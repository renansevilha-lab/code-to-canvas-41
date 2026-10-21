# Prompt para o Claude Design — Dashboard principal ("Visão Geral")

> Cole tudo abaixo da linha no Claude Design. Os números de exemplo são do banco em 21/out/2026 (reais, arredondados).

---

Quero redesenhar o **Dashboard principal** (a "Visão Geral") do nosso app de gestão. O app já tem uma linguagem visual
definida por você, no handoff "Painel de Vendas" e na tela "Promoções": mantenha a mesma fundação.

## Contexto

O app é a ferramenta de operação diária de um pet shop que vende em vários marketplaces: Shopee, Mercado Livre, Amazon e
TikTok Shop, além de Temu e Shein, que não são integrados. Duas empresas usam o app: **Ottz Pet (ACZ)** e **SVL Store / Bumi
Pet**.

O Dashboard é a **primeira tela que o dono abre de manhã**, no computador. Ela precisa responder, em menos de um minuto:
1. **Estou ganhando dinheiro?** Vendas, margem de contribuição (MC), ADS e lucro do período, comparados com o período anterior
   e com a meta do mês.
2. **O que pede atenção HOJE?** Conta vencendo, pedido para cancelar, etiqueta que não gerou, produto em ruptura, ADS no
   prejuízo, integração parada.
3. **Para onde eu clico para resolver?** Cada número leva à tela que resolve.

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
- **Anomalias**: SKU sem custo, CMV maior que a receita, pedido sem recebido, anúncios com ROAS ruim, SKU da Amazon sem
  vínculo.
- **Metas do mês** e **ACOS mês a mês**, em barras com a meta de cada mês (a meta muda de mês para mês).
- **Vendas por SKU e por marca** (kit aberto nos componentes), atual × anterior.
- **Canais sem integração** (Temu, Shein, TikTok Bumi): só receita e pedidos.
- **Relatórios dos agentes** (faixa "Hoje" que você desenhou: ADS, compras, financeiro, pesquisa de produtos).

**O que incomoda:**
- Não mostra **nada do dia a dia**: caixa, operação do galpão, estoque, saúde das integrações. Isso existe em outras telas e
  nos relatórios dos agentes, mas o dono precisa abrir 6 telas para ter o retrato.
- Os **alertas estão no fim** da página, misturados com análise.
- Tudo tem o **mesmo peso visual**: o cartão de receita e uma anomalia de R$ 144 mil sem custo apurado parecem igualmente
  importantes.
- **Não fica claro o que muda com o filtro de período e o que é "hoje"**: a meta do mês, os relatórios e as anomalias não
  obedecem ao filtro.
- Não diz **de quando é cada número**. Algumas fontes atualizam a cada 30 minutos, outras 1× por dia.

## O que eu quero

### Estrutura

Duas camadas bem separadas visualmente:

**A. "Hoje": não muda com o filtro de período.** Fica no topo, logo abaixo do título.

1. **Faixa "Pede atenção hoje"**, no mesmo espírito da faixa "Pede decisão" da tela Promoções.
   - Contadores clicáveis, cada um com o número, um rótulo curto, uma linha de contexto em R$ e o link para a tela que
     resolve.
   - Só aparece o que tem problema. Com tudo em dia, a faixa vira uma linha "Tudo em dia ✓", sem ruído.
   - Ordem por gravidade: vermelho (perde dinheiro hoje), âmbar (perde se ninguém agir), neutro (informativo).
   - Itens:
     - contas a pagar atrasadas e de hoje (R$);
     - pedidos atrasados para envio e pedidos que a Shopee cancela em até 2 dias (R$);
     - etiquetas em erro ou geração parada;
     - Entrega Rápida pendente (antes da coleta das 12h);
     - ruptura: "comprar urgente" e Full zerado com venda;
     - ADS no prejuízo ontem (por loja);
     - token ou integração parada;
     - promoções do ML aguardando decisão.
2. **Caixa** (cartão compacto):
   - saldo nas carteiras e a receber por marketplace, com o a receber da Shopee rotulado **"estimado"**;
   - contas a pagar por faixa: atrasado · hoje · 7 dias · 15 dias;
   - mini-gráfico do saldo projetado em 30 dias, marcando o **pior dia**.
