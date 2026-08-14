# Tela Manual de Processos — backend + prompt de design

> Estado: **backend PRONTO** (migration `manual_processos_backend`, 14/ago/2026).
> Falta o **front** (`/processos`) — montar visual no Lovable com o prompt abaixo e
> ligar nas tabelas. Baseado no HTML `Manual_Interativo_Processos.html`.

## Decisões (com o dono)
1. **Checklist INDIVIDUAL por pessoa** — cada um marca o seu; progresso do dia é por pessoa.
2. **Editar estrutura = só admin** (perfil com módulo `todos`). Marcar tarefas = qualquer um do galpão.
3. Visual pelo Lovable; backend + wiring por aqui.
4. Rota `/processos`, módulo **`galpao`** (adicionar em `ROTA_MODULO` do `usePerfil` + menu).

## Backend (Supabase) — JÁ CRIADO
- **`manual_equipe`** `(id, nome, cor, user_id, ordem, ativo)` — pessoas/funções. `user_id` liga a pessoa ao login (para o checklist individual saber "quem sou eu").
- **`manual_secoes`** `(id, codigo, titulo, descricao, frequencia, responsavel_id→equipe, avisos jsonb, tabela_ref jsonb, ordem, ativo)`
  - `avisos` = `[{tipo:'info'|'warn', texto}]`; `tabela_ref` = `{head:[...], rows:[[...]]}` ou null.
- **`manual_tarefas`** `(id, secao_id→secoes, texto, tags text[], responsavel_id→equipe (override; null=herda da seção), ordem, ativo)`
- **`manual_progresso`** `(id, data, tarefa_id, pessoa_id→equipe, feito, feito_em)` — UNIQUE(data, tarefa_id, pessoa_id).
- GRANT select/insert/update/delete p/ anon+authenticated (sem RLS; edição de estrutura gated no front por perfil `todos`).

## Contrato de dados (como o front liga)
- **Ler estrutura:** `manual_secoes` (ativo=true, order by ordem) + `manual_tarefas` (por secao, ativo=true, order by ordem) + `manual_equipe` (ativo=true, order by ordem).
- **Quem sou eu:** achar em `manual_equipe` a linha com `user_id = auth user`. Se não houver, mostrar seletor de pessoa (ou read-only). O admin liga `user_id` no modo edição.
- **Responsável efetivo da tarefa:** `manual_tarefas.responsavel_id ?? manual_secoes.responsavel_id`.
- **Marcar tarefa (individual):** upsert em `manual_progresso` `{data: hoje, tarefa_id, pessoa_id: eu, feito}` (onConflict `data,tarefa_id,pessoa_id`). Progresso do dia lido com `data = hoje` e `pessoa_id = eu`.
- **Iniciar novo dia:** apaga (ou marca feito=false) o progresso de hoje da pessoa. (O dia vira sozinho: só ler `data = hoje`.)
- **Admin (perfil.modulos inclui `todos`):** insert/update/delete em `manual_equipe`, `manual_secoes`, `manual_tarefas`. Fora do admin, esconder o modo edição.
- Padrões do projeto: `QueryClient` de módulo, `refetchOnWindowFocus:false`, estado (filtro/busca) na URL.

---

## PROMPT PARA O CLAUDE DESIGN (copiar/colar no Lovable)

```text
Crie uma tela "Manual de Processos" — um checklist operacional diário da equipe de galpão/expedição, inspirado num manual de processos impresso. Referência de layout: cabeçalho escuro com barra de "Progresso do dia", cartões de seção recolhíveis, tarefas com caixa de marcar.

TOPO: título "Manual de Processos" + subtítulo "Operação · Separação · Expedição", data de hoje, e uma barra de "Progresso do dia" (percentual das MINHAS tarefas concluídas hoje). Abaixo: uma linha de chips para filtrar por pessoa (Todos + cada pessoa com sua cor e a contagem de tarefas) e um campo de busca.

CORPO: uma lista de cartões de SEÇÃO (processo). Cada cartão traz:
- Um código (ex.: ENV-01) num selo escuro.
- Título grande (ex.: "Envios Fulfillment").
- "Responsável: <pessoa>" como chip colorido + a frequência (ex.: Diária).
- Barra de progresso da seção + percentual.
- É recolhível (clicar no cabeçalho abre/fecha). Quando 100%, mostra um selo "Concluído".
- Dentro: descrição curta; a lista de TAREFAS (cada uma com uma caixa de marcar à esquerda, o texto, e etiquetas/tags coloridas — inclusive um chip com o responsável); avisos em destaque (verde = info, vermelho = atenção); e, quando houver, uma tabela de referência simples.

INTERAÇÃO:
- Marcar uma tarefa risca o texto e atualiza as barras (é o MEU checklist do dia — individual).
- Filtro por pessoa e busca por palavra escondem/mostram tarefas.
- Botão "Iniciar novo dia" (desmarca minhas tarefas do dia, com confirmação).
- MODO EDIÇÃO (só para administrador): um botão "Editar" revela a gestão da equipe (adicionar/renomear/trocar cor/remover pessoas) e a reatribuição de responsáveis por seção e por tarefa; também permite adicionar/editar/remover seções e tarefas. Para quem não é admin, o botão de editar nem aparece.

VISUAL: sério e legível, cores por pessoa, boa hierarquia (código + título grandes), cartões com borda. Suporte a tema claro e escuro. Estados vazios amigáveis. Responsivo (funciona no celular do galpão).

DADOS (mock com esta forma):
- equipe: [{ id, nome, cor }]
- secoes: [{ id, codigo, titulo, descricao, frequencia, responsavel_id, avisos:[{tipo,texto}], tabela_ref:{head,rows}|null, tarefas:[{ id, texto, tags:[], responsavel_id|null }] }]
- meuProgressoHoje: { [tarefa_id]: true }
- eu: { id, nome } (pessoa logada)
- ações: marcarTarefa(tarefa_id, feito), iniciarNovoDia(), e (admin) CRUD de equipe/seções/tarefas.
```
