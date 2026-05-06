import type { Pedido } from "@/lib/vendas/types";
import { STATUS_CANCELADOS } from "@/lib/vendas/types";
import type {
  ConciliacaoPedido,
  StatusRecebimento,
  TransacaoCarteira,
} from "./types";

export interface ResumoCarteira {
  entradas_total: number;
  saidas_total: number;
  saldo_periodo: number;
  saldo_atual: number;          // saldo após a transação mais recente
  n_transacoes: number;
  por_tipo: { tipo: string; valor: number; n: number }[];
}

export function calcularResumoCarteira(
  rows: TransacaoCarteira[]
): ResumoCarteira {
  let entradas = 0;
  let saidas = 0;
  const tipos = new Map<string, { valor: number; n: number }>();
  let maisRecente: TransacaoCarteira | null = null;

  for (const r of rows) {
    if (r.valor >= 0) entradas += r.valor;
    else saidas += r.valor;
    const t = tipos.get(r.tipo) ?? { valor: 0, n: 0 };
    t.valor += r.valor;
    t.n += 1;
    tipos.set(r.tipo, t);
    if (!maisRecente || r.data_hora > maisRecente.data_hora) maisRecente = r;
  }

  return {
    entradas_total: entradas,
    saidas_total: saidas,
    saldo_periodo: entradas + saidas,
    saldo_atual: maisRecente?.saldo_apos ?? 0,
    n_transacoes: rows.length,
    por_tipo: Array.from(tipos.entries())
      .map(([tipo, v]) => ({ tipo, valor: v.valor, n: v.n }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor)),
  };
}

/**
 * Cruza pedidos com transações da carteira. Para cada pedido válido:
 *  - recebido = soma de entradas tipo "Renda do pedido"
 *  - estornado = soma absoluta de saídas (ajustes de devolução)
 *  - status: Pago se recebido > 0 e estornado == 0
 *           Reembolsado se estornado > 0
 *           A receber se válido e recebido == 0
 *           Cancelado se status pedido em [Cancelado, Não pago]
 */
export function conciliarPedidos(
  pedidos: Pedido[],
  carteira: TransacaoCarteira[]
): ConciliacaoPedido[] {
  // Agrupa transações por id_pedido
  const porPedido = new Map<string, TransacaoCarteira[]>();
  for (const t of carteira) {
    if (!t.id_pedido) continue;
    const arr = porPedido.get(t.id_pedido) ?? [];
    arr.push(t);
    porPedido.set(t.id_pedido, arr);
  }

  const result: ConciliacaoPedido[] = [];
  for (const p of pedidos) {
    const txs = porPedido.get(p.id) ?? [];
    let recebido = 0;
    let estornado = 0;
    let dataRecebimento: string | null = null;
    for (const t of txs) {
      if (t.valor >= 0) {
        recebido += t.valor;
        if (!dataRecebimento || t.data_hora < dataRecebimento) {
          dataRecebimento = t.data_hora;
        }
      } else {
        estornado += Math.abs(t.valor);
      }
    }
    const liquido = recebido - estornado;

    let status: StatusRecebimento;
    if (STATUS_CANCELADOS.includes(p.status as never)) {
      status = "Cancelado";
    } else if (estornado > 0 && recebido === 0) {
      status = "Reembolsado";
    } else if (estornado > 0 && recebido > 0) {
      status = "Reembolsado";
    } else if (recebido > 0) {
      status = "Pago";
    } else {
      status = "A receber";
    }

    result.push({
      id_pedido: p.id,
      data_pedido: p.data_pedido,
      status_pedido: p.status,
      valor_total: p.valor_total,
      renda_estimada: p.renda_estimada,
      recebido,
      estornado,
      liquido,
      diferenca: liquido - p.renda_estimada,
      data_recebimento: dataRecebimento,
      status_recebimento: status,
      n_transacoes: txs.length,
    });
  }

  return result;
}

export interface ResumoConciliacao {
  total_pedidos: number;
  pagos: { n: number; valor: number };
  a_receber: { n: number; valor: number };       // soma de renda_estimada
  reembolsados: { n: number; valor: number };
  cancelados: { n: number; valor: number };
  total_recebido: number;
  total_estornado: number;
  diferenca_total: number;                         // recebido - renda_estimada (válidos)
  pedidos_sem_extrato: number;                     // pagos esperados ainda não na carteira
}

export function calcularResumoConciliacao(
  conc: ConciliacaoPedido[]
): ResumoConciliacao {
  const r: ResumoConciliacao = {
    total_pedidos: conc.length,
    pagos: { n: 0, valor: 0 },
    a_receber: { n: 0, valor: 0 },
    reembolsados: { n: 0, valor: 0 },
    cancelados: { n: 0, valor: 0 },
    total_recebido: 0,
    total_estornado: 0,
    diferenca_total: 0,
    pedidos_sem_extrato: 0,
  };
  for (const c of conc) {
    r.total_recebido += c.recebido;
    r.total_estornado += c.estornado;
    if (c.status_recebimento === "Pago") {
      r.pagos.n += 1;
      r.pagos.valor += c.recebido;
      r.diferenca_total += c.diferenca;
    } else if (c.status_recebimento === "A receber") {
      r.a_receber.n += 1;
      r.a_receber.valor += c.renda_estimada;
      r.pedidos_sem_extrato += 1;
    } else if (c.status_recebimento === "Reembolsado") {
      r.reembolsados.n += 1;
      r.reembolsados.valor += c.estornado;
    } else if (c.status_recebimento === "Cancelado") {
      r.cancelados.n += 1;
      r.cancelados.valor += c.valor_total;
    }
  }
  return r;
}

/** Fluxo diário do extrato. */
export function fluxoDiario(
  rows: TransacaoCarteira[]
): { data: string; entradas: number; saidas: number; liquido: number }[] {
  const map = new Map<string, { entradas: number; saidas: number }>();
  for (const r of rows) {
    const m = map.get(r.data) ?? { entradas: 0, saidas: 0 };
    if (r.valor >= 0) m.entradas += r.valor;
    else m.saidas += Math.abs(r.valor);
    map.set(r.data, m);
  }
  return Array.from(map.entries())
    .map(([data, v]) => ({
      data,
      entradas: v.entradas,
      saidas: v.saidas,
      liquido: v.entradas - v.saidas,
    }))
    .sort((a, b) => (a.data < b.data ? -1 : 1));
}

export function filtrarCarteiraPeriodo(
  rows: TransacaoCarteira[],
  dataIni: string | null,
  dataFim: string | null
): TransacaoCarteira[] {
  if (!dataIni && !dataFim) return rows;
  return rows.filter(
    (r) =>
      (!dataIni || r.data >= dataIni) && (!dataFim || r.data <= dataFim)
  );
}
