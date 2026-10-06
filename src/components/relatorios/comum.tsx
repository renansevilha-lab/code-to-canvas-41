import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";

// ============================================================================
// Relatórios dos agentes — tipos, formatação e peças visuais comuns.
// Design "Relatórios · Faixa Hoje" (Claude Design, 06/out/2026): tokens --rl-*
// em styles.css (.rl-ui, claro/escuro). Fonte: view_relatorios_categorias e
// view_relatorios_agentes_lista (SEM o HTML); o corpo_html vem de
// relatorios_agentes só no "Ver versão completa". Os números já chegam prontos
// no `resumo` (funções *_relatorio_diario no banco) — aqui só apresentação.
// ============================================================================

export interface RelatorioLista {
  id: number;
  agente: string;
  categoria: string;
  titulo: string | null;
  destaque: string | null;
  data_referencia: string;
  gerado_em: string | null;
  resumo: Record<string, unknown> | null;
}

export interface CategoriaRel {
  ordem: number;
  categoria: string;
  total_relatorios: number;
  ultimo_relatorio: string | null;
}

export type Kind = "fin" | "compras" | "ads";

/** slug da URL (?rel=) ↔ categoria da view ↔ agente. */
export const CATEGORIAS: { slug: string; nome: string; agente: string; kind: Kind }[] = [
  { slug: "financeiro", nome: "Financeiro", agente: "financeiro", kind: "fin" },
  { slug: "compras", nome: "Compras e Recebimentos", agente: "compras", kind: "compras" },
  { slug: "marketing", nome: "Marketing e ADS", agente: "ads", kind: "ads" },
];
export const categoriaDoSlug = (slug: string | undefined) =>
  CATEGORIAS.find((c) => c.slug === slug) ?? CATEGORIAS[0];
export const kindDoAgente = (agente: string): Kind =>
  CATEGORIAS.find((c) => c.agente === agente)?.kind ?? "fin";
export const nomeDoAgente = (agente: string): string =>
  CATEGORIAS.find((c) => c.agente === agente)?.nome ?? agente;

export const QUERY_OPTS = {
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
} as const;

export const num = (x: unknown): number => {
  const v = Number(x ?? 0);
  return Number.isFinite(v) ? v : 0;
};
/** número ou null (para não mostrar R$ 0 quando o dado não existe) */
export const numOuNull = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};

const MENOS = "−";
/** "R$ 48.210" / "−R$ 6.420" (sem centavos, como no design). */
export function brl(x: unknown): string {
  const v = numOuNull(x);
  if (v == null) return "—";
  const s = Math.abs(v).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
  return `${v < 0 && Math.round(Math.abs(v)) > 0 ? MENOS : ""}R$ ${s}`;
}
/** "R$ 48,2 mil" (≥ 1 mil) ou "R$ 612" — KPIs compactos dos cards. */
export function brlMil(x: unknown): string {
  const v = numOuNull(x);
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a < 1000) return brl(v);
  const s = (a / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${v < 0 ? MENOS : ""}R$ ${s} mil`;
}
export const intBR = (x: unknown): string => {
  const v = numOuNull(x);
  return v == null ? "—" : v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
};
export const dec1 = (x: unknown): string => {
  const v = numOuNull(x);
  return v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};
export const pctBR = (x: unknown, casas = 1): string => {
  const v = numOuNull(x);
  return v == null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: casas })}%`;
};

