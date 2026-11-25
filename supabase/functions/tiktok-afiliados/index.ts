// ============================================================================
// Edge Function: tiktok-afiliados v5 (25/nov/2026; v1 de 18/nov) — afiliados do TikTok Shop (loja ACZ)
// Leitura (criadores, detalhe, pedidos de afiliado, colaborações, amostras, conversas) e ESCRITA
// (mensagem e convite a criadores) — a escrita só com `confirmar: true` + login com o módulo ads.
//
//   ?modulo=criadores[&ver=202508][&page_size=12][&page_token=]   body JSON = filtros (repassado como veio)
//        POST /affiliate_seller/{ver}/marketplace_creators/search
//   ?modulo=criador&id=<creator_open_id>[&ver=202508]
//        GET  /affiliate_seller/{ver}/marketplace_creators/{id}
//   ?modulo=ler&alvo=pedidos|abertas|direcionadas|amostras|produtos[&page_size=][&page_token=]
//        buscas SÓ DE LEITURA (body JSON = filtros)
//   ?modulo=get&caminho=/affiliate_seller/<ver>/...&q_<param>=   GET de leitura (descobrir versões)
//   ?modulo=validar&caminho=...   POST com todo id trocado por "0" (descobrir campos; nada é criado)
//   ?modulo=conversas[&page_token=]   conversas com criadores + mensagens + criador deduzido
//   ?modulo=mensagem   body {creator_open_id | conversation_id, username?, texto, confirmar?}
//   ?modulo=convite    body {nome, mensagem, fim, criadores[], produtos[{id, comissao_pct}], email,
//                            amostra_gratis, amostra_sem_aprovacao, confirmar?}
//   ?modulo=carregar-criadores&chave=   carga do retrato de criadores (chave de ensaio, vence 26/nov)
//   ?modulo=categorias[&q=pet]
//
// A resposta do TikTok volta CRUA em `cru` (texto, cortado) — ids do TikTok não
// cabem em número do JavaScript — e resumida em `http` / `code` / `message`.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const APP_KEY = (Deno.env.get("TIKTOK_APP_KEY") || "").trim();
const APP_SECRET = (Deno.env.get("TIKTOK_APP_SECRET") || "").trim();
const TT_HOST = "https://open-api.tiktokglobalshop.com";
const SHOP_ID = "7496181924415506972"; // TikTok (ACZ Pet) — a única loja conectada
const db = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function assinar(path: string, params: Record<string, string>, body = ""): Promise<string> {
  const chaves = Object.keys(params).filter((k) => k !== "sign" && k !== "access_token").sort();
  return await hmacHex(APP_SECRET, APP_SECRET + path + chaves.map((k) => k + params[k]).join("") + body + APP_SECRET);
}

async function contexto() {
  if (!APP_KEY || !APP_SECRET) throw new Error("faltam os secrets TIKTOK_APP_KEY / TIKTOK_APP_SECRET");
  const { data: l } = await db.from("tiktok_lojas").select("shop_cipher, open_id").eq("shop_id", SHOP_ID).maybeSingle();
  if (!l?.shop_cipher) throw new Error("loja do TikTok não encontrada em tiktok_lojas");
  const { data: t } = await db.from("oauth_tokens_tiktok").select("access_token, access_expires_at").eq("open_id", l.open_id).maybeSingle();
  if (!t?.access_token) throw new Error("token do TikTok não encontrado");
  if (t.access_expires_at && Date.parse(String(t.access_expires_at)) < Date.now()) throw new Error("o token do TikTok venceu: rode o tiktok-refresh-token");
  return { token: String(t.access_token), cipher: String(l.shop_cipher) };
}

