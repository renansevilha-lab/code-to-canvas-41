// ============================================================================
// devolucao-auto v6 (18/out/2026) — motor de NF de DEVOLUCAO automatica.
// v5: bloqueio da API v2 do Tiny (cod 6) vira COOLDOWN GLOBAL de 10 min — a
//   rodada inteira espera (antes so o pedido esperava e a rodada seguinte batia
//   na v2 com outro pedido, o que reinicia o bloqueio).
// v4: &orcamento=<seg> (default 22, teto 50) e max ate 10 — modo acelerado para
//   drenar backlog (~6 s por pedido). UM agendador so: dois motores ao mesmo
//   tempo podem pegar o mesmo pedido.
// v3: cancelado sem pedido na SVL apos 4 tentativas (~2 dias) = nunca faturado
//   -> sem_nf_venda (final); reembolso (pedido entregue teve NF) -> revisar.
// v2: espelhar NUNCA apaga chave ja conhecida (nota criada pela API v2 vem sem
//   observacoes; a v1 gravava null por cima) e busca a chave do clone em
//   devolucao_clonadas.refnfe quando o detalhe nao traz.
// Fase 1: conta SVL (Bumi Shopee + [SVLL] Mercado Livre). Decisao do dono:
//   cancelado com NF autorizada, falha de entrega, extravio, reembolso com
//   produto e reembolso so em dinheiro (Shopee ACCEPTED, na aprovacao).
// O motor CRIA a devolucao (Pendente) no Tiny SVL, chamando
// nf-devolucao?modulo=criar (guards, bridge, itens parciais, anti-duplicata).
// v6 (18/out/2026, decisao do dono — opcao B): o motor tambem EMITE. Antes a emissao
//   era so no clique da equipe e, de 01/10 a 18/10, 456 notas criadas ficaram
//   Pendentes (R$ 36 mil). ?modulo=emitir [&max=3][&dry=1]: as notas que o MOTOR criou
//   (devolucao_auto.estado = criada), ainda Pendentes no espelho, a mais ANTIGA primeiro,
//   pelo MESMO caminho do botao (nf-devolucao?modulo=emitir). 4 s entre uma e outra.
//   SEFAZ 656 (consumo indevido) = para a rodada e espera 60 min (insistir prolonga o
//   bloqueio) + aviso no Discord. Recusa da SEFAZ = a nota espera 12 h antes de nova
//   tentativa (avisa so na 1a vez). Nota com mais de 29 dias nao e emitida (a SEFAZ
//   recusa) — fica para o clone com data nova (aviso). Cada tentativa fica em
//   debug_fulfillment (modulo 'devolucao-auto-emitir', etapa = id da nota).
//
//  ?modulo=espelhar [&dias=15][&max_det=40]
//      lista as devolucoes (tipo E, serie 12) do Tiny SVL -> devolucoes_svl_base
//      e le a chave da venda referenciada (observacoes do detalhe) das que
//      ainda nao foram lidas. Sem isso o anti-duplicata nao enxerga as notas
//      que a equipe cria na mao.
//  ?modulo=processar [&max=3][&orcamento=22][&dry=1]
//      espelha o recente; se ainda ha nota do periodo sem chave lida, SO
//      enriquece (aguardando_espelho). Senao pega a fila
//      (view_devolucao_auto_candidatos_svl) e cria ate `max` devolucoes.
//      dry=1: chama o criar em simulacao e nao grava estado.
//  ?modulo=status  -> contagem por estado/caso
//  ?modulo=emitir [&max=3][&dry=1] -> emite as notas criadas pelo motor (v6)
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_HOST = "https://api.tiny.com.br/public-api/v3";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SERIE_DEVOLUCAO_SVL = "12";
// devolucao de pedido desde 01/ago so pode ter sido criada a partir de 01/ago
const INICIO_ESPELHO = "2026-08-01";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function fixEnc(s: string | null | undefined): string {
  if (!s) return "";
  const str = String(s);
  if (!/[Â-Ã]/.test(str)) return str;
  try {
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    const dec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return dec.length <= str.length ? dec : str;
  } catch { return str; }
}

function extrairChaveReferenciada(observacoes: string | null | undefined): string | null {
  if (!observacoes) return null;
  const m = String(observacoes).match(/referenciada:\s*([0-9]{44})/i) || String(observacoes).match(/([0-9]{44})/);
  return m ? m[1] : null;
}

