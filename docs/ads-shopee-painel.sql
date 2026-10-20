-- ============================================================================
-- Tela ADS Shopee com período escolhido (20/out/2026, pedido do dono: "os totalizadores não mudam quando eu
-- mudo a data"). Antes, cartões, KPIs, tabela e bolhas liam view_ads_anuncios / view_ads_resumo, FIXAS em 30 dias
-- (só o gráfico de barras seguia a data). ads_shopee_painel(de, ate, filtros…) faz a mesma conta da view
-- (soma por campanha no período; ROAS = gmv amplo ÷ gasto; classificar_roas) e devolve tudo de uma vez:
--   total + linhas (página, filtros e ordem no banco) · resumo por classificação (só quem teve gasto, como a
--   view_ads_resumo) · bolhas (todos com gasto). Status e orçamento = o de agora (ads_config_atual), senão o último
--   registrado no período. Com de/ate = últimos 30 dias o resultado bate com a view antiga.
-- ============================================================================
create index if not exists shopee_ads_campanha_data on public.shopee_ads_campanha (data);

create or replace function public.ads_shopee_painel(
  p_de date, p_ate date, p_empresa text default null, p_classif text[] default null,
  p_inv_min numeric default null, p_inv_max numeric default null,
  p_roas_min numeric default null, p_roas_max numeric default null,
  p_acos_min numeric default null, p_acos_max numeric default null,
  p_status text default null, p_tem_gasto boolean default true, p_busca text default null,
  p_ordem text default 'investimento', p_dir text default 'desc', p_offset int default 0, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_busca text := nullif(btrim(coalesce(p_busca, '')), '');
begin
  with ag as (
    select c.campaign_id, c.shop_id, max(c.empresa) empresa, max(c.ad_name) anuncio, max(c.ad_type) tipo_anuncio,
           max(c.placement) posicionamento, max(c.item_id) item_id,
           sum(c.gasto) investimento, sum(c.gmv_amplo) vendas, sum(c.impressoes) impressoes, sum(c.cliques) cliques,
           sum(c.pedidos_amplo) pedidos, min(c.data) primeiro_dia, max(c.data) ultimo_dia,
           (array_agg(c.budget order by c.data desc) filter (where c.budget is not null))[1] orc_reg,
           (array_agg(c.status order by c.data desc) filter (where c.status is not null))[1] status_reg
      from public.shopee_ads_campanha c
     where c.data between p_de and p_ate
     group by c.campaign_id, c.shop_id),
  base as (
    select a.campaign_id, a.shop_id, a.empresa, a.anuncio, a.tipo_anuncio, a.posicionamento, a.item_id,
           coalesce(cf.status, a.status_reg) status, coalesce(cf.budget, a.orc_reg) orcamento_diario,
           an.imagem_url foto, an.sku_pai, a.investimento, a.vendas, a.impressoes, a.cliques, a.pedidos,
           case when a.investimento > 0 then round(a.vendas / a.investimento, 2) end roas,
           case when a.vendas > 0 then round(a.investimento / a.vendas * 100, 2) end acos,
           case when a.impressoes > 0 then round(a.cliques::numeric / a.impressoes * 100, 2) end ctr,
           case when a.cliques > 0 then round(a.investimento / a.cliques, 2) end cpc,
           a.investimento > 0 teve_gasto, a.primeiro_dia, a.ultimo_dia
      from ag a
      left join public.ads_config_atual cf on cf.mkt = 'shopee' and cf.shop_id = a.shop_id and cf.campaign_id = a.campaign_id::text
      left join public.shopee_anuncios an on an.item_id = a.item_id and an.shop_id = a.shop_id),
  cl as (select b.*, public.classificar_roas(b.roas) classificacao_roas from base b),
  escopo as (select * from cl where p_empresa is null or empresa = p_empresa),
  filt as (
    select * from escopo
     where (p_classif is null or cardinality(p_classif) = 0 or classificacao_roas = any (p_classif))
       and (p_inv_min is null or investimento >= p_inv_min) and (p_inv_max is null or investimento <= p_inv_max)
       and (p_roas_min is null or roas >= p_roas_min) and (p_roas_max is null or roas <= p_roas_max)
       and (p_acos_min is null or acos >= p_acos_min) and (p_acos_max is null or acos <= p_acos_max)
       and (p_status is null or status = p_status)
       and (not coalesce(p_tem_gasto, true) or teve_gasto)
       and (v_busca is null or anuncio ilike '%' || v_busca || '%' or sku_pai ilike '%' || v_busca || '%')),
  pagina as (
    select f.*, case p_ordem
        when 'vendas' then f.vendas when 'roas' then f.roas when 'ctr' then f.ctr when 'acos' then f.acos
        when 'cpc' then f.cpc when 'orcamento_diario' then f.orcamento_diario when 'impressoes' then f.impressoes
        when 'cliques' then f.cliques else f.investimento end chave
      from filt f
     order by case when p_dir = 'asc' then case p_ordem
        when 'vendas' then f.vendas when 'roas' then f.roas when 'ctr' then f.ctr when 'acos' then f.acos
        when 'cpc' then f.cpc when 'orcamento_diario' then f.orcamento_diario when 'impressoes' then f.impressoes
        when 'cliques' then f.cliques else f.investimento end end asc nulls last,
      case when p_dir <> 'asc' then case p_ordem
        when 'vendas' then f.vendas when 'roas' then f.roas when 'ctr' then f.ctr when 'acos' then f.acos
        when 'cpc' then f.cpc when 'orcamento_diario' then f.orcamento_diario when 'impressoes' then f.impressoes
        when 'cliques' then f.cliques else f.investimento end end desc nulls last,
      f.campaign_id
     offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 50), 1), 500))
  select jsonb_build_object(
    'de', p_de, 'ate', p_ate,
    'total', (select count(*) from filt),
    'linhas', coalesce((select jsonb_agg(to_jsonb(p) - 'chave' order by
        case when p_dir = 'asc' then p.chave end asc nulls last, case when p_dir <> 'asc' then p.chave end desc nulls last, p.campaign_id)
      from pagina p), '[]'::jsonb),
    'resumo', coalesce((select jsonb_agg(jsonb_build_object('classificacao_roas', r.classificacao_roas, 'anuncios', r.n,
        'investimento', round(r.inv, 2), 'vendas', round(r.ven, 2)))
      from (select classificacao_roas, count(*) n, sum(investimento) inv, sum(vendas) ven from escopo where teve_gasto group by 1) r), '[]'::jsonb),
    'bolhas', coalesce((select jsonb_agg(jsonb_build_object('investimento', investimento, 'vendas', vendas, 'roas', roas,
        'classif', classificacao_roas)) from escopo where teve_gasto), '[]'::jsonb)
  ) into v;
  return v;
end $$;
revoke all on function public.ads_shopee_painel(date, date, text, text[], numeric, numeric, numeric, numeric, numeric, numeric, text, boolean, text, text, text, int, int) from public, anon;
grant execute on function public.ads_shopee_painel(date, date, text, text[], numeric, numeric, numeric, numeric, numeric, numeric, text, boolean, text, text, text, int, int) to authenticated, service_role;
