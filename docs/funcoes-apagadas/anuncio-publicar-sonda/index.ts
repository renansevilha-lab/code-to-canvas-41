// ============================================================================
// Edge Function: anuncio-publicar-sonda v1 (10/out/2026) — DIAGNÓSTICO, só leitura
// ----------------------------------------------------------------------------
// Estudo de viabilidade (pedido do dono): publicar anúncio DIRETO no marketplace,
// sem passar pelo Tiny. Esta função NÃO cria, altera nem apaga nada em lugar
// nenhum: só consulta o que cada API exige para criar um anúncio (categorias,
// atributos obrigatórios, limites, logística) e confere se os nossos apps têm
// acesso ao módulo de produtos. A única chamada POST é o validador do Mercado
// Livre (/items/validate), que só confere um corpo e não publica.
//   GET ?mkt=shopee|ml|amazon|tiktok   (um por chamada: cabe no tempo)
// Não devolve token nem segredo — só status, contagens e nomes de campo.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chaves = (o: unknown) => (o && typeof o === "object" ? Object.keys(o as object) : null);

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- Shopee
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
function credShopee(partnerId: number | string) {
  const id = String(partnerId);
  if (id === "2034179") return { partner_id: 2034179, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim() };
  if (id === "2037384") return { partner_id: 2037384, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY_SVL") || "").trim() };
  throw new Error(`sem credencial para partner_id ${id}`);
}
async function shopeeGet(c: { shopId: number; partnerId: number; partnerKey: string; token: string }, path: string, params: Record<string, unknown>) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}${c.token}${c.shopId}`);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  for (const [k, v] of Object.entries({ partner_id: c.partnerId, timestamp: ts, access_token: c.token, shop_id: c.shopId, sign, ...params })) {
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString());
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { error: "resposta_nao_json", message: txt.slice(0, 200) }; }
}
const vShopee = (r: any) => (r?.error ? `ERRO ${r.error}: ${String(r.message ?? "").slice(0, 140)}` : "LIBERADO");

async function sondaShopee() {
  const { data: toks } = await sb.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token, expires_at");
  const out: any[] = [];
  for (const t of toks ?? []) {
    const cr = credShopee(t.partner_id);
    const c = { shopId: Number(t.shop_id), partnerId: cr.partner_id, partnerKey: cr.partner_key, token: t.access_token as string };
    const loja: Record<string, unknown> = { shop_id: c.shopId };
    const cat = await shopeeGet(c, "/api/v2/product/get_category", { language: "pt-BR" });
    const lista = (cat?.response?.category_list ?? []) as any[];
    loja.categorias = { veredito: vShopee(cat), total: lista.length, folhas: lista.filter((x) => !x.has_children).length };
    const lim = await shopeeGet(c, "/api/v2/product/get_item_limit", {});
    loja.limites = { veredito: vShopee(lim), resposta: lim?.response ?? null };
    const log = await shopeeGet(c, "/api/v2/logistics/get_channel_list", {});
    const canais = (log?.response?.logistics_channel_list ?? []) as any[];
    loja.logistica = { veredito: vShopee(log), canais_habilitados: canais.filter((x) => x.enabled).map((x) => `${x.logistics_channel_id}:${x.logistics_channel_name}`) };
    // um anúncio nosso de exemplo: quais campos a loja já usa (fiscal, marca, atributos)
    const { data: ex } = await sb.from("shopee_anuncios").select("item_id, categoria_id, nome").eq("shop_id", c.shopId).eq("status", "NORMAL")
      .order("atualizado_em", { ascending: false }).limit(1);
    const item = ex?.[0];
    if (item) {
      const bi = await shopeeGet(c, "/api/v2/product/get_item_base_info", { item_id_list: [item.item_id], need_tax_info: true, need_complaint_policy: true });
      const it = bi?.response?.item_list?.[0];
      loja.anuncio_exemplo = {
        veredito: vShopee(bi), item_id: item.item_id, categoria_id: it?.category_id, campos: chaves(it),
        fiscal: it?.tax_info ?? null, marca: it?.brand ?? null, atributos_preenchidos: (it?.attribute_list ?? []).length,
        logistica: (it?.logistic_info ?? []).map((l: any) => `${l.logistic_id}:${l.logistic_name}${l.enabled ? "" : " (off)"}`),
        dimensao: it?.dimension ?? null, peso: it?.weight ?? null, dias_envio: it?.pre_order ?? null, n_imagens: (it?.image?.image_id_list ?? []).length,
      };
      const catId = Number(it?.category_id ?? item.categoria_id);
      if (catId) {
        const at = await shopeeGet(c, "/api/v2/product/get_attribute_tree", { category_id_list: [catId], language: "pt-BR" });
        const arv = (at?.response?.list?.[0]?.attribute_tree ?? []) as any[];
        loja.atributos_categoria = {
          veredito: vShopee(at), categoria_id: catId, total: arv.length,
          obrigatorios: arv.filter((a) => a.mandatory).map((a) => a.display_attribute_name ?? a.name),
        };
        const br = await shopeeGet(c, "/api/v2/product/get_brand_list", { category_id: catId, status: 1, offset: 0, page_size: 5, language: "pt-BR" });
        loja.marcas_categoria = { veredito: vShopee(br), obrigatoria: br?.response?.is_mandatory ?? null, exemplo: (br?.response?.brand_list ?? []).slice(0, 3) };
        const rec = await shopeeGet(c, "/api/v2/product/category_recommend", { item_name: item.nome });
        loja.sugestao_categoria = { veredito: vShopee(rec), sugeridas: rec?.response?.category_id ?? null };
      }
    }
    out.push(loja);
    await sleep(400);
  }
  return out;
}

// ---------------------------------------------------------------- Mercado Livre
const ML = "https://api.mercadolibre.com";
async function ml(token: string, path: string, init?: RequestInit) {
  const r = await fetch(`${ML}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt.slice(0, 200); }
  return { status: r.status, ok: r.ok, body };
}
async function sondaMl() {
  const { data: toks } = await sb.from("oauth_tokens_ml").select("user_id, access_token, scope, expires_at");
  const out: any[] = [];
  for (const t of toks ?? []) {
    const tk = t.access_token as string;
    const conta: Record<string, unknown> = { user_id: t.user_id, escopo_do_token: t.scope };
    const me = await ml(tk, "/users/me");
    conta.vendedor = { status: me.status, apelido: me.body?.nickname, tags: me.body?.tags, status_lista: me.body?.status?.list, reputacao: me.body?.seller_reputation?.level_id };
    const appId = (tk.match(/^APP_USR-(\d+)-/) ?? [])[1];
    if (appId) {
      const app = await ml(tk, `/applications/${appId}`);
      conta.aplicativo = { status: app.status, nome: app.body?.name, escopos: app.body?.scopes ?? null };
    }
    const { data: ex } = await sb.from("ml_anuncios").select("mlb, titulo").eq("status", "active").order("atualizado_em", { ascending: false }).limit(1);
    const mlb = String(t.user_id) === "1107117809" ? ex?.[0]?.mlb : null;
    if (mlb) {
      const it = await ml(tk, `/items/${mlb}`);
      const b = it.body ?? {};
      conta.anuncio_exemplo = {
        status: it.status, mlb, categoria: b.category_id, tipo_anuncio: b.listing_type_id, catalogo: b.catalog_listing, produto_catalogo: b.catalog_product_id,
        envio: { modo: b.shipping?.mode, logistica: b.shipping?.logistic_type, frete_gratis: b.shipping?.free_shipping },
        atributos: (b.attributes ?? []).length, fotos: (b.pictures ?? []).length, variacoes: (b.variations ?? []).length,
        canais: b.channels, tags: b.tags, tem_family: b.family_name ?? null, user_product_id: b.user_product_id ?? null,
      };
      const pred = await ml(tk, `/sites/MLB/domain_discovery/search?limit=3&q=${encodeURIComponent(String(b.title ?? ex?.[0]?.titulo ?? "").slice(0, 80))}`);
      conta.sugestao_categoria = { status: pred.status, sugeridas: Array.isArray(pred.body) ? pred.body.map((p: any) => `${p.category_id} ${p.domain_name ?? ""}`) : pred.body };
      if (b.category_id) {
        const at = await ml(tk, `/categories/${b.category_id}/attributes`);
        const l = Array.isArray(at.body) ? at.body : [];
        conta.atributos_categoria = {
          status: at.status, total: l.length,
          obrigatorios: l.filter((a: any) => a.tags?.required || a.tags?.catalog_required).map((a: any) => a.id),
          condicionais: l.filter((a: any) => a.tags?.conditional_required).map((a: any) => a.id),
        };
        const cat = await ml(tk, `/categories/${b.category_id}`);
        conta.regras_categoria = {
          status: cat.status, caminho: (cat.body?.path_from_root ?? []).map((p: any) => p.name).join(" > "),
          titulo_max: cat.body?.settings?.max_title_length, fotos_max: cat.body?.settings?.max_pictures_per_item,
          catalogo: cat.body?.settings?.catalog_domain, modos_envio: cat.body?.settings?.shipping_modes, tipo_listagem: cat.body?.settings?.listing_allowed,
        };
        // VALIDADOR do ML: confere o corpo de um anúncio SEM publicar (204 = poderia publicar)
        const corpo = {
          title: String(b.title ?? "").slice(0, 60), category_id: b.category_id, price: b.price, currency_id: "BRL", available_quantity: 1,
          buying_mode: "buy_it_now", condition: "new", listing_type_id: b.listing_type_id,
          pictures: (b.pictures ?? []).slice(0, 2).map((p: any) => ({ source: p.secure_url ?? p.url })),
          attributes: (b.attributes ?? []).filter((a: any) => a.value_name).map((a: any) => ({ id: a.id, value_name: a.value_name })),
          shipping: { mode: b.shipping?.mode, free_shipping: b.shipping?.free_shipping },
        };
        const val = await ml(tk, "/items/validate", { method: "POST", body: JSON.stringify(corpo) });
        conta.validador = { status: val.status, veredito: val.status === 204 ? "corpo aceito (poderia publicar)" : "recusado", detalhe: val.body?.cause ?? val.body?.message ?? null };
      }
    }
    out.push(conta);
  }
  return out;
}

