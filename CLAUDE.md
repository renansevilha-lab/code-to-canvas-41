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
| `ml_ads_diario` | ADS do ML por DIA (gasto, cliques, vendas atribuídas). Construída pelo `ml-sync-ads?modulo=diario` (a API só agrega por campanha; 1 request/dia). Cron `ml-ads-diario` 1×/dia re-sincroniza 8 dias (o ML reatribui vendas retroativamente). Histórico: 26/mai/2026+ (API recusa >90 dias). Alimenta ADS do ML em `view_dre_mensal`, `view_dre_ads_marketplace`, `view_canais_diario` e `view_metas_realizado` |
| `produtos.foto_capa` | Imagem do produto por **SKU interno**, lida do **Tiny** (`anexos[0].url` do PRÓPRIO registro — variação = registro filho com foto própria; o pai não empresta foto). Atenção: 3.255 linhas — nunca puxar tudo (corte de 1.000 do PostgREST); buscar só os SKUs visíveis com `.in()` |
| `view_foto_produto` → `mv_foto_produto_v2` | **Tiny PRIMEIRO, marketplace só se o Tiny não tem** (decisão do dono, 16/set/2026). Coluna `origem` (tiny/shopee/ml). A antiga só reconhecia `anexos.tiny.com.br`; os anexos novos do Tiny estão em `s3.amazonaws.com/tiny-anexos-us/` e 915 SKUs caíam na foto da Shopee/ML tendo foto no Tiny. Refresh 3/3 h (cron `mv-foto-produto-refresh`). O fallback Shopee para variação é a imagem do ANÚNCIO (pai) — imagem por model exigiria guardar `image` do `get_model_list` no catálogo; hoje só 25 variações ativas caem nisso. Foto trocada no Tiny chega pelo cron **`tiny-detalhar-refresh`** (hora :17, 40 produtos ativos/rodada, `tiny-sync-produtos?modulo=detalhar&refresh=1`, v25) — antes o detalhe era lido UMA vez por produto e nunca mais. **Foto trocada no Tiny apaga o anexo antigo do S3 (403)**: em 16/set, 46 dos 1.863 links estavam mortos (ex.: kits 16043/16241, "sem imagem" na tela) — varridos com HEAD e re-detalhados (`detalhar&sku=`). Cron passou a `17,47` (~80 produtos/h, ciclo ≈ 28 h) |
| `compras_ordens` + `compra_ordem_itens` | Espelho das ordens de compra do Tiny + conferência física (qtd_recebida, encaixotamento `emb_tipo`/`emb_unidades`, amarração `pallet_lastro`×`pallet_altura`, `pallets`). `kanban_status` (aguardando/conferencia/divergente/concluida) é do APP — sync não toca. Tela `/compras` (módulo galpao) |
| `produto_embalagem` | Cadastro recorrente de embalagem por SKU — pré-preenche a conferência da próxima compra |
| `notas_cancelados` | Pedidos **cancelados** do mês (todos os marketplaces), com ou sem NF. Populada pela edge function `nf-devolucao` (varredura por cron). Lista de trabalho da aba **Devoluções** = `finalidade_nf='1' AND id_nota_fiscal IS NOT NULL` (**situação 3 = NF cancelada, não precisa devolução**; 6/7 = viva). Campos: `precisa_devolucao` (marcação), `devolucao_emitida`+`id_nota_devolucao` (preenchidos pelo módulo `emitir`). GRANT select/update p/ anon+authenticated |
| `view_margem_pedido_v2.modo_envio` | **10/set:** coluna nova (baseline md5 idêntico). Shopee = `opcao_envio` cru (Entrega Rápida, Shopee Xpress, Full, Retirada pelo Comprador, Turbo); ML = rótulo de `logistica_tipo` (fulfillment→**Full**, self_service→**Flex**, xd_drop_off/drop_off→**Agência**, cross_docking→**Coleta**); Amazon = Standard/Expedited (velocidade, não modo). Filtro "Envio" e coluna em Pedidos Integrados |
| `reprocessar_cmv_periodo(sku, de, ate, custo?, por?, obs?)` | **10/set:** reprocesso de CMV por período honrando `cmv_manual` (vigência). Se `custo` vier, grava em `cmv_manual` desde `de`; recongela `pedido_item_cmv` do SKU (e kits que o contêm) entre as datas com `cmv_na_data(sku, data_pedido)` = manual vigente > cadastro (kit-aware). **Por que existe:** o congelado vence o manual e o cron `cmv-congelar-novos` (15 min) congela tudo — então `cmv_manual` sozinho NUNCA mudava pedido já lançado (a tabela estava vazia, ninguém usava). `fn_cmv_congelar_novos` também passou a usar `cmv_na_data`. DRE/PI mudam na hora (leem a view); `view_kpi_pedidos_dia` (matview) em ≤20 min. A antiga `reprocessar_cmv` (tela `/reprocessar-cmv`) segue ignorando o manual |
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
- **Rastreio dos Correios (`AP420460126BR`) não vai ao ML** — o front só
  chama a função se o texto não casa `[A-Z]{2}\d{9}[A-Z]{2}`.

