// =============================================================================
// Edge Function: ia-anuncio v1 — IA · Anúncios, Fase 2 (09/out/2026)
// -----------------------------------------------------------------------------
// Geração de anúncio DENTRO da gestão (porte do gerador pcobdzlpnaoqdbsdzhlq).
// POST ?modulo=... com body JSON. Exige usuário com módulo `ia` (ou service role).
//   briefing        {sku, forcar?}                   → ia_briefing (cache por sku)
//   texto           {sku, canal, empresa, rascunho_id?, observacao?}
//                   sem rascunho_id: cria ia_rascunho com preço (ia_calcular_preco);
//                   com rascunho_id: refaz o texto do MESMO rascunho (preço/imagens intocados)
//   prompts-imagem  {sku, canal, fotos?, forcar?, capa?} → ia_prompt_imagem (editado à mão é preservado)
//   imagens         {rascunho_id, fotos?, modelo?, observacao?} → SÓ enfileira (ia_etapa na_fila)
//                   e dispara 3 workers; quem gera é a ia-imagem-worker (1 imagem por chamada)
//   foto-ref        {sku, path?|refazer?}             → troca a foto real de referência congelada
// Envio ao Tiny = Fase 3 (não existe aqui).
// Diferenças do gerador: foto de referência única (cópia congelada); contextos
// baixados 1× por chamada; preço pelo CMV da gestão (view_cmv_efetivo); capa com
// `[CONFIRMAR` no prompt é recusada também no servidor; templates `__bkp_*` ignorados.
// =============================================================================
import {
  CORS, json, sb, exigirAcesso, carregarProduto, fotoReferencia, templatesAtivos, escolherTemplate,
  guardrails, blocoInstrucoes, regrasImagem, validar, carregarContextos, blocosContexto, claude, modeloTexto,
  planoFotos, dispararWorker, preencher, type Bloco, type DB, type Produto, type Quem,
} from "../_shared/ia.ts";

const WORKERS_EM_PARALELO = 3;

// ---------------------------------------------------------------- briefing
async function gerarBriefing(db: DB, p: Produto, forcar: boolean) {
  if (!forcar) {
    const { data } = await db.from("ia_briefing").select("*").eq("sku", p.sku).maybeSingle();
    if (data) return { ok: true, cache: true, briefing: data };
  }
  const [tpls, gs] = await Promise.all([templatesAtivos(db, ["briefing"]), guardrails(db)]);
  const tpl = escolherTemplate(tpls, "briefing", null);
  if (!tpl) throw new Error("template de briefing ativo não encontrado (/ia/prompts)");
  const foto = await fotoReferencia(db, p);
  if (!foto) throw new Error(`SKU ${p.sku} sem foto de referência — suba uma foto real na tela do anúncio`);

  const { porAplica, anexos } = await carregarContextos(db, p.sku, ["briefing"]);
  const ctx = blocosContexto(porAplica.briefing ?? [], anexos);
  const prompt = preencher(tpl.conteudo, {
    nome: p.nome, marca: p.marca, categoria: p.categoria, publico_alvo: p.publico_alvo,
    atributos: p.atributos, guardrails: blocoInstrucoes(gs),
  }, false);
  const modelo = modeloTexto(tpl);
  const bruto = await claude(modelo, [
    { type: "image", source: { type: "base64", media_type: foto.media_type, data: foto.data } },
    { type: "text", text: "Acima: a FOTO REAL do produto. Leia o rotulo." },
    ...ctx.blocos,
    { type: "text", text: ctx.texto ? `CONTEXTO ADICIONAL:\n${ctx.texto}\n\n${prompt}` : prompt },
  ], 2500);
  let j: Record<string, unknown>;
  try { j = JSON.parse(bruto.replace(/```json|```/g, "").trim()); }
  catch { throw new Error("o modelo não devolveu JSON válido no briefing: " + bruto.slice(0, 300)); }
  const linha = {
    sku: p.sku, persona: j.persona ?? null, dores: j.dores ?? [], objecoes: j.objecoes ?? [], beneficios: j.beneficios ?? [],
    angulo: j.angulo ?? null, tom: j.tom ?? null, palavras_chave: j.palavras_chave ?? [],
    fotos_recomendadas: j.fotos_recomendadas ?? [], modelo, bruto: j,
  };
  const { data: salvo, error } = await db.from("ia_briefing").upsert(linha, { onConflict: "sku" }).select("*").single();
  if (error) throw new Error(error.message);
  return { ok: true, cache: false, briefing: salvo, contextos_usados: ctx.usados };
}

