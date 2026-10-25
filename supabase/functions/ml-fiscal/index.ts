// ============================================================================
// Edge Function: ml-fiscal v1 (25/out/2026) — IA · Anúncios
// ----------------------------------------------------------------------------
// Pedido do dono: enviar ao Mercado Livre SÓ os dados fiscais de um produto (NCM, origem, CEST), sem mexer no
// anúncio. O ML guarda isso por SKU (`/items/fiscal_information/{sku}`), não por anúncio; o kit é um "bundle"
// que aponta para o SKU do componente — então, para kit, os dados enviados são os do(s) componente(s).
// Teste de leitura de 25/out (CLAUDE.md §5.11.13.3): os produtos já estão cadastrados nas duas contas; Ottz com a
// regra tributária 838502 "PRODUTO ICMS NORMAL", SVL sem regra (csosn 102).
//   POST ?modulo=previa  {empresa: ottz|svl, sku, valores?: {<sku>: {ncm, origem, cest}}}
//        → por SKU: o que está no ML hoje × o que vai ficar (NCM, origem e CEST do Tiny; dá para digitar). Só lê.
//   POST ?modulo=aplicar {…o mesmo…, confirmar: true}
//        → SKU que já existe no ML: PUT com o cadastro de hoje trocando só os campos que mudam; SKU novo: POST com
//          a regra da conta. Cada envio UMA vez (sem repetição); só se o ML responder "método não aceito"
//          (nada gravado) tenta o outro verbo. Relê depois. Registro em debug_fulfillment (modulo 'ml-fiscal').
// Sessão de usuário com o módulo `ia`.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const ML = "https://api.mercadolibre.com";
const TINY_HOST = Deno.env.get("TINY_API_HOST") || "https://api.tiny.com.br/public-api/v3";
/** Conta do ML por empresa + como um SKU NOVO nasce lá (o mesmo dos cadastros que já existem em cada conta). */
const CONTA: Record<string, { uid: number; nome: string; novo: Record<string, unknown> }> = {
  ottz: { uid: 1107117809, nome: "Mercado Livre · Ottz", novo: { tax_rule_id: 838502 } },
  svl: { uid: 1299638625, nome: "Mercado Livre · SVL", novo: { csosn: "102" } },
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exigirAcesso(req: Request): Promise<{ nome: string | null } | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

type Resp = { status: number; body: any };
async function tokenMl(uid: number): Promise<string> {
  const { data } = await db.from("oauth_tokens_ml").select("access_token, expires_at").eq("user_id", uid).maybeSingle();
  if (!data) throw new Error("conta do Mercado Livre não conectada");
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token do Mercado Livre vencido — a renovação roda de 30 em 30 min; tente de novo em instantes");
  return String(data.access_token);
}
async function ml(token: string, metodo: string, path: string, corpo?: unknown): Promise<Resp> {
  const r = await fetch(`${ML}${path}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { message: txt.slice(0, 300) }; }
  return { status: r.status, body };
}
const erroMl = (b: any) => [b?.message, b?.error, ...((b?.cause ?? b?.causes ?? []) as any[]).map((c) => c?.message ?? c?.code)].filter(Boolean).join(" · ").slice(0, 400);

/** NCM e origem (v3) e CEST (v2) do cadastro do Tiny. Melhor-esforço: o que não vier fica vazio. */
async function fiscalTiny(idTiny: number | null): Promise<{ ncm: string; origem: string | null; cest: string; lido: boolean }> {
  const out = { ncm: "", origem: null as string | null, cest: "", lido: false };
  if (!idTiny) return out;
  try {
    const { data } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", "ottz").limit(1).single();
    if (data) {
      const r = await fetch(`${TINY_HOST}/produtos/${idTiny}`, { headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/json" } });
      if (r.ok) {
        const p = await r.json();
        out.ncm = digitos(p?.ncm); out.lido = true;
        out.origem = p?.origem != null && String(p.origem).trim() !== "" ? String(p.origem).trim() : null;
      }
    }
  } catch { /* segue sem */ }
  const tk = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
  if (tk) {
    try {
      const r = await fetch(`https://api.tiny.com.br/api2/produto.obter.php?token=${encodeURIComponent(tk)}&id=${idTiny}&formato=json`);
      if (r.ok) out.cest = digitos((await r.json())?.retorno?.produto?.cest);
    } catch { /* segue sem */ }
  }
  return out;
}

