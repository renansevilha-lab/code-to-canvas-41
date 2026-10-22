// ============================================================================
// Folha PREP (encaixotamento, A4 retrato) de um envio ao FBA — 22/out/2026, pedido do dono.
// Para a bancada: por produto, a foto e como montar os volumes dele (quantos volumes, unidades por volume, medidas e
// peso) e o preparo que a Amazon exige; sem a lista caixa a caixa (2ª versão do mesmo dia, pedido do dono). Os dados vêm
// de envios_amazon[].encaixotamento (listShipmentBoxes + listShipmentItems), gravado pela amazon-inbound.
// ============================================================================
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export type CaixaEnc = { id: string | null; nome: string | null; qtd: number; kg: number | null; c: number | null; l: number | null; a: number | null; unidade?: string; itens: { msku: string; q: number }[] };
export type ItemEnc = { msku: string; asin: string | null; fnsku: string | null; q: number; etiqueta: string | null; validade: string | null; preparo: { tipo: string; quem: string | null }[] };
export type DadosFolha = {
  fba: string; empresa: string | null; cd: string | null; coleta: string | null; plano: string | null;
  caixas: CaixaEnc[]; itens: ItemEnc[]; nomes: Record<string, { sku?: string | null; titulo?: string | null }>;
  /** foto do produto por msku (PNG ou JPEG); o que não vier sai com um quadro vazio */
  fotos?: Record<string, Uint8Array>;
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

type Ctx = { pdf: PDFDocument; page: PDFPage; f: PDFFont; fb: PDFFont; y: number };
const M = 36, W = 595.28 - 2 * M, H = 841.89;
const CINZA = rgb(0.45, 0.45, 0.45), PRETO = rgb(0, 0, 0), LINHA = rgb(0.85, 0.85, 0.85);

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
function texto(c: Ctx, s: string, x: number, tam: number, o: { negrito?: boolean; cor?: ReturnType<typeof rgb>; larg?: number; dy?: number } = {}) {
  const fonte = o.negrito ? c.fb : c.f;
  c.page.drawText(o.larg ? cortar(fonte, s, tam, o.larg) : limpo(s), { x, y: H - c.y - (o.dy ?? 0) - tam, size: tam, font: fonte, color: o.cor ?? PRETO });
}
function novaPagina(c: Ctx, fba: string) {
  c.page = c.pdf.addPage([595.28, H]);
  c.y = M;
  texto(c, `Folha PREP ${fba} (continuação)`, M, 9, { cor: CINZA });
  c.y += 20;
}
async function imagem(pdf: PDFDocument, b: Uint8Array | undefined): Promise<PDFImage | null> {
  if (!b || b.length < 8) return null;
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return await pdf.embedPng(b);
    if (b[0] === 0xff && b[1] === 0xd8) return await pdf.embedJpg(b);
  } catch { /* imagem que o pdf-lib não lê: sai sem foto */ }
  return null;
}

