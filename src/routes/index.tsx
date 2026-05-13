import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  Package,
  Wallet,
  Calendar,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type Kpis = {
  pedidos_mes_qtd: number;
  pedidos_mes_receita: number;
  pedidos_mes_ticket_medio: number;
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

type CanalMes = {
  marca_canal: string;
  qtd_pedidos: number;
  receita: number;
  ticket_medio: number;
  pct_total: number;
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

function Dashboard() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [canais, setCanais] = useState<CanalMes[]>([]);
  const [topProdutos, setTopProdutos] = useState<ProdutoMargem[]>([]);
  const [topFornecedores, setTopFornecedores] = useState<FornecedorAberto[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [k, c, p, f] = await Promise.all([
          supabaseExternal.from("view_dashboard_kpis").select("*").maybeSingle(),
          supabaseExternal
            .from("view_vendas_canal_mes")
            .select("*")
            .order("receita", { ascending: false }),
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
        if (k.error) throw k.error;
        setKpis(k.data as Kpis);
        setCanais((c.data ?? []) as CanalMes[]);
        setTopProdutos((p.data ?? []) as ProdutoMargem[]);
        setTopFornecedores((f.data ?? []) as FornecedorAberto[]);
      } catch (e) {
        setErro((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="p-6 md:p-10 max-w-7xl mx-auto">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-64 bg-muted rounded" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-28 bg-muted rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (erro || !kpis) {
    return (
      <div className="p-6 md:p-10 max-w-7xl mx-auto">
        <Card className="p-6 border-destructive/30 bg-destructive/5">
          <h2 className="font-semibold text-destructive">Erro ao carregar dashboard</h2>
          <p className="text-sm text-muted-foreground mt-1">{erro ?? "Sem dados"}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Sparkles className="h-3 w-3" />
          Visão executiva consolidada
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
          Dashboard
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          KPIs do mês corrente, canais de venda, margem por produto e contas a pagar em aberto.
        </p>
      </header>

      {/* KPIs principais */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={ShoppingCart}
          label="Pedidos no mês"
          value={formatNumber(kpis.pedidos_mes_qtd)}
          sub={`Hoje: ${formatNumber(kpis.pedidos_hoje_qtd)} · Ontem: ${formatNumber(kpis.pedidos_ontem_qtd)}`}
        />
        <KpiCard
          icon={TrendingUp}
          label="Receita no mês"
          value={formatBRL(kpis.pedidos_mes_receita, { compact: true })}
          sub={`Ticket médio ${formatBRL(kpis.pedidos_mes_ticket_medio)}`}
          accent="success"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Contas atrasadas"
          value={formatNumber(kpis.contas_atrasadas_qtd)}
          sub={formatBRL(kpis.contas_atrasadas_valor, { compact: true })}
          accent="danger"
        />
        <KpiCard
          icon={Calendar}
          label="Vencem em 7 dias"
          value={formatNumber(kpis.contas_7dias_qtd)}
          sub={formatBRL(kpis.contas_7dias_valor, { compact: true })}
          accent="warning"
        />
        <KpiCard
          icon={Wallet}
          label="Total em aberto"
          value={formatBRL(kpis.contas_aberto_valor, { compact: true })}
          sub={`${formatNumber(kpis.contas_aberto_qtd)} contas`}
        />
        <KpiCard
          icon={Package}
          label="Produtos ativos"
          value={formatNumber(kpis.produtos_ativos)}
          sub={`${formatNumber(kpis.produtos_com_cmv)} com CMV`}
        />
        <KpiCard
          icon={Package}
          label="Kits sincronizados"
          value={formatNumber(kpis.kits_sincronizados)}
        />
        <KpiCard
          icon={ShoppingCart}
          label="Receita hoje"
          value={formatBRL(kpis.pedidos_hoje_receita, { compact: true })}
          sub={`Ontem ${formatBRL(kpis.pedidos_ontem_receita, { compact: true })}`}
        />
      </section>

      {/* Canais */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Vendas por canal · mês</h2>
            <Link to="/pedidos" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver pedidos <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {canais.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem vendas no período.</p>
          ) : (
            <div className="space-y-3">
              {canais.map((c) => (
                <div key={c.marca_canal} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{c.marca_canal}</span>
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
              ))}
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
