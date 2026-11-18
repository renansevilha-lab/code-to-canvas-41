// fiscal-nfe — espelho fiscal das NF-e do Tiny (conta ottz = ACZ Pet), para o fechamento contábil.
// Opção A do dono (18/nov/2026): dados enxutos no banco (fiscal_nfe + fiscal_nfe_item) e o XML ORIGINAL
// compactado no Storage (bucket privado fiscal-xml: nfe/AAAA-MM/<chave>.xml.gz e <chave>-canc.xml.gz).
// Só LÊ o Tiny. Roda à noite por cron; cada chamada trabalha ~40 s e para sozinha.
//
// modulo=rodar [&max=30][&folga=15][&piso=AAAA-MM-DD][&listar_dias=6]
//   1) relê a LISTA dos 3 últimos dias (notas novas e mudança de situação), 1× a cada ~20 h;
//   2) relê as CANCELADAS dos últimos 60 dias (nota cancelada depois de guardada volta para a fila), 1×/dia;
//   3) carga para trás: lista dias ainda não lidos, do mais novo para o mais antigo, até `piso`;
//   4) baixa o XML das notas pendentes (mais novas primeiro), grava dados + arquivo.
//   Para quando o Tiny avisa que restam poucas chamadas no minuto (`folga`) — o limite de 60/min é dividido
//   com a separação — ou no 429. Nunca repete chamada.
// modulo=status → contagens (por mês, pendentes, erros, dias listados).
//
// Entradas (tipo E): o Tiny lista milhares de "notas" de frete sem chave de acesso; só entra o que tem chave
// de 44 dígitos (NF-e de fornecedor, devolução emitida pela ACZ, retorno do Full).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { eventosDe, lerXml, notaDe } from "../_shared/nfe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const TINY = "https://api.tiny.com.br/public-api/v3";
const CONTA = "ottz";
const BUCKET = "fiscal-xml";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ctx = { db: any; token: string; inicio: number; orcamento: number; folga: number; chamadas: number; restante: number | null; parou: string | null };
const tempoOk = (c: Ctx, reserva = 0) => Date.now() - c.inicio < c.orcamento - reserva;
const podeChamar = (c: Ctx) => !c.parou && (c.restante == null || c.restante > c.folga);

async function tiny(c: Ctx, path: string) {
  if (!podeChamar(c)) { c.parou = c.parou ?? `o Tiny avisou que restam ${c.restante} chamadas neste minuto`; return { status: 0, ok: false, body: null as any }; }
  c.chamadas++;
  let r: Response;
  try { r = await fetch(`${TINY}${path}`, { headers: { Authorization: `Bearer ${c.token}` } }); }
  catch (e) { return { status: 0, ok: false, body: { erro: String((e as Error).message) } }; }
  const rem = Number(r.headers.get("x-ratelimit-remaining")); if (r.headers.has("x-ratelimit-remaining") && Number.isFinite(rem)) c.restante = rem;
  const t = await r.text(); let b: any; try { b = JSON.parse(t); } catch { b = { texto: t.slice(0, 300) }; }
  if (r.status === 429) c.parou = "limite de chamadas do Tiny (429)";
  if (r.status === 401) c.parou = "token do Tiny recusado (401)";
  return { status: r.status, ok: r.ok, body: b };
}

async function lerToken(db: any): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.from("oauth_tokens_tiny").select("access_token").eq("conta", CONTA).limit(1).maybeSingle();
    if (!error && data?.access_token) return data.access_token;
    await sleep(700);
  }
  return null;
}

const hojeBRT = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const maisDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const soDig = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** Grava as notas de uma página da lista. Nota já guardada que passou a "cancelada" (3) volta para a fila do XML. */
async function gravarPagina(c: Ctx, tipo: string, itens: any[]) {
  const linhas = itens.filter((x) => soDig(x.chaveAcesso).length === 44 && x.id && x.dataEmissao).map((x) => ({
    chave: soDig(x.chaveAcesso), tiny_id: Number(x.id), conta: CONTA, tipo, numero: String(x.numero ?? ""), serie: String(x.serie ?? ""),
    dia: String(x.dataEmissao).slice(0, 10), situacao_tiny: String(x.situacao ?? ""), v_nf_lista: Number(x.valor) || 0, visto_em: new Date().toISOString(),
  }));
  if (!linhas.length) return { com_chave: 0, voltaram: 0, erro: null as string | null };
  const viraram = linhas.filter((l) => l.situacao_tiny === "3").map((l) => l.chave);
  let voltar: string[] = [];
  if (viraram.length) {
    const { data } = await c.db.from("fiscal_nfe").select("chave").in("chave", viraram).neq("situacao_tiny", "3").eq("cancelada", false).not("xml_em", "is", null);
    voltar = ((data ?? []) as any[]).map((d) => d.chave);
  }
  let { error } = await c.db.from("fiscal_nfe").upsert(linhas, { onConflict: "chave" });
  if (error) {
    // uma linha ruim (ex.: o mesmo id do Tiny com outra chave) não derruba a página
    let falhas = 0; let ultimo = "";
    for (const l of linhas) { const r = await c.db.from("fiscal_nfe").upsert(l, { onConflict: "chave" }); if (r.error) { falhas++; ultimo = r.error.message; } }
    error = falhas === linhas.length ? { message: ultimo } : null;
  }
  if (voltar.length) await c.db.from("fiscal_nfe").update({ xml_em: null, xml_tentativas: 0, xml_erro: null }).in("chave", voltar);
  return { com_chave: linhas.length, voltaram: voltar.length, erro: error?.message ?? null };
}

