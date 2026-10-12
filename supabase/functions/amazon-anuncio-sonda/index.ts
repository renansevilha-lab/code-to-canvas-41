// ============================================================================
// Edge Function: amazon-anuncio-sonda v1 (12/out/2026) — IA · Anúncios
// ----------------------------------------------------------------------------
// DIAGNÓSTICO do envio de anúncio para a Amazon (SP-API, Listings Items). NÃO altera nada:
//  - lê o anúncio do SKU na conta (GET listings item);
//  - ensaia a atualização com `mode=VALIDATION_PREVIEW` (a Amazon só valida, não aplica).
// GET ?conta=ottz|svl&sku=15819[&titulo=...][&foto=<url>]
// GET ?conta=ottz&sku=14560&busca=texto  -> o produto ja existe no catalogo da Amazon? podemos vender nele?
//   sem `titulo`: o ensaio reenvia o MESMO título que já está lá (só para ver o formato da resposta).
// Sem dados sensíveis na resposta (nenhum token).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const SHOP: Record<string, number> = { ottz: 900001, svl: 900002 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sp(token: string, metodo: string, path: string, params: Record<string, string>, corpo?: unknown) {
  const url = new URL(`${SPAPI}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: metodo,
    headers: { "x-amz-access-token": token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { bruto: txt.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const conta = u.searchParams.get("conta") === "svl" ? "svl" : "ottz";
  const sku = (u.searchParams.get("sku") || "").trim();
  if (!sku) return json({ erro: "informe ?sku=" }, 400);
  try {
    const { data: tk } = await sb.from("oauth_tokens_amazon").select("access_token, expires_at, merchant_token, marketplace_id").eq("shop_id", SHOP[conta]).maybeSingle();
    if (!tk) return json({ erro: `conta ${conta} da Amazon não conectada` }, 400);
    const out: Record<string, unknown> = { conta, sku, token_valido_ate: tk.expires_at, tem_merchant_token: Boolean(tk.merchant_token) };
    if (!tk.merchant_token) return json({ ...out, erro: "falta o código de vendedor (merchant token) desta conta" });
    const mkt = tk.marketplace_id || MKT_BR; const seller = String(tk.merchant_token); const token = String(tk.access_token);

    // ?busca=texto : o produto JA existe no catalogo da Amazon? (so leitura) + podemos vender nele? + tipo de produto sugerido
    const busca = (u.searchParams.get("busca") || "").trim();
    if (busca) {
      const cat = await sp(token, "GET", "/catalog/2022-04-01/items", { marketplaceIds: mkt, keywords: busca, pageSize: "8", includedData: "summaries,identifiers" });
      const itens = ((cat.body?.items ?? []) as any[]).map((i) => ({
        asin: i.asin, titulo: String(i.summaries?.[0]?.itemName ?? "").slice(0, 110), marca: i.summaries?.[0]?.brand ?? null, tipo: i.summaries?.[0]?.productType ?? null,
        ean: ((i.identifiers?.[0]?.identifiers ?? []) as any[]).filter((x) => /EAN|GTIN|UPC/.test(String(x.identifierType))).map((x) => x.identifier).slice(0, 2),
      }));
      const restricoes: any[] = [];
      for (const it of itens.slice(0, 4)) {
        const r = await sp(token, "GET", "/listings/2021-08-01/restrictions", { asin: it.asin, sellerId: seller, marketplaceIds: mkt, conditionType: "new_new" });
        restricoes.push({ asin: it.asin, http: r.status, restricoes: ((r.body?.restrictions ?? []) as any[]).flatMap((x) => (x.reasons ?? []).map((m: any) => `${m.reasonCode ?? ""}: ${String(m.message ?? "").slice(0, 160)}`)) });
      }
      const tipos = await sp(token, "GET", "/definitions/2020-09-01/productTypes", { marketplaceIds: mkt, keywords: busca, locale: "pt_BR" });
      return json({ ...out, busca, catalogo_http: cat.status, itens, restricoes, tipos_sugeridos: ((tipos.body?.productTypes ?? []) as any[]).slice(0, 6).map((p) => p.name) });
    }

    // de qual SKU da Amazon estamos falando: o próprio, FBA-<sku>, o de-para e o que o estoque do FBA conhece
    const [map, fulf] = await Promise.all([
      sb.from("sku_mapeamento").select("sku_origem").eq("marketplace", "amazon").eq("sku_correto", sku),
      sb.from("estoque_fulfillment").select("sku_marketplace").ilike("marketplace", "amazon%").eq("shop_id", SHOP[conta]).eq("sku", sku),
    ]);
    const candidatos = [...new Set([sku, `FBA-${sku}`, ...((map.data ?? []) as any[]).map((x) => String(x.sku_origem)), ...((fulf.data ?? []) as any[]).map((x) => String(x.sku_marketplace))])];
    out.candidatos = candidatos;
    const achados: any[] = [];
    for (const c of candidatos.slice(0, 6)) {
      const r = await sp(token, "GET", `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(c)}`,
        { marketplaceIds: mkt, includedData: "summaries,attributes,issues", issueLocale: "pt_BR" });
      if (!r.ok) { achados.push({ sku_amazon: c, status: r.status, erro: (r.body?.errors ?? []).map((e: any) => `${e.code}: ${String(e.message).slice(0, 120)}`) }); continue; }
      const s = r.body?.summaries?.[0] ?? {}; const a = r.body?.attributes ?? {};
      const fotos = ["main_product_image_locator", ...Array.from({ length: 8 }, (_, i) => `other_product_image_locator_${i + 1}`)]
        .map((k) => ({ atributo: k, url: a[k]?.[0]?.media_location ?? null })).filter((f) => f.url);
      achados.push({
        sku_amazon: c, status: r.status, asin: s.asin, tipo_de_produto: s.productType, situacao: s.status, titulo_resumo: s.itemName,
        item_name: a.item_name ?? null, bullet_point: a.bullet_point ?? null, product_description: a.product_description ?? null,
        fotos, n_fotos: fotos.length, exemplo_foto_bruto: a.main_product_image_locator ?? null,
        pendencias: (r.body?.issues ?? []).slice(0, 6).map((i: any) => `${i.severity} ${i.code}: ${String(i.message).slice(0, 140)} [${(i.attributeNames ?? []).join(",")}]`),
      });
    }
    out.anuncios = achados;
    const alvo = achados.find((x) => x.asin);
    if (alvo) {
      // ENSAIO: a Amazon valida e devolve o que aconteceria — nada é aplicado
      const titulo = u.searchParams.get("titulo") || alvo.item_name?.[0]?.value || alvo.titulo_resumo;
      const foto = u.searchParams.get("foto");
      const patches: any[] = [{ op: "replace", path: "/attributes/item_name", value: [{ value: titulo, language_tag: "pt_BR", marketplace_id: mkt }] }];
      if (foto) patches.push({ op: "replace", path: "/attributes/main_product_image_locator", value: [{ media_location: foto, marketplace_id: mkt }] });
      const pv = await sp(token, "PATCH", `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(alvo.sku_amazon)}`,
        { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, { productType: alvo.tipo_de_produto, patches });
      out.ensaio = { enviado: { productType: alvo.tipo_de_produto, patches }, http: pv.status, resposta: pv.body };
    }
    return json(out);
  } catch (e) {
    return json({ erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
