# Anúncio Mágico → gestão · Fase 1 (cadastro de prompts) — PLANO

Decisão do dono (05/out/2026): unificar o gerador (`pcobdzlpnaoqdbsdzhlq`) no app de gestão
(`vhogjofsxyhnyxdyglmq`) em fases. Este documento é a Fase 1.

**Decisões do dono (06/out/2026):**
1. Fonte durante a Fase 1 = **gerador** (edita-se lá; a cópia é re-sincronizada por id antes da Fase 2).
2. Os 2 arquivos do bucket: o dono **sobe manualmente** depois na tela `/ia/contextos`; conferência por MD5.
3. Marca com apóstrofo: **corrigir** já na `ia_contextos_do_sku`.
4. `canal_faixa` e `empresa` **entram na Fase 1** (`ia_canal_faixa`, `ia_empresa`) + abas Canais/Empresas.
5. DDL **fora do horário comercial** (depois das 19h BRT).
6. Banco 501 MB: **opção A** — views do Agente de ADS de 90 → 60 dias (§7).

Telas prontas no repo (tsc + build ok), **sem push** até o DDL ser aplicado.

## 0. Levantamento (06/out/2026)

| Origem (gerador) | Linhas | Ativas | Texto | Destino (gestão) |
|---|---|---|---|---|
| `prompt_template` | 35 (9 `__bkp_20261003`) | 26 | 72 mil chars | `ia_prompt_template` |
| `prompt_guardrail` | 28 | 10 | 3 mil chars | `ia_prompt_guardrail` |
| `contexto_prompt` | 41 (35 "Cena:", 1 marca, 2 global, 3 sku) | 40 | 14 mil chars | `ia_contexto` |
| `modelo_imagem` | 8 | 8 | — | `ia_modelo_imagem` |
| `canal_config` | 7 | — | — | `ia_canal_config` |
| bucket `contexto` | 2 arquivos (960 kB) | — | — | bucket `ia-contexto` |

- Peso no banco da gestão: **< 1 MB**. Mas o banco está em **501 MB** (teto 500) — ver §7.
- **Categoria:** as chaves das cenas usam o formato de `produtos.categoria_caminho` da gestão
  ("Gatos -> Higiene e Limpeza -> Areia Higiênica e Granulados") — idêntico ao
  `produto_atributos.categoria` do gerador (conferido SKU a SKU). `produtos.categoria` da gestão é
  só a folha ("Areia Higiênica e Granulados") e **não** serve.
- **Marca:** gestão tem `marca` (Tiny) e `marca_manual` (correção do app) → marca efetiva =
  `coalesce(marca_manual, marca)`.
- Sem telefone nos textos a copiar (busca por padrão de telefone em templates, guardrails e
  contextos = 0). Os 2 arquivos do bucket são fotos de produto (15159, 15820), não o PDF da Bumi.
- Gestão: rotas TanStack Router por arquivo, planas (`createFileRoute("/x")`); `/ia/prompts` =
  arquivo `ia.prompts.tsx` (sem rota-pai). Menu em `AppSidebar` (`modulo` por item), guarda em
  `ROTA_MODULO` e catálogo em `MODULOS` (`src/hooks/usePerfil`). Não existe função "tem módulo"
  no banco. Perfis: Renan = `todos` (2 contas); equipe = `galpao`/`devolucoes`.

## 1. Migração `ia_01_cadastro_prompts` (DDL)

Tipos: os enums da origem (`tipo_prompt`, `escopo_guardrail`, `acao_guardrail`) viram `text` +
`CHECK` com os mesmos valores (sem criar tipos novos no banco da gestão). Mesmos ids (uuid) da
origem → dá para conferir linha a linha e re-sincronizar por id.

