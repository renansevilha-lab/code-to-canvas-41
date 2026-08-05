import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
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
import { VendasMargemChart } from "@/components/dashboard/VendasMargemChart";

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

type VisaoGeralRow = {
  vendas: number | null;
  custo_total: number | null;
  margem_contrib: number | null;
  margem_pct: number | null;
  pedidos: number | null;
  produtos: number | null;
  ticket_medio: number | null;
  projecao_vendas: number | null;
  cobertura_pct: number | null;
};

type DiaSerie = { data: string; receita: number; margem: number; pedidos: number };

// Vendas por SKU / Marca (kit destrinchado) — RPCs vendas_por_sku / vendas_por_marca.
type VendaSkuRow = {
  sku: string; nome: string | null; marca: string | null;
  qtd_atual: number; qtd_anterior: number; valor_atual: number; valor_anterior: number;
};
type VendaMarcaRow = {
  marca: string; qtd_atual: number; qtd_anterior: number;
  valor_atual: number; valor_anterior: number; skus: number;
};

// Canais vendidos só via Tiny (Temu, TikTok, ML avulso): sem custo/margem/ADS.
type CanalSemDados = { canal: string; receita: number; pedidos: number };

// Agrupa marca_canal cru (do Tiny) num rótulo amigável.
function nomeCanalTiny(marca: string): string {
  const m = (marca ?? "").toLowerCase();
  if (m.includes("temu")) return "Temu";
  if (m.includes("tiktok")) return "TikTok Shop";
  if (m.includes("shein")) return "Shein";
  if (m.includes("mercado livre") || m.startsWith("ml_") || m.includes("[svll]"))
    return "Mercado Livre (não integrado)";
  return marca;
}

// ============================================================
// Period presets
// ============================================================
type PresetKey = "hoje" | "ontem" | "mes_atual" | "ult_7" | "ult_30" | "mes_anterior" | "custom";

// YYYY-MM-DD no fuso America/Sao_Paulo (independente do fuso do browser/servidor)
const spKey = (d: Date) =>
  d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
// Ancora YYYY-MM-DD às 12:00 UTC para aritmética de datas sem drift
const spAnchor = (key: string) => new Date(`${key}T12:00:00Z`);
const spToday = () => spAnchor(spKey(new Date()));

