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
| `view_reposicao_full` | Motor de reposição por SKU interno: estoque_full, em_transito, cobertura_atual_dias, cobertura_alvo_dias, necessidade, **sugestao_envio**, estoque_empresa. Fonte da aba **Fulfillment › Reposição** |
| `view_reposicao_skus_alvo` | Lista de SKUs-alvo da reposição |
| `produtos.foto_capa` | Imagem do produto por **SKU interno**. Usada p/ miniaturas (Fulfillment, etc.). Atenção: 1.668 linhas — nunca puxar tudo (corte de 1.000 do PostgREST); buscar só os SKUs visíveis com `.in()` |
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

## 6. Edge Functions

| Função | Versão | Papel |
|---|---|---|
| `shopee-sync-ads` | v42 | Etiquetas (pregerar/imprimir), catálogo, ADS — ver seção 5.1 |
| `shopee-ship` | v2 | Confirmar envio na Shopee (`ship_order`) — ver seção 5.1 |
| `tiny-separacao` | v24 | Sync da fila, tags de lote, embalar |
| `shopee-sync` | v20 | Pedidos Shopee |
| `tiny-sync` | v44 | Pedidos Tiny |
| `tiny-sync-produtos` | v12 | Produtos/kits/estoque Tiny — ver seção 4 e 9 |
| `amazon-sync-pedidos` | v8 | Pedidos Amazon |
| `fulfillment-sync` | v2 | Estoque nos CDs |

**Limite rígido: ~30 segundos por execução.** Toda função que processa lote
precisa de orçamento de tempo e parar com folga para gravar o que já fez. Isso
já causou falha silenciosa: a pré-geração de etiquetas batia 30s em *toda*
execução, retornava 200 e não gravava nada — a fila nunca andava.

**Lojas Shopee:** Ottz `shop_id 522186766` (partner 2034179) · SVL
`shop_id 759046323` (partner 2037384). Chaves em secrets separados.

**`marca_canal`** (grafia exata, usada em filtros): `"Shopee (Ottz Pet)"` e
`"Sevilla Store [SHOPEE]"`.

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

### Agregação + filtro do PostgREST = materialize
`view_kpi_pedidos_dia` como view comum calculava tudo em 59ms, mas ao receber
filtro de data o plano degradava e estourava o timeout (erro 500). Virou
MATERIALIZED VIEW com índice único + cron de refresh: **1ms**.

### Ao mexer em view de cálculo, capture baseline antes
Rode os totais de um período conhecido **antes** da alteração e compare depois,
ao centavo. Foi assim que a reescrita da margem foi validada com segurança.

---

## 8. Armadilhas de ambiente

- **`net._http_response` e `cron.job_run_details` incham o banco.** Já estouraram
  o limite do plano (0,5 GB) sozinhas. Existe cron de limpeza; não desative.
- **A resposta do `net.http_post` nem sempre persiste.** Para validar se uma
  função rodou, confira o **efeito na tabela**, não a resposta HTTP.
- **`VACUUM FULL` não roda no editor do Supabase** ("cannot run inside a
  transaction block"). `TRUNCATE` libera espaço na hora.

---

## 9. Estado do front (julho/2026)

**Resolvido:** a remontagem da árvore ao voltar para a aba do navegador (perdia
página da tabela, filtros e rolagem).

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
