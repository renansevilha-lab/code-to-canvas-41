// ============================================================================
// Edge Function: amazon-promocoes v5 (20/out/2026, pedido do dono — aba Amazon de /promocoes, opções B + C)
// ----------------------------------------------------------------------------
// A Amazon NÃO cria Oferta Relâmpago, Cupom nem desconto Prime pela API (só Seller Central). Pela API:
//   · LÊ as promoções da conta (Promotions API 2025-12-01: searchPromotions / getSelection);
//   · aplica PREÇO DE OFERTA com início e fim por anúncio (Listings Items: purchasable_offer.discounted_price),
//     com prévia no validador da Amazon (VALIDATION_PREVIEW) antes;
//   · taxas reais por preço (Product Fees: getMyFeesEstimates, 20 SKUs por chamada) para a MC.
// Módulos (POST JSON ou query):
//   teste                       → diagnóstico de permissões (v3), só leitura
//   catalogo {conta}            → anúncios FBA da conta com estoque ou venda em 30 d + preço cheio, preço de oferta
//                                  vigente, taxas da Amazon no preço atual, CMV, MC e preço sugerido por faixa de MC
//   promocoes {conta}           → promoções da conta (tipo, status, período, desconto) — só leitura
//   selecao {conta, promocao}   → SKUs/ASINs de uma promoção — só leitura
//   simular {conta, itens:[{sku, preco}]} → taxas + MC em preços escolhidos (só leitura)
//   oferta {conta, itens:[{sku, preco, inicio, fim}], confirmar?} → sem confirmar: prévia (validador da Amazon + MC);
//                                  com confirmar: APLICA (exige login), uma vez por SKU, registro em debug_fulfillment
//   remover-oferta {conta, skus, confirmar?} → tira o preço de oferta (mesma regra)
// conta = "acz" | "svl". Token: oauth_tokens_amazon.access_token (cron amazon-refresh-token).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const CONTAS: Record<string, number> = { acz: 900001, svl: 900002 };
const FAIXAS = [0.10, 0.15, 0.1725, 0.20];
const IMPOSTO_PADRAO: Record<number, number> = { 900001: 0.10, 900002: 0.075 }; // efetivo dos pedidos (90 d, 20/out)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const sb = createClient(SUPABASE_URL, SRK);

