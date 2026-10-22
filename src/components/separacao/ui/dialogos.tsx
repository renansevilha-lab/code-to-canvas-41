import { createContext, type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Separação › confirmações no padrão do design (Claude Design "Separação",
// 22/out/2026). As funções da fila pedem confirmação por confirmarSep() /
// pedirTextoSep(): com o visual novo na tela (HostDialogosSep montado) abre o
// diálogo desenhado; no visual antigo cai no window.confirm/prompt de sempre.
// ============================================================================

/** true quando a Separação está no visual novo (o SeparacaoPage provê). */
export const VisualNovoSep = createContext(false);

export function DialogoPm({ aberto, onFechar, perigo, kicker, titulo, children, rodape, largura = 540 }: {
  aberto: boolean; onFechar: () => void; perigo?: boolean; kicker: string; titulo: ReactNode;
  children?: ReactNode; rodape: ReactNode; largura?: number;
}) {
  useEffect(() => {
    if (!aberto) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onFechar(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [aberto, onFechar]);
  if (!aberto || typeof document === "undefined") return null;
  return createPortal(
    <div className="pm-ui" onClick={onFechar} style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--pm-ov)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: largura, maxHeight: "calc(100vh - 24px)", background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderTop: `4px solid ${perigo ? "var(--pm-r)" : "var(--pm-a)"}`, borderRadius: 16, boxShadow: "var(--pm-shl)", display: "flex", flexDirection: "column", color: "var(--pm-t)", fontSize: 13 }}
      >
        <div style={{ padding: "14px 18px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: perigo ? "var(--pm-r)" : "var(--pm-t3)", letterSpacing: "0.02em", textTransform: "uppercase" }}>{kicker}</span>
          <b style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em" }}>{titulo}</b>
        </div>
        <div style={{ padding: "6px 18px 12px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto", minHeight: 0 }}>{children}</div>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--pm-b)" }}>{rodape}</div>
      </div>
    </div>,
    document.body,
  );
}

export function BotaoPm({ tipo = "contorno", children, onClick, disabled, style }: {
  tipo?: "primario" | "perigo" | "contorno" | "perigo-contorno"; children: ReactNode; onClick?: () => void; disabled?: boolean; style?: CSSProperties;
}) {
  const base: CSSProperties = { height: 44, padding: "0 16px", borderRadius: 10, cursor: disabled ? "default" : "pointer", fontSize: 13, fontWeight: 600, opacity: disabled ? 0.55 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 };
  const t: Record<string, CSSProperties> = {
    primario: { border: 0, background: "var(--pm-a)", color: "var(--pm-oa)" },
    perigo: { border: 0, background: "var(--pm-r)", color: "var(--pm-or)" },
    contorno: { border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t)", fontWeight: 500 },
    "perigo-contorno": { border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)" },
  };
  return <button type="button" onClick={onClick} disabled={disabled} style={{ ...base, ...t[tipo], ...style }}>{children}</button>;
}

export function CaixaPm({ tom = "n", children }: { tom?: "n" | "r" | "a"; children: ReactNode }) {
  const bg = tom === "r" ? "var(--pm-rs)" : tom === "a" ? "var(--pm-ams)" : "var(--pm-s2)";
  const cor = tom === "r" ? "var(--pm-r)" : tom === "a" ? "var(--pm-am)" : "var(--pm-t)";
  return <div style={{ padding: "10px 12px", borderRadius: 10, background: bg, color: cor, fontSize: 13.5 }}>{children}</div>;
}

export function MarcaPm({ marcado, onClick, children, perigo }: { marcado: boolean; onClick: () => void; children: ReactNode; perigo?: boolean }) {
  const cor = marcado ? (perigo ? "var(--pm-r)" : "var(--pm-a)") : "var(--pm-bs)";
  return (
    <button type="button" onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${cor}`, background: "var(--pm-s)", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}>
      <span style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${cor}`, background: marcado ? cor : "var(--pm-s)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-oa)", flex: "none" }}>
        {marcado && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
      </span>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{children}</span>
    </button>
  );
}

export function OpcaoPm({ marcada, onClick, t, sub, subCor }: { marcada: boolean; onClick: () => void; t: ReactNode; sub?: ReactNode; subCor?: string }) {
  return (
    <button type="button" onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "6px 12px", borderRadius: 10, border: `1.5px solid ${marcada ? "var(--pm-a)" : "var(--pm-b)"}`, background: marcada ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", textAlign: "left", color: "var(--pm-t)", width: "100%" }}>
      <span style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${marcada ? "var(--pm-a)" : "var(--pm-b)"}`, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        <i style={{ width: 7, height: 7, borderRadius: "50%", background: marcada ? "var(--pm-a)" : "transparent" }} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{t}</span>
        {sub && <span style={{ fontSize: 11.5, color: subCor ?? "var(--pm-t3)" }}>{sub}</span>}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// confirmarSep / pedirTextoSep
// ---------------------------------------------------------------------------

export interface OptsConfirmar {
  kicker: string;
  titulo: string;
  resumo?: string;
  linhas?: string[];
  aviso?: string;
  perigo?: boolean;
  okTxt: string;
  /** caixa que precisa ser marcada antes do OK (ações perigosas) */
  check?: string;
}
export interface OptsTexto { kicker: string; titulo: string; atual?: string; placeholder?: string; ajuda?: string; okTxt?: string }

type Pedido =
  | { tipo: "confirmar"; opts: OptsConfirmar; resolve: (v: boolean) => void }
  | { tipo: "texto"; opts: OptsTexto; resolve: (v: string | null) => void };

let host: ((p: Pedido) => void) | null = null;

const textoPlano = (o: OptsConfirmar) =>
  [o.perigo ? `ATENÇÃO — ${o.titulo}` : o.titulo, o.resumo, ...(o.linhas ?? []), o.aviso].filter(Boolean).join("\n\n");

export function confirmarSep(opts: OptsConfirmar): Promise<boolean> {
  if (!host) return Promise.resolve(window.confirm(textoPlano(opts)));
  const h = host;
  return new Promise((resolve) => h({ tipo: "confirmar", opts, resolve }));
}

/** Texto livre (observação). null = cancelou; "" = apagar. */
export function pedirTextoSep(opts: OptsTexto): Promise<string | null> {
  if (!host) return Promise.resolve(window.prompt(`${opts.titulo}${opts.ajuda ? `\n\n${opts.ajuda}` : ""}`, opts.atual ?? ""));
  const h = host;
  return new Promise((resolve) => h({ tipo: "texto", opts, resolve }));
}

export function HostDialogosSep() {
  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [check, setCheck] = useState(false);
  const [texto, setTexto] = useState("");
  useEffect(() => {
    host = (p) => {
      setCheck(false);
      setTexto(p.tipo === "texto" ? p.opts.atual ?? "" : "");
      setPedido(p);
    };
    return () => { host = null; };
  }, []);
  if (!pedido) return null;
  const fechar = (v: boolean) => {
    if (pedido.tipo === "confirmar") pedido.resolve(v);
    else pedido.resolve(v ? texto : null);
    setPedido(null);
  };
  if (pedido.tipo === "texto") {
    const o = pedido.opts;
    return (
      <DialogoPm
        aberto
        onFechar={() => fechar(false)}
        kicker={o.kicker}
        titulo={o.titulo}
        rodape={<><BotaoPm onClick={() => fechar(false)}>Cancelar</BotaoPm><BotaoPm tipo="primario" onClick={() => fechar(true)}>{o.okTxt ?? "Salvar"}</BotaoPm></>}
      >
        <textarea
          autoFocus
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={o.placeholder}
          style={{ minHeight: 80, resize: "vertical", borderRadius: 10, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "10px 12px", fontSize: 13, color: "var(--pm-t)" }}
        />
        {o.ajuda && <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>{o.ajuda}</span>}
      </DialogoPm>
    );
  }
  const o = pedido.opts;
  const ok = !o.check || check;
  return (
    <DialogoPm
      aberto
      perigo={o.perigo}
      onFechar={() => fechar(false)}
      kicker={o.kicker}
      titulo={o.titulo}
      rodape={<>
        <BotaoPm onClick={() => fechar(false)}>Cancelar</BotaoPm>
        <BotaoPm tipo={o.perigo ? "perigo" : "primario"} disabled={!ok} onClick={() => ok && fechar(true)}>{o.okTxt}</BotaoPm>
      </>}
    >
      {o.resumo && <CaixaPm tom={o.perigo ? "r" : "n"}>{o.resumo}</CaixaPm>}
      {(o.linhas ?? []).map((l) => <span key={l} style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>{l}</span>)}
      {o.aviso && <CaixaPm tom="a"><span style={{ fontSize: 12.5, fontWeight: 500 }}>{o.aviso}</span></CaixaPm>}
      {o.check && <MarcaPm perigo={o.perigo} marcado={check} onClick={() => setCheck((v) => !v)}>{o.check}</MarcaPm>}
    </DialogoPm>
  );
}

// ---------------------------------------------------------------------------
// Forçar embalar (quem + motivo + confirmação)
// ---------------------------------------------------------------------------

const MOTIVOS = [
  { id: "A etiqueta saiu, a impressora não avisou", t: "A etiqueta saiu, a impressora não avisou" },
  { id: "A impressora reiniciou no meio", t: "A impressora reiniciou no meio" },
  { id: "outro", t: "Outro motivo", sub: "escreva abaixo" },
];

export function ForcarEmbalarPm({ aberto, titulo, resumo, quemPadrao, carregando, onCancelar, onConfirmar }: {
  aberto: boolean; titulo: string; resumo: ReactNode; quemPadrao: string | null; carregando?: boolean;
  onCancelar: () => void; onConfirmar: (nome: string, motivo: string) => void;
}) {
  const equipeQ = useQuery({
    queryKey: ["separacao", "equipe"],
    staleTime: 10 * 60_000,
    enabled: aberto,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("equipe_membros").select("nome").eq("ativo", true).order("ordem");
      if (error) throw error;
      return ((data ?? []) as { nome: string }[]).map((r) => r.nome);
    },
  });
  const [quem, setQuem] = useState<string | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const [outro, setOutro] = useState("");
  const [check, setCheck] = useState(false);
  useEffect(() => {
    if (aberto) { setQuem(quemPadrao); setMotivo(null); setOutro(""); setCheck(false); }
  }, [aberto, quemPadrao]);
  const equipe = [...new Set([...(quemPadrao ? [quemPadrao] : []), ...(equipeQ.data ?? [])])];
  const motivoFinal = motivo === "outro" ? outro.trim() : motivo ?? "";
  const ok = !!quem && quem.trim().length >= 2 && !!motivoFinal && check && !carregando;
  return (
    <DialogoPm
      aberto={aberto}
      perigo
      onFechar={onCancelar}
      kicker="Forçar embalar · sem confirmação da impressora"
      titulo={titulo}
      rodape={<>
        <BotaoPm onClick={onCancelar} disabled={carregando}>Cancelar</BotaoPm>
        <BotaoPm tipo="perigo" disabled={!ok} onClick={() => ok && quem && onConfirmar(quem, motivoFinal)}>{carregando ? "Embalando…" : "Forçar embalar"}</BotaoPm>
      </>}
    >
      <CaixaPm tom="r">{resumo}</CaixaPm>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Quem está fazendo</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {equipe.map((n) => (
            <button key={n} type="button" onClick={() => setQuem(n)} style={{ height: 40, padding: "0 14px", borderRadius: 20, border: `1.5px solid ${quem === n ? "var(--pm-a)" : "var(--pm-b)"}`, background: quem === n ? "var(--pm-as)" : "var(--pm-s)", color: quem === n ? "var(--pm-at)" : "var(--pm-t)", cursor: "pointer", fontSize: 13, fontWeight: 500 }}>{n}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Motivo</span>
        {MOTIVOS.map((m) => <OpcaoPm key={m.id} marcada={motivo === m.id} onClick={() => setMotivo(m.id)} t={m.t} sub={m.sub} />)}
        {motivo === "outro" && (
          <input autoFocus value={outro} onChange={(e) => setOutro(e.target.value)} placeholder="O que aconteceu?" style={{ height: 40, borderRadius: 10, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "0 12px", fontSize: 13, color: "var(--pm-t)" }} />
        )}
      </div>
      <MarcaPm perigo marcado={check} onClick={() => setCheck((v) => !v)}>Confirmo que a etiqueta física saiu e está colada</MarcaPm>
    </DialogoPm>
  );
}
