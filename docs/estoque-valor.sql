-- ============================================================================
-- Valor em estoque a custo (21/out/2026, pedido do dono — Dashboard "Posição da empresa")
--
-- Uma linha por produto FÍSICO (simples/variação; kit e pai de variação não têm estoque próprio):
--   · depósito da empresa = saldo do depósito Geral do Tiny (estoque_tiny, lido de manhã) e,
--     para quem não está na lista do estoque_tiny, o estoque do cadastro (produtos.estoque,
--     relido em ~28 h; pode incluir o depósito "Amazon Fullfilment" do Tiny);
--   · Fulls = estoque_fulfillment (o que a Amazon, o ML e a Shopee dizem ter no CD:
--     disponível + reservado; a caminho à parte), com kit aberto nos componentes;
--   · NÃO usa os depósitos Full do Tiny (ML/Shopee vêm negativos e marcados desconsiderar;
--     o da Amazon não bate com a Amazon);
--   · custo = produtos.custo (> 0; sem custo = fica fora do valor e é contado à parte);
--   · venda 30 dias e receita = mesma regra da vendas_por_sku (pedidos_validos: Shopee + ML + Amazon,
--     kit aberto nos componentes, receita rateada pelo custo), escrita aqui;
--   · situação = a do agente de compras (ads_cobertura_sku) quando ele classifica o SKU; senão a
--     mesma regra aqui: sem giro = tem estoque e vendeu 0 em 30 dias; excesso = cobertura > 120 dias.
-- Matview porque a venda de 30 dias com kit aberto custa ~3–4 s. Refresh 2x/dia, depois do estoque dos Fulls (cron).
-- Leitura pela função dashboard_estoque_valor() (resumo pronto, jsonb).
-- Rollback: drop function dashboard_estoque_valor(); drop materialized view mv_estoque_valor;
--           select cron.unschedule('estoque-valor-refresh');
-- ============================================================================

