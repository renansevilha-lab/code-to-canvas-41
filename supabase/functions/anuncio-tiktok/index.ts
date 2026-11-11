// ============================================================================
// Edge Function: anuncio-tiktok v1 (11/nov/2026) — IA · Anúncios, envio ao TikTok Shop
// ----------------------------------------------------------------------------
// Pedido do dono: mandar o anúncio montado em IA › Anúncios direto ao TikTok Shop da
// OTTZ/ACZ (a loja da Bumi ainda não autorizou o app). Função separada da
// `anuncio-publicar` (143 kB, crítica) — mesmo contrato que a tela já usa:
//   POST ?modulo=previa  body {rascunho_id, destino:{canal:"tiktok", empresa}, opcoes}
//        → o que SERIA enviado + pendências. Só leitura (banco, Tiny e TikTok).
//   POST ?modulo=enviar  body {… , confirmar: true}
// Dois modos (opcoes.modo):
//   "criar"     → sobe as fotos aprovadas (/product/202309/images/upload) e cria o produto
//                 (POST /product/202309/products). Categoria, marca, depósito e atributos
//                 copiados de um produto da MESMA marca que a loja já tem (é como o Tiny
//                 publica), com a sugestão de categoria do TikTok pelo título. Por padrão
//                 nasce como RASCUNHO (save_mode AS_DRAFT) para conferir o vínculo com o Tiny.
//   "atualizar" → produto que já existe (opcoes.item_id = product_id): só os campos
//                 marcados (título, descrição, fotos — partial_edit; preço — prices/update).
//                 O estado anterior fica gravado no envio (ia_publicacao.enviado.antes).
// Escrita: cada chamada UMA vez (sem repetição automática), só com JWT de usuário + módulo ia.
// Ids do TikTok sempre como TEXTO (passam de 2^53).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const BUCKET = "ia-anuncios";
const TINY_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const APP_KEY = (Deno.env.get("TIKTOK_APP_KEY") || "").trim();
const APP_SECRET = (Deno.env.get("TIKTOK_APP_SECRET") || "").trim();
const TT_HOST = "https://open-api.tiktokglobalshop.com";
// só a loja da Ottz/ACZ está autorizada (a Bumi ainda não): pinada, como manda o CLAUDE.md §2.1
const LOJA_TT: Record<string, { shop_id: string; nome: string }> = {
  ottz: { shop_id: "7496181924415506972", nome: "TikTok Shop · ACZ Pet" },
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

// deno-lint-ignore no-explicit-any
type Quem = { id: string | null; nome: string | null; doUsuario?: any };
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
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null, doUsuario };
}

