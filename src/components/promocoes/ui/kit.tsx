import { useState, type CSSProperties, type ReactNode } from "react";
import { Bot, Package, RefreshCw, Search, X } from "lucide-react";

// ============================================================================
// Kit visual da tela Promoções — design "Promoções" do Claude Design (21/out/2026,
// pacote em Downloads "Visual language selection inquiry.zip", arquivo Promocoes.dc.html).
// Padrão único para os marketplaces: cabeçalho com marketplace/loja/sincronização,
// faixa "Pede decisão", lista de promoções + cartão do robô, tabela de produtos e
// prévia "de → para". Só apresentação: cálculo de margem e escrita no marketplace
// ficam em quem usa (ShopeeMinha etc.). Cores = tokens --pm-* (.pm-ui em styles.css).
// ============================================================================

export const BRL = (v: number) => {
  const neg = v < -0.004;
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return `${neg ? "−" : ""}R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
};
export const PCT = (v: number, d = 1) => `${v < -0.0004 ? "−" : ""}${Math.abs(v * 100).toFixed(d).replace(".", ",")}%`;
export const INT = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
/** Valor para o campo de preço ("42,10"). */
export const IN = (v: number) => v.toFixed(2).replace(".", ",");
export function parseNum(t: unknown): number | null {
  let x = String(t ?? "").trim().replace(/^R\$\s*/, "");
  if (x.includes(",")) x = x.replace(/\./g, "").replace(",", ".");
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
export const corMc = (p: number) => (p < 0 ? "var(--pm-r)" : p < 0.1 ? "var(--pm-am)" : "var(--pm-g)");
export const semAcento = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Botão de segmento (selecionado = cartão branco com sombra). */
export const seg = (on: boolean): CSSProperties => ({
  background: on ? "var(--pm-s)" : "transparent", color: on ? "var(--pm-t)" : "var(--pm-t2)",
  fontWeight: on ? 600 : 500, boxShadow: on ? "var(--pm-sh)" : "none",
});
const MONO = "pm-mono";

// ---------------------------------------------------------------- estados
export type EstadoLinha = "na" | "programado" | "aguardando" | "recusado" | "fora" | "auto" | "melhor" | "troca" | "encerrada" | "aplicado" | "pulado" | "pausado" | "outra" | "candidata";
export const EST: Record<EstadoLinha, [string, string, string]> = {
  na: ["Na promoção", "var(--pm-gs)", "var(--pm-g)"], programado: ["Programado", "var(--pm-as)", "var(--pm-at)"],
  aguardando: ["Aguardando", "var(--pm-ams)", "var(--pm-am)"], recusado: ["Recusado", "var(--pm-rs)", "var(--pm-r)"],
  fora: ["Fora de promoção", "var(--pm-gr)", "var(--pm-t2)"], auto: ["Entra automático", "var(--pm-gs)", "var(--pm-g)"],
  melhor: ["Há promoção melhor", "var(--pm-ams)", "var(--pm-am)"], troca: ["Sugestão de troca", "var(--pm-as)", "var(--pm-at)"],
  encerrada: ["Encerrada", "var(--pm-gr)", "var(--pm-t3)"], aplicado: ["Aplicado agora", "var(--pm-gs)", "var(--pm-g)"],
  pulado: ["Pulado", "var(--pm-gr)", "var(--pm-t2)"], pausado: ["Pausado", "var(--pm-gr)", "var(--pm-t3)"],
  outra: ["Já em outra", "var(--pm-gr)", "var(--pm-t2)"], candidata: ["Candidata", "var(--pm-gr)", "var(--pm-t2)"],
};
export type StatusPromo = "andamento" | "programada" | "encerrada" | "adesao" | "aguardando" | "fora";
export const PST: Record<StatusPromo, [string, string, string]> = {
  andamento: ["Em andamento", "var(--pm-gs)", "var(--pm-g)"], programada: ["Programada", "var(--pm-as)", "var(--pm-at)"],
  encerrada: ["Encerrada", "var(--pm-gr)", "var(--pm-t3)"], adesao: ["Aceitando adesão", "var(--pm-as)", "var(--pm-at)"],
  aguardando: ["Aguardando você", "var(--pm-ams)", "var(--pm-am)"], fora: ["Sugestão", "var(--pm-gr)", "var(--pm-t2)"],
};
export function Chip({ bg, cor, children, size = 11 }: { bg: string; cor: string; children: ReactNode; size?: number }) {
  return <span style={{ fontSize: size, fontWeight: 600, padding: "2px 7px", borderRadius: 6, background: bg, color: cor, whiteSpace: "nowrap" }}>{children}</span>;
}

// ---------------------------------------------------------------- cabeçalho
export interface MktTab { id: string; nome: string; logo: string; alerta?: number }
export function CabecalhoMkt({ mkts, mkt, onMkt, lojaRot, lojas, loja, onLoja, sync, subtabs, sub, onSub, resumo }: {
  mkts: MktTab[]; mkt: string; onMkt: (id: string) => void;
  lojaRot?: string; lojas?: Array<{ id: string | number; nome: string }>; loja?: string | number; onLoja?: (id: string | number) => void;
  sync?: { txt: string; tom: "ok" | "am" | "r"; girando?: boolean; onClick: () => void };
  subtabs?: Array<{ id: string; nome: string }>; sub?: string; onSub?: (id: string) => void;
  resumo?: Array<{ v: string; k: string }>;
}) {
  const corSync = sync?.tom === "am" ? "var(--pm-am)" : sync?.tom === "r" ? "var(--pm-r)" : "var(--pm-t3)";
  const dotSync = sync?.tom === "am" ? "var(--pm-am)" : sync?.tom === "r" ? "var(--pm-r)" : "var(--pm-g)";
  return (
    <div className="pm-card" style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 2, padding: 3, background: "var(--pm-s2)", borderRadius: 10, flexWrap: "wrap" }}>
          {mkts.map((m) => (
            <button key={m.id} type="button" onClick={() => onMkt(m.id)}
              style={{ display: "flex", alignItems: "center", gap: 8, border: 0, cursor: "pointer", padding: "7px 14px", borderRadius: 8, fontSize: 13, ...seg(m.id === mkt) }}>
              <span style={{ width: 22, height: 22, flex: "none", borderRadius: 6, background: "#fff", boxShadow: "0 0 0 1px var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <img src={m.logo} alt="" style={{ width: 18, height: 18, objectFit: "contain", display: "block" }} />
              </span>
              {m.nome}
              {!!m.alerta && m.alerta > 0 && (
                <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "var(--pm-r)", color: "var(--pm-or)", fontSize: 10.5, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{m.alerta}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {lojas && lojas.length > 0 && (
            <>
              <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{lojaRot ?? "Loja"}</span>
              <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8 }}>
                {lojas.map((l) => (
                  <button key={l.id} type="button" onClick={() => onLoja?.(l.id)}
                    style={{ border: 0, cursor: "pointer", padding: "5px 11px", borderRadius: 6, fontSize: 12.5, ...seg(l.id === loja) }}>{l.nome}</button>
                ))}
              </div>
            </>
          )}
          {sync && (
            <>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: corSync }}>
                <i style={{ width: 7, height: 7, borderRadius: "50%", background: dotSync }} />Atualizado {sync.txt}
              </span>
              <button type="button" onClick={sync.onClick} disabled={sync.girando} className="hover:bg-[var(--pm-s2)]"
                style={{ display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)" }}>
                <RefreshCw className={sync.girando ? "animate-spin" : ""} style={{ width: 14, height: 14 }} />Sincronizar
              </button>
            </>
          )}
        </div>
      </div>
      {((subtabs && subtabs.length > 0) || (resumo && resumo.length > 0)) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 20px", justifyContent: "space-between" }}>
          {subtabs && subtabs.length > 0 ? (
            <div style={{ display: "flex", gap: 4 }}>
              {subtabs.map((t) => {
                const on = t.id === sub;
                return (
                  <button key={t.id} type="button" onClick={() => onSub?.(t.id)}
                    style={{ border: 0, cursor: "pointer", padding: "5px 12px", borderRadius: 8, fontSize: 12.5, fontWeight: on ? 600 : 500, background: on ? "var(--pm-as)" : "transparent", color: on ? "var(--pm-at)" : "var(--pm-t2)" }}>{t.nome}</button>
                );
              })}
            </div>
          ) : <span />}
          {resumo && resumo.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontSize: 12, color: "var(--pm-t3)" }}>
              {resumo.map((x) => (
                <span key={x.k}><b className={MONO} style={{ fontWeight: 600, color: "var(--pm-t)", fontSize: 12.5 }}>{x.v}</b> {x.k}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- faixa "Pede decisão"
export interface CartaoDecisao { id: string; n: string; label: string; sub: string; tom: string; ativo?: boolean; onClick?: () => void }
export function FaixaDecisao({ sub, cards, carregando, filtroNome, onLimpar }: {
  sub: string; cards: CartaoDecisao[]; carregando?: boolean; filtroNome?: string | null; onLimpar?: () => void;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Pede decisão</h2>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{sub}</span>
        {filtroNome && (
          <button type="button" onClick={onLimpar}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px", borderRadius: 7, border: "1px solid var(--pm-a)", background: "var(--pm-as)", color: "var(--pm-at)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
            Filtrando: {filtroNome}<X style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(132px,1fr))", gap: 8 }}>
        {carregando
          ? Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ height: 84, borderRadius: 12, border: "1px solid var(--pm-b)", background: "var(--pm-s)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ width: "40%", height: 20, borderRadius: 6, background: "var(--pm-sk)" }} />
              <div style={{ width: "80%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
            </div>
          ))
          : cards.map((c) => {
            const zero = c.n === "0" || c.n === "—";
            return (
              <button key={c.id} type="button" onClick={c.onClick}
                style={{ textAlign: "left", cursor: c.onClick ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 2, padding: "10px 12px", borderRadius: 12, border: `1px solid ${c.ativo ? "var(--pm-a)" : "var(--pm-b)"}`, background: c.ativo ? "var(--pm-as)" : "var(--pm-s)", boxShadow: "var(--pm-sh)" }}>
                <span className={MONO} style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", color: zero ? "var(--pm-t3)" : c.tom }}>{c.n}</span>
                <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--pm-t)", textWrap: "pretty" }}>{c.label}</span>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{zero && c.n === "0" ? "tudo certo" : c.sub}</span>
              </button>
            );
          })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- lista de promoções
export interface ItemLista { id: string; nome: string; periodo: string; status: StatusPromo; itensTxt: string; fimTxt?: string | null; match?: number; apagada?: boolean }
export function ListaPromos({ titulo, itens, sel, onSel, carregando, vazio, onNova }: {
  titulo: string; itens: ItemLista[]; sel: string | null; onSel: (id: string) => void;
  carregando?: boolean; vazio?: ReactNode; onNova?: () => void;
}) {
  return (
    <div className="pm-card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 6px" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" }}>{titulo}</span>
        {onNova && (
          <button type="button" onClick={onNova} className="hover:bg-[var(--pm-s2)]"
            style={{ display: "flex", alignItems: "center", gap: 4, height: 24, padding: "0 8px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 11.5, color: "var(--pm-t2)" }}>+ Nova</button>
        )}
      </div>
      {carregando && Array.from({ length: 4 }, (_, i) => (
        <div key={i} style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ width: "70%", height: 12, borderRadius: 5, background: "var(--pm-sk)" }} />
          <div style={{ width: "90%", height: 9, borderRadius: 5, background: "var(--pm-sk)" }} />
          <div style={{ width: "40%", height: 9, borderRadius: 5, background: "var(--pm-sk)" }} />
        </div>
      ))}
      {!carregando && itens.length === 0 && vazio}
      {!carregando && itens.map((p) => {
        const on = p.id === sel; const st = PST[p.status];
        return (
          <button key={p.id} type="button" onClick={() => onSel(p.id)} className="hover:border-[var(--pm-bs)]"
            style={{ width: "100%", textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4, padding: "9px 10px", borderRadius: 10, border: `1px solid ${on ? "var(--pm-a)" : "transparent"}`, background: on ? "var(--pm-as)" : "transparent", opacity: p.apagada ? 0.5 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.nome}>{p.nome}</span>
              {!!p.match && p.match > 0 && (
                <span style={{ minWidth: 20, height: 18, padding: "0 6px", borderRadius: 9, background: "var(--pm-a)", color: "var(--pm-oa)", fontSize: 10.5, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{p.match}</span>
              )}
            </div>
            <div className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{p.periodo}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Chip bg={st[1]} cor={st[2]} size={10.5}>{st[0]}</Chip>
              <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{p.itensTxt}</span>
              {p.fimTxt && <Chip bg="var(--pm-ams)" cor="var(--pm-am)" size={10.5}>{p.fimTxt}</Chip>}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- cartão do robô
export type ModoRobo = "ligado" | "simulacao" | "desligado";
const MST: Record<ModoRobo, [string, string]> = { ligado: ["Ligado", "var(--pm-g)"], simulacao: ["Simulação", "var(--pm-am)"], desligado: ["Desligado", "var(--pm-t3)"] };
export function CartaoRobo({ nome, desc, modo, modos, onModo, ultima, proxima, params, fez, rodape }: {
  nome: string; desc: string; modo: ModoRobo; modos?: ModoRobo[]; onModo?: (m: ModoRobo) => void;
  ultima: string; proxima: string; params?: Array<{ k: string; v: string }>; fez: string; rodape?: ReactNode;
}) {
  return (
    <div className="pm-card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: "var(--pm-as)", color: "var(--pm-at)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}><Bot style={{ width: 15, height: 15 }} /></div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{nome}</span>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{desc}</span>
        </div>
      </div>
      {modos && modos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${modos.length},1fr)`, gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8 }}>
          {modos.map((m) => (
            <button key={m} type="button" onClick={() => onModo?.(m)} disabled={!onModo}
              style={{ border: 0, cursor: onModo ? "pointer" : "default", padding: "4px 0", borderRadius: 6, fontSize: 11.5, ...seg(m === modo) }}>{MST[m][0]}</button>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", fontSize: 12 }}>
        <span style={{ color: "var(--pm-t3)" }}>Última</span><span className={MONO}>{ultima}</span>
        <span style={{ color: "var(--pm-t3)" }}>Próxima</span><span className={MONO}>{modo === "desligado" ? "—" : proxima}</span>
        {(params ?? []).map((q) => (<span key={q.k} style={{ display: "contents" }}><span style={{ color: "var(--pm-t3)" }}>{q.k}</span><span className={MONO}>{q.v}</span></span>))}
      </div>
      <div style={{ fontSize: 12, color: "var(--pm-t2)", padding: "8px 10px", borderRadius: 8, background: "var(--pm-s2)", textWrap: "pretty" }}>
        <b style={{ fontWeight: 600, color: MST[modo][1] }}>{MST[modo][0]}.</b> {fez}
      </div>
      {rodape}
    </div>
  );
}

// ---------------------------------------------------------------- tabela de produtos
export interface ContaMc { v: number; pct: number; linhas: Array<{ k: string; v: number }> }
export interface LinhaPromo {
  key: string; grupo: string; nome: string; sub?: string | null; foto?: string | null; sku: string | null; code: string;
  cheio: number; promo: number; estado: EstadoLinha; motivo?: string | null;
  v30: number | null; estoque: number | null;
  conta: (preco: number) => ContaMc | null;
  /** Custo (CMV) por unidade usado na conta da MC. */
  cmv?: number | null;
  semCusto: boolean; mcNota?: string | null;
  precoPara?: (alvo: number) => number | null;
  /** Conteúdo a mais embaixo do estado (ex.: estoque/limite da relâmpago). */
  estadoExtra?: ReactNode;
  /** Linha esmaecida (ex.: item pausado). */
  apagada?: boolean;
}
export interface Faixa { id: string; nome: string; t: (p: number) => boolean }
export const FAIXAS: Faixa[] = [
  { id: "todas", nome: "Todas", t: () => true }, { id: "lt10", nome: "< 10%", t: (p) => p < 0.1 },
  { id: "10a15", nome: "10–15%", t: (p) => p >= 0.1 && p < 0.15 }, { id: "15a20", nome: "15–20%", t: (p) => p >= 0.15 && p < 0.2 },
  { id: "20a25", nome: "20–25%", t: (p) => p >= 0.2 && p < 0.25 }, { id: "gt25", nome: "> 25%", t: (p) => p >= 0.25 },
];
export const ALVOS = [0.1, 0.15, 0.1725, 0.2];
export const alvoNome = (a: number) => PCT(a, a === 0.1725 ? 2 : 0);

export function Foto({ url, size = 38 }: { url?: string | null; size?: number }) {
  const [erro, setErro] = useState(false);
  return (
    <div style={{ width: size, height: size, flex: "none", borderRadius: 8, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", color: "var(--pm-t3)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {url && !erro
        ? <img src={url} alt="" loading="lazy" onError={() => setErro(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        : <Package style={{ width: 16, height: 16 }} strokeWidth={1.5} />}
    </div>
  );
}

function Check({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div role="checkbox" aria-checked={on} tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onClick(); } }}
      style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${on ? "var(--pm-a)" : "var(--pm-bs)"}`, background: on ? "var(--pm-a)" : "var(--pm-s)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--pm-oa)" }}>
      {on && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
    </div>
  );
}

const pos = (el: HTMLElement, w: number, h: number) => {
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  return { x: Math.round(x), y: Math.round(y) };
};

export const COLS = "40px minmax(230px,1.7fr) 176px 84px 104px 104px 88px 140px 64px";

/** Cabeçalho do detalhe + barra de filtros + tabela + barra de lote + rodapé. */
export function TabelaPromo({
  cabecalho, linhas, editavel, fora, drafts, setDraft, sel, setSel, busca, setBusca, faixa, setFaixa,
  precoLabel, extraLabel, extra, acoes, filtroLinha, lote, rodape, carregando, carregandoTxt, ordem,
}: {
  cabecalho: ReactNode;
  linhas: LinhaPromo[]; editavel: boolean; fora?: boolean;
  drafts: Map<string, string>; setDraft: (key: string, txt: string | null) => void;
  sel: Set<string>; setSel: (s: Set<string>) => void;
  busca: string; setBusca: (s: string) => void; faixa: string; setFaixa: (f: string) => void;
  precoLabel: string; extraLabel: string;
  extra: (l: LinhaPromo, preco: number) => ReactNode;
  acoes?: (l: LinhaPromo, preco: number) => ReactNode;
  filtroLinha?: ((l: LinhaPromo) => boolean) | null;
  lote: { onAlvo: (a: number) => void; onDesc: (x: number) => void; onTirar?: () => void; onColocar?: () => void };
  rodape: string; carregando?: boolean; carregandoTxt?: string; ordem?: ReactNode;
}) {
  const [tip, setTip] = useState<{ key: string; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const termos = semAcento(busca.trim()).split(/\s+/).filter(Boolean);

  const base = linhas.map((l) => {
    const dt = drafts.get(l.key);
    const dv = dt != null ? parseNum(dt) : null;
    const p = editavel && dv != null ? dv : l.promo;
    const mudou = editavel && dv != null && dv !== l.promo;
    return { l, p, dt, mudou, m: l.conta(p), m0: l.conta(l.promo) };
  });
  const passaBusca = (o: typeof base[number]) => !termos.length || termos.every((t) => semAcento(`${o.l.nome} ${o.l.sub ?? ""} ${o.l.sku ?? ""} ${o.l.code}`).includes(t));
  const passaF = (o: typeof base[number]) => !filtroLinha || filtroLinha(o.l);
  const FX = FAIXAS.find((f) => f.id === faixa) ?? FAIXAS[0];
  const vis = base.filter((o) => passaBusca(o) && passaF(o) && (faixa === "todas" || (o.m && FX.t(o.m.pct))));
  const visKeys = vis.map((o) => o.l.key);
  const allOn = visKeys.length > 0 && visKeys.every((k) => sel.has(k));
  const nSel = linhas.filter((l) => sel.has(l.key)).length;

  const tipO = tip ? base.find((o) => o.l.key === tip.key) : null;
  const menuO = menu ? base.find((o) => o.l.key === menu.key) : null;

  return (
    <div className="pm-card" style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
      {carregando ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--pm-t3)" }}>
            <RefreshCw className="animate-spin" style={{ width: 14, height: 14 }} />{carregandoTxt ?? "Carregando…"}
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", borderTop: "1px solid var(--pm-b)" }}>
              <div style={{ width: 38, height: 38, borderRadius: 8, background: "var(--pm-sk)" }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ width: "45%", height: 11, borderRadius: 5, background: "var(--pm-sk)" }} />
                <div style={{ width: "25%", height: 9, borderRadius: 5, background: "var(--pm-sk)" }} />
              </div>
              <div style={{ width: 90, height: 26, borderRadius: 8, background: "var(--pm-sk)" }} />
              <div style={{ width: 60, height: 26, borderRadius: 8, background: "var(--pm-sk)" }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ padding: "14px 16px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
            {cabecalho}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 8px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", width: 240, color: "var(--pm-t3)" }}>
                <Search style={{ width: 13, height: 13 }} />
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto (ex.: areia bumi)"
                  style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "var(--pm-t)", fontSize: 12, outline: "none", padding: 0 }} />
                {busca && <button type="button" onClick={() => setBusca("")} style={{ border: 0, background: "transparent", cursor: "pointer", color: "var(--pm-t3)", padding: 0, display: "flex" }}><X style={{ width: 12, height: 12 }} /></button>}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: "0 2px 0 6px" }}>MC</span>
              {FAIXAS.map((f) => {
                const on = faixa === f.id;
                const n = base.filter((o) => passaBusca(o) && passaF(o) && (f.id === "todas" || (o.m && f.t(o.m.pct)))).length;
                return (
                  <button key={f.id} type="button" onClick={() => setFaixa(f.id)}
                    style={{ height: 26, padding: "0 9px", borderRadius: 7, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", color: on ? "var(--pm-at)" : "var(--pm-t2)", cursor: "pointer", fontSize: 11.5, display: "flex", alignItems: "center", gap: 5 }}>
                    {f.nome}<span className={MONO} style={{ opacity: 0.7 }}>{n}</span>
                  </button>
                );
              })}
              <div style={{ flex: 1 }} />
              {ordem}
            </div>
          </div>
          <div className="overflow-x-auto xl:overflow-visible" style={{ borderTop: "1px solid var(--pm-b)" }}>
            <div style={{ minWidth: 1014 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", height: 34, background: "var(--pm-s2)", fontSize: 11.5, fontWeight: 500, color: "var(--pm-t3)", position: "sticky", top: 66, zIndex: 5, borderBottom: "1px solid var(--pm-b)", boxShadow: "0 2px 6px -4px oklch(0.2 0.02 270 / 0.35)" }}>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <Check on={allOn} onClick={() => { const n = new Set(sel); visKeys.forEach((k) => { if (allOn) n.delete(k); else n.add(k); }); setSel(n); }} />
                </div>
                <div>Produto</div>
                <div style={{ textAlign: "right", padding: "0 10px" }}>{precoLabel}</div>
                <div style={{ textAlign: "right", padding: "0 10px" }} title="Custo do produto por unidade (o mesmo da conta da MC)">CMV un.</div>
                <div style={{ textAlign: "right", padding: "0 10px" }}>MC por unidade</div>
                <div style={{ textAlign: "right", padding: "0 10px" }}>{extraLabel}</div>
                <div style={{ textAlign: "right", padding: "0 10px" }}>Vendas 30d</div>
                <div style={{ padding: "0 8px" }}>Estado</div>
                <div />
              </div>
              {vis.map((o) => {
                const { l, p, m, m0 } = o;
                const chk = sel.has(l.key);
                const st = EST[l.estado] ?? EST.na;
                const desc = l.cheio > 0 ? 1 - p / l.cheio : 0;
                return (
                  <div key={l.key} style={{ display: "grid", gridTemplateColumns: COLS, alignItems: "center", minHeight: 62, padding: "6px 0", borderTop: "1px solid var(--pm-b)", background: l.estado === "recusado" ? "var(--pm-rs)" : chk ? "var(--pm-as)" : "transparent", opacity: l.apagada ? 0.55 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      <Check on={chk} onClick={() => { const n = new Set(sel); if (chk) n.delete(l.key); else n.add(l.key); setSel(n); }} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, paddingRight: 8 }}>
                      <Foto url={l.foto} />
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                        <span title={l.nome} style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.nome}</span>
                        <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`SKU ${l.sku ?? "—"} · ${l.code}${l.sub ? ` · ${l.sub}` : ""}`}>
                          SKU {l.sku ?? "—"} · {l.code}{l.sub ? ` · ${l.sub}` : ""}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, padding: "0 10px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--pm-t3)" }}>
                        <span className={MONO} style={{ textDecoration: fora ? "none" : "line-through" }}>{BRL(l.cheio)}</span>
                        {!fora && desc > 0.0001 && <span className={MONO} style={{ fontWeight: 600, color: "var(--pm-t2)" }}>−{Math.round(desc * 100)}%</span>}
                      </div>
                      {editavel ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <div style={{ display: "flex", alignItems: "center", height: 28, borderRadius: 8, border: `1px solid ${o.mudou ? "var(--pm-am)" : "var(--pm-b)"}`, background: o.mudou ? "var(--pm-ams)" : "var(--pm-s)", padding: "0 7px", gap: 3, width: 104 }}>
                            <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>R$</span>
                            <input value={o.dt ?? IN(l.promo)} inputMode="decimal" className={MONO}
                              onChange={(e) => setDraft(l.key, e.target.value)}
                              onBlur={() => { const t = drafts.get(l.key); if (t == null) return; const n = parseNum(t); if (n == null || n === l.promo) setDraft(l.key, null); else setDraft(l.key, IN(n)); }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setDraft(l.key, null); (e.target as HTMLInputElement).blur(); } }}
                              style={{ width: "100%", minWidth: 0, border: 0, background: "transparent", color: "var(--pm-t)", fontSize: 12.5, textAlign: "right", outline: "none", padding: 0 }} />
                          </div>
                          {l.precoPara && (
                            <button type="button" title="Preço para uma faixa de MC" className="hover:bg-[var(--pm-s2)] hover:text-[var(--pm-at)]"
                              onClick={(e) => { setTip(null); setMenu({ key: l.key, ...pos(e.currentTarget, 250, 230) }); }}
                              style={{ width: 28, height: 28, borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
                            </button>
                          )}
                        </div>
                      ) : <span className={MONO} style={{ fontSize: 13, fontWeight: 500 }}>{BRL(p)}</span>}
                    </div>
                    <div className={MONO} style={{ textAlign: "right", padding: "0 10px", fontSize: 12.5, color: l.cmv != null ? "var(--pm-t2)" : "var(--pm-t3)" }}>
                      {l.cmv != null ? BRL(l.cmv) : "—"}
                    </div>
                    <div onMouseEnter={(e) => setTip({ key: l.key, ...pos(e.currentTarget, 290, 170) })} onMouseLeave={() => setTip(null)}
                      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, padding: "0 10px", cursor: "help" }}>
                      {m ? (
                        <>
                          <span className={MONO} style={{ fontWeight: 600, fontSize: 13.5, color: corMc(m.pct) }}>{PCT(m.pct)}</span>
                          <span className={MONO} style={{ fontSize: 11.5, color: corMc(m.pct) }}>{BRL(m.v)}</span>
                          {o.mudou && m0 && <span className={MONO} style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>era {PCT(m0.pct)}</span>}
                        </>
                      ) : l.semCusto ? (
                        <>
                          <Chip bg="var(--pm-ams)" cor="var(--pm-am)">sem custo</Chip>
                          <span style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>MC não calculada</span>
                        </>
                      ) : <span style={{ fontSize: 11, color: "var(--pm-t3)", textAlign: "right" }}>{l.mcNota ?? "—"}</span>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", padding: "0 10px", gap: 1 }}>{extra(l, p)}</div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", padding: "0 10px", gap: 1 }}>
                      <span className={MONO} style={{ fontSize: 12.5 }}>{l.v30 != null ? INT(l.v30) : "—"}</span>
                      <span style={{ fontSize: 10.5, color: "var(--pm-t3)", whiteSpace: "nowrap" }}>{l.estoque != null ? `${INT(l.estoque)} em estoque` : ""}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, padding: "0 8px", minWidth: 0 }}>
                      <Chip bg={st[1]} cor={st[2]}>{st[0]}</Chip>
                      {l.motivo && <span style={{ fontSize: 11, color: "var(--pm-t2)", lineHeight: 1.3, textWrap: "pretty" }}>{l.motivo}</span>}
                      {l.estadoExtra}
                    </div>
                    <div style={{ display: "flex", gap: 2, justifyContent: "flex-end", paddingRight: 8 }}>{acoes?.(l, p)}</div>
                  </div>
                );
              })}
              {vis.length === 0 && <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--pm-t3)", fontSize: 12.5, borderTop: "1px solid var(--pm-b)" }}>Nenhum produto neste filtro.</div>}
            </div>
          </div>
          {nSel > 0 && (
            <div style={{ position: "sticky", bottom: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--pm-as)", borderTop: "1px solid var(--pm-a)", color: "var(--pm-at)", fontSize: 12.5 }}>
              <b style={{ fontWeight: 600 }}>{nSel} selecionados</b>
              {editavel && (
                <>
                  <span style={{ marginLeft: 8, color: "var(--pm-t2)" }}>Preço para</span>
                  {ALVOS.map((a) => (
                    <button key={a} type="button" onClick={() => lote.onAlvo(a)} className={`${MONO} hover:border-[var(--pm-a)]`}
                      style={{ height: 26, padding: "0 9px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t)", cursor: "pointer", fontSize: 12 }}>MC {alvoNome(a)}</button>
                  ))}
                  <span style={{ marginLeft: 8, color: "var(--pm-t2)" }}>Desconto</span>
                  {[0.05, 0.1, 0.15].map((x) => (
                    <button key={x} type="button" onClick={() => lote.onDesc(x)} className={`${MONO} hover:border-[var(--pm-a)]`}
                      style={{ height: 26, padding: "0 9px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t)", cursor: "pointer", fontSize: 12 }}>−{Math.round(x * 100)}%</button>
                  ))}
                  <div style={{ flex: 1 }} />
                  {lote.onTirar && (
                    <button type="button" onClick={lote.onTirar}
                      style={{ height: 28, padding: "0 10px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>Tirar da promoção</button>
                  )}
                </>
              )}
              {fora && lote.onColocar && (
                <>
                  <div style={{ flex: 1 }} />
                  <button type="button" onClick={lote.onColocar}
                    style={{ height: 28, padding: "0 12px", borderRadius: 7, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Colocar em promoção</button>
                </>
              )}
              <button type="button" onClick={() => { const n = new Set(sel); linhas.forEach((l) => n.delete(l.key)); setSel(n); }}
                style={{ height: 28, padding: "0 10px", borderRadius: 7, border: 0, background: "transparent", color: "var(--pm-at)", cursor: "pointer", fontSize: 12 }}>Limpar</button>
            </div>
          )}
          <p style={{ margin: 0, padding: "10px 16px 14px", fontSize: 11.5, color: "var(--pm-t3)", borderTop: "1px solid var(--pm-b)", textWrap: "pretty" }}>{rodape}</p>
        </>
      )}

      {tip && tipO && (
        <div style={{ position: "fixed", left: tip.x, top: tip.y, zIndex: 60, width: 290, background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 12, boxShadow: "var(--pm-shl)", padding: "10px 12px", fontSize: 12, pointerEvents: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {tipO.m ? (
            <>
              <span style={{ fontSize: 11, color: "var(--pm-t3)", marginBottom: 2 }}>Conta da MC, por unidade</span>
              {tipO.m.linhas.map((ln) => (
                <div key={ln.k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span style={{ color: "var(--pm-t2)", flex: 1, minWidth: 0 }}>{ln.k}</span><span className={MONO} style={{ whiteSpace: "nowrap" }}>{BRL(ln.v)}</span></div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--pm-b)", paddingTop: 5, marginTop: 2, fontWeight: 600 }}>
                <span>= MC</span><span className={MONO} style={{ color: corMc(tipO.m.pct) }}>{BRL(tipO.m.v)} · {PCT(tipO.m.pct)}</span>
              </div>
            </>
          ) : tipO.l.semCusto ? (
            <>
              <span style={{ fontWeight: 600 }}>Produto sem custo cadastrado</span>
              <span style={{ color: "var(--pm-t2)", textWrap: "pretty" }}>Sem CMV não dá para calcular a MC, então o app não mostra um número. Cadastre o custo (ou a composição do kit) no Tiny.</span>
            </>
          ) : <span style={{ color: "var(--pm-t2)" }}>{tipO.l.mcNota ?? "Sem base para estimar a MC."}</span>}
        </div>
      )}
      {menu && menuO && menuO.l.precoPara && (
        <>
          <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 41, width: 250, background: "var(--pm-s)", color: "var(--pm-t)", border: "1px solid var(--pm-b)", borderRadius: 12, boxShadow: "var(--pm-shl)", padding: 6, display: "flex", flexDirection: "column" }}>
            <span style={{ padding: "5px 8px 6px", fontSize: 11.5, color: "var(--pm-t3)" }}>Preço para atingir a MC</span>
            {ALVOS.map((a) => {
              const pz = menuO.l.precoPara!(a);
              const ok = pz != null && pz < menuO.l.cheio;
              return (
                <button key={a} type="button" className="hover:bg-[var(--pm-s2)]"
                  onClick={() => { if (ok) { setDraft(menuO.l.key, IN(pz!)); setMenu(null); } }}
                  style={{ display: "grid", gridTemplateColumns: "1fr auto 40px", gap: 10, alignItems: "center", padding: "7px 8px", border: 0, borderRadius: 8, background: "transparent", cursor: ok ? "pointer" : "default", textAlign: "left", fontSize: 12.5, color: ok ? "var(--pm-t)" : "var(--pm-t3)" }}>
                  <span>MC {alvoNome(a)}</span>
                  <span className={MONO}>{pz == null ? "sem custo" : ok ? BRL(pz) : "acima do cheio"}</span>
                  <span className={MONO} style={{ color: "var(--pm-t3)", textAlign: "right" }}>{ok ? `−${Math.round((1 - pz! / menuO.l.cheio) * 100)}%` : ""}</span>
                </button>
              );
            })}
            <button type="button" className="hover:bg-[var(--pm-s2)]" onClick={() => { setDraft(menuO.l.key, null); setMenu(null); }}
              style={{ marginTop: 4, padding: "7px 8px", border: 0, borderTop: "1px solid var(--pm-b)", borderRadius: "0 0 8px 8px", background: "transparent", cursor: "pointer", textAlign: "left", fontSize: 12, color: "var(--pm-t2)" }}>Voltar ao preço atual</button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- prévia "de → para"
export type TomAviso = "r" | "am" | "at";
export interface ItemPrevia {
  key: string; nome: string; sku: string; foto?: string | null; op: string;
  de: number; para: number; mcDe: ContaMc | null; mcPara: ContaMc | null; semCusto?: boolean;
  avisos: Array<{ t: string; tom: TomAviso }>;
  res?: { tipo: "aplicado" | "recusado" | "pulado"; motivo: string };
}
const TOM: Record<TomAviso, [string, string]> = { r: ["var(--pm-rs)", "var(--pm-r)"], am: ["var(--pm-ams)", "var(--pm-am)"], at: ["var(--pm-as)", "var(--pm-at)"] };

export function PreviaAplicar({ fase, mktNa, promoNome, itens, botao, onAplicar, onFechar, descRevisar }: {
  fase: "revisar" | "aplicando" | "resultado"; mktNa: string; promoNome: string; itens: ItemPrevia[];
  botao?: string; onAplicar: () => void; onFechar: () => void;
  /** Texto do subtítulo na revisão (padrão: o preço público muda na hora). */
  descRevisar?: string;
}) {
  const n = itens.length;
  const nAv = itens.filter((x) => x.avisos.some((g) => g.tom !== "at")).length;
  const cnt = (t: string) => itens.filter((x) => x.res?.tipo === t).length;
  const titulo = fase === "resultado" ? `Resultado ${mktNa}` : fase === "aplicando" ? `Aplicando ${mktNa}…` : `Revisar antes de aplicar ${mktNa}`;
  const desc = fase === "resultado" ? `“${promoNome}”: o que o marketplace aceitou, recusou ou ficou de fora.` : `“${promoNome}”: ${descRevisar ?? "o preço público muda na hora. Nada foi enviado ainda."}`;
  const COLP = "minmax(220px,1.4fr) 150px 130px minmax(180px,1.2fr)";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "oklch(0.15 0.01 285 / 0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget && fase !== "aplicando") onFechar(); }}>
      <div style={{ width: "min(860px,100%)", maxHeight: "calc(100vh - 48px)", display: "flex", flexDirection: "column", background: "var(--pm-s)", color: "var(--pm-t)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-shl)" }}>
        <div style={{ padding: "16px 18px 12px", display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{titulo}</h3>
            <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>{desc}</span>
          </div>
          {fase !== "aplicando" && (
            <button type="button" onClick={onFechar} className="hover:bg-[var(--pm-s2)]"
              style={{ width: 30, height: 30, borderRadius: 8, border: 0, background: "transparent", cursor: "pointer", color: "var(--pm-t3)", display: "flex", alignItems: "center", justifyContent: "center" }}><X style={{ width: 16, height: 16 }} /></button>
          )}
        </div>
        {fase === "resultado" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "0 18px 12px" }}>
            <Chip bg="var(--pm-gs)" cor="var(--pm-g)" size={12}>{cnt("aplicado")} aplicados</Chip>
            <Chip bg="var(--pm-rs)" cor="var(--pm-r)" size={12}>{cnt("recusado")} recusados</Chip>
            <Chip bg="var(--pm-gr)" cor="var(--pm-t2)" size={12}>{cnt("pulado")} pulados</Chip>
          </div>
        )}
        <div style={{ overflow: "auto", borderTop: "1px solid var(--pm-b)", flex: 1, minHeight: 0 }}>
          <div style={{ minWidth: 720 }}>
            <div style={{ display: "grid", gridTemplateColumns: COLP, gap: 12, alignItems: "center", height: 32, padding: "0 18px", background: "var(--pm-s2)", fontSize: 11.5, fontWeight: 500, color: "var(--pm-t3)", position: "sticky", top: 0 }}>
              <div>Produto</div><div style={{ textAlign: "right" }}>Preço: de → para</div><div style={{ textAlign: "right" }}>MC: de → para</div><div>{fase === "resultado" ? "Resultado" : "Avisos"}</div>
            </div>
            {itens.map((it) => {
              const tags = fase === "resultado" && it.res
                ? [{ t: EST[it.res.tipo][0], bg: EST[it.res.tipo][1], cor: EST[it.res.tipo][2] }]
                : it.avisos.map((a) => ({ t: a.t, bg: TOM[a.tom][0], cor: TOM[a.tom][1] }));
              return (
                <div key={it.key} style={{ display: "grid", gridTemplateColumns: COLP, gap: 12, alignItems: "center", padding: "10px 18px", borderTop: "1px solid var(--pm-b)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <Foto url={it.foto} size={32} />
                    <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.nome}>{it.nome}</span>
                      <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)" }}>SKU {it.sku}</span>
                      <span style={{ fontSize: 11, color: "var(--pm-at)" }}>{it.op}</span>
                    </div>
                  </div>
                  <div className={MONO} style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--pm-t3)" }}>{BRL(it.de)}</span><span style={{ color: "var(--pm-t3)" }}>→</span><b style={{ fontWeight: 600 }}>{BRL(it.para)}</b>
                  </div>
                  <div className={MONO} style={{ display: "flex", alignItems: "baseline", justifyContent: "flex-end", gap: 6, fontSize: 12.5, whiteSpace: "nowrap" }}>
                    <span style={{ color: it.mcDe ? corMc(it.mcDe.pct) : "var(--pm-t3)" }}>{it.mcDe ? PCT(it.mcDe.pct) : "—"}</span>
                    <span style={{ color: "var(--pm-t3)" }}>→</span>
                    <b style={{ fontWeight: 600, color: it.mcPara ? corMc(it.mcPara.pct) : "var(--pm-am)" }}>{it.mcPara ? PCT(it.mcPara.pct) : it.semCusto ? "sem custo" : "—"}</b>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                    {tags.map((g) => <span key={g.t} style={{ fontSize: 11, fontWeight: 500, padding: "2px 7px", borderRadius: 6, background: g.bg, color: g.cor }}>{g.t}</span>)}
                    {fase === "resultado" && it.res && it.res.tipo !== "aplicado" && (
                      <span style={{ fontSize: 11.5, color: "var(--pm-t2)", flexBasis: "100%", textWrap: "pretty" }}>{it.res.motivo}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--pm-b)", flexWrap: "wrap" }}>
          <span style={{ flex: 1, fontSize: 12.5, color: "var(--pm-t2)", minWidth: 200 }}>
            {fase === "resultado" ? "Recusados e pulados continuam marcados na tabela para você ajustar." : `${n} ${n === 1 ? "produto" : "produtos"} · ${nAv ? `${nAv} com aviso` : "sem avisos"}`}
          </span>
          {fase === "revisar" && (
            <>
              <button type="button" onClick={onFechar} style={{ height: 32, padding: "0 12px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5 }}>Cancelar</button>
              <button type="button" onClick={onAplicar} style={{ height: 32, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>{botao ?? `Aplicar ${mktNa} (${n})`}</button>
            </>
          )}
          {fase === "aplicando" && (
            <button type="button" disabled style={{ height: 32, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", fontSize: 12.5, fontWeight: 600, opacity: 0.6, display: "flex", alignItems: "center", gap: 6 }}>
              <RefreshCw className="animate-spin" style={{ width: 14, height: 14 }} />Aplicando…
            </button>
          )}
          {fase === "resultado" && (
            <button type="button" onClick={onFechar} style={{ height: 32, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Fechar</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- estados de tela
export function ErroLeitura({ mktDe, msg, onTentar }: { mktDe: string; msg: string; onTentar: () => void }) {
  return (
    <div className="pm-card" style={{ padding: 28, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: "var(--pm-rs)", color: "var(--pm-r)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
      </div>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Não foi possível ler as promoções {mktDe}</h3>
      <p style={{ margin: 0, color: "var(--pm-t2)", fontSize: 13, maxWidth: "60ch", textWrap: "pretty" }}>O marketplace respondeu “{msg}”. Nenhum preço foi alterado. Os contadores e a lista voltam quando a leitura funcionar.</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={onTentar} style={{ height: 32, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>Tentar de novo</button>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Se continuar, a API pode estar fora do ar.</span>
      </div>
    </div>
  );
}

/** Botão primário/secundário do cabeçalho do detalhe. */
export function Btn({ children, onClick, primario, disabled, title }: { children: ReactNode; onClick?: () => void; primario?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={primario ? undefined : "hover:bg-[var(--pm-s2)]"}
      style={primario
        ? { height: 32, padding: "0 14px", borderRadius: 8, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: disabled ? "default" : "pointer", fontSize: 12.5, fontWeight: 600, opacity: disabled ? 0.45 : 1, display: "flex", alignItems: "center", gap: 6 }
        : { display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: disabled ? "default" : "pointer", fontSize: 12.5, fontWeight: 500, color: "var(--pm-t)", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}
