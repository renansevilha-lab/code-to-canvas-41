// v5 (20/out/2026, pedido do dono): ?modulo=palavras&loja=&item_id=[&termo=] — palavras-chave que a Shopee Ads sugere
//   para o anúncio (ads/get_recommended_keyword_list: termo, volume de busca, qualidade, lance sugerido). Só leitura.
//   ?modulo=palavras-sku&loja=&sku= — o mesmo para todos os anúncios do produto na loja (até 4), gravado em
//   shopee_palavras (base de ia_termos_busca, os termos de busca do gerador de títulos).
// v4 (20/out/2026): ?modulo=historico-desempenho&loja=&de=YYYY-MM-DD&ate=YYYY-MM-DD[&loja_total=1] — busca para trás (até 6 meses, 1 mês por vez).
// v3 (20/out/2026, opção A do dono — histórico de configuração): ?modulo=capturar&loja=ottz|svl|todas lê TODAS as
//   campanhas da loja e grava em ads_config_atual / ads_config_historico (RPC ads_config_registrar; cron a cada 2 h);
//   `editar` registra a troca com origem 'app' e o nome de quem alterou; ?modulo=desempenho-cru&loja=&campanha=&de=&ate=
//   devolve get_product_campaign_daily_performance cru (diagnóstico: quais campos vêm por dia).
// Edge Function: shopee-ads-gestao v2 (20/out/2026) — Shopee Ads: meta de ROAS, orçamento e "impulsionar".
//
// ⚠ PUBLICADA NO SLOT `shopee-flashsale-probe` — o projeto chegou ao limite de funções do plano e criar uma
// nova dá "Max number of functions reached". O slot era uma sonda de agosto sem uso (sem cron, sem front).
//
// Pedido do dono (20/out): mostrar na tela de ADS da Shopee a meta de ROAS de cada anúncio, se ele está
// impulsionado, e poder ALTERAR meta de ROAS e orçamento pelo sistema.
// Função separada da `shopee-sync-ads` de propósito (aquela imprime etiquetas — CLAUDE.md §2.1.5/§10).
//
// O que a API dá (conferido 20/out nas duas lojas):
//   ads/get_product_level_campaign_setting_info (info_type_list 1,2,3,4) → common_info (ad_type, bidding_method,
//     campaign_status, campaign_budget, item_id_list) e auto_bidding_info.roas_target (campanha "manual" com lance
//     automático = a meta de ROAS do Seller Center). Lote de até 50 campanhas.
//   product/get_boosted_list → anúncios impulsionados AGORA (item_list[].item_id, cool_down_second).
//   ads/get_total_balance, ads/get_shop_toggle_info → saldo e recarga automática.
//   ads/edit_manual_product_ads (POST, documentado) → reference_id (aleatório, evita duplicar), campaign_id,
//     edit_action "change_budget" (+budget) ou "change_roas_target" (+roas_target). A doc não tem
//     edit_auto_product_ads (campanha ad_type "auto" não é editável aqui).
//
// Módulos:
//   ?modulo=sonda&loja=ottz|svl[&campanhas=id,id][&n=10]  → respostas cruas (diagnóstico, só leitura)
//   POST {modulo:"config", loja, campanhas:[ids]}          → por campanha: meta de ROAS, orçamento, lance, status;
//                                                             + impulsionados + saldo (só leitura)
//   POST {modulo:"editar", loja, campaign_id, budget?, roas_target?, confirmar?}
//     sem confirmar = prévia (lê a campanha ao vivo e diz o que muda); com confirmar exige LOGIN de usuário
//     (chave publicável = 401), manda cada troca UMA vez (sem repetição), relê e grava em debug_fulfillment
//     (modulo 'shopee-ads-editar', etapa = campaign_id).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(b: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOJAS: Record<string, number> = { ottz: 522186766, svl: 759046323 };

