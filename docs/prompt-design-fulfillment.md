# Prompt para o Claude Design — aba Fulfillment (Envios, Reposição, Inventário, Tarefas)

> Cole tudo abaixo da linha no Claude Design. Os números de exemplo são do banco em 21/out/2026 (reais, arredondados).

---

Quero redesenhar a aba **Fulfillment** do nosso app de gestão. O app já tem uma linguagem visual definida por você
(handoff "Painel de Vendas", telas "Promoções" e "Visão geral"): mantenha a mesma fundação.

## Contexto

O app é a ferramenta de gestão de um pet shop que vende em Shopee, Mercado Livre, Amazon e TikTok Shop. Duas empresas usam o
app, **Ottz Pet (ACZ)** e **SVL Store / Bumi Pet**, e cada uma tem as suas contas nos marketplaces.

"Fulfillment" (ou "Full") é o estoque que mandamos para os centros de distribuição (CDs) dos marketplaces: Amazon FBA,
Mercado Livre Full e Shopee SBS. O marketplace guarda o produto e despacha a venda. **O estoque de uma conta no CD não serve à
outra**: o que a ACZ tem na Amazon não atende a SVL.

A aba é usada por dois públicos:
- **A equipe do galpão** (4–5 pessoas): separa e embala os envios na bancada, imprime etiquetas, conta estoque e cumpre
  tarefas. Usa o PC da bancada (com leitor de código de barras e impressora Zebra) e o celular para contar prateleira.
- **O dono**: decide o que mandar a cada CD (reposição), cria os envios e confere se chegaram.

Bug ou confusão aqui trava gente na bancada. A tela precisa ser **operacional**: dizer o que fazer agora, com botões grandes e
poucos cliques. Não é tela de análise.

O ciclo de um envio:
1. **Reposição** diz o que falta em cada CD.
2. O dono **monta o envio**. Na Amazon o app cria o plano pela API; no ML e na Shopee o envio é criado no painel do
   marketplace e o PDF de preparação é subido no app.
3. A equipe **separa e embala**, contando cada item, e imprime as etiquetas.
4. O envio é **coletado** (marcado como enviado).
5. O app **lança a transferência de estoque no Tiny** (nosso ERP).
6. O app **acompanha o recebimento** no CD.

## Como a aba está hoje

Cabeçalho com o subtítulo "Estoque nos centros de distribuição e sugestão de reposição", botão **Atualizar** e botão
**Sincronizar CDs**. O sincronizar leva ~1 min; o automático roda às 8h e às 18h. **A tela não diz quando foi o último sync.**

Quatro abas, nesta ordem visual: **Reposição · Inventário · Envios · Tarefas**. A aba que abre por padrão é **Envios**, que
fica em 3º lugar. Os filtros de marketplace, empresa e busca só existem em Reposição e Inventário.

**Envios** (aba padrão)
- 3 contadores: "Aguardando separação", "Separadas, em preparo" e "Prontas para envio", em unidades.
- Botões: "Lançar estoque dos enviados (N)", "Arquivados", "Importar da Amazon" e **"Novo envio"**.
- **Kanban com 5 etapas**, cada uma com a sua cor:

  | Etapa | Cor |
  |---|---|
  | Separando ("Verificar estoque / Separar") | âmbar |
  | Embalar | azul |
  | Etiquetas ("Etiquetas de volume / Finalização") | roxo |
  | Pronto para envio | verde |
  | Enviado | cinza |

  Muda-se de etapa arrastando o cartão. Não há setas e não funciona por toque.
- **O cartão mostra:** número, marketplace e CD, data de coleta ("atrasado" em vermelho), até 3 miniaturas de produto,
  "separado / planejado" com barra e o selo "E" quando o estoque já foi lançado no Tiny. **Não mostra a empresa.**
- **Novo envio** troca a aba inteira por um formulário:
  - campos: marketplace, empresa, número, CD e data de coleta;
  - "Subir PDF de preparação": o app lê o PDF do marketplace e preenche os itens;
  - "Subir etiquetas (ZPL)";
  - tabela de itens editável, com o total conferido contra o PDF ("✓ confere com o PDF" / "≠ PDF diz N");
  - botão "Criar envio e separar".
