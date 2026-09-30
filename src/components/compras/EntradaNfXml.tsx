import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp, Loader2 } from "lucide-react";
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
import { parseNfe, similaridade, soDigitos, tokens, unidadesDe, type ItemXml, type NfXml } from "@/lib/nfe";

// ============================================================================
// Nova entrada de recebimento pelo XML da NF-e do fornecedor (30/set/2026).
// O operador sobe o XML; o app lê os itens (det/prod), casa cada um com um
// item da OC (EAN → código = SKU → descrição) e SOMA as unidades ao já
// recebido — uma OC pode chegar em várias notas. Tudo é revisável antes de
// gravar. Grava só no app (compra_ordem_itens.qtd_recebida + nº da NF na OC);
// não mexe no Tiny nem no estoque.
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
}

interface Linha {
  xml: ItemXml;
  itemId: string | null; // item da OC; null = ignorar
  metodo: "ean" | "codigo" | "descricao" | null;
  unidades: number;
  nota: string | null; // conversão de unidade aplicada / aviso
}

const IGNORAR = "__ignorar__";

// Casa um item da NF com um item da OC: EAN (comercial ou tributável) →
// código do fornecedor igual ao nosso SKU → descrição parecida (conferir).
function casar(x: ItemXml, oc: ItemEntrada[]): { item: ItemEntrada | null; metodo: Linha["metodo"]; viaTrib: boolean } {
  for (const it of oc) {
    const g = soDigitos(it.gtin);
    if (!g) continue;
    if (x.ean === g) return { item: it, metodo: "ean", viaTrib: false };
    if (x.eanTrib === g) return { item: it, metodo: "ean", viaTrib: true };
  }
  const cod = x.cProd.trim().toUpperCase();
  const porCod = oc.find((it) => (it.sku ?? "").trim().toUpperCase() === cod && cod !== "");
  if (porCod) return { item: porCod, metodo: "codigo", viaTrib: false };
  let melhor: ItemEntrada | null = null;
  let score = 0;
  for (const it of oc) {
    const sc = similaridade(x.xProd, it.descricao);
    if (sc > score) { score = sc; melhor = it; }
  }
  if (melhor && score >= 0.6) return { item: melhor, metodo: "descricao", viaTrib: false };
  return { item: null, metodo: null, viaTrib: false };
}