export async function gerarFolhaCaixas(d: DadosFolha): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Folha PREP ${d.fba}`);
  const c: Ctx = { pdf, page: pdf.addPage([595.28, H]), f: await pdf.embedFont(StandardFonts.Helvetica), fb: await pdf.embedFont(StandardFonts.HelveticaBold), y: M };
  const nome = (msku: string) => d.nomes[msku] ?? {};
  const vol = (cx: CaixaEnc) => Math.max(1, cx.qtd || 1);
  const totCx = d.caixas.reduce((s, x) => s + vol(x), 0);
  const totUn = d.caixas.reduce((s, x) => s + vol(x) * x.itens.reduce((t, i) => t + i.q, 0), 0);
  const totKg = d.caixas.reduce((s, x) => s + vol(x) * (x.kg ?? 0), 0);

  // volumes por produto (caixas de um produto só) e caixas mistas à parte
  const formatos = new Map<string, Map<string, { volumes: number; un: number; cx: CaixaEnc }>>();
  const mistas = new Map<string, { volumes: number; cx: CaixaEnc }>();
  for (const cx of d.caixas) {
    if (cx.itens.length !== 1) {
      const k = [cx.itens.map((i) => `${i.msku}x${i.q}`).sort().join("+"), cx.c, cx.l, cx.a, cx.kg].join("|");
      const g = mistas.get(k) ?? { volumes: 0, cx };
      g.volumes += vol(cx);
      mistas.set(k, g);
      continue;
    }
    const it = cx.itens[0];
    const m = formatos.get(it.msku) ?? new Map();
    const k = [it.q, cx.c, cx.l, cx.a, cx.kg].join("|");
    const f = m.get(k) ?? { volumes: 0, un: it.q, cx };
    f.volumes += vol(cx);
    m.set(k, f);
    formatos.set(it.msku, m);
  }
  const medidas = (cx: CaixaEnc) => `${cx.c ?? "?"} x ${cx.l ?? "?"} x ${cx.a ?? "?"} cm   ·   ${cx.kg != null ? `${num(cx.kg)} kg` : "peso ?"}`;

  // cabeçalho
  texto(c, "Folha PREP - como montar os volumes (Amazon FBA)", M, 9, { cor: CINZA });
  c.y += 14;
  texto(c, d.fba, M, 22, { negrito: true });
  c.y += 30;
  texto(c, [d.empresa, d.cd ? `CD ${d.cd}` : null, d.coleta ? `coleta ${dataBR(d.coleta)}` : null].filter(Boolean).join("   ·   "), M, 10, { cor: CINZA, larg: W });
  c.y += 16;
  texto(c, `${num(totCx)} volumes   ·   ${num(totUn)} unidades   ·   ${num(Math.round(totKg))} kg`, M, 13, { negrito: true });
  c.y += 26;

  // um bloco por produto: foto | nome, dados e volumes
  const FOTO = 92, xT = M + FOTO + 14, larg = W - FOTO - 14;
  for (const it of d.itens) {
    const n = nome(it.msku);
    const especial = it.preparo.filter((p) => p.tipo !== "ITEM_LABELING" && p.tipo !== "ITEM_NO_PREP");
    const fs = [...(formatos.get(it.msku)?.values() ?? [])];
    const titulo = quebrar(c.fb, n.titulo ?? it.msku, 12, larg, 2);
    const altura = Math.max(FOTO, titulo.length * 15 + 16 + fs.length * 19 + (especial.length ? 20 : 0)) + 18;
    if (c.y + altura > H - M - 20) novaPagina(c, d.fba);
    const topo = c.y;
    const img = await imagem(pdf, d.fotos?.[it.msku]);
    c.page.drawRectangle({ x: M, y: H - topo - FOTO, width: FOTO, height: FOTO, borderColor: LINHA, borderWidth: 0.8 });
    if (img) {
      const s = Math.min((FOTO - 6) / img.width, (FOTO - 6) / img.height);
      const w = img.width * s, h = img.height * s;
      c.page.drawImage(img, { x: M + (FOTO - w) / 2, y: H - topo - FOTO + (FOTO - h) / 2, width: w, height: h });
    } else texto(c, "sem foto", M + 26, 8, { cor: CINZA, dy: FOTO / 2 - 4 });
    for (const l of titulo) { texto(c, l, xT, 12, { negrito: true }); c.y += 15; }
    texto(c, [`SKU ${n.sku ?? it.msku}`, `${num(it.q)} un`, it.validade ? `validade ${dataBR(it.validade)}` : null, it.fnsku ? `FNSKU ${it.fnsku}` : null]
      .filter(Boolean).join("   ·   "), xT, 9, { cor: CINZA, larg: larg });
    c.y += 16;
    for (const f of fs) {
      const forte = `${num(f.volumes)} ${f.volumes === 1 ? "volume" : "volumes"} com ${num(f.un)} un cada`;
      const wf = c.fb.widthOfTextAtSize(limpo(forte), 13) + 12;
      texto(c, forte, xT, 13, { negrito: true });
      texto(c, medidas(f.cx), xT + wf, 10, { cor: CINZA, dy: 2.5, larg: larg - wf });
      c.y += 19;
    }
    if (especial.length) {
      const s = `ATENCAO - preparo: ${especial.map((p) => preparo(p.tipo)).join(" + ")}`;
      const w = Math.min(larg, c.fb.widthOfTextAtSize(limpo(s), 9.5) + 12);
      c.page.drawRectangle({ x: xT, y: H - c.y - 15, width: w, height: 15, color: rgb(1, 0.95, 0.8) });
      texto(c, s, xT + 6, 9.5, { negrito: true, dy: 3, larg: larg - 12 });
      c.y += 20;
    }
    c.y = Math.max(c.y, topo + FOTO) + 12;
    c.page.drawLine({ start: { x: M, y: H - c.y + 6 }, end: { x: M + W, y: H - c.y + 6 }, thickness: 0.5, color: LINHA });
  }

  if (mistas.size) {
    if (c.y + 40 > H - M) novaPagina(c, d.fba);
    texto(c, "Volumes com mais de um produto", M, 11, { negrito: true });
    c.y += 18;
    for (const g of mistas.values()) {
      const s = `${num(g.volumes)} ${g.volumes === 1 ? "volume" : "volumes"} com ${g.cx.itens.map((i) => `${i.q} un ${nome(i.msku).sku ?? i.msku}`).join(" + ")}`;
      for (const l of quebrar(c.fb, s, 11, W, 3)) { if (c.y + 16 > H - M) novaPagina(c, d.fba); texto(c, l, M, 11, { negrito: true }); c.y += 14; }
      texto(c, medidas(g.cx), M, 9.5, { cor: CINZA });
      c.y += 18;
    }
  }

  const paginas = pdf.getPages();
  paginas.forEach((p, i) => p.drawText(`${d.fba} · folha PREP ${i + 1}/${paginas.length}`, { x: M, y: 18, size: 7.5, font: c.f, color: CINZA }));
  return await pdf.save();
}
