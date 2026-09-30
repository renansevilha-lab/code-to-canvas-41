import { formatNumber } from "@/lib/format";

// ============================================================================
// Leitura do XML da NF-e (nfeProc/NFe/infNFe) no navegador — usada no
// recebimento de compras (entrada numa OC existente e nova entrada por NF).
// ============================================================================

export interface ItemXml {
  n: number;
  cProd: string;
  ean: string | null; // normalizado (sem zeros à esquerda); null = "SEM GTIN"
  eanTrib: string | null;
  xProd: string;
  uCom: string;
  qCom: number;
  uTrib: string;
  qTrib: number;
  vProd: number;
}
export interface NfXml {
  chave: string | null;
  numero: string; // sem zeros à esquerda
  numeroBruto: string; // como veio no nNF
  serie: string;
  emissao: string | null;
  emitente: string; // fantasia || razão social
  razaoSocial: string;
  cnpj: string;
  valor: number;
  itens: ItemXml[];
}

const n = (s: string | null | undefined): number => {
  const v = Number(String(s ?? "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

export const soDigitos = (s: string | null | undefined): string | null => {
  const d = String(s ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return d.length >= 8 ? d : null; // "SEM GTIN", vazio, lixo
};

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const tokens = (s: string | null | undefined) =>
  new Set(semAcento(String(s ?? "")).split(/[^a-z0-9]+/).filter((t) => t.length >= 3));

/** Fração das palavras do menor texto que aparecem no outro (0..1). */
export function similaridade(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const w of ta) if (tb.has(w)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

const UNIDADE = /^(UN|UND|UNID|UNIDADE|PC|PCS|PÇ|PEC|PECA|PEÇA)$/i;

export function parseNfe(texto: string): NfXml {
  const doc = new DOMParser().parseFromString(texto, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("Arquivo não é um XML válido.");
  const inf = doc.getElementsByTagName("infNFe")[0];
  if (!inf) throw new Error("Não é o XML de uma NF-e (sem infNFe).");
  const t = (el: Element | undefined, tag: string) => el?.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";
  const ide = inf.getElementsByTagName("ide")[0];
  const emit = inf.getElementsByTagName("emit")[0];
  const tot = inf.getElementsByTagName("ICMSTot")[0];
  const itens: ItemXml[] = Array.from(inf.getElementsByTagName("det")).map((det, i) => {
    const p = det.getElementsByTagName("prod")[0];
    return {
      n: Number(det.getAttribute("nItem") ?? i + 1),
      cProd: t(p, "cProd"),
      ean: soDigitos(t(p, "cEAN")),
      eanTrib: soDigitos(t(p, "cEANTrib")),
      xProd: t(p, "xProd"),
      uCom: t(p, "uCom"),
      qCom: n(t(p, "qCom")),
      uTrib: t(p, "uTrib"),
      qTrib: n(t(p, "qTrib")),
      vProd: n(t(p, "vProd")),
    };
  });
  if (itens.length === 0) throw new Error("A NF-e não tem itens.");
  const id = inf.getAttribute("Id") ?? "";
  const emissao = (t(ide, "dhEmi") || t(ide, "dEmi")).slice(0, 10) || null;
  const razaoSocial = t(emit, "xNome");
  return {
    chave: /\d{44}/.exec(id)?.[0] ?? null,
    numero: String(Number(t(ide, "nNF")) || t(ide, "nNF")),
    numeroBruto: t(ide, "nNF"),
    serie: t(ide, "serie"),
    emissao,
    emitente: t(emit, "xFant") || razaoSocial,
    razaoSocial,
    cnpj: t(emit, "CNPJ") || t(emit, "CPF"),
    valor: n(t(tot, "vNF")),
    itens,
  };
}

/**
 * Quantas UNIDADES essa linha da NF representa. A NF pode vir em caixa/fardo:
 * usa a unidade tributável quando ela é "UN" (ou quando o casamento foi pelo
 * EAN tributável), senão o encaixotamento lembrado do SKU.
 */
export function unidadesDe(
  x: ItemXml, viaTrib: boolean, embUnidades: number | null | undefined,
): { q: number; nota: string | null } {
  if (viaTrib && x.qTrib > 0) return { q: x.qTrib, nota: `${formatNumber(x.qCom)} ${x.uCom} = ${formatNumber(x.qTrib)} ${x.uTrib}` };
  if (UNIDADE.test(x.uCom) || x.uCom === "") return { q: x.qCom, nota: null };
  if (UNIDADE.test(x.uTrib) && x.qTrib > 0 && x.qTrib !== x.qCom) {
    return { q: x.qTrib, nota: `${formatNumber(x.qCom)} ${x.uCom} = ${formatNumber(x.qTrib)} ${x.uTrib}` };
  }
  if (embUnidades && embUnidades > 1) {
    return { q: x.qCom * embUnidades, nota: `${formatNumber(x.qCom)} ${x.uCom} × ${embUnidades} (encaixotamento do SKU) — confira` };
  }
  return { q: x.qCom, nota: `NF em "${x.uCom}" — confira se são unidades` };
}
