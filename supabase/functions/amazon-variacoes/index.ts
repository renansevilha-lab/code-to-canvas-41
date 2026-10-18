// ============================================================================
// Edge Function: amazon-variacoes v1 (18/out/2026) — IA · Anúncios
// ----------------------------------------------------------------------------
// Variações (família de tamanhos etc.) em anúncio da Amazon que JÁ EXISTE. Pedido do dono: opções B + C
//   B) pôr na família um anúncio nosso que hoje está SOLTO (PATCH no SKU: vira filho do pai);
//   C) criar um tamanho NOVO dentro da família (PUT de um SKU novo, copiando a ficha de um irmão).
// Sem família ainda: cria o PAI (PUT parentage_level = parent), copiado da ficha do anúncio escolhido.
//   POST ?modulo=ler     {empresa, busca}  busca = ASIN (B0…), SKU da Amazon ou o nosso SKU
//        → o anúncio, a família (pai, tema, filhos com o valor de cada um) e sugestões do Tiny (kits do
//          mesmo produto base: os que já têm anúncio na Amazon entram pelo B, os outros pelo C). Só leitura.
//   POST ?modulo=previa  {empresa, pai_sku | criar_pai:{sku, tema, molde_sku}, entrar:[{sku_amazon, valor}],
//        novos:[{sku, valor, preco, ean?, marca?}]} → monta tudo e passa no VALIDADOR da Amazon
//        (mode=VALIDATION_PREVIEW: a Amazon só confere). Também confere valor repetido na família.
//   POST ?modulo=aplicar {…o mesmo…, confirmar: true} → na ordem pai → entrar → novos, cada envio UMA vez
//        (sem repetição), para no 1º que a Amazon recusar. Registro em debug_fulfillment
//        (modulo 'amazon-variacoes').
// Regras que custaram ensaio (18/out, ver CLAUDE.md §5.11.12.1): o filho precisa de
// `external_testing_certification` no envio mesmo já preenchido; o validador NÃO acusa valor repetido.
// Código de barras do tamanho novo: EAN do Tiny só se for do PRÓPRIO produto (kit herda o da unidade e
// cairia na ficha dela); senão vai sem código (`supplier_declared_has_product_identifier_exemption`).
// SKU novo na Amazon = `<nosso sku>_FBA` (o fulfillment-sync já casa esse formato com o cadastro).
// Sessão de usuário com o módulo `ia`. Até 19/out 03:00 UTC, `ler` e `previa` (que não escrevem)
// também aceitam a chave publicável — rota de ensaio, morre sozinha.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const CONTA: Record<string, { shop_id: number; nome: string }> = {
  ottz: { shop_id: 900001, nome: "Amazon · ACZ Pet" },
  svl: { shop_id: 900002, nome: "Amazon · SVL" },
};
const ENSAIO_ATE = Date.parse("2026-10-19T03:00:00Z");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const num = (v: unknown): number => { const n = Number(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

async function exigirAcesso(req: Request, modulo: string): Promise<{ nome: string | null } | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "anon" && (modulo === "ler" || modulo === "previa") && Date.now() < ENSAIO_ATE) return { nome: "ensaio" };
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

// ---------------------------------------------------------------- Amazon
type Conta = { shop_id: number; nome: string; token: string; seller: string; mkt: string };
type Resp = { status: number; body: any };
async function conta(empresa: string): Promise<Conta> {
  const c = CONTA[empresa] ?? CONTA.ottz;
  const { data } = await db.from("oauth_tokens_amazon").select("access_token, expires_at, merchant_token, marketplace_id").eq("shop_id", c.shop_id).maybeSingle();
  if (!data) throw new Error(`a conta ${c.nome} não está conectada`);
  if (!data.merchant_token) throw new Error(`falta o código de vendedor (Merchant Token) da conta ${c.nome}`);
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token da Amazon vencido — a renovação automática roda a cada 20 min; tente de novo em instantes");
  return { ...c, token: String(data.access_token), seller: String(data.merchant_token), mkt: String(data.marketplace_id || MKT_BR) };
}
async function sp(c: Conta, metodo: string, path: string, params: Record<string, string> = {}, corpo?: unknown): Promise<Resp> {
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
}
const itemPath = (c: Conta, s: string) => `/listings/2021-08-01/items/${encodeURIComponent(c.seller)}/${encodeURIComponent(s)}`;
async function lerItem(c: Conta, s: string, incluir = "summaries,attributes,relationships,issues"): Promise<Resp> {
  return await sp(c, "GET", itemPath(c, s), { marketplaceIds: c.mkt, includedData: incluir, issueLocale: "pt_BR" });
}
function problemas(body: any): { erros: string[]; avisos: string[] } {
  const erros: string[] = []; const avisos: string[] = [];
  for (const i of arr(body?.issues)) {
    const onde = arr(i?.attributeNames).join(", ");
    const t = `${i?.code ?? ""}: ${String(i?.message ?? "").slice(0, 240)}${onde ? ` [${onde}]` : ""}`;
    (String(i?.severity) === "ERROR" ? erros : avisos).push(t);
  }
  for (const e of arr(body?.errors)) erros.push(`${e?.code ?? ""}: ${String(e?.message ?? "").slice(0, 240)}`);
  return { erros, avisos };
}
const ok = (r: Resp) => r.status >= 200 && r.status < 300;

/** O valor do tema num anúncio (ex.: SIZE → attributes.size[0].value). */
function attrsDoTema(tema: string): string[] {
  return tema.toLowerCase().split("/").map((x) => x.trim()).filter(Boolean)
    .map((x) => (x === "size_name" ? "size" : x === "color_name" ? "color" : x));
}
function valorDoTema(attrs: any, tema: string): string {
  return attrsDoTema(tema).map((k) => {
    const v = attrs?.[k]?.[0];
    return v == null ? "" : String(v.value ?? v.name ?? "");
  }).filter(Boolean).join(" / ");
}
/** Nosso SKU a partir do SKU da Amazon (16330_FBA → 16330; FBA-15825 → 15825; de-para). */
async function nossoSku(skuAmz: string): Promise<string> {
  const m = /^(.+)_FBA$/i.exec(skuAmz) ?? /^FBA-(.+)$/i.exec(skuAmz);
  if (m) return m[1];
  const { data } = await db.from("sku_mapeamento").select("sku_correto").ilike("marketplace", "amazon%").eq("sku_origem", skuAmz).maybeSingle();
  return String(data?.sku_correto ?? skuAmz);
}

type Filho = { sku_amazon: string; sku: string; asin: string | null; valor: string; titulo: string | null; situacao: string[]; preco: number | null };
type Familia = { pai_sku: string; pai_asin: string | null; tema: string; titulo: string | null; tipo: string | null; filhos: Filho[] };

async function lerFamilia(c: Conta, paiSku: string): Promise<Familia | null> {
  const r = await lerItem(c, paiSku);
  if (!ok(r)) return null;
  const a = r.body?.attributes ?? {};
  const sm = r.body?.summaries?.[0] ?? {};
  const tema = String(a.variation_theme?.[0]?.name ?? r.body?.relationships?.[0]?.relationships?.[0]?.variationTheme?.theme ?? "");
  const filhosSku: string[] = [...new Set(arr(r.body?.relationships?.[0]?.relationships).flatMap((x: any) => arr(x.childSkus)).map(String))];
  const filhos: Filho[] = [];
  for (const s of filhosSku.slice(0, 30)) {
    const f = await lerItem(c, s, "summaries,attributes");
    const fa = f.body?.attributes ?? {}; const fs = f.body?.summaries?.[0] ?? {};
    filhos.push({
      sku_amazon: s, sku: await nossoSku(s), asin: fs.asin ?? null, valor: valorDoTema(fa, tema),
      titulo: fs.itemName ?? fa.item_name?.[0]?.value ?? null, situacao: arr(fs.status).map(String),
      preco: fa.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null,
    });
  }
  return { pai_sku: paiSku, pai_asin: sm.asin ?? null, tema, titulo: sm.itemName ?? a.item_name?.[0]?.value ?? null, tipo: sm.productType ?? null, filhos };
}

/** Peso em kg escrito no nome ("… 4kg", "500g"): a última ocorrência. */
function pesoDoNome(nome: string): number | null {
  const ms = [...String(nome).matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/gi)];
  const m = ms[ms.length - 1];
  if (!m) return null;
  const v = num(m[1]);
  return m[2].toLowerCase() === "g" ? v / 1000 : v;
}
/** GTIN (8, 12, 13 ou 14 dígitos) com dígito verificador certo. */
function gtinValido(g: string): boolean {
  if (![8, 12, 13, 14].includes(g.length) || !/^\d+$/.test(g)) return false;
  const ds = g.split("").map(Number); const dv = ds.pop()!;
  const soma = ds.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === dv;
}
const fmtKg = (v: number) => `${String(Math.round(v * 100) / 100).replace(".", ",")}kg`;

