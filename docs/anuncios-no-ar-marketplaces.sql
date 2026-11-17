-- Aba Anúncios — "Anúncios no ar" e "Mudanças" para TODOS os marketplaces (16/nov/2026, pedido do dono: "aplicar o
-- restante da tela de anúncios, ícones nos marketplaces e um filtro com todos os marketplaces, marcado de início").
-- Migração anuncios_no_ar_marketplaces. Substitui as funções de docs/anuncios-no-ar.sql (mesmos nomes, parâmetros novos
-- no fim, com padrão — a tela antiga continua respondendo enquanto a nova não publica).
--
-- Um "anúncio" por marketplace:
--   shopee  = item_id por loja (Ottz 522186766, Bumi 759046323)            venda/margem/ADS: ads_metrica_anuncio_dia
--   ml      = MLB da conta Ottz (1107117809; a SVL não tem espelho)         venda/margem do SKU RATEADAS pelos anúncios ativos
--             do SKU na proporção das visitas de 30 dias (o ML não liga a venda ao MLB — mesma regra da /saude-ml);
--             ADS é do próprio MLB (ml_ads_anuncio_diario)
--   amazon  = SKU da Amazon por conta (900001 ACZ, 900002 SVL), "no ar" = com estoque no CD ou venda em 30 dias; sem ADS
--   tiktok  = product_id da loja ACZ; sem ADS
-- mv_anuncio_dia_outros = venda/margem/unidades por anúncio e dia de Amazon e TikTok (60 dias; a margem do pedido da
-- view_margem_pedido_v2 rateada pelos itens). ~1 mil linhas, 0,2 s; cron anuncio-dia-outros-refresh 06h26 BRT.
-- Os números são sempre até ONTEM (como a MV de ADS).

create materialized view if not exists public.mv_anuncio_dia_outros as
with ped as (
  select v.order_sn, v.shop_id, v.marketplace, (v.data_pedido at time zone 'America/Sao_Paulo')::date dia, v.venda, v.margem
    from public.view_margem_pedido_v2 v
   where v.marketplace in ('amazon', 'tiktok')
     and v.data_pedido >= (((now() at time zone 'America/Sao_Paulo')::date - 60)::timestamp at time zone 'America/Sao_Paulo')),
amz as (
  select p.shop_id, coalesce(nullif(btrim(pi.sku_filho), ''), pi.sku_pai) item_id, p.dia, p.order_sn, p.venda, p.margem, pi.quantidade::numeric quantidade,
         pi.subtotal_produto / nullif(pi.quantidade, 0) preco_un,
         coalesce(pi.subtotal_produto / nullif(sum(pi.subtotal_produto) over (partition by p.order_sn), 0), 1.0 / count(*) over (partition by p.order_sn)) peso
    from ped p join public.pedido_itens pi on pi.pedido_id = p.order_sn
   where p.marketplace = 'amazon'),
tt as (
  select p.shop_id, tp.product_id item_id, p.dia, p.order_sn, p.venda, p.margem, 1::numeric quantidade, i.sale_price preco_un,
         coalesce(i.sale_price / nullif(sum(i.sale_price) over (partition by p.order_sn), 0), 1.0 / count(*) over (partition by p.order_sn)) peso
    from ped p join public.tiktok_pedido_itens i on i.pedido_id = p.order_sn
    join (select distinct t.sku_id, t.product_id from public.tiktok_produtos t) tp on tp.sku_id = i.sku_id
   where p.marketplace = 'tiktok' and not coalesce(i.is_gift, false) and coalesce(i.display_status, '') <> 'CANCELLED')
select 'amazon'::text mkt, a.shop_id, a.item_id, a.dia data, sum(a.venda * a.peso) venda, sum(a.margem * a.peso) margem,
       sum(a.quantidade) unidades, count(distinct a.order_sn) pedidos, max(a.preco_un) preco_un
  from amz a where a.item_id is not null group by a.shop_id, a.item_id, a.dia
union all
select 'tiktok', t.shop_id, t.item_id, t.dia, sum(t.venda * t.peso), sum(t.margem * t.peso), sum(t.quantidade), count(distinct t.order_sn), max(t.preco_un)
  from tt t group by t.shop_id, t.item_id, t.dia;

create unique index if not exists mv_anuncio_dia_outros_pk on public.mv_anuncio_dia_outros (mkt, shop_id, item_id, data);
revoke all on public.mv_anuncio_dia_outros from public, anon, authenticated;
grant select on public.mv_anuncio_dia_outros to service_role;
refresh materialized view public.mv_anuncio_dia_outros;  -- prova, na própria migração, que o refresh do cron funciona

select cron.unschedule(jobid) from cron.job where jobname = 'anuncio-dia-outros-refresh';
select cron.schedule('anuncio-dia-outros-refresh', '26 9 * * *', 'refresh materialized view concurrently public.mv_anuncio_dia_outros');

-- loja pelo shop_id (as contas que o app conhece)
create or replace function public.anuncio_loja(p_shop bigint) returns text language sql immutable as $$
  select case p_shop when 522186766 then 'Ottz' when 759046323 then 'Bumi' when 1107117809 then 'Ottz' when 1299638625 then 'SVL'
                     when 900001 then 'Ottz' when 900002 then 'SVL' when 7496181924415506972 then 'Ottz' else '—' end
$$;

-- cadastro único dos anúncios dos 4 marketplaces (uma linha por anúncio)
create or replace function public.anuncio_base()
returns table (mkt text, shop_id bigint, item_id text, nome text, foto text, sku text, loja text, empresa text, no_ar boolean,
               preco numeric, preco_ate numeric, preco_cheio numeric, estoque numeric, n_var int, link text, asin text, rateado boolean)
language sql stable as $$
  select 'shopee'::text, a.shop_id, a.item_id::text, a.nome, a.imagem_url, a.sku_pai,
         case a.shop_id when 522186766 then 'Ottz' else 'Bumi' end, case a.shop_id when 522186766 then 'ottz' else 'svl' end,
         a.status = 'NORMAL',
         (case when coalesce(v.n, 0) > 0 then v.pmin else a.preco_min end)::numeric,
         (case when coalesce(v.n, 0) > 0 and v.pmax > v.pmin then v.pmax end)::numeric,
         (case when coalesce(v.n, 0) = 0 and a.preco_max > a.preco_min then a.preco_max end)::numeric,
         (case when coalesce(v.n, 0) > 0 then v.est else a.estoque_total end)::numeric, coalesce(v.n, 0)::int,
         'https://shopee.com.br/product/' || a.shop_id || '/' || a.item_id, null::text, false
    from public.shopee_anuncios a
    left join (select vv.shop_id, vv.item_id, min(vv.preco) pmin, max(vv.preco) pmax, count(*) n, sum(vv.estoque) est
                 from public.shopee_anuncios_variacao vv group by 1, 2) v on v.shop_id = a.shop_id and v.item_id = a.item_id
   where a.shop_id in (522186766, 759046323)
  union all
  select 'ml', 1107117809::bigint, a.mlb, a.titulo, a.foto, a.sku, 'Ottz', 'ottz', a.status = 'active',
         coalesce(pr.promo_price, a.preco)::numeric, null::numeric,
         (case when greatest(coalesce(a.preco_original, 0), coalesce(a.preco, 0)) > coalesce(pr.promo_price, a.preco)
               then greatest(coalesce(a.preco_original, 0), coalesce(a.preco, 0)) end)::numeric,
         a.estoque::numeric, (case when coalesce(a.n_variacoes, 0) > 1 then a.n_variacoes else 0 end)::int, a.permalink, null::text, coalesce(w.n, 1) > 1
    from public.ml_anuncios a
    left join lateral (select min(i.promo_price) promo_price from public.ml_promocao_itens i
                        where i.mlb = a.mlb and i.status = 'started' and i.promo_price > 0) pr on true
    left join (select b.sku, count(*) n from public.ml_anuncios b where b.status = 'active' and b.sku is not null group by 1) w on w.sku = a.sku
  union all
  select 'amazon', (case m.conta when 'ottz' then 900001 else 900002 end)::bigint, m.sku_amazon, coalesce(m.nome, pd.nome), f.foto, m.sku,
         case m.conta when 'ottz' then 'Ottz' else 'SVL' end, case m.conta when 'ottz' then 'ottz' else 'svl' end,
         coalesce(e.tot, 0) > 0 or coalesce(u.ultimo >= (now() at time zone 'America/Sao_Paulo')::date - 30, false),
         u.preco_un::numeric, null::numeric, null::numeric, e.est::numeric, 0, 'https://www.amazon.com.br/dp/' || m.asin, m.asin, false
    from public.pesquisa_amz_meus_skus m
    left join public.produtos pd on pd.sku = m.sku
    left join public.view_foto_produto f on f.sku = m.sku
    left join (select ef.shop_id, ef.sku_marketplace, sum(coalesce(ef.sellable, 0)) est,
                      sum(coalesce(ef.sellable, 0) + coalesce(ef.reserved, 0) + coalesce(ef.in_transit, 0)) tot
                 from public.estoque_fulfillment ef where ef.marketplace = 'amazon' group by 1, 2) e
      on e.shop_id = (case m.conta when 'ottz' then 900001 else 900002 end) and e.sku_marketplace = m.sku_amazon
    left join (select distinct on (o.shop_id, o.item_id) o.shop_id, o.item_id, o.data ultimo, o.preco_un
                 from public.mv_anuncio_dia_outros o where o.mkt = 'amazon' order by o.shop_id, o.item_id, o.data desc) u
      on u.shop_id = (case m.conta when 'ottz' then 900001 else 900002 end) and u.item_id = m.sku_amazon
  union all
  select 'tiktok', t.shop_id::bigint, t.product_id, max(t.titulo), max(f.foto),
         case when count(distinct t.seller_sku) = 1 then max(t.seller_sku) end, 'Ottz', 'ottz', bool_or(t.status = 'ACTIVATE'),
         min(t.preco)::numeric, (case when max(t.preco) > min(t.preco) then max(t.preco) end)::numeric, null::numeric,
         sum(t.estoque)::numeric, (case when count(*) > 1 then count(*) else 0 end)::int,
         'https://shop.tiktok.com/view/product/' || t.product_id || '?region=BR', null::text, false
    from public.tiktok_produtos t
    left join public.view_foto_produto f on f.sku = t.seller_sku
   group by t.shop_id, t.product_id
$$;

-- venda, margem e ADS por anúncio e dia, nos 4 marketplaces
create or replace function public.anuncio_dia(p_de date, p_ate date)
returns table (mkt text, shop_id bigint, item_id text, data date, venda numeric, unidades numeric, gasto numeric, vendas_ads numeric, margem numeric, margem_pos numeric)
language sql stable as $$
  select 'shopee'::text, d.shop_id, d.anuncio_id, d.data, coalesce(d.venda_total, 0), coalesce(d.unidades, 0), coalesce(d.gasto, 0),
         coalesce(d.vendas_ads, 0), d.margem, d.margem_pos_ads
    from public.ads_metrica_anuncio_dia d
   where d.marketplace = 'shopee' and d.nivel = 'anuncio' and d.data between p_de and p_ate
  union all
  select 'ml', 1107117809::bigint, k.item_id, k.data, coalesce(sum(k.venda), 0), coalesce(sum(k.un), 0), coalesce(sum(k.gasto), 0),
         coalesce(sum(k.vads), 0), sum(k.margem), sum(k.margem) - coalesce(sum(k.gasto), 0)
    from (
      select w.mlb item_id, d.data, d.venda_total * w.peso venda, d.unidades * w.peso un, d.margem * w.peso margem, 0::numeric gasto, 0::numeric vads
        from public.ads_metrica_anuncio_dia d
        join (select a.mlb, a.sku,
                     case when sum(coalesce(a.visitas_30d, 0)) over (partition by a.sku) > 0
                          then coalesce(a.visitas_30d, 0)::numeric / sum(coalesce(a.visitas_30d, 0)) over (partition by a.sku)
                          else 1.0 / count(*) over (partition by a.sku) end peso
                from public.ml_anuncios a where a.status = 'active' and a.sku is not null) w on w.sku = d.anuncio_id
       where d.marketplace = 'mercadolivre' and d.nivel = 'sku' and d.shop_id = 1107117809 and d.data between p_de and p_ate
      union all
      select d.anuncio_id, d.data, null, null, null, d.gasto, d.vendas_ads
        from public.ads_metrica_anuncio_dia d
       where d.marketplace = 'mercadolivre' and d.nivel = 'anuncio' and d.data between p_de and p_ate) k
   group by k.item_id, k.data
  union all
  select o.mkt, o.shop_id, o.item_id, o.data, coalesce(o.venda, 0), coalesce(o.unidades, 0), 0::numeric, 0::numeric, o.margem, o.margem
    from public.mv_anuncio_dia_outros o where o.data between p_de and p_ate
$$;

drop function if exists public.anuncio_mudancas_lista(int, text[]);
create or replace function public.anuncio_mudancas_lista(p_dias int default 30, p_itens text[] default null)
returns table (quando timestamptz, shop_id bigint, item_id text, campo text, de text, para text, descricao text,
               origem text, quem text, ok boolean, log_id bigint, braco text, campanha text, mkt text)
language sql stable security definer set search_path = public as $$
with lim as (select now() - make_interval(days => p_dias) as desde,
                    (now() at time zone 'America/Sao_Paulo')::date - p_dias - 1 as dia0),
pub as (
  select p.criado_em quando, p.shop_id, p.item_id, p.operacao, p.criado_por_nome quem, p.enviado e,
         case p.canal when 'mercado_livre' then 'ml' else p.canal end mkt,
         case when jsonb_typeof(p.enviado->'fotos'->'novas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'novas') else 0 end n_novas,
         case when jsonb_typeof(p.enviado->'fotos'->'mantidas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'mantidas') else 0 end n_mant
    from ia_publicacao p, lim
   where p.estado = 'publicado' and p.canal in ('shopee', 'mercado_livre', 'amazon', 'tiktok') and p.item_id is not null and p.shop_id is not null
     and p.criado_em >= lim.desde and (p_itens is null or p.item_id = any(p_itens))),
tl as (
  select l.* from anuncio_teste_log l, lim
   where l.criado_em >= lim.desde and l.item_id is not null and (p_itens is null or l.item_id = any(p_itens))),
ret as (
  select ((s.data::timestamp + time '07:30') at time zone 'America/Sao_Paulo') quando, s.shop_id, s.anuncio_id item_id, x.campo, x.de, x.para, x.descricao,
         case s.marketplace when 'mercadolivre' then 'ml' else s.marketplace end mkt
    from (select z.*, lag(z.preco) over w p0, lag(z.em_promocao) over w e0, lag(z.status) over w s0
            from ads_anuncio_snapshot z, lim
           where z.marketplace in ('shopee', 'mercadolivre') and z.variacao_id = '' and z.data >= lim.dia0
             and (p_itens is null or z.anuncio_id = any(p_itens))
          window w as (partition by z.marketplace, z.shop_id, z.anuncio_id order by z.data)) s
    cross join lateral (values
      ('preco_venda', s.p0::text, s.preco::text, 'preço de venda', s.p0 is not null and abs(s.preco - s.p0) >= 0.01),
      ('promocao', case when s.e0 then 'em promoção' else 'sem promoção' end, case when s.em_promocao then 'em promoção' else 'sem promoção' end,
         case when s.em_promocao then 'entrou em promoção' else 'saiu da promoção' end, s.e0 is not null and s.em_promocao is distinct from s.e0),
      ('status_anuncio', s.s0, s.status, 'situação do anúncio', s.s0 is not null and s.status is distinct from s.s0)
    ) x(campo, de, para, descricao, mudou)
   where x.mudou)
-- pelo app (envio do anúncio)
select quando, shop_id, item_id, 'anuncio_criado', null::text, null::text, 'anúncio criado pelo app', 'app', quem, true, null::bigint, null::text, null::text, mkt
  from pub where operacao = 'criar'
union all
select quando, shop_id, item_id, 'fotos', null, (n_novas + n_mant)::text,
       format('%s foto(s) nova(s)%s', n_novas, case when n_mant > 0 then format(', %s mantida(s)', n_mant) else '' end), 'app', quem, true, null, null, null, mkt
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'fotos')::boolean, false)
union all
select quando, shop_id, item_id, 'titulo', e->'antes'->>'titulo', coalesce(e->>'titulo', e->'corpo'->>'item_name'), 'título', 'app', quem, true, null, null, null, mkt
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'titulo')::boolean, false)
union all
select quando, shop_id, item_id, 'descricao', null, null, 'descrição trocada', 'app', quem, true, null, null, null, mkt
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'descricao')::boolean, false)
union all
select quando, shop_id, item_id, 'preco_cheio', e->'antes'->>'preco', e->>'preco', 'preço cheio', 'app', quem, true, null, null, null, mkt
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'preco')::boolean, false) and e->>'preco' is not null
union all
-- visto pelo retrato diário (feito fora do app); o que o teste A/B mudou não repete aqui
select r.quando, r.shop_id, r.item_id, r.campo, r.de, r.para, r.descricao, 'fora', null, true, null, null, null, r.mkt
  from ret r, lim
 where r.quando >= lim.desde
   and not (r.campo = 'preco_venda' and exists (
         select 1 from tl where tl.item_id = r.item_id and tl.acao in ('preco', 'reverter:preco') and tl.ok
            and tl.criado_em <= r.quando and tl.criado_em >= r.quando - interval '2 days'))
