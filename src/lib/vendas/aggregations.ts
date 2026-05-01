/**
 * Agregações sobre o conjunto de pedidos/itens (já filtrados por período).
 * Replica as abas "Resumo Diario", "Top SKUs", "Por UF", "Por Tipo de Envio",
 * "Cancelamentos por Motivo" do consolidar_vendas.py.
 */

import type { ItemPedido, Pedido } from "./types";

export interface ResumoDiario {
  data: string;
  pedidos_total: number;
  pedidos_validos: number;
  pedidos_cancelados: number;
  taxa_cancelamento_pct: number;
  gmv: number;
  subtotal_produtos: number;
  renda_estimada: number;
  imposto_estimado: number;
  receita_liquida: number;
  ticket_medio: number;
  comissao: number;
  servico: number;
  transacao: number;
  total_taxas: number;
  pct_taxas_sobre_gmv: number;
  frete_pago_comprador: number;
  cupons_vendedor: number;
  itens_total: number;
  ajuste_acao_comercial: number;
  comissao_afiliados: number;
}

export interface KPIs {
  gmv: number;
  pedidos: number;
  ticket_medio: number;
  total_taxas: number;
  pct_taxas: number;
  renda_estimada: number;
  cancelados: number;
  taxa_cancelamento_pct: number;
  itens_vendidos: number;
  margem_pct: number; // renda / subtotal
}

export interface TopSKU {
  sku: string;
  produto: string;
  qtd_vendida: number;
  receita: number;
  pedidos: number;
}

export interface VendaPorUF {
  uf: string;
  pedidos: number;
  gmv: number;
  ticket_medio: number;
}

export interface VendaPorEnvio {
  opcao_envio: string;
  pedidos: number;
  gmv: number;
  renda_estimada: number;
  ticket_medio: number;
}

export interface MotivoCancelamento {
  motivo: string;
  quantidade: number;
}

export interface ComposicaoFinanceira {
  receita_liquida: number; // o que sobra pro vendedor (renda estimada)
  taxas_shopee: number;
  imposto: number;
  ads: number; // sempre 0 no módulo Vendas (preenchido no Resultado)
}

// ─── Filtro por período ────────────────────────────────────────────────────

export type PeriodoKey = "7d" | "14d" | "30d" | "90d" | "all";

export const PERIODOS: { key: PeriodoKey; label: string; dias: number | null }[] = [
  { key: "7d", label: "7 dias", dias: 7 },
  { key: "14d", label: "14 dias", dias: 14 },
  { key: "30d", label: "30 dias", dias: 30 },
  { key: "90d", label: "90 dias", dias: 90 },
  { key: "all", label: "Tudo", dias: null },
];

/** Aplica filtro relativo ao maior dia presente nos dados. */
export function filtrarPeriodo<T extends { data_pedido: string }>(
  rows: T[],
  periodo: PeriodoKey,
  dataMax: string | null
): T[] {
  if (periodo === "all" || !dataMax) return rows;
  const cfg = PERIODOS.find((p) => p.key === periodo);
  if (!cfg || !cfg.dias) return rows;
  // dataMax = "YYYY-MM-DD". Calcula limite em string (comparação lexicográfica funciona pra ISO dates).
  const max = new Date(dataMax + "T00:00:00");
  const limite = new Date(max);
  limite.setDate(limite.getDate() - (cfg.dias - 1));
  const limiteStr = limite.toISOString().slice(0, 10);
  return rows.filter((r) => r.data_pedido >= limiteStr && r.data_pedido <= dataMax);
}

/** Retorna o intervalo do período anterior (mesma duração, anterior ao início). */
export function periodoAnterior(
  rows: Pedido[],
  periodo: PeriodoKey,
  dataMax: string | null
): Pedido[] {
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
  return rows.filter((r) => r.data_pedido >= iniStr && r.data_pedido <= fimStr);
}

// ─── KPIs ──────────────────────────────────────────────────────────────────

export function calcularKPIs(pedidos: Pedido[], itens: ItemPedido[]): KPIs {
  const validos = pedidos.filter((p) => p.pedido_valido);
  const cancelados = pedidos.length - validos.length;
  const gmv = sumBy(validos, (p) => p.valor_total);
  const subtotal = sumBy(validos, (p) => p.subtotal_produtos);
  const renda = sumBy(validos, (p) => p.renda_estimada);
  const totalTaxas = sumBy(validos, (p) => p.taxa_comissao + p.taxa_servico + p.taxa_transacao);
  const itensValidos = itens.filter((i) => i.pedido_valido);
  const itensVendidos = sumBy(itensValidos, (i) => i.quantidade);

  return {
    gmv,
    pedidos: validos.length,
    ticket_medio: validos.length ? gmv / validos.length : 0,
    total_taxas: totalTaxas,
    pct_taxas: gmv > 0 ? (totalTaxas / gmv) * 100 : 0,
    renda_estimada: renda,
    cancelados,
    taxa_cancelamento_pct: pedidos.length ? (cancelados / pedidos.length) * 100 : 0,
    itens_vendidos: itensVendidos,
    margem_pct: subtotal > 0 ? (renda / subtotal) * 100 : 0,
  };
}

// ─── Resumo diário ─────────────────────────────────────────────────────────

