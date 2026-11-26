import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

import { L, ddmm, idade, pct, rpc } from "@/components/dashboard/formato";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Painel financeiro (26/nov/2026; desenho aprovado pelo dono, com pedido de ser interativo:
// clicar em qualquer indicador abre o detalhe dele). Tudo vem de financeiro_painel()
// (docs/financeiro-painel.sql); os detalhes de contas a pagar leem view_fin_contas_pagar
// e o de estoque chama dashboard_estoque_valor(), só quando abertos.
// Os saldos de banco ainda não entram: caixa = carteiras Shopee + Mercado Pago.
// ============================================================================

interface Mes {
  mes: string; receita: number; cmv: number; deducoes: number; impostos: number; mc: number; mc_pct: number | null;
  ads: number; fixo: number; despesas: number; ads_pct: number | null; despesas_pct: number | null;
  lucro: number; lucro_pct: number | null; equilibrio: number | null;
}
interface Carteira { carteira: string; marketplace: string; valor: number; pedidos?: number; estimado?: boolean; saldo_em?: string | null }
interface Decisao { tom: "red" | "amber"; o_que: string; detalhe: string; valor?: number; link: string }
interface Painel {
  gerado_em: string; hoje: string; meses: Mes[];
  mes_atual: { mes: string; dia: number; dias_mes: number; receita_projetada: number | null };
  capital: {
    caixa: number; carteiras: number; mercado_pago: number; mercado_pago_dia: string | null;
    mercado_pago_por: Array<{ conta: number; saldo: number; dia: string }> | null; caixa_por: Carteira[] | null;
    receber: number; receber_por: Carteira[] | null; estoque: number; estoque_parado: number;
    estoque_galpao: number | null; estoque_full: number | null;
    pagar: number; pagar_mercadoria: number; pagar_30d: number; pagar_atrasado: number; giro: number;
  };
  ciclo: { estoque_dias: number | null; receber_dias: number | null; pagar_dias: number | null; ciclo_dias: number | null; cmv_dia: number; venda_dia: number; repasse_dia: number; compras_dia: number };
  liquidez: { sem_estoque: number | null; com_estoque: number | null };
  pagar: { por_categoria: Array<{ categoria: string; valor: number; contas: number; ate_30d: number }>; por_faixa: Record<string, { valor: number; contas: number }> };
  decisoes: Decisao[];
}
interface Conta { tiny_id: number; fornecedor_nome: string | null; descricao: string | null; categoria: string | null; saldo_aberto: number; data_vencimento: string | null; dias_para_vencer: number | null; faixa: string }
interface EstoqueDet {
  valor_total: number; valor_geral: number; valor_full: number; cobertura_media_dias: number | null;
  full: { amazon: number; mercado_livre: number; shopee: number; a_caminho: number };
  parado: { valor: number; excesso: { valor: number; produtos: number }; sem_giro: { valor: number; produtos: number } };
  presos?: Array<{ sku: string; nome: string; valor: number; situacao: string; cobertura_dias: number | null }>;
  ruptura?: { receita_dia: number; unidades_dia: number };
}

type Chave = "lucro" | "receita" | "equilibrio" | "giro" | "liquidez" | "ciclo" | "caixa" | "receber" | "estoque" | "fornecedores" | "outras" | "atrasadas" | "cem";

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const nomeMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const n = (v: unknown) => Number(v ?? 0);
const MONO = "pm-mono";

// ---------------------------------------------------------------- peças
const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "14px 16px", minWidth: 0 };
const rot: CSSProperties = { fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--pm-t3)", fontWeight: 600 };
const sub: CSSProperties = { fontSize: 12, color: "var(--pm-t3)" };
const TOM: Record<string, { c: string; s: string }> = {
  ok: { c: "var(--pm-g)", s: "var(--pm-gs)" }, warn: { c: "var(--pm-am)", s: "var(--pm-ams)" },
  bad: { c: "var(--pm-r)", s: "var(--pm-rs)" }, n: { c: "var(--pm-t2)", s: "var(--pm-s2)" },
};
function Pill({ tom, children }: { tom: string; children: ReactNode }) {
  const t = TOM[tom] ?? TOM.n;
  return <span style={{ display: "inline-block", borderRadius: 999, padding: "1px 9px", fontSize: 11.5, fontWeight: 600, background: t.s, color: t.c, whiteSpace: "nowrap" }}>{children}</span>;
}
function Linha({ nome, valor, forte, tom, onClick, aberto, nota }: { nome: ReactNode; valor: ReactNode; forte?: boolean; tom?: string; onClick?: () => void; aberto?: boolean; nota?: ReactNode }) {
  const corpo = (
    <>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: forte ? "var(--pm-t)" : "var(--pm-t2)", minWidth: 0, textAlign: "left" }}>
        {onClick && (aberto ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        <span style={{ minWidth: 0 }}>{nome}{nota && <span style={{ ...sub, marginLeft: 6 }}>{nota}</span>}</span>
      </span>
      <b className={MONO} style={{ fontWeight: forte ? 700 : 600, color: tom ? TOM[tom].c : "var(--pm-t)", whiteSpace: "nowrap" }}>{valor}</b>
    </>
  );
  const st: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "6px 8px", borderRadius: 8, fontSize: 13, width: "100%", background: aberto ? "var(--pm-s2)" : "transparent", border: 0, borderTop: forte ? "1px solid var(--pm-b)" : 0, color: "inherit" };
  return onClick
    ? <button type="button" className="pm-linha-hv" onClick={onClick} style={{ ...st, cursor: "pointer" }}>{corpo}</button>
    : <div style={st}>{corpo}</div>;
}
function Barra({ nome, valor, max, cor, direita }: { nome: ReactNode; valor: number; max: number; cor: string; direita: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 170px) 1fr auto", gap: 10, alignItems: "center", fontSize: 13 }}>
      <span style={{ color: "var(--pm-t2)" }}>{nome}</span>
      <div style={{ background: "var(--pm-s2)", borderRadius: 7, height: 14, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, (valor / (max || 1)) * 100))}%`, height: "100%", borderRadius: 7, background: cor }} />
      </div>
      <b className={MONO} style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{direita}</b>
    </div>
  );
}

// ---------------------------------------------------------------- contas a pagar (detalhe por fornecedor)
function ContasAgrupadas({ filtro }: { filtro: (c: Conta) => boolean }) {
  const q = useQuery({
    queryKey: ["financeiro", "contas-abertas"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_fin_contas_pagar" as never)
        .select("tiny_id,fornecedor_nome,descricao,categoria,saldo_aberto,data_vencimento,dias_para_vencer,faixa").limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as Conta[];
    },
  });
  const [aberto, setAberto] = useState<string | null>(null);
  const grupos = useMemo(() => {
    const m = new Map<string, Conta[]>();
    for (const c of (q.data ?? []).filter(filtro)) {
      const k = c.fornecedor_nome || "Sem fornecedor";
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()].map(([nome, contas]) => ({
      nome, contas: contas.sort((a, b) => String(a.data_vencimento).localeCompare(String(b.data_vencimento))),
      total: contas.reduce((s, c) => s + n(c.saldo_aberto), 0),
      atrasado: contas.filter((c) => c.faixa === "atrasado").reduce((s, c) => s + n(c.saldo_aberto), 0),
      proxima: contas.map((c) => c.data_vencimento).filter(Boolean).sort()[0] ?? null,
    })).sort((a, b) => b.total - a.total);
  }, [q.data, filtro]);
  if (q.isLoading) return <div style={sub}>Carregando as contas…</div>;
  if (q.error) return <div style={{ ...sub, color: "var(--pm-r)" }}>Não consegui ler as contas: {(q.error as Error).message}</div>;
  if (!grupos.length) return <div style={sub}>Nenhuma conta em aberto neste recorte.</div>;
  const max = grupos[0].total;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {grupos.map((g) => (
        <div key={g.nome}>
          <Linha aberto={aberto === g.nome} onClick={() => setAberto(aberto === g.nome ? null : g.nome)}
            nome={g.nome} nota={<>{g.contas.length} conta(s){g.proxima ? ` · próxima ${ddmm(g.proxima)}` : ""}{g.atrasado > 0 ? ` · ${L(g.atrasado)} atrasado` : ""}</>}
            valor={L(g.total)} tom={g.atrasado > 0 ? "bad" : undefined} />
          {aberto !== g.nome && <div style={{ height: 3, margin: "0 8px 4px", borderRadius: 2, background: "var(--pm-s2)" }}><div style={{ width: `${(g.total / max) * 100}%`, height: "100%", borderRadius: 2, background: "var(--pm-a)" }} /></div>}
          {aberto === g.nome && (
            <div style={{ margin: "2px 0 8px 22px", display: "flex", flexDirection: "column", gap: 1 }}>
              {g.contas.map((c) => (
                <div key={c.tiny_id} style={{ display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 10, fontSize: 12.5, padding: "4px 8px", alignItems: "baseline" }}>
                  <span className={MONO} style={{ color: c.faixa === "atrasado" ? "var(--pm-r)" : c.faixa === "hoje" ? "var(--pm-am)" : "var(--pm-t2)", fontWeight: 600 }}>{c.data_vencimento ? ddmm(c.data_vencimento) : "—"}</span>
                  <span style={{ color: "var(--pm-t2)", minWidth: 0, overflowWrap: "anywhere" }}>{c.descricao || "(sem descrição)"}{c.faixa === "atrasado" && <> · <b style={{ color: "var(--pm-r)" }}>{Math.abs(n(c.dias_para_vencer))} dia(s) de atraso</b></>}</span>
                  <b className={MONO} style={{ fontWeight: 600 }}>{L(n(c.saldo_aberto))}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <Link to="/contas-pagar" search={{} as never} style={{ fontSize: 12, fontWeight: 500, color: "var(--pm-at)", textDecoration: "none", padding: "6px 8px" }}>Abrir Contas a Pagar ›</Link>
    </div>
  );
}

// ---------------------------------------------------------------- estoque (detalhe)
function EstoqueDetalhe() {
  const q = useQuery({ queryKey: ["financeiro", "estoque-valor"], queryFn: () => rpc<EstoqueDet>("dashboard_estoque_valor") });
  if (q.isLoading) return <div style={sub}>Carregando o estoque…</div>;
  if (q.error || !q.data) return <div style={{ ...sub, color: "var(--pm-r)" }}>Não consegui ler o estoque.</div>;
  const e = q.data;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Linha nome="No galpão" valor={L(n(e.valor_geral))} />
      <Linha nome="Nos Fulls" nota={`Amazon ${L(n(e.full?.amazon))} · Mercado Livre ${L(n(e.full?.mercado_livre))} · Shopee ${L(n(e.full?.shopee))} · a caminho ${L(n(e.full?.a_caminho))}`} valor={L(n(e.valor_full))} />
      <Linha forte nome="Estoque a custo" nota={e.cobertura_media_dias ? `≈ ${e.cobertura_media_dias} dias de venda` : undefined} valor={L(n(e.valor_total))} />
      <div style={{ ...rot, margin: "10px 8px 2px" }}>Parado</div>
      <Linha nome="Excesso (mais de 120 dias de venda)" nota={`${e.parado.excesso.produtos} produtos`} valor={L(n(e.parado.excesso.valor))} tom="warn" />
      <Linha nome="Sem giro (não vendeu em 30 dias)" nota={`${e.parado.sem_giro.produtos} produtos`} valor={L(n(e.parado.sem_giro.valor))} tom="warn" />
      {(e.presos ?? []).length > 0 && <div style={{ ...rot, margin: "10px 8px 2px" }}>Os que mais prendem dinheiro</div>}
      {(e.presos ?? []).map((p) => (
        <Linha key={p.sku} nome={<><span className={MONO}>{p.sku}</span> · {p.nome}</>} nota={p.situacao === "sem_giro" ? "sem giro" : `excesso${p.cobertura_dias ? ` · ${p.cobertura_dias} dias` : ""}`} valor={L(n(p.valor))} />
      ))}
      {e.ruptura && <Linha nome="Do outro lado: produtos em falta" nota={`${Math.round(n(e.ruptura.unidades_dia))} un/dia sem estoque`} valor={`${L(n(e.ruptura.receita_dia))}/dia`} tom="bad" />}
    </div>
  );
}

// ---------------------------------------------------------------- gráfico receita × equilíbrio
function Grafico({ meses, parcial, sel, onSel }: { meses: Mes[]; parcial: string; sel: string; onSel: (m: string) => void }) {
  const W = 560, H = 240, Lx = 40, Rx = 36, T = 14, B = 26;
  const mx = Math.max(...meses.map((m) => Math.max(n(m.receita), n(m.equilibrio)))) * 1.08 || 1;
  const pmx = Math.max(8, ...meses.map((m) => n(m.lucro_pct))) , pmn = Math.min(0, ...meses.map((m) => n(m.lucro_pct)));
  const bw = (W - Lx - Rx) / meses.length;
  const y = (v: number) => T + (H - T - B) * (1 - v / mx);
  const yp = (p: number) => T + (H - T - B) * (1 - (p - pmn) / (pmx - pmn || 1));
  const passo = mx > 600000 ? 200000 : mx > 250000 ? 100000 : 50000;
  const ticks = Array.from({ length: Math.floor(mx / passo) + 1 }, (_, i) => i * passo);
  const pts = meses.map((m, i) => `${Lx + i * bw + bw / 2},${yp(n(m.lucro_pct))}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Receita, ponto de equilíbrio e lucro por mês">
      {ticks.map((t) => (
        <g key={t}><line x1={Lx} x2={W - Rx} y1={y(t)} y2={y(t)} stroke="var(--pm-b)" strokeWidth={1} />
          <text x={Lx - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--pm-t3)">{t / 1000}</text></g>
      ))}
      <text x={W - Rx + 5} y={yp(pmx) + 4} fontSize={11} fill="var(--pm-t3)">{Math.round(pmx)}%</text>
      <text x={W - Rx + 5} y={yp(0) + 4} fontSize={11} fill="var(--pm-t3)">0%</text>
      {meses.map((m, i) => {
        const x = Lx + i * bw + bw * 0.2, w = bw * 0.6, cx = Lx + i * bw + bw / 2;
        return (
          <g key={m.mes} onClick={() => onSel(m.mes)} style={{ cursor: "pointer" }}>
            <rect x={Lx + i * bw} y={T} width={bw} height={H - T - B} fill={sel === m.mes ? "var(--pm-as)" : "transparent"} rx={6} />
            <rect x={x} y={y(n(m.receita))} width={w} height={Math.max(0, y(0) - y(n(m.receita)))} rx={5} fill="var(--pm-a)" opacity={m.mes === parcial ? 0.55 : 1} />
            {m.equilibrio != null && <line x1={x - 5} x2={x + w + 5} y1={y(n(m.equilibrio))} y2={y(n(m.equilibrio))} stroke="var(--pm-am)" strokeWidth={3} strokeLinecap="round" />}
            <text x={cx} y={H - 8} textAnchor="middle" fontSize={11} fill={sel === m.mes ? "var(--pm-t)" : "var(--pm-t3)"} fontWeight={sel === m.mes ? 700 : 400}>{nomeMes(m.mes)}</text>
          </g>
        );
      })}
      <polyline points={pts} fill="none" stroke="var(--pm-g)" strokeWidth={2.5} strokeLinejoin="round" />
      {meses.map((m, i) => <circle key={m.mes} cx={Lx + i * bw + bw / 2} cy={yp(n(m.lucro_pct))} r={4} fill="var(--pm-s)" stroke="var(--pm-g)" strokeWidth={2.5} />)}
    </svg>
  );
}

