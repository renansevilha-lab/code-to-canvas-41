// ============================================================================
// Edge Function: tiny-vendas-historico v1 (29/out/2026)
// ----------------------------------------------------------------------------
// Pedido do dono: povoar os meses antigos com as vendas do Tiny, só os TOTAIS.
// Lê a LISTAGEM do Tiny (GET /pedidos?dataInicial=D&dataFinal=D, 100 por página —
// valor, situação, canal e data já vêm nela) dia a dia e grava a soma por
// conta × dia × canal × situação em `tiny_vendas_dia`. Nenhum dado de cliente.
//
//   ?modulo=status                      → quantos dias lidos/faltando por conta
//   ?modulo=rodar[&conta=ottz|svl]      → lê os próximos dias pendentes (~22 s)
//        [&de=YYYY-MM-DD&ate=YYYY-MM-DD] → só esse intervalo (refaz mesmo lidos)
//
// Ordem: primeiro os dias nunca lidos, do MAIS ANTIGO para o mais novo (a janela do
// plano da SVL anda um dia por dia — o mais antigo some primeiro); depois relê os
// últimos 15 dias se a leitura tem mais de 20 h (cancelamento/entrega mudam a situação).
// Um dia só é gravado quando TODAS as páginas vieram (senão fica para a próxima).
// "fora do período permitido pelo plano" → o dia é marcado e não volta.
// Só LÊ no Tiny. Token SEMPRE pela conta (nunca "o mais recente").
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TINY = "https://api.tiny.com.br/public-api/v3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORCAMENTO_MS = 22_000;
const PAUSA_MS = 700;                     // ~1,4 chamada/s, para não disputar com a separação
const INICIO = "2024-10-01";              // antes disso nenhuma das contas tem pedido
const RELER_DIAS = 15;
const RELER_APOS_H = 20;
const CONTAS = ["svl", "ottz"] as const;
type Conta = typeof CONTAS[number];

const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;

async function token(conta: Conta): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.from("oauth_tokens_tiny").select("access_token, expires_at").eq("conta", conta).limit(1).maybeSingle();
    if (error) { await sleep(800); continue; }
    if (!data) throw new Error(`token do Tiny (conta ${conta}) não encontrado`);
    if (new Date(data.expires_at as string) < new Date()) throw new Error(`token do Tiny (conta ${conta}) vencido`);
    return String(data.access_token);
  }
  throw new Error("não consegui ler o token do Tiny (banco ocupado)");
}