3. **Operação do galpão** (cartão compacto):
   - por loja: a despachar hoje, com etiqueta pronta, em erro;
   - total a enviar e atrasados;
   - risco de cancelamento por dia (hoje / amanhã / depois).

**B. "Período": obedece ao filtro.** Abaixo da camada A.

4. **KPIs do período**: os 6 cartões de hoje, mais:
   - **meta do mês** com barra de progresso, projeção e "falta R$ X por dia";
   - **ACOS × meta** do mês.
5. **Vendas × margem por dia** (o gráfico de hoje).
6. **Canais**: contribuição por canal e os cartões por canal (cada um com o logo pequeno do marketplace, como na tela
   Promoções), mais os canais sem integração em versão discreta.
7. **ADS** (ontem e 7 dias, por loja): gasto, ROAS, TACOS, margem pós-ADS, campanhas abaixo do ROAS de equilíbrio e a perda
   estimada.
8. **Estoque**:
   - contagem por status de cobertura: ruptura, comprar urgente, atenção, excesso, sem giro;
   - R$ parado em excesso e sem giro;
   - venda/dia em risco;
   - sugestões de envio ao Full por conta.
9. **Produtos**: vendas por SKU e por marca e top SKUs (os de hoje, mais enxutos), com uma alternância "subiram / caíram".
10. **Relatórios dos agentes** e **anomalias de dados** (SKU sem custo, CMV > receita, SKU sem vínculo) no fim, em cartões
    recolhíveis.

### Regras de apresentação

- **Cada bloco diz de quando é o dado**: "atualizado há 12 min", "do relatório das 08h", "estoque de 06h20". Dado com mais de
  1 dia aparece em âmbar.
- **Estimativa tem rótulo.** A receber da Shopee, projeção do mês, saldo projetado, perda de ADS e ADS dos últimos 2 dias
  ("provisório": o marketplace ainda reatribui vendas) levam um selo discreto "estimado" ou "provisório".
- **Escopo visível quando não é tudo.** Exemplos:
  - "só Shopee" nos blocos de etiquetas e cancelamento;
  - "Amazon sem ADS integrado" no bloco de ADS;
  - "463 SKUs sem estoque sincronizado ficam fora" no estoque.
- **Percentual nunca é média de percentuais.** Isso é regra de cálculo, não de layout, mas o design não deve sugerir somar
  percentuais (ex.: um "total" de MC% numa coluna de canais).
- **Cor com significado só**: vermelho = perde dinheiro, âmbar = atenção, verde = ok. O roxo do acento é para seleção e ação.
  Nada de pintar cartões inteiros.
- **Cada bloco carrega sozinho** (skeleton próprio) e pode falhar sozinho ("não deu para ler o caixa agora · tentar de novo")
  sem derrubar a página. O banco é pequeno, então as consultas saem em levas e alguns blocos chegam 2–3 s depois dos outros.
- **Densidade**: o retrato de "Hoje" (faixa + caixa + operação) cabe numa tela de notebook de 1366×768 sem rolar. O resto pode
  rolar.
- Os números da camada A e os dos KPIs **levam à tela de origem**: Contas a pagar, Fluxo de caixa, Separação, Pedidos a
  enviar, Risco de cancelamento, Reposição do Full, Compras, ADS Shopee, ADS ML, Promoções.

## Restrições

- Use os tokens do design system que você já criou:
  - acento roxo #6E56CF;
  - fonte Inter, com JetBrains Mono para números e códigos;
  - cartões brancos sobre fundo #F4F5F7, raio 14px;
  - claro e escuro.
- Marketplace identificado pelo logo pequeno (Shopee, Mercado Livre, Amazon, TikTok), como no cabeçalho da tela Promoções,
  sem pintar o bloco com a cor dele.
- Desktop primeiro (1366–1920 px), sem rolagem lateral na página em 1280 px. No celular basta a camada A empilhada e os 6 KPIs.
- Números em pt-BR: R$ 1.234,56 · 17,3% · datas dd/mm.
- O menu lateral e o cabeçalho do app já existem; desenhe só a área de conteúdo.

## Dados de exemplo (reais de 21/out/2026, arredondados)