async function tt(c: { token: string; cipher: string }, metodo: "GET" | "POST", path: string, query: Record<string, string>, corpo?: unknown) {
  const params: Record<string, string> = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: c.cipher, ...query };
  const bodyStr = corpo === undefined ? "" : JSON.stringify(corpo);
  params.sign = await assinar(path, params, bodyStr);
  const url = new URL(TT_HOST + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { method: metodo, headers: { "x-tts-access-token": c.token, "Content-Type": "application/json" }, body: bodyStr || undefined });
  const txt = await r.text();
  let code: unknown = null, message: unknown = null;
  try { const j = JSON.parse(txt); code = j?.code; message = j?.message; } catch { /* resposta não é JSON */ }
  return { http: r.status, code, message, txt };
}

// Buscas de leitura (todas POST …/search, não alteram nada). Versões conferidas ao vivo em 24/nov/2026.
const LEITURAS: Record<string, string> = {
  pedidos: "/affiliate_seller/202410/orders/search",
  abertas: "/affiliate_seller/202412/open_collaborations/search",
  direcionadas: "/affiliate_seller/202508/target_collaborations/search", // corpo exige {"collaboration_status":"ONGOING"}
  amostras: "/affiliate_seller/202508/sample_applications/search",
  produtos: "/affiliate_seller/202405/open_collaborations/products/search",
};

// v5 (25/nov/2026): ESCRITA — mensagem e convite a criadores. Caminhos e campos descobertos ao vivo
// (corpo com ids zerados, nada criado): conversa POST /202508/conversations {creator_open_id,
// only_need_conversation_id}; mensagem POST /202412/conversations/{id}/messages {msg_type:"TEXT",
// content:"{\"content\":\"...\"}"}; convite POST /202508/target_collaborations {name, message, end_time,
// products[{id, target_commission_rate (1500 = 15%)}], creator_user_open_ids[], seller_contact_info{email},
// free_sample_rule{has_free_sample, is_sample_approval_exempt}}. Leitura: GET /202412/conversations e
// GET /202412/conversation/{id}/messages (singular).
const ESCRITA = {
  conversa: "/affiliate_seller/202508/conversations",
  mensagem: (id: string) => `/affiliate_seller/202412/conversations/${id}/messages`,
  convite: "/affiliate_seller/202508/target_collaborations",
};
// Ensaio sem login: só para os criadores em TESTE_ALVOS e até TESTE_ATE (vazio = desligado).
const TESTE_CHAVE = "afil-ensaio-25nov-k7q2";
const TESTE_ATE = Date.parse("2026-11-26T03:00:00Z");
const TESTE_ALVOS = new Set<string>([]);

async function quemEnvia(req: Request, alvos: string[], url: URL): Promise<{ nome: string } | { erro: string }> {
  const chave = url.searchParams.get("chave") || "";
  if (chave) {
    if (chave !== TESTE_CHAVE || Date.now() > TESTE_ATE) return { erro: "chave de ensaio inválida ou vencida" };
    if (!alvos.length || alvos.some((a) => !TESTE_ALVOS.has(a))) return { erro: "criador fora da lista de ensaio" };
    return { nome: "ensaio (Claude, com OK do dono)" };
  }
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await db.auth.getUser(tok);
  if (!u?.user) return { erro: "faça login no app para enviar" };
  const { data: p } = await db.from("perfis_usuario").select("nome, ativo, modulos").eq("user_id", u.user.id).maybeSingle();
  const mods: string[] = (p?.modulos as string[]) || [];
  if (!p?.ativo || !(mods.includes("ads") || mods.includes("todos"))) return { erro: "seu usuário não tem o módulo ADS" };
  return { nome: String(p.nome || u.user.email || u.user.id) };
}

async function registrar(etapa: string, status: number, resultado: unknown) {
  try { await db.from("debug_fulfillment").insert({ modulo: "tiktok-afiliados-envio", etapa, status_http: status, resultado }); } catch { /* melhor-esforço */ }
}

