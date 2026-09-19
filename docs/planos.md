# Planos (backlog do dono)

## 0. Imposto da ACZ Pet no lucro real (decidido 19/set/2026: fases A e B)

O app usa hoje **10% fixo** sobre o subtotal para a ACZ (`lojas.aliquota_imposto`
vazia → fallback; a SVL usa 7,5%). As NF-e reais de venda da ACZ (CRT 3) mostram
**27,2% a 29,8%** de débito: SP = ICMS 18% + PIS/COFINS 9,25%; BA = ICMS 7% +
DIFAL 13,5% + 9,25%. O XML de cada nota vem pelo Tiny em `GET /notas/{id}/xml`
(`ICMSTot`: vICMS, vICMSUFDest, vFCP, vPIS, vCOFINS, vST) — **rate limit
apertado: 9 de 14 chamadas seguidas voltaram 429**, então o sync tem de ser
cadenciado (~1 req/s) e o histórico entra aos poucos.

- **Fase A — débito real por nota:** espelhar os tributos por pedido (ICMS,
  DIFAL, FCP, PIS, COFINS) e usar no Pedidos Integrados e no DRE, com o DIFAL
  separado (não gera crédito).
- **Fase B — imposto líquido:** creditar PIS/COFINS (9,25% sobre a mercadoria) e
  ICMS da compra, lendo também o XML das NF de entrada.
  - **Frete (respondido pelo dono, 19/set):** entra como crédito **só no
    Mercado Livre**, porque lá o frete sai em **CTE individual por envio**. Na
    Shopee/Amazon não há CTE por pedido, então frete não gera crédito. Efeito
    prático no modelo: o crédito de frete é calculado por pedido ML, a partir
    do CT-e, e não como percentual sobre a dedução do marketplace.
  - **Monofásico:** o dono não identifica produto monofásico no mix (pet food /
    higiene / acessórios); **confirmação com a contabilidade na segunda,
    22/set/2026**. Até lá o modelo assume PIS/COFINS não-cumulativo em toda a
    mercadoria — se houver monofásico, o crédito desses itens cai a zero e a
    conta muda para eles.
  - **Continua pendente:** ICMS-ST por item (quais SKUs) e se a comissão de
    marketplace gera crédito de PIS/COFINS.
- IRPJ/CSLL ficam fora: incidem sobre o lucro do período, não sobre a venda —
  entram como linha mensal do DRE.

## 1. Integração TikTok Shop
Levantamento completo em `docs/integracao-tiktok-shop.md` (16/set/2026). Depende
do dono: cadastro no Partner Center (região/mercado Brasil, "Seller in-house
developer"), criação do app e autorização nas duas contas. Fases: OAuth +
espelho de pedidos → financeiro (taxas por pedido, v202501) → etiqueta ZPL pelo
app → webhooks.

## 2. Falta de estoque → zerar no Tiny → conferir o anúncio na Shopee (viabilidade 17/set/2026)

**IMPLEMENTADO em 17/set/2026 (opção A, com as decisões do dono):** kit
pergunta manualmente o componente; confirmação nos dois casos; aviso no
Discord `#estoque-pedido-sem-estoque` (canal `estoque` — falta o secret
`DISCORD_WEBHOOK_ESTOQUE`). Detalhes em CLAUDE.md §5.0.2: `separacao-falta` v6
(preview / zerar / desfazer), `estoque-conferir` v1 + cron `falta-estoque-
conferir`, tabela `falta_estoque_conferencia`, `FaltaEstoqueDialog.tsx`.
Front depende de Publish no Lovable. O levantamento abaixo fica como registro.

**Hoje** (`separacao-falta` v5): marcador "FALTA ESTOQUE" no pedido do Tiny +
`separacao_tiny.falta_estoque_em/_por` + aviso no Discord (canal estoque).
61 reportes até 17/set, 28 SKUs, quase todos produto simples (tipo S). Caso
típico: SKU 14404 reportado em falta com depósito **Geral = 29** no Tiny — o
Tiny segue anunciando 29 nos marketplaces enquanto a prateleira está vazia.

**Viável, com o que já existe:**
- Tiny API v3 `POST /estoque/{idProduto}` com `{tipo:"B", quantidade:0,
  precoUnitario:<custo>, deposito:{id}, observacoes}` — balanço zera o depósito.
  `precoUnitario` é obrigatório (usar `produtos.custo` ou 0). **Permissão de
  escrita confirmada em 17/set** (corpo vazio → 400 de validação, não 403).
- Depósito certo: **"Geral"** (id 604130012 na conta Ottz), o único físico; os
  depósitos Full (ML/Shopee/Amazon) são estoque nos CDs dos marketplaces e NÃO
  podem ser zerados. `GET /estoque/{id}` já traz `depositos[].id/nome/saldo`.
- Auditoria: `GET /estoque/{idProduto}/logs-movimentacao` (por depósito/tipo/
  período) — dá para exibir o lançamento e desfazer (novo balanço com a
  quantidade anterior, guardada em `separacao_log.detalhe`).
- Propagação Tiny → Shopee: a integração nativa "Enviar estoque" atualiza o
  anúncio quando o saldo muda (a ajuda da Olist não publica o tempo; medir na
  prática — estimativa: minutos).

**Conferir na Shopee:** o espelho `shopee_anuncios_variacao.estoque` só
atualiza 1×/dia (catálogo 04:00/04:15). Para conferir na hora precisa de uma
chamada ao vivo: `product/get_model_list` (por `item_id`) ou
`product/get_item_base_info` (`item_id_list`, com `stock_info_v2`) via
`shopee-sync-ads` (novo módulo `estoque-anuncio&sku=`), mapeando SKU → item/
model pelas tabelas `shopee_anuncios`/`shopee_anuncios_variacao`. Regra:
"zerado na Shopee" = `seller_stock` do model (ou do item, se sem variação) = 0.

**Desenho proposto (opção A, recomendada):**
1. Botão "Reportar falta" ganha a opção **"zerar estoque no Tiny"** (checkbox,
   ligada por padrão) — a `separacao-falta` lê `GET /estoque/{id}`, guarda o
   saldo do Geral em `separacao_log.detalhe` e faz o balanço 0 no Geral.
2. A função agenda uma **conferência em 10 min**: `shopee-sync-ads?modulo=
   estoque-anuncio&sku=` para cada anúncio/variação do SKU nas duas lojas; se
   algum ainda estiver > 0, aviso no Discord (canal estoque) "Tiny zerado, mas
   Shopee ainda mostra N" e a linha da Separação ganha selo. (Implementação:
   tabela `falta_estoque_conferencia(sku, zerado_em, conferir_em, resultado)`
   + cron a cada 5 min fora do minuto cheio.)
3. Desfazer: botão "Estoque voltou" → balanço com o saldo guardado (ou entrada
   da contagem informada).
Opções descartadas: (B) zerar direto na Shopee pela API — desalinha o Tiny,
que reenviaria o saldo antigo; (C) só avisar sem zerar — mantém o problema.
Riscos: SKU multi-depósito físico (se um dia houver outro depósito além do
Geral, listar antes); kits (falta reportada no kit → zerar o COMPONENTE em
falta, não o kit; hoje os reportes são de simples); pedidos abertos reservados
ficam com disponível negativo no Tiny (esperado).
