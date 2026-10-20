// ============================================================================
// Edge Function: amazon-inbound v8 (20/out/2026; ACZ liberada + modelos de caixa do histórico) — envio ao FBA pela API (Fulfillment Inbound v2024-03-20)
// ----------------------------------------------------------------------------
// Pedido do dono: na aba Fulfillment › REPOSIÇÃO, os produtos escolhidos viram o plano de envio na Amazon,
// com as caixas preenchidas pelos MODELOS (amazon_modelo_caixa), parando para a pessoa escolher o centro de
// destino e o transporte; confirmado o transporte, o envio nasce sozinho na aba Envios (v6) e a nota de remessa
// segue no Seller Central. As DUAS contas (v8, 20/out/2026: o app da ACZ, "Ottz Analytics", ganhou o papel de envios —
// a leitura dos envios v0 da ACZ passou a responder às 8h05 de 20/out; até 19/out dava 403).
//
// POST body {modulo, ...} — exige sessão de usuário com o módulo `galpao` (ou service role):
//   lista              → planos dos últimos 30 dias (andamento, resumo). Só leitura.
//   previa             → {empresa, itens:[{sku, quantidade, msku?, titulo?}]} ou {plano}: itens × anúncio da
//                        Amazon (msku) × modelo de caixa; pendências. Só leitura.
//   avancar            → {empresa, itens, confirmar: true} cria o plano; {plano} continua de onde parou.
//                        Até ~22 s por chamada; a tela repete até "escolher_destino".
//   confirmar-destino  → {plano, opcao_id, confirmar: true}: confirma o centro de destino (pode ter taxa).
//   cancelar           → {plano, confirmar: true}: cancela o plano na Amazon.
// Regras: cada escrita na Amazon é feita UMA vez (o passo e o operationId são gravados logo depois da
// resposta; nada é repetido sozinho). O andamento fica em amazon_envio_plano (id próprio, log por passo).
// v4: o plano nasce na Reposição (antes: dependia de um envio do app — lógica errada, apontada pelo dono).
// v5 (19/out/2026): TRANSPORTE pela API. Quando a etapa 2 começa pela API (o app confirmou o destino), o Seller
//   Central TRAVA ("Não é possível continuar… generatePlacementOptions, generateTransportationOptions,
//   confirmPlacementOption e confirmTransportationOptions devem ser chamadas") — 1º caso: wf44bb679e, 19/out.
//   transporte           → {plano, pronto_em?: "AAAA-MM-DD"}: gera as opções de transporte (só cotação) e lista
//                          por envio (transportadora, modo, quem contrata, custo, pré-condições).
//   confirmar-transporte → {plano, escolhas: {shipmentId: transportationOptionId}, confirmar: true}.
//   As opções ficam em envios_amazon[].transporte_opcoes (sem coluna nova).
// v6 (19/out/2026): ENVIO NO APP. Transporte confirmado → cria um envio na aba Fulfillment › Envios por envio da Amazon
//   (fulfillment_envios + itens de listShipmentItems) e anexa as etiquetas das CAIXAS (v0 getLabels, PackageLabel_Thermal
//   10×15) e as de PRODUTO (createMarketplaceItemLabels, térmica 50×25 mm, só itens com labelOwner SELLER).
//   envios-app       → {plano, dry?}: idempotente (envio achado pelo número FBA; documento achado pelo nome); retoma de onde
//                      parou se o tempo acabar (`faltam`). dry = só lê e baixa as etiquetas, não grava nada.
//   A nota de remessa é emitida pela Amazon (regime especial) e pela API exige o papel "Tax Invoicing (Restricted)" — hoje
//   403 nas duas contas: anexar o DANFE à mão até o papel sair.
// v7 (19/out/2026): ENVIOS JÁ CRIADOS NA AMAZON (Seller Central) e RECEBIMENTO (API v0 de envios):
//   amazon-envios → {empresa, dias?=45}: envios da conta atualizados no período (nome, status, CD) e se
//                   já estão na aba Envios (pelo número FBA). Só leitura.
//   importar      → {empresa, ids:[FBA…], confirmar: true}: cria na aba Envios os escolhidos (itens = SellerSKU × enviado).
//   recebimento   → {empresa, numero}: por SKU, enviado × recebido AO VIVO + status do envio. Só leitura.
//   Conta sem o papel de envios no app da Amazon → 403: a resposta diz o que falta.
// v8 (20/out/2026, pedido do dono "liberar tudo do Full Amazon" para a ACZ): tirada a pendência fixa "por enquanto só a
//   SVL" da prévia e:
//   modelos-importar → {empresa, planos?=40, dry?}: lê as CAIXAS dos últimos planos enviados da conta (listInboundPlans
//                      SHIPPED + listInboundPlanBoxes) e cria em amazon_modelo_caixa um modelo por anúncio (msku) com a
//                      caixa mais usada (só caixas de um anúncio só; validade = a mais recente vista). NÃO mexe em modelo
//                      que já existe (o cadastrado à mão vale mais). dry = só mostra o que criaria.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT = "A2Q3Y263D00KWC";
const API = "/inbound/fba/2024-03-20";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// conta da Amazon pela empresa do envio
const CONTA: Record<string, { shop_id: number; nome: string }> = {
  "SVL Store": { shop_id: 900002, nome: "Amazon · SVL" },
  "ACZ Pet": { shop_id: 900001, nome: "Amazon · ACZ Pet" },
};
// endereço de saída (decisão do dono, 14/out: Caieiras)
const ORIGEM = {
  name: "Renan Sevilha Marangoni", companyName: "Ottz [caieiras]", addressLine1: "Rua São Cristóvão 62", city: "Caieiras",
  stateOrProvinceCode: "SP", countryCode: "BR", postalCode: "07700025", phoneNumber: "64999103551", email: "renansevilha@ottzpet.com.br",
};

// passo que espera uma operação da Amazon → passo seguinte quando ela termina bem
const DEPOIS: Record<string, string> = {
  criando: "gerar_embalagem",
  gerando_embalagem: "escolher_embalagem",
  confirmando_embalagem: "caixas",
  enviando_caixas: "gerar_destinos",
  gerando_destinos: "ler_destinos",
  confirmando_destino: "ler_envios",
  gerando_transporte: "ler_transporte",
  confirmando_transporte: "transporte_confirmado",
  cancelando: "cancelado",
};
const PARADOS = new Set(["escolher_destino", "destino_confirmado", "escolher_transporte", "transporte_confirmado", "cancelado", "erro"]);
// rota de ensaio: gerar/ler opções de transporte com a chave publicável (só cotação, nada é confirmado) — morre sozinha
const ENSAIO_ATE = Date.parse("2026-10-22T03:00:00Z"); // v8: ensaio de leitura da ACZ (prévia, envios, modelos dry)

