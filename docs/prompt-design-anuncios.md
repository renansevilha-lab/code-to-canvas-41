# Prompt para o Claude Design — área IA · Anúncios (lista de anúncios e tela do anúncio)

> Cole tudo abaixo da linha no Claude Design. Os números de exemplo são do banco em 22/out/2026 (reais, arredondados).

---

Quero redesenhar a área **IA · Anúncios** do nosso app de gestão. O app já tem uma linguagem visual definida por você
(handoff "Painel de Vendas", telas "Promoções", "Visão geral", "Separação" e "Fulfillment"): mantenha a mesma fundação,
com **uma correção importante de contraste**, explicada na seção "Contraste" abaixo.

## Contexto

O app é a ferramenta de gestão de um pet shop que vende em Shopee, Mercado Livre, Amazon e TikTok Shop. Duas empresas usam o
app, **Ottz Pet (ACZ)** e **SVL Store / Bumi Pet**, cada uma com as suas contas nos marketplaces. O cadastro de produtos vem do
**Tiny** (nosso ERP): produto simples, **kit** (N unidades de outro produto) e **produto com variações** (um "pai" cujas
variações costumam ser kits do mesmo produto em quantidades diferentes: 4 kg, 8 kg, 12 kg…).

A área IA · Anúncios serve para **criar e melhorar anúncios** com ajuda de IA e mandá-los direto aos marketplaces:
1. escolher o produto na lista do catálogo;
2. gerar (ou escrever) o **texto**: título, descrição e destaques, usando os termos que os compradores realmente buscam;
3. gerar ou trazer as **fotos**: capas com selo, fotos de uso, de detalhe, de kit; ou aproveitar fotos de outro anúncio;
4. definir o **preço** pela margem que se quer em cada canal;
5. **enviar**: criar um anúncio novo ou atualizar o que já existe, em cada loja (Shopee Ottz/Bumi, Mercado Livre Ottz/SVL,
   Amazon ACZ/SVL), com conferência antes de qualquer escrita.

Quem usa: **o dono** e uma pessoa de cadastro/marketing, no desktop. Não é tela de bancada, mas é tela de **trabalho**: muitos
produtos por dia, e cada envio mexe em anúncio que está vendendo.

## Como a área está hoje

### Lista de anúncios (`/ia/anuncios`)

- Título "Anúncios com IA" e uma fileira de filtros em vários níveis, um embaixo do outro:
  - **situação**: Todos · Sem anúncio com IA · Em andamento · Prontos · "Fotos da família, sem capa própria";
  - **tipo**: Todos os tipos · Simples · Kits · Com variações · Criados no app;
  - **estoque**: Qualquer estoque · Estoque parado · Sem giro (30 dias) · Excesso (+120 dias), com a hora do retrato;
  - **marca** (lista), **"ainda não vende em <canal>"**, busca por SKU/nome/ID do anúncio e **ordem** (mais vendidos 30 dias ou
    120 dias, nome, SKU mais novo, anúncio mexido por último, mais dinheiro parado);
  - botão **"Importar do Tiny"** (produto cadastrado hoje no Tiny ainda não está na lista).
- Tabela, 50 por página. Cada linha:
  - caixa de seleção (só simples; com 2+ marcados aparece "Criar produto com variações (cor × quantidade)");
  - foto, nome, SKU, tipo; composição do kit ("3× 15679") ou as variações dentro do pai;
  - custo;
  - **"Onde vende hoje (preço · margem)"**: um selo por canal e loja com o preço e a margem real; o selo abre a lista dos
    anúncios daquele canal;
  - selo de **estoque parado** ("sem giro" vermelho / "excesso · 242 dias" âmbar + R$ parado);
  - situação do rascunho de IA ("texto aprovado", N fotos);
  - botões **Abrir / Criar** e menu "…" (criar produto com variações, copiar a foto do produto base, atualizar do Tiny).

### Tela do anúncio (`/ia/gerar?sku=…&canal=…&empresa=…`)

- **Topo do produto**: foto real de referência (até 4 fotos: principal + outras cores/ângulos, com ★ para a principal),
  nome, SKU, tipo, marca, categoria, custo, composição do kit, dados extras (público-alvo, embalagem, frete), **canal e
  empresa de destino** e o campo **"Instruções extras para a IA"** (ex.: "a capa deve mostrar as 3 cores").
