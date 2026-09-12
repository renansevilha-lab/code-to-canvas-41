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
| `dashboard_visao_geral(data_inicial, data_final)` | 1 linha: vendas, custo_total, margem_contrib, margem_pct, pedidos, produtos, ticket_medio, projecao_vendas, cobertura_pct. **Sem quebra por canal** |
| `view_kpi_pedidos_dia` | **MATERIALIZADA** (refresh a cada 10 min). Agregada por dia/canal/empresa/marketplace: pedidos, venda, venda_bruta, comissao_total, frete_vendedor, custo_prod, imposto, custo_total, recebido_estimado, margem, margem_pct, itens, itens_sem_cmv, cobertura_cmv_pct. **Não tem coluna de ADS** — cobre só Shopee e Mercado Livre. Para ADS por canal, fonte separada |
| `view_margem_pedido_v2` | Uma linha por pedido, com margem completa. Use `select` só das colunas exibidas + paginação |
| `view_ads_anuncios` | Uma linha por anúncio (30 dias): investimento, vendas, roas, acos, ctr, cpc, `classificacao_roas`, `teve_gasto`, foto, sku_pai |
| `view_ads_resumo` | Contadores por classificação de ROAS |
| `view_separacao_pedidos` | Fila de separação — **só situação 1** (ver armadilha na seção 5) |
| `view_tendencia_categoria / marca / produto` | Atual vs anterior por chave, com coluna `empresa` |
| `view_amazon_dashboard` | Linha a linha de pedido Amazon (sem agregado pronto) |
| `estoque_fulfillment` | Estoque nos CDs (Amazon FBA, ML Full, Shopee SBS) por marketplace/CD/sku_marketplace: sellable, reserved, in_transit, unsellable. Populada por `fulfillment-sync` (cron). Base do motor de reposição. Fonte da aba **Fulfillment › Inventário** |
| `view_reposicao_full` | Motor de reposição por SKU interno: estoque_full, em_transito, **em_envio_aberto** (unidades planejadas nos envios ABERTOS de `fulfillment_envios` — status != enviado, não arquivados — descontadas da necessidade/sugestão/cobertura; envio marcado enviado sai e vira in_transit no sync), cobertura_atual_dias, cobertura_alvo_dias, necessidade, **sugestao_envio**, estoque_empresa. Fonte da aba **Fulfillment › Reposição** |
| `view_reposicao_skus_alvo` | Lista de SKUs-alvo da reposição |
| `ml_ads_diario` | ADS do ML por DIA (gasto, cliques, vendas atribuídas). Construída pelo `ml-sync-ads?modulo=diario` (a API só agrega por campanha; 1 request/dia). Cron `ml-ads-diario` 1×/dia re-sincroniza 8 dias (o ML reatribui vendas retroativamente). Histórico: 26/mai/2026+ (API recusa >90 dias). Alimenta ADS do ML em `view_dre_mensal`, `view_dre_ads_marketplace`, `view_canais_diario` e `view_metas_realizado` |
| `produtos.foto_capa` | Imagem do produto por **SKU interno**. Usada p/ miniaturas (Fulfillment, etc.). Atenção: 1.668 linhas — nunca puxar tudo (corte de 1.000 do PostgREST); buscar só os SKUs visíveis com `.in()` |
| `compras_ordens` + `compra_ordem_itens` | Espelho das ordens de compra do Tiny + conferência física (qtd_recebida, encaixotamento `emb_tipo`/`emb_unidades`, amarração `pallet_lastro`×`pallet_altura`, `pallets`). `kanban_status` (aguardando/conferencia/divergente/concluida) é do APP — sync não toca. Tela `/compras` (módulo galpao) |
| `produto_embalagem` | Cadastro recorrente de embalagem por SKU — pré-preenche a conferência da próxima compra |
| `notas_cancelados` | Pedidos **cancelados** do mês (todos os marketplaces), com ou sem NF. Populada pela edge function `nf-devolucao` (varredura por cron). Lista de trabalho da aba **Devoluções** = `finalidade_nf='1' AND id_nota_fiscal IS NOT NULL` (**situação 3 = NF cancelada, não precisa devolução**; 6/7 = viva). Campos: `precisa_devolucao` (marcação), `devolucao_emitida`+`id_nota_devolucao` (preenchidos pelo módulo `emitir`). GRANT select/update p/ anon+authenticated |
| `view_margem_pedido_v2.modo_envio` | **10/set:** coluna nova (baseline md5 idêntico). Shopee = `opcao_envio` cru (Entrega Rápida, Shopee Xpress, Full, Retirada pelo Comprador, Turbo); ML = rótulo de `logistica_tipo` (fulfillment→**Full**, self_service→**Flex**, xd_drop_off/drop_off→**Agência**, cross_docking→**Coleta**); Amazon = Standard/Expedited (velocidade, não modo). Filtro "Envio" e coluna em Pedidos Integrados |
| `reprocessar_cmv_periodo(sku, de, ate, custo?, por?, obs?)` | **10/set:** reprocesso de CMV por período honrando `cmv_manual` (vigência). Se `custo` vier, grava em `cmv_manual` desde `de`; recongela `pedido_item_cmv` do SKU (e kits que o contêm) entre as datas com `cmv_na_data(sku, data_pedido)` = manual vigente > cadastro (kit-aware). **Por que existe:** o congelado vence o manual e o cron `cmv-congelar-novos` (15 min) congela tudo — então `cmv_manual` sozinho NUNCA mudava pedido já lançado (a tabela estava vazia, ninguém usava). `fn_cmv_congelar_novos` também passou a usar `cmv_na_data`. DRE/PI mudam na hora (leem a view); `view_kpi_pedidos_dia` (matview) em ≤20 min. A antiga `reprocessar_cmv` (tela `/reprocessar-cmv`) segue ignorando o manual |
| `view_entrega_rapida_pendentes` | Pedidos Shopee "Entrega Rápida" ainda não coletados (1 linha/pedido: loja, status Shopee, situação Tiny, `dias_ate_prazo`, TAG, etiqueta impressa/no cache). Fonte do aviso das 12h10 |
| `view_monitoramento_lotes` | Cards do `/monitoramento` (hoje, Shopee, single-SKU). **10/set:** ganhou `prazo` (min `ship_by_date` da TAG) e `pedidos_com_prazo`. O peso do produto NÃO existe no cadastro — o front extrai do nome (`src/lib/prazo.ts` → `extrairPeso`, última ocorrência de número+kg/g/ml/l) |
| `get_kpis_fluxo_caixa()`, `get_projecao_fluxo_caixa(dias)`, `get_pedidos_resumo(inicio, fim)`, `get_dashboard_kpis()` | Agregações financeiras prontas |
| `classificar_roas(numeric)` | excelente / bom / ok / ruim / sem_dado. **Fonte única da regra** |
| `config_roas_faixas` | Limites editáveis (id=1): roas_excelente 18, roas_bom 15, roas_ok 12, acos_alvo 20 |

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
"Mostrar tratados" revê e "Voltar à lista" desfaz.
**Tela `/a-enviar` (12/set):** MESMA tela (`src/components/separacao/
PedidosShopeeLista.tsx`, prop `modo="risco" | "a-enviar"`; as duas rotas são
finas) lendo `view_pedidos_a_enviar` = TUDO que consta "A enviar" no Seller
Center (READY_TO_SHIP/PROCESSED, sem Full, `ship_by` nos últimos 15 dias),
atrasado ou não, com `dias_para_prazo`/`atrasado`/`opcao_envio` a mais.
Chips de prazo: Todos · Vence hoje · Atrasados · Prestes a cancelar (≤ amanhã)
· Cancela hoje; cards A enviar / Atrasados somam-se aos de cancelamento.
"Tirar da lista" usa a MESMA `risco_cancelamento_tratados` — some das duas
telas. Não duplicar a tela: mudança de layout/ação vai no componente.
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