// ---------------------------------------------------------------- texto
async function gerarTexto(db: DB, p: Produto, body: Record<string, any>, quem: Quem) {
  const canal = String(body.canal ?? "shopee");
  const empresa = String(body.empresa ?? "ottz");
  const rascunhoId: string | null = body.rascunho_id ?? null;
  const obs = typeof body.observacao === "string" && body.observacao.trim() ? body.observacao.trim().slice(0, 1500) : null;

  const [cfgR, tpls, gs] = await Promise.all([
    db.from("ia_canal_config").select("*").eq("canal", canal).maybeSingle(),
    templatesAtivos(db, ["titulo", "descricao", "bullet_points"]),
    guardrails(db),
  ]);
  const c = cfgR.data as Record<string, any> | null;
  if (!c) throw new Error(`canal não encontrado: ${canal}`);
  if (rascunhoId) {
    const { data: alvo } = await db.from("ia_rascunho").select("id, sku").eq("id", rascunhoId).maybeSingle();
    if (!alvo || alvo.sku !== p.sku) throw new Error(`rascunho ${rascunhoId} não é do SKU ${p.sku}`);
  }
  const tT = escolherTemplate(tpls, "titulo", canal), tD = escolherTemplate(tpls, "descricao", canal), tB = escolherTemplate(tpls, "bullet_points", canal);
  if (!tT || !tD || !tB) throw new Error("faltam templates ativos de título/descrição/bullets (/ia/prompts)");

  const foto = await fotoReferencia(db, p);
  if (!foto) throw new Error(`SKU ${p.sku} sem foto de referência — suba uma foto real na tela do anúncio`);
  const brief = (await gerarBriefing(db, p, false)).briefing as Record<string, any>;
  const resumoBrief = {
    persona: brief.persona, dores: brief.dores, objecoes: brief.objecoes, beneficios: brief.beneficios,
    angulo: brief.angulo, tom: brief.tom, palavras_chave: brief.palavras_chave,
  };
  const modelo = modeloTexto(tD);
  const { porAplica, anexos } = await carregarContextos(db, p.sku, ["titulo", "descricao", "bullet_points"]);

  async function rodar(tpl: { conteudo: string }, tipo: string, maxTokens: number) {
    const ctx = blocosContexto(porAplica[tipo] ?? [], anexos);
    const prompt = preencher(tpl.conteudo, {
      nome: p.nome, marca: p.marca, categoria: p.categoria, publico_alvo: p.publico_alvo, atributos: p.atributos,
      briefing: resumoBrief, titulo_max_chars: c!.titulo_max_chars, descricao_max_chars: c!.descricao_max_chars,
      guardrails: blocoInstrucoes(gs),
    });
    const comObs = obs ? `${prompt}\n\nOBSERVACAO DO OPERADOR (prioridade nesta nova versao; nao contrarie as regras obrigatorias): ${obs}` : prompt;
    const blocos: Bloco[] = [
      { type: "image", source: { type: "base64", media_type: foto!.media_type, data: foto!.data } },
      { type: "text", text: "Acima: a FOTO REAL do produto. Leia o rotulo." },
      ...ctx.blocos,
      { type: "text", text: ctx.texto ? `CONTEXTO ADICIONAL:\n${ctx.texto}\n\n${comObs}` : comObs },
    ];
    return { saida: await claude(modelo, blocos, maxTokens), contextos: ctx.usados };
  }
  const [rt, rd, rb] = await Promise.all([rodar(tT, "titulo", 300), rodar(tD, "descricao", 2000), rodar(tB, "bullet_points", 800)]);
  const vT = validar(rt.saida, gs), vD = validar(rd.saida, gs), vB = validar(rb.saida, gs);
  let bullets: string[] = [];
  try { bullets = JSON.parse(vB.texto.replace(/```json|```/g, "").trim()); }
  catch { bullets = vB.texto.split("\n").map((l) => l.replace(/^[-*\d.\s"]+/, "").replace(/",?$/, "").trim()).filter(Boolean); }
  const bloqueios = [...new Set([...vT.bloqueios, ...vD.bloqueios, ...vB.bloqueios])];
  const avisos = [...new Set([...vT.avisos, ...vD.avisos, ...vB.avisos])];
  const contextos = [...new Set([...rt.contextos, ...rd.contextos, ...rb.contextos])];
  if (vT.texto.length > Number(c.titulo_max_chars)) avisos.push(`título com ${vT.texto.length} caracteres (limite ${c.titulo_max_chars})`);
  const status = bloqueios.length ? "erro" : "aguardando_revisao";
  const erro = bloqueios.length ? `regras bloquearam: ${bloqueios.join(", ")}` : null;

  if (rascunhoId) {
    const { data: atual } = await db.from("ia_rascunho").select("memoria_calculo").eq("id", rascunhoId).single();
    const upd = {
      status, titulo: vT.texto, descricao: vD.texto, bullet_points: bullets, briefing_id: brief.id,
      modelo_texto: modelo, prompt_template_id: tD.id, erro,
      memoria_calculo: { ...(atual?.memoria_calculo ?? {}), avisos, bloqueios, contextos_usados: contextos, foto_lida: foto.origem, observacao_texto: obs },
    };
    const { error } = await db.from("ia_rascunho").update(upd).eq("id", rascunhoId);
    if (error) throw new Error(error.message);
    return { ok: true, rascunho_id: rascunhoId, refeito: true, status, avisos, contextos_usados: contextos };
  }

  const { data: preco } = await db.rpc("ia_calcular_preco", { p_sku: p.sku, p_canal: canal, p_empresa: empresa });
  const pr = (preco ?? {}) as Record<string, any>;
  if (pr.erro) avisos.push(`preço não calculado: ${pr.erro}`);
  const linha = {
    sku: p.sku, canal, empresa, status, titulo: vT.texto, descricao: vD.texto, bullet_points: bullets,
    briefing_id: brief.id, custo_snapshot: p.custo, preco_sugerido: pr.preco_sugerido ?? null,
    margem_estimada_pct: pr.margem_estimada_pct ?? null, prompt_template_id: tD.id, modelo_texto: modelo, erro,
    memoria_calculo: { ...(pr.memoria_calculo ?? {}), avisos, bloqueios, contextos_usados: contextos, foto_lida: foto.origem, observacao_texto: obs },
    criado_por: quem.id, criado_por_nome: quem.email,
  };
  const { data: salvo, error } = await db.from("ia_rascunho").insert(linha).select("id").single();
  if (error) throw new Error(error.message);
  return { ok: true, rascunho_id: salvo.id, status, avisos, contextos_usados: contextos };
}

// ---------------------------------------------------------------- prompts de imagem
type CapaEntrada = { quantidade?: unknown; peso?: unknown; barra?: unknown; faixa?: unknown; icones?: unknown; fundo?: unknown; sem_texto?: boolean | null };

/** Formulário de capa. Barra vazia = "sem barra" (o gerador mandava um EXEMPLO que virava texto na arte). */
function blocoOperador(capa: CapaEntrada | null): string {
  if (!capa || typeof capa !== "object") return "";
  const t = (x: unknown) => (x == null ? "" : String(x).trim().slice(0, 300));
  const qtd = t(capa.quantidade), peso = t(capa.peso), barra = t(capa.barra), faixa = t(capa.faixa), icones = t(capa.icones), fundo = t(capa.fundo);
  const l: string[] = [];
  l.push(`Quantidade de embalagens na composicao: ${qtd || "(nao informada — use a regra do esqueleto)"}`);
  l.push(peso
    ? `Peso impresso na embalagem: "${peso}" — CONFIRMADO PELO OPERADOR, use exatamente este no campo MANTER EXATAMENTE`
    : `Peso impresso na embalagem: (nao informado — LEIA na foto; se ilegivel, escreva [CONFIRMAR: peso ilegivel na referencia])`);
  if (capa.sem_texto) {
    l.push(`Este estilo NAO tem texto na capa: Barra inferior = "sem barra", Faixa superior = "sem faixa", Icones = "sem icones".`);
  } else {
    l.push(barra ? `Barra inferior de variacoes: ${barra} — exatamente estes valores, nesta ordem` : `Barra inferior de variacoes: sem barra`);
    l.push(faixa ? `Faixa superior: "${faixa}" — exatamente este texto` : `Faixa superior: sem faixa`);
    l.push(icones ? `Icones de beneficios: ${icones} — exatamente estes` : `Icones de beneficios: (livre — escolha de 3 a 5 beneficios REAIS do briefing; nunca invente)`);
  }
  l.push(`Fundo e composicao: ${fundo || "(livre — siga o estilo do esqueleto)"}`);
  return `\n\n═══ DADOS INFORMADOS PELO OPERADOR (valem mais que o esqueleto) ═══\n${l.join("\n")}`;
}

async function gerarPromptsImagem(db: DB, p: Produto, body: Record<string, any>) {
  const canal = String(body.canal ?? "shopee");
  const forcar = body.forcar === true;
  const fotos: string[] | null = Array.isArray(body.fotos) ? body.fotos : null;
  const [cfgR, tplsImg, tplsMeta, brf, gs, jaTem] = await Promise.all([
    db.from("ia_canal_config").select("regras_extras").eq("canal", canal).maybeSingle(),
    templatesAtivos(db, ["imagem"]),
    templatesAtivos(db, ["meta_prompt"]),
    db.from("ia_briefing").select("*").eq("sku", p.sku).maybeSingle(),
    guardrails(db),
    db.from("ia_prompt_imagem").select("*").eq("sku", p.sku),
  ]);
  const meta = escolherTemplate(tplsMeta, "meta_prompt", null);
  if (!meta) throw new Error("template meta_prompt ativo não encontrado (/ia/prompts)");
  if (!brf.data) throw new Error("sem briefing deste SKU — gere o texto (ou o briefing) antes");
  const brief = brf.data as Record<string, any>;
  const foto = await fotoReferencia(db, p);
  if (!foto) throw new Error(`SKU ${p.sku} sem foto de referência`);

  const ativos = new Set(tplsImg.map((t) => t.nome));
  const { alvo } = planoFotos(fotos, brief.fotos_recomendadas, (cfgR.data as any)?.regras_extras?.plano_fotos, ativos, p.eh_kit);
  if (!alvo.length) throw new Error("nenhuma foto a preparar (tipos pedidos sem template ativo)");

  const { porAplica, anexos } = await carregarContextos(db, p.sku, ["imagem"]);
  const blocosCtx: Bloco[] = []; const usados: string[] = [];
  for (const c of porAplica.imagem ?? []) {
    if (c.tipo === "texto") { blocosCtx.push({ type: "text", text: `CONTEXTO (${c.papel}) — ${c.nome}:\n${c.conteudo ?? ""}` }); usados.push(c.nome); continue; }
    const a = c.storage_path ? anexos.get(c.storage_path) : undefined;
    if (!a) continue;
    const mt = c.media_type ?? a.mime;
    blocosCtx.push(mt === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: mt, data: a.data } }
      : { type: "image", source: { type: "base64", media_type: mt, data: a.data } });
    blocosCtx.push({ type: "text", text: `Acima: ${c.nome} — papel: ${c.papel}. Se for referencia_produto, descreva no prompt a textura/formato REAL que voce ve aqui.` });
    usados.push(c.nome);
  }
  const regras = regrasImagem(gs);
  const modelo = modeloTexto(meta);
  const existentes = (jaTem.data ?? []) as Record<string, any>[];
  const feitos: unknown[] = []; const pulados: unknown[] = [];

  // até 4 ao mesmo tempo (o gerador disparava todos juntos e tomava 429)
  const fila = [...alvo];
  async function trabalhador() {
    for (let tipo = fila.shift(); tipo; tipo = fila.shift()) {
      const antigo = existentes.find((e) => e.tipo === tipo);
      if (antigo?.editado_mao && !forcar) { pulados.push({ tipo, motivo: "editado à mão — preservado" }); continue; }
      if (antigo && !forcar) { pulados.push({ tipo, motivo: "já existe (refazer = forçar)" }); continue; }
      const esqueleto = tplsImg.find((t) => t.nome === tipo)!.conteudo;
      const texto = preencher(meta!.conteudo, {
        tipo_foto: tipo.replace("imagem_", ""), nome: p.nome, marca: p.marca, categoria: p.categoria,
        persona: brief.persona, dores: brief.dores, objecoes: brief.objecoes, beneficios: brief.beneficios,
        angulo: brief.angulo, tom: brief.tom, esqueleto,
      });
      const operador = tipo.startsWith("imagem_capa_") ? blocoOperador(body.capa ?? null) : "";
      const blocos: Bloco[] = [
        { type: "image", source: { type: "base64", media_type: foto!.media_type, data: foto!.data } },
        { type: "text", text: "Acima: a FOTO REAL do produto (embalagem). Leia o rotulo e observe o formato fisico." },
        ...blocosCtx,
        { type: "text", text: texto + operador + (regras ? `\n\nREGRAS QUE O PROMPT DEVE CARREGAR:\n${regras}` : "") },
      ];
      try {
        const prompt = await claude(modelo, blocos, tipo.startsWith("imagem_capa_") ? 1400 : 900);
        const { error } = await db.from("ia_prompt_imagem").upsert({ sku: p.sku, tipo, prompt, modelo, editado_mao: false }, { onConflict: "sku,tipo" });
        if (error) throw new Error(error.message);
        feitos.push({ tipo, palavras: prompt.split(/\s+/).length, confirmar: prompt.includes("[CONFIRMAR") });
      } catch (e) {
        pulados.push({ tipo, motivo: String(e instanceof Error ? e.message : e).slice(0, 200) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, alvo.length) }, trabalhador));
  return { ok: true, sku: p.sku, contextos_usados: usados, prompts_escritos: feitos, pulados };
}

