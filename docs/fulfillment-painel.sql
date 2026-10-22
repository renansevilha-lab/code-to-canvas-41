-- ============================================================================
-- Fulfillment › cabeçalho + faixa "Pede ação" (design "Fulfillment" do Claude Design, 22/out/2026).
-- Uma chamada para o topo da aba: de quando são os dados dos CDs, as contas (empresa × marketplace)
-- com os números delas, os contadores das abas e a faixa "Pede ação". Filtro de empresa
-- ('ACZ Pet' | 'SVL Store' | null = as duas) e de marketplace ('amazon' | 'mercadolivre' | 'shopee' |
-- null) — o mesmo filtro global da tela. Envio sem empresa (null) conta como ACZ Pet, como na
-- view_reposicao_full. Cada parte tem exception própria ({"erro": ...}) e falha sozinha.
--   · cds         = última leitura de estoque_fulfillment por conta (lojas: shop_id → empresa);
--   · contas      = por conta: anúncios no CD, com sugestão de envio, zerados que vendem, inutilizáveis;
--   · abas        = envios abertos, SKUs com sugestão, anúncios no CD, tarefas abertas;
--   · acao        = coleta hoje/vencida não enviada · enviado sem estoque lançado no Tiny (com algo
--                   embalado — a mesma regra do "Lançar estoque dos enviados") · plano da Amazon com
--                   erro (sem plano mais novo da mesma empresa) ou parado no meio há > 1 h · zerados
--                   no CD que vendem (view_reposicao_full: estoque_full <= 0 e und_dia > 0) ·
--                   inutilizáveis no CD · tarefas atrasadas (prazo < hoje, abertas, não arquivadas).
-- Recebimento da Amazon com falta NÃO entra: só existe lido ao vivo na tela do envio.
-- Rollback: drop function public.fulfillment_painel(text, text);
-- ============================================================================

