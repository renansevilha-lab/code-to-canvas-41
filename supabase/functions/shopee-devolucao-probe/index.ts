// ============================================================================
// Returns Shopee -> tabela shopee_devolucoes (motivo/texto/fotos/rastreio reverso).
// modulo=sync [&shop_id=][&dias=14 | &desde=YYYY-MM-DD] -> lista e faz upsert (janelas encadeadas de 15d)
// modulo=detalhar [&max=80] -> get_return_detail dos que estao na fila
//   (view_shopee_devolucoes_a_detalhar): disputa, solucao, logistica reversa,
//   compensacao ao vendedor, responsavel pelo frete. (v19, 24/set)
// modulo=escrow [&max=200] -> escrow ATUAL dos pedidos devolvidos (get_escrow_detail_batch,
//   50/chamada) em colunas esc_* da propria shopee_devolucoes (quem bancou o reembolso). (v20)
// modulo=rastreio-ida [&max=150] | &order_sn=X (cru, debug) -> logistics.get_tracking_info da ENTREGA
//   ORIGINAL dos pedidos so-reembolso (fila view_shopee_devolucoes_a_rastrear): falha na entrega,
//   entregue ao comprador, devolvido ao vendedor. (v21, 25/set; v22 classifica pelo codigo do evento)
// modulo=return-list | return-detail&return_sn=... -> debug/leitura
// modulo=escrow-cru&order_sn=... -> get_escrow_detail com campos nao-zero (v13,
//   auditoria de taxas — ex.: conferir se o Shopee Acelera cobra algo escondido)
//
// v11 (27/ago) — modulo=motivos-disputa&return_sn=X (get_return_dispute_reason):
//  a Shopee diz quais motivos valem PARA AQUELA solicitacao. DESCOBERTA ao vivo:
//  NOT_RECEIPT ("nao recebi") volta VAZIO = sem disputa via API (a Shopee decide
//  pelo rastreio; contestar so no Seller Center). Casos com produto voltando
//  retornam motivos 53/55 com evidencia OBRIGATORIA (evidence_module_list).
//
// v12 (27/ago) — contrato CORRETO do dispute (conferido no SDK congminh1254):
//  - dispute: { return_sn, email, dispute_reason_id, dispute_text_reason?,
//      image_list?: [{ module_index, requirement, image_url: string[] }] }
//  - modulo=converter-imagem (POST {return_sn, imagem_base64, mime?}):
//    /returns/convert_image em multipart (campo upload_image) -> {url,thumbnail}.
//  Sem &confirmar=1 os writes so MOSTRAM o payload. WRITE nunca testado ao vivo.
//
// v26 (18/out/2026) — detalhar grava prazo_disputa (seller_compensation.seller_compensation_due_date):
//  o "disputa ate dd-mm" do Seller Center. O due_date (abertura + 2 dias) vencia um dia antes e o app
//  tirava a devolucao aceita da aba "abertas" ainda dentro do prazo de disputa.
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPEE_HOST = Deno.env.get("SHOPEE_HOST") || "https://partner.shopeemobile.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const JANELA = 15 * 86400; // limite da Returns API por chamada

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
interface LojaCtx { shopId: number; partnerId: number; partnerKey: string; accessToken: string; }
async function shopeeUrl(ctx: LojaCtx, apiPath: string, params: Record<string, any> = {}): Promise<URL> {
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacSha256(`${ctx.partnerId}${apiPath}${ts}${ctx.accessToken}${ctx.shopId}`, ctx.partnerKey);
  const url = new URL(`${SHOPEE_HOST}${apiPath}`);
  url.searchParams.set("partner_id", String(ctx.partnerId));
  url.searchParams.set("timestamp", String(ts));
  url.searchParams.set("access_token", ctx.accessToken);
  url.searchParams.set("shop_id", String(ctx.shopId));
  url.searchParams.set("sign", sign);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  return url;
}
async function shopeeGet(ctx: LojaCtx, apiPath: string, params: Record<string, any> = {}): Promise<any> {
  const url = await shopeeUrl(ctx, apiPath, params);
  const resp = await fetch(url.toString());
  const text = await resp.text();
  let js: any = null; try { js = JSON.parse(text); } catch { /* noop */ }
  return { http: resp.status, body: js ?? text };
}
async function shopeePost(ctx: LojaCtx, apiPath: string, body: Record<string, any>): Promise<any> {
  const url = await shopeeUrl(ctx, apiPath);
  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let js: any = null; try { js = JSON.parse(text); } catch { /* noop */ }
  return { http: resp.status, body: js ?? text };
}
/** POST multipart (convert_image exige arquivo, nao JSON). */
async function shopeePostForm(ctx: LojaCtx, apiPath: string, form: FormData): Promise<any> {
  const url = await shopeeUrl(ctx, apiPath);
  const resp = await fetch(url.toString(), { method: "POST", body: form });
  const text = await resp.text();
  let js: any = null; try { js = JSON.parse(text); } catch { /* noop */ }
  return { http: resp.status, body: js ?? text };
}
async function pegarCtxs(supabase: ReturnType<typeof createClient>, shopId?: number): Promise<LojaCtx[]> {
  let q = supabase.from("oauth_tokens_shopee").select("shop_id, partner_id, access_token, expires_at");
  if (shopId) q = q.eq("shop_id", shopId);
  const { data, error } = await q;
  if (error || !data || data.length === 0) throw new Error("Token Shopee nao encontrado");
  return (data as any[]).map((row) => { const c = getCredentials(row.partner_id); return { shopId: row.shop_id, partnerId: c.partner_id, partnerKey: c.partner_key, accessToken: row.access_token }; });
}
function json(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } }); }

