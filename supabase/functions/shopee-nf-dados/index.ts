// ============================================================================
// Edge Function: shopee-nf-dados v2 (12/nov/2026) — v2: ?modulo=ver-xml / enviar-xml (arquivo XML, upload_invoice_doc)
// ----------------------------------------------------------------------------
// Pedido Shopee com a NF emitida no Tiny e o envio NUNCA confirmado na Shopee (o Tiny não
// passou os dados fiscais). Esta função lê a nota AO VIVO no Tiny e manda os dados fiscais
// à Shopee pela API do vendedor (v2.order.add_invoice_data — só Brasil).
//   GET  ?modulo=ver&order_sn=X            → nota no Tiny + o que a Shopee tem (invoice_data,
//                                             status) + o corpo que SERIA enviado. Só leitura.
//   POST ?modulo=enviar&order_sn=X&confirmar=1 → manda UMA vez (sem repetição), relê a Shopee
//                                             e grava a tentativa em debug_fulfillment.
// Escrita: sessão de usuário (módulo galpao ou todos) OU, até 13/nov 03:00 UTC, a chave de
// ensaio para os pedidos liberados (pedido do dono em 12/nov: 2611123MBJ47R1).
// Não confirma o envio (ship_order) — isso é outro passo, irreversível.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const TINY_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const ENSAIO_ATE = Date.parse("2026-11-13T03:00:00Z");
const ENSAIO_CHAVE = "nf-12nov-8d31c2";
const ENSAIO_PEDIDOS = new Set(["2611123MBJ47R1", "261111327V6BPU", "26111132F5U2W3", "26111137Q6N9RX", "2611123EPDMHD4", "2611123FJG2SUS", "2611123JMR9BPU", "2611123RD6HXTV", "26111248VMP0NU", "26111249KG66NU", "26111249NF3GS6", "2611124A78GACW", "2611124AACMWXD", "2611124AMJR4Y8", "2611124AXDGDWE", "2611124B2J0F4N", "2611124B3380MR", "2611124B3N9SAP", "2611124B7AN8F5", "2611124BFVBVXW", "2611124BU3W5TC", "2611124BYUF285", "2611124C8C9V80", "2611123G5ARMY2", "2611123HKVDN5C", "2611123J4CRM6P", "2611123JNVK045", "2611123JQC6NER", "2611123JUMJ4YR", "2611123JW83SY7", "26111248WM7JVS", "261112490ES7M0", "26111249621FA7", "26111249BHGP7X", "26111249RFEKBG", "2611124B2J127Q", "2611124BYB9SXR"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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
  const { data, error } = await db.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`token da Shopee não encontrado para a loja ${shopId}`);
  const cr = credShopee(data.partner_id as number);
  return { shopId: Number(data.shop_id), partnerId: cr.partner_id, partnerKey: cr.partner_key, token: data.access_token as string };
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
async function shopeeGet(c: Ctx, path: string, params: Record<string, string> = {}) {
  const url = await urlLoja(c, path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return lerJson(await fetch(url.toString()));
}
async function shopeePost(c: Ctx, path: string, body: unknown) {
  const url = await urlLoja(c, path);
  return lerJson(await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

async function tinyGet(path: string) {
  const { data } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", "ottz").order("atualizado_em", { ascending: false }).limit(1).single();
  if (!data?.access_token) throw new Error("token do Tiny não encontrado");
  const r = await fetch(`${TINY_HOST}${path}`, { headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/json" } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error(`Tiny ${path}: HTTP ${r.status}`);
  return j;
}

/** Lê pedido e nota no Tiny e o pedido na Shopee; monta o corpo do add_invoice_data. */
async function montar(orderSn: string) {
  const { data: ped } = await db.from("pedidos").select("id, shop_id, status_pedido").eq("id", orderSn).maybeSingle();
  if (!ped) throw new Error("pedido não encontrado no espelho da Shopee");
  const { data: pt } = await db.from("pedidos_tiny").select("tiny_pedido_id, numero_pedido").eq("numero_ecommerce", orderSn).maybeSingle();
  if (!pt?.tiny_pedido_id) throw new Error("pedido não encontrado no espelho do Tiny");
  const pedidoTiny = await tinyGet(`/pedidos/${pt.tiny_pedido_id}`);
  const idNota = pedidoTiny?.notaFiscal?.id ?? pedidoTiny?.idNotaFiscal;
  if (!idNota) throw new Error("o pedido não tem nota fiscal no Tiny");
  const nota = await tinyGet(`/notas/${idNota}`);
  const pendencias: string[] = [];
  if (String(nota.tipo) !== "S") pendencias.push(`a nota ${nota.numero} não é de saída`);
  if (String(nota.situacao) !== "6" && String(nota.situacao) !== "7") pendencias.push(`a nota ${nota.numero} está na situação ${nota.situacao} no Tiny (esperado 6/7 = autorizada)`);
  const chave = String(nota.chaveAcesso ?? "").replace(/\D/g, "");
  if (chave.length !== 44) pendencias.push("chave de acesso da nota inválida");
  // data/hora de emissão em Brasília → unix
  const quando = String(nota.dataInclusao ?? `${nota.dataEmissao} 12:00:00`).replace(" ", "T") + "-03:00";
  const issue = Math.floor(Date.parse(quando) / 1000);
  if (!Number.isFinite(issue)) pendencias.push("data de emissão da nota ilegível");
  const cfops = [...new Set(((nota.itens ?? []) as any[]).map((i) => String(i.cfop ?? "").replace(/\D/g, "")).filter(Boolean))];
  const corpo = {
    order_sn: orderSn,
    invoice_data: {
      number: String(Number(nota.numero)),
      series_number: String(nota.serie),
      access_key: chave,
      issue_date: issue,
      total_value: Number(nota.valor ?? nota.valorFaturado ?? 0),
      products_total_value: Number(nota.valorProdutos ?? nota.valor ?? 0),
      tax_code: cfops[0] ?? "",
    },
  };
  if (cfops.length > 1) pendencias.push(`a nota tem mais de um CFOP (${cfops.join(", ")})`);
  const c = await ctxShopee(Number(ped.shop_id));
  const det = await shopeeGet(c, "/api/v2/order/get_order_detail", {
    order_sn_list: orderSn, response_optional_fields: "order_status,invoice_data,package_list,shipping_carrier",
  });
  const ordem = det?.response?.order_list?.[0] ?? null;
  return {
    c, corpo, pendencias,
    tiny: { pedido: pt.numero_pedido, situacao_pedido: pedidoTiny?.situacao, nota: { id: idNota, numero: nota.numero, serie: nota.serie, situacao: nota.situacao, chave, emissao: nota.dataInclusao, valor: nota.valor, cfops } },
    shopee: { erro: det?.error || null, mensagem: det?.message || null, status: ordem?.order_status ?? null, invoice_data: ordem?.invoice_data ?? null, pacotes: ordem?.package_list ?? null },
  };
}

/** XML da NF-e (nfeProc puro) pela API v2 do Tiny — a v2 devolve um envelope <retorno><xml_nfe>. */
async function xmlNota(idNota: string | number): Promise<string> {
  const tk = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
  if (!tk) throw new Error("falta o secret TINY_V2_TOKEN");
  const r = await fetch("https://api.tiny.com.br/api2/nota.fiscal.obter.xml.php", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: tk, id: String(idNota) }).toString(),
  });
  let txt = await r.text();
  if (!txt.includes("<nfeProc") && txt.includes("&lt;nfeProc")) {
    txt = txt.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  const i = txt.indexOf("<nfeProc"); const f = txt.lastIndexOf("</nfeProc>");
  if (i < 0 || f < 0) throw new Error(`o Tiny não devolveu o XML da nota: ${txt.replace(/\s+/g, " ").slice(0, 200)}`);
  return `<?xml version="1.0" encoding="UTF-8"?>${txt.slice(i, f + "</nfeProc>".length)}`;
}

async function autorizado(req: Request, orderSn: string, url: URL): Promise<string | null> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "authenticated") {
    const u = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
    const { data } = await u.rpc("tem_modulo", { p_modulo: "galpao" });
    if (data === true) return String(pl.email ?? pl.sub ?? "usuario");
  }
  if (Date.now() < ENSAIO_ATE && url.searchParams.get("chave") === ENSAIO_CHAVE && ENSAIO_PEDIDOS.has(orderSn)) return "ensaio (pedido do dono, 12/nov)";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "ver";
  const orderSn = (url.searchParams.get("order_sn") || "").trim().toUpperCase();
  if (!/^[0-9A-Z]{10,20}$/.test(orderSn)) return json({ ok: false, erro: "informe order_sn" }, 400);
  try {
    const quem = await autorizado(req, orderSn, url);
    if (!quem) return json({ ok: false, erro: "sem acesso (faça login com o módulo galpão)" }, 401);
    const m = await montar(orderSn);
    if (modulo === "ver") return json({ ok: true, order_sn: orderSn, tiny: m.tiny, shopee: m.shopee, enviaria: m.corpo, pendencias: m.pendencias });
    // v2: o ARQUIVO XML da nota (v2.order.upload_invoice_doc, multipart) — a chamada por campos deu "interceptor"
    if (modulo === "ver-xml" || modulo === "enviar-xml") {
      const xml = await xmlNota(m.tiny.nota.id);
      const temChave = xml.includes(m.corpo.invoice_data.access_key);
      if (modulo === "ver-xml") return json({ ok: true, order_sn: orderSn, bytes: xml.length, chave_no_xml: temChave, inicio: xml.slice(0, 160) });
      if (url.searchParams.get("confirmar") !== "1") return json({ ok: false, erro: "envio exige confirmar=1" }, 400);
      if (m.pendencias.length || !temChave) return json({ ok: false, erro: "há pendências", pendencias: [...m.pendencias, ...(temChave ? [] : ["o XML não tem a chave da nota"])] }, 400);
      const fileType = url.searchParams.get("file_type") || "4";
      const fd = new FormData();
      fd.append("order_sn", orderSn);
      fd.append("file_type", fileType);
      fd.append("file", new Blob([xml], { type: "text/xml" }), `NFe${m.corpo.invoice_data.access_key}.xml`);
      const resp = await lerJson(await fetch((await urlLoja(m.c, "/api/v2/order/upload_invoice_doc")).toString(), { method: "POST", body: fd }));
      const depois = await shopeeGet(m.c, "/api/v2/order/get_order_detail", { order_sn_list: orderSn, response_optional_fields: "order_status,invoice_data,package_list" });
      const ordem = depois?.response?.order_list?.[0] ?? null;
      await db.from("debug_fulfillment").insert({
        modulo: "shopee-nf-dados", etapa: `${orderSn}:xml`, status_http: resp?.error ? 409 : 200,
        resultado: { quem, file_type: fileType, bytes: xml.length, resposta: resp, depois: { status: ordem?.order_status ?? null, invoice_data: ordem?.invoice_data ?? null } },
      });
      return json({ ok: !resp?.error, order_sn: orderSn, file_type: fileType, bytes: xml.length, resposta: resp,
        depois: { status: ordem?.order_status ?? null, invoice_data: ordem?.invoice_data ?? null } });
    }
    if (modulo !== "enviar") return json({ ok: false, erro: "use ?modulo=ver ou enviar" }, 400);
    if (url.searchParams.get("confirmar") !== "1") return json({ ok: false, erro: "envio exige confirmar=1" }, 400);
    if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias, enviaria: m.corpo }, 400);
    // uma vez só, sem repetição automática
    const resp = await shopeePost(m.c, "/api/v2/order/add_invoice_data", m.corpo);
    const depois = await shopeeGet(m.c, "/api/v2/order/get_order_detail", { order_sn_list: orderSn, response_optional_fields: "order_status,invoice_data,package_list" });
    const ordem = depois?.response?.order_list?.[0] ?? null;
    await db.from("debug_fulfillment").insert({
      modulo: "shopee-nf-dados", etapa: orderSn, status_http: resp?.error ? 409 : 200,
      resultado: { quem, enviado: m.corpo, resposta: resp, antes: m.shopee, depois: { status: ordem?.order_status ?? null, invoice_data: ordem?.invoice_data ?? null } },
    });
    return json({ ok: !resp?.error, order_sn: orderSn, enviado: m.corpo, resposta: resp,
      depois: { status: ordem?.order_status ?? null, invoice_data: ordem?.invoice_data ?? null, pacotes: ordem?.package_list ?? null } });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