union all
-- ADS da Shopee: meta de ROAS, orçamento e situação da campanha
select h.ate, h.shop_id, c.item_id,
       case h.campo when 'roas_target' then 'roas' when 'budget' then 'orcamento' when 'status' then 'campanha' else h.campo end,
       h.de, h.para,
       case h.campo when 'roas_target' then 'ROAS alvo' when 'budget' then 'orçamento diário de ADS' when 'status' then 'campanha de ADS' else h.campo end,
       case h.origem when 'externo' then 'fora' when 'teste_ab' then 'teste' else 'app' end, h.quem, true, null, null, h.campaign_id, 'shopee'
  from ads_config_historico h
  join ads_config_atual c on c.mkt = h.mkt and c.shop_id = h.shop_id and c.campaign_id = h.campaign_id, lim
 where h.mkt = 'shopee' and h.ate >= lim.desde and c.item_id is not null and (p_itens is null or c.item_id = any(p_itens))
union all
-- ADS do Mercado Livre: a meta e o orçamento são da CAMPANHA — a mudança aparece nos anúncios dela que gastaram em 14 dias
select h.ate, h.shop_id, mc.item_id,
       case h.campo when 'roas_target' then 'roas' when 'budget' then 'orcamento' when 'status' then 'campanha' else h.campo end,
       h.de, h.para,
       case h.campo when 'roas_target' then 'ROAS objetivo da campanha' when 'budget' then 'orçamento diário da campanha' when 'status' then 'campanha de ADS' else h.campo end,
       case h.origem when 'externo' then 'fora' else 'app' end, h.quem, true, null, null, h.campaign_id, 'ml'
  from ads_config_historico h
  join (select distinct x.item_id, x.campaign_id::text campaign_id from ml_ads_anuncio_diario x
         where x.data >= (now() at time zone 'America/Sao_Paulo')::date - 14 and x.gasto > 0) mc on mc.campaign_id = h.campaign_id, lim
 where h.mkt = 'ml' and h.ate >= lim.desde and (p_itens is null or mc.item_id = any(p_itens))
