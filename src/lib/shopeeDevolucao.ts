// ============================================================================
// As três informações que o Seller Center mostra em cada devolução Shopee —
// Solução do reembolso · Status da solicitação · Status da entrega — e, quando
// o comprador devolve o produto, o status dessa devolução (logística reversa).
// Usado nas abas "Shopee (abertas)" e "Perdas Shopee" de /devolucoes
// (componente em src/components/InfoDevolucaoShopee.tsx).
//
// Fonte: shopee_devolucoes (detalhe via get_return_detail + rastreio da IDA via
// get_tracking_info, CLAUDE.md §5.10) e pedidos (transportadora / status).
// O rastreio da ida só é consultado pelo cron 126 para os só-reembolso ACEITOS;
// sem ele, a entrega é deduzida do status do pedido (e o texto diz isso).
// ============================================================================
import { format, parseISO } from "date-fns";

import { supabaseExternal } from "@/integrations/supabase/external-client";

export interface InfoDevolucao {
  return_sn: string;
  order_sn: string | null;
  status: string | null;
  solucao: number | null;
  due_date: string | null;
  needs_logistics: boolean | null;
  logistica_reversa: string | null;
  tracking_number: string | null;
  itens: { sku: string | null; nome: string | null; qtd: number | null }[] | null;
  ida_status: string | null;
  ida_entregue_em: string | null;
  ida_falha_em: string | null;
  ida_devolvido_em: string | null;
  ida_ultimo_evento: string | null;
  ida_ultimo_em: string | null;
  ida_consultado_em: string | null;
  // de `pedidos`
  opcao_envio: string | null;
  status_pedido: string | null;
}

const COLS_DEV =
  "return_sn,order_sn,status,solucao,due_date,needs_logistics,logistica_reversa,tracking_number,itens," +
  "ida_status,ida_entregue_em,ida_falha_em,ida_devolvido_em,ida_ultimo_evento,ida_ultimo_em,ida_consultado_em";

/** Detalhe das devoluções (por return_sn) + transportadora/status do pedido. */
export async function buscarInfoDevolucao(returnSns: string[]): Promise<Record<string, InfoDevolucao>> {
  const map: Record<string, InfoDevolucao> = {};
  const unicos = Array.from(new Set(returnSns));
  for (let i = 0; i < unicos.length; i += 200) {
    const { data, error } = await supabaseExternal.from("shopee_devolucoes")
      .select(COLS_DEV).in("return_sn", unicos.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data ?? []) as unknown as Omit<InfoDevolucao, "opcao_envio" | "status_pedido">[]) {
      map[r.return_sn] = { ...r, opcao_envio: null, status_pedido: null };
    }
  }
  const orders = Array.from(new Set(Object.values(map).map((d) => d.order_sn).filter((x): x is string => !!x)));
  const porPedido: Record<string, { opcao_envio: string | null; status_pedido: string | null }> = {};
  for (let i = 0; i < orders.length; i += 200) {
    const { data, error } = await supabaseExternal.from("pedidos")
      .select("id,opcao_envio,status_pedido").in("id", orders.slice(i, i + 200));
    if (error) throw error;
    for (const p of (data ?? []) as { id: string; opcao_envio: string | null; status_pedido: string | null }[]) porPedido[p.id] = p;
  }
  for (const d of Object.values(map)) {
    const p = d.order_sn ? porPedido[d.order_sn] : undefined;
    if (p) { d.opcao_envio = p.opcao_envio; d.status_pedido = p.status_pedido; }
  }
  return map;
}

export interface Rotulo { rotulo: string; detalhe?: string; cor: string }

const CINZA = "#5C6470";
const dia = (iso: string | null) => (iso ? format(parseISO(iso), "dd/MM/yyyy") : "");

