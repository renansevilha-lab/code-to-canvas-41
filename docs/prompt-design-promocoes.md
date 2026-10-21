# Prompt para o Claude Design — Aba "Promoções"

> Cole tudo abaixo da linha no Claude Design.

---

Quero redesenhar a tela **Promoções** do nosso app de gestão. O app já tem uma linguagem visual definida por você (o
handoff "Painel de Vendas"): mantenha a mesma fundação.

## Contexto

O app é uma ferramenta de operação diária de um pet shop que vende em vários marketplaces. Duas empresas usam o app:
**Ottz Pet (ACZ)** e **SVL Store / Bumi Pet**. A tela de Promoções é usada pelo dono e por quem cuida de preço, quase sempre
no computador e com pressa. Ela serve para decidir **em que promoção colocar cada produto e a que preço sem perder dinheiro**.
O número que decide tudo é a **margem de contribuição (MC)** no preço promocional: preço − comissão/taxas do marketplace −
imposto − custo do produto (CMV). Mostramos a MC em % e em R$ por unidade.

Toda alteração muda o preço público no marketplace na hora. Por isso **toda ação passa por uma prévia "de → para" com a MC
e uma confirmação explícita**. Nada é aplicado com um clique só.

## Como a tela está hoje (o problema)

Hoje é uma página com 4 abas, uma por marketplace. Cada aba foi feita numa época diferente e ficou com um layout próprio:
- **Shopee**: duas sub-abas.
  - *Minha Promoção*: os descontos da loja. Ao abrir um desconto aparece a tabela dos produtos com preço cheio, preço
    promocional editável, limite por comprador, comissão + imposto e MC. Tem o diálogo "Adicionar produtos", com busca,
    filtro por faixa de MC e preço sugerido, e o painel "Promoções diárias", que repete um desconto todo dia.
  - *Relâmpago*: a programação da oferta relâmpago de amanhã. Mostra preço atual, preço relâmpago, teto relâmpago, desconto,
    estoque promo, limite, MC no teto e ativo/pausado. A Shopee aceita até 50 variações por relâmpago. O robô monta a de amanhã
    às 18h, com histórico das programações.
  - Seletor de loja: Ottz / Bumi.
- **Mercado Livre**: "Central de Promoções". Lista o que o ML oferece para cada anúncio (campanhas, ofertas do dia, relâmpago)
  com o preço → promo, os custos na promo (comissão, frete, co-financiamento do ML), a MC e a decisão:
  - entra automático (MC ≥ 15%);
  - aguardando confirmação;
  - há promoção melhor;
  - sugestão de troca.
  Há ainda o bloco do robô "Regra automática", com modo desligado / simulação / ligado, MC mínima e ganho mínimo para trocar.
- **Amazon**: o catálogo FBA com preço cheio, taxas reais da Amazon, CMV, MC hoje e o preço para atingir cada faixa de MC
  (10 / 15 / 17,25 / 20%). Lista as promoções da conta e, ao expandir uma, mostra os produtos com o preço na promoção. A tela
  também cria um "preço de oferta" com início e fim, por produto ou em lote. Seletor de conta: ACZ / SVL.
- **TikTok Shop**: os produtos da loja com preço, CMV, MC, vendas em 30 dias e "na promoção", mais a lista das promoções da
  loja. As ações são nova promoção (preço fixo ou desconto %, por produto ou variação), adicionar os produtos selecionados,
  tirar produto e encerrar.

**O que incomoda:**
- Cada marketplace parece um sistema diferente.
- As tabelas são densas, tudo no mesmo peso: fica difícil achar o que **pede decisão hoje** (MC negativa, produto que saiu da
  promoção, relâmpago de amanhã vazia, item barrado).
- O produto é difícil de reconhecer: faltava foto e nome em algumas listas.
- A MC aparece de formas diferentes em cada aba.

## O que eu quero

1. **Um padrão único para os 4 marketplaces**, que só mude onde a regra do marketplace for diferente. Mesma estrutura:
   - cabeçalho do marketplace com seletor de loja/conta;
   - faixa de resumo;
   - lista de promoções;
   - detalhe da promoção com os produtos;
   - ações.
2. **Faixa "Pede decisão" no topo** (como a faixa "Hoje" que você desenhou para Relatórios), com contadores clicáveis que
   filtram a lista. Por exemplo:
   - produtos com MC negativa na promoção;
   - MC abaixo de 10%;
   - promoções que acabam hoje ou amanhã;
   - relâmpago de amanhã com X de 50 vagas;
   - produtos vendendo bem e fora de qualquer promoção;
   - ações recusadas pelo marketplace.
