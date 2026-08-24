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
| `notas_cancelados` | Pedidos **cancelados** do mês (todos os marketplaces), com ou sem NF. Populada pela edge function `nf-devolucao` (varredura por cron). Lista de trabalho da aba **Devoluções** = `finalidade_nf='1' AND id_nota_fiscal IS NOT NULL` (**situação 3 = NF cancelada, não precisa devolução**; 6/7 = viva). Campos: `precisa_devolucao` (marcação), `devolucao_emitida`+`id_nota_devolucao` (preenchidos pelo módulo `emitir`). GRANT select/update p/ anon+authenticated |
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
| `shopee-sync-ads` | v54 | Etiquetas (pregerar/imprimir), catálogo, ADS — ver seção 5.1 |
| `shopee-ship` | v2 | Confirmar envio na Shopee (`ship_order`) — ver seção 5.1 |
| `tiny-separacao` | v24 | Sync da fila, tags de lote, embalar |
| `separacao-falta` | v4 | Reportar falta de estoque: marcador "FALTA ESTOQUE" no Tiny + aviso no Discord (canal estoque). `?separacao_id=` um pedido; `?tag=` lote; `?grupo=` linha da fila. Grava `separacao_tiny.falta_estoque_em/_por` (espelho p/ badge+filtro da tela). Separada da tiny-separacao de propósito |
| `shopee-sync` | v20 | Pedidos Shopee |
| `tiny-sync` | v44 | Pedidos Tiny |
| `tiny-sync-produtos` | v12 | Produtos/kits/estoque Tiny — ver seção 4 e 9 |
| `amazon-sync-pedidos` | v12 | Pedidos Amazon (Orders API + OrderItems) — ver seção 9 |
| `amazon-sync-financas` | v11 | Finanças Amazon (taxas reais + módulo `estimar`) — ver seção 9 |
| `ml-sync` | v21 | Pedidos ML (Orders API direto, `fonte='api'`) — ver seção 9 |
| `ml-etiqueta` | v4 | Etiqueta de envio do ML (PDF via PrintNode), pedido a pedido — ver seção 6.2 |
| `fulfillment-sync` | v2 | Estoque nos CDs |
| `fulfillment-inbound` | v5 | Lê o PDF de preparação do inbound (SKU/qtd/título, posicional via unpdf) — ver seção 9 |
| `nf-devolucao` | v2 | Devoluções: `varrer-cancelados` (cron), `pendentes` e `emitir` — ver seção 5.2 |
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
`_ESTOQUE`, `_DEVOLUCOES`, `_COMPRAS`. Diagnóstico: `?modulo=status` mostra
quais estão configurados; `?modulo=teste&canal=X` manda uma mensagem de prova.

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
- **`etiquetas_cache` cresce sem teto e já sozinha passou de 144 MB** (o ZPL é
  pesado). Em 21/ago o banco bateu **527 MB** (teto 500 MB) e o Supabase passou
  a limitar a performance. Limpeza feita mantendo só os **últimos 5 dias** (a
  janela do `pregerar`): 144 MB → 23 MB. Etiqueta fora do cache **não se perde**
  — o `imprimir` regenera sob demanda. Sem cron de retenção ainda: **conferir
  o tamanho de tempos em tempos**.
- **DELETE não devolve espaço; TRUNCATE devolve.** Para encolher tabela grande
  sem `VACUUM FULL`: copie o que fica para uma tabela auxiliar, `TRUNCATE` a
  original, reinsira e derrube a auxiliar — tudo numa transação (atômico, e
  preserva grants/PK, diferente de dropar e recriar). Foi assim com
  `etiquetas_cache` e `cron.job_run_details` (42 MB → 856 kB).
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
