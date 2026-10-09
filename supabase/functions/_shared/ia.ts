// =============================================================================
// IA · Anúncios (Fase 2, 09/out/2026) — código comum das edge fns `ia-anuncio`
// e `ia-imagem-worker`. Porte do gerador (projeto pcobdzlpnaoqdbsdzhlq,
// gerar-briefing v8 / gerar-texto v12 / gerar-prompts-imagem v5 / gerar-imagens
// v17 / gerar-imagem-worker v2) para as tabelas ia_* da gestão.
// Deploy via MCP: este arquivo vai junto, como `_shared/ia.ts`, nas duas fns.
// =============================================================================
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const BUCKET = "ia-anuncios";
export const BUCKET_CTX = "ia-contexto";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export function json(o: unknown, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });
}

export type DB = SupabaseClient;
export type Bloco = Record<string, unknown>;
export const sb = (): DB => createClient(SB_URL, SERVICE_KEY);

// ---------------------------------------------------------------- acesso
export type Quem = { id: string | null; email: string | null; servico: boolean };

/** Exige JWT de usuário com o módulo `ia` (ou service role, chamadas internas). */
export async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SERVICE_KEY) return { id: null, email: null, servico: true };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { id: null, email: null, servico: true };
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON_KEY || SERVICE_KEY, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  return { id: String(pl.sub ?? ""), email: (pl.email as string) ?? null, servico: false };
}

// ---------------------------------------------------------------- utilidades
export function b64(buf: Uint8Array): string {
  let bin = "";
  const CH = 8192;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(bin);
}
export function deB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function extDoMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}
/** Troca {{var}} pelo valor; vazio vira "(nao informado)" — mesma regra do gerador. */
export function preencher(tpl: string, vars: Record<string, unknown>, identar = true): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    if (v === null || v === undefined || v === "") return "(nao informado)";
    return typeof v === "object" ? JSON.stringify(v, null, identar ? 2 : 0) : String(v);
  });
}

// ---------------------------------------------------------------- produto
export type Produto = {
  sku: string; nome: string; marca: string | null; categoria: string | null; categoria_folha: string | null;
  eh_kit: boolean; foto_url: string | null; custo: number | null;
  publico_alvo: string | null; foto_ref_path: string | null; fotos_ref: string[];
  atributos: Record<string, unknown>;
};

/** Produto do catálogo da gestão (Tiny) + dados próprios da IA (ia_produto_extra). */
export async function carregarProduto(db: DB, sku: string): Promise<Produto | null> {
  const [ip, pr, ex, cmv, kit] = await Promise.all([
    db.from("ia_produto").select("sku, nome, marca, categoria_caminho, categoria_folha, tipo, foto").eq("sku", sku).maybeSingle(),
    db.from("produtos").select("peso_bruto, peso_liquido, fornecedor, foto_capa").eq("sku", sku).maybeSingle(),
    db.from("ia_produto_extra").select("*").eq("sku", sku).maybeSingle(),
    db.from("view_cmv_efetivo").select("cmv_efetivo").eq("sku", sku).maybeSingle(),
    db.from("produto_kits").select("sku_componente, nome_componente, quantidade").eq("sku_kit", sku),
  ]);
  if (!ip.data) return null;
  const p = ip.data as Record<string, any>;
  const ehKit = p.tipo === "K";
  const componentes = ehKit
    ? ((kit.data ?? []) as Record<string, any>[]).map((c) => ({ sku: c.sku_componente, nome: c.nome_componente, quantidade: Number(c.quantidade) }))
    : [];
  const atributos: Record<string, unknown> = {
    tipo: ehKit ? "kit" : "produto",
    categoria_caminho: p.categoria_caminho ?? null,
    peso_bruto_kg: pr.data?.peso_bruto ?? null,
    peso_liquido_kg: pr.data?.peso_liquido ?? null,
  };
  if (componentes.length) atributos.componentes = componentes;
  for (const k of Object.keys(atributos)) if (atributos[k] == null) delete atributos[k];
  return {
    sku, nome: p.nome, marca: p.marca ?? null, categoria: p.categoria_caminho ?? p.categoria_folha ?? null,
    categoria_folha: p.categoria_folha ?? null, eh_kit: ehKit,
    foto_url: p.foto ?? pr.data?.foto_capa ?? null,
    custo: cmv.data?.cmv_efetivo != null ? Number(cmv.data.cmv_efetivo) : null,
    publico_alvo: ex.data?.publico_alvo ?? null,
    foto_ref_path: ex.data?.foto_ref_path ?? null,
    fotos_ref: (ex.data?.fotos_ref ?? []) as string[],
    atributos,
  };
}

