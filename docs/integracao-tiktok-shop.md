# Integração TikTok Shop — levantamento (16/set/2026)

Estado hoje: o TikTok Shop entra no sistema **só pelo Tiny** (pedidos_tiny, canais
"TikTok Shop ACZ ?" e "TikTok Shop l Bumi Pet", envio "TikTok Shipping"). Não há
linha em `pedidos`, `lojas`, sem margem/taxas, sem etiqueta pelo app (a Separação
avisa "Etiqueta (TikTok não usa o app)"). Volume 30 dias: Ottz 31 pedidos
(R$ 1,2 mil), Bumi 58 (R$ 2,2 mil).

## 1. Cadastro (feito pelo dono, no Partner Center)

- Portal **global** (não US): https://partner.tiktokshop.com → *Get Started* →
  região de registro (só se define UMA vez) → mercado-alvo **Brasil** → tipo
  **"Seller in-house developer"** (verifica pelo e-mail admin da loja; aprovação
  mais rápida, ~2–3 dias úteis). App desse tipo só pode ser autorizado pela(s)
  loja(s) do vendedor — é exatamente o nosso caso.
- Criar o app (tipo *custom*): define **Redirect URL** (será uma edge function
  `tiktok-oauth`), escopos e recebe **app_key / app_secret / service_id**.
- Escopos necessários: `seller.order.info`, `seller.fulfillment.basic`,
  `seller.finance.info`, `seller.product.info` (leitura de catálogo), e os de
  devolução/webhook conforme o app pedir.
- Duas lojas (Ottz e Bumi) = **duas autorizações** do mesmo app (uma por conta
  do Seller Center), cada uma com token e `shop_cipher` próprios.

## 2. Autorização e token (OAuth, ROW)

- Link de consentimento (rest of world):
  `https://services.tiktokshop.com/open/authorize?service_id={service_id}&state=...`
  → volta em `{redirect_url}?code=...&state=...`. O **auth_code vale 30 min e
  é de uso único**.
- Troca: `GET https://auth.tiktok-shops.com/api/v2/token/get?app_key&app_secret&auth_code&grant_type=authorized_code`
  (o valor é `authorized_code` mesmo, não `authorization_code`).
- Resposta: `access_token` (**7 dias**), `refresh_token` (vale o prazo da
  autorização concedida), `open_id`, `seller_name`, `seller_base_region`,
  `granted_scopes`. Refresh: `.../api/v2/token/refresh?grant_type=refresh_token`.
- `shop_cipher` e `shop_id`: `GET /authorization/202309/shops` (necessários
  em toda chamada). Webhooks avisam 30 dias antes da autorização vencer e
  quando o vendedor desautoriza.
- Tabela sugerida: `oauth_tokens_tiktok(shop_id, shop_cipher, seller_name,
  access_token, refresh_token, expires_at, refresh_expires_at, empresa)`;
  cron de refresh **fora do minuto cheio** (lição de 12/set), a cada 6 h.

## 3. Chamadas

- Base: `https://open-api.tiktokglobalshop.com`. Query obrigatória:
  `app_key`, `timestamp` (unix UTC), `sign`, `shop_cipher`; header
  `x-tts-access-token`, `content-type: application/json`.
- **Assinatura** (HMAC-SHA256, chave = app_secret): ordena as queries por nome
  (exceto `sign` e `access_token`), concatena `path + key1value1key2value2…`,
  anexa o body cru (se não for multipart), envolve com o secret nas duas pontas
  (`secret + str + secret`) e faz HMAC hex minúsculo. Node.js de exemplo na doc
  "Sign your API request".
- Rate limit dinâmico (sem número fixo publicado); 429 → backoff exponencial
  com jitter. Sem sandbox desde 202309 — testa-se com **Development Shop**
  (loja de teste do Seller Center, gera token sem link de autorização).

## 4. Endpoints que interessam

