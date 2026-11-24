// ============================================================================
// Edge Function: shopee-vendas-historico v2 (24/nov/2026) — só LÊ na Shopee
// ----------------------------------------------------------------------------
// Pedido do dono: histórico de faturamento de ANTES do Tiny. A conta Ottz só existe no Tiny
// desde 01/01/2025; a loja Ottz da Shopee devolve pedidos pela API desde 2021 (testado: jun/2021
// vazio, dez/2021 já com pedido). Lê os pedidos por dia de CRIAÇÃO e grava só os TOTAIS por
// loja × dia × situação em `shopee_vendas_dia` (nada de cliente nem de pedido).
// Dois valores por pedido: `valor` = total_amount (o que o comprador pagou, com frete) e `valor_itens` =
// soma de preço com desconto × quantidade dos itens (só produtos). Conferido em 28–31/01/2025 contra o Tiny:
// a quantidade de pedidos e de cancelados bate exatamente; o valor que casa com o Tiny está no cabeçalho da view.
// v2: até 4 dias lidos ao mesmo tempo no período de muito movimento (a v1 lia 4 dias por rodada de 40 s).
//
//   ?modulo=status                          → dias lidos/faltando
//   ?modulo=rodar[&loja=ottz]               → lê os próximos dias pendentes, do mais NOVO para o mais antigo
//   ?modulo=sonda&loja=ottz|svl&de=YYYY-MM-DD[&dias=15] → olhar um período sem gravar
//
// Como lê: primeiro tenta o bloco de até 15 dias pendentes numa chamada (get_order_list aceita no
// máximo 15 dias); se coube em uma página (período de pouco movimento ou vazio), fecha os 15 dias de
// uma vez. Senão passa a ler dia a dia até o fim da rodada. Detalhe (get_order_detail) de 50 em 50,
// 3 em paralelo. Um bloco só é gravado quando TODOS os pedidos dele vieram com detalhe.
// A loja SVL/Bumi fica de fora da carga: ela já está no Tiny da SVL desde jun/2022 (conferido em
// 25/11/2024: 99 pedidos na Shopee = 99 no Tiny).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const LOJAS: Record<string, number> = { ottz: 522186766, svl: 759046323 };
/** o que a carga busca: até 31/01/2025 para sobrar um mês de conferência com o Tiny */
const ALVO: Record<string, { de: string; ate: string }> = { ottz: { de: "2020-01-01", ate: "2025-01-31" } };
const ORCAMENTO_MS = 40_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const somaDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const inicioBRT = (d: string) => Math.floor(Date.parse(`${d}T00:00:00-03:00`) / 1000);
const diaBRT = (seg: number) => new Date((seg - 3 * 3600) * 1000).toISOString().slice(0, 10);

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
  const { data, error } = await db.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`token da Shopee não encontrado para a loja ${shopId}`);
  const cr = credShopee(data.partner_id as number);
  return { shopId: Number(data.shop_id), partnerId: cr.partner_id, partnerKey: cr.partner_key, token: data.access_token as string };
}
async function sGet(c: Ctx, path: string, params: Record<string, string>): Promise<any> {
  for (let i = 0; ; i++) {
    const ts = Math.floor(Date.now() / 1000);
    const url = new URL(`${SHOPEE_HOST}${path}`);
    url.searchParams.set("partner_id", String(c.partnerId));
    url.searchParams.set("timestamp", String(ts));
    url.searchParams.set("access_token", c.token);
    url.searchParams.set("shop_id", String(c.shopId));
    url.searchParams.set("sign", await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}${c.token}${c.shopId}`));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let body: any;
    try { const r = await fetch(url.toString()); const txt = await r.text(); try { body = JSON.parse(txt); } catch { body = { error: "resposta_nao_json", message: txt.slice(0, 200) }; } }
    catch (e) { body = { error: "rede", message: String((e as Error)?.message ?? e) }; }
    // leitura: repetir é seguro. Só o que é passageiro (limite de chamadas, servidor, rede).
    if (body?.error && /rate|limit|server|rede|nao_json|timeout/i.test(String(body.error)) && i < 2) { await pausa(1500 * (i + 1)); continue; }
    return body;
  }
}

/** order_sn dos pedidos CRIADOS de `de` a `ate` (dias de Brasília, no máximo 15). */
async function listar(c: Ctx, de: string, ate: string, maxPaginas: number, prazo: number): Promise<{ sns: string[]; mais: boolean; erro?: string }> {
  const sns: string[] = []; let cursor = "";
  for (let p = 0; p < maxPaginas; p++) {
    if (Date.now() > prazo) return { sns, mais: true, erro: "tempo" };
    const r = await sGet(c, "/api/v2/order/get_order_list", {
      time_range_field: "create_time", time_from: String(inicioBRT(de)), time_to: String(inicioBRT(somaDias(ate, 1)) - 1),
      page_size: "100", cursor, response_optional_fields: "order_status",
    });
    if (r?.error) return { sns, mais: true, erro: `${r.error} ${r.message ?? ""}`.trim() };
    for (const o of r?.response?.order_list ?? []) sns.push(String(o.order_sn));
    if (!r?.response?.more) return { sns, mais: false };
    cursor = String(r.response.next_cursor ?? "");
    if (!cursor) return { sns, mais: false };
  }
  return { sns, mais: true };
}

interface Ped { dia: string; status: string; valor: number; itens: number; frete: number }
async function detalhar(c: Ctx, sns: string[], prazo: number): Promise<{ peds: Ped[]; erro?: string }> {
  const peds: Ped[] = [];
  const lotes: string[][] = []; for (let i = 0; i < sns.length; i += 50) lotes.push(sns.slice(i, i + 50));
  for (let i = 0; i < lotes.length; i += 6) {
    if (Date.now() > prazo) return { peds, erro: "tempo" };
    const rs = await Promise.all(lotes.slice(i, i + 6).map((l) => sGet(c, "/api/v2/order/get_order_detail", { order_sn_list: l.join(","), response_optional_fields: "total_amount,order_status,item_list,estimated_shipping_fee" })));
    for (const r of rs) {
      if (r?.error) return { peds, erro: `${r.error} ${r.message ?? ""}`.trim() };
      for (const o of r?.response?.order_list ?? []) {
        let itens = 0;
        for (const it of o.item_list ?? []) itens += Number(it.model_discounted_price ?? it.model_original_price ?? 0) * Number(it.model_quantity_purchased ?? 0);
        peds.push({ dia: diaBRT(Number(o.create_time)), status: String(o.order_status ?? ""), valor: Number(o.total_amount ?? 0), itens: Number.isFinite(itens) ? itens : 0, frete: Number(o.estimated_shipping_fee ?? 0) || 0 });
      }
    }
  }
  if (peds.length !== sns.length) return { peds, erro: `o detalhe devolveu ${peds.length} de ${sns.length} pedidos` };
  return { peds };
}

async function gravar(shop: number, dias: string[], peds: Ped[]): Promise<string | null> {
  const g = new Map<string, { shop_id: number; dia: string; status: string; pedidos: number; valor: number; valor_itens: number }>();
  const porDia = new Map<string, number>();
  for (const p of peds) {
    if (!dias.includes(p.dia)) continue;   // borda de fuso: fica para o bloco do próprio dia
    const k = `${p.dia}|${p.status}`; const x = g.get(k) ?? { shop_id: shop, dia: p.dia, status: p.status, pedidos: 0, valor: 0, valor_itens: 0 };
    x.pedidos++; x.valor += Number.isFinite(p.valor) ? p.valor : 0; x.valor_itens += p.itens; g.set(k, x);
    porDia.set(p.dia, (porDia.get(p.dia) ?? 0) + 1);
  }
  const del = await db.from("shopee_vendas_dia").delete().eq("shop_id", shop).in("dia", dias);
  if (del.error) return `banco: ${del.error.message}`;
  const linhas = [...g.values()].map((x) => ({ ...x, valor: Math.round(x.valor * 100) / 100, valor_itens: Math.round(x.valor_itens * 100) / 100, atualizado_em: new Date().toISOString() }));
  if (linhas.length) { const ins = await db.from("shopee_vendas_dia").insert(linhas); if (ins.error) return `banco: ${ins.error.message}`; }
  const est = await db.from("shopee_vendas_dia_estado").upsert(dias.map((d) => ({ shop_id: shop, dia: d, pedidos: porDia.get(d) ?? 0, concluido_em: new Date().toISOString(), erro: null })));
  return est.error ? `banco: ${est.error.message}` : null;
}

/** dias do alvo ainda não lidos, do mais novo para o mais antigo */
async function pendentes(loja: string): Promise<string[]> {
  const alvo = ALVO[loja]; const shop = LOJAS[loja];
  const est = new Map<string, any>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("shopee_vendas_dia_estado").select("dia, concluido_em, tentativas").eq("shop_id", shop).order("dia").range(off, off + 999);
    if (error) throw new Error(`banco: ${error.message}`);
    for (const r of data ?? []) est.set(String(r.dia), r);
    if (!data || data.length < 1000) break;
  }
  const out: string[] = [];
  for (let d = alvo.ate; d >= alvo.de; d = somaDias(d, -1)) { const e = est.get(d); if (!e?.concluido_em && (e?.tentativas ?? 0) < 6) out.push(d); }
  return out;
}
async function marcarErro(shop: number, dia: string, erro: string) {
  const { data } = await db.from("shopee_vendas_dia_estado").select("tentativas").eq("shop_id", shop).eq("dia", dia).maybeSingle();
  await db.from("shopee_vendas_dia_estado").upsert({ shop_id: shop, dia, erro: erro.slice(0, 300), tentativas: Number(data?.tentativas ?? 0) + 1 });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const modulo = u.searchParams.get("modulo") ?? "status";
  const loja = u.searchParams.get("loja") ?? "ottz";
  try {
    if (!LOJAS[loja]) return json({ ok: false, erro: "loja inválida (ottz | svl)" }, 400);

    if (modulo === "sonda") {
      const de = u.searchParams.get("de") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de)) return json({ ok: false, erro: "informe de=YYYY-MM-DD" }, 400);
      const dias = Math.min(15, Math.max(1, Number(u.searchParams.get("dias") ?? 15)));
      const c = await ctxShopee(LOJAS[loja]);
      const prazo = Date.now() + 20_000;
      const l = await listar(c, de, somaDias(de, dias - 1), 30, prazo);
      const d = l.erro ? { peds: [] as Ped[], erro: l.erro } : await detalhar(c, l.sns, prazo);
      const porStatus: Record<string, { pedidos: number; valor: number; itens: number; frete: number }> = {};
      const r2 = (n: number) => Math.round(n * 100) / 100;
      for (const p of d.peds) { const x = porStatus[p.status] ?? { pedidos: 0, valor: 0, itens: 0, frete: 0 }; x.pedidos++; x.valor = r2(x.valor + p.valor); x.itens = r2(x.itens + p.itens); x.frete = r2(x.frete + p.frete); porStatus[p.status] = x; }
      return json({ ok: !l.erro && !d.erro, loja, de, dias, pedidos: l.sns.length, erro: l.erro ?? d.erro ?? null, por_status: porStatus });
    }

    if (!ALVO[loja]) return json({ ok: false, erro: `a carga não está ligada para a loja ${loja}` }, 400);
    const shop = LOJAS[loja];
    if (modulo === "status") {
      const pend = await pendentes(loja);
      const { data } = await db.from("shopee_vendas_dia_estado").select("dia, erro").eq("shop_id", shop).is("concluido_em", null).not("erro", "is", null).order("dia", { ascending: false }).limit(10);
      return json({ ok: true, loja, alvo: ALVO[loja], faltam: pend.length, proximo: pend[0] ?? null, com_erro: data ?? [] });
    }
    if (modulo !== "rodar") return json({ ok: false, erro: "modulo inválido (status | rodar | sonda)" }, 400);

    const prazo = Date.now() + ORCAMENTO_MS;
    const c = await ctxShopee(shop);
    const pend = await pendentes(loja);
    const feitos: unknown[] = [];
    let denso = false;
    while (pend.length && Date.now() < prazo - 5000) {
      const fim = pend[0];
      // bloco de dias pendentes consecutivos que termina em `fim` (até 15)
      let n = 1; while (n < 15 && pend[n] === somaDias(fim, -n)) n++;
      if (!denso && n > 1) {
        const ini = somaDias(fim, -(n - 1));
        const l = await listar(c, ini, fim, 1, prazo);
        if (l.erro) { if (l.erro !== "tempo") { await marcarErro(shop, fim, l.erro); feitos.push({ dia: fim, erro: l.erro }); } break; }
        if (!l.mais) {
          const d = await detalhar(c, l.sns, prazo);
          if (d.erro) { if (d.erro !== "tempo") { await marcarErro(shop, fim, d.erro); feitos.push({ dia: fim, erro: d.erro }); } break; }
          const dias = pend.slice(0, n);
          const e = await gravar(shop, dias, d.peds);
          if (e) { feitos.push({ de: ini, ate: fim, erro: e }); break; }
          pend.splice(0, n); feitos.push({ de: ini, ate: fim, pedidos: l.sns.length });
          continue;
        }
        denso = true;
      }
      // período de muito movimento: até 4 dias ao mesmo tempo, um dia por vez em cada linha
      const lote = pend.slice(0, 4);
      const rs = await Promise.all(lote.map(async (dia): Promise<{ dia: string; pedidos?: number; erro?: string; banco?: boolean }> => {
        const l = await listar(c, dia, dia, 40, prazo);
        if (l.erro || l.mais) return { dia, erro: l.erro ?? "mais de 4.000 pedidos no dia" };
        const d = await detalhar(c, l.sns, prazo);
        if (d.erro) return { dia, erro: d.erro };
        const e = await gravar(shop, [dia], d.peds);
        return e ? { dia, erro: e, banco: true } : { dia, pedidos: l.sns.length };
      }));
      let parar = false;
      for (const r of rs) {
        if (r.erro === "tempo") { parar = true; continue; }
        if (r.erro) { if (r.banco) parar = true; else await marcarErro(shop, r.dia, r.erro); }
        feitos.push(r);
        const i = pend.indexOf(r.dia); if (i >= 0 && !r.banco) pend.splice(i, 1);
      }
      if (parar) break;
    }
    return json({ ok: true, loja, feitos, faltam: pend.length });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message ?? e) }, 500);
  }
});
