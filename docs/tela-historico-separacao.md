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

## Backend de leitura (Supabase) — JÁ CRIADO
- **`view_separacao_historico_tags`** — **um cartão por TAG**:
  `tag, sku, foto_capa, aplicada_em, aplicada_por, primeira_impressao_em,
  ultima_impressao_em, qtd_impressoes, impressa_por[], embalado_em, embalada_por[],
  finalizada_em, finalizada_por, primeiro_evento_em, ultimo_evento_em, dia`.
  `impressa_por`/`embalada_por` são **arrays** de nomes distintos.
- **`view_separacao_log_enriquecido`** — o log cru + `foto_capa` + `dia` (fuso
  São Paulo), para a **linha do tempo detalhada** e filtros por evento/usuário.
- Ambas com GRANT select p/ anon+authenticated. Foto por SKU interno
  (`produtos.foto_capa`) — cobertura parcial, fallback p/ ícone.

## Contrato de dados (como o front liga)
- **Lista de cartões:** `view_separacao_historico_tags` filtrando por `dia`
  (padrão = hoje, fuso São Paulo). Ordenar por `ultimo_evento_em desc`.
- **Detalhe / timeline de uma TAG:** `view_separacao_log_enriquecido` where
  `tag = X` order by `criado_em` — mostra cada evento com hora e usuário.
- **Filtros úteis:** por `dia` (date range), por `evento`, por `usuario`.
  Estado na URL (`useSearchParams`), padrão do projeto.
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
Seletor de DIA (padrão: hoje) com navegação ‹ hoje ›. Uma linha de contadores do
dia (TAGs no total, finalizadas, em aberto). Campo de busca (por TAG ou SKU) e
filtro por pessoa (chips) e por tipo de evento.

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

INTERAÇÃO: busca e filtros escondem/mostram cartões. Trocar o dia recarrega.
Estado vazio amigável ("Nenhuma separação registrada neste dia").

VISUAL: sério, denso e legível (é tela de auditoria), boa hierarquia (TAG + SKU
grandes), cores por pessoa, cartões com borda, tema claro e escuro, responsivo
(funciona no tablet do galpão).

DADOS (mock com esta forma):
- dia: "2026-08-14"
- tags: [{
    tag, sku, foto_capa,
    aplicada_em, aplicada_por,
    primeira_impressao_em, ultima_impressao_em, qtd_impressoes, impressa_por: [],
    embalado_em, embalada_por: [],
    finalizada_em, finalizada_por,
    ultimo_evento_em
  }]
- timelineDaTag(tag): [{ criado_em, evento, usuario, order_sn, sku, detalhe }]
  (evento ∈ tag_aplicada | etiqueta_impressa | embalado | tag_finalizada)
- contadores: { total, finalizadas, em_aberto }
```
