// ============================================================================
// Edge Function: amazon-inbound v1 (14/out/2026) — envios ao FBA pela API (Fulfillment Inbound v2024-03-20)
// ----------------------------------------------------------------------------
// FASE DE TESTE (pedido do dono): só a conta SVL (o app "SISTEMINHA I" tem a permissão de envios; a ACZ
// dá 403). Módulo único `teste`, protegido por CHAVE TEMPORÁRIA e PRAZO (morre sozinho), que repassa
// uma chamada à API de envios e registra tudo em debug_fulfillment (modulo='amazon-inbound-teste').
//   POST body {chave, metodo: GET|POST|PUT, caminho: "/inbound/fba/2024-03-20/...", corpo?}
// Se a resposta trouxer `operationId`, a função acompanha a operação por até ~18 s e devolve o fim.
// BLOQUEADO (gera cobrança ou compromisso): confirmar destino (placementOptions/{id}/confirmation),
// confirmar transportadora (transportationOptions/confirmation), janelas de entrega e qualquer caminho
// fora de /inbound/fba/2024-03-20/. Sem repetição automática de escrita.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const CHAVE_TESTE = "inb-7f3a-svl-1410";
const PRAZO_TESTE = Date.parse("2026-10-16T03:00:00Z");
const SHOP_SVL = 900002;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BLOQUEADOS = [
  /\/placementOptions\/[^/]+\/confirmation/i,
  /\/transportationOptions\/confirmation/i,
  /\/deliveryWindowOptions/i,
  /\/selfShipAppointment/i,
];

async function sp(token: string, metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(`${SPAPI}${caminho}`, {
    method: metodo,
    headers: { "x-amz-access-token": token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: unknown = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { _raw: txt.slice(0, 500) }; }
  return { status: r.status, body: body as Record<string, any> | null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (Date.now() > PRAZO_TESTE) return json({ ok: false, erro: "fase de teste encerrada" }, 410);
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  if (b.chave !== CHAVE_TESTE) return json({ ok: false, erro: "chave de teste inválida" }, 403);

  const metodo = String(b.metodo ?? "GET").toUpperCase();
  const caminho = String(b.caminho ?? "");
  if (!["GET", "POST", "PUT"].includes(metodo)) return json({ ok: false, erro: "método não aceito" }, 400);
  if (!caminho.startsWith("/inbound/fba/2024-03-20/") && !caminho.startsWith("/fba/inbound/v0/shipments")) {
    return json({ ok: false, erro: "caminho fora da API de envios" }, 400);
  }
  if (metodo !== "GET" && caminho.startsWith("/fba/inbound/v0/")) return json({ ok: false, erro: "v0 só leitura" }, 400);
  if (metodo !== "GET" && BLOQUEADOS.some((re) => re.test(caminho))) {
    return json({ ok: false, erro: "passo bloqueado no teste (gera cobrança ou compromisso)" }, 400);
  }

  const { data: tok } = await sb.from("oauth_tokens_amazon").select("access_token, expires_at").eq("shop_id", SHOP_SVL).maybeSingle();
  if (!tok?.access_token) return json({ ok: false, erro: "conta SVL sem token" }, 500);

  const r = await sp(String(tok.access_token), metodo, caminho, metodo === "GET" ? undefined : (b.corpo ?? {}));
  // operação assíncrona: acompanha até terminar (ou ~18 s)
  let operacao: Record<string, any> | null = null;
  const opId = r.body?.operationId;
  if (opId) {
    const ate = Date.now() + 18000;
    while (Date.now() < ate) {
      await sleep(1500);
      const o = await sp(String(tok.access_token), "GET", `/inbound/fba/2024-03-20/operations/${opId}`);
      operacao = { http: o.status, ...(o.body ?? {}) };
      const st = String(o.body?.operationStatus ?? "");
      if (st && st !== "IN_PROGRESS") break;
    }
  }
  await sb.from("debug_fulfillment").insert({
    modulo: "amazon-inbound-teste", etapa: `${metodo} ${caminho}`.slice(0, 200), status_http: r.status,
    resultado: { corpo: b.corpo ?? null, resposta: r.body, operacao },
  });
  return json({ ok: r.status >= 200 && r.status < 300, http: r.status, resposta: r.body, operacao });
});
