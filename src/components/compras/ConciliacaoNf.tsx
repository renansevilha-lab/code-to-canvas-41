import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileCheck2, Link2, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { toSPDateKey } from "@/lib/date";
import type { NfXml } from "@/lib/nfe";
import type { NfPronta } from "@/components/compras/EntradaNfXml";
import { carregarNfTiny, normNf } from "@/lib/nfTiny";

// ============================================================================
// Conciliação OC × NF do fornecedor (item 1, 10/set/2026).
// Fonte: compras_nf_entrada (espelho das NF de ENTRADA do Tiny, sincronizado
// pela compras-sync?modulo=nf, cron 30 min) + view_compras_conciliacao(_itens).
// A conciliação automática casa por fornecedor + SKUs; aqui o operador vê a
// NF casada, item a item (qtd/preço OC × NF), e pode vincular/desvincular
// manualmente uma NF do mesmo fornecedor.
// 01/out/2026: vincular abre "Aplicar NF à conferência" (as quantidades da NF
// passam a valer na conferência; divergência OC × NF gravada na ordem). NF
// casada pelo cron fica com o botão "Aplicar à conferência" até alguém aplicar.
// ============================================================================

interface NfConciliada {
  nf_tiny_id: number; nf_numero: string | null; data_emissao: string | null;
  fornecedor_nome: string | null; nf_valor: number | null;
  ordem_tiny_id: number | null; oc_valor: number | null;
  match_metodo: string | null; match_score: number | null;
  dif_valor: number | null; itens_divergentes: number | null; itens_total: number | null;
}
interface ItemConc {
  nf_tiny_id: number; sku: string | null; descricao: string | null;
  qtd_oc: number | null; qtd_nf: number | null; preco_oc: number | null; preco_nf: number | null;
  qtd_recebida: number | null; dif_qtd: number | null; dif_preco: number | null; situacao: string;
}
interface NfLivre { tiny_id: number; numero: string | null; data_emissao: string | null; valor: number | null; fornecedor_nome: string | null }

const NF_LIVRE_DIAS = 15;

const SIT_LABEL: Record<string, { label: string; cls: string }> = {
  ok: { label: "ok", cls: "text-emerald-700 dark:text-emerald-400" },
  qtd: { label: "qtd difere", cls: "text-amber-700 dark:text-amber-400" },
  preco: { label: "preço difere", cls: "text-amber-700 dark:text-amber-400" },
  qtd_e_preco: { label: "qtd e preço", cls: "text-red-700 dark:text-red-400" },
  so_na_nf: { label: "só na NF", cls: "text-red-700 dark:text-red-400" },
  so_na_oc: { label: "só na OC", cls: "text-red-700 dark:text-red-400" },
};

