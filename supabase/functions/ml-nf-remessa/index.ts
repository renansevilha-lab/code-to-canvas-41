// ============================================================================
// Edge Function: ml-nf-remessa v1 (19/out/2026) — nota de remessa do envio ao Full do Mercado Livre
// ----------------------------------------------------------------------------
// Pedido do dono: a nota de remessa do envio ao Full entrar sozinha no envio da aba Fulfillment › Envios.
// Quem emite essa nota é o PRÓPRIO Mercado Livre, pelo emissor dele, em nome da empresa (Ottz: série 5,
// "Outras saídas · remessa para depósito", CFOP 5949/6949). No lote de notas ela fica na pasta
// "Outros documentos/Notas de transferência" e o XML/detalhe traz o número do envio
// (external_id "INBOUND-inbound-<envio>-…", xPed dos itens). Não há busca da nota pelo número do envio
// (/invoices/orders/<envio> = 404), então a função baixa o lote do período (só Full: full=inbound, só XML),
// abre os XMLs da pasta de transferência e acha o do envio. Depois baixa DANFE e XML e anexa no envio.
//
// POST {envio_id}                         → acha e anexa a(s) nota(s) do envio (idempotente pelo nome do arquivo).
// POST {modulo:"pendentes", dias?, max?}  → envios do ML dos últimos N dias (30) sem DANFE: tenta cada um.
// {dry: true} = só procura e diz o que anexaria. Sessão de usuário (ou service role). Só LÊ no Mercado Livre.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SRK);
const ML = "https://api.mercadolibre.com";
const DOCS_BUCKET = "fulfillment-docs";
const CONTA_ML: Record<string, number> = { "SVL Store": 1299638625 };
const OTTZ = 1107117809;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
// ensaio sem login, só leitura (dry), até a madrugada de 20/out
const ENSAIO_ATE = Date.parse("2026-10-20T03:00:00Z");

function quemChama(req: Request): { nome: string | null; ensaio: boolean } | null {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { nome: "sistema", ensaio: false };
  try {
    const pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (pl.role === "service_role") return { nome: "sistema", ensaio: false };
    if (pl.role === "authenticated") return { nome: (pl.email as string) ?? null, ensaio: false };
    if (pl.role === "anon" && Date.now() < ENSAIO_ATE) return { nome: "ensaio", ensaio: true };
  } catch { /* sem jwt */ }
  return null;
}
async function tokenMl(userId: number): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.from("oauth_tokens_ml").select("access_token").eq("user_id", userId).maybeSingle();
    if (error) { await new Promise((r) => setTimeout(r, 800)); continue; }
    if (!data?.access_token) throw new Error("conta do Mercado Livre sem token");
    return String(data.access_token);
  }
  throw new Error("não consegui ler o token do Mercado Livre — tente de novo");
}
const aaaammdd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

