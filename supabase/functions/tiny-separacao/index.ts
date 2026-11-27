// ============================================================================
// Edge Function: tiny-separacao v41
// v41 (27/nov, pedido do dono): EMBALAR SEM ESPERAR O TINY. A tela marca embalado
//      no sistema pela RPC separacao_embalar_marcar (situacao 3 + linha em
//      separacao_embalar_fila) e o modulo embalar-fila manda ao Tiny depois
//      (cron a cada minuto + chamada da tela logo apos marcar). Antes cada
//      pedido custava ~0,8 s e a tela embalava um por vez (30 pedidos = 25 s).
//      O sync NAO reverte para a fila (situacao 1) quem esta pendente na fila
//      do Tiny; se a leitura da fila falhar, o sync pula a reversao inteira.
//      8 tentativas sem sucesso = desiste, volta o pedido para a fila do app e
//      avisa no Discord (canal erros).
// v40 (14/set): NAO CONFIA EM LEITURA QUE FALHOU. Nos minutos cheios o
//      PostgREST devolve 504 e (a) pegarAccessToken respondia "Token Tiny nao
//      encontrado" (o token existe; a LEITURA falhou) matando a rodada do cron
//      de tag+aprovacao; (b) a fase ao vivo do processar-abertos tratava a
//      leitura falha do espelho como "vazio" e tentava reinserir itens que ja
//      existiam (duplicate key em pedido_itens_tiny_uniq), queimando o
//      orcamento. Agora: token com 3 tentativas; leitura do espelho com erro
//      PULA a fase ao vivo (registra em erros); duplicate key no upsert de
//      itens = item ja espelhado (ok). Deploy via MCP religa verify_jwt: crons
//      27/30/31 levam Bearer (o front ja levava).
// v33: apos aprovar no Tiny, o processar-abertos atualiza o ESPELHO na hora
//      (pedidos_tiny.situacao='aprovada'). Sem isso o pedido continuava
//      'aberta' no espelho ate o proximo sync (~10 min) e o cron de 5 min
//      REPROCESSAVA o mesmo pedido: marcador duplicado no Tiny a cada rodada.
// v32: processar-abertos fecha o GAP Tiny->espelho NO PROPRIO CLIQUE. O espelho
//      (pedidos_tiny/pedido_itens_tiny) atrasa ate ~10 min atras do Tiny; o
//      operador via o pedido aberto no painel e o botao respondia "nada em
//      aberto" (caso real 25/ago: pedido de 8 min de idade). Agora o modulo:
//        1) lista os pedidos ABERTOS ao vivo (GET /pedidos?situacao=0, 2 dias);
//        2) espelha na hora quem falta ou esta sem itens (cabecalho + detalhe,
//           com a MESMA agregacao v49 do tiny-sync: soma linhas do mesmo SKU);
//        3) segue o fluxo normal (view_tags_pedidos -> tag -> aprovacao).
//      &live=0 pula a fase ao vivo (comportamento antigo). A fase ao vivo NUNCA
//      derruba o fluxo: qualquer erro vira item em `erros` e segue adiante.
// v31: canal Shopee da SVL foi RENOMEADO no Tiny para "Bumi Pet [Shopee]"
//      (mesmo shop 759046323; o sync reescreveu a janela inteira: 954 pedidos
//      em 7d com o rotulo novo, zero com o antigo). O processar-abertos filtra
//      marca_canal por grafia exata -> 45 pedidos abertos ficaram invisiveis
//      para o cron em 21/ago. Os DOIS rotulos entram nas listas (o Tiny pode
//      reverter). Ver CLAUDE.md "marca_canal (grafia exata)".
// v30: pegarAccessToken FIXA conta='ottz'. Havia regressao multi-conta: o
//      token usado era o de atualizado_em mais recente GLOBAL; quando o token
//      svl virava o mais novo (refresh off-cycle da conta SVL), TODOS os
//      writes (tag + aprovacao) batiam na conta ottz com o token svl ->
//      HTTP 401 ate o proximo refresh inverter. Fixar a conta torna imune.
//      Ver memoria tiny-token-multiconta-regressao ("Codigo novo DEVE fixar
//      conta='ottz'"). Todos os pedidos de separacao vivem na conta ottz,
//      inclusive o canal "Sevilla Store [SHOPEE]".
// v29: fix onConflict do upsert de controle (tags_aplicadas_pedidos) em
//      processar-abertos e aplicar-tags. A PK e composta (tiny_pedido_id,
//      tag_valor); o codigo usava so "tiny_pedido_id" -> "no unique or
//      exclusion constraint matching the ON CONFLICT" a cada rodada. Tag e
//      aprovacao ja funcionavam; agora o registro de controle grava.
//      (tag-lote ja usava a composta.)
// v24: o sync agora REVERTE para a fila (situacao 1) separacoes que constam
//      3/9 aqui mas estao na fila "aguardando separacao" do Tiny. Causa: no
//      Tiny um pedido pode ir para "em separacao" e VOLTAR para "aguardando";
//      a versao anterior so processava separacoes nunca detalhadas
//      (paraDetalhar = fila - jaDetalhados), entao quem regredia ficava preso
//      em 3/9 no app e sumia da tela. O Tiny e a fonte da verdade.
// v23: trava embalar (so com etiqueta impressa/confirmada) + forcar auditado.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pegarAccessToken(supabase: ReturnType<typeof createClient>): Promise<string> {
  // FIXA conta='ottz' (v30): a separacao opera na conta ottz. Sem este filtro
  // o token "mais recente" podia ser o da conta svl -> 401 em todos os writes.
  // v40: 3 tentativas — nos minutos cheios a leitura falha (504) e o token EXISTE.
  let ultimo: any = null;
  for (let t = 0; t < 3; t++) {
    const { data, error } = await supabase
      .from("oauth_tokens_tiny").select("access_token")
      .eq("conta", "ottz")
      .order("atualizado_em", { ascending: false }).limit(1).maybeSingle();
    if (!error && data?.access_token) return data.access_token;
    if (!error && !data) break; // realmente nao existe
    ultimo = error; await sleep(1200 * (t + 1));
  }
  throw new Error(`Token Tiny (conta ottz) nao encontrado${ultimo ? ` (leitura falhou: ${ultimo.message})` : ""}`);
}

