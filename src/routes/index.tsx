import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { startOfMonth, endOfMonth, subMonths, subDays } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { PosicaoEmpresa } from "@/components/dashboard/PosicaoEmpresa";
import { HistoricoTiny } from "@/components/dashboard/HistoricoTiny";
import { DesempenhoPeriodo, type Anomalia, type Kpis } from "@/components/dashboard/DesempenhoPeriodo";
import { periodoAnterior as periodoAnteriorComum, type PeriodPreset } from "@/lib/dashboard/period";

export const Route = createFileRoute("/")({
  // ?rel= era a aba da seção Relatórios (hoje em /relatorios); aceito para não quebrar links antigos
  validateSearch: (s: Record<string, unknown>): { rel?: string } => ({
    rel: typeof s.rel === "string" && s.rel ? s.rel : undefined,
  }),
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
  ads_ant: number | null;
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
  ads: number | null;
  lucro_pos_ads: number | null;
  lucro_pos_ads_pct: number | null;
};

type DiaSerie = { data: string; receita: number; margem: number; pedidos: number; ads: number };

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

// Período de comparação dos deltas. "Mês atual" compara com os MESMOS dias do
// mês anterior (01–06/out → 01–06/set; corta no fim do mês se ele for mais
// curto) — leitura "mês contra mês", igual ao painel do Tiny/Olist. Os demais
// presets comparam com o período imediatamente antes, de mesmo nº de dias.
function periodoAnterior(preset: PresetKey, range: { from: string; to: string }): { from: string; to: string } {
  // Regra única (src/lib/dashboard/period.ts): período que é um mês compara mês a mês
  // (Mês = mesmos dias do mês anterior; Mês anterior = o mês cheio antes dele).
  const mapa: Partial<Record<PresetKey, PeriodPreset>> = { mes_atual: "mtd", mes_anterior: "prev_month", custom: "custom" };
  return periodoAnteriorComum(mapa[preset] ?? "last7", range.from, range.to);
}
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "vs 01–06/set", "vs 25/set–01/out" ou "vs 05/out". */
function rotuloComparacao(p: { from: string; to: string }): string {
  const [, mf, df] = p.from.split("-");
  const [, mt, dt] = p.to.split("-");
  const mes = (m: string) => MESES_CURTOS[Number(m) - 1];
  if (p.from === p.to) return `vs ${df}/${mes(mf)}`;
  if (mf === mt) return `vs ${df}–${dt}/${mes(mt)}`;
  return `vs ${df}/${mes(mf)}–${dt}/${mes(mt)}`;
}

// Atalhos de período do bloco "Desempenho do período" (o personalizado fica no próprio bloco)
const PRESETS: { id: PresetKey; nome: string }[] = [
  { id: "hoje", nome: "Hoje" },
  { id: "ontem", nome: "Ontem" },
  { id: "mes_atual", nome: "Mês" },
  { id: "ult_7", nome: "7 dias" },
  { id: "ult_30", nome: "30 dias" },
  { id: "mes_anterior", nome: "Mês anterior" },
];

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
  if (c.includes("tiktok")) return "hsl(349 99% 58%)"; // rosa TikTok (visivel no claro e no escuro)
  return "hsl(215 15% 55%)";
}

