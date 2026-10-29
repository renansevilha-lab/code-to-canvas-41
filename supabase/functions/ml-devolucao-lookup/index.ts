// ============================================================================
// Edge Function: ml-devolucao-lookup v5 — etiqueta de devolucao do ML -> pedido
//                                         + espelho das reclamacoes (ml_claims)
// ----------------------------------------------------------------------------
// A etiqueta de devolucao do Mercado Livre NAO traz o numero do pedido: o QR e
// {"id":"<shipment_id>","t":"lm"} e o codigo de barras e o mesmo numero puro.
// O shipment_id nao existe no nosso espelho, entao a bipagem na tela de
// Devolucoes nunca casava com nada.
//
// Dois caminhos, ambos gravando em ml_envio_devolucao:
//  (a) bipagem: GET /shipments/{id} -> order_id (na hora, com cache).
//  (b) indexar (v3): claims/search da conta -> para cada reclamacao,
//      GET /post-purchase/v2/claims/{id}/returns -> shipments[].
//      Assim o envio de retorno ja esta na tabela ANTES do pacote chegar.
// v4: o claims/search NAO traz related_entities — a v3 filtrava por ele e so
//     lia claims do tipo "returns" (mediacao com devolucao ficava de fora).
//     Agora consulta returns de todo claim que nao e cancel_purchase.
// v5 (29/out/2026, reforma de Devolucoes): espelho das RECLAMACOES em
//     ml_claims + ml_claim_mensagens + ml_claim_motivos. So leitura no ML.
//       ?modulo=claims[&dias=2][&conta=<user_id>]  — abertas (todas) + tudo que
//         mudou nos ultimos N dias; motivos novos; mensagens das abertas/mudadas.
//       ?modulo=claim&claim_id=X  — rele UMA reclamacao (detalhe, mensagens,
//         resolucao esperada) e devolve o que gravou.
//     A fila "Pede resposta" (view_devolucoes_pede_resposta) le dai. As acoes
//     que o ML espera de nos vem em players[respondent].available_actions —
//     inclusive em claim FECHADA (return_review_ok com prazo), por isso o
//     sync tambem olha as fechadas recentes.
//
// v2: pedido de carrinho (pack) — o Tiny registra pelo pack_id, nao pelo
// order_id (ex.: 2000018379163128 -> pack 2000014956563857 -> Tiny 306039).
//
//   ?codigo=<texto bipado>   (ou body {codigo}) — QR inteiro, numero puro etc.
//   ?forcar=1                — ignora o cache e pergunta ao ML de novo
//   ?modulo=indexar[&dias=60][&conta=<user_id>][&reiniciar=1]
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ML_API = "https://api.mercadolibre.com";
const URL_SB = Deno.env.get("SUPABASE_URL") || "";
const KEY_SB = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OTTZ_USER_ID = 1107117809;
const ORCAMENTO_MS = 45_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), {
    status: s,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SB = ReturnType<typeof createClient>;
type ContaML = { user_id: number; access_token: string; expires_at: string };

async function contasML(sb: SB): Promise<ContaML[]> {
  const { data } = await sb.from("oauth_tokens_ml").select("user_id, access_token, expires_at");
  const validas = ((data ?? []) as ContaML[]).filter((t) => new Date(t.expires_at) > new Date());
  // Ottz primeiro: e a conta com mais volume, resolve na 1a tentativa quase sempre.
  validas.sort((a, b) => (Number(a.user_id) === OTTZ_USER_ID ? -1 : Number(b.user_id) === OTTZ_USER_ID ? 1 : 0));
  return validas;
}

/** GET no ML com retry em 429 (rate limit facil nos endpoints de post-purchase). */
async function mlGet(path: string, token: string): Promise<{ status: number; body: any }> {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(`${ML_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 429) { await sleep(800 * (t + 1)); continue; }
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  }
  return { status: 429, body: null };
}

/** Pedido do Tiny pelo order_id OU pelo pack_id (carrinho do ML e registrado pelo pack). */
async function pedidoTiny(sb: SB, orderId: string | null) {
  if (!orderId) return { pack_id: null, pedido_tiny: null };
  const { data: p } = await sb.from("pedidos").select("pack_id").eq("id", orderId).maybeSingle();
  const pack = (p as { pack_id?: string | null } | null)?.pack_id ?? null;
  const chaves = [orderId, pack].filter((x): x is string => !!x);
  const { data: pt } = await sb.from("pedidos_tiny")
    .select("numero_ecommerce, numero_pedido, marca_canal, situacao")
    .in("numero_ecommerce", chaves).limit(1);
  return { pack_id: pack, pedido_tiny: pt?.[0] ?? null };
}

/** Ids candidatos dentro do texto bipado, do mais provavel para o menos. */
function candidatos(raw: string): string[] {
  const achados: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").replace(/\D/g, "");
    if (s.length >= 9 && s.length <= 14 && !achados.includes(s)) achados.push(s);
  };
  // QR do ML: {"id":"47938703625","t":"lm"}
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") { push((j as Record<string, unknown>).id); push((j as Record<string, unknown>).shipment_id); }
  } catch { /* nao e JSON — segue no regex */ }
  const m = raw.match(/\d{9,14}/g) ?? [];
  // 11 digitos e o formato do shipment_id do ML hoje — tenta esses primeiro
  for (const x of m.filter((v) => v.length === 11)) push(x);
  for (const x of m) push(x);
  return achados.slice(0, 4);
}

type Envio = {
  shipment_id: string;
  order_id: string | null;
  seller_id: number | null;
  tipo: string | null;
  status: string | null;
  substatus: string | null;
  tracking: string | null;
  logistic_type: string | null;
};

async function perguntarAoMl(sid: string, contas: ContaML[]): Promise<{ envio: Envio | null; erro: string | null }> {
  let erro = "nenhuma conta ML conectada";
  for (const c of contas) {
    const { status, body: j } = await mlGet(`/shipments/${sid}`, c.access_token);
    if (status === 200 && j) {
      const order = j?.order_id ?? (Array.isArray(j?.orders) && j.orders.length ? j.orders[0]?.id : null);
      return {
        envio: {
          shipment_id: sid,
          order_id: order != null ? String(order) : null,
          seller_id: Number(c.user_id),
          tipo: j?.type ?? null,
          status: j?.status ?? null,
          substatus: j?.substatus ?? null,
          tracking: j?.tracking_number ?? null,
          logistic_type: j?.logistic_type ?? j?.logistic?.type ?? null,
        },
        erro: null,
      };
    }
    // 401/403 = envio de OUTRA conta (o ML responde invalid_caller_id): tenta a proxima.
    // 404 = o ML nao conhece esse id em conta nenhuma.
    if (status === 404) erro = `o Mercado Livre nao reconhece o envio ${sid}`;
    else if (status === 401 || status === 403) erro = `envio ${sid} nao pertence as contas conectadas`;
    else erro = `ML HTTP ${status} no envio ${sid}`;
  }
  return { envio: null, erro };
}

// ---------------------------------------------------------------------------
// Indexador: reclamacoes -> devolucoes -> envios de retorno
// ---------------------------------------------------------------------------
async function indexar(sb: SB, contas: ContaML[], dias: number, reiniciar: boolean, t0: number) {
  const corte = Date.now() - dias * 86400_000;
  const saida: Record<string, unknown>[] = [];
  for (const c of contas) {
    if (Date.now() - t0 > ORCAMENTO_MS) break;
    const uid = Number(c.user_id);
    const { data: est } = await sb.from("ml_devolucao_index_estado").select("*").eq("seller_id", uid).maybeSingle();
    let offset = reiniciar ? 0 : Number((est as any)?.offset_atual ?? 0);
    let lidas = 0, consultadas = 0, gravados = 0, comRetorno = 0, terminou = false;
    const erros: string[] = [];

    pagina: while (Date.now() - t0 < ORCAMENTO_MS) {
      const pg = await mlGet(
        `/post-purchase/v1/claims/search?player_role=respondent&player_user_id=${uid}&limit=50&offset=${offset}&sort=last_updated:desc`,
        c.access_token,
      );
      if (pg.status !== 200 || !Array.isArray(pg.body?.data)) { erros.push(`search HTTP ${pg.status} offset ${offset}`); break; }
      const claims = pg.body.data as any[];
      if (claims.length === 0) { terminou = true; break; }

      const linhas: Record<string, unknown>[] = [];
      let passouDoCorte = false;
      let processados = 0;
      for (const cl of claims) {
        const quando = Date.parse(cl?.last_updated ?? cl?.date_created ?? "");
        if (quando && quando < corte) { passouDoCorte = true; processados++; continue; }
        // cancelamento de compra nunca tem envio de retorno
        if (cl?.type === "cancel_purchase") { lidas++; processados++; continue; }
        if (Date.now() - t0 > ORCAMENTO_MS) break;
        lidas++; processados++; consultadas++;
        const rt = await mlGet(`/post-purchase/v2/claims/${cl.id}/returns`, c.access_token);
        if (rt.status !== 200 || !rt.body) {
          // 404/400 = reclamacao sem devolucao (normal)
          if (rt.status !== 404 && rt.status !== 400) erros.push(`returns ${cl.id} HTTP ${rt.status}`);
          continue;
        }
        comRetorno++;
        const orderId = rt.body?.orders?.[0]?.order_id ?? (cl?.resource === "order" ? cl?.resource_id : null);
        for (const sh of (rt.body?.shipments ?? []) as any[]) {
          if (!sh?.shipment_id) continue;
          linhas.push({
            shipment_id: Number(sh.shipment_id),
            order_id: orderId != null ? String(orderId) : null,
            seller_id: uid,
            tipo: sh?.type ?? "return",
            status: sh?.status ?? null,
            tracking: sh?.tracking_number ?? null,
            claim_id: Number(cl.id),
            return_id: rt.body?.id != null ? Number(rt.body.id) : null,
            encontrado: true,
            erro: null,
            origem: "indexador",
            atualizado_em: new Date().toISOString(),
          });
        }
        await sleep(120);
      }
      if (linhas.length) {
        const { error } = await sb.from("ml_envio_devolucao").upsert(linhas, { onConflict: "shipment_id" });
        if (error) erros.push(`upsert: ${error.message}`); else gravados += linhas.length;
      }
      offset += processados;
      if (passouDoCorte) { terminou = true; break pagina; }
      if (processados < claims.length) break; // orcamento acabou no meio da pagina
    }

    await sb.from("ml_devolucao_index_estado").upsert({
      seller_id: uid,
      offset_atual: terminou ? 0 : offset,
      claims_lidas: lidas,
      envios_gravados: gravados,
      terminou_em: terminou ? new Date().toISOString() : (est as any)?.terminou_em ?? null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: "seller_id" });
    saida.push({ conta: uid, claims_lidas: lidas, returns_consultados: consultadas, com_devolucao: comRetorno, envios_gravados: gravados, terminou, proximo_offset: terminou ? 0 : offset, erros: erros.slice(0, 5) });
  }
  return saida;
}

// ---------------------------------------------------------------------------
// v5 — espelho das reclamacoes (ml_claims / ml_claim_mensagens / ml_claim_motivos)
// ---------------------------------------------------------------------------

/** HTML do chat do ML -> texto simples (as mensagens vem em <p>/<br>/<li>). */
function htmlParaTexto(html: string | null | undefined): string {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|li|tr|h\d)\s*>/gi, "\n").replace(/<\s*li[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** Linha de ml_claims a partir do JSON do ML (search ou detalhe). */
function linhaClaim(cl: any, conta: number, packId: string | null, expected: string | null): Record<string, unknown> {
  const resp = (cl?.players ?? []).find((p: any) => p?.role === "respondent") ?? null;
  const acoes: any[] = Array.isArray(resp?.available_actions) ? resp.available_actions : [];
  const obrig = acoes.find((a) => a?.mandatory)?.action ?? null;
  const prazos = acoes.map((a) => Date.parse(a?.due_date ?? "")).filter((n) => !Number.isNaN(n) && n > 0);
  const prazo = prazos.length ? new Date(Math.min(...prazos)).toISOString() : null;
  const orderId = cl?.resource === "order" && cl?.resource_id != null ? String(cl.resource_id) : null;
  return {
    claim_id: Number(cl.id),
    conta,
    order_id: orderId,
    pack_id: packId,
    tipo: cl?.type ?? null,
    stage: cl?.stage ?? null,
    status: cl?.status ?? null,
    reason_id: cl?.reason_id ?? null,
    claimed_quantity: cl?.claimed_quantity ?? null,
    quantity_type: cl?.quantity_type ?? null,
    fulfilled: cl?.fulfilled ?? null,
    resolucao: cl?.resolution ?? null,
    acoes_disponiveis: acoes,
    acao_obrigatoria: obrig,
    prazo_acao: prazo,
    ...(expected != null ? { expected_resolution: expected } : {}),
    related_entities: Array.isArray(cl?.related_entities) ? cl.related_entities : undefined,
    criado_em: cl?.date_created ?? null,
    atualizado_em: cl?.last_updated ?? null,
    fechado_em: cl?.status === "closed" ? (cl?.resolution?.date_created ?? cl?.last_updated ?? null) : null,
    visto_em: new Date().toISOString(),
  };
}

/** pack_id dos pedidos (o Tiny registra o carrinho pelo pack). */
async function packsDosPedidos(sb: SB, orderIds: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const ids = [...new Set(orderIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from("pedidos").select("id, pack_id").in("id", ids.slice(i, i + 200));
    for (const p of (data ?? []) as { id: string; pack_id: string | null }[]) if (p.pack_id) m.set(p.id, p.pack_id);
  }
  return m;
}

/** Motivos que ainda nao estao no catalogo local. */
async function completarMotivos(sb: SB, token: string, reasonIds: string[], t0: number): Promise<number> {
  const ids = [...new Set(reasonIds.filter(Boolean))];
  if (!ids.length) return 0;
  const { data } = await sb.from("ml_claim_motivos").select("reason_id").in("reason_id", ids);
  const tem = new Set(((data ?? []) as { reason_id: string }[]).map((r) => r.reason_id));
  let n = 0;
  for (const id of ids) {
    if (tem.has(id) || Date.now() - t0 > ORCAMENTO_MS) continue;
    const r = await mlGet(`/post-purchase/v1/claims/reasons/${id}`, token);
    if (r.status === 200 && r.body) {
      await sb.from("ml_claim_motivos").upsert({
        reason_id: id, nome: r.body?.name ?? null, detalhe: r.body?.detail ?? null, flow: r.body?.flow ?? null, atualizado_em: new Date().toISOString(),
      }, { onConflict: "reason_id" });
      n++;
    } else {
      // guarda o id para nao perguntar de novo a cada rodada
      await sb.from("ml_claim_motivos").upsert({ reason_id: id, nome: null, detalhe: null, flow: null }, { onConflict: "reason_id", ignoreDuplicates: true });
    }
    await sleep(100);
  }
  return n;
}

/** Mensagens de uma reclamacao -> ml_claim_mensagens + contadores no claim. */
async function sincronizarMensagens(sb: SB, token: string, claimId: number): Promise<{ n: number; erro: string | null }> {
  const r = await mlGet(`/post-purchase/v1/claims/${claimId}/messages`, token);
  if (r.status !== 200 || !Array.isArray(r.body)) return { n: 0, erro: `messages HTTP ${r.status}` };
  const msgs = r.body as any[];
  const linhas = msgs.filter((m) => m?.hash).map((m) => ({
    hash: String(m.hash),
    claim_id: claimId,
    de: m?.sender_role ?? null,
    para: m?.receiver_role ?? null,
    texto: htmlParaTexto(m?.message),
    html: m?.message ?? null,
    anexos: Array.isArray(m?.attachments) ? m.attachments : [],
    stage: m?.stage ?? null,
    status: m?.status ?? null,
    data: m?.message_date ?? m?.date_created ?? null,
    lida_em: m?.date_read ?? null,
    visto_em: new Date().toISOString(),
  }));
  if (linhas.length) {
    const { error } = await sb.from("ml_claim_mensagens").upsert(linhas, { onConflict: "hash" });
    if (error) return { n: 0, erro: `upsert mensagens: ${error.message}` };
  }
  const ult = [...msgs].sort((a, b) => Date.parse(b?.message_date ?? b?.date_created ?? "") - Date.parse(a?.message_date ?? a?.date_created ?? ""))[0];
  await sb.from("ml_claims").update({
    mensagens_n: msgs.length,
    ultima_msg_de: ult?.sender_role ?? null,
    ultima_msg_em: ult?.message_date ?? ult?.date_created ?? null,
  }).eq("claim_id", claimId);
  return { n: linhas.length, erro: null };
}

/** Resolucao esperada pelo comprador (return_product / change_product / refund...). */
async function resolucaoEsperada(token: string, claimId: number): Promise<string | null> {
  const r = await mlGet(`/post-purchase/v1/claims/${claimId}/expected-resolutions`, token);
  if (r.status !== 200 || !Array.isArray(r.body)) return null;
  const c = r.body.find((x: any) => x?.player_role === "complainant") ?? r.body[0];
  return c?.expected_resolution ?? null;
}

/**
 * Sync das reclamacoes: (1) todas as ABERTAS; (2) tudo que mudou nos ultimos
 * `dias` (pega fechamento, resolucao e a acao de "revisar produto devolvido"
 * que aparece em claim fechada); (3) motivos novos; (4) mensagens das abertas
 * e das que mudaram. Orcamento de 45 s; a rodada seguinte continua.
 */
async function sincronizarClaims(sb: SB, contas: ContaML[], dias: number, t0: number) {
  const corte = Date.now() - dias * 86400_000;
  const saida: Record<string, unknown>[] = [];
  for (const c of contas) {
    if (Date.now() - t0 > ORCAMENTO_MS) { saida.push({ conta: c.user_id, pulada: "orcamento" }); continue; }
    const uid = Number(c.user_id);
    const erros: string[] = [];
    const vistos = new Map<number, any>();

    // 1) abertas (todas — sao poucas)
    for (let offset = 0; offset < 2000 && Date.now() - t0 < ORCAMENTO_MS; offset += 50) {
      const pg = await mlGet(`/post-purchase/v1/claims/search?player_role=respondent&player_user_id=${uid}&status=opened&limit=50&offset=${offset}&sort=last_updated:desc`, c.access_token);
      if (pg.status !== 200 || !Array.isArray(pg.body?.data)) { erros.push(`search opened HTTP ${pg.status}`); break; }
      for (const cl of pg.body.data as any[]) vistos.set(Number(cl.id), cl);
      if ((pg.body.data as any[]).length < 50) break;
      await sleep(120);
    }
    const abertas = vistos.size;

    // 2) o que mudou na janela (abertas ou fechadas)
    let mudadas = 0;
    pagina: for (let offset = 0; offset < 5000 && Date.now() - t0 < ORCAMENTO_MS; offset += 50) {
      const pg = await mlGet(`/post-purchase/v1/claims/search?player_role=respondent&player_user_id=${uid}&limit=50&offset=${offset}&sort=last_updated:desc`, c.access_token);
      if (pg.status !== 200 || !Array.isArray(pg.body?.data)) { erros.push(`search HTTP ${pg.status} offset ${offset}`); break; }
      const lista = pg.body.data as any[];
      for (const cl of lista) {
        const quando = Date.parse(cl?.last_updated ?? cl?.date_created ?? "");
        if (quando && quando < corte) break pagina;
        if (!vistos.has(Number(cl.id))) { vistos.set(Number(cl.id), cl); mudadas++; }
      }
      if (lista.length < 50) break;
      await sleep(120);
    }

    // 3) grava os claims (pack_id pelo espelho de pedidos)
    const lista = [...vistos.values()];
    const packs = await packsDosPedidos(sb, lista.map((cl) => (cl?.resource === "order" ? String(cl.resource_id) : "")));
    const linhas = lista.map((cl) => linhaClaim(cl, uid, packs.get(String(cl?.resource_id)) ?? null, null));
    let gravados = 0;
    for (let i = 0; i < linhas.length; i += 100) {
      const { error } = await sb.from("ml_claims").upsert(linhas.slice(i, i + 100), { onConflict: "claim_id" });
      if (error) erros.push(`upsert claims: ${error.message}`); else gravados += Math.min(100, linhas.length - i);
    }

    // 4) motivos que faltam no catalogo
    const motivos = await completarMotivos(sb, c.access_token, lista.map((cl) => cl?.reason_id), t0);

    // 5) mensagens: abertas, com acao pendente ou que mudaram na janela — as mais recentes primeiro
    const precisamMsg = lista
      .filter((cl) => cl?.status === "opened" || ((cl?.players ?? []).find((p: any) => p?.role === "respondent")?.available_actions ?? []).length > 0 || Date.parse(cl?.last_updated ?? "") >= corte)
      .sort((a, b) => Date.parse(b?.last_updated ?? "") - Date.parse(a?.last_updated ?? ""));
    let msgs = 0, claimsComMsg = 0, faltouMsg = 0;
    for (const cl of precisamMsg) {
      if (Date.now() - t0 > ORCAMENTO_MS) { faltouMsg++; continue; }
      const r = await sincronizarMensagens(sb, c.access_token, Number(cl.id));
      if (r.erro) erros.push(`${cl.id}: ${r.erro}`); else { msgs += r.n; claimsComMsg++; }
      // resolucao esperada so das abertas (1 chamada a mais por claim)
      if (cl?.status === "opened" && Date.now() - t0 < ORCAMENTO_MS) {
        const exp = await resolucaoEsperada(c.access_token, Number(cl.id));
        if (exp) await sb.from("ml_claims").update({ expected_resolution: exp }).eq("claim_id", Number(cl.id));
      }
      await sleep(120);
    }

    saida.push({ conta: uid, abertas, mudadas_na_janela: mudadas, gravados, motivos_novos: motivos, claims_com_mensagens: claimsComMsg, mensagens: msgs, faltou_mensagens: faltouMsg, erros: erros.slice(0, 8) });
  }
  return saida;
}

/** Rele UMA reclamacao (detalhe + mensagens + resolucao esperada). */
async function relerClaim(sb: SB, contas: ContaML[], claimId: number) {
  // conta dona: a que ja temos no espelho, senao tenta todas
  const { data: atual } = await sb.from("ml_claims").select("conta").eq("claim_id", claimId).maybeSingle();
  const ordem = [...contas].sort((a, b) => (Number(a.user_id) === Number((atual as any)?.conta) ? -1 : Number(b.user_id) === Number((atual as any)?.conta) ? 1 : 0));
  for (const c of ordem) {
    const r = await mlGet(`/post-purchase/v1/claims/${claimId}`, c.access_token);
    if (r.status !== 200 || !r.body?.id) continue;
    const cl = r.body;
    const uid = Number(c.user_id);
    const packs = await packsDosPedidos(sb, [cl?.resource === "order" ? String(cl.resource_id) : ""]);
    const exp = cl?.status === "opened" ? await resolucaoEsperada(c.access_token, claimId) : null;
    const linha = linhaClaim(cl, uid, packs.get(String(cl?.resource_id)) ?? null, exp);
    const { error } = await sb.from("ml_claims").upsert(linha, { onConflict: "claim_id" });
    if (error) return { ok: false, erro: `upsert: ${error.message}` };
    await completarMotivos(sb, c.access_token, [cl?.reason_id], Date.now());
    const m = await sincronizarMensagens(sb, c.access_token, claimId);
    const { data: gravado } = await sb.from("ml_claims").select("*").eq("claim_id", claimId).maybeSingle();
    const { data: mensagens } = await sb.from("ml_claim_mensagens").select("hash, de, para, texto, anexos, data, stage").eq("claim_id", claimId).order("data");
    return { ok: true, conta: uid, claim: gravado, mensagens: mensagens ?? [], mensagens_erro: m.erro };
  }
  return { ok: false, erro: `o ML nao devolveu a reclamacao ${claimId} em nenhuma conta conectada` };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  const p = (k: string) => (url.searchParams.get(k) ?? (body[k] != null ? String(body[k]) : null));

  const sb = createClient(URL_SB, KEY_SB);

  if (p("modulo") === "indexar") {
    let contas = await contasML(sb);
    const conta = p("conta");
    if (conta) contas = contas.filter((c) => String(c.user_id) === conta);
    if (contas.length === 0) return json({ ok: false, erro: "nenhum token ML valido" }, 401);
    const dias = Math.min(Math.max(Number(p("dias") ?? 60) || 60, 1), 365);
    const r = await indexar(sb, contas, dias, p("reiniciar") === "1", t0);
    return json({ ok: true, modulo: "indexar", dias, contas: r, ms: Date.now() - t0 });
  }

  if (p("modulo") === "claims") {
    let contas = await contasML(sb);
    const conta = p("conta");
    if (conta) contas = contas.filter((c) => String(c.user_id) === conta);
    if (contas.length === 0) return json({ ok: false, erro: "nenhum token ML valido" }, 401);
    const dias = Math.min(Math.max(Number(p("dias") ?? 2) || 2, 1), 120);
    const r = await sincronizarClaims(sb, contas, dias, t0);
    return json({ ok: true, modulo: "claims", dias, contas: r, ms: Date.now() - t0 });
  }

  if (p("modulo") === "claim") {
    const id = Number(p("claim_id"));
    if (!id) return json({ ok: false, erro: "informe claim_id" }, 400);
    const contas = await contasML(sb);
    if (contas.length === 0) return json({ ok: false, erro: "nenhum token ML valido" }, 401);
    const r = await relerClaim(sb, contas, id);
    return json({ ...r, modulo: "claim", ms: Date.now() - t0 }, r.ok ? 200 : 404);
  }

  const raw = (p("codigo") ?? p("shipment_id") ?? "").trim();
  const forcar = p("forcar") === "1";
  if (!raw) return json({ erro: "informe ?codigo=<texto bipado>" }, 400);

  const ids = candidatos(raw);
  if (ids.length === 0) return json({ ok: false, codigo: raw, motivo: "o codigo bipado nao tem numero com cara de envio do ML" });

  // 1) cache/indice — bipar o mesmo pacote duas vezes nao volta ao ML
  if (!forcar) {
    const { data: cache } = await sb.from("ml_envio_devolucao")
      .select("*").in("shipment_id", ids).eq("encontrado", true).limit(1);
    const c = cache?.[0] as Record<string, unknown> | undefined;
    if (c) {
      await sb.from("ml_envio_devolucao")
        .update({ bipagens: Number(c.bipagens ?? 1) + 1, atualizado_em: new Date().toISOString() })
        .eq("shipment_id", c.shipment_id as number);
      const tiny = await pedidoTiny(sb, c.order_id ? String(c.order_id) : null);
      return json({ ok: !!c.order_id, cache: true, origem: c.origem, codigo: raw, shipment_id: String(c.shipment_id), order_id: c.order_id, claim_id: c.claim_id, tipo: c.tipo, status: c.status, tracking: c.tracking, ...tiny });
    }
  }

  const contas = await contasML(sb);
  if (contas.length === 0) {
    return json({ ok: false, codigo: raw, erro: "nenhum token ML valido — rode ml-refresh-token" }, 401);
  }

  const tentativas: { shipment_id: string; erro: string }[] = [];
  for (const sid of ids) {
    const { envio, erro } = await perguntarAoMl(sid, contas);
    const agora = new Date().toISOString();
    if (!envio) {
      tentativas.push({ shipment_id: sid, erro: erro ?? "desconhecido" });
      // guarda o codigo que nao resolveu: serve para investigar com a etiqueta na mao
      await sb.from("ml_envio_devolucao").upsert({
        shipment_id: Number(sid), encontrado: false, erro: erro, atualizado_em: agora,
      }, { onConflict: "shipment_id", ignoreDuplicates: false });
      continue;
    }
    await sb.from("ml_envio_devolucao").upsert({
      shipment_id: Number(sid),
      order_id: envio.order_id,
      seller_id: envio.seller_id,
      tipo: envio.tipo,
      status: envio.status,
      substatus: envio.substatus,
      tracking: envio.tracking,
      logistic_type: envio.logistic_type,
      encontrado: true,
      erro: null,
      atualizado_em: agora,
    }, { onConflict: "shipment_id" });

    const tiny = await pedidoTiny(sb, envio.order_id);

    return json({
      ok: !!envio.order_id, cache: false, codigo: raw,
      shipment_id: envio.shipment_id, order_id: envio.order_id,
      tipo: envio.tipo, status: envio.status, substatus: envio.substatus,
      tracking: envio.tracking, logistic_type: envio.logistic_type,
      conta: envio.seller_id, ...tiny,
      aviso: envio.order_id ? null : "o ML conhece o envio mas nao devolveu order_id",
    });
  }

  return json({
    ok: false, codigo: raw, candidatos: ids, tentativas,
    motivo: "nenhum dos numeros bipados e um envio visivel nas contas conectadas",
    contas: contas.map((c) => c.user_id),
  });
});
