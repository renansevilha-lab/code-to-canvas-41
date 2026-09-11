import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Printer, RefreshCw, Search } from "lucide-react";
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
import { registrarSeparacaoLog } from "@/lib/separacaoLog";

// ============================================================================
// Risco de cancelamento automático (Shopee) — TODOS os pedidos em risco,
// inclusive os que já saíram da fila de separação (embalados/concluídos
// aguardando coleta). A fila (/separacao) só mostra situação 1; aqui a fonte
// é view_pedidos_risco_cancelamento (pedido arranjado e ainda não coletado;
// cancela_em = ship_by + 3 dias, regra observada no Seller Center).
// Reimpressão é SEMPRE forçada (pedido a pedido, sem dedup) — por isso pede
// confirmação: etiqueta em dobro no mesmo pacote gera extravio/devolução.
// ============================================================================

interface RiscoRow {
  order_sn: string;
  loja: string;
  shop_id: number;
  status_pedido: string;
  dia_pedido: string;
  vence_em: string;
  cancela_em: string;
  dias_para_cancelar: number;
  sit_separacao: number | null;
  situacao_fisica: string;
  tag_lote: string | null;
  sit_tiny: string | null;
  rastreio: string | null;
  valor: number | null;
  itens: string | null;
}

interface Impressora {
  printer_id: number;
  nome: string;
  computador: string;
  estado: string;
}

// mesma chave da Separação: a impressora escolhida lá vale aqui
const STORAGE_PRINTER = "separacao.printerId";

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const lojaParam = (shopId: number): "ottz" | "svl" => (shopId === 522186766 ? "ottz" : "svl");