union all
-- teste A/B (preço na promoção, título, campanha nova, relâmpago, desfazer); ROAS e pausa vêm do bloco de ADS acima
select l.criado_em, l.shop_id, l.item_id,
       case when l.acao = 'preco' then 'preco_venda' when l.acao = 'titulo' then 'titulo' when l.acao = 'criar_campanha' then 'campanha_nova'
            when l.acao like 'relampago%' then 'relampago' else 'desfeito' end,
       case when l.acao = 'preco' then case when jsonb_typeof(l.de) = 'object' then l.de->>'preco' else l.de #>> '{}' end
            when l.acao = 'titulo' then l.de #>> '{}' when l.acao like 'relampago%' then 'na relâmpago' end,
       case when l.acao in ('preco', 'titulo') then l.para #>> '{}' when l.acao = 'criar_campanha' then coalesce('campanha ' || l.campaign_id, 'não criada')
            when l.acao like 'relampago%' then 'fora da relâmpago' end,
       case when l.acao = 'preco' then 'preço de venda' when l.acao = 'titulo' then 'título' when l.acao = 'criar_campanha' then 'campanha por palavra-chave'
            when l.acao like 'relampago%' then 'relâmpago' else 'desfeito: ' || replace(substr(l.acao, 10), '_', ' ') end || coalesce(' — ' || l.erro, ''),
       'teste', l.quem, coalesce(l.ok, false) and coalesce(l.conferido, true), l.id, l.braco, l.campaign_id, 'shopee'
  from tl l
 where (l.acao in ('preco', 'titulo', 'criar_campanha', 'relampago_programacao', 'relampago_remover') or l.acao like 'reverter:%')
   and not (coalesce(l.ok, false) and l.enviado is null and l.acao in ('preco', 'titulo'))
