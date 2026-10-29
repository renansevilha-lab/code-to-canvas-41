# Devoluções e reembolsos — reforma da tela (plano, 29/out/2026)

Pedido do dono: (1) uma aba com TUDO que precisa da resposta dele, com o sistema aprendendo as
respostas e sugerindo; (2) quantificar erros de separação/embalagem; (3) e (4) cancelados com NF
emitida — recentes e antigos — com a NF de devolução gerada e autorizada sozinha. Decisões dele
(29/out): Shopee + Mercado Livre já nesta entrega; histórico + IA redige; NF automática da Ottz
desde fev/2026; erros ligados à pessoa que finalizou a TAG.

## O que existe hoje (medido)

- **Tela `/devolucoes`** (`src/routes/devolucoes.tsx`, visual antigo shadcn): abas Cancelados (NF)
  [Ottz | SVL], Recebidas, Shopee (abertas), Perdas Shopee. A aba ativa não fica na URL.
- **Shopee:** espelho `shopee_devolucoes` completo (motivo, texto, fotos, solução, prazos
  `prazo_disputa`/`prazo_vendedor`, logística, escrow). Ação de resposta na `shopee-devolucao-probe`:
  `responder-reembolsar` (`returns/confirm`), `responder-disputar` (`returns/dispute`, com motivos
  de `get_return_dispute_reason` e fotos por `convert_image`). **Nunca gravamos o que foi
  respondido** nem o resultado. Não há `returns/offer` (contraproposta) nem mensagem ao comprador.
  Últimos 60 d: ACCEPTED/solução só reembolso 531; CANCELLED 355; abertas que pedem gente:
  REQUESTED 10 · PROCESSING 19 · JUDGING 3 · ACCEPTED com `PENDING_REQUEST` 6.
- **Mercado Livre:** NÃO há espelho de reclamações. A API responde com o nosso token
  (`/post-purchase/v1/claims/search?player_role=respondent&status=opened`): hoje **6 abertas na
  Ottz**, e cada uma traz `players[].available_actions` = o que o ML espera de nós
  (`send_message_to_mediator` obrigatório com `due_date`, `send_message_to_complainant`, `refund`,
  `open_dispute`). Mensagens: `GET/POST /post-purchase/v1/claims/{id}/messages`. É exatamente a
  "caixa de entrada" pedida, já com prazo.
- **Erros físicos:** `devolucao_recebida_itens.estado` só tem ok/furado/faltando/quebrado (486
  entradas desde 11/ago, 56 com problema). Não existe CAUSA interna (separação × embalagem ×
  transportadora × cliente). Motivos Shopee em 90 d: NOT_RECEIPT 985 (transportadora), ITEM_MISSING
  248, WRONG_ITEM 107, SPILLED 43, DAMAGED 32, CHANGE_MIND 55, ITEM_NOT_FIT 30. Dos 432 de erro
  provável, 225 casam com uma TAG e 108 já têm `tags_lote.finalizada_por` (o nome só existe desde
  19/set — a cobertura sobe daqui em diante).
- **Cancelados com NF (Ottz):** `notas_cancelados` só cobre desde **06/jul** (janela da
  varredura): jul–out = 588 pedidos com NF viva, **578 sem devolução** (R$ 34 mil), 491 com mais
  de 29 dias (precisam do clone). Antes de julho, `pedidos_tiny` tem **~1.050 cancelados com
  NF** (fev–jun) que nunca foram varridos — não se sabe quantos têm NF ainda autorizada (só o
  Tiny ao vivo diz). A SVL tem o motor `devolucao-auto` (cria + emite, crons 135/158); a Ottz
  não tem nada automático. `nf-devolucao` e `ml-devolucao-lookup` **não estão no repositório**
  (só no ar) — ler com `get_edge_function` antes de mexer.

## Desenho da tela (uma tela, 5 abas, aba na URL `?aba=`)

```
Devoluções e reembolsos                              [Ottz · SVL · Ambas]  [Atualizar]
┌ Pede resposta (N) ┐ Recebidas ┐ Erros ┐ NF dos cancelados ┐ Perdas Shopee ┐
```

Barra do topo em todas as abas (4 números): **respostas vencendo hoje** · **sem resposta** ·
**NF de devolução pendentes** · **erros do mês (%)**. Visual = tokens `--pm-*` em `.pm-ui`
(o padrão das telas novas), peças de `src/components/producao/ui.tsx` (`Cartao`, `Selo`,
`Botao`, `Numero`) e `separacao/ui/kit.tsx` (`Segmento`, `FaixaPedeAcao`, `BarraAbas`).
Cada aba nova vem com a antiga de reserva (`ProtecaoPacking`), como nas outras reformas.

