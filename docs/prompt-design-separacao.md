# Prompt para o Claude Design — Separação (Fila, Multi SKU, Lotes, Monitoramento)

> Cole tudo abaixo da linha no Claude Design. Os números de exemplo são do banco em 21–22/out/2026 (reais, arredondados).

---

Quero redesenhar a tela de **Separação** do nosso app de gestão. O app já tem uma linguagem visual definida por você
(handoff "Painel de Vendas", telas "Promoções", "Visão geral" e "Fulfillment"): mantenha a mesma fundação.

## Contexto

O app é a ferramenta de gestão de um pet shop que vende em Shopee, Mercado Livre, Amazon e TikTok Shop. Duas empresas usam o
app: **Ottz Pet (ACZ)** e **SVL Store / Bumi Pet**. Na Shopee são duas lojas: **Ottz** e **Bumi**.

A Separação é a tela **mais usada do app**. A equipe do galpão (4–5 pessoas) passa o dia nela:
1. Pega uma "linha" da fila, por exemplo "Areia Bumi 4kg · Entrega Rápida · 2 un por pedido · 24 pedidos".
2. Clica **Imprimir etiqueta**. O app reserva uma **TAG de lote** (ex.: `2210-07`), imprime as etiquetas de envio na Zebra
   (Shopee por loja, Mercado Livre pedido a pedido) e, por último, uma **etiqueta identificadora** do lote. Depois marca a TAG
   no ERP (Tiny), só nos pedidos que saíram.
3. Separa os produtos, embala e cola as etiquetas.
4. **Marca embalado.** Só é liberado quando a impressora confirmou a etiqueta; senão existe o "forçar", com nome e motivo.
5. No **Monitoramento**, quem termina **finaliza a TAG** e leva o crédito.

**Regra de ouro do dono:** etiqueta já impressa **nunca sai de novo sozinha**. Reimprimir é sempre uma ação consciente
("forçar"). Bug aqui trava a bancada, gera etiqueta em dobro ou deixa pedido para trás. O que mais custa dinheiro é **prazo**:
pedido da Shopee não coletado até ~3 dias depois do prazo é **cancelado automaticamente**.

O trabalho é dividido por **peso**: acima de 4 kg é dos pesados (Nikolas e Kevin), até 4 kg dos leves (Tânia e Vinicius).
O peso vem do cadastro.

Tipos de envio, em ordem de prioridade:
1. **ER, Entrega Rápida** (Shopee): coleta no mesmo dia.
2. **SPX, Shopee Xpress.**
3. **ML, Mercado Livre**: com **Flex** (motoboy no dia), agência e coleta.
4. **TikTok.**

O Full (estoque que já está no CD do marketplace) não passa por aqui.

## Como a tela está hoje

O item "Separação" do menu tem três abas: **Fila · Monitoramento · Histórico**.

**Fila** (`/separacao`, sem filtros na URL; tudo se perde ao recarregar)
- Cabeçalho sem título, só o texto "Fila de pedidos aguardando separação no galpão (Full excluído)", e três botões:
  "Processar abertos", "Atualizar do Tiny" e "Atualizar fila".
- Sub-abas: **Fila Priorizada · Multi SKU (contador) · Detalhado**. A Detalhado é antiga e ainda manda "copiar a TAG para
  colar no Tiny".
- **4 indicadores**: Aguardando separação · Em separação · Separadas hoje · Embaladas hoje. Embaixo, "Atualizado há X" e
  **outro** "Atualizar do Tiny".
