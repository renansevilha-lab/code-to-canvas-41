-- ============================================================================
-- Dashboard › "Posição da empresa" (21/out/2026, design "Visão geral" do Claude Design)
--
-- 1) mv_carteira_saldo: retrato da view_carteira_saldo (saldo nas carteiras + a receber por
--    carteira). A view custa ~4 s (a receber da Shopee aloca resgates por pedido); a matview é
--    relida de hora em hora (cron carteira-saldo-refresh, minuto 17).
-- 2) dashboard_posicao_empresa(): jsonb com caixa, a receber, contas a pagar (30 dias) e o
--    fluxo de caixa dos próximos 30 dias (saldo = caixa de hoje + acumulado da projeção, a
--    MESMA conta da tela /fluxo-caixa). Cada bloco tem seu próprio tratamento de erro: um bloco
--    que falha volta {"erro": "..."} e os outros seguem.
-- 3) dashboard_pede_decisao(): lista de alertas de NEGÓCIO por gravidade (r = perde dinheiro
--    agora, a = perde se ninguém agir, n = informativo). Só entra o que tem problema.
--    Valores em número; o front formata.
-- Rollback: drop function dashboard_pede_decisao(); drop function dashboard_posicao_empresa();
--           drop materialized view mv_carteira_saldo; select cron.unschedule('carteira-saldo-refresh');
-- ============================================================================

create materialized view public.mv_carteira_saldo as
select v.*, now() as calculado_em from public.view_carteira_saldo v;
create unique index mv_carteira_saldo_carteira on public.mv_carteira_saldo (carteira);
revoke all on public.mv_carteira_saldo from anon, public;
grant select on public.mv_carteira_saldo to authenticated, service_role;

create or replace function public.dashboard_posicao_empresa()
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  r jsonb := '{}'::jsonb;
  v_caixa numeric;
  b jsonb;
begin
  -- caixa (saldo em conta) e a receber, do retrato da carteira
  begin
    select jsonb_build_object(
             'valor', round(coalesce(sum(saldo_em_conta),0), 2),
             'por', jsonb_agg(jsonb_build_object('carteira', carteira, 'marketplace', marketplace,
                     'valor', round(saldo_em_conta, 2), 'saldo_em', saldo_em) order by carteira),
             'atualizado_em', max(calculado_em)),
           coalesce(sum(saldo_em_conta),0)
      into b, v_caixa
      from mv_carteira_saldo;
    r := r || jsonb_build_object('caixa', b);
    select jsonb_build_object(
             'valor', round(coalesce(sum(a_receber_estimado),0), 2),
             'por', jsonb_agg(jsonb_build_object('carteira', carteira, 'marketplace', marketplace,
                     'valor', round(a_receber_estimado, 2), 'pedidos', pedidos_a_receber,
                     'estimado', marketplace = 'shopee') order by a_receber_estimado desc),
             'atualizado_em', max(calculado_em))
      into b from mv_carteira_saldo;
    r := r || jsonb_build_object('receber', b);
  exception when others then
    r := r || jsonb_build_object('caixa', jsonb_build_object('erro', sqlerrm),
                                 'receber', jsonb_build_object('erro', sqlerrm));
  end;

  -- contas a pagar (espelho do Tiny, só abertas)
  begin
    select jsonb_build_object(
             'atrasado', jsonb_build_object('valor', round(coalesce(sum(saldo_aberto) filter (where dias_para_vencer < 0),0), 2),
                                            'contas', count(*) filter (where dias_para_vencer < 0)),
             'hoje', jsonb_build_object('valor', round(coalesce(sum(saldo_aberto) filter (where dias_para_vencer = 0),0), 2),
                                        'contas', count(*) filter (where dias_para_vencer = 0)),
             'd7', jsonb_build_object('valor', round(coalesce(sum(saldo_aberto) filter (where dias_para_vencer between 0 and 7),0), 2),
                                      'contas', count(*) filter (where dias_para_vencer between 0 and 7)),
             'd30', jsonb_build_object('valor', round(coalesce(sum(saldo_aberto) filter (where dias_para_vencer between 0 and 30),0), 2),
                                       'contas', count(*) filter (where dias_para_vencer between 0 and 30)),
             'ate', hoje + 30,
             'atualizado_em', max(atualizado_em))
      into b from view_fin_contas_pagar;
    r := r || jsonb_build_object('pagar', b);
  exception when others then
    r := r || jsonb_build_object('pagar', jsonb_build_object('erro', sqlerrm));
  end;

  -- fluxo de caixa dos próximos 30 dias (projeção da /fluxo-caixa)
  begin
    with d as (
      select dia, coalesce(entradas,0) e, coalesce(saidas,0) s,
             coalesce(v_caixa,0) + acumulado as saldo
      from view_fluxo_caixa_diario
      where dia between hoje and hoje + 30
    )
    select jsonb_build_object(
             'saldo_inicial', round(coalesce(v_caixa,0), 2),
             'entradas', round(sum(e), 2),
             'saidas', round(sum(s), 2),
             'saldo_final', (select round(saldo, 2) from d order by dia desc limit 1),
             'dia_final', max(dia),
             'pior', (select jsonb_build_object('dia', dia, 'saldo', round(saldo, 2)) from d order by saldo, dia limit 1),
             'maior_saida', (select jsonb_build_object('dia', dia, 'valor', round(s, 2)) from d order by s desc, dia limit 1),
             'dias', jsonb_agg(jsonb_build_object('dia', dia, 'entradas', round(e, 2), 'saidas', round(s, 2), 'saldo', round(saldo, 2)) order by dia),
             'atualizado_em', (select max(atualizado_em) from view_fluxo_caixa_eventos))
      into b from d;
    r := r || jsonb_build_object('fluxo', b);
  exception when others then
    r := r || jsonb_build_object('fluxo', jsonb_build_object('erro', sqlerrm));
  end;

  return r || jsonb_build_object('gerado_em', now());
