// mp-extrato v1 (23/nov/2026) — extrato do Mercado Pago no nosso sistema, todo dia.
//
// O Mercado Pago não entrega extrato por API direto: ele GERA um relatório ("Liberações", release_report)
// de forma assíncrona. Esta função pede o relatório de um período fechado e, mais tarde, baixa e grava.
//
//   ?modulo=pedir[&dia=AAAA-MM-DD | &de=&ate=][&conta=<user_id>][&forcar=1]
//        padrão: ontem (Brasília). O período precisa estar FECHADO (hoje não entra: o MP não fecha o arquivo).
//   ?modulo=coletar   confere os pedidos abertos; se o arquivo existe, baixa o CSV e grava em mp_extrato
//   ?modulo=status    últimos pedidos (sem conteúdo do extrato)
//
// A configuração do relatório (colunas, fuso GMT-03, separador ;) é criada uma vez por conta no Mercado Pago
// (POST /v1/account/release_report/config) — feita para a Ottz em 23/nov. Conta nova = criar a configuração lá
// e inserir a linha em mp_extrato_conta.
// Só devolve contagens e estado: nenhum lançamento sai na resposta (a função aceita a chave pública do cron).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const MP = "https://api.mercadopago.com";
const URL_SB = Deno.env.get("SUPABASE_URL")!;
const CHAVE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(URL_SB, CHAVE, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// coluna do arquivo -> [campo da tabela, tipo: t texto | n número | d data]
const MAPA: Record<string, [string, "t" | "n" | "d"]> = {
  DATE: ["data", "d"],
  SOURCE_ID: ["source_id", "t"],
  EXTERNAL_REFERENCE: ["external_reference", "t"],
  RECORD_TYPE: ["record_type", "t"],
  DESCRIPTION: ["descricao", "t"],
  NET_CREDIT_AMOUNT: ["credito", "n"],
  NET_DEBIT_AMOUNT: ["debito", "n"],
  GROSS_AMOUNT: ["bruto", "n"],
  SELLER_AMOUNT: ["valor_vendedor", "n"],
  MP_FEE_AMOUNT: ["tarifa_mp", "n"],
  FINANCING_FEE_AMOUNT: ["tarifa_parcelamento", "n"],
  SHIPPING_FEE_AMOUNT: ["frete", "n"],
  TAXES_AMOUNT: ["impostos", "n"],
  COUPON_AMOUNT: ["cupom", "n"],
  PAYMENT_METHOD: ["meio_pagamento", "t"],
  ORDER_ID: ["order_id", "t"],
  PACK_ID: ["pack_id", "t"],
  SHIPPING_ID: ["shipping_id", "t"],
  BALANCE_AMOUNT: ["saldo", "n"],
  PAYOUT_BANK_ACCOUNT_NUMBER: ["conta_saque", "t"],
  TRANSACTION_APPROVAL_DATE: ["aprovado_em", "d"],
};

const hojeBRT = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function somaDia(d: string, n: number): string {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const ehDia = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function token(conta: number): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await sb.from("oauth_tokens_ml").select("access_token").eq("user_id", conta).maybeSingle();
    if (!error && data?.access_token) return data.access_token as string;
    if (!error) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("sem token do Mercado Livre para a conta " + conta);
}

async function mp(tk: string, caminho: string, init?: RequestInit) {
  const r = await fetch(MP + caminho, {
    ...init,
    headers: { Authorization: "Bearer " + tk, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const txt = await r.text();
  let j: any = null;
  try { j = JSON.parse(txt); } catch { /* não é JSON (arquivo) */ }
  return { status: r.status, txt, j };
}

async function avisar(titulo: string, descricao: string) {
  try {
    await fetch(URL_SB + "/functions/v1/discord-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CHAVE, apikey: CHAVE },
      body: JSON.stringify({ canal: "erros", nivel: "aviso", titulo, descricao, rodape: "mp-extrato" }),
    });
  } catch { /* melhor esforço */ }
}

function lerCsv(txt: string): string[][] {
  txt = txt.replace(/^﻿/, "");
  const fim1 = txt.indexOf("\n");
  const primeira = fim1 < 0 ? txt : txt.slice(0, fim1);
  const sep = (primeira.match(/;/g)?.length ?? 0) >= (primeira.match(/,/g)?.length ?? 0) ? ";" : ",";
  const linhas: string[][] = [];
  let campo = "", linha: string[] = [], aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) {
      if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; }
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ""; }
    else if (c === "\n") { linha.push(campo); campo = ""; linhas.push(linha); linha = []; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => c.trim() !== ""));
}

