// Definições compartilhadas da tela ADS Shopee (rota ads-shopee + visual novo AdsShopeeNovo).
// Saíram da rota em 13/nov/2026 para o componente do visual novo não importar a rota.
import { formatNumber } from "@/lib/format";
import type { PeriodPreset } from "@/lib/dashboard/period";

export type Classificacao = "excelente" | "bom" | "ok" | "ruim" | "sem_dado";
export const CLASSIF_ALL: Classificacao[] = ["excelente", "bom", "ok", "ruim", "sem_dado"];

export const CLASSIF_META: Record<Classificacao, { label: string; emoji: string; badge: string; dot: string }> = {
  excelente: { label: "Excelente", emoji: "🟢", badge: "bg-emerald-100 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
  bom:       { label: "Bom",       emoji: "🔵", badge: "bg-blue-100 text-blue-800 border-blue-200",           dot: "bg-blue-500" },
  ok:        { label: "OK",        emoji: "🟡", badge: "bg-amber-100 text-amber-800 border-amber-200",        dot: "bg-amber-500" },
  ruim:      { label: "Ruim",      emoji: "🔴", badge: "bg-red-100 text-red-800 border-red-200",              dot: "bg-red-500" },
  sem_dado:  { label: "Sem dado",  emoji: "⚪", badge: "bg-slate-100 text-slate-700 border-slate-200",        dot: "bg-slate-400" },
};

// Cores do design por classificação de ROAS (buckets "para onde vai o investimento").
export const BUCKET_COLOR: Record<Classificacao, string> = {
  excelente: "#0E8A5F",
  bom: "#4A7BD9",
  ok: "#E0A72E",
  ruim: "#C9432F",
  sem_dado: "#8A93A3",
};
export function bucketRegra(
  c: Classificacao,
  f: { roas_excelente: number; roas_bom: number; roas_ok: number } | null,
): string {
  if (!f) return "";
  const x = (n: number) => `${String(n).replace(".", ",")}x`;
  if (c === "excelente") return `ROAS ≥ ${x(f.roas_excelente)}`;
  if (c === "bom") return `ROAS ≥ ${x(f.roas_bom)}`;
  if (c === "ok") return `ROAS ≥ ${x(f.roas_ok)}`;
  if (c === "ruim") return `ROAS < ${x(f.roas_ok)}`;
  return "Sem gasto no período";
}

export type SortKey =
  | "investimento" | "vendas" | "roas" | "ctr" | "acos" | "cpc"
  | "orcamento_diario" | "impressoes" | "cliques" | "mc";

export const SORTABLE: SortKey[] = ["investimento", "vendas", "roas", "ctr", "acos", "cpc", "orcamento_diario", "impressoes", "cliques", "mc"];

export interface AnuncioRow {
  campaign_id: number | string;
  shop_id: number | string | null;
  empresa: string | null;
  anuncio: string | null;
  tipo_anuncio: string | null;
  status: string | null;
  posicionamento: string | null;
  orcamento_diario: number | null;
  item_id: number | string | null;
  foto: string | null;
  sku_pai: string | null;
  investimento: number | null;
  vendas: number | null;
  impressoes: number | null;
  cliques: number | null;
  pedidos: number | null;
  roas: number | null;
  acos: number | null;
  ctr: number | null;
  cpc: number | null;
  classificacao_roas: Classificacao | string | null;
  teve_gasto: boolean | null;
  situacoes?: string[] | null;
  meta?: number | null;
  roas_equilibrio?: number | null;
  /** MC do período (10/nov/2026): margem ÷ venda TOTAL do item no período, sem ADS e depois do ADS do item. */
  venda_item?: number | null;
  mc_pct?: number | null;
  mc_pos_ads_pct?: number | null;
}

/** MC % do período (soma dos absolutos dos anúncios com gasto, cada item uma vez; % recalculado no banco). */
export type McPeriodo = {
  venda: number | null; margem: number | null; gasto: number | null;
  mc_pct: number | null; mc_pos_ads_pct: number | null; anuncios: number; sem_margem: number;
  desde: string | null; parcial: boolean;
  filtro: { anuncios: number; mc_pct: number | null; mc_pos_ads_pct: number | null } | null;
};

/** Situações (20/out/2026, pedido do dono: "bom ROAS mas poucos cliques, muitos cliques e baixo ROAS…").
 *  A regra mora no banco (ads_shopee_painel, p_situacao); "poucos/muitos" = abaixo/acima da MEDIANA dos
 *  anúncios com gasto no período (o banco devolve as medianas em `limiares`). */
export type Limiares = { cliques: number | null; impressoes: number | null; ctr: number | null };
export const SITUACOES: { k: string; label: string; dica: string; cor: string; regra: (l: Limiares | null, f: ConfigFaixas | null) => string }[] = [
  { k: "escalar", label: "Bom ROAS, poucos cliques", cor: "#0E8A5F",
    dica: "Converte bem, mas aparece pouco: dá para ganhar alcance subindo o orçamento ou baixando um pouco a meta.",
    regra: (l, f) => `ROAS ≥ ${f?.roas_bom ?? "bom"}x e menos de ${l?.cliques ?? "—"} cliques (mediana da loja no período)` },
  { k: "orcamento_limitando", label: "Orçamento travando ROAS bom", cor: "#0E8A5F",
    dica: "O orçamento acabou em 3 ou mais dias do período com ROAS bom: aumentar o orçamento.",
    regra: () => "gastou 90% ou mais do orçamento em 3+ dias, com ROAS excelente ou bom" },
  { k: "clique_sem_conversao", label: "Muitos cliques, ROAS baixo", cor: "#C9432F",
    dica: "Atrai clique e não vende: rever preço, fotos, avaliações e descrição antes de investir mais.",
    regra: (l, f) => `${l?.cliques ?? "—"} cliques ou mais (mediana) e ROAS abaixo de ${f?.roas_ok ?? "ok"}x` },
  { k: "ctr_baixo", label: "Muitas impressões, poucos cliques", cor: "#E0A72E",
    dica: "Aparece e ninguém clica: capa, título e preço na busca.",
    regra: (l) => `${l?.impressoes != null ? formatNumber(l.impressoes) : "—"} impressões ou mais (mediana) e CTR abaixo de 60% da mediana (${l?.ctr ?? "—"}%)` },
  { k: "gasto_sem_venda", label: "Gasto sem venda", cor: "#C9432F",
    dica: "Investiu e não vendeu nada no período.",
    regra: () => "R$ 10 ou mais investidos e nenhum pedido" },
  { k: "prejuizo", label: "Abaixo do equilíbrio (prejuízo)", cor: "#C9432F",
    dica: "O ADS custa mais do que a margem paga: subir a meta, pausar ou rever o preço.",
    regra: () => "ROAS abaixo de 100 ÷ margem de contribuição sem ADS (30 dias) do anúncio" },
  { k: "abaixo_meta", label: "ROAS abaixo da meta", cor: "#E0A72E",
    dica: "A Shopee não está entregando a meta de ROAS: rever competitividade do anúncio ou ajustar a meta ao realizado.",
    regra: () => "ROAS do período abaixo de 80% da meta de ROAS de hoje" },
];
export const SIT_POR_K = new Map(SITUACOES.map((s) => [s.k, s]));

export interface ResumoRow {
  empresa: string | null;
  classificacao_roas: Classificacao | string | null;
  anuncios: number | null;
  investimento: number | null;
  vendas: number | null;
  roas_medio: number | null;
  acos_medio: number | null;
}

export interface ConfigFaixas {
  roas_excelente: number;
  roas_bom: number;
  roas_ok: number;
  acos_alvo: number;
}

export interface DailyRow {
  empresa: string | null;
  data: string;
  gasto: number | null;
  gmv_direto: number | null;
}

export const PAGE_SIZE = 50;


export function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
export function fmtRoas(v: number) {
  return `${v.toFixed(2).replace(".", ",")}x`;
}


export type SearchParams = {
  classif: Classificacao[];
  inv_min?: number;
  inv_max?: number;
  roas_min?: number;
  roas_max?: number;
  acos_min?: number;
  acos_max?: number;
  empresa: string; // "all" or name
  status: "all" | "ongoing" | "paused" | "closed";
  tem_gasto: boolean;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
  pagina: number;
  period: PeriodPreset;
  from?: string;
  to?: string;
  sit?: string;
};
export const PERIODOS_VALIDOS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];
