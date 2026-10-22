import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { LOGO, ddmm, int } from "@/components/dashboard/formato";
import { NOME_EMP } from "./Cabecalho";

// ============================================================================
// Fulfillment › Envios no design novo (Claude Design "Fulfillment", 22/out/2026): quadro com as
// 5 etapas (arraste, setas no cartão e toque) ou lista, empresa sempre visível no cartão, coleta
// com prazo, progresso do separado e, em "Enviado", o aviso de estoque não lançado no Tiny.
// Só desenho: ler, mover, arquivar e lançar ficam com quem usa (EnviosTab em fulfillment.tsx).
// ============================================================================

export interface EnvioQ {
  id: string; numero: string | null; marketplace: string; empresa: string | null; centro: string | null;
  status: string; data: string | null; plan: number; sep: number; itens: number;
  skus: Array<{ sku: string; qtd: number }>; lancadoEm: string | null; lancadoPor: string | null;
  observacao: string | null; atualizadoEm: string;
}

export const ETAPAS = [
  { id: "separando", nome: "Separando", cor: "var(--pm-st1)" },
  { id: "embalar", nome: "Embalar", cor: "var(--pm-st2)" },
  { id: "etiquetas", nome: "Etiquetas", cor: "var(--pm-st3)" },
  { id: "pronto_envio", nome: "Pronto para envio", cor: "var(--pm-st4)" },
  { id: "enviado", nome: "Enviado", cor: "var(--pm-st5)" },
] as const;
export const idxEtapa = (s: string) => Math.max(0, ETAPAS.findIndex((e) => e.id === s));

const MONO = "pm-mono";
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const logo = (mkt: string, px: number): CSSProperties => ({
  display: "inline-block", width: px, height: px, borderRadius: 4, flex: "none", boxShadow: "0 0 0 1px var(--pm-b)",
  background: `#fff url(${LOGO[mkt] ?? LOGO.shopee}) center/contain no-repeat`,
});
const seloEmp: CSSProperties = { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap", flex: "none" };
const seg = (on: boolean): CSSProperties => ({
  border: 0, cursor: "pointer", height: 28, padding: "0 11px", borderRadius: 6, fontSize: 12.5, fontWeight: on ? 600 : 500,
  background: on ? "var(--pm-s)" : "transparent", color: on ? "var(--pm-t)" : "var(--pm-t2)", boxShadow: on ? "var(--pm-sh)" : "none",
});

function coleta(e: EnvioQ): { t: string; tarde: boolean } {
  if (e.status === "enviado") return { t: e.data ? `enviado · coleta ${ddmm(e.data)}` : "enviado", tarde: false };
  if (!e.data) return { t: "sem data de coleta", tarde: false };
  const d = diasEntre(hojeSP(), e.data);
  if (d < 0) return { t: `coleta ${ddmm(e.data)} · atrasada`, tarde: true };
  if (d === 0) return { t: `coleta hoje, ${ddmm(e.data)}`, tarde: true };
  return { t: `coleta ${ddmm(e.data)} · em ${d} d`, tarde: false };
}
const numero = (e: EnvioQ) => (e.numero ? (/^\d+$/.test(e.numero) ? `#${e.numero}` : e.numero) : "(sem nº)");
const naoLancado = (e: EnvioQ) => e.status === "enviado" && !e.lancadoEm && e.sep > 0;

function Miniaturas({ e, fotos }: { e: EnvioQ; fotos: Record<string, string | null | undefined> }) {
  const mostra = e.skus.slice(0, 3);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {mostra.map((s) => (
        <span key={s.sku} title={`${s.sku} · ${int(s.qtd)} un`}
          style={{ width: 28, height: 28, borderRadius: 7, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 9.5, fontWeight: 600, color: "var(--pm-t3)" }}>
          {fotos[s.sku] ? <img src={fotos[s.sku] as string} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : s.sku.slice(-3)}
        </span>
      ))}
      {e.itens > mostra.length && <span style={{ fontSize: 11, color: "var(--pm-t3)", paddingLeft: 2 }}>+{e.itens - mostra.length}</span>}
    </div>
  );
}

