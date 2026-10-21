import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Dashboard › "Posição da empresa" (design "Visão geral" do Claude Design, 21/out/2026).
// Retrato de AGORA — não muda com o filtro de período. Tudo vem pronto do banco:
//   · dashboard_posicao_empresa(): caixa, a receber (mv_carteira_saldo, 1x/h), contas a pagar
//     30 dias e fluxo de caixa dos próximos 30 dias (mesma conta da /fluxo-caixa);
//   · dashboard_estoque_valor(): valor em estoque a custo (mv_estoque_valor, 2x/dia);
//   · dashboard_pede_decisao(): alertas de negócio por gravidade.
// Cada bloco carrega e falha sozinho. Cores = tokens --pm-* (.pm-ui em styles.css).
// ============================================================================

type Erro = { erro: string };
interface Carteira { carteira: string; marketplace: string; valor: number; pedidos?: number; estimado?: boolean; saldo_em?: string | null }
interface Posicao {
  caixa: { valor: number; por: Carteira[]; atualizado_em: string } | Erro;
  receber: { valor: number; por: Carteira[]; atualizado_em: string } | Erro;
  pagar: {
    atrasado: { valor: number; contas: number }; hoje: { valor: number; contas: number };
    d7: { valor: number; contas: number }; d30: { valor: number; contas: number }; ate: string; atualizado_em: string;
  } | Erro;
  fluxo: {
    saldo_inicial: number; entradas: number; saidas: number; saldo_final: number; dia_final: string;
    pior: { dia: string; saldo: number }; maior_saida: { dia: string; valor: number };
    dias: Array<{ dia: string; entradas: number; saidas: number; saldo: number }>; atualizado_em: string;
  } | Erro;
}
interface Estoque {
  valor_total: number; valor_geral: number; valor_full: number;
  full: { amazon: number; mercado_livre: number; shopee: number; a_caminho: number };
  produtos_com_estoque: number; sem_custo: { produtos: number; unidades: number };
  parado: { valor: number; excesso: { valor: number; produtos: number }; sem_giro: { valor: number; produtos: number } };
  atualizado: { calculado_em: string; geral_em: string | null; full_em: string | null };
}
interface ItemDecisao {
  id: string; sev: "r" | "a" | "n"; valor: number; label: string; link: string; estimado?: boolean;
  contas?: number; dia?: string; lojas?: Array<{ canal: string; marketplace: string; margem_pos_ads: number; roas: number; margem_7d: number | null }>;
  unidades_dia?: number; comprar_urgente?: number; ruptura_empresa?: number; excesso?: number; sem_giro?: number;
  projecao?: number; meta?: number; falta_dia?: number; produtos?: number;
}

const temErro = (x: unknown): x is Erro => !!x && typeof x === "object" && "erro" in (x as object);
const MONO = "pm-mono";
const LOGO: Record<string, string> = { shopee: "/logos/shopee-icon.png", mercadolivre: "/logos/ml-icon.png", amazon: "/logos/amazon-icon.png", tiktok: "/logos/tiktok-icon.png" };

/** R$ compacto do design: ≥ 10 mil vira "R$ 233,7 mil". */
function L(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}R$ ${(a / 1e6).toFixed(2).replace(".", ",")} mi`;
  if (a >= 1e4) return `${s}R$ ${(a / 1e3).toFixed(1).replace(".", ",")} mil`;
  return `${s}R$ ${Math.round(a).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}
const pct = (v: number, d = 1) => `${v.toFixed(d).replace(".", ",")}%`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

/** "há 12 min", "há 3 h", "ontem 06h20", "20/10 06h20" — e se passou de 1 dia (dado velho). */
function idade(iso: string | null | undefined): { txt: string; velho: boolean } {
  if (!iso) return { txt: "—", velho: false };
  const ms = Date.now() - Date.parse(iso);
  const min = Math.max(0, Math.round(ms / 60000));
  const hm = new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  if (min < 1) return { txt: "agora", velho: false };
  if (min < 60) return { txt: `há ${min} min`, velho: false };
  if (min < 12 * 60) return { txt: `há ${Math.round(min / 60)} h`, velho: false };
  const dia = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  if (dia === hojeSP()) return { txt: `hoje ${hm}`, velho: false };
  return { txt: `${ddmm(dia)} ${hm}`, velho: min > 24 * 60 };
}