create materialized view public.mv_estoque_valor as
with hoje as (select (now() at time zone 'America/Sao_Paulo')::date d),
geral_tiny as (
  select distinct on (sku) sku, saldo, atualizado_em
  from public.estoque_tiny where deposito ilike 'geral%'
  order by sku, atualizado_em desc
),
full_raw as (
  select ef.marketplace, ef.sku,
         coalesce(ef.sellable,0) + coalesce(ef.reserved,0) as no_cd,
         coalesce(ef.in_transit,0) as transito,
         ef.atualizado_em
  from public.estoque_fulfillment ef
),
full_fis as (
  select coalesce(pk.sku_componente, f.sku) as sku, f.marketplace,
         f.no_cd * coalesce(pk.quantidade,1) as no_cd,
         f.transito * coalesce(pk.quantidade,1) as transito,
         f.atualizado_em
  from full_raw f
  left join public.produtos pf on pf.sku = f.sku
  left join public.produto_kits pk on pf.tipo = 'K' and pk.sku_kit = f.sku
),
full_sku as (
  select sku,
         sum(no_cd) filter (where marketplace = 'amazon') as full_amazon,
         sum(no_cd) filter (where marketplace = 'mercadolivre') as full_ml,
         sum(no_cd) filter (where marketplace = 'shopee') as full_shopee,
         sum(transito) as full_transito,
         max(atualizado_em) as full_em
  from full_fis group by sku
),
-- vendas 30 dias por produto físico: a mesma regra da vendas_por_sku (pedidos_validos, kit
-- aberto nos componentes, receita rateada pelo custo), escrita aqui com nomes completos porque
-- a vendas_por_sku não fixa search_path e falha no refresh pelo cron.
itens as (
  select coalesce(nullif(pi.sku_filho,''), pi.sku_pai) as sv, pi.quantidade as q, pi.subtotal_produto as s, pr.tipo
  from hoje, public.pedidos_validos pv
  join public.pedido_itens pi on pi.pedido_id = pv.id
  left join public.produtos pr on pr.sku = coalesce(nullif(pi.sku_filho,''), pi.sku_pai)
  where (pv.data_pedido at time zone 'America/Sao_Paulo')::date between hoje.d - 30 and hoje.d - 1
),
kit_peso as (
  select pk.sku_kit, pk.sku_componente, pk.quantidade as qtd_comp,
         case when sum(pk.quantidade * coalesce(c.custo,0)) over w > 0
              then (pk.quantidade * coalesce(c.custo,0)) / sum(pk.quantidade * coalesce(c.custo,0)) over w
              else pk.quantidade::numeric / nullif(sum(pk.quantidade) over w, 0) end as peso
  from public.produto_kits pk
  left join public.produtos c on c.sku = pk.sku_componente
  window w as (partition by pk.sku_kit)
),
vendas as (
  select sku, sum(un) as un30, sum(rec) as rec30 from (
    select i.sv as sku, i.q as un, i.s as rec from itens i
    where not (i.tipo = 'K' and exists (select 1 from kit_peso k where k.sku_kit = i.sv))
    union all
    select kp.sku_componente, i.q * kp.qtd_comp, i.s * kp.peso
    from itens i join kit_peso kp on kp.sku_kit = i.sv
    where i.tipo = 'K'
  ) e group by sku
),
base as (
  select p.sku, p.nome, p.marca, p.ativo,
         case when p.custo > 0 then p.custo end as custo,
         greatest(coalesce(g.saldo, p.estoque, 0), 0) as geral,
         case when g.sku is not null then 'estoque_tiny' when p.estoque is not null then 'cadastro' end as geral_fonte,
         coalesce(g.atualizado_em, p.estoque_atualizado_em) as geral_em,
         greatest(coalesce(f.full_amazon,0),0) as full_amazon,
         greatest(coalesce(f.full_ml,0),0) as full_ml,
         greatest(coalesce(f.full_shopee,0),0) as full_shopee,
         greatest(coalesce(f.full_transito,0),0) as full_transito,
         f.full_em,
         coalesce(v.un30,0) as un30, coalesce(v.rec30,0) as rec30,
         c.status as status_compras, c.cobertura_com_oc_dias
  from public.produtos p
  left join geral_tiny g on g.sku = p.sku
  left join full_sku f on f.sku = p.sku
  left join vendas v on v.sku = p.sku
  left join public.ads_cobertura_sku c on c.sku = p.sku
  where coalesce(p.tipo,'S') = 'S'
),
tot as (
  select b.*, b.geral + b.full_amazon + b.full_ml + b.full_shopee + b.full_transito as estoque_total from base b
)
select t.*,
       round(t.geral * t.custo, 2) as valor_geral,
       round((t.estoque_total - t.geral) * t.custo, 2) as valor_full,
       round(t.estoque_total * t.custo, 2) as valor_total,
       round(t.un30 / 30.0, 2) as venda_dia,
       case when t.un30 > 0 then round(t.rec30 / t.un30, 2) end as preco_medio,
       case when t.un30 > 0 then round(t.estoque_total / (t.un30 / 30.0), 0) end as cobertura_dias,
       case
         when t.status_compras is not null and t.status_compras <> 'estoque_nao_sincronizado' then t.status_compras
         when t.estoque_total <= 0 then case when t.un30 > 0 then 'ruptura_empresa' else 'sem_venda' end
         when t.un30 = 0 then 'sem_giro'
         when t.estoque_total / (t.un30 / 30.0) > 120 then 'excesso'
         else 'ok'
       end as situacao,
       (t.status_compras is not null and t.status_compras <> 'estoque_nao_sincronizado') as situacao_do_agente,
       now() as calculado_em
from tot t
where t.estoque_total > 0 or t.un30 > 0;

create unique index mv_estoque_valor_sku on public.mv_estoque_valor (sku);
revoke all on public.mv_estoque_valor from anon, public;
grant select on public.mv_estoque_valor to authenticated, service_role;