// ============================================================
// Component
// ============================================================
function Dashboard() {
  // Definição do dono (20/ago/2026): a Dashboard SEMPRE abre no dia de hoje.
  const [preset, setPreset] = useState<PresetKey>("hoje");
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const range = useMemo(
    () => computeRange(preset, customRange ?? undefined),
    [preset, customRange],
  );

  const [canaisFiltro, setCanaisFiltro] = useState<string[] | null>(null); // null = todos
  const [kpisCanal, setKpisCanal] = useState<KpiCanal[]>([]);
  const [serieDiaria, setSerieDiaria] = useState<DiaSerie[]>([]);
  const [metas, setMetas] = useState<MetaRealizado[]>([]);
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
  // quantas levas de consultas já chegaram (cada bloco mostra o esqueleto até a sua)
  const [levas, setLevas] = useState(0);
  const [tick, setTick] = useState(0);

  const compAtual = useMemo(() => spKey(startOfMonth(spToday())), []);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setLevas(0);
    setErro(null);

    (async () => {
      try {
        // Período de comparação (ver periodoAnterior) — em SP tz
        const { from: prevFrom, to: prevTo } = periodoAnterior(preset, range);

        const canaisQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,marketplace,shop_id,data,pedidos,receita,receita_com_custo,cmv,margem,ads")
          .gte("data", range.from)
          .lte("data", range.to);

        const canaisPrevQ = supabaseExternal
          .from("view_canais_diario")
          .select("canal,shop_id,pedidos,receita,margem,ads")
          .gte("data", prevFrom)
          .lte("data", prevTo);

        const metasQ = supabaseExternal
          .from("view_metas_realizado")
          .select("*")
          .order("competencia", { ascending: true });

        const produtosQ = supabaseExternal
          .from("view_produtos_dashboard")
          .select("sku", { count: "exact", head: true })
          .eq("vira_prejuizo_com_ads", true);

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

        // Em LEVAS (09/out/2026): as 11 consultas juntas, somadas às rotinas de
        // fundo, estouravam o limite de 8 s do banco (instância pequena) e o
        // Dashboard abria com blocos vazios. 1ª leva = topo e canais (views
        // materializadas + RPC leve) e a tela libera; o resto vem em grupos
        // pequenos. Os builders do supabase-js só disparam quando aguardados.
        const [canaisR, canaisPrevR, visao, canaisSem] = await Promise.all([
          canaisQ, canaisPrevQ, visaoQ, canaisSemQ,
        ]);
        if (cancel) return;

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

        // Nos minutos cheios (:00) várias rotinas disparam juntas e a RPC pode estourar os 8 s (30/out, 22h00:
        // 4 × 500 seguidos). Tenta de novo 2× e, se ainda falhar, NÃO mostra R$ 0: avisa e mantém o último valor.
        let visaoR = visao;
        for (let t = 0; visaoR.error && t < 2 && !cancel; t++) {
          await new Promise((r) => setTimeout(r, 2500 * (t + 1)));
          visaoR = await supabaseExternal.rpc("dashboard_visao_geral", { data_inicial: range.from, data_final: range.to });
        }
        if (cancel) return;
        if (!visaoR.error) {
          const row = Array.isArray(visaoR.data) ? (visaoR.data as VisaoGeralRow[])[0] : (visaoR.data as VisaoGeralRow | null);
          setVisaoGeral(row ?? null);
        } else {
          console.warn("dashboard_visao_geral →", visaoR.error);
          setErro("Os números do topo não carregaram (banco ocupado neste minuto). Clique em “Atualizar tudo” em instantes.");
        }

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

        // Série diária (soma de todos os canais por dia) — base das sparklines
        const porDia = new Map<string, DiaSerie>();
        for (const r of rows) {
          const cur = porDia.get(r.data) ?? { data: r.data, receita: 0, margem: 0, pedidos: 0, ads: 0 };
          cur.receita += Number(r.receita ?? 0);
          cur.margem += Number(r.margem ?? 0);
          cur.pedidos += Number(r.pedidos ?? 0);
          cur.ads += Number(r.ads ?? 0);
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
            pedidos_ant: null, receita_ant: null, margem_ant: null, ads_ant: null,
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
            v.ads_ant = p.ads;
            v.var_receita_pct = pctVar(v.receita, p.receita);
            v.var_margem_pct = pctVar(v.margem, p.margem);
            v.var_pedidos_pct = pctVar(v.pedidos, p.pedidos);
          }
          kpiRows.push(v);
        }

        setKpisCanal(kpiRows);
        setLoading(false);
        setLevas(1);

        // 2ª leva — metas/ACOS e alertas
        const [met, acos, anoms] = await Promise.all([metasQ, acosQ, anomsQ]);
        if (cancel) return;
        if (!met.error) setMetas((met.data ?? []) as MetaRealizado[]);
        else console.warn("view_metas_realizado →", met.error);
        if (!acos.error) {
          const rows = (acos.data ?? []) as { classificacao_roas: string; anuncios: number | null }[];
          const n = rows.reduce((s, r) => s + Number(r.anuncios ?? 0), 0);
          setAlertaAcos(n);
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
        setLevas(2);

        // 3ª leva — vendas por SKU e por marca (kit destrinchado)
        const [vsku, vmarca] = await Promise.all([vendasSkuQ, vendasMarcaQ]);
        if (cancel) return;
        if (!vsku.error) setVendasSku((vsku.data ?? []) as VendaSkuRow[]);
        else console.warn("vendas_por_sku →", vsku.error);
        if (!vmarca.error) setVendasMarca((vmarca.data ?? []) as VendaMarcaRow[]);
        else console.warn("vendas_por_marca →", vmarca.error);
        setLevas(3);

        // 4ª leva — produtos que viram prejuízo com o ADS e SKUs Amazon sem cadastro
        const [prod, am] = await Promise.all([produtosQ, amazonQ]);
        if (cancel) return;

        if (!prod.error) {
          setAlertaPrejuizo(prod.count ?? 0);
        }

        if (!am.error) {
          const rows = (am.data ?? []) as { tem_mapeamento: boolean | null }[];
          setAlertaAmazon(rows.filter((r) => !r.tem_mapeamento).length);
        }
      } catch (e) {
        if (!cancel) setErro((e as Error).message);
      } finally {
        if (!cancel) { setLoading(false); setLevas(4); }
      }
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, preset, compAtual, tick]);

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
    let r = 0, m = 0, p = 0, ra = 0, ma = 0, pa = 0, a = 0, aa = 0;
    for (const k of kpisCanal) {
      r += k.receita; m += k.margem; p += k.pedidos;
      ra += k.receita_ant ?? 0; ma += k.margem_ant ?? 0; pa += k.pedidos_ant ?? 0;
      a += k.ads ?? 0; aa += k.ads_ant ?? 0;
    }
    const rel = (c: number, pv: number) => (pv ? ((c - pv) / Math.abs(pv)) * 100 : null);
    const mcCur = r > 0 ? (m / r) * 100 : null;
    const mcAnt = ra > 0 ? (ma / ra) * 100 : null;
    return {
      receita: rel(r, ra),
      margem: rel(m, ma),
      pedidos: rel(p, pa),
      mcPp: mcCur != null && mcAnt != null ? mcCur - mcAnt : null,
      ads: rel(a, aa),
      // lucro pós ADS anterior = margem anterior − ADS anterior (mesma conta do card)
      lucroPosAds: rel(m - a, ma - aa),
      temHistorico: ra > 0 || ma > 0 || pa > 0,
    };
  }, [kpisCanal]);

  // Metas
  const metaTodos = metas.find((m) => m.marketplace === "todos" && m.competencia === compAtual) ?? null;
  // Serie mensal de ACOS (todos os canais), base do painel ACOS mês a mês.
  const acosMeses = useMemo(
    () => metas.filter((m) => m.marketplace === "todos" && Number(m.receita_realizada ?? 0) > 0),
    [metas],
  );

  // Cartões — valores da RPC dashboard_visao_geral (fonte única: receita, margem, ADS e lucro pós
  // ADS iguais ao DRE; a Amazon não tem ADS integrado). Delta e sparkline vêm da série diária.
  // sem a RPC (carregando ou falhou) os cartões ficam em branco — nunca R$ 0 falso
  const kpis: Kpis | null = !visaoGeral ? null : {
    vendas: Number(visaoGeral?.vendas ?? 0),
    margem: Number(visaoGeral?.margem_contrib ?? 0),
    mcPct: visaoGeral?.margem_pct != null ? Number(visaoGeral.margem_pct) : null,
    pedidos: Number(visaoGeral?.pedidos ?? 0),
    ticket: Number(visaoGeral?.ticket_medio ?? 0),
    ads: Number(visaoGeral?.ads ?? 0),
    lucro: Number(visaoGeral?.lucro_pos_ads ?? 0),
    lucroPct: visaoGeral?.lucro_pos_ads_pct != null ? Number(visaoGeral.lucro_pos_ads_pct) : null,
    projecao: visaoGeral?.projecao_vendas != null ? Number(visaoGeral.projecao_vendas) : null,
    cobertura: visaoGeral?.cobertura_pct != null ? Number(visaoGeral.cobertura_pct) : null,
  };
  const comparado = rotuloComparacao(periodoAnterior(preset, range));

  // Anomalias (bloco recolhível) — derivadas dos alertas existentes.
  const anomalias: Anomalia[] = [];
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
      {/* Desempenho do período em cima, Posição da empresa (retrato de agora) embaixo — pedido do dono, 21/out/2026 */}
      <DesempenhoPeriodo
        tick={tick}
        range={range}
        presets={PRESETS}
        preset={preset}
        onPreset={(id) => { setPreset(id as PresetKey); setCustomRange(null); }}
        custom={customRange}
        onCustom={(r) => { setCustomRange(r); setPreset("custom"); }}
        comparado={comparado}
        isMes={preset === "mes_atual"}
        onAtualizar={() => setTick((x) => x + 1)}
        atualizando={loading}
        erro={erro}
        kpis={kpis}
        deltas={deltas}
        serie={serieDiaria}
        meta={metaTodos}
        acosMeses={acosMeses}
        canais={kpisVisiveis.map((c) => ({ canal: c.canal, marketplace: c.marketplace, shop_id: c.shop_id == null ? null : String(c.shop_id), pedidos: c.pedidos, receita: c.receita, margem: c.margem, mc_pct: c.mc_pct, ads: c.ads }))}
        carregandoCanais={levas < 1}
        filtroCanal={<CanalFilter canais={canaisDisponiveis} selecionados={canaisFiltro} onChange={setCanaisFiltro} />}
        semIntegracao={canaisSemDados}
        vendasSku={vendasSku}
        vendasMarca={vendasMarca}
        carregandoProdutos={levas < 3}
        anomalias={anomalias}
      />

      {/* Posição da empresa — retrato de agora, não muda com o período */}
      <PosicaoEmpresa tick={tick} />

      {/* Histórico de faturamento pelo Tiny (out/2024 →), recolhível — 29/out/2026 */}
      <HistoricoTiny tick={tick} />
    </div>
  );
}

// ============================================================
// Filtro de canais (bloco Canais)
// ============================================================
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
