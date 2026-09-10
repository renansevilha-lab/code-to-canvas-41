# Handoff — estado atual e próximos passos

> Atualizado **10/set/2026 ~16h10 BRT** (HEAD `ac5bd70` + este commit). Este
> doc viaja no `git` — leia ao continuar de outra máquina. **Ao começar:
> `git pull --ff-only`.** Backend (Supabase: migrations, views, edge functions,
> crons) é compartilhado e **já está aplicado** — não precisa reaplicar nada.
>
> **Onde parou (10/set):** a seção "Sessão de 10/set/2026" no fim deste doc é
> o estado atual. Resumo de 1 linha: banco limpo (480 MB) com retenção
> automática; aviso Discord 12h10 de Entrega Rápida no ar (cron 103);
> `/monitoramento` com peso em destaque + filtros — **front no git, falta o
> Publish no Lovable**. Pendências decididas/abertas: ver "Próximos passos".

---

## Como validar antes de publicar (importante)

Erro no front trava a bancada. **Nunca publique sem rodar os dois:**

```bash
node node_modules/typescript/bin/tsc --noEmit && node node_modules/vite/bin/vite.js build
```

Se a máquina não tiver Node no PATH, há um portátil baixado em sessão anterior
(`scratchpad/nodejs/node-v24.19.0-win-x64`) — ou instale normalmente.

**Dois deploys diferentes, não confunda:**
- **Edge function / view / migration** → vale **na hora**, para todo mundo.
- **Front (`src/`)** → o push atualiza o *preview*; a operação roda a versão
  **publicada** (botão **Publish** do Lovable). Já custou horas de diagnóstico
  achar que um fix não funcionava quando só faltava publicar.

---

## Feito nas sessões de 14–25/ago