$$;

drop function if exists public.anuncio_mudanca_efeito(bigint, text, date);
create or replace function public.anuncio_mudanca_efeito(p_mkt text, p_shop bigint, p_item text, p_dia date)
returns table (antes numeric, depois numeric, dias_depois int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(x.venda) filter (where x.data < p_dia), 0),
         coalesce(sum(x.venda) filter (where x.data >= p_dia), 0),
         greatest(least(((now() at time zone 'America/Sao_Paulo')::date - p_dia), 7), 0)::int
    from (
      select d.data, d.venda_total venda
        from ads_metrica_anuncio_dia d
       where p_mkt = 'shopee' and d.marketplace = 'shopee' and d.shop_id = p_shop and d.nivel = 'anuncio' and d.anuncio_id = p_item
         and d.data >= p_dia - 7 and d.data <= p_dia + 6
      union all
      select d.data, d.venda_total * w.peso
        from (select a.sku, case when t.v > 0 then coalesce(a.visitas_30d, 0)::numeric / t.v else 1.0 / nullif(t.n, 0) end peso
                from ml_anuncios a
                cross join lateral (select sum(coalesce(b.visitas_30d, 0)) v, count(*) n from ml_anuncios b where b.sku = a.sku and b.status = 'active') t
               where p_mkt = 'ml' and a.mlb = p_item and a.sku is not null) w
        join ads_metrica_anuncio_dia d on d.marketplace = 'mercadolivre' and d.shop_id = 1107117809 and d.nivel = 'sku' and d.anuncio_id = w.sku
       where d.data >= p_dia - 7 and d.data <= p_dia + 6
      union all
      select o.data, o.venda
        from mv_anuncio_dia_outros o
       where p_mkt in ('amazon', 'tiktok') and o.mkt = p_mkt and o.shop_id = p_shop and o.item_id = p_item
         and o.data >= p_dia - 7 and o.data <= p_dia + 6) x
   where x.data < (now() at time zone 'America/Sao_Paulo')::date