// ---------------------------------------------------------------- comum (copiado da anuncio-publicar v17)
async function carregar(rascunhoId: string) {
  const { data: r } = await db.from("ia_rascunho").select("*").eq("id", rascunhoId).maybeSingle();
  if (!r) throw new Error("rascunho não encontrado");
  const [prod, cad, extra, imgs, etapas, pubs] = await Promise.all([
    db.from("ia_produto").select("sku, nome, marca, tipo").eq("sku", r.sku).maybeSingle(),
    db.from("produtos").select("id_tiny, peso_bruto").eq("sku", r.sku).maybeSingle(),
    db.from("ia_produto_extra").select("*").eq("sku", r.sku).maybeSingle(),
    db.from("ia_rascunho_imagem").select("id, ordem, tipo, storage_path, status").eq("rascunho_id", rascunhoId).order("ordem"),
    db.from("ia_etapa").select("etapa, status, imagem_id").eq("rascunho_id", rascunhoId),
    db.from("ia_publicacao").select("id, sku, canal, empresa, operacao, estado, item_id, url, fora_do_ar, erro, criado_por_nome, criado_em")
      .eq("rascunho_id", rascunhoId).order("criado_em", { ascending: false }).limit(10),
  ]);
  const aprovadas = new Set(((etapas.data ?? []) as any[]).filter((e) => e.etapa === "imagem" && e.status === "aprovado").map((e) => e.imagem_id));
  const fotos = ((imgs.data ?? []) as any[]).filter((i) => i.storage_path && aprovadas.has(i.id))
    // a capa vai primeiro: é a foto que aparece na busca
    .sort((a, b) => Number(!String(a.tipo ?? "").startsWith("capa_")) - Number(!String(b.tipo ?? "").startsWith("capa_")) || a.ordem - b.ordem);
  const textoAprovado = ((etapas.data ?? []) as any[]).some((e) => e.etapa === "texto" && e.status === "aprovado");
  return { r: r as Record<string, any>, produto: prod.data as Record<string, any> | null, cad: cad.data as Record<string, any> | null,
    extra: extra.data as Record<string, any> | null, fotos, textoAprovado, publicacoes: (pubs.data ?? []) as Record<string, any>[],
    capaDestino: null as string | null, avisosCapa: [] as string[],
    // v15: enviando uma VARIAÇÃO do produto pai (Mercado Livre): o SKU do pai e os atributos que a diferenciam
    skuPai: null as string | null, extrasVariacao: [] as { name: string; value_name: string }[] };
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
    return {
      peso_kg: num(d.pesoBruto), comprimento_cm: num(d.comprimento), largura_cm: num(d.largura), altura_cm: num(d.altura), gtin: p?.gtin || null, ncm: p?.ncm || null,
      origem: p?.origem != null && String(p.origem).trim() !== "" ? String(p.origem).trim() : null,
    };
  } catch { return {}; }
}
/** CEST do cadastro do Tiny. A API v3 não traz o campo; a v2 (produto.obter) traz. Melhor-esforço. */
async function cestTiny(idTiny: number | null): Promise<string | null> {
  const tk = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
  if (!idTiny || !tk) return null;
  try {
    const r = await fetch(`https://api.tiny.com.br/api2/produto.obter.php?token=${encodeURIComponent(tk)}&id=${idTiny}&formato=json`);
    if (!r.ok) return null;
    const j = await r.json();
    const c = String(j?.retorno?.produto?.cest ?? "").replace(/\D/g, "");
    return c || null;
  } catch { return null; }
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


// ---------------------------------------------------------------- TikTok Shop
type Tt = { token: string; cipher: string; shopId: string; nome: string };
type RespTt = { status: number; j: any };

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// assinatura 202309: secret + path + params ordenados (sem sign/access_token) + body + secret (multipart: sem body)
async function assinar(path: string, params: Record<string, string>, body = ""): Promise<string> {
  const chaves = Object.keys(params).filter((k) => k !== "sign" && k !== "access_token").sort();
  return await hmacHex(APP_SECRET, APP_SECRET + path + chaves.map((k) => k + params[k]).join("") + body + APP_SECRET);
}

async function ctxTiktok(empresa: string): Promise<Tt> {
  const loja = LOJA_TT[empresa];
  if (!loja) throw new Error("o TikTok Shop desta empresa ainda não está conectado ao app (por enquanto só a loja da Ottz/ACZ)");
  if (!APP_KEY || !APP_SECRET) throw new Error("faltam os secrets TIKTOK_APP_KEY / TIKTOK_APP_SECRET");
  const { data: l } = await db.from("tiktok_lojas").select("shop_id, shop_cipher, open_id").eq("shop_id", loja.shop_id).maybeSingle();
  if (!l?.shop_cipher) throw new Error("loja do TikTok não encontrada em tiktok_lojas");
  const { data: t } = await db.from("oauth_tokens_tiktok").select("access_token, access_expires_at").eq("open_id", l.open_id).maybeSingle();
  if (!t?.access_token) throw new Error("token do TikTok não encontrado");
  if (t.access_expires_at && Date.parse(String(t.access_expires_at)) < Date.now()) throw new Error("o token do TikTok venceu: rode o tiktok-refresh-token");
  return { token: String(t.access_token), cipher: String(l.shop_cipher), shopId: loja.shop_id, nome: loja.nome };
}

/** Uma chamada à API do TikTok (sem repetição: quem escreve chama uma vez só). */
async function tt(c: Tt, metodo: string, path: string, query: Record<string, string> = {}, corpo?: unknown, comCipher = true): Promise<RespTt> {
  const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...query };
  if (comCipher) params.shop_cipher = c.cipher;
  const bodyStr = corpo === undefined ? "" : JSON.stringify(corpo);
  params.sign = await assinar(path, params, bodyStr);
  const url = new URL(TT_HOST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, body: bodyStr || undefined,
  });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch { j = { code: -1, message: txt.slice(0, 300) }; }
  return { status: r.status, j };
}
const okTt = (r: RespTt) => r.j?.code === 0;
const motivoTt = (r: RespTt) => `${r.j?.code ?? r.status}: ${r.j?.message ?? "sem resposta"}`;

