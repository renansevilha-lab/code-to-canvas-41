// ============================================================================
// Edge Function: shopee-destravar v2 (12/nov/2026) — rotina diária, pedido do dono (v2: nota da Bumi pelo Tiny da SVL)
// ----------------------------------------------------------------------------
// Pedido Shopee FATURADO no Tiny que segue "aguardando confirmar o envio" na Shopee não tem
// rastreio nem etiqueta (o Tiny emitiu a NF e não chamou o ship_order). Em 12/nov eram 23 na
// Ottz e 14 na Bumi. Esta rotina, 1×/dia antes da bancada:
//   1. candidatos = pedidos (as duas lojas) READY_TO_SHIP no espelho, de 2 h a 10 dias, com o
//      pedido "faturada" no Tiny; fora Full, Retirada pelo Comprador e Turbo; 1 tentativa/dia;
//   2. confere AO VIVO (get_shipping_parameter): já confirmado → nada; coleta disponível →
//      ship_order no endereço padrão e no horário recomendado (o mesmo da shopee-ship);
//   3. a Shopee recusou por falta de nota e o pedido é da Ottz com a nota "pending" na Shopee →
//      manda o XML da NF (Tiny Ottz, upload_invoice_doc) e tenta confirmar UMA vez de novo.
//      Bumi (v2): a NF fica no Tiny da SVL — acha a nota pelos itens + "Ref. ao pedido" e manda o XML.
//      Nota que a Shopee recebeu e recusa → só avisa;
//   4. registra cada pedido em debug_fulfillment (modulo shopee-destravar) e avisa no Discord
//      (canal pedidos) o que destravou e o que precisa de gente. Silêncio sem nada a fazer.
// A etiqueta sai sozinha depois: o pregerar (3 em 3 min) gera a de quem ganhou rastreio.
//   ?modulo=previa  → só lê (candidatos + o que faria)        ?modulo=rotina → executa
// Chave publicável aceita (cron 1×/dia): só executa a regra fixa acima. Orçamento 22 s/chamada;
// o cron chama 3 vezes seguidas e cada chamada continua de onde a outra parou.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SRK);
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const TINY_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const LOJAS: Record<number, string> = { 522186766: "Ottz", 759046323: "Bumi" };
const OTTZ = 522186766;
const ORCAMENTO_MS = 22_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const ctxCache = new Map<number, Ctx>();
async function ctxShopee(shopId: number): Promise<Ctx> {
  if (ctxCache.has(shopId)) return ctxCache.get(shopId)!;
  const { data, error } = await db.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`token da Shopee não encontrado para a loja ${shopId}`);
  const cr = credShopee(data.partner_id as number);
  const c = { shopId: Number(data.shop_id), partnerId: cr.partner_id, partnerKey: cr.partner_key, token: data.access_token as string };
  ctxCache.set(shopId, c);
  return c;
}
async function urlLoja(c: Ctx, path: string): Promise<URL> {
  const ts = Math.floor(Date.now() / 1000);
  const url = new URL(`${SHOPEE_HOST}${path}`);
  url.searchParams.set("partner_id", String(c.partnerId));
  url.searchParams.set("timestamp", String(ts));
  url.searchParams.set("access_token", c.token);
  url.searchParams.set("shop_id", String(c.shopId));
  url.searchParams.set("sign", await hmacHex(c.partnerKey, `${c.partnerId}${path}${ts}${c.token}${c.shopId}`));
  return url;
}
async function lerJson(r: Response) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { error: "resposta_nao_json", message: txt.slice(0, 300) }; }
}
async function sGet(c: Ctx, path: string, params: Record<string, string>) {
  const url = await urlLoja(c, path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return lerJson(await fetch(url.toString()));
}
async function sPost(c: Ctx, path: string, body: unknown) {
  const url = await urlLoja(c, path);
  return lerJson(await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

/** Coleta: endereço padrão (senão o de coleta, senão o 1º) e o horário recomendado. null = não há coleta. */
function escolherColeta(resp: any): { address_id: number; pickup_time_id: string } | null {
  const lista = (resp?.response?.pickup?.address_list ?? []) as any[];
  if (!resp?.response?.info_needed?.pickup || !lista.length) return null;
  const end = lista.find((a) => (a.address_flag ?? []).includes("default_address")) ?? lista.find((a) => (a.address_flag ?? []).includes("pickup_address")) ?? lista[0];
  const slots = (end.time_slot_list ?? []) as any[];
  const slot = slots.find((s) => (s.flags ?? []).includes("recommended")) ?? slots[0];
  if (!slot) return null;
  return { address_id: Number(end.address_id), pickup_time_id: String(slot.pickup_time_id) };
}

async function tinyToken(): Promise<string> {
  const { data } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", "ottz").order("atualizado_em", { ascending: false }).limit(1).single();
  if (!data?.access_token) throw new Error("token do Tiny não encontrado");
  return String(data.access_token);
}
/** Ottz: manda o XML da NF do Tiny à Shopee. Devolve o status da nota na Shopee depois (valid/pending/…). */
async function mandarXml(c: Ctx, orderSn: string): Promise<{ ok: boolean; detalhe: string }> {
  const { data: pt } = await db.from("pedidos_tiny").select("tiny_pedido_id").eq("numero_ecommerce", orderSn).maybeSingle();
  if (!pt?.tiny_pedido_id) return { ok: false, detalhe: "pedido fora do espelho do Tiny" };
  const tk = await tinyToken();
  const pr = await fetch(`${TINY_HOST}/pedidos/${pt.tiny_pedido_id}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
  const ped = await pr.json().catch(() => null);
  const idNota = ped?.notaFiscal?.id ?? ped?.idNotaFiscal;
  if (!idNota) return { ok: false, detalhe: "o pedido não tem NF no Tiny da Ottz" };
  if (String(ped?.notaFiscal?.situacao ?? "") !== "6" && String(ped?.notaFiscal?.situacao ?? "") !== "7") return { ok: false, detalhe: `NF ${ped?.notaFiscal?.numero} na situação ${ped?.notaFiscal?.situacao} no Tiny` };
  const v2 = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
  if (!v2) return { ok: false, detalhe: "falta o secret TINY_V2_TOKEN" };
  const r = await fetch("https://api.tiny.com.br/api2/nota.fiscal.obter.xml.php", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: v2, id: String(idNota) }).toString(),
  });
  let txt = await r.text();
  if (!txt.includes("<nfeProc") && txt.includes("&lt;nfeProc")) txt = txt.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const i = txt.indexOf("<nfeProc"); const f = txt.lastIndexOf("</nfeProc>");
  if (i < 0 || f < 0) return { ok: false, detalhe: "o Tiny não devolveu o XML da NF" };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>${txt.slice(i, f + 10)}`;
  const fd = new FormData();
  fd.append("order_sn", orderSn); fd.append("file_type", "4");
  fd.append("file", new Blob([xml], { type: "text/xml" }), `NFe-${orderSn}.xml`);
  const up = await lerJson(await fetch((await urlLoja(c, "/api/v2/order/upload_invoice_doc")).toString(), { method: "POST", body: fd }));
  if (up?.error) return { ok: false, detalhe: `a Shopee recusou o XML: ${up.error} ${up.message ?? ""}`.trim() };
  const det = await sGet(c, "/api/v2/order/get_order_detail", { order_sn_list: orderSn, response_optional_fields: "invoice_data" });
  const st = det?.response?.order_list?.[0]?.invoice_data?.status ?? "?";
  return { ok: st === "valid", detalhe: `XML da NF ${ped?.notaFiscal?.numero} enviado; nota na Shopee: ${st}` };
}

// ---------------------------------------------------------------- Bumi: a NF fica no Tiny da SVL (v3)
// A conta SVL do Tiny recebe uma cópia SEM canal do pedido da Bumi e emite a NF lá; a nota não diz o
// pedido da Shopee na listagem, só na observação do detalhe ("Ref. ao pedido número <order_sn>").
// Caminho: itens do pedido (Tiny Ottz, kit aberto nos componentes) → notas da SVL do dia do pedido em
// diante com os MESMOS itens → detalhe de cada candidata até achar a observação → XML (v3 /notas/{id}/xml).
async function tinyFetch(token: string, path: string): Promise<any> {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`${TINY_HOST}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (r.status === 429) { await pausa(2500 * (t + 1)); continue; }
    return await r.json().catch(() => null);
  }
  return null;
}
async function tokenTiny(conta: string): Promise<string> {
  const { data } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", conta).order("atualizado_em", { ascending: false }).limit(1).single();
  if (!data?.access_token) throw new Error(`token do Tiny (${conta}) não encontrado`);
  return String(data.access_token);
}
const notasSvlCache = new Map<string, any[]>();
async function notasSvl(tk: string, de: string, ate: string): Promise<any[]> {
  const chave = `${de}|${ate}`;
  if (notasSvlCache.has(chave)) return notasSvlCache.get(chave)!;
  const todas: any[] = [];
  for (let off = 0; off < 1200; off += 100) {
    const j = await tinyFetch(tk, `/notas?tipo=S&dataInicial=${de}&dataFinal=${ate}&limit=100&offset=${off}`);
    const itens = (j?.itens ?? []) as any[];
    todas.push(...itens);
    if (itens.length < 100) break;
    await pausa(300);
  }
  notasSvlCache.set(chave, todas);
  return todas;
}
const assinaturaItens = (lista: { sku: string; q: number }[]) => {
  const m = new Map<string, number>();
  for (const i of lista) m.set(i.sku, (m.get(i.sku) ?? 0) + i.q);
  return [...m.entries()].sort().map(([s, q]) => `${s}x${q}`).join("+");
};
async function mandarXmlBumi(c: Ctx, orderSn: string): Promise<{ ok: boolean; detalhe: string }> {
  const { data: pt } = await db.from("pedidos_tiny").select("tiny_pedido_id").eq("numero_ecommerce", orderSn).maybeSingle();
  if (!pt?.tiny_pedido_id) return { ok: false, detalhe: "pedido fora do espelho do Tiny" };
  const ped = await tinyFetch(await tokenTiny("ottz"), `/pedidos/${pt.tiny_pedido_id}`);
  const itensPed = ((ped?.itens ?? []) as any[]).map((i) => ({ sku: String(i.produto?.sku ?? i.produto?.codigo ?? ""), q: Number(i.quantidade ?? 0) })).filter((i) => i.sku);
  if (!itensPed.length || !ped?.data) return { ok: false, detalhe: "não consegui ler os itens do pedido no Tiny" };
  // a NF da SVL abre o kit nos componentes
  const { data: kits } = await db.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_kit", itensPed.map((i) => i.sku));
  const esperado: { sku: string; q: number }[] = [];
  for (const i of itensPed) {
    const comps = ((kits ?? []) as any[]).filter((k) => String(k.sku_kit) === i.sku);
    if (comps.length) for (const k of comps) esperado.push({ sku: String(k.sku_componente), q: i.q * (Number(k.quantidade) || 1) });
    else esperado.push(i);
  }
  const alvoNormal = assinaturaItens(itensPed), alvoAberto = assinaturaItens(esperado);
  const tk = await tokenTiny("svl");
  const de = String(ped.data).slice(0, 10);
  const ate = new Date(Math.min(Date.parse(`${de}T12:00:00Z`) + 3 * 86400_000, Date.now())).toISOString().slice(0, 10);
  const notas = await notasSvl(tk, de, ate);
  const cands = notas.filter((n) => ["6", "7"].includes(String(n.situacao)) && [alvoNormal, alvoAberto].includes(
    assinaturaItens(((n.itens ?? []) as any[]).map((i) => ({ sku: String(i.codigo ?? ""), q: Number(i.quantidade ?? 0) })))));
  if (!cands.length) return { ok: false, detalhe: `não achei no Tiny da SVL nota autorizada com os itens ${alvoAberto} (de ${de} a ${ate})` };
  // produto comum = dezenas de notas iguais no dia: olha primeiro as de MESMO valor do pedido no Tiny e as do dia do faturamento
  const valorPed = Number(ped.valorTotalProdutos ?? ped.valorTotalPedido ?? 0);
  const diaFat = String(ped.dataFaturamento ?? "").slice(0, 10);
  const peso = (n: any) => (Math.abs(Number(n.valor ?? 0) - valorPed) < 0.02 ? 0 : 2) + (diaFat && String(n.dataEmissao ?? "") === diaFat ? 0 : 1);
  const ordem = [...cands].sort((x, y) => peso(x) - peso(y));
  const limite = Date.now() + 12_000;
  let achada: any = null; let vistas = 0;
  for (const n of ordem.slice(0, 40)) {
    if (Date.now() > limite) break;
    const det = await tinyFetch(tk, `/notas/${n.id}`);
    vistas++;
    if (String(det?.observacoes ?? "").includes(orderSn)) { achada = det; break; }
    await pausa(300);
  }
  if (!achada) return { ok: false, detalhe: `olhei ${vistas} das ${cands.length} notas da SVL com os mesmos itens e nenhuma cita o pedido ${orderSn}` };
  const xj = await tinyFetch(tk, `/notas/${achada.id}/xml`);
  const xml = String(xj?.xmlNfe ?? "");
  if (!xml.includes("<nfeProc")) return { ok: false, detalhe: `o Tiny da SVL não devolveu o XML da NF ${achada.numero}` };
  return await subirXml(c, orderSn, xml, `NF ${achada.numero}/${achada.serie} (Tiny SVL)`);
}
/** Sobe o XML à Shopee e devolve se a nota ficou "valid". */
async function subirXml(c: Ctx, orderSn: string, xml: string, rotulo: string): Promise<{ ok: boolean; detalhe: string }> {
  const fd = new FormData();
  fd.append("order_sn", orderSn); fd.append("file_type", "4");
  fd.append("file", new Blob([xml], { type: "text/xml" }), `NFe-${orderSn}.xml`);
  const up = await lerJson(await fetch((await urlLoja(c, "/api/v2/order/upload_invoice_doc")).toString(), { method: "POST", body: fd }));
  if (up?.error) return { ok: false, detalhe: `a Shopee recusou o XML da ${rotulo}: ${up.error} ${up.message ?? ""}`.trim() };
  const det = await sGet(c, "/api/v2/order/get_order_detail", { order_sn_list: orderSn, response_optional_fields: "invoice_data" });
  const st = det?.response?.order_list?.[0]?.invoice_data?.status ?? "?";
  return { ok: st === "valid", detalhe: `XML da ${rotulo} enviado; nota na Shopee: ${st}` };
}

type Resultado = { order_sn: string; loja: string; resultado: string; detalhe: string };

async function candidatos(): Promise<{ order_sn: string; shop_id: number; envio: string }[]> {
  const agora = Date.now();
  const { data: peds } = await db.from("pedidos").select("id, shop_id, opcao_envio")
    .in("shop_id", Object.keys(LOJAS).map(Number)).eq("status_pedido", "READY_TO_SHIP")
    .gte("data_pedido", new Date(agora - 10 * 86400_000).toISOString()).lte("data_pedido", new Date(agora - 2 * 3600_000).toISOString())
    .limit(500);
  const lista = ((peds ?? []) as any[]).filter((p) => !/full|retirada|turbo/i.test(String(p.opcao_envio ?? "")));
  if (!lista.length) return [];
  const { data: tiny } = await db.from("pedidos_tiny").select("numero_ecommerce, situacao").in("numero_ecommerce", lista.map((p) => String(p.id)));
  const faturados = new Set(((tiny ?? []) as any[]).filter((t) => t.situacao === "faturada").map((t) => String(t.numero_ecommerce)));
  // 1 tentativa por pedido por dia (dia de Brasília)
  const hoje = new Date(agora - 3 * 3600_000).toISOString().slice(0, 10);
  const { data: feitos } = await db.from("debug_fulfillment").select("etapa").eq("modulo", "shopee-destravar").gte("criado_em", `${hoje}T03:00:00Z`);
  const ja = new Set(((feitos ?? []) as any[]).map((x) => String(x.etapa)));
  return lista.filter((p) => faturados.has(String(p.id)) && !ja.has(String(p.id)))
    .map((p) => ({ order_sn: String(p.id), shop_id: Number(p.shop_id), envio: String(p.opcao_envio ?? "") }));
}

async function tratar(p: { order_sn: string; shop_id: number }, executar: boolean): Promise<Resultado> {
  const loja = LOJAS[p.shop_id] ?? String(p.shop_id);
  const c = await ctxShopee(p.shop_id);
  const par = await sGet(c, "/api/v2/logistics/get_shipping_parameter", { order_sn: p.order_sn });
  if (par?.error) {
    const msg = `${par.error} ${par.message ?? ""}`.trim();
    if (/not eligible|already|package/i.test(msg)) return { order_sn: p.order_sn, loja, resultado: "ja_confirmado", detalhe: msg };
    return { order_sn: p.order_sn, loja, resultado: "erro_leitura", detalhe: msg };
  }
  const coleta = escolherColeta(par);
  if (!coleta) return { order_sn: p.order_sn, loja, resultado: "sem_coleta", detalhe: `a Shopee não ofereceu coleta (pede: ${JSON.stringify(par?.response?.info_needed ?? {})})` };
  if (!executar) return { order_sn: p.order_sn, loja, resultado: "confirmaria", detalhe: `coleta endereço ${coleta.address_id}, horário ${coleta.pickup_time_id}` };
  let so = await sPost(c, "/api/v2/logistics/ship_order", { order_sn: p.order_sn, pickup: coleta });
  if (!so?.error) return { order_sn: p.order_sn, loja, resultado: "confirmado", detalhe: "envio confirmado" };
  const msg = `${so.error} ${so.message ?? ""}`.trim();
  if (!/lack_of_invoice/i.test(msg)) return { order_sn: p.order_sn, loja, resultado: "recusado", detalhe: msg };
  // falta de nota: só a Ottz tem a NF no Tiny que o app lê; e só se a Shopee está com a nota "pending"
  const det = await sGet(c, "/api/v2/order/get_order_detail", { order_sn_list: p.order_sn, response_optional_fields: "invoice_data" });
  const stNota = det?.response?.order_list?.[0]?.invoice_data?.status ?? "?";
  if (stNota !== "pending") {
    return { order_sn: p.order_sn, loja, resultado: "nota_invalida", detalhe: `a Shopee não aceita a nota que recebeu (status ${stNota}): conferir a NF no Tiny${p.shop_id !== OTTZ ? " da SVL" : ""}. ${msg}` };
  }
  const x = p.shop_id === OTTZ ? await mandarXml(c, p.order_sn) : await mandarXmlBumi(c, p.order_sn);
  if (!x.ok) return { order_sn: p.order_sn, loja, resultado: "nota_invalida", detalhe: x.detalhe };
  await pausa(1500);
  so = await sPost(c, "/api/v2/logistics/ship_order", { order_sn: p.order_sn, pickup: coleta });
  if (!so?.error) return { order_sn: p.order_sn, loja, resultado: "confirmado", detalhe: `${x.detalhe}; envio confirmado` };
  return { order_sn: p.order_sn, loja, resultado: "recusado", detalhe: `${x.detalhe}; confirmação recusada: ${so.error} ${so.message ?? ""}`.trim() };
}

async function avisar(res: Resultado[]) {
  const ok = res.filter((r) => r.resultado === "confirmado");
  const gente = res.filter((r) => ["nota_invalida", "recusado", "sem_coleta", "erro_leitura"].includes(r.resultado));
  if (!ok.length && !gente.length) return;
  const linhas: string[] = [];
  if (ok.length) linhas.push(`**${ok.length} destravado(s)** — envio confirmado na Shopee; a etiqueta sai em minutos pela Separação:\n${ok.map((r) => `• ${r.loja} ${r.order_sn}`).join("\n")}`);
  if (gente.length) linhas.push(`**${gente.length} precisa(m) de gente:**\n${gente.map((r) => `• ${r.loja} ${r.order_sn} — ${r.detalhe.slice(0, 160)}`).join("\n")}`);
  try {
    await fetch(`${SB_URL}/functions/v1/discord-notify`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
      body: JSON.stringify({ canal: "pedidos", nivel: gente.length ? "aviso" : "ok", rodape: "shopee-destravar · rotina diária",
        titulo: "Shopee: pedidos faturados no Tiny e sem envio confirmado", descricao: linhas.join("\n\n").slice(0, 3900) }),
    });
  } catch { /* melhor-esforço */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "previa";
  // ?modulo=nota&loja=ottz|svl&pedidos=A,B → só leitura: a nota que a Shopee tem de cada pedido (diagnóstico)
  if (modulo === "nota") {
    const shop = url.searchParams.get("loja") === "svl" ? 759046323 : OTTZ;
    const lista = (url.searchParams.get("pedidos") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[0-9A-Z]{10,20}$/.test(s)).slice(0, 50);
    if (!lista.length) return json({ ok: false, erro: "informe pedidos" }, 400);
    const c = await ctxShopee(shop);
    const det = await sGet(c, "/api/v2/order/get_order_detail", { order_sn_list: lista.join(","), response_optional_fields: "order_status,invoice_data,total_amount,package_list" });
    return json({ ok: !det?.error, erro: det?.error || null, pedidos: ((det?.response?.order_list ?? []) as any[]).map((o) => ({ order_sn: o.order_sn, status: o.order_status, total: o.total_amount, nota: o.invoice_data, pacote: o.package_list?.[0]?.logistics_status ?? null })) });
  }
  if (modulo !== "previa" && modulo !== "rotina") return json({ ok: false, erro: "use ?modulo=previa ou rotina" }, 400);
  const inicio = Date.now();
  try {
    const lista = await candidatos();
    const res: Resultado[] = [];
    for (const p of lista) {
      if (Date.now() - inicio > ORCAMENTO_MS) break;
      let r: Resultado;
      try { r = await tratar(p, modulo === "rotina"); }
      catch (e) { r = { order_sn: p.order_sn, loja: LOJAS[p.shop_id] ?? "", resultado: "erro", detalhe: String(e instanceof Error ? e.message : e) }; }
      res.push(r);
      if (modulo === "rotina" && r.resultado !== "erro_leitura" && r.resultado !== "erro") {
        await db.from("debug_fulfillment").insert({ modulo: "shopee-destravar", etapa: p.order_sn, status_http: r.resultado === "confirmado" ? 200 : r.resultado === "ja_confirmado" ? 204 : 409, resultado: r });
      }
    }
    if (modulo === "rotina") await avisar(res);
    const faltam = lista.length - res.length;
    return json({ ok: true, modulo, candidatos: lista.length, tratados: res.length, faltam, resultados: res });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
