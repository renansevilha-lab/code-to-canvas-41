// ============================================================================
// Edge Function: fulfillment-inbound v14
//   modulo=parse-pdf  body {pdf_base64[, debug]}  -> itens (sku,ean,titulo,qtd)
//   modulo=imprimir   body {zpl | pdf_base64, printer_id, title[, copias]}
//                     -> manda ao PrintNode (ZPL cru OU PDF)
// v14 (25/set, ML): SKU/codigo/titulo lidos SO na coluna de PRODUTO (a esquerda
//   da coluna "UNIDADES"). Caso real (inbound #77022893): o ML quebrou o SKU
//   15989 para a linha de baixo e o "12" da coluna UNIDADES ficou na mesma
//   altura de "SKU:" -> virou o SKU fantasma "12" e TODAS as quantidades
//   seguintes escorregaram uma posicao (a soma ainda fechava 160 por acaso).
//   Conferencia nova: nº de SKUs = "Produtos do envio: N" = nº de quantidades;
//   se nao bater, confere=false + aviso (antes so a soma era comparada).
// v13 (25/ago): imprimir aceita PDF (contentType pdf_base64 + qty=copias).
//   Caso real: etiquetas de produto da AMAZON so existem em PDF ("Labels.pdf");
//   o time abria o arquivo e imprimia na mao. Agora o botao Imprimir do
//   documento manda direto. ZPL continua identico (raw_base64).
// v11: qtd Amazon = ULTIMO numero do run final da linha (dims: peso comp larg alt
//   unid/caixa total_caixas total_unidades) — funciona mesmo com SKU+ID na linha.
// v12 (ML): (1) quantidade lida da coluna "UNIDADES" de CADA pagina (antes so a
//   pagina do 1o cabecalho, perdendo tudo da 2a em diante -> soma vinha 230/338);
//   (2) SKU combina "SKU: <valor>" (ignorando rotulos que NAO sao SKU, ex.
//   "Etiquetagem") com o fallback "<numero> obrigat", porque em linhas de
//   kit/validade o ML quebra o valor pra baixo do rotulo ("SKU: Etiquetagem" numa
//   linha, "15989 obrigatoria" na seguinte).
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PRINTNODE_API_KEY = Deno.env.get("PRINTNODE_API_KEY") || "";
const PRINTNODE_HOST = "https://api.printnode.com";

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
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:.*;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function fixEnc(s: string | null | undefined): string | null {
  if (s == null) return s ?? null;
  const str = String(s);
  if (!/[Â-Ã]/.test(str)) return str;
  try {
    const bytes = Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff);
    const dec = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return dec.length <= str.length ? dec : str;
  } catch { return str; }
}

async function enriquecerComProdutos(itens: any[]): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const skuList = itens.map((i) => i.sku).filter(Boolean);
  const porSku = new Map<string, any>();
  if (skuList.length) {
    const { data } = await supabase.from("produtos").select("sku, nome, foto_capa").in("sku", skuList);
    for (const p of (data || [])) porSku.set(String(p.sku), p);
  }
  for (const it of itens) {
    const p = porSku.get(String(it.sku));
    it.no_cadastro = !!p;
    it.titulo = fixEnc(p?.nome) || it.titulo_pdf || null;
    it.tem_foto = !!(p?.foto_capa);
  }
}

type Tok = { str: string; x: number; y: number; p: number };

