import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function hmac(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sPost(path: string, pid: number, pkey: string, tok: string, sid: number, body: any, bin = false) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmac(pkey, `${pid}${path}${ts}${tok}${sid}`);
  const u = new URL(`${SHOPEE_HOST}${path}`);
  u.searchParams.set("partner_id", String(pid)); u.searchParams.set("timestamp", String(ts));
  u.searchParams.set("access_token", tok); u.searchParams.set("shop_id", String(sid)); u.searchParams.set("sign", sign);
  const r = await fetch(u.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (bin) {
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) { const t = await r.text(); let p: any; try { p = JSON.parse(t); } catch { p = { _raw: t.slice(0,300) }; } return { status: r.status, json: p, bytes: null, ct }; }
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, json: null, bytes: b, ct };
  }
  const t = await r.text(); let p: any; try { p = JSON.parse(t); } catch { p = { _raw: t.slice(0,300) }; }
  return { status: r.status, payload: p };
}

serve(async (req: Request) => {
  const sb = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  const sn = url.searchParams.get("sn") || "";
  const shopId = 522186766, pid = 2034179;
  const pkey = (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim();
  const tipoDoc = "THERMAL_AIR_WAYBILL";
  const log = async (etapa: string, detalhe: string) => { await sb.from("debug_etiqueta").insert({ order_sn: sn, etapa, detalhe: detalhe.slice(0, 900) }); };

  const { data: tok } = await sb.from("oauth_tokens_shopee").select("access_token").eq("shop_id", shopId).single();
  const accessToken = tok?.access_token || "";

  // CREATE SEM tracking_number (correcao)
  const cr = await sPost("/api/v2/logistics/create_shipping_document", pid, pkey, accessToken, shopId, {
    order_list: [{ order_sn: sn, shipping_document_type: tipoDoc }],
  });
  await log("create_sem_tracking", JSON.stringify(cr.payload?.response || cr.payload));

  let ready = false;
  for (let i = 0; i < 8 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const rr = await sPost("/api/v2/logistics/get_shipping_document_result", pid, pkey, accessToken, shopId, {
      order_list: [{ order_sn: sn, shipping_document_type: tipoDoc }],
    });
    const st = (rr.payload?.response?.result_list || [])[0]?.status;
    if (st === "READY") ready = true;
  }
  await log("ready", ready ? "SIM" : "NAO");

  if (ready) {
    const dl = await sPost("/api/v2/logistics/download_shipping_document", pid, pkey, accessToken, shopId, {
      shipping_document_type: tipoDoc, order_list: [{ order_sn: sn }],
    }, true);
    if (dl.bytes && dl.bytes.length > 0 && dl.bytes[0] === 0x50 && dl.bytes[1] === 0x4b) {
      try {
        const arq = unzipSync(dl.bytes);
        const nomes = Object.keys(arq);
        const alvo = nomes.find((n) => n.toLowerCase().endsWith(".txt")) || nomes[0];
        const zpl = alvo ? new TextDecoder().decode(arq[alvo]) : "";
        await log("sucesso", `zpl_len=${zpl.length} head=${zpl.slice(0,30)}`);
      } catch (e) { await log("unzip_erro", (e as Error).message); }
    } else {
      await log("download_falhou", `bytes=${dl.bytes?.length ?? 0} json=${dl.json ? JSON.stringify(dl.json) : "-"}`);
    }
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
