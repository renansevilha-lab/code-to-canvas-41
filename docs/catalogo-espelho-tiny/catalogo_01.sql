-- catalogo_01_espelho_tiny (07/out/2026) — Catálogo espelho do Tiny.
-- Só ACRESCENTA colunas/tabela/view/RPC. Nada existente muda de comportamento
-- até a tiny-sync-produtos v28 começar a gravar as colunas novas.

alter table public.produtos
  add column if not exists situacao text,               -- A / I / E do Tiny (listagem e detalhe)
  add column if not exists gtin text,
  add column if not exists unidade text,
  add column if not exists tipo_variacao text,          -- tipoVariacao do Tiny (P = pai, V = variação, N = normal)
  add column if not exists sku_pai text,                -- pai da variação (detalhe: produtoPai.sku)
  add column if not exists id_tiny_pai bigint,
  add column if not exists tiny_alterado_em timestamptz, -- dataAlteracao do Tiny
  add column if not exists tiny_visto_em timestamptz,    -- última vez que a listagem do Tiny devolveu o SKU
  add column if not exists estoque_atualizado_em timestamptz; -- `estoque` (já existia, vazia) vem do detalhe

comment on column public.produtos.situacao is 'Situação no Tiny (A ativo, I inativo, E excluído) — tiny-sync-produtos v28. `ativo` acompanha: ativo = (situacao = ''A'').';
comment on column public.produtos.sku_pai is 'SKU do produto pai quando o registro é variação (detalhe do Tiny: produtoPai). Base do agrupamento no Catálogo.';
comment on column public.produtos.estoque is 'Estoque total no Tiny (detalhe: estoque.quantidade), gravado pelo detalhar da tiny-sync-produtos v28. Por depósito: estoque_tiny.';

create index if not exists idx_produtos_sku_pai on public.produtos (sku_pai) where sku_pai is not null;
create index if not exists idx_produtos_situacao on public.produtos (situacao);

-- Estado da listagem retomável (a função para em ~25 s e a próxima rodada continua).
create table if not exists public.tiny_sync_estado (
  chave text primary key,
  fase text not null default 'ativos',          -- ativos -> inativos -> excluidos
  proximo_offset integer not null default 0,
  passada_iniciada_em timestamptz,
  ultima_completa_em timestamptz,
  total_tiny_ativos integer,
  total_tiny_inativos integer,
  total_tiny_excluidos integer,
  inativados_ultima integer,
  detalhe jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
alter table public.tiny_sync_estado enable row level security;
revoke all on public.tiny_sync_estado from public, anon, authenticated;
grant select on public.tiny_sync_estado to authenticated;
grant all on public.tiny_sync_estado to service_role;
create policy tiny_sync_estado_sel on public.tiny_sync_estado for select to authenticated using (true);
comment on table public.tiny_sync_estado is 'Estado das passadas da listagem de produtos do Tiny (tiny-sync-produtos v28): fase/offset para retomar, totais do Tiny e quando terminou a última passada completa.';

-- Catálogo: só o que está ATIVO no Tiny (situacao A), sem legado arquivado.
create or replace view public.view_catalogo with (security_invoker = true) as
select
  p.sku, p.id_tiny, p.nome, p.tipo,
  case p.tipo when 'S' then 'Simples' when 'K' then 'Kit' when 'V' then 'Com variações'
              when 'F' then 'Fabricado' when 'M' then 'Matéria-prima' else coalesce(p.tipo, '—') end as tipo_rotulo,
  p.tipo_variacao, p.sku_pai,
  coalesce(nullif(btrim(p.marca_manual), ''), p.marca) as marca,
  p.categoria_caminho,
  p.categoria as categoria_folha,
  f.foto,
  p.preco,
  ce.cmv_efetivo as custo,
  -- mesma conta da tela antiga (view_produtos_margem): preço de tabela − CMV efetivo
  p.preco - ce.cmv_efetivo as margem_bruta,
  case when p.preco > 0 and ce.cmv_efetivo is not null
       then round((p.preco - ce.cmv_efetivo) / p.preco * 100, 2) end as margem_pct,
  p.estoque, p.estoque_atualizado_em,
  p.gtin, p.unidade, p.situacao, p.fornecedor,
  (p.tipo = 'K') as eh_kit,
  coalesce(k.n_componentes, 0) as n_componentes,
  (p.tipo = 'K' and coalesce(k.n_componentes, 0) = 0) as kit_sem_composicao,
  coalesce(v.n_variacoes, 0) as n_variacoes,
  p.tiny_alterado_em, p.tiny_visto_em, p.atualizado_em, p.detalhe_atualizado_em
from public.produtos p
left join public.view_cmv_efetivo ce on ce.sku = p.sku
left join public.view_foto_produto f on f.sku = p.sku
left join (select sku_kit, count(*)::int as n_componentes from public.produto_kits group by sku_kit) k on k.sku_kit = p.sku
left join (select sku_pai, count(*)::int as n_variacoes from public.produtos
           where sku_pai is not null and situacao = 'A' group by sku_pai) v on v.sku_pai = p.sku
where p.id_tiny is not null and p.situacao = 'A' and not coalesce(p.arquivado, false);

revoke all on public.view_catalogo from public, anon;
grant select on public.view_catalogo to authenticated, service_role;
comment on view public.view_catalogo is 'Catálogo = espelho dos produtos ATIVOS do Tiny (situacao A). Custo = view_cmv_efetivo (kit pela composição); foto = view_foto_produto; variações têm sku_pai. Fonte da tela /produtos (Catálogo).';

-- Números do topo da tela (agregado no banco, não no navegador).
create or replace function public.catalogo_resumo()
returns jsonb language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'ativos_espelho', (select count(*) from view_catalogo),
    'por_tipo', (select coalesce(jsonb_object_agg(tipo_rotulo, n), '{}'::jsonb)
                 from (select tipo_rotulo, count(*) n from view_catalogo group by 1) t),
    'sem_foto', (select count(*) from view_catalogo where foto is null),
    'sem_custo', (select count(*) from view_catalogo where coalesce(custo, 0) <= 0 and tipo <> 'V'),
    'kit_sem_composicao', (select count(*) from view_catalogo where kit_sem_composicao),
    'detalhe_mais_antigo', (select min(detalhe_atualizado_em) from view_catalogo),
    'marcas', (select coalesce(jsonb_agg(m order by m), '[]'::jsonb)
               from (select distinct marca m from view_catalogo where marca is not null) t),
    'categorias', (select coalesce(jsonb_agg(c order by c), '[]'::jsonb)
                   from (select distinct categoria_caminho c from view_catalogo where categoria_caminho is not null) t),
    'sync', (select to_jsonb(e) from tiny_sync_estado e where chave = 'produtos')
  );
$$;
revoke all on function public.catalogo_resumo() from public, anon;
grant execute on function public.catalogo_resumo() to authenticated, service_role;

-- Ponte até a 1ª passada da v28: os ativos que a listagem já trouxe (ativo=true, com id_tiny)
-- entram como 'A' para o catálogo não abrir vazio. A v28 corrige (I/E) na 1ª passada completa.
update public.produtos set situacao = 'A'
where id_tiny is not null and ativo and not coalesce(arquivado, false) and situacao is null;
