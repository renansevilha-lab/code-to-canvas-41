// ============================================================================
// Edge Function: ml-sync-ads v8
// Metricas de campanhas do Mercado Ads -> tabela ml_ads_campanha (+ retorna a lista).
//
// v8 (19/out/2026, pedido do dono): modulo=campanha-anuncios&campanha=ID[&de&ate] -> os anuncios da campanha com as
//   metricas do periodo (so leitura) — a tela /ads-ml abre a campanha e mostra os produtos.
// v7 (19/out/2026, pedido do dono): modulo=roas-alvo&campanha=ID&roas=N -> 1a ESCRITA no Mercado Ads:
//   troca o ROAS objetivo de UMA campanha. Le a campanha antes, envia a troca UMA vez e le de novo.
//   So aceita as campanhas/valores liberados em ROAS_LIBERADO e expira em 21/out. Se o ML recusar o
//   formato (400/404/405, nada muda), tenta o proximo formato da lista; para no 1o aceito ou em 401/403.
//   Cada tentativa vai para debug_fulfillment (modulo 'ml-ads-roas').
// v6 (06/out/2026): modulo=anuncios -> ml_ads_anuncio_diario (ADS por MLB/dia via
//   product_ads/ads/search, so leitura). ?de=&ate= (default: ultimos 3 dias). Guarda so
//   anuncios com atividade no dia. Orcamento de tempo: so comeca dia novo ate 20 s, aborta em 27 s
//   (dia incompleto nao grava) e devolve parou_em — chamar de novo a partir dali.
// v5 (06/out/2026): modulo=diario grava TAMBEM ml_ads_campanha_diario (uma linha
//   por campanha/dia — base do Agente de ADS). Mesmas chamadas de leitura (o
//   diario ja buscava as campanhas de cada dia e so guardava a soma).
//   &so_campanha=1 -> grava SO a tabela por campanha (backfill sem regravar
//   ml_ads_diario de meses fechados, que alimenta DRE/Dashboard).
//   modulo=sonda-ads -> leitura pura de product_ads/ads/search (formato da API).
// v4 (31/ago): PINADO na conta Ottz (user_id 1107117809). Com a conta ML da SVL
//   conectada, "token mais recente" vira roleta — e as tabelas de ADS
//   (ml_ads_campanha/ml_ads_diario) nao tem coluna de conta. ADS multi-conta
//   fica para quando essas tabelas ganharem shop_id.
//
// Params (query OU body JSON):
//   date_from,date_to (YYYY-MM-DD)  OU  dias (default 30, max 90)
//   persist (default true; a aba consulta com persist=false, sem gravar)
// Endpoint migrado: /marketplace/advertising/{site}/advertisers/{id}/product_ads/
//   campaigns/search (Api-Version 2). Advertiser via /advertising/advertisers?product_id=PADS (v1).
//
// v3 (24/ago): modulo=diario -> tabela ml_ads_diario (serie POR DIA).
//   ?modulo=diario&de=YYYY-MM-DD&ate=YYYY-MM-DD  (default: ultimos 8 dias,
//   porque o ML REATRIBUI vendas retroativamente na janela de atribuicao).
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ML_API = "https://api.mercadolibre.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OTTZ_USER_ID = 1107117809;
const n = (v: any): number => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
function json(b: unknown, init?: ResponseInit) { return new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } }); }

// v7: campanhas liberadas para troca de ROAS objetivo (dono, 19/out) e prazo da rota
const ROAS_LIBERADO: Record<string, number> = { "359638251": 7 }; // Kit 2 Bumi l Escmectita: 6,5 -> 7
const ROAS_EXPIRA = "2026-10-21T03:00:00Z";

