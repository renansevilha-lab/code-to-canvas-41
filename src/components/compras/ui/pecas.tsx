// Peças visuais de Compras e Recebimento (tokens --pm-* da classe .pm-ui).
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { Check, Package } from "lucide-react";

import type { Passo } from "./defs";
import { diaHora, diaMes } from "./defs";

export const cartaoR: CSSProperties = {
  background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 22, boxShadow: "var(--pm-sh)",
};
export const kicker: CSSProperties = {
  fontSize: 11, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--pm-t3)",
};
export const mini: CSSProperties = { fontSize: 11.5, color: "var(--pm-t3)" };
export const tnum: CSSProperties = { fontVariantNumeric: "tabular-nums" };

type TomBotao = "primario" | "contorno" | "perigo" | "fantasma";
export function BotaoR({ tom = "contorno", pequeno, style, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tom?: TomBotao; pequeno?: boolean }) {
  const cores: Record<TomBotao, CSSProperties> = {
    primario: { background: "var(--pm-a)", color: "var(--pm-oa)", border: "1px solid var(--pm-a)" },
    contorno: { background: "var(--pm-s)", color: "var(--pm-t)", border: "1px solid var(--pm-bc)" },
    perigo: { background: "var(--pm-s)", color: "var(--pm-r)", border: "1px solid var(--pm-r)" },
    fantasma: { background: "transparent", color: "var(--pm-t2)", border: "1px solid transparent" },
  };
  return (
    <button type="button" {...rest}
      className={tom === "primario" ? "pm-hv-a" : "pm-hv"}
      style={{
        ...cores[tom], borderRadius: 999, padding: pequeno ? "5px 12px" : "7px 14px", fontSize: pequeno ? 12 : 13, fontWeight: 500,
        cursor: rest.disabled ? "not-allowed" : "pointer", opacity: rest.disabled ? 0.5 : 1, whiteSpace: "nowrap",
        display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "inherit", ...style,
      }}>
      {children}
    </button>
  );
}

export function SeloR({ tom = "n", children, title }: { tom?: "r" | "a" | "g" | "n" | "z"; children: ReactNode; title?: string }) {
  const c = {
    r: ["var(--pm-rs)", "var(--pm-r)"], a: ["var(--pm-ams)", "var(--pm-am)"], g: ["var(--pm-gs)", "var(--pm-g)"],
    n: ["var(--pm-s2)", "var(--pm-t2)"], z: ["var(--pm-as)", "var(--pm-at)"],
  }[tom];
  return (
    <span title={title} style={{ display: "inline-block", fontSize: 11, fontWeight: 600, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap", background: c[0], color: c[1] }}>
      {children}
    </span>
  );
}

/** Segmento em pílula (escolha única). */
export function Pilulas<T extends string>({ ops, valor, onValor }: { ops: Array<{ id: T; nome: ReactNode }>; valor: T; onValor: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 999, padding: 3, gap: 2, background: "var(--pm-s)", flexWrap: "wrap" }}>
      {ops.map((o) => {
        const on = o.id === valor;
        return (
          <button key={o.id} type="button" onClick={() => onValor(o.id)} className={on ? undefined : "pm-hv"}
            style={{
              border: 0, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t)",
              fontFamily: "inherit", fontSize: 13, fontWeight: 500, padding: "6px 14px", cursor: "pointer", borderRadius: 999, whiteSpace: "nowrap",
            }}>
            {o.nome}
          </button>
        );
      })}
    </div>
  );
}

export function Busca({ valor, onValor, placeholder, largura = 340 }: { valor: string; onValor: (v: string) => void; placeholder: string; largura?: number }) {
  return (
    <input value={valor} onChange={(e) => onValor(e.target.value)} placeholder={placeholder} aria-label={placeholder}
      style={{
        border: "1px solid var(--pm-bc)", borderRadius: 999, padding: "8px 14px", background: "var(--pm-s)", color: "var(--pm-t)",
        fontFamily: "inherit", fontSize: 13, flex: `1 1 ${Math.min(largura, 220)}px`, maxWidth: largura, minWidth: 0,
      }} />
  );
}

export function Progresso({ feito, total, cor }: { feito: number; total: number; cor?: string }) {
  const pct = total > 0 ? Math.min(100, (feito / total) * 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 6, background: "var(--pm-s2)", overflow: "hidden", marginTop: 4 }}>
      <div style={{ height: "100%", borderRadius: 6, width: `${pct}%`, background: cor ?? "var(--pm-g)" }} />
    </div>
  );
}

export function FotoR({ url, tam = 46 }: { url?: string | null; tam?: number }) {
  const [erro, setErro] = useState(false);
  const base: CSSProperties = { width: tam, height: tam, borderRadius: 12, background: "var(--pm-s2)", flexShrink: 0 };
  if (!url || erro) {
    return <div style={{ ...base, display: "grid", placeItems: "center", color: "var(--pm-t3)" }}><Package size={18} /></div>;
  }
  return <img src={url} alt="" loading="lazy" onError={() => setErro(true)} style={{ ...base, objectFit: "cover" }} />;
}

/** Linha do tempo de 6 passos. `detalhe` mostra hora e quem (dentro da ordem). */
export function Trilha({ passos, detalhe }: { passos: Passo[]; detalhe?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", minWidth: 0 }}>
      {passos.map((p, i) => {
        const ok = p.estado === "ok", agora = p.estado === "agora", prob = p.estado === "problema";
        const corBola = ok ? "var(--pm-g)" : prob ? "var(--pm-am)" : agora ? "var(--pm-a)" : "var(--pm-bc)";
        const data = p.quando ? (detalhe ? diaHora(p.quando) : diaMes(p.quando)) : null;
        const linha2 = data ? (detalhe && p.quem ? `${data} · ${p.quem}` : data) : p.nota ? (detalhe && p.quem ? `${p.nota} · ${p.quem}` : p.nota) : null;
        return (
          <div key={p.id} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, position: "relative", minWidth: 0 }}>
            {i > 0 && (
              <div style={{ position: "absolute", top: 8, left: "-50%", width: "100%", height: 3, borderRadius: 3, background: ok || prob ? "var(--pm-g)" : "var(--pm-b)" }} />
            )}
            <div style={{
              width: 19, height: 19, borderRadius: "50%", position: "relative", zIndex: 1, display: "grid", placeItems: "center",
              border: `2px solid ${corBola}`, background: ok || prob ? corBola : "var(--pm-s)",
              boxShadow: agora ? "0 0 0 4px var(--pm-as)" : undefined, color: "#fff", fontSize: 11, fontWeight: 700,
            }}>
              {ok ? <Check size={12} strokeWidth={3} /> : prob ? "!" : null}
            </div>
            <span style={{
              fontSize: 10.5, textAlign: "center", lineHeight: 1.2,
              color: agora ? "var(--pm-at)" : prob ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: agora || prob ? 600 : 400,
            }}>
              {detalhe ? p.nomeLongo : p.nome}
            </span>
            {linha2 && (
              <span style={{
                fontSize: 10.5, textAlign: "center", lineHeight: 1.15, ...tnum,
                color: data ? "var(--pm-t2)" : "var(--pm-t3)", fontWeight: data ? 600 : 400,
              }}>
                {linha2}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Par rótulo/valor da lateral. */
export function ParKV({ k, v, ultimo }: { k: string; v: ReactNode; ultimo?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: ultimo ? undefined : "1px solid var(--pm-b)" }}>
      <span style={{ color: "var(--pm-t3)" }}>{k}</span>
      <span style={{ fontWeight: 500, textAlign: "right", ...tnum }}>{v}</span>
    </div>
  );
}