```sql
-- Anúncio Mágico → gestão · Fase 1: cadastro de prompts (cópia da origem pcob…, 06/out/2026)

-- quem tem o módulo pode ver/editar (Renan = 'todos'); a equipe não vê até ser liberada
create or replace function public.tem_modulo(p_modulo text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfis_usuario u
                 where u.user_id = auth.uid() and u.ativo
                   and (p_modulo = any(u.modulos) or 'todos' = any(u.modulos)));
$$;
revoke all on function public.tem_modulo(text) from public, anon;
grant execute on function public.tem_modulo(text) to authenticated, service_role;

create or replace function public.ia_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create table public.ia_canal_config (
  id uuid primary key default gen_random_uuid(),
  canal text not null unique,
  ativo boolean not null default true,
  qtd_imagens_min smallint not null default 5,
  qtd_imagens_max smallint not null default 9,
  imagem_largura integer not null default 1200,
  imagem_altura integer not null default 1200,
  imagem_formato text not null default 'jpg',
  titulo_max_chars smallint not null default 120,
  descricao_max_chars integer not null default 3000,
  comissao_pct numeric(6,4) not null default 0,
  margem_alvo_pct numeric(6,4) not null default 0.25,
  regras_extras jsonb not null default '{}'::jsonb,
  custos_fixos_pct numeric(6,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ia_prompt_template (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  tipo text not null check (tipo in ('imagem','titulo','descricao','bullet_points','briefing','meta_prompt')),
  canal text references public.ia_canal_config(canal) on update cascade,
  versao integer not null default 1,
  conteudo text not null,
  variaveis jsonb not null default '[]'::jsonb,
  modelo text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nome, versao)
);
create index ia_prompt_template_ativo on public.ia_prompt_template (tipo, canal) where ativo;

create table public.ia_prompt_guardrail (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  escopo text not null default 'global' check (escopo in ('global','canal','categoria')),
  canal text references public.ia_canal_config(canal) on update cascade,
  categoria text,
  tipo text not null,
  padrao text not null,
  substituto text,
  acao text not null default 'bloquear' check (acao in ('bloquear','substituir','avisar')),
  severidade smallint not null default 1,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ia_prompt_guardrail_ativo on public.ia_prompt_guardrail (escopo, canal) where ativo;

create table public.ia_contexto (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  escopo text not null check (escopo in ('global','marca','categoria','sku')),
  chave text,
  tipo text not null check (tipo in ('texto','imagem','documento')),
  conteudo text,
  storage_path text,                      -- caminho no bucket ia-contexto (mesmo caminho da origem)
  media_type text,
  aplica_em text[] not null default array['briefing','titulo','descricao','bullet_points','imagem'],
  prioridade smallint not null default 1,
  ativo boolean not null default true,
  papel text not null default 'diretriz' check (papel in ('referencia_produto','identidade_visual','ficha_tecnica','diretriz')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (escopo = 'global' or chave is not null),
  check ((tipo = 'texto' and conteudo is not null) or (tipo <> 'texto' and storage_path is not null))
);
create index ia_contexto_escopo on public.ia_contexto (escopo, chave) where ativo;

create table public.ia_modelo_imagem (
  id text primary key,
  label text not null,
  provider text not null check (provider in ('gemini','openai')),
  quality text,
  custo_estimado_usd numeric(8,4) not null,
  nota text,
  padrao boolean not null default false,
  ativo boolean not null default true,
  ordem smallint not null default 10,
  created_at timestamptz not null default now()
);
create unique index ia_modelo_imagem_um_padrao on public.ia_modelo_imagem (padrao) where padrao;

create table public.ia_canal_faixa (
  id uuid primary key default gen_random_uuid(),
  canal text not null references public.ia_canal_config(canal) on update cascade,
  ordem smallint not null,
  preco_ate numeric(12,2),
  comissao_pct numeric(6,4) not null,
  tarifa_fixa numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (canal, ordem)
);

create table public.ia_empresa (
  codigo text primary key,
  nome text not null,
  imposto_pct numeric(6,4) not null,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_ia_empresa_upd before update on public.ia_empresa for each row execute function public.ia_set_updated_at();
create trigger trg_ia_canal_config_upd before update on public.ia_canal_config for each row execute function public.ia_set_updated_at();
create trigger trg_ia_prompt_template_upd before update on public.ia_prompt_template for each row execute function public.ia_set_updated_at();
create trigger trg_ia_prompt_guardrail_upd before update on public.ia_prompt_guardrail for each row execute function public.ia_set_updated_at();
create trigger trg_ia_contexto_upd before update on public.ia_contexto for each row execute function public.ia_set_updated_at();

-- RLS: só authenticated com o módulo 'ia' (ou 'todos'); anon nada (lockdown 15/ago).
-- Edge functions da Fase 2 usam service_role (ignora RLS).
do $$ declare t text; begin
  foreach t in array array['ia_canal_config','ia_canal_faixa','ia_empresa','ia_prompt_template','ia_prompt_guardrail','ia_contexto','ia_modelo_imagem'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.tem_modulo(''ia'')) with check (public.tem_modulo(''ia''))', t || '_modulo_ia', t);
  end loop;
end $$;

-- produto visto pelo gerador: catálogo da gestão (sem produto_atributos) + foto resolvida
create or replace view public.ia_produto with (security_invoker = true) as
select p.sku, p.nome, coalesce(p.marca_manual, p.marca) marca, p.categoria_caminho, p.categoria categoria_folha,
       p.tipo, f.foto
from public.produtos p
left join public.view_foto_produto f on f.sku = p.sku;
revoke all on public.ia_produto from anon;
grant select on public.ia_produto to authenticated;

-- contextos que valem para um SKU — mesma regra/ordem da origem (contextos_do_sku), lendo produtos.
-- Categoria por prefixo em categoria_caminho (a chave "Cães -> Acessórios -> " já evita "Acessórios Alimentação").
-- Marca: comparação sem apóstrofo/espaço nas pontas e sem diferenciar maiúscula
-- (corrige "Bumi Pet Care'" do Tiny — pendência levada junto).
create or replace function public.ia_contextos_do_sku(p_sku text, p_aplica_em text default 'imagem')
returns setof public.ia_contexto language sql stable security invoker set search_path = public as $$
  select c.*
  from public.ia_contexto c
  join public.produtos p on p.sku = p_sku
  where c.ativo
    and p_aplica_em = any(c.aplica_em)
    and (
          c.escopo = 'global'
      or (c.escopo = 'marca' and lower(btrim(c.chave, $q$ '"$q$)) = lower(btrim(coalesce(p.marca_manual, p.marca), $q$ '"$q$)))
      or (c.escopo = 'categoria' and p.categoria_caminho like c.chave || '%')
      or (c.escopo = 'sku' and c.chave = p.sku)
    )
  order by case c.escopo when 'global' then 1 when 'categoria' then 2 when 'marca' then 3 when 'sku' then 4 end,
           c.prioridade;
$$;
revoke all on function public.ia_contextos_do_sku(text, text) from public, anon;
grant execute on function public.ia_contextos_do_sku(text, text) to authenticated, service_role;

-- quantos SKUs (não arquivados) cada contexto atinge — MESMA regra da ia_contextos_do_sku
-- (a tela do gerador contava no navegador, com igualdade em vez de prefixo e sobre >1.000 linhas)
create or replace view public.ia_contexto_alcance with (security_invoker = true) as
select c.id, count(p.sku) skus
from public.ia_contexto c
left join public.produtos p on not coalesce(p.arquivado, false) and (
     c.escopo = 'global'
  or (c.escopo = 'marca' and lower(btrim(c.chave, $q$ '"$q$)) = lower(btrim(coalesce(p.marca_manual, p.marca), $q$ '"$q$)))
  or (c.escopo = 'categoria' and p.categoria_caminho like c.chave || '%')
  or (c.escopo = 'sku' and c.chave = p.sku))
group by c.id;

-- opções de chave para o editor (marcas e caminhos de categoria do catálogo)
create or replace view public.ia_chaves_contexto with (security_invoker = true) as
select 'marca'::text tipo, m valor, count(*) skus
from (select coalesce(marca_manual, marca) m from public.produtos where not coalesce(arquivado, false)) x
where m is not null group by m
union all
select 'categoria', categoria_caminho, count(*) from public.produtos
where not coalesce(arquivado, false) and categoria_caminho is not null group by categoria_caminho;

revoke all on public.ia_contexto_alcance, public.ia_chaves_contexto from anon;
grant select on public.ia_contexto_alcance, public.ia_chaves_contexto to authenticated;

-- bucket privado dos arquivos de contexto (fotos de referência, manuais)
insert into storage.buckets (id, name, public) values ('ia-contexto', 'ia-contexto', false) on conflict (id) do nothing;
create policy ia_contexto_obj_sel on storage.objects for select to authenticated using (bucket_id = 'ia-contexto' and public.tem_modulo('ia'));
create policy ia_contexto_obj_ins on storage.objects for insert to authenticated with check (bucket_id = 'ia-contexto' and public.tem_modulo('ia'));
create policy ia_contexto_obj_upd on storage.objects for update to authenticated using (bucket_id = 'ia-contexto' and public.tem_modulo('ia')) with check (bucket_id = 'ia-contexto' and public.tem_modulo('ia'));
create policy ia_contexto_obj_del on storage.objects for delete to authenticated using (bucket_id = 'ia-contexto' and public.tem_modulo('ia'));
```