/** "2026-10-05" → "05/10" (data pura, sem `new Date` para não deslocar o dia). */
export function ddmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
}
/** "2026-10-05" → "05/10/2026". */
export function ddmmaaaa(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
/** Horário HH:mm em America/Sao_Paulo. */
export function horaSP(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit",
  });
}
/** Dia (YYYY-MM-DD) de um timestamp em America/Sao_Paulo. */
export function diaSP(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
/** Hoje em America/Sao_Paulo como YYYY-MM-DD. */
export function hojeSP(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
export function somaDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + dias));
  return dt.toISOString().slice(0, 10);
}
const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "ter, 06/10" */
export function diaSemana(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${DIAS_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${ddmm(iso)}`;
}
/** Grupo do histórico: { label: "Ontem", sub: "seg, 05/10" } ou { label: "Dom, 04/10", sub: "" }. */
export function rotuloDia(iso: string): { label: string; sub: string } {
  const hoje = hojeSP();
  if (iso === hoje) return { label: "Hoje", sub: diaSemana(iso) };
  if (iso === somaDias(hoje, -1)) return { label: "Ontem", sub: diaSemana(iso) };
  return { label: cap(diaSemana(iso)), sub: "" };
}
/** "gerado às 07:30" ou, se não foi hoje, "gerado em 05/10 às 23:51". */
export function quandoGerado(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = diaSP(iso);
  return d === hojeSP() ? `gerado às ${horaSP(iso)}` : `gerado em ${ddmm(d)} às ${horaSP(iso)}`;
}

export function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}
export function arr<T = Record<string, unknown>>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}
export const str = (x: unknown): string => (x == null ? "" : String(x));

/** Fornecedor do Tiny vem em caixa alta e longo: "ESCONDE AI COMERCIO LTDA" → "Esconde Ai".
 *  Pega as palavras até a primeira genérica (LTDA, COMERCIO, PRODUTOS, DE…), no máximo 3. */
const PARADA = /^(LTDA|EIRELI|EPP|ME|SA|S\/A|SLU|IND\.?|INDUSTRIA|INDÚSTRIA|INDUSTRIAL|COM\.?|COMERCIO|COMÉRCIO|COMERCIAL|IMPORT\.?|IMPORTACAO|IMPORTAÇÃO|EXPORT\.?|E|DE|DO|DA|DOS|DAS|PRODUTOS|ARTIGOS|DISTRIBUIDORA|ATACADISTA|VAREJISTA|SERVICOS|SERVIÇOS|CONSULTORIA|-)$/i;
export function nomeCurto(nome: unknown): string {
  const s = str(nome).trim();
  if (!s) return "—";
  const out: string[] = [];
  for (const w of s.split(/\s+/)) {
    if (PARADA.test(w)) { if (out.length) break; continue; }
    out.push(w);
    if (out.length === 3) break;
  }
  const base = out.length ? out : s.split(/\s+/).slice(0, 3);
  if (s !== s.toUpperCase()) return base.join(" ");
  return base.map((w) => (w.length <= 2 || /\d/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(" ");
}

// ---------------------------------------------------------------------------
// Fotos por SKU (view_foto_produto: Tiny > marketplace). Só os SKUs visíveis,
// em lotes de 300 (corte de 1.000 linhas do PostgREST).
// ---------------------------------------------------------------------------
export function useFotos(skus: (string | null | undefined)[]): Map<string, string> {
  const lista = useMemo(
    () => [...new Set(skus.map((s) => str(s).trim()).filter(Boolean))].sort(),
    [skus],
  );
  const q = useQuery({
    queryKey: ["relatorios", "fotos", lista.join(",")],
    enabled: lista.length > 0,
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    queryFn: async () => {
      const m = new Map<string, string>();
      for (let i = 0; i < lista.length; i += 300) {
        const { data } = await supabaseExternal.from("view_foto_produto")
          .select("sku,foto").in("sku", lista.slice(i, i + 300));
        for (const r of (data ?? []) as { sku: string; foto: string | null }[]) if (r.foto) m.set(r.sku, r.foto);
      }
      return m;
    },
  });
  return q.data ?? new Map();
}

/** Foto do produto ou o quadrado tracejado do design (sem foto / logo). */
export function Foto({
  src, size = 36, alt = "", rotulo,
}: { src?: string | null; size?: number; alt?: string; rotulo?: string }) {
  const est = { width: size, height: size };
  if (src) {
    return (
      <img src={src} alt={alt} loading="lazy" style={est}
        className="shrink-0 rounded-md object-cover border border-(--rl-border) bg-(--rl-surface-2)" />
    );
  }
  return (
    <span style={est} aria-hidden
      className="shrink-0 rounded-md border border-dashed border-(--rl-border-strong) bg-(--rl-surface-2) grid place-items-center text-[10px] font-semibold text-(--rl-text-3) uppercase overflow-hidden">
      {rotulo ? rotulo.slice(0, 2) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Peças visuais
// ---------------------------------------------------------------------------
export type Tom = "red" | "amber" | "green" | "text";
export const corTom = (t?: Tom) =>
  t === "red" ? "var(--rl-red)" : t === "amber" ? "var(--rl-amber)" : t === "green" ? "var(--rl-green)" : "var(--rl-text)";

/** KPI grande do card aberto. */
export function Kpi({ label, valor, sub, tom }: { label: string; valor: string; sub?: string | null; tom?: Tom }) {
  return (
    <div className="border border-(--rl-border) rounded-lg px-4 py-3.5 flex flex-col gap-1 min-w-0">
      <div className="text-[12px] font-medium text-(--rl-text-3)">{label}</div>
      <div className="text-[24px] font-semibold tracking-[-0.015em] leading-tight break-words" style={{ color: corTom(tom) }}>{valor}</div>
      {sub ? <div className="text-[12px] text-(--rl-text-3)">{sub}</div> : null}
    </div>
  );
}

/** Título de seção do card aberto ("Carteiras" + nota à direita). */
export function Secao({
  titulo, nota, children, className, acao,
}: { titulo: React.ReactNode; nota?: React.ReactNode; children: React.ReactNode; className?: string; acao?: React.ReactNode }) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="flex justify-between items-baseline gap-3 mb-2.5 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h4 className="text-[14px] font-semibold">{titulo}</h4>
          {acao}
        </div>
        {nota ? <div className="text-[12px] text-(--rl-text-3)">{nota}</div> : null}
      </div>
      {children}
    </section>
  );
}

const PILL: Record<string, { bg: string; fg: string }> = {
  red: { bg: "var(--rl-red-soft)", fg: "var(--rl-red)" },
  "red-solid": { bg: "var(--rl-red)", fg: "var(--rl-on-red)" },
  amber: { bg: "var(--rl-amber-soft)", fg: "var(--rl-amber)" },
  green: { bg: "var(--rl-green-soft)", fg: "var(--rl-green)" },
  gray: { bg: "var(--rl-gray-soft)", fg: "var(--rl-text-2)" },
  accent: { bg: "var(--rl-accent-soft)", fg: "var(--rl-accent-text)" },
};
export function Pill({ cor, children, title }: { cor: keyof typeof PILL; children: React.ReactNode; title?: string }) {
  const c = PILL[cor];
  return (
    <span title={title} style={{ background: c.bg, color: c.fg }}
      className="inline-block text-[11.5px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap">
      {children}
    </span>
  );
}

/** Nota da "Qualidade dos dados" (ícone de info, texto discreto). */
export function Notas({ itens }: { itens: React.ReactNode[] }) {
  if (itens.length === 0) {
    return <div className="text-[12.5px] text-(--rl-text-3)">Nada a apontar.</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {itens.map((n, i) => (
        <div key={i} className="flex gap-2 text-[12.5px] leading-[1.45] text-(--rl-text-3)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
          </svg>
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}

export const MONO = "font-mono text-[12.5px]";

/** Ícone do agente (carteira / caixa / megafone), no quadrado lilás. */
export function IconeAgente({ kind, size = 32 }: { kind: Kind; size?: number }) {
  const i = Math.round(size / 2);
  return (
    <span style={{ width: size, height: size }}
      className="rounded-lg grid place-items-center bg-(--rl-accent-soft) text-(--rl-accent-text) shrink-0">
      <svg width={i} height={i} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {kind === "fin" && (<>
          <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
          <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
        </>)}
        {kind === "compras" && (<>
          <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
          <path d="M12 22V12" /><path d="m3.3 7 7.7 4.7a2 2 0 0 0 2 0L20.7 7" />
        </>)}
        {kind === "ads" && (<>
          <path d="m3 11 18-5v12L3 14v-3z" /><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
        </>)}
      </svg>
    </span>
  );
}

export function Chevron({ aberto, size = 18 }: { aberto: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 transition-transform duration-150" style={{ transform: aberto ? "rotate(180deg)" : "none" }} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconeRelogio({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="shrink-0" aria-hidden>
      <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
    </svg>
  );
}
