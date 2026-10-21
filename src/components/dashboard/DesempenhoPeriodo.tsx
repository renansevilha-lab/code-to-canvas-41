import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nomeDoAgente, CATEGORIAS } from "@/components/relatorios/comum";
import { L, LOGO, ddmm, hojeSP, idade, int, pct, rpc } from "./formato";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Dashboard › "Desempenho do período" (design "Visão geral" do Claude Design, 21/out/2026).
// O período vale para este bloco (menos os cartões com o selo "mês"). Os números chegam prontos:
//   · do Dashboard (props): dashboard_visao_geral (cartões), view_canais_diario (série e canais),
//     view_metas_realizado (meta e ACOS do mês), vendas_por_sku/marca, mv_anomalias;
//   · daqui: dashboard_desempenho(de, ate) = vendas por hora (um dia só), ADS por loja (ontem × 7 dias),
//     resumo das metas de ROAS e o último relatório de cada agente; dashboard_estoque_valor() (o mesmo
//     cache da "Posição da empresa").
// Cores = tokens --pm-* (.pm-ui em styles.css). Nada de cálculo de negócio aqui: só somas para o
// gráfico e a fatia da margem por canal, sobre linhas já agregadas no banco.
// ============================================================================

export type Preset = { id: string; nome: string };
export interface Deltas { receita: number | null; margem: number | null; pedidos: number | null; mcPp: number | null; ads: number | null; lucroPosAds: number | null; temHistorico: boolean }
export interface Kpis {
  vendas: number; margem: number; mcPct: number | null; pedidos: number; ticket: number; ads: number;
  lucro: number; lucroPct: number | null; projecao: number | null; cobertura: number | null;
}
export interface MetaMes {
  competencia: string; receita_realizada: number | null; meta_receita: number | null; projecao_receita: number | null;
  projecao_pct_meta: number | null; dias_decorridos: number | null; dias_no_mes: number | null;
  acos_realizado: number | null; meta_acos: number | null; ads_realizado: number | null;
}
export interface Canal { canal: string; marketplace: string; shop_id: string | null; pedidos: number; receita: number; margem: number; mc_pct: number; ads: number | null }
export interface DiaSerie { data: string; receita: number; margem: number; pedidos: number; ads: number }
export interface VendaSku { sku: string; nome: string | null; valor_atual: number; valor_anterior: number }
export interface VendaMarca { marca: string; valor_atual: number; valor_anterior: number }
export interface Anomalia { cor: "destructive" | "warning" | "amber"; to: string; titulo: string; detalhe: string }

type Erro = { erro: string };
interface AdsLoja { marketplace: string; shop_id: string; canal: string; empresa: string; g1: number; roas1: number | null; pos1: number | null; g7: number; venda7: number; tacos7: number | null; pos7: number; provisorio: boolean }
interface Extra {
  gerado_em: string;
  horas?: Array<{ h: number; receita: number; margem: number; pedidos: number }> | Erro;
  ads_lojas: { ontem: string; linhas: AdsLoja[]; atualizado_em: string | null } | Erro;
  ads_metas: { data_referencia: string; resumo: { campanhas: number; meta_abaixo_equilibrio: number; prejuizo_7d: number; perda_7d_total: number; gasto_7d_total: number; ruim: number } } | Erro;
  relatorios: Array<{ agente: string; titulo: string | null; destaque: string | null; data_referencia: string; gerado_em: string }> | Erro;
}
interface Estoque {
  parado: { valor: number; excesso: { valor: number; produtos: number }; sem_giro: { valor: number; produtos: number } };
  ruptura: { comprar_urgente: number; ruptura_empresa: number; unidades_dia: number; receita_dia: number };
  cobertura_media_dias: number | null; sem_custo: { produtos: number };
  presos: Array<{ sku: string; nome: string; situacao: string; cobertura_dias: number | null; valor: number }>;
  atualizado: { calculado_em: string; geral_em: string | null };
}

const temErro = (x: unknown): x is Erro => !!x && typeof x === "object" && "erro" in (x as object);
const MONO = "pm-mono";

/** Nome curto da loja pelo shop_id (o rótulo da view é por marketplace). */
const NOME_LOJA: Record<string, string> = {
  "522186766": "Shopee Ottz", "759046323": "Shopee Bumi", "1107117809": "Mercado Livre ACZ", "1299638625": "Mercado Livre SVL",
  "900001": "Amazon ACZ", "900002": "Amazon SVL", "7496181924415506972": "TikTok ACZ",
};
const nomeLoja = (shop: string | null, canal: string) =>
  (shop && NOME_LOJA[shop]) || canal.replace(" · ", " ").replace("ACZ Pet", "ACZ").replace("SVL Store", "SVL").replace("Ottz Pet", "Ottz");
const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** "21/out" ou "01–21/out" (mesmo formato do rótulo de comparação) */
function rotuloPeriodo(from: string, to: string): string {
  const m = (iso: string) => MES[Number(iso.slice(5, 7)) - 1];
  if (from === to) return `${from.slice(8, 10)}/${m(from)}`;
  if (from.slice(0, 7) === to.slice(0, 7)) return `${from.slice(8, 10)}–${to.slice(8, 10)}/${m(to)}`;
  return `${from.slice(8, 10)}/${m(from)}–${to.slice(8, 10)}/${m(to)}`;
}
/** O ADS integrado hoje: Shopee (as duas lojas) e Mercado Livre ACZ. */
const temAdsIntegrado = (c: Canal) => c.marketplace === "shopee" || c.shop_id === "1107117809";