## 2. Cópia dos dados (migração `ia_02_copia_dados`)

1. Leio cada tabela da origem em JSON (todas < 1.000 linhas; 1 consulta por tabela, ordenada por id).
2. Insiro na gestão com `jsonb_populate_recordset`, mantendo **ids, datas e `ativo`** (os 9
   `__bkp_20261003` entram inativos, como estão). Ordem: canal → modelo → template → guardrail → contexto.
3. **Conferência** (§5): contagem por tabela e `md5` por linha (todas as colunas, exceto
   `updated_at` que o trigger não toca no insert — também conferido) comparados com a origem.
4. Arquivos (2): ver decisão D2.

## 3. Telas (front da gestão)

- Módulo novo **`ia`** em `MODULOS` ("IA · Anúncios"), `ROTA_MODULO` `["/ia", "ia"]` e
  `primeiraRotaPermitida` (`["ia", "/ia/prompts"]` no fim). Só quem tem `ia` ou `todos` vê.
- Grupo novo no `AppSidebar` "IA · Anúncios": **Prompts** (`/ia/prompts`) e **Contextos** (`/ia/contextos`).
- **`/ia/prompts`** (porta de `_app.ajustes` do gerador, só a parte de prompts): abas **Templates**
  (lista por tipo, editor de conteúdo, ativo; `__bkp_*` escondidos atrás de "mostrar backups"),
  **Regras** (guardrails: lista, ativo, editar padrão/substituto/ação), **Modelos** (ativo, padrão único).
