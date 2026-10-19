// ============================================================================
// Edge Function: pesquisa-ml v2 (18/out/2026) — Pesquisa de produtos / monitoramento de categorias ML
// ----------------------------------------------------------------------------
// Só LÊ o Mercado Livre (token de cada conta em oauth_tokens_ml, renovado pelo cron 21
// ml-refresh-token) e grava só as tabelas pesquisa_ml_*. Snapshot por data (dia em Brasília).
//
//   ?modo=descobrir_lideranca[&forcar=1]
//       atualiza pesquisa_ml_meus (anúncios ativos das DUAS contas: Ottz e SVL) e confere o top 20
//       de cada categoria em que temos anúncio: onde aparecemos → monitorar_diario = true.
//       "Aparecer" = o ranking traz o nosso anúncio (ITEM), o produto de catálogo em que
//       anunciamos (PRODUCT) ou o nosso user product (USER_PRODUCT). Nunca desliga sozinho.
//   ?modo=diario      top 20 das categorias monitorar_diario = true (com nome/preço/vendedor).
//   ?modo=semanal     árvore do Pet Shop (MLB1071) → top 20 de todas as folhas → tendências
//                     (geral + Pet Shop e níveis 1 e 2), uma etapa depois da outra.
// Retomável: cada chamada trabalha ~22 s e devolve `pendentes`; o cron chama de novo e o que já foi
// feito no dia fica marcado em pesquisa_ml_coleta (idempotente: upsert pelos uniques).
// 404 "sem ranking" = categoria sem ranking (gravado, não é erro). 429/5xx = espera e tenta de novo.
// Limites do ML com o nosso token (testados em 18/out): /items de anúncio de TERCEIRO = 403 e
// /user-products de terceiro = 403 → para ITEM/USER_PRODUCT de outros vendedores fica só id + posição.
// PRODUCT (catálogo) sai com nome (/products/{id}) e a 1ª oferta (/products/{id}/items).
// v2 (19/out): e_meu separado em anuncio_proprio (o ITEM/USER_PRODUCT do ranking é nosso) e participo_catalogo
//   (PRODUCT em que anunciamos ou cuja 1ª oferta é nossa); a defesa olha anuncio_proprio.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SRK);
const ML = "https://api.mercadolibre.com";
const RAIZ = "MLB1071"; // "Animais" no site; "Pet Shop" na API (conferido em 18/out)
const CONTAS: Record<string, number> = { ottz: 1107117809, svl: 1299638625 };
const ORCAMENTO_MS = 22_000;
const PARALELO = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
/** 00:00 de hoje em Brasília, em ISO (UTC). */
const inicioHoje = () => new Date(`${hojeBRT()}T03:00:00.000Z`).toISOString();

