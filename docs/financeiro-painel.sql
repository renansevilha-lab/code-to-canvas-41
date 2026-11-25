-- ============================================================================
-- Painel financeiro (26/nov/2026, opção A do dono: painel primeiro, balanço depois)
-- financeiro_painel() -> jsonb com tudo que a tela /financeiro mostra.
-- Só LÊ o que já existe: view_dre_mensal, dashboard_posicao_empresa(),
-- dashboard_estoque_valor(), view_fin_contas_pagar, view_kpi_pedidos_dia,
-- compras_nf_entrada e view_mp_extrato_dia. Nenhuma regra de cálculo nova de
-- margem/CMV — só indicadores derivados (equilíbrio, ciclo, liquidez).
-- Rollback: drop function public.financeiro_painel();
-- ============================================================================
create or replace function public.financeiro_painel()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_pos jsonb := '{}'::jsonb;
  v_est jsonb := '{}'::jsonb;
  v_meses jsonb;
  v_mp numeric := 0; v_mp_dia date; v_mp_por jsonb;
  v_carteiras numeric; v_caixa numeric; v_receber numeric;
  v_estoque numeric; v_parado numeric;
  v_pagar numeric; v_pagar_merc numeric; v_pagar30 numeric; v_atras numeric; v_atras_n int;
  v_cat jsonb; v_faixa jsonb;
  v_venda30 numeric; v_cmv30 numeric; v_receb30 numeric; v_compras90 numeric;
  v_pme numeric; v_pmr numeric; v_pmp numeric;
  v_dec jsonb := '[]'::jsonb;
  f jsonb; a jsonb; b jsonb; c jsonb;   -- mês atual e os dois fechados antes
  v_dia int; v_dias_mes int; v_proj numeric;
  v_liq numeric; v_liq_est numeric;