// ---------------------------------------------------------------- imagens (só enfileira)
async function enfileirarImagens(db: DB, body: Record<string, any>) {
  const rascunhoId = String(body.rascunho_id ?? "");
  if (!rascunhoId) throw new Error("informe rascunho_id");
  const { data: r } = await db.from("ia_rascunho").select("id, sku, canal").eq("id", rascunhoId).maybeSingle();
  if (!r) throw new Error("rascunho não encontrado");
  const p = await carregarProduto(db, r.sku);
  if (!p) throw new Error(`SKU não encontrado no catálogo: ${r.sku}`);
  const fotos: string[] | null = Array.isArray(body.fotos) ? body.fotos : null;
  const observacao = typeof body.observacao === "string" && body.observacao.trim() ? body.observacao.trim().slice(0, 1500) : null;

  const [cfgR, tplsImg, brf, mods, prompts, imgs] = await Promise.all([
    db.from("ia_canal_config").select("regras_extras").eq("canal", r.canal).maybeSingle(),
    templatesAtivos(db, ["imagem"]),
    db.from("ia_briefing").select("fotos_recomendadas").eq("sku", r.sku).maybeSingle(),
    db.from("ia_modelo_imagem").select("*").eq("ativo", true),
    db.from("ia_prompt_imagem").select("tipo, prompt").eq("sku", r.sku),
    db.from("ia_rascunho_imagem").select("id, ordem, tipo").eq("rascunho_id", rascunhoId),
  ]);
  const catalogo = (mods.data ?? []) as Record<string, any>[];
  const escolhido = body.modelo ? catalogo.find((m) => m.id === body.modelo) : catalogo.find((m) => m.padrao);
  if (!escolhido) throw new Error(body.modelo ? `modelo inativo ou inexistente: ${body.modelo}` : "nenhum modelo de imagem padrão ativo (/ia/prompts › Modelos)");

  const ativos = new Set(tplsImg.map((t) => t.nome));
  const { alvo, ignoradas, planoCanal } = planoFotos(fotos, brf.data?.fotos_recomendadas, (cfgR.data as any)?.regras_extras?.plano_fotos, ativos, p.eh_kit);
  const promptPor = new Map(((prompts.data ?? []) as { tipo: string; prompt: string }[]).map((x) => [x.tipo, x.prompt]));
  const puladas: { tipo: string; motivo: string }[] = [];
  const plano = alvo.filter((f) => {
    if (!f.startsWith("imagem_capa_")) return true;
    const pr = promptPor.get(f);
    if (!pr) { puladas.push({ tipo: f.replace("imagem_", ""), motivo: "capa sem prompt — prepare o prompt antes" }); return false; }
    // o gerador mandava a capa com "[CONFIRMAR: ...]" e o texto saía impresso na arte
    if (pr.includes("[CONFIRMAR")) { puladas.push({ tipo: f.replace("imagem_", ""), motivo: "o prompt da capa tem [CONFIRMAR …] — edite o prompt antes" }); return false; }
    return true;
  });
  if (!plano.length) return { ok: false, erro: "nenhuma foto a gerar", puladas, ignoradas };

  // ordem estável: plano do canal = 1..N; demais tipos reusam a ordem que já têm ou pegam > 100
  const porTipo = new Map<string, number>(); let maiorExtra = 100;
  for (const x of (imgs.data ?? []) as { ordem: number; tipo: string }[]) { porTipo.set(x.tipo, x.ordem); if (x.ordem > maiorExtra) maiorExtra = x.ordem; }
  const ordemPara = (nome: string) => {
    const tipo = nome.replace("imagem_", "");
    if (porTipo.has(tipo)) return porTipo.get(tipo)!;
    const i = planoCanal.indexOf(nome);
    if (i !== -1) return i + 1;
    return ++maiorExtra;
  };

  const enfileiradas: { tipo: string; etapa_id: string }[] = [];
  for (const nome of plano) {
    const tipo = nome.replace("imagem_", "");
    const { data: img, error: eI } = await db.from("ia_rascunho_imagem")
      .upsert({ rascunho_id: rascunhoId, ordem: ordemPara(nome), tipo, modelo: escolhido.id }, { onConflict: "rascunho_id,ordem" })
      .select("id").single();
    if (eI || !img) { puladas.push({ tipo, motivo: `banco: ${eI?.message ?? "sem retorno"}` }); continue; }
    const { data: et } = await db.from("ia_etapa").select("id, status").eq("imagem_id", img.id).maybeSingle();
    if (et && ["na_fila", "gerando", "enviando"].includes(et.status)) { puladas.push({ tipo, motivo: `já está ${et.status}` }); continue; }
    const dados = { status: "na_fila", observacao, tentativas: 0, erro: null, pegado_em: null, proxima_em: null, aprovado_em: null, aprovado_por: null, atualizado_em: new Date().toISOString() };
    const res = et
      ? await db.from("ia_etapa").update(dados).eq("id", et.id).select("id").single()
      : await db.from("ia_etapa").insert({ rascunho_id: rascunhoId, etapa: "imagem", imagem_id: img.id, ...dados }).select("id").single();
    if (res.error || !res.data) { puladas.push({ tipo, motivo: `etapa: ${res.error?.message ?? "sem retorno"}` }); continue; }
    enfileiradas.push({ tipo, etapa_id: res.data.id });
  }
  for (let i = 0; i < Math.min(WORKERS_EM_PARALELO, enfileiradas.length); i++) dispararWorker();
  const semPrompt = plano.filter((f) => !promptPor.has(f)).map((f) => f.replace("imagem_", ""));
  return {
    ok: true, rascunho_id: rascunhoId, modelo: { id: escolhido.id, label: escolhido.label },
    enfileiradas, puladas, ignoradas: ignoradas.length ? ignoradas : undefined,
    custo_estimado_usd: Number((Number(escolhido.custo_estimado_usd) * enfileiradas.length).toFixed(3)),
    aviso: semPrompt.length ? `sem prompt preparado (vão pelo template genérico): ${semPrompt.join(", ")}` : undefined,
  };
}

