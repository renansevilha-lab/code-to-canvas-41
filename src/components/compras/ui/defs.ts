// Compras e Recebimento no visual novo (16/nov/2026): tipos, etapas e a regra do
// "próximo passo". Só leitura de dados já gravados — nenhuma regra de cálculo.

export interface OrdemQuadro {
  tiny_id: number;
  numero: string | null;
  data_pedido: string | null;
  data_prevista: string | null;
  situacao_tiny: string | null;
  fornecedor_id: number | null;
  fornecedor_nome: string | null;
  fornecedor_fantasia: string | null;
  categoria: string | null;
  total_pedido: number | null;
  itens_qtd: number | null;
  kanban_status: string;
  recebido_em: string | null;
  recebido_por: string | null;
  arquivada_em: string | null;
  observacao_recebimento: string | null;
  nf_numero: string | null;
  criado_em: string | null;
  divergencia_oc_nf: boolean | null;
  divergencia_oc_nf_detalhe: unknown[] | null;
  divergencia_oc_nf_nfs: string | null;
  estoque_lancado_em: string | null;
  estoque_lancado_por: string | null;
  contas_lancadas_em: string | null;
  contas_lancadas_por: string | null;
  conferencia_iniciada_em: string | null;
  conferencia_iniciada_por: string | null;
  custo_em: string | null;
  custo_por: string | null;
  nf_em: string | null;
  tem_nf: boolean;
  ped: number;
  rec: number;
  n_itens: number;
  conferidos: number;
  apont_n: number;
  apont_ultimo: string | null;
  apont_ultimo_em: string | null;
}

export interface Apontamento {
  id: number;
  ordem_tiny_id: number;
  texto: string;
  etapa: string | null;
  autor: string | null;
  fotos: string[];
  criado_em: string;
}

export const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const fornecedorDe = (o: { fornecedor_fantasia: string | null; fornecedor_nome: string | null }): string =>
  o.fornecedor_fantasia?.trim() || o.fornecedor_nome?.trim() || "Sem fornecedor";

/** "NF 724" para entrada criada pela nota (tiny_id negativo), "OC 733" para ordem do Tiny. */
export function rotuloOrdem(o: { tiny_id: number; numero: string | null }): string {
  const n = o.numero ?? String(o.tiny_id);
  if (o.tiny_id < 0) return n.replace(/^NF-/, "NF ");
  return `OC ${n}`;
}

const TZ = "America/Sao_Paulo";
/** dd/mm de uma data pura (YYYY-MM-DD) ou de um instante (no fuso de São Paulo). */
export function diaMes(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return new Date(iso).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
}
export function diaHora(iso: string | null | undefined): string {
  if (!iso) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return diaMes(iso);
  const d = new Date(iso);
  const dia = d.toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
  const hora = d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  return `${dia} ${hora}`;
}
export function hojeBRT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
/** Dias corridos entre duas datas (b − a); aceita data pura ou instante. */
export function diasEntre(a: string, b: string): number {
  const d = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(s).toLocaleDateString("en-CA", { timeZone: TZ }));
  return Math.round((Date.parse(`${d(b)}T00:00:00Z`) - Date.parse(`${d(a)}T00:00:00Z`)) / 86400000);
}
export function haDias(iso: string | null | undefined): string {
  if (!iso) return "";
  const n = diasEntre(iso, hojeBRT());
  if (n <= 0) return "hoje";
  return n === 1 ? "há 1 dia" : `há ${n} dias`;
}

// ---------------------------------------------------------------------------
// Linha do tempo: Pedido → Nota → Conferir → Estoque → Contas → Custo
// ---------------------------------------------------------------------------

export type EstadoPasso = "ok" | "agora" | "problema" | "pendente";
export interface Passo {
  id: "pedido" | "nota" | "conferir" | "estoque" | "contas" | "custo";
  nome: string;
  nomeLongo: string;
  estado: EstadoPasso;
  /** instante ou data do passo feito */
  quando: string | null;
  quem: string | null;
  /** texto para o passo ainda não feito (previsão, há N dias) */
  nota: string | null;
}

export type Grupo = "andamento" | "aguardando" | "fechar" | "orcamento" | "fechada";

const JANELA_FECHAR_DIAS = 60;

export function conferida(o: OrdemQuadro): boolean {
  return o.kanban_status === "concluida" || o.kanban_status === "divergente";
}

/** A ordem ainda tem passo do pós-chegada em aberto (estoque, contas ou custo)? */
export function faltaFechar(o: OrdemQuadro): Passo["id"] | null {
  if (!o.estoque_lancado_em) return "estoque";
  if (!o.contas_lancadas_em) return "contas";
  if (!o.custo_em) return "custo";
  return null;
}

export function grupoDe(o: OrdemQuadro): Grupo {
  const s = o.kanban_status;
  if (s === "orcamento") return "orcamento";
  if (s === "aguardando") return "aguardando";
  if (s === "conferencia" || s === "divergente") return "andamento";
  // concluída: ainda pede fechamento só se for recente — as antigas foram
  // fechadas no Tiny antes de o app ter esses passos.
  const ref = o.recebido_em ?? o.data_pedido;
  const recente = !!ref && diasEntre(ref, hojeBRT()) <= JANELA_FECHAR_DIAS;
  return recente && faltaFechar(o) ? "fechar" : "fechada";
}

