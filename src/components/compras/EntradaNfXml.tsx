import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { parseNfe, similaridade, soDigitos, tokens, unidadesDe, valorLiquido, type ItemXml, type NfXml } from "@/lib/nfe";
import { buscarDepara, normDesc, salvarDepara } from "@/lib/comprasDepara";

// ============================================================================
// Aplicar a NF do fornecedor à conferência de uma OC.
// Fonte: o XML da NF-e (upload) OU uma NF de entrada do espelho do Tiny já
// vinculada à OC (prop `nfPronta`). Cada item da nota é casado com um item da
// OC (EAN → código = SKU → descrição) e convertido para UNIDADES; a tela mostra
// as diferenças OC × NF. Ao aplicar (RPC compras_aplicar_nf), as quantidades
// da NF passam a ser o esperado da conferência e a divergência OC × NF fica
// gravada na ordem. Item que veio só na NF entra na conferência como item novo.
// Opcional: lançar também como recebido (comportamento antigo da entrada por
// XML). Não mexe no Tiny nem no estoque (o estoque no Tiny é o botão da OC).
// De-para do fornecedor (01/out): fornecedor que fatura em FARDO/CAIXA com a
// descrição dele (Santa Lucia "(4X5) 20 KG" FD) — o de-para salvo
// (compras_depara_fornecedor, por fornecedor + descrição da NF) já casa o
// nosso SKU e aplica o FATOR (un. por fardo); "lembrar" grava o que o
// operador ajustou para a próxima nota (vale também p/ NF vinda do Tiny).
// ============================================================================

export interface OrdemEntrada {
  tiny_id: number;
  numero: string | null;
  nf_numero: string | null;
  observacao_recebimento: string | null;
  fornecedor_nome: string | null;
  fornecedor_fantasia: string | null;
  fornecedor_id?: number | null;
}
export interface ItemEntrada {
  id: string;
  sku: string | null;
  descricao: string | null;
  gtin: string | null;
  quantidade: number;
  qtd_recebida: number;
  emb_unidades: number | null;
  preco?: number | null;
  so_na_nf?: boolean | null;
  tiny_produto_id?: number | null;
}
/** NF já no espelho do Tiny (compras_nf_entrada + compras_nf_itens). */
export interface NfPronta {
  nf: NfXml;
  nfTinyId: number;
}

interface Linha {
  xml: ItemXml;
  destino: string; // id do item da OC | IGNORAR | NOVO
  metodo: "ean" | "codigo" | "descricao" | "depara" | "manual" | null;
  fator: number; // unidades do nosso SKU por 1 unidade da NF (fardo com 5 = 5)
  skuDepara?: string | null; // SKU do de-para quando ele não está na OC (entra como item novo)
  unidades: number;
  nota: string | null; // conversão de unidade aplicada / aviso
}

const IGNORAR = "__ignorar__";
const NOVO = "__novo__";
const normNf = (s: string | null | undefined) => String(s ?? "").trim().replace(/^0+/, "");

// Casa um item da NF com um item da OC: EAN (comercial ou tributável) →
// código do fornecedor igual ao nosso SKU → descrição parecida (conferir).
function casar(x: ItemXml, oc: ItemEntrada[]): { item: ItemEntrada | null; metodo: Linha["metodo"]; viaTrib: boolean } {
  const daOc = oc.filter((it) => !it.so_na_nf);
  for (const it of daOc) {
    const g = soDigitos(it.gtin);
    if (!g) continue;
    if (x.ean === g) return { item: it, metodo: "ean", viaTrib: false };
    if (x.eanTrib === g) return { item: it, metodo: "ean", viaTrib: true };
  }
  const cod = x.cProd.trim().toUpperCase();
  const porCod = daOc.find((it) => (it.sku ?? "").trim().toUpperCase() === cod && cod !== "");
  if (porCod) return { item: porCod, metodo: "codigo", viaTrib: false };
  let melhor: ItemEntrada | null = null;
  let score = 0;
  for (const it of daOc) {
    const sc = similaridade(x.xProd, it.descricao);
    if (sc > score) { score = sc; melhor = it; }
  }
  if (melhor && score >= 0.6) return { item: melhor, metodo: "descricao", viaTrib: false };
  return { item: null, metodo: null, viaTrib: false };
}