// A Shopee devolve a descrição do rastreio com UTF-8 duplo ("DevoluÃ§Ã£o").
function corrigirTexto(s: string | null): string | null {
  if (!s || !/Ã|Â/.test(s)) return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

export function solucaoReembolso(d: InfoDevolucao | undefined): Rotulo {
  if (d?.solucao === 1) return { rotulo: "Apenas reembolso", detalhe: "o produto não volta", cor: "#C9432F" };
  if (d?.solucao === 0) return { rotulo: "Devolução e reembolso", detalhe: "o comprador devolve o produto", cor: "#2F6FB0" };
  return { rotulo: "—", detalhe: "detalhe ainda não lido", cor: CINZA };
}

export function statusSolicitacao(d: InfoDevolucao | undefined): Rotulo {
  const st = d?.status ?? "";
  const dentroDoPrazo = !!d?.due_date && new Date(d.due_date).getTime() > Date.now();
  switch (st) {
    case "REQUESTED": return { rotulo: "Solicitado", detalhe: "aguardando a Shopee", cor: "#2F6FB0" };
    case "PROCESSING":
      return d?.solucao === 0
        ? { rotulo: "Em devolução", detalhe: "o comprador está devolvendo o produto", cor: "#B7791F" }
        : { rotulo: "Em processamento", cor: "#B7791F" };
    case "ACCEPTED":
      return dentroDoPrazo
        ? { rotulo: "Pendente validação do vendedor", detalhe: `a Shopee aprovou o reembolso · disputa até ${dia(d!.due_date)}`, cor: "#C9432F" }
        : { rotulo: "Reembolso concluído", detalhe: "prazo de disputa encerrado", cor: CINZA };
    case "JUDGING": return { rotulo: "Em disputa", detalhe: "julgamento da Shopee", cor: "#7A5CC7" };
    case "SELLER_DISPUTE": return { rotulo: "Disputa aberta", detalhe: "pelo vendedor", cor: "#7A5CC7" };
    case "CANCELLED": return { rotulo: "Cancelada", detalhe: "sem reembolso", cor: "#0E8A5F" };
    case "CLOSED": return { rotulo: "Encerrada", cor: CINZA };
    default: return { rotulo: st || "—", cor: CINZA };
  }
}

const STATUS_PEDIDO: Record<string, string> = {
  TO_CONFIRM_RECEIVE: "Entregue (aguardando o comprador confirmar)",
  COMPLETED: "Pedido concluído",
  SHIPPED: "Em trânsito",
  PROCESSED: "Aguardando coleta",
  READY_TO_SHIP: "Aguardando envio",
  TO_RETURN: "Em devolução",
  IN_CANCEL: "Em cancelamento",
  CANCELLED: "Cancelado",
};

/** Status da ENTREGA ORIGINAL (ida) — o que o Seller Center chama de "Status da entrega". */
export function statusEntrega(d: InfoDevolucao | undefined): Rotulo {
  if (!d) return { rotulo: "—", cor: CINZA };
  const transp = d.opcao_envio ?? undefined;
  const evento = corrigirTexto(d.ida_ultimo_evento);
  if (d.ida_consultado_em) {
    if ((evento && /descartad|perdid|extravi|avariad/i.test(evento)) || /LOST/i.test(d.ida_status ?? "")) {
      return { rotulo: evento ?? "Perdido", detalhe: [dia(d.ida_ultimo_em), transp].filter(Boolean).join(" · "), cor: "#C9432F" };
    }
    if (d.ida_devolvido_em) {
      return { rotulo: "Devolvido ao vendedor (Shopee)", detalhe: [`em ${dia(d.ida_devolvido_em)}`, transp].filter(Boolean).join(" · "), cor: "#D9622B" };
    }
    if (d.ida_entregue_em) {
      return { rotulo: "Entregue", detalhe: [`em ${dia(d.ida_entregue_em)}`, transp].filter(Boolean).join(" · "), cor: "#0E8A5F" };
    }
    if (d.ida_falha_em || /FAIL/i.test(d.ida_status ?? "")) {
      return { rotulo: "Falha na entrega", detalhe: [d.ida_falha_em ? `em ${dia(d.ida_falha_em)}` : "", transp].filter(Boolean).join(" · "), cor: "#B7791F" };
    }
    return { rotulo: evento ?? "Sem evento conclusivo", detalhe: [dia(d.ida_ultimo_em), transp].filter(Boolean).join(" · "), cor: CINZA };
  }
  const st = d.status_pedido ?? "";
  return {
    rotulo: STATUS_PEDIDO[st] ?? (st || "—"),
    detalhe: [transp, "pelo status do pedido (rastreio não consultado)"].filter(Boolean).join(" · "),
    cor: st === "TO_CONFIRM_RECEIVE" || st === "COMPLETED" ? "#0E8A5F" : CINZA,
  };
}

// Rótulos do Seller Center para a logística reversa (códigos vistos no banco).
const LOGISTICA_REVERSA: Record<string, { rotulo: string; detalhe?: string }> = {
  LOGISTICS_NOT_STARTED: { rotulo: "Não iniciada" },
  LOGISTICS_REQUEST_CREATED: { rotulo: "Aguardando postagem", detalhe: "o comprador ainda não postou" },
  LOGISTICS_PENDING_ARRANGE: { rotulo: "Aguardando agendamento" },
  LOGISTICS_READY: { rotulo: "Pronta para postagem" },
  LOGISTICS_PICKUP_RETRY: { rotulo: "Nova tentativa de coleta" },
  LOGISTICS_PICKUP_FAILED: { rotulo: "Falha na coleta" },
  LOGISTICS_PICKUP_DONE: { rotulo: "Postado", detalhe: "a caminho do vendedor" },
  LOGISTICS_DELIVERY_FAILED: { rotulo: "Falha na entrega ao vendedor" },
  LOGISTICS_DELIVERY_DONE: { rotulo: "Entregue ao vendedor" },
  LOGISTICS_REQUEST_CANCELED: { rotulo: "Cancelada" },
  LOGISTICS_LOST: { rotulo: "Perdida no caminho" },
};

// Transportadora da volta pelo formato do rastreio: padrão UPU (AP123456789BR) =
// Correios; "AP" é a autorização de postagem da Logística Reversa.
function transportadoraVolta(trk: string | null): string | null {
  if (!trk) return null;
  if (/^AP\d{9}BR$/i.test(trk)) return "Correios Logística Reversa";
  if (/^[A-Z]{2}\d{9}BR$/i.test(trk)) return "Correios";
  return null;
}

/** Status da devolução do produto (logística reversa) — só quando o produto volta. */
export function statusDevolucaoProduto(d: InfoDevolucao | undefined): Rotulo | null {
  if (!d || d.solucao === 1) return null;
  if (d.solucao !== 0 && !d.needs_logistics) return null;
  const c = d.logistica_reversa ?? "";
  const base = LOGISTICA_REVERSA[c] ?? { rotulo: c ? c.replace(/^LOGISTICS_/, "").replace(/_/g, " ").toLowerCase() : "—" };
  const cor = c === "LOGISTICS_DELIVERY_DONE" ? "#0E8A5F"
    : /FAIL|LOST/.test(c) ? "#C9432F"
    : c === "LOGISTICS_PICKUP_DONE" ? "#B7791F"
    : c === "LOGISTICS_REQUEST_CANCELED" ? CINZA : "#2F6FB0";
  const detalhe = [base.detalhe, transportadoraVolta(d.tracking_number), d.tracking_number].filter(Boolean).join(" · ");
  return { rotulo: base.rotulo, detalhe: detalhe || undefined, cor };
}
