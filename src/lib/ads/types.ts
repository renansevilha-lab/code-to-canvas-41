// Tipos compartilhados do módulo ADS (Anúncios Shopee).

/**
 * 1 linha por (anúncio × dia). Quando o relatório vier agregado (sem coluna
 * de data), usamos data = arquivo_periodo (ou em branco) e tratamos como 1 linha.
 */
export interface AdRow {
  /** Chave única determinística pra dedup (id_anuncio + data ou hash). */
  chave: string;

  data: string;           // YYYY-MM-DD (ou "" se relatório agregado)
  id_anuncio: string;     // se vier; senão usamos o nome
  nome_anuncio: string;
  tipo_anuncio: string;   // "Anúncio do produto", "Pesquisa", "GMV+", etc.
  status: string;

  // Métricas brutas
  impressoes: number;
  cliques: number;
  pedidos: number;
  itens_vendidos: number;
  gmv: number;            // Vendas (GMV) atribuídas ao anúncio
  gasto: number;          // Gasto com anúncio (custo)

  // Derivados (recalculados — não confiamos no que vier no xlsx)
  ctr_pct: number;        // cliques / impressoes * 100
  cpc: number;            // gasto / cliques
  cpa: number;            // gasto / pedidos (custo por aquisição)
  roas: number;           // gmv / gasto
  taxa_conversao_pct: number; // pedidos / cliques * 100
  ticket_medio: number;   // gmv / pedidos

  arquivo_origem: string;
  data_importacao: string;
}