/** Sobe uma foto (multipart, a assinatura não leva o corpo) e devolve o uri do TikTok. */
async function subirFotoTt(c: Tt, bytes: Uint8Array, mime: string, nome: string): Promise<string> {
  const path = "/product/202309/images/upload";
  const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)) };
  params.sign = await assinar(path, params);
  const url = new URL(TT_HOST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const fd = new FormData();
  fd.append("data", new Blob([bytes], { type: mime }), nome);
  fd.append("use_case", "MAIN_IMAGE");
  const r = await fetch(url.toString(), { method: "POST", headers: { "x-tts-access-token": c.token }, body: fd });
  const j = await r.json().catch(() => null);
  if (j?.code !== 0 || !j?.data?.uri) throw new Error(`o TikTok recusou a foto ${nome}: ${j?.code ?? r.status} ${j?.message ?? ""}`.trim());
  return String(j.data.uri);
}
async function subirFotosTt(c: Tt, fotos: { path: string; tipo: string }[]): Promise<string[]> {
  const uris: string[] = [];
  for (const f of fotos) {
    const dl = await db.storage.from(BUCKET).download(f.path);
    if (dl.error || !dl.data) throw new Error(`não consegui ler a foto ${f.tipo} do armazenamento`);
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    const mime = (dl.data.type || "image/png").split(";")[0];
    uris.push(await subirFotoTt(c, bytes, mime, `${f.tipo}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`));
  }
  return uris;
}

type Existente = { item_id: string; nome: string | null; status: string | null; url: string; variacao: boolean; model_id: string | null; nome_variacao: string | null; preco: number | null };
const urlProduto = (id: string) => `https://shop.tiktok.com/view/product/${id}?region=BR`;

/** Produtos da loja que vendem este SKU (ou uma variação dele), pelo espelho tiktok_produtos (só os ativos). */
async function existentesTt(shopId: string, sku: string): Promise<Existente[]> {
  const { data: filhos } = await db.from("produtos").select("sku").eq("sku_pai", sku).limit(60);
  const skus = [sku, ...((filhos ?? []) as any[]).map((f) => String(f.sku))];
  const { data } = await db.from("tiktok_produtos").select("product_id, sku_id, titulo, status, seller_sku, preco").eq("shop_id", shopId).in("seller_sku", skus);
  const porProduto = new Map<string, Existente>();
  for (const x of (data ?? []) as any[]) {
    const id = String(x.product_id);
    if (porProduto.has(id) && String(x.seller_sku) !== sku) continue;
    porProduto.set(id, { item_id: id, nome: x.titulo ?? null, status: x.status ?? null, url: urlProduto(id), variacao: String(x.seller_sku) !== sku,
      model_id: String(x.sku_id), nome_variacao: String(x.seller_sku) !== sku ? String(x.seller_sku) : null, preco: num(x.preco) });
  }
  return [...porProduto.values()];
}

/** Descrição em HTML (o TikTok recebe HTML): parágrafos do texto + bullets em lista. */
function descricaoHtml(r: Record<string, any>): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragrafos = String(r.descricao ?? "").trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
  const bullets = Array.isArray(r.bullet_points) ? (r.bullet_points as string[]).map((b) => String(b).trim()).filter(Boolean) : [];
  return [...paragrafos, ...(bullets.length ? [`<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`] : [])].join("");
}

const LIM_TT: Limites = { quem: "o TikTok", titulo: 255, descMin: 10, descMax: 10000, fotos: 9 };

/** Detalhe de um produto da loja (molde de categoria, marca, depósito, atributos). */
async function produtoTt(c: Tt, id: string) {
  const r = await tt(c, "GET", `/product/202309/products/${id}`);
  return okTt(r) ? r.j.data : null;
}

/** Produto-molde: um da MESMA marca na loja; senão o mais recente. */
async function moldeTt(c: Tt, marca: string | null): Promise<{ p: any; mesmaMarca: boolean } | null> {
  let ids: string[] = [];
  if (marca) {
    const { data: irmaos } = await db.from("ia_produto").select("sku").eq("marca", marca).limit(300);
    const skus = ((irmaos ?? []) as any[]).map((x) => String(x.sku));
    if (skus.length) {
      const { data } = await db.from("tiktok_produtos").select("product_id").eq("shop_id", c.shopId).in("seller_sku", skus).limit(5);
      ids = [...new Set(((data ?? []) as any[]).map((x) => String(x.product_id)))];
    }
  }
  for (const id of ids.slice(0, 2)) { const p = await produtoTt(c, id); if (p) return { p, mesmaMarca: true }; }
  const { data: rec } = await db.from("tiktok_produtos").select("product_id").eq("shop_id", c.shopId).order("atualizado_em", { ascending: false }).limit(1);
  if (rec?.[0]) { const p = await produtoTt(c, String(rec[0].product_id)); if (p) return { p, mesmaMarca: false }; }
  return null;
}

