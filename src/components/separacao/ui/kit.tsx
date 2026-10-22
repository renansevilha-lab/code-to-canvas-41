import { type CSSProperties, type ReactNode, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { int } from "@/components/dashboard/formato";

// ============================================================================
// Separação › peças do design novo (Claude Design "Separação", 22/out/2026).
// Só apresentação: quem imprime, aplica TAG e embala continua sendo a
// FilaPriorizada (separacao.tsx). Cores = tokens --pm-* (.pm-ui em styles.css).
// ============================================================================

export const MONO: CSSProperties = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

export const ENVIOS_SEP: Record<string, { nome: string; curto: string; cor: string; prio: string }> = {
  ER: { nome: "Entrega Rápida · ER", curto: "ER", cor: "var(--pm-er)", prio: "prioridade 1 · coleta no mesmo dia" },
  SPX: { nome: "Shopee Xpress · SPX", curto: "SPX", cor: "var(--pm-spx)", prio: "prioridade 2" },
  ML: { nome: "Mercado Livre · ML", curto: "ML", cor: "var(--pm-ml)", prio: "prioridade 3 · Flex, agência e coleta" },
  TIKTOK: { nome: "TikTok", curto: "TikTok", cor: "var(--pm-tt)", prio: "prioridade 4 · etiqueta pelo TikTok" },
};
export const envioSep = (t: string | null) =>
  ENVIOS_SEP[t ?? ""] ?? { nome: t ?? "Sem envio", curto: t ?? "—", cor: "var(--pm-t3)", prio: "" };

export type Tom = "r" | "a" | "g" | "n";
export const COR_TOM: Record<Tom, string> = { r: "var(--pm-r)", a: "var(--pm-am)", g: "var(--pm-g)", n: "var(--pm-t2)" };
const FUNDO_TOM: Record<Tom, string> = { r: "var(--pm-rs)", a: "var(--pm-ams)", g: "var(--pm-gs)", n: "var(--pm-s2)" };

const Svg = ({ d, size = 14, sw = 1.75, style }: { d: ReactNode; size?: number; sw?: number; style?: CSSProperties }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", ...style }}>{d}</svg>
);
export const IcImpressora = ({ size = 16 }: { size?: number }) => (
  <Svg size={size} d={<><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></>} />
);
const IcSeta = ({ rot = 0 }: { rot?: number }) => <Svg size={13} sw={2} d={<path d="m6 9 6 6 6-6" />} style={{ transform: `rotate(${rot}deg)` }} />;
const IcCheck = ({ size = 12 }: { size?: number }) => <Svg size={size} sw={3} d={<path d="M20 6 9 17l-5-5" />} />;
const IcX = () => <Svg size={12} sw={2.5} d={<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>} />;
const IcGira = ({ girando }: { girando?: boolean }) => (
  <Svg size={14} d={<><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>} style={{ animation: girando ? "spin 1s linear infinite" : undefined }} />
);
export const Spinner = ({ size = 15 }: { size?: number }) => (
  <Svg size={size} sw={2.25} d={<path d="M21 12a9 9 0 1 1-6.22-8.56" />} style={{ animation: "spin 1s linear infinite" }} />
);

// ---------------------------------------------------------------------------
// Topo: impressora + atualizar
// ---------------------------------------------------------------------------

export interface ImpressoraOpcao { id: number; nome: string; online: boolean }

export function EscolhaImpressora({
  opcoes, selecionada, onEscolher, carregando,
}: { opcoes: ImpressoraOpcao[]; selecionada: ImpressoraOpcao | undefined; onEscolher: (id: number) => void; carregando: boolean }) {
  const [aberto, setAberto] = useState(false);
  const off = selecionada && !selecionada.online;
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button
          type="button"
          style={{ display: "flex", alignItems: "center", gap: 8, height: 38, padding: "0 12px", borderRadius: 10, border: `1.5px solid ${off ? "var(--pm-r)" : "var(--pm-b)"}`, background: off ? "var(--pm-rs)" : "var(--pm-s)", cursor: "pointer", fontSize: 12.5, maxWidth: "100%", color: "var(--pm-t)" }}
        >
          <IcImpressora />
          <span style={{ color: "var(--pm-t3)" }}>Imprimindo em:</span>
          <b style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
            {selecionada?.nome ?? (carregando ? "carregando…" : "escolha a impressora")}
          </b>
          {selecionada && (
            <span style={{ display: "flex", alignItems: "center", gap: 4, fontWeight: 600, color: off ? "var(--pm-r)" : "var(--pm-g)" }}>
              <i style={{ width: 7, height: 7, borderRadius: "50%", background: off ? "var(--pm-r)" : "var(--pm-g)" }} />
              {off ? "offline" : "online"}
            </span>
          )}
          <span style={{ color: "var(--pm-t3)" }}><IcSeta /></span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="pm-ui" style={{ width: 320, padding: 6, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", boxShadow: "var(--pm-shl)" }}>
        <div style={{ fontSize: 11, color: "var(--pm-t3)", padding: "6px 8px 4px" }}>Vale para a Fila e os Lotes do dia</div>
        {opcoes.length === 0 && <div style={{ padding: 10, fontSize: 12, color: "var(--pm-t3)" }}>{carregando ? "Lendo as impressoras…" : "Nenhuma Zebra encontrada."}</div>}
        {opcoes.map((p) => {
          const on = p.id === selecionada?.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => { onEscolher(p.id); setAberto(false); }}
              className="hover:bg-[var(--pm-s2)]"
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 10px", borderRadius: 8, border: 0, background: on ? "var(--pm-as)" : "transparent", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}
            >
              <span style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${on ? "var(--pm-a)" : "var(--pm-bs)"}`, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                <i style={{ width: 7, height: 7, borderRadius: "50%", background: on ? "var(--pm-a)" : "transparent" }} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: 12.5, fontWeight: 600 }}>{p.nome}</b>
                <span style={{ fontSize: 11, color: p.online ? "var(--pm-g)" : "var(--pm-r)" }}>{p.online ? "online" : "offline"}</span>
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export interface ItemMenu { t: string; sub?: string; onClick: () => void; perigo?: boolean; disabled?: boolean }

export function BotaoAtualizar({ onAtualizar, girando, itens }: { onAtualizar: () => void; girando: boolean; itens: ItemMenu[] }) {
  return (
    <div style={{ display: "flex" }}>
      <button
        type="button"
        onClick={onAtualizar}
        disabled={girando}
        className="hover:bg-[var(--pm-s2)]"
        style={{ display: "flex", alignItems: "center", gap: 6, height: 38, padding: "0 12px", borderRadius: "10px 0 0 10px", border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t)" }}
      >
        <IcGira girando={girando} />Atualizar
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" title="Mais opções" style={{ width: 32, height: 38, borderRadius: "0 10px 10px 0", border: "1px solid var(--pm-b)", borderLeft: 0, background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t)" }}>
            <IcSeta />
          </button>
        </DropdownMenuTrigger>
        <MenuItens itens={itens} largura={260} />
      </DropdownMenu>
    </div>
  );
}

/** Conteúdo de menu no estilo do design (título + linha de apoio). */
export function MenuItens({ itens, largura = 270 }: { itens: ItemMenu[]; largura?: number }) {
  return (
    <DropdownMenuContent align="end" className="pm-ui" style={{ width: largura, padding: 6, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", boxShadow: "var(--pm-shl)" }}>
      {itens.map((m, i) => (
        <DropdownMenuItem
          key={i}
          disabled={m.disabled}
          onSelect={() => m.onClick()}
          style={{ minHeight: 40, padding: "6px 10px", borderRadius: 8, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0, borderTop: m.perigo && i > 0 && !itens[i - 1].perigo ? "1px solid var(--pm-b)" : undefined, color: m.perigo ? "var(--pm-r)" : "var(--pm-t)", cursor: "pointer" }}
        >
          <b style={{ fontSize: 12.5, fontWeight: 600 }}>{m.t}</b>
          {m.sub && <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>{m.sub}</span>}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );
}

// ---------------------------------------------------------------------------
// Faixa "Pede ação"
// ---------------------------------------------------------------------------

export interface CartaoAcao { chave: string; tom: Tom; label: string; n: string; ctx: string; onClick?: () => void }

export function FaixaPedeAcao({ cartoes, emDia, carregando }: { cartoes: CartaoAcao[]; emDia: string[]; carregando: boolean }) {
  const grade: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,180px),1fr))", gap: 8 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Pede ação</span>
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>clique para filtrar a fila · vermelho perde dinheiro agora</span>
      </div>
      {carregando ? (
        <div style={grade}>
          {[1, 2, 3, 4].map((k) => (
            <div key={k} style={{ height: 74, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ width: "40%", height: 14, borderRadius: 5, background: "var(--pm-sk)" }} />
              <div style={{ width: "80%", height: 9, borderRadius: 5, background: "var(--pm-sk)" }} />
            </div>
          ))}
        </div>
      ) : cartoes.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", fontSize: 12.5 }}>
          <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--pm-gs)", color: "var(--pm-g)", display: "flex", alignItems: "center", justifyContent: "center" }}><IcCheck /></span>
          <b style={{ fontWeight: 600 }}>Tudo em dia ✓</b>
          <span style={{ color: "var(--pm-t3)" }}>Nada cancela hoje nem amanhã, nenhum prazo vencido, impressora confirmando tudo.</span>
        </div>
      ) : (
        <>
          <div style={grade}>
            {cartoes.map((c) => (
              <button
                key={c.chave}
                type="button"
                onClick={c.onClick}
                className={c.onClick ? "hover:border-[var(--pm-a)]" : undefined}
                style={{ textAlign: "left", cursor: c.onClick ? "pointer" : "default", display: "flex", flexDirection: "column", gap: 2, padding: "9px 11px", borderRadius: 12, border: "1.5px solid var(--pm-b)", background: "var(--pm-s)", boxShadow: "var(--pm-sh)", minHeight: 74, color: "var(--pm-t)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <i style={{ width: 7, height: 7, borderRadius: "50%", background: COR_TOM[c.tom], flex: "none" }} />
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{c.label}</span>
                </div>
                <span style={{ ...MONO, fontSize: 16, fontWeight: 600, color: COR_TOM[c.tom], whiteSpace: "nowrap" }}>{c.n}</span>
                <span style={{ fontSize: 11, color: "var(--pm-t2)", textWrap: "pretty" as CSSProperties["textWrap"] }}>{c.ctx}</span>
              </button>
            ))}
          </div>
          {emDia.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 11.5, color: "var(--pm-t3)" }}>
              <span>Em dia:</span>
              {emDia.map((x) => (
                <span key={x} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ color: "var(--pm-g)" }}><IcCheck size={11} /></span>{x}</span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Abas + turno
// ---------------------------------------------------------------------------

export interface AbaSep { id: string; nome: string; n?: number | null; onClick: () => void }

export function Segmento<T extends string>({ ops, valor, onValor, altura = 30 }: {
  ops: Array<{ id: T; nome: ReactNode; sub?: string }>; valor: T; onValor: (v: T) => void; altura?: number;
}) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 9 }}>
      {ops.map((o) => {
        const on = o.id === valor;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onValor(o.id)}
            style={{ border: 0, cursor: "pointer", height: altura, padding: "0 10px", borderRadius: 7, fontSize: 12.5, fontWeight: on ? 600 : 500, background: on ? "var(--pm-s)" : "transparent", color: on ? "var(--pm-t)" : "var(--pm-t2)", boxShadow: on ? "var(--pm-sh)" : "none", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" }}
          >
            {o.nome}
            {o.sub && <span style={{ fontSize: 11, color: "var(--pm-t3)", fontWeight: 500 }}>{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function BarraAbas({ abas, ativa, direita }: { abas: AbaSep[]; ativa: string; direita?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "6px 14px", borderBottom: "1px solid var(--pm-b)" }}>
      <nav style={{ display: "flex", gap: 2, overflowX: "auto", maxWidth: "100%" }}>
        {abas.map((t) => {
          const on = t.id === ativa;
          return (
            <button
              key={t.id}
              type="button"
              onClick={t.onClick}
              style={{ border: 0, background: "transparent", cursor: "pointer", padding: "9px 11px 8px", marginBottom: -1, borderBottom: `2px solid ${on ? "var(--pm-a)" : "transparent"}`, display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: on ? 600 : 500, color: on ? "var(--pm-t)" : "var(--pm-t2)", whiteSpace: "nowrap" }}
            >
              {t.nome}
              {t.n != null && t.n > 0 && (
                <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 10, background: on ? "var(--pm-as)" : "var(--pm-s2)", color: on ? "var(--pm-at)" : "var(--pm-t2)" }}>{int(t.n)}</span>
              )}
            </button>
          );
        })}
      </nav>
      <div style={{ flex: 1 }} />
      {direita && <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 6, flexWrap: "wrap" }}>{direita}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filtros da fila
// ---------------------------------------------------------------------------

export function ChipEnvioSep({ nome, n, cor, on, onClick }: { nome: string; n: number; cor?: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 11px", borderRadius: 17, border: `1.5px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? "var(--pm-at)" : "var(--pm-t)" }}
    >
      {cor && <i style={{ width: 8, height: 8, borderRadius: 2, background: cor }} />}
      {nome}
      <span style={{ ...MONO, fontSize: 11.5, color: "var(--pm-t3)" }}>{int(n)}</span>
    </button>
  );
}

export interface GrupoFiltro { nome: string; ops: Array<{ id: string; nome: string; on: boolean; onClick: () => void }> }

export function BotaoFiltros({ grupos, nAtivos, nVis, onLimpar }: { grupos: GrupoFiltro[]; nAtivos: number; nVis: number; onLimpar: () => void }) {
  const [aberto, setAberto] = useState(false);
  const on = nAtivos > 0;
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", borderRadius: 9, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: 500, color: on ? "var(--pm-at)" : "var(--pm-t)" }}>
          <Svg d={<><path d="M3 6h18" /><path d="M7 12h10" /><path d="M10 18h4" /></>} />
          {on ? `Filtros (${nAtivos})` : "Filtros"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="pm-ui" style={{ width: "min(460px, calc(100vw - 32px))", padding: 12, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", boxShadow: "var(--pm-shl)", display: "flex", flexDirection: "column", gap: 10 }}>
        {grupos.map((g) => (
          <div key={g.nome} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600 }}>{g.nome}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {g.ops.map((o) => (
                <button key={o.id} type="button" onClick={o.onClick} style={{ height: 36, padding: "0 12px", borderRadius: 18, border: `1.5px solid ${o.on ? "var(--pm-a)" : "var(--pm-b)"}`, background: o.on ? "var(--pm-as)" : "var(--pm-s)", color: o.on ? "var(--pm-at)" : "var(--pm-t)", cursor: "pointer", fontSize: 12.5, fontWeight: 500 }}>
                  {o.nome}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button type="button" onClick={onLimpar} style={{ height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t)" }}>Limpar</button>
          <button type="button" onClick={() => setAberto(false)} style={{ height: 36, padding: "0 14px", borderRadius: 9, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Ver {int(nVis)} linhas</button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FiltrosAtivos({ itens }: { itens: Array<{ nome: string; onClick: () => void }> }) {
  if (itens.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Filtrando:</span>
      {itens.map((a) => (
        <button key={a.nome} type="button" onClick={a.onClick} style={{ display: "flex", alignItems: "center", gap: 5, height: 28, padding: "0 6px 0 10px", borderRadius: 14, border: "1px solid var(--pm-a)", background: "var(--pm-as)", color: "var(--pm-at)", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
          {a.nome}<IcX />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grupo de envio e linha da fila
// ---------------------------------------------------------------------------

export function CabecalhoGrupo({ cor, nome, prio, tot, vis, acao }: { cor: string; nome: string; prio: string; tot: string; vis: string; acao?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", padding: "6px 2px 0" }}>
      <i style={{ width: 10, height: 10, borderRadius: 3, background: cor, flex: "none" }} />
      <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.01em" }}>{nome}</span>
      {prio && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{prio}</span>}
      <span style={{ ...MONO, fontSize: 12, color: "var(--pm-t2)" }}>{tot}</span>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{vis}</span>
      {acao}
    </div>
  );
}

export interface Alerta { t: ReactNode; tom: Tom | "contorno"; chave: string }

export type AcaoLinha =
  | { tipo: "imprimir"; rotulo: string; onClick: () => void; disabled?: boolean; ocupado?: boolean }
  | { tipo: "embalar"; rotulo: string; onClick: () => void; disabled?: boolean; ocupado?: boolean }
  | { tipo: "progresso"; texto: string; pct: number };

export interface LinhaFilaProps {
  n: number;
  cor: string;
  foto: string | null;
  nome: string;
  sku: string;
  logo: string | null;
  lojaTxt: string;
  obs?: ReactNode;
  unPorPedido: number;
  pedidos: number;
  unidades: number;
  prazo: { t: string; tom: Tom };
  alertas: Alerta[];
  tag: { texto: string; embalada: boolean; onCopiar: () => void } | null;
  tagNota?: ReactNode;
  passos: [string, string, string];
  acao: AcaoLinha;
  nota?: ReactNode;
  sel: boolean;
  selDisabled: boolean;
  onSel: () => void;
  menu: ItemMenu[];
  menuOcupado?: boolean;
  aberto: boolean;
  onExpandir: () => void;
  mobile: boolean;
  children?: ReactNode;
}

function Foto({ src, alt }: { src: string | null; alt: string }) {
  const [erro, setErro] = useState(false);
  const caixa: CSSProperties = { width: 52, height: 52, flex: "none", borderRadius: 10, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" };
  if (!src || erro) {
    const ab = alt.replace(/[^A-Za-zÀ-ú ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return <span style={{ ...caixa, fontSize: 12, fontWeight: 600, color: "var(--pm-t3)" }}>{ab || "—"}</span>;
  }
  return <span style={{ ...caixa, background: "#fff" }}><img src={src} alt={alt} loading="lazy" onError={() => setErro(true)} style={{ width: "100%", height: "100%", objectFit: "contain" }} /></span>;
}

export function LinhaFila(p: LinhaFilaProps) {
  const cols = p.mobile
    ? "minmax(0,1fr) 44px 30px"
    : "26px 34px minmax(0,1.5fr) minmax(0,1.1fr) 96px minmax(150px,196px) 44px 30px";
  const col = (desk: string, mob: string) => (p.mobile ? mob : desk);
  return (
    <div style={{ background: "var(--pm-s)", border: `1px solid ${p.aberto ? "var(--pm-a)" : "var(--pm-b)"}`, borderLeft: `4px solid ${p.cor}`, borderRadius: 12, boxShadow: "var(--pm-sh)" }}>
      <div style={{ display: "grid", gridTemplateColumns: cols, gridAutoFlow: "dense", gap: p.mobile ? "10px 8px" : 10, alignItems: "center", padding: p.mobile ? 10 : "8px 10px 8px 12px" }}>
        {!p.mobile && (
          <>
            <button type="button" onClick={p.onSel} disabled={p.selDisabled} aria-label="Selecionar" style={{ width: 24, height: 24, borderRadius: 6, border: `1.5px solid ${p.sel ? "var(--pm-a)" : "var(--pm-bs)"}`, background: p.sel ? "var(--pm-a)" : "var(--pm-s)", cursor: p.selDisabled ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-oa)", padding: 0, opacity: p.selDisabled ? 0.35 : 1 }}>
              {p.sel && <IcCheck size={14} />}
            </button>
            <span style={{ ...MONO, fontSize: 13, fontWeight: 600, color: "var(--pm-t3)" }}>#{p.n}</span>
          </>
        )}
        {/* produto */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, gridColumn: col("auto", "1 / -1") }}>
          <Foto src={p.foto} alt={p.nome} />
          <div style={{ width: 58, height: 52, flex: "none", borderRadius: 10, border: `1.5px solid ${p.unPorPedido >= 3 ? "var(--pm-t)" : "var(--pm-bs)"}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
            <b style={{ ...MONO, fontSize: 24, fontWeight: 700 }}>{p.unPorPedido}</b>
            <span style={{ fontSize: 10, color: "var(--pm-t2)", marginTop: 3 }}>un/pedido</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span title={p.nome} style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{p.nome}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--pm-t3)", flexWrap: "wrap" }}>
              <span style={MONO}>SKU {p.sku}</span>
              <span>·</span>
              {p.logo && <span style={{ display: "inline-block", width: 13, height: 13, borderRadius: 3, background: `#fff url(${p.logo}) center/contain no-repeat`, flex: "none" }} />}
              <span>{p.lojaTxt}</span>
            </span>
            {p.obs}
          </div>
        </div>
        {/* pedidos, prazo, alertas */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, gridColumn: col("auto", "1 / -1") }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}><span style={MONO}>{int(p.pedidos)}</span> pedidos · <span style={MONO}>{int(p.unidades)}</span> un</span>
            <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 8px", borderRadius: 6, background: FUNDO_TOM[p.prazo.tom], color: p.prazo.tom === "n" ? "var(--pm-t2)" : COR_TOM[p.prazo.tom], whiteSpace: "nowrap" }}>{p.prazo.t}</span>
          </div>
          {p.alertas.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {p.alertas.map((a) => {
                const contorno = a.tom === "contorno";
                return (
                  <span key={a.chave} style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 5, border: `1px solid ${contorno ? "var(--pm-bs)" : "transparent"}`, background: contorno ? "transparent" : FUNDO_TOM[a.tom as Tom], color: contorno ? "var(--pm-t2)" : COR_TOM[a.tom as Tom], whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {a.t}
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {/* TAG */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start", gridColumn: col("auto", "1 / 2") }}>
          {p.tag ? (
            <button type="button" onClick={p.tag.onCopiar} title="Copiar TAG" style={{ display: "flex", alignItems: "center", gap: 5, height: 28, padding: "0 8px", borderRadius: 7, border: `1px solid ${p.tag.embalada ? "var(--pm-g)" : "var(--pm-b)"}`, background: p.tag.embalada ? "var(--pm-gs)" : "var(--pm-s2)", color: p.tag.embalada ? "var(--pm-g)" : "var(--pm-t)", cursor: "pointer", ...MONO, fontSize: 13, fontWeight: 700 }}>
              {p.tag.texto}
              <Svg size={12} sw={2} d={<><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>} />
            </button>
          ) : (
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>TAG ao imprimir</span>
          )}
          {p.tagNota}
          <div style={{ display: "flex", gap: 3 }} title="etiqueta · impressora · embalado">
            {p.passos.map((c, i) => <i key={i} style={{ width: 18, height: 4, borderRadius: 2, background: c }} />)}
          </div>
        </div>
        {/* ação principal */}
        <div style={{ gridColumn: col("auto", "1 / -1"), minWidth: 0 }}>
          {p.acao.tipo === "imprimir" && (
            <button type="button" onClick={p.acao.onClick} disabled={p.acao.disabled || p.acao.ocupado} className="hover:brightness-110" style={{ width: "100%", height: 46, borderRadius: 11, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: p.acao.disabled ? "default" : "pointer", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: p.acao.disabled && !p.acao.ocupado ? 0.55 : 1 }}>
              {p.acao.ocupado ? <Spinner size={17} /> : <IcImpressora size={17} />}{p.acao.rotulo}
            </button>
          )}
          {p.acao.tipo === "embalar" && (
            <button type="button" onClick={p.acao.onClick} disabled={p.acao.disabled || p.acao.ocupado} className="hover:bg-[var(--pm-as)]" style={{ width: "100%", height: 46, borderRadius: 11, border: "2px solid var(--pm-a)", background: "var(--pm-s)", color: "var(--pm-at)", cursor: p.acao.disabled ? "default" : "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, opacity: p.acao.disabled && !p.acao.ocupado ? 0.55 : 1 }}>
              {p.acao.ocupado ? <Spinner size={17} /> : <Svg size={17} sw={2} d={<><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" /><path d="M12 22V12" /><path d="m3.3 7 8.7 5 8.7-5" /></>} />}
              {p.acao.rotulo}
            </button>
          )}
          {p.acao.tipo === "progresso" && (
            <div style={{ position: "relative", width: "100%", height: 46, borderRadius: 11, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13.5, fontWeight: 600, color: "var(--pm-t2)" }}>
              <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(0, Math.min(100, p.acao.pct))}%`, background: "var(--pm-as)" }} />
              <span style={{ position: "relative", display: "flex", alignItems: "center", gap: 8 }}><Spinner />{p.acao.texto}</span>
            </div>
          )}
          {p.nota && <span style={{ display: "block", fontSize: 10.5, color: "var(--pm-t3)", textAlign: "center", marginTop: 2 }}>{p.nota}</span>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" title="Mais ações" className="hover:bg-[var(--pm-s2)]" style={{ width: 44, height: 44, borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t2)", gridColumn: col("auto", "2 / 3") }}>
              {p.menuOcupado ? <Spinner size={16} /> : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>
              )}
            </button>
          </DropdownMenuTrigger>
          <MenuItens itens={p.menu} />
        </DropdownMenu>
        <button type="button" onClick={p.onExpandir} title={p.aberto ? "Recolher" : "Ver pedidos"} className="hover:bg-[var(--pm-s2)]" style={{ width: 30, height: 44, borderRadius: 8, border: 0, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t3)", gridColumn: col("auto", "3 / 4") }}>
          <Svg size={16} sw={2} d={<path d="m6 9 6 6 6-6" />} style={{ transform: p.aberto ? "rotate(180deg)" : "none" }} />
        </button>
      </div>
      {p.aberto && <div style={{ borderTop: "1px solid var(--pm-b)", padding: 8 }}>{p.children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Painel de impressão (canto) e barra de seleção
// ---------------------------------------------------------------------------

export interface PainelImpressaoProps {
  titulo: string;
  sub: string;
  status: string;
  statusTom: Tom | "t";
  prog: string;
  pct: number;
  barTom: Tom | "a";
  texto: ReactNode;
  botoes: Array<{ t: string; onClick: () => void; perigo?: boolean; primario?: boolean }>;
  mobile: boolean;
}

export function PainelImpressao(p: PainelImpressaoProps) {
  const corStatus = p.statusTom === "t" ? "var(--pm-t)" : COR_TOM[p.statusTom];
  const corBarra = p.barTom === "a" ? "var(--pm-a)" : COR_TOM[p.barTom];
  return (
    <aside className="pm-ui" style={{ position: "fixed", right: p.mobile ? 0 : 20, bottom: p.mobile ? 0 : 20, left: p.mobile ? 0 : undefined, zIndex: 40, width: p.mobile ? "100%" : 380, background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: p.mobile ? "16px 16px 0 0" : 16, boxShadow: "var(--pm-shl)", display: "flex", flexDirection: "column", color: "var(--pm-t)" }}>
      <div style={{ display: "flex", flexDirection: "column", padding: "12px 14px", borderBottom: "1px solid var(--pm-b)" }}>
        <b style={{ fontSize: 14, fontWeight: 600 }}>{p.titulo}</b>
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sub}</span>
      </div>
      <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: corStatus }}>{p.status}</span>
          <div style={{ flex: 1 }} />
          <span style={{ ...MONO, fontSize: 12, color: "var(--pm-t2)" }}>{p.prog}</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: "var(--pm-sk)", overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${Math.max(0, Math.min(100, p.pct))}%`, background: corBarra, transition: "width .4s" }} />
        </div>
        <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{p.texto}</span>
      </div>
      {p.botoes.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--pm-b)" }}>
          {p.botoes.map((b) => (
            <button key={b.t} type="button" onClick={b.onClick} style={{ flex: 1, height: 44, borderRadius: 10, border: b.primario ? 0 : `1px solid ${b.perigo ? "var(--pm-r)" : "var(--pm-b)"}`, background: b.primario ? "var(--pm-a)" : "var(--pm-s)", color: b.primario ? "var(--pm-oa)" : b.perigo ? "var(--pm-r)" : "var(--pm-t)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
              {b.t}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

export function BarraSelecao({ linhas, pedidos, botoes, onLimpar }: {
  linhas: number; pedidos: number; onLimpar: () => void;
  botoes: Array<{ t: string; onClick: () => void; tipo: "primario" | "contorno" | "perigo"; disabled?: boolean }>;
}) {
  return (
    <div style={{ position: "sticky", bottom: 12, zIndex: 15, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "10px 12px 10px 16px", borderRadius: 14, background: "var(--pm-t)", color: "var(--pm-s)", boxShadow: "var(--pm-shl)" }}>
      <span style={{ fontSize: 13 }}><b style={{ ...MONO, fontWeight: 600 }}>{int(linhas)}</b> linhas · <b style={{ ...MONO, fontWeight: 600 }}>{int(pedidos)}</b> pedidos</span>
      <div style={{ flex: 1 }} />
      <button type="button" onClick={onLimpar} style={{ height: 40, padding: "0 12px", borderRadius: 9, border: "1px solid oklch(1 0 0 / 0.25)", background: "transparent", color: "var(--pm-s)", cursor: "pointer", fontSize: 12.5 }}>Limpar</button>
      {botoes.map((b) => (
        <button
          key={b.t}
          type="button"
          onClick={b.onClick}
          disabled={b.disabled}
          style={{
            height: 44, padding: "0 14px", borderRadius: 10, cursor: b.disabled ? "default" : "pointer", fontSize: 13, fontWeight: 600, opacity: b.disabled ? 0.5 : 1,
            border: b.tipo === "primario" ? 0 : `1px solid ${b.tipo === "perigo" ? "var(--pm-r)" : "oklch(1 0 0 / 0.35)"}`,
            background: b.tipo === "primario" ? "var(--pm-a)" : "transparent",
            color: b.tipo === "primario" ? "var(--pm-oa)" : b.tipo === "perigo" ? "var(--pm-r)" : "var(--pm-s)",
          }}
        >
          {b.t}
        </button>
      ))}
    </div>
  );
}