function getCredentials(partnerId: number | string): { partner_id: number; partner_key: string } {
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

async function signedUrl(ctx: Ctx, apiPath: string): Promise<URL> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = await hmacSha256(`${ctx.partnerId}${apiPath}${timestamp}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey);
  const url = new URL(`${SHOPEE_HOST}${apiPath}`);
  url.searchParams.set("partner_id", String(ctx.partnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", ctx.accessToken);
  url.searchParams.set("shop_id", String(ctx.shopId));
  url.searchParams.set("sign", sign);
  return url;
}

async function shopeeGet(ctx: Ctx, apiPath: string, params: Record<string, unknown> = {}): Promise<any> {
  const url = await signedUrl(ctx, apiPath);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const resp = await fetch(url.toString());
  const txt = await resp.text();
  try { return { http: resp.status, ...JSON.parse(txt) }; } catch { return { http: resp.status, _raw: txt.substring(0, 500) }; }
}

/** POST sem repetição: escrita no marketplace vai UMA vez. */
async function shopeePost(ctx: Ctx, apiPath: string, body: Record<string, unknown>): Promise<any> {
  const url = await signedUrl(ctx, apiPath);
  const resp = await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const txt = await resp.text();
  try { return { http: resp.status, ...JSON.parse(txt) }; } catch { return { http: resp.status, _raw: txt.substring(0, 500) }; }
}

// deno-lint-ignore no-explicit-any
async function pegarCtx(supabase: any, shopId: number): Promise<Ctx> {
  const { data, error } = await supabase.from("oauth_tokens_shopee")
    .select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`Token nao encontrado pra shop_id ${shopId}`);
  if (new Date(data.expires_at) < new Date()) throw new Error(`Token shop_id ${shopId} expirado. Roda shopee-refresh-token.`);
  const creds = getCredentials(data.partner_id);
  if (!creds.partner_key) throw new Error(`Partner key vazia pra partner_id ${creds.partner_id}`);
  return { shopId, partnerId: creds.partner_id, partnerKey: creds.partner_key, accessToken: data.access_token };
}

interface Config {
  campaign_id: string; ad_type: string | null; bidding_method: string | null; status: string | null;
  budget: number | null; roas_target: number | null; item_id: string | null; nome: string | null;
}

async function lerConfig(ctx: Ctx, ids: string[]): Promise<{ lista: Config[]; erros: string[] }> {
  const lista: Config[] = []; const erros: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const lote = ids.slice(i, i + 50);
    const r = await shopeeGet(ctx, "/api/v2/ads/get_product_level_campaign_setting_info", { info_type_list: "1,3", campaign_id_list: lote.join(",") });
    if (r.error) { erros.push(`${r.error}: ${r.message ?? ""}`); continue; }
    for (const c of (r.response?.campaign_list ?? []) as any[]) {
      const ci = c.common_info ?? {};
      lista.push({
        campaign_id: String(c.campaign_id), ad_type: ci.ad_type ?? null, bidding_method: ci.bidding_method ?? null,
        status: ci.campaign_status ?? null, budget: ci.campaign_budget ?? null,
        roas_target: c.auto_bidding_info?.roas_target ?? null,
        item_id: (ci.item_id_list ?? [])[0] != null ? String(ci.item_id_list[0]) : null, nome: ci.ad_name ?? null,
      });
    }
    if (i + 50 < ids.length) await sleep(250);
  }
  return { lista, erros };
}

/** O que muda e se a campanha aceita (só "manual"; meta de ROAS só com lance automático). */
function planejar(c: Config, budget: number | null, roas: number | null) {
  const pend: string[] = []; const trocas: { acao: string; campo: string; de: number | null; para: number }[] = [];
  if (c.ad_type !== "manual") pend.push(`campanha do tipo "${c.ad_type}" — a API só edita campanhas de anúncio de produto (tipo manual)`);
  if (budget != null) {
    if (!(budget > 0)) pend.push("orçamento precisa ser maior que zero");
    else if (Number(c.budget) !== budget) trocas.push({ acao: "change_budget", campo: "budget", de: c.budget, para: budget });
  }
  if (roas != null) {
    if (c.bidding_method !== "auto") pend.push("a meta de ROAS só existe em campanha com lance automático");
    else if (!(roas > 0)) pend.push("meta de ROAS precisa ser maior que zero");
    else if (Number(c.roas_target) !== roas) trocas.push({ acao: "change_roas_target", campo: "roas_target", de: c.roas_target, para: roas });
  }
  if (!pend.length && !trocas.length) pend.push("nada muda: os valores são iguais aos de hoje");
  return { pend, trocas };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let b: any = {};
  if (req.method === "POST") { try { b = await req.json(); } catch { b = {}; } }
  const p = (k: string) => url.searchParams.get(k) ?? (b?.[k] != null ? String(b[k]) : null);
  const modulo = p("modulo") || "sonda";
  const loja = p("loja") || "ottz";
  const supabase = createClient(SUPABASE_URL, SRK);

  // captura da configuração de todas as campanhas (uma loja ou as duas)
  if (modulo === "capturar") {
    const lojas = loja === "todas" ? Object.keys(LOJAS) : [loja];
    const saida: Record<string, unknown> = {};
    for (const l of lojas) {
      const sid = LOJAS[l];
      if (!sid) { saida[l] = { erro: "loja invalida" }; continue; }
      try {
        const c = await pegarCtx(supabase, sid);
        const ids: string[] = []; let offset = 0; let segue = true; const erros: string[] = [];
        while (segue && offset < 3000) {
          const r = await shopeeGet(c, "/api/v2/ads/get_product_level_campaign_id_list", { ad_type: "all", offset, limit: 100 });
          if (r.error) { erros.push(`lista: ${r.error} ${r.message ?? ""}`); break; }
          for (const x of (r.response?.campaign_list ?? []) as any[]) ids.push(String(x.campaign_id));
          segue = !!r.response?.has_next_page; offset += 100;
          if (segue) await sleep(200);
        }
        const { lista, erros: e2 } = await lerConfig(c, ids);
        erros.push(...e2);
        // lista vazia por erro de leitura não é gravada (não confunde "não li" com "sumiu")
        const { data: reg, error: errReg } = lista.length
          ? await supabase.rpc("ads_config_registrar", { p_mkt: "shopee", p_shop: sid, p_lista: lista, p_origem: "externo", p_quem: null })
          : { data: null, error: null };
        if (errReg) erros.push(`registrar: ${errReg.message}`);
        saida[l] = { campanhas: ids.length, lidas: lista.length, registro: reg, erros };
      } catch (e) { saida[l] = { erro: (e as Error).message }; }
    }
    return json({ ok: true, modulo, lojas: saida });
  }

  const shopId = LOJAS[loja];
  if (!shopId) return json({ ok: false, erro: "loja: ottz | svl" }, { status: 400 });

  try {
    const ctx = await pegarCtx(supabase, shopId);

    if (modulo === "sonda") {
      let ids = (p("campanhas") || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!ids.length) {
        const n = Math.min(Number(p("n")) || 10, 50);
        const desde = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const { data } = await supabase.from("shopee_ads_campanha").select("campaign_id, gasto").eq("shop_id", shopId).gte("data", desde);
        const soma = new Map<string, number>();
        for (const r of (data ?? []) as { campaign_id: number; gasto: number }[]) soma.set(String(r.campaign_id), (soma.get(String(r.campaign_id)) ?? 0) + Number(r.gasto ?? 0));
        ids = [...soma.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, n).map(([id]) => id);
      }
      const setting = await shopeeGet(ctx, "/api/v2/ads/get_product_level_campaign_setting_info", { info_type_list: "1,2,3,4", campaign_id_list: ids.join(",") });
      await sleep(300);
      const boosted = await shopeeGet(ctx, "/api/v2/product/get_boosted_list");
      await sleep(300);
      const saldo = await shopeeGet(ctx, "/api/v2/ads/get_total_balance");
      await sleep(300);
      const toggle = await shopeeGet(ctx, "/api/v2/ads/get_shop_toggle_info");
      return json({ ok: true, loja, shop_id: shopId, campanhas: ids, setting, boosted, saldo, toggle });
    }

    // v4 (20/out/2026, pedido do dono): histórico de desempenho para trás. A Shopee guarda até 6 meses e aceita no
    // máximo 1 mês por consulta (erros ads.performance.error_date_too_old / error_date_range_too_long).
    // Grava em shopee_ads_campanha SEM sobrescrever o que já existe (ignoreDuplicates) e com orçamento/status em
    // branco (o valor de hoje não é o daquela época). &loja_total=1 também grava o total da loja em shopee_ads_diario
    // (que alimenta o ADS do DRE e do Dashboard).
    if (modulo === "historico-desempenho") {
      const de = String(p("de") ?? ""), ate = String(p("ate") ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return json({ ok: false, erro: "de/ate em YYYY-MM-DD" }, { status: 400 });
      const dias = (Date.parse(ate) - Date.parse(de)) / 86400000;
      if (!(dias >= 1 && dias <= 30)) return json({ ok: false, erro: "intervalo de 2 a 31 dias (a Shopee aceita até 1 mês por consulta)" }, { status: 400 });
      const br = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
      const iso = (d: string) => { const [dd, mm, yyyy] = String(d ?? "").split("-"); return `${yyyy}-${mm}-${dd}`; };
      const empresa = shopId === 522186766 ? "Ottz Pet" : "SVL Store";
      const erros: string[] = [];
      // o PostgREST devolve no máximo 1.000 linhas por leitura (a Ottz tem 1.100+ campanhas): pagina
      const cfgs: { campaign_id: string; item_id: string | null }[] = [];
      for (let o = 0; o < 20000; o += 1000) {
        const { data, error: eCfg } = await supabase.from("ads_config_atual").select("campaign_id, item_id")
          .eq("mkt", "shopee").eq("shop_id", shopId).order("campaign_id").range(o, o + 999);
        if (eCfg) return json({ ok: false, erro: `ads_config_atual: ${eCfg.message}` }, { status: 500 });
        cfgs.push(...((data ?? []) as typeof cfgs));
        if ((data ?? []).length < 1000) break;
      }
      const itemDe = new Map(cfgs.map((c) => [c.campaign_id, c.item_id]));
      const ids = [...itemDe.keys()];
      const registros: Record<string, unknown>[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        let lote = ids.slice(i, i + 100);
        let r = await shopeeGet(ctx, "/api/v2/ads/get_product_campaign_daily_performance",
          { start_date: br(de), end_date: br(ate), campaign_id_list: lote.join(",") });
        // campanha que não é de anúncio de produto (ex.: anúncio da loja) derruba o lote inteiro: tira e refaz uma vez
        const invalidos = String(r.message ?? "").match(/invalid product ads campaign ids-\s*([\d,\s]+)/i)?.[1]
          ?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        if (r.error && invalidos.length) {
          lote = lote.filter((id) => !invalidos.includes(id));
          await sleep(300);
          r = await shopeeGet(ctx, "/api/v2/ads/get_product_campaign_daily_performance",
            { start_date: br(de), end_date: br(ate), campaign_id_list: lote.join(",") });
        }
        if (r.error) { erros.push(`campanhas ${i}: ${r.error} ${r.message ?? ""}`); continue; }
        for (const c of (r.response?.campaign_list ?? []) as any[]) {
          for (const m of (c.metrics_list ?? []) as any[]) {
            if (!((m.impression ?? 0) > 0 || (m.expense ?? 0) > 0)) continue;
            registros.push({
              campaign_id: c.campaign_id, shop_id: shopId, data: iso(m.date), empresa,
              ad_name: c.ad_name ?? null, ad_type: c.ad_type ?? null, status: null, placement: c.campaign_placement ?? null,
              budget: null, item_id: itemDe.get(String(c.campaign_id)) ?? null,
              impressoes: m.impression ?? 0, cliques: m.clicks ?? 0, ctr: m.ctr ?? 0, gasto: m.expense ?? 0,
              gmv_direto: m.direct_gmv ?? 0, gmv_amplo: m.broad_gmv ?? 0, pedidos_direto: m.direct_order ?? 0, pedidos_amplo: m.broad_order ?? 0,
              roi_direto: m.direct_roi ?? 0, roi_amplo: m.broad_roi ?? 0, cir_direto: m.direct_cir ?? 0, cir_amplo: m.broad_cir ?? 0,
              cpc: m.cpc ?? 0, cr: m.cr ?? 0, atualizado_em: new Date().toISOString(),
            });
          }
        }
        await sleep(300);
      }
      let gravados = 0;
      for (let i = 0; i < registros.length; i += 500) {
        const { error } = await supabase.from("shopee_ads_campanha").upsert(registros.slice(i, i + 500), { onConflict: "shop_id,campaign_id,data", ignoreDuplicates: true });
        if (error) erros.push(`gravar campanhas: ${error.message.slice(0, 120)}`); else gravados += Math.min(500, registros.length - i);
      }
      let loja_dias = null as number | null;
      if (p("loja_total") === "1") {
        const r = await shopeeGet(ctx, "/api/v2/ads/get_all_cpc_ads_daily_performance", { start_date: br(de), end_date: br(ate) });
        if (r.error) erros.push(`loja: ${r.error} ${r.message ?? ""}`);
        else {
          const linhas = ((r.response ?? []) as any[]).map((d) => ({
            shop_id: shopId, empresa, data: iso(d.date), impressoes: d.impression ?? 0, cliques: d.clicks ?? 0, ctr: d.ctr ?? 0,
            gasto: d.expense ?? 0, gmv_direto: d.direct_gmv ?? 0, gmv_amplo: d.broad_gmv ?? 0, roas_direto: d.direct_roas ?? 0,
            roas_amplo: d.broad_roas ?? 0, pedidos_diretos: d.direct_order ?? 0, pedidos_amplos: d.broad_order ?? 0,
            itens_vendidos_direto: d.direct_item_sold ?? 0, custo_por_conversao: d.cost_per_conversion ?? 0, atualizado_em: new Date().toISOString(),
          }));
          const { error } = linhas.length ? await supabase.from("shopee_ads_diario").upsert(linhas, { onConflict: "shop_id,data", ignoreDuplicates: true }) : { error: null };
          if (error) erros.push(`gravar loja: ${error.message.slice(0, 120)}`); else loja_dias = linhas.length;
        }
      }
      const datas = registros.map((x) => String(x.data)).sort();
      return json({ ok: !erros.length, loja, de, ate, campanhas_consultadas: ids.length, linhas: registros.length, enviados: gravados,
        primeiro_dia: datas[0] ?? null, ultimo_dia: datas[datas.length - 1] ?? null, loja_dias, erros });
    }

    // v5: palavras-chave sugeridas pela Shopee Ads para um anúncio (com volume de busca). Só leitura.
    if (modulo === "palavras") {
      const itemId = String(p("item_id") ?? "");
      if (!/^\d+$/.test(itemId)) return json({ ok: false, erro: "informe item_id" }, { status: 400 });
      const termo = (p("termo") ?? "").trim();
      const r = await shopeeGet(ctx, "/api/v2/ads/get_recommended_keyword_list", { item_id: itemId, input_keyword: termo || undefined });
      if (r.error) return json({ ok: false, erro: `${r.error}: ${r.message ?? ""}`, resposta: r });
      const lista = ((r.response?.suggested_keyword_list ?? r.response?.suggested_keywords ?? []) as any[]).map((k) => ({
        termo: String(k.keyword ?? ""), volume: k.search_volume ?? null, qualidade: k.quality_score ?? null, lance: k.suggested_bid ?? null,
      })).sort((a, z) => Number(z.volume ?? 0) - Number(a.volume ?? 0));
      return json({ ok: true, loja, item_id: itemId, termo: termo || null, total: lista.length, palavras: lista, cru: p("cru") === "1" ? r : undefined });
    }

    // v5: palavras de TODOS os anúncios de um produto nesta loja (o próprio SKU, as variações e o componente do kit),
    // gravadas em shopee_palavras — base dos termos de busca do gerador de títulos (ia_termos_busca). Só lê a Shopee.
    if (modulo === "palavras-sku") {
      const sku = String(p("sku") ?? "").trim();
      if (!sku) return json({ ok: false, erro: "informe sku" }, { status: 400 });
      const [{ data: filhos }, { data: comps }] = await Promise.all([
        supabase.from("produtos").select("sku").eq("sku_pai", sku).eq("ativo", true),
        supabase.from("produto_kits").select("sku_componente").eq("sku_kit", sku),
      ]);
      const skus = [...new Set([sku, ...((filhos ?? []) as any[]).map((x) => String(x.sku)), ...((comps ?? []) as any[]).map((x) => String(x.sku_componente))])];
      const [{ data: a1 }, { data: a2 }] = await Promise.all([
        supabase.from("shopee_anuncios").select("item_id").eq("shop_id", shopId).eq("status", "NORMAL").in("sku_pai", skus).limit(20),
        supabase.from("shopee_anuncios_variacao").select("item_id").eq("shop_id", shopId).in("sku", skus).limit(50),
      ]);
      const itens = [...new Set([...((a1 ?? []) as any[]), ...((a2 ?? []) as any[])].map((x) => String(x.item_id)))].slice(0, 4);
      const erros: string[] = []; let gravadas = 0;
      for (const it of itens) {
        const r = await shopeeGet(ctx, "/api/v2/ads/get_recommended_keyword_list", { item_id: it });
        if (r.error) { erros.push(`${it}: ${r.error} ${r.message ?? ""}`); continue; }
        const vistos = new Set<string>();
        const linhas = ((r.response?.suggested_keyword_list ?? []) as any[])
          .map((k) => ({ shop_id: shopId, item_id: Number(it), termo: String(k.keyword ?? "").trim().toLowerCase(), volume: k.search_volume ?? null,
            qualidade: k.quality_score ?? null, lance: k.suggested_bid ?? null, coletado_em: new Date().toISOString() }))
          .filter((x) => x.termo && !vistos.has(x.termo) && vistos.add(x.termo));
        if (linhas.length) {
          const { error } = await supabase.from("shopee_palavras").upsert(linhas, { onConflict: "shop_id,item_id,termo" });
          if (error) erros.push(`${it}: gravar ${error.message}`); else gravadas += linhas.length;
        }
        await sleep(300);
      }
      return json({ ok: !erros.length, loja, sku, skus, anuncios: itens, gravadas, erros });
    }

    if (modulo === "desempenho-cru") {
      const camp = String(p("campanha") ?? "");
      const de = String(p("de") ?? ""); const ate = String(p("ate") ?? de); // DD-MM-YYYY
      const r = await shopeeGet(ctx, "/api/v2/ads/get_product_campaign_daily_performance", { start_date: de, end_date: ate, campaign_id_list: camp });
      return json({ ok: !r.error, resposta: r });
    }

    if (modulo === "config") {
      const ids = (Array.isArray(b.campanhas) ? b.campanhas : String(p("campanhas") ?? "").split(","))
        .map((x: unknown) => String(x).trim()).filter((x: string) => /^\d+$/.test(x)).slice(0, 300);
      const { lista, erros } = ids.length ? await lerConfig(ctx, ids) : { lista: [], erros: [] };
      const boosted = await shopeeGet(ctx, "/api/v2/product/get_boosted_list");
      if (boosted.error) erros.push(`impulsionados: ${boosted.error} ${boosted.message ?? ""}`);
      const saldo = await shopeeGet(ctx, "/api/v2/ads/get_total_balance");
      const toggle = await shopeeGet(ctx, "/api/v2/ads/get_shop_toggle_info");
      return json({
        ok: true, loja, shop_id: shopId, campanhas: lista,
        impulsionados: ((boosted.response?.item_list ?? []) as any[]).map((x) => ({ item_id: String(x.item_id), cool_down_second: x.cool_down_second ?? null })),
        saldo: saldo.response?.total_balance ?? null, recarga_automatica: toggle.response?.auto_top_up ?? null,
        erros,
      });
    }

    if (modulo === "editar") {
      const campaignId = String(p("campaign_id") ?? "");
      if (!/^\d+$/.test(campaignId)) return json({ ok: false, erro: "informe campaign_id" }, { status: 400 });
      const budget = p("budget") != null && p("budget") !== "" ? Number(String(p("budget")).replace(",", ".")) : null;
      const roas = p("roas_target") != null && p("roas_target") !== "" ? Number(String(p("roas_target")).replace(",", ".")) : null;
      const confirmar = p("confirmar") === "1" || p("confirmar") === "true";
      const { lista, erros } = await lerConfig(ctx, [campaignId]);
      const atual = lista[0];
      if (!atual) return json({ ok: false, erro: `campanha ${campaignId} não encontrada nesta loja ${erros.join("; ")}` }, { status: 404 });
      const { pend, trocas } = planejar(atual, budget, roas);
      if (!confirmar || pend.length) return json({ ok: !pend.length, previa: true, atual, trocas, pendencias: pend });

      // escrita: só com login de usuário
      const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u } = await supabase.auth.getUser(jwt);
      if (!u?.user) return json({ ok: false, erro: "alterar a campanha exige login de usuário" }, { status: 401 });
      const quem = String(u.user.user_metadata?.nome ?? u.user.email ?? u.user.id);

      const resultados: any[] = [];
      for (const t of trocas) {
        const corpo = { reference_id: crypto.randomUUID(), campaign_id: Number(campaignId), edit_action: t.acao, [t.campo]: t.para };
        const r = await shopeePost(ctx, "/api/v2/ads/edit_manual_product_ads", corpo);
        const ok = !r.error;
        resultados.push({ ...t, ok, erro: r.error || null, mensagem: r.message || null, resposta: r.response ?? null });
        await supabase.from("debug_fulfillment").insert({
          modulo: "shopee-ads-editar", etapa: campaignId, status_http: r.http ?? null,
          resultado: { loja, quem, enviado: corpo, de: t.de, resposta: r },
        });
        if (!ok) break; // para no primeiro recusado
        await sleep(400);
      }
      await sleep(800);
      const depois = (await lerConfig(ctx, [campaignId])).lista[0] ?? null;
      // histórico: a troca feita pelo app fica com origem 'app' e o nome de quem alterou
      if (depois) await supabase.rpc("ads_config_registrar", { p_mkt: "shopee", p_shop: shopId, p_lista: [depois], p_origem: "app", p_quem: quem });
      return json({ ok: resultados.length > 0 && resultados.every((x) => x.ok), atual, depois, resultados, quem });
    }

    return json({ ok: false, erro: `modulo desconhecido: ${modulo}` }, { status: 400 });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, { status: 500 });
  }
});