async function pagina(tk: string, dia: string, offset: number): Promise<{ ok: true; total: number; itens: any[] } | { ok: false; fora: boolean; erro: string }> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${TINY}/pedidos?dataInicial=${dia}&dataFinal=${dia}&limit=100&offset=${offset}`, { headers: { Authorization: `Bearer ${tk}`, Accept: "application/json" } });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { mensagem: txt.slice(0, 200) }; }
    await sleep(PAUSA_MS);
    if (r.ok && body && Array.isArray(body.itens)) return { ok: true, total: Number(body.paginacao?.total ?? 0), itens: body.itens };
    const msg = String(body?.mensagem ?? `HTTP ${r.status}`);
    if (/fora do per[ií]odo permitido/i.test(msg)) return { ok: false, fora: true, erro: msg };
    if ((r.status === 429 || /muito tempo|tente novamente/i.test(msg)) && i < 3) { await sleep(2500 * (i + 1)); continue; }
    return { ok: false, fora: false, erro: msg.slice(0, 300) };
  }
  return { ok: false, fora: false, erro: "o Tiny pediu para esperar (limite de chamadas)" };
}

/** Lê um dia inteiro; devolve null se o tempo acabou antes da última página. */
async function lerDia(conta: Conta, tk: string, dia: string, prazo: number) {
  const grupos = new Map<string, { canal: string; situacao: number; pedidos: number; valor: number; sem_valor: number }>();
  let offset = 0, total = 0, lidos = 0;
  for (;;) {
    if (Date.now() > prazo) return null;
    const p = await pagina(tk, dia, offset);
    if (!p.ok) return { erro: p.erro, fora: p.fora };
    total = p.total;
    for (const it of p.itens) {
      const canal = String(it?.ecommerce?.nome ?? "").trim();
      const situacao = Number(it?.situacao ?? -1);
      const v = String(it?.valor ?? "").trim();
      const k = `${canal}\u0001${situacao}`;
      const g = grupos.get(k) ?? { canal, situacao, pedidos: 0, valor: 0, sem_valor: 0 };
      g.pedidos++;
      if (v === "" || !Number.isFinite(Number(v))) g.sem_valor++; else g.valor += Number(v);
      grupos.set(k, g);
      lidos++;
    }
    offset += 100;
    if (p.itens.length < 100 || offset >= total) break;
  }
  const linhas = [...grupos.values()].map((g) => ({ conta, dia, canal: g.canal, situacao: g.situacao, pedidos: g.pedidos, valor: Math.round(g.valor * 100) / 100, sem_valor: g.sem_valor, atualizado_em: new Date().toISOString() }));
  const del = await db.from("tiny_vendas_dia").delete().eq("conta", conta).eq("dia", dia);
  if (del.error) return { erro: `banco: ${del.error.message}`, fora: false };
  if (linhas.length) {
    const ins = await db.from("tiny_vendas_dia").insert(linhas);
    if (ins.error) return { erro: `banco: ${ins.error.message}`, fora: false };
  }
  return { total, lidos, grupos: linhas.length };
}

async function pendentes(conta: Conta, de?: string, ate?: string): Promise<string[]> {
  const ontem = somaDias(hojeBRT(), -1);
  if (de && ate) { const out: string[] = []; for (let d = de; d <= ate && out.length < 400; d = somaDias(d, 1)) out.push(d); return out; }
  const est = new Map<string, any>();
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("tiny_vendas_dia_estado").select("dia, concluido_em, fora_do_plano, tentativas").eq("conta", conta).range(off, off + 999);
    if (error) throw new Error(`banco: ${error.message}`);
    for (const r of data ?? []) est.set(String(r.dia), r);
    if (!data || data.length < 1000) break;
  }
  const nunca: string[] = [], reler: string[] = [];
  const limiteReler = somaDias(ontem, -RELER_DIAS);
  for (let d = INICIO; d <= ontem; d = somaDias(d, 1)) {
    const e = est.get(d);
    if (e?.fora_do_plano) continue;
    if (!e?.concluido_em) { if ((e?.tentativas ?? 0) < 6) nunca.push(d); continue; }
    if (d > limiteReler && Date.now() - Date.parse(e.concluido_em) > RELER_APOS_H * 3600_000) reler.push(d);
  }
  return [...nunca, ...reler];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const modulo = u.searchParams.get("modulo") ?? "status";
  try {
    if (modulo === "status") {
      const out: Record<string, unknown> = {};
      for (const c of CONTAS) {
        const { data } = await db.from("tiny_vendas_dia_estado").select("dia, concluido_em, fora_do_plano, erro").eq("conta", c).order("dia").limit(1000);
        const lidos = (data ?? []).filter((r) => r.concluido_em);
        out[c] = {
          dias_lidos: lidos.length,
          fora_do_plano: (data ?? []).filter((r) => r.fora_do_plano).length,
          com_erro: (data ?? []).filter((r) => !r.concluido_em && r.erro && !r.fora_do_plano).map((r) => ({ dia: r.dia, erro: r.erro })).slice(0, 10),
          primeiro_lido: lidos[0]?.dia ?? null, ultimo_lido: lidos.at(-1)?.dia ?? null,
          faltam: (await pendentes(c)).length,
        };
      }
      return json({ ok: true, ...out });
    }
    if (modulo !== "rodar") return json({ ok: false, erro: "modulo inválido (status | rodar)" }, 400);

    const de = u.searchParams.get("de") ?? undefined, ate = u.searchParams.get("ate") ?? undefined;
    if ((de && !DATA_OK.test(de)) || (ate && !DATA_OK.test(ate))) return json({ ok: false, erro: "datas no formato YYYY-MM-DD" }, 400);
    const so = u.searchParams.get("conta");
    const contas = (so ? [so] : [...CONTAS]).filter((c): c is Conta => (CONTAS as readonly string[]).includes(c));
    const prazo = Date.now() + ORCAMENTO_MS;
    const filas = new Map<Conta, string[]>();
    const tokens = new Map<Conta, string>();
    for (const c of contas) { filas.set(c, await pendentes(c, de, ate)); tokens.set(c, await token(c)); }

    const feitos: unknown[] = [];
    // alterna as contas, um dia de cada vez, até o tempo acabar
    let girou = true;
    while (girou && Date.now() < prazo - 2500) {
      girou = false;
      for (const c of contas) {
        const fila = filas.get(c)!;
        const dia = fila.shift();
        if (!dia) continue;
        girou = true;
        const r: any = await lerDia(c, tokens.get(c)!, dia, prazo);
        if (r === null) { feitos.push({ conta: c, dia, parou: "tempo" }); fila.unshift(dia); break; }
        const { data: ant } = await db.from("tiny_vendas_dia_estado").select("tentativas").eq("conta", c).eq("dia", dia).maybeSingle();
        const tent = Number(ant?.tentativas ?? 0) + 1;
        if (r.erro) {
          await db.from("tiny_vendas_dia_estado").upsert({ conta: c, dia, erro: r.erro, fora_do_plano: !!r.fora, tentativas: tent });
          feitos.push({ conta: c, dia, erro: r.erro, fora_do_plano: !!r.fora });
          if (r.fora) {
            // o plano não alcança este dia: os mais antigos também não — pula todos de uma vez
            const antigos = fila.filter((d) => d < dia);
            if (antigos.length) await db.from("tiny_vendas_dia_estado").upsert(antigos.map((d) => ({ conta: c, dia: d, fora_do_plano: true, erro: r.erro, tentativas: 1 })));
            filas.set(c, fila.filter((d) => d > dia));
          }
          continue;
        }
        await db.from("tiny_vendas_dia_estado").upsert({ conta: c, dia, total_api: r.total, lidos: r.lidos, concluido_em: new Date().toISOString(), erro: r.lidos === r.total ? null : `lidos ${r.lidos} de ${r.total}`, fora_do_plano: false, tentativas: tent });
        feitos.push({ conta: c, dia, pedidos: r.lidos, total_api: r.total });
      }
    }
    return json({ ok: true, feitos, faltam: Object.fromEntries([...filas].map(([c, f]) => [c, f.length])) });
  } catch (e) {
    return json({ ok: false, erro: String((e as Error)?.message ?? e) }, 500);
  }
});
