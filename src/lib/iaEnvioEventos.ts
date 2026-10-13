// Avisos entre os blocos do envio de um anúncio (IA · Anúncios). O envio (`Publicar`), as variações
// (`VariacoesShopee`) e a promoção (`PromocaoNoEnvio`) são blocos separados na tela; para o
// operador é UM envio, então eles se avisam por eventos da janela.

/** Antes de confirmar o envio: SÍNCRONO, com o detalhe mutável — cada bloco diz o que fará junto. */
export const EV_VAI_CRIAR = "ia-anuncio-vai-criar";
export interface VaiCriar { canal: string; empresa: string; sku: string; variacoes: boolean; promocao: string | null; /** fotos que vão ao Tiny junto */ tiny?: string | null }

/** O anúncio (simples) acabou de ser criado. `ativar`: pôr no ar depois de criar as variações. */
export const EV_CRIADO = "ia-anuncio-criado";
export interface AnuncioCriado { canal: string; empresa: string; sku: string; item_id: string; ativar?: boolean; preco?: number | null }

/** O anúncio está completo (simples criado, ou variações criadas): hora de cadastrar na promoção. */
export const EV_PRONTO = "ia-anuncio-pronto";
export interface AnuncioPronto {
  canal: string; empresa: string; sku: string; item_id: string;
  /** variações criadas (vazio = anúncio simples) */
  modelos?: { model_id: number; sku: string }[];
  /** preço cheio de cada SKU, para não mandar promoção igual ou acima dele */
  precos: Record<string, number>;
}