export function passosDe(o: OrdemQuadro): Passo[] {
  const s = o.kanban_status;
  const chegou = s === "conferencia" || s === "divergente" || s === "concluida";
  const conf = conferida(o);
  const falta = conf ? faltaFechar(o) : null;
  const p = (id: Passo["id"], nome: string, nomeLongo: string, estado: EstadoPasso, quando: string | null, quem: string | null, nota: string | null = null): Passo =>
    ({ id, nome, nomeLongo, estado, quando, quem, nota });

  const pedido = p("pedido", "Pedido", "Pedido", "ok", o.data_pedido, null);

  let nota: Passo;
  if (o.tem_nf) nota = p("nota", "Nota", "Nota aplicada", "ok", o.nf_em, null);
  else if (s === "aguardando") nota = p("nota", "Nota", "Nota aplicada", "agora", null, null, o.data_prevista ? `prev. ${diaMes(o.data_prevista)}` : "sem previsão");
  else nota = p("nota", "Nota", "Nota aplicada", chegou ? "agora" : "pendente", null, null, chegou ? "sem nota" : null);

  let conferir: Passo;
  if (s === "divergente") conferir = p("conferir", "Divergência", "Divergência na carga", "problema", o.recebido_em, o.recebido_por);
  else if (s === "concluida") conferir = p("conferir", "Conferir", "Carga conferida", "ok", o.recebido_em, o.recebido_por);
  else if (s === "conferencia") conferir = p("conferir", "Conferir", "Conferir a carga", "agora", null, o.conferencia_iniciada_por,
    o.conferencia_iniciada_em ? `começou ${diaMes(o.conferencia_iniciada_em)}` : haDias(o.nf_em ?? o.criado_em));
  else conferir = p("conferir", "Conferir", "Conferir a carga", "pendente", null, null);

  const pos = (id: "estoque" | "contas" | "custo", nome: string, longo: string, em: string | null, por: string | null): Passo => {
    if (em) return p(id, nome, longo, "ok", em, por);
    if (falta === id) return p(id, nome, longo, "agora", null, null, haDias(o.recebido_em));
    return p(id, nome, longo, "pendente", null, null);
  };

  return [
    pedido, nota, conferir,
    pos("estoque", "Estoque", "Estoque no Tiny", o.estoque_lancado_em, o.estoque_lancado_por),
    pos("contas", "Contas", "Contas a pagar", o.contas_lancadas_em, o.contas_lancadas_por),
    pos("custo", "Custo", "Custo do produto", o.custo_em, o.custo_por),
  ];
}

/** Rótulo do botão principal da linha no quadro. */
export function proximoPasso(o: OrdemQuadro): string {
  switch (grupoDe(o)) {
    case "orcamento": return "Abrir";
    case "aguardando": return "Chegou";
    case "andamento": return o.kanban_status === "divergente" ? "Resolver" : "Conferir";
    case "fechar": {
      const f = faltaFechar(o);
      return f === "estoque" ? "Lançar estoque" : f === "contas" ? "Lançar contas" : "Formar custo";
    }
    default: return "Abrir";
  }
}

/** Dias de atraso da ordem que ainda não chegou (0 = no prazo ou sem previsão). */
export function atrasoDias(o: OrdemQuadro): number {
  if (o.kanban_status !== "aguardando" || !o.data_prevista) return 0;
  return Math.max(0, diasEntre(o.data_prevista, hojeBRT()));
}

/** Etapa atual em texto — gravada junto do apontamento. */
export function etapaAtual(o: OrdemQuadro): string {
  const agora = passosDe(o).find((x) => x.estado === "agora" || x.estado === "problema");
  return agora ? agora.nomeLongo : "Fechada";
}

// Situação da nota fiscal no Tiny (API v3).
export const SIT_NF: Record<string, { nome: string; tom: "g" | "a" | "r" | "n" }> = {
  "1": { nome: "pendente", tom: "a" },
  "2": { nome: "emitida", tom: "g" },
  "3": { nome: "cancelada", tom: "r" },
  "4": { nome: "aguardando recibo", tom: "a" },
  "5": { nome: "rejeitada", tom: "r" },
  "6": { nome: "autorizada", tom: "g" },
  "7": { nome: "emitida", tom: "g" },
  "8": { nome: "registrada", tom: "g" },
  "9": { nome: "aguardando protocolo", tom: "a" },
  "10": { nome: "denegada", tom: "r" },
};

export interface NotaEntrada {
  tiny_id: number;
  numero: string | null;
  serie: string | null;
  chave_acesso: string | null;
  data_emissao: string | null;
  situacao: string | null;
  fornecedor_id: number | null;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  valor: number | null;
  valor_frete: number | null;
  itens_qtd: number | null;
  ignorar: boolean;
  nao_compra_em: string | null;
  nao_compra_por: string | null;
  ordem_tiny_id: number | null;
  ligada_pelo_app: boolean;
  ordem_numero: string | null;
  kanban_status: string | null;
  recebido_em: string | null;
  estoque_lancado_em: string | null;
  contas_lancadas_em: string | null;
}
