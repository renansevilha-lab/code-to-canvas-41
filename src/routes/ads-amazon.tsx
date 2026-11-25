// ADS da Amazon (24/nov/2026, pedido do dono). Mesmo padrão da /ads-ml.
// Dados: amazon_ads_campanha_diario (sincronizado 1×/dia pela edge fn amazon-ads-sync, últimos 8 dias
// relidos porque a Amazon reatribui vendas). Somas no banco: RPC amazon_ads_painel (até 46 campanhas × 95 dias
// passaria do corte de 1.000 linhas do PostgREST). Só a conta ACZ está conectada.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone, RefreshCw, Loader2, ChevronRight, ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import { CriarCampanhaAmz, EditarCampanhaAmz } from "@/components/ads/AmazonAdsGestao";
import { resolveRange, type PeriodPreset, type PeriodRange } from "@/lib/dashboard/period";

interface Campanha {
  campaign_id: string; ad_product: string; nome: string | null; status: string | null;
  orcamento: number | null; tipo_orcamento: string | null; segmentacao: string | null; estrategia: string | null;
  gasto: number; vendas: number; pedidos: number; unidades: number; cliques: number; impressoes: number; dias_com_gasto: number;
  roas: number | null; acos: number | null; cpc: number | null; ctr: number | null; conversao: number | null;
}
interface Painel {
  de: string; ate: string; atualizado_em: string | null; ultimo_dia: string | null;
  total: { gasto: number; vendas: number; pedidos: number; unidades: number; cliques: number; impressoes: number; receita_loja: number; pedidos_loja: number };
  dias: { data: string; gasto: number; vendas: number }[];
  campanhas: Campanha[];
  sem_gasto: { campaign_id: string; nome: string | null; status: string | null; orcamento: number | null }[];
}

const num = (v: number | null | undefined) => (v ?? 0).toLocaleString("pt-BR");
const VALID_PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];
type Dir = "asc" | "desc";
type SearchParams = { period: PeriodPreset; from?: string; to?: string; campanha?: string; ord?: string; dir?: Dir };

const VALOR: Record<string, (r: Campanha) => number | string | null> = {
  nome: (r) => r.nome ?? r.campaign_id, status: (r) => r.status, gasto: (r) => r.gasto, vendas: (r) => r.vendas,
  roas: (r) => r.roas, acos: (r) => r.acos, pedidos: (r) => r.pedidos, cpc: (r) => r.cpc, ctr: (r) => r.ctr,
  conversao: (r) => r.conversao, cliques: (r) => r.cliques, impressoes: (r) => r.impressoes, orcamento: (r) => r.orcamento,
};
const COLUNAS_TEXTO = new Set(["nome", "status"]);
const proximaOrdem = (ord: string, dir: Dir, chave: string): { ord: string; dir: Dir } =>
  ord === chave ? { ord, dir: dir === "desc" ? "asc" : "desc" } : { ord: chave, dir: COLUNAS_TEXTO.has(chave) ? "asc" : "desc" };

/** Ordena pela coluna; vazio vai sempre para o fim, nos dois sentidos. */
function ordenar<T>(lista: T[], valor: (x: T) => number | string | null | undefined, dir: Dir): T[] {
  return [...lista].sort((a, b) => {
    const va = valor(a), vb = valor(b);
    const na = va == null || va === "", nb = vb == null || vb === "";
    if (na || nb) return na === nb ? 0 : na ? 1 : -1;
    const c = typeof va === "string" || typeof vb === "string"
      ? String(va).localeCompare(String(vb), "pt-BR", { sensitivity: "base" })
      : Number(va) - Number(vb);
    return dir === "asc" ? c : -c;
  });
}

function ThOrdena({ rotulo, chave, ord, dir, onOrdenar, alinhar = "right", className }: {
  rotulo: string; chave: string; ord: string; dir: Dir; onOrdenar: (chave: string) => void; alinhar?: "left" | "center" | "right"; className?: string;
}) {
  const ativo = ord === chave;
  const Icone = !ativo ? ArrowUpDown : dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <th className={cn("font-medium select-none", alinhar === "left" ? "text-left" : alinhar === "center" ? "text-center" : "text-right", className)}
      aria-sort={ativo ? (dir === "desc" ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => onOrdenar(chave)}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", ativo && "text-foreground", alinhar === "right" && "flex-row-reverse")}
        title={ativo ? (dir === "desc" ? "Do maior para o menor — clique para inverter" : "Do menor para o maior — clique para inverter") : "Ordenar por esta coluna"}>
        {rotulo}<Icone className={cn("h-3 w-3 shrink-0", !ativo && "opacity-40")} />
      </button>
    </th>
  );
}