const VERSOES = new Set(["202405", "202406", "202409", "202412", "202501", "202505", "202508", "202509"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "criadores";
  const ver = url.searchParams.get("ver") || "202508"; // criadores: só a 202508 existe
  if (!VERSOES.has(ver)) return json({ erro: "versão não liberada nesta sonda" }, 400);
  const corte = Math.min(Number(url.searchParams.get("corte") || 6000) || 6000, 60000);
  try {
    // carga não precisa do token do TikTok
    if (modulo === "carregar-criadores") {
      if (url.searchParams.get("chave") !== TESTE_CHAVE || Date.now() > TESTE_ATE) return json({ erro: "chave inválida ou vencida" }, 401);
      const linhas = await req.json().catch(() => []) as Array<Record<string, unknown>>;
      if (!Array.isArray(linhas) || !linhas.length || linhas.length > 2000) return json({ erro: "mande uma lista de criadores" }, 400);
      const reg = linhas.filter((d) => d.id && d.u).map((d) => {
        const { id, u, n, seg, nivel, gmv, pets, gmvPets, ...resto } = d;
        return { open_id: String(id), username: String(u), nome: n ?? null, seguidores: seg ?? null, nivel: nivel ?? null, vendas_brl: gmv ?? null, parte_pets: pets ?? null, vendas_pets_brl: gmvPets ?? null, dados: resto, atualizado_em: new Date().toISOString() };
      });
      const { error } = await db.from("tiktok_afiliados_criadores").upsert(reg, { onConflict: "open_id" });
      return json({ modulo, gravados: error ? 0 : reg.length, erro: error?.message ?? null }, error ? 500 : 200);
    }
    const c = await contexto();
    if (modulo === "criadores") {
      let filtros: unknown = {};
      if (req.method === "POST") { try { filtros = await req.json(); } catch { filtros = {}; } }
      const q: Record<string, string> = { page_size: url.searchParams.get("page_size") || "12" };
      const pt = url.searchParams.get("page_token"); if (pt) q.page_token = pt;
      const r = await tt(c, "POST", `/affiliate_seller/${ver}/marketplace_creators/search`, q, filtros);
      return json({ modulo, ver, filtros, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    // v2: tentativa agendada (cron de um dia só). UMA chamada à busca; grava a resposta em
    // debug_fulfillment (modulo tiktok-afiliados, etapa busca) e avisa no Discord (#atualizacoes)
    if (modulo === "tentar") {
      const r = await tt(c, "POST", `/affiliate_seller/${ver}/marketplace_creators/search`, { page_size: "20" }, {});
      const n = (r.txt.match(/"creator_open_id"|"open_id"|"username"/g) || []).length;
      await db.from("debug_fulfillment").insert({ modulo: "tiktok-afiliados", etapa: "busca", status_http: r.code === 0 ? 200 : r.http, resultado: { code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, 30000) } });
      const avisar = async (nivel: string, titulo: string, descricao: string) => {
        try {
          await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/discord-notify`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
            body: JSON.stringify({ canal: "atualizacoes", nivel, titulo, descricao, rodape: "tiktok-afiliados · tentativa agendada" }),
          });
        } catch { /* melhor-esforço */ }
      };
      if (r.code === 0) await avisar("ok", "TikTok: a busca de afiliados respondeu", `A API devolveu dados na tentativa agendada (${r.txt.length} bytes${n ? `, ~${n} campos de criador` : ""}). Peça ao Claude para levantar os filtros e montar a lista de afiliados de Pets.`);
      else if (url.searchParams.get("ultima") === "1") await avisar("aviso", "TikTok: busca de afiliados continua bloqueada", `Todas as tentativas de hoje voltaram: ${String(r.message ?? r.http).slice(0, 220)}. Próximo passo: chamado no Partner Center do TikTok perguntando a cota da busca de criadores.`);
      return json({ modulo, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, gravado: true });
    }
    if (modulo === "ler") {
      const alvo = url.searchParams.get("alvo") || "";
      const livre = url.searchParams.get("caminho") || "";
      const path = new RegExp("^/affiliate_seller/20[0-9]{4}/[a-z_/]+/search$").test(livre) ? livre : LEITURAS[alvo];
      if (!path) return json({ erro: "alvo deve ser " + Object.keys(LEITURAS).join(" | ") }, 400);
      let filtros: unknown = {};
      if (req.method === "POST") { try { filtros = await req.json(); } catch { filtros = {}; } }
      const q: Record<string, string> = { page_size: url.searchParams.get("page_size") || "10" };
      const pt = url.searchParams.get("page_token"); if (pt) q.page_token = pt;
      const r = await tt(c, "POST", path, q, filtros);
      return json({ modulo, alvo, path, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    if (modulo === "get") {
      const livre = url.searchParams.get("caminho") || "";
      if (!new RegExp("^/affiliate_seller/20[0-9]{4}/[A-Za-z0-9_/-]+$").test(livre)) return json({ erro: "caminho inválido" }, 400);
      const q: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k.startsWith("q_")) q[k.slice(2)] = v;
      const r = await tt(c, "GET", livre, q);
      return json({ modulo, path: livre, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    // POST num caminho de escrita com TODO id trocado por "0" (chave com "id", ou 6+ dígitos):
    // serve só para o TikTok dizer quais campos exige; nenhum criador/produto/conversa real é alcançado.
    if (modulo === "validar") {
      const livre = url.searchParams.get("caminho") || "";
      if (!new RegExp("^/affiliate_seller/20[0-9]{4}/[A-Za-z0-9_/-]+$").test(livre)) return json({ erro: "caminho inválido" }, 400);
      let corpo: unknown = {};
      if (req.method === "POST") { try { corpo = await req.json(); } catch { corpo = {}; } }
      const anular = (v: unknown, chave = ""): unknown => {
        if (Array.isArray(v)) return v.map((x) => anular(x, chave));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, anular(x, k)]));
        if (/id/i.test(chave) || /^\d{6,}$/.test(String(v))) return "0";
        return v;
      };
      const seguro = anular(corpo);
      const r = await tt(c, "POST", livre, {}, seguro);
      return json({ modulo, path: livre, enviado: seguro, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    // ---------------- conversas (leitura) ----------------
    if (modulo === "conversas") {
      const q: Record<string, string> = { page_size: url.searchParams.get("page_size") || "20" };
      const pt = url.searchParams.get("page_token"); if (pt) q.page_token = pt;
      const r = await tt(c, "GET", "/affiliate_seller/202412/conversations", q);
      if (r.code !== 0) return json({ modulo, http: r.http, code: r.code, message: r.message }, 502);
      const ids = [...r.txt.matchAll(/"id":"(\d+)"/g)].map((m) => m[1]);
      const prox = /"next_page_token":"([^"]*)"/.exec(r.txt)?.[1] || "";
      // criador por pedido de amostra (apply_id do cartão de amostra) e pela tabela do app
      const amostra = new Map<string, { open_id: string; username: string; nome: string }>();
      let tk = "";
      for (let p = 0; p < 6; p++) {
        const a = await tt(c, "POST", "/affiliate_seller/202508/sample_applications/search", { page_size: "20", ...(tk ? { page_token: tk } : {}) }, {});
        if (a.code !== 0) break;
        try {
          const d = JSON.parse(a.txt).data;
          for (const s of d.sample_applications || []) amostra.set(String(s.id), { open_id: s.creator?.creator_open_id, username: s.creator?.username, nome: s.creator?.nickname });
          tk = d.next_page_token || "";
        } catch { break; }
        if (!tk) break;
      }
      const { data: mapa } = await db.from("tiktok_afiliados_conversas").select("conversation_id, open_id, username").in("conversation_id", ids.length ? ids : ["-"]);
      const doApp = new Map((mapa || []).map((m) => [String(m.conversation_id), m]));
      const conversas = [];
      for (const id of ids) {
        const m = await tt(c, "GET", `/affiliate_seller/202412/conversation/${id}/messages`, { page_size: "20" });
        const msgs: Array<{ id: string; remetente: string; tipo: string; texto: string; quando: number; apply_id?: string }> = [];
        try {
          for (const x of JSON.parse(m.txt).data?.messages || []) {
            const b = x.message_body || {};
            let cont: Record<string, unknown> = {};
            try { cont = JSON.parse(String(b.content || "{}")); } catch { /* não é JSON */ }
            msgs.push({ id: String(b.id), remetente: String(b.sender_id), tipo: String(b.type), texto: String(cont.content ?? ""), quando: Number(b.create_time), apply_id: cont.apply_id ? String(cont.apply_id) : undefined });
          }
        } catch { /* resposta fora do formato */ }
        msgs.sort((a, b) => a.quando - b.quando);
        const ap = msgs.find((x) => x.apply_id)?.apply_id;
        const crit = doApp.get(id) || (ap ? amostra.get(ap) : undefined) || null;
        conversas.push({ id, criador: crit, mensagens: msgs, erro: m.code === 0 ? null : m.message });
      }
      return json({ modulo, proxima: prox, conversas });
    }
    // ---------------- mensagem a um criador ----------------
    if (modulo === "mensagem") {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const texto = String(b.texto || "").trim();
      const criador = String(b.creator_open_id || "").trim();
      let conversa = String(b.conversation_id || "").trim();
      if (!texto) return json({ erro: "escreva a mensagem" }, 400);
      if (texto.length > 2000) return json({ erro: "mensagem acima de 2.000 caracteres" }, 400);
      if (!criador && !conversa) return json({ erro: "informe creator_open_id ou conversation_id" }, 400);
      const previa = { criador: criador || null, conversa: conversa || null, texto };
      if (b.confirmar !== true) return json({ modulo, previa: true, vai_enviar: previa });
      const quem = await quemEnvia(req, [criador || conversa], url);
      if ("erro" in quem) return json(quem, 401);
      if (!conversa) {
        const cv = await tt(c, "POST", ESCRITA.conversa, {}, { creator_open_id: criador, only_need_conversation_id: true });
        conversa = /"conversation_id":"(\d+)"/.exec(cv.txt)?.[1] || /"id":"(\d+)"/.exec(cv.txt)?.[1] || "";
        await registrar(`conversa:${criador}`, cv.code === 0 ? 200 : cv.http, { quem: quem.nome, code: cv.code, message: cv.message, cru: cv.txt.slice(0, 2000) });
        if (cv.code !== 0 || !conversa) return json({ erro: "o TikTok não abriu a conversa", code: cv.code, message: cv.message, cru: cv.txt.slice(0, 1000) }, 502);
        await db.from("tiktok_afiliados_conversas").upsert({ conversation_id: conversa, open_id: criador, username: String(b.username || "") || null, aberta_por: quem.nome });
      }
      const r = await tt(c, "POST", ESCRITA.mensagem(conversa), {}, { msg_type: "TEXT", content: JSON.stringify({ content: texto }) });
      await registrar(`mensagem:${conversa}`, r.code === 0 ? 200 : r.http, { quem: quem.nome, criador, texto, code: r.code, message: r.message, cru: r.txt.slice(0, 2000) });
      return json({ modulo, enviado: r.code === 0, conversa, code: r.code, message: r.message, cru: r.txt.slice(0, 1000) }, r.code === 0 ? 200 : 502);
    }
    // ---------------- convite (colaboração direcionada) ----------------
    if (modulo === "convite") {
      const b = await req.json().catch(() => ({})) as Record<string, unknown>;
      const criadores = (Array.isArray(b.criadores) ? b.criadores : []).map((x) => String(x).trim()).filter(Boolean);
      const produtos = (Array.isArray(b.produtos) ? b.produtos : []) as Array<Record<string, unknown>>;
      const fim = String(b.fim || "");
      const pend: string[] = [];
      if (!String(b.nome || "").trim()) pend.push("nome do convite");
      if (!String(b.mensagem || "").trim()) pend.push("mensagem do convite");
      if (!criadores.length) pend.push("ao menos um criador");
      if (!produtos.length) pend.push("ao menos um produto");
      if (!/^\S+@\S+\.\S+$/.test(String(b.email || ""))) pend.push("e-mail de contato da loja");
      const fimTs = /^\d{4}-\d{2}-\d{2}$/.test(fim) ? Math.floor(Date.parse(fim + "T23:59:59-03:00") / 1000) : 0;
      if (!fimTs || fimTs * 1000 < Date.now() + 86400000) pend.push("data final (a partir de amanhã)");
      const prods = produtos.map((p) => ({ id: String(p.id || ""), target_commission_rate: Math.round(Number(p.comissao_pct || 0) * 100) }));
      if (prods.some((p) => !/^\d{6,}$/.test(p.id) || p.target_commission_rate < 100 || p.target_commission_rate > 8000)) pend.push("produto com id ou comissão inválida (1% a 80%)");
      const corpo = {
        name: String(b.nome || "").trim().slice(0, 100),
        message: String(b.mensagem || "").trim().slice(0, 500),
        end_time: String(fimTs),
        products: prods,
        creator_user_open_ids: criadores,
        seller_contact_info: { email: String(b.email || "") },
        free_sample_rule: { has_free_sample: b.amostra_gratis === true, is_sample_approval_exempt: b.amostra_sem_aprovacao === true },
      };
      if (pend.length || b.confirmar !== true) return json({ modulo, previa: true, pendencias: pend, vai_enviar: corpo });
      const quem = await quemEnvia(req, criadores, url);
      if ("erro" in quem) return json(quem, 401);
      const r = await tt(c, "POST", ESCRITA.convite, {}, corpo);
      await registrar(`convite:${criadores.join(",").slice(0, 200)}`, r.code === 0 ? 200 : r.http, { quem: quem.nome, corpo, code: r.code, message: r.message, cru: r.txt.slice(0, 3000) });
      return json({ modulo, enviado: r.code === 0, code: r.code, message: r.message, cru: r.txt.slice(0, 2000) }, r.code === 0 ? 200 : 502);
    }
    if (modulo === "criador") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) return json({ erro: "informe id (creator_open_id)" }, 400);
      const r = await tt(c, "GET", `/affiliate_seller/${ver}/marketplace_creators/${id}`, {});
      return json({ modulo, ver, id, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    if (modulo === "categorias") {
      const r = await tt(c, "GET", "/product/202309/categories", { locale: "pt-BR" });
      const alvo = (url.searchParams.get("q") || "pet").toLowerCase();
      const itens: Array<{ id: string; pai: string; nome: string; folha: boolean }> = [];
      const re = /\{[^{}]*?"id":"(\d+)"[^{}]*?\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(r.txt))) {
        const bloco = m[0];
        const nome = /"local_name":"([^"]*)"/.exec(bloco)?.[1] ?? "";
        const pai = /"parent_id":"(\d+)"/.exec(bloco)?.[1] ?? "";
        itens.push({ id: m[1], pai, nome, folha: /"is_leaf":true/.test(bloco) });
      }
      const raizes = itens.filter((i) => i.pai === "0" || i.pai === "");
      const bate = itens.filter((i) => i.nome.toLowerCase().includes(alvo) || i.nome.toLowerCase().includes("animal") || i.nome.toLowerCase().includes("estima"));
      return json({ modulo, http: r.http, code: r.code, message: r.message, total: itens.length, raizes, com_o_termo: bate.slice(0, 60) });
    }
    return json({ erro: "modulo deve ser criadores | criador | ler | get | validar | conversas | mensagem | convite | categorias" }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