function computeRange(preset: PresetKey, custom?: { from: string; to: string }): { from: string; to: string } {
  const today = spToday();
  const ymd = (d: Date) => spKey(d);
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

const PRESET_CURTO: Partial<Record<PresetKey, string>> = {
  hoje: "Hoje",
  ontem: "Ontem",
  mes_atual: "Mês",
  ult_7: "7 dias",
  ult_30: "30 dias",
};
const QUICK_PRESETS: PresetKey[] = ["hoje", "ontem", "mes_atual", "ult_7", "ult_30"];

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

// Pontos de uma sparkline (viewBox 0 0 120 30) a partir de uma série numérica.
function sparkPoints(vals: number[]): string {
  const v = vals.filter((n) => Number.isFinite(n));
  if (v.length < 2) return "";
  const mn = Math.min(...v);
  const mx = Math.max(...v);
  const r = mx - mn || 1;
  const stepX = 120 / (v.length - 1);
  return v
    .map((n, i) => `${(i * stepX).toFixed(1)},${(28 - ((n - mn) / r) * 26).toFixed(1)}`)
    .join(" ");
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
  const [serieDiaria, setSerieDiaria] = useState<DiaSerie[]>([]);
  const [metas, setMetas] = useState<MetaRealizado[]>([]);
  const [topProdutos, setTopProdutos] = useState<ProdutoRow[]>([]);
  const [vendasSku, setVendasSku] = useState<VendaSkuRow[]>([]);
  const [vendasMarca, setVendasMarca] = useState<VendaMarcaRow[]>([]);
  const [alertaAcos, setAlertaAcos] = useState(0);
  const [alertaAmazon, setAlertaAmazon] = useState(0);
  const [anomSemCusto, setAnomSemCusto] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomCmvMaior, setAnomCmvMaior] = useState<{ count: number; receita: number }>({ count: 0, receita: 0 });
  const [anomSemRecebido, setAnomSemRecebido] = useState<{ count: number }>({ count: 0 });
  const [alertaPrejuizo, setAlertaPrejuizo] = useState(0);
  const [visaoGeral, setVisaoGeral] = useState<VisaoGeralRow | null>(null);
  const [canaisSemDados, setCanaisSemDados] = useState<CanalSemDados[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [atualizadoEm, setAtualizadoEm] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);

  const compAtual = useMemo(() => spKey(startOfMonth(spToday())), []);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);

    (async () => {
      try {
        // Período anterior (mesmo nº de dias, imediatamente antes) — em SP tz
        const dFrom = spAnchor(range.from);
        const dTo = spAnchor(range.to);
        const nDias = differenceInCalendarDays(dTo, dFrom) + 1;
        const prevTo = spKey(subDays(dFrom, 1));
        const prevFrom = spKey(subDays(dFrom, nDias));

        const canaisQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,marketplace,shop_id,data,pedidos,receita,receita_com_custo,cmv,margem,ads")
          .gte("data", range.from)
          .lte("data", range.to);

        const canaisPrevQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,shop_id,pedidos,receita,margem")
          .gte("data", prevFrom)
          .lte("data", prevTo);

        const metasQ = supabaseExternal
          .from("view_metas_realizado")
          .select("*")
          .eq("competencia", compAtual);

        const produtosQ = supabaseExternal
          .from("view_produtos_dashboard")
          .select("marketplace,sku,produto,foto,receita,gasto_ads,margem_liquida,margem_liquida_pct,vira_prejuizo_com_ads,confiavel")
          .limit(2000);

        // Alerta ACOS: view_ads_resumo já classifica cada anúncio por ROAS
        // (agregado no servidor). Contamos os anúncios classificados como "ruim"
        // em vez de somar milhares de linhas de view_shopee_ads_anuncios.
        const acosQ = supabaseExternal
          .from("view_ads_resumo")
          .select("classificacao_roas,anuncios")
          .eq("classificacao_roas", "ruim");

        const amazonQ = supabaseExternal
          .from("view_amazon_skus_mapear")
          .select("sem_cadastro,tem_mapeamento")
          .eq("sem_cadastro", true);

        const anomsQ = supabaseExternal
          .from("view_anomalias")
          .select("tipo, receita")
          .in("tipo", ["sku_sem_custo", "cmv_maior_que_receita", "sem_recebido"])
          .limit(20000);

        const visaoQ = supabaseExternal.rpc("dashboard_visao_geral", {
          data_inicial: range.from,
          data_final: range.to,
        });

        // Vendas por SKU / Marca (kit destrinchado) — cálculo no banco.
        const vendasSkuQ = supabaseExternal.rpc("vendas_por_sku", {
          data_inicial: range.from,
          data_final: range.to,
        });
        const vendasMarcaQ = supabaseExternal.rpc("vendas_por_marca", {
          data_inicial: range.from,
          data_final: range.to,
        });

        // Canais só-Tiny (sem custo/margem) — exibidos à parte, fora do total geral.
        const canaisSemQ = supabaseExternal
          .from("view_canais_sem_integracao")
          .select("marca_canal,pedidos,receita")
          .gte("data", range.from)
          .lte("data", range.to);

        const [canaisR, canaisPrevR, met, prod, acos, am, anoms, visao, canaisSem, vsku, vmarca] = await Promise.all([
          canaisQ, canaisPrevQ, metasQ, produtosQ, acosQ, amazonQ, anomsQ, visaoQ, canaisSemQ, vendasSkuQ, vendasMarcaQ,
        ]);
        if (cancel) return;

        if (!vsku.error) setVendasSku((vsku.data ?? []) as VendaSkuRow[]);
        else console.warn("vendas_por_sku →", vsku.error);
        if (!vmarca.error) setVendasMarca((vmarca.data ?? []) as VendaMarcaRow[]);
        else console.warn("vendas_por_marca →", vmarca.error);

        if (!canaisSem.error) {
          const rows = (canaisSem.data ?? []) as { marca_canal: string; pedidos: number | null; receita: number | null }[];
          const agg = new Map<string, CanalSemDados>();
          for (const r of rows) {
            const canal = nomeCanalTiny(r.marca_canal);
            const cur = agg.get(canal) ?? { canal, receita: 0, pedidos: 0 };
            cur.receita += Number(r.receita ?? 0);
            cur.pedidos += Number(r.pedidos ?? 0);
            agg.set(canal, cur);
          }
          setCanaisSemDados(
            Array.from(agg.values()).sort((a, b) => b.receita - a.receita),
          );
        }

        if (!visao.error) {
          const row = Array.isArray(visao.data) ? (visao.data as VisaoGeralRow[])[0] : (visao.data as VisaoGeralRow | null);
          setVisaoGeral(row ?? null);
        } else {
          console.warn("dashboard_visao_geral →", visao.error);
          setVisaoGeral(null);
        }

        if (canaisR.error) setErro(`view_canais_diario: ${canaisR.error.message}`);

        type CanalRow = {
          canal: string; marketplace: string; shop_id: string | null; data: string;
          pedidos: number | null; receita: number | null; receita_com_custo: number | null;
          cmv: number | null; margem: number | null; ads: number | null;
        };
        type CanalPrevRow = {
          canal: string; shop_id: string | null;
          pedidos: number | null; receita: number | null; margem: number | null;
        };

        const rows = (canaisR.data ?? []) as CanalRow[];
        const rowsPrev = (canaisPrevR.data ?? []) as CanalPrevRow[];

        // Série diária (soma de todos os canais por dia) — base das sparklines
        const porDia = new Map<string, DiaSerie>();
        for (const r of rows) {
          const cur = porDia.get(r.data) ?? { data: r.data, receita: 0, margem: 0, pedidos: 0 };
          cur.receita += Number(r.receita ?? 0);
          cur.margem += Number(r.margem ?? 0);
          cur.pedidos += Number(r.pedidos ?? 0);
          porDia.set(r.data, cur);
        }
        setSerieDiaria(Array.from(porDia.values()).sort((a, b) => (a.data < b.data ? -1 : 1)));

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
        const aggPrev = new Map<string, { pedidos: number; receita: number; margem: number }>();
        for (const r of rowsPrev) {
          const key = `${r.canal}|${r.shop_id ?? ""}`;
          const cur = aggPrev.get(key) ?? { pedidos: 0, receita: 0, margem: 0 };
          cur.pedidos += Number(r.pedidos ?? 0);
          cur.receita += Number(r.receita ?? 0);
          cur.margem += Number(r.margem ?? 0);
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

        setKpisCanal(kpiRows);
        if (!met.error) setMetas((met.data ?? []) as MetaRealizado[]);

        if (!prod.error) {
          const produtos = (prod.data ?? []) as ProdutoRow[];
          const confiaveis = produtos.filter((p) => p.confiavel !== false);
          setTopProdutos(
            confiaveis
              .sort((a, b) => Number(b.margem_liquida ?? 0) - Number(a.margem_liquida ?? 0))
              .slice(0, 6),
          );
          setAlertaPrejuizo(produtos.filter((p) => p.vira_prejuizo_com_ads).length);
        }

        if (!acos.error) {
          const rows = (acos.data ?? []) as { classificacao_roas: string; anuncios: number | null }[];
          const n = rows.reduce((s, r) => s + Number(r.anuncios ?? 0), 0);
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

  // Deltas globais (todos os canais): soma dos absolutos atual vs anterior.
  const deltas = useMemo(() => {
    let r = 0, m = 0, p = 0, ra = 0, ma = 0, pa = 0;
    for (const k of kpisCanal) {
      r += k.receita; m += k.margem; p += k.pedidos;
      ra += k.receita_ant ?? 0; ma += k.margem_ant ?? 0; pa += k.pedidos_ant ?? 0;
    }
    const rel = (c: number, pv: number) => (pv ? ((c - pv) / Math.abs(pv)) * 100 : null);
    const mcCur = r > 0 ? (m / r) * 100 : null;
    const mcAnt = ra > 0 ? (ma / ra) * 100 : null;
    return {
      receita: rel(r, ra),
      margem: rel(m, ma),
      pedidos: rel(p, pa),
      mcPp: mcCur != null && mcAnt != null ? mcCur - mcAnt : null,
      temHistorico: ra > 0 || ma > 0 || pa > 0,
    };
  }, [kpisCanal]);

  const diasPeriodo = differenceInCalendarDays(parseISO(range.to), parseISO(range.from)) + 1;

  // Metas
  const metaTodos = metas.find((m) => m.marketplace === "todos") ?? null;

  // Hero KPIs — valor da RPC (fonte única) + delta/sparkline da série diária.
  const vendas = Number(visaoGeral?.vendas ?? 0);
  const margemContrib = Number(visaoGeral?.margem_contrib ?? 0);
  const mcPct = visaoGeral?.margem_pct != null ? Number(visaoGeral.margem_pct) : null;
  const pedidosTot = Number(visaoGeral?.pedidos ?? 0);
  const ticket = Number(visaoGeral?.ticket_medio ?? 0);
  const cobertura = visaoGeral?.cobertura_pct != null ? Number(visaoGeral.cobertura_pct) : null;
  const projecao = visaoGeral?.projecao_vendas != null ? Number(visaoGeral.projecao_vendas) : null;

  const heroKpis: HeroKpiData[] = [
    {
      label: "Receita líquida",
      value: formatBRL(vendas, { compact: true }),
      delta: deltas.receita, deltaKind: "rel", temHistorico: deltas.temHistorico,
      color: "var(--color-primary)",
      sub: preset === "mes_atual" && projecao != null
        ? `Projeção ${formatBRL(projecao, { compact: true })}`
        : `Ticket ${formatBRL(ticket, { compact: true })}`,
      spark: sparkPoints(serieDiaria.map((s) => s.receita)),
    },
    {
      label: "Margem de contribuição",
      value: formatBRL(margemContrib, { compact: true }),
      delta: deltas.margem, deltaKind: "rel", temHistorico: deltas.temHistorico,
      color: "var(--color-success)",
      sub: mcPct != null ? `MC ${formatPercent(mcPct)}` : "Após CMV, taxas e frete",
      spark: sparkPoints(serieDiaria.map((s) => s.margem)),
    },
    {
      label: "MC% média",
      value: mcPct != null ? formatPercent(mcPct) : "—",
      delta: deltas.mcPp, deltaKind: "pp", temHistorico: deltas.temHistorico,
      color: "var(--color-warning)",
      sub: cobertura != null ? `Cobertura ${cobertura.toFixed(0)}%` : "Sobre a base coberta",
      subAlerta: cobertura != null && cobertura < 90,
      spark: sparkPoints(serieDiaria.map((s) => (s.receita > 0 ? (s.margem / s.receita) * 100 : 0))),
    },
    {
      label: "Pedidos",
      value: formatNumber(pedidosTot),
      delta: deltas.pedidos, deltaKind: "rel", temHistorico: deltas.temHistorico,
      color: "var(--color-chart-4)",
      sub: `Ticket ${formatBRL(ticket, { compact: true })}`,
      spark: sparkPoints(serieDiaria.map((s) => s.pedidos)),
    },
  ];

  // Anomalias (para o painel) — derivadas dos alertas existentes.
  const anomalias: AnomaliaData[] = [];
  if (anomSemCusto.count > 0)
    anomalias.push({ cor: "destructive", to: "/anomalias", titulo: `${anomSemCusto.count} SKUs sem custo cadastrado`, detalhe: `${formatBRL(anomSemCusto.receita, { compact: true })} de receita sem CMV apurado` });
  if (anomCmvMaior.count > 0)
    anomalias.push({ cor: "destructive", to: "/anomalias", titulo: `${anomCmvMaior.count} pedidos com custo maior que a venda`, detalhe: "Margem negativa — revisar cadastro ou preço" });
  if (alertaPrejuizo > 0)
    anomalias.push({ cor: "destructive", to: "/produtos-margem", titulo: `${alertaPrejuizo} produtos ficam negativos com o ADS`, detalhe: "O gasto de anúncio come toda a margem" });
  if (anomSemRecebido.count > 0)
    anomalias.push({ cor: "warning", to: "/anomalias", titulo: `${anomSemRecebido.count} pedidos sem repasse informado`, detalhe: "Aguardando conciliação do marketplace" });
  if (alertaAcos > 0)
    anomalias.push({ cor: "warning", to: "/ads-shopee", titulo: `${alertaAcos} anúncios com ROAS ruim`, detalhe: "Classificados como abaixo do alvo (30 dias)" });
  if (alertaAmazon > 0)
    anomalias.push({ cor: "amber", to: "/mapeamento-skus", titulo: `${alertaAmazon} SKUs da Amazon sem mapeamento`, detalhe: "Sem custo até vincular ao SKU interno" });

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-[18px]">
      {/* Barra de filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-[13px] text-muted-foreground font-medium tabular-nums">
          {format(parseISO(range.from), "dd MMM", { locale: ptBR })} – {format(parseISO(range.to), "dd MMM yyyy", { locale: ptBR })}
          <span className="opacity-60"> · {diasPeriodo} {diasPeriodo === 1 ? "dia" : "dias"}</span>
        </div>
        <div className="flex-1" />
        {/* Segmentado de período (atalhos) */}
        <div className="flex items-center gap-1 bg-card border border-border rounded-[10px] p-[3px]">
          {QUICK_PRESETS.map((p) => (
            <button
              key={p}
              onClick={() => { setPreset(p); setCustomRange(null); }}
              className={cn(
                "text-[12.5px] font-medium px-3 py-1.5 rounded-[7px] transition-colors",
                preset === p ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {PRESET_CURTO[p]}
            </button>
          ))}
          <PeriodoPicker
            preset={preset}
            onPreset={(p) => { setPreset(p); if (p !== "custom") setCustomRange(null); }}
            customRange={customRange}
            onCustom={(r) => { setCustomRange(r); setPreset("custom"); }}
          />
        </div>
        <CanalFilter canais={canaisDisponiveis} selecionados={canaisFiltro} onChange={setCanaisFiltro} />
        <Button variant="outline" size="sm" onClick={() => setTick((x) => x + 1)} disabled={loading} className="gap-2">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {erro && (
        <Card className="p-4 border-destructive/30 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Erro ao carregar dashboard</p>
          <p className="text-xs text-muted-foreground mt-1">{erro}</p>
        </Card>
      )}

      {/* Hero KPIs */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-[14px]">
        {heroKpis.map((k) => (
          <HeroKpi key={k.label} data={k} loading={loading && !visaoGeral} />
        ))}
      </div>

      {/* Gráfico + Contribuição por canal */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.75fr_1fr] gap-4 items-start">
        <VendasMargemChart range={range} isMesAtual={preset === "mes_atual"} />
        <ContribuicaoCanalPanel canais={kpisVisiveis} loading={loading && kpisVisiveis.length === 0} />
      </div>

      {/* Top SKUs · Anomalias · Metas */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <TopSkusPanel produtos={topProdutos} />
        <AnomaliasPanel anomalias={anomalias} />
        <MetasPanel data={metaTodos} competencia={compAtual} />
      </div>

      {/* Vendas por produto (kit destrinchado) */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-4 items-start">
        <VendasSkuPanel rows={vendasSku} loading={loading && vendasSku.length === 0} />
        <VendasMarcaPanel rows={vendasMarca} loading={loading && vendasMarca.length === 0} />
      </div>

      {/* Desempenho por canal (detalhado) */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">Desempenho por canal</h2>
        </div>
        {loading && kpisVisiveis.length === 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-56 rounded-[14px] bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : kpisVisiveis.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">Nenhum canal no período selecionado.</Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[...kpisVisiveis]
              .sort((a, b) => Number(b.receita ?? 0) - Number(a.receita ?? 0))
              .map((c) => (
                <CanalCard key={c.canal} data={c} />
              ))}
          </div>
        )}
      </section>

      {/* Canais sem dados integrados (Temu, TikTok, ML avulso) — fora do total geral */}
      {canaisSemDados.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
              Canais sem dados integrados
            </h2>
            <p className="text-[12px] text-muted-foreground">
              Vendas informadas pelo Tiny, sem custo/margem/ADS no sistema — não entram no total acima.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {canaisSemDados.map((c) => (
              <Card key={c.canal} className="p-5 flex flex-col gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="inline-block h-3 w-3 rounded-sm shrink-0 bg-muted-foreground/40" />
                  <p className="font-medium truncate" title={c.canal}>{c.canal}</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">{formatBRL(c.receita, { compact: true })}</p>
                <p className="text-sm text-muted-foreground tabular-nums">{formatNumber(c.pedidos)} pedidos</p>
                <Badge variant="outline" className="w-fit text-muted-foreground gap-1 mt-1">
                  <Info className="h-3 w-3" /> Sem margem
                </Badge>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ============================================================
// Hero KPI
// ============================================================
type HeroKpiData = {
  label: string;
  value: string;
  delta: number | null;
  deltaKind: "rel" | "pp";
  temHistorico: boolean;
  color: string;
  sub: string;
  subAlerta?: boolean;
  spark: string;
};

function HeroKpi({ data, loading }: { data: HeroKpiData; loading: boolean }) {
  const { label, value, delta, deltaKind, temHistorico, color, sub, subAlerta, spark } = data;
  const positivo = delta != null && delta >= 0.05;
  const negativo = delta != null && delta <= -0.05;
  const deltaCls = positivo ? "text-success" : negativo ? "text-destructive" : "text-muted-foreground";
  const deltaTxt =
    !temHistorico || delta == null
      ? "—"
      : `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toFixed(1).replace(".", ",")}${deltaKind === "pp" ? " pp" : "%"}`;

  return (
    <Card className="relative overflow-hidden p-0">
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: color }} />
      <div className="p-5 pl-6 flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-semibold text-muted-foreground">{label}</span>
          <span className={cn("text-[11.5px] font-semibold font-mono", deltaCls)}>{deltaTxt}</span>
        </div>
        {loading ? (
          <div className="h-8 w-28 rounded bg-muted/50 animate-pulse" />
        ) : (
          <div className="text-[30px] font-semibold tracking-[-0.035em] tabular-nums leading-none">{value}</div>
        )}
        <div className="flex items-end justify-between gap-3">
          <span className={cn("text-[11.5px] font-medium", subAlerta ? "text-warning" : "text-muted-foreground")}>{sub}</span>
          {spark && (
            <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="w-[110px] h-[30px] overflow-visible shrink-0">
              <polyline
                points={spark}
                fill="none"
                stroke={color}
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Contribuição por canal
// ============================================================
function ContribuicaoCanalPanel({ canais, loading }: { canais: KpiCanal[]; loading: boolean }) {
  const ordenados = useMemo(
    () => [...canais].sort((a, b) => Number(b.margem ?? 0) - Number(a.margem ?? 0)),
    [canais],
  );
  const totalMargemPos = ordenados.reduce((s, c) => s + Math.max(0, Number(c.margem ?? 0)), 0);

  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Contribuição por canal</div>
        <div className="text-[12px] text-muted-foreground">Participação na margem do período</div>
      </div>

      {loading ? (
        <div className="h-40 rounded bg-muted/40 animate-pulse" />
      ) : ordenados.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem canais no período.</p>
      ) : (
        <>
          <div className="flex h-2.5 rounded-md overflow-hidden gap-0.5">
            {ordenados.map((c) => {
              const w = totalMargemPos > 0 ? (Math.max(0, Number(c.margem ?? 0)) / totalMargemPos) * 100 : 0;
              if (w <= 0) return null;
              return <div key={c.canal} style={{ width: `${w}%`, background: colorForCanal(c.canal) }} />;
            })}
          </div>
          <div className="flex flex-col">
            {ordenados.map((c) => {
              const mc = Number(c.mc_pct ?? 0);
              const mcCls = mc >= 16 ? "text-success" : mc >= 12 ? "text-warning" : "text-destructive";
              return (
                <div
                  key={c.canal}
                  className="grid grid-cols-[10px_1fr_auto_52px] items-center gap-2.5 py-[11px] border-b border-border last:border-0"
                >
                  <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: colorForCanal(c.canal) }} />
                  <span className="text-[13px] font-medium truncate" title={c.canal}>{c.canal}</span>
                  <span className="text-[12.5px] text-muted-foreground font-mono tabular-nums">
                    {formatBRL(Number(c.receita ?? 0), { compact: true })}
                  </span>
                  <span className={cn("text-[12.5px] font-semibold font-mono tabular-nums text-right", mcCls)}>
                    {formatPercent(mc)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

// ============================================================
// Top SKUs por margem
// ============================================================
function TopSkusPanel({ produtos }: { produtos: ProdutoRow[] }) {
  const maxMargem = produtos.reduce((m, p) => Math.max(m, Number(p.margem_liquida ?? 0)), 0) || 1;
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Top SKUs por margem</div>
          <div className="text-[12px] text-muted-foreground">Lucro líquido no período</div>
        </div>
        <Link to="/produtos-margem" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 shrink-0">
          Ver todos <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {produtos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem dados.</p>
      ) : (
        <div className="flex flex-col gap-3.5">
          {produtos.map((p, i) => {
            const margem = Number(p.margem_liquida ?? 0);
            const w = Math.max(2, (margem / maxMargem) * 100);
            return (
              <div key={`${p.marketplace}-${p.sku}-${i}`} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12.5px] font-medium truncate" title={p.produto ?? p.sku}>{p.produto ?? p.sku}</span>
                  <span className="text-[12.5px] font-semibold font-mono tabular-nums shrink-0">
                    {formatBRL(margem, { compact: true })}
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                    <div className="h-full rounded bg-primary" style={{ width: `${w}%` }} />
                  </div>
                  <span className="text-[11px] text-muted-foreground font-mono w-11 text-right tabular-nums">
                    {formatPercent(Number(p.margem_liquida_pct ?? 0))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Vendas por SKU (kit destrinchado)
// ============================================================
function QtdDelta({ atual, anterior }: { atual: number; anterior: number }) {
  const up = anterior > 0 && atual > anterior;
  const down = anterior > 0 && atual < anterior;
  return (
    <span className="inline-flex items-center gap-0.5 justify-end">
      {up && <ArrowUp className="h-3 w-3 text-success" />}
      {down && <ArrowDown className="h-3 w-3 text-destructive" />}
      {formatNumber(atual)}
    </span>
  );
}

function VendasSkuPanel({ rows, loading }: { rows: VendaSkuRow[]; loading: boolean }) {
  const [aberto, setAberto] = useState(false);
  const LIMITE = 15;
  const visiveis = aberto ? rows : rows.slice(0, LIMITE);
  const totalValor = rows.reduce((s, r) => s + Number(r.valor_atual ?? 0), 0);
  const totalUnid = rows.reduce((s, r) => s + Number(r.qtd_atual ?? 0), 0);
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Vendas por SKU</div>
          <div className="text-[12px] text-muted-foreground">Unidades reais, com kits destrinchados</div>
        </div>
        {!loading && rows.length > 0 && (
          <div className="text-right shrink-0">
            <div className="text-[13px] font-semibold font-mono tabular-nums">{formatBRL(totalValor, { compact: true })}</div>
            <div className="text-[11px] text-muted-foreground font-mono tabular-nums">
              {formatNumber(totalUnid)} un · {rows.length} SKUs
            </div>
          </div>
        )}
      </div>
      {loading ? (
        <div className="h-64 rounded bg-muted/40 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem vendas no período.</p>
      ) : (
        <>
          <div className={cn("overflow-x-auto -mx-1", aberto && "max-h-[520px] overflow-y-auto")}>
            <table className="w-full text-sm">
              <thead className={cn("text-[11px] text-muted-foreground", aberto && "sticky top-0 bg-card z-10")}>
                <tr className="border-b border-border">
                  <th className="text-left font-medium pb-2 px-1">Produto</th>
                  <th className="text-right font-medium pb-2 px-1 w-14">Ant.</th>
                  <th className="text-right font-medium pb-2 px-1 w-16">Atual</th>
                  <th className="text-right font-medium pb-2 px-1 w-24">Valor</th>
                </tr>
              </thead>
              <tbody>
                {visiveis.map((r) => (
                  <tr key={r.sku} className="border-b border-border last:border-0">
                    <td className="py-2 px-1 min-w-0">
                      <div className="truncate max-w-[300px] text-[12.5px] font-medium" title={r.nome ?? r.sku}>
                        {r.nome ?? r.sku}
                      </div>
                      <div className="text-[10.5px] text-muted-foreground font-mono">
                        {r.sku}{r.marca && r.marca !== "(sem marca)" ? ` · ${r.marca}` : ""}
                      </div>
                    </td>
                    <td className="py-2 px-1 text-right tabular-nums text-muted-foreground font-mono">
                      {formatNumber(Number(r.qtd_anterior ?? 0))}
                    </td>
                    <td className="py-2 px-1 text-right tabular-nums font-mono font-medium">
                      <QtdDelta atual={Number(r.qtd_atual ?? 0)} anterior={Number(r.qtd_anterior ?? 0)} />
                    </td>
                    <td className="py-2 px-1 text-right tabular-nums font-mono font-semibold">
                      {formatBRL(Number(r.valor_atual ?? 0), { compact: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > LIMITE && (
            <button
              onClick={() => setAberto((v) => !v)}
              className="text-[12px] text-primary hover:underline font-medium inline-flex items-center gap-1 self-start"
            >
              {aberto ? "Ver menos" : `Ver todos (${rows.length})`}
              {aberto ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ============================================================
// Vendas por Marca (kit destrinchado)
// ============================================================
function VendasMarcaPanel({ rows, loading }: { rows: VendaMarcaRow[]; loading: boolean }) {
  const [aberto, setAberto] = useState(false);
  const LIMITE = 10;
  const visiveis = aberto ? rows : rows.slice(0, LIMITE);
  const maxValor = rows.reduce((m, r) => Math.max(m, Number(r.valor_atual ?? 0)), 0) || 1;
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Vendas por marca</div>
          <div className="text-[12px] text-muted-foreground">Receita do período (kits destrinchados)</div>
        </div>
        {!loading && rows.length > 0 && (
          <div className="text-[11px] text-muted-foreground font-mono tabular-nums shrink-0">{rows.length} marcas</div>
        )}
      </div>
      {loading ? (
        <div className="h-64 rounded bg-muted/40 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sem vendas no período.</p>
      ) : (
        <>
          <div className={cn("flex flex-col gap-3", aberto && "max-h-[520px] overflow-y-auto pr-1")}>
            {visiveis.map((r) => {
              const w = Math.max(2, (Number(r.valor_atual ?? 0) / maxValor) * 100);
              return (
                <div key={r.marca} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[12.5px] font-medium truncate" title={r.marca}>{r.marca}</span>
                    <span className="text-[12.5px] font-semibold font-mono tabular-nums shrink-0">
                      {formatBRL(Number(r.valor_atual ?? 0), { compact: true })}
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="flex-1 h-1.5 rounded bg-muted overflow-hidden">
                      <div className="h-full rounded bg-primary" style={{ width: `${w}%` }} />
                    </div>
                    <span className="text-[11px] text-muted-foreground font-mono w-20 text-right tabular-nums">
                      <QtdDelta atual={Number(r.qtd_atual ?? 0)} anterior={Number(r.qtd_anterior ?? 0)} /> un
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {rows.length > LIMITE && (
            <button
              onClick={() => setAberto((v) => !v)}
              className="text-[12px] text-primary hover:underline font-medium inline-flex items-center gap-1 self-start"
            >
              {aberto ? "Ver menos" : `Ver todas (${rows.length})`}
              {aberto ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            </button>
          )}
        </>
      )}
    </Card>
  );
}

// ============================================================
// Anomalias detectadas
// ============================================================
type AnomaliaData = { cor: "destructive" | "warning" | "amber"; to: string; titulo: string; detalhe: string };

function AnomaliasPanel({ anomalias }: { anomalias: AnomaliaData[] }) {
  const dotCls = { destructive: "bg-destructive", warning: "bg-warning", amber: "bg-yellow-500" };
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Anomalias detectadas</div>
          <div className="text-[12px] text-muted-foreground">Pendências que afetam a margem</div>
        </div>
        {anomalias.length > 0 && (
          <span className="bg-destructive/10 text-destructive text-[11px] font-semibold px-2.5 py-1 rounded-full tabular-nums">
            {anomalias.length}
          </span>
        )}
      </div>
      {anomalias.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-success py-2">
          <CheckCircle2 className="h-4 w-4" /> Nenhuma pendência.
        </div>
      ) : (
        <div className="flex flex-col">
          {anomalias.map((a, i) => (
            <Link
              key={i}
              to={a.to}
              className="flex gap-3 py-[11px] border-b border-border last:border-0 group"
            >
              <span className={cn("h-[7px] w-[7px] rounded-full mt-[5px] shrink-0", dotCls[a.cor])} />
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[12.5px] font-medium leading-snug group-hover:text-primary transition-colors">{a.titulo}</span>
                <span className="text-[11.5px] text-muted-foreground leading-snug">{a.detalhe}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Metas do mês
// ============================================================
function MetasPanel({ data, competencia }: { data: MetaRealizado | null; competencia: string }) {
  const linhas: MetaLinhaData[] = [];

  const recReal = Number(data?.receita_realizada ?? 0);
  const recMeta = data?.meta_receita != null ? Number(data.meta_receita) : null;
  if (recMeta && recMeta > 0) {
    const pct = Number(data?.receita_pct_meta ?? (recReal / recMeta) * 100);
    const noRitmo =
      data?.meta_receita_diaria != null && data?.receita_media_diaria != null
        ? Number(data.receita_media_diaria) >= Number(data.meta_receita_diaria)
        : null;
    linhas.push({
      nome: "Receita",
      atual: formatBRL(recReal, { compact: true }),
      alvo: formatBRL(recMeta, { compact: true }),
      pct,
      ritmo: noRitmo == null ? "" : noRitmo ? "No ritmo" : "Atrás do plano",
      ritmoBom: noRitmo,
      color: "var(--color-primary)",
    });
  }

  const mgReal = Number(data?.margem_realizada ?? 0);
  const mgMeta = data?.meta_margem != null ? Number(data.meta_margem) : null;
  if (mgMeta && mgMeta > 0) {
    const pct = Number(data?.margem_pct_meta ?? (mgReal / mgMeta) * 100);
    linhas.push({
      nome: "Margem de contribuição",
      atual: formatBRL(mgReal, { compact: true }),
      alvo: formatBRL(mgMeta, { compact: true }),
      pct,
      ritmo: pct >= 100 ? "Acima do plano" : "",
      ritmoBom: pct >= 100 ? true : null,
      color: "var(--color-success)",
    });
  }

  const acos = Number(data?.acos_realizado ?? 0);
  const teto = data?.meta_acos != null ? Number(data.meta_acos) : null;
  if (teto && teto > 0) {
    const pct = (acos / teto) * 100;
    const estourou = data?.acos_estourou === true || acos > teto;
    linhas.push({
      nome: "ACOS (teto)",
      atual: formatPercent(acos),
      alvo: formatPercent(teto),
      pct,
      ritmo: estourou ? "Estourou" : "Dentro do teto",
      ritmoBom: !estourou,
      color: estourou ? "var(--color-destructive)" : "var(--color-warning)",
      invertido: true,
    });
  }

  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="text-[14.5px] font-semibold tracking-[-0.015em]">
            Metas · {format(parseISO(competencia), "MMMM", { locale: ptBR })}
          </div>
          <div className="text-[12px] text-muted-foreground">Progresso vs. objetivo</div>
        </div>
        <Link to="/metas" className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 shrink-0">
          Configurar <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {linhas.length === 0 ? (
        <Link to="/metas" className="text-sm text-primary hover:underline inline-flex items-center gap-1.5">
          <Target className="h-4 w-4" /> Definir metas do mês
        </Link>
      ) : (
        <div className="flex flex-col gap-4">
          {linhas.map((l) => (
            <MetaLinha key={l.nome} data={l} />
          ))}
        </div>
      )}
    </Card>
  );
}

type MetaLinhaData = {
  nome: string;
  atual: string;
  alvo: string;
  pct: number;
  ritmo: string;
  ritmoBom: boolean | null;
  color: string;
  invertido?: boolean;
};

function MetaLinha({ data }: { data: MetaLinhaData }) {
  const { nome, atual, alvo, pct, ritmo, ritmoBom, color, invertido } = data;
  const w = Math.min(100, Math.max(0, pct));
  const ritmoCls = ritmoBom == null ? "text-muted-foreground" : ritmoBom ? "text-success" : "text-destructive";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="text-[12.5px] font-medium">{nome}</span>
        <span className="text-[12px] text-muted-foreground font-mono tabular-nums">
          {atual} / {alvo}
        </span>
      </div>
      <div className="h-2 rounded-md bg-muted overflow-hidden">
        <div className="h-full rounded-md" style={{ width: `${w}%`, background: color }} />
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>
          {pct.toFixed(0).replace(".", ",")}% {invertido ? "do teto" : "atingido"}
        </span>
        {ritmo && <span className={cn("font-medium", ritmoCls)}>{ritmo}</span>}
      </div>
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
  const [from, setFrom] = useState(customRange?.from ?? "");
  const [to, setTo] = useState(customRange?.to ?? "");
  const especial = preset === "mes_anterior" || preset === "custom";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "text-[12.5px] font-medium px-3 py-1.5 rounded-[7px] transition-colors",
            especial ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {especial ? PRESET_LABEL[preset] : "Mais"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">Período</DropdownMenuLabel>
        {(["mes_anterior"] as PresetKey[]).map((p) => (
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
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-xs border rounded px-2 py-1 flex-1 min-w-0" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-xs border rounded px-2 py-1 flex-1 min-w-0" />
          </div>
          <Button size="sm" className="w-full" disabled={!from || !to || from > to} onClick={() => onCustom({ from, to })}>
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
        <DropdownMenuCheckboxItem checked={todos} onSelect={(e) => { e.preventDefault(); onChange(null); }}>
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
// Canal card (detalhado)
// ============================================================
function CanalCard({ data }: { data: KpiCanal }) {
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

      <div className="space-y-1.5 text-sm">
        <Linha label="Margem contrib." valor={formatBRL(margem, { compact: true })} extra={formatPercent(mcPct)} />
        <Linha label="ADS" valor={ads == null ? "—" : formatBRL(ads, { compact: true })} extra={acos == null ? "—" : `ACOS ${formatPercent(acos)}`} />
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
            <Linha label="Cobertura" valor={`${cobertura.toFixed(0)}%`} muted corValor={cobertura < 95 ? "text-warning" : undefined} />
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
      <span className={cn("text-xs text-muted-foreground", destaque && "font-medium text-foreground")}>{label}</span>
      <span className={cn("tabular-nums", destaque ? "font-semibold text-base" : "text-sm", corValor)}>
        {valor}
        {extra && <span className={cn("ml-2 text-xs text-muted-foreground", destaque && "font-normal")}>{extra}</span>}
      </span>
    </div>
  );
}

// ============================================================
// Variação inline
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
