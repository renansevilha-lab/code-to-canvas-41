// ============================================================================
// Edge Function: fulfillment-sync v5
// ----------------------------------------------------------------------------
// v5 (19/out/2026, pedido do dono) — ESTOQUE DO FULL DO ML SEMPRE INTEIRO. A fase de stock lia 120
//   anúncios por rodada, um por vez, e o cron roda 2×/dia: cada anúncio era relido a cada ~1,5 dia
//   (o 14560 aparecia com 0 no Full tendo vendido 6 depois da última leitura). Agora cada rodada lê
//   TODOS os estoques (inventory_id único — 270 para 374 anúncios), 6 em paralelo, gravando em lote;
//   quem vendeu pelo Full depois da última leitura vai primeiro. `limite` é ignorado (`max` limita).
// v4 (14/out/2026, pedido do dono) — EM TRÂNSITO DA AMAZON PELOS ENVIOS. O inventário FBA soma em
//   "inbound" os envios CRIADOS e nunca despachados (WORKING) e envios despachados há meses que
//   nunca chegaram (IN_TRANSIT desde mai/jun com 0 recebido) — a Reposição contava como "a caminho"
//   o que não vai chegar. Agora, na conta cujo app tem a permissão de envios (Fulfillment Inbound,
//   hoje só a SVL): em_trânsito = Σ (enviado − recebido) dos envios em SHIPPED/IN_TRANSIT/DELIVERED/
//   CHECKED_IN/RECEIVING criados nos últimos 45 dias (data do nome "FBA STA (MM/DD/AAAA …)"; sem data
//   no nome, vale a última atualização nos 45 dias). Sem a permissão (ACZ: 403) ou sem tempo para ler
//   todos os envios: só despachado + recebendo, sem os criados (WORKING).
// Sincroniza o ESTOQUE dos CDs fulfillment dos 3 marketplaces para a tabela
// estoque_fulfillment (base do motor de reposicao).
//
// v3 (31/ago MULTI-CONTA): Amazon e ML rodam para TODAS as contas conectadas
//   (antes: primeiro token que aparecesse). O shop_id gravado passa a ser o da
//   CONTA (Amazon: oauth_tokens_amazon.shop_id sintetico 900001/900002;
//   ML: user_id da conta). `ml_full_itens` ganhou user_id — e assim a fase de
//   stock sabe com qual token consultar cada item. Linhas antigas com
//   shop_id=0 foram migradas (900001 / 1107117809).
//
// v2 (FIX ML SKU): o ML devolve o SKU do vendedor em attributes[SELLER_SKU],
//   NAO em seller_custom_field. Itens com variacoes: cada variacao tem
//   inventory_id e SKU proprios; cacheadas como item_id = "MLBxxxx#variationId".
//
// Modulos:
//   ?modulo=amazon                 -> FBA Inventory (paginado, warehouse=FBA)
//   ?modulo=ml[&max=N]             -> itens Full: cache (ml_full_itens) + stock de todos
//   ?modulo=shopee&loja=ottz|svl   -> SBS get_current_inventory (por armazem)
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SPAPI_HOST = "https://sellingpartnerapi-na.amazon.com";
const ML_HOST = "https://api.mercadolibre.com";
const SHOPEE_HOST = "https://partner.shopeemobile.com";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any): number => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

function normalizarSku(sku: string | null | undefined): string | null {
  if (!sku) return null;
  let s = String(sku).trim();
  s = s.replace(/^FBA[-_]/i, "");
  s = s.replace(/[-_]FBA$/i, "");
  return s || null;
}

// v2: o SKU do vendedor no ML vive em attributes[SELLER_SKU]
function skuDoML(obj: any): string | null {
  const attrs = Array.isArray(obj?.attributes) ? obj.attributes : [];
  const attr = attrs.find((a: any) => String(a?.id || "").toUpperCase() === "SELLER_SKU");
  const doAttr = attr?.value_name ?? attr?.values?.[0]?.name ?? null;
  return normalizarSku(doAttr) || normalizarSku(obj?.seller_custom_field);
}

// ---- v4: em trânsito da Amazon pelos envios (v0 Fulfillment Inbound) ----
const STATUS_A_CAMINHO = ["SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING"];
const JANELA_TRANSITO_DIAS = 45;

