// ============================================================================
// Edge Function: amazon-ads-sync v4 (25/nov/2026) — + termos de busca (produto SP_TERMO
//   no pedir/coletar -> amazon_ads_termo_diario) e plano-25nov (temporário, mudanças aprovadas)
// v3 (24/nov/2026)
// ----------------------------------------------------------------------------
// Anúncios da Amazon (Amazon Ads API, região NA — o Brasil fica nela).
// Token: oauth_tokens_amazon_ads (gravado pela amazon-ads-oauth), renovado aqui.
// SÓ LÊ na Amazon (os "relatórios" são pedidos de leitura assíncronos).
//
// Módulos (?modulo=):
//   sonda                 perfis + quantas campanhas por tipo (SP/SB/SD) — nada gravado
//   campanhas[&conta=]    lista as campanhas (SP v3, SB v4, SD) -> amazon_ads_campanha
//   pedir[&de&ate][&produtos=SP,SB,SD][&conta=]
//                         pede os relatórios DIÁRIOS por campanha (padrão: últimos 8
//                         dias fechados — a Amazon reatribui vendas) -> amazon_ads_relatorio
//                         janela máx. 31 dias por relatório (a função quebra)
//   coletar               confere os relatórios pendentes; prontos são baixados e
//                         gravados em amazon_ads_campanha_diario (apaga e regrava o
//                         período/produto/conta do relatório)
//   status                resumo do que está gravado
//   estrutura[&campanha=] (só leitura) grupos, anúncios, palavras e alvos de uma
//                         campanha SP — mostra o que a API deixa gerenciar
//   escrita-sonda&chave=&teste=noop|criar  TEMPORÁRIA (expira 26/nov 03:00 UTC):
//                         noop = regrava o MESMO orçamento de uma campanha pausada
//                         (prova a permissão de escrita sem mudar nada);
//                         criar = cria campanha SP PAUSADA de R$ 4 (ou &orc=) e a
//                         apaga em seguida. Tudo em debug_fulfillment (amazon-ads-escrita)
//   gestao (POST JSON {modulo:"gestao", acao, ...}) — escrita de verdade, com prévia:
//     acao "editar"  {mudancas:[{tipo campanha|palavra|alvo, id, campo orcamento|estado|lance, para}]}
//     acao "criar"   {nome, segmentacao AUTO|MANUAL, orcamento, lance_padrao, estado?,
//                     skus:[sku da Amazon], palavras:[{texto, match, lance}], continuar?}
//     sem confirmar = prévia (só leitura); confirmar: true exige sessão de usuário com
//     o módulo ads. Registro em debug_fulfillment (amazon-ads-gestao). Ver §5.15.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CLIENT_ID = (Deno.env.get("AMAZON_ADS_CLIENT_ID") || "").trim();
const CLIENT_SECRET = (Deno.env.get("AMAZON_ADS_CLIENT_SECRET") || "").trim();
const API = "https://advertising-api.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SHOP_ID: Record<string, number> = { ottz: 900001, svl: 900002 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sb = createClient(SUPABASE_URL, SRK);
let T0 = Date.now(); // zerado a cada chamada (o isolate é reaproveitado entre chamadas)
const restante = () => 50_000 - (Date.now() - T0);

// --------------------------------------------------------------------------- token
type Conta = { conta: string; refresh_token: string; access_token: string | null; expires_at: string | null; profile_id_br: number | null; profiles: any[] };
async function contas(filtro?: string | null): Promise<Conta[]> {
  let q = sb.from("oauth_tokens_amazon_ads").select("*");
  if (filtro) q = q.eq("conta", filtro);
  const { data, error } = await q;
  if (error) throw new Error("ler tokens: " + error.message);
  return (data || []) as Conta[];
}
async function token(c: Conta): Promise<string> {
  if (c.access_token && c.expires_at && new Date(c.expires_at).getTime() - Date.now() > 120_000) return c.access_token;
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }).toString(),
  });
  const t: any = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new Error(`renovar token (${c.conta}): HTTP ${r.status} ${t.error || ""} ${t.error_description || ""}`);
  c.access_token = t.access_token;
  c.expires_at = new Date(Date.now() + ((t.expires_in || 3600) - 60) * 1000).toISOString();
  await sb.from("oauth_tokens_amazon_ads").update({
    access_token: c.access_token, expires_at: c.expires_at,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}), atualizado_em: new Date().toISOString(),
  }).eq("conta", c.conta);
  return c.access_token;
}
function perfil(c: Conta): number {
  if (!c.profile_id_br) throw new Error(`conta ${c.conta} sem perfil BR definido em oauth_tokens_amazon_ads.profile_id_br`);
  return c.profile_id_br;
}

async function api(c: Conta, path: string, opts: { method?: string; body?: unknown; ct?: string; accept?: string } = {}) {
  const tk = await token(c);
  const h: Record<string, string> = {
    Authorization: `Bearer ${tk}`,
    "Amazon-Advertising-API-ClientId": CLIENT_ID,
    "Amazon-Advertising-API-Scope": String(perfil(c)),
  };
  if (opts.ct) h["Content-Type"] = opts.ct;
  if (opts.accept) h["Accept"] = opts.accept;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(API + path, { method: opts.method || "GET", headers: h, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const txt = await r.text();
    if (r.status === 429 && i < 3) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue; }
    let j: any = null; try { j = JSON.parse(txt); } catch { j = txt; }
    return { status: r.status, ok: r.ok, body: j };
  }
  return { status: 429, ok: false, body: "limite da Amazon (429)" };
}