const rotuloStatus = (s: string | null) => {
  const v = (s ?? "").toUpperCase();
  return v === "ENABLED" ? "ativa" : v === "PAUSED" ? "pausada" : v === "ARCHIVED" ? "arquivada" : (s ?? "—").toLowerCase();
};
const rotuloSegmentacao = (s: string | null) => (s === "AUTO" ? "automática" : s === "MANUAL" ? "manual" : s ?? "");
const rotuloEstrategia = (s: string | null) =>
  s === "AUTO_FOR_SALES" ? "lance dinâmico: sobe e desce" : s === "LEGACY_FOR_SALES" ? "lance dinâmico: só desce"
  : s === "MANUAL" ? "lance fixo" : s === "RULE_BASED" ? "lance por regra" : s ?? "";
const dataBR = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export const Route = createFileRoute("/ads-amazon")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset) ? (s.period as PeriodPreset) : "last30",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
    campanha: typeof s.campanha === "string" && s.campanha ? s.campanha : undefined,
    ord: typeof s.ord === "string" && s.ord in VALOR ? s.ord : undefined,
    dir: s.dir === "asc" || s.dir === "desc" ? s.dir : undefined,
  }),
  component: AdsAmazonPage,
});

function AdsAmazonPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.period, search.from, search.to);
  const setRange = (r: PeriodRange) => navigate({ search: { ...search, period: r.preset, from: r.from, to: r.to }, replace: true });
  const ord = search.ord ?? "gasto";
  const dir: Dir = search.dir ?? (COLUNAS_TEXTO.has(ord) ? "asc" : "desc");
  const ordenarPor = (chave: string) => navigate({ search: { ...search, ...proximaOrdem(ord, dir, chave) }, replace: true, resetScroll: false });
  const abrir = (id: string) => navigate({ search: { ...search, campanha: search.campanha === id ? undefined : id }, replace: true, resetScroll: false });

  const q = useQuery({
    queryKey: ["ads-amazon", "painel", range.from, range.to],
    queryFn: async (): Promise<Painel> => {
      const { data, error } = await supabaseExternal.rpc("amazon_ads_painel", { p_de: range.from, p_ate: range.to });
      if (error) throw new Error(error.message);
      return data as unknown as Painel;
    },
  });
  const p = q.data;
  const rows = useMemo(() => ordenar(p?.campanhas ?? [], VALOR[ord] ?? VALOR.gasto, dir), [p, ord, dir]);
  const t = p?.total;
  const roas = t && t.gasto > 0 ? t.vendas / t.gasto : 0;
  const acos = t && t.vendas > 0 ? (t.gasto / t.vendas) * 100 : 0;
  const tacos = t && t.receita_loja > 0 ? (t.gasto / t.receita_loja) * 100 : null;
  const serie = useMemo(() => (p?.dias ?? []).map((d) => ({ ...d, rotulo: dataBR(d.data), roas: d.gasto > 0 ? Number((d.vendas / d.gasto).toFixed(2)) : null })), [p]);

  function corRoas(r: Campanha) {
    if (r.gasto <= 0) return "text-muted-foreground";
    if ((r.roas ?? 0) < 1) return "text-red-600 dark:text-red-400";
    if ((r.roas ?? 0) < 3) return "text-amber-600 dark:text-amber-400";
    return "text-emerald-600 dark:text-emerald-400";
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Megaphone className="h-6 w-6" /> ADS Amazon
          </h1>
          <div className="flex items-center gap-2">
            <DashboardPeriodFilter value={range} onChange={setRange} />
            <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => q.refetch()} disabled={q.isFetching}>
              {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Atualizar
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Produtos Patrocinados · conta ACZ Pet · janela {range.from} → {range.to}
          {p?.ultimo_dia && <> · dados até {dataBR(p.ultimo_dia)}</>}
        </p>
      </header>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <KpiCard titulo="Investimento" valor={formatBRL(t?.gasto ?? 0)} carregando={q.isLoading} />
        <KpiCard titulo="Vendas pelo ADS" valor={formatBRL(t?.vendas ?? 0)} sub={t ? `${num(t.pedidos)} pedidos` : undefined} carregando={q.isLoading} />
        <KpiCard titulo="ROAS" valor={roas.toFixed(2)} sub={`ACOS ${acos.toFixed(1)}%`} carregando={q.isLoading} />
        <KpiCard titulo="TACOS" valor={tacos != null ? `${tacos.toFixed(1)}%` : "—"}
          sub={t ? `ADS ÷ venda total ${formatBRL(t.receita_loja)}` : undefined} carregando={q.isLoading} />
        <KpiCard titulo="Pedidos pelo ADS" valor={t && t.pedidos_loja > 0 ? `${Math.round((t.pedidos / t.pedidos_loja) * 100)}%` : "—"}
          sub={t ? `${num(t.pedidos)} de ${num(t.pedidos_loja)} pedidos da loja` : undefined} carregando={q.isLoading} />
      </div>

      {q.error && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {(q.error as Error).message}
        </Card>
      )}

      {serie.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">Por dia</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={serie} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="r" tick={{ fontSize: 10 }} width={56} tickFormatter={(v) => `R$${Math.round(v)}`} />
                <YAxis yAxisId="x" orientation="right" tick={{ fontSize: 10 }} width={36} tickFormatter={(v) => `${v}x`} />
                <Tooltip formatter={(v, n) => (n === "ROAS" ? `${Number(v).toFixed(2)}x` : formatBRL(Number(v)))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="r" dataKey="gasto" name="Investimento" fill="#7C5CD6" radius={[3, 3, 0, 0]} />
                <Line yAxisId="r" dataKey="vendas" name="Vendas pelo ADS" stroke="#0E8A5F" dot={false} strokeWidth={1.5} />
                <Line yAxisId="x" dataKey="roas" name="ROAS" stroke="#D97706" dot={{ r: 2 }} strokeWidth={2} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4 border-b">
          <h3 className="text-sm font-semibold">Campanhas com gasto {p && <span className="text-muted-foreground font-normal">({rows.length})</span>}</h3>
          <CriarCampanhaAmz onFeito={() => q.refetch()} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                {([
                  ["Campanha", "nome", "left"], ["Status", "status", "center"], ["Investimento", "gasto"], ["Vendas", "vendas"],
                  ["ROAS", "roas"], ["ACOS", "acos"], ["Pedidos", "pedidos"], ["CPC", "cpc"], ["CTR", "ctr"], ["Conversão", "conversao"],
                  ["Cliques", "cliques"], ["Impr.", "impressoes"], ["Orçamento/dia", "orcamento"],
                ] as [string, string, ("left" | "center")?][]).map(([rotulo, chave, alinhar]) => (
                  <ThOrdena key={chave} rotulo={rotulo} chave={chave} alinhar={alinhar} ord={ord} dir={dir} onOrdenar={ordenarPor} className="px-3 py-2" />
                ))}
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-t"><td colSpan={13} className="px-3 py-3"><Skeleton className="h-5 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={13} className="px-3 py-12 text-center text-sm text-muted-foreground">Nenhuma campanha com gasto nesta janela.</td></tr>
              ) : (
                rows.map((r) => (
                  <Fragment key={r.campaign_id}>
                    <tr className={cn("border-t hover:bg-accent/40 cursor-pointer", search.campanha === r.campaign_id && "bg-accent/40")} onClick={() => abrir(r.campaign_id)}>
                      <td className="px-3 py-2 max-w-[300px]">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", search.campanha === r.campaign_id && "rotate-90")} />
                          <span className="min-w-0">
                            <span className="truncate block font-medium">{r.nome ?? `#${r.campaign_id}`}</span>
                            <span className="block text-[10px] text-muted-foreground truncate">
                              {[rotuloSegmentacao(r.segmentacao), rotuloEstrategia(r.estrategia)].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant="outline" className={cn("text-[10px] h-5 px-1.5", (r.status ?? "").toUpperCase() === "ENABLED" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                          {rotuloStatus(r.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{formatBRL(r.gasto)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.vendas)}</td>
                      <td className={cn("px-3 py-2 text-right tabular-nums font-semibold", corRoas(r))}>{r.roas != null ? r.roas.toFixed(2) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.acos != null ? `${r.acos.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(r.pedidos)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.cpc != null ? formatBRL(r.cpc) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.ctr != null ? `${r.ctr.toFixed(2)}%` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.conversao != null ? `${r.conversao.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(r.cliques)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(r.impressoes)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.orcamento != null ? formatBRL(r.orcamento) : "—"}</td>
                    </tr>
                    {search.campanha === r.campaign_id && (
                      <tr className="border-t bg-muted/20">
                        <td colSpan={13} className="px-3 py-3">
                          <div className="mb-2"><EditarCampanhaAmz campanha={r} onFeito={() => q.refetch()} /></div>
                          <DiasDaCampanha campanha={r} de={range.from} ate={range.to} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {p && p.sem_gasto.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold">Ativas e sem gasto no período <span className="text-muted-foreground font-normal">({p.sem_gasto.length})</span></h3>
          <p className="text-xs text-muted-foreground mt-0.5">Ligadas na Amazon, mas não gastaram nada: lance baixo, sem produto com estoque ou segmentação que não aparece.</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {p.sem_gasto.map((c) => (
              <Badge key={c.campaign_id} variant="outline" className="font-normal">
                {c.nome ?? c.campaign_id}{c.orcamento != null && <span className="text-muted-foreground ml-1">· {formatBRL(c.orcamento)}/dia</span>}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Vendas pelo ADS = atribuídas pela Amazon em até 7 dias depois do clique. ROAS <span className="text-red-600 dark:text-red-400">vermelho</span> = abaixo de 1;
        <span className="text-amber-600 dark:text-amber-400"> âmbar</span> = abaixo de 3; <span className="text-emerald-600 dark:text-emerald-400">verde</span> = 3 ou mais
        (a Amazon não informa a meta de ROAS pela API de campanhas). TACOS = investimento ÷ toda a venda da conta na Amazon no período (Pedidos Integrados).
        Os dados chegam 1×/dia às 05h20, relendo os últimos 8 dias porque a Amazon reatribui vendas; o dia de hoje ainda não aparece.
        Este mesmo gasto já entra no DRE, no Dashboard e na meta de ACOS do mês. Clique numa campanha para ver os números dela dia a dia.
      </p>
    </div>
  );
}

function DiasDaCampanha({ campanha, de, ate }: { campanha: Campanha; de: string; ate: string }) {
  const q = useQuery({
    queryKey: ["ads-amazon", "dias", campanha.campaign_id, de, ate],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("amazon_ads_campanha_diario")
        .select("data, gasto, vendas, pedidos, unidades, cliques, impressoes, orcamento")
        .eq("campaign_id", campanha.campaign_id).eq("shop_id", 900001).gte("data", de).lte("data", ate)
        .order("data", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as { data: string; gasto: number; vendas: number; pedidos: number; unidades: number; cliques: number; impressoes: number; orcamento: number | null }[];
    },
  });
  if (q.error) return <div className="text-sm text-red-600 dark:text-red-300">Erro: {(q.error as Error).message}</div>;
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  const lista = q.data ?? [];
  if (!lista.length) return <div className="text-sm text-muted-foreground py-4 text-center">Sem movimento no período.</div>;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">
        {campanha.dias_com_gasto} dia(s) com gasto · ID {campanha.campaign_id}
      </div>
      <div className="overflow-x-auto rounded-md border bg-background max-h-80">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground sticky top-0">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Dia</th>
              <th className="px-2 py-1.5 text-right font-medium">Investimento</th>
              <th className="px-2 py-1.5 text-right font-medium">Vendas</th>
              <th className="px-2 py-1.5 text-right font-medium">ROAS</th>
              <th className="px-2 py-1.5 text-right font-medium">Pedidos</th>
              <th className="px-2 py-1.5 text-right font-medium">Unid.</th>
              <th className="px-2 py-1.5 text-right font-medium">Cliques</th>
              <th className="px-2 py-1.5 text-right font-medium">Impr.</th>
              <th className="px-2 py-1.5 text-right font-medium">Orçamento</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((d) => {
              const r = d.gasto > 0 ? d.vendas / d.gasto : null;
              return (
                <tr key={d.data} className="border-t">
                  <td className="px-2 py-1.5">{dataBR(d.data)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatBRL(d.gasto)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatBRL(d.vendas)}</td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums font-semibold",
                    r == null ? "text-muted-foreground" : r < 1 ? "text-red-600 dark:text-red-400" : r < 3 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
                    {r != null ? r.toFixed(2) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(d.pedidos)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(d.unidades)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{num(d.cliques)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{num(d.impressoes)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{d.orcamento != null ? formatBRL(d.orcamento) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KpiCard({ titulo, valor, sub, icone, carregando }: { titulo: string; valor: string; sub?: string; icone?: ReactNode; carregando?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{titulo}{icone}</div>
      {carregando ? <Skeleton className="h-8 w-24 mt-1" /> : <div className="text-2xl font-semibold tabular-nums mt-1">{valor}</div>}
      {sub && !carregando && <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
    </Card>
  );
}
