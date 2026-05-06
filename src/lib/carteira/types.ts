// Tipos do módulo Carteira (extrato Shopee Balance Transaction).

export interface TransacaoCarteira {
  chave: string;            // dedup: data + id_pedido + valor + tipo
  data_hora: string;        // ISO "YYYY-MM-DD HH:MM:SS"
  data: string;             // YYYY-MM-DD
  tipo: string;             // "Renda do pedido" | "Ajuste" | "Pix" | "Shopee Acelera" | ...
  descricao: string;
  id_pedido: string;        // pode ser "-" ou ""
  direcao: "Entrada" | "Saída";
  valor: number;            // assinado: entradas positivas, saídas negativas
  status: string;           // "Transação completa" etc.
  saldo_apos: number;
  arquivo_origem: string;
  data_importacao: string;
}

export type StatusRecebimento =
  | "Pago"           // pedido válido com Renda do pedido recebida
  | "A receber"     // pedido válido sem renda ainda
  | "Reembolsado"   // teve ajuste de débito (devolução)
  | "Cancelado"     // pedido cancelado/não pago
  | "Sem pedido";   // transação sem pedido associado (Pix, Acelera)

export interface ConciliacaoPedido {
  id_pedido: string;
  data_pedido: string;
  status_pedido: string;
  valor_total: number;          // GMV bruto
  renda_estimada: number;       // calculado em vendas
  recebido: number;             // soma de Entradas (Renda do pedido) na carteira
  estornado: number;            // soma absoluta de Ajustes Saída
  liquido: number;              // recebido - estornado
  diferenca: number;            // liquido - renda_estimada
  data_recebimento: string | null;
  status_recebimento: StatusRecebimento;
  n_transacoes: number;
}
