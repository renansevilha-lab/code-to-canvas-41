// ============================================================================
// Edge Function: fulfillment-teste v6 (TEMPORARIA - diagnostico de etiqueta)
// modulo=shopee-doc-diag
// HIPOTESE: o pedido tem PACOTE proprio (package_number OFG...). A Shopee exige
// package_number no create_shipping_document; sem ele devolve
// logistics.tracking_number_invalid mesmo havendo tracking no pedido.
// Etapas:
//  1. get_order_detail (package_list, order_status, logistics)
//  2. create_shipping_document COM package_number
//  3. get_shipping_document_result COM package_number
// Grava em debug_fulfillment (modulo='shopee-pkg').
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPEE_HOST = "https://partner.shopeemobile.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hmac(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  if (url.searchParams.get("modulo") !== "shopee-doc-diag") {
    return Response.json({ modulos: ["shopee-doc-diag"] });
  }

  const shopId = parseInt(url.searchParams.get("shop_id") || "759046323", 10);
  const orderSn = url.searchParams.get("order_sn") || "";
  const tipoDoc = url.searchParams.get("tipo") || "THERMAL_AIR_WAYBILL";

  const { data: tok } = await supabase.from("oauth_tokens_shopee")
    .select("access_token, partner_id").eq("shop_id", shopId).single();
  if (!tok) return Response.json({ erro: "sem token" }, { status: 500 });
  const partnerId = Number(tok.partner_id);
  const partnerKey = (partnerId === 2034179
    ? Deno.env.get("SHOPEE_PARTNER_KEY")
    : Deno.env.get("SHOPEE_PARTNER_KEY_SVL")) || "";

  async function grava(etapa: string, status: number | null, resultado: any) {
    await supabase.from("debug_fulfillment").insert({
      modulo: "shopee-pkg", etapa: `${orderSn}|${etapa}`, status_http: status, resultado,
    });
  }

  async function chamar(path: string, metodo: "GET" | "POST", extra: any) {
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(partnerKey.trim(), `${partnerId}${path}${ts}${tok.access_token}${shopId}`);
    const u = new URL(`${SHOPEE_HOST}${path}`);
    u.searchParams.set("partner_id", String(partnerId));
    u.searchParams.set("timestamp", String(ts));
    u.searchParams.set("access_token", tok.access_token);
    u.searchParams.set("shop_id", String(shopId));
    u.searchParams.set("sign", sign);
    let r: Response;
    if (metodo === "GET") {
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
      r = await fetch(u.toString());
    } else {
      r = await fetch(u.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extra),
      });
    }
    const txt = await r.text();
    let p: any; try { p = JSON.parse(txt); } catch { p = { _raw: txt.substring(0, 600) }; }
    return { status: r.status, payload: p };
  }

  // 1. detalhe do pedido com a lista de PACOTES
  const det = await chamar("/api/v2/order/get_order_detail", "GET", {
    order_sn_list: orderSn,
    response_optional_fields: "package_list,order_status,shipping_carrier,recipient_address",
  });
  const pedido = det.payload?.response?.order_list?.[0];
  const pacotes = pedido?.package_list || [];
  await grava("1-order_detail_pacotes", det.status, {
    order_status: pedido?.order_status,
    shipping_carrier: pedido?.shipping_carrier,
    qtd_pacotes: pacotes.length,
    pacotes: pacotes.map((p: any) => ({
      package_number: p.package_number,
      logistics_status: p.logistics_status,
      shipping_carrier: p.shipping_carrier,
 allow_self_design_logistic: p.allow_self_design_logistic,
    })),
    erro_api: det.payload?.error || null,
  });
  await sleep(500);

  const pkg = pacotes[0]?.package_number || null;
  if (!pkg) {
    await grava("2-sem-package", null, { nota: "pedido nao tem package_list" });
    return Response.json({ ok: true, order_sn: orderSn, package_number: null });
  }

  // 2. create COM package_number
  const cre = await chamar("/api/v2/logistics/create_shipping_document", "POST", {
    order_list: [{ order_sn: orderSn, package_number: pkg, shipping_document_type: tipoDoc }],
  });
  await grava("2-create_COM_package", cre.status, cre.payload);
  await sleep(3000);

  // 3. result COM package_number
  const res = await chamar("/api/v2/logistics/get_shipping_document_result", "POST", {
    order_list: [{ order_sn: orderSn, package_number: pkg, shipping_document_type: tipoDoc }],
  });
  await grava("3-result_COM_package", res.status, res.payload);

  return Response.json({ ok: true, order_sn: orderSn, package_number: pkg });
});