- **Detalhe do envio (tela de packing)** também troca a aba inteira e não tem URL própria:
  - etapa, data agendada e observações;
  - documentos do envio: DANFE, folha de envio, etiquetas e etiqueta de produto, com tipo adivinhado pelo nome do arquivo,
    imprimir direto na Zebra, abrir e excluir;
  - barra fixa:
    - "Separado: N / M un";
    - seletor de impressora;
    - "Imprimir etiquetas";
    - "Etiqueta de produtos";
    - **"Marcar enviado"**;
    - **"Lançar estoque no Tiny"**;
  - grade de itens: foto, nome, SKU corrigível e um contador − / campo / + com "completar". O cartão fica verde quando o item
    está completo, e cada item imprime as etiquetas dele;
  - "Adicionar item";
  - na Amazon, depois de enviado, o bloco "Recebido pela Amazon": enviado × recebido × falta por SKU.
- Muitas confirmações usam a janela nativa do navegador (`confirm`/`prompt`), cerca de 15, misturadas com diálogos
  desenhados.

**Reposição**
- 2 indicadores ("SKUs abaixo da cobertura-alvo" e "Unidades sugeridas") numa grade de 4, com 2 espaços vazios.
- Cartão "Envios criados na Amazon pelo app (30 dias)": um chip por plano com o passo em que ele está.
- Caixa "Mostrar só itens com sugestão de envio".
- **Tabela de 13 colunas**:
  - Produto e Canal (marketplace + conta);
  - Vendas 30d (com un/dia);
  - **MC 30d Full** (margem das vendas que saíram do CD × fora dele);
  - Estoque CD, Em trânsito e **Em envio** (já planejado em envios abertos);
  - Cobertura em dias (pílula vermelha, âmbar ou verde contra o alvo);
  - Necessidade e Sugestão;
  - **A enviar**, editável. Na Amazon arredonda para caixa fechada e mostra "N cx de U" ou "não fecha caixa";
  - Disponível no Tiny (aviso se não há o bastante no depósito da empresa).
- Seleção → rodapé "N SKUs · N unidades" → **"Montar envio"**, que abre um painel lateral com um bloco por
  marketplace e conta:
  - Amazon: "Criar envio na Amazon" → **assistente do plano Amazon**:
    1. tabela com o anúncio, as unidades, o modelo de caixa, as caixas e a validade;
    2. criar plano;
    3. embalagem (automático);
    4. escolher o **destino** (cards com CD, taxa e prazo);
    5. cotar e escolher o **transporte** por envio ("coleta da parceira da Amazon" grátis × "por nossa conta");
    6. o envio nasce sozinho na aba Envios, com as etiquetas.

    Cada escrita na Amazon pede confirmação.
  - ML e Shopee: "Copiar lista".
- **Modelos de caixa (Amazon)**: tabela editável por anúncio, com unidades por caixa, medidas, peso e validade, mais
  "Importar dos envios anteriores".

**Inventário**
- 4 indicadores: Disponível, Reservado, Em trânsito, Inutilizável.
- Barra empilhada do estoque por marketplace.
- **Tabela plana**: uma linha por marketplace × conta × anúncio × CD, com as colunas Sellable, Reservado, Em trânsito,
  Inutilizável, "Disponível no Tiny" e Atualizado. O mesmo produto aparece em várias linhas soltas. Anúncio sem SKU
  vinculado leva o selo "sem SKU". Não tem ordenação nem agrupamento.

