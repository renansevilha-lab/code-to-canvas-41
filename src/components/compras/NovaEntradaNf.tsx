import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp, Loader2, Package as PackageIcon, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { parseNfe, similaridade, soDigitos, unidadesDe, type ItemXml, type NfXml } from "@/lib/nfe";
import { buscarDepara, normDesc, salvarDepara } from "@/lib/comprasDepara";
import { buscarNfTiny, carregarNfTiny, normNf, type NfEncontrada } from "@/lib/nfTiny";

// ============================================================================
// Nova entrada de recebimento a partir da NF-e (30/set/2026) — para mercadoria
// que chega com nota mas SEM ordem de compra no Tiny. O operador sobe o XML e
// o app cria uma "ordem" só do app, já na coluna Conferência:
//   - tiny_id NEGATIVO (-epoch em segundos): o compras-sync só mexe nos ids
//     que vêm do Tiny, então a ordem do app nunca é sobrescrita nem apagada;
//   - itens da NF viram compra_ordem_itens com o NOSSO SKU, casado por EAN
//     (histórico de compras) → código do fornecedor = SKU → descrição (itens
//     que o mesmo fornecedor já vendeu). Tudo editável antes de criar.
// Não cria nada no Tiny e não lança estoque.
// ============================================================================

interface Linha {
  xml: ItemXml;
  sku: string;
  metodo: "ean" | "codigo" | "descricao" | "manual" | "depara" | null;
  fator: number; // unidades do SKU por 1 unidade da NF (fardo com 5 = 5)
  unidades: number;
  nota: string | null;
  incluir: boolean;
}
interface Fornecedor {
  fornecedor_id: number | null;
  fornecedor_nome: string | null;
  fornecedor_fantasia: string | null;
}
interface ItemHist { sku: string | null; gtin: string | null; descricao: string | null }
interface Produto { sku: string; nome: string | null; id_tiny: number | null; foto_capa: string | null }

function Foto({ url }: { url?: string | null }) {
  const [erro, setErro] = useState(false);
  if (!url || erro) {
    return (
      <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <PackageIcon className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }
  return <img src={url} alt="" loading="lazy" onError={() => setErro(true)} className="h-14 w-14 rounded-lg object-cover bg-muted shrink-0 border" />;
}

// Palavras que não identificam fornecedor ("X COMERCIO LTDA" × "Y COMERCIO LTDA").
const GENERICAS = new Set([
  "ltda", "limitada", "comercio", "industria", "produtos", "para", "eireli", "epp",
  "distribuidora", "importacao", "exportacao", "animais", "pet", "pets", "servicos", "cia",
]);
function simFornecedor(a: string | null | undefined, b: string | null | undefined): number {
  const limpa = (s: string | null | undefined) =>
    String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERICAS.has(w)).join(" ");
  return similaridade(limpa(a), limpa(b));
}
const variantesEan = (e: string) => [...new Set([e, e.padStart(13, "0"), e.padStart(14, "0")])];