$$;

drop function if exists public.anuncios_mudancas(int, text, text, text, text, int, int);
create or replace function public.anuncios_mudancas(p_dias int default 30, p_filtro text default null, p_campo text default null,
  p_empresa text default null, p_busca text default null, p_offset int default 0, p_limit int default 60, p_mkt text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  q text := nullif(btrim(coalesce(p_busca, '')), '');
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  with m as materialized (
    select x.*, b.nome, b.foto, b.sku, b.link, (x.quando at time zone 'America/Sao_Paulo')::date dia,
           public.anuncio_loja(x.shop_id) loja, x.shop_id::text shop
      from anuncio_mudancas_lista(least(greatest(p_dias, 1), 90)) x
      left join anuncio_base() b on b.mkt = x.mkt and b.shop_id = x.shop_id and b.item_id = x.item_id
     where (p_mkt is null or p_mkt = 'todos' or x.mkt = p_mkt)
       and (p_empresa is null or (p_empresa = 'ottz' and public.anuncio_loja(x.shop_id) = 'Ottz') or (p_empresa = 'svl' and public.anuncio_loja(x.shop_id) in ('Bumi', 'SVL')))
       and (q is null or lower(x.item_id) = lower(q) or x.item_id = 'MLB' || q or upper(coalesce(b.asin, '')) = upper(q) or public.ia_bate_busca(b.sku, b.nome, q))
       and (p_campo is null
            or (p_campo = 'preco' and x.campo in ('preco_venda', 'preco_cheio'))
            or (p_campo = 'conteudo' and x.campo in ('titulo', 'descricao', 'fotos', 'anuncio_criado'))
            or (p_campo = 'ads' and x.campo in ('roas', 'orcamento', 'campanha', 'campanha_nova'))
            or (p_campo = 'promocao' and x.campo in ('promocao', 'relampago', 'status_anuncio')))),
  e as materialized (
    select m.*, ef.antes, ef.depois, ef.dias_depois,
           (ef.dias_depois >= 3 and ef.antes >= 200 and ef.depois / nullif(ef.dias_depois, 0) < 0.7 * ef.antes / 7) piorou,
           (ef.dias_depois >= 3 and ef.depois / nullif(ef.dias_depois, 0) > 1.3 * greatest(ef.antes, 1) / 7 and ef.depois >= 200) melhorou
      from m left join lateral public.anuncio_mudanca_efeito(m.mkt, m.shop_id, m.item_id, m.dia) ef on true),
  f as (
    select * from e
     where p_filtro is null or (p_filtro = 'app' and origem = 'app') or (p_filtro = 'teste' and origem = 'teste')
        or (p_filtro = 'fora' and origem = 'fora') or (p_filtro = 'piorou' and piorou) or (p_filtro = 'falhou' and not ok))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'contagem', (select jsonb_build_object('tudo', count(*), 'app', count(*) filter (where origem = 'app'), 'teste', count(*) filter (where origem = 'teste'),
                   'fora', count(*) filter (where origem = 'fora'), 'piorou', count(*) filter (where piorou), 'falhou', count(*) filter (where not ok)) from e),
    'linhas', coalesce((select jsonb_agg(to_jsonb(z) order by z.quando desc, z.item_id) from (
        select quando, mkt, shop_id, shop, loja, item_id, nome, foto, sku, link, campo, de, para, descricao, origem, quem, ok, log_id, braco, campanha,
               antes, depois, dias_depois, piorou, melhorou, (dia + 7) completo_em
          from f order by quando desc, item_id offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 200)) z), '[]'::jsonb),
    'hoje', hoje) into v;
  return v;
end $$;