// --------------------------------------------------------------------------- campanhas
async function listarSP(c: Conta) {
  const out: any[] = []; let next: string | undefined;
  do {
    const r = await api(c, "/sp/campaigns/list", { method: "POST", ct: "application/vnd.spCampaign.v3+json", accept: "application/vnd.spCampaign.v3+json", body: { maxResults: 100, ...(next ? { nextToken: next } : {}) } });
    if (!r.ok) throw new Error(`SP campanhas: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    out.push(...(r.body.campaigns || [])); next = r.body.nextToken;
  } while (next && restante() > 8000);
  return out.map((x) => ({
    ad_product: "SP", campaign_id: String(x.campaignId), nome: x.name, status: x.state,
    orcamento: x.budget?.budget ?? null, tipo_orcamento: x.budget?.budgetType ?? null,
    segmentacao: x.targetingType ?? null, estrategia: x.dynamicBidding?.strategy ?? null,
    inicio: x.startDate ?? null, fim: x.endDate ?? null, bruto: x,
  }));
}
async function listarSB(c: Conta) {
  const out: any[] = []; let next: string | undefined;
  do {
    const r = await api(c, "/sb/v4/campaigns/list", { method: "POST", ct: "application/vnd.sbcampaignresource.v4+json", accept: "application/vnd.sbcampaignresource.v4+json", body: { maxResults: 100, ...(next ? { nextToken: next } : {}) } });
    if (!r.ok) throw new Error(`SB campanhas: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    out.push(...(r.body.campaigns || [])); next = r.body.nextToken;
  } while (next && restante() > 8000);
  return out.map((x) => ({
    ad_product: "SB", campaign_id: String(x.campaignId), nome: x.name, status: x.state,
    orcamento: x.budget ?? null, tipo_orcamento: x.budgetType ?? null, segmentacao: null,
    estrategia: x.bidding?.bidOptimization != null ? String(x.bidding.bidOptimization) : null,
    inicio: x.startDate ?? null, fim: x.endDate ?? null, bruto: x,
  }));
}
async function listarSD(c: Conta) {
  const r = await api(c, "/sd/campaigns?stateFilter=enabled,paused,archived", { accept: "application/json" });
  if (!r.ok) throw new Error(`SD campanhas: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return (Array.isArray(r.body) ? r.body : []).map((x: any) => ({
    ad_product: "SD", campaign_id: String(x.campaignId), nome: x.name, status: x.state,
    orcamento: x.budget ?? null, tipo_orcamento: x.budgetType ?? null, segmentacao: x.tactic ?? null,
    estrategia: x.costType ?? null, inicio: x.startDate ?? null, fim: x.endDate ?? null, bruto: x,
  }));
}
const LISTAR: Record<string, (c: Conta) => Promise<any[]>> = { SP: listarSP, SB: listarSB, SD: listarSD };

// --------------------------------------------------------------------------- relatórios v3
const REL: Record<string, { tipo: string; adProduct: string; colunas: string[]; groupBy?: string[] }> = {
  // termos de busca (25/nov/2026): qual busca do comprador gerou clique/venda em cada palavra/alvo
  SP_TERMO: { tipo: "spSearchTerm", adProduct: "SPONSORED_PRODUCTS", groupBy: ["searchTerm"],
    colunas: ["date", "campaignId", "campaignName", "adGroupId", "adGroupName", "keywordId", "keyword", "matchType", "targeting", "searchTerm", "impressions", "clicks", "cost", "purchases7d", "sales7d", "unitsSoldClicks7d"] },
  SP: { tipo: "spCampaigns", adProduct: "SPONSORED_PRODUCTS",
    colunas: ["date", "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount", "impressions", "clicks", "cost", "purchases7d", "sales7d", "unitsSoldClicks7d"] },
  SB: { tipo: "sbCampaigns", adProduct: "SPONSORED_BRANDS",
    colunas: ["date", "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount", "impressions", "clicks", "cost", "purchases", "sales", "unitsSold"] },
  SD: { tipo: "sdCampaigns", adProduct: "SPONSORED_DISPLAY",
    colunas: ["date", "campaignId", "campaignName", "campaignStatus", "campaignBudgetAmount", "impressions", "clicks", "cost", "purchases", "sales", "unitsSold"] },
};
const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const addDias = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 86400_000).toISOString().slice(0, 10);

async function pedir(c: Conta, prod: string, de: string, ate: string) {
  const cfg = REL[prod];
  const r = await api(c, "/reporting/reports", {
    method: "POST", ct: "application/vnd.createasyncreportrequest.v3+json",
    body: { name: `${prod} campanhas ${de}..${ate}`, startDate: de, endDate: ate,
      configuration: { adProduct: cfg.adProduct, groupBy: cfg.groupBy ?? ["campaign"], columns: cfg.colunas, reportTypeId: cfg.tipo, timeUnit: "DAILY", format: "GZIP_JSON" } },
  });
  // 425 = já existe relatório igual em andamento: a Amazon devolve o id no detalhe
  let reportId = r.body?.reportId as string | undefined;
  if (!reportId && r.status === 425) { const m = String(r.body?.detail || "").match(/[0-9a-f-]{36}/); if (m) reportId = m[0]; }
  const linha = {
    conta: c.conta, profile_id: perfil(c), ad_product: prod, de, ate,
    report_id: reportId ?? null, status: reportId ? "pedido" : "erro",
    erro: reportId ? null : `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`,
  };
  await sb.from("amazon_ads_relatorio").insert(linha);
  return linha;
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
async function baixarGzipJson(url: string): Promise<any[]> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
  const txt = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  const j = JSON.parse(txt);
  return Array.isArray(j) ? j : [];
}

async function coletar(c: Conta, rel: any) {
  const r = await api(c, `/reporting/reports/${rel.report_id}`, { accept: "application/vnd.createasyncreportrequest.v3+json" });
  if (!r.ok) {
    await sb.from("amazon_ads_relatorio").update({ verificado_em: new Date().toISOString(), erro: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}` }).eq("id", rel.id);
    return { id: rel.id, status: "erro_consulta" };
  }
  const st = String(r.body.status || "");
  if (st === "FAILURE") {
    await sb.from("amazon_ads_relatorio").update({ status: "erro", erro: String(r.body.failureReason || "FAILURE").slice(0, 500), verificado_em: new Date().toISOString() }).eq("id", rel.id);
    return { id: rel.id, status: "erro" };
  }
  if (st !== "COMPLETED" || !r.body.url) {
    await sb.from("amazon_ads_relatorio").update({ verificado_em: new Date().toISOString() }).eq("id", rel.id);
    return { id: rel.id, status: st || "?" };
  }
  const linhas = await baixarGzipJson(r.body.url);
  const shop = SHOP_ID[c.conta] ?? null;
  if (rel.ad_product === "SP_TERMO") return await gravarTermos(c, rel, linhas, shop);
  const reg = linhas.map((x) => ({
    data: x.date, conta: c.conta, shop_id: shop, profile_id: rel.profile_id, ad_product: rel.ad_product,
    campaign_id: String(x.campaignId), nome: x.campaignName ?? null, status: x.campaignStatus ?? null,
    orcamento: x.campaignBudgetAmount ?? null,
    impressoes: num(x.impressions), cliques: num(x.clicks), gasto: num(x.cost),
    vendas: num(x.sales7d ?? x.sales), pedidos: num(x.purchases7d ?? x.purchases), unidades: num(x.unitsSoldClicks7d ?? x.unitsSold),
    atualizado_em: new Date().toISOString(),
  })).filter((x) => x.data && x.campaign_id);
  // regrava o período do relatório (vendas são reatribuídas pela Amazon)
  const del = await sb.from("amazon_ads_campanha_diario").delete()
    .eq("conta", c.conta).eq("ad_product", rel.ad_product).gte("data", rel.de).lte("data", rel.ate);
  if (del.error) throw new Error("apagar período: " + del.error.message);
  for (let i = 0; i < reg.length; i += 500) {
    const ins = await sb.from("amazon_ads_campanha_diario").insert(reg.slice(i, i + 500));
    if (ins.error) throw new Error("gravar: " + ins.error.message);
  }
  await sb.from("amazon_ads_relatorio").update({ status: "gravado", linhas: reg.length, concluido_em: new Date().toISOString(), verificado_em: new Date().toISOString(), erro: null }).eq("id", rel.id);
  return { id: rel.id, status: "gravado", linhas: reg.length };
}