export function calcularResumoDiario(pedidos: Pedido[]): ResumoDiario[] {
  const grupos = groupBy(pedidos, (p) => p.data_pedido);
  const result: ResumoDiario[] = [];
  for (const [data, lista] of grupos) {
    if (!data) continue;
    const validos = lista.filter((p) => p.pedido_valido);
    const cancelados = lista.length - validos.length;
    const gmv = sumBy(validos, (p) => p.valor_total);
    const subtotal = sumBy(validos, (p) => p.subtotal_produtos);
    const renda = sumBy(validos, (p) => p.renda_estimada);
    const imposto = sumBy(validos, (p) => p.imposto_estimado);
    const comissao = sumBy(validos, (p) => p.taxa_comissao);
    const servico = sumBy(validos, (p) => p.taxa_servico);
    const transacao = sumBy(validos, (p) => p.taxa_transacao);
    const totalTaxas = comissao + servico + transacao;
    const itens = sumBy(validos, (p) => p.total_itens);

    result.push({
      data,
      pedidos_total: lista.length,
      pedidos_validos: validos.length,
      pedidos_cancelados: cancelados,
      taxa_cancelamento_pct: lista.length ? (cancelados / lista.length) * 100 : 0,
      gmv,
      subtotal_produtos: subtotal,
      renda_estimada: renda,
      imposto_estimado: imposto,
      receita_liquida: sumBy(validos, (p) => p.total_global),
      ticket_medio: validos.length ? gmv / validos.length : 0,
      comissao,
      servico,
      transacao,
      total_taxas: totalTaxas,
      pct_taxas_sobre_gmv: gmv > 0 ? (totalTaxas / gmv) * 100 : 0,
      frete_pago_comprador: sumBy(validos, (p) => p.taxa_envio_comprador),
      cupons_vendedor: sumBy(validos, (p) => p.cupom_vendedor),
      itens_total: itens,
      ajuste_acao_comercial: sumBy(validos, (p) => p.ajuste_acao_comercial),
      comissao_afiliados: sumBy(validos, (p) => p.comissao_afiliados),
    });
  }
  return result.sort((a, b) => a.data.localeCompare(b.data));
}

// ─── Top SKUs ──────────────────────────────────────────────────────────────

export function calcularTopSKUs(itens: ItemPedido[], limit = 50): TopSKU[] {
  const validos = itens.filter((i) => i.pedido_valido);
  const grupos = groupBy(validos, (i) => `${i.sku}|||${i.produto}`);
  const result: TopSKU[] = [];
  for (const [chave, lista] of grupos) {
    const [sku, produto] = chave.split("|||");
    const pedidosUnicos = new Set(lista.map((i) => i.id_pedido)).size;
    result.push({
      sku: sku || "(sem SKU)",
      produto: produto || "(sem nome)",
      qtd_vendida: sumBy(lista, (i) => i.quantidade),
      receita: sumBy(lista, (i) => i.subtotal),
      pedidos: pedidosUnicos,
    });
  }
  return result.sort((a, b) => b.receita - a.receita).slice(0, limit);
}

// ─── Por UF ────────────────────────────────────────────────────────────────

export function calcularPorUF(pedidos: Pedido[]): VendaPorUF[] {
  const validos = pedidos.filter((p) => p.pedido_valido && p.uf);
  const grupos = groupBy(validos, (p) => p.uf);
  const result: VendaPorUF[] = [];
  for (const [uf, lista] of grupos) {
    const gmv = sumBy(lista, (p) => p.valor_total);
    result.push({
      uf,
      pedidos: lista.length,
      gmv,
      ticket_medio: lista.length ? gmv / lista.length : 0,
    });
  }
  return result.sort((a, b) => b.gmv - a.gmv);
}

// ─── Por tipo de envio ─────────────────────────────────────────────────────

export function calcularPorEnvio(pedidos: Pedido[]): VendaPorEnvio[] {
  const validos = pedidos.filter((p) => p.pedido_valido && p.opcao_envio);
  const grupos = groupBy(validos, (p) => p.opcao_envio);
  const result: VendaPorEnvio[] = [];
  for (const [envio, lista] of grupos) {
    const gmv = sumBy(lista, (p) => p.valor_total);
    result.push({
      opcao_envio: envio,
      pedidos: lista.length,
      gmv,
      renda_estimada: sumBy(lista, (p) => p.renda_estimada),
      ticket_medio: lista.length ? gmv / lista.length : 0,
    });
  }
  return result.sort((a, b) => b.pedidos - a.pedidos);
}

// ─── Cancelamentos por motivo ──────────────────────────────────────────────

export function calcularCancelamentos(pedidos: Pedido[]): MotivoCancelamento[] {
  const cancelados = pedidos.filter((p) => !p.pedido_valido);
  const grupos = groupBy(cancelados, (p) => p.motivo_cancelamento || "(sem motivo)");
  const result: MotivoCancelamento[] = [];
  for (const [motivo, lista] of grupos) {
    result.push({ motivo, quantidade: lista.length });
  }
  return result.sort((a, b) => b.quantidade - a.quantidade);
}

// ─── Composição financeira (donut) ─────────────────────────────────────────

export function calcularComposicao(pedidos: Pedido[]): ComposicaoFinanceira {
  const validos = pedidos.filter((p) => p.pedido_valido);
  return {
    receita_liquida: Math.max(0, sumBy(validos, (p) => p.renda_estimada)),
    taxas_shopee: sumBy(validos, (p) => p.taxa_comissao + p.taxa_servico + p.taxa_transacao),
    imposto: sumBy(validos, (p) => p.imposto_estimado),
    ads: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sumBy<T>(arr: T[], fn: (x: T) => number): number {
  let total = 0;
  for (const x of arr) total += fn(x) || 0;
  return total;
}

function groupBy<T, K>(arr: T[], fn: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = fn(x);
    const arr2 = m.get(k) ?? [];
    arr2.push(x);
    m.set(k, arr2);
  }
  return m;
}
