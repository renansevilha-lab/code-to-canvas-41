# Manual de Operação — rota `/processos`

> Estado: **v2 no ar (18/ago/2026)**. Substituiu o modelo de 14/ago
> (`manual_equipe` / `manual_tarefas`), que tinha **zero linhas de progresso** —
> a tela nunca chegou a ser usada, então não houve perda de histórico.
> Front: `src/routes/processos.tsx` + `src/components/manual/ManualAdmin.tsx`.
> Regras puras (datas, completude, relatório): `src/lib/manual.ts`.
> Menu + `ROTA_MODULO` no módulo `galpao`.

## O que a tela faz

Uma rota, três abas:

1. **Checklist do Dia** — rotina marcável (matinal + encerramento).
2. **Responsabilidades** — documentação de quem cuida do quê, sem marcação.
3. **Solução de problemas** — catálogo de erros (`erros_catalogo`).

Mais o **modo edição** (só perfil com módulo `todos`), com CRUD de itens, seções,
equipe e erros.

## Modelo de dados

| Tabela | Papel |
|---|---|
| `equipe_membros` | `(id slug, nome, cor, email, ativo, ordem)`. O `email` liga o login ao membro. |
| `manual_secoes` | PK é o **`code`** (`ROT-AM`, `RESP-01`). `tipo` = `rotina` (vira checklist) ou `processo` (vira documentação). `callouts` jsonb `[{tipo:'warn'\|'info',texto}]`, `tabela_ref` jsonb `{head,rows}`. |
| `manual_itens` | `tipo` = `check` ou `pergunta`; `turno` = `inicio`/`fim` (null em processo); `dias int[]` (null = todo dia, `[1,3]` = seg e qua, 0=dom); `abre_quando` + `campo_label` para as perguntas; `responsavel_id` null = **herda da seção**. |
| `manual_progresso` | `unique (dia, item_id)` — o progresso é **do time**, não por pessoa; `por` registra quem marcou. |
| `erros_catalogo` | `sintomas`/`solucao` são jsonb array de string; o resto é texto. |

RLS habilitada com policy `for all to authenticated using(true) with check(true)`
em todas. `anon` fica de fora de propósito (lockdown de 15/ago).

## A regra de completude (é a alma do sistema)

Vive em `src/lib/manual.ts`, com 31 testes cobrindo os casos:

- **check** — completo quando existe progresso com `concluido = true`.
- **pergunta** — completo quando tem resposta **E**, se essa resposta é
  justamente a que abre o campo (`resposta === abre_quando`, e `abre_quando`
  não é `nunca`), o `detalhe` está preenchido (trim não vazio).

Ou seja: **pergunta respondida "não" sem motivo NÃO fecha o dia** — fica
pendente, destacada em âmbar. É isso que impede o encerramento de virar um
clique automático.

## Armadilhas que o código já trata

- **Datas sempre em `America/Sao_Paulo`** (`hojeSP`, `diaSemanaSP`, `horaSP`).
  O banco roda em UTC: usar `CURRENT_DATE`/`getDay()` faria o dia virar às 21h e
  jogaria a rotina para o dia seguinte.
- **Sem `supabase.rpc()`** — só `select` em tabelas (restrição do projeto).
- **Realtime** em `manual_progresso`: duas pessoas em máquinas diferentes veem a
  marcação uma da outra.
- **Desativar em vez de apagar** no admin (`ativo = false`): apagar um item
  levaria o progresso junto por cascata.
- **E-mail vazio vira `null`** ao salvar membro — a coluna é UNIQUE e `''`
  repetido quebraria o segundo cadastro.

## Como cada pessoa é identificada

1. `auth.email()` casa com `equipe_membros.email` → automático.
2. Sem match: a tela mostra o seletor de membro e guarda a escolha no
   `localStorage` (`manual.euId`).

Para ligar automático, um admin preenche o e-mail de cada um no modo edição →
aba **Equipe**.

## Relatório do dia

Botão no topo do checklist: gera **texto puro** (sem markdown — asterisco e `#`
viram lixo visível no WhatsApp/Discord), agrupado por pessoa e turno, com
`[x]`/`[ ]`/`[!]`, respostas em SIM/NÃO, os detalhes preenchidos,
`SEM RESPOSTA` e `*** NAO PREENCHIDO ***` onde falta, resumo e lista de
pendências. Vai para o clipboard.

## Conteúdo migrado

O seed traz `ROT-AM`, `ROT-PM` e `RESP-01..05` conforme especificado, mais dois
itens preservados do modelo anterior para não perder cadastro:

- membro **`equipe`** ("Equipe", genérico);
- seção **`RESP-06` "Envios Fulfillment"** (era `ENV-01`), com seus 3 passos.

## Pendências

- **`erros_catalogo` está vazia.** A tabela foi criada nesta migration — não
  existia no banco, ao contrário do que o pedido supunha. O conteúdo do catálogo
  de erros vive no HTML standalone; cadastrar pelo admin (aba **Erros**) ou pedir
  um seed a partir daquele arquivo.
- Nenhum `equipe_membros.email` preenchido ainda — todo mundo passa pelo seletor
  na primeira vez.
- Identidade visual refinada (paleta kraft/laranja/navy, fonte condensada nos
  títulos) virá depois via Claude Design; hoje a tela usa o padrão do app.