// termos de busca: soma por (dia, campanha, grupo, palavra/alvo, termo) e regrava o período
async function gravarTermos(c: Conta, rel: any, linhas: any[], shop: number | null) {
  const mapa = new Map<string, any>();
  for (const x of linhas) {
    if (!x.date || !x.campaignId || x.searchTerm == null) continue;
    const alvo = x.keyword ?? x.targeting ?? null;
    const chave = [x.date, c.conta, x.campaignId, x.adGroupId ?? "", x.keywordId ?? alvo ?? "", String(x.searchTerm)].join("|");
    const a = mapa.get(chave) ?? {
      chave, data: x.date, conta: c.conta, shop_id: shop, campaign_id: String(x.campaignId), campanha: x.campaignName ?? null,
      ad_group_id: x.adGroupId != null ? String(x.adGroupId) : null, grupo: x.adGroupName ?? null,
      keyword_id: x.keywordId != null ? String(x.keywordId) : null, alvo, match_type: x.matchType ?? null,
      termo: String(x.searchTerm), impressoes: 0, cliques: 0, gasto: 0, vendas: 0, pedidos: 0, unidades: 0,
      atualizado_em: new Date().toISOString(),
    };
    a.impressoes += num(x.impressions); a.cliques += num(x.clicks); a.gasto += num(x.cost);
    a.vendas += num(x.sales7d); a.pedidos += num(x.purchases7d); a.unidades += num(x.unitsSoldClicks7d);
    mapa.set(chave, a);
  }
  const reg = [...mapa.values()].map((a) => ({ ...a, gasto: Math.round(a.gasto * 100) / 100, vendas: Math.round(a.vendas * 100) / 100 }));
  const del = await sb.from("amazon_ads_termo_diario").delete().eq("conta", c.conta).gte("data", rel.de).lte("data", rel.ate);
  if (del.error) throw new Error("apagar período (termos): " + del.error.message);
  for (let i = 0; i < reg.length; i += 500) {
    const ins = await sb.from("amazon_ads_termo_diario").insert(reg.slice(i, i + 500));
    if (ins.error) throw new Error("gravar termos: " + ins.error.message);
  }
  await sb.from("amazon_ads_relatorio").update({ status: "gravado", linhas: reg.length, concluido_em: new Date().toISOString(), verificado_em: new Date().toISOString(), erro: null }).eq("id", rel.id);
  return { id: rel.id, status: "gravado", linhas: reg.length };
}

// --------------------------------------------------------------------------- gestão (escrita de verdade, 24/nov/2026)
// Prévia sem `confirmar` (só leitura); com `confirmar: true` exige sessão de USUÁRIO
// com o módulo `ads` (a chave publicável e o Bearer dos crons são recusados).
// Cada escrita vai UMA vez, para no 1º recusado, relê depois e fica em
// debug_fulfillment (modulo 'amazon-ads-gestao'). Campanha nova nasce PAUSADA
// por padrão. Só Sponsored Products (a conta não usa SB/SD).
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const CT = {
  campanha: "application/vnd.spCampaign.v3+json",
  grupo: "application/vnd.spAdGroup.v3+json",
  anuncio: "application/vnd.spProductAd.v3+json",
  palavra: "application/vnd.spKeyword.v3+json",
  alvo: "application/vnd.spTargetingClause.v3+json",
};
type Quem = { id: string | null; nome: string | null };
async function exigirUsuarioAds(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { id: null, nome: "sistema" };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { id: null, nome: "sistema" };
  if (pl.role !== "authenticated") return json({ ok: false, erro: "faça login no app (sessão de usuário exigida para escrever na Amazon)" }, 401);
  const doUsuario = createClient(SUPABASE_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ads" });
  if (error || data !== true) return json({ ok: false, erro: "sem acesso ao módulo ADS" }, 403);
  const { data: perfilU } = await sb.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfilU?.nome as string) ?? (pl.email as string) ?? null };
}
async function logGestao(etapa: string, status: number, resultado: unknown) {
  await sb.from("debug_fulfillment").insert({ modulo: "amazon-ads-gestao", etapa, status_http: status, resultado });
}
const porItem = (body: any, plural: string) => ({ ok: (body?.[plural]?.success ?? []) as any[], erro: (body?.[plural]?.error ?? []) as any[] });

