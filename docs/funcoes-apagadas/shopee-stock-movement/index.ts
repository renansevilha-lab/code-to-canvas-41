// ============================================================================
// Edge Function: shopee-stock-movement v3
// ----------------------------------------------------------------------------
// Grava a posicao de ABERTURA do Shopee Fulfillment (SBS) numa data passada em
// estoque_fulfillment_historico.
//
// Como funciona: /api/v2/sbs/get_stock_movement devolve, para o periodo pedido,
// o saldo INICIAL (start_qty / start_on_hand_total por armazem) alem dos
// movimentos. Pedindo start_time = D, o start_qty E a posicao de fechamento de
// D-1. Nao ha reconstrucao por subtracao — o numero vem da Shopee.
//
// v3: page_size <= 19 (a API recusa 20+ com INVALID_PARAM "should be less than
//     20"); paginacao ate 40 paginas.
//
// Uso:
//   ?loja=ottz|svl&start_time=2026-08-01&end_time=2026-08-05&data_ref=2026-07-31
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHOPEE_HOST = "https://partner.shopeemobile.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any): number => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

serve(async (req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const inicio = Date.now();
  const TIMEOUT_MS = 48000;

  const lojaParam = url.searchParams.get("loja") || "ottz";
  const shopId = lojaParam === "svl" ? 759046323 : 522186766;
  const startTime = url.searchParams.get("start_time") || "2026-08-01";
  const endTime = url.searchParams.get("end_time") || "2026-08-05";
  const pageSize = url.searchParams.get("page_size") || "19";

  let dataRef = url.searchParams.get("data_ref");
  if (!dataRef) {
    const d = new Date(`${startTime}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    dataRef = d.toISOString().slice(0, 10);
  }

  const path = "/api/v2/sbs/get_stock_movement";

  const { data: tokRow } = await supabase
    .from("oauth_tokens_shopee")
    .select("access_token, shop_id, partner_id")
    .eq("shop_id", shopId)
    .single();

  if (!tokRow?.access_token) {
    return Response.json({ ok: false, erro: `sem token para shop ${shopId}` });
  }

  const partnerId = Number(tokRow.partner_id);
  const partnerKey =
    (partnerId === 2034179
      ? Deno.env.get("SHOPEE_PARTNER_KEY")
      : Deno.env.get("SHOPEE_PARTNER_KEY_SVL")) || "";

  const skuPorModel = new Map<string, string>();
  const skuPorItem = new Map<string, string>();
  {
    const { data: vars } = await supabase.from("shopee_anuncios_variacao")
      .select("model_id, sku").eq("shop_id", shopId).limit(5000);
    for (const v of (vars || [])) if (v.sku) skuPorModel.set(String(v.model_id), String(v.sku));
    const { data: anun } = await supabase.from("shopee_anuncios")
      .select("item_id, sku_pai").eq("shop_id", shopId).limit(5000);
    for (const a of (anun || [])) if (a.sku_pai) skuPorItem.set(String(a.item_id), String(a.sku_pai));
  }

  async function sbsGet(extra: Record<string, string>) {
    const timestamp = Math.floor(Date.now() / 1000);
    const base = `${partnerId}${path}${timestamp}${tokRow.access_token}${shopId}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(base));
    const sign = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const u = new URL(`${SHOPEE_HOST}${path}`);
    u.searchParams.set("partner_id", String(partnerId));
    u.searchParams.set("timestamp", String(timestamp));
    u.searchParams.set("access_token", tokRow.access_token);
    u.searchParams.set("shop_id", String(shopId));
    u.searchParams.set("sign", sign);
    u.searchParams.set("whs_region", "BR");
    u.searchParams.set("start_time", startTime);
    u.searchParams.set("end_time", endTime);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    const r = await fetch(u.toString());
    const txt = await r.text();
    try { return { status: r.status, payload: JSON.parse(txt) }; }
    catch { return { status: r.status, payload: { _raw: txt.substring(0, 400) } }; }
  }

  const erros: string[] = [];
  let pagina = 1, salvos = 0, itensVistos = 0, total = 0, skusComQtd = 0;

  while (pagina <= 40 && Date.now() - inicio < TIMEOUT_MS) {
    const res = await sbsGet({ page_no: String(pagina), page_size: pageSize });
    if (res.payload?.error) {
      erros.push(`${res.payload.error}: ${String(res.payload.message || "").substring(0, 60)}`);
      await supabase.from("debug_fulfillment").insert({
        modulo: "stock-movement", etapa: `${lojaParam}-p${pagina}`,
        status_http: res.status, resultado: res.payload,
      });
      break;
    }
    total = num(res.payload?.response?.total);
    const itens = res.payload?.response?.item_list || [];
    if (itens.length === 0) break;
    itensVistos += itens.length;

    const linhas: any[] = [];
    for (const it of itens) {
      for (const skuInfo of (it.sku_list || [])) {
        const shopModelId = String(skuInfo.shop_sku_list?.[0]?.shop_model_id || "");
        const shopItemId = String(skuInfo.shop_sku_list?.[0]?.shop_item_id || "");
        const skuInterno = skuPorModel.get(shopModelId) || skuPorItem.get(shopItemId) || null;
        const mtsku = String(skuInfo.mtsku_id || skuInfo.model_id || "");
        if (!mtsku) continue;

        const detalhe = {
          start_sellable: num(skuInfo.start_qty?.start_sellable),
          start_reserved: num(skuInfo.start_qty?.start_reserved),
          start_unsellable: num(skuInfo.start_qty?.start_unsellable),
          start_on_hand_total: num(skuInfo.start_qty?.start_on_hand_total),
          barcode: skuInfo.barcode || null,
        };
        if (detalhe.start_on_hand_total > 0) skusComQtd++;

        for (const whs of (skuInfo.whs_list || [])) {
          const onHand = num(whs.start_on_hand_total);
          if (onHand === 0) continue;
          linhas.push({
            data_ref: dataRef,
            marketplace: "shopee",
            shop_id: shopId,
            sku_marketplace: mtsku,
            warehouse: String(whs.whs_id || "BR"),
            sku: skuInterno,
            titulo: [it.item_name, skuInfo.variation].filter(Boolean).join(" - ").substring(0, 200) || null,
            on_hand: onHand,
            detalhe_sku: detalhe,
            origem: `sbs get_stock_movement ${startTime}..${endTime}`,
          });
        }
      }
    }

    const unicas = Array.from(new Map(linhas.map((l) => [`${l.sku_marketplace}|${l.warehouse}`, l])).values());
    if (unicas.length > 0) {
      const { error } = await supabase.from("estoque_fulfillment_historico")
        .upsert(unicas, { onConflict: "data_ref,marketplace,shop_id,sku_marketplace,warehouse" });
      if (error) erros.push(`upsert: ${error.message.substring(0, 80)}`);
      else salvos += unicas.length;
    }

    if (itensVistos >= total) break;
    pagina++;
    await sleep(350);
  }

  return Response.json({
    ok: erros.length === 0, loja: lojaParam, shop_id: shopId,
    data_ref: dataRef, janela: `${startTime}..${endTime}`,
    total_api: total, itens_vistos: itensVistos, paginas: pagina,
    skus_com_saldo: skusComQtd, linhas_salvas: salvos,
    erros: erros.slice(0, 3), tempo_ms: Date.now() - inicio,
  });
});
