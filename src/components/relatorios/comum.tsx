import { Megaphone, Package, Wallet, type LucideIcon } from "lucide-react";

import { formatBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

// ============================================================================
// Relatórios dos agentes — tipos e utilidades comuns (05/out/2026).
// Fonte: view_relatorios_categorias (abas) e view_relatorios_agentes_lista
// (cards, SEM o HTML). O corpo_html vem de relatorios_agentes só quando o
// usuário pede "Ver versão completa". Os números já chegam prontos no `resumo`
// (funções financeiro_relatorio_diario / compras_relatorio_diario no banco).
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

/** slug da URL (?rel=) ↔ nome da categoria na view. */
export const CATEGORIAS: { slug: string; nome: string; icone: LucideIcon; vazio: string }[] = [
  { slug: "financeiro", nome: "Financeiro", icone: Wallet, vazio: "Nenhum relatório Financeiro ainda." },
  {
    slug: "compras", nome: "Compras e Recebimentos", icone: Package,
    vazio: "Nenhum relatório de Compras e Recebimentos ainda.",
  },
  {
    slug: "marketing", nome: "Marketing e ADS", icone: Megaphone,
    vazio: "Nenhum relatório de Marketing e ADS ainda. O agente desta área ainda não foi criado.",
  },
];
export const slugDaCategoria = (nome: string) => CATEGORIAS.find((c) => c.nome === nome)?.slug ?? nome;
export const categoriaDoSlug = (slug: string | undefined) =>
  CATEGORIAS.find((c) => c.slug === slug) ?? CATEGORIAS[0];
export const iconeDaCategoria = (nome: string): LucideIcon =>
  CATEGORIAS.find((c) => c.nome === nome)?.icone ?? Wallet;

export const QUERY_OPTS = {
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
} as const;

export const num = (x: unknown): number => {
  const v = Number(x ?? 0);
  return Number.isFinite(v) ? v : 0;
};
/** número ou null (para não mostrar R$ 0,00 quando o dado não existe) */
export const numOuNull = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const v = Number(x);
  return Number.isFinite(v) ? v : null;
};
export const brl = (x: unknown): string => {
  const v = numOuNull(x);
  return v == null ? "—" : formatBRL(v);
};

/** "2026-10-05" → "05/10" (data pura, sem `new Date` para não deslocar o dia). */
export function ddmm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
}
/** Horário HH:mm em America/Sao_Paulo. */
export function horaSP(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit",
  });
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
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
/** Rótulo do grupo: "Hoje", "Ontem" ou "Seg, 05/10". */
export function rotuloDia(iso: string): string {
  const hoje = hojeSP();
  if (iso === hoje) return "Hoje";
  if (iso === somaDias(hoje, -1)) return "Ontem";
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DIAS_SEMANA[dow]}, ${ddmm(iso)}`;
}

export function obj(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}
export function arr<T = Record<string, unknown>>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

/** Card de KPI do relatório aberto (tokens do app, claro/escuro). */
export function KpiBox({
  titulo, valor, sub, tom, extra,
}: {
  titulo: string;
  valor: string;
  sub?: string | null;
  tom?: "red" | "green" | "amber";
  extra?: React.ReactNode;
}) {
  return (
    <div className={cn(
      "rounded-lg border bg-card px-3.5 py-3 flex flex-col gap-1 min-w-0",
      tom === "red" && "border-red-300 dark:border-red-900 bg-red-500/5",
    )}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {titulo}{extra}
      </span>
      <span className={cn(
        "text-[15px] sm:text-lg font-extrabold tabular-nums leading-tight break-words",
        tom === "red" && "text-red-700 dark:text-red-400",
        tom === "green" && "text-emerald-700 dark:text-emerald-400",
        tom === "amber" && "text-amber-700 dark:text-amber-400",
      )}>{valor}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function Bloco({ titulo, children, direita }: { titulo: string; children: React.ReactNode; direita?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[12px] font-bold uppercase tracking-wide text-muted-foreground">{titulo}</h4>
        {direita}
      </div>
      {children}
    </section>
  );
}

export const BADGE = {
  red: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  gray: "bg-muted text-muted-foreground",
} as const;

export function Selo({ cor, children, title }: { cor: keyof typeof BADGE; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center text-[10.5px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap", BADGE[cor])}>
      {children}
    </span>
  );
}