export function ConciliacaoNf({ ordemTinyId, onAplicar }: { ordemTinyId: number; onAplicar: (nf: NfPronta) => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [vinculando, setVinculando] = useState<number | null>(null);
  const [abrindo, setAbrindo] = useState<number | null>(null);

  // NFs já aplicadas à conferência desta OC (por número, sem zeros à esquerda).
  const aplicadasQ = useQuery({
    queryKey: ["compras", "nf-qtd", ordemTinyId],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("compra_ordem_nf_qtd").select("nf_numero, item_id, qtd").eq("ordem_tiny_id", ordemTinyId);
      if (error) throw error;
      return (data ?? []) as { nf_numero: string; item_id: string; qtd: number }[];
    },
  });
  const aplicadas = new Set((aplicadasQ.data ?? []).map((r) => normNf(r.nf_numero)));

  async function abrirAplicar(nfTinyId: number) {
    setAbrindo(nfTinyId);
    try {
      onAplicar(await carregarNfTiny(nfTinyId));
    } catch (e) {
      toast.error("Não deu para abrir a NF", { description: (e as Error).message });
    } finally {
      setAbrindo(null);
    }
  }

  const nfsQ = useQuery({
    queryKey: ["compras", "conciliacao", ordemTinyId],
    queryFn: async (): Promise<NfConciliada[]> => {
      const { data, error } = await supabaseExternal
        .from("view_compras_conciliacao").select("*").eq("ordem_tiny_id", ordemTinyId).order("data_emissao", { ascending: false });
      if (error) throw error;
      return (data ?? []) as NfConciliada[];
    },
  });
  const nfIds = (nfsQ.data ?? []).map((n) => n.nf_tiny_id);
  const itensQ = useQuery({
    queryKey: ["compras", "conciliacao-itens", ordemTinyId, nfIds.join(",")],
    enabled: nfIds.length > 0,
    queryFn: async (): Promise<ItemConc[]> => {
      const { data, error } = await supabaseExternal
        .from("view_compras_conciliacao_itens").select("*").eq("ordem_tiny_id", ordemTinyId).order("sku");
      if (error) throw error;
      return (data ?? []) as ItemConc[];
    },
  });
  // NF do mesmo fornecedor ainda sem OC (para vincular na mão) — só as dos
  // últimos 15 dias: as antigas são de compras passadas e só poluíam a lista.
  const livresQ = useQuery({
    queryKey: ["compras", "nf-livres", ordemTinyId],
    queryFn: async (): Promise<NfLivre[]> => {
      const { data: oc } = await supabaseExternal.from("compras_ordens").select("fornecedor_id").eq("tiny_id", ordemTinyId).maybeSingle();
      const fid = (oc as { fornecedor_id: number | null } | null)?.fornecedor_id;
      if (!fid) return [];
      const { data, error } = await supabaseExternal
        .from("compras_nf_entrada").select("tiny_id, numero, data_emissao, valor, fornecedor_nome")
        .eq("fornecedor_id", fid).is("ordem_tiny_id", null).eq("ignorar", false)
        .gte("data_emissao", toSPDateKey(new Date(Date.now() - NF_LIVRE_DIAS * 86_400_000)))
        .order("data_emissao", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as NfLivre[];
    },
  });

  async function vincular(nfTinyId: number, desvincular = false, nfNumero?: string | null) {
    setVinculando(nfTinyId);
    try {
      // Desvincular uma NF já aplicada tira as quantidades dela da conferência.
      if (desvincular && nfNumero && aplicadas.has(normNf(nfNumero))) {
        const { error: eRm } = await supabaseExternal.rpc("compras_remover_nf", {
          p_ordem: ordemTinyId, p_nf_numero: nfNumero, p_por: perfil?.nome ?? null,
        });
        if (eRm) throw eRm;
      }
      const { error } = await supabaseExternal.from("compras_nf_entrada").update({
        ordem_tiny_id: desvincular ? null : ordemTinyId,
        match_metodo: desvincular ? null : "manual",
        match_score: null,
        conciliado_por: perfil?.nome ?? null,
        conciliado_em: new Date().toISOString(),
      }).eq("tiny_id", nfTinyId);
      if (error) throw error;
      toast.success(desvincular ? "NF desvinculada da ordem" : "NF vinculada à ordem — confira as quantidades e aplique");
      void qc.invalidateQueries({ queryKey: ["compras"] });
      if (!desvincular) void abrirAplicar(nfTinyId);
    } catch (e) {
      toast.error("Falha ao vincular NF", { description: (e as Error).message });
    } finally {
      setVinculando(null);
    }
  }

  const nfs = nfsQ.data ?? [];
  const itens = itensQ.data ?? [];
  const livres = livresQ.data ?? [];
  const divergentes = itens.filter((i) => i.situacao !== "ok");

  return (
    <Card className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <FileCheck2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">NF do fornecedor × ordem de compra</span>
        {nfsQ.isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {nfs.length > 0 && (
          divergentes.length === 0 && !itensQ.isLoading ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> itens conferem com a NF
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" /> {divergentes.length} item(ns) divergente(s)
            </span>
          )
        )}
      </div>

      {nfs.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          Nenhuma NF de entrada casada com esta ordem ainda. A conciliação automática roda a cada 30 min
          (NF do mesmo fornecedor com os mesmos SKUs).
          {livres.length > 0 && <span> Abaixo, NFs deste fornecedor sem ordem — vincule se for esta compra.</span>}
        </div>
      ) : (
        nfs.map((nf) => (
          <div key={nf.nf_tiny_id} className="rounded-md border p-2.5 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 flex-wrap text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span className="font-semibold">NF {nf.nf_numero ?? nf.nf_tiny_id}</span>
                <span className="text-muted-foreground text-xs">{nf.data_emissao ? nf.data_emissao.split("-").reverse().join("/") : "—"}</span>
                <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                  {nf.match_metodo === "manual" ? "manual" : nf.match_metodo === "auto_sku" ? `auto · ${Math.round(Number(nf.match_score ?? 0) * 100)}% SKUs` : "auto · fornecedor"}
                </span>
              </span>
              <span className="flex items-center gap-3 text-xs">
                <span className="tabular-nums font-mono">NF {formatBRL(Number(nf.nf_valor ?? 0))}</span>
                <span className="tabular-nums font-mono text-muted-foreground">OC {formatBRL(Number(nf.oc_valor ?? 0))}</span>
                <span className={cn("tabular-nums font-mono font-semibold", Math.abs(Number(nf.dif_valor ?? 0)) > 0.5 ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400")}>
                  Δ {formatBRL(Number(nf.dif_valor ?? 0))}
                </span>
                {aplicadas.has(normNf(nf.nf_numero)) ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                    <ClipboardCheck className="h-3.5 w-3.5" /> aplicada à conferência
                  </span>
                ) : null}
                <Button
                  variant={aplicadas.has(normNf(nf.nf_numero)) ? "ghost" : "default"} size="sm" className="h-7 text-xs gap-1"
                  disabled={abrindo === nf.nf_tiny_id} onClick={() => void abrirAplicar(nf.nf_tiny_id)}
                  title="As quantidades desta NF passam a valer na conferência">
                  {abrindo === nf.nf_tiny_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
                  {aplicadas.has(normNf(nf.nf_numero)) ? "reaplicar" : "Aplicar à conferência"}
                </Button>
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground" disabled={vinculando === nf.nf_tiny_id} onClick={() => void vincular(nf.nf_tiny_id, true, nf.nf_numero)} title="Desvincular esta NF da ordem">
                  <Unlink className="h-3 w-3" /> desvincular
                </Button>
              </span>
            </div>
            {aplicadas.has(normNf(nf.nf_numero)) ? (
              <span className="text-[11px] text-muted-foreground">
                Quantidades desta NF aplicadas à conferência (em unidades) — as diferenças com a OC estão no quadro "Divergência OC × NF".
              </span>
            ) : itens.length > 0 && (
              <div className="overflow-x-auto">
                <span className="text-[10.5px] text-muted-foreground">Como a NF está no Tiny (quantidade na unidade da nota — pode ser caixa/fardo). Ainda não vale para a conferência.</span>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-muted-foreground border-b">
                      <th className="py-1 pr-2 font-medium">SKU</th>
                      <th className="py-1 pr-2 font-medium">Produto</th>
                      <th className="py-1 pr-2 font-medium text-right">Qtd OC</th>
                      <th className="py-1 pr-2 font-medium text-right">Qtd NF</th>
                      <th className="py-1 pr-2 font-medium text-right">Recebida</th>
                      <th className="py-1 pr-2 font-medium text-right">R$ OC</th>
                      <th className="py-1 pr-2 font-medium text-right">R$ NF</th>
                      <th className="py-1 font-medium">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itens.filter((i) => i.nf_tiny_id === nf.nf_tiny_id || i.nf_tiny_id == null).map((i, idx) => {
                      const s = SIT_LABEL[i.situacao] ?? { label: i.situacao, cls: "" };
                      return (
                        <tr key={`${i.sku}-${idx}`} className={cn("border-b last:border-0", i.situacao !== "ok" && "bg-amber-500/5")}>
                          <td className="py-1 pr-2 font-mono">{i.sku ?? "—"}</td>
                          <td className="py-1 pr-2 text-muted-foreground max-w-[260px] truncate">{i.descricao ?? "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums">{i.qtd_oc != null ? formatNumber(Number(i.qtd_oc)) : "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums font-semibold">{i.qtd_nf != null ? formatNumber(Number(i.qtd_nf)) : "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{i.qtd_recebida != null ? formatNumber(Number(i.qtd_recebida)) : "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums font-mono">{i.preco_oc != null ? formatBRL(Number(i.preco_oc)) : "—"}</td>
                          <td className="py-1 pr-2 text-right tabular-nums font-mono">{i.preco_nf != null ? formatBRL(Number(i.preco_nf)) : "—"}</td>
                          <td className={cn("py-1 font-medium", s.cls)}>{s.label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}

      {livres.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">NFs deste fornecedor sem ordem vinculada (últimos {NF_LIVRE_DIAS} dias):</span>
          {livres.map((nf) => (
            <div key={nf.tiny_id} className="flex items-center justify-between gap-2 text-xs rounded border border-dashed px-2 py-1">
              <span>
                NF <span className="font-semibold">{nf.numero}</span> · {nf.data_emissao ? nf.data_emissao.split("-").reverse().join("/") : "—"} · {formatBRL(Number(nf.valor ?? 0))}
              </span>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1" disabled={vinculando === nf.tiny_id} onClick={() => void vincular(nf.tiny_id)}>
                {vinculando === nf.tiny_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} vincular
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
