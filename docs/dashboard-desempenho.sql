-- ============================================================================
-- Dashboard › "Desempenho do período" (design "Visão geral", 21/out/2026).
-- Complementa o que o Dashboard já lê (dashboard_visao_geral, view_canais_diario, view_metas_realizado,
-- vendas_por_sku/marca, mv_anomalias) com as peças que faltavam, numa chamada só:
--   · horas      = receita / margem / pedidos POR HORA (BRT) quando o período é um dia só (Hoje, Ontem);
--                  mesma fonte da view_kpi_pedidos_dia (view_margem_pedido_v2), soma por hora ao vivo (~0,1 s);
--   · ads_lojas  = ADS por loja de ads_metrica_loja_dia (retrato das 06h20): ontem (gasto, ROAS, pós-ADS) e
--                  7 dias até ontem (gasto, TACOS = gasto ÷ venda da loja, pós-ADS = margem da loja − gasto);
--   · ads_metas  = resumo de ads_metas_situacao() (campanhas, meta abaixo do equilíbrio, prejuízo, perda 7 d);
--   · relatorios = último relatório de cada agente (3 dias): só destaque e hora — o corpo fica em /relatorios.
-- Cada parte tem o próprio bloco de exceção: se uma falhar, devolve {"erro": ...} e as outras seguem.
-- Rollback: drop function public.dashboard_desempenho(date, date);
-- ============================================================================

create or replace function public.dashboard_desempenho(p_de date, p_ate date)
returns jsonb
language plpgsql stable
security invoker
set search_path = public
as $$
declare
  r jsonb := jsonb_build_object('gerado_em', now());
  v jsonb;
  em timestamptz;
  ontem date := (now() at time zone 'America/Sao_Paulo')::date - 1;
begin
  -- vendas por hora (só período de um dia)
  if p_de = p_ate then
    begin
      select coalesce(jsonb_agg(jsonb_build_object('h', h, 'receita', round(rec, 2), 'margem', round(mg, 2), 'pedidos', ped) order by h), '[]'::jsonb)
        into v
      from (
        select extract(hour from data_pedido at time zone 'America/Sao_Paulo')::int h,
               sum(venda) rec, sum(coalesce(margem, 0)) mg, count(*) ped
        from view_margem_pedido_v2
        where data_pedido >= (p_de::timestamp at time zone 'America/Sao_Paulo')
          and data_pedido < ((p_de + 1)::timestamp at time zone 'America/Sao_Paulo')
        group by 1
      ) x;
      r := r || jsonb_build_object('horas', v);
    exception when others then
      r := r || jsonb_build_object('horas', jsonb_build_object('erro', sqlerrm));
    end;
  end if;

  -- ADS por loja: ontem × 7 dias até ontem
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'marketplace', marketplace, 'shop_id', shop_id::text, 'canal', canal, 'empresa', empresa,
             'g1', round(coalesce(g1, 0), 2), 'roas1', round(roas1, 2), 'pos1', round(pos1, 2),
             'g7', round(g7, 2), 'venda7', round(v7, 2), 'tacos7', case when v7 > 0 then round(g7 / v7, 4) end,
             'pos7', round(pos7, 2), 'provisorio', coalesce(prov, false)) order by g7 desc), '[]'::jsonb),
           max(atual)
      into v, em
      from (
        select a.marketplace, a.shop_id, a.canal, a.empresa,
               sum(a.gasto) filter (where a.data = ontem) g1,
               max(a.roas) filter (where a.data = ontem) roas1,
               sum(a.margem_pos_ads) filter (where a.data = ontem) pos1,
               sum(a.gasto) g7, sum(a.venda_loja) v7, sum(a.margem_pos_ads) pos7,
               bool_or(a.provisorio) filter (where a.data = ontem) prov,
               max(a.atualizado_em) atual
        from ads_metrica_loja_dia a
        where a.data between ontem - 6 and ontem
        group by 1, 2, 3, 4
        having sum(a.gasto) > 0
      ) x;
    r := r || jsonb_build_object('ads_lojas', jsonb_build_object('ontem', ontem, 'linhas', v, 'atualizado_em', em));
  exception when others then
    r := r || jsonb_build_object('ads_lojas', jsonb_build_object('erro', sqlerrm));
  end;

  -- resumo das metas de ROAS (agente de ADS)
  begin
    v := ads_metas_situacao();
    r := r || jsonb_build_object('ads_metas', jsonb_build_object('data_referencia', v->'data_referencia', 'resumo', v->'resumo'));
  exception when others then
    r := r || jsonb_build_object('ads_metas', jsonb_build_object('erro', sqlerrm));
  end;

  -- último relatório de cada agente
  begin
    select coalesce(jsonb_agg(jsonb_build_object('agente', agente, 'titulo', titulo, 'categoria', categoria,
             'destaque', destaque, 'data_referencia', data_referencia, 'gerado_em', gerado_em) order by gerado_em desc), '[]'::jsonb)
      into v
      from (
        select distinct on (agente) agente, titulo, categoria, destaque, data_referencia, gerado_em
        from relatorios_agentes
        where data_referencia >= (now() at time zone 'America/Sao_Paulo')::date - 3
        order by agente, data_referencia desc, gerado_em desc
      ) x;
    r := r || jsonb_build_object('relatorios', v);
  exception when others then
    r := r || jsonb_build_object('relatorios', jsonb_build_object('erro', sqlerrm));
  end;

  return r;
end;
$$;

revoke all on function public.dashboard_desempenho(date, date) from anon, public;
grant execute on function public.dashboard_desempenho(date, date) to authenticated, service_role;
