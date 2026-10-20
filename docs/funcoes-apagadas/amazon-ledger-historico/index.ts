// ============================================================================
// Edge Function: amazon-ledger-historico v1
// ----------------------------------------------------------------------------
// Posicao do estoque FBA numa data via relatorio GET_LEDGER_SUMMARY_VIEW_DATA
// (Inventory Ledger, agregado MENSAL): a coluna "Ending Warehouse Balance" do mes
// = posicao de fechamento no ultimo dia. Grava em estoque_fulfillment_historico
// (warehouse FBA, on_hand = soma de todas as disposicoes/localizacoes).
//
// Uso:
//   ?modulo=criar&empresa=Ottz%20Pet&mes=2026-07      -> cria o relatorio, devolve reportId
//   ?modulo=baixar&empresa=Ottz%20Pet&report_id=...&data_ref=2026-07-31
//        -> consulta status; se DONE baixa, parseia e grava
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const num = (v: any): number => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };

function normalizarSku(s: string | null): string | null {
  if (!s) return null; let x = String(s).trim(); x = x.replace(/^FBA[-_]/i, "").replace(/[-_]FBA$/i, ""); return x || null;
}

serve(async (req: Request) => {
  const sb = createClient(SUPABASE_URL, KEY);
  const url = new URL(req.url);
  const modulo = url.searchParams.get("modulo") || "criar";
  const empresa = url.searchParams.get("empresa") || "Ottz Pet";

  const { data: contas } = await sb.from("oauth_tokens_amazon").select("seller_id, empresa, access_token, marketplace_id, shop_id");
  const conta = (contas || []).find((c: any) => c.empresa === empresa) || (contas || [])[0];
  if (!conta?.access_token) return Response.json({ ok: false, erro: "sem token", empresas: (contas || []).map((c: any) => c.empresa) });
  const mkt = conta.marketplace_id || "A2Q3Y263D00KWC";
  const H = { "x-amz-access-token": conta.access_token, "Content-Type": "application/json", Accept: "application/json" };

  if (modulo === "criar") {
    const mes = url.searchParams.get("mes") || "2026-07";
    const [y, m] = mes.split("-").map(Number);
    const fim = new Date(Date.UTC(y, m, 0)); // ultimo dia do mes
    const body = {
      reportType: "GET_LEDGER_SUMMARY_VIEW_DATA",
      marketplaceIds: [mkt],
      dataStartTime: `${mes}-01T00:00:00Z`,
      dataEndTime: `${fim.toISOString().slice(0, 10)}T23:59:59Z`,
      reportOptions: { aggregateByLocation: "COUNTRY", aggregatedByTimePeriod: "MONTHLY" },
    };
    const r = await fetch(`${SPAPI}/reports/2021-06-30/reports`, { method: "POST", headers: H, body: JSON.stringify(body) });
    const txt = await r.text(); let p: any; try { p = JSON.parse(txt); } catch { p = { _raw: txt.substring(0, 500) }; }
    await sb.from("debug_fulfillment").insert({ modulo: "amazon-ledger", etapa: `criar-${empresa}-${mes}`, status_http: r.status, resultado: p });
    return Response.json({ ok: r.ok, status: r.status, empresa: conta.empresa, shop_id: conta.shop_id, reportId: p?.reportId ?? null, resposta: r.ok ? undefined : p });
  }

  if (modulo === "baixar") {
    const reportId = url.searchParams.get("report_id") || "";
    const dataRef = url.searchParams.get("data_ref") || "2026-07-31";
    if (!reportId) return Response.json({ ok: false, erro: "report_id" });
    const r = await fetch(`${SPAPI}/reports/2021-06-30/reports/${reportId}`, { headers: H });
    const st = await r.json();
    const status = st?.processingStatus;
    if (status !== "DONE") {
      await sb.from("debug_fulfillment").insert({ modulo: "amazon-ledger", etapa: `status-${reportId}`, status_http: r.status, resultado: st });
      return Response.json({ ok: true, processingStatus: status ?? st, reportDocumentId: st?.reportDocumentId ?? null });
    }
    const d = await fetch(`${SPAPI}/reports/2021-06-30/documents/${st.reportDocumentId}`, { headers: H });
    const doc = await d.json();
    const f = await fetch(doc.url);
    let texto: string;
    if (doc.compressionAlgorithm === "GZIP") {
      const ds = new DecompressionStream("gzip");
      texto = await new Response(f.body!.pipeThrough(ds)).text();
    } else texto = await f.text();

    const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
    const cab = linhas[0].split("\t").map((c) => c.trim().toLowerCase());
    const idx = (nome: string) => cab.findIndex((c) => c === nome.toLowerCase());
    const iMsku = idx("MSKU"), iTit = idx("Title"), iDisp = idx("Disposition"), iEnd = idx("Ending Warehouse Balance"), iStart = idx("Starting Warehouse Balance"), iLoc = idx("Location"), iDate = idx("Date"), iFn = idx("FNSKU");
    const { data: maps } = await sb.from("sku_mapeamento").select("sku_origem, sku_correto").eq("marketplace", "amazon");
    const dePara = new Map<string, string>(); for (const m of (maps || [])) if (m.sku_origem && m.sku_correto) dePara.set(String(m.sku_origem), String(m.sku_correto));

    const agg = new Map<string, any>();
    let parseadas = 0;
    for (const ln of linhas.slice(1)) {
      const c = ln.split("\t");
      const msku = (c[iMsku] || "").trim(); if (!msku) continue;
      parseadas++;
      const disp = (c[iDisp] || "").trim().toUpperCase();
      const end = num(c[iEnd]);
      const a = agg.get(msku) || { msku, titulo: (c[iTit] || "").trim(), fnsku: (c[iFn] || "").trim(), on_hand: 0, det: {}, start: 0, data: (c[iDate] || "").trim(), loc: (c[iLoc] || "").trim() };
      a.on_hand += end; a.start += num(c[iStart]);
      a.det[disp || "?"] = (a.det[disp || "?"] || 0) + end;
      agg.set(msku, a);
    }
    const rows = Array.from(agg.values()).map((a) => ({
      data_ref: dataRef, marketplace: "amazon", shop_id: Number(conta.shop_id ?? 0), sku_marketplace: a.msku, warehouse: "FBA",
      sku: dePara.get(a.msku) ?? normalizarSku(a.msku), titulo: a.titulo || null, on_hand: a.on_hand,
      detalhe_sku: { por_disposicao: a.det, starting_balance: a.start, fnsku: a.fnsku, periodo: a.data, location: a.loc },
      origem: `amazon ledger summary MONTHLY report ${reportId}`,
    }));
    let salvos = 0; const erros: string[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await sb.from("estoque_fulfillment_historico").upsert(rows.slice(i, i + 200), { onConflict: "data_ref,marketplace,shop_id,sku_marketplace,warehouse" });
      if (error) erros.push(error.message.substring(0, 80)); else salvos += Math.min(200, rows.length - i);
    }
    await sb.from("debug_fulfillment").insert({ modulo: "amazon-ledger", etapa: `baixar-${reportId}`, status_http: 200, resultado: { cabecalho: cab, linhas: linhas.length, parseadas, skus: rows.length, amostra: linhas.slice(1, 3) } });
    return Response.json({ ok: erros.length === 0, linhas: linhas.length, skus: rows.length, salvos, unidades: rows.reduce((s, r) => s + r.on_hand, 0), colunas: cab, erros });
  }
  return Response.json({ modulos: ["criar", "baixar"] });
});