**Tarefas**
- 4 indicadores: A fazer, Fazendo, Atrasadas, Feitas.
- Filtros de tipo e de responsável. Botão "Nova tarefa".
- **Kanban de 3 colunas** (A fazer, Fazendo, Feito), com setas e arraste. Soltar em "Feito" abre a tarefa para concluir.
- O cartão mostra tipo, título, responsável, prazo ("atrasada" em vermelho) e progresso ("x de y SKUs contados · N
  divergências").
- **Nova tarefa**, com três tipos:
  - **contagem de inventário**: escolher produtos por busca, fornecedor, marca, categoria e "só com saldo";
    contagem **cega** por padrão;
  - **organização** e **outra**: com checklist;
  - todas com fotos (câmera do celular) e aviso no Discord.
- **Detalhe da contagem**:
  - lista de produtos com foto, SKU e um campo "contado" (Enter pula para o próximo);
  - diferença contra o sistema, que aparece só se a pessoa pede "mostrar sistema";
  - filtros "faltam contar" e "divergentes";
  - **"Conferir com o Tiny e ajustar"**: lê o saldo ao vivo e, com confirmação, lança o balanço só nos SKUs marcados.

**O que incomoda**
- **Nada diz o que fazer agora.** Envio com coleta vencida, envio enviado sem estoque lançado no Tiny, plano da Amazon parado
  no meio, produto zerado no CD que está vendendo: tudo isso existe, mas o dono precisa caçar em quatro abas.
- **Ordem das abas e filtros incoerentes:** a aba padrão fica em 3º, e Envios e Tarefas não filtram por empresa nem por
  marketplace.
- **Telas sem endereço:** Novo envio e o detalhe do envio trocam a aba inteira. Não dá para mandar o link de um envio nem usar
  o "voltar" do navegador.
- **A tela de packing é densa** para a bancada: muitos botões no mesmo nível, e as ações que importam (contar, imprimir,
  marcar enviado) competem com as de cadastro (corrigir SKU, anexar documento).
- **Confirmações nativas do navegador** para ações irreversíveis (lançar estoque no Tiny, excluir envio, imprimir em massa).
- **Reposição** é uma planilha de 13 colunas: difícil ver o que é urgente (zerado e vendendo) e o que é só "dá para mandar
  mais".
- **Inventário** não agrupa por produto: o mesmo produto em 3 CDs vira 3 linhas soltas.
- **Kanban de Envios** não funciona no toque, e os cartões não mostram a empresa.
- Não há estado de erro em Envios. Os indicadores da Reposição deixam espaços vazios.

## O que eu quero

### Estrutura geral

1. **Cabeçalho da aba**:
   - **"Dados dos CDs de hoje 08h05 · há 2 h"**, com âmbar se passou de 1 dia, e o botão **Sincronizar**;
   - **filtro global** de **empresa** (Ambas · ACZ · SVL) e **marketplace** (Todos · Amazon · Mercado Livre · Shopee),
     que vale para as quatro abas. Explique visualmente que o estoque no CD é por conta.
2. **Faixa "Pede ação"** logo abaixo, no mesmo espírito da faixa "Pede decisão" da Visão geral, em contadores clicáveis
   que levam à aba e ao item:
   - envios com **coleta vencida** ou para hoje ainda não prontos;
   - envios **enviados sem estoque lançado no Tiny** (se ninguém lança, o Tiny segue vendendo o que já saiu);
   - **plano da Amazon parado** ou com erro;
   - produtos **zerados no CD que vendem** (ruptura no Full, em un/dia);
   - unidades **inutilizáveis** paradas no CD;
   - **tarefas atrasadas**;
   - envio da Amazon com **unidades faltando** no recebimento.

   Com tudo em dia, vira uma linha "Tudo em dia ✓". Ordem por gravidade: vermelho, âmbar, neutro.
3. **Abas em ordem de uso:** Envios · Reposição · Inventário · Tarefas. Cada aba com contador ("Envios 5", "Tarefas 9
   abertas").
4. **Novo envio, detalhe do envio e detalhe da tarefa** como telas próprias, com endereço (link compartilhável e voltar do
   navegador), e com um caminho de volta claro ("Fulfillment › Envios › #79220166").

### Envios

5. **Quadro** com as 5 etapas:
   - cartões mostrando **empresa** (ACZ/SVL), logo do marketplace, número, CD, coleta (atrasado em vermelho), miniaturas e
     progresso;
   - mudar de etapa por **arraste, por setas no cartão e por toque**;
   - contadores das etapas no topo, em unidades e envios;
   - uma alternativa em **lista** (para quem tem muitos envios), com as mesmas informações em linha.
6. **Tela de packing pensada para a bancada**, com hierarquia clara:
   - **topo**: o que falta, com progresso grande ("Separado 312 de 411 un · 76%"), a próxima etapa e um único botão principal,
     que muda conforme o momento: "Imprimir etiquetas" → "Marcar enviado" → "Lançar estoque no Tiny";
   - **itens** como cartões grandes de toque, com foto, nome, SKU e um contador − / + grande e "completar". O item completo
     fica verde e vai para o fim (ou some com "ocultar completos"). Campo **"bipar código"** (o leitor do PC adiciona 1 ao
     item certo);
   - **secundário, recolhido ou numa coluna lateral:** documentos, observações, corrigir SKU, adicionar item, impressora
     escolhida;
   - na Amazon enviada: **recebimento** enviado × recebido × falta;
   - ações irreversíveis (**lançar estoque no Tiny**, excluir envio, marcar enviado com itens faltando) em **diálogos
     desenhados**, que mostram o que vai acontecer ("vai transferir 411 un do depósito Geral para o Full do ML ACZ; 2 itens
     ficam de fora porque não têm cadastro").
7. **Novo envio** em passos curtos:
   1. marketplace e conta;
   2. subir o PDF (área grande de soltar) → conferência do que foi lido, com o total batendo ou não com o PDF e as linhas com
      problema destacadas;
   3. data de coleta e etiquetas;
   4. criar.

   Mostre também a entrada pelo **plano Amazon** (o envio já chega pronto da Reposição) e "importar da Amazon".

### Reposição

8. **Três grupos no lugar de uma planilha só:**
   - **"Urgente"**: zerado no CD e vendendo, ou cobertura abaixo de 7 dias;
   - **"Sugerido"**: abaixo do alvo;
   - **"Ok / excesso"**: recolhido.

   Em cada linha: produto (foto), canal + conta, vendas/dia, estoque no CD + a caminho + em envio aberto, **cobertura em dias
   como barra contra o alvo**, a sugestão, o campo **"a enviar"** (com caixas fechadas na Amazon) e o **disponível no depósito
   da empresa** (aviso se não dá). A MC das vendas pelo Full fica num detalhe discreto (tooltip ou linha expandida), não numa
   coluna fixa.
9. Rodapé fixo de seleção "N SKUs · N un · Montar envio". O **painel de montar envio** separa por marketplace e conta e, na
   Amazon, leva ao **assistente do plano** como um **stepper** visível (Itens e caixas → Criar → Destino → Transporte →
   Envio criado). Cada passo diz se é automático ou espera decisão, e qual escrita na Amazon ele faz.
10. **Modelos de caixa** como um painel de cadastro limpo, com os que faltam (anúncio sem modelo, areia sem validade) no topo.

### Inventário

11. **Agrupar por produto**: uma linha por produto com o total e, expandindo, cada CD/conta. Colunas: disponível, reservado, a
    caminho, inutilizável e o disponível no depósito da empresa. Filtros rápidos: "com inutilizável", "sem SKU vinculado",
    "zerado". Ordenável.
12. Topo com o total por marketplace e conta (unidades e, se couber, valor a custo).

### Tarefas

13. Quadro com cartões mais legíveis: tipo por ícone, responsável com avatar/iniciais, prazo e progresso.
14. **Contagem pensada para o celular**:
    - uma coluna, foto grande, nome e SKU;
    - campo numérico grande ("Enter" pula para o próximo);
    - contagem cega por padrão;
    - "faltam N";
    - concluir só com tudo contado ou com confirmação.
15. **"Conferir com o Tiny e ajustar"** como um diálogo de revisão: divergentes em destaque, batendo recolhidos, aviso de
    pedidos já separados, confirmação que diz quantos SKUs e unidades mudam no Tiny e o resultado linha a linha.

### Regras de apresentação

- **Cada bloco diz de quando é o dado**: "CDs de hoje 08h05", "Tiny lido às 07h50", "recebimento atualizado há 12 min".
  Âmbar se passou de 1 dia.
- **Empresa sempre visível** onde há estoque ou envio (ACZ / SVL), porque o estoque no CD não é compartilhado.
- **Marketplace pelo logo pequeno** (Shopee, Mercado Livre, Amazon, TikTok), como na tela Promoções, sem pintar blocos com a
  cor dele. As cores das etapas do kanban são as únicas cores "de categoria" da tela.
- **Cor com significado**: vermelho = trava a operação ou perde venda agora, âmbar = atenção, verde = ok/completo. O roxo do
  acento é para seleção e ação.
- **Toda escrita externa** (Tiny, Amazon, impressora em massa) passa por **diálogo desenhado** com o resumo do efeito. Nada de
  `confirm` do navegador.
- **Cada bloco carrega e falha sozinho**: skeleton próprio e "não deu para ler agora · tentar de novo".
- **Alvos de toque de 44 px** na tela de packing e na contagem.
- Desktop primeiro (1366–1920 px, PC da bancada), sem rolagem lateral da página em 1280 px. Tabelas largas podem rolar dentro
  do próprio cartão. **No celular**: faixa "Pede ação", lista de envios, packing e contagem.

## Restrições

- Tokens do design system que você já criou: acento roxo #6E56CF; Inter, com JetBrains Mono para números, SKUs e códigos
  (FBA…); cartões brancos sobre #F4F5F7, raio 14 px; claro e escuro.
- Números em pt-BR: 1.234 un · R$ 1.234,56 · 17,3% · datas dd/mm.
- O menu lateral e o cabeçalho do app já existem; desenhe só a área de conteúdo.
- Não invente funções que dependem do marketplace: o ML e a Shopee não deixam criar envio pela API (o PDF é o caminho), e só
  a Amazon informa o recebimento por SKU.

## Dados de exemplo (reais de 21/out/2026, arredondados)

**Estoque nos CDs** (sync de hoje 21h33)

| Conta | Anúncios | Disponível | Reservado | A caminho | Inutilizável |
|---|---|---|---|---|---|
| Amazon ACZ | 321 | 569 | 194 | 301 | 39 |
| Amazon SVL | 89 | 364 | 97 | 240 | 15 |
| Mercado Livre ACZ | 251 | 557 | 0 | 0 | 57 |
| Mercado Livre SVL | 19 | 21 | 0 | 0 | 0 |
| Shopee Ottz | 89 | 2 | 17 | 28 | 106 |
| Shopee Bumi | 34 | 0 | 3 | 0 | 24 |

Valor a custo nos Fulls: R$ 50,9 mil.

**Envios abertos (5)**

| Envio | Conta | Etapa | Unidades | Itens | Coleta / CD |
|---|---|---|---|---|---|
| #79220166 | ML ACZ | Embalar | 411 | 13 | coleta 24/10 |
| FBA19TPQXVN9 | Amazon SVL | Pronto para envio | 37 | 4 | coleta 21/10 (hoje), XCV9 Cajamar |
| FBA19TZFT26Z | Amazon ACZ | Separando | 26 | 1 | coleta 23/10, XCV9 |
| FBA19TL1K4ZJ | Amazon ACZ | Separando | 60 | 2 | coleta 29/10 |
| FBA19TM3DJHC | Amazon ACZ | Separando | 25 | 1 | coleta 29/10 |

- 56 envios enviados nos últimos 30 dias (77 no histórico).
- Exemplo de item no packing: Areia Bumi Pet 4kg Mandioca (SKU 15984), 146 un planejadas no #79220166.

**Reposição**

| Conta | SKUs | Com sugestão | Un. sugeridas | Zerados vendendo | Em envio aberto |
|---|---|---|---|---|---|
| Amazon ACZ | 285 | 15 | 148 | 14 | 111 |
| Amazon SVL | 87 | 9 | 72 | 15 | 37 |
| ML ACZ | 204 | 14 | 159 | 18 | 411 |
| ML SVL | 16 | 1 | 9 | 3 | — |
| Shopee Ottz | 86 | 3 | 198 | 5 | — |
| Shopee Bumi | 33 | 0 | 0 | 1 | — |

Linhas de exemplo:

| Produto | Conta | Vendas/dia | No CD | A caminho | Em envio | Cobertura | Sugestão | Empresa tem |
|---|---|---|---|---|---|---|---|---|
| Kit Adestrador Xixi Stop + Xixi Aqui Pet Clean (10933) | Shopee Ottz | 6,3 | 0 | 1 | — | 0 d | **188** | 1.027 |
| Areia Bumi Pet 4kg Mandioca (15984) | ML ACZ | 7,1 | 3 | — | 146 | 21 d | 64 | 1.264 |
| Kit 2 Areia Biodegradável Great Pets (14420) | Amazon ACZ | 1,2 | 0 | — | — | 0 d | 36 | 431 |
| Educador Sanitário Xô Gatinho (15227) | ML ACZ | 1,5 | 12 | — | — | 8 d | 33 | 3.433 |
| [Fardo] Areia Esmectita (15825) | Amazon SVL | 1,0 | 0 | — | — | 0 d | 31 | 264 |

- Margem das vendas pelo Full × fora dele (30 dias), ex.: 15984 no ML ACZ: 7,6% pelo Full × 13,1% fora.
- Planos da Amazon pelo app: ACZ 22/10 (transporte confirmado), ACZ 21/10 (**erro**: "o anúncio exige preparo pelo
  vendedor"), SVL 19/10 (transporte confirmado).
- Modelo de caixa de exemplo: 15919 "Fardo com 2", 30×50×40 cm, 8 kg. Transporte: 13 coletas da parceira da Amazon a
  R$ 0,00 × "por nossa conta".

**Tarefas** (9 abertas)

| Tarefa | Tipo | Responsável | Situação |
|---|---|---|---|
| Contagem Bandejas e Caixas de Transporte Four Plastic | contagem | Nikolas | fazendo, prazo 13/10, atrasada |
| Organização bandejas, produtos e cestos do fundo | organização | Tânia | fazendo, prazo 20/10, atrasada |
| 7 tarefas "outra" (comprar envelope de segurança, encomendar tampinhas, alterar foto de kit…) | outra | Renan | sem prazo |

- Feitas: 11.
- Equipe: Nikolas, Kevin, Tânia, Vinicius, Renan.

**Pede ação (com esses dados)**
- 1 envio com coleta hoje ainda não enviado: FBA19TPQXVN9, pronto.
- 1 plano da Amazon com erro (ACZ, 21/10).
- 56 produtos zerados no CD que vendem.
- 241 unidades inutilizáveis nos CDs, 130 delas na Shopee.
- 2 tarefas atrasadas.

## O que entregar

1. A aba completa em **Envios**, com o cabeçalho (dados de quando + sincronizar + filtro global), a faixa "Pede ação" e o
   quadro com os 5 envios acima, na versão quadro e na versão lista.
2. A **tela de packing** do #79220166 (ML ACZ, 411 un, 13 itens) no meio da separação (76%) e no fim (pronto para lançar
   estoque), com o diálogo de "Lançar estoque no Tiny".
3. **Novo envio** pelo PDF: o upload, a conferência (um caso batendo, um com divergência) e o envio criado.
4. **Reposição** com os grupos Urgente / Sugerido / Ok, a seleção e o painel "Montar envio", mais o **stepper do plano
   Amazon** em dois momentos: escolher destino e escolher transporte.
5. **Inventário** agrupado por produto, com uma linha expandida mostrando 3 CDs.
6. **Tarefas**: o quadro e a **contagem no celular** (cega, no meio), mais o diálogo "Conferir com o Tiny e ajustar".
7. Estados: carregando por bloco, erro de um bloco só, dado velho (âmbar) e "tudo em dia".
8. Claro e escuro da tela principal. No celular: a faixa, a lista de envios, o packing e a contagem.

Explique em poucas linhas a hierarquia escolhida: o que a equipe da bancada vê primeiro, o que o dono vê primeiro, e como as
duas coisas convivem na mesma aba.