drop function if exists public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int);
create or replace function public.anuncios_no_ar(p_empresa text default null, p_busca text default null, p_atencao text default null,
  p_so_teste boolean default false, p_mudou7 boolean default false, p_ordem text default 'receita', p_offset int default 0, p_limit int default 50,
  p_mkt text default 'shopee', p_dias int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  n int := case when p_dias = 30 then 30 else 7 end;
  q text := nullif(btrim(coalesce(p_busca, '')), '');
  todos boolean := p_mkt is null or p_mkt = 'todos';
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  with ml as materialized (select * from anuncio_mudancas_lista(30)),
  mud as (select mkt, shop_id, item_id, max(quando) ultima, count(*) filter (where quando >= now() - interval '7 days') n7,
                 count(*) filter (where quando >= now() - interval '7 days' and origem in ('app', 'teste') and ok and campo <> 'desfeito') n7_sis
            from ml group by 1, 2, 3),
  met as (select d.mkt, d.shop_id, d.item_id,
                 sum(d.venda) filter (where d.data >= hoje - n) v7, sum(d.venda) filter (where d.data < hoje - n) v7a,
                 sum(d.unidades) filter (where d.data >= hoje - n) u7, sum(d.gasto) filter (where d.data >= hoje - n) g7,
                 sum(d.vendas_ads) filter (where d.data >= hoje - n) va7, sum(d.margem) filter (where d.data >= hoje - n) m7,
                 sum(d.margem_pos) filter (where d.data >= hoje - n) mp7
            from anuncio_dia(hoje - 2 * n, hoje - 1) d group by 1, 2, 3),
  cfg as (select 'shopee'::text mkt, c.shop_id, c.item_id, c.campaign_id, c.roas_target, c.status, c.budget
            from (select distinct on (shop_id, item_id) * from ads_config_atual where mkt = 'shopee' and item_id is not null
                   order by shop_id, item_id, (status = 'ongoing') desc, visto_em desc) c
          union all
          select 'ml', 1107117809::bigint, mc.item_id, c.campaign_id, c.roas_target, case when c.status = 'active' then 'ongoing' else c.status end, c.budget
            from (select distinct on (x.item_id) x.item_id, x.campaign_id::text campaign_id from ml_ads_anuncio_diario x
                   where x.data >= hoje - 14 order by x.item_id, x.data desc) mc
            join ads_config_atual c on c.mkt = 'ml' and c.campaign_id = mc.campaign_id),
  marc as (select shop_id, item_id, jsonb_agg(jsonb_build_object('id', id, 'braco', braco, 'estrategia', estrategia, 'status', status) order by id) lista,
                  bool_or(status in ('pendente', 'em_andamento', 'divergente')) pend
             from anuncio_marcacao where item_id is not null group by 1, 2),
  jt as materialized (
    select b.mkt, b.shop_id, b.shop_id::text shop, b.item_id, b.nome, b.foto, b.sku, b.loja, b.empresa, b.n_var, b.preco, b.preco_ate, b.preco_cheio,
           b.estoque, b.link, b.asin, b.rateado,
           coalesce(met.v7, 0) v7, coalesce(met.v7a, 0) v7a, round(coalesce(met.u7, 0), 1) u7, coalesce(met.g7, 0) g7,
           case when met.g7 > 0 then round(met.va7 / met.g7, 1) end roas,
           case when met.v7 > 0 and met.m7 is not null then round(100 * met.m7 / met.v7, 1) end mc_pct,
           case when met.v7 > 0 and met.mp7 is not null then round(100 * met.mp7 / met.v7, 1) end mc_pos_pct,
           coalesce(met.mp7, 0) mp7,
           cfg.campaign_id, cfg.roas_target meta, cfg.status campanha_status, cfg.budget orcamento,
           case when met.u7 > 0 and b.estoque is not null then round(b.estoque / (met.u7 / n), 1) end dias_estoque,
           (coalesce(met.u7, 0) >= n and b.estoque is not null and b.estoque < met.u7 * 7.0 / n) f_estoque,
           (coalesce(met.v7a, 0) >= 500 * n / 7.0 and coalesce(met.v7, 0) < 0.7 * met.v7a) f_caindo,
           (coalesce(met.g7, 0) >= 20 * n / 7.0 and coalesce(met.mp7, 0) < 0) f_prejuizo,
           (marc.lista is not null) f_teste, coalesce(marc.pend, false) f_teste_pend, marc.lista marcacoes,
           coalesce(mud.n7, 0) n7, coalesce(mud.n7_sis, 0) n7_sis, mud.ultima
      from anuncio_base() b
      left join met on met.mkt = b.mkt and met.shop_id = b.shop_id and met.item_id = b.item_id
      left join cfg on cfg.mkt = b.mkt and cfg.shop_id = b.shop_id and cfg.item_id = b.item_id
      left join marc on b.mkt = 'shopee' and marc.shop_id = b.shop_id and marc.item_id = b.item_id
      left join mud on mud.mkt = b.mkt and mud.shop_id = b.shop_id and mud.item_id = b.item_id
     where b.no_ar and (p_empresa is null or b.empresa = p_empresa)),
  j as (select * from jt where todos or jt.mkt = p_mkt),
  f as (
    select j.* from j
     where (q is null or lower(j.item_id) = lower(q) or j.item_id = 'MLB' || q or upper(coalesce(j.asin, '')) = upper(q)
            or public.ia_bate_busca(j.sku, j.nome, q)
            or (j.mkt = 'shopee' and exists (select 1 from shopee_anuncios_variacao vv where vv.sku = q and vv.shop_id = j.shop_id and vv.item_id::text = j.item_id))
            or (j.mkt = 'tiktok' and exists (select 1 from tiktok_produtos t where t.seller_sku = q and t.product_id = j.item_id)))
       and (p_atencao is null or (p_atencao = 'estoque' and f_estoque) or (p_atencao = 'caindo' and f_caindo) or (p_atencao = 'prejuizo' and f_prejuizo)
            or (p_atencao = 'teste' and f_teste_pend) or (p_atencao = 'medicao' and n7_sis > 0))
       and (not coalesce(p_so_teste, false) or f_teste)
       and (not coalesce(p_mudou7, false) or n7 > 0)),
  pag as (
    select f.* from f
     order by case when p_ordem = 'queda' then f.v7 - f.v7a end asc nulls last,
              case when p_ordem = 'mexido' then f.ultima end desc nulls last,
              case when p_ordem = 'margem' and f.v7 > 0 then f.mp7 / f.v7 end asc nulls last,
              case when p_ordem = 'estoque' then f.dias_estoque end asc nulls last,
              f.v7 desc, f.mkt, f.item_id
     offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 100))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'no_ar', (select count(*) from j),
    'por_mkt', (select jsonb_build_object('todos', count(*), 'shopee', count(*) filter (where mkt = 'shopee'), 'ml', count(*) filter (where mkt = 'ml'),
                  'amazon', count(*) filter (where mkt = 'amazon'), 'tiktok', count(*) filter (where mkt = 'tiktok')) from jt),
    'dias', n,
    'resumo', (select jsonb_build_object('vendendo', count(*) filter (where v7 > 0), 'receita7', round(sum(v7)), 'receita7a', round(sum(v7a)), 'ads7', round(sum(g7))) from j),
    'atencao', (select jsonb_build_object(
        'estoque', count(*) filter (where f_estoque), 'zerado', count(*) filter (where f_estoque and estoque = 0),
        'caindo', count(*) filter (where f_caindo), 'caindo_rs', round(coalesce(sum(v7a - v7) filter (where f_caindo), 0)),
        'prejuizo', count(*) filter (where f_prejuizo), 'prejuizo_rs', round(coalesce(-sum(mp7) filter (where f_prejuizo), 0)),
        'medicao', coalesce(sum(n7_sis), 0), 'medicao_anuncios', count(*) filter (where n7_sis > 0)) from j)
      || (select jsonb_build_object('teste', count(*), 'teste_bracos', coalesce(string_agg(braco, ', ' order by id), ''))
            from anuncio_marcacao where status in ('pendente', 'em_andamento', 'divergente') and (todos or p_mkt = 'shopee')),
    'linhas', coalesce((select jsonb_agg((to_jsonb(p) - 'mp7'::text) || jsonb_build_object(
          'ultima_mudanca', (select to_jsonb(u) from (select ml.quando, ml.campo, ml.de, ml.para, ml.descricao, ml.origem, ml.ok
                               from ml where ml.mkt = p.mkt and ml.shop_id = p.shop_id and ml.item_id = p.item_id order by ml.quando desc limit 1) u),
          'sku_editar', coalesce(
              (select pr.sku from produtos pr where pr.sku = p.sku and pr.ativo limit 1),
              case when p.mkt = 'shopee' then coalesce(
                (select pr.sku_pai from produtos pr join shopee_anuncios_variacao vv on vv.sku = pr.sku
                  where vv.shop_id = p.shop_id and vv.item_id::text = p.item_id and pr.ativo and pr.sku_pai is not null group by pr.sku_pai order by count(*) desc limit 1),
                (select pr.sku from produtos pr join shopee_anuncios_variacao vv on vv.sku = pr.sku
                  where vv.shop_id = p.shop_id and vv.item_id::text = p.item_id and pr.ativo limit 1)) end,
              case when p.mkt = 'tiktok' then
                (select coalesce(pr.sku_pai, pr.sku) from produtos pr join tiktok_produtos t on t.seller_sku = pr.sku
                  where t.product_id = p.item_id and pr.ativo limit 1) end))
        order by case when p_ordem = 'queda' then p.v7 - p.v7a end asc nulls last,
                 case when p_ordem = 'mexido' then p.ultima end desc nulls last,
                 case when p_ordem = 'margem' and p.v7 > 0 then p.mp7 / p.v7 end asc nulls last,
                 case when p_ordem = 'estoque' then p.dias_estoque end asc nulls last,
                 p.v7 desc, p.mkt, p.item_id) from pag p), '[]'::jsonb),
    'ate', hoje - 1, 'de', hoje - n) into v;
  return v;
