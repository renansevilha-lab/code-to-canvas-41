-- ia_catalogo v2 (12/out/2026) — variações agrupadas como no Tiny na lista /ia/anuncios.
-- NÃO APLICADO. Depende de produtos.sku_pai (catalogo_01.sql) preenchido pela
-- tiny-sync-produtos v28 (`detalhar&pais=1`). Aplicar fora do horário comercial.
-- O que muda em relação à v1 (10/out):
--   * a variação cujo pai está no catálogo ativo deixa de ser uma linha solta: vem dentro do
--     pai, em `variacoes` (com venda, custo, foto, canais e rascunhos próprios);
--   * o pai soma a venda das variações, mostra os canais delas e aparece na busca quando o
--     texto bate numa variação; a situação do pai considera os rascunhos das variações;
--   * `total` e `contagem` passam a contar linhas de topo (pai + produtos sem pai).
-- Enquanto `sku_pai` estiver vazio o resultado é o mesmo da v1 (+ `n_variacoes` 0 e `variacoes` []).
create or replace function public.ia_catalogo(
  p_busca text default null, p_marca text default null, p_situacao text default 'todos',
  p_sem_canal text default null, p_ordem text default 'vendas', p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v jsonb; v_b text := nullif(btrim(coalesce(p_busca, '')), '');
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200); v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  with base as (
    select p.sku, p.nome, coalesce(p.marca_manual, p.marca) as marca, p.tipo, p.sku_pai
    from public.produtos p
    where p.ativo and not coalesce(p.arquivado, false)
  ), lig as (
    -- pai = o pai da variação, só quando ele também está no catálogo ativo (senão fica solta)
    select b.sku, b.nome, b.marca, b.tipo,
           (select x.sku from base x where x.sku = b.sku_pai and x.sku <> b.sku) as pai
    from base b
  ), hist as (
    select h.sku, sum(h.unidades_30d) as un30, sum(h.unidades_120d) as un120, array_agg(distinct h.canal) as lista,
           jsonb_agg(jsonb_build_object('canal', h.canal, 'empresa', h.empresa, 'un30', h.unidades_30d, 'un120', h.unidades_120d,
             'preco', coalesce(h.preco_unit_ult, h.preco_unit_med), 'mc_pct', h.mc_pct) order by h.unidades_120d desc) as canais
    from public.ia_hist_sku_canal h group by 1
  ), rasc as (
    select r.sku, max(r.updated_at) as ultimo,
           bool_or(e.texto = 'aprovado' and e.imgs > 0 and e.imgs_ok = e.imgs) as pronto,
           jsonb_agg(jsonb_build_object('id', r.id, 'canal', r.canal, 'empresa', r.empresa, 'texto', e.texto,
             'imgs', e.imgs, 'imgs_ok', e.imgs_ok, 'andando', e.andando,
             'preco', coalesce(r.preco_aprovado, r.preco_sugerido), 'atualizado', r.updated_at) order by r.updated_at desc) as lista
    from public.ia_rascunho r
    left join lateral (
      select max(t.status) filter (where t.etapa = 'texto') as texto,
             count(*) filter (where t.etapa = 'imagem') as imgs,
             count(*) filter (where t.etapa = 'imagem' and t.status = 'aprovado') as imgs_ok,
             count(*) filter (where t.etapa = 'imagem' and t.status in ('na_fila', 'gerando')) as andando
      from public.ia_etapa t where t.rascunho_id = r.id
    ) e on true
    group by 1
  ), it as (
    -- cada SKU (pai, variação ou produto sem pai) com os números dele
    select l.sku, l.nome, l.marca, l.tipo, l.pai,
           coalesce(h.un30, 0) as un30, coalesce(h.un120, 0) as un120, h.canais, coalesce(h.lista, '{}'::text[]) as vende,
           r.lista as rascunhos, r.ultimo,
           case when r.sku is null then 'sem' when r.pronto then 'pronto' else 'andamento' end as situacao
    from lig l left join hist h using (sku) left join rasc r using (sku)
  ), fam as (
    -- o que as variações somam ao pai
    select i.pai as sku, count(*) as n, sum(i.un30) as un30, sum(i.un120) as un120, max(i.ultimo) as ultimo,
           bool_or(i.situacao = 'pronto') as pronto, bool_or(i.situacao <> 'sem') as tem,
           bool_or(v_b is not null and (i.sku ilike v_b || '%' or i.nome ilike '%' || v_b || '%')) as bate
    from it i where i.pai is not null group by 1
  ), fam_canais as (
    -- canais em que as variações vendem, somados por canal/empresa (preço e margem ficam em cada variação)
    select x.pai as sku, array_agg(distinct x.canal) as vende,
           jsonb_agg(jsonb_build_object('canal', x.canal, 'empresa', x.empresa, 'un30', x.un30, 'un120', x.un120,
             'preco', null, 'mc_pct', null) order by x.un120 desc) as canais
    from (
      select l.pai, h.canal, h.empresa, sum(h.unidades_30d) as un30, sum(h.unidades_120d) as un120
      from lig l join public.ia_hist_sku_canal h on h.sku = l.sku
      where l.pai is not null group by 1, 2, 3
    ) x group by 1
  ), f as (
    select i.sku, i.nome, i.marca, i.tipo,
           i.un30 + coalesce(fm.un30, 0) as un30, i.un120 + coalesce(fm.un120, 0) as un120,
           coalesce(fc.canais, i.canais) as canais, i.rascunhos, greatest(i.ultimo, fm.ultimo) as ultimo,
           case when i.situacao = 'pronto' or coalesce(fm.pronto, false) then 'pronto'
                when i.situacao <> 'sem' or coalesce(fm.tem, false) then 'andamento' else 'sem' end as situacao,
           coalesce(fm.n, 0) as n_variacoes
    from it i left join fam fm on fm.sku = i.sku left join fam_canais fc on fc.sku = i.sku
    where i.pai is null
      and (v_b is null or i.sku ilike v_b || '%' or i.nome ilike '%' || v_b || '%' or coalesce(fm.bate, false))
      and (coalesce(p_marca, '') = '' or i.marca = p_marca)
      and (coalesce(p_sem_canal, '') = '' or not (p_sem_canal = any (i.vende || coalesce(fc.vende, '{}'::text[]))))
  ), g as (
    select * from f where coalesce(p_situacao, 'todos') in ('todos', '') or situacao = p_situacao
  ), num as (
    select g.*, row_number() over (order by
        case when p_ordem = 'nome' then g.nome end asc nulls last,
        case when p_ordem = 'recentes' then g.ultimo end desc nulls last,
        case when p_ordem = 'novos' then g.sku end desc nulls last,
        g.un30 desc, g.un120 desc, g.sku) as rn
    from g
  ), pag as (
    select * from num where rn > v_off and rn <= v_off + v_lim
  )
  select jsonb_build_object(
    'total', (select count(*) from g),
    'contagem', (select jsonb_build_object('todos', count(*), 'sem', count(*) filter (where situacao = 'sem'),
                   'andamento', count(*) filter (where situacao = 'andamento'), 'pronto', count(*) filter (where situacao = 'pronto')) from f),
    'marcas', (select coalesce(jsonb_agg(z.m order by z.m), '[]'::jsonb) from (select distinct marca as m from base where coalesce(marca, '') <> '') z),
    'historico_em', (select max(atualizado_em) from public.ia_hist_sku_canal),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku', pag.sku, 'nome', pag.nome, 'marca', pag.marca, 'tipo', pag.tipo, 'foto', ft.foto, 'custo', c.cmv_efetivo,
                 'un30', pag.un30, 'un120', pag.un120, 'canais', coalesce(pag.canais, '[]'::jsonb),
                 'rascunhos', coalesce(pag.rascunhos, '[]'::jsonb), 'situacao', pag.situacao,
                 'n_variacoes', pag.n_variacoes,
                 'variacoes', case when pag.n_variacoes = 0 then '[]'::jsonb else (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'sku', vr.sku, 'nome', vr.nome, 'tipo', vr.tipo, 'foto', vf.foto, 'custo', vc.cmv_efetivo,
                            'un30', vr.un30, 'un120', vr.un120, 'canais', coalesce(vr.canais, '[]'::jsonb),
                            'rascunhos', coalesce(vr.rascunhos, '[]'::jsonb), 'situacao', vr.situacao)
                            order by vr.un30 desc, vr.un120 desc, vr.sku), '[]'::jsonb)
                   from it vr
                   left join public.view_foto_produto vf on vf.sku = vr.sku
                   left join public.view_cmv_efetivo vc on vc.sku = vr.sku
                   where vr.pai = pag.sku) end
               ) order by pag.rn), '[]'::jsonb)
               from pag
               left join public.view_foto_produto ft on ft.sku = pag.sku
               left join public.view_cmv_efetivo c on c.sku = pag.sku)
  ) into v;
  return v;
end $function$;