export function EntradaNfXml({
  ordem, itens, open, onOpenChange, nfPronta,
}: {
  ordem: OrdemEntrada;
  itens: ItemEntrada[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  nfPronta?: NfPronta | null;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const inputRef = useRef<HTMLInputElement>(null);
  const [nf, setNf] = useState<NfXml | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [lancarRecebido, setLancarRecebido] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [lembrar, setLembrar] = useState(true);
  const [nomesSku, setNomesSku] = useState<Record<string, string>>({});
  const origem: "xml" | "tiny" = nfPronta ? "tiny" : "xml";
  const itensOc = useMemo(() => itens.filter((it) => !it.so_na_nf), [itens]);

  function limpar() {
    setNf(null); setLinhas([]); setErro(null); setLancarRecebido(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function carregar(nota: NfXml) {
    // de-para salvo deste fornecedor ganha de tudo (descrição da NF → SKU + fator)
    const dp = await buscarDepara(ordem.fornecedor_id, nota.cnpj, nota.itens.map((x) => x.xProd)).catch(() => new Map());
    // linha "de verdade" da OC (com produto do Tiny) ganha da linha de fardo digitada à mão
    const itemDoSku = (sku: string) => {
      const cands = itensOc.filter((it) => (it.sku ?? "").trim() === sku);
      return cands.find((it) => Number(it.tiny_produto_id ?? 1) > 0) ?? cands[0] ?? null;
    };
    const foraDaOc = [...new Set([...dp.values()].map((d) => d.sku).filter((sku) => !itemDoSku(sku)))];
    if (foraDaOc.length) {
      const { data } = await supabaseExternal.from("produtos").select("sku, nome").in("sku", foraDaOc);
      setNomesSku(Object.fromEntries(((data ?? []) as { sku: string; nome: string | null }[]).map((p) => [p.sku, p.nome ?? ""])));
    }
    setNf(nota);
    setLinhas(nota.itens.map((x): Linha => {
      const d = dp.get(normDesc(x.xProd));
      if (d) {
        const item = itemDoSku(d.sku);
        return {
          xml: x, destino: item?.id ?? NOVO, metodo: "depara", fator: d.fator, skuDepara: d.sku,
          unidades: x.qCom * d.fator, nota: `${formatNumber(x.qCom)} ${x.uCom} × ${d.fator} (de-para salvo → ${d.sku})`,
        };
      }
      const m = casar(x, itens);
      const u = unidadesDe(x, m.viaTrib, m.item?.emb_unidades, m.item?.preco);
      return { xml: x, destino: m.item?.id ?? NOVO, metodo: m.metodo, fator: x.qCom > 0 ? u.q / x.qCom : 1, unidades: u.q, nota: u.nota };
    }));
  }

  // NF do Tiny: já vem pronta, sem upload.
  useEffect(() => {
    if (open && nfPronta) void carregar(nfPronta.nf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nfPronta]);

  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    setErro(null);
    try {
      await carregar(parseNfe(await f.text()));
    } catch (e) {
      setNf(null); setLinhas([]);
      setErro((e as Error).message);
    }
  }

  function trocarDestino(idx: number, destino: string) {
    setLinhas((ls) => ls.map((l, i) => {
      if (i !== idx) return l;
      const item = itens.find((it) => it.id === destino) ?? null;
      const u = unidadesDe(l.xml, false, item?.emb_unidades, item?.preco);
      return { ...l, destino, metodo: item ? "manual" : null, skuDepara: null, fator: l.xml.qCom > 0 ? u.q / l.xml.qCom : 1, unidades: u.q, nota: u.nota };
    }));
  }

  // Unidades de OUTRAS NFs já aplicadas a esta OC (a NF desta tela substitui
  // a si mesma se for reaplicada).
  const outrasQ = useQuery({
    queryKey: ["compras", "nf-qtd", ordem.tiny_id],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("compra_ordem_nf_qtd").select("nf_numero, item_id, qtd").eq("ordem_tiny_id", ordem.tiny_id);
      if (error) throw error;
      return (data ?? []) as { nf_numero: string; item_id: string; qtd: number }[];
    },
  });

  // Soma por item da OC (duas linhas da NF podem ser o mesmo produto).
  const porItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of linhas) {
      if (l.destino === IGNORAR || l.destino === NOVO || l.unidades <= 0) continue;
      m.set(l.destino, (m.get(l.destino) ?? 0) + l.unidades);
    }
    return m;
  }, [linhas]);
  const novos = linhas.filter((l) => l.destino === NOVO && l.unidades > 0);
  const ignorados = linhas.filter((l) => l.destino === IGNORAR).length;

  // Prévia das diferenças OC × NF (esta NF + as outras já aplicadas).
  const difs = useMemo(() => {
    if (!nf) return [];
    const esta = normNf(nf.numero);
    const outras = new Map<string, number>();
    for (const r of outrasQ.data ?? []) {
      if (normNf(r.nf_numero) === esta) continue;
      outras.set(r.item_id, (outras.get(r.item_id) ?? 0) + Number(r.qtd));
    }
    const out: { chave: string; rotulo: string; oc: number; nf: number; tipo: "qtd" | "nao_veio" | "so_na_nf" }[] = [];
    for (const it of itens) {
      const nfQ = (porItem.get(it.id) ?? 0) + (outras.get(it.id) ?? 0);
      const oc = Number(it.quantidade ?? 0);
      if (it.so_na_nf) {
        if (nfQ > 0) out.push({ chave: it.id, rotulo: `${it.sku ? `${it.sku} · ` : ""}${it.descricao ?? "—"}`, oc: 0, nf: nfQ, tipo: "so_na_nf" });
        continue;
      }
      if (nfQ !== oc) {
        out.push({ chave: it.id, rotulo: `${it.sku ? `${it.sku} · ` : ""}${it.descricao ?? "—"}`, oc, nf: nfQ, tipo: nfQ === 0 ? "nao_veio" : "qtd" });
      }
    }
    for (const [i, l] of novos.entries()) {
      out.push({ chave: `novo-${i}`, rotulo: `${l.xml.cProd ? `${l.xml.cProd} · ` : ""}${l.xml.xProd}`, oc: 0, nf: l.unidades, tipo: "so_na_nf" });
    }
    return out;
  }, [nf, itens, porItem, novos, outrasQ.data]);
  const outrasNfs = useMemo(() => {
    const esta = normNf(nf?.numero);
    return [...new Set((outrasQ.data ?? []).map((r) => normNf(r.nf_numero)).filter((n) => n !== esta))];
  }, [outrasQ.data, nf]);

  const jaLancada = !!nf && (ordem.nf_numero ?? "").split(/[,;\s]+/).map(normNf).includes(normNf(nf.numero));
  const fornecedorOc = ordem.fornecedor_fantasia || ordem.fornecedor_nome || "";
  const fornecedorDifere = !!nf && origem === "xml" && fornecedorOc !== "" && (() => {
    const a = tokens(fornecedorOc);
    const b = tokens(`${nf.emitente} ${nf.cnpj}`);
    for (const w of a) if (b.has(w)) return false;
    return true;
  })();

  async function aplicar() {
    if (!nf || (porItem.size === 0 && novos.length === 0)) return;
    setSalvando(true);
    try {
      const agora = new Date().toISOString();
      // Valor da NF por item da OC (vProd − desconto do item): a formação de custo
      // usa o preço DA NOTA, não o da OC. NF do Tiny não tem desconto por item —
      // o desconto total vai como extra (o servidor lê o cabeçalho da nota).
      const valorPorItem = new Map<string, { valor: number; desconto: number }>();
      for (const l of linhas) {
        if (l.destino === IGNORAR || l.destino === NOVO || l.unidades <= 0) continue;
        const v = valorPorItem.get(l.destino) ?? { valor: 0, desconto: 0 };
        v.valor += valorLiquido(l.xml); v.desconto += l.xml.vDesc ?? 0;
        valorPorItem.set(l.destino, v);
      }
      const r2 = (x: number) => Math.round(x * 100) / 100;
      const payload = [
        ...[...porItem].map(([item_id, qtd]) => ({
          item_id, qtd, valor: r2(valorPorItem.get(item_id)?.valor ?? 0), desconto: r2(valorPorItem.get(item_id)?.desconto ?? 0),
        })),
        ...novos.map((l) => ({
          item_id: null, sku: l.skuDepara || l.xml.cProd || null, descricao: l.xml.xProd, gtin: l.xml.ean, qtd: l.unidades,
          valor: valorLiquido(l.xml), desconto: r2(l.xml.vDesc ?? 0),
        })),
      ];
      const { data: res, error: eRpc } = await supabaseExternal.rpc("compras_aplicar_nf", {
        p_ordem: ordem.tiny_id, p_nf_numero: nf.numero, p_origem: origem,
        p_nf_tiny_id: nfPronta?.nfTinyId ?? null, p_itens: payload, p_por: perfil?.nome ?? null,
        // desconto_itens = desconto de TODAS as linhas da nota (linha ignorada também não é desconto de cabeçalho)
        p_totais: nf.totais ? { ...nf.totais, desconto_itens: r2(nf.itens.reduce((t, x) => t + (x.vDesc ?? 0), 0)) } : null,
      });
      if (eRpc) throw eRpc;

      // Opcional: lançar também como recebido (soma ao já recebido).
      if (lancarRecebido) {
        for (const [id, add] of porItem) {
          const it = itens.find((x) => x.id === id);
          if (!it) continue;
          const { error } = await supabaseExternal.from("compra_ordem_itens")
            .update({ qtd_recebida: Number(it.qtd_recebida ?? 0) + add, conferido: true, atualizado_em: agora }).eq("id", id);
          if (error) throw new Error(`${it.sku ?? it.descricao}: ${error.message}`);
        }
      }

      const nfs = (ordem.nf_numero ?? "").trim();
      const nfNumero = !nfs ? nf.numero : jaLancada ? nfs : `${nfs}, ${nf.numero}`;
      const dia = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
      const log = `NF ${nf.numero} aplicada à conferência (${origem === "xml" ? "XML" : "Tiny"})${lancarRecebido ? " + recebido" : ""} ${dia}${perfil?.nome ? ` por ${perfil.nome}` : ""}`;
      const obs = [ordem.observacao_recebimento?.trim(), log].filter(Boolean).join(" · ");
      const { error: eOc } = await supabaseExternal.from("compras_ordens")
        .update({ nf_numero: nfNumero, observacao_recebimento: obs }).eq("tiny_id", ordem.tiny_id);
      if (eOc) throw eOc;
      // XML de uma NF que já está no espelho do Tiny sem OC: vincula a esta.
      if (origem === "xml" && ordem.fornecedor_id) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: ordem.tiny_id, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("fornecedor_id", ordem.fornecedor_id).in("numero", [...new Set([nf.numero, nf.numeroBruto])])
          .is("ordem_tiny_id", null);
      }
      // lembra o de-para do que não é óbvio (casado à mão/descrição ou fator ≠ 1)
      if (lembrar) {
        const novosDp = linhas
          .filter((l) => l.destino !== IGNORAR && l.fator > 0 && ((l.metodo !== "ean" && l.metodo !== "codigo") || l.fator !== 1))
          .map((l) => {
            const it = itens.find((x) => x.id === l.destino);
            const sku = (it?.sku ?? l.skuDepara ?? "").trim();
            return { descricao: l.xml.xProd, codigo: l.xml.cProd, unidade: l.xml.uCom, sku, fator: l.fator };
          })
          .filter((x) => x.sku);
        if (novosDp.length) await salvarDepara(ordem.fornecedor_id, nf.cnpj, novosDp, perfil?.nome ?? null);
      }
      const r = (res ?? {}) as { divergencia?: boolean | null; detalhe?: unknown[] | null };
      const nDiv = Array.isArray(r.detalhe) ? r.detalhe.length : 0;
      if (r.divergencia) {
        toast.warning(`NF ${nf.numero} aplicada — divergência OC × NF em ${nDiv} item(ns)`, {
          description: "A conferência passa a usar as quantidades da NF. A divergência ficou registrada na ordem.",
        });
      } else {
        toast.success(`NF ${nf.numero} aplicada — OC e NF conferem`);
      }
      void qc.invalidateQueries({ queryKey: ["compras"] });
      limpar();
      onOpenChange(false);
    } catch (e) {
      toast.error("Falha ao aplicar a NF", { description: (e as Error).message });
      void qc.invalidateQueries({ queryKey: ["compras", "itens", ordem.tiny_id] });
    } finally {
      setSalvando(false);
    }
  }

  const rotuloTipo = { qtd: "qtd diferente", nao_veio: "não veio na NF", so_na_nf: "só na NF" } as const;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) limpar(); onOpenChange(o); }}>
      <DialogContent className="max-w-[min(1180px,96vw)] w-full max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Aplicar NF à conferência{origem === "tiny" ? " (NF do Tiny)" : " (XML da NF-e)"}</DialogTitle>
          <DialogDescription>
            OC #{ordem.numero ?? ordem.tiny_id} · os itens da nota são casados com os da ordem e convertidos para
            unidades. <b>As quantidades da NF passam a valer para a conferência</b> e a divergência OC × NF fica
            registrada na ordem. Não altera o Tiny nem o estoque.
          </DialogDescription>
        </DialogHeader>

        {!nf && !nfPronta && (
          <label
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground cursor-pointer hover:bg-muted/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void lerArquivo(e.dataTransfer.files?.[0]); }}
          >
            <FileUp className="h-6 w-6" />
            <span>Arraste o XML da NF-e aqui ou <span className="text-primary font-semibold">clique para escolher</span></span>
            <input ref={inputRef} type="file" accept=".xml,text/xml,application/xml" className="hidden"
              onChange={(e) => void lerArquivo(e.target.files?.[0])} />
          </label>
        )}
        {erro && <div className="text-sm text-red-700 dark:text-red-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {erro}</div>}

        {nf && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border p-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold">NF {nf.numero}{nf.serie ? `/${nf.serie}` : ""}</span>
              <span className="text-muted-foreground">{nf.emitente}</span>
              <span className="text-muted-foreground text-xs">{nf.emissao ? nf.emissao.split("-").reverse().join("/") : "—"}</span>
              <span className="font-mono tabular-nums">{formatBRL(nf.valor)}</span>
              <span className="text-muted-foreground text-xs">{nf.itens.length} item(ns)</span>
              {!nfPronta && <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={limpar}>trocar arquivo</Button>}
            </div>
            {origem === "tiny" && (
              <div className="text-xs rounded-md bg-sky-500/10 text-sky-900 dark:text-sky-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                A NF do Tiny não informa a unidade (caixa/fardo/unidade). Confira a coluna Unidades — quando o preço da NF é
                múltiplo do da OC, a conversão é sugerida.
              </div>
            )}
            {fornecedorDifere && (
              <div className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                O emitente da NF ({nf.emitente}) parece diferente do fornecedor da OC ({fornecedorOc}). Confira se é a ordem certa.
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="hidden md:grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_250px] gap-3 px-3 text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                <span>Item da nota</span><span>Vira qual produto nosso</span><span>Conversão para unidades</span>
              </div>
              {linhas.map((l, idx) => {
                const it = itens.find((x) => x.id === l.destino);
                const ocQ = it ? Number(it.quantidade ?? 0) : null;
                const totalItem = porItem.get(l.destino) ?? 0;
                const difere = ocQ != null && totalItem !== ocQ;
                const unitNf = l.xml.qCom > 0 ? valorLiquido(l.xml) / l.xml.qCom : 0; // já sem o desconto do item
                const metodoTxt = l.metodo === "ean" ? "pelo EAN" : l.metodo === "codigo" ? "pelo código" : l.metodo === "depara" ? "de-para salvo" : l.metodo === "manual" ? "escolhido à mão" : l.metodo === "descricao" ? "pela descrição — confira" : null;
                return (
                  <div key={idx} className={cn(
                    "grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_250px] gap-3 items-start rounded-lg border p-3",
                    l.destino === IGNORAR && "opacity-55 bg-muted/40",
                    l.destino === NOVO && "border-violet-300 dark:border-violet-800 bg-violet-500/5",
                  )}>
                    {/* item da NF */}
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium leading-snug break-words">{l.xml.xProd}</div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                        <span className="font-semibold text-foreground tabular-nums">{formatNumber(l.xml.qCom)} {l.xml.uCom || "un"}</span>
                        {unitNf > 0 && <span className="tabular-nums">· {formatBRL(unitNf)}/{l.xml.uCom || "un"}</span>}
                        {(l.xml.vDesc ?? 0) > 0 && (
                          <span className="tabular-nums text-emerald-700 dark:text-emerald-400" title="Desconto do item na NF — já abatido do preço">
                            · desc. {formatBRL(l.xml.vDesc ?? 0)}
                          </span>
                        )}
                        {l.xml.cProd && <span className="font-mono">· cód {l.xml.cProd}</span>}
                        {l.xml.ean && <span className="font-mono">· EAN {l.xml.ean}</span>}
                      </div>
                    </div>

                    {/* destino */}
                    <div className="min-w-0 flex flex-col gap-1">
                      <Select value={l.destino} onValueChange={(v) => trocarDestino(idx, v)}>
                        <SelectTrigger className="h-9 text-xs w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
                        <SelectContent className="max-w-[min(560px,90vw)]">
                          <SelectItem value={NOVO} className="text-xs">Não está na OC — incluir na conferência</SelectItem>
                          <SelectItem value={IGNORAR} className="text-xs">Ignorar esta linha</SelectItem>
                          {itensOc.map((x) => (
                            <SelectItem key={x.id} value={x.id} className="text-xs">
                              {x.sku ? `${x.sku} · ` : ""}{x.descricao ?? "—"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                        {l.destino === NOVO ? (
                          <span className="rounded px-1.5 py-0.5 bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300 font-semibold">
                            {l.skuDepara ? `entra como item novo · ${l.skuDepara}${nomesSku[l.skuDepara] ? ` · ${nomesSku[l.skuDepara]}` : ""}` : "entra como item novo"}
                          </span>
                        ) : l.destino !== IGNORAR && metodoTxt ? (
                          <span className={cn("rounded px-1.5 py-0.5",
                            l.metodo === "descricao" ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 font-semibold"
                              : l.metodo === "depara" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                                : "bg-muted text-muted-foreground")}>
                            {metodoTxt}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {/* conversão */}
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="tabular-nums font-semibold w-[46px] text-right">{formatNumber(l.xml.qCom)}</span>
                        <span className="text-muted-foreground">×</span>
                        <Input
                          value={String(Math.round(l.fator * 1000) / 1000)}
                          disabled={l.destino === IGNORAR}
                          title="Unidades do nosso produto em 1 unidade da nota (fardo com 5 = 5)"
                          onChange={(e) => {
                            const v = Number(e.target.value.replace(",", "."));
                            const f = Number.isFinite(v) && v > 0 ? v : 0;
                            setLinhas((ls) => ls.map((x, i) => (i === idx ? { ...x, fator: f, unidades: x.xml.qCom * f, nota: null } : x)));
                          }}
                          className="h-8 w-14 text-center font-mono text-xs"
                          inputMode="decimal"
                        />
                        <span className="text-muted-foreground">=</span>
                        <Input
                          value={String(l.unidades)}
                          disabled={l.destino === IGNORAR}
                          onChange={(e) => {
                            const v = Number(e.target.value.replace(",", "."));
                            const u = Number.isFinite(v) && v >= 0 ? v : 0;
                            setLinhas((ls) => ls.map((x, i) => (i === idx ? { ...x, unidades: u, fator: x.xml.qCom > 0 ? u / x.xml.qCom : x.fator, nota: null } : x)));
                          }}
                          className="h-8 w-20 text-center font-mono text-xs font-semibold"
                          inputMode="numeric"
                        />
                        <span className="text-muted-foreground text-[11px]">un</span>
                      </div>
                      {ocQ != null && (
                        <span className={cn("text-[11px] tabular-nums", difere ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-emerald-700 dark:text-emerald-400")}>
                          OC pediu {formatNumber(ocQ)} un{difere ? ` · diferença ${totalItem - ocQ > 0 ? "+" : ""}${formatNumber(totalItem - ocQ)}` : " · confere"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Diferenças OC × NF */}
            {difs.length === 0 ? (
              <div className="rounded-md bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 px-2.5 py-2 text-xs flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> OC e NF conferem: mesmas quantidades em todos os itens.
              </div>
            ) : (
              <div className="rounded-md border border-red-300 dark:border-red-900 bg-red-500/5 p-3 text-xs flex flex-col gap-2">
                <span className="font-bold text-red-800 dark:text-red-300 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Divergência OC × NF em {difs.length} item(ns) — a conferência vai usar a quantidade da NF
                </span>
                {outrasNfs.length > 0 && (
                  <span className="text-muted-foreground">Somando as NFs já aplicadas a esta OC: {outrasNfs.join(", ")}.</span>
                )}
                <table className="w-full table-fixed">
                  <thead>
                    <tr className="text-[10px] uppercase text-muted-foreground text-left">
                      <th className="font-medium pb-1">Produto</th>
                      <th className="font-medium pb-1 text-right w-[70px]">OC</th>
                      <th className="font-medium pb-1 text-right w-[70px]">NF</th>
                      <th className="font-medium pb-1 text-right w-[80px]">Diferença</th>
                      <th className="font-medium pb-1 pl-3 w-[110px]">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {difs.map((d) => (
                      <tr key={d.chave} className="border-t border-red-200/60 dark:border-red-900/40">
                        <td className="py-1 pr-2 truncate" title={d.rotulo}>{d.rotulo}</td>
                        <td className="py-1 text-right tabular-nums font-mono">{formatNumber(d.oc)}</td>
                        <td className="py-1 text-right tabular-nums font-mono font-semibold">{formatNumber(d.nf)}</td>
                        <td className={cn("py-1 text-right tabular-nums font-mono font-semibold", d.nf - d.oc < 0 ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                          {d.nf - d.oc > 0 ? "+" : ""}{formatNumber(d.nf - d.oc)}
                        </td>
                        <td className="py-1 pl-3 text-muted-foreground">{rotuloTipo[d.tipo]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {ignorados > 0 && <span className="text-[11px] text-muted-foreground">{ignorados} linha(s) da NF ignorada(s).</span>}
          </div>
        )}

        <DialogFooter className="gap-3 sm:justify-between items-center">
          {nf ? (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-xs cursor-pointer" title="Sem marcar, a contagem física é feita na conferência">
                <Checkbox checked={lancarRecebido} onCheckedChange={(v) => setLancarRecebido(v === true)} />
                Lançar também como recebido (sem contagem física)
                {lancarRecebido && jaLancada && <span className="text-amber-700 dark:text-amber-400 font-semibold">· NF já lançada: vai somar de novo</span>}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer" title="Grava produto + fator por fornecedor e descrição da NF; a próxima nota igual já vem convertida, e a conferência NF × OC também usa">
                <Checkbox checked={lembrar} onCheckedChange={(v) => setLembrar(v === true)} />
                Lembrar o de-para (produto e fator) para as próximas notas deste fornecedor
              </label>
            </div>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={() => void aplicar()} disabled={!nf || (porItem.size === 0 && novos.length === 0) || salvando} className="gap-2">
              {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
              Aplicar NF à conferência
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
