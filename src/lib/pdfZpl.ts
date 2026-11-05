// PDF → ZPL no navegador (05/nov/2026, PrintNode fora). O agente da bancada só
// manda ZPL cru à Zebra; PDF (etiqueta de produto da Amazon, etiquetas das
// caixas do FBA) é desenhado aqui a 203 dpi, cada página vira uma imagem
// preto-e-branco (^GFA com a compressão ASCII da Zebra) e vai pela mesma fila.
// Página maior que a etiqueta 10×15 é reduzida para caber (812×1218 pontos).

const DPI = 203;
const MAX_L = 812;
const MAX_A = 1218;
const LIMIAR = 150; // 0–255: abaixo disto o ponto sai preto

/** Contagem de repetição no formato da Zebra (G–Y = 1–19, g–z = 20–400). */
function codigoRepeticao(n: number): string {
  let s = "";
  while (n > 400) { s += "z"; n -= 400; }
  if (n >= 20) { s += String.fromCharCode("g".charCodeAt(0) + Math.floor(n / 20) - 1); n %= 20; }
  if (n > 0) s += String.fromCharCode("G".charCodeAt(0) + n - 1);
  return s;
}

/** Compressão ASCII de uma linha em hex (repetições, "," = resto da linha em branco). */
function comprimirLinha(hex: string): string {
  const semZeros = hex.replace(/0+$/, "");
  if (!semZeros.length) return ",";
  let out = "";
  for (let i = 0; i < semZeros.length; ) {
    const c = semZeros[i];
    let j = i + 1;
    while (j < semZeros.length && semZeros[j] === c) j++;
    const n = j - i;
    out += n > 1 ? codigoRepeticao(n) + c : c;
    i = j;
  }
  return semZeros.length < hex.length ? out + "," : out;
}

/** Imagem RGBA → um bloco ^XA…^XZ com ^GFA comprimido. */
export function imagemParaZpl(px: Uint8ClampedArray, largura: number, altura: number): string {
  const bpl = Math.ceil(largura / 8);
  const HEX = "0123456789ABCDEF";
  let dados = "";
  let anterior = "";
  for (let y = 0; y < altura; y++) {
    let linha = "";
    for (let b = 0; b < bpl; b++) {
      let byte = 0;
      for (let k = 0; k < 8; k++) {
        const x = b * 8 + k;
        if (x >= largura) continue;
        const o = (y * largura + x) * 4;
        const a = px[o + 3] / 255;
        const lum = 255 - a * (255 - (0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]));
        if (lum < LIMIAR) byte |= 0x80 >> k;
      }
      linha += HEX[byte >> 4] + HEX[byte & 15];
    }
    dados += linha === anterior ? ":" : comprimirLinha(linha);
    anterior = linha;
  }
  const total = bpl * altura;
  return `^XA^PW${largura}^LL${altura}^LH0,0^FO0,0^GFA,${total},${total},${bpl},${dados}^FS^XZ`;
}

/** Escala (pontos de PDF → pontos da Zebra) que cabe na etiqueta 10×15. */
export function escalaPagina(larguraPt: number, alturaPt: number): number {
  const esc = DPI / 72;
  return esc * Math.min(1, MAX_L / (larguraPt * esc), MAX_A / (alturaPt * esc));
}

/** Converte o PDF inteiro (uma etiqueta por página) em ZPL. Só no navegador. */
export async function pdfParaZpl(bytes: Uint8Array): Promise<{ zpl: string; paginas: number }> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const partes: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pag = await doc.getPage(p);
    const base = pag.getViewport({ scale: 1 });
    const vp = pag.getViewport({ scale: escalaPagina(base.width, base.height) });
    const largura = Math.ceil(vp.width);
    const altura = Math.ceil(vp.height);
    const canvas = document.createElement("canvas");
    canvas.width = largura;
    canvas.height = altura;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("o navegador não deu acesso ao desenho (canvas)");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, largura, altura);
    await pag.render({ canvasContext: ctx, viewport: vp }).promise;
    partes.push(imagemParaZpl(ctx.getImageData(0, 0, largura, altura).data, largura, altura));
    pag.cleanup();
  }
  await doc.destroy();
  return { zpl: partes.join("\n"), paginas: partes.length };
}
