# IA · Anúncios — Fase 3: publicar direto no marketplace (estudo de viabilidade)

10/out/2026. Pedido do dono: estudar se o anúncio gerado na gestão pode ir **direto** para o
marketplace, em vez de passar pelo Tiny. Este documento é só o estudo — **nada foi criado em
marketplace nenhum**.

## Como foi verificado

Edge function `anuncio-publicar-sonda` (só leitura; código em `supabase/functions/`), chamada com
`?mkt=shopee|ml|amazon|tiktok`. Ela consulta, com os nossos tokens, o que cada API exige para
criar um anúncio (categorias, atributos obrigatórios, limites, logística) e olha um anúncio nosso
de exemplo. A única chamada que não é GET é o **validador** do Mercado Livre (`/items/validate`),
que confere um corpo de anúncio sem publicar.

O que a sonda **não** prova: a escrita em si (enviar imagem, criar o anúncio). Leitura liberada no
módulo de produtos é um sinal forte, mas a confirmação final é o primeiro anúncio de teste.

## Resultado por canal

| Canal | Contas | Acesso ao módulo de produtos | O que a API exige | Dificuldade |
|---|---|---|---|---|
| **Shopee** | Ottz e SVL | Liberado nas duas | Nome até 120 caracteres, descrição de 10 a 5.000, 1 a 9 fotos, categoria final, marca, **peso e dimensões**, canais de envio, prazo de 2 dias | Baixa |
| **Mercado Livre** | Ottz e SVL | Liberado (escopo de publicação leitura e escrita) | `family_name` (modelo novo de anúncio), marca, GTIN ou motivo da falta, até 12 fotos por URL, tipo de anúncio, modo de envio | Média |
| **TikTok Shop** | ACZ (Bumi não conectada) | Liberado | Categoria final, fotos enviadas pela API, **peso e dimensões do pacote**, depósito de venda, marca | Média |
| **Amazon** | ACZ (SVL sem o código de vendedor) | Liberado | Esquema próprio por tipo de produto (areia: 105 campos, 6 obrigatórios), EAN, NCM, país de origem, fotos por URL pública | Alta |
| Temu, Shein, Olist | — | Não há API ligada à gestão | — | Só via Tiny |

### Shopee — detalhes
- 2.056 categorias (1.766 finais); a própria API sugere a categoria pelo nome do produto
  (`category_recommend` devolveu a certa nos dois testes).
- Marca é obrigatória, mas aceita "Sem marca". "Bumi Pet Care" já é marca registrada (id 6252127).
- Nas categorias testadas (areia e acessório) **nenhum atributo é obrigatório**.
- Peso e dimensões são obrigatórios. A gestão tem o peso (`produtos.peso_bruto`), **não tem as
  dimensões** — o Tiny tem; falta trazer.
- Os anúncios atuais estão sem dados fiscais na Shopee (`tax_info` vazio): a nota sai pelo Tiny,
  então isso não bloqueia.
- Variações existem na API (`init_tier_variation`); dá mais trabalho que anúncio simples.
- Dá para criar o anúncio **não listado** (fora do ar) e ativar depois — ótimo para o piloto.

### Mercado Livre — detalhes
- O token tem `publish-sync` leitura e escrita; a conta Ottz pode anunciar (sem restrição).
- A conta está no modelo novo ("User Products"): o validador recusou o corpo antigo pedindo
  `family_name`. Isso confirma duas coisas: o validador funciona com o nosso token, e o corpo tem
  de seguir o modelo novo (o ML monta o título a partir do nome da família e dos atributos).
- Categoria de areia: só **marca** é obrigatória; **GTIN** é condicional (informar o código ou o
  motivo de não ter); título de até 60 caracteres; até 12 fotos.
- A categoria tem catálogo do ML (`MLB-CATS_LITTER`): o anúncio pode ser associado a um produto de
  catálogo existente.
- Fotos vão por URL; o ML baixa e guarda. O nosso bucket é privado — uma URL assinada temporária
  resolve.