3. **Linha de produto padrão** para todas as tabelas:
   - foto e nome com SKU, e o código do marketplace (MLB, ASIN, ID do item) discreto;
   - preço cheio → preço promo, com o % de desconto;
   - MC em % e R$, com cor: vermelho < 0, âmbar < 10%, verde ≥ 10%;
   - vendas 30 dias e estoque;
   - estado (na promoção, programado, aguardando, recusado).
   Ao passar o mouse na MC, mostrar a conta aberta: preço − comissão − imposto − CMV.
4. **Edição em linha do preço promocional**, com a MC recalculando na hora. Atalhos de faixa ("preço para MC 15%") e uma barra
   de ações em lote quando houver seleção.
5. **Prévia antes de aplicar**: um painel ou diálogo "de → para" por produto, com a MC antiga e a nova, o total de produtos,
   avisos (ex.: "sai da promoção X", "abaixo do preço mínimo do marketplace") e o botão "Aplicar no [marketplace]". O resultado
   aparece por linha: aplicado, recusado com o motivo, ou pulado.
6. **Estados**: carregando, lista vazia, erro de leitura do marketplace, dado desatualizado ("atualizado há 3 h" + botão
   sincronizar) e produto sem custo cadastrado (sem MC: mostrar o aviso, não um número errado).
7. **Robôs/automação** (relâmpago diária da Shopee, regra automática do ML, promoção diária repetida): um cartão compacto e
   padronizado com o estado (ligado / simulação / desligado), a última e a próxima execução e o que fez na última rodada.

## Restrições

- Use os tokens do design system que você já criou:
  - acento roxo #6E56CF;
  - fonte Inter, com JetBrains Mono para números e códigos;
  - cartões brancos sobre fundo #F4F5F7, raio 14px.
  Tem que funcionar em claro e em escuro. Cada marketplace se identifica só por um ponto de cor (Shopee #EE4D2D,
  Mercado Livre #E8B500, Amazon #FF9900, TikTok #111111), sem pintar a tela com a cor dele.
- Desktop primeiro (1366–1920 px), mas utilizável em notebook de 1280 px sem rolagem lateral na página. Tabela larga pode
  rolar dentro do cartão.
- Números em pt-BR: R$ 1.234,56 · 17,25% · datas dd/mm.
- Tabelas de até ~300 produtos com paginação ou rolagem.

## Dados de exemplo (para os mocks — produtos reais, valores ilustrativos)

- **Shopee Ottz, Minha Promoção "Ofertas de Outubro"**:
  - Areia Higiênica Bumi Pet 4kg, SKU 15984, cheio R$ 49,90 → promo R$ 42,10, MC 17,3% (R$ 7,28);
  - Kit 2 Areia Bumi 4kg, SKU 15987, cheio R$ 89,90 → R$ 79,99, MC 9,4% (âmbar);
  - Creme Dental Bumi, SKU 16246, R$ 68,03, MC R$ 8,12.
  - Comissão Shopee: 20% + R$ 4,50 por unidade abaixo de R$ 80; 14% + R$ 16 a R$ 26 acima.
- **Relâmpago de amanhã (Bumi)**: 47 de 50 vagas usadas. Granulado Bumi Mix 4kg com preço atual R$ 39,90, teto relâmpago
  R$ 37,50 e MC no teto 12,1%. 9 produtos ficaram de fora por falta de vaga.
- **Mercado Livre**: campanha "11.11 da Black", Areia Bento Mix 10kg (SKU 16457) R$ 119,90 → R$ 104,90, co-financiamento
  do ML R$ 5,00, MC 16,2%, "entra automático". Relâmpago para o Kit 2 Bumi com MC 8,9%, "aguardando confirmação".
- **Amazon ACZ**: FBA-15825 (Areia Bumi 20kg), cheio R$ 49,90, oferta R$ 44,90 de 21/10 a 31/10, taxas Amazon R$ 11,20,
  MC 26,9%. Na promoção "BUMI" a R$ 42,64. 15742_FBA bloqueado ("GTIN inválido") → alerta.
- **TikTok ACZ**: Perfume Pet Clean Macho, R$ 29,90, CMV R$ 9,80, MC 18,5%, 41 vendas em 30 dias, fora de promoção.

## O que entregar

1. A tela de Promoções com a faixa "Pede decisão", nas abas Shopee (Minha Promoção aberta), Mercado Livre e Amazon.
2. O detalhe de uma promoção com a tabela de produtos, edição em linha e a barra de lote.
3. A tela da Relâmpago da Shopee (programação de amanhã, vagas, robô).
4. O diálogo "Adicionar produtos à promoção" (busca, filtro por faixa de MC, preço sugerido por faixa).
5. A prévia/confirmação "de → para" e o resultado por linha depois de aplicar, com recusas.
6. Os estados de vazio, carregando, erro e "sem custo cadastrado".
7. As versões clara e escura de pelo menos a tela principal.

Explique em poucas linhas as decisões de layout e o que é igual em todos os marketplaces e o que muda.