/** Loja dona do return_sn (espelho); cai na primeira se nao achar. */
async function ctxDoReturn(
  supabase: ReturnType<typeof createClient>, ctxs: LojaCtx[], returnSn: string,
): Promise<LojaCtx> {
  const { data } = await supabase.from("shopee_devolucoes")
    .select("shop_id").eq("return_sn", returnSn).maybeSingle();
  if (data?.shop_id) {
    const hit = ctxs.find((c) => c.shopId === data.shop_id);
    if (hit) return hit;
  }
  return ctxs[0];
}

function mapItens(item: any): any[] {
  if (!Array.isArray(item)) return [];
  return item.map((i: any) => ({
    sku: i.model_sku || i.item_sku || null,
    nome: i.name ?? null,
    qtd: i.amount ?? null,
    preco: i.item_price ?? null,
  }));
}

/** v19: campos do get_return_detail que o espelho guarda (sem endereco/PII). */
function mapDetalhe(d: any): Record<string, any> {
  const vazio = (v: any) => v === undefined || v === null || v === "";
  const lista = (v: any) => (Array.isArray(v) && v.length ? v : null);
  return {
    status: d.status ?? undefined,
    refund_amount: d.refund_amount ?? undefined,
    solucao: typeof d.return_solution === "number" ? d.return_solution : null,
    tipo_reembolso: vazio(d.return_refund_type) ? null : d.return_refund_type,
    disputa_motivo: lista(d.dispute_reason),
    disputa_texto: lista(d.dispute_text_reason),
    logistica_reversa: vazio(d.reverse_logistics_status) ? null : d.reverse_logistics_status,
    logistica_status: vazio(d.logistics_status) ? null : d.logistics_status,
    compensacao_status: vazio(d.seller_compensation?.seller_compensation_status) ? null : d.seller_compensation.seller_compensation_status,
    compensacao_valor: d.seller_compensation?.compensation_amount ?? null,
    // v26 (18/out/2026): prazo para o vendedor disputar o reembolso aceito — é o "disputa até" do Seller
    // Center. O due_date é outro prazo (abertura + 2 dias) e vencia um dia antes.
    prazo_disputa: Number(d.seller_compensation?.seller_compensation_due_date) > 0
      ? new Date(Number(d.seller_compensation.seller_compensation_due_date) * 1000).toISOString() : null,
    frete_responsavel: vazio(d.shipping_fee_responsibility) ? null : d.shipping_fee_responsibility,
    frete_resp_motivo: vazio(d.shipping_fee_responsibility_reason) ? null : d.shipping_fee_responsibility_reason,
    valor_antes_desconto: d.amount_before_discount ?? null,
    reembolso_ajustado: typeof d.is_refund_amount_adjusted === "boolean" ? d.is_refund_amount_adjusted : null,
    negociacao_status: vazio(d.negotiation?.negotiation_status) ? null : d.negotiation.negotiation_status,
    prova_status: vazio(d.seller_proof?.seller_proof_status) ? null : d.seller_proof.seller_proof_status,
    validacao: vazio(d.validation_type) ? null : d.validation_type,
    chegou_armazem: d.is_arrived_at_warehouse == null ? null : !!d.is_arrived_at_warehouse,
    update_time: d.update_time ? new Date(d.update_time * 1000).toISOString() : undefined,
    detalhe_em: new Date().toISOString(),
  };
}