end $$;

drop function if exists public.anuncio_no_ar_detalhe(bigint, text);
create or replace function public.anuncio_no_ar_detalhe(p_shop bigint, p_item text, p_mkt text default 'shopee')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  select jsonb_build_object(
    'serie', (select jsonb_agg(jsonb_build_object('data', g.d::date, 'venda', round(coalesce(d.venda, 0), 2), 'gasto', coalesce(d.gasto, 0), 'un', round(coalesce(d.unidades, 0), 1)) order by g.d)
                from generate_series(hoje - 28, hoje - 1, interval '1 day') g(d)
                left join (select x.data, x.venda, x.gasto, x.unidades from anuncio_dia(hoje - 28, hoje - 1) x
                            where x.mkt = p_mkt and x.shop_id = p_shop and x.item_id = p_item) d on d.data = g.d::date),
    'mudancas', coalesce((select jsonb_agg(to_jsonb(z) order by z.quando desc) from (
        select x.quando, x.campo, x.de, x.para, x.descricao, x.origem, x.quem, x.ok, x.log_id, x.braco, x.campanha,
               ef.antes, ef.depois, ef.dias_depois, ((x.quando at time zone 'America/Sao_Paulo')::date + 7) completo_em
          from anuncio_mudancas_lista(90, array[p_item]) x
          left join lateral public.anuncio_mudanca_efeito(p_mkt, p_shop, p_item, (x.quando at time zone 'America/Sao_Paulo')::date) ef on true
         where x.shop_id = p_shop and x.mkt = p_mkt order by x.quando desc limit 60) z), '[]'::jsonb),
    'campanhas', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', c.campaign_id, 'status', case when c.status = 'active' then 'ongoing' else c.status end,
                                    'roas_target', c.roas_target, 'budget', c.budget, 'nome', c.nome) order by (c.status in ('ongoing', 'active')) desc, c.visto_em desc)
                   from ads_config_atual c
                  where (p_mkt = 'shopee' and c.mkt = 'shopee' and c.shop_id = p_shop and c.item_id = p_item)
                     or (p_mkt = 'ml' and c.mkt = 'ml' and c.campaign_id in (select distinct x.campaign_id::text from ml_ads_anuncio_diario x where x.item_id = p_item and x.data >= hoje - 14))), '[]'::jsonb),
    'variacoes', coalesce(
        (select jsonb_agg(jsonb_build_object('sku', vv.sku, 'preco', vv.preco, 'preco_cheio', vv.preco_original, 'estoque', vv.estoque) order by vv.preco)
           from shopee_anuncios_variacao vv where p_mkt = 'shopee' and vv.shop_id = p_shop and vv.item_id::text = p_item),
        (select jsonb_agg(jsonb_build_object('sku', t.seller_sku, 'preco', t.preco, 'preco_cheio', null, 'estoque', t.estoque) order by t.preco)
           from tiktok_produtos t where p_mkt = 'tiktok' and t.product_id = p_item having count(*) > 1), '[]'::jsonb),
    -- contador da regra de parada do teste A/B: cliques e ROAS do ADS desde o dia em que o braço foi aplicado (dias fechados)
    'teste', coalesce((select jsonb_agg(jsonb_build_object('braco', a.braco, 'desde', (a.aplicado_em at time zone 'America/Sao_Paulo')::date,
                                 'regra', a.regra_parada, 'cliques', s.cliques, 'gasto', s.gasto, 'dias', s.dias,
                                 'roas', case when s.gasto > 0 then round(s.vads / s.gasto, 1) end) order by a.id)
                   from anuncio_marcacao a
                   left join lateral (select coalesce(sum(d.cliques), 0) cliques, coalesce(sum(d.gasto), 0) gasto, coalesce(sum(d.vendas_ads), 0) vads, count(*) dias
                                        from ads_metrica_anuncio_dia d
                                       where d.marketplace = 'shopee' and d.shop_id = p_shop and d.nivel = 'anuncio' and d.anuncio_id = p_item
                                         and d.data >= (a.aplicado_em at time zone 'America/Sao_Paulo')::date) s on true
                  where p_mkt = 'shopee' and a.shop_id = p_shop and a.item_id = p_item and a.aplicado_em is not null), '[]'::jsonb),
    'hoje', hoje) into v;
  return v;