/** Lê a lista do Tiny de um período (todas as páginas). `completo` = leu tudo. */
async function listar(c: Ctx, tipo: string, de: string, ate: string, extra = "") {
  let total = 0, lidos = 0, comChave = 0, voltaram = 0; let erro: string | null = null; let foraDoPlano = false;
  for (let offset = 0; ; offset += 100) {
    if (!tempoOk(c, 4000)) { erro = "sem tempo"; break; }
    const r = await tiny(c, `/notas?tipo=${tipo}&dataInicial=${de}&dataFinal=${ate}&limit=100&offset=${offset}${extra}`);
    if (!r.ok) {
      const msg = JSON.stringify(r.body ?? "").slice(0, 300);
      if (r.status === 400 && /per[ií]odo|plano/i.test(msg)) foraDoPlano = true;
      erro = c.parou ?? `Tiny ${r.status}: ${msg}`; break;
    }
    const itens = (r.body?.itens ?? []) as any[];
    total = Number(r.body?.paginacao?.total ?? itens.length);
    const g = await gravarPagina(c, tipo, itens);
    if (g.erro) { erro = `banco: ${g.erro}`; break; }
    lidos += itens.length; comChave += g.com_chave; voltaram += g.voltaram;
    if (!itens.length || lidos >= total) break;
  }
  return { total, lidos, comChave, voltaram, erro, foraDoPlano, completo: !erro };
}

async function listarDia(c: Ctx, tipo: string, dia: string) {
  const r = await listar(c, tipo, dia, dia);
  if (r.completo || r.foraDoPlano) {
    await c.db.from("fiscal_nfe_dia").upsert({ conta: CONTA, tipo, dia, total_api: r.total, com_chave: r.comChave, listado_em: new Date().toISOString(), fora_do_plano: r.foraDoPlano, erro: r.foraDoPlano ? r.erro : null }, { onConflict: "conta,tipo,dia" });
  }
  return r;
}