async function rpc<T>(nome: string): Promise<T> {
  const { data, error } = await supabaseExternal.rpc(nome as never);
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------- peças visuais
const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, minHeight: 150, minWidth: 0 };
const valorGrande: CSSProperties = { fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" };
const selo: CSSProperties = { fontSize: 10, padding: "1px 5px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap" };
const linkSt: CSSProperties = { marginTop: "auto", fontSize: 12, fontWeight: 500, textDecoration: "none", color: "var(--pm-at)" };

function Esqueleto() {
  return (
    <>
      <div style={{ width: "55%", height: 26, borderRadius: 7, background: "var(--pm-sk)" }} />
      <div style={{ width: "85%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
      <div style={{ width: "65%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
    </>
  );
}
function ErroBloco({ titulo, msg, onTentar }: { titulo: string; msg: string; onTentar: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 10, background: "var(--pm-rs)", color: "var(--pm-r)", fontSize: 12.5 }}>
      <b style={{ fontWeight: 600 }}>{titulo}</b>
      <span style={{ color: "var(--pm-t2)", fontSize: 12, wordBreak: "break-word" }}>{msg}. O resto da página segue normal.</span>
      <button type="button" onClick={onTentar}
        style={{ alignSelf: "flex-start", height: 26, padding: "0 10px", borderRadius: 7, border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Tentar de novo</button>
    </div>
  );
}
function Cabeca({ titulo, quando }: { titulo: string; quando?: { txt: string; velho: boolean } | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--pm-t2)" }}>{titulo}</span>
      {quando && <span style={{ fontSize: 11, color: quando.velho ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: quando.velho ? 600 : 400, whiteSpace: "nowrap" }}>{quando.txt}</span>}
    </div>
  );
}
function IrPara({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to as never} style={linkSt} className="hover:underline">{children} →</Link>;
}

// ---------------------------------------------------------------- fluxo (mini-gráfico)
function GraficoFluxo({ dias, pior, maiorSaida }: { dias: Array<{ dia: string; saldo: number }>; pior: { dia: string; saldo: number }; maiorSaida: { dia: string; valor: number } }) {
  const g = useMemo(() => {
    const n = dias.length;
    const vals = dias.map((d) => d.saldo);
    const mx = Math.max(0, ...vals), mn = Math.min(0, ...vals);
    const pad = (mx - mn) * 0.08 || 1;
    const top = mx + pad, bot = mn - pad;
    const X = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 300);
    const Y = (v: number) => 100 - ((v - bot) / (top - bot)) * 100;
    const line = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
    const iPior = dias.findIndex((d) => d.dia === pior.dia);
    const iSaida = dias.findIndex((d) => d.dia === maiorSaida.dia);
    const marcas = [0, 0.25, 0.5, 0.75, 1].map((f) => dias[Math.round(f * (n - 1))]?.dia).filter(Boolean) as string[];
    return {
      line, area: `${line} L300 ${Y(bot).toFixed(1)} L0 ${Y(bot).toFixed(1)} Z`, zeroY: Y(0),
      pior: iPior >= 0 ? { x: (X(iPior) / 300) * 100, y: Y(vals[iPior]) } : null,
      saida: iSaida >= 0 ? { x: (X(iSaida) / 300) * 100, y: Y(vals[iSaida]) } : null,
      marcas,
    };
  }, [dias, pior, maiorSaida]);
  return (
    <div style={{ position: "relative", height: 118, flex: "1 1 260px", minWidth: 0 }}>
      <svg viewBox="0 0 300 100" preserveAspectRatio="none" width="100%" height="100" style={{ display: "block", overflow: "visible" }}>
        <line x1="0" y1={g.zeroY} x2="300" y2={g.zeroY} stroke="var(--pm-bs)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <path d={g.area} fill="var(--pm-as)" />
        <path d={g.line} fill="none" stroke="var(--pm-a)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      {g.pior && <div title={`Saldo mais baixo: ${L(pior.saldo)} em ${ddmm(pior.dia)}`} style={{ position: "absolute", left: `${g.pior.x}%`, top: g.pior.y, width: 11, height: 11, margin: "-5.5px 0 0 -5.5px", borderRadius: "50%", background: pior.saldo < 0 ? "var(--pm-r)" : "var(--pm-am)", border: "2px solid var(--pm-s)" }} />}
      {g.saida && maiorSaida.valor > 0 && (
        <>
          <div style={{ position: "absolute", left: `${g.saida.x}%`, top: g.saida.y, width: 9, height: 9, margin: "-4.5px 0 0 -4.5px", borderRadius: "50%", background: "var(--pm-t2)", border: "2px solid var(--pm-s)" }} />
          <div className={MONO} style={{ position: "absolute", top: Math.max(0, g.saida.y - 22), ...(g.saida.x > 60 ? { right: `${100 - g.saida.x}%` } : { left: `${g.saida.x}%` }), fontSize: 10.5, color: "var(--pm-t2)", background: "var(--pm-s)", padding: "0 3px", whiteSpace: "nowrap" }}>
            maior saída −{L(maiorSaida.valor).replace("−", "")} · {ddmm(maiorSaida.dia)}
          </div>
        </>
      )}
      <div className={MONO} style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--pm-t3)" }}>
        {g.marcas.map((d, i) => <span key={`${d}-${i}`}>{ddmm(d)}</span>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- texto dos alertas
function contexto(c: ItemDecisao): { n: string; ctx: string; link: string } {
  switch (c.id) {
    case "contas_atrasadas": return { n: L(c.valor), ctx: `${c.contas} ${c.contas === 1 ? "conta vencida" : "contas vencidas"}`, link: "Contas a pagar" };
    case "caixa_negativo": return { n: L(c.valor), ctx: `saldo projetado em ${c.dia ? ddmm(c.dia) : "—"}`, link: "Fluxo de caixa" };
    case "ads_prejuizo": {
      const l = c.lojas ?? [];
      const nomes = l.map((x) => x.canal.replace("Mercado Livre", "ML").replace(/\s*\((.*)\)/, " $1")).join(", ");
      const s7 = l.reduce((a, x) => a + (x.margem_7d ?? 0), 0);
      return { n: L(c.valor), ctx: `${nomes} ontem${l.length === 1 ? ` · ROAS ${String(l[0].roas).replace(".", ",")}` : ""} · 7 dias ${L(s7)}`, link: c.link === "/ads-ml" ? "ADS ML" : "ADS Shopee" };
    }
    case "ruptura": return { n: `${L(c.valor)}/dia`, ctx: `${c.comprar_urgente} para comprar urgente · ${c.ruptura_empresa} em ruptura · ${Math.round(c.unidades_dia ?? 0)} un/dia`, link: "Compras" };
    case "meta": return { n: pct(c.valor, 0), ctx: `projeção ${L(c.projecao ?? 0)} de ${L(c.meta ?? 0)}${c.falta_dia ? ` · faltam ${L(c.falta_dia)}/dia` : ""}`, link: "Metas" };
    case "acos": return { n: pct(c.valor), ctx: `meta do mês: ${pct(c.meta ?? 0)}`, link: "ADS Shopee" };
    case "parado": return { n: L(c.valor), ctx: `${L(c.excesso ?? 0)} em excesso + ${L(c.sem_giro ?? 0)} sem giro`, link: "Compras" };
    case "sem_custo": return { n: L(c.valor), ctx: `${c.produtos} produtos · margem não confiável`, link: "Anomalias" };
    default: return { n: L(c.valor), ctx: "", link: "Abrir" };
  }
}
const SEV: Record<string, string> = { r: "var(--pm-r)", a: "var(--pm-am)", n: "var(--pm-t2)" };

// ---------------------------------------------------------------- componente
export function PosicaoEmpresa({ tick = 0 }: { tick?: number }) {
  const posQ = useQuery({ queryKey: ["dashboard", "posicao", tick], queryFn: () => rpc<Posicao>("dashboard_posicao_empresa"), staleTime: 5 * 60_000, placeholderData: (a) => a });
  const estQ = useQuery({ queryKey: ["dashboard", "estoque-valor", tick], queryFn: () => rpc<Estoque>("dashboard_estoque_valor"), staleTime: 5 * 60_000, placeholderData: (a) => a });
  const decQ = useQuery({ queryKey: ["dashboard", "pede-decisao", tick], queryFn: () => rpc<{ itens: ItemDecisao[]; erros: string[]; gerado_em: string }>("dashboard_pede_decisao"), staleTime: 5 * 60_000, placeholderData: (a) => a });

  const p = posQ.data;
  const erroPos = posQ.error ? (posQ.error as Error).message : null;
  const bloco = <K extends keyof Posicao>(k: K): { ok: Exclude<Posicao[K], Erro> | null; erro: string | null } => {
    if (erroPos) return { ok: null, erro: erroPos };
    const v = p?.[k];
    if (!v) return { ok: null, erro: null };
    if (temErro(v)) return { ok: null, erro: v.erro };
    return { ok: v as Exclude<Posicao[K], Erro>, erro: null };
  };
  const caixa = bloco("caixa"), receber = bloco("receber"), pagar = bloco("pagar"), fluxo = bloco("fluxo");
  const est = estQ.data ?? null;
  const tentarPos = () => void posQ.refetch();

  // capital de giro = caixa + a receber + estoque − contas a pagar 30 dias (conta aberta)
  const partes = [
    { nome: "caixa", v: caixa.ok?.valor, sinal: 1 }, { nome: "a receber", v: receber.ok?.valor, sinal: 1 },
    { nome: "estoque", v: est?.valor_total, sinal: 1 }, { nome: "a pagar 30d", v: pagar.ok?.d30.valor, sinal: -1 },
  ];
  const faltam = partes.filter((x) => x.v == null).map((x) => x.nome);
  const giro = partes.reduce((a, x) => a + (x.v ?? 0) * x.sinal, 0);

  const itens = decQ.data?.itens ?? [];
  const carregandoFaixa = decQ.isLoading;

  return (
    <section className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 18, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", color: "var(--pm-t)", fontSize: 13 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Posição da empresa</h2>
        <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 5, background: "var(--pm-s)", border: "1px solid var(--pm-b)", color: "var(--pm-t2)" }}>AGORA</span>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>retrato de agora · não muda com o filtro de período</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,228px),1fr))", gap: 10 }}>
        {/* Caixa disponível */}
        <div style={cartao}>
          <Cabeca titulo="Caixa disponível" quando={caixa.ok ? idade(caixa.ok.atualizado_em) : null} />
          {caixa.erro ? <ErroBloco titulo="Não deu para ler o caixa agora" msg={caixa.erro} onTentar={tentarPos} />
            : !caixa.ok ? <Esqueleto /> : (
              <>
                <span className={MONO} style={valorGrande}>{L(caixa.ok.valor)}</span>
                <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>saldo nas carteiras da Shopee · o Mercado Livre não informa saldo pela API</span>
                {pagar.ok && pagar.ok.d30.valor > 0 && (
                  <span style={{ fontSize: 12, fontWeight: 500, color: caixa.ok.valor / pagar.ok.d30.valor < 0.25 ? "var(--pm-am)" : "var(--pm-t2)" }}>
                    cobre {pct((caixa.ok.valor / pagar.ok.d30.valor) * 100)} das contas dos próximos 30 dias
                  </span>
                )}
                <IrPara to="/carteira">Carteira</IrPara>
              </>
            )}
        </div>

        {/* A receber */}
        <div style={cartao}>
          <Cabeca titulo="A receber" quando={receber.ok ? idade(receber.ok.atualizado_em) : null} />
          {receber.erro ? <ErroBloco titulo="Não deu para ler o a receber agora" msg={receber.erro} onTentar={tentarPos} />
            : !receber.ok ? <Esqueleto /> : (
              <>
                <span className={MONO} style={valorGrande}>{L(receber.ok.valor)}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
                  {receber.ok.por.map((x) => (
                    <div key={x.carteira} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <img src={LOGO[x.marketplace] ?? LOGO.shopee} alt="" style={{ width: 14, height: 14, objectFit: "contain", borderRadius: 3, background: "#fff" }} />
                      <span style={{ flex: 1, color: "var(--pm-t2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.carteira.replace(" · ", " ")}</span>
                      {x.estimado && <span style={selo} title="Prazo de crédito estimado pela média de liberação da Shopee">estimado</span>}
                      <span className={MONO}>{L(x.valor)}</span>
                    </div>
                  ))}
                </div>
                <IrPara to="/fluxo-caixa">Fluxo de caixa</IrPara>
              </>
            )}
        </div>

        {/* Valor em estoque */}
        <div style={cartao}>
          <Cabeca titulo="Valor em estoque, a custo" quando={est ? (() => { const i = idade(est.atualizado.geral_em ?? est.atualizado.calculado_em); return { txt: `estoque ${i.txt}`, velho: i.velho }; })() : null} />
          {estQ.error ? <ErroBloco titulo="Não deu para ler o estoque agora" msg={(estQ.error as Error).message} onTentar={() => void estQ.refetch()} />
            : !est ? <Esqueleto /> : (
              <>
                <span className={MONO} style={valorGrande}>{L(est.valor_total)}</span>
                <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>
                  depósito da empresa {L(est.valor_geral)} · Fulls {L(est.valor_full)} · {est.produtos_com_estoque} produtos
                </span>
                {est.valor_total > 0 && (
                  <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--pm-sk)" }}
                    title={`Excesso ${L(est.parado.excesso.valor)} · sem giro ${L(est.parado.sem_giro.valor)}`}>
                    <i style={{ width: `${(est.parado.excesso.valor / est.valor_total) * 100}%`, background: "var(--pm-am)" }} />
                    <i style={{ width: `${(est.parado.sem_giro.valor / est.valor_total) * 100}%`, background: "var(--pm-r)" }} />
                  </div>
                )}
                <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>
                  <b style={{ color: "var(--pm-am)", fontWeight: 600 }}>{L(est.parado.valor)} parado</b> · {L(est.parado.excesso.valor)} em excesso + {L(est.parado.sem_giro.valor)} sem giro
                </span>
                {est.sem_custo.produtos > 0 && <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>{est.sem_custo.produtos} produtos com estoque sem custo cadastrado ficam fora</span>}
                <IrPara to="/compras">Compras</IrPara>
              </>
            )}
        </div>

        {/* Contas a pagar */}
        <div style={cartao}>
          <Cabeca titulo="Contas a pagar em 30 dias" quando={pagar.ok ? idade(pagar.ok.atualizado_em) : null} />
          {pagar.erro ? <ErroBloco titulo="Não deu para ler as contas agora" msg={pagar.erro} onTentar={tentarPos} />
            : !pagar.ok ? <Esqueleto /> : (
              <>
                <span className={MONO} style={valorGrande}>{L(pagar.ok.d30.valor)}</span>
                <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{pagar.ok.d30.contas} {pagar.ok.d30.contas === 1 ? "conta" : "contas"} até {ddmm(pagar.ok.ate)}</span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 6, fontSize: 11.5 }}>
                  {[
                    { k: "Atrasado", v: pagar.ok.atrasado.valor, r: pagar.ok.atrasado.valor > 0 },
                    { k: "7 dias", v: pagar.ok.d7.valor, r: false },
                    { k: "30 dias", v: pagar.ok.d30.valor, r: false },
                  ].map((x) => (
                    <div key={x.k} style={{ display: "flex", flexDirection: "column", gap: 1, padding: "5px 7px", borderRadius: 8, background: x.r ? "var(--pm-rs)" : "var(--pm-s2)", minWidth: 0 }}>
                      <span style={{ color: x.r ? "var(--pm-r)" : "var(--pm-t3)", fontWeight: x.r ? 500 : 400 }}>{x.k}</span>
                      <b className={MONO} style={{ color: x.r ? "var(--pm-r)" : "var(--pm-t)", fontWeight: 600, whiteSpace: "nowrap" }}>{L(x.v)}</b>
                    </div>
                  ))}
                </div>
                <IrPara to="/contas-pagar">Contas a pagar</IrPara>
              </>
            )}
        </div>
      </div>

      {/* Capital de giro */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", padding: "9px 14px", borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Capital de giro</span>
        <span className={MONO} style={{ fontSize: 12.5, color: "var(--pm-t2)", display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "baseline" }}>
          <span style={{ color: "var(--pm-t)", fontWeight: 600 }}>≈ {L(giro)}</span>
          <span style={{ color: "var(--pm-t3)" }}>=</span>
          {partes.map((x, i) => (
            <span key={x.nome} style={{ color: x.v == null ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: x.v == null ? 500 : 400 }}>
              {i > 0 ? (x.sinal < 0 ? "− " : "+ ") : ""}{x.v == null ? `${x.nome} ?` : `${L(x.v)} ${x.nome}`}
            </span>
          ))}
        </span>
        <span style={selo}>estimado</span>
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
          {faltam.length ? `incompleto: falta ${faltam.join(", ")}` : giro > 0 && est ? `${pct((est.valor_total / giro) * 100, 0)} dele está em estoque` : ""}
        </span>
      </div>

      {/* Fluxo de caixa · próximos 30 dias */}
      <div style={{ ...cartao, minHeight: 0, gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 14px" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Fluxo de caixa · próximos 30 dias</span>
          <span style={selo}>projetado</span>
          {fluxo.ok && <span style={{ fontSize: 11, color: idade(fluxo.ok.atualizado_em).velho ? "var(--pm-am)" : "var(--pm-t3)" }}>{idade(fluxo.ok.atualizado_em).txt}</span>}
          <div style={{ flex: 1 }} />
          {fluxo.ok && (
            <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>
              Entradas <b className={MONO} style={{ color: "var(--pm-g)", fontWeight: 600 }}>+{L(fluxo.ok.entradas)}</b> · Saídas <b className={MONO} style={{ fontWeight: 600 }}>−{L(fluxo.ok.saidas)}</b> · Saldo em {ddmm(fluxo.ok.dia_final)} <b className={MONO} style={{ fontWeight: 600, color: fluxo.ok.saldo_final < 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{L(fluxo.ok.saldo_final)}</b>
            </span>
          )}
        </div>
        {fluxo.erro ? <ErroBloco titulo="Não deu para ler a projeção agora" msg={fluxo.erro} onTentar={tentarPos} />
          : !fluxo.ok ? <div style={{ height: 118, borderRadius: 10, background: "var(--pm-sk)" }} />
          : fluxo.ok.dias.length === 0 ? <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>Sem projeção para os próximos 30 dias.</span>
          : (() => {
            const f = fluxo.ok;
            const neg = f.pior.saldo < 0, apertado = !neg && f.pior.saldo < 10_000;
            const cor = neg ? "var(--pm-r)" : apertado ? "var(--pm-am)" : "var(--pm-g)";
            const fundo = neg ? "var(--pm-rs)" : apertado ? "var(--pm-ams)" : "var(--pm-gs)";
            const quando = f.pior.dia === hojeSP() ? `hoje, ${ddmm(f.pior.dia)}` : ddmm(f.pior.dia);
            return (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "stretch" }}>
                <GraficoFluxo dias={f.dias} pior={f.pior} maiorSaida={f.maior_saida} />
                <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, padding: "10px 12px", borderRadius: 10, background: fundo, flex: "0 1 220px", maxWidth: "100%" }}>
                  <span style={{ fontSize: 11.5, color: cor, fontWeight: 600 }}>Saldo mais baixo</span>
                  <span className={MONO} style={{ fontSize: 20, fontWeight: 600, color: cor }}>{f.pior.saldo >= 0 ? "+" : ""}{L(f.pior.saldo)}</span>
                  <span style={{ fontSize: 11.5, color: "var(--pm-t2)", textWrap: "pretty" }}>
                    {quando} · {neg ? "fica negativo: precisa de dinheiro de fora" : apertado ? "não fica negativo, mas não há folga" : "sem aperto no período"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>começa no caixa de hoje ({L(f.saldo_inicial)})</span>
                  <Link to={"/fluxo-caixa" as never} style={{ fontSize: 12, fontWeight: 500, textDecoration: "none", color: "var(--pm-at)" }} className="hover:underline">Fluxo de caixa →</Link>
                </div>
              </div>
            );
          })()}
      </div>

      {/* Pede decisão */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Pede decisão</span>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
            por gravidade · vermelho perde dinheiro agora, âmbar perde se ninguém agir{decQ.data ? ` · ${idade(decQ.data.gerado_em).txt}` : ""}
          </span>
        </div>
        {decQ.error ? <ErroBloco titulo="Não deu para montar os alertas agora" msg={(decQ.error as Error).message} onTentar={() => void decQ.refetch()} />
          : carregandoFaixa ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))", gap: 8 }}>
              {[0, 1, 2, 3].map((k) => (
                <div key={k} style={{ height: 96, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ width: "45%", height: 18, borderRadius: 6, background: "var(--pm-sk)" }} />
                  <div style={{ width: "80%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
                  <div style={{ width: "60%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
                </div>
              ))}
            </div>
          ) : itens.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", fontSize: 12.5 }}>
              <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--pm-gs)", color: "var(--pm-g)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <b style={{ fontWeight: 600 }}>Tudo em dia ✓</b>
              <span style={{ color: "var(--pm-t3)" }}>Nenhuma conta atrasada, caixa positivo nos 30 dias, meta e ADS dentro do esperado.</span>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))", gap: 8 }}>
              {itens.map((c) => {
                const t = contexto(c);
                const cor = SEV[c.sev] ?? SEV.n;
                return (
                  <Link key={c.id} to={c.link as never} className="hover:border-[var(--pm-a)]"
                    style={{ textAlign: "left", textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 3, padding: "10px 12px", borderRadius: 12, border: "1px solid var(--pm-b)", background: "var(--pm-s)", boxShadow: "var(--pm-sh)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <i style={{ width: 7, height: 7, borderRadius: "50%", background: cor, flex: "none" }} />
                      <span className={MONO} style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.02em", color: cor, whiteSpace: "nowrap" }}>{t.n}</span>
                      {c.estimado && <span style={selo}>estimado</span>}
                    </div>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--pm-t)" }}>{c.label}</span>
                    <span style={{ fontSize: 11.5, color: "var(--pm-t2)", textWrap: "pretty" }}>{t.ctx}</span>
                    <span style={{ fontSize: 11.5, color: "var(--pm-at)", fontWeight: 500, marginTop: "auto" }}>{t.link} →</span>
                  </Link>
                );
              })}
            </div>
          )}
        {decQ.data && decQ.data.erros.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--pm-am)" }}>Não deu para conferir: {decQ.data.erros.map((e) => String(e).split(":")[0]).join(", ")}.</span>
        )}
      </div>
    </section>
  );
}