/** Produto do cadastro: nome, peso (kit = soma da composição; senão o do cadastro) e EAN próprio. */
async function produto(sku: string) {
  const { data: p } = await db.from("produtos").select("sku, nome, tipo, gtin, peso_bruto, marca, marca_manual").eq("sku", sku).maybeSingle();
  if (!p) return null;
  const { data: kit } = await db.from("produto_kits").select("sku_componente, quantidade").eq("sku_kit", sku);
  const comp = arr(kit);
  let peso = num(p.peso_bruto) > 0 ? num(p.peso_bruto) : 0;
  let pesoLiq: number | null = null;
  if (comp.length) {
    const { data: cs } = await db.from("produtos").select("sku, nome, peso_bruto").in("sku", comp.map((x) => String(x.sku_componente)));
    const porSku = new Map(arr(cs).map((x) => [String(x.sku), x]));
    let soma = 0; let liq = 0; let liqOk = true;
    for (const k of comp) {
      const c = porSku.get(String(k.sku_componente));
      soma += num(c?.peso_bruto) * num(k.quantidade);
      const pn = pesoDoNome(String(c?.nome ?? ""));
      if (pn == null) liqOk = false; else liq += pn * num(k.quantidade);
    }
    // kit: vale a soma da composição — o peso do kit no Tiny vem errado (8kg com 4,01; 20kg com 12,03)
    if (soma > 0) peso = soma;
    if (liqOk && liq > 0) pesoLiq = liq;
  }
  if (pesoLiq == null) pesoLiq = pesoDoNome(String(p.nome));
  // EAN só se for do PRÓPRIO produto: kit costuma herdar o da unidade (aí cairia na ficha dela)
  let ean: string | null = String(p.gtin ?? "").replace(/\D/g, "") || null;
  if (ean) {
    const { count } = await db.from("produtos").select("sku", { count: "exact", head: true }).eq("gtin", p.gtin).neq("sku", sku).eq("ativo", true);
    if ((count ?? 0) > 0) ean = null;
  }
  return { sku, nome: String(p.nome), tipo: String(p.tipo ?? ""), peso_kg: peso || null, peso_liquido_kg: pesoLiq, ean, componentes: comp };
}