async function pegarTokenML(supabase: ReturnType<typeof createClient>) {
  // v4: conta FIXA (Ottz). Nunca "mais recente" — multi-conta no banco.
  const { data, error } = await supabase.from("oauth_tokens_ml")
    .select("access_token, user_id, expires_at").eq("user_id", OTTZ_USER_ID).limit(1).single();
  if (error || !data) throw new Error("Token ML (Ottz) nao encontrado");
  if (new Date(data.expires_at as string) < new Date()) throw new Error("Token ML expirado. Rode ml-refresh-token.");
  return data;
}
async function mlGet(path: string, token: string, apiver?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (apiver) headers["Api-Version"] = apiver;
  const resp = await fetch(`${ML_API}${path}`, { headers });
  const txt = await resp.text();
  let body: any; try { body = JSON.parse(txt); } catch { body = { _raw: txt.substring(0, 300) }; }
  return { status: resp.status, body };
}
async function mlPut(path: string, token: string, corpo: unknown, apiver?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
  if (apiver) headers["Api-Version"] = apiver;
  const resp = await fetch(`${ML_API}${path}`, { method: "PUT", headers, body: JSON.stringify(corpo) });
  const txt = await resp.text();
  let body: any; try { body = txt ? JSON.parse(txt) : null; } catch { body = { _raw: txt.substring(0, 300) }; }
  return { status: resp.status, body };
}

const METRICS = "clicks,prints,cost,cpc,acos,roas,units_quantity,direct_amount,indirect_amount,total_amount";