### Aba 1 — Pede resposta (Shopee + ML numa fila só)
Lista ordenada por prazo (vence hoje em vermelho, amanhã âmbar), filtros marketplace / loja /
tipo (devolve produto · só reembolso · mediação ML) / motivo. Linha = foto do produto, pedido,
loja, motivo + texto do cliente, valor, prazo, **o que o marketplace espera** (Shopee: validar
/ disputar / produto chegou·validar; ML: responder ao mediador / ao comprador / reembolsar).
Clicar abre o **painel lateral do caso**: tudo que já temos (itens, fotos do cliente, rastreio
da ida e da volta, se já deu entrada no galpão e em que estado, escrow, histórico de mensagens
do ML) + **bloco de resposta**:
- **Sugestão** no topo: "casos parecidos: você respondeu assim N vezes" (3 últimas) +
  botão "Redigir com IA" (OpenAI já cadastrada; o texto vem das suas respostas em casos do
  mesmo motivo/situação, adaptado ao texto deste cliente) — sempre editável, nada sai sem clique.
- **Ações por marketplace**: Shopee = Aprovar reembolso · Disputar (motivo + texto + fotos) ·
  **Contraproposta** (`returns/offer`, novo) · Validar produto recebido; ML = Mensagem ao
  comprador · Mensagem ao mediador · Reembolsar · Abrir disputa (`available_actions` manda).
- **Causa interna** (obrigatória ao responder; sugerida pelo motivo): erro de separação (item
  errado / faltando) · embalagem (furado / vazou / quebrado) · transportadora (não recebi /
  extravio) · produto (defeito / validade) · cliente (desistiu / não serviu) · outro. É isso
  que alimenta a aba Erros.

### Aba 2 — Recebidas (a bancada de hoje) + causa
Mantém a bipagem como está e ganha o mesmo seletor de **causa interna** e o campo "quem
separou" preenchido sozinho (TAG → `finalizada_por`). Estados por item ganham `errado` e
`vazado` (hoje só ok/furado/faltando/quebrado).

### Aba 3 — Erros (quantificação)
Cartões do mês: erros de separação, de embalagem, transportadora, cliente — cada um com nº,
% sobre pedidos enviados no mês e R$ reembolsado. Abaixo: **por pessoa** (erros ÷ pedidos
que ela finalizou no mês, com a ressalva do login compartilhado), **por SKU** (top 20, com
foto — mostra produto que chega furado/errado com frequência), **por mês** (6 meses, linha).
Filtro Ottz/SVL/Ambas e marketplace. Fonte = `view_devolucao_erros` (abaixo).

### Aba 4 — NF dos cancelados (Ottz e SVL no mesmo painel)
Substitui "Cancelados (NF)". Topo: fila do motor (a criar · criadas aguardando emissão ·
autorizadas no mês · precisam de gente, com o motivo). Lista com filtro por estado e idade
(até 29 dias · 30–60 · mais antigas) e busca; linha mostra pedido, canal, NF de venda, NF de
devolução (nº/situação), última tentativa. Botões só para o que precisa de gente: "Marcar
como não precisa", "Tentar de novo", abrir no Tiny. Painel "Antigos (fev–jun)" com o botão
**"Varrer e incluir"** que chama a varredura por período (confere a NF ao vivo no Tiny — só
entra quem tem NF autorizada, como hoje).

### Aba 5 — Perdas Shopee
Fica como está (só ganha o visual novo e a aba na URL).

## Banco (migrações; SQL + rollback em `docs/devolucoes-reforma.sql`)

1. **`ml_claims`** (espelho das reclamações do ML, as duas contas): `claim_id` PK, `conta`,
   `order_id`, `pack_id`, `tipo` (mediations/returns/cancel_purchase), `stage`, `status`,
   `reason_id`, `reason_texto`, `resolucao`, `acoes_disponiveis` jsonb (as `available_actions`
   do respondent, com `due_date`), `prazo_acao`, `return_id`, `criado_em`, `atualizado_em`,
   `fechado_em`, `raw` (enxuto). **`ml_claim_mensagens`** (`claim_id`, `mensagem_id` PK,
   `de` (buyer/seller/mediator), `texto`, `anexos`, `data`). Preenchidas pelo
   `ml-devolucao-lookup` (já lê `claims/search`): módulo novo `claims` (abertas a cada 20 min +
   fechadas do dia) e `claim-mensagens`.
