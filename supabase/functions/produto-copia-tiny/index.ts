// ============================================================================
// Edge Function de uso único: produto-copia-tiny (06/nov/2026) — publicada no slot `tiny-scope-probe` (o projeto está
// no limite de funções; a sonda antiga não tinha cron nem tela).
// Pedido do dono: SKU próprio para a areia Bumi 15984 no saco TRANSPARENTE ("em alguns marketplaces vamos continuar
// enviando na embalagem transparente"), com a foto antiga (saco transparente). Cria no Tiny o 15984T copiando o
// cadastro do 15984 (unidade, NCM, origem, código de barras, marca, categoria, preço, custo, peso e medidas).
//   GET ?chave=…            → prévia (lê o 15984 no Tiny, confere se 15984T e o nome estão livres). Não escreve.
//   GET ?chave=…&confirmar=1 → cria (UMA chamada de criação; 400 = nada criado: tenta sem código de barras, depois
//                              sem marca/categoria), põe a foto como cópia do Tiny e grava o espelho `produtos`.
// Só estes valores, só até o prazo. Registro em debug_fulfillment (modulo 'produto-copia-tiny').
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TINY = "https://api.tiny.com.br/public-api/v3";
const PRAZO = "2026-11-07T03:00:00Z";
const CHAVE = "c15984t-6nov-8e2a";
const BASE = "15984";
const SKU = "15984T";
const NOME = "Areia Bumi Pet 4kg Mandioca Natural Alta Absorção Anti Odor Gatos (Embalagem Transparente)";
const FOTO = "https://http2.mlstatic.com/D_NQ_NP_2X_947654-MLA113697399372_072026-F.jpg";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => { if (v == null || v === "") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const erroV3 = (b: any) => [b?.mensagem, ...((b?.detalhes ?? []) as any[]).map((d) => `${d.campo}: ${d.mensagem}`)].filter(Boolean).join(" · ").slice(0, 400);

async function v3(token: string, metodo: string, path: string, corpo?: unknown) {
  for (let t = 0; ; t++) {
    const r = await fetch(`${TINY}${path}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { mensagem: txt.slice(0, 300) }; }
    await sleep(600);
    if (r.status === 429 && t < 3) { await sleep(2000 * (t + 1)); continue; } // 429 = nada processado
    return { status: r.status, body };
  }
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (Date.now() > Date.parse(PRAZO) || u.searchParams.get("chave") !== CHAVE) return json({ erro: "encerrado" }, 410);
  const confirmar = u.searchParams.get("confirmar") === "1";
  try {
    const { data: tk } = await db.from("oauth_tokens_tiny").select("access_token, expires_at").eq("conta", "ottz").limit(1).single();
    if (!tk || new Date(tk.expires_at as string) < new Date()) return json({ ok: false, erro: "token do Tiny (ottz) ausente ou vencido" }, 503);
    const token = String(tk.access_token);
    const { data: esp } = await db.from("produtos").select("id_tiny").eq("sku", BASE).single();
    const g = await v3(token, "GET", `/produtos/${esp!.id_tiny}`);
    if (g.status !== 200) return json({ ok: false, erro: `não li o ${BASE} no Tiny: ${erroV3(g.body) || g.status}` }, 502);
    const d = g.body;
    const pend: string[] = [];
    if (d.tipo !== "S") pend.push(`o ${BASE} não é simples no Tiny (tipo ${d.tipo})`);
    const oc = await v3(token, "GET", `/produtos?codigo=${encodeURIComponent(SKU)}&limit=1`);
    if (String(oc.body?.itens?.[0]?.sku ?? "") === SKU) pend.push(`o SKU ${SKU} já existe no Tiny (id ${oc.body.itens[0].id})`);
    const dup = await v3(token, "GET", `/produtos?nome=${encodeURIComponent(NOME)}&situacao=A&limit=5`);
    if (((dup.body?.itens ?? []) as any[]).some((i) => String(i.descricao ?? "").trim().toLowerCase() === NOME.toLowerCase())) pend.push("já existe produto ativo com este nome");
    const dim = d.dimensoes ?? {};
    const preco = num(d.precos?.preco) ?? 0;
    const custo = num(d.precos?.precoCusto);
    const corpo: Record<string, unknown> = {
      tipo: "S", sku: SKU, descricao: NOME, unidade: d.unidade || "UN", origem: Number(d.origem ?? 0),
      ...(d.ncm ? { ncm: d.ncm } : {}), ...(d.gtin ? { gtin: d.gtin } : {}),
      ...(d.marca?.id ? { marca: { id: d.marca.id } } : {}), ...(d.categoria?.id ? { categoria: { id: d.categoria.id } } : {}),
      precos: { preco, ...(custo != null ? { precoCusto: custo } : {}) },
      dimensoes: { pesoBruto: dim.pesoBruto ?? null, pesoLiquido: dim.pesoLiquido ?? null, largura: dim.largura ?? null, altura: dim.altura ?? null, comprimento: dim.comprimento ?? null },
    };
    const previa = { base: { sku: BASE, nome: d.descricao, gtin: d.gtin, ncm: d.ncm, marca: d.marca?.nome, categoria: d.categoria?.nome, preco, custo, dimensoes: dim }, novo: corpo, foto: FOTO };
    if (!confirmar || pend.length) return json({ ok: !pend.length, previa, pendencias: pend });

    const avisos: string[] = [];
    let enviado = corpo;
    let cr = await v3(token, "POST", "/produtos", enviado);
    if (cr.status === 400 && enviado.gtin) {
      const { gtin: _g, ...sem } = enviado; enviado = sem;
      cr = await v3(token, "POST", "/produtos", enviado);
      if (cr.status === 201) avisos.push("o Tiny recusou o código de barras repetido: o 15984T ficou sem ele");
    }
    if (cr.status === 400 && (enviado.marca || enviado.categoria)) {
      const { marca: _m, categoria: _c, ...sem } = enviado; enviado = sem;
      cr = await v3(token, "POST", "/produtos", enviado);
    }
    const id = Number(cr.body?.id ?? 0);
    if (cr.status !== 201 || !id) {
      await db.from("debug_fulfillment").insert({ modulo: "produto-copia-tiny", etapa: SKU, status_http: cr.status, resultado: { enviado, resposta: cr.body } });
      return json({ ok: false, erro: `o Tiny recusou: ${erroV3(cr.body) || cr.status}`, resposta: cr.body }, 200);
    }
    // foto: cópia guardada no Tiny (externo false); se recusar o pedido, como endereço externo
    let foto: any = null;
    for (const externo of [false, true]) {
      const r = await v3(token, "POST", `/produtos/${id}/anexos`, [{ url: FOTO, externo }]);
      foto = { status: r.status, externo, body: r.body };
      if (r.status >= 200 && r.status < 300) break;
      if (r.status !== 400 && r.status !== 422) break;
    }
    const c = await v3(token, "GET", `/produtos/${id}`);
    const capa = ((c.body?.anexos ?? []) as any[]).find((x) => x?.url)?.url ?? null;
    const agora = new Date().toISOString();
    const up = await db.from("produtos").upsert({
      sku: SKU, id_tiny: id, nome: NOME, tipo: "S", preco, ativo: true, situacao: "A", tipo_variacao: "N", sku_pai: null, id_tiny_pai: null,
      gtin: c.body?.gtin || null, unidade: d.unidade || "UN", marca: d.marca?.nome ?? null, categoria: d.categoria?.nome ?? null,
      foto_capa: capa, criado_app_em: agora, sku_base: BASE, atualizado_em: agora, detalhe_atualizado_em: agora,
      ...(custo != null ? { custo } : {}), ...(num(dim.pesoBruto) ? { peso_bruto: num(dim.pesoBruto) } : {}),
      ...(num(dim.pesoLiquido) ? { peso_liquido: num(dim.pesoLiquido) } : {}),
    }, { onConflict: "sku" });
    const out = {
      ok: true, id, sku: c.body?.sku, nome: c.body?.descricao, tipo: c.body?.tipo, gtin: c.body?.gtin, ncm: c.body?.ncm,
      marca: c.body?.marca?.nome, categoria: c.body?.categoria?.nome, precos: c.body?.precos, anexos: c.body?.anexos,
      foto_status: foto?.status, espelho: up.error?.message ?? "ok", avisos,
    };
    await db.from("debug_fulfillment").insert({ modulo: "produto-copia-tiny", etapa: SKU, status_http: 201, resultado: { enviado, foto, out } });
    return json(out);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