// ---------------------------------------------------------------- montar os envios
// campos do irmão que NÃO são copiados para o tamanho novo (identificam o outro anúncio ou são refeitos)
const NAO_COPIAR = new Set([
  "externally_assigned_product_identifier", "supplier_declared_has_product_identifier_exemption", "merchant_suggested_asin",
  "item_name", "child_parent_sku_relationship", "parentage_level", "variation_theme", "purchasable_offer", "list_price",
  "fulfillment_availability", "product_site_launch_date", "model_number", "model_name", "item_package_weight", "item_weight",
]);
const txt = (c: Conta, v: string) => [{ value: v, language_tag: "pt_BR", marketplace_id: c.mkt }];
const so = (c: Conta, v: unknown) => [{ value: v, marketplace_id: c.mkt }];

function tituloComValor(base: string, valor: string): string {
  const b = String(base ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${b} (${valor})`.slice(0, 200);
}
function valorDoTemaAttrs(c: Conta, tema: string, valor: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ks = attrsDoTema(tema); const vs = valor.split("/").map((x) => x.trim());
  ks.forEach((k, i) => {
    const v = vs[i] ?? vs[0] ?? valor;
    out[k] = ["number_of_items", "item_package_quantity", "total_product_quantity"].includes(k) ? so(c, Math.max(1, Math.round(num(v.replace(/[^\d.,]/g, ""))) || 1)) : txt(c, v);
  });
  return out;
}

type Plano = { tipo: "pai" | "entrar" | "novo"; sku_amazon: string; sku?: string; valor?: string; metodo: "PUT" | "PATCH"; productType: string; corpo: unknown; avisos: string[]; pendencias: string[] };

async function montar(c: Conta, body: any): Promise<{ planos: Plano[]; familia: Familia | null; pendencias: string[]; avisos: string[] }> {
  const pendencias: string[] = []; const avisos: string[] = []; const planos: Plano[] = [];
  const criarPai = body?.criar_pai && typeof body.criar_pai === "object" ? body.criar_pai : null;
  const paiSku = String(criarPai?.sku ?? body?.pai_sku ?? "").trim();
  if (!paiSku) return { planos, familia: null, pendencias: ["escolha a família (SKU do pai) ou crie uma"], avisos };
  let familia: Familia | null = null;
  let tema = ""; let tipo = ""; let tituloBase = ""; let molde: any = null; let moldeSku = "";

  if (criarPai) {
    tema = String(criarPai.tema ?? "SIZE").trim() || "SIZE";
    moldeSku = String(criarPai.molde_sku ?? "").trim();
    if (!moldeSku) pendencias.push("para criar a família, escolha o anúncio que serve de modelo da ficha");
    const existe = await lerItem(c, paiSku, "summaries");
    if (ok(existe)) pendencias.push(`já existe um anúncio com o SKU ${paiSku} nesta conta: escolha outro SKU para o pai`);
  } else {
    familia = await lerFamilia(c, paiSku);
    if (!familia) return { planos, familia, pendencias: [`não achei o anúncio pai ${paiSku} nesta conta`], avisos };
    if (!familia.tema) pendencias.push(`o anúncio ${paiSku} não é pai de variação (sem tema)`);
    tema = familia.tema; tipo = familia.tipo ?? ""; tituloBase = familia.titulo ?? "";
    moldeSku = String(body?.molde_sku ?? familia.filhos[0]?.sku_amazon ?? "");
  }
  if (moldeSku) {
    const m = await lerItem(c, moldeSku, "summaries,attributes");
    if (ok(m)) { molde = m.body; tipo = tipo || String(m.body?.summaries?.[0]?.productType ?? ""); }
    else pendencias.push(`não consegui ler o anúncio modelo ${moldeSku}`);
  }
  if (!tituloBase) tituloBase = String(molde?.attributes?.item_name?.[0]?.value ?? "");

  // valores: não pode repetir na família nem entre os novos
  const usados = new Map<string, string>();
  for (const f of familia?.filhos ?? []) if (f.valor) usados.set(f.valor.toLowerCase().replace(/\s+/g, ""), f.sku_amazon);
  const conferirValor = (valor: string, quem: string, lista: string[]) => {
    const v = valor.toLowerCase().replace(/\s+/g, "");
    if (!v) { lista.push(`${quem}: informe o valor da variação (ex.: 12kg)`); return; }
    const outro = usados.get(v);
    if (outro && outro !== quem) lista.push(`${quem}: o valor "${valor}" já existe na família (${outro}) — a Amazon não aceita dois iguais`);
    usados.set(v, quem);
  };

  if (criarPai && molde) {
    const a: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(molde.attributes ?? {})) {
      if (NAO_COPIAR.has(k) || attrsDoTema(tema).includes(k) || /image_locator/.test(k) || ["condition_type", "merchant_shipping_group", "skip_offer"].includes(k)) continue;
      a[k] = v;
    }
    const titulo = String(criarPai.titulo ?? tituloBase.replace(/\s*\([^)]*\)\s*$/, "")).slice(0, 200);
    Object.assign(a, {
      item_name: txt(c, titulo), parentage_level: so(c, "parent"),
      child_parent_sku_relationship: [{ child_relationship_type: "variation", marketplace_id: c.mkt }],
      variation_theme: [{ name: tema, marketplace_id: c.mkt }],
    });
    const img = molde.attributes?.main_product_image_locator; if (img) a.main_product_image_locator = img;
    planos.push({ tipo: "pai", sku_amazon: paiSku, metodo: "PUT", productType: tipo, corpo: { productType: tipo, requirements: "LISTING", attributes: a }, avisos: [], pendencias: [] });
    tituloBase = titulo;
  }

  // B) anúncio nosso que hoje está solto entra na família
  for (const e of arr(body?.entrar)) {
    const skuAmz = String(e?.sku_amazon ?? "").trim(); const valor = String(e?.valor ?? "").trim();
    const pend: string[] = []; const avs: string[] = [];
    if (!skuAmz) continue;
    const r = await lerItem(c, skuAmz, "summaries,attributes,relationships,issues");
    if (!ok(r)) { pend.push(`não achei o anúncio ${skuAmz} nesta conta`); planos.push({ tipo: "entrar", sku_amazon: skuAmz, valor, metodo: "PATCH", productType: tipo, corpo: null, avisos: avs, pendencias: pend }); continue; }
    const pt = String(r.body?.summaries?.[0]?.productType ?? tipo);
    const rel = arr(r.body?.relationships?.[0]?.relationships);
    const paiAtual = rel.flatMap((x: any) => arr(x.parentSkus)).map(String)[0];
    if (paiAtual === paiSku) pend.push(`${skuAmz} já está nesta família`);
    else if (paiAtual) avs.push(`${skuAmz} sai da família ${paiAtual} e entra nesta`);
    if (rel.some((x: any) => arr(x.childSkus).length)) pend.push(`${skuAmz} é pai de outra família: não pode virar filho`);
    if (tipo && pt && pt !== tipo) pend.push(`${skuAmz} é do tipo ${pt} e a família é ${tipo}: a Amazon só junta o mesmo tipo de produto`);
    conferirValor(valor, skuAmz, pend);
    for (const x of problemas(r.body).erros) avs.push(`a Amazon já aponta neste anúncio: ${x}`);
    const patches: unknown[] = [
      { op: "replace", path: "/attributes/parentage_level", value: so(c, "child") },
      { op: "replace", path: "/attributes/child_parent_sku_relationship", value: [{ child_relationship_type: "variation", parent_sku: paiSku, marketplace_id: c.mkt }] },
      { op: "replace", path: "/attributes/variation_theme", value: [{ name: tema, marketplace_id: c.mkt }] },
      ...Object.entries(valorDoTemaAttrs(c, tema, valor)).map(([k, v]) => ({ op: "replace", path: `/attributes/${k}`, value: v })),
      // o filho de variação passa a exigir este campo no envio, mesmo já preenchido (ensaio de 18/out)
      { op: "replace", path: "/attributes/external_testing_certification", value: r.body?.attributes?.external_testing_certification ?? so(c, "Não Aplicável") },
    ];
    planos.push({ tipo: "entrar", sku_amazon: skuAmz, sku: await nossoSku(skuAmz), valor, metodo: "PATCH", productType: pt, corpo: { productType: pt, patches }, avisos: avs, pendencias: pend });
  }

  // C) tamanho novo: SKU novo, ficha copiada do irmão
  for (const n of arr(body?.novos)) {
    const sku = String(n?.sku ?? "").trim(); const valor = String(n?.valor ?? "").trim(); const preco = num(n?.preco);
    const pend: string[] = []; const avs: string[] = [];
    if (!sku) continue;
    const skuAmz = String(n?.sku_amazon ?? `${sku}_FBA`).trim();
    const p = await produto(sku);
    if (!p) pend.push(`SKU ${sku} não está no cadastro`);
    if (!molde) pend.push("sem anúncio modelo para copiar a ficha");
    if (preco <= 0) pend.push(`${sku}: informe o preço`);
    conferirValor(valor, skuAmz, pend);
    const ja = await lerItem(c, skuAmz, "summaries");
    if (ok(ja)) pend.push(`já existe o anúncio ${skuAmz} nesta conta (ASIN ${ja.body?.summaries?.[0]?.asin ?? "?"}): use "pôr na família"`);
    const a: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(molde?.attributes ?? {})) if (!NAO_COPIAR.has(k) && !attrsDoTema(tema).includes(k)) a[k] = v;
    const marca = String(n?.marca ?? "").trim();
    if (marca) { a.brand = txt(c, marca); a.manufacturer = txt(c, marca); avs.push(`marca trocada para "${marca}"`); }
    Object.assign(a, {
      item_name: txt(c, tituloComValor(tituloBase, valor)),
      model_name: txt(c, String(p?.nome ?? valor).slice(0, 60)), model_number: so(c, sku),
      parentage_level: so(c, "child"),
      child_parent_sku_relationship: [{ child_relationship_type: "variation", parent_sku: paiSku, marketplace_id: c.mkt }],
      variation_theme: [{ name: tema, marketplace_id: c.mkt }],
      ...valorDoTemaAttrs(c, tema, valor),
      external_testing_certification: molde?.attributes?.external_testing_certification ?? so(c, "Não Aplicável"),
      condition_type: so(c, "new_new"),
      purchasable_offer: [{ currency: "BRL", audience: "ALL", our_price: [{ schedule: [{ value_with_tax: preco }] }], marketplace_id: c.mkt }],
      list_price: [{ currency: "BRL", value_with_tax: preco, marketplace_id: c.mkt }],
      fulfillment_availability: [{ fulfillment_channel_code: "AMAZON_NA", marketplace_id: c.mkt }],
    });
    if (p?.peso_kg) a.item_package_weight = [{ unit: "kilograms", value: Math.round(p.peso_kg * 100) / 100, marketplace_id: c.mkt }];
    else avs.push(`${sku}: sem peso no cadastro — vai o peso da embalagem do modelo`);
    if (!a.item_package_weight && molde?.attributes?.item_package_weight) a.item_package_weight = molde.attributes.item_package_weight;
    if (p?.peso_liquido_kg) a.item_weight = [{ unit: "kilograms", value: Math.round(p.peso_liquido_kg * 100) / 100, marketplace_id: c.mkt }];
    if (p?.componentes?.length) avs.push(`${sku}: as medidas da caixa vêm do modelo (${moldeSku}) — confira se a embalagem do kit é outra`);
    // código de barras: o digitado na tela > o do cadastro (se for só deste produto). Sem nenhum, vai com a
    // isenção — a Amazon só aceita se a marca tiver isenção de GTIN APROVADA no Seller Central (ensaio de
    // 18/out: sem código = erro 8560, também com a marca "Genérico"/"Generic").
    const eanInf = String(n?.ean ?? "").replace(/\D/g, "");
    if (eanInf && !gtinValido(eanInf)) pend.push(`${sku}: o código de barras ${eanInf} não é válido (EAN tem 13 dígitos e o último confere os outros)`);
    const ean = eanInf || p?.ean || null;
    if (ean) a.externally_assigned_product_identifier = [{ type: "ean", value: ean, marketplace_id: c.mkt }];
    else {
      a.supplier_declared_has_product_identifier_exemption = so(c, true);
      avs.push(`${sku}: sem código de barras — só passa se a marca tiver isenção de GTIN aprovada na Amazon`);
    }
    avs.push("tamanho novo no FBA: o anúncio só vende depois de o estoque chegar ao CD (envio pela Reposição)");
    planos.push({ tipo: "novo", sku_amazon: skuAmz, sku, valor, metodo: "PUT", productType: tipo, corpo: { productType: tipo, requirements: "LISTING", attributes: a }, avisos: avs, pendencias: pend });
  }
  if (!planos.length) pendencias.push("nada a enviar: escolha um anúncio para pôr na família ou um tamanho novo");
  if (planos.length && !planos.some((x) => x.tipo !== "pai")) avisos.push("a família nasce sem filhos — inclua ao menos um anúncio");
  return { planos, familia, pendencias, avisos };
}

/** Resumo do envio para a tela (sem o corpo inteiro). */
function resumo(p: Plano) {
  const at = (p.corpo as any)?.attributes ?? {};
  return {
    tipo: p.tipo, sku_amazon: p.sku_amazon, sku: p.sku ?? null, valor: p.valor ?? null,
    titulo: at.item_name?.[0]?.value ?? null, preco: at.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null,
    codigo_barras: at.externally_assigned_product_identifier?.[0]?.value ?? (at.supplier_declared_has_product_identifier_exemption ? "sem código (isenção)" : null),
    peso_kg: at.item_package_weight?.[0]?.value ?? null,
  };
}

// ---------------------------------------------------------------- ler
async function ler(c: Conta, busca: string) {
  const q = busca.trim();
  let alvoSku = ""; let asin = "";
  const ehAsin = /^B0[A-Z0-9]{8}$/i.test(q);
  if (ehAsin) {
    asin = q.toUpperCase();
    const r = await sp(c, "GET", `/listings/2021-08-01/items/${encodeURIComponent(c.seller)}`, { marketplaceIds: c.mkt, identifiers: asin, identifiersType: "ASIN", includedData: "summaries", pageSize: "20" });
    alvoSku = String(arr(r.body?.items)[0]?.sku ?? "");
  } else {
    for (const s of [q, `${q}_FBA`, `FBA-${q}`]) {
      const r = await lerItem(c, s, "summaries");
      if (ok(r) && r.body?.summaries?.[0]?.asin) { alvoSku = s; asin = String(r.body.summaries[0].asin); break; }
    }
  }
  const cat = asin ? await sp(c, "GET", `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, { marketplaceIds: c.mkt, includedData: "summaries,relationships,identifiers,images" }) : null;
  const cs = cat?.body?.summaries?.[0] ?? {};
  const foto = arr(cat?.body?.images?.[0]?.images).find((x: any) => x.variant === "MAIN")?.link ?? null;
  const catalogo = cat && ok(cat) ? {
    asin, titulo: cs.itemName ?? null, marca: cs.brand ?? null, foto,
    ean: arr(cat.body?.identifiers?.[0]?.identifiers).map((x: any) => `${x.identifierType}:${x.identifier}`).slice(0, 3),
    url: `https://www.amazon.com.br/dp/${asin}`,
  } : null;
  if (!alvoSku) return { encontrado: Boolean(catalogo), nosso: false, catalogo, anuncio: null, familia: null, sugestoes: [], aviso: catalogo ? "este ASIN existe na Amazon, mas não tem anúncio nosso nesta conta" : "não achei esse ASIN/SKU nesta conta" };

  const r = await lerItem(c, alvoSku);
  const sm = r.body?.summaries?.[0] ?? {}; const a = r.body?.attributes ?? {};
  const rel = arr(r.body?.relationships?.[0]?.relationships);
  const paiSku = rel.flatMap((x: any) => arr(x.parentSkus)).map(String)[0] ?? (rel.some((x: any) => arr(x.childSkus).length) ? alvoSku : "");
  const anuncio = {
    sku_amazon: alvoSku, sku: await nossoSku(alvoSku), asin: sm.asin ?? asin, titulo: sm.itemName ?? a.item_name?.[0]?.value ?? null,
    tipo: sm.productType ?? null, situacao: arr(sm.status).map(String), e_pai: paiSku === alvoSku,
    marca: a.brand?.[0]?.value ?? null, preco: a.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null,
    pendencias_amazon: problemas(r.body).erros,
  };
  const familia = paiSku ? await lerFamilia(c, paiSku) : null;

  // sugestões do Tiny: produtos do mesmo produto base (kits de 1 componente) que ainda não estão na família
  const naFamilia = new Set((familia?.filhos ?? []).map((f) => f.sku));
  const skusBase = new Set<string>();
  const referencias = familia?.filhos.length ? familia.filhos.map((f) => f.sku) : [anuncio.sku];
  const { data: kitsRef } = await db.from("produto_kits").select("sku_kit, sku_componente").in("sku_kit", referencias);
  for (const k of arr(kitsRef)) skusBase.add(String(k.sku_componente));
  for (const s of referencias) if (!arr(kitsRef).some((k) => String(k.sku_kit) === s)) skusBase.add(s);
  const sugestoes: any[] = [];
  if (skusBase.size) {
    const { data: kits } = await db.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_componente", [...skusBase]);
    const candidatos = new Map<string, { base: string; qtd: number }>();
    for (const b of skusBase) candidatos.set(b, { base: b, qtd: 1 });
    for (const k of arr(kits)) candidatos.set(String(k.sku_kit), { base: String(k.sku_componente), qtd: num(k.quantidade) });
    // só kit de UM componente (kit misto não é "tamanho")
    const porKit = new Map<string, number>();
    for (const k of arr(kits)) porKit.set(String(k.sku_kit), (porKit.get(String(k.sku_kit)) ?? 0) + 1);
    const skus = [...candidatos.keys()].filter((s) => !naFamilia.has(s) && (porKit.get(s) ?? 1) === 1);
    const { data: ps } = await db.from("produtos").select("sku, nome, ativo, sku_pai").in("sku", skus);
    const { data: bases } = await db.from("produtos").select("sku, nome").in("sku", [...skusBase]);
    const nomeBase = new Map(arr(bases).map((x) => [String(x.sku), String(x.nome)]));
    const lista = arr(ps).filter((x) => x.ativo).sort((x, y) => (candidatos.get(String(x.sku))!.qtd - candidatos.get(String(y.sku))!.qtd));
    for (const x of lista.slice(0, 14)) {
      const cand = candidatos.get(String(x.sku))!;
      const pb = pesoDoNome(nomeBase.get(cand.base) ?? "");
      let skuAmz: string | null = null; let asinS: string | null = null; let familiaS: string | null = null;
      for (const s of [`${x.sku}_FBA`, String(x.sku), `FBA-${x.sku}`]) {
        const g = await lerItem(c, s, "summaries,relationships");
        if (ok(g) && g.body?.summaries?.[0]?.asin) {
          skuAmz = s; asinS = String(g.body.summaries[0].asin);
          familiaS = arr(g.body?.relationships?.[0]?.relationships).flatMap((y: any) => arr(y.parentSkus)).map(String)[0] ?? null;
          break;
        }
      }
      sugestoes.push({
        sku: String(x.sku), nome: String(x.nome), base: cand.base, quantidade: cand.qtd,
        valor_sugerido: pb ? fmtKg(pb * cand.qtd) : (cand.qtd > 1 ? `${cand.qtd} un` : ""),
        sku_amazon: skuAmz, asin: asinS, em_outra_familia: familiaS && familiaS !== paiSku ? familiaS : null,
        caminho: skuAmz ? "entrar" : "novo",
      });
    }
  }
  return { encontrado: true, nosso: true, catalogo, anuncio, familia, sugestoes };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const modulo = u.searchParams.get("modulo") || "ler";
  const quem = await exigirAcesso(req, modulo);
  if (quem instanceof Response) return quem;
  const body = await req.json().catch(() => ({}));
  try {
    const c = await conta(String(body?.empresa ?? "ottz"));
    if (modulo === "ler") {
      const busca = String(body?.busca ?? u.searchParams.get("busca") ?? "").trim();
      if (!busca) return json({ erro: "informe o ASIN ou o SKU" }, 400);
      return json({ ok: true, conta: c.nome, ...(await ler(c, busca)) });
    }
    if (modulo !== "previa" && modulo !== "aplicar") return json({ erro: `módulo desconhecido: ${modulo}` }, 400);

    const m = await montar(c, body);
    // validador da Amazon: confere cada envio sem aplicar nada (o pai novo vai primeiro; filho que
    // aponta para pai ainda inexistente pode receber aviso — o validador olha um anúncio por vez)
    const conferidos: any[] = [];
    for (const p of m.planos) {
      if (!p.corpo || p.pendencias.length) { conferidos.push({ ...resumo(p), situacao: "nao_conferido", pendencias: p.pendencias, avisos: p.avisos }); continue; }
      const v = await sp(c, p.metodo, itemPath(c, p.sku_amazon), { marketplaceIds: c.mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, p.corpo);
      const pv = problemas(v.body);
      const situacao = String(v.body?.status ?? (ok(v) ? "?" : v.status));
      const pend = [...p.pendencias, ...pv.erros.map((e) => `Amazon: ${e}`)];
      if (!pv.erros.length && situacao !== "VALID") pend.push(`Amazon: a validação respondeu ${situacao}`);
      conferidos.push({ ...resumo(p), situacao, pendencias: pend, avisos: [...p.avisos, ...pv.avisos.map((e) => `Amazon: ${e}`)] });
    }
    const pendencias = [...m.pendencias, ...conferidos.flatMap((x) => x.pendencias.map((t: string) => `${x.sku_amazon}: ${t}`))];
    if (modulo === "previa") return json({ ok: true, conta: c.nome, familia: m.familia, envios: conferidos, pendencias, avisos: m.avisos });

    // ---------------- aplicar
    if (body?.confirmar !== true) return json({ erro: "confirmação exigida (confirmar: true)" }, 400);
    if (pendencias.length) return json({ ok: false, erro: "há pendências — confira antes de aplicar", pendencias, envios: conferidos }, 400);
    const feitos: any[] = [];
    for (const p of m.planos) {
      const r = await sp(c, p.metodo, itemPath(c, p.sku_amazon), { marketplaceIds: c.mkt, issueLocale: "pt_BR" }, p.corpo);
      const pr = problemas(r.body);
      const situacao = String(r.body?.status ?? r.status);
      await db.from("debug_fulfillment").insert({
        modulo: "amazon-variacoes", etapa: `${p.tipo}:${p.sku_amazon}`, status_http: r.status,
        resultado: { conta: c.nome, por: quem.nome, pai: body?.criar_pai?.sku ?? body?.pai_sku, valor: p.valor, enviado: p.corpo, resposta: r.body },
      });
      feitos.push({ ...resumo(p), situacao, submissionId: r.body?.submissionId ?? null, erros: pr.erros });
      if (!ok(r) || situacao !== "ACCEPTED") {
        return json({ ok: false, erro: `a Amazon recusou ${p.sku_amazon}: ${pr.erros.join(" · ") || situacao}`, feitos, parou_em: p.sku_amazon }, 200);
      }
    }
    return json({ ok: true, feitos, aviso: "a Amazon processa em alguns minutos; a família aparece no catálogo depois disso" });
  } catch (e) {
    return json({ erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