2. **`devolucao_resposta`** (o histórico que ensina): `id`, `marketplace`, `conta`,
   `case_id` (return_sn / claim_id), `order_sn`, `motivo_mkt`, `texto_cliente`, `solucao`,
   `valor`, `fotos_cliente` (n), `tem_entrada_galpao`, `estado_item`, **`causa_interna`**,
   `acao` (aprovar / disputar / oferta / mensagem_comprador / mensagem_mediador / reembolsar /
   validar_ok / validar_recusa), `texto_resposta`, `motivo_disputa_id`, `sugestao_usada`
   (nenhuma / historico / ia / ia_editada), `respondido_por`, `respondido_em`, `resposta_mkt`
   (crua), **`resultado`** (preenchido depois pelo sync: reembolso aprovado / disputa ganha /
   perdida / comprador aceitou oferta…). Só a edge fn grava.
3. **`devolucao_resposta_modelo`**: modelos salvos à mão (nome, marketplace, causa, acao,
   texto, `usos`). O "Salvar como modelo" nasce no painel.
4. **`devolucao_causa`** (dicionário) + coluna **`causa_interna`** em `devolucoes_recebidas` e
   **`separador`** (= `tags_lote.finalizada_por` via `separacao_tiny.tag_lote`, gravado na
   entrada e na resposta). `devolucao_recebida_itens.estado` aceita `errado` e `vazado`.
5. **`view_devolucoes_pede_resposta`**: UNION Shopee (`view_devolucoes_shopee_abertas` +
   PROCESSING com produto chegado) × ML (`ml_claims` abertas) com colunas comuns
   (`marketplace, conta, case_id, order_sn, prazo, acao_esperada, motivo, texto, valor, sku,
   foto, entrada_galpao`), ordenada por prazo. RPC **`devolucao_caso(marketplace, case_id)`**
   = tudo do painel lateral em 1 chamada (itens, fotos, rastreios, entrada, mensagens ML,
   respostas anteriores do mesmo pedido). RPC **`devolucao_sugestoes(marketplace, motivo,
   causa, solucao, texto)`** = as N respostas mais parecidas (mesmo marketplace+motivo+ação;
   desempate por `similarity` do `pg_trgm` no texto do cliente e por resultado positivo).
6. **`view_devolucao_erros`** (base da aba 3): uma linha por caso com causa (da resposta ou
   da entrada; sem classificação humana, causa **provável** pelo motivo do marketplace, marcada
   `provavel=true`), mês BRT, marketplace, conta, SKU(s), `separador`, R$ reembolsado
   (`view_shopee_reembolsos.valor_reembolsado`), + **`mv_devolucao_erros_mes`** (mês × causa ×
   pessoa × SKU; refresh no cron 62) e `view_separador_pedidos_mes` (denominador = TAGs
   finalizadas por pessoa/mês → pedidos).
7. **Motor da Ottz:** `devolucao-auto` parametrizado por `?conta=` (hoje `svl` está fixo em
   3 lugares + série 12 + `devolucoes_svl_base` + `view_devolucao_auto_candidatos_svl`):
   mapa por conta {fila, espelho, série (Ottz = **13**), início}; fila da Ottz =
   `view_devolucao_auto_candidatos_ottz` sobre `notas_cancelados` (NF viva, sem devolução,
   `precisa_devolucao` não-falso) + espelho `devolucoes_ottz_base` (mesma forma da SVL,
   preenchido pelo `espelhar` lendo tipo E série 13). **Notas com mais de 29 dias:** o motor
   passa a chamar `nf-devolucao?modulo=clonar` (hoje só avisa) — ler os parâmetros reais no
   código no ar antes. Crons novos `devolucao-auto-ottz` (processar `max=3`, `12,27,42,57`) e
   `devolucao-auto-emitir-ottz` (`4,19,34,49`, `max=3`) — somados à SVL ficam ~24 notas/h; se
   a SEFAZ 656 aparecer, o motor já pausa 1 h. **Varredura antiga:** `nf-devolucao?modulo=
   varrer-cancelados&de=2026-02-01&ate=2026-06-30` em janelas de 15 dias (conferir se o módulo
   aceita período; senão acrescentar), disparada pelo botão da aba 4 e repetida até zerar.
   Backlog Ottz ≈ 578 + até 1.050 → 2 a 5 dias para drenar.

