# Handoff — estado atual e próximos passos

> Atualizado **25/ago/2026** (HEAD `86725d2`). Este doc viaja no `git` — leia ao
> continuar de outra máquina. **Ao começar: `git pull --ff-only`.** Backend
> (Supabase: migrations, edge functions, crons) é compartilhado e **já está
> aplicado** — não precisa reaplicar nada.

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

## Estado do backend (Supabase — já aplicado)

| Edge function | Versão | Nota |
|---|---|---|
| `ml-etiqueta` | v6 | ZPL nativo, CORS completo, 200 com `liberado:false` |
| `tiny-separacao` | v33 | `processar-abertos` ao vivo + marca `aprovada` no espelho |
| `shopee-sync-ads` | v54 | aceita as duas grafias do canal SVL no `imprimir` |
| `discord-notify` | v2 | `marcar`/`conteudo` no content + `allowed_mentions` |
| `discord-avisos` | v2 | cobra checklist (turno `inicio`/`fim`), `dry=1`, `sempre=1` |

> Versões conferidas em 25/ago (número do cabeçalho do arquivo, não o do
> Supabase). Outra sessão pode ter avançado alguma — confira o cabeçalho
> antes de reescrever uma função.

**Views criadas:** `view_separacao_historico_tags`, `view_separacao_historico_pedidos`,
`view_separacao_log_enriquecido`, `view_manual_pendentes_hoje`.
**Reescrita:** `view_tags_pedidos` (LATERAL).
**Tabela:** `separacao_log`. **Coluna:** `equipe_membros.discord_user_id`.

---

## Próximos passos (pendentes)

1. **Conferir a etiqueta ML no papel.** O ZPL foi validado tecnicamente (2 blocos
   `^XA`, mesmo padrão da Shopee), mas **ninguém viu sair impressa** depois da
   troca. Se vier com 2 partes e a segunda for supérflua, dá para imprimir só a
   primeira.
2. **Retenção do `etiquetas_cache`** — não existe cron de limpeza; volta a
   crescer (~30 MB/mês). Vale criar um cron mantendo 5 dias.
3. **Amazon** — `subtotal_produtos = 0` em pedido `Pending` (a Amazon não devolve
   `ItemPrice` nesse status) e a trava incremental nunca rebusca: ~146 pedidos,
   R$ 7,6 mil presos. Fix: rebuscar enquanto `subtotal_produtos` for null/0 +
   backfill. Depois, juntar a Amazon ao Pedidos Integrados.
4. **ML — sync de Claims** (`GET /post-purchase/v1/claims/{id}` → `reason_id`)
   para o motivo de DEVOLUÇÃO do ML (mesmo padrão do Shopee Returns).
5. **Full Meli:** puxar `logistic_type` para distinguir Full do normal.
6. **Devoluções Fase B:** botão "Emitir NF de devolução" no registro recebido.
7. **AuthProvider único** — `useAuth` é hook com estado local em 4 lugares (4
   subscriptions). Mexe em login: fazer **fora do horário de operação**.

---

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
