// ============================================================================
// Edge Function: ml-sync-wallet v5
// ----------------------------------------------------------------------------
// Sincroniza pagamentos da carteira do Mercado Pago (API MP, host
// api.mercadopago.com) pra tabela transacoes_carteira (marketplace='mercadolivre').
//
// v5 (23/nov/2026, OK do dono): PAGAMENTO FEITO PELA CONTA NAO E ENTRADA.
//   /v1/payments/search devolve os pagamentos em que a conta e RECEBEDORA
//   (collector_id = conta, payer.id = outro) e tambem os que ela PAGOU
//   (payer_id = conta, collector.id = outro: boletos, PIX enviado, compras).
//   Ate a v4 tudo virava "Entrada"/recebimento_pedido — a conciliacao com o
//   extrato achou 16 lancamentos, R$ 47,6 mil em 7 dias, somando na carteira o
//   que na verdade saiu. Agora: tipo 'pagamento_feito', direcao 'Saída', valor
//   NEGATIVO quando saiu do saldo da conta (payment_type_id = account_money);
//   compra paga com cartao/outro meio nao mexe no saldo -> valor 0 (o valor da
//   compra fica em valor_bruto). pedido_id fica nulo (a referencia e de quem
//   recebeu, nao um pedido nosso) e vai para a descricao.
//   Tambem: &de=YYYY-MM-DD&ate=YYYY-MM-DD para reprocessar uma janela.
//
// v4 (31/ago): MULTI-CONTA — roda o sync para CADA conta em oauth_tokens_ml
//   (orcamento dividido), gravando shop_id = user_id da conta. Antes pegava "o
//   token mais recente", que com 2+ contas e roleta.
//
// v3 (25/ago): PAYMENT_MP SEM external_reference vira tipo 'recebimento_avulso'
// (nao 'recebimento_pedido'). Sao PIX/transferencias entrando na conta MP —
// valores redondos, sem taxas, sem descricao (inclui os saques da Shopee que
// chegam aqui).
//
// v2 (25/ago) — CONCILIACAO: removido o filtro "pedido_id so se existir em
// pedidos" (a FK que o exigia foi dropada). Ledger grava o pedido SEMPRE;
// re-rodar com ?dias=N conserta o historico (upsert por transaction_id).
//
// Modulos:
//   ?modulo=test [&conta=user_id]      - 1 pagina crua pra debug
//   ?modulo=payments&dias=90           - sync paginado de N dias (todas as contas)
//   ?modulo=payments&de=&ate=          - sync de uma janela (datas de Brasilia)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const MP_API = "https://api.mercadopago.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OTTZ_USER_ID = 1107117809;

type ContaML = { user_id: number; access_token: string; expires_at: string };

async function pegarContasML(supabase: ReturnType<typeof createClient>): Promise<ContaML[]> {
  const { data, error } = await supabase
    .from("oauth_tokens_ml")
    .select("access_token, user_id, expires_at")
    .order("user_id", { ascending: true });
  if (error || !data || data.length === 0) throw new Error("Nenhum token ML encontrado");
  const validas = (data as ContaML[]).filter((t) => new Date(t.expires_at) > new Date());
  if (validas.length === 0) throw new Error("Todos os tokens ML expirados. Rode ml-refresh-token.");
  return validas;
}

