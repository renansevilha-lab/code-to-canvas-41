import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  Package,
  Wallet,
  Calendar,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Target,
  Receipt,
  CheckCircle2,
  Megaphone,
  Link2,
} from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  format,
  parseISO,
  startOfMonth,
  subMonths,
  endOfMonth,
  getDate,
  getDaysInMonth,
  subDays,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { SyncStatusFooter } from "@/components/SyncStatusFooter";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

// ============================================================
// Types
// ============================================================
type MetaRealizado = {
  competencia: string;
  marketplace: string;
  receita_realizada: number | null;
  margem_realizada: number | null;
  margem_pct_receita: number | null;
  ads_realizado: number | null;
  acos_realizado: number | null;
  meta_receita: number | null;
  meta_margem: number | null;
  meta_acos: number | null;
  receita_pct_meta: number | null;
  margem_pct_meta: number | null;
  acos_estourou: boolean | null;
  dias_no_mes: number | null;
  dias_decorridos: number | null;
  receita_media_diaria: number | null;
  meta_receita_diaria: number | null;
  projecao_receita: number | null;
  projecao_margem: number | null;
  projecao_pct_meta: number | null;
  // legado (algumas views ainda expõem)
  meta_ads?: number | null;
  ads_pct_meta?: number | null;
};

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
};

type DiaRow = {
  dia: string;
  marca_canal: string | null;
  qtd_pedidos: number;
  receita: number;
};

type ProdutoRow = {
  marketplace: string;
  sku: string;
  produto: string | null;
  foto: string | null;
  receita: number | null;
  gasto_ads: number | null;
  margem_liquida: number | null;
  margem_liquida_pct: number | null;
  vira_prejuizo_com_ads: boolean | null;
  confiavel: boolean | null;
};

const CHART_COLORS = [
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(280 65% 60%)",
  "hsl(0 84% 60%)",
];

function ymd(d: Date) {
  return format(d, "yyyy-MM-dd");
}