/** Cascata do DRE de um mês (do faturamento ao lucro), com o mês anterior ao lado. */
function CascataMes({ m, ant, parcial }: { m: Mes; ant?: Mes; parcial: boolean }) {
  const linhas: Array<[string, number, number | undefined, boolean?]> = [
    ["Receita", m.receita, ant?.receita, true],
    ["− Custo dos produtos", -m.cmv, ant && -ant.cmv],
    ["− Marketplace (comissão e frete)", -m.deducoes, ant && -ant.deducoes],
    ["− Impostos", -m.impostos, ant && -ant.impostos],
    ["Margem de contribuição", m.mc, ant?.mc, true],
    ["− ADS", -m.ads, ant && -ant.ads],
    ["− Despesas fixas", -m.fixo, ant && -ant.fixo],
    ["Lucro líquido", m.lucro, ant?.lucro, true],
  ];
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480, fontSize: 13 }}>
        <thead><tr>
          <th style={{ ...rot, textAlign: "left", padding: "4px 8px" }}>{nomeMes(m.mes)}{parcial ? " (parcial)" : ""}</th>
          <th style={{ ...rot, textAlign: "right", padding: "4px 8px" }}>R$</th>
          <th style={{ ...rot, textAlign: "right", padding: "4px 8px" }}>% da receita</th>
          {ant && <th style={{ ...rot, textAlign: "right", padding: "4px 8px" }}>{nomeMes(ant.mes)} %</th>}
        </tr></thead>
        <tbody>{linhas.map(([nome, v, va, forte]) => (
          <tr key={nome} style={{ borderTop: "1px solid var(--pm-b)", fontWeight: forte ? 700 : 400 }}>
            <td style={{ padding: "6px 8px", color: forte ? "var(--pm-t)" : "var(--pm-t2)" }}>{nome}</td>
            <td className={MONO} style={{ padding: "6px 8px", textAlign: "right", color: v < 0 && forte ? "var(--pm-r)" : undefined }}>{L(v)}</td>
            <td className={MONO} style={{ padding: "6px 8px", textAlign: "right" }}>{m.receita ? pct((Math.abs(v) / m.receita) * 100 * (v < 0 && forte ? -1 : 1)) : "—"}</td>
            {ant && <td className={MONO} style={{ padding: "6px 8px", textAlign: "right", color: "var(--pm-t3)" }}>{va != null && ant.receita ? pct((Math.abs(va) / ant.receita) * 100) : "—"}</td>}
          </tr>
        ))}</tbody>
      </table>
      <Link to="/dre" style={{ display: "inline-block", marginTop: 8, fontSize: 12, fontWeight: 500, color: "var(--pm-at)", textDecoration: "none" }}>Abrir o DRE completo ›</Link>
    </div>
  );
}