export function EntradaNfXml({
  ordem, itens, open, onOpenChange,
}: {
  ordem: OrdemEntrada;
  itens: ItemEntrada[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const inputRef = useRef<HTMLInputElement>(null);
  const [nf, setNf] = useState<NfXml | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [somar, setSomar] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  function limpar() {
    setNf(null); setLinhas([]); setErro(null); setSomar(true);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    setErro(null);
    try {
      const nota = parseNfe(await f.text());
      setNf(nota);
      setLinhas(nota.itens.map((x) => {
        const m = casar(x, itens);
        const u = unidadesDe(x, m.viaTrib, m.item?.emb_unidades);
        return { xml: x, itemId: m.item?.id ?? null, metodo: m.metodo, unidades: u.q, nota: u.nota };
      }));
    } catch (e) {
      setNf(null); setLinhas([]);
      setErro((e as Error).message);
    }
  }

  function trocarItem(idx: number, itemId: string | null) {
    setLinhas((ls) => ls.map((l, i) => {
      if (i !== idx) return l;
      const item = itens.find((it) => it.id === itemId) ?? null;
      const u = unidadesDe(l.xml, false, item?.emb_unidades);
      return { ...l, itemId, metodo: itemId ? l.metodo : null, unidades: u.q, nota: u.nota };
    }));
  }

  // Soma por item da OC (duas linhas da NF podem ser o mesmo produto).
  const porItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of linhas) if (l.itemId && l.unidades > 0) m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.unidades);
    return m;
  }, [linhas]);
  const semCasar = linhas.filter((l) => !l.itemId).length;
  const jaLancada = !!nf && (ordem.nf_numero ?? "").split(/[,;\s]+/).includes(nf.numero);
  const fornecedorOc = ordem.fornecedor_fantasia || ordem.fornecedor_nome || "";
  const fornecedorDifere = !!nf && fornecedorOc !== "" && (() => {
    const a = tokens(fornecedorOc);
    const b = tokens(`${nf.emitente} ${nf.cnpj}`);
    for (const w of a) if (b.has(w)) return false;
    return true;
  })();

  async function lancar() {
    if (!nf || porItem.size === 0) return;
    setSalvando(true);
    try {
      const agora = new Date().toISOString();
      for (const [id, add] of porItem) {
        const it = itens.find((x) => x.id === id);
        if (!it) continue;
        const novo = somar ? Number(it.qtd_recebida ?? 0) + add : add;
        const { error } = await supabaseExternal.from("compra_ordem_itens")
          .update({ qtd_recebida: novo, conferido: true, atualizado_em: agora }).eq("id", id);
        if (error) throw new Error(`${it.sku ?? it.descricao}: ${error.message}`);
      }
      const nfs = (ordem.nf_numero ?? "").trim();
      const nfNumero = !nfs ? nf.numero : jaLancada ? nfs : `${nfs}, ${nf.numero}`;
      const dia = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
      const log = `Entrada NF ${nf.numero} (XML) ${dia}${perfil?.nome ? ` por ${perfil.nome}` : ""}`;
      const obs = [ordem.observacao_recebimento?.trim(), log].filter(Boolean).join(" · ");
      const { error: eOc } = await supabaseExternal.from("compras_ordens")
        .update({ nf_numero: nfNumero, observacao_recebimento: obs }).eq("tiny_id", ordem.tiny_id);
      if (eOc) throw eOc;
      // Se a mesma NF já está no espelho do Tiny sem OC, vincula a esta.
      if (ordem.fornecedor_id) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: ordem.tiny_id, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("fornecedor_id", ordem.fornecedor_id).in("numero", [...new Set([nf.numero, nf.numeroBruto])])
          .is("ordem_tiny_id", null);
      }
      const total = [...porItem.values()].reduce((s, v) => s + v, 0);
      toast.success(`Entrada da NF ${nf.numero} lançada`, {
        description: `${formatNumber(total)} un em ${porItem.size} item(ns)${semCasar ? ` · ${semCasar} linha(s) da NF ignorada(s)` : ""}`,
      });
      void qc.invalidateQueries({ queryKey: ["compras"] });
      limpar();
      onOpenChange(false);
    } catch (e) {
      toast.error("Falha ao lançar a entrada", { description: (e as Error).message });
      void qc.invalidateQueries({ queryKey: ["compras", "itens", ordem.tiny_id] });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) limpar(); onOpenChange(o); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Entrada de recebimento pelo XML da NF</DialogTitle>
          <DialogDescription>
            OC #{ordem.numero ?? ordem.tiny_id} · os itens da nota são casados com os da ordem e as
            unidades entram no recebido. Revise antes de lançar. Não altera o Tiny nem o estoque.
          </DialogDescription>
        </DialogHeader>

        {!nf && (
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
              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={limpar}>trocar arquivo</Button>
            </div>
            {jaLancada && (
              <div className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                A NF {nf.numero} já consta nesta ordem. Somar de novo vai dobrar o recebido — desmarque "somar" para substituir.
              </div>
            )}
            {fornecedorDifere && (
              <div className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                O emitente da NF ({nf.emitente}) parece diferente do fornecedor da OC ({fornecedorOc}). Confira se é a ordem certa.
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b">
                    <th className="py-1 pr-2 font-medium">Item da NF</th>
                    <th className="py-1 pr-2 font-medium text-right">Qtd NF</th>
                    <th className="py-1 pr-2 font-medium">Item da OC</th>
                    <th className="py-1 pr-2 font-medium text-right">Unidades</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l, idx) => (
                    <tr key={idx} className={cn("border-b last:border-0 align-top", !l.itemId && "bg-muted/40")}>
                      <td className="py-1.5 pr-2 max-w-[280px]">
                        <div className="truncate" title={l.xml.xProd}>{l.xml.xProd}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          cód {l.xml.cProd || "—"}{l.xml.ean ? ` · EAN ${l.xml.ean}` : ""}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                        {formatNumber(l.xml.qCom)} {l.xml.uCom}
                      </td>
                      <td className="py-1.5 pr-2 min-w-[240px]">
                        <Select value={l.itemId ?? IGNORAR} onValueChange={(v) => trocarItem(idx, v === IGNORAR ? null : v)}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={IGNORAR} className="text-xs">— não está na OC (ignorar) —</SelectItem>
                            {itens.map((it) => (
                              <SelectItem key={it.id} value={it.id} className="text-xs">
                                {it.sku ? `${it.sku} · ` : ""}{it.descricao ?? "—"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {l.itemId && l.metodo && (
                          <span className={cn("text-[10px]", l.metodo === "descricao" ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-muted-foreground")}>
                            {l.metodo === "ean" ? "casado pelo EAN" : l.metodo === "codigo" ? "casado pelo código" : "casado pela descrição — confira"}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        <Input
                          value={String(l.unidades)}
                          disabled={!l.itemId}
                          onChange={(e) => {
                            const v = Number(e.target.value.replace(",", "."));
                            setLinhas((ls) => ls.map((x, i) => (i === idx ? { ...x, unidades: Number.isFinite(v) && v >= 0 ? v : 0 } : x)));
                          }}
                          className="h-8 w-24 ml-auto text-center font-mono text-xs"
                          inputMode="numeric"
                        />
                        {l.nota && l.itemId && <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[180px] ml-auto">{l.nota}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {porItem.size > 0 && (
              <div className="rounded-md bg-muted/40 p-2.5 text-xs flex flex-col gap-1">
                <span className="font-semibold text-muted-foreground uppercase text-[10px] tracking-wide">Vai ficar assim</span>
                {[...porItem].map(([id, add]) => {
                  const it = itens.find((x) => x.id === id);
                  if (!it) return null;
                  const novo = somar ? Number(it.qtd_recebida ?? 0) + add : add;
                  return (
                    <div key={id} className="flex justify-between gap-3">
                      <span className="truncate">{it.sku ? `${it.sku} · ` : ""}{it.descricao}</span>
                      <span className="font-mono tabular-nums whitespace-nowrap">
                        {formatNumber(Number(it.qtd_recebida ?? 0))} → <b className={cn(novo > Number(it.quantidade) && "text-amber-700 dark:text-amber-400")}>{formatNumber(novo)}</b> / {formatNumber(Number(it.quantidade))} un
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-3 sm:justify-between items-center">
          {nf ? (
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={somar} onCheckedChange={(v) => setSomar(v === true)} />
              Somar ao já recebido (desmarcado = substitui)
            </label>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={() => void lancar()} disabled={!nf || porItem.size === 0 || salvando} className="gap-2">
              {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
              Lançar entrada
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
