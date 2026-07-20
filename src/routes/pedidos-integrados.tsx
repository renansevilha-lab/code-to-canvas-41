import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Search,
  Package as PackageIcon,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO, subDays } from "date-fns";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { rangeToSPIso } from "@/lib/date";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import {
  resolveRange,
  type PeriodPreset,
  type PeriodRange,
} from "@/lib/dashboard/period";


// ─────────────────────────────────────────────────────────────────────────────
// Tipos

type Cobertura = "completo" | "parcial" | "sem_dado";

interface PedidoIntegrado {
  order_sn: string;
  marketplace: string;
  
  shop_id: number | null;
  empresa: string | null;
  canal: string | null;
  data_pedido: string | null;
  data_pagamento_shopee: string | null;
  status_pedido: string | null;
  uf: string | null;
  cidade: string | null;
  venda_bruta: number | null;
  venda: number | null;
  taxa_comissao: number | null;
  taxa_servico: number | null;
  ajuste_acao_comercial: number | null;
  comissao_afiliados: number | null;
  comissao_total: number | null;
  custo_prod: number | null;
  imposto: number | null;
  custo_total: number | null;
  recebido_estimado: number | null;
  margem: number | null;
  mc_pct: number | null;
  qtd_itens: number | null;
  itens_sem_cmv: number | null;
  cobertura_cmv: Cobertura | null;
  skus: string | null;
  primeiro_produto_nome: string | null;
  primeiro_produto_foto: string | null;
  primeira_marca: string | null;
  primeira_categoria: string | null;
}

interface KpiDiaRow {
  dia: string | null;
  canal: string | null;
  empresa: string | null;
  marketplace: string | null;
  pedidos: number | null;
  venda: number | null;
  comissao_total: number | null;
  custo_prod: number | null;
  imposto: number | null;
  custo_total: number | null;
  recebido_estimado: number | null;
  margem: number | null;
  itens: number | null;
  itens_sem_cmv: number | null;
}

// Colunas retornadas na listagem — apenas o que a tabela + drawer usam.
const LIST_COLUMNS =
  "order_sn,marketplace,empresa,canal,data_pedido,status_pedido,uf,cidade,venda,custo_prod,comissao_total,taxa_comissao,taxa_servico,ajuste_acao_comercial,comissao_afiliados,recebido_estimado,imposto,margem,mc_pct,qtd_itens,cobertura_cmv,skus,itens_sem_cmv,primeiro_produto_nome,primeiro_produto_foto";



// ─────────────────────────────────────────────────────────────────────────────
// Route

const VALID_PRESETS: PeriodPreset[] = ["today", "last7", "last30", "mtd", "prev_month", "last90", "custom"];

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
  page: number;
  empresas: string[];
  canais: string[];
  statuses: string[];
  cobertura: CoberturaFilter;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
};

function stringArraySearch(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function intSearch(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

export const Route = createFileRoute("/pedidos-integrados")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset)
      ? (s.period as PeriodPreset)
      : "last30",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
    page: intSearch(s.page ?? s.pagina, 1),
    empresas: stringArraySearch(s.empresas),
    canais: stringArraySearch(s.canais),
    statuses: stringArraySearch(s.statuses).length ? stringArraySearch(s.statuses) : [...DEFAULT_STATUSES],
    cobertura: ["todos", "completo", "incompletos"].includes(s.cobertura as string)
      ? (s.cobertura as CoberturaFilter)
      : "todos",
    q: typeof s.q === "string" ? s.q : "",
    sort: ["data_pedido", "venda", "custo_prod", "comissao_total", "imposto", "margem", "mc_pct"].includes(s.sort as string)
      ? (s.sort as SortKey)
      : "data_pedido",
    dir: s.dir === "asc" ? "asc" : "desc",
  }),
  component: PedidosIntegradosPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Constantes

const STATUS_OPTIONS: { value: string; label: string; marketplace: "shopee" | "mercadolivre" }[] = [
  { value: "PROCESSED", label: "Processando (Shopee)", marketplace: "shopee" },
  { value: "READY_TO_SHIP", label: "Pronto para envio (Shopee)", marketplace: "shopee" },
  { value: "SHIPPED", label: "Enviado (Shopee)", marketplace: "shopee" },
  { value: "TO_CONFIRM_RECEIVE", label: "Aguardando confirmação (Shopee)", marketplace: "shopee" },
  { value: "COMPLETED", label: "Concluído (Shopee)", marketplace: "shopee" },
  { value: "PAID", label: "Pago (ML)", marketplace: "mercadolivre" },
  { value: "PARTIALLY_REFUNDED", label: "Devolução parcial (ML)", marketplace: "mercadolivre" },
];

const DEFAULT_STATUSES = STATUS_OPTIONS.map((s) => s.value);

