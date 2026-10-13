// ============================================================================
// Edge Function: anuncio-shopee-variacoes v1 (12/out/2026)
// ----------------------------------------------------------------------------
// Transforma um anúncio SIMPLES da Shopee (o que a `anuncio-publicar` cria) em anúncio COM
// VARIAÇÕES — `product/init_tier_variation`. É o 2º passo de "enviar anúncio com variações":
//   1) `anuncio-publicar` cria o anúncio do produto pai (título, descrição, fotos, categoria…);
//   2) esta função cria as opções (ex.: 4kg, 8kg, 12kg) com SKU, preço e estoque de cada uma
//      e, se pedido, a foto de cada opção.
//   POST ?modulo=previa {empresa, item_id, grade, variacoes:[{sku, opcao, preco, estoque, foto_path?}]}
//        → lê o anúncio ao vivo, confere tudo e devolve o que SERIA enviado. Não escreve.
//   POST ?modulo=criar  {…o mesmo…, confirmar: true}
// Regras: sessão de usuário com o módulo `ia`; a escrita NÃO é repetida; anúncio que já tem
// variações é recusado (mudar opções de anúncio que já vende derruba o histórico delas).
// Separada da `anuncio-publicar` de propósito (função grande e crítica).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const BUCKET = "ia-anuncios";
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const LOJA: Record<string, number> = { ottz: 522186766, svl: 759046323 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const num = (v: unknown): number => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };

async function exigirAcesso(req: Request): Promise<{ nome: string | null } | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

// ---------------------------------------------------------------- Shopee (mesma assinatura da anuncio-publicar)
async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
interface Ctx { shopId: number; partnerId: number; partnerKey: string; token: string }
async function ctxShopee(shopId: number): Promise<Ctx> {
  const { data, error } = await db.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`token da Shopee não encontrado para a loja ${shopId}`);
  if (new Date(data.expires_at as string) < new Date()) throw new Error(`token da Shopee da loja ${shopId} vencido — aguarde a renovação automática`);
  const id = String(data.partner_id);
  const partnerKey = id === "2034179" ? (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim() : id === "2037384" ? (Deno.env.get("SHOPEE_PARTNER_KEY_SVL") || "").trim() : "";
  if (!partnerKey) throw new Error(`sem credencial para partner_id ${id}`);
  return { shopId: Number(data.shop_id), partnerId: Number(id), partnerKey, token: data.access_token as string };
}
async function urlLoja(c: Ctx, path: string): Promise<URL> {
  const ts = Math.floor(Date.now() / 1000);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.set("partner_id", String(c.partnerId));
  url.searchParams.set("timestamp", String(ts));
  url.searchParams.set("access_token", c.token);
  url.searchParams.set("shop_id", String(c.shopId));
  url.searchParams.set("sign", await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}${c.token}${c.shopId}`));
  return url;
}
async function lerJson(r: Response) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { error: "resposta_nao_json", message: txt.slice(0, 300) }; }
}
async function subirImagem(c: Ctx, bytes: Uint8Array, mime: string, nome: string): Promise<string> {
  const path = "/api/v2/media_space/upload_image";
  const corpo = () => { const fd = new FormData(); fd.append("image", new Blob([bytes], { type: mime }), nome); return fd; };
  const ts = Math.floor(Date.now() / 1000);
  const pub = new URL(`${SHOPEE_HOST}${path}`);
  pub.searchParams.set("partner_id", String(c.partnerId));
  pub.searchParams.set("timestamp", String(ts));
  pub.searchParams.set("sign", await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}`));
  let r = await lerJson(await fetch(pub.toString(), { method: "POST", body: corpo() }));
  if (r?.error && /auth|sign|access_token|shop_id|param/i.test(`${r.error} ${r.message ?? ""}`)) {
    r = await lerJson(await fetch((await urlLoja(c, path)).toString(), { method: "POST", body: corpo() }));
  }
  const id = r?.response?.image_info?.image_id ?? r?.response?.image_info_list?.[0]?.image_info?.image_id;
  if (r?.error || !id) throw new Error(`a Shopee recusou a foto ${nome}: ${r?.error || "sem image_id"} ${r?.message ?? ""}`.trim());
  return String(id);
}