export type Foto = { media_type: string; data: string; bytes: Uint8Array; origem: string };

async function baixarUrl(url: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const mime = (r.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.byteLength < 1000 || bytes.byteLength > 5_000_000) return null;
    return { mime, bytes };
  } catch { return null; }
}

/**
 * Foto real de referência — UMA fonte só: a cópia congelada no bucket
 * (ia_produto_extra.foto_ref_path). Sem cópia, baixa a foto do catálogo
 * (Tiny primeiro, view_foto_produto), congela em ref/{sku}/0.ext e grava o caminho.
 * O gerador tinha 3 fontes diferentes (briefing lia a URL, texto a cópia, worker
 * copiava 4 fotos) — aqui todas as etapas veem a mesma imagem.
 */
export async function fotoReferencia(db: DB, p: Produto): Promise<Foto | null> {
  if (p.foto_ref_path) {
    const dl = await db.storage.from(BUCKET).download(p.foto_ref_path);
    if (!dl.error && dl.data) {
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const mime = (dl.data.type || "image/jpeg").split(";")[0];
      return { media_type: mime, data: b64(bytes), bytes, origem: p.foto_ref_path };
    }
  }
  if (!p.foto_url) return null;
  const f = await baixarUrl(p.foto_url);
  if (!f) return null;
  const path = `ref/${p.sku}/0.${extDoMime(f.mime)}`;
  const up = await db.storage.from(BUCKET).upload(path, f.bytes, { contentType: f.mime, upsert: true });
  if (!up.error) {
    await db.from("ia_produto_extra").upsert({ sku: p.sku, foto_ref_path: path, fotos_ref: [path] }, { onConflict: "sku" });
    p.foto_ref_path = path;
  }
  return { media_type: f.mime, data: b64(f.bytes), bytes: f.bytes, origem: up.error ? p.foto_url : path };
}

// ---------------------------------------------------------------- prompts / regras
export type Template = { id: string; nome: string; tipo: string; canal: string | null; versao: number; conteudo: string; modelo: string | null };
export type Guardrail = { nome: string; tipo: string; padrao: string; substituto: string | null; acao: string };

