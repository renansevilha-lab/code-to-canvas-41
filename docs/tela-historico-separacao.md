# Tela Histórico de Separação — backend + prompt de design

> Estado: **captura PRONTA e no ar** (front grava em `separacao_log`) + **views
> de leitura criadas** (migration `view_separacao_historico`, 14/ago/2026).
> Falta o **front** (`/historico-separacao`) — montar visual no Lovable com o
> prompt abaixo e ligar nas views.

## O que motivou
Pedido do dono: manter um **histórico visual** das separações — qual TAG foi
aplicada, **quem** imprimiu a etiqueta e **quando**, **quem** embalou, e **que
horas / por quem** a TAG foi finalizada.

## Como a captura funciona (JÁ NO AR)
Tabela append-only **`separacao_log`** `(id, criado_em, evento, usuario, tag,
order_sn, separacao_id, sku, detalhe jsonb)`. O front grava via helper
compartilhado `src/lib/separacaoLog.ts` (`registrarSeparacaoLog`), sempre em
segundo plano (`void`) e com try/catch — **o log nunca trava a operação**.
`usuario` = `perfil.nome` (usePerfil).

Eventos gravados hoje:
- **`tag_aplicada`** — `separacao.tsx` (`aplicarTag`, `aplicarTagVarios`). `tag`,
  `detalhe.grupo`, `detalhe.pedidos_tagueados`.
- **`etiqueta_impressa`** — `separacao.tsx` nos 3 fluxos: por lote
  (`imprimirLote`), por SKU (`imprimirPorSku`) e por pedido (`imprimirPedido`).
  `tag`/`sku`/`order_sn` conforme o fluxo; `detalhe.via` = `lote|sku|pedido`.
- **`embalado`** — `separacao.tsx` (`marcarEmbalado`, `embalarPorSku`,
  `embalarPedido`, `marcarEmbaladoVarios`). `detalhe.via`, `detalhe.forcado`.
- **`tag_finalizada`** — `monitoramento.tsx` (`finalizar`). `tag`, `usuario`,
  `detalhe` com qtd_pedidos/total_unidades/sku do card.

> Nota: só popula depois que o Lovable reconstruir e a operação usar a versão
> nova. Antes disso as views respondem 0 linhas (normal).

## Dois modos de visualização (requisito do dono)
A tela precisa mostrar o histórico **por LOTE (TAG)** e **por PEDIDO**. Cada modo
tem sua view:

- **`view_separacao_historico_tags`** — **um cartão por TAG** (modo por lote):
  `tag, sku, foto_capa, aplicada_em, aplicada_por, primeira_impressao_em,
  ultima_impressao_em, qtd_impressoes, impressa_por[], embalado_em, embalada_por[],
  finalizada_em, finalizada_por, primeiro_evento_em, ultimo_evento_em, dia`.
  `impressa_por`/`embalada_por` são **arrays** de nomes distintos.
- **`view_separacao_historico_pedidos`** — **uma linha por PEDIDO tagueado**
  (modo por pedido): `separacao_id, numero_ecommerce, venda_numero, sku,
  nome_produto, qtd_unidades, marca_canal, forma_envio, tag_lote, situacao,
  tag_lote_em, foto_capa, aplicada_em, aplicada_por, impressao_em, impressa_por,
  embalado_em, embalado_por, finalizada_em, finalizada_por, dia`.
  Cada pedido **herda** os eventos da sua TAG (aplicada/impressa-lote/finalizada)
  e **sobrepõe** eventos individuais (impressão/embalado por pedido, quando o
  operador usou o fluxo por pedido). Base = `separacao_tiny` (durável: guarda
  situação 9; ~2 meses de histórico), join com `separacao_log`.
- **`view_separacao_log_enriquecido`** — o log cru + `foto_capa` + `dia` (fuso
  São Paulo), para a **linha do tempo detalhada** de uma TAG/pedido e filtros por
  evento/usuário.
- Todas com GRANT select p/ anon+authenticated. Foto por SKU interno
  (`produtos.foto_capa`) — cobertura parcial, fallback p/ ícone.

> **Limitação do modo por pedido:** o elo pedido↔TAG mora em `separacao_tiny`
> (fila operacional, ~2 meses). Pedidos muito antigos que saíram da tabela não
> aparecem no modo por pedido; o modo por TAG e o log cru continuam completos.

## Contrato de dados (como o front liga)
- **Toggle de modo** na URL (ex.: `?modo=tag|pedido`, padrão `tag`).
- **Modo por TAG — lista de cartões:** `view_separacao_historico_tags` filtrando
  por `dia` (padrão = hoje, fuso São Paulo). Ordenar por `ultimo_evento_em desc`.
- **Modo por pedido — lista/tabela:** `view_separacao_historico_pedidos` filtrando
  por `dia`. Busca por `numero_ecommerce`/`venda_numero`/`sku`/`tag_lote`.
  Ordenar por `aplicada_em desc`. Mostra a TAG de cada pedido (clicável → filtra a
  TAG no modo por TAG).
- **Detalhe / timeline:** `view_separacao_log_enriquecido` where `tag = X`
  (ou `separacao_id = Y`) order by `criado_em` — cada evento com hora e usuário.
