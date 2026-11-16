// Edge Function: shopee-teste-ab v2 (16/nov/2026) — teste A/B da Areia Ottz Pet Mandioca (nov/2026).
//
// ⚠ PUBLICADA NO SLOT `tiny-scope-probe` (o projeto está no limite de funções; o slot era de uso único e já expirou).
//
// Pedido do dono: aplicar na Shopee, por API, as tarefas da marcação (tabela anuncio_marcacao) que têm endpoint.
// Decisões dele (16/nov): aplicar; tirar T1-A e T3-A da relâmpago; lance do T2 = R$ 1,02.
//
//   GET  ?modulo=previa                          → valor lido AGORA na Shopee × valor novo (só leitura; aceita a chave pública)
//   POST ?modulo=aplicar  {bracos?: [...]}       → aplica as tarefas tipo 'api' ainda não feitas, UMA chamada cada (sem
//        repetir), registra em anuncio_teste_log, relê na Shopee, marca a tarefa feita ou o braço 'divergente',
//        preenche aplicado_em e, com os 4 braços aplicados, data_leitura = início + 14 dias.
//   POST ?modulo=reverter {braco, confirmar?}    → desfaz o braço pelo que está no log (sem confirmar = prévia).
//   Escrita exige login com módulo 'ads' (tela) ou a chave interna anuncio_teste_chave (função do banco
//   reverter_braco_teste). Lista fechada: só os itens/campanhas do PLANO; os anúncios de controle nunca são tocados.
//
// Preço: os anúncios estão na Minha Promoção — o preço de VENDA muda pelo discount/update_discount_item (mantendo o
// limite por comprador). O preço cheio (product/update_price) não é mexido.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-chave",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = createClient(SUPABASE_URL, SRK);

const TESTE = "Areia Ottz Pet Mandioca - nov/2026";
const OTTZ = 522186766, SVL = 759046323;
const LANCE_T2 = 1.02;

const PLANO = [
  { braco: "T1-A", shop: SVL, item: 41632450730, preco: { de: 65.9, para: 63.9 }, roas: { campanha: 110855297, de: 16.9, para: 17 }, relampago: true },
  { braco: "T1-B", shop: OTTZ, item: 51013400283, preco: { de: 64.9, para: 69.9 }, roas: { campanha: 110376031, de: 13.1, para: 10 } },
  {
    braco: "T2", shop: OTTZ, item: 55713397643, pausar: 110376034,
    criar: {
      lance: LANCE_T2, orcamento: 15, dias: 10,
      termos: ["areia para gato", "areia biodegradável gato", "areia de gato", "areia higiênica para gatos",
        "areia para gato biodegradável", "areia de mandioca para gatos", "areia para gato milho e mandioca",
        "areia gato mandioca", "areia mandioca", "areia para gato mandioca"],
    },
  },
  {
    braco: "T3-A", shop: SVL, item: 48963736980, preco: { de: 38.99, para: 33.9 }, pausar: 110843494, relampago: true,
    titulo: "Areia para Gato Biodegradável Mandioca 4kg Ottz Pet Higiênica para Gatos Natural Anti Odor",
  },
];
const CONTROLE = [{ shop: SVL, item: 53713653947 }, { shop: SVL, item: 49813727245 }, { shop: OTTZ, item: 52763388482 }, { shop: OTTZ, item: 46713408425 }];
const BRACOS_API = PLANO.map((p) => p.braco);

