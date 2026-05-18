import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  Package,
  Wallet,
  Calendar,
  ArrowRight,
  Sparkles,
  Receipt,
  LineChart as LineChartIcon,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import {
  PERIOD_SUFFIX,
  resolveRange,
  type PeriodPreset,
  type PeriodRange,
} from "@/lib/dashboard/period";

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
};

const VALID_PRESETS: PeriodPreset[] = [
  "today",
  "last7",
  "last30",
  "mtd",
  "prev_month",
  "last90",
  "custom",
];

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const period = VALID_PRESETS.includes(search.period as PeriodPreset)
      ? (search.period as PeriodPreset)
      : "mtd";
    return {
      period,
      from: typeof search.from === "string" ? search.from : undefined,
      to: typeof search.to === "string" ? search.to : undefined,
    };
  },
  component: Dashboard,
});

type Kpis = {
  pedidos_qtd: number;
  pedidos_receita: number;
  pedidos_ticket_medio: number;
  pedidos_hoje_qtd: number;
  pedidos_hoje_receita: number;
  pedidos_ontem_qtd: number;
  pedidos_ontem_receita: number;
  contas_atrasadas_qtd: number;
  contas_atrasadas_valor: number;
  contas_7dias_qtd: number;
  contas_7dias_valor: number;
  contas_aberto_qtd: number;
  contas_aberto_valor: number;
  produtos_ativos: number;
  produtos_com_cmv: number;
  kits_sincronizados: number;
};

type CanalRow = {
  marca_canal: string | null;
  qtd_pedidos: number;
  receita: number;
  ticket_medio: number;
  pct_total: number;
};

type DiaRow = {
  dia: string;
  marca_canal: string | null;
  qtd_pedidos: number;
  receita: number;
};

type ProdutoMargem = {
  sku: string;
  nome: string | null;
  preco_venda: number | null;
  cmv_efetivo: number | null;
  margem_bruta: number | null;
  margem_pct: number | null;
};

type FornecedorAberto = {
  fornecedor_nome: string;
  qtd_contas: number;
  total_aberto: number;
  proximo_vencimento: string | null;
};

const CHART_COLORS = [
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(280 65% 60%)",
  "hsl(0 84% 60%)",
  "hsl(190 90% 50%)",
  "hsl(50 95% 55%)",
];

function Dashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  const range: PeriodRange = useMemo(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );
  const suffix = PERIOD_SUFFIX[range.preset];

  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [canais, setCanais] = useState<CanalRow[]>([]);
  const [dias, setDias] = useState<DiaRow[]>([]);
  const [topProdutos, setTopProdutos] = useState<ProdutoMargem[]>([]);
  const [topFornecedores, setTopFornecedores] = useState<FornecedorAberto[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const handlePeriodChange = (next: PeriodRange) => {
    navigate({
      search: () =>
        next.preset === "custom"
          ? { period: next.preset, from: next.from, to: next.to }
          : { period: next.preset },
      replace: true,
    });
  };

  // Snapshot data (carregadas uma vez)
  useEffect(() => {
    (async () => {
      try {
        const [p, f] = await Promise.all([
          supabaseExternal
            .from("view_produtos_margem")
            .select("sku,nome,preco_venda,cmv_efetivo,margem_bruta,margem_pct")
            .not("margem_pct", "is", null)
            .order("margem_pct", { ascending: false })
            .limit(8),
          supabaseExternal
            .from("view_top_fornecedores_aberto")
            .select("*")
            .limit(5),
        ]);
        setTopProdutos((p.data ?? []) as ProdutoMargem[]);
        setTopFornecedores((f.data ?? []) as FornecedorAberto[]);
      } catch (e) {
        // não bloqueia o dashboard
        console.error(e);
      }
    })();
  }, []);

  // Period-aware data
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    (async () => {
      try {
        const args = { p_data_inicio: range.from, p_data_fim: range.to };
        const [k, c, d] = await Promise.all([
          supabaseExternal.rpc("get_dashboard_kpis", args),
          supabaseExternal.rpc("get_vendas_canal", args),
          supabaseExternal.rpc("get_vendas_dia", args),
        ]);
        if (cancel) return;
        if (k.error) throw k.error;
        if (c.error) throw c.error;
        if (d.error) throw d.error;
        const kRow = Array.isArray(k.data) ? k.data[0] : k.data;
        setKpis(kRow as Kpis);
        setCanais((c.data ?? []) as CanalRow[]);
        setDias((d.data ?? []) as DiaRow[]);
      } catch (e) {
        if (!cancel) setErro((e as Error).message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [range.from, range.to]);

  const chartData = useMemo(() => buildChartData(dias), [dias]);
  const canaisAtivos = chartData.canais;
  const diasMs = useMemo(
    () => Math.max(1, daysBetween(range.from, range.to)),
    [range.from, range.to],
  );

  if (erro && !kpis) {
    return (
      <div className="p-6 md:p-10 max-w-7xl mx-auto">
        <Card className="p-6 border-destructive/30 bg-destructive/5">
          <h2 className="font-semibold text-destructive">Erro ao carregar dashboard</h2>
          <p className="text-sm text-muted-foreground mt-1">{erro}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-3">
          <Badge variant="secondary" className="gap-1.5">
            <Sparkles className="h-3 w-3" />
            Visão executiva consolidada
          </Badge>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {formatRangeLabel(range)} · KPIs de vendas, contas a pagar e margem por produto.
          </p>
        </div>
        <DashboardPeriodFilter value={range} onChange={handlePeriodChange} />
      </header>

      <SyncStatusFooter area="dashboard" />

      {/* Linha 1 — period-aware */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={ShoppingCart}
          label={`Pedidos ${suffix}`}
          value={loading || !kpis ? "—" : formatNumber(kpis.pedidos_qtd)}
          sub={`${formatNumber(Math.round((kpis?.pedidos_qtd ?? 0) / diasMs))} / dia em média`}
        />
        <KpiCard
          icon={TrendingUp}
          label={`Receita ${suffix}`}
          value={loading || !kpis ? "—" : formatBRL(kpis.pedidos_receita, { compact: true })}
          sub={`Média ${formatBRL((kpis?.pedidos_receita ?? 0) / diasMs, { compact: true })} / dia`}
          accent="success"
        />
        <KpiCard
          icon={Receipt}
          label={`Ticket médio ${suffix}`}
          value={loading || !kpis ? "—" : formatBRL(kpis.pedidos_ticket_medio)}
        />
        <KpiCard
          icon={LineChartIcon}
          label="Canais ativos"
          value={loading ? "—" : formatNumber(canaisAtivos.length)}
          sub={canaisAtivos[0] ?? "—"}
        />
      </section>

      {/* Linha 2 — snapshots */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={AlertTriangle}
          label="Contas atrasadas"
          value={kpis ? formatNumber(kpis.contas_atrasadas_qtd) : "—"}
          sub={kpis ? formatBRL(kpis.contas_atrasadas_valor, { compact: true }) : undefined}
          accent="danger"
        />
        <KpiCard
          icon={Calendar}
          label="Vencem em 7 dias"
          value={kpis ? formatNumber(kpis.contas_7dias_qtd) : "—"}
          sub={kpis ? formatBRL(kpis.contas_7dias_valor, { compact: true }) : undefined}
          accent="warning"
        />
        <KpiCard
          icon={Wallet}
          label="Total em aberto"
          value={kpis ? formatBRL(kpis.contas_aberto_valor, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.contas_aberto_qtd)} contas` : undefined}
        />
        <KpiCard
          icon={Package}
          label="Produtos ativos"
          value={kpis ? formatNumber(kpis.produtos_ativos) : "—"}
          sub={kpis ? `${formatNumber(kpis.produtos_com_cmv)} com CMV` : undefined}
        />
      </section>

      {/* Linha 3 — snapshots adicionais */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          icon={Package}
          label="Kits sincronizados"
          value={kpis ? formatNumber(kpis.kits_sincronizados) : "—"}
        />
        <KpiCard
          icon={ShoppingCart}
          label="Receita hoje"
          value={kpis ? formatBRL(kpis.pedidos_hoje_receita, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.pedidos_hoje_qtd)} pedidos` : undefined}
        />
        <KpiCard
          icon={ShoppingCart}
          label="Receita ontem"
          value={kpis ? formatBRL(kpis.pedidos_ontem_receita, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.pedidos_ontem_qtd)} pedidos` : undefined}
        />
      </section>

      {/* Gráfico de linhas — vendas/dia/canal */}
      <section>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold">Vendas no período por canal</h2>
              <p className="text-xs text-muted-foreground">
                Receita diária por canal · {formatRangeLabel(range)}
              </p>
            </div>
          </div>
          {loading ? (
            <div className="h-72 animate-pulse bg-muted/40 rounded-md" />
          ) : chartData.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem vendas no período.</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData.rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis
                    dataKey="dia"
                    tickFormatter={(v) => format(parseISO(v), "dd/MM", { locale: ptBR })}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(v) => formatBRL(Number(v), { compact: true })}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(v) => format(parseISO(String(v)), "dd 'de' MMM", { locale: ptBR })}
                    formatter={(value) => formatBRL(Number(value ?? 0))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {canaisAtivos.map((canal, i) => (
                    <Line
                      key={canal}
                      type="monotone"
                      dataKey={canal}
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      {/* Canais e fornecedores */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Vendas por canal · {suffix}</h2>
            <Link to="/pedidos" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver pedidos <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 bg-muted/40 animate-pulse rounded" />
              ))}
            </div>
          ) : canais.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem vendas no período.</p>
          ) : (
            <div className="space-y-3">
              {canais.map((c) => {
                const nome = c.marca_canal ?? "Sem canal";
                return (
                  <div key={nome} className="space-y-1.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{nome}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatNumber(c.qtd_pedidos)} pedidos · {formatBRL(c.receita)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary to-primary-glow"
                        style={{ width: `${Math.max(2, Number(c.pct_total))}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">
                      {formatPercent(Number(c.pct_total))} · ticket {formatBRL(c.ticket_medio)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Top fornecedores em aberto</h2>
            <Link to="/contas-pagar" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver tudo <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {topFornecedores.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma conta em aberto.</p>
          ) : (
            <ul className="space-y-3">
              {topFornecedores.map((f) => (
                <li key={f.fornecedor_nome} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{f.fornecedor_nome}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatNumber(f.qtd_contas)} contas
                    </p>
                  </div>
                  <span className="tabular-nums font-semibold text-foreground shrink-0">
                    {formatBRL(f.total_aberto, { compact: true })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Produtos top margem */}
      <section>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Top produtos por margem</h2>
            <Link to="/produtos" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver catálogo <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {topProdutos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem dados de margem.</p>
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                    <th className="px-2 py-2 font-medium">SKU</th>
                    <th className="px-2 py-2 font-medium">Produto</th>
                    <th className="px-2 py-2 font-medium text-right">Preço</th>
                    <th className="px-2 py-2 font-medium text-right">CMV</th>
                    <th className="px-2 py-2 font-medium text-right">Margem</th>
                    <th className="px-2 py-2 font-medium text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {topProdutos.map((p) => (
                    <tr key={p.sku} className="border-b last:border-0">
                      <td className="px-2 py-2 font-mono text-xs">{p.sku}</td>
                      <td className="px-2 py-2 truncate max-w-xs">{p.nome ?? "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(p.preco_venda ?? 0)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(p.cmv_efetivo ?? 0)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(p.margem_bruta ?? 0)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <Badge className="bg-success/10 text-success border-success/20 hover:bg-success/15">
                          {formatPercent(Number(p.margem_pct ?? 0))}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

function buildChartData(rows: DiaRow[]) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = r.marca_canal ?? "Sem canal";
    totals.set(k, (totals.get(k) ?? 0) + Number(r.receita ?? 0));
  }
  // Top 5 canais para não poluir o gráfico
  const canais = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nome]) => nome);
  const set = new Set(canais);
  const byDay = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const nome = r.marca_canal ?? "Sem canal";
    if (!set.has(nome)) continue;
    const key = r.dia;
    if (!byDay.has(key)) byDay.set(key, { dia: key });
    const acc = byDay.get(key)!;
    acc[nome] = (Number(acc[nome] ?? 0) + Number(r.receita ?? 0));
  }
  const out = [...byDay.values()].sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
  return { rows: out, canais };
}

function daysBetween(from: string, to: string) {
  const a = parseISO(from).getTime();
  const b = parseISO(to).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
}

function formatRangeLabel(r: PeriodRange) {
  const a = format(parseISO(r.from), "dd MMM", { locale: ptBR });
  const b = format(parseISO(r.to), "dd MMM yyyy", { locale: ptBR });
  return `${a} – ${b}`;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  sub?: string;
  accent?: "success" | "warning" | "danger";
}) {
  const accentClasses = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
  } as const;
  const iconClass = accent ? accentClasses[accent] : "bg-primary/10 text-primary";
  return (
    <Card className="p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${iconClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </Card>
  );
}
