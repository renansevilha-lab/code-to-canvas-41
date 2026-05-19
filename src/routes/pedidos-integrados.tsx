import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
  loja_nome: string | null;
  shop_id: number | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Route

const VALID_PRESETS: PeriodPreset[] = ["today", "last7", "last30", "mtd", "prev_month", "last90", "custom"];

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
};

export const Route = createFileRoute("/pedidos-integrados")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset)
      ? (s.period as PeriodPreset)
      : "last30",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
  }),
  component: PedidosIntegradosPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Constantes

const STATUS_OPTIONS = [
  "PROCESSED",
  "SHIPPED",
  "READY_TO_SHIP",
  "TO_CONFIRM_RECEIVE",
  "UNPAID",
  "CANCELLED",
] as const;

const DEFAULT_STATUSES = STATUS_OPTIONS.filter(
  (s) => s !== "CANCELLED" && s !== "UNPAID",
);

const STATUS_COLORS: Record<string, string> = {
  PROCESSED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  SHIPPED: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30",
  READY_TO_SHIP: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
  TO_CONFIRM_RECEIVE: "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  UNPAID: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  CANCELLED: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
};

const MARKETPLACES = [
  { id: "Shopee", label: "Shopee", available: true },
  { id: "Mercado Livre", label: "Mercado Livre", available: false },
  { id: "Amazon", label: "Amazon", available: false },
  { id: "TikTok Shop", label: "TikTok Shop", available: false },
];

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

  const range = useMemo<PeriodRange>(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );

  const [marketplaces, setMarketplaces] = useState<string[]>(["Shopee"]);
  const [statuses, setStatuses] = useState<string[]>([...DEFAULT_STATUSES]);
  const [cobertura, setCobertura] = useState<CoberturaFilter>("todos");
  const [searchText, setSearchText] = useState("");
  const [debounced, setDebounced] = useState("");

  const [data, setData] = useState<PedidoIntegrado[]>([]);
  const [prevData, setPrevData] = useState<PedidoIntegrado[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("data_pedido");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PedidoIntegrado | null>(null);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebounced(searchText.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [searchText]);

  // fetch
  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      setLoading(true);
      setError(null);
      try {
        const { fromIso, toIso } = rangeToSPIso(range.from, range.to);
        const days =
          (parseISO(`${range.to}T00:00:00`).getTime() -
            parseISO(`${range.from}T00:00:00`).getTime()) /
            (1000 * 60 * 60 * 24) +
          1;
        const prevTo = format(subDays(parseISO(`${range.from}T00:00:00`), 1), "yyyy-MM-dd");
        const prevFrom = format(
          subDays(parseISO(`${range.from}T00:00:00`), days),
          "yyyy-MM-dd",
        );
        const { fromIso: prevFromIso, toIso: prevToIso } = rangeToSPIso(prevFrom, prevTo);

        const baseQuery = (fromI: string, toI: string) =>
          supabaseExternal
            .from("view_pedidos_integrados")
            .select("*")
            .gte("data_pedido", fromI)
            .lte("data_pedido", toI)
            .order("data_pedido", { ascending: false })
            .limit(5000);

        const [cur, prev] = await Promise.all([
          baseQuery(fromIso, toIso),
          baseQuery(prevFromIso, prevToIso),
        ]);
        if (cancelled) return;
        if (cur.error) throw cur.error;
        setData((cur.data ?? []) as PedidoIntegrado[]);
        setPrevData((prev.data ?? []) as PedidoIntegrado[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Erro desconhecido");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchAll();
    const interval = setInterval(fetchAll, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [range.from, range.to]);

  // filtered
  const filtered = useMemo(() => {
    return data.filter((p) => {
      if (marketplaces.length && !marketplaces.includes(p.marketplace)) return false;
      if (statuses.length && (!p.status_pedido || !statuses.includes(p.status_pedido)))
        return false;
      if (cobertura === "completo" && p.cobertura_cmv !== "completo") return false;
      if (cobertura === "incompletos" && p.cobertura_cmv === "completo") return false;
      if (debounced) {
        const hay = `${p.order_sn} ${p.primeiro_produto_nome ?? ""}`.toLowerCase();
        if (!hay.includes(debounced)) return false;
      }
      return true;
    });
  }, [data, marketplaces, statuses, cobertura, debounced]);

  const filteredPrev = useMemo(() => {
    return prevData.filter((p) => {
      if (marketplaces.length && !marketplaces.includes(p.marketplace)) return false;
      if (statuses.length && (!p.status_pedido || !statuses.includes(p.status_pedido)))
        return false;
      return true;
    });
  }, [prevData, marketplaces, statuses]);

  // KPIs
  const kpis = useMemo(() => computeKpis(filtered), [filtered]);
  const prevKpis = useMemo(() => computeKpis(filteredPrev), [filteredPrev]);

  // sorted + paginated
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = (a[sortKey] ?? null) as number | string | null;
      const bv = (b[sortKey] ?? null) as number | string | null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [debounced, marketplaces, statuses, cobertura, range.from, range.to]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // chart data
  const dailySeries = useMemo(() => buildDailySeries(filtered), [filtered]);
  const worstProducts = useMemo(() => buildWorstProducts(filtered), [filtered]);
  const marketplaceShare = useMemo(() => buildMarketplaceShare(filtered), [filtered]);
  const ufRanking = useMemo(() => buildUfRanking(filtered), [filtered]);

  const updatePeriod = (next: PeriodRange) => {
    navigate({
      search: { period: next.preset, from: next.from, to: next.to },
      replace: true,
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
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

            <MarketplaceFilter value={marketplaces} onChange={setMarketplaces} />
            <StatusFilter value={statuses} onChange={setStatuses} />
            <CoberturaSegment value={cobertura} onChange={setCobertura} />

            <div className="relative ml-auto w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Buscar por pedido ou produto..."
                className="pl-8 h-9 bg-card"
              />
            </div>
          </div>
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
            <h3 className="text-sm font-semibold mb-1">Top 10 produtos com pior margem</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Apenas pedidos com cobertura completa e margem negativa
            </p>
            <div className="h-64">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : worstProducts.length === 0 ? (
                <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                  Nenhum produto com margem negativa no período
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={worstProducts} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => formatBRL(v, { compact: true })}
                    />
                    <YAxis
                      type="category"
                      dataKey="nome"
                      width={140}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: string) => (v.length > 22 ? v.slice(0, 22) + "…" : v)}
                    />
                    <RTooltip formatter={(v: unknown) => formatBRL(Number(v) || 0)} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="margem" fill="hsl(0 84% 60%)" />
                  </BarChart>
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
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={marketplaceShare}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {marketplaceShare.map((_, i) => (
                        <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />
                      ))}
                    </Pie>
                    <RTooltip formatter={(v: unknown) => formatBRL(Number(v) || 0)} contentStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-1">Margem média por UF</h3>
            <p className="text-xs text-muted-foreground mb-3">Top 10 estados (cobertura completa)</p>
            <div className="h-64 overflow-auto">
              {loading ? (
                <Skeleton className="h-full w-full" />
              ) : ufRanking.length === 0 ? (
                <EmptyChart />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground sticky top-0 bg-card">
                    <tr>
                      <th className="text-left font-medium py-1.5">UF</th>
                      <th className="text-right font-medium">Pedidos</th>
                      <th className="text-right font-medium">Receita</th>
                      <th className="text-right font-medium">Margem média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ufRanking.map((u) => (
                      <tr key={u.uf} className="border-t border-border/50">
                        <td className="py-1.5 font-medium">{u.uf}</td>
                        <td className="text-right tabular-nums">{u.qtd}</td>
                        <td className="text-right tabular-nums">{formatBRL(u.receita)}</td>
                        <td
                          className={cn(
                            "text-right tabular-nums font-medium",
                            u.margemMedia >= 0
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-red-600 dark:text-red-400",
                          )}
                        >
                          {formatBRL(u.margemMedia)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                ({formatNumber(sorted.length)})
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
                      <td colSpan={14} className="px-3 py-3">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                ) : paged.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="px-3 py-12 text-center text-sm text-muted-foreground">
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

          {!loading && sorted.length > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
              <span className="text-muted-foreground">
                Página {page} de {totalPages} · {formatNumber(sorted.length)} pedidos
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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

function MarketplaceFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 bg-card">
          <span className="font-medium">Marketplace</span>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {value.length}
          </Badge>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Canais</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {MARKETPLACES.map((m) => (
          <DropdownMenuCheckboxItem
            key={m.id}
            checked={value.includes(m.id)}
            disabled={!m.available}
            onCheckedChange={(c) => {
              if (!m.available) return;
              onChange(c ? [...value, m.id] : value.filter((x) => x !== m.id));
            }}
            className="flex items-center justify-between"
          >
            <span>{m.label}</span>
            {!m.available && (
              <Badge variant="secondary" className="text-[10px] h-4">
                em breve
              </Badge>
            )}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
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
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Status do pedido</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {STATUS_OPTIONS.map((s) => (
          <DropdownMenuCheckboxItem
            key={s}
            checked={value.includes(s)}
            onCheckedChange={(c) =>
              onChange(c ? [...value, s] : value.filter((x) => x !== s))
            }
          >
            {s}
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
  return (
    <tr
      onClick={onClick}
      className="border-t hover:bg-accent/40 cursor-pointer transition"
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
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] h-5 px-1.5 font-medium border",
            STATUS_COLORS[p.status_pedido ?? ""] ?? "",
          )}
        >
          {p.status_pedido ?? "—"}
        </Badge>
      </td>
      <td className="px-3 py-2 text-xs">{p.marketplace}</td>
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

const DONUT_COLORS = ["hsl(var(--primary))", "hsl(25 95% 55%)", "hsl(280 70% 60%)", "hsl(160 70% 45%)"];

function computeKpis(rows: PedidoIntegrado[]) {
  const receita = sum(rows, (r) => r.venda);
  const custo = sum(
    rows.filter((r) => r.cobertura_cmv !== "sem_dado"),
    (r) => r.custo_total,
  );
  const completos = rows.filter((r) => r.cobertura_cmv === "completo");
  const margem = sum(completos, (r) => r.margem);
  const mcReceita = sum(completos, (r) => r.venda);
  const mcWeighted = sum(completos, (r) => (r.mc_pct ?? 0) * (r.venda ?? 0));
  const mcPct = mcReceita > 0 ? mcWeighted / mcReceita : 0;
  const cobertura = rows.length > 0 ? completos.length / rows.length : 0;
  return { receita, custo, margem, mcPct, qtd: rows.length, cobertura };
}

function sum<T>(rows: T[], pick: (r: T) => number | null | undefined): number {
  return rows.reduce((acc, r) => acc + (Number(pick(r) ?? 0) || 0), 0);
}

function pctDelta(curr: number, prev: number): number | null {
  if (!prev || !Number.isFinite(prev) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function buildDailySeries(rows: PedidoIntegrado[]) {
  const map = new Map<string, { date: string; receita: number; margem: number }>();
  for (const r of rows) {
    if (!r.data_pedido) continue;
    const day = r.data_pedido.slice(0, 10);
    const e = map.get(day) ?? { date: day.slice(5), receita: 0, margem: 0 };
    e.receita += r.venda ?? 0;
    if (r.cobertura_cmv === "completo") e.margem += r.margem ?? 0;
    map.set(day, e);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => v);
}

function buildWorstProducts(rows: PedidoIntegrado[]) {
  const map = new Map<string, { nome: string; margem: number }>();
  for (const r of rows) {
    if (r.cobertura_cmv !== "completo" || (r.margem ?? 0) >= 0) continue;
    const key = r.primeiro_produto_nome ?? r.skus ?? r.order_sn;
    const e = map.get(key) ?? { nome: key, margem: 0 };
    e.margem += r.margem ?? 0;
    map.set(key, e);
  }
  return Array.from(map.values())
    .sort((a, b) => a.margem - b.margem)
    .slice(0, 10);
}

function buildMarketplaceShare(rows: PedidoIntegrado[]) {
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.marketplace, (map.get(r.marketplace) ?? 0) + (r.venda ?? 0));
  }
  return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

function buildUfRanking(rows: PedidoIntegrado[]) {
  const map = new Map<string, { uf: string; qtd: number; receita: number; margemSoma: number; margemQtd: number }>();
  for (const r of rows) {
    const uf = (r.uf ?? "—").trim() || "—";
    if (uf === "****") continue;
    const e = map.get(uf) ?? { uf, qtd: 0, receita: 0, margemSoma: 0, margemQtd: 0 };
    e.qtd += 1;
    e.receita += r.venda ?? 0;
    if (r.cobertura_cmv === "completo" && r.margem != null) {
      e.margemSoma += r.margem;
      e.margemQtd += 1;
    }
    map.set(uf, e);
  }
  return Array.from(map.values())
    .map((e) => ({
      uf: e.uf,
      qtd: e.qtd,
      receita: e.receita,
      margemMedia: e.margemQtd > 0 ? e.margemSoma / e.margemQtd : 0,
    }))
    .sort((a, b) => b.receita - a.receita)
    .slice(0, 10);
}