async function tinyFetch(token: string, path: string): Promise<any> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const resp = await fetch(`${TINY_API_HOST}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (resp.ok) return await resp.json().catch(() => ({}));
    if (resp.status === 404) return null;
    if (resp.status === 429 || resp.status >= 500) { await sleep(Math.min(2000 * 2 ** attempt, 12000)); continue; }
    const t = await resp.text();
    throw new Error(`Tiny ${resp.status} em ${path}: ${t.substring(0, 160)}`);
  }
  throw new Error(`retries em ${path}`);
}

type SB = ReturnType<typeof createClient>;

/** Espelha as devolucoes da SVL e le as chaves referenciadas que faltam. */
async function espelhar(supabase: SB, token: string, dias: number, maxDet: number, orcamentoMs: number) {
  const inicio = Date.now();
  const dataInicial = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
  const dataFinal = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const linhas: any[] = [];
  let offset = 0, total = Infinity, paginas = 0;
  while (offset < total && paginas < 10 && Date.now() - inicio < orcamentoMs / 2) {
    const lista = await tinyFetch(token, `/notas?tipo=E&dataInicial=${dataInicial}&dataFinal=${dataFinal}&limit=100&offset=${offset}`);
    paginas++;
    const itens = lista?.itens || [];
    total = lista?.paginacao?.total ?? itens.length;
    for (const n of itens) {
      if (String(n.serie) !== SERIE_DEVOLUCAO_SVL) continue;
      const sit = String(n.situacao);
      linhas.push({
        id_nota: n.id, numero: n.numero, serie: n.serie,
        valor: n.valor != null ? Number(n.valor) : null,
        cliente_nome: fixEnc(n.cliente?.nome) || null,
        data_emissao: (n.dataEmissao && n.dataEmissao !== "0000-00-00") ? n.dataEmissao : null,
        situacao: sit, autorizada: sit === "6" || sit === "7",
        atualizado_em: new Date().toISOString(), verificado_em: new Date().toISOString(),
      });
    }
    offset += 100;
    if (itens.length < 100) break;
    await sleep(250);
  }
  // upsert sem tocar chave_referenciada / chave_lida_em (colunas ausentes)
  for (let i = 0; i < linhas.length; i += 200) {
    const { error } = await supabase.from("devolucoes_svl_base").upsert(linhas.slice(i, i + 200), { onConflict: "id_nota" });
    if (error) throw new Error(`upsert base: ${error.message}`);
  }

  // chaves: mais recentes primeiro (sao as que podem colidir com a fila)
  const { data: semChave, error: eSel } = await supabase.from("devolucoes_svl_base")
    .select("id_nota").is("chave_lida_em", null).gte("data_emissao", INICIO_ESPELHO)
    .order("data_emissao", { ascending: false }).limit(maxDet);
  if (eSel) throw new Error(`select base: ${eSel.message}`);
  let lidas = 0, comChave = 0;
  for (const r of (semChave || []) as any[]) {
    if (Date.now() - inicio > orcamentoMs) break;
    const det = await tinyFetch(token, `/notas/${r.id_nota}`);
    let chave = extrairChaveReferenciada(det?.observacoes);
    if (!chave) {
      // nota criada pela API v2 (clone) nao tem observacoes: a chave esta no registro do clone
      const { data: dc } = await supabase.from("devolucao_clonadas").select("refnfe")
        .eq("id_novo", r.id_nota).not("refnfe", "is", null).limit(1);
      chave = (dc as any[] | null)?.[0]?.refnfe ?? null;
    }
    await supabase.from("devolucoes_svl_base").update({
      chave_lida_em: new Date().toISOString(), ...(chave ? { chave_referenciada: chave } : {}),
    }).eq("id_nota", r.id_nota);
    lidas++; if (chave) comChave++;
    await sleep(250);
  }
  const { count: faltam } = await supabase.from("devolucoes_svl_base")
    .select("id_nota", { count: "exact", head: true }).is("chave_lida_em", null).gte("data_emissao", INICIO_ESPELHO);
  return { listadas: linhas.length, paginas, chaves_lidas: lidas, com_chave: comChave, faltam_ler: faltam ?? null, tempo_ms: Date.now() - inicio };
}

// ---------------------------------------------------------------- v6: emissao automatica
const LOG_EMISSAO = "devolucao-auto-emitir";
const IDADE_MAX_DIAS = 29; // a SEFAZ recusa a emissao direta de nota com mais de ~30 dias

async function avisarDiscord(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/discord-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
      body: JSON.stringify({ canal: "devolucoes", rodape: "devolucao-auto · emitir", ...payload }),
    });
  } catch { /* melhor-esforco */ }
}

/** Emite ate `max` notas que o motor criou e seguem Pendentes, a mais antiga primeiro. */
async function emitirPendentes(supabase: SB, max: number, dry: boolean) {
  const inicio = Date.now();
  const agora = Date.now();
  // 1) SEFAZ 656 na ultima hora: nao toca em nada
  const { data: bloq } = await supabase.from("debug_fulfillment").select("criado_em")
    .eq("modulo", LOG_EMISSAO).eq("status_http", 429)
    .gt("criado_em", new Date(agora - 60 * 60000).toISOString()).limit(1);
  if ((bloq || []).length) return { pausado_656: true, desde: (bloq as any[])[0].criado_em, aviso: "SEFAZ bloqueou (656) ha menos de 1 h — rodada pulada" };

  // 2) notas criadas pelo motor
  const ids: number[] = [];
  for (let de = 0; de < 5000; de += 1000) {
    const { data, error } = await supabase.from("devolucao_auto").select("id_nota_devolucao")
      .eq("conta", "svl").eq("estado", "criada").not("id_nota_devolucao", "is", null).range(de, de + 999);
    if (error) throw new Error(`devolucao_auto: ${error.message}`);
    for (const r of (data || []) as any[]) ids.push(Number(r.id_nota_devolucao));
    if ((data || []).length < 1000) break;
  }
  // 3) as que seguem Pendentes no espelho
  const pend: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("devolucoes_svl_base")
      .select("id_nota, numero, serie, valor, data_emissao, cliente_nome").in("id_nota", ids.slice(i, i + 200)).eq("situacao", "1");
    if (error) throw new Error(`espelho: ${error.message}`);
    pend.push(...((data || []) as any[]));
  }
  // 4) recusadas nas ultimas 12 h esperam; "ainda processando" (202) espera 1 h — nao reenviar
  //    nota que a SEFAZ ainda esta julgando
  const { data: recusas } = await supabase.from("debug_fulfillment").select("etapa, status_http, criado_em")
    .eq("modulo", LOG_EMISSAO).in("status_http", [409, 202]).gt("criado_em", new Date(agora - 12 * 3600000).toISOString());
  const esperando = new Set(((recusas || []) as any[])
    .filter((r) => r.status_http === 409 || Date.parse(r.criado_em) > agora - 3600000).map((r) => String(r.etapa)));
  const hoje = new Date(agora - 3 * 3600000).toISOString().slice(0, 10); // dia em Brasilia
  const limite = new Date(new Date(`${hoje}T00:00:00Z`).getTime() - IDADE_MAX_DIAS * 86400000).toISOString().slice(0, 10);
  const velhas = pend.filter((p) => p.data_emissao && p.data_emissao < limite);
  const fila = pend.filter((p) => !esperando.has(String(p.id_nota)) && !(p.data_emissao && p.data_emissao < limite))
    .sort((a, b) => String(a.data_emissao ?? "").localeCompare(String(b.data_emissao ?? "")) || Number(a.id_nota) - Number(b.id_nota));
  const resumo = { pendentes: pend.length, na_fila: fila.length, esperando_12h: pend.length - fila.length - velhas.length, velhas_para_clonar: velhas.length };
  if (dry) return { dry: true, ...resumo, proximas: fila.slice(0, max).map((p) => ({ id_nota: p.id_nota, numero: p.numero, data: p.data_emissao, valor: p.valor })) };

  // 5) emite pelo mesmo caminho do botao da tela
  const feitas: any[] = [];
  let parou656 = false;
  for (const p of fila.slice(0, max)) {
    if (Date.now() - inicio > 40000) break;
    let d: any = null; let http = 0;
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/nf-devolucao`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}`, apikey: SRK },
        body: JSON.stringify({ modulo: "emitir", conta: "svl", id_nota: p.id_nota, confirmar: "1" }),
        signal: AbortSignal.timeout(45000),
      });
      http = resp.status;
      const txt = await resp.text();
      try { d = JSON.parse(txt); } catch { d = { erro: `${resp.status}: ${txt.slice(0, 200)}` }; }
    } catch (e) {
      d = { erro: (e as Error).message };
    }
    const autorizada = d?.autorizada === true;
    const consumo = d?.consumo_indevido === true;
    const status = autorizada ? 200 : consumo ? 429 : (d?.situacao && String(d.situacao) !== "1") || d?.erro || d?.motivo ? 409 : 202;
    await supabase.from("debug_fulfillment").insert({
      modulo: LOG_EMISSAO, etapa: String(p.id_nota), status_http: status,
      resultado: { numero: p.numero, serie: p.serie, valor: p.valor, data_emissao: p.data_emissao, http, resposta: d },
    });
    if (autorizada) {
      await supabase.from("devolucoes_svl_base").update({
        situacao: String(d.situacao ?? "6"), autorizada: true, chave_devolucao: d.chave_devolucao ?? null,
        emitida_via_app: true, atualizado_em: new Date().toISOString(),
      }).eq("id_nota", p.id_nota);
    } else if (consumo) {
      parou656 = true;
    } else if (status === 409 && !esperando.has(String(p.id_nota))) {
      const { count } = await supabase.from("debug_fulfillment").select("id", { count: "exact", head: true })
        .eq("modulo", LOG_EMISSAO).eq("etapa", String(p.id_nota)).eq("status_http", 409);
      if ((count ?? 0) <= 1) {
        await avisarDiscord({ nivel: "aviso", titulo: `NF de devolução SVL ${p.numero}/${p.serie} não autorizou`,
          descricao: `Valor R$ ${Number(p.valor ?? 0).toFixed(2)} · ${fixEnc(p.cliente_nome) || "—"}\n${String(d?.motivo || d?.erro || `situação ${d?.situacao ?? "?"}`).slice(0, 400)}\nNova tentativa em 12 h — conferir no Tiny SVL.` });
      }
    }
    feitas.push({ id_nota: p.id_nota, numero: p.numero, autorizada, consumo_indevido: consumo, situacao: d?.situacao ?? null, motivo: d?.motivo ?? d?.erro ?? null });
    if (parou656) break;
    await sleep(4000);
  }
  if (parou656) {
    await avisarDiscord({ nivel: "erro", titulo: "SEFAZ bloqueou a emissão das devoluções SVL (656 · Consumo Indevido)",
      descricao: `O robô pausou por 1 h e volta sozinho. Autorizadas nesta rodada: ${feitas.filter((f) => f.autorizada).length}. Pendentes: ${fila.length}.` });
  }
  if (velhas.length && new Date(agora).getUTCHours() === 12 && new Date(agora).getUTCMinutes() < 15) {
    await avisarDiscord({ nivel: "aviso", titulo: `${velhas.length} devolução(ões) SVL com mais de ${IDADE_MAX_DIAS} dias sem emitir`,
      descricao: "A SEFAZ recusa a emissão direta: refazer com data de hoje (clonar) na aba SVL de /devolucoes." });
  }
  return { ...resumo, emitidas: feitas.filter((f) => f.autorizada).length, pausado_656: parou656, feitas, tempo_ms: Date.now() - inicio };
}

/** Traduz a resposta do nf-devolucao?modulo=criar em estado do motor. */
function estadoDe(r: any, tentativas: number, caso: string): { estado: string; reagendarMin?: number; parar?: boolean } {
  const c = r?.codigo;
  if (c === "criada" && r?.ok) return { estado: "criada" };
  if (c === "ja_existe") return { estado: "ja_existe" };
  if (c === "sem_nf_venda") return { estado: "sem_nf_venda" };
  if (c === "venda_nao_autorizada") return { estado: "venda_nao_autorizada" };
  if (c === "nao_cancelado") return { estado: "nao_cancelado" };
  if (c === "revisar_itens" || c === "itens_sem_ncm" || c === "sem_chave" || c === "sem_itens" || c === "sem_ordem") return { estado: "revisar" };
  if (c === "v2_bloqueada") return { estado: "pendente", reagendarMin: 10, parar: true };
  if (c === "sem_pedido_svl") {
    // pode nao ter sido faturado ainda na SVL: tenta de novo por ~2 dias
    if (tentativas < 4) return { estado: "sem_pedido_svl", reagendarMin: 12 * 60 };
    return caso.startsWith("reembolso") ? { estado: "revisar" } : { estado: "sem_nf_venda" };
  }
  return tentativas >= 5 ? { estado: "revisar" } : { estado: "erro", reagendarMin: 30 * Math.max(1, tentativas) };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SRK) return json({ erro: "secrets ausentes" }, 500);
  const supabase = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "status";
  const conta = "svl";

  if (modulo === "status") {
    const { data, error } = await supabase.from("devolucao_auto").select("estado, caso").eq("conta", conta);
    if (error) return json({ erro: error.message }, 500);
    const por: Record<string, Record<string, number>> = {};
    for (const r of (data || []) as any[]) {
      por[r.estado] = por[r.estado] || {};
      por[r.estado][r.caso] = (por[r.estado][r.caso] || 0) + 1;
    }
    const { count: fila } = await supabase.from("view_devolucao_auto_candidatos_svl").select("order_sn", { count: "exact", head: true });
    const { count: faltam } = await supabase.from("devolucoes_svl_base")
      .select("id_nota", { count: "exact", head: true }).is("chave_lida_em", null).gte("data_emissao", INICIO_ESPELHO);
    return json({ modulo, conta, fila: fila ?? null, espelho_faltam_ler: faltam ?? null, por_estado: por });
  }

  if (modulo === "emitir") {
    try {
      const max = Math.min(Math.max(parseInt(url.searchParams.get("max") || "3", 10), 1), 6);
      return json({ modulo, conta, ...(await emitirPendentes(supabase, max, url.searchParams.get("dry") === "1")) });
    } catch (e) {
      return json({ erro: (e as Error).message }, 500);
    }
  }

  const { data: tk } = await supabase.from("oauth_tokens_tiny").select("access_token").eq("conta", conta).limit(1).single();
  const token = tk?.access_token as string | undefined;
  if (!token) return json({ erro: "token Tiny svl ausente" }, 401);

  try {
    if (modulo === "espelhar") {
      const dias = Math.min(parseInt(url.searchParams.get("dias") || "15", 10), 120);
      const maxDet = Math.min(parseInt(url.searchParams.get("max_det") || "40", 10), 120);
      return json({ modulo, conta, ...(await espelhar(supabase, token, dias, maxDet, 25000)) });
    }

    if (modulo === "processar") {
      const inicio = Date.now();
      const dry = url.searchParams.get("dry") === "1";
      const max = Math.min(Math.max(parseInt(url.searchParams.get("max") || "3", 10), 1), 10);
      const orcamentoMs = Math.min(Math.max(parseInt(url.searchParams.get("orcamento") || "22", 10), 5), 50) * 1000;

      // 1) espelho recente + chaves que faltam
      const esp = await espelhar(supabase, token, 4, 20, 10000);
      if ((esp.faltam_ler ?? 1) > 0) {
        return json({ modulo, conta, aguardando_espelho: true, espelho: esp,
          aviso: "ainda ha devolucoes da SVL sem a chave da venda lida — nao crio nada ate o espelho completar (anti-duplicata)" });
      }

      // 1b) v2 do Tiny em cooldown (cod 6): nao toca em nada ate passar
      if (!dry) {
        const { data: bloq } = await supabase.from("devolucao_auto").select("order_sn, proxima_em")
          .eq("conta", conta).eq("estado", "pendente").gt("proxima_em", new Date().toISOString()).limit(1);
        if ((bloq || []).length) {
          return json({ modulo, conta, cooldown_v2: true, ate: (bloq as any[])[0].proxima_em,
            aviso: "API v2 do Tiny bloqueada recentemente (cod 6) — rodada pulada para nao reiniciar o bloqueio" });
        }
      }

      // 2) rodada anterior que morreu no meio: nao retenta, manda para revisao humana
      const dezMin = new Date(Date.now() - 10 * 60000).toISOString();
      await supabase.from("devolucao_auto").update({ estado: "revisar", detalhe: "rodada interrompida durante a criacao — conferir no Tiny SVL se a nota foi criada", atualizado_em: new Date().toISOString() })
        .eq("conta", conta).eq("estado", "criando").lt("atualizado_em", dezMin);

      // 3) fila
      const { data: fila, error: eFila } = await supabase.from("view_devolucao_auto_candidatos_svl")
        .select("order_sn, tiny_pedido_id, canal, caso, tentativas").order("data_pedido", { ascending: true }).limit(max);
      if (eFila) return json({ erro: `fila: ${eFila.message}` }, 500);

      const resultados: any[] = [];
      for (const f of (fila || []) as any[]) {
        if (Date.now() - inicio > orcamentoMs) break;
        const tent = (f.tentativas || 0) + 1;
        const agora = new Date().toISOString();
        if (!dry) {
          const { error: eIns } = await supabase.from("devolucao_auto").upsert({
            conta, order_sn: f.order_sn, tiny_pedido_id: f.tiny_pedido_id, canal: f.canal, caso: f.caso,
            estado: "criando", tentativas: tent, atualizado_em: agora,
          }, { onConflict: "conta,order_sn" });
          if (eIns) { resultados.push({ order_sn: f.order_sn, erro: eIns.message }); continue; }
        }
        const qs = new URLSearchParams({ modulo: "criar", conta, tiny_pedido_id: String(f.tiny_pedido_id), serie: SERIE_DEVOLUCAO_SVL });
        if (!dry) qs.set("confirmar", "1");
        let r: any = null;
        try {
          const resp = await fetch(`${SUPABASE_URL}/functions/v1/nf-devolucao?${qs}`, {
            headers: { Authorization: `Bearer ${SRK}`, apikey: SRK },
            signal: AbortSignal.timeout(45000),
          });
          const txt = await resp.text();
          try { r = JSON.parse(txt); } catch { r = { codigo: "erro_http", erro: `${resp.status}: ${txt.substring(0, 200)}` }; }
        } catch (e) {
          r = { codigo: "erro_http", erro: (e as Error).message };
        }
        const res = {
          order_sn: f.order_sn, caso: f.caso, codigo: r?.codigo ?? null, ok: r?.ok ?? null, dry: r?.dry ?? false,
          guard: r?.guard ?? null, itens_parcial: r?.itens_parcial ?? null, nota_venda: r?.nota_venda_numero ?? null,
          registro: r?.registro ?? null, existente: r?.existente ?? null, erro: r?.erro ?? null,
          itens: dry ? (r?.payload?.nota_fiscal?.itens || []).map((x: any) => `${x.item.codigo} x${x.item.quantidade}`) : undefined,
        };
        resultados.push(res);
        if (dry) continue;

        const st = estadoDe(r, tent, f.caso);
        const upd: Record<string, unknown> = {
          estado: st.estado,
          chave_venda: r?.chave_referenciada ?? null,
          detalhe: (r?.erro || r?.guard || null)?.toString().slice(0, 500) ?? null,
          itens_parcial: r?.itens_parcial ?? null,
          proxima_em: st.reagendarMin ? new Date(Date.now() + st.reagendarMin * 60000).toISOString() : null,
          atualizado_em: new Date().toISOString(),
        };
        if (st.estado === "criada") {
          upd.id_nota_devolucao = r?.registro?.id ? Number(r.registro.id) : null;
          upd.numero_nota = r?.registro?.numero ?? null;
        } else if (st.estado === "ja_existe") {
          upd.id_nota_devolucao = r?.existente?.id_nota ? Number(r.existente.id_nota) : null;
          upd.numero_nota = r?.existente?.numero ?? null;
        }
        if (st.parar) upd.tentativas = tent - 1; // bloqueio da v2 nao conta tentativa
        await supabase.from("devolucao_auto").update(upd).eq("conta", conta).eq("order_sn", f.order_sn);
        if (st.parar) break;
        await sleep(1500); // v2 do Tiny: 60 req/min nesta conta
      }
      return json({ modulo, conta, dry, espelho: esp, processados: resultados.length, resultados, tempo_ms: Date.now() - inicio });
    }

    return json({ erro: `modulo ${modulo} desconhecido`, modulos: ["status", "espelhar", "processar"] }, 400);
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
