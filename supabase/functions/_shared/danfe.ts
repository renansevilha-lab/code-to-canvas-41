// ============================================================================
// DANFE (A4 retrato) gerado a partir do XML da NF-e — 21/out/2026, pedido do dono.
// A Amazon entrega só o XML da nota de remessa do envio ao FBA (Invoices API); este arquivo monta o PDF com os
// blocos do DANFE: canhoto, emitente + chave com código de barras (Code 128C), natureza/protocolo, destinatário,
// cálculo do imposto, transportador/volumes, produtos (com páginas a mais se precisar) e dados adicionais.
// Sem dependência de Deno: o mesmo arquivo roda em teste local trocando o import do pdf-lib.
// ============================================================================
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// ---------------------------------------------------------------- leitura do XML
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const des = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
/** Conteúdo do 1º <tag …>…</tag> (com o nome sem prefixo de namespace). */
function bloco(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m?.[1] ?? "";
}
function blocos(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g"))].map((m) => m[1]);
}
const val = (xml: string, tag: string) => des(bloco(xml, tag).trim());

// ---------------------------------------------------------------- formatação
const num = (s: string) => (s === "" ? null : Number(s));
const moeda = (s: string) => {
  const n = num(s);
  return n == null || isNaN(n) ? "" : n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const qtd = (s: string) => {
  const n = num(s);
  return n == null || isNaN(n) ? "" : n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
};
const so = (s: string) => s.replace(/\D/g, "");
function doc(s: string) {
  const d = so(s);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return s;
}
const cep = (s: string) => (so(s).length === 8 ? so(s).replace(/^(\d{5})(\d{3})$/, "$1-$2") : s);
const data = (s: string) => (/^\d{4}-\d{2}-\d{2}/.test(s) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const hora = (s: string) => (/T\d{2}:\d{2}:\d{2}/.test(s) ? s.slice(11, 19) : "");
const FRETE: Record<string, string> = {
  "0": "0-Por conta do Remet (CIF)", "1": "1-Por conta do Dest (FOB)", "2": "2-Por conta de Terceiros",
  "3": "3-Próprio Remetente", "4": "4-Próprio Destinatário", "9": "9-Sem Ocorrência de Transporte",
};
/** As fontes padrão do PDF só desenham WinAnsi: o resto vira espaço (aspas tipográficas viram aspas simples). */
const limpo = (s: string) => s.normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, " ");

// ---------------------------------------------------------------- Code 128C (só dígitos, número par)
const BARS = ["11011001100","11001101100","11001100110","10010011000","10010001100","10001001100","10011001000","10011000100","10001100100","11001001000","11001000100","11000100100","10110011100","10011011100","10011001110","10111001100","10011101100","10011100110","11001110010","11001011100","11001001110","11011100100","11001110100","11101101110","11101001100","11100101100","11100100110","11101100100","11100110100","11100110010","11011011000","11011000110","11000110110","10100011000","10001011000","10001000110","10110001000","10001101000","10001100010","11010001000","11000101000","11000100010","10110111000","10110001110","10001101110","10111011000","10111000110","10001110110","11101110110","11010001110","11000101110","11011101000","11011100010","11011101110","11101011000","11101000110","11100010110","11101101000","11101100010","11100011010","11101111010","11001000010","11110001010","10100110000","10100001100","10010110000","10010000110","10000101100","10000100110","10110010000","10110000100","10011010000","10011000010","10000110100","10000110010","11000010010","11001010000","11110111010","11000010100","10001111010","10100111100","10010111100","10010011110","10111100100","10011110100","10011110010","11110100100","11110010100","11110010010","11011011110","11011110110","11110110110","10101111000","10100011110","10001011110","10111101000","10111100010","11110101000","11110100010","10111011110","10111101110","11101011110","11110101110","11010000100","11010010000","11010011100","1100011101011"];
export function code128c(digitos: string): string {
  const d = so(digitos);
  if (!d || d.length % 2) throw new Error("código 128C precisa de número par de dígitos");
  const vals = [105];
  for (let i = 0; i < d.length; i += 2) vals.push(Number(d.slice(i, i + 2)));
  let soma = 105;
  for (let i = 1; i < vals.length; i++) soma += vals[i] * i;
  vals.push(soma % 103);
  return vals.map((v) => BARS[v]).join("") + BARS[106];
}

// ---------------------------------------------------------------- desenho
type Ctx = { page: PDFPage; f: PDFFont; fb: PDFFont; H: number };
const PRETO = rgb(0, 0, 0);
const M = 20; // margem
const W = 595.28 - 2 * M; // largura útil

function cortar(f: PDFFont, s: string, tam: number, larg: number): string {
  let t = limpo(s);
  if (f.widthOfTextAtSize(t, tam) <= larg) return t;
  while (t.length > 1 && f.widthOfTextAtSize(`${t}…`.replace("…", "..."), tam) > larg) t = t.slice(0, -1);
  return `${t}...`;
}
function quebrar(f: PDFFont, s: string, tam: number, larg: number, max = 99): string[] {
  const linhas: string[] = [];
  for (const par of limpo(s).split(/\n/)) {
    let atual = "";
    for (const p of par.split(/\s+/).filter(Boolean)) {
      const tenta = atual ? `${atual} ${p}` : p;
      if (f.widthOfTextAtSize(tenta, tam) <= larg) { atual = tenta; continue; }
      if (atual) linhas.push(atual);
      atual = f.widthOfTextAtSize(p, tam) <= larg ? p : cortar(f, p, tam, larg);
    }
    if (atual) linhas.push(atual);
  }
  if (linhas.length > max) { const r = linhas.slice(0, max); r[max - 1] = cortar(f, `${r[max - 1]} …`, tam, larg); return r; }
  return linhas;
}
/** Retângulo com rótulo pequeno em cima e o valor embaixo; y = topo (de cima para baixo). */
function caixa(c: Ctx, x: number, y: number, w: number, h: number, rotulo: string, valor = "", o: { alinhar?: "e" | "d" | "c"; tam?: number; negrito?: boolean } = {}) {
  c.page.drawRectangle({ x, y: c.H - y - h, width: w, height: h, borderColor: PRETO, borderWidth: 0.5 });
  if (rotulo) c.page.drawText(cortar(c.f, rotulo, 5, w - 3), { x: x + 1.5, y: c.H - y - 6, size: 5, font: c.f });
  if (valor) {
    const tam = o.tam ?? 7.5;
    const fonte = o.negrito ? c.fb : c.f;
    const t = cortar(fonte, valor, tam, w - 4);
    const tw = fonte.widthOfTextAtSize(t, tam);
    const tx = o.alinhar === "d" ? x + w - 2 - tw : o.alinhar === "c" ? x + (w - tw) / 2 : x + 2;
    c.page.drawText(t, { x: tx, y: c.H - y - h + 3, size: tam, font: fonte });
  }
}
function texto(c: Ctx, s: string, x: number, y: number, tam: number, negrito = false, larg?: number) {
  const fonte = negrito ? c.fb : c.f;
  c.page.drawText(larg ? cortar(fonte, s, tam, larg) : limpo(s), { x, y: c.H - y - tam, size: tam, font: fonte });
}
function centro(c: Ctx, s: string, x: number, y: number, w: number, tam: number, negrito = false) {
  const fonte = negrito ? c.fb : c.f;
  const t = cortar(fonte, s, tam, w);
  c.page.drawText(t, { x: x + (w - fonte.widthOfTextAtSize(t, tam)) / 2, y: c.H - y - tam, size: tam, font: fonte });
}
function titulo(c: Ctx, s: string, y: number) { texto(c, s, M, y, 6.5, true); }

// colunas da tabela de produtos (soma = W)
const COLS: { r: string; w: number; a: "e" | "d" | "c" }[] = [
  { r: "CÓDIGO", w: 46, a: "e" }, { r: "DESCRIÇÃO DO PRODUTO / SERVIÇO", w: 150, a: "e" }, { r: "NCM/SH", w: 38, a: "c" },
  { r: "CST", w: 20, a: "c" }, { r: "CFOP", w: 22, a: "c" }, { r: "UN", w: 18, a: "c" }, { r: "QUANT.", w: 36, a: "d" },
  { r: "V. UNIT.", w: 40, a: "d" }, { r: "V. TOTAL", w: 42, a: "d" }, { r: "BC ICMS", w: 40, a: "d" }, { r: "V. ICMS", w: 34, a: "d" },
  { r: "V. IPI", w: 28, a: "d" }, { r: "ALÍQ. ICMS", w: 20.28, a: "d" }, { r: "ALÍQ. IPI", w: 20, a: "d" },
];

export async function gerarDanfe(xml: string): Promise<Uint8Array> {
  const inf = bloco(xml, "infNFe");
  if (!inf) throw new Error("XML sem infNFe");
  const ide = bloco(inf, "ide"), emit = bloco(inf, "emit"), dest = bloco(inf, "dest");
  const ee = bloco(emit, "enderEmit"), ed = bloco(dest, "enderDest");
  const tot = bloco(bloco(inf, "total"), "ICMSTot");
  const transp = bloco(inf, "transp"), tr = bloco(transp, "transporta"), vol = bloco(transp, "vol"), veic = bloco(transp, "veicTransp");
  const prot = bloco(xml, "infProt");
  const chave = so(val(prot, "chNFe")) || so(inf.length ? (xml.match(/Id="NFe(\d{44})"/)?.[1] ?? "") : "");
  const nNF = so(val(ide, "nNF")).padStart(9, "0").replace(/^(\d{3})(\d{3})(\d{3})$/, "$1.$2.$3");
  const serie = val(ide, "serie");
  const dhEmi = val(ide, "dhEmi") || val(ide, "dEmi");
  const dhSai = val(ide, "dhSaiEnt") || val(ide, "dSaiEnt");
  const itens = blocos(inf, "det").map((d) => {
    const p = bloco(d, "prod");
    const icms = bloco(bloco(d, "imposto"), "ICMS");
    const ipi = bloco(bloco(d, "imposto"), "IPI");
    const cst = val(icms, "CSOSN") || `${val(icms, "orig")}${val(icms, "CST")}`;
    const adProd = val(d, "infAdProd");
    return {
      cod: val(p, "cProd"), desc: adProd ? `${val(p, "xProd")} ${adProd}` : val(p, "xProd"), ncm: val(p, "NCM"), cst, cfop: val(p, "CFOP"), un: val(p, "uCom"),
      q: qtd(val(p, "qCom")), vu: moeda(val(p, "vUnCom")), vt: moeda(val(p, "vProd")),
      bc: moeda(val(icms, "vBC")), vicms: moeda(val(icms, "vICMS")), vipi: moeda(val(ipi, "vIPI")),
      aicms: qtd(val(icms, "pICMS")), aipi: qtd(val(ipi, "pIPI")),
    };
  });

  const pdf = await PDFDocument.create();
  pdf.setTitle(`DANFE ${nNF} série ${serie}`);
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const fb = await pdf.embedFont(StandardFonts.HelveticaBold);
  const novaPagina = (): Ctx => { const page = pdf.addPage([595.28, 841.89]); return { page, f, fb, H: 841.89 }; };
  let c = novaPagina();
  let y = M;

  // canhoto
  const nomeEmit = val(emit, "xNome");
  caixa(c, M, y, W - 100, 22, `RECEBEMOS DE ${nomeEmit} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO`);
  caixa(c, M + W - 100, y, 100, 44, "");
  centro(c, "NF-e", M + W - 100, y + 6, 100, 9, true);
  centro(c, `Nº ${nNF}`, M + W - 100, y + 19, 100, 8, true);
  centro(c, `SÉRIE ${serie}`, M + W - 100, y + 30, 100, 8, true);
  caixa(c, M, y + 22, 110, 22, "DATA DE RECEBIMENTO");
  caixa(c, M + 110, y + 22, W - 210, 22, "IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR");
  y += 44;
  c.page.drawLine({ start: { x: M, y: c.H - y - 5 }, end: { x: M + W, y: c.H - y - 5 }, thickness: 0.5, dashArray: [3, 2], color: PRETO });
  y += 10;

  // cabeçalho: emitente | DANFE | código de barras + chave
  const hCab = 112;
  const wEmit = 220, wDanfe = 95, wChave = W - wEmit - wDanfe;
  caixa(c, M, y, wEmit, hCab, "IDENTIFICAÇÃO DO EMITENTE");
  let ly = y + 14;
  for (const l of quebrar(fb, nomeEmit, 9, wEmit - 8, 3)) { centro(c, l, M, ly, wEmit, 9, true); ly += 11; }
  ly += 3;
  const end1 = [val(ee, "xLgr"), val(ee, "nro"), val(ee, "xCpl")].filter(Boolean).join(", ");
  for (const l of [end1, [val(ee, "xBairro"), cep(val(ee, "CEP"))].filter(Boolean).join(" - "),
    `${val(ee, "xMun")} - ${val(ee, "UF")}`, val(ee, "fone") ? `Fone: ${val(ee, "fone")}` : ""].filter(Boolean)) {
    for (const q of quebrar(f, l, 7, wEmit - 8, 2)) { centro(c, q, M, ly, wEmit, 7); ly += 9; }
  }
  const xD = M + wEmit;
  caixa(c, xD, y, wDanfe, hCab, "");
  centro(c, "DANFE", xD, y + 6, wDanfe, 12, true);
  centro(c, "Documento Auxiliar da", xD, y + 21, wDanfe, 6.5);
  centro(c, "Nota Fiscal Eletrônica", xD, y + 29, wDanfe, 6.5);
  texto(c, "0 - ENTRADA", xD + 8, y + 42, 6.5);
  texto(c, "1 - SAÍDA", xD + 8, y + 51, 6.5);
  c.page.drawRectangle({ x: xD + wDanfe - 26, y: c.H - y - 58, width: 16, height: 16, borderColor: PRETO, borderWidth: 0.7 });
  centro(c, val(ide, "tpNF"), xD + wDanfe - 26, y + 45, 16, 10, true);
  centro(c, `Nº ${nNF}`, xD, y + 68, wDanfe, 8, true);
  centro(c, `SÉRIE ${serie}`, xD, y + 79, wDanfe, 8, true);
  const xC = xD + wDanfe;
  caixa(c, xC, y, wChave, 46, "");
  if (chave.length === 44) {
    const barras = code128c(chave);
    const bw = Math.min(0.85, (wChave - 16) / barras.length);
    const bx = xC + (wChave - bw * barras.length) / 2;
    for (let i = 0; i < barras.length; i++) {
      if (barras[i] === "1") c.page.drawRectangle({ x: bx + i * bw, y: c.H - y - 41, width: bw, height: 34, color: PRETO });
    }
  }
  caixa(c, xC, y + 46, wChave, 22, "CHAVE DE ACESSO", chave.replace(/(\d{4})(?=\d)/g, "$1 "), { alinhar: "c", tam: 7.5, negrito: true });
  caixa(c, xC, y + 68, wChave, hCab - 68, "");
  centro(c, "Consulta de autenticidade no portal nacional da NF-e", xC, y + 78, wChave, 7);
  centro(c, "www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora", xC, y + 88, wChave, 7);
  y += hCab;

  const protTxt = [val(prot, "nProt"), val(prot, "dhRecbto") ? `${data(val(prot, "dhRecbto"))} ${hora(val(prot, "dhRecbto"))}` : ""].filter(Boolean).join(" - ");
  caixa(c, M, y, wEmit + wDanfe, 20, "NATUREZA DA OPERAÇÃO", val(ide, "natOp"));
  caixa(c, xC, y, wChave, 20, "PROTOCOLO DE AUTORIZAÇÃO DE USO", protTxt, { alinhar: "c" });
  y += 20;
  const t3 = W / 3;
  caixa(c, M, y, t3, 20, "INSCRIÇÃO ESTADUAL", val(emit, "IE"));
  caixa(c, M + t3, y, t3, 20, "INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.", val(emit, "IEST"));
  caixa(c, M + 2 * t3, y, t3, 20, "CNPJ", doc(val(emit, "CNPJ") || val(emit, "CPF")));
  y += 24;

  // destinatário / remetente
  titulo(c, "DESTINATÁRIO / REMETENTE", y); y += 8;
  caixa(c, M, y, 330, 20, "NOME / RAZÃO SOCIAL", val(dest, "xNome"));
  caixa(c, M + 330, y, 130, 20, "CNPJ / CPF", doc(val(dest, "CNPJ") || val(dest, "CPF")));
  caixa(c, M + 460, y, W - 460, 20, "DATA DA EMISSÃO", data(dhEmi), { alinhar: "c" });
  y += 20;
  caixa(c, M, y, 270, 20, "ENDEREÇO", [val(ed, "xLgr"), val(ed, "nro"), val(ed, "xCpl")].filter(Boolean).join(", "));
  caixa(c, M + 270, y, 120, 20, "BAIRRO / DISTRITO", val(ed, "xBairro"));
  caixa(c, M + 390, y, 70, 20, "CEP", cep(val(ed, "CEP")), { alinhar: "c" });
  caixa(c, M + 460, y, W - 460, 20, "DATA DA SAÍDA/ENTRADA", data(dhSai), { alinhar: "c" });
  y += 20;
  caixa(c, M, y, 220, 20, "MUNICÍPIO", val(ed, "xMun"));
  caixa(c, M + 220, y, 110, 20, "FONE / FAX", val(ed, "fone"));
  caixa(c, M + 330, y, 30, 20, "UF", val(ed, "UF"), { alinhar: "c" });
  caixa(c, M + 360, y, 100, 20, "INSCRIÇÃO ESTADUAL", val(dest, "IE"));
  caixa(c, M + 460, y, W - 460, 20, "HORA DA SAÍDA/ENTRADA", hora(dhSai), { alinhar: "c" });
  y += 24;

  // cálculo do imposto
  titulo(c, "CÁLCULO DO IMPOSTO", y); y += 8;
  const linha = (cols: [string, string][]) => {
    const w = W / cols.length;
    cols.forEach(([r, v], i) => caixa(c, M + i * w, y, w, 20, r, v, { alinhar: "d" }));
    y += 20;
  };
  linha([["BASE DE CÁLC. DO ICMS", moeda(val(tot, "vBC"))], ["VALOR DO ICMS", moeda(val(tot, "vICMS"))], ["BASE DE CÁLC. ICMS S.T.", moeda(val(tot, "vBCST"))],
    ["VALOR DO ICMS SUBST.", moeda(val(tot, "vST"))], ["V. IMP. IMPORTAÇÃO", moeda(val(tot, "vII"))], ["V. TOTAL PRODUTOS", moeda(val(tot, "vProd"))]]);
  linha([["VALOR DO FRETE", moeda(val(tot, "vFrete"))], ["VALOR DO SEGURO", moeda(val(tot, "vSeg"))], ["DESCONTO", moeda(val(tot, "vDesc"))],
    ["OUTRAS DESPESAS", moeda(val(tot, "vOutro"))], ["VALOR TOTAL IPI", moeda(val(tot, "vIPI"))], ["V. TOTAL DA NOTA", moeda(val(tot, "vNF"))]]);
  y += 4;

  // transportador / volumes
  titulo(c, "TRANSPORTADOR / VOLUMES TRANSPORTADOS", y); y += 8;
  caixa(c, M, y, 200, 20, "NOME / RAZÃO SOCIAL", val(tr, "xNome"));
  caixa(c, M + 200, y, 100, 20, "FRETE", FRETE[val(transp, "modFrete")] ?? val(transp, "modFrete"));
  caixa(c, M + 300, y, 60, 20, "CÓDIGO ANTT", val(veic, "RNTC"));
  caixa(c, M + 360, y, 60, 20, "PLACA DO VEÍCULO", val(veic, "placa"));
  caixa(c, M + 420, y, 25, 20, "UF", val(veic, "UF"), { alinhar: "c" });
  caixa(c, M + 445, y, W - 445, 20, "CNPJ / CPF", doc(val(tr, "CNPJ") || val(tr, "CPF")));
  y += 20;
  caixa(c, M, y, 300, 20, "ENDEREÇO", val(tr, "xEnder"));
  caixa(c, M + 300, y, 120, 20, "MUNICÍPIO", val(tr, "xMun"));
  caixa(c, M + 420, y, 25, 20, "UF", val(tr, "UF"), { alinhar: "c" });
  caixa(c, M + 445, y, W - 445, 20, "INSCRIÇÃO ESTADUAL", val(tr, "IE"));
  y += 20;
  const w6 = W / 6;
  [["QUANTIDADE", qtd(val(vol, "qVol"))], ["ESPÉCIE", val(vol, "esp")], ["MARCA", val(vol, "marca")], ["NUMERAÇÃO", val(vol, "nVol")],
    ["PESO BRUTO", qtd(val(vol, "pesoB"))], ["PESO LÍQUIDO", qtd(val(vol, "pesoL"))]]
    .forEach(([r, v], i) => caixa(c, M + i * w6, y, w6, 20, r, v, { alinhar: i === 0 || i >= 4 ? "d" : "e" }));
  y += 24;

  // produtos
  const cabecalhoItens = () => {
    titulo(c, "DADOS DO PRODUTO / SERVIÇO", y); y += 8;
    let x = M;
    for (const col of COLS) {
      c.page.drawRectangle({ x, y: c.H - y - 14, width: col.w, height: 14, borderColor: PRETO, borderWidth: 0.5 });
      for (const [k, l] of quebrar(fb, col.r, 4.6, col.w - 2, 2).entries()) centro(c, l, x, y + 2 + k * 5.5, col.w, 4.6, true);
      x += col.w;
    }
    y += 14;
  };
  const adic = bloco(inf, "infAdic");
  const pedido = val(bloco(inf, "compra"), "xPed");
  const infCpl = [val(adic, "infAdFisco") ? `Inf. fisco: ${val(adic, "infAdFisco")}` : "",
    val(adic, "infCpl") ? `Inf. contribuinte: ${val(adic, "infCpl")}` : "", pedido ? `Pedido: ${pedido}` : ""].filter(Boolean).join("\n");
  const linhasAdic = quebrar(f, infCpl, 6.5, W - 160 - 6);
  const hAdic = Math.max(60, 14 + linhasAdic.length * 8);
  cabecalhoItens();
  const topoItens = y;
  const fim = () => c.H - M - hAdic - 14;
  for (const it of itens) {
    const desc = quebrar(f, it.desc, 6.5, COLS[1].w - 4, 4);
    const h = Math.max(11, 3 + desc.length * 7.5);
    if (y + h > fim()) {
      c.page.drawRectangle({ x: M, y: c.H - y, width: W, height: y - topoItens, borderColor: PRETO, borderWidth: 0.5 });
      c = novaPagina(); y = M;
      cabecalhoItens();
    }
    let x = M;
    const vals = [it.cod, "", it.ncm, it.cst, it.cfop, it.un, it.q, it.vu, it.vt, it.bc, it.vicms, it.vipi, it.aicms, it.aipi];
    COLS.forEach((col, i) => {
      if (i === 1) desc.forEach((l, k) => texto(c, l, x + 2, y + 2 + k * 7.5, 6.5));
      else if (vals[i]) {
        const t = cortar(f, vals[i], 6.5, col.w - 3);
        const tw = f.widthOfTextAtSize(t, 6.5);
        const tx = col.a === "d" ? x + col.w - 1.5 - tw : col.a === "c" ? x + (col.w - tw) / 2 : x + 1.5;
        c.page.drawText(t, { x: tx, y: c.H - y - 8.5, size: 6.5, font: f });
      }
      c.page.drawLine({ start: { x, y: c.H - y }, end: { x, y: c.H - y - h }, thickness: 0.3, color: PRETO });
      x += col.w;
    });
    c.page.drawLine({ start: { x: M + W, y: c.H - y }, end: { x: M + W, y: c.H - y - h }, thickness: 0.3, color: PRETO });
    y += h;
    c.page.drawLine({ start: { x: M, y: c.H - y }, end: { x: M + W, y: c.H - y }, thickness: 0.2, color: rgb(0.6, 0.6, 0.6) });
  }
  c.page.drawRectangle({ x: M, y: c.H - y, width: W, height: y - topoItens, borderColor: PRETO, borderWidth: 0.5 });

  // dados adicionais (no pé da última página)
  y = c.H - M - hAdic - 8;
  titulo(c, "DADOS ADICIONAIS", y); y += 8;
  caixa(c, M, y, W - 160, hAdic, "INFORMAÇÕES COMPLEMENTARES");
  linhasAdic.forEach((l, k) => texto(c, l, M + 3, y + 9 + k * 8, 6.5));
  caixa(c, M + W - 160, y, 160, hAdic, "RESERVADO AO FISCO");

  // numeração das folhas
  const paginas = pdf.getPages();
  paginas.forEach((p, i) => {
    if (i === 0) {
      const t = `FOLHA 1/${paginas.length}`;
      p.drawText(t, { x: xD + (wDanfe - f.widthOfTextAtSize(t, 7)) / 2, y: p.getHeight() - (M + 54 + 92) - 7, size: 7, font: f });
    } else {
      p.drawText(`NF-e Nº ${nNF} Série ${serie} - FOLHA ${i + 1}/${paginas.length}`, { x: M, y: p.getHeight() - M + 6, size: 7, font: fb });
    }
  });
  return await pdf.save();
}