const CAMPOS = [
  { k: "ncm", attr: "ncm", nome: "NCM" },
  { k: "origem", attr: "origin_detail", nome: "Origem" },
  { k: "cest", attr: "cest", nome: "CEST" },
] as const;
type Linha = { campo: string; nome: string; atual: string; novo: string; fonte: string; muda: boolean };
type Item = {
  sku: string; nome: string | null; quantidade: number | null; existe: boolean; pode_faturar: boolean | null; regra: string | null;
  linhas: Linha[]; corpo: Record<string, unknown> | null; metodo: "PUT" | "POST" | null; pendencias: string[]; avisos: string[];
};

/** O SKU no ML + Tiny → o que vai ser enviado. */
async function montarItem(token: string, conta: (typeof CONTA)[string], sku: string, quantidade: number | null, digitados: Record<string, unknown>): Promise<Item> {
  const [{ data: cad }, { data: cmv }, atualR] = await Promise.all([
    db.from("produtos").select("sku, nome, id_tiny, gtin, peso_bruto, peso_liquido, tipo").eq("sku", sku).maybeSingle(),
    db.from("view_cmv_efetivo").select("cmv_efetivo").eq("sku", sku).maybeSingle(),
    ml(token, "GET", `/items/fiscal_information/${encodeURIComponent(sku)}`),
  ]);
  const pendencias: string[] = []; const avisos: string[] = [];
  const existe = atualR.status === 200 && !!atualR.body?.tax_information;
  if (!existe && atualR.status !== 404) pendencias.push(`não consegui ler o cadastro fiscal do ${sku} no ML: ${erroMl(atualR.body) || atualR.status}`);
  const ti = (atualR.body?.tax_information ?? {}) as Record<string, any>;
  const tiny = await fiscalTiny(cad?.id_tiny ? Number(cad.id_tiny) : null);
  if (!cad) avisos.push(`o SKU ${sku} não está no cadastro da gestão: digite os valores`);
  else if (!cad.id_tiny) avisos.push(`o SKU ${sku} não tem id do Tiny: NCM, origem e CEST não puderam ser lidos`);
  else if (!tiny.lido) avisos.push(`o Tiny não respondeu para o ${sku}: NCM e origem não foram lidos`);

  // valor sugerido = o do Tiny (a nota do ML tem de bater com a que o Tiny emite); sem Tiny, fica o que está no ML
  const sugerido: Record<string, { v: string; fonte: string }> = {
    ncm: tiny.ncm ? { v: tiny.ncm, fonte: "Tiny" } : { v: digitos(ti.ncm), fonte: ti.ncm ? "ML (mantido)" : "" },
    origem: tiny.origem != null ? { v: tiny.origem, fonte: "Tiny" } : { v: String(ti.origin_detail ?? ""), fonte: ti.origin_detail != null ? "ML (mantido)" : "" },
    cest: tiny.cest ? { v: tiny.cest, fonte: "Tiny" } : { v: digitos(ti.cest), fonte: ti.cest ? "ML (mantido)" : "" },
  };
  const linhas: Linha[] = CAMPOS.map((f) => {
    const dig = String(digitados[f.k] ?? "").trim();
    const novo = dig ? (f.k === "origem" ? dig : digitos(dig)) : sugerido[f.k].v;
    const hoje = f.k === "origem" ? String(ti.origin_detail ?? "") : digitos(ti[f.attr]);
    return { campo: f.k, nome: f.nome, atual: hoje, novo, fonte: dig ? "digitado" : sugerido[f.k].fonte, muda: !!novo && novo !== hoje };
  });
  const v = Object.fromEntries(linhas.map((l) => [l.campo, l.novo]));
  if (!v.ncm) pendencias.push(`${sku}: sem NCM (nem o Tiny nem o ML têm) — digite o NCM`);
  else if (v.ncm.length !== 8) pendencias.push(`${sku}: NCM "${v.ncm}" precisa ter 8 dígitos`);
  if (v.cest && v.cest.length !== 7) pendencias.push(`${sku}: CEST "${v.cest}" precisa ter 7 dígitos`);
  if (v.origem && !/^[0-8]$/.test(v.origem)) pendencias.push(`${sku}: origem "${v.origem}" deve ser de 0 a 8`);
  const ncmL = linhas[0];
  if (existe && ncmL.muda && ncmL.atual) avisos.push(`${sku}: o NCM muda de ${ncmL.atual} para ${ncmL.novo} — NCM muda o imposto da nota, confirme com o contador`);

  let corpo: Record<string, unknown> | null = null; let metodo: Item["metodo"] = null;
  if (existe && linhas.some((l) => l.muda)) {
    // o cadastro de hoje, inteiro, trocando só NCM/origem/CEST (o ML pede o registro completo)
    metodo = "PUT";
    corpo = {
      sku, title: atualR.body.title, type: atualR.body.type ?? "single", measurement_unit: atualR.body.measurement_unit ?? "UN",
      cost: atualR.body.cost, tax_information: { ...ti, ncm: v.ncm, origin_detail: v.origem || ti.origin_detail, cest: v.cest ?? "" },
    };
    delete (corpo.tax_information as Record<string, unknown>).empty;
  } else if (!existe && atualR.status === 404) {
    metodo = "POST";
    const custo = cmv?.cmv_efetivo != null ? Number(cmv.cmv_efetivo) : null;
    if (custo == null) pendencias.push(`${sku}: sem custo na gestão — o ML pede o custo no cadastro fiscal`);
    corpo = {
      sku, title: cad?.nome ?? sku, type: "single", measurement_unit: "UN", cost: custo,
      tax_information: {
        ncm: v.ncm, origin_type: "reseller", origin_detail: v.origem || "0", cest: v.cest ?? "", ean: digitos(cad?.gtin),
        gross_weight: Number(cad?.peso_bruto) || undefined, net_weight: Number(cad?.peso_liquido ?? cad?.peso_bruto) || undefined,
        ...conta.novo,
      },
    };
    avisos.push(`${sku}: ainda não tem cadastro fiscal no ${conta.nome} — vai ser criado${conta.novo.tax_rule_id ? ` com a regra ${conta.novo.tax_rule_id} (PRODUTO ICMS NORMAL)` : " como Simples Nacional (CSOSN 102)"}`);
  }
  return {
    sku, nome: cad?.nome ?? atualR.body?.title ?? null, quantidade, existe, pode_faturar: existe ? atualR.body?.can_invoice === true : null,
    regra: ti.tax_rule_id != null ? String(ti.tax_rule_id) : null, linhas, corpo, metodo, pendencias, avisos,
  };
}