function Progresso({ e, grosso }: { e: EnvioQ; grosso?: boolean }) {
  const pct = e.plan > 0 ? Math.min(1, e.sep / e.plan) : 0;
  return (
    <div style={{ height: grosso ? 6 : 6, borderRadius: 3, background: "var(--pm-sk)", overflow: "hidden", flex: 1 }}>
      <i style={{ display: "block", height: "100%", width: `${Math.round(pct * 100)}%`, background: pct >= 1 ? "var(--pm-g)" : "var(--pm-a)", borderRadius: 3 }} />
    </div>
  );
}

export function QuadroEnvios(p: {
  envios: EnvioQ[]; fotos: Record<string, string | null | undefined>;
  carregando: boolean; erro: string | null; onTentar: () => void;
  destaque: string | null; enviados30d: number | null;
  onAbrir: (id: string) => void; onMover: (id: string, status: string) => void;
  onArquivar: (id: string) => void; onLancar: (id: string) => void;
  /** botões do topo (lançar em massa, arquivados, importar, novo envio) */
  acoes: ReactNode;
}) {
  const mobile = useIsMobile();
  const [vista, setVista] = useState<"quadro" | "lista">(() => {
    try { return localStorage.getItem("fulfillment.envios.vista") === "lista" ? "lista" : "quadro"; } catch { return "quadro"; }
  });
  useEffect(() => { try { localStorage.setItem("fulfillment.envios.vista", vista); } catch { /* sem storage */ } }, [vista]);
  const [filtroEtapa, setFiltroEtapa] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [sobre, setSobre] = useState<number | null>(null);
  const [todosEnviados, setTodosEnviados] = useState(false);

  // o destaque vindo da faixa "Pede ação" rola até o cartão
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!p.destaque) return;
    const el = refs.current[p.destaque];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [p.destaque, p.envios.length, vista]);

  const abertos = p.envios.filter((e) => e.status !== "enviado");
  const unAbertas = abertos.reduce((t, e) => t + e.plan, 0);
  // em "Enviado" ficam os que pedem ação (sem estoque no Tiny) e os dos últimos 3 dias; o resto, sob demanda
  const limite = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const enviadosVisiveis = (lst: EnvioQ[]) => (todosEnviados ? lst : lst.filter((e) => naoLancado(e) || e.atualizadoEm >= limite));
  const porEtapa = useMemo(() => ETAPAS.map((_, i) => p.envios.filter((e) => idxEtapa(e.status) === i)
    .sort((a, b) => (a.data ?? "9999").localeCompare(b.data ?? "9999"))), [p.envios]);
  const verQuadro = vista === "quadro" && !mobile;

  const cartao = (e: EnvioQ) => {
    const i = idxEtapa(e.status);
    const c = coleta(e);
    const dest = p.destaque === e.id;
    return (
      <div key={e.id} ref={(el) => { refs.current[e.id] = el; }} draggable={!mobile}
        onDragStart={(ev) => { ev.dataTransfer.setData("text/plain", e.id); ev.dataTransfer.effectAllowed = "move"; setDragId(e.id); }}
        onDragEnd={() => { setDragId(null); setSobre(null); }}
        style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 12, boxShadow: "var(--pm-sh)", padding: 10, display: "flex", flexDirection: "column", gap: 8, cursor: mobile ? "default" : "grab", outline: dest ? "2px solid var(--pm-a)" : "none", outlineOffset: 1, opacity: dragId === e.id ? 0.5 : 1 }}>
        <button type="button" onClick={() => p.onAbrir(e.id)} style={{ border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, color: "inherit" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={logo(e.marketplace, 16)} />
            <span className={MONO} style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{numero(e)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span style={seloEmp}>{NOME_EMP[e.empresa ?? "ACZ Pet"] ?? e.empresa}</span>
            <span style={{ fontSize: 11.5, color: "var(--pm-t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.centro || "CD a definir"}</span>
          </div>
          <span style={{ fontSize: 11.5, color: c.tarde ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: c.tarde ? 600 : 400 }}>{c.t}</span>
          {e.skus.length > 0 && <Miniaturas e={e} fotos={p.fotos} />}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11.5 }}>
              <span style={{ color: "var(--pm-t3)" }}>{e.itens} {e.itens === 1 ? "item" : "itens"}</span>
              <span className={MONO} style={{ fontWeight: 600 }}>{int(e.sep)} / {int(e.plan)} un</span>
            </div>
            <Progresso e={e} />
          </div>
          {e.observacao && <span style={{ fontSize: 11, color: "var(--pm-t3)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{e.observacao}</span>}
        </button>
        {naoLancado(e) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "7px 8px", borderRadius: 9, background: "var(--pm-rs)" }}>
            <span style={{ fontSize: 11.5, color: "var(--pm-r)", fontWeight: 600 }}>Estoque não lançado no Tiny</span>
            <button type="button" onClick={() => p.onLancar(e.id)} style={{ height: 32, borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Lançar estoque no Tiny</button>
          </div>
        )}
        {e.status === "enviado" && e.lancadoEm && (
          <span style={{ fontSize: 11.5, color: "var(--pm-g)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }} title={e.lancadoPor ? `por ${e.lancadoPor}` : undefined}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            Estoque lançado no Tiny
          </span>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          {i < 4 && (
            <>
              <button type="button" disabled={i === 0} title="Voltar etapa" onClick={() => p.onMover(e.id, ETAPAS[i - 1].id)}
                style={{ width: 34, height: 34, flex: "none", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: i === 0 ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t2)", opacity: i === 0 ? 0.4 : 1 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <button type="button" onClick={() => p.onMover(e.id, ETAPAS[i + 1].id)}
                style={{ flex: 1, height: 34, borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s2)", cursor: "pointer", fontSize: 12, fontWeight: 500, color: "var(--pm-t)", whiteSpace: "nowrap" }}>
                {i === 3 ? "Marcar enviado" : ETAPAS[i + 1].nome} ›
              </button>
            </>
          )}
          <button type="button" title="Arquivar — sai do quadro sem excluir (dá para desarquivar)" onClick={() => p.onArquivar(e.id)}
            style={{ width: 34, height: 34, flex: "none", marginLeft: i < 4 ? 0 : "auto", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t3)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></svg>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 10, color: "var(--pm-t)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {!mobile && (
          <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8 }}>
            {(["quadro", "lista"] as const).map((v) => <button key={v} type="button" style={seg(vista === v)} onClick={() => setVista(v)}>{v === "quadro" ? "Quadro" : "Lista"}</button>)}
          </div>
        )}
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
          {abertos.length} {abertos.length === 1 ? "aberto" : "abertos"} · {int(unAbertas)} un{p.enviados30d != null ? ` · ${p.enviados30d} enviados em 30 dias` : ""}
        </span>
        <div style={{ flex: 1 }} />
        {p.acoes}
      </div>

      {p.erro ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px", padding: 16, borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)" }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, background: "var(--pm-rs)", color: "var(--pm-r)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 220 }}>
            <b style={{ fontWeight: 600 }}>Não deu para ler os envios agora</b>
            <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{p.erro}. O cabeçalho, a faixa “Pede ação” e as outras abas seguem normais. Nenhum envio foi alterado.</span>
          </div>
          <button type="button" onClick={p.onTentar} style={{ height: 34, padding: "0 14px", borderRadius: 9, border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Tentar de novo</button>
        </div>
      ) : p.carregando ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10 }}>
          {[0, 1, 2, 3, 4].map((k) => (
            <div key={k} style={{ height: 300, borderRadius: 14, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ width: "50%", height: 14, borderRadius: 5, background: "var(--pm-sk)" }} />
              <div style={{ height: 130, borderRadius: 12, background: "var(--pm-s)" }} />
            </div>
          ))}
        </div>
      ) : verQuadro ? (
        <>
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(196px,1fr))", gap: 10, minWidth: 1020, alignItems: "start" }}>
              {ETAPAS.map((et, i) => {
                const todos = porEtapa[i];
                const lst = i === 4 ? enviadosVisiveis(todos) : todos;
                const un = todos.reduce((t, e) => t + e.plan, 0);
                const over = sobre === i;
                return (
                  <div key={et.id}
                    onDragOver={(ev) => { ev.preventDefault(); if (sobre !== i) setSobre(i); }}
                    onDragLeave={() => { if (sobre === i) setSobre(null); }}
                    onDrop={(ev) => { ev.preventDefault(); const id = ev.dataTransfer.getData("text/plain") || dragId; setSobre(null); setDragId(null); if (id) p.onMover(id, et.id); }}
                    style={{ display: "flex", flexDirection: "column", gap: 8, padding: 8, borderRadius: 14, background: over ? "var(--pm-as)" : "var(--pm-s2)", border: `1px solid ${over ? "var(--pm-a)" : "var(--pm-b)"}`, minHeight: 340 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, padding: "4px 4px 2px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <i style={{ width: 9, height: 9, borderRadius: 3, background: et.cor, flex: "none" }} />
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{et.nome}</span>
                      </div>
                      <span className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>
                        {i === 4
                          ? `${todos.filter(naoLancado).length ? `${todos.filter(naoLancado).length} sem estoque no Tiny · ` : ""}${p.enviados30d ?? todos.length} em 30 dias`
                          : `${todos.length} ${todos.length === 1 ? "envio" : "envios"} · ${int(un)} un`}
                      </span>
                    </div>
                    {lst.map(cartao)}
                    {lst.length === 0 && i < 4 && (
                      <div style={{ padding: "18px 10px", borderRadius: 12, border: "1px dashed var(--pm-bs)", fontSize: 11.5, color: "var(--pm-t3)", textAlign: "center" }}>
                        {dragId ? "Solte aqui" : "Nenhum envio nesta etapa"}
                      </div>
                    )}
                    {i === 4 && todos.length > lst.length && (
                      <button type="button" onClick={() => setTodosEnviados(true)}
                        style={{ textAlign: "left", cursor: "pointer", padding: 10, borderRadius: 12, border: "1px dashed var(--pm-bs)", background: "transparent", display: "flex", flexDirection: "column", gap: 3, color: "inherit" }}>
                        <span className={MONO} style={{ fontSize: 15, fontWeight: 600 }}>{todos.length - lst.length}</span>
                        <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>enviados há mais de 3 dias, com estoque lançado no Tiny</span>
                        <span style={{ fontSize: 11.5, color: "var(--pm-at)", fontWeight: 500 }}>Mostrar todos →</span>
                      </button>
                    )}
                    {i === 4 && todosEnviados && (
                      <button type="button" onClick={() => setTodosEnviados(false)} style={{ border: 0, background: "transparent", cursor: "pointer", fontSize: 11.5, color: "var(--pm-at)", fontWeight: 500, textAlign: "left", padding: "2px 4px" }}>
                        Mostrar só os recentes
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Arraste o cartão, ou use as setas: funcionam no toque e no teclado.</span>
        </>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))", gap: 6 }}>
            {ETAPAS.map((et, i) => {
              const lst = porEtapa[i];
              const on = filtroEtapa === i;
              return (
                <button key={et.id} type="button" onClick={() => setFiltroEtapa(on ? null : i)}
                  style={{ textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 1, padding: "8px 10px", borderRadius: 10, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", color: "inherit" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: et.cor }} />{et.nome}</span>
                  <span className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>
                    {i === 4 ? `${p.enviados30d ?? lst.length} em 30 dias` : `${lst.length} · ${int(lst.reduce((t, e) => t + e.plan, 0))} un`}
                  </span>
                </button>
              );
            })}
          </div>
          {(() => {
            const linhas = p.envios
              .filter((e) => (filtroEtapa == null ? (e.status !== "enviado" || naoLancado(e) || e.atualizadoEm >= limite) : idxEtapa(e.status) === filtroEtapa))
              .sort((a, b) => idxEtapa(a.status) - idxEtapa(b.status) || (a.data ?? "9999").localeCompare(b.data ?? "9999"));
            if (mobile) {
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {linhas.length === 0 && <span style={{ fontSize: 12.5, color: "var(--pm-t3)", padding: "12px 4px" }}>Nenhum envio nesta etapa com o filtro atual.</span>}
                  {linhas.map((e) => {
                    const i = idxEtapa(e.status);
                    const c = coleta(e);
                    return (
                      <div key={e.id} ref={(el) => { refs.current[e.id] = el; }}
                        style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: 12, display: "flex", flexDirection: "column", gap: 8, outline: p.destaque === e.id ? "2px solid var(--pm-a)" : "none" }}>
                        <button type="button" onClick={() => p.onAbrir(e.id)} style={{ border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, color: "inherit" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            <i style={{ width: 8, height: 8, borderRadius: 2, background: ETAPAS[i].cor }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" }}>{ETAPAS[i].nome}</span>
                            <div style={{ flex: 1 }} />
                            <span style={seloEmp}>{NOME_EMP[e.empresa ?? "ACZ Pet"] ?? e.empresa}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={logo(e.marketplace, 18)} /><span className={MONO} style={{ fontSize: 14, fontWeight: 600 }}>{numero(e)}</span></div>
                          <span style={{ fontSize: 12, color: c.tarde ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: c.tarde ? 600 : 400 }}>{c.t} · {e.centro || "CD a definir"}</span>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Progresso e={e} /><span className={MONO} style={{ fontSize: 12, fontWeight: 600 }}>{int(e.sep)} / {int(e.plan)} un</span></div>
                        </button>
                        {i < 4 && (
                          <button type="button" onClick={() => p.onMover(e.id, ETAPAS[i + 1].id)}
                            style={{ height: 44, borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s2)", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--pm-t)" }}>
                            {i === 3 ? "Marcar enviado" : `Mover para ${ETAPAS[i + 1].nome}`} ›
                          </button>
                        )}
                        {naoLancado(e) && (
                          <button type="button" onClick={() => p.onLancar(e.id)} style={{ height: 44, borderRadius: 10, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Lançar estoque no Tiny</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }
            const cols = "150px minmax(190px,1.3fr) 130px 160px 50px 64px minmax(150px,1fr) 170px";
            return (
              <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", overflowX: "auto" }}>
                <div style={{ minWidth: 960 }}>
                  <div style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 14px", background: "var(--pm-s2)", fontSize: 11, color: "var(--pm-t3)", fontWeight: 500, borderRadius: "14px 14px 0 0" }}>
                    <span>Etapa</span><span>Envio</span><span>CD</span><span>Coleta</span><span style={{ textAlign: "right" }}>Itens</span><span style={{ textAlign: "right" }}>Un</span><span>Separado</span><span />
                  </div>
                  {linhas.length === 0 && <div style={{ padding: "18px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12.5, color: "var(--pm-t3)" }}>Nenhum envio nesta etapa com o filtro atual.</div>}
                  {linhas.map((e) => {
                    const i = idxEtapa(e.status);
                    const c = coleta(e);
                    const pct = e.plan > 0 ? Math.round(Math.min(1, e.sep / e.plan) * 100) : 0;
                    return (
                      <div key={e.id} ref={(el) => { refs.current[e.id] = el; }}
                        style={{ display: "grid", gridTemplateColumns: cols, gap: 10, alignItems: "center", padding: "8px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12.5, background: p.destaque === e.id ? "var(--pm-as)" : "transparent" }}>
                        <span style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 500 }}><i style={{ width: 8, height: 8, borderRadius: 2, background: ETAPAS[i].cor, flex: "none" }} />{ETAPAS[i].nome}</span>
                        <button type="button" onClick={() => p.onAbrir(e.id)} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 7, minWidth: 0, textAlign: "left", color: "inherit" }}>
                          <span style={logo(e.marketplace, 16)} />
                          <span className={MONO} style={{ fontWeight: 600 }}>{numero(e)}</span>
                          <span style={seloEmp}>{NOME_EMP[e.empresa ?? "ACZ Pet"] ?? e.empresa}</span>
                        </button>
                        <span style={{ color: "var(--pm-t2)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.centro || "—"}</span>
                        <span style={{ color: c.tarde ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: c.tarde ? 600 : 400, fontSize: 12 }}>{c.t}</span>
                        <span className={MONO} style={{ textAlign: "right" }}>{e.itens}</span>
                        <span className={MONO} style={{ textAlign: "right" }}>{int(e.plan)}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Progresso e={e} /><span className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t2)", width: 34, textAlign: "right" }}>{pct}%</span></div>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          {i < 4 && (
                            <button type="button" onClick={() => p.onMover(e.id, ETAPAS[i + 1].id)}
                              style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s2)", cursor: "pointer", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", color: "var(--pm-t)" }}>
                              {i === 3 ? "Marcar enviado" : ETAPAS[i + 1].nome} ›
                            </button>
                          )}
                          {naoLancado(e) && (
                            <button type="button" onClick={() => p.onLancar(e.id)} style={{ height: 30, padding: "0 10px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>Lançar no Tiny</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

/** Confirmação desenhada (no lugar do confirm do navegador) para escrita fora do app. */
export function ConfirmacaoPm({ kicker, titulo, linhas, aviso, okLabel, carregando, ocupado, onOk, onCancelar, erro }: {
  kicker: string; titulo: string; linhas: ReactNode[]; aviso?: string | null; okLabel: string;
  carregando?: boolean; ocupado?: boolean; erro?: string | null; onOk: () => void; onCancelar: () => void;
}) {
  return (
    <div className="pm-ui" onClick={() => { if (!ocupado) onCancelar(); }}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--pm-ov)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()}
        style={{ width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 16, boxShadow: "var(--pm-shl)", display: "flex", flexDirection: "column", color: "var(--pm-t)" }}>
        <div style={{ padding: "16px 18px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 500 }}>{kicker}</span>
          <b style={{ fontSize: 16, fontWeight: 600 }}>{titulo}</b>
        </div>
        <div style={{ padding: "6px 18px 12px", display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: "var(--pm-t2)" }}>
          {carregando ? (
            <>
              <div style={{ width: "80%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
              <div style={{ width: "60%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
            </>
          ) : linhas.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}><span style={{ color: "var(--pm-t3)" }}>•</span><span style={{ textWrap: "pretty" }}>{l}</span></div>
          ))}
          {aviso && <div style={{ padding: "8px 10px", borderRadius: 10, background: "var(--pm-rs)", color: "var(--pm-r)", fontWeight: 500, textWrap: "pretty" }}>{aviso}</div>}
          {erro && <div style={{ padding: "8px 10px", borderRadius: 10, background: "var(--pm-rs)", color: "var(--pm-r)", textWrap: "pretty" }}>{erro}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--pm-b)" }}>
          <button type="button" disabled={ocupado} onClick={onCancelar} style={{ height: 40, padding: "0 14px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 13, color: "var(--pm-t)" }}>Cancelar</button>
          <button type="button" disabled={ocupado || carregando} onClick={onOk}
            style={{ height: 40, padding: "0 16px", borderRadius: 9, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: ocupado || carregando ? "default" : "pointer", fontSize: 13, fontWeight: 600, opacity: ocupado || carregando ? 0.6 : 1 }}>
            {ocupado ? "Enviando…" : okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
