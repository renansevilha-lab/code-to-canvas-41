// ============================================================================
// Edge Function: anuncio-publicar v2 (12/out/2026) — IA · Anúncios, Fase 3
// ----------------------------------------------------------------------------
// Envia o anúncio montado na gestão DIRETO para o marketplace (pedido do dono).
// Só a SHOPEE por enquanto (ver docs/ia-fase3-publicacao-direta.md).
//   POST ?modulo=existentes body {sku} → onde o produto JÁ está anunciado (espelhos
//        da gestão: Shopee das duas lojas, Mercado Livre, TikTok). Só banco.
//   POST ?modulo=previa  body {rascunho_id, opcoes?}  → o que SERIA enviado + pendências.
//        Só leitura (banco, Tiny e Shopee). Não cria nem altera nada.
//   POST ?modulo=enviar  body {rascunho_id, opcoes, confirmar: true}
// v2: DOIS MODOS (opcoes.modo):
//   "criar"     → sobe as fotos aprovadas e cria o anúncio (product.add_item). Por padrão
//                 nasce FORA DO AR (UNLIST), para conferir o vínculo com o Tiny pelo SKU.
//   "atualizar" → altera um anúncio que JÁ existe (opcoes.item_id), só nos campos marcados
//                 em opcoes.campos {titulo, descricao, fotos, preco}: product.update_item
//                 e, para o preço, product.update_price. O anúncio já está ligado ao Tiny
//                 e mantém vendas e avaliações. Padrão quando o SKU já tem anúncio na loja.
//                 O estado ANTERIOR (título, descrição, fotos, preço) fica gravado no envio.
// opcoes: {modo, item_id, campos, categoria_id, estoque, fora_do_ar, peso_kg,
//          comprimento_cm, largura_cm, altura_cm, preco, de_novo}
// Regras:
//  - exige sessão de usuário com o módulo `ia` (ou service role);
//  - texto/fotos só vão se estiverem APROVADOS;
//  - escrita NÃO é retentada (um POST repetido criaria anúncio em dobro);
//  - tudo que foi enviado e a resposta da Shopee ficam em ia_publicacao;
//  - um rascunho já CRIADO só cria outro anúncio com opcoes.de_novo = true.
// Criar = anúncio SIMPLES (um SKU, sem variações). Atualizar aceita anúncio com variações:
// título, descrição e fotos são do anúncio inteiro; o preço é da variação com o nosso SKU.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const BUCKET = "ia-anuncios";
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const TINY_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const LOJA_SHOPEE: Record<string, { shop_id: number; nome: string }> = {
  ottz: { shop_id: 522186766, nome: "Shopee · Ottz Pet" },
  svl: { shop_id: 759046323, nome: "Shopee · Bumi Pet" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------- acesso
type Quem = { id: string | null; nome: string | null };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { id: null, nome: "sistema" };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { id: null, nome: "sistema" };
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

// ---------------------------------------------------------------- Shopee
async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function credShopee(partnerId: number | string) {
  const id = String(partnerId);
  if (id === "2034179") return { partner_id: 2034179, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim() };
  if (id === "2037384") return { partner_id: 2037384, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY_SVL") || "").trim() };
  throw new Error(`sem credencial para partner_id ${id}`);
}
interface Ctx { shopId: number; partnerId: number; partnerKey: string; token: string }
async function ctxShopee(shopId: number): Promise<Ctx> {
  const { data, error } = await db.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`token da Shopee não encontrado para a loja ${shopId}`);
  if (new Date(data.expires_at as string) < new Date()) throw new Error(`token da Shopee da loja ${shopId} vencido — aguarde a renovação automática`);
  const cr = credShopee(data.partner_id as number);
  return { shopId: Number(data.shop_id), partnerId: cr.partner_id, partnerKey: cr.partner_key, token: data.access_token as string };
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
async function shopeeGet(c: Ctx, path: string, params: Record<string, unknown> = {}) {
  const url = await urlLoja(c, path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) url.searchParams.append(k, String(x)); else url.searchParams.set(k, String(v));
  }
  return lerJson(await fetch(url.toString()));
}
async function shopeePost(c: Ctx, path: string, body: unknown) {
  const url = await urlLoja(c, path);
  return lerJson(await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
/** Envia uma imagem para o espaço de mídia da Shopee e devolve o image_id. */
async function subirImagem(c: Ctx, bytes: Uint8Array, mime: string, nome: string): Promise<string> {
  const path = "/api/v2/media_space/upload_image";
  const corpo = () => { const fd = new FormData(); fd.append("image", new Blob([bytes], { type: mime }), nome); return fd; };
  // API "pública" da Shopee: assinatura só com partner_id + caminho + hora
  const ts = Math.floor(Date.now() / 1000);
  const pub = new URL(`${SHOPEE_HOST}${path}`);
  pub.searchParams.set("partner_id", String(c.partnerId));
  pub.searchParams.set("timestamp", String(ts));
  pub.searchParams.set("sign", await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}`));
  let r = await lerJson(await fetch(pub.toString(), { method: "POST", body: corpo() }));
  // se a Shopee pedir a assinatura de loja, repete com ela (não cria nada em dobro: é só mídia)
  if (r?.error && /auth|sign|access_token|shop_id|param/i.test(`${r.error} ${r.message ?? ""}`)) {
    r = await lerJson(await fetch((await urlLoja(c, path)).toString(), { method: "POST", body: corpo() }));
  }
  const id = r?.response?.image_info?.image_id ?? r?.response?.image_info_list?.[0]?.image_info?.image_id;
  if (r?.error || !id) throw new Error(`a Shopee recusou a foto ${nome}: ${r?.error || "sem image_id"} ${r?.message ?? ""}`.trim());
  return String(id);
}
/** Sobe as fotos aprovadas (na ordem) e devolve os image_id. */
async function subirFotos(c: Ctx, fotos: { path: string; tipo: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of fotos) {
    const dl = await db.storage.from(BUCKET).download(f.path);
    if (dl.error || !dl.data) throw new Error(`não consegui ler a foto ${f.tipo} do armazenamento`);
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    const mime = (dl.data.type || "image/png").split(";")[0];
    ids.push(await subirImagem(c, bytes, mime, `${f.tipo}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`));
  }
  return ids;
}

// ---------------------------------------------------------------- onde o produto já está anunciado
type Existente = {
  item_id: string; nome: string | null; status: string | null; url: string;
  variacao: boolean; model_id: string | null; nome_variacao: string | null; preco: number | null;
};
/** Anúncios da loja Shopee que vendem este SKU (anúncio próprio ou uma variação de anúncio maior). */
async function existentesShopee(shopId: number, sku: string): Promise<Existente[]> {
  const [proprios, vars] = await Promise.all([
    db.from("shopee_anuncios").select("item_id, nome, status, tem_variacao, preco_min").eq("shop_id", shopId).eq("sku_pai", sku).in("status", ["NORMAL", "UNLIST"]),
    db.from("shopee_anuncios_variacao").select("item_id, model_id, nome_variacao, preco").eq("shop_id", shopId).eq("sku", sku),
  ]);
  const porItem = new Map<string, Existente>();
  const idsVar = [...new Set(((vars.data ?? []) as any[]).map((v) => Number(v.item_id)))];
  const pais = idsVar.length
    ? ((await db.from("shopee_anuncios").select("item_id, nome, status").eq("shop_id", shopId).in("item_id", idsVar).in("status", ["NORMAL", "UNLIST"])).data ?? []) as any[]
    : [];
  const pai = new Map(pais.map((p) => [String(p.item_id), p]));
  for (const v of (vars.data ?? []) as any[]) {
    const a = pai.get(String(v.item_id));
    if (!a) continue; // anúncio fora do ar/apagado
    porItem.set(String(v.item_id), {
      item_id: String(v.item_id), nome: a.nome ?? null, status: a.status ?? null, url: `https://shopee.com.br/product/${shopId}/${v.item_id}`,
      variacao: true, model_id: String(v.model_id), nome_variacao: v.nome_variacao ?? null, preco: num(v.preco),
    });
  }
  for (const a of (proprios.data ?? []) as any[]) {
    if (porItem.has(String(a.item_id))) continue;
    porItem.set(String(a.item_id), {
      item_id: String(a.item_id), nome: a.nome ?? null, status: a.status ?? null, url: `https://shopee.com.br/product/${shopId}/${a.item_id}`,
      variacao: false, model_id: null, nome_variacao: null, preco: num(a.preco_min),
    });
  }
  return [...porItem.values()];
}
async function existentesTodos(sku: string) {
  const [ottz, svl, ml, tt] = await Promise.all([
    existentesShopee(LOJA_SHOPEE.ottz.shop_id, sku),
    existentesShopee(LOJA_SHOPEE.svl.shop_id, sku),
    db.from("ml_anuncios").select("mlb, titulo, permalink, preco, n_variacoes").eq("sku", sku).eq("status", "active"),
    db.from("tiktok_produtos").select("product_id::text, titulo, preco").eq("seller_sku", sku),
  ]);
  return {
    shopee: { ottz, svl },
    mercado_livre: ((ml.data ?? []) as any[]).map((m) => ({ item_id: m.mlb, nome: m.titulo, url: m.permalink, preco: num(m.preco), variacoes: Number(m.n_variacoes) || 0 })),
    tiktok: [...new Map(((tt.data ?? []) as any[]).map((t) => [t.product_id, { item_id: t.product_id, nome: t.titulo, preco: num(t.preco) }])).values()],
  };
}

// ---------------------------------------------------------------- dados do anúncio
async function carregar(rascunhoId: string) {
  const { data: r } = await db.from("ia_rascunho").select("*").eq("id", rascunhoId).maybeSingle();
  if (!r) throw new Error("rascunho não encontrado");
  const [prod, cad, extra, imgs, etapas, pubs] = await Promise.all([
    db.from("ia_produto").select("sku, nome, marca, tipo").eq("sku", r.sku).maybeSingle(),
    db.from("produtos").select("id_tiny, peso_bruto").eq("sku", r.sku).maybeSingle(),
    db.from("ia_produto_extra").select("*").eq("sku", r.sku).maybeSingle(),
    db.from("ia_rascunho_imagem").select("id, ordem, tipo, storage_path, status").eq("rascunho_id", rascunhoId).order("ordem"),
    db.from("ia_etapa").select("etapa, status, imagem_id").eq("rascunho_id", rascunhoId),
    db.from("ia_publicacao").select("id, canal, empresa, operacao, estado, item_id, url, fora_do_ar, erro, criado_por_nome, criado_em")
      .eq("rascunho_id", rascunhoId).order("criado_em", { ascending: false }).limit(10),
  ]);
  const aprovadas = new Set(((etapas.data ?? []) as any[]).filter((e) => e.etapa === "imagem" && e.status === "aprovado").map((e) => e.imagem_id));
  const fotos = ((imgs.data ?? []) as any[]).filter((i) => i.storage_path && aprovadas.has(i.id))
    // a capa vai primeiro: é a foto que aparece na busca
    .sort((a, b) => Number(!String(a.tipo ?? "").startsWith("capa_")) - Number(!String(b.tipo ?? "").startsWith("capa_")) || a.ordem - b.ordem);
  const textoAprovado = ((etapas.data ?? []) as any[]).some((e) => e.etapa === "texto" && e.status === "aprovado");
  return { r: r as Record<string, any>, produto: prod.data as Record<string, any> | null, cad: cad.data as Record<string, any> | null,
    extra: extra.data as Record<string, any> | null, fotos, textoAprovado, publicacoes: (pubs.data ?? []) as Record<string, any>[] };
}
type Dados = Awaited<ReturnType<typeof carregar>>;

/** Peso, dimensões, EAN e NCM do cadastro do Tiny (leitura; melhor-esforço). */
async function medidasTiny(idTiny: number | null): Promise<Record<string, any>> {
  if (!idTiny) return {};
  try {
    const { data } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", "ottz").order("atualizado_em", { ascending: false }).limit(1).single();
    if (!data) return {};
    const resp = await fetch(`${TINY_HOST}/produtos/${idTiny}`, { headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/json" } });
    if (!resp.ok) return {};
    const p = await resp.json();
    const d = p?.dimensoes ?? {};
    return { peso_kg: num(d.pesoBruto), comprimento_cm: num(d.comprimento), largura_cm: num(d.largura), altura_cm: num(d.altura), gtin: p?.gtin || null, ncm: p?.ncm || null };
  } catch { return {}; }
}

function montarDescricao(r: Record<string, any>): string {
  const bullets = Array.isArray(r.bullet_points) ? (r.bullet_points as string[]).map((b) => String(b).trim()).filter(Boolean) : [];
  return [String(r.descricao ?? "").trim(), bullets.length ? bullets.map((b) => `• ${b}`).join("\n") : ""].filter(Boolean).join("\n\n");
}

type Opcoes = Record<string, any>;

/** O que é comum aos dois modos: texto, preço e fotos do rascunho, com as checagens de tamanho. */
function base(d: Dados, op: Opcoes) {
  const titulo = String(d.r.titulo ?? "").trim();
  const descricao = montarDescricao(d.r);
  const preco = num(op.preco) ?? num(d.r.preco_aprovado) ?? num(d.r.preco_sugerido);
  const fotos = d.fotos.slice(0, 9).map((f: any) => ({ path: f.storage_path as string, tipo: f.tipo as string }));
  const problemas = {
    titulo: [
      ...(!d.textoAprovado ? ["aprove o texto (bloco 1) antes de enviar"] : []),
      ...(!titulo ? ["o anúncio está sem título"] : []),
      ...(titulo.length > 120 ? [`título com ${titulo.length} caracteres (a Shopee aceita até 120)`] : []),
    ],
    descricao: [
      ...(!d.textoAprovado ? ["aprove o texto (bloco 1) antes de enviar"] : []),
      ...(descricao.length < 10 ? ["descrição muito curta (a Shopee pede ao menos 10 caracteres)"] : []),
      ...(descricao.length > 5000 ? [`descrição com ${descricao.length} caracteres (a Shopee aceita até 5.000)`] : []),
    ],
    fotos: d.fotos.length === 0 ? ["aprove ao menos 1 foto (bloco 2)"] : [],
    preco: !(preco && preco >= 1) ? ["defina o preço no bloco Preço (\"Salvar preço\")"] : [],
  };
  return { titulo, descricao, preco, fotos, problemas };
}

// ---------------------------------------------------------------- modo CRIAR
async function montarCriar(d: Dados, op: Opcoes, c: Ctx, loja: { shop_id: number; nome: string }, existentes: Existente[]) {
  const b = base(d, op);
  const pendencias = [...new Set([...b.problemas.titulo, ...b.problemas.descricao, ...b.problemas.fotos, ...b.problemas.preco])];
  const avisos: string[] = [];
  if (existentes.length) avisos.push(`este produto JÁ tem ${existentes.length} anúncio(s) nesta loja: criar outro gera anúncio duplicado. Para melhorar o que existe, use "Atualizar anúncio existente"`);
  if (d.fotos.length > 9) avisos.push(`há ${d.fotos.length} fotos aprovadas; a Shopee aceita 9 — vão as 9 primeiras (capa na frente)`);
  if (d.produto?.tipo === "V") avisos.push("este produto tem variações no Tiny: criar gera um anúncio simples, só deste SKU");

  // medidas: o que a pessoa digitou → o que já foi salvo → cadastro do Tiny → peso da gestão
  const tiny = await medidasTiny(d.cad?.id_tiny ? Number(d.cad.id_tiny) : null);
  const medidas = {
    peso_kg: num(op.peso_kg) ?? num(d.extra?.peso_kg) ?? tiny.peso_kg ?? num(d.cad?.peso_bruto),
    comprimento_cm: num(op.comprimento_cm) ?? num(d.extra?.comprimento_cm) ?? tiny.comprimento_cm ?? null,
    largura_cm: num(op.largura_cm) ?? num(d.extra?.largura_cm) ?? tiny.largura_cm ?? null,
    altura_cm: num(op.altura_cm) ?? num(d.extra?.altura_cm) ?? tiny.altura_cm ?? null,
  };
  if (!(medidas.peso_kg && medidas.peso_kg > 0)) pendencias.push("informe o peso da embalagem (kg)");
  if (!(medidas.comprimento_cm && medidas.largura_cm && medidas.altura_cm)) pendencias.push("informe comprimento, largura e altura da embalagem (cm)");

  // categoria: a Shopee sugere pelo título; os nomes vêm da árvore de categorias
  const [rec, arv] = await Promise.all([
    b.titulo ? shopeeGet(c, "/api/v2/product/category_recommend", { item_name: b.titulo }) : Promise.resolve(null),
    shopeeGet(c, "/api/v2/product/get_category", { language: "pt-BR" }),
  ]);
  const nos = new Map<number, any>(((arv?.response?.category_list ?? []) as any[]).map((n) => [Number(n.category_id), n]));
  const caminho = (id: number) => {
    const partes: string[] = []; let n = nos.get(id); let guarda = 0;
    while (n && guarda++ < 8) { partes.unshift(n.display_category_name ?? n.original_category_name ?? String(n.category_id)); n = nos.get(Number(n.parent_category_id)); }
    return partes.join(" > ");
  };
  const sugeridas = ((rec?.response?.category_id ?? []) as number[]).map(Number).filter((id) => nos.has(id) && !nos.get(id).has_children)
    .slice(0, 5).map((id) => ({ id, caminho: caminho(id) }));
  const categoriaId = num(op.categoria_id) ?? sugeridas[0]?.id ?? null;
  if (!categoriaId) pendencias.push("a Shopee não sugeriu categoria para este título — informe o código da categoria");
  else if (!nos.has(categoriaId) || nos.get(categoriaId).has_children) pendencias.push("a categoria escolhida não é uma categoria final da Shopee");

  // marca e canais de envio: copiados de anúncios que a loja já tem (é como o Tiny publica hoje)
  let marca = { brand_id: 0, original_brand_name: "NoBrand" };
  let logistica: { id: number; nome: string }[] = [];
  const { data: recente } = await db.from("shopee_anuncios").select("item_id").eq("shop_id", loja.shop_id).eq("status", "NORMAL")
    .order("atualizado_em", { ascending: false }).limit(1);
  const idModelo = recente?.[0]?.item_id ? Number(recente[0].item_id) : null;
  const idsMarca: number[] = [];
  if (d.produto?.marca) {
    const { data: irmaos } = await db.from("ia_produto").select("sku").eq("marca", d.produto.marca).limit(300);
    const skus = ((irmaos ?? []) as any[]).map((x) => x.sku);
    if (skus.length) {
      const { data: daMarca } = await db.from("shopee_anuncios").select("item_id").eq("shop_id", loja.shop_id).eq("status", "NORMAL").in("sku_pai", skus).limit(3);
      for (const a of (daMarca ?? []) as any[]) idsMarca.push(Number(a.item_id));
    }
  }
  const ids = [...new Set([...(idModelo ? [idModelo] : []), ...idsMarca])];
  if (ids.length) {
    const bi = await shopeeGet(c, "/api/v2/product/get_item_base_info", { item_id_list: ids.join(",") });
    const lista = (bi?.response?.item_list ?? []) as any[];
    const modelo = lista.find((x) => Number(x.item_id) === idModelo) ?? lista[0];
    logistica = ((modelo?.logistic_info ?? []) as any[]).filter((l) => l.enabled).map((l) => ({ id: Number(l.logistic_id), nome: String(l.logistic_name ?? l.logistic_id) }));
    const comMarca = lista.find((x) => idsMarca.includes(Number(x.item_id)) && Number(x.brand?.brand_id) > 0);
    if (comMarca?.brand) marca = { brand_id: Number(comMarca.brand.brand_id), original_brand_name: String(comMarca.brand.original_brand_name) };
  }
  if (marca.brand_id === 0) avisos.push(`o anúncio sai como "Sem marca": não achei outro anúncio da marca ${d.produto?.marca ?? "(sem marca no cadastro)"} nesta loja para copiar o registro`);
  if (logistica.length === 0) pendencias.push("não consegui ler os canais de envio de um anúncio existente desta loja");

  const estoque = Math.max(0, Math.floor(num(op.estoque) ?? 0));
  const foraDoAr = op.fora_do_ar !== false;
  if (estoque === 0) avisos.push("estoque inicial 0: o anúncio nasce esgotado até o Tiny mandar o estoque (depois do vínculo pelo SKU)");

  const corpo = {
    original_price: b.preco, description: b.descricao, description_type: "normal", item_name: b.titulo, item_sku: String(d.r.sku),
    weight: medidas.peso_kg,
    dimension: { package_length: Math.max(1, Math.ceil(medidas.comprimento_cm ?? 0)), package_width: Math.max(1, Math.ceil(medidas.largura_cm ?? 0)), package_height: Math.max(1, Math.ceil(medidas.altura_cm ?? 0)) },
    logistic_info: logistica.map((l) => ({ logistic_id: l.id, enabled: true })),
    category_id: categoriaId, brand: marca,
    image: { image_id_list: [] as string[] },
    seller_stock: [{ stock: estoque }],
    item_status: foraDoAr ? "UNLIST" : "NORMAL", condition: "NEW", pre_order: { is_pre_order: false },
  };
  return {
    corpo, pendencias, avisos, medidas, tiny,
    previa: {
      loja: loja.nome, titulo: b.titulo, descricao: b.descricao, preco: b.preco, estoque, fora_do_ar: foraDoAr, sku: String(d.r.sku), medidas,
      categoria: categoriaId ? { id: categoriaId, caminho: caminho(categoriaId) } : null, categorias_sugeridas: sugeridas,
      marca: { id: marca.brand_id, nome: marca.brand_id ? marca.original_brand_name : "Sem marca" },
      logistica, fotos: b.fotos, ean: d.extra?.gtin ?? tiny.gtin ?? null,
    },
  };
}

// ---------------------------------------------------------------- modo ATUALIZAR
async function montarAtualizar(d: Dados, op: Opcoes, c: Ctx, loja: { shop_id: number; nome: string }, alvo: Existente) {
  const b = base(d, op);
  const campos = {
    titulo: op.campos?.titulo !== false, descricao: op.campos?.descricao !== false,
    fotos: op.campos?.fotos !== false, preco: op.campos?.preco === true, // preço: só se a pessoa marcar
  };
  const pendencias: string[] = []; const avisos: string[] = [];
  if (!campos.titulo && !campos.descricao && !campos.fotos && !campos.preco) pendencias.push("marque ao menos um item para atualizar");
  if (campos.titulo) pendencias.push(...b.problemas.titulo);
  if (campos.descricao) pendencias.push(...b.problemas.descricao);
  if (campos.fotos) pendencias.push(...b.problemas.fotos);
  if (campos.preco) pendencias.push(...b.problemas.preco);

  // o anúncio como está AGORA na Shopee (para mostrar o antes e guardar no registro)
  const bi = await shopeeGet(c, "/api/v2/product/get_item_base_info", { item_id_list: alvo.item_id });
  const it = bi?.response?.item_list?.[0];
  if (bi?.error || !it) throw new Error(`não consegui ler o anúncio ${alvo.item_id} na Shopee: ${bi?.error ?? "não encontrado"} ${bi?.message ?? ""}`.trim());
  const estendida = it.description_type === "extended";
  const descAtual = estendida
    ? ((it.description_info?.extended_description?.field_list ?? []) as any[]).filter((f) => f.field_type === "text").map((f) => String(f.text ?? "")).join("\n")
    : String(it.description ?? "");
  let precoAtual: number | null = num(it.price_info?.[0]?.original_price);
  let nVariacoes = 0;
  if (it.has_model) {
    const ml = await shopeeGet(c, "/api/v2/product/get_model_list", { item_id: alvo.item_id });
    const modelos = (ml?.response?.model ?? []) as any[];
    nVariacoes = modelos.length;
    const m = modelos.find((x) => String(x.model_id) === String(alvo.model_id)) ?? modelos.find((x) => String(x.model_sku ?? "").trim() === String(d.r.sku));
    precoAtual = num(m?.price_info?.[0]?.original_price);
    if (m) alvo.model_id = String(m.model_id);
    if (campos.preco && !m) pendencias.push("não achei, neste anúncio, a variação com o SKU deste produto para trocar o preço");
    if (campos.titulo || campos.descricao || campos.fotos) avisos.push(`este anúncio tem ${nVariacoes} variações: título, descrição e fotos valem para o anúncio INTEIRO, não só para este SKU`);
  }
  const fotosAtuais = ((it.image?.image_url_list ?? []) as string[]);
  if (campos.fotos) avisos.push(`as ${fotosAtuais.length} fotos atuais do anúncio serão SUBSTITUÍDAS pelas ${b.fotos.length} aprovadas aqui`);
  if (campos.descricao && estendida) avisos.push("este anúncio usa descrição com imagens; ao atualizar, a descrição passa a ser só o texto novo");
  if (campos.preco) avisos.push("troca de preço: se o anúncio estiver em promoção, a Shopee pode recusar ou a promoção pode ser afetada");
  if (it.item_status && it.item_status !== "NORMAL") avisos.push(`o anúncio está com a situação ${it.item_status} na Shopee`);

  const corpo: Record<string, any> = { item_id: Number(alvo.item_id) };
  if (campos.titulo) corpo.item_name = b.titulo;
  if (campos.descricao) {
    if (estendida) {
      corpo.description_type = "extended";
      corpo.description_info = { extended_description: { field_list: [{ field_type: "text", text: b.descricao }] } };
    } else corpo.description = b.descricao;
  }
  if (campos.fotos) corpo.image = { image_id_list: [] as string[] };
  const corpoPreco = campos.preco
    ? { item_id: Number(alvo.item_id), price_list: [{ ...(it.has_model ? { model_id: Number(alvo.model_id) } : {}), original_price: b.preco }] }
    : null;
  const antes = { titulo: String(it.item_name ?? ""), descricao: descAtual, descricao_tipo: it.description_type ?? "normal",
    fotos: fotosAtuais, image_id_list: (it.image?.image_id_list ?? []) as string[], preco: precoAtual };
  return {
    corpo, corpoPreco, pendencias: [...new Set(pendencias)], avisos, campos, antes,
    previa: {
      loja: loja.nome, sku: String(d.r.sku), titulo: b.titulo, descricao: b.descricao, preco: b.preco, fotos: b.fotos,
      alvo: { ...alvo, n_variacoes: nVariacoes, situacao: it.item_status ?? null }, campos,
      atual: { titulo: antes.titulo, descricao: antes.descricao, fotos: antes.fotos, preco: antes.preco },
    },
  };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") || "";
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const op: Opcoes = (body.opcoes ?? {}) as Opcoes;

  try {
    if (modulo === "existentes") {
      if (!body.sku) return json({ ok: false, erro: "informe sku" }, 400);
      return json({ ok: true, sku: String(body.sku), existentes: await existentesTodos(String(body.sku)) });
    }
    if (!body.rascunho_id) return json({ ok: false, erro: "informe rascunho_id" }, 400);
    const d = await carregar(String(body.rascunho_id));
    if (d.r.canal !== "shopee") {
      return json({ ok: true, disponivel: false, canal: d.r.canal, publicacoes: d.publicacoes,
        motivo: "o envio direto está pronto só para a Shopee; os outros canais entram nas próximas versões" });
    }
    const loja = LOJA_SHOPEE[d.r.empresa] ?? LOJA_SHOPEE.ottz;
    const c = await ctxShopee(loja.shop_id);
    const existentes = await existentesShopee(loja.shop_id, String(d.r.sku));
    // padrão: se o produto já tem anúncio na loja, atualiza; senão, cria
    const modo: "criar" | "atualizar" = op.modo === "criar" || op.modo === "atualizar" ? op.modo : (existentes.length ? "atualizar" : "criar");
    const alvo = modo === "atualizar" ? (existentes.find((e) => e.item_id === String(op.item_id ?? "")) ?? existentes[0]) : null;
    if (modo === "atualizar" && !alvo) return json({ ok: false, erro: "este produto não tem anúncio nesta loja para atualizar — use Criar anúncio novo" }, 400);

    const mC = modo === "criar" ? await montarCriar(d, op, c, loja, existentes) : null;
    const mA = modo === "atualizar" ? await montarAtualizar(d, op, c, loja, { ...alvo! }) : null;
    const m = (mC ?? mA)!;

    if (modulo === "previa") {
      return json({ ok: true, disponivel: true, canal: "shopee", modo, existentes, previa: m.previa, pendencias: m.pendencias, avisos: m.avisos, publicacoes: d.publicacoes });
    }

    if (modulo === "enviar") {
      if (body.confirmar !== true) return json({ ok: false, erro: "envio exige confirmar: true" }, 400);
      if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
      if (modo === "criar") {
        const jaFoi = d.publicacoes.find((p) => p.canal === "shopee" && p.empresa === d.r.empresa && p.estado === "publicado" && p.operacao !== "atualizar");
        if (jaFoi && op.de_novo !== true) return json({ ok: false, erro: `este rascunho já criou o anúncio ${jaFoi.item_id}. Para criar outro, marque "criar outro anúncio mesmo assim".` }, 409);
      }
      const emCurso = d.publicacoes.find((p) => p.estado === "enviando" && Date.now() - new Date(p.criado_em).getTime() < 3 * 60_000);
      if (emCurso) return json({ ok: false, erro: "já há um envio em andamento para este rascunho — aguarde" }, 409);

      const { data: pub, error: ePub } = await db.from("ia_publicacao").insert({
        rascunho_id: d.r.id, sku: d.r.sku, canal: "shopee", empresa: d.r.empresa, shop_id: loja.shop_id, estado: "enviando", operacao: modo,
        item_id: mA ? mA.previa.alvo.item_id : null, fora_do_ar: mC ? mC.previa.fora_do_ar : null, criado_por: quem.id, criado_por_nome: quem.nome,
      }).select("id").single();
      if (ePub || !pub) return json({ ok: false, erro: `banco: ${ePub?.message}` }, 500);
      const registro = () => (mC ? mC.corpo : { campos: mA!.campos, corpo: mA!.corpo, preco: mA!.corpoPreco, antes: mA!.antes });
      const falhar = async (erro: string, resposta: unknown = null) => {
        await db.from("ia_publicacao").update({ estado: "erro", erro: erro.slice(0, 500), enviado: registro(), resposta }).eq("id", pub.id);
        return json({ ok: false, erro, resposta }, 200);
      };

      // ------------------------------------------------ CRIAR
      if (mC) {
        // as medidas conferidas ficam salvas para o próximo anúncio do mesmo produto
        await db.from("ia_produto_extra").upsert({ sku: d.r.sku, ...mC.medidas, gtin: d.extra?.gtin ?? mC.tiny.gtin ?? null, ncm: d.extra?.ncm ?? mC.tiny.ncm ?? null }, { onConflict: "sku" });
        try { mC.corpo.image.image_id_list = await subirFotos(c, mC.previa.fotos); }
        catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
        // sem repetição automática
        const resp = await shopeePost(c, "/api/v2/product/add_item", mC.corpo);
        const itemId = resp?.response?.item_id;
        if (resp?.error || !itemId) return await falhar(`a Shopee recusou o anúncio: ${resp?.error || "sem item_id"} ${resp?.message ?? ""}`.trim(), resp);
        const url = `https://shopee.com.br/product/${loja.shop_id}/${itemId}`;
        await db.from("ia_publicacao").update({ estado: "publicado", item_id: String(itemId), url, enviado: mC.corpo, resposta: resp }).eq("id", pub.id);
        await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
        return json({ ok: true, modo, item_id: String(itemId), url, fora_do_ar: mC.previa.fora_do_ar, avisos: mC.avisos });
      }

      // ------------------------------------------------ ATUALIZAR
      const a = mA!;
      const respostas: Record<string, unknown> = {};
      const feitos: string[] = [];
      if (a.campos.fotos) {
        try { a.corpo.image.image_id_list = await subirFotos(c, a.previa.fotos); }
        catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
      }
      if (a.campos.titulo || a.campos.descricao || a.campos.fotos) {
        const resp = await shopeePost(c, "/api/v2/product/update_item", a.corpo);
        respostas.update_item = resp;
        if (resp?.error) return await falhar(`a Shopee recusou a atualização: ${resp.error} ${resp.message ?? ""}`.trim(), respostas);
        feitos.push(...[a.campos.titulo ? "título" : "", a.campos.descricao ? "descrição" : "", a.campos.fotos ? "fotos" : ""].filter(Boolean));
      }
      if (a.corpoPreco) {
        const resp = await shopeePost(c, "/api/v2/product/update_price", a.corpoPreco);
        respostas.update_price = resp;
        const falhas = (resp?.response?.failure_list ?? []) as any[];
        if (resp?.error || falhas.length) {
          const motivo = resp?.error ? `${resp.error} ${resp.message ?? ""}` : String(falhas[0]?.failed_reason ?? "preço recusado");
          return await falhar(`${feitos.length ? `${feitos.join(", ")} atualizado(s), mas ` : ""}a Shopee recusou o preço: ${motivo}`.trim(), respostas);
        }
        feitos.push("preço");
      }
      await db.from("ia_publicacao").update({ estado: "publicado", url: a.previa.alvo.url, enviado: registro(), resposta: respostas }).eq("id", pub.id);
      await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
      return json({ ok: true, modo, item_id: a.previa.alvo.item_id, url: a.previa.alvo.url, atualizados: feitos, avisos: a.avisos });
    }

    return json({ ok: false, erro: "use ?modulo=existentes, previa ou enviar" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