- **Faixa "Etiquetas do dia"**, por loja: "N a despachar · N prontas (x%) · N gerando · N em erro" e o ritmo ("N geradas /
  30 min"). Se a geração para, fica vermelha ("geração PARADA"). Na mesma faixa, "⚠ Cancelamento automático Shopee: cancela
  HOJE N pedidos (N embalados aguardando coleta · N na fila · R$) · cancela amanhã …".
- **Painel "Lotes do dia"**, recolhido por padrão:
  - resumo "Finalizadas hoje: Vinicius 87 · Nikolas 38";
  - um "Como usar" desatualizado;
  - **o seletor de impressora** (a fila inteira usa a impressora escolhida aqui, escondida dentro de um painel fechado);
  - caixa "imprimir etiqueta identificadora";
  - tabela de TAGs (TAG, bloco, pedidos, status), com até 4 botões + um seletor de loja + menu por lote.
- **Barra de filtros com ~17 controles numa faixa**:
  - chips de envio "Todos / ER / SPX / ML" (Ctrl+clique soma);
  - "SEM ESTOQUE", "CANCELA HOJE", "CANCELA AMANHÃ" e "ML FLEX";
  - "Ottz | Bumi";
  - peso "Até 4 kg | 4 a 8 kg | Acima de 8 kg | Sem peso";
  - "Full (fora do galpão): N";
  - os botões "Imprimir tudo" e "Embalar impressos";
  - o resumo "N TAGs · N pedidos · N un";
  - "Prazo" (vencidos, hoje, amanhã, 2 dias…);
  - busca por SKU, nome ou nº do pedido. Se o número não está na fila, avisa "pode já ter sido separado".
- **A fila** é agrupada por envio. Cada grupo tem um cabeçalho colorido, por exemplo "ENTREGA RÁPIDA (ER) — PRIORIDADE ·
  N TAGs · N pedidos · N un". No fim vem um bloco roxo "MÚLTIPLOS SKUs" só informativo (as ações estão na aba Multi SKU).
- **Cada linha**, numa única faixa horizontal:
  1. menu ⋮, caixa de seleção e seta de expandir;
  2. "#1" grande;
  3. foto 80×80;
  4. SKU · envio · selo "2un" (cor por quantidade: 1 cinza, 2 azul, 3 âmbar…);
  5. selos: "sem estoque (N)" + conferência da Shopee ("conferindo / Shopee zerada / ainda com N"), "cancela hoje (N)",
     "Flex (N)" e peso ("4,0 kg");
  6. nome e observação;
  7. **prazo** ("Vencido · 20/10", "Hoje", "Amanhã");
  8. pílula "24 pedidos / 48 un";
  9. **estado da TAG**: "TAG ao imprimir", a TAG para copiar (verde = embalada), "N com TAG, N sem" ou "TAGs diferentes";
  10. **até 4 botões empilhados**: **Imprimir etiqueta**, Reimprimir (forçar), e o botão de embalar com 5 estados
      ("Marcar embalado", "Aguardando N", "Bloqueado (N)" + "Forçar embalar", "Embalar n/m" + "Forçar restante").
- **Expandir a linha** mostra os pedidos: nº, canal, prazo, lote, situação da impressão, e um menu por pedido (imprimir só
  este, marcar embalado, forçar, falta de estoque, observação).
- **Menu ⋮ da linha**: mensagem aos clientes (Shopee), reportar falta de estoque, estoque voltou, observação, reimprimir.
- **Seleção** → barra flutuante: "Aplicar TAG em massa" (fluxo antigo), "Imprimir selecionados", "Reimprimir selecionados
  (forçar)".
- **Impressão em andamento**: barra flutuante em duas fases.
  1. "Imprimindo lote 3/12 — SKU · N etiquetas · TAG·loja", com Pausar / Parar após esta linha;
  2. "Impressora imprimindo · faltam N na fila · N confirmadas", com Fechar.
- **Diálogos desenhados**:
  - "Forçar embalar": quem está forçando, motivo e "confirmo que a etiqueta física saiu";
  - "Reportar falta de estoque": lê o saldo no Tiny, "zerar no Tiny (Geral: 15 → 0)", e em kit pergunta qual componente;
  - "Mensagem aos clientes".
- **Mas ainda há 17 confirmações nativas do navegador** (`confirm`): reimprimir, imprimir em massa, impressora offline,
  embalar em massa… A observação é editada num `prompt` do navegador.

**Multi SKU** (pedido com 2 ou mais produtos diferentes)
- Alternância **"Por pedido | Picking list"**, com um seletor de impressora próprio (o segundo da tela).
- Filtros: envio, loja, prazo, estado (sem TAG, com TAG, impressos…).
- **Por pedido**: um cartão por combinação idêntica ("15984 ×2 + 15679 ×1"), com fotos sobrepostas, nº de pedidos, prazo,
  "n/N impressos", e os botões **Imprimir etiquetas** e **Embalar**. Ao expandir: itens com foto e 📍 localização na
  prateleira, e a tabela dos pedidos.
- **Picking list**:
  - à esquerda, "N SKUs · N un a separar": local, produto, necessário, pedidos e um campo **separado**;
  - à direita, **"Liberados para impressão (N)"**, os pedidos cujos itens já foram todos separados, com o botão **"Liberar e
    imprimir"**;
  - também à direita, "Ainda incompletos", que mostra o que falta.

**Monitoramento** (painel ao vivo, atualiza a cada 20 s, com relógio grande; fica aberto na bancada)
- **Funil**: A separar → Em lote (aguardando etiqueta) → Na tela / etiqueta impressa → Finalizadas. Tem ainda um card
  desatualizado "Multi SKU (fora do sistema)".
- **"Lotes na tela"**: um card por TAG com a TAG grande, prazo, envio, foto, **peso em destaque**, "2 un/ped · 24 pedidos ·
  48 un", "etiquetas 24/24 impressas · 24 confirmadas" e o botão **"Finalizar TAG"**. O botão dá o crédito a quem clica e não
  tem desfazer na tela.
- As cores dos envios aqui são outras, diferentes das da Fila.

**Histórico**: por TAG ou por pedido, por dia, semana ou mês. Linha do tempo de cada TAG: aplicada → impressa → embalada →
finalizada, com hora e pessoa. Filtro por pessoa e evento.

**O que incomoda**
- **Densidade.** Cada linha tem 3 controles à esquerda, 5–6 tipos de selo, o estado da TAG e até 4 botões empilhados. A barra
  de filtros tem 17 controles. Ninguém sabe para onde olhar.
- **O botão que importa** ("Imprimir etiqueta") tem o mesmo peso que "Reimprimir (forçar)", que é perigoso e fica logo abaixo.
- **Impressora escondida**: a fila imprime na impressora escolhida dentro de um painel recolhido. Há 3 lugares diferentes
  para escolher impressora. Já houve impressão "às cegas" na Zebra errada.
- **Prazo e risco de cancelamento** estão numa faixa de texto no topo e em selos pequenos. Não organizam a fila.
- **Divisão por peso** (pesados × leves) é só um filtro. Cada pessoa precisa lembrar de ligar o seu.
- **Duplicações**: dois "Atualizar do Tiny", "Reimprimir" como botão e no menu, "Aplicar TAG em massa" convivendo com o botão
  único, a aba "Detalhado" e o "Como usar" desatualizados.
- **Confirmações nativas** (17) misturadas com diálogos desenhados.
- **Nada na URL**: recarregar perde filtros e aba.
- **Celular**: a linha não quebra (colunas de largura fixa), a impressora tem 380 px fixos e as barras flutuantes cobrem o
  conteúdo.
- **Resultado das ações só em toasts** que somem (alguns ficam 10–12 s), sem um lugar para ver "o que aconteceu com a minha
  impressão".

## O que eu quero

### Estrutura geral

1. **Cabeçalho da tela** com:
   - título "Separação";
   - quando a fila foi atualizada;
   - **impressora atual sempre visível**: "Imprimindo em: Zebra 2 (PC Nikolas) · online", com troca rápida. Uma só, que
     vale para Fila, Multi SKU e Lotes;
   - **um** botão de atualizar, com "Atualizar do Tiny" num menu.
2. **Faixa "Pede ação"** (mesmo espírito da Visão geral e do Fulfillment), em contadores clicáveis que **filtram a fila**:
   - **cancela hoje / amanhã** (pedidos e R$), separando "na fila" de "embalado esperando coleta";
   - **prazo vencido / vence hoje**;
   - **etiquetas**: geração parada ou com erros, por loja ("Ottz 120/130 prontas · 10 em erro");
   - **impressão presa** (job enviado que a impressora não confirmou);
   - **falta de estoque** reportada, com o retorno da Shopee ("ainda com N");
   - **Multi SKU pendentes**.

   Com tudo em dia: "Tudo em dia ✓".
3. **"Meu turno"**: escolher uma vez **Leves (até 4 kg) / Pesados (acima de 4 kg) / Todos** e a fila já abre filtrada para
   aquela pessoa ou bancada. Os limites de peso vêm do banco.
4. Abas **Fila · Multi SKU · Lotes do dia · Monitoramento · Histórico**. Lotes do dia sai de dentro da Fila, e a Detalhado
   sai. Filtros e aba na URL.

### Fila

5. **Filtros enxutos**:
   - à vista: envio (chips com contagem), loja (Ottz / Bumi), peso (vem do "Meu turno") e busca (SKU, nome ou nº do pedido);
   - o resto (prazo detalhado, Flex, sem estoque, cancela) num botão "Filtros (N)" ou vindo dos contadores da faixa.
6. **Grupos por envio** na ordem de prioridade (ER → SPX → ML → TikTok), cada um com o total. Dentro do grupo, a ordem que
   o banco já calcula (#1, #2…).
7. **Linha redesenhada, legível a 1 m de distância**:
   - à esquerda: foto, nome curto e SKU, com o **"2 un por pedido" bem grande** (é o que a pessoa separa);
   - no meio: **pedidos e unidades** ("24 pedidos · 48 un"), o **prazo** como selo de cor e, só quando houver, os alertas
     (cancela, sem estoque, Flex, peso faltando). Nada de selo para estado normal;
   - à direita, **um botão principal que muda conforme o estado da linha**:
     - sem TAG → "**Imprimir etiqueta**";
     - impressa, aguardando a impressora → "Imprimindo… 18/24", com progresso;
     - confirmada → "**Marcar embalado**";
     - embalada → TAG verde e "✓ Embalado".

     **Reimprimir e Forçar** ficam num menu "mais" e sempre abrem um diálogo vermelho. Nunca botão do mesmo tamanho ao lado do
     principal;
   - a TAG da linha visível e copiável quando existe.
8. **Expandir a linha** mostra os pedidos (nº, loja, prazo, TAG, impressão) com as ações por pedido no menu.
9. **Seleção e impressão em massa**: barra embaixo com "Imprimir N linhas (N pedidos)" e "Embalar impressos". A
   **impressão em andamento** vira um **painel lateral ou inferior persistente**: fila de linhas, o que saiu, o que falhou,
   "faltam N na impressora", com Pausar / Parar. Ao terminar, fica um resumo consultável ("Impressão das 14h12: 12 linhas,
   250 etiquetas, 2 com erro") no lugar dos toasts.

### Multi SKU

10. **Por pedido**: cartões por combinação, com os produtos lado a lado (foto + "×2"), a **localização** de cada um e
    as ações Imprimir / Embalar.
11. **Picking list** como fluxo de bancada:
    1. lista do que buscar na prateleira, ordenada por localização, com campo "separado" grande e "✓ tudo";
    2. à medida que os itens completam, os pedidos **liberados** aparecem com "Liberar e imprimir (N)".

    Mostre o que falta para cada pedido incompleto.

### Lotes do dia

12. Tabela das TAGs do dia (TAG, produto/bloco, pedidos, loja, status: impressa, embalada, finalizada por quem), com
    resumo "Finalizadas hoje: Vinicius 87 · Nikolas 38" e ações por lote (reimprimir identificadora, marcar embalado,
    observação) no menu. Status único e coerente (hoje um lote mostra "Aguardando impressão" e "✓ Impresso" juntos).

### Monitoramento

13. Painel para **ficar aberto na bancada / TV**: funil grande e cards por TAG com a TAG enorme, produto, **peso em
    destaque**, "un por pedido", etiquetas impressas × confirmadas, prazo, e "**Finalizar TAG**" com quem está finalizando
    visível (o crédito é de quem clica) e **desfazer** por alguns segundos. Mesmas cores de envio da Fila.

### Histórico

14. Manter a linha do tempo, com o visual novo.

### Diálogos

15. Desenhe os diálogos que substituem as confirmações nativas:
    - **Reimprimir (forçar)**: "estas N etiquetas já saíram às 14h12; reimprimir gera etiqueta em dobro se a primeira estiver
      na bancada";
    - **Imprimir em massa**: quantas linhas, pedidos e etiquetas, e em qual impressora;
    - **Impressora offline**: trocar ou tentar assim mesmo;
    - **Forçar embalar**: quem, motivo, confirmação;
    - **Falta de estoque**: zerar no Tiny e escolher o componente do kit;
    - **Observação**: no lugar do `prompt` do navegador.

### Regras de apresentação

- **Cor com significado**:
  - vermelho = perde dinheiro agora (cancela hoje, vencido, bloqueado);
  - âmbar = atenção;
  - verde = feito.

  O roxo do acento é para ação e seleção. **Cores de envio** iguais em todas as abas, em detalhe pequeno (um selo ou uma
  borda), sem pintar a linha inteira.
- **Marketplace e loja pelo logo pequeno** (Shopee, Mercado Livre, TikTok), como nas outras telas novas.
- **Alvos de toque ≥ 44 px** nos botões principais. A bancada usa mouse, mas também tablet e celular.
- **Cada bloco carrega e falha sozinho**: a fila pode carregar enquanto a faixa de etiquetas mostra "não deu para ler
  agora".
- **Dado com data**: "fila atualizada há 40 s", "etiquetas lidas há 3 min".
- Densidade: na tela de 1366×768 da bancada, a faixa "Pede ação" + filtros + **pelo menos 6 linhas da fila** sem rolar.

## Restrições

- Tokens do design system que você já criou: acento roxo #6E56CF; Inter, com JetBrains Mono para TAG, SKU e números;
  cartões brancos sobre #F4F5F7, raio 14 px; claro e escuro.
- Números em pt-BR: 1.234 · R$ 312,76 · datas dd/mm · horas 14h12.
- O menu lateral e o cabeçalho do app já existem; desenhe só a área de conteúdo.
- Desktop primeiro (1366–1920 px), sem rolagem lateral. No **celular**: faixa, fila (linha empilhada), Multi SKU picking e
  Monitoramento.
- Não mude regras: embalar só com impressão confirmada (ou forçado com nome), reimpressão sempre explícita, a identificadora
  sai por último, multi-SKU fora da impressão em massa da fila, TikTok sem etiqueta pelo app, Mercado Livre da conta SVL
  imprime pelo painel do ML.

## Dados de exemplo (reais, 21–22/out/2026)

**Fila agora:** 100 linhas, 246 pedidos, 680 unidades.

| Envio | Linhas de 1 produto | Pedidos | Un. | Multi SKU (linhas · pedidos · un.) |
|---|---|---|---|---|
| Entrega Rápida (ER) | 24 | 104 | 243 | 8 · 13 · 29 |
| Shopee Xpress (SPX) | 39 | 79 | 279 | 8 · 17 · 53 |
| Mercado Livre (ML) | 15 | 26 | 62 | 3 · 4 · 9 |
| TikTok | 2 | 2 | 4 | — |

- Multi SKU: **34 pedidos** na aba.
- Peso das linhas: 40 até 4 kg · 17 de 4 a 8 kg · 35 acima de 8 kg · 3 sem peso.

**Primeiras linhas (ER)**

| # | Produto | Por pedido | Pedidos | Unidades |
|---|---|---|---|---|
| 1 | Areia Bumi Pet 4kg Mandioca (15984) | 2 un | 24 | 48 |
| 2 | Areia Esmectita com Carvão Ativado 4kg (15679) | 2 un | 13 | 26 |
| 3 | Areia Bumi Pet 4kg Mandioca (15984) | 1 un | 13 | 13 |
| 4 | Areia Mya Cat Mandioca Torrão Firme 2kg (16010) | 5 un | 13 | 65 |
| 5 | Areia Kets Gatissimo 4kg (14758) | 2 un | 10 | 20 |
| 6 | Areia Bumi Pet 2kg Mandioca (16028) | 5 un | 5 | 25 |
| 7 | Educador Sanitário Xô Gatinho 500 ml (15035) | 1 un | 4 | 4 |

**Etiquetas do dia**

| Loja | A despachar hoje | Com etiqueta | Gerando | Em erro | Ritmo |
|---|---|---|---|---|---|
| Ottz | 130 | 120 | — | 10 | 3 geradas / 30 min |
| Bumi | 83 | 73 | 2 | 8 | 2 geradas / 30 min |

- Mais antigo sem etiqueta: 6 h (Ottz).

**Outros números**
- **Cancelamento automático:** Bumi, 3 pedidos (R$ 312,76) cancelam amanhã, 23/10; os 3 ainda estão na fila.
- **Lotes de ontem:** 126 TAGs, 125 finalizadas, 352 pedidos. Finalizadas por: Vinicius 87, Nikolas 38.
- **Falta de estoque** reportada nas últimas 24 h: 2 pedidos.
- **TAG**: formato `ddmm-NN` (ex.: `2110-07`). Impressoras: "Zebra 2 (PC Nikolas)", "Zebra Frente (PC Tânia)".

## O que entregar

1. A **Fila** completa com os dados acima:
   - cabeçalho com a impressora visível e a faixa "Pede ação";
   - "Meu turno: Pesados";
   - os grupos ER / SPX / ML e as linhas nos 4 estados do botão principal: imprimir, imprimindo, marcar embalado, embalado.
2. Uma **linha expandida** com os pedidos, e o **menu "mais"** com reimprimir/forçar.
3. A **impressão em massa em andamento** (painel persistente) e o **resumo depois de terminar**.
4. **Multi SKU** nos dois modos, com a picking list pela metade (alguns pedidos liberados, outros incompletos).
5. **Lotes do dia** e o **Monitoramento** em tela cheia (bancada / TV), com o "Finalizar TAG" e o desfazer.
6. Os **diálogos**: reimprimir (forçar), imprimir em massa, impressora offline, forçar embalar, falta de estoque (produto
   simples e kit) e observação.
7. Estados: fila vazia ("Nada para separar 🎉"), carregando por bloco, erro de um bloco só, impressora offline e geração
   de etiquetas parada.
8. Claro e escuro da Fila. Celular: faixa, fila e picking list.

Explique em poucas linhas a hierarquia escolhida: o que a pessoa na bancada vê primeiro, como ela sabe o próximo passo de
cada linha sem ler, e como as ações perigosas (reimprimir, forçar) ficam longe das do dia a dia.