## Edge functions

- **`shopee-devolucao-probe` v29:** `responder-reembolsar`/`responder-disputar` gravam em
  `devolucao_resposta`; módulos novos `responder-oferta` (`returns/offer` + `get_available_
  solutions`), `validar-produto` (`returns/confirm` no PROCESSING com produto chegado /
  `returns/dispute` para recusar) e, no `sync`, preencher `devolucao_resposta.resultado`
  quando o status final chega. Exige JWT de usuário nos módulos de escrita (hoje passam com a
  chave publicável — fechar isso junto).
- **`ml-devolucao-lookup` v5:** `claims` (espelho, cron 20 min) · `claim-mensagens` · escrita:
  `claim-mensagem` (`POST /claims/{id}/actions/send-message`, receiver_role complainant |
  mediator) · `claim-reembolsar` (`/actions/refund`) · `claim-disputa` (`open_dispute`) ·
  `claim-review-return` (`/claims/{id}/returns/{rid}/reviews` — produto OK / não OK). Prévia
  sem `confirmar`; com `confirmar` exige login; cada envio uma vez; registro em
  `devolucao_resposta` + `debug_fulfillment`.
- **`devolucao-resposta-ia`** (nova; se o limite de funções barrar, módulo `sugerir` dentro da
  `ia-anuncio` ou da `shopee-devolucao-probe`): recebe o caso + as 5 respostas mais parecidas
  (RPC) + modelos → OpenAI (`_shared/ia.ts`, `claude()` roteia) → texto curto no tom da casa,
  em português, sem prometer o que a regra não permite (prompt fixo + regras em
  `ia_prompt_guardrail` tipo `instrucao`, escopo `devolucao`). Nunca envia nada sozinha.
- **`devolucao-auto` v7:** `?conta=svl|ottz` (acima) + chamada do `clonar`.

## Front

- `src/routes/devolucoes.tsx`: abas na URL (`?aba=resposta|recebidas|erros|nf|perdas`,
  `resetScroll: false`), filtro de empresa comum, faixa de números no topo.
- Novos em `src/components/devolucoes/`: `PedeResposta.tsx` (lista), `PainelCaso.tsx` (lateral
  com ações por marketplace, sugestões, causa), `Sugestoes.tsx`, `Erros.tsx`, `NfCancelados.tsx`
  (absorve `DevolucaoAutoSvlPainel` para as duas contas), `ui.tsx` (peças comuns).
- `DevolucoesRecebidas.tsx`: campo causa + separador + estados novos (mudança pequena).
- Tipos/chamadas em `src/lib/devolucoes.ts`; mantém `src/lib/shopeeDevolucao.ts`.

## Ordem de entrega (cada passo publicável sozinho)

1. Banco: `ml_claims`, `devolucao_resposta`, `devolucao_causa`, colunas novas, views e RPCs.
2. `ml-devolucao-lookup` v5 (espelho + mensagens, só leitura) e cron → a fila do ML já aparece.
3. Tela: abas na URL + aba **Pede resposta** com painel do caso e as ações que já existem
   (Shopee aprovar/disputar), gravando `devolucao_resposta` e a causa.
4. Escritas novas: Shopee oferta/validar; ML mensagem/reembolso/disputa/review — **cada uma
   testada ao vivo num caso real com o OK do dono**.
5. Sugestões (histórico por semelhança) → depois a IA.
6. Aba Erros + causa nas Recebidas + MV.
7. Motor da Ottz (`devolucao-auto` v7, série 13, clone) + crons + varredura fev–jun; aba NF.
8. Perdas no visual novo; CLAUDE.md §5.10/§5.2.3 atualizados.

## Riscos e o que confirmar no caminho

- `nf-devolucao` e `ml-devolucao-lookup` só existem no ar: baixar, versionar em
  `supabase/functions/` e só então alterar (regra do §10).
- Série da devolução da Ottz = 13 (§5.2); confirmar que o `criar` com `conta=ottz` ainda passa
  nos guards (ele foi escrito para a Ottz originalmente).
- `returns/offer` e as escritas do ML nunca foram usadas: formato pela doc; 1º uso real valida.
- Reembolso ML pelo app é dinheiro saindo: confirmação dupla na tela, valor e pedido na frente.
- A sugestão da IA só fica boa depois de ~30–50 respostas gravadas; até lá vale o histórico puro.
