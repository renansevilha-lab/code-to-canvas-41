import { type CSSProperties, Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LOGO, idade, int } from "@/components/dashboard/formato";
import { NOME_EMP, nomeConta } from "@/components/fulfillment/ui/Cabecalho";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Fulfillment › Inventário no padrão do design (Claude Design,
// Fulfillment-Inventario.dc.html, 22/out/2026). Só apresentação sobre o
// estoque_fulfillment (gravado pelo fulfillment-sync): cartões por conta e a
// tabela por produto, que abre em cada CD e conta. O valor a custo vem da
// dashboard_estoque_valor (a mesma conta do Dashboard).
// ============================================================================

export interface LinhaInv {
  marketplace: string; shop_id: number | null; warehouse: string; sku_marketplace: string; sku: string | null;
  titulo: string | null; sellable: number | string | null; reserved: number | string | null;
  in_transit: number | string | null; unsellable: number | string | null; atualizado_em: string | null;
}
export interface DispTiny { disponivel: number; sincronizado: boolean; em: string | null }

type Col = "nome" | "ncd" | "disp" | "res" | "cam" | "inu" | "dep" | "at";
type Chip = "inu" | "sem" | "zer" | null;

const MONO = "pm-mono";
const n = (v: unknown) => { const x = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(x) ? x : 0; };
const EMP_SHOP: Record<number, string> = { 522186766: "ACZ Pet", 1107117809: "ACZ Pet", 900001: "ACZ Pet", 759046323: "SVL Store", 1299638625: "SVL Store", 900002: "SVL Store" };
const empDe = (r: LinhaInv) => EMP_SHOP[r.shop_id ?? 0] ?? "ACZ Pet";
const logo = (mkt: string, px: number): CSSProperties => ({ display: "inline-block", width: px, height: px, borderRadius: 4, flex: "none", boxShadow: "0 0 0 1px var(--pm-b)", background: LOGO[mkt] ? `#fff url(${LOGO[mkt]}) center/contain no-repeat` : "var(--pm-s2)" });
const selo: CSSProperties = { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap", flex: "none" };
const GRADE = "30px minmax(240px,1.8fr) 96px repeat(4,90px) 130px 90px";
const ORDEM_MKT = ["amazon", "mercadolivre", "shopee"];
const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "—");
const brl = (v: number) => (v >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : `R$ ${int(v)}`);

export function InventarioNovo({ rows, loading, mkt, emp, fotos, tiny }: {
  rows: LinhaInv[];
  loading: boolean;
  mkt: string;
  emp: string;
  fotos: Record<string, string | null | undefined>;
  tiny?: Map<string, DispTiny>;
}) {
  const [aberto, setAberto] = useState<Record<string, boolean>>({});
  const [chip, setChip] = useState<Chip>(null);
  const [ordem, setOrdem] = useState<{ col: Col; dir: 1 | -1 }>({ col: "disp", dir: -1 });
  const [busca, setBusca] = useState("");

  const valorQ = useQuery({
    queryKey: ["fulfillment", "estoque-valor"],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("dashboard_estoque_valor" as never);
      if (error) throw error;
      return data as { valor_full?: number; full?: Record<string, number> } | null;
    },
  });

  const contas = useMemo(() => {
    const m = new Map<string, { mkt: string; emp: string; anun: number; disp: number; res: number; cam: number; inu: number }>();
    for (const r of rows) {
      const k = `${r.marketplace}|${r.shop_id ?? 0}`;
      const c = m.get(k) ?? { mkt: r.marketplace, emp: empDe(r), anun: 0, disp: 0, res: 0, cam: 0, inu: 0 };
      c.anun++; c.disp += n(r.sellable); c.res += n(r.reserved); c.cam += n(r.in_transit); c.inu += n(r.unsellable);
      m.set(k, c);
    }
    return [...m.values()].sort((a, b) => ORDEM_MKT.indexOf(a.mkt) - ORDEM_MKT.indexOf(b.mkt) || a.emp.localeCompare(b.emp));
  }, [rows]);
  const tot = contas.reduce((t, c) => ({ disp: t.disp + c.disp, res: t.res + c.res, cam: t.cam + c.cam, inu: t.inu + c.inu }), { disp: 0, res: 0, cam: 0, inu: 0 });
  const lido = rows.reduce<string | null>((m, r) => (r.atualizado_em && (!m || r.atualizado_em > m) ? r.atualizado_em : m), null);
  const tinyEm = useMemo(() => { let m: string | null = null; for (const t of tiny?.values() ?? []) if (t.em && (!m || t.em > m)) m = t.em; return m; }, [tiny]);
  const fresco = idade(lido);

  const valor = (() => {
    const d = valorQ.data;
    if (!d) return null;
    const chave: Record<string, string> = { amazon: "amazon", mercadolivre: "mercado_livre", shopee: "shopee" };
    const v = mkt !== "todos" ? d.full?.[chave[mkt] ?? mkt] : d.valor_full;
    return v == null ? null : { v, todas: emp !== "todas" };
  })();

  const produtos = useMemo(() => {
    const m = new Map<string, { chave: string; sku: string | null; nome: string; cds: LinhaInv[] }>();
    for (const r of rows) {
      const chave = r.sku ?? `${r.marketplace}:${r.sku_marketplace}`;
      const p = m.get(chave) ?? { chave, sku: r.sku, nome: r.titulo ?? r.sku_marketplace, cds: [] };
      if (!p.nome && r.titulo) p.nome = r.titulo;
      p.cds.push(r);
      m.set(chave, p);
    }
    return [...m.values()].map((p) => {
      const s = (f: (r: LinhaInv) => number) => p.cds.reduce((t, r) => t + f(r), 0);
      const emps = [...new Set(p.cds.map(empDe))];
      const t = p.sku ? tiny?.get(p.sku) : undefined;
      const at = p.cds.reduce<string | null>((mx, r) => (r.atualizado_em && (!mx || r.atualizado_em > mx) ? r.atualizado_em : mx), null);
      return {
        ...p, emps, at, tinyDisp: t && t.sincronizado ? t.disponivel : null,
        disp: s((r) => n(r.sellable)), res: s((r) => n(r.reserved)), cam: s((r) => n(r.in_transit)), inu: s((r) => n(r.unsellable)),
        mkts: [...new Set(p.cds.map((r) => r.marketplace))].sort((a, b) => ORDEM_MKT.indexOf(a) - ORDEM_MKT.indexOf(b)),
      };
    });
  }, [rows, tiny]);

  const cont = { inu: produtos.filter((p) => p.inu > 0).length, sem: produtos.filter((p) => !p.sku).length, zer: produtos.filter((p) => p.disp <= 0).length };
  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    let l = produtos;
    if (chip === "inu") l = l.filter((p) => p.inu > 0);
    if (chip === "sem") l = l.filter((p) => !p.sku);
    if (chip === "zer") l = l.filter((p) => p.disp <= 0);
    if (q) l = l.filter((p) => p.nome.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q) || p.cds.some((r) => r.sku_marketplace.toLowerCase().includes(q)));
    const v = (p: (typeof produtos)[number]): number | string => {
      switch (ordem.col) {
        case "nome": return p.nome.toLowerCase();
        case "ncd": return p.cds.length;
        case "disp": return p.disp;
        case "res": return p.res;
        case "cam": return p.cam;
        case "inu": return p.inu;
        case "dep": return p.tinyDisp ?? -1e9;
        case "at": return p.at ?? "";
      }
    };
    return [...l].sort((a, b) => { const x = v(a), y = v(b); return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * ordem.dir; });
  }, [produtos, chip, busca, ordem]);

  const cab = (col: Col, rotulo: string, direita?: boolean, dica?: string) => {
    const on = ordem.col === col;
    return (
      <button type="button" title={dica} onClick={() => setOrdem((o) => (o.col === col ? { col, dir: (o.dir * -1) as 1 | -1 } : { col, dir: col === "nome" ? 1 : -1 }))}
        style={{ border: 0, background: "transparent", padding: "4px 0", cursor: "pointer", font: "inherit", fontSize: 11, fontWeight: on ? 600 : 500, color: on ? "var(--pm-t)" : "var(--pm-t3)", display: "flex", justifyContent: direita ? "flex-end" : "flex-start", alignItems: "center", gap: 3 }}>
        {rotulo}<span style={{ fontSize: 9.5, opacity: on ? 1 : 0.4 }}>{on ? (ordem.dir === 1 ? "▲" : "▼") : "⇅"}</span>
      </button>
    );
  };
  const num = (v: number, cor?: string, peso?: number) => (
    <span className={MONO} style={{ textAlign: "right", color: cor ?? (v ? "var(--pm-t2)" : "var(--pm-t3)"), fontWeight: peso ?? 400 }}>{v ? int(v) : "—"}</span>
  );

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--pm-t)", fontSize: 13, lineHeight: 1.4, fontVariantNumeric: "tabular-nums" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Estoque por conta</span>
        <span style={{ fontSize: 11.5, color: fresco.velho ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: fresco.velho ? 600 : 400 }}>
          CDs lidos {fresco.txt}{tinyEm ? ` · Tiny lido ${idade(tinyEm).txt}` : ""}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,190px),1fr))", gap: 10 }}>
        {loading ? [1, 2, 3, 4, 5, 6].map((k) => (
          <div key={k} style={{ height: 118, borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ width: "60%", height: 11, borderRadius: 5, background: "var(--pm-sk)" }} />
            <div style={{ width: "40%", height: 22, borderRadius: 6, background: "var(--pm-sk)" }} />
          </div>
        )) : (
          <>
            {contas.map((c) => (
              <div key={`${c.mkt}|${c.emp}`} style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={logo(c.mkt, 16)} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nomeConta(c.mkt, c.emp)}</span>
                  <span style={selo}>{NOME_EMP[c.emp] ?? c.emp}</span>
                </div>
                <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <b className={MONO} style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: c.disp <= 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{int(c.disp)}</b>
                  <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>disponível</span>
                </span>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "1px 10px", fontSize: 11.5 }}>
                  <span style={{ color: "var(--pm-t3)" }}>Reservado</span><span className={MONO} style={{ textAlign: "right" }}>{int(c.res)}</span>
                  <span style={{ color: "var(--pm-t3)" }}>A caminho</span><span className={MONO} style={{ textAlign: "right" }}>{int(c.cam)}</span>
                  <span style={{ color: "var(--pm-t3)" }}>Inutilizável</span><span className={MONO} style={{ textAlign: "right", color: c.inu ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: c.inu ? 600 : 400 }}>{int(c.inu)}</span>
                </div>
                <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>{int(c.anun)} anúncios</span>
              </div>
            ))}
            {contas.length > 0 && (
              <div style={{ background: "var(--pm-s2)", border: "1px solid var(--pm-b)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Total nos Fulls</span>
                <b className={MONO} style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em" }}>{int(tot.disp)} un</b>
                <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>{int(tot.res)} reservado · {int(tot.cam)} a caminho · {int(tot.inu)} inutilizável</span>
                {valorQ.isError ? (
                  <span style={{ fontSize: 11.5, color: "var(--pm-r)", marginTop: "auto" }}>
                    Não deu para ler o custo agora ·{" "}
                    <button type="button" onClick={() => void valorQ.refetch()} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--pm-r)", fontWeight: 600, fontSize: 11.5, textDecoration: "underline" }}>tentar de novo</button>
                  </span>
                ) : valor ? (
                  <span style={{ fontSize: 12, color: "var(--pm-t2)", marginTop: "auto" }} title="Disponível + reservado + a caminho × custo do cadastro, kit aberto nos componentes (a mesma conta do Dashboard).">
                    Valor a custo <b className={MONO} style={{ fontWeight: 600, color: "var(--pm-t)" }}>{brl(valor.v)}</b>{valor.todas ? " · as duas empresas" : ""}
                  </span>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px", padding: "12px 14px" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Por produto</span>
          <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{int(lista.length)} {lista.length === 1 ? "produto" : "produtos"} · abra para ver cada CD e conta</span>
          <div style={{ flex: 1 }} />
          {([["inu", "Com inutilizável", cont.inu], ["sem", "Sem SKU vinculado", cont.sem], ["zer", "Zerado", cont.zer]] as const).map(([id, nome, qt]) => {
            const on = chip === id;
            return (
              <button key={id} type="button" onClick={() => setChip(on ? null : id)}
                style={{ height: 32, padding: "0 11px", borderRadius: 16, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-a)" : "var(--pm-s)", color: on ? "var(--pm-oa)" : "var(--pm-t2)", cursor: "pointer", fontSize: 12, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
                {nome}<span className={MONO} style={{ fontSize: 11, fontWeight: 600 }}>{int(qt)}</span>
              </button>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 10px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", width: 220 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--pm-t3)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Produto, SKU ou anúncio"
              style={{ border: 0, outline: "none", background: "transparent", flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--pm-t)" }} />
          </div>
        </div>

        {loading ? (
          <div style={{ margin: "0 14px 14px", height: 260, borderRadius: 10, background: "var(--pm-sk)" }} />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 980 }}>
              <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 10, alignItems: "center", padding: "4px 14px", background: "var(--pm-s2)" }}>
                <span />
                {cab("nome", "Produto")}
                {cab("ncd", "CDs")}
                {cab("disp", "Disponível", true)}
                {cab("res", "Reservado", true)}
                {cab("cam", "A caminho", true)}
                {cab("inu", "Inutilizável", true)}
                {cab("dep", "Depósito da empresa", true, "Disponível no depósito Geral do Tiny (saldo − reservado). Kit = quantos dá para montar com os componentes.")}
                {cab("at", "Atualizado", true)}
              </div>
              {lista.map((p) => {
                const ab = !!aberto[p.chave];
                const foto = p.sku ? fotos[p.sku] : null;
                const ini = p.nome.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
                return (
                  <Fragment key={p.chave}>
                    <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 10, alignItems: "center", padding: "8px 14px", borderTop: "1px solid var(--pm-b)", background: ab ? "var(--pm-as)" : "transparent", fontSize: 12.5 }}>
                      <button type="button" aria-label={ab ? "Fechar" : "Abrir"} onClick={() => setAberto((a) => ({ ...a, [p.chave]: !ab }))}
                        style={{ width: 28, height: 28, borderRadius: 7, border: 0, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t3)" }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: ab ? "rotate(90deg)" : "none" }}><path d="m9 18 6-6-6-6" /></svg>
                      </button>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                        {foto ? <img src={foto} alt="" loading="lazy" style={{ width: 34, height: 34, flex: "none", borderRadius: 8, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-b)" }} />
                          : <span style={{ width: 34, height: 34, flex: "none", borderRadius: 8, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 600, color: "var(--pm-t3)" }}>{p.sku ? ini : "?"}</span>}
                        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                          <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.nome}>{p.nome}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--pm-t3)" }}>
                            {p.sku ? <span className={MONO}>SKU {p.sku}</span> : (
                              <>
                                <span className={MONO}>{p.cds[0]?.sku_marketplace}</span>
                                <span style={{ fontSize: 10.5, fontWeight: 600, padding: "0 5px", borderRadius: 4, background: "var(--pm-ams)", color: "var(--pm-am)" }}>sem SKU</span>
                                <a href="/mapeamento-skus" style={{ fontSize: 11, fontWeight: 500, color: "var(--pm-at)" }}>vincular</a>
                              </>
                            )}
                          </span>
                        </div>
                      </div>
                      <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                        {p.mkts.map((m) => <span key={m} style={logo(m, 15)} />)}
                        <span style={{ fontSize: 11.5, color: "var(--pm-t3)", marginLeft: 3 }}>{p.cds.length} {p.cds.length === 1 ? "CD" : "CDs"}</span>
                      </span>
                      <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: p.disp <= 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{int(p.disp)}</span>
                      {num(p.res)}
                      {num(p.cam)}
                      {num(p.inu, p.inu ? "var(--pm-am)" : undefined, p.inu ? 600 : 400)}
                      <span className={MONO} style={{ textAlign: "right", fontSize: 12, color: p.tinyDisp == null ? "var(--pm-t3)" : p.tinyDisp <= 0 ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: p.tinyDisp != null && p.tinyDisp <= 0 ? 600 : 400 }}
                        title={p.tinyDisp == null ? "Este SKU não está na leitura de estoque do Tiny (só os SKUs da reposição)" : undefined}>
                        {p.tinyDisp == null ? "—" : `${p.emps.map((e) => NOME_EMP[e] ?? e).join(" + ")} ${int(p.tinyDisp)}`}
                      </span>
                      <span style={{ textAlign: "right", fontSize: 11, color: "var(--pm-t3)" }}>{hm(p.at)}</span>
                    </div>
                    {ab && p.cds.map((r) => (
                      <div key={`${r.marketplace}|${r.shop_id}|${r.sku_marketplace}|${r.warehouse}`}
                        style={{ display: "grid", gridTemplateColumns: GRADE, gap: 10, alignItems: "center", padding: "6px 14px", background: "var(--pm-s2)", fontSize: 12 }}>
                        <span />
                        <span style={{ display: "flex", alignItems: "center", gap: 7, paddingLeft: 43, minWidth: 0 }}>
                          <span style={logo(r.marketplace, 15)} />
                          <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{nomeConta(r.marketplace, empDe(r))}</span>
                          <span style={selo}>{NOME_EMP[empDe(r)]}</span>
                          <span style={{ color: "var(--pm-t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${r.warehouse} · ${r.sku_marketplace}`}>{r.warehouse} · <span className={MONO}>{r.sku_marketplace}</span></span>
                        </span>
                        <span />
                        <span className={MONO} style={{ textAlign: "right", fontWeight: 600, color: n(r.sellable) <= 0 ? "var(--pm-r)" : "var(--pm-t)" }}>{int(n(r.sellable))}</span>
                        {num(n(r.reserved))}
                        {num(n(r.in_transit))}
                        {num(n(r.unsellable), n(r.unsellable) ? "var(--pm-am)" : undefined, n(r.unsellable) ? 600 : 400)}
                        <span />
                        <span style={{ textAlign: "right", fontSize: 11, color: "var(--pm-t3)" }}>{hm(r.atualizado_em)}</span>
                      </div>
                    ))}
                  </Fragment>
                );
              })}
              {lista.length === 0 && <div style={{ padding: "18px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12.5, color: "var(--pm-t3)" }}>Nenhum produto com esses filtros.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
