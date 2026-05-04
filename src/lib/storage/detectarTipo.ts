/**
 * Detecção automática do tipo de relatório Shopee a partir do nome do arquivo.
 * (Inspeção do conteúdo é feita no próprio parser de cada módulo.)
 */

import JSZip from "jszip";

export type TipoArquivo = "vendas" | "ads" | "cmv" | "produtos" | "carteira";

const NOMES_VENDAS = ["order.all", "order_all"];
const NOMES_ADS = [
  "dados+gerais+de+anuncios",
  "dados_gerais_de_anuncios",
  "dados gerais de an",
  "dados-gerais-de-an",
  "dados gerais de anúncios",
];
const NOMES_CARTEIRA = [
  "balance_transaction",
  "balance.transaction",
  "balance transaction",
  "my_balance",
];
const NOMES_PRODUTOS = [
  "mass_update_basic",
  "mass.update.basic",
  "mass update basic",
  "mass_update_sales",
  "mass.update.sales",
  "mass update sales",
];
const NOMES_CMV = [
  "tiny_produtos",
  "tiny.produtos",
  "tiny-produtos",
  "gapbi-custos",
  "gapbi_custos",
  "gapbi custos",
  "custos",
  "cmv",
];

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function detectarTipoPorNome(nome: string): TipoArquivo | null {
  const n = norm(nome);
  if (NOMES_VENDAS.some((p) => n.includes(p))) return "vendas";
  if (NOMES_ADS.some((p) => n.includes(p))) return "ads";
  if (NOMES_CARTEIRA.some((p) => n.includes(p))) return "carteira";
  if (NOMES_PRODUTOS.some((p) => n.includes(p))) return "produtos";
  if (NOMES_CMV.some((p) => n.includes(p))) return "cmv";
  return null;
}

export async function detectarTipo(file: File): Promise<TipoArquivo | null> {
  const direto = detectarTipoPorNome(file.name);
  if (direto) return direto;

  // Zips: olha os nomes internos
  if (file.name.toLowerCase().endsWith(".zip")) {
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const t = detectarTipoPorNome(entry.name);
        if (t) return t;
      }
    } catch {
      /* ignora */
    }
  }
  return null;
}

export const ROTULOS: Record<TipoArquivo, string> = {
  vendas: "Vendas (Order.all)",
  ads: "Anúncios (Dados Gerais)",
  cmv: "CMV (custos)",
  produtos: "Catálogo (mass update)",
  carteira: "Carteira (extrato)",
};
