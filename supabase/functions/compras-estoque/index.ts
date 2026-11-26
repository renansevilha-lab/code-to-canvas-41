// ============================================================================
// Edge Function: compras-estoque v9 (26/nov/2026)
// v9: PREÇO NF EDITÁVEL por item (pedido do dono, 26/nov): precos={"sku":{"preco":18.02,"motivo":"..."}}
//     substitui o preço unitário da NF/OC ANTES do rateio (valor = preço × unidades), então
//     frete/IPI/ST/outras/desconto rateados por valor se redistribuem com o preço certo.
//     O preço original da nota continua no retorno (preco_nf_original) e fica gravado em
//     compras_custo_formacao.precos junto com os extras.
// v8: formação de custo pelo VALOR DA NF (com desconto) e CUSTO MANUAL.
//     - Item com NF aplicada (compra_ordem_nf_qtd.valor) usa o valor líquido da
//       NF (vProd − desconto do item) em vez do preço da OC.
//     - Cabeçalho da NF (compras_nf_aplicada: frete, IPI, ST, outras, desconto
//       não abatido nos itens) pré-preenche os extras quando a formação ainda
//       não foi salva. NF do Tiny: o cabeçalho é lido da API (GET /notas/{id})
//       e guardado — a API do Tiny não dá desconto por item, só o total.
//     - manuais={"sku":{"custo":12.3,"motivo":"..."}}: custo digitado substitui
//       o calculado (o calculado continua visível e fica registrado).
// v7: fornecedores[].padrao obrigatório no PUT /produtos (GET não traz) — 1º = padrão.
// v6: despesa MANUAL por unidade por SKU (ex.: etiqueta R$0,40/un) — param
//     ajustes={"sku":{"valor_un":0.4,"motivo":"etiqueta"}}; soma depois do rateio.
// v5: FORMAÇÃO DE CUSTO da compra (custo-preview / custo-aplicar / custo-teste)
//     — ver bloco "FORMAÇÃO DE CUSTO" abaixo.
// v4: base=nf — lança SEM conferência, pela quantidade da NF (qtd_nf, ou a
//     quantidade da linha: na OC criada pela NF já está em unidades do SKU;
//     na OC do Tiny sem NF aplicada é a quantidade pedida). Ledger grava a base.
// v2: item "só na NF" (so_na_nf) é produto de verdade — entra no lançamento.
// Lança no Tiny a ENTRADA de estoque de uma ordem de compra (depósito Geral
// 604130012), manual: preview → confirmar. Idempotente pelo ledger
// compras_estoque_lancamentos (relança só o delta; nunca estorna). Kits
// explodidos. Token Tiny SEMPRE da conta 'ottz'.
//
//   ?modulo=preview&ordem_tiny_id=X[&base=conferido|nf]
//   ?modulo=lancar&ordem_tiny_id=X&confirmar=1[&base=..][&lancado_por=Nome]
//   ?modulo=custo-preview&ordem_tiny_id=X[&frete=&ipi=&st=&outras=&desconto=&rateio=valor|quantidade][&ajustes=JSON][&manuais=JSON][&precos=JSON]
//   ?modulo=custo-aplicar&ordem_tiny_id=X&confirmar=1&skus=a,b[&extras..][&aplicado_por=Nome]
//   ?modulo=custo-teste&sku=X   (diagnóstico: regrava o MESMO custo e confere o cadastro)
// Exige JWT de usuário logado (ou service role).
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DEPOSITO_GERAL = 604130012;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(b: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(b), { ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) } });
}
function dataSP(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ").slice(0, 19);
}

async function tokenOttz(sb: ReturnType<typeof createClient>): Promise<string> {
  const { data, error } = await sb.from("oauth_tokens_tiny").select("access_token")
    .eq("conta", "ottz").order("atualizado_em", { ascending: false }).limit(1).single();
  if (error || !data) throw new Error("Token Tiny (conta ottz) não encontrado");
  return (data as { access_token: string }).access_token;
}

