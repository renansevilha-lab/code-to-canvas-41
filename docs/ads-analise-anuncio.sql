-- ============================================================================
-- Análise de ADS por anúncio — Shopee (20/out/2026, pedido do dono)
-- ads_analise_anuncio(p_shop, p_campaign, p_dias) → jsonb
--   dias[]     : por dia — investimento, receita e pedidos do ADS, ROAS, meta de ROAS e orçamento VIGENTES no dia
--                (do ads_config_historico; antes da 1ª captura = desconhecido), uso do orçamento, e a venda total e a
--                margem do anúncio (todas as campanhas do item; ads_metrica_anuncio_dia, 60 d)
--   resumo     : últimos 7 dias × 7 anteriores
--   margem     : MC% do anúncio SEM ADS (ads_margem_anuncio, 30 d) → ROAS de equilíbrio = 100 ÷ MC%
--   mudancas[] : cada troca de meta/orçamento/status com 7 dias antes × 7 dias depois
--   diagnostico[] : {tom: ruim|atencao|oportunidade|info, titulo, texto, acao}
-- Fontes de dado diário: shopee_ads_campanha (API get_product_campaign_daily_performance; os últimos ~4 dias são
-- regravados pelo cron 40/41 — números do dia ainda podem mudar) e ads_metrica_anuncio_dia.
-- A API da Shopee NÃO devolve meta nem orçamento por dia (conferido 20/out, campanha 74740543, 14/10): só o que
-- capturamos a cada 2 h (crons 164/165) desde 20/out.
-- ============================================================================
create or replace function public.ads_analise_anuncio(p_shop bigint, p_campaign text, p_dias int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ini date := v_hoje - greatest(least(coalesce(p_dias, 30), 60), 14);
  v_camp bigint := nullif(p_campaign, '')::bigint;
  cfg public.ads_config_atual%rowtype;
  v_item text; v_nome text;
  v_mc numeric; v_conf boolean; v_eq numeric;
  v_dias jsonb; v_mud jsonb; v_diag jsonb := '[]'::jsonb;
  u7 record; a7 record;
  v_meta numeric; v_orc numeric; v_min_meta numeric;
begin
  select * into cfg from public.ads_config_atual where mkt = 'shopee' and shop_id = p_shop and campaign_id = p_campaign;
  select max(c.item_id)::text, max(c.ad_name) into v_item, v_nome
    from public.shopee_ads_campanha c where c.shop_id = p_shop and c.campaign_id = v_camp;
  v_item := coalesce(cfg.item_id, v_item); v_nome := coalesce(cfg.nome, v_nome);
  if v_item is null and cfg.campaign_id is null then
    return jsonb_build_object('ok', false, 'erro', 'campanha não encontrada');
  end if;

  select m.margem_contribuicao_pct, m.confiavel into v_mc, v_conf
    from public.ads_margem_anuncio m
   where m.nivel = 'anuncio' and m.marketplace = 'shopee' and m.shop_id = p_shop and m.anuncio_id = v_item limit 1;
  v_eq := case when v_mc > 0 then round(100 / v_mc, 2) end;
  v_min_meta := case when v_eq is not null then round(ceil(v_eq * 1.15 * 10) / 10, 1) end;   -- equilíbrio + 15% de folga

  -- série diária
  with dd as (select d::date as data from generate_series(v_ini, v_hoje - 1, interval '1 day') d),
  base as (
    select dd.data,
      coalesce(c.gasto, 0) gasto, coalesce(c.gmv_amplo, 0) receita, coalesce(c.pedidos_amplo, 0) pedidos,
      coalesce(c.impressoes, 0) impressoes, coalesce(c.cliques, 0) cliques, c.budget as orc_registrado,
      m.venda_total, m.margem, m.margem_pos_ads, m.gasto as gasto_item,
      -- meta e orçamento vigentes no FIM do dia (histórico capturado)
      (select h.para from public.ads_config_historico h where h.mkt = 'shopee' and h.shop_id = p_shop and h.campaign_id = p_campaign
         and h.campo = 'roas_target' and (h.ate at time zone 'America/Sao_Paulo')::date <= dd.data order by h.ate desc limit 1) meta_h,
      (select h.de from public.ads_config_historico h where h.mkt = 'shopee' and h.shop_id = p_shop and h.campaign_id = p_campaign
         and h.campo = 'roas_target' and (h.ate at time zone 'America/Sao_Paulo')::date > dd.data order by h.ate asc limit 1) meta_antes,
      (select h.para from public.ads_config_historico h where h.mkt = 'shopee' and h.shop_id = p_shop and h.campaign_id = p_campaign
         and h.campo = 'budget' and (h.ate at time zone 'America/Sao_Paulo')::date <= dd.data order by h.ate desc limit 1) orc_h,
      (select h.de from public.ads_config_historico h where h.mkt = 'shopee' and h.shop_id = p_shop and h.campaign_id = p_campaign
         and h.campo = 'budget' and (h.ate at time zone 'America/Sao_Paulo')::date > dd.data order by h.ate asc limit 1) orc_antes,
      cfg.primeira_vez is not null and (cfg.primeira_vez at time zone 'America/Sao_Paulo')::date <= dd.data as conhecido
    from dd
    left join public.shopee_ads_campanha c on c.shop_id = p_shop and c.campaign_id = v_camp and c.data = dd.data
    left join public.ads_metrica_anuncio_dia m on m.marketplace = 'shopee' and m.nivel = 'anuncio' and m.shop_id = p_shop
      and m.anuncio_id = v_item and m.data = dd.data
  ),
  fin as (
    select b.*,
      case when b.meta_h is not null then b.meta_h::numeric
           when b.conhecido then coalesce(b.meta_antes::numeric, cfg.roas_target) end as meta,
      case when b.orc_h is not null then b.orc_h::numeric
           when b.conhecido then coalesce(b.orc_antes::numeric, cfg.budget) end as orc
    from base b
  )
  select jsonb_agg(jsonb_build_object(
      'data', f.data, 'gasto', round(f.gasto, 2), 'receita', round(f.receita, 2), 'pedidos', f.pedidos,
      'impressoes', f.impressoes, 'cliques', f.cliques,
      'roas', case when f.gasto > 0 then round(f.receita / f.gasto, 2) end,
      'meta', f.meta, 'meta_conhecida', f.meta is not null,
      'orcamento', coalesce(f.orc, f.orc_registrado), 'orcamento_aproximado', f.orc is null and f.orc_registrado is not null,
      'uso_orcamento', case when coalesce(f.orc, f.orc_registrado) > 0 then round(f.gasto / coalesce(f.orc, f.orc_registrado) * 100, 0) end,
      'venda_total', round(f.venda_total, 2), 'margem', round(f.margem, 2), 'margem_pos_ads', round(f.margem_pos_ads, 2),
      'gasto_item', round(f.gasto_item, 2)
    ) order by f.data)
  into v_dias from fin f;

  -- 7 dias × 7 anteriores (dia de hoje fora: incompleto)
  select coalesce(sum(c.gasto), 0) gasto, coalesce(sum(c.gmv_amplo), 0) receita, coalesce(sum(c.pedidos_amplo), 0) pedidos,
         count(*) filter (where c.gasto > 0) dias_gasto,
         count(*) filter (where c.gasto > 0 and coalesce(cfg.budget, c.budget) > 0 and c.gasto >= 0.9 * coalesce(cfg.budget, c.budget)) dias_esgotado
    into u7 from public.shopee_ads_campanha c
   where c.shop_id = p_shop and c.campaign_id = v_camp and c.data between v_hoje - 7 and v_hoje - 1;
  select coalesce(sum(c.gasto), 0) gasto, coalesce(sum(c.gmv_amplo), 0) receita, coalesce(sum(c.pedidos_amplo), 0) pedidos
    into a7 from public.shopee_ads_campanha c
   where c.shop_id = p_shop and c.campaign_id = v_camp and c.data between v_hoje - 14 and v_hoje - 8;

  v_meta := cfg.roas_target; v_orc := cfg.budget;

  -- mudanças registradas com efeito 7 dias antes × 7 depois
  select coalesce(jsonb_agg(jsonb_build_object(
      'campo', h.campo, 'de', h.de, 'para', h.para, 'quando', h.ate, 'desde', h.desde, 'origem', h.origem, 'quem', h.quem,
      'antes', (select jsonb_build_object('gasto', round(coalesce(sum(c.gasto),0),2), 'receita', round(coalesce(sum(c.gmv_amplo),0),2),
                  'roas', case when sum(c.gasto) > 0 then round(sum(c.gmv_amplo)/sum(c.gasto),2) end, 'dias', count(*))
                from public.shopee_ads_campanha c where c.shop_id = p_shop and c.campaign_id = v_camp
                 and c.data between (h.ate at time zone 'America/Sao_Paulo')::date - 7 and (h.ate at time zone 'America/Sao_Paulo')::date - 1),
      'depois', (select jsonb_build_object('gasto', round(coalesce(sum(c.gasto),0),2), 'receita', round(coalesce(sum(c.gmv_amplo),0),2),
                  'roas', case when sum(c.gasto) > 0 then round(sum(c.gmv_amplo)/sum(c.gasto),2) end, 'dias', count(*))
                from public.shopee_ads_campanha c where c.shop_id = p_shop and c.campaign_id = v_camp
                 and c.data between (h.ate at time zone 'America/Sao_Paulo')::date + 1 and least((h.ate at time zone 'America/Sao_Paulo')::date + 7, v_hoje - 1))
    ) order by h.ate desc), '[]'::jsonb)
  into v_mud from public.ads_config_historico h
  where h.mkt = 'shopee' and h.shop_id = p_shop and h.campaign_id = p_campaign and h.ate >= now() - interval '120 days';

  -- diagnóstico (as regras ficam aqui, no banco)
  if v_mc is not null and v_mc <= 0 then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Sem margem nem antes do ADS',
      'texto', format('A margem de contribuição do anúncio em 30 dias é %s%% SEM contar o ADS: qualquer gasto aumenta o prejuízo.', round(v_mc, 1)),
      'acao', 'Rever preço, custo ou frete antes de investir em ADS.');
  end if;
  if v_eq is not null and v_meta is not null and v_meta < v_eq then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Meta abaixo do equilíbrio',
      'texto', format('A meta de ROAS (%s) está abaixo do ROAS de equilíbrio (%s, com margem de %s%%): mesmo batendo a meta o anúncio perde dinheiro.', v_meta, v_eq, round(v_mc, 1)),
      'acao', format('Subir a meta para pelo menos %s.', v_min_meta));
  end if;
  if v_eq is not null and u7.gasto >= 20 and u7.receita / nullif(u7.gasto, 0) < v_eq then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Dando prejuízo nos últimos 7 dias',
      'texto', format('ROAS de %s nos últimos 7 dias, abaixo do equilíbrio (%s): cada R$ 1 de ADS custou mais do que a margem que trouxe (R$ %s investidos).',
        round(u7.receita / u7.gasto, 2), v_eq, round(u7.gasto, 2)),
      'acao', format('Subir a meta para %s ou pausar a campanha.', v_min_meta));
  end if;
  if u7.gasto >= 15 and u7.pedidos = 0 then
    v_diag := v_diag || jsonb_build_object('tom', 'ruim', 'titulo', 'Gasto sem venda',
      'texto', format('R$ %s investidos em 7 dias sem nenhum pedido pelo ADS.', round(u7.gasto, 2)),
      'acao', 'Conferir preço, estoque, fotos e avaliações; se não melhorar, pausar.');
  end if;
  if v_meta is not null and u7.gasto >= 10 and u7.receita / nullif(u7.gasto, 0) < v_meta * 0.8 then
    v_diag := v_diag || jsonb_build_object('tom', 'atencao', 'titulo', 'ROAS bem abaixo da meta',
      'texto', format('A Shopee não está conseguindo entregar a meta: ROAS de %s nos últimos 7 dias contra meta de %s.', round(u7.receita / u7.gasto, 2), v_meta),
      'acao', 'O anúncio está perdendo competitividade (preço, avaliações, estoque). Se o ROAS real ainda dá lucro, ajuste a meta para perto do realizado.');
  end if;
  if v_orc > 0 and u7.dias_esgotado >= 3 and u7.receita / nullif(u7.gasto, 0) >= greatest(coalesce(v_meta, 0), coalesce(v_eq, 0)) then
    v_diag := v_diag || jsonb_build_object('tom', 'oportunidade', 'titulo', 'Orçamento travando vendas',
      'texto', format('O orçamento de R$ %s/dia esgotou em %s dos últimos 7 dias, com ROAS bom (%s).', v_orc, u7.dias_esgotado, round(u7.receita / u7.gasto, 2)),
      'acao', format('Aumentar o orçamento (ex.: R$ %s/dia).', round(v_orc * 1.5)));
  end if;
  if v_meta is not null and u7.gasto > 0 and u7.receita / u7.gasto >= v_meta * 1.3
     and (coalesce(v_orc, 0) = 0 or u7.gasto / 7 < 0.5 * v_orc)
     and (v_eq is null or greatest(coalesce(v_min_meta, 0), round(u7.receita / u7.gasto * 0.85, 1)) < v_meta) then
    v_diag := v_diag || jsonb_build_object('tom', 'oportunidade', 'titulo', 'Meta pode estar segurando o volume',
      'texto', format('ROAS de %s nos últimos 7 dias, bem acima da meta (%s), gastando pouco: a meta alta limita onde o anúncio aparece.', round(u7.receita / u7.gasto, 2), v_meta),
      'acao', format('Testar meta de %s para ganhar volume%s.', greatest(coalesce(v_min_meta, 0), round(u7.receita / u7.gasto * 0.85, 1)),
        case when v_eq is not null then format(' (sem passar do equilíbrio + folga, %s)', v_min_meta) else '' end));
  end if;
  if a7.receita >= 50 and abs(u7.receita - a7.receita) / a7.receita >= 0.3 then
    v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', case when u7.receita > a7.receita then 'Receita subindo' else 'Receita caindo' end,
      'texto', format('Receita do ADS nos últimos 7 dias: R$ %s, contra R$ %s nos 7 anteriores (%s%%).', round(u7.receita, 2), round(a7.receita, 2),
        round((u7.receita - a7.receita) / a7.receita * 100)),
      'acao', null);
  end if;
  if v_mc is null then
    v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', 'Sem margem calculada',
      'texto', 'Não há margem de 30 dias para este anúncio (sem venda ou sem custo): o ROAS de equilíbrio não pôde ser calculado.', 'acao', null);
  end if;
  if cfg.primeira_vez is null or cfg.primeira_vez > now() - interval '7 days' then
    v_diag := v_diag || jsonb_build_object('tom', 'info', 'titulo', 'Histórico de meta começando',
      'texto', 'A Shopee não informa a meta de ROAS de dias passados. O sistema registra meta e orçamento a cada 2 horas desde 20/10/2026: antes disso a meta do dia aparece como "sem registro".',
      'acao', null);
  end if;

  return jsonb_build_object(
    'ok', true, 'shop_id', p_shop, 'campaign_id', p_campaign, 'item_id', v_item, 'nome', v_nome,
    'config', case when cfg.campaign_id is not null then jsonb_build_object('roas_target', cfg.roas_target, 'budget', cfg.budget,
      'status', cfg.status, 'bidding_method', cfg.bidding_method, 'ad_type', cfg.ad_type, 'primeira_vez', cfg.primeira_vez, 'visto_em', cfg.visto_em) end,
    'margem', jsonb_build_object('mc_pct', v_mc, 'confiavel', v_conf, 'roas_equilibrio', v_eq, 'meta_minima', v_min_meta),
    'resumo', jsonb_build_object(
      'u7', jsonb_build_object('gasto', round(u7.gasto, 2), 'receita', round(u7.receita, 2), 'pedidos', u7.pedidos,
        'roas', case when u7.gasto > 0 then round(u7.receita / u7.gasto, 2) end, 'dias_gasto', u7.dias_gasto, 'dias_orcamento_esgotado', u7.dias_esgotado),
      'a7', jsonb_build_object('gasto', round(a7.gasto, 2), 'receita', round(a7.receita, 2), 'pedidos', a7.pedidos,
        'roas', case when a7.gasto > 0 then round(a7.receita / a7.gasto, 2) end)),
    'dias', coalesce(v_dias, '[]'::jsonb), 'mudancas', v_mud, 'diagnostico', v_diag);
end $$;
revoke all on function public.ads_analise_anuncio(bigint, text, int) from public, anon;
grant execute on function public.ads_analise_anuncio(bigint, text, int) to authenticated, service_role;
