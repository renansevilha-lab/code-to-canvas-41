// Nome das opções de um produto com variações em que cada variação é kit de um produto base diferente
// (cor × quantidade). Fonte única: o diálogo que cria o produto no Tiny (CriarVariacoesCores) e o bloco que
// cria as variações na Shopee (VariacoesShopee) usam a MESMA regra.

export interface BaseRotulo { sku: string; nome: string; marca: string | null }

/** Até 20 letras (limite da opção na Shopee) sem cortar palavra no meio: "Higiene Face Olhos Focinho" → "Higiene Face Olhos". */
export function caber20(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length <= 20) return s;
  const palavras = s.split(" "); let out = "";
  for (const p of palavras) { if ((out ? out.length + 1 : 0) + p.length > 20) break; out = out ? `${out} ${p}` : p; }
  return out || s.slice(0, 20);
}
const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * "Carpete Autocolante 31X48cm [Bege]" → "Bege"; sem colchete, o que sobra do nome tirando o começo comum (palavras
 * inteiras), a quantidade do fim ("50 Un", "500ml") e a marca ("Pet Clean"), em até 20 letras sem cortar palavra.
 * 19/out: "Toalhas Umedecidas Cães Higiene Face Olhos Focinho 50un" saía "Higiene Face Olhos F" (o resto inteiro
 * cortado na 20ª letra) e "Limpa Popô Pet Clean 50 Un" levava a marca.
 */
export function rotulosDasCores(bases: BaseRotulo[]): { cores: { sku: string; rotulo: string }[]; comum: string; temCor: boolean } {
  const nomes = bases.map((b) => b.nome.replace(/\s+/g, " ").trim());
  let comum = nomes[0] ?? "";
  for (const n of nomes.slice(1)) { let i = 0; while (i < comum.length && i < n.length && comum[i] === n[i]) i++; comum = comum.slice(0, i); }
  // o começo comum só vale até a última palavra inteira ("Limpa Popô" × "Limpa Patas" não come o "P")
  if (nomes.some((n) => n.length > comum.length && n[comum.length] !== " ")) comum = comum.slice(0, comum.lastIndexOf(" ") + 1);
  const marcas = [...new Set(bases.map((b) => (b.marca ?? "").trim()).filter(Boolean))];
  let temCor = false;
  const cores = bases.map((b, i) => {
    const col = b.nome.match(/\[([^\]]+)\]\s*$/);
    if (col) { temCor = true; return { sku: b.sku, rotulo: caber20(col[1]) }; }
    let resto = nomes[i].slice(comum.length).replace(/^[\s\-–[(]+|[\s\])]+$/g, "");
    resto = resto.replace(/\s*[-–]?\s*\d+([.,]\d+)?\s*(un|und|unid|unidades?|pcs|p[çc]s|ml|l|g|gr|grs|kg)\.?$/i, "").trim();
    for (const m of marcas) {
      const i0 = semAcento(resto).indexOf(semAcento(m));
      if (i0 >= 0 && resto.length > m.length) resto = `${resto.slice(0, i0)} ${resto.slice(i0 + m.length)}`.replace(/\s+/g, " ").trim();
    }
    return { sku: b.sku, rotulo: caber20(resto || b.sku) };
  });
  return { cores, comum: comum.replace(/[\s\-–[(]+$/, "").trim(), temCor };
}

/** "Toalhas … 50 Un" → 50; sem contagem de unidades no fim do nome → null. */
export function unidadesDoNome(nome: string | null | undefined): number | null {
  const m = String(nome ?? "").match(/(\d+)\s*(un|und|unid|unidades?)\.?\s*$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 1 ? n : null;
}

/** Contagem de unidades por pacote quando TODOS os produtos base têm a mesma (a Shopee usa a mesma lista de
 *  quantidades para todos os tipos — pacotes de tamanhos diferentes dariam rótulos diferentes por tipo). */
export function unidadesComuns(nomes: (string | null | undefined)[]): number | null {
  const us = nomes.map(unidadesDoNome);
  return us.length && us.every((u) => u != null && u === us[0]) ? us[0] : null;
}

/** Opção do grupo Quantidade: "6 pct (300 un)" quando o pacote tem contagem (pedido do dono, 19/out —
 *  "6 un" não dizia quantas toalhas o kit tem); senão "6 un". Sempre ≤ 20 letras para kits de até 999. */
export function rotuloQuantidade(qtd: number, unidadesPorPacote: number | null): string {
  return unidadesPorPacote ? `${qtd} pct (${qtd * unidadesPorPacote} un)` : `${qtd} un`;
}
