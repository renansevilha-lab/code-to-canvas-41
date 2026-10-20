// ============================================================================
// Edge Function: ml-test-wallet v0 (TESTE DE ENDPOINTS)
// ----------------------------------------------------------------------------
// Testa varios endpoints potenciais da API do Mercado Pago / Mercado Livre
// pra descobrir o que esta acessivel com o token OAuth atual.
//
// Hosts:
//   ML_API = api.mercadolibre.com (ML core, pedidos, usuarios)
//   MP_API = api.mercadopago.com  (pagamentos, saques, saldo)
//   Mesmo token OAuth funciona pros dois.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ML_API = "https://api.mercadolibre.com";
const MP_API = "https://api.mercadopago.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function pegarTokenML(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("oauth_tokens_ml")
    .select("access_token, user_id, expires_at")
    .order("atualizado_em", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error("Token ML nao encontrado");
  if (new Date(data.expires_at) < new Date()) {
    throw new Error(`Token ML expirado em ${data.expires_at}. Rode ml-refresh-token.`);
  }
  return data;
}

async function tryEndpoint(host: string, path: string, accessToken: string, params: Record<string, any> = {}): Promise<any> {
  const url = new URL(`${host}${path}`);
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
  try { payload = JSON.parse(txt); } catch { payload = { _raw: txt.slice(0, 500) }; }
  return {
    status: resp.status,
    ok: resp.ok,
    url: url.toString().replace(accessToken, "***"),
    payload,
  };
}

serve(async (req: Request) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Faltam secrets Supabase", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let tokenData;
  try { tokenData = await pegarTokenML(supabase); }
  catch (err) { return new Response((err as Error).message, { status: 401 }); }

  const accessToken = tokenData.access_token;
  const userId = tokenData.user_id;

  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "user-info";

  // Sanity check (ML core)
  if (modulo === "user-info") {
    const r = await tryEndpoint(ML_API, `/users/${userId}`, accessToken);
    return Response.json({ modulo, ...r });
  }

  // Pagamentos recebidos - Mercado Pago (host MP)
  if (modulo === "payments-search") {
    const r = await tryEndpoint(MP_API, `/v1/payments/search`, accessToken, {
      sort: "date_created",
      criteria: "desc",
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Movimentos da conta em dinheiro - Mercado Pago (host MP)
  if (modulo === "account-money") {
    const r = await tryEndpoint(MP_API, `/v1/account_money/movements`, accessToken, {
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Saldo - Mercado Pago (host MP)
  if (modulo === "balance") {
    const r = await tryEndpoint(MP_API, `/users/${userId}/mercadopago_account/balance`, accessToken);
    return Response.json({ modulo, ...r });
  }

  // Saques/Withdraw - Mercado Pago (host MP)
  if (modulo === "withdrawals") {
    const r = await tryEndpoint(MP_API, `/v1/withdrawals/search`, accessToken, {
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Banking movements - Mercado Pago (host MP)
  if (modulo === "movements") {
    const r = await tryEndpoint(MP_API, `/v1/banking/movements`, accessToken, {
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Releases (liberacoes futuras) - Mercado Pago (host MP)
  if (modulo === "releases") {
    const r = await tryEndpoint(MP_API, `/v1/account/release_log`, accessToken, {
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Account settlement (extrato) - Mercado Pago
  if (modulo === "settlement") {
    const r = await tryEndpoint(MP_API, `/v1/account/settlement_report/list`, accessToken, {
      limit: 5,
    });
    return Response.json({ modulo, ...r });
  }

  // Billing ML (faturas vendedor)
  if (modulo === "billing-period") {
    const hoje = new Date();
    const ano = hoje.getUTCFullYear();
    const mes = String(hoje.getUTCMonth() + 1).padStart(2, "0");
    const r = await tryEndpoint(ML_API, `/billing/integration/period/key/MP/group/MP/details`, accessToken, {
      date_invoice: `${ano}-${mes}-01T00:00:00Z`,
    });
    return Response.json({ modulo, ...r });
  }

  return new Response(
    `Modulos disponiveis: user-info | payments-search | account-money | balance | withdrawals | movements | releases | settlement | billing-period`,
    { status: 400 }
  );
});