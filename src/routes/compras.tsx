import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Boxes, Check, CheckCircle2, FileText, Layers, Loader2,
  Package as PackageIcon, PackagePlus, RefreshCw, Truck,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Compras & Recebimento de Mercadorias — kanban integrado às ORDENS DE COMPRA
// do Tiny (espelho: compras_ordens / compra_ordem_itens, sync pela edge fn
// compras-sync a cada 30 min). O kanban é o fluxo FÍSICO do recebimento — o
// Tiny não modela conferência de chegada; a situação do Tiny é só um selo.
// Abrir um card = conferência no estilo do packing do Fulfillment: contar o
// que chegou por item + apontar o encaixotamento (caixa/fardo com N) e a
// amarração do pallet (lastro × altura). A embalagem é lembrada por SKU
// (produto_embalagem) e pré-preenche a próxima compra.
// ============================================================================

interface Ordem {
  tiny_id: number;
  numero: string | null;
  data_pedido: string | null;
  data_prevista: string | null;
  situacao_tiny: string | null;
  fornecedor_nome: string | null;
  fornecedor_fantasia: string | null;
  categoria: string | null;
  total_pedido: number | null;
  itens_qtd: number | null;
  kanban_status: string;
  recebido_em: string | null;
  recebido_por: string | null;
  arquivada_em: string | null;
  observacao_recebimento: string | null;
  nf_numero: string | null;
}

interface ItemOrdem {
  id: string;
  ordem_tiny_id: number;
  sku: string | null;
  descricao: string | null;
  gtin: string | null;
  quantidade: number;
  preco: number | null;
  qtd_recebida: number;
  conferido: boolean;
  emb_tipo: string | null;
  emb_unidades: number | null;
  pallet_lastro: number | null;
  pallet_altura: number | null;
  pallets: number | null;
  observacao: string | null;
}

