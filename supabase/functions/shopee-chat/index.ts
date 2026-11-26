// ============================================================================
// Edge Function: shopee-chat v4 — chat com compradores Shopee
// ----------------------------------------------------------------------------
// v4 (26/nov): LEITURA do chat para a futura caixa de atendimento (respostas
//   pela IA). So leitura, nada e enviado:
//   ?modulo=conversas&loja=ottz|svl[&tipo=all|unread][&limite=20][&antes=<nano>]
//      -> get_conversation_list (conversa, comprador, nao lidas, ultima msg)
//   ?modulo=mensagens&loja=ottz|svl&conversa=<conversation_id>[&limite=25][&offset=]
//      -> get_message (historico da conversa, do mais novo para o mais antigo)
// v3 (11/set): 1o envio real devolveu `first_chat_without_order_info` — a Shopee
//   exige que a PRIMEIRA mensagem de uma conversa nova carregue o pedido. Agora:
//   tenta o texto; se vier esse erro, manda o card do pedido (message_type
//   "order", content {order_sn}) e repete o texto. Dedupe passou a olhar so
//   envios `ok=true` (a v2 pulava pedidos cuja tentativa tinha FALHADO).
// v2 (11/set): alem de `tag` (lote), aceita `order_sns` (lista de pedidos) — o
//   menu do GRUPO na fila de separacao existe antes de haver TAG. O rotulo
//   (`rotulo`) e gravado na coluna `tag` do registro para rastreio.
// v1 (10/set): probe / preview&tag / enviar&tag&confirmar=1.
//
// API: v2.sellerchat (send_message / get_conversation_list / get_message). O
// destinatario e o `buyer_user_id` do pedido (get_order_detail?response_optional_fields)
// — NAO esta no espelho `pedidos`.
// Modulos:
//   ?modulo=probe                               escopo de chat por loja (leitura)
//   ?modulo=conversas / mensagens               leitura do chat (v4)
//   ?modulo=preview&tag=X | body {order_sns[]}  destinatarios (sem enviar)
//   ?modulo=enviar&confirmar=1  body {texto, tag? | order_sns?, rotulo?, por?}
// Regras: escrita SO com confirmar=1; dedupe por (order_sn, hash do texto, ok);
// pausa entre envios; para no 1o erro de escopo/rate-limit.
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HOST = "https://partner.shopeemobile.com";
const LOJAS: Record<string, { shop_id: number; nome: string }> = {
  ottz: { shop_id: 522186766, nome: "Shopee (Ottz Pet)" },
  svl: { shop_id: 759046323, nome: "Bumi Pet [Shopee]" },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

type Auth = { shop_id: number; partner_id: number; partner_key: string; access_token: string };

async function authDaLoja(sb: any, shopId: number): Promise<Auth> {
  const { data } = await sb.from("oauth_tokens_shopee")
    .select("access_token, shop_id, partner_id").eq("shop_id", shopId).single();
  if (!data?.access_token) throw new Error(`sem token da loja ${shopId}`);
  const partnerId = Number(data.partner_id);
  const key = (partnerId === 2034179 ? Deno.env.get("SHOPEE_PARTNER_KEY") : Deno.env.get("SHOPEE_PARTNER_KEY_SVL")) || "";
  return { shop_id: shopId, partner_id: partnerId, partner_key: key.trim(), access_token: data.access_token };
}

async function assinar(a: Auth, path: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const base = `${a.partner_id}${path}${timestamp}${a.access_token}${a.shop_id}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(a.partner_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(base));
  const sign = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const u = new URL(`${HOST}${path}`);
  u.searchParams.set("partner_id", String(a.partner_id));
  u.searchParams.set("timestamp", String(timestamp));
  u.searchParams.set("access_token", a.access_token);
  u.searchParams.set("shop_id", String(a.shop_id));
  u.searchParams.set("sign", sign);
  return u;
}

async function shopeeGet(a: Auth, path: string, params: Record<string, string>) {
  const u = await assinar(a, path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString());
  const t = await r.text();
  try { return { http: r.status, body: JSON.parse(t) }; } catch { return { http: r.status, body: { _raw: t.slice(0, 300) } }; }
}

async function shopeePost(a: Auth, path: string, body: unknown) {
  const u = await assinar(a, path);
  const r = await fetch(u.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return { http: r.status, body: JSON.parse(t) }; } catch { return { http: r.status, body: { _raw: t.slice(0, 300) } }; }
}

function lojaDoCanal(marcaCanal: string | null): keyof typeof LOJAS | null {
  const m = (marcaCanal || "").toLowerCase();
  if (!m.includes("shopee")) return null;
  if (m.includes("ottz")) return "ottz";
  if (m.includes("bumi") || m.includes("sevilla") || m.includes("svl")) return "svl";
  return null;
}

// Ids do chat passam de 2^53: o JSON.parse arredonda. Lemos o texto cru e
// trocamos os numeros longos por string antes do parse.
async function shopeeGetIdsTexto(a: Auth, path: string, params: Record<string, string>) {
  const u = await assinar(a, path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString());
  const t = await r.text();
  const seguro = t.replace(/(:\s*)(-?\d{16,})(\s*[,}\]])/g, '$1"$2"$3');
  try { return { http: r.status, body: JSON.parse(seguro) }; } catch { return { http: r.status, body: { _raw: t.slice(0, 300) } }; }
}

// Papel do JWT que chegou (verify_jwt ja validou a assinatura).
function papelDoJwt(req: Request): string {
  const tk = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  try {
    const p = tk.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return String(JSON.parse(atob(p + "===".slice((p.length + 3) % 4))).role || "");
  } catch { return ""; }
}

// Texto legivel de qualquer tipo de mensagem (texto, pedido, produto, imagem...).
function resumoConteudo(tipo: string, c: any): string {
  if (!c) return "";
  if (tipo === "text") return String(c.text ?? "");
  if (tipo === "order") return `[pedido ${c.order_sn ?? ""}]`;
  if (tipo === "item" || tipo === "product") return `[produto ${c.item_id ?? ""}]`;
  if (tipo === "image") return "[imagem]";
  if (tipo === "video") return "[video]";
  if (tipo === "sticker") return "[figurinha]";
  if (tipo === "bundle_message" && Array.isArray(c.messages)) {
    return c.messages.map((x: any) => resumoConteudo(x?.message_type ?? x?.type ?? "", x?.content ?? x)).filter(Boolean).join(" | ") || "[mensagem automatica]";
  }
  if (c.text) return String(c.text);
  return `[${tipo}]`;
}

// v3: texto; se a conversa e nova, a Shopee exige o pedido na 1a mensagem ->
// manda o card do pedido e repete o texto. Devolve a resposta final + se abriu.
async function enviarTexto(a: Auth, buyerId: number, orderSn: string, texto: string) {
  let r = await shopeePost(a, "/api/v2/sellerchat/send_message", {
    to_id: buyerId, message_type: "text", content: { text: texto },
  });
  let abriuComPedido = false;
  if (String(r.body?.error || "").includes("first_chat_without_order_info")) {
    const card = await shopeePost(a, "/api/v2/sellerchat/send_message", {
      to_id: buyerId, message_type: "order", content: { order_sn: orderSn },
    });
    if (card.body?.error) return { r: card, abriuComPedido: false };
    abriuComPedido = true;
    await sleep(300);
    r = await shopeePost(a, "/api/v2/sellerchat/send_message", {
      to_id: buyerId, message_type: "text", content: { text: texto },
    });
  }
  return { r, abriuComPedido };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "probe";
  let corpo: any = {};
  if (req.method === "POST") { try { corpo = await req.json(); } catch { corpo = {}; } }
  const p = (k: string) => url.searchParams.get(k) ?? (corpo?.[k] != null && !Array.isArray(corpo[k]) ? String(corpo[k]) : null);

  if (modulo === "probe") {
    const out: any[] = [];
    for (const [nome, l] of Object.entries(LOJAS)) {
      try {
        const a = await authDaLoja(sb, l.shop_id);
        const r = await shopeeGet(a, "/api/v2/sellerchat/get_conversation_list", { direction: "latest", type: "all", page_size: "5" });
        const conv = r.body?.response?.conversations ?? [];
        out.push({ loja: nome, shop_id: l.shop_id, http: r.http, erro: r.body?.error || null, msg: r.body?.message || null,
          conversas_amostra: conv.length, veredito: r.body?.error ? `SEM escopo de chat (${r.body.error})` : "chat OK" });
      } catch (e) { out.push({ loja: nome, erro: (e as Error).message }); }
    }
    return json({ modulo, lojas: out });
  }

  // ---- v4: leitura do chat (nada e enviado) ----
  if (modulo === "conversas" || modulo === "mensagens") {
    // conversa tem dado do comprador: so usuario logado (ou service role), nunca a chave publica
    if (!["authenticated", "service_role"].includes(papelDoJwt(req))) {
      return json({ erro: "leitura do chat exige login" }, 401);
    }
    const nome = (p("loja") || "ottz").toLowerCase();
    const l = LOJAS[nome];
    if (!l) return json({ erro: "loja deve ser ottz ou svl" }, 400);
    let a: Auth;
    try { a = await authDaLoja(sb, l.shop_id); } catch (e) { return json({ erro: (e as Error).message }, 500); }

    if (modulo === "conversas") {
      const tipo = p("tipo") === "unread" ? "unread" : "all";
      const limite = Math.min(Math.max(parseInt(p("limite") || "20", 10) || 20, 1), 60);
      // "older" a partir de agora = das mais recentes para as mais antigas
      // ("latest" sem cursor devolvia as mais ANTIGAS da loja, de 2024).
      const antes = p("antes") || `${Date.now()}000000`;
      const params: Record<string, string> = { direction: "older", type: tipo, page_size: String(limite), next_timestamp_nano: antes };
      const r = await shopeeGetIdsTexto(a, "/api/v2/sellerchat/get_conversation_list", params);
      if (r.body?.error) return json({ modulo, loja: nome, erro: r.body.error, msg: r.body.message || null }, 502);
      const resp = r.body?.response || {};
      if (p("cru") === "1") return json({ modulo, loja: nome, cru: (resp.conversations || []).slice(0, 2), page_result: resp.page_result ?? null });
      const conversas = (resp.conversations || []).map((c: any) => ({
        conversation_id: String(c.conversation_id),
        comprador_id: c.to_id != null ? String(c.to_id) : null,
        comprador: c.to_name ?? null,
        foto: c.to_avatar ?? null,
        nao_lidas: c.unread_count ?? 0,
        ultima_msg: resumoConteudo(c.latest_message_type, c.latest_message_content),
        ultima_msg_tipo: c.latest_message_type ?? null,
        // o remetente da loja e o usuario dono da loja (nao o shop_id): "de nos" = nao veio do comprador
        ultima_msg_de_nos: c.latest_message_from_id != null && c.to_id != null && String(c.latest_message_from_id) !== String(c.to_id),
        ultima_msg_em: c.last_message_timestamp ? new Date(Number(String(c.last_message_timestamp).slice(0, 13))).toISOString() : null,
        fixada: !!c.pinned,
      }));
      return json({
        modulo, loja: nome, tipo, conversas,
        mais: !!resp.page_result?.more,
        proxima: resp.page_result?.next_cursor?.next_message_time_nano != null
          ? String(resp.page_result.next_cursor.next_message_time_nano) : null,
      });
    }

    // mensagens
    const conversa = (p("conversa") || "").trim();
    if (!/^\d+$/.test(conversa)) return json({ erro: "informe &conversa=<conversation_id>" }, 400);
    const limite = Math.min(Math.max(parseInt(p("limite") || "25", 10) || 25, 1), 60);
    const params: Record<string, string> = { conversation_id: conversa, page_size: String(limite) };
    const offset = p("offset");
    if (offset) params.offset = offset;
    const r = await shopeeGetIdsTexto(a, "/api/v2/sellerchat/get_message", params);
    if (r.body?.error) return json({ modulo, loja: nome, conversa, erro: r.body.error, msg: r.body.message || null }, 502);
    const resp = r.body?.response || {};
    if (p("cru") === "1") return json({ modulo, loja: nome, conversa, cru: (resp.messages || []).slice(0, 3), page_result: resp.page_result ?? null });
    const mensagens =(resp.messages || []).map((m: any) => ({
      message_id: String(m.message_id),
      de_nos: m.from_shop_id != null && String(m.from_shop_id) === String(l.shop_id),
      tipo: m.message_type,
      texto: resumoConteudo(m.message_type, m.content),
      conteudo: m.content ?? null,
      em: m.created_timestamp ? new Date(Number(m.created_timestamp) * 1000).toISOString() : null,
      origem: m.source ?? null, // android/ios/web = pessoa; openapi = sistema; server = automatico da Shopee
      item_id: m.source_content?.item_id != null ? String(m.source_content.item_id) : null,
      order_sn: m.source_content?.order_sn ?? (m.message_type === "order" ? m.content?.order_sn ?? null : null),
    }));
    return json({
      modulo, loja: nome, conversa, mensagens,
      mais: !!resp.page_result?.next_offset,
      proximo_offset: resp.page_result?.next_offset ?? null,
    });
  }

  // ---- alvo: por TAG (lote) ou por lista de pedidos (grupo da fila) ----
  const tag = (p("tag") || "").trim();
  const orderSnsIn: string[] = Array.isArray(corpo?.order_sns)
    ? corpo.order_sns.map((x: any) => String(x).trim()).filter(Boolean)
    : (url.searchParams.get("order_sns") || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!tag && orderSnsIn.length === 0) return json({ erro: "informe ?tag=1009-42 ou body {order_sns:[...]}" }, 400);
  const rotulo = (p("rotulo") || tag || `pedidos:${orderSnsIn.length}`).slice(0, 80);

  let q = sb.from("separacao_tiny").select("numero_ecommerce, marca_canal, venda_numero, nome_produto");
  q = tag ? q.eq("tag_lote", tag) : q.in("numero_ecommerce", orderSnsIn.slice(0, 500));
  const { data: seps, error: eSep } = await q;
  if (eSep) return json({ erro: eSep.message }, 500);
  const shopeeRows = (seps || []).filter((s: any) => lojaDoCanal(s.marca_canal) && s.numero_ecommerce);

  const porLoja: Record<string, any[]> = {};
  for (const s of shopeeRows) porLoja[lojaDoCanal(s.marca_canal)!] = [...(porLoja[lojaDoCanal(s.marca_canal)!] || []), s];
  const alvos: { loja: string; shop_id: number; order_sn: string; buyer_user_id: number | null; buyer_username: string | null; produto: string | null }[] = [];
  const erros: string[] = [];
  for (const [nome, rows] of Object.entries(porLoja)) {
    const l = LOJAS[nome as keyof typeof LOJAS];
    let a: Auth;
    try { a = await authDaLoja(sb, l.shop_id); } catch (e) { erros.push(`${nome}: ${(e as Error).message}`); continue; }
    for (let i = 0; i < rows.length; i += 50) {
      const lote = rows.slice(i, i + 50);
      const r = await shopeeGet(a, "/api/v2/order/get_order_detail", {
        order_sn_list: lote.map((x: any) => x.numero_ecommerce).join(","),
        response_optional_fields: "buyer_user_id,buyer_username",
      });
      if (r.body?.error) { erros.push(`${nome} get_order_detail: ${r.body.error} ${r.body.message || ""}`); continue; }
      const porSn = new Map<string, any>((r.body?.response?.order_list || []).map((o: any) => [o.order_sn, o]));
      for (const x of lote) {
        const o = porSn.get(x.numero_ecommerce);
        alvos.push({ loja: nome, shop_id: l.shop_id, order_sn: x.numero_ecommerce,
          buyer_user_id: o?.buyer_user_id ?? null, buyer_username: o?.buyer_username ?? null, produto: x.nome_produto ?? null });
      }
      await sleep(250);
    }
  }

  if (modulo === "preview") {
    return json({ modulo, tag: tag || null, rotulo, pedidos_no_lote: (seps || []).length, pedidos_shopee: shopeeRows.length,
      com_buyer_id: alvos.filter((x) => x.buyer_user_id).length, alvos, erros });
  }

  if (modulo === "enviar") {
    const texto = (p("texto") || "").trim();
    if (!texto) return json({ erro: "informe o texto (body JSON {texto} ou ?texto=)" }, 400);
    if (p("confirmar") !== "1") {
      return json({ modulo, dry: true, rotulo, destinatarios: alvos.filter((x) => x.buyer_user_id).length, texto,
        aviso: "repita com confirmar=1 para ENVIAR de verdade", alvos: alvos.slice(0, 10), erros });
    }
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto))))
      .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

    // v3: so envio que DEU CERTO conta como "ja enviada".
    const { data: jaEnviadas } = await sb.from("shopee_mensagens")
      .select("order_sn").eq("texto_hash", hash).eq("ok", true).in("order_sn", alvos.map((x) => x.order_sn));
    const ja = new Set((jaEnviadas || []).map((x: any) => x.order_sn));

    const inicio = Date.now();
    let enviadas = 0, puladas = 0, abertasComPedido = 0;
    const falhas: any[] = [];
    const auths: Record<string, Auth> = {};
    for (const x of alvos) {
      if (Date.now() - inicio > 45000) { falhas.push({ order_sn: x.order_sn, erro: "timeout — rode de novo (dedupe pula as enviadas)" }); break; }
      if (!x.buyer_user_id) { puladas++; continue; }
      if (ja.has(x.order_sn)) { puladas++; continue; }
      if (!auths[x.loja]) auths[x.loja] = await authDaLoja(sb, x.shop_id);
      const { r, abriuComPedido } = await enviarTexto(auths[x.loja], x.buyer_user_id, x.order_sn, texto);
      if (abriuComPedido) abertasComPedido++;
      const ok = !r.body?.error;
      await sb.from("shopee_mensagens").insert({
        shop_id: x.shop_id, order_sn: x.order_sn, tag: rotulo, buyer_user_id: x.buyer_user_id, buyer_username: x.buyer_username,
        texto, texto_hash: hash, ok, resposta: JSON.stringify({ ...r.body, abriu_com_pedido: abriuComPedido }).slice(0, 400), enviado_por: p("por") || null,
      });
      if (ok) enviadas++;
      else {
        falhas.push({ order_sn: x.order_sn, erro: r.body?.error, msg: r.body?.message });
        if (/permission|scope|auth|rate|limit/i.test(`${r.body?.error} ${r.body?.message}`)) break;
      }
      await sleep(400);
    }
    return json({ modulo, rotulo, enviadas, puladas, abertas_com_pedido: abertasComPedido, falhas, total_alvos: alvos.length, tempo_ms: Date.now() - inicio });
  }

  return json({ modulos: ["probe", "conversas&loja=", "mensagens&loja=&conversa=", "preview (tag | order_sns)", "enviar&confirmar=1 (body {texto, tag|order_sns, rotulo})"] });
});
