// ============================================================================
// ADS Shopee — visual novo (13/nov/2026, aprovado pelo dono na proposta
// https://claude.ai/artifact/7sGA7A1XMA6ADuQY1Dr2HJ). Só apresentação: toda leitura/escrita continua na
// rota `ads-shopee.tsx` (RPC ads_shopee_painel, config ao vivo, análise por dia, marcações). A rota passa
// os dados e as funções; aqui é layout com os tokens `--pm-*` (identidade do app), formato arredondado.
// Ordem: filtros de loja/situação → Pede decisão (situações com R$ em jogo) → KPIs → gráfico + "para onde
// vai o investimento" → lista com colunas agrupadas (Entrega · Gasto · Retorno · Margem), período e busca
// na barra da lista, linha expansível com situações, marcações e ações.
// ============================================================================
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Loader2, Pencil } from "lucide-react";
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip as RTooltip, XAxis, YAxis, ZAxis,
} from "recharts";

import { Botao, Entrada, Selo } from "@/components/producao/ui";
import { Foto, Segmento } from "@/components/separacao/ui/kit";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import { MetaRoasCelula, SeloImpulsionado, textoOrcamento, type ShopeeAdsConfig } from "@/components/ads/ShopeeAdsConfig";
import { BlocoOQueFazer, EtiquetaMarcacao, PainelTestesAB, marcacoesDoItem, type Marcacao } from "@/components/ads/MarcacoesTeste";
import { AnaliseAnuncioAds } from "@/components/ads/AnaliseAnuncioAds";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import type { PeriodRange } from "@/lib/dashboard/period";
import {
  BUCKET_COLOR, CLASSIF_ALL, CLASSIF_META, PAGE_SIZE, SITUACOES, SIT_POR_K, bucketRegra, fmtDate, fmtRoas, num,
  type AnuncioRow, type Classificacao, type ConfigFaixas, type Limiares, type McPeriodo, type SearchParams, type SortKey,
} from "@/components/ads/shopeeDefs";

export interface AdsShopeeNovoProps {
  sp: SearchParams;
  update: (patch: Partial<SearchParams>, resetPage?: boolean) => void;
  empresas: string[];
  faixas: ConfigFaixas | null;
  acosAlvo: number;
  range: PeriodRange;
  setRange: (r: PeriodRange) => void;
  anuncios: AnuncioRow[];
  total: number;
  loadingAds: boolean;
  errAds: string | null;
  countsByClassif: Record<Classificacao, number>;
  bucketInv: Record<Classificacao, number>;
  totais: { inv: number; vendas: number; anuncios: number; roas: number; acos: number };
  mc: McPeriodo | null;
  situacoes: Record<string, number>;
  limiares: Limiares | null;
  serie: { data: string; investimento: number; vendas: number; roas: number }[];
  loadingDaily: boolean;
  scatterPts: { investimento: number; roas: number; vendas: number; classif: Classificacao }[];
  cfgQ: { data?: ShopeeAdsConfig; isLoading: boolean; isFetching: boolean; isError: boolean; error: unknown };
  marcacoesPorItem: Map<string, Marcacao[]> | undefined;
  chips: { label: string; onRemove: () => void }[];
  limparTudo: () => void;
  toggleClassif: (c: Classificacao) => void;
  onSort: (k: SortKey) => void;
  altoAcos: number;
  onUsarAntigo: () => void;
}