type Mudanca = { tipo: "campanha" | "palavra" | "alvo"; id: string; campo: "orcamento" | "estado" | "lance"; para: unknown };
const ESTADOS = new Set(["ENABLED", "PAUSED", "ARCHIVED"]);

/** Lê ao vivo os itens citados nas mudanças (para a prévia e para o "hoje"). */
async function lerAtuais(c: Conta, mudancas: Mudanca[]) {
  const ids = (t: Mudanca["tipo"]) => [...new Set(mudancas.filter((m) => m.tipo === t).map((m) => String(m.id)))];
  const atuais: Record<string, any> = {};
  const camp = ids("campanha");
  if (camp.length) {
    const r = await api(c, "/sp/campaigns/list", { method: "POST", ct: CT.campanha, accept: CT.campanha, body: { campaignIdFilter: { include: camp } } });
    if (!r.ok) throw new Error(`ler campanhas: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    for (const x of r.body?.campaigns ?? []) atuais[`campanha:${x.campaignId}`] = { nome: x.name, estado: x.state, orcamento: x.budget?.budget ?? null };
  }
  const pal = ids("palavra");
  if (pal.length) {
    const r = await api(c, "/sp/keywords/list", { method: "POST", ct: CT.palavra, accept: CT.palavra, body: { keywordIdFilter: { include: pal } } });
    if (!r.ok) throw new Error(`ler palavras: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    for (const x of r.body?.keywords ?? []) atuais[`palavra:${x.keywordId}`] = { nome: x.keywordText, match: x.matchType, estado: x.state, lance: x.bid ?? null, campaign_id: String(x.campaignId) };
  }
  const alv = ids("alvo");
  if (alv.length) {
    const r = await api(c, "/sp/targets/list", { method: "POST", ct: CT.alvo, accept: CT.alvo, body: { targetIdFilter: { include: alv } } });
    if (!r.ok) throw new Error(`ler alvos: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    for (const x of r.body?.targetingClauses ?? []) atuais[`alvo:${x.targetId}`] = { nome: (x.resolvedExpression ?? x.expression ?? []).map((e: any) => e.value).join(" "), estado: x.state, lance: x.bid ?? null, campaign_id: String(x.campaignId) };
  }
  return atuais;
}

async function gestaoEditar(c: Conta, b: any, quem: Quem | null) {
  const mudancas = (Array.isArray(b.mudancas) ? b.mudancas : []) as Mudanca[];
  if (!mudancas.length) return json({ ok: false, erro: "mande mudancas: [{tipo, id, campo, para}]" }, 400);
  if (mudancas.length > 50) return json({ ok: false, erro: "no máximo 50 mudanças por vez" }, 400);
  for (const m of mudancas) {
    if (!["campanha", "palavra", "alvo"].includes(m.tipo) || !m.id) return json({ ok: false, erro: `mudança inválida: ${JSON.stringify(m)}` }, 400);
    if (m.campo === "estado" && !ESTADOS.has(String(m.para))) return json({ ok: false, erro: `estado inválido (${m.para}): use ENABLED, PAUSED ou ARCHIVED` }, 400);
    if ((m.campo === "orcamento" || m.campo === "lance") && !(Number(m.para) > 0)) return json({ ok: false, erro: `${m.campo} precisa ser um número maior que zero` }, 400);
    if (m.campo === "orcamento" && m.tipo !== "campanha") return json({ ok: false, erro: "orçamento só existe em campanha" }, 400);
    if (m.campo === "lance" && m.tipo === "campanha") return json({ ok: false, erro: "lance é de palavra/alvo, não de campanha" }, 400);
  }
  const atuais = await lerAtuais(c, mudancas);
  const previa = mudancas.map((m) => {
    const a = atuais[`${m.tipo}:${m.id}`];
    const hoje = a ? (m.campo === "orcamento" ? a.orcamento : m.campo === "lance" ? a.lance : a.estado) : null;
    const avisos: string[] = [];
    if (!a) avisos.push("não encontrado na Amazon");
    if (m.campo === "orcamento" && Number(m.para) < 4) avisos.push("abaixo de R$ 4 a Amazon pode recusar (mínimo do marketplace)");
    if (a && String(hoje) === String(m.para)) avisos.push("já está com esse valor");
    return { ...m, nome: a?.nome ?? null, hoje, avisos };
  });
  if (!b.confirmar) return json({ ok: true, previa, confirmar: false });
  if (previa.some((p) => p.avisos.includes("não encontrado na Amazon"))) return json({ ok: false, erro: "há item que não existe na Amazon — refaça a prévia", previa }, 400);

  // monta UM request por tipo; a resposta 207 diz item a item o que passou
  const corpo: Record<string, Record<string, any>> = { campanha: {}, palavra: {}, alvo: {} };
  for (const m of mudancas) {
    const alvo = (corpo[m.tipo][m.id] ??= m.tipo === "campanha" ? { campaignId: m.id } : m.tipo === "palavra" ? { keywordId: m.id } : { targetId: m.id });
    if (m.campo === "orcamento") alvo.budget = { budget: Number(m.para), budgetType: "DAILY" };
    if (m.campo === "lance") alvo.bid = Number(m.para);
    if (m.campo === "estado") alvo.state = String(m.para);
  }
  const resultados: any[] = [];
  const envios: [Mudanca["tipo"], string, string, string][] = [
    ["campanha", "/sp/campaigns", CT.campanha, "campaigns"],
    ["palavra", "/sp/keywords", CT.palavra, "keywords"],
    ["alvo", "/sp/targets", CT.alvo, "targetingClauses"],
  ];
  for (const [tipo, path, ct, plural] of envios) {
    const itens = Object.values(corpo[tipo]);
    if (!itens.length) continue;
    const r = await api(c, path, { method: "PUT", ct, accept: ct, body: { [plural]: itens } });
    const { ok, erro } = porItem(r.body, plural);
    await logGestao(`editar:${tipo}`, r.status, { por: quem?.nome ?? null, enviado: itens, resposta: r.body });
    resultados.push({ tipo, status: r.status, sucesso: ok.length, recusados: erro });
    if (!r.ok || erro.length) break; // para no 1º recusado (os tipos seguintes não vão)
  }
  // espelho: orçamento/estado das campanhas alteradas
  const depois = await lerAtuais(c, mudancas.filter((m) => m.tipo === "campanha"));
  for (const [chave, a] of Object.entries(depois)) {
    const id = chave.split(":")[1];
    await sb.from("amazon_ads_campanha").update({ orcamento: a.orcamento, status: a.estado, atualizado_em: new Date().toISOString() })
      .eq("conta", c.conta).eq("ad_product", "SP").eq("campaign_id", id);
  }
  const tudoOk = resultados.every((x) => x.recusados.length === 0 && (x.status < 300 || x.status === 207));
  return json({ ok: tudoOk, resultados, depois });
}

async function gestaoCriar(c: Conta, b: any, quem: Quem | null) {
  const nome = String(b.nome ?? "").trim();
  const seg = b.segmentacao === "AUTO" ? "AUTO" : "MANUAL";
  const orcamento = Number(b.orcamento);
  const lancePadrao = Number(b.lance_padrao ?? 0.5);
  const estado = b.estado === "ENABLED" ? "ENABLED" : "PAUSED";
  const skus = [...new Set(((Array.isArray(b.skus) ? b.skus : []) as unknown[]).map((s) => String(s).trim()).filter(Boolean))];
  const palavras = (Array.isArray(b.palavras) ? b.palavras : []).map((p: any) => ({
    texto: String(p.texto ?? "").trim(), match: ["EXACT", "PHRASE", "BROAD"].includes(p.match) ? p.match : "EXACT", lance: Number(p.lance ?? lancePadrao),
  })).filter((p: any) => p.texto);

  const avisos: string[] = [];
  const pendencias: string[] = [];
  if (!nome) pendencias.push("dê um nome à campanha");
  if (!(orcamento > 0)) pendencias.push("informe o orçamento diário");
  else if (orcamento < 4) avisos.push("orçamento abaixo de R$ 4: a Amazon pode recusar (mínimo do marketplace)");
  if (!(lancePadrao > 0)) pendencias.push("informe o lance padrão do grupo");
  if (!skus.length) pendencias.push("escolha ao menos um SKU da Amazon");
  if (seg === "MANUAL" && !palavras.length) pendencias.push("campanha manual precisa de ao menos uma palavra-chave");
  // nome repetido = confusão na conta
  const { data: jaExiste } = await sb.from("amazon_ads_campanha").select("campaign_id,status").eq("conta", c.conta).eq("ad_product", "SP").eq("nome", nome).limit(1);
  if (nome && jaExiste?.length) avisos.push(`já existe campanha com este nome (#${jaExiste[0].campaign_id}, ${jaExiste[0].status})`);
  // SKU precisa existir na conta (anúncio da Amazon)
  const { data: meus } = await sb.from("pesquisa_amz_meus_skus").select("sku_amazon, asin, sku, nome").eq("conta", c.conta).in("sku_amazon", skus);
  const achados = new Map((meus ?? []).map((m: any) => [m.sku_amazon, m]));
  const skusInfo = skus.map((s) => ({ sku_amazon: s, asin: achados.get(s)?.asin ?? null, nosso_sku: achados.get(s)?.sku ?? null, nome: achados.get(s)?.nome ?? null, conhecido: achados.has(s) }));
  for (const s of skusInfo) if (!s.conhecido) avisos.push(`SKU ${s.sku_amazon} não está na lista de anúncios da conta (pesquisa_amz_meus_skus) — confira a grafia; se for anúncio novo, a Amazon confere na hora`);

  const plano = { nome, segmentacao: seg, orcamento, lance_padrao: lancePadrao, estado, skus: skusInfo, palavras, avisos, pendencias };
  if (!b.confirmar) return json({ ok: pendencias.length === 0, previa: plano, confirmar: false });
  if (pendencias.length) return json({ ok: false, erro: "há pendências — refaça a prévia", previa: plano }, 400);

  // retomada: se a tela mandar os ids já criados, pula as etapas prontas
  let campaignId: string | null = b.continuar?.campaignId ? String(b.continuar.campaignId) : null;
  let adGroupId: string | null = b.continuar?.adGroupId ? String(b.continuar.adGroupId) : null;
  const passos: any[] = [];
  const falha = (etapa: string, r: { status: number; body: unknown }) =>
    json({ ok: false, erro: `a Amazon recusou em "${etapa}"`, parou_em: etapa, campaignId, adGroupId, passos, resposta: r.body }, 502);

  if (!campaignId) {
    const r = await api(c, "/sp/campaigns", { method: "POST", ct: CT.campanha, accept: CT.campanha, body: { campaigns: [{ name: nome, targetingType: seg, state: estado, budget: { budget: orcamento, budgetType: "DAILY" }, startDate: hojeBRT(), dynamicBidding: { strategy: "LEGACY_FOR_SALES" } }] } });
    const { ok, erro } = porItem(r.body, "campaigns");
    await logGestao(`criar:campanha:${nome}`, r.status, { por: quem?.nome ?? null, resposta: r.body });
    if (!ok.length) return falha("criar a campanha", r);
    campaignId = String(ok[0].campaignId);
    passos.push({ etapa: "campanha", id: campaignId, recusados: erro });
  }
  if (!adGroupId) {
    const r = await api(c, "/sp/adGroups", { method: "POST", ct: CT.grupo, accept: CT.grupo, body: { adGroups: [{ campaignId, name: nome, defaultBid: lancePadrao, state: "ENABLED" }] } });
    const { ok } = porItem(r.body, "adGroups");
    await logGestao(`criar:grupo:${campaignId}`, r.status, { por: quem?.nome ?? null, resposta: r.body });
    if (!ok.length) return falha("criar o grupo de anúncios", r);
    adGroupId = String(ok[0].adGroupId);
    passos.push({ etapa: "grupo", id: adGroupId });
  }
  {
    const r = await api(c, "/sp/productAds", { method: "POST", ct: CT.anuncio, accept: CT.anuncio, body: { productAds: skus.map((s) => ({ campaignId, adGroupId, sku: s, state: "ENABLED" })) } });
    const { ok, erro } = porItem(r.body, "productAds");
    await logGestao(`criar:anuncios:${campaignId}`, r.status, { por: quem?.nome ?? null, skus, resposta: r.body });
    passos.push({ etapa: "anuncios", criados: ok.length, recusados: erro.map((e: any) => ({ sku: skus[e.index], erros: e.errors })) });
    if (!ok.length) return falha("pôr os produtos na campanha", r);
  }
  if (seg === "MANUAL" && palavras.length) {
    const r = await api(c, "/sp/keywords", { method: "POST", ct: CT.palavra, accept: CT.palavra, body: { keywords: palavras.map((p: any) => ({ campaignId, adGroupId, keywordText: p.texto, matchType: p.match, bid: p.lance, state: "ENABLED" })) } });
    const { ok, erro } = porItem(r.body, "keywords");
    await logGestao(`criar:palavras:${campaignId}`, r.status, { por: quem?.nome ?? null, resposta: r.body });
    passos.push({ etapa: "palavras", criadas: ok.length, recusadas: erro.map((e: any) => ({ palavra: palavras[e.index]?.texto, erros: e.errors })) });
    if (!ok.length) return falha("criar as palavras-chave", r);
  }
  // espelho na hora
  await sb.from("amazon_ads_campanha").upsert({
    conta: c.conta, shop_id: SHOP_ID[c.conta] ?? null, profile_id: perfil(c), ad_product: "SP", campaign_id: campaignId,
    nome, status: estado, orcamento, tipo_orcamento: "DAILY", segmentacao: seg, estrategia: "LEGACY_FOR_SALES",
    inicio: hojeBRT(), bruto: { criado_pelo_app: true, por: quem?.nome ?? null }, atualizado_em: new Date().toISOString(),
  }, { onConflict: "conta,ad_product,campaign_id" });
  return json({ ok: true, campaignId, adGroupId, estado, passos });
}

// --------------------------------------------------------------------------- sonda de escrita (temporária, 24/nov/2026)
// O escopo advertising::campaign_management inclui escrita no papel, mas o ML já
// negou escrita mesmo com escopo concedido — só um write real prova a permissão.
const ESCRITA_CHAVE = "esc-24nov-7qf3xd";
const ESCRITA_EXPIRA = Date.parse("2026-11-26T03:00:00Z");
const CT_SP = "application/vnd.spCampaign.v3+json";
async function logEscrita(etapa: string, status: number, resultado: unknown) {
  await sb.from("debug_fulfillment").insert({ modulo: "amazon-ads-escrita", etapa, status_http: status, resultado });
}

// --------------------------------------------------------------------------- plano aprovado em 25/nov/2026 (temporário)
const PLANO_CHAVE = "plano-25nov-k8r2w";
const PLANO_EXPIRA = Date.parse("2026-11-27T03:00:00Z");
// prejuízo nos últimos 30 dias (retorno abaixo do empate pela margem do produto)
const PLANO_PAUSAR = [
  "250819784255212", // TOFU AUTOMÁTICA — retorno 2,3 (semana 1,5), empate ~9
  "214276531478525", // BUMI BANHO A SECO - MANUAL — 2,3, empate 5,3
  "250344582322099", // SP | Exata | Banho Seco Bumi 500ml — 1,8
  "25354521130747",  // SP | ASIN | Banho Seco Bumi 500ml | Conquista — 2,0
  "322239002822671", // Bumi Adestradores — 3,1, empate 5,6
];
// Bumi Mandioca 4 kg (15984_FBA, margem 17,7%) + 8 kg (16330_FBA, 15,7%); termos do Brand Analytics (semana 15/11)
const PLANO_NOVAS = [
  { nome: "SP | Exata | Bumi Mandioca", segmentacao: "MANUAL", orcamento: 15, lance_padrao: 0.7, estado: "ENABLED",
    skus: ["15984_FBA", "16330_FBA"],
    palavras: ["areia para gato mandioca", "areia de mandioca para gato", "areia gato mandioca", "areia mandioca", "areia de mandioca",
      "areia biodegradável para gato", "areia para gato biodegradavel", "areia biodegradável"].map((texto) => ({ texto, match: "EXACT", lance: 0.75 })) },
  { nome: "SP | Frase | Bumi Mandioca", segmentacao: "MANUAL", orcamento: 10, lance_padrao: 0.5, estado: "ENABLED",
    skus: ["15984_FBA", "16330_FBA"],
    palavras: [
      { texto: "areia mandioca", match: "PHRASE", lance: 0.55 }, { texto: "areia de mandioca", match: "PHRASE", lance: 0.55 },
      { texto: "mandioca para gato", match: "PHRASE", lance: 0.5 }, { texto: "areia biodegradavel", match: "PHRASE", lance: 0.45 },
      { texto: "areia para gato", match: "PHRASE", lance: 0.4 }, { texto: "areia de gato", match: "PHRASE", lance: 0.4 },
      { texto: "areia gato", match: "PHRASE", lance: 0.4 },
    ] },
];

// --------------------------------------------------------------------------- serve
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  T0 = Date.now();
  const u = new URL(req.url);
  let corpo: any = null;
  if (req.method === "POST" && (req.headers.get("content-type") || "").includes("json")) {
    try { corpo = await req.json(); } catch { corpo = null; }
  }
  const modulo = corpo?.modulo || u.searchParams.get("modulo") || "status";
  const filtro = corpo?.conta || u.searchParams.get("conta");
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ ok: false, erro: "faltam AMAZON_ADS_CLIENT_ID/SECRET" }, 500);
    const cs = await contas(filtro);
    if (!cs.length) return json({ ok: false, erro: "nenhuma conta conectada em oauth_tokens_amazon_ads" }, 400);

    if (modulo === "gestao") {
      // prévia é só leitura (qualquer sessão que passou do verify_jwt); escrever exige usuário com módulo ads
      let quem: Quem | null = null;
      if (corpo?.confirmar) {
        const q = await exigirUsuarioAds(req);
        if (q instanceof Response) return q;
        quem = q;
      }
      const c = cs[0];
      if (corpo?.acao === "editar") return await gestaoEditar(c, corpo, quem);
      if (corpo?.acao === "criar") return await gestaoCriar(c, corpo, quem);
      return json({ ok: false, erro: 'acao ? ("editar" | "criar")' }, 400);
    }

    if (modulo === "sonda") {
      const out: any[] = [];
      for (const c of cs) {
        const pr = await api(c, "/v2/profiles", { accept: "application/json" });
        const tipos: Record<string, unknown> = {};
        for (const p of ["SP", "SB", "SD"]) {
          try { const l = await LISTAR[p](c); tipos[p] = { campanhas: l.length, ativas: l.filter((x) => String(x.status).toLowerCase() === "enabled").length }; }
          catch (e) { tipos[p] = { erro: String((e as Error).message).slice(0, 300) }; }
        }
        out.push({ conta: c.conta, perfil: c.profile_id_br, perfis: Array.isArray(pr.body) ? pr.body.map((p: any) => ({ id: p.profileId, pais: p.countryCode, moeda: p.currencyCode, fuso: p.timezone, nome: p.accountInfo?.name })) : pr.body, tipos });
      }
      return json({ ok: true, contas: out });
    }

    if (modulo === "campanhas") {
      const out: any[] = [];
      for (const c of cs) {
        let n = 0; const erros: string[] = [];
        for (const p of ["SP", "SB", "SD"]) {
          try {
            const l = await LISTAR[p](c);
            const reg = l.map((x) => ({ ...x, conta: c.conta, shop_id: SHOP_ID[c.conta] ?? null, profile_id: perfil(c), atualizado_em: new Date().toISOString() }));
            for (let i = 0; i < reg.length; i += 500) {
              const up = await sb.from("amazon_ads_campanha").upsert(reg.slice(i, i + 500), { onConflict: "conta,ad_product,campaign_id" });
              if (up.error) throw new Error(up.error.message);
            }
            n += reg.length;
          } catch (e) { erros.push(`${p}: ${(e as Error).message}`.slice(0, 300)); }
        }
        out.push({ conta: c.conta, campanhas: n, erros });
      }
      return json({ ok: true, contas: out });
    }

    if (modulo === "pedir") {
      const ate = u.searchParams.get("ate") || addDias(hojeBRT(), -1);
      const de = u.searchParams.get("de") || addDias(ate, -7);
      const prods = (u.searchParams.get("produtos") || "SP,SB,SD").split(",").map((s) => s.trim().toUpperCase()).filter((s) => REL[s]);
      const out: any[] = [];
      for (const c of cs) for (const p of prods) {
        for (let ini = de; ini <= ate; ini = addDias(ini, 31)) {
          const fim = addDias(ini, 30) < ate ? addDias(ini, 30) : ate;
          out.push(await pedir(c, p, ini, fim));
          if (restante() < 6000) break;
        }
      }
      return json({ ok: true, pedidos: out.map(({ conta, ad_product, de, ate, status, erro }) => ({ conta, ad_product, de, ate, status, erro })) });
    }

    if (modulo === "coletar") {
      const { data: pend, error } = await sb.from("amazon_ads_relatorio").select("*").eq("status", "pedido").order("criado_em").limit(20);
      if (error) throw new Error(error.message);
      const out: any[] = [];
      for (const rel of pend || []) {
        if (restante() < 10000) break;
        const c = cs.find((x) => x.conta === rel.conta);
        if (!c) continue;
        try { out.push(await coletar(c, rel)); }
        catch (e) {
          await sb.from("amazon_ads_relatorio").update({ erro: String((e as Error).message).slice(0, 500), verificado_em: new Date().toISOString() }).eq("id", rel.id);
          out.push({ id: rel.id, status: "erro", erro: (e as Error).message });
        }
      }
      // pedido há mais de 6 h sem ficar pronto = desiste (o próximo "pedir" refaz)
      await sb.from("amazon_ads_relatorio").update({ status: "erro", erro: "6 h sem ficar pronto" })
        .eq("status", "pedido").lt("criado_em", new Date(Date.now() - 6 * 3600_000).toISOString());
      return json({ ok: true, relatorios: out });
    }

    if (modulo === "estrutura") {
      const c = cs[0];
      const camp = u.searchParams.get("campanha");
      const chamadas: [string, string, string][] = [
        ["adGroups", "/sp/adGroups/list", "application/vnd.spAdGroup.v3+json"],
        ["productAds", "/sp/productAds/list", "application/vnd.spProductAd.v3+json"],
        ["keywords", "/sp/keywords/list", "application/vnd.spKeyword.v3+json"],
        ["targetingClauses", "/sp/targets/list", "application/vnd.spTargetingClause.v3+json"],
        ["negativeKeywords", "/sp/negativeKeywords/list", "application/vnd.spNegativeKeyword.v3+json"],
      ];
      const out: Record<string, unknown> = {};
      for (const [nome, path, ct] of chamadas) {
        const r = await api(c, path, { method: "POST", ct, accept: ct, body: { maxResults: 10, ...(camp ? { campaignIdFilter: { include: [camp] } } : {}) } });
        const arr = (r.body && (r.body[nome] || r.body[nome.toLowerCase()])) ?? null;
        out[nome] = r.ok
          ? { total: r.body?.totalResults ?? (Array.isArray(arr) ? arr.length : null), amostra: Array.isArray(arr) ? arr.slice(0, 3) : r.body }
          : { erro: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 250)}` };
      }
      return json({ ok: true, conta: cs[0].conta, campanha: camp, estrutura: out });
    }

    if (modulo === "plano-25nov") {
      // TEMPORÁRIO: mudanças aprovadas pelo dono no chat em 25/nov/2026 (opção C).
      // Lista fechada no código; sem &confirmar=1 = só prévia. Campanha cujo nome já
      // existe não é recriada (rodar de novo não duplica).
      if (u.searchParams.get("chave") !== PLANO_CHAVE || Date.now() > PLANO_EXPIRA) return json({ ok: false, erro: "plano fora do ar" }, 403);
      const c = cs.find((x) => x.conta === "ottz") ?? cs[0];
      const confirmar = u.searchParams.get("confirmar") === "1";
      const quem: Quem = { id: null, nome: "Renan (aprovado no chat em 25/nov/2026)" };
      const ed = await gestaoEditar(c, { mudancas: PLANO_PAUSAR.map((id) => ({ tipo: "campanha", id, campo: "estado", para: "PAUSED" })), confirmar }, quem);
      const editar = await ed.json();
      const criar: any[] = [];
      for (const n of PLANO_NOVAS) {
        const { data: ja } = await sb.from("amazon_ads_campanha").select("campaign_id,status").eq("conta", c.conta).eq("ad_product", "SP").eq("nome", n.nome).limit(1);
        if (ja?.length) { criar.push({ nome: n.nome, pulada: `já existe (#${ja[0].campaign_id}, ${ja[0].status})` }); continue; }
        const r = await gestaoCriar(c, { ...n, confirmar }, quem);
        criar.push({ nome: n.nome, ...(await r.json()) });
        if (restante() < 8000) break;
      }
      return json({ ok: true, confirmar, editar, criar });
    }

    if (modulo === "escrita-sonda") {
      if (u.searchParams.get("chave") !== ESCRITA_CHAVE || Date.now() > ESCRITA_EXPIRA) return json({ ok: false, erro: "sonda de escrita fora do ar" }, 403);
      const c = cs[0];
      const teste = u.searchParams.get("teste") || "";
      if (teste === "noop") {
        const id = u.searchParams.get("campanha") || "";
        const antes = await api(c, "/sp/campaigns/list", { method: "POST", ct: CT_SP, accept: CT_SP, body: { campaignIdFilter: { include: [id] } } });
        const camp = antes.body?.campaigns?.[0];
        if (!camp) return json({ ok: false, erro: "campanha não encontrada", antes: antes.body }, 400);
        const upd = await api(c, "/sp/campaigns", { method: "PUT", ct: CT_SP, accept: CT_SP, body: { campaigns: [{ campaignId: String(camp.campaignId), budget: camp.budget }] } });
        await logEscrita(`noop:${id}`, upd.status, { orcamento_mantido: camp.budget, resposta: upd.body });
        return json({ ok: upd.ok, teste: "noop", campanha: id, orcamento_mantido: camp.budget, status: upd.status, resposta: upd.body });
      }
      if (teste === "criar") {
        const nome = `TESTE APP ${hojeBRT()} (apagar)`;
        const cria = await api(c, "/sp/campaigns", { method: "POST", ct: CT_SP, accept: CT_SP, body: { campaigns: [{ name: nome, targetingType: "MANUAL", state: "PAUSED", budget: { budget: Number(u.searchParams.get("orc") || 4), budgetType: "DAILY" }, startDate: hojeBRT() }] } });
        await logEscrita("criar", cria.status, cria.body);
        const novoId = cria.body?.campaigns?.success?.[0]?.campaignId;
        let apaga: { status: number; body: unknown } | null = null;
        if (novoId) {
          const d = await api(c, "/sp/campaigns/delete", { method: "POST", ct: CT_SP, accept: CT_SP, body: { campaignIdFilter: { include: [String(novoId)] } } });
          apaga = { status: d.status, body: d.body };
          await logEscrita(`apagar:${novoId}`, d.status, d.body);
        }
        return json({ ok: cria.ok && !!novoId, teste: "criar", nome, status: cria.status, criada: cria.body, apagada: apaga });
      }
      return json({ ok: false, erro: "teste ? (noop | criar)" }, 400);
    }

    // status
    const { data: rel } = await sb.from("amazon_ads_relatorio").select("conta,ad_product,de,ate,status,linhas,erro,criado_em").order("criado_em", { ascending: false }).limit(12);
    return json({ ok: true, ultimos_relatorios: rel });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, 500);
  }
});