### TikTok Shop — detalhes
- 1.978 categorias; na de higiene para pets nenhum atributo é obrigatório e não há certificação
  exigida. Dimensões do pacote são obrigatórias.
- Depósito de venda já identificado (o mesmo dos anúncios atuais).
- As fotos têm de ser enviadas pela API de imagens antes de criar o produto.

### Amazon — detalhes
- Listings, definições de tipo de produto, catálogo e restrições respondem na conta ACZ.
- Tipo `ANIMAL_LITTER`: 105 campos, obrigatórios `brand`, `bullet_point`, `country_of_origin`,
  `item_name`, `product_description`, `supplier_declared_dg_hz_regulation`. Na prática também EAN,
  NCM, peso e imagens.
- **Cada tipo de produto tem um esquema diferente** — é o canal que mais dá trabalho por categoria.
- Existe modo de validação sem publicar (`VALIDATION_PREVIEW`), ainda não testado.
- O anúncio de exemplo tem uma pendência do lado da Amazon ("outras limitações de listagem").
- Criar produto novo (ASIN novo) costuma exigir marca aprovada; entrar numa oferta de produto que
  já existe é bem mais simples.

## O ponto que decide: o vínculo com o Tiny

Hoje o Tiny é o centro: ele manda o estoque para os marketplaces e recebe os pedidos. Um anúncio
criado direto na Shopee **não nasce ligado** ao produto do Tiny. Sem o vínculo:
- o estoque daquele anúncio não acompanha o Tiny (risco de vender sem ter);
- o pedido chega ao Tiny sem produto reconhecido, e a separação e a nota travam.

O Tiny costuma casar anúncio e produto pelo **SKU** quando importa os anúncios do canal — mas isso
**ainda não foi conferido** nesta conta. É a primeira coisa a testar, antes de qualquer volume.

## O que falta na gestão para publicar

| Dado | Situação | De onde vem |
|---|---|---|
| Dimensões da embalagem | Não temos (só o peso) | Tiny (`dimensoes`) |
| EAN / GTIN | Não está no cadastro de produtos | Tiny |
| NCM e origem | Não está no cadastro de produtos | Tiny |
| Categoria em cada marketplace | Não temos | A API de cada canal sugere; a pessoa confirma |
| Marca registrada em cada marketplace | Não temos | Listas das APIs |
| Atributos por categoria | Não temos | APIs; a IA pode preencher a partir do briefing |

## Caminhos

- **A — Via Tiny (plano original).** O app grava texto e fotos no produto do Tiny; a publicação em
  cada canal continua sendo feita no Tiny. Vínculo de estoque garantido. Depende de clique no Tiny
  por canal, e o mesmo texto vale para todos os canais.
- **B — Direto no marketplace.** Um clique no app, com texto, preço e fotos próprios de cada canal.
  Exige resolver o vínculo com o Tiny e manter categoria e atributos por canal.
- **C — Direto, com piloto controlado (recomendado).** Mesmo que o B, mas começando por um produto
  na Shopee Ottz, criado **não listado**; confere-se no Tiny se o vínculo acontece pelo SKU e só
  então ativa. Depois segue para Mercado Livre (com o validador), TikTok e, por último, Amazon.

## Ordem sugerida

1. Trazer do Tiny dimensões, EAN, NCM e origem para o cadastro (leitura).
2. Tela "Publicar": categoria sugerida, marca, peso e dimensões, canais de envio, prévia do que
   será enviado. Sempre com confirmação.
3. Piloto Shopee Ottz: 1 produto, anúncio não listado, conferir o vínculo no Tiny.
4. Shopee SVL → Mercado Livre → TikTok → Amazon.

## O que precisa de decisão do dono

- Autorizar o primeiro teste de escrita (1 anúncio não listado na Shopee Ottz).
- Escolher o caminho (A, B ou C).
- Informar o código de vendedor (Merchant Token) da Amazon SVL, se a SVL entrar.