// ---------------------------------------------------------------- acesso
type Quem = { nome: string | null };
async function exigirAcesso(req: Request, modulo = ""): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { nome: "sistema" };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { nome: "sistema" };
  if (pl.role === "anon" && Date.now() < ENSAIO_ATE && ["previa", "amazon-envios", "recebimento", "modelos-importar"].includes(modulo)) return { nome: "ensaio" };
  if (pl.role !== "authenticated") return json({ ok: false, erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "galpao" });
  if (error || data !== true) return json({ ok: false, erro: "sem acesso ao módulo do galpão" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

// ---------------------------------------------------------------- Amazon
async function tokenConta(shopId: number): Promise<string> {
  const { data } = await db.from("oauth_tokens_amazon").select("access_token, expires_at").eq("shop_id", shopId).maybeSingle();
  if (!data?.access_token) throw new Error("conta da Amazon sem token");
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token da Amazon vencido — a renovação roda a cada 20 min; tente de novo em instantes");
  return String(data.access_token);
}
type Resp = { status: number; body: Record<string, any> | null };
async function sp(token: string, metodo: string, caminho: string, corpo?: unknown): Promise<Resp> {
  const r = await fetch(`${SPAPI}${caminho}`, {
    method: metodo,
    headers: { "x-amz-access-token": token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: unknown = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { _raw: txt.slice(0, 400) }; }
  return { status: r.status, body: body as Record<string, any> | null };
}
const ok = (r: Resp) => r.status >= 200 && r.status < 300;
function motivo(r: Resp): string {
  const e = (r.body?.errors ?? []) as any[];
  return (e.map((x) => `${x.code ?? ""}: ${x.message ?? ""}${x.details ? ` (${x.details})` : ""}`).join(" · ") || `HTTP ${r.status}`).slice(0, 500);
}

// ---------------------------------------------------------------- dados do envio
type Linha = {
  sku: string; msku: string | null; titulo: string | null; quantidade: number;
  modelo: Record<string, any> | null; caixas: number | null; validade: string | null; problema: string | null;
  anuncios: string[]; // anúncios (msku) deste SKU no FBA da conta — a tela deixa escolher quando há mais de um
};
type Entrada = { sku: string; quantidade: number; msku?: string | null; titulo?: string | null };
async function montar(empresa: string | null, entrada: Entrada[]) {
  const conta = CONTA[String(empresa ?? "")] ?? CONTA["ACZ Pet"];
  const itens = entrada.filter((i) => i && i.sku && Number(i.quantidade) > 0);
  const skus = [...new Set(itens.map((i) => String(i.sku)))];
  const [estq, mods, prods] = await Promise.all([
    db.from("estoque_fulfillment").select("sku, sku_marketplace").eq("marketplace", "amazon").eq("shop_id", conta.shop_id).in("sku", skus.length ? skus : ["-"]),
    db.from("amazon_modelo_caixa").select("*").eq("shop_id", conta.shop_id),
    db.from("produtos").select("sku, nome").in("sku", skus.length ? skus : ["-"]),
  ]);
  const modelos = new Map(((mods.data ?? []) as any[]).map((m) => [String(m.msku), m]));
  const nomes = new Map(((prods.data ?? []) as any[]).map((p) => [String(p.sku), String(p.nome ?? "")]));
  const anuncios = new Map<string, string[]>();
  for (const e of (estq.data ?? []) as any[]) anuncios.set(String(e.sku), [...(anuncios.get(String(e.sku)) ?? []), String(e.sku_marketplace)]);

  const linhas: Linha[] = itens.map((i) => {
    const sku = String(i.sku);
    const qtd = Math.floor(Number(i.quantidade));
    const ops = [...new Set(anuncios.get(sku) ?? [])];
    let msku: string | null = i.msku ? String(i.msku) : null;
    let problema: string | null = null;
    if (!msku) {
      const comModelo = ops.filter((o) => modelos.has(o));
      msku = ops.length === 1 ? ops[0] : comModelo.length === 1 ? comModelo[0] : null;
      if (!msku) problema = ops.length ? `o SKU tem ${ops.length} anúncios nesta conta (${ops.join(", ")}): escolha qual na lista` : "não achei o anúncio deste SKU no FBA desta conta";
    }
    const modelo = msku ? modelos.get(msku) ?? null : null;
    let caixas: number | null = null;
    if (msku && !modelo) problema = "sem modelo de caixa: cadastre em \"Modelos de caixa\"";
    if (modelo) {
      const un = Number(modelo.un_por_caixa);
      if (qtd % un !== 0) problema = `${qtd} unidades não fecham caixas de ${un} (o modelo "${modelo.nome ?? ""}" leva ${un})`;
      else caixas = qtd / un;
    }
    return { sku, msku, titulo: i.titulo ?? nomes.get(sku) ?? null, quantidade: qtd, modelo, caixas, validade: modelo?.validade ?? null, problema, anuncios: ops };
  });
  const repetidos = linhas.filter((l, k) => l.msku && linhas.findIndex((x) => x.msku === l.msku) !== k).map((l) => l.msku);
  const pendencias = [
    ...linhas.filter((l) => l.problema).map((l) => `${l.sku}: ${l.problema}`),
    ...(linhas.length === 0 ? ["nenhum produto com quantidade"] : []),
    ...(repetidos.length ? [`anúncio repetido: ${[...new Set(repetidos)].join(", ")} — junte as quantidades num item só`] : []),
  ];
  const avisos = linhas.filter((l) => l.msku && !l.validade).map((l) => `${l.sku}: sem validade no modelo — se o produto exigir (areia exige), a Amazon recusa o plano`);
  return { conta, linhas, pendencias, avisos };
}
async function lerPlano(id: string) {
  const { data } = await db.from("amazon_envio_plano").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Error("plano não encontrado");
  return data as Record<string, any>;
}

// ---------------------------------------------------------------- estado
async function salvar(planoRef: string, patch: Record<string, unknown>, registro?: Record<string, unknown>) {
  const set: Record<string, unknown> = { ...patch, atualizado_em: new Date().toISOString() };
  if (registro) {
    const { data } = await db.from("amazon_envio_plano").select("log").eq("id", planoRef).maybeSingle();
    const log = Array.isArray(data?.log) ? data!.log as unknown[] : [];
    set.log = [...log, { em: new Date().toISOString(), ...registro }].slice(-60);
  }
  const { data: linha } = await db.from("amazon_envio_plano").update(set).eq("id", planoRef).select("*").single();
  return linha as Record<string, any>;
}
/** Dispara UMA escrita assíncrona: grava o passo de espera e o operationId logo depois da resposta. */
async function disparar(planoRef: string, token: string, metodo: string, caminho: string, corpo: unknown, passoEspera: string, acao: string) {
  const r = await sp(token, metodo, caminho, corpo);
  if (!ok(r) || !r.body?.operationId) {
    return await salvar(planoRef, { passo: "erro", erro: `${acao}: a Amazon recusou — ${motivo(r)}`, operacao_id: null }, { acao, http: r.status, erro: motivo(r) });
  }
  const extra: Record<string, unknown> = r.body?.inboundPlanId ? { plano_id: String(r.body.inboundPlanId) } : {};
  return await salvar(planoRef, { passo: passoEspera, operacao_id: String(r.body.operationId), erro: null, ...extra }, { acao, http: r.status, operacao: r.body.operationId });
}

// ---------------------------------------------------------------- envio no app (aba Envios)
const DOCS_BUCKET = "fulfillment-docs";
const diaBRT = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) - 3 * 3600000).toISOString().slice(0, 10) : null);
async function baixarPdf(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
/** Etiquetas das caixas (v0 getLabels): o link vale 15 s, então baixa na hora. */
async function etiquetasCaixas(token: string, fba: string, caixas: string[]): Promise<Uint8Array> {
  const q = new URLSearchParams({ PageType: "PackageLabel_Thermal", LabelType: "UNIQUE", PackageLabelsToPrint: caixas.join(",") });
  const r = await sp(token, "GET", `/fba/inbound/v0/shipments/${encodeURIComponent(fba)}/labels?${q}`);
  const url = r.body?.payload?.DownloadURL;
  if (!ok(r) || !url) throw new Error(`etiquetas das caixas: ${motivo(r)}`);
  return await baixarPdf(String(url));
}
/** Etiquetas de produto (FNSKU), térmicas 50×25 mm, das unidades que o vendedor etiqueta. */
async function etiquetasProduto(token: string, mskus: { msku: string; quantity: number }[]): Promise<Uint8Array> {
  const r = await sp(token, "POST", `${API}/items/labels`, {
    marketplaceId: MKT, labelType: "THERMAL_PRINTING", width: 50, height: 25, localeCode: "pt_BR", mskuQuantities: mskus,
  });
  const url = ((r.body?.documentDownloads ?? []) as any[])[0]?.uri;
  if (!ok(r) || !url) throw new Error(`etiquetas de produto: ${motivo(r)}`);
  return await baixarPdf(String(url));
}
async function anexarDoc(envioId: string, tipo: string, nome: string, bytes: Uint8Array, por: string | null) {
  const { data: ja } = await db.from("fulfillment_envio_docs").select("id").eq("envio_id", envioId).eq("nome", nome).limit(1);
  if (ja?.length) return "ja_tinha";
  const caminho = `${envioId}/${crypto.randomUUID().slice(0, 8)}-${nome.replace(/[^A-Za-z0-9._-]+/g, "_")}`;
  const { error: eUp } = await db.storage.from(DOCS_BUCKET).upload(caminho, bytes, { contentType: "application/pdf", upsert: false });
  if (eUp) throw new Error(`storage: ${eUp.message}`);
  const { error } = await db.from("fulfillment_envio_docs").insert({
    envio_id: envioId, tipo, nome, mime: "application/pdf", tamanho: bytes.length, storage_path: caminho, criado_por: por,
  });
  if (error) { await db.storage.from(DOCS_BUCKET).remove([caminho]); throw new Error(`banco: ${error.message}`); }
  return "anexado";
}

// ---------------------------------------------------------------- envios já criados na Amazon (API v0)
const SEM_PAPEL = "a conta não tem o papel de envios (Amazon Fulfillment) no aplicativo da Amazon — o app precisa ganhar o papel e a conta ser autorizada de novo";
const STATUS_V0 = ["WORKING", "READY_TO_SHIP", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING", "CLOSED"];
const STATUS_APP: Record<string, string> = { WORKING: "separando", READY_TO_SHIP: "pronto_envio" }; // o resto já saiu: enviado
const STATUS_PT: Record<string, string> = {
  WORKING: "em preparação", READY_TO_SHIP: "pronto para enviar", SHIPPED: "enviado", IN_TRANSIT: "em trânsito", DELIVERED: "entregue no CD",
  CHECKED_IN: "conferido na chegada", RECEIVING: "recebendo", CLOSED: "fechado (recebido)", CANCELLED: "cancelado", DELETED: "excluído",
};
async function v0Envios(token: string, filtro: string, ate: number): Promise<any[] | null> {
  const out: any[] = [];
  let next = "";
  for (let pag = 0; pag < 10 && Date.now() < ate; pag++) {
    const r = await sp(token, "GET", next
      ? `/fba/inbound/v0/shipments?MarketplaceId=${MKT}&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(next)}`
      : `/fba/inbound/v0/shipments?MarketplaceId=${MKT}&${filtro}`);
    if (r.status === 403) return null;
    if (r.status === 429) { await sleep(1500); pag--; continue; }
    if (!ok(r)) throw new Error(`envios da Amazon: ${motivo(r)}`);
    out.push(...((r.body?.payload?.ShipmentData ?? []) as any[]));
    next = String(r.body?.payload?.NextToken ?? "");
    if (!next) break;
    await sleep(500);
  }
  return out;
}
async function v0Itens(token: string, fba: string): Promise<any[] | null> {
  const out: any[] = [];
  let next = "";
  const vistos = new Set<string>();
  for (let pag = 0; pag < 5; pag++) {
    // a continuação NÃO é o mesmo endereço com NextToken (devolvia a 1ª página de novo e cada item saía 5×):
    // é o /shipmentItems com QueryType=NEXT_TOKEN
    const caminho = next
      ? `/fba/inbound/v0/shipmentItems?MarketplaceId=${MKT}&QueryType=NEXT_TOKEN&NextToken=${encodeURIComponent(next)}`
      : `/fba/inbound/v0/shipments/${encodeURIComponent(fba)}/items?MarketplaceId=${MKT}`;
    let r = await sp(token, "GET", caminho);
    if (r.status === 429) { await sleep(1500); r = await sp(token, "GET", caminho); }
    if (r.status === 403) return null;
    if (!ok(r)) throw new Error(`itens do envio ${fba}: ${motivo(r)}`);
    for (const it of (r.body?.payload?.ItemData ?? []) as any[]) {
      const k = `${it.ShipmentId ?? fba}|${it.SellerSKU ?? ""}|${it.FulfillmentNetworkSKU ?? ""}`;
      if (vistos.has(k)) continue; // um SKU aparece uma vez por envio
      vistos.add(k);
      out.push(it);
    }
    const prox = String(r.body?.payload?.NextToken ?? "");
    if (!prox || prox === next) break;
    next = prox;
  }
  return out;
}
/** SKU da Amazon → nosso SKU: estoque do FBA da conta (o mesmo de-para da reposição), senão tira _FBA/FBA-. */
async function mapaSkus(shopId: number) {
  const { data } = await db.from("estoque_fulfillment").select("sku, sku_marketplace").eq("marketplace", "amazon").eq("shop_id", shopId);
  const m = new Map(((data ?? []) as any[]).filter((x) => x.sku).map((x) => [String(x.sku_marketplace), String(x.sku)]));
  return (cru: string) => m.get(cru) ?? cru.replace(/^FBA-/i, "").replace(/[-_](FBA|FBAA|FBM)$/i, "").trim();
}

// ---------------------------------------------------------------- passos
async function prepConstraints(token: string, mskus: string[]) {
  const q = mskus.map((m) => `mskus=${encodeURIComponent(m)}`).join("&");
  const r = await sp(token, "GET", `${API}/items/prepDetails?marketplaceId=${MKT}&${q}`);
  const m = new Map<string, { labelOwner: string; prepOwner: string }>();
  for (const d of ((r.body?.mskuPrepDetails ?? []) as any[])) {
    const label = d.labelOwnerConstraint === "AMAZON_ONLY" ? "AMAZON" : d.labelOwnerConstraint === "NONE_ONLY" ? "NONE" : "SELLER";
    const prep = d.prepOwnerConstraint === "AMAZON_ONLY" ? "AMAZON" : d.prepOwnerConstraint === "SELLER_ONLY" ? "SELLER" : "NONE";
    m.set(String(d.msku), { labelOwner: label, prepOwner: prep });
  }
  return m;
}

async function passo(plano: Record<string, any>, token: string, planoRef: string, ate: number): Promise<Record<string, any>> {
  const id = String(plano.plano_id ?? "");
  const itens = (plano.itens ?? []) as Linha[];
  // esperando uma operação
  if (plano.operacao_id && DEPOIS[plano.passo]) {
    while (Date.now() < ate) {
      const o = await sp(token, "GET", `${API}/operations/${plano.operacao_id}`);
      const st = String(o.body?.operationStatus ?? "");
      if (st === "SUCCESS") return await salvar(planoRef, { passo: DEPOIS[plano.passo], operacao_id: null }, { acao: `${plano.passo}: concluído` });
      if (st === "FAILED") {
        const probs = ((o.body?.operationProblems ?? []) as any[]).map((p) => `${p.code ?? ""}: ${p.message ?? ""}${p.details ? ` (${p.details})` : ""}`).join(" · ");
        return await salvar(planoRef, { passo: "erro", operacao_id: null, erro: `${plano.passo}: ${probs || "operação falhou"}` }, { acao: `${plano.passo}: falhou`, erro: probs });
      }
      await sleep(1500);
    }
    return plano; // ainda em andamento: a tela chama de novo
  }
  switch (plano.passo) {
    case "gerar_embalagem":
      return await disparar(planoRef, token, "POST", `${API}/inboundPlans/${id}/packingOptions`, {}, "gerando_embalagem", "gerar opções de embalagem");
    case "escolher_embalagem": {
      const r = await sp(token, "GET", `${API}/inboundPlans/${id}/packingOptions`);
      const ops = ((r.body?.packingOptions ?? []) as any[]).filter((p) => p.status === "OFFERED");
      if (!ops.length) return await salvar(planoRef, { passo: "erro", erro: `a Amazon não ofereceu embalagem (${motivo(r)})` });
      const taxa = (p: any) => ((p.fees ?? []) as any[]).reduce((s, f) => s + Number(f?.value?.amount ?? 0), 0);
      const esc = [...ops].sort((a, b) => taxa(a) - taxa(b) || (a.packingGroups?.length ?? 0) - (b.packingGroups?.length ?? 0))[0];
      await salvar(planoRef, { caixas: { packing_option: esc.packingOptionId, grupos: esc.packingGroups ?? [], taxa: taxa(esc) } }, { acao: "embalagem escolhida", opcoes: ops.length, taxa: taxa(esc) });
      return await disparar(planoRef, token, "POST", `${API}/inboundPlans/${id}/packingOptions/${esc.packingOptionId}/confirmation`, {}, "confirmando_embalagem", "confirmar embalagem");
    }
    case "caixas": {
      const grupos = ((plano.caixas?.grupos ?? []) as string[]);
      const prep = await prepConstraints(token, itens.map((l) => String(l.msku)));
      const porMsku = new Map(itens.map((l) => [String(l.msku), l]));
      const packageGroupings: any[] = [];
      for (const g of grupos) {
        const r = await sp(token, "GET", `${API}/inboundPlans/${id}/packingGroups/${g}/items`);
        if (!ok(r)) return await salvar(planoRef, { passo: "erro", erro: `ler os itens do grupo de embalagem: ${motivo(r)}` });
        const boxes: any[] = [];
        for (const it of ((r.body?.items ?? []) as any[])) {
          const l = porMsku.get(String(it.msku));
          const m = l?.modelo;
          if (!l || !m) return await salvar(planoRef, { passo: "erro", erro: `a Amazon pôs no grupo o anúncio ${it.msku}, que não está no envio` });
          const un = Number(m.un_por_caixa);
          const qtd = Number(it.quantity);
          if (qtd % un !== 0) return await salvar(planoRef, { passo: "erro", erro: `${it.msku}: ${qtd} unidades no grupo não fecham caixas de ${un}` });
          const p = prep.get(String(it.msku)) ?? { labelOwner: "SELLER", prepOwner: "NONE" };
          boxes.push({
            contentInformationSource: "BOX_CONTENT_PROVIDED",
            dimensions: { unitOfMeasurement: "CM", length: Number(m.comprimento_cm), width: Number(m.largura_cm), height: Number(m.altura_cm) },
            weight: { unit: "KG", value: Number(m.peso_kg) },
            quantity: qtd / un,
            items: [{ msku: String(it.msku), quantity: un, labelOwner: p.labelOwner, prepOwner: p.prepOwner, ...(l.validade ? { expiration: l.validade } : {}) }],
          });
        }
        packageGroupings.push({ packingGroupId: g, boxes });
      }
      await salvar(planoRef, { caixas: { ...(plano.caixas ?? {}), enviadas: packageGroupings } });
      return await disparar(planoRef, token, "POST", `${API}/inboundPlans/${id}/packingInformation`, { packageGroupings }, "enviando_caixas", "informar caixas");
    }
    case "gerar_destinos":
      return await disparar(planoRef, token, "POST", `${API}/inboundPlans/${id}/placementOptions`, {}, "gerando_destinos", "gerar opções de destino");
    case "ler_destinos": {
      const r = await sp(token, "GET", `${API}/inboundPlans/${id}/placementOptions`);
      const ops = ((r.body?.placementOptions ?? []) as any[]).filter((p) => p.status === "OFFERED");
      if (!ops.length) return await salvar(planoRef, { passo: "erro", erro: `a Amazon não ofereceu destino (${motivo(r)})` });
      const cds = new Map<string, any>();
      for (const sid of [...new Set(ops.flatMap((p) => (p.shipmentIds ?? []) as string[]))]) {
        const s = await sp(token, "GET", `${API}/inboundPlans/${id}/shipments/${sid}`);
        cds.set(sid, { cd: s.body?.destination?.warehouseId ?? null, cidade: s.body?.destination?.address?.city ?? null });
        await sleep(300);
      }
      const destinos = ops.map((p) => ({
        id: String(p.placementOptionId),
        expira: p.expiration ?? null,
        taxa: ((p.fees ?? []) as any[]).reduce((s, f) => s + Number(f?.value?.amount ?? 0), 0),
        desconto: ((p.discounts ?? []) as any[]).reduce((s, f) => s + Number(f?.value?.amount ?? 0), 0),
        envios: ((p.shipmentIds ?? []) as string[]).map((sid) => ({ id: sid, ...(cds.get(sid) ?? {}) })),
      }));
      return await salvar(planoRef, { passo: "escolher_destino", destinos }, { acao: "opções de destino lidas", opcoes: destinos.length });
    }
    case "ler_envios": {
      const pl = await sp(token, "GET", `${API}/inboundPlans/${id}`);
      const envios: any[] = [];
      for (const s of ((pl.body?.shipments ?? []) as any[])) {
        const d = await sp(token, "GET", `${API}/inboundPlans/${id}/shipments/${s.shipmentId}`);
        envios.push({ id: s.shipmentId, fba: d.body?.shipmentConfirmationId ?? null, cd: d.body?.destination?.warehouseId ?? null, status: d.body?.status ?? s.status });
        await sleep(300);
      }
      return await salvar(planoRef, { passo: "destino_confirmado", envios_amazon: envios }, { acao: "destino confirmado", envios: envios.map((e) => e.fba) });
    }
    case "gerar_transporte": {
      // a cotação de transporte é por envio; readyToShipWindow.start = quando a carga fica pronta para sair
      const envios = (plano.envios_amazon ?? []) as any[];
      const placement = String(plano.destino_escolhido ?? ((plano.destinos ?? []) as any[])[0]?.id ?? "");
      if (!placement || !envios.length) return await salvar(planoRef, { passo: "erro", erro: "sem destino confirmado para cotar o transporte" });
      const corpo = {
        placementOptionId: placement,
        shipmentTransportationConfigurations: envios.map((e) => ({ shipmentId: String(e.id), readyToShipWindow: { start: String(e.pronto_em) } })),
      };
      return await disparar(planoRef, token, "POST", `${API}/inboundPlans/${id}/transportationOptions`, corpo, "gerando_transporte", "gerar opções de transporte");
    }
    case "ler_transporte": {
      const placement = String(plano.destino_escolhido ?? ((plano.destinos ?? []) as any[])[0]?.id ?? "");
      const todas: any[] = [];
      let pagina = "";
      for (let k = 0; k < 10; k++) {
        const r = await sp(token, "GET", `${API}/inboundPlans/${id}/transportationOptions?placementOptionId=${encodeURIComponent(placement)}&pageSize=20${pagina ? `&paginationToken=${encodeURIComponent(pagina)}` : ""}`);
        if (!ok(r)) return await salvar(planoRef, { passo: "erro", erro: `ler opções de transporte: ${motivo(r)}` });
        todas.push(...((r.body?.transportationOptions ?? []) as any[]));
        pagina = String(r.body?.pagination?.nextToken ?? "");
        if (!pagina) break;
        await sleep(300);
      }
      const envios = ((plano.envios_amazon ?? []) as any[]).map((e) => ({
        ...e,
        transporte_opcoes: todas.filter((t) => String(t.shipmentId) === String(e.id)).map((t) => ({
          id: String(t.transportationOptionId),
          transportadora: t.carrier?.name ?? t.carrier?.alphaCode ?? null,
          modo: t.shippingMode ?? null, // GROUND_SMALL_PARCEL (caixas) | FREIGHT_LTL (palete)
          solucao: t.shippingSolution ?? null, // USE_YOUR_OWN_CARRIER | AMAZON_PARTNERED_CARRIER
          custo: t.quote?.cost?.amount ?? null, moeda: t.quote?.cost?.code ?? null, cotacao_expira: t.quote?.expiration ?? null,
          cancelavel_ate: t.quote?.voidableUntil ?? null,
          // parceiro da Amazon: cada opção é uma janela de COLETA no endereço de saída
          coleta_inicio: t.carrierAppointment?.startTime ?? null, coleta_fim: t.carrierAppointment?.endTime ?? null,
          precondicoes: t.preconditions ?? [],
        })),
      }));
      const n = envios.reduce((s, e) => s + e.transporte_opcoes.length, 0);
      if (!n) return await salvar(planoRef, { passo: "erro", envios_amazon: envios, erro: "a Amazon não ofereceu transporte para os envios" });
      return await salvar(planoRef, { passo: "escolher_transporte", envios_amazon: envios }, { acao: "opções de transporte lidas", opcoes: n });
    }
  }
  return plano;
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  const modulo = String(b.modulo ?? "");
  const quem = await exigirAcesso(req, modulo);
  if (quem instanceof Response) return quem;
  const ate = Date.now() + 22000;

  try {
    if (modulo === "lista") {
      const desde = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data } = await db.from("amazon_envio_plano")
        .select("id, empresa, shop_id, passo, plano_id, itens_origem, envios_amazon, erro, criado_por, criado_em, atualizado_em")
        .gte("criado_em", desde).order("criado_em", { ascending: false }).limit(30);
      return json({ ok: true, planos: data ?? [] });
    }

    // v8: modelos de caixa a partir do histórico de envios da conta
    if (modulo === "modelos-importar") {
      const conta = CONTA[String(b.empresa ?? "")];
      if (!conta) return json({ ok: false, erro: "informe a empresa (SVL Store ou ACZ Pet)" }, 400);
      const dry = b.dry === true || b.dry === "1";
      if (quem.nome === "ensaio" && !dry) return json({ ok: false, erro: "gravar exige login" }, 401);
      const token = await tokenConta(conta.shop_id);
      const maxPlanos = Math.min(Number(b.planos) || 40, 80);
      const planos: string[] = [];
      let next: string | null = null;
      while (planos.length < maxPlanos && Date.now() < ate) {
        const q = `status=SHIPPED&pageSize=30&sortBy=LAST_UPDATED_TIME&sortOrder=DESC${next ? `&paginationToken=${encodeURIComponent(next)}` : ""}`;
        const r = await sp(token, "GET", `${API}/inboundPlans?${q}`);
        if (r.status === 403) return json({ ok: false, erro: SEM_PAPEL }, 403);
        if (!ok(r)) return json({ ok: false, erro: `planos: ${motivo(r)}` }, 502);
        for (const p of ((r.body?.inboundPlans ?? []) as any[])) if (p.inboundPlanId) planos.push(String(p.inboundPlanId));
        next = r.body?.pagination?.nextToken ?? null;
        if (!next) break;
        await sleep(600);
      }
      const skuDe = await mapaSkus(conta.shop_id);
      // por anúncio: contagem de cada formato de caixa (un × medidas × peso) + validade mais recente
      const porMsku = new Map<string, { formatos: Map<string, { n: number; un: number; c: number; l: number; a: number; kg: number; nome: string | null }>; validade: string | null }>();
      let lidos = 0, mistas = 0;
      for (const id of planos.slice(0, maxPlanos)) {
        if (Date.now() > ate) break;
        let tk: string | null = null;
        do {
          const r = await sp(token, "GET", `${API}/inboundPlans/${encodeURIComponent(id)}/boxes?pageSize=1000${tk ? `&paginationToken=${encodeURIComponent(tk)}` : ""}`);
          if (!ok(r)) break;
          for (const bx of ((r.body?.boxes ?? []) as any[])) {
            const its = ((bx.items ?? []) as any[]).filter((i) => i.msku && Number(i.quantity) > 0);
            if (new Set(its.map((i) => i.msku)).size !== 1) { if (its.length) mistas++; continue; }
            const msku = String(its[0].msku);
            const un = its.reduce((s, i) => s + Number(i.quantity), 0);
            const fat = String(bx.dimensions?.unitOfMeasurement ?? "CM").toUpperCase() === "IN" ? 2.54 : 1;
            const kgf = String(bx.weight?.unit ?? "KG").toUpperCase() === "LB" ? 0.453592 : 1;
            const c = Math.round(Number(bx.dimensions?.length) * fat * 10) / 10, l = Math.round(Number(bx.dimensions?.width) * fat * 10) / 10;
            const a = Math.round(Number(bx.dimensions?.height) * fat * 10) / 10, kg = Math.round(Number(bx.weight?.value) * kgf * 100) / 100;
            if (!(un > 0 && c > 0 && l > 0 && a > 0 && kg > 0)) continue;
            const reg = porMsku.get(msku) ?? { formatos: new Map(), validade: null };
            const chave = `${un}|${c}|${l}|${a}|${kg}`;
            const f = reg.formatos.get(chave) ?? { n: 0, un, c, l, a, kg, nome: bx.templateName ?? null };
            f.n += Math.max(1, Number(bx.quantity) || 1);
            reg.formatos.set(chave, f);
            for (const i of its) if (i.expiration && (!reg.validade || String(i.expiration) > reg.validade)) reg.validade = String(i.expiration).slice(0, 10);
            porMsku.set(msku, reg);
          }
          tk = r.body?.pagination?.nextToken ?? null;
          await sleep(550);
        } while (tk && Date.now() < ate);
        lidos++;
      }
      const { data: existentes } = await db.from("amazon_modelo_caixa").select("msku").eq("shop_id", conta.shop_id);
      const tem = new Set(((existentes ?? []) as any[]).map((x) => String(x.msku)));
      const novos: Record<string, unknown>[] = [];
      const jaExistiam: string[] = [];
      for (const [msku, reg] of porMsku) {
        if (tem.has(msku)) { jaExistiam.push(msku); continue; }
        const melhor = [...reg.formatos.values()].sort((x, y) => y.n - x.n)[0];
        novos.push({ shop_id: conta.shop_id, msku, sku: skuDe(msku), nome: melhor.nome ?? `Caixa com ${melhor.un}`, un_por_caixa: melhor.un,
          comprimento_cm: melhor.c, largura_cm: melhor.l, altura_cm: melhor.a, peso_kg: melhor.kg, validade: reg.validade,
          origem: "historico", caixas_historico: [...reg.formatos.values()].reduce((s, x) => s + x.n, 0), atualizado_por: quem.nome ?? "importação" });
      }
      if (!dry && novos.length) {
        const { error } = await db.from("amazon_modelo_caixa").insert(novos);
        if (error) return json({ ok: false, erro: `gravar modelos: ${error.message}`, novos }, 500);
      }
      return json({ ok: true, dry, conta: conta.nome, planos_encontrados: planos.length, planos_lidos: lidos, caixas_mistas_ignoradas: mistas,
        novos, ja_existiam: jaExistiam, faltou_tempo: lidos < Math.min(planos.length, maxPlanos) });
    }

    if (modulo === "amazon-envios" || modulo === "importar" || modulo === "recebimento") {
      const conta = CONTA[String(b.empresa ?? "")];
      if (!conta) return json({ ok: false, erro: "informe a empresa (SVL Store ou ACZ Pet)" }, 400);
      const token = await tokenConta(conta.shop_id);

      if (modulo === "recebimento") {
        const numero = String(b.numero ?? "").trim();
        if (!/^FBA[0-9A-Z]{6,}$/.test(numero)) return json({ ok: false, erro: "número FBA inválido" }, 400);
        const [env, itens] = [await v0Envios(token, `QueryType=SHIPMENT&ShipmentIdList=${numero}`, ate), await v0Itens(token, numero)];
        if (env === null || itens === null) return json({ ok: false, sem_papel: true, erro: SEM_PAPEL }, 200);
        const sku = await mapaSkus(conta.shop_id);
        const e = env[0] ?? {};
        const linhas = itens.map((it) => ({ sku: sku(String(it.SellerSKU)), sku_amazon: String(it.SellerSKU), fnsku: it.FulfillmentNetworkSKU ?? null,
          enviado: Number(it.QuantityShipped) || 0, recebido: Number(it.QuantityReceived) || 0 }));
        return json({ ok: true, numero, nome: e.ShipmentName ?? null, status: e.ShipmentStatus ?? null, status_pt: STATUS_PT[String(e.ShipmentStatus)] ?? e.ShipmentStatus ?? null,
          cd: e.DestinationFulfillmentCenterId ?? null, itens: linhas,
          enviado: linhas.reduce((s, l) => s + l.enviado, 0), recebido: linhas.reduce((s, l) => s + l.recebido, 0), lido_em: new Date().toISOString() });
      }

      if (modulo === "amazon-envios") {
        const dias = Math.min(120, Math.max(3, Number(b.dias) || 45));
        const desde = new Date(Date.now() - dias * 86400000).toISOString();
        const lista = await v0Envios(token, `QueryType=DATE_RANGE&ShipmentStatusList=${STATUS_V0.join(",")}&LastUpdatedAfter=${encodeURIComponent(desde)}&LastUpdatedBefore=${encodeURIComponent(new Date().toISOString())}`, ate);
        if (lista === null) return json({ ok: false, sem_papel: true, erro: SEM_PAPEL }, 200);
        const ids = lista.map((e) => String(e.ShipmentId));
        const { data: noApp } = await db.from("fulfillment_envios").select("id, numero, status, arquivado_em").eq("marketplace", "amazon").in("numero", ids.length ? ids : ["-"]);
        const porNum = new Map(((noApp ?? []) as any[]).map((x) => [String(x.numero), x]));
        const envios = lista.map((e) => ({
          numero: String(e.ShipmentId), nome: e.ShipmentName ?? null, status: e.ShipmentStatus ?? null, status_pt: STATUS_PT[String(e.ShipmentStatus)] ?? e.ShipmentStatus,
          cd: e.DestinationFulfillmentCenterId ?? null, no_app: porNum.get(String(e.ShipmentId))?.id ?? null,
        })).sort((a, b) => String(b.nome ?? "").localeCompare(String(a.nome ?? "")));
        return json({ ok: true, empresa: b.empresa, dias, envios });
      }

      // importar
      if (quem.nome === "ensaio") return json({ ok: false, erro: "faça login no app" }, 401);
      if (b.confirmar !== true) return json({ ok: false, erro: "importar exige confirmar: true" }, 400);
      const pedidos = [...new Set(((b.ids ?? []) as unknown[]).map(String).filter((x) => /^FBA[0-9A-Z]{6,}$/.test(x)))].slice(0, 15);
      if (!pedidos.length) return json({ ok: false, erro: "escolha os envios" }, 400);
      const env = await v0Envios(token, `QueryType=SHIPMENT&ShipmentIdList=${pedidos.join(",")}`, ate);
      if (env === null) return json({ ok: false, sem_papel: true, erro: SEM_PAPEL }, 200);
      const sku = await mapaSkus(conta.shop_id);
      const resultado: any[] = [];
      for (const numero of pedidos) {
        if (Date.now() > ate - 3000) { resultado.push({ numero, erro: "sem tempo: importe de novo" }); continue; }
        try {
          const e = env.find((x) => String(x.ShipmentId) === numero);
          if (!e) throw new Error("a Amazon não devolveu este envio");
          const { data: ja } = await db.from("fulfillment_envios").select("id").eq("marketplace", "amazon").eq("numero", numero).limit(1);
          if (ja?.length) { resultado.push({ numero, envio_id: ja[0].id, criado: false }); continue; }
          const itens = await v0Itens(token, numero);
          if (itens === null) throw new Error(SEM_PAPEL);
          const skus = itens.map((it) => sku(String(it.SellerSKU)));
          const { data: prods } = await db.from("produtos").select("sku, nome").in("sku", skus.length ? skus : ["-"]);
          const nomes = new Map(((prods ?? []) as any[]).map((x) => [String(x.sku), x.nome]));
          const status = STATUS_APP[String(e.ShipmentStatus)] ?? "enviado";
          const linhas = itens.map((it, k) => {
            const q = Number(it.QuantityShipped) || 0;
            return { sku: skus[k], sku_origem: String(it.SellerSKU), titulo: nomes.get(skus[k]) ?? null, qtd_planejada: q,
              qtd_separada: status === "enviado" ? q : 0, ordem: k };
          });
          const { data: novo, error } = await db.from("fulfillment_envios").insert({
            marketplace: "amazon", empresa: b.empresa, numero, centro: e.DestinationFulfillmentCenterId ?? null, status,
            total_unidades: linhas.reduce((s, l) => s + l.qtd_planejada, 0), criado_por: quem.nome,
            observacao: `Importado da Amazon (${e.ShipmentName ?? numero} · ${STATUS_PT[String(e.ShipmentStatus)] ?? e.ShipmentStatus}).`,
          }).select("id").single();
          if (error || !novo) throw new Error(`banco (envio): ${error?.message}`);
          const { error: eI } = await db.from("fulfillment_envio_itens").insert(linhas.map((l) => ({ ...l, envio_id: novo.id })));
          if (eI) { await db.from("fulfillment_envios").delete().eq("id", novo.id); throw new Error(`banco (itens): ${eI.message}`); }
          resultado.push({ numero, envio_id: novo.id, criado: true, itens: linhas.length, status });
        } catch (x) { resultado.push({ numero, erro: String((x as Error).message ?? x) }); }
      }
      return json({ ok: !resultado.some((r) => r.erro), resultado });
    }

    // plano existente (continuar / destino / cancelar) ou itens novos vindos da Reposição
    const planoRow = b.plano ? await lerPlano(String(b.plano)) : null;
    const empresa = planoRow ? (planoRow.empresa as string | null) : (b.empresa ? String(b.empresa) : null);
    const entrada = (planoRow ? planoRow.itens_origem : b.itens) as Entrada[] | undefined;
    if (!Array.isArray(entrada)) return json({ ok: false, erro: "informe os itens (sku e quantidade) ou o plano" }, 400);
    const m = await montar(empresa, entrada);
    const resumo = (plano: Record<string, any> | null) => ({
      ok: true, conta: m.conta.nome, empresa, linhas: plano?.itens ?? m.linhas, pendencias: plano ? [] : m.pendencias, avisos: plano ? [] : m.avisos,
      plano: plano ? { ...plano, log: undefined, ultimos: Array.isArray(plano.log) ? plano.log.slice(-8) : [] } : null,
    });
    if (modulo === "previa") return json(resumo(planoRow));

    const token = await tokenConta(m.conta.shop_id);

    if (modulo === "avancar") {
      let plano = planoRow;
      if (!plano) {
        if (b.confirmar !== true) return json({ ok: false, erro: "criar o plano na Amazon exige confirmar: true" }, 400);
        if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
        const prep = await prepConstraints(token, m.linhas.map((l) => String(l.msku)));
        const itens = m.linhas.map((l) => {
          const p = prep.get(String(l.msku)) ?? { labelOwner: "SELLER", prepOwner: "NONE" };
          return { msku: String(l.msku), quantity: l.quantidade, labelOwner: p.labelOwner, prepOwner: p.prepOwner, ...(l.validade ? { expiration: l.validade } : {}) };
        });
        const { data: novo, error } = await db.from("amazon_envio_plano").insert({
          shop_id: m.conta.shop_id, empresa, itens_origem: entrada, itens: m.linhas, passo: "novo", criado_por: quem.nome,
        }).select("*").single();
        if (error || !novo) return json({ ok: false, erro: `banco: ${error?.message}` }, 500);
        const nome = `App Reposição · ${new Date().toISOString().slice(0, 10)} · ${m.linhas.length} SKU`;
        plano = await disparar(String(novo.id), token, "POST", `${API}/inboundPlans`,
          { name: nome, destinationMarketplaces: [MKT], sourceAddress: ORIGEM, items: itens }, "criando", "criar plano");
      }
      let guarda = 0;
      while (plano && !PARADOS.has(plano.passo) && Date.now() < ate && guarda++ < 12) {
        const antes = `${plano.passo}|${plano.operacao_id ?? ""}`;
        plano = await passo(plano, token, String(plano.id), ate);
        if (`${plano.passo}|${plano.operacao_id ?? ""}` === antes) break; // operação ainda andando
      }
      return json(resumo(plano));
    }

    if (!planoRow) return json({ ok: false, erro: "informe o plano" }, 400);
    const ref = String(planoRow.id);

    if (modulo === "confirmar-destino") {
      if (planoRow.passo !== "escolher_destino") return json({ ok: false, erro: "o plano não está esperando a escolha do destino" }, 400);
      if (b.confirmar !== true) return json({ ok: false, erro: "confirmar o destino exige confirmar: true" }, 400);
      const opcao = ((planoRow.destinos ?? []) as any[]).find((d) => d.id === String(b.opcao_id ?? ""));
      if (!opcao) return json({ ok: false, erro: "opção de destino não encontrada" }, 400);
      if (opcao.expira && Date.parse(opcao.expira) < Date.now()) return json({ ok: false, erro: "esta opção de destino venceu — crie o plano de novo" }, 400);
      await salvar(ref, { destino_escolhido: opcao.id }, { acao: "destino escolhido", por: quem.nome, taxa: opcao.taxa });
      let p = await disparar(ref, token, "POST", `${API}/inboundPlans/${planoRow.plano_id}/placementOptions/${opcao.id}/confirmation`, {}, "confirmando_destino", "confirmar destino");
      let guarda = 0;
      while (p && !PARADOS.has(p.passo) && Date.now() < ate && guarda++ < 6) {
        const antes = `${p.passo}|${p.operacao_id ?? ""}`;
        p = await passo(p, token, ref, ate);
        if (`${p.passo}|${p.operacao_id ?? ""}` === antes) break;
      }
      return json(resumo(p));
    }

    if (modulo === "cancelar") {
      if (!planoRow.plano_id) return json({ ok: false, erro: "o plano não chegou a ser criado na Amazon" }, 400);
      if (planoRow.passo === "cancelado") return json(resumo(planoRow));
      if (b.confirmar !== true) return json({ ok: false, erro: "cancelar exige confirmar: true" }, 400);
      await salvar(ref, {}, { acao: "cancelamento pedido", por: quem.nome });
      const r = await sp(token, "PUT", `${API}/inboundPlans/${planoRow.plano_id}/cancellation`);
      if (!ok(r) || !r.body?.operationId) {
        const p = await salvar(ref, { erro: `cancelar: a Amazon recusou — ${motivo(r)}` }, { acao: "cancelar", http: r.status, erro: motivo(r) });
        return json({ ...resumo(p), ok: false, erro: `a Amazon recusou o cancelamento: ${motivo(r)}` });
      }
      let p = await salvar(ref, { passo: "cancelando", operacao_id: String(r.body.operationId), erro: null }, { acao: "cancelar", http: r.status });
      p = await passo(p, token, ref, ate);
      return json(resumo(p));
    }

    if (modulo === "transporte") {
      // só cotação: gera as opções e lista (pode ser refeito enquanto o transporte não foi confirmado)
      if (!["destino_confirmado", "escolher_transporte"].includes(String(planoRow.passo)) && !(planoRow.passo === "erro" && planoRow.envios_amazon))
        return json({ ok: false, erro: "o transporte só é cotado depois de confirmar o destino" }, 400);
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(b.pronto_em ?? "")) ? String(b.pronto_em) : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const pronto = `${dia}T12:00:00Z`; // 09:00 em Brasília
      if (Date.parse(pronto) < Date.now()) return json({ ok: false, erro: "a data de saída tem de ser hoje ou depois" }, 400);
      const envios = ((planoRow.envios_amazon ?? []) as any[]).map((e) => ({ ...e, pronto_em: pronto }));
      let p = await salvar(ref, { passo: "gerar_transporte", envios_amazon: envios, erro: null }, { acao: "cotar transporte", por: quem.nome, pronto_em: pronto });
      let guarda = 0;
      while (p && !PARADOS.has(p.passo) && Date.now() < ate && guarda++ < 6) {
        const antes = `${p.passo}|${p.operacao_id ?? ""}`;
        p = await passo(p, token, ref, ate);
        if (`${p.passo}|${p.operacao_id ?? ""}` === antes) break;
      }
      return json(resumo(p));
    }

    if (modulo === "confirmar-transporte") {
      if (quem.nome === "ensaio") return json({ ok: false, erro: "faça login no app" }, 401);
      if (planoRow.passo !== "escolher_transporte") return json({ ok: false, erro: "o plano não está esperando a escolha do transporte" }, 400);
      if (b.confirmar !== true) return json({ ok: false, erro: "confirmar o transporte exige confirmar: true" }, 400);
      const escolhas = (b.escolhas ?? {}) as Record<string, string>;
      const envios = (planoRow.envios_amazon ?? []) as any[];
      const selecao: any[] = [];
      for (const e of envios) {
        const op = ((e.transporte_opcoes ?? []) as any[]).find((o) => o.id === String(escolhas[String(e.id)] ?? ""));
        if (!op) return json({ ok: false, erro: `escolha o transporte do envio ${e.fba ?? e.id}` }, 400);
        if (op.cotacao_expira && Date.parse(op.cotacao_expira) < Date.now()) return json({ ok: false, erro: `a cotação do envio ${e.fba ?? e.id} venceu: cote de novo` }, 400);
        if ((op.precondicoes ?? []).length) return json({ ok: false, erro: `o transporte escolhido para ${e.fba ?? e.id} exige antes: ${(op.precondicoes as string[]).join(", ")} (ainda não feito pelo app)` }, 400);
        selecao.push({ shipmentId: String(e.id), transportationOptionId: op.id });
      }
      await salvar(ref, { envios_amazon: envios.map((e) => ({ ...e, transporte_escolhido: escolhas[String(e.id)] })) }, { acao: "transporte escolhido", por: quem.nome, selecao });
      let p = await disparar(ref, token, "POST", `${API}/inboundPlans/${planoRow.plano_id}/transportationOptions/confirmation`, { transportationSelections: selecao }, "confirmando_transporte", "confirmar transporte");
      let guarda = 0;
      while (p && !PARADOS.has(p.passo) && Date.now() < ate && guarda++ < 6) {
        const antes = `${p.passo}|${p.operacao_id ?? ""}`;
        p = await passo(p, token, ref, ate);
        if (`${p.passo}|${p.operacao_id ?? ""}` === antes) break;
      }
      return json(resumo(p));
    }

    if (modulo === "envios-app") {
      // cria na aba Envios um envio por envio da Amazon, com itens e etiquetas — só depois do transporte confirmado
      const dry = b.dry === true || quem.nome === "ensaio";
      if (!dry && planoRow.passo !== "transporte_confirmado") return json({ ok: false, erro: "o envio no app é criado depois de confirmar o transporte" }, 400);
      const porMsku = new Map(((planoRow.itens ?? []) as Linha[]).map((l) => [String(l.msku), l]));
      const envios = (planoRow.envios_amazon ?? []) as any[];
      const resultado: any[] = [];
      let faltam = 0;
      for (const e of envios) {
        if (Date.now() > ate - 6000) { faltam++; continue; }
        const r: Record<string, any> = { fba: e.fba, cd: e.cd, avisos: [] as string[] };
        try {
          const [ri, rc] = [await sp(token, "GET", `${API}/inboundPlans/${planoRow.plano_id}/shipments/${e.id}/items?pageSize=100`),
            await sp(token, "GET", `${API}/inboundPlans/${planoRow.plano_id}/shipments/${e.id}/boxes?pageSize=100`)];
          if (!ok(ri)) throw new Error(`itens do envio: ${motivo(ri)}`);
          const itens = ((ri.body?.items ?? []) as any[]).map((it, k) => {
            const l = porMsku.get(String(it.msku));
            return { sku: l?.sku ?? String(it.msku), sku_origem: String(it.msku), titulo: l?.titulo ?? null, qtd_planejada: Number(it.quantity) || 0,
              qtd_separada: 0, ordem: k, _rotula: String(it.labelOwner) === "SELLER" };
          });
          const listaCx = (rc.body?.boxes ?? []) as any[];
          const caixas = listaCx.map((x) => String(x.boxId ?? "")).filter(Boolean);
          if (!ok(rc)) r.avisos.push(`caixas: ${motivo(rc)}`);
          if (listaCx.some((x) => Number(x.quantity) > 1)) r.avisos.push("caixas agrupadas pela Amazon: confira se veio uma etiqueta por caixa");
          r.itens = itens.map(({ _rotula, ...x }) => ({ ...x, etiqueta_produto: _rotula }));
          r.caixas = caixas.length;
          const total = itens.reduce((s, i) => s + i.qtd_planejada, 0);
          const opc = ((e.transporte_opcoes ?? []) as any[]).find((o) => o.id === e.transporte_escolhido);
          const dia = diaBRT(opc?.coleta_inicio) ?? diaBRT(e.pronto_em);
          // etiquetas (baixadas na hora; no dry só confere que vieram)
          let pdfCaixas: Uint8Array | null = null, pdfProduto: Uint8Array | null = null;
          if (caixas.length) { try { pdfCaixas = await etiquetasCaixas(token, String(e.fba), caixas); } catch (x) { r.avisos.push(String((x as Error).message)); } }
          else r.avisos.push("a Amazon não devolveu as caixas: etiquetas das caixas ficam para o Seller Central");
          const rotular = itens.filter((i) => i._rotula).map((i) => ({ msku: i.sku_origem, quantity: i.qtd_planejada }));
          if (rotular.length) { try { pdfProduto = await etiquetasProduto(token, rotular); } catch (x) { r.avisos.push(String((x as Error).message)); } }
          r.etiquetas_caixas_kb = pdfCaixas ? Math.round(pdfCaixas.length / 1024) : null;
          r.etiquetas_produto_kb = pdfProduto ? Math.round(pdfProduto.length / 1024) : null;
          if (dry) { resultado.push(r); continue; }

          // envio no app (reaproveita o que já foi criado para este FBA)
          let envioId = e.envio_app_id as string | undefined;
          if (!envioId) {
            const { data: ja } = await db.from("fulfillment_envios").select("id").eq("marketplace", "amazon").eq("numero", String(e.fba)).limit(1);
            envioId = ja?.[0]?.id;
          }
          if (!envioId) {
            const transp = opc ? (opc.solucao === "AMAZON_PARTNERED_CARRIER" ? `coleta ${opc.transportadora ?? ""} (parceira Amazon) em ${dia ?? "?"}` : `por nossa conta (${opc.transportadora ?? ""})`) : "transporte confirmado pelo app";
            const { data: novo, error } = await db.from("fulfillment_envios").insert({
              marketplace: "amazon", empresa: planoRow.empresa, numero: String(e.fba), centro: e.cd ?? null, status: "separando",
              total_unidades: total, data_envio_agendada: dia, criado_por: quem.nome,
              observacao: `Criado pelo app (plano Amazon ${planoRow.plano_id}) · ${transp}. Nota de remessa: gerar no Seller Central e anexar.`,
            }).select("id").single();
            if (error || !novo) throw new Error(`banco (envio): ${error?.message}`);
            envioId = String(novo.id);
            const { error: eI } = await db.from("fulfillment_envio_itens").insert(itens.map(({ _rotula, ...x }) => ({ ...x, envio_id: envioId })));
            if (eI) { await db.from("fulfillment_envios").delete().eq("id", envioId); throw new Error(`banco (itens): ${eI.message}`); }
            r.criado = true;
          } else r.criado = false;
          r.envio_id = envioId;
          if (pdfCaixas) r.doc_caixas = await anexarDoc(envioId, "etiquetas", `Etiquetas das caixas ${e.fba}.pdf`, pdfCaixas, quem.nome);
          if (pdfProduto) r.doc_produto = await anexarDoc(envioId, "etiqueta_produto", `Etiquetas de produto ${e.fba}.pdf`, pdfProduto, quem.nome);
          e.envio_app_id = envioId;
        } catch (x) {
          r.erro = String((x as Error).message ?? x);
        }
        resultado.push(r);
      }
      let p = planoRow;
      if (!dry && resultado.some((r) => r.envio_id)) {
        p = await salvar(ref, { envios_amazon: envios }, { acao: "envios criados no app", por: quem.nome,
          envios: resultado.map((r) => ({ fba: r.fba, envio: r.envio_id ?? null, criado: r.criado ?? false, erro: r.erro ?? null, avisos: r.avisos })) });
      }
      return json({ ...resumo(p), ok: !resultado.some((r) => r.erro), dry, faltam, envios_app: resultado });
    }

    return json({ ok: false, erro: "use modulo lista, previa, avancar, confirmar-destino, transporte, confirmar-transporte, envios-app, amazon-envios, importar, recebimento ou cancelar" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
