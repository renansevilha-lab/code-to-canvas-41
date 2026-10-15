// ============================================================================
// Edge Function: amazon-inbound v3 (14/out/2026) — envio ao FBA pela API (Fulfillment Inbound v2024-03-20)
// ----------------------------------------------------------------------------
// Pedido do dono: o envio montado na aba Fulfillment › Envios vira o plano de envio na Amazon, com as
// caixas preenchidas pelos MODELOS (amazon_modelo_caixa), parando para a pessoa escolher o centro de
// destino. Transportadora, nota fiscal de remessa e etiquetas seguem no Seller Central (ainda não testados
// pela API). Só funciona na conta cujo app tem a permissão de envios (hoje a SVL; a ACZ responde 403).
//
// POST body {modulo, envio_id, ...} — exige sessão de usuário com o módulo `galpao` (ou service role):
//   previa             → itens do envio × anúncio da Amazon (msku) × modelo de caixa; pendências. Só leitura.
//   avancar            → executa os próximos passos (até ~22 s) e devolve o estado; a tela chama de novo
//                        até parar em "escolher_destino". O 1º passo (criar o plano) exige confirmar: true.
//   confirmar-destino  → {opcao_id, confirmar: true}: confirma o centro de destino (pode ter taxa).
//   cancelar           → {confirmar: true}: cancela o plano na Amazon.
// Regras: cada escrita na Amazon é feita UMA vez (o passo e o operationId são gravados logo depois da
// resposta; nada é repetido sozinho). O andamento fica em amazon_envio_plano (log por passo).
// v1 (teste com chave temporária) saiu: a fase de teste terminou com o plano criado e cancelado.
// v3: envio com número FBA… (veio do PDF do Seller Central) não cria outro plano — seria em dobro.
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
  cancelando: "cancelado",
};
const PARADOS = new Set(["escolher_destino", "destino_confirmado", "cancelado", "erro"]);

