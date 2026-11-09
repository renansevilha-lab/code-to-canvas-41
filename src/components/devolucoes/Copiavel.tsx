// Número (pedido, solicitação, rastreio) que se copia com um clique. Usado em
// todas as abas de /devolucoes. Não propaga o clique: dentro de uma linha
// clicável, copiar não abre o caso.
import { useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

export function Copiavel({ valor, oQue = "Pedido", children, className, style }: {
  valor: string | null | undefined; oQue?: string; children?: ReactNode; className?: string; style?: CSSProperties;
}) {
  const [ok, setOk] = useState(false);
  if (!valor) return <span className={className} style={style}>{children ?? "—"}</span>;
  const copiar = (e: { stopPropagation: () => void; preventDefault: () => void }) => {
    e.stopPropagation(); e.preventDefault();
    void navigator.clipboard.writeText(String(valor)).then(
      () => { setOk(true); toast.success(`${oQue} copiado`, { description: String(valor), duration: 1500 }); window.setTimeout(() => setOk(false), 1500); },
      () => toast.error("Não consegui copiar"),
    );
  };
  return (
    <span
      role="button" tabIndex={0} title={`Copiar ${oQue.toLowerCase()} ${valor}`}
      onClick={copiar}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") copiar(e); }}
      className={`copiavel ${className ?? ""}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "copy", borderRadius: 6, padding: "0 4px", margin: "0 -4px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", userSelect: "text", ...style }}
    >
      {children ?? valor}
      {ok ? <Check size={12} strokeWidth={3} style={{ color: "var(--pm-g, #0E8A5F)", flex: "none" }} /> : <Copy size={11} style={{ opacity: 0.45, flex: "none" }} />}
    </span>
  );
}