async function mpGet(path: string, accessToken: string, params: Record<string, any> = {}) {
  const url = new URL(`${MP_API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
  });
  const txt = await resp.text();
  let payload: any;
  try { payload = JSON.parse(txt); } catch { payload = { _raw: txt }; }
  if (!resp.ok) {
    const err: any = new Error(`MP API ${resp.status} em ${path}: ${JSON.stringify(payload).slice(0, 300)}`);
    err.status = resp.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

// v5: a conta PAGOU este pagamento (nao recebeu)? Na busca, quem recebe vem com
// collector_id = conta; quem paga vem com payer_id = conta e collector.id = outro.
function feitoPelaConta(p: any, sellerId: number): boolean {
  const conta = String(sellerId);
  const pagador = String(p.payer_id ?? p.payer?.id ?? "");
  const recebedor = String(p.collector_id ?? p.collector?.id ?? "");
  return pagador === conta && recebedor !== "" && recebedor !== conta;
}

// 'direcao' tem CHECK constraint: aceita SOMENTE 'Entrada' ou 'Saída'
function mapearTipo(p: any, sellerId: number): { tipo: string; classificacao: string; direcao: string; feito: boolean } {
  const status = (p.status || "").toLowerCase();
  const opType = (p.operation_type || "").toLowerCase();

  if (feitoPelaConta(p, sellerId)) {
    if (status === "cancelled" || status === "rejected") {
      return { tipo: "cancelado", classificacao: "CANCELLED_OUT_MP", direcao: "Saída", feito: true };
    }
    const base = opType === "regular_payment" ? "PAYMENT_OUT" : `OP_${opType.toUpperCase() || "UNKNOWN"}_OUT`;
    const meio = (p.payment_type_id || "") === "account_money" ? "" : "_CARD";
    return { tipo: "pagamento_feito", classificacao: `${base}${meio}_MP`, direcao: "Saída", feito: true };
  }

  if (status === "refunded" || p.transaction_amount_refunded > 0) {
    return { tipo: "estorno", classificacao: "REFUND_MP", direcao: "Saída", feito: false };
  }
  if (status === "cancelled" || status === "rejected") {
    return { tipo: "cancelado", classificacao: "CANCELLED_MP", direcao: "Saída", feito: false };
  }
  if (opType === "regular_payment") {
    // v3: sem external_reference nao e pedido do ML — e PIX/transferencia
    // entrando na conta (valor redondo, sem taxa). Outra especie no caixa.
    if (!p.external_reference) {
      return { tipo: "recebimento_avulso", classificacao: "PAYMENT_MP", direcao: "Entrada", feito: false };
    }
    return { tipo: "recebimento_pedido", classificacao: "PAYMENT_MP", direcao: "Entrada", feito: false };
  }
  return { tipo: "outro_mp", classificacao: `OP_${opType.toUpperCase() || "UNKNOWN"}`, direcao: "Entrada", feito: false };
}

function extraiCharge(charges: any[], nome: string): number {
  if (!Array.isArray(charges)) return 0;
  let total = 0;
  for (const c of charges) {
    if (c?.name === nome) {
      total += parseFloat(c?.amounts?.original || 0);
    }
  }
  return total;
}

function mapearPagamento(p: any, sellerId: number): Record<string, any> {
  const { tipo, classificacao, direcao, feito } = mapearTipo(p, sellerId);

  const valorBruto = parseFloat(p.transaction_amount || 0);
  const valorLiquido = parseFloat(p.transaction_details?.net_received_amount || 0);

  if (feito) {
    // Saiu do saldo so quando foi pago com o dinheiro da conta e nao foi cancelado.
    const devolvido = parseFloat(p.transaction_amount_refunded || 0);
    const saiuDoSaldo = tipo === "pagamento_feito" && (p.payment_type_id || "") === "account_money";
    const ref = p.external_reference ? String(p.external_reference) : "";
    const desc = [p.description ? String(p.description).trim() : "", ref ? `ref. ${ref}` : ""].filter(Boolean).join(" · ");
    return {
      shop_id: sellerId,
      marketplace: "mercadolivre",
      transaction_id: String(p.id),
      data: p.date_approved || p.date_created,
      tipo,
      classificacao,
      descricao: desc || null,
      pedido_id: null,
      direcao,
      valor: saiuDoSaldo ? -Math.max(0, Math.round((valorBruto - devolvido) * 100) / 100) : 0,
      status: p.status || null,
      fonte: "api",
      valor_bruto: valorBruto || null,
      valor_liquido: null,
      taxa_comissao: null,
      taxa_processamento: null,
      frete_charge: null,
      data_liberacao: p.money_release_date || null,
      status_liberacao: p.money_release_status || null,
    };
  }

  const charges = p.charges_details || [];
  const taxaComissao = extraiCharge(charges, "ml_sale_fee");
  const taxaProcessamento = extraiCharge(charges, "mp_processing_fee");
  const freteCharge = extraiCharge(charges, "shp_fulfillment");

  return {
    shop_id: sellerId,
    marketplace: "mercadolivre",
    transaction_id: String(p.id),
    data: p.date_approved || p.date_created,
    tipo,
    classificacao,
    descricao: p.description || null,
    pedido_id: p.external_reference ? String(p.external_reference) : null,
    direcao,
    valor: direcao === "Entrada" ? valorLiquido : -Math.abs(valorLiquido || valorBruto),
    status: p.status || null,
    fonte: "api",
    valor_bruto: valorBruto || null,
    valor_liquido: valorLiquido || null,
    taxa_comissao: taxaComissao || null,
    taxa_processamento: taxaProcessamento || null,
    frete_charge: freteCharge || null,
    data_liberacao: p.money_release_date || null,
    status_liberacao: p.money_release_status || null,
  };
}

async function syncPayments(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  sellerId: number,
  dataDe: string,
  dataAte: string,
  deadlineMs: number,
) {
  const PAGE_SIZE = 50;
  const inicio = Date.now();

  let offset = 0;
  let totalEncontrados: number | null = null;
  let totalUpsert = 0;
  let feitos = 0;
  const erros: string[] = [];

  while (true) {
    if (Date.now() > deadlineMs) {
      erros.push(`Timeout no offset ${offset}`);
      break;
    }

    let resp: any;
    try {
      resp = await mpGet("/v1/payments/search", accessToken, {
        sort: "date_created",
        criteria: "desc",
        "range": "date_created",
        "begin_date": dataDe,
        "end_date": dataAte,
        offset,
        limit: PAGE_SIZE,
      });
    } catch (err) {
      erros.push(`offset ${offset}: ${(err as Error).message}`);
      break;
    }

    const results = resp.results || [];
    totalEncontrados = resp.paging?.total ?? totalEncontrados;
    if (results.length === 0) break;

    const linhas = results.map((p: any) => mapearPagamento(p, sellerId));
    feitos += linhas.filter((l: any) => l.tipo === "pagamento_feito" || l.classificacao === "CANCELLED_OUT_MP").length;

    const { error: errUp } = await supabase
      .from("transacoes_carteira")
      .upsert(linhas, { onConflict: "transaction_id" });

    if (errUp) erros.push(`upsert offset ${offset}: ${errUp.message}`);
    else totalUpsert += linhas.length;

    offset += PAGE_SIZE;
    if (results.length < PAGE_SIZE) break;
    if (offset >= 30000) break; // safety
  }

  return {
    seller_id: sellerId,
    total_no_mp: totalEncontrados,
    upserted: totalUpsert,
    feitos_pela_conta: feitos,
    erros,
    tempo_ms: Date.now() - inicio,
  };
}

serve(async (req: Request) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Faltam secrets Supabase", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let contas: ContaML[];
  try { contas = await pegarContasML(supabase); }
  catch (err) { return new Response((err as Error).message, { status: 401 }); }

  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "payments";

  if (modulo === "test") {
    const contaTeste = Number(url.searchParams.get("conta") || OTTZ_USER_ID);
    const c = contas.find((x) => Number(x.user_id) === contaTeste) || contas[0];
    const dias = parseInt(url.searchParams.get("dias") || "7", 10);
    const dataDe = new Date(Date.now() - dias * 86400000).toISOString();
    try {
      const resp = await mpGet("/v1/payments/search", c.access_token, {
        sort: "date_created",
        criteria: "desc",
        "range": "date_created",
        "begin_date": dataDe,
        "end_date": "NOW",
        offset: 0,
        limit: 3,
      });
      const mapeado = (resp.results || []).map((p: any) => mapearPagamento(p, Number(c.user_id)));
      return Response.json({
        seller_id: Number(c.user_id),
        total: resp.paging?.total,
        primeiro_payment_cru: resp.results?.[0],
        mapeado_pro_banco: mapeado,
      });
    } catch (err) {
      return Response.json({ erro: (err as Error).message, payload: (err as any).payload }, { status: 500 });
    }
  }

  const tInicio = Date.now();
  let resultado: any;
  try {
    if (modulo === "payments") {
      const dias = parseInt(url.searchParams.get("dias") || "90", 10);
      // v5: janela explicita (dias de Brasilia) para reprocessar o historico por partes
      const de = url.searchParams.get("de");
      const ate = url.searchParams.get("ate");
      const ehData = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
      const dataDe = ehData(de) ? `${de}T00:00:00.000-03:00` : new Date(Date.now() - dias * 86400000).toISOString();
      const dataAte = ehData(ate) ? `${ate}T23:59:59.999-03:00` : "NOW";
      const contaSo = url.searchParams.get("conta");
      const alvo = contaSo ? contas.filter((c) => String(c.user_id) === contaSo) : contas;
      if (alvo.length === 0) return new Response("conta nao encontrada", { status: 400 });
      const orcamentoTotal = 50000;
      const porConta = Math.floor(orcamentoTotal / alvo.length);
      const porContaResultados: any[] = [];
      for (let i = 0; i < alvo.length; i++) {
        const c = alvo[i];
        const deadline = tInicio + porConta * (i + 1);
        porContaResultados.push(await syncPayments(supabase, c.access_token, Number(c.user_id), dataDe, dataAte, deadline));
      }
      resultado = {
        modulo: "payments",
        dias: ehData(de) ? null : dias,
        de: ehData(de) ? de : null,
        ate: ehData(ate) ? ate : null,
        contas: porContaResultados,
        upserted: porContaResultados.reduce((s, r) => s + r.upserted, 0),
        feitos_pela_conta: porContaResultados.reduce((s, r) => s + r.feitos_pela_conta, 0),
        erros: porContaResultados.flatMap((r) => r.erros),
      };
    } else {
      return new Response(`Modulo "${modulo}" nao implementado`, { status: 400 });
    }
  } catch (err) {
    return new Response(`Erro: ${(err as Error).message}`, { status: 500 });
  }
  resultado.tempo_ms_total = Date.now() - tInicio;
  return Response.json(resultado);
});
