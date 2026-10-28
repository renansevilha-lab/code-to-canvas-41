// ============================================================================
// producao-tiny v1 (28/out/2026) — Produção × Tiny, opção B do dono: lançamentos de estoque pela API
// no depósito GERAL (604130012, conta ottz). Os depósitos Full nunca são tocados.
//   POST ?modulo=status                         → matérias-primas e SKUs fabricados com a ligação no Tiny
//   POST ?modulo=cadastrar {insumo_id, confirmar?}  → cria a matéria-prima no Tiny (produto simples, SKU livre)
//   POST ?modulo=ligar {insumo_id, sku}          → liga a matéria-prima a um produto que JÁ existe no Tiny
//   POST ?modulo=entrada {entrada_id, confirmar?}   → E da matéria-prima recebida (quantidade × custo)
//   POST ?modulo=lote {ordem_id, confirmar?}        → lote encerrado: E do acabado (sacos bons × custo real)
//                                                     + S da farinha, do saco e da etiqueta (o consumo gravado)
// Sem `confirmar` = prévia (lê o saldo do Geral ao vivo e mostra o que vai ser lançado). Com `confirmar`:
// cada lançamento UMA vez (registro em producao_tiny_lanc, ok nunca repete); erro em um não apaga os outros;
// chamar de novo lança só o que faltou. Cadastrar/ligar = administrador (módulo `todos`); lançar = `galpao`.
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