**Período "Mês" (01–21/out × 01–21/set)**
- Receita líquida: R$ 422 mil; projeção do mês R$ 623 mil = 77,9% da meta de R$ 800 mil.
- Margem de contribuição: R$ 68,6 mil (16,2%).
- ADS: R$ 26,2 mil, ACOS 6,2% × meta 5,5% (estourou).
- Lucro pós ADS: R$ 42,4 mil.
- Pedidos: 7.798.

**Pede atenção hoje**
- Contas a pagar: 3 atrasadas (R$ 1.936) e 2 vencem hoje (R$ 8.574).
- 3 pedidos atrasados para envio (Bumi); 51 a enviar sem impressão registrada.
- Risco de cancelamento: nada hoje; 3 pedidos em 23/10; 77 pedidos (R$ 6,1 mil) em 24/10, todos embalados esperando coleta.
- 35 pedidos de Entrega Rápida pendentes (26 ACZ, 9 Bumi).
- Etiquetas: Ottz 6 em erro, Bumi 2 em erro.
- Ruptura: 11 SKUs "comprar urgente" e 56 em ruptura na empresa; Full zerado com venda: Amazon ACZ 13, Amazon SVL 15,
  ML ACZ 16.
- ADS ontem: ML ACZ gastou R$ 624, ROAS 4,7, **margem pós-ADS −R$ 169**.
- Mercado Livre: 60 promoções aguardando decisão, 10 sugestões de troca.
- Integrações: 8 tokens ok (exemplo de "tudo em dia").

**Caixa**
- Carteiras:
  - Shopee Ottz: R$ 4,7 mil em conta e R$ 97 mil a receber (estimado);
  - Bumi: R$ 1 mil e R$ 104 mil;
  - Mercado Livre: R$ 29,7 mil a receber.
- Contas a pagar: 13 em até 7 dias (R$ 52,9 mil), 11 em até 15 dias (R$ 58,9 mil).
- Fluxo projetado: +R$ 655 hoje e +R$ 34,9 mil em 27/10; maior saída de R$ 69,9 mil em 20/11.

**Operação (Shopee)**
- Ottz: 41 a despachar hoje, 78 de 84 com etiqueta, 6 em erro.
- Bumi: 39 a despachar, 50 de 52 com etiqueta, 2 em erro.
- 136 pedidos a enviar no total.

**ADS (ontem)**

| Loja | Gasto | ROAS | Margem pós-ADS |
|---|---|---|---|
| Shopee ACZ | R$ 749 | 14,4 | +R$ 992 |
| Shopee SVL | R$ 587 | 14,9 | +R$ 1.016 |
| ML ACZ | R$ 624 | 4,7 | −R$ 169 |

- 7 dias: 127 campanhas, 30 ruins, 13 com meta abaixo do ROAS de equilíbrio.
- Perda estimada: R$ 1.038 de R$ 8.428 gastos.

**Estoque**
- Excesso: 66 SKUs, R$ 154,8 mil parados.
- Sem giro: 62 SKUs, R$ 17,1 mil.
- Venda em risco: R$ 360/dia.
- Sugestões de envio ao Full: Amazon ACZ 16 SKUs / 148 un; ML ACZ 14 SKUs / 102 un.

**Anomalias**
- 43 SKUs sem custo somando R$ 144 mil de receita sem custo apurado.
- 24 pedidos com prejuízo extremo.

**Produtos**: Areia Bumi Pet 4kg (SKU 15984) é o mais vendido (2.605 un no mês anterior); 61 produtos caíram e 44 subiram mês
contra mês.

## O que entregar

1. O Dashboard completo no período "Mês", com a camada "Hoje" no topo e a camada "Período" abaixo, deixando claro o que o
   filtro afeta.
2. A faixa "Pede atenção hoje" em três estados: com vários problemas (os dados acima), com um problema só e "tudo em dia".
3. Os cartões Caixa e Operação no detalhe, com o selo "estimado" e o "atualizado há".
4. O bloco de ADS por loja e o bloco de Estoque.
5. Os estados de carregando (por bloco), erro de um bloco só e dado velho (âmbar).
6. Versões clara e escura da tela principal e a versão de celular da camada A + KPIs.

Explique em poucas linhas a hierarquia escolhida: o que o dono vê primeiro, o que fica para quando ele rola e por quê.