## 6. Edge Functions

| Função | Versão | Papel |
|---|---|---|
| `shopee-sync-ads` | v58 | Etiquetas (pregerar/imprimir), catálogo, ADS — ver seção 5.1 |
| `shopee-ship` | v2 | Confirmar envio na Shopee (`ship_order`) — ver seção 5.1 |
| `shopee-flashsale` | v3 | Relâmpago da Loja: leitura (slots/criteria/list/sale/catalogo) + escrita gated `confirmar=1` (criar/add-items/ativar/remover-itens/excluir) + **`programar` = RECONCILIAÇÃO**: compara `flashsale_programacao` com o que JÁ existe no slot de amanhã na Shopee e adiciona só o que falta — completa blocos existentes e cria blocos novos de até `flashsale_config.max_itens_bloco` produtos (default 10, limite do Seller Center), ativando só os novos. **ARMADILHA:** `get_time_slot_id` ESCONDE slot que já tem sale — o timeslot do dia vem das sales existentes primeiro. Cron jobid 87 (21h UTC; `&auto=1` respeita `automacao_ativa`, default OFF). Guarda de preço: pula promo ≥ original ou < 50%. Tela `/flash-sale` (busca no espelho `shopee_anuncios`; MC% via RPC `flashsale_mc_base` = comissão/imposto efetivos 60d + CMV kit-aware; grant só authenticated) |
| `tiny-separacao` | v33 | Sync da fila, tags de lote, embalar. `processar-abertos` confere o Tiny **ao vivo** e espelha na hora o que falta (fecha o gap de ~10 min do espelho); apos aprovar, marca `aprovada` no espelho (evita reprocesso/marcador duplicado) |
| `separacao-falta` | v4 | Reportar falta de estoque: marcador "FALTA ESTOQUE" no Tiny + aviso no Discord (canal estoque). `?separacao_id=` um pedido; `?tag=` lote; `?grupo=` linha da fila. Grava `separacao_tiny.falta_estoque_em/_por` (espelho p/ badge+filtro da tela). Separada da tiny-separacao de propósito |
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
| `etiquetas-saude` | v3 | `resumo` / `discord` (quadro 2×/dia) / `verificar` (watchdog 20 min) / **`entrega-rapida`** (cron jobid 103, 12h10 BRT): lista pedidos Shopee **Entrega Rápida** ainda não entregues ao motorista com prazo hoje/vencido, via `view_entrega_rapida_pendentes` (status Shopee pré-envio E situação Tiny não enviada, janela 10 dias — o espelho da Shopee tem 1.204 fantasmas em PROCESSED de mai–jul). Silêncio se não há pendente; `&sempre=1` força |
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
