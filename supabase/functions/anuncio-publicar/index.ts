// ============================================================================
// Edge Function: anuncio-publicar v11 (19/out/2026) — IA · Anúncios, Fase 3
// ----------------------------------------------------------------------------
// Envia o anúncio montado na gestão DIRETO para o marketplace (pedido do dono).
// SHOPEE e MERCADO LIVRE (ver docs/ia-fase3-publicacao-direta.md).
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
// v3: no modo atualizar as fotos NÃO são mais substituídas em bloco. opcoes.fotos =
//   {manter: [image_id das fotos atuais que ficam], novas: [caminho das aprovadas que entram],
//    posicao: "inicio" | "fim"}. Padrão: todas as atuais ficam e todas as novas entram
//   (no início, se a primeira nova for capa; senão no fim). Limite da Shopee: 9 fotos.
// v4: MERCADO LIVRE (rascunho com canal mercado_livre; conta pela empresa: ottz 1107117809,
//   svl 1299638625 — o token é sempre o DA CONTA). Mesmos dois modos e a mesma conferência.
//   Criar: as contas estão no modelo "User Products" → o corpo leva family_name (e NÃO title);
//   características obrigatórias da categoria + medidas da embalagem (SELLER_PACKAGE_*) + SKU;
//   código de barras ou o motivo de não ter; a prévia passa o corpo no VALIDADOR do ML
//   (/items/validate, não cria nada) e os erros dele viram pendência. Fotos sobem por
//   /pictures/items/upload. Por padrão o anúncio é PAUSADO logo depois de criado.
//   Atualizar: fotos (mesmo seletor manter/novas/posição), descrição, preço (só se marcar) e
//   título (só se marcar; o ML recusa em anúncio que já vendeu).
//   opcoes extras do ML: tipo_anuncio (gold_special | gold_pro), gtin, atributos {ID: valor}.
// v5: UM ANÚNCIO, VÁRIOS DESTINOS (pedido do dono). body.destino = {canal, empresa} manda o MESMO
//   rascunho (texto e fotos) para outro marketplace/loja, sem um rascunho por canal. Sem destino
//   vale o canal/empresa do rascunho, como antes. O preço de outro destino é o salvo para ele
//   (memoria_calculo.destinos["canal:empresa"].preco) ou, se não houver, o sugerido pelas taxas
//   daquele canal (ia_calcular_preco) — nunca o preço do canal do rascunho.
// v6: ORDEM DAS FOTOS escolhida na tela e o mesmo plano em OUTRO anúncio (pedido do dono).
//   opcoes.fotos.ordem = [..] dá a sequência final: id de foto atual, caminho de foto nova ou
//   "#N" (a foto atual da posição N, contando do zero). O que não estiver na lista vai para o fim.
//   opcoes.fotos.manter_pos = [N..] mantém as fotos atuais POR POSIÇÃO (em vez de por id): é o que
//   permite repetir, no anúncio de outra conta/loja, a mesma escolha feita no primeiro.
// v7: AMAZON, só ATUALIZAR anúncio que já existe (SP-API Listings Items, conta pela empresa: shop
//   900001 ACZ / 900002 SVL; exige o merchant_token da conta). Título, descrição + bullets e fotos
//   (a principal + 8; a Amazon baixa cada foto nova de um endereço assinado do nosso armazenamento).
//   A prévia passa as alterações no VALIDADOR da Amazon (mode=VALIDATION_PREVIEW, não aplica nada).
//   Preço e criar anúncio novo na Amazon ainda não.
// v9 (14/out/2026): PRODUTO PAI acha o anúncio pelas VARIAÇÕES. O anúncio da Shopee pode ter outro
//   `item_sku` (ex.: 15182 → anúncio 23297086602 com item_sku 14423, o SKU antigo) e mesmo assim ser o anúncio
//   dele: as variações têm os SKUs dos filhos (15177/15178/15186/15187). Antes a tela dizia "ainda não
//   anunciado" e o envio CRIAVA outro anúncio. Agora `existentesShopee` também procura os SKUs dos filhos.
// v8: PESO E MEDIDAS nunca travam por cadastro zerado (pedido do dono). O Tiny devolve 0 para
//   produto sem peso/medida e o 0 era aceito como valor, sem cair no recurso seguinte. Agora só
//   vale número MAIOR que zero. Peso: digitado → já conferido (ia_produto_extra) → Tiny ao vivo →
//   o que a gestão sabe (peso do cadastro; kit = soma da composição; produto com variações = a
//   menor variação; por último o peso escrito no nome, "… 2kg"). Medidas: digitadas → conferidas
//   → Tiny → EMBALAGEM PADRÃO 40 × 30 × 15 cm. A tela avisa de onde veio cada número.
// v10 (15/out/2026): CAPA PRINCIPAL POR DESTINO (pedido do dono) — Ottz Shopee = "Menor preço da
//   Shopee", Bumi Shopee = ambientada com texto, Mercado Livre (Ottz e SVL) = ambientada limpa. A capa
//   do destino vai na frente e as outras capas não vão; sem ela aprovada, vale a regra antiga + aviso.
// v11 (19/out/2026): AMAZON também CRIA (pedido do dono). Pelo código de barras: produto que já existe no catálogo
//   → OFERTA no ASIN dele (LISTING_OFFER_ONLY); senão → FICHA NOVA (LISTING) com texto, fotos, marca, medidas e o
//   que o tipo de produto exige (formulário montado pelo esquema do tipo + os campos que o validador apontar).
//   Sempre FBA; SKU na Amazon = `<sku>_FBA`. opcoes extras: caminho (oferta|ficha), asin, tipo_produto, gtin,
//   sku_amazon, atributos {campo: valor}. Só a conta que tem o Merchant Token (hoje a ACZ).
//   Até 20/out 03:00 UTC a PRÉVIA da Amazon aceita a chave publicável (rota de ensaio: só leitura + validador).
// opcoes: {modo, item_id, campos, fotos, categoria_id, estoque, fora_do_ar, peso_kg,
//          comprimento_cm, largura_cm, altura_cm, preco, de_novo}
// Regras:
//  - exige sessão de usuário com o módulo `ia` (ou service role);
//  - texto/fotos só vão se estiverem APROVADOS;
//  - escrita NÃO é retentada (um POST repetido criaria anúncio em dobro);
//  - tudo que foi enviado e a resposta do marketplace ficam em ia_publicacao;
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
// deno-lint-ignore no-explicit-any
type Quem = { id: string | null; nome: string | null; doUsuario?: any; ensaio?: boolean };
// v11: rota de ensaio da criação na Amazon — só a PRÉVIA (leitura + validador), morre sozinha
const ENSAIO_AMZ_ATE = Date.parse("2026-10-20T03:00:00Z");
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { id: null, nome: "sistema" };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { id: null, nome: "sistema" };
  if (pl.role === "anon" && Date.now() < ENSAIO_AMZ_ATE && new URL(req.url).searchParams.get("modulo") === "previa") return { id: null, nome: "ensaio", ensaio: true };
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null, doUsuario };
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
  vendas?: number; catalogo?: boolean; // só Mercado Livre
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
  // v9: produto PAI — o anúncio dele é o que tem as variações com os SKUs dos filhos, qualquer que seja o item_sku
  const { data: filhos } = await db.from("produtos").select("sku").eq("sku_pai", sku).limit(60);
  const skusFilhos = ((filhos ?? []) as any[]).map((f) => String(f.sku));
  if (skusFilhos.length) {
    const { data: vf } = await db.from("shopee_anuncios_variacao").select("item_id, preco").eq("shop_id", shopId).in("sku", skusFilhos);
    const ids = [...new Set(((vf ?? []) as any[]).map((v) => Number(v.item_id)))].filter((id) => !porItem.has(String(id)));
    if (ids.length) {
      const { data: ans } = await db.from("shopee_anuncios").select("item_id, nome, status, preco_min").eq("shop_id", shopId).in("item_id", ids).in("status", ["NORMAL", "UNLIST"]);
      for (const a of (ans ?? []) as any[]) {
        porItem.set(String(a.item_id), {
          item_id: String(a.item_id), nome: a.nome ?? null, status: a.status ?? null, url: `https://shopee.com.br/product/${shopId}/${a.item_id}`,
          variacao: false, model_id: null, nome_variacao: null, preco: num(a.preco_min),
        });
      }
    }
  }
  return [...porItem.values()];
}
async function existentesTodos(sku: string) {
  const [ottz, svl, mlLojas, amzLojas, ml, tt] = await Promise.all([
    existentesShopee(LOJA_SHOPEE.ottz.shop_id, sku),
    existentesShopee(LOJA_SHOPEE.svl.shop_id, sku),
    existentesMlLojas(sku),
    existentesAmzLojas(sku),
    db.from("ml_anuncios").select("mlb, titulo, permalink, preco, n_variacoes").eq("sku", sku).eq("status", "active"),
    db.from("tiktok_produtos").select("product_id::text, titulo, preco").eq("seller_sku", sku),
  ]);
  const mlEspelho = ((ml.data ?? []) as any[]).map((m) => ({ item_id: m.mlb, nome: m.titulo, url: m.permalink, preco: num(m.preco), variacoes: Number(m.n_variacoes) || 0 }));
  return {
    shopee: { ottz, svl },
    mercado_livre: mlEspelho, // espelho da gestão (só a conta Ottz) — mantido para a tela antiga
    // ao vivo, por conta (null = não deu para consultar); a Ottz cai no espelho se a consulta falhar
    mercado_livre_lojas: { ottz: mlLojas.ottz ?? mlEspelho, svl: mlLojas.svl },
    amazon: amzLojas, // ao vivo, por conta (null = não deu para consultar, ex.: falta o código de vendedor)
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
    extra: extra.data as Record<string, any> | null, fotos, textoAprovado, publicacoes: (pubs.data ?? []) as Record<string, any>[],
    capaDestino: null as string | null, avisosCapa: [] as string[] };
}
type Dados = Awaited<ReturnType<typeof carregar>>;

// v10: capa PRINCIPAL por destino (dono, 15/out/2026). Ottz Shopee = "Menor preço da Shopee";
// Bumi Shopee = ambientada com texto; Mercado Livre (as duas contas) = ambientada limpa.
// Achada a capa do destino, ela vai na frente e as OUTRAS capas não vão; sem ela, vale a regra antiga.
const CAPA_DO_DESTINO: Record<string, { tipos: string[]; nome: string }> = {
  "shopee:ottz": { tipos: ["capa_ambientada_shopee", "capa_shopee_basica", "capa_shopee_livre"], nome: "Menor preço da Shopee" },
  "shopee:svl": { tipos: ["capa_ambientada_texto"], nome: "ambientada com texto" },
  "mercado_livre:ottz": { tipos: ["capa_ambientada_limpa"], nome: "ambientada limpa" },
  "mercado_livre:svl": { tipos: ["capa_ambientada_limpa"], nome: "ambientada limpa" },
};
function aplicarCapaDoDestino(d: Dados) {
  const regra = CAPA_DO_DESTINO[`${d.r.canal}:${d.r.empresa}`];
  if (!regra) return;
  const capa = regra.tipos.map((tp) => d.fotos.find((f: any) => f.tipo === tp)).find(Boolean);
  if (!capa) {
    if (d.fotos.some((f: any) => String(f.tipo ?? "").startsWith("capa_")))
      d.avisosCapa.push(`a capa principal deste destino é a "${regra.nome}", que não está aprovada neste anúncio: vai a capa que houver`);
    return;
  }
  const saem = d.fotos.filter((f: any) => f !== capa && String(f.tipo ?? "").startsWith("capa_")).length;
  d.fotos = [capa, ...d.fotos.filter((f: any) => !String(f.tipo ?? "").startsWith("capa_"))];
  d.capaDestino = String(capa.storage_path);
  if (saem) d.avisosCapa.push(`capa principal: "${regra.nome}"; ${saem} outra(s) capa(s) aprovada(s) não vão para este destino`);
}

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

/** Só número MAIOR que zero conta (o Tiny devolve 0 para o que não foi cadastrado). */
const pos = (v: unknown): number | null => { const n = num(v); return n !== null && n > 0 ? n : null; };
// embalagem padrão quando nem a tela, nem o que já foi conferido, nem o Tiny têm medidas (dono, 13/out/2026)
const MEDIDAS_PADRAO = { comprimento_cm: 40, largura_cm: 30, altura_cm: 15 };

