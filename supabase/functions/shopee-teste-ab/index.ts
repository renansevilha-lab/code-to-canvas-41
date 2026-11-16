// Edge Function: shopee-teste-ab v1 (16/nov/2026) — teste A/B da Areia Ottz Pet Mandioca (nov/2026).
//
// ⚠ PUBLICADA NO SLOT `tiny-scope-probe` (o projeto está no limite de funções; o slot era de uso único e já expirou).
//
// Pedido do dono: aplicar na Shopee, por API, as tarefas da marcação (tabela anuncio_marcacao) que têm endpoint.
// v1 = SÓ a prévia (leitura ao vivo). A aplicação entra numa versão seguinte, depois do "aplicar" do dono.
//
//   GET ?modulo=previa  → por tarefa: valor lido AGORA na Shopee × valor novo, e o que pode atrapalhar
//     (o preço de venda é o da PROMOÇÃO — muda pelo discount/update_discount_item, não pelo product/update_price —,
//      fim da promoção, relâmpago, lance sugerido das palavras). Só leitura; aceita a chave publicável.
//
// Lista fechada: só os itens e campanhas do teste. Os anúncios de controle são lidos e não são tocados.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OTTZ = 522186766, SVL = 759046323;

// O plano do teste (o mesmo de anuncio_marcacao). Nada fora desta lista é lido para escrita.
const PLANO = [
  { braco: "T1-A", shop: SVL, item: 41632450730, preco: { de: 65.9, para: 63.9 }, roas: { campanha: 110855297, de: 16.9, para: 17 } },
  { braco: "T1-B", shop: OTTZ, item: 51013400283, preco: { de: 64.9, para: 69.9 }, roas: { campanha: 110376031, de: 13.1, para: 10 } },
  {
    braco: "T2", shop: OTTZ, item: 55713397643, pausar: 110376034,
    criar: {
      lance: 0.6, orcamento: 15, dias: 10,
      termos: ["areia para gato", "areia biodegradável gato", "areia de gato", "areia higiênica para gatos",
        "areia para gato biodegradável", "areia de mandioca para gatos", "areia para gato milho e mandioca",
        "areia gato mandioca", "areia mandioca", "areia para gato mandioca"],
    },
  },
  {
    braco: "T3-A", shop: SVL, item: 48963736980, preco: { de: 38.99, para: 33.9 }, pausar: 110843494,
    titulo: "Areia para Gato Biodegradável Mandioca 4kg Ottz Pet Higiênica para Gatos Natural Anti Odor",
  },
];
const CONTROLE = [{ shop: SVL, item: 53713653947 }, { shop: SVL, item: 49813727245 }, { shop: OTTZ, item: 52763388482 }, { shop: OTTZ, item: 46713408425 }];