end $$;

revoke all on function public.anuncio_loja(bigint) from public, anon;
revoke all on function public.anuncio_base() from public, anon, authenticated;
revoke all on function public.anuncio_dia(date, date) from public, anon, authenticated;
revoke all on function public.anuncio_mudancas_lista(int, text[]) from public, anon, authenticated;
revoke all on function public.anuncio_mudanca_efeito(text, bigint, text, date) from public, anon, authenticated;
grant execute on function public.anuncio_loja(bigint) to authenticated, service_role;
grant execute on function public.anuncio_base() to service_role;
grant execute on function public.anuncio_dia(date, date) to service_role;
grant execute on function public.anuncio_mudancas_lista(int, text[]) to service_role;
grant execute on function public.anuncio_mudanca_efeito(text, bigint, text, date) to service_role;
revoke all on function public.anuncios_mudancas(int, text, text, text, text, int, int, text) from public, anon;
revoke all on function public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int, text, int) from public, anon;
revoke all on function public.anuncio_no_ar_detalhe(bigint, text, text) from public, anon;
grant execute on function public.anuncios_mudancas(int, text, text, text, text, int, int, text) to authenticated, service_role;
grant execute on function public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int, text, int) to authenticated, service_role;
grant execute on function public.anuncio_no_ar_detalhe(bigint, text, text) to authenticated, service_role;

-- Rollback: reaplicar docs/anuncios-no-ar.sql (a versão só Shopee) depois de
-- drop function if exists public.anuncio_no_ar_detalhe(bigint, text, text);
-- drop function if exists public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int, text, int);
-- drop function if exists public.anuncios_mudancas(int, text, text, text, text, int, int, text);
-- drop function if exists public.anuncio_mudanca_efeito(text, bigint, text, date);
-- drop function if exists public.anuncio_mudancas_lista(int, text[]);
-- drop function if exists public.anuncio_dia(date, date); drop function if exists public.anuncio_base(); drop function if exists public.anuncio_loja(bigint);
-- select cron.unschedule(jobid) from cron.job where jobname = 'anuncio-dia-outros-refresh';
-- drop materialized view if exists public.mv_anuncio_dia_outros;
