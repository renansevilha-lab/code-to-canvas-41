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
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
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

const VALID_PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
  pagina: number;
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
    pagina: intSearch(s.pagina ?? s.page, 1),
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

  const page = search.pagina as number;
  const empresas = search.empresas as string[];
  const canais = search.canais as string[];
  const statuses = search.statuses as string[];
  const cobertura = search.cobertura as CoberturaFilter;
  const searchText = search.q as string;
  const sortKey = search.sort as SortKey;
  const sortDir = search.dir as "asc" | "desc";

  const range = useMemo<PeriodRange>(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );

  const [canaisOptions, setCanaisOptions] = useState<string[]>([]);
  const [empresasOptions, setEmpresasOptions] = useState<string[]>(EMPRESAS_FALLBACK);
  const [searchDraft, setSearchDraft] = useState(searchText);

  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const updateSearch = (next: Partial<SearchParams>) => {
    navigate({ search: { ...search, ...next }, replace: true });
  };

  useEffect(() => {
    setSearchDraft(searchText);
  }, [searchText]);

  // debounce da busca antes de gravar na URL e disparar a query
  useEffect(() => {
    const next = searchDraft.trim().toLowerCase();
    if (next === searchText) return;
    const t = setTimeout(() => {
      updateSearch({ q: next, pagina: 1 });
    }, 250);
    return () => clearTimeout(t);
  }, [searchDraft, searchText]);

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
    updateSearch({ period: next.preset, from: next.from, to: next.to, pagina: 1 });
  };

  const updateEmpresas = (next: string[]) => {
    updateSearch({ empresas: next, pagina: 1 });
  };

  const updateCanais = (next: string[]) => {
    updateSearch({ canais: next, pagina: 1 });
  };

  const updateStatuses = (next: string[]) => {
    updateSearch({ statuses: next, pagina: 1 });
  };

  const updateCobertura = (next: CoberturaFilter) => {
    updateSearch({ cobertura: next, pagina: 1 });
  };

  const goToPage = (next: number) => {
    updateSearch({ pagina: Math.max(1, Math.min(totalPages, next)) });
  };

  const toggleSort = (key: SortKey) => {
    const nextDir = sortKey === key && sortDir === "desc" ? "asc" : "desc";
    updateSearch({ sort: key, dir: nextDir });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="w-full flex flex-col gap-[18px] px-6 md:px-8 py-6">
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
                  updateSearch({ empresas: [], canais: [], pagina: 1 });
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
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-[14px]">
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
                    <Bar dataKey="receita" fill="var(--color-primary)" opacity={0.6} name="Receita" />
                    <Line
                      type="monotone"
                      dataKey="margem"
                      stroke="var(--color-success)"
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
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h3 className="text-[14.5px] font-semibold tracking-[-0.015em]">
              Pedidos{" "}
              <span className="text-muted-foreground font-normal">({formatNumber(totalRows)})</span>
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-3" />
                  <th className="text-left font-semibold px-3 py-3">Produto</th>
                  <th className="text-left font-semibold px-3 py-3">Pedido</th>
                  <Th label="Data" k="data_pedido" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                  <th className="text-left font-semibold px-3 py-3">Empresa</th>
                  <th className="text-left font-semibold px-3 py-3">Canal</th>
                  <Th label="Receita" k="venda" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="CMV" k="custo_prod" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="Margem" k="margem" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <Th label="MC%" k="mc_pct" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <th className="text-left font-semibold px-3 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-t border-border">
                      <td colSpan={11} className="px-3 py-3">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : paged.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-12 text-center text-sm text-muted-foreground">
                      Nenhum pedido encontrado com os filtros selecionados
                    </td>
                  </tr>
                ) : (
                  paged.map((p) => (
                    <PedidoRow
                      key={p.order_sn}
                      p={p}
                      expanded={expandedId === p.order_sn}
                      onToggle={() =>
                        setExpandedId((id) => (id === p.order_sn ? null : p.order_sn))
                      }
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && totalRows > PAGE_SIZE && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-border text-sm">
              <span className="text-muted-foreground">
                Página {page} de {totalPages} · {formatNumber(totalRows)} pedidos
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  Anterior
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </Card>
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
    <Card className="p-4 flex flex-col gap-1.5">
      <span className="text-[11.5px] font-semibold text-muted-foreground">{label}</span>
      {loading ? (
        <Skeleton className="h-6 w-24" />
      ) : (
        <span className={cn("text-[21px] font-semibold tracking-[-0.03em] tabular-nums leading-none", valueClassName)}>
          {value}
        </span>
      )}
      <div className="flex items-center gap-2 min-h-[16px]">
        {delta != null && Number.isFinite(delta) ? (
          <span
            className={cn(
              "text-[11px] font-medium font-mono",
              isGood && "text-emerald-600 dark:text-emerald-400",
              isBad && "text-red-600 dark:text-red-400",
              !isGood && !isBad && "text-muted-foreground",
            )}
          >
            {positive ? "↑" : negative ? "↓" : ""} {Math.abs(delta).toFixed(1).replace(".", ",")}%
          </span>
        ) : !badge ? (
          <span className="text-[11px] text-muted-foreground">vs. anterior</span>
        ) : null}
        {badge && (
          <span
            className={cn(
              "text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
              badge.tone === "ok" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
              badge.tone === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
              badge.tone === "bad" && "bg-red-500/15 text-red-700 dark:text-red-300",
            )}
          >
            {badge.label}
          </span>
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
    <th className={cn("font-semibold px-3 py-3", align === "right" ? "text-right" : "text-left")}>
      <button
        onClick={() => onClick(k)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition",
          align === "right" && "flex-row-reverse",
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

function PedidoRow({
  p,
  expanded,
  onToggle,
}: {
  p: PedidoIntegrado;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cmvMissing = p.cobertura_cmv !== "completo";
  const semCusto = p.cobertura_cmv === "sem_dado";
  return (
    <>
      <tr
        onClick={onToggle}
        className={cn(
          "border-t border-border hover:bg-muted/40 cursor-pointer transition-colors",
          expanded && "bg-primary/[0.04]",
          semCusto && "opacity-60",
        )}
      >
        <td className="px-3 py-2.5">
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")} />
        </td>
        <td className="px-3 py-2.5 max-w-[280px]">
          <div className="flex items-center gap-2.5">
            <ProductThumb url={p.primeiro_produto_foto} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">
                {p.primeiro_produto_nome ?? "—"}
                {(p.qtd_itens ?? 1) > 1 && (
                  <span className="text-muted-foreground font-normal"> + {(p.qtd_itens ?? 1) - 1}</span>
                )}
              </div>
              <div className="truncate text-[11px] text-muted-foreground font-mono">{p.skus ?? "—"}</div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-[12px] text-muted-foreground">{p.order_sn.slice(0, 10)}…</span>
            </TooltipTrigger>
            <TooltipContent>{p.order_sn}</TooltipContent>
          </Tooltip>
        </td>
        <td className="px-3 py-2.5 text-[12px] whitespace-nowrap text-muted-foreground">
          {p.data_pedido ? format(parseISO(p.data_pedido), "dd/MM HH:mm") : "—"}
        </td>
        <td className="px-3 py-2.5 text-[12.5px] whitespace-nowrap">{p.empresa ?? "—"}</td>
        <td className="px-3 py-2.5 text-[12.5px]">
          <span className="inline-flex items-center gap-1.5">
            <MarketplaceDot canal={p.canal} marketplace={p.marketplace} />
            <span className="whitespace-nowrap">{p.canal ?? p.marketplace}</span>
          </span>
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[12.5px]">{formatBRL(p.venda ?? 0)}</td>
        <td
          className={cn(
            "px-3 py-2.5 text-right tabular-nums font-mono text-[12.5px] text-muted-foreground",
            cmvMissing && "italic",
          )}
        >
          {p.custo_prod != null ? formatBRL(p.custo_prod) : "—"}
        </td>
        <td
          className={cn(
            "px-3 py-2.5 text-right tabular-nums font-mono text-[12.5px] font-semibold",
            p.margem == null
              ? "text-muted-foreground"
              : p.margem >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400",
          )}
        >
          {p.margem != null ? formatBRL(p.margem) : "—"}
        </td>
        <td className="px-3 py-2.5 text-right">
          {p.mc_pct != null ? <McPill mc={p.mc_pct} /> : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap border",
                STATUS_COLORS[p.status_pedido ?? ""] ?? "border-border text-muted-foreground",
              )}
            >
              {STATUS_LABELS[p.status_pedido ?? ""] ?? p.status_pedido ?? "—"}
            </span>
            <CoberturaIcon cobertura={p.cobertura_cmv} />
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/25 border-t border-border">
          <td colSpan={11} className="px-6 py-5">
            <PedidoExpandido p={p} />
          </td>
        </tr>
      )}
    </>
  );
}

const COMP_CORES: Record<string, string> = {
  Margem: "#0E8A5F",
  CMV: "#64748B",
  Comissão: "var(--color-primary)",
  Imposto: "#E0A72E",
  Outros: "#94A3B8",
};

function PedidoExpandido({ p }: { p: PedidoIntegrado }) {
  const venda = Number(p.venda ?? 0);
  const partes = [
    { label: "Margem", val: Number(p.margem ?? 0) },
    { label: "CMV", val: Number(p.custo_prod ?? 0) },
    { label: "Comissão", val: Number(p.comissao_total ?? 0) },
    { label: "Imposto", val: Number(p.imposto ?? 0) },
  ];
  const somaPos = partes.reduce((a, b) => a + Math.max(0, b.val), 0);
  const outros = venda - somaPos;
  if (outros > 0.01) partes.push({ label: "Outros", val: outros });
  const base = Math.max(somaPos + Math.max(0, outros), venda, 1);

  const qtd = p.qtd_itens ?? 1;
  const shopee = marketplaceFromCanal(p.canal) === "shopee";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-8">
      {/* Composição da receita */}
      <div className="flex flex-col gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Composição da receita
        </div>
        <div className="flex h-8 rounded-lg overflow-hidden gap-0.5">
          {partes.map((part) => {
            const w = (Math.max(0, part.val) / base) * 100;
            if (w <= 0) return null;
            return (
              <div
                key={part.label}
                className="flex items-center justify-center text-white text-[10.5px] font-semibold font-mono"
                style={{ width: `${w}%`, background: COMP_CORES[part.label] }}
                title={`${part.label}: ${formatBRL(part.val)}`}
              >
                {w >= 9 ? `${w.toFixed(0)}%` : ""}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {partes.map((part) => (
            <div key={part.label} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-sm" style={{ background: COMP_CORES[part.label] }} />
              <span className="text-[12px] text-muted-foreground">{part.label}</span>
              <span className="text-[12px] font-semibold font-mono tabular-nums">{formatBRL(part.val)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detalhes do pedido */}
      <div className="flex flex-col gap-3">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          Detalhes do pedido
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3">
          <Meta label="Data do pedido" value={p.data_pedido ? format(parseISO(p.data_pedido), "dd/MM/yyyy HH:mm") : "—"} />
          <Meta label="Quantidade" value={`${qtd} ${qtd === 1 ? "item" : "itens"}`} />
          <Meta label="Ticket unitário" value={qtd > 0 ? formatBRL(venda / qtd) : "—"} />
          <Meta label="Destino" value={`${p.cidade ?? "—"}/${p.uf ?? "—"}`} />
          <Meta label="Recebido estimado" value={p.recebido_estimado != null ? formatBRL(p.recebido_estimado) : "—"} />
          <Meta
            label="Cobertura CMV"
            value={
              p.cobertura_cmv === "completo"
                ? "Completa"
                : `${p.cobertura_cmv ?? "—"}${p.itens_sem_cmv ? ` · ${p.itens_sem_cmv} sem custo` : ""}`
            }
          />
        </div>

        {p.cobertura_cmv !== "completo" && <PuxarCustoTiny pedido={p} />}

        {shopee && (
          <a
            href={`https://seller.shopee.com.br/portal/sale/order/${p.order_sn}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:underline mt-1"
          >
            Ver no Shopee Seller Center
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
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

function PuxarCustoTiny({ pedido }: { pedido: PedidoIntegrado }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const skus = (pedido.skus ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const puxar = async () => {
    if (skus.length === 0) return;
    setBusy(true);
    try {
      // Re-detalha cada SKU no Tiny (repopula produtos/produto_kits). A view de
      // margem recalcula o custo sozinha na próxima leitura.
      const resultados = await Promise.all(
        skus.map((sku) =>
          supabaseExternal.functions.invoke("tiny-sync-produtos", {
            body: { modulo: "detalhar", sku },
          }),
        ),
      );
      const erro = resultados.find((r) => r.error)?.error;
      if (erro) {
        toast.error("Falha ao puxar custo", { description: erro.message });
        return;
      }
      toast.success("Custo puxado do Tiny", { description: "Recalculando margem…" });
      await queryClient.invalidateQueries({ queryKey: ["pi-list"] });
      await queryClient.invalidateQueries({ queryKey: ["pi-kpi-dia"] });
    } catch (e) {
      toast.error("Erro ao puxar custo", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground mb-2">
        Pedido sem custo (CMV). Se o produto já tem custo cadastrado no Tiny, puxe agora para
        recalcular a margem.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="w-full gap-2"
        onClick={puxar}
        disabled={busy || skus.length === 0}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Puxar custo do Tiny
      </Button>
    </div>
  );
}

function Meta({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-[12.5px] font-medium break-words">{value}</div>
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

const DONUT_COLORS = ["var(--color-primary)", "hsl(25 95% 55%)", "hsl(280 70% 60%)", "hsl(160 70% 45%)"];

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

