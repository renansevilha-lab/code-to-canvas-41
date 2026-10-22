// ============================================================================
// Folha de encaixotamento (A4 retrato) de um envio ao FBA — 22/out/2026, pedido do dono.
// Mesmo conteúdo da "folha da remessa" do Seller Central, para a bancada: como montar as caixas (caixas iguais
// agrupadas), o preparo que a Amazon exige por produto e a conferência caixa a caixa. Os dados vêm de
// envios_amazon[].encaixotamento (listShipmentBoxes + listShipmentItems), gravado pela amazon-inbound.
// ============================================================================
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export type CaixaEnc = { id: string | null; nome: string | null; qtd: number; kg: number | null; c: number | null; l: number | null; a: number | null; unidade?: string; itens: { msku: string; q: number }[] };
export type ItemEnc = { msku: string; asin: string | null; fnsku: string | null; q: number; etiqueta: string | null; validade: string | null; preparo: { tipo: string; quem: string | null }[] };
export type DadosFolha = {
  fba: string; empresa: string | null; cd: string | null; coleta: string | null; plano: string | null;
  caixas: CaixaEnc[]; itens: ItemEnc[]; nomes: Record<string, { sku?: string | null; titulo?: string | null }>;
};

const PREPARO: Record<string, string> = {
  ITEM_LABELING: "etiqueta FNSKU", ITEM_POLYBAGGING: "saco plastico", ITEM_BUBBLEWRAP: "plastico bolha", ITEM_TAPING: "fita",
  ITEM_BLACK_SHRINKWRAP: "filme preto", ITEM_BOXING: "caixa", ITEM_SETCREAT: "montar conjunto", ITEM_SETSTK: "etiqueta de conjunto",
  ITEM_CAP_SEALING: "lacre da tampa", ITEM_SUFFOSTK: "aviso de sufocamento", ITEM_NO_PREP: "sem preparo", ITEM_SIOC: "embalagem propria",
};
const preparo = (t: string) => PREPARO[t] ?? t.replace(/^ITEM_/, "").toLowerCase().replace(/_/g, " ");
const limpo = (s: string) => String(s ?? "").normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/[^\x20-\x7E\xA0-\xFF]/g, " ");
const num = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const dataBR = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const numeroCaixa = (n: string | null) => Number(String(n ?? "").match(/B(\d+)\s*$/)?.[1] ?? NaN);

/** "B1".."B26" → "B1-B26, B30"; nomes fora do padrão saem como vieram. */
function faixas(nomes: string[]): string {
  const ns = nomes.map(numeroCaixa);
  if (ns.some((n) => !Number.isFinite(n))) return nomes.join(", ");
  ns.sort((a, b) => a - b);
  const partes: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    partes.push(j > i ? `B${ns[i]}-B${ns[j]}` : `B${ns[i]}`);
    i = j;
  }
  return partes.join(", ");
}

type Ctx = { pdf: PDFDocument; page: PDFPage; f: PDFFont; fb: PDFFont; y: number };
const M = 32, W = 595.28 - 2 * M, H = 841.89;
const CINZA = rgb(0.45, 0.45, 0.45), PRETO = rgb(0, 0, 0);

function cortar(f: PDFFont, s: string, tam: number, larg: number) {
  let t = limpo(s);
  if (f.widthOfTextAtSize(t, tam) <= larg) return t;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, tam) > larg) t = t.slice(0, -1);
  return `${t}...`;
}
function quebrar(f: PDFFont, s: string, tam: number, larg: number, max = 3) {
  const out: string[] = [];
  let atual = "";
  for (const p of limpo(s).split(/\s+/).filter(Boolean)) {
    const t = atual ? `${atual} ${p}` : p;
    if (f.widthOfTextAtSize(t, tam) <= larg) { atual = t; continue; }
    if (atual) out.push(atual);
    atual = cortar(f, p, tam, larg);
  }
  if (atual) out.push(atual);
  return out.length > max ? [...out.slice(0, max - 1), cortar(f, out.slice(max - 1).join(" "), tam, larg)] : out;
}
function texto(c: Ctx, s: string, x: number, tam: number, o: { negrito?: boolean; cor?: ReturnType<typeof rgb>; larg?: number } = {}) {
  const fonte = o.negrito ? c.fb : c.f;
  c.page.drawText(o.larg ? cortar(fonte, s, tam, o.larg) : limpo(s), { x, y: H - c.y - tam, size: tam, font: fonte, color: o.cor ?? PRETO });
}
function novaPagina(c: Ctx, fba: string) {
  c.page = c.pdf.addPage([595.28, H]);
  c.y = M;
  texto(c, `Encaixotamento ${fba} (continuação)`, M, 9, { cor: CINZA });
  c.y += 18;
}