// ---------------------------------------------------------------- zip (sem biblioteca: diretório central + deflate-raw)
type Entrada = { nome: string; metodo: number; tamanho: number; inicio: number };
function lerZip(buf: Uint8Array): Entrada[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error("o lote do Mercado Livre não veio como zip");
  const total = dv.getUint16(fim + 10, true);
  let p = dv.getUint32(fim + 16, true);
  const dec = new TextDecoder("utf-8");
  const out: Entrada[] = [];
  for (let k = 0; k < total && dv.getUint32(p, true) === 0x02014b50; k++) {
    const metodo = dv.getUint16(p + 10, true), tamanho = dv.getUint32(p + 20, true);
    const n = dv.getUint16(p + 28, true), e = dv.getUint16(p + 30, true), c = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nome = dec.decode(buf.subarray(p + 46, p + 46 + n));
    const ln = dv.getUint16(local + 26, true), le = dv.getUint16(local + 28, true);
    out.push({ nome, metodo, tamanho, inicio: local + 30 + ln + le });
    p += 46 + n + e + c;
  }
  return out;
}
async function abrir(buf: Uint8Array, e: Entrada): Promise<string> {
  const bruto = buf.subarray(e.inicio, e.inicio + e.tamanho);
  if (e.metodo === 0) return new TextDecoder().decode(bruto);
  const s = new Blob([bruto]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(s).text();
}

// ---------------------------------------------------------------- anexo
async function anexar(envioId: string, tipo: string, nome: string, mime: string, bytes: Uint8Array, por: string | null) {
  const { data: ja } = await db.from("fulfillment_envio_docs").select("id").eq("envio_id", envioId).eq("nome", nome).limit(1);
  if (ja?.length) return "ja_tinha";
  const caminho = `${envioId}/${crypto.randomUUID().slice(0, 8)}-${nome.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
  const { error: eUp } = await db.storage.from(DOCS_BUCKET).upload(caminho, bytes, { contentType: mime, upsert: false });
  if (eUp) throw new Error(`storage: ${eUp.message}`);
  const { error } = await db.from("fulfillment_envio_docs").insert({ envio_id: envioId, tipo, nome, mime, tamanho: bytes.length, storage_path: caminho, criado_por: por });
  if (error) { await db.storage.from(DOCS_BUCKET).remove([caminho]); throw new Error(`banco: ${error.message}`); }
  return "anexado";
}

/** Acha a(s) nota(s) de remessa de UM envio do ML e (sem dry) anexa DANFE + XML. */
async function processar(envio: Record<string, any>, por: string | null, dry: boolean) {
  const numero = String(envio.numero ?? "").replace(/\D/g, "");
  if (numero.length < 6) return { envio_id: envio.id, numero: envio.numero, erro: "o envio não tem o número do Mercado Livre" };
  const userId = CONTA_ML[String(envio.empresa ?? "")] ?? OTTZ;
  const token = await tokenMl(userId);
  // a nota sai no agendamento (dias depois de criar o envio): janela da criação até +20 dias
  const base = new Date(envio.criado_em);
  const de = new Date(base.getTime() - 86400000), ate = new Date(Math.min(Date.now(), base.getTime() + 20 * 86400000));
  const r = await fetch(`${ML}/users/${userId}/invoices/sites/MLB/batch_request/period/stream?start=${aaaammdd(de)}&end=${aaaammdd(ate)}&full=inbound&file_types=xml&simple_folder=false`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200) return { envio_id: envio.id, numero, erro: `o Mercado Livre recusou o lote de notas (${r.status}): ${(await r.text()).slice(0, 150)}` };
  const buf = new Uint8Array(await r.arrayBuffer());
  const entradas = lerZip(buf).filter((e) => /transfer/i.test(e.nome) && /\.xml$/i.test(e.nome));
  const alvo = new RegExp(`(inbound-${numero}-|<xPed>${numero}</xPed>)`);
  const achadas: { id: string; chave: string | null }[] = [];
  for (const e of entradas) {
    const xml = await abrir(buf, e);
    if (!alvo.test(xml)) continue;
    const arq = e.nome.split("/").pop()!;
    achadas.push({ id: arq.split("_")[0], chave: (xml.match(/<chNFe>(\d{44})<\/chNFe>/) ?? [])[1] ?? null });
  }
  if (!achadas.length) return { envio_id: envio.id, numero, achou: 0, notas_no_lote: entradas.length, aviso: "a nota de remessa deste envio ainda não apareceu no Mercado Livre (sai no agendamento)" };
  const notas: any[] = [];
  for (const a of achadas) {
    const d = await (await fetch(`${ML}/users/${userId}/invoices/${a.id}`, { headers: { Authorization: `Bearer ${token}` } })).json().catch(() => null);
    const rotulo = `NF ${d?.invoice_series ?? "?"}-${d?.invoice_number ?? a.id}`;
    const n: Record<string, unknown> = { id: a.id, rotulo, chave: a.chave ?? d?.attributes?.invoice_key ?? null, status: d?.status ?? null, emitida: d?.issued_date ?? null, valor: d?.amount ?? null };
    if (!dry) {
      const pdf = await fetch(`${ML}/users/${userId}/invoices/sites/MLB/documents/danfe/${a.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (pdf.ok) n.danfe = await anexar(envio.id, "danfe", `DANFE remessa ML ${numero} (${rotulo}).pdf`, "application/pdf", new Uint8Array(await pdf.arrayBuffer()), por);
      else n.erro_danfe = `DANFE ${pdf.status}`;
      const xml = await fetch(`${ML}/users/${userId}/invoices/documents/xml/${a.id}/authorized`, { headers: { Authorization: `Bearer ${token}` } });
      if (xml.ok) n.xml = await anexar(envio.id, "outro", `XML remessa ML ${numero} (${rotulo}).xml`, "application/xml", new Uint8Array(await xml.arrayBuffer()), por);
      else n.erro_xml = `XML ${xml.status}`;
    }
    notas.push(n);
  }
  return { envio_id: envio.id, numero, achou: notas.length, notas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const quem = quemChama(req);
  if (!quem) return json({ ok: false, erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  const dry = b.dry === true || quem.ensaio;
  const ate = Date.now() + 40000;
  try {
    let envios: any[] = [];
    if (b.modulo === "pendentes") {
      const dias = Math.min(60, Math.max(3, Number(b.dias) || 30));
      const { data } = await db.from("fulfillment_envios").select("id, numero, empresa, criado_em")
        .eq("marketplace", "mercadolivre").is("arquivado_em", null).gte("criado_em", new Date(Date.now() - dias * 86400000).toISOString())
        .order("criado_em", { ascending: true });
      const ids = ((data ?? []) as any[]).map((e) => e.id);
      const { data: docs } = await db.from("fulfillment_envio_docs").select("envio_id").eq("tipo", "danfe").in("envio_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
      const com = new Set(((docs ?? []) as any[]).map((d) => d.envio_id));
      envios = ((data ?? []) as any[]).filter((e) => !com.has(e.id)).slice(0, Math.min(10, Math.max(1, Number(b.max) || 3)));
    } else {
      const { data } = await db.from("fulfillment_envios").select("id, numero, empresa, criado_em, marketplace").eq("id", String(b.envio_id ?? "")).maybeSingle();
      if (!data) return json({ ok: false, erro: "envio não encontrado" }, 404);
      if (data.marketplace !== "mercadolivre") return json({ ok: false, erro: "só envios do Mercado Livre" }, 400);
      envios = [data];
    }
    const resultado: any[] = [];
    for (const e of envios) {
      if (Date.now() > ate) { resultado.push({ envio_id: e.id, numero: e.numero, erro: "sem tempo: tente de novo" }); continue; }
      try { resultado.push(await processar(e, quem.nome, dry)); }
      catch (x) { resultado.push({ envio_id: e.id, numero: e.numero, erro: String((x as Error).message ?? x).slice(0, 300) }); }
    }
    if (!dry) await db.from("debug_fulfillment").insert({ modulo: "ml-nf-remessa", etapa: envios.map((e) => e.numero).join(",").slice(0, 120), status_http: 200, resultado: { quem: quem.nome, resultado } });
    return json({ ok: !resultado.some((r) => r.erro), dry, resultado });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