/** Todas as campanhas com metricas da janela [de..ate] (paginado). */
async function buscarCampanhas(
  token: string, site: string, advertiserId: number, de: string, ate: string,
): Promise<{ campanhas: any[]; erro: string | null }> {
  const out: any[] = [];
  let offset = 0; const limit = 50; let total = Infinity;
  while (offset < total && offset < 1000) {
    const path = `/marketplace/advertising/${site}/advertisers/${advertiserId}/product_ads/campaigns/search` +
      `?limit=${limit}&offset=${offset}&date_from=${de}&date_to=${ate}&metrics=${METRICS}`;
    const r = await mlGet(path, token, "2");
    if (r.status !== 200) {
      return { campanhas: out, erro: `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}` };
    }
    total = r.body?.paging?.total ?? 0;
    const results = r.body?.results || [];
    out.push(...results);
    offset += limit;
    if (results.length < limit) break;
  }
  return { campanhas: out, erro: null };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supabase = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const p = (k: string): string | null => url.searchParams.get(k) ?? (body?.[k] != null ? String(body[k]) : null);

  let tk: any;
  try { tk = await pegarTokenML(supabase); } catch (e) { return json({ erro: (e as Error).message }, { status: 401 }); }
  const token = tk.access_token as string;

  const adv = await mlGet("/advertising/advertisers?product_id=PADS", token, "1");
  const advertiser = adv.body?.advertisers?.[0];
  if (!advertiser) return json({ erro: "nenhum advertiser (permissao de Ads?)", adv: adv.body }, { status: 400 });
  const advertiserId = advertiser.advertiser_id;
  const site = advertiser.site_id || "MLB";

  const fmtSP = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

  // ------------------------------------------------------- modulo ROAS-ALVO (v7: escrita, so o liberado)
  if ((p("modulo") || "") === "roas-alvo") {
    if (Date.now() > Date.parse(ROAS_EXPIRA)) return json({ erro: "rota expirada" }, { status: 410 });
    const campanha = String(p("campanha") || "").replace(/\D/g, "");
    const roas = Number(String(p("roas") || "").replace(",", "."));
    if (!campanha || ROAS_LIBERADO[campanha] == null) return json({ erro: "campanha nao liberada", liberadas: ROAS_LIBERADO }, { status: 400 });
    if (roas !== ROAS_LIBERADO[campanha]) return json({ erro: `valor nao liberado (liberado: ${ROAS_LIBERADO[campanha]})` }, { status: 400 });
    const hoje = fmtSP(new Date());
    const ler = async () => {
      const { campanhas, erro } = await buscarCampanhas(token, site, advertiserId, hoje, hoje);
      const c = campanhas.find((x) => String(x.id) === campanha);
      return c ? { id: c.id, nome: c.name, status: c.status, strategy: c.strategy, roas_target: c.roas_target ?? null, acos_target: c.acos_target ?? null, budget: c.budget ?? null } : { erro: erro ?? "campanha nao encontrada" };
    };
    const antes: any = await ler();
    if (antes.erro) return json({ erro: `nao consegui ler a campanha: ${antes.erro}` }, { status: 400 });
    if (Number(antes.roas_target) === roas) return json({ ok: true, aviso: "a campanha ja esta com esse ROAS objetivo", antes });
    const acos = Math.round((100 / roas) * 100) / 100;
    // formatos, do mais provavel ao menos; so passa ao seguinte quando o ML recusa o formato (nada muda)
    const formatos: { path: string; ver: string; corpo: Record<string, unknown> }[] = [
      { path: `/marketplace/advertising/${site}/product_ads/campaigns/${campanha}`, ver: "2", corpo: { roas_target: roas } },
      { path: `/marketplace/advertising/${site}/product_ads/campaigns/${campanha}`, ver: "2", corpo: { acos_target: acos } },
      { path: `/marketplace/advertising/${site}/advertisers/${advertiserId}/product_ads/campaigns/${campanha}`, ver: "2", corpo: { roas_target: roas } },
      { path: `/advertising/product_ads/campaigns/${campanha}`, ver: "1", corpo: { acos_target: acos } },
      { path: `/advertising/product_ads/campaigns/${campanha}`, ver: "2", corpo: { roas_target: roas } },
    ];
    const tentativas: any[] = [];
    let aceito: any = null;
    for (const f of formatos) {
      const r = await mlPut(f.path, token, f.corpo, f.ver);
      const t = { path: f.path, api_version: f.ver, corpo: f.corpo, status: r.status, resposta: JSON.stringify(r.body ?? null).slice(0, 600) };
      tentativas.push(t);
      await supabase.from("debug_fulfillment").insert({ modulo: "ml-ads-roas", etapa: campanha, status_http: r.status, resultado: t });
      if (r.status >= 200 && r.status < 300) { aceito = t; break; }
      // 401 "User does not have permission to write" veio no 1o formato com o token JA com urn:ml:mktp:ads:/read-write:
      // os outros caminhos podem ter outra checagem, entao 401 tambem passa ao proximo; limite/erro do ML para.
      if (r.status === 429 || r.status >= 500) break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const depois = await ler();
    return json({ ok: !!aceito, campanha, pedido: { roas_target: roas, acos_equivalente: acos }, antes, depois, aceito, tentativas });
  }

  // ------------------------------------------------------- modulo CAMPANHA-ANUNCIOS (v8: leitura pura)
  // Anuncios de UMA campanha com as metricas do periodo, inclusive os sem impressao (o espelho
  // ml_ads_anuncio_diario so guarda quem teve atividade). Tenta o filtro da API; se ele for ignorado,
  // pagina tudo e filtra por campaign_id.
  if ((p("modulo") || "") === "campanha-anuncios") {
    const campanha = String(p("campanha") || "").replace(/\D/g, "");
    if (!campanha) return json({ erro: "informe campanha" }, { status: 400 });
    const hoje = fmtSP(new Date());
    const de = p("de") || fmtSP(new Date(Date.now() - 29 * 86400000));
    const ate = p("ate") || hoje;
    const base = `/marketplace/advertising/${site}/advertisers/${advertiserId}/product_ads/ads/search`;
    const inicio = Date.now();
    const out: any[] = [];
    let filtroOk = false, erro: string | null = null;
    for (const comFiltro of [true, false]) {
      out.length = 0;
      let offset = 0; const limit = 50; let total = Infinity;
      while (offset < total && offset < 5000 && Date.now() - inicio < 25000) {
        const q = `?limit=${limit}&offset=${offset}&date_from=${de}&date_to=${ate}&metrics=${METRICS}` +
          (comFiltro ? `&filters[campaign_id]=${campanha}` : "");
        const r = await mlGet(base + q, token, "2");
        if (r.status !== 200) { erro = `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`; break; }
        total = r.body?.paging?.total ?? 0;
        const res = r.body?.results || [];
        out.push(...res);
        offset += limit;
        if (res.length < limit) break;
      }
      if (comFiltro && !erro && out.length && out.every((a) => String(a.campaign_id) === campanha)) { filtroOk = true; break; }
      erro = null;
    }
    const anuncios = out.filter((a) => String(a.campaign_id) === campanha).map((a) => {
      const m = a.metrics || {};
      return {
        item_id: a.item_id, titulo: a.title ?? null, status: a.status ?? null, preco: a.price != null ? n(a.price) : null,
        catalogo: a.catalog_listing ?? null, logistica: a.logistic_type ?? null, foto: a.thumbnail ?? null, link: a.permalink ?? null,
        gasto: n(m.cost), cliques: Math.round(n(m.clicks)), impressoes: Math.round(n(m.prints)),
        vendas: n(m.total_amount), unidades: Math.round(n(m.units_quantity)),
        roas: n(m.cost) > 0 ? Math.round((n(m.total_amount) / n(m.cost)) * 100) / 100 : null,
      };
    }).sort((a, z) => z.gasto - a.gasto || z.impressoes - a.impressoes);
    return json({ campanha, de, ate, filtro_da_api: filtroOk, anuncios, erro, campos_do_anuncio: out[0] ? Object.keys(out[0]) : [] });
  }

  // ------------------------------------------------------- modulo SONDA-ADS (leitura pura, nao grava)
  if ((p("modulo") || "") === "sonda-ads") {
    const dia = p("dia") || fmtSP(new Date(Date.now() - 86400000));
    const path = `/marketplace/advertising/${site}/advertisers/${advertiserId}/product_ads/ads/search` +
      `?limit=5&offset=0&date_from=${dia}&date_to=${dia}&metrics=${METRICS}`;
    const r = await mlGet(path, token, "2");
    return json({ modulo: "sonda-ads", dia, status: r.status, paging: r.body?.paging ?? null, amostra: (r.body?.results ?? r.body) });
  }

  // ------------------------------------------------------- modulo ANUNCIOS (ADS por MLB/dia)
  if ((p("modulo") || "") === "anuncios") {
    const inicio = Date.now();
    const inicioIso = new Date(inicio - 1000).toISOString();
    const ate = p("ate") || fmtSP(new Date());
    let de = p("de");
    if (!de) { const d = new Date(); d.setDate(d.getDate() - 2); de = fmtSP(d); }
    const dias: string[] = [];
    for (let d = new Date(de + "T12:00:00Z"); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso > ate) break;
      dias.push(iso);
      if (dias.length > 95) break;
    }
    const erros: string[] = [];
    let gravadas = 0, diasOk = 0;
    let parou_em: string | null = null;
    for (const dia of dias) {
      if (Date.now() - inicio > 20000) { parou_em = dia; break; }
      const linhas: any[] = [];
      let offset = 0; const limit = 50; let total = Infinity; let falhou = false;
      while (offset < total && offset < 3000) {
        const r = await mlGet(`/marketplace/advertising/${site}/advertisers/${advertiserId}/product_ads/ads/search` +
          `?limit=${limit}&offset=${offset}&date_from=${dia}&date_to=${dia}&metrics=${METRICS}`, token, "2");
        if (r.status !== 200) { erros.push(`${dia}@${offset}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); falhou = true; break; }
        total = r.body?.paging?.total ?? 0;
        const res = r.body?.results || [];
        for (const a of res) {
          const m = a.metrics || {};
          if (n(m.prints) === 0 && n(m.clicks) === 0 && n(m.cost) === 0 && n(m.total_amount) === 0) continue;
          linhas.push({
            data: dia, item_id: a.item_id, campaign_id: a.campaign_id ?? null, ad_group_id: a.ad_group_id ?? null,
            shop_id: OTTZ_USER_ID, titulo: a.title ?? null, status: a.status ?? null, preco: a.price != null ? n(a.price) : null,
            catalog_listing: a.catalog_listing ?? null, logistic_type: a.logistic_type ?? null,
            gasto: n(m.cost), cliques: Math.round(n(m.clicks)), impressoes: Math.round(n(m.prints)),
            vendas_diretas: n(m.direct_amount), vendas_indiretas: n(m.indirect_amount), vendas_total: n(m.total_amount),
            unidades_diretas: Math.round(n(m.direct_units_quantity)), unidades: Math.round(n(m.units_quantity)),
            atualizado_em: new Date().toISOString(),
          });
        }
        offset += limit;
        if (res.length < limit) break;
        if (Date.now() - inicio > 27000) { falhou = true; erros.push(`${dia}: tempo esgotado no meio da paginacao`); break; }
      }
      if (falhou) { parou_em = dia; break; }   // dia incompleto: nao grava nem apaga (proxima rodada refaz)
      // o mesmo MLB pode vir em mais de um grupo/campanha no dia: soma (PK data+item)
      const porItem = new Map<string, any>();
      for (const l of linhas) {
        const x = porItem.get(l.item_id);
        if (!x) { porItem.set(l.item_id, { ...l }); continue; }
        for (const k of ["gasto", "cliques", "impressoes", "vendas_diretas", "vendas_indiretas", "vendas_total", "unidades_diretas", "unidades"]) x[k] += l[k];
        if (l.gasto > 0) x.campaign_id = l.campaign_id;
      }
      linhas.length = 0; linhas.push(...porItem.values());
      if (linhas.length) {
        const { error } = await supabase.from("ml_ads_anuncio_diario").upsert(linhas, { onConflict: "data,item_id" });
        if (error) { erros.push(`${dia}: upsert ${error.message}`); continue; }
        gravadas += linhas.length;
        // remove do dia quem nao veio nesta leitura (sem lista de ids na URL: centenas de MLBs estouram o tamanho)
        await supabase.from("ml_ads_anuncio_diario").delete().eq("data", dia).lt("atualizado_em", inicioIso);
      } else {
        await supabase.from("ml_ads_anuncio_diario").delete().eq("data", dia);
      }
      diasOk++;
    }
    return json({ modulo: "anuncios", de, ate, dias_pedidos: dias.length, dias_ok: diasOk, linhas_gravadas: gravadas, parou_em, erros: erros.slice(0, 6), tempo_ms: Date.now() - inicio });
  }

  // ------------------------------------------------------- modulo DIARIO
  if ((p("modulo") || "") === "diario") {
    const hojeSP = fmtSP(new Date());
    let de = p("de");
    const ate = p("ate") || hojeSP;
    if (!de) {
      const d = new Date(); d.setDate(d.getDate() - 7);
      de = fmtSP(d);
    }
    const soCampanha = p("so_campanha") === "1";

    const inicio = Date.now();
    const dias: string[] = [];
    for (let d = new Date(de + "T12:00:00Z"); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso > ate) break;
      dias.push(iso);
      if (dias.length > 120) break; // teto de sanidade
    }

    let gravados = 0, campanhasGravadas = 0;
    const erros: string[] = [];
    let parou_em: string | null = null;
    for (const dia of dias) {
      if (Date.now() - inicio > 45000) { parou_em = dia; break; }
      const { campanhas, erro } = await buscarCampanhas(token, site, advertiserId, dia, dia);
      if (erro) { erros.push(`${dia}: ${erro}`); if (erro.includes("429")) { parou_em = dia; break; } continue; }
      const linha = {
        data: dia,
        advertiser_id: advertiserId,
        gasto: 0, cliques: 0, impressoes: 0,
        vendas_diretas: 0, vendas_indiretas: 0, vendas_total: 0, unidades: 0,
        campanhas: 0,
        atualizado_em: new Date().toISOString(),
      };
      const porCampanha: any[] = [];
      for (const c of campanhas) {
        const m = c.metrics || {};
        if (n(m.cost) === 0 && n(m.clicks) === 0 && n(m.total_amount) === 0) continue;
        linha.gasto += n(m.cost);
        linha.cliques += Math.round(n(m.clicks));
        linha.impressoes += Math.round(n(m.prints));
        linha.vendas_diretas += n(m.direct_amount);
        linha.vendas_indiretas += n(m.indirect_amount);
        linha.vendas_total += n(m.total_amount);
        linha.unidades += Math.round(n(m.units_quantity));
        linha.campanhas++;
        porCampanha.push({
          data: dia, campaign_id: c.id, advertiser_id: advertiserId, shop_id: OTTZ_USER_ID,
          nome: c.name ?? null, status: c.status ?? null, strategy: c.strategy ?? null,
          acos_target: c.acos_target != null ? n(c.acos_target) : null,
          budget: c.budget != null ? n(c.budget) : null,
          gasto: n(m.cost), cliques: Math.round(n(m.clicks)), impressoes: Math.round(n(m.prints)),
          vendas_diretas: n(m.direct_amount), vendas_indiretas: n(m.indirect_amount), vendas_total: n(m.total_amount),
          unidades: Math.round(n(m.units_quantity)),
          atualizado_em: new Date().toISOString(),
        });
      }
      // por campanha: upsert do que veio + remove do dia quem deixou de ter atividade (reatribuicao)
      if (porCampanha.length) {
        const { error: eC } = await supabase.from("ml_ads_campanha_diario").upsert(porCampanha, { onConflict: "data,campaign_id" });
        if (eC) { erros.push(`${dia}: upsert campanha ${eC.message}`); continue; }
        campanhasGravadas += porCampanha.length;
        const ids = porCampanha.map((x) => x.campaign_id).join(",");
        await supabase.from("ml_ads_campanha_diario").delete().eq("data", dia).not("campaign_id", "in", `(${ids})`);
      } else {
        await supabase.from("ml_ads_campanha_diario").delete().eq("data", dia);
      }
      if (!soCampanha) {
        const { error } = await supabase.from("ml_ads_diario").upsert(linha, { onConflict: "data" });
        if (error) erros.push(`${dia}: upsert ${error.message}`);
        else gravados++;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return json({
      modulo: "diario", de, ate, so_campanha: soCampanha,
      dias_pedidos: dias.length, dias_gravados: gravados, campanhas_dia_gravadas: campanhasGravadas,
      parou_em,
      erros: erros.slice(0, 6),
      tempo_ms: Date.now() - inicio,
    });
  }

  // -------------------------------------------------- modulo padrao (janela)
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  let dateFrom = p("date_from");
  let dateTo = p("date_to");
  if (!dateFrom || !dateTo) {
    const dias = Math.min(parseInt(p("dias") || "30", 10), 90);
    const hoje = new Date();
    dateFrom = fmt(new Date(hoje.getTime() - dias * 86400000));
    dateTo = fmt(hoje);
  }
  const persist = p("persist") !== "false" && p("persist") !== "0";

  const { campanhas, erro: erroBusca } = await buscarCampanhas(token, site, advertiserId, dateFrom, dateTo);
  const erros: string[] = erroBusca ? [erroBusca] : [];
  const linhas: any[] = campanhas.map((c) => {
    const m = c.metrics || {};
    return {
      campaign_id: c.id, advertiser_id: advertiserId, site_id: site,
      nome: c.name ?? null, status: c.status ?? null, strategy: c.strategy ?? null,
      acos_target: c.acos_target != null ? n(c.acos_target) : null,
      roas_target: c.roas_target != null ? n(c.roas_target) : null,
      budget: c.budget != null ? n(c.budget) : null,
      cliques: Math.round(n(m.clicks)), impressoes: Math.round(n(m.prints)),
      gasto: n(m.cost), cpc: n(m.cpc),
      vendas_diretas: n(m.direct_amount), vendas_indiretas: n(m.indirect_amount), vendas_total: n(m.total_amount),
      unidades: Math.round(n(m.units_quantity)), acos: n(m.acos), roas: n(m.roas),
      janela_de: dateFrom, janela_ate: dateTo, atualizado_em: new Date().toISOString(),
    };
  });

  let gravadas = 0;
  if (persist && linhas.length) {
    const { error } = await supabase.from("ml_ads_campanha").upsert(linhas, { onConflict: "campaign_id" });
    if (error) return json({ erro: `upsert: ${error.message}`, lidas: linhas.length }, { status: 500 });
    gravadas = linhas.length;
  }

  const totGasto = linhas.reduce((s, l) => s + (l.gasto || 0), 0);
  const totVendas = linhas.reduce((s, l) => s + (l.vendas_total || 0), 0);
  return json({
    ok: true, advertiser_id: advertiserId, site, janela: { de: dateFrom, ate: dateTo },
    campanhas: linhas.length, gravadas, persist,
    gasto_total: Math.round(totGasto * 100) / 100, vendas_total: Math.round(totVendas * 100) / 100,
    roas_geral: totGasto > 0 ? Math.round((totVendas / totGasto) * 100) / 100 : null,
    lista: linhas, erros,
  });
});