function getCredentials(partnerId: number | string) {
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
interface Ctx { shopId: number; partnerId: number; partnerKey: string; accessToken: string }
async function shopeeGet(ctx: Ctx, apiPath: string, params: Record<string, unknown> = {}): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacSha256(`${ctx.partnerId}${apiPath}${ts}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey);
  const url = new URL(`${SHOPEE_HOST}${apiPath}`);
  for (const [k, v] of Object.entries({ partner_id: ctx.partnerId, timestamp: ts, access_token: ctx.accessToken, shop_id: ctx.shopId, sign, ...params })) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString());
  const txt = await resp.text();
  try { return { http: resp.status, ...JSON.parse(txt) }; } catch { return { http: resp.status, _raw: txt.substring(0, 300) }; }
}
// deno-lint-ignore no-explicit-any
async function pegarCtx(sb: any, shopId: number): Promise<Ctx> {
  const { data, error } = await sb.from("oauth_tokens_shopee").select("partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`Token nao encontrado pra shop_id ${shopId}`);
  if (new Date(data.expires_at) < new Date()) throw new Error(`Token shop_id ${shopId} expirado`);
  const c = getCredentials(data.partner_id);
  return { shopId, partnerId: c.partner_id, partnerKey: c.partner_key, accessToken: data.access_token };
}
const dataBR = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const modulo = new URL(req.url).searchParams.get("modulo") || "previa";
  if (modulo !== "previa") return json({ ok: false, erro: "v1 só tem a prévia" }, { status: 400 });
  const sb = createClient(SUPABASE_URL, SRK);
  const ctxs: Record<number, Ctx> = { [OTTZ]: await pegarCtx(sb, OTTZ), [SVL]: await pegarCtx(sb, SVL) };

  // 1) anúncios (teste + controle) e promoções, por loja
  const itens: Record<string, any> = {};
  for (const shop of [OTTZ, SVL]) {
    const ids = [...PLANO.filter((p) => p.shop === shop).map((p) => p.item), ...CONTROLE.filter((c) => c.shop === shop).map((c) => c.item)];
    const base = await shopeeGet(ctxs[shop], "/api/v2/product/get_item_base_info", { item_id_list: ids.join(",") });
    for (const it of (base.response?.item_list ?? []) as any[]) {
      itens[`${shop}:${it.item_id}`] = {
        nome: it.item_name, status: it.item_status, tem_variacao: !!it.has_model,
        preco_venda: it.price_info?.[0]?.current_price ?? null, preco_cheio: it.price_info?.[0]?.original_price ?? null,
      };
    }
    if (base.error) itens[`${shop}:erro`] = `${base.error} ${base.message ?? ""}`;
    await sleep(300);
    const promo = await shopeeGet(ctxs[shop], "/api/v2/product/get_item_promotion", { item_id_list: ids.join(",") });
    for (const s of (promo.response?.success_list ?? []) as any[]) {
      const k = `${shop}:${s.item_id}`;
      itens[k] = itens[k] ?? {};
      itens[k].promocoes = ((s.promotion ?? []) as any[]).map((p) => ({
        tipo: p.promotion_type, id: String(p.promotion_id), model_id: p.model_id ?? 0, situacao: p.promotion_staging,
        inicio: dataBR(p.start_time), fim: dataBR(p.end_time), preco: p.promotion_price_info?.[0]?.promotion_price ?? null,
      }));
    }
    await sleep(300);
  }

  // 2) descontos (Minha Promoção) dos itens com troca de preço: limite por comprador e fim
  const descontos: Record<string, any> = {};
  for (const p of PLANO.filter((x) => x.preco)) {
    const it = itens[`${p.shop}:${p.item}`];
    const d = (it?.promocoes ?? []).find((x: any) => /discount/i.test(String(x.tipo)) && x.situacao === "ongoing");
    if (!d || descontos[d.id]) continue;
    const r = await shopeeGet(ctxs[p.shop], "/api/v2/discount/get_discount", { discount_id: d.id, page_no: 1, page_size: 100 });
    const lista = (r.response?.item_list ?? []) as any[];
    descontos[d.id] = {
      nome: r.response?.discount_name ?? null, status: r.response?.status ?? null,
      inicio: dataBR(r.response?.start_time), fim: dataBR(r.response?.end_time), n_itens: lista.length, mais_paginas: !!r.response?.more,
      itens_do_teste: lista.filter((x) => PLANO.some((q) => q.item === Number(x.item_id))).map((x) => ({
        item_id: String(x.item_id), preco_promo: x.item_promotion_price ?? null, preco_cheio: x.item_original_price ?? null,
        limite_por_comprador: x.purchase_limit ?? null, variacoes: (x.model_list ?? []).length,
      })),
      erro: r.error ? `${r.error} ${r.message ?? ""}` : null,
    };
    await sleep(300);
  }

  // 3) campanhas
  const camps: Record<string, any> = {};
  for (const shop of [OTTZ, SVL]) {
    const ids = PLANO.filter((p) => p.shop === shop).flatMap((p) => [p.roas?.campanha, p.pausar]).filter(Boolean);
    const r = await shopeeGet(ctxs[shop], "/api/v2/ads/get_product_level_campaign_setting_info", { info_type_list: "1,3", campaign_id_list: ids.join(",") });
    for (const c of (r.response?.campaign_list ?? []) as any[]) {
      camps[String(c.campaign_id)] = {
        tipo: c.common_info?.ad_type, lance: c.common_info?.bidding_method, situacao: c.common_info?.campaign_status,
        orcamento: c.common_info?.campaign_budget, roas: c.auto_bidding_info?.roas_target ?? null, itens: c.common_info?.item_id_list,
      };
    }
    await sleep(300);
  }

  // 4) palavras do T2: lance sugerido pela Shopee para cada termo (o lance de R$ 0,60 pode ser recusado como baixo)
  const t2 = PLANO.find((p) => p.braco === "T2")!;
  const palavras: any[] = [];
  for (const termo of t2.criar!.termos) {
    const r = await shopeeGet(ctxs[t2.shop], "/api/v2/ads/get_recommended_keyword_list", { item_id: t2.item, input_keyword: termo });
    const lista = (r.response?.suggested_keyword_list ?? r.response?.suggested_keywords ?? []) as any[];
    const igual = lista.find((k) => String(k.keyword).toLowerCase() === termo.toLowerCase());
    palavras.push({
      termo, achou: !!igual, volume: igual?.search_volume ?? null, lance_sugerido: igual?.suggested_bid ?? null,
      erro: r.error ? `${r.error} ${r.message ?? ""}` : null,
    });
    await sleep(250);
  }

  // 5) linhas da prévia
  const linhas: any[] = [];
  for (const p of PLANO) {
    const it = itens[`${p.shop}:${p.item}`] ?? {};
    const loja = p.shop === OTTZ ? "Ottz" : "Bumi";
    if (p.preco) {
      const d = (it.promocoes ?? []).find((x: any) => /discount/i.test(String(x.tipo)) && x.situacao === "ongoing");
      linhas.push({
        braco: p.braco, loja, item_id: String(p.item), campo: "preço de venda",
        atual: it.preco_venda, planejado_de: p.preco.de, novo: p.preco.para,
        como: d ? `discount/update_discount_item no desconto ${d.id} (o preço cheio ${it.preco_cheio} não muda)` : "product/update_price (sem promoção ativa)",
      });
    }
    if (p.roas) {
      const c = camps[String(p.roas.campanha)] ?? {};
      linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: `ROAS alvo (campanha ${p.roas.campanha})`, atual: c.roas, planejado_de: p.roas.de, novo: p.roas.para, como: "ads/edit_manual_product_ads change_roas_target" });
    }
    if (p.pausar) {
      const c = camps[String(p.pausar)] ?? {};
      linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: `campanha ${p.pausar}`, atual: c.situacao, novo: "paused", como: "ads/edit_manual_product_ads pause" });
    }
    if (p.titulo) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: "título", atual: it.nome, novo: p.titulo, como: "product/update_item (só item_name)" });
    if (p.criar) {
      linhas.push({
        braco: p.braco, loja, item_id: String(p.item), campo: "campanha manual por palavra-chave (nova)", atual: "não existe",
        novo: `${p.criar.termos.length} termos exatos, lance R$ ${p.criar.lance}, R$ ${p.criar.orcamento}/dia, ${p.criar.dias} dias`,
        como: "ads/create_manual_product_ads bidding_method manual + selected_keywords match_type exact",
      });
    }
  }
  return json({
    ok: true, lido_em: new Date().toISOString(), linhas, itens, descontos, campanhas: camps, palavras_t2: palavras,
    controle: CONTROLE.map((c) => ({ loja: c.shop === OTTZ ? "Ottz" : "Bumi", item_id: String(c.item), ...(itens[`${c.shop}:${c.item}`] ?? {}) })),
  });
});