- **Filtros úteis:** por `dia` (date range), por `evento`, por `usuario`, por
  `marca_canal`. Estado na URL (`useSearchParams`), padrão do projeto.
- **Rota:** `/historico-separacao`, módulo **`galpao`** (adicionar em
  `ROTA_MODULO` do `usePerfil` + item no menu, grupo do galpão).
- Padrões: `QueryClient` de módulo, `refetchOnWindowFocus:false`,
  `staleTime` 5 min. Sem somar milhares de linhas no cliente (as views já
  agregam). Refetch manual + intervalo curto opcional (é histórico, não precisa
  ao-vivo agressivo).

---

## PROMPT PARA O CLAUDE DESIGN (copiar/colar no Lovable)

```text
Crie uma tela "Histórico de Separação" — um registro visual e auditável do que
aconteceu com cada LOTE (TAG) de separação: quando a TAG foi aplicada, quem
imprimiu as etiquetas e a que horas, quem embalou, e quando/por quem a TAG foi
finalizada. Público: gestor do galpão conferindo a operação do dia.

TOPO: título "Histórico de Separação" + subtítulo "Quem fez o quê, e quando".
Um SELETOR DE MODO bem visível (dois botões/abas): "Por TAG (lote)" e
"Por pedido". Seletor de DIA (padrão: hoje) com navegação ‹ hoje ›. Uma linha de
contadores do dia (TAGs no total, finalizadas, em aberto). Campo de busca (por
TAG, número do pedido ou SKU) e filtro por pessoa (chips) e por tipo de evento.

=== MODO "POR TAG (lote)" ===
CORPO — lista de CARTÕES, um por TAG (lote), ordenados do mais recente para o
mais antigo. Cada cartão traz:
- Miniatura do produto (foto_capa; fallback para ícone de caixa) + o SKU + a TAG
  em selo escuro.
- Uma LINHA DO TEMPO horizontal com 4 marcos, cada um com ícone, hora (HH:MM) e
  o nome de quem fez:
  1) TAG aplicada — hora + quem (aplicada_por / aplicada_em)
  2) Etiquetas impressas — primeira→última impressão + quantas vezes
     (qtd_impressoes) + a(s) pessoa(s) que imprimiram (impressa_por[])
  3) Embalado — hora + a(s) pessoa(s) (embalada_por[] / embalado_em)
  4) Finalizada — hora + quem (finalizada_por / finalizada_em)
- Marcos ainda não ocorridos aparecem apagados/"—". Quando finalizada, um selo
  verde "Finalizada". Cada nome de pessoa como chip colorido.
- Clicar no cartão expande a LINHA DO TEMPO DETALHADA (todos os eventos do log
  daquela TAG, em ordem, com hora exata e usuário; útil para reimpressões e
  correções).

=== MODO "POR PEDIDO" ===
CORPO — uma TABELA/lista densa, uma linha por PEDIDO, ordenada do mais recente
para o mais antigo. Colunas: miniatura + SKU, número do pedido (numero_ecommerce)
e venda, canal (marca_canal), a TAG do pedido (selo clicável que leva ao modo por
TAG filtrado nela), e quatro colunas de marco compactas — TAG aplicada
(hora + aplicada_por), Impressão (hora + impressa_por), Embalado
(hora + embalado_por), Finalizada (hora + finalizada_por). Marcos vazios como "—".
Clicar na linha expande a LINHA DO TEMPO DETALHADA daquele pedido (eventos do log
por separacao_id/tag, com hora e usuário). Bom para responder "o que aconteceu com
ESTE pedido" digitando o número na busca.

INTERAÇÃO: o toggle troca entre os dois modos (estado na URL). Busca e filtros
escondem/mostram linhas/cartões. Trocar o dia recarrega. Clicar numa TAG no modo
por pedido pula para o modo por TAG já filtrado. Estado vazio amigável ("Nenhuma
separação registrada neste dia").

VISUAL: sério, denso e legível (é tela de auditoria), boa hierarquia (TAG/pedido +
SKU grandes), cores por pessoa, cartões/linhas com borda, tema claro e escuro,
responsivo (funciona no tablet do galpão; no modo por pedido a tabela vira cartões
empilhados no celular).

DADOS (mock com esta forma):
- modo: "tag" | "pedido"
- dia: "2026-08-14"
- tags: [{
    tag, sku, foto_capa,
    aplicada_em, aplicada_por,
    primeira_impressao_em, ultima_impressao_em, qtd_impressoes, impressa_por: [],
    embalado_em, embalada_por: [],
    finalizada_em, finalizada_por,
    ultimo_evento_em
  }]
- pedidos: [{
    separacao_id, numero_ecommerce, venda_numero, sku, nome_produto,
    qtd_unidades, marca_canal, forma_envio, tag_lote, situacao, foto_capa,
    aplicada_em, aplicada_por,
    impressao_em, impressa_por,
    embalado_em, embalado_por,
    finalizada_em, finalizada_por
  }]
- timeline(chave): [{ criado_em, evento, usuario, order_sn, sku, detalhe }]
  (chave = tag OU separacao_id; evento ∈ tag_aplicada | etiqueta_impressa |
  embalado | tag_finalizada)
- contadores: { total, finalizadas, em_aberto }
```