const sg = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1).replace(".", ",")}%`;
function corDelta(v: number | null, inverso = false): string {
  if (v == null || Math.abs(v) < 0.05) return "var(--pm-t3)";
  return (inverso ? v < 0 : v > 0) ? "var(--pm-g)" : "var(--pm-r)";
}
/** pontos de sparkline num viewBox 100×24 */
function spark(vals: number[]): string {
  if (vals.length < 2) return "";
  const mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || 1;
  return vals.map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(1)},${(22 - ((v - mn) / r) * 20).toFixed(1)}`).join(" ");
}
/** todos os dias de from..to (YYYY-MM-DD), sem fuso */
function diasDoPeriodo(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`), fim = new Date(`${to}T12:00:00Z`);
  for (let i = 0; d <= fim && i < 400; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// ---------------------------------------------------------------- peças visuais
const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 };
const selo: CSSProperties = { fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap" };
const seloMes: CSSProperties = { fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: "var(--pm-s2)", color: "var(--pm-t2)", whiteSpace: "nowrap" };
const link: CSSProperties = { fontSize: 12, fontWeight: 500, textDecoration: "none", color: "var(--pm-at)" };
const seg = (on: boolean): CSSProperties => ({
  border: 0, cursor: "pointer", padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: on ? 600 : 500,
  background: on ? "var(--pm-s)" : "transparent", color: on ? "var(--pm-t)" : "var(--pm-t2)", boxShadow: on ? "var(--pm-sh)" : "none",
});
const segGrupo: CSSProperties = { display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8, flexWrap: "wrap" };

function Titulo({ children, quando, extra }: { children: ReactNode; quando?: string | null; extra?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 14px" }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{children}</span>
      {quando && <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>{quando}</span>}
      {extra}
    </div>
  );
}
function Bloco({ h }: { h: number }) {
  return <div style={{ height: h, borderRadius: 10, background: "var(--pm-sk)" }} />;
}
function Falhou({ msg, onTentar }: { msg: string; onTentar: () => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: "var(--pm-rs)", color: "var(--pm-r)", fontSize: 12.5 }}>
      <b style={{ fontWeight: 600 }}>Não deu para ler agora.</b>
      <span style={{ color: "var(--pm-t2)", fontSize: 12, wordBreak: "break-word" }}>{msg}</span>
      <button type="button" onClick={onTentar} style={{ height: 24, padding: "0 9px", borderRadius: 7, border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Tentar de novo</button>
    </div>
  );
}
function IrPara({ to, search, children }: { to: string; search?: Record<string, string>; children: ReactNode }) {
  return <Link to={to as never} search={search as never} style={link} className="hover:underline">{children} →</Link>;
}

// ---------------------------------------------------------------- cartão de KPI
interface CartaoKpi {
  label: string; v: string; d?: string; dCor?: string; sub: ReactNode; est?: boolean; mes?: boolean; valCor?: string;
  pts?: string; barra?: { real: number; proj: number; alvo: number; corReal?: string };
}
function Kpi({ k, carregando }: { k: CartaoKpi; carregando: boolean }) {
  return (
    <div style={{ ...cartao, gap: 5, minHeight: 118 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--pm-t2)", flex: 1 }}>{k.label}</span>
        {k.mes && <span style={seloMes}>mês</span>}
      </div>
      {carregando ? (
        <>
          <div style={{ width: "60%", height: 22, borderRadius: 7, background: "var(--pm-sk)" }} />
          <div style={{ width: "90%", height: 24, borderRadius: 6, background: "var(--pm-sk)" }} />
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span className={MONO} style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: k.valCor ?? "var(--pm-t)" }}>{k.v}</span>
            {k.d && <span className={MONO} style={{ fontSize: 12, fontWeight: 600, color: k.dCor ?? "var(--pm-t3)" }}>{k.d}</span>}
          </div>
          {k.pts ? (
            <svg viewBox="0 0 100 24" preserveAspectRatio="none" width="100%" height="24" style={{ display: "block" }}>
              <polyline points={k.pts} fill="none" stroke="var(--pm-bs)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          ) : k.barra ? (
            <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--pm-sk)", margin: "6px 0 4px" }}>
              <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, k.barra.proj)}%`, borderRadius: 4, border: "1.5px dashed var(--pm-a)" }} />
              <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, k.barra.real)}%`, borderRadius: 4, background: k.barra.corReal ?? "var(--pm-a)" }} />
              <i style={{ position: "absolute", left: `${Math.min(100, k.barra.alvo)}%`, top: -3, bottom: -3, width: 2, background: "var(--pm-t)" }} />
            </div>
          ) : <div style={{ height: 24 }} />}
          <span style={{ fontSize: 11.5, color: "var(--pm-t2)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {k.sub}{k.est && <span style={selo}>estimado</span>}
          </span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- período personalizado
function Personalizado({ ativo, custom, onCustom }: { ativo: boolean; custom: { from: string; to: string } | null; onCustom: (r: { from: string; to: string }) => void }) {
  const [from, setFrom] = useState(custom?.from ?? "");
  const [to, setTo] = useState(custom?.to ?? "");
  const [aberto, setAberto] = useState(false);
  const inp: CSSProperties = { fontSize: 12, border: "1px solid var(--pm-b)", borderRadius: 6, padding: "4px 6px", background: "var(--pm-s)", color: "var(--pm-t)", minWidth: 0, flex: 1 };
  return (
    <DropdownMenu open={aberto} onOpenChange={setAberto}>
      <DropdownMenuTrigger asChild>
        <button type="button" style={seg(ativo)}>{ativo && custom ? `${ddmm(custom.from)}–${ddmm(custom.to)}` : "Personalizado"}</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="pm-ui w-64" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>De / até</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inp} />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inp} />
          </div>
          <button type="button" disabled={!from || !to || from > to}
            onClick={() => { onCustom({ from, to }); setAberto(false); }}
            style={{ height: 30, borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", fontWeight: 600, fontSize: 12.5, cursor: "pointer", opacity: !from || !to || from > to ? 0.5 : 1 }}>
            Aplicar
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- componente
export function DesempenhoPeriodo(p: {
  tick: number;
  range: { from: string; to: string };
  presets: Preset[]; preset: string; onPreset: (id: string) => void;
  custom: { from: string; to: string } | null; onCustom: (r: { from: string; to: string }) => void;
  comparado: string; isMes: boolean;
  onAtualizar: () => void; atualizando: boolean; erro: string | null;
  kpis: Kpis | null; deltas: Deltas; serie: DiaSerie[];
  meta: MetaMes | null; acosMeses: MetaMes[];
  canais: Canal[]; carregandoCanais: boolean; filtroCanal: ReactNode;
  semIntegracao: Array<{ canal: string; receita: number; pedidos: number }>;
  vendasSku: VendaSku[]; vendasMarca: VendaMarca[]; carregandoProdutos: boolean;
  anomalias: Anomalia[];
}) {
  const umDia = p.range.from === p.range.to;
  const extraQ = useQuery({
    queryKey: ["dashboard", "desempenho", p.range.from, p.range.to, p.tick],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("dashboard_desempenho" as never, { p_de: p.range.from, p_ate: p.range.to } as never);
      if (error) throw error;
      return data as unknown as Extra;
    },
    staleTime: 5 * 60_000,
  });
  const estQ = useQuery({ queryKey: ["dashboard", "estoque-valor", p.tick], queryFn: () => rpc<Estoque>("dashboard_estoque_valor"), staleTime: 5 * 60_000, placeholderData: (a) => a });
  const ex = extraQ.data;
  const horas = ex && umDia && ex.horas && !temErro(ex.horas) ? ex.horas : null;

  const [hover, setHover] = useState<number | null>(null);
  const [prodTab, setProdTab] = useState<"top" | "sub" | "cai">("top");
  const [aberto, setAberto] = useState<Record<string, boolean>>({});

  // ---------------- série do gráfico: por hora (um dia) ou por dia
  const barras = useMemo(() => {
    if (umDia) {
      if (!horas) return null;
      const agora = p.range.from === hojeSP() ? Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false })) : 23;
      const m = new Map(horas.map((h) => [h.h, h]));
      return Array.from({ length: Math.max(1, agora + 1) }, (_, h) => ({ lbl: `${String(h).padStart(2, "0")}h`, receita: Number(m.get(h)?.receita ?? 0), margem: Number(m.get(h)?.margem ?? 0) }));
    }
    const m = new Map(p.serie.map((s) => [s.data, s]));
    return diasDoPeriodo(p.range.from, p.range.to).map((d) => ({ lbl: ddmm(d), receita: Number(m.get(d)?.receita ?? 0), margem: Number(m.get(d)?.margem ?? 0) }));
  }, [umDia, horas, p.serie, p.range.from, p.range.to]);

  // ---------------- sparklines (por hora quando é um dia só)
  const sp = useMemo(() => {
    const base = umDia ? (horas ?? []).map((h) => ({ receita: Number(h.receita), margem: Number(h.margem), pedidos: Number(h.pedidos), ads: 0 })) : p.serie;
    return {
      rec: spark(base.map((s) => s.receita)), mc: spark(base.map((s) => s.margem)),
      mcp: spark(base.map((s) => (s.receita > 0 ? s.margem / s.receita : 0))), ped: spark(base.map((s) => s.pedidos)),
      ads: umDia ? "" : spark(base.map((s) => s.ads)), luc: umDia ? "" : spark(base.map((s) => s.margem - s.ads)),
    };
  }, [umDia, horas, p.serie]);

  // ---------------- cartões
  const k = p.kpis, dt = p.deltas;
  const d = (v: number | null, inverso = false) => (!dt.temHistorico || v == null ? { d: "—", dCor: "var(--pm-t3)" } : { d: sg(v), dCor: corDelta(v, inverso) });
  const acosPer = k && k.vendas > 0 ? (k.ads / k.vendas) * 100 : null;
  const kpis: CartaoKpi[] = k ? [
    { label: "Receita líquida", v: L(k.vendas), ...d(dt.receita), pts: sp.rec, est: p.isMes && k.projecao != null,
      sub: p.isMes && k.projecao != null ? `projeção do mês ${L(k.projecao)}` : p.comparado },
    { label: "Margem de contribuição", v: L(k.margem), ...d(dt.margem), pts: sp.mc,
      sub: k.cobertura != null && k.cobertura < 90 ? <span style={{ color: "var(--pm-am)" }}>só {pct(k.cobertura, 0)} da receita tem custo</span> : "receita − taxas − imposto − CMV" },
    { label: "MC %", v: k.mcPct != null ? pct(k.mcPct) : "—", pts: sp.mcp,
      d: !dt.temHistorico || dt.mcPp == null ? "—" : `${dt.mcPp >= 0 ? "+" : "−"}${Math.abs(dt.mcPp).toFixed(1).replace(".", ",")} p.p.`, dCor: corDelta(dt.mcPp),
      sub: "sobre a receita líquida" },
    { label: "Pedidos", v: int(k.pedidos), ...d(dt.pedidos), pts: sp.ped, sub: `ticket médio ${L(k.ticket)}` },
    { label: "Gastos com ADS", v: L(k.ads), ...d(dt.ads, true), pts: sp.ads,
      sub: `${acosPer != null ? `ACOS ${pct(acosPer)} · ` : ""}gastar mais não é verde` },
    { label: "Lucro pós ADS", v: L(k.lucro), ...d(dt.lucroPosAds), pts: sp.luc, valCor: k.lucro < 0 ? "var(--pm-r)" : undefined,
      sub: `MC − ADS${k.lucroPct != null ? ` · ${pct(k.lucroPct)} da receita` : ""} · sem ADS da Amazon` },
  ] : [];
  // meta e ACOS do mês corrente (selo "mês": não seguem o período)
  const m = p.meta;
  if (m && m.meta_receita && Number(m.meta_receita) > 0) {
    const real = Number(m.receita_realizada ?? 0), meta = Number(m.meta_receita), proj = Number(m.projecao_receita ?? real);
    const restam = Math.max(0, Number(m.dias_no_mes ?? 0) - Number(m.dias_decorridos ?? 0));
    const falta = restam > 0 ? Math.max(0, meta - real) / restam : 0;
    const esc = Math.max(meta, proj) || 1;
    kpis.push({ label: "Meta do mês", mes: true, v: L(real), d: `de ${L(meta)}`, est: true,
      barra: { real: (real / esc) * 100, proj: (proj / esc) * 100, alvo: (meta / esc) * 100 },
      sub: `projeção ${L(proj)} (${pct((proj / meta) * 100, 0)})${falta > 0 ? ` · faltam ${L(falta)} por dia` : ""}` });
  } else if (k) {
    kpis.push({ label: "Meta do mês", mes: true, v: "—", sub: <IrPara to="/metas">Cadastrar meta</IrPara> });
  }
  if (m && m.acos_realizado != null) {
    const ac = Number(m.acos_realizado), mt = m.meta_acos != null ? Number(m.meta_acos) : null;
    const esc = Math.max(ac, mt ?? 0) * 1.25 || 1;
    const pp = mt != null ? ac - mt : null;
    kpis.push({ label: "ACOS × meta", mes: true, v: pct(ac), valCor: pp != null && pp > 0 ? "var(--pm-am)" : undefined,
      d: mt != null ? `meta ${pct(mt)}` : "sem meta",
      barra: { real: (ac / esc) * 100, proj: (ac / esc) * 100, alvo: ((mt ?? 0) / esc) * 100, corReal: pp != null && pp > 0 ? "var(--pm-am)" : "var(--pm-a)" },
      sub: pp != null ? `${Math.abs(pp).toFixed(1).replace(".", ",")} p.p. ${pp > 0 ? "acima" : "abaixo"} · a meta muda a cada mês` : "a meta muda a cada mês" });
  }
  const carregandoKpis = !k;

  // ---------------- canais
  const canais = useMemo(() => [...p.canais].sort((a, b) => b.receita - a.receita), [p.canais]);
  const totMc = canais.reduce((a, c) => a + Math.max(0, c.margem), 0);
  const corFatia = ["var(--pm-a)", "var(--pm-at)", "var(--pm-t2)", "var(--pm-t3)", "var(--pm-bs)", "var(--pm-bs)", "var(--pm-bs)"];

  // ---------------- produtos
  const prod = useMemo(() => {
    const comD = <T extends { valor_atual: number; valor_anterior: number }>(xs: T[]) => xs.map((x) => ({ ...x, a: Number(x.valor_atual ?? 0), b: Number(x.valor_anterior ?? 0), dv: Number(x.valor_atual ?? 0) - Number(x.valor_anterior ?? 0) }));
    const s = comD(p.vendasSku), mk = comD(p.vendasMarca);
    const nSub = s.filter((x) => x.dv > 0).length, nCai = s.filter((x) => x.dv < 0).length;
    const ordena = <T extends { a: number; dv: number }>(xs: T[]) =>
      prodTab === "sub" ? xs.filter((x) => x.dv > 0).sort((x, y) => y.dv - x.dv)
        : prodTab === "cai" ? xs.filter((x) => x.dv < 0).sort((x, y) => x.dv - y.dv)
          : [...xs].sort((x, y) => y.a - x.a);
    return { skus: ordena(s).slice(0, 6), marcas: ordena(mk).slice(0, 5), nSub, nCai };
  }, [p.vendasSku, p.vendasMarca, prodTab]);
  const deltaProd = (a: number, b: number) => (b > 0 ? { t: sg(((a - b) / b) * 100).replace(/,\d%$/, "%"), c: a >= b ? "var(--pm-g)" : "var(--pm-r)" } : a > 0 ? { t: "novo", c: "var(--pm-g)" } : { t: "—", c: "var(--pm-t3)" });

  // ---------------- recolhíveis
  const rels = ex && !temErro(ex.relatorios) ? ex.relatorios : [];
  const relHoje = rels.filter((r) => r.data_referencia === hojeSP()).length;
  const slugDe = (agente: string) => CATEGORIAS.find((c) => c.agente === agente)?.slug;
  const acosMeses = p.acosMeses.slice(-12);
  const acosMax = Math.max(1, ...acosMeses.map((x) => Math.max(Number(x.acos_realizado ?? 0), Number(x.meta_acos ?? 0)))) * 1.2;
  const rotMes = (c: string) => `${["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"][Number(c.slice(5, 7)) - 1]}/${c.slice(2, 4)}`;
  const corAnom = { destructive: "var(--pm-r)", warning: "var(--pm-am)", amber: "var(--pm-t3)" };

  const recolhiveis: Array<{ key: string; titulo: string; resumo: string; selo: string; corpo: ReactNode }> = [
    {
      key: "rel", titulo: "Relatórios dos agentes", selo: "não muda com o período",
      resumo: !ex ? "carregando…" : temErro(ex.relatorios) ? "não deu para ler" : `${relHoje} ${relHoje === 1 ? "relatório" : "relatórios"} hoje`,
      corpo: rels.length === 0 ? <Linha k="—" v="Nenhum relatório nos últimos 3 dias." /> : (
        <>
          {rels.map((r) => {
            const q = idade(r.gerado_em);
            const slug = slugDe(r.agente);
            return (
              <Link key={r.agente} to={"/relatorios" as never} search={(slug ? { rel: slug } : {}) as never} style={{ textDecoration: "none", color: "inherit" }} className="hover:bg-[var(--pm-s2)]">
                <Linha k={nomeDoAgente(r.agente)} v={r.destaque ?? "—"} h={q.txt} hCor={r.data_referencia !== hojeSP() ? "var(--pm-am)" : undefined} cor={r.data_referencia === hojeSP() ? "var(--pm-a)" : "var(--pm-t3)"} />
              </Link>
            );
          })}
          <div style={{ padding: "8px 14px 12px", borderTop: "1px solid var(--pm-b)" }}><IrPara to="/relatorios">Abrir relatórios</IrPara></div>
        </>
      ),
    },
    {
      key: "anom", titulo: "Anomalias de dados", selo: "agora",
      resumo: p.anomalias.length === 0 ? "nenhuma pendência" : `${p.anomalias.length} ${p.anomalias.length === 1 ? "tipo" : "tipos"} · ${p.anomalias[0].titulo}`,
      corpo: p.anomalias.length === 0 ? <Linha k="Tudo certo" v="Nenhuma pendência que afete a margem." cor="var(--pm-g)" /> : p.anomalias.map((a) => (
        <Link key={a.titulo} to={a.to as never} style={{ textDecoration: "none", color: "inherit" }} className="hover:bg-[var(--pm-s2)]">
          <Linha k={a.titulo} v={a.detalhe} cor={corAnom[a.cor]} />
        </Link>
      )),
    },
    {
      key: "acos", titulo: "ACOS mês a mês", selo: "12 meses",
      resumo: acosMeses.length ? `traço = meta de cada mês · ${acosMeses.filter((x) => x.meta_acos != null && Number(x.acos_realizado ?? 0) > Number(x.meta_acos)).length} acima da meta` : "sem histórico",
      corpo: (
        <div style={{ display: "flex", alignItems: "stretch", gap: 6, height: 150, padding: "12px 14px", borderTop: "1px solid var(--pm-b)" }}>
          {acosMeses.map((x) => {
            const v = Number(x.acos_realizado ?? 0), mt = x.meta_acos != null ? Number(x.meta_acos) : null;
            const acima = mt != null && v > mt;
            return (
              <div key={x.competencia} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
                title={`${rotMes(x.competencia)} · ACOS ${pct(v)}${mt != null ? ` · meta ${pct(mt)}` : ""} · ADS ${L(Number(x.ads_realizado ?? 0))}`}>
                <span className={MONO} style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>{v > 0 ? pct(v) : "—"}</span>
                <div style={{ position: "relative", width: "100%", flex: 1, borderRadius: 5, background: "var(--pm-s2)" }}>
                  <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${Math.max(2, (v / acosMax) * 100)}%`, borderRadius: 5, background: acima ? "var(--pm-am)" : "var(--pm-a)" }} />
                  {mt != null && <div style={{ position: "absolute", left: 0, right: 0, bottom: `${(mt / acosMax) * 100}%`, borderTop: "1.5px dashed var(--pm-t)" }} />}
                </div>
                <span style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>{rotMes(x.competencia)}</span>
              </div>
            );
          })}
        </div>
      ),
    },
  ];

  const est = estQ.data ?? null;
  const adsL = ex && !temErro(ex.ads_lojas) ? ex.ads_lojas : null;
  const adsM = ex && !temErro(ex.ads_metas) ? ex.ads_metas.resumo : null;
  const nomeAds = (c: string) => c.replace("Mercado Livre", "ML").replace(/\s*\((ACZ|SVL)[^)]*\)/, " $1");

  return (
    <section className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--pm-t)", fontSize: 13 }}>
      {/* cabeçalho fixo com o período */}
      <div style={{ position: "sticky", top: 69, zIndex: 20, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "10px 14px", borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)", boxShadow: "var(--pm-sh)" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Desempenho do período</h2>
        <div style={segGrupo}>
          {p.presets.map((x) => <button key={x.id} type="button" style={seg(p.preset === x.id)} onClick={() => { setHover(null); p.onPreset(x.id); }}>{x.nome}</button>)}
          <Personalizado ativo={p.preset === "custom"} custom={p.custom} onCustom={p.onCustom} />
        </div>
        <span className={MONO} style={{ fontSize: 12, color: "var(--pm-t2)" }}>
          {rotuloPeriodo(p.range.from, p.range.to)} × {p.comparado.replace(/^vs /, "")}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>O período vale só para este bloco, menos o que tiver o selo “mês”. A posição da empresa, abaixo, é sempre de agora.</span>
        <button type="button" onClick={p.onAtualizar} disabled={p.atualizando}
          style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.atualizando ? "animate-spin" : undefined}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
          Atualizar tudo
        </button>
      </div>

      {p.erro && <Falhou msg={p.erro} onTentar={p.onAtualizar} />}

      {/* cartões */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(max(170px,calc((100% - 30px) / 4)),1fr))", gap: 10 }}>
        {(carregandoKpis ? Array.from({ length: 8 }, (_, i) => ({ label: ["Receita líquida", "Margem de contribuição", "MC %", "Pedidos", "Gastos com ADS", "Lucro pós ADS", "Meta do mês", "ACOS × meta"][i], v: "", sub: "" } as CartaoKpi)) : kpis)
          .map((x) => <Kpi key={x.label} k={x} carregando={carregandoKpis} />)}
      </div>

      {/* vendas × margem */}
      <div style={cartao}>
        <Titulo quando={ex ? idade(ex.gerado_em).txt : null} extra={
          <>
            <div style={{ flex: 1 }} />
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--pm-t2)" }}><i style={{ width: 10, height: 10, borderRadius: 2, background: "var(--pm-bar, var(--pm-bs))" }} />Receita líquida</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--pm-t2)" }}><i style={{ width: 10, height: 10, borderRadius: 2, background: "var(--pm-a)" }} />Margem de contribuição</span>
          </>
        }>Vendas × margem {umDia ? "por hora" : "por dia"}</Titulo>
        {umDia && ex && temErro(ex.horas) ? <Falhou msg={ex.horas.erro} onTentar={() => void extraQ.refetch()} />
          : !barras ? <Bloco h={170} />
            : barras.every((b) => b.receita === 0) ? <span style={{ fontSize: 12.5, color: "var(--pm-t3)", padding: "30px 0", textAlign: "center" }}>Sem vendas no período.</span>
              : (() => {
                const mx = Math.max(...barras.map((b) => b.receita), 1);
                const step = barras.length > 20 ? 5 : barras.length > 12 ? 4 : barras.length > 8 ? 2 : 1;
                const hv = hover != null ? barras[hover] : null;
                return (
                  <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 3, height: 170, paddingBottom: 18 }} onMouseLeave={() => setHover(null)}>
                    {barras.map((b, i) => (
                      <div key={`${b.lbl}-${i}`} onMouseEnter={() => setHover(i)} style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", position: "relative" }}>
                        <div style={{ height: `${(b.receita / mx) * 100}%`, background: hover === i ? "var(--pm-bs)" : "var(--pm-bar, var(--pm-sk))", borderRadius: "3px 3px 0 0", display: "flex", flexDirection: "column", justifyContent: "flex-end", overflow: "hidden" }}>
                          <i style={{ height: `${b.receita > 0 ? Math.max(0, Math.min(100, (b.margem / b.receita) * 100)) : 0}%`, background: "var(--pm-a)" }} />
                        </div>
                        <span className={MONO} style={{ position: "absolute", bottom: -18, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "var(--pm-t3)", whiteSpace: "nowrap" }}>{i % step === 0 ? b.lbl : ""}</span>
                      </div>
                    ))}
                    {hv && hover != null && (
                      <div style={{ position: "absolute", left: `${((hover + 0.5) / barras.length) * 100}%`, top: 0, transform: `translateX(${hover / barras.length > 0.75 ? "-100%" : hover / barras.length < 0.25 ? "0" : "-50%"})`, background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 10, boxShadow: "var(--pm-shl, var(--pm-sh))", padding: "8px 10px", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 2, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 2 }}>
                        <b style={{ fontWeight: 600 }}>{hv.lbl}</b>
                        <span>Receita <b className={MONO} style={{ fontWeight: 600 }}>{L(hv.receita)}</b></span>
                        <span>MC <b className={MONO} style={{ fontWeight: 600, color: "var(--pm-at)" }}>{L(hv.margem)}{hv.receita > 0 ? ` · ${pct((hv.margem / hv.receita) * 100)}` : ""}</b></span>
                      </div>
                    )}
                  </div>
                );
              })()}
      </div>

      {/* canais */}
      <div style={cartao}>
        <Titulo extra={<><span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Amazon, TikTok e ML SVL sem ADS integrado</span><div style={{ flex: 1 }} />{p.filtroCanal}</>}>Canais</Titulo>
        {p.carregandoCanais ? <Bloco h={150} /> : canais.length === 0 ? <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>Nenhum canal no período.</span> : (
          <>
            {totMc > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>De onde vem a margem de contribuição</span>
                <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden", gap: 2 }}>
                  {canais.filter((c) => c.margem > 0).map((c, i) => {
                    const sh = c.margem / totMc;
                    const nome = nomeLoja(c.shop_id, c.canal);
                    return (
                      <div key={`${c.canal}-${c.shop_id}`} title={`${nome} · ${pct(sh * 100, 0)} da margem`} style={{ width: `${sh * 100}%`, background: corFatia[i] ?? "var(--pm-bs)", display: "flex", alignItems: "center", padding: "0 6px", overflow: "hidden" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--pm-oa)", whiteSpace: "nowrap" }}>{sh > 0.08 ? `${nome.split(" ")[0] === "Mercado" ? "ML" : nome.split(" ")[0]} ${nome.split(" ").pop()} ${pct(sh * 100, 0)}` : ""}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,210px),1fr))", gap: 8 }}>
              {canais.map((c) => {
                const integrado = temAdsIntegrado(c);
                const ads = integrado ? Number(c.ads ?? 0) : null;
                const pos = c.margem - (ads ?? 0);
                const acos = ads != null && c.receita > 0 ? (ads / c.receita) * 100 : null;
                const metaAcos = p.meta?.meta_acos != null ? Number(p.meta.meta_acos) : null;
                return (
                  <div key={`${c.canal}-${c.shop_id}`} style={{ border: "1px solid var(--pm-b)", borderRadius: 12, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: "#fff", boxShadow: "0 0 0 1px var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <img src={LOGO[c.marketplace] ?? LOGO.shopee} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} />
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{nomeLoja(c.shop_id, c.canal)}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--pm-t3)" }}>{int(c.pedidos)} ped.</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", fontSize: 12 }}>
                      <span style={{ color: "var(--pm-t3)" }}>Receita</span><span className={MONO} style={{ textAlign: "right" }}>{L(c.receita)}</span>
                      <span style={{ color: "var(--pm-t3)" }}>MC</span>
                      <span className={MONO} style={{ textAlign: "right" }}>{L(c.margem)} <span style={{ color: c.mc_pct < 10 ? "var(--pm-am)" : "var(--pm-t2)" }}>· {pct(c.mc_pct)}</span></span>
                      <span style={{ color: "var(--pm-t3)" }}>ADS</span><span className={MONO} style={{ textAlign: "right", color: "var(--pm-t2)" }}>{ads == null ? "sem integração" : L(ads)}</span>
                      <span style={{ color: "var(--pm-t3)" }}>ACOS</span>
                      <span className={MONO} style={{ textAlign: "right", color: acos != null && metaAcos != null && acos > metaAcos ? "var(--pm-am)" : "var(--pm-t2)" }}>{acos == null ? "—" : pct(acos)}</span>
                      <span style={{ color: "var(--pm-t3)" }}>Pós-ADS</span>
                      <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: pos < 0 ? "var(--pm-r)" : c.receita > 0 && pos / c.receita < 0.05 ? "var(--pm-am)" : "var(--pm-g)" }}>{L(pos)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {p.semIntegracao.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", padding: "8px 10px", borderRadius: 10, background: "var(--pm-s2)", fontSize: 12, color: "var(--pm-t2)" }}>
                <span style={{ fontWeight: 500 }}>Sem integração</span>
                {p.semIntegracao.map((x) => <span key={x.canal}><b style={{ fontWeight: 600, color: "var(--pm-t)" }}>{x.canal}</b> <span className={MONO}>{L(x.receita)} · {int(x.pedidos)} ped.</span></span>)}
                <span style={{ color: "var(--pm-t3)" }}>só receita e pedidos, informados pelo Tiny · fora dos totais acima</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ADS por loja + estoque como investimento */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,460px),1fr))", gap: 12, alignItems: "start" }}>
        <div style={{ ...cartao, padding: 0, gap: 0 }}>
          <div style={{ padding: "12px 14px 8px" }}>
            <Titulo quando={adsL?.atualizado_em ? `retrato das ${new Date(adsL.atualizado_em).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).replace(":", "h")}` : null}
              extra={<><div style={{ flex: 1 }} /><span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>não muda com o período · Amazon sem ADS</span></>}>ADS por loja</Titulo>
          </div>
          {!ex ? <div style={{ margin: "0 14px 14px" }}><Bloco h={150} /></div>
            : temErro(ex.ads_lojas) ? <div style={{ margin: "0 14px 14px" }}><Falhou msg={ex.ads_lojas.erro} onTentar={() => void extraQ.refetch()} /></div>
              : (
                <>
                  <div style={{ overflowX: "auto" }}><div style={{ minWidth: 500 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(100px,1.2fr) 64px 44px 74px 66px 50px 76px", gap: "0 8px", alignItems: "end", padding: "6px 12px", background: "var(--pm-s2)", fontSize: 11, color: "var(--pm-t3)", fontWeight: 500 }}>
                      <span />
                      <span style={{ gridColumn: "span 3", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid var(--pm-bs)", paddingBottom: 3 }}>Ontem · {ddmm(adsL!.ontem)} {adsL!.linhas.some((x) => x.provisorio) && <span style={selo}>provisório</span>}</span>
                      <span style={{ gridColumn: "span 3", borderBottom: "1px solid var(--pm-bs)", paddingBottom: 3 }}>7 dias até ontem</span>
                      <span>Loja</span><span style={{ textAlign: "right" }}>Gasto</span><span style={{ textAlign: "right" }}>ROAS</span><span style={{ textAlign: "right" }}>Pós-ADS</span>
                      <span style={{ textAlign: "right" }}>Gasto</span><span style={{ textAlign: "right" }}>TACOS</span><span style={{ textAlign: "right" }}>Pós-ADS</span>
                    </div>
                    {adsL!.linhas.map((a) => {
                      const ruim = (a.pos1 ?? 0) < 0 || a.pos7 < 0;
                      const cor = (v: number | null) => (v == null ? "var(--pm-t3)" : v < 0 ? "var(--pm-r)" : "var(--pm-g)");
                      return (
                        <div key={a.shop_id} style={{ display: "grid", gridTemplateColumns: "minmax(100px,1.2fr) 64px 44px 74px 66px 50px 76px", gap: "0 8px", alignItems: "center", padding: "9px 12px", borderTop: "1px solid var(--pm-b)", fontSize: 12, background: ruim ? "var(--pm-rs)" : "transparent" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 500 }}><img src={LOGO[a.marketplace] ?? LOGO.shopee} alt="" style={{ width: 16, height: 16, objectFit: "contain", borderRadius: 4, background: "#fff" }} />{nomeAds(a.canal)}</span>
                          <span className={MONO} style={{ textAlign: "right" }}>{L(a.g1)}</span>
                          <span className={MONO} style={{ textAlign: "right", color: (a.pos1 ?? 0) < 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{a.roas1 != null ? String(a.roas1.toFixed(1)).replace(".", ",") : "—"}</span>
                          <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: cor(a.pos1) }}>{a.pos1 == null ? "—" : `${a.pos1 >= 0 ? "+" : ""}${L(a.pos1)}`}</span>
                          <span className={MONO} style={{ textAlign: "right" }}>{L(a.g7)}</span>
                          <span className={MONO} style={{ textAlign: "right", color: a.pos7 < 0 ? "var(--pm-r)" : "var(--pm-t2)" }}>{a.tacos7 != null ? pct(a.tacos7 * 100) : "—"}</span>
                          <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: cor(a.pos7) }}>{`${a.pos7 >= 0 ? "+" : ""}${L(a.pos7)}`}</span>
                        </div>
                      );
                    })}
                  </div></div>
                  {adsM && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--pm-b)" }}>
                      <Mini v={int(adsM.campanhas)} t={`campanhas em 7 dias · ${L(adsM.gasto_7d_total)} gastos`} />
                      <Mini v={int(adsM.meta_abaixo_equilibrio)} cor={adsM.meta_abaixo_equilibrio > 0 ? "var(--pm-am)" : undefined} t="com meta abaixo do ROAS de equilíbrio" />
                      <Mini v={int(adsM.prejuizo_7d)} cor={adsM.prejuizo_7d > 0 ? "var(--pm-r)" : undefined} t="no prejuízo em 7 dias" />
                      <Mini v={L(-adsM.perda_7d_total)} cor={adsM.perda_7d_total > 0 ? "var(--pm-r)" : undefined} t="perda estimada em 7 dias" est />
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 14, padding: "0 14px 12px" }}><IrPara to="/ads-shopee">ADS Shopee</IrPara><IrPara to="/ads-ml">ADS ML</IrPara></div>
                </>
              )}
        </div>

        <div style={cartao}>
          <Titulo quando={est ? `estoque ${idade(est.atualizado.geral_em ?? est.atualizado.calculado_em).txt}` : null}
            extra={<><div style={{ flex: 1 }} /><span style={seloMes}>agora · não muda com o período</span></>}>Estoque como investimento</Titulo>
          {estQ.error ? <Falhou msg={(estQ.error as Error).message} onTentar={() => void estQ.refetch()} /> : !est ? <Bloco h={200} /> : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                <Caixa cor="am" t="Excesso" v={L(est.parado.excesso.valor)} s={`${est.parado.excesso.produtos} produtos · 120+ dias`} />
                <Caixa cor="am" t="Sem giro" v={L(est.parado.sem_giro.valor)} s={`${est.parado.sem_giro.produtos} sem venda em 30 dias`} />
                <Caixa cor="r" t="Ruptura" v={`${L(est.ruptura.receita_dia)}/dia`} s={`${est.ruptura.comprar_urgente} comprar urgente · ${est.ruptura.ruptura_empresa} em ruptura`} />
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)", paddingBottom: 4 }}>Os 5 que mais prendem dinheiro</span>
                {est.presos.map((x) => (
                  <div key={x.sku} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto 80px", gap: 10, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--pm-b)", fontSize: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.nome}>{x.nome}</span>
                      <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)" }}>SKU {x.sku}</span>
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 6px", borderRadius: 5, background: "var(--pm-ams)", color: "var(--pm-am)", whiteSpace: "nowrap" }}>
                      {x.situacao === "sem_giro" ? "sem giro" : `excesso${x.cobertura_dias != null ? ` · ${int(x.cobertura_dias)} d` : ""}`}
                    </span>
                    <span className={MONO} style={{ textAlign: "right", fontWeight: 600 }}>{L(x.valor)}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 14px", fontSize: 12, color: "var(--pm-t2)" }}>
                {est.cobertura_media_dias != null && <span>Cobertura média <b className={MONO} style={{ color: "var(--pm-t)", fontWeight: 600 }}>{int(est.cobertura_media_dias)} dias</b></span>}
                {est.sem_custo.produtos > 0 && <span style={{ color: "var(--pm-t3)" }}>{est.sem_custo.produtos} produtos com estoque sem custo cadastrado ficam fora</span>}
                <div style={{ flex: 1 }} />
                <IrPara to="/compras">Compras</IrPara>
                <IrPara to="/fulfillment" search={{ tab: "reposicao" }}>Fulfillment (Reposição)</IrPara>
              </div>
            </>
          )}
        </div>
      </div>

      {/* produtos e marcas */}
      <div style={cartao}>
        <Titulo quando="kit aberto nos componentes" extra={
          <>
            <div style={{ flex: 1 }} />
            <div style={segGrupo}>
              {([["top", "Mais vendidos"], ["sub", `Subiram · ${prod.nSub}`], ["cai", `Caíram · ${prod.nCai}`]] as const).map(([id, nome]) => (
                <button key={id} type="button" style={seg(prodTab === id)} onClick={() => setProdTab(id)}>{nome}</button>
              ))}
            </div>
          </>
        }>Produtos e marcas</Titulo>
        {p.carregandoProdutos ? <Bloco h={180} /> : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))", gap: 16 }}>
              <TabelaProd titulo="Por SKU" linhas={prod.skus.map((x) => ({ key: x.sku, nome: x.nome ?? x.sku, sub: `SKU ${x.sku}`, a: x.a, b: x.b }))} delta={deltaProd} />
              <TabelaProd titulo="Por marca" linhas={prod.marcas.map((x) => ({ key: x.marca, nome: x.marca, a: x.a, b: x.b }))} delta={deltaProd} />
            </div>
            <IrPara to="/vendas">Vendas por produto</IrPara>
          </>
        )}
      </div>

      {/* recolhíveis */}
      {recolhiveis.map((g) => {
        const ab = !!aberto[g.key];
        return (
          <div key={g.key} style={{ ...cartao, padding: 0, gap: 0 }}>
            <button type="button" onClick={() => setAberto((s) => ({ ...s, [g.key]: !ab }))}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", width: "100%", color: "inherit" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: ab ? "rotate(90deg)" : "none", color: "var(--pm-t3)", flex: "none" }}><path d="m9 18 6-6-6-6" /></svg>
              <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{g.titulo}</span>
              <span style={{ fontSize: 11.5, color: "var(--pm-t3)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.resumo}</span>
              <div style={{ flex: 1 }} />
              <span style={seloMes}>{g.selo}</span>
            </button>
            {ab && g.corpo}
          </div>
        );
      })}
    </section>
  );
}

function Linha({ k, v, h, hCor, cor }: { k: string; v: string; h?: string; hCor?: string; cor?: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px,220px) minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "9px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12.5 }}>
      <span style={{ fontWeight: 500, display: "flex", alignItems: "center", gap: 7 }}><i style={{ width: 7, height: 7, borderRadius: "50%", background: cor ?? "var(--pm-t3)", flex: "none" }} />{k}</span>
      <span style={{ color: "var(--pm-t2)", textWrap: "pretty" }}>{v}</span>
      <span style={{ fontSize: 11, color: hCor ?? "var(--pm-t3)", whiteSpace: "nowrap" }}>{h ?? ""}</span>
    </div>
  );
}
function Mini({ v, t, cor, est }: { v: string; t: string; cor?: string; est?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span className={MONO} style={{ fontSize: 15, fontWeight: 600, color: cor ?? "var(--pm-t)" }}>{v}</span>
        {est && <span style={selo}>estimado</span>}
      </span>
      <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{t}</span>
    </div>
  );
}
function Caixa({ cor, t, v, s }: { cor: "am" | "r"; t: string; v: string; s: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "8px 10px", borderRadius: 10, background: cor === "r" ? "var(--pm-rs)" : "var(--pm-ams)", minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: cor === "r" ? "var(--pm-r)" : "var(--pm-am)", fontWeight: 600 }}>{t}</span>
      <span className={MONO} style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}>{v}</span>
      <span style={{ fontSize: 11, color: "var(--pm-t2)" }}>{s}</span>
    </div>
  );
}
function TabelaProd({ titulo, linhas, delta }: {
  titulo: string; linhas: Array<{ key: string; nome: string; sub?: string; a: number; b: number }>;
  delta: (a: number, b: number) => { t: string; c: string };
}) {
  const cols = "minmax(0,1fr) 84px 84px 60px";
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 8, fontSize: 11, color: "var(--pm-t3)", paddingBottom: 4 }}>
        <span>{titulo}</span><span style={{ textAlign: "right" }}>Atual</span><span style={{ textAlign: "right" }}>Anterior</span><span style={{ textAlign: "right" }}>Δ</span>
      </div>
      {linhas.length === 0 && <span style={{ fontSize: 12, color: "var(--pm-t3)", padding: "8px 0", borderTop: "1px solid var(--pm-b)" }}>Nada nesta lista no período.</span>}
      {linhas.map((x) => {
        const d = delta(x.a, x.b);
        return (
          <div key={x.key} style={{ display: "grid", gridTemplateColumns: cols, gap: 8, alignItems: "center", padding: x.sub ? "6px 0" : "8px 0", borderTop: "1px solid var(--pm-b)", fontSize: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={x.nome}>{x.nome}</span>
              {x.sub && <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)" }}>{x.sub}</span>}
            </div>
            <span className={MONO} style={{ textAlign: "right" }}>{L(x.a)}</span>
            <span className={MONO} style={{ textAlign: "right", color: "var(--pm-t3)" }}>{L(x.b)}</span>
            <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: d.c }}>{d.t}</span>
          </div>
        );
      })}
    </div>
  );
}
