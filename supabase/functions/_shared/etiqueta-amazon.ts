// Etiquetas das caixas da Amazon (v0 getLabels, PackageLabel_Thermal) — página da transportadora em pé.
//
// O PDF da Amazon traz 2 páginas por caixa, as duas 4,25 × 6 pol (306 × 432 pt): a etiqueta FBA (desenhada em pé)
// e a da transportadora parceira (Total Express), que é UMA imagem 4 × 6 em pé (1200 × 1800 px) que o próprio
// PDF desenha DEITADA e encolhida (cm "0 -162.67 244 0 31 330.83", 8,6 × 5,7 cm no meio da página). Visto na tela
// e impresso na Zebra, a etiqueta sai de lado e pequena (relato do dono, 22/out/2026).
// Aqui: página cujo conteúdo é uma imagem só, desenhada com rotação de 90° (a = d = 0 na matriz), é redesenhada
// em pé, centralizada e do maior tamanho que cabe na página. O resto do PDF não muda.
// Sem dependência de Deno: o mesmo arquivo roda em teste local trocando o import do pdf-lib.
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "https://esm.sh/pdf-lib@1.17.1";

const DESENHO = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm\s*\/([\w.-]+)\s+Do/g;

function textoDoConteudo(doc: PDFDocument, contents: unknown): string | null {
  const lista = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  let s = "";
  for (const st of lista) {
    if (!(st instanceof PDFRawStream)) return null;
    s += new TextDecoder("latin1").decode(decodePDFRawStream(st).decode());
  }
  return s;
}

/** Devolve o PDF com as etiquetas da transportadora em pé e quantas páginas mudaram (0 = devolve o original). */
export async function endireitarEtiquetasAmazon(bytes: Uint8Array): Promise<{ bytes: Uint8Array; corrigidas: number }> {
  const doc = await PDFDocument.load(bytes);
  let corrigidas = 0;
  for (const pg of doc.getPages()) {
    const bruto = pg.node.get(PDFName.of("Contents"));
    if (!bruto) continue;
    const s = textoDoConteudo(doc, doc.context.lookup(bruto) ?? bruto);
    if (s == null) continue;
    const desenhos = [...s.matchAll(DESENHO)];
    if (desenhos.length !== 1) continue; // só a página que é uma imagem e nada mais
    const [, a, , , d, , , nome] = desenhos[0];
    if (Number(a) !== 0 || Number(d) !== 0) continue; // já está em pé
    const xo = pg.node.Resources()?.get(PDFName.of("XObject"));
    const im = xo ? doc.context.lookup((xo as any).get(PDFName.of(nome))) : null;
    const iw = Number((im as any)?.dict?.get(PDFName.of("Width"))?.toString());
    const ih = Number((im as any)?.dict?.get(PDFName.of("Height"))?.toString());
    if (!(iw > 0 && ih > 0)) continue;
    const { width: W, height: H } = pg.getSize();
    const esc = Math.min(W / iw, H / ih);
    const w = iw * esc, h = ih * esc, x = (W - w) / 2, y = (H - h) / 2;
    const conteudo = doc.context.flateStream(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${nome} Do Q\n`);
    pg.node.set(PDFName.of("Contents"), doc.context.register(conteudo));
    corrigidas++;
  }
  if (!corrigidas) return { bytes, corrigidas: 0 };
  return { bytes: await doc.save(), corrigidas };
}