// ---------------------------------------------------------------- acesso
type Quem = { nome: string | null };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === SRK) return { nome: "sistema" };
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role === "service_role") return { nome: "sistema" };
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
async function montar(envioId: string) {
  const { data: envio } = await db.from("fulfillment_envios").select("id, marketplace, empresa, numero, centro, status").eq("id", envioId).maybeSingle();
  if (!envio) throw new Error("envio não encontrado");
  if (envio.marketplace !== "amazon") throw new Error("este envio não é da Amazon");
  const conta = CONTA[String(envio.empresa ?? "")] ?? CONTA["ACZ Pet"];
  const { data: itensD } = await db.from("fulfillment_envio_itens").select("sku, sku_origem, titulo, qtd_planejada").eq("envio_id", envioId).order("ordem");
  const itens = ((itensD ?? []) as any[]).filter((i) => Number(i.qtd_planejada) > 0);
  const skus = [...new Set(itens.map((i) => String(i.sku)))];
  const [estq, mods] = await Promise.all([
    db.from("estoque_fulfillment").select("sku, sku_marketplace").eq("marketplace", "amazon").eq("shop_id", conta.shop_id).in("sku", skus.length ? skus : ["-"]),
    db.from("amazon_modelo_caixa").select("*").eq("shop_id", conta.shop_id),
  ]);
  const modelos = new Map(((mods.data ?? []) as any[]).map((m) => [String(m.msku), m]));
  const anuncios = new Map<string, string[]>();
  for (const e of (estq.data ?? []) as any[]) anuncios.set(String(e.sku), [...(anuncios.get(String(e.sku)) ?? []), String(e.sku_marketplace)]);

  const linhas: Linha[] = itens.map((i) => {
    const sku = String(i.sku);
    const qtd = Number(i.qtd_planejada);
    let msku: string | null = i.sku_origem ? String(i.sku_origem) : null;
    let problema: string | null = null;
    if (!msku) {
      const ops = [...new Set(anuncios.get(sku) ?? [])];
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
    return { sku, msku, titulo: i.titulo ?? null, quantidade: qtd, modelo, caixas, validade: modelo?.validade ?? null, problema, anuncios: [...new Set(anuncios.get(sku) ?? [])] };
  });
  const repetidos = linhas.filter((l, k) => l.msku && linhas.findIndex((x) => x.msku === l.msku) !== k).map((l) => l.msku);
  const pendencias = [
    ...linhas.filter((l) => l.problema).map((l) => `${l.sku}: ${l.problema}`),
    ...(linhas.length === 0 ? ["o envio não tem itens com quantidade"] : []),
    ...(conta.shop_id === 900001 ? ["a conta ACZ ainda não tem a permissão de envios no aplicativo da Amazon (\"Ottz Analytics\"): por enquanto só a SVL"] : []),
    ...(repetidos.length ? [`anúncio repetido no envio: ${[...new Set(repetidos)].join(", ")} — junte as quantidades num item só`] : []),
  ];
  const avisos = linhas.filter((l) => l.msku && !l.validade).map((l) => `${l.sku}: sem validade no modelo — se o produto exigir (areia exige), a Amazon recusa o plano`);
  const { data: plano } = await db.from("amazon_envio_plano").select("*").eq("envio_id", envioId).maybeSingle();
  // envio que veio do PDF do Seller Central já existe na Amazon: criar de novo daria um plano em dobro
  if (!plano && /^FBA/i.test(String(envio.numero ?? ""))) {
    pendencias.unshift(`este envio já existe na Amazon (${envio.numero}, criado no Seller Central): o botão é para envio montado no app`);
  }
  return { envio, conta, linhas, pendencias, avisos, plano: plano as Record<string, any> | null };
}

// ---------------------------------------------------------------- estado
async function salvar(envioId: string, patch: Record<string, unknown>, registro?: Record<string, unknown>) {
  const set: Record<string, unknown> = { ...patch, atualizado_em: new Date().toISOString() };
  if (registro) {
    const { data } = await db.from("amazon_envio_plano").select("log").eq("envio_id", envioId).maybeSingle();
    const log = Array.isArray(data?.log) ? data!.log as unknown[] : [];
    set.log = [...log, { em: new Date().toISOString(), ...registro }].slice(-60);
  }
  const { data: linha } = await db.from("amazon_envio_plano").update(set).eq("envio_id", envioId).select("*").single();
  return linha as Record<string, any>;
}
/** Dispara UMA escrita assíncrona: grava o passo de espera e o operationId logo depois da resposta. */
async function disparar(envioId: string, token: string, metodo: string, caminho: string, corpo: unknown, passoEspera: string, acao: string) {
  const r = await sp(token, metodo, caminho, corpo);
  if (!ok(r) || !r.body?.operationId) {
    return await salvar(envioId, { passo: "erro", erro: `${acao}: a Amazon recusou — ${motivo(r)}`, operacao_id: null }, { acao, http: r.status, erro: motivo(r) });
  }
  const extra: Record<string, unknown> = r.body?.inboundPlanId ? { plano_id: String(r.body.inboundPlanId) } : {};
  return await salvar(envioId, { passo: passoEspera, operacao_id: String(r.body.operationId), erro: null, ...extra }, { acao, http: r.status, operacao: r.body.operationId });
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

async function passo(plano: Record<string, any>, token: string, envioId: string, ate: number): Promise<Record<string, any>> {
  const id = String(plano.plano_id ?? "");
  const itens = (plano.itens ?? []) as Linha[];
  // esperando uma operação
  if (plano.operacao_id && DEPOIS[plano.passo]) {
    while (Date.now() < ate) {
      const o = await sp(token, "GET", `${API}/operations/${plano.operacao_id}`);
      const st = String(o.body?.operationStatus ?? "");
      if (st === "SUCCESS") return await salvar(envioId, { passo: DEPOIS[plano.passo], operacao_id: null }, { acao: `${plano.passo}: concluído` });
      if (st === "FAILED") {
        const probs = ((o.body?.operationProblems ?? []) as any[]).map((p) => `${p.code ?? ""}: ${p.message ?? ""}${p.details ? ` (${p.details})` : ""}`).join(" · ");
        return await salvar(envioId, { passo: "erro", operacao_id: null, erro: `${plano.passo}: ${probs || "operação falhou"}` }, { acao: `${plano.passo}: falhou`, erro: probs });
      }
      await sleep(1500);
    }
    return plano; // ainda em andamento: a tela chama de novo
  }
  switch (plano.passo) {
    case "gerar_embalagem":
      return await disparar(envioId, token, "POST", `${API}/inboundPlans/${id}/packingOptions`, {}, "gerando_embalagem", "gerar opções de embalagem");
    case "escolher_embalagem": {
      const r = await sp(token, "GET", `${API}/inboundPlans/${id}/packingOptions`);
      const ops = ((r.body?.packingOptions ?? []) as any[]).filter((p) => p.status === "OFFERED");
      if (!ops.length) return await salvar(envioId, { passo: "erro", erro: `a Amazon não ofereceu embalagem (${motivo(r)})` });
      const taxa = (p: any) => ((p.fees ?? []) as any[]).reduce((s, f) => s + Number(f?.value?.amount ?? 0), 0);
      const esc = [...ops].sort((a, b) => taxa(a) - taxa(b) || (a.packingGroups?.length ?? 0) - (b.packingGroups?.length ?? 0))[0];
      await salvar(envioId, { caixas: { packing_option: esc.packingOptionId, grupos: esc.packingGroups ?? [], taxa: taxa(esc) } }, { acao: "embalagem escolhida", opcoes: ops.length, taxa: taxa(esc) });
      return await disparar(envioId, token, "POST", `${API}/inboundPlans/${id}/packingOptions/${esc.packingOptionId}/confirmation`, {}, "confirmando_embalagem", "confirmar embalagem");
    }
    case "caixas": {
      const grupos = ((plano.caixas?.grupos ?? []) as string[]);
      const prep = await prepConstraints(token, itens.map((l) => String(l.msku)));
      const porMsku = new Map(itens.map((l) => [String(l.msku), l]));
      const packageGroupings: any[] = [];
      for (const g of grupos) {
        const r = await sp(token, "GET", `${API}/inboundPlans/${id}/packingGroups/${g}/items`);
        if (!ok(r)) return await salvar(envioId, { passo: "erro", erro: `ler os itens do grupo de embalagem: ${motivo(r)}` });
        const boxes: any[] = [];
        for (const it of ((r.body?.items ?? []) as any[])) {
          const l = porMsku.get(String(it.msku));
          const m = l?.modelo;
          if (!l || !m) return await salvar(envioId, { passo: "erro", erro: `a Amazon pôs no grupo o anúncio ${it.msku}, que não está no envio` });
          const un = Number(m.un_por_caixa);
          const qtd = Number(it.quantity);
          if (qtd % un !== 0) return await salvar(envioId, { passo: "erro", erro: `${it.msku}: ${qtd} unidades no grupo não fecham caixas de ${un}` });
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
      await salvar(envioId, { caixas: { ...(plano.caixas ?? {}), enviadas: packageGroupings } });
      return await disparar(envioId, token, "POST", `${API}/inboundPlans/${id}/packingInformation`, { packageGroupings }, "enviando_caixas", "informar caixas");
    }
    case "gerar_destinos":
      return await disparar(envioId, token, "POST", `${API}/inboundPlans/${id}/placementOptions`, {}, "gerando_destinos", "gerar opções de destino");
    case "ler_destinos": {
      const r = await sp(token, "GET", `${API}/inboundPlans/${id}/placementOptions`);
      const ops = ((r.body?.placementOptions ?? []) as any[]).filter((p) => p.status === "OFFERED");
      if (!ops.length) return await salvar(envioId, { passo: "erro", erro: `a Amazon não ofereceu destino (${motivo(r)})` });
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
      return await salvar(envioId, { passo: "escolher_destino", destinos }, { acao: "opções de destino lidas", opcoes: destinos.length });
    }
    case "ler_envios": {
      const pl = await sp(token, "GET", `${API}/inboundPlans/${id}`);
      const envios: any[] = [];
      for (const s of ((pl.body?.shipments ?? []) as any[])) {
        const d = await sp(token, "GET", `${API}/inboundPlans/${id}/shipments/${s.shipmentId}`);
        envios.push({ id: s.shipmentId, fba: d.body?.shipmentConfirmationId ?? null, cd: d.body?.destination?.warehouseId ?? null, status: d.body?.status ?? s.status });
        await sleep(300);
      }
      const linha = await salvar(envioId, { passo: "destino_confirmado", envios_amazon: envios }, { acao: "destino confirmado", envios: envios.map((e) => e.fba) });
      // o envio do app passa a mostrar o número e o centro da Amazon (só se ainda estiverem vazios)
      const { data: env } = await db.from("fulfillment_envios").select("numero, centro").eq("id", envioId).maybeSingle();
      const patch: Record<string, unknown> = {};
      const fbas = envios.map((e) => e.fba).filter(Boolean);
      if (!env?.numero && fbas.length) patch.numero = fbas.join(" + ");
      if (!env?.centro) patch.centro = [...new Set(envios.map((e) => e.cd).filter(Boolean))].join(" + ") || null;
      if (Object.keys(patch).length) await db.from("fulfillment_envios").update(patch).eq("id", envioId);
      return linha;
    }
  }
  return plano;
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  const modulo = String(b.modulo ?? "");
  const envioId = String(b.envio_id ?? "");
  if (!envioId) return json({ ok: false, erro: "informe envio_id" }, 400);
  const inicio = Date.now();
  const ate = inicio + 22000;

  try {
    const m = await montar(envioId);
    const resumo = (plano: Record<string, any> | null) => ({
      ok: true, conta: m.conta.nome, linhas: m.linhas, pendencias: m.pendencias, avisos: m.avisos,
      plano: plano ? { ...plano, log: undefined, ultimos: Array.isArray(plano.log) ? plano.log.slice(-8) : [] } : null,
    });
    if (modulo === "previa") return json(resumo(m.plano));

    const token = await tokenConta(m.conta.shop_id);

    if (modulo === "avancar") {
      let plano = m.plano;
      // novo plano: nenhum ainda, o anterior foi cancelado, ou a Amazon recusou a criação
      const recriar = !plano || plano.passo === "cancelado" || (plano.passo === "erro" && (!plano.plano_id || String(plano.erro ?? "").startsWith("criando:") || String(plano.erro ?? "").startsWith("criar plano:")));
      if (recriar) {
        if (b.confirmar !== true) return json({ ok: false, erro: "criar o plano na Amazon exige confirmar: true" }, 400);
        if (m.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: m.pendencias }, 400);
        const prep = await prepConstraints(token, m.linhas.map((l) => String(l.msku)));
        const itens = m.linhas.map((l) => {
          const p = prep.get(String(l.msku)) ?? { labelOwner: "SELLER", prepOwner: "NONE" };
          return { msku: String(l.msku), quantity: l.quantidade, labelOwner: p.labelOwner, prepOwner: p.prepOwner, ...(l.validade ? { expiration: l.validade } : {}) };
        });
        const base = { shop_id: m.conta.shop_id, plano_id: null, passo: "novo", operacao_id: null, itens: m.linhas, caixas: null, destinos: null,
          destino_escolhido: null, envios_amazon: null, erro: null, log: [], criado_por: quem.nome, criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() };
        await db.from("amazon_envio_plano").upsert({ envio_id: envioId, ...base }, { onConflict: "envio_id" });
        const nome = `App ${m.envio.numero ? `#${m.envio.numero}` : envioId.slice(0, 8)} · ${new Date().toISOString().slice(0, 10)}`;
        plano = await disparar(envioId, token, "POST", `${API}/inboundPlans`,
          { name: nome, destinationMarketplaces: [MKT], sourceAddress: ORIGEM, items: itens }, "criando", "criar plano");
      }
      // avança até parar ou acabar o tempo
      let guarda = 0;
      while (plano && !PARADOS.has(plano.passo) && Date.now() < ate && guarda++ < 12) {
        const antes = `${plano.passo}|${plano.operacao_id ?? ""}`;
        plano = await passo(plano, token, envioId, ate);
        if (`${plano.passo}|${plano.operacao_id ?? ""}` === antes) break; // operação ainda andando
      }
      return json(resumo(plano));
    }

    if (modulo === "confirmar-destino") {
      const plano = m.plano;
      if (!plano || plano.passo !== "escolher_destino") return json({ ok: false, erro: "o plano não está esperando a escolha do destino" }, 400);
      if (b.confirmar !== true) return json({ ok: false, erro: "confirmar o destino exige confirmar: true" }, 400);
      const opcao = ((plano.destinos ?? []) as any[]).find((d) => d.id === String(b.opcao_id ?? ""));
      if (!opcao) return json({ ok: false, erro: "opção de destino não encontrada" }, 400);
      if (opcao.expira && Date.parse(opcao.expira) < Date.now()) return json({ ok: false, erro: "esta opção de destino venceu — gere as opções de novo" }, 400);
      await salvar(envioId, { destino_escolhido: opcao.id }, { acao: "destino escolhido", por: quem.nome, taxa: opcao.taxa });
      let p = await disparar(envioId, token, "POST", `${API}/inboundPlans/${plano.plano_id}/placementOptions/${opcao.id}/confirmation`, {}, "confirmando_destino", "confirmar destino");
      let guarda = 0;
      while (p && !PARADOS.has(p.passo) && Date.now() < ate && guarda++ < 6) {
        const antes = `${p.passo}|${p.operacao_id ?? ""}`;
        p = await passo(p, token, envioId, ate);
        if (`${p.passo}|${p.operacao_id ?? ""}` === antes) break;
      }
      return json(resumo(p));
    }

    if (modulo === "cancelar") {
      const plano = m.plano;
      if (!plano?.plano_id) return json({ ok: false, erro: "não há plano na Amazon para cancelar" }, 400);
      if (plano.passo === "cancelado") return json(resumo(plano));
      if (b.confirmar !== true) return json({ ok: false, erro: "cancelar exige confirmar: true" }, 400);
      await salvar(envioId, {}, { acao: "cancelamento pedido", por: quem.nome });
      const r = await sp(token, "PUT", `${API}/inboundPlans/${plano.plano_id}/cancellation`);
      if (!ok(r) || !r.body?.operationId) {
        const p = await salvar(envioId, { erro: `cancelar: a Amazon recusou — ${motivo(r)}` }, { acao: "cancelar", http: r.status, erro: motivo(r) });
        return json({ ...resumo(p), ok: false, erro: `a Amazon recusou o cancelamento: ${motivo(r)}` });
      }
      let p = await salvar(envioId, { passo: "cancelando", operacao_id: String(r.body.operationId), erro: null }, { acao: "cancelar", http: r.status });
      p = await passo(p, token, envioId, ate);
      return json(resumo(p));
    }

    return json({ ok: false, erro: "use modulo previa, avancar, confirmar-destino ou cancelar" }, 400);
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