end;
$$;
revoke all on function public.dashboard_posicao_empresa() from anon, public;
grant execute on function public.dashboard_posicao_empresa() to authenticated, service_role;

create or replace function public.dashboard_pede_decisao()
returns jsonb
language plpgsql stable
set search_path = public
as $$
declare
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  itens jsonb := '[]'::jsonb;
  erros jsonb := '[]'::jsonb;
  v_valor numeric; v_n int; v_dia date; v_caixa numeric;
  j jsonb;
  m record;
begin
  -- contas atrasadas
  begin
    select coalesce(sum(saldo_aberto),0), count(*) into v_valor, v_n
      from view_fin_contas_pagar where dias_para_vencer < 0;
    if v_n > 0 then
      itens := itens || jsonb_build_object('id','contas_atrasadas','sev','r','valor',round(v_valor,2),
        'label','Contas atrasadas','contas',v_n,'link','/contas-pagar');
    end if;
  exception when others then erros := erros || to_jsonb('contas: ' || sqlerrm); end;

  -- caixa projetado negativo nos próximos 30 dias
  begin
    select coalesce(sum(saldo_em_conta),0) into v_caixa from mv_carteira_saldo;
    select v_caixa + acumulado, dia into v_valor, v_dia
      from view_fluxo_caixa_diario where dia between hoje and hoje + 30
      order by acumulado, dia limit 1;
    if v_valor < 0 then
      itens := itens || jsonb_build_object('id','caixa_negativo','sev','r','valor',round(v_valor,2),
        'label','Caixa projetado negativo','dia',v_dia,'link','/fluxo-caixa','estimado',true);
    end if;
  exception when others then erros := erros || to_jsonb('fluxo: ' || sqlerrm); end;

  -- ADS no prejuízo ontem (margem pós-ADS negativa por loja)
  begin
    select jsonb_agg(jsonb_build_object('canal', canal, 'marketplace', marketplace, 'margem_pos_ads', round(margem_pos_ads,2),
              'gasto', round(gasto,2), 'roas', round(roas,2),
              'margem_7d', (select round(sum(x.margem_pos_ads),2) from ads_metrica_loja_dia x
                             where x.marketplace = a.marketplace and x.shop_id = a.shop_id
                               and x.data between hoje - 7 and hoje - 1)) order by margem_pos_ads),
           sum(margem_pos_ads), bool_or(provisorio)
      into j, v_valor
      from ads_metrica_loja_dia a
     where data = hoje - 1 and margem_pos_ads < 0;
    if j is not null then
      itens := itens || jsonb_build_object('id','ads_prejuizo','sev','r','valor',round(v_valor,2),
        'label','ADS no prejuízo','lojas',j,'dia',hoje - 1,'estimado',true,
        'link', case when j->0->>'marketplace' = 'mercadolivre' then '/ads-ml' else '/ads-shopee' end);
    end if;
  exception when others then erros := erros || to_jsonb('ads: ' || sqlerrm); end;

  -- estoque: ruptura (venda em risco) e dinheiro parado
  begin
    j := dashboard_estoque_valor();
    if coalesce((j->'ruptura'->>'receita_dia')::numeric, 0) > 0 then
      itens := itens || jsonb_build_object('id','ruptura','sev','r','valor',(j->'ruptura'->>'receita_dia')::numeric,
        'label','Venda em risco por ruptura','unidades_dia',(j->'ruptura'->>'unidades_dia')::numeric,
        'comprar_urgente',(j->'ruptura'->>'comprar_urgente')::int,'ruptura_empresa',(j->'ruptura'->>'ruptura_empresa')::int,
        'link','/compras','estimado',true);
    end if;
    if coalesce((j->'parado'->>'valor')::numeric, 0) > 0 then
      itens := itens || jsonb_build_object('id','parado','sev','a','valor',(j->'parado'->>'valor')::numeric,
        'label','Dinheiro parado em estoque','excesso',(j->'parado'->'excesso'->>'valor')::numeric,
        'sem_giro',(j->'parado'->'sem_giro'->>'valor')::numeric,'link','/compras');
    end if;
  exception when others then erros := erros || to_jsonb('estoque: ' || sqlerrm); end;

  -- meta do mês e ACOS (todos os canais)
  begin
    select * into m from view_metas_realizado
     where marketplace = 'todos' and competencia = date_trunc('month', hoje)::date;
    if found then
      if m.meta_receita > 0 and coalesce(m.projecao_pct_meta, 0) < 100 then
        itens := itens || jsonb_build_object('id','meta','sev','a','valor',m.projecao_pct_meta,
          'label','Meta do mês em risco','projecao',m.projecao_receita,'meta',m.meta_receita,
          'realizado',m.receita_realizada,
          'falta_dia', case when m.dias_no_mes > m.dias_decorridos
                            then round((m.meta_receita - m.receita_realizada) / (m.dias_no_mes - m.dias_decorridos), 2) end,
          'link','/metas','estimado',true);
      end if;
      if m.meta_acos is not null and coalesce(m.acos_estourou, false) then
        itens := itens || jsonb_build_object('id','acos','sev','a','valor',m.acos_realizado,
          'label','ACOS acima da meta','meta',m.meta_acos,'link','/ads-shopee');
      end if;
    end if;
  exception when others then erros := erros || to_jsonb('metas: ' || sqlerrm); end;

  -- receita sem custo apurado
  begin
    select count(*), coalesce(sum(receita),0) into v_n, v_valor from mv_anomalias where tipo = 'sku_sem_custo';
    if v_n > 0 then
      itens := itens || jsonb_build_object('id','sem_custo','sev','n','valor',round(v_valor,2),
        'label','Receita sem custo apurado','produtos',v_n,'link','/anomalias');
    end if;
  exception when others then erros := erros || to_jsonb('anomalias: ' || sqlerrm); end;

  return jsonb_build_object(
    'itens', (select coalesce(jsonb_agg(e order by case e->>'sev' when 'r' then 1 when 'a' then 2 else 3 end, o), '[]'::jsonb)
                from jsonb_array_elements(itens) with ordinality as t(e, o)),
    'erros', erros,
    'gerado_em', now());
end;
$$;
revoke all on function public.dashboard_pede_decisao() from anon, public;
grant execute on function public.dashboard_pede_decisao() to authenticated, service_role;

select cron.schedule('carteira-saldo-refresh', '17 * * * *',
  $c$refresh materialized view concurrently public.mv_carteira_saldo$c$);