// ---------------------------------------------------------------- tela
export function PainelFinanceiro() {
  const q = useQuery({ queryKey: ["financeiro", "painel"], queryFn: () => rpc<Painel>("financeiro_painel"), staleTime: 5 * 60_000 });
  const [aberto, setAberto] = useState<Chave | null>(null);
  const [mesSel, setMesSel] = useState<string | null>(null);
  const abrir = (k: Chave) => setAberto((a) => (a === k ? null : k));

  if (q.isLoading) return <div style={{ ...cartao, ...sub }}>Calculando o painel financeiro…</div>;
  if (q.error || !q.data) return (
    <div style={{ ...cartao, color: "var(--pm-r)" }}>Não consegui montar o painel: {(q.error as Error)?.message ?? "sem resposta"}
      <button type="button" onClick={() => q.refetch()} style={{ marginLeft: 10, cursor: "pointer" }}>Tentar de novo</button></div>
  );
  const p = q.data, c = p.capital, ci = p.ciclo;
  const meses = p.meses.filter((m) => n(m.receita) > 0).slice(-8);
  const atual = p.meses[p.meses.length - 1];
  const ehParcial = atual.mes === p.mes_atual.mes;
  const fechado = ehParcial ? p.meses[p.meses.length - 2] : atual;
  const proj = p.mes_atual.receita_projetada;
  const folga = atual.equilibrio ? ((proj ?? atual.receita) / atual.equilibrio - 1) * 100 : null;
  const sel = p.meses.find((m) => m.mes === (mesSel ?? atual.mes)) ?? atual;
  const selAnt = p.meses[p.meses.indexOf(sel) - 1];
  const liq = p.liquidez.sem_estoque;
  const outras = c.pagar - c.pagar_mercadoria;
  const faixa = (k: string) => n(p.pagar.por_faixa?.[k]?.valor);
  const ehMerc = (x: Conta) => (x.categoria ?? "").toLowerCase().startsWith("mercadoria");
  const chaveDecisao = (d: Decisao): Chave => d.o_que.includes("atrasad") ? "atrasadas" : d.o_que.includes("estoque") ? "estoque" : d.o_que.includes("Caixa") ? "liquidez" : d.o_que.includes("equilíbrio") ? "equilibrio" : "lucro";

  const kpis: Array<{ k: Chave; nome: string; valor: string; tom: string; selo: string; nota: string }> = [
    { k: "lucro", nome: "Lucro líquido do mês", valor: atual.lucro_pct != null ? pct(atual.lucro_pct) : "—", tom: n(atual.lucro_pct) >= 5 ? "ok" : n(atual.lucro_pct) >= 0 ? "warn" : "bad", selo: ehParcial ? "parcial" : "fechado", nota: `${L(atual.lucro)}${ehParcial ? ` até dia ${p.mes_atual.dia}` : ""} · ${nomeMes(fechado.mes)} fechou em ${fechado.lucro_pct != null ? pct(fechado.lucro_pct) : "—"}` },
    { k: "receita", nome: "Receita projetada", valor: L(proj ?? atual.receita), tom: (proj ?? 0) >= fechado.receita ? "ok" : "warn", selo: proj && fechado.receita ? `${proj >= fechado.receita ? "+" : "−"}${Math.abs(Math.round((proj / fechado.receita - 1) * 100))}% vs ${nomeMes(fechado.mes)}` : "mês", nota: "no ritmo dos dias fechados do mês" },
    { k: "equilibrio", nome: "Ponto de equilíbrio", valor: atual.equilibrio ? L(atual.equilibrio) : "—", tom: folga == null ? "n" : folga >= 20 ? "ok" : folga >= 0 ? "warn" : "bad", selo: folga == null ? "sem margem" : `folga de ${Math.round(folga)}%`, nota: "quanto precisa vender para pagar fixas e ADS" },
    { k: "giro", nome: "Capital de giro", valor: L(c.giro), tom: c.giro >= 0 ? "n" : "bad", selo: "sem bancos", nota: "caixa + a receber + estoque − contas a pagar" },
    { k: "liquidez", nome: "Liquidez de 30 dias", valor: liq != null ? liq.toFixed(2).replace(".", ",") : "—", tom: liq == null ? "n" : liq >= 1 ? "ok" : liq >= 0.6 ? "warn" : "bad", selo: liq != null && liq < 1 ? "abaixo de 1" : "cobre", nota: "caixa + a receber ÷ o que vence em 30 dias" },
    { k: "ciclo", nome: "Ciclo de caixa", valor: ci.ciclo_dias != null ? `${ci.ciclo_dias} dias` : "—", tom: n(ci.ciclo_dias) <= 15 ? "ok" : n(ci.ciclo_dias) <= 40 ? "warn" : "bad", selo: n(ci.ciclo_dias) <= 15 ? "curto" : "longo", nota: `${ci.estoque_dias ?? "—"} de estoque + ${ci.receber_dias ?? "—"} a receber − ${ci.pagar_dias ?? "—"} do fornecedor` },
  ];

  const cem: Array<[string, number, string]> = atual.receita ? [
    ["Custo do produto", (atual.cmv / atual.receita) * 100, "var(--pm-a)"],
    ["Marketplace (comissão e frete)", (atual.deducoes / atual.receita) * 100, "var(--pm-st5)"],
    ["Impostos", (atual.impostos / atual.receita) * 100, "var(--pm-st1)"],
    ["ADS", (atual.ads / atual.receita) * 100, "var(--pm-st2)"],
    ["Despesas fixas", (atual.fixo / atual.receita) * 100, "var(--pm-st3)"],
    ["Lucro", Math.max(0, (atual.lucro / atual.receita) * 100), "var(--pm-g)"],
  ] : [];

  const detalhe = (k: Chave): ReactNode => {
    switch (k) {
      case "lucro": return <CascataMes m={sel} ant={selAnt} parcial={sel.mes === p.mes_atual.mes} />;
      case "receita": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Linha nome={`Receita de ${nomeMes(atual.mes)} até agora`} valor={L(atual.receita)} />
          <Linha nome="Dias fechados do mês" valor={`${Math.max(1, p.mes_atual.dia - 1)} de ${p.mes_atual.dias_mes}`} />
          <Linha nome="Ritmo por dia" valor={L(atual.receita / Math.max(1, p.mes_atual.dia - 1))} nota={`últimos 30 dias: ${L(ci.venda_dia)}/dia`} />
          <Linha forte nome="Projeção do mês" valor={L(proj ?? atual.receita)} />
          <div style={{ ...rot, margin: "10px 8px 4px" }}>Meses anteriores</div>
          {meses.slice(0, -1).reverse().map((m) => <Barra key={m.mes} nome={nomeMes(m.mes)} valor={m.receita} max={Math.max(...meses.map((x) => x.receita))} cor="var(--pm-a)" direita={L(m.receita)} />)}
        </div>
      );
      case "equilibrio": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Linha nome="Despesas fixas" valor={L(atual.fixo)} />
          <Linha nome="ADS" valor={L(atual.ads)} />
          <Linha forte nome="Total a cobrir no mês" valor={L(atual.despesas)} />
          <Linha nome="Margem de contribuição" nota="o que sobra de cada R$ 100 vendidos depois de produto, marketplace e imposto" valor={atual.mc_pct != null ? pct(atual.mc_pct) : "—"} />
          <Linha forte nome="Ponto de equilíbrio" nota="total a cobrir ÷ margem" valor={atual.equilibrio ? L(atual.equilibrio) : "—"} />
          <Linha nome="Receita projetada do mês" valor={L(proj ?? atual.receita)} />
          <Linha forte nome="Folga" valor={folga != null ? pct(folga, 0) : "—"} tom={folga == null ? undefined : folga >= 20 ? "ok" : folga >= 0 ? "warn" : "bad"} />
          {atual.mc_pct != null && atual.mc_pct > 1 && <div style={{ ...sub, padding: "6px 8px" }}>Cada ponto de margem a mais baixa o equilíbrio em cerca de {L(n(atual.equilibrio) - atual.despesas / ((atual.mc_pct + 1) / 100))}.</div>}
        </div>
      );
      case "giro": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ ...sub, padding: "0 8px 6px" }}>Clique em uma linha para abrir.</div>
          <Linha onClick={() => setAberto("caixa")} nome="Caixa" nota="carteiras Shopee + Mercado Pago" valor={L(c.caixa)} />
          <Linha onClick={() => setAberto("receber")} nome="A receber dos marketplaces" valor={L(c.receber)} />
          <Linha onClick={() => setAberto("estoque")} nome="Estoque a custo" nota={`${L(c.estoque_parado)} parados`} valor={L(c.estoque)} />
          <Linha onClick={() => setAberto("fornecedores")} nome="− Fornecedores de mercadoria" valor={L(-c.pagar_mercadoria)} tom="bad" />
          <Linha onClick={() => setAberto("outras")} nome="− Pessoal, aluguel e demais contas" valor={L(-outras)} tom="bad" />
          <Linha forte nome="Capital de giro" valor={L(c.giro)} />
        </div>
      );
      case "liquidez": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Linha onClick={() => setAberto("caixa")} nome="Caixa" valor={L(c.caixa)} />
          <Linha onClick={() => setAberto("receber")} nome="A receber dos marketplaces" valor={L(c.receber)} />
          <Linha forte nome="Disponível em até 30 dias" valor={L(c.caixa + c.receber)} />
          <div style={{ ...rot, margin: "10px 8px 2px" }}>O que vence</div>
          <Linha onClick={() => setAberto("atrasadas")} nome="Já atrasado" valor={L(faixa("atrasado"))} tom={faixa("atrasado") > 0 ? "bad" : undefined} />
          <Linha nome="Hoje" valor={L(faixa("hoje"))} />
          <Linha nome="Em até 7 dias" valor={L(faixa("ate_7d"))} />
          <Linha nome="De 8 a 15 dias" valor={L(faixa("ate_15d"))} />
          <Linha nome="De 16 a 30 dias" valor={L(faixa("ate_30d"))} />
          <Linha forte nome="Vence em até 30 dias" valor={L(c.pagar_30d)} />
          <Linha forte nome={c.caixa + c.receber >= c.pagar_30d ? "Sobra" : "Falta (depende das vendas do período)"} valor={L(Math.abs(c.caixa + c.receber - c.pagar_30d))} tom={c.caixa + c.receber >= c.pagar_30d ? "ok" : "warn"} />
          <Link to="/fluxo-caixa" style={{ fontSize: 12, fontWeight: 500, color: "var(--pm-at)", textDecoration: "none", padding: "6px 8px" }}>Ver o fluxo de caixa dia a dia ›</Link>
        </div>
      );
      case "ciclo": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Barra nome="Estoque até vender" valor={n(ci.estoque_dias)} max={60} cor="var(--pm-a)" direita={`${ci.estoque_dias ?? "—"} d`} />
          <div style={{ ...sub, marginLeft: 8 }}>estoque de {L(c.estoque)} ÷ custo vendido de {L(ci.cmv_dia)} por dia</div>
          <Barra nome="Marketplace até repassar" valor={n(ci.receber_dias)} max={60} cor="var(--pm-st2)" direita={`${ci.receber_dias ?? "—"} d`} />
          <div style={{ ...sub, marginLeft: 8 }}>a receber de {L(c.receber)} ÷ repasse de {L(ci.repasse_dia)} por dia</div>
          <Barra nome="Prazo do fornecedor" valor={n(ci.pagar_dias)} max={60} cor="var(--pm-g)" direita={`${ci.pagar_dias ?? "—"} d`} />
          <div style={{ ...sub, marginLeft: 8 }}>fornecedores a pagar de {L(c.pagar_mercadoria)} ÷ compras de {L(ci.compras_dia)} por dia (notas dos últimos 90 dias)</div>
          <Barra nome={<b>Ciclo de caixa</b>} valor={Math.max(0, n(ci.ciclo_dias))} max={60} cor="var(--pm-am)" direita={`${ci.ciclo_dias ?? "—"} d`} />
          <div style={{ ...sub, marginLeft: 8 }}>Cada dia a menos de estoque libera cerca de {L(ci.cmv_dia)}; cada dia a mais de prazo no fornecedor, cerca de {L(ci.compras_dia)}.</div>
        </div>
      );
      case "caixa": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {(c.caixa_por ?? []).filter((x) => x.marketplace !== "mercadolivre").map((x) => <Linha key={x.carteira} nome={x.carteira} nota={x.saldo_em ? idade(x.saldo_em).txt : undefined} valor={L(n(x.valor))} />)}
          {(c.mercado_pago_por ?? []).map((x) => <Linha key={x.conta} nome={`Mercado Pago · ${x.conta === 1107117809 ? "Ottz" : "SVL"}`} nota={`saldo do fim de ${ddmm(x.dia)}`} valor={L(n(x.saldo))} />)}
          <Linha forte nome="Caixa que o sistema enxerga" valor={L(c.caixa)} />
          <div style={{ ...sub, padding: "6px 8px" }}>Os bancos (Olist, Nubank, Inter, Itaú) ainda não entram. Vão entrar com o extrato da conta digital e com a tela de saldos do balanço.</div>
        </div>
      );
      case "receber": return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {(c.receber_por ?? []).map((x) => <Linha key={x.carteira} nome={x.carteira} nota={`${x.pedidos ?? 0} pedidos · ${x.estimado ? "estimativa" : "data real de liberação"}`} valor={L(n(x.valor))} />)}
          <Linha forte nome="A receber" nota={ci.receber_dias != null ? `≈ ${ci.receber_dias} dias de repasse` : undefined} valor={L(c.receber)} />
          <Link to="/carteira" style={{ fontSize: 12, fontWeight: 500, color: "var(--pm-at)", textDecoration: "none", padding: "6px 8px" }}>Abrir a Carteira ›</Link>
        </div>
      );
      case "estoque": return <EstoqueDetalhe />;
      case "fornecedores": return <ContasAgrupadas filtro={ehMerc} />;
      case "outras": return <ContasAgrupadas filtro={(x) => !ehMerc(x)} />;
      case "atrasadas": return <ContasAgrupadas filtro={(x) => x.faixa === "atrasado"} />;
      case "cem": return <CascataMes m={atual} ant={fechado !== atual ? fechado : undefined} parcial={ehParcial} />;
    }
  };
  const TITULO: Record<Chave, string> = {
    lucro: "Do faturamento ao lucro", receita: "Como a receita do mês é projetada", equilibrio: "Como o ponto de equilíbrio é calculado",
    giro: "O que compõe o capital de giro", liquidez: "O que entra e o que vence em 30 dias", ciclo: "Os três prazos do ciclo de caixa",
    caixa: "Caixa por conta", receber: "A receber por carteira", estoque: "Estoque a custo", fornecedores: "A pagar a fornecedores de mercadoria",
    outras: "Pessoal, aluguel e demais contas", atrasadas: "Contas atrasadas", cem: "Para onde vai a receita do mês",
  };
  const painelzinho = (k: Chave) => (
    <div style={{ ...cartao, borderColor: "var(--pm-a)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>{TITULO[k]}</b>
        <button type="button" className="pm-hv" onClick={() => setAberto(null)} style={{ border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t2)", borderRadius: 8, height: 26, padding: "0 10px", cursor: "pointer", fontSize: 12 }}>Fechar</button>
      </div>
      {detalhe(k)}
    </div>
  );
  const noGrupoKpi = aberto && ["lucro", "receita", "equilibrio", "giro", "liquidez", "ciclo", "atrasadas"].includes(aberto);
  const noGrupoGiro = aberto && ["caixa", "receber", "estoque", "fornecedores", "outras"].includes(aberto);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Financeiro</h1>
        <span style={sub}>ACZ + SVL juntas · atualizado {idade(p.gerado_em).txt}</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="pm-hv" onClick={() => q.refetch()} disabled={q.isFetching}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t2)", borderRadius: 8, height: 30, padding: "0 12px", cursor: "pointer", fontSize: 12.5 }}>
          <RefreshCw size={13} /> {q.isFetching ? "Atualizando…" : "Atualizar"}
        </button>
      </div>
      <div style={{ ...sub, background: "var(--pm-as)", color: "var(--pm-t2)", borderRadius: 10, padding: "8px 12px" }}>
        Clique em qualquer indicador para abrir o detalhe. Os saldos de banco ainda não entram: o caixa é carteira Shopee + Mercado Pago.
      </div>

      {p.decisoes.length > 0 && (
        <section>
          <div style={{ ...rot, marginBottom: 6 }}>Pede decisão</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10 }}>
            {p.decisoes.map((d) => {
              const t = d.tom === "red" ? TOM.bad : TOM.warn, k = chaveDecisao(d);
              return (
                <button key={d.o_que} type="button" onClick={() => abrir(k)}
                  style={{ textAlign: "left", background: t.s, border: `1px solid ${t.c}`, borderRadius: 12, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 2, cursor: "pointer", color: "var(--pm-t)", outline: aberto === k ? `2px solid ${t.c}` : "none" }}>
                  <b style={{ fontSize: 13.5 }}>{d.o_que}</b>
                  {d.valor != null && <span style={{ fontSize: 19, fontWeight: 700, color: t.c }}>{L(d.valor)}</span>}
                  <span style={sub}>{d.detalhe}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))", gap: 10 }}>
        {kpis.map((k) => (
          <button key={k.k} type="button" onClick={() => abrir(k.k)}
            style={{ ...cartao, textAlign: "left", cursor: "pointer", color: "var(--pm-t)", borderColor: aberto === k.k ? "var(--pm-a)" : "var(--pm-b)", outline: aberto === k.k ? "2px solid var(--pm-as)" : "none", display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={rot}>{k.nome}</span>
            <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>{k.valor}</span>
            <span><Pill tom={k.tom}>{k.selo}</Pill></span>
            <span style={sub}>{k.nota}</span>
            <span style={{ marginTop: "auto", fontSize: 11.5, color: "var(--pm-at)", fontWeight: 500 }}>{aberto === k.k ? "fechar ▴" : "ver detalhe ▾"}</span>
          </button>
        ))}
      </section>
      {noGrupoKpi && painelzinho(aberto!)}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12 }}>
        <div style={cartao}>
          <b style={{ fontSize: 14 }}>Receita × ponto de equilíbrio</b>
          <div style={sub}>Em R$ mil. Clique em um mês para ver do faturamento ao lucro.</div>
          <Grafico meses={meses} parcial={p.mes_atual.mes} sel={sel.mes} onSel={(m) => { setMesSel(m); setAberto("lucro"); }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", ...sub }}>
            {[["var(--pm-a)", "Receita"], ["var(--pm-am)", "Ponto de equilíbrio"], ["var(--pm-g)", "Lucro líquido %"]].map(([cor, nome]) => (
              <span key={nome}><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: cor, marginRight: 5 }} />{nome}</span>
            ))}
          </div>
        </div>
        <div style={cartao}>
          <b style={{ fontSize: 14 }}>Para onde vai cada R$ 100 vendidos</b>
          <div style={sub}>{nomeMes(atual.mes)}{ehParcial ? ` até dia ${p.mes_atual.dia}` : ""}</div>
          <div style={{ display: "flex", height: 28, borderRadius: 9, overflow: "hidden", margin: "10px 0 6px" }}>
            {cem.map(([nome, v, cor]) => <span key={nome} title={nome} style={{ width: `${v}%`, background: cor, minWidth: 2 }} />)}
          </div>
          {cem.map(([nome, v, cor]) => (
            <Linha key={nome} nome={<><i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: cor, marginRight: 7 }} />{nome}</>} valor={`R$ ${v.toFixed(2).replace(".", ",")}`} />
          ))}
          <button type="button" onClick={() => abrir("cem")} style={{ border: 0, background: "transparent", color: "var(--pm-at)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: "6px 8px" }}>{aberto === "cem" ? "Fechar a comparação" : `Comparar com ${nomeMes(fechado.mes)} ▾`}</button>
        </div>
      </section>
      {aberto === "cem" && painelzinho("cem")}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 12 }}>
        <div style={cartao}>
          <b style={{ fontSize: 14 }}>Capital de giro</b>
          <div style={{ ...sub, marginBottom: 6 }}>O que a empresa tem para girar contra o que deve. Clique em uma linha.</div>
          <Linha aberto={aberto === "caixa"} onClick={() => abrir("caixa")} nome="Caixa" nota="carteiras + Mercado Pago" valor={L(c.caixa)} />
          <Linha aberto={aberto === "receber"} onClick={() => abrir("receber")} nome="A receber dos marketplaces" valor={L(c.receber)} />
          <Linha aberto={aberto === "estoque"} onClick={() => abrir("estoque")} nome="Estoque a custo" nota={`${L(c.estoque_parado)} parados`} valor={L(c.estoque)} />
          <Linha aberto={aberto === "fornecedores"} onClick={() => abrir("fornecedores")} nome="− Fornecedores de mercadoria" valor={L(-c.pagar_mercadoria)} tom="bad" />
          <Linha aberto={aberto === "outras"} onClick={() => abrir("outras")} nome="− Pessoal, aluguel e demais contas" valor={L(-outras)} tom="bad" />
          <Linha forte nome="Capital de giro" valor={L(c.giro)} />
        </div>
        <div style={{ ...cartao, display: "flex", flexDirection: "column", gap: 8 }}>
          <b style={{ fontSize: 14 }}>Ciclo de caixa</b>
          <div style={sub}>Dias entre pagar o fornecedor e receber do marketplace</div>
          <Barra nome="Estoque até vender" valor={n(ci.estoque_dias)} max={60} cor="var(--pm-a)" direita={`${ci.estoque_dias ?? "—"} d`} />
          <Barra nome="Marketplace até repassar" valor={n(ci.receber_dias)} max={60} cor="var(--pm-st2)" direita={`${ci.receber_dias ?? "—"} d`} />
          <Barra nome="Prazo do fornecedor" valor={n(ci.pagar_dias)} max={60} cor="var(--pm-g)" direita={`${ci.pagar_dias ?? "—"} d`} />
          <Barra nome={<b>Ciclo de caixa</b>} valor={Math.max(0, n(ci.ciclo_dias))} max={60} cor="var(--pm-am)" direita={`${ci.ciclo_dias ?? "—"} d`} />
          <button type="button" onClick={() => abrir("ciclo")} style={{ border: 0, background: "transparent", color: "var(--pm-at)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: 0, textAlign: "left" }}>{aberto === "ciclo" ? "fechar ▴" : "ver como cada prazo é calculado ▾"}</button>
        </div>
      </section>
      {noGrupoGiro && painelzinho(aberto!)}

      <section style={cartao}>
        <b style={{ fontSize: 14 }}>Mês a mês</b>
        <div style={sub}>Clique em um mês para abrir do faturamento ao lucro.</div>
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 680, fontSize: 13 }}>
            <thead><tr>{["Mês", "Receita", "Margem contrib.", "MC %", "Despesas + ADS", "Lucro", "Lucro %", "Equilíbrio", "Folga"].map((h, i) => (
              <th key={h} style={{ ...rot, textAlign: i ? "right" : "left", padding: "6px 8px", borderBottom: "1px solid var(--pm-b)" }}>{h}</th>))}</tr></thead>
            <tbody>{[...meses].reverse().map((m) => {
              const f = m.equilibrio ? (m.receita / m.equilibrio - 1) * 100 : null, parc = m.mes === p.mes_atual.mes;
              const td: CSSProperties = { padding: "7px 8px", textAlign: "right", borderBottom: "1px solid var(--pm-b)" };
              return (
                <tr key={m.mes} className="pm-linha-hv" onClick={() => { setMesSel(m.mes); setAberto("lucro"); }} style={{ cursor: "pointer", color: parc ? "var(--pm-t3)" : undefined, background: aberto === "lucro" && sel.mes === m.mes ? "var(--pm-s2)" : undefined }}>
                  <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{nomeMes(m.mes)}{parc ? " (parcial)" : ""}</td>
                  <td className={MONO} style={td}>{L(m.receita)}</td>
                  <td className={MONO} style={td}>{L(m.mc)}</td>
                  <td className={MONO} style={td}>{m.mc_pct != null ? pct(m.mc_pct) : "—"}</td>
                  <td className={MONO} style={td}>{L(m.despesas)}</td>
                  <td className={MONO} style={{ ...td, color: m.lucro < 0 ? "var(--pm-r)" : undefined }}>{L(m.lucro)}</td>
                  <td className={MONO} style={{ ...td, color: n(m.lucro_pct) < 0 ? "var(--pm-r)" : undefined }}>{m.lucro_pct != null ? pct(m.lucro_pct) : "—"}</td>
                  <td className={MONO} style={td}>{m.equilibrio ? L(m.equilibrio) : "—"}</td>
                  <td className={MONO} style={{ ...td, color: f == null ? undefined : f < 10 ? "var(--pm-r)" : "var(--pm-g)" }}>{f != null ? pct(f, 0) : "—"}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