export function NovaEntradaNf({
  open, onOpenChange, onCriada,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCriada: (tinyId: number) => void;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [nf, setNf] = useState<NfXml | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [fornecedor, setFornecedor] = useState<Fornecedor | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [jaRecebido, setJaRecebido] = useState(false);
  const [termo, setTermo] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [encontradas, setEncontradas] = useState<NfEncontrada[] | null>(null);
  const [nfTinyId, setNfTinyId] = useState<number | null>(null);
  const [lembrar, setLembrar] = useState(true);
  const [salvando, setSalvando] = useState(false);

  function limpar() {
    setNf(null); setLinhas([]); setFornecedor(null); setAvisos([]); setErro(null); setJaRecebido(false);
    setEncontradas(null); setNfTinyId(null);
  }

  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    setErro(null); setLendo(true);
    let nota: NfXml;
    try { nota = parseNfe(await f.text()); }
    catch (e) { limpar(); setErro((e as Error).message); setLendo(false); return; }
    setNfTinyId(null);
    await processar(nota);
  }

  // NF já no espelho do Tiny, achada pelo número ou pela chave (sem precisar do XML)
  async function buscar() {
    setErro(null); setEncontradas(null);
    if (!termo.trim()) return;
    setBuscando(true);
    try {
      const r = await buscarNfTiny(termo);
      setEncontradas(r);
      if (r.length === 1) await usarNfTiny(r[0]);
    } catch (e) { setErro((e as Error).message); }
    finally { setBuscando(false); }
  }
  async function usarNfTiny(n: NfEncontrada) {
    setErro(null); setLendo(true);
    try {
      const { nf: nota } = await carregarNfTiny(n.tiny_id);
      setNfTinyId(n.tiny_id);
      await processar(nota);
    } catch (e) { setErro((e as Error).message); setLendo(false); }
  }

  async function processar(nota: NfXml) {
    setLendo(true);
    try {
      const av: string[] = [];

      // 1) Fornecedor: OC mais parecida pelo nome (dá o fornecedor_id do Tiny,
      //    que a conciliação automática de NFs usa) + os itens que ele já vendeu.
      const { data: ocs } = await supabaseExternal.from("compras_ordens")
        .select("tiny_id, fornecedor_id, fornecedor_nome, fornecedor_fantasia")
        .gt("tiny_id", 0).order("data_pedido", { ascending: false }).limit(1000);
      let forn: Fornecedor | null = null;
      let melhor = 0;
      for (const o of (ocs ?? []) as (Fornecedor & { tiny_id: number })[]) {
        const s = Math.max(simFornecedor(nota.razaoSocial, o.fornecedor_nome), simFornecedor(nota.emitente, o.fornecedor_fantasia));
        if (s > melhor) { melhor = s; forn = o; }
      }
      if (melhor < 0.6) forn = null;
      const idsForn = forn
        ? ((ocs ?? []) as (Fornecedor & { tiny_id: number })[])
          .filter((o) => (forn!.fornecedor_id != null ? o.fornecedor_id === forn!.fornecedor_id : o.fornecedor_nome === forn!.fornecedor_nome))
          .map((o) => o.tiny_id).slice(0, 60)
        : [];

      // 2) Histórico de itens: EAN → SKU (qualquer fornecedor) e itens deste fornecedor.
      const eans = [...new Set(nota.itens.flatMap((x) => [x.ean, x.eanTrib]).filter((e): e is string => !!e))];
      const hist: ItemHist[] = [];
      if (eans.length) {
        const { data } = await supabaseExternal.from("compra_ordem_itens")
          .select("sku, gtin, descricao").in("gtin", eans.flatMap(variantesEan)).limit(2000);
        hist.push(...((data ?? []) as ItemHist[]));
      }
      const doForn: ItemHist[] = [];
      if (idsForn.length) {
        const { data } = await supabaseExternal.from("compra_ordem_itens")
          .select("sku, gtin, descricao").in("ordem_tiny_id", idsForn).limit(3000);
        doForn.push(...((data ?? []) as ItemHist[]));
      }
      const skuPorEan = new Map<string, string>();
      for (const h of [...hist, ...doForn]) {
        const g = soDigitos(h.gtin);
        if (g && h.sku) skuPorEan.set(g, h.sku);
      }

      // 3) Código do fornecedor que já é o nosso SKU.
      const cods = [...new Set(nota.itens.map((x) => x.cProd.trim()).filter(Boolean))];
      const skusCod = new Set<string>();
      if (cods.length) {
        const { data } = await supabaseExternal.from("produtos").select("sku").in("sku", cods.slice(0, 300));
        for (const p of (data ?? []) as { sku: string }[]) skusCod.add(p.sku);
      }

      // 0) De-para salvo deste fornecedor (descrição da NF → nosso SKU + fator) ganha de tudo.
      const dp = await buscarDepara(forn?.fornecedor_id, nota.cnpj, nota.itens.map((x) => x.xProd));

      const casadas = nota.itens.map((x): Omit<Linha, "unidades" | "nota" | "fator"> & { viaTrib: boolean; fatorDp?: number } => {
        const d = dp.get(normDesc(x.xProd));
        if (d) return { xml: x, sku: d.sku, metodo: "depara", incluir: true, viaTrib: false, fatorDp: d.fator };
        if (x.ean && skuPorEan.has(x.ean)) return { xml: x, sku: skuPorEan.get(x.ean)!, metodo: "ean", incluir: true, viaTrib: false };
        if (x.eanTrib && skuPorEan.has(x.eanTrib)) return { xml: x, sku: skuPorEan.get(x.eanTrib)!, metodo: "ean", incluir: true, viaTrib: true };
        if (skusCod.has(x.cProd.trim())) return { xml: x, sku: x.cProd.trim(), metodo: "codigo", incluir: true, viaTrib: false };
        let best: ItemHist | null = null;
        let sc = 0;
        for (const h of doForn) {
          if (!h.sku) continue;
          const s = similaridade(x.xProd, h.descricao);
          if (s > sc) { sc = s; best = h; }
        }
        if (best && sc >= 0.6) return { xml: x, sku: best.sku!, metodo: "descricao", incluir: true, viaTrib: false };
        return { xml: x, sku: "", metodo: null, incluir: true, viaTrib: false };
      });

      // 4) Encaixotamento lembrado (NF em caixa/fardo → unidades).
      const skusCasados = [...new Set(casadas.map((c) => c.sku).filter(Boolean))];
      const emb = new Map<string, number | null>();
      if (skusCasados.length) {
        const { data } = await supabaseExternal.from("produto_embalagem").select("sku, emb_unidades").in("sku", skusCasados);
        for (const r of (data ?? []) as { sku: string; emb_unidades: number | null }[]) emb.set(r.sku, r.emb_unidades);
      }

      // 5) Já existe? (mesma NF criada antes pelo app, ou já casada com uma OC do Tiny)
      if (nota.chave) {
        const { data: dup } = await supabaseExternal.from("compras_ordens")
          .select("numero, kanban_status").ilike("observacoes", `%${nota.chave}%`).neq("kanban_status", "excluida").limit(1);
        if (dup && dup.length) av.push(`Esta NF já gerou a entrada #${(dup[0] as { numero: string }).numero} no app.`);
      }
      const { data: vinc } = await supabaseExternal.from("compras_nf_entrada")
        .select("ordem_tiny_id, fornecedor_nome").in("numero", [...new Set([nota.numero, nota.numeroBruto])])
        .not("ordem_tiny_id", "is", null).limit(10);
      for (const v of (vinc ?? []) as { ordem_tiny_id: number; fornecedor_nome: string | null }[]) {
        if (simFornecedor(v.fornecedor_nome, nota.razaoSocial) >= 0.6) {
          const { data: oc } = await supabaseExternal.from("compras_ordens").select("numero").eq("tiny_id", v.ordem_tiny_id).maybeSingle();
          av.push(`Esta NF já está casada com a OC #${(oc as { numero: string } | null)?.numero ?? v.ordem_tiny_id} do Tiny — se for essa compra, use "Entrada pelo XML da NF" dentro dela.`);
          break;
        }
      }

      setNf(nota);
      setFornecedor(forn);
      setAvisos(av);
      setLinhas(casadas.map((c): Linha => {
        if (c.fatorDp) {
          return { xml: c.xml, sku: c.sku, metodo: c.metodo, incluir: c.incluir, fator: c.fatorDp, unidades: c.xml.qCom * c.fatorDp,
            nota: `${c.xml.qCom} ${c.xml.uCom} × ${c.fatorDp} (de-para salvo)` };
        }
        const u = unidadesDe(c.xml, c.viaTrib, c.sku ? emb.get(c.sku) : null);
        return { xml: c.xml, sku: c.sku, metodo: c.metodo, incluir: c.incluir, fator: c.xml.qCom > 0 ? u.q / c.xml.qCom : 1, unidades: u.q, nota: u.nota };
      }));
    } catch (e) {
      limpar();
      setErro((e as Error).message);
    } finally {
      setLendo(false);
    }
  }

  // Confere os SKUs digitados/casados contra o cadastro (nome + id do Tiny).
  const skusLinhas = useMemo(
    () => [...new Set(linhas.map((l) => l.sku.trim()).filter(Boolean))].sort(),
    [linhas],
  );
  const prodQ = useQuery({
    queryKey: ["compras", "nova-nf-produtos", skusLinhas],
    enabled: skusLinhas.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, Produto>> => {
      const { data, error } = await supabaseExternal.from("produtos").select("sku, nome, id_tiny, foto_capa").in("sku", skusLinhas);
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as Produto[]).map((p) => [p.sku, p]));
    },
  });
  const prods = prodQ.data ?? {};

  const incluidas = linhas.filter((l) => l.incluir && l.unidades > 0);
  const semSku = incluidas.filter((l) => !l.sku.trim()).length;
  const skuDesconhecido = prodQ.isSuccess
    ? incluidas.filter((l) => l.sku.trim() && !prods[l.sku.trim()]).length
    : 0;

  async function criar() {
    if (!nf || incluidas.length === 0) return;
    setSalvando(true);
    const tinyId = -Math.floor(Date.now() / 1000);
    try {
      // Agrupa por SKU (duas linhas da NF podem ser o mesmo produto).
      const porSku = new Map<string, { sku: string | null; descricao: string; gtin: string | null; qtd: number; valor: number; tinyProd: number }>();
      incluidas.forEach((l, i) => {
        const sku = l.sku.trim() || null;
        const chave = sku ?? `__sem_sku_${i}`;
        const g = porSku.get(chave);
        if (g) { g.qtd += l.unidades; g.valor += l.xml.vProd; return; }
        const p = sku ? prods[sku] : undefined;
        porSku.set(chave, {
          sku, descricao: p?.nome ?? l.xml.xProd, gtin: l.xml.ean ?? l.xml.eanTrib,
          qtd: l.unidades, valor: l.xml.vProd, tinyProd: p?.id_tiny ?? 0,
        });
      });
      const totalUn = [...porSku.values()].reduce((s, g) => s + g.qtd, 0);
      const agora = new Date().toISOString();

      const { error: eOc } = await supabaseExternal.from("compras_ordens").insert({
        tiny_id: tinyId,
        numero: `NF-${nf.numero}`,
        data_pedido: nf.emissao,
        data_prevista: null,
        situacao_tiny: null,
        fornecedor_id: fornecedor?.fornecedor_id ?? null,
        fornecedor_nome: fornecedor?.fornecedor_nome ?? nf.razaoSocial,
        fornecedor_fantasia: fornecedor?.fornecedor_fantasia ?? (nf.emitente !== nf.razaoSocial ? nf.emitente : null),
        categoria: "Entrada por NF (app)",
        total_produtos: nf.itens.reduce((s, x) => s + x.vProd, 0),
        total_pedido: nf.valor,
        itens_qtd: totalUn,
        observacoes: `Criada no app a partir da NF-e ${nf.numero}${nf.serie ? `/${nf.serie}` : ""}${nf.chave ? ` · chave ${nf.chave}` : ""}${perfil?.nome ? ` · por ${perfil.nome}` : ""}`,
        kanban_status: "conferencia",
        nf_numero: nf.numero,
        recebido_em: null,
        arquivada_em: null,
        atualizado_em: agora,
      });
      if (eOc) throw eOc;

      const { error: eIt } = await supabaseExternal.from("compra_ordem_itens").insert(
        [...porSku.values()].map((g) => ({
          ordem_tiny_id: tinyId,
          tiny_produto_id: g.tinyProd,
          sku: g.sku,
          descricao: g.descricao,
          gtin: g.gtin,
          quantidade: g.qtd,
          preco: g.qtd > 0 ? Math.round((g.valor / g.qtd) * 100) / 100 : 0,
          qtd_recebida: jaRecebido ? g.qtd : 0,
          conferido: jaRecebido,
          atualizado_em: agora,
        })),
      );
      if (eIt) {
        await supabaseExternal.from("compras_ordens").delete().eq("tiny_id", tinyId);
        throw eIt;
      }

      // NF escolhida do espelho do Tiny: vincula direto pelo id.
      if (nfTinyId) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: tinyId, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("tiny_id", nfTinyId).is("ordem_tiny_id", null);
      }
      // Se a NF já está no espelho do Tiny sem OC, casa com esta entrada.
      if (!nfTinyId && fornecedor?.fornecedor_id) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: tinyId, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("fornecedor_id", fornecedor.fornecedor_id)
          .in("numero", [...new Set([nf.numero, nf.numeroBruto])]).is("ordem_tiny_id", null);
      }

      let lembrados = 0;
      if (lembrar) {
        const novos = incluidas
          .filter((l) => l.sku.trim() && l.fator > 0 && ((l.metodo !== "ean" && l.metodo !== "codigo") || l.fator !== 1))
          .map((l) => ({ descricao: l.xml.xProd, codigo: l.xml.cProd, unidade: l.xml.uCom, sku: l.sku.trim(), fator: l.fator }));
        if (novos.length) lembrados = await salvarDepara(fornecedor?.fornecedor_id, nf.cnpj, novos, perfil?.nome ?? null);
      }

      toast.success(`Entrada NF-${nf.numero} criada`, {
        description: `${porSku.size} item(ns) · ${formatNumber(totalUn)} un — já na coluna Conferência${lembrados ? ` · ${lembrados} de-para salvo(s)` : ""}`,
      });
      void qc.invalidateQueries({ queryKey: ["compras"] });
      limpar();
      onOpenChange(false);
      onCriada(tinyId);
    } catch (e) {
      toast.error("Falha ao criar a entrada", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  function setLinha(idx: number, patch: Partial<Linha>) {
    setLinhas((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) limpar(); onOpenChange(o); }}>
      <DialogContent className="max-w-[min(1320px,96vw)] w-full max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Nova entrada de recebimento pela NF</DialogTitle>
          <DialogDescription>
            Para mercadoria que chegou com nota e sem ordem de compra. Suba o XML da NF-e: os itens
            viram uma entrada na coluna Conferência, com o nosso SKU. Não cria nada no Tiny nem lança estoque.
          </DialogDescription>
        </DialogHeader>

        {!nf && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Buscar a NF pelo número ou pela chave</span>
              <div className="flex gap-2">
                <Input value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="ex.: 16648 ou a chave de 44 dígitos"
                  className="h-9 font-mono text-sm" onKeyDown={(e) => { if (e.key === "Enter") void buscar(); }} disabled={lendo} />
                <Button variant="outline" className="h-9 gap-1.5" onClick={() => void buscar()} disabled={buscando || lendo || !termo.trim()}>
                  {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">Procura nas NFs de entrada que já estão no Tiny (atualizadas a cada 30 min). Nota que ainda não entrou no Tiny: use o XML.</span>
              {encontradas && encontradas.length === 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">Nenhuma NF com esse número/chave no Tiny ainda — use o XML abaixo.</span>
              )}
              {encontradas && encontradas.length > 1 && (
                <div className="rounded-md border divide-y">
                  {encontradas.map((n) => (
                    <button key={n.tiny_id} type="button" disabled={lendo} onClick={() => void usarNfTiny(n)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40">
                      <span className="min-w-0 truncate"><b>NF {normNf(n.numero)}</b> · {n.fornecedor_nome} · {n.data_emissao ? n.data_emissao.split("-").reverse().join("/") : "—"}</span>
                      <span className="font-mono tabular-nums shrink-0">{formatBRL(Number(n.valor ?? 0))}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground"><div className="h-px flex-1 bg-border" />ou<div className="h-px flex-1 bg-border" /></div>
          <label
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground cursor-pointer hover:bg-muted/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void lerArquivo(e.dataTransfer.files?.[0]); }}
          >
            {lendo ? <Loader2 className="h-6 w-6 animate-spin" /> : <FileUp className="h-6 w-6" />}
            <span>{lendo ? "Lendo a nota e casando os produtos…" : <>Arraste o XML da NF-e aqui ou <span className="text-primary font-semibold">clique para escolher</span></>}</span>
            <input type="file" accept=".xml,text/xml,application/xml" className="hidden" disabled={lendo}
              onChange={(e) => { void lerArquivo(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          </div>
        )}
        {erro && <div className="text-sm text-red-700 dark:text-red-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {erro}</div>}

        {nf && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border p-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold">NF {nf.numero}{nf.serie ? `/${nf.serie}` : ""}</span>
              <span>{nf.razaoSocial}</span>
              <span className="text-muted-foreground text-xs">{nf.emissao ? nf.emissao.split("-").reverse().join("/") : "—"}</span>
              <span className="font-mono tabular-nums">{formatBRL(nf.valor)}</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={limpar}>trocar arquivo</Button>
              <span className="basis-full text-xs text-muted-foreground">
                {fornecedor
                  ? <>Fornecedor reconhecido: <b>{fornecedor.fornecedor_fantasia || fornecedor.fornecedor_nome}</b> (compras anteriores no Tiny)</>
                  : "Fornecedor sem compras anteriores no app — os produtos só casam por EAN ou código."}
              </span>
            </div>
            {avisos.map((a) => (
              <div key={a} className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {a}
              </div>
            ))}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b">
                    <th className="py-1 pr-2 font-medium w-6" />
                    <th className="py-1 pr-2 font-medium">Item da NF</th>
                    <th className="py-1 pr-2 font-medium text-right">Qtd NF</th>
                    <th className="py-1 pr-2 font-medium">Nosso SKU</th>
                    <th className="py-1 pr-2 font-medium text-right" title="Quantas unidades do nosso SKU vêm em 1 unidade da NF (fardo com 5 = 5)">Un. por FD/CX</th>
                    <th className="py-1 pr-2 font-medium text-right">Unidades</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l, idx) => {
                    const sku = l.sku.trim();
                    const p = sku ? prods[sku] : undefined;
                    return (
                      <tr key={idx} className={cn("border-b last:border-0 align-top", !l.incluir && "opacity-50")}>
                        <td className="py-2 pr-2">
                          <Checkbox checked={l.incluir} onCheckedChange={(v) => setLinha(idx, { incluir: v === true })} />
                        </td>
                        <td className="py-2 pr-3 w-[34%]">
                          <div className="text-[13px] font-medium leading-snug break-words">{l.xml.xProd}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            cód {l.xml.cProd || "—"}{l.xml.ean ? ` · EAN ${l.xml.ean}` : ""} · {formatBRL(l.xml.vProd)}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                          {formatNumber(l.xml.qCom)} {l.xml.uCom}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex items-start gap-3">
                          <Foto url={p?.foto_capa} />
                          <div className="min-w-0 flex-1">
                          <Input
                            value={l.sku}
                            placeholder="SKU (ex.: 15102)"
                            disabled={!l.incluir}
                            onChange={(e) => setLinha(idx, { sku: e.target.value, metodo: "manual" })}
                            className="h-8 w-40 font-mono text-xs"
                          />
                          <div className="text-[11.5px] mt-1 leading-snug break-words">
                            {!sku ? (
                              <span className="text-amber-700 dark:text-amber-400 font-semibold">sem SKU — entra só com a descrição da NF</span>
                            ) : p ? (
                              <span className="text-foreground/80">
                                {l.metodo === "ean" ? "pelo EAN · " : l.metodo === "codigo" ? "pelo código · " : l.metodo === "depara" ? "de-para salvo · " : ""}
                                {l.metodo === "descricao" && <span className="text-amber-700 dark:text-amber-400 font-semibold">pela descrição, confira · </span>}
                                {p.nome}
                              </span>
                            ) : prodQ.isFetching ? (
                              <span className="text-muted-foreground">conferindo…</span>
                            ) : (
                              <span className="text-red-700 dark:text-red-400 font-semibold">SKU não encontrado no cadastro</span>
                            )}
                          </div>
                          </div>
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right">
                          <Input
                            value={String(Math.round(l.fator * 1000) / 1000)}
                            disabled={!l.incluir}
                            onChange={(e) => {
                              const v = Number(e.target.value.replace(",", "."));
                              const f = Number.isFinite(v) && v > 0 ? v : 0;
                              setLinha(idx, { fator: f, unidades: l.xml.qCom * f, nota: f !== 1 ? `${l.xml.qCom} ${l.xml.uCom} × ${f}` : null });
                            }}
                            className="h-8 w-16 ml-auto text-center font-mono text-xs"
                            inputMode="decimal"
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <Input
                            value={String(l.unidades)}
                            disabled={!l.incluir}
                            onChange={(e) => {
                              const v = Number(e.target.value.replace(",", "."));
                              const u = Number.isFinite(v) && v >= 0 ? v : 0;
                              setLinha(idx, { unidades: u, fator: l.xml.qCom > 0 ? u / l.xml.qCom : l.fator });
                            }}
                            className="h-8 w-24 ml-auto text-center font-mono text-xs"
                            inputMode="numeric"
                          />
                          {l.nota && <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[180px] ml-auto">{l.nota}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(semSku > 0 || skuDesconhecido > 0) && (
              <div className="text-xs text-amber-800 dark:text-amber-300">
                {semSku > 0 && <span>{semSku} item(ns) sem SKU. </span>}
                {skuDesconhecido > 0 && <span>{skuDesconhecido} SKU(s) não existem no cadastro — confira antes de criar. </span>}
                Desmarque o que não deve entrar (brinde, material de uso).
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-3 sm:justify-between items-center">
          {nf ? (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={jaRecebido} onCheckedChange={(v) => setJaRecebido(v === true)} />
                Já conferi — lançar as quantidades da NF como recebidas
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={lembrar} onCheckedChange={(v) => setLembrar(v === true)} />
                Lembrar o de-para (produto e fator) para as próximas notas deste fornecedor
              </label>
            </div>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={() => void criar()} disabled={!nf || incluidas.length === 0 || salvando} className="gap-2">
              {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
              Criar entrada ({incluidas.length} item{incluidas.length === 1 ? "" : "s"})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