/** Templates ativos (sem os backups `__bkp_*`), maior versão primeiro. */
export async function templatesAtivos(db: DB, tipos: string[]): Promise<Template[]> {
  const { data } = await db.from("ia_prompt_template").select("id, nome, tipo, canal, versao, conteudo, modelo")
    .eq("ativo", true).in("tipo", tipos).order("versao", { ascending: false });
  return ((data ?? []) as Template[]).filter((t) => !t.nome.startsWith("__bkp"));
}
/** Template do canal; senão o geral (canal nulo). */
export function escolherTemplate(tpls: Template[], tipo: string, canal: string | null): Template | undefined {
  const c = tpls.filter((t) => t.tipo === tipo);
  return (canal ? c.find((t) => t.canal === canal) : undefined) ?? c.find((t) => t.canal == null);
}
export async function guardrails(db: DB): Promise<Guardrail[]> {
  const { data } = await db.from("ia_prompt_guardrail").select("nome, tipo, padrao, substituto, acao").eq("ativo", true);
  return (data ?? []) as Guardrail[];
}
export function blocoInstrucoes(gs: Guardrail[]): string {
  const inst = gs.filter((g) => g.tipo === "instrucao");
  return inst.length ? "REGRAS OBRIGATORIAS:\n" + inst.map((g) => "- " + g.padrao).join("\n") : "";
}
/** Só as regras de IMAGEM (as de texto poluíam o prompt de imagem — lição do gerador). */
export function regrasImagem(gs: Guardrail[]): string {
  return gs.filter((g) => g.tipo === "instrucao" && (g.padrao.startsWith("IMAGEM:") || g.nome === "inst_formato_produto"))
    .map((g) => "- " + g.padrao).join("\n");
}
export function validar(texto: string, gs: Guardrail[]) {
  let saida = texto;
  const bloqueios: string[] = []; const avisos: string[] = [];
  for (const g of gs) {
    if (g.tipo === "instrucao") continue;
    let re: RegExp;
    try {
      re = g.tipo === "regex" ? new RegExp(g.padrao, "giu") : new RegExp(g.padrao.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch { continue; }
    if (!re.test(saida)) continue;
    re.lastIndex = 0;
    if (g.acao === "bloquear") bloqueios.push(g.nome);
    else if (g.acao === "substituir" && g.substituto) saida = saida.replace(re, g.substituto);
    else if (g.acao === "avisar") avisos.push(g.nome);
  }
  return { texto: saida, bloqueios, avisos };
}

// ---------------------------------------------------------------- contextos
type Ctx = { nome: string; escopo: string; chave: string | null; tipo: string; conteudo: string | null; storage_path: string | null; media_type: string | null; papel: string };

/**
 * Contextos do SKU (RPC ia_contextos_do_sku) — os anexos são baixados UMA vez por
 * chamada e reaproveitados (o gerador baixava de novo para título, descrição e bullets).
 */
export async function carregarContextos(db: DB, sku: string, aplicaEm: string[]) {
  const porAplica: Record<string, Ctx[]> = {};
  await Promise.all(aplicaEm.map(async (a) => {
    const { data } = await db.rpc("ia_contextos_do_sku", { p_sku: sku, p_aplica_em: a });
    porAplica[a] = (data ?? []) as Ctx[];
  }));
  const anexos = new Map<string, { mime: string; data: string }>();
  const caminhos = new Set<string>();
  for (const l of Object.values(porAplica)) for (const c of l) if (c.tipo !== "texto" && c.storage_path) caminhos.add(c.storage_path);
  await Promise.all([...caminhos].map(async (path) => {
    const dl = await db.storage.from(BUCKET_CTX).download(path);
    if (dl.error || !dl.data) return;
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    anexos.set(path, { mime: (dl.data.type || "application/pdf").split(";")[0], data: b64(bytes) });
  }));
  return { porAplica, anexos };
}

/** Contextos no formato de blocos da Anthropic (texto + imagem/PDF). */
export function blocosContexto(lista: Ctx[], anexos: Map<string, { mime: string; data: string }>) {
  const blocos: Bloco[] = []; const textos: string[] = []; const usados: string[] = [];
  for (const c of lista) {
    if (c.tipo === "texto") {
      textos.push(`[${c.escopo}${c.chave ? ": " + c.chave : ""}] ${c.nome}\n${c.conteudo ?? ""}`);
      usados.push(c.nome);
      continue;
    }
    const a = c.storage_path ? anexos.get(c.storage_path) : undefined;
    if (!a) continue;
    const mt = c.media_type ?? a.mime;
    blocos.push(mt === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mt, data: a.data } }
      : { type: "image", source: { type: "base64", media_type: mt, data: a.data } });
    blocos.push({ type: "text", text: `Acima: ${c.nome} (contexto de ${c.escopo}${c.chave ? " " + c.chave : ""}, papel: ${c.papel}). Siga as diretrizes deste material.` });
    usados.push(c.nome);
  }
  return { blocos, texto: textos.join("\n\n"), usados };
}

// ---------------------------------------------------------------- Anthropic
export async function claude(modelo: string, blocos: Bloco[], maxTokens: number): Promise<string> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY não cadastrada nos secrets do Supabase da gestão");
  for (let t = 0; t < 3; t++) {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: modelo, max_tokens: maxTokens, messages: [{ role: "user", content: blocos }] }),
    });
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && t < 2) { await new Promise((ok) => setTimeout(ok, 2000 * (t + 1))); continue; }
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    return ((d.content ?? []) as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  }
  throw new Error("Anthropic indisponível");
}
export const modeloTexto = (tpl?: { modelo: string | null } | null) => Deno.env.get("MODELO_TEXTO") ?? tpl?.modelo ?? "claude-sonnet-4-6";

/** Lista de fotos (templates imagem_*) a partir do pedido, do briefing ou do plano do canal. */
export function planoFotos(pedidas: string[] | null, recomendadas: unknown, planoCanal: unknown, ativos: Set<string>, ehKit: boolean) {
  const norm = (f: string) => (f.startsWith("imagem_") ? f : `imagem_${f}`);
  const rec = Array.isArray(recomendadas) ? (recomendadas as string[]).map(norm) : [];
  const canal = Array.isArray(planoCanal) ? (planoCanal as string[]).map(norm) : [];
  let alvo = pedidas && pedidas.length ? pedidas.map(norm) : (rec.length ? rec : canal);
  const ignoradas = alvo.filter((f) => !ativos.has(f));
  alvo = [...new Set(alvo.filter((f) => ativos.has(f)))];
  if (!ehKit) alvo = alvo.filter((f) => f !== "imagem_kit");
  return { alvo, ignoradas, planoCanal: canal };
}

/** Dispara o worker sem esperar (encadeamento da fila de imagens). */
export function dispararWorker(corpo: Record<string, unknown> = {}) {
  const p = fetch(`${SB_URL}/functions/v1/ia-imagem-worker`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify(corpo),
  }).catch(() => null);
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p);
}