- **`/ia/contextos`** (porta de `_app.contextos`): lista por escopo (global / categoria / marca / sku),
  criar/editar/desativar/excluir, **upload** de imagem/documento para `ia-contexto`, e uma caixa
  "Ver contextos de um SKU" que chama `ia_contextos_do_sku` e mostra o produto (`ia_produto`, com foto).
- Visual da gestão (acento roxo, oklch, componentes shadcn já existentes). Sem cálculo no front.
- Validar com `npx tsc --noEmit` e `npm run build` (descartar `routeTree.gen.ts` se só reordenar).

## 4. O gerador continua no ar

Nada é escrito no projeto pcob…: só leitura (SELECT) para copiar. As funções e telas do gerador
seguem lendo `prompt_template`/`contexto_prompt` de lá.

## 5. Validação

- Contagem por tabela origem × destino (35/28/41/8/7).
- `md5` de cada linha (mesma serialização nos dois bancos) — 0 diferenças.
- `ia_contextos_do_sku` × `contextos_do_sku` da origem para **todos os SKUs que existem nos dois
  catálogos** (por `md5` da lista de ids em ordem, por SKU, paginado): esperado idêntico, exceto
  os SKUs da marca "Bumi Pet Care'" (passam a receber a identidade Bumi — mudança intencional).
- Arquivos: tamanho e MD5 (`eTag`) iguais aos da origem (`059d25…`, `475c97…`).
- Front: tsc + build; acesso com usuário sem `ia` não mostra o menu nem abre a rota.

## 6. Rollback

```sql
drop function if exists public.ia_contextos_do_sku(text, text);
drop view if exists public.ia_produto, public.ia_contexto_alcance, public.ia_chaves_contexto;
drop table if exists public.ia_contexto, public.ia_prompt_guardrail, public.ia_prompt_template,
                     public.ia_modelo_imagem, public.ia_canal_faixa, public.ia_empresa, public.ia_canal_config;
drop function if exists public.ia_set_updated_at();
drop policy if exists ia_contexto_obj_sel on storage.objects;
drop policy if exists ia_contexto_obj_ins on storage.objects;
drop policy if exists ia_contexto_obj_upd on storage.objects;
drop policy if exists ia_contexto_obj_del on storage.objects;
drop function if exists public.tem_modulo(text);   -- só se nada mais usar
```
Bucket: esvaziar e apagar pelo painel/API do Storage (o Supabase não deixa apagar
`storage.objects` por SQL). Front: `git revert` do commit da Fase 1.

## 7. Banco em 501 MB — opção A aprovada (aplicar junto, à noite)

Maiores: escrow_componentes 81 MB, pedidos 50, pedidos_tiny 43, pedido_itens_tiny 30,
transacoes_carteira 30, etiquetas_cache 22, **print_jobs 21**, **ads_metrica_anuncio_dia 21**,
job_run_details 16, **ads_metrica_campanha_dia 15**. Objetos do Agente de ADS ≈ 42 MB.