async function tinyGet(
  accessToken: string, path: string,
  params: Record<string, string | number> = {}, maxRetries = 3,
): Promise<any> {
  const url = new URL(`${TINY_API_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let lastError = "";
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (resp.ok) return await resp.json();
    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 15000);
      lastError = `${resp.status} apos ${attempt} tentativas`;
      if (attempt < maxRetries) { await sleep(waitMs); continue; }
    }
    const text = await resp.text();
    throw new Error(`Tiny API ${resp.status} em ${path}: ${text.substring(0, 200)}`);
  }
  throw new Error(`Tiny API exauriu retries em ${path}: ${lastError}`);
}

async function tinyWritePut(
  accessToken: string, path: string, body: any, maxRetries = 2,
): Promise<{ ok: boolean; status: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(`${TINY_API_HOST}${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) return { ok: true, status: resp.status };
    if (resp.status === 429 || resp.status >= 500) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 10000);
      if (attempt < maxRetries) { await sleep(waitMs); continue; }
    }
    return { ok: false, status: resp.status };
  }
  return { ok: false, status: 0 };
}

async function aplicarMarcador(
  accessToken: string, tinyPedidoId: number | string, descricao: string, maxRetries = 2,
): Promise<{ ok: boolean; status: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(`${TINY_API_HOST}/pedidos/${tinyPedidoId}/marcadores`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify([{ descricao }]),
    });
    if (resp.ok) return { ok: true, status: resp.status };
    if (resp.status === 429 || resp.status >= 500) {
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 10000);
      if (attempt < maxRetries) { await sleep(waitMs); continue; }
    }
    return { ok: false, status: resp.status };
  }
  return { ok: false, status: 0 };
}

async function listarFila(accessToken: string, maxPaginas = 20): Promise<any[]> {
  const todas: any[] = [];
  let offset = 0;
  const LIMIT = 100;
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const resp = await tinyGet(accessToken, "/separacao", { situacao: 1, limit: LIMIT, offset });
    const itens = resp.itens || [];
    todas.push(...itens);
    if (itens.length < LIMIT) break;
    offset += LIMIT;
    await sleep(300);
  }
  return todas;
}

// Estado de impressao por separacao_id. done/forcado = liberado pra embalar.
// Prioridade: done > forcado > sent > error > ausente.
async function estadoImpressaoPorSep(
  supabase: ReturnType<typeof createClient>, sepIds: number[],
): Promise<Map<number, string>> {
  const mapa = new Map<number, string>();
  const rank = (e: string) => e === "done" ? 4 : e === "forcado" ? 3 : e === "sent" ? 2 : e === "error" ? 1 : 0;
  for (let i = 0; i < sepIds.length; i += 300) {
    const lote = sepIds.slice(i, i + 300);
    const { data } = await supabase
      .from("impressao_etiquetas")
      .select("separacao_id, estado")
      .in("separacao_id", lote);
    for (const r of (data || [])) {
      if (r.separacao_id == null) continue;
      const atual = mapa.get(r.separacao_id);
      if (!atual || rank(r.estado) > rank(atual)) mapa.set(r.separacao_id, r.estado);
    }
  }
  return mapa;
}