async function syncLoja(supabase: ReturnType<typeof createClient>, ctx: LojaCtx, inicioEpoch: number) {
  const now = Math.floor(Date.now() / 1000);
  let upserted = 0; const erros: string[] = []; let paginas = 0; let janelas = 0;
  for (let start = inicioEpoch; start < now; start += JANELA) {
    const to = Math.min(start + JANELA, now);
    janelas++;
    for (let page = 0; page < 12; page++) {
      const r = await shopeeGet(ctx, "/api/v2/returns/get_return_list", { page_no: page, page_size: 50, create_time_from: start, create_time_to: to });
      if (r.body?.error) { erros.push(`${r.body.error}: ${r.body.message || ""}`); break; }
      const list = r.body?.response?.return || [];
      paginas++;
      const linhas = list.map((x: any) => ({
        return_sn: x.return_sn, order_sn: x.order_sn ?? null, shop_id: ctx.shopId,
        reason: x.reason ?? null, text_reason: x.text_reason ?? null, status: x.status ?? null,
        refund_amount: x.refund_amount ?? null, images: x.image ?? [],
        tem_video: Array.isArray(x.buyer_videos) && x.buyer_videos.length > 0,
        tracking_number: x.tracking_number || null,
        needs_logistics: typeof x.needs_logistics === "boolean" ? x.needs_logistics : null,
        due_date: x.due_date ? new Date(x.due_date * 1000).toISOString() : null,
        itens: mapItens(x.item),
        create_time: x.create_time ? new Date(x.create_time * 1000).toISOString() : null,
        update_time: x.update_time ? new Date(x.update_time * 1000).toISOString() : null,
        atualizado_em: new Date().toISOString(),
      })).filter((l: any) => l.return_sn);
      if (linhas.length) {
        const { error } = await supabase.from("shopee_devolucoes").upsert(linhas, { onConflict: "return_sn" });
        if (error) erros.push(error.message.slice(0, 80)); else upserted += linhas.length;
      }
      if (!r.body?.response?.more || list.length === 0) break;
    }
  }
  return { shop_id: ctx.shopId, janelas, paginas, upserted, erros };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return new Response("secrets ausentes", { status: 500, headers: CORS });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  let corpo: any = {};
  if (req.method === "POST") { try { corpo = await req.json(); } catch { corpo = {}; } }
  const par = (k: string): string | null => url.searchParams.get(k) ?? (corpo?.[k] != null ? String(corpo[k]) : null);
  const modulo = par("modulo") || "sync";
  const shopId = par("shop_id") ? parseInt(par("shop_id")!, 10) : undefined;
  const dias = Math.min(90, parseInt(par("dias") || "14", 10));
  let ctxs: LojaCtx[];
  try { ctxs = await pegarCtxs(supabase, shopId); } catch (e) { return json({ erro: (e as Error).message }, { status: 401 }); }

  try {
    if (modulo === "sync") {
      // v19: &desde=YYYY-MM-DD (backfill historico, sem o teto de 90 dias)
      const desde = par("desde");
      const inicioEpoch = desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)
        ? Math.floor(new Date(`${desde}T00:00:00-03:00`).getTime() / 1000)
        : Math.floor(Date.now() / 1000) - dias * 86400;
      const porLoja = [];
      for (const ctx of ctxs) porLoja.push(await syncLoja(supabase, ctx, inicioEpoch));
      return json({ modulo: "sync", dias, desde: desde || null, por_loja: porLoja });
    }
    if (modulo === "detalhar") {
      const inicio = Date.now();
      const ORCAMENTO = 25000;
      const max = Math.min(Math.max(parseInt(par("max") || "80", 10), 1), 300);
      const { data: fila, error } = await supabase.from("view_shopee_devolucoes_a_detalhar")
        .select("return_sn, shop_id").limit(max);
      if (error) return json({ erro: `fila: ${error.message}` }, { status: 500 });
      let feitos = 0; const erros: string[] = [];
      const lista = (fila || []) as any[];
      for (let i = 0; i < lista.length; i += 5) {
        if (Date.now() - inicio > ORCAMENTO) break;
        await Promise.all(lista.slice(i, i + 5).map(async (f) => {
          const ctx = ctxs.find((c) => c.shopId === Number(f.shop_id));
          if (!ctx) { erros.push(`${f.return_sn}: loja sem token`); return; }
          const r = await shopeeGet(ctx, "/api/v2/returns/get_return_detail", { return_sn: f.return_sn });
          const d = r.body?.response;
          if (r.body?.error || !d) {
            erros.push(`${f.return_sn}: ${r.body?.error || r.http} ${r.body?.message || ""}`.slice(0, 120));
            return;
          }
          const upd = mapDetalhe(d);
          for (const k of Object.keys(upd)) if (upd[k] === undefined) delete upd[k];
          const { error: eUp } = await supabase.from("shopee_devolucoes").update(upd).eq("return_sn", f.return_sn);
          if (eUp) erros.push(`${f.return_sn}: ${eUp.message.slice(0, 80)}`); else feitos++;
        }));
      }
      const { count: restantes } = await supabase.from("view_shopee_devolucoes_a_detalhar")
        .select("return_sn", { count: "exact", head: true });
      return json({ modulo, lidos: lista.length, detalhados: feitos, restantes, tempo_ms: Date.now() - inicio, erros: erros.slice(0, 8) });
    }
    if (modulo === "escrow") {
      const inicio = Date.now();
      const ORCAMENTO = 25000;
      const max = Math.min(Math.max(parseInt(par("max") || "200", 10), 1), 500);
      const { data: fila, error } = await supabase.from("view_shopee_devolucoes_a_escrow")
        .select("order_sn, shop_id").limit(max);
      if (error) return json({ erro: `fila: ${error.message}` }, { status: 500 });
      const porLoja = new Map<number, string[]>();
      for (const f of (fila || []) as any[]) {
        const k = Number(f.shop_id);
        if (!porLoja.has(k)) porLoja.set(k, []);
        porLoja.get(k)!.push(String(f.order_sn));
      }
      let gravados = 0, semRetorno = 0; const erros: string[] = []; let amostra: unknown = null;
      for (const [shop, ordens] of porLoja) {
        const ctx = ctxs.find((c) => c.shopId === shop);
        if (!ctx) { erros.push(`loja ${shop} sem token`); continue; }
        for (let i = 0; i < ordens.length; i += 50) {
          if (Date.now() - inicio > ORCAMENTO) { erros.push("orcamento"); break; }
          const lote = ordens.slice(i, i + 50);
          const r = await shopeePost(ctx, "/api/v2/payment/get_escrow_detail_batch", { order_sn_list: lote });
          if (r.body?.error) { erros.push(`${r.body.error}: ${r.body.message || ""}`.slice(0, 120)); continue; }
          const resp = r.body?.response;
          const itens: any[] = Array.isArray(resp) ? resp : (resp?.escrow_detail_list || resp?.list || []);
          if (!itens.length && !amostra) amostra = resp;
          const vistos = new Set<string>();
          for (const it of itens) {
            const det = it?.escrow_detail ?? it;
            const osn = det?.order_sn;
            const inc = det?.order_income;
            if (!osn || !inc) continue;
            vistos.add(String(osn));
            const n = (v: any) => (typeof v === "number" ? v : v == null ? null : Number(v));
            const { error: eUp } = await supabase.from("shopee_devolucoes").update({
              esc_escrow: n(inc.escrow_amount), esc_escrow_ajustado: n(inc.escrow_amount_after_adjustment),
              esc_reembolso_vendedor: n(inc.seller_return_refund), esc_drc: n(inc.drc_adjustable_refund),
              esc_frete_reverso: n(inc.reverse_shipping_fee), esc_preco_venda: n(inc.order_selling_price),
              esc_consultado_em: new Date().toISOString(),
            }).eq("order_sn", String(osn));
            if (eUp) erros.push(`${osn}: ${eUp.message.slice(0, 60)}`); else gravados++;
          }
          semRetorno += lote.filter((o) => !vistos.has(o)).length;
        }
      }
      const { count: restantes } = await supabase.from("view_shopee_devolucoes_a_escrow")
        .select("order_sn", { count: "exact", head: true });
      return json({ modulo, lidos: (fila || []).length, gravados, sem_retorno: semRetorno, restantes,
        tempo_ms: Date.now() - inicio, erros: erros.slice(0, 8), amostra_resposta: amostra });
    }
    if (modulo === "rastreio-ida") {
      const inicio = Date.now();
      const ORCAMENTO = 25000;
      const osnDebug = (par("order_sn") || "").trim();
      // v22: classifica pelo CODIGO do evento + frase final exata. Texto livre engana:
      //   "Nao conseguimos coletar: Remetente nao preparou" nao e devolucao nem falha de entrega.
      const ehDevolvido = (e: any) => /RETURN/i.test(e.logistics_status || "") || /^Pedido devolvido|devolvido ao (vendedor|remetente)/i.test(e.description || "");
      const ehFalha = (e: any) => /FAILED_DELIVER|DELIVERY_FAIL|LOST/i.test(e.logistics_status || "") || /tentativa de entrega|descartad|extraviad/i.test(e.description || "");
      const ehEntregue = (e: any) => /^DELIVERED$/i.test(e.logistics_status || "") || /^Pedido entregue/i.test(e.description || "");
      const ts = (v: any) => (v ? new Date(Number(v) * 1000).toISOString() : null);
      const ler = async (ctx: LojaCtx, osn: string) => {
        const r = await shopeeGet(ctx, "/api/v2/logistics/get_tracking_info", { order_sn: osn });
        return r;
      };
      if (osnDebug) {
        const { data: ped } = await supabase.from("pedidos").select("shop_id").eq("id", osnDebug).maybeSingle();
        const { data: dv } = await supabase.from("shopee_devolucoes").select("shop_id").eq("order_sn", osnDebug).limit(1).maybeSingle();
        const ctx = ctxs.find((c) => c.shopId === Number(ped?.shop_id ?? dv?.shop_id)) ?? ctxs[0];
        return json({ modulo, order_sn: osnDebug, shop_id: ctx.shopId, ...(await ler(ctx, osnDebug)) });
      }
      const max = Math.min(Math.max(parseInt(par("max") || "150", 10), 1), 400);
      const { data: fila, error } = await supabase.from("view_shopee_devolucoes_a_rastrear")
        .select("order_sn, shop_id").limit(max);
      if (error) return json({ erro: `fila: ${error.message}` }, { status: 500 });
      let feitos = 0; const erros: string[] = []; const porStatus: Record<string, number> = {};
      const lista = (fila || []) as any[];
      for (let i = 0; i < lista.length; i += 6) {
        if (Date.now() - inicio > ORCAMENTO) break;
        await Promise.all(lista.slice(i, i + 6).map(async (f) => {
          const ctx = ctxs.find((c) => c.shopId === Number(f.shop_id));
          if (!ctx) { erros.push(`${f.order_sn}: loja sem token`); return; }
          const r = await ler(ctx, f.order_sn);
          const resp = r.body?.response;
          if (r.body?.error || !resp) {
            erros.push(`${f.order_sn}: ${r.body?.error || r.http} ${r.body?.message || ""}`.slice(0, 120));
            await supabase.from("shopee_devolucoes").update({ ida_consultado_em: new Date().toISOString() }).eq("order_sn", f.order_sn);
            return;
          }
          const evs: any[] = (Array.isArray(resp.tracking_info) ? resp.tracking_info : [])
            .slice().sort((a: any, b: any) => Number(a.update_time || 0) - Number(b.update_time || 0));
          const primeiro = (f: (e: any) => boolean) => {
            const e = evs.find(f);
            return e ? ts(e.update_time) : null;
          };
          const ult = evs[evs.length - 1];
          const st = resp.logistics_status || null;
          porStatus[st || "?"] = (porStatus[st || "?"] || 0) + 1;
          const upd: Record<string, any> = {
            ida_status: st,
            ida_ultimo_evento: ult ? String(ult.description || ult.logistics_status || "").slice(0, 300) : null,
            ida_ultimo_em: ult ? ts(ult.update_time) : null,
            ida_falha_em: primeiro(ehFalha),
            ida_devolvido_em: primeiro(ehDevolvido),
            ida_entregue_em: primeiro(ehEntregue),
            ida_consultado_em: new Date().toISOString(),
          };
          const { error: eUp } = await supabase.from("shopee_devolucoes").update(upd).eq("order_sn", f.order_sn);
          if (eUp) erros.push(`${f.order_sn}: ${eUp.message.slice(0, 80)}`); else feitos++;
        }));
      }
      const { count: restantes } = await supabase.from("view_shopee_devolucoes_a_rastrear")
        .select("order_sn", { count: "exact", head: true });
      return json({ modulo, lidos: lista.length, gravados: feitos, restantes, status_ida: porStatus,
        tempo_ms: Date.now() - inicio, erros: erros.slice(0, 8) });
    }
    if (modulo === "return-list") {
      const now = Math.floor(Date.now() / 1000);
      const r = await shopeeGet(ctxs[0], "/api/v2/returns/get_return_list", { page_no: 0, page_size: 5, create_time_from: now - dias * 86400, create_time_to: now });
      return json({ modulo, shop_id: ctxs[0].shopId, ...r });
    }
    if (modulo === "return-detail") {
      const rsn = par("return_sn");
      if (!rsn) return new Response("Forneca ?return_sn=...", { status: 400, headers: CORS });
      const ctx = await ctxDoReturn(supabase, ctxs, rsn);
      const r = await shopeeGet(ctx, "/api/v2/returns/get_return_detail", { return_sn: rsn });
      return json({ modulo, shop_id: ctx.shopId, ...r });
    }

    // Escrow CRU de um pedido — auditoria de taxas: mostra TODOS os campos
    // nao-zero do order_income (pega taxa nova/escondida, ex. Shopee Acelera).
    if (modulo === "escrow-cru") {
      const osn = (par("order_sn") || "").trim();
      if (!osn) return json({ erro: "informe ?order_sn=..." }, { status: 400 });
      const { data: ped } = await supabase.from("pedidos").select("shop_id").eq("id", osn).maybeSingle();
      const ctx = ctxs.find((c) => c.shopId === Number(ped?.shop_id)) ?? ctxs[0];
      const r = await shopeeGet(ctx, "/api/v2/payment/get_escrow_detail", { order_sn: osn });
      const income = r.body?.response?.order_income ?? null;
      const naoZero: Record<string, unknown> = {};
      if (income && typeof income === "object") {
        for (const [k, v] of Object.entries(income)) {
          if (typeof v === "number" && v !== 0) naoZero[k] = v;
          else if (Array.isArray(v) && v.length > 0) naoZero[k] = v;
          else if (typeof v === "string" && v) naoZero[k] = v;
        }
      }
      return json({
        modulo, order_sn: osn, shop_id: ctx.shopId,
        error: r.body?.error || null, message: r.body?.message || null,
        campos_nao_zero: naoZero,
      });
    }

    // Motivos de disputa validos PARA a solicitacao (leitura).
    if (modulo === "motivos-disputa") {
      const rsn = (par("return_sn") || "").trim();
      if (!rsn) return json({ erro: "informe ?return_sn=..." }, { status: 400 });
      const ctx = await ctxDoReturn(supabase, ctxs, rsn);
      const r = await shopeeGet(ctx, "/api/v2/returns/get_return_dispute_reason", { return_sn: rsn });
      const lista = r.body?.response?.dispute_reason_list ?? [];
      return json({
        modulo, return_sn: rsn, shop_id: ctx.shopId,
        error: r.body?.error || null, message: r.body?.message || null,
        motivos: lista, disputa_disponivel: Array.isArray(lista) && lista.length > 0,
      });
    }

    // Converte UMA imagem (base64) em URL de evidencia da Shopee (convert_image).
    if (modulo === "converter-imagem") {
      const rsn = (par("return_sn") || "").trim();
      const b64 = (corpo?.imagem_base64 || "").trim();
      const mime = (corpo?.mime || "image/jpeg").trim();
      if (!rsn || !b64) return json({ erro: "POST {return_sn, imagem_base64[, mime]}" }, { status: 400 });
      const ctx = await ctxDoReturn(supabase, ctxs, rsn);
      const bin = Uint8Array.from(atob(b64.replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.set("return_sn", rsn);
      form.set("upload_image", new Blob([bin], { type: mime }), `evidencia.${mime.includes("png") ? "png" : "jpg"}`);
      const r = await shopeePostForm(ctx, "/api/v2/returns/convert_image", form);
      const ok = !r.body?.error && (r.body?.response?.url || r.body?.response?.thumbnail);
      return json({
        modulo, return_sn: rsn, ok: !!ok,
        url: r.body?.response?.url ?? null, thumbnail: r.body?.response?.thumbnail ?? null,
        error: r.body?.error || null, message: r.body?.message || null,
      }, { status: ok ? 200 : 502 });
    }

    // ---------------------------------------------------------- RESPONDER
    if (modulo === "responder-reembolsar" || modulo === "responder-disputar") {
      const rsn = (par("return_sn") || "").trim();
      const confirmar = par("confirmar") === "1";
      if (!rsn) return json({ erro: "informe ?return_sn=..." }, { status: 400 });

      const { data: dev } = await supabase.from("shopee_devolucoes")
        .select("return_sn, order_sn, shop_id, status, reason, refund_amount, due_date")
        .eq("return_sn", rsn).maybeSingle();
      if (!dev) return json({ erro: `return_sn ${rsn} nao esta no espelho — rode o sync` }, { status: 404 });
      const ctx = await ctxDoReturn(supabase, ctxs, rsn);

      if (modulo === "responder-reembolsar") {
        const payload = { return_sn: rsn };
        if (!confirmar) {
          return json({
            modulo, dry: true, devolucao: dev,
            aviso: "IRREVERSIVEL: finaliza a solicitacao e reembolsa o comprador " +
                   `(R$ ${dev.refund_amount}). Nada foi enviado — repita com &confirmar=1.`,
            payload, endpoint: "/api/v2/returns/confirm",
          });
        }
        const r = await shopeePost(ctx, "/api/v2/returns/confirm", payload);
        const ok = !r.body?.error;
        if (ok) {
          await supabase.from("shopee_devolucoes")
            .update({ status: "ACCEPTED", atualizado_em: new Date().toISOString() })
            .eq("return_sn", rsn);
        }
        return json({ modulo, return_sn: rsn, ok, resposta: r.body }, { status: ok ? 200 : 502 });
      }

      // responder-disputar — contrato v12 (SDK): dispute_reason_id + image_list
      const texto = (par("texto") || "").trim();
      const email = (par("email") || "").trim();
      const motivo = parseInt(par("motivo") || "0", 10);
      const imageList = Array.isArray(corpo?.image_list) ? corpo.image_list : [];
      if (!email || !motivo) {
        return json({
          erro: "informe motivo (enum) e email; texto e image_list conforme a exigencia do motivo",
          dica: "pegue os motivos validos em ?modulo=motivos-disputa&return_sn=... — vazio = sem disputa via API",
        }, { status: 400 });
      }
      const payload: Record<string, any> = {
        return_sn: rsn,
        email,
        dispute_reason_id: motivo,
      };
      if (texto) payload.dispute_text_reason = texto;
      if (imageList.length > 0) payload.image_list = imageList;
      if (!confirmar) {
        return json({
          modulo, dry: true, devolucao: dev,
          aviso: "IRREVERSIVEL: abre disputa na Shopee (vai para julgamento). " +
                 "Nada foi enviado — repita com &confirmar=1.",
          payload, endpoint: "/api/v2/returns/dispute",
        });
      }
      const r = await shopeePost(ctx, "/api/v2/returns/dispute", payload);
      const ok = !r.body?.error;
      if (ok) {
        await supabase.from("shopee_devolucoes")
          .update({ status: "SELLER_DISPUTE", atualizado_em: new Date().toISOString() })
          .eq("return_sn", rsn);
      }
      return json({ modulo, return_sn: rsn, ok, resposta: r.body }, { status: ok ? 200 : 502 });
    }

    return new Response(`modulo ${modulo} desconhecido`, { status: 400, headers: CORS });
  } catch (e) {
    return json({ erro: (e as Error).message }, { status: 500 });
  }
});