- **4 abas**: Anúncio · Fotos · Análise · Preço e promoção.
- **Aba Anúncio** (uma coluna longa, um bloco embaixo do outro):
  - **Preço**: preço sugerido pela margem do canal (Shopee 30%), "margem que eu quero" com atalhos 10/15/20/25/30%, conta
    aberta (comissão, tarifa fixa, imposto, custo), de onde veio a taxa e "como este produto vende hoje" por canal;
  - **Referências**: arquivos e instruções que a IA usa (identidade da marca, ficha técnica…), por produto ou por marca;
  - **Termos de busca**: três colunas (Shopee com volume de busca mensal, Amazon e Mercado Livre por posição), ✓ = já está no
    título, itálico = a conferir, riscado = marca concorrente; cobertura do título; palavras escondidas da Amazon e "Modelo" do
    ML para copiar;
  - **1 · Texto**: título, descrição e destaques editáveis, "refazer com observação", briefing, avisos de regra quebrada;
  - **2 · Fotos**: só um resumo com a contagem e o atalho para a aba Fotos;
  - blocos de **variações** conforme o canal (Shopee: criar as opções num anúncio simples; ampliar opções de um anúncio que já
    está no ar; Amazon: família de variações);
  - **3 · Enviar anúncio**: cartões por loja (Shopee Ottz, Shopee Bumi, ML Ottz, ML SVL, Amazon ACZ, Amazon SVL) dizendo se o
    produto **já tem anúncio** ali; "enviar para cá" abre a **conferência**:
    - modo **criar** ou **atualizar** (padrão = atualizar quando já existe);
    - campos marcáveis (título, descrição, fotos, preço, palavras escondidas);
    - **hoje → vai ficar** lado a lado;
    - fotos: as do anúncio e as novas, clicáveis (manter/tirar, incluir/não), arrastáveis, a primeira é a capa;
    - peso e medidas; categoria e características (ML/Amazon); dados fiscais (Amazon: NCM, origem);
    - "Atualizar também" os outros anúncios do mesmo produto;
    - **Minha Promoção** no envio (Shopee): escolher a promoção e a margem do preço promocional, com a MC de cada SKU;
    - **Fotos no Tiny**: mandar as fotos aprovadas ao cadastro do Tiny;
    - pendências que bloqueiam, avisos que não bloqueiam, e o botão de enviar com confirmação.
- **Aba Fotos**:
  - **Aproveitar** (família do kit): usar as fotos do produto base / levar as fotos para os kits, atualizar as fotos em todos
    os anúncios da família;
  - **Usar fotos de outro anúncio** (os mais parecidos pelo nome primeiro);
  - **Fotos prontas, sem IA**: subir arquivos e trazer fotos de anúncios que já estão no ar;
  - **Gerar** (a etapa de IA): plano de fotos por tipo (capas em 6 estilos, uso, detalhe, kit, benefícios, passo a passo…), cada
    tipo com explicação, prompt editável, "prompt" e "imagem/refazer" por linha, dados da capa (título do selo, barra de
    pesos, quantidade de embalagens), custo estimado, fila andando e revisão (aprovar / rejeitar / refazer com "o que mudar?");
  - **Fotos das variações** (produto pai): uma capa por variação, mostrando a quantidade de embalagens.
- **Aba Análise**: vendas por dia e marketplace, margem de contribuição, ADS e margem pós-ADS por anúncio, estoque por produto
  físico (depósito, Full, a caminho, valor em estoque, cobertura).
- **Aba Preço e promoção**: por loja Shopee, os anúncios e variações com preço de hoje × cheio e MC; editar o preço na Minha
  Promoção e na Relâmpago.

### O que incomoda

- **Contraste fraco: tudo parece da mesma cor.** Fundo, cartão, borda, botão secundário, aba escolhida e texto de apoio ficam
  em cinzas quase iguais. Menus suspensos, abas e botões "fantasma" quase não se distinguem do fundo; é difícil ver o que é
  clicável e o que está selecionado.
- **A aba Anúncio é uma coluna enorme**: preço, referências, termos, texto, variações e envio empilhados. Não fica claro em que
  passo o anúncio está nem o que falta para enviar.
- **O destino (canal + loja) se confunde com o rascunho**: o texto e as fotos são um só, mas preço, capa principal e envio são
  por loja. A tela não deixa isso visível.
- **A conferência do envio é densa**: muitos campos, avisos e caixas no mesmo nível; o "hoje → vai ficar" se perde.
- **A lista tem filtros demais em fileiras soltas**, e a linha mistura muita informação (selos de canal, estoque parado,
  situação da IA) sem hierarquia.
- **A aba Fotos tem quatro jeitos de conseguir foto** (aproveitar, de outro anúncio, subir/trazer, gerar), um embaixo do outro,
  e a revisão das fotos geradas fica no meio deles.
- Confirmações misturam diálogos desenhados e janelas nativas do navegador.

## O que eu quero

### Contraste — mais forte do que nas telas anteriores (prioridade)

