/**
 * Cálculo de margem real cruzando Vendas × ADS × CMV.
 *
 * Margem por item:
 *   margem_item = subtotal_liquido - taxas_rateadas - imposto_rateado
 *                 - cmv_total - ads_rateado
 *
 * Onde:
 *   subtotal_liquido vem do item (subtotal dos SKUs)
 *   taxas_rateadas / imposto = proporcionais ao subtotal do item / subtotal do pedido
 *   cmv_total = cmv_unitario(sku ou sku_principal) × quantidade
 *   ads_rateado = (gasto_ads_total_periodo / gmv_periodo) × valor_total_pedido,
 *     rateado por item proporcional ao subtotal
 */

import type { ItemPedido, Pedido } from "@/lib/vendas/types";
import type { AdRow } from "@/lib/ads/types";
import type { CmvRow } from "./types";

export interface MargemPorItem {
  id_pedido: string;
  data_pedido: string;
  sku: string;
  produto: string;
  quantidade: number;
  receita: number;          // subtotal do item
  taxas_rateadas: number;
  imposto_rateado: number;
  ads_rateado: number;
  cmv_total: number;
  margem: number;
  margem_pct: number;       // margem / receita * 100
  tem_cmv: boolean;
}

export interface MargemPorSKU {
  sku: string;
  produto: string;
  qtd_vendida: number;
  receita: number;
  cmv_total: number;
  taxas: number;
  imposto: number;
  ads: number;
  margem: number;
  margem_pct: number;
  pedidos: number;
  tem_cmv: boolean;
}

export interface MargemDiaria {
  data: string;
  receita: number;
  cmv: number;
  taxas: number;
  imposto: number;
  ads: number;
  margem: number;
  margem_pct: number;
}

export interface ResumoMargem {
  receita: number;          // soma do subtotal dos itens válidos
  taxas: number;
  imposto: number;
  ads: number;
  cmv: number;
  margem: number;
  margem_pct: number;
  cobertura_cmv_pct: number; // % da receita coberta por SKUs com CMV
  itens_sem_cmv: number;
  itens_total: number;
}

function buildCmvIndex(cmv: CmvRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cmv) m.set(c.sku.trim(), c.cmv);
  return m;
}

function lookupCmv(item: ItemPedido, idx: Map<string, number>): number {
  if (item.sku && idx.has(item.sku)) return idx.get(item.sku)!;
  if (item.sku_principal && idx.has(item.sku_principal)) {
    return idx.get(item.sku_principal)!;
  }
  return 0;
}

/**
 * Calcula margem por item.
 * adsTotalPeriodo: gasto total de ADS no período (rateado proporcional ao GMV).
 * gmvTotalPeriodo: GMV válido do período (denominador para o rateio de ADS).
 */
export function calcularMargemPorItem(
  pedidos: Pedido[],
  itens: ItemPedido[],
  cmv: CmvRow[],
  adsTotalPeriodo: number,
  gmvTotalPeriodo: number
): MargemPorItem[] {
  const idx = buildCmvIndex(cmv);
  const pedidosMap = new Map(pedidos.map((p) => [p.id, p]));
  const result: MargemPorItem[] = [];

  // Pré-calcula soma do subtotal dos itens por pedido (denominador do rateio)
  const subtotalPorPedido = new Map<string, number>();
  for (const it of itens) {
    if (!it.pedido_valido) continue;
    subtotalPorPedido.set(
      it.id_pedido,
      (subtotalPorPedido.get(it.id_pedido) ?? 0) + (it.subtotal || 0)
    );
  }

  const taxaAds = gmvTotalPeriodo > 0 ? adsTotalPeriodo / gmvTotalPeriodo : 0;

  for (const it of itens) {
    if (!it.pedido_valido) continue;
    const ped = pedidosMap.get(it.id_pedido);
    if (!ped) continue;

    const subtotalPed = subtotalPorPedido.get(it.id_pedido) ?? 0;
    const peso = subtotalPed > 0 ? it.subtotal / subtotalPed : 0;

    const taxasPed =
      (ped.taxa_comissao || 0) +
      (ped.taxa_servico || 0) +
      (ped.taxa_transacao || 0) +
      (ped.comissao_afiliados || 0);

    const taxasRateadas = taxasPed * peso;
    const impostoRateado = (ped.imposto_estimado || 0) * peso;

    // ADS rateado por item: gasto_ads_pedido = taxaAds × valor_total_pedido,
    // depois proporcional ao item dentro do pedido
    const adsPedido = taxaAds * (ped.valor_total || 0);
    const adsRateado = adsPedido * peso;

    const cmvUnit = lookupCmv(it, idx);
    const cmvTotal = cmvUnit * (it.quantidade || 0);

    const receita = it.subtotal || 0;
    const margem = receita - taxasRateadas - impostoRateado - adsRateado - cmvTotal;

    result.push({
      id_pedido: it.id_pedido,
      data_pedido: it.data_pedido,
      sku: it.sku,
      produto: it.produto,
      quantidade: it.quantidade,
      receita,
      taxas_rateadas: taxasRateadas,
      imposto_rateado: impostoRateado,
      ads_rateado: adsRateado,
      cmv_total: cmvTotal,
      margem,
      margem_pct: receita > 0 ? (margem / receita) * 100 : 0,
      tem_cmv: cmvUnit > 0,
    });
  }

  return result;
}

