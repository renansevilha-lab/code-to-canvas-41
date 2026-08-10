# Tela de Monitoramento de Lotes — spec, backend e prompt de design

> Estado em 10/ago/2026: **backend PRONTO no Supabase** (views + coluna + RPC).
> **Falta o front** (`/monitoramento`) — montar o visual no Lovable com o mock
> abaixo e ligar nas duas views + RPC. Decisões já fechadas com o dono.

## 1. Objetivo
Painel de bancada para acompanhar, ao vivo, os pedidos que devem ser **separados
e embalados no sistema** (hoje = **Shopee, single-SKU**; MULTI SKU fica fora do
fluxo, só conta nos totalizadores). Cada card é o **gêmeo digital da etiqueta
identificadora física** que passamos a imprimir — quem bate o olho relaciona a
etiqueta na caixa com o card na tela.

## 2. Decisões (fechadas com o dono)
1. **"Finalizar TAG" = só monitoramento** — marca `tags_lote.finalizada_em` e tira
   da tela; **NÃO** toca no Tiny/situação (desacoplado do "embalar").
2. **Recorte: hoje, Ottz+SVL juntas** (sem filtro por loja por ora).
3. Escopo: Shopee (`marca_canal IN ('Shopee (Ottz Pet)','Sevilla Store [SHOPEE]')`),
   single-SKU (`qtd_skus = 1`). MULTI SKU (`qtd_skus > 1`) só no totalizador.

## 3. Backend — JÁ CRIADO (migration `monitoramento_lotes_backend`, 10/ago/2026)
- **Coluna** `tags_lote.finalizada_em timestamptz` (nullable; NULL = ativo na tela).
- **`view_monitoramento_lotes`** — 1 linha por card (lote impresso, não finalizado,
  Shopee, hoje). Já filtrada e ordenada por `sequencia, criado_em`. Colunas:
  `tag, sku, produto_nome, foto, tipo_envio, grupo_origem, unidades_por_pedido,
  qtd_pedidos, total_unidades, etiquetas_impressas, etiquetas_confirmadas,
  impresso_em, sequencia, marca_canal, data`. **A foto já vem na view** (join em
  `view_foto_produto`) — não precisa buscar `produtos` à parte.
- **`view_monitoramento_totais`** — 1 linha (funil do dia). Colunas:
  `a_separar_pedidos/unidades, em_lote_lotes/pedidos/unidades,
  na_tela_lotes/pedidos/unidades, finalizadas_lotes/pedidos/unidades,
  multi_pedidos/unidades`.
- **RPC** `monitoramento_finalizar_tag(p_tag text, p_desfazer boolean default false)`
  — SECURITY DEFINER, só afeta o lote de hoje com aquela tag. GRANT anon+authenticated.

## 4. Front — A FAZER (`/monitoramento`)
- Query `view_monitoramento_totais` (1 linha) + `view_monitoramento_lotes` (cards),
  ambas com `refetchInterval` ~20s (painel vivo). `select("*")`.
- **Finalizar TAG:** update otimista (some o card na hora) →
  `supabaseExternal.rpc("monitoramento_finalizar_tag", { p_tag: tag })` → em erro,
  volta o card + toast. Desfazer: mesmo RPC com `p_desfazer: true`.
- Rota nova + item no menu (grupo Principal, módulo `separacao`, `ROTA_MODULO` em
  `usePerfil`). Estado (se houver filtros) na URL.
- Padrões do projeto: `QueryClient` de módulo (`refetchOnWindowFocus:false`),
  somar absolutos nos totais, nunca puxar `produtos` inteiro.

## 5. Funil (semântica dos totalizadores)
```
A separar (fila, sem tag) ─▶ Em lote (tag, sem etiqueta) ─▶
  Na tela (etiqueta impressa)  ──Finalizar TAG──▶ Finalizadas
MULTI SKU = fora do fluxo (informativo)
```
`a_separar` = `view_separacao_pedidos` (situacao=1, Shopee, single, `tag_lote IS NULL`)
— é um snapshot "agora". Os demais buckets são de `tags_lote` do dia.

---

## 6. PROMPT PARA O CLAUDE DESIGN (copiar/colar no Lovable)

```text
Crie uma tela de "Monitoramento de Lotes de Separação" — um painel de bancada, pensado para ser lido de longe, num monitor no setor de embalagem.

TOPO — totalizadores (funil do dia): uma fileira de cartões grandes com números destacados, na ordem do fluxo: "A separar", "Em lote (aguardando etiqueta)", "Na tela / etiqueta impressa", "Finalizadas" e, separado/apagado, "MULTI SKU (fora do sistema)". Cada um mostra nº de PEDIDOS e, abaixo menor, UNIDADES. É um funil: dá pra perceber quanto já andou no dia.

ÁREA PRINCIPAL — grade de cards de lote. Cada card é o gêmeo digital de uma etiqueta física de lote e deve conter, com hierarquia visual forte:
- TAG em destaque grande (ex.: 1307-01) — é o que a pessoa procura.
- Badge do tipo de envio com cor própria (ER, SPX, ML).
- Foto do produto (grande) + nome do produto.
- Unidades por pedido (ex.: "3 un/pedido"), nº de pedidos e total de unidades do lote — três números claros.
- Progresso das etiquetas: "X/Y impressas" (e quantas confirmadas), como barrinha ou selo.
- Botão "Finalizar TAG" — ao clicar, o card sai da grade (com animação de saída) e o totalizador "Finalizadas" incrementa.

COMPORTAMENTO: o painel atualiza sozinho a cada ~20s (sensação de tempo real). Só aparecem lotes com etiqueta impressa; os demais ficam só nos totalizadores. Cards ordenados por sequência de criação.

DIREÇÃO VISUAL: legibilidade à distância (tipografia grande, bom contraste), cores por tipo de envio, foto do produto com peso visual, densidade de "board" (vários cards por linha, responsivo). Estados vazios amigáveis ("Nenhum lote na tela — tudo finalizado 🎉"). Suporte a tema claro e escuro.

DADOS (mock com esta forma):
- totais: { a_separar:{pedidos,unidades}, em_lote:{...}, na_tela:{...}, finalizadas:{...}, multi_sku:{...} }
- cards: [{ tag, sku, produto_nome, foto, tipo_envio, unidades_por_pedido, qtd_pedidos, total_unidades, etiquetas_impressas, etiquetas_confirmadas }]
- ação: botão "Finalizar TAG" chama onFinalizar(tag) e remove o card.
```