type AtribTt = { id: string; nome: string; obrigatorio: boolean; valor: string; opcoes: string[]; dica: string | null; _vals: { id: string; name: string }[]; _custom: boolean };

// ---------------------------------------------------------------- modo CRIAR
async function montarCriarTt(d: Dados, op: Opcoes, c: Tt, existentes: Existente[]) {
  const b = base(d, op, LIM_TT);
  const pendencias = [...new Set([...b.problemas.titulo, ...b.problemas.descricao, ...b.problemas.fotos, ...b.problemas.preco])];
  const avisos: string[] = [];
  if (existentes.length) avisos.push(`este produto JÁ tem ${existentes.length} anúncio(s) nesta loja do TikTok: criar outro gera anúncio duplicado. Para melhorar o que existe, use "Atualizar anúncio existente"`);
  if (d.fotos.length > LIM_TT.fotos) avisos.push(`há ${d.fotos.length} fotos aprovadas; o TikTok aceita ${LIM_TT.fotos} — vão as ${LIM_TT.fotos} primeiras (capa na frente)`);
  if (d.produto?.tipo === "V") avisos.push("este produto tem variações no Tiny: criar gera um anúncio simples, só deste SKU");
  if (b.titulo && b.titulo.length < 25) avisos.push("título curto: o TikTok costuma pedir ao menos 25 caracteres");

  const tiny = await medidasTiny(d.cad?.id_tiny ? Number(d.cad.id_tiny) : null);
  const med = await medidasDoAnuncio(d, op, tiny);
  const medidas = med.medidas;
  avisos.push(...med.avisos);
  if (med.faltaPeso) pendencias.push("informe o peso da embalagem (kg): o cadastro está sem peso e não deu para calcular");

  // molde: produto da mesma marca que a loja já tem (categoria, marca, depósito, atributos)
  const molde = await moldeTt(c, d.produto?.marca ? String(d.produto.marca) : null);
  const cadeia = ((molde?.p?.category_chains ?? []) as any[]);
  const folhaMolde = cadeia.find((x) => x.is_leaf) ?? cadeia[cadeia.length - 1];
  const caminhoMolde = cadeia.map((x) => String(x.local_name ?? x.id)).join(" > ");

  // sugestão do TikTok pelo título
  const sugeridas: { id: string; caminho: string }[] = [];
  if (folhaMolde) sugeridas.push({ id: String(folhaMolde.id), caminho: `${caminhoMolde}${molde?.mesmaMarca ? " (a mesma de outro produto da marca)" : " (de outro produto da loja)"}` });
  if (b.titulo) {
    const rec = await tt(c, "POST", "/product/202309/categories/recommend", {}, { product_title: b.titulo });
    if (okTt(rec)) {
      const cats = ((rec.j.data?.categories ?? []) as any[]);
      const folha = String(rec.j.data?.leaf_category_id ?? cats.find((x) => x.is_leaf)?.id ?? "");
      if (folha && !sugeridas.some((s) => s.id === folha)) sugeridas.push({ id: folha, caminho: cats.map((x) => String(x.name ?? x.local_name ?? x.id)).join(" > ") || folha });
    }
  }
  const categoriaId = String(op.categoria_id ?? "").trim() || sugeridas[0]?.id || "";
  if (!categoriaId) pendencias.push("não achei categoria para este produto no TikTok — informe o código da categoria");
  const categoria = categoriaId ? (sugeridas.find((s) => s.id === categoriaId) ?? { id: categoriaId, caminho: categoriaId }) : null;

  // marca: a do produto-molde da mesma marca; senão procura pelo nome na lista do TikTok
  let marca: { id: string; nome: string } | null = null;
  if (molde?.mesmaMarca && molde.p?.brand?.id) marca = { id: String(molde.p.brand.id), nome: String(molde.p.brand.name ?? d.produto?.marca ?? "") };
  if (!marca && d.produto?.marca && categoriaId) {
    const br = await tt(c, "GET", "/product/202309/brands", { page_size: "20", category_id: categoriaId, brand_name: String(d.produto.marca) });
    const alvo = String(d.produto.marca).toLowerCase().trim();
    const achou = ((br.j?.data?.brands ?? []) as any[]).find((x) => String(x.name ?? "").toLowerCase().trim() === alvo);
    if (achou) marca = { id: String(achou.id), nome: String(achou.name) };
  }
  if (!marca) avisos.push(`o anúncio sai sem marca: não achei a marca ${d.produto?.marca ?? "(sem marca no cadastro)"} no TikTok (nem em outro produto desta loja)`);

  // depósito de venda: o do produto-molde; senão o padrão da loja
  let deposito = String(molde?.p?.skus?.[0]?.inventory?.[0]?.warehouse_id ?? "");
  if (!deposito) {
    const wh = await tt(c, "GET", "/logistics/202309/warehouses");
    const lista = ((wh.j?.data?.warehouses ?? []) as any[]).filter((w) => w.type === "SALES_WAREHOUSE");
    deposito = String((lista.find((w) => w.is_default) ?? lista[0])?.id ?? "");
  }
  if (!deposito) pendencias.push("não consegui ler o depósito de venda da loja no TikTok");

  // atributos da categoria: obrigatórios + os que o produto-molde preenche (valor do molde como sugestão)
  const atributos: AtribTt[] = [];
  if (categoriaId) {
    const at = await tt(c, "GET", `/product/202309/categories/${categoriaId}/attributes`);
    const doMolde = new Map(((molde?.p?.product_attributes ?? []) as any[]).map((a) => [String(a.id), ((a.values ?? []) as any[]).map((v) => String(v.name ?? "")).filter(Boolean)]));
    const usarMolde = folhaMolde && String(folhaMolde.id) === categoriaId;
    for (const a of ((at.j?.data?.attributes ?? []) as any[])) {
      if (a.type && a.type !== "PRODUCT_PROPERTY") continue;
      const obrig = a.is_requried === true || a.is_required === true;
      const id = String(a.id);
      const sugestao = usarMolde ? (doMolde.get(id) ?? []).join(", ") : "";
      if (!obrig && !sugestao) continue;
      const vals = ((a.values ?? []) as any[]).map((v) => ({ id: String(v.id), name: String(v.name ?? "") }));
      const digitado = typeof op.atributos?.[id] === "string" ? String(op.atributos[id]).trim() : null;
      const valor = digitado ?? sugestao;
      atributos.push({ id, nome: String(a.name ?? id), obrigatorio: obrig, valor, opcoes: vals.map((v) => v.name).slice(0, 200),
        dica: a.is_customizable ? "escolha da lista ou escreva" : (vals.length ? "escolha da lista" : null), _vals: vals, _custom: a.is_customizable !== false });
      if (obrig && !valor) pendencias.push(`preencha a característica obrigatória "${a.name ?? id}"`);
    }
    const ru = await tt(c, "GET", `/product/202309/categories/${categoriaId}/rules`);
    const certs = ((ru.j?.data?.product_certifications ?? []) as any[]).filter((x) => x.is_required);
    if (certs.length) pendencias.push(`o TikTok exige certificação nesta categoria (${certs.map((x) => x.name ?? x.id).join(", ")}): envie pelo Seller Center`);
  }
  const productAttributes = atributos.filter((a) => a.valor).map((a) => ({
    id: a.id,
    values: a.valor.split(",").map((s) => s.trim()).filter(Boolean).map((nome) => {
      const v = a._vals.find((x) => x.name.toLowerCase() === nome.toLowerCase());
      return v ? { id: v.id } : { name: nome };
    }),
  }));

  const estoque = Math.max(0, Math.floor(num(op.estoque) ?? 0));
  const foraDoAr = op.fora_do_ar !== false;
  if (estoque === 0) avisos.push("estoque inicial 0: o anúncio nasce esgotado até o Tiny mandar o estoque (depois do vínculo pelo SKU)");
  if (!foraDoAr) avisos.push("o TikTok analisa todo produto novo antes de mostrar aos compradores (pode levar algumas horas)");

  const corpo: Record<string, any> = {
    save_mode: foraDoAr ? "AS_DRAFT" : "LISTING",
    title: b.titulo, description: descricaoHtml(d.r), category_id: categoriaId,
    main_images: [] as { uri: string }[],
    skus: [{ seller_sku: String(d.r.sku), price: { amount: (b.preco ?? 0).toFixed(2), currency: "BRL" }, inventory: [{ warehouse_id: deposito, quantity: estoque }] }],
    package_weight: { value: String(medidas.peso_kg ?? ""), unit: "KILOGRAM" },
    package_dimensions: {
      length: String(Math.max(1, Math.ceil(medidas.comprimento_cm ?? 0))), width: String(Math.max(1, Math.ceil(medidas.largura_cm ?? 0))),
      height: String(Math.max(1, Math.ceil(medidas.altura_cm ?? 0))), unit: "CENTIMETER",
    },
  };
  if (marca) corpo.brand_id = marca.id;
  if (productAttributes.length) corpo.product_attributes = productAttributes;
  return {
    corpo, pendencias: [...new Set(pendencias)], avisos, medidasSalvar: med.salvar, tiny,
    previa: {
      loja: c.nome, titulo: b.titulo, descricao: b.descricao, preco: b.preco, estoque, fora_do_ar: foraDoAr, sku: String(d.r.sku), medidas,
      categoria, categorias_sugeridas: sugeridas, marca: { id: 0, nome: marca?.nome ?? "Sem marca" },
      fotos: b.fotos, ean: d.extra?.gtin ?? tiny.gtin ?? null, limites: { titulo: LIM_TT.titulo, fotos: LIM_TT.fotos },
      atributos: atributos.map(({ _vals, _custom, ...x }) => x),
    },
  };
}

