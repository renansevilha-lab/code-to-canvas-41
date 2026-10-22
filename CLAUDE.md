# Ottz Pet — App de Gestão Multi-canal

Contexto permanente do projeto. Leia antes de qualquer alteração.

---

## 1. O que é

App de gestão para um pet shop multi-canal (Shopee, Mercado Livre, Amazon,
TikTok Shop, Temu, Shein, Olist). Duas empresas operam nele: **Ottz Pet / ACZ
Pet** e **SVL Store / Sevilla**.

Não é um app de conteúdo — é **ferramenta de operação diária**. A equipe usa para
separar pedidos, imprimir etiquetas e decidir reposição de estoque. Bug em
produção trava gente na bancada. Trate mudanças em separação, etiquetas e login
com o cuidado correspondente.

**Stack:** React + Vite + TypeScript + React Query + Supabase (gerado pelo
Lovable). Repositório: `renansevilha-lab/code-to-canvas-41`.

---

## 2. Arquitetura — a regra mais importante

**A lógica de negócio mora no banco, não no front.**

O app lê views e chama edge functions. Cálculo de margem, CMV, imposto,
classificação, agregação — tudo é feito em Postgres. O front exibe.

Consequências práticas:

- **Nunca** recrie regra de cálculo em TypeScript. Se precisa de um número
  agregado, provavelmente já existe view ou função — pergunte antes de somar no
  navegador.
- **Nunca** some milhares de linhas no cliente. Além de lento, o PostgREST corta
  em 1.000 linhas por padrão e o resultado fica **silenciosamente errado** (já
  aconteceu: tela mostrava R$ 52 mil quando o real era R$ 170 mil).
- Alterações de schema, views e edge functions **passam pelo dono do projeto**.
  Há coisa em produção que a operação usa agora.

**Supabase:** projeto `vhogjofsxyhnyxdyglmq`. Edge Functions em Deno/TypeScript,
agendamentos via `pg_cron`.

---

## 2.1 Multi-conta ML/Amazon (31/ago/2026)

A tabela **`lojas`** é a fonte de canal/empresa/alíquota por `shop_id`. ML usa o
próprio `user_id` como shop_id (Ottz 1107117809). Amazon usa shop_id
**sintético** (seller_id é alfanumérico): **900001 = Amazon (ACZ Pet)**,
**900002 = Amazon (SVL Store)** — a verdade da conta segue em
`oauth_tokens_amazon.seller_id` e `pedidos.fonte='amazon:{cnpj}'`.

Regras ao mexer em função que usa token ML/Amazon:
- **NUNCA "pegar o token mais recente"** — com 2+ contas é roleta (mesma
  armadilha da regressão do Tiny multi-conta). Ou a função **loopa todas as
  contas** (ml-sync, ml-sync-wallet, fulfillment-sync, amazon-sync-*), ou
  escolhe o token pelo **`pedidos.shop_id`** (ml-etiqueta), ou **pina** na
  Ottz com `OTTZ_USER_ID = 1107117809` (ml-sync-ads, ml-sync-anuncios,
  ml-promocoes — tabelas deles não têm coluna de conta).
- `ml-notificacoes` é webhook PÚBLICO (verify_jwt=false): **não redeployar via
  MCP** (o deploy religa verify_jwt e derruba os webhooks do ML). Idem
  `amazon-oauth`/`ml-oauth` (callbacks de navegador): depois de qualquer deploy,
  desligar "Enforce JWT verification" no painel.
- Conexão de conta nova: ML = `ml-oauth?help=1` (upsert por user_id; trigger
  `trg_loja_ml_nova` cria a loja p/ user_id ≠ Ottz). Amazon = autoautorização no
  Portal do provedor de soluções (menu ˅ do app → token de atualização) e
  inserção manual em `oauth_tokens_amazon`.
- **Amazon: o `refresh_token` só funciona no aplicativo SP-API que o emitiu.**
  Token de um app + credencial de outro = LWA `unauthorized_client` (≠
  `invalid_grant`, que é token corrompido). Cada empresa tem seu app — Ottz
  "Ottz Analytics", SVL "SISTEMINHA I". Por isso a conta guarda o rótulo
  **`oauth_tokens_amazon.lwa_app_ref`** (ex.: `SVL`) e as credenciais ficam em
  secrets **`AMAZON_LWA_CLIENT_ID_<REF>` / `AMAZON_LWA_CLIENT_SECRET_<REF>`**
  (sem rótulo = secrets globais). **Nunca guardar client_secret no banco**: com
  ele fora, vazar a tabela não basta para usar o refresh_token.
- Alíquota de imposto vem de **`lojas.aliquota_imposto`** (crons 46 e 57), não
  mais escrita na mão por shop_id/CNPJ — conta nova nasce com o imposto certo.
- Função que processa várias contas precisa de **orçamento de tempo por conta**:
  com limite global, a primeira consome os 50s e a segunda fica sem nada
  (aconteceu na `amazon-sync-pedidos`; corrigido na v16).
- **Nunca consultar o banco por item dentro de laço de sync.** A
  `amazon-sync-pedidos` fazia 2 consultas por pedido só para saber se já o
  conhecia; como a SP-API devolve do mais ANTIGO para o mais recente, o
  orçamento acabava no meio e **o resto do período nunca era alcançado** — a
  conta nova ficou com 16 dias vazios no meio de agosto e o sync **reportava
  sucesso**. v18 faz a checagem em LOTE (2 consultas por página de 50): a
  chamada do cron caiu de estourar 50s para 24s com 129 pedidos.
  Auditar cobertura com **`?debug=contar&de=YYYY-MM-DD`** (compara quantos a
  Amazon diz existir × quantos há no banco) e preencher buraco com
  `?modulo=pedidos&conta=<seller|cnpj>&de=...&ate=...`. Atenção: no timeout
  interno o `nextToken` é zerado, então `faltou_pagina:false` **não** prova que
  terminou — olhe o array `erros`.

## 2.1.1 Token vencido em silêncio (10/set/2026)

`ml-refresh-token` **devolve 200 mesmo quando o refresh falha** (o resultado
vai só no corpo: `falhas`/`resultados`), então o cron marca "succeeded" e
ninguém vê. Uma falha transitória do ML às 16:00 deixou o token da Ottz
**vencido por ~1h**: `ml-etiqueta` respondia "conta NÃO conectada (contas:
1299638625)" — só a Bumi sobrava na lista de válidos — e a bancada achou que a
impressão em massa "não funcionou". Defesas: cron `ml-refresh-token` passou de
2h para **30 min** (retenta sozinho; só renova quem vence em <60 min), e a
`view_tokens_saude` (ML/Shopee/Tiny/Amazon: `situacao` vencido/vencendo/ok) é
vigiada pelo watchdog `etiquetas-saude?modulo=verificar` (20 min) com alerta
no canal erros e cooldown de 2h. Diagnóstico rápido: `select * from
view_tokens_saude`; cura: `ml-refresh-token?force=1` (ou `?user_id=`).
**Segunda queda (12/set/2026) — o banco travado no minuto cheio:** o refresh
no ML funcionava, mas a gravação em `oauth_tokens_ml` morria em "DB: Gateway
Timeout" 6 rodadas seguidas (11:00→13:30 UTC) e o token venceu de novo.
Causa: às :00/:15/:30/:45 rodam juntos `refresh-margem-incremental` (20–27 s,
reescrevia ~900 pedidos por rodada sem checar mudança), `cmv-congelar-novos`
(11–21 s) e o refresh das matviews, com o banco em 511 MB (acima do teto);
todo cron que caía nesse segundo levava timeout (Tiny, Amazon, ML). Feito:
`ml-refresh-token` v16 com **retry 3× no select/update + aviso no Discord**
(canal erros) e cron movido para **`7,37`** com `Authorization: Bearer`
(deploy religou o verify_jwt); `refresh-margem-incremental` movido para
`4,19,34,49` e os UPDATEs de imposto/renda ganharam `IS DISTINCT FROM` (só
reescreve o que mudou); `cron.job_run_details` encolhido (retenção 3 dias,
truncate+reinsert). Sintoma no app: **Pedidos Integrados "não puxa" o ML** —
a `view_margem_pedido_v2` exige `escrow_atualizado_em`, que só o
`ml-sync?modulo=pedidos-detalhes` preenche; com token vencido os pedidos
entram em `pedidos` mas não aparecem no PI. Cura: `ml-refresh-token?force=1`
→ `ml-sync?modulo=pedidos&dias=2` → `ml-sync?modulo=pedidos-detalhes&max=80`.
**Mesma armadilha no Tiny (16:00 UTC do mesmo dia):** `tiny-refresh-token-auto`
rodava `0 * * * *` sem auth; o token do Tiny dura 4 h, três `:00` seguidos
com "Erro ao ler tokens: Gateway Timeout" e o `processar-abertos` parou de
aplicar TAG/aprovar ("Tiny API 401 em /pedidos", 6 candidatos presos por 1 h).
Movido para **`13,43`** com Bearer; `amazon-refresh-token-auto` para
`3,23,43`; `cmv-congelar-novos` para `6,21,36,51`; `refresh-kpi-pedidos-dia`
para `8,28,48`. **Regra: cron de renovação de token NUNCA no minuto :00/:15/
:30/:45** (19 jobs disparam em `0 * * * *`). Cura: `POST tiny-refresh-token`
(renova as duas contas) e `tiny-separacao?modulo=processar-abertos&canal=
shopee` para destravar a fila.

## 2.1.2 Custos do Full/ML pela API de faturamento (verificado 10/set/2026)

`GET /billing/integration/monthly/periods?group=ML&document_type=BILL` lista os
períodos (13 disponíveis); `GET /billing/integration/periods/key/{YYYY-MM-01}/
group/ML/details?document_type=BILL&limit=150&offset=N` devolve **cada
cobrança** com `charge_info.detail_sub_type`/`transaction_detail`, valor e, nas
tarifas por venda, `sales_info[].order_id`. Agosto/2026 (5.154 lançamentos):
CFFE envio extra R$ 10.076 · CVVML custo por vender R$ 4.869 · PADS Product Ads
R$ 4.059 · CXDE R$ 1.709 · **CFCBE coleta Full R$ 842** · **CFWA armazenamento
Full R$ 340 (892 lançamentos, sem order_id — custo do período)** · CFBA estoque
antigo Full R$ 75 · CFPB inconformidade Full R$ 48; BONUS (B*) são estornos.
Rate limit: 429 fácil — paginar com pausa (~0,6 s) e retry. Não há endpoint de
summary. `GET /shipments/{id}/costs` dá o custo do envio por pedido
(`senders[].cost`, com desconto obrigatório). **Ainda NÃO sincronizado** —
proposta: edge fn `ml-sync-billing` → tabela `ml_billing_detalhes` (period_key,
detail_id PK, sub_type, descricao, valor, order_id, data) → DRE (armazenamento/
coleta como despesa do mês; tarifas por pedido conciliam com `pedidos`).

## 2.1.3 Financeiro — o que foi ligado em 10/set/2026 (itens do dono)

- **Custos do Full no DRE (ML + Shopee):** `ml-sync-billing` (cron jobid 104,
  a cada 10 min) espelha o faturamento do ML em `ml_billing_detalhes` (PK
  `detail_id`; estado por conta/período em `ml_billing_sync_estado`; período
  ABERTO é relido a cada rodada, fechado é definitivo). `view_dre_custos_full`
  = ML sub-tipos CFWA/CFCBE/CFBA/CFPB (armazenamento, coleta, estoque antigo,
  inconformidade; B* = estorno) + Shopee `transacoes_carteira.tipo='taxa_servico'`
  com "relacionado ao Full"/"Estoque na Shopee" (SBS). Linha "Custos Full (ML /
  Shopee)" na `view_dre_mensal` (`custos_full`) e no `/dre`, com drill.
- **Shopee Acelera:** taxa da antecipação (`tipo='antecipacao_taxa'`,
  FAST_ESCROW_DEDUCT) é descontada na carteira DEPOIS do escrow — não está no
  `recebido_estimado`, logo não estava em lugar nenhum do DRE (jul/26: R$ 4,5 mil;
  set/26 até dia 10: R$ 5,8 mil). `view_dre_acelera` → coluna `acelera` e linha
  "Antecipação Shopee Acelera". Baseline: total_despesas novo = antigo +
  custos_full + acelera, ao centavo.
- **Amazon FBA:** a taxa por unidade (FBAPerUnitFulfillmentFee) já entra em
  `pedidos.taxa_servico` via `amazon-sync-financas` (dedução do pedido). Taxa de
  ARMAZENAMENTO mensal (ServiceFee "FBAStorageFee") não é capturada — está na
  Finances API `listFinancialEvents` (ServiceFeeEventList) e não no evento do
  pedido. Pendente.
- **Fornecedor agrupado no DRE:** `dre_fornecedor_grupo(fornecedor_nome PK,
  grupo)`; `view_dre_despesas_detalhe.grupo` = coalesce(grupo, btrim(nome)). O
  drill do `/dre` agrupa por `grupo` (uma linha com total e contagem, expansível)
  e cada lançamento tem "agrupar". Kevin (33 diárias/mês) virou "Salário Kevin
  (diárias)" e passou a `Pessoal` na `categoria_despesa_dre` (era "a
  classificar"); "Renan Sevilha" ≡ "Renan Sevilha Marangoni".
- **Conta a pagar criada pelo app (com boleto/NF):** `tiny-contas-pagar`
  (`modulo=contatos&q=` busca contato; `modulo=criar` POST → `POST
  /contas-pagar` do Tiny, que exige `contato.id`, `valor>0`, `dataVencimento`;
  400 do Tiny volta em `validacao`) e espelha em `contas_pagar` na hora
  (`fonte='app'`). Anexo vai ao Storage bucket `contas-pagar-docs` (policy
  anon/authenticated) + `contas_pagar_anexos(tiny_id, tipo boleto|nf|outro,
  storage_path)`. Botão "Nova conta a pagar" em `/contas-pagar`. **Não** existe
  upload de anexo para o Tiny pela API (o PDF fica só no app).
- **OC × NF do fornecedor:** `compras-sync?modulo=nf` (cron `compras-sync-nf`,
  :12/:42) espelha `GET /notas?tipo=E` em `compras_nf_entrada` + `compras_nf_itens`
  (o `codigo` do item da NF é o nosso SKU quando o produto está mapeado no
  Tiny; NF de retorno do Full — EBAZAR/MERCADO LIVRE — e de pessoa física entram
  com `ignorar=true`). Conciliação automática: OCs do mesmo `fornecedor_id`
  (contato) até 90 dias antes; score = fração dos SKUs da NF na OC (≥0,5 →
  `auto_sku`; senão OC única → `auto_fornecedor`). `view_compras_conciliacao`
  (NF × OC, Δ valor, itens divergentes) e `_itens` (qtd/preço OC × NF por SKU).
  Painel "NF do fornecedor × ordem de compra" em `/compras` com vincular/
  desvincular manual (`match_metodo='manual'`). **Escrita em LOTE** nos
  cabeçalhos (a v3 fazia 1 update por NF: 274 NFs = 74 s sem chegar aos itens).
- **Conciliação de devoluções/reembolsos:** `view_conciliacao_devolucoes`
  (Shopee `shopee_devolucoes` + ML cancelados/parcialmente reembolsados ×
  carteira por `pedido_id` × `devolucoes_recebidas` × `notas_cancelados`).
  Só view, sem tela ainda. Semântica: na Shopee o reembolso antes da liberação
  é descontado no próprio escrow (`pedidos.escrow_reembolso`) e NÃO passa pela
  carteira; ML `REFUND_MP`/`CANCELLED_MP` têm `pedido_id` (397+82 em 90 dias),
  Shopee `ressarcimento`/`estorno_credito` NÃO têm (48+29) — são créditos por
  item perdido no armazém, sem pedido.

## 2.1.5 Sessões paralelas em 11/set — o que ficou e o que foi sobrescrito

Duas sessões (dois PCs) implementaram os mesmos 4 pedidos ao mesmo tempo. O
que vale hoje:
- **Chat Shopee em massa:** a versão da outra sessão (`shopee-chat` v3, tabela
  `shopee_mensagens`, `MensagemLoteDialog`). A tentativa desta sessão foi
  bloqueada pelo classificador e sua tabela `shopee_chat_envios` foi apagada.
- **Ignorar fornecedor:** `contas_pagar_ignorar` + trigger + RPCs (outra
  sessão). A alternativa `contas_pagar_exclusoes` desta sessão foi apagada e o
  `tiny-sync-contas-pagar` voltou ao código original (v21 = v19 sem a rpc).
  Em `/contas-pagar`, o ícone ⃠ da linha chama `ignorar_fornecedor_contas_pagar`
  e o painel "Regras" lista/reativa.
- **Recorrência — DUAS formas, complementares:** (a) `repetir_meses` no
  diálogo "Nova conta" cria N meses de uma vez; (b) regra em
  `contas_pagar_recorrentes` (ícone ↻ na linha) gera todo mês pelo cron
  `contas-pagar-recorrentes` (12:00 UTC) via `tiny-contas-pagar?modulo=
  recorrentes-gerar` (`&dry=1` para prévia). **A `tiny-contas-pagar` v4 tem as
  duas**: o deploy da v3 desta sessão havia sobrescrito a v2 da outra (o front
  já mandava `repetir_meses` e a função ignorava). Lição: antes de redeployar
  uma função, `get_edge_function` e compare o cabeçalho — CLAUDE.md §10.
- **DRE custo fixo sem/com ADS:** front da outra sessão; a coluna
  `view_dre_mensal.custo_fixo_sem_ads` desta sessão ficou (redundante, inofensiva).

## 2.2 Receita fantasma — cancelamento que não chega ao espelho

O sync de rotina do ML roda com `dias=2` (custo). Pedido **cancelado depois
disso** nunca era reconferido e seguia contando como venda válida para sempre.
Revarrer por data de **criação** é caro e nunca cobre o período todo.

A forma certa é pedir ao marketplace os pedidos **atualizados**, não os criados:
`ml-sync?modulo=status&dias=N[&dry=1]` usa
`/orders/search?order.date_last_updated.from=<iso>`. Ele corrige **apenas
campos de estado** (`status_pedido`, `valido`, `motivo_cancelamento`) — não
encosta em valor, frete ou escrow — e faz a checagem em lote.

Validação de que o filtro vale: em `dry=1` o campo `mais_antigo_criado` deve
vir **antes** da janela (medido: janela de 30 dias devolveu pedido criado em
05/abr). Achado em 31/ago: **30 pedidos da Ottz corrigidos, R$ 1.270 de receita
fantasma** (motivos `buyer_cancel_express`, `mediations`,
`shipment_not_delivered`). Rode `dry=1` antes de aplicar.

## 2.1.4 Itens do dono (10/set/2026, noite — 2ª leva)

- **Mensagem em massa aos compradores Shopee por TAG de lote:** edge fn
  `shopee-chat` (`probe` = o app tem escopo `sellerchat` nas DUAS lojas —
  confirmado; `preview&tag=` lista os pedidos Shopee do lote com
  `buyer_user_id` via `get_order_detail?response_optional_fields=buyer_user_id`
  — o id do comprador NÃO está no espelho; `enviar&tag=&confirmar=1` com body
  `{texto}` → `sellerchat/send_message` 1×/pedido). Dedupe em
  `shopee_mensagens(order_sn, texto_hash)`; para no 1º erro de escopo/rate.
  Front: menu ⋮ do lote em Separação › "Mensagem aos clientes (Shopee)"
  (`MensagemLoteDialog`, modelos + confirmação com contagem). ML fica de fora
  (não há chat vendedor→comprador na API).
- **Conta a pagar recorrente:** `tiny-contas-pagar` v2 aceita `repetir_meses`
  (2–36) → N POSTs `/contas-pagar` no Tiny, um por mês, mesmo dia (mês curto =
  último dia), histórico "(n/N)"; para no 1º erro e devolve 207 com as já
  criadas. A v3 do Tiny **não tem recorrência nativa**. Checkbox "Repetir
  mensalmente" no diálogo "Nova conta a pagar". Nunca testado ponta a ponta
  com conta real (o `criar` simples também não).
- **DRE: custo fixo sem ADS → ADS → custo fixo total (com ADS).** Só
  apresentação em `dre.tsx` (`total_despesas` da view já inclui ADS).
- **"Apagar definitivamente" contas irrelevantes do Tiny:** tabela
  `contas_pagar_ignorar(fornecedor_nome)` + **trigger BEFORE INSERT em
  `contas_pagar`** que descarta a linha (RETURN NULL) — o sync de 15 min não
  precisa mudar e a conta some de tudo que lê o espelho (DRE, /contas-pagar,
  fluxo). RPCs `ignorar_fornecedor_contas_pagar(nome, motivo)` (grava a regra
  + apaga o que já entrou) e `reativar_fornecedor_contas_pagar(nome)` (o
  próximo sync traz de volta). Ação no popover "agrupar" do lançamento no
  drill do `/dre`. Diferente do `dre_conta_override.excluir` (1 lançamento, só
  DRE).

## 3. Objetos do banco que o front usa

### Existem e devem ser usados

| Objeto | O que entrega |
|---|---|
| `dashboard_visao_geral(data_inicial, data_final)` | 1 linha: vendas, custo_total, margem_contrib, margem_pct, pedidos, produtos, ticket_medio, projecao_vendas, cobertura_pct + **ads, lucro_pos_ads, lucro_pos_ads_pct** (19/set). ADS = `shopee_ads_diario` + `ml_ads_diario` no período, a MESMA definição do DRE (`view_dre_ads_marketplace`) — conferido ao centavo em jul e ago; **não** usa `view_canais_diario`, que junta o ADS do ML sem filtrar shop_id e duplicaria no dia em que a SVL do ML entrar em `pedidos_validos`. Amazon não tem ADS integrado e fica de fora. **Sem quebra por canal** |
| `view_kpi_pedidos_dia` | **MATERIALIZADA** (refresh a cada 10 min). Agregada por dia/canal/empresa/marketplace: pedidos, venda, venda_bruta, comissao_total, frete_vendedor, custo_prod, imposto, custo_total, recebido_estimado, margem, margem_pct, itens, itens_sem_cmv, cobertura_cmv_pct. **Não tem coluna de ADS** — cobre só Shopee e Mercado Livre. Para ADS por canal, fonte separada |
| `view_margem_pedido_v2` | Uma linha por pedido, com margem completa. Use `select` só das colunas exibidas + paginação |
| `view_ads_anuncios` | Uma linha por anúncio (30 dias): investimento, vendas, roas, acos, ctr, cpc, `classificacao_roas`, `teve_gasto`, foto, sku_pai |
| `view_ads_resumo` | Contadores por classificação de ROAS |
| `view_separacao_pedidos` | Fila de separação — **só situação 1** (ver armadilha na seção 5) |
| `view_tendencia_categoria / marca / produto` | Atual vs anterior por chave, com coluna `empresa` |
| `view_amazon_dashboard` | Linha a linha de pedido Amazon (sem agregado pronto) |
| `estoque_fulfillment` | Estoque nos CDs (Amazon FBA, ML Full, Shopee SBS) por marketplace/CD/sku_marketplace: sellable, reserved, in_transit, unsellable. Populada por `fulfillment-sync` (cron). Base do motor de reposição. Fonte da aba **Fulfillment › Inventário** |
| `view_reposicao_full` | Motor de reposição por SKU interno **e por conta** (`shop_id`/`empresa`, 17/set/2026 — as contas não compartilham estoque no CD: Amazon ACZ×SVL, ML ACZ×SVL, Shopee Ottz×Bumi; envios abertos casam por `fulfillment_envios.empresa`, null = ACZ Pet; filtro Ambas/Ottz/SVL na tela): estoque_full, em_transito, **em_envio_aberto** (unidades planejadas nos envios ABERTOS de `fulfillment_envios` — status != enviado, não arquivados — descontadas da necessidade/sugestão/cobertura; envio marcado enviado sai e vira in_transit no sync), cobertura_atual_dias, cobertura_alvo_dias, necessidade, **sugestao_envio**, estoque_empresa. Fonte da aba **Fulfillment › Reposição** |
| `view_reposicao_skus_alvo` | Lista de SKUs-alvo da reposição |
| `dashboard_desempenho(p_de, p_ate)` | **Dashboard › "Desempenho do período"** (21/out/2026, design "Visão geral"; SQL + rollback em `docs/dashboard-desempenho.sql`; tela `src/components/dashboard/DesempenhoPeriodo.tsx`, no TOPO do Dashboard; formatação comum em `dashboard/formato.ts`). Os cartões seguem lendo `dashboard_visao_geral` + `view_canais_diario` (série e canais) + `view_metas_realizado` (meta e ACOS do mês, selo "mês") + `vendas_por_sku/marca` + `mv_anomalias`; a função dá o resto, cada parte com `exception` própria: `horas` (receita/margem/pedidos por hora BRT da `view_margem_pedido_v2` quando o período é 1 dia, ~0,1 s), `ads_lojas` (`ads_metrica_loja_dia`: ontem gasto/ROAS/pós-ADS × 7 dias gasto/TACOS/pós-ADS), `ads_metas` (resumo de `ads_metas_situacao()`, ~0,45 s) e `relatorios` (último destaque de cada agente; o corpo fica em `/relatorios` — a seção de relatórios saiu do Dashboard e virou bloco recolhível). Saíram do Dashboard: cartões antigos, Top SKUs por margem, painel de metas, cartões detalhados por canal (o ACOS mês a mês virou recolhível). **21/out — `mv_canais_diario` corrigida** (`docs/canais-diario-ads-ml-por-loja.sql`): o ADS do ML (só da conta ACZ, `ml_ads_diario` sem conta) caía também na conta SVL do ML nos dias em que ela vendia (R$ 4.271 a mais em 180 d); agora só `shop_id 1107117809`; e as contas SVL do ML/Amazon ganharam o rótulo certo ("Mercado Livre · SVL Store", "Amazon · SVL Store"). `view_canais_sem_integracao` deixou de listar `[SVLL] Mercado Livre` (já vem pela API desde mai; repetia os mesmos pedidos). ⚠ "Hoje" compara com o dia de ONTEM inteiro (regra antiga, `periodoAnterior`), então os deltas de hoje saem sempre negativos até a noite |
| `dashboard_posicao_empresa()` + `dashboard_pede_decisao()` | **Dashboard › "Posição da empresa"** (21/out/2026, design "Visão geral"; SQL + rollback em `docs/dashboard-posicao.sql`; tela `src/components/dashboard/PosicaoEmpresa.tsx`, ABAIXO do Desempenho do período — ordem pedida pelo dono). Posição: caixa (saldo das carteiras Shopee — o ML não informa saldo pela API) e a receber por carteira de **`mv_carteira_saldo`** (retrato da `view_carteira_saldo`, que custa ~4 s; cron `carteira-saldo-refresh` `17 * * * *`), contas a pagar (atrasado / 7 / 30 dias, `view_fin_contas_pagar`) e fluxo dos próximos 30 dias (saldo = caixa de hoje + acumulado da `view_fluxo_caixa_diario`, a MESMA conta da /fluxo-caixa; pior dia e maior saída). Cada bloco tem `exception` próprio (`{"erro"}`) para falhar sozinho. Pede decisão = só alertas de NEGÓCIO com problema, por gravidade: contas atrasadas, caixa projetado negativo, ADS no prejuízo ontem (`ads_metrica_loja_dia`), ruptura (R$/dia) e parado (`dashboard_estoque_valor`), meta do mês e ACOS (`view_metas_realizado` todos), receita sem custo (`mv_anomalias`). Valores em número; o front formata. As duas juntas: 135 ms |
| `dashboard_estoque_valor()` → `mv_estoque_valor` | **Valor em estoque a custo** (21/out/2026, para o Dashboard "Posição da empresa"; SQL + rollback em `docs/estoque-valor.sql`). MV 1 linha por produto FÍSICO (simples/variação): depósito da empresa = Geral do `estoque_tiny` (ou `produtos.estoque` do cadastro para quem não está lá — 259 SKUs; pode incluir o depósito Amazon do Tiny) + Fulls do `estoque_fulfillment` (disponível + reservado + a caminho, **kit aberto nos componentes**; os depósitos Full do Tiny NÃO entram — ML/Shopee vêm negativos e o da Amazon não bate com a Amazon) × `produtos.custo`; venda 30 d com kit aberto (mesma regra da `vendas_por_sku`, reescrita com nomes completos porque ela não fixa search_path e falha no cron); situação = a do agente de compras (`ads_cobertura_sku`) ou, fora dele, a mesma regra (sem giro / excesso > 120 d). A função devolve jsonb: total, empresa × Fulls por marketplace, parado (excesso/sem giro), ruptura (unidades/dia e **receita/dia em risco**), cobertura média, 5 que mais prendem dinheiro, sem custo, atualizado_em. 14 ms. Refresh cron `estoque-valor-refresh` `52 11,21 * * *` (depois do estoque dos Fulls). 21/out: R$ 557,6 mil (empresa 505,8 + Fulls 51,8); parado R$ 284 mil (excesso 169,5 / sem giro 114,5 — inclui insumos como fita e envelope); ruptura 367 un/dia ≈ R$ 7 mil/dia. ⚠ o `venda_dia_em_risco` do relatório de compras (360) é em UNIDADES, não R$ |
| `ml_ads_diario` | ADS do ML por DIA (gasto, cliques, vendas atribuídas). Construída pelo `ml-sync-ads?modulo=diario` (a API só agrega por campanha; 1 request/dia). Cron `ml-ads-diario` 1×/dia re-sincroniza 8 dias (o ML reatribui vendas retroativamente). Histórico: 26/mai/2026+ (API recusa >90 dias). Alimenta ADS do ML em `view_dre_mensal`, `view_dre_ads_marketplace`, `view_canais_diario` e `view_metas_realizado` |
| `ml_ads_campanha_diario` | ADS do ML por **campanha/dia** (PK data+campaign_id; só campanhas com gasto/clique/venda no dia). Mesmo `modulo=diario` (v5) — soma por dia = `ml_ads_diario` ao centavo nos dias fechados. Histórico desde **06/jul/2026** (API recusa >90 d). Backfill sem mexer no DRE: `&so_campanha=1` (não regrava `ml_ads_diario`) |
| **Agente de ADS** (`ads_*`, 06/out/2026) | Motor no banco — o agente **só analisa e sugere**, nunca escreve em API de marketplace. **`ads_anuncio_snapshot`** (entrega 1): retrato diário (dia BRT) por anúncio (`variacao_id=''`) e variação Shopee: preço efetivo × `preco_original`, `em_promocao`, estoque, status, health/catálogo/visitas_30d (ML), `fonte_atualizada_em` (idade do dado). Só quem a sync tocou recentemente (Shopee 48 h, ML 30 h — o espelho guarda anúncio fora do ar). ML: `price` do item é o CHEIO; o promocional vem de `ml_promocao_itens` started. Gravado por `ads_snapshot_capturar(p_data)` (cron **140** `ads-snapshot-diario` `30 10 * * *`). Para o catálogo Shopee cobrir a loja inteira por dia, a `shopee-sync-ads?modulo=catalogo` (só anúncios não tocados em 24 h, ~200/rodada) ganhou rodadas extras: crons **141–146** (Ottz 03:00/03:30/04:30, SVL 03:15/03:45/04:45 UTC). **Métricas** (entrega 2, MVs de anúncio e campanha com **60 d** — eram 90, cortadas em 06/out para caber no teto do banco, 40,7 MB → 10,5 MB, resultados idênticos; loja segue 90 d; refresh `ads_metricas_atualizar()` ~13 s, cron **147** `ads-metricas` `20 9 * * *`): `ads_metrica_loja_dia` (Shopee = `shopee_ads_diario`; ML = soma das campanhas; + venda/margem da loja de `view_kpi_pedidos_dia`, `tacos`, `margem_pos_ads`, `cobertura_campanhas`), `ads_metrica_campanha_dia` (Shopee cobre ~87–94% do gasto da loja), `ads_metrica_anuncio_dia` (venda/margem rateadas da `view_margem_pedido_v2`; Shopee `nivel='anuncio'` por item_id; ML `nivel='sku'` — `pedido_itens` não tem MLB e 41% da receita é de SKU com >1 MLB). `vendas_ads` = base do ROAS do gabarito: Shopee `gmv_direto`, ML `vendas_total`. `provisorio` = últimos 2 dias (reatribuição). Validado ao centavo contra o relatório id 3 (28/09–04/10). **Não somar anúncio com campanha** (granularidades diferentes). Shopee: `gmv_direto` ≈ venda da loja (a Shopee atribui quase tudo ao ADS) — ler `tacos`, não só ROAS. `classificar_roas` ganhou `search_path=public` (PG17 roda MV com search_path restrito). **Entregas 3–5 (06/out):** `ml_ads_anuncio_diario` (ADS do ML **por MLB**/dia via `product_ads/ads/search`, ml-sync-ads v6 `modulo=anuncios`, cron **148** `5 9 * * *`, histórico desde 07/jul; soma = campanha) entra em `ads_metrica_anuncio_dia` (ML `nivel='anuncio'` só com ADS — venda real do ML segue por SKU). **Alertas:** config `ads_config_alertas` (linha única; `queda_pct` 30, `dias_consecutivos` 2, janelas 7/28, `min_gasto_dia` 5, `min_impressoes_dia` 200, `roas_ruim_dias` 3, `estavel_pct` 10); `ads_comparativo_em(data)` (formato longo; base de cada dia = dias anteriores, % sempre de absolutos; série densa por UNION+GROUP BY — join com CTE fazia o planner varrer 45 mi de combinações) + view larga `ads_comparativo_anuncio`; `ads_alertas_em(data)` / view `ads_alertas` (D-1): queda_impressoes/ctr/conversao/vendas, gasto_sem_venda, orcamento_esgotando, anuncio_parado, queda_loja (diário **e semana×semana** — a regra diária perdia o caso ML de 05/10). Severidade por posição da venda base na loja. ~1,7 s. **Diagnóstico** `ads_diagnosticar(mkt, anuncio, data)` → jsonb de causas (variação sem estoque, preço subiu, saiu de promoção, campanha/orçamento, ruptura full/empresa/estoque crítico — kits explodidos em `produto_kits`, health/catálogo/visitas ML; `historico_insuficiente` até o snapshot ter 7 dias). Cobertura lida de `ads_cobertura_sku` (MV diária da `view_cobertura_fornecedor`, que custa ~1,8 s por consulta). **Margem** `ads_margem_anuncio` (MV, 30 d D-30..D-1, mesma fonte do PI; `situacao` prejuizo/apertado/saudavel/folgado, `roas_enganoso`). `ads_metricas_atualizar()` refresca as 5 MVs. Faixas de ROAS (`config_roas_faixas`) são calibradas para a Shopee — o ML (~8x) fica "ruim" sempre; por isso `gasto_sem_venda` por ROAS só vale por anúncio |
| **Agente de ADS — relatório** (entregas 6–10, 06/out/2026) | **Tendências:** MV `ads_tendencia_semana` (**5** semanas ISO completas, idx 0..4 — eram 9, cortadas em 06/out; `ads_tendencias` só usa idx 0..4; SKU vendido + anúncio) + view `ads_tendencias` (subindo/caindo = 3 variações semanais ≥10% na mesma direção em receita ou cliques; organico_sem_ads = top 30% da loja sem gasto; ctr_alto_orcamento_limitado; sazonal = semana × mesma semana do mês anterior; 15 por bloco; `semanas` = sparkline). **Alertas gravados** em `ads_alertas_dia` por `ads_alertas_gravar()` (cron `ads-alertas-gravar` `45 10 * * *`, depois do retrato); `ads_alertas_do_dia(data)` lê o gravado ou calcula ao vivo. **Sugestões** `ads_sugestoes_em(data)` / view `ads_sugestoes` (pausar só com ruim nos últimos 7 dias com gasto + prejuízo + gasto 30d ≥ R$50 + CMV confiável; reduzir; aumentar = +20% sobre o gasto do próprio anúncio; repor/renovar/revisar_preco do diagnóstico; revisar_lance; criar_campanha; verificar; sem contradição por anúncio). **Relatório** `ads_relatorio_diario(data)` → jsonb `versao 'v1'` (~1,1 s com alertas gravados; totais batem ao centavo com shopee_ads_diario/ml_ads_diario) + `view_ads_relatorio_cards`. **Card** `src/components/relatorios/RelatorioAds.tsx` (agente `ads` no mapa `src/components/relatorios/agentes.ts`; registro v0 → só a versão completa). **Tela /relatorios (design "Faixa Hoje" do Claude Design, 06/out):** faixa com o último relatório de cada agente (destaque, 3 mini-KPIs, "Pede decisão" tirado do `resumo` — ou de `resumo.decisoes[{tom,o_que,detalhe,sku}]` se o agente mandar pronto) + painel do detalhe abaixo (no celular, dentro do card) + histórico por agente (abas com contagem do período; os de HOJE ficam só na faixa). Tokens `--rl-*` em `.rl-ui` (styles.css, claro/escuro); modal da versão completa em papel branco (`.relatorio-html.rl-papel`). Mesma seção na Visão Geral (`#relatorios`). **Skill** `agentes/agente-ads/SKILL.md` (pacote `agente-ads.skill`): grava em `relatorios_agentes` (on conflict agente+data; sem categoria/título — o gatilho preenche), sem e-mail. ⚠ `config_roas_faixas.acos_alvo` está em **5** (este doc dizia 20) — com 5% quase toda campanha ML vira "reduzir"; confirmar com o dono |
| **Rateio de ADS por SKU** (`view_shopee_ads_sku` → `_sku_total` → `view_margem_pos_ads` / `view_produtos_dashboard`, corrigido 06/out/2026) | **Regra (Renan):** o gasto de um anúncio é rateado pela **venda real de cada SKU vendido naquele anúncio e loja** (SKU vendido = `sku_filho`, ou `sku_pai` sem variação); anúncio com gasto e sem venda → gasto no `sku_pai`. Antes: a receita da variação era buscada por `pedido_itens.sku_pai` (= agrupador), sem `shop_id`, e anúncio sem variação ficava fora → a variação que "emprestava" receita de outro anúncio levava 100% do gasto do pai (SKU 15988: −R$ 1.750 pós-ADS que era +R$ 259) e **só R$ 10,6 mil dos R$ 36,7 mil** de gasto Shopee em 30 d chegavam ao Dashboard/`/produtos-margem`. Agora o rateado soma o gasto real ao centavo. As duas views de produto agrupam venda pelo SKU vendido (o `cmv_unitario` por `sku_pai` também saía errado) |
| `produtos.foto_capa` | Imagem do produto por **SKU interno**, lida do **Tiny** (`anexos[0].url` do PRÓPRIO registro — variação = registro filho com foto própria; o pai não empresta foto). Atenção: 3.255 linhas — nunca puxar tudo (corte de 1.000 do PostgREST); buscar só os SKUs visíveis com `.in()` |
| `view_foto_produto` → `mv_foto_produto_v2` | **Tiny PRIMEIRO, marketplace só se o Tiny não tem** (decisão do dono, 16/set/2026). Coluna `origem` (tiny/shopee/ml). A antiga só reconhecia `anexos.tiny.com.br`; os anexos novos do Tiny estão em `s3.amazonaws.com/tiny-anexos-us/` e 915 SKUs caíam na foto da Shopee/ML tendo foto no Tiny. Refresh 3/3 h (cron `mv-foto-produto-refresh`). O fallback Shopee para variação é a imagem do ANÚNCIO (pai) — imagem por model exigiria guardar `image` do `get_model_list` no catálogo; hoje só 25 variações ativas caem nisso. Foto trocada no Tiny chega pelo cron **`tiny-detalhar-refresh`** (hora :17, 40 produtos ativos/rodada, `tiny-sync-produtos?modulo=detalhar&refresh=1`, v25) — antes o detalhe era lido UMA vez por produto e nunca mais. **Foto trocada no Tiny apaga o anexo antigo do S3 (403)**: em 16/set, 46 dos 1.863 links estavam mortos (ex.: kits 16043/16241, "sem imagem" na tela) — varridos com HEAD e re-detalhados (`detalhar&sku=`). Cron passou a `17,47` (~80 produtos/h, ciclo ≈ 28 h) |
| `compras_ordens` + `compra_ordem_itens` | Espelho das ordens de compra do Tiny + conferência física (qtd_recebida, encaixotamento `emb_tipo`/`emb_unidades`, amarração `pallet_lastro`×`pallet_altura`, `pallets`). `kanban_status` (aguardando/conferencia/divergente/concluida/**excluida**) e `arquivada_em` são do APP — sync não toca. **Excluir = lógico** (`excluida` + arquivada): DELETE seria reinserido pelo `compras-sync` (janela 90 d). Não exclui no Tiny. Tela `/compras` (módulo galpao): arquivar/excluir no cabeçalho da OC, **entrada pelo XML da NF-e** (front lê `det/prod`, casa EAN→código=SKU→descrição, soma em `qtd_recebida`, anota nº da NF), NFs livres só dos últimos 15 dias. **"Nova entrada por NF"** (topo do quadro): mercadoria sem OC no Tiny → o XML vira uma ordem **só do app** com `tiny_id` **negativo** (−epoch s; o sync só toca ids do Tiny), `numero 'NF-<nº>'`, `categoria 'Entrada por NF (app)'`, chave da NF em `observacoes` (anti-duplicata), coluna Conferência; SKU casado por EAN (histórico `compra_ordem_itens.gtin`) → `cProd`=SKU → descrição (itens do mesmo fornecedor); `fornecedor_id` herdado da OC mais parecida pelo nome. Parser comum em `src/lib/nfe.ts`. **Pendente:** a conciliação automática do `compras-sync?modulo=nf` ainda considera OCs `excluida` como candidatas (filtra só `orcamento`) · **Conferência pela NF (01/out/2026, pedido do dono):** aplicar uma NF à OC (XML ou NF do Tiny vinculada — vincular abre o diálogo; NF casada pelo cron fica com botão "Aplicar à conferência") grava as UNIDADES por item em `compra_ordem_nf_qtd` (PK ordem+nº NF sem zeros+item; reaplicar a mesma NF substitui) via RPC `compras_aplicar_nf`; `compra_ordem_itens.qtd_nf` = soma das NFs (0 p/ item da OC que não veio; NULL = sem NF → vale a OC) e é o **esperado da conferência**; item que veio só na NF vira item `so_na_nf` (quantidade 0, `tiny_produto_id` negativo — o sync não toca). Divergência fica em `compras_ordens.divergencia_oc_nf` (+ `_detalhe` jsonb, `_nfs`, `_em`, `_por`, `_primeira_em` que nunca é apagada); selo "OC ≠ NF" no card e quadro vermelho na conferência. `compras_remover_nf` (ao desvincular) e trigger em `quantidade` recalculam. NF do Tiny NÃO traz unidade (caixa/fardo): o front sugere conversão quando o preço da NF é múltiplo inteiro do da OC — operador confere. A entrada por XML deixou de lançar recebido por padrão (checkbox "lançar também como recebido") |
| `produto_embalagem` | Cadastro recorrente de embalagem por SKU — pré-preenche a conferência da próxima compra |
| `notas_cancelados` | Pedidos **cancelados** do mês (todos os marketplaces), com ou sem NF. Populada pela edge function `nf-devolucao` (varredura por cron). Lista de trabalho da aba **Devoluções** = `finalidade_nf='1' AND id_nota_fiscal IS NOT NULL` (**situação 3 = NF cancelada, não precisa devolução**; 6/7 = viva). Campos: `precisa_devolucao` (marcação), `devolucao_emitida`+`id_nota_devolucao` (preenchidos pelo módulo `emitir`). GRANT select/update p/ anon+authenticated |
| `view_margem_pedido_v2.modo_envio` | **10/set:** coluna nova (baseline md5 idêntico). Shopee = `opcao_envio` cru (Entrega Rápida, Shopee Xpress, Full, Retirada pelo Comprador, Turbo); ML = rótulo de `logistica_tipo` (fulfillment→**Full**, self_service→**Flex**, xd_drop_off/drop_off→**Agência**, cross_docking→**Coleta**); Amazon = Standard/Expedited (velocidade, não modo). Filtro "Envio" e coluna em Pedidos Integrados |
| `reprocessar_cmv_periodo(sku, de, ate, custo?, por?, obs?)` | **10/set:** reprocesso de CMV por período honrando `cmv_manual` (vigência). Se `custo` vier, grava em `cmv_manual` desde `de`; recongela `pedido_item_cmv` do SKU (e kits que o contêm) entre as datas com `cmv_na_data(sku, data_pedido)` = manual vigente > cadastro (kit-aware). **Por que existe:** o congelado vence o manual e o cron `cmv-congelar-novos` (15 min) congela tudo — então `cmv_manual` sozinho NUNCA mudava pedido já lançado (a tabela estava vazia, ninguém usava). `fn_cmv_congelar_novos` também passou a usar `cmv_na_data`. DRE/PI mudam na hora (leem a view); `view_kpi_pedidos_dia` (matview) em ≤20 min. A antiga `reprocessar_cmv` (tela `/reprocessar-cmv`) segue ignorando o manual. **07/out/2026 — timeout corrigido:** a versão anterior varria TODOS os pedidos convertendo o fuso de cada um (sem índice) e calculava `cmv_na_data` por pedido: 5+ s com o banco carregado, estourando os 8 s do `authenticated` ("Falha ao reprocessar o CMV — Timeout" no PI). Agora: SKUs-alvo uma vez (SKU + kits que o contêm), itens desses SKUs, pedido pela PK com filtro em `timestamptz` (fuso só nos que casam) e custo por SKU×dia — 5,3 s → 0,3 s em 3 meses do 15984, md5 idêntico (2.175 pares) |
| `view_entrega_rapida_pendentes` | Pedidos Shopee "Entrega Rápida" ainda não coletados (1 linha/pedido: loja, status Shopee, situação Tiny, `dias_ate_prazo`, TAG, etiqueta impressa/no cache). Fonte do aviso das 12h10 |
| `view_monitoramento_lotes` | Cards do `/monitoramento` (hoje, Shopee, single-SKU). **10/set:** ganhou `prazo` (min `ship_by_date` da TAG) e `pedidos_com_prazo`. O peso do produto NÃO existe no cadastro — o front extrai do nome (`src/lib/prazo.ts` → `extrairPeso`, última ocorrência de número+kg/g/ml/l) |
| `get_kpis_fluxo_caixa()`, `get_projecao_fluxo_caixa(dias)`, `get_pedidos_resumo(inicio, fim)`, `get_dashboard_kpis()` | Agregações financeiras prontas |
| `classificar_roas(numeric)` | excelente / bom / ok / ruim / sem_dado. **Fonte única da regra** |
| `config_roas_faixas` | Limites editáveis (id=1): roas_excelente 18, roas_bom 15, roas_ok 12, **acos_alvo 5** (o doc dizia 20; o banco tem 5 desde 21/jul). Vale para a classificação de ANÚNCIO; a **meta de ACOS do mês** do Dashboard é outra coisa e sai da tabela `metas` (tipo 'acos', por competência: jul 5%, ago/set 6%) |

### NÃO existem — remover do código se aparecerem

- `rpc('kpi_pedidos')` — gerava dezenas de 404 em laço de retentativa
- `view_pedidos_integrados` — usar `view_margem_pedido_v2`
- coluna `loja_nome` — a correta é **`canal`** ("Shopee (ACZ Pet)", "Shopee (SVL
  Store)", "Mercado Livre (ACZ Pet)")

---

## 4. Armadilhas de dados (todas custaram bug em produção)

### Fuso horário
O Postgres roda em **UTC**; `data_pedido` é `timestamptz`. Agregar com
`data_pedido::date` ou comparar com `CURRENT_DATE` agrupa pelo dia UTC — pedidos
entre 21h e meia-noite caem no dia seguinte (um dia mostrou 242 pedidos quando o
real era 306).

Sempre: `(data_pedido AT TIME ZONE 'America/Sao_Paulo')::date` e
`(now() AT TIME ZONE 'America/Sao_Paulo')::date`.

**Exceção:** na tabela `pedidos_tiny` a data é crua (meia-noite UTC) — **não**
converter ali, senão o dia desloca.

### Percentuais não se somam
`margem_pct`, `mc_pct`, `delta_pp`, `cobertura_cmv_pct`, `acos` são calculados
por linha. Ao agrupar, some os **absolutos** e recalcule o percentual. Média de
percentual entre empresas ou canais dá número errado.

### SKU pai vs filho
`sku_pai` é só agrupador de anúncio e **não tem custo real**. O custo está no
`sku_filho` (a variação vendida). Na Amazon o `sku_filho` vem cru (ex.:
`FBA-15825`) e pode não existir no cadastro — por isso a resolução usa
LEFT JOIN LATERAL na ordem `sku_mapeamento` → `sku_filho` → `sku_pai`, pegando o
primeiro que **existe**. `COALESCE` simples não serve.

**Vínculo novo em `sku_mapeamento` (Amazon) não corrige o passado (05/out/2026):**
o `amazon-sync-pedidos` aplica o de-para ao gravar `pedido_itens.sku_pai` e o
`fulfillment-sync` ao gravar `estoque_fulfillment.sku`, mas só nas próximas
gravações. A reposição (`view_reposicao_full`) usa `pedido_itens.sku_pai` CRU
na velocidade — anúncio com código da Amazon (ex.: `DF-CLWD-07BZ`) ficava sem
produto, sem estoque da empresa e com sugestão sempre 0. Ao criar vínculo,
atualizar também `estoque_fulfillment.sku` (por `sku_marketplace`) e
`pedido_itens.sku_pai` dos pedidos Amazon com `sku_pai = sku_origem`. Feito em
05/out para 14 vínculos novos (pelo nome + marca/preço no catálogo da Amazon) e
os 3 antigos (108 itens de pedido). `GR-N80P-XE7D` (Kit 2 areia mandioca 2kg,
"Genérico") = **Mya Cat 16011** (confirmado pelo dono). Sem vínculo, por decisão
do dono: kits Wisecat+Bumi 6kg (`P5-…`/`VV-…`) e os anúncios TRUQYS — podem
aparecer como "sem cadastro" na reposição, ignorar.

### Custo de kit
Fonte da verdade: `produtos.tipo = 'K'` → somar `produto_kits` × `produtos.custo`.
A tabela `kits_composicao` é concorrente e **incompleta** — não usar. O campo
`produtos.custo` para kits é lixo vindo do Tiny.

### Amazon: ItemTax separado (margem esmagada em ~29%)
A SP-API do **Brasil desagrega o imposto embutido no preço**: `ItemPrice`/
`Principal` vêm SEM imposto e o `ItemTax`/charge `"Tax"` vêm separados (ex.:
preço 16,90 = 12,30 + 4,60; ~29,25% = ICMS 20 + PIS/COFINS 9,25, varia por UF).
A Amazon **repassa** o Tax ao vendedor (`ItemTaxWithheld = null`) e a comissão
real incide sobre o preço CHEIO (12% de 16,90). Receita/margem devem usar o
cheio: `amazon-sync-pedidos` v14 soma ItemPrice+ItemTax−Promo; `amazon-sync-
financas` v13 soma TODOS os charges. Antes disso, TODA margem Amazon parecia
negativa ("comissão em dobro" era na verdade imposto subtraído da receita).

### Pedido válido
Use a view `pedidos_validos`. É lista **branca** de status por canal, nunca
filtro por exclusão — cada marketplace usa nomenclatura própria, e filtrar por
exclusão já deixou entrar R$ 21,3 mil de receita fantasma num mês.

---

## 5. Semântica do Tiny (separação)

Situações: **1** = aguardando · **2** = em separação · **3** = embalada ·
**9** = concluída/fora da fila.

Dois comportamentos que já geraram bug:

1. **A situação regride.** Um pedido vai de 1 → 2 e pode **voltar** para 1. O
   sync precisa refletir os dois sentidos — a versão antiga só avançava, e
   separações ficavam presas em 9, invisíveis para sempre.

2. **`view_separacao_pedidos` só mostra situação 1.** Quem lê essa view para
   qualquer coisa além da fila de separar vai perder pedidos. A função de
   impressão de etiquetas tinha esse bug: depois que a equipe pegava o lote, era
   impossível imprimir ("nenhum pedido neste lote"). Para operações sobre um
   lote, leia `separacao_tiny` (todas as situações) e filtre por status do
   **pedido**, não por situação da separação.

---

## 5.0 Cron de TAG + aprovação (tiny-separacao processar-abertos) — 14/set/2026

"Travou" duas vezes pelo mesmo motivo: o cron rodava em `*/5` (minutos cheios,
onde dezenas de crons disparam juntos num NANO) e metade das rodadas morria em
**"Token Tiny não encontrado"** — o token existe, a LEITURA falhou (504). Na
fase ao vivo, a leitura do espelho com erro era tratada como vazio e o módulo
reinseria itens já existentes (`duplicate key` em `pedido_itens_tiny_uniq`),
queimando o orçamento. **v40:** token com 3 tentativas; leitura do espelho com
erro pula a fase ao vivo; duplicate key = item já espelhado. Crons movidos para
fora dos minutos cheios: 30 → `3-59/5`, 27 → `1-59/10`, 31 → `9-59/15`,
13 (shopee-sync) → `2-59/10`. Deploy via MCP religou `verify_jwt`: crons 27/30/31
levam Bearer (front já levava). Regra: **pedido Shopee ainda fora do espelho
`pedidos` fica com `tag_sugerida` "Shopee Envios" e é pulado de propósito**
(`pulados_sem_match_shopee`) até o `shopee-sync` trazê-lo — se o shopee-sync
também falha nos minutos cheios, os dois efeitos se somam e o pedido "trava".

## 5.0.1 Multi SKU — aba própria em /separacao (16/set/2026)

Pedido com 2+ SKUs não tem TAG por bloco (o `tag-lote` só resolve linha de SKU
único; a priorizada mostra "MULTI: a+b" e a impressão em massa pula). A aba
**Multi SKU** (`src/components/separacao/MultiSkuPanel.tsx`) trata isso com
dois modos, lendo `view_separacao_multi_pedidos` (1 linha por pedido multi na
fila: `chave_combo` = sku×qtd ordenado, `itens` jsonb com sku/nome/qtd/
localização/foto, loja, prazo, TAG, estado de impressão):
- **Por pedido:** agrupa pedidos IGUAIS (mesma `chave_combo`); expandir mostra
  os produtos (foto, localização) e os pedidos. "Imprimir etiquetas" do grupo
  = TAG (se faltar) + etiquetas; "Embalar" só quem tem impressão confirmada
  (`embalar-um`). Seleção de grupos → uma TAG por grupo.
- **Picking list:** `view_separacao_multi_picking` (necessário × separado por
  SKU, só pedidos SEM TAG) + tabela `separacao_multi_picking(sku, qtd_separada)`
  persistida. Alocação GREEDY no front por prioridade (ER > SPX > ML, prazo,
  idade): pedido só é liberado se TODOS os itens cabem no que resta; quem não
  cabe não consome. "Liberar e imprimir" abate o separado ANTES de imprimir,
  aplica TAG (`grupo` "MULTI · picking") e imprime.
- **TAG:** edge fn **`separacao-multi`** (`POST ?modulo=tag`, body
  `{separacao_ids, grupo}`): mesma sequência `ddmm-NN` de `tags_lote`, mesmo
  dedup (pedido com TAG hoje é pulado), `tags_lote.sku='MULTI'`. Criada à
  parte para não redeployar a `tiny-separacao` (outra sessão mexe nela).
- **Impressão:** Shopee por TAG e loja (dedup do servidor), ML pedido a pedido
  (regra de ouro: já impresso não sai), identificadora por TAG no fim; barra
  de progresso com espera da impressora igual à da fila.

## 5.0.2 Falta de estoque → balanço 0 no Tiny → conferência na Shopee (17/set/2026)

Pedido do dono: ao reportar falta, **zerar o estoque no Tiny** (senão o Tiny
segue anunciando o que não está na prateleira) e **conferir se o anúncio da
Shopee zerou**; kit **pergunta manualmente** qual componente zerar; confirmação
em ambos os casos; aviso no Discord `#estoque-pedido-sem-estoque`.
- **Front:** `src/components/separacao/FaltaEstoqueDialog.tsx` substitui os
  três `window.confirm` (pedido, lote, linha) da Separação. Abre com
  `separacao-falta?…&preview=1` (SKU, se é kit, saldo do Geral **ao vivo** de
  cada candidato); checkbox "Zerar o estoque no Tiny" (ligada por padrão,
  `localStorage separacao.falta.zerarTiny`); kit = lista de componentes com
  rádio (obrigatório); confirmação mostra "Geral: 15 (9 reservados) → 0".
  Menu "Estoque voltou (desfazer balanço no Tiny)" no pedido e na linha.
  Selo na linha da fila (`ConferenciaBadge`): "conferindo Shopee" → "Shopee
  zerada" (verde) / "Shopee ainda com N" (vermelho), via
  `falta_estoque_conferencia` (3 dias).
- **Tiny:** `POST /estoque/{idProduto}` `{deposito:{id:604130012}, tipo:"B",
  data:"YYYY-MM-DD HH:mm:ss" (BRT), quantidade:0, precoUnitario:custo||0,
  observacoes}` no depósito **Geral** (id 604130012 na conta ottz; achado por
  id ou nome). Os depósitos Full (ML/Shopee/Amazon) são estoque nos CDs e
  NUNCA são tocados. O Tiny envia o **`disponivel`** (saldo − reservado) aos
  marketplaces (medido: 14752 Geral 634/62 reservados → Shopee 572 nas duas
  lojas); com saldo 0 o disponível fica negativo e a Shopee recebe 0. Kit não
  tem estoque próprio: zera-se o **componente** escolhido (validado em
  `produto_kits`). Saldo já 0 = não lança, só confere a Shopee.
- **Registro:** `falta_estoque_conferencia` (sku zerado, `sku_reportado`,
  `saldo_anterior`, `conferir_em`, `tentativas`, `shopee_zerada`, `resultado`
  por loja/anúncio/variação, `desfeito_em`) + `separacao_log` eventos
  `estoque_zerado` / `estoque_restaurado`. Desfazer = balanço com o
  `saldo_anterior` guardado.
- **Conferência:** `estoque-conferir` (cron `4-59/5`, Bearer) processa as
  linhas vencidas: 1ª tentativa 10 min após zerar; se ainda > 0, reagenda +15
  min (até 3) — a propagação Tiny → Shopee leva minutos e alarme falso seria
  ruído. "Zerada" = todo anúncio/variação com status NORMAL do SKU tem
  `seller_stock` 0. Posta **ok** ("Shopee zerada") ou **aviso** ("Shopee AINDA
  mostra N") no canal `estoque` — aqui silêncio não é bom, o dono pediu o
  retorno. Anúncio despublicado não conta.
- **Discord:** o canal `estoque` já é `#estoque-pedido-sem-estoque`, mas o
  secret **`DISCORD_WEBHOOK_ESTOQUE` NÃO está cadastrado** (17/set) — tudo cai
  no GERAL até o dono criar o secret (idem `_ERROS`, `_ATUALIZACOES`,
  `_DEVOLUCOES`, `_COMPRAS`). `discord-notify?modulo=status` lista.

## 5.0.3 Peso do pedido e crédito do separador/embalador (19/set/2026)

Duas decisões do dono no mesmo dia, nesta ordem:
1. Dividir o trabalho por peso — **acima de 4 kg** é dos pesados (Nikolas e
   Kevin), até 4 kg dos leves (Tânia e Vinicius), com filtro de peso na tela.
2. **Sem atribuição prévia de pessoa.** A tela só classifica por peso; o
   **separador/embalador é quem FINALIZA a TAG** no `/monitoramento`
   (`tags_lote.finalizada_por`). O rodízio automático por pessoa foi removido
   no mesmo dia, antes de entrar em produção.

- **O peso é do CADASTRO, não do nome.** O Tiny tem `dimensoes.pesoBruto` em kg
  (`GET /produtos/{id}`; medido: SKU 14752 = 12, 11116 = 0,09, e a "Areia 4kg"
  do SKU 15984 pesa **4,01** bruto). Até aqui o app só tinha `extrairPeso` em
  `src/lib/prazo.ts`, um regex sobre o nome usado no `/monitoramento` — regex
  não serve para dividir trabalho: um erro manda 12 kg para quem separa leve.
  Colunas novas: `produtos.peso_bruto`, `peso_liquido`, `peso_atualizado_em`.
- **Quem preenche:** edge fn **`produtos-peso`** (`preencher` prioriza os SKUs
  da fila de separação, depois os ativos; `refresh`; `sku`), cron
  `produtos-peso-preencher` **`9,39`** (fora do minuto cheio e longe do
  `tiny-detalhar-refresh` 17,47), ~20 produtos por rodada a 1 req/s. Função
  SEPARADA da `tiny-sync-produtos` v25 de propósito (§2.1.5/§10). SKU que o
  Tiny devolve **404** (apagado lá, ainda ativo no espelho: `10901_FBA`,
  `10941HJ`…) ficava eternamente na fila e queimava o orçamento da rodada —
  a v2 grava a tentativa em `peso_atualizado_em` e só repesca depois de 7 dias.
- **Filtro por banda (22/set):** `separacao_regra_peso.limite2_kg` (8) e coluna
  `banda` na view (`ate_limite` · `entre` · `acima` · `sem_peso`); chips
  multi-seleção "Até 4 kg / 4 a 8 kg / Acima de 8 kg / Sem peso". A `faixa`
  (time) continua só com o limite de 4 kg.
- **Regra, no banco:** `separacao_regra_peso.limite_kg` (4). "Acima de 4 kg" é
  **estritamente maior** — pedido de exatamente 4,00 kg é leve (por isso a
  areia de 4,01 kg cai nos pesados). `separacao_separadores` ficou apenas como
  REGISTRO dos times; não alimenta atribuição nenhuma.
- **Views:** `view_separacao_itens` (um item por linha, do `itens_json`),
  `view_separacao_peso_pedido` (peso por pedido da fila) e
  **`view_separacao_peso_linha`** (chave = `tag_sugerida` da priorizada,
  `peso_kg`, `peso_kg_min`, `faixa`, `limite_kg`).
- **Peso incompleto = sem faixa.** Se qualquer item do pedido está sem peso no
  cadastro, a linha fica `sem_peso` com selo cinza — é cadastro a corrigir no
  Tiny, e chutar o peso seria pior do que não classificar.
- **Front:** `separacao.tsx` ganhou `usePesoPorLinha` (mesmo padrão de Map por
  linha de `tagsPorLinha`/`riscoPorLinha` — a `view_separacao_priorizada`,
  crítica, **não** foi alterada), o grupo de filtro "Acima de 4 kg / Até 4 kg /
  Sem peso" com contagem e o selo de peso na linha.
- Medido na fila de 19/set: 45 linhas / 99 pedidos acima de 4 kg (até 36 kg) e
  51 linhas / 89 pedidos até 4 kg — volume parelho entre os dois lados.

**Crédito do separador/embalador (quem finaliza a TAG):**
- `tags_lote.finalizada_por` (novo) + RPC
  **`monitoramento_finalizar_tag(p_tag, p_desfazer, p_por)`** — o 3º argumento
  entrou com default para não quebrar chamada antiga; **desfazer limpa a data e
  o nome juntos**. O `/monitoramento` passa `perfil?.nome`.
- O nome já existia em `separacao_log` (`evento='tag_finalizada'`, com
  `usuario`) mas não ficava na TAG, então nenhuma tela mostrava "quem fez".
  Backfill do histórico a partir do log: **1.088 de 1.273** TAGs finalizadas
  ganharam nome (Nikolas 455, Vinicius 393, "Separacao 1" 191, "separacao2" 30,
  Renan 19).
- **Login compartilhado estraga o crédito:** 221 TAGs estão em "Separacao 1"/
  "separacao2" (contas de bancada). Para o crédito valer, cada pessoa precisa
  entrar com o próprio usuário.
- Onde aparece: painel **Lotes do dia** da Separação — selo roxo com o nome na
  linha do lote e um resumo "Finalizadas hoje: Fulano N" no cabeçalho.

## 5.1 Etiquetas Shopee — status, cache e confirmação de envio

**Semântica dos status Shopee (validada com dados 22/jul/2026 — é o INVERSO do
que parece):**
- **READY_TO_SHIP** = pago, **aguardando o vendedor confirmar o envio**. Não tem
  rastreio nem etiqueta ainda. (Medido: 17 pedidos nesse status, 0 com rastreio,
  0 com etiqueta.)
- **`ship_order`** (confirmar envio) → Shopee atribui o **rastreio** → pedido vai
  para **PROCESSED** → a **etiqueta fica imprimível**.
- Ou seja: o gatilho real de "dá pra imprimir etiqueta" **não é o status** no
  nosso espelho (`pedidos.status_pedido`, que atrasa e engana), é ter **rastreio
  válido**. O sinal confiável no banco é `pedidos_tiny.codigo_rastreamento`
  preenchido (o Tiny recebe o rastreio quando o envio é confirmado).

**Quem confirma hoje:** o **Tiny** confirma o envio quando você **fatura a NF**
(situação vira `pronto_envio` e surge o rastreio). Há um lag (~1h no teste).

**Fluxo:** Tiny fatura NF → Shopee READY_TO_SHIP → (Tiny confirma envio) →
PROCESSED + rastreio → `pregerar` salva a etiqueta.

**Estado de impressão (`impressao_etiquetas`) — v56 (28/ago):** job vai ao
PrintNode como `sent`; o cron `confirmar-impressao` (10 min) consulta o
PrintNode e move para `done`/`error`. **Regra de ouro do dono: etiqueta já
impressa NUNCA pode sair de novo** — o dedup do `imprimir` por TAG bloqueia
`done`/`forcado`/`sent`/`preso` SEMPRE (zero reimpressão automática). Job
PRESO (`sent` 25+ min sem confirmação, ex.: impressora offline) é tratado pelo
cron em camadas: (1) tenta **cancelar o job no PrintNode** (`DELETE
/printjobs/{id}` — **funciona**, validado 28/ago cancelando 4 presos reais);
cancelou → `error` e o lote volta a incluir o pedido com segurança; (2) não
cancelou → `preso` + **remove a TAG do pedido só no app** (marcador do Tiny
fica) → o pedido sai do fluxo em massa e volta à fila para decisão humana, com
aviso no Discord (canal pedidos). A impressão individual nunca teve dedup — é
a via consciente do operador, que vê na bancada se o papel saiu.

**Contador de impressão na Separação (14/set):** o `imprimir` devolve assim
que ENTREGA ao PrintNode, então a barra tem duas fases: "Enviando TAG · loja"
(uma TAG pode ser 2 chamadas — Ottz e Bumi — a Shopee imprime por loja) e
"Impressora imprimindo · faltam N na fila", que consulta
`confirmar-impressao` (sem tag) a cada 4 s até `jobs_ainda_sent = 0` ou 2
min (`aguardarImpressora` em `separacao.tsx`; botão Fechar encerra a espera).
Na massa a espera é só no fim de tudo. Etiqueta pulada pela dedup não conta
como enviada.
**Identificadora no meio da pilha (14/set):** a mesma TAG tem pedidos da
Ottz E da Bumi (hoje 20 das 35 TAGs); a Shopee imprime por loja, e o
`imprimirPorSku` disparava a identificadora logo após a parte da Ottz — ela
saía ANTES das etiquetas da Bumi. Agora agrupa por TAG (`porTag`: partes
Shopee por loja + ML) e a identificadora sai UMA vez, depois da última parte.
O painel Lotes do dia (`imprimirLote`) tinha bug pior: `lojaDoLote` escolhia
UMA loja e a outra metade da TAG nem era impressa — agora imprime todas as
lojas presentes em `separacao_tiny` da TAG.

**Pico de campanha derruba a geração de etiquetas (9.9, 10/set/2026 — v57/v58):**
com ~500 pedidos do pico na fila, o `pregerar` tentava 40 e gerava **zero** em
27s, e a fila nunca andava. Três causas empilhadas: (1) a busca de tracking do
two-pass era 1 a 1 com `sleep(120)` e teto de 60% do orçamento — no pico a
maioria nem chegava ao segundo `create` (**v57: lotes de 8 em paralelo**; o
download idem, lotes de 5); (2) a Shopee, sobrecarregada, respondia o download
do documento READY com **200 + `application/force-download` e CORPO VAZIO (0
bytes)** na 1ª tentativa e o arquivo real na 2ª — provado ao vivo (0 → 9.415
bytes no mesmo pedido); baixávamos 1× e desistíamos (**v58: até 3 tentativas,
400ms**); (3) o documento recém-criado demora minutos para ficar READY — o
download acontece na REVISITA do pedido, então em pico vale rodar o `pregerar`
com `&backoff_min=5` para revisitar mais cedo (o cron usa o default 20). Para
zerar o backoff e retrabalhar já: `delete from etiqueta_pregerar_estado`.

**Salvaguardas de saúde (10/set/2026):** `view_etiquetas_saude` (por loja: a
despachar hoje via `ship_by_date`, com etiqueta no cache, aguardando geração,
em erro = já falhou 1x no `etiqueta_pregerar_estado`, ritmo `geradas_30min`).
Consumida por: faixa "Etiquetas do dia" no topo da Separação (refetch 60s;
fica vermelha se fila ≥25 e ritmo 0), quadro no Discord canal pedidos 2×/dia
(cron `etiquetas-saude-quadro`, 8h/13h BRT) e **watchdog** `etiquetas-saude?
modulo=verificar` (cron 20 min): alerta no canal erros se a geração PAROU
(fila ≥25 e zero geradas em 30 min — o modo de falha do 9.9) ou fila REPRESADA
(≥100 sem etiqueta, mais antigo >6h), com cooldown de 2h
(`etiquetas_saude_alerta`). Silêncio é bom: saudável não posta.

**Cancelamento automático da Shopee (11/set/2026):** pedido arranjado
(PROCESSED/READY_TO_SHIP) que a transportadora não bipa é cancelado ~**3 dias
depois do `ship_by_date`** (observado no Seller Center: "Cancelamento em 1
dia" para ship_by 08/09 → cancela 11/09; a API não expõe a data, é
estimativa). `view_pedidos_risco_cancelamento` (por pedido: `cancela_em`,
`situacao_fisica` = embalado aguardando coleta / na fila / fora da separação,
rastreio, TAG, valor) e `view_risco_cancelamento_resumo`. Consumidas pela faixa
da Separação e pelo watchdog `etiquetas-saude` v3 (canal pedidos, cooldown 6h;
nível erro quando cancela HOJE). **Armadilha de fuso:** `ship_by_date` é
23:59:59 BRT — comparar com `(x at time zone 'America/Sao_Paulo')::date`;
`ship_by_date <= data` em UTC deixa o último dia de fora. Achado em 11/set:
121 pedidos (R$ 14 mil) cancelando no dia, 108 deles já embalados esperando
coleta — o gargalo era a coleta SPX, não a separação.
**Tela `/risco-cancelamento` (11/set, módulo galpao):** lista TODOS os pedidos
em risco, inclusive os que já saíram da fila (embalados/concluídos aguardando
coleta) — a fila só mostra situação 1. Filtros empresa / hoje-amanhã /
situação física / busca; reimpressão por pedido e em massa (SEMPRE forçada,
`imprimir&order_sn=` não tem dedup) com aviso de etiqueta em dobro; pedido
`READY_TO_SHIP` ("sem envio arranjado") não tem etiqueta e fica sem botão.
Usa a mesma impressora da Separação (`localStorage separacao.printerId`). Mostra foto+nome do 1º SKU (`produtos`, só os visíveis, toggle) e imprime a
**identificadora** da TAG depois das etiquetas (toggle compartilhado
`separacao.identificadorLote`). **A identificadora mora em
`src/lib/identificador.ts`** (`gerarZplIdentificador`, `acharLoteDaTag`,
`imprimirIdentificadorApi`, `TagLoteRow`, `diasAtePrazo`) — fonte única para
Separação e Risco; não duplicar o ZPL em tela nenhuma. Barra da tela: Pausar/Retomar e Encerrar na massa; "Marcar embalado"
(reimpressos ou selecionados; só os ainda na fila, via `embalar-um`);
"Tirar da lista" grava em `risco_cancelamento_tratados` (só some da TELA —
o risco real, a faixa e o watchdog seguem contando até a coleta bipar);
"Mostrar impressos/tirados" revê e "Voltar à lista" desfaz. **Sair da aba ao
imprimir (12/set, ligado por padrão, `localStorage risco.sairAoImprimir`):**
impressão com sucesso (por pedido ou em massa, inclusive ao Encerrar no meio)
grava `motivo='impresso'` na mesma tabela e o pedido some das duas abas na
hora — antes ele ficava até alguém clicar "Tirar da lista os reimpressos", e
o botão morria com a sessão (lista só em memória). Selo verde "impresso"
quando revisto.
**Tela `/a-enviar` (12/set):** MESMA tela (`src/components/separacao/
PedidosShopeeLista.tsx`, prop `modo="risco" | "a-enviar"`; as duas rotas são
finas) lendo `view_pedidos_a_enviar` = TUDO que consta "A enviar" no Seller
Center (READY_TO_SHIP/PROCESSED, sem Full, `ship_by` nos últimos 15 dias),
atrasado ou não, com `dias_para_prazo`/`atrasado`/`opcao_envio` a mais.
Chips de prazo: Todos · Vence hoje · Atrasados · Prestes a cancelar (≤ amanhã)
· Cancela hoje; cards A enviar / Atrasados somam-se aos de cancelamento.
"Tirar da lista" usa a MESMA `risco_cancelamento_tratados` — some das duas
telas. Não duplicar a tela: mudança de layout/ação vai no componente.
**Coluna "Impressa" (12/set):** as duas views trazem `impressa_em`/
`impressa_estado`/`impressa_tag`/`impressa_forcado_por`/`impressoes` (LATERAL
na `impressao_etiquetas`, última done/forcado/sent) — o front mostra data/hora
+ como (lote TAG / avulsa / forçada por X / N×). "sem registro" = nunca passou
pelo PrintNode via app: em 12/set, 471 dos 496 embalados a enviar estavam
assim (etiqueta no cache, sem TAG, sem `separacao_log`) — saíram pelo Seller
Center/Tiny durante o colapso do 9.9. Não é bug da coluna.
**Filtro na fila (11/set):** chip **RISCO DE CANCELAMENTO** na Separação
(ao lado de SEM ESTOQUE) + selo "cancela hoje/amanhã (n)" na linha, via
`view_risco_cancelamento_linhas` (pedidos AINDA NA FILA, hoje+amanhã, por
linha). A chave casa com a `tag_sugerida` da priorizada: multi-SKU é
`'MULTI: ' + SKUs do itens_json ordenados com '+'` — no pedido a tag é o
genérico `MULTI SKU` e não casaria. Embalados que só esperam coleta não
aparecem na fila (estão na faixa). Validado: 48/48 pedidos de print do Seller
Center (Ottz) presentes na view. **`rastreio` da view vem do espelho do Tiny e
pode faltar** mesmo com envio agendado — "sem envio agendado" de verdade é
`status_pedido = 'READY_TO_SHIP'` (ex.: 2609057QVR7FG5, concluído no Tiny e
nunca arranjado na Shopee).

**Cache de etiquetas (`etiquetas_cache`, coluna `zpl_conteudo`):**
- Preenchido pelo módulo `pregerar` do `shopee-sync-ads` (cron a cada 3 min, por
  loja: `pregerar-etiquetas-ottz` min 0,3,6…; `-svl` min 1,4,7…) OU on-demand
  pelo `imprimir` (que gera na hora se não achar no cache — lento).
- O `pregerar` só grava depois que a Shopee cria + libera o documento (READY) e o
  download do ZPL dá certo. Isso **não é previsível pelo status nem pelo
  rastreio**: mesmo pedido arranjado (PROCESSED, com pacote) volta
  `tracking_number_invalid`/`package_can_not_print` até a transportadora validar.
  A única verdade é tentar o `create_shipping_document`.
- **Evolução v41→v42 (jul/2026):** a v41 filtrou por
  `pedidos_tiny.codigo_rastreamento IS NOT NULL` e **superfiltrou** — pedidos
  arranjados cujo rastreio não chegou no nosso mirror (ex.: quando a situação no
  Tiny **regride** Faturado→Aprovado e o rastreio se perde) eram excluídos para
  sempre e nunca cacheavam. **v42 (24/jul):** candidatos = **PROCESSED** +
  READY_TO_SHIP (sem exigir rastreio), prioriza PROCESSED, e usa **backoff** via
  tabela `etiqueta_pregerar_estado` (tenta cada pedido no máx. 1×/20 min; apaga o
  registro ao cachear). Assim continua tentando os arranjados até a etiqueta
  ficar pronta, sem entupir o orçamento a cada 3 min.
- **v43 (24/jul) — CAUSA RAIZ do cache vazio:** a Shopee **exige o
  `tracking_number` no corpo do `create_shipping_document`** para pedidos que já
  têm rastreio (canais BR). Sem ele, o `create` volta `tracking_number_invalid`
  e a etiqueta **nunca gera** — mesmo o pedido estando pronto no painel. Validado
  ao vivo: `create` sem tracking = falha; `create` COM tracking (via
  `get_tracking_number`) = sucesso. `gerarEtiquetasShopee` agora é **two-pass**:
  `create` sem tracking → para os que falham por `tracking_number_invalid`, busca
  `get_tracking_number` e refaz o `create` COM tracking. Depois do fix, os erros
  passam de `tracking_number_invalid` para `sem_codigo`/`should_print_first` (o
  documento foi criado, só falta ficar READY para o download — o `imprimir`, com
  40s, baixa na hora; o `pregerar` baixa na rodada seguinte).
  **Ferramenta de depuração:** `shopee-ship?modulo=doc-param|doc-create&loja=X&
  order_sn=Y` mostra tipos de doc, rastreio e testa o create com/sem tracking.
- Depurar por SKU/loja: `imprimir?loja=svl&order_sn=X&dry=1` gera 1 pedido, salva
  no cache e **não imprime** (o `dry` só pula o PrintNode; o save é antes).
- **v63 (14/set/2026) — pregerar não confia em leitura que falhou.** Nos minutos
  :00/:10/:20/… dezenas de crons disparam juntos e o PostgREST devolve 504. O
  pregerar ignorava `error` (`const { data } = …`): candidatos viravam "nenhum
  elegível" e, pior, a checagem de cache vinha vazia → TODOS os pedidos viravam
  "sem cache", as 40 tentativas iam à Shopee com pedidos JÁ PRONTOS (`sem_codigo`)
  e eles entravam em backoff (1.013 registros falsos em 13/set; o watchdog
  `etiquetas-saude` gritou "geração PAROU"). Agora: leitura com 3 tentativas; se
  ainda falhar, a rodada **aborta com 503 sem gravar**; backoff de pedido que já
  está no cache é apagado na hora. Os crons 55/56 saíram dos minutos múltiplos
  de 5 (listas explícitas). **`shopee-sync-ads` agora exige JWT** (deploy via
  MCP): crons 38–45/55/56 e a função `confirmar_impressoes_pendentes` levam
  Bearer (chave publicável); o front já levava. Chamada sem header = 401.
- **v64 (21/set/2026) — baixa o documento que já ficou pronto.** O `create` +
  espera (~24s de orçamento) não cabia: o documento ficava READY **depois** da
  rodada, e a seguinte (20 min depois, pelo backoff) recriava tudo e estourava de
  novo → `sem_codigo` em loop (145 sem etiqueta, 0 geradas na noite de 20/set),
  enquanto o `imprimir` (40s, 1 pedido) gerava normal. Agora
  `gerarEtiquetasShopee` chama `get_shipping_document_result` **antes**; os READY
  vão direto ao download e só o resto passa pelo `create`. Vale para o
  `pregerar` e o `imprimir`.
- **v65 (21/set/2026) — CAUSA RAIZ: 1 pedido com erro envenena o lote.** A v64
  sozinha não resolveu. Teste ao vivo: 20 pedidos juntos (3 com
  `package_can_not_print`) = **0** etiquetas; os mesmos 17 sem os 3 = **17**.
  Agora quem falha (no `create` ou na consulta) sai da lista de
  `get_shipping_document_result`, e o `create` é refeito **uma vez** só com os
  limpos. Validado: lote misto de 20 = 19 geradas. **Regra:** chamada em lote na
  Shopee logistics nunca pode carregar pedido já sabidamente com erro.

**Por que o "app confirma o envio" NÃO avança (testado 23/jul):** o `ship_order`
pelo app falha com **`logistics.lack_of_invoice_data`** — a Shopee exige a NF-e
**enviada a ela** (upload da nota) antes de arranjar o envio. Esse upload é o real
gargalo/lag (Tiny: emite NF → sobe nota na Shopee → confirma envio). O app não
pula isso: a Shopee bloqueia sem a nota, e **não temos a chave da NF no banco**
(`pedidos_tiny.chave_nfe` = 0/595 preenchidos) para subir a nota nós mesmos.
Entre "bloqueado por falta de NF" e "o Tiny já arranjou" (guard pula), não sobra
janela útil para o app confirmar. Foco correto: acelerar o upload da NF (lado
Tiny) e manter o cache cheio (v42).

**`shopee-ship` (app confirma o envio — COEXISTE com o Tiny):**
- `?modulo=ship-param&loja=X&order_sn=Y` — leitura pura (`get_shipping_parameter`).
- `?modulo=confirmar&loja=X&order_sn=Y[&dry=1]` — `ship_order` (mutação). Lê os
  params primeiro; se a Shopee disser "não elegível / já tem pacote" (Tiny já
  arranjou), **pula** (sem corrida). Auto-seleciona endereço `default_address` +
  slot `recommended`. As duas lojas usam canal **pickup** (precisa `address_id` +
  `pickup_time_id`). `dry=1` mostra o payload sem confirmar.
- **Está deployada mas fora do fluxo automático** — o Tiny dá conta hoje. Usar só
  se decidir que o app assume a confirmação (para os que o Tiny ainda não pegou).
- `ship_order` é **ação irreversível** (agenda coleta) — nunca disparar sem
  confirmação explícita, por pedido.

---

## 5.2 NF de devolução (Tiny) — o que a API permite e o que não permite

**Desenho fiscal validado ao vivo (27/jul/2026, NF 001124 autorizada, protocolo
SEFAZ 135263016600187):** devolução = nota de **entrada** (`tipo E`, `tpNF 0`),
natureza **"Devolução de Mercadorias"** (`idNaturezaOperacao 794940395`), série
**13**, `finalidade 4`, CFOP **1202**, `NFref/refNFe` = chave da NF de venda. Ao
criar pela UI informando a chave referenciada, o Tiny preenche cliente, itens e
impostos sozinho; a chave referenciada aparece nas `observacoes` da nota (regex
44 dígitos) — é assim que casamos com `notas_cancelados`.

**Limites da API v3 (testados):**
- **Não cria nota por JSON.** Só por XML pronto (`POST /notas/xml`) — inviável.
- `POST /pedidos/{id}/gerar-nota-fiscal` só aceita `{modelo}` e **falha com 409**
  se o pedido já tem NF (1 pedido = 1 nota) → **não serve para devolução**.
- Não há endpoint de naturezas de operação (o ID 794940395 veio de um GET numa
  devolução manual).
- **Emitir funciona**: `POST /notas/{id}/emitir` (exige escopo
  `notas-fiscais-escrita` no aplicativo API v3 — habilitado em 27/jul; mexer nos
  escopos **revoga o token ativo**, rodar `tiny-refresh-token` depois).

**Fluxo em fases:** Fase 2.5: operador **cria** as devoluções na UI do Tiny; o
app **emite** e **registra** via aba Devoluções → card "Pendentes de emissão"
(`nf-devolucao?modulo=pendentes` lista tipo E Pendentes + match por chave;
`modulo=emitir&id_nota=X&confirmar=1` emite UMA nota, guardas tipo E + situação
1). **Estoque NÃO é lançado pelo app** (decisão: manual/regra no Tiny).

**Fase 3 (VALIDADA em 28/jul/2026 — NF 001125/13 autorizada, ciclo 100% via
app):** `modulo=criar&id_nota_venda=X&confirmar=1` lê a NF de venda na v3 e
inclui a devolução via **API v2** (`nota.fiscal.incluir.php`, secret
`TINY_V2_TOKEN`); depois `emitir` pela v3. Aprendizados que custaram tentativas:
- A v3 devolve texto com **UTF-8 duplamente codificado** ("BrasÃ­lia") —
  `fixEnc()` reverte antes de mandar à v2.
- `incluir` exige **`frete_por_conta`** ("S" = sem frete, como o gabarito).
- **`refNFe` funciona na v2** (campo estruturado preenchido na nota), mas a nota
  criada via API fica com `observacoes` VAZIAS → o match por regex não pega;
  por isso o `criar` grava `id_nota_devolucao` no ato e o `emitir` casa por
  chave OU por id.
- **Série: sempre enviar `serie: "13"`** (das devoluções). Sem o campo, o Tiny
  usou a série 12, cujo nº 000001 estava **INUTILIZADO na SEFAZ** → emissão
  rejeitada (cód. 32). A nota rejeitada 000001/12 (id 820172089) ficou para
  excluir na UI.
- Há **duas naturezas homônimas** "Devolução de Mercadorias" (794940395 manual ×
  718775306 usada pela v2 no match por nome) — CFOP saiu certo (2202
  interestadual automático), mas a contabilidade deve validar qual manter.

**Duas populações de devolução:** (a) cancelados com NF (rastreados em
`notas_cancelados`); (b) **entregues que o cliente devolveu** — fora da varredura;
o `emitir` funciona igual, só não tem onde registrar (match retorna null).

**Falso-positivo de cancelamento (31/jul/2026 — custou 2 NF-e erradas):** o
mapeamento `mapSituacaoPedido` do `tiny-sync` está **CORRETO** (validado contra o
enum oficial v3 `ObterPedidoModelResponse`: 2=Cancelada, 7=Pronto Envio, etc.). A
causa é **flicker REAL upstream (Shopee→Tiny)**: o Tiny reporta `situacao=2`
(Cancelada) por um instante e depois volta para ativo (ex.: 287879/287245, na
verdade ENVIADOS=7). A varredura fotografava esse instante e **nunca removia**; aí
o pedido aparecia como cancelado e alguém gerou+emitiu devolução para venda válida
— **erro fiscal**. Defesas em camadas: (1) front lê `view_devolucoes_lista` (=
`notas_cancelados` JOIN `pedidos_tiny` WHERE `situacao='cancelada'`) — esconde os
que voltaram a ativo; (2) `criar` (v3.7) tem **guard ao vivo**: consulta
`/pedidos/{id}` no Tiny e recusa se `situacao != 2` — **nunca confie só no
espelho**; (3) `varrer-cancelados` (v3.8) só insere se o Tiny **confirmar ao vivo**
`situacao==2` (ignora flicker já revertido na origem) + remove falsos-positivos
sem devolução. Rate-limit da **API v2**: 60 req/min nesta conta (header
`x-limit-api`); NÃO faça retry na v2 no código 6 (reinicia o cooldown).

---

**Fila SVL sem fantasmas (31/ago/2026):** `devolucoes_svl` é uma **VIEW** sobre
`devolucoes_svl_base` que esconde as órfãs já resolvidas por clone
(`devolucao_clonadas.id_novo IS NOT NULL`). O front lê/ATUALIZA pela view
(auto-atualizável); **UPSERT não atravessa view** — a `devolucoes-svl-sync`
grava na `_base`. Nota com data de emissão >~30 dias é recusada pela SEFAZ na
emissão direta: o caminho é o clone com data de hoje (`clonar-lote`). Excesso
de emissões num dia dispara **SEFAZ 656 "Consumo Indevido"** — parar sem retry
e espalhar no tempo (cron temporário jobid 98 drena o backlog; remover quando
`recriados=0`).

## 5.2.1 Bipar etiqueta de devolução do Mercado Livre (22/set/2026)

A etiqueta de devolução do ML **não tem o nosso número de pedido**. O QR é
`{"id":"<shipment_id>","t":"lm"}` e o código de barras é o mesmo número puro
(11 dígitos) — é o id do **envio de retorno**, que não é o envio de ida nem
existe em nenhuma tabela nossa (`ml_billing_detalhes.shipment_id` está 0/10.209
preenchido). Por isso a bipagem em Devoluções nunca casava: o
`DevolucoesRecebidas.buscar()` só procurava `numero_ecommerce`, `numero_pedido`
e `codigo_rastreamento` no espelho do Tiny.

Único caminho que o ML expõe: **`GET /shipments/{id}`** com o token da conta
dona devolve `order_id` (validado ao vivo: envio `47938703625` → `type:
"return"`, pedido `2000018261294906` → Tiny 302304, "Mercado Livre (Ottz Pet)",
cancelado, NF 086589). Não há endpoint de returns utilizável:
`/post-purchase/v1|v2/claims/{id}/returns` responde 400/429,
`/post-purchase/v1/returns/...` não existe e `/stock/withdrawals` dá 403 (o app
não tem a role). O que existe e funciona é `/post-purchase/v1/claims/{claim_id}`
(o `mediations[].id` do pedido) — dá motivo e resolução, mas **não** o envio.

- **Edge fn `ml-devolucao-lookup` v4:** `?codigo=<texto bipado>` (ou body
  `{codigo}`) aceita o QR inteiro, o número puro ou texto com vários números;
  tenta as contas conectadas (Ottz primeiro, depois SVL) e cacheia em
  **`ml_envio_devolucao`** (`shipment_id` PK → `order_id`, tipo, status,
  tracking, `bipagens`). Bipar duas vezes o mesmo pacote não volta ao ML.
  Código que o ML não reconhece também é gravado (`encontrado=false` + `erro`)
  para investigar com a etiqueta na mão.
- **Front:** "Fallback 5" no `buscar()` — só entra quando os fallbacks locais
  falham e o texto tem 9–14 dígitos; com o `order_id` na mão refaz a busca
  local normal (e, se o pedido não estiver no espelho, monta card mínimo).
  Mensagem de erro específica quando o ML não reconhece o envio.
- **Pedido de carrinho (pack) — card vazio na 1ª versão:** o Tiny registra
  pedido ML de carrinho pelo **`pack_id`**, não pelo `order_id` (1.589 casos;
  ex.: envio 48015249396 → pedido 2000018379163128 → pack 2000014956563857 →
  Tiny 306039). A busca do Tiny usa `numero_ecommerce in (order_id,
  pedidos.pack_id)`; status/itens/registro ficam no `order_id`. Pedido do
  **Full** não passa pela nossa separação (`separacao_tiny` vazia): os itens
  vêm de `pedido_itens` (espelho do marketplace). O selo de status diz
  "ML:"/"Shopee:" conforme o canal (antes era sempre "Shopee:").
- **Indexador (v3/v4, cron jobid 114 `27 */2 * * *`, Bearer):**
  `?modulo=indexar&dias=N[&conta=][&reiniciar=1]` — `GET /post-purchase/v1/
  claims/search?player_role=respondent&player_user_id=<conta>&sort=
  last_updated:desc` (1.693 claims na Ottz) → para cada claim que não é
  `cancel_purchase`, **`GET /post-purchase/v2/claims/{id}/returns`** →
  `shipments[]` (`shipment_id`, `tracking_number`, status) + `orders[].order_id`.
  Grava com `origem='indexador'`, `claim_id`, `return_id`; estado por conta em
  `ml_devolucao_index_estado`. **Armadilhas:** o `claims/search` **não traz
  `related_entities`** (a v3 filtrava por ele e só pegava claims tipo
  "returns" — 11 de 40); returns sem devolução = 404 "There is no associated
  return" (mediação resolvida por cobertura, sem o produto voltar); 429 fácil
  (retry com espera). 90 dias: 283+14 claims → 42 envios de retorno em ~41 s.
- **Códigos que o ML não conhece = DEVOLUÇÃO AO REMETENTE (resolvido 22/set
  com a etiqueta física):** `47880155625`, `47880250285`, `47881569283`,
  `47880389898`, `48037688400` (404 `not_found_shipping_id`; outra conta daria
  401). A etiqueta tem remetente **"MELI #0, Rua Jussara 1250, Tamboré,
  Barueri"**, rota `XSP1 > SSP18` e, no topo, **"Ref. ID: 47662448910"** — esse
  é o envio ORIGINAL (despachado por nós, `xd_drop_off`, J&T; `status
  not_delivered` / `substatus returned`) → pedido 2000017707640358 → pack →
  Tiny 288504. O envio da volta é interno do ML e não existe na API pública, e
  o original não cita o id novo (nem em `/history`). **Não é Full** (Full não
  entregue volta para o CD). Solução: digitar o **Ref. ID** (a bipagem normal
  resolve via `/shipments`) ou escolher na lista
  **`view_ml_devolucao_ao_remetente`** (ML `motivo_cancelamento =
  'shipment_not_delivered'`, logística ≠ fulfillment, 90 dias, Tiny por
  `order_id`/`pack_id`, `recebido_em` de `devolucoes_recebidas`; 20 pedidos em
  22/set, nenhum recebido), que a tela mostra quando o ML não reconhece o
  código.
- **Quem vai ao ML (corrigido 24/set):** SÓ o QR `{"id":…,"t":"lm"}` ou um
  número puro de **10–11 dígitos** (id de envio / Ref. ID). A 1ª regra ("tem
  9–14 dígitos em algum lugar") mandava ao ML os rastreios da **Shopee**
  (`BR263476903446F`, e o leitor às vezes entrega só os dígitos, 12–13) que não
  estavam no espelho — a bancada via a mensagem do ML ("devolução ao remetente")
  para pacote da Shopee (8 casos em 23–24/set, gravados em `ml_envio_devolucao`
  com `encontrado=false`). Correios (`AP…BR`), J&T/TikTok (15 dígitos) e pedido
  ML de 16 dígitos também ficam fora. Junto: o fallback "rastreio CONTÉM o
  bloco" passou a tentar os 3 maiores blocos, não só o maior (o
  `263476903446` = `BR263476903446F` não casou por isso).

## 5.2.2 Bipar etiqueta do TikTok Shop em Devoluções (24/set/2026)

A etiqueta do TikTok é da **J&T Express Brazil**, rastreio de 15 dígitos
**999881…** (o mesmo da ida — pacote não entregue volta com ela). O Tiny guarda
esse rastreio só na **Bumi** (73/97); na **ACZ, 0 de 537** — e o
`tiktok-sync-pedidos` (outra sessão) não grava o campo. Por isso a bipagem não
casava (ex.: `999881942058407` → pedido **585780818888131762** → Tiny 299731,
cancelado "collection time out").
- **Edge fn `tiktok-rastreio` v1** (separada da `tiktok-sync-pedidos` de
  propósito, §2.1.5/§10): `?modulo=preencher[&dias=15][&max=]` lê
  `tiktok_rastreio_pendentes(p_dias, p_max)` (pedidos não-UNPAID na janela sem
  consulta, ou sem rastreio há >4 h) e chama **`GET /order/202309/orders?ids=`**
  (50 por chamada) → `tracking_number` + `shipping_provider` do pedido e de cada
  `line_items[]` (`package_id`). Grava **`tiktok_rastreios`** (PK `order_id,
  rastreio`, índice em `rastreio`) e **`tiktok_rastreio_estado`**
  (`n_rastreios`, `verificado_em`). `?modulo=pedido&id=` lê um pedido ao vivo.
  Cron jobid **123** `53 */2 * * *` (`dias=20`, Bearer). Backfill de 400 dias
  feito (a RPC corta em 1.000 linhas pelo PostgREST — rodar de novo até
  `pendentes` < 1.000). ~85% dos pedidos têm rastreio; o resto é cancelado
  antes de enviar.
- **Front (`DevolucoesRecebidas.buscar`):** fallback TikTok ANTES do ML —
  tokens de 10–20 dígitos em `tiktok_rastreios.rastreio` → `order_id` →
  `pedidos_tiny.numero_ecommerce`. Card TikTok: status de `tiktok_pedidos`,
  motivo de `tiktok_cancelamentos.motivo_texto` / `tiktok_devolucoes`, itens de
  `tiktok_pedido_itens` quando a separação não tem (cada linha = 1 unidade →
  agrupa por SKU; brinde marcado). Selo "TikTok:".
- Os 15 dígitos da J&T **não** vão ao ML (regra em §5.2.1 — só QR `"t":"lm"`
  ou número puro de 10–11 dígitos).

## 5.2.3 Automação de NF de devolução — SVL/Bumi (30/set/2026)

Pedido do dono: gerar a NF de devolução sozinha para **todo** pedido que precisa
dela. Decisões dele (30/set): casos = **cancelado com NF autorizada, falha de
entrega, extravio, reembolso com produto e reembolso só em dinheiro** (este e o
extravio são "devolução simbólica" — produto não volta; decisão fiscal do dono);
reembolso gera nota **na aprovação** (Shopee `ACCEPTED`), não na chegada do
pacote; automação **semi**: o motor CRIA (Pendente) e a **emissão continua no
clique** da equipe (lista da SVL em `/devolucoes`). Fase 1 = conta SVL (Bumi
Shopee + [SVLL] ML); depois Ottz.
- **Fila:** `view_devolucao_auto_candidatos_svl` — pedidos desde 01/ago dos canais
  `Bumi Pet [Shopee]`/`Sevilla Store [SHOPEE]`/`[SVLL] Mercado Livre`: cancelados no
  Tiny principal (menos `Unpaid Order` = nunca faturado) + reembolsos Shopee
  `ACCEPTED` da loja 759046323 com `solucao` preenchida. Some da fila o que já tem
  estado final em **`devolucao_auto`** (PK conta+order_sn: caso, estado, chave da
  venda, id/nº da nota, `itens_parcial`, detalhe, tentativas, `proxima_em`).
- **`nf-devolucao` v3.21 (`criar`, conta svl):** pedido **não** cancelado passa se
  há reembolso `ACCEPTED` no espelho (`guard = reembolso_aceito(return_sn, itens|
  valor|parcial)`). **ARMADILHA de SKU:** a devolução Shopee traz o SKU do
  ANÚNCIO (pai) e a NF da SVL traz o SKU do Tiny com **kit aberto** em
  componentes (15205 = 2× 15190; 15836 = 2× 15679). Reembolso que cobre o pedido
  todo (itens ou valor) = **NF inteira**; parcial traduz `pedido_itens`
  (pai→filho) e abre o kit por `produto_kits`; o que não casar → `revisar_itens`
  (nunca chuta item). **Anti-duplicata em todas as origens, também no dry:**
  `notas_cancelados`, `devolucoes_svl_base.chave_referenciada`, `devolucao_auto`.
  Nota criada entra na hora em `devolucoes_svl_base`. Recusas têm `codigo`
  (`sem_pedido_svl`, `sem_nf_venda`, `venda_nao_autorizada`, `nao_cancelado`,
  `ja_existe`, `revisar_itens`, `itens_sem_ncm`, `v2_bloqueada`). Série default da
  SVL corrigida para **12** (era "1", a da venda).
- **Espelho com a chave da venda:** `devolucoes_svl_base` nunca guardou
  `chave_referenciada` (o sync lê só a LISTA do Tiny) → o motor não enxergava as
  ~740 devoluções que a equipe emitiu na mão em ago/set. `devolucao-auto?modulo=
  espelhar` lê o detalhe (`observacoes` → 44 dígitos) e marca `chave_lida_em`
  (nota criada pela API v2 não tem observações → fica sem chave; essas são
  cobertas por `devolucao_auto`). **O motor não cria nada enquanto houver nota
  desde 01/ago sem chave lida.**
- **Edge fn `devolucao-auto` v1:** `status` · `espelhar[&dias][&max_det]` ·
  `processar[&max=3][&dry=1]` (espelha o recente → aborta se falta chave → rodada
  morta no meio vira `revisar`, nunca retenta → chama o `criar` com `confirmar=1`
  → grava o estado). `sem_pedido_svl` retenta a cada 12 h (até 4×: pode não ter
  faturado ainda); erro retenta com espera crescente (até 5×); v2 bloqueada para a
  rodada sem contar tentativa.
- **Tela:** painel "Automação de devoluções" no topo da aba SVL (contagem por
  estado + casos que precisam de gente, com o motivo) e selo "automática · caso ·
  pedido" na nota criada pelo motor (`DevolucaoAutoSvlPainel.tsx`,
  `src/lib/devolucaoAuto.ts`).
- **Validado em simulação (30/set):** extravio 260913U8DJ5H8M → NF 054358 (10933
  ×6); falha 260925VVBKN42G → NF 056259 (15679 ×5); reembolsos 2609263252K37Y →
  NF 056420 (14404 ×1 + 15679 ×2) e 260918BXQUP2M8 → NF 055207 (15190 ×2); cancelado
  de 30/09 → `sem_pedido_svl` (não faturado).
- **No ar (30/set):** cron **135** `devolucao-auto-svl` (`11,26,41,56`, `processar&max=3`,
  Bearer) — só cria. Primeiras reais: **001470** (260723EXDKDSX0, R$ 48,90, 14758 ×5),
  **001471** (260728SXKKY0N8, R$ 79,92) e **001472** (260728SYG4JKA4, parcial: 1 de 2
  kits, R$ 89,90), conferidas no Tiny (série 12, tipo E, finalidade 4, NCM ok). Fila
  inicial ~700 (maioria deve dar `ja_existe` — a equipe já emitia na mão) ≈ 2–3 dias
  para drenar. **A equipe deve PARAR de criar devolução na mão no Tiny SVL** para os
  casos cobertos — o controle de duplicata só enxerga nota manual depois do espelho
  (a cada rodada, 4 dias para trás).
- **EMISSÃO automática (18/out/2026, decisão do dono — opção B):** a criação funcionava,
  mas a emissão ficava no clique e, de 01/10 a 18/10, **456 notas** criadas pelo motor
  ficaram Pendentes (~R$ 36 mil). `devolucao-auto` **v6** `?modulo=emitir[&max=3][&dry=1]`:
  só as notas que o MOTOR criou (`devolucao_auto.estado = 'criada'`) e seguem `situacao 1`
  em `devolucoes_svl_base`, a mais antiga primeiro, pelo mesmo caminho do botão
  (`nf-devolucao` POST `{modulo:"emitir", conta:"svl", id_nota, confirmar:"1"}`), 4 s entre
  notas, orçamento de 40 s. **SEFAZ 656** = para a rodada, pausa de 1 h e aviso no Discord
  (canal `devolucoes`); recusa = a nota espera 12 h (aviso só na 1ª); "ainda processando" =
  1 h; nota com **mais de 29 dias** não é emitida (a SEFAZ recusa — clonar; aviso 1×/dia às
  9h). Cada tentativa em `debug_fulfillment` (`modulo 'devolucao-auto-emitir'`, `etapa` = id
  da nota; 200 autorizada · 429 = 656 · 409 recusa · 202 processando). Cron **158**
  `devolucao-auto-emitir-svl` (`3,18,33,48`, `max=3`, Bearer publicável) ≈ 12 notas/h → o
  backlog drena em ~1,6 dia. 1ª real: **001489** autorizada ("autorização fora de prazo" —
  nota antiga, a SEFAZ aceita até ~30 dias). Nota criada à mão pela equipe NÃO é emitida
  pelo robô.

## 5.3 DRE — categorização de despesas e camada de override

**Fonte das despesas:** `contas_pagar` é **espelho do Tiny**, re-sincronizado
pelo cron `tiny-sync-contas-pagar` (jobid 16, **1×/dia às 4h**) (upsert por `tiny_id`).
Editar/excluir direto ali **é desfeito no próximo sync** — nunca escreva no
espelho para ajustar o DRE.

**Categorização:** a função `categoria_despesa_dre(fornecedor_nome)` (regex no
nome) devolve strings **exatas** que o front precisa casar ao caractere. As
grafias já causaram bug ("Sem itens detalhados"): `Frete/Logística` (sem
espaços), `Outras / a classificar`, `Pessoal/Creative (revisar)`, além de
`Pessoal`, `Aluguel`, `Administrativas`, `Embalagem`, `Financeiras` e as que
saem do DRE (`Mercadoria (ref)`, `Cartão/Financeiro (fora DRE)`, `Impostos`).

**Gastos recorrentes (25/ago/2026):** tabela `dre_gastos_recorrentes`
(descrição, categoria do DRE, valor/mês, `mes_inicio`→`mes_fim`; RLS
authenticated, front escreve). As views `view_dre_despesas`/`_detalhe` expandem
mês a mês até o mês corrente (nunca projetam futuro); no detalhe a linha vem
com `tiny_id NULL` — o front já esconde o override nesse caso. Botão "Gastos
recorrentes" no cabeçalho do `/dre`. **Encerrar** (preenche `mes_fim`) preserva
o histórico; **excluir** apaga de todos os meses. Baseline md5 validado
idêntico com a tabela vazia.

**Override manual (28/jul/2026):** tabela `dre_conta_override` (PK `tiny_id`,
campos `excluir`, `categoria_override`, `motivo`, `editado_por`, `editado_em`;
GRANT anon+authenticated, sem RLS). Sobrevive ao sync porque a chave é o
`tiny_id` estável. As views `view_dre_despesas` e `view_dre_despesas_detalhe`
fazem LEFT JOIN nela: categoria efetiva = `coalesce(categoria_override,
categoria_despesa_dre(...))`; o agregado tira `excluir=true` da soma; o detalhe
**mostra** a excluída (flag `excluida`) para dar "restaurar". Regra de ouro ao
mexer nessas views: **capture baseline antes/depois** (override vazio tem de dar
idêntico ao centavo — validado). O front (`/dre`) grava por lançamento no
drill-down e recarrega os totais. Receita/CMV expandem por empresa a partir de
`view_dre_operacional`.

---

## 5.4 Fluxo de caixa × Shopee Acelera

As **duas lojas** usam o Shopee Acelera (antecipação de repasse; Ottz desde maio,
Bumi desde 28/08/2026). O "Resgate do Shopee Acelera" entra em
`transacoes_carteira` como `FAST_ESCROW_DISBURSE` **sem `pedido_id`**, e os
pedidos que ele paga **nunca** ganham "Renda do pedido" (`ESCROW_VERIFIED_ADD`).
Consequência: "pedido sem evento na carteira" ≠ "a receber". Em 14/set a
projeção mostrava R$ 259 mil de entradas Shopee em 7 dias; R$ 202 mil já tinham
entrado via resgate. Modelo atual (opção A): `view_shopee_a_receber_acelera`
aloca os resgates dos últimos 45 dias aos pedidos sem evento (60 dias) do mais
antigo para o mais novo (FIFO) e marca `coberto_por_resgate`; as views
`view_fluxo_caixa_eventos` e `view_carteira_a_receber` só contam os descobertos
("disponível p/ resgate", em D+1 — o resgate é **manual**, entra quando alguém
clica). Validação: a alocação fecha ao centavo com os resgates e os descobertos
começam logo após o último resgate de cada loja. `FAST_ESCROW_DEDUCT` ("Ajuste
do Shopee Acelera") é pequeno (3–4% do antecipado): cancelamento/valor menor.

## 5.4.1 Fluxo de caixa sem Shopee Acelera (22/set/2026)

O dono desligou o Acelera nas duas lojas (último resgate: Ottz 06/09, Bumi
09/09). A projeção ainda tratava todo pedido Shopee sem evento como
"disponível p/ resgate amanhã" — R$ 114 mil caindo em D+1 que na verdade entram
ao longo de duas semanas.
- **Prazo real medido** (pedido → crédito "recebimento do pedido" na
  carteira, ago/set): mediana 8 dias Ottz / 7 Bumi, p90 13 dias.
  `view_shopee_lag_liberacao` = distribuição empírica por loja (pedidos de 21
  a 90 dias atrás).
- **Modo do Acelera por loja:** `shopee_acelera_config(shop_id, modo
  auto|ligado|desligado)` + `view_shopee_acelera_status` (auto = resgate nos
  últimos 10 dias). Volta a ligar sozinho se alguém resgatar.
- **Sem Acelera:** cada pedido pendente é espalhado pelos próximos dias pela
  distribuição, condicionada ao que já esperou; pedido com >30 dias sem
  crédito não entra; concluído sem crédito entra em D+1 se tiver até 14 dias.
  A venda projetada da Shopee usa a mesma distribuição (antes: +3 dias).
  Com Acelera ligado, a regra antiga continua valendo.
- **Performance:** a projeção virou **`mv_fluxo_caixa_eventos`** (refresh no
  cron 62, a cada 20 min; ~5 s). `view_fluxo_caixa_eventos` é view fina sobre
  ela (leitura 43 ms) e ganhou `atualizado_em`; a lógica viva está em
  `view_fluxo_caixa_eventos_live`. `view_fluxo_caixa_diario` foi recriada
  (dependia do nome). O snapshot diário (cron `fluxo-caixa-snapshot`, 09:15
  UTC) lê a view fina, então mede a projeção com até 20 min de atraso.
- `view_carteira_a_receber` troca os rótulos "disponível p/ resgate" por
  "libera após a entrega" / "aguardando crédito" quando o Acelera está
  desligado. A tela `/fluxo-caixa` mostra o modo por loja no cabeçalho.
- **Shopee só credita em DIA ÚTIL (conferido 22/set):** em 14 sáb/dom sem
  Acelera, 22 dias com zero crédito; segunda tem ~2,5× um dia útil (235
  créditos, R$ 10,4 mil × ~100 / R$ 4 mil); feriado igual (07/09 = 1 crédito,
  08/09 = 227). Janela 09h–18h. Camada `view_fluxo_caixa_eventos_ajustado` move
  só as ENTRADAS Shopee para `proximo_dia_util(dia)` (fim de semana +
  `feriados_nacionais`, cadastrados até dez/2027 — **renovar a tabela todo
  ano**) e reagrega; a matview lê dessa camada. Total de 60 dias idêntico ao
  centavo. Mercado Livre libera todos os dias (sáb 515, dom 369 em 60 d) e não
  entra na regra.
- **PIX/transferência avulsa do Mercado Pago fica FORA (decisão do dono,
  22/set):** `transacoes_carteira.tipo='recebimento_avulso'` é quase sempre
  dinheiro próprio mudando de conta (saque da carteira Shopee → MP, transferência
  dos bancos). Saiu da projeção (`ml_real`), do `view_carteira_a_receber` e do
  `view_fluxo_caixa_previsto_realizado` — em 21 dias eram R$ 285 mil de
  "realizado" contra R$ 95 mil de liberação real de vendas do ML, e 10 avulsos
  de mar–ago presos como "pendente" no espelho viravam R$ 1.439 fantasmas em
  HOJE. Os lançamentos continuam na carteira; só não contam como caixa.
- Previsto × realizado antes da mudança mostrava o sintoma: dias de resgate
  com +R$ 60–108 mil e os demais sistematicamente abaixo do previsto.

## 5.5 Separação — botão único "Imprimir etiqueta" (TAG nasce ao imprimir)

Pedido do dono (14/set/2026): um clique imprime e aplica a TAG, sem que o
marcador do Tiny (1 chamada por pedido, ~0,4 s cada) atrase o papel, e a TAG
só vale para quem saiu. Ordem no front (`imprimirComTag` em `separacao.tsx`):
1. `separacao-imprimir?modulo=reservar&grupo=<tag_sugerida>` — aloca a TAG do
   dia, grava `tags_lote(status='imprimindo')` e `separacao_tiny.tag_lote` nos
   pedidos sem TAG da linha. **Só banco, instantâneo.**
2. Imprime pela TAG pelo caminho de sempre (`imprimirPorSku`: Shopee por lote,
   ML pedido a pedido, identificadora no fim). `imprimirLoteApi`/`imprimirMlPedidos`
   agora devolvem a lista do que saiu.
3. `separacao-imprimir?modulo=aplicar&tag=X` body `{order_sns_ok}` — marcador no
   Tiny só nos impressos (+ quem já constava em `impressao_etiquetas`), com
   orçamento de 20 s e retomada (`restantes`; o front chama em laço, idempotente
   por `tags_aplicadas_pedidos`). Ao finalizar, quem NÃO saiu perde a TAG no
   sistema e volta para a fila; `tags_lote` vira `aplicada` com a contagem real.
Linha que já tem TAG só imprime. "Aplicar TAG em massa" (tag-lote antigo) segue
existindo na barra. Função separada da `tiny-separacao` (crítica; outras sessões
mexem). **Fase 2 (a testar): embalar automaticamente os pedidos com impressão
confirmada** — o gancho natural é o `confirmar-impressao` (job `done`).

## 5.5.1 Separação no design novo — fase 1 (22/out/2026)

Pacote "Separação" do Claude Design (zip de 22/out). `SeparacaoPage` abre o visual novo por padrão
(`localStorage separacao.visual`; "Usar o visual antigo" no menu do Atualizar) e, se o novo quebrar na
tela, a `ProtecaoVisualNovo` (error boundary) mostra o antigo com o erro no topo. O novo é um ramo
`if (novo)` dentro da MESMA `FilaPriorizada`: imprimir/TAG/embalar/falta/forçar são as funções de
sempre; peças visuais em `src/components/separacao/ui/kit.tsx` (tokens `--pm-*`, + `--pm-er/spx/ml/tt`).
Topo: impressora (Popover; offline = faixa vermelha com "Trocar para"), Atualizar + Tiny/Processar abertos.
"Pede ação": prazo vencido, cancela hoje/amanhã (`view_risco_cancelamento_resumo`; sem nada na fila
leva a /risco-cancelamento), etiquetas com erro/geração parada (`view_etiquetas_saude`), aguardando a
impressora (estado `sent`), falta de estoque, Multi SKU. Abas Fila · Multi SKU · Lotes do dia (+ links
para Monitoramento/Histórico). "Meu turno" (`separacao.turno`) = bandas de peso: leves {até 4 kg, sem
peso}, pesados {4–8, >8, sem peso}. Seleção → barra escura (embalar impressos, reimprimir forçado,
imprimir). **Fase 2 (22/out):** pedidos da linha, Multi SKU (cartões por combinação + picking em 2
colunas), Lotes do dia (Hoje/Ontem, status, quem finalizou, menu) e "Impressões de hoje" (`separacao_log`
por TAG) no padrão; cor por un/pedido de volta (1 cinza, 2 azul, 3 âmbar, 4 roxo, 5 verde, 6+ vermelho);
"Cancela amanhã" sem valor. Confirmações: `confirmarSep()`/`pedirTextoSep()` (`ui/dialogos.tsx`) abrem o
diálogo desenhado quando o `HostDialogosSep` está montado (visual novo) e caem no `window.confirm/prompt`
no antigo; `VisualNovoSep` (contexto) troca FaltaEstoqueDialog, ForcarEmbalarDialog (quem = `equipe_membros`
+ motivo + confirmação), PedidosDoSku, LotesDoDia e MultiSkuPanel. Monitoramento e Histórico seguem
como estavam. **Não conferido na tela** (pede login).

## 5.6 Ponto (registro de horas da equipe) — 16/set/2026

Rota `/ponto` (módulo `galpao`), quiosque: a pessoa escolhe o nome, digita a
SUA senha e bate **Chegada / Almoço / Saída** ("Almoço" é um botão: 1º clique =
saída, 2º = volta). Pessoas em `ponto_pessoas` (vini, renan, niko, tania,
kevin; senha em **bcrypt** via pgcrypto — que no Supabase vive no schema
`extensions`: as RPCs têm `search_path = public, extensions`). Escrita **só por
RPC security definer**: `ponto_definir_senha(pessoa, nova, atual?)` e
`ponto_registrar(pessoa, senha, evento)` — ordem dos eventos, um por dia,
`pg_sleep(0.6)` em senha errada. As tabelas não têm grant para o app; ele lê
`view_ponto_pessoas` (sem hash) e `view_ponto_dia` (horas = saída − chegada −
almoço; dia sem saída/volta = incompleto). O quadro "Hoje" e o "Relatório do mês" só
aparecem para o administrador (módulo `todos`). Ajuste manual de marcação
ainda não existe (fazer por SQL). Testado ponta-a-ponta com pessoa temporária (12 casos).

## 5.7 Prazo de pagamento por fornecedor (base do ciclo de caixa)

**Objetivo:** prazo do fornecedor = vencimento da parcela − âncora. Três âncoras
lado a lado (pedido / emissão da NF / entrada da mercadoria); **principal = NF**,
sem NF = pedido (`ancora_tipo` diz qual). Só a base — tela e ciclo de caixa depois.

**Views (22–23/set/2026):**
- `view_cp_parcela_origem` — 1 linha por parcela. Vínculo vem do TEXTO de
  `contas_pagar.descricao` (regex de "NF nº / Nota Fiscal l / nf 123" e "ordem de
  compra nº"). NF casa por **CNPJ só dígitos + número sem zeros**. `categoria` =
  categoria **efetiva do DRE** (override > `categoria_despesa_dre`), porque
  `contas_pagar.categoria` vem **NULL em 100%** (a listagem do Tiny não traz; só o detalhe).
- `view_prazo_pedido` — 1 linha por compra (fornecedor + NF, ou + OC), prazos
  ponderados por valor e divergência soma das parcelas × NF/OC.
- `view_prazo_fornecedor` — recortes 180d/12m por `data_ancora`, mín/máx/mediana,
  % sem referência (recorte por **vencimento**), dias pedido→NF→entrada, tendência 90×90.
- `view_fornecedor_mercadoria` — regra: DRE `Mercadoria (ref)` **ou** `Outras / a
  classificar` com parcela citando NF/OC (Esconde Aí, Four Plastic, Napi, Vidotto
  caem aí; Embalagem/Frete não).
- `view_cp_sem_referencia` — parcelas "In cash"/sem referência × OCs candidatas do
  mesmo fornecedor (pedido até 60 d antes do vencimento, casamento por **nome** — o
  mesmo fornecedor tem contato_id diferente no Tiny). **Sugestão**, nunca vínculo.

**Armadilhas:**
- `contas_pagar.data_emissao` é a data de **lançamento** no Tiny, não a da nota.
- `data_pagamento` só vem no **detalhe** (`dataLiquidacao`). A listagem não traz; o
  sync v1 gravava `null` fixo. v2: sync não envia mais a coluna; o módulo
  `liquidacao` (cron 116, 4h23 e 16h23) grava data + `valorPago`. O sync diário
  **re-grava `valor_pago = valor − saldo`**, então juros/multa da baixa são
  sobrescritos na rodada seguinte (pendência).
- Boleto **cedido ao banco** (Petlook pago via Itaú): a parcela tem o CNPJ do Itaú e
  não casa com a NF da Petlook.
- Backfill de NF: listagem do Tiny limitada a 600/chamada → `compras-sync?modulo=nf
  &de=&ate=&max=0` em janelas de 3 dias; depois `?modulo=nf-detalhe` até zerar
  (data de entrada). 95% das NF são retorno do Full (`ignorar=true`) e pesam no `raw`.

## 5.8 TikTok Shop (ACZ) no Pedidos Integrados — 24/set/2026

- **Só a loja ACZ/Ottz** (`shop_id 7496181924415506972`, "ottzpet"). A **Bumi**
  ainda não autorizou o app e segue em "Canais sem integração" (Tiny,
  `marca_canal = 'TikTok Shop l Bumi Pet'`).
- `view_margem_pedido_v2` = definição Shopee/ML/Amazon **UNION ALL
  `view_margem_tiktok`** (colunas idênticas, cast explícito para os tipos da v2 —
  `numeric(12,2)` quebra o `CREATE OR REPLACE` sem cast). Cascata automática para
  `view_kpi_pedidos_dia`, `mv_dre_pedidos_mes`, tendências e Dashboard. Baseline
  validado: Shopee/ML/Amazon **idênticos ao centavo** antes/depois.
- Loja `lojas` "TikTok (ACZ Pet)"; `view_canais_sem_integracao` exclui
  `'TikTok Shop ACZ ?'` e `'TikTok Shop'` (nome antigo no Tiny, fev–abr/2026) —
  senão o TikTok ACZ contaria duas vezes. `mv_canais_diario` ganhou o card
  "TikTok · ACZ Pet" (sem ADS: TikTok Ads não integrado).
- Margem TikTok = `recebido` REAL do extrato (liquidação) − CMV congelado em
  `tiktok_pedido_itens` − imposto. Out/25–mar/26 deu **negativa** (frete
  pós-liquidação + Kit Wisecat 15226 com peso errado) — é real, não bug.
- **ARMADILHA — id > 2^53:** o `shop_id` do TikTok não cabe em número do JS.
  `Number()` ou ler o bigint via PostgREST/JSON arredonda (`…6972` → `…7000`) e o
  JOIN com `lojas` falha em silêncio (canal saía "TikTok" sem empresa). A v4 lê
  `shop_id::text` e grava string. Vale para qualquer id TikTok (pedido, extrato):
  sempre texto.
- No front, o drawer do PI esconde "Puxar custo do Tiny" e "Custo manual" para
  TikTok (o CMV é congelado no sync; o reprocessamento por período mexe em
  `pedido_item_cmv`, que não alcança esses pedidos).
- Crons (minuto quebrado, política do NANO): 117 `recentes&horas=8` a cada 3h
  (:37) · 118 `financas` 10h47/22h47 UTC · 119 `extratos&etapa=lista` 10h53 ·
  120 `extratos&etapa=transacoes` 10h59 · 121 `devolucoes` 11h13.

## 5.9 Impressão própria (substituto do PrintNode) — fase 1, 24/set/2026

**Por quê:** o PrintNode só entrega o arquivo na impressora; toda a regra
(dedup "nunca reimprimir", preso, TAG, contador) já é nossa. PCs em rede →
Zebra Browser Print (só imprime do PC da impressora) descartado. ML em ZPL
aprovado pelo dono → o agente só precisa de ZPL.

**Peças (fase 1 — NADA do fluxo atual usa ainda):**
- Tabelas `print_agentes` (token só como sha256), `impressoras` (registradas
  pelo heartbeat do agente; `usar_proprio` = **chave da transição por
  impressora**, `printnode_id` = a mesma no PrintNode), `print_jobs`
  (`conteudo_b64` = ZPL em bytes exatos; estados pendente → pegou →
  impresso/erro, ou cancelado). RPC `print_jobs_pegar` (FOR UPDATE SKIP
  LOCKED). **`pegou` sem concluir = PRESO, nunca volta sozinho** (regra do dono).
- Edge fn **`impressao`** (verify_jwt off; agente autentica por
  `x-agente-token`, app por JWT de usuário ou service role): `heartbeat`,
  `aguardar` (long-poll 20 s, checa a fila a cada 1,5 s), `concluir`,
  `enfileirar`, `status`, `cancelar`, `impressoras` (online = contato < 90 s).
- Agente Windows **`tools/ottz-impressao/`** (PowerShell 5.1 puro, sem
  instalar nada; `.ps1` salvo **com BOM** — sem BOM o PS 5.1 lê como ANSI e o
  "—" vira aspas e quebra o script). ZPL cru via winspool (RAW), igual ao
  PrintNode. Impressora offline → não manda (erro); não saiu da fila do
  Windows em 60 s → cancela o job no Windows e reporta erro. `instalar.ps1`
  cria a tarefa agendada "Ottz Impressao" (logon, oculta, reinicia). `-Teste`
  imprime etiqueta local; `-Listar` mostra as Zebras vistas.
- Medido (24/set, agente de teste): job pego **0,5 s** após entrar na fila,
  concluído em 1,3 s (PrintNode: mediana 4–7 s).

**Agente instalado (30/set):** `bancada-1` no **RENANPC**, ZD220 USB =
`impressoras.id 2`. Instalar a partir da pasta do repositório: arquivo
baixado da internet fica "bloqueado" e a política padrão do Windows recusa o
script **em silêncio** (tarefa e `C:\OttzImpressao` não aparecem). Comando:
`powershell -NoProfile -ExecutionPolicy Bypass -File <repo>	ools\ottz-impressao\instalar.ps1`
com o `config.json` ao lado. A 1ª chamada do agente levou ~30 s (cold start).

**Fase 2 — LIGADA em 30/set (piloto só na ZD220 do RENANPC):**
- **O front NÃO muda:** continua mandando o `printer_id` do **PrintNode**. O
  servidor decide por impressora: `impressoras.printnode_id` (RENANPC =
  75043468) + `usar_proprio=true` + agente vivo (<90 s) → fila própria; senão
  PrintNode (**reserva automática, temporária** — decisão do dono). RPC única
  **`print_enfileirar_se_proprio(p_printnode_id, p_b64, p_titulo, p_origem)`**
  → id do job ou NULL. Só ZPL; PDF segue no PrintNode.
- **Quem chama:** `shopee-sync-ads imprimir` v66 (deploy 68; lote = 1 job por
  TAG/loja, igual ao PrintNode — opção A do dono, **sem limite de lote**),
  `ml-etiqueta` v16 (1 pedido/job, responde `enviado:true, fila_propria:true`),
  `fulfillment-inbound imprimir` v15 (identificadora/ZPL; `copias` = ZPL
  repetido). `separacao-imprimir`/`separacao-multi` não imprimem (só TAG).
- **Controle = o mesmo de antes, por pedido:** `impressao_etiquetas` ganhou
  **`print_job_id`** (fila própria) ao lado do `printnode_job_id` (um OU
  outro). Dedup "nunca reimprimir", forçado, preso e liberação para embalar
  leem a mesma tabela/estados.
- **Confirmação no banco, na hora:** trigger **`trg_print_jobs_espelha`**
  (impresso→`done`+`confirmado_em`; erro/cancelado→`error`; só mexe em
  sent/preso). Cron **133 `print-jobs-vigiar`** (`1-59/2`,
  `print_jobs_vigiar()`): `pendente` 25+ min (agente fora) → `cancelado`
  (nunca chegou à impressora, pode reimprimir); `pegou` 25+ min sem resposta →
  `preso` + TAG removida só no app (situação 1) + Discord canal pedidos — mesma
  regra do PrintNode. `confirmar-impressao` ignora linhas da fila própria no
  PrintNode e soma as ainda `sent` em `jobs_ainda_sent` (contador da tela).
- **Medido:** agente pega em 0,6 s; "impresso" ~10 s depois (espera o Windows
  esvaziar a fila USB; o papel sai em 1–2 s).
- **Deploy dessas funções via MCP:** não há CLI/token no PC — o arquivo inteiro
  vai colado; conferir SEMPRE baixando a versão no ar e comparando sha256 com
  o local (feito na `shopee-sync-ads`: idêntico).
- **1º dia de uso (30/set) — três armadilhas que NÃO eram do software:**
  (1) a tela do Full **não tem seletor de impressora**: usa a mesma
  `localStorage separacao.printerId` da Separação — se lá está outra ZD220, o
  Full imprime nela pelo PrintNode (lote de 80 KB "sumiu" assim); (2) depois de
  trocar o papel, a Zebra não aceitou o job: fila do Windows presa em
  "Excluindo, Imprimindo" (0 bytes) — o agente cancelou em 60 s (job `erro`,
  pedido liberado para reimprimir), mas o `Get-CimInstance Win32_Printer` do
  heartbeat **travou junto** e o agente ficou sem sinal (~2 min) até a Zebra
  voltar (luz verde fixa); **corrigir no agente: heartbeat não pode depender do
  spooler**; (3) formato errado = mídia da Zebra (a etiqueta Shopee é uma
  imagem `~DGR` 816×1218 = 10×15 cm SEM `^PW/^LL` — vale o tamanho gravado na
  impressora; os bytes da fila são idênticos ao `etiquetas_cache`). Calibrar
  (segurar o avanço até 2 piscadas) resolveu.
- **Correções do mesmo dia (30/set):** agente **v1.1.0** — toda consulta ao
  spooler (`Get-CimInstance Win32_Printer`, `Get-PrintJob`, `Remove-PrintJob`)
  roda num runspace com prazo (`ComTempo`, 10–15 s); estourou = spooler travado:
  o heartbeat segue e manda as impressoras como **offline** (o servidor para de
  enfileirar → reserva PrintNode) e loga "spooler voltou ao normal" quando
  normaliza. Atualizar um agente instalado = parar a tarefa, copiar o `.ps1`
  para `C:\OttzImpressao` e iniciar a tarefa (o `.ps1` precisa manter o **BOM**).
  **Apelido de impressora:** `impressoras.apelido` → `view_impressoras_apelidos`
  (printnode_id → apelido, grant anon/authenticated) → `aplicarApelidos()` em
  `src/lib/impressoras.ts`, usado pelas 4 listas (Separação, Multi SKU, Risco/A
  enviar, Full) DEPOIS do filtro "zd220" (que roda no nome original do PrintNode).
  RENANPC = **"Zebra Fundos (PC RENAN)"**. Full: o seletor de impressora ficava
  dentro do bloco "tem ZPL anexado" — agora aparece sempre no rodapé do envio.
- **2ª Zebra (01/out):** agente `bancada-2` no **JUSSARAPC** (PC da Tânia). O
  Windows de lá tem DUAS entradas da ZD220: a original ("ZDesigner ZD220-203dpi
  ZPL", `impressoras.id 151`) NÃO imprime (job preso na fila do Windows); a que
  funciona é a **"(Copiar 1)"** = `impressoras.id 150` = PrintNode **75108254**,
  apelido **"Zebra Frente (PC Tânia)"**, `usar_proprio=true`. A mesma Zebra
  compartilhada em rede no DESKTOP-SEPARACAO (`\jussarapc\…(Copiar 1)`,
  PrintNode 75573931) NÃO está mapeada — escolhida lá, segue pelo PrintNode.
  **Vigia:** o `instalar.ps1` agenda, além do logon, um gatilho a cada 5 min
  (tarefa já rodando = nada acontece); o agente do RENANPC morreu em 30/set
  (0xC000013A) e só voltou na mão.
- **Zebra mudou de PC (06/out):** o agente `bancada-1` foi para o **NIKOLASPC**
  (mesmo token/config; subiu na versão **1.0.0** — sem a correção do spooler da
  v1.1.0, atualizar o `.ps1`). Lá a fila do Windows que imprime é **"ZDesigner
  ZD220-203dpi [nikolaspc]"** (`impressoras.id 10540`); a "ZDesigner ZD220-203dpi
  ZPL" do mesmo PC fica offline. A ligação foi movida: `10540` ganhou
  `printnode_id 75043468` (o id que o app já mandava para a antiga "Zebra
  Fundos"), `usar_proprio=true`, apelido **"Zebra 2 (PC Nikolas)"**; o `id 2`
  ficou sem `printnode_id`/apelido. O roteamento é SÓ por `printnode_id` +
  agente vivo — impressora nova vista pelo agente nasce com `usar_proprio=false`
  e o app não a enxerga até alguém fazer essa ligação.
- **Pendente:** tirar a reserva do PrintNode depois de ~1
  semana; PDFs do Fulfillment → ZPL (pdf.js → ^GFA); seletor de impressora
  próprio no front. 55 linhas `sent` de ago (antes da janela do cron) ficam
  como estão — decisão do dono.

## 5.9.1 Promoções Shopee — Minha Promoção + Relâmpago (30/set/2026)

**Hub `/promocoes` (07/out/2026, pedido do dono):** um item de menu só, "Promoções", com uma
sub-aba por marketplace (`?mkt=shopee|ml|amazon|tiktok`): **Shopee** = Minha Promoção / Relâmpago
(`?aba=minha|relampago&loja=`; componente `PromocoesShopee`; a antiga "Relâmpago manual" —
página `/promocoes` de 01/ago — foi removida a pedido do dono), **Mercado Livre** = Central de Promoções
(`PromocoesML`, antes a rota `/promocoes-ml`), **Amazon** = `PromocoesEmBreve` (estudo) e **TikTok** =
`PromocoesTikTok` + `TikTokAcoes` (abaixo).
- **Design novo do Claude Design (21/out/2026, fase 1 = Shopee › Minha Promoção):** pacote "Promoções" (Promocoes.dc.html)
  aplicado por partes. Kit em `src/components/promocoes/ui/kit.tsx` (CabecalhoMkt com logos em `public/logos/*-icon.png`, FaixaDecisao,
  ListaPromos, CartaoRobo, TabelaPromo com preço editável/balão da conta da MC/menu "preço para MC x%"/barra de lote, PreviaAplicar com
  resultado por linha, ErroLeitura); cores = tokens **`--pm-*` em `.pm-ui`** (styles.css, claro/escuro pela classe .dark). A Minha
  Promoção virou `ShopeeMinha.tsx` (MESMAS leituras e escritas da `MinhaPromocao.tsx`, que fica no repositório sem uso): lê o detalhe de
  todas as promoções vivas (em andamento + programadas, até 15) para os contadores "Pede decisão" (MC negativa, < 10%, acabam hoje/amanhã,
  vagas da relâmpago de amanhã = `flashsale_programacao` ativas /50, fora de promoção = 20+ vendas em 30 d e fora de campanha via
  `modulo=em-campanha` + `shopee_anuncios_busca`, recusados na sessão, sem custo); "Fora de promoção" é um item da lista; tirar da promoção
  e aplicar preço passam pela prévia; "Adicionar produtos" ainda é o diálogo antigo (AdicionarAoDesconto). Relâmpago, Mercado Livre,
  Amazon e TikTok seguem com a tela antiga abaixo do cabeçalho novo — próximas fases.
  **Fase 2 (21/out) = Relâmpago** (`ShopeeRelampago.tsx`): "Amanhã" = `flashsale_programacao` (editar preço vai pela prévia e grava SÓ na
  programação; estoque/limite/pausar gravam direto; teto = `tetoRelampago` e preço acima dele fica "Aguardando · a Shopee deve recusar";
  motivo da última rodada por SKU vem de `flashsale_criadas.detalhe.problemas`); dias anteriores = `flashsale_criadas` + itens ao vivo
  (`shopee-flashsale?modulo=sale`, só leitura; relâmpago encerrada zera o status de todos os modelos — vale quem tinha preço menor que o
  original). "Programar amanhã agora" e o robô (flashsale_config.automacao_ativa) iguais à tela antiga (Relampago.tsx fica no repo; o
  diálogo AdicionarProduto é exportado de lá).
- **TikTok Shop ACZ — etapa 1, LEITURA (07/out/2026):** edge fn **`tiktok-promocoes`** (deploy 2)
  `?modulo=sync` = catálogo ativo (`POST /product/202309/products/search`, status ACTIVATE) →
  **`tiktok_produtos`** (1 linha por `sku_id`; apaga o que sumiu só se a leitura completou) +
  promoções (`POST /promotion/202309/activities/search`) → **`tiktok_promocoes`** e, das
  ONGOING/NOT_START, os produtos (`GET /promotion/202309/activities/{id}`) → **`tiktok_promocao_itens`**
  (PRODUCT ou VARIATION; `sku_id ''` = produto inteiro). `?modulo=sonda` = respostas cruas. Cron
  **151** `tiktok-promocoes-sync` (`33 10,16,22 * * *`, Bearer publicável) + botão "Sincronizar".
  Margem em **`view_tiktok_produtos_mc`**: preço × (1 − `taxa_pct` − `imp_pct`) − CMV de hoje
  (`cmv_na_data`), com taxa/imposto EFETIVOS de **`view_tiktok_taxas`** (120 d da
  `view_margem_pedido_v2`, marketplace tiktok: taxa = 1 − recebido/venda ≈ 35%, imposto ≈ 10%) e
  vendas 30d de `tiktok_pedido_itens` (1 linha = 1 unidade, sem brinde/cancelado). Medido: 116 SKUs,
  115 com CMV; as 4 promoções da loja estavam EXPIRED — promoção encerrada devolve `products` vazio,
  então o formato dos itens de promoção ATIVA ainda não foi visto ao vivo (conferir no 1º sync com
  promoção rodando). Ids sempre texto (o parse protege números de 16+ dígitos).
- **TikTok — etapa 2, ESCRITA (07/out/2026, autorizada pelo dono):** `tiktok-promocoes` v2 (deploy 3),
  POST com body JSON: `criar` (POST /activities: title, activity_type FIXED_PRICE|DIRECT_DISCOUNT,
  begin/end em segundos, product_level), `editar` (PUT /activities/{id}), `produtos` (PUT
  /activities/{id}/products, lotes de 300: `{id, skus:[{id, activity_price_amount "x.xx" | discount
  "N", quantity_limit, quantity_per_user}]}` — `-1` = sem limite; por PRODUTO o valor vai no produto),
  `remover` (DELETE …/products `{product_ids, sku_ids}`) e `encerrar` (POST …/deactivate, sem volta).
  **Sem `confirmar=1` = prévia** (MC por item calculada na função com taxa/imposto/CMV da
  `view_tiktok_produtos_mc`; bloqueia preço ≥ atual e desconto > 50% sem `forcar`; avisa "sai da
  promoção X"). Com `confirmar=1` exige JWT de usuário (a chave publicável dá 401 — testado), não
  retenta 5xx (POST repetido criaria promoção em dobro), grava em **`tiktok_promocao_acoes`** (enviado,
  resposta, usuário) e relê a promoção para o espelho. Nomes dos campos vêm da biblioteca EcomPHP +
  doc (a página oficial é JS): **o 1º uso real confirma o formato** — se a TikTok recusar, a resposta
  está em `tiktok_promocao_acoes.resposta`. Front: `src/components/promocoes/TikTokAcoes.tsx`
  ("Nova promoção", seleção na tabela → "Adicionar à promoção…" com prévia de margem, expandir a
  promoção → tirar produto, "Encerrar").
- **Amazon — ABA FUNCIONANDO (20/out/2026, opções B + C do dono): `amazon-promocoes` v5 (deploy 8; fonte em
  `supabase/functions/amazon-promocoes/`) + `src/components/promocoes/PromocoesAmazon.tsx`.** Módulos: `catalogo {conta}` (anúncios
  FBA com estoque ou venda em 30 d — `estoque_fulfillment` + `pedido_itens.sku_filho` — com preço cheio e preço de oferta da Listings,
  **taxas reais** da Product Fees API no preço atual (20 por chamada, ~2 s entre lotes), CMV de `view_cmv_efetivo`, MC e preço por faixa
  10/15/17,25/20% = (CMV + taxa fixa) ÷ (1 − comissão% − imposto − MC); imposto = `lojas.aliquota_imposto` ou 10% ACZ / 7,5% SVL, o
  efetivo dos pedidos), `promocoes` (searchPromotions; ACZ 60: 12 descontos de preço rodando, ofertas/cupons encerrados),
  `selecao {promocao}` (itens: `GET /promotions/2025-12-01/promotions/{id}/selections/{selectionId}?revisionId=` →
  `selection.selectionDetails.items[{asin, sku, benefit{type FIXED_PRICE, price}, budget{UNITS}}]`; o `/selections/{id}` solto dá 403),
  `simular`, `oferta` / `remover-oferta` (PATCH `purchasable_offer` com `discounted_price.schedule` — o objeto inteiro é regravado
  mantendo `our_price`; sempre passa no VALIDATION_PREVIEW antes; com `confirmar` exige login — anon = 401 — e grava em
  `debug_fulfillment` `modulo=amazon-promo-preco`). Ensaio 20/out: FBA-15825 a R$ 44,90 (cheio 49,90) = VALID, MC 26,9%. **Nenhuma
  oferta aplicada de verdade ainda.** O preço da PROMOÇÃO (Seller Central) é outra coisa: FBA-15825 está a R$ 42,64 na promoção "BUMI"
  sem ter preço de oferta no anúncio. Atalhos do Seller Central na tela (cupom, oferta relâmpago, promoções) com endereços não
  conferidos. **Achado:** o 15742_FBA (170 vendas em 30 d) está NÃO comprável — "oferta bloqueada pela recusa de faturas: GTIN (cEAN)
  inválido" (Faturador Amazon); a tela mostra esse alerta no topo.
- **Amazon — teste de permissões (07/out/2026), edge fn `amazon-promocoes` v2 (só diagnóstico,
  `?modulo=teste[&conta=acz|svl]`):** Promotions API 2025-12-01 (`marketplaceIds` obrigatório) e
  Pricing v0 **liberadas** nas duas contas (ACZ com PRICE_DISCOUNT/DEAL/COUPON ativos; SVL 0).
  Listings Items exige no path o **Merchant Token** (`A…`), que NÃO é o `oauth_tokens_amazon.seller_id`
  → coluna **`oauth_tokens_amazon.merchant_token`** (ACZ = `AKDVB4QOPSP1V`, informado pelo dono em
  07/out; **SVL ainda falta**). Com ele (v3): Listings LIBERADA na ACZ (498 anúncios; item `FBA-15825`
  com offers) — leitura; escrita de preço promocional (PATCH com `discounted_price`) usa o mesmo papel,
  ainda não testada. `oauth_tokens_amazon_ads` vazio = ADS da Amazon não conectado.
`/promocoes-shopee`, `/promocoes-ml` e `/flash-sale` só redirecionam (links antigos).
Antes: rota **`/promocoes-shopee`** (menu "Promoções Shopee", módulo ads; `?aba=minha|relampago&loja=`),
`/flash-sale` redirecionava para a aba Relâmpago.
- **"Atualizar da Shopee" (06/out/2026):** além da lista de promoções, relê os itens da promoção
  aberta e o **cadastro desses anúncios** (SKU/foto das variações) pela edge fn
  **`shopee-catalogo-itens`**, depois relê os itens. Antes, SKU alterado no Seller Center só aparecia
  depois do catálogo noturno (crons 38/39/141–146, 00h–01h45 BRT, só anúncios não lidos há 24 h),
  e a lista de itens ficava em cache até o F5 (`refetchOnMount: false`).
  **09/out/2026 — produto NOVO:** o botão só relia os anúncios que JÁ estavam na promoção; anúncio
  cadastrado hoje não entrava no espelho e não aparecia no "Adicionar produtos". `shopee-catalogo-itens`
  **v2** `?modulo=recentes&shop_id=&dias=3` lista na Shopee (`get_item_list` por `update_time`,
  NORMAL/UNLIST) o que foi criado/alterado nos últimos N dias e devolve só o que o espelho não tem ou
  tem mais velho; o front relê esses (`sincronizarRecentesShopee` em `promocoes/comum.tsx`). Roda
  sozinho ao abrir o "Adicionar produtos" (cache 10 min) e junto do "Atualizar da Shopee".
  **09/out/2026 — SKU sem custo:** produto cadastrado no Tiny durante o dia só chegava ao cadastro
  na sincronização das 05h (cron 19) e a composição do kit às 07h30 (cron 11) — até lá a promoção
  mostrava CMV/comissão/MC vazios (caso dos kits Bumi Mix 16458–16475, todos 16454 × n). Agora
  `useCustoTinyAutomatico` (`promocoes/comum.tsx`, nas 3 telas: Minha Promoção, Adicionar produtos
  e busca da Relâmpago) pega os SKUs sem CMV, roda a listagem do Tiny se algum nem existe em
  `produtos` (`tiny-sync-produtos?modulo=produtos`, no máx. 1×/10 min, ~9 s) + `detalhar&sku=` de
  cada um (custo e `produto_kits`) e recalcula a margem. Cada SKU é tentado 1× por sessão; o que
  continua sem custo é custo que falta no PRÓPRIO Tiny (a tela avisa).
- **"Adicionar produtos" busca por ID do Item (06/out/2026):** `shopee_anuncios_busca` aceita o
  `item_id` exato; no diálogo, digitar um ID (9+ dígitos) relê ESSE anúncio na Shopee
  (`shopee-catalogo-itens`) antes de listar — anúncio renomeado ou com SKU trocado aparece na hora
  (nome/SKU/preço cheio do diálogo vêm do espelho). Se o ID está em outra campanha e "Só produtos
  sem nenhuma campanha" está ligado, o diálogo avisa em vez de só sumir com ele.
- **Ordenar (06/out/2026):** "Mais vendidos" (vendas 30d, soma das variações — padrão) ou
  "Últimos adicionados". A `get_discount` **não informa quando o item entrou** no desconto, então
  a tela chama a RPC **`promo_itens_vistos(shop, discount, itens)`** a cada leitura: grava a 1ª vez
  que cada item/variação apareceu (`shopee_desconto_item_visto`, só via RPC) e apaga o que saiu
  (re-inclusão conta como nova). Como a tela relê logo após "Adicionar produtos", o horário é
  ~exato; incluído pelo Seller Center = hora da 1ª abertura seguinte. `inicial` = já estava na 1ª
  leitura do desconto (data real desconhecida) → vai para o fim, na ordem da Shopee.
- **Clonar para a Relâmpago (07/out/2026, pedido do dono):** botão ⚡ na 1ª linha de cada
  anúncio da Minha Promoção (só promoção em andamento/próxima) grava **todas as variações** do
  anúncio em `flashsale_programacao` (upsert por shop+item+model, `ativo=true`):
  `preco_promo` = `tetoRelampago(preço promo daqui, menor_preco_7d)` (o maior que a Shopee deve
  aceitar), `preco_original` = o preço promo daqui (base da proteção ≥/50% do `programar`) e
  `estoque_promo` = **1000** (teto do CHECK). A `shopee-flashsale` manda 1000 e, na recusa
  1400101726, reenvia com o saldo real do anúncio (`corrigirItem`). Confirma antes se alguma
  variação fica com MC negativa. Entra na relâmpago de amanhã pelo cron das 18h (se a automação
  da loja estiver ligada) ou pelo "Programar amanhã agora". Selo ⚡ R$ x na linha = já programado.
  ⚠ A `shopee-flashsale` no ar é a **v8** (deploy 20), não v3: `programar` não usa
  `flashsale_config.max_itens_bloco` (1 sale/dia, até 50 itens, completa a existente) e o
  "já está" é por `item_id` inteiro.
- **Relâmpago em dias alternados (12/out/2026) — `shopee-flashsale` v9 (deploy 22; fonte agora em
  `supabase/functions/shopee-flashsale/`):** o clone pelo ⚡ grava `estoque_promo = 1000`; a Shopee
  recusa (1400101726) e a v8 reenviava o estoque **inteiro** do anúncio. A relâmpago do dia ficava
  com tudo reservado (conferido: Bumi Mix 4 kg com `campaign_stock` 999 de 999) e a do dia seguinte
  — montada às 18h07 com a de hoje ainda no ar — era recusada: o produto entrava dia sim, dia não.
  v9: o reenvio manda **metade do estoque livre** = `stock_info_v2.seller_stock` (total do vendedor)
  menos o `campaign_stock` das OUTRAS relâmpagos ativas/programadas (`lerReservas`, lido só quando
  há reenvio; variação com `status` 0 na promoção não reserva). Livre < 1 → problema "estoque todo
  reservado pela relampago em andamento". **Armadilha:** com o anúncio numa relâmpago em andamento,
  `total_available_stock` passa a ser o estoque DA CAMPANHA (ex.: 10), não o total (47) — por isso o
  espelho `shopee_anuncios_variacao.estoque` também cai nesses dias. `?modulo=modelos` mostra os três
  números (`estoque`, `estoque_vendedor`, `reservado_futuro`). Os 9 itens Bumi Mix da SVL ficaram com
  `estoque_promo` ≈ 1/3 do estoque (300/150/100/80/60). O reenvio novo só roda de verdade no cron das
  18h07 — conferir `flashsale_criadas.detalhe.acoes` (`ler-reservas`, `add-retry`) do dia seguinte.
- **Minha Promoção** = módulo **`v2.discount`** da Open API. Edge fn **`shopee-promocoes`**
  (verify_jwt + exige JWT `authenticated`/service role — chave publicável e o Bearer anon dos
  crons dão 401): `list` / `detalhe` / `item-promo` (leitura) e, com `confirmar=1`,
  `atualizar-itens` (update_discount_item: preço promo + purchase_limit no desconto EM ANDAMENTO,
  sem recriar), `add-itens`, `remover-item`, `editar` (em andamento só o fim), `criar`, `encerrar`.
  Front: `src/components/promocoes/MinhaPromocao.tsx` — edição local → prévia "de → para" + MC →
  aplicar. **Write ainda não testado ao vivo.**
- **RPC `promo_mc_base(shop_id, skus[])`**: igual à `flashsale_mc_base` (CMV kit-aware,
  comissão/imposto mediana 60d mono-SKU) + `menor_preco_7d` (menor `subtotal_produto/quantidade`
  vendido em 7 d, por `coalesce(sku_filho, sku_pai)`) + `vendas_30d`. ~3 s.
  **Fix 02/out/2026 (as DUAS RPCs):** `imp_pct`/`com_pct` eram medidos sobre `venda_bruta` (preço
  cheio inflado, ~30–40% acima), mas o imposto incide sobre `venda` e o front aplica o % sobre o
  preço promo → imposto subestimado (ACZ 7,1% × real 10%; SVL 4,1% × real 7,5%) e **MC da tela de
  promoção mais alta que a do Pedidos Integrados**. Base agora = `venda`. Validado: 16246 a
  R$68,03 → tela R$8,12 × pedido real R$8,13. **Percentual de pedido sempre sobre `venda`.**
- **RPC `shopee_anuncios_busca(shop_id, busca, ordem 'vendas'|'recentes', offset, limit)`**:
  `shopee_anuncios.vendas` é SEMPRE nulo no espelho — vendas 30d vêm dos nossos pedidos por
  `sku_pai` (casa 614/617).
- **Comissão Shopee com vigência — `shopee_tarifa`** (+ `shopee_tarifa_vigente(dia)`, padrão
  AMANHÃ; `shopee_comissao(preco, dia)`). Validada nos pedidos (60 d, mono-unidade): <R$80 =
  **20% + fixo por UNIDADE** (2 un = 2× fixo); 80–99,99 = 14% + 16; 100–199,99 = 14% + 20;
  200+ = 14% + 26. **01/10/2026: fixo <R$80 de R$4,00 → R$4,50** (demais iguais). Degrau: R$79,99
  paga 20,50 e R$80 paga 27,20. As ESTIMATIVAS de MC (Minha Promoção + Relâmpago, `calcMc` em
  `promocoes/comum.tsx`) usam a tabela; imposto segue a % efetiva histórica. Pedidos reais (PI,
  Dashboard, DRE) usam a taxa do escrow e já refletem a mudança sozinhos. Nova mudança da
  Shopee = inserir linhas com a nova `vigencia_inicio` (não editar as antigas).
- **Adicionar a um desconto** (`promocoes/AdicionarAoDesconto.tsx`): `shopee-promocoes v3
  ?modulo=em-campanha` (get_item_promotion de todos os anúncios ativos, lotes de 50, orçamento
  24 s) → `shopee_anuncios_busca(..., p_excluir)` tira os que já estão em campanha; preço promo =
  cheio − desconto padrão; filtros de MC (<10, 10–15, 15–20, 20–25, >25%); `add-itens` em lotes de 50.
- **Promoção DIÁRIA (02/out/2026, dono escolheu "uma promoção nova por dia"):** botão "Repetir todo
  dia" no detalhe de um desconto (`promocoes/PromoDiaria.tsx`) grava em **`promo_recorrente`** o
  snapshot `itens` (formato do add_discount_item, preços/limite de AGORA), `hora_inicio` (BRT; padrão =
  1 min após o fim da promoção de origem), `dias_antecedencia` (3) e `primeiro_inicio` (fim da origem —
  não sobrepõe). `shopee-promocoes` **v4** `?modulo=recorrente-programar[&id=][&confirmar=1]` cria um
  desconto por dia ("nome dd/mm", janela 24 h − 1 min) até N dias à frente; idempotente por
  **`promo_recorrente_criadas`** (unique recorrente+dia) + nome existente na Shopee; recusa por item
  vai em `detalhe.falhas`. Único módulo que aceita o Bearer anon (cron **137**
  `promo-recorrente-programar`, `23 9,21 * * *`). Pausar/excluir no painel "Promoções diárias" não
  encerra as já criadas na Shopee. **Write ainda não testado ao vivo.**
  **v5 (03/out/2026) — produto adicionado depois:** os dias futuros são DESCONTOS SEPARADOS já
  criados com o snapshot; adicionar num deles só mexia nele. Agora `add-itens&propagar=1` (o
  "Adicionar produtos" sempre manda) acha a diária do desconto (origem ou `promo_recorrente_criadas`),
  mescla o que entrou no snapshot (`itens`/`n_itens`) e faz `add_discount_item` em cada dia
  programado que ainda NÃO começou (os já começados a Shopee não deixa). Botão "Sincronizar produtos"
  no painel = `recorrente-sincronizar&id=&fonte_discount_id=` (fonte = desconto de hoje) — prévia →
  confirma. **v6 (05/out):** PREÇO/LIMITE também propaga — "Revisar e aplicar" manda
  `atualizar-itens&propagar=1` e o sincronizar compara (`compararComSnapshot` → novos = add,
  alterados = `update_discount_item`). **REMOVER ainda NÃO propaga** (vale só naquele dia).
- **Teto da relâmpago** (`tetoRelampago` em `promocoes/comum.tsx`): `get_item_criteria` da loja =
  `min_discount 1`, `need_lowest_price false`, mas o erro **10014** (acima do menor preço de 7 dias)
  existe e a API não expõe esse piso → teto = min(1% abaixo do preço atual, menor preço vendido
  em 7 d). Estimativa; recusa continua traduzida no histórico.

## 5.9.2 Compras — de-para do fornecedor e estoque no Tiny (01/out/2026)

- **Problema:** fornecedor fatura em FARDO/CAIXA com a descrição DELE (Santa Lucia
  "FARINHA DE MAND. FINA CRUA (4X5) 20 KG" FD; Alfapet "... 5X4KG" 340 FD = 1.700 un do 14758).
  O Tiny às vezes nem vincula o produto (`compras_nf_itens.sku` nulo) e, quando vincula, a qtd
  vem em fardos — lançar o estoque pela NF no Tiny entra errado.
- **`compras_depara_fornecedor`**: (fornecedor_id do Tiny | CNPJ) + `descricao_norm`
  (`compras_norm_desc` = espaços colapsados, trim, MAIÚSCULAS — o front usa a MESMA regra em
  `src/lib/comprasDepara.ts`) → nosso `sku` + `fator` (un do SKU por 1 un da NF). Aprendido no
  recebimento por XML (coluna "Un. por FD/CX" + "lembrar", padrão ligado) nas duas telas
  (`EntradaNfXml`, `NovaEntradaNf`). Pré-carregados: Alfapet ×5 (4 itens) e Santa Lucia
  (4X2)→15984 ×2, (4X3)→15984 ×3. **Faltam** os MYA da Santa Lucia (SKU a confirmar).
- **`view_compras_conciliacao_itens`** converte a NF pelo de-para e SOMA linhas da NF que viram o
  mesmo SKU (antes o FULL JOIN duplicava a qtd da OC em 4 NFs). Baseline: fora dessas 4,
  idêntica ao centavo.
- **Estoque no Tiny = o APP lança, MANUAL** (decisão do dono): edge fn **`compras-estoque`**
  (verify_jwt + exige JWT de usuário) `preview`/`lancar&confirmar=1` → POST /estoque tipo **E** no
  depósito **Geral 604130012** com o **conferido** (`qtd_recebida`, já em unidades), preço = preço
  da OC; kit explodido; linha de OC do Tiny sem produto (`tiny_produto_id<=0`, ex. "[Fardo com 5]")
  fica FORA (aviso) — exceto item `so_na_nf` (criado por `compras_aplicar_nf`, id negativo, é produto de verdade; v2). O de-para também vale no diálogo "Aplicar NF à conferência" (XML e NF do Tiny). Ledger **`compras_estoque_lancamentos`** → relança só o delta; nunca
  estorna. Token Tiny `conta='ottz'`. Botão "Lançar estoque no Tiny" no cabeçalho da OC
  (`LancarEstoqueTiny.tsx`); `compras_ordens.estoque_lancado_em/_por`. **A equipe não deve mais
  lançar estoque pela NF no Tiny** (dobra).
  **v4 (02/out/2026) — SEM conferência liberado (dono):** `&base=nf` usa `coalesce(qtd_nf,
  quantidade)` (OC "NF · app" já está em unidades; OC do Tiny sem NF = qtd pedida, com aviso). O
  diálogo abre direto em "Pela NF" quando nada foi conferido. Ledger grava `lancado_por` + `base`
  (`conferido|nf`); a observação no Tiny leva o nome. O delta vale entre bases (lançar pela NF e
  depois conferir não duplica; conferido MENOR que o lançado só avisa, não estorna).
- **Selos E / C no card do kanban:** E = `compras_ordens.estoque_lancado_em` (só com lançamento
  sem erro); C = `contas_lancadas_em/_por` — gravado pelo `ContasDaNf` ao lançar (nome do
  usuário) ou ao detectar que todas as parcelas já existem no Tiny ("já existiam no Tiny";
  backfill de 02/out marcou 10 OCs por NF casada + `contas_pagar`).
- **Formação de custo (02/out/2026, `FormacaoCusto.tsx`, botão na OC):** o lançamento de estoque
  **NÃO** muda custo no Tiny (nem `precoCusto` nem `precoCustoMedio` — medido) e o app copia
  `precos.precoCusto` do Tiny no sync `tiny-sync-produtos?modulo=produtos` (cron 19, **05:00 BRT**).
  Por isso o custo é gravado NO TINY: `compras-estoque` **v5** `custo-preview` / `custo-aplicar`
  (cálculo no servidor): custo = (valor do SKU na NF + rateio de frete+IPI+ST+outras−desconto,
  por valor ou quantidade, resto do arredondamento no último) ÷ unidades — preço DESTA nota, não
  média. Gravação: `PUT /produtos/{id}` exige `sku`+`descricao` e é PUT — o app faz GET, **reenvia
  todos os campos** (`corpoProduto`) trocando só `precoCusto`, faz GET de novo e compara
  (`assinatura`); se outro campo mudou, **restaura automaticamente** e marca erro. (`PUT
  /produtos/{id}/preco` NÃO aceita custo.) **Pegadinha (v7):** o PUT exige
  `fornecedores[].padrao` não-nulo, mas o GET NÃO devolve `padrao` → 400 "Este valor não deve ser
  nulo". O app manda `padrao: true` no 1º fornecedor (todos os SKUs testados têm 1 só). Só tipo S (variação/kit fica de fora). Em seguida
  atualiza `produtos.custo` na hora. Tabelas `compras_custo_formacao` (extras por OC; `extras`
  jsonb reservado p/ créditos do lucro real) e `compras_custo_itens` (de→para, quem, erro).
  **v6:** despesa MANUAL por unidade por SKU (coluna "+ Despesa un." com motivo, ex. etiqueta
  R$0,40/un) — `&ajustes={"sku":{"valor_un":0.4,"motivo":"etiqueta"}}`, soma DEPOIS do rateio;
  salva em `compras_custo_formacao.ajustes` e `compras_custo_itens.ajuste_unit/_motivo`.
  `custo-teste&sku=` regrava o MESMO custo (diagnóstico). Vendas já feitas mantêm o CMV congelado
  — corrigir período com `/reprocessar-cmv`.
  **v8 (06/out/2026, pedido do dono) — preço da NF com desconto + custo manual.** Até a v7 o
  "Preço NF un." era o **preço da OC** (`compra_ordem_itens.preco × qtd`): a nota não entrava
  (ex.: OC #738, sílica 14,52 na OC × 22,50 na NF 008471; desconto R$ 337,50 e IPI R$ 856,26 da
  nota ignorados). Agora: (1) aplicar a NF grava o **valor líquido por item** em
  `compra_ordem_nf_qtd.valor/desconto` (XML: `vProd − vDesc` da linha; NF do Tiny: `vProd` — a API
  v3 do Tiny só tem `valorDesconto` no cabeçalho, nunca por item); (2) **`compras_nf_aplicada`**
  guarda o cabeçalho da nota (frete, IPI, ST, outras+seguro, `desconto_total`, `desconto_itens` =
  já abatido nas linhas). XML manda pelo `p_totais` da RPC `compras_aplicar_nf` (7º parâmetro,
  default null); NF do Tiny é lida pela formação (`GET /notas/{id}`) e gravada (`lido_em`). A
  "Nova entrada por NF" grava o preço líquido nos itens e o cabeçalho também; (3) a formação usa o
  valor da NF por item quando existe (`origem_preco` nf/oc/misto; linha aplicada antes da v8 =
  `valor` NULL → preço da OC + aviso "reaplique") e, sem formação salva, pré-preenche os extras com
  o cabeçalho (desconto = `desconto_total − desconto_itens`, rateado). Botão "usar os valores da NF".
  NF vinculada mas NÃO aplicada → aviso no topo (preço segue o da OC); (4) **custo manual** por SKU
  (`&manuais={"sku":{"custo":x,"motivo":".."}}`) substitui o calculado; grava
  `compras_custo_formacao.manuais` e `compras_custo_itens.custo_calculado/manual/manual_motivo/
  origem_preco`. Desconto do Tiny rateado por valor pode cair no item errado (ex.: desconto que era
  só da sílica) — aí o operador corrige com o custo manual.

- **Contas a pagar da NF** (botão "Contas da NF" na OC, `ContasDaNf.tsx`): parcelas da NF do Tiny
  (`tiny-contas-pagar` **v7** `?modulo=nf-parcelas&nf_tiny_id=` → GET /notas/{id}.`parcelas`
  {dias, data, valor}) ou do XML (`cobr/dup` → `NfXml.duplicatas`, parse em `src/lib/nfe.ts`).
  Lança cada parcela com `modulo=criar` usando o histórico IGUAL ao do Tiny ("Ref. a NF nº N,
  FORNECEDOR (parcela i/N)"); antes, procura em `contas_pagar` (descrição `NF nº N` + CNPJ) e
  bloqueia parcela já lançada (pelo Tiny ou pelo app). Limite: o espelho `contas_pagar` atualiza
  a cada 15 min — conta lançada no Tiny nesse intervalo ainda não aparece.

## 5.9.3 Fulfillment › Tarefas — contagem de inventário e organização (06/out/2026)

Pedido do dono: além dos envios, a aba Fulfillment ganhou a sub-aba **Tarefas**
(`?tab=tarefas`, `src/components/fulfillment/TarefasTab.tsx`) — quadro A fazer /
Fazendo / Feito, com responsável (`equipe_membros`), prazo (atrasada em vermelho)
e aviso no Discord (canal `fulfilment`, marcando o responsável) ao criar e ao
concluir.
- **Tipos:** `contagem` (lista de SKUs) · `organizacao` e `outro` (descrição +
  checklist jsonb).
- **Contagem:** produtos escolhidos por busca (nome/SKU) + filtros fornecedor /
  marca / categoria / "só com saldo no Geral" (`view_inventario_produtos` =
  simples e variações ativos, saldo do Geral do espelho `estoque_tiny`, foto;
  `view_inventario_filtros`), "selecionar os N filtrados". `qtd_sistema` = saldo do
  espelho NA CRIAÇÃO. Contagem **cega** por padrão (quem conta não vê o sistema).
  Divergência pronta em `view_fulfillment_tarefa_itens.diferenca` e contadores no
  card em `view_fulfillment_tarefas` (LATERAL).
- **Ajuste no Tiny = passo separado, com confirmação** (decisão do dono): edge fn
  **`fulfillment-tarefas`** v1 (verify_jwt + exige JWT de usuário) —
  `ajuste-preview` relê o saldo do Geral AO VIVO (orçamento 20 s, `restantes`);
  `ajuste-aplicar&confirmar=1` faz **balanço tipo B = quantidade contada** no
  depósito Geral 604130012 (relê antes; igual = não lança), grava `ajuste_*` no
  item, atualiza o espelho e avisa no Discord. Depósitos Full nunca são tocados.
  Concluir a tarefa NÃO mexe no Tiny. Sem desfazer automático.
- **Armadilha:** pedido já separado/embalado que ainda não baixou no Tiny está no
  saldo mas não na prateleira — a tela avisa antes do ajuste.
- Tabelas `fulfillment_tarefas` / `fulfillment_tarefa_itens` (RLS off, grant só
  `authenticated`). Localização de prateleira NÃO existe no cadastro (só no
  itens_json dos pedidos) — por isso não há filtro por localização.
- **Fotos (09/out/2026, pedido do dono):** em qualquer tarefa, na criação e no
  detalhe ("Tirar foto" abre a câmera do celular; "Escolher fotos" aceita várias).
  `src/components/fulfillment/FotosTarefa.tsx`. **Sem tabela nem DDL:** ficam no
  bucket privado `fulfillment-docs` (o dos PDFs de envio), pasta
  `tarefas/<tarefa_id>/`, nome `<epoch ms>__<autor>.jpg` (quando/quem); a lista vem
  do próprio Storage (`list`) com URL assinada de 1 h. Reduzidas no navegador
  (lado maior 1.600 px, JPEG 82%) — foto de celular tem 4–8 MB. Excluir a tarefa
  apaga as fotos (melhor-esforço).
- **Só produto simples na contagem (16/out/2026, pedido do dono):** o seletor lê
  `view_inventario_produtos` com `tipo = 'S'` — o pai de variações (tipo V, 228 na data) não
  tem estoque próprio e saiu da lista; kit (K) já não entrava. Nome não decide: "Kit Adestrador"
  (14466) é simples no Tiny e aparece. As contagens dos filtros (`view_inventario_filtros`) ainda
  somam os pais — diferença pequena, só no número ao lado do nome. O diálogo "Nova tarefa" ficou
  largo (`max-w-6xl`, lista de produtos até 60% da altura) e sem rolagem lateral.
- **Visual (09/out/2026, pedido do dono):** o quadro segue o padrão do quadro de
  Envios — resumo no topo (A fazer / Fazendo / Atrasadas / Feitas, borda colorida
  à esquerda), colunas com fundo tingido e cabeçalho na cor da etapa (mesmas cores
  dos STAGES), cartões brancos com faixa da cor da etapa, chips de responsável/prazo
  e **arrastar entre colunas** (soltar em Feito abre a tarefa para concluir).

## 5.9.4 Amazon FBA — em trânsito pelos envios e modelos de caixa (14/out/2026)

- **Problema (relato do dono):** o "Em trânsito" da Reposição somava o `inboundWorking` do inventário FBA
  (envio CRIADO no Seller Central e nunca despachado — SVL: 4 de 19–24/09, ex. FBA19QWH4CD0 = 20 un do 15919)
  e envios `IN_TRANSIT` desde mai/jun com 0 recebido (FBA19DVVNKN0, FBA19G75MBRF, FBA19G7DX9T6,
  FBA19GW2CN5D = 86 un — perdidos ou nunca saíram: cancelar no Seller Central ou abrir caso de reembolso).
- **`fulfillment-sync` v4:** na conta cujo app tem a permissão de envios (Fulfillment Inbound; hoje só a
  **SVL** — app "SISTEMINHA I"), em trânsito = soma de (QuantityShipped − QuantityReceived) dos envios v0 em
  SHIPPED/IN_TRANSIT/DELIVERED/CHECKED_IN/RECEIVING **criados nos últimos 45 dias** (data do nome
  "FBA STA (MM/DD/AAAA …)"; sem data no nome, última atualização). Sem a permissão (**ACZ dá 403** — app
  "Ottz Analytics" sem a função de envios) ou sem tempo: shipped + receiving, sem o working. Detalhe de
  cada rodada (envio contado/ignorado, a caminho por SKU) em `debug_fulfillment` (`modulo='sync-amazon'`,
  `etapa='transito-<shop_id>'`). Medido na 1ª rodada: SVL 15919 21→3, 15983 58→28, 15825_FBA 10→0; ACZ
  FBA-15825 98→78.
- **Modelos de caixa ("packing templates") NÃO têm endpoint** na API (`/inbound/fba/2024-03-20/packingTemplates`
  = 403/inexistente), mas cada caixa de um plano já despachado traz `templateName`, medidas, peso e unidades
  por SKU (`GET /inbound/fba/2024-03-20/inboundPlans/{id}/boxes`). Lidos os 30 últimos planos da SVL: 34 SKUs,
  cada um com UM modelo (ex.: 15919 "Fardo com 2" 30×50×40 8 kg, 170 caixas; 15825_FBA "Fardo com 1"
  20 kg; 15040 "Caixa com 6 un" 20×40×30 4 kg). Dá para montar o cadastro de modelos a partir do histórico.
- **Vendas 30d** na Reposição = `view_reposicao_full.unidades_30d` (canal + conta, só saídas do CD).
- **1º envio pela API — TESTE na SVL (14/out, 21h30, autorizado pelo dono; plano criado e CANCELADO):** edge fn
  **`amazon-inbound`** v1 (fonte em `supabase/functions/amazon-inbound/`), só a conta SVL, repasse de UMA chamada
  da API v2024-03-20 por vez, protegido por chave temporária e prazo (16/out 03:00 UTC); bloqueia confirmar destino,
  transportadora, janelas de entrega; registra tudo em `debug_fulfillment` (`modulo='amazon-inbound-teste'`).
  Sequência que funcionou: `POST /inboundPlans` (msku, quantity, labelOwner SELLER, prepOwner NONE, **expiration**
  — areia exige validade: sem ela a operação falha com FBA_INB_0180 "Expiration date required" e o plano fica
  ERRORED; os envios anteriores do 15919 usaram 2029-10-01) → `POST …/packingOptions` (gera; 1 opção, sem taxa)
  → `POST …/packingOptions/{id}/confirmation` → `POST …/packingInformation` (caixa 30×50×40, 8 kg, 2 un) →
  `POST …/placementOptions` (1 opção, taxa de alocação R$ 0, destino **GRU8 Cajamar**) → parou → `PUT
  …/cancellation` → plano **VOIDED**. Toda escrita devolve `operationId` (assíncrona: acompanhar
  `GET /operations/{id}` até SUCCESS/FAILED). Faltam ensaiar: confirmar destino, transportadora (opções
  USE_YOUR_OWN_CARRIER e AMAZON_PARTNERED_CARRIER aparecem), nota fiscal de remessa e etiquetas das caixas.
- **"Criar envio na Amazon" — na REPOSIÇÃO (14/out, 22h30; 1ª versão no detalhe do envio estava errada,
  apontado pelo dono: os envios só entram em Envios depois de criados na Amazon e com o PDF lançado).** Fluxo:
  Reposição → selecionar produtos → "Montar envio" → no bloco da Amazon, "Criar envio na Amazon"
  (`src/components/fulfillment/PlanoAmazon.tsx`: `PlanoAmazonDialog` + `PlanosAmazonLista`, a lista dos planos dos
  últimos 30 dias no topo da Reposição). **Não cria envio no app**: confirmado o destino, segue no Seller Central
  (transportadora, NF, etiquetas), baixa o PDF e lança em Envios como sempre. Tabelas (migrações
  `amazon_envio_api_modelos` e `amazon_envio_plano_pela_reposicao`): **`amazon_modelo_caixa`** (PK shop_id+msku: sku,
  nome, un_por_caixa, medidas cm, peso_kg, **validade**, origem historico|manual; app lê e escreve) — 34 modelos da
  SVL importados das caixas dos 30 últimos planos, 8 com validade; editor `ModelosCaixaAmazon.tsx`.
  **`amazon_envio_plano`** (id uuid próprio; empresa, `itens_origem` = o que veio da Reposição, plano_id, passo,
  operacao_id, itens, caixas, destinos, envios_amazon, erro, log) — só a função escreve (app só lê).
  **`amazon-inbound` v4** (JWT de usuário + módulo `galpao`): `lista`, `previa` ({empresa, itens} ou {plano}: item →
  anúncio = msku escolhido na tela, senão o único msku do SKU no FBA da conta; modelo; caixas = unidades ÷ un_por_caixa,
  tem de fechar; ACZ = pendência), `avancar` ({empresa, itens, confirmar} cria; {plano} continua: criar → embalagem
  (menor taxa) → caixas por grupo → opções de destino; ~22 s por chamada, a tela repete), `confirmar-destino`,
  `cancelar`. Cada escrita na Amazon uma vez só (passo + operationId gravados logo depois da resposta).
  Labels/prep pelo `items/prepDetails`. Origem fixa: Caieiras. Link "Continuar no Seller Central" =
  `sellercentral.amazon.com.br/fba/sendtoamazon?wf=<plano>` (URL não conferida). **Não testado pela tela** (exige login).
- **1º plano real (19/out, SVL, wf44bb679e, 93 un / 6 SKU, por Renan) TRAVOU no Seller Central:** "Não é possível continuar
  em Enviar para a Amazon… generatePlacementOptions, generateTransportationOptions, confirmPlacementOption e
  confirmTransportationOptions devem ser chamadas". **Regra da Amazon: etapa 2 começada pela API termina pela API** — confirmado
  o destino pelo app, o TRANSPORTE também tem de ser escolhido pela API (a etapa 3, NF e etiquetas, volta a ser no Seller
  Central). A Amazon dividiu em FBA19TPSZTVN (GRU8) + FBA19TPQXVN9 (XCV9), os dois em Cajamar. `amazon-inbound` **v5**
  (deploy 6): `transporte {plano, pronto_em}` = `POST …/transportationOptions` (readyToShipWindow.start = dia às 09:00 BRT)
  + lista por envio em `envios_amazon[].transporte_opcoes` (sem coluna nova; `carrierAppointment` = janela de coleta,
  `quote.cost`); `confirmar-transporte {plano, escolhas: {shipmentId: transportationOptionId}, confirmar}` (só com login; recusa
  opção com `preconditions`). Passos novos `gerar_transporte → gerando_transporte → ler_transporte → escolher_transporte →
  confirmando_transporte → transporte_confirmado`. Opções vistas (pronto em 20/10): por envio, **13 coletas da Total Express
  parceira da Amazon a R$ 0,00** (dias úteis de 21/10 a 09/11, 09h–18h em Caieiras) + 5 por nossa conta (Self caixas/palete,
  Other caixas/palete, "Total Express – Tex Courier" contratada). Tela: no plano (Reposição › envios criados pelo app),
  "Cotar transporte" com a data → opções agrupadas (coleta parceira / por nossa conta), "em todos" repete a escolha nos
  envios, "Confirmar transporte" com confirmação. `transporte`/`previa` aceitam a chave publicável até 20/out 03:00 UTC
  (rota de ensaio). **Daqui em diante todo plano criado pelo app precisa passar pelo transporte no app.**
- **Aba sem recarregar = "carregando eternamente" (19/out):** o dono abriu o plano numa aba de ANTES do deploy; a tela velha não
  conhecia `escolher_transporte` e o "Continuar" repetia 16 chamadas por clique (vistas nos logs, nada mudou na Amazon).
  Recarregar resolveu; o dono confirmou a coleta Total Express parceira em 21/10 para os dois envios.
- **v6 (deploy 7) — envio nasce na aba Envios:** `envios-app {plano, dry?}` (automático na tela ao chegar em
  `transporte_confirmado`; botão para refazer). Um `fulfillment_envios` por envio da Amazon (numero = FBA…, centro = CD,
  status `separando`, `data_envio_agendada` = dia da coleta, itens de `listShipmentItems`: sku pelo plano, `sku_origem` = msku)
  + anexos: **etiquetas das caixas** (v0 `getLabels` PackageLabel_Thermal, UNIQUE, `PackageLabelsToPrint` = boxIds de
  `listShipmentBoxes`; o link vale 15 s) e **etiquetas de produto** (`POST items/labels`, THERMAL 50×25 mm, itens com
  labelOwner SELLER). Idempotente (envio pelo número FBA, anexo pelo nome); `envios_amazon[].envio_app_id`. Ensaio `dry` no
  wf44bb679e: 6 + 24 caixas, PDFs de 92/364 kB e 63/46 kB. **Não rodado de verdade** (precisa de login).
- **Nota de remessa:** quem emite hoje é a PRÓPRIA Amazon (regime especial, Portaria CAT 31/2019; DANFEs anexados: SVL série 5
  emitente BMPC, ACZ série 25; "Outras Saídas - Remessa para Depósito Temporário", CFOP 5949, transportadora preenchida). Pela
  API = Invoices `POST /tax/invoices/2024-06-19/governmentInvoiceRequests` {inboundPlanId, shipmentId, marketplaceId,
  transactionType INBOUND_SHIPMENT, invoiceType REMITTANCE} + `GET …/governmentInvoiceRequests/{shipmentId}` (documento). Exige o
  papel **Tax Invoicing (Restricted)** — 403 nas duas contas; o dono vai pedir para o SISTEMINHA I. A API de envios (v0 e
  2024-03-20) não tem campo de nota. Emitir pelo Tiny foi descartado (fora do regime especial, duplicaria).

- **ACZ LIBERADA (20/out/2026, pedido do dono "liberar tudo do Full Amazon"):** o app da ACZ ("Ottz Analytics") ganhou o papel de
  envios — a leitura v0 dos envios da ACZ respondeu pela 1ª vez no sync das 8h05 de 20/out (21 envios, 13 nos 45 dias), então o
  em trânsito da ACZ na Reposição passou a vir dos envios reais. `amazon-inbound` **v8** (deploy 10; idêntica ao repositório antes da
  troca): tirada a pendência fixa "por enquanto só a SVL" da prévia; módulo **`modelos-importar {empresa, planos?, dry?}`** lê as caixas
  dos planos SHIPPED (`listInboundPlans` + `/boxes`) e propõe um modelo por anúncio com a caixa mais usada (só caixas de um anúncio;
  validade = a mais recente; nunca mexe em modelo existente). Lê ~15 planos por chamada (22 s), sempre os mais recentes — a tela
  (`ModelosCaixaAmazon`, botão "Importar dos envios anteriores") roda a prévia e grava ela mesma o que a prévia mostrou (upsert
  ignorando os que já existem). Prévia de 20/out na ACZ: 60 planos, 15 lidos, 16 modelos novos (2 já existiam); vários de AREIA sem
  validade (15742_FBA, 15627, 15825…) — preencher antes de criar plano, a Amazon recusa areia sem validade. Ensaio sem login até
  22/out 03:00 UTC só em `previa`, `amazon-envios`, `recebimento` e `modelos-importar` dry (o `transporte`/`envios-app` saíram do ensaio).
  Prévia de envio ACZ (15987 ×10 + 15820 ×24) sem pendência. **Nenhum plano real da ACZ criado ainda.**
- **1º plano da ACZ recusado (20/out, 23h32 BRT, 12 SKU):** "DF-CLWD-07BZ requires prepOwner but NONE was assigned". Causa: o
  `items/prepDetails` era chamado com `mskus=a&mskus=b…` e a **Amazon só lê o 1º** — os outros 11 iam com o padrão prepOwner NONE.
  O certo é **`mskus=a,b,c`** (até 100 por chamada). `amazon-inbound` **v8.1** (deploy 11, conferido por sha256). Nenhum plano foi
  criado na Amazon (a recusa foi na criação). O Xô Gatinho 500 ml (DF-CLWD-07BZ) é **LIQUID** com prep **SELLER_ONLY**
  (etiqueta + **saco plástico** por unidade): no envio, cada frasco vai ensacado. Os outros 11 do plano: só etiqueta (prep NONE).
  No SVL a falha não apareceu porque nenhum item precisava de prep.
- **"A enviar" já em caixas fechadas (21/out, pedido do dono):** na Reposição, linha da Amazon com modelo de caixa
  (`amazon_modelo_caixa` por conta + SKU; `src/components/fulfillment/CaixaReposicao.ts`) abre com a sugestão no múltiplo
  mais próximo de `un_por_caixa` (mínimo 1 caixa; desce uma caixa se passar do disponível no Tiny) e mostra "N cx de U";
  digitado fora do múltiplo fica âmbar ("não fecha caixa de U"). A coluna Sugestão continua o número cru da view. SKU com
  dois anúncios de modelos diferentes fica sem arredondar. ML/Shopee não têm modelo de caixa.
- **"Transporte confirmado" no app × Seller Central (21/out, FBA19TZFT26Z, ACZ):** a API mostrava o envio com
  `selectedTransportationOptionId` (coleta Total Express, janela 23/10) e um rastreio AMZC… por caixa logo depois da
  confirmação, status v0 `WORKING`; o dono não via data nem NF no Seller Central. A NF de remessa é a etapa 3 (Seller
  Central) e o status só sai de WORKING depois dela. **A reserva da coleta é um passo à parte no Seller Central**
  ("Reservar agendamento da transportadora", depois da NF): a data escolhida pela API é só a preferência e pode estar
  esgotada lá (23/10 estava; 28–30 livres). A tela do plano passou a dizer isso.
- **NF de remessa importada sozinha (21/out, pedido do dono) — `amazon-inbound` v9 (deploy 12, sha256 conferido):** os
  apps das DUAS contas já têm o papel de notas (em 19/out dava 403). `GET /tax/invoices/2024-06-19/governmentInvoiceRequests/
  {shipmentId sh…}?marketplaceId&transactionType=INBOUND_SHIPMENT&invoiceType=REMITTANCE&inboundPlanId=wf…` (sem o
  `inboundPlanId` = 400) devolve um link de 10 s para o **XML** da NF-e (não há PDF). Módulo `nf-remessa {plano?, dry?}`:
  anexa o XML no envio da aba Envios (tipo `danfe`, `NF remessa <nº>-<série> <FBA>.xml`), grava `envios_amazon[].nf`
  (número, série, chave, emissão, valor, emitente) e escreve a nota na observação do envio; sem nota ainda = `nf_erro` e
  nova tentativa em 25 min. Cota ~1 consulta/min (5 s entre duas = 429): o cron **169** `amazon-nf-remessa`
  (`6-56/10 * * * *`, chave publicável — o módulo aceita anon) faz UM envio por rodada; o botão "Buscar NF agora" do plano
  tenta os envios dele. Só envios criados pelo app (plano com `sh…`/`wf…`); importados do Seller Central não têm esses ids.
  1ª rodada: ACZ FBA19TZFT26Z NF 7541/25 (R$ 1.297,40, emitente ACZ PET); SVL FBA19TPSZTVN NF 6320/5 e FBA19TPQXVN9 NF
  6321/5 (emitente BMPC). A emitente é a própria empresa (regime especial da Amazon emite em nome dela).
- **DANFE em PDF + coleta reservada (21/out, `amazon-inbound` v10, deploy 13, sha256 conferido dos dois arquivos):**
  `supabase/functions/_shared/danfe.ts` (pdf-lib via esm.sh, sem dependência de Deno) monta o DANFE A4 a partir do XML —
  canhoto, emitente, chave com Code 128C (conferido igual ao jsbarcode), natureza/protocolo, destinatário, impostos,
  transportador/volumes, produtos com folhas extras, dados adicionais (infAdFisco + infCpl + pedido); `infAdProd` vai na
  descrição. Anexado como `DANFE <nº>-<série> <FBA>.pdf` junto do XML; nota já importada sem PDF ganha o PDF na rodada
  seguinte (lê o XML do Storage). Deploy leva os DOIS arquivos (`index.ts` + `../_shared/danfe.ts`). **Reserva da coleta
  NÃO existe na API para a transportadora parceira**: `generateSelfShipAppointmentSlots` recusa ("Selected carrier was not
  self-ship carrier") — é só para transportadora própria. Mas depois de reservada no Seller Central, a opção de transporte
  escolhida devolve o dia em `carrierAppointment` (`GET …/transportationOptions?shipmentId=`): a rodada relê (até 3 envios,
  a cada 3 h por envio) e grava `envios_amazon[].coleta` + `fulfillment_envios.data_envio_agendada`. Lido em 21/out:
  FBA19TZFT26Z 30/10, FBA19TPSZTVN 21/10, FBA19TPQXVN9 29/10.
- **Encaixotamento no próprio envio (22/out, `amazon-inbound` v11, deploy 14, sha256 conferido; pedido do dono: a "folha
  da remessa" do Seller Central só serve para a equipe saber como montar as caixas, não precisa de PDF):** `listShipmentBoxes`
  (nome "P1 - B13", ID, peso, medidas, conteúdo por msku) + `listShipmentItems` (ASIN, FNSKU, validade, `prepInstructions`)
  → `envios_amazon[].encaixotamento`, gravado no `envios-app` e, para envio que ainda não tem, na rodada do `nf-remessa`
  (cron 169; até 3 por rodada, com `plano` todos). Tela: cartão "Encaixotamento (Amazon)" no detalhe do envio em
  Fulfillment › Envios (`src/components/fulfillment/EncaixotamentoAmazon.tsx`, envio FBA ainda não enviado): caixas iguais
  agrupadas (quantas, o que vai em cada, medidas, peso, nomes "B1–B26"), alerta âmbar para preparo além da etiqueta (saco
  plástico, bolha…), FNSKU/validade por item e botão "Ler da Amazon". Envio importado do Seller Central (sem plano do app)
  não mostra o cartão. Preenchido em 22/out: FBA19TZFT26Z 26 cx (= folha da Amazon), FBA19TPQXVN9 24, FBA19TPSZTVN 6.

## 5.9.4.1 Mercado Livre Full — criar envio pela API? NÃO (testado 19/out/2026)

- Existe a API **Inbound FBM** (`POST /marketplace/fbm/inbounds` {items:[{user_product_id, quantity}]} → 202 + `process_id`;
  `GET /marketplace/fbm/inbounds/process/{id}` → `inbound_id` + link para o vendedor AGENDAR no painel do ML), mas a doc diz
  "só para vendedores do Fulfillment China". Teste com produto INEXISTENTE (nada criado) nas duas contas: **403
  `unauthorized_user` — "The seller is not authorized to access this workflow."** (lista vazia dá 400 antes da checagem do
  vendedor, não serve de teste). Não há leitura de inbound (`/inbounds/{id}` 403 nginx, demais 404).
- O que a API dá: estoque (`/inventories/{inventory_id}/stock/fulfillment`) e operações
  (`/stock/fulfillment/operations/search?seller_id&inventory_id`) — SVL ok; na Ottz, anúncio antigo do Full vem sem
  `user_product_id`/`inventory_id` no `/items` (14 de 20 da amostra têm). NF de inbound (Matriz → armazém ML) só para quem usa o
  emissor do ML: `/users/{id}/invoices/sites/MLB/batch_request/period/stream?...&full=inbound` (não testado).
- Sonda: `ml-anuncio-sonda` v6 (deploy 7) `?teste=inbound&conta=ottz|svl` (expira 21/out).

## 5.9.4.2 Estoque do Full do ML ficava até 1,5 dia velho (19/out/2026)

Relato do dono: "problema com atualização dos estoques fulfillment". Nenhuma rodada falhava. O `fulfillment-sync?modulo=ml`
lia só 120 anúncios por rodada, um por vez (~0,35 s cada), e o cron 61 roda 2×/dia — com 374 anúncios no cache, cada um era
relido a cada ~1,5 dia, e o botão da tela relia só ~60 (tempo). Ex.: 14560 aparecia com 0 no Full tendo vendido 6 pelo Full
depois da última leitura (32 h antes). **v5 (deploy 20):** lê os estoques por `inventory_id` único (270 para 374 anúncios —
catálogo e anúncio normal dividem o estoque), 6 em paralelo, grava `estoque_fulfillment` e o carimbo de `ml_full_itens` em
lote; quem vendeu pelo Full depois da última leitura vai primeiro. `limite` (cron e tela mandam 120) é ignorado; `max=N`
limita. 1ª rodada: 270/270 em 38 s, sem erro. Amazon e Shopee já liam tudo a cada rodada. Shopee SBS quase vazio na data
(Ottz 5 un, Bumi 0) é real — as vendas pelo Full da Shopee caíram a ~0 desde 15/out.

## 5.9.4.3 Reposição: margem de contribuição pelo Full × fora dele (19/out/2026)

Pedido do dono: saber se vale mandar mais ao Full. Coluna **"MC 30d Full"** na Reposição
(`src/components/fulfillment/MargemFull.tsx`): MC% das vendas que saíram do Full/FBA nos últimos 30 dias
naquela conta, R$/un e, embaixo, a MC das vendas FORA do Full (coleta, agência, Flex) para comparar; a
tooltip diz se o Full rende ≥ 3 pp a mais ou a menos. Fonte: **`mv_reposicao_margem_30d`** (shop_id × sku
= mesma chave `pi.sku_pai` da `view_reposicao_full`): margem da `view_margem_pedido_v2` (recebido − CMV −
imposto) rateada pelos itens do pedido pelo `subtotal_produto`, só `cobertura_cmv = 'completo'`, Full =
`modo_envio 'Full'` ou `logistica_tipo` fulfillment/FBA. **Sem ADS e sem armazenagem do Full.** Calcular ao
vivo custa 3,3 s → matview com índice único, cron `reposicao-margem-30d` (`41 9,15 * * *`, refresh
concurrently), grant só `authenticated`. Medido na criação: 15984 ML Ottz 7,6% pelo Full × 13,1% fora;
15704 e 16080 (SVL) negativos no Full.

## 5.9.4.3 ROAS objetivo das campanhas do ML pela API — sem permissão de escrita (19/out/2026)

Pedido do dono: subir o ROAS objetivo da campanha "Kit 2 Bumi l Escmectita" (359638251) de 6,5 para 7. `ml-sync-ads`
**v7** `?modulo=roas-alvo&campanha=&roas=` (só a campanha/valor de `ROAS_LIBERADO`, expira 21/out; lê antes, envia uma vez,
lê depois; tentativas em `debug_fulfillment` `modulo=ml-ads-roas`). O ML recusou na 1ª chamada — `PUT
/marketplace/advertising/MLB/product_ads/campaigns/{id}` (Api-Version 2, corpo `{roas_target: 7}`) → **401 "User does not
have permission to write."** (`mclics.campaigns.exceptions.UnauthorizedException`); nada mudou (antes e depois 6,5 / ACOS
15,38). **Não é o app nem o token:** o DevCenter já tem "Publicidade de um produto" em Leitura e escrita e o token da Ottz já traz
`urn:ml:mktp:ads:/read-write`. Os 4 caminhos válidos (`/marketplace/advertising/MLB/product_ads/campaigns/{id}` v2 com `roas_target`
e com `acos_target`, `/advertising/product_ads/campaigns/{id}` v1 e v2) dão o MESMO 401 do serviço do Mercado Ads (`mclics`); o
caminho com `advertisers/{id}` dá 404. Reautorizar não muda nada. A recusa é do lado do ML (escrita em campanhas não liberada para o
nosso app/conta) — caminho: chamado no suporte de desenvolvedores do ML; até lá, ROAS objetivo só pelo painel do Mercado Ads. A leitura (campanhas, métricas, `roas_target`/`acos_target` = 100 ÷ ROAS) já funciona.

## 5.9.4.4 Shopee Ads — meta de ROAS, orçamento e impulsionado (20/out/2026)

Pedido do dono: mostrar a meta de ROAS de cada anúncio, se está impulsionado, e alterar meta e orçamento pelo sistema.
- **Edge fn `shopee-ads-gestao` v2 — publicada no slot `shopee-flashsale-probe`** (o projeto bateu o LIMITE DE FUNÇÕES do plano:
  criar função nova dá "Max number of functions reached"; o slot era uma sonda de agosto sem cron nem front). Fonte em
  `supabase/functions/shopee-ads-gestao/`. Módulos: `sonda` (cru), `config {loja, campanhas}` e `editar`.
- **Leitura (conferida nas duas lojas):** `ads/get_product_level_campaign_setting_info` (`info_type_list 1,3`) → `common_info`
  (`ad_type`, `bidding_method`, `campaign_status`, `campaign_budget` — **0 = sem limite**) e `auto_bidding_info.roas_target` (a meta
  de ROAS; todas as nossas campanhas são "manual" com lance automático). `product/get_boosted_list` = impulsionados agora (vazio nas
  duas em 20/out). `ads/get_total_balance` e `ads/get_shop_toggle_info` = saldo de ADS e recarga automática.
- **Escrita:** `POST ads/edit_manual_product_ads` (documentado) `{reference_id aleatório, campaign_id, edit_action change_budget|
  change_roas_target, budget|roas_target}`. Prévia sem `confirmar`; com `confirmar` exige login (chave publicável = 401), manda cada
  troca uma vez, para no 1º recusado, relê e grava em `debug_fulfillment` (`modulo shopee-ads-editar`). Campanha `ad_type auto`
  não é editável (a doc não tem edit_auto_product_ads). **Nenhuma alteração real feita ainda** — o 1º uso pela tela confirma se o app
  tem permissão de escrita nas ADS.
- **Tela `/ads-shopee`:** coluna **Meta ROAS** (âmbar quando o ROAS do período está abaixo da meta) com lápis → diálogo Conferir →
  Aplicar na Shopee (com confirmação); Orç. diário passa a ser o valor ao vivo; selo **impulsionado** no anúncio; saldo de ADS por
  loja acima da lista. Só a página visível é lida (`src/components/ads/ShopeeAdsConfig.tsx`).

- **Histórico de configuração (20/out, opção A do dono):** nenhum marketplace dá histórico de alterações de ADS pela API
  (Shopee: lista oficial das 25 APIs de ADS, nenhuma de log; ML: só a config atual). E a API diária da Shopee
  (`get_product_campaign_daily_performance`) NÃO traz meta nem orçamento por dia — conferido na resposta crua de 14/10
  (campanha 74740543: impression, clicks, ctr, expense, broad/direct gmv/order/roi/cir, cr, cpc, cpdc). Por isso nós fotografamos:
  tabelas **`ads_config_atual`** (PK mkt+shop+campanha; `primeira_vez`, `visto_em`) e **`ads_config_historico`** (campo
  roas_target|budget|status|bidding_method, de→para, `desde`/`ate` = janela em que mudou, `origem` externo|app, `quem`), RPC
  **`ads_config_registrar(mkt, shop, lista, origem, quem)`** (só service_role). Shopee: `shopee-ads-gestao` v3 `?modulo=capturar&loja=`
  (TODAS as campanhas: Ottz 1.109, SVL 569 na 1ª captura), crons **164** `ads-config-capturar-ottz` `11 */2` e **165** `…-svl` `23 */2`
  (Bearer publicável); `editar` registra com origem `app` + nome. ML: gatilho `ml_ads_campanha_historico` em `ml_ads_campanha` (o
  ml-sync-ads regrava a cada 6 h; ADS do ML = só Ottz 1107117809). Ponto de partida = 20/out ~16h; antes disso a meta do dia é
  "sem registro". O orçamento por dia de antes existe aproximado em `shopee_ads_campanha.budget` (os últimos ~4 dias são regravados
  com o valor atual, então a data da mudança pode sair adiantada) e em `ml_ads_campanha_diario.budget/acos_target`. SQL em
  `docs/ads-config-historico.sql`. `?modulo=desempenho-cru&loja=&campanha=&de=DD-MM-YYYY` = resposta crua do dia.
- **Análise por anúncio (20/out):** RPC **`ads_analise_anuncio(shop, campaign, dias)`** (security definer, authenticated; SQL em
  `docs/ads-analise-anuncio.sql`): por dia investimento, receita e pedidos do ADS (`shopee_ads_campanha`, gmv amplo = a mesma
  base da tela), ROAS, meta/orçamento VIGENTES no dia (do histórico), uso do orçamento, e venda total + margem pós-ADS do item
  (`ads_metrica_anuncio_dia`); margem sem ADS de 30 d (`ads_margem_anuncio`) → **ROAS de equilíbrio = 100 ÷ MC%** e meta mínima
  = equilíbrio × 1,15; efeito de cada mudança (7 d antes × 7 d depois); diagnóstico (regras no banco): sem margem sem ADS · meta
  abaixo do equilíbrio · prejuízo em 7 d · gasto sem venda (≥ R$ 15) · ROAS < 80% da meta · orçamento esgotando ≥ 3 de 7 dias com
  ROAS bom · ROAS ≥ 1,3× a meta gastando pouco (baixar a meta) · receita ±30% · sem margem calculada · histórico começando. Tela:
  clicar no nome do anúncio em `/ads-shopee` abre `src/components/ads/AnaliseAnuncioAds.tsx` (gráfico investimento/receita/ROAS/
  meta/equilíbrio, alterações, tabela por dia). Só Shopee; ML fica para depois. Ex. 20/out: Kit Adestrador meta 19,5 × ROAS 11,8 em
  7 d, equilíbrio 5,3 (MC 18,8%) — lucrativo, mas a Shopee não entrega a meta.
- **Desempenho para trás (20/out, pedido do dono):** a API diária da Shopee aceita até **6 meses para trás e no máximo 1 mês
  por consulta** (erros `error_date_too_old` / `error_date_range_too_long`); o ML recusa > 90 dias (já temos mais do que isso).
  `shopee-ads-gestao` **v4** `?modulo=historico-desempenho&loja=&de=&ate=[&loja_total=1]` grava `shopee_ads_campanha` (orçamento e
  status em branco) e, com `loja_total`, `shopee_ads_diario` — os dois com `ignoreDuplicates` (nunca sobrescreve). Armadilhas: o
  PostgREST corta em 1.000 linhas (a Ottz tem 1.109 campanhas — a lista é paginada) e campanha que não é de anúncio de produto
  (ex. 20662003) faz a Shopee recusar o lote de 100 inteiro (`invalid product ads campaign ids-`): tirada e o lote refeito.
  Feito em 20/out: campanhas 21/abr→03/jul nas duas lojas (Ottz +4.990 linhas, SVL +4.164) e total da loja 21/abr→15/jun.
  **O DRE mudou nesses meses** (`view_dre_ads_marketplace` lê `shopee_ads_diario`): ADS Shopee abr ACZ 0→4.977,60 / SVL 0→3.612,47;
  mai ACZ 0→21.491,34 / SVL 0→9.765,55; jun ACZ 10.645,80→23.058,48 / SVL 5.521,11→9.604,61 (jun só tinha a 2ª quinzena);
  jul em diante igual. Baseline em `_bkp_ads_antes_20out`. As campanhas somam 85–92% do total da loja (o resto é ADS que não é
  anúncio de produto), a mesma proporção de julho.
- **Período vale para a tela toda (20/out, relato do dono: "os totalizadores não mudam quando mudo a data"):** cartões por
  classificação, KPIs, tabela e bolhas liam `view_ads_anuncios`/`view_ads_resumo`, FIXAS em 30 dias; só o gráfico de barras seguia o
  período. Agora RPC **`ads_shopee_painel(de, ate, empresa, classif[], faixas inv/roas/acos, status, tem_gasto, busca, ordem, dir,
  offset, limit)`** (security definer, authenticated; SQL em `docs/ads-shopee-painel.sql`) devolve `total`, `linhas` (página),
  `resumo` (por classificação, só com gasto, como a view_ads_resumo) e `bolhas`; status/orçamento = `ads_config_atual` (senão o
  último registrado no período). Validado: com os últimos 30 dias bate com as views antigas (186 anúncios, resumo idêntico, mesma
  ordem). 6 meses = 1,2 s. Índice novo `shopee_ads_campanha_data`. Tela: o filtro de data (`DashboardPeriodFilter`, o mesmo do ADS
  ML; `?period=&from=&to=`, padrão 30 dias) foi para o topo; o "Período (gráfico)" saiu. As views antigas seguem (outras telas).
- **Análise por anúncio — Mercado Livre (20/out, pedido do dono):** RPC **`ads_analise_anuncio_ml(p_item, p_campaign, p_dias)`**
  (SQL em `docs/ads-analise-anuncio-ml.sql`), mesmo formato da Shopee: com `p_item` (MLB) = série do anúncio (`ml_ads_anuncio_diario`,
  desde 07/jul); só `p_campaign` = campanha inteira (`ml_ads_campanha_diario`, desde 06/jul). Receita = `vendas_total` (diretas +
  indiretas, a base da tela /ads-ml). Meta (ROAS = 100 ÷ `acos_target`) e orçamento são da CAMPANHA: histórico capturado desde 20/out e,
  antes, o REGISTRO DIÁRIO da campanha (`ml_ads_campanha_diario.acos_target/budget`, marcado `meta_aproximada`/≈ — o cron 81 regrava os
  últimos 8 dias com a config do momento, então a troca aparece até ~8 dias antes; ex. BUMI MANDIOCA 6,8→7,2 aparece em 09/10). Margem
  = do SKU (`ml_anuncios.sku`; o ML não liga venda a MLB): MC sem ADS 30 d de `ads_margem_anuncio` nivel sku e venda/margem diária do
  SKU em `ads_metrica_anuncio_dia` (margem − ADS da linha). Diagnóstico com as mesmas regras (ação "no painel do Mercado Ads" — a API
  recusa escrita) + orçamento esgotando pelo gasto da CAMPANHA. Tela: em /ads-ml, campanha aberta → "Análise da campanha" ou clique
  no nome do produto; componente `AnaliseAnuncioAds` com prop `ml`. Achados em 20/out: MLB4908814821 (Areia Bumi 4kg, SKU 15984) margem
  10,2% → equilíbrio 9,8 × objetivo 7,2 e ROAS 6,15 em 7 d (R$ 1.079 investidos, no prejuízo); DILICAT (15919) margem 1,3%.
- **Filtro de período acima da lista + situações (20/out, noite, pedido do dono):** o filtro de data saiu do topo e foi
  para o cartão "Período e situação", logo acima da lista (onde ficava o aviso de ACOS, que virou uma linha dentro dele).
  `ads_shopee_painel` ganhou `p_situacao` (18º parâmetro; a de 17 foi removida — sem ele o resultado é idêntico ao de antes,
  conferido por md5 em 30 dias) e devolve `situacoes` (contagem), `limiares` (medianas) e, por linha, `situacoes[]`, `meta`,
  `roas_equilibrio`. Situações: `escalar` (ROAS excelente/bom e cliques abaixo da mediana), `clique_sem_conversao` (cliques acima da
  mediana e ROAS ruim), `ctr_baixo` (impressões acima da mediana e CTR < 60% da mediana), `gasto_sem_venda` (≥ R$ 10 sem pedido),
  `abaixo_meta` (ROAS < 80% da meta de hoje), `prejuizo` (abaixo do equilíbrio da `ads_margem_anuncio`), `orcamento_limitando` (≥ 3 dias
  com gasto ≥ 90% do orçamento e ROAS bom). "Poucos/muitos" é RELATIVO à loja no período (mediana dos anúncios com gasto), não
  número fixo. Na tela: chips com contagem e a regra no tooltip; selos de situação na linha (clique filtra). SQL em
  `docs/ads-shopee-painel.sql`. 30 dias até ontem: 20 escalar, 36 clique sem conversão, 6 CTR baixo, 3 gasto sem venda, 44 prejuízo,
  160 abaixo da meta (de 185).
- **"Impulsionando" das campanhas de ADS NÃO vem pela API (conferido 20/out):** o selo da Shopee na campanha 116316230 (Areia Bumi Pet
  8kg a 20kg [2], Ottz) não aparece em nenhum campo de `get_product_level_campaign_setting_info` (info 1–4, idêntico ao de uma campanha
  sem o selo) e `product/get_boosted_list` veio vazio. É o impulso de produto NOVO do GMV Max ("New Product Boost"), que não tem
  endpoint na API v2 de ADS. O selo "impulsionado" da tela é só o "Impulsionar" de Meus Produtos (5 vagas, 4 h).
- **Funções apagadas pelo dono (20/out):** `tiny-test-produto`, `ml-test-wallet`, `fulfillment-teste`, `svl-probe`. O código de 15
  sondas antigas sem uso ficou em `docs/funcoes-apagadas/` (as outras 11 seguiam no ar na conferência).

- **Agente de ADS com metas (20/out/2026, noite):** **`ads_metas_situacao(p_ref default ontem)`** (fonte em
  `docs/ads-metas-situacao.sql`) = todas as campanhas com gasto ≥ R$ 5 em 7 dias (Shopee por campanha/anúncio, ML por
  campanha) com meta/orçamento de `ads_config_atual` (ML sem registro = `100 ÷ acos_target` do registro diário), MC sem
  ADS 30 d (`ads_margem_anuncio`; ML = SKUs da campanha), ROAS de equilíbrio, meta mínima (×1,15), `perda_7d`, `tom`,
  `problemas` e `sugestao` prontos; top 40 em `itens`. Meta JÁ acima do equilíbrio com ROAS real abaixo NÃO sugere subir
  a meta (só corta alcance): pausar ou rever preço/anúncio — regra igual nas duas análises por anúncio (migração
  `ads_sugestao_meta_ja_alta`). O `ads_relatorio_diario` ganhou **`metas`** e **`alteracoes_config`**
  (`ads_config_historico` com `ate` nos últimos 7 dias; `quando` = `ate`) — migração `ads_relatorio_metas`. Card
  `RelatorioAds` mostra a seção "Metas de ROAS" + alterações; skill `agentes/agente-ads/SKILL.md` atualizada (o agente
  segue sem executar nada — nem a troca de meta da Shopee, que é do dono pela tela). 1ª leitura (19/out): 127 campanhas,
  28 ruins, 14 com meta abaixo do equilíbrio, perda estimada R$ 930 de R$ 7,8 mil em 7 d; pior = ML "BUMI MANDIOCA l 4kg"
  (objetivo 7,2, ROAS 6,1, equilíbrio 9,9).
- **Análise com filtro de data (20/out):** `ads_analise_anuncio` / `_ml` aceitam `p_de`/`p_ate` (e `p_sem_anterior`
  interno); `resumo.periodo` e `resumo.anterior` (mesmo nº de dias logo antes). O diálogo abre no período da tela que o
  abriu e tem o próprio filtro; o diagnóstico continua sendo dos últimos 7 dias. Migração `ads_analise_com_periodo`
  (a fonte em `docs/ads-analise-anuncio*.sql` é a de antes do período — vale o que está no banco).
- **Mudanças do anúncio na análise de ADS (20/out, pedido do dono):** além de meta/orçamento, a lista de alterações da análise
  por anúncio (Shopee e ML) mostra o que o SISTEMA enviou ao anúncio (`ia_publicacao`: criado, fotos — "N novas do sistema, M
  mantidas" —, título, descrição, preço cheio; "pelo sistema (quem)") e o que o RETRATO DIÁRIO viu mudar (`ads_anuncio_snapshot`:
  preço de venda, entrou/saiu de promoção, situação; desde 05/out), cada um com ADS 7 dias antes × depois. Função
  **`ads_mudancas_anuncio(mkt, shop, itens[])`** (`docs/ads-mudancas-anuncio.sql`), juntada às duas análises pela migração
  `ads_analise_mudancas_anuncio`; no ML com anúncio escolhido o antes/depois é do anúncio (`ml_ads_anuncio_diario`). Mudança
  feita direto no Seller Center/painel do ML só aparece se mexer em preço, promoção ou situação (o retrato não guarda fotos/texto).
- **Promoções Amazon — itens com produto (20/out):** os itens de uma promoção mostram foto, nome, nosso SKU, SKU da Amazon e
  ASIN (catálogo da tela → `produtos` → `pesquisa_amz_asins`), preço cheio × promoção com % de desconto, vendas 30 d e
  estoque (`ItensDaPromocao` em `PromocoesAmazon.tsx`).

## 5.9.5 Pesquisa de produtos — Mercado Livre (18/out/2026)

Pedido do dono: DEFESA (categorias em que estamos no top 20, todo dia) e DESCOBERTA (varredura
semanal do Pet Shop: buscas em alta e top 20 das categorias em que não atuamos). Só leitura no ML.
- **Token:** o mesmo de sempre — `oauth_tokens_ml` por `user_id` (Ottz 1107117809, SVL 1299638625),
  renovado pelo cron 21 `ml-refresh-token` (`7,37`). A função só lê `access_token`.
- **O que a API dá com o nosso token (testado 18/out):** `/trends/MLB[/cat]` = 50 termos, só
  `keyword` + `url` (sem posição/tipo: a ordem é a posição; pela doc do ML 1–10 maior crescimento,
  11–30 mais desejadas, 31–50 populares). `/highlights/MLB/category/{cat}` = top 20 — funciona até em
  categoria NÃO folha (o Pet Shop inteiro respondeu); 404 = sem ranking (130 das 253 folhas). O top 20
  vem quase todo como **PRODUCT** (catálogo) e **USER_PRODUCT**, pouco ITEM. `/products/{id}` (nome) e
  `/products/{id}/items` (ofertas, preço, vendedor) liberam dados de terceiros. **Não liberam:**
  `/items` de anúncio de terceiro (403) e `/user-products` de terceiro (403) → para esses fica só id +
  posição. `/highlights/MLB/item|product/{id}` dos nossos deu 404 nos testados. Sem token tudo é 401/403.
  Raiz "Animais" = **MLB1071**, que a API chama de **"Pet Shop"**.
- **"Meu" no ranking** = o id do ranking é o nosso anúncio (ITEM), o `catalog_product_id` de um anúncio
  nosso (PRODUCT — anunciamos naquele produto de catálogo, o que não garante ganhar a vitrine) ou o nosso
  `user_product_id`; também se a 1ª oferta do catálogo é de uma das nossas contas.
- **Tabelas** (`pesquisa_ml_*`, snapshot por `data_coleta` = dia BRT; leitura `authenticated`, sem anon;
  só a função escreve): `categorias` (árvore: nivel 0 = Pet Shop, `e_folha`, `monitorar_diario`, `atuo`
  = temos anúncio ativo, `ativa`, `visto_em`), `ranking` (unique data+categoria+ml_id; `e_meu`,
  `meu_conta`, `meu_mlb`), `tendencias` (`category_id 'MLB'` = geral do site), `coleta` (o que já foi
  coletado no dia por modo — torna as rodadas retomáveis; guarda o 404), `produtos` (cache do catálogo:
  20 h no diário, 6 dias no semanal), `meus` (nossos anúncios ativos das duas contas), `execucoes` (log).
- **Edge fn `pesquisa-ml` v1** (fonte em `supabase/functions/pesquisa-ml/`; aceita chave publicável):
  `?modo=descobrir_lideranca[&forcar=1]` (atualiza `meus` via `/users/{id}/items/search` scan +
  multiget e confere o top 20 de cada categoria em que temos anúncio; onde aparecemos →
  `monitorar_diario = true`, **nunca desliga sozinho**), `?modo=diario` (top 20 das monitoradas),
  `?modo=semanal` (árvore → top 20 de todas as folhas → tendências geral + níveis 0, 1 e 2). Orçamento
  de 22 s por chamada; 429/5xx com espera crescente; erro de uma categoria não derruba a rodada.
  1ª passada completa (18/out): 330 categorias, 253 folhas, 2.271 posições, 956 produtos, 1.522 termos —
  em 2 chamadas (a API respondeu rápido).
- **Crons:** 155 `pesquisa-ml-diario` `13,16,19,22 10 * * *` (07h13–07h22 BRT) · 156
  `pesquisa-ml-lideranca` `27,32 5 * * 0` (dom 02h27) · 157 `pesquisa-ml-semanal` (dom 03h03–05h57, fora
  dos minutos cheios). Todos com Bearer publicável.
- **Primeira leitura (18/out), top 20 por catálogo:** Areias Higiênicas 2º (Bento Mix 4kg) e 20º (Kit 2
  Tofu Great Pets); Perfumes 3º (Perfume Macho Pet Clean); Creme Dental 6º; Repelentes Líquidos 6º (Xô
  Gatinho) e 8º (Kit Xixi Sim/Não); Casas 18º (Stone House). Ottz 335 anúncios ativos, SVL 5.
- **Views:** `view_pesquisa_ml_top_monitorado` (hoje × 7 dias antes, com quem saiu),
  `view_pesquisa_ml_defesa` (1 linha por categoria), `view_pesquisa_ml_tendencias` (semana × anterior),
  `view_pesquisa_ml_descoberta` e `_resumo` (folhas com `atuo = false`, faixa de preço). Sem base =
  `sem_base` (1ª semana).
- **Tela `/pesquisa-produtos`** (módulo `ads`, menu Mídia & Canais): abas Defesa · Descoberta · Buscas
  em alta, cada categoria abre o top 20. **Não conferida com login.**
- **Agente diário (18/out, pedido do dono):** `pesquisa_ml_relatorio_diario(p_data)` → jsonb `versao 'v1'`
  (`kpis`, `defesa` = por categoria minha posição hoje × coleta anterior × 7 dias + `acima` (até 3 logo
  acima, com movimento) + `top3` + `novos`/`sairam`; `descoberta` = última varredura (12 categorias em que
  não atuo); `tendencias` = novos/subindo do Pet Shop níveis 0–2 (na 1ª semana, os de maior crescimento);
  `decisoes` prontas — saiu do top, caiu, concorrente novo acima, perdendo na semana; `coleta`). Agente
  `pesquisa_ml` com categoria PRÓPRIA "Pesquisa de produtos" (gatilho `relatorios_agentes_defaults` +
  `view_relatorios_categorias` ordem 4 + `CATEGORIAS` em `relatorios/comum.tsx`); a faixa Hoje passou a 4
  cards (`md:grid-cols-2 2xl:grid-cols-4`). Card `src/components/relatorios/RelatorioPesquisaML.tsx`
  (entrada `pesquisa_ml` em `agentes.ts`). Skill `agentes/agente-pesquisa-ml/SKILL.md` (+ pacote
  `agente-pesquisa-ml.skill`) e tarefa agendada local **`agente-pesquisa-ml-diario`** (07h40, o app sorteou
  07h53; só roda com o app do Claude aberto — os outros agentes rodam fora deste PC). 1º relatório
  gravado à mão em 18/out (id 27).
- **Catálogo × anúncio próprio (19/out, pedido do dono):** `pesquisa_ml_ranking` ganhou
  **`anuncio_proprio`** (o ITEM/USER_PRODUCT do ranking é nosso) e **`participo_catalogo`** (PRODUCT em
  que anunciamos, ou cuja 1ª oferta é nossa); `e_meu` = um OU outro. `pesquisa-ml` **v2** grava as duas.
  A defesa (`view_pesquisa_ml_defesa`, `pesquisa_ml_relatorio_diario`) olha **só `anuncio_proprio`**
  para "minha posição"; o catálogo vem à parte (`catalogos_que_participo`, `melhor_catalogo`; no
  relatório `catalogo[]`, `melhor_catalogo`, `kpis.catalogo_no_top`, e "Logo acima" conta a partir do
  catálogo quando não há anúncio próprio). **Achado:** nas 8 posições em que "aparecíamos" (18/out),
  TODAS eram catálogo em que participamos — nenhum anúncio próprio no top 20. Tela e card mostram
  "nosso anúncio" × "participamos do catálogo".

## 5.9.6 Pesquisa de produtos — Amazon (19/out/2026)

Fase 2 da pesquisa (pedido do dono). Só LÊ a Amazon (SP-API, token de `oauth_tokens_amazon`, as duas
contas) e grava só `pesquisa_amz_*`. Tela: `/pesquisa-produtos?mkt=amazon` (seletor Mercado Livre |
Amazon; componente `src/components/pesquisa/PesquisaAmazon.tsx`), abas Meus produtos · Concorrentes ·
Oportunidades · Buscas (Brand Analytics). **Não conferida com login.**
- **Tabelas:** `asins` (ASIN acompanhado: nome, marca, `e_meu`, `origem` meu | `termo:<termo>` |
  `brand_analytics`, `ativo`), `bsr` (data × ASIN × categoria; `tipo` subcategoria = classificationRanks,
  grupo = displayGroupRanks, ex. "Pet Shop"), `termos_monitorados` (10 iniciais, o app escreve),
  `brand_analytics` (semana × termo: `rank_busca` + top 3 ASINs com click/conversion share),
  **`meus_skus`** (conta × SKU da Amazon → ASIN → nosso SKU: sem `_FBA`/`FBA-` ou pelo `sku_mapeamento`),
  `coleta` (o que já foi feito no dia — retomável), `relatorios` (estado do Brand Analytics por
  conta/semana), `execucoes`, **`marcas_calibracao`** (Bumi Pet Care, Genérico, Ottz Pet).
- **Edge fn `pesquisa-amz` v3** (fonte no repositório; aceita chave publicável): `meus` (inventário FBA
  das duas contas + Listings da ACZ — a SVL não tem `merchant_token`), `descobrir` (2 páginas da busca do
  catálogo por termo), `diario` (BSR de todos os ASINs ativos, 20 por chamada, 600 ms entre chamadas,
  espera crescente no 429), `brand_analytics[&semana=]` (pede → acompanha → baixa o gzip lendo em fluxo,
  ~100 MB / 300 mil linhas em ~7 s). Semana que a Amazon ainda não liberou volta FATAL "not available
  yet" → `aguardando_dados`, pedida de novo a cada 6 h. Uma conta gravada basta (o relatório é do site).
- **Vínculo ASIN ↔ venda:** `meus_skus.sku_amazon` = `pedido_itens.sku_filho` (SKU cru do vendedor) dos
  `pedidos_validos` da conta (`shop_id` 900001/900002) → `view_pesquisa_amz_vendas30`.
- **Curva BSR → vendas/mês (`view_pesquisa_amz_curva`):** `ln(unidades 30 d) = a + b·ln(BSR médio)`, só
  com **marcas próprias** (de revenda vendemos só uma fatia do ASIN — essa curva saía achatada, b ≈ 0).
  Variações da mesma família dividem o BSR do pai: mesmo BSR = UM ponto, unidades somadas. 3+ pontos e
  −4 < b < 0 = regressão própria (`ok`); 1–2 pontos = inclinação comum medida dentro das categorias com
  2+ pontos, ancorada nos pontos dali (`baixa`); sem ponto nenhum = curva do **grupo "Pet Shop"** pelo BSR
  geral do produto (`*`, `baixa`) — é o único ranking comparável entre subcategorias. A 1ª tentativa de
  `*` (regressão de tudo junto, b −0,32) e a 2ª (constante mediana: 1º de qualquer nicho = 5.800/mês)
  foram descartadas. **Extrapolação limitada:** no máximo 5× melhor que o melhor ponto medido; acima
  disso a estimativa é o valor desse limite com `estimativa_minima` ("≥"). Sem isso o 1º da Areia saía
  com 91 mil/mês. **Areia para Gatos (19/out):** `ln(u) = 11,42 − 1,47·ln(BSR)`, 29 pontos, r² 0,47,
  medida entre BSR 62 e 851 (BSR 100 ≈ 103/mês, 200 ≈ 37); Pet Shop: 39 pontos, b −1,21, r² 0,53.
  Só 1 dia de BSR ainda: a "média de 30 dias" é o BSR de hoje — a curva melhora com o tempo.
- **Views:** `view_pesquisa_amz_meus` (BSR hoje × 7 × 30 dias), `_concorrentes` (top 30 por subcategoria
  ENTRE OS ASINs ACOMPANHADOS — não é o ranking inteiro da Amazon; `melhora_7d`), `_estimativa`,
  `_brand` (última semana, `meu_1..3` = temos anúncio naquele ASIN, inclusive revenda),
  `pesquisa_amz_oportunidades(p_min)` (subcategorias sem ASIN nosso no top 30 com concorrente acima de
  `p_min`/mês; 19/out, X = 100: 37 — ração seca gato/cão, petiscos importados, sachês lideram).
- **Brand Analytics:** ACZ tem acesso (semana 04–10/out gravada: 1.666 termos de pet, em 119 um dos 3 mais
  clicados é ASIN nosso); **SVL recusa** ("A client error occurred…" — provável falta do Registro de
  Marca nessa conta). Filtro de "termo de pet": palavra forte (gato, cão, cachorro, ração como PALAVRA,
  coleira…) ou ambígua com contexto (areia + higiênica/sílica/mandioca, tapete + higiênico…) ou um dos
  ASINs clicados já conhecido (marca: Seresto, Pipicat, Viva Verde). A 1ª versão aceitava "banho",
  "dental", "areia" sozinhas e "ração" dentro de "geração" (Kindle, "coração partido") e trazia 2.850
  termos com lixo. Só os ASINs dos **300 termos mais buscados** entram no `diario` (eram 3.736).
- **Crons (Bearer publicável):** 159 `pesquisa-amz-meus` `22 4 * * 0` (dom 01h22 BRT) · 160
  `pesquisa-amz-descobrir` `26,34,38 4 * * 0` · 161 `pesquisa-amz-diario` `31,34,38,42 9 * * *`
  (06h31–06h42) · 162 `pesquisa-amz-brand` `17,47 11-12 * * *` (todo dia: a Amazon libera a semana com
  2–3 dias de atraso; semana já gravada = a chamada não faz nada).
- 19/out: 1.224 ASINs acompanhados (482 nossos, 325 da busca, 417 do Brand Analytics).

## 5.10 Reembolsos/devoluções Shopee — classificação (24/set/2026)

- **`view_shopee_reembolsos`** — 1 linha por pedido com devolução, extravio,
  "Failed Delivery" ou TO_RETURN; coluna **`classe`** (01 em disputa … 12 em
  retorno) + dinheiro: `valor_reembolsado`, `descontado_vendedor` (−(escrow
  seller_return_refund + débito pós-liberação + escrow negativo)),
  `compensado` (SELLER_COMPENSATE/RETURN_COMPENSATION + crédito da central de
  ajustes por extravio/comprovante — order_sn no FIM da descrição), `cmv`,
  `produto_recebido_em` (devolucoes_recebidas).
- `shopee_devolucoes` ganhou o **detalhe** (`get_return_detail`: `disputa_motivo`
  presente = houve disputa; `solucao` 0 devolve produto / 1 só reembolso;
  `tipo_reembolso` RRBOC antes de concluir / RRAOC depois; logística reversa;
  compensação; frete) e o **escrow ATUAL** (`esc_*`, via
  `get_escrow_detail_batch` 50/chamada). **ARMADILHA:** o `escrow_componentes`
  é foto antiga — em 883 de 1.296 reembolsos foi gravado ANTES da devolução.
  As colunas `esc_*` são escritas só pela `shopee-devolucao-probe` (não mexer
  no escrow_componentes, que é de outra rotina).
- `shopee-devolucao-probe` **v20**: `sync&desde=YYYY-MM-DD` (histórico desde
  fev), `detalhar` (fila `view_shopee_devolucoes_a_detalhar`, cron 124
  `13,43 * * * *`), `escrow` (fila `view_shopee_devolucoes_a_escrow`, cron 125
  `27 */2 * * *`).
- **ARMADILHA:** a compensação por pacote perdido vem na carteira como
  "Reembolso por objeto perdido" com **`classificacao` VAZIA** (204 lançamentos,
  R$ 7,2 mil fev–set) — a view trata como `OBJETO_PERDIDO`. Compensação cai em
  mediana 4 dias (até 15) após o reembolso.
- **Rastreio da IDA (25/set):** o detalhe da devolução NÃO mostra a falha da entrega
  original (o `logistics_status` dele é o da volta). `shopee-devolucao-probe` v22
  `modulo=rastreio-ida` (`logistics.get_tracking_info`, cron 126 `7 10,11,16,20 * * *`)
  grava `ida_*` dos pedidos só-reembolso (e das abertas, ver abaixo). Classificar pelo **CÓDIGO** do evento
  (`DELIVERED`, `FAILED_DELIVERED`) + frase final exata ("Pedido devolvido",
  "Pedido descartado", "Pedido extraviado…") — texto livre engana ("Não conseguimos
  coletar: **Remetente** não preparou" não é devolução). Descrição vem com UTF-8
  duplo (`convert_from(convert_to(x,'LATIN1'),'UTF8')`).
- **`view_shopee_perda_logistica`** (situação 1 descartado/perdido · 2 Shopee diz que
  devolveu, sem entrada no galpão · 2b voltando · 3 falha, não voltou · 4 entregue ×
  "não recebi" · 5 voltou · 6 entregue, reclamação de item · 7 sem evento) +
  **`view_shopee_perda_alertar`** + função **`shopee_alerta_perda_logistica(p_dry)`**
  (posta no #devolucoes via discord-notify, 1× por pedido — `alerta_perda_em`;
  silêncio sem caso novo). Cron do alerta: **NÃO criado** — o dono ainda vai decidir
  o backlog (marcar os acumulados como avisados × soltar ~25/dia).
- **`view_shopee_reembolsos` reescrita com LATERAL (29/set):** agregava a carteira
  Shopee inteira (~42 mil) e o CMV de ~52 mil itens a cada leitura (~6 s); com o
  filtro da `view_shopee_perda_logistica` por cima o planner estimava 1 linha e a
  view de perdas estourava o statement timeout até em `count`. Agora carteira e
  CMV são por pedido (`idx_trans_pedido`, `idx_itens_pedido`): reembolsos 6 s →
  0,13 s, perdas timeout → 0,24 s. md5 idêntico antes/depois (2.892 linhas).
- **Tela `/devolucoes` › aba "Perdas Shopee" (29/set,
  `src/components/DevolucoesShopeePerdas.tsx`):** lê a `view_shopee_perda_logistica`
  paginando de 1.000 em 1.000; chips multi-seleção por situação (padrão 1/2/3 =
  perda), período (desde 10/ago = início das Recebidas · 60 dias · tudo), loja,
  "sem compensação" (padrão); itens/rastreio (ida `shopee_rastreio`, volta
  `shopee_devolucoes.tracking_number`) e foto só dos filtrados; **Planilha (CSV)**
  do filtro atual (serve de lista para o galpão conferir); **"Dar entrada"** abre a
  aba Recebidas já buscando o pedido (prop `buscaInicial`) — ao registrar, o
  pedido vira situação 5 e sai da lista. Só leitura, nenhuma ação na Shopee.
- **Faixa "como no Seller Center" (29/set, pedido do dono):** nas abas "Shopee
  (abertas)" e "Perdas Shopee", cada card mostra **Solução do reembolso**
  (`solucao` 1 = apenas reembolso / 0 = devolução e reembolso), **Status da
  solicitação** (ACCEPTED dentro do `due_date` = "Pendente validação do vendedor ·
  disputa até dd/mm"; fora = "Reembolso concluído") e **Status da entrega** da IDA
  (`ida_*` + `pedidos.opcao_envio`), mais **Status da devolução**
  (`logistica_reversa` com os rótulos do Seller Center — `PICKUP_DONE` = "Postado";
  rastreio `AP…BR` = Correios Logística Reversa) quando o produto volta. Regras em
  `src/lib/shopeeDevolucao.ts`, componente `InfoDevolucaoShopee.tsx`. Sem rastreio da
  ida consultado, a entrega é deduzida de `pedidos.status_pedido` e o texto avisa.
- **Rastreio da ida também nas ABERTAS (30/set, pedido do dono):**
  `view_shopee_devolucoes_a_rastrear` passou a incluir, além de só-reembolso,
  toda devolução REQUESTED/PROCESSING/JUDGING/SELLER_DISPUTE e ACCEPTED ainda no
  `due_date` (antes: só `solucao = 1`, e as com produto nunca tinham "Status da
  entrega"). Fila foi de 1 para 30; 1ª rodada 30/30 gravados em 5 s. Cron 126
  passou a `7 10,11,16,20 * * *` (antes 10,11) — devolução aberta vence em dias.
- **Prazo de disputa ≠ due_date (18/out/2026, print do dono: 3 devoluções "Pendente validação · disputa até
  18-10" que o app já não mostrava):** o `due_date` da Returns API é **abertura + 2 dias**; o "disputa até" do
  Seller Center é `get_return_detail.seller_compensation.seller_compensation_due_date` — 24 a 55 h depois. O app
  usava o `due_date` para filtrar a aba "Shopee (abertas)" e no rótulo "disputa até", e tirava a devolução aceita
  da lista um dia antes. Agora: coluna **`shopee_devolucoes.prazo_disputa`** (gravada pelo `detalhar`,
  `shopee-devolucao-probe` **v26** — fonte agora no repositório), `view_devolucoes_shopee_abertas.prazo_disputa` =
  `coalesce(prazo_disputa, due_date)`, mesma regra em `view_shopee_devolucoes_a_rastrear`, na aba de abertas e em
  `statusSolicitacao` (`src/lib/shopeeDevolucao.ts`). A Shopee só informa o prazo em parte das aceitas (19 de 82
  em 15 dias); sem ele vale o `due_date`. Na hora da correção: abertas dentro do prazo 4 → 8.
- **"Aguardando sua validação" = `compensacao_status = PENDING_REQUEST` (18/out, 2ª rodada):** reembolso aceito sem
  pedido de compensação ao vendedor (vazio ou `NOT_REQUIRED` — ex.: 2610170U790YQUV "não recebi") não tem validação
  nem disputa e o Seller Center não o lista com "Disputar"; o app mostrava todo ACCEPTED dentro do prazo. Agora a aba
  de abertas filtra `status = ACCEPTED and compensacao_status = PENDING_REQUEST and prazo_disputa > now()` (coluna
  nova na `view_devolucoes_shopee_abertas`), o card dos demais aceitos (achados pela busca) diz "Reembolso aprovado
  pela Shopee · sem validação do vendedor", sem botões, e `statusSolicitacao` usa a mesma regra. Aceita ainda sem
  detalhe lido some da aba até o `detalhar` (cron 124, :13/:43) preencher o status.
- Reembolso aceito com o prazo de DISPUTA vencido = "Reembolso concluído", sem botões (o "Aprovar" numa achada pela
  busca voltava "Invalid return status: RETURN_ACCEPTED").
- **Busca na aba "Shopee (abertas)" (18/out, pedido do dono):** campo ao lado dos filtros de loja — pedido,
  solicitação, rastreio ou SKU/produto filtram as abertas; pedido/solicitação/rastreio (6+ caracteres) que NÃO está
  entre as abertas é procurado na `view_devolucoes_shopee_abertas` sem filtro de status e aparece com o selo "fora
  das abertas". Com busca, os cartões de status (validar/disputa) não filtram.
- **Quando o produto devolvido chegou (18/out, pedido do dono):** devolução COM produto (`solucao 0`) que já foi
  entregue ao vendedor fica `PROCESSING` com `logistica_reversa = LOGISTICS_DELIVERY_DONE`, e o prazo que vale é
  o de VALIDAR o produto: `get_return_detail.return_seller_due_date` = chegada + 3 dias (o card mostrava "prazo
  venceu · 11/10" pelo `due_date`). `shopee-devolucao-probe` **v27/v28** grava **`prazo_vendedor`** e
  **`volta_entregue_em`** — `returns.get_reverse_tracking_info`: com `reverse_logistics_status =
  LOGISTICS_DELIVERY_DONE` a hora é `reverse_logistics_update_time` (os eventos só trazem `update_time` +
  `tracking_description`, ex. "Pedido devolvido"); sem isso, `return_seller_due_date − 3 dias`. O rastreio da volta
  só é lido 1× por devolução. `?modulo=volta&return_sn=` = rastreio cru. A view de abertas usa `prazo_vendedor`
  como prazo das não aceitas (`coalesce(prazo_disputa, prazo_vendedor se ≠ ACCEPTED, due_date)`) e o `detalhar`
  relê as `solucao 0` dos últimos 45 dias. Card: selo "devolvido em dd/mm às HH:mm", status "Produto chegou ·
  valide" e prazo "validar: vence em …". Ex.: 26100907HT3QWQ8 chegou 17/10 11h58, validar até 20/10 11h58.
- Achado: "não recebi" (NOT_RECEIPT, RRBOC) = escrow ZERADO — a venda não gera
  receita para nós, mesmo com `frete_responsavel=SHOPEE`. Créditos "perdido no
  ARMAZÉM" são do Full (por item_id/index, não por pedido).

## 5.11 IA · Anúncios — unificação do gerador, Fase 1 (06/out/2026)

Decisão do dono (05/out): o gerador "Anúncio Mágico" (Supabase **`pcob…`**,
clone em `C:\dev\an-ncio-m-gico`) vem para dentro da gestão em 4 fases. Fase 1
= cadastro de prompts e contextos. Plano, SQL e **rollback** em
`docs/ia-fase1-plano.md`.

- **Fonte da verdade:** o **gerador** continua mandando até a Fase 2 (que
  ressincroniza por `id`). A gestão tem uma cópia com os **mesmos ids e
  datas**, conferida por md5 linha a linha (35 templates, 28 regras, 41
  contextos, 8 modelos, 7 canais, 4 faixas, 2 empresas). Não edite os dois
  lados achando que se falam — não se falam.
- **Tabelas** (`ia_*`): `ia_prompt_template` (unique nome+versão; nomes
  `__bkp_*` são backups, escondidos na tela), `ia_prompt_guardrail`,
  `ia_contexto` (escopo global/categoria/marca/sku + `aplica_em[]`:
  briefing/bullet_points/descricao/imagem/titulo), `ia_modelo_imagem` (um
  `padrao` só — índice parcial), `ia_canal_config` + `ia_canal_faixa`,
  `ia_empresa`. Trigger `ia_set_updated_at`.
- **Acesso:** módulo de perfil **`ia`**. RLS em todas via
  **`tem_modulo('ia')`** (security definer, lê `perfis_usuario`; `todos` passa).
  Sem anon. Bucket privado **`ia-contexto`** (mesmas regras; caminho
  `<escopo>/…` ou `sku/<chave>/<uuid>.<ext>`; front usa URL assinada).
- **Leitura pronta:** view `ia_produto` (security_invoker; marca efetiva =
  `coalesce(marca_manual, marca)`, `categoria_caminho` "Gatos -> Higiene… ->
  …", foto da `view_foto_produto`), `ia_contexto_alcance` (quantos SKUs cada
  contexto pega), `ia_chaves_contexto` (datalist do editor) e RPC
  **`ia_contextos_do_sku(sku, aplica_em)`** — mesma regra do
  `contextos_do_sku` do gerador, mas categoria casa por `categoria_caminho`
  e marca compara sem aspas/apóstrofo nas pontas (o gerador tinha "Bumi Pet
  Care'"). Validado contra o gerador: 1.612/1.616 SKUs idênticos; os 4
  diferentes são cadastro (gerador desatualizado ou SKU sem marca/categoria
  na gestão), não regra.
- **Telas:** `/ia/prompts` (abas Templates/Regras/Modelos/Canais+faixas/
  Empresas) e `/ia/contextos` (por escopo, alcance, upload de imagem, "ver
  contextos de um SKU"). Grupo "IA · Anúncios" no menu.
- **Pendente:** os 2 arquivos de contexto de imagem (`sku/15159/…jpg`,
  `sku/15820/…png`) existem só no bucket do gerador — o dono sobe pela tela.

## 5.11.1 IA · Anúncios — Fase 2: geração na gestão (09/out/2026)

Decisões do dono (09/out): **começar do zero** (o histórico do gerador — 15
rascunhos, 58 imagens — fica lá como arquivo), só produto do Tiny (sem produto
manual), entrada pelo **Catálogo** (botão "Gerar anúncio" na linha, só com o
módulo `ia`) + lista `/ia/anuncios`, fila de imagem **encadeada + rede de
segurança de 5 min**, comparar modelos fora. Envio ao Tiny = **Fase 3** (aqui
aprovar só marca a etapa). Plano em `docs/ia-fase2-plano.md`; SQL + rollback em
**`docs/ia-fase2-migracao.sql`**; código das fns em **`supabase/functions/`**
(`ia-anuncio`, `ia-imagem-worker`, comum em `_shared/ia.ts` — deploy via MCP com
o arquivo `../_shared/ia.ts` junto).
- **Tabelas:** `ia_produto_extra` (público-alvo, frete adicional, embalagem e a
  foto real CONGELADA `foto_ref_path` em `ia-anuncios/ref/{sku}/…` — uma fonte só;
  o gerador tinha três), `ia_briefing` (1 por SKU), `ia_rascunho` (= draft),
  `ia_prompt_imagem` (sku+tipo; `editado_mao` nunca é sobrescrito sem forçar),
  `ia_rascunho_imagem`, `ia_etapa` (texto|imagem; pendente→na_fila→gerando→gerado→
  aprovado/rejeitado/erro; `proxima_em` = backoff). RLS `tem_modulo('ia')`;
  `ia_etapa` só leitura no app (muda por RPC/edge fn). Bucket privado `ia-anuncios`.
- **RPCs:** `ia_calcular_preco`/`ia_analisar_preco` (custo = **`view_cmv_efetivo`**,
  regra da gestão, kit pela composição; + frete/embalagem do `ia_produto_extra`;
  faixas `ia_canal_faixa`, imposto `ia_empresa`), `ia_etapa_aprovar/rejeitar`,
  `ia_imagem_fila_pegar` (SKIP LOCKED, devolve `gerando` > 5 min, respeita
  `proxima_em`), `ia_fila_vigiar()` (cron `ia-fila-vigiar` `2-59/5`: só chama o
  worker se há imagem parada; sem pendência não faz nada). Triggers: texto →
  etapa texto (hash; texto editado depois de aprovado volta para revisão) e etapa
  → status da imagem.
- **Edge fns:** `ia-anuncio` (`briefing`, `texto`, `prompts-imagem`, `imagens` =
  só enfileira + 3 workers, `foto-ref`; JWT de usuário + `tem_modulo('ia')`
  checado no código) e `ia-imagem-worker` (1 imagem por chamada, encadeia;
  Gemini `generateContent` 1:1 / OpenAI `images/edits` 1024; 3 tentativas com
  espera 2 min × tentativa). Correções levadas do gerador: capa com
  `[CONFIRMAR` recusada também no servidor; barra vazia = "sem barra" (o gerador
  mandava um exemplo que saía impresso na arte); contextos baixados 1× por
  chamada; prompts de imagem 4 por vez (antes todos juntos → 429).
- **Secrets que o dono cadastra (nunca no chat):** `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` (modelo padrão `gpt-image-2.5-sunburst`), `GOOGLE_API_KEY`
  (só se ativar modelo Gemini). Opcional `MODELO_TEXTO`.
- **Front:** `/ia/gerar?sku=&canal=&empresa=&r=` (`src/components/ia/anuncio/`:
  `ProdutoTopo` — foto de referência com troca/upload, dados extras; `EtapaTexto` —
  texto editável, refazer com observação, briefing, preço com análise;
  `EtapaFotos` — plano de fotos, formulário de capa, prompts editáveis, geração e
  revisão com polling de 3 s só com fila andando e aba visível) e `/ia/anuncios`.
  Tipos/chamadas em `src/lib/iaAnuncio.ts`. Quem tem só o módulo `ia` cai em
  `/ia/anuncios` ao entrar.
- **Catálogo (`/produtos`):** carregava só 1.000 dos 2.321 produtos (busca no
  navegador não achava a outra metade) — agora pagina de 1.000 em 1.000.
- **Estado em 10/out/2026:** migração `ia_10_geracao` APLICADA (sábado 12h47, banco
  parado) e cron **152** `ia-fila-vigiar` (`2-59/5`) ligado. Falta o dono cadastrar os
  secrets e o 1º teste real (nenhuma geração foi feita ainda). Ordem combinada com o
  dono (10/out): **primeiro a lógica e o layout, depois as integrações** (chaves de IA,
  envio ao Tiny).

## 5.11.2 IA · Anúncios — preço pelo histórico e catálogo (10/out/2026)

Pedido do dono: o preço usa "o conhecimento que temos" (margens e taxas dos pedidos) e a
lista de Anúncios "replica o catálogo ativo". Migrações `ia_11_preco_historico_catalogo` e
`ia_12_taxa_faixas_finas`; SQL comentado + rollback em `docs/ia-fase2b-preco-historico.sql`.
- **Histórico (2 tabelas, preenchidas 1×/dia):** `ia_historico_atualizar()` (cron **153**
  `ia-historico`, `23 9 * * *` = 06h23 BRT; ~8 s; lê a `view_margem_pedido_v2` UMA vez para
  temp tables) grava **`ia_hist_taxa_faixa`** (canal × empresa × faixa de preço: `n`,
  `taxa_med`, p25/p75 e **`taxa_suave`/`n_suave`**) e **`ia_hist_sku_canal`** (SKU vendido ×
  canal × empresa: unidades 30/120 d de todos os pedidos; preço unitário mediano e do último
  pedido, `mc_pct` = soma margem ÷ soma venda e taxa — estes de pedidos de 1 SKU só).
  Canais/empresas nos códigos da IA (`shopee`, `mercado_livre`, `amazon`, `tiktok`;
  `ottz`/`svl`; empresa `'*'` = as duas; faixa `0` = canal inteiro).
- **Taxa do canal** = `(venda − recebido_estimado) ÷ venda` do pedido de 1 SKU e 1 unidade
  (tudo que o marketplace desconta: comissão, tarifa fixa, frete do vendedor). Faixas FINAS
  (`ia_faixa_preco`/`ia_faixas`: R$ 5 até 100, R$ 10 até 200, R$ 50 até 500) e a taxa de
  cada faixa é a média ponderada com as vizinhas a ±15% do preço, **sem atravessar R$ 80**
  (degrau real de Shopee/ML). 1ª versão tinha 6 faixas largas e a mediana criava degrau
  artificial (ML sugeria R$ 50,00 "com 28% de margem"). Regressão fixo+% por faixa foi
  testada e descartada (produtos se concentram em poucos preços: r² baixo, coeficientes
  absurdos).
- **`ia_faixas_taxa(sku, canal, empresa)`** → por faixa: `pct`, `fixo`, `fonte`, `nivel`, `n`.
  **Shopee = `shopee_tarifa_vigente()`** (a MESMA tabela das telas de promoção: 20% + R$ 4,50
  etc.). Demais, do mais específico ao mais geral: faixa da empresa (`n_suave` ≥ 15) → faixa
  das duas empresas → mediana do canal (`nivel='canal'`, a tela avisa "estimativa fraca") →
  `ia_canal_config.comissao_pct` cadastrada → erro "sem pedidos deste canal". Se o produto já
  vende no canal (≥ 5 pedidos de 1 un.), as faixas são multiplicadas por
  `taxa do produto ÷ taxa do canal no preço dele` (limitado a 0,6–1,6; `nivel='sku'`) — leva
  peso/categoria/frete próprios do produto para outros preços.
- **`ia_calcular_preco` / `ia_analisar_preco`** reescritas sobre isso (mesmas chaves de
  antes + `fonte_taxa`, `nivel_taxa`, `amostra`, `faixa_min/max` e `historico` = como o
  produto vende hoje naquele canal). Percorre as faixas em ordem e aceita a 1ª em que o
  preço cabe (`greatest(preço, piso da faixa)`). **`ia_canal_faixa` ficou sem uso** (não
  apagada). Temu/Shein/Olist não têm pedido com repasse na gestão → sem preço sugerido até
  cadastrar `comissao_pct`. Margem alvo segue em `ia_canal_config.margem_alvo_pct` (17,5%).
  Conferido no 15984: Shopee Ottz R$ 42,10; ML Ottz vende a R$ 36,99 com 8,5% de margem →
  sugerido R$ 45,00; Amazon Ottz R$ 37,23.
- **Limite conhecido:** produto NOVO no canal usa a taxa média da faixa de preço — não
  enxerga peso (frete do ML/Amazon varia com ele). Próximo refinamento = faixa × peso.
- **Tela `/ia/anuncios` = catálogo ativo** (RPC **`ia_catalogo(busca, marca, situacao,
  sem_canal, ordem, offset, limit)`**, security definer + `tem_modulo('ia')`, ~0,3 s):
  produtos `ativo` e não arquivados (2.318), com custo, unidades 30 d, selos "onde vende
  hoje" (canal · empresa · preço · margem real) e os rascunhos de IA. Filtros na URL:
  situação (sem anúncio / em andamento / pronto, com contagem), marca, "ainda não vende em
  <canal>", ordem; 50 por página. Tudo no banco — nada de filtrar no navegador.
- **Tela `/ia/gerar`:** bloco **Preço** (`PainelPreco.tsx`) aparece SEMPRE, antes de existir
  rascunho: sugerido, conta aberta, de onde veio a taxa, "analisar o preço que vou praticar"
  e a tabela "como este produto vende hoje" por canal. **"Escrever à mão"** (RPC
  `ia_rascunho_criar`) cria o rascunho sem IA — dá para percorrer texto e fotos sem as
  chaves cadastradas.
- **Teste de RPC que exige login, sem login:** `set_config('request.jwt.claims',
  json_build_object('sub', <user_id>, 'role','authenticated')::text, true)` na mesma consulta
  (só leitura). Função `stable` chamada na MESMA instrução que a função que grava não vê o
  que ela gravou (snapshot) — conferir em consulta separada.

## 5.11.3 IA · Anúncios — referências na tela, preço por margem e estudo de publicação direta (10/out/2026)

- **Referências e instruções na tela do anúncio** (`anuncio/Referencias.tsx`, bloco em
  `/ia/gerar`): lista o que vale para o SKU (regra do banco `ia_contextos_do_sku`, uma chamada
  por uso) e deixa **subir arquivos** (JPG/PNG/WEBP/PDF, vários de uma vez; imagem > 3 MB é
  reduzida a 2.000 px no navegador) ou **escrever instrução**, com papel (identidade visual,
  referência do produto, ficha técnica, diretriz), alcance (só o produto ou toda a marca) e uso
  (textos e/ou imagens). **Sem tabela nova:** é o cadastro de `/ia/contextos` (`ia_contexto` +
  bucket `ia-contexto`, caminho `sku/<sku>/<uuid>` ou `marca/<uuid>`). Categoria/global só se
  editam em `/ia/contextos`.
- **Quem recebe o quê:** texto e prompts (Claude) recebem imagem e PDF. Modelo de imagem:
  Gemini recebia as imagens de contexto; **a OpenAI (modelo padrão) NÃO** — só a foto real, e o
  anexo virava a nota "(anexo nao suportado)". `ia-imagem-worker` **v2 (no repositório)** manda
  até 4 imagens de contexto como `image[]` do `images/edits` e, se a OpenAI recusar (400),
  refaz só com a foto real. **No ar desde 12/out** (deploy 3). PDF nunca vai ao modelo de imagem.
- **Preço por margem:** `ia_calcular_preco(sku, canal, empresa, p_margem default null)` e
  `ia_analisar_preco(..., p_preco, p_margem default null)` (migração `ia_13_preco_por_margem`;
  as assinaturas antigas foram removidas — chamada com 3 argumentos nomeados continua valendo).
  Sem margem = `ia_canal_config.margem_alvo_pct`. Na tela: campo "Margem que eu quero" +
  atalhos 10/15/20/25/30% + "padrão do canal"; o caminho inverso (preço → margem) é o
  "Analisar". A margem escolhida é salva em `ia_rascunho.memoria_calculo.margem_desejada`
  junto com o preço.
- **Publicação direta (estudo, `docs/ia-fase3-publicacao-direta.md`):** edge fn
  **`anuncio-publicar-sonda`** v1 (só leitura, `?mkt=shopee|ml|amazon|tiktok`; a única chamada
  não-GET é o validador `/items/validate` do ML). Resultado: módulo de produtos **liberado nos
  quatro canais** com os nossos apps. Shopee = o mais simples (sem atributo obrigatório nas
  categorias testadas; marca obrigatória aceita "Sem marca"; peso e **dimensões** obrigatórios;
  dá para criar NÃO LISTADO). ML = conta no modelo novo (User Products: exige `family_name`),
  BRAND obrigatório, GTIN condicional, validador funciona. TikTok = dimensões do pacote
  obrigatórias, depósito conhecido. Amazon = esquema por tipo de produto (`ANIMAL_LITTER`: 105
  campos, 6 obrigatórios), o mais trabalhoso. **Escrita não testada.** O que decide é o
  **vínculo com o Tiny** (estoque e pedido): anúncio criado direto precisa casar com o produto
  do Tiny pelo SKU — a conferir com 1 anúncio de teste. Faltam na gestão: dimensões, EAN, NCM,
  origem (o Tiny tem). Recomendação: piloto com 1 produto na Shopee Ottz, não listado.
  **Aguardando decisão do dono** (caminho A/B/C e autorização do 1º teste de escrita).

## 5.11.4 IA · Anúncios — texto pela OpenAI e 1ª ligação das chaves (12/out/2026)

O dono não conseguiu entrar na Anthropic e pediu para começar só com o GPT.
- **Provedor de texto automático** (`_shared/ia.ts`): com `ANTHROPIC_API_KEY` → Anthropic (como
  antes); sem ela → **OpenAI** com a `OPENAI_API_KEY` (a mesma das imagens). Forçar: secret
  `IA_TEXTO_PROVEDOR` = `openai`|`anthropic`. Modelo da OpenAI: secret `MODELO_TEXTO_OPENAI`;
  sem ele, a função lista os modelos da chave e usa o GPT numerado mais novo sem sufixo
  (`resolverModeloTexto()` — hoje **`gpt-5.5`**; o nome real fica em `ia_rascunho.modelo_texto`).
  O `modelo` dos templates (`claude-sonnet-4-6`) só vale com a Anthropic. `claude()` manteve o
  nome, mas roteia: `claude-*` → Anthropic, o resto → `chat/completions` (imagem = `image_url`
  data-URL, PDF = `file`; `max_completion_tokens` folgado e `reasoning_effort: low`, com
  repetição sem o parâmetro se o modelo recusar).
- **Diagnóstico sem login:** `POST ia-imagem-worker` com corpo `{"status": true}` (chave
  publicável) → quais secrets existem (só verdadeiro/falso), modelo de texto escolhido, modelos
  de imagem que a chave enxerga e se o padrão existe. Medido em 12/out: só `openai` cadastrada;
  texto `gpt-5.5`; imagem padrão `gpt-image-2.5-sunburst` existe. O campo `fonte_sha256` **não
  funciona** (a função não lê o próprio código no runtime) — ignorar; a conferência do deploy foi
  feita baixando o que está no ar (`get_edge_function`) e comparando com o repositório: idênticos.
- **Deploy:** `ia-anuncio` e `ia-imagem-worker` na versão 3, iguais ao repositório. O arquivo
  comum é enviado nas DUAS com o nome `../_shared/ia.ts` — mudou o comum, republica as duas.
- **Ainda sem teste real:** a geração de texto e de imagem exige login com o módulo `ia`; o 1º
  teste é do dono pela tela. Erros ficam em `ia_rascunho.erro` / `ia_etapa.erro` e nos logs das
  funções (`ia_imagem_gerada`, `ia_imagem_falhou`, `ia_imagem_extras_recusadas`).

## 5.11.5 IA · Anúncios — fotos uma a uma e envio direto à Shopee (12/out/2026)

1ª geração real feita pelo dono em 12/out (SKU 16170, texto pelo `gpt-5.5`, 5 imagens aprovadas).
- **Fotos (`EtapaFotos.tsx`):** cada tipo tem uma linha de explicação (`DESCRICAO_FOTO` em
  `src/lib/iaAnuncio.ts`, resumo dos templates `imagem_*`; tipo novo sem descrição só não mostra
  a linha) e botões próprios **prompt** e **imagem/refazer** — uma foto por vez. Os botões de
  baixo seguem fazendo as marcadas. Pela linha, o prompt existente é reescrito, menos o editado
  à mão (esse só com a caixa "refazer os que já existem").
- **Bloco "3 · Enviar anúncio" (`Publicar.tsx`):** cartões Shopee (disponível), Mercado Livre,
  TikTok e Amazon (em preparação). O rascunho é POR canal — o cartão de outro canal só troca o
  canal da tela.
- **Edge fn `anuncio-publicar` v1** (JWT de usuário + `tem_modulo('ia')` conferido no código;
  fonte no repositório): `previa` (só leitura: banco, Tiny e Shopee) e `enviar` (`confirmar:
  true`). Só **Shopee**, anúncio **simples** (um SKU, sem variações). Loja pela empresa do
  rascunho (ottz → 522186766, svl → 759046323). Monta: título (≤ 120), descrição = texto +
  bullets (10–5.000), preço = `preco_aprovado` ou sugerido, até 9 fotos APROVADAS (capa na
  frente), `item_sku` = nosso SKU, categoria = `category_recommend` pelo título (nomes da
  `get_category`; a pessoa pode trocar), **marca e canais de envio copiados de anúncios que a
  loja já tem** (marca: outro anúncio da mesma marca; sem achar → "Sem marca", com aviso), peso e
  dimensões = digitado → `ia_produto_extra` → **Tiny ao vivo** (`GET /produtos/{id}`.`dimensoes`,
  conta ottz) → `produtos.peso_bruto`. Estoque inicial padrão **0** e **fora do ar** (`UNLIST`)
  por padrão: o Tiny só manda estoque depois de ligar o anúncio ao produto pelo SKU — vínculo
  ainda **não conferido**. Exige texto aprovado e ≥ 1 foto aprovada. Envio: sobe as fotos
  (`media_space/upload_image`, assinatura pública com queda para a de loja) e chama
  `product/add_item` **sem repetição**. Rascunho já publicado só vai de novo com `de_novo`.
- **`ia_publicacao`** (migração `ia_14_publicacao`): um registro por envio (estado
  enviando/publicado/erro, `item_id`, `url`, `enviado`, `resposta`, quem). Só a função grava;
  o app lê. `ia_produto_extra` ganhou `peso_kg`, `comprimento_cm`, `largura_cm`, `altura_cm`,
  `gtin`, `ncm` (as medidas conferidas ficam salvas para o próximo anúncio do produto).
- **Não testado:** nem a prévia nem o envio rodaram (exigem login). O formato do `add_item` e
  do upload de imagem vem da documentação — se a Shopee recusar, a resposta crua fica em
  `ia_publicacao.resposta` e a mensagem aparece na tela.
- **Imagem sem prompt saía crua (12/out, mesmo dia):** há DOIS caminhos de imagem. Com prompt
  escrito (`ia_prompt_imagem`, feito pelo `meta_prompt`) sai o infográfico com título e destaques.
  Sem prompt, o worker usa o template `imagem_*` puro — e os de lifestyle/detalhe/ângulo/kit
  diziam "Sem texto sobreposto". O botão "imagem" por linha deixou esse 2º caminho a um clique
  (a 1ª Lifestyle do dono saiu sem texto). Além disso capa sem prompt é recusada pela função
  ("nenhuma foto a gerar", sem dizer por quê). Corrigido: (1) o front **escreve antes o prompt
  das fotos que não têm** (uma ou várias) e só então enfileira; (2) o erro mostra o motivo de
  cada foto pulada; (3) regra nova `inst_imagem_texto_vantagem` (`ia_prompt_guardrail`,
  instrução `IMAGEM:`): fora a principal e as capas, toda imagem leva texto apontando vantagem
  ou uso, e prefere cenário de uso a fundo branco (pedido do dono); (4) templates
  `imagem_lifestyle`, `imagem_detalhe`, `imagem_angulo` e `imagem_kit` ganharam a **versão 2**
  (v1 desligada, não apagada) pedindo o texto. `imagem_principal` segue sem texto (regra dos
  marketplaces para a foto de catálogo).
- **Sem etapa de confirmação (12/out, pedido do dono):** a capa era barrada quando o prompt
  trazia `[CONFIRMAR: …]` (peso ilegível na foto, barra não informada). Agora "imagem" = prompt +
  imagem direto. `ia-anuncio` **v3 (deploy 4)**: `semConfirmar()` troca o campo marcado pela opção
  neutra (peso: "nao citar peso na arte"; barra/faixa/ícones: "sem …"; outro marcador vira "nao
  escrever nada sobre isto") ao SALVAR o prompt e, para prompt antigo, ao ENFILEIRAR (regrava a
  linha). O `meta_prompt_imagem` ganhou a **versão 2** (v1 desligada): não pede mais `[CONFIRMAR]`
  e proíbe marcador entre colchetes. Motivo de nunca deixar o marcador ir adiante: o gerador de
  imagem desenha na arte tudo o que está escrito no prompt.
- **Capas — regras do dono (12/out, com 4 capas de exemplo):** (1) capa padrão **não leva
  benefícios** (nada de ícones/selos/frases de vantagem; só se o operador informar ícones);
  (2) o título nunca é faixa colada no topo: é um **selo flutuante** (placa arredondada com
  margem das bordas, cenário aparecendo em volta), desenhado na identidade da marca/produto —
  cores da embalagem, tipografia display pesada, linha de cima = tipo de produto, linha de baixo
  numa 2ª placa contrastante = diferencial, 1–2 acentos ligados ao produto (folhas, gotas); o
  texto vem do NOME do produto, nunca de benefício; (3) a barra inferior também flutua, em
  pílulas com um ícone do tipo de embalagem antes de cada valor. Onde está: templates
  `imagem_capa_shopee_basica`, `_shopee_livre`, `_ambientada_texto`, `_ambientada_shopee` na
  **versão 2** (blocos SELO DE TÍTULO / BARRA INFERIOR / SEM BENEFÍCIOS; v1 desligada);
  `meta_prompt_imagem` **versão 3**; `ia-anuncio` **deploy 5** (`blocoOperador`: ícones vazios =
  "sem icones" — antes mandava "escolha 3 a 5 benefícios do briefing", origem dos ícones na capa
  das Dedeiras; título vazio = a IA escreve pelo nome, ou MENOR PREÇO / DA SHOPEE nos estilos
  Shopee; `|` no título separa as duas linhas). Estilos 2 (ML fundo branco) e 5 (sem texto) não
  mudaram. Efeito ainda não visto numa imagem gerada.
- **Atualizar anúncio existente (12/out, pedido do dono) — `anuncio-publicar` v2:** dos 2.318
  produtos ativos, 1.635 já têm anúncio em algum canal (Shopee Ottz 1.314, Bumi 1.042, ML 342,
  TikTok 106) — criar para eles duplicaria. `?modulo=existentes {sku}` (só banco) devolve onde o
  SKU já está anunciado: Shopee por loja (`shopee_anuncios.sku_pai` = anúncio próprio;
  `shopee_anuncios_variacao.sku` = variação de um anúncio maior, com `model_id`), `ml_anuncios`
  e `tiktok_produtos`; a Amazon não tem espelho. Os cartões do bloco 3 mostram "já anunciado /
  ainda não anunciado" por loja. **`opcoes.modo`**: `atualizar` é o PADRÃO quando o SKU já tem
  anúncio na loja do rascunho (senão `criar`). Atualizar = `product.update_item` só com os campos
  marcados (`opcoes.campos`: título, descrição e fotos ligados por padrão; **preço desligado por
  padrão** → `product.update_price`, por variação quando o anúncio tem variações). A prévia lê o
  anúncio AO VIVO e mostra hoje → vai ficar; o estado anterior (título, descrição, ids das
  fotos, preço) fica em `ia_publicacao.enviado.antes`. Avisos: anúncio com variações (texto e
  fotos valem para todas), fotos substituídas, descrição "extended" vira só texto, preço ×
  promoção. `ia_publicacao.operacao` (`criar`|`atualizar`, migração `ia_15`). A trava "já foi
  enviado" vale só para criar. Atualização mexe em anúncio NO AR — sempre com a confirmação da
  tela. **Não testado** (nem prévia nem envio do modo atualizar rodaram).
- **Fotos no modo atualizar NÃO substituem mais em bloco (`anuncio-publicar` v3, pedido do dono
  ao ver a 1ª prévia: 7 fotos atuais seriam trocadas por 1):** `opcoes.fotos = {manter: [image_id
  das atuais], novas: [caminho das aprovadas], posicao: inicio|fim}`. Padrão: TODAS as atuais
  ficam e todas as novas entram (no início se a 1ª nova é capa; senão no fim). Na tela, as fotos
  do anúncio e as novas são clicáveis (manter/tirar, incluir/não), com a escolha da posição e a
  fila final; a conferência se refaz sozinha 0,7 s depois do último clique. Limite de 9 fotos e
  "nada muda" viram pendência. A lista enviada mistura os `image_id` que já eram do anúncio com
  os das fotos novas recém-subidas — reaproveitar id antigo no `update_item` ainda não foi
  testado.
- **Mercado Livre (12/out, pedido do dono) — `anuncio-publicar` v4 (NO AR desde 12/out à
  tarde, com o OK do dono; o que subiu foi conferido por sha256 contra o repositório,
  `a63a0d8b…431fe2`).**
  Rascunho com canal `mercado_livre`; conta pela empresa (ottz 1107117809, svl 1299638625),
  token sempre DA CONTA. Mesma tela e a mesma conferência da Shopee (`Envio` em `Publicar.tsx`
  serve aos dois; textos/limites mudam pelo canal; `previa.limites`). O que a sondagem
  (`ml-anuncio-sonda`, só leitura + validador) mostrou e a função segue:
  - As duas contas estão no modelo **User Products**: o corpo de criação leva **`family_name`**
    e **NÃO pode levar `title`** (`body.invalid_fields`); o ML monta o título final.
  - Obrigatório: BRAND (+ o que a categoria pedir com `tags.required`, ex. MODEL), as medidas
    da embalagem `SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH` ("31 cm") e `_WEIGHT` ("450 g"),
    `SELLER_SKU` = nosso SKU. Código de barras: `GTIN` ou `EMPTY_GTIN_REASON` (17055160 "não
    tem código cadastrado"; 17055159 "kit ou pack" para produto tipo K) — em algumas
    categorias (ex. MLB178927) o motivo NÃO é aceito e o GTIN é exigido.
  - `shipping` pode ir `{mode: me2, local_pick_up: false, free_shipping: false}`; `sale_terms`
    (garantia do vendedor, 30 dias) é opcional. Preço ≥ ~R$ 79 → o ML põe frete grátis
    obrigatório (aviso).
  - **`POST /items/validate` devolve 400 "Validation error" mesmo quando só há `warning:`** —
    aceito = nenhuma causa `type: error`. `shipping.lost_me1_by_user` e
    `shipping.free_shipping.cost_exceeded` aparecem em todo anúncio nosso: ignorados. A prévia
    de criar passa o corpo no validador (fotos como URL assinada de 15 min) e os erros viram
    pendência.
  - Categoria: `/sites/MLB/domain_discovery/search?q=título` (também adianta características);
    limites em `/categories/{id}` (`max_title_length` 60, `max_pictures_per_item` 12);
    características em `/categories/{id}/attributes`. Tipo de anúncio padrão = o que a conta
    mais usa (Ottz: 256 Clássico × 81 Premium).
  - Existentes: **ao vivo** por conta, `/users/{id}/items/search?seller_sku=` + multiget (a
    gestão só espelha a Ottz em `ml_anuncios`). `existentes` devolve `mercado_livre_lojas
    {ottz, svl}` (null = não deu para consultar) além do `mercado_livre` antigo. Um SKU pode
    ter vários MLB (15984 tem 6, 3 de **catálogo**): a lista traz primeiro os editáveis.
  - Criar: fotos por `POST /pictures/items/upload` → `POST /items` (sem repetição) → **pausa**
    (`PUT {status: paused}`, padrão; o ML não cria pausado e exige estoque ≥ 1) → descrição
    (`POST /items/{id}/description {plain_text}`). Se a pausa ou a descrição falharem, o
    anúncio fica criado e o aviso aparece em destaque.
  - Atualizar: um passo por vez, para no primeiro que o ML recusar — fotos (`PUT /items/{id}
    {pictures: [{id}]}`, mesmo seletor manter/novas/posição), descrição (`PUT
    …/description?api_version=2`), título (**desmarcado por padrão**; pendência se o anúncio
    já vendeu; tenta `family_name` e depois `title`) e preço (desmarcado por padrão). Anúncio
    de catálogo: só preço. Anúncio com `variations` (modelo antigo): sem fotos/preço.
  - `ia_publicacao`: `canal 'mercado_livre'`, `shop_id` = user_id da conta, `item_id` = MLB,
    resposta enxuta (o corpo inteiro do ML tem ~15 kB e o banco está no teto).
  - **Limite de unidades por compra NÃO se altera pela API (testado 14/out/2026, com o OK do
    dono):** é o termo de venda `PURCHASE_MAX_QUANTITY` ("Quantidade máxima de compra"; 8 dos 20
    anúncios mais vistos da Ottz têm 1, 2 ou 15). A categoria o marca `read_only`/`hidden`; o
    validador recusa na criação e o `PUT /items` recusa a troca (1 → 2 no MLB7659304960:
    `sale_term.not_allowed`, nada mudou). Regravar o MESMO valor volta 200 — não prova nada. Dá
    para LER (multiget com `attributes=sale_terms`); mudar só no painel do ML. Sonda:
    `ml-anuncio-sonda` v5 `?teste=limite&mlb=[&valor=]` (expira em 15/out).
  - **Não testado ao vivo:** nenhum `enviar` (criar ou atualizar), o upload de foto, a troca de
    título e se anúncios da mesma família compartilham fotos.
- **Próximos:** TikTok, Amazon; anúncio com variações na Shopee.

## 5.11.6 IA · Anúncios — aproveitar o que já foi gerado e kits como no Tiny (12/out/2026)

Pedido do dono: o conteúdo feito para a Shopee serve para o Mercado Livre, e as artes do
produto base (Xô Gatinho, Adestrador) servem para todos os kits dele — sem gerar de novo.

- **Edge fn `ia-aproveitar` v1** (função separada da `ia-anuncio`, §2.1.5/§10; não precisou de
  DDL). Só copia dentro da gestão: nada vai a marketplace nem a IA.
  - `fontes {sku, canal, empresa, destino_id?}` → rascunhos de onde dá para TRAZER + a família.
  - `destinos {rascunho_id}` → produtos da família para onde dá para LEVAR as fotos.
  - `aplicar {origem_id, sku, canal, empresa, destino_id?, texto?, imagens[], substituir?,
    aprovadas?}` → um destino (cria o rascunho se faltar, por `ia_rascunho_criar` em nome do
    usuário, então nasce com o preço do canal).
  - `aplicar-lote {origem_id, skus[], canal, empresa, imagens[]…}` → vários produtos; orçamento
    de 22 s e `restantes` (a tela reenvia). Só aceita SKU da família da origem.
- **Família de um SKU** (`produto_kits`): ele mesmo, os componentes dele (se for kit) e os kits
  ATIVOS que contêm ele ou os componentes. Relação: `mesmo` · `componente` · `kit` (contém o
  produto aberto) · `irmao` (kit do mesmo componente). Medido: 10933 → 8 kits; 14560 (via 11538)
  → 10; 16170 (via 15820) → 25. Kit com mais de um componente aparece como "kit misto" e não
  vem marcado.
- **A foto aproveitada NÃO divide o arquivo com a origem.** O worker regrava
  `{sku}/{rascunho}/{ordem}-{tipo}.ext` ao "refazer" (upsert): se o destino apontasse para esse
  caminho, uma foto já aprovada mudaria sozinha. A função copia UMA vez para
  **`compartilhado/{sku de origem}/{tipo}-{12 do sha256}.{ext}`** e todos os destinos apontam
  para essa cópia (25 kits = 1 arquivo, ~1,3 MB por foto, e não 25). "Refazer" no destino grava
  no caminho do próprio destino. Para a origem refeita chegar aos kits: levar de novo com
  "substituir".
- **Regras de aprovação:** foto aprovada na origem entra aprovada (caixa desligável); as outras
  entram "para revisar". Texto só entra aprovado quando é o MESMO produto, estava aprovado e o
  título cabe no canal — senão fica para revisar com o aviso (Mercado Livre aceita 60
  caracteres; os da Shopee têm 53–79). Texto de outro produto nunca entra aprovado.
- **O que não vem marcado:** capa com selo da Shopee (`capa_*shopee*`) quando o destino não é
  Shopee; capa de OUTRO produto (mostra a quantidade errada); tipo que o destino já tem.
- **Tela:** bloco "Aproveitar o que já está pronto" em `/ia/gerar`
  (`src/components/ia/anuncio/Aproveitar.tsx`): lista as fontes com "Trazer para <canal>"
  (diálogo com texto + miniaturas) e, quando o anúncio aberto tem fotos e o produto tem
  família, "Levar as fotos deste anúncio para os kits" (escolhe fotos e produtos; cria os
  rascunhos que faltam). O preço NÃO é copiado: cada canal calcula o seu.
- **Kits como no Tiny:** composição (quantidade × componente) no topo de `/ia/gerar`
  (`ComposicaoKit`, com atalho para o componente) e na linha de `/ia/anuncios` (uma consulta a
  `produto_kits` só com os kits da página).
- **Variações como no Tiny — NO AR desde 12/out à noite (§5.11.9):** o espelho `produtos`
  guarda o pai de cada variação (`sku_pai`) e a lista `/ia/anuncios` mostra as variações
  dentro do pai (campo `variacoes` da RPC `ia_catalogo` v2). Lição do caminho: arquivo
  preparado e não aplicado NÃO fica em pasta temporária (foi limpa e o pacote teve de ser
  refeito a partir do histórico) — vai para `docs/`.
- **Não testado ao vivo:** nenhuma chamada com sessão de usuário (a prévia local para no
  login). Conferido: preflight 200, sem sessão 401, chave pública 401; `tsc` e `vite build` ok.
  A cópia de arquivo no Storage (`storage.copy`) é o passo a observar na 1ª vez.
  (12/out, tarde: o dono usou o "Trazer" no 14560 Shopee → Mercado Livre e funcionou.)

## 5.11.7 IA · Anúncios — um anúncio, vários destinos (12/out/2026)

Pedido do dono depois de testar o "Trazer": **sem botão de trazer para o mesmo produto** — o
anúncio é um só e o marketplace é escolhido nos cartões do bloco "3 · Enviar anúncio".

- **`anuncio-publicar` v5:** `previa` e `enviar` aceitam `destino {canal, empresa}`. Sem
  `destino` vale o canal/empresa do rascunho (como antes). Com destino diferente, o MESMO
  rascunho (texto + fotos aprovadas) é conferido e enviado para aquela loja; `ia_publicacao`
  grava o canal/empresa do DESTINO. Conferido por sha256 (`d8aa86ee…551b`).
- **Preço por destino:** `ia_rascunho.preco_aprovado` continua sendo o preço do canal do
  rascunho. O de outro destino fica em `memoria_calculo.destinos["canal:empresa"] = {preco,
  margem}` (gravado pelo `PainelPreco` quando o canal da tela não é o do rascunho). A função
  usa: `opcoes.preco` → o salvo para o destino → o sugerido por `ia_calcular_preco` daquele
  canal (chamado em nome do usuário). **Nunca** o preço do canal do rascunho.
- **Tela:** o canal/empresa da URL de `/ia/gerar` passou a ser o DESTINO (preço e envio).
  Sem rascunho exato daquele canal, abre o mais recente do produto; trocar canal/empresa no
  topo ou clicar em "enviar para cá" num cartão mantém o mesmo rascunho. Cartões: uma linha
  por loja (Shopee Ottz/Bumi, Mercado Livre Ottz/SVL) com "já anunciado" + botão. Sumiram
  "abrir o rascunho de <canal>" e o "Trazer" do mesmo produto; o bloco de aproveitar ficou só
  com a família de kit ("Usar as fotos deste produto" e "Levar as fotos para os kits").
- **Limites que continuam por canal:** título do Mercado Livre ≤ 60 (na atualização o título
  vem desmarcado); capa com selo da Shopee não deve ir para outro canal — na conferência,
  desmarque a foto em "Novas, aprovadas aqui".
- **Legado:** rascunhos de Mercado Livre criados pelo "Trazer" (ex.: 14560) continuam
  existindo como cópias; aparecem em "Outros rascunhos deste SKU".
- **Não testado ao vivo:** `previa`/`enviar` com `destino` diferente do canal do rascunho.
- **v6 (mesmo dia, 3 pedidos do dono; sha256 `fa824000…7da5`):**
  - **Clicar em "enviar para cá" já abre a conferência** (o `Envio` é remontado aberto; abrir a
    página sem clicar continua fechado, para não ler o marketplace à toa).
  - **Ordem das fotos manual:** as miniaturas de "Vai ficar com N fotos" (atualizar) e do
    anúncio novo (criar) são arrastáveis e têm setas; a primeira é a capa. A ordem fica só na
    tela e vai no `enviar` como `opcoes.fotos.ordem` (id de foto atual, caminho de foto nova
    ou `#N` = foto atual da posição N). Clicar em "no início / no fim" desfaz a ordem manual.
  - **"Atualizar também":** na conferência de atualização aparecem os OUTROS anúncios do
    produto no mesmo marketplace (outra conta/loja e outros códigos da mesma conta — no
    Mercado Livre, Ottz + SVL). Marcado, cada um é conferido em separado (`previa` com
    `destino` dele) e, no envio, recebe a mesma troca depois que o principal dá certo, um por
    vez. Como os ids de foto são de cada anúncio, as fotos atuais que ficam vão **por
    posição** (`opcoes.fotos.manter_pos`). Anúncio com pendência fica de fora e é avisado. O
    preço, se marcado, é o de cada destino (não o do principal).
  - **Não testado ao vivo:** `ordem`, `manter_pos` e o envio em sequência.
- **v7 — Amazon, só ATUALIZAR (12/out, sha256 `9fcce7f4…2f64`):** SP-API Listings Items
  (`GET/PATCH /listings/2021-08-01/items/{merchant_token}/{sku}`), conta pela empresa (shop
  900001 ACZ / 900002 SVL). O SKU na Amazon é procurado em: o nosso SKU, `FBA-<sku>`,
  `sku_mapeamento` e `estoque_fulfillment`. Atualiza `item_name`, `product_description` +
  `bullet_point` (campos separados; até 5 bullets) e as fotos (`main_product_image_locator` +
  `other_product_image_locator_1..8`; foto nova = endereço assinado do bucket por 7 dias, que
  a Amazon baixa; campo que sobra é apagado com `op: delete`). A prévia passa os patches no
  validador (`mode=VALIDATION_PREVIEW`, não aplica). Preço e criar anúncio novo: não.
  **SVL sem `merchant_token`** → erro claro. Ensaio real em 12/out (leitura do 15819 + preview
  do título = `VALID`) pelo diagnóstico `supabase/functions/amazon-anuncio-sonda`, que está
  publicado no slot **`amazon-lwa-debug`** (`?conta=ottz&sku=`): criar função NOVA no projeto
  falhou 3× com erro interno (atualizar existente funciona; suspeita: limite de funções — há
  ~90, várias `*-probe/-teste/-debug` sem uso que o dono pode apagar no painel; a MCP não apaga;
  **`shopee-devolucao-probe` NÃO pode sair: 4 crons usam**).
  **Não testado ao vivo:** `previa`/`enviar` da Amazon pela tela, fotos por endereço assinado.
- **Vínculo com o Tiny (12/out, relato do dono):** o anúncio CRIADO direto na Shopee (16452 →
  item 43435113505, `item_sku` = SKU do Tiny, não listado) **não ficou ligado ao Tiny**. Criar
  direto só serve depois de resolver isso (importar anúncios no Tiny, ou publicar pelo Tiny e
  só ATUALIZAR por aqui). Atualizar anúncio existente não tem esse problema.
- **Estrutura real de anúncio com variação de quantidade (print do dono):** Tiny tem um produto
  pai tipo V (ex.: 16181 "1 a 3 un") cujas variações são KITS do produto base (16176/16177/16178
  = 1×/2×/3× 15820); na Shopee o anúncio tem `item_sku` = pai e cada modelo com o SKU do kit.
- **Fotos em lote na família (12/out, pedido do dono):** botão "Atualizar as fotos em todos os
  anúncios da família" no bloco de aproveitar (`DialogoFamilia` em `Aproveitar.tsx`; só tela,
  sem função nova). **Regra do dono: em cada anúncio a CAPA atual fica (1ª foto) e as demais
  são trocadas pelas escolhidas** (`fotos: {manter_pos: [0], novas, posicao: "fim"}`, só o
  campo Fotos). Passos: escolher fotos aprovadas + produtos da família → `existentes` de cada
  SKU ao vivo (Shopee Ottz/Bumi, Mercado Livre Ottz/SVL, Amazon ACZ), deduplicado por anúncio
  (um anúncio com variações serve a vários SKUs) → confirmar → `ia-aproveitar aplicar-lote`
  (as fotos entram no rascunho de cada produto, `substituir: true`) → `anuncio-publicar
  enviar` um anúncio por vez, com "Parar". Anúncio de catálogo do ML vem desmarcado. Catálogo
  da Amazon (consulta de 12/out): Xô Gatinho unidade = ASIN B09SJT22QN (Pet Clean), Kit 2 =
  B0GNTS7RHT, sem restrição para a ACZ. **Não testado ao vivo.**

## 5.11.8 Criar no Tiny produto com variações de quantidade (12/out/2026)

Pedido do dono: a partir de um produto SIMPLES, criar pelo app o produto pai cujas variações
são kits do produto base (a estrutura do print: 16181 → 16176/16177/16178 = 1×/2×/3× 15820).
Como nasce no Tiny, o anúncio enviado depois PELO TINY já sai ligado (resolve o vínculo que
faltou no anúncio criado direto na Shopee).

- **Ensaio real autorizado (produto `TESTE-APP-208691`), o que a API do Tiny faz e não faz:**
  - v3 `POST /produtos` (tipo V + `grade: ["Tamanho"]` + `variacoes[{sku, precos, grade[{chave,
    valor}]}]`) cria pai e variações. **O SKU é OBRIGATÓRIO** no pai e em cada variação (sem
    ele: 400 "Este valor não deve ser nulo" — o Tiny NÃO numera sozinho pela API). A variação
    nasce `tipo S`.
  - v3 NÃO transforma variação em kit: `PUT /produtos/{id}/kit` = 400 "Produto não é do tipo
    'Kit'"; `tipo`/`kit` no corpo da variação são ignorados; `PUT /produtos/{idVariacao}` = 404.
  - **v2 `produto.alterar.php` com `classe_produto: "K"` + `kit: [{item: {id_produto,
    quantidade}}]` transforma a variação em kit** e mantém `tipoVariacao V` + `produtoPai`.
    Campos mínimos que funcionaram: `sequencia, id, codigo, nome, unidade, preco, origem,
    situacao, tipo: "P"`. Alterar um produto que JÁ é kit exige mandar a lista do kit de novo.
  - **Excluir não dá:** v3 `DELETE /produtos/{id}` = 403; v2 só aceita situação A ou I (não "E").
    Sobrou no Tiny o produto de teste: pai e 2 variações INATIVADOS, e a variação
    `TESTE-APP-208691-2` ainda ATIVA (virou kit) — apagar na tela do Tiny.
  - Achado útil: v3 tem `POST/PUT /produtos/{id}/anexos` (`{url, externo}`) — dá para mandar
    FOTO ao produto do Tiny por endereço (ainda não usado).
- **Edge fn `tiny-produto-variacoes`** (v1; v2 logo abaixo — JWT de usuário + módulo `ia`; conta Tiny `ottz`):
  `sugerir {base_sku}` (dados do produto + próximos SKUs livres = maior SKU numérico de 5
  dígitos do espelho + 1…) · `previa {…}` (confere tudo, inclusive SKU livre no espelho E ao
  vivo no Tiny; não escreve) · `criar {…, confirmar: true}` (POST do pai → v2 em cada variação
  → confere pelo GET → grava `produtos` e `produto_kits` na hora) · `kit {id_variacao,
  quantidade, base_sku, confirmar}` (refaz só o passo do kit). Copia do produto base: unidade,
  NCM, origem, GTIN, marca e categoria. O POST não é repetido; no código 6 da v2 a função para
  e as variações restantes ficam simples até o "tentar de novo". Registro em
  `debug_fulfillment` (`modulo = 'tiny-produto-variacoes'`, `etapa` = SKU do pai).
- **Tela:** menu "…" na linha de `/ia/anuncios` → "Criar produto com variações" (só produto
  simples) → `CriarVariacoes.tsx`: nome, SKU do pai, nome da grade ("Tamanho"), linhas (nome
  da opção, quantidade no kit, SKU, preço — sugeridos; preço = preço do base × quantidade;
  atalhos 1·2·3, 3·4·6, 6·12) → Conferir → Criar no Tiny (com confirmação) → resultado por
  variação. **Não testado pela tela** (sem sessão a função responde 401).
- **v2 (12/out, noite) — 1º uso real pelo dono (base 16452, Bento Mix 4kg):** a sugestão de SKU
  saía do ESPELHO (maior = 16475), mas o dono tinha criado 16476–16485 no Tiny horas antes (o
  espelho só atualiza de madrugada) → todas as linhas recusadas com "já existe no Tiny: Areia
  Higiênica Bumi Pet Mix…", lido como "o sistema confundiu Bento com Bumi". Corrigido: `sugerir`
  confere os números **ao vivo no Tiny** (`skusLivres`: parte do maior do espelho, sonda 6 por
  vez, até +72) e só devolve os livres; a recusa agora diz `SKU X já está em uso no Tiny por
  OUTRO produto ("nome"): troque o número`. **Areia vai por PESO** (regra do dono): quando o nome
  do base casa `areia|granulado|sílica` e tem peso (`extrairPeso` de `src/lib/prazo.ts`), as
  opções nascem "4kg, 8kg, 12kg…" (peso da embalagem × quantidade do kit), o nome do pai troca
  o peso pela faixa ("… 4kg a 20kg"), o padrão é 1–5 embalagens e os atalhos são em kg. Demais
  produtos seguem em "N unidades".
- **v4 (12/out, ~21h50) — foto herdada + filtro "Criados no app" (pedido do dono):**
  - **Foto:** o pai e cada variação nascem com a **foto principal do produto base** (1º anexo
    dele no Tiny). `POST /produtos/{id}/anexos` com corpo `[{url, externo}]`: com
    **`externo: false` o Tiny BAIXA e guarda uma cópia própria** (arquivo novo no S3 dele, 221 kB
    conferidos) — a foto não morre quando a do base for trocada; a função só cai para
    `externo: true` se o Tiny recusar (400/422). A resposta do POST às vezes vem sem o endereço
    da cópia (3 de 6): o espelho fica com o endereço do base até o detalhe reler. Módulo
    `foto {sku_pai, confirmar}` põe a foto em quem da família ainda não tem (menu "…" do pai →
    "Copiar a foto do produto base"). Feito na família 16486 (base 16452): 6 de 6 com foto no
    Tiny. Na lista a foto vem de `mv_foto_produto_v2` (refresh 3/3 h).
  - **Marca de origem:** `produtos.criado_app_em` + `sku_base` (migração
    `produtos_criado_app_e_filtro`; a listagem do Tiny não toca nelas; backfill pelo registro em
    `debug_fulfillment`).
  - **Filtro:** `ia_catalogo` **v2.1** (`versao: 5`): `p_tipo = 'APP'` = produtos criados no app,
    `tipos.APP` com a contagem, `criado_app` em cada linha. A migração troca 9 trechos da função
    NO AR (cada um precisa existir uma vez) e confere o resultado na mesma transação; o
    arquivo `docs/catalogo-espelho-tiny/ia_catalogo_variacoes.sql` recebeu as mesmas trocas (md5
    do corpo igual ao do banco). Na tela: botão "Criados no app" na fileira de tipos e selo
    "criado no app" na linha.
  - O produto de teste `TESTE-APP-208691-2` ganhou a foto do 16452 no ensaio (é para apagar).
    A rota de ensaio `foto-ensaio` da função morre sozinha à meia-noite de 12/out (prazo no
    código), como a `inativar-teste` que ela substituiu.
- **Cor × quantidade — várias bases, duas grades (14/out/2026, pedido do dono: Carpete
  Autocolante 16075–16079, uma cor por SKU):** em `/ia/anuncios` cada produto SIMPLES tem uma
  caixa de seleção; com 2+ marcados, "Criar produto com variações (cor × quantidade)" abre
  `CriarVariacoesCores.tsx`: cores tiradas do nome (`[Bege]`, ou o que sobra depois do começo
  comum), quantidades ("1, 2, 3"), grade COMPLETA cor × quantidade com SKU (próximos livres,
  conferidos no Tiny) e preço (preço da cor × qtd) editáveis.
  - **`tiny-produto-variacoes` v6 (deploy 8):** aceita `grades: ["Cor","Quantidade"]` e, por
    variação, `base_sku` + `valores: ["Bege","2 un"]` → no Tiny `grade` com duas chaves e cada
    variação vira kit de N× o produto DA COR dela (vender "Marrom · 2 un" baixa 2 do 16076). Sem
    `grades` = formato antigo, uma base. Conferência: todas as bases simples, grade completa
    (Shopee exige), até 50 variações, opção ≤ 20 letras e grade ≤ 14. SKUs ocupados conferidos no
    Tiny de 6 em 6 (`sugerir` aceita até 51).
  - **Tempo:** cada kit custa ~3 s (GET + v2 + GET) e o limite é ~30 s. O espelho (`produtos`,
    `sku_base` = a cor) é gravado logo depois do POST; os kits param aos ~20 s e voltam com
    `pendente: true`; a tela termina chamando `kit` um a um (código 6 da v2 = espera 60 s) e
    depois `foto` até não haver `pendente` (a `foto` agora para aos ~22 s e pula quem já tem foto
    no espelho). Cada variação recebe a foto do produto DA COR dela (`produto_kits` → componente).
  - **`?modulo=grade {sku_pai}`** (só leitura): grades e valores de cada variação, ao vivo do Tiny.
  - **Shopee (`anuncio-shopee-variacoes` v6):** `grade2` + `opcao2` → `tier_variation` com dois
    grupos e `tier_index [cor, qtd]`; grade completa obrigatória; foto só no 1º grupo (a da 1ª
    variação de cada cor). `VariacoesShopee` só lê a grade do Tiny quando as variações são kits de
    produtos DIFERENTES (produto de uma base segue igual) e mostra a 2ª coluna de opção.
  - `FotosVariacoes`: variação de outra cor usa a foto DELA (catálogo ou referência do produto da
    cor), nunca a do pai.
  - **Não testado ao vivo** (criação no Tiny e na Shopee exigem sessão). Os carpetes não têm foto
    no Tiny: as variações nascem sem foto.
  - **Nome da opção cortado (19/out, pai 16594 "Kit Atacado Toalhas Umedecidas", bases 15962/15963/15964):** sem
    `[Cor]` no nome, a opção era "o que sobra depois do começo comum" cortado na 20ª letra → "Higiene Face Olhos F",
    "Limpa Popô Pet Clean" (com a marca e sem o "50 Un"). Agora (`rotulosDasCores`) o começo comum é por palavra
    inteira, sai a quantidade do fim ("50 Un", "500ml") e a marca do produto, e o corte de 20 letras não parte
    palavra ("Higiene Face Olhos", "Limpa Popô", "Limpa Patas Passeio"); sem `[Cor]` o grupo nasce "Tipo", não "Cor".
    Na tela da Shopee (`VariacoesShopee`) o nome do grupo guardado no navegador só vale se foi digitado sobre a MESMA
    grade do Tiny (`grades_tiny` no `localStorage`): a tela aberta antes de os kits existirem guardou "Tamanho" e ele
    passava por cima do "Cor" do Tiny. O 16594 continua com os nomes antigos no Tiny (a opção da Shopee pode ser
    corrigida no próprio bloco antes de enviar; o vínculo é pelo SKU).
  - **Pai duplicado 16523 (14/out, inativado com o OK do dono):** criado com o MESMO nome do 16506 —
    o Tiny recusou transformar as variações em kit ("Registro em duplicidade - nome do produto já
    cadastrado"), e 16524/26/28/30 ficaram simples. Inativados pela v2 (`produto.alterar.php`,
    situação "I"; o pai ganhou " (duplicado, inativo)" no nome) pela rota temporária
    `inativar-16523` da v6 (deploy 9; expira 15/out). Excluir de vez só na tela do Tiny. **Lição:**
    nome de produto repetido no Tiny barra o `alterar` da v2 — o "Criar" deveria recusar nome já
    usado (pendente).
- **Fotos das variações (12/out, ~22h30, pedido do dono):** na página do produto PAI
  (`/ia/gerar?sku=<pai>`, tipo V) o bloco "Fotos das variações"
  (`src/components/ia/anuncio/FotosVariacoes.tsx`) gera UMA foto por variação: cena ambientada
  com a quantidade de embalagens da variação (quantidade do kit em `produto_kits`). Caixa "Selo
  só com o peso/quantidade" (ligada por padrão): ligada usa o estilo 4
  (`imagem_capa_ambientada_texto`) com o selo recebendo SÓ o nome da opção ("8kg"); desligada
  usa o estilo 5 (`imagem_capa_ambientada_limpa`, nenhum texto). **Sem função nova no
  servidor** — a tela encadeia, por variação: (1) copia o briefing do pai para o SKU da
  variação (`ia_briefing` é por SKU e o `prompts-imagem` exige um; não gasta IA); (2)
  `ia-anuncio?modulo=prompts-imagem` com `capa {quantidade, peso (o da embalagem, lido do nome
  do componente), faixa, sem_texto}` e `forcar`; (3) `ia_rascunho_criar` se a variação não tem
  rascunho; (4) `ia-anuncio?modulo=imagens`. A foto mora no rascunho da PRÓPRIA variação (tipo
  `capa_ambientada_*`), então aparece também ao abrir a variação. A referência é a foto da
  variação no Tiny (nas criadas pelo app = a foto principal do base). Custo: o do modelo
  (US$ 0,21 por foto no padrão), mostrado antes de confirmar. **Não testado de ponta a ponta**
  (precisa de sessão e gasta imagem): só tsc/build e os dados conferidos no banco.
  **Aproveitamento automático (14/out/2026, pedido do dono):** ao abrir o bloco, a variação SEM foto
  que é o mesmo kit (um componente, mesmo produto base, mesma quantidade em `produto_kits`) de uma
  variação de OUTRO anúncio com capa ambientada **aprovada** recebe essa foto sozinha, já aprovada,
  por `ia-aproveitar?modulo=aplicar` (cópia em `compartilhado/…`, sem IA e sem custo) — ex.: 16521
  (8kg = 4× 16362, pai 16515) usa a do 16513 (pai 16506); 16522 (10kg) a do 16514. Variação com
  foto própria, rejeitada ou gerando não é tocada; o "Gerar as N que faltam" não conta as que vão
  ser aproveitadas. `fotosGemeas()` em `FotosVariacoes.tsx`.
  **Não feito:** mandar essa foto ao Tiny como foto da variação e criar na Shopee o anúncio COM
  variações (`anuncio-publicar` só cria anúncio simples — é o aviso "este produto tem
  variações no Tiny" da tela de envio).
- **Lista de anúncios (mesmo dia):** filtro "Fotos da família, sem capa própria" e ordem "Mais
  vendidos (geral · 120 dias)" — a tela só mostra os dois quando a RPC `ia_catalogo` responde
  `versao >= 2`. **RPC v1.1 APLICADA em 12/out às 18h18** (migração
  `ia_catalogo_filtros_sem_capa_vendas120`, `docs/ia-catalogo-filtros.sql`; o dono mandou
  aplicar antes das 19h — foi só um `create or replace function`, e a API respondeu em 0,6 s
  logo depois). "Sem capa" = tem foto em `compartilhado/…` e nenhuma capa PRÓPRIA aprovada; no
  dia eram 8 produtos do Xô Gatinho.
- **Filtro por tipo, como as abas do Tiny (12/out, 19h07):** RPC `ia_catalogo` **v1.2** —
  migração `ia_catalogo_filtro_tipo`. A função passou a ter **8 parâmetros** (`p_tipo` no fim:
  `S` simples, `K` kit, `V` com variações = o pai); a de 7 foi removida no mesmo passo (duas
  com o mesmo nome deixariam a chamada ambígua) e as permissões foram refeitas (só
  `authenticated` e `service_role`). A resposta traz `versao: 3` e `tipos {todos, S, K, V}`.
  As contagens se cruzam: `contagem` (situações) dentro do tipo escolhido e `tipos` dentro da
  situação escolhida. Na tela, segunda fileira de botões em `/ia/anuncios` (`?tipo=`).
  **Quem mexer na `ia_catalogo` precisa manter os parâmetros** — desde 19/out são **9** (`p_giro` no fim,
  §5.11.11.15); a fonte única é `docs/catalogo-espelho-tiny/ia_catalogo_variacoes.sql` (`versao: 6`).

## 5.11.9 Catálogo = espelho do Tiny (aplicado em 12/out/2026, 19h50–20h10)

Pacote de `docs/catalogo-espelho-tiny/` (aprovado em 07/out, "pode rodar" em 12/out). O que
ficou no ar:
- **Banco** (migrações `carga_09out_indices_escrow`, `catalogo_01_espelho_tiny`,
  `ia_catalogo_v2_variacoes_no_pai`): colunas novas em `produtos` (`situacao` A/I/E, `gtin`,
  `unidade`, `tipo_variacao`, **`sku_pai`**, `id_tiny_pai`, `tiny_alterado_em`,
  `tiny_visto_em`, `estoque_atualizado_em`; `estoque` passou a ser preenchido), tabela
  `tiny_sync_estado`, `view_catalogo` (security_invoker; 25 ms), RPC `catalogo_resumo()`.
  De carona: 2 índices parciais e janela de 30 dias em `pedidos_sem_escrow_componente`
  (4 s → 38 ms; não havia pendente mais velho que isso).
- **`tiny-sync-produtos` v29** (v28 + ajuste): listagem **retomável** em 3 fases (ativos →
  inativos → excluídos; estado em `tiny_sync_estado`; a passada inteira coube em 2 chamadas,
  26 s + 6 s). Em I/E só marca `ativo=false` no que o Tiny DEVOLVEU. `detalhar` grava
  estoque, situação, GTIN, unidade e o pai; o detalhe do pai liga os filhos de uma vez
  (`detalhar&pais=1`). **v29: 404 no detalhe = produto apagado de vez no Tiny** (não vem em
  lista nenhuma) → `ativo=false`, `situacao='E'` e detalhe carimbado. Motivo: 26 fantasmas
  ficavam "ativos" para sempre e, por serem sempre os mais antigos, gastavam as vagas de TODA
  rodada do refresh — o "ciclo de ~28 h" do §3 não era verdade (detalhe mais antigo: 01/ago).
  Se o Tiny voltar a listar o SKU, a listagem do dia reativa sozinha.
- **Resultado medido:** espelho 2.318 → **2.267 ativos** = 2.261 do Tiny + 6 criados pelo dono
  no app na mesma hora. 80 saíram: 52 inativos no Tiny, 2 excluídos, 26 inexistentes (404).
  Nenhum tinha saldo no Geral; com venda em 30 d só **15126** (Tapete Bumi 80x60, 4 un,
  inativo no Tiny) e **14133** (Shampoo Duprat, 31 un, não existe mais no Tiny). Custo e tipo
  de quem ficou: zero mudanças. `view_inventario_produtos` 1.149 → 1.099,
  `view_produtos_margem` 2.331 → 2.267; cobertura e SKUs-alvo de compras iguais. 223 pais,
  **985 variações ligadas**.
- **`ia_catalogo` v2** (`versao: 4`, mesmos 8 parâmetros): variação com pai ativo sai do
  topo e vem em `variacoes` do pai; o pai soma a venda, os canais e a situação delas e
  aparece na busca pelo SKU/nome da filha. Topo: 2.293 → **1.296 linhas**; 1,0 s por página.
  A migração se confere sozinha (total = contagem independente; senão desfaz tudo). A aba
  "Kits" conta só kit SEM pai (381): kit que é variação fica dentro do pai, como no Tiny.
- **Tela `/produtos` (Catálogo) nova:** lê `view_catalogo` paginado no banco + `catalogo_resumo`
  (antes baixava `view_produtos_margem` inteira). Variações dentro do pai, composição do kit,
  filtros tipo/marca/categoria e pendências (sem foto 279, sem custo 158, kit sem composição
  14), cartão "Sincronização com o Tiny" e botão "Gerar anúncio" (módulo `ia`; não no pai).
  **Não conferida na tela** (exige login) — tsc e build ok; leitura como usuário logado
  testada no banco (2.281 linhas na hora).
- **`tiny-produto-variacoes` v3:** o produto criado pelo app já nasce no espelho com
  `situacao`, `tipo_variacao` e `sku_pai` (aparece agrupado na hora). 1º uso real do dono
  (v2, 12/out ~19h55): pai **16486** "Areia Higiênica Bento Mix… 4kg a 20kg" + 5 variações
  kit (4kg…20kg), todas viraram kit.
- **Crons:** 19 (listagem) passou a `3,13,23 8 * * *` (a 2ª e a 3ª saem sem chamar o Tiny
  quando a passada do dia já fechou).
- **Reverter:** `_bkp_produtos_ativo_12out` guarda `ativo/tipo/custo/preco` de antes
  (sem acesso pelo app; apagar depois de alguns dias). Função: publicar de novo
  `tiny-sync-produtos-v27-no-ar.ts` (as colunas novas são ignoradas por ela).
- **Fica para depois:** `produtos.tipo_variacao` nulo nas variações que só o pai ligou
  (preenche na listagem do dia seguinte); 10 variações cujo pai é fantasma ficam soltas.

## 5.11.10 Abas do anúncio: Análise e Preço e promoção (12/out/2026, ~22h40)

A página `/ia/gerar` ganhou abas na URL (`?aba=analise|preco`; sem `aba` = o anúncio de
sempre). Pedido do dono; **começa pela Shopee**. Nenhuma edge function nova.
- **Análise** (`AnaliseProduto.tsx`) — uma chamada à RPC **`ia_analise_sku(p_sku, p_dias)`**
  (`docs/ia-analise-sku.sql`, security definer + `tem_modulo('ia')`): `dias` (unidades e
  receita por dia e marketplace, de `pedido_itens` × `pedidos_validos`, dia em Brasília),
  `canais` e `anuncios` (30 dias: margem de contribuição, ADS e margem pós-ADS da matview
  `ads_margem_anuncio` — Shopee e ML; o app NÃO tem grant nessa matview, por isso a RPC),
  `historico` (`ia_hist_sku_canal`, cobre Amazon/TikTok sem ADS) e `estoque` por SKU
  FÍSICO (kit = o componente): Geral do Tiny, Full, em trânsito, custo, **valor em estoque**,
  venda/dia e cobertura (`view_cobertura_fornecedor`, que explode os kits — o Full guardado
  como kit no CD só aparece nela). Produto pai = soma das variações. SKU vendido = `sku_filho`;
  `sku_pai` só sem variação ou na Amazon. A 1ª chamada numa conexão fria levou 6–8 s (as
  seguintes < 1 s) — o limite do app é 8 s; se estourar, recarregar resolve.
- **Preço e promoção** (`PrecoPromocao.tsx`) — por loja Shopee (a da tela primeiro): os
  anúncios do SKU e as variações (espelho `shopee_anuncios`/`_variacao`; anúncio cujo
  `sku_pai` é o produto entra com TODAS as variações), preço de hoje × cheio, **MC no preço**
  (mesma regra da tela Promoções: `promo_mc_base` + `calcMc` + tabela de comissão), e:
  - **Minha Promoção:** a tela descobre os descontos do anúncio lendo `shopee-promocoes
    ?modulo=list` (em andamento + programados, até 15) e o `detalhe` de cada um — não existe
    módulo "em qual desconto este item está". Editar o preço chama o MESMO
    `atualizar-itens&confirmar=1&propagar=1` da tela Promoções (o item vai com todas as
    variações do desconto; só a alterada muda), com confirmação mostrando de → para e a MC.
  - **Relâmpago:** o preço fica em `flashsale_programacao` (editar, pausar, ou "Pôr na
    relâmpago" com o teto estimado de `tetoRelampago`). Vale para as PRÓXIMAS relâmpagos que o
    app cria; **a API não troca o preço de item que já está numa relâmpago** (a
    `shopee-flashsale` não tem módulo para isso — só remover o anúncio inteiro e pôr de novo).
  - Não muda o preço CHEIO do anúncio (isso é no envio, aba Anúncio).
- **Não testado na tela nem com escrita real** (exige login): tsc/build ok, RPC conferida no
  banco com 15836 (kit), 16486 (pai) e 15679 (simples).

## 5.11.11 Anúncio COM variações na Shopee — 2º passo (12/out/2026, ~23h)

O dono não conseguia "enviar direto" anúncio com variações: a `anuncio-publicar` só cria
anúncio SIMPLES (aviso "este produto tem variações no Tiny…"). Em vez de mexer nela (1.243
linhas, crítica), entrou o 2º passo que a própria Shopee pede:
- **Edge fn `anuncio-shopee-variacoes` v1** (JWT de usuário + módulo `ia`): `previa` lê o
  anúncio ao vivo (`get_item_base_info`) e confere; `criar {…, confirmar: true}` chama
  **`product/init_tier_variation`** com `tier_variation: [{name, option_list: [{option,
  image?}]}]` e `model: [{tier_index: [i], original_price, model_sku, seller_stock:
  [{stock}]}]`. Limites conferidos antes: grupo até 14 letras, opção até 20, 2 a 50 variações,
  foto da opção = todas ou nenhuma, aviso se a mais cara passa de 5× a mais barata. **Recusa
  anúncio que já tem variações** (trocar opção de anúncio que vende derruba o histórico). Sem
  repetição da escrita; registro em `debug_fulfillment` (`modulo = 'anuncio-shopee-variacoes'`,
  `etapa` = item_id).
- **Tela:** bloco "Variações no anúncio da Shopee" (`VariacoesShopee.tsx`) na aba Anúncio do
  produto PAI, quando o destino é Shopee, logo abaixo do envio. Traz o ID do anúncio criado
  (`ia_publicacao` ou o espelho; dá para digitar), o nome do grupo ("Tamanho"), e por variação:
  opção (o fim do nome, ex. "8kg"), SKU, preço (o do Tiny) e estoque; usa a foto da variação
  (bloco Fotos das variações) quando TODAS têm. Conferir → Criar (com confirmação) → relê o
  anúncio no espelho.
- **Fluxo do dono:** (1) preço no bloco Preço + peso/medidas → "Criar o anúncio na Shopee" (fora
  do ar); (2) neste bloco, "Criar as variações na Shopee"; (3) conferir no Tiny o vínculo pelo
  SKU e ativar no Seller Center.
- **Um envio só para o operador (ajuste do mesmo dia):** o dono abriu a tela e, sem anúncio criado,
  os botões do bloco ficavam apagados ("não aparece para enviar as variações"). O bloco subiu
  para ANTES do envio e ganhou a caixa "Criar as variações junto com o anúncio" (ligada): ao
  terminar de criar o anúncio, o `Publicar` dispara o evento `ia-anuncio-criado` (`{canal,
  empresa, sku, item_id}`) e o bloco chama o `criar` no anúncio novo, sem outro clique. Se as
  variações falharem, o anúncio simples fica criado e o bloco mostra o ID para tentar de novo. O
  aviso do servidor ("criar gera um anúncio simples") é reescrito na tela.
- **Ajustes na conferência do envio (13/out/2026, pedido do dono):**
  - **Fotos maiores** (144 px, clique amplia) e **X para tirar** a foto no modo "criar". A
    `anuncio-publicar` não tem exclusão de foto ao criar (`opcoes.fotos.ordem` só ordena; manda
    as 9 primeiras APROVADAS), então tirar = **rejeitar a etapa da imagem** (`ia_rascunho_imagem`
    por `storage_path` → `ia_etapa.imagem_id` → RPC `ia_etapa_rejeitar`). Vale para TODOS os
    destinos do rascunho; volta aprovando de novo no bloco Fotos. No modo "atualizar" seguem os
    seletores manter/incluir.
  - **Preço editável** na caixa: vai em `opcoes.preco` (a função já aceitava) — só deste envio,
    não muda o preço aprovado; precisa "Atualizar a conferência".
  - **Título editável** na caixa: a função só lê `ia_rascunho.titulo`, então "Salvar título"
    grava no rascunho (o mesmo para todos os destinos) e reaprova a etapa de texto se ela estava
    aprovada (o gatilho devolve a "para revisar" quando o texto muda).
  - **Peso e medidas por variação** (`anuncio-shopee-variacoes` **v2**): cada variação aceita
    `peso_kg` e `comprimento_cm`/`largura_cm`/`altura_cm` (os três juntos) → `weight` e
    `dimension {package_length, package_width, package_height}` (cm inteiros) no `model` do
    `init_tier_variation`. Em branco não manda (valem os do anúncio). A tela sugere o peso
    quando a opção é "8kg"/"500g". **Não testado ao vivo:** se a Shopee recusar esses campos no
    `init_tier_variation`, o caminho é `product/update_model` depois de criar.
- **Shopee: preço padrão a 30% de MC, nasce NO AR, e já entra em Minha Promoção (13/out/2026, à
  tarde, pedido do dono):**
  - **Preço padrão:** `ia_canal_config.margem_alvo_pct` da Shopee passou de 0,175 para **0,30**
    (dado, editável em IA › Prompts › Canais). O `preco_sugerido` guardado nos rascunhos antigos
    é o da margem velha e a `anuncio-publicar` lê o guardado — por isso a conferência (`Publicar`)
    calcula na hora `ia_calcular_preco(sku, 'shopee', empresa, null)` e já abre com esse preço
    em `opcoes.preco` quando o destino NÃO tem preço aprovado (preço aprovado no bloco Preço
    continua mandando). As variações (`VariacoesShopee`) também nascem com o preço da margem
    padrão, SKU a SKU (kit incluso); sem custo na gestão, fica o preço do Tiny.
  - **No ar:** `opInicial` da Shopee = `fora_do_ar: false` (Mercado Livre segue pausando). Com
    variações, o anúncio simples nasce FORA do ar e a `anuncio-shopee-variacoes` **v3**
    (`ativar: true`) o põe no ar com `product/unlist_item` (unlist=false) logo depois de criar
    as opções — o comprador nunca vê o anúncio sem as variações/preços. Se a ativação falhar, as
    variações ficam criadas e a tela avisa para ativar no Seller Center.
  - **Minha Promoção no envio** (`PromocaoNoEnvio.tsx`, dentro da conferência de CRIAR): escolhe
    uma promoção em andamento ou programada (`shopee-promocoes?modulo=list`) e a margem do preço
    promocional — **10%, 15%, 17,25% ou 20%** (`FAIXAS_PROMO`; padrão 17,25%). Preço promocional
    de cada SKU = `ia_calcular_preco(sku, 'shopee', empresa, faixa)`, editável. Anúncio pronto →
    `add-itens&confirmar=1&propagar=1` (item simples = `item_promotion_price`; variações =
    `model_list` com o `model_id` da resposta do `init_tier_variation` ou, na falta, do espelho
    `shopee_anuncios_variacao`). Promocional ≥ preço cheio ou sem preço = fica de fora, com aviso.
    Sem repetição automática: "Tentar cadastrar de novo" é clique. A última promoção/margem
    escolhida fica no `localStorage` (`ia.envio.promo.<empresa>`).
  - **Também no ATUALIZAR (20/out/2026, pedido do dono):** o bloco aparece na conferência de
    atualizar anúncio Shopee que já existe (contexto `EnvioAlvoContext` em `PromocaoNoEnvio.tsx`:
    modo, `itemId`, preço cheio que vai ficar e o de hoje). Lê o `detalhe` das promoções em
    andamento/programadas para achar em qual o anúncio está (pré-escolhe essa, com "hoje R$ x" por
    SKU); variações vêm de `shopee_anuncios_variacao` do próprio anúncio. Ao terminar a atualização
    (`EV_PRONTO` também no modo atualizar): já está na promoção escolhida → `atualizar-itens`
    (mantém `purchase_limit` e o preço das outras variações); senão `add-itens` (aviso: a Shopee
    costuma recusar o mesmo anúncio em duas promoções). Botão "Só trocar/cadastrar agora" faz só a
    promoção, comparando com o preço cheio de HOJE. **Atualizar também (20/out, pedido do dono):** cada anúncio Shopee marcado ali (ex.: Bumi) ganha o SEU bloco, com as promoções da loja dele e "Só cadastrar na promoção agora"; no envio, a promoção dele entra depois da atualização dele. Os avisos (`ia-anuncio-vai-criar` / `-pronto`) levam o `item_id` e cada bloco só responde pelo seu anúncio (prop `promoPara` de `Publicar`).
    **Não testado ao vivo.**
  - **Como os blocos conversam** (`src/lib/iaEnvioEventos.ts`): `ia-anuncio-vai-criar` (síncrono,
    detalhe mutável: variações e promoção dizem o que farão — entra no texto da confirmação) →
    `ia-anuncio-criado` (`ativar`) → `ia-anuncio-pronto` (item, modelos, preços cheios).
  - **1º uso real (13/out, print do dono):** SKU 16453 criado NO AR na Shopee Ottz (item
    56419164656) e cadastrado na hora na promoção escolhida a 15% (R$ 26,73) — anúncio SIMPLES:
    criar ativo + `add_discount_item` imediato funcionam. Variações (`unlist_item` + promoção por
    `model_id`) seguem sem teste real.
  - **Enviar também (13/out):** depois de criar num destino, a conferência mostra o quadro verde
    "Anúncio criado … Enviar também para" com um botão por marketplace/loja pronta (Shopee
    Ottz/Bumi, Mercado Livre Ottz/SVL, Amazon ACZ/SVL), dizendo se já existe anúncio lá; o clique
    troca o destino e abre a conferência dele no mesmo lugar (`demais`/`onIr` no `Envio`).
    Amazon sem anúncio fica desabilitada (ainda não cria).
  - **Trocar de marketplace jogava a tela para o topo (13/out, relato do dono: "como que para
    aprovar novamente e escolher as fotos de novo"):** o roteador tem `scrollRestoration: true` e
    toda troca de destino é uma navegação (`nav({search})`) — sem `resetScroll: false` a página
    voltava ao início. Além disso o `apoioQ` de `ia.gerar.tsx` é por canal e, enquanto
    recarregava, o bloco Fotos sumia e voltava do zero, e o `Aproveitar` remontava. Agora:
    `set()` com `resetScroll: false`, `placeholderData` no `apoioQ`, `Aproveitar` com chave só
    pelo SKU, a conferência do destino escolhido rola para a vista (`scrollIntoView` "nearest") e
    a **ordem das fotos** arrumada num destino vale nos outros (`ordemComum` no `Publicar`).
    Regra: navegação que só muda parâmetro da tela (aba, filtro, destino) leva `resetScroll: false`.
  - **Não testado ao vivo (variações):** (`unlist_item`, `add_discount_item` em anúncio recém-criado
    — pode haver atraso de indexação —, e a faixa de preço: no degrau dos R$ 80 da tarifa a
    conta dá saltos, ex. 16497 a 30% = R$ 108,70 e a 20% = R$ 69,00).
- **Não testado ao vivo** (precisa de sessão e cria de verdade). Mercado Livre e Amazon com
  variações: não feito.

## 5.9.1.1 Relâmpago: o limite de 50 é por VARIAÇÃO (13/out/2026)

A Ottz ficou **5 dias sem relâmpago** (09 a 13/out: 0 itens) e a Bumi em 13/out. A tela
mostrava "0 adicionado(s) · 75 falha(s) — exceed the max number of item limit per promotion".
- **Causa:** a Shopee aceita **50 variações (modelos) por relâmpago** — anúncio sem variação
  conta 1 — e, quando o envio passa disso, **recusa TUDO** (`shop_flash_sale_exceed_max_item_
  criteria`), não só o excedente. A `shopee-flashsale` contava 50 ANÚNCIOS. Medido: 41 e 43
  variações entram; 58 e 72 não. Estourou quando a programação cresceu (Ottz: +29 linhas em
  07/out → 72; Bumi: +16 em 12/out → 58).
- **v10 (deploy 23):** cada envio leva anúncios INTEIROS até somar 50 variações (o que a
  relâmpago do dia já tem conta, lido de `get_shop_flash_sale_items`), na ordem de **quem vende
  mais em 30 dias** (RPC `promo_mc_base`); o resto vira "não coube". `dia` = hoje passa a
  enxergar a relâmpago EM ANDAMENTO (`type: 2`), para completar a do dia que nasceu vazia. A
  prévia devolve tudo em variações + `nao_cabem_skus`.
- **Na data:** Ottz 83 linhas ativas (81 válidas) → 50 entram, 31 ficam de fora; Bumi 59 → 50
  entram, 9 ficam. Quem fica de fora é sempre quem vende menos (inclusive produto novo sem
  venda): para entrar, pausar outra linha na programação. Só existe 1 relâmpago por dia.
- **Relâmpago que JÁ COMEÇOU não aceita produto (testado 13/out, 11h, com o OK do dono):**
  `add_shop_flash_sale_items` na relâmpago em andamento das duas lojas devolveu
  `shop_flash_sale_is_not_enabled_or_upcoming` para os 50 itens — nada foi alterado. Ou seja,
  o `type: 2` da v10 serve só para ENXERGAR a do dia (não criar outra por cima); **dia que
  nasceu vazio fica vazio**, não há conserto pela API depois da meia-noite. O que salva é
  conferir ANTES: a relâmpago de amanhã é criada às 18h07 e pode ser completada até 23h59.
- **Lição:** falha do cron das 18h07 fica em `flashsale_criadas.status = 'erro'` e vai ao
  Discord (#atualizações), mas ninguém viu por 5 dias — vale um alerta mais forte quando a
  relâmpago do dia fecha com 0 itens.

## 5.11.11.1 Fotos do anúncio → Tiny, e a foto do produto no sistema na hora (13/out/2026)

Pedido do dono: quando as fotos de um produto são cadastradas, o sistema já mostra a foto e as
principais vão para o Tiny (na lista de anúncios o 16453 aparecia sem foto, com anúncio criado).
- **Edge fn `tiny-produto-variacoes` v5** (deploy 7), módulo **`fotos-anuncio`**
  `{itens: [{sku, paths}], confirmar?}`: sem `confirmar` devolve só quantas fotos o produto tem no
  Tiny; com, cada foto aprovada (bucket privado `ia-anuncios`, endereço assinado de 2 h) entra por
  `POST /produtos/{id}/anexos` com **`externo: false`** — o Tiny guarda uma CÓPIA; nunca como
  endereço externo, porque o assinado vence. Só aceita caminho que é de um rascunho daquele SKU.
  Depois relê o produto e grava o 1º anexo em **`produtos.foto_capa`** (a foto do produto no
  sistema). Para aos ~24 s e devolve `faltou`; a tela continua de onde parou (não repete foto já
  enviada). Registro em `debug_fulfillment` (`modulo = 'tiny-fotos-anuncio'`).
- **Tela:** bloco "Fotos no Tiny" na conferência do envio (`FotosTiny.tsx`, dentro do `Envio`,
  vale para qualquer marketplace): mostra se o produto tem foto no Tiny, quantas mandar (1, 3, 5 ou
  todas — padrão 5, na ordem do envio), caixa "Mandar junto, assim que o anúncio for criado"
  (ligada quando o produto está SEM foto no Tiny; entra no texto da confirmação pelo
  `ia-anuncio-vai-criar`) e botão "Mandar agora ao Tiny" (com confirmação) para anúncio já criado.
  As fotos entram DEPOIS das que o produto já tem: a principal do Tiny só muda se ele estava sem
  foto. **A API do Tiny não apaga anexo** — tirar foto é na tela do Tiny.
- **Foto na hora, sem DDL:** `view_foto_produto` é a `mv_foto_produto_v2` (refeita a cada 3 h) e
  `ia_produto`/`ia_catalogo` leem dela. Para não esperar, a lista `/ia/anuncios` confere em
  `produtos.foto_capa` os SKUs da página que vieram sem foto (`.in()` só dos visíveis) e a página
  do anúncio faz o mesmo. As outras telas enxergam no próximo refresh da MV.
- **Não testado ao vivo:** o Tiny baixar a foto de um endereço assinado do nosso armazenamento
  (PNG grande, com `?token=` na URL). Se recusar, a mensagem do Tiny aparece no bloco. Foto das
  VARIAÇÕES (cada kit com a sua) ainda não vai — só as do produto do anúncio.

## 5.11.11.2 Aba Fotos e fotos de outro anúncio (13/out/2026)

Pedido do dono: aba própria para as fotos e poder usar as fotos de outro anúncio parecido (ex.: o
16500 "Granulado 100% Mandioca 2kg" usar as do Granulado de 2 kg já feito), em vez de gerar do zero.
- **Abas de `/ia/gerar`:** Anúncio · **Fotos** · Análise · Preço e promoção (`?aba=fotos`). A aba
  Fotos tem, nesta ordem: `Aproveitar` (família de KIT), **`FotosDeOutros`** (qualquer outro
  anúncio), `EtapaFotos` (gerar/revisar) e `FotosVariacoes`. Na aba Anúncio ficou só o cartão
  "2 · Fotos" com a contagem e o atalho. O envio (`Publicar`) continua na aba Anúncio e usa as
  fotos aprovadas.
- **`FotosDeOutros.tsx`:** lista os rascunhos de OUTROS produtos que têm fotos (fora o próprio e a
  família de kit, que já aparece no bloco de cima), os mais parecidos pelo nome primeiro (palavras
  em comum; número com unidade, tipo "2kg", pesa o dobro), com busca por nome ou SKU. "Escolher
  fotos" abre o mesmo `DialogoTrazer` do Aproveitar (agora exportado) → `ia-aproveitar?modulo=
  aplicar`, que **não exige família** (qualquer `origem_id` serve) e cria o rascunho se o produto
  ainda não tem — dá para montar o anúncio só com fotos prontas, sem texto. Sem função nova.
  As capas vêm desmarcadas (capa de outro produto pode trazer nome/peso/quantidade diferentes).
- **Bloco Preço:** "padrão do canal" aparecia 17,5% em produto SEM custo (a `ia_calcular_preco`
  devolve o erro antes de ler o canal e a tela caía no valor fixo). Agora lê
  `ia_canal_config.margem_alvo_pct` direto (Shopee = 30%).
- **Fotos das variações: "SKU … sem foto de referência" (13/out, relato do dono).** A
  `ia-anuncio` resolve a referência por SKU (`ia_produto_extra.foto_ref_path`, senão a foto do
  catálogo). Variação criada pelo app a partir de base SEM foto no Tiny (16503–16505, pai 16500,
  base 16453) não tinha nenhuma das duas, embora o PAI tivesse a referência que o dono subiu
  (`ref/16500/…`). `FotosVariacoes.garantirReferencia` agora grava na variação a referência do
  pai (ou do `sku_base`) antes de gerar — aponta para o MESMO arquivo, não copia; a função baixa
  qualquer caminho do bucket. Variação com referência própria não é tocada.
- **Não testado na tela** (exige login).

## 5.11.11.3 Peso e medidas do envio nunca travam por cadastro zerado (13/out/2026, `anuncio-publicar` v8)

Criar anúncio travava em "informe o peso / comprimento, largura e altura" com os campos em **0**
(caso: 16500, pai com variações 16503/4/5 — kits de 2/4/5 × 16453; o Tiny tem peso e medidas
ZERADOS no pai, nos kits e no produto base). Causa: `num(0) ?? próximo` — o zero do Tiny era
aceito como valor e a cadeia nunca chegava ao recurso seguinte. Agora só vale número **> 0**
(`pos()`), em Shopee e Mercado Livre (`medidasDoAnuncio`):
- **Peso:** digitado → `ia_produto_extra.peso_kg` → Tiny ao vivo → **o que a gestão sabe**
  (`pesosDoSistema`): `produtos.peso_bruto` → peso já conferido em outro anúncio → **kit = soma
  da composição** (`produto_kits` × peso do componente) → peso escrito no nome ("… 2kg", última
  ocorrência). Produto com variações (tipo V) usa **a menor variação** (16500 → 4 kg); cada
  variação segue com o seu peso no bloco de variações. Só vira pendência se nada disso der peso.
- **Medidas:** digitadas → conferidas → Tiny → **embalagem padrão 40 × 30 × 15 cm** (decisão do
  dono). O padrão NÃO é gravado em `ia_produto_extra` como medida conferida (`medidasSalvar`).
- A conferência avisa de onde veio cada número ("peso puxado do sistema (…)", "medidas no
  padrão"). 99 dos 2.271 produtos ativos estão com peso 0 no cadastro (23 kits) — o conserto de
  verdade é preencher no Tiny.

## 5.11.11.4 Peso e medidas acompanham a troca de marketplace/loja (13/out/2026)

Pedido do dono: ao trocar o destino do envio, aproveitar peso e tamanho da embalagem já informados.
- **Conferência (`Publicar`):** `peso_kg`/`comprimento_cm`/`largura_cm`/`altura_cm` DIGITADOS num
  destino ficam em `medidasComuns` (por rascunho) e a conferência do destino seguinte já abre com
  eles aplicados (sem "Atualizar a conferência"). Depois de um envio, a `anuncio-publicar` v8 já
  guardava as medidas conferidas em `ia_produto_extra`; isto cobre a troca ANTES de enviar.
- **Variações (`VariacoesShopee`):** a tela não remonta mais ao trocar Ottz ↔ Bumi (chave só pelo
  SKU). Na troca de loja mudam preço (o imposto é por empresa), anúncio e foto; ficam nome da
  opção, estoque, **peso e medidas** de cada variação. Ao criar as variações com sucesso, peso e
  medidas de cada uma são gravados em `ia_produto_extra` do SKU da variação e voltam preenchidos
  na próxima vez (outra loja, outro dia). Sair da Shopee (ex.: ir ao Mercado Livre) desmonta o
  bloco: aí vale só o que já foi gravado.
- **Não testado na tela.**

## 5.11.11.5 Shopee sempre no ar + margem do preço promocional (13/out/2026, noite)

- **1º uso real das variações (o que os registros mostram):** 16500 → Ottz item 55419192648:
  variações criadas com `weight` e `dimension` por modelo (**a Shopee aceita os dois no
  `init_tier_variation`**) e `unlist_item` OK → NORMAL. Bumi item 53619183224: variações criadas,
  mas a ativação falhou (`product.error_unlist_item_all_failed` — "external error, source:
  …account_health_metric_api.get_shop_listing_limit … marketplace.listing.upload.lock.
  check_product_lock, code 332700006") e o anúncio ficou UNLIST. Não se sabe se é trava de
  processamento logo após criar as variações ou limite de anúncios da loja.
- **Sempre no ar (decisão do dono):** a caixa "Criar fora do ar" saiu da conferência da Shopee
  (`Publicar`; Mercado Livre continua pausando). `anuncio-shopee-variacoes` **v4**: `porNoAr` tenta
  de novo UMA vez depois de 6 s (é só mudança de estado — repetir não duplica nada; única exceção
  à regra de não repetir escrita) e ganhou `?modulo=ativar {empresa, item_id, confirmar}`. Na tela
  das variações, anúncio fora do ar (falha desta sessão, ou `shopee_anuncios.status = 'UNLIST'` no
  espelho) mostra a faixa amarela com **"Pôr no ar agora"**.
- **Margem do preço promocional:** em "Minha Promoção" (no envio), cada SKU mostra ao lado do preço
  a margem de contribuição que ele dá (`ia_analisar_preco` → `lucro_pct`/`lucro_reais`), e ela
  acompanha o que for digitado à mão (atraso de 0,45 s). Vermelho < 0, âmbar < 10%, verde acima.

## 5.11.11.6 Texto da IA "explicando de onde tirou a informação" (13/out/2026)

Relato do dono: descrições com "Marca visível na embalagem: Great Pets", "Produto identificado no
nome como mandioca mista", "Pelo rótulo, ela oferece…" — a IA contava ao comprador como descobriu
cada dado.
- **Causa:** as regras de texto (`ia_prompt_guardrail`, tipo `instrucao`, que entram em todo
  prompt como "REGRAS OBRIGATORIAS") dizem quais são as fontes — `inst_sem_invencao` ("suas duas
  fontes de verdade são o NOME e a FOTO…") e os templates ("o que você LÊ NA FOTO") — e nenhuma
  dizia que isso é interno. Piora quando o cadastro está sem marca: `inst_sem_marca_terceira` só
  permite a marca do campo `{{marca}}`, e a IA, vendo outra no rótulo, hesita por escrito.
- **Feito (dado, não código — aparece em IA › Prompts › Regras):** regra **`inst_sem_citar_fonte`**
  (instrução, ativa): escrever como o vendedor, afirmar o fato direto, nunca dizer de onde veio;
  na dúvida, omitir; única exceção é orientar o uso ("siga o modo de uso do rótulo"). E o alerta
  **`cita_a_fonte_da_informacao`** (regex, ação `avisar`): se a frase escapar, o bloco Texto mostra
  "Avisos: cita_a_fonte_da_informacao". ARMADILHA: os padrões regex vão para `new RegExp(p,
  "giu")` — o `(?i)` das regras antigas (herdadas do gerador) é inválido em JS e elas são puladas.
- **Textos já gerados:** 12 dos 19 rascunhos com texto têm a frase (20 ocorrências), 9 deles já
  publicados (10933, 14091, 14258, 14560, 14983, 16452, 16453, 16486, 16500). A regra só vale para
  geração nova — corrigir os antigos é refazer o texto ou editar à mão e reenviar.
- **Não testado:** não rodei uma geração nova (precisa de sessão e gasta IA).

## 5.11.11.7 Fotos: tipos retirados, estilo dos prompts e dados da capa (13/out/2026, noite)

- **Tipos de foto retirados (dono):** `imagem_variantes`, `imagem_escala`, `imagem_principal`,
  `imagem_conteudo`, `imagem_publico` e a capa `imagem_capa_ml_branca` ficaram `ativo = false` em
  `ia_prompt_template` (nada apagado; a lista da tela vem dos ativos). Junto: `briefing_base`
  **v2** não recomenda mais esses tipos e o `plano_fotos` de todos os canais perdeu a
  `imagem_principal`. ⚠ O Mercado Livre pede a 1ª foto em fundo branco — sem "Principal" e sem
  "Capa ML Branca" o app não gera mais essa foto.
- **Estilo/fundo (regra de 12/out: cenário de uso em vez de fundo liso + texto de vantagem):**
  ainda estavam na v1 antiga e ganharam **v2**: `imagem_beneficios` (era "fundo claro sólido"),
  `imagem_cta` (era estúdio com degradê), `imagem_emocional` e `imagem_uso` (texto passou a ser
  obrigatório), `imagem_passo_a_passo` (era "fundo claro e neutro"); `imagem_kit` **v3** (era
  "sobre fundo branco"). Prompt já escrito por SKU (`ia_prompt_imagem`) NÃO muda sozinho: só ao
  refazer o prompt.
- **"Capa Ambientada Texto com título errado" — causa:** o selo usa exatamente o campo "Título do
  selo" dos Dados da capa, e o `EtapaFotos` não tinha `key` por SKU: ao trocar de produto na
  mesma tela, quantidade, barra e título digitados para o produto ANTERIOR continuavam lá (o 16506
  saiu com "Areia de Mandioca / e Minenais"). Além disso o título digitado ia também para as
  capas "Menor Preço da Shopee". Agora: `key={ef-<sku>}` (formulário zera por produto) e
  `escreverPrompts` manda as capas da Shopee à parte, sem o título (lá é sempre MENOR PREÇO DA
  SHOPEE). Título vazio = a IA escreve tipo de produto + diferencial pelo NOME.
- **Produto com variações (pai):** a barra da capa já vem com as variações na ordem da quantidade
  ("2kg 4kg 6kg 8kg 10kg") e "Qtd. de embalagens" com a MAIOR quantidade de kit (`varsQ` no
  `EtapaFotos`, por `produtos.sku_pai` + `produto_kits`). Só preenche campo vazio.
- **Vendas por produto:** "SKUs vendidos" contava quem vendeu em QUALQUER dos dois períodos
  (231); passou a contar quem vendeu no período atual (171) e a linha de baixo diz quantos só
  venderam no período de comparação.

## 5.11.11.8 Preço padrão do produto PAI = variação mais cara (13/out/2026)

Produto com variações (tipo V) não tem custo na gestão — o bloco Preço dizia "Sem preço sugerido:
produto sem custo (SKU 16506)" e a conferência pedia para digitar. Pedido do dono: o padrão é o
preço a 30% de margem da variação MAIS CARA.
- `calcularPreco(sku, canal, empresa, margem)` em `src/lib/iaAnuncio.ts`: chama
  `ia_calcular_preco`; se voltar erro e o SKU tiver variações ativas (`produtos.sku_pai`), calcula
  cada variação na mesma margem e devolve a de maior preço, com `da_variacao`/`n_variacoes`. Só
  front, sem mexer na função do banco. Ex.: 16506 → R$ 222,39 (variação 10 kg, 16514).
- **Bloco Preço** (`PainelPreco`): mostra o sugerido "pela variação mais cara (SKU…)", já preenche
  "Preço que vai praticar" quando não há preço salvo e analisa o preço digitado pela conta dessa
  variação. Mudar a margem recalcula.
- **Conferência do envio** (`Publicar`, Shopee): sem preço aprovado, abre com esse preço. Não é
  gravado como aprovado de propósito — continua acompanhando custo e margem; "Salvar preço" fixa.
  No anúncio com variações ele só vale por instantes: cada variação entra com o próprio preço.

## 5.11.11.9 Dois envios do 16506 sem variações (13/out/2026, 22h30) — causa NÃO identificada

Shopee Ottz (item 28996051694, 22:28) e Bumi (45619213619, 22:40): o anúncio simples foi criado
(fora do ar, como previsto para variações) e as fotos foram ao Tiny, mas
`anuncio-shopee-variacoes?modulo=criar` devolveu **HTTP 400 "há pendências"** em 2–4 s, sem chegar
à Shopee — e sem registro: a função só gravava em `debug_fulfillment` DEPOIS de chamar a Shopee, e
o motivo só aparecia num aviso de 30 s na tela.
- **O que se sabe:** os dados que a tela manda passam na conferência (5 opções "2kg…10kg", preços
  50,00 a 222,39, sem medidas pela metade); então a pendência veio da LEITURA do anúncio recém-
  criado (`get_item_base_info`): não achou, ou situação diferente de NORMAL/UNLIST. Não deu para
  ler o estado dos dois anúncios por fora (o catálogo noturno só lista os ativos).
- **v5 (deploy 5):** a leitura tenta até 3× com 2,5 s; toda recusa por pendência é gravada
  (`etapa = '<item>:pendencias'`, com as pendências e o que foi enviado). Tela: o motivo fica num
  quadro vermelho no bloco das variações; "Criar as variações na Shopee" (caminho manual) agora
  também põe o anúncio no ar no fim.
- **Tela depois da falha (relato do dono: "as variações ainda não estão sendo preenchidas
  automaticamente"):** anúncio que já existe sem variações NÃO recebe as opções sozinho ao abrir a
  página — a criação automática só acontece no instante do envio (escrita em marketplace não roda
  sem confirmação). O bloco passou a dizer isso e o botão virou **"Criar as variações e pôr no
  ar"**, de um clique: confere ao vivo (`previa`), mostra a pendência se houver, pede a
  confirmação e cria. O que é digitado (opção, estoque, peso, medidas, nome do grupo) fica em
  `localStorage` (`ia.variacoes.<sku do pai>`): volta ao recarregar e vale para a outra loja mesmo
  quando a 1ª criação falhou (antes só era gravado no sucesso).
- **Medidas e estoque por variação preenchidos sozinhos (o que o dono queria dizer):** comprimento,
  largura e altura vinham em branco e o estoque em 0. Agora `VariacoesShopee` preenche — medidas:
  as conferidas da própria variação (`ia_produto_extra`) → as do produto pai → as do produto base
  do kit → **embalagem padrão 40 × 30 × 15** (a mesma `MEDIDAS_PADRAO` da `anuncio-publicar`; se
  mudar lá, mudar aqui); estoque: `floor(produtos.estoque do componente ÷ quantidade do kit)`
  (kit de um componente só; senão 0). O `localStorage` guarda SÓ o que o operador mudou em relação
  a esse preenchimento, para o automático continuar acompanhando o cadastro.
- **CAUSA ACHADA de "não achei o anúncio 45619213619 nesta loja" (print do dono, 23h40): o bloco
  estava com o anúncio da OUTRA loja.** O `QueryClient` do app (`__root.tsx`) tem
  **`placeholderData: (anterior) => anterior`**, `refetchOnMount: false` e `gcTime` de 30 min: ao
  mudar a chave de uma consulta, `data` continua sendo o resultado ANTERIOR até o novo chegar, e
  consulta guardada não é relida. Enquanto o `VariacoesShopee` remontava a cada loja (chave com
  a empresa) isso não aparecia; quando passou a ficar montado para aproveitar peso/medidas
  (§5.11.11.4), o efeito "preenche uma vez por loja" rodava com os dados da loja anterior — ID do
  anúncio e preços trocados — e marcava a loja como pronta, ignorando os dados certos que chegavam
  depois. Corrigido: a consulta do bloco tem `placeholderData: undefined, gcTime: 0, staleTime: 0`,
  devolve a `empresa` de que é, e o efeito e a tela só usam resultado da loja atual. O mesmo
  cuidado foi para o preço promocional do `PromocaoNoEnvio` (não mostrar o da margem anterior).
  **Regra: componente que NÃO remonta quando um parâmetro muda e usa o resultado para preencher
  estado ou para ESCREVER precisa desligar o `placeholderData` global (ou conferir de que
  parâmetro o resultado é).** As duas recusas das 22h30 foram ANTES de qualquer troca nesse
  sentido e seguem sem causa provada (provável a mesma mensagem, por atraso da Shopee em devolver
  o anúncio recém-criado — coberto pelas 3 leituras da v5).
- **Os dois anúncios seguem sem variações e fora do ar.** Conserto pela tela: abrir o 16506 em cada
  loja → Conferir → Criar as variações na Shopee. Se repetir, a pendência estará em
  `debug_fulfillment`.

## 5.11.11.10 Várias fotos reais de referência e instruções extras para a IA (14/out/2026)

Pedido do dono: usar mais de uma foto como referência e dar instruções como "este produto tem 3
opções de cores; a capa deve mostrar as três". Sem DDL.
- **Fotos reais (até 4):** `ia_produto_extra.fotos_ref` (já existia, só a 1ª era usada) = a
  principal (`foto_ref_path`) + até 3 extras (outras cores/opções, ângulos, o conteúdo). Tela: coluna
  da foto no topo do produto (`FotoReferencia` em `ProdutoTopo.tsx`) — "+ Fotos" (várias de uma vez,
  reduzidas a 2.000 px acima de 3 MB por `prepararImagem`), ★ = principal (clicar noutra troca), ✕
  tira. "Trocar" substitui a principal (a antiga SAI da lista; antes virava extra) e "usar a do Tiny"
  idem; as extras ficam. Grava direto em `ia_produto_extra` (RLS `tem_modulo('ia')`).
- **Quem recebe:** `_shared/ia.ts` `fotosReaisExtras()` + `blocosFotosReais()` → briefing, texto e
  prompts de imagem (`ia-anuncio` **v4**, deploy 6) recebem todas, a principal primeiro;
  `ia-imagem-worker` **v3** (deploy 4) manda as extras logo depois da principal no `images/edits`
  (antes das imagens de contexto, teto `MAX_IMAGENS_EXTRA` 6) e no Gemini. Se a OpenAI recusar o
  conjunto (400): tenta só com as fotos reais, depois só a principal. `fotoReferencia()` deixou de
  apagar as extras ao congelar a foto do Tiny.
- **Instruções extras:** campo "Instruções extras para a IA" no topo do produto (`InstrucoesIa.tsx`).
  Mora em `ia_contexto` (escopo `sku`, papel `diretriz`, tipo `texto`, nome fixo
  **`NOME_INSTRUCOES` = "Instruções extras do anúncio"**, `aplica_em` textos + imagem) — aparece
  também no bloco Referências. **Toda diretriz de escopo SKU** (`ehInstrucaoDoProduto`) vira, nos
  prompts de imagem e na geração, o bloco "INSTRUCOES EXTRAS DO OPERADOR (OBRIGATORIAS)" com o tipo
  da foto ("a capa…" vale só para capas; sem foto citada, vale para todas). Diretrizes de
  categoria/global (36) seguem como contexto comum. O worker passa as instruções SEMPRE (antes, com
  prompt já escrito, os textos ficavam de fora e instrução salva depois nunca chegava à imagem).
- **Prompt anterior às instruções:** `EtapaFotos` compara `ia_prompt_imagem.updated_at` com o
  `updated_at` da instrução; o mais velho (e não editado à mão) mostra "instruções novas: o prompt
  será reescrito" e é reescrito (forçar) ao clicar em "imagem". Fotos de referência novas NÃO marcam
  o prompt como velho (a imagem já as recebe; para o texto do prompt considerá-las, "prompt").
- **Não testado ao vivo** (exige login e gasta IA): nenhuma geração com várias referências nem com
  instruções ainda. Os 4 arquivos no ar conferidos por sha256 com o repositório.

## 5.11.11.10 Produto PAI acha o anúncio pelas variações + selo "onde vende" abre o anúncio (14/out/2026)

Relato do dono: o 15182 (pai com variações 15177/15178/15186/15187) aparecia "Ottz: ainda não
anunciado" no envio, mas vende na Shopee Ottz. O anúncio (23297086602) tem `item_sku` **14423** (SKU
antigo); só as VARIAÇÕES têm os SKUs dos filhos. A busca era por `sku_pai = sku` e por variação com
o próprio SKU — o pai nunca casava, e o envio CRIARIA um anúncio duplicado.
- **`anuncio-publicar` v9 (sha256 `4dec2790…`):** `existentesShopee` também procura, em
  `shopee_anuncios_variacao`, os SKUs dos filhos (`produtos.sku_pai = sku`) → o anúncio deles. Com
  isso o modo padrão vira "atualizar".
- **`VariacoesShopee`:** acha o anúncio pelo mesmo caminho; se ele JÁ tem variações, mostra só um
  cartão "este anúncio já tem variações" com o link (o `anuncio-shopee-variacoes` recusa recriar).
- **`/ia/anuncios`:** o selo "onde vende" virou botão — abre a lista dos anúncios daquele canal
  (Shopee: link da loja e do Seller Center; Mercado Livre só Ottz, pelo espelho; TikTok; Amazon só
  aviso), procurando pelo SKU e pelos SKUs das variações, para conferir se é o anúncio certo.

## 5.11.11.11 Texto pré-aprovado e capa principal por loja (15/out/2026)

Pedido do dono, quatro regras:
- **Texto sempre aprovado.** O gatilho `ia_trg_rascunho_texto` (migração `ia_16_texto_pre_aprovado`)
  grava a etapa de texto como `aprovado` (`aprovado_em = now()`, `aprovado_por = auth.uid()`) ao gerar
  E a cada edição — antes voltava para `gerado` ("para revisar"). Texto copiado de outro produto pelo
  `ia-aproveitar` também entra aprovado (o aviso "confira nome e quantidade" continua aparecendo).
- **Capa principal por destino — `anuncio-publicar` v10** (`CAPA_DO_DESTINO` / `aplicarCapaDoDestino`):
  Shopee Ottz = "Menor preço da Shopee" (`capa_ambientada_shopee`, senão `capa_shopee_basica`, senão
  `capa_shopee_livre`); Shopee Bumi = `capa_ambientada_texto`; Mercado Livre Ottz e SVL =
  `capa_ambientada_limpa`. Achada a capa APROVADA do destino, ela vai na frente e **as outras capas não
  vão** para aquele destino (aviso na conferência). Sem ela, vale a regra antiga (qualquer capa na
  frente) + aviso "a capa principal deste destino é X, que não está aprovada". Amazon e TikTok: sem regra.
- **Ordem manual das fotos** arrumada em OUTRO destino (`ordemComum` no `Publicar`) não contém a capa
  deste: nesse caso a capa do destino vai na frente (criar: `base()`; atualizar: `ordemFinal(..., capa)`).
  Ordem arrumada no próprio destino é respeitada.
- **Na data:** dos 61 rascunhos com capa aprovada, 17 têm "Menor preço", 46 a ambientada com texto, 12 a
  limpa e só 1 as três — a maioria vai precisar gerar a capa que falta para o destino.
- **Não testado ao vivo** (prévia/envio exigem login).

## 5.11.11.12 Variações num anúncio que JÁ ESTÁ RODANDO na Shopee (16/out/2026)

Pedido do dono: pegar um anúncio no ar e acrescentar opções (ex.: 15824 = kit 3× 15679, anúncio Ottz
49705431794 com as opções 3 un / 2 un → pôr 4 e 5), com a mudança indo ao Tiny e à Shopee. Decisões
dele: **opção B** (no Tiny, as opções ficam ligadas a um PRODUTO PAI com variações) e **os dois casos**
(anúncio que já tem variações e anúncio simples).
- **Tela:** bloco "Variações num anúncio que já está no ar" na aba Anúncio de `/ia/gerar` (destino
  Shopee, qualquer tipo de produto) → `AmpliarVariacoes.tsx`: escolhe o anúncio (`existentes` da loja ou
  ID digitado) → lê ao vivo → mostra cada opção de hoje com o que ela é no cadastro (kit de N× base, por
  `produto_kits`; precisa ser UM produto base para todas) → opções novas (qtd, nome — areia vai por peso
  —, preço = preço por unidade das de hoje × qtd, estoque = estoque do base ÷ qtd) → pai no Tiny →
  Conferir (Tiny + Shopee) → Aplicar (com confirmação listando tudo).
- **Pai no Tiny:** se já existe um pai ativo cujas variações são kits de 1 componente do MESMO base em
  TODAS as quantidades (ex.: **16361** = 1× a 5× 15679 → 16306/16302/16303/16304/16305), o anúncio passa
  a usar os SKUs dele e nada é criado no Tiny. Senão, cria um pai novo pela `tiny-produto-variacoes
  criar` (uma variação-kit por quantidade, INCLUSIVE as que já vendem — a API do Tiny não transforma
  produto existente em variação nem acrescenta variação a pai existente), termina os kits pendentes e as
  fotos como a criação por cores. Nome repetido no Tiny barra o kit (16523): a tela confere o nome do pai
  e das variações no espelho antes. Se alguma variação não virar kit, a Shopee NÃO é alterada.
- **Shopee — `anuncio-shopee-variacoes` v7:** `ler` (o anúncio ao vivo: `get_item_base_info` +
  `get_model_list`, estoque = soma do `seller_stock`) e `ampliar` (anúncio COM variações, um grupo só):
  `update_tier_variation` (opções de hoje na mesma ordem, com a foto, + as novas) → `add_model` (as
  novas) → `update_model` (SKU novo das opções de hoje; model_id, vendas e avaliações ficam) →
  `update_item` (`item_sku` = pai). Cada passo uma vez, para no 1º recusado, tudo em
  `debug_fulfillment` (`etapa = <item>:ampliar`). Anúncio SIMPLES: `criar` (init_tier_variation com a
  opção de hoje — preço e estoque atuais — + as novas) e depois `ampliar` só com o `item_sku`.
- **Depois de aplicar:** conferir no Tiny se o anúncio ficou ligado ao produto pai (o vínculo de anúncio
  do Tiny não é feito pela API — sem ele o estoque das opções novas não sobe; foi o que aconteceu com o
  anúncio criado direto em §5.11.7).
- **Não testado ao vivo** (exige login e mexe em anúncio no ar). Os formatos de `update_tier_variation`,
  `add_model` e `update_model` vêm da documentação da Shopee: o 1º uso real confirma — se recusar, a
  resposta está em `debug_fulfillment` e a mensagem diz o que já foi feito.

## 5.11.11.13 Fotos sem IA: subir à mão e trazer de anúncio no ar (18/out/2026)

Pedido do dono: subir fotos manualmente para o anúncio (e elas servirem a outros produtos) e ver as
fotos que já estão nos anúncios publicados. Decisão dele: as duas entram **para revisar**.
- **Tela:** bloco "Fotos prontas, sem IA" na aba Fotos de `/ia/gerar` (`FotosNovas.tsx`, entre "Usar
  fotos de outro anúncio" e a geração). (1) Subir: arrastar ou escolher (JPG/PNG/WEBP, até 20; acima de
  3 MB reduz a 2.000 px por `prepararImagem`); o app grava em `ia-anuncios/manual/{sku}/{uuid}.ext` e
  chama `subir`; se falhar, apaga o que subiu. (2) Anúncios no ar: lista do espelho (`shopee_anuncios`
  das duas lojas, `ml_anuncios` só Ottz) — sem busca, os anúncios do próprio SKU, dos componentes (kit)
  e das variações (pai); busca por nome, SKU, ID da Shopee ou MLB (ID fora do espelho, ex. ML da SVL,
  abre direto). "Ver fotos" lê o anúncio AO VIVO e mostra todas, maiores; marca e "Trazer".
- **Edge fn `ia-aproveitar` v2:** `subir` (só aceita caminho `manual/<sku>/`), `no-ar` (Shopee
  `get_item_base_info` → `image.image_url_list`, assinatura da loja; ML `/items/{mlb}` →
  `pictures[].secure_url`, token da conta e `seller_id` conferido) e `copiar-no-ar` (só baixa de
  `*.susercontent.com`, `shopee.com(.br)`, `*.mlstatic.com`; grava em `no-ar/{mkt}/{item}/{hash}`; até
  12 por vez). Sem rascunho, cria um (`ia_rascunho_criar`). Sem DDL.
- **Como a foto vive:** linha em `ia_rascunho_imagem` com tipo **`manual_<8>`** / **`anuncio_<8>`** (uma
  foto por tipo, ordem > 100, depois das da IA), etapa `gerado` = para revisar. Por isso aparece em "Usar
  fotos de outro anúncio" e vai para outro produto pelo `aplicar` de sempre — caminhos `manual/` e
  `no-ar/` nunca são regravados, então a cópia aponta para o MESMO arquivo (`copiaCompartilhada`).
  O worker não refaz esses tipos (não há template `imagem_manual_*`): a grade esconde o "refazer"
  (`fotoSemIa` em `src/lib/iaAnuncio.ts`; `rotuloFoto` mostra "foto enviada" / "foto de anúncio no ar").
  Não são capa para a regra de capa por loja (§5.11.11.11) — a ordem se ajusta na conferência do envio.
- **Não testado ao vivo** (exige login): nenhum upload nem leitura de anúncio feitos. Conferido: tsc,
  build e a função no ar idêntica ao repositório.

## 5.11.11.14 "Refazer" a imagem parecia não fazer nada (18/out/2026)

Relato do dono (capa ambientada limpa do 15987 com "Mais foco no produto… retire o peso de baixo"): a
imagem ERA refeita (12h25:59, observação gravada), mas: (1) o worker regravava o MESMO arquivo
(`{ordem}-{tipo}.png`) e toda tela guarda o link assinado pelo caminho (30 min) — continuava mostrando a
antiga; (2) a observação ia só no FIM do prompt, depois de "Barra inferior: 8kg e 20kg"; (3) a capa
**limpa** (estilo 5, sem texto) recebia a barra do formulário de capa.
- **`ia-imagem-worker` v4 (deploy 5, conferido por sha256 com o repositório):** cada versão em
  `{ordem}-{tipo}-{hash10}.ext`; a anterior é apagada se era do próprio rascunho e nenhuma linha aponta
  para ela (cópias de outros produtos vivem em `compartilhado/`). O "o que mudar?" abre o prompt
  ("vale mais que qualquer instrução abaixo que conflite") e é repetido no fim.
- **`EtapaFotos.escreverPrompts`:** a capa limpa vai sozinha, com `sem_texto: true` e barra/selo/ícones
  vazios. O prompt da limpa do 15987 continua com a barra: reescrever pelo botão "prompt" da linha.
- Arquivos antigos (`{ordem}-{tipo}.png` sem hash) seguem válidos; viram o formato novo na próxima geração.
- **2ª rodada (18/out, "reescrevi o prompt e refiz a capa, mas continua igual"):** o prompt SALVO da limpa
  do 15987 não tinha mudado (o editor só gravava no botão "Salvar prompt"; o texto digitado se perdia) e
  ainda mandava desenhar "8kg 20kg". Feito: (1) os 6 prompts de capa limpa com barra (14983, 15987, 16310,
  16452, 16457, 16486) tiveram a linha "Barra inferior" trocada por "sem barra" no banco; (2)
  `ia-imagem-worker` **v5 (deploy 6, conferido)**: na capa limpa, as linhas Barra/Faixa/Ícones/Título do
  selo do prompt viram "sem" na hora de gerar + aviso "ESTILO SEM TEXTO" — vale para prompt antigo e
  editado à mão; (3) `EditorPrompt` salva ao sair do campo e mostra "não salvo / salvo".

## 5.11.11.15 Filtro "estoque parado" em /ia/anuncios (19/out/2026)

Pedido do dono: filtrar produtos de baixo giro ou com excesso de estoque, na mesma lógica dos agentes de relatório.
- **Regra = a do agente de compras** (`view_cobertura_fornecedor.status`): **sem giro** = tem estoque (Geral + Fulls) e
  vendeu 0 em 30 dias (todos os canais, pelo `pedidos_tiny`, kits abertos nos componentes); **excesso** = (estoque total +
  OC aguardando) ÷ venda/dia > **120 dias**. A lista lê o retrato do dia **`ads_cobertura_sku`** (refeito pelo
  `ads_metricas_atualizar()`, cron 147, 06h20 BRT) — a view ao vivo custa ~1,8 s. A MV ganhou `venda_30d`,
  `estoque_total`, `oc_aguardando`, `cobertura_com_oc_dias`, `valor_estoque`, `custo` (migração `ia_catalogo_giro`;
  SQL + rollback em `docs/ia-catalogo-giro.sql`; `ads_diagnosticar` lê por nome de coluna, não mudou).
- **Produto do catálogo → produto físico:** simples = ele mesmo; kit = os componentes (`produto_kits`); produto com
  variações = as variações (e os componentes delas). Produto com estoque NÃO sincronizado (`estoque_nao_sincronizado`,
  463 SKUs em 19/out — o `estoque_tiny` só cobre os SKUs-alvo) não entra: o agente também não classifica.
- **`ia_catalogo` v2.2 (`versao: 6`, 9 parâmetros — `p_giro` = `parado` | `sem_giro` | `excesso`):** cada linha (e
  variação) traz `giro` (lista dos físicos parados: status, dias, estoque, venda 30 d, valor) e `giro_valor`; a resposta
  traz `giro` (contagem dentro da situação/tipo) e `giro_em`; ordem nova `parado` (dinheiro parado). A de 8 parâmetros foi
  removida. Conferido: com o filtro desligado, total, contagens e SKUs de 4 cenários idênticos à versão anterior; ~0,9 s.
  Na data: 345 produtos de topo parados (243 excesso, 113 sem giro; ex.: família Creme Dental + Dedeiras Bumi
  R$ 26 mil parados, Xô Gatinho 11538 R$ 25,8 mil em excesso de 242 dias e todos os kits dele).
- **Tela:** fileira "Qualquer estoque · Estoque parado · Sem giro (30 dias) · Excesso (+120 dias)" com contagem e a hora
  do retrato (`?giro=` na URL); ligar o filtro já ordena por "Mais dinheiro parado em estoque". Selo na linha ("sem giro"
  vermelho / "excesso · N dias" âmbar + R$ parado; "no componente"/"nas variações" quando vem do físico) abre a lista dos
  produtos físicos. **Não conferida com login.**

## 5.11.11.12 Importar/atualizar produto do Tiny na hora (19/out/2026)

Pedido do dono: produto cadastrado no Tiny durante o dia não aparecia em `/ia/anuncios`.
- **Causa:** o espelho `produtos` só recebe produto novo na listagem da madrugada (cron 19). Desde a
  `tiny-sync-produtos` v29, `?modulo=produtos` chamado no meio do dia responde "passada de hoje já
  completa" **sem ir ao Tiny** (só `forcar=1` começa outra passada inteira), e `?modulo=detalhar&sku=`
  só serve a SKU que já está no espelho (precisa do `id_tiny`). Ou seja, não havia caminho para trazer
  um produto novo. **O atalho da tela de Promoções (`useCustoTinyAutomatico`, §5.9.1) também parou por
  isso** — ele chama `modulo=produtos` e depois `detalhar&sku=`; trocar pela função nova é pendência.
- **Edge fn `tiny-produto-importar` v1** (função nova, separada da `tiny-sync-produtos` crítica e da
  `tiny-produto-variacoes`; sessão de usuário qualquer, `verify_jwt` true): `POST {skus: [...]}` (até 20)
  → `GET /produtos?codigo=` (código exato) + `GET /produtos/{id}` → upsert em `produtos` com os MESMOS
  campos da listagem (`mapearItemBasico` da v29: custo, preço, situação, gtin, unidade, tipo_variacao,
  `tiny_alterado_em`) + do detalhe (foto, marca, categoria, fornecedor, estoque, pai,
  `detalhe_atualizado_em`) e a composição do kit em `produto_kits`. Já existe = atualiza. Traz junto a
  família: as variações de um pai (e liga `sku_pai`), o pai de uma variação e o componente de um kit
  que ainda não estão no espelho. Só LÊ no Tiny. Orçamento 22 s → `faltam` (a tela chama de novo).
  Responde `ok: true` + resultado por código (`itens[].ok/erro`) e `tudo_ok`. Registro em
  `debug_fulfillment` (`modulo = 'tiny-produto-importar'`).
- **Tela:** botão "Importar do Tiny" ao lado da busca em `/ia/anuncios` (diálogo `ImportarDoTiny.tsx`:
  códigos separados por vírgula/espaço, resultado com foto, novo/atualizado, custo, kit, variações, e
  "Ver na lista"); a lista vazia com busca oferece "Importar "<busca>" do Tiny agora"; menu "…" da
  linha → "Atualizar do Tiny" (relê custo, foto, kit, variações). Produto inativo no Tiny entra com
  `ativo=false` e não aparece na lista (o diálogo avisa).
- **Não testado com login** (o teste real é do dono pela tela). Conferido: preflight 200, sem sessão
  401, no ar = repositório por sha256 (`cea505f6…a470`).

## 5.11.11.16 Selo "Preço de Atacado" no lugar de "Menor Preço da Shopee" (20/out/2026)

Pedido do dono. Os três estilos de capa com selo de preço (1 Básica `imagem_capa_shopee_basica`, 3 Livre `_shopee_livre`, 6
Ambientada `imagem_capa_ambientada_shopee`) ganharam a **versão 3** com o selo **PREÇO DE / ATACADO** (v2 desligada, não
apagada); `imagem_capa_ambientada_texto` v3 só troca a frase "Sem faixa Menor Preço" e a regra
`inst_imagem_sem_logo_marketplace` cita o selo novo. Os nomes dos tipos (`capa_*shopee*`) e a regra de capa por loja
(§5.11.11.11) não mudaram. A tela (`EtapaFotos.escreverPrompts`) manda `faixa: "PREÇO DE|ATACADO"` explícito para esses
estilos — o texto de reserva da `ia-anuncio` (`blocoOperador`, título vazio) ainda fala em "MENOR PRECO / DA SHOPEE", mas
não é mais alcançado por eles (não republicada). O rótulo "Menor preço da Shopee" de `CAPA_DO_DESTINO` na `anuncio-publicar`
(aviso da conferência) também ficou o antigo. Prompts já escritos por SKU (`ia_prompt_imagem`) seguem com o texto antigo até
o "prompt" ser refeito.

**Complemento (20/out, mesmo dia):** a 1ª capa de selo de preço gerada depois da troca (15810) saiu com "AREIA DE GATO / BIO GOLD
FINA": a aba estava aberta antes da publicação e mandou o título vazio, e o texto de reserva da `ia-anuncio` ainda chamava esses
estilos de "Menor Preço da Shopee" — a IA não reconheceu o estilo novo e usou o nome do produto. Correções só no banco: os 29
prompts gravados desses estilos passaram a dizer PREÇO DE / ATACADO (os de título próprio 16506/14091 ficaram), e o
`meta_prompt_imagem` **v4** manda o selo PREÇO DE / ATACADO nos estilos 1, 3 e 6 mesmo sem título e mesmo se algo citar o nome antigo.
**Capa sem texto centralizada (pedido do dono):** `imagem_capa_ambientada_limpa` **v2** com o bloco CENTRALIZAÇÃO (produto ou conjunto
no centro do quadro, mesma margem dos dois lados, pet e objetos nas laterais) e a mesma regra acrescentada aos 19 prompts já gravados.

## 5.11.12 Amazon — como seria CRIAR anúncio (ensaios de 13/out/2026, nada criado)

Pergunta do dono: como faríamos o envio de produtos para a Amazon. Hoje a `anuncio-publicar` só
ATUALIZA (v7). Ensaiado ao vivo na conta ACZ com o validador (`PUT listings item` +
`mode=VALIDATION_PREVIEW`, não aplica) pela sonda `amazon-anuncio-sonda` **v2** (slot
`amazon-lwa-debug` v15; `?ensaio=criar&sku=[&tipo=][&canal=fba|proprio][&forcar=novo][&completo=1]`,
`&bruto=1` devolve todos os atributos de um anúncio nosso = molde). A função recusa qualquer
escrita sem `VALIDATION_PREVIEW`.
- **Dois caminhos, decididos pelo EAN no catálogo** (`GET /catalog/2022-04-01/items?identifiers=
  &identifiersType=EAN`):
  - **A — o produto já existe na Amazon** (marca de terceiro): `requirements:
    LISTING_OFFER_ONLY` com `merchant_suggested_asin`, `condition_type`, `purchasable_offer`
    e `fulfillment_availability`. Do galpão (`DEFAULT` + `quantity`) = **VALID com esses 4
    campos**; FBA (`AMAZON_NA`) pede mais `supplier_declared_dg_hz_regulation` e
    `batteries_required`. `restrictions` veio vazio para o Pet Clean.
  - **B — ficha nova (ASIN novo, marca própria)**: `requirements: LISTING`. O esquema do tipo
    diz 6 obrigatórios, mas o validador cobra **~16–18**: além de título, marca, bullets,
    descrição, país e produto perigoso → `manufacturer`, `model_name`, `model_number`,
    `directions`, `specific_uses_for_product`, `color`, `warranty_description`,
    `external_testing_certification`, `batteries_required`, `number_of_boxes`, `unit_count`,
    `list_price` (`value_with_tax`, não `value`), `item_package_weight`,
    `item_package_dimensions` (+ `included_components`, `contains_liquid_contents`,
    `is_expiration_dated_product` em PET_SUPPLIES; ANIMAL_LITTER ignora esses três). Com tudo
    preenchido: **VALID** para Bumi Pet Care (creme dental 15814 e kit de areia 16034).
- **Marca:** "Bumi Pet Care" passa; **"Ottz Pet" = erro 5665 (marca não aprovada pela Amazon)** —
  areia Ottz (16054) não cria ficha até o dono pedir a aprovação da marca no Seller Central.
  Produto sem marca no cadastro (ex.: o pai 16486) = "marca obrigatória".
- **Tipo de produto:** areia = `ANIMAL_LITTER` (103 campos); os nossos anúncios de higiene estão
  em `PET_SUPPLIES` (109); a Amazon troca sozinha quando acha melhor (creme dental →
  `TOOTH_CLEANING_AGENT`, só aviso). A busca de tipo por palavras do nome falha às vezes —
  a tela precisa deixar escolher.
- **EAN é o ponto fraco do cadastro:** 789 de 2.267 ativos têm EAN (kits: 150 de 1.165) e **kit
  herda o EAN da unidade** (o "Kit 2/3/4/5" da areia 2 kg têm todos o mesmo). Na Amazon um EAN =
  um produto: o validador NÃO acusa a repetição, mas na criação real o 2º kit cairia na ficha
  do 1º. Kit precisa de EAN próprio, isenção de GTIN, ou entrar como variação (tema de
  quantidade) de uma ficha só. Achado na mesma linha: o EAN do kit 10933 no Tiny é o da
  unidade (aponta para outro ASIN que não o do nosso anúncio).
- **Tudo que vendemos na Amazon é FBA** (90 dias: ACZ 1.253, SVL 1.188 pedidos; zero do galpão).
  Criar o anúncio FBA não vende nada sozinho: precisa do envio ao CD (a aba Fulfillment › Envios
  já cuida do packing; o plano de envio é feito no Seller Central — a API de inbound deu 403).
  Vender do galpão exigiria estoque e pedidos Amazon pelo Tiny, que hoje só tem "Amazon FBA
  Classic".
- **SVL segue sem `merchant_token`** → nada de Listings nessa conta.
- **19/out/2026: SVL ganhou o `merchant_token` = `A1SV0PAWMH4T1F`** (informado pelo dono). Listings liberada: leitura do 15919/15922
  ok e ensaio de título VALID; a SVL tem 117 anúncios (26 compráveis), 49 sem NCM/origem e 9 com origem 1. Criar/atualizar
  anúncio, variações e varredura fiscal passam a valer para a SVL também.
- **Não ensaiado:** fotos por endereço assinado na criação (só no atualizar), variações
  (`parentage_level`/`child_parent_sku_relationship`/`variation_theme`), e a criação REAL
  (o validador não pega tudo — ex.: conflito de EAN, revisão da ficha).

## 5.11.12.1 Amazon — pesquisa pelo ASIN e variação em anúncio já criado (18/out/2026, só ensaio)

Pergunta do dono (com o ASIN B0GZLQVHQM): dá para pesquisar pelo ASIN e incluir variações num anúncio já criado?
Sonda `amazon-anuncio-sonda` **v3** (slot `amazon-lwa-debug` v18; fonte no repositório):
`?conta=ottz&asin=B0…[&pai=<sku pai existente>][&sku_filho=][&tema=SIZE][&valor=8kg]`. Só leitura +
`VALIDATION_PREVIEW`; nada foi alterado na Amazon.
- **Pesquisa pelo ASIN: SIM.** `GET /catalog/2022-04-01/items/{asin}` (título, marca, tipo, EAN, fotos e
  `relationships` = pai/filhos/tema) + **`searchListingsItems`** `GET /listings/2021-08-01/items/{merchant}?
  identifiers=<asin>&identifiersType=ASIN` = quais SKUs NOSSOS estão naquele ASIN (com pai/filhos). A busca
  por palavra (`keywords=<asin>`) também acha.
- **O que o ASIN mostrou:** B0GZLQVHQM (Areia Bumi 4kg, EAN do 15984) **já é filho** do pai **B0HLWGDZFN**
  (SKU pai **16358**, ACZ, tema **SIZE**), com os filhos 15984_FBA (4kg), 16330_FBA (8kg, ASIN B0HLWH7C47)
  e 16332_FBA. O Kit 2×4kg **15987** é ASIN SOLTO (B0HHFM5WXG, EAN 7892806719087, que o Tiny não tem).
- **Incluir variação em anúncio já criado: SIM, pela API.** PATCH no SKU que vai entrar:
  `parentage_level = child`, `child_parent_sku_relationship = {variation, parent_sku}`,
  `variation_theme = SIZE`, `size = "8kg"` **e** `external_testing_certification = "Não Aplicável"` (sem
  ele a validação recusa — mesmo já preenchido no anúncio). Ensaio do 15987 → pai 16358 = **VALID**; do
  15984_FBA = VALID. Pai novo (família do zero) = PUT com `parentage_level = parent` + tema + bullets,
  descrição e `batteries_required`. ANIMAL_LITTER aceita 55 temas (SIZE, NUMBER_OF_ITEMS,
  ITEM_PACKAGE_QUANTITY, ITEM_WEIGHT…).
- **Cuidados:** o validador olha um anúncio por vez — **não acusa tamanho repetido** na família (o 15987
  "8kg" bateria com o 16330_FBA "8kg"; usar "2x4kg" ou tirar um); o 15987 tem o aviso 18076 "outras
  limitações de listagem"; a SVL segue sem `merchant_token` (só ACZ). Filho NOVO (SKU sem anúncio) =
  ficha completa do caminho B (§5.11.12) + os campos de filho — não ensaiado junto.
- **Tela + função (18/out, dono escolheu B + C):** edge fn **`amazon-variacoes`** v1 (fonte no repositório; JWT
  de usuário + módulo `ia`; até 19/out 03:00 UTC `ler`/`previa` também aceitam a chave publicável — rota de
  ensaio): `ler {empresa, busca}` (ASIN/SKU → anúncio, família com o valor de cada filho e kits do mesmo produto
  base no Tiny, cada um marcado "pôr na família" se já tem anúncio ou "tamanho novo"), `previa` (validador) e
  `aplicar {confirmar}` (pai → entrar → novos, cada envio uma vez, para no 1º recusado; `debug_fulfillment`
  modulo amazon-variacoes). Tamanho novo = SKU `<sku>_FBA` com a ficha copiada de um irmão (título com
  "(valor)", preço, FBA, peso do kit = soma da composição — no Tiny o peso dos kits vem errado: 8kg com 4,01).
  Família nova: cria o pai copiando a ficha do anúncio pesquisado. Tela: bloco "Variações na Amazon" na aba
  Anúncio de `/ia/gerar` quando o destino é Amazon (`VariacoesAmazon.tsx`); Aplicar só depois de conferir o
  MESMO pedido sem pendência, com confirmação. Barra: valor repetido na família, EAN inválido, SKU já
  anunciado, tipo de produto diferente, pai de outra família.
- **Código de barras do tamanho novo (pergunta do dono — "marca genérica não precisa"): PRECISA.** Ensaio de
  18/out com o 15988 (12kg): sem código = erro **8560** com Bumi Pet Care, "Genérico" e "Generic"; com um EAN de
  formato válido = **VALID**. Sem código só passa se a marca tiver **isenção de GTIN aprovada** no Seller
  Central. A tela pede o EAN por linha; o do Tiny só vale se for do próprio produto (kit herda o da unidade).
- **Não testado ao vivo:** nenhum `aplicar` (escrita real) nem a tela com login. Ensaios VALID: 15987 → pai
  16358 como "2x4kg"; 15988_FBA (12kg) como tamanho novo com EAN.

## 5.11.12.2 Amazon — CRIAR anúncio pela tela de envio (19/out/2026)

Pedido do dono ("criar o módulo de criação de anúncios na Amazon"). Mesma tela e mesma função do envio da
Shopee e do ML: `anuncio-publicar` **v11/v12** (`montarCriarAmz` / `enviarCriarAmz`) + bloco "Criar anúncio
novo" de `Publicar.tsx` (antes travado para a Amazon). Só a conta **ACZ** (a SVL segue sem Merchant Token).
- **Caminho pelo código de barras** (`GET /catalog/2022-04-01/items?identifiers=<EAN>`; ASIN pai de variação
  fica fora): achou → **OFERTA** no ASIN que já existe (`requirements LISTING_OFFER_ONLY`: ASIN, condição,
  preço, FBA + produto perigoso/bateria; título, fotos e textos são os da ficha da Amazon); não achou →
  **FICHA NOVA** (`LISTING`). A pessoa pode trocar o caminho e escolher o ASIN. Restrições do ASIN
  (`/listings/2021-08-01/restrictions`) viram pendência.
- **EAN só se for DESTE produto:** digitado → `ia_produto_extra.gtin` → Tiny → cadastro; se outro produto ativo
  tem o mesmo (kit herda o da unidade — 15824 = o de 15679, 16303, 16304), não é usado (senão o kit cairia
  na ficha/oferta da unidade). EAN com dígito errado = pendência.
- **Ficha nova:** título, bullets (até 5), descrição (≤ 2.000), fotos aprovadas por endereço assinado (7 dias;
  a Amazon baixa), preço (`purchasable_offer` + `list_price`), FBA (`AMAZON_NA`), SKU **`<sku>_FBA`**,
  `model_number` = SKU, `unit_count`/`number_of_items` = soma do kit, peso e medidas pela mesma cadeia da
  Shopee/ML (`medidasDoAnuncio`), sem EAN = `supplier_declared_has_product_identifier_exemption`. Tipo de produto:
  areia/granulado/sílica = `ANIMAL_LITTER`, senão o 1º que a Amazon sugerir pelo nome (escolhível na tela).
- **Formulário montado pelo ESQUEMA do tipo** (`/definitions/2020-09-01/productTypes/{tipo}`, guardado por
  isolate): campos com sugestão (marca, fabricante, modelo, modo de uso, uso, garantia "Garantia legal de 30
  dias", componentes, líquido sim/não pelo nome, validade "não", origem BR, bateria não, produto perigoso "não
  aplicável", **cor em branco**) + os obrigatórios do esquema + **os que o validador apontar** (`attributeNames`
  dos erros que são campo do tipo; o próprio SKU às vezes vem ali e é ignorado). Valor digitado é convertido
  pelo formato do campo (lista → id da opção, booleano, número, `language_tag`). Campo que o tipo não conhece
  é tirado do corpo. A prévia passa tudo no validador (`PUT … mode=VALIDATION_PREVIEW`).
- **Erros traduzidos** (`traduzAmz`): 5665 marca não aprovada · 8560 falta EAN · 8541/8542 EAN de outro produto ·
  **8572** EAN não bate com a marca na GS1 · 8566 (vem junto do 8572).
- **Ensaios de 19/out (validador, nada criado):** 10933 Pet Clean → oferta no **B07YGQHYFL**, **sem pendência**
  (o produto já tem o anúncio `10933` — a tela avisa duplicado); 16457 Bento 10 kg → ficha nova pedindo só a
  **Cor**, e com cor dá **8572** (o EAN 7898778130264 não bate com "Bento" na GS1); 15824 kit Bumi → 8560 (sem
  EAN próprio). Envio real: NÃO feito (exige login; cria de verdade).
- **Rota de ensaio:** até 20/out 03:00 UTC a PRÉVIA da Amazon aceita a chave publicável (Shopee/ML e o envio
  seguem exigindo login — 401 conferido). `existentesAmz` passou a procurar também `<sku>_FBA`.
- **Depois de criar:** a Amazon processa em minutos (ficha nova pode levar horas para ganhar ASIN); só vende
  quando o estoque chega ao CD (envio pelo Seller Central; na SVL, pela Reposição).

## 5.11.12.3 Amazon — dados fiscais pela API (19/out/2026, só ensaio)

Pergunta do dono: dá para mandar os dados fiscais à Amazon pela API? Sonda `amazon-anuncio-sonda` **v4** (slot
`amazon-lwa-debug` v20): `?teste=fiscal&conta=ottz[&sku_amazon=X&ncm=&origem=&papel=&csosn=&cest=]` (só leitura
+ VALIDATION_PREVIEW).
- **No anúncio: SIM.** O esquema (ANIMAL_LITTER e PET_SUPPLIES) tem, todos opcionais: `ncm_code` (8 dígitos),
  `import_designation` (origem 0–8), `contributor_supply_chain_role` (distributor/manufacturer/importer),
  `tax_treatment` (CSOSN: csosn_102, _103, _300, _400, _500), `tax_classification_code` (CEST),
  `tax_legal_proceeding`. O PATCH desses campos dá **VALID** (ensaio: 15984_FBA com origem 0 + NCM 11062000;
  FBA-15825 com NCM, origem e papel). Os anúncios já têm NCM/origem/papel (preenchidos no Seller Central) e
  nenhum tem CSOSN nem CEST.
- **Achado:** o **15984_FBA** está com origem **1** (estrangeira, importação direta) — areia nacional deveria ser 0.
  Não corrigido (escrita real precisa do OK do dono).
- **`anuncio-publicar` NÃO manda nenhum campo fiscal** na ficha nova (§5.11.12.2): o anúncio nasce sem NCM/origem.
- **Notas fiscais: NÃO, por enquanto.** Invoices API (`/tax/invoices/2024-06-19/…`: NF que a Amazon emite no FBA e
  a nota de REMESSA do envio ao CD, `governmentInvoiceRequests`) e Shipment Invoicing (`/fba/outbound/brazil/v0`,
  só FBA Onsite) dão **403 nas duas contas**: os apps (Ottz Analytics, SISTEMINHA I) não têm o papel
  **"Tax Invoicing (Restricted)"** — papel restrito, pedido no Developer Central (a Amazon analisa). Na venda FBA a
  NF é emitida pela própria Amazon (Faturador), a partir dos campos fiscais do anúncio. O papel só LÊ notas: não
  grava atributo fiscal (isso é o anúncio).
- **Item A do briefing — feito (`anuncio-publicar` v13, deploy 14, conferido idêntico ao repositório):** toda criação
  pela tela (ficha nova E oferta em ASIN existente — os campos existem nos dois esquemas) leva `ncm_code` = NCM do Tiny
  ao vivo (8 dígitos; sem ele = pendência), `import_designation` = **0 sempre** (decisão do dono; Tiny ≠ 0 vira aviso
  "a NF sai diferente"), `contributor_supply_chain_role` e regime pela conta (`FISCAL_AMZ` no código: ACZ = regime
  normal, papel distributor; SVL = regime a confirmar) e `tax_classification_code` = CEST. Aparecem no formulário da
  conferência (dá para corrigir) e num resumo no bloco Amazon. **CEST:** a API v3 do Tiny NÃO traz o campo (chaves
  conferidas no payload); a função lê pela v2 (`produto.obter`, `TINY_V2_TOKEN`) — nos dois testes veio vazio (areia e
  perfume), não confirmado que a v2 devolve. **CST:** o esquema da Amazon só tem CSOSN (`tax_treatment`); para a ACZ
  (lucro real) nada vai nesse campo. Ensaio da prévia: 16457 (ficha) e 10933 (oferta B07YGQHYFL) com NCM 25059000 /
  33029019, origem 0, VALID. O **briefing citava `tiny-fiscal-offers`**: é um script de planilha sobre
  `tmp_fiscal_offers` (193 linhas) — não serve para o envio; o envio já lê o Tiny ao vivo. `tiny-fiscal-produtos` grava
  `produtos_fiscal` (22 linhas) e serve para a varredura.
- **1º anúncio Amazon criado pela tela:** 16457_FBA (ASIN B0HNKZD9BN), 19/out 12h09, pelo dono, com a v12 —
  **sem nenhum dado fiscal** (NCM, origem e papel vazios). O PATCH com NCM 25059000 / origem 0 / distributor dá VALID
  no validador; aplicar é escrita real (aguarda OK, junto com o 15984_FBA).
- **Correções APLICADAS (19/out, OK do dono):** 15984_FBA origem 1 → **0** (submission b3962f34…) e 16457_FBA
  NCM 25059000 + origem 0 + distributor (submission 4612b8b3…), ambas ACCEPTED e já relidas no anúncio. Feitas pela
  sonda v5 (`amazon-lwa-debug` v21) `?teste=fiscal-aplicar` — lê antes, valida, aplica UMA vez, relê; registro em
  `debug_fulfillment` (`modulo='amazon-fiscal-aplicar'`). A rota só aceita esses dois SKUs e morre em 20/out 03:00 UTC.
  `?teste=fiscal-varredura[&pagina=]` (só leitura) lista os anúncios com os campos fiscais: ACZ = 499 anúncios.
- **Varredura ACZ × Tiny (19/out, só leitura; planilha entregue ao dono para aprovar):** 499 anúncios, 62 "ativos"
  (venda em 90 d ou estoque no FBA); só 56 sem nenhuma divergência (31 dos ativos). Amazon sem NCM/origem: 299 (11
  ativos); sem atividade: 412; origem 1 na Amazon: 21 (8 ativos, ex. 15983_FBA, 0Q-MGF3-VY0C, J3-A6R2-YDMX, 16330_FBA);
  origem 5: 5; **NCM diferente do Tiny: 30** (9 ativos — Gatissimo/Kets/Mr. Miau com 35051000 na Amazon × 25059000 no
  Tiny; 14426 sílica 35051000 × 28112230; 16011 Mya Cat 35051000 × 11062000; 16163 11062000 × 11081400; 15818
  33051000 × 33059000) — NCM muda o imposto: confirmar com o contador antes de trocar. **Origem ≠ 0 no próprio Tiny:
  26 produtos** (Good Pad/PetLike 5, Ultra Secão, Tofu/Purple Moon/Great Pets 1, Kets White 2, Seresto 6, Drontal 2) —
  acertar no Tiny, senão a NF sai diferente do anúncio. 82 anúncios apontam para SKU que não existe mais no Tiny
  (antigos, sem venda). Tiny lido por `tiny-fiscal-produtos?skus=` → `produtos_fiscal` (a função não espera o 429 do
  Tiny: em lotes de 28 metade falhava; lotes de 5 com 8 s de pausa passaram). De-para usado: `sku_mapeamento`
  (J3-A6R2-YDMX = 15679 lá; o briefing dizia "produto do 15825") + tirar `_FBA`/`_FBAA`/`_FBM`/`FBA-`/`-FBA`/`- HJ`.
- **Regra do dono (19/out, `anuncio-publicar` v12, deploy 13): na Amazon, só produto Bumi vai com a marca própria;
  todo o resto vai como "Genérico"** (marca e fabricante; `/bumi/i` na marca do cadastro). Na FICHA NOVA de um
  Genérico o EAN do cadastro NÃO vai — é do fabricante na GS1 e dá **8572**; só vai se for digitado. `opcoes.sem_gtin`
  tira o código de qualquer produto. Ensaio no validador (16457 Bento Mix, conta ACZ): Genérico **sem EAN = VALID**;
  Genérico com o EAN = 8572 + 8566; "Bento" com o EAN = 8572 (o código nem é da Bento na GS1). Ou seja, a conta ACZ
  aceita "Genérico" sem código. A prévia devolve `amazon.marca`, `generico`, `ean_ficha`; a tela mostra o aviso e o
  campo EAN com o código que vai de fato. A OFERTA num ASIN que já existe não muda (a marca é a da ficha da Amazon).

## 5.11.13 Termos de busca reais no título, nas palavras escondidas da Amazon e no Modelo do ML (20/out/2026)

Pedido do dono: títulos pelo que o comprador realmente busca (opção B = A + palavras escondidas da Amazon). SQL +
rollback em `docs/ia-termos-busca.sql`.
- **Fontes:** Shopee = API de anúncios patrocinados **`ads/get_recommended_keyword_list`** (`item_id`, ~50 termos por
  anúncio com `search_volume` mensal REAL, `quality_score`, `suggested_bid`; ex. "areia para gato" 339 mil) — módulos
  `palavras` e `palavras-sku` da `shopee-ads-gestao` **v5** (slot `shopee-flashsale-probe`, deploy 21), gravam
  **`shopee_palavras`** (PK shop+item+termo); só leitura na Shopee. Amazon = Brand Analytics (`pesquisa_amz_brand_analytics`,
  só RANK, só a ACZ). ML = `pesquisa_ml_tendencias` (só posição); `pesquisa-ml` **v3** coleta também as categorias em que
  vendemos (`atuo`) e ganhou `?modo=tendencias` (131 categorias, 2.309 termos em 20/out).
- **RPC `ia_termos_busca(p_sku, p_titulo default null)`** (security invoker, authenticated + service_role; ~0,3 s): junta as
  três fontes do produto (+ variações e componentes do kit; ML pelas categorias dos nossos MLB e as 2 de cima). Relevância:
  o termo tem o **núcleo** (1ª palavra do nome) e é **confirmado** (todas as palavras já estão no vocabulário do produto =
  nome, categoria e textos de TODOS os rascunhos dele e das variações) ou **a conferir** (≥ 50% das palavras no nome).
  Marca de outro fabricante = `concorrente` (lista de `produtos`, `pesquisa_amz_asins` + fixa; a própria marca não conta).
  Sem `unaccent`: `ia_norm()` tira acento por `translate`; `ia_tokens()` = palavras ≥ 3 letras sem stopwords e sem plural.
  Devolve as 3 listas (com `no_titulo`), `palavras_ocultas` (palavras dos confirmados que o título NÃO cobre, ≤ 249 bytes),
  `modelo_sugerido` (as mesmas na ordem do ML, ≤ 60) e `cobertura` (fortes no título). Só os CONFIRMADOS viram palavras
  escondidas e Modelo. Testado como `authenticated` (15984, 11538).
- **IA de texto (`ia-anuncio` v5, deploy 7):** título, descrição e bullets recebem "TERMOS QUE OS COMPRADORES REALMENTE
  BUSCAM" (o canal do anúncio primeiro, até 12 por fonte com volume/posição) + "A CONFERIR" (só se a foto/rótulo confirmar)
  + "nunca marca de outro fabricante". Falha da RPC = gera sem o bloco. `memoria_calculo.termos_busca` = quantos de cada fonte.
- **Envio (`anuncio-publicar` v14, deploy 15):** Amazon ficha nova → `generic_keyword` no formulário; Amazon atualizar →
  `campos.palavras` (ligado por padrão; vira falso sozinho se não há palavra ou já é a mesma; `opcoes.palavras` troca o
  texto) com patch `replace /attributes/generic_keyword`; ML criar → **MODEL** entra sempre que a categoria tem, com o
  `modelo_sugerido` (digitado > termos > palpite do ML). **Não testado ao vivo** (exige login; nenhum envio feito).
- **Tela:** bloco "Termos de busca" na aba Anúncio de `/ia/gerar` (`TermosBusca.tsx`): três colunas, ✓ = já no título,
  itálico = a conferir, riscado = concorrente, cobertura do título, palavras escondidas/Modelo para copiar e "Atualizar
  palavras da Shopee" (lê sozinho 1× por tela se o produto tem anúncio e o dado falta ou tem > 30 dias). Na conferência da
  Amazon (atualizar), linha "Palavras de busca (escondidas)" hoje → vai ficar, desmarcável.
- **Limites:** Amazon e ML não dão volume (só posição); a Shopee sugere só para anúncio que já existe; termo "a conferir"
  pode ser de outro tipo de produto (tofu, sílica numa areia de mandioca) — por isso nunca vai para palavras/Modelo.

## 6. Edge Functions

| Função | Versão | Papel |
|---|---|---|
| `shopee-sync-ads` | v66 | Etiquetas (pregerar/imprimir), catálogo, ADS — ver seção 5.1. v66: `imprimir` usa a fila própria quando a impressora é nossa (§5.9) |
| `shopee-ship` | v2 | Confirmar envio na Shopee (`ship_order`) — ver seção 5.1 |
| `shopee-catalogo-itens` | v2 | Relê do catálogo Shopee **só os anúncios pedidos** (v2: `modulo=recentes` = anúncios novos/alterados nos últimos N dias que o espelho não tem; fonte em `supabase/functions/`) (≤30/chamada, `pendentes` = reenviar) e faz upsert no espelho com o MESMO mapeamento do `shopee-sync-ads?modulo=catalogo`. Só leitura na Shopee; JWT de usuário. Usado pelo "Atualizar da Shopee" da Minha Promoção — ver seção 5.9.1 |
| `shopee-flashsale` | v11 (deploy 24, 21/out — escrita com `confirmar=1` só com login de usuário ou service role; a chave pública só lê e faz prévia; exceção: a rodada do robô `programar&auto=1` sem `dia`, cron 87; o front `chamarFlashsale` manda a sessão) · v10 (deploy 23 — limite de 50 VARIAÇÕES por relâmpago, §5.9.1.1); antes: v9 (deploy 22; a descrição ao lado é da v3 — ver §5.9.1 para v8/v9) | Relâmpago da Loja: leitura (slots/criteria/list/sale/catalogo) + escrita gated `confirmar=1` (criar/add-items/ativar/remover-itens/excluir) + **`programar` = RECONCILIAÇÃO**: compara `flashsale_programacao` com o que JÁ existe no slot de amanhã na Shopee e adiciona só o que falta — completa blocos existentes e cria blocos novos de até `flashsale_config.max_itens_bloco` produtos (default 10, limite do Seller Center), ativando só os novos. **ARMADILHA:** `get_time_slot_id` ESCONDE slot que já tem sale — o timeslot do dia vem das sales existentes primeiro. Cron jobid 87 (21h UTC; `&auto=1` respeita `automacao_ativa`, default OFF). Guarda de preço: pula promo ≥ original ou < 50%. Tela `/flash-sale` (busca no espelho `shopee_anuncios`; MC% via RPC `flashsale_mc_base` = comissão/imposto efetivos 60d + CMV kit-aware; grant só authenticated) |
| `tiny-separacao` | v33 | Sync da fila, tags de lote, embalar. `processar-abertos` confere o Tiny **ao vivo** e espelha na hora o que falta (fecha o gap de ~10 min do espelho); apos aprovar, marca `aprovada` no espelho (evita reprocesso/marcador duplicado) |
| `separacao-falta` | v6 (deploy 9) | Reportar falta de estoque: marcador "FALTA ESTOQUE" no Tiny + aviso no Discord (canal `estoque` = #estoque-pedido-sem-estoque) + **balanço 0 no depósito Geral do Tiny** (`zerar=1`, kit exige `sku_zerar`) + agenda a conferência da Shopee. `?separacao_id=` um pedido; `?tag=` lote; `?grupo=` linha da fila; `&preview=1` lê o saldo ao vivo sem aplicar nada; `?desfazer=1&sku=` "estoque voltou". Grava `separacao_tiny.falta_estoque_em/_por`. Ver §5.0.2. Separada da tiny-separacao de propósito |
| `produtos-peso` | v2 | Peso real do produto (`dimensoes.pesoBruto` do Tiny) → `produtos.peso_bruto`. Base da divisão de separação por peso — ver §5.0.3. `?modulo=preencher` (cron jobid 113, `9,39`), `refresh`, `sku=X`, `&dry=1` |
| `estoque-conferir` | v1 | Fecha o ciclo da falta: lê o estoque **ao vivo** dos anúncios Shopee do SKU (`get_model_list` / `get_item_base_info`, duas lojas) e avisa no canal `estoque` se, depois do balanço 0 no Tiny, a Shopee ainda mostra estoque. `?modulo=conferir` (cron jobid 109, `4-59/5`), `&sku=X` força, `?modulo=estoque&sku=X` só leitura. Ver §5.0.2 |
| `shopee-sync` | v20 | Pedidos Shopee |
| `tiny-sync` | v44 | Pedidos Tiny |
| `tiny-sync-produtos` | v29 | Produtos/kits/estoque Tiny — ver seção 4 e 9. v28/v29: listagem retomável (ativos → inativos → excluídos), `sku_pai` das variações, 404 no detalhe = inativo — ver §5.11.9. Fonte: `docs/catalogo-espelho-tiny/tiny-sync-produtos-v29.ts` (não há cópia em `supabase/functions`). `verify_jwt` **false** |
| `amazon-sync-pedidos` | v19 | Pedidos Amazon (Orders API + OrderItems) — ver seção 9. Cron 33 (`dias=7`) só relê pedidos **criados** nos últimos 7 dias; **`modulo=pendentes`** (v19, cron 122 `29 11,23 * * *`) relê pelo ID (`AmazonOrderIds`, 50/chamada) os Pending mais velhos que 6 dias — antes ficavam presos para sempre (24/set: 94 presos desde jul → 44 enviados entraram no PI, 18 cancelados). Só grava status "enviado" junto com o preço |
| `amazon-sync-financas` | v11 | Finanças Amazon (taxas reais + módulo `estimar`) — ver seção 9 |
| `amazon-ads-oauth` | v1 | Conecta a **Amazon Ads API** (separada da SP-API; BR = região NA, consentimento em amazon.com, API advertising-api.amazon.com). `?help=1&conta=ottz\|svl` → link; state assinado (HMAC, 30 min); grava `oauth_tokens_amazon_ads` (só service_role) + `/v2/profiles` e o perfil BR. Secrets do dono: `AMAZON_ADS_CLIENT_ID/_SECRET` (security profile LwA próprio). verify_jwt OFF (redirect). Criada 02/out/2026 — aguardando o dono cadastrar o app |
| `ml-sync` | v21 | Pedidos ML (Orders API direto, `fonte='api'`) — ver seção 9 |
| `ml-promocoes` | v26 (16/out: robô também troca e ajusta o preço; fonte em `supabase/functions/ml-promocoes/`) | Central de Promoções ML (`/promocoes-ml`). **v26 (16/out/2026, pedido do dono — "não estão sendo aplicadas"):** o robô funcionava, mas quase nada passava: 64 de 82 candidatas com MC < 15% no preço sugerido, 4 com MC boa barradas só por frete estimado (produto novo sem frete medido) e as trocas só pela tela. Agora: `exigir_frete_real = false` no banco; o `modulo=auto` faz (1) a entrada de sempre, (2) **troca** quando a nova dá MC ≥ regra e ganho ≥ `ganho_min_troca` — só se a promoção atual está EM ANDAMENTO (`ml_promocoes.status = 'started'`; não tira de campanha programada como a "11.11 da Black") e a nova NÃO é Relâmpago (dura horas; o anúncio ficaria sem promoção depois); recusa volta para a anterior (`trocarItem`, a mesma rotina do botão); (3) **preço dentro da faixa**: candidata sem co-financiamento/offer_id que não passa no sugerido entra no MENOR preço até `preco_max` que ainda dá MC ≥ regra (busca binária, comissão do `listing_prices` ao vivo, avaliação limitada a 9 s; `acao = 'auto-preco'`). Teto `max_por_rodada` vale para as três etapas juntas; o modo `simulacao` devolve `aplicaria`/`trocaria`/`trocas_puladas`/`ajustaria`. 1ª simulação: 4 entradas (16457 ×2, 16478 ×2) + 2 com preço ajustado (15508 R$ 33,26 × sugerido 32,73; 16012 R$ 56,16 × 53,31), todas na "11.11 da Black"; as 2 trocas do 15836 (Black → Relâmpago) puladas de propósito. **Regra de entrada automática (dono, 05/out):** `ml_promo_regra` (id=1: `modo` desligado/simulacao/ligado, `mc_min_pct` 0,15, `ganho_min_troca` R$0,50, `exigir_frete_real`, `max_por_rodada` 20) + **`view_ml_promo_decisao`** (fonte única: `auto` = MC%≥regra, melhor do anúncio, anúncio fora de promoção, frete real · `confirmar` · `trocar` = já está numa promoção e esta dá +R$0,50/un · `manter_atual` · `outra_melhor` · `sem_cmv`). Robô `modulo=auto` (cron **139** `35 10,14,18`; aceita chave pública porque só executa a regra do banco) avisa no Discord #atualizacoes; `modulo=trocar` (login) sai da atual e entra na melhor, volta se a nova recusar (Relâmpago ativo não sai). Começou em SIMULAÇÃO. **Escrita (aplicar/remover/item) exige JWT de usuário** (antes aceitava a chave pública). `aplicar` confere AO VIVO antes (`/seller-promotions/items/{mlb}`) e grava tudo em `ml_promocao_acoes` (resposta do ML). **Relâmpago exige `stock`** (faixa `stock.min..max`) e preço ≤ `max_discounted_price` (o sugerido pode passar). **Relâmpago só p/ anúncios com venda no ML em 30d** (dono, 05/out): `modulo=relampago` confere cada um ao vivo, 5 em paralelo, rodízio por `ml_relampago_verif`; cron **138** `25,28 10,14,18 * * *`; o sync (cron 73, 1×/dia) não lê mais as 1.200+ candidatas do Relâmpago. Sync marca campanha vencida `finished` e apaga os itens. Vendas 30d = RPC `ml_vendas_30d_sku` (~0,1 s) |
| `ml-sync-ads` | v8 (deploy 21; 19/out: `modulo=campanha-anuncios&campanha=` = produtos da campanha com métricas, ao vivo — a tela /ads-ml abre a campanha) · v7 (deploy 19; 19/out: `modulo=roas-alvo` — 1ª escrita no Mercado Ads, recusada com 401 "User does not have permission to write"; fonte agora em `supabase/functions/ml-sync-ads/`) · v6 | ADS ML: janela por campanha (`ml_ads_campanha`) + `modulo=diario` (série `ml_ads_diario` **e** `ml_ads_campanha_diario`; `&so_campanha=1` grava só a por campanha) + `modulo=anuncios` (por MLB/dia → `ml_ads_anuncio_diario`; ~1 s/dia, para em 20 s e devolve `parou_em`) + `sonda-ads`. Só leitura na API |
| `ml-sync-anuncios` | v4 | Catálogo ML (`ml_anuncios`): v4 grava também `preco` (cheio), `preco_original`, `estoque` — base do snapshot do Agente de ADS. Conta Ottz fixa |
| `ml-etiqueta` | v16 | Etiqueta ML (ZPL via PrintNode ou fila própria §5.9) + **upload de NF-e ao ML** quando o Tiny falha (`enviar-nf` manual; `varrer-nf` = cron jobid 96 a cada 10 min, backoff em `ml_nf_estado`). Endpoint certo: `POST /shipments/{sid}/invoice_data?siteId=MLB` com o **nfeProc puro** (o obter.xml da v2 do Tiny devolve envelope `<retorno><xml_nfe>` — mandar o envelope dá "Malformed XML"). Bloqueio v2 cod 6 aborta a rodada — ver seção 6.2 |
| `fulfillment-sync` | v5.1 (deploy 21, 21/out: CORS de volta — a v4 saiu sem nenhum cabeçalho CORS e o botão "Sincronizar" do Fulfillment dava "Failed to fetch" nos 4 módulos desde 14/out; o cron não sentia, §6.2) · v5 (deploy 20) | Estoque nos CDs. v5: o ML lê TODOS os estoques do Full a cada rodada (§5.9.4.2); v4: em trânsito da Amazon pelos envios (§5.9.4); fonte em `supabase/functions/fulfillment-sync/` |
| `compras-sync` | v3.3 | Ordens de compra (`sync`), NF de entrada (`nf`, com `?de=&ate=`) e `nf-detalhe` (detalha NF pendentes sem janela) — ver seção 5.7. Sync NÃO toca campos do app (ordem_tiny_id manual, ignorar, conciliado_*) |
| `tiny-sync-contas-pagar` | v2 | Espelho do contas a pagar + módulo `liquidacao` (data/valor da baixa) — ver seção 5.7. Token fixo `conta='ottz'` |
| `fulfillment-inbound` | v15 | **v15:** `imprimir` ZPL pela fila própria quando a impressora é nossa (§5.9). Lê o PDF de preparação do inbound (SKU/qtd/título, posicional via unpdf) — ver seção 9. **v14 (25/set):** SKU/título lidos SÓ na coluna de produto (à esquerda de "UNIDADES"); antes o "12" da coluna de quantidade colava em "SKU:" quando o ML quebrava o SKU de linha → SKU fantasma e TODAS as qtds deslocadas (soma fechava por acaso). `confere` agora exige nº de SKUs = "Produtos do envio: N" = nº de qtds. Regressão com 12 PDFs reais: 9 idênticos, 3 corrigidos |
| `nf-devolucao` | v3.21 (deploy 36) | Devoluções: `varrer-cancelados` (cron), `pendentes`, `emitir`, `criar` (SVL aceita reembolso aceito, itens parciais com kit aberto, anti-duplicata), `clonar`/`clonar-lote` — ver seções 5.2 e 5.2.3 |
| `devolucao-auto` | v6 (deploy 9; fonte em `supabase/functions/devolucao-auto/`) | Motor da NF de devolução automática da SVL: `espelhar` (chave da venda nas devoluções), `processar` (cria Pendente via `nf-devolucao?modulo=criar`), **`emitir`** (v6: emite as notas que o motor criou; cron 158), `status` — ver §5.2.3 |
| `shopee-devolucao-probe` | v28 (fonte em `supabase/functions/shopee-devolucao-probe/`) | Returns da Shopee: `sync`, `detalhar` (v26 `prazo_disputa`, v27/v28 `prazo_vendedor` + `volta_entregue_em`), `escrow`, `rastreio-ida`, `volta`, responder — ver §5.10. **Não apagar** (crons 124–126) |
| `etiquetas-saude` | v5 | **Quadro do dia e alerta de risco de cancelamento vão para o canal `atualizacoes`** (#atualizações-projeto, pedido do dono 16/set); token e pipeline degradado seguem em `erros`. Texto do risco = UMA linha por loja (tudo que já venceu ou cancela hoje somado). `resumo` / `discord` (quadro 2×/dia) / `verificar` (watchdog 20 min) / **`entrega-rapida`** (cron jobid 103, 12h10 BRT): lista pedidos Shopee **Entrega Rápida** ainda não entregues ao motorista com prazo hoje/vencido, via `view_entrega_rapida_pendentes` (status Shopee pré-envio E situação Tiny não enviada, janela 10 dias — o espelho da Shopee tem 1.204 fantasmas em PROCESSED de mai–jul). Silêncio se não há pendente; `&sempre=1` força |
| `discord-notify` | v2 | **Porta única** de saída para o Discord (webhooks em secret, um por canal) — ver seção 6.1 |
| `discord-avisos` | v2 | Cobra checklist não fechado, marcando a pessoa — ver seção 6.1 |
| `resumo-operacao` | v3 | Resumos de abertura/fechamento/fulfillment no Discord |
| `ml-agendados` | v1 | ML Ottz **na agência** (`xd_drop_off`/`drop_off`; Flex/Full fora) com **etiqueta programada** (envio `pending/buffered`, `lead_time.buffering.date` = data limite de despacho): no dia em que o ML libera (ou na data) → confere o pedido ao vivo no Tiny, **TAG + aprova**; depois NF (Tiny gera sozinho ou o app gera/emite; 656 = para) e rede de segurança do XML via `ml-nfe`. Controle em `ml_agendados_log`. Sem `confirmar=1` = simulação |
| `ml-nfe` | v4 | Envia o XML da NF-e (Tiny) ao ML quando o Tiny não manda os dados fiscais: `?modulo=pendentes` (quem o ML espera NF), `status&pack=`, `enviar&pack=` (dry) / `&confirmar=1`. Conta ML Ottz fixa (user 1107117809). **Só envia com envio em `invoice_pending`** — o Tiny manda os dados com ATRASO (23/set: 5 pedidos viraram `ready_to_print` minutos depois da NF), sem a trava duplicaria |
| `tiktok-oauth` | v1 | Callback **público** (verify_jwt off) da autorização do TikTok Shop → `oauth_tokens_tiktok` + `tiktok_lojas` (shop_cipher). `?help=1` mostra o link |
| `tiktok-refresh-token` | v1 | Renova o token TikTok (validade ~7d; renova se vence em <5d). Cron `tiktok-refresh-token` (jobid 115, `41 9 * * *`) |
| `impressao` | v1 | Impressão própria (fila `print_jobs` + agente Windows) — ver seção 5.9 |
| `tiktok-sync-pedidos` | v4 | Espelho TikTok (ACZ) em `tiktok_pedidos`/`tiktok_pedido_itens`/`tiktok_extratos`/`tiktok_extrato_transacoes`/`tiktok_devolucoes`/`tiktok_cancelamentos` — ver seção 5.8. Crons 117–121 |
| `tiktok-rastreio` | v1 | Rastreio J&T (999881…) dos pedidos TikTok → `tiktok_rastreios` (a bipagem de Devoluções casa por ele). Cron jobid 123 — ver §5.2.2 |
| `tiktok-promocoes` | v2 (deploy 3) | Promoções TikTok ACZ: `sync` (catálogo + promoções → espelho, cron 151), `sonda` e escrita com prévia/`confirmar=1` + JWT de usuário (`criar`, `editar`, `produtos`, `remover`, `encerrar`) — ver §5.9.1 |
| `amazon-promocoes` | v2 | Diagnóstico de permissões da SP-API (Promotions/Listings/Pricing) por conta. Só leitura — ver §5.9.1 |
| `amazon-inbound` | v11 (deploy 14; 22/out: encaixotamento do envio — caixas e preparo — na tela do envio) · v10 (deploy 13; 21/out: DANFE em PDF do XML via `_shared/danfe.ts` + coleta reservada lida da Amazon) · v9 (deploy 12; 21/out: `nf-remessa` importa o XML da NF de remessa, cron 169) · v8.1 (deploy 11; prepDetails com vírgula) · v8 (deploy 10; 20/out: ACZ liberada + `modelos-importar`, §5.9.4) · v6 (deploy 7; 19/out: `envios-app` cria o envio na aba Envios com etiquetas); v5 (deploy 6: `transporte` e `confirmar-transporte` — destino confirmado pela API obriga o transporte pela API) | Envio ao FBA pela API (Fulfillment Inbound v2024-03-20) a partir da Reposição: `lista`, `previa`, `avancar`, `confirmar-destino`, `transporte`, `confirmar-transporte`, `cancelar`; JWT de usuário + módulo galpao; só SVL — ver §5.9.4 |
| `fulfillment-tarefas` | v1 | Tarefas do galpão (§5.9.3): `avisar` (Discord), `ajuste-preview` (saldo do Geral ao vivo) e `ajuste-aplicar&confirmar=1` (balanço = contado). Exige JWT de usuário |
| `ia-anuncio` | v5 (deploy 7; 20/out: termos reais de busca no texto, §5.11.13); v4 (deploy 6) | IA · Anúncios Fase 2: briefing, texto+preço, prompts de imagem, enfileirar imagens, foto de referência. JWT de usuário + módulo `ia`. Texto pela Anthropic ou, sem a chave dela, pela OpenAI; v4: várias fotos reais e instruções do produto obrigatórias — ver §5.11.1, §5.11.4 e §5.11.11.10 |
| `ia-imagem-worker` | v5 (deploy 6: capa limpa sem texto na hora de gerar); v4 (deploy 5; 18/out: arquivo novo por versão + "o que mudar?" no topo do prompt, §5.11.11.14); v3 (deploy 4) | Fila de imagens da IA (1 por chamada, encadeada; rede de segurança `ia_fila_vigiar` a cada 5 min); imagens de contexto também para a OpenAI; v3: fotos reais extras e instruções do produto sempre no prompt; `{"status": true}` = diagnóstico das chaves — ver §5.11.1, §5.11.3, §5.11.4 e §5.11.11.10 |
| `anuncio-publicar` | v14 (deploy 15; 20/out: palavras escondidas da Amazon e Modelo do ML pelos termos de busca, §5.11.13); v13 (deploy 14; 19/out: dados fiscais — NCM do Tiny, origem 0, papel e CEST — na criação Amazon, §5.11.12.3); v12 (deploy 13; 19/out: na Amazon, fora da Bumi a marca vai "Genérico" e a ficha nova sai sem o EAN do fabricante, §5.11.12.2); v11 (deploy 12; a Amazon também CRIA — oferta em ASIN existente ou ficha nova); v10 | Envia o anúncio da IA direto ao marketplace — Shopee e (v4) Mercado Livre; criar ou atualizar anúncio existente: `existentes`, `previa` (só lê), `enviar` com `confirmar: true`. v5: `destino {canal, empresa}` no corpo — o mesmo rascunho vai para qualquer loja; v6: ordem manual das fotos e fotos atuais por posição; v8: peso/medidas ignoram zero do cadastro (peso pelo sistema, embalagem padrão 40×30×15); v9: produto pai acha o anúncio Shopee pelos SKUs das variações (§5.11.11.10); v10: capa principal por loja (§5.11.11.11). JWT de usuário + módulo `ia` — ver §5.11.5, §5.11.7 e §5.11.11.3 |
| `anuncio-shopee-variacoes` | v7 (16/out: `ler` e `ampliar` — opções novas em anúncio que já está no ar, §5.11.11.12); v6 (deploy 6; v6 = duas grades, cor × quantidade — §5.11.8; v4: peso e medidas por variação; `ativar` põe no ar depois das variações, com 1 nova tentativa; módulo `ativar`) | 2º passo do envio à Shopee: cria as opções (variações) num anúncio simples já criado — `init_tier_variation`. `previa`, `criar`. JWT de usuário + módulo `ia` — ver §5.11.11 |
| `tiny-produto-variacoes` | v6 (deploy 9 — o 9 só acrescenta a rota temporária `inativar-16523`; várias bases e duas grades — cor × quantidade, módulo `grade` — §5.11.8; v5: `fotos-anuncio` manda as fotos do anúncio ao Tiny — §5.11.11.1) | Cria no Tiny, a partir de um produto simples, o produto com variações em que cada variação é kit do base (v3 cria, v2 transforma em kit). `sugerir` (SKUs livres conferidos ao vivo no Tiny), `previa`, `criar` (herda a foto principal do base e marca `criado_app_em`), `kit`, `foto`. JWT de usuário + módulo `ia` — ver §5.11.8 |
| `tiny-produto-importar` | v1 | Traz/atualiza no espelho `produtos` um produto do Tiny NA HORA (código exato → detalhe; kit, variações e pai junto). Só lê no Tiny. Sessão de usuário — ver §5.11.11.12 |
| `ia-aproveitar` | v2 (18/out: `subir`, `no-ar`, `copiar-no-ar` — fotos à mão e de anúncio no ar, §5.11.11.13) | Aproveita texto e fotos já gerados, sem chamar IA: o mesmo produto em outro canal e a família de kit. `fontes`, `destinos`, `aplicar`, `aplicar-lote`. Só banco e Storage da gestão. JWT de usuário + módulo `ia` — ver §5.11.6 |
| `shopee-flashsale-probe` | v21 (= `shopee-ads-gestao` v5: + `palavras` / `palavras-sku`, sugestão de palavras com volume, §5.11.13); v19 (v4: + `historico-desempenho`) | Shopee Ads: meta de ROAS, orçamento, impulsionados e saldo ao vivo (`config`), alteração de meta/orçamento (`editar`, com login) e captura do histórico de configuração (`capturar`, crons 164/165) — ver §5.9.4.4 |
| `amazon-lwa-debug` | v20 (= `amazon-anuncio-sonda` v4) | Sonda da Amazon (só leitura + VALIDATION_PREVIEW): anúncio por SKU, busca, ensaio de criar, v3 pesquisa pelo ASIN + ensaio de variação, v4 dados fiscais (`teste=fiscal`) — ver §5.11.12, §5.11.12.1 e §5.11.12.3 |
| `amazon-variacoes` | v1 (deploy 3) | Família de variações na Amazon: `ler` (ASIN/SKU → família + kits do Tiny), `previa` (validador), `aplicar` (pôr anúncio solto na família, criar tamanho novo, criar pai). JWT de usuário + módulo `ia` — ver §5.11.12.1 |
| `ml-anuncio-sonda` | v5 | Diagnóstico só leitura + validador do ML: ensaia as chamadas do envio ao Mercado Livre para um SKU (`?conta=ottz\|svl&sku=`); v4/v5: `?teste=limite` (limite por compra — recusado pela API) — ver §5.11.5 |
| `anuncio-publicar-sonda` | v1 | Diagnóstico só leitura: o que cada marketplace exige para criar anúncio e se os apps têm acesso — ver §5.11.3 |
| `pesquisa-ml` | v3 (20/out: tendências também das categorias em que vendemos + `?modo=tendencias`, §5.11.13); v2 (19/out: grava `anuncio_proprio` × `participo_catalogo`) | Pesquisa de produtos ML: `descobrir_lideranca`, `diario`, `semanal` (top 20 por categoria + tendências do Pet Shop), só leitura no ML — ver §5.9.5. Crons 155–157 |
| `pesquisa-amz` | v3 | Pesquisa de produtos Amazon: `meus`, `descobrir`, `diario` (BSR), `brand_analytics`; só leitura na SP-API — ver §5.9.6. Crons 159–162 |
| `ml-devolucao-lookup` | v4 | Etiqueta de devolução do ML → pedido (`/shipments`) + indexador de devoluções por reclamação (cron 114) — ver §5.2.1 |

**Limite rígido: ~30 segundos por execução.** Toda função que processa lote
precisa de orçamento de tempo e parar com folga para gravar o que já fez. Isso
já causou falha silenciosa: a pré-geração de etiquetas batia 30s em *toda*
execução, retornava 200 e não gravava nada — a fila nunca andava.

---

## 6.2 CORS — o erro que faz o botão não fazer NADA

**Toda edge function chamada pelo front precisa responder o preflight com o
bloco CORS completo** — não basta o `Access-Control-Allow-Origin`:

```ts
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
```

Sem o **`Access-Control-Allow-Headers`** o navegador não recebe permissão para
enviar o cabeçalho `authorization` e **bloqueia a requisição real**: o `OPTIONS`
sai, o `GET` nunca. O sintoma na bancada é o pior possível — **o botão não faz
nada e nenhum erro aparece na tela** (o erro fica só no console do navegador).

Custou 3 dias de "o ML não imprime" (21→24/ago). A `ml-etiqueta` era a única
função do projeto fora do padrão. **Como diagnosticar:** nos logs, agrupe por
método — se só há `OPTIONS` e zero `GET`/`POST`, é CORS, não é lógica:

```sql
select log_attributes['request.method'], count(*) from logs
where source='function_edge_logs' and event_message like '%<funcao>%'
group by 1;
```

## 6.1 Discord — avisos e menções

**Porta única:** todo envio passa pela `discord-notify`. A URL do webhook é
**credencial** (quem tem, posta como se fosse o sistema) e mora só lá, em
secret — nunca no front, nunca no banco. Canais por secret:
`DISCORD_WEBHOOK_GERAL` (fallback), `_PEDIDOS`, `_FULFILMENT`, `_ERROS`,
`_ESTOQUE`, `_DEVOLUCOES`, `_COMPRAS`, `_ATUALIZACOES` (#atualizações-projeto:
relâmpago Shopee e avisos de "o sistema fez X"). Diagnóstico: `?modulo=status`
mostra quais estão configurados; `?modulo=teste&canal=X` manda uma mensagem
de prova.

**v3 (11/set/2026) — canal genérico:** qualquer `canal` vira o secret
`DISCORD_WEBHOOK_<CANAL em maiúsculas>`; sem o secret cai no GERAL (não
falha). **A porta exige JWT** (o deploy via MCP religa `verify_jwt`): TODO
chamador manda `Authorization: Bearer` — edge functions usam a service key,
funções do banco (`notificar_envio_fulfillment`, `fulfillment_atualizar_envio`)
e crons usam a chave publicável. Chamada sem header morre em 401 *silencioso*
("melhor-esforço") — o aviso simplesmente não chega. Já corrigidos:
`shopee-flashsale` v6, `separacao-falta` v5, as duas funções do banco.

**Como marcar alguém (duas pegadinhas que custam o aviso não chegar):**
1. O Discord **só notifica pelo ID numérico** — `<@583378141901357075>`.
   Escrever "@Nikolas" em texto **não marca ninguém**.
2. Menção **dentro de embed NÃO notifica**. Tem que ir no `content`.

Por isso a `discord-notify` **v2** aceita `marcar: [ids]` (vira `<@id>` no
`content`) e `conteudo` (texto livre fora do embed). O `allowed_mentions`
limita o alcance aos IDs pedidos — `@everyone`/`@here` nunca disparam por
acidente. Os IDs ficam em **`equipe_membros.discord_user_id`** (vazio = cita o
nome, sem marcar).

**Aviso de checklist (`discord-avisos`):** cobra quem não fechou a rotina.
`?turno=inicio|fim`, `&dry=1` (monta sem enviar), `&sempre=1` (posta mesmo com
tudo em dia). Lê `view_manual_pendentes_hoje`, que **espelha em SQL a regra de
completude do front** (`src/lib/manual.ts`): check → `concluido`; pergunta →
resposta E, se ela "abre" o campo, o detalhe preenchido (um "não" seco não
fecha o item). **Silêncio é bom:** sem pendência não posta nada — aviso diário
sem motivo vira ruído e a equipe para de ler.

**Crons (BRT = UTC−3):** `checklist-matinal-discord` `0 12 * * 1-5` (9h) e
`checklist-fim-discord` `30 20 * * 1-5` (17h30). O fim de semana é limitado
**no cron**, porque a maioria dos itens está com `dias = null` (roda todo dia).

**Lojas Shopee:** Ottz `shop_id 522186766` (partner 2034179) · SVL
`shop_id 759046323` (partner 2037384). Chaves em secrets separados.

**`marca_canal`** (grafia exata, usada em filtros): `"Shopee (Ottz Pet)"` e
`"Bumi Pet [Shopee]"` (ex-`"Sevilla Store [SHOPEE]"` — o Tiny RENOMEOU o canal
em 21/ago/2026; mesmo shop 759046323. Filtros por grafia exata devem aceitar as
DUAS: o rename derrubou o cron de TAGs por um dia inteiro até ser notado).

---

## 7. Performance — lições aprendidas

### Nunca meça view com `count(*)`
O planner **elimina joins agregados** em contagens. Uma view que respondia em
16ms no `count(*)` levava **40,2 segundos** para devolver 50 linhas reais.
Meça sempre selecionando as colunas de verdade.

### `LATERAL` em vez de subquery agregada global
`view_margem_pedido_v2` tinha um LEFT JOIN com CTE agregada sobre todos os
pedidos. Quando o PostgREST aplicava filtro seletivo, o planner estimava 1 linha,
escolhia Nested Loop e **recomputava a agregação de 22,6 mil pedidos uma vez por
pedido filtrado** — 968 mil execuções da subquery de kit. Reescrito com
`LEFT JOIN LATERAL` parametrizado (`WHERE pi.pedido_id = p.id` dentro):
**40.252ms → 1ms**, com resultado validado ao centavo.

### `LATERAL` — caso 2: `view_tags_pedidos` (25/ago/2026)
Mesmo padrão: CTE `itens_agg` agregava TODOS os ~63 mil pedidos de
`pedido_itens_tiny` para juntar com meia dúzia de abertos — ~2s aquecida e
**statement timeout sob carga**, derrubando o `processar-abertos` (cron 5 min +
botão da Separação) com 500 intermitente. Reescrita com `CROSS JOIN LATERAL`
parametrizado: **2.026ms → 2,6ms**, baseline md5 idêntico (22 linhas). O JOIN
interno da versão antiga excluía pedido sem itens — o `ia.n_linhas > 0`
preserva isso.

### Agregação + filtro do PostgREST = materialize
`view_kpi_pedidos_dia` como view comum calculava tudo em 59ms, mas ao receber
filtro de data o plano degradava e estourava o timeout (erro 500). Virou
MATERIALIZED VIEW com índice único + cron de refresh: **1ms**.

### DRE materializado (10/set/2026) — "canceling statement due to statement timeout"
A aba do DRE quebrou com timeout: `view_dre_operacional` e
`view_dre_deducoes_marketplace` recalculavam a margem de ~40 mil pedidos
(LATERAL de CMV da `view_margem_pedido_v2`) a cada abertura — 1 a 3 s cada,
**seis consultas em paralelo**, limite de **8 s** do role `authenticated`.
Cura igual à do Dashboard: matview **`mv_dre_pedidos_mes`** (mês × empresa ×
canal × marketplace, só `cobertura_cmv='completo'`, somas cruas; o `round`
fica nas views → saída idêntica, md5 das 3 views validado igual ao baseline).
`view_dre_mensal` caiu de **1.004 ms para 88 ms**. Refresh junto com a kpi no
cron **62** (a cada 20 min). Se criar outra view de pedidos para o DRE, leia
daqui — nunca da `view_margem_pedido_v2` direto.

### Pane de 17/set/2026 (11:26–12:01 BRT) — banco sem folga de CPU
"Erro ao carregar pedidos: upstream request timeout" no Pedidos Integrados.
Por 20 min o banco não iniciou nem cron trivial (77 "job startup timeout", 47
conexões SSL resetadas, `pg_settings` em 12,9 s) e depois estourou de novo no
minuto cheio das 12:00. Não era tráfego (as requisições caíram) nem disco
(cache 99,99%; checkpoint de 270 s é o espalhamento normal de 5 min): é a
instância pequena (1 GB) saturada pela carga de fundo. Diagnóstico pelo
`pg_stat_statements` (total acumulado) + `query_logs` por minuto. Cortes feitos
em 18/set:
- **`refresh-margem-incremental` (cron 57): 19–24 s → 0,8 s.** O UPDATE lia a
  `view_cmv_pedido` inteira (48 mil itens, agregação de kits por item) para
  mexer em 5–8 pedidos. O planner NÃO empurra o filtro para dentro da view nem
  com `IN (subquery)` nem com `LATERAL` (medido: 24 s e 20 s) — a cura é
  repetir o corpo da agregação num CTE com `p.data_pedido >= now() - '2 days'`
  DENTRO. Se a `view_cmv_pedido` mudar, o CTE do cron 57 muda junto.
- **`fn_cmv_congelar_novos`: 16 s → 0,4 s.** Ganhou `p_dias`; sem argumento =
  7 dias (cron de 15 min); `fn_cmv_congelar_novos(null)` = varredura completa,
  no cron diário `cmv-congelar-completo` (03:40 UTC).
- **`view_anomalias` → `mv_anomalias`** (2–3 s por chamada, 409×/dia entre
  sidebar, Dashboard e `/anomalias`). Matview com índice único (tipo, chave,
  marketplace), refresh no cron 62 junto da KPI (20 min); o nome
  `view_anomalias` segue valendo. md5 idêntico antes/depois (378 linhas).
- **`view_sync_status`**: índices parciais para o `max()` de carteira e escrow
  (2,8 s → 8 ms); `pedidos_tiny.atualizado_em` fica SEM índice de propósito
  (muda em todo upsert e mataria os HOT updates). Rodapé do front passou de
  30 s para 2 min.
- **19/set — Dashboard "não carrega" (10:38 BRT):** sem pane no banco; o
  Dashboard dispara 12 consultas em paralelo e três levaram 500 (8 s) logo após
  um login. `view_canais_diario` (1,7 s, 2×) e `view_canais_sem_integracao`
  (2,8 s) viraram `mv_canais_diario` / `mv_canais_sem_integracao` (mesmo
  refresh do cron 62; nomes das views preservados; md5 idêntico). Os números
  por canal do Dashboard agora têm até 20 min de atraso, como a KPI.
- **`fn_cmv_congelar_novos`, 2ª correção (19/set):** a janela de 7 dias não
  bastou (seguia em 13 s): o planner empurrava `cmv_na_data(...) IS NOT NULL`
  para ANTES do anti-join e avaliava a função (~4 ms, kit-aware) nos ~2.600
  itens da janela. CTEs `MATERIALIZED` (anti-join primeiro, função só nos
  novos). Lição: função cara em CTE filtrada depois = cerca de otimização.
Se voltar a acontecer com esses cortes no ar, o próximo passo é subir a
instância (Micro → Small), não caçar consulta.

### Dashboard com blocos vazios (08–09/out/2026) — disputa de CPU, não consulta ruim
`canceling statement due to statement timeout` (limite 8 s do `authenticated`) em rajadas no MESMO
segundo: as 11 consultas do Dashboard saíam juntas e, somadas às rotinas de fundo, nenhuma
terminava. Isoladas eram rápidas (metas 175 ms, visão geral 0,2 s) — sob carga, 3–8 s.
Feito em 09/out (pedido do dono):
- **Front em levas** (`src/routes/index.tsx`): topo+canais primeiro (libera a tela), depois
  metas/ACOS/anomalias, vendas SKU/marca, produtos/Amazon. Não voltar ao `Promise.all` único.
- **CMV congelado só de madrugada:** cron **68** `cmv-congelar-novos` (15 min, ~6,5 s) DESLIGADO;
  vale o **112** `cmv-congelar-completo` (03:40 UTC). Sem risco: a `view_margem_pedido_v2` usa o
  custo ao vivo enquanto o item não está congelado, e o custo do Tiny só muda 1×/dia (05h BRT).
  Exceção: custo trocado no meio do dia (Puxar custo / formação de custo) congela os pedidos do
  dia com o custo novo.
- **Estoque do Tiny só de manhã:** cron **58** `tiny-estoque-reposicao` de `*/10` o dia todo
  (lia a `view_reposicao_skus_alvo`, 5,7 s, 144×/dia) para **`*/10 8-10 * * *`** (05h–07h50 BRT,
  18 rodadas × 35 = os 601 SKUs-alvo 1×/dia). O app não manda estoque aos marketplaces (o Tiny
  manda); quem lê `estoque_tiny` = reposição do Full, cobertura do agente de compras (cron 127,
  madrugada) e inventário (o ajuste relê ao vivo).
- **Pendente (DDL, noite):** índice parcial `pedidos_tiny (data_pedido desc) where valor_produtos
  is null` (busca do sync levava 3,7 s × centenas/dia, 11% do tempo do banco) e janela de 30 dias +
  índice em `pedidos_sem_escrow_componente` (percorria 32 mil pedidos para achar 6 de hoje, ~4 s).

### Ao mexer em view de cálculo, capture baseline antes
Rode os totais de um período conhecido **antes** da alteração e compare depois,
ao centavo. Foi assim que a reescrita da margem foi validada com segurança.

---

## 8. Armadilhas de ambiente

- **`net._http_response` e `cron.job_run_details` incham o banco.** Já estouraram
  o limite do plano (0,5 GB) sozinhas. Existe cron de limpeza; não desative.
- **A resposta do `net.http_post` nem sempre persiste.** Para validar se uma
  função rodou, confira o **efeito na tabela**, não a resposta HTTP.
- **`etiquetas_cache` cresce sem teto e já sozinha passou de 144 MB** (o ZPL é
  pesado). Em 21/ago o banco bateu **527 MB** (teto 500 MB) e o Supabase passou
  a limitar a performance. Limpeza feita mantendo só os **últimos 5 dias** (a
  janela do `pregerar`): 144 MB → 23 MB. Etiqueta fora do cache **não se perde**
  — o `imprimir` regenera sob demanda. **10/set/2026:** voltou a 117 MB (banco em
  659 MB); limpo de novo e criado o cron `limpar-etiquetas-cache` (jobid 102,
  03:30 UTC) que chama `limpar_etiquetas_cache(5)` — copia 5 dias, TRUNCATE,
  reinsere. O `limpar-logs` (jobid 47) passou a fazer **TRUNCATE** em
  `net._http_response` (o DELETE deixava 90 MB de espaço morto p/ 1 mil linhas).
- **06/out/2026: 517 MB → 490 MB.** MVs do Agente de ADS cortadas de 90 para
  60 dias (anúncio/campanha; tendência 9→5 semanas): 40,7 MB → 10,5 MB.
  **`print_jobs`** guardava o arquivo (ZPL/PDF base64) de todo job para sempre
  (26 MB): `limpar_print_jobs_conteudo(2)` esvazia `conteudo_b64` (NOT NULL →
  `''`) de `impresso`/`erro`/`cancelado` com mais de 2 dias, mantendo o
  histórico; cron **150 `limpar-print-jobs`** (`7 4 * * *`). É UPDATE (não
  dispara `trg_print_jobs_espelha`, que é só `OF estado`): o espaço não volta
  ao disco, mas é reaproveitado — a tabela para de crescer.
- **PDF não mora no banco.** `fulfillment_envio_docs` guardava 21 MB de PDF em
  base64 (12/set/2026); migrado para o Storage bucket **`fulfillment-docs`**
  (policy anon+authenticated, caminho `<envio_id>/<8 do id>-<nome>`), a linha
  virou metadado + `storage_path` (`conteudo_base64` fica NULL; o front ainda
  lê base64 se `storage_path` for nulo). Upload/abrir/imprimir/excluir passam
  por `subirDocStorage`/`baixarDocBytes`/`removerArquivosDoEnvio` em
  `fulfillment.tsx`. Anexo novo em tabela = mesma armadilha: use Storage.
- **`escrow_componentes.raw_json`** = a resposta inteira do
  `get_escrow_detail` da Shopee por pedido (itens, preços, promoções, taxas —
  ~2,5 kB cada), 90 MB dos ~500 MB. Nada lê a coluna (nenhuma view/função/
  cron); todos os valores usados já estão nas colunas tipadas. **Retenção de
  60 dias pela data do PEDIDO** (decisão do dono, 12/set): zerado para 16.702
  pedidos antigos (38 MB) via copia+TRUNCATE+reinsert; cron
  `limpar-escrow-raw` (03:45 UTC) zera quem completa 60 dias. Não usar
  `coletado_em` como critério — ele é renovado a cada recoleta. Campo novo da
  Shopee para pedido antigo tem de ser rebuscado na API.
- **Limpeza de 25/set/2026 — 517 MB → 424 MB:** (1) `ml_notificacoes` (log bruto dos
  webhooks do ML, SÓ escrita — nada lê) 33 MB → 3,7 MB com retenção de **7 dias**:
  função `limpar_ml_notificacoes(dias)` (copia+TRUNCATE+reinsert) + cron 131
  `limpar-ml-notificacoes` (03:52 UTC); (2) `escrow_componentes` compactada (espaço
  morto dos UPDATEs que zeram `raw_json`) 84 → 72 MB, sem perder linha, política de
  60 dias mantida; (3) **índices inchados** pelo apaga-e-reinsere dos syncs — só o
  `pedido_itens_pkey` tinha 27 MB para 9 MB de dados; REINDEX em `pedido_itens`
  (41 → 12 MB), `pedidos_tiny`, `pedido_itens_tiny`, `separacao_tiny`,
  `transacoes_carteira`, `pedidos` + cron 132 `reindex-semanal` (domingo 04:17 UTC,
  lock de < 1 s por tabela); (4) removido `idx_transacoes_carteira_shopee_tx_id`
  (cópia exata da chave única `transaction_id`). **NÃO remover**
  `pedido_itens_tiny_uniq` (0 usos, mas trata NULL com COALESCE — protege contra
  item duplicado que a chave `_uniq_key` deixa passar).
- **Compactação de 13/out/2026 — 530 MB → 444 MB, sem apagar dado.** As rotinas de limpeza
  rodavam todas (crons 47, 102, 107, 131, 132, 150), mas esvaziar coluna/linha não devolve o
  espaço ao disco. `CLUSTER tabela USING <pkey>` reescreve a tabela e os índices (preserva
  FKs, gatilhos e permissões; roda dentro de transação, ao contrário do VACUUM FULL), com
  `set lock_timeout = '4s'` antes para não enfileirar atrás de um cron. Medido:
  `print_jobs` 27,3 → 8,2 MB (3 s) · `escrow_componentes` 88,9 → 66,6 MB (**33 s de tabela
  travada** — o TOAST de 47 MB é lento; fazer à noite) · `transacoes_carteira` 29,9 → 21,7 MB
  (6 s) · `pedidos` 54,4 → 24,8 MB (6 s) · `cron.job_run_details` 15,9 → 8,7 MB (dona =
  supabase_admin, não aceita CLUSTER: copia + TRUNCATE + reinsere). Feito às 08h40 com o OK do
  dono ("pode fazer agora"); nenhum cron falhou. **Causa do inchaço de `pedidos`:** crons 43
  e 46 reescrevem ~37 mil pedidos toda noite para mudar ~4 — correção pronta em
  `docs/crons-43-46-so-o-que-mudou.sql` (IS DISTINCT FROM), **aplicada em 13/out de manhã** — conferir no registro dos jobs 43 e 46 que o UPDATE caiu de ~37 mil para poucas dezenas.
- **DELETE não devolve espaço; TRUNCATE devolve.** Para encolher tabela grande
  sem `VACUUM FULL`: copie o que fica para uma tabela auxiliar, `TRUNCATE` a
  original, reinsira e derrube a auxiliar — tudo numa transação (atômico, e
  preserva grants/PK, diferente de dropar e recriar). Foi assim com
  `etiquetas_cache` e `cron.job_run_details` (42 MB → 856 kB).
- **Função SQL chamada por VIEW que um CRON refresca precisa de
  `set search_path = public` e tabela schema-qualificada.** O pg_cron roda com
  search_path próprio: a `cmv_manual_vigente` sem isso derrubou o
  `refresh-kpi-pedidos-dia` ("relation cmv_manual does not exist") e o KPI do
  Pedidos Integrados congelou por ~30 min (27/ago) enquanto a lista seguia viva.
- **Queda de 01/out/2026 (19h10–21h BRT): app sem login, API 503 `PGRST002`.** A instância
  de 1 GB saturou (dia de muitas migrations de 2 sessões + backfill `ml-hist-tmp` a cada minuto +
  refresh das matviews) e o PostgREST não conseguia recarregar o schema cache (estoura o
  `statement_timeout` do role `authenticator`). Cada DDL dispara esse reload. Medido: 8–11 s com
  cache frio logo após restart, 1,4 s aquecido → **`authenticator` ficou com 30s** (era 8s).
  Cortes de cron em 02/out: 95 desligado, 113 → a cada 2 h (peso é lido 1× por SKU; só pega produto novo), 111 pausado, 104 → 2×/dia, 109 → 15 min,
  26 → 10 min, 62 → 30 min. Regra: **DDL/migrations e backfills fora do horário comercial**;
  diagnóstico: `query_logs` postgrest_logs "schema cache".
- **Alerta "Table publicly accessible" do Supabase (20/out/2026):** 26 tabelas, 37 views/MVs e 14 funções security definer
  criadas depois do fechamento de 15/ago ainda davam acesso ao **anon** (a chave pública que vai no site) — várias migrações
  faziam `grant … to anon, authenticated` por hábito, e funções herdam EXECUTE de PUBLIC. Dava para ler e APAGAR compras,
  contas a pagar, CMV manual etc. sem login, e baixar boletos/NF dos buckets `contas-pagar-docs`/`fulfillment-docs`.
  Migração `seguranca_revogar_anon_20out`: revoke de tudo isso do anon, funções só `authenticated`/`service_role`, as
  duas políticas de storage só `authenticated`, e default privileges do postgres sem anon (funções e sequências). Conferido
  de fora: REST com a chave pública = 401. **Regra: nunca `grant … to anon`** — o app inteiro passa pelo login
  (`AuthGate`); edge function que lê com a chave pública repassa o JWT do usuário. O alerta do Supabase olha RLS desligado,
  não grants: ~110 tabelas seguem sem RLS (acesso = `authenticated`, app de uma empresa só) e ele vai continuar aparecendo
  até ligar RLS com política `to authenticated using (true)` nelas.
- **`VACUUM FULL` não roda no editor do Supabase** ("cannot run inside a
  transaction block"). `TRUNCATE` libera espaço na hora.

---

## 9. Estado do front (julho/2026)

**Resolvido:** a remontagem da árvore ao voltar para a aba do navegador (perdia
página da tabela, filtros e rolagem).

**Feito em 10/ago/2026 — Separação (impressora + identificadora) + backend do Monitoramento:**
- **Troca de impressora destravada:** o `imprimir` da `shopee-sync-ads` ignorava o
  `printer_id` do app quando `config_impressora.ativo=true`. Fix imediato:
  `config_impressora.ativo=false` (o app manda). Fix definitivo preparado (inverter
  prioridade na `resolverImpressora` — app manda, config = fallback) — deploy pendente.
- **Etiqueta identificadora** passou a sair também no fluxo **por SKU**
  (`imprimirPorSku`) — antes só saía no painel "Lotes do dia". Extraída para
  `imprimirIdentificadorApi` (módulo), reusada nos dois fluxos. Vai por
  `fulfillment-inbound?modulo=imprimir` (usa o `printer_id` do app; sem override).
- **Tela de Monitoramento de Lotes — backend PRONTO, front PENDENTE.** Ver
  `docs/tela-monitoramento-lotes.md` (lógica, contrato e prompt de design). Criados:
  coluna `tags_lote.finalizada_em`; views `view_monitoramento_lotes` (cards, com foto
  já no join) e `view_monitoramento_totais` (funil do dia); RPC
  `monitoramento_finalizar_tag(p_tag, p_desfazer)`. Escopo: Shopee single-SKU, hoje,
  Ottz+SVL juntas. "Finalizar TAG" é **só monitoramento** (não toca no Tiny). Falta
  montar a rota `/monitoramento` no front, ligada a essas views + RPC (refetch ~20s).

**Feito em 04/ago/2026 — coerência DRE × Pedidos Integrados × Dashboard + fix ML:**
- **Margem canônica = `recebido_estimado − CMV − imposto`** (view_margem_pedido_v2
  / Pedidos Integrados = escrow real). O DRE reconstruía de taxas e
  **superestimava ~R$13,6k/mês (jul)**; `view_dre_operacional` passou a usar
  `sum(margem)` e `comissoes_frete` virou resíduo (cascata fecha ao centavo).
  Baseline mai–ago validado. Rótulo "Comissões + Frete" → **"Deduções
  Marketplace"** em `dre.tsx`, com **drill-down por canal/componente** (views novas
  `view_dre_deducoes_marketplace`, `view_dre_ads_marketplace`) e **ADS por loja**
  (ML não integrado).
- **Dashboard:** `dashboard_visao_geral` **deixou de somar canais só-Tiny**
  (Temu/TikTok/ML-SVL) — topo agora bate com os cards (base pedidos_validos =
  Shopee+ML+Amazon). Esses canais aparecem numa seção separada **"Canais sem dados
  integrados"** (view `view_canais_sem_integracao`; só receita/pedidos, sem margem).
  PI segue só Shopee+ML por design (fica ~R$3k abaixo do Dashboard = Amazon).
- **`ml-sync` v21 — fix "itens sumindo":** a v20 deletava `pedido_itens` de TODO o
  lote e só reinseria `if (linhasItens>0)`; quando `/orders/search` vinha sem
  `order_items` (intermitente nos recentes), o pedido ficava com 0 itens até o
  próximo run (aparecia "0 itens/Cobertura Completa/Margem —" no PI). v21 deleta/
  repõe **só os pedidos que vieram com itens** (`idsComItens`). Sem backfill.

**PENDENTE — Amazon (captura + junção com Pedidos Integrados):**
- **Bug confirmado (doc SP-API + ao vivo):** a Amazon **não retorna `ItemPrice` em
  pedido `Pending`**; o `amazon-sync-pedidos` pega o pedido novo em Pending → grava
  `subtotal_produtos=0` e a **trava incremental** (`precisaItens = só se não tem
  itens`) nunca rebusca → receita/margem ficam **0 para sempre** (~146 pedidos,
  R$7,6k presos no `subtotal_bruto`). Efeito: `amazon-sync-financas?modulo=estimar`
  filtra `subtotal_produtos>0` e **pula** esses pedidos.
- **Fix a fazer:** em `amazon-sync-pedidos`, rebuscar itens/preço enquanto
  `subtotal_produtos` for null/0 (não só quando faltam itens) + backfill dos presos.
- **Depois:** juntar a Amazon ao Pedidos Integrados (hoje aba `/amazon` separada,
  fonte `view_amazon_dashboard`; PI = `view_margem_pedido_v2`, Shopee+ML). Atenção:
  economia Amazon é diferente (comissão + FBA + `origem_margem` real/estimado;
  status `Shipped` vs Pending/Canceled).

**Feito em 19/set/2026 — Dashboard: ADS, lucro pós ADS e ACOS mês a mês:**
- Dois cards novos no topo (**Gastos com ADS** e **Lucro pós ADS**), valor vindo
  da `dashboard_visao_geral` — ver §3. A grade dos hero KPIs passou a 3 colunas
  no xl (são 6 cards). O delta do card de ADS é **invertido** (gastar mais não
  é "verde"); `HeroKpiData.deltaInverso`.
- Painel **ACOS mês a mês** (`AcosMensalPanel`): ACOS do mês, meta do mês e as
  últimas 12 competências em barras, com a meta como traço POR BARRA — a meta
  muda de mês para mês (`metas` tipo 'acos': jul 5%, ago/set 6%), então uma
  linha única mentiria. Barra vermelha = estourou. Fonte:
  `view_metas_realizado` com `marketplace='todos'` (já trazia
  `acos_realizado`/`meta_acos`; a consulta do Dashboard só lia o mês atual e
  passou a ler a série — 32 linhas, 0,11 s). Medido: jul 7,04% × 5, ago 6,76% ×
  6, set 6,85% × 6 — estourou nos três.
- `rotuloMes` formata a competência SEM `new Date()`: a competência é data pura
  e o parse com fuso jogaria o mês para trás.

**Feito em 21/jul/2026:** limpeza do Dashboard (`src/routes/index.tsx`):
- Removida a query morta `view_receita_diaria_canal` (`limit(20000)`) e o código
  zumbi que ela alimentava (`diario`, `diarioVisivel`, `totais`, `ticketMedioAnt`,
  tipo `ReceitaDiaCanal`) — nada disso era renderizado; o gráfico
  `VendasMargemChart` consulta sozinho por `range`.
- Alerta ACOS deixou de somar `view_shopee_ads_anuncios` (`limit(20000)`) e passou
  a contar anúncios `classificacao_roas = 'ruim'` em `view_ads_resumo`. **Mudança
  de semântica:** janela agora é a da view (30 dias) e o critério é a
  classificação de ROAS, não "ACOS > 20% nos últimos 7 dias".
- Removido `limit(20000)` das duas queries de `view_canais_diario` (medido: 101
  linhas/30d, 204/90d — já agregada no servidor).

**Feito em 30/jul/2026 — Fulfillment › Envios (packing por PDF):**
- Nenhum marketplace (ML/Amazon/Shopee) expõe o **inbound pendente** por API para
  vendedor doméstico — testado: ML só dá estoque + operações (por SKU, pós-
  recebimento); Amazon `/fba/inbound` deu 403 (falta a role de Inbound no app
  SP-API). Contorno: o operador **sobe o PDF de "instruções de preparação"** do
  marketplace e o app vira um checklist de separação.
- Edge fn **`fulfillment-inbound`** (`modulo=parse-pdf`, body `{pdf_base64}`):
  lê o PDF com **unpdf** por **posição** (NÃO usar `extractText` antes de
  `getTextContent` — consome o documento e zera as coordenadas). Quantidade vem
  da coluna cujo header é **exatamente** "UNIDADES" (`/UNIDADES/i` casaria "Total
  de unidades:"). Aplica `fixEnc` (UTF-8 duplo) e casa SKU→`produtos` (título +
  foto). Validado com o PDF real #72900192 (15102×12 + 15984×125 = 137).
- Tabelas `fulfillment_envios` / `fulfillment_envio_itens` (RLS off, grant
  anon/authenticated). Sub-aba **Envios** em `/fulfillment`: novo envio (form +
  upload PDF → revisão editável → salvar) e **packing** visual (cards com foto,
  contador separado/planejado, progresso, "marcar enviado"; update otimista).
  Isso resolve o follow-up do "Montar envio" que não persistia.
- **Pendente:** reconciliar "recebido" (Amazon via role de Inbound; ML via
  operações por inventory_id). Parser hoje calibrado no layout do **ML**; validar
  com PDFs de Amazon/Shopee quando surgirem.

**Feito em 21/jul/2026 — aba Fulfillment nova (`/fulfillment`):**
- Duas sub-abas: **Inventário** (`estoque_fulfillment` por marketplace/CD) e
  **Reposição** (`view_reposicao_full` — estoque no CD, cobertura em dias,
  em trânsito, sugestão de envio, com qtd editável e montagem de envio).
- Miniaturas de produto via `produtos.foto_capa`, buscando só os SKUs visíveis
  (`.in()` em lotes ≤300, cache 30 min) — cobertura ~64%, fallback p/ ícone.
- Item no menu (grupo Principal, módulo `separacao`) + `ROTA_MODULO` em
  `usePerfil`. Estado (sub-aba/filtros) na URL.
- **Follow-up:** o botão "Montar envio" **NÃO persiste** — falta uma tabela de
  envios no banco (e, idealmente, inbound API de cada marketplace). Hoje só monta
  rascunho + copia TSV. Pipeline de backend já está pronto e agendado
  (`fulfillment-sync` cron: Amazon 2h, Shopee 2h, ML 30min).

**Feito em 24/jul/2026 — aba Devoluções (`/devolucoes`, Fase 1):** lê
`notas_cancelados` (lista de trabalho = `finalidade_nf='1' AND id_nota_fiscal
NOT NULL`) e deixa **marcar `precisa_devolucao`** por linha (checkbox, update
otimista). Mostra `devolucao_emitida` como selo. Multi-marketplace (não filtra
por canal); busca/filtro/paginação na URL. **Só leitura + marcação** — nada de
cálculo, emissão de NF ou chamar a `nf-devolucao` (roda por cron). Fases 2/3
(link p/ nota no Tiny, emissão) ficam para depois. Item no menu (módulo
`financeiro`).

**Feito em 24/jul/2026 — separação (`separacao.tsx`):** "marcar como embalado"
travava a UI por vários segundos. Causa: os handlers de embalar/imprimir faziam
`await qc.invalidateQueries(["separacao"])`, e o `await` segurava o estado
"embalando" (que desabilita os botões) enquanto a `view_separacao_priorizada`
(`limit 5000`) recarregava. Agora a invalidação roda em **segundo plano**
(`void`); o botão libera logo após a gravação no Tiny. O botão manual "Atualizar
fila" mantém o `await` (esperar é o esperado ali).

**Pendências conhecidas:**

1. `useAuth` é hook com estado local chamado em 4 lugares (`usePerfil`,
   `AuthGate`, `PerfilGate`, `AppShell`) → **4 subscriptions + 4 getSession
   ativos** (confirmado). Consolidar num `AuthProvider` (Context único). Mudança
   de risco alto (mexe em login) — fazer fora do horário de operação.
2. **Cards por canal do Dashboard ainda usam `view_canais_diario`** (agregada,
   ~101 linhas — não é o problema de "milhares de linhas"). Migrar para
   `view_kpi_pedidos_dia` **depende de uma nova view de ADS agregado por
   canal/empresa/dia** a ser criada no banco, porque `view_kpi_pedidos_dia` não
   tem coluna de ADS e o card mostra ADS / ACOS / "Margem após ADS" por canal.
   Os totais do topo já vêm de `dashboard_visao_geral` (RPC). Ao migrar, somar
   absolutos e recalcular percentuais (ver seção 4).
3. Estado do Dashboard ainda não está na URL (Pedidos Integrados já está — use
   como referência).
4. `view_anomalias` ainda vem com `limit(20000)` no Dashboard (inofensivo, 364
   linhas). O `count`/soma por tipo poderia ir para o servidor — opcional.
5. `separacao.tsx` e `mapeamento-skus.tsx` usam `limit(5000)` como teto de fila
   operacional — **não são agregação, deixe como estão**.
6. **"Puxar custo do Tiny" em Pedidos Integrados (FEITO em 21/jul/2026):**
   botão no drawer de detalhe (quando `cobertura_cmv != completo`) que chama
   `tiny-sync-produtos` (`modulo=detalhar`, `sku`) para re-detalhar cada SKU do
   pedido e repopular `produtos`/`produto_kits`; depois invalida as queries de
   margem. **Edge function `tiny-sync-produtos` foi para v12:** lê params por
   query OU body JSON, e `detalhar?sku=X` re-detalha um SKU ignorando o filtro
   `detalhe_atualizado_em IS NULL`.
   - **Causa raiz que motivou:** kits cuja composição foi cadastrada/alterada no
     Tiny DEPOIS do primeiro `detalhar` nunca eram revisitados (o cron só pega
     `detalhe_atualizado_em IS NULL`). Ex.: kit 14808 destravou **1.631 pedidos**.
   - **Limite:** se o Tiny **não tem** a composição do kit (array `kit` vazio),
     re-detalhar não resolve — tem que cadastrar a composição no Tiny. Havia 15
     kits sem composição; 4 resolvidos pelo re-detalhe, **11 seguem sem composição
     no próprio Tiny** (14077 14078 14081 14082 14083 14085 14088 14612 14613
     14614 14615) — correção é na origem (Tiny), não no app.

**Comparação dos cards do Dashboard (06/out/2026, pedido do dono):** o filtro **"Mês"** compara
com os **mesmos dias do mês anterior** (01–06/out → 01–06/set; corta no fim do mês mais curto) —
leitura mês contra mês, igual ao painel do Tiny/Olist. Antes comparava com os N dias imediatamente
antes (25–30/set) e mostrava +32% quando o mês-contra-mês era −29%. Hoje/Ontem/7/30 dias seguem com
o período imediatamente antes. Regra em `periodoAnterior()` (`src/routes/index.tsx`); cada card mostra
"vs 01–06/set". **09/out/2026 — regra ÚNICA em todas as telas (pedido do dono):** `periodoAnterior(preset, from, to)` em
`src/lib/dashboard/period.ts` (calendário puro em UTC — as funções de mês do date-fns usam o fuso do
navegador e deslocavam o fim do mês). Período que começa no dia 1 dentro de um mês ("Mês atual", "Mês
anterior" ou personalizado assim) compara MÊS A MÊS: parcial = mesmos dias do mês anterior (corta no
mês mais curto), cheio = o mês cheio antes. Hoje/Ontem/7/30/90 dias = período logo antes. Usam: Dashboard
(via mapa de presets), **Vendas por produto** (`vendas_por_sku`/`vendas_por_marca` ganharam
`p_ant_inicio`/`p_ant_fim` opcionais — sem eles = regra antiga, md5 de set/26 idêntico) e **Pedidos
Integrados** (cards "vs 01–09/set"). Tendências fica com janelas móveis 7/30 d × as 7/30 anteriores (de
propósito). Exemplo do erro antigo: 15984 em 01–09/out aparecia 17 → 708 (+4.064%) contra 22–30/set;
mês a mês é 2.605 → 709.

**Menu lateral enxuto (14/out/2026, pedido do dono):** telas parecidas viraram ABAS de um item só
(`NavItem.abas` em `src/components/AppSidebar.tsx`): Separação (Fila · Monitoramento · Histórico),
Pedidos Shopee a enviar (A enviar · Risco de cancelamento), Equipe (Manual de Operação · Registro de
horas), Produtos (Catálogo · Margem · Mapeamento SKUs), ADS (Shopee · Mercado Livre · Saúde ML),
Carteira (Carteira · Saldos MKT) e Configuração da IA (Prompts · Contextos). Cada aba continua sendo
a rota de antes (filtros na URL, links antigos valem); a barra de abas é desenhada UMA vez no shell
(`AbasDaTela` no `__root`), não nas telas. `localizarRota()` acha item/aba pela url mais longa que
casa. Grupos nascem fechados (abre o da tela atual) e **Favoritos** (estrela no item) ficam numa
seção fixa no topo — os dois em `localStorage` (`menu.gruposAbertos`, `menu.favoritos`), por
navegador. Tela nova que for aba de outra: só acrescentar em `abas`.

**Padrões a manter:**
- `QueryClient` no nível de módulo, com `refetchOnWindowFocus: false`,
  `refetchOnMount: false`, `staleTime` 5 min.
- Paginação, filtros e período na URL (`useSearchParams`) — sobrevive a
  remontagem.
- Em `onAuthStateChange`, reagir só quando o `user.id` muda. `TOKEN_REFRESHED` e
  `INITIAL_SESSION` disparam ao voltar para a aba e não são troca de usuário.

---

## 9.1 Site publicado — como saber se um recurso já está no ar

**Migração para Cloudflare própria (29/set/2026, em andamento):** o site também está
em **https://ottz-pet-app.ottzpet.workers.dev** (Worker `ottz-pet-app`, conta
Cloudflare do dono, subdomínio `ottzpet`). Deploy: `npm run build && npx wrangler
deploy --config .output/server/wrangler.json` (o build — nitro preset
`cloudflare-module` — gera o wrangler.json a partir do `wrangler.jsonc` da raiz).
Medido: HTML 0,07–0,14 s vs 0,56–0,90 s no Lovable (que gerava no servidor só o
spinner do login e injetava `/~flock.js` + selo). Removido o código de servidor da
era Lovable (callback Shopee `/api/public/shopee/callback`, `auth.functions`,
`sign.server`, `client.server`, 3 middlewares): nada usava — a autorização Shopee é
a edge fn `shopee-oauth` (Supabase). O site não precisa de segredo nenhum.
**Publicação automática (29/set):** Workers Builds ligado ao GitHub
(`renansevilha-lab/code-to-canvas-41`, branch `main`) — build `npm run build`,
deploy `npx wrangler deploy --config .output/server/wrangler.json`. **Push na main
= site publicado** (não existe mais "dar Publish"). Gerenciador = **npm**
(`bun.lockb`/`bunfig.toml` do Lovable removidos — lock do bun estava parado em
21/jul). Endereço definitivo decidido pelo dono: **ottz-pet-app.ottzpet.workers.dev**.
Pendente: avisar a equipe (login 1× + reescolher impressora) e desligar o Lovable.
**Push não garante publicado (18/out/2026):** o site ficou parado desde 16/10 sem ninguém ver — todos os builds de
18/10 falharam no `npm ci` da Cloudflare (**npm 10.9.2**, Node 24): "package.json e package-lock.json fora de
sincronia — Missing: miniflare@4.20260730.0, workerd… (cópias aninhadas do `nitro`)". O npm 11 deste PC aceita o
lock e o build local passa, por isso nada acusava. Cura: lock refeito com `npx npm@10.9.2 install
--package-lock-only` (só +9 cópias aninhadas, nenhuma versão mudou). **Regra:** mexeu em dependência, conferir com
`npx npm@10.9.2 ci`; depois de cada push, conferir o build em
`https://api.github.com/repos/renansevilha-lab/code-to-canvas-41/commits/<sha>/check-runs` (público). O registro
completo do erro fica no painel da Cloudflare (Workers › ottz-pet-app › Deployments), que pede login do dono.

URL publicada: **https://code-to-canvas-41.lovable.app** (o `id-preview--…lovable.app`
do editor exige login e não serve para checar). Front só muda com **Publish**
no Lovable; backend (banco/edge) vale na hora. Para conferir sem depender do
usuário: baixe o index, siga os `modulepreload`/`/assets/*.js` e os
`import("./…")` dos chunks (as rotas são lazy — ~100 bundles) e procure uma
string única do recurso (rótulo de botão, nome de RPC). Não há service worker
e o index é `no-cache`: reload normal já traz a versão publicada.

Armadilha real (11/set/2026): "não aparece" pode ser **condição de exibição**,
não Publish — o "Reprocessar CMV por período" nasceu dentro do bloco "Puxar
custo do Tiny", que só renderiza em pedido com custo INCOMPLETO; nos pedidos
completos (onde se corrige custo errado) nunca aparecia.

## 9.2 Planos do dono

Backlog com levantamento pronto em **`docs/planos.md`**: (1) integração TikTok
Shop (`docs/integracao-tiktok-shop.md`) — depende do cadastro do app pelo
dono; (2) falta de estoque → balanço 0 no Tiny + conferência na Shopee —
**FEITO em 17/set/2026** (§5.0.2).

## 10. Como trabalhar aqui

- **Diagnostique antes de alterar.** Várias correções erradas saíram de supor a
  causa pelo sintoma. Leia o código e os dados primeiro.
- **Consulta ao banco em leitura é livre e encorajada** — é mais rápido que
  perguntar. Escrita (DDL, deploy de função) passa pelo dono.
- **Cuidado com escrita concorrente.** Lovable, Claude Code e outras sessões
  podem tocar os mesmos arquivos e as mesmas funções. Sincronize antes de
  começar; combine quem mexe em quê.
- **Idioma:** português do Brasil, no código e na conversa.
- **Ao propor decisão, ofereça opções (A/B/C)** com o trade-off de cada uma.