/** "FBA STA (09/23/2026 18:57)-XCV9" → Date (MM/DD/AAAA, como o Send to Amazon nomeia). */
function dataDoNomeEnvio(nome: string): Date | null {
  const m = String(nome ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])));
  return isNaN(d.getTime()) ? null : d;
}

async function amzGet(token: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${SPAPI_HOST}${path}`, { headers: { "x-amz-access-token": token, "Accept": "application/json" } });
  const txt = await r.text();
  let body: any = null;
  try { body = JSON.parse(txt); } catch { body = { _raw: txt.substring(0, 300) }; }
  return { status: r.status, body };
}

/** Lista envios (v0) com paginação. null = sem permissão. */
async function listarEnvios(token: string, mkt: string, filtro: string, ate: number): Promise<any[] | null> {
  const out: any[] = [];
  let next: string | null = null;
  for (let pag = 0; pag < 20; pag++) {
    if (Date.now() > ate) throw new Error("tempo");
    const path = next
      ? `/fba/inbound/v0/shipments?MarketplaceId=${mkt}&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(next)}`
      : `/fba/inbound/v0/shipments?MarketplaceId=${mkt}&${filtro}`;
    const r = await amzGet(token, path);
    if (r.status === 403) return null;
    if (r.status === 429) { await sleep(1500); pag--; continue; }
    if (r.status !== 200) throw new Error(`envios HTTP ${r.status}`);
    out.push(...(r.body?.payload?.ShipmentData ?? []));
    next = r.body?.payload?.NextToken ?? null;
    if (!next) break;
    await sleep(600);
  }
  return out;
}

type Transito = { porSku: Map<string, number>; envios: number; antigos: number; detalhe: any[] };
/** Em trânsito real por SKU da Amazon (enviado − recebido), só envios a caminho dos últimos 45 dias. */
async function transitoPorEnvios(token: string, mkt: string, ate: number): Promise<Transito | null> {
  const ativos = await listarEnvios(token, mkt, `QueryType=SHIPMENT&ShipmentStatusList=${STATUS_A_CAMINHO.join(",")}`, ate);
  if (ativos === null) return null;
  const desde = new Date(Date.now() - JANELA_TRANSITO_DIAS * 86400000);
  // só para envio sem data no nome: atualizado nos últimos 45 dias
  let recentes: Set<string> | null = null;
  const semData = ativos.filter((e) => !dataDoNomeEnvio(e.ShipmentName));
  if (semData.length) {
    const upd = await listarEnvios(token, mkt,
      `QueryType=DATE_RANGE&LastUpdatedAfter=${encodeURIComponent(desde.toISOString())}&LastUpdatedBefore=${encodeURIComponent(new Date().toISOString())}`, ate);
    recentes = new Set((upd ?? []).map((e: any) => String(e.ShipmentId)));
  }
  const porSku = new Map<string, number>();
  const detalhe: any[] = [];
  let envios = 0, antigos = 0;
  for (const e of ativos) {
    const id = String(e.ShipmentId);
    const criado = dataDoNomeEnvio(e.ShipmentName);
    const dentro = criado ? criado >= desde : (recentes?.has(id) ?? false);
    if (!dentro) { antigos++; detalhe.push({ id, nome: e.ShipmentName, status: e.ShipmentStatus, contado: false }); continue; }
    if (Date.now() > ate) throw new Error("tempo");
    let r = await amzGet(token, `/fba/inbound/v0/shipments/${id}/items?MarketplaceId=${mkt}`);
    if (r.status === 429) { await sleep(1500); r = await amzGet(token, `/fba/inbound/v0/shipments/${id}/items?MarketplaceId=${mkt}`); }
    if (r.status !== 200) throw new Error(`itens do envio ${id}: HTTP ${r.status}`);
    let falta = 0;
    for (const it of (r.body?.payload?.ItemData ?? [])) {
      const pend = Math.max(0, num(it.QuantityShipped) - num(it.QuantityReceived));
      if (pend > 0 && it.SellerSKU) { porSku.set(String(it.SellerSKU), (porSku.get(String(it.SellerSKU)) ?? 0) + pend); falta += pend; }
    }
    envios++;
    detalhe.push({ id, nome: e.ShipmentName, status: e.ShipmentStatus, contado: true, a_caminho: falta });
    await sleep(350); // limite da Amazon: 2/s com rajada de 30
  }
  return { porSku, envios, antigos, detalhe };
}

serve(async (req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "";
  const inicio = Date.now();
  const TIMEOUT_MS = 48000;

  async function logErro(etapa: string, resultado: any) {
    await supabase.from("debug_fulfillment").insert({
      modulo: `sync-${modulo}`, etapa, status_http: null, resultado,
    });
  }

  // ==========================================================================
  // AMAZON: FBA Inventory summaries (paginado) — v3: TODAS as contas
  // ==========================================================================
  if (modulo === "amazon") {
    const { data: contas } = await supabase
      .from("oauth_tokens_amazon")
      .select("seller_id, empresa, access_token, marketplace_id, shop_id");
    const comToken = (contas || []).filter((c: any) => c.access_token);
    if (comToken.length === 0) { await logErro("token", { erro: "sem access_token" }); return Response.json({ ok: false, erro: "sem token" }); }

    const dePara = new Map<string, string>();
    const { data: maps } = await supabase.from("sku_mapeamento")
      .select("sku_origem, sku_correto").eq("marketplace", "amazon");
    for (const m of (maps || [])) if (m.sku_origem && m.sku_correto) dePara.set(String(m.sku_origem), String(m.sku_correto));
    const resolverSku = (cru: string | null) => cru ? (dePara.get(String(cru).trim()) ?? normalizarSku(cru)) : null;

    const porConta: any[] = [];
    const orcamentoPorConta = Math.floor(TIMEOUT_MS / comToken.length);

    for (let ci = 0; ci < comToken.length; ci++) {
      const conta = comToken[ci];
      const deadline = inicio + orcamentoPorConta * (ci + 1);
      const mkt = conta.marketplace_id || "A2Q3Y263D00KWC";
      const shopId = Number(conta.shop_id ?? 0);

      // v4: em trânsito pelos envios (até ~65% do tempo que resta à conta); sem permissão/tempo = regra A
      let transito: Transito | null = null;
      let modoTransito = "envios";
      try {
        transito = await transitoPorEnvios(conta.access_token, mkt, Date.now() + Math.max(0, deadline - Date.now()) * 0.65);
        if (!transito) modoTransito = "sem_permissao_envios";
      } catch (err) {
        modoTransito = `falhou_envios: ${(err as Error).message.substring(0, 80)}`;
        transito = null;
      }

      let nextToken: string | null = null;
      let salvos = 0, paginas = 0;
      const erros: string[] = [];

      do {
        if (Date.now() > deadline) { erros.push("timeout"); break; }
        const u = new URL(`${SPAPI_HOST}/fba/inventory/v1/summaries`);
        u.searchParams.set("granularityType", "Marketplace");
        u.searchParams.set("granularityId", mkt);
        u.searchParams.set("marketplaceIds", mkt);
        u.searchParams.set("details", "true");
        if (nextToken) u.searchParams.set("nextToken", nextToken);
        let payload: any = null;
        try {
          const r = await fetch(u.toString(), { headers: { "x-amz-access-token": conta.access_token, "Accept": "application/json" } });
          const txt = await r.text();
          try { payload = JSON.parse(txt); } catch { payload = { _raw: txt.substring(0, 400) }; }
          if (!r.ok) { erros.push(`HTTP ${r.status}`); await logErro(`${conta.empresa}-pagina-${paginas}`, payload); break; }
        } catch (err) { erros.push((err as Error).message); break; }

        const resumo = payload?.payload?.inventorySummaries || [];
        nextToken = payload?.pagination?.nextToken || null;
        paginas++;

        const linhas = resumo.map((s: any) => {
          const det = s.inventoryDetails || {};
          // v4: envios criados e não despachados (inboundWorking) não estão a caminho
          const inbound = transito
            ? (transito.porSku.get(String(s.sellerSku ?? "")) ?? 0)
            : num(det.inboundShippedQuantity) + num(det.inboundReceivingQuantity);
          return {
            marketplace: "amazon", shop_id: shopId,
            sku_marketplace: String(s.sellerSku || s.fnSku || s.asin || ""),
            warehouse: "FBA",
            sku: resolverSku(s.sellerSku),
            titulo: s.productName || null,
            sellable: num(det.fulfillableQuantity),
            reserved: num(det.reservedQuantity?.totalReservedQuantity),
            in_transit: inbound,
            unsellable: num(det.unfulfillableQuantity?.totalUnfulfillableQuantity),
            atualizado_em: new Date().toISOString(),
          };
        }).filter((l: any) => l.sku_marketplace);

        if (linhas.length > 0) {
          const { error } = await supabase.from("estoque_fulfillment")
            .upsert(linhas, { onConflict: "marketplace,shop_id,sku_marketplace,warehouse" });
          if (error) erros.push(`upsert: ${error.message.substring(0, 60)}`);
          else salvos += linhas.length;
        }
        await sleep(600);
      } while (nextToken);

      porConta.push({
        empresa: conta.empresa, shop_id: shopId, paginas, skus_salvos: salvos, erros: erros.slice(0, 3),
        transito: { modo: transito ? "envios" : modoTransito, envios_contados: transito?.envios ?? null, envios_antigos_ignorados: transito?.antigos ?? null },
      });
      if (transito) await logErro(`transito-${shopId}`, { envios: transito.detalhe, por_sku: Object.fromEntries(transito.porSku) });
    }

    return Response.json({ modulo, contas: porConta, tempo_ms: Date.now() - inicio });
  }

  // ==========================================================================
  // ML: fase 1 cacheia/corrige itens Full (multiget), fase 2 stock (rotativo)
  // v3: roda para todas as contas; cache guarda o dono (user_id)
  // ==========================================================================
  if (modulo === "ml") {
    const { data: toks } = await supabase
      .from("oauth_tokens_ml")
      .select("user_id, access_token, expires_at")
      .order("user_id", { ascending: true });
    const contas = (toks || []).filter((t: any) => t.access_token && new Date(t.expires_at) > new Date());
    if (contas.length === 0) { await logErro("token", { erro: "sem access_token valido" }); return Response.json({ ok: false, erro: "sem token" }); }

    const tokenPorConta = new Map<number, string>();
    for (const t of contas) tokenPorConta.set(Number(t.user_id), t.access_token);

    const erros: string[] = [];
    let cacheados = 0;
    const itensFullPorConta: any[] = [];

    // ---- Fase 1 (por conta): lista itens Full + multiget dos sem SKU
    const fase1Deadline = inicio + TIMEOUT_MS * 0.55;
    const fase1PorConta = (fase1Deadline - inicio) / contas.length;

    for (let ci = 0; ci < contas.length; ci++) {
      const tok = contas[ci];
      const H = { Authorization: `Bearer ${tok.access_token}` };
      const deadlineConta = inicio + fase1PorConta * (ci + 1);

      const idsFull: string[] = [];
      let offset = 0;
      while (Date.now() < inicio + fase1PorConta * ci + fase1PorConta * 0.4) {
        try {
          const r = await fetch(`${ML_HOST}/users/${tok.user_id}/items/search?logistic_type=fulfillment&limit=50&offset=${offset}`, { headers: H });
          const p = await r.json();
          const lote = p?.results || [];
          idsFull.push(...lote);
          const total = p?.paging?.total || 0;
          offset += 50;
          if (offset >= total || lote.length === 0) break;
        } catch (err) { erros.push(`search ${tok.user_id}: ${(err as Error).message.substring(0, 60)}`); break; }
        await sleep(250);
      }

      // v2: reprocessa tambem os JA cacheados que estao sem sku
      const { data: cacheRows } = await supabase.from("ml_full_itens").select("item_id, sku").eq("user_id", tok.user_id);
      const comSku = new Set((cacheRows || []).filter((r: any) => r.sku).map((r: any) => String(r.item_id).split("#")[0]));
      const aBuscar = idsFull.filter((id) => !comSku.has(id));

      for (let i = 0; i < aBuscar.length && Date.now() < deadlineConta; i += 20) {
        const lote = aBuscar.slice(i, i + 20);
        try {
          const r = await fetch(
            `${ML_HOST}/items?ids=${lote.join(",")}&attributes=id,inventory_id,seller_custom_field,title,attributes,variations`,
            { headers: H },
          );
          const arr = await r.json();
          const linhas: any[] = [];
          for (const x of (Array.isArray(arr) ? arr : [])) {
            const b = x?.body;
            if (!b?.id) continue;
            const variacoes = Array.isArray(b.variations) ? b.variations : [];
            const comInvId = variacoes.filter((v: any) => v?.inventory_id);
            if (comInvId.length > 0) {
              for (const v of comInvId) {
                linhas.push({
                  item_id: `${b.id}#${v.id}`,
                  inventory_id: v.inventory_id,
                  sku: skuDoML(v) || skuDoML(b),
                  titulo: b.title || null,
                  user_id: tok.user_id,
                  atualizado_em: new Date().toISOString(),
                });
              }
            } else {
              linhas.push({
                item_id: b.id,
                inventory_id: b.inventory_id || null,
                sku: skuDoML(b),
                titulo: b.title || null,
                user_id: tok.user_id,
                atualizado_em: new Date().toISOString(),
              });
            }
          }
          if (linhas.length > 0) {
            const { error } = await supabase.from("ml_full_itens").upsert(linhas, { onConflict: "item_id" });
            if (error) erros.push(`cache upsert: ${error.message.substring(0, 60)}`);
            else cacheados += linhas.length;
          }
        } catch (err) { erros.push(`multiget: ${(err as Error).message.substring(0, 60)}`); }
        await sleep(300);
      }

      itensFullPorConta.push({ user_id: tok.user_id, itens_full: idsFull.length, a_buscar: aBuscar.length });
    }

    // ---- Fase 2 (v5): stock de TODOS os estoques do Full, 6 em paralelo, gravação em lote.
    // Um inventory_id pode servir a vários anúncios (anúncio normal + catálogo): lê uma vez só.
    // Ordem: primeiro quem vendeu pelo Full depois da última leitura, depois os mais antigos.
    // `limite` (antigo, cron/tela mandam 120) é ignorado; `max` limita, se precisar.
    const maxInv = parseInt(url.searchParams.get("max") || "0", 10) || Infinity;
    const { data: cacheStock } = await supabase
      .from("ml_full_itens")
      .select("item_id, inventory_id, sku, titulo, user_id, stock_atualizado_em")
      .not("inventory_id", "is", null)
      .limit(5000);
    type Inv = { inventory_id: string; user_id: number; sku: string | null; titulo: string | null; itens: string[]; lido_em: number };
    const porInv = new Map<string, Inv>();
    for (const r of (cacheStock || [])) {
      const chave = `${r.user_id}|${r.inventory_id}`;
      const lido = r.stock_atualizado_em ? new Date(r.stock_atualizado_em).getTime() : 0;
      const atual = porInv.get(chave);
      if (!atual) {
        porInv.set(chave, { inventory_id: String(r.inventory_id), user_id: Number(r.user_id), sku: r.sku ?? null, titulo: r.titulo ?? null, itens: [r.item_id], lido_em: lido });
      } else {
        atual.itens.push(r.item_id);
        if (!atual.sku && r.sku) atual.sku = r.sku;
        if (!atual.titulo && r.titulo) atual.titulo = r.titulo;
        atual.lido_em = Math.min(atual.lido_em, lido);
      }
    }

    // vendas pelo Full nos últimos 3 dias, por SKU (2 consultas, sem laço por item)
    const ultimaVenda = new Map<string, number>();
    {
      const { data: peds } = await supabase.from("pedidos")
        .select("id, data_pedido")
        .eq("marketplace", "mercadolivre").eq("logistica_tipo", "fulfillment")
        .gte("data_pedido", new Date(Date.now() - 3 * 86400000).toISOString())
        .limit(2000);
      const dataPorPedido = new Map<string, number>((peds || []).map((p: any) => [String(p.id), new Date(p.data_pedido).getTime()]));
      const ids = [...dataPorPedido.keys()];
      for (let i = 0; i < ids.length; i += 200) {
        const { data: its } = await supabase.from("pedido_itens").select("pedido_id, sku_filho, sku_pai").in("pedido_id", ids.slice(i, i + 200));
        for (const it of (its || [])) {
          const t = dataPorPedido.get(String(it.pedido_id)) ?? 0;
          for (const s of [it.sku_filho, it.sku_pai]) {
            const n = normalizarSku(s);
            if (n && t > (ultimaVenda.get(n) ?? 0)) ultimaVenda.set(n, t);
          }
        }
      }
    }
    const vendeuDepois = (v: Inv) => !!v.sku && (ultimaVenda.get(v.sku) ?? 0) > v.lido_em;
    const fila = [...porInv.values()]
      .sort((a, b) => (Number(vendeuDepois(b)) - Number(vendeuDepois(a))) || (a.lido_em - b.lido_em))
      .slice(0, maxInv);
    const prioritarios = fila.filter(vendeuDepois).length;

    let stockOk = 0, semTokenDaConta = 0, estoquesLidos = 0;
    const PARALELO = 6;
    async function lerStock(v: Inv): Promise<any | null> {
      const tokenItem = tokenPorConta.get(v.user_id);
      if (!tokenItem) { semTokenDaConta++; return null; }
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        try {
          const r = await fetch(`${ML_HOST}/inventories/${v.inventory_id}/stock/fulfillment`, { headers: { Authorization: `Bearer ${tokenItem}` } });
          if (r.status === 429 || r.status >= 500) { await sleep(1200); continue; }
          if (!r.ok) { erros.push(`stock ${v.inventory_id}: HTTP ${r.status}`); return null; }
          return await r.json();
        } catch (err) {
          if (tentativa === 1) erros.push(`stock ${v.inventory_id}: ${(err as Error).message.substring(0, 50)}`);
          await sleep(500);
        }
      }
      erros.push(`stock ${v.inventory_id}: sem resposta`);
      return null;
    }

    for (let i = 0; i < fila.length; i += PARALELO) {
      if (Date.now() - inicio > TIMEOUT_MS) { erros.push(`timeout stock (faltaram ${fila.length - i})`); break; }
      const lote = fila.slice(i, i + PARALELO);
      const resp = await Promise.all(lote.map(lerStock));
      const agora = new Date().toISOString();
      const linhas: any[] = [];
      const itensOk: string[] = [];
      lote.forEach((v, k) => {
        const p = resp[k];
        if (!p) return;
        estoquesLidos++;
        linhas.push({
          marketplace: "mercadolivre", shop_id: v.user_id,
          sku_marketplace: v.inventory_id,
          warehouse: "MELI",
          sku: v.sku,
          titulo: v.titulo,
          sellable: num(p?.available_quantity),
          reserved: 0,
          in_transit: 0,
          unsellable: num(p?.not_available_quantity),
          atualizado_em: agora,
        });
        itensOk.push(...v.itens);
      });
      if (linhas.length) {
        const { error } = await supabase.from("estoque_fulfillment")
          .upsert(linhas, { onConflict: "marketplace,shop_id,sku_marketplace,warehouse" });
        if (error) erros.push(`upsert: ${error.message.substring(0, 60)}`);
        else {
          stockOk += linhas.length;
          const { error: e2 } = await supabase.from("ml_full_itens").update({ stock_atualizado_em: agora }).in("item_id", itensOk);
          if (e2) erros.push(`cache stamp: ${e2.message.substring(0, 60)}`);
        }
      }
      await sleep(120);
    }

    return Response.json({ modulo, versao: 5, contas: itensFullPorConta, novos_no_cache: cacheados, estoques_na_fila: fila.length, prioritarios_vendidos: prioritarios, estoques_lidos: estoquesLidos, stock_atualizados: stockOk, sem_token_da_conta: semTokenDaConta, erros: erros.slice(0, 6), tempo_ms: Date.now() - inicio });
  }

  // ==========================================================================
  // SHOPEE: SBS get_current_inventory paginado (whs_region=BR)
  // ==========================================================================
  if (modulo === "shopee") {
    const lojaParam = url.searchParams.get("loja") || "ottz";
    const shopId = lojaParam === "svl" ? 759046323 : 522186766;
    const { data: tokRow } = await supabase
      .from("oauth_tokens_shopee")
      .select("access_token, shop_id, partner_id")
      .eq("shop_id", shopId)
      .single();
    if (!tokRow?.access_token) { await logErro("token", { erro: `sem token shop ${shopId}` }); return Response.json({ ok: false }); }

    const partnerId = Number(tokRow.partner_id);
    const partnerKey = (partnerId === 2034179 ? Deno.env.get("SHOPEE_PARTNER_KEY") : Deno.env.get("SHOPEE_PARTNER_KEY_SVL")) || "";

    const skuPorModel = new Map<string, string>();
    const skuPorItem = new Map<string, string>();
    {
      const { data: vars } = await supabase.from("shopee_anuncios_variacao")
        .select("model_id, sku").eq("shop_id", shopId).limit(5000);
      for (const v of (vars || [])) if (v.sku) skuPorModel.set(String(v.model_id), String(v.sku));
      const { data: anun } = await supabase.from("shopee_anuncios")
        .select("item_id, sku_pai").eq("shop_id", shopId).limit(5000);
      for (const a of (anun || [])) if (a.sku_pai) skuPorItem.set(String(a.item_id), String(a.sku_pai));
    }

    async function sbsGet(path: string, extra: Record<string, string>) {
      const timestamp = Math.floor(Date.now() / 1000);
      const base = `${partnerId}${path}${timestamp}${tokRow.access_token}${shopId}`;
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", enc.encode(partnerKey.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(base));
      const sign = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const u = new URL(`${SHOPEE_HOST}${path}`);
      u.searchParams.set("partner_id", String(partnerId));
      u.searchParams.set("timestamp", String(timestamp));
      u.searchParams.set("access_token", tokRow.access_token);
      u.searchParams.set("shop_id", String(shopId));
      u.searchParams.set("sign", sign);
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
      const r = await fetch(u.toString());
      const txt = await r.text();
      try { return { status: r.status, payload: JSON.parse(txt) }; } catch { return { status: r.status, payload: { _raw: txt.substring(0, 400) } }; }
    }

    let salvos = 0, pagina = 1;
    const erros: string[] = [];
    while (pagina <= 20 && Date.now() - inicio < TIMEOUT_MS) {
      const res = await sbsGet("/api/v2/sbs/get_current_inventory", { whs_region: "BR", page_no: String(pagina), page_size: "50" });
      if (res.payload?.error) { erros.push(String(res.payload.error).substring(0, 60)); await logErro(`pagina-${pagina}`, res.payload); break; }
      const itens = res.payload?.response?.item_list || [];
      if (itens.length === 0) break;

      const linhas: any[] = [];
      for (const it of itens) {
        for (const skuInfo of (it.sku_list || [])) {
          const shopModelId = String(skuInfo.shop_sku_list?.[0]?.shop_model_id || "");
          const shopItemId = String(skuInfo.shop_sku_list?.[0]?.shop_item_id || "");
          const skuInterno = skuPorModel.get(shopModelId) || skuPorItem.get(shopItemId) || null;
          for (const whs of (skuInfo.whs_list || [])) {
            linhas.push({
              marketplace: "shopee", shop_id: shopId,
              sku_marketplace: String(skuInfo.mtsku_id || skuInfo.model_id || ""),
              warehouse: String(whs.whs_id || "BR"),
              sku: skuInterno,
              titulo: [it.item_name, skuInfo.model_name].filter(Boolean).join(" - ").substring(0, 200) || null,
              sellable: num(whs.sellable_qty),
              reserved: num(whs.reserved_qty),
              in_transit: num(whs.in_transit_pending_putaway_qty),
              unsellable: num(whs.unsellable_qty),
              atualizado_em: new Date().toISOString(),
            });
          }
        }
      }
      const unicas = Array.from(new Map(linhas.filter((l) => l.sku_marketplace).map((l) => [`${l.sku_marketplace}|${l.warehouse}`, l])).values());
      if (unicas.length > 0) {
        const { error } = await supabase.from("estoque_fulfillment")
          .upsert(unicas, { onConflict: "marketplace,shop_id,sku_marketplace,warehouse" });
        if (error) erros.push(`upsert: ${error.message.substring(0, 60)}`);
        else salvos += unicas.length;
      }
      pagina++;
      await sleep(400);
    }

    return Response.json({ modulo, loja: lojaParam, paginas: pagina - 1, linhas_salvas: salvos, erros: erros.slice(0, 3), tempo_ms: Date.now() - inicio });
  }

  return Response.json({ modulos: ["amazon", "ml (limite)", "shopee (loja)"], nota: "sincroniza estoque_fulfillment" });
});