/** Produto → SKUs que têm cadastro fiscal no ML: o próprio (simples) ou os componentes (kit). */
async function alvos(sku: string): Promise<{ tipo: string | null; itens: { sku: string; quantidade: number | null }[]; erro?: string }> {
  const { data: p } = await db.from("produtos").select("sku, tipo").eq("sku", sku).maybeSingle();
  if (p?.tipo === "V") return { tipo: "V", itens: [], erro: "produto com variações: escolha uma variação (o ML guarda os dados fiscais por SKU)" };
  if (p?.tipo === "K") {
    const { data: ks } = await db.from("produto_kits").select("sku_componente, quantidade").eq("sku_kit", sku);
    const itens = ((ks ?? []) as { sku_componente: string; quantidade: number }[]).map((k) => ({ sku: String(k.sku_componente), quantidade: Number(k.quantidade) }));
    if (!itens.length) return { tipo: "K", itens: [], erro: "kit sem composição no cadastro" };
    return { tipo: "K", itens };
  }
  return { tipo: p?.tipo ?? null, itens: [{ sku, quantidade: null }] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") ?? "previa";
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  try {
    const conta = CONTA[String(body.empresa ?? "ottz")] ?? CONTA.ottz;
    const sku = String(body.sku ?? "").trim();
    if (!sku) return json({ ok: false, erro: "informe o SKU" }, 400);
    const a = await alvos(sku);
    if (a.erro) return json({ ok: false, erro: a.erro }, 400);
    const token = await tokenMl(conta.uid);
    const valores = (body.valores ?? {}) as Record<string, Record<string, unknown>>;
    const itens: Item[] = [];
    for (const x of a.itens) itens.push(await montarItem(token, conta, x.sku, x.quantidade, valores[x.sku] ?? {}));
    const pendencias = [...new Set(itens.flatMap((i) => i.pendencias))];
    const avisos = [...new Set(itens.flatMap((i) => i.avisos))];
    if (a.tipo === "K") avisos.unshift(`${sku} é kit: no ML o kit usa os dados fiscais do componente — o envio corrige o cadastro de ${itens.map((i) => i.sku).join(", ")} (vale para todo anúncio que usa esse produto)`);
    const previa = {
      conta: conta.nome, sku, tipo: a.tipo, nada_a_mudar: itens.every((i) => !i.corpo),
      itens: itens.map(({ corpo: _c, ...r }) => r),
    };
    if (modulo === "previa") return json({ ok: true, previa, pendencias, avisos });
    if (modulo !== "aplicar") return json({ ok: false, erro: `módulo desconhecido: ${modulo}` }, 400);
    if (body.confirmar !== true) return json({ ok: false, erro: "confirmação exigida (confirmar: true)" }, 400);
    if (pendencias.length) return json({ ok: false, erro: "há pendências — confira antes de enviar", pendencias }, 400);
    if (previa.nada_a_mudar) return json({ ok: false, erro: "os dados fiscais já estão iguais: nada a enviar" }, 400);

    const feitos: Record<string, unknown>[] = [];
    for (const it of itens) {
      if (!it.corpo || !it.metodo) continue;
      const caminho = it.metodo === "PUT" ? `/items/fiscal_information/${encodeURIComponent(it.sku)}` : "/items/fiscal_information";
      let w = await ml(token, it.metodo, caminho, it.corpo);
      let metodo: string = it.metodo;
      // 405 = o ML não aceita este verbo neste caminho: nada foi gravado, tenta o outro uma vez
      if (w.status === 405) {
        metodo = it.metodo === "PUT" ? "POST" : "PUT";
        w = await ml(token, metodo, metodo === "PUT" ? `/items/fiscal_information/${encodeURIComponent(it.sku)}` : "/items/fiscal_information", it.corpo);
      }
      const aceito = w.status >= 200 && w.status < 300;
      let depois: Record<string, string> | null = null;
      if (aceito) {
        await sleep(1500);
        const d = await ml(token, "GET", `/items/fiscal_information/${encodeURIComponent(it.sku)}`);
        const t = d.body?.tax_information ?? {};
        depois = { ncm: digitos(t.ncm), origem: String(t.origin_detail ?? ""), cest: digitos(t.cest), pode_faturar: String(d.body?.can_invoice ?? "") };
      }
      const resposta = { status: w.status, metodo, erro: aceito ? null : erroMl(w.body), corpo: w.body };
      await db.from("debug_fulfillment").insert({
        modulo: "ml-fiscal", etapa: `${conta.uid}:${it.sku}`, status_http: w.status,
        resultado: { conta: conta.nome, por: quem.nome, produto: sku, antes: Object.fromEntries(it.linhas.map((l) => [l.campo, l.atual])), enviado: it.corpo, resposta, depois },
      });
      feitos.push({ sku: it.sku, ok: aceito, metodo, status: w.status, erro: resposta.erro, enviados: it.linhas.filter((l) => l.muda).map((l) => l.nome), depois });
      if (!aceito) return json({ ok: false, erro: `o ML recusou o ${it.sku}: ${resposta.erro || w.status}`, feitos, parou_em: it.sku }, 200);
    }
    return json({ ok: true, feitos });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