const STATUS_COLORS: Record<string, string> = {
  PROCESSED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  SHIPPED: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  READY_TO_SHIP: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
  TO_CONFIRM_RECEIVE: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  COMPLETED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  PAID: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  PARTIALLY_REFUNDED: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  UNPAID: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  CANCELLED: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  STATUS_OPTIONS.map((s) => [s.value, s.label]),
);

const EMPRESAS_FALLBACK: string[] = ["ACZ Pet", "SVL Store"];

const MARKETPLACE_COLORS: Record<string, string> = {
  shopee: "#EE4D2D",
  mercadolivre: "#FFE600",
};

function marketplaceFromCanal(canal: string | null | undefined): "shopee" | "mercadolivre" | null {
  if (!canal) return null;
  const c = canal.toLowerCase();
  if (c.includes("shopee")) return "shopee";
  if (c.includes("mercado livre") || c.includes("mercadolivre")) return "mercadolivre";
  return null;
}

function colorForCanal(canal: string | null | undefined, mk?: string | null): string | null {
  const m = marketplaceFromCanal(canal) ?? (mk?.toLowerCase() as "shopee" | "mercadolivre" | undefined);
  return m ? MARKETPLACE_COLORS[m] ?? null : null;
}

type CoberturaFilter = "todos" | "completo" | "incompletos";
type SortKey =
  | "data_pedido"
  | "venda"
  | "custo_prod"
  | "comissao_total"
  | "imposto"
  | "margem"
  | "mc_pct";

const PAGE_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Page

function PedidosIntegradosPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const page = search.page;
  const empresas = search.empresas;
  const canais = search.canais;
  const statuses = search.statuses;
  const cobertura = search.cobertura;
  const searchText = search.q;
  const sortKey = search.sort;
  const sortDir = search.dir;

  const range = useMemo<PeriodRange>(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );

  const [canaisOptions, setCanaisOptions] = useState<string[]>([]);
  const [empresasOptions, setEmpresasOptions] = useState<string[]>(EMPRESAS_FALLBACK);
  const [searchDraft, setSearchDraft] = useState(searchText);

  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<PedidoIntegrado | null>(null);

  useEffect(() => {
    setSearchDraft(searchText);
  }, [searchText]);

  // debounce da busca antes de gravar na URL e disparar a query
  useEffect(() => {
    const next = searchDraft.trim().toLowerCase();
    if (next === searchText) return;
    const t = setTimeout(() => {
      navigate({ search: (prev) => ({ ...prev, q: next, page: 1 }), replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [navigate, searchDraft, searchText]);

  // Datas ISO do período atual e do período anterior
  const { fromIso, toIso, prevFrom, prevTo } = useMemo(() => {
    const iso = rangeToSPIso(range.from, range.to);
    const days =
      (parseISO(`${range.to}T00:00:00`).getTime() -
        parseISO(`${range.from}T00:00:00`).getTime()) /
        (1000 * 60 * 60 * 24) +
      1;
    const pTo = format(subDays(parseISO(`${range.from}T00:00:00`), 1), "yyyy-MM-dd");
    const pFrom = format(subDays(parseISO(`${range.from}T00:00:00`), days), "yyyy-MM-dd");
    return { fromIso: iso.fromIso, toIso: iso.toIso, prevFrom: pFrom, prevTo: pTo };
  }, [range.from, range.to]);

  const empresasKey = useMemo(() => [...empresas].sort().join("|"), [empresas]);
  const canaisKey = useMemo(() => [...canais].sort().join("|"), [canais]);
  const statusesKey = useMemo(() => [...statuses].sort().join("|"), [statuses]);

  // ─── KPI agregado no banco (view_kpi_pedidos_dia) — período atual ───────
  const kpiQuery = useQuery({
    queryKey: ["pi-kpi-dia", range.from, range.to, empresasKey, canaisKey],
    queryFn: async (): Promise<KpiDiaRow[]> => {
      let q = supabaseExternal
        .from("view_kpi_pedidos_dia")
        .select(
          "dia,canal,empresa,marketplace,pedidos,venda,comissao_total,custo_prod,imposto,custo_total,recebido_estimado,margem,itens,itens_sem_cmv",
        )
        .gte("dia", range.from)
        .lte("dia", range.to);
      if (empresas.length) q = q.in("empresa", empresas);
      if (canais.length) q = q.in("canal", canais);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as KpiDiaRow[];
    },
  });

  const prevKpiQuery = useQuery({
    queryKey: ["pi-kpi-dia-prev", prevFrom, prevTo, empresasKey, canaisKey],
    queryFn: async (): Promise<KpiDiaRow[]> => {
      let q = supabaseExternal
        .from("view_kpi_pedidos_dia")
        .select("pedidos,venda,custo_total,margem")
        .gte("dia", prevFrom)
        .lte("dia", prevTo);
      if (empresas.length) q = q.in("empresa", empresas);
      if (canais.length) q = q.in("canal", canais);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as KpiDiaRow[];
    },
  });

  // ─── Options de filtro (canais/empresas) — vem do próprio kpi_dia ─────
  useQuery({
    queryKey: ["pi-filter-options"],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabaseExternal
        .from("view_kpi_pedidos_dia")
        .select("canal,empresa")
        .limit(2000);
      if (data) {
        const cset = new Set<string>();
        const eset = new Set<string>();
        for (const r of data as { canal: string | null; empresa: string | null }[]) {
          if (r.canal) cset.add(r.canal);
          if (r.empresa) eset.add(r.empresa);
        }
        const cs = [...cset].sort((a, b) => a.localeCompare(b, "pt-BR"));
        const es = [...eset].sort((a, b) => a.localeCompare(b, "pt-BR"));
        if (cs.length) setCanaisOptions(cs);
        if (es.length) setEmpresasOptions(es);
      }
      return true;
    },
  });

  // ─── Lista paginada (view_margem_pedido_v2) — apenas página atual ─────
  const listQuery = useQuery({
    queryKey: [
      "pi-list",
      fromIso,
      toIso,
      page,
      sortKey,
      sortDir,
      empresasKey,
      canaisKey,
      statusesKey,
      cobertura,
      searchText,
    ],
    queryFn: async () => {
      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;
      let q = supabaseExternal
        .from("view_margem_pedido_v2")
        .select(LIST_COLUMNS, { count: "exact" })
        .gte("data_pedido", fromIso)
        .lte("data_pedido", toIso);
      if (empresas.length) q = q.in("empresa", empresas);
      if (canais.length) q = q.in("canal", canais);
      if (statuses.length && statuses.length !== DEFAULT_STATUSES.length) {
        q = q.in("status_pedido", statuses);
      }
      if (cobertura === "completo") q = q.eq("cobertura_cmv", "completo");
      else if (cobertura === "incompletos") q = q.neq("cobertura_cmv", "completo");
      if (searchText) {
        const esc = searchText.replace(/[,%()]/g, " ").trim();
        if (esc) q = q.or(`order_sn.ilike.%${esc}%,primeiro_produto_nome.ilike.%${esc}%`);
      }
      q = q.order(sortKey, { ascending: sortDir === "asc" }).range(start, end);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as unknown as PedidoIntegrado[], count: count ?? 0 };
    },
  });

  const loading = kpiQuery.isLoading || listQuery.isLoading;
  const error =
    (kpiQuery.error as Error | null)?.message ??
    (listQuery.error as Error | null)?.message ??
    null;

  // Derived selected marketplaces (para o filtro de status)
  const selectedMarketplaces = useMemo(() => {
    const set = new Set<string>();
    const src = canais.length ? canais : canaisOptions;
    for (const c of src) {
      const m = marketplaceFromCanal(c);
      if (m) set.add(m);
    }
    return [...set];
  }, [canais, canaisOptions]);

  const kpis = useMemo(() => aggregateKpiDia(kpiQuery.data ?? []), [kpiQuery.data]);
  const prevKpis = useMemo(
    () => aggregateKpiDia(prevKpiQuery.data ?? []),
    [prevKpiQuery.data],
  );

  const paged = listQuery.data?.rows ?? [];
  const totalRows = listQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  // chart data (agregado no banco)
  const dailySeries = useMemo(() => buildDailyFromKpi(kpiQuery.data ?? []), [kpiQuery.data]);
  const marketplaceShare = useMemo(
    () => buildMarketplaceShareFromKpi(kpiQuery.data ?? []),
    [kpiQuery.data],
  );
  const empresaResumo = useMemo(
    () => buildEmpresaResumoFromKpi(kpiQuery.data ?? []),
    [kpiQuery.data],
  );

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["pi-kpi-dia"] });
    queryClient.invalidateQueries({ queryKey: ["pi-kpi-dia-prev"] });
    queryClient.invalidateQueries({ queryKey: ["pi-list"] });
  };


  const updatePeriod = (next: PeriodRange) => {
    navigate({
      search: (prev) => ({ ...prev, period: next.preset, from: next.from, to: next.to, page: 1 }),
      replace: true,
    });
  };

  const updateEmpresas = (next: string[]) => {
    navigate({ search: (prev) => ({ ...prev, empresas: next, page: 1 }), replace: true });
  };

  const updateCanais = (next: string[]) => {
    navigate({ search: (prev) => ({ ...prev, canais: next, page: 1 }), replace: true });
  };

  const updateStatuses = (next: string[]) => {
    navigate({ search: (prev) => ({ ...prev, statuses: next, page: 1 }), replace: true });
  };

  const updateCobertura = (next: CoberturaFilter) => {
    navigate({ search: (prev) => ({ ...prev, cobertura: next, page: 1 }), replace: true });
  };

  const goToPage = (next: number) => {
    navigate({ search: (prev) => ({ ...prev, page: Math.max(1, Math.min(totalPages, next)) }), replace: true });
  };

  const toggleSort = (key: SortKey) => {
    const nextDir = sortKey === key && sortDir === "desc" ? "asc" : "desc";
    navigate({ search: (prev) => ({ ...prev, sort: key, dir: nextDir }), replace: true });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto">
        {/* Header */}
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Pedidos Integrados</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Margem de contribuição por pedido em marketplaces conectados
          </p>
        </header>

        <SyncStatusFooter area="pedidos_integrados" />

        {/* Filtros sticky */}
        <div className="sticky top-0 z-10 -mx-6 px-6 py-3 bg-background/80 backdrop-blur border-b">
          <div className="flex flex-wrap items-center gap-2">
            <DashboardPeriodFilter value={range} onChange={updatePeriod} />

            <EmpresaFilter value={empresas} options={empresasOptions} onChange={updateEmpresas} />
            <CanalFilter value={canais} options={canaisOptions} onChange={updateCanais} />
            <StatusFilter value={statuses} onChange={updateStatuses} marketplaces={selectedMarketplaces} />
            {(empresas.length > 0 || canais.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2 text-xs text-muted-foreground"
                onClick={() => {
                  navigate({ search: (prev) => ({ ...prev, empresas: [], canais: [], page: 1 }), replace: true });
                }}
              >
                Limpar filtros
              </Button>
            )}
            <CoberturaSegment value={cobertura} onChange={updateCobertura} />

            <div className="relative ml-auto w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder="Buscar por pedido ou produto..."
                className="pl-8 h-9 bg-card"
              />
            </div>
            <Button variant="outline" size="sm" className="h-9" onClick={refreshAll} disabled={loading}>
              Atualizar
            </Button>
          </div>


          {(empresas.length > 0 || canais.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {empresas.map((e) => (
                <Badge key={`e-${e}`} variant="secondary" className="gap-1 pl-2 pr-1 py-0.5 text-[11px]">
                  <span className="text-muted-foreground">Empresa:</span>
                  <span className="font-medium">{e}</span>
                  <button
                    onClick={() => updateEmpresas(empresas.filter((x) => x !== e))}
                    className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 px-1"
                    aria-label={`Remover ${e}`}
                  >
                    ×
                  </button>
                </Badge>
              ))}
              {canais.map((c) => (
                <Badge key={`c-${c}`} variant="secondary" className="gap-1 pl-2 pr-1 py-0.5 text-[11px]">
                  <MarketplaceDot canal={c} size={8} />
                  <span className="font-medium">{c}</span>
                  <button
                    onClick={() => updateCanais(canais.filter((x) => x !== c))}
                    className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 px-1"
                    aria-label={`Remover ${c}`}
                  >
                    ×
                  </button>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {error && (
          <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
            Erro ao carregar pedidos: {error}
          </Card>
        )}

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <KpiCard
            label="Receita Total"
            value={formatBRL(kpis.receita)}
            delta={pctDelta(kpis.receita, prevKpis.receita)}
            loading={loading}
          />
          <KpiCard
            label="Custo Total"
            value={formatBRL(kpis.custo)}
            delta={pctDelta(kpis.custo, prevKpis.custo)}
            invertColor
            loading={loading}
          />
          <KpiCard
            label="Margem Total"
            value={formatBRL(kpis.margem)}
            valueClassName={
              kpis.margem >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }
            delta={pctDelta(kpis.margem, prevKpis.margem)}
            loading={loading}
          />
          <KpiCard
            label="MC% Média"
            value={formatPercent((kpis.mcPct ?? 0) * 100, 1)}
            delta={pctDelta(kpis.mcPct, prevKpis.mcPct)}
            loading={loading}
          />
          <KpiCard
            label="Pedidos"
            value={formatNumber(kpis.qtd)}
            delta={pctDelta(kpis.qtd, prevKpis.qtd)}
            loading={loading}
          />
          <KpiCard
            label="Cobertura CMV"
            value={formatPercent(kpis.cobertura * 100, 0)}
            badge={
              kpis.cobertura > 0.8
                ? { label: "ótima", tone: "ok" }
                : kpis.cobertura > 0.5
                  ? { label: "parcial", tone: "warn" }
                  : { label: "baixa", tone: "bad" }
            }
            loading={loading}
          />
        </section>

        <EmpresaSubResumo groups={empresaResumo} loading={loading} />


        {/* Charts */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-1">Margem ao longo do tempo</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Receita (barra) × Margem (linha) por dia
            </p>
            <div className="h-64">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : dailySeries.length === 0 ? (
                <EmptyChart />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={dailySeries}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatBRL(v, { compact: true })} />
                    <RTooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(v: unknown) => formatBRL(Number(v) || 0)}
                    />
                    <Bar dataKey="receita" fill="hsl(var(--primary))" opacity={0.6} name="Receita" />
                    <Line
                      type="monotone"
                      dataKey="margem"
                      stroke="hsl(142 76% 36%)"
                      strokeWidth={2}
                      dot={false}
                      name="Margem"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-1">Distribuição por marketplace</h3>
            <p className="text-xs text-muted-foreground mb-3">Receita por canal</p>
            <div className="h-64">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : marketplaceShare.length === 0 ? (
                <EmptyChart />
              ) : (
                <div className="h-full flex flex-col">
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={marketplaceShare}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={45}
                          outerRadius={80}
                          paddingAngle={2}
                        >
                          {marketplaceShare.map((entry, i) => (
                            <Cell
                              key={i}
                              fill={
                                colorForCanal(entry.name, entry.marketplace) ??
                                DONUT_COLORS[i % DONUT_COLORS.length]
                              }
                            />
                          ))}
                        </Pie>
                        <RTooltip formatter={(v: unknown) => formatBRL(Number(v) || 0)} contentStyle={{ fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 pt-2 justify-center text-[11px]">
                    {marketplaceShare.map((s) => (
                      <span key={s.name} className="inline-flex items-center gap-1.5">
                        <MarketplaceDot canal={s.name} marketplace={s.marketplace} size={8} />
                        <span>{s.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </section>


        {/* Tabela */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="text-sm font-semibold">
              Pedidos{" "}
              <span className="text-muted-foreground font-normal">
                ({formatNumber(totalRows)})
              </span>
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2 w-12"></th>
                  <th className="text-left font-medium px-3 py-2">Pedido</th>
                  <Th label="Data" k="data_pedido" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">Empresa</th>
                  <th className="text-left font-medium px-3 py-2">Canal</th>
                  <th className="text-left font-medium px-3 py-2">Produto</th>
                  <th className="text-left font-medium px-3 py-2">UF</th>
                  <Th label="Venda" k="venda" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="CMV" k="custo_prod" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="Comissão" k="comissao_total" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="Imposto" k="imposto" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="Margem" k="margem" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="MC%" k="mc_pct" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <th className="text-center font-medium px-3 py-2 w-12">Cob.</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-t">
                      <td colSpan={15} className="px-3 py-3">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : paged.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="px-3 py-12 text-center text-sm text-muted-foreground">
                      Nenhum pedido encontrado com os filtros selecionados
                    </td>
                  </tr>
                ) : (
                  paged.map((p) => (
                    <PedidoRow key={p.order_sn} p={p} onClick={() => setSelected(p)} />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && totalRows > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <span className="text-muted-foreground">
                Página {page} de {totalPages} · {formatNumber(totalRows)} pedidos
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </Card>

        <PedidoDetailSheet pedido={selected} onClose={() => setSelected(null)} />
      </div>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents

function MarketplaceDot({ canal, marketplace, size = 10 }: { canal?: string | null; marketplace?: string | null; size?: number }) {
  const color = colorForCanal(canal ?? null, marketplace ?? null);
  if (!color) return null;
  return (
    <span
      aria-hidden
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, backgroundColor: color, boxShadow: "0 0 0 1px rgba(0,0,0,0.08) inset" }}
    />
  );
}

function EmpresaFilter({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 bg-card">
          <span className="font-medium">Empresa</span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {value.length === 0 ? "Todas" : value.length}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Empresas</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((e) => (
          <DropdownMenuCheckboxItem
            key={e}
            checked={value.includes(e)}
            onCheckedChange={(c) => {
              onChange(c ? [...value, e] : value.filter((x) => x !== e));
            }}
          >
            {e}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CanalFilter({
  value,
  options,
  onChange,
}: {
  value: string[];
  options: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 bg-card">
          <span className="font-medium">Canal</span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {value.length === 0 ? "Todos" : value.length}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Canais</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Sem canais</div>
        ) : (
          options.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={value.includes(c)}
              onCheckedChange={(chk) => {
                onChange(chk ? [...value, c] : value.filter((x) => x !== c));
              }}
            >
              <span className="inline-flex items-center gap-2">
                <MarketplaceDot canal={c} />
                {c}
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusFilter({
  value,
  onChange,
  marketplaces,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  marketplaces: string[];
}) {
  const visible = STATUS_OPTIONS.filter(
    (s) => marketplaces.length === 0 || marketplaces.includes(s.marketplace),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 bg-card">
          <span className="font-medium">Status</span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {value.length}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Status do pedido</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {visible.map((s) => (
          <DropdownMenuCheckboxItem
            key={s.value}
            checked={value.includes(s.value)}
            onCheckedChange={(c) =>
              onChange(c ? [...value, s.value] : value.filter((x) => x !== s.value))
            }
          >
            {s.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CoberturaSegment({
  value,
  onChange,
}: {
  value: CoberturaFilter;
  onChange: (v: CoberturaFilter) => void;
}) {
  const opts: { id: CoberturaFilter; label: string }[] = [
    { id: "todos", label: "Todos" },
    { id: "completo", label: "Com CMV" },
    { id: "incompletos", label: "Sem CMV" },
  ];
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-sm transition",
            value === o.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  valueClassName,
  badge,
  invertColor,
  loading,
}: {
  label: string;
  value: string;
  delta?: number | null;
  valueClassName?: string;
  badge?: { label: string; tone: "ok" | "warn" | "bad" };
  invertColor?: boolean;
  loading?: boolean;
}) {
  const positive = delta != null && delta > 0;
  const negative = delta != null && delta < 0;
  const isGood = invertColor ? negative : positive;
  const isBad = invertColor ? positive : negative;
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground font-medium">{label}</div>
      {loading ? (
        <Skeleton className="h-7 w-24 mt-2" />
      ) : (
        <div className={cn("text-xl font-semibold mt-1 tabular-nums", valueClassName)}>{value}</div>
      )}
      <div className="flex items-center gap-1.5 mt-2">
        {delta != null && Number.isFinite(delta) && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[11px] font-medium",
              isGood && "text-emerald-600 dark:text-emerald-400",
              isBad && "text-red-600 dark:text-red-400",
              !isGood && !isBad && "text-muted-foreground",
            )}
          >
            {positive ? <ArrowUp className="h-3 w-3" /> : negative ? <ArrowDown className="h-3 w-3" /> : null}
            {Math.abs(delta).toFixed(1).replace(".", ",")}%
          </span>
        )}
        {badge && (
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] h-4 px-1.5",
              badge.tone === "ok" && "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
              badge.tone === "warn" && "border-amber-500/40 text-amber-700 dark:text-amber-300",
              badge.tone === "bad" && "border-red-500/40 text-red-700 dark:text-red-300",
            )}
          >
            {badge.label}
          </Badge>
        )}
        {(delta == null || !Number.isFinite(delta)) && !badge && (
          <span className="text-[11px] text-muted-foreground">vs período anterior</span>
        )}
      </div>
    </Card>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortDir,
  onClick,
  align = "left",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onClick: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === k;
  return (
    <th className={cn("font-medium px-3 py-2", align === "right" ? "text-right" : "text-left")}>
      <button
        onClick={() => onClick(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition",
          active && "text-foreground",
        )}
      >
        {label}
        {active ? (
          sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

function PedidoRow({ p, onClick }: { p: PedidoIntegrado; onClick: () => void }) {
  const cmvMissing = p.cobertura_cmv !== "completo";
  const semCusto = p.cobertura_cmv === "sem_dado";
  return (
    <tr
      onClick={onClick}
      className={cn(
        "border-t hover:bg-accent/40 cursor-pointer transition",
        semCusto && "opacity-60",
      )}
    >
      <td className="px-3 py-2">
        <ProductThumb url={p.primeiro_produto_foto} />
      </td>
      <td className="px-3 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-xs">{p.order_sn.slice(0, 10)}…</span>
          </TooltipTrigger>
          <TooltipContent>{p.order_sn}</TooltipContent>
        </Tooltip>
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
        {p.data_pedido ? format(parseISO(p.data_pedido), "dd/MM HH:mm") : "—"}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1 flex-wrap">
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] h-5 px-1.5 font-medium border",
              STATUS_COLORS[p.status_pedido ?? ""] ?? "",
            )}
          >
            {STATUS_LABELS[p.status_pedido ?? ""] ?? p.status_pedido ?? "—"}
          </Badge>
          {p.status_pedido === "PARTIALLY_REFUNDED" && (
            <Badge
              variant="outline"
              className="text-[10px] h-5 px-1.5 font-medium border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            >
              Devolução parcial
            </Badge>
          )}
          {semCusto && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="text-[10px] h-5 px-1.5 font-medium border border-muted-foreground/30 bg-muted text-muted-foreground"
                >
                  sem custo
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Não entra nos totalizadores — custo não cadastrado
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-xs whitespace-nowrap">{p.empresa ?? "—"}</td>
      <td className="px-3 py-2 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <MarketplaceDot canal={p.canal} marketplace={p.marketplace} />
          <span>{p.canal ?? p.marketplace}</span>
        </span>
      </td>
      <td className="px-3 py-2 max-w-[260px]">
        <div className="truncate text-xs">
          {p.primeiro_produto_nome ?? "—"}
          {(p.qtd_itens ?? 1) > 1 && (
            <span className="text-muted-foreground"> + {(p.qtd_itens ?? 1) - 1}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-xs">{p.uf ?? "—"}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBRL(p.venda ?? 0)}</td>
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums",
          cmvMissing && "italic text-muted-foreground",
        )}
      >
        {p.custo_prod != null ? formatBRL(p.custo_prod) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBRL(p.comissao_total ?? 0)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{formatBRL(p.imposto ?? 0)}</td>
      <td
        className={cn(
          "px-3 py-2 text-right tabular-nums font-medium",
          p.margem == null
            ? "text-muted-foreground"
            : p.margem >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400",
        )}
      >
        {p.margem != null ? formatBRL(p.margem) : "—"}
      </td>
      <td className="px-3 py-2 text-right">
        {p.mc_pct != null ? <McPill mc={p.mc_pct} /> : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2 text-center">
        <CoberturaIcon cobertura={p.cobertura_cmv} />
      </td>
    </tr>
  );
}

function McPill({ mc }: { mc: number }) {
  const pct = mc * 100;
  const tone =
    pct > 15
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : pct >= 0
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-red-500/15 text-red-700 dark:text-red-300";
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums", tone)}>
      {formatPercent(pct, 1)}
    </span>
  );
}

function CoberturaIcon({ cobertura }: { cobertura: Cobertura | null }) {
  if (cobertura === "completo") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <CheckCircle2 className="h-4 w-4 text-emerald-500 mx-auto" />
        </TooltipTrigger>
        <TooltipContent>Cobertura completa de CMV</TooltipContent>
      </Tooltip>
    );
  }
  if (cobertura === "parcial") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertTriangle className="h-4 w-4 text-amber-500 mx-auto" />
        </TooltipTrigger>
        <TooltipContent>Cálculo parcial — algum item sem CMV</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <XCircle className="h-4 w-4 text-muted-foreground mx-auto" />
      </TooltipTrigger>
      <TooltipContent>Algum SKU não tem custo cadastrado no Tiny</TooltipContent>
    </Tooltip>
  );
}

function ProductThumb({ url }: { url: string | null }) {
  if (!url) {
    return (
      <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
        <PackageIcon className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className="h-10 w-10 rounded object-cover bg-muted"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

function EmptyChart() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      Sem dados no período
    </div>
  );
}

function PedidoDetailSheet({
  pedido,
  onClose,
}: {
  pedido: PedidoIntegrado | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!pedido} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        {pedido && (
          <>
            <SheetHeader>
              <div className="flex items-start gap-3">
                <ProductThumb url={pedido.primeiro_produto_foto} />
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-sm font-semibold leading-tight">
                    {pedido.primeiro_produto_nome ?? "Pedido"}
                  </SheetTitle>
                  <p className="text-xs text-muted-foreground font-mono mt-1">{pedido.order_sn}</p>
                </div>
              </div>
            </SheetHeader>

            <div className="mt-6 space-y-1 text-sm font-mono">
              <Row label="Venda" value={pedido.venda} bold />
              <Row label="− Comissão" value={-(pedido.taxa_comissao ?? 0)} muted />
              <Row label="+ Ajuste comercial" value={pedido.ajuste_acao_comercial} muted />
              <Row label="− Taxa de serviço" value={-(pedido.taxa_servico ?? 0)} muted />
              <Row label="− Afiliados" value={-(pedido.comissao_afiliados ?? 0)} muted />
              <div className="border-t my-1" />
              <Row label="= Recebido" value={pedido.recebido_estimado} bold />
              <Row label="− CMV" value={pedido.custo_prod != null ? -pedido.custo_prod : null} muted />
              <Row label="− Imposto" value={-(pedido.imposto ?? 0)} muted />
              <div className="border-t my-1" />
              <Row
                label="= Margem"
                value={pedido.margem}
                bold
                className={
                  pedido.margem == null
                    ? ""
                    : pedido.margem >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400"
                }
              />
              {pedido.mc_pct != null && (
                <Row label="MC%" valueText={formatPercent(pedido.mc_pct * 100, 2)} />
              )}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 text-xs">
              <Meta label="Data" value={pedido.data_pedido ? format(parseISO(pedido.data_pedido), "dd/MM/yyyy HH:mm") : "—"} />
              <Meta label="Status" value={pedido.status_pedido ?? "—"} />
              <Meta label="Localização" value={`${pedido.cidade ?? "—"}/${pedido.uf ?? "—"}`} />
              <Meta label="Itens" value={`${pedido.qtd_itens ?? 0}`} />
              <Meta label="SKUs" value={pedido.skus ?? "—"} className="col-span-2" />
              {pedido.cobertura_cmv !== "completo" && (
                <div className="col-span-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-amber-700 dark:text-amber-300">
                  Cobertura CMV: <strong>{pedido.cobertura_cmv}</strong>
                  {pedido.itens_sem_cmv ? ` · ${pedido.itens_sem_cmv} item(ns) sem custo` : ""}
                </div>
              )}
            </div>

            <Button asChild variant="outline" className="w-full mt-6 gap-2">
              <a
                href={`https://seller.shopee.com.br/portal/sale/order/${pedido.order_sn}`}
                target="_blank"
                rel="noreferrer"
              >
                Ver no Shopee Seller Center
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({
  label,
  value,
  valueText,
  bold,
  muted,
  className,
}: {
  label: string;
  value?: number | null;
  valueText?: string;
  bold?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-between py-0.5", bold && "font-semibold", muted && "text-muted-foreground", className)}>
      <span>{label}</span>
      <span className="tabular-nums">
        {valueText ?? (value == null ? "—" : formatBRL(value))}
      </span>
    </div>
  );
}

function Meta({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value}</div>
    </div>
  );
}

type EmpresaResumo = { empresa: string; receita: number; margem: number; mcPct: number };

function EmpresaSubResumo({ groups, loading }: { groups: EmpresaResumo[]; loading: boolean }) {
  if (loading || groups.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-3">Resumo por empresa</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1.5">Empresa</th>
              <th className="text-right font-medium">Receita</th>
              <th className="text-right font-medium">Margem</th>
              <th className="text-right font-medium">MC%</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.empresa} className="border-t border-border/50">
                <td className="py-1.5 font-medium">{g.empresa}</td>
                <td className="text-right tabular-nums">{formatBRL(g.receita)}</td>
                <td
                  className={cn(
                    "text-right tabular-nums font-medium",
                    g.margem >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-red-600 dark:text-red-400",
                  )}
                >
                  {formatBRL(g.margem)}
                </td>
                <td className="text-right tabular-nums">{formatPercent(g.mcPct * 100, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Helpers

const DONUT_COLORS = ["hsl(var(--primary))", "hsl(25 95% 55%)", "hsl(280 70% 60%)", "hsl(160 70% 45%)"];

function aggregateKpiDia(rows: KpiDiaRow[]) {
  let receita = 0, custo = 0, margem = 0, pedidos = 0, itens = 0, semCmv = 0;
  for (const r of rows) {
    receita += Number(r.venda ?? 0) || 0;
    custo += Number(r.custo_total ?? 0) || 0;
    margem += Number(r.margem ?? 0) || 0;
    pedidos += Number(r.pedidos ?? 0) || 0;
    itens += Number(r.itens ?? 0) || 0;
    semCmv += Number(r.itens_sem_cmv ?? 0) || 0;
  }
  const mcPct = receita > 0 ? margem / receita : 0;
  const cobertura = itens > 0 ? (itens - semCmv) / itens : 0;
  return { receita, custo, margem, mcPct, qtd: pedidos, cobertura };
}

function pctDelta(curr: number, prev: number): number | null {
  if (!prev || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function buildDailyFromKpi(rows: KpiDiaRow[]) {
  const map = new Map<string, { date: string; receita: number; margem: number }>();
  for (const r of rows) {
    if (!r.dia) continue;
    const day = r.dia.slice(0, 10);
    const e = map.get(day) ?? { date: day.slice(5), receita: 0, margem: 0 };
    e.receita += Number(r.venda ?? 0) || 0;
    e.margem += Number(r.margem ?? 0) || 0;
    map.set(day, e);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => v);
}

function buildMarketplaceShareFromKpi(
  rows: KpiDiaRow[],
): { name: string; value: number; marketplace: string | null }[] {
  const map = new Map<string, { value: number; marketplace: string | null }>();
  for (const r of rows) {
    const key = r.canal ?? r.marketplace ?? "—";
    const cur = map.get(key) ?? { value: 0, marketplace: r.marketplace ?? null };
    cur.value += Number(r.venda ?? 0) || 0;
    map.set(key, cur);
  }
  return Array.from(map.entries()).map(([name, v]) => ({
    name,
    value: v.value,
    marketplace: v.marketplace,
  }));
}

function buildEmpresaResumoFromKpi(rows: KpiDiaRow[]): EmpresaResumo[] {
  const map = new Map<string, { receita: number; margem: number }>();
  for (const r of rows) {
    const key = r.empresa ?? "—";
    const g = map.get(key) ?? { receita: 0, margem: 0 };
    g.receita += Number(r.venda ?? 0) || 0;
    g.margem += Number(r.margem ?? 0) || 0;
    map.set(key, g);
  }
  return Array.from(map.entries())
    .filter(([k, g]) => k !== "—" && g.receita > 0)
    .sort(([a], [b]) => a.localeCompare(b, "pt-BR"))
    .map(([empresa, g]) => ({
      empresa,
      receita: g.receita,
      margem: g.margem,
      mcPct: g.receita > 0 ? g.margem / g.receita : 0,
    }));
}