interface Variacao { sku: string; opcao: string; preco: number; estoque: number; foto_path: string | null }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") ?? "";
  if (modulo !== "previa" && modulo !== "criar") return json({ ok: false, erro: "use ?modulo=previa ou criar" }, 400);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  try {
    const shopId = LOJA[String(body.empresa ?? "")];
    const itemId = Number(String(body.item_id ?? "").replace(/\D/g, ""));
    const grade = String(body.grade ?? "").trim();
    const variacoes: Variacao[] = (Array.isArray(body.variacoes) ? body.variacoes : []).map((v: any) => ({
      sku: String(v?.sku ?? "").trim(), opcao: String(v?.opcao ?? "").trim(), preco: num(v?.preco),
      estoque: Math.max(0, Math.floor(num(v?.estoque))), foto_path: v?.foto_path ? String(v.foto_path) : null,
    }));
    const pend: string[] = []; const avisos: string[] = [];
    if (!shopId) pend.push("loja inválida (empresa = ottz ou svl)");
    if (!itemId) pend.push("informe o ID do anúncio na Shopee");
    if (!grade) pend.push("dê um nome ao grupo de opções (ex.: Tamanho)");
    else if (grade.length > 14) pend.push(`o nome do grupo tem ${grade.length} caracteres (a Shopee aceita até 14)`);
    if (variacoes.length < 2) pend.push("informe ao menos 2 variações");
    if (variacoes.length > 50) pend.push("no máximo 50 variações por anúncio");
    variacoes.forEach((v, i) => {
      const n = `variação ${i + 1}`;
      if (!v.opcao) pend.push(`${n}: escreva o nome da opção`);
      else if (v.opcao.length > 20) pend.push(`${n}: "${v.opcao}" tem ${v.opcao.length} caracteres (a Shopee aceita até 20)`);
      if (!v.sku) pend.push(`${n}: sem SKU`);
      if (!(v.preco > 0)) pend.push(`${n}: informe o preço`);
    });
    if (new Set(variacoes.map((v) => v.opcao.toLowerCase())).size !== variacoes.length) pend.push("há duas opções com o mesmo nome");
    if (new Set(variacoes.map((v) => v.sku)).size !== variacoes.length) pend.push("há SKU repetido entre as variações");
    const comFoto = variacoes.filter((v) => v.foto_path).length;
    if (comFoto > 0 && comFoto < variacoes.length) pend.push("foto da opção: ou todas as variações têm foto, ou nenhuma (regra da Shopee)");
    const precos = variacoes.map((v) => v.preco).filter((p) => p > 0);
    if (precos.length > 1 && Math.max(...precos) / Math.min(...precos) > 5) {
      avisos.push("a variação mais cara custa mais de 5× a mais barata: a Shopee costuma recusar essa diferença");
    }
    if (variacoes.some((v) => v.estoque === 0)) avisos.push("variação com estoque 0 nasce esgotada até o Tiny mandar o estoque (depois do vínculo pelo SKU)");

    // o anúncio, lido ao vivo: precisa existir e ainda ser simples
    let anuncio: Record<string, unknown> | null = null; let c: Ctx | null = null;
    if (shopId && itemId) {
      c = await ctxShopee(shopId);
      const url = await urlLoja(c, "/api/v2/product/get_item_base_info");
      url.searchParams.set("item_id_list", String(itemId));
      const bi = await lerJson(await fetch(url.toString()));
      const it = bi?.response?.item_list?.[0];
      if (bi?.error || !it) pend.push(`não achei o anúncio ${itemId} nesta loja${bi?.error ? ` (${bi.error} ${bi.message ?? ""})` : ""}`);
      else {
        anuncio = { item_id: itemId, nome: it.item_name, sku: it.item_sku ?? null, situacao: it.item_status, tem_variacao: !!it.has_model, url: `https://shopee.com.br/product/${shopId}/${itemId}` };
        if (it.has_model) pend.push("este anúncio JÁ tem variações na Shopee: esta tela só cria as variações de um anúncio simples");
        if (it.item_status && !["NORMAL", "UNLIST"].includes(String(it.item_status))) pend.push(`o anúncio está com a situação ${it.item_status} na Shopee`);
      }
    }
    const pendencias = [...new Set(pend)];
    const semFoto = (opt: Variacao, id?: string) => ({ option: opt.opcao, ...(id ? { image: { image_id: id } } : {}) });
    const montar = (ids: Map<string, string>) => ({
      item_id: itemId,
      tier_variation: [{ name: grade, option_list: variacoes.map((v) => semFoto(v, ids.get(v.sku))) }],
      model: variacoes.map((v, i) => ({ tier_index: [i], original_price: v.preco, model_sku: v.sku, seller_stock: [{ stock: v.estoque }] })),
    });
    if (modulo === "previa") return json({ ok: true, anuncio, pendencias, avisos, com_foto: comFoto === variacoes.length && comFoto > 0, payload: montar(new Map()) });

    if (body.confirmar !== true) return json({ ok: false, erro: "criar exige confirmar: true" }, 400);
    if (pendencias.length || !c) return json({ ok: false, erro: "há pendências", pendencias }, 400);

    // fotos das opções (só mídia: se falhar aqui, nada foi mudado no anúncio)
    const ids = new Map<string, string>();
    if (comFoto === variacoes.length) {
      for (const v of variacoes) {
        const dl = await db.storage.from(BUCKET).download(v.foto_path!);
        if (dl.error || !dl.data) throw new Error(`não consegui ler a foto da opção ${v.opcao}`);
        const mime = (dl.data.type || "image/png").split(";")[0];
        ids.set(v.sku, await subirImagem(c, new Uint8Array(await dl.data.arrayBuffer()), mime, `${v.sku}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`));
      }
    }
    const payload = montar(ids);
    const r = await lerJson(await fetch((await urlLoja(c, "/api/v2/product/init_tier_variation")).toString(), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }));
    const erro = r?.error ? `${r.error} ${r.message ?? ""}`.trim() : null;
    await db.from("debug_fulfillment").insert({
      modulo: "anuncio-shopee-variacoes", etapa: String(itemId), status_http: erro ? 400 : 200,
      resultado: { quem: quem.nome, shop_id: shopId, enviado: payload, resposta: r },
    });
    if (erro) return json({ ok: false, erro: `a Shopee recusou as variações: ${erro}`, resposta: r }, 200);
    const modelos = ((r?.response?.model ?? []) as any[]).map((m) => ({ model_id: m.model_id, sku: m.model_sku, tier_index: m.tier_index }));
    return json({ ok: true, anuncio, modelos, aviso: r?.warning || null });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
