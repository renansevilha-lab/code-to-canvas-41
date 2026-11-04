-- Produção — estoque do produto acabado pelo NOSSO sistema, não pelo Tiny (04/nov/2026, pedido do dono).
-- Motivo: "O que produzir" lia venda e estoque do retrato do agente de compras, que só cobre produto com
-- fornecedor no Tiny — 15933 e 16640 (fabricados, sem fornecedor) apareciam "—" sendo os que mais vendem.
--
-- Estoque no galpão de cada SKU com ficha de produção =
--     última contagem física (producao_estoque_contagem)
--   + sacos bons dos lotes encerrados depois da contagem
--   − unidades vendidas DO GALPÃO depois da contagem (pedidos válidos Shopee/ML + TikTok; Full/FBA ficam fora;
--     kits abertos pelo produto_kits)
--   − unidades enviadas ao Full (envios "enviado", kits abertos) depois da contagem.
-- Venda 30 dias = todas as vendas (galpão + Full), kits abertos, mesma fonte.
-- O que está no Full vem à parte (estoque_fulfillment: disponível + reservado + a caminho).
-- Contagem: a hora da contagem separa o antes/depois; pedido feito ANTES da contagem e ainda na prateleira
-- seria contado de novo — contar com a fila desses produtos já embalada.

begin;

create table if not exists public.producao_estoque_contagem (
  id bigserial primary key,
  sku text not null,
  qtd integer not null check (qtd >= 0),
  em timestamptz not null default now(),
  por text,
  obs text,
  criado_em timestamptz not null default now()
);
create index if not exists producao_estoque_contagem_sku_em on public.producao_estoque_contagem (sku, em desc);
alter table public.producao_estoque_contagem enable row level security;
revoke all on public.producao_estoque_contagem from anon, public;
grant select, insert, delete on public.producao_estoque_contagem to authenticated;
grant usage on sequence public.producao_estoque_contagem_id_seq to authenticated;
create policy ler on public.producao_estoque_contagem for select to authenticated using (tem_modulo('galpao'));
create policy gravar on public.producao_estoque_contagem for insert to authenticated with check (tem_modulo('galpao'));
create policy apagar on public.producao_estoque_contagem for delete to authenticated using (tem_modulo('galpao'));

-- índice para achar os itens pelo SKU do anúncio (sku_pai) sem varrer pedido_itens
create index if not exists idx_itens_sku_pai on public.pedido_itens (sku_pai);