async function tinyEntrada(token: string, idTiny: number, quantidade: number, preco: number, obs: string) {
  for (let t = 0; t <= 2; t++) {
    const resp = await fetch(`${TINY_API_HOST}/estoque/${idTiny}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ tipo: "E", data: dataSP(), quantidade, precoUnitario: preco, observacoes: obs, deposito: { id: DEPOSITO_GERAL } }),
    });
    const txt = await resp.text();
    if (resp.ok) { let js: any = null; try { js = JSON.parse(txt); } catch { /* */ } return { ok: true, id: js?.idLancamento ?? null, status: resp.status, erro: null as string | null }; }
    if ((resp.status === 429 || resp.status >= 500) && t < 2) { await sleep(1500 * 2 ** t); continue; }
    return { ok: false, id: null, status: resp.status, erro: txt.slice(0, 180) };
  }
  return { ok: false, id: null, status: 0, erro: "exauriu tentativas" };
}
// ============================================================================
// FORMAÇÃO DE CUSTO (v5, 02/out/2026; v8 06/out; v9 26/nov) — custo unitário da compra =
// (valor do SKU + rateio dos extras) / unidades. Valor do SKU = preço digitado (v9)
// × unidades, senão valor LÍQUIDO da NF aplicada (vProd − desconto do item) quando
// houver, senão preço da OC × qtd. Extras (frete, IPI, ST, outras, −desconto)
// rateados por VALOR (padrão) ou QUANTIDADE. Usa o preço DESTA nota (não média com
// o estoque). Aplicar grava precoCusto no cadastro do Tiny (PUT /produtos/{id}
// reenviando TODOS os campos lidos do GET — só o custo muda — e conferindo depois)
// e já atualiza produtos.custo (sem esperar o sync das 05:00). Kits/variações ficam de fora.
// ============================================================================
type Extras = { frete: number; ipi: number; st: number; outras: number; desconto: number; rateio: "valor" | "quantidade" };
// Despesa manual por unidade (ex.: etiqueta), por SKU — soma DEPOIS do rateio (v6).
type Ajustes = Record<string, { valor_un: number; motivo: string | null }>;
// Custo digitado (v8) — substitui o calculado.
type Manuais = Record<string, { custo: number; motivo: string | null }>;
// Preço unitário digitado (v9) — substitui o preço da NF/OC antes do rateio.
type Precos = Record<string, { preco: number; motivo: string | null }>;
function lerJson(v: unknown): any {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return {}; } }
  return v ?? {};
}
function lerAjustes(v: unknown): Ajustes {
  const o = lerJson(v);
  const out: Ajustes = {};
  for (const [sku, a] of Object.entries(o ?? {})) {
    const n = Number((a as any)?.valor_un);
    if (Number.isFinite(n) && n !== 0) out[sku] = { valor_un: Math.round(n * 10000) / 10000, motivo: (a as any)?.motivo ? String((a as any).motivo).slice(0, 80) : null };
  }
  return out;
}
function lerManuais(v: unknown): Manuais {
  const o = lerJson(v);
  const out: Manuais = {};
  for (const [sku, a] of Object.entries(o ?? {})) {
    const n = Number((a as any)?.custo);
    if (Number.isFinite(n) && n > 0) out[sku] = { custo: Math.round(n * 100) / 100, motivo: (a as any)?.motivo ? String((a as any).motivo).slice(0, 120) : null };
  }
  return out;
}
function lerPrecos(v: unknown): Precos {
  const o = lerJson(v);
  const out: Precos = {};
  for (const [sku, a] of Object.entries(o ?? {})) {
    const n = Number((a as any)?.preco);
    if (Number.isFinite(n) && n > 0) out[sku] = { preco: Math.round(n * 10000) / 10000, motivo: (a as any)?.motivo ? String((a as any).motivo).slice(0, 120) : null };
  }
  return out;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

// Cabeçalho das NFs aplicadas à OC. NF do Tiny ainda não lida → GET /notas/{id}
// (a API não traz desconto por item; o total do desconto entra como extra).
async function cabecalhosNf(sb: any, ordemId: number, getToken: () => Promise<string>) {
  const { data } = await sb.from("compras_nf_aplicada").select("*").eq("ordem_tiny_id", ordemId);
  const lista = (data ?? []) as any[];
  for (const c of lista) {
    if (c.origem !== "tiny" || c.lido_em || !c.nf_tiny_id) continue;
    try {
      const token = await getToken();
      const g = await tinyReq(token, "GET", `/notas/${c.nf_tiny_id}`);
      if (!g.ok) { c.erro_leitura = `GET /notas ${g.status}`; continue; }
      const n = g.js ?? {};
      const novo = {
        frete: Number(n.valorFrete || 0), ipi: Number(n.valorIpi || 0), st: Number(n.valorIcmsSt || 0),
        outras: Number(n.valorOutras || 0) + Number(n.valorSeguro || 0), desconto_total: Number(n.valorDesconto || 0),
        lido_em: new Date().toISOString(),
      };
      Object.assign(c, novo);
      await sb.from("compras_nf_aplicada").update(novo).eq("ordem_tiny_id", ordemId).eq("nf_numero", c.nf_numero);
    } catch (e) { c.erro_leitura = (e as Error).message; }
  }
  return lista.map((c) => ({
    nf_numero: c.nf_numero, origem: c.origem,
    frete: Number(c.frete || 0), ipi: Number(c.ipi || 0), st: Number(c.st || 0), outras: Number(c.outras || 0),
    desconto_total: Number(c.desconto_total || 0), desconto_itens: Number(c.desconto_itens || 0),
    // desconto que ainda não está no valor dos itens (Tiny: todo; XML: o que sobrar)
    desconto_extra: r2(Math.max(0, Number(c.desconto_total || 0) - Number(c.desconto_itens || 0))),
    lido: c.origem === "xml" ? c.desconto_total != null : !!c.lido_em,
    erro_leitura: c.erro_leitura ?? null,
  }));
}

async function carregarExtras(sb: any, ordemId: number, p: (k: string) => string | null, getToken: () => Promise<string>) {
  const { data: salvo } = await sb.from("compras_custo_formacao").select("*").eq("ordem_tiny_id", ordemId).maybeSingle();
  const { data: nfs } = await sb.from("compras_nf_entrada").select("valor_frete").eq("ordem_tiny_id", ordemId);
  const freteNf = ((nfs ?? []) as any[]).reduce((s, n) => s + Number(n.valor_frete || 0), 0);
  const cab = await cabecalhosNf(sb, ordemId, getToken);
  const soma = (k: string) => r2(cab.reduce((s, c: any) => s + Number(c[k] || 0), 0));
  // Sem formação salva: extras vêm do cabeçalho das NFs aplicadas (ou só o frete das NFs vinculadas).
  const padrao = cab.length
    ? { frete: soma("frete"), ipi: soma("ipi"), st: soma("st"), outras: soma("outras"), desconto: soma("desconto_extra") }
    : { frete: freteNf, ipi: 0, st: 0, outras: 0, desconto: 0 };
  const num = (k: keyof Extras, valor: number) => { const v = p(k); return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : valor; };
  const s = (salvo ?? {}) as any;
  const ex: Extras = {
    frete: num("frete", salvo ? Number(s.frete ?? 0) : padrao.frete),
    ipi: num("ipi", salvo ? Number(s.ipi ?? 0) : padrao.ipi),
    st: num("st", salvo ? Number(s.st ?? 0) : padrao.st),
    outras: num("outras", salvo ? Number(s.outras ?? 0) : padrao.outras),
    desconto: num("desconto", salvo ? Number(s.desconto ?? 0) : padrao.desconto),
    rateio: (p("rateio") ?? s.rateio) === "quantidade" ? "quantidade" : "valor",
  };
  const ajustes = lerAjustes(p("ajustes") ?? s.ajustes ?? {});
  const manuais = lerManuais(p("manuais") ?? s.manuais ?? {});
  const precos = lerPrecos(p("precos") ?? s.precos ?? {});
  return { ex, ajustes, manuais, precos, salvo, freteNf, cabecalho_nf: cab, extras_da_nf: padrao };
}

async function formarCusto(sb: any, ordemId: number, ex: Extras, ajustes: Ajustes = {}, manuais: Manuais = {}, precos: Precos = {}) {
  const { data: itens } = await sb.from("compra_ordem_itens")
    .select("id, sku, descricao, tiny_produto_id, quantidade, qtd_nf, preco, so_na_nf").eq("ordem_tiny_id", ordemId);
  const { data: nfq } = await sb.from("compra_ordem_nf_qtd").select("item_id, nf_numero, qtd, valor, desconto").eq("ordem_tiny_id", ordemId);
  // valor da NF por item (só linhas com valor — as aplicadas antes da v8 não têm)
  const nfPorItem = new Map<string, { qtd: number; valor: number; desconto: number; nfs: Set<string>; semValor: boolean }>();
  for (const r of (nfq ?? []) as any[]) {
    const a = nfPorItem.get(r.item_id) ?? { qtd: 0, valor: 0, desconto: 0, nfs: new Set<string>(), semValor: false };
    if (r.valor == null) a.semValor = true;
    else { a.qtd += Number(r.qtd || 0); a.valor += Number(r.valor || 0); a.desconto += Number(r.desconto || 0); }
    a.nfs.add(r.nf_numero);
    nfPorItem.set(r.item_id, a);
  }
  const avisos: Array<{ sku: string | null; motivo: string }> = [];
  const porSku = new Map<string, { unidades: number; valor: number; desconto: number; origem: "nf" | "oc" | "misto"; nfs: Set<string> }>();
  for (const it of (itens ?? []) as any[]) {
    const sku = String(it.sku || "").trim();
    const nf = nfPorItem.get(it.id);
    const usaNf = !!nf && !nf.semValor && nf.qtd > 0;
    const un = usaNf ? nf!.qtd : Number(it.qtd_nf ?? it.quantidade ?? 0);
    if (un <= 0) continue;
    if (!sku) { avisos.push({ sku: it.descricao, motivo: "linha sem SKU — fora da formação" }); continue; }
    if (ordemId > 0 && Number(it.tiny_produto_id || 0) <= 0 && !it.so_na_nf) { avisos.push({ sku, motivo: "linha da OC sem produto vinculado no Tiny — fora" }); continue; }
    if (nf?.semValor) avisos.push({ sku, motivo: `NF ${[...nf.nfs].join(", ")} aplicada antes do valor por item — usando o preço da OC; reaplique a NF para usar o preço da nota` });
    const a = porSku.get(sku) ?? { unidades: 0, valor: 0, desconto: 0, origem: usaNf ? "nf" : "oc", nfs: new Set<string>() };
    if ((a.origem === "nf") !== usaNf && a.unidades > 0) a.origem = "misto";
    a.unidades += un;
    a.valor += usaNf ? nf!.valor : un * Number(it.preco || 0);
    if (usaNf) { a.desconto += nf!.desconto; nf!.nfs.forEach((n) => a.nfs.add(n)); }
    porSku.set(sku, a);
  }
  const skus = [...porSku.keys()];
  const prod = new Map<string, any>();
  for (let i = 0; i < skus.length; i += 300) {
    const { data } = await sb.from("produtos").select("sku, id_tiny, tipo, nome, custo, foto_capa").in("sku", skus.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) prod.set(r.sku, r);
  }
  const base: any[] = [];
  for (const [sku, a] of porSku) {
    const pr = prod.get(sku);
    if (!pr) { avisos.push({ sku, motivo: "SKU sem cadastro" }); continue; }
    if (pr.tipo === "K") { avisos.push({ sku, motivo: "kit — o custo vem da composição, não da compra" }); continue; }
    if (!pr.id_tiny) { avisos.push({ sku, motivo: "sem id do Tiny" }); continue; }
    // v9: preço unitário digitado substitui o da NF/OC antes do rateio
    const valorOriginal = a.valor;
    const pm = precos[sku];
    const valor = pm ? pm.preco * a.unidades : a.valor;
    if (valor <= 0) { avisos.push({ sku, motivo: "sem preço na OC/NF" }); continue; }
    base.push({ sku, pr, ...a, valor, valorOriginal, precoManual: pm ?? null });
  }
  const extrasTotal = r2(ex.frete + ex.ipi + ex.st + ex.outras - ex.desconto);
  const totValor = base.reduce((s, b) => s + b.valor, 0);
  const totUn = base.reduce((s, b) => s + b.unidades, 0);
  let distribuido = 0;
  const linhas = base.sort((x, y) => y.valor - x.valor).map((b, i) => {
    const peso = ex.rateio === "quantidade" ? (totUn > 0 ? b.unidades / totUn : 0) : (totValor > 0 ? b.valor / totValor : 0);
    // último leva o resto do arredondamento — a soma do rateio fecha no centavo
    const rateio = i === base.length - 1 ? r2(extrasTotal - distribuido) : r2(extrasTotal * peso);
    distribuido = r2(distribuido + rateio);
    const aj = ajustes[b.sku]?.valor_un ?? 0;
    const calculado = r2((b.valor + rateio) / b.unidades + aj);
    const man = manuais[b.sku];
    const custo = man ? man.custo : calculado;
    const atual = b.pr.custo != null ? Number(b.pr.custo) : null;
    return {
      sku: b.sku, id_tiny: b.pr.id_tiny, nome: b.pr.nome, foto: b.pr.foto_capa ?? null,
      unidades: b.unidades, valor_nf: r2(b.valor), preco_nf_unit: r4(b.valor / b.unidades),
      preco_manual: !!b.precoManual, preco_manual_motivo: b.precoManual?.motivo ?? null,
      preco_nf_original: b.valorOriginal > 0 ? r4(b.valorOriginal / b.unidades) : null,
      origem_preco: b.origem, nfs: [...b.nfs], desconto_item: r2(b.desconto), desconto_item_unit: r4(b.desconto / b.unidades),
      rateio_total: rateio, rateio_unit: r4(rateio / b.unidades), ajuste_unit: aj, ajuste_motivo: ajustes[b.sku]?.motivo ?? null,
      custo_calculado: calculado, manual: !!man, manual_motivo: man?.motivo ?? null, custo_final: custo,
      custo_atual: atual, variacao_pct: atual && atual > 0 ? Math.round(((custo - atual) / atual) * 1000) / 10 : null,
    };
  });
  return { linhas, avisos, extras_total: extrasTotal, total_nf: r2(totValor), total_com_extras: r2(totValor + extrasTotal) };
}

// Monta o corpo do PUT /produtos/{id} a partir do GET — reenvia tudo, troca só o custo.
function corpoProduto(d: any, precoCusto: number) {
  const corpo: any = {
    sku: d.sku, descricao: d.descricao,
    descricaoComplementar: d.descricaoComplementar ?? "", unidade: d.unidade ?? "", unidadePorCaixa: d.unidadePorCaixa ?? "",
    ncm: d.ncm ?? "", gtin: d.gtin ?? "", origem: d.origem != null && d.origem !== "" ? Number(d.origem) : null,
    codigoEspecificadorSubstituicaoTributaria: d.codigoEspecificadorSubstituicaoTributaria ?? undefined,
    garantia: d.garantia ?? "", observacoes: d.observacoes ?? "",
    precos: { preco: d.precos?.preco ?? null, precoPromocional: d.precos?.precoPromocional ?? null, precoCusto },
  };
  if (d.marca?.id) corpo.marca = { id: d.marca.id };
  if (d.categoria?.id) corpo.categoria = { id: d.categoria.id };
  if (d.dimensoes) {
    const dm = d.dimensoes;
    corpo.dimensoes = {
      largura: dm.largura, altura: dm.altura, comprimento: dm.comprimento, diametro: dm.diametro,
      pesoLiquido: dm.pesoLiquido, pesoBruto: dm.pesoBruto,
      ...(dm.embalagem?.id ? { embalagem: { id: dm.embalagem.id, tipo: dm.embalagem.tipo } } : {}),
    };
  }
  if (d.tributacao) corpo.tributacao = { gtinEmbalagem: d.tributacao.gtinEmbalagem ?? "", valorIPIFixo: d.tributacao.valorIPIFixo ?? 0, classeIPI: d.tributacao.classeIPI ?? "" };
  if (d.seo) corpo.seo = d.seo;
  // O PUT exige `padrao` não-nulo e o GET não o devolve: 1 fornecedor = o padrão;
  // vários = o primeiro (ordem em que o Tiny lista). (v7, 02/out — PUT 400 sem isso)
  if (Array.isArray(d.fornecedores)) corpo.fornecedores = d.fornecedores.map((f: any, i: number) => ({ id: f.id, codigoProdutoNoFornecedor: f.codigoProdutoNoFornecedor ?? "", padrao: f.padrao ?? (i === 0) }));
  if (d.estoque) {
    const e = d.estoque;
    corpo.estoque = { controlar: e.controlar, sobEncomenda: e.sobEncomenda, minimo: e.minimo, maximo: e.maximo, diasPreparacao: e.diasPreparacao, localizacao: e.localizacao ?? "" };
  }
  return corpo;
}

// Campos comparados antes × depois (tudo menos o custo e o que o Tiny calcula).
function assinatura(d: any) {
  const c = corpoProduto(d, 0);
  delete c.precos.precoCusto;
  return JSON.stringify({ ...c, situacao: d.situacao, tipo: d.tipo, anexos: (d.anexos ?? []).map((a: any) => a.id), kit: d.kit, variacoes: (d.variacoes ?? []).map((v: any) => v.id) });
}

async function tinyReq(token: string, method: string, path: string, body?: unknown) {
  for (let t = 0; t <= 2; t++) {
    const resp = await fetch(`${TINY_API_HOST}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await resp.text();
    let js: any = null; try { js = JSON.parse(txt); } catch { /* */ }
    if (resp.ok) return { ok: true, status: resp.status, js, txt };
    if ((resp.status === 429 || resp.status >= 500) && t < 2) { await sleep(1500 * 2 ** t); continue; }
    return { ok: false, status: resp.status, js, txt: txt.slice(0, 300) };
  }
  return { ok: false, status: 0, js: null, txt: "exauriu tentativas" };
}

// Grava o custo no Tiny com conferência. Recusa variação/kit.
async function tinyGravarCusto(token: string, idTiny: number, novo: number) {
  const g1 = await tinyReq(token, "GET", `/produtos/${idTiny}`);
  if (!g1.ok) return { ok: false, erro: `GET ${g1.status}`, antes: null as number | null, depois: null as number | null };
  const d = g1.js;
  if (d.tipo !== "S" || (d.variacoes ?? []).length || (d.kit ?? []).length) return { ok: false, erro: `produto tipo ${d.tipo} (variação/kit) — atualize no Tiny`, antes: d.precos?.precoCusto ?? null, depois: null };
  const antes = Number(d.precos?.precoCusto ?? 0);
  await sleep(400);
  const pu = await tinyReq(token, "PUT", `/produtos/${idTiny}`, corpoProduto(d, novo));
  if (!pu.ok) return { ok: false, erro: `PUT ${pu.status}: ${pu.txt}`, antes, depois: null };
  await sleep(400);
  const g2 = await tinyReq(token, "GET", `/produtos/${idTiny}`);
  if (!g2.ok) return { ok: false, erro: `conferência GET ${g2.status}`, antes, depois: null };
  const depois = Number(g2.js.precos?.precoCusto ?? 0);
  const iguais = assinatura(d) === assinatura(g2.js);
  if (!iguais) {
    // Algo além do custo mudou: devolve o cadastro como estava (campos + custo antigo).
    await sleep(400);
    const rest = await tinyReq(token, "PUT", `/produtos/${idTiny}`, corpoProduto(d, antes));
    return {
      ok: false, antes, depois,
      erro: `ATENÇÃO: outro campo do cadastro mudou junto — ${rest.ok ? "restaurado automaticamente; confira no Tiny" : `RESTAURAÇÃO FALHOU (${rest.status}) — corrigir no Tiny`}`,
      diff: { antes: JSON.parse(assinatura(d)), depois: JSON.parse(assinatura(g2.js)) },
    };
  }
  if (Math.abs(depois - novo) > 0.005) return { ok: false, erro: `Tiny gravou ${depois} em vez de ${novo}`, antes, depois };
  return { ok: true, erro: null, antes, depois };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const p = (k: string): string | null => url.searchParams.get(k) ?? (body?.[k] != null ? (typeof body[k] === "object" ? JSON.stringify(body[k]) : String(body[k])) : null);
  const modulo = p("modulo") || "preview";

  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let role = "";
  try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = ""; }
  if (bearer !== SRK && role !== "authenticated" && role !== "service_role") {
    return json({ erro: "faça login no app (sessão de usuário exigida)" }, { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SRK);
  const confirmar = p("confirmar") === "1";
  let tokenCache: string | null = null;
  const getToken = async () => (tokenCache ??= await tokenOttz(sb));

  // ---------------- FORMAÇÃO DE CUSTO ----------------
  if (modulo === "custo-teste") {
    const sku = p("sku");
    if (!sku) return json({ erro: "informe sku" }, { status: 400 });
    const { data: pr } = await sb.from("produtos").select("sku, id_tiny").eq("sku", sku).maybeSingle();
    if (!(pr as any)?.id_tiny) return json({ erro: "sku sem id_tiny" }, { status: 404 });
    let token: string;
    try { token = await getToken(); } catch (e) { return json({ erro: (e as Error).message }, { status: 401 }); }
    const g = await tinyReq(token, "GET", `/produtos/${(pr as any).id_tiny}`);
    if (!g.ok) return json({ erro: `GET ${g.status}` }, { status: 502 });
    const atual = Number(g.js.precos?.precoCusto ?? 0);
    const r = await tinyGravarCusto(token, (pr as any).id_tiny, atual); // MESMO valor: não muda nada
    return json({ modulo, sku, custo_regravado: atual, ...r });
  }

  if (modulo === "custo-preview" || modulo === "custo-aplicar") {
    const ordemId = Number(p("ordem_tiny_id") || 0);
    if (!ordemId) return json({ erro: "informe ordem_tiny_id" }, { status: 400 });
    const { ex, ajustes, manuais, precos, salvo, freteNf, cabecalho_nf, extras_da_nf } = await carregarExtras(sb, ordemId, p, getToken);
    const f = await formarCusto(sb, ordemId, ex, ajustes, manuais, precos);
    // NF vinculada à OC mas não aplicada: o preço da nota (e o desconto) não entram.
    const { data: vinc } = await sb.from("compras_nf_entrada").select("numero").eq("ordem_tiny_id", ordemId).eq("ignorar", false);
    const aplicadas = new Set(cabecalho_nf.map((c) => c.nf_numero));
    const naoAplicadas = ((vinc ?? []) as any[]).map((v) => String(v.numero || "").replace(/^0+/, "")).filter((n) => n && !aplicadas.has(n));
    if (naoAplicadas.length) f.avisos.unshift({ sku: null, motivo: `NF ${naoAplicadas.join(", ")} vinculada mas não aplicada à conferência — os preços são da OC e o desconto/IPI da nota não entram. Aplique a NF para usar o valor da nota.` });
    const { data: aplic } = await sb.from("compras_custo_itens").select("sku, custo_final, custo_anterior, tiny_ok, tiny_erro, aplicado_em, aplicado_por, manual").eq("ordem_tiny_id", ordemId);
    const aplicados = Object.fromEntries(((aplic ?? []) as any[]).map((a) => [a.sku, a]));
    if (modulo === "custo-preview") {
      return json({ modulo, extras: ex, ajustes, manuais, precos, frete_nf: freteNf, cabecalho_nf, extras_da_nf, nf_nao_aplicadas: naoAplicadas, salvo: salvo ?? null, ...f, aplicados });
    }
    if (!confirmar) return json({ modulo, precisa_confirmar: true, extras: ex, ...f });
    const quem = p("aplicado_por") || "app";
    const escolhidos = new Set(String(p("skus") || "").split(",").map((s) => s.trim()).filter(Boolean));
    const fila = f.linhas.filter((l: any) => escolhidos.has(l.sku));
    if (fila.length === 0) return json({ erro: "nenhum SKU escolhido" }, { status: 400 });
    const agora = new Date().toISOString();
    await sb.from("compras_custo_formacao").upsert({
      ordem_tiny_id: ordemId, frete: ex.frete, ipi: ex.ipi, st: ex.st, outras: ex.outras, desconto: ex.desconto, rateio: ex.rateio, ajustes, manuais, precos, atualizado_em: agora,
    }, { onConflict: "ordem_tiny_id" });
    let token: string;
    try { token = await getToken(); } catch (e) { return json({ erro: (e as Error).message }, { status: 401 }); }
    const inicio = Date.now(); const resultados: any[] = []; const pendentes: string[] = [];
    for (const l of fila) {
      if (Date.now() - inicio > 22000) { pendentes.push(l.sku); continue; }
      const r = await tinyGravarCusto(token, l.id_tiny, l.custo_final);
      if (r.ok) await sb.from("produtos").update({ custo: l.custo_final }).eq("sku", l.sku);
      await sb.from("compras_custo_itens").upsert({
        ordem_tiny_id: ordemId, sku: l.sku, id_tiny: l.id_tiny, unidades: l.unidades, valor_nf: l.valor_nf, preco_nf_unit: l.preco_nf_unit,
        rateio_total: l.rateio_total, ajuste_unit: l.ajuste_unit, ajuste_motivo: l.ajuste_motivo, custo_final: l.custo_final, custo_anterior: r.antes ?? l.custo_atual,
        custo_calculado: l.custo_calculado, manual: l.manual, manual_motivo: l.manual_motivo, origem_preco: l.preco_manual ? "manual" : l.origem_preco,
        tiny_ok: r.ok, tiny_erro: r.erro, aplicado_em: agora, aplicado_por: quem,
      }, { onConflict: "ordem_tiny_id,sku" });
      resultados.push({ sku: l.sku, ok: r.ok, de: r.antes, para: l.custo_final, erro: r.erro, diff: (r as any).diff ?? undefined });
      await sleep(300);
    }
    if (resultados.some((x) => x.ok)) await sb.from("compras_custo_formacao").update({ aplicado_em: agora, aplicado_por: quem }).eq("ordem_tiny_id", ordemId);
    return json({ modulo, ok: resultados.every((x) => x.ok) && pendentes.length === 0, resultados, pendentes });
  }

  // ---------------- LANÇAMENTO DE ESTOQUE (v4) ----------------
  const ordemId = Number(p("ordem_tiny_id") || 0);
  const lancadoPor = p("lancado_por") || "app";
  const base = p("base") === "nf" ? "nf" : "conferido";
  if (!ordemId) return json({ erro: "informe ordem_tiny_id" }, { status: 400 });

  const { data: oc } = await sb.from("compras_ordens").select("tiny_id, numero, fornecedor_nome, kanban_status, estoque_lancado_em, estoque_lancado_por, nf_numero").eq("tiny_id", ordemId).maybeSingle();
  if (!oc) return json({ erro: "ordem não encontrada" }, { status: 404 });
  const ordem = oc as any;

  const { data: itens } = await sb.from("compra_ordem_itens")
    .select("sku, descricao, tiny_produto_id, quantidade, qtd_recebida, qtd_nf, preco, so_na_nf").eq("ordem_tiny_id", ordemId);
  const lista = (itens ?? []) as any[];
  const temConferencia = lista.some((it) => Number(it.qtd_recebida || 0) > 0);
  const temNf = ordemId < 0 || lista.some((it) => it.qtd_nf != null);
  const avisos: Array<{ sku: string | null; motivo: string }> = [];
  if (base === "nf" && !temNf) avisos.push({ sku: null, motivo: "esta OC não tem NF aplicada — a base é a quantidade PEDIDA na OC" });
  const validos: any[] = [];
  for (const it of lista) {
    const rec = base === "nf" ? Number(it.qtd_nf ?? it.quantidade ?? 0) : Number(it.qtd_recebida || 0);
    if (rec <= 0) continue;
    const sku = String(it.sku || "").trim();
    if (!sku) { avisos.push({ sku: it.descricao, motivo: `${rec} un mas a linha não tem SKU — não lançado` }); continue; }
    if (ordemId > 0 && Number(it.tiny_produto_id || 0) <= 0 && !it.so_na_nf) {
      avisos.push({ sku, motivo: `linha "${String(it.descricao || "").slice(0, 50)}" da OC não tem produto vinculado no Tiny (ex.: fardo digitado à mão) — ${rec} não lançado; lance pela linha do produto` });
      continue;
    }
    validos.push({ ...it, sku, rec });
  }

  const prod = new Map<string, any>();
  async function carregar(skus: string[]) {
    const novos = [...new Set(skus.filter((s) => s && !prod.has(s)))];
    for (let i = 0; i < novos.length; i += 300) {
      const { data } = await sb.from("produtos").select("sku, id_tiny, tipo, nome").in("sku", novos.slice(i, i + 300));
      for (const r of (data ?? []) as any[]) prod.set(r.sku, r);
    }
  }
  await carregar(validos.map((v) => v.sku));
  const kits = validos.map((v) => v.sku).filter((s) => prod.get(s)?.tipo === "K");
  const comp = new Map<string, Array<{ sku: string; qtd: number }>>();
  if (kits.length) {
    const { data } = await sb.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_kit", kits);
    for (const c of (data ?? []) as any[]) {
      if (!comp.has(c.sku_kit)) comp.set(c.sku_kit, []);
      comp.get(c.sku_kit)!.push({ sku: c.sku_componente, qtd: Number(c.quantidade || 0) });
    }
    await carregar([...comp.values()].flat().map((c) => c.sku));
  }

  type Alvo = { id_tiny: number; nome: string | null; recebido: number; valor: number; origem: string };
  const alvos = new Map<string, Alvo>();
  const add = (sku: string, idTiny: number, nome: string | null, qtd: number, valor: number, origem: string) => {
    const a = alvos.get(sku);
    if (a) { a.recebido += qtd; a.valor += valor; if (a.origem !== origem) a.origem = "misto"; }
    else alvos.set(sku, { id_tiny: idTiny, nome, recebido: qtd, valor, origem });
  };
  for (const v of validos) {
    const pr = prod.get(v.sku);
    if (!pr) { avisos.push({ sku: v.sku, motivo: "SKU sem cadastro em produtos" }); continue; }
    if (pr.tipo === "K") {
      const cs = comp.get(v.sku) ?? [];
      if (!cs.length) { avisos.push({ sku: v.sku, motivo: "kit sem composição no cadastro" }); continue; }
      for (const c of cs) {
        const pc = prod.get(c.sku);
        if (!pc?.id_tiny) { avisos.push({ sku: c.sku, motivo: `componente do kit ${v.sku} sem id do Tiny` }); continue; }
        add(c.sku, pc.id_tiny, pc.nome, c.qtd * v.rec, 0, `kit ${v.sku}`);
      }
    } else {
      if (!pr.id_tiny) { avisos.push({ sku: v.sku, motivo: "sem id do Tiny no cadastro" }); continue; }
      add(v.sku, pr.id_tiny, pr.nome, v.rec, v.rec * Number(v.preco || 0), "direto");
    }
  }

  const { data: led } = await sb.from("compras_estoque_lancamentos").select("sku, quantidade, lancado_por, lancado_em, base").eq("ordem_tiny_id", ordemId).order("lancado_em");
  const ja = new Map<string, number>();
  for (const r of (led ?? []) as any[]) ja.set(r.sku, (ja.get(r.sku) || 0) + Number(r.quantidade || 0));

  const plano: any[] = [];
  for (const [sku, a] of alvos) {
    const jaL = ja.get(sku) || 0;
    const delta = Math.round((a.recebido - jaL) * 1000) / 1000;
    if (delta < 0) avisos.push({ sku, motivo: `${base === "nf" ? "quantidade da NF" : "recebido"} (${a.recebido}) menor que o já lançado (${jaL}) — o app não estorna; ajuste no Tiny` });
    const preco = a.recebido > 0 && a.valor > 0 ? Math.round((a.valor / a.recebido) * 10000) / 10000 : 0;
    plano.push({ sku, id_tiny: a.id_tiny, nome: a.nome, origem: a.origem, recebido: a.recebido, ja_lancado: jaL, a_lancar: Math.max(0, delta), preco_unitario: preco });
  }
  plano.sort((x, y) => String(x.sku).localeCompare(String(y.sku)));
  const historico = ((led ?? []) as any[]).map((r) => ({ sku: r.sku, quantidade: Number(r.quantidade), lancado_por: r.lancado_por, lancado_em: r.lancado_em, base: r.base }));
  const resumo = {
    base, tem_conferencia: temConferencia, tem_nf: temNf,
    ordem: { tiny_id: ordem.tiny_id, numero: ordem.numero, fornecedor: ordem.fornecedor_nome, estoque_lancado_em: ordem.estoque_lancado_em, estoque_lancado_por: ordem.estoque_lancado_por },
    deposito: { id: DEPOSITO_GERAL, nome: "Geral" }, avisos, historico,
  };

  if (modulo === "preview") return json({ modulo, ...resumo, plano });

  if (modulo === "lancar") {
    const fila = plano.filter((x) => x.a_lancar > 0);
    if (!confirmar) return json({ modulo, precisa_confirmar: true, ...resumo, plano: fila });
    let token: string;
    try { token = await getToken(); } catch (e) { return json({ erro: (e as Error).message }, { status: 401 }); }
    const inicio = Date.now(); const erros: string[] = []; let movimentos = 0;
    const obs = `Compra OC #${ordem.numero ?? ordemId} (app${base === "nf" ? ", pela NF sem conferência" : ""}) · ${lancadoPor}`;
    for (const it of fila) {
      if (Date.now() - inicio > 24000) { erros.push("tempo esgotado — clique de novo para continuar (só lança o que falta)"); break; }
      const r = await tinyEntrada(token, it.id_tiny, it.a_lancar, it.preco_unitario, obs);
      if (r.ok) {
        movimentos++;
        await sb.from("compras_estoque_lancamentos").insert({
          ordem_tiny_id: ordemId, sku: it.sku, id_tiny: it.id_tiny, quantidade: it.a_lancar,
          preco_unitario: it.preco_unitario, deposito_id: DEPOSITO_GERAL, tiny_id_lancamento: r.id, lancado_por: lancadoPor, base,
        });
      } else erros.push(`${it.sku}: HTTP ${r.status} ${r.erro ?? ""}`);
      await sleep(150);
    }
    if (erros.length === 0 && movimentos > 0) {
      await sb.from("compras_ordens").update({ estoque_lancado_em: new Date().toISOString(), estoque_lancado_por: lancadoPor }).eq("tiny_id", ordemId);
    }
    return json({ modulo, ok: erros.length === 0, movimentos, itens: fila.length, base, avisos, erros });
  }

  return json({ erro: `modulo '${modulo}' desconhecido` }, { status: 400 });
});