### Mercado Livre — etiqueta finalmente imprime (saga de 3 dias)
Três causas empilhadas, todas corrigidas:
1. **Front não roteava o ML** — `imprimirPorSku` (o botão roxo "Imprimir
   etiqueta" da fila, o que a bancada usa) **pulava** todo pedido não-Shopee;
   com um SKU 100% ML o clique morria em "Nada para imprimir" sem nem chamar o
   servidor. O fluxo por lote tinha o mesmo buraco.
2. **CORS (a causa raiz do silêncio)** — a `ml-etiqueta` respondia o preflight
   só com `Access-Control-Allow-Origin`, sem `Access-Control-Allow-Headers`. O
   navegador bloqueava a requisição real: log com 11 `OPTIONS` e **zero `GET`**.
   Sintoma: botão não faz nada e **nenhum erro aparece**. Ver **CLAUDE.md §6.2**.
3. **Formato errado** — mandávamos PDF para uma Zebra térmica (driver
   rasterizava, saía torto). Agora `response_type=zpl2` → descompacta → envia
   `raw_base64`, igual à Shopee. **40 KB de PDF → 1,9 KB de ZPL.**

Também: pedido `pending/buffered` (ML segurando o envio) devolvia **409** e o
monitor da tela acusava "Runtime error" por um **estado normal**; virou 200 com
`liberado: false` + aviso discreto. E a conta **SVL do ML não é integrada**
(token é da Ottz, API dá 403) — o botão vem desabilitado com o motivo.

### Processar abertos — agora fura o gap Tiny→app (o propósito do botão)
- `processar-abertos` (v33) **consulta o Tiny ao vivo**, espelha na hora o que
  falta (cabeçalho + itens, com a agregação que soma o mesmo SKU em 2 linhas) e
  só então aplica TAG + aprova. Antes lia só o espelho, que atrasa ~10 min.
- **Bug achado no caminho:** após aprovar, o espelho continuava "aberta" até o
  próximo sync → o cron de 5 min **reprocessava o mesmo pedido** (marcador
  duplicado no Tiny). Corrigido: marca `aprovada` no ato.
- **`view_tags_pedidos` reescrita com `LATERAL`** — a CTE agregava ~63 mil
  pedidos para juntar com meia dúzia de abertos: **2.026ms → 2,6ms**, e acabaram
  os 500 intermitentes (era *statement timeout*). Baseline md5 idêntico.

### Canal "Bumi Pet [Shopee]" (o Tiny renomeou a SVL em 21/ago)
Mesmo shop `759046323`. Tudo que filtra `marca_canal` por grafia exata precisa
aceitar **as duas** grafias (o Tiny pode reverter). Corrigido em
`shopee-sync-ads` v54 (o `imprimir` por TAG descartava os pedidos novos — lote
misto saía incompleto), `tiny-separacao` v31 e nas views. No front, o helper
[`src/lib/canais.ts`](../src/lib/canais.ts) normaliza **só a exibição** para o
nome atual — o dado cru fica intacto.

### Histórico de Separação (`/historico-separacao`) — novo
- Captura em `separacao_log` (append-only, nunca trava a operação): quem aplicou
  a TAG, quem imprimiu, quem embalou, quem finalizou — nos fluxos por SKU, por
  pedido e por lote. Helper [`src/lib/separacaoLog.ts`](../src/lib/separacaoLog.ts).
- Tela com **dois modos**: por TAG (cartões com linha do tempo de 4 marcos) e
  **por pedido** (tabela densa), ambos com timeline expansível. Views
  `view_separacao_historico_tags` / `_pedidos` / `view_separacao_log_enriquecido`.

### Busca por número de pedido na Separação
A mesma caixa de busca reconhece quando o texto parece um nº de pedido (ML,
Shopee, Temu, venda Tiny — aceita parcial), consulta a fila real e **filtra para
a linha onde o pedido está**, mostrando canal e TAG. Sem resultado, explica que
pode já ter sido separado.

### Discord — avisos com menção real
- **`discord-notify` é a porta única** (webhooks em secret, um por canal). v2
  aceita `marcar: [ids]` e `conteudo` → vão no `content`, **fora do embed**
  (menção dentro de embed **não notifica**; e "@Nome" em texto não marca nada —
  só `<@id>` numérico).
- **`discord-avisos`** cobra quem não fechou o checklist, marcando a pessoa.
  Crons: **9h** (`checklist-matinal-discord`) e **17h30** (`checklist-fim-discord`),
  dias úteis. **Silêncio é bom:** sem pendência, não posta.
- IDs em `equipe_membros.discord_user_id` (Nikolas e Vinicius cadastrados;
  Tânia e "Equipe" ainda sem ID → aparecem citados, sem marcação).

### Banco estava estourando o plano (527 MB / teto 500 MB)
Limpeza feita → **393 MB**. `etiquetas_cache` era o vilão (144 MB → 23 MB,
mantidos os últimos 5 dias = janela do `pregerar`; etiqueta fora do cache é
regerada sob demanda). Também `cron.job_run_details` (42 MB → 856 kB) e
`net._http_response`. **Técnica:** DELETE não devolve espaço — copie o que fica,
`TRUNCATE`, reinsira (ver CLAUDE.md §8).

---

## Feito na sessão de 26–27/ago (este PC)

### Relâmpago Shopee — automação diária (`/flash-sale`, NOVA)
Pedido do dono: parar de criar promoção relâmpago na mão todo dia.
- **Tabelas:** `flashsale_programacao` (lista fixa de produtos+preços por loja),
  `flashsale_config` (`automacao_ativa` default **OFF** + `max_itens_bloco`
  default **10**), `flashsale_criadas` (log por loja/dia).
- **`shopee-flashsale` v4** (deploy = versão 9 no Supabase): `programar` é
  **RECONCILIAÇÃO** — compara a programação com o que JÁ existe no slot de
  amanhã na Shopee e adiciona só o que falta; completa blocos existentes e cria
  blocos novos de até `max_itens_bloco`, ativando só os novos. **Armadilhas
  descobertas ao vivo:** (a) `get_time_slot_id` ESCONDE slot que já tem sale —
  o timeslot vem das sales existentes primeiro; (b) **auto-correção** no add:
  erro de estoque (capa pelo disponível ao vivo) e de variação (casa o model
  pelo SKU e conserta a programação); (c) o mesmo produto tem **item_id
  diferente em cada loja** (Dedeira 15819: Ottz 49065516262 × Bumi 46514960728)
  — guard "anúncio não é desta loja". Motivos legíveis em `problemas`
  (toast + Discord + `flashsale_criadas.detalhe`).
- **Tela `/flash-sale`** (menu Mídia & Canais): busca server-side no espelho
  `shopee_anuncios` (nome/SKU/SKU de variação), coluna **MC promo %** por preço
  digitado (RPC `flashsale_mc_base` = comissão+imposto efetivos 60d + CMV
  kit-aware; grant só authenticated), toggle de automação e "produtos por
  bloco" por loja, botão "Programar amanhã agora" (dry → prévia → confirmar),
  histórico. Cron **jobid 87** (21h UTC = 18h BRT), inofensivo com automação OFF.
- **Write E2E validado pelo dono** (criou a relâmpago de 27/08 pela tela).

### Fulfillment — re-upload de PDF atualiza o envio (sem duplicar)
- RPC **`fulfillment_atualizar_envio(envio_id, itens jsonb, editado_por)`**:
  merge no banco — qtd_planejada nova por SKU **preservando `qtd_separada`**;
  item novo entra com 0; item que saiu do plano com separação fica com
  planejado 0 (visível p/ retirar da caixa), sem separação é deletado; match
  por `sku` **e por `sku_origem`** (SKU cru do PDF ↔ linha corrigida pelo
  operador — validado FBA-15102→15102). Avisa no Discord (canal fulfilment,
  marca Nikolas/Vinicius) com o **diff por SKU**; `TESTE-%` silencia. Validado
  com envios de teste, ao item.
- **Front:** botão **"Atualizar por PDF"** dentro do envio (PackingEnvio, ao
  lado de Excluir) — parse → confirmação (avisa se o nº do PDF difere) → RPC;
  e o "Novo envio" com nº repetido também oferece atualizar em vez de duplicar.
- Aviso de CRIAÇÃO continua no trigger `notificar_envio_fulfillment` — padrão:
  **avisos de fulfillment saem do banco**, não do front.

### ⚠️ PENDENTE DE PUBLISH (Lovable)
Todo o front acima está no git mas **não publicado**: `/flash-sale` (tela nova,
menu, MC%), botão "Atualizar por PDF" no envio, detecção de nº repetido no
"Novo envio", toasts com motivos da flash sale. O dono tentou o re-upload e
"não funcionou" **porque a versão publicada é a antiga** — nada quebrou, nada
duplicou (conferido no banco).

---

## Estado do backend (Supabase — já aplicado)

| Edge function | Versão | Nota |
|---|---|---|
| `ml-etiqueta` | v6 | ZPL nativo, CORS completo, 200 com `liberado:false` |
| `tiny-separacao` | v33 | `processar-abertos` ao vivo + marca `aprovada` no espelho |
| `shopee-sync-ads` | v54 | aceita as duas grafias do canal SVL no `imprimir` |
| `discord-notify` | v2 | `marcar`/`conteudo` no content + `allowed_mentions` |
| `discord-avisos` | v2 | cobra checklist (turno `inicio`/`fim`), `dry=1`, `sempre=1` |
| `shopee-flashsale` | v4 | reconciliação diária + auto-correção; módulo debug `modelos` |

> Versões conferidas em 25/ago (número do cabeçalho do arquivo, não o do
> Supabase). Outra sessão pode ter avançado alguma — confira o cabeçalho
> antes de reescrever uma função.

**Views criadas:** `view_separacao_historico_tags`, `view_separacao_historico_pedidos`,
`view_separacao_log_enriquecido`, `view_manual_pendentes_hoje`.
**Reescrita:** `view_tags_pedidos` (LATERAL).
**Tabela:** `separacao_log`. **Coluna:** `equipe_membros.discord_user_id`.

---

## Próximos passos (pendentes) — ordem sugerida

0. **Publish no Lovable** (pré-requisito para a bancada ver): `/monitoramento`
   (peso, prazo, filtros), tudo da Separação de 10/set (faixa "Etiquetas do
   dia", impressão em massa, reimprimir forçado, filtro de prazo), `/flash-sale`,
   "Atualizar por PDF" no Fulfillment. Depois do Publish: conferir na bancada.
1. **Confirmar com o dono o que é "Entrega Direta"** — o aviso das 12h10 foi
   feito sobre `opcao_envio = 'Entrega Rápida'` (único rótulo de coleta que a
   Shopee devolve). Se for outro canal, ajustar o WHERE de
   `view_entrega_rapida_pendentes`. Ver a 1ª mensagem real do cron (12h10 de
   11/set) no canal pedidos e calibrar (ex.: incluir prazo amanhã, dias úteis).
2. **Decisões ainda abertas do dono (10/set):** seletor de impressora só com
   Zebras online (hoje o PrintNode lista 25, só 6 são Zebra — "online" é o PC);
   identificadora ligada por padrão em máquina nova; salvaguardas A
   (auto-recuperação do pregerar) e C (sonda diária) — provavelmente
   redundantes com o watchdog de 20 min.
3. **Cron 98 `svl-clonar-backlog-TEMP`** — sem trabalho desde 02/set; remover
   com `select cron.unschedule(98)` (com OK do dono).
4. **Peso real do produto**: sincronizar `pesoBruto`/`pesoLiquido` do Tiny para
   `produtos` (mexe em `tiny-sync-produtos`) e trocar `extrairPeso` do nome pelo
   campo. Enquanto isso, o front lê do nome (funciona para areia/ração/líquidos).
5. **Deduplicar faixas de prazo** em `separacao.tsx` (ainda tem cópia local de
   `FAIXAS_PRAZO`/`diasAtePrazo`; o Monitoramento já importa de
   `src/lib/prazo.ts`). Fazer quando for mexer na Separação — mudança mecânica.
6. **Conferir a etiqueta ML no papel** (ZPL validado, ninguém viu sair após a
   troca de formato). As 3 de 10/set saíram na Zebra do RENANPC, não da bancada.
7. **Amazon** — `subtotal_produtos = 0` em pedido `Pending` (~146 pedidos,
   R$ 7,6 mil presos). Fix: rebuscar enquanto `subtotal_produtos` for null/0 +
   backfill. Depois, juntar a Amazon ao Pedidos Integrados.
8. **ML — sync de Claims** (motivo de devolução) · **Full Meli** (`logistic_type`)
   · **Devoluções Fase B** (botão "Emitir NF de devolução" no recebido).
9. **AuthProvider único** — `useAuth` em 4 lugares (4 subscriptions). Mexe em
   login: fazer **fora do horário de operação**.

**Ambiente para validar o front (este PC não tem Node no PATH):** há um Node
portátil em `%LOCALAPPDATA%\Temp\claude\C--Users-Renan-code-to-canvas-413113138b-…\scratchpad
odejs
ode-v24.19.0-win-x64
ode.exe` (pasta de sessão;
pode sumir). Em outro PC: instale o Node ou baixe o zip portátil de nodejs.org
e rode `node node_modules/typescript/bin/tsc --noEmit && node
node_modules/vite/bin/vite.js build`. O build reordena `src/routeTree.gen.ts`
sem mudança real — descarte com `git checkout -- src/routeTree.gen.ts`.

## Avisos / gotchas

- **Escrita concorrente** (Lovable + Claude Code + outra sessão): `git pull`
  antes de começar e combine quem mexe em quê.
- **Diagnóstico de "o botão não faz nada":** olhe os logs agrupando por método.
  Só `OPTIONS` e zero `GET` = **CORS**, não é lógica (CLAUDE.md §6.2).
- **"Nada em aberto" pode ser verdade:** o `processar-abertos` agora confere o
  Tiny ao vivo — se `abertos_no_tiny_live = 0`, é zero mesmo; o pendente é o
  próprio Tiny importar da Shopee.
- **Tokens ML expiram rápido** — se um probe der 401, rode `ml-refresh-token`
  e espere ~5s.
- **Não deixar query pesada travar o banco** — se o app parar de carregar dado,
  cheque `pg_stat_activity` / logs do Postgres (procure "statement timeout").
- Tokens Shopee em `oauth_tokens_shopee`; Returns API: janela máx **15 dias**.

---

## Sessão de 10/set/2026 (pós-campanha 9.9) — estado e pendências

**Publicar (Publish no Lovable) é pré-requisito para a bancada ver:** tudo de
`src/routes/separacao.tsx` desta sessão só vale depois do Publish.

### Feito (backend, já valendo)
- `shopee-sync-ads` v57/v58: geração de etiquetas em paralelo + retry do
  download (a Shopee devolvia 0 bytes na 1ª tentativa). Fila de ~600 → ~70.
- `etiquetas-saude` v2: `view_etiquetas_saude` + `view_tokens_saude`; quadro
  no Discord 2×/dia; watchdog 20 min (geração parada / fila represada / token
  vencido). Cron `ml-refresh-token` de 2h → 30 min (falhava em silêncio).
- Resíduo antigo de `ml_nf_estado` limpo.

### Feito (front — aguarda Publish)
- Faixa "Etiquetas do dia" no topo da Separação.
- Chips de canal ISOLAM (clique = só aquele; Ctrl+clique soma).
- "Imprimir tudo (N)" / "Imprimir selecionados" / "Reimprimir selecionados
  (forçar)" na barra de seleção; barra de progresso com Pausar/Retomar e
  "Parar após esta linha"; combinações multi-SKU ficam de fora (tag-lote não
  resolve "MULTI: a+b").
- "Reimprimir (forçar)" visível na coluna de ações da linha (e no menu ⋮),
  com aviso de etiqueta em dobro. Checkbox aceita linha já tagueada.
- Fluxo ML por SKU pula pedido já impresso (regra de ouro), salvo forçar.
- Identificadora: faixa "ETIQUETAS DESTE LOTE ESTÃO ABAIXO" com setas + linha
  PRAZO; sai também em lote de 1 pedido; busca a TAG no banco quando ainda
  não está no cache (race de 30 s).
- Filtro de prazo multi-seleção (faixas exclusivas); "Embalar impressos (N)".

### Pendências / próximos passos
- Conector Supabase do app Claude ficou "invalidated" no fim da sessão —
  abrir conversa nova (a reconexão não vale para sessão já aberta).
- Conferir em qual Zebra saíram as 3 etiquetas dos lotes ML 1009-69/70/71
  (18:01) — `impressao_etiquetas` + logs `printer_id=` da `ml-etiqueta`.
- Decidir: identificadora ligada por padrão em máquina nova; salvaguardas
  A (auto-recuperação do pregerar), B (retenção do cache), C (sonda diária),
  D (alerta de prazo às 15h); seletor de impressora só com Zebras online.

---

## Sessão de 10/set/2026 (tarde) — conferências pós-handoff

Só leitura; nada foi alterado no banco nem nas funções.

### Resolvido: as 3 etiquetas ML dos lotes 1009-69/70/71
- Saíram às **15:01 BRT** (18:01 UTC) na Zebra **`ZDesigner ZD220-203dpi ZPL`
  do computador RENANPC** (PrintNode `printer_id=75043468`), não na da bancada.
  Os lotes Shopee 1009-98/99, disparados 1 min antes e depois, foram para a
  `\jussarapc\ZDesigner ZD220-203dpi ZPL (Copiar 1)` (`75573931`, via
  DESKTOP-SEPARACAO). Mesmo IP e user-agent nos dois → duas máquinas da rede,
  cada uma com seu `localStorage` (`separacao.printerId`). O front tem UM só
  `printerId` para Shopee e ML (conferido em `separacao.tsx`), sem valor fixo.
- PrintNode confirmou as 3 como `done` em 15:02. `impressao_etiquetas` **não
  guarda `printer_id`** — a impressora só aparece na URL dos edge logs
  (`function_edge_logs`, `event_message like '%printer_id=%'`).
- Na mesma rajada, 2 pedidos ML (`2000018131091072`, `2000018175396332`, lote
  1009-48) foram chamados e NÃO viraram job: `ml-etiqueta?modulo=ensaio` (só
  leitura) mostra `status=pending / substatus=buffered` — o ML segura o envio.
  Estado normal, sem etiqueta ainda.

### ⚠️ Banco em 659 MB (teto do plano 500 MB) — voltou a estourar
| Objeto | Tamanho | Observação |
|---|---|---|
| `etiquetas_cache` | 117 MB | 6.181 linhas com >5 dias (79 MB de ZPL) × 1.983 recentes (25 MB). Mais antiga 16/ago |
| `net._http_response` | 90 MB | só **1.033 linhas** (desde 12:40 UTC de hoje) — é espaço morto; o `limpar-logs` (jobid 47) faz DELETE, que não devolve espaço |
| `escrow_componentes` | 113 MB | dado real, não é lixo |
| `cron.job_run_details` | 20 MB | ok (retenção 7 dias) |

**FEITO (com OK do dono, 10/set ~15:50 BRT):** (1) `etiquetas_cache` copiar
5 dias → TRUNCATE → reinserir, num bloco `DO` com checagem de contagem
(8.164 → 1.988 linhas, 117 MB → 28 MB); (2) `TRUNCATE net._http_response`
(90 MB → 32 kB); (3) função `limpar_etiquetas_cache(p_dias)` + cron
**`limpar-etiquetas-cache` jobid 102** (03:30 UTC, retenção 5 dias) —
**salvaguarda B**; (4) `limpar-logs` (jobid 47) agora faz TRUNCATE em
`net._http_response`. **Banco: 659 MB → 480 MB.** Fora dessa dieta, o que
resta grande é dado real (`escrow_componentes` 113 MB, `pedidos` 49 MB).

### Outras conferências
- **Crons 54 e 90 NÃO são duplicados**: 54 (`confirmar_impressoes_pendentes()`,
  2 min) dispara o `confirmar-impressao` por TAG com job `sent` há >20 s;
  90 (10 min) é a varredura global. Complementares.
- **Cron 98 `svl-clonar-backlog-TEMP`**: última clonagem em **02/set**; roda a
  cada 15 min sem trabalho há 8 dias → candidato a remover (`cron.unschedule(98)`).
- Saúde: tokens todos `ok`; etiquetas — Ottz 342/382 com etiqueta, Bumi 282/314,
  fila `aguardando_geracao=0`, sem impressão presa. `etiqueta_pregerar_estado`
  tem 310 `falha` + 23 `package_can_not_print` de hoje (o backoff cuida).
- Impressoras no PrintNode: 25 "online" mas só **6 são Zebra** (RENANPC,
  JUSSARAPC ×2, nikolaspc, renanphilco, GKTECH) — resto é OneNote/XPS/Fax.
  "Online" no PrintNode é o computador, não a impressora.

### Pedidos do dono (10/set, tarde) — FEITO, front aguarda Publish
1. **Aviso 12h10 "Entrega Direta"** — implementado sobre `opcao_envio =
   'Entrega Rápida'` (é o único rótulo de coleta que a Shopee devolve em
   `shipping_carrier`; não existe "Entrega Direta" literal nos dados — **confirmar
   com o dono que é isso mesmo**). `view_entrega_rapida_pendentes` +
   `etiquetas-saude` v3 `?modulo=entrega-rapida` + cron **jobid 103** (`10 15 * *
   *`, todo dia). Posta no canal pedidos só se houver pendente com prazo hoje ou
   vencido; lista pedido, TAG, situação Tiny e se a etiqueta foi impressa, e
   soma os que ainda estão no prazo. Teste ao vivo 15:56: 1 pendente hoje
   (`260910MCRP433H`), 39 no prazo.
2. **Monitoramento — peso em destaque**: `produtos` não tem peso; o front lê do
   NOME (última ocorrência de número+kg/g/ml/l, porque a variação vem no fim:
   "2,5 a 15kg - Pêssego l 5 kg" → **5 kg**). Selo roxo 72px ao lado da foto +
   trecho marcado no nome; "s/ peso" quando não acha (helper em
   `src/lib/prazo.ts`). Follow-up possível: sincronizar `pesoBruto` do Tiny
   para `produtos` e usar o campo real.
3. **Monitoramento — filtros**: chips de modo de envio (ER/SPX/ML, com contagem;
   clique alterna) + dropdown de faixas de prazo (mesmas faixas da Separação,
   agora compartilhadas em `src/lib/prazo.ts`); selo de prazo no card
   (`view_monitoramento_lotes.prazo`). Estado só na tela (painel fica aberto).
   `separacao.tsx` ainda tem as cópias locais das faixas — dá para trocar pelo
   import quando for mexer lá.