**A (aprovada):** `ads_metrica_anuncio_dia` e `ads_metrica_campanha_dia` de 90 → **60 dias**
(nenhuma leitura passa de 36 dias: comparativo 36, sugestões/margem 30, alertas 3) e
`ads_tendencia_semana` de 9 → **5 semanas** (só idx 0–4 são usadas). `ads_metrica_loja_dia`
fica com 90 (minúscula; o resumo usa o mês anterior). Recriação numa migração só (transação):
captura das definições, troca da janela, recriação das dependentes (`ads_metrica_loja_dia`,
`ads_metrica_anuncio_dia`, `ads_tendencia_semana`, `ads_tendencias`) com índices, grants e
comentários; refresh; conferência do relatório de 04/10 contra o gabarito. Ganho ≈ 12–13 MB.

**print_jobs — APROVADO (06/out), aplicar à noite junto:**

```sql
-- Retenção do arquivo das etiquetas da impressão própria: depois de impresso o ZPL não é reutilizado
-- (reimpressão sai do etiquetas_cache, mesmos bytes). A linha fica (data, impressora, estado, título).
-- conteudo_b64 é NOT NULL → vira '' (sem alterar a coluna da fila viva). O trigger trg_print_jobs_espelha
-- só reage a UPDATE OF estado — não dispara. 'pegou' (preso) e 'pendente' não são tocados.
create or replace function public.limpar_print_jobs_conteudo(p_dias int default 2)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.print_jobs set conteudo_b64 = ''
  where estado in ('impresso', 'erro', 'cancelado')
    and conteudo_b64 <> ''
    and criado_em < now() - make_interval(days => p_dias);
  get diagnostics n = row_count;
  return jsonb_build_object('limpos', n, 'dias', p_dias);
end $$;
revoke all on function public.limpar_print_jobs_conteudo(int) from public, anon, authenticated;
grant execute on function public.limpar_print_jobs_conteudo(int) to service_role;
select cron.schedule('limpar-print-jobs', '7 4 * * *', $c$select public.limpar_print_jobs_conteudo(2)$c$);  -- 01h07 BRT
select public.limpar_print_jobs_conteudo(2);   -- 1ª limpeza na hora
```
O espaço liberado é reaproveitado pelos jobs novos (o arquivo da tabela não encolhe sem
TRUNCATE, e TRUNCATE na fila viva está fora de cogitação); o efeito é a tabela parar de crescer.

Proposta original: guarda o ZPL de cada etiqueta enviada à impressora própria
(`conteudo_b64`, ~20 kB por job) e cresce **4–7,5 MB por dia útil** (≈ 100 MB/mês). Depois de
impresso o conteúdo não é reutilizado (reimpressão sai do `etiquetas_cache`, mesmos bytes).
Retenção proposta: zerar `conteudo_b64` dos jobs `impresso`/`erro`/`cancelado` com mais de 2 dias
(a linha fica: data, impressora, estado, título — o histórico e a trilha de "preso" continuam),
num cron diário de madrugada. Sem TRUNCATE (a tabela é a fila viva).

## 8. Fases seguintes (só plano)

- **Fase 2 — geração na gestão:** tabelas `ia_briefing`, `ia_rascunho`, `ia_rascunho_imagem`,
  `ia_prompt_imagem` (prompts escritos), `ia_etapa`; as 5 functions versionadas (gerar-texto,
  gerar-imagens, gerar-prompts-imagem, gerar-imagem-worker, tiny-worker-detalhe→só a parte de
  geração) + gerar-briefing (só no remoto) adaptadas para `ia_produto`/`ia_contextos_do_sku`
  (sem `produto_atributos`; foto via `view_foto_produto`, o que resolve as capas defasadas);
  secrets ANTHROPIC/OPENAI/GOOGLE no projeto da gestão (o dono cadastra); worker encadeado sob
  demanda + cron de sobra a cada 5 min (NANO); bucket `ia-anuncios` (privado) e cópia dos 71 MB
  (Storage, não banco); tela "Gerar anúncio" (etapas, capas 1–6, Aprovar/Rejeitar/Refazer).
  Corrigir junto: barra vazia mandando exemplo, ícones vazios "escolha 3 a 5", aceitar "sem barra".
  Teste de referência: SKU 15984, capa estilo 5, 5 sacos, Sunburst.
- **Fase 3 — envio ao Tiny pela gestão:** token multi-conta com conta fixada no código (Ottz/SVL);
  conferir se o app Tiny da gestão tem escopo de escrita de produtos — mudar escopo revoga o token
  (só fora do expediente, com o dono). Regras: PUT /produtos com GET antes e conferência depois;
  imagem só por POST /anexos (nunca PUT de anexos); preço não é enviado. Bucket `ia-publicadas` público.
- **Fase 4:** gerador só leitura por 30 dias; depois pausar o projeto pcob….