type Quem = { id: string; nome: string | null; admin: boolean };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const [g, t] = await Promise.all([
    doUsuario.rpc("tem_modulo", { p_modulo: "galpao" }),
    doUsuario.rpc("tem_modulo", { p_modulo: "todos" }),
  ]);
  if (g.error || g.data !== true) return json({ erro: "sem acesso à Produção (módulo galpão)" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null, admin: t.data === true };
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

/** Próximo SKU numérico de 5 dígitos LIVRE (maior do espelho + 1…, conferido no Tiny). */
async function skuLivre(token: string): Promise<string | null> {
  const { data: maior } = await db.from("produtos").select("sku").filter("sku", "match", "^[0-9]{5}$").order("sku", { ascending: false }).limit(1);
  const ini = Number(maior?.[0]?.sku ?? 0) + 1;
  for (let s = ini; s < ini + 30; s++) {
    const r = await v3(token, "GET", `/produtos?codigo=${s}&limit=1`);
    if (r.status !== 200) return null;
    if (String(r.body?.itens?.[0]?.sku ?? "") !== String(s)) return String(s);
  }
  return null;
}

type Item = {
  papel: "acabado" | "farinha" | "embalagem" | "etiqueta" | "entrada"; tipo: "E" | "S"; nome: string;
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
  const { data: cons } = await db.from("producao_consumo")
    .select("quantidade, custo_un, insumo:producao_insumo(id, nome, tipo, unidade, tiny_produto_id, tiny_sku)").eq("ordem_id", ordemId);
  for (const c of (cons ?? []) as any[]) {
    const ins = c.insumo;
    if (!ins || Number(c.quantidade) <= 0) continue;
    const papel = (ins.tipo === "farinha" ? "farinha" : ins.tipo === "etiqueta" ? "etiqueta" : "embalagem") as Item["papel"];
    itens.push({
      papel, tipo: "S", nome: ins.nome, tiny_produto_id: num(ins.tiny_produto_id), sku: ins.tiny_sku ?? null,
      quantidade: r3(Number(c.quantidade)), unidade: ins.unidade === "kg" ? "KG" : "UN", preco_un: Number(c.custo_un),
      problema: ins.tiny_produto_id ? null : `"${ins.nome}" ainda não está ligado a um produto do Tiny`,
    });
  }
  return { codigo: o.codigo, itens };
}

async function itensDaEntrada(entradaId: number): Promise<{ codigo: string; itens: Item[]; erro?: string }> {
  const { data: e } = await db.from("producao_entrada")
    .select("id, codigo, quantidade, custo_un, insumo:producao_insumo(id, nome, unidade, tiny_produto_id, tiny_sku)").eq("id", entradaId).maybeSingle();
  if (!e) return { codigo: "", itens: [], erro: "entrada não encontrada" };
  const ins = (e as any).insumo;
  if (!ins) return { codigo: e.codigo, itens: [], erro: `classifique a farinha do big bag ${e.codigo} antes de lançar no Tiny` };
  return {
    codigo: e.codigo,
    itens: [{
      papel: "entrada", tipo: "E", nome: ins.nome, tiny_produto_id: num(ins.tiny_produto_id), sku: ins.tiny_sku ?? null,
      quantidade: r3(Number(e.quantidade)), unidade: ins.unidade === "kg" ? "KG" : "UN", preco_un: Number(e.custo_un),
      problema: ins.tiny_produto_id ? null : `"${ins.nome}" ainda não está ligado a um produto do Tiny`,
    }],
  };
}

async function lancar(token: string, origem: "lote" | "entrada", refId: number, codigo: string, itens: Item[], quem: Quem, confirmar: boolean) {
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
    if (origem === "lote") {
      await db.from("producao_ordem").update({ tiny_lancado_em: quando, tiny_lancado_por: quem.nome, tiny_resultado: { itens } }).eq("id", refId);
    } else {
      await db.from("producao_entrada").update({ tiny_lancado_em: quando, tiny_lancado_por: quem.nome }).eq("id", refId);
    }
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
    if (modulo === "status") {
      const { data: insumos } = await db.from("producao_insumo").select("id, nome, tipo, unidade, ncm, tiny_produto_id, tiny_sku").eq("ativo", true).order("tipo");
      const { data: pars } = await db.from("producao_parametros").select("sku").eq("ativo", true);
      const skus = ((pars ?? []) as any[]).map((p) => p.sku);
      const { data: prods } = skus.length ? await db.from("produtos").select("sku, nome, id_tiny").in("sku", skus) : { data: [] };
      return json({ ok: true, admin: quem.admin, insumos, acabados: prods });
    }

    if (modulo === "cadastrar" || modulo === "ligar") {
      if (!quem.admin) return json({ erro: "só o administrador cadastra ou liga matéria-prima no Tiny" }, 403);
      const { data: ins } = await db.from("producao_insumo").select("*").eq("id", Number(body.insumo_id)).maybeSingle();
      if (!ins) return json({ erro: "matéria-prima não encontrada" }, 404);
      if (ins.tiny_produto_id && modulo === "cadastrar") return json({ erro: `já está ligada ao produto ${ins.tiny_sku} do Tiny` }, 409);
      const token = await tokenTiny();

      if (modulo === "ligar") {
        const sku = String(body.sku ?? "").trim();
        if (!sku) return json({ erro: "informe o SKU do produto no Tiny" }, 400);
        const r = await v3(token, "GET", `/produtos?codigo=${encodeURIComponent(sku)}&limit=1`);
        const it = (r.body?.itens ?? [])[0];
        if (!it || String(it.sku) !== sku) return json({ erro: `não achei o produto ${sku} no Tiny` }, 404);
        await db.from("producao_insumo").update({ tiny_produto_id: Number(it.id), tiny_sku: sku }).eq("id", ins.id);
        return json({ ok: true, ligado: { sku, id: it.id, nome: it.descricao } });
      }

      const sku = String(body.sku ?? "").trim() || await skuLivre(token);
      if (!sku) return json({ erro: "não consegui achar um SKU livre no Tiny agora; tente de novo" }, 502);
      const corpo: Record<string, unknown> = {
        tipo: "S", sku, descricao: String(ins.nome).slice(0, 120), unidade: ins.unidade === "kg" ? "KG" : "UN", origem: 0,
        ...(ins.ncm ? { ncm: ins.ncm } : {}),
        precos: { preco: 0, ...(ins.custo_referencia != null ? { precoCusto: Number(ins.custo_referencia) } : {}) },
      };
      if (!confirmar) return json({ ok: true, previa: true, corpo });
      let cr = await v3(token, "POST", "/produtos", corpo);
      if (cr.status === 400) {
        // 400 = o Tiny não criou nada: tenta uma vez sem os campos opcionais
        const { ncm: _n, ...semNcm } = corpo as any;
        cr = await v3(token, "POST", "/produtos", { ...semNcm, precos: { preco: 0 } });
      }
      await db.from("debug_fulfillment").insert({ modulo: "producao-tiny", etapa: `cadastrar:${sku}`, status_http: cr.status, resultado: { enviado: corpo, resposta: cr.body, por: quem.nome } }).then(() => {}, () => {});
      const id = num(cr.body?.id);
      if (cr.status >= 300 || !id) return json({ erro: `o Tiny recusou: ${erroV3(cr.body) || cr.status}`, corpo }, 422);
      await db.from("producao_insumo").update({ tiny_produto_id: id, tiny_sku: sku }).eq("id", ins.id);
      return json({ ok: true, criado: { sku, id } });
    }

    if (modulo === "entrada" || modulo === "lote") {
      const refId = Number(body.entrada_id ?? body.ordem_id);
      if (!(refId > 0)) return json({ erro: "informe o lote ou a entrada" }, 400);
      const dados = modulo === "lote" ? await itensDoLote(refId) : await itensDaEntrada(refId);
      if (dados.erro) return json({ erro: dados.erro }, 409);
      const token = await tokenTiny();
      return json(await lancar(token, modulo, refId, dados.codigo, dados.itens, quem, confirmar));
    }

    return json({ erro: "módulo desconhecido (status, cadastrar, ligar, entrada, lote)" }, 400);
  } catch (e) {
    return json({ erro: e instanceof Error ? e.message : String(e) }, 500);
  }
});