-- Resumo pronto para o Dashboard
create or replace function public.dashboard_estoque_valor()
returns jsonb
language sql stable
set search_path = public
as $$
  with m as (select * from mv_estoque_valor),
  sem_map as (
    select coalesce(sum(coalesce(ef.sellable,0)+coalesce(ef.reserved,0)+coalesce(ef.in_transit,0)),0) un, count(*) n
    from estoque_fulfillment ef
    left join produtos p on p.sku = ef.sku
    where ef.sku is null or p.sku is null
       or (p.tipo = 'K' and not exists (select 1 from produto_kits k where k.sku_kit = ef.sku))
  )
  select jsonb_build_object(
    'valor_total', round(coalesce(sum(valor_total),0)),
    'valor_geral', round(coalesce(sum(valor_geral),0)),
    'valor_full', round(coalesce(sum(valor_full),0)),
    'full', jsonb_build_object(
       'amazon', round(coalesce(sum(full_amazon*custo),0)),
       'mercado_livre', round(coalesce(sum(full_ml*custo),0)),
       'shopee', round(coalesce(sum(full_shopee*custo),0)),
       'a_caminho', round(coalesce(sum(full_transito*custo),0))),
    'produtos_com_estoque', count(*) filter (where estoque_total > 0),
    'unidades', round(coalesce(sum(estoque_total),0)),
    'sem_custo', jsonb_build_object('produtos', count(*) filter (where estoque_total > 0 and custo is null),
                                    'unidades', round(coalesce(sum(estoque_total) filter (where custo is null),0))),
    'fulls_sem_cadastro', (select jsonb_build_object('linhas', n, 'unidades', round(un)) from sem_map),
    'geral_do_cadastro', count(*) filter (where geral > 0 and geral_fonte = 'cadastro'),
    'parado', jsonb_build_object(
       'valor', round(coalesce(sum(valor_total) filter (where situacao in ('excesso','sem_giro')),0)),
       'excesso', jsonb_build_object('valor', round(coalesce(sum(valor_total) filter (where situacao = 'excesso'),0)),
                                      'produtos', count(*) filter (where situacao = 'excesso')),
       'sem_giro', jsonb_build_object('valor', round(coalesce(sum(valor_total) filter (where situacao = 'sem_giro'),0)),
                                       'produtos', count(*) filter (where situacao = 'sem_giro'))),
    'ruptura', jsonb_build_object(
       'comprar_urgente', count(*) filter (where situacao = 'comprar_urgente'),
       'ruptura_empresa', count(*) filter (where situacao = 'ruptura_empresa'),
       'unidades_dia', round(coalesce(sum(venda_dia) filter (where situacao in ('ruptura_empresa','comprar_urgente')),0), 1),
       'receita_dia', round(coalesce(sum(venda_dia * preco_medio) filter (where situacao in ('ruptura_empresa','comprar_urgente')),0))),
    'cobertura_media_dias', round(sum(valor_total) filter (where custo is not null)
                                  / nullif(sum(venda_dia * custo) filter (where custo is not null), 0)),
    'presos', (select coalesce(jsonb_agg(x order by x.valor desc), '[]'::jsonb) from (
        select sku, nome, situacao, cobertura_dias, round(valor_total) as valor
        from m where situacao in ('excesso','sem_giro') and valor_total > 0
        order by valor_total desc limit 5) x),
    'atualizado', jsonb_build_object(
       'calculado_em', max(calculado_em),
       'geral_em', max(geral_em) filter (where geral_fonte = 'estoque_tiny'),
       'full_em', max(full_em))
  ) from m;
$$;
revoke all on function public.dashboard_estoque_valor() from anon, public;
grant execute on function public.dashboard_estoque_valor() to authenticated, service_role;

-- Refresh 2x/dia, depois do estoque dos Fulls (08h–08h35 e 18h–18h35 BRT)
select cron.schedule('estoque-valor-refresh', '52 11,21 * * *',
  $c$refresh materialized view concurrently public.mv_estoque_valor$c$);