// ---------------------------------------------------------------- modo ATUALIZAR
async function montarAtualizarTt(d: Dados, op: Opcoes, c: Tt, alvo: Existente) {
  const b = base(d, op, LIM_TT);
  const campos = {
    titulo: op.campos?.titulo !== false, descricao: op.campos?.descricao !== false,
    fotos: op.campos?.fotos !== false, preco: op.campos?.preco === true,
  };
  const pendencias: string[] = []; const avisos: string[] = [];
  if (!campos.titulo && !campos.descricao && !campos.fotos && !campos.preco) pendencias.push("marque ao menos um item para atualizar");
  if (campos.titulo) pendencias.push(...b.problemas.titulo);
  if (campos.descricao) pendencias.push(...b.problemas.descricao);
  if (campos.preco) pendencias.push(...b.problemas.preco);

  const p = await produtoTt(c, alvo.item_id);
  if (!p) throw new Error(`não consegui ler o produto ${alvo.item_id} no TikTok`);
  const skusP = ((p.skus ?? []) as any[]);
  const sku = skusP.find((s) => String(s.seller_sku ?? "").trim() === String(d.r.sku)) ?? (skusP.length === 1 ? skusP[0] : null);
  const precoAtual = num(sku?.price?.sale_price ?? sku?.price?.tax_exclusive_price);
  if (campos.preco && !sku) pendencias.push("não achei, neste produto do TikTok, o SKU deste produto para trocar o preço");
  if (skusP.length > 1 && (campos.titulo || campos.descricao || campos.fotos)) avisos.push(`este produto tem ${skusP.length} variações: título, descrição e fotos valem para o produto INTEIRO`);
  if (p.status && p.status !== "ACTIVATE") avisos.push(`o produto está com a situação ${p.status} no TikTok`);
  avisos.push("o TikTok pode analisar o produto de novo depois da edição");

  const imgs = ((p.main_images ?? []) as any[]);
  const idsAtuais = imgs.map((i) => String(i.uri));
  const fotosAtuais = imgs.map((i) => String(i.urls?.[0] ?? i.thumb_urls?.[0] ?? ""));
  const todasNovas = d.fotos.map((f: any) => ({ path: f.storage_path as string, tipo: f.tipo as string }));
  const selF = (op.fotos ?? {}) as Record<string, any>;
  const manter = fotosQueFicam(selF, idsAtuais);
  const novas = Array.isArray(selF.novas) ? todasNovas.filter((f) => (selF.novas as unknown[]).map(String).includes(f.path)) : todasNovas;
  const posicao: "inicio" | "fim" = selF.posicao === "inicio" || selF.posicao === "fim" ? selF.posicao
    : (String(novas[0]?.tipo ?? "").startsWith("capa_") ? "inicio" : "fim");
  if (campos.fotos) {
    const total = manter.length + novas.length;
    if (total === 0) pendencias.push("o produto precisa de ao menos 1 foto");
    if (total > LIM_TT.fotos) pendencias.push(`o TikTok aceita ${LIM_TT.fotos} fotos e há ${total} marcadas (${manter.length} atuais + ${novas.length} novas): desmarque ${total - LIM_TT.fotos}`);
    if (novas.length === 0 && manter.length === idsAtuais.length) pendencias.push("nada muda nas fotos: desmarque \"Fotos\" ou escolha o que entra e o que sai");
    if (manter.length < idsAtuais.length) avisos.push(`${idsAtuais.length - manter.length} foto(s) atual(is) do produto sai(em)`);
  }
  const descAtual = String(p.description ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const corpo: Record<string, any> = {};
  if (campos.titulo) corpo.title = b.titulo;
  if (campos.descricao) corpo.description = descricaoHtml(d.r);
  if (campos.fotos) corpo.main_images = [] as { uri: string }[];
  const corpoPreco = campos.preco && sku ? { skus: [{ id: String(sku.id), price: { amount: (b.preco ?? 0).toFixed(2), currency: "BRL" } }] } : null;
  const antes = { titulo: String(p.title ?? ""), descricao: String(p.description ?? ""), fotos: fotosAtuais, uris: idsAtuais, preco: precoAtual };
  return {
    corpo, corpoPreco, pendencias: [...new Set(pendencias)], avisos, campos, antes, plano: { manter, novas, posicao, atuais: idsAtuais },
    previa: {
      loja: c.nome, sku: String(d.r.sku), titulo: b.titulo, descricao: b.descricao, preco: b.preco, fotos: todasNovas,
      fotos_plano: { manter, novas: novas.map((f) => f.path), posicao }, limites: { titulo: LIM_TT.titulo, fotos: LIM_TT.fotos },
      alvo: { ...alvo, n_variacoes: skusP.length > 1 ? skusP.length : 0, situacao: p.status ?? null }, campos,
      atual: { titulo: antes.titulo, descricao: descAtual, fotos: idsAtuais.map((id, i) => ({ id, url: fotosAtuais[i] ?? "" })), preco: precoAtual },
    },
  };
}

// ---------------------------------------------------------------- entrada
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") || "";
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const op: Opcoes = (body.opcoes ?? {}) as Opcoes;

  try {
    if (!body.rascunho_id) return json({ ok: false, erro: "informe rascunho_id" }, 400);
    const d = await carregar(String(body.rascunho_id));
    const empresaD = body.destino?.empresa === "svl" ? "svl" : body.destino?.empresa === "ottz" ? "ottz" : String(d.r.empresa);
    if (!LOJA_TT[empresaD]) {
      return json({ ok: true, disponivel: false, canal: "tiktok", publicacoes: d.publicacoes,
        motivo: "o TikTok Shop da Bumi ainda não autorizou o app: por enquanto o envio vai só para a loja da Ottz/ACZ" });
    }
    if (d.r.canal !== "tiktok" || d.r.empresa !== empresaD) {
      // o preço do rascunho é o do canal DELE: para o TikTok vale o salvo para o destino ou o sugerido
      const salvo = num(d.r.memoria_calculo?.destinos?.[`tiktok:${empresaD}`]?.preco);
      let sugerido: number | null = null;
      if (salvo == null && quem.doUsuario) {
        const { data: pr } = await quem.doUsuario.rpc("ia_calcular_preco", { p_sku: d.r.sku, p_canal: "tiktok", p_empresa: empresaD });
        sugerido = num((pr as Record<string, unknown> | null)?.preco_sugerido);
      }
      d.r = { ...d.r, canal: "tiktok", empresa: empresaD, preco_aprovado: salvo, preco_sugerido: sugerido };
    }
    const c = await ctxTiktok(empresaD);
    const existentes = await existentesTt(c.shopId, String(d.r.sku));
    const modo: "criar" | "atualizar" = op.modo === "criar" || op.modo === "atualizar" ? op.modo : (existentes.length ? "atualizar" : "criar");
    const alvo = modo === "atualizar" ? (existentes.find((e) => e.item_id === String(op.item_id ?? "")) ?? existentes[0]) : null;
    if (modo === "atualizar" && !alvo) return json({ ok: false, erro: "este produto não tem anúncio nesta loja do TikTok para atualizar — use Criar anúncio novo" }, 400);

    const mC = modo === "criar" ? await montarCriarTt(d, op, c, existentes) : null;
    const mA = modo === "atualizar" ? await montarAtualizarTt(d, op, c, { ...alvo! }) : null;
    const m = (mC ?? mA)!;

    if (modulo === "previa") {
      return json({ ok: true, disponivel: true, canal: "tiktok", modo, existentes, previa: m.previa, pendencias: m.pendencias, avisos: m.avisos, publicacoes: d.publicacoes });
    }
    if (modulo !== "enviar") return json({ ok: false, erro: "use ?modulo=previa ou enviar" }, 400);

    if (body.confirmar !== true) return json({ ok: false, erro: "envio exige confirmar: true" }, 400);
    if (!quem.id) return json({ ok: false, erro: "o envio exige sessão de usuário" }, 401);
    if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
    if (modo === "criar") {
      const jaFoi = d.publicacoes.find((p) => p.canal === "tiktok" && p.empresa === empresaD && p.estado === "publicado" && p.operacao !== "atualizar");
      if (jaFoi && op.de_novo !== true) return json({ ok: false, erro: `este rascunho já criou o produto ${jaFoi.item_id} no TikTok. Para criar outro, marque "criar outro anúncio mesmo assim".` }, 409);
    }
    const emCurso = d.publicacoes.find((p) => p.estado === "enviando" && Date.now() - new Date(p.criado_em).getTime() < 3 * 60_000);
    if (emCurso) return json({ ok: false, erro: "já há um envio em andamento para este rascunho — aguarde" }, 409);

    const { data: pub, error: ePub } = await db.from("ia_publicacao").insert({
      rascunho_id: d.r.id, sku: d.r.sku, canal: "tiktok", empresa: empresaD, shop_id: c.shopId, estado: "enviando", operacao: modo,
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
      await db.from("ia_produto_extra").upsert({ sku: d.r.sku, ...mC.medidasSalvar, gtin: d.extra?.gtin ?? mC.tiny.gtin ?? null, ncm: d.extra?.ncm ?? mC.tiny.ncm ?? null }, { onConflict: "sku" });
      try { mC.corpo.main_images = (await subirFotosTt(c, mC.previa.fotos)).map((uri) => ({ uri })); }
      catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
      const r = await tt(c, "POST", "/product/202309/products", {}, mC.corpo);
      const id = r.j?.data?.product_id ? String(r.j.data.product_id) : "";
      if (!okTt(r) || !id) return await falhar(`o TikTok recusou o produto: ${motivoTt(r)}`, r.j);
      const url = urlProduto(id);
      await db.from("ia_publicacao").update({ estado: "publicado", item_id: id, url, enviado: mC.corpo, resposta: r.j }).eq("id", pub.id);
      await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
      const avisosResp = ((r.j?.data?.warnings ?? []) as any[]).map((w) => `aviso do TikTok: ${w.message ?? JSON.stringify(w)}`);
      return json({ ok: true, modo, item_id: id, url, fora_do_ar: mC.previa.fora_do_ar, avisos: [...mC.avisos, ...avisosResp] });
    }

    // ------------------------------------------------ ATUALIZAR
    const a = mA!;
    const respostas: Record<string, unknown> = {};
    const feitos: string[] = [];
    if (a.campos.fotos) {
      try {
        const novas = await subirFotosTt(c, a.plano.novas);
        a.corpo.main_images = ordemFinal(op, a.plano, novas, null).map((uri) => ({ uri }));
      } catch (e) { return await falhar(String(e instanceof Error ? e.message : e)); }
    }
    if (a.campos.titulo || a.campos.descricao || a.campos.fotos) {
      const r = await tt(c, "POST", `/product/202309/products/${a.previa.alvo.item_id}/partial_edit`, {}, a.corpo);
      respostas.partial_edit = r.j;
      if (!okTt(r)) return await falhar(`o TikTok recusou a atualização: ${motivoTt(r)}`, respostas);
      feitos.push(...[a.campos.titulo ? "título" : "", a.campos.descricao ? "descrição" : "", a.campos.fotos ? "fotos" : ""].filter(Boolean));
    }
    if (a.corpoPreco) {
      const r = await tt(c, "POST", `/product/202309/products/${a.previa.alvo.item_id}/prices/update`, {}, a.corpoPreco);
      respostas.preco = r.j;
      if (!okTt(r)) return await falhar(`${feitos.length ? `${feitos.join(", ")} atualizado(s), mas ` : ""}o TikTok recusou o preço: ${motivoTt(r)}`, respostas);
      feitos.push("preço");
    }
    await db.from("ia_publicacao").update({ estado: "publicado", url: a.previa.alvo.url, enviado: registro(), resposta: respostas }).eq("id", pub.id);
    await db.from("ia_rascunho").update({ status: "publicado" }).eq("id", d.r.id);
    return json({ ok: true, modo, item_id: a.previa.alvo.item_id, url: a.previa.alvo.url, atualizados: feitos, avisos: a.avisos });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
