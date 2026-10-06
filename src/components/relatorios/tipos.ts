/** Mini-KPI do card fechado / da faixa Hoje. `risco` pinta de vermelho. */
export interface MiniKpi {
  label: string;
  valor: string;
  risco?: boolean;
}

/**
 * Item de "Pede decisão" (faixa Hoje). Tirado do `resumo` do agente — só
 * escolha e texto, nenhum cálculo novo. `sku` traz a foto; sem foto, o
 * quadrado tracejado mostra `rotulo` (iniciais).
 */
export interface Decisao {
  tom: "red" | "amber" | "gray";
  oQue: string;
  detalhe: string;
  sku?: string | null;
  rotulo?: string;
}