// ---------------------------------------------------------------- foto de referência
async function trocarFotoRef(db: DB, p: Produto, body: Record<string, any>) {
  if (typeof body.path === "string" && body.path) {
    if (!body.path.startsWith(`ref/${p.sku}/`)) throw new Error(`a foto deve estar em ref/${p.sku}/`);
    const { error } = await db.from("ia_produto_extra").upsert({ sku: p.sku, foto_ref_path: body.path, fotos_ref: [body.path, ...p.fotos_ref.filter((x) => x !== body.path)] }, { onConflict: "sku" });
    if (error) throw new Error(error.message);
    return { ok: true, foto_ref_path: body.path };
  }
  if (body.refazer) {
    p.foto_ref_path = null;
    const f = await fotoReferencia(db, p);
    if (!f) throw new Error("não consegui baixar a foto do catálogo (Tiny)");
    return { ok: true, foto_ref_path: p.foto_ref_path, origem: f.origem };
  }
  throw new Error("informe path (foto enviada) ou refazer=true");
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") ?? "";
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const db = sb();
  try {
    if (modulo === "imagens") return json(await enfileirarImagens(db, body));
    const sku = String(body.sku ?? "").trim();
    if (!sku) return json({ erro: "informe o sku" }, 400);
    const p = await carregarProduto(db, sku);
    if (!p) return json({ erro: `SKU não encontrado no catálogo: ${sku}` }, 404);
    if (modulo === "briefing") return json(await gerarBriefing(db, p, body.forcar === true));
    if (modulo === "texto") return json(await gerarTexto(db, p, body, quem));
    if (modulo === "prompts-imagem") return json(await gerarPromptsImagem(db, p, body));
    if (modulo === "foto-ref") return json(await trocarFotoRef(db, p, body));
    return json({ erro: `módulo desconhecido: ${modulo}` }, 400);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