type Col = { r: string; w: number; d?: boolean };
/** Tabela com cabeçalho repetido a cada página; linhas com várias linhas de texto por célula. */
function tabela(c: Ctx, fba: string, cols: Col[], linhas: string[][], tam = 8.5, negritoCol = -1) {
  const cab = () => {
    let x = M;
    c.page.drawRectangle({ x: M, y: H - c.y - 14, width: W, height: 14, color: rgb(0.93, 0.93, 0.93) });
    for (const col of cols) { texto(c, col.r, x + 3, 7.5, { negrito: true, larg: col.w - 6 }); x += col.w; }
    c.y += 17;
  };
  cab();
  for (const ln of linhas) {
    const cel = ln.map((v, i) => quebrar(i === negritoCol ? c.fb : c.f, v, tam, cols[i].w - 6, 4));
    const h = Math.max(...cel.map((l) => l.length)) * (tam + 2.5) + 5;
    if (c.y + h > H - M) { novaPagina(c, fba); cab(); }
    let x = M;
    cel.forEach((ls, i) => {
      ls.forEach((t, k) => {
        const fonte = i === negritoCol ? c.fb : c.f;
        const tx = cols[i].d ? x + cols[i].w - 3 - fonte.widthOfTextAtSize(t, tam) : x + 3;
        c.page.drawText(t, { x: tx, y: H - c.y - tam - k * (tam + 2.5), size: tam, font: fonte });
      });
      x += cols[i].w;
    });
    c.y += h;
    c.page.drawLine({ start: { x: M, y: H - c.y + 2 }, end: { x: M + W, y: H - c.y + 2 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.8) });
  }
  c.y += 8;
}
function titulo(c: Ctx, fba: string, s: string) {
  if (c.y + 60 > H - M) novaPagina(c, fba);
  texto(c, s, M, 11, { negrito: true });
  c.y += 18;
}

