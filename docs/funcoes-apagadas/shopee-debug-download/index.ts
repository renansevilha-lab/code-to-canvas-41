// Sonda temporaria: mostra a resposta CRUA do download_shipping_document da
// Shopee para 1 pedido (10/set: etiquetas com doc READY baixando 0 bytes).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const HOST = "https://partner.shopeemobile.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

async function hmac(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const orderSn = url.searchParams.get("order_sn") || "";
  const lojaParam = url.searchParams.get("loja") || "ottz";
  const shopId = lojaParam === "svl" ? 759046323 : 522186766;
  const partnerId = lojaParam === "svl" ? 2037384 : 2034179;
  const partnerKey = (lojaParam === "svl" ? Deno.env.get("SHOPEE_PARTNER_KEY_SVL") : Deno.env.get("SHOPEE_PARTNER_KEY") || "")!.trim();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: tok } = await supabase.from("oauth_tokens_shopee").select("access_token").eq("shop_id", shopId).single();
  if (!tok) return new Response("sem token", { status: 401, headers: CORS });

  const chamar = async (path: string, body: unknown, binario = false) => {
    const ts = Math.floor(Date.now() / 1000);
    const sign = await hmac(partnerKey, `${partnerId}${path}${ts}${tok.access_token}${shopId}`);
    const u = `${HOST}${path}?partner_id=${partnerId}&timestamp=${ts}&access_token=${tok.access_token}&shop_id=${shopId}&sign=${sign}`;
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ct = r.headers.get("content-type") || "";
    if (binario && !ct.includes("application/json")) {
      const buf = await r.arrayBuffer();
      return { status: r.status, content_type: ct, bytes: buf.byteLength };
    }
    const txt = await r.text();
    let p: unknown; try { p = JSON.parse(txt); } catch { p = txt.substring(0, 800); }
    return { status: r.status, content_type: ct, payload: p };
  };

  const tipoDoc = url.searchParams.get("tipo") || "THERMAL_AIR_WAYBILL";
  const resultado = await chamar("/api/v2/logistics/get_shipping_document_result", { order_list: [{ order_sn: orderSn, shipping_document_type: tipoDoc }] });
  const download = await chamar("/api/v2/logistics/download_shipping_document", { shipping_document_type: tipoDoc, order_list: [{ order_sn: orderSn }] }, true);
  return new Response(JSON.stringify({ order_sn: orderSn, tipo: tipoDoc, resultado, download }, null, 1), { headers: { ...CORS, "Content-Type": "application/json" } });
});