// ============================================================
// Component
// ============================================================
function Dashboard() {
  const today = useMemo(() => new Date(), []);
  const compAtual = useMemo(() => ymd(startOfMonth(today)), [today]);
  const compAnterior = useMemo(() => ymd(startOfMonth(subMonths(today, 1))), [today]);
  const diaAtual = useMemo(() => getDate(today), [today]);
  const diasNoMes = useMemo(() => getDaysInMonth(today), [today]);

  // Ranges do mês atual (do dia 1 até hoje)
  const rangeAtual = useMemo(() => ({
    from: compAtual,
    to: ymd(today),
  }), [compAtual, today]);

  // Mesmo intervalo do mês anterior (dia 1 ao dia atual)
  const rangeMesmoIntervaloAnterior = useMemo(() => {
    const de = parseISO(compAnterior);
    const ate = new Date(de.getFullYear(), de.getMonth(), diaAtual);
    const fimMesAnt = endOfMonth(de);
    return { from: ymd(de), to: ymd(ate > fimMesAnt ? fimMesAnt : ate) };
  }, [compAnterior, diaAtual]);

  // Estados
  const [metasAtual, setMetasAtual] = useState<MetaRealizado | null>(null);
  const [metasAnterior, setMetasAnterior] = useState<MetaRealizado | null>(null);
  const [porCanal, setPorCanal] = useState<MetaRealizado[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [dias, setDias] = useState<DiaRow[]>([]);
  const [topProdutos, setTopProdutos] = useState<ProdutoRow[]>([]);
  const [produtosOcultos, setProdutosOcultos] = useState(0);
  const [alertaPrejuizo, setAlertaPrejuizo] = useState(0);
  const [alertaBaixaConf, setAlertaBaixaConf] = useState(0);
  const [alertaAcos, setAlertaAcos] = useState(0);
  const [alertaAmazon, setAlertaAmazon] = useState(0);
  const [anomSemCusto, setAnomSemCusto] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomCmvMaior, setAnomCmvMaior] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomSemRecebido, setAnomSemRecebido] = useState<{ count: number }>({ count: 0 });
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    (async () => {
      try {
        // Metas x Realizado — atual + anterior + por canal
        const metasQ = await supabaseExternal
          .from("view_metas_realizado")
          .select("*")
          .in("competencia", [compAtual, compAnterior]);

        // KPIs snapshot + diário do mês atual
        const kpisQ = supabaseExternal.rpc("get_dashboard_kpis", {
          p_data_inicio: rangeAtual.from,
          p_data_fim: rangeAtual.to,
        });
        const diasQ = supabaseExternal.rpc("get_vendas_dia", {
          p_data_inicio: rangeAtual.from,
          p_data_fim: rangeAtual.to,
        });

        // Top produtos + alertas
        const produtosQ = supabaseExternal
          .from("view_produtos_dashboard")
          .select(
            "marketplace,sku,produto,foto,receita,gasto_ads,margem_liquida,margem_liquida_pct,vira_prejuizo_com_ads,confiavel",
          )
          .limit(2000);

        // ACOS alto últimos 7 dias
        const de7 = ymd(subDays(today, 6));
        const ate7 = ymd(today);
        const acosQ = supabaseExternal
          .from("view_shopee_ads_anuncios")
          .select("campaign_id,investimento,vendas_direto")
          .gte("data", de7)
          .lte("data", ate7)
          .limit(20000);

        // Amazon SKUs sem cadastro e sem mapeamento
        const amazonQ = supabaseExternal
          .from("view_amazon_skus_mapear")
          .select("sem_cadastro,tem_mapeamento")
          .eq("sem_cadastro", true);

        // Anomalias resumidas
        const anomaliasQ = supabaseExternal
          .from("view_anomalias")
          .select("tipo, receita")
          .in("tipo", ["sku_sem_custo", "cmv_maior_que_receita", "sem_recebido"])
          .limit(20000);

        const [k, d, pr, acos, am, anoms] = await Promise.all([
          kpisQ, diasQ, produtosQ, acosQ, amazonQ, anomaliasQ,
        ]);
        if (cancel) return;

        if (metasQ.error) throw metasQ.error;
        const metasRows = (metasQ.data ?? []) as MetaRealizado[];

        const atualTodos = metasRows.find(
          (m) => m.competencia === compAtual && m.marketplace === "todos",
        );
        const anteriorTodos = metasRows.find(
          (m) => m.competencia === compAnterior && m.marketplace === "todos",
        );
        const canais = metasRows
          .filter((m) => m.competencia === compAtual && m.marketplace !== "todos")
          .sort((a, b) => Number(b.receita_realizada ?? 0) - Number(a.receita_realizada ?? 0));

        setMetasAtual(atualTodos ?? null);
        setMetasAnterior(anteriorTodos ?? null);
        setPorCanal(canais);

        if (k.error) throw k.error;
        const kRow = Array.isArray(k.data) ? k.data[0] : k.data;
        setKpis(kRow as Kpis);

        if (d.error) throw d.error;
        setDias((d.data ?? []) as DiaRow[]);

        if (pr.error) throw pr.error;
        const produtos = (pr.data ?? []) as ProdutoRow[];
        const confiaveis = produtos.filter((p) => p.confiavel !== false);
        const oculto = produtos.length - confiaveis.length;
        setProdutosOcultos(oculto);
        setTopProdutos(
          confiaveis
            .sort((a, b) => Number(b.margem_liquida ?? 0) - Number(a.margem_liquida ?? 0))
            .slice(0, 10),
        );
        setAlertaPrejuizo(produtos.filter((p) => p.vira_prejuizo_com_ads).length);
        setAlertaBaixaConf(oculto);

        if (!acos.error) {
          const map = new Map<string, { inv: number; vendas: number }>();
          for (const r of (acos.data ?? []) as { campaign_id: string; investimento: number; vendas_direto: number }[]) {
            const cur = map.get(r.campaign_id) ?? { inv: 0, vendas: 0 };
            cur.inv += Number(r.investimento ?? 0);
            cur.vendas += Number(r.vendas_direto ?? 0);
            map.set(r.campaign_id, cur);
          }
          let n = 0;
          for (const v of map.values()) {
            if (v.inv > 0 && v.vendas > 0 && (v.inv / v.vendas) * 100 > 20) n++;
          }
          setAlertaAcos(n);
        }

        if (!am.error) {
          const rows = (am.data ?? []) as { tem_mapeamento: boolean | null }[];
          setAlertaAmazon(rows.filter((r) => !r.tem_mapeamento).length);
        }
      } catch (e) {
        if (!cancel) setErro((e as Error).message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [compAtual, compAnterior, rangeAtual.from, rangeAtual.to, today]);

  // Comparativo: mesmo intervalo do mês anterior — precisa re-fetch de vendas do intervalo comparável
  const [receitaAnteriorMesmoIntervalo, setReceitaAnteriorMesmoIntervalo] = useState<number | null>(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const { data } = await supabaseExternal.rpc("get_vendas_dia", {
          p_data_inicio: rangeMesmoIntervaloAnterior.from,
          p_data_fim: rangeMesmoIntervaloAnterior.to,
        });
        if (cancel) return;
        const soma = ((data ?? []) as DiaRow[]).reduce((s, r) => s + Number(r.receita ?? 0), 0);
        setReceitaAnteriorMesmoIntervalo(soma);
      } catch { /* silencioso */ }
    })();
    return () => { cancel = true; };
  }, [rangeMesmoIntervaloAnterior.from, rangeMesmoIntervaloAnterior.to]);

  const chartData = useMemo(() => buildChartData(dias), [dias]);
  const canaisAtivos = chartData.canais;

  const metaDiariaReceita = useMemo(() => {
    if (metasAtual?.meta_receita_diaria != null) return Number(metasAtual.meta_receita_diaria);
    const meta = Number(metasAtual?.meta_receita ?? 0);
    return meta > 0 ? meta / diasNoMes : 0;
  }, [metasAtual, diasNoMes]);

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

  const receitaAtual = Number(metasAtual?.receita_realizada ?? kpis?.pedidos_receita ?? 0);
  const margemAtual = Number(metasAtual?.margem_realizada ?? 0);
  const adsAtual = Number(metasAtual?.ads_realizado ?? 0);
  const acosGeral = receitaAtual > 0 ? (adsAtual / receitaAtual) * 100 : 0;

  const diasIntervaloAnt = getDate(parseISO(rangeMesmoIntervaloAnterior.to));

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm">
          {format(parseISO(compAtual), "MMMM 'de' yyyy", { locale: ptBR })} · Metas, realizado, alertas.
        </p>
      </header>

      <SyncStatusFooter area="dashboard" />

      {/* 3.1 — Metas do mês */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ReceitaMetaCard data={metasAtual} realizadoFallback={receitaAtual} />
        <MargemMetaCard data={metasAtual} realizadoFallback={margemAtual} receita={receitaAtual} />
        <AcosMetaCard data={metasAtual} adsRealizado={adsAtual} acosFallback={acosGeral} />
      </section>


      {/* 3.2 — Comparativo mesmo intervalo do mês anterior */}
      <section>
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Comparativo: 1–{diaAtual} {format(today, "MMM", { locale: ptBR })} vs
              1–{diasIntervaloAnt} {format(parseISO(compAnterior), "MMM", { locale: ptBR })}
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <VariacaoLine
              label="Receita"
              atual={receitaAtual}
              anterior={receitaAnteriorMesmoIntervalo ?? 0}
              altaBoa
            />
            <VariacaoLine
              label="Margem"
              atual={margemAtual}
              anterior={Number(metasAnterior?.margem_realizada ?? 0)}
              altaBoa
            />
            <VariacaoLine
              label="ADS"
              atual={adsAtual}
              anterior={Number(metasAnterior?.ads_realizado ?? 0)}
              altaBoa={false}
            />
          </div>
        </Card>
      </section>

      {/* 3.3 — Visão por canal */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Por canal · {format(parseISO(compAtual), "MMMM", { locale: ptBR })}
        </h2>
        {porCanal.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">
            Sem dados por canal. Verifique se <code>view_metas_realizado</code> retorna linhas por marketplace.
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {porCanal.map((c) => (
              <CanalCard key={c.marketplace} data={c} dias={dias} />
            ))}
          </div>
        )}
      </section>

      {/* 3.4 — Evolução */}
      <section>
        <Card className="p-6">
          <div className="mb-4">
            <h2 className="font-semibold">Evolução de receita por canal</h2>
            <p className="text-xs text-muted-foreground">
              Receita diária no mês · linha tracejada = meta diária
              {metaDiariaReceita > 0 ? ` (${formatBRL(metaDiariaReceita, { compact: true })})` : " (sem meta)"}
            </p>
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
                  {metaDiariaReceita > 0 && (
                    <ReferenceLine
                      y={metaDiariaReceita}
                      stroke="hsl(var(--warning))"
                      strokeDasharray="4 4"
                      label={{ value: "meta/dia", position: "insideTopRight", fontSize: 10, fill: "hsl(var(--warning))" }}
                    />
                  )}
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

      {/* Alertas acionáveis */}
      <section>
        <Card className="p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            Alertas acionáveis
          </h2>
          <ul className="space-y-2">
            {alertaPrejuizo > 0 && (
              <AlertaItem
                dot="red"
                to="/produtos-margem"
                text={`${alertaPrejuizo} produtos ficam negativos por causa do ADS`}
              />
            )}
            {alertaAcos > 0 && (
              <AlertaItem
                dot="orange"
                to="/ads-shopee"
                text={`${alertaAcos} anúncios com ACOS acima de 20% (últimos 7 dias)`}
              />
            )}
            {alertaBaixaConf > 0 && (
              <AlertaItem
                dot="yellow"
                to="/produtos-margem"
                text={`${alertaBaixaConf} produtos sem custo cadastrado (baixa confiança)`}
              />
            )}
            {alertaAmazon > 0 && (
              <AlertaItem
                dot="yellow"
                to="/mapeamento-skus"
                text={`${alertaAmazon} SKUs da Amazon sem mapeamento`}
              />
            )}
            {kpis && kpis.contas_atrasadas_qtd > 0 && (
              <AlertaItem
                dot="red"
                to="/contas-pagar"
                text={`${kpis.contas_atrasadas_qtd} contas atrasadas · ${formatBRL(kpis.contas_atrasadas_valor, { compact: true })}`}
              />
            )}
            {alertaPrejuizo === 0 && alertaAcos === 0 && alertaBaixaConf === 0 && alertaAmazon === 0 && (!kpis || kpis.contas_atrasadas_qtd === 0) && (
              <li className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" /> Nenhuma pendência.
              </li>
            )}
          </ul>
        </Card>
      </section>

      {/* KPIs mantidos */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SmallKpi icon={ShoppingCart} label="Pedidos no mês" value={kpis ? formatNumber(kpis.pedidos_qtd) : "—"} />
        <SmallKpi icon={Receipt} label="Ticket médio" value={kpis ? formatBRL(kpis.pedidos_ticket_medio) : "—"} />
        <SmallKpi
          icon={ShoppingCart}
          label="Receita hoje"
          value={kpis ? formatBRL(kpis.pedidos_hoje_receita, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.pedidos_hoje_qtd)} pedidos` : undefined}
        />
        <SmallKpi
          icon={ShoppingCart}
          label="Receita ontem"
          value={kpis ? formatBRL(kpis.pedidos_ontem_receita, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.pedidos_ontem_qtd)} pedidos` : undefined}
        />
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SmallKpi
          icon={AlertTriangle}
          label="Contas atrasadas"
          value={kpis ? formatNumber(kpis.contas_atrasadas_qtd) : "—"}
          sub={kpis ? formatBRL(kpis.contas_atrasadas_valor, { compact: true }) : undefined}
          accent="danger"
        />
        <SmallKpi
          icon={Calendar}
          label="Vencem em 7 dias"
          value={kpis ? formatNumber(kpis.contas_7dias_qtd) : "—"}
          sub={kpis ? formatBRL(kpis.contas_7dias_valor, { compact: true }) : undefined}
          accent="warning"
        />
        <SmallKpi
          icon={Wallet}
          label="Total em aberto"
          value={kpis ? formatBRL(kpis.contas_aberto_valor, { compact: true }) : "—"}
          sub={kpis ? `${formatNumber(kpis.contas_aberto_qtd)} contas` : undefined}
        />
      </section>

      {/* Top produtos */}
      <section>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Top produtos por margem líquida</h2>
            <Link to="/produtos-margem" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver todos <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {topProdutos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem dados.</p>
          ) : (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b">
                    <th className="px-2 py-2 font-medium w-12"></th>
                    <th className="px-2 py-2 font-medium">Produto</th>
                    <th className="px-2 py-2 font-medium">Canal</th>
                    <th className="px-2 py-2 font-medium text-right">Receita</th>
                    <th className="px-2 py-2 font-medium text-right">ADS</th>
                    <th className="px-2 py-2 font-medium text-right">Margem líq.</th>
                    <th className="px-2 py-2 font-medium text-right">%</th>
                  </tr>
                </thead>
                <tbody>
                  {topProdutos.map((p, i) => (
                    <tr key={`${p.marketplace}-${p.sku}-${i}`} className="border-b last:border-0">
                      <td className="px-2 py-2">
                        <div className="h-10 w-10 rounded bg-muted overflow-hidden flex items-center justify-center">
                          {p.foto ? (
                            <img src={p.foto} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Package className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 max-w-xs">
                        <div className="truncate font-medium" title={p.produto ?? p.sku}>
                          {p.produto ?? p.sku}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono">{p.sku}</div>
                      </td>
                      <td className="px-2 py-2 capitalize">{p.marketplace}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(Number(p.receita ?? 0), { compact: true })}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(Number(p.gasto_ads ?? 0), { compact: true })}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatBRL(Number(p.margem_liquida ?? 0), { compact: true })}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <Badge variant="secondary">{formatPercent(Number(p.margem_liquida_pct ?? 0))}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {produtosOcultos > 0 && (
                <p className="text-xs text-muted-foreground mt-3">
                  {produtosOcultos} produtos ocultos por cobertura de custo insuficiente.
                </p>
              )}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

// ============================================================
// Subcomponentes
// ============================================================
const CORES = {
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  danger: "bg-destructive/10 text-destructive border-destructive/20",
  muted: "bg-muted text-muted-foreground border-border",
} as const;

type Cor = keyof typeof CORES;

function corPorMeta(pct: number): Cor {
  if (pct >= 100) return "success";
  if (pct >= 70) return "warning";
  return "danger";
}
function corProjecao(pct: number): Cor {
  if (pct >= 100) return "success";
  if (pct >= 90) return "warning";
  return "danger";
}
function progressClass(cor: Cor) {
  if (cor === "danger") return "[&>div]:bg-destructive";
  if (cor === "warning") return "[&>div]:bg-warning";
  if (cor === "success") return "[&>div]:bg-success";
  return "";
}

function CardShell({
  label, icon: Icon, children, badge,
}: {
  label: string;
  icon: typeof TrendingUp;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
            <Icon className="h-4 w-4" />
          </div>
          <span className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</span>
        </div>
        {badge}
      </div>
      {children}
    </Card>
  );
}

function ReceitaMetaCard({ data, realizadoFallback }: { data: MetaRealizado | null; realizadoFallback: number }) {
  const realizado = Number(data?.receita_realizada ?? realizadoFallback);
  const meta = data?.meta_receita != null ? Number(data.meta_receita) : null;
  const temMeta = meta != null && meta > 0;
  const pctVal = temMeta ? Number(data?.receita_pct_meta ?? (realizado / meta! * 100)) : 0;
  const cor = temMeta ? corPorMeta(pctVal) : "muted";

  const media = Number(data?.receita_media_diaria ?? 0);
  const metaDia = Number(data?.meta_receita_diaria ?? 0);
  const noRitmo = metaDia > 0 && media >= metaDia;

  const projecao = Number(data?.projecao_receita ?? 0);
  const projPct = Number(data?.projecao_pct_meta ?? 0);
  const projCor = temMeta ? corProjecao(projPct) : "muted";
  const projTextClass = { success: "text-success", warning: "text-warning", danger: "text-destructive", muted: "text-muted-foreground" }[projCor];

  const diasDec = Number(data?.dias_decorridos ?? 0);
  const diasMes = Number(data?.dias_no_mes ?? 0);

  return (
    <CardShell
      label="Receita"
      icon={TrendingUp}
      badge={temMeta ? <Badge className={CORES[cor]}>{formatPercent(pctVal)}</Badge> : undefined}
    >
      <div>
        <p className="text-3xl font-bold tabular-nums">{formatBRL(realizado, { compact: true })}</p>
        {!temMeta && (
          <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1">
            <Target className="h-3 w-3" /> Definir meta
          </Link>
        )}
      </div>
      {temMeta && (
        <>
          <Progress value={Math.min(100, pctVal)} className={progressClass(cor)} />
          <p className="text-xs text-muted-foreground">
            Meta: {formatBRL(meta!, { compact: true })}
            {realizado < meta! && ` · Faltam ${formatBRL(meta! - realizado, { compact: true })}`}
          </p>
        </>
      )}
      {metaDia > 0 && (
        <p className={`text-xs inline-flex items-center gap-1 ${noRitmo ? "text-success" : "text-destructive"}`}>
          <span>{noRitmo ? "✓" : "▼"}</span>
          Ritmo: {formatBRL(media, { compact: true })}/dia · Meta: {formatBRL(metaDia, { compact: true })}/dia
        </p>
      )}
      {temMeta && projecao > 0 && (
        <div className={`text-xs flex items-center gap-1 ${projTextClass}`}>
          <span>Projeção do mês: <strong>{formatBRL(projecao, { compact: true })}</strong> ({formatPercent(projPct)} da meta)</span>
          <TooltipProvider>
            <UITooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex"><Info className="h-3 w-3" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Projeção linear: média diária dos {diasDec} dias × {diasMes} dias do mês. Não considera sazonalidade.
              </TooltipContent>
            </UITooltip>
          </TooltipProvider>
        </div>
      )}
    </CardShell>
  );
}

function MargemMetaCard({ data, realizadoFallback, receita }: { data: MetaRealizado | null; realizadoFallback: number; receita: number }) {
  const realizado = Number(data?.margem_realizada ?? realizadoFallback);
  const meta = data?.meta_margem != null ? Number(data.meta_margem) : null;
  const temMeta = meta != null && meta > 0;
  const pctVal = temMeta ? Number(data?.margem_pct_meta ?? (realizado / meta! * 100)) : 0;
  const cor = temMeta ? corPorMeta(pctVal) : "muted";

  const margemPctReceita = data?.margem_pct_receita != null
    ? Number(data.margem_pct_receita)
    : receita > 0 ? (realizado / receita) * 100 : 0;

  const projecao = Number(data?.projecao_margem ?? 0);
  const diasDec = Number(data?.dias_decorridos ?? 0);
  const diasMes = Number(data?.dias_no_mes ?? 0);

  return (
    <CardShell
      label="Margem de contribuição"
      icon={Wallet}
      badge={temMeta ? <Badge className={CORES[cor]}>{formatPercent(pctVal)}</Badge> : undefined}
    >
      <div>
        <p className="text-3xl font-bold tabular-nums">{formatBRL(realizado, { compact: true })}</p>
        <p className="text-xs text-muted-foreground mt-1">{formatPercent(margemPctReceita)} da receita</p>
      </div>
      {temMeta ? (
        <>
          <Progress value={Math.min(100, pctVal)} className={progressClass(cor)} />
          <p className="text-xs text-muted-foreground">Meta: {formatBRL(meta!, { compact: true })}</p>
        </>
      ) : (
        <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <Target className="h-3 w-3" /> Definir meta
        </Link>
      )}
      {projecao > 0 && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <span>Projeção do mês: <strong>{formatBRL(projecao, { compact: true })}</strong></span>
          <TooltipProvider>
            <UITooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex"><Info className="h-3 w-3" /></button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                Projeção linear: média diária dos {diasDec} dias × {diasMes} dias do mês. Não considera sazonalidade.
              </TooltipContent>
            </UITooltip>
          </TooltipProvider>
        </div>
      )}
    </CardShell>
  );
}

function AcosMetaCard({ data, adsRealizado, acosFallback }: { data: MetaRealizado | null; adsRealizado: number; acosFallback: number }) {
  const ads = Number(data?.ads_realizado ?? adsRealizado);
  const acos = Number(data?.acos_realizado ?? acosFallback);
  const teto = data?.meta_acos != null ? Number(data.meta_acos) : null;
  const temTeto = teto != null && teto > 0;
  const estourou = data?.acos_estourou === true || (temTeto && acos > teto!);

  let cor: Cor = "muted";
  if (temTeto) {
    const razao = acos / teto!;
    if (estourou) cor = "danger";
    else if (razao >= 0.85) cor = "warning";
    else cor = "success";
  }

  return (
    <CardShell
      label="ACOS · publicidade"
      icon={Megaphone}
      badge={temTeto ? <Badge className={CORES[cor]}>Teto {formatPercent(teto!)}</Badge> : undefined}
    >
      <div>
        <p className={`text-3xl font-bold tabular-nums ${temTeto ? { success: "text-success", warning: "text-warning", danger: "text-destructive", muted: "" }[cor] : ""}`}>
          {formatPercent(acos)}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {formatBRL(ads, { compact: true })} investidos
        </p>
      </div>
      {temTeto ? (
        <p className="text-xs text-muted-foreground">
          Teto: {formatPercent(teto!)}
          {estourou && ` · Estourou em ${formatPercent(acos - teto!)}`}
        </p>
      ) : (
        <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <Target className="h-3 w-3" /> Definir teto
        </Link>
      )}
    </CardShell>
  );
}


function VariacaoLine({
  label, atual, anterior, altaBoa,
}: {
  label: string;
  atual: number;
  anterior: number;
  altaBoa: boolean;
}) {
  const delta = anterior > 0 ? ((atual - anterior) / Math.abs(anterior)) * 100 : 0;
  const subiu = delta > 0.05;
  const desceu = delta < -0.05;
  const bom = altaBoa ? subiu : desceu;
  const ruim = altaBoa ? desceu : subiu;
  const cor = bom ? "text-success" : ruim ? "text-destructive" : "text-muted-foreground";
  const Arrow = subiu ? ArrowUp : desceu ? ArrowDown : ArrowRight;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`inline-flex items-center gap-1 font-semibold tabular-nums ${cor}`}>
        <Arrow className="h-3.5 w-3.5" />
        {delta > 0 ? "+" : ""}{delta.toFixed(1).replace(".", ",")}%
      </span>
    </div>
  );
}

function CanalCard({ data, dias }: { data: MetaRealizado; dias: DiaRow[] }) {
  const receita = Number(data.receita_realizada ?? 0);
  const margem = Number(data.margem_realizada ?? 0);
  const ads = Number(data.ads_realizado ?? 0);
  const margemPct = receita > 0 ? (margem / receita) * 100 : 0;

  const spark = useMemo(() => {
    const filtered = dias.filter((d) =>
      (d.marca_canal ?? "").toLowerCase().includes(data.marketplace.toLowerCase()),
    );
    const map = new Map<string, number>();
    for (const d of filtered) {
      map.set(d.dia, (map.get(d.dia) ?? 0) + Number(d.receita ?? 0));
    }
    return [...map.entries()].sort().map(([dia, v]) => ({ dia, v }));
  }, [dias, data.marketplace]);

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold capitalize">{data.marketplace}</h3>
      </div>
      <div className="space-y-1">
        <p className="text-2xl font-bold tabular-nums">{formatBRL(receita, { compact: true })}</p>
        <p className="text-xs text-muted-foreground">
          Margem: {formatBRL(margem, { compact: true })} ({formatPercent(margemPct)})
        </p>
        <p className="text-xs text-muted-foreground">
          ADS: {ads > 0 ? formatBRL(ads, { compact: true }) : "—"}
        </p>
      </div>
      {spark.length > 1 && (
        <div className="h-12 -mx-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spark}>
              <Line type="monotone" dataKey="v" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function AlertaItem({ dot, to, text }: { dot: "red" | "orange" | "yellow"; to: string; text: string }) {
  const cor = { red: "bg-destructive", orange: "bg-warning", yellow: "bg-yellow-500" }[dot];
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 rounded-md p-3 hover:bg-muted/50 transition-colors">
        <span className="flex items-center gap-2.5 text-sm">
          <span className={`h-2.5 w-2.5 rounded-full ${cor}`} />
          {text}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
      </Link>
    </li>
  );
}

function SmallKpi({
  icon: Icon, label, value, sub, accent,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  sub?: string;
  accent?: "success" | "warning" | "danger";
}) {
  const map = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
  };
  const iconClass = accent ? map[accent] : "bg-primary/10 text-primary";
  return (
    <Card className="p-5">
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center mb-3 ${iconClass}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </Card>
  );
}

function buildChartData(rows: DiaRow[]) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const k = r.marca_canal ?? "Sem canal";
    totals.set(k, (totals.get(k) ?? 0) + Number(r.receita ?? 0));
  }
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
