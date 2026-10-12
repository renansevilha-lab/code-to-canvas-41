-- ia_catalogo v1.1 (12/out/2026) — dois pedidos do dono na lista /ia/anuncios:
--   * filtro "Fotos da família, sem capa própria" (p_situacao = 'sem_capa'): o produto recebeu fotos
--     aproveitadas de outro produto (caminho `compartilhado/...`) e ainda não tem capa PRÓPRIA aprovada
--     — é a fila de capas a fazer depois de levar as fotos para os kits;
--   * ordem "Mais vendidos (120 dias)" (p_ordem = 'vendas120'): o histórico de vendas da IA guarda
--     30 e 120 dias (ia_hist_sku_canal); 120 dias é o "geral" disponível.
-- A resposta ganha `versao` (a tela só mostra o filtro e a ordem novos quando ele chega) e, em cada
-- linha, `sem_capa`. Nada mais muda: mesma assinatura, mesmos campos.
-- APLICADO em 12/out/2026 às 18h18 (com o OK do dono). O pacote de variações (docs/catalogo-espelho-tiny/
-- ia_catalogo_variacoes.sql) já inclui estas duas coisas — se ele for aplicado, este arquivo não precisa.
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
    select p.sku, p.nome, coalesce(p.marca_manual, p.marca) as marca, p.tipo
    from public.produtos p
    where p.ativo and not coalesce(p.arquivado, false)
  ), hist as (
    select h.sku, sum(h.unidades_30d) as un30, sum(h.unidades_120d) as un120, array_agg(distinct h.canal) as lista,
           jsonb_agg(jsonb_build_object('canal', h.canal, 'empresa', h.empresa, 'un30', h.unidades_30d, 'un120', h.unidades_120d,
             'preco', coalesce(h.preco_unit_ult, h.preco_unit_med), 'mc_pct', h.mc_pct) order by h.unidades_120d desc) as canais
    from public.ia_hist_sku_canal h group by 1
  ), rasc as (
    select r.sku, max(r.updated_at) as ultimo,
           bool_or(e.texto = 'aprovado' and e.imgs > 0 and e.imgs_ok = e.imgs) as pronto,
           bool_or(e.da_familia > 0) as tem_familia, bool_or(e.capas_proprias > 0) as tem_capa,
           jsonb_agg(jsonb_build_object('id', r.id, 'canal', r.canal, 'empresa', r.empresa, 'texto', e.texto,
             'imgs', e.imgs, 'imgs_ok', e.imgs_ok, 'andando', e.andando,
             'preco', coalesce(r.preco_aprovado, r.preco_sugerido), 'atualizado', r.updated_at) order by r.updated_at desc) as lista
    from public.ia_rascunho r
    left join lateral (
      select max(t.status) filter (where t.etapa = 'texto') as texto,
             count(*) filter (where t.etapa = 'imagem') as imgs,
             count(*) filter (where t.etapa = 'imagem' and t.status = 'aprovado') as imgs_ok,
             count(*) filter (where t.etapa = 'imagem' and t.status in ('na_fila', 'gerando')) as andando,
             -- foto aproveitada de outro produto (a função ia-aproveitar grava em compartilhado/...)
             count(*) filter (where t.etapa = 'imagem' and i.storage_path like 'compartilhado/%') as da_familia,
             -- capa PRÓPRIA aprovada (capa trazida de outro produto não conta: mostra a quantidade errada)
             count(*) filter (where t.etapa = 'imagem' and t.status = 'aprovado' and i.tipo like 'capa\_%'
                                and i.storage_path is not null and i.storage_path not like 'compartilhado/%') as capas_proprias
      from public.ia_etapa t
      left join public.ia_rascunho_imagem i on i.id = t.imagem_id
      where t.rascunho_id = r.id
    ) e on true
    group by 1
  ), f as (
    select b.sku, b.nome, b.marca, b.tipo, coalesce(h.un30, 0) as un30, coalesce(h.un120, 0) as un120, h.canais,
           r.lista as rascunhos, r.ultimo,
           case when r.sku is null then 'sem' when r.pronto then 'pronto' else 'andamento' end as situacao,
           (coalesce(r.tem_familia, false) and not coalesce(r.tem_capa, false)) as sem_capa
    from base b left join hist h using (sku) left join rasc r using (sku)
    where (v_b is null or b.sku ilike v_b || '%' or b.nome ilike '%' || v_b || '%')
      and (coalesce(p_marca, '') = '' or b.marca = p_marca)
      and (coalesce(p_sem_canal, '') = '' or not (p_sem_canal = any (coalesce(h.lista, '{}'::text[]))))
  ), g as (
    select * from f
    where coalesce(p_situacao, 'todos') in ('todos', '')
       or (p_situacao = 'sem_capa' and sem_capa)
       or situacao = p_situacao
  ), num as (
    select g.*, row_number() over (order by
        case when p_ordem = 'nome' then g.nome end asc nulls last,
        case when p_ordem = 'recentes' then g.ultimo end desc nulls last,
        case when p_ordem = 'novos' then g.sku end desc nulls last,
        case when p_ordem = 'vendas120' then g.un120 end desc nulls last,
        g.un30 desc, g.un120 desc, g.sku) as rn
    from g
  ), pag as (
    select * from num where rn > v_off and rn <= v_off + v_lim
  )
  select jsonb_build_object(
    'versao', 2,
    'total', (select count(*) from g),
    'contagem', (select jsonb_build_object('todos', count(*), 'sem', count(*) filter (where situacao = 'sem'),
                   'andamento', count(*) filter (where situacao = 'andamento'), 'pronto', count(*) filter (where situacao = 'pronto'),
                   'sem_capa', count(*) filter (where sem_capa)) from f),
    'marcas', (select coalesce(jsonb_agg(z.m order by z.m), '[]'::jsonb) from (select distinct marca as m from base where coalesce(marca, '') <> '') z),
    'historico_em', (select max(atualizado_em) from public.ia_hist_sku_canal),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku', pag.sku, 'nome', pag.nome, 'marca', pag.marca, 'tipo', pag.tipo, 'foto', ft.foto, 'custo', c.cmv_efetivo,
                 'un30', pag.un30, 'un120', pag.un120, 'canais', coalesce(pag.canais, '[]'::jsonb),
                 'rascunhos', coalesce(pag.rascunhos, '[]'::jsonb), 'situacao', pag.situacao, 'sem_capa', pag.sem_capa) order by pag.rn), '[]'::jsonb)
               from pag
               left join public.view_foto_produto ft on ft.sku = pag.sku
               left join public.view_cmv_efetivo c on c.sku = pag.sku)
  ) into v;
  return v;
end $function$;
