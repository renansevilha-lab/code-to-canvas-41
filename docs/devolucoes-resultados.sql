-- ============================================================================
-- Devoluções — aba RESULTADOS (29/out/2026, pedido do dono: "aba de resultados,
-- perdas totais e etc"). Migração: devolucoes_reforma_02_resultados.
--
-- view_devolucao_erros = UMA linha por caso (Shopee: view_shopee_reembolsos —
-- devolução, extravio, falha de entrega, TO_RETURN; ML: ml_claims que não são
-- cancelamento de compra) com: data, mês BRT, loja, motivo, classe, SKU, quem
-- separou, CAUSA interna (resposta > entrada no galpão > provável pelo motivo) e
-- o dinheiro: reembolsado ao cliente, descontado de nós, compensado pelo
-- marketplace, CMV, perda líquida (descontado − compensado) e CMV perdido
-- (produto que não voltou e reembolso saiu do nosso bolso).
-- devolucao_resultados(de, ate, empresa) = os agregados da aba (totais, por mês,
-- por grupo/causa, por marketplace, por pessoa com o denominador de pedidos
-- finalizados, por SKU, por motivo). Só leitura. Rollback no fim.
-- ============================================================================

create or replace view public.view_devolucao_erros as
with shopee as (
  select
    'shopee'::text as marketplace,
    case r.shop_id when 522186766 then 'ottz' when 759046323 then 'svl' end as empresa,
    r.shop_id::text as conta,
    coalesce(r.return_sn, r.order_sn) as case_id,
    r.order_sn,
    coalesce(r.devolucao_em, r.data_pedido) as data,
    coalesce(r.motivo_devolucao, r.motivo_cancelamento, r.status_pedido) as motivo,
    r.classe,
    r.texto_comprador as texto_cliente,
    coalesce(r.valor_reembolsado, 0) as valor_reembolsado,
    coalesce(r.descontado_vendedor, 0) as descontado,
    coalesce(r.compensado, 0) as compensado,
    coalesce(r.cmv, 0) as cmv,
    r.produto_recebido_em is not null as produto_voltou,
    -- CMV perdido: reembolso saiu do nosso bolso e o produto não voltou
    -- 03 extraviado, 04 disputa perdida, 09 reembolso sem devolução: o produto não volta.
    -- 06/07 a Shopee bancou/compensou (o dinheiro já cobre); 08 o produto volta (ou está voltando).
    case when r.produto_recebido_em is null and left(r.classe, 2) in ('03','04','09') then coalesce(r.cmv, 0) else 0 end as cmv_perdido,
    (left(r.classe, 2) in ('01','02','11')) as em_aberto,
    r.venda as venda
  from view_shopee_reembolsos r
),
ml as (
  select
    'mercadolivre'::text as marketplace,
    case c.conta when 1107117809 then 'ottz' when 1299638625 then 'svl' end as empresa,
    c.conta::text as conta,
    c.claim_id::text as case_id,
    c.order_id as order_sn,
    c.criado_em as data,
    coalesce(m.nome, c.reason_id) as motivo,
    case
      when c.status = 'opened' then '01 Reclamação aberta'
      when r.favor_cliente and r.cobriu then '06 Reembolsado — ML cobriu'
      when r.favor_cliente and r.voltou then '08 Reembolsado — nós pagamos (produto voltou)'
      when r.favor_cliente then '09 Reembolsado — nós pagamos (sem devolução do produto)'
      when c.resolucao->'benefited' @> '["respondent"]'::jsonb then '05 Decidido a nosso favor'
      else '10 Encerrada sem reembolso' end as classe,
    msg.texto as texto_cliente,
    case when r.favor_cliente then r.reembolso else 0 end as valor_reembolsado,
    case when r.favor_cliente and not r.cobriu then r.reembolso else 0 end as descontado,
    0::numeric as compensado,
    coalesce(p.cmv_total, 0) as cmv,
    r.voltou as produto_voltou,
    case when r.favor_cliente and not r.cobriu and not r.voltou then coalesce(p.cmv_total, 0) else 0 end as cmv_perdido,
    (c.status = 'opened') as em_aberto,
    p.subtotal_produtos as venda
  from ml_claims c
  left join ml_claim_motivos m on m.reason_id = c.reason_id
  left join pedidos p on p.id = c.order_id
  left join lateral (select mm.texto from ml_claim_mensagens mm where mm.claim_id = c.claim_id and mm.de = 'complainant' order by mm.data limit 1) msg on true
  left join lateral (
    select
      coalesce(c.resolucao->'benefited' @> '["complainant"]'::jsonb, false) as favor_cliente,
      coalesce((c.resolucao->>'applied_coverage')::boolean, false) as cobriu,
      coalesce((select sum(-t.valor) from transacoes_carteira t where t.pedido_id = c.order_id and t.classificacao = 'REFUND_MP'), p.subtotal_produtos, 0) as reembolso,
      (coalesce((select bool_or(e.status = 'delivered') from ml_envio_devolucao e where e.claim_id = c.claim_id), false)
        or exists (select 1 from devolucoes_recebidas d where d.order_sn in (c.order_id, c.pack_id))) as voltou
  ) r on true
  where c.tipo <> 'cancel_purchase' and c.order_id is not null
),
u as (select * from shopee union all select * from ml)
select
  u.*,
  (date_trunc('month', u.data at time zone 'America/Sao_Paulo'))::date as mes,
  u.descontado - u.compensado as perda_liquida,
  it.sku, it.nome_produto,
  sep.finalizada_por as separador,
  coalesce(resp.causa, rec.causa_interna, devolucao_causa_provavel(u.marketplace, u.motivo)) as causa,
  case when resp.causa is not null then 'resposta' when rec.causa_interna is not null then 'entrada' else 'provavel' end as causa_origem,
  dc.grupo, dc.nome as causa_nome,
  rec.recebido_em as entrada_em
from u
left join lateral (
  select pi.sku_pai as sku, pi.nome_produto from pedido_itens pi where pi.pedido_id = u.order_sn order by pi.subtotal_produto desc nulls last limit 1) it on true
left join lateral (
  select tl.finalizada_por from separacao_tiny st join tags_lote tl on tl.tag = st.tag_lote
  where st.numero_ecommerce in (u.order_sn, (select pk.pack_id from pedidos pk where pk.id = u.order_sn)) and tl.finalizada_por is not null
  order by tl.finalizada_em desc nulls last limit 1) sep on true
left join lateral (
  select r.causa_interna as causa from devolucao_resposta r
  where r.marketplace = u.marketplace and (r.case_id = u.case_id or r.order_sn = u.order_sn) and r.causa_interna is not null
  order by r.respondido_em desc limit 1) resp on true
left join lateral (
  select d.causa_interna, d.recebido_em from devolucoes_recebidas d
  where d.order_sn = u.order_sn or (u.marketplace = 'mercadolivre' and d.order_sn = (select pk.pack_id from pedidos pk where pk.id = u.order_sn))
  order by d.recebido_em desc limit 1) rec on true
left join devolucao_causa dc on dc.codigo = coalesce(resp.causa, rec.causa_interna, devolucao_causa_provavel(u.marketplace, u.motivo));

revoke all on public.view_devolucao_erros from anon, public;
grant select on public.view_devolucao_erros to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Agregados da aba
-- ---------------------------------------------------------------------------
create or replace function public.devolucao_resultados(p_de date, p_ate date, p_empresa text default 'ambas')
returns jsonb language plpgsql volatile security definer set search_path = public as $$
-- volatile de propósito: cria temp tables (stable não deixa). Só lê.
declare
  v_ini timestamptz := (p_de::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := ((p_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  v_out jsonb;
begin
  if not tem_modulo('devolucoes') and not tem_modulo('financeiro') and not tem_modulo('galpao') then
    raise exception 'sem acesso' using errcode = '42501';
  end if;

  create temp table _casos on commit drop as
    select * from view_devolucao_erros e
    where e.data >= v_ini and e.data < v_fim
      and (p_empresa = 'ambas' or e.empresa = p_empresa);

  create temp table _pedidos on commit drop as
    select (date_trunc('month', p.data_pedido at time zone 'America/Sao_Paulo'))::date as mes,
           p.marketplace, case p.shop_id when 522186766 then 'ottz' when 759046323 then 'svl' when 1107117809 then 'ottz' when 1299638625 then 'svl' when 900001 then 'ottz' when 900002 then 'svl' end as empresa,
           count(*) as n
    from pedidos_validos p
    where p.data_pedido >= v_ini and p.data_pedido < v_fim and p.marketplace in ('shopee','mercadolivre')
    group by 1, 2, 3;

  v_out := jsonb_build_object(
    'periodo', jsonb_build_object('de', p_de, 'ate', p_ate, 'empresa', p_empresa),
    'totais', (select jsonb_build_object(
        'casos', count(*),
        'em_aberto', count(*) filter (where em_aberto),
        'com_perda', count(*) filter (where perda_liquida > 0 or cmv_perdido > 0),
        'reembolsado', round(sum(valor_reembolsado), 2),
        'descontado', round(sum(descontado), 2),
        'compensado', round(sum(compensado), 2),
        'perda_liquida', round(sum(perda_liquida), 2),
        'cmv_perdido', round(sum(cmv_perdido), 2),
        'perda_total', round(sum(perda_liquida) + sum(cmv_perdido), 2),
        'produto_voltou', count(*) filter (where produto_voltou),
        'classificados', count(*) filter (where causa_origem <> 'provavel'),
        'pedidos', (select coalesce(sum(n), 0) from _pedidos where p_empresa = 'ambas' or empresa = p_empresa)
      ) from _casos),
    'por_mes', (select coalesce(jsonb_agg(x order by x.mes), '[]'::jsonb) from (
        select c.mes, count(*) as casos, round(sum(c.perda_liquida), 2) as perda_liquida, round(sum(c.cmv_perdido), 2) as cmv_perdido,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total,
               (select coalesce(sum(n), 0) from _pedidos pp where pp.mes = c.mes and (p_empresa = 'ambas' or pp.empresa = p_empresa)) as pedidos
        from _casos c group by c.mes) x),
    'por_grupo', (select coalesce(jsonb_agg(x order by x.casos desc), '[]'::jsonb) from (
        select coalesce(c.grupo, 'outro') as grupo, count(*) as casos, round(sum(c.perda_liquida), 2) as perda_liquida, round(sum(c.cmv_perdido), 2) as cmv_perdido,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total, count(*) filter (where c.causa_origem <> 'provavel') as classificados
        from _casos c group by 1) x),
    'por_causa', (select coalesce(jsonb_agg(x order by x.casos desc), '[]'::jsonb) from (
        select c.causa, c.causa_nome, coalesce(c.grupo, 'outro') as grupo, count(*) as casos,
               round(sum(c.perda_liquida), 2) as perda_liquida, round(sum(c.cmv_perdido), 2) as cmv_perdido,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total, count(*) filter (where c.causa_origem <> 'provavel') as classificados
        from _casos c group by 1, 2, 3) x),
    'por_marketplace', (select coalesce(jsonb_agg(x order by x.marketplace, x.empresa), '[]'::jsonb) from (
        select c.marketplace, c.empresa, count(*) as casos, round(sum(c.valor_reembolsado), 2) as reembolsado,
               round(sum(c.perda_liquida), 2) as perda_liquida, round(sum(c.cmv_perdido), 2) as cmv_perdido,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total,
               (select coalesce(sum(n), 0) from _pedidos pp where pp.marketplace = c.marketplace and pp.empresa = c.empresa) as pedidos
        from _casos c group by 1, 2) x),
    'por_classe', (select coalesce(jsonb_agg(x order by x.classe), '[]'::jsonb) from (
        select c.marketplace, c.classe, count(*) as casos, round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total
        from _casos c group by 1, 2) x),
    'por_pessoa', (select coalesce(jsonb_agg(x order by x.casos desc), '[]'::jsonb) from (
        select c.separador, count(*) as casos,
               count(*) filter (where c.grupo in ('separacao','embalagem')) as erros_nossos,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total,
               (select coalesce(sum(tl.qtd_pedidos), 0) from tags_lote tl
                 where tl.finalizada_por = c.separador and tl.finalizada_em >= v_ini and tl.finalizada_em < v_fim) as pedidos_finalizados
        from _casos c where c.separador is not null group by 1) x),
    'por_sku', (select coalesce(jsonb_agg(x order by x.perda_total desc, x.casos desc), '[]'::jsonb) from (
        select c.sku, max(c.nome_produto) as nome_produto, (select f.foto from view_foto_produto f where f.sku = c.sku limit 1) as foto,
               count(*) as casos, count(*) filter (where c.grupo = 'embalagem') as embalagem, count(*) filter (where c.grupo = 'separacao') as separacao,
               round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total
        from _casos c where c.sku is not null group by 1 order by 7 desc, 4 desc limit 20) x),
    'por_motivo', (select coalesce(jsonb_agg(x order by x.casos desc), '[]'::jsonb) from (
        select c.marketplace, c.motivo, count(*) as casos, round(sum(c.perda_liquida) + sum(c.cmv_perdido), 2) as perda_total
        from _casos c group by 1, 2 order by 3 desc limit 25) x)
  );
  return v_out;
end $$;

revoke all on function public.devolucao_resultados(date, date, text) from public, anon;
grant execute on function public.devolucao_resultados(date, date, text) to authenticated, service_role;

-- Casos de um recorte (drill da aba): mesmo filtro da RPC + grupo/causa/pessoa/sku opcionais.
create or replace function public.devolucao_resultados_casos(p_de date, p_ate date, p_empresa text default 'ambas', p_grupo text default null, p_causa text default null, p_separador text default null, p_sku text default null, p_limite int default 200)
returns setof public.view_devolucao_erros language sql stable security definer set search_path = public as $$
  select e.* from view_devolucao_erros e
  where (tem_modulo('devolucoes') or tem_modulo('financeiro') or tem_modulo('galpao'))
    and e.data >= (p_de::timestamp at time zone 'America/Sao_Paulo') and e.data < ((p_ate + 1)::timestamp at time zone 'America/Sao_Paulo')
    and (p_empresa = 'ambas' or e.empresa = p_empresa)
    and (p_grupo is null or coalesce(e.grupo, 'outro') = p_grupo)
    and (p_causa is null or e.causa = p_causa)
    and (p_separador is null or e.separador = p_separador)
    and (p_sku is null or e.sku = p_sku)
  order by (e.perda_liquida + e.cmv_perdido) desc, e.data desc
  limit greatest(p_limite, 1);
$$;
revoke all on function public.devolucao_resultados_casos(date, date, text, text, text, text, text, int) from public, anon;
grant execute on function public.devolucao_resultados_casos(date, date, text, text, text, text, text, int) to authenticated, service_role;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- drop function if exists public.devolucao_resultados_casos(date, date, text, text, text, text, text, int);
-- drop function if exists public.devolucao_resultados(date, date, text);
-- drop view if exists public.view_devolucao_erros;
