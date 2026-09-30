// Automação de NF de devolução (edge fn `devolucao-auto`, tabela `devolucao_auto`).
// Rótulos e tipo compartilhados entre o painel e a lista da SVL em /devolucoes.

export interface DevolucaoAuto {
  order_sn: string;
  caso: string;
  estado: string;
  id_nota_devolucao: number | null;
  numero_nota: string | null;
  itens_parcial: boolean | null;
  detalhe: string | null;
  atualizado_em: string;
}

export const CASO_DEVOLUCAO_PT: Record<string, string> = {
  cancelado: "cancelado",
  falha_entrega: "falha na entrega",
  extravio: "extravio",
  reembolso_produto: "reembolso c/ produto",
  reembolso_dinheiro: "reembolso só dinheiro",
};
