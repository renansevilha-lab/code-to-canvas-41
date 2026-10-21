# Prompt para o Claude Design — Dashboard principal ("Visão Geral")

> Cole tudo abaixo da linha no Claude Design. Os números de exemplo são do banco em 21/out/2026 (reais, arredondados).

---

Quero redesenhar o **Dashboard principal** (a "Visão Geral") do nosso app de gestão. O app já tem uma linguagem visual
definida por você, no handoff "Painel de Vendas" e na tela "Promoções": mantenha a mesma fundação.

## Contexto

O app é a ferramenta de gestão de um pet shop que vende em vários marketplaces: Shopee, Mercado Livre, Amazon e TikTok Shop,
além de Temu e Shein, que não são integrados. Duas empresas usam o app: **Ottz Pet (ACZ)** e **SVL Store / Bumi Pet**.

O Dashboard é a tela do **dono**, de **negócio e estratégia**. A operação do galpão (etiquetas, separação, coleta,
cancelamentos) tem telas próprias e **não entra aqui**. A tela precisa responder, em menos de um minuto:
1. **Como está a saúde financeira da empresa agora?** Quanto tenho em caixa, quanto vou receber, quanto está parado em
   estoque e quanto preciso pagar nos próximos 30 dias.
2. **Estou ganhando dinheiro?** Vendas, margem de contribuição (MC), ADS e lucro do período, comparados com o período
   anterior e com a meta do mês.
3. **Onde está o dinheiro sendo ganho ou perdido?** Por canal, por marca/produto, no ADS e no estoque parado.
4. **Que decisão eu preciso tomar?** Cada número leva à tela que aprofunda.

O número que decide tudo é a **margem de contribuição**: receita − taxas do marketplace − imposto − custo do produto (CMV).
Mostramos a MC em R$ e em %. "Lucro pós ADS" = MC − gasto com anúncios.

## Como o Dashboard está hoje

É todo de **período e venda**. Tem um filtro de período no topo (Hoje · Ontem · Mês · 7d · 30d · Mês anterior ·
Personalizado), que compara com o período anterior; no "Mês", compara com os mesmos dias do mês passado. Tem também filtro de
canal e o botão Atualizar. Os blocos, de cima para baixo:
- **6 cartões**:
  - Receita líquida (com projeção do mês);
  - Margem de contribuição;
  - MC %;
  - Pedidos;
  - Gastos com ADS (o delta tem a cor invertida: gastar mais não é verde);
  - Lucro pós ADS.
  Cada cartão tem delta e sparkline.
- **Gráfico de vendas × margem por dia.**
- **Contribuição por canal** e cartões "Desempenho por canal" (receita, MC, ADS, ACOS, margem após ADS).
- **Top SKUs.**
- **Anomalias de dados** (SKU sem custo, CMV maior que a receita, pedido sem recebido, anúncios com ROAS ruim, SKU da Amazon
  sem vínculo).
- **Metas do mês** e **ACOS mês a mês** (barras com a meta de cada mês; a meta muda de mês para mês).
- **Vendas por SKU e por marca** (kit aberto nos componentes), atual × anterior.
- **Canais sem integração** (Temu, Shein, TikTok Bumi): só receita e pedidos.
- **Relatórios dos agentes** (a faixa "Hoje" que você desenhou: ADS, compras, financeiro, pesquisa de produtos).

**O que incomoda:**
- Mostra só venda. **Não mostra a posição da empresa**: caixa, a receber, valor em estoque e contas a pagar. Hoje o dono
  precisa abrir Carteira, Fluxo de caixa, Contas a pagar e Compras para montar esse retrato.
- Os **alertas estão no fim** da página, misturados com análise, e são alertas de dado, não de negócio.
- Tudo tem o **mesmo peso visual**: o cartão de receita e uma anomalia de R$ 144 mil sem custo apurado parecem igualmente
  importantes.
- **Não fica claro o que muda com o filtro de período**: a meta do mês, os relatórios e as anomalias não obedecem a ele.
- Não diz **de quando é cada número**. Algumas fontes atualizam a cada 30 minutos, outras 1 vez por dia.

## O que eu quero

### Estrutura

Duas camadas bem separadas visualmente.

**A. "Posição da empresa": retrato de agora, não muda com o filtro de período.** Fica no topo, logo abaixo do título.

1. **Quatro números grandes**, cada um com um detalhe embaixo e link para a tela que aprofunda:
   - **Caixa disponível**: saldo nas carteiras dos marketplaces;
   - **A receber**: por marketplace, com a Shopee rotulada **"estimado"** (o crédito dela é projetado pelo prazo médio);
   - **Valor em estoque**, a custo: depósito da empresa + estoque nos Fulls (Amazon, Mercado Livre, Shopee), com quanto
     disso está parado (excesso + sem giro);
   - **Contas a pagar em 30 dias**: atrasado · 7 dias · 30 dias.
