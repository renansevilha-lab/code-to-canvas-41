-- ============================================================================
-- Agente de ADS — metas de ROAS, orçamento e equilíbrio (20/out/2026, pedido do dono)
-- ads_metas_situacao(p_ref) → jsonb {resumo, itens}: TODAS as campanhas com gasto nos 7 dias até p_ref (Shopee por
-- campanha = anúncio; ML por campanha), com meta atual (ads_config_atual), orçamento, ROAS 7 d, MC sem ADS (30 d),
-- ROAS de equilíbrio (100 ÷ MC%), meta mínima (equilíbrio × 1,15) e as MESMAS regras do diagnóstico da análise por
-- anúncio (ads_analise_anuncio / _ml). perda_7d = gasto − margem que a venda do ADS trouxe (só quando > 0).
-- Entra no ads_relatorio_diario como 'metas' + 'alteracoes_config' (ads_config_historico dos últimos 7 dias).
-- ============================================================================
create or replace function public.ads_metas_situacao(p_ref date default null)
returns jsonb language sql stable security definer set search_path = public as $$
with ref as (select coalesce(p_ref, (now() at time zone 'America/Sao_Paulo')::date - 1) d),
sh as (
  select 'shopee'::text mkt, c.shop_id, c.campaign_id::text campanha, max(c.ad_name) nome, max(c.item_id)::text anuncio,
         sum(c.gasto) gasto, sum(c.gmv_amplo) receita, sum(c.pedidos_amplo) pedidos
    from public.shopee_ads_campanha c, ref
   where c.data between ref.d - 6 and ref.d
   group by 1, 2, 3),
sh2 as (
  select s.mkt, s.shop_id, s.campanha, coalesce(cf.nome, s.nome) nome, s.anuncio, null::text sku,
         s.gasto, s.receita, s.pedidos, cf.roas_target meta, cf.budget orcamento, cf.status,
         (select count(*) from public.shopee_ads_campanha x, ref
           where x.shop_id = s.shop_id and x.campaign_id::text = s.campanha and x.data between ref.d - 6 and ref.d
             and cf.budget > 0 and x.gasto >= 0.9 * cf.budget) dias_esgotado,
         m.margem_contribuicao_pct mc, m.confiavel
    from sh s
    left join public.ads_config_atual cf on cf.mkt = 'shopee' and cf.shop_id = s.shop_id and cf.campaign_id = s.campanha
    left join public.ads_margem_anuncio m on m.marketplace = 'shopee' and m.nivel = 'anuncio' and m.shop_id = s.shop_id and m.anuncio_id = s.anuncio),
ml as (
  select c.campaign_id::text campanha, max(c.nome) nome, sum(c.gasto) gasto, sum(c.vendas_total) receita, sum(c.unidades) pedidos,
         (array_agg(c.acos_target order by c.data desc))[1] acos_reg, (array_agg(c.budget order by c.data desc))[1] orc_reg
    from public.ml_ads_campanha_diario c, ref
   where c.data between ref.d - 6 and ref.d
   group by 1),
ml_sku as (
  select a.campaign_id::text campanha, array_agg(distinct m.sku) skus
    from public.ml_ads_anuncio_diario a join public.ml_anuncios m on m.mlb = a.item_id, ref
   where a.data between ref.d - 29 and ref.d and m.sku is not null
   group by 1),
ml_mg as (
  select k.campanha, round(sum(g.margem_contribuicao) / nullif(sum(g.receita), 0) * 100, 2) mc, bool_and(g.confiavel) confiavel,
         string_agg(distinct g.sku, ', ') sku
    from ml_sku k join public.ads_margem_anuncio g on g.marketplace = 'mercadolivre' and g.nivel = 'sku' and g.sku = any (k.skus)
   group by 1),
ml2 as (
  select 'ml'::text mkt, 1107117809::bigint shop_id, l.campanha, coalesce(cf.nome, l.nome) nome, null::text anuncio, mg.sku,
         l.gasto, l.receita, l.pedidos,
         coalesce(cf.roas_target, round(100 / nullif(l.acos_reg, 0), 2)) meta, coalesce(cf.budget, l.orc_reg) orcamento, cf.status,
         (select count(*) from public.ml_ads_campanha_diario x, ref
           where x.campaign_id::text = l.campanha and x.data between ref.d - 6 and ref.d
             and coalesce(cf.budget, x.budget) > 0 and x.gasto >= 0.9 * coalesce(cf.budget, x.budget)) dias_esgotado,
         mg.mc, mg.confiavel
    from ml l
    left join public.ads_config_atual cf on cf.mkt = 'ml' and cf.shop_id = 1107117809 and cf.campaign_id = l.campanha
    left join ml_mg mg on mg.campanha = l.campanha),
todas as (select * from sh2 union all select * from ml2),
calc as (
  select t.*,
         case when t.gasto > 0 then round(t.receita / t.gasto, 2) end roas,
         case when t.mc > 0 then round(100 / t.mc, 2) end eq,
         case when t.mc > 0 then round(ceil(100 / t.mc * 1.15 * 10) / 10, 1) end meta_min
    from todas t where t.gasto >= 5),
