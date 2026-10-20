// ml-probe: sondagem SO LEITURA da API do Mercado Livre.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ML = "https://api.mercadolibre.com";

async function tok(supabase: any): Promise<{ token: string; seller: number }> {
  const { data } = await supabase.from("oauth_tokens_ml")
    .select("access_token, user_id").order("atualizado_em", { ascending: false }).limit(1).single();
  return { token: data.access_token, seller: data.user_id };
}

async function call(token: string, path: string, extraHeaders: Record<string,string> = {}) {
  const r = await fetch(`${ML}${path}`, { headers: { Authorization: `Bearer ${token}`, ...extraHeaders } });
  const txt = await r.text();
  let body: any; try { body = JSON.parse(txt); } catch { body = txt.substring(0, 300); }
  return { path, status: r.status, ok: r.ok, body };
}

serve(async (req) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { token, seller } = await tok(supabase);
  const url = new URL(req.url);
  const alvo = url.searchParams.get("alvo") || "ads-advertisers";
  const extra = url.searchParams.get("p") || "";
  const p2 = url.searchParams.get("p2") || "";
  const out: any = { seller };

  if (alvo === "highlights") {
    out.r = await call(token, `/highlights/MLB/category/${extra}`);
  } else if (alvo === "produto") {
    out.r = await call(token, `/products/${extra}`);
  } else if (alvo === "produto-itens") {
    out.r = await call(token, `/products/${extra}/items`);
  } else if (alvo === "item") {
    const r = await call(token, `/items/${extra}?attributes=id,title,price,sold_quantity,available_quantity,date_created,start_time,seller_id,category_id,catalog_product_id`);
    out.r = r;
  } else if (alvo === "item-full") {
    out.r = await call(token, `/items/${extra}`);
  } else if (alvo === "visits") {
    out.r = await call(token, `/items/${extra}/visits/time_window?last=30&unit=day`);
  } else if (alvo === "meus-itens") {
    out.r = await call(token, `/users/${seller}/items/search?limit=5`);
  } else if (alvo === "promos") {
    // Lista de promoções/campanhas disponíveis ao vendedor
    out.r = await call(token, `/seller-promotions/users/${seller}?app_version=v2`);
  } else if (alvo === "promo-itens") {
    // Itens candidatos/participantes de uma promoção. p=promotion_id  p2=promotion_type
    out.r = await call(token, `/seller-promotions/promotions/${extra}/items?promotion_type=${p2}&app_version=v2&limit=25`);
  } else if (alvo === "item-promos") {
    // Promoções aplicáveis a UM item. p=MLBxxxx
    out.r = await call(token, `/seller-promotions/items/${extra}?app_version=v2`);
  } else if (alvo === "listing-prices") {
    // Taxa de venda (comissão) por preço/categoria. p=preco p2=category_id
    out.r = await call(token, `/sites/MLB/listing_prices?price=${extra}&category_id=${p2}&listing_type_id=gold_pro`);
  } else if (alvo === "sale-fee-item") {
    // detalhe do item com sale_terms + shipping
    out.r = await call(token, `/items/${extra}?attributes=id,price,base_price,category_id,listing_type_id,shipping,sale_terms,seller_custom_field`);
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