2. **Capital de giro** numa linha-resumo: caixa + a receber + estoque − contas a pagar 30 dias. Mostre como uma conta
   aberta ("R$ X + R$ Y + R$ Z − R$ W"), não como um número mágico.
3. **Fluxo de caixa dos próximos 30 dias**: mini-gráfico do saldo projetado dia a dia, com entradas e saídas somadas no
   período e o **pior dia** marcado. Se o saldo projetado fica negativo em algum dia, isso vira o destaque do bloco.
4. **Faixa "Pede decisão"**, no mesmo espírito da faixa da tela Promoções, só com assuntos de negócio:
   - contas a pagar atrasadas (R$);
   - caixa projetado negativo em algum dia dos próximos 30;
   - meta do mês em risco (projeção abaixo da meta);
   - ACOS acima da meta do mês;
   - loja ou campanha de ADS no prejuízo (margem pós-ADS negativa nos últimos 7 dias);
   - dinheiro parado em estoque (excesso + sem giro);
   - venda em risco por falta de estoque (produtos que vendem e estão em ruptura, em R$/dia);
   - receita sem custo apurado (margem não confiável).
   Contadores clicáveis, cada um com o número, um rótulo curto, uma linha de contexto em R$ e o link para a tela que
   resolve. Só aparece o que tem problema; com tudo em dia, a faixa vira uma linha "Tudo em dia ✓". Ordem por gravidade:
   vermelho (perde dinheiro agora), âmbar (perde se ninguém agir), neutro (informativo).

**B. "Desempenho do período": obedece ao filtro.** Abaixo da camada A.

5. **KPIs do período**: os 6 cartões de hoje, mais:
   - **meta do mês** com barra de progresso, projeção e "falta R$ X por dia";
   - **ACOS × meta** do mês.
6. **Vendas × margem por dia** (o gráfico de hoje).
7. **Canais**: contribuição por canal e os cartões por canal (cada um com o logo pequeno do marketplace, como na tela
   Promoções), mais os canais sem integração numa versão discreta.
8. **ADS por loja** (ontem e 7 dias): gasto, ROAS, TACOS (ADS ÷ venda total), margem pós-ADS, campanhas abaixo do ROAS de
   equilíbrio e a perda estimada.
9. **Estoque como investimento**:
   - valor parado por situação (excesso, sem giro), com os 5 produtos que mais prendem dinheiro;
   - venda/dia em risco por ruptura;
   - cobertura média em dias.
10. **Produtos e marcas**: vendas por SKU e por marca e top SKUs (os de hoje, mais enxutos), com uma alternância
    "subiram / caíram".
11. **Relatórios dos agentes** e **anomalias de dados** no fim, em cartões recolhíveis.

### Regras de apresentação

- **Cada bloco diz de quando é o dado**: "atualizado há 12 min", "do relatório das 08h", "estoque de 06h20". Dado com mais de
  1 dia aparece em âmbar.
- **Estimativa tem rótulo.** A receber da Shopee, saldo projetado, projeção do mês, perda de ADS e ADS dos últimos 2 dias
  ("provisório": o marketplace ainda reatribui vendas) levam um selo discreto "estimado" ou "provisório".
- **Escopo visível quando não é tudo.** Exemplos:
  - "Amazon sem ADS integrado" no bloco de ADS;
  - "62 produtos com estoque sem custo cadastrado" no valor em estoque;
  - "Temu e Shein fora da margem" nos canais.
- **Percentual nunca é média de percentuais.** É regra de cálculo, não de layout, mas o design não deve sugerir somar
  percentuais (ex.: um "total" de MC% numa coluna de canais).
- **Cor com significado só**: vermelho = perde dinheiro, âmbar = atenção, verde = ok. O roxo do acento é para seleção e ação.
  Nada de pintar cartões inteiros.
- **Cada bloco carrega sozinho** (skeleton próprio) e pode falhar sozinho ("não deu para ler o caixa agora · tentar de novo")
  sem derrubar a página. O banco é pequeno, então as consultas saem em levas e alguns blocos chegam 2–3 s depois dos outros.
- **Densidade**: a camada A inteira (quatro números, capital de giro, fluxo 30 dias e a faixa) cabe numa tela de notebook de
  1366×768 sem rolar. O resto pode rolar.
- Os números levam à tela de origem: Carteira, Fluxo de caixa, Contas a pagar, Compras (cobertura), Fulfillment (Reposição),
  ADS Shopee, ADS ML, Promoções, Vendas por produto, DRE.

## Restrições

