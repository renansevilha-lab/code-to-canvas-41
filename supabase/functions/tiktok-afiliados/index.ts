// ============================================================================
// Edge Function: tiktok-afiliados v1 (18/nov/2026) — SONDA, SÓ LEITURA
// Pergunta do dono: "conseguimos acessar os Melhores Afiliados do TikTok da
// parte de Pets?". Testa a API de afiliados do vendedor (Affiliate Seller) com
// o token da loja Ottz/ACZ. Nenhuma escrita: só as chamadas da lista abaixo.
//
//   ?modulo=criadores[&ver=202406][&page_size=12][&page_token=]   body JSON = filtros (repassado como veio)
//        POST /affiliate_seller/{ver}/marketplace_creators/search
//   ?modulo=criador&id=<creator_user_id>[&ver=202406]
//        GET  /affiliate_seller/{ver}/marketplace_creators/{id}
//   ?modulo=categorias[&q=pet]
//        GET  /product/202309/categories  (ids e nomes; filtra pelo nome)
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

const VERSOES = new Set(["202405", "202406", "202409", "202412", "202501", "202505", "202508", "202509"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "criadores";
  const ver = url.searchParams.get("ver") || "202406";
  if (!VERSOES.has(ver)) return json({ erro: "versão não liberada nesta sonda" }, 400);
  const corte = Math.min(Number(url.searchParams.get("corte") || 6000) || 6000, 60000);
  try {
    const c = await contexto();
    if (modulo === "criadores") {
      let filtros: unknown = {};
      if (req.method === "POST") { try { filtros = await req.json(); } catch { filtros = {}; } }
      const q: Record<string, string> = { page_size: url.searchParams.get("page_size") || "12" };
      const pt = url.searchParams.get("page_token"); if (pt) q.page_token = pt;
      const r = await tt(c, "POST", `/affiliate_seller/${ver}/marketplace_creators/search`, q, filtros);
      return json({ modulo, ver, filtros, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    if (modulo === "criador") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(id)) return json({ erro: "informe id (creator_user_id)" }, 400);
      const r = await tt(c, "GET", `/affiliate_seller/${ver}/marketplace_creators/${id}`, {});
      return json({ modulo, ver, id, http: r.http, code: r.code, message: r.message, bytes: r.txt.length, cru: r.txt.slice(0, corte) });
    }
    if (modulo === "categorias") {
      const r = await tt(c, "GET", "/product/202309/categories", { locale: "pt-BR" });
      const alvo = (url.searchParams.get("q") || "pet").toLowerCase();
      // tira id e nome sem JSON.parse (ids grandes): {"id":"…", … "local_name":"…", "parent_id":"…"}
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
    return json({ erro: "modulo deve ser criadores | criador | categorias" }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