export function calcularMargemPorSKU(margens: MargemPorItem[]): MargemPorSKU[] {
  const grupos = new Map<string, MargemPorItem[]>();
  for (const m of margens) {
    const k = m.sku || "(sem SKU)";
    const a = grupos.get(k) ?? [];
    a.push(m);
    grupos.set(k, a);
  }
  const result: MargemPorSKU[] = [];
  for (const [sku, lista] of grupos) {
    const receita = sum(lista, (x) => x.receita);
    const cmvTotal = sum(lista, (x) => x.cmv_total);
    const taxas = sum(lista, (x) => x.taxas_rateadas);
    const imposto = sum(lista, (x) => x.imposto_rateado);
    const ads = sum(lista, (x) => x.ads_rateado);
    const margem = sum(lista, (x) => x.margem);
    const pedidos = new Set(lista.map((x) => x.id_pedido)).size;
    const temCmv = lista.some((x) => x.tem_cmv);
    result.push({
      sku,
      produto: lista[0]?.produto ?? "",
      qtd_vendida: sum(lista, (x) => x.quantidade),
      receita,
      cmv_total: cmvTotal,
      taxas,
      imposto,
      ads,
      margem,
      margem_pct: receita > 0 ? (margem / receita) * 100 : 0,
      pedidos,
      tem_cmv: temCmv,
    });
  }
  return result.sort((a, b) => b.receita - a.receita);
}

export function calcularMargemDiaria(margens: MargemPorItem[]): MargemDiaria[] {
  const grupos = new Map<string, MargemPorItem[]>();
  for (const m of margens) {
    if (!m.data_pedido) continue;
    const a = grupos.get(m.data_pedido) ?? [];
    a.push(m);
    grupos.set(m.data_pedido, a);
  }
  const result: MargemDiaria[] = [];
  for (const [data, lista] of grupos) {
    const receita = sum(lista, (x) => x.receita);
    const margem = sum(lista, (x) => x.margem);
    result.push({
      data,
      receita,
      cmv: sum(lista, (x) => x.cmv_total),
      taxas: sum(lista, (x) => x.taxas_rateadas),
      imposto: sum(lista, (x) => x.imposto_rateado),
      ads: sum(lista, (x) => x.ads_rateado),
      margem,
      margem_pct: receita > 0 ? (margem / receita) * 100 : 0,
    });
  }
  return result.sort((a, b) => a.data.localeCompare(b.data));
}

export function calcularResumoMargem(margens: MargemPorItem[]): ResumoMargem {
  const receita = sum(margens, (x) => x.receita);
  const margem = sum(margens, (x) => x.margem);
  const cobertura = sum(margens.filter((x) => x.tem_cmv), (x) => x.receita);
  return {
    receita,
    taxas: sum(margens, (x) => x.taxas_rateadas),
    imposto: sum(margens, (x) => x.imposto_rateado),
    ads: sum(margens, (x) => x.ads_rateado),
    cmv: sum(margens, (x) => x.cmv_total),
    margem,
    margem_pct: receita > 0 ? (margem / receita) * 100 : 0,
    cobertura_cmv_pct: receita > 0 ? (cobertura / receita) * 100 : 0,
    itens_sem_cmv: margens.filter((x) => !x.tem_cmv).length,
    itens_total: margens.length,
  };
}

/** Soma o gasto total de ADS no período. */
export function gastoAdsPeriodo(rows: AdRow[]): number {
  let s = 0;
  for (const r of rows) s += r.gasto || 0;
  return s;
}

function sum<T>(arr: T[], fn: (x: T) => number): number {
  let s = 0;
  for (const x of arr) s += fn(x) || 0;
  return s;
}