// ------------------------------------------------------------------ Shopee
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
async function urlAssinada(ctx: Ctx, apiPath: string, params: Record<string, unknown> = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacSha256(`${ctx.partnerId}${apiPath}${ts}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey);
  const url = new URL(`${SHOPEE_HOST}${apiPath}`);
  for (const [k, v] of Object.entries({ partner_id: ctx.partnerId, timestamp: ts, access_token: ctx.accessToken, shop_id: ctx.shopId, sign, ...params })) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}
async function lerResp(resp: Response) {
  const txt = await resp.text();
  try { return { http: resp.status, ...JSON.parse(txt) }; } catch { return { http: resp.status, _raw: txt.substring(0, 300) }; }
}
async function shopeeGet(ctx: Ctx, apiPath: string, params: Record<string, unknown> = {}): Promise<any> {
  return lerResp(await fetch((await urlAssinada(ctx, apiPath, params)).toString()));
}
/** POST sem repetição: escrita na Shopee vai UMA vez. */
async function shopeePost(ctx: Ctx, apiPath: string, body: Record<string, unknown>): Promise<any> {
  return lerResp(await fetch((await urlAssinada(ctx, apiPath)).toString(), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}
async function pegarCtx(shopId: number): Promise<Ctx> {
  const { data, error } = await db.from("oauth_tokens_shopee").select("partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`Token nao encontrado pra shop_id ${shopId}`);
  if (new Date(data.expires_at) < new Date()) throw new Error(`Token shop_id ${shopId} expirado`);
  const c = getCredentials(data.partner_id);
  return { shopId, partnerId: c.partner_id, partnerKey: c.partner_key, accessToken: data.access_token };
}
const dataBR = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : null;
const erroShopee = (r: any) => (r?.error ? `${r.error}${r.message ? `: ${r.message}` : ""}` : null);
const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
function diaBR(somaDias = 0) {
  const d = new Date(Date.now() - 3 * 3600000 + somaDias * 86400000);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
}

// leituras usadas na prévia, no aplicar e no reverter
async function lerItem(ctx: Ctx, item: number) {
  const r = await shopeeGet(ctx, "/api/v2/product/get_item_base_info", { item_id_list: String(item) });
  const it = (r.response?.item_list ?? [])[0];
  return { erro: erroShopee(r), nome: it?.item_name ?? null, preco_venda: it?.price_info?.[0]?.current_price ?? null, preco_cheio: it?.price_info?.[0]?.original_price ?? null };
}
async function lerPromocao(ctx: Ctx, item: number) {
  const r = await shopeeGet(ctx, "/api/v2/product/get_item_promotion", { item_id_list: String(item) });
  const promos = ((r.response?.success_list ?? [])[0]?.promotion ?? []) as any[];
  const d = promos.find((p) => /discount/i.test(String(p.promotion_type)) && p.promotion_staging === "ongoing" && !Number(p.model_id));
  return { erro: erroShopee(r), discount_id: d ? String(d.promotion_id) : null, preco: d?.promotion_price_info?.[0]?.promotion_price ?? null, fim: dataBR(d?.end_time), promos };
}
async function limiteNoDesconto(ctx: Ctx, discountId: string, item: number): Promise<{ limite: number | null; achou: boolean; erro: string | null }> {
  for (let pag = 1; pag <= 15; pag++) {
    const r = await shopeeGet(ctx, "/api/v2/discount/get_discount", { discount_id: discountId, page_no: pag, page_size: 100 });
    if (r.error) return { limite: null, achou: false, erro: erroShopee(r) };
    const x = ((r.response?.item_list ?? []) as any[]).find((i) => Number(i.item_id) === item);
    if (x) return { limite: Number(x.purchase_limit ?? 0), achou: true, erro: null };
    if (!r.response?.more) break;
    await sleep(250);
  }
  return { limite: null, achou: false, erro: null };
}
interface Config { campaign_id: string; ad_type: string | null; bidding_method: string | null; status: string | null; budget: number | null; roas_target: number | null; item_id: string | null; nome: string | null }
async function lerCampanhas(ctx: Ctx, ids: (number | string)[]): Promise<Config[]> {
  const r = await shopeeGet(ctx, "/api/v2/ads/get_product_level_campaign_setting_info", { info_type_list: "1,3", campaign_id_list: ids.join(",") });
  return ((r.response?.campaign_list ?? []) as any[]).map((c) => ({
    campaign_id: String(c.campaign_id), ad_type: c.common_info?.ad_type ?? null, bidding_method: c.common_info?.bidding_method ?? null,
    status: c.common_info?.campaign_status ?? null, budget: c.common_info?.campaign_budget ?? null,
    roas_target: c.auto_bidding_info?.roas_target ?? null,
    item_id: (c.common_info?.item_id_list ?? [])[0] != null ? String(c.common_info.item_id_list[0]) : null, nome: c.common_info?.ad_name ?? null,
  }));
}
async function registrarConfig(shop: number, lista: Config[]) {
  if (lista.length) await db.rpc("ads_config_registrar", { p_mkt: "shopee", p_shop: shop, p_lista: lista, p_origem: "teste_ab", p_quem: "sistema" });
}

// ------------------------------------------------------------------ acesso
async function exigirEscrita(req: Request): Promise<{ nome: string } | Response> {
  const chave = req.headers.get("x-chave") || "";
  if (chave) {
    const { data } = await db.from("anuncio_teste_chave").select("chave").eq("id", 1).maybeSingle();
    if (data?.chave && data.chave === chave) return { nome: "sistema" };
    return json({ ok: false, erro: "chave inválida" }, { status: 401 });
  }
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ ok: false, erro: "faça login no app (sessão de usuário exigida)" }, { status: 401 });
  const doUsuario = createClient(SUPABASE_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ads" });
  if (error || data !== true) return json({ ok: false, erro: "sem acesso ao módulo de ADS" }, { status: 403 });
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { nome: String(perfil?.nome ?? pl.email ?? "usuário") };
}

// ------------------------------------------------------------------ prévia
async function previa(ctxs: Record<number, Ctx>) {
  const linhas: any[] = [];
  for (const p of PLANO) {
    const ctx = ctxs[p.shop];
    const loja = p.shop === OTTZ ? "Ottz" : "Bumi";
    const it = await lerItem(ctx, p.item);
    if (p.preco) {
      const pr = await lerPromocao(ctx, p.item);
      linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: "preço de venda", atual: pr.preco ?? it.preco_venda, novo: p.preco.para,
        como: pr.discount_id ? `promoção ${pr.discount_id} (termina ${pr.fim}); preço cheio ${it.preco_cheio} não muda` : "sem promoção ativa" });
    }
    const ids = [p.roas?.campanha, p.pausar].filter(Boolean) as number[];
    const camps = ids.length ? await lerCampanhas(ctx, ids) : [];
    if (p.roas) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: `ROAS alvo (campanha ${p.roas.campanha})`, atual: camps.find((c) => c.campaign_id === String(p.roas!.campanha))?.roas_target ?? null, novo: p.roas.para });
    if (p.pausar) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: `campanha ${p.pausar}`, atual: camps.find((c) => c.campaign_id === String(p.pausar))?.status ?? null, novo: "paused" });
    if (p.titulo) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: "título", atual: it.nome, novo: p.titulo });
    if (p.criar) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: "campanha manual por palavra-chave (nova)", atual: "—", novo: `${p.criar.termos.length} termos exatos, lance R$ ${p.criar.lance}, R$ ${p.criar.orcamento}/dia, ${p.criar.dias} dias` });
    if (p.relampago) linhas.push({ braco: p.braco, loja, item_id: String(p.item), campo: "relâmpago", atual: "programado", novo: "fora da relâmpago durante o teste" });
    await sleep(200);
  }
  return linhas;
}

// ------------------------------------------------------------------ aplicar
type Res = { braco: string; tarefa: string | null; acao: string; ok: boolean; conferido: boolean | null; de?: unknown; para?: unknown; relido?: unknown; erro?: string | null; ja_estava?: boolean };

async function logar(r: Res & { marcacao_id?: number | null; shop: number; item?: number | string | null; campanha?: string | null; enviado?: unknown; resposta?: unknown; quem: string }) {
  const { data } = await db.from("anuncio_teste_log").insert({
    teste: TESTE, braco: r.braco, marcacao_id: r.marcacao_id ?? null, tarefa_id: r.tarefa, shop_id: r.shop,
    item_id: r.item != null ? String(r.item) : null, campaign_id: r.campanha ?? null, acao: r.acao,
    de: r.de === undefined ? null : r.de, para: r.para === undefined ? null : r.para, enviado: r.enviado ?? null,
    resposta: r.resposta ?? null, ok: r.ok, conferido: r.conferido, valor_relido: r.relido === undefined ? null : r.relido,
    erro: r.erro ?? null, quem: r.quem,
  }).select("id").single();
  return data?.id ?? null;
}

async function aplicarTarefa(ctx: Ctx, p: typeof PLANO[number], t: any, marcId: number, quem: string): Promise<Res> {
  const base = { braco: p.braco, tarefa: t.id, marcacao_id: marcId, shop: p.shop, item: p.item, quem };
  if (t.campo === "preco") {
    const para = Number(t.para);
    const pr = await lerPromocao(ctx, p.item);
    if (!pr.discount_id) { const r: Res = { ...base, acao: "preco", ok: false, conferido: false, de: pr.preco, para, erro: `anúncio sem promoção ativa (${pr.erro ?? "nenhuma"})` }; await logar({ ...r, ...base }); return r; }
    if (Math.abs(Number(pr.preco) - para) < 0.005) { const r: Res = { ...base, acao: "preco", ok: true, conferido: true, de: pr.preco, para, relido: pr.preco, ja_estava: true }; await logar({ ...r, ...base }); return r; }
    const lim = await limiteNoDesconto(ctx, pr.discount_id, p.item);
    if (!lim.achou) { const r: Res = { ...base, acao: "preco", ok: false, conferido: false, de: pr.preco, para, erro: `não achei o item na promoção ${pr.discount_id} ${lim.erro ?? ""}` }; await logar({ ...r, ...base }); return r; }
    const corpo = { discount_id: Number(pr.discount_id), item_list: [{ item_id: p.item, item_promotion_price: para, purchase_limit: lim.limite ?? 0 }] };
    const resp = await shopeePost(ctx, "/api/v2/discount/update_discount_item", corpo);
    const falhaItem = (resp.response?.error_list ?? [])[0];
    const okEnvio = !resp.error && !falhaItem;
    await sleep(1500);
    const depois = await lerPromocao(ctx, p.item);
    const conferido = okEnvio && Math.abs(Number(depois.preco) - para) < 0.005;
    const r: Res = { ...base, acao: "preco", ok: okEnvio, conferido, de: { preco: pr.preco, discount_id: pr.discount_id, purchase_limit: lim.limite }, para, relido: depois.preco,
      erro: erroShopee(resp) ?? (falhaItem ? `${falhaItem.fail_error}: ${falhaItem.fail_message}` : null) };
    await logar({ ...r, ...base, enviado: corpo, resposta: resp });
    return r;
  }
  if (t.campo === "roas" || t.campo === "status_campanha") {
    const camp = String(t.campanha);
    const antes = (await lerCampanhas(ctx, [camp]))[0];
    const acao = t.campo === "roas" ? "roas" : "pausar";
    if (!antes) { const r: Res = { ...base, acao, ok: false, conferido: false, erro: `campanha ${camp} não encontrada` }; await logar({ ...r, ...base, campanha: camp }); return r; }
    const jaEsta = t.campo === "roas" ? Math.abs(Number(antes.roas_target) - Number(t.para)) < 0.05 : ["paused", "ended", "closed"].includes(String(antes.status));
    const de = t.campo === "roas" ? antes.roas_target : antes.status;
    if (jaEsta) { const r: Res = { ...base, acao, ok: true, conferido: true, de, para: t.para, relido: de, ja_estava: true }; await logar({ ...r, ...base, campanha: camp }); return r; }
    const corpo: Record<string, unknown> = { reference_id: crypto.randomUUID(), campaign_id: Number(camp), edit_action: t.campo === "roas" ? "change_roas_target" : "pause" };
    if (t.campo === "roas") corpo.roas_target = Number(t.para);
    const resp = await shopeePost(ctx, "/api/v2/ads/edit_manual_product_ads", corpo);
    await sleep(1500);
    const depois = (await lerCampanhas(ctx, [camp]))[0];
    const relido = t.campo === "roas" ? depois?.roas_target : depois?.status;
    const conferido = !resp.error && (t.campo === "roas" ? Math.abs(Number(relido) - Number(t.para)) < 0.05 : ["paused", "ended", "closed"].includes(String(relido)));
    if (depois) await registrarConfig(p.shop, [depois]);
    const r: Res = { ...base, acao, ok: !resp.error, conferido, de, para: t.para, relido, erro: erroShopee(resp) };
    await logar({ ...r, ...base, campanha: camp, enviado: corpo, resposta: resp });
    return r;
  }
  if (t.campo === "titulo") {
    const antes = await lerItem(ctx, p.item);
    if (norm(antes.nome) === norm(t.para)) { const r: Res = { ...base, acao: "titulo", ok: true, conferido: true, de: antes.nome, para: t.para, relido: antes.nome, ja_estava: true }; await logar({ ...r, ...base }); return r; }
    const corpo = { item_id: p.item, item_name: String(t.para) };
    const resp = await shopeePost(ctx, "/api/v2/product/update_item", corpo);
    await sleep(1500);
    const depois = await lerItem(ctx, p.item);
    const r: Res = { ...base, acao: "titulo", ok: !resp.error, conferido: !resp.error && norm(depois.nome) === norm(t.para), de: antes.nome, para: t.para, relido: depois.nome, erro: erroShopee(resp) };
    await logar({ ...r, ...base, enviado: corpo, resposta: resp });
    return r;
  }
  if (t.campo === "criar_campanha" && p.criar) {
    // nunca cria duas: se já há campanha criada por este teste, só confere
    const { data: ja } = await db.from("anuncio_teste_log").select("campaign_id").eq("teste", TESTE).eq("braco", p.braco).eq("acao", "criar_campanha").eq("ok", true).is("revertido_em", null).limit(1);
    if (ja?.length) {
      const c = (await lerCampanhas(ctx, [ja[0].campaign_id]))[0];
      const r: Res = { ...base, acao: "criar_campanha", ok: true, conferido: !!c, para: { campanha: ja[0].campaign_id }, relido: c ?? null, ja_estava: true };
      return r;
    }
    const corpo = {
      reference_id: crypto.randomUUID(), budget: p.criar.orcamento, start_date: diaBR(0), end_date: diaBR(p.criar.dias),
      bidding_method: "manual", item_id: p.item, enhanced_cpc: false, smart_creative_setting: "default",
      selected_keywords: p.criar.termos.map((k) => ({ keyword: k, match_type: "exact", bid_price_per_click: p.criar!.lance })),
    };
    const resp = await shopeePost(ctx, "/api/v2/ads/create_manual_product_ads", corpo);
    const nova = resp.response?.campaign_id ?? (Array.isArray(resp.response) ? resp.response[0]?.campaign_id : null);
    let relido: Config | null = null;
    if (nova) { await sleep(1500); relido = (await lerCampanhas(ctx, [nova]))[0] ?? null; if (relido) await registrarConfig(p.shop, [relido]); }
    const r: Res = { ...base, acao: "criar_campanha", ok: !resp.error && !!nova, conferido: !!relido, para: { ...corpo, reference_id: undefined, campanha: nova ? String(nova) : null }, relido, erro: erroShopee(resp) ?? (nova ? null : "a Shopee não devolveu o id da campanha") };
    await logar({ ...r, ...base, campanha: nova ? String(nova) : null, enviado: corpo, resposta: resp });
    return r;
  }
  return { braco: p.braco, tarefa: t.id, acao: String(t.campo), ok: false, conferido: false, erro: "tarefa sem caminho por API" };
}

/** Relâmpago (decisão do dono): tira T1-A/T3-A da programação e das relâmpagos de hoje em diante. */
async function tirarDaRelampago(ctx: Ctx, p: typeof PLANO[number], marcId: number, quem: string): Promise<Res[]> {
  const out: Res[] = [];
  const { data: prog } = await db.from("flashsale_programacao").select("id, ativo, preco_promo").eq("shop_id", p.shop).eq("item_id", p.item);
  const ativos = (prog ?? []).filter((x: any) => x.ativo);
  if (ativos.length) {
    const { error } = await db.from("flashsale_programacao").update({ ativo: false }).in("id", ativos.map((x: any) => x.id));
    const r: Res = { braco: p.braco, tarefa: null, acao: "relampago_programacao", ok: !error, conferido: !error, de: { ativo: true, ids: ativos.map((x: any) => x.id), preco: ativos[0].preco_promo }, para: { ativo: false }, erro: error?.message ?? null };
    await logar({ ...r, marcacao_id: marcId, shop: p.shop, item: p.item, quem });
    out.push(r);
  }
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const { data: sales } = await db.from("flashsale_criadas").select("flash_sale_id, dia").eq("shop_id", p.shop).gte("dia", hoje);
  for (const s of (sales ?? []) as any[]) {
    if (!s.flash_sale_id) continue;
    const it = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_items", { flash_sale_id: s.flash_sale_id, offset: 0, limit: 50 });
    const infos: any[] = it?.response?.item_info ?? it?.response?.items ?? [];
    if (!infos.some((i) => Number(i.item_id) === p.item)) continue;
    const corpo = { flash_sale_id: Number(s.flash_sale_id), item_ids: [p.item] };
    const resp = await shopeePost(ctx, "/api/v2/shop_flash_sale/delete_shop_flash_sale_items", corpo);
    const r: Res = { braco: p.braco, tarefa: null, acao: "relampago_remover", ok: !resp.error, conferido: !resp.error, de: { flash_sale_id: String(s.flash_sale_id), dia: s.dia }, para: "removido", erro: erroShopee(resp) };
    await logar({ ...r, marcacao_id: marcId, shop: p.shop, item: p.item, quem, enviado: corpo, resposta: resp });
    out.push(r);
    await sleep(400);
  }
  return out;
}

async function aplicar(ctxs: Record<number, Ctx>, bracos: string[], quem: string) {
  const { data: marcs } = await db.from("anuncio_marcacao").select("*").eq("teste", TESTE);
  const resultados: Res[] = [];
  for (const p of PLANO.filter((x) => bracos.includes(x.braco))) {
    const m = (marcs ?? []).find((x: any) => x.braco === p.braco && String(x.item_id) === String(p.item) && x.shop_id === p.shop);
    if (!m || ["nao_mexer", "revertido"].includes(m.status)) continue;
    const ctx = ctxs[p.shop];
    const tarefas = [...(m.tarefas ?? [])] as any[];
    let divergente = false;
    for (let i = 0; i < tarefas.length; i++) {
      const t = tarefas[i];
      if (t.tipo !== "api" || t.feito) continue;
      let r: Res;
      try { r = await aplicarTarefa(ctx, p, t, m.id, quem); }
      catch (e) { r = { braco: p.braco, tarefa: t.id, acao: String(t.campo), ok: false, conferido: false, erro: (e as Error).message }; await logar({ ...r, marcacao_id: m.id, shop: p.shop, item: p.item, quem }); }
      resultados.push(r);
      if (r.ok && r.conferido) {
        tarefas[i] = { ...t, feito: true, feito_em: new Date().toISOString(), feito_por: `${quem} (API)`,
          ...(r.acao === "criar_campanha" ? { campanha: (r.para as any)?.campanha ?? null } : {}) };
      } else divergente = true;
      await sleep(500);
    }
    if (p.relampago) {
      try { resultados.push(...await tirarDaRelampago(ctx, p, m.id, quem)); }
      catch (e) { resultados.push({ braco: p.braco, tarefa: null, acao: "relampago", ok: false, conferido: false, erro: (e as Error).message }); }
    }
    const apiTodas = tarefas.filter((t) => t.tipo === "api");
    const apiFeitas = apiTodas.length > 0 && apiTodas.every((t) => t.feito);
    const upd: Record<string, unknown> = { tarefas, atualizado_por: `${quem} (API)` };
    if (apiFeitas && !m.aplicado_em) upd.aplicado_em = new Date().toISOString();
    upd.status = divergente ? "divergente" : (m.status === "divergente" ? "pendente" : m.status); // o gatilho recalcula
    await db.from("anuncio_marcacao").update(upd).eq("id", m.id);
  }
  // início do teste = quando os 4 braços com API ficaram aplicados → leitura em início + 14 dias (todos os registros)
  const { data: depois } = await db.from("anuncio_marcacao").select("braco, aplicado_em").eq("teste", TESTE).in("braco", BRACOS_API);
  let inicio: string | null = null;
  if ((depois ?? []).length === BRACOS_API.length && (depois ?? []).every((x: any) => x.aplicado_em)) {
    inicio = (depois as any[]).map((x) => x.aplicado_em).sort().at(-1);
    const leitura = new Date(new Date(inicio!).getTime() - 3 * 3600000 + 14 * 86400000).toISOString().slice(0, 10);
    await db.from("anuncio_marcacao").update({ data_leitura: leitura }).eq("teste", TESTE);
  }
  return { resultados, inicio_teste: inicio };
}

// ------------------------------------------------------------------ reverter
async function reverter(ctxs: Record<number, Ctx>, braco: string, confirmar: boolean, quem: string) {
  const p = PLANO.find((x) => x.braco === braco);
  if (!p) return { ok: false, erro: `braço ${braco} não tem alterações por API` };
  const { data: logs } = await db.from("anuncio_teste_log").select("*").eq("teste", TESTE).eq("braco", braco).eq("ok", true).is("revertido_em", null)
    .in("acao", ["preco", "roas", "pausar", "titulo", "criar_campanha", "relampago_programacao"]).order("criado_em", { ascending: false });
  const plano = ((logs ?? []) as any[]).filter((l) => !(l.de === null && l.acao !== "criar_campanha")).map((l) => ({
    id: l.id, acao: l.acao, campanha: l.campaign_id,
    volta_para: l.acao === "preco" ? l.de?.preco : l.acao === "roas" ? l.de : l.acao === "pausar" ? "resume" : l.acao === "titulo" ? l.de : l.acao === "criar_campanha" ? "pausar a campanha criada" : "religar na programação",
  }));
  if (!confirmar) return { ok: true, previa: true, braco, plano, aviso: "relâmpago removida da Shopee não volta sozinha: religar a programação a põe na próxima" };
  const ctx = ctxs[p.shop];
  const feitos: any[] = [];
  for (const l of (logs ?? []) as any[]) {
    let corpo: Record<string, unknown> | null = null; let resp: any = null; let caminho = "";
    if (l.acao === "preco" && l.de?.preco != null) {
      const pr = await lerPromocao(ctx, p.item);
      const lim = pr.discount_id ? await limiteNoDesconto(ctx, pr.discount_id, p.item) : { limite: null };
      caminho = "/api/v2/discount/update_discount_item";
      corpo = { discount_id: Number(pr.discount_id ?? l.de.discount_id), item_list: [{ item_id: p.item, item_promotion_price: Number(l.de.preco), purchase_limit: lim.limite ?? l.de.purchase_limit ?? 0 }] };
    } else if (l.acao === "roas" && l.de != null) {
      caminho = "/api/v2/ads/edit_manual_product_ads";
      corpo = { reference_id: crypto.randomUUID(), campaign_id: Number(l.campaign_id), edit_action: "change_roas_target", roas_target: Number(l.de) };
    } else if (l.acao === "pausar") {
      caminho = "/api/v2/ads/edit_manual_product_ads";
      corpo = { reference_id: crypto.randomUUID(), campaign_id: Number(l.campaign_id), edit_action: "resume" };
    } else if (l.acao === "titulo" && l.de) {
      caminho = "/api/v2/product/update_item";
      corpo = { item_id: p.item, item_name: String(l.de) };
    } else if (l.acao === "criar_campanha" && l.campaign_id) {
      caminho = "/api/v2/ads/edit_manual_product_ads";
      corpo = { reference_id: crypto.randomUUID(), campaign_id: Number(l.campaign_id), edit_action: "pause" };
    } else if (l.acao === "relampago_programacao") {
      const { error } = await db.from("flashsale_programacao").update({ ativo: true }).in("id", l.de?.ids ?? []);
      resp = { error: error?.message ?? "" };
    }
    if (caminho && corpo) resp = await shopeePost(ctx, caminho, corpo);
    const ok = !!resp && !resp.error && !(resp.response?.error_list ?? []).length;
    await logar({ braco, tarefa: l.tarefa_id, acao: `reverter:${l.acao}`, ok, conferido: null, de: l.para, para: l.acao === "preco" ? l.de?.preco : l.de, erro: erroShopee(resp), marcacao_id: l.marcacao_id, shop: p.shop, item: p.item, campanha: l.campaign_id, enviado: corpo, resposta: resp, quem });
    if (ok) await db.from("anuncio_teste_log").update({ revertido_em: new Date().toISOString() }).eq("id", l.id);
    feitos.push({ acao: l.acao, ok, erro: erroShopee(resp) });
    await sleep(500);
  }
  const camps = [p.roas?.campanha, p.pausar].filter(Boolean) as number[];
  if (camps.length) await registrarConfig(p.shop, await lerCampanhas(ctx, camps));
  if (feitos.length && feitos.every((f) => f.ok)) await db.from("anuncio_marcacao").update({ status: "revertido", atualizado_por: `${quem} (reverter)` }).eq("teste", TESTE).eq("braco", braco);
  return { ok: feitos.every((f) => f.ok), braco, feitos };
}

// ------------------------------------------------------------------ roteamento
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "previa";
  let b: any = {};
  if (req.method === "POST") { try { b = await req.json(); } catch { b = {}; } }
  try {
    const ctxs: Record<number, Ctx> = { [OTTZ]: await pegarCtx(OTTZ), [SVL]: await pegarCtx(SVL) };
    if (modulo === "previa") return json({ ok: true, lido_em: new Date().toISOString(), linhas: await previa(ctxs), controle: CONTROLE });
    if (modulo === "aplicar" || modulo === "reverter") {
      if (req.method !== "POST") return json({ ok: false, erro: "use POST" }, { status: 405 });
      const acesso = await exigirEscrita(req);
      if (acesso instanceof Response) return acesso;
      const quem = acesso.nome === "sistema" && b.quem ? String(b.quem) : acesso.nome;
      if (modulo === "aplicar") {
        const bracos = (Array.isArray(b.bracos) && b.bracos.length ? b.bracos : BRACOS_API).filter((x: string) => BRACOS_API.includes(x));
        return json({ ok: true, ...(await aplicar(ctxs, bracos, quem)) });
      }
      const confirmar = b.confirmar === true || b.confirmar === "true" || b.confirmar === "1";
      return json(await reverter(ctxs, String(b.braco ?? ""), confirmar, quem));
    }
    return json({ ok: false, erro: `modulo desconhecido: ${modulo}` }, { status: 400 });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, { status: 500 });
  }
});
