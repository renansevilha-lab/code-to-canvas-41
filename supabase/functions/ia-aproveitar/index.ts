// ============================================================================
// Edge Function: ia-aproveitar v1 (12/out/2026) — IA · Anúncios
// ----------------------------------------------------------------------------
// Aproveita o que JÁ foi gerado em outro rascunho, SEM chamar IA nenhuma (pedido do dono):
//  - o mesmo produto em outro canal: texto e fotos da Shopee → Mercado Livre;
//  - a família de kit: fotos do produto base → kits que o contêm, e entre kits do mesmo produto.
// POST ?modulo=fontes       {sku, canal, empresa}
//        → rascunhos de onde dá para TRAZER conteúdo para este produto/canal + a família do SKU.
// POST ?modulo=destinos     {rascunho_id}
//        → produtos da família para onde dá para LEVAR as fotos deste rascunho.
// POST ?modulo=aplicar      {origem_id, sku, canal, empresa, destino_id?, texto?, imagens?: [id],
//                            substituir?, aprovadas?}
// POST ?modulo=aplicar-lote {origem_id, skus: [..], canal, empresa, imagens: [id], substituir?, aprovadas?}
//        → cria o rascunho de cada produto que ainda não tem (com o preço calculado) e leva as fotos.
//          Para com folga do limite de tempo e devolve `restantes` (reenviar).
// Regras:
//  - exige sessão de usuário com o módulo `ia`;
//  - só mexe no banco e no armazenamento da gestão: NADA vai a marketplace nem a IA;
//  - a foto aproveitada NÃO divide o arquivo com a origem: é copiada UMA vez para
//    `compartilhado/{sku de origem}/{tipo}-{hash}.{ext}` e todos os destinos apontam para essa cópia
//    (o worker regrava o arquivo da origem ao "refazer"; a cópia não muda). Refazer a foto no
//    destino grava no caminho do próprio destino, sem tocar na cópia;
//  - foto que estava aprovada na origem entra aprovada (aprovadas=false desliga); as outras, para revisar;
//  - texto só entra aprovado quando é o MESMO produto, estava aprovado e o título cabe no canal.
// ============================================================================

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const BUCKET = "ia-anuncios";
const ORCAMENTO_MS = 22_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- acesso
type Quem = { id: string; doUsuario: SupabaseClient };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  return { id: String(pl.sub ?? ""), doUsuario };
}

// ---------------------------------------------------------------- família de kit
type Relacao = "mesmo" | "componente" | "kit" | "irmao";
type Parente = { sku: string; nome: string; tipo: string | null; relacao: Relacao; quantidade: number | null; n_componentes: number };

/** O próprio SKU, os componentes dele (se for kit) e os kits ativos que contêm ele ou os componentes dele. */
async function familia(sku: string): Promise<Parente[]> {
  const { data: comps } = await db.from("produto_kits").select("sku_componente, quantidade").eq("sku_kit", sku);
  const componentes = ((comps ?? []) as { sku_componente: string; quantidade: number }[]);
  const raizes = [...new Set([sku, ...componentes.map((c) => c.sku_componente)])];
  const { data: ks } = await db.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_componente", raizes).limit(2000);
  const kits = ((ks ?? []) as { sku_kit: string; sku_componente: string; quantidade: number }[]).filter((k) => k.sku_kit !== sku);
  const idsKit = [...new Set(kits.map((k) => k.sku_kit))];
  const todos = [...new Set([...raizes, ...idsKit])];
  const [prods, contagem] = await Promise.all([
    db.from("produtos").select("sku, nome, tipo, ativo, arquivado").in("sku", todos),
    idsKit.length ? db.from("produto_kits").select("sku_kit").in("sku_kit", idsKit).limit(5000) : Promise.resolve({ data: [] as { sku_kit: string }[] }),
  ]);
  const prod = new Map(((prods.data ?? []) as any[]).map((p) => [String(p.sku), p]));
  const nComp = new Map<string, number>();
  for (const x of ((contagem.data ?? []) as { sku_kit: string }[])) nComp.set(x.sku_kit, (nComp.get(x.sku_kit) ?? 0) + 1);

  const out: Parente[] = [];
  const eu = prod.get(sku);
  out.push({ sku, nome: String(eu?.nome ?? sku), tipo: eu?.tipo ?? null, relacao: "mesmo", quantidade: null, n_componentes: componentes.length });
  for (const c of componentes) {
    const p = prod.get(c.sku_componente);
    out.push({ sku: c.sku_componente, nome: String(p?.nome ?? c.sku_componente), tipo: p?.tipo ?? null, relacao: "componente", quantidade: Number(c.quantidade) || null, n_componentes: 0 });
  }
  const visto = new Set(out.map((x) => x.sku));
  for (const k of kits) {
    if (visto.has(k.sku_kit)) continue;
    const p = prod.get(k.sku_kit);
    if (!p || p.ativo === false || p.arquivado === true) continue; // kit desativado não entra
    visto.add(k.sku_kit);
    out.push({
      sku: k.sku_kit, nome: String(p.nome ?? k.sku_kit), tipo: p.tipo ?? null,
      relacao: k.sku_componente === sku ? "kit" : "irmao", quantidade: Number(k.quantidade) || null, n_componentes: nComp.get(k.sku_kit) ?? 1,
    });
  }
  return out;
}