async function gzip(texto: string): Promise<Uint8Array> {
  const s = new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const n2 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

/** Baixa o XML das notas pendentes (mais novas primeiro), guarda o arquivo e os dados. */
async function baixar(c: Ctx, max: number) {
  const { data: fila, error } = await c.db.from("fiscal_nfe").select("chave, tiny_id, dia, xml_tentativas")
    .is("xml_em", null).lt("xml_tentativas", 4).order("dia", { ascending: false }).limit(max);
  if (error) return { baixados: 0, falhas: 0, erro: `banco: ${error.message}` };
  const notas: any[] = []; const itens: any[] = []; const falhas: { chave: string; tentativas: number; erro: string }[] = [];
  for (const f of (fila ?? []) as any[]) {
    if (!tempoOk(c, 6000) || !podeChamar(c)) break;
    const r = await tiny(c, `/notas/${f.tiny_id}/xml`);
    if (c.parou && !r.ok) break;
    if (!r.ok) { falhas.push({ chave: f.chave, tentativas: f.xml_tentativas + 1, erro: `Tiny ${r.status}: ${JSON.stringify(r.body ?? "").slice(0, 160)}` }); continue; }
    const xml = String(r.body?.xmlNfe ?? ""); const xmlCanc = String(r.body?.xmlCancelamento ?? "");
    const nota = xml ? notaDe(lerXml(xml)) : null;
    if (!nota) { falhas.push({ chave: f.chave, tentativas: f.xml_tentativas + 1, erro: xml ? "o XML não é uma NF-e" : "o Tiny não tem o XML desta nota" }); continue; }
    const mes = String(nota.data || f.dia).slice(0, 7);
    const caminho = `nfe/${mes}/${f.chave}.xml.gz`;
    const gz = await gzip(xml);
    const up = await c.db.storage.from(BUCKET).upload(caminho, gz, { contentType: "application/gzip", upsert: true });
    if (up.error) { falhas.push({ chave: f.chave, tentativas: f.xml_tentativas, erro: `arquivo: ${up.error.message}` }); continue; }
    let cancelada = false, canceladaEm: string | null = null, cancPath: string | null = null;
    if (xmlCanc.trim()) {
      const ev = eventosDe(lerXml(xmlCanc)).find((e: any) => e.tpEvento === "110111");
      if (ev) { cancelada = true; canceladaEm = ev.data || null; }
      cancPath = `nfe/${mes}/${f.chave}-canc.xml.gz`;
      const upc = await c.db.storage.from(BUCKET).upload(cancPath, await gzip(xmlCanc), { contentType: "application/gzip", upsert: true });
      if (upc.error) cancPath = null;
    }
    const dest = soDig(nota.dest_doc);
    notas.push({
      chave: f.chave, tp_nf: Number(nota.tpNF) || 0, fin_nfe: Number(nota.finNFe) || 0, nat_op: String(nota.natOp ?? "").slice(0, 120),
      dia: String(nota.data).slice(0, 10) || f.dia, data_emissao: nota.data || null,
      emit_doc: soDig(nota.emit_cnpj), emit_nome: String(nota.emit_nome ?? "").slice(0, 80), emit_uf: nota.emit_uf || null,
      dest_doc: dest.length === 14 ? dest : null, dest_uf: nota.dest_uf || null, ind_ie_dest: nota.indIEDest || null,
      v_prod: n2(nota.vProd), v_frete: n2(nota.vFrete), v_desc: n2(nota.vDesc), v_outro: n2(nota.vOutro), v_icms: n2(nota.vICMS), v_st: n2(nota.vST),
      v_ipi: n2(nota.vIPI), v_pis: n2(nota.vPIS), v_cofins: n2(nota.vCOFINS), v_difal: n2(nota.vICMSUFDest), v_fcp: n2(nota.vFCPUFDest), v_nf: n2(nota.vNF),
      c_stat: nota.cStat || null, ref_nfe: nota.refNFe?.length ? nota.refNFe : null,
      cancelada, cancelada_em: canceladaEm, xml_path: caminho, xml_bytes: gz.length, canc_path: cancPath,
      xml_em: new Date().toISOString(), xml_erro: null,
    });
    for (const i of nota.itens as any[]) itens.push({
      chave: f.chave, n: i.n, c_prod: String(i.cProd ?? "").slice(0, 60), x_prod: String(i.xProd ?? "").slice(0, 120), ncm: i.NCM || null, cfop: i.CFOP || null,
      u_com: i.uCom || null, q_com: Number(i.qCom) || 0, v_prod: n2(i.vProd), v_desc: n2(i.vDesc), v_frete: n2(i.vFrete), v_outro: n2(i.vOutro),
      orig: i.orig || null, cst_icms: i.cstICMS || null, p_icms: Number(i.pICMS) || 0, v_bc: n2(i.vBC), v_icms: n2(i.vICMS), v_st: n2(i.vST),
      v_difal: n2(i.vICMSUFDest), v_fcp: n2(i.vFCPUFDest), cst_pis: i.cstPIS || null, v_pis: n2(i.vPIS), cst_cofins: i.cstCOFINS || null, v_cofins: n2(i.vCOFINS), v_ipi: n2(i.vIPI),
    });
  }
  let erroBanco: string | null = null; let baixados = 0;
  if (notas.length) {
    // um UPDATE por nota (são ≤ 30): o upsert em lote exigiria reenviar as colunas da lista
    const chaves = notas.map((n) => n.chave);
    const del = await c.db.from("fiscal_nfe_item").delete().in("chave", chaves);
    if (del.error) erroBanco = del.error.message;
    if (!erroBanco && itens.length) { const ins = await c.db.from("fiscal_nfe_item").insert(itens); if (ins.error) erroBanco = ins.error.message; }
    if (!erroBanco) {
      const rs = await Promise.all(notas.map(({ chave, ...resto }) => c.db.from("fiscal_nfe").update(resto).eq("chave", chave)));
      baixados = rs.filter((r) => !r.error).length;
      const ruim = rs.find((r) => r.error); if (ruim) erroBanco = ruim.error.message;
    }
  }
  for (const f of falhas) await c.db.from("fiscal_nfe").update({ xml_tentativas: f.tentativas, xml_erro: f.erro }).eq("chave", f.chave);
  return { baixados, falhas: falhas.length, erro: erroBanco ? `banco: ${erroBanco}` : null, exemplos_falha: falhas.slice(0, 3) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "status";
  const db = createClient(SUPABASE_URL, SRK);
  try {
    if (modulo === "status") {
      // tem valores fiscais: só sessão de usuário ou service role (a chave pública do site não lê)
      const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      let role = ""; try { role = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role || ""; } catch { role = ""; }
      if (bearer !== SRK && role !== "authenticated" && role !== "service_role") return json({ erro: "faça login no app" }, 401);
      const { data, error } = await db.rpc("fiscal_nfe_resumo");
      if (error) return json({ erro: error.message }, 500);
      return json({ modulo, ...data });
    }
    if (modulo !== "rodar") return json({ erro: "modulo desconhecido (status | rodar)" }, 400);

    const token = await lerToken(db);
    if (!token) return json({ erro: "não consegui ler o token do Tiny" }, 503);
    const c: Ctx = {
      db, token, inicio: Date.now(), orcamento: 40000, chamadas: 0, restante: null, parou: null,
      folga: Math.max(5, Number(url.searchParams.get("folga") || 15)),
    };
    const max = Math.min(60, Math.max(1, Number(url.searchParams.get("max") || 30)));
    const piso = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("piso") || "") ? url.searchParams.get("piso")! : "2024-11-19";
    const listarDias = Math.min(20, Math.max(0, Number(url.searchParams.get("listar_dias") ?? 6)));
    const hoje = hojeBRT();
    const feito: Record<string, unknown> = {};

    // 1) os 3 últimos dias, 1× a cada ~20 h
    const recentes = [0, -1, -2].map((n) => maisDias(hoje, n));
    const { data: jaLidos } = await db.from("fiscal_nfe_dia").select("tipo, dia, listado_em").eq("conta", CONTA).in("dia", recentes).in("tipo", ["S", "E"]);
    const lidoEm = new Map(((jaLidos ?? []) as any[]).map((d) => [`${d.tipo}|${d.dia}`, Date.parse(d.listado_em)]));
    const relidos: string[] = [];
    for (const dia of recentes) for (const tipo of ["S", "E"]) {
      if (!tempoOk(c, 12000) || !podeChamar(c)) break;
      if (Date.now() - (lidoEm.get(`${tipo}|${dia}`) ?? 0) < 20 * 3600e3) continue;
      const r = await listarDia(c, tipo, dia);
      if (r.completo) relidos.push(`${tipo} ${dia}: ${r.comChave}`);
    }
    feito.dias_recentes = relidos;

    // 2) canceladas dos últimos 60 dias, 1×/dia (marcador: tipo 'C' no dia de hoje)
    const { data: marc } = await db.from("fiscal_nfe_dia").select("dia").eq("conta", CONTA).eq("tipo", "C").eq("dia", hoje).maybeSingle();
    if (!marc && tempoOk(c, 15000) && podeChamar(c)) {
      let ok = true; let voltaram = 0; let vistas = 0;
      for (const [de, ate] of [[maisDias(hoje, -30), hoje], [maisDias(hoje, -60), maisDias(hoje, -31)]]) for (const tipo of ["S", "E"]) {
        const r = await listar(c, tipo, de, ate, "&situacao=3");
        if (!r.completo) { ok = false; break; }
        voltaram += r.voltaram; vistas += r.comChave;
      }
      if (ok) await db.from("fiscal_nfe_dia").upsert({ conta: CONTA, tipo: "C", dia: hoje, total_api: vistas, com_chave: voltaram, listado_em: new Date().toISOString() }, { onConflict: "conta,tipo,dia" });
      feito.canceladas = { completo: ok, vistas, voltaram_para_a_fila: voltaram };
    }

    // 3) carga para trás: só lista dia antigo quando a fila de XML está curta
    const { count: pendAntes } = await db.from("fiscal_nfe").select("chave", { count: "exact", head: true }).is("xml_em", null).lt("xml_tentativas", 4);
    const listados: string[] = [];
    if ((pendAntes ?? 0) < max * 4 && listarDias > 0) {
      const { data: dias } = await db.rpc("fiscal_nfe_dias_a_listar", { p_piso: piso, p_n: listarDias });
      for (const d of (dias ?? []) as any[]) {
        if (!tempoOk(c, 14000) || !podeChamar(c)) break;
        const r = await listarDia(c, d.tipo, d.dia);
        if (r.completo) listados.push(`${d.tipo} ${d.dia}: ${r.comChave} de ${r.total}`); else if (r.foraDoPlano) listados.push(`${d.tipo} ${d.dia}: fora do período do plano`); else break;
      }
    }
    feito.dias_antigos = listados;

    // 4) XML das pendentes
    const b = await baixar(c, max);
    const { count: pendentes } = await db.from("fiscal_nfe").select("chave", { count: "exact", head: true }).is("xml_em", null).lt("xml_tentativas", 4);
    return json({ modulo, ...feito, xml: b, pendentes: pendentes ?? null, chamadas_tiny: c.chamadas, restante_no_minuto: c.restante, parou: c.parou, ms: Date.now() - c.inicio });
  } catch (e) {
    return json({ erro: (e as Error).message, onde: String((e as Error).stack ?? "").split(/\n/).slice(1, 3).map((s) => s.trim()) }, 500);
  }
});