function num(s: string): number | null {
  s = (s ?? "").trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const t = s.replace(/\./g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
function data(s: string): string | null {
  s = (s ?? "").trim();
  if (!s) return null;
  const d = Date.parse(s);
  return isNaN(d) ? null : new Date(d).toISOString();
}

async function pedir(u: URL) {
  const dia = u.searchParams.get("dia");
  const de = u.searchParams.get("de") ?? dia ?? somaDia(hojeBRT(), -1);
  const ate = u.searchParams.get("ate") ?? dia ?? de;
  if (!ehDia(de) || !ehDia(ate) || de > ate) return json({ ok: false, erro: "datas inválidas (AAAA-MM-DD, de <= ate)" }, 400);
  if (ate >= hojeBRT()) return json({ ok: false, erro: "o período precisa estar fechado: o último dia tem de ser até ontem" }, 400);
  if ((Date.parse(ate) - Date.parse(de)) / 864e5 > 59) return json({ ok: false, erro: "no máximo 60 dias por pedido" }, 400);
  const forcar = u.searchParams.get("forcar") === "1";
  const soConta = u.searchParams.get("conta");

  let q = sb.from("mp_extrato_conta").select("user_id, apelido").eq("ativo", true);
  if (soConta) q = q.eq("user_id", Number(soConta));
  const { data: contas, error } = await q;
  if (error) return json({ ok: false, erro: "não li as contas: " + error.message }, 503);

  const inicio = de + "T03:00:00Z";
  const fim = somaDia(ate, 1) + "T02:59:59Z";
  const res: unknown[] = [];
  for (const c of contas ?? []) {
    const { data: ja, error: e2 } = await sb.from("mp_extrato_pedido").select("id, status")
      .eq("conta", c.user_id).eq("de", de).eq("ate", ate).in("status", ["pedido", "gravado"]).limit(1);
    if (e2) { res.push({ conta: c.apelido, erro: "não li os pedidos: " + e2.message }); continue; }
    if (ja?.length && !forcar) { res.push({ conta: c.apelido, pulado: "já pedido", status: ja[0].status }); continue; }
    try {
      const tk = await token(c.user_id);
      const r = await mp(tk, "/v1/account/release_report", { method: "POST", body: JSON.stringify({ begin_date: inicio, end_date: fim }) });
      const ok = r.status >= 200 && r.status < 300 && r.j?.id;
      await sb.from("mp_extrato_pedido").insert({
        conta: c.user_id, de, ate, inicio, fim,
        task_id: ok ? String(r.j.id) : null,
        status: ok ? "pedido" : "erro",
        status_mp: r.j?.status ?? null,
        erro: ok ? null : `HTTP ${r.status}: ${r.txt.slice(0, 300)}`,
      });
      res.push({ conta: c.apelido, pedido: !!ok, http: r.status, status_mp: r.j?.status ?? null });
      if (!ok) await avisar("Extrato do Mercado Pago: pedido recusado", `${c.apelido} · ${de} a ${ate} · HTTP ${r.status}: ${r.txt.slice(0, 200)}`);
    } catch (e) {
      res.push({ conta: c.apelido, erro: String((e as Error).message ?? e) });
    }
  }
  return json({ ok: true, de, ate, contas: res });
}

async function coletar() {
  const t0 = Date.now();
  const { data: pend, error } = await sb.from("mp_extrato_pedido").select("*").eq("status", "pedido").order("pedido_em").limit(6);
  if (error) return json({ ok: false, erro: "não li os pedidos: " + error.message }, 503);
  const res: unknown[] = [];
  for (const p of pend ?? []) {
    if (Date.now() - t0 > 20000) { res.push({ id: p.id, pulado: "sem tempo nesta rodada" }); continue; }
    const agora = new Date().toISOString();
    try {
      const tk = await token(p.conta);
      const t = await mp(tk, `/v1/account/release_report/task/${p.task_id}`);
      const statusMp = t.j?.status ?? null;
      let arquivo: string | null = t.j?.file_name ?? null;
      if (!arquivo) {
        const l = await mp(tk, "/v1/account/release_report/list");
        if (Array.isArray(l.j)) {
          const a = l.j.find((x: any) =>
            String(x?.id ?? "") === String(p.task_id) ||
            (Date.parse(x?.begin_date) === Date.parse(p.inicio) && Date.parse(x?.end_date) === Date.parse(p.fim)));
          arquivo = a?.file_name ?? null;
        }
      }
      if (!arquivo) {
        const horas = (Date.now() - Date.parse(p.pedido_em)) / 36e5;
        const desistir = horas > 36;
        await sb.from("mp_extrato_pedido").update({
          verificado_em: agora, status_mp: statusMp,
          ...(desistir ? { status: "erro", erro: `sem arquivo ${Math.round(horas)} h depois do pedido (estado no MP: ${statusMp})`, avisado_em: agora } : {}),
        }).eq("id", p.id);
        if (desistir) await avisar("Extrato do Mercado Pago não saiu", `Pedido ${p.id} (${p.de} a ${p.ate}) sem arquivo há ${Math.round(horas)} h. Estado no Mercado Pago: ${statusMp}.`);
        res.push({ id: p.id, de: p.de, ate: p.ate, aguardando: true, status_mp: statusMp, horas: Math.round(horas * 10) / 10 });
        continue;
      }

      const r = await fetch(`${MP}/v1/account/release_report/${encodeURIComponent(arquivo)}`, { headers: { Authorization: "Bearer " + tk } });
      const txt = await r.text();
      if (!r.ok || txt.startsWith("PK")) {
        const tent = (p.tentativas ?? 0) + 1;
        const erro = !r.ok ? `download HTTP ${r.status}: ${txt.slice(0, 200)}` : "o arquivo veio em XLSX, a rotina lê CSV";
        await sb.from("mp_extrato_pedido").update({ verificado_em: agora, status_mp: statusMp, arquivo, tentativas: tent, erro, ...(tent >= 5 ? { status: "erro" } : {}) }).eq("id", p.id);
        if (tent >= 5) await avisar("Extrato do Mercado Pago: não consegui baixar", `Pedido ${p.id} (${p.de} a ${p.ate}) · ${erro}`);
        res.push({ id: p.id, erro });
        continue;
      }

      const tab = lerCsv(txt);
      const cab = (tab[0] ?? []).map((c) => c.trim().toUpperCase());
      if (!cab.includes("DATE")) {
        const erro = "cabeçalho inesperado no arquivo: " + cab.slice(0, 12).join(", ");
        await sb.from("mp_extrato_pedido").update({ verificado_em: agora, status_mp: statusMp, arquivo, status: "erro", erro, cabecalho: cab }).eq("id", p.id);
        await avisar("Extrato do Mercado Pago: arquivo em formato inesperado", `Pedido ${p.id} (${p.de} a ${p.ate}) · ${erro}`);
        res.push({ id: p.id, erro });
        continue;
      }

      const linhas: Record<string, unknown>[] = [];
      const resumo: Record<string, string>[] = [];
      for (let i = 1; i < tab.length; i++) {
        const cru: Record<string, string> = {};
        cab.forEach((k, j) => { cru[k] = (tab[i][j] ?? "").trim(); });
        const o: Record<string, unknown> = { linha: i };
        const extras: Record<string, string> = {};
        for (const k of cab) {
          const m = MAPA[k];
          if (!m) { if (cru[k]) extras[k] = cru[k]; continue; }
          o[m[0]] = m[1] === "n" ? num(cru[k]) : m[1] === "d" ? data(cru[k]) : cru[k];
        }
        if (!o.data) { resumo.push(cru); continue; }   // saldo inicial, totais: sem data
        o.extras = Object.keys(extras).length ? extras : null;
        linhas.push(o);
      }

      let gravadas = 0, falha: string | null = null;
      const TAM = 1500;
      for (let i = 0; i === 0 || i < linhas.length; i += TAM) {
        const { data: n, error: eg } = await sb.rpc("mp_extrato_gravar", { p_pedido: p.id, p_linhas: linhas.slice(i, i + TAM), p_primeiro: i === 0 });
        if (eg) { falha = eg.message; break; }
        gravadas += Number(n ?? 0);
      }
      if (falha) {
        const tent = (p.tentativas ?? 0) + 1;
        await sb.from("mp_extrato_pedido").update({ verificado_em: agora, arquivo, tentativas: tent, erro: "gravação: " + falha, ...(tent >= 5 ? { status: "erro" } : {}) }).eq("id", p.id);
        res.push({ id: p.id, erro: "gravação: " + falha });
        continue;
      }
      const comSaldo = linhas.filter((l) => l.saldo !== null && l.saldo !== undefined);
      const ultimo = comSaldo.sort((a, b) => String(a.data).localeCompare(String(b.data)) || Number(a.linha) - Number(b.linha)).at(-1);
      await sb.from("mp_extrato_pedido").update({
        status: "gravado", status_mp: statusMp, arquivo, verificado_em: agora, baixado_em: agora, linhas: gravadas,
        saldo_final: ultimo ? ultimo.saldo : null, resumo: resumo.slice(0, 20), cabecalho: cab, erro: null,
      }).eq("id", p.id);
      res.push({ id: p.id, de: p.de, ate: p.ate, gravado: true, linhas: gravadas, sem_data: resumo.length });
    } catch (e) {
      res.push({ id: p.id, erro: String((e as Error).message ?? e) });
    }
  }
  return json({ ok: true, pedidos: res });
}

async function status() {
  const { data, error } = await sb.from("mp_extrato_pedido")
    .select("id, conta, de, ate, status, status_mp, arquivo, pedido_em, verificado_em, baixado_em, linhas, saldo_final, erro, tentativas")
    .order("id", { ascending: false }).limit(15);
  if (error) return json({ ok: false, erro: error.message }, 503);
  return json({ ok: true, pedidos: data });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const modulo = u.searchParams.get("modulo") ?? "status";
  try {
    if (modulo === "pedir") return await pedir(u);
    if (modulo === "coletar") return await coletar();
    if (modulo === "status") return await status();
    return json({ ok: false, erro: "módulo desconhecido: " + modulo }, 400);
  } catch (e) {
    return json({ ok: false, erro: String((e as Error).message ?? e) }, 500);
  }
});