// ---------------------------------------------------------------- leitura dos rascunhos
type Img = { id: string; ordem: number; tipo: string; storage_path: string | null; status: string | null; hash: string | null };
async function imagensDe(rascunhoIds: string[]): Promise<Map<string, Img[]>> {
  const out = new Map<string, Img[]>();
  if (!rascunhoIds.length) return out;
  const [imgs, ets] = await Promise.all([
    db.from("ia_rascunho_imagem").select("id, rascunho_id, ordem, tipo, storage_path").in("rascunho_id", rascunhoIds).order("ordem").limit(5000),
    db.from("ia_etapa").select("imagem_id, status, conteudo_hash").in("rascunho_id", rascunhoIds).eq("etapa", "imagem").limit(5000),
  ]);
  const et = new Map(((ets.data ?? []) as any[]).map((e) => [String(e.imagem_id), e]));
  for (const i of ((imgs.data ?? []) as any[])) {
    const e = et.get(String(i.id));
    const l = out.get(i.rascunho_id) ?? [];
    l.push({ id: String(i.id), ordem: Number(i.ordem), tipo: String(i.tipo ?? ""), storage_path: i.storage_path ?? null, status: e?.status ?? null, hash: e?.conteudo_hash ?? null });
    out.set(i.rascunho_id, l);
  }
  return out;
}
async function textoDe(rascunhoIds: string[]): Promise<Map<string, string>> {
  if (!rascunhoIds.length) return new Map();
  const { data } = await db.from("ia_etapa").select("rascunho_id, status").in("rascunho_id", rascunhoIds).eq("etapa", "texto");
  return new Map(((data ?? []) as any[]).map((e) => [String(e.rascunho_id), String(e.status)]));
}
/** O rascunho mais recente do produto no canal/empresa (é o que a tela abre). */
async function rascunhoAtual(sku: string, canal: string, empresa: string) {
  const { data } = await db.from("ia_rascunho").select("*").eq("sku", sku).eq("canal", canal).eq("empresa", empresa)
    .order("created_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] ?? null) as Record<string, any> | null;
}
async function limiteTitulo(canal: string): Promise<number> {
  const { data } = await db.from("ia_canal_config").select("titulo_max_chars").eq("canal", canal).maybeSingle();
  return Number(data?.titulo_max_chars) || 120;
}

// ---------------------------------------------------------------- fontes (de onde trazer)
async function fontes(body: Record<string, any>) {
  const sku = String(body.sku ?? "").trim();
  const canal = String(body.canal ?? "shopee"); const empresa = String(body.empresa ?? "ottz");
  if (!sku) throw new Error("informe o sku");
  const fam = await familia(sku);
  const relacao = new Map(fam.map((f) => [f.sku, f]));
  const destino = body.destino_id
    ? ((await db.from("ia_rascunho").select("*").eq("id", String(body.destino_id)).maybeSingle()).data as Record<string, any> | null)
    : await rascunhoAtual(sku, canal, empresa);
  const { data: rs } = await db.from("ia_rascunho").select("id, sku, canal, empresa, status, titulo, updated_at")
    .in("sku", fam.map((f) => f.sku)).order("updated_at", { ascending: false }).limit(300);
  const lista = ((rs ?? []) as Record<string, any>[]).filter((r) => r.id !== destino?.id);
  const ids = [...lista.map((r) => String(r.id)), ...(destino ? [String(destino.id)] : [])];
  const [imgs, txt, lim] = await Promise.all([imagensDe(ids), textoDe(ids), limiteTitulo(canal)]);
  const ordemRel: Record<Relacao, number> = { mesmo: 0, componente: 1, irmao: 2, kit: 3 };
  const saida = lista.map((r) => {
    const p = relacao.get(String(r.sku))!;
    const is = (imgs.get(String(r.id)) ?? []).filter((i) => i.storage_path);
    return {
      rascunho_id: r.id, sku: r.sku, nome: p.nome, relacao: p.relacao, quantidade: p.quantidade, n_componentes: p.n_componentes,
      canal: r.canal, empresa: r.empresa, atualizado: r.updated_at,
      texto: r.titulo ? { status: txt.get(String(r.id)) ?? null, titulo: r.titulo, n_titulo: String(r.titulo).length } : null,
      imagens: is.map((i) => ({ id: i.id, ordem: i.ordem, tipo: i.tipo, storage_path: i.storage_path, status: i.status })),
    };
  }).filter((f) => f.texto || f.imagens.length)
    .sort((a, b) => ordemRel[a.relacao] - ordemRel[b.relacao] || b.imagens.length - a.imagens.length);
  const imgsDest = destino ? (imgs.get(String(destino.id)) ?? []) : [];
  return {
    ok: true, sku, canal, empresa, limite_titulo: lim,
    destino: destino ? {
      rascunho_id: destino.id, tem_texto: !!destino.titulo,
      tipos: imgsDest.filter((i) => i.storage_path || ["na_fila", "gerando"].includes(String(i.status))).map((i) => i.tipo),
      n_fotos: imgsDest.filter((i) => i.storage_path).length,
    } : null,
    familia: fam.filter((f) => f.relacao !== "mesmo"),
    fontes: saida,
  };
}

// ---------------------------------------------------------------- destinos (para onde levar)
async function destinos(body: Record<string, any>) {
  const { data: o } = await db.from("ia_rascunho").select("id, sku, canal, empresa").eq("id", String(body.rascunho_id ?? "")).maybeSingle();
  if (!o) throw new Error("rascunho não encontrado");
  const fam = (await familia(String(o.sku))).filter((f) => f.relacao !== "mesmo");
  const skus = fam.map((f) => f.sku);
  if (!skus.length) return { ok: true, origem: o, destinos: [] };
  const [rs, fotos] = await Promise.all([
    db.from("ia_rascunho").select("id, sku, created_at").in("sku", skus).eq("canal", o.canal).eq("empresa", o.empresa).order("created_at", { ascending: false }).limit(1000),
    db.from("view_foto_produto").select("sku, foto").in("sku", skus),
  ]);
  const rasc = new Map<string, string>();
  for (const r of ((rs.data ?? []) as any[])) if (!rasc.has(String(r.sku))) rasc.set(String(r.sku), String(r.id));
  const imgs = await imagensDe([...rasc.values()]);
  const foto = new Map(((fotos.data ?? []) as any[]).map((f) => [String(f.sku), f.foto as string | null]));
  return {
    ok: true, origem: o,
    destinos: fam.map((f) => {
      const id = rasc.get(f.sku) ?? null;
      const is = id ? (imgs.get(id) ?? []) : [];
      return { ...f, foto: foto.get(f.sku) ?? null, rascunho_id: id, n_fotos: is.filter((i) => i.storage_path).length, tipos: is.filter((i) => i.storage_path).map((i) => i.tipo) };
    }),
  };
}

// ---------------------------------------------------------------- cópia das fotos
async function sha12(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
/** Cópia que não muda mais: uma por foto de origem, usada por todos os destinos. */
async function copiaCompartilhada(skuOrigem: string, src: Record<string, any>, hash: string | null, feitas: Map<string, string>): Promise<string> {
  const de = String(src.storage_path);
  if (de.startsWith("compartilhado/")) return de; // já é uma cópia: reaproveita a mesma
  if (feitas.has(de)) return feitas.get(de)!;
  const ext = (de.split(".").pop() || "png").toLowerCase();
  const h = hash ? hash.slice(0, 12) : await sha12(`${de}|${src.gerado_em ?? ""}`);
  const para = `compartilhado/${skuOrigem}/${src.tipo}-${h}.${ext}`;
  const { error } = await db.storage.from(BUCKET).copy(de, para);
  if (error && !/exist|duplicate|409/i.test(`${error.message} ${(error as any).statusCode ?? ""} ${(error as any).error ?? ""}`)) {
    throw new Error(`não consegui copiar a foto ${src.tipo}: ${error.message}`);
  }
  feitas.set(de, para);
  return para;
}

type Origem = { r: Record<string, any>; imagens: Map<string, Record<string, any>>; etapas: Map<string, Record<string, any>> };
async function carregarOrigem(origemId: string): Promise<Origem> {
  const { data: r } = await db.from("ia_rascunho").select("*").eq("id", origemId).maybeSingle();
  if (!r) throw new Error("rascunho de origem não encontrado");
  const [imgs, ets] = await Promise.all([
    db.from("ia_rascunho_imagem").select("*").eq("rascunho_id", origemId),
    db.from("ia_etapa").select("*").eq("rascunho_id", origemId),
  ]);
  return {
    r: r as Record<string, any>,
    imagens: new Map(((imgs.data ?? []) as any[]).map((i) => [String(i.id), i])),
    etapas: new Map(((ets.data ?? []) as any[]).map((e) => [e.etapa === "texto" ? "texto" : String(e.imagem_id), e])),
  };
}

/** Leva as fotos escolhidas da origem para um rascunho de destino. */
async function levarFotos(o: Origem, destino: Record<string, any>, ids: string[], op: { substituir: boolean; aprovadas: boolean }, quem: Quem, feitas: Map<string, string>) {
  const copiadas: string[] = []; const puladas: { tipo: string; motivo: string }[] = [];
  if (!ids.length) return { copiadas, puladas };
  const [cfg, atuais, etsDest] = await Promise.all([
    db.from("ia_canal_config").select("regras_extras").eq("canal", destino.canal).maybeSingle(),
    db.from("ia_rascunho_imagem").select("id, ordem, tipo, storage_path").eq("rascunho_id", destino.id),
    db.from("ia_etapa").select("id, imagem_id, status").eq("rascunho_id", destino.id).eq("etapa", "imagem"),
  ]);
  // mesma regra de ordem da ia-anuncio: plano do canal = 1..N; os outros tipos ficam acima de 100
  const plano = (((cfg.data as any)?.regras_extras?.plano_fotos ?? []) as string[]).map((f) => (f.startsWith("imagem_") ? f : `imagem_${f}`));
  const porTipo = new Map<string, Record<string, any>>(); const ordens = new Set<number>(); let maiorExtra = 100;
  for (const x of ((atuais.data ?? []) as any[])) { porTipo.set(String(x.tipo), x); ordens.add(Number(x.ordem)); if (Number(x.ordem) > maiorExtra) maiorExtra = Number(x.ordem); }
  const etapaDe = new Map(((etsDest.data ?? []) as any[]).map((e) => [String(e.imagem_id), e]));
  const agora = new Date().toISOString();

  for (const id of ids) {
    const src = o.imagens.get(String(id));
    if (!src) { puladas.push({ tipo: String(id), motivo: "não é uma foto do rascunho de origem" }); continue; }
    const tipo = String(src.tipo ?? "");
    if (!src.storage_path) { puladas.push({ tipo, motivo: "a foto de origem ainda não foi gerada" }); continue; }
    const jaTem = porTipo.get(tipo);
    const etJa = jaTem ? etapaDe.get(String(jaTem.id)) : undefined;
    if (etJa && ["na_fila", "gerando", "enviando"].includes(String(etJa.status))) { puladas.push({ tipo, motivo: "está sendo gerada neste rascunho" }); continue; }
    if (jaTem?.storage_path && !op.substituir) { puladas.push({ tipo, motivo: "já existe neste rascunho" }); continue; }
    const etSrc = o.etapas.get(String(src.id));
    let caminho: string;
    try { caminho = await copiaCompartilhada(String(o.r.sku), src, etSrc?.conteudo_hash ?? null, feitas); }
    catch (e) { puladas.push({ tipo, motivo: String(e instanceof Error ? e.message : e) }); continue; }
    if (jaTem?.storage_path === caminho) { puladas.push({ tipo, motivo: "já é esta mesma foto" }); continue; }

    let ordem: number;
    if (jaTem) ordem = Number(jaTem.ordem);
    else {
      const i = plano.indexOf(`imagem_${tipo}`);
      ordem = i !== -1 && !ordens.has(i + 1) ? i + 1 : ++maiorExtra;
    }
    const aprovada = op.aprovadas && etSrc?.status === "aprovado";
    const linha = {
      rascunho_id: destino.id, ordem, tipo, storage_path: caminho, prompt_usado: src.prompt_usado ?? null, modelo: src.modelo ?? null,
      status: aprovada ? "aprovada" : "gerada", referencia_path: src.referencia_path ?? null, referencia_bytes: src.referencia_bytes ?? null,
      referencia_sha256: src.referencia_sha256 ?? null, gerado_em: src.gerado_em ?? agora, revisado_em: aprovada ? agora : null,
    };
    const { data: img, error: eI } = await db.from("ia_rascunho_imagem").upsert(linha, { onConflict: "rascunho_id,ordem" }).select("id").single();
    if (eI || !img) { puladas.push({ tipo, motivo: `banco: ${eI?.message ?? "sem retorno"}` }); continue; }
    ordens.add(ordem); porTipo.set(tipo, { id: img.id, ordem, tipo, storage_path: caminho });
    const dados = {
      status: aprovada ? "aprovado" : "gerado", conteudo_hash: etSrc?.conteudo_hash ?? null, observacao: null, tentativas: 0, erro: null,
      pegado_em: null, proxima_em: null, aprovado_em: aprovada ? agora : null, aprovado_por: aprovada ? quem.id : null, atualizado_em: agora,
    };
    const et = etapaDe.get(String(img.id));
    const res = et
      ? await db.from("ia_etapa").update(dados).eq("id", et.id).select("id").single()
      : await db.from("ia_etapa").insert({ rascunho_id: destino.id, etapa: "imagem", imagem_id: img.id, ...dados }).select("id").single();
    if (res.error || !res.data) { puladas.push({ tipo, motivo: `etapa: ${res.error?.message ?? "sem retorno"}` }); continue; }
    etapaDe.set(String(img.id), { id: res.data.id, imagem_id: img.id, status: dados.status });
    copiadas.push(tipo);
  }
  return { copiadas, puladas };
}

/** Acha o rascunho do produto no canal/empresa ou cria um (com o preço calculado, em nome de quem pediu). */
async function acharOuCriar(sku: string, canal: string, empresa: string, quem: Quem): Promise<{ r: Record<string, any>; criado: boolean }> {
  const atual = await rascunhoAtual(sku, canal, empresa);
  if (atual) return { r: atual, criado: false };
  const { data: id, error } = await quem.doUsuario.rpc("ia_rascunho_criar", { p_sku: sku, p_canal: canal, p_empresa: empresa });
  if (error || !id) throw new Error(`não consegui criar o rascunho de ${sku}: ${error?.message ?? "sem retorno"}`);
  const { data: r } = await db.from("ia_rascunho").select("*").eq("id", String(id)).single();
  if (!r) throw new Error(`rascunho de ${sku} criado, mas não consegui ler`);
  return { r: r as Record<string, any>, criado: true };
}

// ---------------------------------------------------------------- aplicar (um destino)
async function aplicar(body: Record<string, any>, quem: Quem) {
  const o = await carregarOrigem(String(body.origem_id ?? ""));
  const sku = String(body.sku ?? "").trim();
  const canal = String(body.canal ?? ""); const empresa = String(body.empresa ?? "ottz");
  let destino: Record<string, any>; let criado = false;
  if (body.destino_id) {
    const { data } = await db.from("ia_rascunho").select("*").eq("id", String(body.destino_id)).maybeSingle();
    if (!data) throw new Error("rascunho de destino não encontrado");
    destino = data as Record<string, any>;
  } else {
    if (!sku || !canal) throw new Error("informe sku e canal do destino");
    const x = await acharOuCriar(sku, canal, empresa, quem); destino = x.r; criado = x.criado;
  }
  if (String(destino.id) === String(o.r.id)) throw new Error("a origem e o destino são o mesmo rascunho");
  const mesmoProduto = String(destino.sku) === String(o.r.sku);
  const op = { substituir: body.substituir === true, aprovadas: body.aprovadas !== false };
  const avisos: string[] = [];

  // ---- texto
  let texto: "copiado" | "copiado_aprovado" | null = null;
  if (body.texto === true) {
    if (!o.r.titulo) throw new Error("o rascunho de origem não tem texto");
    const lim = await limiteTitulo(String(destino.canal));
    const titulo = String(o.r.titulo).trim();
    const { error } = await db.from("ia_rascunho").update({
      titulo, descricao: o.r.descricao ?? null, bullet_points: o.r.bullet_points ?? [],
      prompt_template_id: o.r.prompt_template_id ?? null, modelo_texto: o.r.modelo_texto ?? null,
      ...(mesmoProduto ? { briefing_id: o.r.briefing_id ?? null } : {}),
      status: destino.status === "publicado" ? "publicado" : "aguardando_revisao", erro: null,
      memoria_calculo: { ...(destino.memoria_calculo ?? {}), texto_aproveitado_de: { rascunho_id: o.r.id, sku: o.r.sku, canal: o.r.canal, empresa: o.r.empresa, em: new Date().toISOString() } },
    }).eq("id", destino.id);
    if (error) throw new Error(`banco (texto): ${error.message}`);
    texto = "copiado";
    // o gatilho do banco deixa a etapa de texto "para revisar"; mantém aprovado só se nada precisa de ajuste
    const origemAprovada = o.etapas.get("texto")?.status === "aprovado";
    if (titulo.length > lim) avisos.push(`o título tem ${titulo.length} caracteres e este canal aceita ${lim}: encurte e aprove o texto`);
    else if (!mesmoProduto) avisos.push("o texto veio de outro produto: confira nome e quantidade antes de aprovar");
    else if (origemAprovada && op.aprovadas) {
      const agora = new Date().toISOString();
      const { error: eA } = await db.from("ia_etapa").update({ status: "aprovado", aprovado_em: agora, aprovado_por: quem.id, erro: null, atualizado_em: agora })
        .eq("rascunho_id", destino.id).eq("etapa", "texto");
      if (!eA) texto = "copiado_aprovado";
    }
  }

  // ---- fotos
  const ids = Array.isArray(body.imagens) ? (body.imagens as unknown[]).map(String) : [];
  const f = await levarFotos(o, destino, ids, op, quem, new Map());
  const comSelo = f.copiadas.filter((t) => /shopee/.test(t));
  if (comSelo.length && destino.canal !== "shopee") avisos.push(`${comSelo.length} capa(s) com o selo da Shopee veio(ram) junto: não use em outro canal`);
  return { ok: true, rascunho_id: destino.id, criado, texto, copiadas: f.copiadas, puladas: f.puladas, avisos };
}

// ---------------------------------------------------------------- aplicar em vários produtos (kits)
async function aplicarLote(body: Record<string, any>, quem: Quem) {
  const t0 = Date.now();
  const o = await carregarOrigem(String(body.origem_id ?? ""));
  const canal = String(body.canal ?? o.r.canal); const empresa = String(body.empresa ?? o.r.empresa);
  const skus = [...new Set((Array.isArray(body.skus) ? (body.skus as unknown[]) : []).map((s) => String(s).trim()).filter(Boolean))];
  const ids = Array.isArray(body.imagens) ? (body.imagens as unknown[]).map(String) : [];
  if (!skus.length) throw new Error("escolha ao menos um produto");
  if (!ids.length) throw new Error("escolha ao menos uma foto");
  // só produtos da família do SKU de origem (não é uma porta para copiar para qualquer produto)
  const permitidos = new Set((await familia(String(o.r.sku))).filter((f) => f.relacao !== "mesmo").map((f) => f.sku));
  const op = { substituir: body.substituir === true, aprovadas: body.aprovadas !== false };
  const feitas = new Map<string, string>();
  const feitos: Record<string, unknown>[] = []; const restantes: string[] = [];
  for (const sku of skus) {
    if (Date.now() - t0 > ORCAMENTO_MS) { restantes.push(sku); continue; }
    if (!permitidos.has(sku)) { feitos.push({ sku, ok: false, erro: "não é da família deste produto" }); continue; }
    try {
      const { r, criado } = await acharOuCriar(sku, canal, empresa, quem);
      const f = await levarFotos(o, r, ids, op, quem, feitas);
      feitos.push({ sku, ok: true, rascunho_id: r.id, criado, copiadas: f.copiadas.length, puladas: f.puladas });
    } catch (e) {
      feitos.push({ sku, ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 300) });
    }
  }
  return { ok: true, feitos, restantes };
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") ?? "";
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  try {
    if (modulo === "fontes") return json(await fontes(body));
    if (modulo === "destinos") return json(await destinos(body));
    if (modulo === "aplicar") return json(await aplicar(body, quem));
    if (modulo === "aplicar-lote") return json(await aplicarLote(body, quem));
    return json({ ok: false, erro: "use ?modulo=fontes, destinos, aplicar ou aplicar-lote" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