## 5.3 DRE — categorização de despesas e camada de override

**Fonte das despesas:** `contas_pagar` é **espelho do Tiny**, re-sincronizado
pelo cron `tiny-sync-contas-pagar` **a cada 15 min** (upsert por `tiny_id`).
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

## 6. Edge Functions

| Função | Versão | Papel |
|---|---|---|
| `shopee-sync-ads` | v65 | Etiquetas (pregerar/imprimir), catálogo, ADS — ver seção 5.1 |
| `shopee-ship` | v2 | Confirmar envio na Shopee (`ship_order`) — ver seção 5.1 |
| `shopee-flashsale` | v3 | Relâmpago da Loja: leitura (slots/criteria/list/sale/catalogo) + escrita gated `confirmar=1` (criar/add-items/ativar/remover-itens/excluir) + **`programar` = RECONCILIAÇÃO**: compara `flashsale_programacao` com o que JÁ existe no slot de amanhã na Shopee e adiciona só o que falta — completa blocos existentes e cria blocos novos de até `flashsale_config.max_itens_bloco` produtos (default 10, limite do Seller Center), ativando só os novos. **ARMADILHA:** `get_time_slot_id` ESCONDE slot que já tem sale — o timeslot do dia vem das sales existentes primeiro. Cron jobid 87 (21h UTC; `&auto=1` respeita `automacao_ativa`, default OFF). Guarda de preço: pula promo ≥ original ou < 50%. Tela `/flash-sale` (busca no espelho `shopee_anuncios`; MC% via RPC `flashsale_mc_base` = comissão/imposto efetivos 60d + CMV kit-aware; grant só authenticated) |
| `tiny-separacao` | v33 | Sync da fila, tags de lote, embalar. `processar-abertos` confere o Tiny **ao vivo** e espelha na hora o que falta (fecha o gap de ~10 min do espelho); apos aprovar, marca `aprovada` no espelho (evita reprocesso/marcador duplicado) |
| `separacao-falta` | v6 (deploy 9) | Reportar falta de estoque: marcador "FALTA ESTOQUE" no Tiny + aviso no Discord (canal `estoque` = #estoque-pedido-sem-estoque) + **balanço 0 no depósito Geral do Tiny** (`zerar=1`, kit exige `sku_zerar`) + agenda a conferência da Shopee. `?separacao_id=` um pedido; `?tag=` lote; `?grupo=` linha da fila; `&preview=1` lê o saldo ao vivo sem aplicar nada; `?desfazer=1&sku=` "estoque voltou". Grava `separacao_tiny.falta_estoque_em/_por`. Ver §5.0.2. Separada da tiny-separacao de propósito |
| `produtos-peso` | v2 | Peso real do produto (`dimensoes.pesoBruto` do Tiny) → `produtos.peso_bruto`. Base da divisão de separação por peso — ver §5.0.3. `?modulo=preencher` (cron jobid 113, `9,39`), `refresh`, `sku=X`, `&dry=1` |
| `estoque-conferir` | v1 | Fecha o ciclo da falta: lê o estoque **ao vivo** dos anúncios Shopee do SKU (`get_model_list` / `get_item_base_info`, duas lojas) e avisa no canal `estoque` se, depois do balanço 0 no Tiny, a Shopee ainda mostra estoque. `?modulo=conferir` (cron jobid 109, `4-59/5`), `&sku=X` força, `?modulo=estoque&sku=X` só leitura. Ver §5.0.2 |
| `shopee-sync` | v20 | Pedidos Shopee |
| `tiny-sync` | v44 | Pedidos Tiny |
| `tiny-sync-produtos` | v12 | Produtos/kits/estoque Tiny — ver seção 4 e 9 |
| `amazon-sync-pedidos` | v12 | Pedidos Amazon (Orders API + OrderItems) — ver seção 9 |
| `amazon-sync-financas` | v11 | Finanças Amazon (taxas reais + módulo `estimar`) — ver seção 9 |
| `ml-sync` | v21 | Pedidos ML (Orders API direto, `fonte='api'`) — ver seção 9 |
| `ml-sync-ads` | v3 | ADS ML: janela por campanha (`ml_ads_campanha`) + `modulo=diario` (série `ml_ads_diario`) |
| `ml-etiqueta` | v14 | Etiqueta ML (ZPL via PrintNode) + **upload de NF-e ao ML** quando o Tiny falha (`enviar-nf` manual; `varrer-nf` = cron jobid 96 a cada 10 min, backoff em `ml_nf_estado`). Endpoint certo: `POST /shipments/{sid}/invoice_data?siteId=MLB` com o **nfeProc puro** (o obter.xml da v2 do Tiny devolve envelope `<retorno><xml_nfe>` — mandar o envelope dá "Malformed XML"). Bloqueio v2 cod 6 aborta a rodada — ver seção 6.2 |
| `fulfillment-sync` | v2 | Estoque nos CDs |
| `compras-sync` | v1 | Espelha ordens de compra do Tiny (`GET /ordem-compra` — atenção: singular) p/ o módulo Compras & Recebimento; cron 30 min; sync NÃO toca campos de conferência do app |
| `fulfillment-inbound` | v5 | Lê o PDF de preparação do inbound (SKU/qtd/título, posicional via unpdf) — ver seção 9 |
| `nf-devolucao` | v2 | Devoluções: `varrer-cancelados` (cron), `pendentes` e `emitir` — ver seção 5.2 |
| `etiquetas-saude` | v5 | **Quadro do dia e alerta de risco de cancelamento vão para o canal `atualizacoes`** (#atualizações-projeto, pedido do dono 16/set); token e pipeline degradado seguem em `erros`. Texto do risco = UMA linha por loja (tudo que já venceu ou cancela hoje somado). `resumo` / `discord` (quadro 2×/dia) / `verificar` (watchdog 20 min) / **`entrega-rapida`** (cron jobid 103, 12h10 BRT): lista pedidos Shopee **Entrega Rápida** ainda não entregues ao motorista com prazo hoje/vencido, via `view_entrega_rapida_pendentes` (status Shopee pré-envio E situação Tiny não enviada, janela 10 dias — o espelho da Shopee tem 1.204 fantasmas em PROCESSED de mai–jul). Silêncio se não há pendente; `&sempre=1` força |
| `discord-notify` | v2 | **Porta única** de saída para o Discord (webhooks em secret, um por canal) — ver seção 6.1 |
| `discord-avisos` | v2 | Cobra checklist não fechado, marcando a pessoa — ver seção 6.1 |
| `resumo-operacao` | v3 | Resumos de abertura/fechamento/fulfillment no Discord |

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

**Padrões a manter:**
- `QueryClient` no nível de módulo, com `refetchOnWindowFocus: false`,
  `refetchOnMount: false`, `staleTime` 5 min.
- Paginação, filtros e período na URL (`useSearchParams`) — sobrevive a
  remontagem.
- Em `onAuthStateChange`, reagir só quando o `user.id` muda. `TOKEN_REFRESHED` e
  `INITIAL_SESSION` disparam ao voltar para a aba e não são troca de usuário.

---

## 9.1 Site publicado — como saber se um recurso já está no ar

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
