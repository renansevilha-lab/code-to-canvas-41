// ============================================================================
// Edge Function: shopee-catalogo-itens v2 (09/out/2026; v1 em 06/out/2026)
// Relê do catálogo Shopee SÓ os anúncios pedidos e atualiza o espelho
// (shopee_anuncios + shopee_anuncios_variacao) — para a tela de Promoções
// Shopee mostrar na hora o SKU/foto alterados no Seller Center, sem esperar o
// catálogo noturno. MESMO mapeamento de colunas do shopee-sync-ads
// ?modulo=catalogo (v66): base_info → shopee_anuncios; get_model_list →
// shopee_anuncios_variacao (nome_variacao = tier_index "0-1", como lá).
// Só LÊ a Shopee; só grava o nosso espelho (upsert, nunca apaga).
//
//   POST ?shop_id=X   body {item_ids:[...]}   (até 30 por chamada)
//   → { processados, pendentes[] (não deu tempo — reenviar), anuncios, variacoes, erros }
//   v2: GET|POST ?modulo=recentes&shop_id=X[&dias=3]
//   → { item_ids[] } = anúncios criados/alterados na Shopee nos últimos N dias
//     (get_item_list por update_time, NORMAL/UNLIST) que NÃO estão no espelho ou
//     estão desatualizados. O front relê esses pelo modo normal. Motivo: produto
//     recém-cadastrado não aparecia no "Adicionar produtos" até o catálogo noturno.
// Exige JWT de usuário logado (ou service role), como o shopee-promocoes.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MAX_ITENS = 30;
const ORCAMENTO_MS = 20000;
const EMPRESA: Record<string, string> = { "522186766": "Ottz Pet", "759046323": "SVL Store" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(b: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getCredentials(partnerId: number | string): { partner_id: number; partner_key: string } {
  const id = String(partnerId);
  if (id === "2034179") return { partner_id: 2034179, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim() };
  if (id === "2037384") return { partner_id: 2037384, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY_SVL") || "").trim() };
  throw new Error(`Credenciais nao encontradas pra partner_id ${id}`);
}
async function hmacSha256(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
interface Ctx { shopId: number; partnerId: number; partnerKey: string; accessToken: string; }
async function shopeeGet(ctx: Ctx, apiPath: string, params: Record<string, unknown>): Promise<any> {
  let ultimo: any = null;
  for (let t = 0; t < 3; t++) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await hmacSha256(`${ctx.partnerId}${apiPath}${timestamp}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey);
    const url = new URL(`${SHOPEE_HOST}${apiPath}`);
    url.searchParams.set("partner_id", String(ctx.partnerId));
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("access_token", ctx.accessToken);
    url.searchParams.set("shop_id", String(ctx.shopId));
    url.searchParams.set("sign", sign);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x));
      else url.searchParams.set(k, String(v));
    }
    const resp = await fetch(url.toString());
    const txt = await resp.text();
    let p: any; try { p = JSON.parse(txt); } catch { p = { _raw: txt.substring(0, 500) }; }
    if (!String(p?.error || "").includes("rate_limit")) return p;
    ultimo = p; await sleep(1500 * (t + 1));
  }
  return ultimo;
}

/** v2: anúncios criados/alterados na Shopee nos últimos `dias` que o espelho não tem (ou tem velho). */
async function recentes(supabase: ReturnType<typeof createClient>, ctx: Ctx, dias: number) {
  const agora = Math.floor(Date.now() / 1000);
  const de = agora - dias * 86400;
  const vistos = new Map<number, number>(); // item_id → update_time
  const erros: string[] = [];
  let offset = 0;
  const inicio = Date.now();
  for (let pg = 0; pg < 20; pg++) {
    if (Date.now() - inicio > ORCAMENTO_MS) { erros.push("tempo esgotado na listagem — rode de novo"); break; }
    const r = await shopeeGet(ctx, "/api/v2/product/get_item_list", {
      offset, page_size: 100, update_time_from: de, update_time_to: agora, item_status: ["NORMAL", "UNLIST"],
    });
    if (r?.error) { erros.push(`get_item_list: ${r.error} ${r.message ?? ""}`.trim()); break; }
    for (const it of (r?.response?.item ?? []) as any[]) vistos.set(Number(it.item_id), Number(it.update_time ?? 0));
    if (!r?.response?.has_next_page) break;
    offset = Number(r.response.next_offset ?? offset + 100);
  }
  const ids = [...vistos.keys()];
  const doEspelho = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("shopee_anuncios").select("item_id, atualizado_em")
      .eq("shop_id", ctx.shopId).in("item_id", ids.slice(i, i + 200));
    if (error) { erros.push(`espelho: ${error.message.substring(0, 80)}`); continue; }
    for (const a of (data ?? []) as any[]) doEspelho.set(Number(a.item_id), new Date(a.atualizado_em).getTime() / 1000);
  }
  const alvo = ids
    .filter((id) => !doEspelho.has(id) || (doEspelho.get(id)! < (vistos.get(id) ?? 0)))
    .sort((a, b) => (vistos.get(b) ?? 0) - (vistos.get(a) ?? 0))
    .slice(0, 300);
  return {
    shop_id: ctx.shopId, dias, alterados_na_shopee: ids.length,
    novos: alvo.filter((id) => !doEspelho.has(id)).length, item_ids: alvo, erros,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let role = "";
  try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = ""; }
  if (bearer !== SRK && role !== "authenticated" && role !== "service_role") {
    return json({ erro: "faça login no app (sessão de usuário exigida)" }, { status: 401 });
  }
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const modulo = url.searchParams.get("modulo") || body?.modulo || "";
  const shopId = Number(url.searchParams.get("shop_id") || body?.shop_id || 0);
  if (!EMPRESA[String(shopId)]) return json({ erro: "shop_id inválido" }, { status: 400 });

  const supabase = createClient(SUPABASE_URL, SRK);
  const { data: tok, error: et } = await supabase.from("oauth_tokens_shopee")
    .select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (et || !tok) return json({ erro: `Token nao encontrado pra shop_id ${shopId}` }, { status: 401 });
  if (new Date(tok.expires_at) < new Date()) return json({ erro: `Token shop_id ${shopId} expirado` }, { status: 401 });
  const creds = getCredentials(tok.partner_id);
  const ctx: Ctx = { shopId: Number(tok.shop_id), partnerId: creds.partner_id, partnerKey: creds.partner_key, accessToken: tok.access_token };

  if (modulo === "recentes") {
    const dias = Math.min(14, Math.max(1, Number(url.searchParams.get("dias") || body?.dias || 3)));
    return json(await recentes(supabase, ctx, dias));
  }

  const brutos: unknown[] = Array.isArray(body?.item_ids) ? body.item_ids : String(url.searchParams.get("item_ids") || "").split(",");
  const ids = [...new Set(brutos.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  if (ids.length === 0) return json({ erro: "informe item_ids" }, { status: 400 });
  if (ids.length > MAX_ITENS) return json({ erro: `no máximo ${MAX_ITENS} anúncios por chamada` }, { status: 400 });

  const inicio = Date.now();
  const erros: string[] = [];
  const base = await shopeeGet(ctx, "/api/v2/product/get_item_base_info", { item_id_list: ids.join(","), need_tax_info: false, need_complaint_policy: false });
  if (base?.error) return json({ erro: `base_info: ${base.error} ${base.message ?? ""}`.trim() }, { status: 502 });
  const itens = (base?.response?.item_list ?? []) as any[];
  const agora = () => new Date().toISOString();

  const anuncios = itens.map((it) => {
    const precoInfo = it.price_info?.[0] || {};
    return {
      item_id: it.item_id, shop_id: ctx.shopId, empresa: EMPRESA[String(ctx.shopId)], nome: it.item_name || null,
      status: it.item_status || null, sku_pai: it.item_sku || null, tem_variacao: it.has_model === true,
      preco_min: precoInfo.current_price ?? null, preco_max: precoInfo.original_price ?? null,
      estoque_total: it.stock_info_v2?.summary_info?.total_available_stock ?? null,
      categoria_id: it.category_id ?? null, imagem_url: it.image?.image_url_list?.[0] || null,
      views: it.view ?? null, likes: it.like_count ?? null, vendas: it.sale ?? null, rating: it.rating_star ?? null,
      criado_em_shopee: it.create_time ? new Date(it.create_time * 1000).toISOString() : null,
      atualizado_em: agora(),
    };
  });

  // variações: get_model_list por anúncio, 3 de cada vez, dentro do orçamento
  const comVar = itens.filter((it) => it.has_model === true).map((it) => Number(it.item_id));
  const variacoes: any[] = [];
  const feitos = new Set<number>(itens.filter((it) => it.has_model !== true).map((it) => Number(it.item_id)));
  for (let i = 0; i < comVar.length; i += 3) {
    if (Date.now() - inicio > ORCAMENTO_MS) break;
    const lote = comVar.slice(i, i + 3);
    const rs = await Promise.all(lote.map((id) => shopeeGet(ctx, "/api/v2/product/get_model_list", { item_id: id })));
    rs.forEach((rm, k) => {
      const itemId = lote[k];
      if (rm?.error) { erros.push(`model_list ${itemId}: ${rm.error}`); return; }
      for (const m of (rm?.response?.model ?? []) as any[]) {
        const p = m.price_info?.[0] || {};
        variacoes.push({
          model_id: m.model_id, item_id: itemId, shop_id: ctx.shopId, sku: m.model_sku || null,
          nome_variacao: (m.tier_index || []).join("-") || null, preco: p.current_price ?? null,
          preco_original: p.original_price ?? null, estoque: m.stock_info_v2?.summary_info?.total_available_stock ?? null,
          atualizado_em: agora(),
        });
      }
      feitos.add(itemId);
    });
    await sleep(150);
  }

  // grava só os anúncios cujas variações foram lidas (o resto volta em `pendentes`)
  const anunciosOk = anuncios.filter((a) => feitos.has(Number(a.item_id)));
  if (anunciosOk.length) {
    const { error } = await supabase.from("shopee_anuncios").upsert(anunciosOk, { onConflict: "shop_id,item_id" });
    if (error) erros.push(`upsert anuncios: ${error.message.substring(0, 80)}`);
  }
  if (variacoes.length) {
    const { error } = await supabase.from("shopee_anuncios_variacao").upsert(variacoes, { onConflict: "shop_id,item_id,model_id" });
    if (error) erros.push(`upsert variacoes: ${error.message.substring(0, 80)}`);
  }
  const lidosShopee = new Set(itens.map((it) => Number(it.item_id)));
  return json({
    shop_id: ctx.shopId,
    processados: anunciosOk.length,
    pendentes: ids.filter((id) => lidosShopee.has(id) && !feitos.has(id)),
    nao_encontrados: ids.filter((id) => !lidosShopee.has(id)),
    anuncios: anunciosOk.length, variacoes: variacoes.length, tempo_ms: Date.now() - inicio, erros: erros.slice(0, 10),
  });
});
