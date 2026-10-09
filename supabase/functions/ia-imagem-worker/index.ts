// =============================================================================
// Edge Function: ia-imagem-worker v1 — IA · Anúncios, Fase 2 (09/out/2026)
// -----------------------------------------------------------------------------
// Gera UMA imagem por chamada, da fila em ia_etapa (etapa='imagem', status 'na_fila').
// Quem chama: ia-anuncio?modulo=imagens (3 em paralelo ao enfileirar), o próprio
// worker (encadeia o próximo ao terminar) e a rede de segurança ia_fila_vigiar()
// (cron a cada 5 min, só chama se há imagem parada há mais de 3 min).
// Não recebe dado de usuário além de `etapa_id`: só processa o que um usuário com
// módulo `ia` já enfileirou — por isso aceita a chave publicável do cron.
// Porte da gerar-imagem-worker v2 do gerador, com:
//  - referência = a cópia congelada da foto real (ia_produto_extra.foto_ref_path);
//  - backoff entre tentativas (o gerador re-tentava na hora e repetia o mesmo 429);
//  - tempo medido no log (limite da função).
// =============================================================================
import {
  CORS, json, sb, carregarProduto, fotoReferencia, templatesAtivos, guardrails, regrasImagem,
  carregarContextos, preencher, extDoMime, sha256hex, deB64, dispararWorker, BUCKET, type DB,
} from "../_shared/ia.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_EDITS = "https://api.openai.com/v1/images/edits";
const MAX_TENTATIVAS = 3;
type Parte = Record<string, unknown>;

function fraseDoPapel(papel: string, nome: string, escopo: string, chave: string | null): string {
  const de = escopo === "global" ? "" : ` (${escopo}${chave ? ": " + chave : ""})`;
  switch (papel) {
    case "referencia_produto":
      return `FOTO REAL adicional do produto — ${nome}${de}. Reproduza FIELMENTE textura, formato, cor real, brilho e proporcao que voce ve nela. Esta imagem manda mais que a sua imaginacao. Se ela mostra o CONTEUDO do produto (e nao a embalagem), use-a como verdade em qualquer close, detalhe ou cena de uso.`;
    case "identidade_visual":
      return `Manual de identidade visual${de} — ${nome}. Respeite paleta, tipografia, icones e estilo. NAO copie o layout das paginas; extraia as diretrizes.`;
    case "ficha_tecnica":
      return `Ficha tecnica do fabricante${de} — ${nome}. Use como fonte de dado. Nao invente o que nao estiver la.`;
    default:
      return `Material de referencia${de} — ${nome}. Siga as diretrizes contidas nele.`;
  }
}

/** Com prompt já escrito (ia_prompt_imagem), os contextos de TEXTO já foram digeridos nele; anexos seguem sempre. */
async function contextoImagem(db: DB, sku: string, incluirTextos: boolean) {
  const { porAplica, anexos } = await carregarContextos(db, sku, ["imagem"]);
  const partes: Parte[] = []; const textos: string[] = []; const usados: string[] = [];
  for (const c of porAplica.imagem ?? []) {
    const frase = fraseDoPapel(c.papel, c.nome, c.escopo, c.chave);
    if (c.tipo === "texto") {
      if (!incluirTextos) continue;
      partes.push({ text: `${frase}\n${c.conteudo ?? ""}` });
      textos.push(`${frase}\n${c.conteudo ?? ""}`);
      usados.push(`${c.nome} [${c.papel}]`);
      continue;
    }
    const a = c.storage_path ? anexos.get(c.storage_path) : undefined;
    if (!a) continue;
    partes.push({ inline_data: { mime_type: c.media_type ?? a.mime, data: a.data } });
    partes.push({ text: `Acima: ${frase}` });
    textos.push(`(anexo nao suportado neste modelo) ${frase}`);
    usados.push(`${c.nome} [${c.papel}]`);
  }
  return { partes, textos, usados };
}

