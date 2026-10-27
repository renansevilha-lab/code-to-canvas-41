import { type CSSProperties, Fragment, type ReactNode, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { LOGO, idade, int } from "@/components/dashboard/formato";
import { NOME_EMP, type EmpF } from "@/components/fulfillment/ui/Cabecalho";
import { MargemFullCell, chaveMargem, type MargemFull } from "@/components/fulfillment/MargemFull";
import { arredondarCaixa, chaveCaixa, type CaixaSku } from "@/components/fulfillment/CaixaReposicao";
import { ModelosCaixaAmazon } from "@/components/fulfillment/ModelosCaixaAmazon";

// ============================================================================
// Fulfillment › Reposição no padrão do design (Claude Design,
// Fulfillment-Reposicao.dc.html, 22/out/2026). Só apresentação sobre a
// view_reposicao_full (o motor de sugestão segue no banco): grupos Urgente /
// Sugerido / Ok, ordenação por coluna, "A enviar" em caixas fechadas da Amazon,
// barra de seleção e painel "Montar envio" (Amazon = plano pela API, que
// continua no PlanoAmazonDialog; ML/Shopee = copiar a lista e subir o PDF).
// ============================================================================

export interface LinhaRepo {
  marketplace: string; shop_id: number | null; empresa: string | null; sku: string; produto: string | null;
  eh_kit: boolean | null; und_dia: number | string | null; unidades_30d: number | string | null;
  estoque_full: number | string | null; em_transito: number | string | null; em_envio_aberto?: number | string | null;
  cobertura_atual_dias: number | string | null; cobertura_alvo_dias: number | string | null;
  estoque_empresa: number | string | null; estoque_sincronizado: boolean | null;
  necessidade: number | string | null; sugestao_envio: number | string | null; estoque_atualizado_em: string | null;
  /** dias até o envio chegar ao CD (agendamento; Amazon pesado = 14) — já somados em cobertura_alvo_dias e na sugestão */
  prazo_envio_dias?: number | string | null; cobertura_base_dias?: number | string | null; peso_kg?: number | string | null;
}

type Col = "produto" | "canal" | "vendas" | "mc" | "cd" | "cobertura" | "sugestao" | "tiny";
type Grupo = "u" | "s" | "o";

const MONO = "pm-mono";
const n = (v: unknown) => { const x = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(x) ? x : 0; };
const chave = (r: LinhaRepo) => `${r.marketplace}|${r.shop_id ?? 0}|${r.sku}`;
const EMP_SHOP: Record<number, string> = { 522186766: "ACZ Pet", 1107117809: "ACZ Pet", 900001: "ACZ Pet", 759046323: "SVL Store", 1299638625: "SVL Store", 900002: "SVL Store" };
const empDe = (r: LinhaRepo) => r.empresa ?? EMP_SHOP[r.shop_id ?? 0] ?? null;
const MKT_CURTO: Record<string, string> = { amazon: "Amazon", mercadolivre: "ML", shopee: "Shopee" };
const contaDe = (r: LinhaRepo) => `${MKT_CURTO[r.marketplace] ?? r.marketplace} ${empDe(r) === "SVL Store" ? (r.marketplace === "shopee" ? "Bumi" : "SVL") : r.marketplace === "shopee" ? "Ottz" : "ACZ"}`;
const d1 = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
const logo = (mkt: string, px: number): CSSProperties => ({ display: "inline-block", width: px, height: px, borderRadius: 3, flex: "none", boxShadow: "0 0 0 1px var(--pm-b)", background: LOGO[mkt] ? `#fff url(${LOGO[mkt]}) center/contain no-repeat` : "var(--pm-s2)" });
const selo: CSSProperties = { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap", flex: "none" };
const GRADE = "28px minmax(220px,1.6fr) 150px 70px 100px 128px 150px 62px 128px 116px 30px";
const POR_PAGINA = 40;

/** abaixo disto é urgente: 7 dias, ou o prazo até um envio novo chegar ao CD (o que for maior) */
const limiteUrgente = (r: LinhaRepo) => Math.max(7, n(r.prazo_envio_dias));
function grupoDe(r: LinhaRepo): Grupo {
  const vende = n(r.und_dia) > 0;
  if (vende && (n(r.estoque_full) <= 0 || n(r.cobertura_atual_dias) < limiteUrgente(r))) return "u";
  if (n(r.sugestao_envio) > 0) return "s";
  return "o";
}

export function ReposicaoNova({ rows, loading, emp, fotos, margens, caixas, planos, onAmazon, onNovoEnvio }: {
  rows: LinhaRepo[];
  loading: boolean;
  emp: EmpF;
  fotos: Record<string, string | null | undefined>;
  margens: Map<string, MargemFull> | undefined;
  caixas: Map<string, CaixaSku> | undefined;
  planos: ReactNode;
  onAmazon: (empresa: string | null, itens: { sku: string; quantidade: number; titulo: string | null }[]) => void;
  onNovoEnvio: () => void;
}) {
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qtd, setQtd] = useState<Record<string, number>>({});
  const [ordem, setOrdem] = useState<{ col: Col; dir: 1 | -1 } | null>(null);
  const [abertos, setAbertos] = useState<Record<Grupo, boolean>>({ u: true, s: true, o: false });
  const [limite, setLimite] = useState<Record<Grupo, number>>({ u: POR_PAGINA, s: POR_PAGINA, o: POR_PAGINA });
  const [exp, setExp] = useState<string | null>(null);
  const [painel, setPainel] = useState(false);
  const [modelos, setModelos] = useState<number | null>(null);

  const caixaDe = (r: LinhaRepo) => (r.marketplace === "amazon" ? caixas?.get(chaveCaixa(r.shop_id, r.sku)) : undefined);
  const margemDe = (r: LinhaRepo) => margens?.get(chaveMargem(r.shop_id, r.sku));
  const valor = (r: LinhaRepo) => {
    const k = chave(r);
    if (qtd[k] !== undefined) return qtd[k];
    const cx = caixaDe(r);
    return cx ? arredondarCaixa(n(r.sugestao_envio), cx.un, n(r.estoque_empresa)) : n(r.sugestao_envio);
  };

  const clicarOrdem = (col: Col) => {
    const texto = col === "produto" || col === "canal";
    setOrdem((o) => (!o || o.col !== col ? { col, dir: texto ? 1 : -1 } : o.dir === (texto ? 1 : -1) ? { col, dir: texto ? -1 : 1 } : null));
  };
  const ordenar = (lista: LinhaRepo[]) => {
    if (!ordem) return lista;
    const v = (r: LinhaRepo): number | string => {
      switch (ordem.col) {
        case "produto": return (r.produto ?? "").toLowerCase();
        case "canal": return contaDe(r);
        case "vendas": return n(r.unidades_30d);
        case "mc": { const m = margemDe(r); return m?.mc_pct_full != null ? Number(m.mc_pct_full) : -1e9; }
        case "cd": return n(r.estoque_full);
        case "cobertura": return n(r.und_dia) > 0 ? n(r.cobertura_atual_dias) : 1e9;
        case "sugestao": return n(r.sugestao_envio);
        case "tiny": return n(r.estoque_empresa);
      }
    };
    return [...lista].sort((a, b) => { const x = v(a), y = v(b); return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * ordem.dir; });
  };

  const porGrupo = useMemo(() => {
    const g: Record<Grupo, LinhaRepo[]> = { u: [], s: [], o: [] };
    for (const r of rows) g[grupoDe(r)].push(r);
    return g;
  }, [rows]);

  const kpis = useMemo(() => {
    let sug = 0, nSug = 0, env = 0, abaixo = 0;
    for (const r of rows) {
      const s = n(r.sugestao_envio);
      if (s > 0) { sug += s; nSug++; }
      env += n(r.em_envio_aberto);
      if (n(r.und_dia) > 0 && n(r.cobertura_atual_dias) < n(r.cobertura_alvo_dias)) abaixo++;
    }
    return { sug, nSug, env, abaixo };
  }, [rows]);

  const alvo = useMemo(() => {
    const c = new Map<number, number>();
    for (const r of rows) { const a = n(r.cobertura_alvo_dias); if (a) c.set(a, (c.get(a) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 30;
  }, [rows]);
  const lido = useMemo(() => rows.reduce<string | null>((m, r) => (r.estoque_atualizado_em && (!m || r.estoque_atualizado_em > m) ? r.estoque_atualizado_em : m), null), [rows]);
  const fresco = idade(lido);
  const semModelo = useMemo(() => rows.filter((r) => r.marketplace === "amazon" && grupoDe(r) !== "o" && n(r.sugestao_envio) > 0 && !caixaDe(r)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, caixas]);

  const selecionadas = rows.filter((r) => sel[chave(r)] && valor(r) > 0);
  const unSel = selecionadas.reduce((t, r) => t + valor(r), 0);
  const blocos = useMemo(() => {
    const m = new Map<string, LinhaRepo[]>();
    for (const r of selecionadas) { const k = `${r.marketplace}|${empDe(r) ?? ""}`; m.set(k, [...(m.get(k) ?? []), r]); }
    const ordemMkt = ["amazon", "mercadolivre", "shopee"];
    return [...m.entries()].sort(([a], [b]) => ordemMkt.indexOf(a.split("|")[0]) - ordemMkt.indexOf(b.split("|")[0]) || a.localeCompare(b))
      .map(([k, rs]) => ({ mkt: k.split("|")[0], empresa: k.split("|")[1] || null, rs }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecionadas.map(chave).join(","), qtd]);

  const shopsModelos = emp === "SVL Store" ? [900002] : emp === "ACZ Pet" ? [900001] : [900001, 900002];

  function copiar(rs: LinhaRepo[]) {
    const linhas = rs.map((r) => `${r.sku}\t${valor(r)}\t${r.produto ?? ""}`).join("\n");
    void navigator.clipboard?.writeText(`sku\tquantidade\tproduto\n${linhas}`);
    toast.success(`Lista copiada · ${rs.length} SKUs, ${int(rs.reduce((t, r) => t + valor(r), 0))} un`);
  }

  const cab = (col: Col | null, rotulo: string, direita?: boolean, dica?: string) => {
    const ativo = col && ordem?.col === col;
    if (!col) return <span style={{ textAlign: direita ? "right" : "left" }} title={dica}>{rotulo}</span>;
    return (
      <button type="button" onClick={() => clicarOrdem(col)} title={dica}
        style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", font: "inherit", color: ativo ? "var(--pm-t)" : "var(--pm-t3)", fontWeight: ativo ? 600 : 500, display: "flex", alignItems: "center", gap: 3, justifyContent: direita ? "flex-end" : "flex-start", textAlign: direita ? "right" : "left" }}>
        {rotulo}<span style={{ fontSize: 9.5, opacity: ativo ? 1 : 0.4 }}>{ativo ? (ordem!.dir === 1 ? "▲" : "▼") : "⇅"}</span>
      </button>
    );
  };

  function linha(r: LinhaRepo) {
    const k = chave(r);
    const marcado = !!sel[k];
    const v = valor(r);
    const cx = caixaDe(r);
    const tem = n(r.estoque_empresa);
    const sinc = r.estoque_sincronizado !== false;
    const falta = sinc && v > tem;
    const cob = n(r.cobertura_atual_dias);
    const alvoR = n(r.cobertura_alvo_dias) || alvo;
    const vende = n(r.und_dia) > 0;
    const cobCor = !vende ? "var(--pm-t3)" : cob < limiteUrgente(r) ? "var(--pm-r)" : cob < alvoR ? "var(--pm-am)" : "var(--pm-g)";
    const cobW = Math.min(cob / (alvoR * 1.5), 1) * 100;
    const naoFecha = !!cx && cx.un > 1 && v > 0 && v % cx.un !== 0;
    const cd = n(r.estoque_full), cam = n(r.em_transito), env = n(r.em_envio_aberto);
    const foto = fotos[r.sku];
    const m = margemDe(r);
    const aberto = exp === k;
    return (
      <Fragment key={k}>
        <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 10, alignItems: "center", padding: "9px 14px", borderTop: "1px solid var(--pm-b)", background: marcado ? "var(--pm-as)" : "transparent" }}>
          <button type="button" aria-label="Selecionar" onClick={() => setSel((s) => ({ ...s, [k]: !marcado }))}
            style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${marcado ? "var(--pm-a)" : "var(--pm-bs)"}`, background: marcado ? "var(--pm-a)" : "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-oa)", padding: 0 }}>
            {marcado && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
            {foto ? <img src={foto} alt="" loading="lazy" style={{ width: 36, height: 36, flex: "none", borderRadius: 8, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-b)" }} />
              : <span style={{ width: 36, height: 36, flex: "none", borderRadius: 8, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 600, color: "var(--pm-t3)" }}>{(r.produto ?? r.sku).split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase()}</span>}
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.produto ?? ""}>{r.produto ?? "—"}</span>
              <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)" }}>SKU {r.sku}{r.eh_kit ? " · kit" : ""}</span>
            </div>
          </div>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, minWidth: 0 }}>
            <span style={logo(r.marketplace, 15)} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contaDe(r)}</span>
            <span style={selo}>{NOME_EMP[empDe(r) ?? ""] ?? "—"}</span>
          </span>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span className={MONO} style={{ fontSize: 12.5, color: n(r.und_dia) > 0 ? "var(--pm-t)" : "var(--pm-t3)" }}>{d1(n(r.und_dia))}</span>
            <span style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>{int(n(r.unidades_30d))} em 30 d</span>
          </span>
          <div style={{ textAlign: "right", minWidth: 0 }}><MargemFullCell m={m} /></div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0, paddingLeft: 6 }}>
            <span className={MONO} style={{ fontSize: 13, fontWeight: 600, color: cd <= 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{int(cd)} no CD</span>
            {/* a caminho e em envio em linhas separadas: juntos passavam da coluna */}
            {cam ? <span style={{ fontSize: 11, color: "var(--pm-t3)", lineHeight: 1.25 }}>+{int(cam)} a caminho</span> : null}
            {env ? <span style={{ fontSize: 11, color: "var(--pm-t3)", lineHeight: 1.25 }}>+{int(env)} em envio</span> : null}
            {!cam && !env && <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>nada a caminho</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ position: "relative", height: 8, borderRadius: 4, background: "var(--pm-sk)" }}>
              <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${vende && cob > 0 ? Math.max(cobW, 3) : 0}%`, borderRadius: 4, background: cobCor }} />
              <i style={{ position: "absolute", left: "66.6%", top: -3, bottom: -3, width: 2, background: "var(--pm-t2)" }} />
            </div>
            <span className={MONO} style={{ fontSize: 11.5, fontWeight: 600, color: cobCor }}>{!vende ? "sem venda" : `${int(cob)} d${cob >= alvoR ? "" : ` de ${int(alvoR)}`}`}</span>
          </div>
          <span className={MONO} style={{ textAlign: "right", fontSize: 13, fontWeight: 600, color: n(r.sugestao_envio) > 0 ? "var(--pm-t)" : "var(--pm-t3)" }}>{n(r.sugestao_envio) > 0 ? int(n(r.sugestao_envio)) : "—"}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <input value={String(v)} inputMode="numeric" className={MONO}
              onChange={(e) => { const x = parseInt(e.target.value.replace(/[^\d]/g, ""), 10); setQtd((q) => ({ ...q, [k]: Number.isFinite(x) ? x : 0 })); }}
              onFocus={(e) => e.currentTarget.select()}
              style={{ height: 32, width: 72, textAlign: "right", borderRadius: 8, border: `1px solid ${falta ? "var(--pm-r)" : naoFecha ? "var(--pm-am)" : "var(--pm-bs)"}`, background: "var(--pm-s)", padding: "0 8px", fontSize: 13, fontWeight: 600, color: "var(--pm-t)" }} />
            {cx && cx.un > 1 && (
              <span style={{ fontSize: 11, color: naoFecha ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: naoFecha ? 600 : 400 }} title={`Modelo de caixa da Amazon: ${cx.nome ?? `caixa com ${cx.un}`}`}>
                {naoFecha ? `não fecha caixa · ${cx.un}/cx` : `${int(v / cx.un)} cx de ${cx.un}`}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span className={MONO} style={{ fontSize: 12.5, color: !sinc ? "var(--pm-t3)" : tem <= 0 || falta ? "var(--pm-r)" : "var(--pm-t)", fontWeight: tem <= 0 || falta ? 600 : 400 }}>{int(tem)}</span>
            <span style={{ fontSize: 11, color: sinc && (tem <= 0 || falta) ? "var(--pm-r)" : "var(--pm-t3)", textAlign: "right" }}>
              {!sinc ? "estoque não sincronizado" : tem <= 0 ? "sem saldo · Compras" : falta ? `não dá: só tem ${int(tem)}` : `depósito ${NOME_EMP[empDe(r) ?? ""] ?? ""}`}
            </span>
          </div>
          <button type="button" title="Detalhe" onClick={() => setExp(aberto ? null : k)}
            style={{ width: 28, height: 28, borderRadius: 7, border: 0, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t3)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: aberto ? "rotate(180deg)" : "none" }}><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </div>
        {aberto && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 24px", padding: "8px 14px 10px 80px", background: "var(--pm-s2)", fontSize: 12, color: "var(--pm-t2)" }}>
            <Det k="Vendas 30 d" v={`${int(n(r.unidades_30d))} un`} />
            <Det k="Média" v={`${d1(n(r.und_dia))}/dia`} />
            <Det k="No CD" v={int(cd)} />
            <Det k="A caminho" v={int(cam)} />
            <Det k="Em envio aberto" v={int(env)} />
            <Det k="Necessidade" v={int(n(r.necessidade))} />
            <Det k="Cobertura-alvo" v={n(r.prazo_envio_dias) > 0 ? `${int(alvoR)} d (${int(n(r.cobertura_base_dias))} + ${int(n(r.prazo_envio_dias))} de agendamento)` : `${int(alvoR)} d`} />
            {n(r.peso_kg) > 0 && <Det k="Peso" v={`${d1(n(r.peso_kg))} kg`} />}
            {m && m.mc_pct_full != null && <Det k="MC 30 d pelo Full" v={pct(n(m.mc_pct_full))} />}
            {m && m.mc_pct_fora != null && <Det k="fora do Full" v={pct(n(m.mc_pct_fora))} />}
            {cx && <Det k="Modelo" v={cx.nome ?? `caixa com ${cx.un}`} />}
            {r.marketplace === "amazon" && !cx && <Det k="Modelo de caixa" v="não cadastrado" />}
          </div>
        )}
      </Fragment>
    );
  }

  const GRUPOS: Array<{ id: Grupo; nome: string; cor: string; desc: string }> = [
    { id: "u", nome: "Urgente", cor: "var(--pm-r)", desc: "zerado no CD e vendendo, ou cobertura abaixo de 7 dias (Amazon pesado: abaixo do prazo de agendamento)" },
    { id: "s", nome: "Sugerido", cor: "var(--pm-am)", desc: `com sugestão de envio para chegar a ${int(alvo)} dias` },
    { id: "o", nome: "Ok / excesso", cor: "var(--pm-g)", desc: "no alvo ou acima, ou sem venda · recolhido" },
  ];

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--pm-t)", fontSize: 13, lineHeight: 1.4, fontVariantNumeric: "tabular-nums", paddingBottom: selecionadas.length ? 8 : 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,200px),1fr))", gap: 10 }}>
        {[
          { label: "Urgente", v: int(porGrupo.u.length), cor: porGrupo.u.length ? "var(--pm-r)" : "var(--pm-t)", sub: "zerados no CD que vendem ou < 7 dias" },
          { label: "Sugerido", v: `${int(kpis.sug)} un`, cor: "var(--pm-t)", sub: `${kpis.nSug} SKUs com sugestão de envio` },
          { label: "Em envio aberto", v: `${int(kpis.env)} un`, cor: "var(--pm-t)", sub: "já planejado, ainda não saiu" },
          { label: "Abaixo do alvo", v: int(kpis.abaixo), cor: "var(--pm-t)", sub: `de ${int(rows.length)} SKUs nas contas` },
        ].map((k) => (
          <div key={k.label} style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--pm-t2)" }}>{k.label}</span>
            {loading ? <span style={{ width: "40%", height: 22, borderRadius: 6, background: "var(--pm-sk)" }} />
              : <span className={MONO} style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: k.cor }}>{k.v}</span>}
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{k.sub}</span>
          </div>
        ))}
      </div>

      {planos}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
        <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>Cobertura-alvo <b className={MONO} style={{ fontWeight: 600 }}>{int(alvo)} dias</b></span>
        <span style={{ fontSize: 11.5, color: fresco.velho ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: fresco.velho ? 600 : 400 }}>estoque lido {fresco.txt}</span>
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>· {loading ? "carregando…" : `${int(rows.length)} SKUs`}</span>
        <div style={{ flex: 1 }} />
        {shopsModelos.map((shop) => (
          <button key={shop} type="button" onClick={() => setModelos(shop)}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)" }}>
            <span style={logo("amazon", 14)} />Modelos de caixa{shopsModelos.length > 1 ? ` · ${shop === 900001 ? "ACZ" : "SVL"}` : ""}
            {semModelo > 0 && shop === shopsModelos[0] && <span style={{ fontSize: 11, fontWeight: 600, padding: "0 6px", borderRadius: 8, background: "var(--pm-ams)", color: "var(--pm-am)" }}>{semModelo} faltando</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ height: 320, borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ width: "30%", height: 14, borderRadius: 5, background: "var(--pm-sk)" }} />
          {[1, 2, 3, 4].map((i) => <div key={i} style={{ height: 44, borderRadius: 8, background: "var(--pm-sk)" }} />)}
        </div>
      ) : GRUPOS.map((g) => {
        const lista = ordenar(porGrupo[g.id]);
        const ab = abertos[g.id];
        const vis = lista.slice(0, limite[g.id]);
        const marcaveis = lista.filter((r) => valor(r) > 0);
        const todos = marcaveis.length > 0 && marcaveis.every((r) => sel[chave(r)]);
        return (
          <div key={g.id} style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", padding: "12px 14px" }}>
              <button type="button" onClick={() => setAbertos((a) => ({ ...a, [g.id]: !ab }))}
                style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", border: 0, background: "transparent", cursor: "pointer", textAlign: "left", flex: 1, padding: 0, color: "var(--pm-t)" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: ab ? "rotate(90deg)" : "none", color: "var(--pm-t3)" }}><path d="m9 18 6-6-6-6" /></svg>
                <i style={{ width: 9, height: 9, borderRadius: "50%", background: g.cor }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>{g.nome}</span>
                <span className={MONO} style={{ fontSize: 12.5, fontWeight: 600, color: g.cor }}>{int(lista.length)}</span>
                <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{g.desc}</span>
              </button>
              {ab && marcaveis.length > 0 && (
                <button type="button" onClick={() => setSel((s) => { const x = { ...s }; for (const r of marcaveis) x[chave(r)] = !todos; return x; })}
                  style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-at)", fontWeight: 500 }}>
                  {todos ? "Desmarcar o grupo" : `Selecionar os ${marcaveis.length} com envio`}
                </button>
              )}
            </div>
            {ab && (
              <>
                <div style={{ overflowX: "auto" }}>
                  <div style={{ minWidth: 1220 }}>
                    <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 10, alignItems: "end", padding: "7px 14px", background: "var(--pm-s2)", fontSize: 11, color: "var(--pm-t3)", fontWeight: 500 }}>
                      <span />
                      {cab("produto", "Produto")}
                      {cab("canal", "Canal")}
                      {cab("vendas", "Vendas/dia", true, "Unidades vendidas por dia nos últimos 30 dias NESTE canal e conta, só as que saíram do CD (Full/FBA). Ordena pelas vendas de 30 dias.")}
                      {cab("mc", "MC 30d Full", true, "Margem de contribuição dos últimos 30 dias nas vendas que saíram do Full/FBA nesta conta (sem ADS e sem armazenagem). Embaixo, a margem fora do Full.")}
                      {cab("cd", "No CD + a caminho + em envio", false, "Estoque no CD, em trânsito e nos envios abertos da aba Envios (já descontados da sugestão).")}
                      {cab("cobertura", `Cobertura × alvo ${int(alvo)} d`)}
                      {cab("sugestao", "Sugestão", true)}
                      {cab(null, "A enviar")}
                      {cab("tiny", "Depósito da empresa", true, "Disponível no depósito Geral do Tiny (saldo − reservado). Kit = quantos dá para montar com os componentes.")}
                      <span />
                    </div>
                    {vis.map((r) => linha(r))}
                    {lista.length === 0 && <div style={{ padding: 14, borderTop: "1px solid var(--pm-b)", fontSize: 12.5, color: "var(--pm-t3)" }}>Nada neste grupo com o filtro atual.</div>}
                  </div>
                </div>
                {lista.length > vis.length && (
                  <button type="button" onClick={() => setLimite((l) => ({ ...l, [g.id]: l[g.id] + POR_PAGINA * 3 }))}
                    style={{ margin: "10px 14px 12px", alignSelf: "flex-start", height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-at)", fontWeight: 500 }}>
                    Ver mais {int(Math.min(lista.length - vis.length, POR_PAGINA * 3))} de {int(lista.length - vis.length)}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}

      {selecionadas.length > 0 && (
        <div style={{ position: "sticky", bottom: 12, zIndex: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", padding: "10px 12px 10px 16px", borderRadius: 14, background: "var(--pm-t)", color: "var(--pm-s)", boxShadow: "var(--pm-shl)" }}>
          <span style={{ fontSize: 13 }}><b className={MONO} style={{ fontWeight: 600 }}>{selecionadas.length}</b> SKUs · <b className={MONO} style={{ fontWeight: 600 }}>{int(unSel)}</b> un</span>
          <span style={{ fontSize: 12, opacity: 0.75 }}>{blocos.length} {blocos.length === 1 ? "conta" : "contas"}: {blocos.map((b) => contaDe(b.rs[0])).join(", ")}</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => setSel({})} style={{ height: 38, padding: "0 12px", borderRadius: 9, border: "1px solid color-mix(in oklch, var(--pm-s) 30%, transparent)", background: "transparent", color: "var(--pm-s)", cursor: "pointer", fontSize: 12.5 }}>Limpar</button>
          <button type="button" onClick={() => setPainel(true)} style={{ height: 38, padding: "0 16px", borderRadius: 9, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Montar envio</button>
        </div>
      )}

      {painel && selecionadas.length > 0 && typeof document !== "undefined" && createPortal(
        <div className="pm-ui">
          <div onClick={() => setPainel(false)} style={{ position: "fixed", inset: 0, zIndex: 60, background: "var(--pm-ov)" }} />
          <aside style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 61, width: "min(480px,100vw)", background: "var(--pm-bg)", borderLeft: "1px solid var(--pm-b)", boxShadow: "var(--pm-shl)", display: "flex", flexDirection: "column", color: "var(--pm-t)", fontSize: 13 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--pm-b)", background: "var(--pm-s)" }}>
              <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                <b style={{ fontSize: 15, fontWeight: 600 }}>Montar envio</b>
                <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{selecionadas.length} SKUs · {int(unSel)} un · um envio por conta</span>
              </div>
              <button type="button" onClick={() => setPainel(false)} aria-label="Fechar"
                style={{ width: 36, height: 36, borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t)" }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {blocos.map((b) => {
                const amz = b.mkt === "amazon";
                const un = b.rs.reduce((t, r) => t + valor(r), 0);
                const cxs = b.rs.reduce((t, r) => { const c = caixaDe(r); return t + (c && c.un > 1 ? Math.ceil(valor(r) / c.un) : 0); }, 0);
                return (
                  <div key={`${b.mkt}|${b.empresa ?? ""}`} style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 8px" }}>
                      <span style={logo(b.mkt, 18)} />
                      <b style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{contaDe(b.rs[0])}</b>
                      <span style={selo}>{NOME_EMP[b.empresa ?? ""] ?? "—"}</span>
                    </div>
                    {b.rs.map((r) => {
                      const c = caixaDe(r); const v = valor(r); const nf = !!c && c.un > 1 && v % c.un !== 0;
                      return (
                        <div key={chave(r)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12 }}>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.produto ?? ""}>{r.produto ?? r.sku}</span>
                          <span className={MONO} style={{ fontWeight: 600 }}>{int(v)} un</span>
                          <span style={{ fontSize: 11, color: nf ? "var(--pm-am)" : "var(--pm-t3)", minWidth: 70, textAlign: "right" }}>{c && c.un > 1 ? (nf ? "não fecha" : `${int(v / c.un)} cx de ${c.un}`) : ""}</span>
                        </div>
                      );
                    })}
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 14px 12px", borderTop: "1px solid var(--pm-b)" }}>
                      <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>
                        <b className={MONO} style={{ fontWeight: 600, color: "var(--pm-t)" }}>{b.rs.length} {b.rs.length === 1 ? "SKU" : "SKUs"} · {int(un)} un{amz && cxs ? ` · ${cxs} caixas` : ""}</b>
                        {" · "}{amz ? "o app cria o plano pela API, passo a passo" : `o ${b.mkt === "mercadolivre" ? "Mercado Livre" : "Shopee"} não cria envio pela API: copie a lista, crie no painel e suba o PDF`}
                      </span>
                      {amz ? (
                        <button type="button" onClick={() => { setPainel(false); onAmazon(b.empresa, b.rs.map((r) => ({ sku: r.sku, quantidade: valor(r), titulo: r.produto }))); }}
                          style={{ height: 44, borderRadius: 10, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
                          Criar envio na Amazon
                        </button>
                      ) : (
                        <div style={{ display: "flex", gap: 8 }}>
                          <button type="button" onClick={() => copiar(b.rs)} style={{ flex: 1, height: 44, borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--pm-t)" }}>Copiar lista</button>
                          <button type="button" onClick={() => { setPainel(false); onNovoEnvio(); }} style={{ flex: 1, height: 44, borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-at)" }}>Subir o PDF →</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>,
        document.body,
      )}

      {modelos != null && <ModelosCaixaAmazon shopId={modelos} aberto onFechar={() => setModelos(null)} />}
    </div>
  );
}

function Det({ k, v }: { k: string; v: string }) {
  return <span>{k} <b className="pm-mono" style={{ fontWeight: 600, color: "var(--pm-t)" }}>{v}</b></span>;
}