export async function gerarFolhaCaixas(d: DadosFolha): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Encaixotamento ${d.fba}`);
  const c: Ctx = { pdf, page: pdf.addPage([595.28, H]), f: await pdf.embedFont(StandardFonts.Helvetica), fb: await pdf.embedFont(StandardFonts.HelveticaBold), y: M };
  const nome = (msku: string) => d.nomes[msku] ?? {};
  const produto = (msku: string) => {
    const n = nome(msku);
    return `${n.sku && n.sku !== msku ? `${n.sku} (${msku})` : msku}${n.titulo ? ` - ${n.titulo}` : ""}`;
  };
  const totCx = d.caixas.reduce((s, x) => s + (x.qtd || 1), 0);
  const totUn = d.caixas.reduce((s, x) => s + (x.qtd || 1) * x.itens.reduce((t, i) => t + i.q, 0), 0);
  const totKg = d.caixas.reduce((s, x) => s + (x.qtd || 1) * (x.kg ?? 0), 0);

  // cabeçalho
  texto(c, "Encaixotamento - envio ao FBA (Amazon)", M, 9, { cor: CINZA });
  c.y += 14;
  texto(c, d.fba, M, 22, { negrito: true });
  c.y += 30;
  texto(c, [d.empresa, d.cd ? `CD ${d.cd}` : null, d.coleta ? `coleta ${dataBR(d.coleta)}` : null, d.plano].filter(Boolean).join("   ·   "), M, 9.5, { cor: CINZA, larg: W });
  c.y += 16;
  texto(c, `${num(totCx)} caixas   ·   ${num(totUn)} unidades   ·   ${num(Math.round(totKg))} kg`, M, 12, { negrito: true });
  c.y += 22;

  // preparo especial
  const especiais = d.itens.filter((i) => i.preparo.some((p) => p.tipo !== "ITEM_LABELING" && p.tipo !== "ITEM_NO_PREP"));
  if (especiais.length) {
    const linhas = especiais.map((i) => `${nome(i.msku).sku ?? i.msku}: ${i.preparo.map((p) => preparo(p.tipo)).join(" + ")}`);
    const ls = linhas.flatMap((l) => quebrar(c.f, l, 9, W - 20, 3));
    const h = 22 + ls.length * 12;
    c.page.drawRectangle({ x: M, y: H - c.y - h, width: W, height: h, color: rgb(1, 0.96, 0.85), borderColor: rgb(0.85, 0.6, 0.1), borderWidth: 1 });
    c.y += 6;
    texto(c, "ATENCAO - preparo exigido pela Amazon", M + 10, 9.5, { negrito: true });
    c.y += 14;
    for (const l of ls) { texto(c, l, M + 10, 9); c.y += 12; }
    c.y += 12;
  }

  // como montar: caixas iguais agrupadas
  titulo(c, d.fba, "Como montar as caixas");
  const grupos = new Map<string, { caixas: CaixaEnc[]; total: number }>();
  for (const cx of d.caixas) {
    const k = [cx.itens.map((i) => `${i.msku}x${i.q}`).sort().join("+"), cx.c, cx.l, cx.a, cx.kg].join("|");
    const g = grupos.get(k) ?? { caixas: [], total: 0 };
    g.caixas.push(cx);
    g.total += cx.qtd || 1;
    grupos.set(k, g);
  }
  tabela(c, d.fba, [{ r: "CAIXAS", w: 50, d: true }, { r: "CADA CAIXA LEVA", w: 245 }, { r: "MEDIDAS (CM)", w: 75 }, { r: "PESO/CX", w: 50, d: true }, { r: "NOMES", w: W - 420 }],
    [...grupos.values()].sort((a, b) => b.total - a.total).map((g) => {
      const cx = g.caixas[0];
      return [String(g.total), cx.itens.map((i) => `${i.q} un · ${produto(i.msku)}`).join("  /  "), `${cx.c ?? "?"} x ${cx.l ?? "?"} x ${cx.a ?? "?"}`,
        cx.kg != null ? `${num(cx.kg)} kg` : "-", faixas(g.caixas.map((x) => x.nome ?? x.id ?? ""))];
    }), 9, 0);

  // produtos
  titulo(c, d.fba, "Produtos do envio");
  tabela(c, d.fba, [{ r: "PRODUTO", w: 200 }, { r: "FNSKU", w: 72 }, { r: "UN", w: 34, d: true }, { r: "VALIDADE", w: 56 }, { r: "PREPARO", w: 95 }, { r: "ETIQUETA POR", w: W - 457 }],
    d.itens.map((i) => [produto(i.msku), i.fnsku ?? "-", String(i.q), dataBR(i.validade) || "-",
      i.preparo.length ? i.preparo.map((p) => preparo(p.tipo)).join(" + ") : "sem preparo",
      i.etiqueta === "SELLER" ? "nós" : i.etiqueta === "AMAZON" ? "Amazon" : (i.etiqueta ?? "-")]));

  // conferência caixa a caixa
  titulo(c, d.fba, "Conferência caixa a caixa");
  const ordenadas = [...d.caixas].sort((a, b) => (numeroCaixa(a.nome) || 0) - (numeroCaixa(b.nome) || 0));
  tabela(c, d.fba, [{ r: "OK", w: 26 }, { r: "CAIXA", w: 62 }, { r: "ID DA CAIXA", w: 130 }, { r: "CONTEUDO", w: 215 }, { r: "PESO", w: W - 433, d: true }],
    ordenadas.map((cx) => ["[  ]", `${cx.nome ?? "-"}${(cx.qtd || 1) > 1 ? ` (x${cx.qtd})` : ""}`, cx.id ?? "-",
      cx.itens.map((i) => `${i.q} un · ${nome(i.msku).sku ?? i.msku}`).join(" / "), cx.kg != null ? `${num(cx.kg)} kg` : "-"]), 8.5, 1);

  // rodapé com página
  const paginas = pdf.getPages();
  paginas.forEach((p, i) => p.drawText(`${d.fba} · folha ${i + 1}/${paginas.length}`, { x: M, y: 16, size: 7.5, font: c.f, color: CINZA }));
  return await pdf.save();
}
