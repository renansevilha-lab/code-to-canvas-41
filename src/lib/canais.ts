// ============================================================================
// Rótulo de canal para EXIBIÇÃO.
//
// Em 21/ago/2026 o Tiny renomeou o canal Shopee da SVL de
// "Sevilla Store [SHOPEE]" para "Bumi Pet [Shopee]" (mesmo shop 759046323).
// Os pedidos antigos continuam gravados com o nome velho, então a mesma loja
// aparecia com duas grafias lado a lado na tela, como se fossem canais
// diferentes.
//
// Aqui normalizamos só o que o operador VÊ. O dado cru (marca_canal) fica
// intacto: quem filtra/consulta precisa aceitar as duas grafias, porque o Tiny
// pode reverter o nome a qualquer momento (o `imprimir` da shopee-sync-ads v54
// e a tiny-separacao v31 já aceitam as duas).
// ============================================================================

const ALIASES: Array<{ de: RegExp; para: string }> = [
  // SVL / Sevilla Store no canal Shopee -> nome atual. O negative lookahead
  // evita pegar "Sevilla Store" da loja própria (site), que não é Shopee.
  { de: /^sevilla store \[shopee\]$/i, para: "Bumi Pet [Shopee]" },
  { de: /^\[svl\] shopee$/i, para: "Bumi Pet [Shopee]" },
];

/** Nome do canal como deve aparecer na tela. Nunca use para filtrar/consultar. */
export function rotuloCanal(marca: string | null | undefined): string {
  const s = (marca ?? "").trim();
  if (!s) return "—";
  for (const a of ALIASES) if (a.de.test(s)) return a.para;
  return s;
}
