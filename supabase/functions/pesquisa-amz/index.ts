// ============================================================================
// Edge Function: pesquisa-amz v3 (19/out/2026) — Pesquisa de produtos, fase 2: Amazon
// ----------------------------------------------------------------------------
// Só LÊ a Amazon (SP-API, região NA, marketplace BR A2Q3Y263D00KWC; token de cada conta em
// oauth_tokens_amazon, renovado pelo cron amazon-refresh-token-auto) e grava só as tabelas pesquisa_amz_*.
//
//   ?modo=meus        nossos ASINs: inventário FBA das duas contas (sellerSku → asin) + anúncios da ACZ
//                     (Listings, exige o Merchant Token) → pesquisa_amz_meus_skus + pesquisa_amz_asins (e_meu).
//                     É o vínculo ASIN ↔ SKU que liga o BSR às nossas vendas (pedido_itens só guarda o SKU).
//   ?modo=descobrir   cada termo ativo de pesquisa_amz_termos_monitorados: 2 páginas da busca do catálogo
//                     (searchCatalogItems keywords) → ASINs novos (origem 'termo:<termo>') + o BSR do dia.
//   ?modo=diario      BSR (salesRanks) de todos os ASINs ativos, 20 por chamada (identifiers=ASIN).
//   ?modo=brand_analytics [&semana=YYYY-MM-DD (domingo)]
//                     relatório GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT (WEEK) da semana fechada: pede, acompanha
//                     e, quando sai, baixa o documento (gzip, JSON grande) lendo em fluxo e grava só os termos
//                     de pet em pesquisa_amz_brand_analytics. Sem permissão = registra o erro e segue.
// Retomável: ~22 s por chamada; o que já foi feito no dia fica em pesquisa_amz_coleta (o cron chama de novo).
// v2: relatório FATAL por "semana ainda não processada" vira aguardando_dados e é pedido de novo (a cada 6 h);
//   o documento do erro vem em gzip e agora é descompactado (antes ia com bytes nulos e o banco recusava).
// v3: filtro de termo de pet por palavra forte / palavra ambígua com contexto / ASIN clicado já conhecido
//   (a v2 trazia "óleo de banho", "fio dental", "Kindle 11ª geração" — "ração" dentro de "geração" — e
//   bebedouro de água gelada); só os ASINs dos 300 termos de pet mais buscados vão ao diário.
// Catalog API: ~2 req/s com burst baixo → uma chamada a cada 600 ms e espera crescente no 429.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SRK);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const CONTAS: Record<string, number> = { ottz: 900001, svl: 900002 };
const ORCAMENTO_MS = 22_000;
const BA = "GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------- contas e chamadas
type Conta = { conta: string; shop_id: number; token: string; seller: string | null; mkt: string };
async function contas(): Promise<Conta[]> {
  const { data, error } = await db.from("oauth_tokens_amazon").select("shop_id, access_token, expires_at, merchant_token, marketplace_id").in("shop_id", Object.values(CONTAS));
  if (error) throw new Error(`tokens Amazon: ${error.message}`);
  const out: Conta[] = [];
  for (const r of (data ?? []) as any[]) {
    if (!r.access_token || new Date(r.expires_at) < new Date()) continue; // renovação automática a cada 20 min
    const conta = Object.entries(CONTAS).find(([, s]) => s === Number(r.shop_id))?.[0] ?? String(r.shop_id);
    out.push({ conta, shop_id: Number(r.shop_id), token: String(r.access_token), seller: r.merchant_token ? String(r.merchant_token) : null, mkt: String(r.marketplace_id || MKT_BR) });
  }
  if (!out.length) throw new Error("nenhuma conta da Amazon com token válido (a renovação roda a cada 20 min)");
  return out.sort((a, b) => a.shop_id - b.shop_id);
}
const ultimaVez = new Map<string, number>();
/** Chamada à SP-API com intervalo mínimo por família (catálogo = 600 ms) e espera crescente em 429/5xx. Nunca lança. */
async function sp(c: Conta, metodo: string, path: string, params: Record<string, string> = {}, corpo?: unknown, familia = "outros", intervalo = 250): Promise<{ status: number; body: any }> {
  const url = new URL(`${SPAPI}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let ultimo = { status: 0, body: null as any };
  for (let t = 0; t < 4; t++) {
    const espera = (ultimaVez.get(familia) ?? 0) + intervalo - Date.now();
    if (espera > 0) await sleep(espera);
    ultimaVez.set(familia, Date.now());
    try {
      const r = await fetch(url.toString(), {
        method: metodo,
        headers: { "x-amz-access-token": c.token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
      const txt = await r.text();
      let b: any; try { b = txt ? JSON.parse(txt) : null; } catch { b = { message: txt.slice(0, 300) }; }
      ultimo = { status: r.status, body: b };
      if (r.status !== 429 && r.status < 500) return ultimo;
    } catch (e) { ultimo = { status: 0, body: { message: String(e) } }; }
    await sleep(1500 * 2 ** t);
  }
  return ultimo;
}
const erroAmz = (r: { status: number; body: any }) => `${r.status} ${arr(r.body?.errors).map((e) => `${e?.code ?? ""}: ${String(e?.message ?? "").slice(0, 200)}`).join(" · ") || String(r.body?.message ?? "").slice(0, 200)}`.trim();

async function todas<T>(q: (de: number, ate: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await q(de, de + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}
async function feitosHoje(modo: string): Promise<Set<string>> {
  const rows = await todas<any>((de, ate) => db.from("pesquisa_amz_coleta").select("chave").eq("data_coleta", hojeBRT()).eq("modo", modo).is("erro", null).range(de, ate));
  return new Set(rows.map((r) => String(r.chave)));
}
async function marcar(modo: string, chaves: { chave: string; http_status?: number; n_itens?: number; erro?: string | null }[]) {
  if (!chaves.length) return;
  const d = hojeBRT();
  await db.from("pesquisa_amz_coleta").upsert(chaves.map((x) => ({ data_coleta: d, modo, chave: x.chave, http_status: x.http_status ?? 200, n_itens: x.n_itens ?? null, erro: x.erro ?? null, coletado_em: new Date().toISOString() })), { onConflict: "data_coleta,modo,chave" });
}

// ---------------------------------------------------------------- BSR
/** Grava o BSR do dia de um item do catálogo (classificationRanks = subcategoria; displayGroupRanks = grupo). */
function linhasBsr(asin: string, salesRanks: unknown): Record<string, unknown>[] {
  const d = hojeBRT();
  const porCat = new Map<string, Record<string, unknown>>();
  for (const sr of arr(salesRanks)) {
    for (const c of arr(sr?.classificationRanks)) {
      const t = String(c?.title ?? "").trim(); const rk = Number(c?.rank);
      if (t && rk > 0) porCat.set(t, { data_coleta: d, asin, categoria: t, tipo: "subcategoria", rank: rk, categoria_id: c?.classificationId ?? null });
    }
    for (const g of arr(sr?.displayGroupRanks)) {
      const t = String(g?.title ?? "").trim(); const rk = Number(g?.rank);
      if (t && rk > 0 && !porCat.has(t)) porCat.set(t, { data_coleta: d, asin, categoria: t, tipo: "grupo", rank: rk, categoria_id: g?.websiteDisplayGroup ?? null });
    }
  }
  return [...porCat.values()];
}
async function gravarItens(itens: any[], erros: string[], origem?: string): Promise<number> {
  if (!itens.length) return 0;
  const asins = itens.map((i) => ({
    asin: String(i.asin), nome: i.summaries?.[0]?.itemName ?? null, marca: i.summaries?.[0]?.brand ?? null, atualizado_em: new Date().toISOString(),
  }));
  // só nome/marca/data: e_meu e origem dos que já existem não mudam
  const { error: eA } = await db.from("pesquisa_amz_asins").upsert(asins, { onConflict: "asin" });
  if (eA) { erros.push(`asins: ${eA.message}`); return 0; }
  if (origem) await db.from("pesquisa_amz_asins").update({ origem }).in("asin", asins.map((a) => a.asin)).is("origem", null);
  const bsr = itens.flatMap((i) => linhasBsr(String(i.asin), i.salesRanks));
  if (bsr.length) {
    const { error } = await db.from("pesquisa_amz_bsr").upsert(bsr, { onConflict: "data_coleta,asin,categoria" });
    if (error) erros.push(`bsr: ${error.message}`);
  }
  // BSR já gravado hoje por aqui: o diário não precisa consultar de novo
  await marcar("diario", itens.map((i) => ({ chave: String(i.asin), n_itens: linhasBsr(String(i.asin), i.salesRanks).length })));
  return bsr.length;
}

// ---------------------------------------------------------------- modos
/** Nosso SKU a partir do SKU da Amazon (16330_FBA → 16330; FBA-15825 → 15825; de-para). */
function nossoSkuSimples(s: string): string {
  const m = /^(.+)_FBA$/i.exec(s) ?? /^FBA-(.+)$/i.exec(s);
  return m ? m[1] : s;
}
async function meus(t0: number, erros: string[]) {
  const cs = await contas();
  const linhas = new Map<string, Record<string, unknown>>();
  const resumo: Record<string, unknown> = {};
  for (const c of cs) {
    // 1) inventário FBA (traz o ASIN de cada SKU, inclusive os sem estoque)
    let next: string | null = null; let n = 0; let completo = true;
    for (let pg = 0; pg < 40; pg++) {
      if (Date.now() - t0 > ORCAMENTO_MS) { completo = false; break; }
      const p: Record<string, string> = { granularityType: "Marketplace", granularityId: c.mkt, marketplaceIds: c.mkt, details: "false" };
      if (next) p.nextToken = next;
      const r = await sp(c, "GET", "/fba/inventory/v1/summaries", p, undefined, "fba", 500);
      if (r.status !== 200) { erros.push(`meus ${c.conta}: inventário ${erroAmz(r)}`); completo = false; break; }
      for (const s of arr(r.body?.payload?.inventorySummaries)) {
        if (!s?.asin || !s?.sellerSku) continue;
        linhas.set(`${c.conta}|${s.sellerSku}`, { conta: c.conta, sku_amazon: String(s.sellerSku), asin: String(s.asin), nome: s.productName ?? null, origem: "fba", atualizado_em: new Date().toISOString() });
        n++;
      }
      next = r.body?.pagination?.nextToken ?? null;
      if (!next) break;
    }
    // 2) anúncios da conta (Listings — só a conta com o Merchant Token)
    let nl = 0;
    if (c.seller) {
      let tok: string | null = null;
      for (let pg = 0; pg < 60; pg++) {
        if (Date.now() - t0 > ORCAMENTO_MS) { completo = false; break; }
        const p: Record<string, string> = { marketplaceIds: c.mkt, includedData: "summaries", pageSize: "20" };
        if (tok) p.pageToken = tok;
        const r = await sp(c, "GET", `/listings/2021-08-01/items/${encodeURIComponent(c.seller)}`, p, undefined, "listings", 220);
        if (r.status !== 200) { erros.push(`meus ${c.conta}: anúncios ${erroAmz(r)}`); break; }
        for (const it of arr(r.body?.items)) {
          const sm = it?.summaries?.[0];
          if (!it?.sku || !sm?.asin) continue;
          const k = `${c.conta}|${it.sku}`;
          if (!linhas.has(k)) linhas.set(k, { conta: c.conta, sku_amazon: String(it.sku), asin: String(sm.asin), nome: sm.itemName ?? null, origem: "listing", atualizado_em: new Date().toISOString() });
          nl++;
        }
        tok = r.body?.pagination?.nextToken ?? null;
        if (!tok) break;
      }
    }
    resumo[c.conta] = { fba: n, anuncios: nl, completo };
  }
  // nosso SKU: sem _FBA / FBA- e pelo de-para da Amazon
  const lista = [...linhas.values()];
  const { data: mapa } = await db.from("sku_mapeamento").select("sku_origem, sku_correto").ilike("marketplace", "amazon%");
  const dePara = new Map(((mapa ?? []) as any[]).map((m) => [String(m.sku_origem), String(m.sku_correto)]));
  for (const l of lista) l.sku = dePara.get(String(l.sku_amazon)) ?? nossoSkuSimples(String(l.sku_amazon));
  for (let i = 0; i < lista.length; i += 500) {
    const { error } = await db.from("pesquisa_amz_meus_skus").upsert(lista.slice(i, i + 500), { onConflict: "conta,sku_amazon" });
    if (error) erros.push(`meus_skus: ${error.message}`);
  }
  const asins = [...new Map(lista.map((l) => [String(l.asin), l])).values()];
  for (let i = 0; i < asins.length; i += 500) {
    const { error } = await db.from("pesquisa_amz_asins").upsert(asins.slice(i, i + 500).map((l) => ({
      asin: l.asin, nome: l.nome, e_meu: true, origem: "meu", ativo: true, atualizado_em: new Date().toISOString(),
    })), { onConflict: "asin" });
    if (error) erros.push(`asins: ${error.message}`);
  }
  return { contas: resumo, skus: lista.length, asins_meus: asins.length };
}

async function descobrir(t0: number, erros: string[]) {
  const [c] = await contas();
  const { data: ts } = await db.from("pesquisa_amz_termos_monitorados").select("termo").eq("ativo", true).order("termo");
  const feitos = await feitosHoje("descobrir");
  const termos = ((ts ?? []) as any[]).map((t) => String(t.termo)).filter((t) => !feitos.has(t));
  const antes = await db.from("pesquisa_amz_asins").select("asin", { count: "exact", head: true });
  let lidos = 0; let feitosAgora = 0;
  for (const termo of termos) {
    if (Date.now() - t0 > ORCAMENTO_MS) break;
    let tok: string | null = null; let n = 0; let falhou: string | null = null;
    for (let pg = 0; pg < 2; pg++) {
      const p: Record<string, string> = { marketplaceIds: c.mkt, keywords: termo, includedData: "summaries,salesRanks", pageSize: "20" };
      if (tok) p.pageToken = tok;
      const r = await sp(c, "GET", "/catalog/2022-04-01/items", p, undefined, "catalogo", 600);
      if (r.status !== 200) { falhou = erroAmz(r); break; }
      const itens = arr(r.body?.items).filter((i) => i?.asin);
      await gravarItens(itens, erros, `termo:${termo}`);
      n += itens.length;
      tok = r.body?.pagination?.nextToken ?? null;
      if (!tok) break;
    }
    if (falhou) erros.push(`descobrir "${termo}": ${falhou}`);
    await marcar("descobrir", [{ chave: termo, n_itens: n, erro: falhou }]);
    lidos += n; if (!falhou) feitosAgora++;
  }
  const depois = await db.from("pesquisa_amz_asins").select("asin", { count: "exact", head: true });
  const resta = termos.length - feitosAgora;
  return { termos_feitos_agora: feitosAgora, pendentes: resta, itens_lidos: lidos, asins_novos: (depois.count ?? 0) - (antes.count ?? 0), asins_total: depois.count ?? 0 };
}

async function diario(t0: number, erros: string[]) {
  const [c] = await contas();
  const todos = await todas<any>((de, ate) => db.from("pesquisa_amz_asins").select("asin").eq("ativo", true).order("asin").range(de, ate));
  const feitos = await feitosHoje("diario");
  const pend = todos.map((a) => String(a.asin)).filter((a) => !feitos.has(a));
  let consultados = 0; let comRank = 0;
  for (let i = 0; i < pend.length; i += 20) {
    if (Date.now() - t0 > ORCAMENTO_MS) break;
    const lote = pend.slice(i, i + 20);
    const r = await sp(c, "GET", "/catalog/2022-04-01/items", { marketplaceIds: c.mkt, identifiers: lote.join(","), identifiersType: "ASIN", includedData: "summaries,salesRanks", pageSize: "20" }, undefined, "catalogo", 600);
    if (r.status !== 200) { erros.push(`diario: ${erroAmz(r)}`); await marcar("diario", lote.map((a) => ({ chave: a, http_status: r.status, erro: erroAmz(r) }))); continue; }
    const itens = arr(r.body?.items).filter((x) => x?.asin);
    await gravarItens(itens, erros);
    const vieram = new Set(itens.map((x) => String(x.asin)));
    // ASIN que a Amazon não devolveu (saiu do catálogo / sem ranking): marcado para não repetir no dia
    await marcar("diario", lote.filter((a) => !vieram.has(a)).map((a) => ({ chave: a, n_itens: 0 })));
    consultados += lote.length; comRank += itens.filter((x) => linhasBsr(String(x.asin), x.salesRanks).length).length;
  }
  const restam = pend.length - consultados;
  return { asins_ativos: todos.length, consultados_agora: consultados, com_bsr: comRank, pendentes: Math.max(0, restam) };
}

// ---------------------------------------------------------------- Brand Analytics
// Termo de pet: palavra que só existe no mundo pet, ou palavra ambígua ("areia", "tapete"…) com contexto.
// A 1ª versão aceitava "banho"/"dental"/"areia" sozinhas e trazia "óleo de banho", "fio dental" e "Capitães
// da Areia". Termo sem palavra de pet também entra se um dos ASINs clicados já é um ASIN de pet conhecido
// (nosso ou achado na descoberta) — ex.: "areia bionature", "coleira seresto".
const PET_FORTE = /(gat[oa]s?\b|gatinh|felin|\bc[aã]o\b|\bc[aã]es\b|cachorr|cadel|\bpets?\b|\bra[cç][aã]o|petisc|coleira|arranhador|comedouro|catnip|antipulga|\bpulgas?\b|carrapat|hamster|calopsita|aqu[aá]rio|caninh|\bfelix\b|whiskas|pedigree)/i;
const PET_COMBO: [RegExp, RegExp][] = [
  [/areia/i, /(higi[eê]n|sanit|s[ií]lica|mandioca|tofu|bentonit|aglomer|biodegrad|granul)/i],
  [/tapete/i, /(higi[eê]n|xixi|sanit)/i],
  [/granulad/i, /(higi[eê]n|sanit|madeira|pinus|mandioca)/i],
  [/educador/i, /sanit/i],
  [/\bxixi\b/i, /(sim|n[aã]o|aqui|educador|tapete)/i],
];
const ehPet = (t: string) => PET_FORTE.test(t) || PET_COMBO.some(([a, b]) => a.test(t) && b.test(t));
/** ASINs que entram no monitoramento diário a partir do Brand Analytics: os dos N termos de pet mais buscados. */
const BA_TERMOS_MONITORAR = 300;
/** Semana fechada (domingo a sábado, dia de Brasília) mais recente. */
function semanaFechada(): { inicio: string; fim: string } {
  const hoje = new Date(`${hojeBRT()}T12:00:00Z`);
  const sab = new Date(hoje.getTime() - (hoje.getUTCDay() + 1) * 86400_000);
  const dom = new Date(sab.getTime() - 6 * 86400_000);
  return { inicio: dom.toISOString().slice(0, 10), fim: sab.toISOString().slice(0, 10) };
}
/** Lê o documento em fluxo (gzip) e junta, por termo de pet, os 3 ASINs mais clicados. */
async function lerDocumento(url: string, gzip: boolean, t0: number, conhecidos: Set<string>) {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) throw new Error(`download do relatório: ${resp.status}`);
  let fluxo: ReadableStream<Uint8Array> = resp.body;
  if (gzip) fluxo = fluxo.pipeThrough(new DecompressionStream("gzip"));
  const leitor = fluxo.pipeThrough(new TextDecoderStream()).getReader();
  const termos = new Map<string, { rank: number | null; asins: { r: number; asin: string; click: number | null; conv: number | null }[] }>();
  let resto = ""; let linhas = 0; let bytes = 0;
  const objeto = /\{[^{}]*"searchTerm"[^{}]*\}/g;
  const termoDe = /"searchTerm"\s*:\s*"((?:[^"\\]|\\.)*)"/;
  const asinDe = /"clickedAsin"\s*:\s*"([^"]*)"/;
  // as linhas de um termo vêm juntas (ordem de clickShareRank): decide o termo inteiro quando ele termina
  let atual = ""; let buf: string[] = []; let porNome = false; let porAsin = false;
  const fechar = () => {
    if (buf.length && (porNome || porAsin)) {
      for (const raw of buf) {
        let o: any; try { o = JSON.parse(raw); } catch { continue; }
        const termo = String(o.searchTerm ?? "").trim().toLowerCase();
        if (!termo) continue;
        const e = termos.get(termo) ?? { rank: Number(o.searchFrequencyRank) || null, asins: [] };
        e.asins.push({ r: Number(o.clickShareRank) || 99, asin: String(o.clickedAsin ?? ""), click: o.clickShare ?? null, conv: o.conversionShare ?? null });
        termos.set(termo, e);
      }
    }
    buf = []; porNome = false; porAsin = false;
  };
  for (;;) {
    const { done, value } = await leitor.read();
    if (value) { resto += value; bytes += value.length; }
    let ultimoFim = 0;
    objeto.lastIndex = 0;
    for (let m = objeto.exec(resto); m; m = objeto.exec(resto)) {
      ultimoFim = m.index + m[0].length;
      linhas++;
      const t = termoDe.exec(m[0]);
      if (!t) continue;
      if (t[1] !== atual) { fechar(); atual = t[1]; porNome = ehPet(t[1]); }
      buf.push(m[0]);
      if (!porAsin) { const a = asinDe.exec(m[0]); if (a && conhecidos.has(a[1])) porAsin = true; }
    }
    resto = ultimoFim ? resto.slice(ultimoFim) : resto.slice(-20000);
    if (done) { fechar(); break; }
    if (Date.now() - t0 > 140_000) throw new Error("o relatório é grande demais para ler numa chamada (passou de 140 s)");
  }
  return { termos, linhas, bytes };
}
async function brandAnalytics(t0: number, erros: string[], semanaPedida: string | null) {
  const cs = await contas();
  const sem = semanaPedida
    ? { inicio: semanaPedida, fim: new Date(Date.parse(`${semanaPedida}T12:00:00Z`) + 6 * 86400_000).toISOString().slice(0, 10) }
    : semanaFechada();
  const { data: ja } = await db.from("pesquisa_amz_relatorios").select("*").eq("tipo", BA).eq("semana", sem.inicio);
  const estados = (ja ?? []) as any[];
  if (estados.some((e) => e.estado === "gravado")) return { semana: sem, situacao: "ja_gravado", contas: estados.map((e) => ({ conta: e.conta, estado: e.estado, resumo: e.resumo })) };
  const saida: any[] = [];
  for (const c of cs) {
    const atual = estados.find((e) => e.conta === c.conta);
    const salvar = async (x: Record<string, unknown>) => {
      await db.from("pesquisa_amz_relatorios").upsert({ conta: c.conta, tipo: BA, semana: sem.inicio, atualizado_em: new Date().toISOString(), ...x }, { onConflict: "conta,tipo,semana" });
      saida.push({ conta: c.conta, ...x });
    };
    if (atual && ["sem_permissao", "FATAL", "CANCELLED", "erro"].includes(String(atual.estado))) { saida.push({ conta: c.conta, estado: atual.estado, erro: atual.erro }); continue; }
    // 1) pedir (semana que a Amazon ainda não tinha: no máximo uma vez a cada 6 h)
    if (atual?.estado === "aguardando_dados" && Date.now() - Date.parse(atual.atualizado_em) < 6 * 3600_000) { saida.push({ conta: c.conta, estado: atual.estado, erro: atual.erro }); continue; }
    if (!atual?.report_id) {
      const r = await sp(c, "POST", "/reports/2021-06-30/reports", {}, {
        reportType: BA, marketplaceIds: [c.mkt], reportOptions: { reportPeriod: "WEEK" },
        dataStartTime: `${sem.inicio}T00:00:00Z`, dataEndTime: `${sem.fim}T23:59:59Z`,
      }, "reports", 1000);
      if (r.status === 202 && r.body?.reportId) { await salvar({ report_id: String(r.body.reportId), estado: "IN_QUEUE", erro: null }); continue; }
      const sem_perm = r.status === 403 || /unauthori|access to the requested resource is denied|not allowed|brand/i.test(JSON.stringify(r.body ?? ""));
      await salvar({ estado: sem_perm ? "sem_permissao" : "erro", erro: erroAmz(r).slice(0, 600) });
      continue;
    }
    // 2) acompanhar
    const r = await sp(c, "GET", `/reports/2021-06-30/reports/${atual.report_id}`, {}, undefined, "reports", 500);
    if (r.status !== 200) { erros.push(`brand ${c.conta}: ${erroAmz(r)}`); saida.push({ conta: c.conta, estado: atual.estado, erro: erroAmz(r) }); continue; }
    const st = String(r.body?.processingStatus ?? "");
    if (st !== "DONE") {
      let det: string | null = null;
      if (st === "FATAL" && r.body?.reportDocumentId) {
        // relatório que falhou traz um documento com o motivo
        const d = await sp(c, "GET", `/reports/2021-06-30/documents/${r.body.reportDocumentId}`, {}, undefined, "reports", 500);
        if (d.status === 200 && d.body?.url) {
          try {
            const rr = await fetch(String(d.body.url));
            let s: ReadableStream<Uint8Array> = rr.body!;
            if (String(d.body.compressionAlgorithm ?? "").toUpperCase() === "GZIP") s = s.pipeThrough(new DecompressionStream("gzip"));
            det = (await new Response(s).text()).slice(0, 600);
          } catch { /* sem detalhe */ }
        }
      }
      // semana ainda não processada pela Amazon (sai 2–3 dias depois): pede de novo numa próxima rodada
      const aguardar = st === "FATAL" && !!det && /not available yet/i.test(det);
      await salvar({ report_id: aguardar ? null : atual.report_id, estado: aguardar ? "aguardando_dados" : (st || "?"), erro: det });
      continue;
    }
    // 3) baixar e gravar
    const docId = String(r.body?.reportDocumentId ?? "");
    const d = await sp(c, "GET", `/reports/2021-06-30/documents/${docId}`, {}, undefined, "reports", 500);
    if (d.status !== 200 || !d.body?.url) { await salvar({ report_id: atual.report_id, documento_id: docId, estado: "erro", erro: `documento: ${erroAmz(d)}` }); continue; }
    try {
      const conhecidos = new Set<string>();
      for (let de = 0; ; de += 1000) {
        const { data: ks, error: ke } = await db.from("pesquisa_amz_asins").select("asin").neq("origem", "brand_analytics").range(de, de + 999);
        if (ke) throw new Error(`banco (asins conhecidos): ${ke.message}`);
        (ks ?? []).forEach((k: any) => conhecidos.add(String(k.asin)));
        if ((ks ?? []).length < 1000) break;
      }
      const lido = await lerDocumento(String(d.body.url), String(d.body.compressionAlgorithm ?? "").toUpperCase() === "GZIP", t0, conhecidos);
      const linhas = [...lido.termos.entries()].map(([termo, e]) => {
        const top = e.asins.sort((a, b) => a.r - b.r).slice(0, 3);
        const l: Record<string, unknown> = { semana: sem.inicio, termo, rank_busca: e.rank };
        top.forEach((x, i) => { l[`asin_${i + 1}`] = x.asin || null; l[`click_share_${i + 1}`] = x.click; l[`conv_share_${i + 1}`] = x.conv; });
        return l;
      });
      for (let i = 0; i < linhas.length; i += 500) {
        const { error } = await db.from("pesquisa_amz_brand_analytics").upsert(linhas.slice(i, i + 500), { onConflict: "semana,termo" });
        if (error) throw new Error(`banco: ${error.message}`);
      }
      // os ASINs mais clicados dos termos de pet entram no monitoramento diário
      const maisBuscados = [...linhas].sort((a, b) => (Number(a.rank_busca) || 1e9) - (Number(b.rank_busca) || 1e9)).slice(0, BA_TERMOS_MONITORAR);
      const novos = [...new Set(maisBuscados.flatMap((l) => [l.asin_1, l.asin_2, l.asin_3]).filter(Boolean).map(String))];
      for (let i = 0; i < novos.length; i += 500) {
        await db.from("pesquisa_amz_asins").upsert(novos.slice(i, i + 500).map((a) => ({ asin: a, origem: "brand_analytics" })), { onConflict: "asin", ignoreDuplicates: true });
      }
      await salvar({ report_id: atual.report_id, documento_id: docId, estado: "gravado", erro: null, resumo: { linhas_lidas: lido.linhas, termos_pet: linhas.length, caracteres: lido.bytes } });
    } catch (e) {
      await salvar({ report_id: atual.report_id, documento_id: docId, estado: "DONE", erro: String(e instanceof Error ? e.message : e).slice(0, 600) });
    }
    break; // uma conta gravada basta: o relatório de termos é do marketplace inteiro
  }
  return { semana: sem, contas: saida };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // só lê a Amazon e grava as tabelas do módulo: aceita o cron (chave publicável), usuário logado e service role
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let role = "";
  try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = bearer === SRK ? "service_role" : ""; }
  if (!["anon", "authenticated", "service_role"].includes(role)) return json({ erro: "sem autorização" }, 401);

  const url = new URL(req.url);
  const modo = url.searchParams.get("modo") ?? "";
  if (!["meus", "descobrir", "diario", "brand_analytics"].includes(modo)) return json({ erro: "use ?modo=meus, descobrir, diario ou brand_analytics" }, 400);
  const t0 = Date.now();
  const erros: string[] = [];
  const { data: ex } = await db.from("pesquisa_amz_execucoes").insert({ modo }).select("id").single();
  let resumo: Record<string, unknown> = {};
  try {
    resumo = modo === "meus" ? await meus(t0, erros)
      : modo === "descobrir" ? await descobrir(t0, erros)
      : modo === "diario" ? await diario(t0, erros)
      : await brandAnalytics(t0, erros, url.searchParams.get("semana"));
  } catch (e) {
    erros.push(`falha geral: ${String(e instanceof Error ? e.message : e)}`);
  }
  resumo.ms = Date.now() - t0;
  if (ex?.id) await db.from("pesquisa_amz_execucoes").update({ fim: new Date().toISOString(), resumo, erros: erros.length ? erros.slice(0, 200) : null }).eq("id", ex.id);
  return json({ ok: erros.length === 0, modo, ...resumo, erros: erros.slice(0, 30) });
});
