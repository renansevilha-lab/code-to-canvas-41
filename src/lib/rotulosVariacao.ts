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