| Objetivo | Endpoint | Obs. |
|---|---|---|
| Pedidos | `POST /order/202309/orders/search` (filtros `create_time_ge/lt`, `update_time_ge/lt`, `order_status`, `shipping_type`; `page_size` ≤100, `page_token`) e `GET /order/202309/orders?ids=` (detalhe) | status: UNPAID, ON_HOLD, AWAITING_SHIPMENT, AWAITING_COLLECTION, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED. Espelhar por `update_time` (mesma lição do ML: cancelamento tardio). |
| Etiqueta | `POST /fulfillment/202309/packages/{package_id}/ship` (TikTok Shipping: `handover_method` PICKUP/DROP_OFF + `pickup_slot`) e depois `GET /fulfillment/202309/packages/{package_id}/shipping_documents?document_type=SHIPPING_LABEL&document_format=ZPL` | **ZPL só para BR e MX** — cabe direto na Zebra/PrintNode como a Shopee. `INVOICE_LABEL` (A6) é exclusivo do Brasil. `package_id` vem do detalhe do pedido. Erro 11034002 = pedido "seller shipping" (não tem etiqueta da plataforma). |
| Financeiro | `GET /finance/202309/statements` (1 extrato/dia, UTC, status PAID/PROCESSING/FAILED); `GET /finance/202501/orders/{order_id}/statement_transactions` (**todas as regiões**, taxas por SKU: comissão, taxa de transação, afiliado, frete, ajustes, reembolso); `GET /finance/202309/payments`; `GET /finance/202309/transactions/unsettled` | As versões **202309** de "transactions by order/statement" são só US/UK — usar **202501**. Dados só a partir de jul/2023. |
| Catálogo | `POST /product/202309/products/search` + detalhe | para casar `seller_sku` → SKU interno e fotos (só fallback; Tiny primeiro). |
| Webhooks | `ORDER_STATUS_CHANGE`, cancelamento, devolução, expiração/cancelamento de autorização | assinatura no header `Authorization` = HMAC-SHA256(app_secret, app_key + body cru), hex minúsculo; usar `tts_notification_id` para idempotência. Endpoint público (verify_jwt=false — **não redeployar via MCP**, mesma regra do `ml-notificacoes`). |

## 5. Como encaixa no sistema (proposta)

- `lojas`: 2 linhas TikTok (shop_id real do TikTok; `canal` "TikTok Shop (Ottz Pet)" / "TikTok Shop (Bumi Pet)", alíquota).
- `pedidos`: `marketplace='tiktok'`, `fonte='api'`, `id` = order_id do TikTok;
  `pedido_itens` por `seller_sku` (mapeamento via `sku_mapeamento` se divergir).
  Casar com `pedidos_tiny.numero_ecommerce` (é o order_id do TikTok).
- Taxas/margem: `statement_transactions` 202501 → `recebido_estimado` e colunas
  de comissão (mesmo desenho do escrow Shopee); `pedidos_validos` ganha a lista
  branca de status do TikTok (COMPLETED/DELIVERED/IN_TRANSIT/AWAITING_*).
- Etiqueta: edge fn `tiktok-etiqueta` (ship + shipping_documents ZPL → PrintNode),
  registrando em `impressao_etiquetas` como as demais; a Separação passa a
  imprimir TikTok pelo app. **Não usar o app para agendar coleta sem o Tiny já
  ter feito**: conferir `order_status`/pacote antes (mesma armadilha do
  `shopee-ship`).
- Fases sugeridas: (1) OAuth + espelho de pedidos + lojas (DRE/PI passam a
  incluir TikTok); (2) financeiro (taxas por pedido + extratos); (3) etiqueta
  ZPL pelo app; (4) webhooks (substituem o polling frequente).

## 6. Riscos / decisões

- Aprovação do app pelo TikTok leva dias; testes antes disso só com Development
  Shop (dados fictícios).
- Access token de 7 dias: refresh precisa de watchdog (entra na
  `view_tokens_saude`).
- Se o Tiny continuar fazendo a confirmação/"ship", a etiqueta pelo app é só
  impressão (documento já existe); se o pacote ainda não foi arranjado, o app
  teria que chamar o `ship` (irreversível — mesma cautela do Shopee).
- Assinatura de webhook usa o `app_secret`: fica só em secret da edge function.