/** "… 2kg" / "500 g" no nome → kg (a última ocorrência). Último recurso, quando o cadastro não tem peso. */
function pesoDoNome(nome: unknown): number | null {
  const ms = [...String(nome ?? "").matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/gi)];
  const m = ms[ms.length - 1];
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  if (!(v > 0)) return null;
  return m[2].toLowerCase() === "kg" ? v : v / 1000;
}
type PesoAchado = { kg: number; origem: string };
/** Peso de cada SKU pelo que a gestão sabe: cadastro → já conferido em outro anúncio → composição do kit → nome. */
async function pesosDoSistema(skus: string[]): Promise<Map<string, PesoAchado>> {
  const out = new Map<string, PesoAchado>();
  if (!skus.length) return out;
  const { data: kitsD } = await db.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_kit", skus);
  const kits = (kitsD ?? []) as any[];
  const todos = [...new Set([...skus, ...kits.map((k) => String(k.sku_componente))])];
  const [prods, extras] = await Promise.all([
    db.from("produtos").select("sku, nome, peso_bruto").in("sku", todos),
    db.from("ia_produto_extra").select("sku, peso_kg").in("sku", todos),
  ]);
  const cad = new Map(((prods.data ?? []) as any[]).map((x) => [String(x.sku), x]));
  const conf = new Map(((extras.data ?? []) as any[]).map((x) => [String(x.sku), pos(x.peso_kg)]));
  const proprio = (sku: string): PesoAchado | null => {
    const c = pos(cad.get(sku)?.peso_bruto); if (c) return { kg: c, origem: "peso do cadastro" };
    const e = conf.get(sku); if (e) return { kg: e, origem: "peso já conferido em outro anúncio" };
    return null;
  };
  for (const sku of skus) {
    const direto = proprio(sku);
    if (direto) { out.set(sku, direto); continue; }
    const comps = kits.filter((k) => String(k.sku_kit) === sku);
    if (comps.length) {
      let soma = 0; let completo = true;
      for (const k of comps) {
        const sc = String(k.sku_componente);
        const u = proprio(sc)?.kg ?? pesoDoNome(cad.get(sc)?.nome);
        if (!u) { completo = false; break; }
        soma += u * (Number(k.quantidade) || 1);
      }
      if (completo && soma > 0) {
        out.set(sku, { kg: Math.round(soma * 1000) / 1000, origem: `soma da composição do kit (${comps.map((k) => `${k.quantidade} × ${k.sku_componente}`).join(" + ")})` });
        continue;
      }
    }
    const n = pesoDoNome(cad.get(sku)?.nome);
    if (n) out.set(sku, { kg: n, origem: "peso escrito no nome do produto" });
  }
  return out;
}
/** Peso e medidas da embalagem do anúncio (iguais para Shopee e Mercado Livre) + de onde vieram. */
async function medidasDoAnuncio(d: Dados, op: Opcoes, tiny: Record<string, any>) {
  const sku = String(d.r.sku);
  const avisos: string[] = [];
  let peso = pos(op.peso_kg) ?? pos(d.extra?.peso_kg) ?? pos(tiny.peso_kg);
  if (!peso) {
    let achado = (await pesosDoSistema([sku])).get(sku) ?? null;
    if (d.produto?.tipo === "V") {
      // produto com variações: o peso do anúncio é o da menor variação (cada variação leva o seu no bloco de variações)
      const { data: filhos } = await db.from("produtos").select("sku").eq("sku_pai", sku).limit(40);
      const dosFilhos = [...(await pesosDoSistema(((filhos ?? []) as any[]).map((f) => String(f.sku)))).values()].sort((x, y) => x.kg - y.kg);
      if (dosFilhos[0]) achado = { kg: dosFilhos[0].kg, origem: `a menor variação — ${dosFilhos[0].origem}` };
    }
    if (achado) {
      peso = achado.kg;
      avisos.push(`peso de ${String(achado.kg).replace(".", ",")} kg puxado do sistema (${achado.origem}): o cadastro do Tiny deste produto está sem peso — confira`);
    }
  }
  const dim = (k: "comprimento_cm" | "largura_cm" | "altura_cm") => pos(op[k]) ?? pos(d.extra?.[k]) ?? pos(tiny[k]);
  const lidas = { comprimento_cm: dim("comprimento_cm"), largura_cm: dim("largura_cm"), altura_cm: dim("altura_cm") };
  const usouPadrao = !lidas.comprimento_cm || !lidas.largura_cm || !lidas.altura_cm;
  if (usouPadrao) {
    avisos.push(`medidas da embalagem no padrão ${MEDIDAS_PADRAO.comprimento_cm} × ${MEDIDAS_PADRAO.largura_cm} × ${MEDIDAS_PADRAO.altura_cm} cm (o cadastro não tem medidas): troque nos campos se a caixa for outra`);
  }
  const medidas = {
    peso_kg: peso,
    comprimento_cm: lidas.comprimento_cm ?? MEDIDAS_PADRAO.comprimento_cm,
    largura_cm: lidas.largura_cm ?? MEDIDAS_PADRAO.largura_cm,
    altura_cm: lidas.altura_cm ?? MEDIDAS_PADRAO.altura_cm,
  };
  // o que fica salvo para o próximo anúncio do produto: o padrão NÃO é gravado como medida conferida
  const salvar = { peso_kg: peso, comprimento_cm: lidas.comprimento_cm, largura_cm: lidas.largura_cm, altura_cm: lidas.altura_cm };
  return { medidas, salvar, avisos, faltaPeso: !peso };
}

function montarDescricao(r: Record<string, any>): string {
  const bullets = Array.isArray(r.bullet_points) ? (r.bullet_points as string[]).map((b) => String(b).trim()).filter(Boolean) : [];
  return [String(r.descricao ?? "").trim(), bullets.length ? bullets.map((b) => `• ${b}`).join("\n") : ""].filter(Boolean).join("\n\n");
}

type Opcoes = Record<string, any>;

/** Fotos atuais que ficam: por posição (manter_pos), por id (manter) ou todas. */
function fotosQueFicam(selF: Record<string, any>, idsAtuais: string[]): string[] {
  if (Array.isArray(selF.manter_pos)) { const pos = (selF.manter_pos as unknown[]).map(Number); return idsAtuais.filter((_, i) => pos.includes(i)); }
  if (Array.isArray(selF.manter)) { const ids = (selF.manter as unknown[]).map(String); return idsAtuais.filter((id) => ids.includes(id)); }
  return idsAtuais;
}
/** Sequência final das fotos no modo atualizar: a escolhida na tela ou atuais/novas pela posição. */
function ordemFinal(op: Opcoes, plano: { manter: string[]; novas: { path: string }[]; posicao: "inicio" | "fim"; atuais: string[] }, novosIds: string[], capa: string | null = null): string[] {
  const padrao = plano.posicao === "inicio" ? [...novosIds, ...plano.manter] : [...plano.manter, ...novosIds];
  if (!Array.isArray(op.fotos?.ordem)) return padrao;
  const idDaNova = new Map(plano.novas.map((f, i) => [f.path, novosIds[i]]));
  const out: string[] = [];
  for (const t of (op.fotos.ordem as unknown[]).map(String)) {
    const atual = t.startsWith("#") ? plano.atuais[Number(t.slice(1))] : t;
    const id = atual && plano.manter.includes(atual) ? atual : idDaNova.get(t);
    if (id && !out.includes(id)) out.push(id);
  }
  for (const id of padrao) if (!out.includes(id)) out.push(id);
  // a ordem arrumada em outro destino não tem a capa deste: ela vai na frente
  const ordemTela = (op.fotos.ordem as unknown[]).map(String);
  const idCapa = capa && !ordemTela.includes(capa) ? idDaNova.get(capa) : undefined;
  if (idCapa) return [idCapa, ...out.filter((x) => x !== idCapa)];
  return out;
}

type Limites = { quem: string; titulo: number; descMin: number; descMax: number; fotos: number };
const LIM_SHOPEE: Limites = { quem: "a Shopee", titulo: 120, descMin: 10, descMax: 5000, fotos: 9 };