Nas telas que você já desenhou, os tons ficaram próximos demais e tivemos de reforçar à mão. Nesta área, e como regra para o
sistema daqui em diante:
- **Três planos bem separados**: fundo da página, cartão e área interna do cartão (tabela, campo, faixa). A diferença entre eles
  tem de aparecer em monitor comum e de bancada, não só em tela boa.
- **Bordas visíveis** em tudo que é clicável ou editável: campos, botões secundários, segmentos, chips, menus. Contraste da borda
  contra o fundo de pelo menos **3:1**.
- **Botão secundário com borda e texto escuros**, não cinza claro; botão "fantasma" só para ações terciárias, e mesmo assim com
  ícone e texto legíveis.
- **Estado selecionado inconfundível**: aba ativa, segmento escolhido e chip ligado com **fundo do acento cheio** (roxo) e texto
  branco, ou sublinhado grosso + texto forte. Nunca só "cinza um pouco mais escuro".
- **Hover e foco** com mudança clara (fundo e borda), e foco de teclado com anel do acento.
- **Menus suspensos e popovers** com sombra e borda que os separem do conteúdo, e item em hover com fundo distinto.
- **Texto**: principal quase preto; secundário ainda legível (contraste ≥ 4,5:1); o terceiro tom só para rótulos pequenos de
  apoio, nunca para informação necessária.
- O mesmo vale para o **tema escuro**: cartão claramente acima do fundo, bordas visíveis, textos secundários sem sumir.
- Referência do que já ajustamos no código (oklch, claro): fundo 0,955 · cartão 1 · área interna 0,945 · borda 0,87 ·
  borda forte 0,79 · texto 0,21 / 0,38 / 0,47. Pode ir além disso se achar necessário; menos que isso, não.

### Lista de anúncios

1. **Filtros em uma barra só**, com os mais usados à vista (situação, tipo, busca, ordem) e o resto num "Mais filtros" (marca,
   "ainda não vende em…", estoque parado). Filtros ligados viram chips removíveis, com contagem.
2. **Linha com hierarquia**: produto (foto, nome, SKU, tipo/composição) em primeiro; depois **onde vende hoje** (logos pequenos
   com preço e margem, cor só na margem); depois o **estado do anúncio com IA** como progresso curto (texto · fotos · enviado em
   N lojas); estoque parado como selo discreto; ação principal **Abrir** à direita, o resto no menu.
3. Produto com variações e kit **como no Tiny**: o pai com as variações recolhidas, o kit com a composição.
4. Barra de seleção quando há produtos marcados ("criar produto com variações").
5. "Importar do Tiny" acessível pela busca vazia ("não achou? importar do Tiny").

### Tela do anúncio

6. **Cabeçalho do produto compacto e fixo** ao rolar: foto, nome, SKU, tipo, custo e o **seletor de destino** (canal + loja) bem
   visível, dizendo o que muda com ele (preço, capa principal, envio) e o que não muda (texto e fotos são um só).
7. **Progresso do anúncio** no topo: Texto → Fotos → Preço → Enviado, com o estado de cada passo (feito / falta / com aviso) e o
   que falta para poder enviar.
8. **Aba Anúncio em duas colunas no desktop**: à esquerda o trabalho (texto, termos de busca, referências); à direita o
   resumo fixo (preço do destino com a margem, capa principal do destino, onde já está anunciado, botão de enviar).
9. **Envio por loja como lista de destinos**: cada loja com "já anunciado (link) / não anunciado", último envio e o botão.
   A **conferência** em passos ou seções recolhíveis:
   - o que muda (**hoje → vai ficar**, só os campos marcados, diferença destacada);
   - fotos (fila final com a capa, arrastar, manter/tirar);
   - dados do canal (categoria, características, peso e medidas, fiscais);
   - extras (promoção, fotos no Tiny, atualizar também);
   - **pendências** (bloqueiam) separadas de **avisos** (não bloqueiam);
   - confirmação em diálogo desenhado que diz exatamente o que será escrito e onde.
10. **Termos de busca** mais legíveis: o que já está no título, o que falta e os de concorrente claramente diferentes; volume
    de busca como barra pequena.

### Aba Fotos

11. **Uma galeria só** com todas as fotos do anúncio (geradas, enviadas à mão, trazidas de outro anúncio), com filtro
    aprovadas / para revisar / rejeitadas e a **capa principal de cada loja** marcada.
12. **"Adicionar fotos"** como um único ponto de entrada com as quatro origens (gerar com IA, aproveitar da família, de outro
    anúncio, subir ou trazer de anúncio no ar).
13. **Revisão** rápida: foto grande, aprovar / rejeitar / refazer com "o que mudar?", próxima.
14. **Gerar com IA**: plano de fotos por tipo, com explicação curta, estilo de capa em miniatura, custo antes de gerar e a fila
    andando.

### Regras de apresentação