create or replace function public.producao_estoque_acabado()
returns table (
  sku text, contagem_qtd integer, contagem_em timestamptz, contagem_por text,
  produzido integer, vendido_galpao integer, enviado_full integer, saldo integer,
  venda_30d integer, venda_30d_galpao integer, venda_30d_full integer, full_estoque integer, cobertura_dias numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_skus text[];
begin
  if not tem_modulo('galpao') then raise exception 'sem acesso à produção'; end if;
  -- SKUs que baixam estoque de um fabricado: ele mesmo e os kits que o contêm
  select array_agg(distinct x) into v_skus from (
    select pp.sku as x from producao_parametros pp where pp.ativo
    union select k.sku_kit from produto_kits k join producao_parametros pp on pp.sku = k.sku_componente and pp.ativo) s;
  return query
  with alvo as materialized (select pp.sku from producao_parametros pp where pp.ativo),
  -- SKU vendido → SKU fabricado × quantidade (o próprio, ou o componente de um kit)
  mapa as materialized (
    select a.sku as vendido, a.sku as fab, 1::numeric as fator from alvo a
    union all
    select k.sku_kit, k.sku_componente, k.quantidade from produto_kits k join alvo a on a.sku = k.sku_componente
  ),
  cont as materialized (
    select distinct on (c.sku) c.sku, c.qtd, c.em, c.por from producao_estoque_contagem c
    join alvo a on a.sku = c.sku order by c.sku, c.em desc, c.id desc
  ),
  desde as materialized (select least(coalesce(min(c.em), now()), now() - interval '30 days') as d from cont c),
  -- só os itens desses SKUs (índices por sku_filho e sku_pai), depois o pedido pela PK
  itens as materialized (
    select i.id, i.pedido_id, i.sku_pai, i.sku_filho, i.quantidade from pedido_itens i where i.sku_filho = any(v_skus)
    union
    select i.id, i.pedido_id, i.sku_pai, i.sku_filho, i.quantidade from pedido_itens i where i.sku_pai = any(v_skus)
  ),
  -- vendas unitárias (kit aberto): Shopee / Mercado Livre / Amazon (pedidos válidos) + TikTok (1 linha = 1 un)
  vendas as materialized (
    select m.fab, p.data_pedido as em, (i.quantidade * m.fator)::numeric as un,
           coalesce(p.logistica_tipo in ('fulfillment', 'FBA') or p.marketplace = 'amazon'
            or (p.marketplace = 'shopee' and p.opcao_envio ilike '%full%'), false) as do_full
      from itens i
      join pedidos_validos p on p.id = i.pedido_id
      join mapa m on m.vendido = case when p.marketplace = 'amazon' then i.sku_pai else coalesce(nullif(i.sku_filho, ''), i.sku_pai) end
     where p.data_pedido >= (select d from desde)
    union all
    select m.fab, coalesce(t.pago_em, t.criado_em_tt), m.fator, coalesce(t.fulfillment_type ilike '%platform%', false)
      from tiktok_pedido_itens ti
      join mapa m on m.vendido = ti.sku
      join tiktok_pedidos t on t.id = ti.pedido_id
     where ti.sku = any(v_skus) and coalesce(ti.display_status, '') <> 'CANCELLED' and coalesce(t.status, '') not in ('CANCELLED', 'UNPAID')
       and coalesce(t.pago_em, t.criado_em_tt) >= (select d from desde)
  ),
  envios as materialized (
    -- hora da saída = dia agendado do envio (meio-dia BRT) ou o lançamento, o que vier antes
    select m.fab, least((e.data_envio_agendada + time '12:00') at time zone 'America/Sao_Paulo', coalesce(e.estoque_lancado_em, e.atualizado_em)) as em, (coalesce(ei.qtd_separada, ei.qtd_planejada, 0) * m.fator)::numeric as un
      from fulfillment_envio_itens ei
      join mapa m on m.vendido = ei.sku
      join fulfillment_envios e on e.id = ei.envio_id
     where e.status = 'enviado'
  ),
  lotes as materialized (
    select l.sku, l.fim_em, l.boas from view_producao_lote l where l.status = 'encerrada'
  ),
  -- tudo somado UMA vez por SKU
  v as (
    select a.sku,
      sum(x.un) filter (where x.em >= now() - interval '30 days') as v30,
      sum(x.un) filter (where x.em >= now() - interval '30 days' and not x.do_full) as v30g,
      sum(x.un) filter (where x.em >= now() - interval '30 days' and x.do_full) as v30f,
      sum(x.un) filter (where not x.do_full and x.em > c.em) as vend
    from alvo a left join cont c on c.sku = a.sku join vendas x on x.fab = a.sku group by a.sku
  ),
  en as (select a.sku, sum(x.un) as env from alvo a join cont c on c.sku = a.sku join envios x on x.fab = a.sku and x.em > c.em group by a.sku),
  pr as (select a.sku, sum(x.boas) as prod from alvo a join cont c on c.sku = a.sku join lotes x on x.sku = a.sku and x.fim_em > c.em group by a.sku),
  fu as (
    select f.sku, sum(coalesce(f.sellable, 0) + coalesce(f.reserved, 0) + coalesce(f.in_transit, 0))::int as un
      from estoque_fulfillment f join alvo a on a.sku = f.sku group by f.sku
  ),
  base as (
    select a.sku, c.qtd, c.em, c.por,
      case when c.sku is null then null else coalesce(pr.prod, 0)::int end as prod,
      case when c.sku is null then null else coalesce(v.vend, 0)::int end as vend,
      case when c.sku is null then null else coalesce(en.env, 0)::int end as env,
      case when c.sku is null then null else (c.qtd + coalesce(pr.prod, 0) - coalesce(v.vend, 0) - coalesce(en.env, 0))::int end as saldo,
      coalesce(v.v30, 0)::int as v30, coalesce(v.v30g, 0)::int as v30g, coalesce(v.v30f, 0)::int as v30f,
      coalesce(fu.un, 0) as full_un
    from alvo a
    left join cont c on c.sku = a.sku
    left join v on v.sku = a.sku
    left join en on en.sku = a.sku
    left join pr on pr.sku = a.sku
    left join fu on fu.sku = a.sku
  )
  -- cobertura = (galpão + Full) ÷ venda média por dia dos últimos 30 dias
  select b.*, case when b.saldo is null or b.v30 = 0 then null
                  else round((greatest(b.saldo, 0) + b.full_un) / (b.v30 / 30.0), 1) end
    from base b order by b.sku;
end $$;

revoke all on function public.producao_estoque_acabado() from public, anon;
grant execute on function public.producao_estoque_acabado() to authenticated, service_role;

commit;

-- ROLLBACK:
-- drop function public.producao_estoque_acabado();
-- drop table public.producao_estoque_contagem;
-- drop index public.idx_itens_sku_pai;
