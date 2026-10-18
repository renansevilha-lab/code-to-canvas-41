// Central de Promocoes ML: espelha promocoes do vendedor + cacheia inputs pra MC.
// PINADO na conta Ottz (user_id 1107117809) desde 31/ago — multi-conta no banco;
// as tabelas ml_promocoes/ml_promocao_itens nao tem coluna de conta.
// v26 (16/out): robô também TROCA de promoção (só de campanha em andamento, nunca para Relâmpago) e
//      entra no MENOR preço da faixa do ML que dá MC >= regra quando o sugerido não dá; trocarItem
//      virou rotina única (botão Trocar + robô). Regra exigir_frete_real desligada no banco.
// v24 (05/out): REGRA de entrada automática — modulo=auto aplica o que view_ml_promo_decisao marca
//      'auto' (MC >= ml_promo_regra.mc_min_pct; modo desligado|simulacao|ligado) e avisa no Discord
//      (#atualizacoes); modulo=trocar sai da promoção atual e entra na de MC melhor (volta se a nova
//      recusar). aplicar virou rotina única (aplicarItem).
// v23: relampago confere 5 anúncios em paralelo (80 por rodada; sequencial fazia ~16).
// v22 (05/out): RELÂMPAGO só para anúncios com venda no ML em 30 dias — modulo=relampago confere
//      cada um AO VIVO em rodízio (ml_relampago_verif), apaga candidata de quem não vende; o sync
//      não lê mais as 1.200+ candidatas da campanha (só as ativas).
// v21: listagem com teto de 120 por status (400 estourou o tempo).
// v20: sync encerra campanha vencida (finish_date < agora → status finished + apaga itens).
// v19: sync APAGA candidatas que o ML não lista mais (listagem completa, linha parada 7+ dias) — lista velha dava erro ao aplicar.
// v18 (05/out/2026): RELÂMPAGO exige `stock` (unidades reservadas, faixa stock.min..max
//   do ML) — sem ele o ML recusava todo LIGHTNING. `aplicar` agora confere o estado AO VIVO
//   (/seller-promotions/items/{mlb}) antes de mandar: item que o ML nao oferece mais = lista
//   desatualizada (apaga a linha); ja aplicado = marca started; preco fora da faixa = recusa
//   com motivo. Toda tentativa vai pro historico ml_promocao_acoes com a resposta do ML.
//   SEGURANCA: aplicar/remover/item exigem JWT de USUARIO logado (antes aceitava a chave
//   publica do bundle). sync/simular/estado seguem abertos (cron 73 chama o sync).
// modulo=sync            -> lista promos + itens; preco=suggested; frete=mediana por SKU (fallback mediana global)
// modulo=estado  &mlb=   -> promocoes do item AO VIVO no ML (leitura, nao grava)
// modulo=relampago[&max=] -> Relâmpago dos anúncios COM VENDA em 30d, ao vivo, em rodízio (cron)
// modulo=item    &mlb=   -> TODAS as promocoes elegiveis do item (item-promos)
// modulo=simular &mlb=&promocao_id=&preco=   -> MC exata num preco escolhido
// modulo=aplicar &mlb=&promocao_id=&tipo=[&offer_id=][&deal_price=][&stock=]&confirmar=1  (WRITE)
// modulo=remover &mlb=&promocao_id=&tipo=&confirmar=1                                       (WRITE)
// modulo=auto                -> robô da regra (cron); só executa view_ml_promo_decisao='auto'
// modulo=trocar &mlb=&de_promocao_id=&de_tipo=&para_promocao_id=&para_tipo=[&deal_price=][&stock=]&confirmar=1 (WRITE)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ML = "https://api.mercadolibre.com";
const OTTZ_USER_ID = 1107117809;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, i?: ResponseInit) => new Response(JSON.stringify(b), { ...i, headers: { ...CORS, "Content-Type": "application/json", ...(i?.headers || {}) } });
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const shipLog = (b: any) => b?.shipping?.logistic_type ?? null;
const shipFree = (b: any) => typeof b?.shipping?.free_shipping === "boolean" ? b.shipping.free_shipping : null;
const ESCRITA = new Set(["aplicar", "remover", "item", "trocar"]);