async function viaGemini(key: string, model: string, partes: Parte[]) {
  const chamar = async (comConfig: boolean) => {
    const body: Record<string, unknown> = { contents: [{ parts: partes }] };
    if (comConfig) body.generationConfig = { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } };
    const r = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { r, txt: await r.text() };
  };
  let { r, txt } = await chamar(true);
  if (r.status === 400 && /imageConfig|aspect|generation_config|generationConfig/i.test(txt)) ({ r, txt } = await chamar(false));
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${txt.slice(0, 220)}`);
  const d = JSON.parse(txt);
  const ps = d?.candidates?.[0]?.content?.parts ?? [];
  const img = ps.find((p: Record<string, unknown>) => p.inlineData ?? p.inline_data);
  const inline = (img?.inlineData ?? img?.inline_data) as { mimeType?: string; mime_type?: string; data: string } | undefined;
  if (!inline?.data) throw new Error(`sem imagem (${d?.candidates?.[0]?.finishReason ?? "?"})`);
  return { bytes: deB64(inline.data), mime: inline.mimeType ?? inline.mime_type ?? "image/png" };
}

async function viaOpenAI(key: string, model: string, quality: string, prompt: string, ref: { mime: string; bytes: Uint8Array }) {
  const fd = new FormData();
  fd.append("model", model);
  fd.append("prompt", prompt);
  fd.append("size", "1024x1024");
  fd.append("quality", quality);
  fd.append("n", "1");
  fd.append("image", new Blob([ref.bytes], { type: ref.mime }), `referencia.${extDoMime(ref.mime)}`);
  const r = await fetch(OPENAI_EDITS, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${txt.slice(0, 220)}`);
  const b = JSON.parse(txt)?.data?.[0]?.b64_json;
  if (!b) throw new Error("sem b64_json na resposta");
  return { bytes: deB64(b), mime: "image/png" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  const db = sb();
  const body = await req.json().catch(() => ({}));

  const { data: pegos, error: eP } = await db.rpc("ia_imagem_fila_pegar", { p_etapa: body?.etapa_id ?? null });
  if (eP) return json({ erro: eP.message }, 500);
  const etapa = ((pegos ?? []) as Record<string, any>[])[0];
  if (!etapa) return json({ ok: true, nota: "fila vazia" });

  try {
    const { data: img } = await db.from("ia_rascunho_imagem").select("*").eq("id", etapa.imagem_id).single();
    if (!img) throw new Error("linha da imagem não encontrada");
    const { data: r } = await db.from("ia_rascunho").select("*").eq("id", etapa.rascunho_id).single();
    if (!r) throw new Error("rascunho não encontrado");
    const p = await carregarProduto(db, r.sku);
    if (!p) throw new Error(`SKU não encontrado no catálogo: ${r.sku}`);

    const [tpls, gs, brf, mods, feitoR] = await Promise.all([
      templatesAtivos(db, ["imagem"]),
      guardrails(db),
      db.from("ia_briefing").select("*").eq("sku", r.sku).maybeSingle(),
      db.from("ia_modelo_imagem").select("*").eq("ativo", true),
      db.from("ia_prompt_imagem").select("*").eq("sku", r.sku).eq("tipo", `imagem_${img.tipo}`).maybeSingle(),
    ]);
    const catalogo = (mods.data ?? []) as Record<string, any>[];
    const escolhido = catalogo.find((m) => m.id === img.modelo) ?? catalogo.find((m) => m.padrao);
    if (!escolhido) throw new Error("nenhum modelo de imagem ativo");
    const key = escolhido.provider === "gemini" ? Deno.env.get("GOOGLE_API_KEY") : Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error(`chave do ${escolhido.provider} não cadastrada nos secrets do Supabase da gestão`);

    const ref = await fotoReferencia(db, p);
    if (!ref || ref.bytes.length < 1000) throw new Error("Sem foto real de referência: suba a foto real do produto na tela do anúncio.");
    const refSha = await sha256hex(ref.bytes);

    const brief = brf.data as Record<string, any> | null;
    const feito = feitoR.data as Record<string, any> | null;
    const ctx = await contextoImagem(db, r.sku, !feito);
    const regras = regrasImagem(gs);
    const tpl = tpls.find((t) => t.nome === `imagem_${img.tipo}`);
    if (!feito && !tpl) throw new Error(`template inativo ou inexistente: imagem_${img.tipo}`);
    const base = feito ? String(feito.prompt) : preencher(tpl!.conteudo, {
      nome: p.nome, marca: p.marca, categoria: p.categoria, publico_alvo: p.publico_alvo,
      componentes: p.atributos.componentes ?? null,
      beneficios: ((brief?.beneficios ?? r.bullet_points ?? []) as unknown[]).slice(0, 3),
    }, false);
    const prompt = base +
      (!feito && brief?.angulo ? `\n\nANGULO DE VENDA: ${brief.angulo}` : "") +
      (regras ? `\n\nREGRAS OBRIGATORIAS:\n${regras}` : "") +
      (etapa.observacao ? `\n\nOBSERVACAO DO OPERADOR (prioridade nesta versao): ${etapa.observacao}` : "");

    let gerada: { bytes: Uint8Array; mime: string };
    if (escolhido.provider === "gemini") {
      gerada = await viaGemini(key, escolhido.id, [
        { inline_data: { mime_type: ref.media_type, data: ref.data } },
        { text: "Acima: a FOTO REAL do produto. Use o produto exatamente como nela: rotulo, logo, cores, tampa e proporcoes identicos." },
        ...ctx.partes,
        { text: prompt },
      ]);
    } else {
      const extra = ctx.textos.length ? `\n\nCONTEXTO:\n${ctx.textos.join("\n\n")}` : "";
      gerada = await viaOpenAI(key, escolhido.id, escolhido.quality ?? "medium", prompt + extra, { mime: ref.media_type, bytes: ref.bytes });
    }

    const caminho = `${r.sku}/${r.id}/${img.ordem}-${img.tipo}.${extDoMime(gerada.mime)}`;
    const up = await db.storage.from(BUCKET).upload(caminho, gerada.bytes, { contentType: gerada.mime, upsert: true });
    if (up.error) throw new Error(`storage: ${up.error.message}`);
    const hash = await sha256hex(gerada.bytes);
    await db.from("ia_rascunho_imagem").update({
      storage_path: caminho, prompt_usado: prompt, modelo: escolhido.id, status: "gerada", gerado_em: new Date().toISOString(),
      referencia_path: ref.origem, referencia_bytes: ref.bytes.length, referencia_sha256: refSha,
    }).eq("id", img.id);
    await db.from("ia_etapa").update({
      status: "gerado", conteudo_hash: hash, erro: null, pegado_em: null, atualizado_em: new Date().toISOString(),
    }).eq("id", etapa.id).eq("status", "gerando");
    const segundos = Math.round((Date.now() - t0) / 1000);
    console.log(JSON.stringify({ evento: "ia_imagem_gerada", etapa: etapa.id, sku: r.sku, tipo: img.tipo, modelo: escolhido.id, contextos: ctx.usados, segundos }));
    dispararWorker();
    return json({ ok: true, etapa_id: etapa.id, tipo: img.tipo, storage_path: caminho, segundos });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 400);
    const final = Number(etapa.tentativas ?? 1) >= MAX_TENTATIVAS || /Sem foto real de referência|não cadastrada|template inativo/.test(msg);
    // backoff: volta à fila, mas só pode ser pega depois de 2 min × tentativa (o gerador re-tentava na hora)
    const espera = 2 * 60_000 * Math.max(1, Number(etapa.tentativas ?? 1));
    await db.from("ia_etapa").update({
      status: final ? "erro" : "na_fila", erro: msg, pegado_em: null, atualizado_em: new Date().toISOString(),
      proxima_em: final ? null : new Date(Date.now() + espera).toISOString(),
    }).eq("id", etapa.id);
    console.log(JSON.stringify({ evento: "ia_imagem_falhou", etapa: etapa.id, final, erro: msg, segundos: Math.round((Date.now() - t0) / 1000) }));
    // segue a fila (o item que falhou está adiado; volta pelo vigia quando vencer a espera)
    dispararWorker();
    return json({ ok: false, etapa_id: etapa.id, final, erro: msg }, 200);
  }
});
