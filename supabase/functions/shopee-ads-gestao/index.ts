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
  const shopId = LOJAS[loja];
  if (!shopId) return json({ ok: false, erro: "loja: ottz | svl" }, { status: 400 });
  const supabase = createClient(SUPABASE_URL, SRK);

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
      return json({ ok: resultados.length > 0 && resultados.every((x) => x.ok), atual, depois, resultados, quem });
    }

    return json({ ok: false, erro: `modulo desconhecido: ${modulo}` }, { status: 400 });
  } catch (e) {
    return json({ ok: false, erro: (e as Error).message }, { status: 500 });
  }
});