- Use os tokens do design system que você já criou:
  - acento roxo #6E56CF;
  - fonte Inter, com JetBrains Mono para números e códigos;
  - cartões brancos sobre fundo #F4F5F7, raio 14px;
  - claro e escuro.
- Marketplace identificado pelo logo pequeno (Shopee, Mercado Livre, Amazon, TikTok), como no cabeçalho da tela Promoções,
  sem pintar o bloco com a cor dele.
- Desktop primeiro (1366–1920 px), sem rolagem lateral na página em 1280 px. No celular bastam a camada A empilhada e os 6
  KPIs.
- Números em pt-BR: R$ 1.234,56 · 17,3% · datas dd/mm.
- O menu lateral e o cabeçalho do app já existem; desenhe só a área de conteúdo.

## Dados de exemplo (reais de 21/out/2026, arredondados)

**Posição da empresa (agora)**
- Caixa disponível nas carteiras: R$ 2,9 mil.
- A receber: R$ 233,7 mil no total.
  - Shopee Ottz: R$ 97 mil (estimado);
  - Shopee Bumi: R$ 104 mil (estimado);
  - Mercado Livre: R$ 29,7 mil.
- Valor em estoque a custo: R$ 566 mil no depósito da empresa (511 produtos; 62 com estoque e sem custo cadastrado),
  mais o estoque nos Fulls.
  - Parado: R$ 154,8 mil em excesso (66 produtos, mais de 120 dias de cobertura) e R$ 17,1 mil sem giro (62 produtos sem
    venda em 30 dias).
- Contas a pagar: R$ 1,9 mil atrasadas, R$ 61,5 mil em 7 dias, **R$ 229,3 mil em 30 dias** (45 contas).
- Capital de giro: R$ 2,9 mil + R$ 233,7 mil + R$ 566 mil − R$ 229,3 mil ≈ R$ 573 mil.
- Fluxo projetado em 30 dias: entradas R$ 380,8 mil, saídas R$ 325,9 mil. Saldo mais baixo: +R$ 655, hoje. Maior saída:
  R$ 69,9 mil em 20/11.

**Pede decisão**
- 3 contas atrasadas: R$ 1.936.
- Meta do mês: realizado R$ 422,7 mil, projeção R$ 623,9 mil = 78% da meta de R$ 800 mil; faltam R$ 37,7 mil por dia.
- ACOS do mês 6,2% × meta 5,5%.
- ADS no prejuízo: Mercado Livre ACZ ontem gastou R$ 624 com ROAS 4,7 e margem pós-ADS −R$ 169. Em 7 dias, 14 campanhas
  no prejuízo e perda estimada de R$ 1.038 sobre R$ 8.428 gastos.
- Dinheiro parado em estoque: R$ 171,9 mil (excesso + sem giro).
- Venda em risco por ruptura: R$ 360/dia (11 produtos "comprar urgente", 56 em ruptura na empresa).
- Receita sem custo apurado: 43 produtos, R$ 144 mil de receita.

**Período "Mês" (01–21/out × 01–21/set)**
- Receita líquida: R$ 422,7 mil; projeção do mês R$ 623,9 mil.
- Margem de contribuição: R$ 68,6 mil (16,2%).
- ADS: R$ 26,2 mil.
- Lucro pós ADS: R$ 42,4 mil.
- Pedidos: 7.798.

**ADS (ontem)**

| Loja | Gasto | ROAS | Margem pós-ADS |
|---|---|---|---|
| Shopee ACZ | R$ 749 | 14,4 | +R$ 992 |
| Shopee SVL | R$ 587 | 14,9 | +R$ 1.016 |
| ML ACZ | R$ 624 | 4,7 | −R$ 169 |

- 7 dias: 127 campanhas, 30 ruins, 13 com meta abaixo do ROAS de equilíbrio.

**Produtos**: Areia Bumi Pet 4kg (SKU 15984) é o mais vendido; 61 produtos caíram e 44 subiram mês contra mês.

## O que entregar

1. O Dashboard completo no período "Mês", com a camada "Posição da empresa" no topo e a camada "Desempenho do período"
   abaixo, deixando claro o que o filtro afeta.
2. A camada "Posição da empresa" no detalhe: os quatro números, o capital de giro como conta aberta e o fluxo de 30 dias
   com o pior dia, com o selo "estimado" e o "atualizado há".
3. A faixa "Pede decisão" em três estados: com vários problemas (os dados acima), com um problema só e "tudo em dia".
4. Os blocos de ADS por loja e de Estoque como investimento.
5. Os estados de carregando (por bloco), erro de um bloco só e dado velho (âmbar).
6. Versões clara e escura da tela principal e a versão de celular da camada A + KPIs.

Explique em poucas linhas a hierarquia escolhida: o que o dono vê primeiro, o que fica para quando ele rola e por quê.