// v41: aviso no Discord (melhor-esforco)
async function avisarDiscord(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/discord-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch { /* melhor-esforco */ }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Secrets Supabase ausentes", { status: 500, headers: CORS });
  }

  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "sync";
  const debug = url.searchParams.get("debug");
  const maxDetalhes = parseInt(url.searchParams.get("max") || "150", 10);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let accessToken: string;
  try { accessToken = await pegarAccessToken(supabase); }
  catch (err) { return new Response((err as Error).message, { status: 401, headers: CORS }); }

  if (debug === "fila") {
    try {
      const fila = await listarFila(accessToken, 20);
      return json({
        total_na_fila: fila.length,
        amostra: fila.slice(0, 5).map((s: any) => ({
          id: s.id, venda: s.venda?.numero,
          ecommerce: s.ecommerce?.numeroPedidoEcommerce,
          canal: s.ecommerce?.nome, envio: s.formaEnvio?.nome,
        })),
      });
    } catch (err) {
      return new Response(`Erro: ${(err as Error).message}`, { status: 500, headers: CORS });
    }
  }

  if (modulo === "sync") {
    const inicio = Date.now();
    const TIMEOUT_MS = 50000;
    const erros: string[] = [];

    let fila: any[];
    try { fila = await listarFila(accessToken, 20); }
    catch (err) { return new Response(`Erro listando fila: ${(err as Error).message}`, { status: 500, headers: CORS }); }

    const idsNaFila = new Set(fila.map((s: any) => s.id));
    const idsArray = [...idsNaFila];

    // Quem estava na fila local (1) e sumiu da fila do Tiny -> concluida (9)
    // v40: se a leitura falhar, NAO marca ninguem como concluida (antes um 504
    // aqui viraria "ninguem na fila local" = nada a fazer, ok; mantido, mas
    // checando o erro para nao raciocinar sobre lista vazia por engano).
    const { data: cacheados, error: errCache } = await supabase
      .from("separacao_tiny").select("separacao_id").eq("situacao", 1);
    if (errCache) erros.push(`leitura fila local: ${errCache.message.substring(0, 60)} (pulei 'sairam da fila')`);
    const idsCacheados = new Set((errCache ? [] : (cacheados || [])).map((c: any) => c.separacao_id));
    const sairam = [...idsCacheados].filter((id) => !idsNaFila.has(id));
    if (sairam.length > 0) {
      await supabase.from("separacao_tiny")
        .update({ situacao: 9, atualizado_em: new Date().toISOString() })
        .in("separacao_id", sairam);
    }

    // v41: quem o APP ja marcou embalado e ainda espera a fila do Tiny NAO volta
    // para 1. Leitura da fila falhou -> pula a reversao inteira (nunca reverter
    // pedido ja embalado no galpao por causa de uma leitura que falhou).
    const pendEmbalar = new Set<number>();
    const { data: pf, error: errPf } = await supabase
      .from("separacao_embalar_fila").select("separacao_id")
      .is("concluido_em", null).is("desistiu_em", null);
    if (errPf) erros.push(`leitura fila de embalar: ${errPf.message.substring(0, 60)} (pulei a reversao)`);
    else for (const r of (pf || [])) pendEmbalar.add(Number(r.separacao_id));
    const idsReverter = errPf ? [] : idsArray.filter((id) => !pendEmbalar.has(Number(id)));

    // v24: quem ESTA na fila do Tiny mas aqui consta 3/9 (avancou e REGREDIU
    // no Tiny) volta para 1. O Tiny e a fonte da verdade; sem isso a separacao
    // fica presa fora da tela para sempre.
    let revertidas = 0;
    for (let i = 0; i < idsReverter.length; i += 300) {
      const lote = idsReverter.slice(i, i + 300);
      const { data: rev, error: errRev } = await supabase
        .from("separacao_tiny")
        .update({ situacao: 1, atualizado_em: new Date().toISOString() })
        .in("separacao_id", lote)
        .neq("situacao", 1)
        .select("separacao_id");
      if (errRev) erros.push(`revert: ${errRev.message.substring(0, 60)}`);
      else revertidas += (rev || []).length;
    }

    const jaDetalhados = new Set<number>();
    let errDet = false;
    for (let i = 0; i < idsArray.length; i += 200) {
      const lote = idsArray.slice(i, i + 200);
      const { data, error } = await supabase
        .from("separacao_tiny").select("separacao_id")
        .in("separacao_id", lote)
        .not("itens_json", "is", null);
      if (error) { errDet = true; erros.push(`leitura detalhados: ${error.message.substring(0, 60)}`); break; }
      for (const r of (data || [])) jaDetalhados.add(r.separacao_id);
    }
    // v40: leitura falhou -> nao redetalha tudo (o upsert reescreveria a fila
    // inteira e estouraria o tempo); tenta na proxima rodada.
    const paraDetalhar = errDet ? [] : fila.filter((s: any) => !jaDetalhados.has(s.id));

    let detalhados = 0;
    const linhas: any[] = [];
    for (const sep of paraDetalhar) {
      if (detalhados >= maxDetalhes) break;
      if (Date.now() - inicio > TIMEOUT_MS) break;

      let det: any;
      try {
        det = await tinyGet(accessToken, `/separacao/${sep.id}`);
      } catch (err) {
        const msg = (err as Error).message;
        erros.push(`sep ${sep.id}: ${msg}`);
        if (msg.includes("429")) break;
        continue;
      }

      const itens = det.itens || [];
      const skusDistintos = new Set(itens.map((it: any) => it.produto?.sku).filter(Boolean));
      const qtdUnidades = itens.reduce((s: number, it: any) => s + (parseFloat(it.quantidade) || 0), 0);
      const skuUnico = skusDistintos.size === 1 ? [...skusDistintos][0] as string : null;
      const nomeProduto = skuUnico ? (itens.find((it: any) => it.produto?.sku === skuUnico)?.produto?.descricao || null) : null;

      linhas.push({
        separacao_id: det.id,
        situacao: 1,
        venda_numero: det.venda?.numero ? String(det.venda.numero) : null,
        numero_ecommerce: det.ecommerce?.numeroPedidoEcommerce || null,
        marca_canal: det.ecommerce?.nome || null,
        forma_envio: det.formaEnvio?.nome || null,
        qtd_skus: skusDistintos.size,
        qtd_unidades: qtdUnidades,
        sku_unico: skuUnico,
        nome_produto: nomeProduto,
        itens_json: itens,
        data_criacao: det.dataCriacao ? det.dataCriacao.replace(" ", "T") + "Z" : null,
        detalhado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      });
      detalhados++;
      await sleep(250);
    }

    let upserted = 0;
    if (linhas.length > 0) {
      const { error } = await supabase
        .from("separacao_tiny").upsert(linhas, { onConflict: "separacao_id" });
      if (error) erros.push(`upsert: ${error.message}`);
      else upserted = linhas.length;
    }

    return json({
      modulo: "sync",
      total_na_fila: fila.length,
      revertidas_para_fila: revertidas,
      pendentes_embalar_no_tiny: pendEmbalar.size,
      ja_detalhados_antes: jaDetalhados.size,
      novos_detalhados: detalhados,
      upserted,
      sairam_da_fila: sairam.length,
      pendentes_detalhe: paraDetalhar.length - detalhados,
      tempo_ms: Date.now() - inicio,
      erros,
    });
  }

  if (modulo === "aplicar-tags") {
    const inicio = Date.now();
    const TIMEOUT_MS = 50000;
    const erros: string[] = [];

    const { data: candidatos, error: errSel } = await supabase
      .from("view_tags_pedidos")
      .select("tiny_pedido_id, numero_pedido, tag_sugerida")
      .not("tag_sugerida", "is", null)
      .limit(1000);

    if (errSel) return new Response(`Erro lendo view: ${errSel.message}`, { status: 500, headers: CORS });
    if (!candidatos || candidatos.length === 0) {
      return json({ modulo: "aplicar-tags", status: "nada aprovado com tag", aplicadas: 0 });
    }

    const ids = candidatos.map((c: any) => c.tiny_pedido_id);
    const jaAplicados = new Set<number>();
    for (let i = 0; i < ids.length; i += 200) {
      const lote = ids.slice(i, i + 200);
      const { data, error } = await supabase
        .from("tags_aplicadas_pedidos").select("tiny_pedido_id")
        .in("tiny_pedido_id", lote);
      if (error) return new Response(`Erro lendo controle de tags: ${error.message}`, { status: 500, headers: CORS });
      for (const r of (data || [])) jaAplicados.add(r.tiny_pedido_id);
    }

    const pendentes = candidatos.filter((c: any) => !jaAplicados.has(c.tiny_pedido_id));

    let aplicadas = 0;
    const registros: any[] = [];
    for (const c of pendentes) {
      if (Date.now() - inicio > TIMEOUT_MS) break;
      const r = await aplicarMarcador(accessToken, c.tiny_pedido_id, c.tag_sugerida);
      if (r.ok) {
        aplicadas++;
        registros.push({
          tiny_pedido_id: c.tiny_pedido_id,
          numero_pedido: c.numero_pedido,
          tag_valor: c.tag_sugerida,
          aplicada_em: new Date().toISOString(),
        });
      } else {
        erros.push(`pedido ${c.numero_pedido}: HTTP ${r.status}`);
        if (r.status === 429) break;
        if (r.status === 403) {
          return new Response(JSON.stringify({
            modulo: "aplicar-tags", erro: "403 - token sem permissao de escrita. Rode tiny-refresh-token.",
            aplicadas,
          }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }
      await sleep(500);
    }

    if (registros.length > 0) {
      const { error } = await supabase
        .from("tags_aplicadas_pedidos").upsert(registros, { onConflict: "tiny_pedido_id,tag_valor" });
      if (error) erros.push(`upsert controle: ${error.message}`);
    }

    return json({
      modulo: "aplicar-tags",
      candidatos: candidatos.length,
      ja_aplicados_antes: jaAplicados.size,
      aplicadas,
      pendentes_restantes: pendentes.length - aplicadas,
      tempo_ms: Date.now() - inicio,
      erros,
    });
  }

  if (modulo === "processar-abertos") {
    const inicio = Date.now();
    const TIMEOUT_MS = 50000;
    const erros: string[] = [];
    const canalParam = url.searchParams.get("canal") || "svl";

    // ------------------------------------------------------------------
    // v32: fase AO VIVO — fecha o gap Tiny -> espelho no proprio clique.
    // O espelho atrasa ate ~10 min; sem isto, pedido recem-importado pelo
    // Tiny ficava invisivel para o botao ("nada em aberto" enganoso).
    // v40: leitura do espelho com erro -> PULA a fase (nunca tratar como vazio:
    // era isso que reinseria itens ja existentes e queimava o orcamento).
    // ------------------------------------------------------------------
    let liveAbertosTiny = 0;
    let liveEspelhados = 0;
    if (url.searchParams.get("live") !== "0") {
      try {
        const d0 = new Date(Date.now() - 2 * 86400000).toISOString().split("T")[0];
        const dF = new Date().toISOString().split("T")[0];
        const abertosLive: any[] = [];
        let off = 0;
        for (let pg = 0; pg < 3; pg++) {
          const lst = await tinyGet(accessToken, "/pedidos", {
            situacao: 0, dataInicial: d0, dataFinal: dF, limit: 100, offset: off,
          });
          const its = (lst.itens || []).filter((p: any) => String(p.situacao) === "0");
          abertosLive.push(...its);
          if ((lst.itens || []).length < 100) break;
          off += 100;
          await sleep(250);
        }
        liveAbertosTiny = abertosLive.length;

        if (abertosLive.length > 0) {
          const idsLive = abertosLive.map((p: any) => p.id);
          const { data: exist, error: errExist } = await supabase
            .from("pedidos_tiny").select("id, tiny_pedido_id").in("tiny_pedido_id", idsLive);
          if (errExist) throw new Error(`leitura pedidos_tiny: ${errExist.message.substring(0, 80)}`);
          const uuidPorTiny = new Map((exist || []).map((e: any) => [e.tiny_pedido_id, e.id]));
          const uuids = [...uuidPorTiny.values()];
          const comItens = new Set<string>();
          if (uuids.length > 0) {
            const { data: it, error: errIt0 } = await supabase
              .from("pedido_itens_tiny").select("pedido_tiny_id").in("pedido_tiny_id", uuids);
            if (errIt0) throw new Error(`leitura pedido_itens_tiny: ${errIt0.message.substring(0, 80)}`);
            for (const r of (it || [])) comItens.add(r.pedido_tiny_id);
          }
          // Falta espelhar: nao existe OU existe sem itens (a view exige itens).
          const faltantes = abertosLive.filter((p: any) => {
            const u = uuidPorTiny.get(p.id);
            return !u || !comItens.has(u);
          }).slice(0, 15);

          for (const p of faltantes) {
            // Folga para a fase de tag+aprovacao que vem depois.
            if (Date.now() - inicio > 20000) break;
            const { data: up, error: errUp } = await supabase.from("pedidos_tiny").upsert({
              tiny_pedido_id: p.id,
              numero_pedido: String(p.numeroPedido || ""),
              numero_ecommerce: p.ecommerce?.numeroPedidoEcommerce || null,
              marca_canal: p.ecommerce?.nome || null,
              data_pedido: p.dataCriacao ? `${p.dataCriacao}T00:00:00Z` : null,
              valor_total: parseFloat(p.valor || 0) || null,
              situacao: "aberta",
            }, { onConflict: "tiny_pedido_id" }).select("id").single();
            if (errUp) { erros.push(`live upsert ${p.id}: ${errUp.message.substring(0, 60)}`); continue; }
            const uuid = up?.id ?? uuidPorTiny.get(p.id);
            if (!uuid) continue;

            let det: any;
            try { det = await tinyGet(accessToken, `/pedidos/${p.id}`); }
            catch (e) { erros.push(`live det ${p.id}: ${(e as Error).message.substring(0, 60)}`); continue; }

            const brutos = (det.itens || [])
              .filter((it: any) => it.produto?.sku)
              .map((it: any) => ({
                pedido_tiny_id: uuid,
                tiny_produto_id: it.produto?.id || null,
                sku: String(it.produto?.sku || ""),
                nome_produto: it.produto?.descricao || null,
                quantidade: parseFloat(it.quantidade) || 0,
                valor_unitario: parseFloat(it.valorUnitario) || 0,
                valor_total_item: (parseFloat(it.quantidade) || 0) * (parseFloat(it.valorUnitario) || 0),
              }));
            // Agregacao v49 do tiny-sync: um pedido pode ter o MESMO SKU em duas
            // linhas (2un + 5un = 7un); somamos por (pedido, sku, produto).
            const porChave = new Map<string, any>();
            for (const it of brutos) {
              const k = `${it.pedido_tiny_id}::${it.sku}::${it.tiny_produto_id || 0}`;
              const ex = porChave.get(k);
              if (ex) {
                ex.quantidade += it.quantidade;
                ex.valor_total_item += it.valor_total_item;
                ex.valor_unitario = ex.quantidade ? ex.valor_total_item / ex.quantidade : ex.valor_unitario;
              } else {
                porChave.set(k, { ...it });
              }
            }
            const unicos = Array.from(porChave.values());
            if (unicos.length > 0) {
              const { error: errIt } = await supabase
                .from("pedido_itens_tiny")
                .upsert(unicos, { onConflict: "pedido_tiny_id,sku,tiny_item_id", ignoreDuplicates: false });
              // v40: duplicate key = item ja espelhado por outro caminho (indice
              // pedido_itens_tiny_uniq com COALESCE) -> o pedido TEM itens, ok.
              if (errIt && !/duplicate key/i.test(errIt.message)) { erros.push(`live itens ${p.id}: ${errIt.message.substring(0, 60)}`); continue; }
            }
            await supabase.from("pedidos_tiny").update({
              valor_produtos: parseFloat(det.valorTotalProdutos) || 0,
              valor_frete: parseFloat(det.valorFrete) || 0,
              valor_desconto: parseFloat(det.valorDesconto) || 0,
              forma_envio: det.transportador?.formaEnvio?.nome || null,
            }).eq("id", uuid);
            liveEspelhados++;
            await sleep(300);
          }
        }
      } catch (e) {
        // A fase ao vivo NUNCA derruba o fluxo antigo.
        erros.push(`live: ${(e as Error).message.substring(0, 80)}`);
      }
    }

    let query = supabase
      .from("view_tags_pedidos")
      .select("tiny_pedido_id, numero_pedido, marca_canal, tag_sugerida")
      .eq("situacao", "aberta")
      .not("tag_sugerida", "is", null);

    // v31: "Bumi Pet [Shopee]" = SVL renomeada no Tiny (mesmo shop 759046323).
    // Mantemos as DUAS grafias: o Tiny pode reverter o nome a qualquer momento.
    const canaisSvl = ["Sevilla Store [SHOPEE]", "Bumi Pet [Shopee]"];
    const canaisShopee = [...canaisSvl, "Shopee (Ottz Pet)"];
    if (canalParam === "svl") {
      query = query.in("marca_canal", canaisSvl);
    } else if (canalParam === "ottz") {
      query = query.eq("marca_canal", "Shopee (Ottz Pet)");
    } else if (canalParam === "shopee") {
      query = query.in("marca_canal", canaisShopee);
    }

    const { data: pedidos, error: errSel } = await query.limit(200);

    if (errSel) return new Response(`Erro lendo view: ${errSel.message}`, { status: 500, headers: CORS });
    if (!pedidos || pedidos.length === 0) {
      return json({
        modulo: "processar-abertos", canal: canalParam, status: "nada em aberto", processados: 0,
        abertos_no_tiny_live: liveAbertosTiny, espelhados_na_hora: liveEspelhados, erros,
      });
    }

    let tagsAplicadas = 0, aprovados = 0, puladosSemMatch = 0;
    const registros: any[] = [];

    for (const p of pedidos) {
      if (Date.now() - inicio > TIMEOUT_MS) break;

      const ehShopee = (p.marca_canal || "").toUpperCase().includes("SHOPEE")
                    || (p.marca_canal || "").toLowerCase().includes("sevilla");
      if (ehShopee && (p.tag_sugerida || "").includes("Shopee Envios")) {
        puladosSemMatch++;
        continue;
      }

      const rTag = await aplicarMarcador(accessToken, p.tiny_pedido_id, p.tag_sugerida);
      if (!rTag.ok) {
        erros.push(`pedido ${p.numero_pedido}: tag falhou HTTP ${rTag.status}`);
        if (rTag.status === 429) break;
        if (rTag.status === 403) {
          return new Response(JSON.stringify({
            modulo: "processar-abertos", erro: "403 - token sem permissao. Rode tiny-refresh-token.",
            tags_aplicadas: tagsAplicadas, aprovados,
          }), { status: 403, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        continue;
      }
      tagsAplicadas++;
      await sleep(400);

      const rAprov = await tinyWritePut(accessToken, `/pedidos/${p.tiny_pedido_id}/situacao`, { situacao: 3 });
      if (!rAprov.ok) {
        erros.push(`pedido ${p.numero_pedido}: aprovacao falhou HTTP ${rAprov.status} (tag JA aplicada)`);
        if (rAprov.status === 429) break;
        continue;
      }
      aprovados++;
      // v33: o espelho acompanha NA HORA. Sem isto o pedido continuava 'aberta'
      // em pedidos_tiny ate o proximo sync (~10 min) e o cron de 5 min
      // reprocessava o MESMO pedido (marcador duplicado no Tiny a cada rodada).
      await supabase.from("pedidos_tiny")
        .update({ situacao: "aprovada" })
        .eq("tiny_pedido_id", p.tiny_pedido_id);
      registros.push({
        tiny_pedido_id: p.tiny_pedido_id,
        numero_pedido: p.numero_pedido,
        tag_valor: p.tag_sugerida,
        aplicada_em: new Date().toISOString(),
      });
      await sleep(500);
    }

    if (registros.length > 0) {
      const { error } = await supabase
        .from("tags_aplicadas_pedidos").upsert(registros, { onConflict: "tiny_pedido_id,tag_valor" });
      if (error) erros.push(`upsert controle: ${error.message}`);
    }

    return json({
      modulo: "processar-abertos",
      canal: canalParam,
      candidatos: pedidos.length,
      tags_aplicadas: tagsAplicadas,
      aprovados,
      pulados_sem_match_shopee: puladosSemMatch,
      abertos_no_tiny_live: liveAbertosTiny,
      espelhados_na_hora: liveEspelhados,
      tempo_ms: Date.now() - inicio,
      erros,
    });
  }

  if (modulo === "totalizadores") {
    const hoje = new Date().toISOString().split("T")[0];
    const erros: string[] = [];

    async function contar(situacao: number, comData: boolean): Promise<number | null> {
      try {
        const params: Record<string, any> = { situacao, limit: 1, offset: 0 };
        if (comData) { params.dataInicial = hoje; params.dataFinal = hoje; }
        const resp = await tinyGet(accessToken, "/separacao", params);
        return resp.paginacao?.total ?? 0;
      } catch (err) {
        erros.push(`situacao ${situacao}: ${(err as Error).message.substring(0, 80)}`);
        return null;
      }
    }

    const aguardando = await contar(1, false);
    await sleep(300);
    const emSeparacao = await contar(2, false);
    await sleep(300);
    const separadasHoje = await contar(3, true);
    await sleep(300);
    const embaladasHoje = await contar(4, true);

    const patch: Record<string, any> = { id: 1, atualizado_em: new Date().toISOString() };
    if (aguardando !== null) patch.aguardando_separacao = aguardando;
    if (emSeparacao !== null) patch.em_separacao = emSeparacao;
    if (separadasHoje !== null) patch.separadas_hoje = separadasHoje;
    if (embaladasHoje !== null) patch.embaladas_hoje = embaladasHoje;

    const { error: errUp } = await supabase
      .from("separacao_totais").update(patch).eq("id", 1);
    if (errUp) erros.push(`update totais: ${errUp.message}`);

    return json({
      modulo: "totalizadores",
      data: hoje,
      aguardando_separacao: aguardando,
      em_separacao: emSeparacao,
      separadas_hoje: separadasHoje,
      embaladas_hoje: embaladasHoje,
      erros,
    });
  }

  if (modulo === "tag-lote") {
    const grupo = url.searchParams.get("grupo");
    if (!grupo) {
      return json({ erro: "informe ?grupo=<tag_sugerida>" }, { status: 400 });
    }

    const hojeISO = new Date().toLocaleDateString("sv-SE", {
      timeZone: "America/Sao_Paulo",
    });
    const [, mm, dd] = hojeISO.split("-");
    const prefixo = `${dd}${mm}`;

    const { data: ultimo } = await supabase
      .from("tags_lote").select("sequencia")
      .eq("data", hojeISO).order("sequencia", { ascending: false }).limit(1);
    const sequencia = ((ultimo?.[0]?.sequencia as number) || 0) + 1;
    const tag = `${prefixo}-${String(sequencia).padStart(2, "0")}`;

    const { data: pedidosGrupo, error: errGrupo } = await supabase
      .from("view_separacao_pedidos")
      .select("separacao_id, tiny_pedido_id, venda_numero, sku_unico, tipo_envio")
      .eq("tag_sugerida", grupo);
    if (errGrupo) {
      return json({ erro: `view: ${errGrupo.message}` }, { status: 500 });
    }
    if (!pedidosGrupo || pedidosGrupo.length === 0) {
      return json({ erro: `nenhum pedido no bloco "${grupo}"` }, { status: 404 });
    }

    const ids = pedidosGrupo.map((p: any) => p.tiny_pedido_id).filter(Boolean);
    const { data: jaTagueados, error: errDedup } = await supabase
      .from("tags_aplicadas_pedidos")
      .select("tiny_pedido_id, tag_valor")
      .in("tiny_pedido_id", ids)
      .like("tag_valor", "____-__")
      .gte("aplicada_em", `${hojeISO}T00:00:00Z`);
    if (errDedup) {
      return json({
        erro: "falha ao checar pedidos ja tagueados — abortado por seguranca",
        detalhe: errDedup.message,
      }, { status: 500 });
    }
    const setJa = new Set((jaTagueados || []).map((r: any) => String(r.tiny_pedido_id)));

    const pendentes = pedidosGrupo.filter(
      (p: any) => p.tiny_pedido_id && !setJa.has(String(p.tiny_pedido_id))
    );
    const pulados = pedidosGrupo.length - pendentes.length;

    if (pendentes.length === 0) {
      return json({
        modulo: "tag-lote", grupo,
        erro: "todos os pedidos deste bloco ja receberam tag de lote hoje",
        pulados,
      }, { status: 409 });
    }

    const aplicados: any[] = [];
    const erros: string[] = [];
    for (const p of pendentes) {
      const r = await aplicarMarcador(accessToken, p.tiny_pedido_id, tag);
      if (r.ok) {
        aplicados.push({
          tiny_pedido_id: p.tiny_pedido_id,
          separacao_id: p.separacao_id,
          tag_valor: tag,
          aplicada_em: new Date().toISOString(),
        });
      } else {
        erros.push(`pedido ${p.tiny_pedido_id}: HTTP ${r.status}`);
        if (r.status === 403) break;
      }
      await sleep(120);
    }

    if (aplicados.length === 0) {
      return json({
        modulo: "tag-lote", grupo, tag,
        erro: "nenhum marcador aplicado", erros: erros.slice(0, 5),
      }, { status: 500 });
    }

    const { error: errReg } = await supabase.from("tags_aplicadas_pedidos").upsert(
      aplicados.map((a) => ({
        tiny_pedido_id: a.tiny_pedido_id,
        tag_valor: a.tag_valor,
        aplicada_em: a.aplicada_em,
      })),
      { onConflict: "tiny_pedido_id,tag_valor" }
    );
    if (errReg) {
      console.error("ERRO ao registrar tags_aplicadas_pedidos:", errReg.message);
    }

    await supabase.from("separacao_tiny")
      .update({ tag_lote: tag, tag_lote_em: new Date().toISOString() })
      .in("separacao_id", aplicados.map((a) => a.separacao_id));

    const primeiro: any = pendentes[0];
    await supabase.from("tags_lote").insert({
      data: hojeISO,
      sequencia,
      tag,
      grupo_origem: grupo,
      sku: primeiro.sku_unico,
      tipo_envio: primeiro.tipo_envio,
      qtd_pedidos: aplicados.length,
      qtd_pulados: pulados,
      status: "aplicada",
    });

    return json({
      modulo: "tag-lote",
      tag, grupo,
      pedidos_tagueados: aplicados.length,
      pedidos_pulados: pulados,
      aviso: pulados > 0
        ? `${pulados} pedido(s) ja tinham tag de lote hoje e foram pulados — nao serao impressos duas vezes`
        : null,
      proximo_passo: `No Tiny, filtre pelo marcador "${tag}" e imprima as etiquetas em massa`,
      erros: erros.slice(0, 5),
    });
  }

  // ==========================================================================
  // EMBALAR-LOTE (v23): so embala pedido com etiqueta IMPRESSA e confirmada.
  // Uso: ?modulo=embalar-lote&tag=1207-01&confirmar=1
  //      + &forcar=1&forcado_por=NOME  (escape auditado)
  // ==========================================================================
  if (modulo === "embalar-lote") {
    const tag = url.searchParams.get("tag");
    const confirmar = url.searchParams.get("confirmar") === "1";
    const forcar = url.searchParams.get("forcar") === "1";
    const forcadoPor = url.searchParams.get("forcado_por") || null;
    const forcadoMotivo = url.searchParams.get("forcado_motivo") || "forcado manualmente no lote";
    if (!tag) return json({ erro: "informe ?tag=1207-01" }, { status: 400 });

    const { data: seps } = await supabase
      .from("separacao_tiny")
      .select("separacao_id, venda_numero, numero_ecommerce")
      .eq("tag_lote", tag).eq("situacao", 1);

    if (!seps || seps.length === 0) {
      return json({ erro: `nenhuma separacao na fila com a tag "${tag}"` }, { status: 404 });
    }

    const sepIds = seps.map((s: any) => s.separacao_id);
    const estadoPorSep = await estadoImpressaoPorSep(supabase, sepIds);

    const liberadas: any[] = [];
    const bloqueadas: any[] = [];
    for (const s of seps) {
      const est = estadoPorSep.get(s.separacao_id) || "ausente";
      if (est === "done" || est === "forcado") liberadas.push(s);
      else bloqueadas.push({ separacao_id: s.separacao_id, venda: s.venda_numero, estado_impressao: est });
    }

    const paraEmbalar = forcar ? seps : liberadas;

    if (paraEmbalar.length === 0) {
      return json({
        modulo: "embalar-lote", tag,
        erro: "nenhum pedido deste lote teve etiqueta impressa e confirmada",
        bloqueados_sem_impressao: bloqueadas,
        dica: "imprima as etiquetas e aguarde a confirmacao, ou use &forcar=1&forcado_por=SEU_NOME (auditado)",
      }, { status: 409 });
    }

    if (!confirmar) {
      return json({
        modulo: "embalar-lote", tag,
        separacoes_liberadas: liberadas.length,
        separacoes_bloqueadas: bloqueadas.length,
        bloqueados_sem_impressao: bloqueadas,
        vai_embalar: paraEmbalar.length,
        forcar,
        aviso: forcar
          ? "FORCAR ativo: vai embalar TODAS, inclusive sem impressao confirmada (auditado). Confirme."
          : "Confirme para prosseguir. So as com impressao confirmada serao embaladas. Muda no Tiny para EMBALADA (3), sem desfazer.",
        para_confirmar: `?modulo=embalar-lote&tag=${tag}&confirmar=1${forcar ? `&forcar=1&forcado_por=${forcadoPor || "OPERADOR"}` : ""}`,
      });
    }

    if (forcar && bloqueadas.length > 0) {
      const linhasForcadas = bloqueadas.map((b: any) => ({
        order_sn: (seps.find((s: any) => s.separacao_id === b.separacao_id)?.numero_ecommerce) || String(b.separacao_id),
        separacao_id: b.separacao_id,
        tag_lote: tag,
        estado: "forcado",
        enviado_em: new Date().toISOString(),
        confirmado_em: new Date().toISOString(),
        forcado_por: forcadoPor || "OPERADOR",
        forcado_motivo: forcadoMotivo,
        atualizado_em: new Date().toISOString(),
      }));
      await supabase.from("impressao_etiquetas").insert(linhasForcadas);
    }

    let ok = 0;
    const erros: string[] = [];
    const embaladosIds: number[] = [];
    for (const s of paraEmbalar) {
      const r = await tinyWritePut(accessToken, `/separacao/${s.separacao_id}/situacao`, { situacao: 3 });
      if (r.ok) { ok++; embaladosIds.push(s.separacao_id); }
      else {
        erros.push(`sep ${s.separacao_id}: HTTP ${r.status}`);
        if (r.status === 403) break;
      }
      await sleep(150);
    }

    if (embaladosIds.length > 0) {
      await supabase.from("separacao_tiny")
        .update({ situacao: 3, atualizado_em: new Date().toISOString() })
        .in("separacao_id", embaladosIds);
      await supabase.from("tags_lote")
        .update({ status: "embalada", embalado_em: new Date().toISOString() })
        .eq("tag", tag);
    }

    return json({
      modulo: "embalar-lote", tag,
      embaladas: ok,
      total_no_lote: seps.length,
      bloqueados_sem_impressao: forcar ? [] : bloqueadas,
      forcado: forcar,
      erros: erros.slice(0, 5),
    });
  }

  // ==========================================================================
  // EMBALAR-UM (v23): mesma trava de impressao confirmada + forcar auditado.
  // Uso: ?modulo=embalar-um&separacao_id=...&confirmar=1
  //      + &forcar=1&forcado_por=NOME
  // ==========================================================================
  if (modulo === "embalar-um") {
    const sepId = url.searchParams.get("separacao_id");
    const confirmar = url.searchParams.get("confirmar") === "1";
    const forcar = url.searchParams.get("forcar") === "1";
    const forcadoPor = url.searchParams.get("forcado_por") || null;
    const forcadoMotivo = url.searchParams.get("forcado_motivo") || "forcado manualmente";
    if (!sepId) return json({ erro: "informe ?separacao_id=..." }, { status: 400 });
    const sepIdNum = parseInt(sepId, 10);

    const { data: sep } = await supabase
      .from("separacao_tiny")
      .select("separacao_id, venda_numero, situacao, sku_unico, nome_produto, tag_lote, numero_ecommerce")
      .eq("separacao_id", sepIdNum).single();

    if (!sep) return json({ erro: `separacao ${sepId} nao encontrada` }, { status: 404 });

    const estadoMapa = await estadoImpressaoPorSep(supabase, [sepIdNum]);
    const estado = estadoMapa.get(sepIdNum) || "ausente";
    const liberado = estado === "done" || estado === "forcado";

    if (!liberado && !forcar) {
      return json({
        modulo: "embalar-um", separacao_id: sepId,
        erro: "etiqueta ainda nao foi impressa/confirmada para este pedido",
        estado_impressao: estado,
        dica: "imprima e aguarde a confirmacao, ou use &forcar=1&forcado_por=SEU_NOME (auditado)",
      }, { status: 409 });
    }

    if (!confirmar) {
      return json({
        modulo: "embalar-um",
        separacao: sep,
        estado_impressao: estado,
        forcar,
        aviso: forcar && !liberado
          ? "FORCAR ativo: vai embalar SEM impressao confirmada (auditado). Muda no Tiny para EMBALADA (3), sem desfazer."
          : "Muda no Tiny para EMBALADA (3). Nao tem desfazer.",
        para_confirmar: `?modulo=embalar-um&separacao_id=${sepId}&confirmar=1${forcar ? `&forcar=1&forcado_por=${forcadoPor || "OPERADOR"}` : ""}`,
      });
    }

    if (forcar && !liberado) {
      await supabase.from("impressao_etiquetas").insert({
        order_sn: sep.numero_ecommerce || String(sepIdNum),
        separacao_id: sepIdNum,
        tag_lote: sep.tag_lote || null,
        estado: "forcado",
        enviado_em: new Date().toISOString(),
        confirmado_em: new Date().toISOString(),
        forcado_por: forcadoPor || "OPERADOR",
        forcado_motivo: forcadoMotivo,
        atualizado_em: new Date().toISOString(),
      });
    }

    const r = await tinyWritePut(accessToken, `/separacao/${sepIdNum}/situacao`, { situacao: 3 });

    if (!r.ok) {
      return json({
        modulo: "embalar-um", separacao_id: sepId,
        ok: false, status: r.status,
        dica: r.status === 403 ? "token sem permissao de escrita em separacao" : undefined,
      }, { status: 500 });
    }

    await supabase.from("separacao_tiny")
      .update({ situacao: 3, atualizado_em: new Date().toISOString() })
      .eq("separacao_id", sepIdNum);

    return json({
      modulo: "embalar-um",
      separacao_id: sepId,
      venda: sep.venda_numero,
      ok: true,
      forcado: forcar && !liberado,
      estado_impressao: estado,
    });
  }

  // ==========================================================================
  // EMBALAR-FILA (v41): manda ao Tiny o que o app ja marcou embalado pela RPC
  // separacao_embalar_marcar. Cron a cada minuto + a tela chama logo apos marcar.
  // Uso: ?modulo=embalar-fila[&max=80]
  // ==========================================================================
  if (modulo === "embalar-fila") {
    const inicio = Date.now();
    const limite = Math.min(parseInt(url.searchParams.get("max") || "80", 10), 300);
    const { data: pend, error: errP } = await supabase
      .from("separacao_embalar_fila").select("separacao_id, tentativas")
      .is("concluido_em", null).is("desistiu_em", null)
      .lte("proxima_em", new Date().toISOString())
      .order("criado_em", { ascending: true }).limit(limite);
    if (errP) return json({ modulo, erro: `leitura da fila: ${errP.message}` }, { status: 500 });

    let ok = 0, falhas = 0, desistiu = 0;
    const erros: string[] = [];
    for (const p of (pend || [])) {
      if (Date.now() - inicio > 40000) break;
      const sepId = Number(p.separacao_id);
      const r = await tinyWritePut(accessToken, `/separacao/${sepId}/situacao`, { situacao: 3 });
      let feito = r.ok;
      // Recusa 4xx: confere se o Tiny ja nao esta embalado (alguem fez por la)
      if (!feito && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429) {
        try {
          const det = await tinyGet(accessToken, `/separacao/${sepId}`, {}, 1);
          const sit = Number(det?.situacao);
          if (sit && sit !== 1 && sit !== 2) feito = true;
        } catch { /* segue como falha */ }
      }
      if (feito) {
        ok++;
        await supabase.from("separacao_embalar_fila")
          .update({ concluido_em: new Date().toISOString(), ultimo_erro: null, tentativas: (p.tentativas || 0) + 1 })
          .eq("separacao_id", sepId);
      } else {
        falhas++;
        const t = (p.tentativas || 0) + 1;
        const erro = `HTTP ${r.status}`;
        erros.push(`sep ${sepId}: ${erro}`);
        if (t >= 8) {
          desistiu++;
          await supabase.from("separacao_embalar_fila")
            .update({ tentativas: t, ultimo_erro: erro, desistiu_em: new Date().toISOString() })
            .eq("separacao_id", sepId);
          // volta para a fila do app: o operador ve que nao foi embalado no Tiny
          await supabase.from("separacao_tiny")
            .update({ situacao: 1, atualizado_em: new Date().toISOString() })
            .eq("separacao_id", sepId).eq("situacao", 3);
          await avisarDiscord({
            canal: "erros", nivel: "erro",
            titulo: "Embalar no Tiny falhou 8 vezes",
            descricao: `Separacao ${sepId} voltou para a fila da Separacao (ultimo erro: ${erro}). Marque como embalado de novo.`,
            rodape: "tiny-separacao · embalar-fila",
          });
        } else {
          const espera = Math.min(Math.pow(2, t), 30); // minutos
          await supabase.from("separacao_embalar_fila")
            .update({ tentativas: t, ultimo_erro: erro, proxima_em: new Date(Date.now() + espera * 60000).toISOString() })
            .eq("separacao_id", sepId);
        }
        if (r.status === 429 || r.status === 401 || r.status === 403) break;
      }
      await sleep(150);
    }

    return json({
      modulo: "embalar-fila", pendentes_lidos: (pend || []).length,
      embalados_no_tiny: ok, falhas, desistiu, tempo_ms: Date.now() - inicio, erros: erros.slice(0, 5),
    });
  }

  return new Response(`Modulo "${modulo}" nao implementado`, { status: 400, headers: CORS });
});
