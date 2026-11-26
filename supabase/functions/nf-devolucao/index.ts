// ============================================================================
// Edge Function: nf-devolucao v3.27 (MULTI-CONTA: ottz | svl)
// v3.27 (26/nov/2026, pedido do dono): conta OTTZ volta a ser automatizada, so vendas do LUCRO REAL da ACZ.
//   - natureza padrao da Ottz = "Devolução de Venda de Mercadoria - Lucro Real" (param `natureza` ainda troca).
//     Com ela o Tiny cria a nota no regime 3 com ICMS destacado (a natureza antiga saia regime 1 e a SEFAZ
//     recusava com 481). A serie sai a da natureza (20), o param `serie` e ignorado pelo Tiny nesse caso.
//   - trava: venda da Ottz so gera devolucao se a NF de venda e da ACZ (CNPJ na chave) e foi emitida em/apos
//     10/08/2026 (Lucro Real). Antes disso = codigo `venda_simples` (periodo desconsiderado por decisao do dono).
//   - caminho direto aceita so `pedido_id` (a nota vem do proprio pedido) e, na Ottz, pedido NAO cancelado com
//     reembolso ACEITO da Shopee (loja Ottz) — igual a SVL; parcial recorta os itens sem abrir kit (a NF da Ottz
//     traz o kit inteiro).
//   - anti-duplicata da Ottz tambem olha o espelho fiscal: devolucao (finalidade 4) ja emitida pela ACZ que
//     referencia a chave da venda (fiscal_nfe.ref_nfe) — cobre as feitas a mao no Tiny (o espelho e noturno).
// v3.26 (24/nov/2026): depois de criar, o `criar` RELE a nota no Tiny e compara os itens com o que foi enviado. Quando
//   a venda tem um KIT cadastrado como kit na conta, a v2 `nota.fiscal.incluir` DESMEMBRA o kit nos componentes e o
//   Tiny depois recusa emitir ("o item X esta sem a chave de acesso da NF-e referenciada": o item nao casa com a NF de
//   origem). 45 notas da SVL de 19/11 cairam nisso. A resposta traz `itens_criados` e `itens_divergem` (o motor marca
//   `revisar` e nao emite). Nao ha campo na v2 para evitar o desmembramento (doc oficial).
// v3.25 (22/nov/2026): o caminho direto (id_nota_venda + pedido_id, guard = pedido cancelado AO VIVO e nota
//   vinculada a ele) vale tambem para a conta OTTZ (historico de vendas do Lucro Real). `pedido_svl_id` continua
//   aceito como apelido de `pedido_id`. Param opcional `natureza` troca a natureza de operacao da devolucao
//   (ex.: venda feita no Simples -> natureza sem credito, a criar no Tiny).
// v3.24 (19/nov/2026): criar&conta=svl aceita id_nota_venda + pedido_svl_id (venda que vive NO Tiny SVL —
//   historico 2025–jun/2026 da Sevilla Store / ML SVL, sem pedido no principal). Guard = pedido de origem
//   cancelado AO VIVO no Tiny SVL e nota vinculada a ele. Usado pelo devolucao-auto?modulo=processar-historico.
// v3.23 (01/out): o CEP do pedido na SVL pode diferir do principal (ex.:
//   260803B87YQ2QA so achou pelo valor). Candidatos = CEP igual primeiro,
//   depois valor igual; a confirmacao segue exata por numeroOrdemCompra.
// v3.22 (01/out): a ponte acharVendaSVL listava a janela data-1..data+2 com teto
//   de 6 paginas (600 pedidos) — a Bumi faz ~165 pedidos/dia, a janela passava
//   de 600 e o pedido ficava alem do corte ("nao encontrei", com paginas=6 e
//   0 candidatos). Agora: janelas PROGRESSIVAS (dia do pedido e seguinte ->
//   alarga), ate 20 paginas no total, ancoradas tambem na data do order_sn
//   da Shopee (YYMMDD no inicio).
// v3.21 (30/set): o SKU da devolucao Shopee e o do ANUNCIO (sku pai) e a NF
//   da SVL traz o SKU do Tiny ja com KIT ABERTO em componentes (ex.: 15205 =
//   2x 15190). Reembolso que cobre o pedido todo (itens ou valor) = NF
//   inteira; parcial = traduz pedido_itens (pai -> filho) e abre o kit por
//   produto_kits antes de recortar. O que nao casar continua em revisao.
// v3.20 (30/set): automacao SVL (devolucao-auto chama o criar):
//   - criar SVL aceita pedido NAO cancelado quando ha reembolso ACEITO da
//     Shopee no espelho (shopee_devolucoes.status=ACCEPTED) — reembolso de
//     pedido entregue; e devolve SO os SKUs/qtds reembolsados (parcial).
//   - anti-duplicata antes de criar (dry e confirmar): notas_cancelados,
//     devolucoes_svl_base.chave_referenciada e devolucao_auto.
//   - nota criada entra na hora em devolucoes_svl_base (lista de emissao).
//   - respostas de recusa ganham `codigo` (sem_pedido_svl, sem_nf_venda,
//     venda_nao_autorizada, nao_cancelado, ja_existe, revisar_itens, ...).
//   - serie default da SVL = 12 (a das devolucoes; "1" era a da venda).
// v3.17: itens fiscais do XML AUTORIZADO da venda qdo rascunho sem NCM; clonar
//   aceita rejeitada (sit 5); lote reclona clones que nao autorizam.
// v3.18: obter.xml devolve XML CRU — tinyV2Texto() le inteiro.
// v3.19 (30/ago): CAUSA RAIZ das rejeicoes remanescentes da SVL — devolucoes
//   referenciando NF de VENDA que NUNCA FOI AUTORIZADA (venda Pendente desde
//   jan/fev; a SEFAZ rejeita refNFe inexistente). Guard: antes de recriar,
//   checa a situacao da venda pela chave (pesquisa v2); se nao autorizada,
//   recusa com motivo claro e APOSENTA o caso no motor (devolucao_clonadas.
//   id_novo=null = tratar manualmente: excluir rascunho na UI — venda sem NF
//   nao gera devolucao). Sem isso o lote criava clone rejeitado a cada rodada.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
const TINY_V2_HOST = "https://api.tiny.com.br/api2";
const TINY_V2_TOKEN_OTTZ = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
const TINY_V2_TOKEN_SVL = (Deno.env.get("TINY_V2_TOKEN_SVL") || "").trim();
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serieDevolucaoDe(conta: string): string {
  if (conta === "svl") return (Deno.env.get("TINY_SERIE_DEVOLUCAO_SVL") || "12").trim();
  return "13";
}
// v3.27: Ottz (ACZ) no Lucro Real desde 10/08/2026 — so essas vendas geram devolucao automatica
const NATUREZA_OTTZ_LUCRO_REAL = "Devolução de Venda de Mercadoria - Lucro Real";
const CNPJ_ACZ = "37393638000140";
const INICIO_LUCRO_REAL = "2026-08-10";
const SHOP_SHOPEE_OTTZ = 522186766;
function v2TokenDe(conta: string): string {
  return conta === "svl" ? TINY_V2_TOKEN_SVL : TINY_V2_TOKEN_OTTZ;
}
function digits(s: unknown): string { return String(s ?? "").replace(/\D/g, ""); }

function fixEnc(s: string | null | undefined): string {
  if (!s) return "";
  const str = String(s);
  if (!/[Â-Ã]/.test(str)) return str;
  try {
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    const dec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return dec.length <= str.length ? dec : str;
  } catch {
    return str;
  }
}

async function pegarToken(supabase: ReturnType<typeof createClient>, conta: string): Promise<string> {
  const { data, error } = await supabase
    .from("oauth_tokens_tiny").select("access_token").eq("conta", conta).limit(1).single();
  if (error || !data) throw new Error(`Token Tiny (conta ${conta}) nao encontrado. Autorize em /functions/v1/tiny-oauth?conta=${conta}`);
  return data.access_token as string;
}

async function tinyFetch(accessToken: string, path: string, init?: RequestInit, maxRetries = 3): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(`${TINY_API_HOST}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers || {}),
      },
    });
    if (resp.ok) return await resp.json().catch(() => ({}));
    if (resp.status === 404) return null;
    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 15000);
      if (attempt < maxRetries) { await sleep(waitMs); continue; }
    }
    const text = await resp.text();
    throw new Error(`Tiny ${resp.status} em ${path}: ${text.substring(0, 200)}`);
  }
  throw new Error(`Tiny exauriu retries em ${path}`);
}

async function tinyV2(servico: string, params: Record<string, string>, token: string): Promise<any> {
  const body = new URLSearchParams({ token, formato: "json", ...params });
  const resp = await fetch(`${TINY_V2_HOST}/${servico}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const txt = await resp.text();
  try { return JSON.parse(txt); } catch { return { _raw: txt.substring(0, 500) }; }
}

