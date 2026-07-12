import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  ShoppingCart,
  AlertTriangle,
  Package,
  Wallet,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Target,
  Megaphone,
  CheckCircle2,
  Info,
  RefreshCw,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Line,
  LineChart,
} from "recharts";
import {
  format,
  parseISO,
  startOfMonth,
  endOfMonth,
  subMonths,
  subDays,
  differenceInCalendarDays,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

// ============================================================
// Types
// ============================================================
type KpiCanal = {
  canal: string;
  marketplace: string;
  shop_id: string | null;
  pedidos: number;
  receita: number;
  receita_com_custo: number;
  cmv: number;
  imposto: number;
  margem: number;
  mc_pct: number;
  ticket_medio: number;
  ads: number | null;
  acos: number | null;
  pedidos_ant: number | null;
  receita_ant: number | null;
  margem_ant: number | null;
  var_receita_pct: number | null;
  var_margem_pct: number | null;
  var_pedidos_pct: number | null;
  cobertura_pct: number | null;
};

type ReceitaDiaCanal = {
  canal: string;
  marketplace: string;
  shop_id: string | null;
  data: string;
  pedidos: number;
  receita: number;
  margem: number;
  ticket_medio: number;
};

type MetaRealizado = {
  competencia: string;
  marketplace: string;
  receita_realizada: number | null;
  margem_realizada: number | null;
  ads_realizado: number | null;
  acos_realizado: number | null;
  meta_receita: number | null;
  meta_margem: number | null;
  meta_acos: number | null;
  receita_pct_meta: number | null;
  margem_pct_meta: number | null;
  acos_estourou: boolean | null;
  meta_receita_diaria: number | null;
  receita_media_diaria: number | null;
  projecao_receita: number | null;
  projecao_pct_meta: number | null;
  dias_decorridos: number | null;
  dias_no_mes: number | null;
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

// ============================================================
// Period presets
// ============================================================
type PresetKey = "hoje" | "ontem" | "mes_atual" | "ult_7" | "ult_30" | "mes_anterior" | "custom";

function computeRange(preset: PresetKey, custom?: { from: string; to: string }): { from: string; to: string } {
  const today = new Date();
  const ymd = (d: Date) => format(d, "yyyy-MM-dd");
  switch (preset) {
    case "hoje":
      return { from: ymd(today), to: ymd(today) };
    case "ontem": {
      const y = subDays(today, 1);
      return { from: ymd(y), to: ymd(y) };
    }
    case "mes_atual":
      return { from: ymd(startOfMonth(today)), to: ymd(today) };
    case "ult_7":
      return { from: ymd(subDays(today, 6)), to: ymd(today) };
    case "ult_30":
      return { from: ymd(subDays(today, 29)), to: ymd(today) };
    case "mes_anterior": {
      const m = subMonths(today, 1);
      return { from: ymd(startOfMonth(m)), to: ymd(endOfMonth(m)) };
    }
    case "custom":
      return custom ?? { from: ymd(startOfMonth(today)), to: ymd(today) };
  }
}

const PRESET_LABEL: Record<PresetKey, string> = {
  hoje: "Hoje",
  ontem: "Ontem",
  mes_atual: "Mês atual",
  ult_7: "Últimos 7 dias",
  ult_30: "Últimos 30 dias",
  mes_anterior: "Mês anterior",
  custom: "Personalizado",
};

// ============================================================
// Canal colors
// ============================================================
function colorForCanal(canal: string): string {
  const c = (canal ?? "").toLowerCase();
  if (c.includes("shopee") && c.includes("ottz")) return "hsl(24 95% 53%)"; // laranja
  if (c.includes("shopee") && (c.includes("svl") || c.includes("sv "))) return "hsl(270 60% 55%)"; // roxo
  if (c.includes("shopee")) return "hsl(24 95% 53%)";
  if (c.includes("mercado")) return "hsl(45 93% 47%)"; // amarelo
  if (c.includes("amazon")) return "hsl(215 60% 22%)"; // azul escuro
  return "hsl(215 15% 55%)";
}

// ============================================================
// Component
// ============================================================
function Dashboard() {
  const [preset, setPreset] = useState<PresetKey>("mes_atual");
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const range = useMemo(
    () => computeRange(preset, customRange ?? undefined),
    [preset, customRange],
  );

  const [canaisFiltro, setCanaisFiltro] = useState<string[] | null>(null); // null = todos
  const [kpisCanal, setKpisCanal] = useState<KpiCanal[]>([]);
  const [diario, setDiario] = useState<ReceitaDiaCanal[]>([]);
  const [metas, setMetas] = useState<MetaRealizado[]>([]);
  const [topProdutos, setTopProdutos] = useState<ProdutoRow[]>([]);
  const [alertaAcos, setAlertaAcos] = useState(0);
  const [alertaAmazon, setAlertaAmazon] = useState(0);
  const [anomSemCusto, setAnomSemCusto] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomCmvMaior, setAnomCmvMaior] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomSemRecebido, setAnomSemRecebido] = useState<{ count: number }>({ count: 0 });
  const [alertaPrejuizo, setAlertaPrejuizo] = useState(0);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const compAtual = useMemo(() => format(startOfMonth(new Date()), "yyyy-MM-dd"), []);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);

    (async () => {
      try {
        // Período anterior (mesmo nº de dias, imediatamente antes)
        const dFrom = parseISO(range.from);
        const dTo = parseISO(range.to);
        const nDias = differenceInCalendarDays(dTo, dFrom) + 1;
        const prevTo = format(subDays(dFrom, 1), "yyyy-MM-dd");
        const prevFrom = format(subDays(dFrom, nDias), "yyyy-MM-dd");

        const canaisQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,marketplace,shop_id,data,pedidos,receita,receita_com_custo,cmv,margem,ads")
          .gte("data", range.from)
          .lte("data", range.to)
          .limit(20000);

        const canaisPrevQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,shop_id,pedidos,receita,margem,ads")
          .gte("data", prevFrom)
          .lte("data", prevTo)
          .limit(20000);

        const diaQ = supabaseExternal
          .from("view_receita_diaria_canal")
          .select("canal,marketplace,shop_id,data,pedidos,receita,margem,ticket_medio")
          .gte("data", range.from)
          .lte("data", range.to)
          .order("data", { ascending: true })
          .limit(20000);

        const metasQ = supabaseExternal
          .from("view_metas_realizado")
          .select("*")
          .eq("competencia", compAtual);

        const produtosQ = supabaseExternal
          .from("view_produtos_dashboard")
          .select("marketplace,sku,produto,foto,receita,gasto_ads,margem_liquida,margem_liquida_pct,vira_prejuizo_com_ads,confiavel")
          .limit(2000);

        const de7 = format(subDays(new Date(), 6), "yyyy-MM-dd");
        const ate7 = format(new Date(), "yyyy-MM-dd");
        const acosQ = supabaseExternal
          .from("view_shopee_ads_anuncios")
          .select("campaign_id,investimento,vendas_direto")
          .gte("data", de7)
          .lte("data", ate7)
          .limit(20000);

        const amazonQ = supabaseExternal
          .from("view_amazon_skus_mapear")
          .select("sem_cadastro,tem_mapeamento")
          .eq("sem_cadastro", true);

        const anomsQ = supabaseExternal
          .from("view_anomalias")
          .select("tipo, receita")
          .in("tipo", ["sku_sem_custo", "cmv_maior_que_receita", "sem_recebido"])
          .limit(20000);

        const [canaisR, canaisPrevR, dia, met, prod, acos, am, anoms] = await Promise.all([
          canaisQ, canaisPrevQ, diaQ, metasQ, produtosQ, acosQ, amazonQ, anomsQ,
        ]);
        if (cancel) return;

        console.log("view_canais_diario →", {
          rows: canaisR.data?.length ?? 0,
          error: canaisR.error,
          range,
        });
        if (canaisR.error) setErro(`view_canais_diario: ${canaisR.error.message}`);

        type CanalRow = {
          canal: string; marketplace: string; shop_id: string | null; data: string;
          pedidos: number | null; receita: number | null; receita_com_custo: number | null;
          cmv: number | null; margem: number | null; ads: number | null;
        };
        type CanalPrevRow = {
          canal: string; shop_id: string | null;
          pedidos: number | null; receita: number | null; margem: number | null; ads: number | null;
        };

        const rows = (canaisR.data ?? []) as CanalRow[];
        const rowsPrev = (canaisPrevR.data ?? []) as CanalPrevRow[];

        // Agrega período atual por canal
        const agg = new Map<string, KpiCanal>();
        for (const r of rows) {
          const key = `${r.canal}|${r.shop_id ?? ""}`;
          const cur = agg.get(key) ?? {
            canal: r.canal,
            marketplace: r.marketplace,
            shop_id: r.shop_id,
            pedidos: 0, receita: 0, cmv: 0, imposto: 0, margem: 0,
            mc_pct: 0, ticket_medio: 0,
            ads: 0, acos: null,
            pedidos_ant: null, receita_ant: null, margem_ant: null,
            var_receita_pct: null, var_margem_pct: null, var_pedidos_pct: null,
            cobertura_pct: null,
            receita_com_custo: 0,
          };
          cur.pedidos += Number(r.pedidos ?? 0);
          cur.receita += Number(r.receita ?? 0);
          cur.receita_com_custo += Number(r.receita_com_custo ?? 0);
          cur.cmv += Number(r.cmv ?? 0);
          cur.margem += Number(r.margem ?? 0);
          cur.ads = (cur.ads ?? 0) + Number(r.ads ?? 0);
          agg.set(key, cur);
        }

        // Agrega período anterior por canal
        const aggPrev = new Map<string, { pedidos: number; receita: number; margem: number; ads: number }>();
        for (const r of rowsPrev) {
          const key = `${r.canal}|${r.shop_id ?? ""}`;
          const cur = aggPrev.get(key) ?? { pedidos: 0, receita: 0, margem: 0, ads: 0 };
          cur.pedidos += Number(r.pedidos ?? 0);
          cur.receita += Number(r.receita ?? 0);
          cur.margem += Number(r.margem ?? 0);
          cur.ads += Number(r.ads ?? 0);
          aggPrev.set(key, cur);
        }

        const pctVar = (cur: number, prev: number): number | null => {
          if (!prev) return null;
          return ((cur - prev) / Math.abs(prev)) * 100;
        };

        const kpiRows: KpiCanal[] = [];
        for (const [key, v] of agg) {
          v.ticket_medio = v.pedidos > 0 ? v.receita / v.pedidos : 0;
          // Margem de contribuição % sobre receita_com_custo (base coberta)
          v.mc_pct = v.receita_com_custo > 0 ? (v.margem / v.receita_com_custo) * 100 : 0;
          v.acos = v.receita > 0 ? ((v.ads ?? 0) / v.receita) * 100 : null;
          v.cobertura_pct = v.receita > 0 ? (v.receita_com_custo / v.receita) * 100 : null;

          const p = aggPrev.get(key);
          if (p) {
            v.pedidos_ant = p.pedidos;
            v.receita_ant = p.receita;
            v.margem_ant = p.margem;
            v.var_receita_pct = pctVar(v.receita, p.receita);
            v.var_margem_pct = pctVar(v.margem, p.margem);
            v.var_pedidos_pct = pctVar(v.pedidos, p.pedidos);
          }
          kpiRows.push(v);
        }

        const diaRows = !dia.error ? ((dia.data ?? []) as ReceitaDiaCanal[]) : [];
        setDiario(diaRows);
        setKpisCanal(kpiRows);
        if (!met.error) setMetas((met.data ?? []) as MetaRealizado[]);

        if (!prod.error) {
          const produtos = (prod.data ?? []) as ProdutoRow[];
          const confiaveis = produtos.filter((p) => p.confiavel !== false);
          setTopProdutos(
            confiaveis
              .sort((a, b) => Number(b.margem_liquida ?? 0) - Number(a.margem_liquida ?? 0))
              .slice(0, 8),
          );
          setAlertaPrejuizo(produtos.filter((p) => p.vira_prejuizo_com_ads).length);
        }

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

        if (!anoms.error) {
          const rows = (anoms.data ?? []) as { tipo: string; receita: number | null }[];
          const acc = {
            sku_sem_custo: { count: 0, receita: 0 },
            cmv_maior_que_receita: { count: 0, receita: 0 },
            sem_recebido: { count: 0, receita: 0 },
          };
          for (const r of rows) {
            const g = acc[r.tipo as keyof typeof acc];
            if (!g) continue;
            g.count++;
            g.receita += Number(r.receita ?? 0);
          }
          setAnomSemCusto(acc.sku_sem_custo);
          setAnomCmvMaior(acc.cmv_maior_que_receita);
          setAnomSemRecebido({ count: acc.sem_recebido.count });
        }

        setAtualizadoEm(new Date());
      } catch (e) {
        if (!cancel) setErro((e as Error).message);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [range.from, range.to, compAtual, tick]);

  // Lista de todos os canais conhecidos (para o filtro)
  const canaisDisponiveis = useMemo(() => {
    const set = new Set<string>();
    for (const r of kpisCanal) set.add(r.canal);
    return Array.from(set).sort();
  }, [kpisCanal]);

  const kpisVisiveis = useMemo(() => {
    if (!canaisFiltro) return kpisCanal;
    const s = new Set(canaisFiltro);
    return kpisCanal.filter((r) => s.has(r.canal));
  }, [kpisCanal, canaisFiltro]);

  const diarioVisivel = useMemo(() => {
    if (!canaisFiltro) return diario;
    const s = new Set(canaisFiltro);
    return diario.filter((r) => s.has(r.canal));
  }, [diario, canaisFiltro]);

  // Totais consolidados
  const totais = useMemo(() => {
    const t = {
      pedidos: 0, receita: 0, margem: 0, ads: 0, cmv: 0, imposto: 0,
      pedidos_ant: 0, receita_ant: 0, margem_ant: 0,
      ticket_medio: 0, acos: 0, mc_pct: 0,
    };
    for (const r of kpisVisiveis) {
      t.pedidos += Number(r.pedidos ?? 0);
      t.receita += Number(r.receita ?? 0);
      t.margem += Number(r.margem ?? 0);
      t.ads += Number(r.ads ?? 0);
      t.cmv += Number(r.cmv ?? 0);
      t.imposto += Number(r.imposto ?? 0);
      t.pedidos_ant += Number(r.pedidos_ant ?? 0);
      t.receita_ant += Number(r.receita_ant ?? 0);
      t.margem_ant += Number(r.margem_ant ?? 0);
    }
    t.ticket_medio = t.pedidos > 0 ? t.receita / t.pedidos : 0;
    t.acos = t.receita > 0 ? (t.ads / t.receita) * 100 : 0;
    t.mc_pct = t.receita > 0 ? (t.margem / t.receita) * 100 : 0;
    return t;
  }, [kpisVisiveis]);

  const ticketMedioAnt = totais.pedidos_ant > 0 ? totais.receita_ant / totais.pedidos_ant : 0;

  // Série diária consolidada
  const serieTotal = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of diarioVisivel) {
      m.set(r.data, (m.get(r.data) ?? 0) + Number(r.receita ?? 0));
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([data, receita]) => ({ data, receita }));
  }, [diarioVisivel]);

  const donutData = useMemo(() => {
    return kpisVisiveis
      .filter((r) => Number(r.receita ?? 0) > 0)
      .sort((a, b) => Number(b.receita) - Number(a.receita))
      .map((r) => ({
        name: r.canal,
        value: Number(r.receita),
        color: colorForCanal(r.canal),
      }));
  }, [kpisVisiveis]);

  const diasPeriodo = differenceInCalendarDays(parseISO(range.to), parseISO(range.from)) + 1;

  // Metas
  const metaTodos = metas.find((m) => m.marketplace === "todos") ?? null;

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8 bg-background">
      {/* Header + filtros */}
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {format(parseISO(range.from), "dd MMM", { locale: ptBR })} –
            {" "}{format(parseISO(range.to), "dd MMM yyyy", { locale: ptBR })}
            {" · "}{diasPeriodo} {diasPeriodo === 1 ? "dia" : "dias"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodoPicker
            preset={preset}
            onPreset={(p) => {
              setPreset(p);
              if (p !== "custom") setCustomRange(null);
            }}
            customRange={customRange}
            onCustom={(r) => { setCustomRange(r); setPreset("custom"); }}
          />
          <CanalFilter
            canais={canaisDisponiveis}
            selecionados={canaisFiltro}
            onChange={setCanaisFiltro}
          />
          <Button variant="outline" size="sm" onClick={() => setTick((x) => x + 1)} className="gap-2">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            {atualizadoEm ? `Atualizado ${format(atualizadoEm, "HH:mm")}` : "Atualizar"}
          </Button>
        </div>
      </header>

      {erro && (
        <Card className="p-4 border-destructive/30 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Erro ao carregar dashboard</p>
          <p className="text-xs text-muted-foreground mt-1">{erro}</p>
        </Card>
      )}

      {/* 2.1 — Linha superior: Total das vendas + Donut */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Total das vendas</p>
              <p className="text-4xl font-semibold tabular-nums mt-1">{formatBRL(totais.receita, { compact: true })}</p>
              <div className="mt-2">
                <VariacaoBadge atual={totais.receita} anterior={totais.receita_ant} altaBoa />
              </div>
            </div>
            <Link to="/pedidos" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Expandir detalhes <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {loading ? (
            <div className="h-40 animate-pulse bg-muted/40 rounded-md" />
          ) : serieTotal.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">Sem vendas no período.</p>
          ) : (
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={serieTotal} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradReceita" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(215 80% 55%)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(215 80% 55%)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="data"
                    tickFormatter={(v) => format(parseISO(v), "dd/MM")}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(v) => format(parseISO(String(v)), "dd 'de' MMM", { locale: ptBR })}
                    formatter={(value) => [formatBRL(Number(value ?? 0)), "Receita"]}
                  />
                  <Area
                    type="monotone"
                    dataKey="receita"
                    stroke="hsl(215 80% 55%)"
                    strokeWidth={2}
                    fill="url(#gradReceita)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-6 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Receita por canal</p>
            <p className="text-xs text-muted-foreground mt-1">Participação no período</p>
          </div>
          {donutData.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">—</p>
          ) : (
            <>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={donutData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {donutData.map((d, i) => (
                        <Cell key={i} fill={d.color} stroke="transparent" />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value) => formatBRL(Number(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <ul className="space-y-1.5">
                {donutData.map((d) => {
                  const pct = totais.receita > 0 ? (d.value / totais.receita) * 100 : 0;
                  return (
                    <li key={d.name} className="flex items-center gap-2 text-xs">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ background: d.color }}
                      />
                      <span className="truncate flex-1">{d.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatBRL(d.value, { compact: true })} · {pct.toFixed(1).replace(".", ",")}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      </section>

      {/* 2.2 — Visão geral */}
      <section>
        <Card className="p-6">
          <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium mb-4">Visão geral</p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
            <VisaoItem
              label="Pedidos"
              value={formatNumber(totais.pedidos)}
              atual={totais.pedidos}
              anterior={totais.pedidos_ant}
              altaBoa
            />
            <VisaoItem
              label="Receita"
              value={formatBRL(totais.receita, { compact: true })}
              atual={totais.receita}
              anterior={totais.receita_ant}
              altaBoa
            />
            <VisaoItem
              label="Margem contrib."
              value={formatBRL(totais.margem, { compact: true })}
              atual={totais.margem}
              anterior={totais.margem_ant}
              altaBoa
            />
            <VisaoItem
              label="Ticket médio"
              value={formatBRL(totais.ticket_medio)}
              atual={totais.ticket_medio}
              anterior={ticketMedioAnt}
              altaBoa
            />
            <VisaoItem
              label="Gasto com ADS"
              value={formatBRL(totais.ads, { compact: true })}
              atual={totais.ads}
              anterior={null}
              altaBoa={false}
            />
            <VisaoItem
              label="ACOS geral"
              value={formatPercent(totais.acos)}
              atual={totais.acos}
              anterior={null}
              altaBoa={false}
            />
          </div>
        </Card>
      </section>

      {/* 2.3 — Cards por canal */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Desempenho por canal</h2>
        </div>
        {loading && kpisVisiveis.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-64 rounded-lg bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : kpisVisiveis.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">Nenhum canal no período selecionado.</Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[...kpisVisiveis]
              .sort((a, b) => Number(b.receita ?? 0) - Number(a.receita ?? 0))
              .map((c) => (
                <CanalCard key={c.canal} data={c} diario={diarioVisivel.filter((d) => d.canal === c.canal)} />
              ))}
          </div>
        )}
      </section>

      {/* 2.4 — Metas */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Metas · {format(parseISO(compAtual), "MMMM", { locale: ptBR })}
          </h2>
          <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
            Configurar <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <MetaReceitaCard data={metaTodos} />
          <MetaMargemCard data={metaTodos} />
          <MetaAcosCard data={metaTodos} />
        </div>
      </section>

      {/* Alertas + Top produtos */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Top produtos por margem líquida</h2>
            <Link to="/produtos-margem" className="text-xs text-primary inline-flex items-center gap-1 hover:underline">
              Ver todos <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {topProdutos.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem dados.</p>
          ) : (
            <ul className="space-y-2">
              {topProdutos.map((p, i) => (
                <li key={`${p.marketplace}-${p.sku}-${i}`} className="flex items-center gap-3 py-1.5 border-b last:border-0">
                  <div className="h-9 w-9 rounded bg-muted overflow-hidden flex items-center justify-center shrink-0">
                    {p.foto ? (
                      <img src={p.foto} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <Package className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate font-medium" title={p.produto ?? p.sku}>
                      {p.produto ?? p.sku}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono">{p.sku} · {p.marketplace}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium tabular-nums">{formatBRL(Number(p.margem_liquida ?? 0), { compact: true })}</div>
                    <div className="text-[11px] text-muted-foreground tabular-nums">{formatPercent(Number(p.margem_liquida_pct ?? 0))}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-warning" />
            Alertas
          </h2>
          <ul className="space-y-2">
            {anomSemCusto.count > 0 && (
              <AlertaItem
                dot="red"
                to="/anomalias"
                text={`${anomSemCusto.count} SKUs sem custo · ${formatBRL(anomSemCusto.receita, { compact: true })}`}
              />
            )}
            {anomCmvMaior.count > 0 && (
              <AlertaItem
                dot="red"
                to="/anomalias"
                text={`${anomCmvMaior.count} pedidos com custo > venda`}
              />
            )}
            {anomSemRecebido.count > 0 && (
              <AlertaItem
                dot="orange"
                to="/anomalias"
                text={`${anomSemRecebido.count} pedidos sem repasse informado`}
              />
            )}
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
                text={`${alertaAcos} anúncios com ACOS > 20% (7 dias)`}
              />
            )}
            {alertaAmazon > 0 && (
              <AlertaItem
                dot="yellow"
                to="/mapeamento-skus"
                text={`${alertaAmazon} SKUs da Amazon sem mapeamento`}
              />
            )}
            {anomSemCusto.count + anomCmvMaior.count + anomSemRecebido.count + alertaPrejuizo + alertaAcos + alertaAmazon === 0 && (
              <li className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" /> Nenhuma pendência.
              </li>
            )}
          </ul>
        </Card>
      </section>
    </div>
  );
}

// ============================================================
// Filtros
// ============================================================
function PeriodoPicker({
  preset,
  onPreset,
  customRange,
  onCustom,
}: {
  preset: PresetKey;
  onPreset: (p: PresetKey) => void;
  customRange: { from: string; to: string } | null;
  onCustom: (r: { from: string; to: string }) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(customRange?.from ?? "");
  const [to, setTo] = useState(customRange?.to ?? "");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          {PRESET_LABEL[preset]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">Período</DropdownMenuLabel>
        {(["hoje", "ontem", "mes_atual", "ult_7", "ult_30", "mes_anterior"] as PresetKey[]).map((p) => (
          <DropdownMenuCheckboxItem
            key={p}
            checked={preset === p}
            onSelect={(e) => { e.preventDefault(); onPreset(p); }}
          >
            {PRESET_LABEL[p]}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <div className="p-2 space-y-2">
          <p className="text-xs text-muted-foreground">Personalizado</p>
          <div className="flex gap-1">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="text-xs border rounded px-2 py-1 flex-1 min-w-0"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="text-xs border rounded px-2 py-1 flex-1 min-w-0"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!from || !to || from > to}
            onClick={() => { onCustom({ from, to }); setCustomOpen(false); }}
          >
            Aplicar
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CanalFilter({
  canais,
  selecionados,
  onChange,
}: {
  canais: string[];
  selecionados: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const todos = selecionados === null;
  const count = todos ? canais.length : selecionados.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          Canais ({todos ? "todos" : count})
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuCheckboxItem
          checked={todos}
          onSelect={(e) => { e.preventDefault(); onChange(null); }}
        >
          Todos os canais
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {canais.map((c) => {
          const on = todos || selecionados?.includes(c);
          return (
            <DropdownMenuCheckboxItem
              key={c}
              checked={!!on}
              onSelect={(e) => {
                e.preventDefault();
                const base = todos ? [...canais] : [...(selecionados ?? [])];
                const next = on ? base.filter((x) => x !== c) : [...base, c];
                onChange(next.length === canais.length ? null : next.length === 0 ? [] : next);
              }}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm mr-2" style={{ background: colorForCanal(c) }} />
              {c}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================
// Canal card
// ============================================================
function CanalCard({ data, diario }: { data: KpiCanal; diario: ReceitaDiaCanal[] }) {
  const cor = colorForCanal(data.canal);
  const receita = Number(data.receita ?? 0);
  const pedidos = Number(data.pedidos ?? 0);
  const margem = Number(data.margem ?? 0);
  const mcPct = Number(data.mc_pct ?? 0);
  const ads = data.ads == null ? null : Number(data.ads);
  const acos = data.acos == null ? null : Number(data.acos);
  const ticket = Number(data.ticket_medio ?? 0);
  const cobertura = data.cobertura_pct == null ? null : Number(data.cobertura_pct);
  const temHistorico = data.receita_ant != null;

  const margemAposAds = ads == null ? margem : margem - ads;
  const margemAposAdsPct = receita > 0 ? (margemAposAds / receita) * 100 : 0;

  const spark = diario
    .slice()
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((d) => ({ data: d.data, receita: Number(d.receita ?? 0) }));

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block h-3 w-3 rounded-sm shrink-0" style={{ background: cor }} />
          <p className="font-medium truncate">{data.canal}</p>
        </div>
        {cobertura != null && cobertura < 95 && (
          <TooltipProvider>
            <UITooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="text-warning border-warning/30 bg-warning/5 gap-1">
                  <Info className="h-3 w-3" /> {cobertura.toFixed(0)}%
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-xs">
                {cobertura.toFixed(0)}% da receita tem custo conhecido — a margem deste canal é parcial.
              </TooltipContent>
            </UITooltip>
          </TooltipProvider>
        )}
      </div>

      <div>
        <div className="flex items-baseline gap-3">
          <p className="text-2xl font-semibold tabular-nums">{formatBRL(receita, { compact: true })}</p>
          <VariacaoInline valor={data.var_receita_pct} temHistorico={temHistorico} altaBoa />
        </div>
        <div className="flex items-baseline gap-3 mt-1">
          <p className="text-sm text-muted-foreground tabular-nums">{formatNumber(pedidos)} pedidos</p>
          <VariacaoInline valor={data.var_pedidos_pct} temHistorico={temHistorico} altaBoa small />
        </div>
      </div>

      {spark.length > 1 && (
        <div className="h-10">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={spark} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
              <Line type="monotone" dataKey="receita" stroke={cor} strokeWidth={1.75} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="space-y-1.5 text-sm">
        <Linha
          label="Margem contrib."
          valor={formatBRL(margem, { compact: true })}
          extra={formatPercent(mcPct)}
        />
        <Linha
          label="ADS"
          valor={ads == null ? "—" : formatBRL(ads, { compact: true })}
          extra={acos == null ? "—" : `ACOS ${formatPercent(acos)}`}
        />
        <div className="border-t pt-2 mt-2">
          <Linha
            label="Margem após ADS"
            valor={formatBRL(margemAposAds, { compact: true })}
            extra={formatPercent(margemAposAdsPct)}
            destaque
            corValor={margemAposAds < 0 ? "text-destructive" : undefined}
          />
        </div>
        <div className="pt-1 space-y-1">
          <Linha label="Ticket médio" valor={formatBRL(ticket)} muted />
          {cobertura != null && (
            <Linha
              label="Cobertura"
              valor={`${cobertura.toFixed(0)}%`}
              muted
              corValor={cobertura < 95 ? "text-warning" : undefined}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

function Linha({
  label,
  valor,
  extra,
  destaque,
  muted,
  corValor,
}: {
  label: string;
  valor: string;
  extra?: string;
  destaque?: boolean;
  muted?: boolean;
  corValor?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className={cn("text-xs", muted ? "text-muted-foreground" : "text-muted-foreground", destaque && "font-medium text-foreground")}>
        {label}
      </span>
      <span className={cn("tabular-nums", destaque ? "font-semibold text-base" : "text-sm", corValor)}>
        {valor}
        {extra && <span className={cn("ml-2 text-xs", destaque ? "text-muted-foreground font-normal" : "text-muted-foreground")}>{extra}</span>}
      </span>
    </div>
  );
}

// ============================================================
// Variações
// ============================================================
function VariacaoInline({
  valor,
  temHistorico,
  altaBoa,
  small,
}: {
  valor: number | null;
  temHistorico: boolean;
  altaBoa: boolean;
  small?: boolean;
}) {
  if (!temHistorico || valor == null) {
    return <span className={cn("text-muted-foreground", small ? "text-[11px]" : "text-xs")}>—</span>;
  }
  const v = Number(valor);
  const subiu = v > 0.05;
  const desceu = v < -0.05;
  const bom = altaBoa ? subiu : desceu;
  const ruim = altaBoa ? desceu : subiu;
  const cls = bom ? "text-success" : ruim ? "text-destructive" : "text-muted-foreground";
  const Icon = subiu ? ArrowUp : desceu ? ArrowDown : null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 font-medium", cls, small ? "text-[11px]" : "text-xs")}>
      {Icon && <Icon className={small ? "h-2.5 w-2.5" : "h-3 w-3"} />}
      {`${v > 0 ? "+" : ""}${v.toFixed(1).replace(".", ",")}%`}
    </span>
  );
}

function VariacaoBadge({
  atual,
  anterior,
  altaBoa,
}: {
  atual: number;
  anterior: number | null;
  altaBoa: boolean;
}) {
  if (anterior == null || anterior === 0) {
    return <Badge variant="outline" className="text-xs text-muted-foreground">Sem comparativo</Badge>;
  }
  const delta = ((atual - anterior) / Math.abs(anterior)) * 100;
  const subiu = delta > 0.05;
  const desceu = delta < -0.05;
  const bom = altaBoa ? subiu : desceu;
  const cls = bom
    ? "bg-success/10 text-success border-success/20"
    : (altaBoa ? desceu : subiu)
    ? "bg-destructive/10 text-destructive border-destructive/20"
    : "bg-muted text-muted-foreground";
  const Icon = subiu ? ArrowUp : desceu ? ArrowDown : null;
  return (
    <Badge variant="outline" className={cn("gap-1 text-xs", cls)}>
      {Icon && <Icon className="h-3 w-3" />}
      {`${delta > 0 ? "+" : ""}${delta.toFixed(1).replace(".", ",")}%`}
      <span className="text-muted-foreground font-normal">vs anterior</span>
    </Badge>
  );
}

function VisaoItem({
  label,
  value,
  atual,
  anterior,
  altaBoa,
}: {
  label: string;
  value: string;
  atual: number;
  anterior: number | null;
  altaBoa: boolean;
}) {
  const temHist = anterior != null && anterior !== 0;
  const delta = temHist ? ((atual - anterior!) / Math.abs(anterior!)) * 100 : null;
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
      <div className="mt-0.5">
        <VariacaoInline valor={delta} temHistorico={temHist} altaBoa={altaBoa} />
      </div>
    </div>
  );
}

// ============================================================
// Metas
// ============================================================
function MetaReceitaCard({ data }: { data: MetaRealizado | null }) {
  const realizado = Number(data?.receita_realizada ?? 0);
  const meta = data?.meta_receita != null ? Number(data.meta_receita) : null;
  const temMeta = meta != null && meta > 0;
  const pct = temMeta ? Number(data?.receita_pct_meta ?? (realizado / meta! * 100)) : 0;
  const cor = temMeta ? (pct >= 100 ? "success" : pct >= 70 ? "warning" : "destructive") : "muted";
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Meta de receita</p>
        <TrendingUp className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="text-2xl font-semibold tabular-nums">{formatBRL(realizado, { compact: true })}</p>
      {temMeta ? (
        <>
          <Progress
            value={Math.min(100, pct)}
            className={cn(
              cor === "destructive" && "[&>div]:bg-destructive",
              cor === "warning" && "[&>div]:bg-warning",
              cor === "success" && "[&>div]:bg-success",
            )}
          />
          <p className="text-xs text-muted-foreground">
            {formatPercent(pct)} da meta · {formatBRL(meta!, { compact: true })}
          </p>
        </>
      ) : (
        <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <Target className="h-3 w-3" /> Definir meta
        </Link>
      )}
    </Card>
  );
}

function MetaMargemCard({ data }: { data: MetaRealizado | null }) {
  const realizado = Number(data?.margem_realizada ?? 0);
  const meta = data?.meta_margem != null ? Number(data.meta_margem) : null;
  const temMeta = meta != null && meta > 0;
  const pct = temMeta ? Number(data?.margem_pct_meta ?? (realizado / meta! * 100)) : 0;
  const cor = temMeta ? (pct >= 100 ? "success" : pct >= 70 ? "warning" : "destructive") : "muted";
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Meta de margem</p>
        <Wallet className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="text-2xl font-semibold tabular-nums">{formatBRL(realizado, { compact: true })}</p>
      {temMeta ? (
        <>
          <Progress
            value={Math.min(100, pct)}
            className={cn(
              cor === "destructive" && "[&>div]:bg-destructive",
              cor === "warning" && "[&>div]:bg-warning",
              cor === "success" && "[&>div]:bg-success",
            )}
          />
          <p className="text-xs text-muted-foreground">
            {formatPercent(pct)} da meta · {formatBRL(meta!, { compact: true })}
          </p>
        </>
      ) : (
        <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <Target className="h-3 w-3" /> Definir meta
        </Link>
      )}
    </Card>
  );
}

function MetaAcosCard({ data }: { data: MetaRealizado | null }) {
  const acos = Number(data?.acos_realizado ?? 0);
  const teto = data?.meta_acos != null ? Number(data.meta_acos) : null;
  const temTeto = teto != null && teto > 0;
  const estourou = data?.acos_estourou === true || (temTeto && acos > teto!);
  const cor: "success" | "warning" | "destructive" | "muted" = !temTeto
    ? "muted"
    : estourou
    ? "destructive"
    : acos / teto! >= 0.85
    ? "warning"
    : "success";
  const textCls = {
    success: "text-success",
    warning: "text-warning",
    destructive: "text-destructive",
    muted: "",
  }[cor];
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Teto de ACOS</p>
        <Megaphone className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className={cn("text-2xl font-semibold tabular-nums", textCls)}>{formatPercent(acos)}</p>
      {temTeto ? (
        <p className="text-xs text-muted-foreground">
          Teto {formatPercent(teto!)}
          {estourou && ` · estourou em ${formatPercent(acos - teto!)}`}
        </p>
      ) : (
        <Link to="/metas" className="text-xs text-primary hover:underline inline-flex items-center gap-1">
          <Target className="h-3 w-3" /> Definir teto
        </Link>
      )}
    </Card>
  );
}

// ============================================================
// Alerta item
// ============================================================
function AlertaItem({
  dot,
  to,
  text,
}: {
  dot: "red" | "orange" | "yellow";
  to: string;
  text: string;
}) {
  const cls = { red: "bg-destructive", orange: "bg-warning", yellow: "bg-yellow-500" }[dot];
  return (
    <li>
      <Link to={to} className="flex items-start gap-2 text-sm hover:underline">
        <span className={cn("inline-block h-2 w-2 rounded-full mt-1.5 shrink-0", cls)} />
        <span className="flex-1">{text}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground mt-1" />
      </Link>
    </li>
  );
}