- **Cada bloco diz de quando é o dado** (anúncio lido da Shopee às 10h12, retrato de estoque de hoje 06h20). Âmbar se velho.
- **Marketplace pelo logo pequeno**, empresa sempre visível (Ottz/Bumi, ACZ/SVL).
- **Cor com significado**: vermelho = bloqueia ou perde dinheiro, âmbar = atenção, verde = pronto/aprovado; roxo = seleção e
  ação.
- **Toda escrita externa** (marketplace, Tiny, gerar imagem paga) passa por **diálogo desenhado** com o resumo do efeito e,
  quando houver, o custo. Nada de `confirm` do navegador.
- **Cada bloco carrega e falha sozinho**: skeleton próprio e "não deu para ler agora · tentar de novo".
- Desktop primeiro (1366–1920 px), sem rolagem lateral da página em 1280 px.

## Restrições

- Tokens do design system que você já criou: acento roxo #6E56CF; Inter, com JetBrains Mono para números, SKUs e códigos
  (MLB…, ASIN); raio 14 px nos cartões; claro e escuro — **com o contraste reforçado descrito acima**.
- Números em pt-BR: 1.234 un · R$ 1.234,56 · 17,3% · datas dd/mm.
- O menu lateral e o cabeçalho do app já existem; desenhe só a área de conteúdo.
- Não invente funções: a Shopee e o ML não deixam mudar o limite por compra pela API; o ML exige título ≤ 60 caracteres; a
  Amazon só cria anúncio na conta com token de vendedor; foto já enviada ao Tiny não se apaga pela API.

## Dados de exemplo (reais de 22/out/2026, arredondados)

- Catálogo: **2.317 produtos ativos** (≈ 1.300 linhas na lista, porque as variações ficam dentro do pai); 345 com estoque
  parado (243 excesso, 113 sem giro, em 19/out).
- Anúncios com IA: **110 rascunhos** em 106 produtos · **465 fotos** (415 aprovadas, 39 para revisar, 11 rejeitadas) · 42
  textos aprovados.
- Envios feitos pela tela: Shopee 25 criados + 29 atualizados (3 com erro) · Mercado Livre 5 criados + 9 atualizados ·
  Amazon 1 criado.
- Exemplo de produto: **Areia Bumi Pet 4kg Mandioca (15984)**, custo R$ 16,90. Como vende hoje (120 dias, preço mediano por
  unidade · margem de contribuição): Mercado Livre Ottz R$ 34,90 · 9,2% (362 un em 30 dias); Shopee Ottz R$ 35,86 · 15,4%
  (210 un); Amazon ACZ R$ 34,91 · 12,9% (37 un); Shopee Bumi e Amazon SVL sem venda em 30 dias. Termos da Shopee (buscas/mês):
  "areia para gato" 339 mil · "areia biodegradável gato" 119 mil · "areia de gato" 62 mil.
- Exemplo de pai com variações: **Areia Higiênica Bento Mix 4kg a 20kg (16486)**, 5 variações (4, 8, 12, 16, 20 kg = 1× a 5×
  o 16452), preço padrão pela variação mais cara.
- Exemplo de kit: **Kit 3 Bumi Pet (15824) = 3× 15679**.
- Estilos de capa: 1 Básica com selo "Preço de Atacado" · 3 Livre com selo · 4 Ambientada com título · 5 Ambientada sem texto
  (centralizada) · 6 Ambientada com selo. Capa principal por loja: Shopee Ottz = selo de preço; Shopee Bumi = ambientada com
  título; Mercado Livre = ambientada sem texto.

## O que entregar

1. **Lista de anúncios** com a barra de filtros, chips ligados, 8–10 linhas (simples, kit, pai com variações aberto, com e sem
   anúncio de IA, com estoque parado) e a barra de seleção.
2. **Tela do anúncio, aba Anúncio**, do 15984 com destino Shopee Ottz: cabeçalho fixo, progresso, duas colunas e a lista de
   destinos.
3. **Conferência do envio** em modo **atualizar** (hoje → vai ficar, fotos, pendência + aviso) e o diálogo de confirmação.
4. **Aba Fotos** com a galeria, o "Adicionar fotos" e a revisão de uma foto gerada.
5. **Folha de contraste**: os tokens propostos (fundo, cartão, área interna, bordas, três tons de texto, acento, hover, foco,
   selecionado) em claro e escuro, com os botões primário / secundário / fantasma, aba ativa, segmento escolhido, chip ligado e
   menu suspenso aberto lado a lado, para eu conferir que dá para distinguir tudo.
6. Estados: carregando por bloco, erro de um bloco só, envio com pendência e envio pronto.

Explique em poucas linhas como a tela deixa claro o que é do anúncio (texto e fotos, um só) e o que é de cada loja (preço,
capa principal, envio).