async function tinyV2Texto(servico: string, params: Record<string, string>, token: string): Promise<string> {
  const body = new URLSearchParams({ token, formato: "json", ...params });
  const resp = await fetch(`${TINY_V2_HOST}/${servico}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return await resp.text();
}

function v2Bloqueada(ret: any): boolean {
  return String(ret?.codigo_erro ?? "") === "6" ||
    (Array.isArray(ret?.erros) && ret.erros.some((e: any) => /API Bloqueada|Excedido o n/i.test(e?.erro || "")));
}

function extrairChaveReferenciada(observacoes: string | null | undefined): string | null {
  if (!observacoes) return null;
  const m = String(observacoes).match(/referenciada:\s*([0-9]{44})/i) || String(observacoes).match(/([0-9]{44})/);
  return m ? m[1] : null;
}

function parseItensXml(xml: string): any[] {
  const dets = xml.match(/<det nItem="\d+">[\s\S]*?<\/det>/g) || [];
  return dets.map((d) => {
    const g = (tag: string) => {
      const m = d.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1] : "";
    };
    return {
      codigo: fixEnc(g("cProd")),
      descricao: fixEnc(g("xProd")),
      ncm: digits(g("NCM")),
      unidade: fixEnc(g("uCom")) || "UN",
      quantidade: g("qCom") || "1",
      valor_unitario: g("vUnCom") || "0",
    };
  });
}

/** v3.19: situacao da NF de venda pela chave. true=autorizada, false=NAO autorizada, null=nao encontrada. */
async function vendaAutorizadaPelaChave(v2Token: string, chave: string): Promise<boolean | null> {
  const numero = String(parseInt(chave.substring(25, 34), 10));
  const r = await tinyV2("notas.fiscais.pesquisa.php", { numero }, v2Token);
  const notas = (r?.retorno?.notas_fiscais || []).map((n: any) => n?.nota_fiscal || n).filter((n: any) => n?.tipo === "S");
  if (notas.length === 0) return null;
  // 6 Autorizada / 7 Emitida DANFE = existe na SEFAZ
  return notas.some((n: any) => ["6", "7"].includes(String(n.situacao)));
}

/** Acha a NF de venda pela CHAVE e devolve os itens do XML autorizado. */
async function itensDaVendaPorChave(v2Token: string, chave: string): Promise<{ itens: any[]; fonte_id: string | null; erro?: string }> {
  const numero = String(parseInt(chave.substring(25, 34), 10));
  const r = await tinyV2("notas.fiscais.pesquisa.php", { numero }, v2Token);
  if (v2Bloqueada(r?.retorno)) return { itens: [], fonte_id: null, erro: "v2 bloqueada (cod 6)" };
  const notas = (r?.retorno?.notas_fiscais || []).map((n: any) => n?.nota_fiscal || n).filter((n: any) => n?.tipo === "S");
  for (const n of notas.slice(0, 5)) {
    await sleep(400);
    const txt = await tinyV2Texto("nota.fiscal.obter.xml.php", { id: String(n.id) }, v2Token);
    let xml = txt;
    try {
      const j = JSON.parse(txt);
      xml = String(j?.retorno?.xml_nfe ?? j?.retorno?.xml ?? "");
    } catch { /* txt ja e o XML cru */ }
    if (!xml || !xml.includes(chave)) continue;
    const itens = parseItensXml(xml);
    if (itens.length > 0) return { itens, fonte_id: String(n.id) };
  }
  return { itens: [], fonte_id: null, erro: `xml da venda ${numero} nao encontrado pela chave` };
}

async function acharVendaSVL(
  tokenSVL: string,
  alvo: { ordem: string; valor: number; cep: string; data: string },
): Promise<{ candidatos: number; examinados: number; pedido: any; nota_venda: any; paginas: number }> {
  const out = { candidatos: 0, examinados: 0, pedido: null as any, nota_venda: null as any, paginas: 0 };
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const alvoValorC = Math.round(Number(alvo.valor) * 100);
  const alvoCep = digits(alvo.cep);
  const alvoOrdem = String(alvo.ordem).trim();
  // ancora: data do pedido no principal; order_sn da Shopee comeca com YYMMDD
  const ancoras = [new Date(`${alvo.data}T12:00:00Z`)];
  const m = alvoOrdem.match(/^(\d{2})(\d{2})(\d{2})[0-9A-Z]{8}$/);
  if (m) {
    const d = new Date(`20${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
    if (!isNaN(d.getTime()) && fmt(d) !== fmt(ancoras[0])) ancoras.push(d);
  }
  const base = ancoras[0];
  const dia = (n: number) => fmt(new Date(base.getTime() + n * 86400000));
  // janelas progressivas: estreita primeiro (cabe em poucas paginas), depois alarga
  const janelas: [string, string][] = [];
  for (const a of ancoras) janelas.push([fmt(a), fmt(new Date(a.getTime() + 86400000))]);
  janelas.push([dia(-1), dia(2)], [dia(-2), dia(4)]);
  const MAX_PAGINAS = 20;
  const vistos = new Set<string>();
  const examinados = new Set<string>();

  for (const [dIni, dFim] of janelas) {
    const porCep: any[] = [];
    const porValor: any[] = [];
    let offset = 0, total = Infinity;
    while (offset < total && out.paginas < MAX_PAGINAS) {
      const lista = await tinyFetch(tokenSVL, `/pedidos?dataInicial=${dIni}&dataFinal=${dFim}&limit=100&offset=${offset}`);
      out.paginas++;
      const itens = lista?.itens || [];
      total = lista?.paginacao?.total ?? itens.length;
      for (const p of itens) {
        const id = String(p.id);
        if (vistos.has(id)) continue;
        vistos.add(id);
        const cepMatch = !!alvoCep && digits(p.cliente?.endereco?.cep) === alvoCep;
        const valMatch = Math.round(Number(p.valor) * 100) === alvoValorC;
        if (cepMatch) porCep.push(p);
        else if (valMatch) porValor.push(p);
      }
      offset += 100;
      if (itens.length < 100) break;
      await sleep(300);
    }
    const candidatos = [...porCep, ...porValor];
    out.candidatos += candidatos.length;
    for (const c of candidatos) {
      if (examinados.size >= 12) break;
      if (examinados.has(String(c.id))) continue;
      examinados.add(String(c.id));
      out.examinados++;
      const det = await tinyFetch(tokenSVL, `/pedidos/${c.id}`);
      await sleep(200);
      if (String(det?.numeroOrdemCompra ?? "").trim() === alvoOrdem) {
        out.pedido = det;
        const idNota = det?.idNotaFiscal || null;
        if (idNota) out.nota_venda = await tinyFetch(tokenSVL, `/notas/${idNota}`);
        return out;
      }
    }
    if (out.paginas >= MAX_PAGINAS) break;
  }
  return out;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init, headers: { ...CORS, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
}

/** v3.20: itens da NF de venda (v3) no formato do payload. */
function itensDaVendaV3(venda: any): any[] {
  return (venda.itens || []).map((it: any) => ({
    codigo: fixEnc(it.codigo),
    descricao: fixEnc(it.descricao),
    ncm: digits(it.ncm ?? it.produto?.ncm ?? ""),
    unidade: fixEnc(it.unidade) || "UN",
    quantidade: String(it.quantidade ?? 1),
    valor_unitario: String(it.valorUnitario ?? 0),
  }));
}

/** v3.20: devolucao so do que foi reembolsado (SKU + qtd). SKU que nao esta
 *  na NF de venda = `faltando` (caso vai para revisao manual, nunca chuta). */
function recortarItens(fonte: any[], devolver: { sku: string; qtd: number }[]) {
  const norm = (x: unknown) => String(x ?? "").trim().toUpperCase();
  const pedido = new Map<string, number>();
  for (const d of devolver) pedido.set(norm(d.sku), (pedido.get(norm(d.sku)) || 0) + (Number(d.qtd) || 1));
  const faltando: string[] = [];
  const itens: any[] = [];
  for (const [sku, qtdDev] of pedido) {
    let resta = qtdDev;
    const doSku = fonte.filter((f) => norm(f.codigo) === sku);
    if (doSku.length === 0) { faltando.push(sku); continue; }
    for (const f of doSku) {
      if (resta <= 0) break;
      const q = Math.min(resta, Number(f.quantidade) || 0);
      if (q <= 0) continue;
      itens.push({ ...f, quantidade: String(q) });
      resta -= q;
    }
    if (resta > 0) faltando.push(`${sku} (reembolsado ${qtdDev}, na NF ${qtdDev - resta})`);
  }
  const totalFonte = fonte.reduce((a, f) => a + (Number(f.quantidade) || 0), 0);
  const totalDev = itens.reduce((a, f) => a + (Number(f.quantidade) || 0), 0);
  return { itens, parcial: totalDev < totalFonte, faltando };
}

/** v3.21: itens da devolucao Shopee traduzidos para o SKU do Tiny (kit aberto).
 *  completo=true quando o reembolso cobre o pedido inteiro (itens ou valor). */
async function traduzirItensDevolvidos(supabase: ReturnType<typeof createClient>, orderSn: string, ret: any, abrirKit = true) {
  const norm = (x: unknown) => String(x ?? "").trim().toUpperCase();
  const devolver = ((ret?.itens || []) as any[])
    .map((i) => ({ sku: String(i.sku ?? "").trim(), qtd: Number(i.qtd ?? 1) || 1 }))
    .filter((i) => i.sku);
  const { data: pi } = await supabase.from("pedido_itens").select("sku_pai, sku_filho, quantidade").eq("pedido_id", orderSn);
  const itensPed = ((pi || []) as any[]).map((x) => ({ pai: x.sku_pai, filho: x.sku_filho, qtd: Number(x.quantidade) || 1 }));
  const { data: ped } = await supabase.from("pedidos").select("subtotal_produtos").eq("id", orderSn).maybeSingle();
  const subtotal = Number(ped?.subtotal_produtos || 0);
  const reembolso = Number(ret?.refund_amount || 0);
  const acha = (sku: string) => itensPed.find((ip) => norm(ip.pai) === norm(sku) || norm(ip.filho) === norm(sku));
  const cobreItens = itensPed.length > 0 && itensPed.every((ip) => {
    const d = devolver.find((x) => norm(x.sku) === norm(ip.pai) || norm(x.sku) === norm(ip.filho));
    return !!d && d.qtd >= ip.qtd;
  });
  const cobreValor = subtotal > 0 && reembolso >= subtotal - 0.01;
  if (cobreItens || cobreValor || devolver.length === 0) {
    return { completo: true, motivo: cobreItens ? "itens" : cobreValor ? "valor" : "sem_itens_na_devolucao", itens: null as null | { sku: string; qtd: number }[] };
  }
  const itens: { sku: string; qtd: number }[] = [];
  for (const d of devolver) {
    const ip = acha(d.sku);
    const skuTiny = String(ip?.filho || ip?.pai || d.sku).trim();
    const { data: kit } = abrirKit ? await supabase.from("produto_kits").select("sku_componente, quantidade").eq("sku_kit", skuTiny) : { data: [] as any[] };
    if ((kit || []).length) for (const k of kit as any[]) itens.push({ sku: String(k.sku_componente), qtd: d.qtd * (Number(k.quantidade) || 1) });
    else itens.push({ sku: skuTiny, qtd: d.qtd });
  }
  return { completo: false, motivo: "parcial", itens };
}

/** v3.20: devolucao ja existente para a NF de venda (qualquer origem). */
async function devolucaoExistente(supabase: ReturnType<typeof createClient>, conta: string, chave: string) {
  const { data: nc } = await supabase.from("notas_cancelados")
    .select("id_nota_devolucao").eq("chave_nfe", chave).not("id_nota_devolucao", "is", null).limit(1);
  if ((nc || []).length) return { onde: "notas_cancelados", id_nota: nc![0].id_nota_devolucao, numero: null, situacao: null };
  if (conta === "svl") {
    const { data: b } = await supabase.from("devolucoes_svl_base")
      .select("id_nota, numero, situacao").eq("chave_referenciada", chave).order("id_nota", { ascending: false }).limit(1);
    if ((b || []).length) return { onde: "devolucoes_svl", id_nota: b![0].id_nota, numero: b![0].numero, situacao: b![0].situacao };
  }
  const { data: a } = await supabase.from("devolucao_auto")
    .select("id_nota_devolucao, numero_nota").eq("conta", conta).eq("chave_venda", chave).not("id_nota_devolucao", "is", null).limit(1);
  if ((a || []).length) return { onde: "devolucao_auto", id_nota: a![0].id_nota_devolucao, numero: a![0].numero_nota, situacao: null };
  if (conta === "ottz") {
    // v3.27: devolucao ja emitida pela ACZ (inclusive a mao no Tiny) que referencia a venda — espelho fiscal noturno
    const { data: f } = await supabase.from("fiscal_nfe").select("tiny_id, numero, serie")
      .eq("fin_nfe", "4").eq("emit_doc", CNPJ_ACZ).contains("ref_nfe", [chave]).or("cancelada.is.null,cancelada.eq.false").limit(1);
    if ((f || []).length) return { onde: "fiscal_nfe", id_nota: f![0].tiny_id, numero: f![0].numero, situacao: null };
  }
  return null;
}

function montarPayloadDevolucao(venda: any, serie: string, chave: string, itensOverride?: any[]) {
  const cli = venda.cliente || {};
  const end = cli.endereco || {};
  const isoHoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const [ay, am, ad] = isoHoje.split("-");
  const dataEmissao = `${ad}/${am}/${ay}`;
  let itensSemNcm = 0;
  const fonte = itensOverride ?? (venda.itens || []).map((it: any) => ({
    codigo: fixEnc(it.codigo),
    descricao: fixEnc(it.descricao),
    ncm: digits(it.ncm ?? it.produto?.ncm ?? ""),
    unidade: fixEnc(it.unidade) || "UN",
    quantidade: String(it.quantidade ?? 1),
    valor_unitario: String(it.valorUnitario ?? 0),
  }));
  const itens = fonte.map((f: any) => {
    if (!f.ncm) itensSemNcm++;
    const item: Record<string, string> = {
      codigo: f.codigo || "",
      descricao: f.descricao,
      unidade: f.unidade || "UN",
      quantidade: String(f.quantidade),
      valor_unitario: String(f.valor_unitario),
    };
    if (f.ncm) item.ncm = f.ncm;
    return { item };
  });
  return {
    payload: {
      nota_fiscal: {
        tipo: "E",
        natureza_operacao: "Devolução de Mercadorias",
        finalidade: "4",
        serie,
        data_emissao: dataEmissao,
        refNFe: chave,
        frete_por_conta: "S",
        cliente: {
          nome: fixEnc(cli.nome),
          tipo_pessoa: cli.tipoPessoa || "F",
          cpf_cnpj: cli.cpfCnpj || "",
          endereco: fixEnc(end.endereco),
          numero: fixEnc(end.numero),
          complemento: fixEnc(end.complemento),
          bairro: fixEnc(end.bairro),
          cep: end.cep || "",
          cidade: fixEnc(end.municipio),
          uf: end.uf || "",
        },
        itens,
      },
    },
    nItens: itens.length,
    itensSemNcm,
  };
}

async function emitirNota(accessToken: string, idNota: number): Promise<any> {
  const ehAut = (s: string | null) => s === "6" || s === "7" || s === "2";
  const eh656 = (r: any): boolean => {
    const xml = typeof r?.xml === "string" ? r.xml : "";
    const s = (xml + " " + JSON.stringify(r?.mensagem ?? "") + " " + JSON.stringify(r?.erros ?? "")).toLowerCase();
    return s.includes("consumo indevido") || (/656/.test(s) && /rejei|cstat|consumo/.test(s));
  };
  let res = await tinyFetch(accessToken, `/notas/${idNota}/emitir`, { method: "POST", body: JSON.stringify({ enviarEmail: false }) });
  let situacao = res?.situacao != null ? String(res.situacao) : null;
  const consumo = eh656(res);
  let autorizada = ehAut(situacao);
  if (!autorizada && !consumo) {
    await sleep(3000);
    const rec = await tinyFetch(accessToken, `/notas/${idNota}`);
    const sr = rec?.situacao != null ? String(rec.situacao) : null;
    if (ehAut(sr)) { autorizada = true; situacao = sr; res = rec; }
  }
  return { autorizada, situacao, consumo, chave: res?.chaveAcesso || null };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Secrets Supabase ausentes", { status: 500, headers: CORS });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const url = new URL(req.url);
  let body: any = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const param = (k: string): string | null => url.searchParams.get(k) ?? (body?.[k] != null ? String(body[k]) : null);
  const modulo = param("modulo") || "varrer-cancelados";
  const conta = (param("conta") || "ottz").toLowerCase().trim();
  if (conta !== "ottz" && conta !== "svl") return json({ erro: `conta invalida: ${conta} (use ottz ou svl)` }, { status: 400 });

  let accessToken: string;
  let accessTokenPrincipal: string;
  try {
    accessTokenPrincipal = await pegarToken(supabase, "ottz");
    accessToken = conta === "ottz" ? accessTokenPrincipal : await pegarToken(supabase, conta);
  } catch (err) {
    return new Response((err as Error).message, { status: 401, headers: CORS });
  }
  const v2Token = v2TokenDe(conta);

  if (modulo === "nota-crua") {
    const idNota = parseInt(param("id_nota") || "0", 10);
    if (!idNota) return json({ erro: "informe id_nota" }, { status: 400 });
    const det = await tinyFetch(accessToken, `/notas/${idNota}`);
    if (!det) return json({ erro: `nota ${idNota} nao encontrada` }, { status: 404 });
    return json({ modulo, conta, id_nota: idNota, nota: det,
      itens_resumo: (det.itens || []).map((it: any) => ({ codigo: it.codigo, descricao: fixEnc(it.descricao)?.slice(0, 40), ncm: it.ncm ?? it.produto?.ncm ?? null, quantidade: it.quantidade, valorUnitario: it.valorUnitario })) });
  }

  if (modulo === "procurar-nota") {
    if (!v2Token) return json({ erro: `secret v2 ausente p/ conta ${conta}` }, { status: 500 });
    const numero = (param("numero") || "").trim();
    if (!numero) return json({ erro: "informe numero" }, { status: 400 });
    const r = await tinyV2("notas.fiscais.pesquisa.php", { numero }, v2Token);
    const ret = r?.retorno || {};
    const notas = (ret?.notas_fiscais || []).map((n: any) => n?.nota_fiscal || n).map((n: any) => ({
      id: n.id, numero: n.numero, serie: n.serie, tipo: n.tipo, situacao: n.situacao,
      data_emissao: n.data_emissao, cliente: fixEnc(n.nome || n.cliente?.nome), valor: n.valor,
    }));
    return json({ modulo, conta, numero, status: ret?.status || null, codigo_erro: ret?.codigo_erro || null,
      erros: ret?.erros || null, notas,
      legenda_situacao: "v2: 1 Pendente / 2 Emitida / 3 Cancelada / 4 Enviada aguard. recibo / 5 Rejeitada / 6 Autorizada / 7 Emitida DANFE / 8 Registrada / 9 Enviada aguard. protocolo / 10 Denegada" });
  }

  if (modulo === "itens-venda") {
    if (!v2Token) return json({ erro: `secret v2 ausente p/ conta ${conta}` }, { status: 500 });
    const chave = digits(param("chave") || "");
    if (chave.length !== 44) return json({ erro: "informe chave de 44 digitos" }, { status: 400 });
    const r = await itensDaVendaPorChave(v2Token, chave);
    const aut = await vendaAutorizadaPelaChave(v2Token, chave);
    return json({ modulo, conta, chave, venda_autorizada: aut, ...r });
  }

  if (modulo === "svl-nota") {
    const contaSVL = conta === "svl" ? accessToken : await pegarToken(supabase, "svl").catch(() => null as any);
    if (!contaSVL) return json({ erro: "token svl ausente" }, { status: 401 });
    const tinyPedidoId = parseInt(param("tiny_pedido_id") || "0", 10);
    let alvo: any;
    let situacaoPrincipal: any = null;
    if (tinyPedidoId) {
      const ped = await tinyFetch(accessTokenPrincipal, `/pedidos/${tinyPedidoId}`);
      if (!ped) return json({ erro: `pedido principal ${tinyPedidoId} nao encontrado` }, { status: 404 });
      situacaoPrincipal = ped.situacao;
      alvo = {
        ordem: ped.numeroOrdemCompra || ped.ecommerce?.numeroPedidoEcommerce || "",
        valor: ped.valorTotalPedido, cep: ped.cliente?.endereco?.cep || "", data: ped.data,
      };
    } else {
      alvo = { ordem: param("numero_ecommerce") || "", valor: Number(param("valor") || 0), cep: param("cep") || "", data: param("data") || "" };
    }
    if (!alvo.ordem || !alvo.data) return json({ erro: "informe tiny_pedido_id OU numero_ecommerce+valor+cep+data", alvo }, { status: 400 });
    const r = await acharVendaSVL(contaSVL, alvo);
    return json({
      modulo: "svl-nota", conta: "svl", alvo, situacao_principal: situacaoPrincipal,
      encontrado: !!r.pedido, paginas: r.paginas, candidatos: r.candidatos, examinados: r.examinados,
      pedido: r.pedido ? { id: r.pedido.id, numeroPedido: r.pedido.numeroPedido, situacao: r.pedido.situacao, idNotaFiscal: r.pedido.idNotaFiscal, numeroOrdemCompra: r.pedido.numeroOrdemCompra } : null,
      nota_venda: r.nota_venda ? { id: r.nota_venda.id, numero: r.nota_venda.numero, serie: r.nota_venda.serie, tipo: r.nota_venda.tipo, situacao: r.nota_venda.situacao, chaveAcesso: r.nota_venda.chaveAcesso, valor: r.nota_venda.valor, cliente: fixEnc(r.nota_venda.cliente?.nome), itens: (r.nota_venda.itens || []).length } : null,
    });
  }

  if (modulo === "v2-teste") {
    if (!v2Token) return json({ ok: false, erro: `secret do token v2 nao configurado para conta ${conta}` }, { status: 500 });
    const servico = param("servico") || "nota.fiscal.obter.php";
    const idNota = param("id_nota") || "820170721";
    const form = new URLSearchParams({ token: v2Token, formato: "json", id: idNota });
    const resp = await fetch(`${TINY_V2_HOST}/${servico}`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    const xLimit = resp.headers.get("x-limit-api");
    const txt = await resp.text();
    let r: any; try { r = JSON.parse(txt); } catch { r = { _raw: txt.substring(0, 300) }; }
    const ret = r?.retorno || {};
    const nf = ret?.nota_fiscal || null;
    return json({
      modulo: "v2-teste", conta, servico, x_limit_api: xLimit, ok: ret?.status === "OK",
      status: ret?.status || null, codigo_erro: ret?.codigo_erro || null, erros: ret?.erros || null,
      nota: nf ? { id: nf.id, numero: nf.numero, serie: nf.serie, tipo: nf.tipo, situacao: nf.situacao, natureza_operacao: nf.natureza_operacao, cliente: nf.cliente?.nome } : null,
      raw_keys: nf ? Object.keys(nf) : null,
      corpo_preview: txt.substring(0, 200),
      ref_scan: nf ? ((JSON.stringify(nf).match(/[0-9]{44}/g)) || []) : null,
    });
  }

  if (modulo === "clonar") {
    if (!v2Token) return json({ erro: `secret v2 ausente p/ conta ${conta}` }, { status: 500 });
    const idNota = parseInt(param("id_nota") || "0", 10);
    const confirmar = param("confirmar") === "1";
    const serieParam = param("serie");
    if (!idNota) return json({ erro: "informe id_nota" }, { status: 400 });

    const det = await tinyFetch(accessToken, `/notas/${idNota}`);
    if (!det) return json({ erro: `nota ${idNota} nao encontrada` }, { status: 404 });
    if (det.tipo !== "E") return json({ erro: `nota ${idNota} nao e de entrada (tipo=${det.tipo}) - clonar so devolucao` }, { status: 400 });
    const sit = String(det.situacao);
    if (sit !== "1" && sit !== "5") return json({ erro: `nota ${idNota} nao esta Pendente nem Rejeitada (situacao=${sit}) - so clono rascunho/rejeitada` }, { status: 400 });

    let refnfe: string | null = null;
    let refonte = "";
    let v2keys: any = null;
    const { data: nc } = await supabase.from("notas_cancelados").select("chave_nfe").eq("id_nota_devolucao", idNota).not("chave_nfe", "is", null).limit(1);
    if (nc?.[0]?.chave_nfe && digits(nc[0].chave_nfe).length === 44) { refnfe = digits(nc[0].chave_nfe); refonte = "banco"; }
    if (!refnfe) {
      const { data: dc } = await supabase.from("devolucao_clonadas").select("refnfe").or(`id_orfao.eq.${idNota},id_novo.eq.${idNota}`).not("refnfe", "is", null).limit(1);
      if (dc?.[0]?.refnfe && digits(dc[0].refnfe).length === 44) { refnfe = digits(dc[0].refnfe); refonte = "devolucao_clonadas"; }
    }
    if (!refnfe) {
      const r2 = await tinyV2("nota.fiscal.obter.php", { id: String(idNota) }, v2Token);
      const nf2 = r2?.retorno?.nota_fiscal || null;
      v2keys = nf2 ? Object.keys(nf2) : (r2?.retorno?.erros || r2?.retorno || null);
      if (nf2) {
        const propria = digits(det.chaveAcesso || "");
        const todas = ((JSON.stringify(nf2).match(/[0-9]{44}/g)) || []).filter((c: string) => c !== propria);
        const distintas = [...new Set(todas)];
        if (distintas.length === 1) { refnfe = distintas[0]; refonte = "v2_obter"; }
        else if (distintas.length > 1) {
          return json({ modulo: "clonar", conta, id_nota: idNota, ok: false, ambiguo: true, chaves_44: distintas,
            erro: "v2 obter trouxe mais de uma chave de 44 digitos - ambiguo, nao clono. Corrija pela UI." }, { status: 422 });
        }
      }
    }

    const serie = serieParam || det.serie || serieDevolucaoDe(conta);

    if (!refnfe) {
      return json({ modulo: "clonar", conta, id_nota: idNota, ok: false, sem_refnfe: true,
        numero: det.numero, serie_atual: det.serie, data_atual: det.dataEmissao, v2_campos: v2keys,
        erro: "Nao recuperei o refNFe (chave da NF de venda referenciada). NAO clono sem o vinculo fiscal - corrija pela UI do Tiny." }, { status: 422 });
    }

    // v3.19: venda referenciada precisa estar AUTORIZADA na SEFAZ
    const vendaAut = await vendaAutorizadaPelaChave(v2Token, refnfe);
    if (vendaAut === false) {
      return json({ modulo: "clonar", conta, id_nota: idNota, ok: false, venda_nao_autorizada: true, refnfe,
        erro: "A NF de VENDA referenciada NUNCA FOI AUTORIZADA (esta Pendente/Rejeitada no Tiny). Devolucao nao se aplica - a SEFAZ rejeitaria o refNFe. Trate a NF de venda (emitir ou excluir o rascunho) na UI do Tiny." }, { status: 422 });
    }

    let feito = montarPayloadDevolucao(det, serie, refnfe);
    let origemItens = "rascunho";
    let avisoVenda: string | null = null;
    if (feito.itensSemNcm > 0 || feito.nItens === 0) {
      const vx = await itensDaVendaPorChave(v2Token, refnfe);
      if (vx.itens.length > 0 && vx.itens.every((i: any) => i.ncm)) {
        feito = montarPayloadDevolucao(det, serie, refnfe, vx.itens);
        origemItens = `xml_venda(${vx.fonte_id})`;
      } else if (vx.erro) avisoVenda = vx.erro;
    }
    const { payload, nItens, itensSemNcm } = feito;
    if (nItens === 0) return json({ erro: `rascunho ${idNota} sem itens` }, { status: 400 });

    if (!confirmar) {
      return json({ modulo: "clonar", conta, id_nota: idNota, dry: true, recriar_sem_excluir: true,
        situacao_atual: sit, numero_atual: det.numero, serie_atual: det.serie, data_atual: det.dataEmissao,
        refnfe, refnfe_fonte: refonte, venda_autorizada: vendaAut, origem_itens: origemItens, aviso_venda: avisoVenda,
        nova_data_emissao: payload.nota_fiscal.data_emissao, n_itens: nItens, itens_sem_ncm: itensSemNcm, payload,
        aviso: "repita com confirmar=1 para RECRIAR com a data de hoje. O rascunho ANTIGO nao e apagado (a API nao exclui) - vira orfao, apague na UI por data. Emissao continua separada no modulo emitir." });
    }

    if (itensSemNcm > 0) {
      return json({ modulo: "clonar", conta, id_nota: idNota, ok: false, itens_sem_ncm: itensSemNcm, aviso_venda: avisoVenda,
        erro: "item sem NCM mesmo apos buscar o XML da venda - a SEFAZ vai rejeitar. Preencha o NCM no cadastro/rascunho ou verifique a NF de venda." }, { status: 422 });
    }

    const r = await tinyV2("nota.fiscal.incluir.php", { nota: JSON.stringify(payload) }, v2Token);
    const ret = r?.retorno || {};
    const reg = ret?.registros?.registro || ret?.registros || null;
    const ok = ret?.status === "OK";

    if (!ok && v2Bloqueada(ret)) {
      return json({ modulo: "clonar", conta, id_nota_orfao: idNota, ok: false, bloqueada: true,
        erro: "A v2 esta bloqueada (cod 6). Nada foi recriado. Tente de novo em 1-2 min.", payload, refnfe }, { status: 429 });
    }

    if (ok && reg?.id && refnfe) {
      await supabase.from("notas_cancelados").update({ id_nota_devolucao: reg.id, devolucao_emitida: false }).eq("chave_nfe", refnfe);
      await supabase.from("devolucao_clonadas").upsert({ id_orfao: idNota, id_novo: reg.id, numero_antigo: det.numero, numero_novo: reg.numero, conta, refnfe }, { onConflict: "id_orfao" });
    }
    return json({ modulo: "clonar", conta, id_nota_orfao: idNota, ok, recriar_sem_excluir: true,
      novo_id: reg?.id || null, novo_numero: reg?.numero || null, nova_serie: reg?.serie || null,
      numero_antigo: det.numero, data_antiga: det.dataEmissao, nova_data: payload.nota_fiscal.data_emissao,
      refnfe, refnfe_fonte: refonte, origem_itens: origemItens, status: ret?.status || null, erros: ret?.erros || reg?.erros || null,
      aviso: ok ? "Rascunho ANTIGO (orfao) NAO foi apagado - a API nao exclui. Apague na UI por data. Emita o NOVO id." : null,
      proximo_passo: ok ? `nf-devolucao?modulo=emitir&conta=${conta}&id_nota=${reg?.id}&confirmar=1` : null });
  }

  if (modulo === "clonar-lote") {
    if (!v2Token) return json({ erro: `secret v2 ausente p/ conta ${conta}` }, { status: 500 });
    const inicio = Date.now();
    const TIMEOUT_MS = 24000;
    const emitirFlag = param("emitir") !== "0";
    const hojeISO = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const ate = param("ate") || (hojeISO.slice(0, 8) + "01");
    const maxN = Math.min(parseInt(param("max") || "8", 10), 20);

    const ehAut = (s: string | null) => s === "6" || s === "7" || s === "2";
    const recriados: any[] = [];
    const emitidos: any[] = [];
    const erros: any[] = [];
    const manuais: any[] = [];
    let bloqueado656 = false;
    let ops = 0;

    // aposenta o caso no motor (id_novo=null): tratamento manual na UI
    const aposentar = async (idOrfao: number, numero: string | null, motivo: string) => {
      await supabase.from("devolucao_clonadas").upsert({ id_orfao: idOrfao, id_novo: null, numero_antigo: numero, conta }, { onConflict: "id_orfao" });
      manuais.push({ id_orfao: idOrfao, numero, motivo });
    };

    const recriarUm = async (idOrfao: number, det: any, refnfe: string): Promise<{ id: number; numero: string } | null> => {
      // v3.19: guard — venda referenciada precisa existir na SEFAZ
      const vendaAut = await vendaAutorizadaPelaChave(v2Token, refnfe);
      if (vendaAut === false) {
        await aposentar(idOrfao, det?.numero ?? null, "NF de venda referenciada NAO autorizada - excluir/emitir a venda na UI");
        return null;
      }
      const serie = det.serie || serieDevolucaoDe(conta);
      let feito = montarPayloadDevolucao(det, serie, refnfe);
      if (feito.itensSemNcm > 0 || feito.nItens === 0) {
        const vx = await itensDaVendaPorChave(v2Token, refnfe);
        if (vx.itens.length > 0 && vx.itens.every((i: any) => i.ncm)) feito = montarPayloadDevolucao(det, serie, refnfe, vx.itens);
      }
      if (feito.nItens === 0) { erros.push({ id: idOrfao, e: "sem itens" }); return null; }
      if (feito.itensSemNcm > 0) {
        await aposentar(idOrfao, det?.numero ?? null, "sem NCM (nem no XML da venda) - preencher NCM/cadastro na UI");
        return null;
      }
      const r = await tinyV2("nota.fiscal.incluir.php", { nota: JSON.stringify(feito.payload) }, v2Token);
      const ret = r?.retorno || {}; const reg = ret?.registros?.registro || ret?.registros || null;
      if (ret?.status !== "OK" || !reg?.id) {
        if (v2Bloqueada(ret)) erros.push({ id: idOrfao, e: "v2 cod6" });
        else erros.push({ id: idOrfao, e: "incluir falhou" });
        return null;
      }
      await supabase.from("devolucao_clonadas").upsert({ id_orfao: idOrfao, id_novo: reg.id, numero_antigo: det.numero, numero_novo: reg.numero, conta, refnfe }, { onConflict: "id_orfao" });
      await supabase.from("notas_cancelados").update({ id_nota_devolucao: reg.id, devolucao_emitida: false }).eq("chave_nfe", refnfe);
      return { id: Number(reg.id), numero: String(reg.numero) };
    };

    if (emitirFlag) {
      const { data: pend } = await supabase.from("devolucao_clonadas")
        .select("id_orfao, id_novo, numero_novo, refnfe").eq("conta", conta).is("emitido_em", null).not("id_novo", "is", null).limit(40);
      for (const p of (pend || [])) {
        if (ops >= maxN || Date.now() - inicio > TIMEOUT_MS) break;
        const det = await tinyFetch(accessToken, `/notas/${p.id_novo}`);
        if (!det) { erros.push({ id: p.id_novo, e: "novo sumiu" }); continue; }
        if (ehAut(String(det.situacao))) { await supabase.from("devolucao_clonadas").update({ emitido_em: new Date().toISOString() }).eq("id_orfao", p.id_orfao); continue; }
        if (String(det.situacao) !== "1" && String(det.situacao) !== "5") { erros.push({ id: p.id_novo, e: `sit ${det.situacao}` }); continue; }
        ops++;
        const alvoId = Number(p.id_novo);
        const alvoNumero = p.numero_novo;
        if (String(det.situacao) === "1") {
          const e = await emitirNota(accessToken, alvoId);
          if (e.consumo) { bloqueado656 = true; break; }
          if (e.autorizada) { await supabase.from("devolucao_clonadas").update({ emitido_em: new Date().toISOString() }).eq("id_orfao", p.id_orfao); emitidos.push({ id: alvoId, numero: alvoNumero, chave: e.chave }); await sleep(1200); continue; }
        }
        if (!p.refnfe || digits(p.refnfe).length !== 44) { await aposentar(Number(p.id_orfao), alvoNumero, "nao autorizou e sem refnfe"); continue; }
        await sleep(700);
        const novo = await recriarUm(Number(p.id_orfao), det, digits(p.refnfe));
        if (!novo) continue;
        recriados.push({ orfao: p.id_orfao, novo_id: novo.id, novo_numero: novo.numero, reclone: true });
        await sleep(700);
        const e2 = await emitirNota(accessToken, novo.id);
        if (e2.consumo) { bloqueado656 = true; break; }
        if (e2.autorizada) { await supabase.from("devolucao_clonadas").update({ emitido_em: new Date().toISOString() }).eq("id_orfao", p.id_orfao); emitidos.push({ id: novo.id, numero: novo.numero, chave: e2.chave }); }
        else { await aposentar(Number(p.id_orfao), novo.numero, "reclone rejeitado pela SEFAZ - investigar na UI"); }
        await sleep(1200);
      }
    }

    if (!bloqueado656) {
      const stale: any[] = [];
      for (const sitEnum of ["1", "5"]) {
        let offset = 0;
        for (let pg = 0; pg < 8; pg++) {
          if (Date.now() - inicio > 12000) break;
          const lista = await tinyFetch(accessToken, `/notas?situacao=${sitEnum}&dataInicial=2026-01-01&limit=100&offset=${offset}`);
          const itens = lista?.itens || [];
          for (const n of itens) {
            if (n?.tipo !== "E" || !n?.dataEmissao) continue;
            if (sitEnum === "1" && String(n.dataEmissao) >= ate) continue;
            stale.push({ id: n.id, numero: n.numero, sit: sitEnum });
          }
          if (itens.length < 100) break;
          offset += 100; await sleep(200);
        }
      }
      const ids = stale.map((s) => s.id);
      const ja = new Set<number>();
      for (let i = 0; i < ids.length; i += 300) { const { data } = await supabase.from("devolucao_clonadas").select("id_orfao").in("id_orfao", ids.slice(i, i + 300)); for (const r of (data || [])) ja.add(Number(r.id_orfao)); }
      const fila = stale.filter((s) => !ja.has(Number(s.id)));

      for (const s of fila) {
        if (ops >= maxN || Date.now() - inicio > TIMEOUT_MS) break;
        try {
          const det = await tinyFetch(accessToken, `/notas/${s.id}`);
          const sitDet = det ? String(det.situacao) : "";
          if (!det || det.tipo !== "E" || (sitDet !== "1" && sitDet !== "5")) { erros.push({ id: s.id, e: "nao pend/rej E" }); continue; }
          let refnfe: string | null = null;
          const { data: nc } = await supabase.from("notas_cancelados").select("chave_nfe").eq("id_nota_devolucao", s.id).not("chave_nfe", "is", null).limit(1);
          if (nc?.[0]?.chave_nfe && digits(nc[0].chave_nfe).length === 44) refnfe = digits(nc[0].chave_nfe);
          if (!refnfe) {
            const r2 = await tinyV2("nota.fiscal.obter.php", { id: String(s.id) }, v2Token);
            const nf2 = r2?.retorno?.nota_fiscal || null;
            if (nf2) { const pr = digits(det.chaveAcesso || ""); const t = [...new Set(((JSON.stringify(nf2).match(/[0-9]{44}/g)) || []).filter((c: string) => c !== pr))]; if (t.length === 1) refnfe = t[0] as string; else if (t.length > 1) { erros.push({ id: s.id, e: "ambiguo" }); continue; } }
          }
          if (!refnfe) { erros.push({ id: s.id, numero: s.numero, e: "sem refnfe" }); continue; }
          ops++;
          const novo = await recriarUm(Number(s.id), det, refnfe);
          if (!novo) continue;
          recriados.push({ orfao: s.id, novo_id: novo.id, novo_numero: novo.numero, de_sit: s.sit });
          await sleep(700);
          if (emitirFlag) {
            const e = await emitirNota(accessToken, novo.id);
            if (e.consumo) { bloqueado656 = true; break; }
            if (e.autorizada) { await supabase.from("devolucao_clonadas").update({ emitido_em: new Date().toISOString() }).eq("id_orfao", s.id); emitidos.push({ id: novo.id, numero: novo.numero, chave: e.chave }); }
            else erros.push({ id: novo.id, e: "nao autorizou" });
            await sleep(1200);
          }
        } catch (ex) { const m = (ex as Error).message; erros.push({ id: s.id, e: m.substring(0, 60) }); if (m.includes("429")) break; }
      }
    }

    return json({ modulo: "clonar-lote", conta, ate, emitir: emitirFlag, recriados: recriados.length, emitidos: emitidos.length,
      bloqueado_656: bloqueado656, ops, erros: erros.slice(0, 12), casos_manuais: manuais.slice(0, 12), amostra: emitidos.slice(0, 6), recriados_detalhe: recriados.slice(0, 6), tempo_ms: Date.now() - inicio,
      aviso: bloqueado656 ? "PAROU no 656 (Consumo Indevido). Aguarde ~1h e rode de novo - retoma de onde parou." : (ops >= maxN ? "atingiu max desta rodada - rode de novo p/ continuar" : "rodada concluida (pode nao haver mais vencidos)") });
  }

  if (modulo === "criar") {
    if (!v2Token) return json({ erro: `secret do token v2 nao configurado para conta ${conta}` }, { status: 500 });
    const confirmar = param("confirmar") === "1";
    const serie = param("serie") || serieDevolucaoDe(conta);

    let venda: any = null;
    let chave: string | null = null;
    let idNotaVenda: number | null = null;
    let chaveParaVinculo: string | null = null;
    let bridge: any = null;
    let guard = "cancelado";
    let devolverItens: { sku: string; qtd: number }[] | null = null;

    const pedidoDireto = parseInt(param("pedido_id") || param("pedido_svl_id") || "0", 10);
    if (!param("tiny_pedido_id") && (param("id_nota_venda") || (conta === "ottz" && pedidoDireto > 0)) && (conta === "svl" || pedidoDireto > 0)) {
      // v3.24/v3.25: venda emitida NA PROPRIA conta (SVL sem pedido no principal; Ottz historico). Guard: o pedido
      // de origem esta cancelado AO VIVO nessa conta e a nota informada e a nota dele (nunca confiar so no espelho).
      let idNotaSvl = parseInt(param("id_nota_venda") || "0", 10);
      const pedSvlId = pedidoDireto;
      if (!pedSvlId || (!idNotaSvl && conta !== "ottz")) return json({ erro: `conta ${conta} sem ponte: informe id_nota_venda E pedido_id (pedido de origem no Tiny da conta)` }, { status: 400 });
      const pedSvl = await tinyFetch(accessToken, `/pedidos/${pedSvlId}`);
      if (!pedSvl) return json({ modulo: "criar", conta, ok: false, codigo: "sem_pedido_svl", erro: `pedido ${pedSvlId} nao encontrado no Tiny ${conta}` }, { status: 404 });
      let reembolsoOttz = false;
      if (String(pedSvl.situacao) !== "2") {
        // v3.27: na Ottz, pedido entregue com reembolso ACEITO na Shopee (loja Ottz) tambem gera devolucao
        const ordemPed = String(pedSvl.ecommerce?.numeroPedidoEcommerce || pedSvl.numeroOrdemCompra || "").trim();
        const { data: ret } = conta === "ottz" && ordemPed
          ? await supabase.from("shopee_devolucoes").select("return_sn, itens, solucao, refund_amount")
              .eq("order_sn", ordemPed).eq("shop_id", SHOP_SHOPEE_OTTZ).eq("status", "ACCEPTED").order("create_time", { ascending: false }).limit(1)
          : { data: [] as any[] };
        if (!(ret || []).length) {
          return json({ modulo: "criar", conta, ok: false, codigo: "nao_cancelado", nao_cancelado: true, situacao_pedido: pedSvl.situacao,
            erro: `O pedido ${pedSvl.numeroPedido} NAO esta cancelado no Tiny ${conta} (situacao ${pedSvl.situacao}) e nao tem reembolso aceito. Nao gero devolucao para pedido ativo.` });
        }
        const tr = await traduzirItensDevolvidos(supabase, ordemPed, ret![0], false);
        devolverItens = tr.itens;
        reembolsoOttz = true;
        guard = `reembolso_aceito(${ret![0].return_sn}, ${tr.motivo})`;
      }
      const notaDoPedido = pedSvl.idNotaFiscal ?? pedSvl.notaFiscal?.id ?? null;
      if (!idNotaSvl) {
        if (notaDoPedido == null || !Number(notaDoPedido)) return json({ modulo: "criar", conta, ok: false, codigo: "sem_nf_venda", erro: `pedido ${pedSvl.numeroPedido} sem NF de venda vinculada no Tiny ${conta}` }, { status: 404 });
        idNotaSvl = Number(notaDoPedido);
      }
      if (notaDoPedido != null && Number(notaDoPedido) !== idNotaSvl) {
        return json({ modulo: "criar", conta, ok: false, codigo: "nota_nao_do_pedido", situacao_pedido: pedSvl.situacao,
          erro: `A NF ${idNotaSvl} nao e a nota vinculada ao pedido ${pedSvl.numeroPedido} no Tiny ${conta} (idNotaFiscal ${notaDoPedido}).` }, { status: 422 });
      }
      venda = await tinyFetch(accessToken, `/notas/${idNotaSvl}`);
      if (!venda) return json({ codigo: "sem_nf_venda", erro: `nota de venda ${idNotaSvl} nao encontrada no Tiny ${conta}` }, { status: 404 });
      idNotaVenda = idNotaSvl;
      if (!reembolsoOttz) guard = `cancelado_${conta}`;
      bridge = { direto: true, pedido_svl: pedSvlId, nota_do_pedido: notaDoPedido };
    } else if (conta === "svl") {
      const tinyPedidoId = parseInt(param("tiny_pedido_id") || "0", 10);
      if (!tinyPedidoId) return json({ erro: "conta svl: informe tiny_pedido_id (id do pedido no Tiny principal) OU id_nota_venda+pedido_svl_id" }, { status: 400 });
      const ped = await tinyFetch(accessTokenPrincipal, `/pedidos/${tinyPedidoId}`);
      if (!ped) return json({ codigo: "sem_pedido_principal", erro: `pedido principal ${tinyPedidoId} nao encontrado` }, { status: 404 });
      const ordemPed = String(ped.numeroOrdemCompra || ped.ecommerce?.numeroPedidoEcommerce || "").trim();
      if (String(ped.situacao) !== "2") {
        // v3.20: pedido entregue com reembolso ACEITO na Shopee tambem gera devolucao
        const { data: ret } = ordemPed
          ? await supabase.from("shopee_devolucoes").select("return_sn, itens, solucao, refund_amount")
              .eq("order_sn", ordemPed).eq("status", "ACCEPTED").order("create_time", { ascending: false }).limit(1)
          : { data: [] as any[] };
        if (!(ret || []).length) {
          return json({ modulo: "criar", conta, ok: false, codigo: "nao_cancelado", nao_cancelado: true, situacao_pedido: ped.situacao,
            erro: `O pedido ${ped.numeroPedido} NAO esta cancelado (situacao ${ped.situacao} no principal) e nao tem reembolso aceito. Nao gero devolucao para pedido ativo.` });
        }
        const tr = await traduzirItensDevolvidos(supabase, ordemPed, ret![0]);
        guard = `reembolso_aceito(${ret![0].return_sn}, ${tr.motivo})`;
        devolverItens = tr.itens;
      }
      const alvo = { ordem: ordemPed, valor: ped.valorTotalPedido, cep: ped.cliente?.endereco?.cep || "", data: ped.data };
      if (!alvo.ordem) return json({ codigo: "sem_ordem", erro: `pedido ${tinyPedidoId} sem numero do marketplace (numeroOrdemCompra)` }, { status: 400 });
      const r = await acharVendaSVL(accessToken, alvo);
      bridge = { ordem: alvo.ordem, candidatos: r.candidatos, examinados: r.examinados, paginas: r.paginas, pedido_svl: r.pedido?.id || null };
      if (!r.pedido) return json({ modulo: "criar", conta, ok: false, codigo: "sem_pedido_svl", erro: `nao encontrei o pedido no Tiny SVL para a ordem ${alvo.ordem} (janela de data/CEP). Verifique se ja foi faturado na SVL.`, bridge });
      if (!r.nota_venda) return json({ modulo: "criar", conta, ok: false, codigo: "sem_nf_venda", erro: `pedido ${r.pedido.numeroPedido} na SVL nao tem NF de venda vinculada (idNotaFiscal vazio).`, bridge });
      venda = r.nota_venda;
    } else {
      idNotaVenda = parseInt(param("id_nota_venda") || "0", 10);
      if (!idNotaVenda) return json({ erro: "informe id_nota_venda (id da NF de VENDA no Tiny)" }, { status: 400 });
      venda = await tinyFetch(accessToken, `/notas/${idNotaVenda}`);
      if (!venda) return json({ erro: `nota de venda ${idNotaVenda} nao encontrada` }, { status: 404 });
    }

    if (venda.tipo !== "S") return json({ erro: `nota de venda nao e de saida (tipo=${venda.tipo})` }, { status: 400 });
    // v3.19: venda precisa estar AUTORIZADA (6/7) para gerar devolucao
    const sitVenda = String(venda.situacao ?? "");
    if (sitVenda && !["6", "7", "2"].includes(sitVenda)) {
      return json({ modulo: "criar", conta, ok: false, codigo: "venda_nao_autorizada", venda_nao_autorizada: true, situacao_venda: sitVenda, chave_referenciada: venda.chaveAcesso || null,
        erro: `A NF de venda ${venda.numero} NAO esta autorizada (situacao ${sitVenda}). Devolucao nao se aplica - trate a NF de venda primeiro.` }, { status: 422 });
    }
    chave = venda.chaveAcesso || null;
    if (!chave || String(chave).length !== 44) return json({ codigo: "sem_chave", erro: `NF de venda sem chave de acesso valida` }, { status: 400 });
    if (conta === "ottz") {
      // v3.27: so venda da ACZ emitida no Lucro Real (desde 10/08/2026); o periodo do Simples fica de fora
      const emitVenda = digits(chave).slice(6, 20);
      const dataVenda = String(venda.dataEmissao || "").slice(0, 10);
      if (emitVenda !== CNPJ_ACZ) {
        return json({ modulo: "criar", conta, ok: false, codigo: "nao_acz", chave_referenciada: chave,
          erro: `A NF de venda ${venda.numero} nao e da ACZ (CNPJ ${emitVenda} na chave). Devolucao automatica da Ottz so para notas da ACZ.` }, { status: 422 });
      }
      if (!dataVenda || dataVenda < INICIO_LUCRO_REAL) {
        return json({ modulo: "criar", conta, ok: false, codigo: "venda_simples", chave_referenciada: chave, data_venda: dataVenda || null,
          erro: `A NF de venda ${venda.numero} foi emitida em ${dataVenda || "?"}, antes do Lucro Real (${INICIO_LUCRO_REAL}). Periodo do Simples fica de fora por enquanto.` }, { status: 422 });
      }
    }
    chaveParaVinculo = chave;

    // v3.20: anti-duplicata em TODAS as origens, tambem no dry (o motor usa o dry)
    const existente = await devolucaoExistente(supabase, conta, chave);
    if (existente) {
      return json({ modulo: "criar", conta, ok: false, codigo: "ja_existe", ja_existe: true, existente,
        id_nota_devolucao: existente.id_nota, chave_referenciada: chave, bridge, guard,
        erro: `Ja existe devolucao para a NF de venda ${venda.numero} (${existente.onde}, nota ${existente.numero ?? existente.id_nota}).` });
    }

    if (confirmar) {
      const { data: jaVinc } = await supabase.from("notas_cancelados")
        .select("id_nota_devolucao").eq("chave_nfe", chaveParaVinculo).not("id_nota_devolucao", "is", null).limit(1);
      if ((jaVinc || []).length > 0) {
        return json({ modulo: "criar", conta, ok: false, codigo: "ja_existe", ja_existe: true, id_nota_devolucao: jaVinc![0].id_nota_devolucao,
          erro: `Ja existe uma devolucao criada para este pedido (id ${jaVinc![0].id_nota_devolucao}).` });
      }
      if (conta === "ottz" && !guard.startsWith("reembolso_aceito")) {
        const { data: ncRow } = await supabase.from("notas_cancelados").select("tiny_pedido_id, numero_pedido").eq("chave_nfe", chaveParaVinculo).limit(1);
        const tinyPedidoId = ncRow?.[0]?.tiny_pedido_id;
        if (tinyPedidoId) {
          const ped = await tinyFetch(accessTokenPrincipal, `/pedidos/${tinyPedidoId}`);
          const sit = ped?.situacao;
          if (sit != null && String(sit) !== "2") {
            return json({ modulo: "criar", conta, ok: false, codigo: "nao_cancelado", nao_cancelado: true, situacao_pedido: sit,
              erro: `O pedido ${ped?.numeroPedido ?? ""} NAO esta cancelado (situacao ${sit} no principal).` });
          }
        }
      }
    }

    let fonteItens = itensDaVendaV3(venda);
    let origemItens = "nota_venda_v3";
    if (fonteItens.length === 0 || fonteItens.some((i: any) => !i.ncm)) {
      const vx = await itensDaVendaPorChave(v2Token, digits(chave));
      if (vx.itens.length > 0 && vx.itens.every((i: any) => i.ncm)) {
        fonteItens = vx.itens;
        origemItens = `xml_venda(${vx.fonte_id})`;
      }
    }
    let itensParcial = false;
    if (devolverItens && devolverItens.length > 0) {
      const rc = recortarItens(fonteItens, devolverItens);
      if (rc.faltando.length > 0) {
        return json({ modulo: "criar", conta, ok: false, codigo: "revisar_itens", chave_referenciada: chave, guard, bridge,
          erro: `Itens reembolsados que nao batem com a NF de venda ${venda.numero}: ${rc.faltando.join(", ")}. Criar a devolucao na mao.`,
          itens_venda: fonteItens.map((i: any) => `${i.codigo} x${i.quantidade}`), devolver: devolverItens }, { status: 422 });
      }
      fonteItens = rc.itens;
      itensParcial = rc.parcial;
    }
    const feito = montarPayloadDevolucao(venda, serie, chave, fonteItens);
    const { payload, nItens, itensSemNcm } = feito;
    const naturezaParam = (param("natureza") || "").trim() || (conta === "ottz" ? NATUREZA_OTTZ_LUCRO_REAL : ""); // v3.27
    if (naturezaParam) (payload.nota_fiscal as any).natureza_operacao = naturezaParam; // v3.25
    if (nItens === 0) return json({ codigo: "sem_itens", erro: "nota de venda sem itens" }, { status: 400 });

    if (!confirmar) {
      return json({ modulo: "criar", conta, dry: true, serie, guard, natureza: payload.nota_fiscal.natureza_operacao, itens_parcial: itensParcial, id_nota_venda: idNotaVenda, bridge, nota_venda_id: venda.id, nota_venda_numero: venda.numero, chave_referenciada: chave, origem_itens: origemItens, itens_sem_ncm: itensSemNcm, payload, aviso: "repita com confirmar=1 para incluir no Tiny (nasce Pendente)" });
    }

    if (itensSemNcm > 0) {
      return json({ modulo: "criar", conta, ok: false, codigo: "itens_sem_ncm", chave_referenciada: chave, itens_sem_ncm: itensSemNcm,
        erro: "item sem NCM mesmo apos buscar o XML da venda - a SEFAZ rejeitaria. Preencha o NCM no cadastro e tente de novo." }, { status: 422 });
    }

    const r = await tinyV2("nota.fiscal.incluir.php", { nota: JSON.stringify(payload) }, v2Token);
    const ret = r?.retorno || {};
    const reg = ret?.registros?.registro || ret?.registros || null;
    const ok = ret?.status === "OK";

    if (!ok && v2Bloqueada(ret)) {
      return json({ modulo: "criar", conta, ok: false, codigo: "v2_bloqueada", bloqueada: true, codigo_erro: 6,
        erro: "A API v2 do Tiny esta temporariamente bloqueada por excesso de acessos. Aguarde 1-2 minutos e tente novamente." });
    }

    let vinculado = false;
    // v3.26: o que o Tiny gravou de fato (kit pode ter sido desmembrado)
    let itensCriados: string[] | null = null;
    let itensDivergem = false;
    const normCod = (x: unknown) => String(x ?? "").trim().toUpperCase();
    if (ok && reg?.id) {
      try {
        await sleep(800);
        const criada = await tinyFetch(accessToken, `/notas/${reg.id}`);
        if (criada?.itens) {
          itensCriados = (criada.itens as any[]).map((i) => `${normCod(i.codigo)} x${Number(i.quantidade)}`).sort();
          const enviados = (payload.nota_fiscal.itens as any[]).map((x) => `${normCod(x.item.codigo)} x${Number(x.item.quantidade)}`).sort();
          itensDivergem = JSON.stringify(itensCriados) !== JSON.stringify(enviados);
        }
      } catch { /* so diagnostico */ }
      const { data } = await supabase.from("notas_cancelados").update({ id_nota_devolucao: reg.id }).eq("chave_nfe", chaveParaVinculo).select("tiny_pedido_id");
      vinculado = (data || []).length > 0;
      // v3.20: entra na hora na lista de emissao da SVL (o sync diario so passa as 5h30)
      if (conta === "svl") {
        const valor = (payload.nota_fiscal.itens as any[]).reduce((a, x) => a + Number(x.item.quantidade) * Number(x.item.valor_unitario), 0);
        const agora = new Date().toISOString();
        await supabase.from("devolucoes_svl_base").upsert({
          id_nota: Number(reg.id), numero: reg.numero ?? null, serie: String(reg.serie ?? serie),
          valor: Math.round(valor * 100) / 100, cliente_nome: fixEnc(venda.cliente?.nome) || null,
          data_emissao: new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }),
          situacao: "1", autorizada: false, chave_referenciada: chave, chave_lida_em: agora,
          atualizado_em: agora, verificado_em: agora,
        }, { onConflict: "id_nota" });
      }
    }
    return json({
      modulo: "criar", conta, ok, serie, guard, itens_parcial: itensParcial, bridge, nota_venda_id: venda.id, nota_venda_numero: venda.numero,
      codigo: ok ? "criada" : "erro_tiny",
      status: ret?.status || null, codigo_erro: ret?.codigo_erro || null, erros: ret?.erros || reg?.erros || null,
      erro: ok ? null : "O Tiny nao confirmou a criacao da devolucao.",
      registro: reg ? { sequencia: reg.sequencia, status: reg.status, id: reg.id, numero: reg.numero, serie: reg.serie } : null,
      chave_referenciada: chave, vinculado_no_app: vinculado, origem_itens: origemItens,
      itens_enviados: (payload.nota_fiscal.itens as any[]).map((x) => `${x.item.codigo} x${x.item.quantidade}`),
      itens_criados: itensCriados, itens_divergem: itensDivergem,
      aviso: !ok ? null : itensDivergem
        ? "O Tiny DESMEMBROU o kit ao incluir: os itens da devolucao nao casam com a NF de venda e a emissao vai ser recusada (item sem chave da NF-e referenciada). Nao emita: exclua a nota no Tiny."
        : "Nota criada PENDENTE no Tiny - confira/emita em seguida",
    });
  }

  if (modulo === "pendentes") {
    const inicio = Date.now();
    const dias = Math.min(parseInt(param("dias") || "30", 10), 90);
    const dataInicial = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const lista = await tinyFetch(accessToken, `/notas?situacao=1&dataInicial=${dataInicial}`);
    const itens = (lista?.itens || []).filter((n: any) => n?.tipo === "E");
    const pendentes: any[] = [];
    for (const n of itens.slice(0, 30)) {
      if (Date.now() - inicio > 40000) break;
      let chaveRef: string | null = null;
      try {
        const det = await tinyFetch(accessToken, `/notas/${n.id}`);
        chaveRef = extrairChaveReferenciada(det?.observacoes);
        await sleep(350);
      } catch { /* segue sem chave */ }
      pendentes.push({ id_nota: n.id, numero: n.numero, serie: n.serie, valor: n.valor, data_emissao: n.dataEmissao, cliente: fixEnc(n.cliente?.nome) || null, chave_referenciada: chaveRef });
    }
    const chaves = pendentes.map((p) => p.chave_referenciada).filter(Boolean);
    const ids = pendentes.map((p) => p.id_nota);
    const porChave = new Map<string, any>();
    const porId = new Map<number, any>();
    if (chaves.length > 0 || ids.length > 0) {
      const { data } = await supabase.from("notas_cancelados")
        .select("chave_nfe, id_nota_devolucao, tiny_pedido_id, numero_pedido, numero_ecommerce, marca_canal, precisa_devolucao, devolucao_emitida")
        .or(`chave_nfe.in.(${chaves.map((c) => '"' + c + '"').join(",") || '"x"'}),id_nota_devolucao.in.(${ids.join(",") || 0})`);
      for (const r of (data || [])) {
        if (r.chave_nfe) porChave.set(r.chave_nfe, r);
        if (r.id_nota_devolucao) porId.set(Number(r.id_nota_devolucao), r);
      }
    }
    for (const p of pendentes) {
      const m = (p.chave_referenciada ? porChave.get(p.chave_referenciada) : null) || porId.get(Number(p.id_nota)) || null;
      p.pedido_cancelado = m ? { numero_pedido: m.numero_pedido, numero_ecommerce: m.numero_ecommerce, marca_canal: m.marca_canal, precisa_devolucao: m.precisa_devolucao } : null;
    }
    return json({ modulo: "pendentes", conta, dias, total: pendentes.length, pendentes, tempo_ms: Date.now() - inicio });
  }

  if (modulo === "emitir") {
    const idNota = parseInt(param("id_nota") || "0", 10);
    const confirmar = param("confirmar") === "1";
    if (!idNota) return json({ erro: "informe id_nota" }, { status: 400 });
    if (!confirmar) return json({ erro: "emissao e irreversivel - repita com confirmar=1" }, { status: 400 });

    const det = await tinyFetch(accessToken, `/notas/${idNota}`);
    if (!det) return json({ erro: `nota ${idNota} nao encontrada` }, { status: 404 });
    if (det.tipo !== "E") return json({ erro: `nota ${idNota} nao e de entrada (tipo=${det.tipo}) - este modulo so emite devolucoes` }, { status: 400 });
    if (String(det.situacao) !== "1") {
      const s = String(det.situacao);
      if (s === "6" || s === "7") return json({ modulo: "emitir", conta, id_nota: idNota, numero: det.numero, serie: det.serie, autorizada: true, situacao: s, ja_estava: true });
      if (s === "5") return json({ modulo: "emitir", conta, id_nota: idNota, numero: det.numero, autorizada: false, situacao: s, rejeitada: true,
        erro: `nota ${det.numero} esta REJEITADA pela SEFAZ - nao da para reemitir direto`,
        dica: `recrie com a data de hoje e itens fiscais completos: nf-devolucao?modulo=clonar&conta=${conta}&id_nota=${idNota}&confirmar=1 (depois emita o novo id)` }, { status: 422 });
      return json({ erro: `nota ${idNota} nao esta Pendente (situacao=${det.situacao})` }, { status: 400 });
    }
    const chaveRef = extrairChaveReferenciada(det.observacoes);

    const emitirUma = () => tinyFetch(accessToken, `/notas/${idNota}/emitir`, { method: "POST", body: JSON.stringify({ enviarEmail: false }) });
    const ehAutorizada = (s: string | null) => s === "6" || s === "7" || s === "2";
    const motivoDe = (r: any): string => {
      const xml = typeof r?.xml === "string" ? r.xml : "";
      const m = xml.match(/<erro>([^<]{0,300})<\/erro>/) || xml.match(/<xMotivo>([^<]{0,300})<\/xMotivo>/);
      if (m) return m[1];
      if (typeof r?.mensagem === "string") return r.mensagem;
      if (Array.isArray(r?.erros) && r.erros.length) return JSON.stringify(r.erros).substring(0, 300);
      return "";
    };
    const ehConsumoIndevido = (r: any): boolean => {
      const s = (motivoDe(r) + " " + JSON.stringify(r?.mensagem ?? "") + " " + JSON.stringify(r?.erros ?? "")).toLowerCase();
      return s.includes("consumo indevido") || /656/.test(s) && /rejei|cstat|consumo/.test(s);
    };

    let res = await emitirUma();
    let situacao = res?.situacao != null ? String(res.situacao) : null;
    let autorizada = ehAutorizada(situacao);
    let tentativas = 1;
    let consumoIndevido = ehConsumoIndevido(res);

    if (!autorizada && !consumoIndevido) {
      await sleep(3500);
      const rec = await tinyFetch(accessToken, `/notas/${idNota}`);
      const sitRec = rec?.situacao != null ? String(rec.situacao) : null;
      if (ehAutorizada(sitRec)) { res = rec; situacao = sitRec; autorizada = true; }
      else if (sitRec === "1") { res = await emitirUma(); tentativas = 2; situacao = res?.situacao != null ? String(res.situacao) : null; autorizada = ehAutorizada(situacao); consumoIndevido = ehConsumoIndevido(res); }
    }

    const chaveDevolucao = res?.chaveAcesso || null;
    const motivo: string | null = motivoDe(res) || null;
    const faltaNcm = !autorizada && /ncm/i.test(motivo || "");

    let registrado = false;
    if (autorizada) {
      const upd = { devolucao_emitida: true, id_nota_devolucao: idNota, observacao: `Devolucao ${det.numero}/${det.serie} emitida via app (conta ${conta}) em ${new Date().toISOString().slice(0, 10)}` };
      if (chaveRef) { const { data } = await supabase.from("notas_cancelados").update(upd).eq("chave_nfe", chaveRef).select("tiny_pedido_id"); registrado = (data || []).length > 0; }
      if (!registrado) { const { data } = await supabase.from("notas_cancelados").update(upd).eq("id_nota_devolucao", idNota).select("tiny_pedido_id"); registrado = (data || []).length > 0; }
    }

    return json({ modulo: "emitir", conta, id_nota: idNota, numero: det.numero, serie: det.serie, autorizada, situacao, tentativas, consumo_indevido: consumoIndevido, motivo, falta_ncm: faltaNcm, chave_devolucao: chaveDevolucao, chave_referenciada: chaveRef, registrado_no_app: registrado, dica: faltaNcm ? `Item sem NCM: recrie com os itens fiscais do XML da venda: nf-devolucao?modulo=clonar&conta=${conta}&id_nota=${idNota}&confirmar=1 (depois emita o novo id).` : undefined, aviso: consumoIndevido ? "SEFAZ bloqueou temporariamente (Rejeicao 656 - Consumo Indevido) por excesso de requisicoes. PARE de emitir, aguarde ~1h e emita mais devagar." : undefined, nota_estoque: "estoque NAO lancado (fluxo manual no Tiny, por decisao)" });
  }

  if (modulo === "varrer-cancelados") {
    const inicio = Date.now();
    const TIMEOUT_MS = 50000;
    const limite = Math.min(parseInt(param("limite") || "40", 10), 80);
    const { data: candidatos, error: errSel } = await supabase
      .from("pedidos_tiny")
      .select("tiny_pedido_id, numero_pedido, numero_ecommerce, marca_canal, data_pedido, valor_total")
      .eq("situacao", "cancelada")
      .gte("data_pedido", new Date(Date.now() - 90 * 86400000).toISOString())
      .order("data_pedido", { ascending: false }).limit(500);
    if (errSel) return json({ erro: `select: ${errSel.message}` }, { status: 500 });

    const ids = (candidatos || []).map((c: any) => c.tiny_pedido_id);
    const jaVerificados = new Set<number>();
    for (let i = 0; i < ids.length; i += 300) {
      const lote = ids.slice(i, i + 300);
      const { data } = await supabase.from("notas_cancelados").select("tiny_pedido_id").in("tiny_pedido_id", lote).gte("verificado_em", new Date(Date.now() - 12 * 3600 * 1000).toISOString());
      for (const r of (data || [])) jaVerificados.add(r.tiny_pedido_id);
    }
    const pendentes = (candidatos || []).filter((c: any) => !jaVerificados.has(c.tiny_pedido_id)).slice(0, limite);

    let comNf = 0, semNf = 0, erros = 0, puloNaoCancelado = 0;
    const linhas: any[] = [];
    for (const p of pendentes) {
      if (Date.now() - inicio > TIMEOUT_MS) break;
      try {
        const det = await tinyFetch(accessTokenPrincipal, `/pedidos/${p.tiny_pedido_id}`);
        await sleep(600);
        if (det && String(det.situacao) !== "2") { puloNaoCancelado++; continue; }
        const idNota = det?.idNotaFiscal || null;
        let nota: any = null;
        if (idNota) { nota = await tinyFetch(accessTokenPrincipal, `/notas/${idNota}`); await sleep(600); }
        linhas.push({ tiny_pedido_id: p.tiny_pedido_id, numero_pedido: p.numero_pedido, numero_ecommerce: p.numero_ecommerce, marca_canal: p.marca_canal, data_pedido: p.data_pedido, valor_pedido: p.valor_total, id_nota_fiscal: idNota, numero_nf: nota?.numero || null, serie_nf: nota?.serie || null, chave_nfe: nota?.chaveAcesso || null, data_emissao_nf: (nota?.dataEmissao && nota.dataEmissao !== "0000-00-00") ? nota.dataEmissao : null, valor_nf: nota?.valor != null ? Number(nota.valor) : null, finalidade_nf: nota?.finalidade || null, situacao_nf: nota?.situacao || null, tipo_nf: nota?.tipo || null, verificado_em: new Date().toISOString() });
        if (idNota && nota) comNf++; else semNf++;
      } catch (err) { erros++; const msg = (err as Error).message; if (msg.includes("429")) break; }
    }

    let gravadas = 0;
    if (linhas.length > 0) {
      const { error } = await supabase.from("notas_cancelados").upsert(linhas, { onConflict: "tiny_pedido_id" });
      if (!error) gravadas = linhas.length; else return json({ erro: `upsert: ${error.message}`, processados: linhas.length }, { status: 500 });
    }

    let limpos = 0;
    try {
      const { data: suspeitos } = await supabase.from("notas_cancelados").select("tiny_pedido_id").is("id_nota_devolucao", null).not("devolucao_emitida", "is", true);
      const idsSus = (suspeitos || []).map((s: any) => s.tiny_pedido_id).filter(Boolean);
      for (let i = 0; i < idsSus.length; i += 300) {
        const lote = idsSus.slice(i, i + 300);
        const { data: ativos } = await supabase.from("pedidos_tiny").select("tiny_pedido_id").in("tiny_pedido_id", lote).neq("situacao", "cancelada");
        const paraRemover = (ativos || []).map((a: any) => a.tiny_pedido_id);
        if (paraRemover.length > 0) {
          const { data: del } = await supabase.from("notas_cancelados").delete().in("tiny_pedido_id", paraRemover).is("id_nota_devolucao", null).not("devolucao_emitida", "is", true).select("tiny_pedido_id");
          limpos += (del || []).length;
        }
      }
    } catch (_e) { /* best-effort */ }

    return json({ modulo: "varrer-cancelados", conta: "ottz", candidatos_90d: (candidatos || []).length, ja_verificados_12h: jaVerificados.size, processados_agora: pendentes.length, com_nf: comNf, sem_nf: semNf, pulados_nao_cancelado_ao_vivo: puloNaoCancelado, erros, gravadas, limpos_falsos_positivos: limpos, restam: (candidatos || []).length - jaVerificados.size - pendentes.length, tempo_ms: Date.now() - inicio });
  }

  return json({ modulos: ["varrer-cancelados", "pendentes", "emitir", "criar", "clonar", "clonar-lote", "v2-teste", "svl-nota", "nota-crua", "procurar-nota", "itens-venda"], conta, nota: "v3.27: Ottz so Lucro Real (natureza propria, reembolso aceito, anti-duplicata fiscal); v3.26: criar rele a nota e avisa itens_divergem (kit desmembrado pelo Tiny); v3.25: criar direto por id_nota_venda+pedido_id nas duas contas, natureza opcional" });
});