// ---------------------------------------------------------------- ML
const tokens = new Map<number, string>();
async function token(userId: number): Promise<string> {
  if (tokens.has(userId)) return tokens.get(userId)!;
  const { data, error } = await db.from("oauth_tokens_ml").select("access_token").eq("user_id", userId).maybeSingle();
  if (error || !data?.access_token) throw new Error(`token ML da conta ${userId} não encontrado`);
  tokens.set(userId, String(data.access_token));
  return String(data.access_token);
}
/** GET no ML com retentativa em 429/5xx (espera crescente). Nunca lança: devolve status + corpo. */
async function ml(path: string, userId = CONTAS.ottz): Promise<{ status: number; body: any }> {
  const tk = await token(userId);
  let ultimo = { status: 0, body: null as any };
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(`${ML}${path}`, { headers: { Authorization: `Bearer ${tk}` } });
      const txt = await r.text();
      let b: any; try { b = JSON.parse(txt); } catch { b = txt.slice(0, 300); }
      ultimo = { status: r.status, body: b };
      if (r.status !== 429 && r.status < 500) return ultimo;
    } catch (e) { ultimo = { status: 0, body: String(e) }; }
    await sleep(700 * 2 ** t);
  }
  return ultimo;
}
/** Executa fn em lotes paralelos enquanto houver tempo; devolve quantos ficaram de fora. */
async function emLotes<T>(itens: T[], t0: number, fn: (x: T) => Promise<void>, limite = ORCAMENTO_MS): Promise<number> {
  for (let i = 0; i < itens.length; i += PARALELO) {
    if (Date.now() - t0 > limite) return itens.length - i;
    await Promise.all(itens.slice(i, i + PARALELO).map((x) => fn(x).catch(() => {})));
  }
  return 0;
}
/** Lê todas as linhas de uma consulta (o PostgREST corta em 1.000). */
async function todas<T>(q: (de: number, ate: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await q(de, de + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}

// ---------------------------------------------------------------- nossos anúncios
async function atualizarMeus(t0: number, forcar: boolean, erros: string[]) {
  const resumo: Record<string, number> = {};
  for (const [conta, uid] of Object.entries(CONTAS)) {
    if (!forcar) {
      const { count } = await db.from("pesquisa_ml_meus").select("mlb", { count: "exact", head: true }).eq("conta", conta).gte("atualizado_em", inicioHoje());
      if ((count ?? 0) > 0) { resumo[conta] = count ?? 0; continue; }
    }
    const inicio = new Date().toISOString();
    // ids ativos (scan com scroll: o offset do ML para em 1.000)
    const ids: string[] = []; let scroll: string | null = null;
    for (let pg = 0; pg < 60; pg++) {
      const r = await ml(`/users/${uid}/items/search?status=active&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ""}`, uid);
      if (r.status !== 200) { erros.push(`meus ${conta}: items/search ${r.status}`); break; }
      const res = (r.body?.results ?? []) as string[];
      ids.push(...res); scroll = r.body?.scroll_id ?? null;
      if (!res.length || !scroll) break;
    }
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const linhas: Record<string, unknown>[] = [];
    await emLotes(lotes, t0, async (l) => {
      const r = await ml(`/items?ids=${l.join(",")}&attributes=id,title,category_id,catalog_product_id,user_product_id,status`, uid);
      for (const e of (Array.isArray(r.body) ? r.body : []) as any[]) {
        const b = e?.body;
        if (e?.code === 200 && b?.id) linhas.push({ mlb: b.id, conta, category_id: b.category_id ?? null, catalog_product_id: b.catalog_product_id ?? null, user_product_id: b.user_product_id ?? null, titulo: b.title ?? null, atualizado_em: new Date().toISOString() });
      }
    }, ORCAMENTO_MS + 5000);
    for (let i = 0; i < linhas.length; i += 500) {
      const { error } = await db.from("pesquisa_ml_meus").upsert(linhas.slice(i, i + 500), { onConflict: "mlb" });
      if (error) erros.push(`meus ${conta}: ${error.message}`);
    }
    // anúncio que saiu do ar some do cache (só se a leitura veio inteira)
    if (linhas.length && linhas.length >= ids.length * 0.95) await db.from("pesquisa_ml_meus").delete().eq("conta", conta).lt("atualizado_em", inicio);
    resumo[conta] = linhas.length;
  }
  return resumo;
}
type Meu = { conta: string; mlb: string; titulo: string | null };
async function mapaMeus(): Promise<Map<string, Meu>> {
  const ms = await todas<any>((de, ate) => db.from("pesquisa_ml_meus").select("mlb, conta, catalog_product_id, user_product_id, titulo").range(de, ate));
  const m = new Map<string, Meu>();
  for (const x of ms) {
    const v = { conta: String(x.conta), mlb: String(x.mlb), titulo: x.titulo ?? null };
    m.set(String(x.mlb), v);
    if (x.catalog_product_id && !m.has(String(x.catalog_product_id))) m.set(String(x.catalog_product_id), v);
    if (x.user_product_id) m.set(String(x.user_product_id), v);
  }
  return m;
}
const nossosVendedores = new Set(Object.values(CONTAS));

// ---------------------------------------------------------------- categorias
async function garantirCategoria(cat: string) {
  const { data } = await db.from("pesquisa_ml_categorias").select("category_id, nome").eq("category_id", cat).maybeSingle();
  if (data?.nome) return;
  const r = await ml(`/categories/${cat}`);
  const b = r.status === 200 ? r.body : null;
  const caminho = ((b?.path_from_root ?? []) as any[]).map((p) => p.name).join(" > ") || null;
  const pai = ((b?.path_from_root ?? []) as any[]).slice(-2, -1)[0]?.id ?? null;
  await db.from("pesquisa_ml_categorias").upsert({
    category_id: cat, nome: b?.name ?? null, caminho, pai_id: pai,
    e_folha: b ? !((b.children_categories ?? []).length) : true, atualizado_em: new Date().toISOString(),
  }, { onConflict: "category_id" });
}

// ---------------------------------------------------------------- produtos de catálogo (cache)
async function enriquecerProdutos(ids: string[], idadeMaxH: number) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const { data } = await db.from("pesquisa_ml_produtos").select("*").in("ml_id", ids);
  const limite = Date.now() - idadeMaxH * 3600_000;
  for (const p of (data ?? []) as any[]) if (Date.parse(p.atualizado_em) > limite) out.set(String(p.ml_id), p);
  const faltam = ids.filter((i) => !out.has(i));
  const novos: Record<string, unknown>[] = [];
  await Promise.all(faltam.map(async (id) => {
    const [p, of] = await Promise.all([ml(`/products/${id}`), ml(`/products/${id}/items?limit=1`)]);
    if (p.status !== 200 && of.status !== 200) return;
    const o = of.status === 200 ? (of.body?.results ?? [])[0] : null;
    const linha = {
      ml_id: id, titulo: p.status === 200 ? (p.body?.name ?? null) : null, preco: o?.price ?? null,
      vendedor_id: o?.seller_id ?? null, n_ofertas: of.status === 200 ? (of.body?.paging?.total ?? null) : null, atualizado_em: new Date().toISOString(),
    };
    novos.push(linha); out.set(id, linha);
  }));
  if (novos.length) await db.from("pesquisa_ml_produtos").upsert(novos, { onConflict: "ml_id" });
  return out;
}

// ---------------------------------------------------------------- top 20 de uma categoria
async function coletarRanking(cat: string, modo: string, data: string, meus: Map<string, Meu>, enriquecer: boolean, idadeProdutoH: number) {
  const r = await ml(`/highlights/MLB/category/${cat}`);
  if (r.status === 404) {
    await db.from("pesquisa_ml_coleta").upsert({ data_coleta: data, modo, category_id: cat, http_status: 404, n_itens: 0, erro: null, coletado_em: new Date().toISOString() }, { onConflict: "data_coleta,modo,category_id" });
    return { cat, n: 0, meus: [] as any[] };
  }
  if (r.status !== 200) {
    const erro = typeof r.body === "string" ? r.body : (r.body?.message ?? JSON.stringify(r.body)).slice(0, 300);
    await db.from("pesquisa_ml_coleta").upsert({ data_coleta: data, modo, category_id: cat, http_status: r.status, n_itens: null, erro, coletado_em: new Date().toISOString() }, { onConflict: "data_coleta,modo,category_id" });
    throw new Error(`${cat}: highlights ${r.status} ${erro}`);
  }
  const content = ((r.body?.content ?? []) as any[]).filter((c) => c?.id);
  const prods = enriquecer ? await enriquecerProdutos(content.filter((c) => c.type === "PRODUCT").map((c) => String(c.id)), idadeProdutoH) : new Map();
  const linhas = content.map((c) => {
    const id = String(c.id); const meu = meus.get(id); const p = prods.get(id);
    const vend = p?.vendedor_id != null ? Number(p.vendedor_id) : null;
    // anúncio próprio = o ITEM / USER_PRODUCT do ranking é nosso; catálogo = o PRODUCT é um catálogo em que
    // anunciamos (ou cuja 1ª oferta é nossa) — participar do catálogo não é ter o anúncio no top 20
    const proprio = !!meu && c.type !== "PRODUCT";
    const catalogo = c.type === "PRODUCT" && (!!meu || (vend != null && nossosVendedores.has(vend)));
    return {
      data_coleta: data, category_id: cat, posicao: Number(c.position), tipo: c.type ?? null, ml_id: id,
      titulo: p?.titulo ?? meu?.titulo ?? null, preco: p?.preco ?? null, vendedor_id: vend,
      e_meu: proprio || catalogo, anuncio_proprio: proprio, participo_catalogo: catalogo,
      meu_conta: meu?.conta ?? null, meu_mlb: meu?.mlb ?? null,
    };
  });
  if (linhas.length) {
    await garantirCategoria(cat);
    const { error } = await db.from("pesquisa_ml_ranking").upsert(linhas, { onConflict: "data_coleta,category_id,ml_id" });
    if (error) throw new Error(`${cat}: banco ${error.message}`);
  }
  await db.from("pesquisa_ml_coleta").upsert({ data_coleta: data, modo, category_id: cat, http_status: 200, n_itens: linhas.length, erro: null, coletado_em: new Date().toISOString() }, { onConflict: "data_coleta,modo,category_id" });
  return { cat, n: linhas.length, meus: linhas.filter((l) => l.e_meu).map((l) => ({ posicao: l.posicao, tipo: l.tipo, ml_id: l.ml_id, mlb: l.meu_mlb, conta: l.meu_conta, titulo: l.titulo, anuncio_proprio: l.anuncio_proprio })) };
}
/** Categorias que ainda faltam no dia para o modo (sem linha, ou com erro que não é 404). */
async function pendentesDoDia(cats: string[], modo: string, data: string) {
  const feitas = await todas<any>((de, ate) => db.from("pesquisa_ml_coleta").select("category_id, http_status, erro").eq("data_coleta", data).eq("modo", modo).range(de, ate));
  const ok = new Set(feitas.filter((f) => !f.erro || f.http_status === 404).map((f) => String(f.category_id)));
  return cats.filter((c) => !ok.has(c));
}

// ---------------------------------------------------------------- modos
async function descobrirLideranca(t0: number, forcar: boolean, erros: string[]) {
  const data = hojeBRT();
  const contas = await atualizarMeus(t0, forcar, erros);
  const meusRows = await todas<any>((de, ate) => db.from("pesquisa_ml_meus").select("category_id").range(de, ate));
  const cats = [...new Set(meusRows.map((m) => m.category_id).filter(Boolean).map(String))];
  // atuo = temos anúncio ativo na categoria
  for (const c of cats) await db.from("pesquisa_ml_categorias").upsert({ category_id: c }, { onConflict: "category_id", ignoreDuplicates: true });
  await db.from("pesquisa_ml_categorias").update({ atuo: false }).eq("atuo", true);
  if (cats.length) await db.from("pesquisa_ml_categorias").update({ atuo: true }).in("category_id", cats);
  const meus = await mapaMeus();
  const pend = await pendentesDoDia(cats, "lideranca", data);
  const achados: any[] = [];
  const faltaram = await emLotes(pend, t0, async (cat) => {
    try {
      await garantirCategoria(cat);
      const r = await coletarRanking(cat, "lideranca", data, meus, false, 0);
      if (r.meus.length) {
        achados.push(r);
        await db.from("pesquisa_ml_categorias").update({ monitorar_diario: true, atualizado_em: new Date().toISOString() }).eq("category_id", cat);
      }
    } catch (e) { erros.push(String(e instanceof Error ? e.message : e)); }
  });
  // resultado do dia inteiro (inclui rodadas anteriores), lido do banco
  const { data: lideres } = await db.from("pesquisa_ml_ranking").select("category_id, posicao, tipo, ml_id, meu_mlb, meu_conta, titulo")
    .eq("data_coleta", data).eq("e_meu", true).order("posicao");
  return { contas, categorias_com_anuncio: cats.length, conferidas_agora: pend.length - faltaram, pendentes: faltaram, novas_lideradas_agora: achados.length, minhas_posicoes_hoje: lideres ?? [] };
}

async function diario(t0: number, erros: string[]) {
  const data = hojeBRT();
  const { data: cs } = await db.from("pesquisa_ml_categorias").select("category_id").eq("monitorar_diario", true);
  const cats = ((cs ?? []) as any[]).map((c) => String(c.category_id));
  const meus = await mapaMeus();
  const pend = await pendentesDoDia(cats, "diario", data);
  let coletadas = 0;
  const faltaram = await emLotes(pend, t0, async (cat) => {
    try { await coletarRanking(cat, "diario", data, meus, true, 20); coletadas++; }
    catch (e) { erros.push(String(e instanceof Error ? e.message : e)); }
  });
  return { monitoradas: cats.length, coletadas_agora: coletadas, pendentes: faltaram };
}

/** Semanal, etapa 1: árvore do Pet Shop em largura; categoria lida hoje = feita. */
async function etapaArvore(t0: number, erros: string[]) {
  const h0 = inicioHoje();
  await db.from("pesquisa_ml_categorias").upsert({ category_id: RAIZ, nivel: 0 }, { onConflict: "category_id", ignoreDuplicates: true });
  await db.from("pesquisa_ml_categorias").update({ nivel: 0 }).eq("category_id", RAIZ);
  let lidas = 0;
  for (;;) {
    if (Date.now() - t0 > ORCAMENTO_MS) break;
    const { data: pend } = await db.from("pesquisa_ml_categorias").select("category_id, nivel").not("nivel", "is", null)
      .or(`visto_em.is.null,visto_em.lt."${h0}"`).order("nivel").limit(40);
    const lista = (pend ?? []) as { category_id: string; nivel: number }[];
    if (!lista.length) break;
    await emLotes(lista, t0, async (c) => {
      const r = await ml(`/categories/${c.category_id}`);
      if (r.status !== 200) { erros.push(`árvore ${c.category_id}: ${r.status}`); if (r.status === 404) await db.from("pesquisa_ml_categorias").update({ ativa: false, visto_em: new Date().toISOString() }).eq("category_id", c.category_id); return; }
      const b = r.body; const filhos = (b.children_categories ?? []) as any[];
      const caminho = ((b.path_from_root ?? []) as any[]).map((p) => p.name).join(" > ");
      const pai = ((b.path_from_root ?? []) as any[]).slice(-2, -1)[0]?.id ?? null;
      await db.from("pesquisa_ml_categorias").update({
        nome: b.name ?? null, caminho, pai_id: c.category_id === RAIZ ? null : pai, e_folha: filhos.length === 0, ativa: true,
        visto_em: new Date().toISOString(), atualizado_em: new Date().toISOString(),
      }).eq("category_id", c.category_id);
      if (filhos.length) {
        // filho novo entra pendente (visto_em nulo); filho já conhecido recebe só o nível
        await db.from("pesquisa_ml_categorias").upsert(filhos.map((f) => ({ category_id: String(f.id), nome: f.name ?? null, pai_id: c.category_id, nivel: c.nivel + 1 })), { onConflict: "category_id", ignoreDuplicates: true });
        await db.from("pesquisa_ml_categorias").update({ nivel: c.nivel + 1, pai_id: c.category_id }).in("category_id", filhos.map((f) => String(f.id)));
      }
      lidas++;
    });
  }
  const { count } = await db.from("pesquisa_ml_categorias").select("category_id", { count: "exact", head: true }).not("nivel", "is", null).or(`visto_em.is.null,visto_em.lt."${h0}"`);
  return { lidas_agora: lidas, faltam: count ?? 0 };
}

async function semanal(t0: number, erros: string[]) {
  const data = hojeBRT();
  const arvore = await etapaArvore(t0, erros);
  if (arvore.faltam > 0) return { etapa: "arvore", arvore, pendentes: arvore.faltam };
  // categoria que saiu da árvore do ML (não lida hoje) deixa de ser ativa — o histórico continua apontando para ela
  await db.from("pesquisa_ml_categorias").update({ ativa: false }).not("nivel", "is", null).lt("visto_em", inicioHoje());

  // etapa 2: top 20 de todas as folhas ativas do Pet Shop
  const folhas = (await todas<any>((de, ate) => db.from("pesquisa_ml_categorias").select("category_id").eq("e_folha", true).eq("ativa", true).not("nivel", "is", null).range(de, ate))).map((c) => String(c.category_id));
  const meus = await mapaMeus();
  const pendR = await pendentesDoDia(folhas, "semanal", data);
  let coletadas = 0;
  const faltaramR = await emLotes(pendR, t0, async (cat) => {
    try { await coletarRanking(cat, "semanal", data, meus, true, 6 * 24); coletadas++; }
    catch (e) { erros.push(String(e instanceof Error ? e.message : e)); }
  });
  if (faltaramR > 0) return { etapa: "ranking", folhas: folhas.length, coletadas_agora: coletadas, pendentes: faltaramR };

  // etapa 3: tendências — geral (MLB) + Pet Shop e níveis 1 e 2
  const { data: niv } = await db.from("pesquisa_ml_categorias").select("category_id").eq("ativa", true).lte("nivel", 2).not("nivel", "is", null);
  const alvos = ["MLB", ...((niv ?? []) as any[]).map((c) => String(c.category_id))];
  const pendT = await pendentesDoDia(alvos, "tendencias", data);
  let termos = 0;
  const faltaramT = await emLotes(pendT, t0, async (cat) => {
    const r = await ml(cat === "MLB" ? "/trends/MLB" : `/trends/MLB/${cat}`);
    const lista = r.status === 200 && Array.isArray(r.body) ? (r.body as any[]) : [];
    if (r.status === 200) {
      const vistos = new Set<string>();
      const linhas = lista.map((t, i) => ({ data_coleta: data, category_id: cat, posicao: i + 1, palavra: String(t.keyword ?? "").trim(), tipo: i < 10 ? "maior_crescimento" : i < 30 ? "mais_desejadas" : "populares" }))
        .filter((l) => l.palavra && !vistos.has(l.palavra) && vistos.add(l.palavra));
      if (linhas.length) {
        const { error } = await db.from("pesquisa_ml_tendencias").upsert(linhas, { onConflict: "data_coleta,category_id,palavra" });
        if (error) { erros.push(`tendências ${cat}: ${error.message}`); return; }
      }
      termos += linhas.length;
    } else if (r.status !== 404) erros.push(`tendências ${cat}: ${r.status}`);
    await db.from("pesquisa_ml_coleta").upsert({ data_coleta: data, modo: "tendencias", category_id: cat, http_status: r.status, n_itens: lista.length, erro: r.status === 200 || r.status === 404 ? null : String(r.status), coletado_em: new Date().toISOString() }, { onConflict: "data_coleta,modo,category_id" });
  });
  return { etapa: faltaramT > 0 ? "tendencias" : "concluido", folhas: folhas.length, alvos_tendencias: alvos.length, termos_agora: termos, pendentes: faltaramT };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  // só lê o ML e grava as tabelas do módulo: aceita o cron (chave publicável), usuário logado e service role
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let role = "";
  try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = bearer === SRK ? "service_role" : ""; }
  if (!["anon", "authenticated", "service_role"].includes(role)) return json({ erro: "sem autorização" }, 401);

  const url = new URL(req.url);
  const modo = url.searchParams.get("modo") ?? "";
  if (!["descobrir_lideranca", "diario", "semanal"].includes(modo)) return json({ erro: "use ?modo=descobrir_lideranca, diario ou semanal" }, 400);
  const t0 = Date.now();
  const erros: string[] = [];
  const { data: ex } = await db.from("pesquisa_ml_execucoes").insert({ modo }).select("id").single();
  let resumo: Record<string, unknown> = {};
  try {
    resumo = modo === "descobrir_lideranca" ? await descobrirLideranca(t0, url.searchParams.get("forcar") === "1", erros)
      : modo === "diario" ? await diario(t0, erros)
      : await semanal(t0, erros);
  } catch (e) {
    erros.push(`falha geral: ${String(e instanceof Error ? e.message : e)}`);
  }
  resumo.ms = Date.now() - t0;
  if (ex?.id) await db.from("pesquisa_ml_execucoes").update({ fim: new Date().toISOString(), resumo, erros: erros.length ? erros.slice(0, 200) : null }).eq("id", ex.id);
  return json({ ok: erros.length === 0, modo, ...resumo, erros: erros.slice(0, 30) });
});
