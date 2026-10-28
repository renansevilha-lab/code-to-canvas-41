// Peças visuais da Produção — mesmos tokens --pm-* das telas novas (classe .pm-ui).
import type { CSSProperties, ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from "react";

export const cartao: CSSProperties = {
  background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, padding: 14, boxShadow: "var(--pm-sh)",
};

export function Cartao({ titulo, direita, children, style }: { titulo?: ReactNode; direita?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ ...cartao, ...style }}>
      {(titulo || direita) && (
        <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 14.5, fontWeight: 650, margin: 0, color: "var(--pm-t)" }}>{titulo}</h2>
          <div style={{ flex: 1 }} />
          {direita}
        </header>
      )}
      {children}
    </section>
  );
}

type Tom = "primario" | "secundario" | "perigo" | "ok" | "fantasma";
const TONS: Record<Tom, CSSProperties> = {
  primario: { background: "var(--pm-a)", color: "var(--pm-oa)", border: "1px solid var(--pm-a)" },
  secundario: { background: "var(--pm-s)", color: "var(--pm-t)", border: "1px solid var(--pm-bc)" },
  perigo: { background: "var(--pm-r)", color: "var(--pm-or)", border: "1px solid var(--pm-r)" },
  ok: { background: "var(--pm-g)", color: "#fff", border: "1px solid var(--pm-g)" },
  fantasma: { background: "transparent", color: "var(--pm-t2)", border: "1px solid transparent" },
};

export function Botao({ tom = "secundario", grande, style, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tom?: Tom; grande?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={tom === "secundario" || tom === "fantasma" ? "pm-hv" : undefined}
      style={{
        ...TONS[tom], borderRadius: grande ? 16 : 9, height: grande ? undefined : 34, padding: grande ? "18px 14px" : "0 13px",
        fontSize: grande ? 22 : 13, fontWeight: 650, cursor: rest.disabled ? "not-allowed" : "pointer", opacity: rest.disabled ? 0.5 : 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, whiteSpace: "nowrap", ...style,
      }}
    >
      {children}
    </button>
  );
}

const campoBase: CSSProperties = {
  height: 36, padding: "0 10px", borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)",
  color: "var(--pm-t)", fontSize: 13.5, width: "100%",
};

export function Campo({ rotulo, dica, children }: { rotulo: string; dica?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" }}>{rotulo}</span>
      {children}
      {dica && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{dica}</span>}
    </label>
  );
}

export const Entrada = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} style={{ ...campoBase, ...p.style }} />;
export const Escolha = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} style={{ ...campoBase, ...p.style }} />;

export function Selo({ tom = "n", children }: { tom?: "r" | "a" | "g" | "n" | "azul"; children: ReactNode }) {
  const cores = {
    r: ["var(--pm-rs)", "var(--pm-r)"], a: ["var(--pm-ams)", "var(--pm-am)"], g: ["var(--pm-gs)", "var(--pm-g)"],
    n: ["var(--pm-s2)", "var(--pm-t2)"], azul: ["var(--pm-as)", "var(--pm-at)"],
  }[tom];
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: cores[0], color: cores[1], whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function Numero({ rotulo, valor, sub, tom }: { rotulo: string; valor: ReactNode; sub?: ReactNode; tom?: "r" | "a" | "g" }) {
  const cor = tom === "r" ? "var(--pm-r)" : tom === "a" ? "var(--pm-am)" : tom === "g" ? "var(--pm-g)" : "var(--pm-t)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600 }}>{rotulo}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: cor, fontVariantNumeric: "tabular-nums" }}>{valor}</span>
      {sub && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{sub}</span>}
    </div>
  );
}

export const tabela: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
export const th: CSSProperties = { textAlign: "left", fontSize: 11.5, fontWeight: 600, color: "var(--pm-t3)", padding: "6px 8px", borderBottom: "1px solid var(--pm-b)", whiteSpace: "nowrap" };
export const td: CSSProperties = { padding: "8px", borderBottom: "1px solid var(--pm-b)", verticalAlign: "middle" };