async function tok(supabase: any): Promise<{ token: string; seller: number }> {
  // conta FIXA (Ottz). Nunca "mais recente" — multi-conta no banco.
  const { data } = await supabase.from("oauth_tokens_ml").select("access_token, user_id").eq("user_id", OTTZ_USER_ID).limit(1).single();
  return { token: data.access_token, seller: data.user_id };
}
async function freteMediana(supabase: any): Promise<number> {
  const { data } = await supabase.rpc("ml_frete_mediana");
  const n = Number(data);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
async function mlGet(token: string, path: string) {
  const r = await fetch(`${ML}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t.slice(0, 300); }
  return { status: r.status, ok: r.ok, body: b };
}
async function mlSend(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${ML}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = t.slice(0, 400); }
  return { status: r.status, ok: r.ok, body: b };
}
async function saleFee(token: string, price: number, categoryId: string, listingType: string): Promise<number | null> {
  if (!price || !categoryId || !listingType) return null;
  const r = await mlGet(token, `/sites/MLB/listing_prices?price=${price}&category_id=${categoryId}&listing_type_id=${listingType}`);
  const v = r.body?.sale_fee_amount;
  return v != null ? Number(v) : null;
}
/** Motivo legível a partir da resposta de erro do ML. */
function motivoML(body: any): string {
  if (!body) return "sem resposta do Mercado Livre";
  if (typeof body === "string") return body.slice(0, 240);
  const causas = Array.isArray(body.cause) ? body.cause.map((c: any) => c?.message || c?.code || "").filter(Boolean) : [];
  const partes = [body.message, body.error, ...causas].filter((x) => x && typeof x === "string");
  return (partes.length ? [...new Set(partes)].join(" · ") : JSON.stringify(body)).slice(0, 300);
}
type Item = { mlb: string; promocao_id: string; tipo: string; status: string; promo_price: number | null; original_price: number | null; offer_id: string | null; meli: number | null; seller: number | null; sugerido: number | null; pmin: number | null; pmax: number | null; estMin: number | null; estMax: number | null; ini: string | null; fim: string | null };
async function coletarItens(token: string, promoId: string, tipo: string, status: string, cap: number): Promise<Item[]> {
  const out: Item[] = []; let offset = 0;
  for (let pg = 0; pg < 8 && out.length < cap; pg++) {
    const r = await mlGet(token, `/seller-promotions/promotions/${promoId}/items?promotion_type=${tipo}&status=${status}&app_version=v2&limit=50&offset=${offset}`);
    const res = (r.body?.results || []) as any[];
    for (const x of res) {
      const sugerido = num(x.suggested_discounted_price);
      const price = num(x.price);
      out.push({ mlb: x.id, promocao_id: promoId, tipo, status: x.status ?? status,
        promo_price: sugerido ?? price, sugerido, pmin: num(x.min_discounted_price), pmax: num(x.max_discounted_price),
        original_price: num(x.original_price), offer_id: x.offer_id ?? null,
        meli: x.meli_percentage != null ? Number(x.meli_percentage) : null,
        seller: x.seller_percentage != null ? Number(x.seller_percentage) : null,
        estMin: x.stock?.min != null ? Number(x.stock.min) : null, estMax: x.stock?.max != null ? Number(x.stock.max) : null,
        ini: x.start_date ?? null, fim: x.finish_date ?? null });
    }
    if (res.length < 50) break;
    offset += 50;
  }
  return out.slice(0, cap);
}
/** Promoções do item AO VIVO no ML (lista de /seller-promotions/items/{mlb}). */
async function promosDoItem(token: string, mlb: string) {
  const r = await mlGet(token, `/seller-promotions/items/${mlb}?app_version=v2`);
  return { status: r.status, lista: Array.isArray(r.body) ? r.body as any[] : [], body: r.body };
}
const acharPromo = (lista: any[], promocaoId: string, tipo: string) =>
  lista.find((p) => p?.id === promocaoId) ?? (tipo === "LIGHTNING" ? lista.find((p) => String(p?.type).toUpperCase() === "LIGHTNING") : undefined);
const resumoPromo = (p: any) => p && ({
  id: p.id ?? null, tipo: p.type ?? null, status: p.status ?? null, nome: p.name ?? null,
  preco: num(p.price), original: num(p.original_price), sugerido: num(p.suggested_discounted_price),
  min: num(p.min_discounted_price), max: num(p.max_discounted_price),
  estoque_min: p.stock?.min ?? null, estoque_max: p.stock?.max ?? null,
  inicio: p.start_date ?? null, fim: p.finish_date ?? null, offer_id: p.offer_id ?? null,
});

/** Entra numa promoção conferindo AO VIVO antes (lista do app pode estar velha). Usado pelo
 *  botão Aplicar, pelo robô da regra (modulo=auto) e pela troca (modulo=trocar). Registra tudo
 *  em ml_promocao_acoes. */
async function aplicarItem(supabase: any, token: string, a: { mlb: string; promocaoId: string; tipo: string; dealPrice?: number | null; offerId?: string | null; stock?: number | null; por: string | null; acao?: string }) {
  const { mlb, promocaoId, tipo, por } = a;
  const acao = a.acao ?? "aplicar";
  const registrar = async (enviado: unknown, r: { status: number; ok: boolean; body: any } | null, mensagem: string | null, ok: boolean) => {
    await supabase.from("ml_promocao_acoes").insert({ mlb, promocao_id: promocaoId, tipo, acao, enviado, http_status: r?.status ?? null, ok, mensagem, resposta: r?.body ?? null, por });
  };
  const vivo = await promosDoItem(token, mlb);
  if (vivo.status === 401) return { ok: false, mensagem: "token do Mercado Livre expirado — tente de novo em 1 minuto", http: 401 };
  const p = acharPromo(vivo.lista, promocaoId, tipo);
  if (!p) {
    await supabase.from("ml_promocao_itens").delete().eq("promocao_id", promocaoId).eq("mlb", mlb).eq("status", "candidate");
    const msg = "O Mercado Livre não oferece mais esta promoção para este anúncio (a lista estava desatualizada — tirei o item da tela).";
    await registrar(null, { status: vivo.status, ok: false, body: vivo.body }, msg, false);
    return { ok: false, desatualizado: true, mensagem: msg };
  }
  const st = String(p.status ?? "");
  if (st === "started" || st === "pending") {
    await supabase.from("ml_promocao_itens").update({ status: "started" }).eq("promocao_id", promocaoId).eq("mlb", mlb);
    await registrar(null, null, `já estava ${st === "started" ? "ativa" : "programada"}`, true);
    return { ok: true, ja_estava: true, mensagem: st === "started" ? "Este anúncio já está nesta promoção." : "Este anúncio já está programado nesta promoção." };
  }
  const body: any = { promotion_type: tipo };
  if (tipo !== "LIGHTNING") body.promotion_id = promocaoId;
  const offerId = a.offerId || p.offer_id || null;
  const dealPrice = num(a.dealPrice);
  if (offerId) body.offer_id = offerId;
  else if (dealPrice) {
    const pmin = num(p.min_discounted_price), pmax = num(p.max_discounted_price);
    if ((pmin && dealPrice < pmin - 0.001) || (pmax && dealPrice > pmax + 0.001)) {
      const msg = `Preço fora da faixa aceita pelo ML agora (R$ ${pmin ?? "?"} a R$ ${pmax ?? "?"}).`;
      await registrar({ deal_price: dealPrice }, null, msg, false);
      return { ok: false, mensagem: msg, faixa: { min: pmin, max: pmax } };
    }
    body.deal_price = dealPrice;
  }
  if (tipo === "LIGHTNING") {
    const eMin = p.stock?.min != null ? Number(p.stock.min) : null, eMax = p.stock?.max != null ? Number(p.stock.max) : null;
    let stock = Number(a.stock || 0) || eMin || 0;
    if (eMin != null && stock < eMin) stock = eMin;
    if (eMax != null && stock > eMax) stock = eMax;
    if (!stock) {
      const msg = "O Relâmpago exige informar quantas unidades reservar, e o ML não informou a faixa para este item.";
      await registrar(body, null, msg, false);
      return { ok: false, mensagem: msg };
    }
    body.stock = stock;
  }
  const r = await mlSend(token, "POST", `/seller-promotions/items/${mlb}?app_version=v2`, body);
  const msg = r.ok ? null : motivoML(r.body);
  if (r.ok) await supabase.from("ml_promocao_itens").update({ status: "started", promo_price: body.deal_price ?? undefined }).eq("promocao_id", promocaoId).eq("mlb", mlb);
  await registrar(body, r, msg, r.ok);
  return { ok: r.ok, mensagem: msg, enviado: body, status: r.status, body: r.body };
}

/** Sai da promoção atual e entra na nova; se a nova recusar, tenta voltar para a atual.
 *  Usado pelo botão Trocar (modulo=trocar) e pelo robô (modulo=auto). */
async function trocarItem(supabase: any, token: string, a: { mlb: string; de: string; deTipo: string; para: string; paraTipo: string; dealPrice?: number | null; offerId?: string | null; stock?: number | null; por: string | null; prefixo?: string }) {
  const { mlb, de, deTipo, para, paraTipo, por } = a;
  const pre = a.prefixo ?? "trocar";
  if (deTipo === "LIGHTNING") return { ok: false, mensagem: "Relâmpago ativo não pode ser removido no Mercado Livre — espere ele terminar." };
  const vivo = await promosDoItem(token, mlb);
  const alvo = acharPromo(vivo.lista, para, paraTipo);
  if (!alvo || String(alvo.status) !== "candidate") return { ok: false, mensagem: "A promoção nova não está mais disponível para este anúncio — nada foi alterado." };
  const { data: atual } = await supabase.from("ml_promocao_itens").select("promo_price, offer_id").eq("promocao_id", de).eq("mlb", mlb).maybeSingle();
  const sai = await mlSend(token, "DELETE", `/seller-promotions/items/${mlb}?promotion_id=${de}&promotion_type=${deTipo}&app_version=v2`);
  await supabase.from("ml_promocao_acoes").insert({ mlb, promocao_id: de, tipo: deTipo, acao: `${pre}-sair`, enviado: null, http_status: sai.status, ok: sai.ok, mensagem: sai.ok ? null : motivoML(sai.body), resposta: sai.body, por });
  if (!sai.ok) return { ok: false, mensagem: `Não consegui tirar da promoção atual: ${motivoML(sai.body)} — nada foi alterado.` };
  await supabase.from("ml_promocao_itens").update({ status: "candidate" }).eq("promocao_id", de).eq("mlb", mlb);
  const entra = await aplicarItem(supabase, token, { mlb, promocaoId: para, tipo: paraTipo, dealPrice: a.dealPrice ?? null, offerId: a.offerId ?? null, stock: a.stock ?? null, por, acao: `${pre}-entrar` });
  if (entra.ok) return { ok: true, mensagem: "Troca feita: saiu da promoção anterior e entrou na nova." };
  // a nova recusou: tenta devolver para a anterior
  const volta: any = { promotion_type: deTipo, promotion_id: de };
  if ((atual as any)?.offer_id) volta.offer_id = (atual as any).offer_id; else if ((atual as any)?.promo_price) volta.deal_price = Number((atual as any).promo_price);
  const rv = await mlSend(token, "POST", `/seller-promotions/items/${mlb}?app_version=v2`, volta);
  if (rv.ok) await supabase.from("ml_promocao_itens").update({ status: "started" }).eq("promocao_id", de).eq("mlb", mlb);
  await supabase.from("ml_promocao_acoes").insert({ mlb, promocao_id: de, tipo: deTipo, acao: `${pre}-voltar`, enviado: volta, http_status: rv.status, ok: rv.ok, mensagem: rv.ok ? null : motivoML(rv.body), resposta: rv.body, por });
  return { ok: false, sem_promocao: !rv.ok, mensagem: `A promoção nova recusou (${entra.mensagem ?? "sem detalhe"}). ${rv.ok ? "O anúncio voltou para a promoção anterior." : "ATENÇÃO: não consegui voltar para a anterior — o anúncio ficou SEM promoção."}` };
}

/** MC (R$) num preço, mesma conta da view_ml_promocoes para item sem co-financiamento:
 *  preço − comissão (listing_prices ao vivo) − frete − imposto − CMV. */
async function mcNoPreco(token: string, p: number, x: { cat: string; lt: string; frete: number; aliquota: number; cmv: number }) {
  const fee = await saleFee(token, p, x.cat, x.lt);
  if (fee == null) return null;
  const mc = p - fee - x.frete - Math.round(p * x.aliquota * 100) / 100 - x.cmv;
  return { mc: Math.round(mc * 100) / 100, pct: mc / p };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const supabase = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "sync";

  // Escrita no ML (muda preço público) só com sessão de usuário ou service role.
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let role = "";
  try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = ""; }
  if (ESCRITA.has(modulo) && bearer !== SRK && role !== "authenticated" && role !== "service_role") {
    return json({ erro: "faça login no app (sessão de usuário exigida)" }, { status: 401 });
  }

  const { token, seller } = await tok(supabase);
  const DET_ATTR = "id,category_id,listing_type_id,sold_quantity,date_created,shipping";

  try {
    if (modulo === "estado") {
      const mlb = url.searchParams.get("mlb");
      if (!mlb) return json({ erro: "faltam mlb" }, { status: 400 });
      const r = await promosDoItem(token, mlb);
      if (r.status === 401) return json({ erro: "token ML expirado (rode ml-refresh-token)" }, { status: 401 });
      const pid = url.searchParams.get("promocao_id"); const tipo = (url.searchParams.get("tipo") || "").toUpperCase();
      return json({ modulo, mlb, http: r.status, promocao: pid ? resumoPromo(acharPromo(r.lista, pid, tipo)) ?? null : undefined, promocoes: r.lista.map(resumoPromo) });
    }

    if (modulo === "relampago") {
      // v22: Relâmpago SÓ para anúncios com venda no ML em 30 dias (dono, 05/out). A listagem
      // da campanha tem 1.200+ candidatas e o sync não dava conta; aqui cada anúncio que vende é
      // conferido AO VIVO (/seller-promotions/items/{mlb}), em rodízio (mais antigo primeiro).
      const inicioR = Date.now();
      const max = Math.min(150, parseInt(url.searchParams.get("max") || "80", 10));
      const { data: vend } = await supabase.rpc("ml_vendas_30d_sku");
      const vendidos = new Set(((vend ?? []) as any[]).map((r) => String(r.sku)));
      const anuncios: Array<{ mlb: string; sku: string }> = [];
      const skusArr = [...vendidos];
      for (let k = 0; k < skusArr.length; k += 300) {
        const { data } = await supabase.from("ml_anuncios").select("mlb, sku").eq("status", "active").in("sku", skusArr.slice(k, k + 300));
        anuncios.push(...((data ?? []) as any[]));
      }
      const alvo = new Set(anuncios.map((a) => a.mlb));
      // promoções-relâmpago conhecidas (ids LGH-...) — para limpar e apagar por item
      const { data: lghPromos } = await supabase.from("ml_promocoes").select("promocao_id").eq("tipo", "LIGHTNING");
      const lghIds = ((lghPromos ?? []) as any[]).map((p) => p.promocao_id);
      // limpeza: candidata de Relâmpago de anúncio SEM venda em 30 dias sai da lista
      let removidosSemVenda = 0;
      if (lghIds.length) {
        const { data: cands } = await supabase.from("ml_promocao_itens").select("mlb").in("promocao_id", lghIds).eq("status", "candidate");
        const fora = [...new Set(((cands ?? []) as any[]).map((c) => c.mlb).filter((m) => !alvo.has(m)))];
        for (let k = 0; k < fora.length; k += 100) {
          await supabase.from("ml_promocao_itens").delete().in("promocao_id", lghIds).eq("status", "candidate").in("mlb", fora.slice(k, k + 100));
        }
        removidosSemVenda = fora.length;
      }
      // rodízio: nunca verificados primeiro, depois os mais antigos
      const { data: verif } = await supabase.from("ml_relampago_verif").select("mlb, verificado_em");
      const quando = new Map(((verif ?? []) as any[]).map((v) => [v.mlb, String(v.verificado_em)]));
      const skuDe = new Map(anuncios.map((a) => [a.mlb, a.sku]));
      const lote = [...alvo].sort((a, b) => (quando.get(a) ?? "").localeCompare(quando.get(b) ?? "")).slice(0, max);
      const det = new Map<string, { cat: string; lt: string; logistic: string | null; free: boolean | null; sold: number | null; dc: string | null }>();
      for (let k = 0; k < lote.length; k += 20) {
        const r = await mlGet(token, `/items?ids=${lote.slice(k, k + 20).join(",")}&attributes=${DET_ATTR}`);
        for (const e of (r.body || []) as any[]) { const b = e.body; if (b?.id) det.set(b.id, { cat: b.category_id, lt: b.listing_type_id, logistic: shipLog(b), free: shipFree(b), sold: b.sold_quantity ?? null, dc: b.date_created ?? null }); }
      }
      const { data: freteRows } = await supabase.from("ml_frete_sku").select("sku, frete_vendedor").in("sku", [...new Set(lote.map((m) => skuDe.get(m)).filter(Boolean))] as string[]);
      const freteMap = new Map<string, number>(((freteRows ?? []) as any[]).map((r) => [r.sku, Number(r.frete_vendedor)]));
      const medFallback = await freteMediana(supabase);
      let verificados = 0, comRelampago = 0, gravadosR = 0, semTempoR = 0;
      let tokenExpirado = false;
      const processar = async (mlb: string) => {
        const vivoR = await promosDoItem(token, mlb);
        if (vivoR.status === 401) { tokenExpirado = true; return; }
        const lgh = vivoR.lista.filter((p) => String(p?.type).toUpperCase() === "LIGHTNING" && ["candidate", "started", "pending"].includes(String(p?.status)) && p?.id);
        const sku = skuDe.get(mlb) ?? null; const d = det.get(mlb);
        if (lgh.length === 0 && lghIds.length) {
          await supabase.from("ml_promocao_itens").delete().eq("mlb", mlb).in("promocao_id", lghIds).eq("status", "candidate");
        }
        for (const p of lgh) {
          await supabase.from("ml_promocoes").upsert({ promocao_id: p.id, tipo: "LIGHTNING", nome: p.name ?? null, status: "started" }, { onConflict: "promocao_id", ignoreDuplicates: true });
          const pmin = num(p.min_discounted_price), pmax = num(p.max_discounted_price);
          let preco = num(p.suggested_discounted_price) ?? num(p.price);
          if (preco != null && pmax != null && preco > pmax) preco = pmax; // sugerido do ML pode passar do máximo aceito
          const [comissaoPromo, comissaoAtual] = await Promise.all([
            preco && d ? saleFee(token, preco, d.cat, d.lt) : Promise.resolve(null),
            num(p.original_price) && d ? saleFee(token, Number(p.original_price), d.cat, d.lt) : Promise.resolve(null),
          ]);
          const freteReal = sku && freteMap.has(sku) ? freteMap.get(sku)! : null;
          await supabase.from("ml_promocao_itens").upsert({
            promocao_id: p.id, mlb, sku, status: p.status === "candidate" ? "candidate" : "started", offer_id: p.offer_id ?? null,
            original_price: num(p.original_price), promo_price: preco, preco_sugerido: num(p.suggested_discounted_price) ?? num(p.price), preco_min: pmin, preco_max: pmax,
            meli_percentage: p.meli_percentage ?? null, seller_percentage: p.seller_percentage ?? null,
            category_id: d?.cat ?? null, listing_type_id: d?.lt ?? null, logistic_type: d?.logistic ?? null, free_shipping: d?.free ?? null,
            sold_quantity: d?.sold ?? null, date_created: d?.dc ?? null,
            comissao_promo: comissaoPromo, comissao_atual: comissaoAtual, frete_vendedor: freteReal ?? medFallback, frete_estimado: freteReal == null,
            estoque_min: p.stock?.min ?? null, estoque_max: p.stock?.max ?? null, item_inicio: p.start_date ?? null, item_fim: p.finish_date ?? null,
            atualizado_em: new Date().toISOString(),
          }, { onConflict: "promocao_id,mlb" });
          gravadosR++;
        }
        if (lgh.length) comRelampago++;
        await supabase.from("ml_relampago_verif").upsert({ mlb, verificado_em: new Date().toISOString(), tem_relampago: lgh.length > 0 }, { onConflict: "mlb" });
        verificados++;
      };
      // 5 anúncios em paralelo (sequencial dava ~16 por rodada de 22 s)
      for (let k = 0; k < lote.length; k += 5) {
        if (Date.now() - inicioR > 21000 || tokenExpirado) { semTempoR += lote.length - k; break; }
        await Promise.all(lote.slice(k, k + 5).map((m) => processar(m).catch(() => {})));
      }
      if (tokenExpirado) return json({ erro: "token ML expirado (rode ml-refresh-token)", verificados }, { status: 401 });
      for (const id of lghIds) {
        const { count } = await supabase.from("ml_promocao_itens").select("mlb", { count: "exact", head: true }).eq("promocao_id", id);
        await supabase.from("ml_promocoes").update({ n_itens: count ?? 0 }).eq("promocao_id", id);
      }
      return json({ modulo, anuncios_com_venda: alvo.size, lote: lote.length, verificados, com_relampago: comRelampago, gravados: gravadosR, removidos_sem_venda: removidosSemVenda, sem_tempo: semTempoR, ms: Date.now() - inicioR });
    }

    if (modulo === "auto") {
      // ROBÔ da regra (dono, 05/out): só executa a regra do banco — não recebe item/preço de quem
      // chama (por isso o cron pode chamar com a chave pública). Três etapas, nesta ordem, com o
      // mesmo teto ml_promo_regra.max_por_rodada no total:
      //  1) ENTRAR pelo preço sugerido: view_ml_promo_decisao = 'auto'.
      //  2) TROCAR (v26, 16/out): 'trocar' em que a nova dá MC >= regra e ganho >= ganho_min_troca.
      //     Só quando a promoção atual está EM ANDAMENTO (não tira de campanha programada, ex.
      //     "11.11 da Black") e a nova NÃO é Relâmpago (dura horas: depois o anúncio ficaria sem
      //     promoção). Relâmpago ativo nunca sai (regra do ML).
      //  3) PREÇO DENTRO DA FAIXA (v26): 'confirmar' (anúncio fora de promoção, melhor opção) que
      //     não passa no sugerido mas passa em algum preço até o máximo aceito pelo ML — entra no
      //     MENOR preço (maior desconto) que ainda dá MC >= regra. Só item sem co-financiamento e
      //     sem offer_id (preço livre). Comissão conferida ao vivo (listing_prices).
      const inicioA = Date.now();
      const avaliarOk = () => Date.now() - inicioA < 9000;  // etapa 3 só avalia até aqui
      const tempoOk = () => Date.now() - inicioA < 22000;
      const { data: regra } = await supabase.from("ml_promo_regra").select("*").eq("id", 1).maybeSingle();
      const R = (regra ?? {}) as any;
      const modoR = String(R.modo ?? "desligado");
      const minPct = Number(R.mc_min_pct ?? 0.15);
      const ganhoMin = Number(R.ganho_min_troca ?? 0.5);
      const exigirFrete = R.exigir_frete_real === true;
      let vagas = Number(R.max_por_rodada ?? 20);
      const POR = "automático (regra MC)";

      // ---- 1) entradas pelo sugerido
      const { data: cands } = await supabase.from("view_ml_promo_decisao").select("promocao_id, mlb, sku, promocao_nome, promocao_tipo, promo_price, offer_id, mc_promo, mc_promo_pct")
        .eq("decisao", "auto").order("mc_promo_pct", { ascending: false }).limit(vagas);
      const lista = (cands ?? []) as any[];

      // ---- 2) trocas
      const { data: trocasV } = await supabase.from("view_ml_promo_decisao")
        .select("promocao_id, mlb, sku, promocao_nome, promocao_tipo, promo_price, offer_id, mc_promo_pct, frete_estimado, ativo_promocao_id, ativo_tipo, ativo_nome, ativo_mc_pct, ganho_troca")
        .eq("decisao", "trocar").eq("melhor_do_anuncio", true).gte("mc_promo_pct", minPct).order("ganho_troca", { ascending: false });
      const idsAtivos = [...new Set(((trocasV ?? []) as any[]).map((t) => t.ativo_promocao_id).filter(Boolean))];
      const { data: promAtivas } = idsAtivos.length ? await supabase.from("ml_promocoes").select("promocao_id, status, nome").in("promocao_id", idsAtivos) : { data: [] as any[] };
      const statusPromo = new Map(((promAtivas ?? []) as any[]).map((p) => [p.promocao_id, String(p.status ?? "")]));
      const trocas: any[] = []; const trocasPuladas: any[] = [];
      for (const t of (trocasV ?? []) as any[]) {
        const motivo = t.ganho_troca == null || Number(t.ganho_troca) < ganhoMin ? "ganho da troca não conhecido ou abaixo do mínimo"
          : exigirFrete && t.frete_estimado ? "frete estimado"
          : String(t.ativo_tipo).toUpperCase() === "LIGHTNING" ? "está num Relâmpago ativo (o ML não deixa tirar)"
          : String(t.promocao_tipo).toUpperCase() === "LIGHTNING" ? "a nova é Relâmpago (dura horas; o anúncio sairia da campanha atual)"
          : statusPromo.get(t.ativo_promocao_id) !== "started" ? `a promoção atual (${t.ativo_nome ?? t.ativo_promocao_id}) ainda não começou — não tiro de campanha programada`
          : null;
        if (motivo) trocasPuladas.push({ mlb: t.mlb, sku: t.sku, de: t.ativo_nome ?? t.ativo_promocao_id, para: t.promocao_nome ?? t.promocao_id, motivo });
        else trocas.push(t);
      }

      // ---- 3) preço dentro da faixa
      const { data: confV } = await supabase.from("view_ml_promo_decisao").select("promocao_id, mlb, sku, promocao_nome, promocao_tipo, promo_price, mc_promo_pct, frete_estimado")
        .eq("decisao", "confirmar").eq("melhor_do_anuncio", true).not("mc_promo_pct", "is", null);
      const confL = ((confV ?? []) as any[]).filter((c) => !(exigirFrete && c.frete_estimado));
      const chaves = new Set(confL.map((c) => `${c.promocao_id}|${c.mlb}`));
      const mlbsConf = [...new Set(confL.map((c) => c.mlb))];
      const detConf = new Map<string, any>();
      for (let k = 0; k < mlbsConf.length; k += 100) {
        const { data } = await supabase.from("view_ml_promocoes").select("promocao_id, mlb, preco_max, preco_min, offer_id, seller_percentage, meli_percentage, comissao_promo, promo_price, category_id, listing_type_id, cmv, frete, aliquota")
          .in("mlb", mlbsConf.slice(k, k + 100));
        for (const d of (data ?? []) as any[]) if (chaves.has(`${d.promocao_id}|${d.mlb}`)) detConf.set(`${d.promocao_id}|${d.mlb}`, d);
      }
      // estimativa barata (comissão proporcional à já conhecida) para só consultar o ML de quem pode passar
      const faixa: any[] = [];
      for (const c of confL) {
        const d = detConf.get(`${c.promocao_id}|${c.mlb}`);
        if (!d || d.offer_id || d.seller_percentage != null || d.meli_percentage != null) continue;
        const pmax = num(d.preco_max), sug = num(d.promo_price), com = Number(d.comissao_promo);
        if (!pmax || !sug || pmax <= sug + 0.009 || d.cmv == null || !d.category_id || !d.listing_type_id || !Number.isFinite(com)) continue;
        const aliq = Number(d.aliquota ?? 0.1), frete = Number(d.frete ?? 0), cmv = Number(d.cmv);
        const est = (pmax - pmax * (com / sug) - frete - pmax * aliq - cmv) / pmax;
        if (est < minPct - 0.04) continue;
        faixa.push({ ...c, est, pmax, sug, pmin: num(d.preco_min), x: { cat: d.category_id, lt: d.listing_type_id, frete, aliquota: aliq, cmv } });
      }
      faixa.sort((a, b) => b.est - a.est);
      const ajustes: any[] = [];
      for (const f of faixa) {
        if (!avaliarOk() || ajustes.length >= vagas) break;
        const noMax = await mcNoPreco(token, f.pmax, f.x);
        if (!noMax || noMax.pct < minPct) continue;
        // menor preço (maior desconto) em [sugerido, máximo] que ainda dá MC >= regra
        let lo = f.sug, hi = f.pmax, best = { p: f.pmax, mc: noMax.mc, pct: noMax.pct };
        for (let it = 0; it < 6 && hi - lo > 0.05 && avaliarOk(); it++) {
          const mid = Math.round(((lo + hi) / 2) * 100) / 100;
          const m = await mcNoPreco(token, mid, f.x);
          if (m && m.pct >= minPct) { hi = mid; best = { p: mid, mc: m.mc, pct: m.pct }; } else lo = mid;
        }
        if (f.pmin && best.p < f.pmin) continue;
        ajustes.push({ ...f, preco: best.p, mc_pct_novo: best.pct, mc_novo: best.mc });
      }

      if (modoR !== "ligado") {
        return json({ modulo, modo: modoR, aplicaria: lista.length, itens: lista,
          trocaria: trocas.map((t) => ({ mlb: t.mlb, sku: t.sku, de: t.ativo_nome, para: t.promocao_nome, mc_pct: t.mc_promo_pct, ganho: t.ganho_troca })),
          trocas_puladas: trocasPuladas,
          ajustaria: ajustes.map((a) => ({ mlb: a.mlb, sku: a.sku, promocao: a.promocao_nome, sugerido: a.sug, preco: a.preco, mc_pct: a.mc_pct_novo })) });
      }

      const mlbsTodos = [...new Set([...lista, ...trocas, ...ajustes].map((c) => c.mlb))];
      const { data: est } = mlbsTodos.length
        ? await supabase.from("ml_promocao_itens").select("promocao_id, mlb, estoque_min").in("mlb", mlbsTodos)
        : { data: [] as any[] };
      const estMin = new Map(((est ?? []) as any[]).map((e) => [`${e.promocao_id}|${e.mlb}`, e.estoque_min]));
      const feitos: any[] = []; let pendentes = 0;
      const jaMexido = new Set<string>();
      for (const c of lista) {
        if (!tempoOk() || vagas <= 0) { pendentes++; continue; }
        const r = await aplicarItem(supabase, token, {
          mlb: c.mlb, promocaoId: c.promocao_id, tipo: String(c.promocao_tipo).toUpperCase(),
          dealPrice: c.offer_id ? null : c.promo_price, offerId: c.offer_id, stock: estMin.get(`${c.promocao_id}|${c.mlb}`) ?? null,
          por: POR, acao: "auto",
        });
        jaMexido.add(c.mlb); if (r.ok && !(r as any).ja_estava) vagas--;
        feitos.push({ etapa: "entrar", mlb: c.mlb, sku: c.sku, promocao: c.promocao_nome ?? c.promocao_id, tipo: c.promocao_tipo, mc_pct: c.mc_promo_pct, ok: r.ok, ja_estava: (r as any).ja_estava ?? false, mensagem: r.mensagem });
      }
      for (const t of trocas) {
        if (jaMexido.has(t.mlb)) continue;
        if (!tempoOk() || vagas <= 0) { pendentes++; continue; }
        const r = await trocarItem(supabase, token, {
          mlb: t.mlb, de: t.ativo_promocao_id, deTipo: String(t.ativo_tipo).toUpperCase(), para: t.promocao_id, paraTipo: String(t.promocao_tipo).toUpperCase(),
          dealPrice: t.offer_id ? null : t.promo_price, offerId: t.offer_id, stock: estMin.get(`${t.promocao_id}|${t.mlb}`) ?? null, por: POR, prefixo: "auto-trocar",
        });
        jaMexido.add(t.mlb); if (r.ok) vagas--;
        feitos.push({ etapa: "trocar", mlb: t.mlb, sku: t.sku, promocao: t.promocao_nome ?? t.promocao_id, de: t.ativo_nome ?? t.ativo_promocao_id, tipo: t.promocao_tipo, mc_pct: t.mc_promo_pct, ganho: t.ganho_troca, ok: r.ok, sem_promocao: (r as any).sem_promocao ?? false, mensagem: r.mensagem });
      }
      for (const a of ajustes) {
        if (jaMexido.has(a.mlb)) continue;
        if (!tempoOk() || vagas <= 0) { pendentes++; continue; }
        const r = await aplicarItem(supabase, token, {
          mlb: a.mlb, promocaoId: a.promocao_id, tipo: String(a.promocao_tipo).toUpperCase(),
          dealPrice: a.preco, offerId: null, stock: estMin.get(`${a.promocao_id}|${a.mlb}`) ?? null, por: POR, acao: "auto-preco",
        });
        jaMexido.add(a.mlb); if (r.ok && !(r as any).ja_estava) vagas--;
        feitos.push({ etapa: "preco", mlb: a.mlb, sku: a.sku, promocao: a.promocao_nome ?? a.promocao_id, tipo: a.promocao_tipo, mc_pct: a.mc_pct_novo, sugerido: a.sug, preco: a.preco, ok: r.ok, ja_estava: (r as any).ja_estava ?? false, mensagem: r.mensagem });
      }
      const entraram = feitos.filter((f) => f.ok && !f.ja_estava);
      const falhas = feitos.filter((f) => !f.ok);
      if (entraram.length || falhas.length) {
        const brl = (v: number) => `R$ ${Number(v).toFixed(2).replace(".", ",")}`;
        const linha = (f: any) => {
          const base = `• ${f.sku ?? f.mlb} · ${f.promocao}${f.tipo === "LIGHTNING" ? " (Relâmpago)" : ""} · MC ${(Number(f.mc_pct) * 100).toFixed(1)}%`;
          const extra = f.etapa === "trocar" ? ` · trocou (saiu de ${f.de}, +${brl(f.ganho)}/un)`
            : f.etapa === "preco" ? ` · preço ${brl(f.preco)} (sugerido do ML ${brl(f.sugerido)})` : "";
          const erro = f.ok ? "" : ` — ${f.sem_promocao ? "FICOU SEM PROMOÇÃO · " : ""}${String(f.mensagem ?? "").slice(0, 90)}`;
          return base + extra + erro;
        };
        await fetch(`${SUPABASE_URL}/functions/v1/discord-notify`, {
          method: "POST", headers: { Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            canal: "atualizacoes", nivel: falhas.length ? "aviso" : "ok",
            titulo: `Promoções ML — entrada automática: ${entraram.length} anúncio(s)${falhas.length ? ` · ${falhas.length} recusa(s)` : ""}`,
            descricao: [...entraram.map(linha), ...falhas.map(linha)].join("\n").slice(0, 3900),
            rodape: `Regra: MC na promoção ≥ ${(minPct * 100).toFixed(0)}% (no sugerido ou no menor preço da faixa que alcança) · troca só de campanha em andamento · abaixo disso, confirmação na tela`,
          }),
        }).catch(() => {});
      }
      return json({ modulo, modo: modoR, entraram: entraram.length, ja_estavam: feitos.filter((f) => f.ja_estava).length, falhas: falhas.length, pendentes,
        trocas_puladas: trocasPuladas, avaliados_faixa: faixa.length, itens: feitos, ms: Date.now() - inicioA });
    }

    if (modulo === "trocar") {
      // v24: troca de promoção sugerida (outra dá MC melhor): sai da atual e entra na nova.
      // Relâmpago ativo não sai (regra do ML). Se a nova recusar, tenta voltar para a atual.
      const mlb = url.searchParams.get("mlb"); const de = url.searchParams.get("de_promocao_id"); const deTipo = (url.searchParams.get("de_tipo") || "").toUpperCase();
      const para = url.searchParams.get("para_promocao_id"); const paraTipo = (url.searchParams.get("para_tipo") || "").toUpperCase();
      const por = url.searchParams.get("por") || null;
      if (!mlb || !de || !deTipo || !para || !paraTipo) return json({ erro: "faltam mlb/de_promocao_id/de_tipo/para_promocao_id/para_tipo" }, { status: 400 });
      if (url.searchParams.get("confirmar") !== "1") return json({ erro: "exige confirmar=1" }, { status: 400 });
      const r = await trocarItem(supabase, token, {
        mlb, de, deTipo, para, paraTipo, dealPrice: num(url.searchParams.get("deal_price")), offerId: url.searchParams.get("offer_id"),
        stock: Number(url.searchParams.get("stock") || 0) || null, por,
      });
      return json({ ok: r.ok, mensagem: r.mensagem });
    }

    if (modulo === "item") {
      const mlb = url.searchParams.get("mlb");
      if (!mlb) return json({ erro: "faltam mlb" }, { status: 400 });
      const r = await mlGet(token, `/seller-promotions/items/${mlb}?app_version=v2`);
      if (r.status === 401) return json({ erro: "token ML expirado (rode ml-refresh-token)" }, { status: 401 });
      const promos = Array.isArray(r.body) ? r.body : [];
      const { data: anun } = await supabase.from("ml_anuncios").select("sku").eq("mlb", mlb).maybeSingle();
      const sku = (anun as any)?.sku ?? null;
      const det = await mlGet(token, `/items/${mlb}?attributes=${DET_ATTR}`);
      const b = det.body || {};
      const cat = b.category_id, lt = b.listing_type_id, logistic = shipLog(b), free = shipFree(b), sold = b.sold_quantity ?? null, dc = b.date_created ?? null;
      const medFallback = await freteMediana(supabase);
      let freteReal: number | null = null;
      if (sku) { const { data: fr } = await supabase.from("ml_frete_sku").select("frete_vendedor").eq("sku", sku).maybeSingle(); freteReal = (fr as any)?.frete_vendedor != null ? Number((fr as any).frete_vendedor) : null; }
      let adicionados = 0, jaTinha = 0, semId = 0;
      for (const p of promos) {
        if (!p.id) { semId++; continue; }
        await supabase.from("ml_promocoes").upsert({ promocao_id: p.id, tipo: p.type, nome: p.name ?? null, status: p.status ?? null, start_date: p.start_date ?? null, finish_date: p.finish_date ?? null }, { onConflict: "promocao_id", ignoreDuplicates: true });
        const { data: ex } = await supabase.from("ml_promocao_itens").select("mlb").eq("promocao_id", p.id).eq("mlb", mlb).maybeSingle();
        if (ex) { jaTinha++; continue; }
        const sug = num(p.suggested_discounted_price); const price = num(p.price);
        const promoPrice = sug ?? price;
        const comissaoPromo = promoPrice && cat && lt ? await saleFee(token, promoPrice, cat, lt) : null;
        const comissaoAtual = num(p.original_price) && cat && lt ? await saleFee(token, Number(p.original_price), cat, lt) : null;
        await supabase.from("ml_promocao_itens").insert({
          promocao_id: p.id, mlb, sku, status: p.status ?? "candidate", offer_id: p.offer_id ?? null,
          original_price: num(p.original_price), promo_price: promoPrice, preco_sugerido: sug, preco_min: num(p.min_discounted_price), preco_max: num(p.max_discounted_price),
          meli_percentage: p.meli_percentage ?? null, seller_percentage: p.seller_percentage ?? null,
          category_id: cat ?? null, listing_type_id: lt ?? null, logistic_type: logistic, free_shipping: free, sold_quantity: sold, date_created: dc,
          comissao_promo: comissaoPromo, comissao_atual: comissaoAtual, frete_vendedor: freteReal ?? medFallback, frete_estimado: freteReal == null,
          estoque_min: p.stock?.min ?? null, estoque_max: p.stock?.max ?? null, item_inicio: p.start_date ?? null, item_fim: p.finish_date ?? null,
          atualizado_em: new Date().toISOString(),
        });
        adicionados++;
      }
      return json({ modulo: "item", mlb, promos: promos.length, adicionados, ja_tinha: jaTinha, sem_campanha: semId });
    }

    if (modulo === "simular") {
      const mlb = url.searchParams.get("mlb"); const promocaoId = url.searchParams.get("promocao_id"); const preco = Number(url.searchParams.get("preco") || "0");
      if (!mlb || !promocaoId || !preco) return json({ erro: "faltam mlb/promocao_id/preco" }, { status: 400 });
      const { data: v } = await supabase.from("view_ml_promocoes").select("cmv, frete, aliquota, category_id, listing_type_id").eq("promocao_id", promocaoId).eq("mlb", mlb).maybeSingle();
      if (!v) return json({ erro: "item nao encontrado" }, { status: 404 });
      const comissao = await saleFee(token, preco, (v as any).category_id, (v as any).listing_type_id);
      const cmv = (v as any).cmv != null ? Number((v as any).cmv) : null;
      const frete = Number((v as any).frete ?? 0);
      const aliquota = Number((v as any).aliquota ?? 0.10);
      const imposto = +(preco * aliquota).toFixed(2);
      const mc = comissao != null && cmv != null ? +(preco - comissao - frete - imposto - cmv).toFixed(2) : null;
      return json({ modulo, mlb, preco, comissao, cmv, frete, imposto, mc, mc_pct: mc != null ? +(mc / preco).toFixed(4) : null });
    }

    if (modulo === "aplicar" || modulo === "remover") {
      const mlb = url.searchParams.get("mlb"); const promocaoId = url.searchParams.get("promocao_id"); const tipo = (url.searchParams.get("tipo") || "").toUpperCase();
      const por = url.searchParams.get("por") || null;
      if (!mlb || !promocaoId || !tipo) return json({ erro: "faltam mlb/promocao_id/tipo" }, { status: 400 });
      if (url.searchParams.get("confirmar") !== "1") return json({ erro: "exige confirmar=1 (acao irreversivel)" }, { status: 400 });
      const registrar = async (enviado: unknown, r: { status: number; ok: boolean; body: any } | null, mensagem: string | null, ok: boolean) => {
        await supabase.from("ml_promocao_acoes").insert({ mlb, promocao_id: promocaoId, tipo, acao: modulo, enviado, http_status: r?.status ?? null, ok, mensagem, resposta: r?.body ?? null, por });
      };
      if (modulo === "remover") {
        const r = await mlSend(token, "DELETE", `/seller-promotions/items/${mlb}?promotion_id=${promocaoId}&promotion_type=${tipo}&app_version=v2`);
        if (r.ok) await supabase.from("ml_promocao_itens").update({ status: "candidate" }).eq("promocao_id", promocaoId).eq("mlb", mlb);
        const msg = r.ok ? null : motivoML(r.body);
        await registrar({ promotion_id: promocaoId, promotion_type: tipo }, r, msg, r.ok);
        return json({ modulo, mlb, ok: r.ok, mensagem: msg, status: r.status, body: r.body });
      }

      const r = await aplicarItem(supabase, token, {
        mlb, promocaoId, tipo, dealPrice: num(url.searchParams.get("deal_price")), offerId: url.searchParams.get("offer_id"),
        stock: Number(url.searchParams.get("stock") || 0) || null, por,
      });
      if ((r as any).http === 401) return json({ ok: false, mensagem: r.mensagem }, { status: 401 });
      return json({ modulo, mlb, ...r });
    }

    // ---------- SYNC ----------
    const MAX_ITENS = Math.min(80, parseInt(url.searchParams.get("max") || "40", 10));
    const freshHoras = Math.max(0, parseInt(url.searchParams.get("fresh_h") || "12", 10));
    const inicio = Date.now();
    const promosR = await mlGet(token, `/seller-promotions/users/${seller}?app_version=v2`);
    const promos = (promosR.body?.results || []) as any[];
    for (const p of promos) {
      await supabase.from("ml_promocoes").upsert({
        promocao_id: p.id, tipo: p.type, nome: p.name ?? null, status: p.status ?? null,
        start_date: p.start_date ?? null, finish_date: p.finish_date ?? null, deadline_date: p.deadline_date ?? null,
        atualizado_em: new Date().toISOString(),
      }, { onConflict: "promocao_id" });
    }
    const { data: freteRows } = await supabase.from("ml_frete_sku").select("sku, frete_vendedor");
    const freteMap = new Map<string, number>((freteRows ?? []).map((r: any) => [r.sku, Number(r.frete_vendedor)]));
    const medFallback = await freteMediana(supabase);

    const started: Item[] = [];
    const candByPromo: Item[][] = [];
    let limpos = 0;
    for (const p of promos) {
      const st = await coletarItens(token, p.id, p.type, "started", 120);
      // v22: candidatas de Relâmpago vêm do modulo=relampago (só anúncios com venda em 30d)
      const ehRelampago = String(p.type).toUpperCase() === "LIGHTNING";
      const cd = ehRelampago ? [] : await coletarItens(token, p.id, p.type, "candidate", 120);
      started.push(...st);
      candByPromo.push(cd);
      // v19: listagem COMPLETA (abaixo do teto) → candidata que o ML não lista mais
      // (nem como ativa) saiu da campanha: apaga, senão vira clique com erro na tela.
      if (!ehRelampago && cd.length < 120 && st.length < 120) {
        const vivos = new Set([...st, ...cd].map((i) => i.mlb));
        // só linhas paradas há 7+ dias: as que o botão "Elegíveis do item" trouxe (fora do
        // listing curado da campanha) sobrevivem enquanto forem recentes.
        const seteDias = new Date(Date.now() - 7 * 86400e3).toISOString();
        const { data: nossos } = await supabase.from("ml_promocao_itens").select("mlb").eq("promocao_id", p.id).eq("status", "candidate").lt("atualizado_em", seteDias);
        const velhos = ((nossos ?? []) as any[]).map((r) => r.mlb).filter((m) => !vivos.has(m));
        for (let k = 0; k < velhos.length; k += 100) {
          await supabase.from("ml_promocao_itens").delete().eq("promocao_id", p.id).eq("status", "candidate").in("mlb", velhos.slice(k, k + 100));
        }
        limpos += velhos.length;
      }
    }
    // campanha vencida: o ML para de listar e ela ficava "started" na tela para sempre
    const { data: vencidas } = await supabase.from("ml_promocoes").update({ status: "finished", atualizado_em: new Date().toISOString() })
      .lt("finish_date", new Date().toISOString()).neq("status", "finished").select("promocao_id");
    for (const v of (vencidas ?? []) as any[]) await supabase.from("ml_promocao_itens").delete().eq("promocao_id", v.promocao_id);
    const candidates: Item[] = [];
    for (let idx = 0, add = true; add; idx++) { add = false; for (const arr of candByPromo) { if (arr[idx]) { candidates.push(arr[idx]); add = true; } } }
    let ordem = [...started, ...candidates];
    const cutoff = new Date(Date.now() - freshHoras * 3600e3).toISOString();
    const { data: fresh } = await supabase.from("ml_promocao_itens").select("promocao_id, mlb").gt("atualizado_em", cutoff);
    const skip = new Set<string>((fresh ?? []).map((r: any) => `${r.promocao_id}|${r.mlb}`));
    ordem = ordem.filter((i) => !skip.has(`${i.promocao_id}|${i.mlb}`)).slice(0, MAX_ITENS);

    const mlbs = [...new Set(ordem.map((i) => i.mlb))];
    const skuMap = new Map<string, string>();
    for (let k = 0; k < mlbs.length; k += 200) {
      const { data } = await supabase.from("ml_anuncios").select("mlb, sku").in("mlb", mlbs.slice(k, k + 200));
      for (const r of (data ?? []) as any[]) if (r.sku) skuMap.set(r.mlb, r.sku);
    }
    const detMap = new Map<string, { cat: string; lt: string; logistic: string | null; free: boolean | null; sold: number | null; dc: string | null }>();
    for (let k = 0; k < mlbs.length; k += 20) {
      const r = await mlGet(token, `/items?ids=${mlbs.slice(k, k + 20).join(",")}&attributes=${DET_ATTR}`);
      for (const e of (r.body || []) as any[]) { const b = e.body; if (b?.id) detMap.set(b.id, { cat: b.category_id, lt: b.listing_type_id, logistic: shipLog(b), free: shipFree(b), sold: b.sold_quantity ?? null, dc: b.date_created ?? null }); }
    }
    let gravados = 0, semTempo = 0;
    for (const i of ordem) {
      if (Date.now() - inicio > 24000) { semTempo++; continue; }
      const det = detMap.get(i.mlb); const sku = skuMap.get(i.mlb) ?? null;
      const comissaoPromo = det && i.promo_price ? await saleFee(token, i.promo_price, det.cat, det.lt) : null;
      const comissaoAtual = det && i.original_price ? await saleFee(token, i.original_price, det.cat, det.lt) : null;
      const freteReal = sku && freteMap.has(sku) ? freteMap.get(sku)! : null;
      await supabase.from("ml_promocao_itens").upsert({
        promocao_id: i.promocao_id, mlb: i.mlb, sku, status: i.status, offer_id: i.offer_id,
        original_price: i.original_price, promo_price: i.promo_price, preco_sugerido: i.sugerido, preco_min: i.pmin, preco_max: i.pmax,
        meli_percentage: i.meli, seller_percentage: i.seller,
        category_id: det?.cat ?? null, listing_type_id: det?.lt ?? null,
        logistic_type: det?.logistic ?? null, free_shipping: det?.free ?? null, sold_quantity: det?.sold ?? null, date_created: det?.dc ?? null,
        comissao_promo: comissaoPromo, comissao_atual: comissaoAtual,
        frete_vendedor: freteReal ?? medFallback, frete_estimado: freteReal == null,
        estoque_min: i.estMin, estoque_max: i.estMax, item_inicio: i.ini, item_fim: i.fim,
        atualizado_em: new Date().toISOString(),
      }, { onConflict: "promocao_id,mlb" });
      gravados++;
    }
    for (const p of promos) {
      const { count } = await supabase.from("ml_promocao_itens").select("mlb", { count: "exact", head: true }).eq("promocao_id", p.id);
      await supabase.from("ml_promocoes").update({ n_itens: count ?? 0 }).eq("promocao_id", p.id);
    }
    return json({ modulo: "sync", promos: promos.length, limpos, encerradas: (vencidas ?? []).length, started: started.length, candidatos: candidates.length, processados: ordem.length, gravados, semTempo, ms: Date.now() - inicio });
  } catch (e) {
    return json({ erro: (e as Error).message }, { status: 500 });
  }
});