/** O que é comum aos dois modos: texto, preço e fotos do rascunho, com as checagens de tamanho. */
function base(d: Dados, op: Opcoes, lim: Limites = LIM_SHOPEE) {
  const titulo = String(d.r.titulo ?? "").trim();
  const descricao = montarDescricao(d.r);
  const preco = num(op.preco) ?? num(d.r.preco_aprovado) ?? num(d.r.preco_sugerido);
  const ordem = Array.isArray(op.fotos?.ordem) ? (op.fotos.ordem as unknown[]).map(String) : null;
  const lugar = (f: any) => { const i = ordem ? ordem.indexOf(String(f.storage_path)) : -1; return i === -1 ? 1e6 : i; };
  const ordenadas = ordem ? [...d.fotos].sort((x: any, y: any) => lugar(x) - lugar(y)) : d.fotos;
  // a ordem arrumada em outro destino não tem a capa deste: ela vai na frente
  if (ordem && d.capaDestino && !ordem.includes(d.capaDestino)) {
    const i = ordenadas.findIndex((f: any) => f.storage_path === d.capaDestino);
    if (i > 0) ordenadas.unshift(...ordenadas.splice(i, 1));
  }
  const fotos = ordenadas
    .slice(0, lim.fotos).map((f: any) => ({ path: f.storage_path as string, tipo: f.tipo as string }));
  const problemas = {
    titulo: [
      ...(!d.textoAprovado ? ["aprove o texto (bloco 1) antes de enviar"] : []),
      ...(!titulo ? ["o anúncio está sem título"] : []),
      ...(titulo.length > lim.titulo ? [`título com ${titulo.length} caracteres (${lim.quem} aceita até ${lim.titulo})`] : []),
    ],
    descricao: [
      ...(!d.textoAprovado ? ["aprove o texto (bloco 1) antes de enviar"] : []),
      ...(descricao.length < lim.descMin ? [`descrição muito curta (${lim.quem} pede ao menos ${lim.descMin} caracteres)`] : []),
      ...(descricao.length > lim.descMax ? [`descrição com ${descricao.length} caracteres (${lim.quem} aceita até ${lim.descMax.toLocaleString("pt-BR")})`] : []),
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
  const avisos: string[] = [...d.avisosCapa];
  if (existentes.length) avisos.push(`este produto JÁ tem ${existentes.length} anúncio(s) nesta loja: criar outro gera anúncio duplicado. Para melhorar o que existe, use "Atualizar anúncio existente"`);
  if (d.fotos.length > 9) avisos.push(`há ${d.fotos.length} fotos aprovadas; a Shopee aceita 9 — vão as 9 primeiras (capa na frente)`);
  if (d.produto?.tipo === "V") avisos.push("este produto tem variações no Tiny: criar gera um anúncio simples, só deste SKU");

  // medidas: o que a pessoa digitou → o que já foi salvo → cadastro do Tiny → o que a gestão sabe → embalagem padrão
  const tiny = await medidasTiny(d.cad?.id_tiny ? Number(d.cad.id_tiny) : null);
  const med = await medidasDoAnuncio(d, op, tiny);
  const medidas = med.medidas;
  avisos.push(...med.avisos);
  if (med.faltaPeso) pendencias.push("informe o peso da embalagem (kg): o cadastro está sem peso e não deu para calcular");

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
    corpo, pendencias, avisos, medidas, medidasSalvar: med.salvar, tiny,
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
  const pendencias: string[] = []; const avisos: string[] = [...d.avisosCapa];
  if (!campos.titulo && !campos.descricao && !campos.fotos && !campos.preco) pendencias.push("marque ao menos um item para atualizar");
  if (campos.titulo) pendencias.push(...b.problemas.titulo);
  if (campos.descricao) pendencias.push(...b.problemas.descricao);
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
  // FOTOS: por padrão as atuais FICAM e as novas entram. A pessoa escolhe quais atuais manter,
  // quais novas incluir e se as novas vão para o início (a primeira vira a capa) ou para o fim.
  const idsAtuais = ((it.image?.image_id_list ?? []) as unknown[]).map(String);
  const fotosAtuais = ((it.image?.image_url_list ?? []) as string[]);
  const todasNovas = d.fotos.map((f: any) => ({ path: f.storage_path as string, tipo: f.tipo as string }));
  const selF = (op.fotos ?? {}) as Record<string, any>;
  const manter = fotosQueFicam(selF, idsAtuais);
  const novas = Array.isArray(selF.novas) ? todasNovas.filter((f) => (selF.novas as unknown[]).map(String).includes(f.path)) : todasNovas;
  const posicao: "inicio" | "fim" = selF.posicao === "inicio" || selF.posicao === "fim" ? selF.posicao
    : (String(novas[0]?.tipo ?? "").startsWith("capa_") ? "inicio" : "fim");
  if (campos.fotos) {
    const total = manter.length + novas.length;
    if (total === 0) pendencias.push("o anúncio precisa de ao menos 1 foto");
    if (total > 9) pendencias.push(`a Shopee aceita 9 fotos e há ${total} marcadas (${manter.length} atuais + ${novas.length} novas): desmarque ${total - 9}`);
    if (novas.length === 0 && manter.length === idsAtuais.length) pendencias.push("nada muda nas fotos: desmarque \"Fotos\" ou escolha o que entra e o que sai");
    if (manter.length < idsAtuais.length) avisos.push(`${idsAtuais.length - manter.length} foto(s) atual(is) do anúncio sai(em)`);
  }
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
    corpo, corpoPreco, pendencias: [...new Set(pendencias)], avisos, campos, antes, plano: { manter, novas, posicao, atuais: idsAtuais },
    previa: {
      loja: loja.nome, sku: String(d.r.sku), titulo: b.titulo, descricao: b.descricao, preco: b.preco, fotos: todasNovas,
      fotos_plano: { manter, novas: novas.map((f) => f.path), posicao },
      alvo: { ...alvo, n_variacoes: nVariacoes, situacao: it.item_status ?? null }, campos,
      atual: { titulo: antes.titulo, descricao: antes.descricao, fotos: idsAtuais.map((id, i) => ({ id, url: fotosAtuais[i] ?? "" })), preco: antes.preco },
    },
  };
}

// ---------------------------------------------------------------- Mercado Livre
const ML_HOST = "https://api.mercadolibre.com";
const CONTA_ML: Record<string, { user_id: number; nome: string }> = {
  ottz: { user_id: 1107117809, nome: "Mercado Livre · Ottz Pet" },
  svl: { user_id: 1299638625, nome: "Mercado Livre · SVL" },
};
const TIPOS_ML = [{ id: "gold_special", nome: "Clássico" }, { id: "gold_pro", nome: "Premium" }];
// características que a função preenche sozinha (não entram no formulário)
const ATRIB_AUTO_ML = new Set(["SELLER_SKU", "GTIN", "EMPTY_GTIN_REASON", "ITEM_CONDITION", "SELLER_PACKAGE_HEIGHT",
  "SELLER_PACKAGE_WIDTH", "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WEIGHT", "SELLER_PACKAGE_TYPE"]);
type RespMl = { status: number; body: any };
type ContaMl = { user_id: number; nome: string };
const mlOk = (r: RespMl) => r.status >= 200 && r.status < 300;

/** Token DA CONTA (nunca "o mais recente": são duas contas). */
async function tokenMl(userId: number): Promise<string> {
  const { data, error } = await db.from("oauth_tokens_ml").select("access_token, expires_at").eq("user_id", userId).maybeSingle();
  if (error || !data) throw new Error(`a conta ${userId} do Mercado Livre não está conectada`);
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token do Mercado Livre vencido — a renovação automática roda a cada 30 min; tente de novo em instantes");
  return data.access_token as string;
}
async function mlApi(token: string, path: string, metodo = "GET", corpo?: unknown): Promise<RespMl> {
  const r = await fetch(`${ML_HOST}${path}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { message: txt.slice(0, 300) }; }
  return { status: r.status, body };
}
/** Separa o que o ML devolve em `cause`: erro bloqueia, aviso só informa. */
function causasMl(body: any): { erros: string[]; avisos: string[] } {
  const erros: string[] = []; const avisos: string[] = [];
  for (const c of ((body?.cause ?? []) as any[])) {
    const code = String(c?.code ?? ""); const msg = String(c?.message ?? "").slice(0, 240);
    // aparecem em todo anúncio nosso, inclusive nos que já existem: não dizem nada
    if (code === "shipping.lost_me1_by_user" || code === "shipping.free_shipping.cost_exceeded") continue;
    // característica recomendada (sem *) em branco: já aparece no formulário, não precisa repetir
    if (code === "item.attribute.missing_catalog_required") continue;
    if (code === "item.shipping.mandatory_free_shipping") { avisos.push("neste preço o Mercado Livre põe frete grátis obrigatório (o custo do frete sai do nosso repasse)"); continue; }
    const t = /missing_conditional_required/.test(code) && /GTIN/.test(msg)
      ? "esta categoria exige o código de barras (GTIN/EAN): informe o código do produto"
      : `${code}: ${msg}`;
    (String(c?.type) === "error" ? erros : avisos).push(t);
  }
  return { erros, avisos };
}
/** Texto do motivo de uma recusa do ML. */
function motivoMl(r: RespMl): string {
  const c = causasMl(r.body);
  return (c.erros.join(" · ") || `${r.body?.error ?? r.status} ${r.body?.message ?? ""}`).trim().slice(0, 450);
}
/** Anúncios da conta que vendem este SKU (ao vivo: a gestão só espelha a conta Ottz). */
async function existentesMl(token: string, userId: number, sku: string): Promise<Existente[]> {
  const s = await mlApi(token, `/users/${userId}/items/search?seller_sku=${encodeURIComponent(sku)}&limit=50`);
  if (!mlOk(s)) throw new Error(`não consegui procurar os anúncios do SKU no Mercado Livre: ${motivoMl(s)}`);
  const ids = ((s.body?.results ?? []) as unknown[]).map(String).slice(0, 20);
  if (!ids.length) return [];
  const mg = await mlApi(token, `/items?ids=${ids.join(",")}&attributes=id,title,price,status,permalink,sold_quantity,catalog_listing,variations`);
  return ((Array.isArray(mg.body) ? mg.body : []) as any[]).map((x) => x?.body)
    .filter((it) => it?.id && ["active", "paused"].includes(String(it.status)))
    .map((it) => ({
      item_id: String(it.id), nome: it.title ?? null, status: String(it.status), url: String(it.permalink ?? ""),
      variacao: false, model_id: null, nome_variacao: null, preco: num(it.price),
      vendas: Number(it.sold_quantity) || 0, catalogo: it.catalog_listing === true,
    }))
    // primeiro os que dá para editar (anúncio de catálogo só aceita preço), depois os ativos, depois quem mais vendeu
    .sort((a, b) => Number(a.catalogo) - Number(b.catalogo) || Number(a.status !== "active") - Number(b.status !== "active") || (b.vendas ?? 0) - (a.vendas ?? 0));
}
async function existentesMlLojas(sku: string): Promise<Record<string, Existente[] | null>> {
  const out: Record<string, Existente[] | null> = { ottz: null, svl: null };
  await Promise.all(Object.entries(CONTA_ML).map(async ([k, c]) => {
    try { out[k] = await existentesMl(await tokenMl(c.user_id), c.user_id, sku); } catch { out[k] = null; }
  }));
  return out;
}
/** Nome, caminho e limites de uma categoria do ML. */
async function categoriaMl(token: string, id: string) {
  const r = await mlApi(token, `/categories/${encodeURIComponent(id)}`);
  const c = r.body ?? {};
  return {
    existe: mlOk(r) && !!c.id, id,
    caminho: ((c.path_from_root ?? []) as any[]).map((x) => String(x.name)).join(" > ") || String(c.name ?? id),
    final: ((c.children_categories ?? []) as any[]).length === 0,
    titulo_max: Number(c.settings?.max_title_length) || 60,
    fotos_max: Math.min(12, Number(c.settings?.max_pictures_per_item) || 10),
  };
}
/** Envia uma foto ao ML e devolve o id dela. */
async function subirFotosMl(token: string, fotos: { path: string; tipo: string }[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of fotos) {
    const dl = await db.storage.from(BUCKET).download(f.path);
    if (dl.error || !dl.data) throw new Error(`não consegui ler a foto ${f.tipo} do armazenamento`);
    const mime = (dl.data.type || "image/png").split(";")[0];
    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(await dl.data.arrayBuffer())], { type: mime }), `${f.tipo}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`);
    const r = await fetch(`${ML_HOST}/pictures/items/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
    const txt = await r.text();
    let b: any = null; try { b = JSON.parse(txt); } catch { b = { message: txt.slice(0, 200) }; }
    if (!r.ok || !b?.id) throw new Error(`o Mercado Livre recusou a foto ${f.tipo}: ${b?.error ?? r.status} ${b?.message ?? ""}`.trim());
    ids.push(String(b.id));
  }
  return ids;
}
/** Escolha de fotos do modo atualizar (igual nos dois marketplaces). */
function planoFotos(d: Dados, op: Opcoes, idsAtuais: string[]) {
  const todasNovas = d.fotos.map((f: any) => ({ path: f.storage_path as string, tipo: f.tipo as string }));
  const selF = (op.fotos ?? {}) as Record<string, any>;
  const manter = fotosQueFicam(selF, idsAtuais);
  const novas = Array.isArray(selF.novas) ? todasNovas.filter((f) => (selF.novas as unknown[]).map(String).includes(f.path)) : todasNovas;
  const posicao: "inicio" | "fim" = selF.posicao === "inicio" || selF.posicao === "fim" ? selF.posicao
    : (String(novas[0]?.tipo ?? "").startsWith("capa_") ? "inicio" : "fim");
  return { todasNovas, manter, novas, posicao };
}

// ---------------------------------------------------------------- Mercado Livre · CRIAR
async function montarCriarMl(d: Dados, op: Opcoes, token: string, conta: ContaMl, existentes: Existente[]) {
  const titulo0 = String(d.r.titulo ?? "").trim();
  // categoria: o ML sugere pelo título (e já adianta algumas características)
  const disc = titulo0 ? await mlApi(token, `/sites/MLB/domain_discovery/search?limit=4&q=${encodeURIComponent(titulo0)}`) : null;
  const palpites = (Array.isArray(disc?.body) ? disc!.body : []) as any[];
  const idsSug = [...new Set(palpites.map((x) => String(x.category_id)).filter(Boolean))];
  const categoriaId = String(op.categoria_id ?? idsSug[0] ?? "").trim() || null;
  const idsCat = [...new Set([...(categoriaId ? [categoriaId] : []), ...idsSug])];
  const [cats, atrR, tiny, nPro, nEsp] = await Promise.all([
    Promise.all(idsCat.map((id) => categoriaMl(token, id))),
    categoriaId ? mlApi(token, `/categories/${encodeURIComponent(categoriaId)}/attributes`) : Promise.resolve(null),
    medidasTiny(d.cad?.id_tiny ? Number(d.cad.id_tiny) : null),
    // tipo de anúncio padrão = o que a conta mais usa hoje
    mlApi(token, `/users/${conta.user_id}/items/search?status=active&listing_type_id=gold_pro&limit=1`),
    mlApi(token, `/users/${conta.user_id}/items/search?status=active&listing_type_id=gold_special&limit=1`),
  ]);
  const cat = categoriaId ? cats.find((c) => c.id === categoriaId) ?? null : null;
  const lim: Limites = { quem: "o Mercado Livre", titulo: cat?.titulo_max ?? 60, descMin: 10, descMax: 50000, fotos: cat?.fotos_max ?? 10 };
  const b = base(d, op, lim);
  const pendencias = [...new Set([...b.problemas.titulo, ...b.problemas.descricao, ...b.problemas.fotos, ...b.problemas.preco])];
  const avisos: string[] = [...d.avisosCapa];
  if (existentes.length) avisos.push(`este produto JÁ tem ${existentes.length} anúncio(s) nesta conta: criar outro gera anúncio duplicado. Para melhorar o que existe, use "Atualizar anúncio existente"`);
  if (d.fotos.length > lim.fotos) avisos.push(`há ${d.fotos.length} fotos aprovadas; esta categoria aceita ${lim.fotos} — vão as ${lim.fotos} primeiras (capa na frente)`);
  if (!categoriaId) pendencias.push("o Mercado Livre não sugeriu categoria para este título — informe o código da categoria (MLB...)");
  else if (!cat?.existe) pendencias.push(`a categoria ${categoriaId} não existe no Mercado Livre`);
  else if (!cat.final) pendencias.push("a categoria escolhida não é uma categoria final do Mercado Livre");

  const med = await medidasDoAnuncio(d, op, tiny);
  const medidas = med.medidas;
  avisos.push(...med.avisos);
  if (med.faltaPeso) pendencias.push("informe o peso da embalagem (kg): o cadastro está sem peso e não deu para calcular");

  // características da categoria: obrigatórias (*) e as que o ML pede para a ficha
  const previstos = new Map<string, string>();
  for (const a of ((palpites.find((x) => String(x.category_id) === categoriaId)?.attributes ?? []) as any[])) {
    if (a?.id && a?.value_name) previstos.set(String(a.id), String(a.value_name));
  }
  const digitados = (op.atributos ?? {}) as Record<string, unknown>;
  const listaAtr = (Array.isArray(atrR?.body) ? atrR!.body : []) as any[];
  const atributos = listaAtr
    .filter((a) => a?.id && !ATRIB_AUTO_ML.has(String(a.id)) && !a.tags?.hidden && !a.tags?.read_only && !a.tags?.fixed
      && (a.tags?.required || a.tags?.catalog_required || a.tags?.conditional_required))
    .map((a) => {
      const id = String(a.id);
      const digitado = typeof digitados[id] === "string" ? String(digitados[id]).trim() : "";
      const unidades = ((a.allowed_units ?? []) as any[]).map((u) => String(u.name)).slice(0, 5);
      return {
        id, nome: String(a.name ?? id), obrigatorio: a.tags?.required === true,
        valor: digitado || (id === "BRAND" ? String(d.produto?.marca ?? "").trim() : "") || previstos.get(id) || "",
        opcoes: ((a.values ?? []) as any[]).slice(0, 80).map((v) => String(v.name)),
        ids: ((a.values ?? []) as any[]).slice(0, 80).map((v) => String(v.id)),
        dica: a.hint ? String(a.hint).slice(0, 80) : (unidades.length ? `número + unidade (${unidades.join(", ")})` : null),
      };
    })
    .sort((x, y) => Number(y.obrigatorio) - Number(x.obrigatorio));
  for (const a of atributos) if (a.obrigatorio && !a.valor) pendencias.push(`preencha "${a.nome}" (obrigatório nesta categoria)`);

  const gtin = String(op.gtin ?? d.extra?.gtin ?? tiny.gtin ?? "").replace(/\D/g, "") || null;
  const total = (r: RespMl) => Number(r.body?.paging?.total) || 0;
  const tipo = op.tipo_anuncio === "gold_pro" || op.tipo_anuncio === "gold_special" ? String(op.tipo_anuncio)
    : (total(nPro) > total(nEsp) ? "gold_pro" : "gold_special");
  const estoque = Math.max(1, Math.floor(num(op.estoque) ?? 1));
  const foraDoAr = op.fora_do_ar !== false;
  if (!foraDoAr) avisos.push(`o anúncio nasce NO AR com ${estoque} unidade(s) de estoque, antes de o Tiny assumir o estoque pelo SKU`);
  avisos.push("no Mercado Livre o título do anúncio é montado a partir do nome enviado e das características: pode sair um pouco diferente do texto aprovado");

  const cm = (v: number | null) => `${Math.max(1, Math.ceil(v ?? 0))} cm`;
  const corpo = {
    family_name: b.titulo, category_id: categoriaId, price: b.preco, currency_id: "BRL", available_quantity: estoque,
    buying_mode: "buy_it_now", condition: "new", listing_type_id: tipo,
    pictures: [] as Record<string, string>[],
    sale_terms: [{ id: "WARRANTY_TYPE", value_name: "Garantia do vendedor" }, { id: "WARRANTY_TIME", value_name: "30 dias" }],
    shipping: { mode: "me2", local_pick_up: false, free_shipping: false },
    attributes: [
      ...atributos.filter((a) => a.valor).map((a) => {
        const i = a.opcoes.findIndex((o) => o.toLowerCase() === a.valor.toLowerCase());
        return i >= 0 ? { id: a.id, value_id: a.ids[i], value_name: a.opcoes[i] } : { id: a.id, value_name: a.valor };
      }),
      { id: "SELLER_SKU", value_name: String(d.r.sku) },
      gtin ? { id: "GTIN", value_name: gtin }
        : (d.produto?.tipo === "K" ? { id: "EMPTY_GTIN_REASON", value_id: "17055159", value_name: "O produto é um kit ou um pack" }
          : { id: "EMPTY_GTIN_REASON", value_id: "17055160", value_name: "O produto não tem código cadastrado" }),
      { id: "SELLER_PACKAGE_HEIGHT", value_name: cm(medidas.altura_cm) }, { id: "SELLER_PACKAGE_WIDTH", value_name: cm(medidas.largura_cm) },
      { id: "SELLER_PACKAGE_LENGTH", value_name: cm(medidas.comprimento_cm) },
      { id: "SELLER_PACKAGE_WEIGHT", value_name: `${Math.max(1, Math.round((medidas.peso_kg ?? 0) * 1000))} g` },
    ],
  };

  // VALIDADOR do ML: confere o corpo sem criar nada (as fotos vão como endereço temporário)
  if (cat?.existe && cat.final && b.titulo && b.preco && medidas.peso_kg && medidas.comprimento_cm && medidas.largura_cm && medidas.altura_cm) {
    const { data: assinadas } = b.fotos.length ? await db.storage.from(BUCKET).createSignedUrls(b.fotos.map((f) => f.path), 900) : { data: [] as any[] };
    const v = await mlApi(token, "/items/validate", "POST", { ...corpo, pictures: ((assinadas ?? []) as any[]).filter((x) => x?.signedUrl).map((x) => ({ source: x.signedUrl })) });
    const c = causasMl(v.body);
    // obrigatória em branco já virou pendência acima ("preencha ..."): não repete a versão do ML
    const jaAvisado = atributos.some((a) => a.obrigatorio && !a.valor);
    pendencias.push(...c.erros.filter((e) => !(jaAvisado && e.startsWith("item.attributes.missing_required"))).map((e) => `Mercado Livre: ${e}`));
    avisos.push(...c.avisos);
    if (!mlOk(v) && ((v.body?.cause ?? []) as any[]).length === 0) pendencias.push(`Mercado Livre: ${v.body?.error ?? v.status} ${v.body?.message ?? ""}`.trim());
  }

  return {
    corpo, pendencias: [...new Set(pendencias)], avisos: [...new Set(avisos)], medidas, medidasSalvar: med.salvar, tiny, gtin,
    previa: {
      loja: conta.nome, titulo: b.titulo, descricao: b.descricao, preco: b.preco, estoque, fora_do_ar: foraDoAr, sku: String(d.r.sku), medidas,
      categoria: cat ? { id: cat.id, caminho: cat.caminho } : (categoriaId ? { id: categoriaId, caminho: categoriaId } : null),
      categorias_sugeridas: idsSug.map((id) => ({ id, caminho: cats.find((c) => c.id === id)?.caminho ?? id })),
      fotos: b.fotos, ean: gtin, tipo_anuncio: tipo, tipos_anuncio: TIPOS_ML,
      atributos: atributos.map((a) => ({ id: a.id, nome: a.nome, obrigatorio: a.obrigatorio, valor: a.valor, opcoes: a.opcoes, dica: a.dica })),
      limites: { titulo: lim.titulo, fotos: lim.fotos },
    },
  };
}

// ---------------------------------------------------------------- Mercado Livre · ATUALIZAR
async function montarAtualizarMl(d: Dados, op: Opcoes, token: string, conta: ContaMl, alvo: Existente) {
  const [ri, rd] = await Promise.all([mlApi(token, `/items/${alvo.item_id}`), mlApi(token, `/items/${alvo.item_id}/description`)]);
  const it = ri.body;
  if (!mlOk(ri) || !it?.id) throw new Error(`não consegui ler o anúncio ${alvo.item_id} no Mercado Livre: ${motivoMl(ri)}`);
  const cat = await categoriaMl(token, String(it.category_id));
  const lim: Limites = { quem: "o Mercado Livre", titulo: cat.titulo_max, descMin: 10, descMax: 50000, fotos: cat.fotos_max };
  const b = base(d, op, lim);
  const campos = {
    titulo: op.campos?.titulo === true, // título: só se a pessoa marcar (o ML recusa em anúncio que já vendeu)
    descricao: op.campos?.descricao !== false, fotos: op.campos?.fotos !== false, preco: op.campos?.preco === true,
  };
  const pendencias: string[] = []; const avisos: string[] = [...d.avisosCapa];
  if (!campos.titulo && !campos.descricao && !campos.fotos && !campos.preco) pendencias.push("marque ao menos um item para atualizar");
  if (campos.titulo) pendencias.push(...b.problemas.titulo);
  if (campos.descricao) pendencias.push(...b.problemas.descricao);
  if (campos.preco) pendencias.push(...b.problemas.preco);

  const vendas = Number(it.sold_quantity) || 0;
  const nVariacoes = ((it.variations ?? []) as any[]).length;
  if (it.catalog_listing === true && (campos.titulo || campos.descricao || campos.fotos)) {
    pendencias.push("este é um anúncio de CATÁLOGO: título, descrição e fotos vêm da ficha do Mercado Livre e não podem ser trocados por aqui (só o preço)");
  }
  if (campos.titulo && vendas > 0) pendencias.push(`o Mercado Livre não deixa trocar o título de anúncio que já vendeu (este tem ${vendas} venda(s)): desmarque "Título"`);
  if (nVariacoes > 0 && (campos.fotos || campos.preco)) {
    pendencias.push(`este anúncio tem ${nVariacoes} variações (modelo antigo): fotos e preço são por variação e ainda não são trocados por aqui — desmarque "Fotos" e "Preço"`);
  }
  const fotosIt = ((it.pictures ?? []) as any[]).map((x) => ({ id: String(x.id), url: String(x.secure_url ?? x.url ?? "") }));
  const idsAtuais = fotosIt.map((f) => f.id);
  const { todasNovas, manter, novas, posicao } = planoFotos(d, op, idsAtuais);
  if (campos.fotos) {
    const total = manter.length + novas.length;
    if (total === 0) pendencias.push("o anúncio precisa de ao menos 1 foto");
    if (total > lim.fotos) pendencias.push(`esta categoria aceita ${lim.fotos} fotos e há ${total} marcadas (${manter.length} atuais + ${novas.length} novas): desmarque ${total - lim.fotos}`);
    if (novas.length === 0 && manter.length === idsAtuais.length) pendencias.push("nada muda nas fotos: desmarque \"Fotos\" ou escolha o que entra e o que sai");
    if (manter.length < idsAtuais.length) avisos.push(`${idsAtuais.length - manter.length} foto(s) atual(is) do anúncio sai(em)`);
  }
  if (campos.preco) avisos.push("troca de preço: se o anúncio estiver em promoção, o Mercado Livre pode recusar ou a promoção pode ser afetada");
  if (String(it.status) !== "active") avisos.push(`o anúncio está com a situação "${it.status}" no Mercado Livre`);
  const descAtual = mlOk(rd) ? String(rd.body?.plain_text ?? "") : "";
  const antes = { titulo: String(it.title ?? ""), descricao: descAtual, fotos: fotosIt.map((f) => f.url), picture_ids: idsAtuais, preco: num(it.price) };
  return {
    pendencias: [...new Set(pendencias)], avisos, campos, antes, plano: { manter, novas, posicao, atuais: idsAtuais },
    temDescricao: mlOk(rd), temFamilia: !!it.family_name, titulo: b.titulo, descricao: b.descricao, preco: b.preco,
    previa: {
      loja: conta.nome, sku: String(d.r.sku), titulo: b.titulo, descricao: b.descricao, preco: b.preco, fotos: todasNovas,
      fotos_plano: { manter, novas: novas.map((f) => f.path), posicao },
      alvo: { ...alvo, url: String(it.permalink ?? alvo.url), vendas, n_variacoes: nVariacoes, situacao: String(it.status ?? "") }, campos,
      atual: { titulo: antes.titulo, descricao: antes.descricao, fotos: fotosIt, preco: antes.preco },
      limites: { titulo: lim.titulo, fotos: lim.fotos },
    },
  };
}

// ---------------------------------------------------------------- Mercado Livre · fluxo
async function fluxoMl(d: Dados, op: Opcoes, modulo: string, body: Record<string, any>, quem: Quem): Promise<Response> {
  const conta = CONTA_ML[d.r.empresa] ?? CONTA_ML.ottz;
  const token = await tokenMl(conta.user_id);
  const existentes = await existentesMl(token, conta.user_id, String(d.r.sku));
  const modo: "criar" | "atualizar" = op.modo === "criar" || op.modo === "atualizar" ? op.modo : (existentes.length ? "atualizar" : "criar");
  const alvo = modo === "atualizar" ? (existentes.find((e) => e.item_id === String(op.item_id ?? "")) ?? existentes[0]) : null;
  if (modo === "atualizar" && !alvo) return json({ ok: false, erro: "este produto não tem anúncio nesta conta para atualizar — use Criar anúncio novo" }, 400);
  const mC = modo === "criar" ? await montarCriarMl(d, op, token, conta, existentes) : null;
  const mA = modo === "atualizar" ? await montarAtualizarMl(d, op, token, conta, { ...alvo! }) : null;
  const m = (mC ?? mA)!;
  if (mA && mA.campos.fotos && existentes.length > 1) {
    mA.avisos.push(`este SKU tem ${existentes.length} anúncios nesta conta: no Mercado Livre, anúncios do mesmo produto podem compartilhar as fotos — a troca pode aparecer nos outros também`);
  }

  if (modulo === "previa") {
    return json({ ok: true, disponivel: true, canal: "mercado_livre", modo, existentes, previa: m.previa, pendencias: m.pendencias, avisos: m.avisos, publicacoes: d.publicacoes });
  }
  if (modulo !== "enviar") return json({ ok: false, erro: "use ?modulo=existentes, previa ou enviar" }, 400);
  if (body.confirmar !== true) return json({ ok: false, erro: "envio exige confirmar: true" }, 400);
  if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
  if (modo === "criar") {
    const jaFoi = d.publicacoes.find((p) => p.canal === "mercado_livre" && p.empresa === d.r.empresa && p.estado === "publicado" && p.operacao !== "atualizar");
    if (jaFoi && op.de_novo !== true) return json({ ok: false, erro: `este rascunho já criou o anúncio ${jaFoi.item_id}. Para criar outro, marque "criar outro anúncio mesmo assim".` }, 409);
  }
  const emCurso = d.publicacoes.find((p) => p.estado === "enviando" && Date.now() - new Date(p.criado_em).getTime() < 3 * 60_000);
  if (emCurso) return json({ ok: false, erro: "já há um envio em andamento para este rascunho — aguarde" }, 409);

  const { data: pub, error: ePub } = await db.from("ia_publicacao").insert({
    rascunho_id: d.r.id, sku: d.r.sku, canal: "mercado_livre", empresa: d.r.empresa, shop_id: conta.user_id, estado: "enviando", operacao: modo,
    item_id: mA ? mA.previa.alvo.item_id : null, fora_do_ar: mC ? mC.previa.fora_do_ar : null, criado_por: quem.id, criado_por_nome: quem.nome,
  }).select("id").single();
  if (ePub || !pub) return json({ ok: false, erro: `banco: ${ePub?.message}` }, 500);
  const respostas: Record<string, unknown> = {};
  const enxuto = (r: RespMl) => ({ status: r.status, ...(mlOk(r) ? {} : { erro: r.body?.error ?? null, mensagem: r.body?.message ?? null, causas: r.body?.cause ?? null }) });
  const registro = () => (mC ? mC.corpo : { campos: mA!.campos, antes: mA!.antes, titulo: mA!.campos.titulo ? mA!.titulo : null, preco: mA!.campos.preco ? mA!.preco : null,
    descricao: mA!.campos.descricao ? mA!.descricao : null,
    fotos: { mantidas: mA!.plano.manter, novas: mA!.plano.novas.map((f) => f.path), posicao: mA!.plano.posicao } });
  const falhar = async (erro: string) => {
    await db.from("ia_publicacao").update({ estado: "erro", erro: erro.slice(0, 500), enviado: registro(), resposta: respostas }).eq("id", pub.id);
    return json({ ok: false, erro, resposta: respostas }, 200);
  };

  // ------------------------------------------------ CRIAR
  if (mC) {
    await db.from("ia_produto_extra").upsert({ sku: d.r.sku, ...mC.medidasSalvar, gtin: mC.gtin, ncm: d.extra?.ncm ?? mC.tiny.ncm ?? null }, { onConflict: "sku" });
    try { mC.corpo.pictures = (await subirFotosMl(token, mC.previa.fotos)).map((id) => ({ id })); }
    catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
    // sem repetição automática: um POST repetido criaria anúncio em dobro
    const resp = await mlApi(token, "/items", "POST", mC.corpo);
    const itemId = resp.body?.id ? String(resp.body.id) : null;
    respostas.item = mlOk(resp) ? { status: resp.status, id: itemId, permalink: resp.body?.permalink ?? null, situacao: resp.body?.status ?? null,
      titulo: resp.body?.title ?? null, user_product_id: resp.body?.user_product_id ?? null, avisos: resp.body?.warnings ?? null } : enxuto(resp);
    if (!mlOk(resp) || !itemId) return await falhar(`o Mercado Livre recusou o anúncio: ${motivoMl(resp)}`);
    const url = String(resp.body?.permalink ?? "");
    const avisos = [...mC.avisos];
    // pausa primeiro (para não ficar no ar com o estoque inicial), depois a descrição
    let foraDoAr = false;
    if (mC.previa.fora_do_ar) {
      const pz = await mlApi(token, `/items/${itemId}`, "PUT", { status: "paused" });
      respostas.pausa = enxuto(pz);
      foraDoAr = mlOk(pz);
      if (!foraDoAr) avisos.unshift(`ATENÇÃO: o anúncio foi criado mas NÃO consegui pausar (${motivoMl(pz)}) — ele está NO AR; pause no Mercado Livre`);
    }
    const dsc = await mlApi(token, `/items/${itemId}/description`, "POST", { plain_text: mC.previa.descricao });
    respostas.descricao = enxuto(dsc);
    if (!mlOk(dsc)) avisos.unshift(`o anúncio foi criado, mas o Mercado Livre recusou a descrição (${motivoMl(dsc)}) — use "Atualizar anúncio existente" para mandar de novo`);
    await db.from("ia_publicacao").update({ estado: "publicado", item_id: itemId, url, fora_do_ar: foraDoAr, enviado: mC.corpo, resposta: respostas }).eq("id", pub.id);
    await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
    return json({ ok: true, modo, item_id: itemId, url, fora_do_ar: foraDoAr, titulo_final: resp.body?.title ?? null, avisos });
  }

  // ------------------------------------------------ ATUALIZAR (um passo por vez; para no primeiro que o ML recusar)
  const a = mA!;
  const id = a.previa.alvo.item_id;
  const feitos: string[] = [];
  const parcial = () => (feitos.length ? `${feitos.join(", ")} atualizado(s), mas ` : "");
  if (a.campos.fotos) {
    let lista: string[];
    try {
      const novosIds = await subirFotosMl(token, a.plano.novas);
      lista = ordemFinal(op, a.plano, novosIds, d.capaDestino);
    } catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
    const r = await mlApi(token, `/items/${id}`, "PUT", { pictures: lista.map((x) => ({ id: x })) });
    respostas.fotos = { ...enxuto(r), enviadas: lista };
    if (!mlOk(r)) return await falhar(`o Mercado Livre recusou as fotos: ${motivoMl(r)}`);
    feitos.push("fotos");
  }
  if (a.campos.descricao) {
    let r = a.temDescricao
      ? await mlApi(token, `/items/${id}/description?api_version=2`, "PUT", { plain_text: a.descricao })
      : await mlApi(token, `/items/${id}/description`, "POST", { plain_text: a.descricao });
    // anúncio sem descrição cadastrada responde 404 no PUT: aí cria (não duplica nada)
    if (!mlOk(r) && a.temDescricao && r.status === 404) r = await mlApi(token, `/items/${id}/description`, "POST", { plain_text: a.descricao });
    respostas.descricao = enxuto(r);
    if (!mlOk(r)) return await falhar(`${parcial()}o Mercado Livre recusou a descrição: ${motivoMl(r)}`);
    feitos.push("descrição");
  }
  if (a.campos.titulo) {
    // no modelo novo o nome do anúncio é o family_name; no antigo, title. Tenta o do modelo do anúncio e, se recusar, o outro.
    const tentativas = a.temFamilia ? [{ family_name: a.titulo }, { title: a.titulo }] : [{ title: a.titulo }, { family_name: a.titulo }];
    let r = await mlApi(token, `/items/${id}`, "PUT", tentativas[0]);
    respostas.titulo = enxuto(r);
    if (!mlOk(r)) { r = await mlApi(token, `/items/${id}`, "PUT", tentativas[1]); respostas.titulo_2 = enxuto(r); }
    if (!mlOk(r)) return await falhar(`${parcial()}o Mercado Livre recusou o título: ${motivoMl(r)}`);
    feitos.push("título");
  }
  if (a.campos.preco) {
    const r = await mlApi(token, `/items/${id}`, "PUT", { price: a.preco });
    respostas.preco = enxuto(r);
    if (!mlOk(r)) return await falhar(`${parcial()}o Mercado Livre recusou o preço: ${motivoMl(r)}`);
    feitos.push("preço");
  }
  await db.from("ia_publicacao").update({ estado: "publicado", url: a.previa.alvo.url, enviado: registro(), resposta: respostas }).eq("id", pub.id);
  await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
  return json({ ok: true, modo, item_id: id, url: a.previa.alvo.url, atualizados: feitos, avisos: a.avisos });
}

// ---------------------------------------------------------------- Amazon (v7: ATUALIZAR anúncio existente)
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const CONTA_AMZ: Record<string, { shop_id: number; nome: string }> = {
  ottz: { shop_id: 900001, nome: "Amazon · ACZ Pet" },
  svl: { shop_id: 900002, nome: "Amazon · SVL" },
};
// a 1ª é a capa; a Amazon aceita a principal + 8
const FOTOS_AMZ = ["main_product_image_locator", ...Array.from({ length: 8 }, (_, i) => `other_product_image_locator_${i + 1}`)];
const LIM_AMZ = { titulo: 200, descricao: 2000, bullet: 500, bullets: 5, fotos: FOTOS_AMZ.length };
type ContaAmz = { shop_id: number; nome: string; token: string; seller: string; mkt: string };

/** Token e código de vendedor DA CONTA (shop 900001 = ACZ, 900002 = SVL). */
async function contaAmz(empresa: string): Promise<ContaAmz> {
  const c = CONTA_AMZ[empresa] ?? CONTA_AMZ.ottz;
  const { data } = await db.from("oauth_tokens_amazon").select("access_token, expires_at, merchant_token, marketplace_id").eq("shop_id", c.shop_id).maybeSingle();
  if (!data) throw new Error(`a conta ${c.nome} não está conectada`);
  if (!data.merchant_token) throw new Error(`falta o código de vendedor (Merchant Token) da conta ${c.nome}`);
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token da Amazon vencido — a renovação automática roda a cada 20 min; tente de novo em instantes");
  return { ...c, token: String(data.access_token), seller: String(data.merchant_token), mkt: String(data.marketplace_id || MKT_BR) };
}
/** Um anúncio (SKU da Amazon) da conta: GET lê; PATCH atualiza — com mode=VALIDATION_PREVIEW a Amazon só valida. */
async function amzItem(c: ContaAmz, skuAmz: string, metodo = "GET", params: Record<string, string> = {}, corpo?: unknown): Promise<RespMl> {
  const url = new URL(`${SPAPI}/listings/2021-08-01/items/${encodeURIComponent(c.seller)}/${encodeURIComponent(skuAmz)}`);
  url.searchParams.set("marketplaceIds", c.mkt); url.searchParams.set("issueLocale", "pt_BR");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: metodo,
    headers: { "x-amz-access-token": c.token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { message: txt.slice(0, 300) }; }
  return { status: r.status, body };
}
/** O que a Amazon aponta: erro bloqueia, o resto só informa. */
function problemasAmz(body: any): { erros: string[]; avisos: string[] } {
  const erros: string[] = []; const avisos: string[] = [];
  for (const i of ((body?.issues ?? []) as any[])) {
    const onde = ((i?.attributeNames ?? []) as string[]).join(", ");
    const t = `${i?.code ?? ""}: ${String(i?.message ?? "").slice(0, 240)}${onde ? ` [${onde}]` : ""}`;
    (String(i?.severity) === "ERROR" ? erros : avisos).push(t);
  }
  for (const e of ((body?.errors ?? []) as any[])) erros.push(`${e?.code ?? ""}: ${String(e?.message ?? "").slice(0, 240)}`);
  return { erros, avisos };
}
/** Anúncios da conta que são este produto. O SKU na Amazon pode ser o nosso, FBA-<sku>, o do de-para ou o que o FBA conhece. */
async function existentesAmz(c: ContaAmz, sku: string): Promise<Existente[]> {
  const [map, fulf] = await Promise.all([
    db.from("sku_mapeamento").select("sku_origem").ilike("marketplace", "amazon%").eq("sku_correto", sku),
    db.from("estoque_fulfillment").select("sku_marketplace").ilike("marketplace", "amazon%").eq("shop_id", c.shop_id).eq("sku", sku),
  ]);
  const candidatos = [...new Set([sku, `${sku}_FBA`, `FBA-${sku}`, ...((map.data ?? []) as any[]).map((x) => String(x.sku_origem)),
    ...((fulf.data ?? []) as any[]).map((x) => String(x.sku_marketplace))])].slice(0, 7);
  const out: Existente[] = [];
  for (const s of candidatos) {
    const r = await amzItem(c, s, "GET", { includedData: "summaries" });
    const sm = r.body?.summaries?.[0];
    if (!mlOk(r) || !sm?.asin) continue;
    out.push({
      item_id: s, nome: sm.itemName ?? null, status: ((sm.status ?? []) as string[]).includes("BUYABLE") ? "active" : "sem oferta ativa",
      url: `https://www.amazon.com.br/dp/${sm.asin}`, variacao: false, model_id: String(sm.asin), nome_variacao: null, preco: null,
    });
  }
  return out;
}
async function existentesAmzLojas(sku: string): Promise<Record<string, Existente[] | null>> {
  const out: Record<string, Existente[] | null> = { ottz: null, svl: null };
  await Promise.all(Object.keys(CONTA_AMZ).map(async (k) => {
    try { out[k] = await existentesAmz(await contaAmz(k), sku); } catch { out[k] = null; }
  }));
  return out;
}

async function montarAtualizarAmz(d: Dados, op: Opcoes, c: ContaAmz, alvo: Existente) {
  const r = await amzItem(c, alvo.item_id, "GET", { includedData: "summaries,attributes,issues" });
  const at = r.body?.attributes ?? {}; const sm = r.body?.summaries?.[0];
  if (!mlOk(r) || !sm) throw new Error(`não consegui ler o anúncio ${alvo.item_id} na Amazon: ${problemasAmz(r.body).erros.join(" · ") || r.status}`);
  const b = base(d, op, { quem: "a Amazon", titulo: LIM_AMZ.titulo, descMin: 10, descMax: 50000, fotos: LIM_AMZ.fotos });
  // na Amazon a descrição e os bullets são campos separados
  const descricao = String(d.r.descricao ?? "").trim();
  const bullets = (Array.isArray(d.r.bullet_points) ? (d.r.bullet_points as unknown[]) : []).map((x) => String(x).trim()).filter(Boolean).slice(0, LIM_AMZ.bullets);
  const junto = (desc: string, bl: string[]) => [desc, bl.length ? bl.map((x) => `• ${x}`).join("\n") : ""].filter(Boolean).join("\n\n");
  const campos = {
    titulo: op.campos?.titulo !== false, descricao: op.campos?.descricao !== false,
    fotos: op.campos?.fotos !== false, preco: op.campos?.preco === true,
  };
  const pendencias: string[] = []; const avisos: string[] = [...d.avisosCapa];
  if (!campos.titulo && !campos.descricao && !campos.fotos && !campos.preco) pendencias.push("marque ao menos um item para atualizar");
  if (campos.titulo) pendencias.push(...b.problemas.titulo);
  if (campos.descricao) {
    if (!d.textoAprovado) pendencias.push("aprove o texto (bloco 1) antes de enviar");
    if (descricao.length < 10) pendencias.push("descrição muito curta");
    if (descricao.length > LIM_AMZ.descricao) pendencias.push(`descrição com ${descricao.length} caracteres (a Amazon aceita até ${LIM_AMZ.descricao.toLocaleString("pt-BR")}; os bullets vão à parte)`);
    if (bullets.some((x) => x.length > LIM_AMZ.bullet)) pendencias.push(`há bullet com mais de ${LIM_AMZ.bullet} caracteres`);
  }
  if (campos.preco) pendencias.push("o preço na Amazon ainda não é trocado por aqui: desmarque \"Preço\"");

  // fotos atuais: uma por campo de imagem do anúncio (o id é o nome do campo; a mesma imagem pode repetir)
  const atuais = FOTOS_AMZ.map((k) => ({ id: k, url: String(at[k]?.[0]?.media_location ?? "") })).filter((f) => f.url);
  const idsAtuais = atuais.map((f) => f.id);
  const { todasNovas, manter, novas, posicao } = planoFotos(d, op, idsAtuais);
  if (campos.fotos) {
    const total = manter.length + novas.length;
    if (total === 0) pendencias.push("o anúncio precisa de ao menos 1 foto");
    if (total > LIM_AMZ.fotos) pendencias.push(`a Amazon aceita ${LIM_AMZ.fotos} fotos e há ${total} marcadas (${manter.length} atuais + ${novas.length} novas): desmarque ${total - LIM_AMZ.fotos}`);
    if (novas.length === 0 && manter.length === idsAtuais.length) pendencias.push("nada muda nas fotos: desmarque \"Fotos\" ou escolha o que entra e o que sai");
    if (manter.length < idsAtuais.length) avisos.push(`${idsAtuais.length - manter.length} foto(s) atual(is) do anúncio sai(em)`);
  }
  for (const x of problemasAmz(r.body).erros) avisos.push(`a Amazon já aponta neste anúncio: ${x}`);
  avisos.push("a Amazon aplica a mudança em alguns minutos; título e fotos podem demorar ou não mudar se a ficha do produto for de outra marca");

  /** Endereço público temporário das fotos novas (a Amazon baixa a imagem a partir dele), na ordem de `novas`. */
  const assinar = async (segundos: number): Promise<string[]> => {
    if (!campos.fotos || !novas.length) return [];
    const { data } = await db.storage.from(BUCKET).createSignedUrls(novas.map((f) => f.path), segundos);
    const urls = novas.map((f) => String(((data ?? []) as any[]).find((x) => x?.path === f.path)?.signedUrl ?? ""));
    if (urls.some((u) => !u)) throw new Error("não consegui gerar o endereço de uma das fotos novas");
    return urls;
  };
  /** As alterações no formato da Amazon. Campo de foto que sobra é apagado. */
  const patches = (urlsNovas: string[]): Record<string, unknown>[] => {
    const p: Record<string, unknown>[] = [];
    const val = (v: string) => ({ value: v, language_tag: "pt_BR", marketplace_id: c.mkt });
    if (campos.titulo) p.push({ op: "replace", path: "/attributes/item_name", value: [val(b.titulo)] });
    if (campos.descricao) {
      p.push({ op: "replace", path: "/attributes/product_description", value: [val(descricao)] });
      if (bullets.length) p.push({ op: "replace", path: "/attributes/bullet_point", value: bullets.map(val) });
    }
    if (campos.fotos) {
      const urlAtual = new Map(atuais.map((f) => [f.id, f.url]));
      const finais = ordemFinal(op, { manter, novas, posicao, atuais: idsAtuais }, urlsNovas).map((x) => urlAtual.get(x) ?? x).slice(0, LIM_AMZ.fotos);
      FOTOS_AMZ.forEach((k, i) => {
        if (finais[i]) p.push({ op: "replace", path: `/attributes/${k}`, value: [{ media_location: finais[i], marketplace_id: c.mkt }] });
        else if (urlAtual.has(k)) p.push({ op: "delete", path: `/attributes/${k}`, value: [{ media_location: urlAtual.get(k), marketplace_id: c.mkt }] });
      });
    }
    return p;
  };
  // VALIDADOR da Amazon: confere as alterações sem aplicar nada
  if (!pendencias.length) {
    const v = await amzItem(c, alvo.item_id, "PATCH", { mode: "VALIDATION_PREVIEW" }, { productType: sm.productType, patches: patches(await assinar(900)) });
    const pv = problemasAmz(v.body);
    pendencias.push(...pv.erros.map((e) => `Amazon: ${e}`));
    avisos.push(...pv.avisos.map((e) => `Amazon: ${e}`));
    if (!pv.erros.length && String(v.body?.status ?? "") !== "VALID") pendencias.push(`Amazon: a validação respondeu ${v.body?.status ?? v.status}`);
  }
  const antes = {
    titulo: String(at.item_name?.[0]?.value ?? sm.itemName ?? ""),
    descricao: junto(String(at.product_description?.[0]?.value ?? ""), ((at.bullet_point ?? []) as any[]).map((x) => String(x?.value ?? "")).filter(Boolean)),
    fotos: atuais.map((f) => f.url), preco: null as number | null,
  };
  return {
    pendencias: [...new Set(pendencias)], avisos: [...new Set(avisos)], campos, antes, patches, assinar, tipo: String(sm.productType),
    previa: {
      loja: c.nome, sku: String(d.r.sku), titulo: b.titulo, descricao: junto(descricao, bullets), preco: null, fotos: todasNovas,
      fotos_plano: { manter, novas: novas.map((f) => f.path), posicao },
      alvo: { ...alvo, n_variacoes: 0, situacao: alvo.status }, campos,
      atual: { titulo: antes.titulo, descricao: antes.descricao, fotos: atuais, preco: null },
      limites: { titulo: LIM_AMZ.titulo, fotos: LIM_AMZ.fotos },
    },
  };
}

// ---------------------------------------------------------------- Amazon · CRIAR (v11, 19/out/2026)
// Dois caminhos, decididos pelo código de barras no catálogo da Amazon (ensaios de 13 e 18/out, CLAUDE.md §5.11.12):
//  - OFERTA: o produto já existe (um ASIN com o mesmo EAN) → só a nossa oferta nele (LISTING_OFFER_ONLY). Título,
//    fotos e textos são os da ficha da Amazon; os nossos não vão.
//  - FICHA NOVA: ASIN novo (requirements LISTING) com texto, bullets, fotos, marca, medidas e o que o tipo de
//    produto exige. O validador cobra mais do que o esquema diz: os campos que ele apontar entram no formulário.
// Sempre FBA (tudo o que vendemos na Amazon sai do CD). SKU na Amazon = `<sku>_FBA` (o fulfillment-sync casa).
const API_AMZ = (c: ContaAmz, metodo: string, path: string, params: Record<string, string> = {}, corpo?: unknown) =>
  (async (): Promise<RespMl> => {
    const url = new URL(`${SPAPI}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url.toString(), {
      method: metodo,
      headers: { "x-amz-access-token": c.token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const txt = await r.text();
    let body: any = null;
    try { body = txt ? JSON.parse(txt) : null; } catch { body = { message: txt.slice(0, 300) }; }
    return { status: r.status, body };
  })();
// tipos de produto em que temos anúncio (aparecem sempre na lista, além dos que a Amazon sugerir)
const TIPOS_AMZ_BASE = ["PET_SUPPLIES", "ANIMAL_LITTER"];
// campos que a função preenche sozinha (não entram no formulário)
const AUTO_AMZ = new Set(["item_name", "bullet_point", "product_description", "externally_assigned_product_identifier",
  "supplier_declared_has_product_identifier_exemption", "merchant_suggested_asin", "condition_type", "purchasable_offer", "list_price",
  "fulfillment_availability", "item_package_weight", "item_package_dimensions", "unit_count", "number_of_items", "model_number",
  "external_testing_certification", "number_of_boxes", "parentage_level", "child_parent_sku_relationship", "variation_theme", ...FOTOS_AMZ]);
const esquemasAmz = new Map<string, { props: Record<string, any>; obrig: string[] } | null>();
/** Esquema do tipo de produto (o que cada campo aceita). Guardado por isolate: o arquivo é grande. */
async function esquemaAmz(c: ContaAmz, tipo: string, requisitos: string) {
  const chave = `${tipo}:${requisitos}`;
  if (esquemasAmz.has(chave)) return esquemasAmz.get(chave)!;
  let out: { props: Record<string, any>; obrig: string[] } | null = null;
  try {
    const def = await API_AMZ(c, "GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(tipo)}`,
      { marketplaceIds: c.mkt, sellerId: c.seller, requirements: requisitos, requirementsEnforced: "ENFORCED", locale: "pt_BR" });
    const link = def.body?.schema?.link?.resource;
    if (link) {
      const sc = await (await fetch(String(link))).json();
      out = { props: sc?.properties ?? {}, obrig: (sc?.required ?? []) as string[] };
    }
  } catch { out = null; }
  esquemasAmz.set(chave, out);
  return out;
}
/** Opções de um campo de lista (enum / enumNames, também dentro de anyOf/oneOf). */
function opcoesAmz(pv: any): { ids: string[]; nomes: string[] } {
  const ids: string[] = []; const nomes: string[] = [];
  const add = (en: unknown[], nm?: unknown[]) => en.forEach((e, i) => { if (!ids.includes(String(e))) { ids.push(String(e)); nomes.push(String(nm?.[i] ?? e)); } });
  if (Array.isArray(pv?.enum)) add(pv.enum, pv.enumNames);
  for (const x of [...((pv?.anyOf ?? []) as any[]), ...((pv?.oneOf ?? []) as any[])]) if (Array.isArray(x?.enum)) add(x.enum, x.enumNames);
  return { ids, nomes };
}
function tipoValorAmz(pv: any): string {
  const t = pv?.type ?? ((pv?.anyOf ?? []) as any[]).find((x) => x?.type)?.type;
  return String(Array.isArray(t) ? t[0] : t ?? "string");
}
/** Um campo simples (com `value`) montado a partir do texto do formulário; null = campo de formato que não montamos. */
function campoAmz(c: ContaAmz, prop: any, texto: string): unknown[] | null {
  const ps = prop?.items?.properties ?? {};
  if (!ps.value) return null;
  const tp = tipoValorAmz(ps.value);
  const op = opcoesAmz(ps.value);
  const t = texto.trim();
  let valor: unknown = t;
  if (tp === "boolean") valor = /^(sim|s|true|yes|1)$/i.test(t);
  else if (tp === "number" || tp === "integer") valor = Number(t.replace(",", "."));
  else if (op.ids.length) {
    const i = op.ids.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    const j = op.nomes.findIndex((x) => x.toLowerCase() === t.toLowerCase());
    valor = i >= 0 ? op.ids[i] : j >= 0 ? op.ids[j] : t;
  }
  const v: Record<string, unknown> = { value: valor, marketplace_id: c.mkt };
  if (ps.language_tag) v.language_tag = "pt_BR";
  return [v];
}
/** Como o campo aparece no formulário: nome, opções, dica. */
function rotuloAmz(id: string, prop: any) {
  const pv = prop?.items?.properties?.value;
  const tp = tipoValorAmz(pv);
  const op = opcoesAmz(pv);
  return {
    nome: String(prop?.title ?? id), tipo: tp,
    opcoes: tp === "boolean" ? ["Sim", "Não"] : op.nomes.slice(0, 80), ids: tp === "boolean" ? ["true", "false"] : op.ids.slice(0, 80),
    dica: prop?.description ? String(prop.description).replace(/\s+/g, " ").slice(0, 90) : null,
  };
}
/** Mostra o valor pelo nome da opção (o banco/código guarda o id). */
function mostrarAmz(r: { opcoes: string[]; ids: string[]; tipo: string }, v: string): string {
  if (r.tipo === "boolean") return /^(sim|s|true|yes|1)$/i.test(v) ? "Sim" : /^(não|nao|n|false|no|0)$/i.test(v) ? "Não" : v;
  const i = r.ids.findIndex((x) => x.toLowerCase() === v.toLowerCase());
  return i >= 0 ? r.opcoes[i] : v;
}
/** GTIN (8, 12, 13 ou 14 dígitos) com o dígito verificador certo. */
function gtinValido(g: string): boolean {
  if (![8, 12, 13, 14].includes(g.length) || !/^\d+$/.test(g)) return false;
  const ds = g.split("").map(Number); const dv = ds.pop()!;
  const soma = ds.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === dv;
}
/** O que a Amazon diz no erro, em português de gente. */
function traduzAmz(t: string): string {
  if (/^5665\b/.test(t)) return `${t} → a marca não está aprovada na Amazon (Registro de Marca): use a marca registrada no Seller Central ou peça a aprovação`;
  if (/^8560\b/.test(t)) return `${t} → a Amazon exige o código de barras (EAN) deste produto; sem ele só passa se a marca tiver isenção de GTIN aprovada`;
  if (/^8541\b|^8542\b/.test(t)) return `${t} → o código de barras já pertence a outro produto do catálogo da Amazon`;
  if (/^8572\b/.test(t)) return `${t} → a Amazon confere o código de barras na GS1: o dono do código não bate com a marca informada. Escreva a marca como o fabricante registrou, use o código certo ou peça isenção de GTIN`;
  if (/^8566\b/.test(t)) return `${t} → vem junto com o problema do código de barras: costuma sumir quando ele é resolvido`;
  return t;
}

async function montarCriarAmz(d: Dados, op: Opcoes, c: ContaAmz, existentes: Existente[]) {
  const sku = String(d.r.sku);
  const skuAmz = String(op.sku_amazon ?? `${sku}_FBA`).trim();
  const b = base(d, op, { quem: "a Amazon", titulo: LIM_AMZ.titulo, descMin: 10, descMax: 50000, fotos: LIM_AMZ.fotos });
  const pendencias: string[] = [...b.problemas.preco];
  const avisos: string[] = [...d.avisosCapa];
  if (existentes.length) avisos.push(`este produto JÁ tem ${existentes.length} anúncio(s) nesta conta: criar outro gera anúncio duplicado. Para melhorar o que existe, use "Atualizar anúncio existente"`);
  if (d.produto?.tipo === "V") pendencias.push("este é um produto PAI (com variações): na Amazon, crie o anúncio de cada variação e junte em família no bloco \"Variações na Amazon\"");

  // código de barras: o digitado → o já conferido → o do Tiny → o do cadastro. Só vale se for DESTE produto
  // (kit costuma herdar o da unidade; na Amazon um EAN é um produto e o kit cairia na ficha da unidade).
  const [tiny, cadR, kitR] = await Promise.all([
    medidasTiny(d.cad?.id_tiny ? Number(d.cad.id_tiny) : null),
    db.from("produtos").select("gtin, nome").eq("sku", sku).maybeSingle(),
    db.from("produto_kits").select("sku_componente, quantidade").eq("sku_kit", sku),
  ]);
  const digitado = String(op.gtin ?? "").replace(/\D/g, "");
  let ean: string | null = digitado || String(d.extra?.gtin ?? tiny.gtin ?? cadR.data?.gtin ?? "").replace(/\D/g, "") || null;
  if (ean && !gtinValido(ean)) {
    pendencias.push(`o código de barras ${ean} não é válido (o EAN tem 13 dígitos e o último confere os outros)`);
    ean = null;
  } else if (ean && !digitado) {
    const { data: outros } = await db.from("produtos").select("sku").eq("gtin", ean).neq("sku", sku).eq("ativo", true).limit(3);
    if ((outros ?? []).length) {
      avisos.push(`o código de barras ${ean} do cadastro é o mesmo de ${((outros ?? []) as any[]).map((x) => x.sku).join(", ")} (kit herda o da unidade): não usei — informe o código próprio deste produto`);
      ean = null;
    }
  }
  const kit = (kitR.data ?? []) as any[];
  const unidades = kit.length ? kit.reduce((s, k) => s + (Number(k.quantidade) || 1), 0) : 1;

  // o produto já existe no catálogo? (pelo EAN; ASIN pai de variação não vende)
  let asins: { asin: string; titulo: string | null; marca: string | null; tipo: string | null; foto: string | null; url: string }[] = [];
  if (ean) {
    const cat = await API_AMZ(c, "GET", "/catalog/2022-04-01/items", { marketplaceIds: c.mkt, identifiers: ean, identifiersType: "EAN", includedData: "summaries,images,relationships,productTypes", pageSize: "5" });
    asins = ((cat.body?.items ?? []) as any[])
      .filter((i) => !((i.relationships?.[0]?.relationships ?? []) as any[]).some((r: any) => (r.childAsins ?? []).length))
      .map((i) => ({
        asin: String(i.asin), titulo: i.summaries?.[0]?.itemName ?? null, marca: i.summaries?.[0]?.brand ?? null,
        tipo: i.productTypes?.[0]?.productType ?? i.summaries?.[0]?.productType ?? null,
        foto: (((i.images?.[0]?.images ?? []) as any[]).find((x) => x.variant === "MAIN")?.link as string) ?? null,
        url: `https://www.amazon.com.br/dp/${i.asin}`,
      }));
  }
  const caminho: "oferta" | "ficha" = op.caminho === "ficha" || op.caminho === "oferta" ? op.caminho : (asins.length ? "oferta" : "ficha");
  if (caminho === "oferta" && !asins.length) pendencias.push("não há produto no catálogo da Amazon com este código de barras para entrar na oferta: use \"ficha nova\"");
  const alvoAsin = caminho === "oferta" ? (asins.find((a) => a.asin === String(op.asin ?? "")) ?? asins[0] ?? null) : null;

  // SKU já usado na conta?
  const ja = await amzItem(c, skuAmz, "GET", { includedData: "summaries" });
  if (mlOk(ja) && ja.body?.summaries?.[0]?.asin) pendencias.push(`já existe o anúncio ${skuAmz} nesta conta (ASIN ${ja.body.summaries[0].asin}): use "Atualizar anúncio existente"`);

  // tipo de produto: o do ASIN (oferta) ou o escolhido / sugerido pela Amazon (ficha nova)
  let tipos: string[] = [...TIPOS_AMZ_BASE];
  let tipo = String(op.tipo_produto ?? "").trim();
  if (caminho === "oferta") tipo = alvoAsin?.tipo || tipo || "PRODUCT";
  else {
    const nome = String(cadR.data?.nome ?? b.titulo);
    const tp = await API_AMZ(c, "GET", "/definitions/2020-09-01/productTypes", { marketplaceIds: c.mkt, keywords: nome.split(/\s+/).slice(0, 4).join(" "), locale: "pt_BR" });
    const sug = ((tp.body?.productTypes ?? []) as any[]).map((x) => String(x.name));
    tipos = [...new Set([...sug.slice(0, 6), ...TIPOS_AMZ_BASE])];
    if (!tipo) tipo = /areia|granulado|s[ií]lica/i.test(nome) ? "ANIMAL_LITTER" : sug[0] || "PET_SUPPLIES";
    if (!tipos.includes(tipo)) tipos.unshift(tipo);
  }
  const requisitos = caminho === "oferta" ? "LISTING_OFFER_ONLY" : "LISTING";
  const esq = await esquemaAmz(c, tipo, requisitos);
  if (!esq) avisos.push(`não consegui ler o que o tipo ${tipo} exige: a conferência fica só com o validador`);
  const props = esq?.props ?? {};
  const temCampo = (k: string) => !esq || k in props;

  // restrições para vender (marca/categoria que pedem aprovação)
  if (alvoAsin) {
    const rest = await API_AMZ(c, "GET", "/listings/2021-08-01/restrictions", { asin: alvoAsin.asin, sellerId: c.seller, marketplaceIds: c.mkt, conditionType: "new_new" });
    for (const x of ((rest.body?.restrictions ?? []) as any[])) for (const m of ((x.reasons ?? []) as any[])) {
      pendencias.push(`a Amazon exige aprovação para vender o ASIN ${alvoAsin.asin}: ${String(m.message ?? m.reasonCode ?? "").slice(0, 220)}`);
    }
  }

  // medidas e peso (mesma cadeia da Shopee e do Mercado Livre)
  const med = await medidasDoAnuncio(d, op, tiny);
  if (caminho === "ficha") {
    avisos.push(...med.avisos);
    if (med.faltaPeso) pendencias.push("informe o peso da embalagem (kg): o cadastro está sem peso e não deu para calcular");
  }

  // ---------------- formulário: campos que a pessoa confere (com sugestão) + os que a Amazon exigir
  const nomeProd = String(cadR.data?.nome ?? b.titulo);
  const marca = String(d.produto?.marca ?? "").trim();
  const liquido = /\b\d+\s*ml\b|spray|l[ií]quid|shampoo|lo[cç][aã]o|perfume|col[oô]nia/i.test(nomeProd);
  const uso = /gat/i.test(nomeProd) && /c[aã]es|cachorr/i.test(nomeProd) ? "Cães e gatos" : /gat/i.test(nomeProd) ? "Gatos" : /c[aã]es|cachorr/i.test(nomeProd) ? "Cães" : "Animais de estimação";
  const sugestoes: Record<string, string> = caminho === "ficha" ? {
    brand: marca, manufacturer: marca, model_name: nomeProd.slice(0, 60), color: "",
    directions: "Siga as instruções da embalagem.", specific_uses_for_product: uso,
    warranty_description: "Garantia legal de 30 dias", included_components: unidades > 1 ? `${unidades} unidades` : "1 unidade",
    contains_liquid_contents: liquido ? "true" : "false", is_expiration_dated_product: "false",
    country_of_origin: "BR", batteries_required: "false", supplier_declared_dg_hz_regulation: "not_applicable",
  } : { batteries_required: "false", supplier_declared_dg_hz_regulation: "not_applicable" };
  const digitados = (op.atributos ?? {}) as Record<string, unknown>;
  const noForm = new Set<string>([
    ...Object.keys(sugestoes).filter(temCampo),
    ...(esq?.obrig ?? []).filter((k) => !AUTO_AMZ.has(k) && (caminho === "ficha" || !["item_name", "brand"].includes(k))),
    ...Object.keys(digitados),
  ]);
  const valorForm = (k: string) => (typeof digitados[k] === "string" ? String(digitados[k]).trim() : (sugestoes[k] ?? ""));

  /** O corpo completo para a Amazon (fotos como endereços assinados). */
  const montar = (urls: string[]) => {
    const t = (v: string) => [{ value: v, language_tag: "pt_BR", marketplace_id: c.mkt }];
    const so = (v: unknown) => [{ value: v, marketplace_id: c.mkt }];
    const a: Record<string, unknown> = {
      condition_type: so("new_new"),
      purchasable_offer: [{ currency: "BRL", audience: "ALL", our_price: [{ schedule: [{ value_with_tax: b.preco }] }], marketplace_id: c.mkt }],
      fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_NA", marketplace_id: c.mkt }],
    };
    if (caminho === "oferta") a.merchant_suggested_asin = so(alvoAsin?.asin ?? "");
    else {
      const bullets = (Array.isArray(d.r.bullet_points) ? (d.r.bullet_points as unknown[]) : []).map((x) => String(x).trim()).filter(Boolean).slice(0, LIM_AMZ.bullets);
      Object.assign(a, {
        item_name: t(b.titulo),
        ...(bullets.length ? { bullet_point: bullets.map((x) => ({ value: x.slice(0, LIM_AMZ.bullet), language_tag: "pt_BR", marketplace_id: c.mkt })) } : {}),
        product_description: t(String(d.r.descricao ?? "").trim().slice(0, LIM_AMZ.descricao)),
        list_price: [{ currency: "BRL", value_with_tax: b.preco, marketplace_id: c.mkt }],
        model_number: so(sku), external_testing_certification: so("Não Aplicável"), number_of_boxes: so(1),
        unit_count: [{ value: unidades, type: { value: "Unidade", language_tag: "pt_BR" }, marketplace_id: c.mkt }],
        number_of_items: so(unidades),
      });
      if (med.medidas.peso_kg) a.item_package_weight = [{ unit: "kilograms", value: Math.round(med.medidas.peso_kg * 100) / 100, marketplace_id: c.mkt }];
      const cm = (v: number | null) => ({ unit: "centimeters", value: Math.max(1, Math.round(Number(v) || 1)) });
      a.item_package_dimensions = [{ length: cm(med.medidas.comprimento_cm), width: cm(med.medidas.largura_cm), height: cm(med.medidas.altura_cm), marketplace_id: c.mkt }];
      if (ean) a.externally_assigned_product_identifier = [{ type: "ean", value: ean, marketplace_id: c.mkt }];
      else a.supplier_declared_has_product_identifier_exemption = so(true);
      urls.slice(0, LIM_AMZ.fotos).forEach((u, i) => { a[FOTOS_AMZ[i]] = [{ media_location: u, marketplace_id: c.mkt }]; });
    }
    for (const k of noForm) {
      const v = valorForm(k);
      if (!v) continue;
      const campo = props[k] ? campoAmz(c, props[k], v) : (k in sugestoes ? so(/^(true|false)$/.test(v) ? v === "true" : v) : null);
      if (campo) a[k] = campo;
    }
    // só vai o que o tipo de produto conhece (campo a mais é recusado)
    if (esq) for (const k of Object.keys(a)) if (!(k in props)) delete a[k];
    return { productType: tipo, requirements: requisitos, attributes: a };
  };
  const assinar = async (segundos: number): Promise<string[]> => {
    if (caminho !== "ficha" || !b.fotos.length) return [];
    const { data } = await db.storage.from(BUCKET).createSignedUrls(b.fotos.map((f) => f.path), segundos);
    const urls = b.fotos.map((f) => String(((data ?? []) as any[]).find((x) => x?.path === f.path)?.signedUrl ?? ""));
    if (urls.some((u) => !u)) throw new Error("não consegui gerar o endereço de uma das fotos");
    return urls;
  };

  if (caminho === "ficha") {
    pendencias.push(...b.problemas.titulo, ...b.problemas.fotos);
    if (!d.textoAprovado) pendencias.push("aprove o texto (bloco 1) antes de enviar");
    if (!ean) avisos.push("sem código de barras: a Amazon só aceita a ficha nova se a marca tiver isenção de GTIN aprovada no Seller Central");
    if (!marca && !valorForm("brand")) pendencias.push("informe a marca (o cadastro está sem marca)");
  } else {
    avisos.push(`entra como OFERTA no produto ${alvoAsin?.asin ?? ""} que já existe na Amazon: título, fotos e descrição são os da ficha dela — os deste anúncio não vão`);
  }
  avisos.push("vendas pelo FBA: o anúncio só vende depois que o estoque chegar ao CD da Amazon (envio pelo Seller Central ou, na SVL, pela Reposição)");

  // VALIDADOR da Amazon: confere o corpo sem criar nada
  const errosCampo = new Set<string>();
  if (!pendencias.length && b.preco) {
    const v = await amzItem(c, skuAmz, "PUT", { mode: "VALIDATION_PREVIEW" }, montar(await assinar(900)));
    const pv = problemasAmz(v.body);
    for (const i of ((v.body?.issues ?? []) as any[])) {
      if (String(i?.severity) !== "ERROR") continue;
      // attributeNames às vezes traz o próprio SKU (erro do anúncio inteiro): só campo do tipo de produto vira formulário
      for (const k of ((i?.attributeNames ?? []) as string[])) if (!AUTO_AMZ.has(k) && esq && k in props) errosCampo.add(k);
    }
    pendencias.push(...pv.erros.map((e) => `Amazon: ${traduzAmz(e)}`));
    avisos.push(...pv.avisos.map((e) => `Amazon: ${e}`));
    if (!pv.erros.length && String(v.body?.status ?? "") !== "VALID") pendencias.push(`Amazon: a validação respondeu ${v.body?.status ?? v.status}`);
  }
  for (const k of errosCampo) noForm.add(k);

  const atributos = [...noForm].map((k) => {
    const r = rotuloAmz(k, props[k]);
    const v = valorForm(k);
    return {
      id: k, nome: r.nome, obrigatorio: (esq?.obrig ?? []).includes(k) || errosCampo.has(k), valor: v ? mostrarAmz(r, v) : "",
      opcoes: r.opcoes, dica: r.dica,
    };
  }).sort((x, y) => Number(y.obrigatorio) - Number(x.obrigatorio) || x.nome.localeCompare(y.nome));
  for (const a of atributos) if (a.obrigatorio && !a.valor) pendencias.push(`preencha "${a.nome}" (a Amazon exige)`);

  const junto = [String(d.r.descricao ?? "").trim(), ((Array.isArray(d.r.bullet_points) ? d.r.bullet_points : []) as unknown[]).map((x) => `• ${String(x).trim()}`).join("\n")].filter(Boolean).join("\n\n");
  return {
    pendencias: [...new Set(pendencias)], avisos: [...new Set(avisos)], montar, assinar, skuAmz, caminho, alvoAsin, ean, med, tiny,
    previa: {
      loja: c.nome, sku, titulo: caminho === "oferta" ? (alvoAsin?.titulo ?? b.titulo) : b.titulo, descricao: junto, preco: b.preco,
      fotos: caminho === "oferta" ? [] : b.fotos, ean, medidas: med.medidas, estoque: 0, fora_do_ar: false,
      atributos, limites: { titulo: LIM_AMZ.titulo, fotos: LIM_AMZ.fotos },
      amazon: { caminho, asins, asin: alvoAsin?.asin ?? null, tipo, tipos, sku_amazon: skuAmz, unidades, canal_envio: "FBA" },
    },
  };
}

async function enviarCriarAmz(d: Dados, op: Opcoes, c: ContaAmz, m: Awaited<ReturnType<typeof montarCriarAmz>>, quem: Quem): Promise<Response> {
  const jaFoi = d.publicacoes.find((p) => p.canal === "amazon" && p.empresa === d.r.empresa && p.estado === "publicado" && p.operacao !== "atualizar");
  if (jaFoi && op.de_novo !== true) return json({ ok: false, erro: `este rascunho já criou o anúncio ${jaFoi.item_id}. Para criar outro, marque "criar outro anúncio mesmo assim".` }, 409);
  const { data: pub, error: ePub } = await db.from("ia_publicacao").insert({
    rascunho_id: d.r.id, sku: d.r.sku, canal: "amazon", empresa: d.r.empresa, shop_id: c.shop_id, estado: "enviando", operacao: "criar",
    item_id: m.skuAmz, fora_do_ar: false, criado_por: quem.id, criado_por_nome: quem.nome,
  }).select("id").single();
  if (ePub || !pub) return json({ ok: false, erro: `banco: ${ePub?.message}` }, 500);
  let corpo: Record<string, unknown> = {};
  let resposta: Record<string, unknown> = {};
  const falhar = async (erro: string) => {
    await db.from("ia_publicacao").update({ estado: "erro", erro: erro.slice(0, 500), enviado: corpo, resposta }).eq("id", pub.id);
    return json({ ok: false, erro, resposta }, 200);
  };
  if (m.caminho === "ficha") {
    await db.from("ia_produto_extra").upsert({ sku: d.r.sku, ...m.med.salvar, gtin: m.ean ?? d.extra?.gtin ?? null, ncm: d.extra?.ncm ?? m.tiny.ncm ?? null }, { onConflict: "sku" });
  }
  // o endereço das fotos vale 7 dias: a Amazon baixa as imagens depois de aceitar o pedido
  try { corpo = m.montar(await m.assinar(7 * 24 * 3600)); }
  catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
  // sem repetição automática
  const r = await amzItem(c, m.skuAmz, "PUT", {}, corpo);
  const pr = problemasAmz(r.body);
  resposta = { status: r.status, situacao: r.body?.status ?? null, submissionId: r.body?.submissionId ?? null, issues: r.body?.issues ?? null, errors: r.body?.errors ?? null };
  if (!mlOk(r) || String(r.body?.status ?? "") !== "ACCEPTED") return await falhar(`a Amazon recusou o anúncio: ${pr.erros.map(traduzAmz).join(" · ") || r.body?.status || r.status}`);
  const url = m.alvoAsin ? m.alvoAsin.url : null;
  await db.from("ia_publicacao").update({ estado: "publicado", url, enviado: corpo, resposta }).eq("id", pub.id);
  await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
  return json({
    ok: true, modo: "criar", item_id: m.skuAmz, url, fora_do_ar: false,
    avisos: [...pr.avisos.map((e) => `Amazon: ${e}`),
      m.caminho === "ficha" ? "a Amazon processa a ficha nova em alguns minutos (às vezes horas) e só então dá o ASIN; o anúncio aparece em \"já anunciado\" depois disso" : "a oferta aparece no produto em alguns minutos",
      "vendas pelo FBA: o anúncio só vende depois que o estoque chegar ao CD da Amazon"],
  });
}

async function fluxoAmazon(d: Dados, op: Opcoes, modulo: string, body: Record<string, any>, quem: Quem): Promise<Response> {
  const c = await contaAmz(String(d.r.empresa));
  const existentes = await existentesAmz(c, String(d.r.sku));
  // v11: padrão = atualizar quando o produto já tem anúncio na conta; senão, criar
  const modo: "criar" | "atualizar" = op.modo === "criar" || op.modo === "atualizar" ? op.modo : (existentes.length ? "atualizar" : "criar");
  if (modo === "criar") {
    const m = await montarCriarAmz(d, op, c, existentes);
    if (modulo === "previa") {
      return json({ ok: true, disponivel: true, canal: "amazon", modo, existentes, previa: m.previa, pendencias: m.pendencias, avisos: m.avisos, publicacoes: d.publicacoes });
    }
    if (modulo !== "enviar") return json({ ok: false, erro: "use ?modulo=existentes, previa ou enviar" }, 400);
    if (body.confirmar !== true) return json({ ok: false, erro: "envio exige confirmar: true" }, 400);
    if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
    const emCurso = d.publicacoes.find((p) => p.estado === "enviando" && Date.now() - new Date(p.criado_em).getTime() < 3 * 60_000);
    if (emCurso) return json({ ok: false, erro: "já há um envio em andamento para este rascunho — aguarde" }, 409);
    return await enviarCriarAmz(d, op, c, m, quem);
  }
  const alvo = existentes.find((e) => e.item_id === String(op.item_id ?? "")) ?? existentes[0];
  if (!alvo) return json({ ok: false, erro: "este produto não tem anúncio nesta conta para atualizar — use Criar anúncio novo" }, 400);
  const a = await montarAtualizarAmz(d, op, c, { ...alvo });
  if (modulo === "previa") {
    return json({ ok: true, disponivel: true, canal: "amazon", modo: "atualizar", existentes, previa: a.previa, pendencias: a.pendencias, avisos: a.avisos, publicacoes: d.publicacoes });
  }
  if (modulo !== "enviar") return json({ ok: false, erro: "use ?modulo=existentes, previa ou enviar" }, 400);
  if (body.confirmar !== true) return json({ ok: false, erro: "envio exige confirmar: true" }, 400);
  if (a.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: a.pendencias }, 400);
  const emCurso = d.publicacoes.find((p) => p.estado === "enviando" && Date.now() - new Date(p.criado_em).getTime() < 3 * 60_000);
  if (emCurso) return json({ ok: false, erro: "já há um envio em andamento para este rascunho — aguarde" }, 409);

  const { data: pub, error: ePub } = await db.from("ia_publicacao").insert({
    rascunho_id: d.r.id, sku: d.r.sku, canal: "amazon", empresa: d.r.empresa, shop_id: c.shop_id, estado: "enviando", operacao: "atualizar",
    item_id: alvo.item_id, criado_por: quem.id, criado_por_nome: quem.nome,
  }).select("id").single();
  if (ePub || !pub) return json({ ok: false, erro: `banco: ${ePub?.message}` }, 500);
  let lista: Record<string, unknown>[] = [];
  let resposta: Record<string, unknown> = {};
  const falhar = async (erro: string) => {
    await db.from("ia_publicacao").update({ estado: "erro", erro: erro.slice(0, 500), enviado: { campos: a.campos, antes: a.antes, patches: lista }, resposta }).eq("id", pub.id);
    return json({ ok: false, erro, resposta }, 200);
  };
  // o endereço das fotos novas vale 7 dias: a Amazon baixa a imagem depois de aceitar o pedido
  try { lista = a.patches(await a.assinar(7 * 24 * 3600)); }
  catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
  // sem repetição automática
  const r = await amzItem(c, alvo.item_id, "PATCH", {}, { productType: a.tipo, patches: lista });
  const pv = problemasAmz(r.body);
  resposta = { status: r.status, situacao: r.body?.status ?? null, submissionId: r.body?.submissionId ?? null, issues: r.body?.issues ?? null, errors: r.body?.errors ?? null };
  if (!mlOk(r) || String(r.body?.status ?? "") !== "ACCEPTED") return await falhar(`a Amazon recusou a atualização: ${pv.erros.join(" · ") || r.body?.status || r.status}`);
  const feitos = [a.campos.titulo ? "título" : "", a.campos.descricao ? "descrição e bullets" : "", a.campos.fotos ? "fotos" : ""].filter(Boolean);
  await db.from("ia_publicacao").update({ estado: "publicado", url: alvo.url, enviado: { campos: a.campos, antes: a.antes, patches: lista }, resposta }).eq("id", pub.id);
  await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
  return json({ ok: true, modo: "atualizar", item_id: alvo.item_id, url: alvo.url, atualizados: feitos, avisos: [...a.avisos, ...pv.avisos.map((e) => `Amazon: ${e}`)] });
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
    // v5: destino escolhido na tela — o mesmo rascunho serve a qualquer marketplace/loja
    const dest = (body.destino ?? {}) as Record<string, unknown>;
    const canalD = typeof dest.canal === "string" && dest.canal ? dest.canal : String(d.r.canal);
    const empresaD = dest.empresa === "ottz" || dest.empresa === "svl" ? dest.empresa : String(d.r.empresa);
    if (canalD !== d.r.canal || empresaD !== d.r.empresa) {
      // o preço do rascunho é o do canal DELE: para outro destino vale o salvo para o destino ou o sugerido
      const salvo = num(d.r.memoria_calculo?.destinos?.[`${canalD}:${empresaD}`]?.preco);
      let sugerido: number | null = null;
      if (salvo == null && quem.doUsuario) {
        const { data: pr } = await quem.doUsuario.rpc("ia_calcular_preco", { p_sku: d.r.sku, p_canal: canalD, p_empresa: empresaD });
        sugerido = num((pr as Record<string, unknown> | null)?.preco_sugerido);
      }
      d.r = { ...d.r, canal: canalD, empresa: empresaD, preco_aprovado: salvo, preco_sugerido: sugerido };
    }
    aplicarCapaDoDestino(d);
    if (quem.ensaio && d.r.canal !== "amazon") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
    if (d.r.canal === "mercado_livre") return await fluxoMl(d, op, modulo, body, quem);
    if (d.r.canal === "amazon") return await fluxoAmazon(d, op, modulo, body, quem);
    if (d.r.canal !== "shopee") {
      return json({ ok: true, disponivel: false, canal: d.r.canal, publicacoes: d.publicacoes,
        motivo: "o envio direto está pronto para a Shopee, o Mercado Livre e a Amazon; os outros canais entram nas próximas versões" });
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
      const registro = () => (mC ? mC.corpo : { campos: mA!.campos, corpo: mA!.corpo, preco: mA!.corpoPreco, antes: mA!.antes,
        fotos: { mantidas: mA!.plano.manter, novas: mA!.plano.novas.map((f) => f.path), posicao: mA!.plano.posicao } });
      const falhar = async (erro: string, resposta: unknown = null) => {
        await db.from("ia_publicacao").update({ estado: "erro", erro: erro.slice(0, 500), enviado: registro(), resposta }).eq("id", pub.id);
        return json({ ok: false, erro, resposta }, 200);
      };

      // ------------------------------------------------ CRIAR
      if (mC) {
        // as medidas conferidas ficam salvas para o próximo anúncio do mesmo produto
        await db.from("ia_produto_extra").upsert({ sku: d.r.sku, ...mC.medidasSalvar, gtin: d.extra?.gtin ?? mC.tiny.gtin ?? null, ncm: d.extra?.ncm ?? mC.tiny.ncm ?? null }, { onConflict: "sku" });
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
        try {
          const novosIds = await subirFotos(c, a.plano.novas);
          a.corpo.image.image_id_list = ordemFinal(op, a.plano, novosIds, d.capaDestino);
        } catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
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
