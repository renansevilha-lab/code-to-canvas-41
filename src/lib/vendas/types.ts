// Tipos compartilhados entre parser, storage e dashboards.

/**
 * 1 linha por pedido. Quando o pedido tem multi-SKU, agregamos os itens.
 * Equivalente à aba "Pedidos" do shopee_vendas_master.xlsx.
 */
export interface Pedido {
  id: string;
  status: string;
  status_devolucao: string;
  motivo_cancelamento: string;
  data_pedido: string;          // YYYY-MM-DD
  data_hora_pedido: string;     // ISO
  hora_pagamento: string;
  fbs: string;
  metodo_envio: string;
  opcao_envio: string;

  valor_total: number;          // GMV bruto cobrado do comprador
  total_global: number;
  taxa_envio_comprador: number;
  taxa_transacao: number;
  taxa_comissao: number;
  taxa_servico: number;
  cupom_vendedor: number;
  cupom_shopee: number;
  desconto_cartao: number;

  // Agregados de itens
  n_skus: number;
  total_itens: number;
  primeiro_produto: string;
  subtotal_produtos: number;    // soma dos subtotais dos itens
  ajuste_acao_comercial: number;
  comissao_afiliados: number;

  // Derivados
  pedido_valido: boolean;       // !cancelado e !não pago
  imposto_estimado: number;     // 10% do subtotal
  renda_estimada: number;       // subtotal - taxas - imposto + ajuste - afiliados

  cidade: string;
  uf: string;
  cep: string;
  destinatario: string;

  arquivo_origem: string;
  data_importacao: string;
}

/** 1 linha por SKU. */
export interface ItemPedido {
  id_pedido: string;
  data_pedido: string;
  produto: string;
  sku: string;
  sku_principal: string;
  variacao: string;
  preco: number;
  quantidade: number;
  subtotal: number;
  desconto_vendedor: number;
  status: string;
  uf: string;
  pedido_valido: boolean;
  arquivo_origem: string;
}

export type StatusCancelado = "Cancelado" | "Não pago";
export const STATUS_CANCELADOS: StatusCancelado[] = ["Cancelado", "Não pago"];