create or replace function public.fulfillment_painel(p_emp text default null, p_mkt text default null)
returns jsonb
language plpgsql stable
security invoker
set search_path = public
as $$
declare
  r jsonb := jsonb_build_object('gerado_em', now());
  v jsonb;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- contas, frescor dos CDs e números por conta
  begin
    with contas as (
      select l.shop_id, l.empresa, l.nome,
             case when l.nome ilike 'Amazon%' then 'amazon' when l.nome ilike 'Mercado Livre%' then 'mercadolivre'
                  when l.nome ilike 'Shopee%' then 'shopee' end as mkt
      from lojas l
      where l.nome ilike any (array['Amazon%','Mercado Livre%','Shopee%'])
    ),
    estq as (
      select ef.shop_id, ef.marketplace, count(distinct ef.sku_marketplace) anuncios,
             sum(coalesce(ef.unsellable,0)) inutil, max(ef.atualizado_em) em
      from estoque_fulfillment ef group by 1, 2
    ),
    rep as (
      select rf.shop_id, rf.marketplace,
             count(*) filter (where rf.sugestao_envio > 0) com_sugestao,
             coalesce(sum(rf.sugestao_envio) filter (where rf.sugestao_envio > 0), 0) un_sugeridas,
             count(*) filter (where coalesce(rf.estoque_full,0) <= 0 and rf.und_dia > 0) zerados
      from view_reposicao_full rf group by 1, 2
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'shop_id', c.shop_id::text, 'empresa', c.empresa, 'marketplace', c.mkt, 'nome', c.nome,
             'anuncios', coalesce(e.anuncios,0), 'inutil', coalesce(e.inutil,0), 'atualizado_em', e.em,
             'com_sugestao', coalesce(p.com_sugestao,0), 'un_sugeridas', coalesce(p.un_sugeridas,0),
             'zerados', coalesce(p.zerados,0),
             'no_filtro', (p_emp is null or c.empresa = p_emp) and (p_mkt is null or c.mkt = p_mkt))
           order by c.empresa, c.mkt), '[]'::jsonb)
      into v
      from contas c
      left join estq e on e.shop_id = c.shop_id and e.marketplace = c.mkt
      left join rep p on p.shop_id = c.shop_id and p.marketplace = c.mkt;
    r := r || jsonb_build_object('contas', v);
  exception when others then
    r := r || jsonb_build_object('contas', jsonb_build_object('erro', sqlerrm));
  end;

  -- envios: coleta vencida/hoje e enviados sem estoque no Tiny
  begin
    with env as (
      select e.id, e.numero, e.marketplace, coalesce(e.empresa, 'ACZ Pet') empresa, e.status,
             e.data_envio_agendada, e.estoque_lancado_em, e.atualizado_em,
             coalesce((select sum(i.qtd_separada) from fulfillment_envio_itens i where i.envio_id = e.id), 0) sep,
             coalesce((select sum(i.qtd_planejada) from fulfillment_envio_itens i where i.envio_id = e.id), e.total_unidades, 0) plan
      from fulfillment_envios e
      where e.arquivado_em is null
        and (p_emp is null or coalesce(e.empresa, 'ACZ Pet') = p_emp)
        and (p_mkt is null or e.marketplace = p_mkt)
    )
    select jsonb_build_object(
      'abertos', (select count(*) from env where status <> 'enviado'),
      'un_abertas', (select coalesce(sum(plan),0) from env where status <> 'enviado'),
      'enviados_30d', (select count(*) from fulfillment_envios e where e.status = 'enviado'
                         and e.atualizado_em > now() - interval '30 days'
                         and (p_emp is null or coalesce(e.empresa, 'ACZ Pet') = p_emp)
                         and (p_mkt is null or e.marketplace = p_mkt)),
      'coleta', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'marketplace', marketplace,
                    'empresa', empresa, 'status', status, 'data', data_envio_agendada) order by data_envio_agendada), '[]'::jsonb)
                 from env where status <> 'enviado' and data_envio_agendada <= hoje),
      'sem_tiny', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'numero', numero, 'marketplace', marketplace,
                    'empresa', empresa, 'sep', sep) order by atualizado_em), '[]'::jsonb)
                   from env where status = 'enviado' and estoque_lancado_em is null and sep > 0)
    ) into v;
    r := r || jsonb_build_object('envios', v);
  exception when others then
    r := r || jsonb_build_object('envios', jsonb_build_object('erro', sqlerrm));
  end;

  -- planos da Amazon com erro (sem plano mais novo da mesma empresa) ou parados no meio
  begin
    if p_mkt is null or p_mkt = 'amazon' then
      select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'empresa', p.empresa, 'passo', p.passo,
               'criado_em', p.criado_em, 'atualizado_em', p.atualizado_em, 'erro', left(p.erro::text, 200),
               'tipo', case when p.passo = 'erro' then 'erro' else 'parado' end) order by p.criado_em desc), '[]'::jsonb)
        into v
        from amazon_envio_plano p
        where p.criado_em > now() - interval '14 days'
          and (p_emp is null or p.empresa = p_emp)
          and (
            (p.passo = 'erro' and not exists (select 1 from amazon_envio_plano q
                                              where q.empresa = p.empresa and q.criado_em > p.criado_em))
            or (p.passo not in ('erro', 'cancelado', 'transporte_confirmado') and p.atualizado_em < now() - interval '1 hour')
          );
    else
      v := '[]'::jsonb;
    end if;
    r := r || jsonb_build_object('planos', v);
  exception when others then
    r := r || jsonb_build_object('planos', jsonb_build_object('erro', sqlerrm));
  end;

  -- zerados no CD que vendem (os 3 que mais vendem, para o contexto)
  begin
    with z as (
      select rf.sku, rf.produto, rf.marketplace, rf.empresa, rf.und_dia,
             coalesce(rf.em_transito,0) + coalesce(rf.em_envio_aberto,0) a_caminho
      from view_reposicao_full rf
      where coalesce(rf.estoque_full,0) <= 0 and rf.und_dia > 0
        and (p_emp is null or rf.empresa = p_emp)
        and (p_mkt is null or rf.marketplace = p_mkt)
    )
    select jsonb_build_object(
      'total', (select count(*) from z),
      'a_caminho', (select count(*) from z where a_caminho > 0),
      'und_dia', (select round(coalesce(sum(und_dia),0), 1) from z),
      'top', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (
                select sku, produto, marketplace, empresa, round(und_dia, 1) und_dia from z order by und_dia desc limit 3) t)
    ) into v;
    r := r || jsonb_build_object('zerados', v);
  exception when others then
    r := r || jsonb_build_object('zerados', jsonb_build_object('erro', sqlerrm));
  end;

  -- tarefas abertas e atrasadas
  begin
    select jsonb_build_object(
      'abertas', count(*),
      'atrasadas', coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'titulo', t.titulo, 'responsavel', t.responsavel,
                     'prazo', t.prazo) order by t.prazo) filter (where t.prazo < hoje), '[]'::jsonb)
    ) into v
    from fulfillment_tarefas t
    where t.status <> 'feito' and t.arquivado_em is null;
    r := r || jsonb_build_object('tarefas', v);
  exception when others then
    r := r || jsonb_build_object('tarefas', jsonb_build_object('erro', sqlerrm));
  end;

  return r;
end;
$$;

revoke all on function public.fulfillment_painel(text, text) from anon, public;
grant execute on function public.fulfillment_painel(text, text) to authenticated, service_role;
