-- ============================================================================
-- Análise de ADS — Mercado Livre (20/out/2026, pedido do dono: "a mesma análise por anúncio para o ML")
-- ads_analise_anuncio_ml(p_item, p_campaign, p_dias) → jsonb no MESMO formato de ads_analise_anuncio (Shopee),
-- para a tela usar o mesmo componente.
--   p_item (MLB) informado  → série do anúncio (ml_ads_anuncio_diario, desde 07/jul)
--   só p_campaign           → série da campanha (ml_ads_campanha_diario, desde 06/jul)
-- Meta (ROAS = 100 ÷ ACOS objetivo) e orçamento são da CAMPANHA: do histórico capturado (ads_config_historico,
-- desde 20/out) e, antes disso, do registro diário da campanha (ml_ads_campanha_diario.acos_target/budget) —
-- APROXIMADO: o cron 81 regrava os últimos 8 dias com a config do momento, então a troca pode aparecer até ~8 dias
-- antes da data real. Receita = vendas_total (diretas + indiretas), a mesma base da tela /ads-ml.
-- Margem: o ML não liga a venda ao MLB (pedido_itens não tem MLB) → margem do SKU do anúncio (ml_anuncios.sku):
-- MC sem ADS de 30 d em ads_margem_anuncio (nivel sku) e venda/margem diária do SKU em ads_metrica_anuncio_dia
-- (todas as vendas do SKU no ML, de todos os anúncios). Campanha = soma dos SKUs dos anúncios dela.
-- ============================================================================
create or replace function public.ads_analise_anuncio_ml(p_item text default null, p_campaign text default null, p_dias int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini date := v_hoje - greatest(least(coalesce(p_dias, 30), 90), 14);
  v_shop bigint := 1107117809;
  v_camp bigint; v_nome text; v_skus text[];
  cfg public.ads_config_atual%rowtype; mc record;
  v_mc numeric; v_eq numeric; v_min_meta numeric;
  v_dias jsonb; v_mud jsonb; v_diag jsonb := '[]'::jsonb;
  u7 record; a7 record; v_meta numeric; v_orc numeric; v_primeira date; v_esgotado int := 0;
begin
  if nullif(p_item, '') is not null then
    select a.campaign_id, coalesce(m.titulo, a.titulo) into v_camp, v_nome
      from public.ml_ads_anuncio_diario a left join public.ml_anuncios m on m.mlb = a.item_id
     where a.item_id = p_item order by a.data desc limit 1;
    if v_camp is null then return jsonb_build_object('ok', false, 'erro', 'anúncio sem ADS registrado'); end if;
    select array_agg(distinct m.sku) filter (where m.sku is not null) into v_skus from public.ml_anuncios m where m.mlb = p_item;
  else
    v_camp := nullif(p_campaign, '')::bigint;
    if v_camp is null then return jsonb_build_object('ok', false, 'erro', 'informe o anúncio ou a campanha'); end if;
    select array_agg(distinct m.sku) filter (where m.sku is not null) into v_skus
      from public.ml_ads_anuncio_diario a join public.ml_anuncios m on m.mlb = a.item_id
     where a.campaign_id = v_camp and a.data >= v_hoje - 30;
  end if;
  select * into cfg from public.ads_config_atual where mkt = 'ml' and shop_id = v_shop and campaign_id = v_camp::text;
  if p_item is null then
    v_nome := coalesce(cfg.nome, (select max(nome) from public.ml_ads_campanha_diario where campaign_id = v_camp));
  end if;
  v_primeira := (select min(data) from public.ml_ads_campanha_diario where campaign_id = v_camp);

  -- margem sem ADS (30 d) dos SKUs
  select sum(margem_contribuicao) mcon, sum(receita) rec, bool_and(confiavel) conf into mc
    from public.ads_margem_anuncio where marketplace = 'mercadolivre' and nivel = 'sku' and sku = any (coalesce(v_skus, '{}'));
  v_mc := case when mc.rec > 0 then round(mc.mcon / mc.rec * 100, 2) end;
  v_eq := case when v_mc > 0 then round(100 / v_mc, 2) end;
  v_min_meta := case when v_eq is not null then round(ceil(v_eq * 1.15 * 10) / 10, 1) end;

  with dd as (select d::date as data from generate_series(v_ini, v_hoje - 1, interval '1 day') d),
  ser as (  -- série: do anúncio ou da campanha
    select dd.data,
      coalesce(case when p_item is not null then (select sum(a.gasto) from public.ml_ads_anuncio_diario a where a.item_id = p_item and a.data = dd.data)
                    else (select sum(c.gasto) from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) end, 0) gasto,
      coalesce(case when p_item is not null then (select sum(a.vendas_total) from public.ml_ads_anuncio_diario a where a.item_id = p_item and a.data = dd.data)
                    else (select sum(c.vendas_total) from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) end, 0) receita,
      coalesce(case when p_item is not null then (select sum(a.unidades) from public.ml_ads_anuncio_diario a where a.item_id = p_item and a.data = dd.data)
                    else (select sum(c.unidades) from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) end, 0) pedidos,
      coalesce(case when p_item is not null then (select sum(a.impressoes) from public.ml_ads_anuncio_diario a where a.item_id = p_item and a.data = dd.data)
                    else (select sum(c.impressoes) from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) end, 0) impressoes,
      coalesce(case when p_item is not null then (select sum(a.cliques) from public.ml_ads_anuncio_diario a where a.item_id = p_item and a.data = dd.data)
                    else (select sum(c.cliques) from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) end, 0) cliques,
      (select c.gasto from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) gasto_campanha,
      (select c.acos_target from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) acos_reg,
      (select c.budget from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data = dd.data) orc_reg,
      (select h.para from public.ads_config_historico h where h.mkt = 'ml' and h.shop_id = v_shop and h.campaign_id = v_camp::text
         and h.campo = 'roas_target' and (h.ate at time zone 'America/Sao_Paulo')::date <= dd.data order by h.ate desc limit 1) meta_h,
      (select h.de from public.ads_config_historico h where h.mkt = 'ml' and h.shop_id = v_shop and h.campaign_id = v_camp::text
         and h.campo = 'roas_target' and (h.ate at time zone 'America/Sao_Paulo')::date > dd.data order by h.ate asc limit 1) meta_antes,
      (select h.para from public.ads_config_historico h where h.mkt = 'ml' and h.shop_id = v_shop and h.campaign_id = v_camp::text
         and h.campo = 'budget' and (h.ate at time zone 'America/Sao_Paulo')::date <= dd.data order by h.ate desc limit 1) orc_h,
      (select h.de from public.ads_config_historico h where h.mkt = 'ml' and h.shop_id = v_shop and h.campaign_id = v_camp::text
         and h.campo = 'budget' and (h.ate at time zone 'America/Sao_Paulo')::date > dd.data order by h.ate asc limit 1) orc_antes,
      cfg.primeira_vez is not null and (cfg.primeira_vez at time zone 'America/Sao_Paulo')::date <= dd.data as conhecido,
      (select sum(m.venda_total) from public.ads_metrica_anuncio_dia m where m.marketplace = 'mercadolivre' and m.nivel = 'sku'
          and m.anuncio_id = any (coalesce(v_skus, '{}')) and m.data = dd.data) venda_sku,
      (select sum(m.margem) from public.ads_metrica_anuncio_dia m where m.marketplace = 'mercadolivre' and m.nivel = 'sku'
          and m.anuncio_id = any (coalesce(v_skus, '{}')) and m.data = dd.data) margem_sku
    from dd),
  fin as (
    select s.*,
      case when s.meta_h is not null then s.meta_h::numeric
           when s.conhecido then coalesce(s.meta_antes::numeric, cfg.roas_target) end as meta_cap,
      case when s.orc_h is not null then s.orc_h::numeric
           when s.conhecido then coalesce(s.orc_antes::numeric, cfg.budget) end as orc_cap
    from ser s)
  select jsonb_agg(jsonb_build_object(
      'data', f.data, 'gasto', round(f.gasto, 2), 'receita', round(f.receita, 2), 'pedidos', f.pedidos,
      'impressoes', f.impressoes, 'cliques', f.cliques,
      'roas', case when f.gasto > 0 then round(f.receita / f.gasto, 2) end,
      'meta', coalesce(f.meta_cap, case when f.acos_reg > 0 then round(100 / f.acos_reg, 2) end),
      'meta_conhecida', coalesce(f.meta_cap, f.acos_reg) is not null,
      'meta_aproximada', f.meta_cap is null and f.acos_reg is not null,
      'orcamento', coalesce(f.orc_cap, f.orc_reg), 'orcamento_aproximado', f.orc_cap is null and f.orc_reg is not null,
      'uso_orcamento', case when coalesce(f.orc_cap, f.orc_reg) > 0 then round(coalesce(f.gasto_campanha, 0) / coalesce(f.orc_cap, f.orc_reg) * 100, 0) end,
      'venda_total', round(f.venda_sku, 2), 'margem', round(f.margem_sku, 2),
      'margem_pos_ads', case when f.margem_sku is not null then round(f.margem_sku - f.gasto, 2) end
    ) order by f.data)
  into v_dias from fin f;

  if p_item is not null then
    select coalesce(sum(gasto), 0) gasto, coalesce(sum(vendas_total), 0) receita, coalesce(sum(unidades), 0) pedidos,
           count(*) filter (where gasto > 0) dias_gasto into u7
      from public.ml_ads_anuncio_diario where item_id = p_item and data between v_hoje - 7 and v_hoje - 1;
    select coalesce(sum(gasto), 0) gasto, coalesce(sum(vendas_total), 0) receita, coalesce(sum(unidades), 0) pedidos into a7
      from public.ml_ads_anuncio_diario where item_id = p_item and data between v_hoje - 14 and v_hoje - 8;
  else
    select coalesce(sum(gasto), 0) gasto, coalesce(sum(vendas_total), 0) receita, coalesce(sum(unidades), 0) pedidos,
           count(*) filter (where gasto > 0) dias_gasto into u7
      from public.ml_ads_campanha_diario where campaign_id = v_camp and data between v_hoje - 7 and v_hoje - 1;
    select coalesce(sum(gasto), 0) gasto, coalesce(sum(vendas_total), 0) receita, coalesce(sum(unidades), 0) pedidos into a7
      from public.ml_ads_campanha_diario where campaign_id = v_camp and data between v_hoje - 14 and v_hoje - 8;
  end if;

  v_meta := coalesce(cfg.roas_target, (select round(100 / nullif(acos_target, 0), 2) from public.ml_ads_campanha_diario where campaign_id = v_camp order by data desc limit 1));
  v_orc := coalesce(cfg.budget, (select budget from public.ml_ads_campanha_diario where campaign_id = v_camp order by data desc limit 1));

  -- orçamento esgotando = gasto da CAMPANHA ≥ 90% do orçamento diário (o orçamento é dela)
  select count(*) filter (where c.gasto > 0 and coalesce(c.budget, v_orc) > 0 and c.gasto >= 0.9 * coalesce(c.budget, v_orc))
    into v_esgotado
    from public.ml_ads_campanha_diario c where c.campaign_id = v_camp and c.data between v_hoje - 7 and v_hoje - 1;

  -- mudanças: capturadas (exatas) + do registro diário (aproximadas)
  with cap as (
    select h.campo, h.de, h.para, h.ate quando, h.origem, h.quem, false aproximada
      from public.ads_config_historico h where h.mkt = 'ml' and h.shop_id = v_shop and h.campaign_id = v_camp::text
       and h.campo in ('roas_target', 'budget', 'status') and h.ate >= now() - interval '120 days'),
  reg as (
    select x.* from (
      select c.data, c.acos_target, c.budget,
             lag(c.acos_target) over (order by c.data) acos_ant, lag(c.budget) over (order by c.data) orc_ant
        from public.ml_ads_campanha_diario c where c.campaign_id = v_camp) x
     where x.data < coalesce((select min((quando at time zone 'America/Sao_Paulo')::date) from cap), v_hoje + 1)
       and ((x.acos_ant is not null and x.acos_target is distinct from x.acos_ant) or (x.orc_ant is not null and x.budget is distinct from x.orc_ant))),
  todas as (
    select campo, de, para, quando, origem, quem, aproximada from cap
    union all
    select 'roas_target', round(100 / nullif(acos_ant, 0), 2)::text, round(100 / nullif(acos_target, 0), 2)::text,
           (data::timestamp at time zone 'America/Sao_Paulo'), 'registro diário', null, true
      from reg where acos_target is distinct from acos_ant and acos_ant is not null
    union all
    select 'budget', orc_ant::text, budget::text, (data::timestamp at time zone 'America/Sao_Paulo'), 'registro diário', null, true
      from reg where budget is distinct from orc_ant and orc_ant is not null)
  select coalesce(jsonb_agg(jsonb_build_object(
      'campo', t.campo, 'de', t.de, 'para', t.para, 'quando', t.quando, 'origem', t.origem, 'quem', t.quem, 'aproximada', t.aproximada,
      'antes', (select jsonb_build_object('gasto', round(coalesce(sum(c.gasto),0),2), 'receita', round(coalesce(sum(c.vendas_total),0),2),
                  'roas', case when sum(c.gasto) > 0 then round(sum(c.vendas_total)/sum(c.gasto),2) end, 'dias', count(*))
                from public.ml_ads_campanha_diario c where c.campaign_id = v_camp
                 and c.data between (t.quando at time zone 'America/Sao_Paulo')::date - 7 and (t.quando at time zone 'America/Sao_Paulo')::date - 1),
      'depois', (select jsonb_build_object('gasto', round(coalesce(sum(c.gasto),0),2), 'receita', round(coalesce(sum(c.vendas_total),0),2),
                  'roas', case when sum(c.gasto) > 0 then round(sum(c.vendas_total)/sum(c.gasto),2) end, 'dias', count(*))
                from public.ml_ads_campanha_diario c where c.campaign_id = v_camp
                 and c.data between (t.quando at time zone 'America/Sao_Paulo')::date + 1 and least((t.quando at time zone 'America/Sao_Paulo')::date + 7, v_hoje - 1))
    ) order by t.quando desc), '[]'::jsonb)
  into v_mud from todas t;

  -- diagnóstico (mesmas regras da Shopee; no ML meta e orçamento só mudam pelo painel do Mercado Ads)
  if v_mc is not null and v_mc <= 0 then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Sem margem nem antes do ADS',
      'texto', format('A margem de contribuição do produto no ML em 30 dias é %s%% SEM contar o ADS: qualquer gasto aumenta o prejuízo.', round(v_mc, 1)),
      'acao', 'Rever preço, custo ou frete antes de investir em ADS.');
  end if;
  if v_eq is not null and v_meta is not null and v_meta < v_eq then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Meta abaixo do equilíbrio',
      'texto', format('O ROAS objetivo da campanha (%s) está abaixo do ROAS de equilíbrio (%s, com margem de %s%%): mesmo batendo a meta o produto perde dinheiro.', v_meta, v_eq, round(v_mc, 1)),
      'acao', format('Subir o ROAS objetivo para pelo menos %s no painel do Mercado Ads.', v_min_meta));
  end if;
  if v_eq is not null and u7.gasto >= 20 and u7.receita / nullif(u7.gasto, 0) < v_eq then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Dando prejuízo nos últimos 7 dias',
      'texto', format('ROAS de %s nos últimos 7 dias, abaixo do equilíbrio (%s): cada R$ 1 de ADS custou mais do que a margem que trouxe (R$ %s investidos).',
        round(u7.receita / u7.gasto, 2), v_eq, round(u7.gasto, 2)),
      'acao', case when p_item is not null then 'Tirar este anúncio da campanha ou subir o ROAS objetivo dela no painel do Mercado Ads.'
                   else format('Subir o ROAS objetivo para %s ou pausar a campanha (painel do Mercado Ads).', v_min_meta) end);
  end if;
  if u7.gasto >= 15 and u7.pedidos = 0 then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Gasto sem venda',
      'texto', format('R$ %s investidos em 7 dias sem nenhuma venda pelo ADS.', round(u7.gasto, 2)),
      'acao', 'Conferir preço, estoque, fotos e reputação do anúncio; se não melhorar, tirar da campanha.');
  end if;
  if v_meta is not null and u7.gasto >= 10 and u7.receita / nullif(u7.gasto, 0) < v_meta * 0.8 then
    v_diag := v_diag || jsonb_build_object('tom', 'atencao', 'titulo', 'ROAS bem abaixo da meta',
      'texto', format('O Mercado Livre não está entregando a meta: ROAS de %s nos últimos 7 dias contra objetivo de %s.', round(u7.receita / u7.gasto, 2), v_meta),
      'acao', 'O anúncio pode estar perdendo competitividade (preço, frete, reputação, estoque). Se o ROAS real ainda dá lucro, ajuste o objetivo para perto do realizado.');
  end if;
  if v_orc > 0 and v_esgotado >= 3 and u7.receita / nullif(u7.gasto, 0) >= greatest(coalesce(v_meta, 0), coalesce(v_eq, 0)) then
    v_diag := v_diag || jsonb_build_object('tom', 'oportunidade', 'titulo', 'Orçamento travando vendas',
      'texto', format('O orçamento da campanha (R$ %s/dia) esgotou em %s dos últimos 7 dias, com ROAS bom (%s).', v_orc, v_esgotado, round(u7.receita / u7.gasto, 2)),
      'acao', format('Aumentar o orçamento no painel do Mercado Ads (ex.: R$ %s/dia).', round(v_orc * 1.5)));
  end if;
  if v_meta is not null and u7.gasto > 0 and u7.receita / u7.gasto >= v_meta * 1.3
     and (v_eq is null or greatest(coalesce(v_min_meta, 0), round(u7.receita / u7.gasto * 0.85, 1)) < v_meta) then
    v_diag := v_diag || jsonb_build_object('tom', 'oportunidade', 'titulo', 'Meta pode estar segurando o volume',
      'texto', format('ROAS de %s nos últimos 7 dias, bem acima do objetivo (%s): dá para baixar o objetivo e ganhar alcance.', round(u7.receita / u7.gasto, 2), v_meta),
      'acao', format('Testar ROAS objetivo de %s no painel do Mercado Ads%s.', greatest(coalesce(v_min_meta, 0), round(u7.receita / u7.gasto * 0.85, 1)),
        case when v_eq is not null then format(' (sem passar do equilíbrio + folga, %s)', v_min_meta) else '' end));
  end if;
  if a7.receita >= 50 and abs(u7.receita - a7.receita) / a7.receita >= 0.3 then
    v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', case when u7.receita > a7.receita then 'Receita subindo' else 'Receita caindo' end,
      'texto', format('Receita do ADS nos últimos 7 dias: R$ %s, contra R$ %s nos 7 anteriores (%s%%).', round(u7.receita, 2), round(a7.receita, 2),
        round((u7.receita - a7.receita) / a7.receita * 100)), 'acao', null);
  end if;
  if v_mc is null then
    v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', 'Sem margem calculada',
      'texto', 'Não há margem de 30 dias para o SKU deste anúncio no ML (sem venda, sem custo ou anúncio sem SKU): o ROAS de equilíbrio não pôde ser calculado.', 'acao', null);
  end if;
  v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', 'Sobre a meta de dias passados',
    'texto', 'Antes de 20/10/2026 a meta e o orçamento vêm do registro diário da campanha (aproximado: a troca pode aparecer até ~8 dias antes da data real). De 20/10 em diante o sistema registra a cada 6 horas.',
    'acao', null);

  return jsonb_build_object(
    'ok', true, 'mkt', 'ml', 'shop_id', v_shop, 'campaign_id', v_camp::text, 'item_id', p_item, 'nome', v_nome, 'skus', v_skus,
    'config', jsonb_build_object('roas_target', v_meta, 'budget', v_orc, 'status', cfg.status, 'bidding_method', cfg.bidding_method,
      'ad_type', null, 'primeira_vez', coalesce(cfg.primeira_vez, v_primeira::timestamptz), 'visto_em', cfg.visto_em),
    'margem', jsonb_build_object('mc_pct', v_mc, 'confiavel', mc.conf, 'roas_equilibrio', v_eq, 'meta_minima', v_min_meta),
    'resumo', jsonb_build_object(
      'u7', jsonb_build_object('gasto', round(u7.gasto, 2), 'receita', round(u7.receita, 2), 'pedidos', u7.pedidos,
        'roas', case when u7.gasto > 0 then round(u7.receita / u7.gasto, 2) end, 'dias_gasto', u7.dias_gasto, 'dias_orcamento_esgotado', v_esgotado),
      'a7', jsonb_build_object('gasto', round(a7.gasto, 2), 'receita', round(a7.receita, 2), 'pedidos', a7.pedidos,
        'roas', case when a7.gasto > 0 then round(a7.receita / a7.gasto, 2) end)),
    'dias', coalesce(v_dias, '[]'::jsonb), 'mudancas', v_mud, 'diagnostico', v_diag);
end $$;
revoke all on function public.ads_analise_anuncio_ml(text, text, int) from public, anon;
grant execute on function public.ads_analise_anuncio_ml(text, text, int) to authenticated, service_role;
