// ============================================================================
// Edge Function: amazon-ads-sync v2 (24/nov/2026)
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
const REL: Record<string, { tipo: string; adProduct: string; colunas: string[] }> = {
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
      configuration: { adProduct: cfg.adProduct, groupBy: ["campaign"], columns: cfg.colunas, reportTypeId: cfg.tipo, timeUnit: "DAILY", format: "GZIP_JSON" } },
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

// --------------------------------------------------------------------------- sonda de escrita (temporária, 24/nov/2026)
// O escopo advertising::campaign_management inclui escrita no papel, mas o ML já
// negou escrita mesmo com escopo concedido — só um write real prova a permissão.
const ESCRITA_CHAVE = "esc-24nov-7qf3xd";
const ESCRITA_EXPIRA = Date.parse("2026-11-26T03:00:00Z");
const CT_SP = "application/vnd.spCampaign.v3+json";
async function logEscrita(etapa: string, status: number, resultado: unknown) {
  await sb.from("debug_fulfillment").insert({ modulo: "amazon-ads-escrita", etapa, status_http: status, resultado });
}

// --------------------------------------------------------------------------- serve
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  T0 = Date.now();
  const u = new URL(req.url);
  const modulo = u.searchParams.get("modulo") || "status";
  const filtro = u.searchParams.get("conta");
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ ok: false, erro: "faltam AMAZON_ADS_CLIENT_ID/SECRET" }, 500);
    const cs = await contas(filtro);
    if (!cs.length) return json({ ok: false, erro: "nenhuma conta conectada em oauth_tokens_amazon_ads" }, 400);

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
