/**
 * Agregações sobre rows de anúncios (já filtrados por período).
 */

import type { AdRow } from "./types";
import {
  PERIODOS,
  type PeriodoKey,
  filtrarPeriodo as filtrarPeriodoVendas,
} from "@/lib/vendas/aggregations";

export type { PeriodoKey };
export { PERIODOS };

export interface AdsKPIs {
  impressoes: number;
  cliques: number;
  pedidos: number;
  itens_vendidos: number;
  gmv: number;
  gasto: number;
  roas: number;
  ctr_pct: number;
  cpc: number;
  cpa: number;
  taxa_conversao_pct: number;
  ticket_medio: number;
}

export interface ResumoDiarioAds {
  data: string;
  impressoes: number;
  cliques: number;
  pedidos: number;
  gmv: number;
  gasto: number;
  roas: number;
  ctr_pct: number;
  cpc: number;
}

export interface TopAnuncio {
  id_anuncio: string;
  nome: string;
  tipo: string;
  impressoes: number;
  cliques: number;
  pedidos: number;
  gmv: number;
  gasto: number;
  roas: number;
  ctr_pct: number;
  cpc: number;
  cpa: number;
}

export interface AdsPorTipo {
  tipo: string;
  anuncios: number;
  gasto: number;
  gmv: number;
  pedidos: number;
  roas: number;
}

// ─── Filtro por período (reusa o helper de Vendas; rows têm `data`) ───────

export function filtrarPeriodoAds(
  rows: AdRow[],
  periodo: PeriodoKey,
  dataMax: string | null
): AdRow[] {
  // Adapta: a função de Vendas espera `data_pedido`. Mapeamos.
  const adapted = rows.map((r) => ({ ...r, data_pedido: r.data }));
  const filtered = filtrarPeriodoVendas(adapted, periodo, dataMax);
  // Remove o data_pedido extra
  return filtered.map((r) => {
    const { data_pedido: _, ...rest } = r as AdRow & { data_pedido: string };
    return rest as AdRow;
  });
}

export function periodoAnteriorAds(
  rows: AdRow[],
  periodo: PeriodoKey,
  dataMax: string | null
): AdRow[] {
  if (periodo === "all" || !dataMax) return [];
  const cfg = PERIODOS.find((p) => p.key === periodo);
  if (!cfg || !cfg.dias) return [];
  const max = new Date(dataMax + "T00:00:00");
  const fim = new Date(max);
  fim.setDate(fim.getDate() - cfg.dias);
  const inicio = new Date(fim);
  inicio.setDate(inicio.getDate() - (cfg.dias - 1));
  const fimStr = fim.toISOString().slice(0, 10);
  const iniStr = inicio.toISOString().slice(0, 10);
  return rows.filter((r) => r.data >= iniStr && r.data <= fimStr);
}

// ─── KPIs ─────────────────────────────────────────────────────────────────

export function calcularAdsKPIs(rows: AdRow[]): AdsKPIs {
  const impressoes = sumBy(rows, (r) => r.impressoes);
  const cliques = sumBy(rows, (r) => r.cliques);
  const pedidos = sumBy(rows, (r) => r.pedidos);
  const itens = sumBy(rows, (r) => r.itens_vendidos);
  const gmv = sumBy(rows, (r) => r.gmv);
  const gasto = sumBy(rows, (r) => r.gasto);

  return {
    impressoes,
    cliques,
    pedidos,
    itens_vendidos: itens,
    gmv,
    gasto,
    roas: gasto > 0 ? gmv / gasto : 0,
    ctr_pct: impressoes > 0 ? (cliques / impressoes) * 100 : 0,
    cpc: cliques > 0 ? gasto / cliques : 0,
    cpa: pedidos > 0 ? gasto / pedidos : 0,
    taxa_conversao_pct: cliques > 0 ? (pedidos / cliques) * 100 : 0,
    ticket_medio: pedidos > 0 ? gmv / pedidos : 0,
  };
}

// ─── Resumo diário ────────────────────────────────────────────────────────

export function calcularResumoDiarioAds(rows: AdRow[]): ResumoDiarioAds[] {
  const grupos = groupBy(rows.filter((r) => r.data), (r) => r.data);
  const result: ResumoDiarioAds[] = [];
  for (const [data, lista] of grupos) {
    const impressoes = sumBy(lista, (r) => r.impressoes);
    const cliques = sumBy(lista, (r) => r.cliques);
    const gmv = sumBy(lista, (r) => r.gmv);
    const gasto = sumBy(lista, (r) => r.gasto);
    result.push({
      data,
      impressoes,
      cliques,
      pedidos: sumBy(lista, (r) => r.pedidos),
      gmv,
      gasto,
      roas: gasto > 0 ? gmv / gasto : 0,
      ctr_pct: impressoes > 0 ? (cliques / impressoes) * 100 : 0,
      cpc: cliques > 0 ? gasto / cliques : 0,
    });
  }
  return result.sort((a, b) => a.data.localeCompare(b.data));
}

// ─── Top anúncios ─────────────────────────────────────────────────────────

export function calcularTopAnuncios(rows: AdRow[], limit = 50): TopAnuncio[] {
  const grupos = groupBy(rows, (r) => r.id_anuncio);
  const result: TopAnuncio[] = [];
  for (const [id, lista] of grupos) {
    const impressoes = sumBy(lista, (r) => r.impressoes);
    const cliques = sumBy(lista, (r) => r.cliques);
    const pedidos = sumBy(lista, (r) => r.pedidos);
    const gmv = sumBy(lista, (r) => r.gmv);
    const gasto = sumBy(lista, (r) => r.gasto);
    result.push({
      id_anuncio: id,
      nome: lista[0].nome_anuncio,
      tipo: lista[0].tipo_anuncio,
      impressoes,
      cliques,
      pedidos,
      gmv,
      gasto,
      roas: gasto > 0 ? gmv / gasto : 0,
      ctr_pct: impressoes > 0 ? (cliques / impressoes) * 100 : 0,
      cpc: cliques > 0 ? gasto / cliques : 0,
      cpa: pedidos > 0 ? gasto / pedidos : 0,
    });
  }
  return result.sort((a, b) => b.gasto - a.gasto).slice(0, limit);
}

// ─── Por tipo de anúncio ──────────────────────────────────────────────────

export function calcularAdsPorTipo(rows: AdRow[]): AdsPorTipo[] {
  const com = rows.filter((r) => r.tipo_anuncio);
  if (com.length === 0) return [];
  const grupos = groupBy(com, (r) => r.tipo_anuncio);
  const result: AdsPorTipo[] = [];
  for (const [tipo, lista] of grupos) {
    const gmv = sumBy(lista, (r) => r.gmv);
    const gasto = sumBy(lista, (r) => r.gasto);
    const idsUnicos = new Set(lista.map((r) => r.id_anuncio));
    result.push({
      tipo,
      anuncios: idsUnicos.size,
      gasto,
      gmv,
      pedidos: sumBy(lista, (r) => r.pedidos),
      roas: gasto > 0 ? gmv / gasto : 0,
    });
  }
  return result.sort((a, b) => b.gasto - a.gasto);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sumBy<T>(arr: T[], fn: (x: T) => number): number {
  let s = 0;
  for (const x of arr) s += fn(x) || 0;
  return s;
}

function groupBy<T, K>(arr: T[], fn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = fn(x);
    const a = m.get(k) ?? [];
    a.push(x);
    m.set(k, a);
  }
  return m;
}
