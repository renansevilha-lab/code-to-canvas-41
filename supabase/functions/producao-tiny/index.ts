// ============================================================================
// producao-tiny v2 (28/out/2026) — Produção × Tiny. Decisão do dono (28/out): as matérias-primas (farinha,
// saco, etiqueta) ficam SÓ no app; ao Tiny vai apenas a ENTRADA do produto acabado no depósito GERAL
// (604130012, conta ottz) quando o lote é encerrado. Os depósitos Full nunca são tocados.
//   POST ?modulo=lote {ordem_id, confirmar?} → E do acabado (sacos bons × custo real do lote)
// Sem `confirmar` = prévia (lê o saldo do Geral ao vivo). Com `confirmar`: lança UMA vez (registro em
// producao_tiny_lanc, ok nunca repete). Acesso = módulo `galpao`.
// O custo do produto no Tiny (precoCusto) NÃO é alterado aqui — decisão do dono ainda em aberto.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const TINY = "https://api.tiny.com.br/public-api/v3";
const DEPOSITO_GERAL = 604130012;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Quem = { id: string; nome: string | null };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const g = await doUsuario.rpc("tem_modulo", { p_modulo: "galpao" });
  if (g.error || g.data !== true) return json({ erro: "sem acesso à Produção (módulo galpão)" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

/** Token da conta principal do Tiny (sempre `ottz`: nunca "o mais recente"). Leitura com 3 tentativas (504 no minuto cheio). */
async function tokenTiny(): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.from("oauth_tokens_tiny").select("access_token, expires_at").eq("conta", "ottz").limit(1).maybeSingle();
    if (!error && data) {
      if (new Date(data.expires_at as string) < new Date()) throw new Error("token do Tiny vencido — a renovação automática roda de 30 em 30 min; tente de novo em instantes");
      return String(data.access_token);
    }
    await sleep(800);
  }
  throw new Error("não consegui ler o token do Tiny (conta ottz)");
}
async function v3(token: string, metodo: string, path: string, corpo?: unknown) {
  for (let tentativa = 0; ; tentativa++) {
    const r = await fetch(`${TINY}${path}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { mensagem: txt.slice(0, 300) }; }
    await sleep(500);
    // 429 = o Tiny recusou SEM processar (limite por minuto): esperar e repetir é seguro.
    if (r.status === 429 && tentativa < 3) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(ra > 0 && ra <= 10 ? ra * 1000 : 2000 * (tentativa + 1));
      continue;
    }
    return { status: r.status, body };
  }
}
const erroV3 = (b: any) => [b?.mensagem, ...((b?.detalhes ?? []) as any[]).map((d) => `${d.campo}: ${d.mensagem}`)].filter(Boolean).join(" · ").slice(0, 400);
const agoraBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().replace("T", " ").slice(0, 19);

/** Saldo do depósito Geral, ao vivo (null = não deu para ler). */
async function saldoGeral(token: string, idProduto: number): Promise<number | null> {
  const r = await v3(token, "GET", `/estoque/${idProduto}`);
  if (r.status !== 200) return null;
  const deps = (r.body?.depositos ?? []) as any[];
  const dep = deps.find((d) => Number(d?.id) === DEPOSITO_GERAL) ?? deps.find((d) => /geral/i.test(String(d?.nome ?? "")));
  return dep ? num(dep.saldo) : null;
}

type Item = {
  papel: "acabado"; tipo: "E" | "S"; nome: string;
  tiny_produto_id: number | null; sku: string | null; quantidade: number; unidade: string; preco_un: number;
  ja_lancado?: boolean; saldo_hoje?: number | null; saldo_depois?: number | null; problema?: string | null;
};

async function jaLancados(origem: string, refId: number): Promise<Set<string>> {
  const { data } = await db.from("producao_tiny_lanc").select("papel").eq("origem", origem).eq("ref_id", refId).eq("ok", true);
  return new Set(((data ?? []) as any[]).map((x) => String(x.papel)));
}

async function itensDoLote(ordemId: number): Promise<{ codigo: string; itens: Item[]; erro?: string }> {
  const { data: o } = await db.from("producao_ordem").select("id, codigo, sku, status, qtd_boa_final").eq("id", ordemId).maybeSingle();
  if (!o) return { codigo: "", itens: [], erro: "lote não encontrado" };
  if (o.status !== "encerrada") return { codigo: o.codigo, itens: [], erro: `o lote ${o.codigo} ainda não foi encerrado` };
  const { data: l } = await db.from("view_producao_lote").select("custo_real_un").eq("id", ordemId).maybeSingle();
  const { data: p } = await db.from("produtos").select("sku, nome, id_tiny, unidade").eq("sku", o.sku).maybeSingle();
  const itens: Item[] = [{
    papel: "acabado", tipo: "E", nome: p?.nome ?? o.sku, tiny_produto_id: num(p?.id_tiny), sku: o.sku,
    quantidade: Number(o.qtd_boa_final ?? 0), unidade: p?.unidade ?? "UN", preco_un: Number(num(l?.custo_real_un) ?? 0),
    problema: p?.id_tiny ? null : `o SKU ${o.sku} não tem o código do Tiny no catálogo`,
  }];
  return { codigo: o.codigo, itens };
}

async function lancar(token: string, origem: "lote", refId: number, codigo: string, itens: Item[], quem: Quem, confirmar: boolean) {
  const ja = await jaLancados(origem, refId);
  const t0 = Date.now();
  for (const it of itens) {
    it.ja_lancado = ja.has(it.papel);
    if (it.ja_lancado || !it.tiny_produto_id) continue;
    if (Date.now() - t0 > 20_000) { it.problema = it.problema ?? "sem tempo nesta chamada: chame de novo"; continue; }
    it.saldo_hoje = await saldoGeral(token, it.tiny_produto_id);
    it.saldo_depois = it.saldo_hoje == null ? null : r3(it.saldo_hoje + (it.tipo === "E" ? it.quantidade : -it.quantidade));
  }
  const pendentes = itens.filter((i) => !i.ja_lancado);
  const bloqueio = pendentes.find((i) => !i.tiny_produto_id);
  if (!confirmar || bloqueio) return { ok: !bloqueio, previa: true, codigo, itens, pendentes: pendentes.length, bloqueio: bloqueio?.problema ?? null };

  let falhas = 0;
  for (const it of pendentes) {
    if (Date.now() - t0 > 24_000) { it.problema = "sem tempo nesta chamada: chame de novo"; falhas++; continue; }
    const corpo = {
      deposito: { id: DEPOSITO_GERAL }, tipo: it.tipo, data: agoraBRT(), quantidade: it.quantidade,
      precoUnitario: Math.round(it.preco_un * 10000) / 10000,
      observacoes: `Produção ${codigo} (${it.papel}) — app${quem.nome ? `, ${quem.nome}` : ""}`,
    };
    const r = await v3(token, "POST", `/estoque/${it.tiny_produto_id}`, corpo);
    const ok = r.status >= 200 && r.status < 300;
    await db.from("producao_tiny_lanc").insert({
      origem, ref_id: refId, papel: it.papel, tiny_produto_id: it.tiny_produto_id, sku: it.sku, tipo: it.tipo,
      quantidade: it.quantidade, preco_un: corpo.precoUnitario, ok, resposta: { status: r.status, body: r.body, enviado: corpo },
      lancado_por: quem.nome,
    });
    if (ok) it.ja_lancado = true; else { falhas++; it.problema = erroV3(r.body) || `o Tiny respondeu ${r.status}`; }
  }
  const tudo = itens.every((i) => i.ja_lancado);
  if (tudo) {
    const quando = new Date().toISOString();
    await db.from("producao_ordem").update({ tiny_lancado_em: quando, tiny_lancado_por: quem.nome, tiny_resultado: { itens } }).eq("id", refId);
  }
  return { ok: falhas === 0, previa: false, codigo, itens, falhas, completo: tudo };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") ?? "";
  let body: Record<string, any> = {};
  try { body = req.method === "POST" ? await req.json() : {}; } catch { /* sem corpo */ }
  const confirmar = body.confirmar === true || url.searchParams.get("confirmar") === "1";

  try {
    if (modulo === "lote") {
      const refId = Number(body.ordem_id);
      if (!(refId > 0)) return json({ erro: "informe o lote" }, 400);
      const dados = await itensDoLote(refId);
      if (dados.erro) return json({ erro: dados.erro }, 409);
      const token = await tokenTiny();
      return json(await lancar(token, "lote", refId, dados.codigo, dados.itens, quem, confirmar));
    }
    return json({ erro: "módulo desconhecido (lote)" }, 400);
  } catch (e) {
    return json({ erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});
