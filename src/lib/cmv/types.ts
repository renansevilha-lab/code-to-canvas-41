// Tipos do módulo CMV (Custo da Mercadoria Vendida).

export interface CmvRow {
  sku: string;            // chave de match com itens da Shopee
  cmv: number;            // custo unitário em R$
  nome_erp?: string;
  preco_venda_erp?: number;
  categoria?: string;
  marca?: string;
  fornecedor?: string;
  formato_origem: string; // "simples" | "Tiny ERP"
  arquivo_origem: string;
  data_importacao: string;
}
