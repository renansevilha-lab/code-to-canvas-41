// ============================================================================
// Edge Function: tiny-sync-produtos v29
// ----------------------------------------------------------------------------
// v29 (12/out/2026): detalhar trata o 404 do Tiny. Produto apagado de vez no Tiny
//      não vem em nenhuma lista (nem na de excluídos) e o GET pelo ID responde 404
//      "Produto não encontrado". Antes ele seguia "ativo" no espelho para sempre e,
//      por nunca ter o detalhe atualizado, ficava SEMPRE na frente da fila: 26
//      fantasmas gastavam as vagas de toda rodada do refresh (e 12 deles, tipo V,
//      as do `pais=1`). Agora o 404 marca ativo=false + situacao='E' e carimba o
//      detalhe (sai da fila). Só o 404; outros erros seguem como antes. Se o Tiny
//      voltar a listar o SKU como ativo, a listagem do dia o reativa sozinha.
// v28 (07/out/2026): CATÁLOGO ESPELHO DO TINY.
//      - modulo=produtos RETOMÁVEL: para em ~25 s e grava fase/offset em
//        tiny_sync_estado; a rodada seguinte continua (antes recomeçava do zero
//        e parava em ~1.000 de ~2.300 — o resto nunca era atualizado).
//        Fases: ativos (situacao=A, upsert como antes + situacao/gtin/unidade/
//        tipo_variacao/tiny_alterado_em/tiny_visto_em) -> inativos (I) ->
//        excluidos (E). Em I/E só MARCA ativo=false + situacao nos SKUs que o
//        Tiny DEVOLVEU nessas listas; nada vira inativo por "não ter aparecido".
//        Passada completa no dia = rodadas seguintes saem sem chamar o Tiny;
//        &forcar=1 (botão da tela) começa outra passada se a última terminou,
//        ou CONTINUA a que está em andamento (nunca volta ao zero no meio).
//        O custo continua EXATAMENTE como antes.
//      - modulo=detalhar grava também estoque (estoque.quantidade) +
//        estoque_atualizado_em, sku_pai/id_tiny_pai (produtoPai), situacao
//        (+ ativo), gtin, unidade. Ao detalhar um produto COM VARIAÇÕES grava
//        o pai em cada filho (variacoes[].sku -> sku_pai); `&pais=1` detalha só
//        os produtos tipo V (liga pais e filhos em poucas rodadas).
// v27 (25/set/2026): FIX da fila do modulo estoque. A data da ultima
//      atualizacao era lida com select direto em estoque_tiny, que tem ~5
//      linhas por SKU (uma por deposito) e o PostgREST corta em 1.000 linhas.
//      SKUs ja sincronizados pareciam "nunca sincronizados" e a fila repetia
//      sempre os mesmos SKUs (afetava o motor Full e o agente de compras).
//      Agora le view_estoque_tiny_ultima (1 linha por SKU), paginada.
// v26 (25/set/2026): `estoque&alvo=compras` le os SKUs de view_compras_skus_alvo
//      (SKUs com venda em 30d + SKUs dos fornecedores do agente de compras).
//      Sem `alvo` o comportamento e o mesmo de antes (view_reposicao_skus_alvo,
//      motor Full). Cron noturno `tiny-estoque-compras` usa o alvo novo.
// v25 (16/set/2026): `detalhar&refresh=1` RE-detalha produtos ATIVOS ja
//      detalhados, do mais antigo para o mais novo (detalhe_atualizado_em asc).
//      Motivo: foto/marca/kit so eram lidos UMA vez (detalhe_atualizado_em IS
//      NULL) - foto trocada no Tiny nunca chegava ao app. Cron horario
//      `tiny-detalhar-refresh` (40/rodada; ~1 req/s do Tiny). A foto e SEMPRE
//      o anexo do PROPRIO registro (variacao = registro filho com foto propria;
//      o pai nao empresta foto ao filho).
// v14: CORS COMPLETO. A funcao nao respondia o preflight (OPTIONS) com nenhum
//      cabecalho CORS -> o navegador BLOQUEAVA a chamada real e o botao
//      "Puxar custo do Tiny" (Pedidos Integrados) nao fazia NADA, sem erro na
//      tela. Mesmo defeito da ml-etiqueta (CLAUDE.md secao 6.2). Via curl
//      sempre funcionou (curl nao faz preflight) - por isso enganou.
// v13: pegarTokenTiny FIXA conta='ottz'. Antes lia 'o mais recente' e, com a
//      conta SVL no banco, chegou a rodar com o token da SVL -> gravou custo=0
//      (precoCusto vazio da SVL) por SKU, corrompendo o CMV. Restaurado via
//      re-sync. NUNCA leia o token por 'atualizado_em desc' aqui.
// v12: params por query OU body JSON; modulo `detalhar?sku=X` re-detalha 1 SKU.
//
// Modulos:
//   ?modulo=produtos&limite=N[&forcar=1] - sync paginado RETOMÁVEL (campos basicos, inclui custo; v28)
//   ?modulo=detalhar&limite=N        - enriquecimento (foto/marca/kit; NAO custo)
//   ?modulo=detalhar&sku=X           - re-detalha SO o SKU X
//   ?modulo=detalhar&refresh=1&limite=N - re-detalha ativos mais antigos (v25)
//   ?modulo=detalhar&pais=1&limite=N - detalha so os produtos com variacoes (liga sku_pai; v28)
//   ?modulo=estoque&limite=N         - saldo por deposito -> estoque_tiny (motor Full)
//   ?modulo=estoque&alvo=compras&limite=N - idem, SKUs do agente de compras (v26)
//   ?modulo=test-estoque&sku=X       - payload cru de /estoque/{id}
//   ?modulo=test-pagina | test-produto - debugs v1
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_BASE = "https://api.tiny.com.br/public-api/v3";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Bloco padrao do projeto. O Allow-Headers e OBRIGATORIO: sem ele o navegador
// nao tem permissao de enviar o `authorization` e a requisicao real nem sai.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Views que definem quais SKUs o modulo estoque sincroniza.
const VIEWS_ALVO: Record<string, string> = {
  full: "view_reposicao_skus_alvo",
  compras: "view_compras_skus_alvo",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (v: any): number => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

function jsonResp(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function textResp(msg: string, status: number) {
  return new Response(msg, { status, headers: CORS });
}

async function pegarTokenTiny(supabase: ReturnType<typeof createClient>): Promise<string> {
  // Multi-conta: SEMPRE a conta principal (ottz). Sem o filtro, pegaria o token
  // da SVL quando ela fosse a linha mais recente -> gravaria custo=0 por SKU.
  const { data, error } = await supabase
    .from("oauth_tokens_tiny")
    .select("access_token, expires_at")
    .eq("conta", "ottz")
    .limit(1)
    .single();
  if (error || !data) throw new Error("Token Tiny (conta ottz) nao encontrado");
  const exp = new Date(data.expires_at);
  if (exp < new Date()) {
    throw new Error(`Token Tiny expirado em ${exp.toISOString()}. Roda tiny-refresh-token.`);
  }
  return data.access_token;
}

async function tinyGet(path: string, token: string, params: Record<string, any> = {}) {
  const url = new URL(`${TINY_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
  });
  const txt = await resp.text();
  let payload: any;
  try { payload = JSON.parse(txt); } catch { payload = { _raw: txt }; }
  if (!resp.ok) {
    const err: any = new Error(`Tiny API ${resp.status} em ${path}: ${JSON.stringify(payload).slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return payload;
}

async function tinyGetWithRetry(path: string, token: string, maxRetries = 4): Promise<any> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await tinyGet(path, token);
    } catch (err: any) {
      const is429 = err.status === 429 || /\b429\b/.test(err.message || "");
      if (is429 && i < maxRetries) {
        const backoff = 2000 * Math.pow(2, i);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw new Error("tinyGetWithRetry esgotou tentativas");
}

/** "2026-09-29 10:00:00" (horário de Brasília, como o Tiny devolve) -> ISO com fuso. */
function dataTiny(s: any): string | null {
  const t = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) return null;
  return `${t.replace(" ", "T")}${t.length === 16 ? ":00" : ""}-03:00`;
}

function mapearItemBasico(item: any): Record<string, any> | null {
  if (!item?.sku) return null;
  const precos = item.precos || {};
  const agora = new Date().toISOString();
  return {
    sku: String(item.sku).trim(),
    id_tiny: item.id || null,
    nome: item.descricao || null,
    tipo: item.tipo || null,
    custo: parseFloat(precos.precoCusto) || 0,
    preco: parseFloat(precos.preco) || null,
    ativo: item.situacao === "A",
    // v28: campos que a listagem já devolvia e eram descartados
    situacao: item.situacao || null,
    gtin: (item.gtin && String(item.gtin).trim()) || null,
    unidade: (item.unidade && String(item.unidade).trim()) || null,
    tipo_variacao: item.tipoVariacao || null,
    tiny_alterado_em: dataTiny(item.dataAlteracao),
    tiny_visto_em: agora,
    atualizado_em: agora,
  };
}

// v28: fases da passada. Só "ativos" grava produto; I/E só marcam inativo.
const FASES_LISTAGEM = ["ativos", "inativos", "excluidos"] as const;
const SITUACAO_DA_FASE: Record<string, string> = { ativos: "A", inativos: "I", excluidos: "E" };
const CAMPO_TOTAL: Record<string, string> = { ativos: "total_tiny_ativos", inativos: "total_tiny_inativos", excluidos: "total_tiny_excluidos" };
const diaSP = (d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

async function syncProdutos(supabase: ReturnType<typeof createClient>, token: string, limite: number, forcar = false) {
  const ORCAMENTO_MS = 25000; // limite da edge function ~30 s (CLAUDE.md §6): para com folga e grava
  const PAGE_SIZE = 100;
  const inicio = Date.now();
  const erros: string[] = [];

  const { data: lido } = await supabase.from("tiny_sync_estado").select("*").eq("chave", "produtos").maybeSingle();
  const est: any = lido ?? { chave: "produtos", fase: "ativos", proximo_offset: 0, detalhe: {} };
  const hoje = diaSP(new Date());
  const passadaDeHojeCompleta = est.ultima_completa_em && diaSP(est.ultima_completa_em) === hoje
    && est.fase === "ativos" && Number(est.proximo_offset) === 0;
  if (passadaDeHojeCompleta && !forcar) {
    return { modulo: "produtos", nota: "passada de hoje já completa (forcar=1 começa outra)", ultima_completa_em: est.ultima_completa_em };
  }
  if (est.fase === "ativos" && Number(est.proximo_offset) === 0) {
    est.passada_iniciada_em = new Date().toISOString();
    est.detalhe = { inativados: 0, upserts: 0 };
  }
  est.detalhe = est.detalhe || {};

  const salvar = async () => {
    est.atualizado_em = new Date().toISOString();
    const { error } = await supabase.from("tiny_sync_estado").upsert(est, { onConflict: "chave" });
    if (error) erros.push(`estado: ${error.message.substring(0, 80)}`);
  };

  let processados = 0, upserts = 0, inativados = 0, completou = false;
  while (Date.now() - inicio < ORCAMENTO_MS && processados < limite) {
    const fase = est.fase as string;
    const offset = Number(est.proximo_offset) || 0;
    let resp: any;
    try {
      resp = await tinyGet("/produtos", token, { situacao: SITUACAO_DA_FASE[fase], limit: PAGE_SIZE, offset });
    } catch (err) { erros.push(`${fase} offset ${offset}: ${(err as Error).message}`); break; } // estado fica: a próxima rodada repete a página
    const itens = resp.itens || [];
    if (resp.paginacao?.total != null) est[CAMPO_TOTAL[fase]] = resp.paginacao.total;

    if (fase === "ativos") {
      const linhas = itens.map(mapearItemBasico).filter((l: any) => l !== null);
      if (linhas.length > 0) {
        const { error: errUp } = await supabase.from("produtos").upsert(linhas, { onConflict: "sku" });
        if (errUp) { erros.push(`upsert offset ${offset}: ${errUp.message}`); break; }
        upserts += linhas.length;
      }
    } else if (itens.length > 0) {
      // Só os SKUs que o Tiny devolveu como I/E; nunca cria produto; legado sem id_tiny fica de fora.
      const sit = SITUACAO_DA_FASE[fase];
      const skus = itens.map((i: any) => (i?.sku ? String(i.sku).trim() : null)).filter(Boolean);
      const { data: mudam } = await supabase.from("produtos").select("sku")
        .in("sku", skus).not("id_tiny", "is", null).or(`ativo.eq.true,situacao.is.null,situacao.neq.${sit}`);
      const alvo = (mudam || []).map((r: any) => r.sku);
      if (alvo.length > 0) {
        const { data: eraAtivo } = await supabase.from("produtos").select("sku").in("sku", alvo).eq("ativo", true);
        const { error: errIn } = await supabase.from("produtos")
          .update({ ativo: false, situacao: sit, tiny_visto_em: new Date().toISOString() }).in("sku", alvo);
        if (errIn) { erros.push(`${fase} offset ${offset}: ${errIn.message}`); break; }
        inativados += (eraAtivo || []).length;
      }
    }

    processados += itens.length;
    if (itens.length < PAGE_SIZE) {
      const i = FASES_LISTAGEM.indexOf(fase as any);
      if (i < FASES_LISTAGEM.length - 1) {
        est.fase = FASES_LISTAGEM[i + 1];
        est.proximo_offset = 0;
      } else {
        est.fase = "ativos";
        est.proximo_offset = 0;
        est.ultima_completa_em = new Date().toISOString();
        completou = true;
      }
    } else {
      est.proximo_offset = offset + PAGE_SIZE;
    }
    est.detalhe.inativados = Number(est.detalhe.inativados || 0) + 0; // acumulado abaixo
    await salvar();
    if (completou) break;
  }
  est.detalhe.inativados = Number(est.detalhe.inativados || 0) + inativados;
  est.detalhe.upserts = Number(est.detalhe.upserts || 0) + upserts;
  if (completou) est.inativados_ultima = est.detalhe.inativados;
  await salvar();

  return {
    modulo: "produtos", limite, forcar, fase_atual: est.fase, proximo_offset: est.proximo_offset, completou,
    total_tiny_ativos: est.total_tiny_ativos ?? null, total_tiny_inativos: est.total_tiny_inativos ?? null,
    total_tiny_excluidos: est.total_tiny_excluidos ?? null,
    processados, upserted: upserts, inativados, erros: erros.slice(0, 5), tempo_ms: Date.now() - inicio,
  };
}

// v12: skuAlvo opcional — quando presente, re-detalha SO esse SKU, ignorando o
// filtro de detalhe_atualizado_em (usado pelo botao "Puxar custo do Tiny").
// v25: refresh=true re-detalha ATIVOS ja detalhados, do mais antigo ao mais novo.
async function detalharProdutos(
  supabase: ReturnType<typeof createClient>,
  token: string,
  limite: number,
  skuAlvo?: string | null,
  refresh = false,
  pais = false,
) {
  const TIMEOUT_MS = 50000;
  const SLEEP_MS = 1100;
  const inicio = Date.now();

  let query = supabase
    .from("produtos")
    .select("sku, id_tiny, tipo, nome, foto_capa")
    .not("id_tiny", "is", null);
  if (skuAlvo) {
    query = query.eq("sku", skuAlvo).limit(1);
  } else if (pais) {
    // v28: só os produtos COM VARIAÇÕES (tipo V), do detalhe mais antigo ao mais novo —
    // é o que liga cada variação ao pai (sku_pai) sem esperar o ciclo de todos os ativos.
    query = query
      .eq("ativo", true).eq("tipo", "V")
      .order("detalhe_atualizado_em", { ascending: true, nullsFirst: true }).limit(limite);
  } else if (refresh) {
    query = query
      .eq("ativo", true).not("arquivado", "is", true)
      .not("detalhe_atualizado_em", "is", null)
      .order("detalhe_atualizado_em", { ascending: true }).limit(limite);
  } else {
    query = query.is("detalhe_atualizado_em", null).order("sku").limit(limite);
  }
  const { data: produtos, error: errSel } = await query;
  if (errSel) throw new Error(`Erro buscando produtos: ${errSel.message}`);
  if (!produtos || produtos.length === 0) {
    return { modulo: "detalhar", sku: skuAlvo ?? null, refresh, pendentes: 0, processados: 0, kits_atualizados: 0, componentes_inseridos: 0, erros: skuAlvo ? [`sku ${skuAlvo} sem id_tiny / nao encontrado`] : [] };
  }
  let totalProcessados = 0, totalKits = 0, totalComponentes = 0, fotosAlteradas = 0, totalVariacoes = 0, inexistentes = 0;
  const erros: string[] = [];
  for (let i = 0; i < produtos.length; i++) {
    if (Date.now() - inicio > TIMEOUT_MS) { erros.push(`Timeout apos ${i} processados`); break; }
    if (i > 0) await sleep(SLEEP_MS);
    const p: any = produtos[i];
    let det: any;
    try { det = await tinyGetWithRetry(`/produtos/${p.id_tiny}`, token); }
    catch (err) {
      // v29: 404 pelo ID = o produto não existe mais no Tiny. Sai do catálogo e da fila.
      if ((err as any)?.status === 404) {
        const { error: errX } = await supabase.from("produtos")
          .update({ ativo: false, situacao: "E", detalhe_atualizado_em: new Date().toISOString() }).eq("sku", p.sku);
        if (errX) erros.push(`${p.sku} inexistente: ${errX.message}`); else inexistentes++;
        continue;
      }
      erros.push(`${p.sku}: ${(err as Error).message}`); continue;
    }
    // Anexo do PROPRIO registro. Variacao (filho) tem registro e foto proprios;
    // o pai (tipo V, tipoVariacao P) nao empresta foto ao filho.
    const foto_capa = det?.anexos?.[0]?.url || null;
    const marca = det?.marca?.nome || null;
    const categoria = det?.categoria?.nome || null;
    const categoria_caminho = det?.categoria?.caminhoCompleto || null;
    const fornecedor = det?.fornecedores?.[0]?.nome || null;
    // v28: estoque total, pai da variação, situação, gtin e unidade (Catálogo).
    const agora = new Date().toISOString();
    const extra: Record<string, any> = {
      sku_pai: det?.produtoPai?.sku ? String(det.produtoPai.sku).trim() : null,
      id_tiny_pai: det?.produtoPai?.id || null,
    };
    const qtd = det?.estoque?.quantidade;
    if (qtd !== undefined && qtd !== null && !isNaN(parseFloat(qtd))) {
      extra.estoque = Math.round(parseFloat(qtd));
      extra.estoque_atualizado_em = agora;
    }
    if (det?.situacao) { extra.situacao = det.situacao; extra.ativo = det.situacao === "A"; }
    if (det?.gtin !== undefined) extra.gtin = (det.gtin && String(det.gtin).trim()) || null;
    if (det?.unidade !== undefined) extra.unidade = (det.unidade && String(det.unidade).trim()) || null;
    const { error: errUp } = await supabase.from("produtos").update({
      foto_capa, marca, categoria, categoria_caminho, fornecedor,
      ...extra,
      detalhe_atualizado_em: agora,
    }).eq("sku", p.sku);
    if (errUp) { erros.push(`${p.sku} update: ${errUp.message}`); continue; }
    totalProcessados++;
    if ((p.foto_capa || null) !== foto_capa) fotosAlteradas++;
    if (p.tipo === "K" && Array.isArray(det.kit) && det.kit.length > 0) {
      await supabase.from("produto_kits").delete().eq("sku_kit", p.sku);
      const linhas = det.kit.map((c: any) => {
        const sku_componente = c.produto?.sku || c.sku || null;
        return sku_componente ? {
          sku_kit: p.sku, sku_componente: String(sku_componente).trim(), nome_kit: p.nome,
          nome_componente: c.produto?.descricao || null, quantidade: parseFloat(c.quantidade) || 1,
          atualizado_em: new Date().toISOString(),
        } : null;
      }).filter((x: any) => x !== null);
      if (linhas.length > 0) {
        const { error: errIns } = await supabase.from("produto_kits").insert(linhas);
        if (errIns) erros.push(`${p.sku} insert kit: ${errIns.message}`);
        else { totalKits++; totalComponentes += linhas.length; }
      }
    }
    // v28: o detalhe do PAI lista as variações; grava o pai em cada filho de uma vez
    // (o detalhe do próprio filho, quando rodar, confirma pelo produtoPai).
    if (Array.isArray(det?.variacoes) && det.variacoes.length > 0) {
      const filhos = det.variacoes.map((v: any) => (v?.sku ? String(v.sku).trim() : "")).filter((s: string) => s && s !== p.sku);
      if (filhos.length > 0) {
        const { error: errF } = await supabase.from("produtos").update({ sku_pai: p.sku, id_tiny_pai: p.id_tiny }).in("sku", filhos);
        if (errF) erros.push(`${p.sku} variacoes: ${errF.message}`);
        else totalVariacoes += filhos.length;
      }
    }
  }
  return { modulo: "detalhar", sku: skuAlvo ?? null, refresh, pendentes: produtos.length, processados: totalProcessados, fotos_alteradas: fotosAlteradas, kits_atualizados: totalKits, componentes_inseridos: totalComponentes, variacoes_ligadas: totalVariacoes, inexistentes_no_tiny: inexistentes, erros, tempo_ms: Date.now() - inicio };
}

// ============================================================================
// SYNC DE ESTOQUE -> estoque_tiny (v26: alvo selecionavel; v27: fila corrigida)
// ============================================================================
function extrairDepositos(payload: any): { deposito: string; saldo: number; reservado: number; desconsiderar: boolean }[] {
  const lista = payload?.depositos || payload?.estoque?.depositos || [];
  const out: { deposito: string; saldo: number; reservado: number; desconsiderar: boolean }[] = [];
  for (const d of (Array.isArray(lista) ? lista : [])) {
    const nome = d?.deposito?.nome || d?.nome || d?.deposito || "Geral";
    const saldo = n0(d?.saldo ?? d?.quantidade ?? d?.estoque);
    const reservado = n0(d?.reservado ?? d?.saldoReservado ?? d?.reserva);
    out.push({ deposito: String(nome), saldo, reservado, desconsiderar: d?.desconsiderar === true });
  }
  if (out.length === 0) {
    const saldoTopo = payload?.saldo ?? payload?.estoque?.saldo ?? payload?.quantidade;
    if (saldoTopo !== undefined) {
      const s = n0(saldoTopo);
      const r = n0(payload?.reservado ?? payload?.estoque?.reservado);
      out.push({ deposito: "Geral", saldo: s, reservado: r, desconsiderar: false });
    }
  }
  return out;
}

async function syncEstoque(supabase: ReturnType<typeof createClient>, token: string, limite: number, alvo = "full") {
  const TIMEOUT_MS = 50000;
  const SLEEP_MS = 1100;
  const inicio = Date.now();
  const erros: string[] = [];

  const viewAlvo = VIEWS_ALVO[alvo];
  if (!viewAlvo) return { modulo: "estoque", alvo, nota: `alvo desconhecido (use: ${Object.keys(VIEWS_ALVO).join(", ")})`, processados: 0 };

  const { data: alvoRows } = await supabase.from(viewAlvo).select("sku");
  const skusAlvo = Array.from(new Set((alvoRows || []).map((r: any) => String(r.sku)).filter((s: string) => s && s !== "null")));
  if (skusAlvo.length === 0) return { modulo: "estoque", alvo, nota: "nenhum sku alvo", processados: 0 };

  const idPorSku = new Map<string, any>();
  for (let i = 0; i < skusAlvo.length; i += 300) {
    const lote = skusAlvo.slice(i, i + 300);
    const { data } = await supabase.from("produtos").select("sku, id_tiny").in("sku", lote).not("id_tiny", "is", null);
    for (const r of (data || [])) idPorSku.set(String(r.sku), r.id_tiny);
  }

  // v27: 1 linha por SKU e leitura paginada (o PostgREST corta em 1.000 linhas).
  const ultimaPorSku = new Map<string, string>();
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase
      .from("view_estoque_tiny_ultima")
      .select("sku, ultima")
      .order("sku")
      .range(de, de + 999);
    if (error) { erros.push(`leitura ultima atualizacao: ${error.message.substring(0, 60)}`); break; }
    for (const r of (data || [])) ultimaPorSku.set(String(r.sku), r.ultima);
    if (!data || data.length < 1000) break;
  }

  const fila = skusAlvo
    .filter((s) => idPorSku.has(s))
    .sort((a, b) => {
      const ua = ultimaPorSku.get(a) || "";
      const ub = ultimaPorSku.get(b) || "";
      return ua.localeCompare(ub);
    })
    .slice(0, limite);
  const semCadastro = skusAlvo.filter((s) => !idPorSku.has(s)).length;
  const nuncaSincronizados = skusAlvo.filter((s) => idPorSku.has(s) && !ultimaPorSku.has(s)).length;

  let processados = 0, linhasGravadas = 0;
  for (let i = 0; i < fila.length; i++) {
    if (Date.now() - inicio > TIMEOUT_MS) { erros.push(`timeout apos ${i}`); break; }
    if (i > 0) await sleep(SLEEP_MS);
    const sku = fila[i];
    const idTiny = idPorSku.get(sku);
    let payload: any;
    try { payload = await tinyGetWithRetry(`/estoque/${idTiny}`, token); }
    catch (err) { erros.push(`${sku}: ${(err as Error).message.substring(0, 70)}`); continue; }
    const deps = extrairDepositos(payload);
    if (deps.length === 0) { erros.push(`${sku}: payload sem depositos`); continue; }
    await supabase.from("estoque_tiny").delete().eq("sku", sku);
    const linhas = deps.map((d) => ({
      tiny_produto_id: idTiny,
      sku,
      nome_produto: payload?.nome || payload?.descricao || null,
      deposito: d.deposito,
      saldo: d.saldo,
      saldo_reservado: d.reservado,
      desconsiderar: d.desconsiderar,
      atualizado_em: new Date().toISOString(),
    }));
    const { error } = await supabase.from("estoque_tiny").insert(linhas);
    if (error) { erros.push(`${sku} insert: ${error.message.substring(0, 60)}`); continue; }
    processados++;
    linhasGravadas += linhas.length;
  }

  return { modulo: "estoque", alvo, skus_alvo: skusAlvo.length, sem_cadastro_tiny: semCadastro, nunca_sincronizados_antes: nuncaSincronizados, fila: fila.length, processados, linhas_gravadas: linhasGravadas, erros: erros.slice(0, 5), tempo_ms: Date.now() - inicio };
}

// ============================================================================
// MAIN
// ============================================================================
serve(async (req: Request) => {
  // Preflight PRIMEIRO — sem isso o navegador bloqueia a chamada real (v14).
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return textResp("Faltam secrets Supabase", 500);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let token: string;
  try { token = await pegarTokenTiny(supabase); }
  catch (err) { return textResp((err as Error).message, 401); }

  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { body = {}; }
  }
  const param = (k: string): string | null => url.searchParams.get(k) ?? (body?.[k] != null ? String(body[k]) : null);

  const modulo = param("modulo") || "produtos";

  if (modulo === "test-pagina") {
    const offset = parseInt(param("offset") || "0", 10);
    try {
      const resp = await tinyGet("/produtos", token, { situacao: "A", limit: 5, offset });
      return jsonResp(resp);
    } catch (err) { return jsonResp({ erro: (err as Error).message }, 500); }
  }

  if (modulo === "test-produto") {
    const sku = param("sku");
    if (!sku) return textResp("Forneca ?sku=NUMERO", 400);
    try {
      const lista = await tinyGet("/produtos", token, { codigo: sku, limit: 1 });
      const id = lista.itens?.[0]?.id;
      const detalhe = id ? await tinyGet(`/produtos/${id}`, token) : null;
      return jsonResp({ sku, lista, detalhe });
    } catch (err) { return jsonResp({ erro: (err as Error).message }, 500); }
  }

  if (modulo === "test-estoque") {
    const sku = param("sku");
    if (!sku) return textResp("Forneca ?sku=NUMERO", 400);
    try {
      const { data: p } = await supabase.from("produtos").select("id_tiny").eq("sku", sku).single();
      if (!p?.id_tiny) throw new Error(`sku ${sku} sem id_tiny`);
      const payload = await tinyGet(`/estoque/${p.id_tiny}`, token);
      await supabase.from("debug_fulfillment").insert({ modulo: "tiny-estoque", etapa: sku, status_http: 200, resultado: payload });
      return jsonResp({ ok: true, sku });
    } catch (err) {
      await supabase.from("debug_fulfillment").insert({ modulo: "tiny-estoque", etapa: sku, status_http: null, resultado: { erro: (err as Error).message } });
      return jsonResp({ erro: (err as Error).message }, 500);
    }
  }

  const tInicio = Date.now();
  let resultado: any;
  try {
    if (modulo === "produtos") {
      const limite = parseInt(param("limite") || "5000", 10);
      resultado = await syncProdutos(supabase, token, limite, param("forcar") === "1");
    } else if (modulo === "detalhar") {
      const skuAlvo = param("sku");
      const limite = parseInt(param("limite") || "50", 10);
      const refresh = param("refresh") === "1";
      resultado = await detalharProdutos(supabase, token, limite, skuAlvo, refresh, param("pais") === "1");
    } else if (modulo === "estoque") {
      const limite = parseInt(param("limite") || "35", 10);
      const alvo = param("alvo") || "full";
      resultado = await syncEstoque(supabase, token, limite, alvo);
    } else {
      return textResp(`Modulo "${modulo}" nao implementado`, 400);
    }
  } catch (err) {
    return textResp(`Erro: ${(err as Error).message}`, 500);
  }
  resultado.tempo_ms_total = Date.now() - tInicio;
  return jsonResp(resultado);
});