// ---------------------------------------------------------------- Amazon
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
async function sp(token: string, path: string, params: Record<string, string>) {
  const url = new URL(`${SPAPI}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let t = 0; t < 2; t++) {
    const r = await fetch(url.toString(), { headers: { "x-amz-access-token": token, Accept: "application/json" } });
    const txt = await r.text();
    if (r.status === 429 && t === 0) { await sleep(3000); continue; }
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = null; }
    const erros = Array.isArray(body?.errors) ? body.errors.map((e: any) => `${e.code ?? "?"}: ${String(e.message ?? "").slice(0, 140)}`) : [];
    return { status: r.status, ok: r.ok, erros, body };
  }
  return { status: 429, ok: false, erros: ["rate limit"], body: null as any };
}
const vSp = (r: { status: number; ok: boolean }) => (r.ok ? "LIBERADO" : r.status === 403 ? "SEM PERMISSÃO (papel do app)" : `erro ${r.status}`);
async function sondaAmazon() {
  const { data: contas } = await sb.from("oauth_tokens_amazon").select("seller_id, empresa, shop_id, access_token, marketplace_id, merchant_token");
  const out: any[] = [];
  for (const c of contas ?? []) {
    const tk = c.access_token as string; const mkt = c.marketplace_id || MKT_BR;
    const conta: Record<string, unknown> = { empresa: c.empresa, shop_id: c.shop_id, tem_merchant_token: Boolean(c.merchant_token) };
    const tipos = await sp(tk, "/definitions/2020-09-01/productTypes", { marketplaceIds: mkt, keywords: "areia gato", locale: "pt_BR" });
    conta.tipos_de_produto = { veredito: vSp(tipos), erros: tipos.erros, encontrados: (tipos.body?.productTypes ?? []).slice(0, 8).map((p: any) => p.name) };
    await sleep(500);
    if (c.merchant_token) {
      const lista = await sp(tk, `/listings/2021-08-01/items/${encodeURIComponent(c.merchant_token)}`, { marketplaceIds: mkt, pageSize: "3" });
      const sku = lista.body?.items?.[0]?.sku ? String(lista.body.items[0].sku) : null;
      if (sku) {
        await sleep(500);
        const um = await sp(tk, `/listings/2021-08-01/items/${encodeURIComponent(c.merchant_token)}/${encodeURIComponent(sku)}`,
          { marketplaceIds: mkt, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability", issueLocale: "pt_BR" });
        const s = um.body?.summaries?.[0] ?? {};
        const pt = s.productType as string | undefined;
        conta.anuncio_exemplo = {
          veredito: vSp(um), sku, asin: s.asin, tipo_de_produto: pt, status: s.status, condicao: s.conditionType,
          atributos_preenchidos: chaves(um.body?.attributes), pendencias: (um.body?.issues ?? []).slice(0, 5).map((i: any) => `${i.severity}: ${String(i.message).slice(0, 100)}`),
        };
        if (pt) {
          await sleep(500);
          const def = await sp(tk, `/definitions/2020-09-01/productTypes/${encodeURIComponent(pt)}`, { marketplaceIds: mkt, requirements: "LISTING", locale: "pt_BR" });
          conta.definicao_do_tipo = {
            veredito: vSp(def), erros: def.erros, tipo: pt, grupos: chaves(def.body?.propertyGroups),
            tem_esquema: Boolean(def.body?.schema?.link?.resource), requisitos: def.body?.requirements, requisitos_aplicados: def.body?.requirementsEnforced,
          };
          const esquema = def.body?.schema?.link?.resource as string | undefined;
          if (esquema) {
            const r = await fetch(esquema);
            const j = r.ok ? await r.json().catch(() => null) : null;
            conta.esquema = { status: r.status, propriedades: j?.properties ? Object.keys(j.properties).length : null, obrigatorias: j?.required ?? null };
          }
        }
      }
    }
    await sleep(500);
    const cat = await sp(tk, "/catalog/2022-04-01/items", { marketplaceIds: mkt, keywords: "areia higienica gato", pageSize: "3", includedData: "summaries" });
    conta.catalogo_busca = { veredito: vSp(cat), erros: cat.erros, exemplos: (cat.body?.items ?? []).slice(0, 3).map((i: any) => `${i.asin} ${String(i.summaries?.[0]?.itemName ?? "").slice(0, 50)}`) };
    await sleep(500);
    const rest = await sp(tk, "/listings/2021-08-01/restrictions", { asin: (cat.body?.items?.[0]?.asin ?? "B000000000"), sellerId: c.merchant_token || c.seller_id, marketplaceIds: mkt, conditionType: "new_new" });
    conta.restricoes = { veredito: vSp(rest), erros: rest.erros, restricoes: (rest.body?.restrictions ?? []).length };
    out.push(conta);
  }
  return out;
}

// ---------------------------------------------------------------- TikTok Shop
const TT_KEY = (Deno.env.get("TIKTOK_APP_KEY") || "").trim();
const TT_SECRET = (Deno.env.get("TIKTOK_APP_SECRET") || "").trim();
const TT_HOST = "https://open-api.tiktokglobalshop.com";
async function tt(token: string, path: string, params: Record<string, string>) {
  const p: Record<string, string> = { app_key: TT_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const ks = Object.keys(p).filter((k) => k !== "sign" && k !== "access_token").sort();
  p.sign = await hmacHex(TT_SECRET, TT_SECRET + path + ks.map((k) => k + p[k]).join("") + TT_SECRET);
  const url = new URL(TT_HOST + path);
  for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { headers: { "x-tts-access-token": token, "Content-Type": "application/json" } });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt.replace(/:\s*(\d{16,})/g, ': "$1"')); } catch { j = null; }
  return { http: r.status, code: j?.code, message: j?.message, data: j?.data ?? null };
}
const vTt = (r: { http: number; code: unknown; message: unknown }) => (r.http === 200 && Number(r.code) === 0 ? "LIBERADO" : `ERRO http ${r.http} code ${r.code}: ${String(r.message ?? "").slice(0, 140)}`);
async function sondaTiktok() {
  const { data: ls } = await sb.from("tiktok_lojas").select("shop_id::text, shop_cipher, open_id");
  const { data: tks } = await sb.from("oauth_tokens_tiktok").select("open_id, access_token");
  const tok = new Map((tks ?? []).map((t: any) => [t.open_id, t.access_token]));
  const out: any[] = [];
  for (const l of ls ?? []) {
    const token = tok.get((l as any).open_id) as string | undefined;
    const loja: Record<string, unknown> = { shop_id: (l as any).shop_id };
    if (!token) { loja.erro = "sem token"; out.push(loja); continue; }
    const base = { shop_cipher: (l as any).shop_cipher as string };
    const cats = await tt(token, "/product/202309/categories", { ...base, locale: "pt-BR" });
    const lista = (cats.data?.categories ?? []) as any[];
    loja.categorias = { veredito: vTt(cats), total: lista.length, folhas: lista.filter((c) => c.is_leaf).length };
    const { data: ex } = await sb.from("tiktok_produtos").select("product_id::text, titulo").order("atualizado_em", { ascending: false }).limit(1);
    const pid = (ex?.[0] as any)?.product_id;
    if (pid) {
      const pr = await tt(token, `/product/202309/products/${pid}`, base);
      const d = pr.data ?? {};
      const folha = (d.category_chains ?? []).find((c: any) => c.is_leaf) ?? (d.category_chains ?? []).slice(-1)[0];
      loja.anuncio_exemplo = {
        veredito: vTt(pr), product_id: pid, campos: chaves(d), categoria: folha ? `${folha.id} ${folha.local_name ?? ""}` : null,
        atributos: (d.product_attributes ?? []).length, fotos: (d.main_images ?? []).length, marca: d.brand ?? null,
        peso: d.package_weight ?? null, dimensoes: d.package_dimensions ?? null, certificacoes: (d.certifications ?? []).length,
        skus: (d.skus ?? []).length, deposito: (d.skus?.[0]?.inventory ?? []).map((i: any) => i.warehouse_id),
      };
      if (folha?.id) {
        const at = await tt(token, `/product/202309/categories/${folha.id}/attributes`, { ...base, locale: "pt-BR" });
        const la = (at.data?.attributes ?? []) as any[];
        loja.atributos_categoria = { veredito: vTt(at), total: la.length, obrigatorios: la.filter((a) => a.is_requried || a.is_required).map((a) => a.name) };
        const ru = await tt(token, `/product/202309/categories/${folha.id}/rules`, base);
        loja.regras_categoria = { veredito: vTt(ru), regras: ru.data ?? null };
      }
    }
    const br = await tt(token, "/product/202309/brands", { ...base, page_size: "5" });
    loja.marcas = { veredito: vTt(br), total: br.data?.total_count ?? null, exemplo: (br.data?.brands ?? []).slice(0, 3).map((b: any) => `${b.name} (${b.authorized_status ?? b.brand_status ?? "?"})`) };
    const wh = await tt(token, "/logistics/202309/warehouses", base);
    loja.depositos = { veredito: vTt(wh), lista: (wh.data?.warehouses ?? []).map((w: any) => `${w.id} ${w.name} ${w.type ?? ""} ${w.effect_status ?? ""}`) };
    out.push(loja);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const mkt = new URL(req.url).searchParams.get("mkt") || "";
  try {
    if (mkt === "shopee") return json({ mkt, sondado_em: new Date().toISOString(), lojas: await sondaShopee() });
    if (mkt === "ml") return json({ mkt, sondado_em: new Date().toISOString(), contas: await sondaMl() });
    if (mkt === "amazon") return json({ mkt, sondado_em: new Date().toISOString(), contas: await sondaAmazon() });
    if (mkt === "tiktok") return json({ mkt, sondado_em: new Date().toISOString(), lojas: await sondaTiktok() });
    return json({ erro: "use ?mkt=shopee|ml|amazon|tiktok" }, 400);
  } catch (e) {
    return json({ mkt, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
