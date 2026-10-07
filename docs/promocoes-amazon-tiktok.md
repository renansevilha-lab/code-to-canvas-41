# Promoções e campanhas — Amazon e TikTok Shop (estudo, 07/out/2026)

Estudo de leitura (nenhuma API de marketplace chamada, nada alterado). Base para as
sub-abas Amazon e TikTok de `/promocoes`.

## Amazon (BR: marketplace `A2Q3Y263D00KWC`, endpoint `sellingpartnerapi-na`)

- **Ler promoções: sim.** Promotions API **v2025-12-01** (lançada em 26/ago/2026):
  `searchPromotions` (`GET /promotions/2025-12-01/promotions`, tipos BASKET_BUILDING,
  DEAL, PRICE_DISCOUNT, COUPON; filtros de status/ASIN/SKU/data), `getPromotion` e
  `getSelection` (ASINs/SKUs da promoção). Traz desconto, agenda, budget e `feeSnapshot`.
  Rate 0,1/s (rajada 4). Papel **Pricing** ou **Product Listing**. A doc não cita o
  Brasil — confirmar chamando. Fontes:
  https://developer-docs.amazon/sp-api/docs/promotions-api ·
  https://developer-docs.amazon/sp-api/reference/searchpromotions
- **Criar Oferta/Cupom/desconto Prime pela API: não existe.** Segue no Seller Central.
- **Alternativa de escrita:** Listings Items API (`patchListingsItem`,
  `purchasable_offer.discounted_price` com `schedule` start/end) = preço promocional com
  agenda, anúncio a anúncio (equivalente à "Minha Promoção" da Shopee; não dá selo de
  Oferta). Papel **Product Listing**. No BR o `value_with_tax` é o preço CHEIO com imposto
  (ver ItemTax, CLAUDE.md §4). https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer
- **Taxas reais para a MC:** Product Fees API (`getMyFeesEstimates`, 20 SKUs/chamada).
  Hoje o `amazon-sync-financas?modulo=estimar` usa 12% + FBA por faixa (fixo).
- **Papéis dos nossos apps:** só chamamos orders, finances, fba inventory e reports —
  nenhuma chamada a listings/pricing/fees/promotions, e `/fba/inbound` já deu 403.
  **Provavelmente NÃO têm Pricing nem Product Listing.** Confirmar em Developer Central
  (Seller Central → Desenvolver aplicativos → editar app) ou com um GET de teste
  (403 = papel faltando). Adicionar papel deve exigir reautorizar cada conta.
- **ADS (Sponsored Products):** a edge fn `amazon-ads-oauth` está pronta, mas
  `oauth_tokens_amazon_ads` está **vazia** — nenhuma conta conectada. Falta: security
  profile LwA aprovado para a Ads API, secrets `AMAZON_ADS_CLIENT_ID/_SECRET`, redirect
  em "Allowed Return URLs" e conectar ACZ/SVL (`?help=1&conta=`). Depois: renovação de
  token, sync de campanhas, DRE e Dashboard.

## TikTok Shop (ACZ)

- **Promotion API 202309** (caminhos pela biblioteca EcomPHP e guia da Hemi — a página
  oficial é JS e não pôde ser lida): criar (`POST /promotion/202309/activities`), editar
  (`PUT …/{id}`), encerrar (`POST …/{id}/deactivate`, não reativa), buscar
  (`POST …/activities/search`), detalhe (`GET …/{id}`), adicionar/atualizar produtos
  (`PUT …/{id}/products`, até 300) e remover (`DELETE …/{id}/products`). Tipos
  `DIRECT_DISCOUNT` (%), `FIXED_PRICE` (`activity_price`), `FLASHSALE` (preço ≤ menor de
  30 dias). Nível PRODUCT ou VARIATION; `quantity_limit`/`quantity_per_user`; **um produto
  em uma promoção por vez** (entrar numa tira da outra); duração 10 min–30 dias.
  Cupons: só leitura. Inscrição em campanhas da PLATAFORMA: sem API confirmada.
  https://raw.githubusercontent.com/EcomPHP/tiktokshop-php/master/src/Resources/Promotion.php
- **Escopos já concedidos:** `oauth_tokens_tiktok.granted_scopes` da loja `ottzpet` já tem
  `seller.promotion.info` e `seller.promotion.write` (+ product, finance, order). Não precisa
  reautorizar a ACZ. **Bumi não autorizou o app.**
- Não existe espelho do catálogo TikTok (só itens de pedido). Ids TikTok sempre como texto
  (> 2^53, §5.8). Volume 30 d: 24 pedidos, R$ 1,1 mil.

## Proposta

| Marketplace | Dá para fazer já | Depende do dono | Esforço |
|---|---|---|---|
| Amazon — preços/promoções | Tela de MC por SKU e simulador de preço com o que já temos (pedidos, CMV, taxa estimada) — regra numa RPC | Papéis Product Listing + Pricing nos 2 apps + reautorização → ler Ofertas/Cupons/Promoções, taxas reais, criar preço promocional com agenda | M |
| Amazon — ADS | — (função pronta, tabela vazia) | App da Ads API, 2 secrets, redirect, conectar ACZ e SVL | M |
| TikTok (ACZ) | Edge fn `tiktok-promocoes` (search/get + espelho do catálogo), RPC de MC (extrato real), criar/editar desconto com `confirmar=1` e JWT | Autorizar a Bumi; aprovar deploy e escrita | M |