const R = 22; // raio dos cartões
const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: R, boxShadow: "var(--pm-sh)" };
const kicker: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--pm-t3)" };
const pil: CSSProperties = { border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", borderRadius: 999, padding: "6px 12px", font: "inherit", fontWeight: 500, cursor: "pointer", fontSize: 12.5 };

const LOJAS_SEG = (empresas: string[]) => [{ id: "all", nome: "Todas" }, ...empresas.map((e) => ({ id: e, nome: /svl/i.test(e) ? "Bumi" : /ottz/i.test(e) ? "Ottz" : e }))];
const STATUS_SEG: { id: SearchParams["status"]; nome: string }[] = [
  { id: "all", nome: "Todos" }, { id: "ongoing", nome: "Em andamento" }, { id: "paused", nome: "Pausado" }, { id: "closed", nome: "Encerrado" },
];
const ORDENS: { id: SortKey; nome: string }[] = [{ id: "investimento", nome: "Investimento" }, { id: "roas", nome: "ROAS" }, { id: "mc", nome: "MC" }, { id: "vendas", nome: "Vendas" }, { id: "cliques", nome: "Cliques" }];

/** Tom do cartão de situação: vermelho perde dinheiro, âmbar atenção, verde oportunidade. */
const TOM_SIT: Record<string, "r" | "a" | "g"> = {
  prejuizo: "r", gasto_sem_venda: "r", clique_sem_conversao: "a", ctr_baixo: "a", abaixo_meta: "a", escalar: "g", orcamento_limitando: "g",
};
const COR_TOM = { r: "var(--pm-r)", a: "var(--pm-am)", g: "var(--pm-g)" };

export function AdsShopeeNovo(p: AdsShopeeNovoProps) {
  const { sp, update, faixas, acosAlvo, range, anuncios, cfgQ } = p;
  const [analise, setAnalise] = useState<{ shopId: number | string; campaignId: number | string; nome: string; itemId?: number | string | null } | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [maisFiltros, setMaisFiltros] = useState(false);
  const totalPages = Math.max(1, Math.ceil(p.total / PAGE_SIZE));

  // R$ em jogo por situação: só o que está na página (o banco só devolve a CONTAGEM por situação);
  // soma o investimento das linhas da página com a situação. Mostrado como "nesta página".
  const rsSituacao = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of anuncios) for (const k of a.situacoes ?? []) m[k] = (m[k] ?? 0) + num(a.investimento);
    return m;
  }, [anuncios]);

  const abrirAnalise = (a: AnuncioRow) => a.shop_id != null && setAnalise({ shopId: a.shop_id, campaignId: a.campaign_id, nome: a.anuncio ?? String(a.campaign_id), itemId: a.item_id });

  const filtrosLojaStatus = (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={kicker}>Loja</span>
      <SegPill ops={LOJAS_SEG(p.empresas)} valor={sp.empresa} onValor={(v) => update({ empresa: v })} />
      <span style={{ ...kicker, marginLeft: 6 }}>Situação</span>
      <SegPill ops={STATUS_SEG} valor={sp.status} onValor={(v) => update({ status: v as SearchParams["status"] })} />
    </div>
  );

  return (
    <div className="pm-ui" style={{ color: "var(--pm-t)", fontSize: 13, padding: "18px 24px 40px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 1480, margin: "0 auto" }}>
      {/* topo */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: "-.01em" }}>ADS Shopee</h1>
          <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>
            {fmtDate(range.from)} a {fmtDate(range.to)} · {formatNumber(p.totais.anuncios)} anúncios com gasto · meta de ROAS, orçamento e "impulsionado" lidos agora na Shopee
            {cfgQ.isFetching ? " (atualizando…)" : ""}
          </div>
        </div>
        {filtrosLojaStatus}
        <button type="button" onClick={p.onUsarAntigo} style={{ ...pil, fontSize: 11.5, color: "var(--pm-t3)" }} title="Volta ao visual anterior desta tela (fica guardado neste navegador)">visual antigo</button>
      </div>

      {/* pede decisão */}
      <div>
        <div style={{ ...kicker, marginBottom: 8 }}>Pede decisão <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>· clique filtra a lista · R$ = investido nesta página</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {SITUACOES.map((s) => {
            const n = p.situacoes[s.k] ?? 0;
            const tom = TOM_SIT[s.k] ?? "a";
            const on = sp.sit === s.k;
            return (
              <button key={s.k} type="button" onClick={() => update({ sit: on ? undefined : s.k })} title={`${s.dica}\nRegra: ${s.regra(p.limiares, faixas)}`}
                className="pm-hv"
                style={{ ...cartao, borderRadius: 20, padding: "14px 16px 14px 22px", textAlign: "left", cursor: "pointer", position: "relative", display: "flex", flexDirection: "column", gap: 3, font: "inherit", color: "inherit",
                  borderColor: on ? "var(--pm-a)" : "var(--pm-bs)", background: on ? "var(--pm-as)" : "var(--pm-s)", opacity: n === 0 && !on ? 0.6 : 1 }}>
                <span style={{ position: "absolute", left: 10, top: 16, bottom: 16, width: 5, borderRadius: 5, background: COR_TOM[tom] }} />
                <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", fontVariantNumeric: "tabular-nums" }}>
                  {formatNumber(n)}
                  {rsSituacao[s.k] > 0 && <small style={{ fontSize: 12, fontWeight: 500, color: "var(--pm-t3)", marginLeft: 6 }}>{formatBRL(rsSituacao[s.k], { compact: true })}</small>}
                </span>
                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{s.label}</span>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{s.dica}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        <Kpi rotulo="Investimento" valor={formatBRL(p.totais.inv)} />
        <Kpi rotulo="Vendas pelo ADS" valor={formatBRL(p.totais.vendas)} />
        <Kpi rotulo="ROAS" valor={p.totais.roas > 0 ? fmtRoas(p.totais.roas) : "—"} cor={faixas ? (p.totais.roas >= faixas.roas_bom ? "var(--pm-g)" : p.totais.roas < faixas.roas_ok ? "var(--pm-r)" : undefined) : undefined}
          sub={faixas ? `bom ≥ ${faixas.roas_bom}x · ok ≥ ${faixas.roas_ok}x` : undefined} />
        <Kpi rotulo="ACOS" valor={p.totais.acos > 0 ? formatPercent(p.totais.acos) : "—"} cor={p.totais.acos > 0 && p.totais.acos > acosAlvo ? "var(--pm-r)" : undefined}
          sub={<>teto {formatPercent(acosAlvo)}{p.altoAcos > 0 ? ` · ${p.altoAcos} acima nesta página` : ""}</>} />
        <Kpi rotulo="MC % no período" valor={p.mc?.mc_pct != null ? formatPercent(num(p.mc.mc_pct)) : "—"}
          title={p.mc ? `Margem de contribuição dos ${formatNumber(p.mc.anuncios)} anúncios com gasto: margem (recebido − custo − imposto) ÷ venda TOTAL desses produtos, inclusive a que não veio do ADS. Venda ${formatBRL(num(p.mc.venda))} · margem ${formatBRL(num(p.mc.margem))} · ADS ${formatBRL(num(p.mc.gasto))}.` : undefined}
          sub={p.mc?.mc_pos_ads_pct != null ? (
            <>
              <b style={{ color: num(p.mc.mc_pos_ads_pct) < 0 ? "var(--pm-r)" : "var(--pm-g)" }}>{formatPercent(num(p.mc.mc_pos_ads_pct))}</b> depois do ADS
              {p.mc.filtro && p.mc.filtro.anuncios !== p.mc.anuncios ? <span style={{ display: "block" }}>filtro ({formatNumber(p.mc.filtro.anuncios)}): {p.mc.filtro.mc_pct != null ? formatPercent(num(p.mc.filtro.mc_pct)) : "—"} · {p.mc.filtro.mc_pos_ads_pct != null ? formatPercent(num(p.mc.filtro.mc_pos_ads_pct)) : "—"} depois</span> : null}
              {p.mc.parcial && p.mc.desde ? <span style={{ display: "block", color: "var(--pm-am)" }}>só desde {p.mc.desde.split("-").reverse().join("/")}</span> : null}
            </>
          ) : undefined} />
        <Kpi rotulo="Saldo de ADS" valor={cfgQ.data?.lojas.length ? cfgQ.data.lojas.map((l) => `${/svl/i.test(l.loja) ? "Bumi" : "Ottz"} ${l.saldo != null ? formatBRL(l.saldo) : "—"}`).join(" · ") : cfgQ.isLoading ? "…" : "—"} pequeno
          sub={cfgQ.data?.lojas.some((l) => l.recarga_automatica != null) ? cfgQ.data.lojas.map((l) => `${/svl/i.test(l.loja) ? "Bumi" : "Ottz"}: recarga ${l.recarga_automatica ? "ligada" : "desligada"}`).join(" · ") : cfgQ.isError ? "não consegui ler na Shopee" : undefined} />
      </div>

      {p.errAds && <div style={{ ...cartao, padding: 12, color: "var(--pm-r)", background: "var(--pm-rs)" }}>{p.errAds}</div>}

      {/* gráfico + para onde vai */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)", gap: 12 }} className="ads-meio">
        <div style={{ ...cartao, padding: "14px 16px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <b>Investimento e ROAS por dia</b><span style={{ fontSize: 12, color: "var(--pm-t3)" }}>barras = investimento · linha = ROAS</span>
          </div>
          <div style={{ width: "100%", height: 240, marginTop: 6 }}>
            {p.loadingDaily ? <Centro><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</Centro>
              : p.serie.length === 0 ? <Centro>Sem dados no período.</Centro> : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={p.serie} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} vertical={false} />
                    <XAxis dataKey="data" tick={{ fontSize: 11, fill: "var(--pm-t3)" }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "var(--pm-t3)" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatBRL(v, { compact: true })} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "var(--pm-t3)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${Number(v).toFixed(0)}x`} />
                    <RTooltip formatter={(value, name) => { const v = Number(value) || 0; return name === "ROAS" ? [fmtRoas(v), name] : [formatBRL(v), name]; }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar yAxisId="left" dataKey="investimento" name="Investimento" fill="var(--pm-a)" radius={[4, 4, 0, 0]} />
                    <Line yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke="var(--pm-g)" strokeWidth={2.5} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
          </div>
        </div>
        <div style={{ ...cartao, padding: "14px 16px", minWidth: 0 }}>
          <b>Para onde vai o investimento</b>
          <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>por faixa de ROAS · clique filtra a lista</div>
          <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", gap: 3, margin: "8px 0 6px" }}>
            {CLASSIF_ALL.map((c) => { const w = p.totais.inv > 0 ? (p.bucketInv[c] / p.totais.inv) * 100 : 0; return w > 0 ? <div key={c} style={{ width: `${w}%`, background: BUCKET_COLOR[c], borderRadius: 999 }} /> : null; })}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {CLASSIF_ALL.map((c) => {
              const on = sp.classif.includes(c);
              return (
                <button key={c} type="button" onClick={() => p.toggleClassif(c)} className="pm-hv" title={bucketRegra(c, faixas)}
                  style={{ display: "grid", gridTemplateColumns: "10px 1fr auto auto", gap: 10, alignItems: "center", border: `1px solid ${on ? "var(--pm-a)" : "transparent"}`, background: on ? "var(--pm-as)" : "transparent", borderRadius: 999, padding: "6px 10px", font: "inherit", color: "inherit", cursor: "pointer", textAlign: "left" }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: BUCKET_COLOR[c] }} />
                  <span>{CLASSIF_META[c].label} <span style={{ color: "var(--pm-t3)", fontSize: 11.5 }}>· {bucketRegra(c, faixas)}</span></span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatNumber(p.countsByClassif[c])}</span>
                  <span style={{ color: "var(--pm-t3)", fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>{formatBRL(p.bucketInv[c], { compact: true })}</span>
                </button>
              );
            })}
          </div>
          {p.scatterPts.length > 0 && (
            <div style={{ width: "100%", height: 150, marginTop: 8 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 6, right: 8, bottom: 0, left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                  <XAxis type="number" dataKey="investimento" name="Investimento" tick={{ fontSize: 10, fill: "var(--pm-t3)" }} tickFormatter={(v) => formatBRL(Number(v), { compact: true })} axisLine={false} tickLine={false} />
                  <YAxis type="number" dataKey="roas" name="ROAS" tick={{ fontSize: 10, fill: "var(--pm-t3)" }} tickFormatter={(v) => `${Number(v).toFixed(0)}x`} axisLine={false} tickLine={false} />
                  <ZAxis type="number" dataKey="vendas" range={[16, 240]} name="Vendas" />
                  {faixas && <ReferenceLine y={faixas.roas_ok} stroke="var(--pm-r)" strokeDasharray="5 4" ifOverflow="extendDomain" />}
                  <RTooltip cursor={{ strokeDasharray: "3 3" }} formatter={(value, name) => { const v = Number(value) || 0; return name === "ROAS" ? [fmtRoas(v), name] : [formatBRL(v), name]; }} />
                  <Scatter data={p.scatterPts}>{p.scatterPts.map((pt, i) => <Cell key={i} fill={BUCKET_COLOR[pt.classif]} fillOpacity={0.55} />)}</Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <PainelTestesAB />

      {/* lista */}
      <div style={{ ...cartao, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--pm-b)" }}>
          <b>{formatNumber(p.total)} anúncios</b>
          {p.chips.map((c, i) => (
            <button key={i} type="button" onClick={c.onRemove} style={{ ...pil, padding: "2px 10px", fontSize: 11.5, background: "var(--pm-as)", color: "var(--pm-at)", borderColor: "transparent" }}>{c.label} ✕</button>
          ))}
          {p.chips.length > 0 && <button type="button" onClick={p.limparTudo} style={{ border: 0, background: "transparent", color: "var(--pm-at)", cursor: "pointer", fontSize: 11.5 }}>limpar</button>}
          <div style={{ flex: 1 }} />
          <Entrada placeholder="produto, SKU ou campanha" defaultValue={sp.q} style={{ width: 230, borderRadius: 999, height: 32 }}
            onBlur={(e) => e.target.value !== sp.q && update({ q: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") update({ q: (e.target as HTMLInputElement).value }); }} />
          <DashboardPeriodFilter value={range} onChange={p.setRange} />
          <SegPill ops={ORDENS.map((o) => ({ id: o.id, nome: `${o.nome}${sp.sort === o.id ? (sp.dir === "desc" ? " ↓" : " ↑") : ""}` }))} valor={sp.sort} onValor={(v) => p.onSort(v as SortKey)} />
          <button type="button" onClick={() => setMaisFiltros((v) => !v)} style={pil}>{maisFiltros ? "menos filtros" : "mais filtros"}</button>
        </div>
        <div style={{ padding: "10px 16px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid var(--pm-b)" }}>
          {filtrosLojaStatus}
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--pm-t2)", marginLeft: 6 }}>
            <input type="checkbox" checked={sp.tem_gasto} onChange={(e) => update({ tem_gasto: e.target.checked })} /> só com gasto
          </label>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)", marginLeft: "auto" }}>os mesmos filtros do topo — mudar aqui muda a tela toda</span>
        </div>
        {maisFiltros && (
          <div style={{ padding: "10px 16px", display: "flex", gap: 16, flexWrap: "wrap", borderBottom: "1px solid var(--pm-b)", background: "var(--pm-s2)" }}>
            <Faixa rotulo="Investimento (R$)" min={sp.inv_min} max={sp.inv_max} onChange={(mn, mx) => update({ inv_min: mn, inv_max: mx })} />
            <Faixa rotulo="ROAS (x)" min={sp.roas_min} max={sp.roas_max} onChange={(mn, mx) => update({ roas_min: mn, roas_max: mx })} />
            <Faixa rotulo="ACOS (%)" min={sp.acos_min} max={sp.acos_max} onChange={(mn, mx) => update({ acos_min: mn, acos_max: mx })} />
          </div>
        )}
        {cfgQ.isError && <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--pm-am)" }}>Não consegui ler a meta de ROAS na Shopee: {String((cfgQ.error as Error)?.message ?? "")}</div>}

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}>
            <thead>
              <tr>
                <th style={thGrp}></th>
                <th style={{ ...thGrp, ...sepL }} colSpan={2}>Entrega</th>
                <th style={{ ...thGrp, ...sepL }} colSpan={2}>Gasto</th>
                <th style={{ ...thGrp, ...sepL }} colSpan={2}>Retorno</th>
                <th style={{ ...thGrp, ...sepL }}>Margem</th>
                <th style={{ ...thGrp, ...sepL }}></th>
              </tr>
              <tr>
                <Th onClick={() => p.onSort("investimento")}>Anúncio</Th>
                <Th dir sep onClick={() => p.onSort("impressoes")} ativo={sp.sort === "impressoes"}>Impressões · cliques</Th>
                <Th dir onClick={() => p.onSort("ctr")} ativo={sp.sort === "ctr"}>CTR · CPC</Th>
                <Th dir sep onClick={() => p.onSort("investimento")} ativo={sp.sort === "investimento"}>Investido · ACOS</Th>
                <Th dir onClick={() => p.onSort("orcamento_diario")} ativo={sp.sort === "orcamento_diario"}>Orçamento/dia</Th>
                <Th dir sep onClick={() => p.onSort("vendas")} ativo={sp.sort === "vendas"}>Vendas</Th>
                <Th dir onClick={() => p.onSort("roas")} ativo={sp.sort === "roas"}>ROAS × meta</Th>
                <Th dir sep onClick={() => p.onSort("mc")} ativo={sp.sort === "mc"}>MC % · pós-ADS</Th>
                <th style={{ ...th, ...sepL }}></th>
              </tr>
            </thead>
            <tbody>
              {p.loadingAds && <tr><td colSpan={9} style={{ ...td, textAlign: "center", padding: 28, color: "var(--pm-t3)" }}><Loader2 className="h-4 w-4 animate-spin inline-block mr-2" /> Carregando…</td></tr>}
              {!p.loadingAds && anuncios.length === 0 && <tr><td colSpan={9} style={{ ...td, textAlign: "center", padding: 28, color: "var(--pm-t3)" }}>Nenhum anúncio no filtro atual.</td></tr>}
              {!p.loadingAds && anuncios.map((a) => {
                const chave = String(a.campaign_id);
                const roasVal = num(a.roas), acosVal = num(a.acos), inv = num(a.investimento);
                const cfg = cfgQ.data?.porCampanha.get(chave);
                const meta = cfg?.roas_target ?? (a.meta != null ? num(a.meta) : null);
                const eq = a.roas_equilibrio != null ? num(a.roas_equilibrio) : null;
                const tomRoas = inv > 0 && roasVal === 0 ? "r" : eq != null && roasVal < eq ? "r" : meta != null && roasVal < meta * 0.8 ? "a" : "g";
                const corRoas = tomRoas === "r" ? "var(--pm-r)" : tomRoas === "a" ? "var(--pm-am)" : "var(--pm-g)";
                const maxTrk = Math.max(roasVal, meta ?? 0, 1);
                const orcamento = cfg ? cfg.budget : a.orcamento_diario;
                const dias = Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / 86_400_000) + 1);
                const usoOrc = orcamento != null && Number(orcamento) > 0 ? Math.min(100, (inv / dias) / Number(orcamento) * 100) : null;
                const impulsionado = a.item_id != null && !!cfgQ.data?.impulsionados.has(String(a.item_id));
                const marcs = marcacoesDoItem(p.marcacoesPorItem, a.shop_id, a.item_id);
                const on = aberto === chave;
                const classif = (a.classificacao_roas ?? "sem_dado") as Classificacao;
                return (
                  <Fragment key={chave}>
                    <tr className="pm-linha-hv" style={{ background: on ? "var(--pm-as)" : undefined, cursor: "pointer" }} onClick={() => setAberto(on ? null : chave)}>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 280 }}>
                          <Foto src={a.foto} alt={a.anuncio ?? ""} tam={44} />
                          <div style={{ minWidth: 0 }}>
                            <button type="button" onClick={(e) => { e.stopPropagation(); abrirAnalise(a); }} title="Análise por dia (meta, orçamento, margem e diagnóstico)"
                              style={{ border: 0, background: "transparent", padding: 0, font: "inherit", fontWeight: 600, color: "inherit", cursor: "pointer", display: "block", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                              {a.anuncio}
                            </button>
                            <div style={{ fontSize: 11.5, color: "var(--pm-t3)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                              <SeloLoja empresa={a.empresa} />
                              <span>{a.sku_pai ? `${a.sku_pai} · ` : ""}{a.tipo_anuncio ?? ""}</span>
                              <SeloStatus status={a.status} />
                              {impulsionado && <SeloImpulsionado />}
                              {(a.situacoes ?? []).map((k) => { const s = SIT_POR_K.get(k); if (!s) return null; const t = TOM_SIT[k] ?? "a"; return <Selo key={k} tom={t}>{s.label}</Selo>; })}
                              {marcs.map((m) => <EtiquetaMarcacao key={m.id} m={m} onClick={() => abrirAnalise(a)} />)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...td, ...sepL, textAlign: "right" }}><div style={big}>{formatNumber(num(a.impressoes))}</div><div style={mini}>{formatNumber(num(a.cliques))} cliques</div></td>
                      <td style={{ ...td, textAlign: "right" }}><div>{num(a.ctr) > 0 ? formatPercent(num(a.ctr)) : "—"}</div><div style={mini}>{num(a.cpc) > 0 ? formatBRL(num(a.cpc)) : "—"}</div></td>
                      <td style={{ ...td, ...sepL, textAlign: "right" }}><div style={big}>{formatBRL(inv)}</div><div style={{ ...mini, color: acosVal > acosAlvo && inv > 0 ? "var(--pm-r)" : undefined }}>{inv > 0 && num(a.vendas) > 0 ? `ACOS ${formatPercent(acosVal)}` : inv > 0 ? "sem venda" : "—"}</div></td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <div>{cfg ? textoOrcamento(cfg.budget) : num(a.orcamento_diario) > 0 ? formatBRL(num(a.orcamento_diario)) : "—"}</div>
                        {usoOrc != null && <><div style={{ height: 6, borderRadius: 999, background: "var(--pm-s2)", marginTop: 4, overflow: "hidden" }}><i style={{ display: "block", height: "100%", width: `${usoOrc}%`, background: usoOrc >= 90 ? "var(--pm-am)" : "var(--pm-a)", borderRadius: 999 }} /></div><div style={mini}>{Math.round(usoOrc)}% usado/dia</div></>}
                      </td>
                      <td style={{ ...td, ...sepL, textAlign: "right" }}><div style={big}>{formatBRL(num(a.vendas))}</div><div style={mini}>{num(a.pedidos) > 0 ? `${formatNumber(num(a.pedidos))} pedidos` : ""}</div></td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                          <span style={{ ...big, color: corRoas }}>{roasVal > 0 ? fmtRoas(roasVal) : "—"} <span style={mini}>· {cfgQ.isLoading ? "…" : meta != null ? `meta ${String(meta).replace(".", ",")}` : cfg?.ad_type === "auto" ? "auto" : "sem meta"}</span></span>
                          <div style={{ width: 92, height: 8, borderRadius: 999, background: "var(--pm-s2)", position: "relative", overflow: "hidden" }} title={`ROAS ${fmtRoas(roasVal)}${meta != null ? ` · meta ${meta}x` : ""}${eq != null ? ` · equilíbrio ${fmtRoas(eq)} (100 ÷ MC sem ADS)` : ""} · faixa ${CLASSIF_META[classif]?.label ?? ""}`}>
                            <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, (roasVal / maxTrk) * 100)}%`, background: corRoas, borderRadius: 999 }} />
                            {meta != null && <b style={{ position: "absolute", top: -3, bottom: -3, width: 3, borderRadius: 3, background: "var(--pm-t2)", left: `${Math.min(99, (meta / maxTrk) * 100)}%` }} />}
                          </div>
                        </div>
                      </td>
                      <td style={{ ...td, ...sepL, textAlign: "right" }} title={a.mc_pct != null ? `Margem do produto no período (venda total ${formatBRL(num(a.venda_item))}, não só a do ADS). Sem ADS ${formatPercent(num(a.mc_pct))}; depois do ADS do produto ${formatPercent(num(a.mc_pos_ads_pct))}.` : "Sem venda com custo no período"}>
                        {a.mc_pct != null ? (<><div style={{ ...big, color: num(a.mc_pct) < 0 ? "var(--pm-r)" : num(a.mc_pct) < 10 ? "var(--pm-am)" : undefined }}>{formatPercent(num(a.mc_pct))}</div>
                          {a.mc_pos_ads_pct != null && <div style={{ ...mini, color: num(a.mc_pos_ads_pct) < 0 ? "var(--pm-r)" : "var(--pm-g)" }}>{formatPercent(num(a.mc_pos_ads_pct))} pós-ADS</div>}</>)
                          : <><div style={{ ...big, color: "var(--pm-t3)" }}>—</div><div style={mini}>sem custo</div></>}
                      </td>
                      <td style={{ ...td, ...sepL, whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          {cfgQ.isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <MetaRoasCelula cfg={cfg} nome={a.anuncio ?? chave} roasAtual={roasVal} />}
                          <button type="button" onClick={() => setAberto(on ? null : chave)} style={{ ...pil, padding: "2px 9px", fontSize: 11 }}>{on ? "fechar ▴" : "abrir ▾"}</button>
                        </div>
                      </td>
                    </tr>
                    {on && (
                      <tr>
                        <td colSpan={9} style={{ ...td, background: "var(--pm-s2)", padding: "14px 18px 16px" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, fontSize: 12.5 }}>
                            <div>
                              <h4 style={h4}>Situações no período</h4>
                              {(a.situacoes?.length ?? 0) === 0 ? <div style={{ color: "var(--pm-t3)" }}>Nenhuma situação apontada — dentro das regras.</div> : (
                                <ul style={ul}>{a.situacoes!.map((k) => { const s = SIT_POR_K.get(k); return s ? <li key={k}><b>{s.label}:</b> {s.dica} <span style={{ color: "var(--pm-t3)" }}>({s.regra(p.limiares, faixas)})</span></li> : null; })}</ul>
                              )}
                            </div>
                            <div>
                              <h4 style={h4}>Números</h4>
                              <ul style={ul}>
                                <li>ROAS {roasVal > 0 ? fmtRoas(roasVal) : "—"} · faixa {CLASSIF_META[classif]?.label ?? "—"}{meta != null ? ` · meta ${meta}x` : ""}{eq != null ? ` · equilíbrio ${fmtRoas(eq)}` : ""}</li>
                                <li>{formatNumber(num(a.impressoes))} impressões · {formatNumber(num(a.cliques))} cliques · CTR {num(a.ctr) > 0 ? formatPercent(num(a.ctr)) : "—"} · CPC {num(a.cpc) > 0 ? formatBRL(num(a.cpc)) : "—"}</li>
                                <li>Investido {formatBRL(inv)} · vendas {formatBRL(num(a.vendas))} · {formatNumber(num(a.pedidos))} pedidos</li>
                                {a.mc_pct != null && <li>MC do produto {formatPercent(num(a.mc_pct))} (venda total {formatBRL(num(a.venda_item))}) · {formatPercent(num(a.mc_pos_ads_pct))} depois do ADS</li>}
                              </ul>
                            </div>
                            <div>
                              <h4 style={h4}>{marcs.length ? "O que fazer (teste em andamento)" : "Ações"}</h4>
                              {marcs.map((m) => <BlocoOQueFazer key={m.id} m={m} compacto />)}
                              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                                <Botao tom="primario" onClick={() => abrirAnalise(a)}>Análise completa por dia</Botao>
                                {cfg?.ad_type === "manual" && <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--pm-t2)" }}><Pencil className="h-3 w-3" /> meta e orçamento: lápis na linha</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--pm-b)", fontSize: 11.5, color: "var(--pm-t3)" }}>
          <span>Barra do ROAS: preenchimento = ROAS do período, traço = meta. Verde atinge · âmbar abaixo de 80% da meta · vermelho abaixo do equilíbrio (a margem não cobre). Clique na linha para abrir; no nome, a análise por dia.</span>
          <div style={{ flex: 1 }} />
          {p.total > PAGE_SIZE && (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              Página {sp.pagina} de {totalPages}
              <button type="button" style={pil} disabled={sp.pagina <= 1} onClick={() => update({ pagina: sp.pagina - 1 }, false)}>Anterior</button>
              <button type="button" style={pil} disabled={sp.pagina >= totalPages} onClick={() => update({ pagina: sp.pagina + 1 }, false)}>Próxima</button>
            </span>
          )}
        </div>
      </div>

      {analise && <AnaliseAnuncioAds shopId={analise.shopId} campaignId={analise.campaignId} nome={analise.nome} periodo={range} onFechar={() => setAnalise(null)}
        topo={marcacoesDoItem(p.marcacoesPorItem, analise.shopId, analise.itemId).length > 0 ? (
          <div className="space-y-2"><div className="text-sm font-semibold">O que fazer</div>{marcacoesDoItem(p.marcacoesPorItem, analise.shopId, analise.itemId).map((m) => <BlocoOQueFazer key={m.id} m={m} />)}</div>
        ) : undefined} />}
      <style>{`@media (max-width: 900px){ .pm-ui .ads-meio { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

// ─── peças ────────────────────────────────────────────────────────────────
const th: CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--pm-t3)", textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--pm-b)", whiteSpace: "nowrap", background: "var(--pm-s)" };
const thGrp: CSSProperties = { ...th, color: "var(--pm-t2)", textTransform: "uppercase", letterSpacing: ".05em", borderBottom: 0, paddingBottom: 2, paddingTop: 12 };
const sepL: CSSProperties = { borderLeft: "1px solid var(--pm-b)" };
const td: CSSProperties = { padding: "11px 10px", borderBottom: "1px solid var(--pm-b)", verticalAlign: "middle", fontVariantNumeric: "tabular-nums" };
const big: CSSProperties = { fontWeight: 700, fontSize: 13.5 };
const mini: CSSProperties = { fontSize: 11, color: "var(--pm-t3)" };
const h4: CSSProperties = { margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" };
const ul: CSSProperties = { margin: 0, paddingLeft: 16, color: "var(--pm-t2)", display: "flex", flexDirection: "column", gap: 3 };

function Th({ children, dir, sep, ativo, onClick }: { children: ReactNode; dir?: boolean; sep?: boolean; ativo?: boolean; onClick: () => void }) {
  return (
    <th style={{ ...th, ...(sep ? sepL : {}), textAlign: dir ? "right" : "left", color: ativo ? "var(--pm-t)" : "var(--pm-t3)" }}>
      <button type="button" onClick={onClick} style={{ border: 0, background: "transparent", font: "inherit", color: "inherit", cursor: "pointer", padding: 0 }}>{children}{ativo ? " •" : ""}</button>
    </th>
  );
}
function Centro({ children }: { children: ReactNode }) {
  return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--pm-t3)" }}>{children}</div>;
}
function Kpi({ rotulo, valor, sub, cor, title, pequeno }: { rotulo: string; valor: string; sub?: ReactNode; cor?: string; title?: string; pequeno?: boolean }) {
  return (
    <div style={{ ...cartao, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 2 }} title={title}>
      <span style={kicker}>{rotulo}</span>
      <span style={{ fontSize: pequeno ? 15 : 22, fontWeight: 700, letterSpacing: "-.02em", fontVariantNumeric: "tabular-nums", color: cor }}>{valor}</span>
      {sub && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{sub}</span>}
    </div>
  );
}
function SegPill<T extends string>({ ops, valor, onValor }: { ops: { id: T; nome: string }[]; valor: string; onValor: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 999, padding: 3, gap: 2, background: "var(--pm-s)" }}>
      {ops.map((o) => { const on = o.id === valor; return (
        <button key={o.id} type="button" onClick={() => onValor(o.id)} style={{ border: 0, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t)", font: "inherit", fontSize: 12.5, fontWeight: on ? 600 : 500, padding: "5px 13px", cursor: "pointer", borderRadius: 999, whiteSpace: "nowrap" }}>{o.nome}</button>
      ); })}
    </div>
  );
}
function SeloLoja({ empresa }: { empresa: string | null }) {
  if (!empresa) return null;
  const svl = /svl/i.test(empresa);
  return <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 20, background: svl ? "#e9e3fb" : "#fdebd9", color: svl ? "#5c3fb3" : "#a0520f", whiteSpace: "nowrap" }}>{svl ? "Bumi" : "Ottz"}</span>;
}
function SeloStatus({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "ongoing") return <Selo tom="g">em andamento</Selo>;
  if (s === "paused") return <Selo tom="a">pausado</Selo>;
  if (s === "closed") return <Selo tom="n">encerrado</Selo>;
  return null;
}
function Faixa({ rotulo, min, max, onChange }: { rotulo: string; min?: number; max?: number; onChange: (mn?: number, mx?: number) => void }) {
  const [mn, setMn] = useState(min?.toString() ?? ""); const [mx, setMx] = useState(max?.toString() ?? "");
  const parse = (v: string) => { if (!v.trim()) return undefined; const n = Number(v.replace(",", ".")); return Number.isFinite(n) ? n : undefined; };
  const commit = () => onChange(parse(mn), parse(mx));
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--pm-t3)" }}>
      {rotulo}
      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        <Entrada inputMode="decimal" placeholder="mín" value={mn} onChange={(e) => setMn(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} style={{ width: 80, height: 30, borderRadius: 999 }} />
        –
        <Entrada inputMode="decimal" placeholder="máx" value={mx} onChange={(e) => setMx(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} style={{ width: 80, height: 30, borderRadius: 999 }} />
      </span>
    </label>
  );
}