type Sp = { status: number; ok: boolean; body: any; erros: string[] };
async function sp(token: string, metodo: string, path: string, params: Record<string, string> = {}, corpo?: unknown): Promise<Sp> {
  const url = new URL(`${SPAPI}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let t = 0; t < 3; t++) {
    const r = await fetch(url.toString(), {
      method: metodo,
      headers: { "x-amz-access-token": token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const txt = await r.text();
    // só LEITURA repete no 429; escrita (PATCH sem preview) não repete
    if (r.status === 429 && (metodo === "GET" || (metodo === "POST" && path.includes("feesEstimate")) || params.mode === "VALIDATION_PREVIEW") && t < 2) { await sleep(2000 * (t + 1)); continue; }
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { _raw: txt.slice(0, 300) }; }
    const erros = Array.isArray(body?.errors) ? body.errors.map((e: any) => `${e.code ?? "?"}: ${String(e.message ?? "").slice(0, 200)}`) : [];
    return { status: r.status, ok: r.ok, body, erros };
  }
  return { status: 429, ok: false, body: null, erros: ["limite de chamadas da Amazon (429)"] };
}

async function contaDe(conta: string) {
  const shopId = CONTAS[String(conta || "").toLowerCase()];
  if (!shopId) throw new Error("conta deve ser acz ou svl");
  const { data, error } = await sb.from("oauth_tokens_amazon").select("access_token, merchant_token, seller_id, marketplace_id, shop_id, empresa").eq("shop_id", shopId).maybeSingle();
  if (error || !data?.access_token) throw new Error(`sem token da Amazon para ${conta}`);
  if (!data.merchant_token) throw new Error(`conta ${conta} sem merchant_token (Listings exige)`);
  const { data: loja } = await sb.from("lojas").select("aliquota_imposto").eq("shop_id", shopId).maybeSingle();
  const imposto = Number(loja?.aliquota_imposto) > 0 ? Number(loja!.aliquota_imposto) : IMPOSTO_PADRAO[shopId];
  return { shopId, token: data.access_token as string, merchant: String(data.merchant_token), mkt: (data.marketplace_id as string) || MKT_BR, empresa: data.empresa as string, imposto };
}

/** SKU da Amazon → nosso SKU (sku_mapeamento → tira _FBA/FBA-/-FBA). */
async function nossoSkuDe(skusAmz: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!skusAmz.length) return out;
  const { data } = await sb.from("sku_mapeamento").select("sku_origem, sku_correto").eq("marketplace", "amazon").in("sku_origem", skusAmz);
  for (const m of (data ?? []) as any[]) if (m.sku_correto) out.set(String(m.sku_origem), String(m.sku_correto));
  for (const s of skusAmz) if (!out.has(s)) out.set(s, s.replace(/^FBA[-_]/i, "").replace(/[-_](FBA|FBAA|FBM)$/i, "").trim());
  return out;
}
async function cmvDe(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const u = [...new Set(skus)].filter(Boolean);
  for (let i = 0; i < u.length; i += 200) {
    const { data } = await sb.from("view_cmv_efetivo").select("sku, cmv_efetivo").in("sku", u.slice(i, i + 200));
    for (const c of (data ?? []) as any[]) if (Number(c.cmv_efetivo) > 0) out.set(String(c.sku), Number(c.cmv_efetivo));
  }
  return out;
}

/** Anúncios por SKU (até 20 por chamada): ASIN, título, status, preço cheio e preço de oferta com agenda. */
async function lerAnuncios(c: Awaited<ReturnType<typeof contaDe>>, skus: string[]) {
  const out = new Map<string, any>();
  for (let i = 0; i < skus.length; i += 20) {
    const lote = skus.slice(i, i + 20);
    const r = await sp(c.token, "GET", `/listings/2021-08-01/items/${encodeURIComponent(c.merchant)}`, {
      marketplaceIds: c.mkt, identifiers: lote.join(","), identifiersType: "SKU", includedData: "summaries,attributes,offers,issues", pageSize: "20",
    });
    if (!r.ok) throw new Error(`Listings HTTP ${r.status}: ${r.erros.join(" | ") || JSON.stringify(r.body).slice(0, 200)}`);
    for (const it of (r.body?.items ?? []) as any[]) out.set(String(it.sku), resumoAnuncio(it));
    if (i + 20 < skus.length) await sleep(250);
  }
  return out;
}
function resumoAnuncio(it: any) {
  const s = (it.summaries ?? [])[0] ?? {};
  const po = ((it.attributes?.purchasable_offer ?? []) as any[]).find((o) => !o.marketplace_id || o.marketplace_id === MKT_BR) ?? (it.attributes?.purchasable_offer ?? [])[0] ?? null;
  const cheio = num(po?.our_price?.[0]?.schedule?.[0]?.value_with_tax);
  const sch = po?.discounted_price?.[0]?.schedule?.[0] ?? null;
  const ofertaPreco = num(sch?.value_with_tax);
  const agora = Date.now();
  const ini = sch?.start_at ? Date.parse(sch.start_at) : null, fim = sch?.end_at ? Date.parse(sch.end_at) : null;
  const ofertaVigente = ofertaPreco != null && (!ini || ini <= agora) && (!fim || fim > agora);
  const oferta = (it.offers ?? []).find((o: any) => o.offerType === "B2C") ?? (it.offers ?? [])[0] ?? null;
  return {
    asin: s.asin ?? null, titulo: s.itemName ?? null, status: (s.status ?? []) as string[], tipo_produto: s.productType ?? null,
    foto: s.mainImage?.link ?? null, preco_cheio: cheio,
    oferta: ofertaPreco != null ? { preco: ofertaPreco, inicio: sch?.start_at ?? null, fim: sch?.end_at ?? null, vigente: ofertaVigente } : null,
    preco_vitrine: num(oferta?.price?.amount),
    problemas: ((it.issues ?? []) as any[]).filter((x) => x.severity === "ERROR").map((x) => String(x.message).slice(0, 160)).slice(0, 3),
    _offer: po,
  };
}

/** Taxas da Amazon (FBA) para cada SKU num preço. 20 por chamada; ~0,5/s. */
async function taxas(c: Awaited<ReturnType<typeof contaDe>>, itens: { sku: string; preco: number }[], ate: number) {
  const out = new Map<string, { total: number; comissao: number; outras: number; erro?: string }>();
  for (let i = 0; i < itens.length; i += 20) {
    if (Date.now() > ate) { for (const x of itens.slice(i)) out.set(`${x.sku}|${x.preco}`, { total: NaN, comissao: NaN, outras: NaN, erro: "sem tempo" }); break; }
    const lote = itens.slice(i, i + 20);
    const corpo = lote.map((x, k) => ({
      FeesEstimateRequest: { MarketplaceId: c.mkt, IsAmazonFulfilled: true, Identifier: `${k}|${x.sku}|${x.preco}`,
        PriceToEstimateFees: { ListingPrice: { CurrencyCode: "BRL", Amount: r2(x.preco) } } },
      IdType: "SellerSKU", IdValue: x.sku,
    }));
    const r = await sp(c.token, "POST", "/products/fees/v0/feesEstimate", {}, corpo);
    const res = Array.isArray(r.body) ? r.body : [];
    lote.forEach((x, k) => {
      const e = res.find((y: any) => String(y?.FeesEstimateIdentifier?.SellerInputIdentifier ?? "").startsWith(`${k}|`)) ?? res[k];
      const fe = e?.FeesEstimate;
      if (!fe) { out.set(`${x.sku}|${x.preco}`, { total: NaN, comissao: NaN, outras: NaN, erro: e?.Error?.Message ?? (r.erros.join(" | ") || `HTTP ${r.status}`) }); return; }
      const total = Number(fe.TotalFeesEstimate?.Amount ?? NaN);
      const ref = ((fe.FeeDetailList ?? []) as any[]).find((d) => d.FeeType === "ReferralFee");
      const comissao = Number(ref?.FinalFee?.Amount ?? ref?.FeeAmount?.Amount ?? 0);
      out.set(`${x.sku}|${x.preco}`, { total, comissao, outras: total - comissao });
    });
    if (i + 20 < itens.length) await sleep(2100);
  }
  return out;
}

function mc(preco: number, taxa: number, cmv: number | null, imposto: number) {
  if (cmv == null || !Number.isFinite(taxa)) return { reais: null, pct: null };
  const v = preco - taxa - cmv - preco * imposto;
  return { reais: r2(v), pct: preco > 0 ? Math.round((v / preco) * 10000) / 100 : null };
}
/** Preço para uma MC alvo: P = (CMV + taxa fixa) ÷ (1 − comissão% − imposto − MC). A comissão% vem da taxa no preço atual. */
function precoPorFaixa(cmv: number | null, comissaoPct: number, fixo: number, imposto: number) {
  if (cmv == null || !Number.isFinite(comissaoPct) || !Number.isFinite(fixo)) return null;
  const o: Record<string, number | null> = {};
  for (const f of FAIXAS) { const d = 1 - comissaoPct - imposto - f; o[String(f)] = d > 0.05 ? r2((cmv + fixo) / d) : null; }
  return o;
}

async function exigirUsuario(req: Request): Promise<{ nome: string } | Response> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return json({ ok: false, erro: "aplicar exige login de usuário" }, 401);
  return { nome: String(data.user.user_metadata?.nome ?? data.user.email ?? data.user.id) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let b: any = {};
  if (req.method === "POST") { try { b = await req.json(); } catch { b = {}; } }
  const p = (k: string) => url.searchParams.get(k) ?? (b?.[k] != null ? String(b[k]) : null);
  const modulo = p("modulo") || "teste";
  const inicio = Date.now();
  try {
    // ------------------------------------------------------------ catalogo
    if (modulo === "catalogo") {
      const c = await contaDe(p("conta") || "acz");
      const desde = new Date(Date.now() - 30 * 86400000).toISOString();
      const [est, peds] = await Promise.all([
        sb.from("estoque_fulfillment").select("sku_marketplace, sku, titulo, sellable, reserved, in_transit").eq("marketplace", "amazon").eq("shop_id", c.shopId).limit(2000),
        sb.from("pedidos").select("id").eq("marketplace", "amazon").eq("shop_id", c.shopId).gte("data_pedido", desde).not("status_pedido", "in", "(Canceled,Cancelled)").limit(5000),
      ]);
      const vendas = new Map<string, number>();
      const ids = ((peds.data ?? []) as any[]).map((x) => x.id);
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await sb.from("pedido_itens").select("sku_filho, quantidade").in("pedido_id", ids.slice(i, i + 300));
        for (const it of (data ?? []) as any[]) if (it.sku_filho) vendas.set(String(it.sku_filho), (vendas.get(String(it.sku_filho)) ?? 0) + (Number(it.quantidade) || 1));
      }
      const base = new Map<string, any>();
      for (const e of (est.data ?? []) as any[]) base.set(String(e.sku_marketplace), { sku_amazon: String(e.sku_marketplace), titulo: e.titulo, estoque: Number(e.sellable) || 0, a_caminho: Number(e.in_transit) || 0 });
      for (const s of vendas.keys()) if (!base.has(s)) base.set(s, { sku_amazon: s, titulo: null, estoque: 0, a_caminho: 0 });
      const lista = [...base.values()].map((x) => ({ ...x, vendas_30d: vendas.get(x.sku_amazon) ?? 0 }))
        .filter((x) => x.estoque > 0 || x.vendas_30d > 0)
        .sort((a, z) => z.vendas_30d - a.vendas_30d || z.estoque - a.estoque)
        .slice(0, Number(p("max") || 120));
      const skus = lista.map((x) => x.sku_amazon);
      const anuncios = await lerAnuncios(c, skus);
      const nossos = await nossoSkuDe(skus);
      const cmvs = await cmvDe([...nossos.values()]);
      const pedirTaxa = skus.filter((s) => anuncios.get(s)?.preco_cheio).map((s) => {
        const a = anuncios.get(s)!; return { sku: s, preco: a.oferta?.vigente ? a.oferta.preco : a.preco_cheio };
      });
      const tx = await taxas(c, pedirTaxa, inicio + 26000);
      const itens = lista.map((x) => {
        const a = anuncios.get(x.sku_amazon) ?? null;
        const nosso = nossos.get(x.sku_amazon) ?? null;
        const cmv = nosso ? cmvs.get(nosso) ?? null : null;
        const precoAtual = a ? (a.oferta?.vigente ? a.oferta.preco : a.preco_cheio) : null;
        const t = precoAtual != null ? tx.get(`${x.sku_amazon}|${precoAtual}`) : undefined;
        const comPct = t && precoAtual ? t.comissao / precoAtual : NaN;
        return {
          ...x, titulo: a?.titulo ?? x.titulo, sku: nosso, asin: a?.asin ?? null, foto: a?.foto ?? null, status: a?.status ?? [],
          preco_cheio: a?.preco_cheio ?? null, oferta: a?.oferta ?? null, preco_atual: precoAtual, cmv,
          taxa: t && Number.isFinite(t.total) ? { total: r2(t.total), comissao: r2(t.comissao), outras: r2(t.outras), comissao_pct: Math.round(comPct * 10000) / 100 } : null,
          taxa_erro: t?.erro ?? (a ? null : "anúncio não encontrado"),
          mc_atual: precoAtual != null && t ? mc(precoAtual, t.total, cmv, c.imposto) : null,
          preco_por_mc: t && Number.isFinite(t.total) ? precoPorFaixa(cmv, comPct, t.outras, c.imposto) : null,
          problemas: a?.problemas ?? [],
        };
      });
      return json({ ok: true, conta: p("conta") || "acz", empresa: c.empresa, imposto: c.imposto, faixas: FAIXAS, itens, tempo_ms: Date.now() - inicio });
    }

    // ------------------------------------------------------------ promocoes
    if (modulo === "promocoes") {
      const c = await contaDe(p("conta") || "acz");
      const todas: any[] = [];
      let next: string | null = null;
      for (let pag = 0; pag < 10; pag++) {
        const params: Record<string, string> = { marketplaceIds: c.mkt, pageSize: "50" };
        if (next) params.nextToken = next;
        const r = await sp(c.token, "GET", "/promotions/2025-12-01/promotions", params);
        if (!r.ok) return json({ ok: false, erro: `Promotions HTTP ${r.status}: ${r.erros.join(" | ")}` }, 502);
        todas.push(...(r.body?.promotions ?? []));
        next = r.body?.pagination?.nextToken ?? null;
        if (!next || Date.now() - inicio > 20000) break;
        await sleep(10500); // 0,1/s
      }
      return json({ ok: true, total: todas.length, promocoes: todas, exemplo_chaves: todas[0] ? Object.keys(todas[0]) : [] });
    }
    if (modulo === "selecao") {
      const c = await contaDe(p("conta") || "acz");
      const id = String(p("promocao") || "");
      if (!id) return json({ ok: false, erro: "informe promocao" }, 400);
      const d = await sp(c.token, "GET", `/promotions/2025-12-01/promotions/${encodeURIComponent(id)}`, { marketplaceIds: c.mkt });
      const selId = d.body?.selection?.selectionId ? String(d.body.selection.selectionId) : "";
      const rev = String(d.body?.selection?.revisionId ?? 1);
      // itens da promoção: /promotions/{id}/selections/{selectionId}?revisionId= (o /selections/{id} solto dá 403)
      if (!selId) return json({ ok: false, erro: "promoção sem seleção", detalhe: d.body });
      const itens: any[] = [];
      let next: string | null = null, r: Sp | null = null;
      for (let pag = 0; pag < 10; pag++) {
        const params: Record<string, string> = { marketplaceIds: c.mkt, revisionId: rev, pageSize: "100" };
        if (next) params.nextToken = next;
        r = await sp(c.token, "GET", `/promotions/2025-12-01/promotions/${encodeURIComponent(id)}/selections/${encodeURIComponent(selId)}`, params);
        if (!r.ok) break;
        // formato visto em 20/out: { selection: { selectionDetails: { items: [{asin, sku, benefit:{type, price|percent}, budget}] } } }
        const det = r.body?.selection?.selectionDetails ?? {};
        const lista = det.items ?? r.body?.items ?? [];
        itens.push(...(Array.isArray(lista) ? lista : []));
        next = det.nextToken ?? r.body?.pagination?.nextToken ?? r.body?.nextToken ?? null;
        if (!next || Date.now() - inicio > 20000) break;
        await sleep(10500);
      }
      // nosso SKU e CMV para a MC no preço da promoção
      const nossos = await nossoSkuDe(itens.map((x) => String(x.sku ?? "")).filter(Boolean));
      const cmvs = await cmvDe([...nossos.values()]);
      const saida = itens.map((x) => {
        const preco = num(x.benefit?.price?.amount);
        return { asin: x.asin ?? null, sku_amazon: x.sku ?? null, sku: nossos.get(String(x.sku ?? "")) ?? null, cmv: cmvs.get(nossos.get(String(x.sku ?? "")) ?? "") ?? null,
          beneficio: x.benefit?.type ?? null, preco, percentual: num(x.benefit?.percent ?? x.benefit?.percentage), limite_unidades: num(x.budget?.value) };
      });
      return json({ ok: !!r?.ok, erros: r?.erros ?? [], itens: saida, detalhe: d.body });
    }

    // ------------------------------------------------------------ simular
    if (modulo === "simular") {
      const c = await contaDe(p("conta") || "acz");
      const itens = ((b.itens ?? []) as any[]).map((x) => ({ sku: String(x.sku), preco: Number(x.preco) })).filter((x) => x.sku && x.preco > 0).slice(0, 60);
      const nossos = await nossoSkuDe(itens.map((x) => x.sku));
      const cmvs = await cmvDe([...nossos.values()]);
      const tx = await taxas(c, itens, inicio + 26000);
      return json({ ok: true, imposto: c.imposto, itens: itens.map((x) => {
        const t = tx.get(`${x.sku}|${x.preco}`); const cmv = cmvs.get(nossos.get(x.sku) ?? "") ?? null;
        return { ...x, taxa: t && Number.isFinite(t.total) ? r2(t.total) : null, taxa_erro: t?.erro ?? null, cmv, mc: t ? mc(x.preco, t.total, cmv, c.imposto) : null };
      }) });
    }

    // ------------------------------------------------------------ oferta / remover-oferta
    if (modulo === "oferta" || modulo === "remover-oferta") {
      const c = await contaDe(p("conta") || "acz");
      const confirmar = p("confirmar") === "1" || b.confirmar === true;
      let quem = "prévia";
      if (confirmar) { const u = await exigirUsuario(req); if (u instanceof Response) return u; quem = u.nome; }
      const remover = modulo === "remover-oferta";
      const pedidos = remover
        ? ((b.skus ?? []) as any[]).map((s) => ({ sku: String(s), preco: 0, inicio: "", fim: "" }))
        : ((b.itens ?? []) as any[]).map((x) => ({ sku: String(x.sku), preco: Number(x.preco), inicio: String(x.inicio ?? ""), fim: String(x.fim ?? "") }));
      if (!pedidos.length || pedidos.length > 30) return json({ ok: false, erro: "de 1 a 30 anúncios por vez" }, 400);
      const anuncios = await lerAnuncios(c, pedidos.map((x) => x.sku));
      const nossos = await nossoSkuDe(pedidos.map((x) => x.sku));
      const cmvs = await cmvDe([...nossos.values()]);
      const tx = remover ? new Map() : await taxas(c, pedidos.filter((x) => x.preco > 0), inicio + 12000);
      const resultados: any[] = [];
      for (const x of pedidos) {
        const a = anuncios.get(x.sku);
        const res: any = { sku: x.sku, preco: x.preco || null, inicio: x.inicio || null, fim: x.fim || null, pendencias: [] as string[] };
        resultados.push(res);
        if (!a) { res.pendencias.push("anúncio não encontrado nesta conta"); continue; }
        if (!a._offer || a.preco_cheio == null) { res.pendencias.push("anúncio sem preço cheio (purchasable_offer) — não dá para pôr oferta"); continue; }
        res.preco_cheio = a.preco_cheio; res.oferta_hoje = a.oferta;
        if (!remover) {
          const ini = Date.parse(x.inicio), fim = Date.parse(x.fim);
          if (!(x.preco > 0)) res.pendencias.push("preço de oferta inválido");
          else if (x.preco >= a.preco_cheio) res.pendencias.push(`preço de oferta (${x.preco}) precisa ser menor que o cheio (${a.preco_cheio})`);
          else if (x.preco < a.preco_cheio * 0.5 && !b.forcar) res.pendencias.push("desconto acima de 50% — confira o valor (ou mande forcar)");
          if (!Number.isFinite(ini) || !Number.isFinite(fim)) res.pendencias.push("informe início e fim");
          else if (fim <= ini) res.pendencias.push("o fim precisa ser depois do início");
          else if (fim < Date.now()) res.pendencias.push("o fim já passou");
          const t = tx.get(`${x.sku}|${x.preco}`);
          const cmv = cmvs.get(nossos.get(x.sku) ?? "") ?? null;
          res.taxa = t && Number.isFinite(t.total) ? r2(t.total) : null;
          res.mc = t ? mc(x.preco, t.total, cmv, c.imposto) : null;
        } else if (!a.oferta) res.pendencias.push("anúncio já está sem preço de oferta");
        if (res.pendencias.length) continue;
        const { discounted_price: _d, ...semOferta } = a._offer;
        const valor = remover ? [{ ...semOferta, marketplace_id: c.mkt }] : [{
          ...semOferta, marketplace_id: c.mkt,
          discounted_price: [{ schedule: [{ start_at: new Date(Date.parse(x.inicio)).toISOString(), end_at: new Date(Date.parse(x.fim)).toISOString(), value_with_tax: r2(x.preco) }] }],
        }];
        const corpo = { productType: a.tipo_produto, patches: [{ op: "replace", path: "/attributes/purchasable_offer", value: valor }] };
        const path = `/listings/2021-08-01/items/${encodeURIComponent(c.merchant)}/${encodeURIComponent(x.sku)}`;
        const prev = await sp(c.token, "PATCH", path, { marketplaceIds: c.mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, corpo);
        const problemas = ((prev.body?.issues ?? []) as any[]).filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${String(i.message).slice(0, 200)}`);
        res.validacao = { status: prev.status, resultado: prev.body?.status ?? null, problemas };
        if (!prev.ok || prev.body?.status !== "VALID") { res.pendencias.push(problemas[0] ?? `a Amazon recusou na conferência (${prev.body?.status ?? prev.status})`); continue; }
        if (!confirmar) continue;
        const real = await sp(c.token, "PATCH", path, { marketplaceIds: c.mkt, issueLocale: "pt_BR" }, corpo);
        res.aplicado = { status: real.status, resultado: real.body?.status ?? null, submissao: real.body?.submissionId ?? null,
          problemas: ((real.body?.issues ?? []) as any[]).filter((i) => i.severity === "ERROR").map((i) => `${i.code}: ${String(i.message).slice(0, 200)}`) };
        await sb.from("debug_fulfillment").insert({ modulo: "amazon-promo-preco", etapa: `${p("conta")}:${x.sku}`, status_http: real.status,
          resultado: { acao: modulo, por: quem, pedido: x, antes: a.oferta, cheio: a.preco_cheio, resposta: res.aplicado } });
      }
      return json({ ok: true, confirmar, imposto: c.imposto, resultados, tempo_ms: Date.now() - inicio });
    }

    // ------------------------------------------------------------ teste (diagnóstico, só leitura)
    if (modulo === "teste") {
      const out: any[] = [];
      for (const conta of ["acz", "svl"]) {
        try {
          const c = await contaDe(conta);
          const promo = await sp(c.token, "GET", "/promotions/2025-12-01/promotions", { marketplaceIds: c.mkt, pageSize: "5" });
          await sleep(600);
          const list = await sp(c.token, "GET", `/listings/2021-08-01/items/${encodeURIComponent(c.merchant)}`, { marketplaceIds: c.mkt, pageSize: "5" });
          out.push({ conta, promocoes: { status: promo.status, n: (promo.body?.promotions ?? []).length, erros: promo.erros }, listings: { status: list.status, total: list.body?.numberOfResults ?? null, erros: list.erros } });
        } catch (e) { out.push({ conta, erro: (e as Error).message }); }
      }
      return json({ ok: true, testado_em: new Date().toISOString(), contas: out });
    }
    return json({ ok: false, erro: `módulo desconhecido: ${modulo}` }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error).message ?? e).slice(0, 400) }, 500);
  }
});