interface EmbalagemSku {
  sku: string;
  emb_tipo: string | null;
  emb_unidades: number | null;
  pallet_lastro: number | null;
  pallet_altura: number | null;
}

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// Situação da ordem NO TINY (selo informativo; o fluxo do kanban é nosso).
const SIT_TINY: Record<string, { label: string; cls: string }> = {
  "0": { label: "Em aberto", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
  "1": { label: "Atendida", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" },
  "2": { label: "Cancelada", cls: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300" },
  "3": { label: "Em andamento", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
};

// Colunas do RECEBIMENTO (mesmo desenho do quadro do Fulfillment).
const STAGES: Array<{ id: string; label: string; curto: string; col: string; tint: string }> = [
  { id: "orcamento", label: "Em orçamento", curto: "Orçamento", col: "#5C6470", tint: "#F2F3F5" },
  { id: "aguardando", label: "Aguardando chegada", curto: "Aguardando", col: "#B7791F", tint: "#FDF6EA" },
  { id: "conferencia", label: "Em conferência", curto: "Conferência", col: "#2F6FB0", tint: "#EEF5FC" },
  { id: "divergente", label: "Divergência", curto: "Divergência", col: "#C9432F", tint: "#FBEFED" },
  { id: "concluida", label: "Recebida", curto: "Recebida", col: "#0E8A5F", tint: "#EBF7F1" },
];
const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const stageDe = (status: string) => STAGE_MAP[status] ?? STAGE_MAP["aguardando"];

const EMB_TIPOS: Array<{ id: string; label: string }> = [
  { id: "caixa", label: "Caixa" },
  { id: "fardo", label: "Fardo" },
  { id: "unidade", label: "Unidade solta" },
];

function fornecedorDe(o: Ordem): string {
  return o.fornecedor_fantasia?.trim() || o.fornecedor_nome?.trim() || "—";
}
function dataBR(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function useFotos(skus: (string | null)[]) {
  const chave = useMemo(
    () => Array.from(new Set(skus.filter((s): s is string => !!s))).sort(),
    [skus],
  );
  return useQuery({
    queryKey: ["compras", "fotos", chave],
    enabled: chave.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      const map: Record<string, string> = {};
      for (let i = 0; i < chave.length; i += 300) {
        const lote = chave.slice(i, i + 300);
        const { data } = await supabaseExternal
          .from("produtos").select("sku, foto_capa").in("sku", lote);
        for (const r of (data ?? []) as { sku: string; foto_capa: string | null }[]) {
          if (r.foto_capa) map[r.sku] = r.foto_capa;
        }
      }
      return map;
    },
  });
}

function Foto({ url, className }: { url?: string | null; className?: string }) {
  const [erro, setErro] = useState(false);
  if (!url || erro) {
    return (
      <div className={cn("rounded-[10px] bg-muted flex items-center justify-center shrink-0", className)}>
        <PackageIcon className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img src={url} alt="" loading="lazy" onError={() => setErro(true)}
      className={cn("rounded-[10px] object-cover bg-muted shrink-0", className)} />
  );
}

// ============================================================================
// Página
// ============================================================================

function ComprasPage() {
  const [confId, setConfId] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-5 p-6 max-w-[1500px] mx-auto">
      {confId === null ? (
        <QuadroCompras onAbrir={setConfId} />
      ) : (
        <ConferenciaOrdem tinyId={confId} onVoltar={() => setConfId(null)} />
      )}
    </div>
  );
}

// ============================================================================
// Kanban
// ============================================================================

function QuadroCompras({ onAbrir }: { onAbrir: (tinyId: number) => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  // Valor da compra e informacao de gestao: so ADM (modulo "todos") ve R$.
  const ehAdm = !!perfil?.modulos.includes("todos");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [sincronizando, setSincronizando] = useState(false);

  const ordensQ = useQuery({
    queryKey: ["compras", "ordens"],
    queryFn: async (): Promise<Ordem[]> => {
      const { data, error } = await supabaseExternal
        .from("compras_ordens").select("*")
        .is("arquivada_em", null)
        .order("data_pedido", { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data ?? []) as Ordem[];
    },
  });

  // Progresso recebido/pedido por ordem (as ordens da janela têm poucas linhas).
  const progQ = useQuery({
    queryKey: ["compras", "progresso"],
    queryFn: async (): Promise<Map<number, { ped: number; rec: number }>> => {
      const { data, error } = await supabaseExternal
        .from("compra_ordem_itens")
        .select("ordem_tiny_id, quantidade, qtd_recebida")
        .limit(5000);
      if (error) throw error;
      const map = new Map<number, { ped: number; rec: number }>();
      for (const r of (data ?? []) as { ordem_tiny_id: number; quantidade: number; qtd_recebida: number }[]) {
        const g = map.get(r.ordem_tiny_id) ?? { ped: 0, rec: 0 };
        g.ped += num(r.quantidade);
        g.rec += num(r.qtd_recebida);
        map.set(r.ordem_tiny_id, g);
      }
      return map;
    },
  });

  const ordens = ordensQ.data ?? [];

  async function moverPara(tinyId: number, status: string) {
    const atual = ordens.find((o) => o.tiny_id === tinyId);
    if (!atual || atual.kanban_status === status) return;
    qc.setQueryData<Ordem[]>(["compras", "ordens"], (old) =>
      (old ?? []).map((o) => (o.tiny_id === tinyId ? { ...o, kanban_status: status } : o)),
    );
    const { error } = await supabaseExternal
      .from("compras_ordens").update({ kanban_status: status }).eq("tiny_id", tinyId);
    if (error) {
      toast.error("Falha ao mover", { description: error.message });
      void qc.invalidateQueries({ queryKey: ["compras", "ordens"] });
    }
  }

  async function arquivar(o: Ordem) {
    qc.setQueryData<Ordem[]>(["compras", "ordens"], (old) =>
      (old ?? []).filter((x) => x.tiny_id !== o.tiny_id),
    );
    const { error } = await supabaseExternal
      .from("compras_ordens")
      .update({ arquivada_em: new Date().toISOString() })
      .eq("tiny_id", o.tiny_id);
    if (error) {
      toast.error("Falha ao arquivar", { description: error.message });
      void qc.invalidateQueries({ queryKey: ["compras", "ordens"] });
    }
  }

  async function sincronizar() {
    setSincronizando(true);
    try {
      const resp = await fetch(
        `${EXTERNAL_URL}/functions/v1/compras-sync?modulo=sync&dias=90&max=25`,
        { method: "POST", headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
      );
      const d = (await resp.json().catch(() => ({}))) as {
        inseridas?: number; atualizadas?: number; erro?: string;
      };
      if (!resp.ok || d.erro) throw new Error(d.erro ?? `HTTP ${resp.status}`);
      toast.success(`Sincronizado com o Tiny`, {
        description: `${d.inseridas ?? 0} nova(s) · ${d.atualizadas ?? 0} atualizada(s)`,
      });
      await qc.invalidateQueries({ queryKey: ["compras"] });
    } catch (e) {
      toast.error("Falha ao sincronizar", { description: (e as Error).message });
    } finally {
      setSincronizando(false);
    }
  }

  const hoje = new Date().toISOString().slice(0, 10);
  // "Em aberto" = aguardando chegada ou em conferencia; orcamento ainda nao conta.
  const orcamentos = ordens.filter((o) => o.kanban_status === "orcamento");
  const abertas = ordens.filter(
    (o) => o.kanban_status !== "concluida" && o.kanban_status !== "orcamento",
  );
  const totalUn = abertas.reduce((s, o) => s + num(o.itens_qtd), 0);

  return (
    <>
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary" /> Compras & Recebimento
          </h1>
          <span className="text-sm text-muted-foreground">
            Ordens de compra do Tiny · conferência física na chegada
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void sincronizar()} disabled={sincronizando} className="gap-2">
          {sincronizando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Atualizar do Tiny
        </Button>
      </div>

      {/* Contadores */}
      <div className="flex items-center gap-2.5 flex-wrap">
        {[
          { label: "Em orçamento", value: orcamentos.length },
          { label: "Aguardando / conferindo", value: abertas.length },
          { label: "Unidades a receber", value: formatNumber(totalUn) },
        ].map((c) => (
          <Card key={c.label} className="px-4 py-2.5 flex flex-col gap-0.5 min-w-[110px]">
            <span className="text-xl font-extrabold tabular-nums leading-none">{c.value}</span>
            <span className="text-[11px] text-muted-foreground font-semibold">{c.label}</span>
          </Card>
        ))}
      </div>

      {ordensQ.isLoading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando ordens…
        </div>
      )}

      {!ordensQ.isLoading && (
        <div
          className="grid gap-3.5 overflow-x-auto pb-1.5 items-start"
          style={{ gridTemplateColumns: "repeat(5, minmax(200px, 1fr))" }}
        >
          {STAGES.map((stage) => {
            const doStage = ordens.filter((o) => stageDe(o.kanban_status).id === stage.id);
            const over = dragId !== null && dragOver === stage.id;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => { e.preventDefault(); if (dragOver !== stage.id) setDragOver(stage.id); }}
                onDragLeave={() => { if (dragOver === stage.id) setDragOver(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = Number(e.dataTransfer.getData("text/plain") || dragId);
                  if (id) void moverPara(id, stage.id);
                }}
                className="flex flex-col gap-2.5 min-h-[200px] rounded-[14px] p-1.5 pb-2.5"
                style={{
                  background: over ? "#F7F6FD" : stage.tint,
                  border: over ? "1.5px dashed var(--color-primary)" : `1.5px solid ${stage.tint}`,
                }}
              >
                <div className="flex items-center gap-2 px-2 py-2 -mx-1.5 -mt-1.5 rounded-t-[10px]" style={{ background: stage.col }}>
                  <span className="h-[7px] w-[7px] rounded-full bg-white shrink-0" />
                  <span className="text-[11.5px] font-bold uppercase tracking-wide text-white">{stage.curto}</span>
                  <div className="flex-1" />
                  <span className="text-[11px] font-bold text-white font-mono px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,.28)" }}>
                    {doStage.length}
                  </span>
                </div>

                {doStage.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#C9CFD8] py-5 px-4 flex flex-col items-center gap-1.5 text-center" style={{ background: "rgba(255,255,255,.5)" }}>
                    <span className="text-[#B8BEC8] text-base">◌</span>
                    <span className="text-[12px] font-medium text-[#8B93A1]">Nenhuma ordem</span>
                  </div>
                ) : (
                  doStage.map((o) => {
                    const sit = SIT_TINY[o.situacao_tiny ?? ""] ?? null;
                    const p = progQ.data?.get(o.tiny_id);
                    const ped = p?.ped ?? num(o.itens_qtd);
                    const rec = p?.rec ?? 0;
                    const pct = ped > 0 ? Math.min(100, (rec / ped) * 100) : 0;
                    const atrasada = !!o.data_prevista && o.kanban_status === "aguardando" && o.data_prevista < hoje;
                    return (
                      <div
                        key={o.tiny_id}
                        draggable
                        onDragStart={(ev) => { ev.dataTransfer.setData("text/plain", String(o.tiny_id)); ev.dataTransfer.effectAllowed = "move"; setDragId(o.tiny_id); }}
                        onDragEnd={() => { setDragId(null); setDragOver(null); }}
                        onClick={() => { if (!dragId) onAbrir(o.tiny_id); }}
                        className="bg-card rounded-xl p-3 flex flex-col gap-2 cursor-grab"
                        style={{ border: "1px solid #E6E8EC", borderLeft: `4px solid ${stage.col}`, opacity: dragId === o.tiny_id ? 0.4 : 1 }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-extrabold font-mono">OC #{o.numero ?? o.tiny_id}</span>
                          <div className="flex-1" />
                          {sit && <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap", sit.cls)}>{sit.label}</span>}
                        </div>
                        <span className="text-[12.5px] font-semibold leading-snug line-clamp-2">{fornecedorDe(o)}</span>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Truck className="h-3 w-3 shrink-0" />
                          <span>{dataBR(o.data_pedido)}</span>
                          {o.data_prevista && (
                            <span className={cn(atrasada && "text-red-600 font-bold")}>
                              · prev. {dataBR(o.data_prevista)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-mono font-bold">{formatNumber(rec)} / {formatNumber(ped)} un</span>
                          {ehAdm && <span className="text-muted-foreground">{formatBRL(num(o.total_pedido))}</span>}
                        </div>
                        <div className="h-1.5 rounded bg-muted overflow-hidden">
                          <div className="h-full rounded" style={{ width: `${pct}%`, background: stage.col }} />
                        </div>
                        {o.kanban_status === "concluida" && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void arquivar(o); }}
                            className="text-[11px] text-muted-foreground hover:text-foreground text-left underline-offset-2 hover:underline"
                          >
                            Arquivar
                          </button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ============================================================================
// Conferência de uma ordem (estilo packing do Fulfillment)
// ============================================================================

function ConferenciaOrdem({ tinyId, onVoltar }: { tinyId: number; onVoltar: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const ehAdm = !!perfil?.modulos.includes("todos");
  const [salvandoFim, setSalvandoFim] = useState(false);

  const ordemQ = useQuery({
    queryKey: ["compras", "ordem", tinyId],
    queryFn: async (): Promise<Ordem | null> => {
      const { data, error } = await supabaseExternal
        .from("compras_ordens").select("*").eq("tiny_id", tinyId).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Ordem | null;
    },
  });

  const itensQ = useQuery({
    queryKey: ["compras", "itens", tinyId],
    queryFn: async (): Promise<ItemOrdem[]> => {
      const { data, error } = await supabaseExternal
        .from("compra_ordem_itens").select("*")
        .eq("ordem_tiny_id", tinyId)
        .order("descricao");
      if (error) throw error;
      return (data ?? []) as ItemOrdem[];
    },
  });

  const itens = useMemo(() => itensQ.data ?? [], [itensQ.data]);
  const skus = useMemo(() => itens.map((i) => i.sku), [itens]);
  const fotosQ = useFotos(skus);

  // Embalagem lembrada por SKU — pré-preenche o que o item ainda não tem.
  const embQ = useQuery({
    queryKey: ["compras", "embalagem", skus],
    enabled: skus.some(Boolean),
    queryFn: async (): Promise<Record<string, EmbalagemSku>> => {
      const lista = skus.filter((s): s is string => !!s);
      const map: Record<string, EmbalagemSku> = {};
      for (let i = 0; i < lista.length; i += 300) {
        const { data } = await supabaseExternal
          .from("produto_embalagem").select("*").in("sku", lista.slice(i, i + 300));
        for (const r of (data ?? []) as EmbalagemSku[]) map[r.sku] = r;
      }
      return map;
    },
  });

  const ordem = ordemQ.data;
  const ped = itens.reduce((s, i) => s + num(i.quantidade), 0);
  const rec = itens.reduce((s, i) => s + num(i.qtd_recebida), 0);
  const pct = ped > 0 ? Math.min(100, (rec / ped) * 100) : 0;
  const completo = ped > 0 && rec >= ped && itens.every((i) => num(i.qtd_recebida) === num(i.quantidade));

  function patchLocal(id: string, patch: Partial<ItemOrdem>) {
    qc.setQueryData<ItemOrdem[]>(["compras", "itens", tinyId], (old) =>
      (old ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  }

  // qtd recebida: update otimista (igual ao packing do Fulfillment)
  async function setRecebida(item: ItemOrdem, qtd: number) {
    const clamped = Math.max(0, qtd);
    patchLocal(item.id, { qtd_recebida: clamped, conferido: true });
    const { error } = await supabaseExternal
      .from("compra_ordem_itens")
      .update({ qtd_recebida: clamped, conferido: true, atualizado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) {
      toast.error("Falha ao salvar quantidade", { description: error.message });
      void qc.invalidateQueries({ queryKey: ["compras", "itens", tinyId] });
    } else {
      void qc.invalidateQueries({ queryKey: ["compras", "progresso"] });
    }
  }

  // Embalagem/amarração desta CHEGADA: grava só no item. O cadastro do SKU
  // (que pré-preenche as próximas compras) é salvo pelo botão explícito —
  // padrão errado se propagaria em silêncio.
  async function salvarEmbalagem(item: ItemOrdem, patch: Partial<ItemOrdem>) {
    patchLocal(item.id, patch);
    const { error } = await supabaseExternal
      .from("compra_ordem_itens")
      .update({ ...patch, atualizado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) toast.error("Falha ao salvar embalagem", { description: error.message });
  }

  // Salva o MODELO de encaixotamento do SKU para as futuras compras.
  async function salvarPadrao(item: ItemOrdem, padrao: Omit<EmbalagemSku, "sku">) {
    if (!item.sku) { toast.error("Item sem SKU — não dá para salvar modelo"); return; }
    const { error } = await supabaseExternal.from("produto_embalagem").upsert({
      sku: item.sku, ...padrao,
      atualizado_em: new Date().toISOString(),
      atualizado_por: perfil?.nome ?? null,
    }, { onConflict: "sku" });
    if (error) { toast.error("Falha ao salvar modelo", { description: error.message }); return; }
    toast.success(`Modelo de encaixotamento salvo — SKU ${item.sku}`, {
      description: "As próximas compras deste produto virão pré-preenchidas.",
    });
    void qc.invalidateQueries({ queryKey: ["compras", "embalagem"] });
  }

  // NF vinculada / observação do recebimento (cabeçalho da ordem).
  async function salvarOrdem(patch: Partial<Ordem>) {
    qc.setQueryData<Ordem | null>(["compras", "ordem", tinyId], (old) => (old ? { ...old, ...patch } : old));
    const { error } = await supabaseExternal
      .from("compras_ordens").update(patch).eq("tiny_id", tinyId);
    if (error) toast.error("Falha ao salvar", { description: error.message });
  }

  async function concluir() {
    if (!ordem) return;
    const divergente = !completo;
    if (divergente && !window.confirm(
      `Recebido ${formatNumber(rec)} de ${formatNumber(ped)} unidades — há divergência. Concluir mesmo assim (vai para a coluna Divergência)?`,
    )) return;
    setSalvandoFim(true);
    try {
      const { error } = await supabaseExternal.from("compras_ordens").update({
        kanban_status: divergente ? "divergente" : "concluida",
        recebido_em: new Date().toISOString(),
        recebido_por: perfil?.nome ?? null,
      }).eq("tiny_id", tinyId);
      if (error) throw error;
      toast.success(divergente ? "Conferência concluída com divergência" : "Recebimento concluído", {
        description: `OC #${ordem.numero} · ${formatNumber(rec)}/${formatNumber(ped)} un`,
      });
      void qc.invalidateQueries({ queryKey: ["compras"] });
      onVoltar();
    } catch (e) {
      toast.error("Falha ao concluir", { description: (e as Error).message });
    } finally {
      setSalvandoFim(false);
    }
  }

  if (ordemQ.isLoading || itensQ.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando ordem…
      </div>
    );
  }
  if (!ordem) {
    return (
      <Card className="p-8 text-center">
        <span className="text-sm text-muted-foreground">Ordem não encontrada.</span>
        <div className="mt-4"><Button variant="outline" onClick={onVoltar}>Voltar</Button></div>
      </Card>
    );
  }

  const sit = SIT_TINY[ordem.situacao_tiny ?? ""] ?? null;

  return (
    <>
      {/* Cabeçalho da conferência */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onVoltar} className="gap-1.5 -ml-2">
            <ArrowLeft className="h-4 w-4" /> Quadro
          </Button>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-extrabold font-mono">OC #{ordem.numero ?? tinyId}</h1>
              {sit && <span className={cn("text-[10.5px] font-bold px-2 py-0.5 rounded-full", sit.cls)}>{sit.label} no Tiny</span>}
            </div>
            <span className="text-sm text-muted-foreground">
              {fornecedorDe(ordem)} · pedido {dataBR(ordem.data_pedido)}
              {ordem.data_prevista ? ` · previsto ${dataBR(ordem.data_prevista)}` : ""}
              {ehAdm ? ` · ${formatBRL(num(ordem.total_pedido))}` : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end">
            <span className="text-lg font-extrabold tabular-nums leading-none">
              {formatNumber(rec)} <span className="text-muted-foreground font-semibold text-sm">/ {formatNumber(ped)} un</span>
            </span>
            <div className="h-1.5 w-36 rounded bg-muted overflow-hidden mt-1.5">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: completo ? "#0E8A5F" : "#B7791F" }} />
            </div>
          </div>
          <Button onClick={() => void concluir()} disabled={salvandoFim || itens.length === 0} className="gap-2">
            {salvandoFim ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {completo ? "Concluir recebimento" : "Concluir com divergência"}
          </Button>
        </div>
      </div>

      {/* NF vinculada + observação do recebimento */}
      <Card className="p-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground whitespace-nowrap">NF vinculada</span>
          <CampoTexto
            valor={ordem.nf_numero}
            placeholder="nº ou chave da nota…"
            onCommit={(v) => void salvarOrdem({ nf_numero: v })}
            className="w-[300px]"
          />
        </div>
        <div className="flex items-center gap-2 flex-1 min-w-[280px]">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground whitespace-nowrap">Observação</span>
          <CampoTexto
            valor={ordem.observacao_recebimento}
            placeholder="ex.: chegou em 2 entregas, caixa amassada…"
            onCommit={(v) => void salvarOrdem({ observacao_recebimento: v })}
            className="flex-1"
          />
        </div>
      </Card>

      {/* Itens */}
      <div className="flex flex-col gap-3">
        {itens.map((it) => (
          <ItemConferencia
            key={it.id}
            item={it}
            foto={it.sku ? fotosQ.data?.[it.sku] : undefined}
            lembrada={it.sku ? embQ.data?.[it.sku] : undefined}
            onQtd={(q) => void setRecebida(it, q)}
            onEmb={(patch) => void salvarEmbalagem(it, patch)}
            onSalvarPadrao={(padrao) => void salvarPadrao(it, padrao)}
          />
        ))}
        {itens.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Itens ainda não sincronizados — use "Atualizar do Tiny" no quadro.
          </Card>
        )}
      </div>
    </>
  );
}

// ---- linha de item: entrada unitária + entrada por encaixotamento -----------

function ItemConferencia({
  item, foto, lembrada, onQtd, onEmb, onSalvarPadrao,
}: {
  item: ItemOrdem;
  foto?: string;
  lembrada?: EmbalagemSku;
  onQtd: (qtd: number) => void;
  onEmb: (patch: Partial<ItemOrdem>) => void;
  onSalvarPadrao: (padrao: Omit<EmbalagemSku, "sku">) => void;
}) {
  // efetivo = o que está no item; se vazio, o lembrado do SKU (pré-preenchido)
  const embTipo = item.emb_tipo ?? lembrada?.emb_tipo ?? null;
  const embUnid = item.emb_unidades ?? lembrada?.emb_unidades ?? null;
  const lastro = item.pallet_lastro ?? lembrada?.pallet_lastro ?? null;
  const altura = item.pallet_altura ?? lembrada?.pallet_altura ?? null;

  const ok = num(item.qtd_recebida) === num(item.quantidade) && item.conferido;
  const caixasPorPallet = lastro && altura ? lastro * altura : null;
  const rotuloEmb = embTipo === "fardo" ? "fardo" : "caixa";

  // entrada por encaixotamento: caixas <-> unidades (a fonte é sempre qtd_recebida)
  const podeCaixa = !!embUnid && embUnid > 0 && embTipo !== "unidade";
  const caixasAtuais = podeCaixa ? num(item.qtd_recebida) / (embUnid as number) : 0;
  const caixasFmt = podeCaixa
    ? String(Number.isInteger(caixasAtuais) ? caixasAtuais : Number(caixasAtuais.toFixed(2)))
    : "";

  // modelo já salvo no cadastro do SKU e igual ao apontado aqui?
  const padraoIgual = !!lembrada &&
    (lembrada.emb_tipo ?? null) === embTipo &&
    (lembrada.emb_unidades ?? null) === embUnid &&
    (lembrada.pallet_lastro ?? null) === lastro &&
    (lembrada.pallet_altura ?? null) === altura;

  const [txt, setTxt] = useState<string | null>(null);
  const mostra = txt ?? String(num(item.qtd_recebida));
  function commit(v: string) {
    setTxt(null);
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) onQtd(n);
  }

  const [txtCx, setTxtCx] = useState<string | null>(null);
  const mostraCx = txtCx ?? caixasFmt;
  function commitCx(v: string) {
    setTxtCx(null);
    if (!podeCaixa) return;
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) onQtd(Math.round(n * (embUnid as number)));
  }

  return (
    <Card className={cn("p-3.5 flex flex-col gap-3", ok && "border-emerald-300 dark:border-emerald-900")}>
      <div className="flex items-center gap-3.5 flex-wrap">
        <Foto url={foto} className="w-[54px] h-[54px]" />
        <div className="flex flex-col gap-0.5 min-w-0 flex-[1_1_260px]">
          <span className="text-[13px] font-semibold leading-snug line-clamp-2">{item.descricao ?? "—"}</span>
          <span className="text-[11px] text-muted-foreground font-mono">
            SKU {item.sku || "—"}{item.gtin ? ` · EAN ${item.gtin}` : ""}
          </span>
        </div>

        {/* ENTRADA UNITÁRIA */}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">Entrada unitária</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 w-9 p-0 text-base font-bold"
              onClick={() => onQtd(num(item.qtd_recebida) - 1)} disabled={num(item.qtd_recebida) <= 0}>−</Button>
            <Input
              value={mostra}
              onChange={(e) => setTxt(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="h-9 w-[74px] text-center font-mono font-bold tabular-nums"
              inputMode="numeric"
            />
            <Button variant="outline" size="sm" className="h-9 w-9 p-0 text-base font-bold"
              onClick={() => onQtd(num(item.qtd_recebida) + 1)}>+</Button>
            <span className="text-[12px] text-muted-foreground font-mono whitespace-nowrap">/ {formatNumber(num(item.quantidade))} un</span>
            <Button
              variant={ok ? "default" : "outline"} size="sm" className="h-9 gap-1.5"
              onClick={() => onQtd(num(item.quantidade))}
              title="Recebeu tudo — marca a quantidade pedida"
            >
              <Check className="h-3.5 w-3.5" /> Tudo
            </Button>
          </div>
        </div>
      </div>

      {/* encaixotamento + entrada por caixa + amarração */}
      <div className="flex items-end gap-x-5 gap-y-2.5 flex-wrap rounded-lg bg-muted/50 px-3 py-2.5">
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Boxes className="h-3 w-3" /> Encaixotamento
          </span>
          <div className="flex items-center gap-2">
            <Select
              value={embTipo ?? undefined}
              onValueChange={(v) => onEmb({ emb_tipo: v })}
            >
              <SelectTrigger className="h-8 w-[130px] text-xs bg-card"><SelectValue placeholder="Tipo…" /></SelectTrigger>
              <SelectContent>
                {EMB_TIPOS.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {embTipo !== "unidade" && (
              <>
                <span className="text-xs text-muted-foreground">com</span>
                <CampoNum valor={embUnid} onCommit={(n) => onEmb({ emb_unidades: n })} largura="w-[64px]" />
                <span className="text-xs text-muted-foreground">un</span>
              </>
            )}
          </div>
        </div>

        {/* ENTRADA POR ENCAIXOTAMENTO: digitou 3 caixas de 8 = 24 un recebidas */}
        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
            Entrada por {rotuloEmb}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 w-8 p-0 text-sm font-bold"
              disabled={!podeCaixa || num(item.qtd_recebida) <= 0}
              onClick={() => onQtd(Math.max(0, num(item.qtd_recebida) - (embUnid as number)))}
              title={`− 1 ${rotuloEmb} (${embUnid ?? "?"} un)`}>−</Button>
            <Input
              value={mostraCx}
              disabled={!podeCaixa}
              placeholder="cx"
              onChange={(e) => setTxtCx(e.target.value)}
              onBlur={(e) => commitCx(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className="h-8 w-[64px] text-center font-mono font-bold tabular-nums bg-card"
              inputMode="numeric"
            />
            <Button variant="outline" size="sm" className="h-8 w-8 p-0 text-sm font-bold"
              disabled={!podeCaixa}
              onClick={() => onQtd(num(item.qtd_recebida) + (embUnid as number))}
              title={`+ 1 ${rotuloEmb} (${embUnid ?? "?"} un)`}>+</Button>
            {podeCaixa ? (
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                × {embUnid} un = <b className="font-mono">{formatNumber(num(item.qtd_recebida))}</b> un
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground italic">defina o tipo e "com N un"</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Layers className="h-3 w-3" /> Amarração do pallet
          </span>
          <div className="flex items-center gap-2">
            <CampoNum valor={lastro} onCommit={(n) => onEmb({ pallet_lastro: n })} largura="w-[58px]" placeholder="lastro" />
            <span className="text-xs text-muted-foreground">×</span>
            <CampoNum valor={altura} onCommit={(n) => onEmb({ pallet_altura: n })} largura="w-[58px]" placeholder="alt." />
            {caixasPorPallet !== null && (
              <span className="text-[11px] font-bold font-mono px-2 py-1 rounded bg-card border whitespace-nowrap">
                {caixasPorPallet} cx/pallet
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-2">pallets:</span>
            <CampoNum valor={item.pallets} onCommit={(n) => onEmb({ pallets: n })} largura="w-[58px]" />
          </div>
        </div>

        {/* modelo do SKU para futuras compras */}
        <div className="flex items-center gap-2 pb-0.5 ml-auto">
          {padraoIgual ? (
            <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1 whitespace-nowrap">
              <Check className="h-3.5 w-3.5" /> modelo do SKU salvo
            </span>
          ) : (
            <Button
              variant="outline" size="sm" className="h-8 text-xs gap-1.5"
              disabled={!item.sku || (!embTipo && !embUnid && !lastro && !altura)}
              onClick={() => onSalvarPadrao({
                emb_tipo: embTipo, emb_unidades: embUnid,
                pallet_lastro: lastro, pallet_altura: altura,
              })}
              title="Grava este encaixotamento como modelo do SKU — as próximas compras vêm pré-preenchidas"
            >
              Salvar modelo p/ futuras compras
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// input de texto com commit no blur/Enter
function CampoTexto({
  valor, onCommit, placeholder, className,
}: {
  valor: string | null;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const mostra = txt ?? (valor ?? "");
  function commit(v: string) {
    setTxt(null);
    const limpo = v.trim();
    if (limpo === (valor ?? "")) return;
    onCommit(limpo === "" ? null : limpo);
  }
  return (
    <Input
      value={mostra}
      placeholder={placeholder}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={cn("h-8 text-xs bg-card", className)}
    />
  );
}

// input numérico pequeno com commit no blur/Enter
function CampoNum({
  valor, onCommit, largura, placeholder,
}: {
  valor: number | null | undefined;
  onCommit: (n: number | null) => void;
  largura?: string;
  placeholder?: string;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const mostra = txt ?? (valor != null ? String(valor) : "");
  function commit(v: string) {
    setTxt(null);
    const limpo = v.trim();
    if (limpo === "") { onCommit(null); return; }
    const n = Number(limpo.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) onCommit(n);
  }
  return (
    <Input
      value={mostra}
      placeholder={placeholder}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={cn("h-8 text-center font-mono text-xs bg-card", largura)}
      inputMode="numeric"
    />
  );
}

export const Route = createFileRoute("/compras")({
  component: ComprasPage,
});