function useImpressoras() {
  return useQuery({
    queryKey: ["separacao", "impressoras"],
    queryFn: async () => {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras`, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const data = (await resp.json().catch(() => ({}))) as { impressoras?: Impressora[] };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (data.impressoras ?? []).filter((p) => (p.nome ?? "").toLowerCase().includes("zd220"));
    },
    refetchInterval: 60_000,
  });
}

/** Etiqueta Shopee de UM pedido (sem dedup no servidor = reimprime sempre). */
async function reimprimirShopee(loja: "ottz" | "svl", orderSn: string, printerId: number): Promise<boolean> {
  const url = `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
    `?modulo=imprimir&loja=${loja}&order_sn=${encodeURIComponent(orderSn)}&printer_id=${printerId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } });
  const data = (await resp.json().catch(() => ({}))) as {
    erro?: string; etiquetas_prontas?: number; pedidos_no_lote?: number; aviso?: string | null;
  };
  if (!resp.ok || data.erro) {
    toast.error(`Falha ao imprimir ${orderSn}`, { description: data.erro ?? `HTTP ${resp.status}` });
    return false;
  }
  if ((data.etiquetas_prontas ?? 0) < (data.pedidos_no_lote ?? 1)) {
    toast.warning(`${orderSn}: etiqueta não está pronta na Shopee`, {
      description: data.aviso ?? "Pedido sem envio arranjado — nada para imprimir.", duration: 10000,
    });
    return false;
  }
  return true;
}

function RiscoCancelamentoPage() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const { data: impressoras } = useImpressoras();
  const [printerId, setPrinterId] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem(STORAGE_PRINTER));
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined" && printerId > 0) window.localStorage.setItem(STORAGE_PRINTER, String(printerId));
  }, [printerId]);
  const impressora = impressoras?.find((p) => p.printer_id === printerId);

  const [empresa, setEmpresa] = useState<"todas" | "Ottz Pet" | "Bumi Pet">("todas");
  const [quando, setQuando] = useState<"hoje" | "amanha" | "todos">("hoje");
  const [situacao, setSituacao] = useState<"todas" | "embalado" | "fila" | "fora">("todas");
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [imprimindo, setImprimindo] = useState<string | null>(null);
  const [massa, setMassa] = useState<{ atual: number; total: number } | null>(null);
  const cancelarRef = useRef(false);

  const q = useQuery({
    queryKey: ["risco-cancelamento", "lista"],
    refetchInterval: 120_000,
    queryFn: async (): Promise<RiscoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_pedidos_risco_cancelamento").select("*")
        .order("cancela_em", { ascending: true }).order("loja").order("situacao_fisica").order("order_sn")
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as RiscoRow[];
    },
  });

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return (q.data ?? []).filter((r) => {
      if (empresa !== "todas" && r.loja !== empresa) return false;
      if (quando === "hoje" && Number(r.dias_para_cancelar) > 0) return false;
      if (quando === "amanha" && Number(r.dias_para_cancelar) !== 1) return false;
      if (situacao === "embalado" && !r.situacao_fisica.startsWith("embalado")) return false;
      if (situacao === "fila" && !["na fila", "em separação"].includes(r.situacao_fisica)) return false;
      if (situacao === "fora" && r.situacao_fisica !== "fora da separação") return false;
      if (t && !(
        r.order_sn.toLowerCase().includes(t) || (r.rastreio ?? "").toLowerCase().includes(t) ||
        (r.tag_lote ?? "").toLowerCase().includes(t) || (r.itens ?? "").toLowerCase().includes(t)
      )) return false;
      return true;
    });
  }, [q.data, empresa, quando, situacao, busca]);

  const resumo = useMemo(() => {
    const todos = q.data ?? [];
    const hoje = todos.filter((r) => Number(r.dias_para_cancelar) <= 0);
    const amanha = todos.filter((r) => Number(r.dias_para_cancelar) === 1);
    const soma = (xs: RiscoRow[]) => xs.reduce((a, b) => a + Number(b.valor ?? 0), 0);
    return {
      hoje: hoje.length, hojeValor: soma(hoje), hojeEmbalados: hoje.filter((r) => r.situacao_fisica.startsWith("embalado")).length,
      amanha: amanha.length, amanhaValor: soma(amanha),
      filtrados: linhas.length, filtradosValor: soma(linhas),
    };
  }, [q.data, linhas]);

  const AVISO = (n: number) =>
    `ATENÇÃO — reimprimir ${n} etiqueta(s)\n\n` +
    `Estes pedidos já tiveram etiqueta impressa (constam como embalados/concluídos). ` +
    `Se a etiqueta anterior ainda estiver no pacote, ele fica com DUAS — risco de extravio/devolução.\n\n` +
    `Use só se as etiquetas anteriores foram perdidas, rasgadas ou saíram na impressora errada.\n\n` +
    `Impressora: ${impressora?.nome ?? "(nenhuma selecionada)"}. Confirmar?`;

  async function reimprimirUm(r: RiscoRow) {
    if (!printerId) { toast.warning("Escolha a impressora primeiro."); return; }
    if (imprimindo || massa) return;
    if (!window.confirm(AVISO(1))) return;
    setImprimindo(r.order_sn);
    try {
      const ok = await reimprimirShopee(lojaParam(r.shop_id), r.order_sn, printerId);
      if (ok) {
        toast.success(`Etiqueta ${r.order_sn} enviada`, { description: impressora?.nome ?? "" });
        void registrarSeparacaoLog({
          evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
          order_sn: r.order_sn, tag: r.tag_lote, detalhe: { via: "risco", forcar: true, loja: lojaParam(r.shop_id) },
        });
      }
    } finally {
      setImprimindo(null);
    }
  }

  async function reimprimirSelecionados() {
    if (!printerId) { toast.warning("Escolha a impressora primeiro."); return; }
    if (massa) return;
    const alvo = linhas.filter((r) => sel.has(r.order_sn));
    if (alvo.length === 0) return;
    if (impressora?.estado === "offline") { toast.error("Impressora offline"); return; }
    if (!window.confirm(AVISO(alvo.length))) return;
    cancelarRef.current = false;
    let ok = 0;
    try {
      for (let i = 0; i < alvo.length; i++) {
        if (cancelarRef.current) break;
        setMassa({ atual: i + 1, total: alvo.length });
        const r = alvo[i];
        if (await reimprimirShopee(lojaParam(r.shop_id), r.order_sn, printerId)) {
          ok++;
          void registrarSeparacaoLog({
            evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
            order_sn: r.order_sn, tag: r.tag_lote, detalhe: { via: "risco-massa", forcar: true, loja: lojaParam(r.shop_id) },
          });
        }
      }
    } finally {
      setMassa(null);
    }
    toast.success(`${ok} de ${alvo.length} etiqueta(s) reimpressa(s)`, { description: impressora?.nome ?? "" });
    setSel(new Set());
  }

  const todasSel = linhas.length > 0 && linhas.every((r) => sel.has(r.order_sn));

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Risco de cancelamento — Shopee</h1>
          <p className="text-[12.5px] text-muted-foreground max-w-3xl">
            Pedidos com envio arranjado e ainda <b>não coletados</b> — inclusive os que já saíram da fila de
            separação (embalados/concluídos). A Shopee cancela automaticamente ~3 dias após o prazo de envio;
            a data é estimada (a API não a expõe). Reimpressão aqui é sempre forçada, pedido a pedido.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={printerId ? String(printerId) : ""} onValueChange={(v) => setPrinterId(Number(v))}>
            <SelectTrigger className={cn("h-9 w-[260px] text-sm bg-card", impressora?.estado === "offline" && "border-destructive text-destructive")}>
              <Printer className="h-3.5 w-3.5 mr-1 shrink-0" />
              <SelectValue placeholder="Impressora (Zebra)" />
            </SelectTrigger>
            <SelectContent>
              {(impressoras ?? []).map((p) => (
                <SelectItem key={p.printer_id} value={String(p.printer_id)}>
                  {p.nome} · {p.computador} {p.estado === "offline" ? "· OFFLINE" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-9 gap-1.5" disabled={q.isFetching}
            onClick={() => void qc.invalidateQueries({ queryKey: ["risco-cancelamento"] })}>
            {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Atualizar
          </Button>
        </div>
      </div>

      {/* resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 border-red-300 bg-red-50 dark:bg-red-950/30">
          <div className="text-[11px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300">Cancela HOJE</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.hoje)}</div>
          <div className="text-[11px] text-muted-foreground">{formatNumber(resumo.hojeEmbalados)} embalados aguardando coleta · {formatBRL(resumo.hojeValor)}</div>
        </Card>
        <Card className="p-3 border-orange-300 bg-orange-50 dark:bg-orange-950/30">
          <div className="text-[11px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">Cancela amanhã</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.amanha)}</div>
          <div className="text-[11px] text-muted-foreground">{formatBRL(resumo.amanhaValor)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">No filtro atual</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.filtrados)}</div>
          <div className="text-[11px] text-muted-foreground">{formatBRL(resumo.filtradosValor)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Selecionados</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(sel.size)}</div>
          <div className="text-[11px] text-muted-foreground">marque na tabela para reimprimir em massa</div>
        </Card>
      </div>

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["todas", "Todas"], ["Ottz Pet", "Ottz"], ["Bumi Pet", "Bumi"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setEmpresa(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                empresa === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["hoje", "Cancela hoje"], ["amanha", "Cancela amanhã"], ["todos", "Hoje + amanhã"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setQuando(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                quando === id ? (id === "hoje" ? "bg-red-600 text-white" : "bg-accent text-accent-foreground") : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["todas", "Todas situações"], ["embalado", "Embalados (aguardam coleta)"], ["fila", "Na fila"], ["fora", "Fora da separação"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setSituacao(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                situacao === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-auto sm:min-w-[260px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input className="h-9 pl-8 text-sm bg-card" placeholder="Pedido, rastreio, TAG ou SKU"
            value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </div>

      {/* tabela */}
      <Card className="overflow-x-auto">
        {q.isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</div>
        ) : linhas.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhum pedido com esses filtros. 🎉</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-2 w-8">
                  <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer" checked={todasSel}
                    onChange={(e) => setSel(e.target.checked ? new Set(linhas.map((r) => r.order_sn)) : new Set())}
                    title="Selecionar todos do filtro" />
                </th>
                <th className="p-2 text-left">Pedido</th>
                <th className="p-2 text-left">Loja</th>
                <th className="p-2 text-left">Situação física</th>
                <th className="p-2 text-left">TAG</th>
                <th className="p-2 text-left">Rastreio</th>
                <th className="p-2 text-left">Itens</th>
                <th className="p-2 text-right">Valor</th>
                <th className="p-2 text-left">Prazo</th>
                <th className="p-2 text-left">Cancela</th>
                <th className="p-2 text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((r) => {
                const hoje = Number(r.dias_para_cancelar) <= 0;
                const semEnvio = r.status_pedido === "READY_TO_SHIP";
                return (
                  <tr key={r.order_sn} className={cn("border-t border-border/60", sel.has(r.order_sn) && "bg-accent/40")}>
                    <td className="p-2">
                      <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer" checked={sel.has(r.order_sn)}
                        onChange={(e) => setSel((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r.order_sn); else n.delete(r.order_sn); return n; })} />
                    </td>
                    <td className="p-2 font-mono font-semibold">{r.order_sn}</td>
                    <td className="p-2">{r.loja}</td>
                    <td className="p-2">
                      <span className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold",
                        r.situacao_fisica.startsWith("embalado") ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : r.situacao_fisica === "fora da separação" ? "bg-muted text-muted-foreground"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300")}>
                        {r.situacao_fisica}
                      </span>
                      {semEnvio && (
                        <span className="ml-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                          title="Pedido sem envio arranjado na Shopee — não há etiqueta; precisa faturar/arranjar">
                          sem envio arranjado
                        </span>
                      )}
                    </td>
                    <td className="p-2 font-mono">{r.tag_lote ?? "—"}</td>
                    <td className="p-2 font-mono text-[11.5px]">{r.rastreio ?? "—"}</td>
                    <td className="p-2 text-muted-foreground max-w-[220px] truncate" title={r.itens ?? ""}>{r.itens ?? "—"}</td>
                    <td className="p-2 text-right tabular-nums">{formatBRL(Number(r.valor ?? 0))}</td>
                    <td className="p-2 tabular-nums">{ddmm(r.vence_em)}</td>
                    <td className="p-2">
                      <span className={cn("font-bold tabular-nums", hoje ? "text-destructive" : "text-orange-700 dark:text-orange-400")}>
                        {hoje ? `HOJE ${ddmm(r.cancela_em)}` : `amanhã ${ddmm(r.cancela_em)}`}
                      </span>
                    </td>
                    <td className="p-2 text-right">
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                        disabled={imprimindo !== null || massa !== null || semEnvio}
                        title={semEnvio ? "Sem envio arranjado — não há etiqueta" : "Reimprime a etiqueta deste pedido (forçado)"}
                        onClick={() => void reimprimirUm(r)}>
                        {imprimindo === r.order_sn ? <Loader2 className="h-3 w-3 animate-spin" /> : <Printer className="h-3 w-3" />}
                        Reimprimir
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {/* barra de seleção / progresso */}
      {(sel.size > 0 || massa) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-card border shadow-lg">
          {massa ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-sm font-medium tabular-nums">Reimprimindo {massa.atual}/{massa.total}</span>
              <Button size="sm" variant="destructive" onClick={() => { cancelarRef.current = true; }}>Parar após este</Button>
            </>
          ) : (
            <>
              <span className="text-sm font-medium">{sel.size} pedido(s) selecionado(s)</span>
              <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => void reimprimirSelecionados()}>
                <AlertTriangle className="h-4 w-4" /> Reimprimir selecionados (forçar)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Limpar</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/risco-cancelamento")({
  component: RiscoCancelamentoPage,
});