/** Junta os tokens em linhas (mesma pagina + mesma altura, tolerancia 4pt), de cima para baixo. */
function montarTexto(toks: Tok[]): string {
  const buckets = new Map<string, { x: number; str: string }[]>();
  for (const it of toks) {
    const key = `${it.p}:${Math.round(it.y / 4) * 4}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push({ x: it.x, str: it.str });
  }
  return [...buckets.entries()]
    .sort((a, b) => {
      const [pa, ya] = a[0].split(":").map(Number);
      const [pb, yb] = b[0].split(":").map(Number);
      return pa !== pb ? pa - pb : yb - ya;
    })
    .map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((i) => i.str).join(" "))
    .join("\n");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const modulo = url.searchParams.get("modulo") || body?.modulo || "parse-pdf";

  if (modulo === "imprimir") {
    if (!PRINTNODE_API_KEY) return json({ erro: "secret PRINTNODE_API_KEY nao configurado" }, { status: 500 });
    const zpl = body?.zpl;
    const pdfB64 = body?.pdf_base64;
    const printerId = body?.printer_id;
    const title = body?.title || "Etiquetas fulfillment";
    const copias = Math.max(1, parseInt(String(body?.copias ?? "1"), 10) || 1);
    if (!zpl && !pdfB64) return json({ erro: "envie zpl ou pdf_base64 no corpo" }, { status: 400 });
    if (!printerId) return json({ erro: "envie printer_id no corpo" }, { status: 400 });

    let contentType: string; let content: string; let blocos = 0;
    if (zpl) {
      content = btoa(unescape(encodeURIComponent(String(zpl))));
      contentType = "raw_base64";
      blocos = (String(zpl).match(/\^XA/g) || []).length;
    } else {
      // PDF (ex.: etiqueta de produtos da Amazon) — o PrintNode imprime via
      // driver, igual ao abrir+Ctrl+P que o time fazia na mao.
      content = String(pdfB64).replace(/^data:.*;base64,/, "");
      contentType = "pdf_base64";
    }
    const jobBody: Record<string, unknown> = {
      printerId: parseInt(String(printerId), 10), title, contentType, content, source: "Ottz Fulfillment",
    };
    if (copias > 1) jobBody.qty = copias;
    const jobResp = await fetch(`${PRINTNODE_HOST}/printjobs`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${PRINTNODE_API_KEY}:`), "Content-Type": "application/json" },
      body: JSON.stringify(jobBody),
    });
    const txt = await jobResp.text();
    let jid: any; try { jid = JSON.parse(txt); } catch { jid = txt; }
    if (!jobResp.ok) return json({ modulo: "imprimir", ok: false, status: jobResp.status, resposta: jid }, { status: 502 });
    return json({ modulo: "imprimir", ok: true, printnode_job_id: typeof jid === "number" ? jid : (jid?.id ?? null), blocos_zpl: blocos, formato: zpl ? "zpl" : "pdf", copias });
  }

  if (modulo !== "parse-pdf") return json({ erro: "modulo desconhecido" }, { status: 400 });

  const b64 = body?.pdf_base64;
  if (!b64) return json({ erro: "envie pdf_base64 no corpo" }, { status: 400 });

  let itens_pos: Tok[];
  try {
    const bytes = b64ToBytes(String(b64));
    const pdf = await getDocumentProxy(bytes);
    const nP = Math.min(pdf.numPages, 4);
    itens_pos = [];
    for (let pg = 1; pg <= nP; pg++) {
      const page = await pdf.getPage(pg);
      const content = await page.getTextContent();
      for (const it of (content.items as any[])) {
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const s = String(it.str || "");
        if (s.trim() === "") continue;
        itens_pos.push({ str: s, x: Math.round(tr[4]), y: Math.round(tr[5]), p: pg });
      }
    }
  } catch (e) {
    return json({ erro: `falha ao ler PDF: ${(e as Error).message}` }, { status: 500 });
  }

  const texto = montarTexto(itens_pos);

  // Cabecalho "UNIDADES" de cada pagina (ML): separa a coluna de produto da de quantidade.
  const headersUnid = new Map<number, { x: number; y: number }>();
  for (const i of itens_pos) {
    if (i.str.trim().toUpperCase() === "UNIDADES") {
      const ex = headersUnid.get(i.p);
      if (!ex || i.y > ex.y) headersUnid.set(i.p, { x: i.x, y: i.y });
    }
  }
  // v14: so a coluna de PRODUTO (a esquerda de UNIDADES) — sem os numeros de quantidade
  // e o texto das instrucoes caindo na mesma linha de "SKU:".
  const textoProduto = montarTexto(itens_pos.filter((i) => {
    const h = headersUnid.get(i.p);
    return !h || i.x < h.x - 10;
  }));

  if (body?.debug) {
    return json({
      debug: true, n_linhas: texto.split("\n").length, linhas: texto.split("\n"),
      linhas_coluna_produto: textoProduto.split("\n"),
    });
  }

  const ehAmazon = /ID da remessa/i.test(texto) && /(FNSKU|Encaixotado)/i.test(texto);
  if (ehAmazon) {
    const linhas = texto.split("\n");
    const numeroA = (texto.match(/ID da remessa\s+([A-Z0-9]+)/i) || [])[1] || null;
    const totalA = parseInt((texto.match(/\bUnidades\s+(\d+)/) || [])[1] || "0", 10) || null;

    const itensA: any[] = [];
    const skuSet = new Set<string>();
    for (const ln of linhas) {
      const m = ln.match(/^(\S+)\s+(.+?)\s+(B0[A-Z0-9]{8})\s+(X0[A-Z0-9]+)\b/);
      if (!m) continue;
      const sku = m[1];
      if (skuSet.has(sku)) continue;
      skuSet.add(sku);
      itensA.push({ sku, ean: null, fnsku: m[4], asin: m[3], titulo_pdf: fixEnc(m[2].replace(/\s+/g, " ").trim()), qtd: null, ordem: itensA.length });
    }

    const idxEnc = linhas.findIndex((l) => /Encaixotado/i.test(l));
    if (idxEnc >= 0) {
      const porSkuQtd = new Map<string, number>();
      let cur: string | null = null;
      for (let i = idxEnc + 1; i < linhas.length; i++) {
        const toks = linhas[i].trim().split(/\s+/).filter(Boolean);
        if (!toks.length) continue;
        if (skuSet.has(toks[0])) cur = toks[0];
        const run: string[] = [];
        for (let j = toks.length - 1; j >= 0; j--) {
          if (/^\d+(?:[.,]\d+)?$/.test(toks[j])) run.unshift(toks[j]); else break;
        }
        if (run.length >= 5 && cur) {
          const ult = parseInt(run[run.length - 1].replace(",", "."), 10);
          if (Number.isFinite(ult)) porSkuQtd.set(cur, (porSkuQtd.get(cur) || 0) + ult);
        }
      }
      for (const it of itensA) it.qtd = porSkuQtd.get(it.sku) ?? null;
    }

    await enriquecerComProdutos(itensA);
    const somaA = itensA.reduce((s, i) => s + (i.qtd || 0), 0);
    return json({
      modulo: "parse-pdf", fonte: "amazon", numero: numeroA, total: totalA, itens: itensA,
      soma_qtd: somaA, confere: totalA != null && somaA === totalA,
      aviso: (totalA != null && somaA !== totalA) ? "Soma das unidades lidas difere do total do PDF - confira/edite antes de salvar." : null,
    });
  }

  // MERCADO LIVRE
  const numero = (texto.match(/#\s*(\d{5,})/) || [])[1] || null;
  const total = parseInt((texto.match(/[Tt]otal de unidades:\s*(\d+)/) || [])[1] || "0", 10) || null;
  const produtosEsperados = parseInt((texto.match(/Produtos do envio:\s*(\d+)/i) || [])[1] || "0", 10) || null;

  // SKUs em ordem de documento. Nas linhas de kit/validade o ML quebra o valor
  // pra baixo do rotulo ("SKU: Etiquetagem" numa linha, "15989 obrigatoria" na
  // seguinte). Combinamos "SKU: <valor>" (ignorando rotulos que NAO sao SKU) com
  // o fallback "<numero> obrigat". Dedup preservando a 1a ocorrencia (ordem doc).
  // v14: le a COLUNA DE PRODUTO (textoProduto), nao a pagina inteira.
  const NAO_SKU = /^(etiquet|obrigat|universal|n\/a)/i;
  const skus: string[] = [];
  const eans: string[] = [];
  {
    const seen = new Set<string>();
    const skuRe = /SKU:\s*([A-Za-z0-9._\-]+)|(\d{4,7})\s+obrigat/gi;
    let m: RegExpExecArray | null;
    while ((m = skuRe.exec(textoProduto)) !== null) {
      const cand = m[1] && !NAO_SKU.test(m[1]) ? m[1] : (m[2] || null);
      if (cand && !seen.has(cand)) { seen.add(cand); skus.push(cand); }
    }
    for (const m2 of textoProduto.matchAll(/universal:\s*\n?\s*(\d{8,14})/gi)) eans.push(m2[1]);
  }

  // Quantidades: coluna "UNIDADES" de CADA pagina (1 cabecalho por pagina).
  const qtdTok: { p: number; y: number; v: number }[] = [];
  for (const [pg, h] of headersUnid) {
    for (const i of itens_pos) {
      if (i.p === pg && i.y < h.y - 2 && /^\d{1,4}$/.test(i.str.trim()) && Math.abs(i.x - h.x) < 40) {
        qtdTok.push({ p: pg, y: i.y, v: parseInt(i.str.trim(), 10) });
      }
    }
  }
  qtdTok.sort((a, b) => (a.p !== b.p ? a.p - b.p : b.y - a.y));
  const qtds: number[] = qtdTok.map((t) => t.v);

  const itens: any[] = [];
  for (let i = 0; i < skus.length; i++) {
    let titulo_pdf: string | null = null;
    const re = new RegExp(`SKU:\\s*${skus[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*([\\s\\S]*?)(?:Etiquetagem|Código ML|SKU:|PRODUTO|$)`);
    const mt = textoProduto.match(re);
    if (mt) titulo_pdf = mt[1].replace(/\s+/g, " ").trim() || null;
    itens.push({ sku: skus[i], ean: eans[i] || null, titulo_pdf: fixEnc(titulo_pdf), qtd: qtds[i] ?? null, ordem: i });
  }
  await enriquecerComProdutos(itens);
  const somaQtd = itens.reduce((s, i) => s + (i.qtd || 0), 0);

  // v14: a soma sozinha engana (linha fantasma + quantidade faltando podem fechar o total).
  const avisos: string[] = [];
  if (total != null && somaQtd !== total) avisos.push(`Soma das quantidades (${somaQtd}) difere do total do PDF (${total}).`);
  if (produtosEsperados != null && skus.length !== produtosEsperados) {
    avisos.push(`Li ${skus.length} produtos, o PDF diz ${produtosEsperados}.`);
  }
  if (qtds.length !== skus.length) avisos.push(`Li ${skus.length} SKUs e ${qtds.length} quantidades — a ordem pode estar deslocada.`);
  const confere = total != null && somaQtd === total
    && (produtosEsperados == null || skus.length === produtosEsperados)
    && qtds.length === skus.length;

  return json({
    modulo: "parse-pdf", fonte: "mercadolivre", numero, total, produtos_esperados: produtosEsperados, itens,
    soma_qtd: somaQtd, confere,
    aviso: avisos.length ? avisos.join(" ") + " Confira antes de salvar." : null,
  });
});