begin
  if not (tem_modulo('financeiro')) then
    raise exception 'sem acesso ao financeiro';
  end if;

  begin v_pos := dashboard_posicao_empresa(); exception when others then v_pos := jsonb_build_object('erro', sqlerrm); end;
  begin v_est := dashboard_estoque_valor();   exception when others then v_est := jsonb_build_object('erro', sqlerrm); end;

  -- DRE mês a mês (13 meses), com equilíbrio = despesas ÷ margem de contribuição %
  select jsonb_agg(to_jsonb(x) order by x.mes) into v_meses from (
    select mes,
           receita_liquida as receita, cmv, comissoes_frete as deducoes, impostos,
           margem_contribuicao as mc,
           round(100 * margem_contribuicao / nullif(receita_liquida, 0), 1) as mc_pct,
           ads, custo_fixo_sem_ads as fixo, total_despesas as despesas,
           round(100 * ads / nullif(receita_liquida, 0), 1) as ads_pct,
           round(100 * total_despesas / nullif(receita_liquida, 0), 1) as despesas_pct,
           lucro_liquido as lucro, margem_liquida_pct as lucro_pct,
           case when margem_contribuicao > 0
                then round(total_despesas / (margem_contribuicao / receita_liquida)) end as equilibrio
    from view_dre_mensal order by mes desc limit 13) x;

  -- Saldo do Mercado Pago (extrato diário; a API de saldo não abre)
  begin
    select coalesce(sum(saldo_final), 0), max(dia),
           jsonb_agg(jsonb_build_object('conta', conta, 'saldo', saldo_final, 'dia', dia))
      into v_mp, v_mp_dia, v_mp_por
    from (select distinct on (conta) conta, dia, saldo_final from view_mp_extrato_dia order by conta, dia desc) s;
  exception when others then v_mp := 0; end;

  v_carteiras := coalesce((v_pos #>> '{caixa,valor}')::numeric, 0);
  v_caixa     := v_carteiras + coalesce(v_mp, 0);
  v_receber   := coalesce((v_pos #>> '{receber,valor}')::numeric, 0);
  v_estoque   := coalesce((v_est ->> 'valor_total')::numeric, 0);
  v_parado    := coalesce((v_est #>> '{parado,valor}')::numeric, 0);

  -- Contas a pagar em aberto
  select coalesce(sum(saldo_aberto), 0),
         coalesce(sum(saldo_aberto) filter (where categoria ilike 'Mercadoria%'), 0),
         coalesce(sum(saldo_aberto) filter (where faixa in ('atrasado','hoje','ate_7d','ate_15d','ate_30d')), 0),
         coalesce(sum(saldo_aberto) filter (where faixa = 'atrasado'), 0),
         count(*) filter (where faixa = 'atrasado')
    into v_pagar, v_pagar_merc, v_pagar30, v_atras, v_atras_n
  from view_fin_contas_pagar;

  select jsonb_agg(to_jsonb(x) order by x.valor desc) into v_cat from (
    select coalesce(categoria, 'Sem categoria') as categoria, round(sum(saldo_aberto), 2) as valor, count(*) as contas,
           round(coalesce(sum(saldo_aberto) filter (where faixa in ('atrasado','hoje','ate_7d','ate_15d','ate_30d')), 0), 2) as ate_30d
    from view_fin_contas_pagar group by 1) x;

  select jsonb_object_agg(faixa, jsonb_build_object('valor', v, 'contas', n)) into v_faixa from (
    select faixa, round(sum(saldo_aberto), 2) v, count(*) n from view_fin_contas_pagar group by 1) x;

  -- Ritmo dos últimos 30 dias fechados (venda, custo do vendido, repasse) e compras de 90 dias
  select coalesce(sum(venda), 0), coalesce(sum(custo_prod), 0), coalesce(sum(recebido_estimado), 0)
    into v_venda30, v_cmv30, v_receb30
  from view_kpi_pedidos_dia where dia >= v_hoje - 30 and dia < v_hoje;

  select coalesce(sum(valor), 0) into v_compras90
  from compras_nf_entrada
  where not coalesce(ignorar, false) and fornecedor_cnpj is not null and data_emissao >= v_hoje - 90;

  v_pme := case when v_cmv30 > 0 then round(v_estoque / (v_cmv30 / 30)) end;        -- dias de estoque
  v_pmr := case when v_receb30 > 0 then round(v_receber / (v_receb30 / 30)) end;    -- dias para receber
  v_pmp := case when v_compras90 > 0 then round(v_pagar_merc / (v_compras90 / 90)) end; -- dias para pagar fornecedor

  v_liq     := case when v_pagar30 > 0 then round((v_caixa + v_receber) / v_pagar30, 2) end;
  v_liq_est := case when v_pagar30 > 0 then round((v_caixa + v_receber + v_estoque) / v_pagar30, 2) end;

  -- mês atual (parcial) e os dois fechados antes
  f := v_meses -> (jsonb_array_length(v_meses) - 1);
  a := v_meses -> (jsonb_array_length(v_meses) - 2);
  b := v_meses -> (jsonb_array_length(v_meses) - 3);
  c := v_meses -> (jsonb_array_length(v_meses) - 4);
  v_dia := extract(day from v_hoje)::int;
  v_dias_mes := extract(day from (date_trunc('month', v_hoje) + interval '1 month - 1 day'))::int;
  if (f ->> 'mes') = to_char(v_hoje, 'YYYY-MM') and v_dia > 1 then
    v_proj := round((f ->> 'receita')::numeric / (v_dia - 1) * v_dias_mes);
  end if;

  -- Pede decisão (regras fixas)
  if v_atras > 0 then
    v_dec := v_dec || jsonb_build_object('tom', 'red', 'o_que', 'Contas atrasadas',
      'detalhe', v_atras_n || ' conta(s) vencida(s)', 'valor', v_atras, 'link', '/contas-pagar');
  end if;
  if v_liq is not null and v_liq < 1 then
    v_dec := v_dec || jsonb_build_object('tom', case when v_liq < 0.6 then 'red' else 'amber' end,
      'o_que', 'Caixa e a receber não cobrem os próximos 30 dias',
      'detalhe', 'cobrem ' || round(v_liq * 100) || '% do que vence; o resto depende das vendas do período',
      'valor', round(v_pagar30 - v_caixa - v_receber), 'link', '/fluxo-caixa');
  end if;
  if (a ->> 'lucro_pct') is not null and (b ->> 'lucro_pct') is not null and (c ->> 'lucro_pct') is not null
     and (a ->> 'lucro_pct')::numeric < (b ->> 'lucro_pct')::numeric
     and (b ->> 'lucro_pct')::numeric <= (c ->> 'lucro_pct')::numeric then
    v_dec := v_dec || jsonb_build_object('tom', 'amber', 'o_que', 'Lucro caindo há dois meses',
      'detalhe', (c ->> 'lucro_pct') || '% → ' || (b ->> 'lucro_pct') || '% → ' || (a ->> 'lucro_pct') || '%', 'link', '/dre');
  end if;
  if (a ->> 'equilibrio') is not null and (a ->> 'receita')::numeric < (a ->> 'equilibrio')::numeric * 1.10 then
    v_dec := v_dec || jsonb_build_object('tom', 'amber', 'o_que', 'Pouca folga sobre o ponto de equilíbrio',
      'detalhe', 'último mês fechado: receita ' || round(100 * ((a ->> 'receita')::numeric / (a ->> 'equilibrio')::numeric - 1)) || '% acima do equilíbrio', 'link', '/dre');
  end if;
  if v_estoque > 0 and v_parado / v_estoque >= 0.30 then
    v_dec := v_dec || jsonb_build_object('tom', 'amber', 'o_que', 'Dinheiro parado em estoque',
      'detalhe', round(100 * v_parado / v_estoque) || '% do estoque sem giro ou em excesso', 'valor', v_parado, 'link', '/ia/anuncios?ver=produtos&giro=parado');
  end if;

  return jsonb_build_object(
    'gerado_em', now(), 'hoje', v_hoje,
    'meses', v_meses,
    'mes_atual', jsonb_build_object('mes', f ->> 'mes', 'dia', v_dia, 'dias_mes', v_dias_mes, 'receita_projetada', v_proj),
    'capital', jsonb_build_object(
      'caixa', round(v_caixa, 2), 'carteiras', round(v_carteiras, 2), 'mercado_pago', round(coalesce(v_mp, 0), 2),
      'mercado_pago_dia', v_mp_dia, 'mercado_pago_por', v_mp_por, 'caixa_por', v_pos #> '{caixa,por}',
      'receber', round(v_receber, 2), 'receber_por', v_pos #> '{receber,por}',
      'estoque', round(v_estoque, 2), 'estoque_parado', round(v_parado, 2),
      'estoque_galpao', (v_est ->> 'valor_geral')::numeric, 'estoque_full', (v_est ->> 'valor_full')::numeric,
      'pagar', round(v_pagar, 2), 'pagar_mercadoria', round(v_pagar_merc, 2), 'pagar_30d', round(v_pagar30, 2),
      'pagar_atrasado', round(v_atras, 2),
      'giro', round(v_caixa + v_receber + v_estoque - v_pagar, 2),
      'sem_bancos', true),
    'ciclo', jsonb_build_object('estoque_dias', v_pme, 'receber_dias', v_pmr, 'pagar_dias', v_pmp,
      'ciclo_dias', v_pme + v_pmr - v_pmp,
      'cmv_dia', round(v_cmv30 / 30), 'venda_dia', round(v_venda30 / 30), 'repasse_dia', round(v_receb30 / 30),
      'compras_dia', round(v_compras90 / 90)),
    'liquidez', jsonb_build_object('sem_estoque', v_liq, 'com_estoque', v_liq_est),
    'pagar', jsonb_build_object('por_categoria', v_cat, 'por_faixa', v_faixa),
    'fluxo', v_pos -> 'fluxo',
    'decisoes', v_dec
  );
end;
$$;

revoke all on function public.financeiro_painel() from public, anon;
grant execute on function public.financeiro_painel() to authenticated, service_role;
