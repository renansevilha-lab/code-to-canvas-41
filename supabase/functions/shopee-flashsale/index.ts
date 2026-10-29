// ============================================================================
// Edge Function: shopee-flashsale v12
// ----------------------------------------------------------------------------
// v12 (28/out): TAMBEM 20 ANUNCIOS POR RELAMPAGO. A Bumi ficou sem relampago de 21 a
//   29/out: a programacao tinha 21 anuncios (48 variacoes, dentro das 50) e a Shopee
//   recusou TUDO com o mesmo "exceed the max number of item limit per promotion".
//   Nas ultimas 50 relampagos de cada loja o maximo foi 20 anuncios (Bumi; Ottz 17)
//   e a de 20/out entrou com 20 anuncios/44 variacoes. Agora cada envio respeita os
//   DOIS limites (20 anuncios E 50 variacoes, contando o que ja esta na do dia); o
//   resto vira "nao coube", na ordem de quem vende mais.
// v11 (21/out): ESCRITA SÓ COM LOGIN. A chave pública do site (que vai no código
//   do navegador) bastava para criar/adicionar/ativar/remover/excluir relâmpagos e
//   para programar com confirmar=1. Agora, com confirmar=1, exige sessão de usuário
//   (role authenticated) ou service role. Única exceção: a rodada do robô
//   (programar&auto=1, cron 87) — sem `dia` (sempre amanhã) e só nas lojas com
//   flashsale_config.automacao_ativa, igual à regra do ml-promocoes modulo=auto.
//   Leitura e prévia (sem confirmar) seguem abertas.
// Promocao Relampago da Loja (Shop Flash Sale) nas 2 lojas.
// LEITURA (seguro):
//   ?modulo=slots&shop_id=X[&dias=7]      - horarios disponiveis (slots DIARIOS)
//   ?modulo=criteria&shop_id=X            - criterios de elegibilidade
//   ?modulo=list&shop_id=X[&type=0]       - flash sales existentes
//   ?modulo=sale&shop_id=X&flash_sale_id=Y- detalhe + itens de uma flash sale
//   ?modulo=catalogo&shop_id=X[&offset=0&limit=50] - produtos (item_id/model/preco)
//   ?modulo=modelos&shop_id=X&item_id=Y   - variacoes ao vivo (debug)
// ESCRITA (exige confirmar=1; sem isso e DRY):
//   ?modulo=criar / add-items / ativar / remover-itens / excluir
//   ?modulo=programar&shop_id=X|0[&dia=YYYY-MM-DD][&auto=1]&confirmar=1
//
// v10 (13/out): O LIMITE DE 50 E POR VARIACAO, NAO POR ANUNCIO. A funcao contava 50
//   ANUNCIOS; com 72+ variacoes num envio so, a Shopee recusa TUDO
//   ("shop_flash_sale_exceed_max_item_criteria — exceed the max number of item limit
//   per promotion"): a Ottz ficou sem relampago de 09 a 13/out (0 itens em 5 dias) e a
//   Bumi em 13/out. Medido: 41 e 43 variacoes entram, 58 e 72 nao. Agora cada envio
//   leva anuncios INTEIROS ate somar 50 variacoes (o que ja esta na relampago do dia
//   conta), na ordem de quem vende mais em 30 dias (RPC promo_mc_base); o resto vai
//   para "nao coube". E `dia` = hoje passa a enxergar a relampago EM ANDAMENTO
//   (antes so as futuras), para completar a do dia quando ela nasceu vazia.
// v9 (12/out): ESTOQUE NO REENVIO. Quando o estoque da programacao e maior que o
//   do anuncio (o clone pelo raio grava 1000), a v8 reenviava o estoque INTEIRO.
//   A relampago do dia ficava com tudo reservado e, as 18h07, a do dia seguinte
//   era recusada (1400101726) — o produto entrava em dias alternados. Agora o
//   reenvio usa METADE do estoque LIVRE = estoque do vendedor (seller_stock)
//   menos o que as outras relampagos ativas/programadas ja reservaram
//   (campaign_stock). Atencao: com o anuncio numa relampago em andamento, o
//   total_available_stock da Shopee vira o estoque DA CAMPANHA, nao o total.
// v8 (15/set): RATE LIMIT da Shopee (`error_rate_limit`, "Too many requests")
//   nas APIs de flash sale e BAIXO e estourava na previa da tela (cada clique =
//   list + slots + items). Agora toda chamada a Shopee espera 2,5 s e tenta de
//   novo (ate 3x) quando volta rate limit; se persistir, a mensagem explica.
//   Com a loja bloqueada por criterio (not_meet_shop_criteria), a previa avisa
//   isso ANTES de gastar chamadas.
// v7 (13/set): leitura do banco com retentativa; erro em run real grava
//   flashsale_criadas(status=erro)+Discord; erro da Shopee literal; retry so
//   dos modelos que falharam; contagem por modelo.
// v6: aviso no canal `atualizacoes` com Bearer.
// v5: 1 flash sale por slot/dia, ate ~50 itens; erros traduzidos p/ PT.
// v4: auto-correcao (estoque capado ao vivo; model_id pelo SKU).
// v3: PROGRAMAR = RECONCILIACAO (adiciona so o que falta na sale do dia).
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(b: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getCredentials(partnerId: number | string): { partner_id: number; partner_key: string } {
  const id = String(partnerId);
  if (id === "2034179") return { partner_id: 2034179, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY") || "").trim() };
  if (id === "2037384") return { partner_id: 2037384, partner_key: (Deno.env.get("SHOPEE_PARTNER_KEY_SVL") || "").trim() };
  throw new Error(`Credenciais nao encontradas pra partner_id ${id}`);
}

async function hmacSha256(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Ctx { shopId: number; partnerId: number; partnerKey: string; accessToken: string; }

function signedUrl(ctx: Ctx, apiPath: string): Promise<{ url: URL; }> {
  const timestamp = Math.floor(Date.now() / 1000);
  return hmacSha256(`${ctx.partnerId}${apiPath}${timestamp}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey).then((sign) => {
    const url = new URL(`${SHOPEE_HOST}${apiPath}`);
    url.searchParams.set("partner_id", String(ctx.partnerId));
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("access_token", ctx.accessToken);
    url.searchParams.set("shop_id", String(ctx.shopId));
    url.searchParams.set("sign", sign);
    return { url };
  });
}

// v8: rate limit da Shopee -> espera e tenta de novo (ate 3 tentativas).
const ehRateLimit = (p: any) => String(p?.error || "").includes("rate_limit");

async function shopeeGet(ctx: Ctx, apiPath: string, params: Record<string, any> = {}): Promise<any> {
  let ultimo: any = null;
  for (let t = 0; t < 3; t++) {
    const { url } = await signedUrl(ctx, apiPath);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const resp = await fetch(url.toString());
    const txt = await resp.text();
    let p: any; try { p = JSON.parse(txt); } catch { p = { _raw: txt.substring(0, 500) }; }
    if (!ehRateLimit(p)) return p;
    ultimo = p; await sleep(2500 * (t + 1));
  }
  return { ...ultimo, message: `${ultimo?.message || "rate limit"} — limite de chamadas da Shopee nas APIs de Relampago; aguarde ~1 min e tente de novo (evite cliques repetidos na previa)` };
}

async function shopeePost(ctx: Ctx, apiPath: string, bodyObj: Record<string, any>): Promise<any> {
  let ultimo: any = null;
  for (let t = 0; t < 3; t++) {
    const { url } = await signedUrl(ctx, apiPath);
    const resp = await fetch(url.toString(), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyObj),
    });
    const txt = await resp.text();
    let p: any; try { p = JSON.parse(txt); } catch { p = { _raw: txt.substring(0, 500) }; }
    if (!ehRateLimit(p)) return p;
    ultimo = p; await sleep(2500 * (t + 1));
  }
  return { ...ultimo, message: `${ultimo?.message || "rate limit"} — limite de chamadas da Shopee nas APIs de Relampago; aguarde ~1 min e tente de novo` };
}

async function pegarCtx(supabase: ReturnType<typeof createClient>, shopId: number): Promise<Ctx> {
  const { data, error } = await supabase.from("oauth_tokens_shopee")
    .select("shop_id, partner_id, access_token, expires_at").eq("shop_id", shopId).single();
  if (error || !data) throw new Error(`Token nao encontrado pra shop_id ${shopId}`);
  if (new Date(data.expires_at) < new Date()) throw new Error(`Token shop_id ${shopId} expirado. Roda shopee-refresh-token.`);
  const creds = getCredentials(data.partner_id);
  if (!creds.partner_key) throw new Error(`Partner key vazia pra partner_id ${creds.partner_id}`);
  return { shopId, partnerId: creds.partner_id, partnerKey: creds.partner_key, accessToken: data.access_token };
}

/** YYYY-MM-DD em America/Sao_Paulo para um epoch (s). */
function diaSP(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
function lojaNome(shopId: number): string {
  return shopId === 522186766 ? "Ottz Pet" : shopId === 759046323 ? "Bumi Pet" : String(shopId);
}
const DICA_CRITERIO = "a loja nao atende os criterios de loja da Shopee para Relampago (taxa de atraso no envio acima de 5%) — conferir em shopee-prazo?modulo=saude e no Seller Center > Central de Marketing";

// v6: com Bearer (a discord-notify exige JWT) e canal `atualizacoes`.
async function avisarDiscord(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/discord-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
      body: JSON.stringify(payload),
    });
  } catch { /* melhor-esforco */ }
}

// v7: leitura do banco com retentativa — no minuto 00 o banco engasga (504).
async function lerProgramacao(supabase: ReturnType<typeof createClient>, shopId: number) {
  let ultimo: any = null;
  for (let t = 0; t < 3; t++) {
    const r = await supabase.from("flashsale_programacao").select("*")
      .eq("shop_id", shopId).eq("ativo", true).order("sku");
    if (!r.error) return r;
    ultimo = r; await sleep(1500 * (t + 1));
  }
  return ultimo;
}

/**
 * Programa/completa a flash sale de UMA loja para o dia alvo (reconciliacao).
 * Verdade = Shopee: le as sales do slot e adiciona so o que falta.
 */
async function programarLoja(
  supabase: ReturnType<typeof createClient>, shopId: number, diaAlvo: string, confirmar: boolean,
): Promise<Record<string, unknown>> {
  const { data: itens, error: errItens } = await lerProgramacao(supabase, shopId);
  if (errItens) return { shop_id: shopId, status: "erro", erro: `banco: ${errItens.message} (3 tentativas)` };
  if (!itens || itens.length === 0) return { shop_id: shopId, status: "sem_itens_programados" };

  // v10: 50 VARIACOES (modelos) por relampago — anuncio sem variacao conta 1.
  const MAX_POR_SALE = 50;
  // v12: e no maximo 20 ANUNCIOS — passar de qualquer um dos dois derruba o envio inteiro.
  const MAX_ANUNCIOS = 20;

  let ctx: Ctx;
  try { ctx = await pegarCtx(supabase, shopId); }
  catch (e) { return { shop_id: shopId, status: "erro", erro: (e as Error).message }; }

  // v8: o criterio de LOJA bloqueia tudo — checar primeiro (1 chamada) evita
  // gastar o rate limit com list/items que nao vao servir.
  const agora = Math.floor(Date.now() / 1000);
  const slotsR = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_time_slot_id",
    { start_time: agora + 600, end_time: agora + 8 * 86400 });
  if (slotsR?.error && String(slotsR.error).includes("not_meet_shop_criteria")) {
    return { shop_id: shopId, status: "erro", erro: `Shopee get_time_slot_id: ${slotsR.error} ${slotsR.message || ""}`.trim(), dica: DICA_CRITERIO };
  }
  if (slotsR?.error && ehRateLimit(slotsR)) {
    return { shop_id: shopId, status: "erro", erro: `Shopee get_time_slot_id: ${slotsR.error} ${slotsR.message || ""}`.trim() };
  }

  const listR = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_list",
    { type: 1, offset: 0, limit: 50 });
  if (listR?.error) return { shop_id: shopId, status: "erro", erro: `Shopee get_shop_flash_sale_list: ${listR.error} ${listR.message || ""}` };
  // v10: para HOJE a relampago ja esta em andamento (type 2) e nao vem na lista das futuras
  let listaDia: any[] = listR?.response?.flash_sale_list ?? [];
  if (diaAlvo === diaSP(agora)) {
    const emCurso = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_list", { type: 2, offset: 0, limit: 50 });
    listaDia = [...listaDia, ...((emCurso?.response?.flash_sale_list ?? []) as any[]).filter((x) => !listaDia.some((y) => Number(y.flash_sale_id) === Number(x.flash_sale_id)))];
  }
  const salesDia = listaDia
    .filter((s: any) => diaSP(Number(s.start_time)) === diaAlvo && (s.status === 1 || s.status === 2));

  let timeslotId: number | null = salesDia.length ? Number(salesDia[0].timeslot_id) : null;
  if (!timeslotId) {
    if (slotsR?.error) {
      return { shop_id: shopId, status: "erro", erro: `Shopee get_time_slot_id: ${slotsR.error} ${slotsR.message || ""}`.trim() };
    }
    const slots = Array.isArray(slotsR?.response) ? slotsR.response : [];
    const slot = slots.find((s: any) => diaSP(s.start_time) === diaAlvo);
    if (slot) timeslotId = Number(slot.timeslot_id);
  }
  if (!timeslotId) return { shop_id: shopId, status: "erro", erro: `nenhum slot nem flash sale para ${diaAlvo} (a Shopee so oferece slots futuros; para hoje ja passou)` };

  const validos: any[] = []; const pulados: any[] = [];
  for (const it of itens) {
    const orig = Number(it.preco_original ?? 0);
    const promo = Number(it.preco_promo);
    if (orig > 0 && (promo >= orig || promo < orig * 0.5)) {
      pulados.push({ sku: it.sku, motivo: promo >= orig ? "promo >= preco original" : "promo < 50% do original", promo, original: orig });
      continue;
    }
    validos.push(it);
  }
  if (validos.length === 0) return { shop_id: shopId, status: "erro", erro: "nenhum item valido (guarda de preco)", pulados };

  const itemIdsExistentes = new Set<number>();
  const ocupadas = new Map<number, number>(); // v10: variacoes que cada relampago do dia ja tem
  const anunciosOcupados = new Map<number, number>(); // v12: anuncios que cada relampago do dia ja tem
  for (const s of salesDia) {
    const it = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_items",
      { flash_sale_id: s.flash_sale_id, offset: 0, limit: 50 });
    const infos: any[] = it?.response?.item_info ?? it?.response?.items ?? [];
    const modelos: any[] = it?.response?.models ?? [];
    for (const info of infos) {
      if (info?.item_id != null) itemIdsExistentes.add(Number(info.item_id));
    }
    const comModelo = new Set(modelos.map((m) => Number(m.item_id)));
    const n = modelos.length + infos.filter((i) => i?.item_id != null && !comModelo.has(Number(i.item_id))).length;
    ocupadas.set(Number(s.flash_sale_id), Math.max(n, Number(s.item_count) || 0));
    const nAnuncios = new Set(infos.filter((i) => i?.item_id != null).map((i) => Number(i.item_id))).size;
    anunciosOcupados.set(Number(s.flash_sale_id), Math.max(nAnuncios, Number(s.item_count) || 0));
  }

  const porItem = new Map<number, any>();
  for (const it of validos) {
    if (itemIdsExistentes.has(Number(it.item_id))) continue;
    const g = porItem.get(Number(it.item_id)) ?? { item_id: Number(it.item_id), purchase_limit: Number(it.limite_compra) || 0, models: [] };
    g.models.push({ model_id: Number(it.model_id) || 0, input_promo_price: Number(it.preco_promo), stock: Number(it.estoque_promo) });
    porItem.set(Number(it.item_id), g);
  }
  // v10: quem vende mais entra primeiro (a soma das variacoes do anuncio, 30 dias)
  const vendas = new Map<string, number>();
  {
    const skus = [...new Set(validos.map((v: any) => String(v.sku || "")).filter(Boolean))];
    const mc = await supabase.rpc("promo_mc_base", { p_shop_id: shopId, p_skus: skus });
    for (const x of ((mc.data ?? []) as any[])) vendas.set(String(x.sku), Number(x.vendas_30d) || 0);
  }
  const pesoDe = (g: any) => validos.filter((v: any) => Number(v.item_id) === Number(g.item_id))
    .reduce((s: number, v: any) => s + (vendas.get(String(v.sku || "")) ?? 0), 0);
  const faltantes = [...porItem.values()].map((g) => ({ g, peso: pesoDe(g) })).sort((a, b) => b.peso - a.peso).map((x) => x.g);
  const contar = (lista: any[]) => lista.reduce((s: number, g: any) => s + (g.models?.length || 0), 0);
  /** Anuncios INTEIROS da lista ate somarem `limite` variacoes e no maximo `limAnuncios` anuncios
   *  (pula o que nao cabe e tenta o seguinte). */
  const separar = (lista: any[], limite: number, limAnuncios: number): { pega: any[]; fica: any[] } => {
    const pega: any[] = []; const fica: any[] = []; let n = 0;
    for (const g of lista) {
      const m = g.models?.length || 0;
      if (n + m <= limite && pega.length < limAnuncios) { pega.push(g); n += m; } else fica.push(g);
    }
    return { pega, fica };
  };
  const jaNaPromo = validos.length - faltantes.reduce((s, g) => s + g.models.length, 0);

  const capacidades = salesDia.map((s: any) => ({
    flash_sale_id: Number(s.flash_sale_id), status: s.status,
    itens: ocupadas.get(Number(s.flash_sale_id)) ?? (Number(s.item_count) || 0),
    cap: Math.max(0, MAX_POR_SALE - (ocupadas.get(Number(s.flash_sale_id)) ?? (Number(s.item_count) || 0))),
    capAnuncios: Math.max(0, MAX_ANUNCIOS - (anunciosOcupados.get(Number(s.flash_sale_id)) ?? (Number(s.item_count) || 0))),
  }));
  const capTotal = capacidades.reduce((s: number, c: any) => s + c.cap, 0);
  const capAnunciosTotal = capacidades.reduce((s: number, c: any) => s + c.capAnuncios, 0);

  if (faltantes.length === 0) {
    return {
      shop_id: shopId, status: "em_dia", dia: diaAlvo,
      sales_existentes: salesDia.length, itens_ja_na_promo: itemIdsExistentes.size, pulados,
    };
  }

  if (!confirmar) {
    // v10: tudo em VARIACOES (e o que a Shopee conta)
    const previa = salesDia.length ? separar(faltantes, capTotal, capAnunciosTotal) : separar(faltantes, MAX_POR_SALE, MAX_ANUNCIOS);
    return {
      shop_id: shopId, status: "dry", dia: diaAlvo, timeslot_id: timeslotId,
      sales_existentes: salesDia.length, itens_ja_na_promo: itemIdsExistentes.size,
      faltam: contar(faltantes), anuncios_faltando: faltantes.length,
      cabem: contar(previa.pega), anuncios_cabem: previa.pega.length,
      nao_cabem: contar(previa.fica),
      nao_cabem_skus: previa.fica.flatMap((g: any) => validos.filter((v: any) => Number(v.item_id) === Number(g.item_id)).map((v: any) => v.sku)),
      pulados, payload: previa.pega,
      aviso: "nada criado — repita com confirmar=1",
    };
  }

  // Contagem por MODELO (variacao): e o que a Shopee aceita/recusa um a um.
  let okModelos = 0; let falhaModelos = 0; const acoes: any[] = []; let fila = [...faltantes];
  const problemas: any[] = [];

  // v9: estoque ja reservado por OUTRAS relampagos (em andamento ou programadas
  // para outro dia), por "item:model". Lido uma vez, so quando ha reenvio.
  let reservas: Map<string, number> | null = null;
  async function lerReservas(): Promise<Map<string, number>> {
    if (reservas) return reservas;
    const mapa = new Map<string, number>();
    const outras: any[] = (listR?.response?.flash_sale_list ?? [])
      .filter((x: any) => diaSP(Number(x.start_time)) !== diaAlvo && (x.status === 1 || x.status === 2));
    const emAndamento = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_list", { type: 2, offset: 0, limit: 50 });
    for (const x of (emAndamento?.response?.flash_sale_list ?? [])) {
      if (diaSP(Number(x.start_time)) !== diaAlvo && !outras.some((o) => Number(o.flash_sale_id) === Number(x.flash_sale_id))) outras.push(x);
    }
    for (const x of outras) {
      const r = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_items", { flash_sale_id: x.flash_sale_id, offset: 0, limit: 50 });
      for (const m of (r?.response?.models ?? [])) {
        if (Number(m.status) !== 1) continue; // variacao desligada na promocao nao reserva estoque
        const k = `${Number(m.item_id)}:${Number(m.model_id) || 0}`;
        mapa.set(k, (mapa.get(k) ?? 0) + (Number(m.campaign_stock) || 0));
      }
      for (const info of (r?.response?.item_info ?? r?.response?.items ?? [])) {
        if (info?.campaign_stock == null || Number(info.status) === 0) continue; // anuncio sem variacao
        const k = `${Number(info.item_id)}:0`;
        mapa.set(k, (mapa.get(k) ?? 0) + (Number(info.campaign_stock) || 0));
      }
    }
    acoes.push({ acao: "ler-reservas", outras_relampagos: outras.length, variacoes_reservadas: mapa.size });
    reservas = mapa;
    return mapa;
  }
  // estoque total do vendedor (nao muda quando o anuncio entra numa relampago)
  const estoqueVendedor = (info: any): number | null => {
    const l = info?.stock_info_v2?.seller_stock;
    if (!Array.isArray(l) || l.length === 0) return null;
    return l.reduce((t: number, x: any) => t + (Number(x?.stock) || 0), 0);
  };
  const MOTIVO_RESERVADO = "estoque todo reservado pela relampago em andamento — entra na proxima (ou reduza o estoque da promocao deste item)";

  // v7: so as linhas (modelos) pedidas sao corrigidas/reenviadas.
  async function corrigirItem(itemId: number, soModelIds: Set<number> | null): Promise<any | null> {
    const res = await lerReservas();
    let linhas = validos.filter((v: any) => Number(v.item_id) === itemId);
    if (soModelIds && soModelIds.size > 0) linhas = linhas.filter((v: any) => soModelIds.has(Number(v.model_id) || 0));
    if (linhas.length === 0) return null;
    const ml = await shopeeGet(ctx, "/api/v2/product/get_model_list", { item_id: itemId });
    const models = ml?.response?.model ?? [];
    const novas: any[] = [];
    if (models.length > 0) {
      for (const linha of linhas) {
        const m = models.find((mm: any) => (mm.model_sku || "").trim() === (linha.sku || "").trim())
          ?? models.find((mm: any) => Number(mm.model_id) === Number(linha.model_id));
        if (!m) {
          problemas.push({ sku: linha.sku, motivo: "item tem variacao na Shopee e nenhuma casa com este SKU — remova e adicione de novo escolhendo a variacao" });
          continue;
        }
        const total = estoqueVendedor(m) ?? m.stock_info_v2?.summary_info?.total_available_stock
          ?? m.stock_info?.[0]?.current_stock ?? null;
        if (total != null && total < 1) { problemas.push({ sku: linha.sku, motivo: "sem estoque disponivel na Shopee — desative na programacao ou reponha" }); continue; }
        const livre = total != null ? Number(total) - (res.get(`${itemId}:${Number(m.model_id) || 0}`) ?? 0) : null;
        if (livre != null && livre < 1) { problemas.push({ sku: linha.sku, motivo: MOTIVO_RESERVADO }); continue; }
        // metade do livre: sobra estoque para a relampago do dia seguinte, montada com esta ainda no ar
        const stock = livre != null ? Math.min(Number(linha.estoque_promo), Math.max(1, Math.floor(livre / 2))) : Number(linha.estoque_promo);
        if (Number(linha.model_id) !== Number(m.model_id)) {
          await supabase.from("flashsale_programacao")
            .update({ model_id: Number(m.model_id), atualizado_em: new Date().toISOString() })
            .eq("id", linha.id);
          acoes.push({ acao: "auto-corrigir-model", sku: linha.sku, de: Number(linha.model_id), para: Number(m.model_id) });
        }
        novas.push({ model_id: Number(m.model_id), input_promo_price: Number(linha.preco_promo), stock });
      }
    } else {
      const bi = await shopeeGet(ctx, "/api/v2/product/get_item_base_info", { item_id_list: String(itemId) });
      const it0 = bi?.response?.item_list?.[0];
      if (!it0) {
        for (const linha of linhas) problemas.push({ sku: linha.sku, motivo: "anuncio nao encontrado NESTA loja (item de outra loja?) — remova e adicione de novo pela busca" });
        return null;
      }
      const total = estoqueVendedor(it0) ?? it0?.stock_info_v2?.summary_info?.total_available_stock ?? null;
      const livre = total != null ? Number(total) - (res.get(`${itemId}:0`) ?? 0) : null;
      for (const linha of linhas) {
        if (total != null && total < 1) { problemas.push({ sku: linha.sku, motivo: "sem estoque disponivel na Shopee — desative na programacao ou reponha" }); continue; }
        if (livre != null && livre < 1) { problemas.push({ sku: linha.sku, motivo: MOTIVO_RESERVADO }); continue; }
        const stock = livre != null ? Math.min(Number(linha.estoque_promo), Math.max(1, Math.floor(livre / 2))) : 1;
        novas.push({ model_id: 0, input_promo_price: Number(linha.preco_promo), stock });
      }
    }
    if (novas.length === 0) return null;
    return { item_id: itemId, purchase_limit: Number(linhas[0].limite_compra) || 0, models: novas };
  }

  function traduzirFalha(f: any): string {
    const uq = Array.isArray(f?.unqualified_conditions) ? f.unqualified_conditions : [];
    const codes = uq.map((u: any) => Number(u.unqualified_code));
    if (codes.includes(10010)) return "desconto abaixo do minimo do criterio da Shopee (~1%) — 1 centavo nao passa; aumente o desconto";
    if (codes.includes(10014)) return "preco promo MAIOR que o menor preco dos ultimos 7 dias — abaixe o promo ate esse piso";
    if (Number(f?.err_code) === 1400101726) return "estoque promo maior que o estoque LIVRE na Shopee (parte pode estar reservada por outra promocao) — reduza o estoque da promocao ou reponha";
    if (Number(f?.err_code) === 1400101740) return "item tem variacao e faltou o model_id";
    if (Number(f?.err_code) === 1400101731) return "ja estava na promocao";
    if (Number(f?.err_code) === 1400101718) {
      const msgs = uq.map((u: any) => u.unqualified_msg).filter(Boolean).join("; ");
      return `nao atende os criterios do produto${msgs ? ` (${msgs})` : ""}`;
    }
    return f?.err_msg || `erro ${f?.err_code}`;
  }

  const RETRYABLE = new Set([1400101726, 1400101740]);
  const nModelos = (chunk: any[]) => chunk.reduce((s, g) => s + (g.models?.length || 0), 0);

  async function addItens(flashSaleId: number, chunk: any[]): Promise<void> {
    const enviados = nModelos(chunk);
    const ad = await shopeePost(ctx, "/api/v2/shop_flash_sale/add_shop_flash_sale_items",
      { flash_sale_id: flashSaleId, items: chunk });
    let falhas: any[] = Array.isArray(ad?.response?.failed_items) ? ad.response.failed_items : [];
    if (ad?.error && falhas.length === 0) falhas = chunk.flatMap((c) => c.models.map((m: any) => ({ item_id: c.item_id, model_id: m.model_id, err_msg: ad?.message || ad?.error })));
    acoes.push({ acao: "add", flash_sale_id: flashSaleId, enviados, falhas: falhas.length,
      error: ad?.error || null, message: ad?.message || null, failed_items: falhas.length ? falhas : undefined });

    const retry = new Map<number, Set<number>>();
    for (const f of falhas) {
      if (!RETRYABLE.has(Number(f.err_code))) continue;
      const set = retry.get(Number(f.item_id)) ?? new Set<number>();
      set.add(Number(f.model_id) || 0);
      retry.set(Number(f.item_id), set);
    }
    const semRetry = falhas.filter((f: any) => !RETRYABLE.has(Number(f.err_code)));
    for (const f of semRetry) {
      const linha = validos.find((v: any) => Number(v.item_id) === Number(f.item_id) && (!f.model_id || Number(v.model_id) === Number(f.model_id)))
        ?? validos.find((v: any) => Number(v.item_id) === Number(f.item_id));
      problemas.push({ sku: linha?.sku ?? String(f.item_id), motivo: traduzirFalha(f) });
    }
    let falhasFinais = semRetry.length;
    let naoCorrigidos = 0;
    if (retry.size > 0) {
      const corrigidos: any[] = [];
      for (const [id, set] of retry) {
        const c = await corrigirItem(id, set);
        if (c) corrigidos.push(c); else naoCorrigidos += set.size;
      }
      let reFalhas: any[] = [];
      if (corrigidos.length > 0) {
        const re = await shopeePost(ctx, "/api/v2/shop_flash_sale/add_shop_flash_sale_items",
          { flash_sale_id: flashSaleId, items: corrigidos });
        reFalhas = Array.isArray(re?.response?.failed_items) ? re.response.failed_items
          : (re?.error ? corrigidos.flatMap((c) => c.models.map((m: any) => ({ item_id: c.item_id, model_id: m.model_id, err_msg: re?.message || re?.error }))) : []);
        acoes.push({ acao: "add-retry", flash_sale_id: flashSaleId, enviados: nModelos(corrigidos), falhas: reFalhas.length,
          error: re?.error || null, message: re?.message || null, failed_items: reFalhas.length ? reFalhas : undefined });
        for (const f of reFalhas) {
          const linha = validos.find((v: any) => Number(v.item_id) === Number(f.item_id) && (!f.model_id || Number(v.model_id) === Number(f.model_id)))
            ?? validos.find((v: any) => Number(v.item_id) === Number(f.item_id));
          problemas.push({ sku: linha?.sku ?? String(f.item_id), motivo: traduzirFalha(f) });
        }
        const reenviados = nModelos(corrigidos);
        const pedidos = [...retry.values()].reduce((s, set) => s + set.size, 0);
        naoCorrigidos += Math.max(0, pedidos - reenviados - naoCorrigidos);
      }
      falhasFinais += naoCorrigidos + reFalhas.length;
    }
    falhaModelos += falhasFinais;
    okModelos += Math.max(0, enviados - falhasFinais);
  }

  for (const c of capacidades) {
    if (fila.length === 0 || c.cap <= 0 || c.capAnuncios <= 0) continue;
    const parte = separar(fila, c.cap, c.capAnuncios);
    fila = parte.fica;
    if (parte.pega.length) await addItens(c.flash_sale_id, parte.pega);
  }

  if (fila.length > 0 && salesDia.length === 0) {
    const parte = separar(fila, MAX_POR_SALE, MAX_ANUNCIOS);
    const chunk = parte.pega; fila = parte.fica;
    const cr = await shopeePost(ctx, "/api/v2/shop_flash_sale/create_shop_flash_sale", { timeslot_id: Number(timeslotId) });
    const flashSaleId = cr?.response?.flash_sale_id;
    if (cr?.error || !flashSaleId) {
      falhaModelos += nModelos(chunk);
      acoes.push({ acao: "criar", error: cr?.error, message: cr?.message, itens_perdidos: chunk.length });
      problemas.push({ sku: "*", motivo: `Shopee recusou criar a flash sale: ${cr?.error || "?"} ${cr?.message || ""}` });
    } else {
      await addItens(Number(flashSaleId), chunk);
      const at = await shopeePost(ctx, "/api/v2/shop_flash_sale/update_shop_flash_sale",
        { flash_sale_id: Number(flashSaleId), status: 1 });
      acoes.push({ acao: "ativar", flash_sale_id: Number(flashSaleId), ok: !at?.error, error: at?.error || null, message: at?.message || null });
      if (at?.error) problemas.push({ sku: "*", motivo: `Shopee recusou ATIVAR a flash sale: ${at.error} ${at.message || ""}` });
    }
  }
  if (fila.length > 0) {
    falhaModelos += nModelos(fila);
    for (const g of fila) for (const _m of g.models) {
      const linha = validos.find((v: any) => Number(v.item_id) === Number(g.item_id));
      problemas.push({ sku: linha?.sku ?? String(g.item_id), motivo: "nao coube na relampago do dia (a Shopee permite 1 por dia, ate 20 anuncios e 50 variacoes — entram primeiro os que mais vendem)" });
    }
  }

  const status = okModelos === 0 ? "erro" : falhaModelos > 0 ? "parcial" : "ok";
  await supabase.from("flashsale_criadas").upsert({
    shop_id: shopId, dia: diaAlvo, timeslot_id: timeslotId,
    flash_sale_id: (acoes.find((a) => a.acao === "ativar")?.flash_sale_id
      ?? capacidades[0]?.flash_sale_id ?? null),
    status, itens_ok: okModelos, itens_falha: falhaModelos,
    detalhe: { acoes, pulados, problemas, ja_na_promo: jaNaPromo },
  }, { onConflict: "shop_id,dia" });

  await avisarDiscord({
    canal: "atualizacoes",
    nivel: status === "ok" ? "ok" : status === "parcial" ? "aviso" : "erro",
    titulo: `⚡ Relâmpago ${lojaNome(shopId)} — ${diaAlvo}`,
    descricao: status === "ok"
      ? `Promoção do dia completa: **${okModelos}** variação(ões) adicionadas${salesDia.length ? ` (${salesDia.length} bloco(s) já existiam)` : ""}.`
      : status === "parcial"
        ? `${okModelos} variação(ões) ok e **${falhaModelos} falha(s)** — conferir no Seller Center.`
        : `**Falhou** ao montar a promoção — conferir.`,
    campos: [
      { nome: "Adicionados", valor: `${okModelos}`, inline: true },
      { nome: "Já estavam", valor: `${itemIdsExistentes.size}`, inline: true },
      ...(pulados.length ? [{ nome: "Pulados (guarda de preço)", valor: pulados.map((x: any) => x.sku).join(", ").slice(0, 900), inline: false }] : []),
      ...(problemas.length ? [{ nome: "Problemas", valor: problemas.map((x: any) => `${x.sku}: ${x.motivo}`).join("\n").slice(0, 900), inline: false }] : []),
    ],
    rodape: "shopee-flashsale · programar",
  });

  return {
    shop_id: shopId, status, dia: diaAlvo, itens_ok: okModelos, itens_falha: falhaModelos,
    ja_na_promo: itemIdsExistentes.size, acoes, pulados, problemas,
  };
}

// v7: erro ANTES de chegar na Shopee (banco, token, slot, loja bloqueada) em
// run real -> grava e avisa. Antes isso morria em silencio e o dia passava.
async function registrarErro(supabase: ReturnType<typeof createClient>, r: Record<string, unknown>, diaAlvo: string) {
  const shopId = Number(r.shop_id);
  await supabase.from("flashsale_criadas").upsert({
    shop_id: shopId, dia: diaAlvo, timeslot_id: null, flash_sale_id: null,
    status: "erro", itens_ok: 0, itens_falha: 0,
    detalhe: { erro: r.erro, dica: r.dica ?? null, pulados: r.pulados ?? [] },
  }, { onConflict: "shop_id,dia" });
  await avisarDiscord({
    canal: "atualizacoes", nivel: "erro",
    titulo: `⚡ Relâmpago ${lojaNome(shopId)} — ${diaAlvo}`,
    descricao: `**Não foi possível montar a promoção.**\n${String(r.erro)}${r.dica ? `\n_${r.dica}_` : ""}`,
    rodape: "shopee-flashsale · programar",
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supabase = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const p = (k: string): string | null => url.searchParams.get(k) ?? (body?.[k] != null ? String(body[k]) : null);

  const modulo = p("modulo") || "list";
  const shopId = parseInt(p("shop_id") || "0", 10);

  // v11: escrita na Shopee só com sessão de usuário ou service role (ver cabeçalho)
  if (p("confirmar") === "1") {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    let role = "";
    try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = ""; }
    const logado = bearer === SRK || role === "authenticated" || role === "service_role";
    const rodadaRobo = modulo === "programar" && p("auto") === "1" && !p("dia");
    if (!logado && !rodadaRobo) return json({ erro: "faça login no app (sessão de usuário exigida para alterar a relâmpago)" }, { status: 401 });
  }

  if (modulo === "programar") {
    const confirmar = p("confirmar") === "1";
    const auto = p("auto") === "1";
    const diaAlvo = p("dia") || diaSP(Math.floor(Date.now() / 1000) + 86400);

    let shops: number[];
    if (shopId) shops = [shopId];
    else {
      const { data } = await supabase.from("flashsale_config").select("shop_id, automacao_ativa");
      shops = (data ?? []).map((r: any) => Number(r.shop_id));
      if (auto) shops = (data ?? []).filter((r: any) => r.automacao_ativa).map((r: any) => Number(r.shop_id));
    }
    if (auto && shopId) {
      const { data: cfg } = await supabase.from("flashsale_config")
        .select("automacao_ativa").eq("shop_id", shopId).maybeSingle();
      if (!cfg?.automacao_ativa) return json({ modulo, shop_id: shopId, status: "automacao_desligada" });
    }
    if (shops.length === 0) return json({ modulo, dia: diaAlvo, status: "nenhuma loja com automacao ativa" });

    const resultados = [];
    for (const sid of shops) {
      let r: Record<string, unknown>;
      try { r = await programarLoja(supabase, sid, diaAlvo, confirmar); }
      catch (e) { r = { shop_id: sid, status: "erro", erro: `excecao: ${(e as Error).message}` }; }
      if (confirmar && r.status === "erro" && r.erro) {
        try { await registrarErro(supabase, r, diaAlvo); } catch { /* melhor-esforco */ }
      }
      resultados.push(r);
    }
    return json({ modulo, dia: diaAlvo, confirmar, resultados });
  }

  if (!shopId) return json({ erro: "informe shop_id" }, { status: 400 });

  let ctx: Ctx;
  try { ctx = await pegarCtx(supabase, shopId); }
  catch (err) { return json({ erro: (err as Error).message }, { status: 401 }); }

  if (modulo === "slots") {
    const dias = Math.min(parseInt(p("dias") || "7", 10), 30);
    const start = Math.floor(Date.now() / 1000) + 3600;
    const r = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_time_slot_id", { start_time: start, end_time: start + dias * 86400 });
    const arr = Array.isArray(r?.response) ? r.response : [];
    return json({ modulo, shop_id: shopId, error: r?.error || null, message: r?.message || null,
      dica: String(r?.error || "").includes("not_meet_shop_criteria") ? DICA_CRITERIO : undefined,
      slots: arr.map((s: any) => ({ timeslot_id: s.timeslot_id, start_time: s.start_time, end_time: s.end_time })) });
  }

  if (modulo === "modelos") {
    const itemId = p("item_id");
    if (!itemId) return json({ erro: "informe item_id" }, { status: 400 });
    const ml = await shopeeGet(ctx, "/api/v2/product/get_model_list", { item_id: itemId });
    const models = (ml?.response?.model ?? []).map((m: any) => ({
      model_id: m.model_id, model_sku: m.model_sku ?? null,
      estoque: m.stock_info_v2?.summary_info?.total_available_stock ?? m.stock_info?.[0]?.current_stock ?? null,
      // v9: total do vendedor (nao cai quando a variacao entra numa relampago) e reservado para promocoes futuras
      estoque_vendedor: Array.isArray(m.stock_info_v2?.seller_stock)
        ? m.stock_info_v2.seller_stock.reduce((t: number, x: any) => t + (Number(x?.stock) || 0), 0) : null,
      reservado_futuro: m.stock_info_v2?.summary_info?.total_reserved_stock ?? null,
      preco: m.price_info?.[0]?.current_price ?? null,
    }));
    return json({ modulo, shop_id: shopId, item_id: itemId, error: ml?.error || null, message: ml?.message || null, models });
  }

  if (modulo === "criteria") {
    const r = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_item_criteria");
    return json({ modulo, shop_id: shopId, error: r?.error || null, response: r?.response ?? null });
  }

  if (modulo === "list") {
    const type = parseInt(p("type") || "0", 10);
    const r = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_list", {
      type, offset: parseInt(p("offset") || "0", 10), limit: parseInt(p("limit") || "20", 10),
    });
    return json({ modulo, shop_id: shopId, error: r?.error || null, message: r?.message || null, total: r?.response?.total_count ?? null, flash_sale_list: r?.response?.flash_sale_list ?? r?.response ?? null });
  }

  if (modulo === "sale") {
    const flashSaleId = p("flash_sale_id");
    if (!flashSaleId) return json({ erro: "informe flash_sale_id" }, { status: 400 });
    const det = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale", { flash_sale_id: flashSaleId });
    const itens = await shopeeGet(ctx, "/api/v2/shop_flash_sale/get_shop_flash_sale_items", { flash_sale_id: flashSaleId, offset: 0, limit: 50 });
    return json({ modulo, shop_id: shopId, detalhe: det?.response ?? det, itens: itens?.response ?? itens });
  }

  if (modulo === "catalogo") {
    const offset = parseInt(p("offset") || "0", 10);
    const limit = Math.min(parseInt(p("limit") || "20", 10), 50);
    const lista = await shopeeGet(ctx, "/api/v2/product/get_item_list", { offset, page_size: limit, item_status: "NORMAL" });
    if (lista?.error) return json({ modulo, shop_id: shopId, error: lista.error, message: lista.message });
    const items = lista?.response?.item || [];
    const ids = items.map((i: any) => i.item_id).filter(Boolean);
    let base: any = { response: { item_list: [] } };
    if (ids.length > 0) base = await shopeeGet(ctx, "/api/v2/product/get_item_base_info", { item_id_list: ids.join(",") });
    const baseList = base?.response?.item_list || [];
    const out: any[] = [];
    for (const it of baseList) {
      let models: any[] = [];
      if (it.has_model) {
        const ml = await shopeeGet(ctx, "/api/v2/product/get_model_list", { item_id: it.item_id });
        models = (ml?.response?.model || []).map((m: any) => ({
          model_id: m.model_id, nome: (m.tier_index || []).join("-") || m.model_sku || null, model_sku: m.model_sku || null,
          preco: m.price_info?.[0]?.current_price ?? null, estoque: m.stock_info_v2?.summary_info?.total_available_stock ?? m.stock_info?.[0]?.current_stock ?? null,
        }));
      }
      out.push({
        item_id: it.item_id, nome: it.item_name, item_sku: it.item_sku || null, has_model: !!it.has_model,
        preco: it.price_info?.[0]?.current_price ?? null,
        estoque: it.stock_info_v2?.summary_info?.total_available_stock ?? null,
        imagem: it.image?.image_url_list?.[0] || null, models,
      });
    }
    return json({ modulo, shop_id: shopId, offset, tem_proxima: !!lista?.response?.has_next_page, next_offset: lista?.response?.next_offset ?? null, produtos: out });
  }

  const confirmar = p("confirmar") === "1";

  if (modulo === "criar") {
    const timeslotId = p("timeslot_id");
    if (!timeslotId) return json({ erro: "informe timeslot_id" }, { status: 400 });
    if (!confirmar) return json({ modulo, shop_id: shopId, dry: true, aviso: "cria a flash sale (nasce DESABILITADA). Repita com confirmar=1", timeslot_id: timeslotId });
    const r = await shopeePost(ctx, "/api/v2/shop_flash_sale/create_shop_flash_sale", { timeslot_id: Number(timeslotId) });
    return json({ modulo, shop_id: shopId, ok: !r?.error, error: r?.error || null, message: r?.message || null, flash_sale_id: r?.response?.flash_sale_id ?? null, status: r?.response?.status ?? null });
  }

  if (modulo === "add-items") {
    const flashSaleId = p("flash_sale_id");
    const items = body?.items;
    if (!flashSaleId || !Array.isArray(items) || items.length === 0) return json({ erro: "informe flash_sale_id e body.items[]" }, { status: 400 });
    if (items.length > 50) return json({ erro: "maximo 50 itens por flash sale" }, { status: 400 });
    if (!confirmar) return json({ modulo, shop_id: shopId, dry: true, aviso: "adiciona itens. Repita com confirmar=1", flash_sale_id: flashSaleId, n_itens: items.length, payload: { flash_sale_id: Number(flashSaleId), items } });
    const r = await shopeePost(ctx, "/api/v2/shop_flash_sale/add_shop_flash_sale_items", { flash_sale_id: Number(flashSaleId), items });
    return json({ modulo, shop_id: shopId, ok: !r?.error, error: r?.error || null, message: r?.message || null, response: r?.response ?? null, warning: r?.warning ?? null });
  }

  if (modulo === "ativar") {
    const flashSaleId = p("flash_sale_id");
    const status = parseInt(p("status") || "0", 10);
    if (!flashSaleId || (status !== 1 && status !== 2)) return json({ erro: "informe flash_sale_id e status (1=ativar,2=desativar)" }, { status: 400 });
    if (!confirmar) return json({ modulo, shop_id: shopId, dry: true, aviso: `${status === 1 ? "ATIVA (fica publico)" : "desativa"} a flash sale. Repita com confirmar=1`, flash_sale_id: flashSaleId, status });
    const r = await shopeePost(ctx, "/api/v2/shop_flash_sale/update_shop_flash_sale", { flash_sale_id: Number(flashSaleId), status });
    return json({ modulo, shop_id: shopId, ok: !r?.error, error: r?.error || null, message: r?.message || null, response: r?.response ?? null });
  }

  if (modulo === "remover-itens") {
    const flashSaleId = p("flash_sale_id");
    const itemIds = body?.item_ids;
    if (!flashSaleId || !Array.isArray(itemIds) || itemIds.length === 0) return json({ erro: "informe flash_sale_id e body.item_ids[]" }, { status: 400 });
    if (!confirmar) return json({ modulo, shop_id: shopId, dry: true, aviso: "remove itens. Repita com confirmar=1", flash_sale_id: flashSaleId, item_ids: itemIds });
    const r = await shopeePost(ctx, "/api/v2/shop_flash_sale/delete_shop_flash_sale_items", { flash_sale_id: Number(flashSaleId), item_ids: itemIds });
    return json({ modulo, shop_id: shopId, ok: !r?.error, error: r?.error || null, message: r?.message || null });
  }

  if (modulo === "excluir") {
    const flashSaleId = p("flash_sale_id");
    if (!flashSaleId) return json({ erro: "informe flash_sale_id" }, { status: 400 });
    if (!confirmar) return json({ modulo, shop_id: shopId, dry: true, aviso: "EXCLUI a flash sale. Repita com confirmar=1", flash_sale_id: flashSaleId });
    const r = await shopeePost(ctx, "/api/v2/shop_flash_sale/delete_shop_flash_sale", { flash_sale_id: Number(flashSaleId) });
    return json({ modulo, shop_id: shopId, ok: !r?.error, error: r?.error || null, message: r?.message || null });
  }

  return json({ modulos: ["slots", "modelos", "criteria", "list", "sale", "catalogo", "programar", "criar", "add-items", "ativar", "remover-itens", "excluir"], nota: "escrita exige confirmar=1 (sem isso = dry)" });
});