flags as (
  select c.*,
    (c.mc is not null and c.mc <= 0) sem_margem,
    (c.eq is not null and c.meta is not null and c.meta < c.eq) meta_abaixo_equilibrio,
    (c.eq is not null and c.gasto >= 20 and c.roas < c.eq) prejuizo_7d,
    (c.gasto >= 15 and c.pedidos = 0) gasto_sem_venda,
    (c.meta is not null and c.gasto >= 10 and coalesce(c.roas, 0) < c.meta * 0.8) roas_abaixo_meta,
    (c.orcamento > 0 and c.dias_esgotado >= 3 and coalesce(c.roas, 0) >= greatest(coalesce(c.meta, 0), coalesce(c.eq, 0))) orcamento_travando,
    (c.meta is not null and c.roas >= c.meta * 1.3 and (coalesce(c.orcamento, 0) = 0 or c.gasto / 7 < 0.5 * c.orcamento)
       and (c.eq is null or greatest(coalesce(c.meta_min, 0), round(c.roas * 0.85, 1)) < c.meta)) meta_segurando_volume,
    case when c.mc is not null then greatest(round(c.gasto - c.receita * c.mc / 100, 2), 0) end perda_7d
  from calc c),
cl as (
  select f.*,
    case when f.sem_margem or f.meta_abaixo_equilibrio or f.prejuizo_7d or f.gasto_sem_venda then 'ruim'
         when f.roas_abaixo_meta then 'atencao'
         when f.orcamento_travando or f.meta_segurando_volume then 'oportunidade' else 'ok' end tom
  from flags f)
select jsonb_build_object(
  'data_referencia', (select d from ref), 'janela', '7 dias até a data de referência',
  'resumo', jsonb_build_object(
    'campanhas', count(*), 'ruim', count(*) filter (where tom = 'ruim'), 'atencao', count(*) filter (where tom = 'atencao'),
    'oportunidade', count(*) filter (where tom = 'oportunidade'),
    'meta_abaixo_equilibrio', count(*) filter (where meta_abaixo_equilibrio), 'prejuizo_7d', count(*) filter (where prejuizo_7d),
    'gasto_sem_venda', count(*) filter (where gasto_sem_venda), 'roas_abaixo_meta', count(*) filter (where roas_abaixo_meta),
    'orcamento_travando', count(*) filter (where orcamento_travando), 'meta_segurando_volume', count(*) filter (where meta_segurando_volume),
    'perda_7d_total', round(coalesce(sum(perda_7d) filter (where prejuizo_7d or sem_margem or gasto_sem_venda), 0), 2),
    'gasto_7d_total', round(sum(gasto), 2)),
  'itens', coalesce((select jsonb_agg(jsonb_build_object(
      'mkt', x.mkt, 'loja', case x.shop_id when 522186766 then 'Shopee Ottz' when 759046323 then 'Shopee Bumi/SVL' else 'ML Ottz' end,
      'campanha', x.campanha, 'nome', x.nome, 'anuncio', x.anuncio, 'sku', x.sku, 'status', x.status,
      'gasto_7d', round(x.gasto, 2), 'receita_7d', round(x.receita, 2), 'pedidos_7d', x.pedidos, 'roas_7d', x.roas,
      'meta', x.meta, 'orcamento', x.orcamento, 'dias_orcamento_esgotado', x.dias_esgotado,
      'mc_pct', x.mc, 'cmv_confiavel', x.confiavel, 'roas_equilibrio', x.eq, 'meta_minima', x.meta_min, 'perda_7d', x.perda_7d,
      'tom', x.tom,
      'problemas', to_jsonb(array_remove(array[
         case when x.sem_margem then 'sem margem nem antes do ADS' end,
         case when x.meta_abaixo_equilibrio then format('meta %s abaixo do equilíbrio %s', x.meta, x.eq) end,
         case when x.prejuizo_7d then format('ROAS %s abaixo do equilíbrio %s em 7 dias', x.roas, x.eq) end,
         case when x.gasto_sem_venda then 'gasto sem venda em 7 dias' end,
         case when x.roas_abaixo_meta then format('ROAS %s abaixo de 80%% da meta %s', coalesce(x.roas, 0), x.meta) end,
         case when x.orcamento_travando then format('orçamento esgotou em %s de 7 dias com ROAS bom', x.dias_esgotado) end,
         case when x.meta_segurando_volume then format('ROAS %s bem acima da meta %s gastando pouco', x.roas, x.meta) end], null)),
      'sugestao', case
         when x.sem_margem then 'rever preço/custo antes de investir em ADS'
         when x.meta_abaixo_equilibrio or x.prejuizo_7d then format('subir a meta para pelo menos %s%s', x.meta_min,
              case when x.mkt = 'ml' then ' (painel do Mercado Ads)' else ' (dá pelo lápis da tela de ADS Shopee)' end)
         when x.gasto_sem_venda then 'conferir preço/estoque/fotos; se não melhorar, pausar'
         when x.orcamento_travando then format('aumentar o orçamento (ex.: R$ %s/dia)', round(x.orcamento * 1.5))
         when x.meta_segurando_volume then format('testar meta de %s para ganhar volume', greatest(coalesce(x.meta_min, 0), round(x.roas * 0.85, 1)))
         when x.roas_abaixo_meta then 'a plataforma não entrega a meta: revisar competitividade ou ajustar a meta ao realizado' end
    ) order by case x.tom when 'ruim' then 0 when 'atencao' then 1 when 'oportunidade' then 2 else 3 end, coalesce(x.perda_7d, 0) desc, x.gasto desc)
    from (select * from cl where tom <> 'ok' order by case tom when 'ruim' then 0 when 'atencao' then 1 else 2 end, coalesce(perda_7d, 0) desc, gasto desc limit 40) x), '[]'::jsonb)
) from cl;
$$;
revoke all on function public.ads_metas_situacao(date) from public, anon;
grant execute on function public.ads_metas_situacao(date) to authenticated, service_role;

-- relatório diário do agente: + 'metas' e 'alteracoes_config' (aplicado por troca de texto na função no ar; ver a migração
-- ads_relatorio_metas). Formato de 'alteracoes_config': [{mkt, loja, campanha, nome, campo, de, para, quando, desde, origem, quem}].
