-- =====================================================================================================
-- Agente "Tendências e mudanças" — motor no banco (sem IA), 23/nov/2026
--
-- O que é
--   tendencias_relatorio(p_ref date default null) -> jsonb   (p_ref nulo = ontem em Brasília, último dia fechado)
--   tendencias_destaque(p jsonb)                  -> text    (1–2 frases para o cartão)
--   tendencias_html(p jsonb)                      -> text    (relatório completo em HTML simples)
--   auxiliares: tend_rs, tend_n2, tend_pc, tend_num, tend_campanha
--
-- O que o relatório traz
--   1. Por loja (marketplace + conta) e no Total: receita, pedidos, margem, ADS e ticket em três horizontes
--      (7 × 7 dias, 30 × 30, 90 × 90), a série por semana fechada (até 26), a tendência de cada horizonte e
--      uma leitura (queda_persistente, queda_recente, recuperando, alta_persistente, alta_recente, estavel…).
--   2. Possíveis motivos, por regra e com evidência (horizonte de 30 dias): volume × ticket, ADS da loja,
--      concentração em poucos produtos, produtos que pararam de vender / novos, dias sem relâmpago, devoluções
--      e, por produto que mais perdeu ou ganhou, o que mudou (preço, promoção, estoque do anúncio, ADS do
--      anúncio, meta de ROAS, alteração feita pelo sistema).
--   3. Nossas mudanças dos últimos 30 dias e o efeito (7 dias antes × 7 depois, receita do anúncio):
--      meta de ROAS, preço, promoção, orçamento, alterações do sistema.
--   4. Até 6 decisões e um bloco de qualidade (o que faltou, desde quando há dado, avisos de sazonalidade).
--
-- Fontes (só leitura): view_kpi_pedidos_dia (MV), shopee_ads_diario, ml_ads_diario, pedidos_validos +
--   pedido_itens, ads_anuncio_snapshot, ads_metrica_anuncio_dia (MV), anuncio_mudancas_lista(), anuncio_dia(),
--   flashsale_criadas, shopee_devolucoes, lojas, produtos, shopee_anuncios, ml_anuncios.
--
-- Efeito das mudanças: receita do anúncio 7 dias antes × até 7 dias depois, DESCONTADO o movimento da loja nas
--   mesmas janelas (efeito); o efeito sem o desconto, igual ao da tela Anúncios › Mudanças, vem em efeito_bruto.
--   Oscilação de preço/promoção desfeita em até 2 dias (relâmpago) não conta como mudança.
-- qualidade.tempos_ms = milissegundos acumulados até o começo de cada etapa (1 a 14).
--
-- Regras respeitadas: dia em Brasília; percentual sempre recalculado dos absolutos; só pedido válido;
--   SKU vendido = coalesce(sku_filho, sku_pai) (na Amazon, sku_pai); nada é gravado (só tabelas temporárias).
--
-- Quem chama: o pg_cron (sem usuário). Por isso não usa as RPCs com trava de módulo e as permissões de
--   public/anon/authenticated são revogadas.
--
-- Rollback
--   drop function if exists public.tendencias_html(jsonb);
--   drop function if exists public.tendencias_destaque(jsonb);
--   drop function if exists public.tendencias_relatorio(date);
--   drop function if exists public.tend_campanha(date);
--   drop function if exists public.tend_num(text);
--   drop function if exists public.tend_pc(numeric);
--   drop function if exists public.tend_n2(numeric);
--   drop function if exists public.tend_rs(numeric);
-- =====================================================================================================

-- ---------- auxiliares ----------
create or replace function public.tend_rs(v numeric) returns text
language sql immutable set search_path = public, extensions as $f$
  select case when v is null then '—' else
    case when v < 0 then '-' else '' end || 'R$ ' ||
    case when abs(v) >= 1000000 then replace(to_char(round(abs(v) / 1000000.0, 2), 'FM999990.00'), '.', ',') || ' mi'
         when abs(v) >= 100000  then to_char(round(abs(v) / 1000.0), 'FM999990') || ' mil'
         when abs(v) >= 1000    then replace(to_char(round(abs(v) / 1000.0, 1), 'FM999990.0'), '.', ',') || ' mil'
         else to_char(round(abs(v)), 'FM999990') end end $f$;

create or replace function public.tend_n2(v numeric) returns text
language sql immutable set search_path = public, extensions as $f$
  select case when v is null then '—' else replace(to_char(round(v, 2), 'FM999999990.00'), '.', ',') end $f$;

create or replace function public.tend_pc(v numeric) returns text
language sql immutable set search_path = public, extensions as $f$
  select case when v is null then '—' else
    case when v > 0 then '+' else '' end ||
    case when abs(v) >= 10 then to_char(round(v), 'FM999999990')
         else replace(to_char(round(v, 1), 'FM999999990.0'), '.', ',') end || '%' end $f$;

create or replace function public.tend_num(t text) returns numeric
language sql immutable set search_path = public, extensions as $f$
  select case when t ~ '^\s*-?[0-9]+([.,][0-9]+)?\s*$' then replace(btrim(t), ',', '.')::numeric end $f$;

create or replace function public.tend_campanha(d date) returns text
language sql immutable set search_path = public, extensions as $f$
  select case
    when extract(month from d) = extract(day from d) and extract(month from d) >= 3
      then extract(month from d)::int::text || '.' || extract(day from d)::int::text
    when extract(month from d) = 11 and extract(isodow from d) = 5 and extract(day from d) between 23 and 29 then 'Black Friday'
  end $f$;

-- ---------- relatório ----------
create or replace function public.tendencias_relatorio(p_ref date default null)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $fn$
declare
  v_t0    timestamptz := clock_timestamp();
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ref   date;
  v_w0    date;           -- segunda-feira da última semana fechada
  v_ml_canal text;
  v_dias_lista int;
  v_lojas jsonb; v_mud jsonb; v_g jsonb; v_ex jsonb; v_dest jsonb; v_dec jsonb; v_qual jsonb; v_saz jsonb;
  v_avisos text[] := '{}';
  v_tmp text[];
  v_snap_de date; v_cfg_de date; v_flash_de date; v_adsm_de date; v_kpi_de date; v_kpi_em timestamptz;
  v_sads_de date; v_mlads_de date;
  r record;
  v_txt text;
  v_tp jsonb := '{}';
begin
  v_ref := least(coalesce(p_ref, v_hoje - 1), v_hoje - 1);
  v_w0  := date_trunc('week', (v_ref + 1)::timestamp)::date - 7;
  select l.nome into v_ml_canal from lojas l where l.shop_id = 1107117809;

  drop table if exists tt_dia, tt_ads, tt_loja, tt_h, tt_sem, tt_tend, tt_sku, tt_top, tt_sr, tt_sd, tt_se, tt_si,
                       tt_sads, tt_mud, tt_ad, tt_ef, tt_ev, tt_causa, tt_dec;

  v_tp := v_tp || jsonb_build_object('ate_1', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 1. vendas e margem por loja e dia (MV do Dashboard / Pedidos Integrados) --------------------------
  create temp table tt_dia on commit drop as
  select l.shop_id, k.canal, k.empresa, k.marketplace, k.dia, coalesce(k.pedidos, 0)::numeric pedidos,
         coalesce(k.venda, 0)::numeric venda, coalesce(k.margem, 0)::numeric margem
    from view_kpi_pedidos_dia k left join lojas l on l.nome = k.canal
   where k.dia between v_ref - 195 and v_ref;

  insert into tt_dia
  select null, 'Total', 'Todas', 'todos', d.dia, sum(d.pedidos), sum(d.venda), sum(d.margem) from tt_dia d group by d.dia;

  v_tp := v_tp || jsonb_build_object('ate_2', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 2. ADS por loja e dia (mesma definição do DRE) -------------------------------------------------------
  create temp table tt_ads on commit drop as
  select l.nome canal, d.data, coalesce(d.gasto, 0)::numeric gasto, coalesce(d.gmv_direto, 0)::numeric vendas_ads
    from shopee_ads_diario d join lojas l on l.shop_id = d.shop_id
   where d.data between v_ref - 195 and v_ref
  union all
  select v_ml_canal, m.data, sum(coalesce(m.gasto, 0))::numeric, sum(coalesce(m.vendas_total, 0))::numeric
    from ml_ads_diario m
   where m.data between v_ref - 195 and v_ref and v_ml_canal is not null
   group by m.data;

  insert into tt_ads select 'Total', a.data, sum(a.gasto), sum(a.vendas_ads) from tt_ads a group by a.data;

  v_tp := v_tp || jsonb_build_object('ate_3', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 3. lojas com venda nos últimos 90 dias (+ Total) ----------------------------------------------------
  create temp table tt_loja on commit drop as
  with g as (select d.canal, d.dia, d.dia - lag(d.dia) over (partition by d.canal order by d.dia) gap from tt_dia d),
       i as (select g.canal, coalesce(max(g.dia) filter (where g.gap > 45), min(g.dia)) inicio from g group by g.canal),
       b as (select d.canal, max(d.shop_id) shop_id, max(d.empresa) empresa, max(d.marketplace) marketplace,
                    coalesce(sum(d.venda) filter (where d.dia > v_ref - 30), 0) v30
               from tt_dia d group by d.canal
             having coalesce(sum(d.venda) filter (where d.dia > v_ref - 90), 0) > 0)
  select b.canal, b.shop_id, b.empresa, b.marketplace, i.inicio, (b.canal = 'Total') e_total,
         x.loja, lower(replace(x.loja, ' ', '-')) slug,
         exists (select 1 from tt_ads a where a.canal = b.canal and a.data > v_ref - 90) tem_ads,
         (row_number() over (order by (b.canal = 'Total'), b.v30 desc))::int ord
    from b join i on i.canal = b.canal
   cross join lateral (select case b.shop_id
             when 522186766 then 'Shopee Ottz' when 759046323 then 'Shopee Bumi'
             when 1107117809 then 'Mercado Livre Ottz' when 1299638625 then 'Mercado Livre SVL'
             when 900001 then 'Amazon ACZ' when 900002 then 'Amazon SVL'
             when 7496181924415506972 then 'TikTok ACZ' else b.canal end loja) x;

  v_tp := v_tp || jsonb_build_object('ate_4', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 4. horizontes: curto 7×7, médio 30×30, longo 90×90 --------------------------------------------------
  create temp table tt_h on commit drop as
  with hz(h, n, lim) as (values ('curto', 7, 15.0), ('medio', 30, 10.0), ('longo', 90, 10.0)),
  a as (
    select l.canal, hz.h, hz.n, hz.lim,
           coalesce(sum(d.venda)   filter (where d.dia >  v_ref - hz.n), 0) receita,
           coalesce(sum(d.venda)   filter (where d.dia <= v_ref - hz.n), 0) receita_ant,
           coalesce(sum(d.pedidos) filter (where d.dia >  v_ref - hz.n), 0) pedidos,
           coalesce(sum(d.pedidos) filter (where d.dia <= v_ref - hz.n), 0) pedidos_ant,
           coalesce(sum(d.margem)  filter (where d.dia >  v_ref - hz.n), 0) margem,
           coalesce(sum(d.margem)  filter (where d.dia <= v_ref - hz.n), 0) margem_ant
      from tt_loja l cross join hz
      left join tt_dia d on d.canal = l.canal and d.dia > v_ref - 2 * hz.n
     group by l.canal, hz.h, hz.n, hz.lim),
  ad as (
    select l.canal, hz.h,
           sum(x.gasto)      filter (where x.data >  v_ref - hz.n) ads,
           sum(x.gasto)      filter (where x.data <= v_ref - hz.n) ads_ant,
           sum(x.vendas_ads) filter (where x.data >  v_ref - hz.n) vads,
           sum(x.vendas_ads) filter (where x.data <= v_ref - hz.n) vads_ant
      from tt_loja l cross join hz
      join tt_ads x on x.canal = l.canal and x.data > v_ref - 2 * hz.n
     group by l.canal, hz.h),
  c as (
    select a.*, ad.ads, ad.ads_ant, ad.vads, ad.vads_ant,
           greatest(0, least(a.n, (v_ref - a.n) - greatest(l.inicio, v_ref - 2 * a.n + 1) + 1)) dias_ant,
           greatest(0, least(a.n, v_ref - greatest(l.inicio, v_ref - a.n + 1) + 1)) dias_cur
      from a join tt_loja l on l.canal = a.canal left join ad on ad.canal = a.canal and ad.h = a.h),
  v as (
    select c.*,
           case when c.receita_ant > 0 and c.dias_ant >= ceil(c.n * 0.5) and c.dias_cur >= ceil(c.n * 0.5)
                then round(((c.receita / c.dias_cur) / (c.receita_ant / c.dias_ant) - 1) * 100, 1) end var_pct
      from c)
  select v.*,
         case when v.receita = 0 and v.receita_ant = 0 then 'sem_venda'
              when v.var_pct is null then 'sem_base'
              when v.var_pct <= -v.lim then 'queda'
              when v.var_pct >=  v.lim then 'alta'
              else 'estavel' end tend
    from v;

  v_tp := v_tp || jsonb_build_object('ate_5', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 5. série por semana fechada (segunda a domingo), até 26 semanas --------------------------------------
  create temp table tt_sem on commit drop as
  select l.canal, w.semana::date semana,
         coalesce(sum(d.venda), 0) receita, coalesce(sum(d.pedidos), 0) pedidos, coalesce(sum(d.margem), 0) margem,
         (select sum(x.gasto) from tt_ads x where x.canal = l.canal and x.data between w.semana::date and w.semana::date + 6) ads,
         (row_number() over (partition by l.canal order by w.semana desc))::int rn      -- 1 = semana mais recente
    from tt_loja l
   cross join generate_series(v_w0 - 25 * 7, v_w0, interval '7 days') w(semana)
    left join tt_dia d on d.canal = l.canal and d.dia between w.semana::date and w.semana::date + 6
   where w.semana::date >= l.inicio
   group by l.canal, w.semana;

  create temp table tt_tend on commit drop as
  with s as (
    select t.canal, count(*) filter (where t.rn <= 13) n13,
           regr_slope(t.receita, -t.rn) filter (where t.rn <= 13) slope,
           avg(t.receita) filter (where t.rn <= 13) media13,
           avg(t.receita) filter (where t.rn <= 4) media4
      from tt_sem t group by t.canal),
  m4 as (
    select t.canal, t.semana,
           avg(t.receita) over (partition by t.canal order by t.semana rows between 3 preceding and current row) mm4,
           count(*)       over (partition by t.canal order by t.semana rows between 3 preceding and current row) c4
      from tt_sem t),
  pk as (select distinct on (m4.canal) m4.canal, m4.semana pico_fim, m4.mm4 pico_mm4 from m4 where m4.c4 = 4 order by m4.canal, m4.mm4 desc),
  sq as (
    select z.canal, coalesce(min(z.rn) filter (where z.caiu is not true), max(z.rn) + 1) - 1 seguidas
      from (select t.canal, t.rn, t.receita < lead(t.receita) over (partition by t.canal order by t.rn) caiu from tt_sem t) z
     group by z.canal),
  p as (
    select h.canal, max(h.tend) filter (where h.h = 'curto') tc, max(h.tend) filter (where h.h = 'medio') tm,
           max(h.tend) filter (where h.h = 'longo') tl
      from tt_h h group by h.canal),
  q as (
    select p.canal, p.tc, p.tm, p.tl, s.n13, sq.seguidas, pk.pico_fim,
           case when s.n13 >= 6 then round((s.slope / nullif(s.media13, 0)::float8 * 100)::numeric, 1) end incl,
           round((s.media4 / nullif(pk.pico_mm4, 0) - 1) * 100, 1) qpico
      from p left join s on s.canal = p.canal left join pk on pk.canal = p.canal left join sq on sq.canal = p.canal)
  select q.*,
         case
           when q.tm in ('sem_base', 'sem_venda') then q.tm
           when q.tm = 'queda' and (q.tl = 'queda' or coalesce(q.incl, 0) <= -1.5 or coalesce(q.qpico, 0) <= -25) then 'queda_persistente'
           when q.tm = 'queda' then 'queda_recente'
           when q.tm = 'alta' and q.tl = 'queda' then 'recuperando'
           when q.tm = 'alta' and (q.tl = 'alta' or coalesce(q.incl, 0) >= 1.5) then 'alta_persistente'
           when q.tm = 'alta' then 'alta_recente'
           when q.tl = 'queda' and q.tc = 'alta' then 'recuperando'
           when q.tl = 'queda' then 'estavel_apos_queda'
           when q.tl = 'alta' and q.tc = 'queda' then 'perdendo_folego'
           else 'estavel' end leitura
    from q;

  v_tp := v_tp || jsonb_build_object('ate_6', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 6. receita por produto vendido, 30 × 30 dias (pedidos válidos; TikTok não tem quebra por produto aqui) --
  create temp table tt_sku on commit drop as
  select l.canal, p.shop_id, x.sku, max(i.nome_produto) nome_item,
         coalesce(sum(i.subtotal_produto) filter (where x.dia >  v_ref - 30), 0)::numeric r1,
         coalesce(sum(i.subtotal_produto) filter (where x.dia <= v_ref - 30), 0)::numeric r0,
         coalesce(sum(i.quantidade)       filter (where x.dia >  v_ref - 30), 0)::numeric u1,
         coalesce(sum(i.quantidade)       filter (where x.dia <= v_ref - 30), 0)::numeric u0
    from pedidos_validos p
    join pedido_itens i on i.pedido_id = p.id
    join lojas lj on lj.shop_id = p.shop_id
    join tt_loja l on l.canal = lj.nome
   cross join lateral (select case when p.marketplace = 'amazon' then coalesce(nullif(i.sku_pai, ''), nullif(i.sku_filho, ''))
                                   else coalesce(nullif(i.sku_filho, ''), nullif(i.sku_pai, '')) end sku,
                              (p.data_pedido at time zone 'America/Sao_Paulo')::date dia) x
   where p.data_pedido >= (v_ref - 59)::timestamp at time zone 'America/Sao_Paulo'
     and p.data_pedido <  (v_ref + 1)::timestamp at time zone 'America/Sao_Paulo'
     and x.sku is not null
   group by l.canal, p.shop_id, x.sku;

  insert into tt_sku
  select 'Total', null, s.sku, max(s.nome_item), sum(s.r1), sum(s.r0), sum(s.u1), sum(s.u0) from tt_sku s group by s.sku;

  create temp table tt_top on commit drop as
  select z.canal, z.shop_id, z.sku, coalesce((select pr.nome from produtos pr where pr.sku = z.sku limit 1), z.nome_item, z.sku) nome,
         z.r1, z.r0, z.u1, z.u0, z.delta, z.lado, z.pos::int pos
    from (
      select s.*, s.r1 - s.r0 delta, 'queda'::text lado, row_number() over (partition by s.canal order by s.r1 - s.r0, s.sku) pos
        from tt_sku s where s.r1 - s.r0 <= -50
      union all
      select s.*, s.r1 - s.r0, 'alta', row_number() over (partition by s.canal order by s.r1 - s.r0 desc, s.sku)
        from tt_sku s where s.r1 - s.r0 >= 50) z
   where (z.lado = 'queda' and z.pos <= 8) or (z.lado = 'alta' and z.pos <= 5);

  v_tp := v_tp || jsonb_build_object('ate_7', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 7. retrato diário dos anúncios dos produtos em destaque (preço, promoção, estoque) -------------------
  create temp table tt_sr on commit drop as
  select t.shop_id, t.sku, s.data, s.anuncio_id, s.preco, s.estoque, s.em_promocao
    from (select distinct tt.shop_id, tt.sku from tt_top tt where tt.shop_id is not null) t
    join ads_anuncio_snapshot s on s.sku = t.sku and s.shop_id = t.shop_id and s.data between v_ref - 59 and v_ref
   where s.status in ('NORMAL', 'active')
     and (s.variacao_id <> ''
          or not exists (select 1 from ads_anuncio_snapshot v
                          where v.marketplace = s.marketplace and v.anuncio_id = s.anuncio_id and v.data = s.data and v.variacao_id > ''));

  create temp table tt_sd on commit drop as
  select s.shop_id, s.sku, s.data,
         coalesce(min(s.preco) filter (where s.estoque > 0), min(s.preco)) preco,
         sum(coalesce(s.estoque, 0)) estoque, bool_or(coalesce(s.em_promocao, false)) promo
    from tt_sr s group by s.shop_id, s.sku, s.data;

  create temp table tt_si on commit drop as
  select distinct s.shop_id, s.sku, s.anuncio_id from tt_sr s;

  create temp table tt_se on commit drop as
  select o.shop_id, o.sku,
         count(*) filter (where o.data >  v_ref - 30) d1, count(*) filter (where o.data <= v_ref - 30) d0,
         count(*) filter (where o.data >  v_ref - 30 and o.estoque = 0) z1,
         count(*) filter (where o.data <= v_ref - 30 and o.estoque = 0) z0,
         count(*) filter (where o.data >  v_ref - 30 and o.promo) pr1,
         count(*) filter (where o.data <= v_ref - 30 and o.promo) pr0,
         (array_agg(o.preco order by o.data))[1] p_ini, (array_agg(o.preco order by o.data desc))[1] p_fim,
         (array_agg(o.promo order by o.data))[1] e_ini, (array_agg(o.promo order by o.data desc))[1] e_fim,
         (array_agg(o.estoque order by o.data desc))[1] est_fim,
         max(o.data) filter (where o.p_ant is not null and abs(o.preco - o.p_ant) >= 0.01 * greatest(o.p_ant, 0.01)) dt_preco,
         max(o.data) filter (where o.e_ant is not null and o.promo is distinct from o.e_ant) dt_promo,
         min(o.data) dt_ini
    from (select d.*, lag(d.preco) over w p_ant, lag(d.promo) over w e_ant
            from tt_sd d window w as (partition by d.shop_id, d.sku order by d.data)) o
   group by o.shop_id, o.sku;

  -- ADS dos anúncios desses produtos (30 × 30)
  create temp table tt_sads on commit drop as
  select si.shop_id, si.sku,
         coalesce(sum(m.gasto) filter (where m.data >  v_ref - 30), 0) g1,
         coalesce(sum(m.gasto) filter (where m.data <= v_ref - 30), 0) g0
    from tt_si si
    join ads_metrica_anuncio_dia m
      on m.shop_id = si.shop_id and m.nivel = 'anuncio' and m.anuncio_id = si.anuncio_id
     and m.marketplace = case when si.shop_id in (522186766, 759046323) then 'shopee' else 'mercadolivre' end
     and m.data between v_ref - 59 and v_ref
   group by si.shop_id, si.sku;

  v_tp := v_tp || jsonb_build_object('ate_8', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 8. nossas mudanças (fonte única: anuncio_mudancas_lista) e o efeito 7 × 7 dias ------------------------
  v_dias_lista := least(greatest(v_hoje - v_ref, 1) + 31, 90);

  create temp table tt_mud on commit drop as
  with b as (
    select m.*, (m.quando at time zone 'America/Sao_Paulo')::date dia
      from anuncio_mudancas_lista(v_dias_lista) m where m.ok),
  a as (
    select b.mkt, b.shop_id, b.item_id, b.campo, b.dia,
           (array_agg(b.de order by b.quando))[1] de, (array_agg(b.para order by b.quando desc))[1] para,
           (array_agg(b.descricao order by b.quando desc))[1] descricao,
           (array_agg(b.origem order by b.quando desc))[1] origem
      from b where b.dia between v_ref - 29 and v_ref
     group by b.mkt, b.shop_id, b.item_id, b.campo, b.dia),
  c0 as (
    select a.*, tend_num(a.de) de_n, tend_num(a.para) para_n,
           case when a.campo = 'roas' then 'roas'
                when a.campo in ('preco_venda', 'preco_cheio') then 'preco'
                when a.campo in ('promocao', 'relampago') then 'promocao'
                when a.campo = 'orcamento' then 'orcamento'
                when a.campo in ('anuncio_criado', 'fotos', 'titulo', 'descricao', 'campanha_nova') then 'sistema'
                else 'situacao' end grupo
      from a),
  -- oscilação: preço ou promoção que muda e é desfeito em até 2 dias (relâmpago do dia). Numa sequência de
  -- idas e voltas os pares se anulam; se sobra uma mudança no fim, ela é a de verdade.
  c1 as (
    select c0.*,
           coalesce(c0.campo in ('preco_venda', 'promocao')
                    and c0.dia - lag(c0.dia) over w <= 2
                    and case when c0.campo = 'preco_venda' then abs(c0.para_n / nullif(lag(c0.de_n) over w, 0) - 1) < 0.01
                             else c0.para = lag(c0.de) over w end, false) desfaz
      from c0
    window w as (partition by c0.mkt, c0.shop_id, c0.item_id, c0.campo order by c0.dia)),
  c2 as (
    select c1.*,
           sum(case when c1.desfaz then 0 else 1 end) over (partition by c1.mkt, c1.shop_id, c1.item_id, c1.campo order by c1.dia) serie
      from c1),
  c as (
    select c2.*,
           case when (count(*) over s) % 2 = 0 then true
                else (row_number() over (s order by c2.dia)) < (count(*) over s) end oscilacao
      from c2
    window s as (partition by c2.mkt, c2.shop_id, c2.item_id, c2.campo, c2.serie))
  select c.mkt, c.shop_id, c.item_id, c.campo, c.dia, c.de, c.para, c.descricao, c.origem, c.de_n, c.para_n, c.grupo, c.oscilacao,
         case when c.grupo in ('roas', 'preco', 'orcamento') then case when c.para_n > c.de_n then 'subiu' when c.para_n < c.de_n then 'desceu' end
              when c.campo = 'promocao' then case when c.para = 'em promoção' then 'entrou' else 'saiu' end
              when c.campo = 'relampago' then 'saiu' end direcao,
         left(coalesce(sa.nome, ma.titulo, c.item_id), 90) nome, coalesce(sa.sku_pai, ma.sku) sku,
         coalesce(lj.loja, case c.mkt when 'shopee' then 'Shopee ' when 'ml' then 'Mercado Livre ' when 'amazon' then 'Amazon ' when 'tiktok' then 'TikTok ' else '' end
                           || anuncio_loja(c.shop_id)) loja,
         coalesce(lj.slug, c.mkt || '-' || c.shop_id::text) slug
    from c
    left join shopee_anuncios sa on c.mkt = 'shopee' and sa.shop_id = c.shop_id and sa.item_id::text = c.item_id
    left join ml_anuncios ma on c.mkt = 'ml' and ma.mlb = c.item_id
    left join tt_loja lj on lj.shop_id = c.shop_id
   where not (c.campo in ('roas', 'orcamento', 'preco_venda', 'preco_cheio', 'promocao', 'campanha', 'status_anuncio', 'titulo')
              and c.de is not distinct from c.para)
     and not (c.grupo = 'preco' and (c.de_n is null or c.para_n is null or c.de_n <= 0 or abs(c.para_n / c.de_n - 1) < 0.03));

  create temp table tt_ad on commit drop as
  select a.mkt, a.shop_id, a.item_id, a.data, a.venda, a.gasto, a.vendas_ads, a.margem_pos
    from anuncio_dia(v_ref - 37, v_ref) a;

  -- efeito: 7 dias antes × até 7 dias a partir da mudança, descontado o movimento da LOJA nas mesmas janelas
  -- (fator = receita por dia da loja depois ÷ antes). Sem isso tudo "melhora" antes do 11.11 e "piora" depois.
  create temp table tt_ef on commit drop as
  with j as (
    select m.mkt, m.shop_id, m.item_id, m.dia, m.grupo,
           (array_agg(m.campo order by m.campo))[1] campo,
           (array_agg(m.de order by m.campo desc))[1] de, (array_agg(m.para order by m.campo desc))[1] para,
           (array_agg(m.direcao order by m.campo desc))[1] direcao,
           string_agg(distinct m.descricao, ', ') descricao, max(m.origem) origem,
           max(m.nome) nome, max(m.sku) sku, max(m.loja) loja, max(m.slug) slug
      from tt_mud m where not m.oscilacao
     group by m.mkt, m.shop_id, m.item_id, m.dia, m.grupo),
  e as (
    select j.*, least(v_ref - j.dia + 1, 7)::int dias_depois,
           coalesce(sum(a.venda)      filter (where a.data <  j.dia), 0) rec_a,
           coalesce(sum(a.venda)      filter (where a.data >= j.dia), 0) rec_d,
           coalesce(sum(a.gasto)      filter (where a.data <  j.dia), 0) g_a,
           coalesce(sum(a.gasto)      filter (where a.data >= j.dia), 0) g_d,
           coalesce(sum(a.vendas_ads) filter (where a.data <  j.dia), 0) va_a,
           coalesce(sum(a.vendas_ads) filter (where a.data >= j.dia), 0) va_d,
           coalesce(sum(a.margem_pos) filter (where a.data <  j.dia), 0) mp_a,
           coalesce(sum(a.margem_pos) filter (where a.data >= j.dia), 0) mp_d
      from j
      left join tt_ad a on a.mkt = j.mkt and a.shop_id = j.shop_id and a.item_id = j.item_id
                       and a.data between j.dia - 7 and least(j.dia + 6, v_ref)
     group by j.mkt, j.shop_id, j.item_id, j.dia, j.grupo, j.campo, j.de, j.para, j.direcao, j.descricao, j.origem, j.nome, j.sku, j.loja, j.slug),
  lw as (
    select w.shop_id, w.dia,
           (select coalesce(sum(d.venda), 0) from tt_dia d where d.shop_id = w.shop_id and d.dia between w.dia - 7 and w.dia - 1) loja_a,
           (select coalesce(sum(d.venda), 0) from tt_dia d where d.shop_id = w.shop_id and d.dia between w.dia and least(w.dia + 6, v_ref)) loja_d
      from (select distinct j.shop_id, j.dia from j) w),
  k as (
    select e.*, coalesce(lw.loja_a, 0) loja_a, coalesce(lw.loja_d, 0) loja_d,
           case when lw.loja_a > 0 and lw.loja_d > 0 then (lw.loja_d / e.dias_depois) / (lw.loja_a / 7) else 1 end fator,
           (row_number() over (partition by e.mkt, e.shop_id, e.item_id, e.grupo order by e.dia)) = 1 primeira
      from e left join lw on lw.shop_id = e.shop_id and lw.dia = e.dia)
  select k.*,
         round(k.rec_d * 7.0 / k.dias_depois, 2) rec_d7, round(k.g_d * 7.0 / k.dias_depois, 2) g_d7,
         round(k.va_d * 7.0 / k.dias_depois, 2) va_d7, round(k.mp_d * 7.0 / k.dias_depois, 2) mp_d7,
         round(k.rec_a * k.fator, 2) esp7,
         round(k.rec_d * 7.0 / k.dias_depois - k.rec_a * k.fator, 2) delta7,
         round(k.rec_d * 7.0 / k.dias_depois - k.rec_a, 2) delta7_bruto,
         case when k.dias_depois < 3 then 'medindo'
              when k.rec_a >= 200 and k.rec_d * 7.0 / k.dias_depois < 0.7 * k.rec_a * k.fator then 'piorou'
              when k.rec_d * 7.0 / k.dias_depois >= 200 and k.rec_d * 7.0 / k.dias_depois > 1.3 * greatest(k.rec_a * k.fator, 1) then 'melhorou'
              else 'sem_efeito' end efeito,
         case when k.dias_depois < 3 then 'medindo'
              when k.rec_a >= 200 and k.rec_d / k.dias_depois < 0.7 * k.rec_a / 7 then 'piorou'
              when k.rec_d >= 200 and k.rec_d / k.dias_depois > 1.3 * greatest(k.rec_a, 1) / 7 then 'melhorou'
              else 'sem_efeito' end efeito_bruto
    from k;

  v_tp := v_tp || jsonb_build_object('ate_9', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 9. o que mudou em cada produto em destaque ---------------------------------------------------------------
  create temp table tt_ev on commit drop as
  with mu as (
    select si.shop_id, si.sku,
           bool_or(m.campo = 'roas' and m.para_n > m.de_n) roas_up,
           bool_or(m.campo = 'roas' and m.para_n < m.de_n) roas_down,
           bool_or(m.grupo = 'sistema' or m.campo = 'preco_cheio') sistema,
           (array_agg('meta de ROAS de ' || replace(m.de, '.', ',') || ' para ' || replace(m.para, '.', ',') || ' em ' || to_char(m.dia, 'DD/MM')
                      order by m.dia desc) filter (where m.campo = 'roas'))[1] t_roas,
           (array_agg('alteração pelo sistema em ' || to_char(m.dia, 'DD/MM') || ': ' || m.descricao
                      order by m.dia desc) filter (where m.grupo = 'sistema' or m.campo = 'preco_cheio'))[1] t_sis,
           (array_agg(case when m.campo = 'roas' then 'meta de ROAS de ' || replace(m.de, '.', ',') || ' para ' || replace(m.para, '.', ',')
                           when m.campo = 'orcamento' then 'orçamento diário de ADS de ' || replace(m.de, '.', ',') || ' para ' || replace(m.para, '.', ',')
                           when m.campo in ('campanha', 'status_anuncio') then m.descricao || ' de ' || coalesce(m.de, '?') || ' para ' || coalesce(m.para, '?')
                           when m.campo = 'relampago' then 'saiu da programação da relâmpago' else 'alteração pelo sistema: ' || m.descricao end || ' em ' || to_char(m.dia, 'DD/MM')
                      order by m.dia desc, m.campo))[1:4] textos
      from tt_si si join tt_mud m on m.shop_id = si.shop_id and m.item_id = si.anuncio_id
     where m.campo not in ('preco_venda', 'promocao')          -- preço e promoção já vêm do retrato por produto
     group by si.shop_id, si.sku),
  b as (
    select t.*, e.d1, e.d0, e.z1, e.z0, e.pr1, e.pr0, e.p_ini, e.p_fim, e.e_ini, e.e_fim, e.est_fim, e.dt_preco, e.dt_promo,
           (e.sku is not null) tem_retrato, a.g1, a.g0, mu.roas_up, mu.roas_down, mu.sistema, mu.t_roas, mu.t_sis, mu.textos,
           t.r1 / nullif(t.u1, 0) pm1, t.r0 / nullif(t.u0, 0) pm0
      from tt_top t
      left join tt_se e on e.shop_id = t.shop_id and e.sku = t.sku
      left join tt_sads a on a.shop_id = t.shop_id and a.sku = t.sku
      left join mu on mu.shop_id = t.shop_id and mu.sku = t.sku),
  f as (
    select b.*,
           coalesce(b.p_ini > 0 and b.p_fim >= b.p_ini * 1.03, false) or (not b.tem_retrato and coalesce(b.pm1 >= b.pm0 * 1.05, false)) preco_up,
           coalesce(b.p_ini > 0 and b.p_fim <= b.p_ini * 0.97, false) or (not b.tem_retrato and coalesce(b.pm1 <= b.pm0 * 0.95, false)) preco_down,
           coalesce(b.e_ini and not b.e_fim, false) promo_saiu,
           coalesce(not b.e_ini and b.e_fim, false) promo_entrou,
           coalesce(b.z1 >= 3 and (b.z1::numeric / nullif(b.d1, 0) >= 0.5 or b.d0 = 0
                                   or b.z1::numeric / nullif(b.d1, 0) > b.z0::numeric / nullif(b.d0, 0) + 0.10), false) est_pior,
           coalesce(b.d0 > 0 and b.z0 >= 3 and b.d1 > 0 and b.z1::numeric / b.d1 < b.z0::numeric / b.d0 - 0.10, false) est_melhor,
           coalesce(b.g0 >= 30 and b.g1 < 0.7 * b.g0, false) ads_down,
           coalesce(b.g1 >= 30 and b.g1 > 1.3 * b.g0, false) ads_up
      from b),
  x as (
    select f.*,
           case when f.tem_retrato and f.p_ini > 0 and abs(f.p_fim / f.p_ini - 1) >= 0.03
                then 'preço no anúncio ' || case when f.p_fim > f.p_ini then 'subiu' else 'desceu' end || ' de ' || tend_n2(f.p_ini) || ' para ' || tend_n2(f.p_fim)
                     || coalesce(' (última alteração em ' || to_char(f.dt_preco, 'DD/MM') || ')', '')
                when not f.tem_retrato and f.pm0 > 0 and f.pm1 > 0 and abs(f.pm1 / f.pm0 - 1) >= 0.05
                then 'preço médio vendido de ' || tend_n2(f.pm0) || ' para ' || tend_n2(f.pm1) end txt_preco,
           case when f.promo_saiu then 'saiu da promoção' || coalesce(' em ' || to_char(f.dt_promo, 'DD/MM'), '')
                when f.promo_entrou then 'entrou em promoção' || coalesce(' em ' || to_char(f.dt_promo, 'DD/MM'), '') end txt_promo,
           case when f.est_pior then 'ficou ' || f.z1 || ' de ' || f.d1 || ' dias sem estoque no anúncio'
                                     || case when f.d0 > 0 then ' (antes: ' || f.z0 || ' de ' || f.d0 || ' dias medidos)' else '' end
                when f.est_melhor then 'voltou a ter estoque no anúncio (antes: ' || f.z0 || ' de ' || f.d0 || ' dias zerado; agora ' || f.z1 || ' de ' || f.d1 || ')' end txt_est,
           case when f.ads_down then 'ADS do anúncio caiu de ' || tend_rs(f.g0) || ' para ' || tend_rs(f.g1)
                when f.ads_up then 'ADS do anúncio subiu de ' || tend_rs(f.g0) || ' para ' || tend_rs(f.g1) end txt_ads
      from f)
  select x.canal, x.shop_id, x.sku, x.nome, x.lado, x.pos, x.delta, x.r1, x.r0, x.u1, x.u0, x.tem_retrato,
         x.preco_up, x.preco_down, x.promo_saiu, x.promo_entrou, x.est_pior, x.est_melhor, x.ads_down, x.ads_up,
         coalesce(x.roas_up, false) roas_up, coalesce(x.roas_down, false) roas_down, coalesce(x.sistema, false) sistema,
         x.est_fim, x.txt_preco, x.txt_promo, x.txt_est, x.txt_ads, x.t_roas, x.t_sis,
         case when x.canal = 'Total' then
           coalesce((select array_agg(l.loja || ': ' || tend_rs(s.r0) || ' → ' || tend_rs(s.r1) order by abs(s.r1 - s.r0) desc)
                       from tt_sku s join tt_loja l on l.canal = s.canal
                      where s.sku = x.sku and s.canal <> 'Total' and abs(s.r1 - s.r0) >= 50), '{}')
         else
           array_remove(array[
             case when x.r0 = 0 then 'não vendia nos 30 dias anteriores' when x.r1 = 0 then 'não vendeu nos últimos 30 dias' end,
             case when x.tem_retrato and x.pm0 > 0 and x.pm1 > 0 and abs(x.pm1 / x.pm0 - 1) >= 0.03
                  then 'preço médio vendido de ' || tend_n2(x.pm0) || ' para ' || tend_n2(x.pm1) end,
             x.txt_preco, x.txt_promo, x.txt_est,
             case when x.est_fim = 0 then 'anúncio sem estoque em ' || to_char(v_ref, 'DD/MM') end,
             x.txt_ads], null) || coalesce(x.textos, '{}')
         end mudou
    from x;

  v_tp := v_tp || jsonb_build_object('ate_10', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 10. causas candidatas --------------------------------------------------------------------------------
  create temp table tt_causa (canal text, tipo text, sentido text, titulo text, detalhe text, impacto numeric, sku text, prio int) on commit drop;

  -- 10a. volume × ticket
  insert into tt_causa
  select m.canal, 'outro', case when m.ef_vol < 0 then 'negativo' else 'positivo' end,
         case when m.ef_vol < 0 then 'Menos pedidos: ' else 'Mais pedidos: ' end || abs(m.pedidos - m.pedidos_ant)::int || ' a ' || case when m.ef_vol < 0 then 'menos' else 'mais' end,
         'pedidos de ' || m.pedidos_ant::int || ' para ' || m.pedidos::int || ' (' || tend_pc((m.pedidos / m.pedidos_ant - 1) * 100) || '); ticket médio de '
           || tend_n2(m.receita_ant / m.pedidos_ant) || ' para ' || tend_n2(m.receita / m.pedidos),
         round(m.ef_vol, 2), null, 0
    from (select h.*, (h.pedidos - h.pedidos_ant) * (h.receita_ant / h.pedidos_ant) ef_vol
            from tt_h h where h.h = 'medio' and h.dias_ant = h.n and h.dias_cur = h.n and h.pedidos > 0 and h.pedidos_ant > 0) m
   where abs(m.receita - m.receita_ant) >= 200 and abs(m.ef_vol) >= 0.3 * abs(m.receita - m.receita_ant);

  insert into tt_causa
  select m.canal, 'ticket', case when m.ef_tic < 0 then 'negativo' else 'positivo' end,
         'Ticket médio ' || case when m.ef_tic < 0 then 'caiu' else 'subiu' end || ' de R$ ' || tend_n2(m.receita_ant / m.pedidos_ant) || ' para R$ ' || tend_n2(m.receita / m.pedidos),
         'cada pedido vale ' || tend_pc(((m.receita / m.pedidos) / (m.receita_ant / m.pedidos_ant) - 1) * 100) || '; com ' || m.pedidos::int || ' pedidos isso dá ' || tend_rs(m.ef_tic),
         round(m.ef_tic, 2), null, 0
    from (select h.*, (h.receita / h.pedidos - h.receita_ant / h.pedidos_ant) * h.pedidos ef_tic
            from tt_h h where h.h = 'medio' and h.dias_ant = h.n and h.dias_cur = h.n and h.pedidos > 0 and h.pedidos_ant > 0) m
   where abs(m.receita - m.receita_ant) >= 200 and abs(m.ef_tic) >= 0.3 * abs(m.receita - m.receita_ant);

  -- 10b. ADS da loja
  insert into tt_causa
  select m.canal, 'ads_gasto',
         case when m.d_rec < 0 and (m.d_g < 0 or m.roas1 < m.roas0) then 'negativo'
              when m.d_rec > 0 and (m.d_g > 0 or m.roas1 > m.roas0) then 'positivo'
              when m.d_rec < 0 then 'negativo' else 'positivo' end,
         case when abs(m.d_g) >= 0.15 * m.ads_ant and sign(m.d_g) = sign(m.d_rec)
                then 'Gasto de ADS ' || case when m.d_g < 0 then 'caiu ' else 'subiu ' end || ltrim(tend_pc(abs(m.d_g) / m.ads_ant * 100), '+') || ' junto com a receita'
              when abs(m.d_g) >= 0.15 * m.ads_ant and m.d_g > 0
                then 'ADS subiu ' || ltrim(tend_pc(m.d_g / m.ads_ant * 100), '+') || ' e a receita caiu: os anúncios renderam menos'
              when abs(m.d_g) >= 0.15 * m.ads_ant
                then 'Receita subiu com ' || tend_pc(m.d_g / m.ads_ant * 100) || ' de ADS'
              when m.roas1 < m.roas0 then 'ADS rendeu menos: ROAS de ' || tend_n2(m.roas0) || ' para ' || tend_n2(m.roas1)
              else 'ADS rendeu mais: ROAS de ' || tend_n2(m.roas0) || ' para ' || tend_n2(m.roas1) end,
         'ADS de ' || tend_rs(m.ads_ant) || ' para ' || tend_rs(m.ads) || '; ROAS de ' || tend_n2(m.roas0) || ' para ' || tend_n2(m.roas1)
           || '; ADS sobre a receita de ' || tend_n2(m.ads_ant / nullif(m.receita_ant, 0) * 100) || '% para ' || tend_n2(m.ads / nullif(m.receita, 0) * 100) || '% (impacto estimado pelo ROAS e limitado à variação da receita: é teto, não medida)',
         round(case when abs(m.d_g) >= 0.15 * m.ads_ant and sign(m.d_g) = sign(m.d_rec)
                      then sign(m.d_rec) * least(abs(m.d_g * m.roas0), abs(m.d_rec))
                    when abs(m.d_g) >= 0.15 * m.ads_ant and m.d_g > 0
                      then -least(abs((m.roas1 - m.roas0) * m.ads), abs(m.d_rec))
                    when abs(m.d_g) >= 0.15 * m.ads_ant then -m.d_g
                    else sign(m.roas1 - m.roas0) * least(abs((m.roas1 - m.roas0) * m.ads), abs(m.d_rec)) end, 2),
         null, 0
    from (select h.*, h.ads - h.ads_ant d_g, h.receita - h.receita_ant d_rec,
                 h.vads / nullif(h.ads, 0) roas1, h.vads_ant / nullif(h.ads_ant, 0) roas0
            from tt_h h where h.h = 'medio' and h.dias_ant = h.n and h.dias_cur = h.n and h.ads_ant >= 100 and h.ads >= 1) m
   where abs(m.d_rec) >= 200
     and (abs(m.d_g) >= 0.15 * m.ads_ant or abs(m.roas1 / nullif(m.roas0, 0) - 1) >= 0.15);

  -- 10c. concentração em poucos produtos, produtos que pararam e produtos novos
  insert into tt_causa
  select g.canal, 'mix', 'negativo',
         'Os 3 produtos que mais caíram somam ' || tend_rs(g.top3n),
         'SKUs ' || g.skn || ' = ' || round(g.top3n / g.neg * 100)::int || '% de tudo que caiu (' || tend_rs(g.neg) || '); o que subiu soma ' || tend_rs(coalesce(g.pos, 0)),
         round(g.top3n, 2), null, 0
    from (select z.canal, sum(z.delta) filter (where z.delta < 0) neg, sum(z.delta) filter (where z.delta > 0) pos,
                 sum(z.delta) filter (where z.pq <= 3 and z.delta < 0) top3n,
                 string_agg(z.sku, ', ' order by z.pq) filter (where z.pq <= 3 and z.delta < 0) skn
            from (select s.canal, s.sku, s.r1 - s.r0 delta, row_number() over (partition by s.canal order by s.r1 - s.r0, s.sku) pq from tt_sku s) z
           group by z.canal) g
    join tt_tend t on t.canal = g.canal
   where t.tm = 'queda' and g.top3n <= -500;

  insert into tt_causa
  select g.canal, 'mix', 'positivo',
         'Os 3 produtos que mais subiram somam ' || tend_rs(g.top3p),
         'SKUs ' || g.skp || ' = ' || round(g.top3p / g.pos * 100)::int || '% de tudo que subiu (' || tend_rs(g.pos) || '); o que caiu soma ' || tend_rs(coalesce(g.neg, 0)),
         round(g.top3p, 2), null, 0
    from (select z.canal, sum(z.delta) filter (where z.delta < 0) neg, sum(z.delta) filter (where z.delta > 0) pos,
                 sum(z.delta) filter (where z.pa <= 3 and z.delta > 0) top3p,
                 string_agg(z.sku, ', ' order by z.pa) filter (where z.pa <= 3 and z.delta > 0) skp
            from (select s.canal, s.sku, s.r1 - s.r0 delta, row_number() over (partition by s.canal order by s.r1 - s.r0 desc, s.sku) pa from tt_sku s) z
           group by z.canal) g
    join tt_tend t on t.canal = g.canal
   where t.tm = 'alta' and g.top3p >= 500;

  insert into tt_causa
  select g.canal, 'mix', 'negativo',
         g.n || ' produtos pararam de vender',
         'vendiam ' || tend_rs(g.v) || ' nos 30 dias anteriores e nada agora: ' || g.sk,
         -round(g.v, 2), null, 0
    from (select s.canal, count(*) n, sum(s.r0) v,
                 (array_to_string((array_agg(s.sku order by s.r0 desc))[1:6], ', ')) sk
            from tt_sku s where s.r1 = 0 and s.r0 >= 300 group by s.canal) g
    join tt_h h on h.canal = g.canal and h.h = 'medio'
   where g.v >= greatest(1000, 0.02 * h.receita_ant);

  insert into tt_causa
  select g.canal, 'mix', 'positivo',
         g.n || ' produtos novos (ou que voltaram) venderam ' || tend_rs(g.v),
         'não vendiam nos 30 dias anteriores: ' || g.sk,
         round(g.v, 2), null, 0
    from (select s.canal, count(*) n, sum(s.r1) v,
                 (array_to_string((array_agg(s.sku order by s.r1 desc))[1:6], ', ')) sk
            from tt_sku s where s.r0 = 0 and s.r1 >= 300 group by s.canal) g
    join tt_h h on h.canal = g.canal and h.h = 'medio'
   where g.v >= greatest(1000, 0.02 * h.receita);

  -- 10d. relâmpago da Shopee: dias sem itens
  insert into tt_causa
  select q.canal, 'relampago', case when q.s1 > q.s0 then 'negativo' else 'positivo' end,
         'Relâmpago: ' || q.s1 || ' dias sem itens (antes ' || q.s0 || ')',
         'nos últimos 60 dias a loja vendeu em média ' || tend_rs(q.m_com) || ' por dia com relâmpago e ' || tend_rs(q.m_sem) || ' sem',
         case when q.m_com > q.m_sem then round(-(q.s1 - q.s0) * (q.m_com - q.m_sem), 2) end, null, 0
    from (select f.canal,
                 count(*) filter (where not f.tem and f.dia >  v_ref - 30) s1,
                 count(*) filter (where not f.tem and f.dia <= v_ref - 30) s0,
                 avg(f.venda) filter (where f.tem) m_com, avg(f.venda) filter (where not f.tem) m_sem
            from (select l.canal, gs::date dia,
                         exists (select 1 from flashsale_criadas fc where fc.shop_id = l.shop_id and fc.dia = gs::date and coalesce(fc.itens_ok, 0) > 0) tem,
                         coalesce((select t.venda from tt_dia t where t.canal = l.canal and t.dia = gs::date), 0) venda
                    from tt_loja l cross join generate_series(v_ref - 59, v_ref, interval '1 day') gs
                   where l.marketplace = 'shopee' and l.shop_id is not null
                     and exists (select 1 from flashsale_criadas f0 where f0.shop_id = l.shop_id and f0.dia <= v_ref - 59)) f
           group by f.canal) q
   where abs(q.s1 - q.s0) >= 3;

  -- 10e. devoluções abertas na Shopee
  insert into tt_causa
  select q.canal, 'devolucao', case when q.v1 > q.v0 then 'negativo' else 'positivo' end,
         'Devoluções ' || case when q.v1 > q.v0 then 'subiram' else 'caíram' end || ': ' || tend_rs(q.v0) || ' para ' || tend_rs(q.v1),
         q.n1 || ' pedidos de devolução/reembolso abertos em 30 dias contra ' || q.n0 || ' nos 30 anteriores (pesa na margem, não na receita)',
         round(-(q.v1 - q.v0), 2), null, 0
    from (select l.canal,
                 count(*) filter (where x.dia >  v_ref - 30) n1, count(*) filter (where x.dia <= v_ref - 30) n0,
                 coalesce(sum(d.refund_amount) filter (where x.dia >  v_ref - 30), 0) v1,
                 coalesce(sum(d.refund_amount) filter (where x.dia <= v_ref - 30), 0) v0
            from shopee_devolucoes d
            join tt_loja l on l.shop_id = d.shop_id
           cross join lateral (select (d.create_time at time zone 'America/Sao_Paulo')::date dia) x
           where d.create_time >= (v_ref - 59)::timestamp at time zone 'America/Sao_Paulo'
             and d.create_time <  (v_ref + 1)::timestamp at time zone 'America/Sao_Paulo'
             and coalesce(d.status, '') <> 'CANCELLED'
           group by l.canal) q
   where (q.v1 >= 300 and q.v1 > 1.3 * q.v0) or (q.v0 >= 300 and q.v1 < 0.7 * q.v0);

  -- 10f. por produto (no máximo 2 motivos por produto e 5 por loja)
  insert into tt_causa
  select k.canal, k.tipo, k.sentido, k.titulo, k.detalhe, k.impacto, k.sku, k.prio
    from (
      select e.canal, c.tipo, case when e.lado = 'queda' then 'negativo' else 'positivo' end sentido,
             c.titulo || ' — SKU ' || e.sku titulo,
             left(e.nome, 60) || ': ' || c.det || '; receita do produto de ' || tend_rs(e.r0) || ' para ' || tend_rs(e.r1) detalhe,
             round(e.delta, 2) impacto, e.sku, c.prio,
             row_number() over (partition by e.canal, e.sku order by c.prio) rk,
             dense_rank() over (partition by e.canal order by abs(e.delta) desc, e.sku) rs
        from tt_ev e
       cross join lateral (values
             ('estoque',   1, 'Ficou sem estoque no anúncio', e.txt_est,   e.lado = 'queda' and e.est_pior),
             ('estoque',   1, 'Voltou a ter estoque',         e.txt_est,   e.lado = 'alta'  and e.est_melhor),
             ('preco',     2, 'Preço subiu',                  e.txt_preco, e.lado = 'queda' and e.preco_up),
             ('preco',     2, 'Preço desceu',                 e.txt_preco, e.lado = 'alta'  and e.preco_down),
             ('promocao',  3, 'Saiu da promoção',             e.txt_promo, e.lado = 'queda' and e.promo_saiu),
             ('promocao',  3, 'Entrou em promoção',           e.txt_promo, e.lado = 'alta'  and e.promo_entrou),
             ('ads_meta',  4, 'Meta de ROAS subiu',           e.t_roas,    e.lado = 'queda' and e.roas_up),
             ('ads_meta',  4, 'Meta de ROAS baixou',          e.t_roas,    e.lado = 'alta'  and e.roas_down),
             ('ads_gasto', 5, 'ADS do anúncio caiu',          e.txt_ads,   e.lado = 'queda' and e.ads_down),
             ('ads_gasto', 5, 'ADS do anúncio subiu',         e.txt_ads,   e.lado = 'alta'  and e.ads_up),
             ('anuncio',   6, 'Anúncio alterado pelo sistema', e.t_sis,    e.sistema)
           ) c(tipo, prio, titulo, det, vale)
       where c.vale and c.det is not null and e.canal <> 'Total') k
   where k.rk <= 2 and k.rs <= 5;

  -- loja em queda ou em alta sem nenhum motivo encontrado
  insert into tt_causa
  select t.canal, 'outro', case when t.tm = 'queda' then 'negativo' else 'positivo' end,
         'Sem causa identificada nos dados', 'nenhuma das regras (preço, promoção, estoque, ADS, mix, ticket, relâmpago, devolução) apontou mudança no período',
         null, null, 9
    from tt_tend t
   where t.tm in ('queda', 'alta') and not exists (select 1 from tt_causa c where c.canal = t.canal);

  v_tp := v_tp || jsonb_build_object('ate_11', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 11. JSON das lojas ----------------------------------------------------------------------------------------
  select jsonb_agg(jsonb_build_object(
           'loja', l.loja, 'marketplace', l.marketplace, 'empresa', l.empresa, 'shop_id', l.shop_id::text, 'canal', l.canal,
           'dados_desde', l.inicio,
           'curto', hz.j -> 'curto', 'medio', hz.j -> 'medio', 'longo', hz.j -> 'longo',
           'semanas', coalesce(sm.j, '[]'::jsonb),
           'tendencia', jsonb_build_object('curto', t.tc, 'medio', t.tm, 'longo', t.tl,
                          'inclinacao_13_semanas_pct', t.incl, 'semanas_seguidas_de_queda', t.seguidas,
                          'pico_4_semanas_ate', t.pico_fim + 6, 'vs_pico_pct', t.qpico),
           'leitura', t.leitura,
           'causas', coalesce(cs.j, '[]'::jsonb),
           'skus_queda', coalesce(sq.j, '[]'::jsonb),
           'skus_alta', coalesce(sa.j, '[]'::jsonb)) order by l.ord)
    into v_lojas
    from tt_loja l
    join tt_tend t on t.canal = l.canal
    left join lateral (
      select jsonb_object_agg(h.h, jsonb_build_object(
               'dias', h.n, 'receita', round(h.receita, 2), 'receita_ant', round(h.receita_ant, 2), 'var_pct', h.var_pct,
               'pedidos', h.pedidos::int, 'pedidos_ant', h.pedidos_ant::int,
               'margem', round(h.margem, 2), 'margem_ant', round(h.margem_ant, 2),
               'mc_pct', round(h.margem / nullif(h.receita, 0) * 100, 1), 'mc_pct_ant', round(h.margem_ant / nullif(h.receita_ant, 0) * 100, 1),
               'ads', case when l.tem_ads then round(coalesce(h.ads, 0), 2) end,
               'ads_ant', case when l.tem_ads then round(coalesce(h.ads_ant, 0), 2) end,
               'ticket', round(h.receita / nullif(h.pedidos, 0), 2), 'ticket_ant', round(h.receita_ant / nullif(h.pedidos_ant, 0), 2),
               'roas', round(h.vads / nullif(h.ads, 0), 2), 'roas_ant', round(h.vads_ant / nullif(h.ads_ant, 0), 2),
               'ads_sobre_receita_pct', case when l.tem_ads then round(h.ads / nullif(h.receita, 0) * 100, 1) end,
               'ads_sobre_receita_pct_ant', case when l.tem_ads then round(h.ads_ant / nullif(h.receita_ant, 0) * 100, 1) end,
               'dias_com_dado', h.dias_cur, 'dias_com_dado_ant', h.dias_ant,
               'base_incompleta', (h.dias_ant < h.n or h.dias_cur < h.n))) j
        from tt_h h where h.canal = l.canal) hz on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('semana', s.semana, 'receita', round(s.receita, 2), 'pedidos', s.pedidos::int,
                                          'margem', round(s.margem, 2), 'ads', case when l.tem_ads then round(coalesce(s.ads, 0), 2) end) order by s.semana) j
        from tt_sem s where s.canal = l.canal) sm on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('tipo', c.tipo, 'sentido', c.sentido, 'titulo', c.titulo, 'detalhe', c.detalhe,
                                          'impacto_rs', c.impacto, 'sku', c.sku) order by c.o) j
        from (select cc.*, row_number() over (order by abs(cc.impacto) desc nulls last, cc.prio, cc.titulo) o
                from tt_causa cc where cc.canal = l.canal) c
       where c.o <= 8) cs on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('sku', e.sku, 'nome', e.nome, 'receita', round(e.r1, 2), 'receita_ant', round(e.r0, 2),
                                          'delta', round(e.delta, 2), 'unidades', round(e.u1)::int, 'unidades_ant', round(e.u0)::int,
                                          'o_que_mudou', to_jsonb(e.mudou)) order by e.pos) j
        from tt_ev e where e.canal = l.canal and e.lado = 'queda') sq on true
    left join lateral (
      select jsonb_agg(jsonb_build_object('sku', e.sku, 'nome', e.nome, 'receita', round(e.r1, 2), 'receita_ant', round(e.r0, 2),
                                          'delta', round(e.delta, 2), 'unidades', round(e.u1)::int, 'unidades_ant', round(e.u0)::int,
                                          'o_que_mudou', to_jsonb(e.mudou)) order by e.pos) j
        from tt_ev e where e.canal = l.canal and e.lado = 'alta') sa on true;

  v_tp := v_tp || jsonb_build_object('ate_12', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 12. JSON das mudanças ---------------------------------------------------------------------------------
  -- contagens = todas as mudanças; somas antes/depois = só a 1ª mudança de cada anúncio no grupo (o mesmo anúncio não conta duas vezes)
  with a as (
    select e.grupo, e.direcao, count(*) n, count(distinct e.mkt || ':' || e.item_id) anuncios,
           count(*) filter (where e.efeito = 'melhorou') melhorou, count(*) filter (where e.efeito = 'piorou') piorou,
           count(*) filter (where e.efeito = 'sem_efeito') sem_efeito, count(*) filter (where e.efeito = 'medindo') medindo,
           count(*) filter (where e.efeito_bruto = 'melhorou') melhorou_bruto, count(*) filter (where e.efeito_bruto = 'piorou') piorou_bruto,
           count(*) filter (where e.primeira and e.efeito <> 'medindo') medidos,
           coalesce(sum(e.rec_a)  filter (where e.primeira and e.efeito <> 'medindo'), 0) rec_a,
           coalesce(sum(e.rec_d7) filter (where e.primeira and e.efeito <> 'medindo'), 0) rec_d,
           coalesce(sum(e.esp7)   filter (where e.primeira and e.efeito <> 'medindo'), 0) esp,
           coalesce(sum(e.g_a)    filter (where e.primeira and e.efeito <> 'medindo'), 0) g_a,
           coalesce(sum(e.g_d7)   filter (where e.primeira and e.efeito <> 'medindo'), 0) g_d,
           coalesce(sum(e.va_a)   filter (where e.primeira and e.efeito <> 'medindo'), 0) va_a,
           coalesce(sum(e.va_d7)  filter (where e.primeira and e.efeito <> 'medindo'), 0) va_d,
           grouping(e.direcao) gd
      from tt_ef e group by grouping sets ((e.grupo), (e.grupo, e.direcao))),
  o as (
    select a.grupo, a.direcao, a.gd,
           jsonb_build_object('n', a.n, 'anuncios', a.anuncios, 'melhorou', a.melhorou, 'piorou', a.piorou, 'sem_efeito', a.sem_efeito, 'medindo', a.medindo,
             'melhorou_bruto', a.melhorou_bruto, 'piorou_bruto', a.piorou_bruto, 'anuncios_medidos', a.medidos,
             'antes', jsonb_build_object('receita', round(a.rec_a, 2), 'gasto', round(a.g_a, 2), 'roas', round(a.va_a / nullif(a.g_a, 0), 2)),
             'depois', jsonb_build_object('receita', round(a.rec_d, 2), 'gasto', round(a.g_d, 2), 'roas', round(a.va_d / nullif(a.g_d, 0), 2),
                                          'receita_se_seguisse_a_loja', round(a.esp, 2))) j
      from a)
  select jsonb_object_agg(g.grupo, g.j) into v_g
    from (select o.grupo,
                 (max(o.j::text) filter (where o.gd = 1))::jsonb
                 || coalesce(jsonb_object_agg(o.direcao, o.j) filter (where o.gd = 0 and o.direcao is not null), '{}'::jsonb) j
            from o group by o.grupo) g;
  v_g := coalesce(v_g, '{}'::jsonb);

  -- exemplos: até 5 por grupo, um por anúncio (a mudança de maior efeito de cada um)
  select jsonb_object_agg(z.grupo, z.j) into v_ex
    from (select y.grupo, jsonb_agg(y.j order by y.rn) j
            from (select x.grupo, row_number() over (partition by x.grupo order by abs(x.delta7) desc, x.item_id) rn,
                         jsonb_build_object('loja', x.loja, 'anuncio', x.nome, 'item_id', x.item_id, 'sku', x.sku, 'o_que', x.descricao,
                           'de', x.de, 'para', x.para, 'direcao', x.direcao, 'quando', x.dia, 'origem', x.origem, 'dias_depois', x.dias_depois,
                           'antes', jsonb_build_object('receita', round(x.rec_a, 2), 'gasto', round(x.g_a, 2), 'roas', round(x.va_a / nullif(x.g_a, 0), 2), 'margem_pos_ads', round(x.mp_a, 2)),
                           'depois', jsonb_build_object('receita', x.rec_d7, 'gasto', x.g_d7, 'roas', round(x.va_d / nullif(x.g_d, 0), 2), 'margem_pos_ads', x.mp_d7),
                           'loja_var_pct', round((x.fator - 1) * 100, 1), 'receita_se_seguisse_a_loja', x.esp7,
                           'delta_receita_7d', x.delta7, 'delta_bruto_7d', x.delta7_bruto, 'efeito', x.efeito, 'efeito_bruto', x.efeito_bruto) j
                    from (select e.*, row_number() over (partition by e.grupo, e.mkt, e.shop_id, e.item_id order by abs(e.delta7) desc, e.dia) r1
                            from tt_ef e where e.efeito <> 'medindo') x
                   where x.r1 = 1) y
           where y.rn <= 5 group by y.grupo) z;
  v_ex := coalesce(v_ex, '{}'::jsonb);

  -- destaques: as 8 mudanças de maior efeito, uma por anúncio
  select coalesce(jsonb_agg(y.j order by y.rn), '[]'::jsonb) into v_dest
    from (select row_number() over (order by abs(q.delta7) desc, q.item_id) rn,
                 jsonb_build_object('loja', q.loja, 'anuncio', q.nome, 'item_id', q.item_id, 'sku', q.sku, 'o_que', q.o_que, 'quando', q.dia,
                   'dias_depois', q.dias_depois, 'antes', jsonb_build_object('receita', round(q.rec_a, 2), 'gasto', round(q.g_a, 2)),
                   'depois', jsonb_build_object('receita', q.rec_d7, 'gasto', q.g_d7),
                   'loja_var_pct', round((q.fator - 1) * 100, 1), 'receita_se_seguisse_a_loja', q.esp7,
                   'delta_receita_7d', q.delta7, 'efeito', q.efeito) j
            from (select d.*, row_number() over (partition by d.mkt, d.shop_id, d.item_id order by abs(d.delta7) desc, d.dia) r1
                    from (select e.mkt, e.shop_id, e.item_id, e.dia, max(e.loja) loja, max(e.nome) nome, max(e.sku) sku,
                                 string_agg(e.descricao || coalesce(' (' || replace(e.de, '.', ',') || ' → ' || replace(e.para, '.', ',') || ')', ''), '; ' order by e.grupo) o_que,
                                 max(e.dias_depois) dias_depois, max(e.rec_a) rec_a, max(e.g_a) g_a, max(e.rec_d7) rec_d7, max(e.g_d7) g_d7,
                                 max(e.fator) fator, max(e.esp7) esp7, max(e.delta7) delta7, max(e.efeito) efeito
                            from tt_ef e where e.efeito in ('melhorou', 'piorou')
                           group by e.mkt, e.shop_id, e.item_id, e.dia) d) q
           where q.r1 = 1) y
   where y.rn <= 8;

  -- frases de resumo
  v_mud := jsonb_build_object('periodo_dias', 30, 'de', v_ref - 29, 'ate', v_ref,
             'como_mede', 'receita do anúncio nos 7 dias antes × 7 dias a partir da mudança (com menos de 7 dias, projetado para 7; menos de 3 dias = medindo). O efeito desconta o movimento da loja no mesmo período: piorou = ficou mais de 30% abaixo do que teria se seguisse a loja (com pelo menos R$ 200 antes); melhorou = mais de 30% acima (com pelo menos R$ 200 depois). Oscilação de preço ou promoção desfeita em até 2 dias (relâmpago) não conta. O efeito sem esse desconto vem em efeito_bruto.');

  for r in select * from (values ('roas'), ('preco'), ('promocao'), ('sistema'), ('orcamento'), ('situacao')) q(grupo) loop
    v_qual := coalesce(v_g -> r.grupo, jsonb_build_object('n', 0, 'melhorou', 0, 'piorou', 0, 'sem_efeito', 0, 'medindo', 0));
    if (v_qual ->> 'n')::int = 0 then
      v_txt := case r.grupo when 'roas' then 'Nenhuma mudança de meta de ROAS registrada em 30 dias.'
                            when 'preco' then 'Nenhuma mudança de preço de 3% ou mais registrada em 30 dias.'
                            when 'promocao' then 'Nenhuma entrada ou saída de promoção registrada em 30 dias.'
                            when 'sistema' then 'Nenhum anúncio criado ou alterado pelo sistema em 30 dias.'
                            when 'orcamento' then 'Nenhuma mudança de orçamento de ADS em 30 dias.'
                            else 'Nenhuma mudança de situação de anúncio ou campanha em 30 dias.' end;
    else
      v_txt := (v_qual ->> 'n') || ' ' ||
               case r.grupo when 'roas' then 'mudanças de meta de ROAS'
                            when 'preco' then 'mudanças de preço de 3% ou mais'
                            when 'promocao' then 'entradas ou saídas de promoção'
                            when 'sistema' then 'envios do sistema (anúncio criado ou alterado)'
                            when 'orcamento' then 'mudanças de orçamento de ADS'
                            else 'mudanças de situação de anúncio ou campanha' end
               || case when r.grupo in ('roas', 'preco', 'orcamento') then
                    ' (' || coalesce(v_qual #>> '{subiu,n}', '0') || ' para cima, ' || coalesce(v_qual #>> '{desceu,n}', '0') || ' para baixo)'
                       when r.grupo = 'promocao' then
                    ' (' || coalesce(v_qual #>> '{entrou,n}', '0') || ' entradas, ' || coalesce(v_qual #>> '{saiu,n}', '0') || ' saídas)'
                       else '' end
               || ' em ' || (v_qual ->> 'anuncios') || ' anúncios: descontado o movimento da loja, ' || (v_qual ->> 'melhorou') || ' melhoraram, ' || (v_qual ->> 'piorou') || ' pioraram, '
               || (v_qual ->> 'sem_efeito') || ' sem efeito claro e ' || (v_qual ->> 'medindo') || ' ainda medindo.';
      if r.grupo in ('roas', 'preco') then
        if coalesce((v_qual #>> '{subiu,anuncios_medidos}')::int, 0) > 0 then
          v_txt := v_txt || ' Onde ' || case r.grupo when 'roas' then 'a meta' else 'o preço' end || ' subiu (' || (v_qual #>> '{subiu,anuncios_medidos}')
                   || ' anúncios, 1ª mudança de cada): receita semanal de ' || tend_rs((v_qual #>> '{subiu,antes,receita}')::numeric)
                   || ' para ' || tend_rs((v_qual #>> '{subiu,depois,receita}')::numeric)
                   || ' (seguindo a loja seria ' || tend_rs((v_qual #>> '{subiu,depois,receita_se_seguisse_a_loja}')::numeric)
                   || '); ADS de ' || tend_rs((v_qual #>> '{subiu,antes,gasto}')::numeric) || ' para ' || tend_rs((v_qual #>> '{subiu,depois,gasto}')::numeric) || '.';
        end if;
        if coalesce((v_qual #>> '{desceu,anuncios_medidos}')::int, 0) > 0 then
          v_txt := v_txt || ' Onde ' || case r.grupo when 'roas' then 'a meta' else 'o preço' end || ' baixou (' || (v_qual #>> '{desceu,anuncios_medidos}')
                   || ' anúncios): receita semanal de ' || tend_rs((v_qual #>> '{desceu,antes,receita}')::numeric)
                   || ' para ' || tend_rs((v_qual #>> '{desceu,depois,receita}')::numeric)
                   || ' (seguindo a loja seria ' || tend_rs((v_qual #>> '{desceu,depois,receita_se_seguisse_a_loja}')::numeric)
                   || '); ADS de ' || tend_rs((v_qual #>> '{desceu,antes,gasto}')::numeric) || ' para ' || tend_rs((v_qual #>> '{desceu,depois,gasto}')::numeric) || '.';
        end if;
      end if;
    end if;
    v_mud := v_mud || jsonb_build_object(r.grupo, v_qual || jsonb_build_object('resumo', v_txt, 'exemplos', coalesce(v_ex -> r.grupo, '[]'::jsonb)));
  end loop;
  v_mud := v_mud || jsonb_build_object('destaques', v_dest);
  v_qual := null;

  v_tp := v_tp || jsonb_build_object('ate_13', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 13. decisões (até 6; no máximo 3 por loja) ---------------------------------------------------------------
  create temp table tt_dec (chave text, tom text, o_que text, detalhe text, sku text, valor numeric, slug text) on commit drop;

  insert into tt_dec
  select 'tend:' || l.slug || ':queda:medio', case when t.leitura = 'queda_persistente' and h.receita_ant - h.receita >= 15000 then 'red' else 'amber' end,
         'Decidir o plano para a queda de vendas — ' || l.loja,
         tend_pc(h.var_pct) || ' em 30 dias (' || tend_rs(h.receita_ant) || ' → ' || tend_rs(h.receita) || ')'
           || case when t.leitura = 'queda_persistente' and t.qpico is not null then '; últimas 4 semanas ' || tend_pc(t.qpico) || ' contra as melhores 4 semanas da série' else '' end
           || coalesce('; principal motivo candidato: ' || (select c.titulo from tt_causa c where c.canal = l.canal and c.sentido = 'negativo' and c.impacto is not null
                                                              order by abs(c.impacto) desc limit 1), ''),
         null, round(h.receita_ant - h.receita, 2), l.slug
    from tt_loja l join tt_h h on h.canal = l.canal and h.h = 'medio' join tt_tend t on t.canal = l.canal
   where not l.e_total and h.tend = 'queda' and h.receita_ant - h.receita >= 3000;

  insert into tt_dec
  select 'tend:' || l.slug || ':estoque:' || e.sku, 'amber',
         'Repor o estoque do SKU ' || e.sku || ' — ' || l.loja,
         left(e.nome, 60) || ': ' || e.txt_est || '; receita de ' || tend_rs(e.r0) || ' para ' || tend_rs(e.r1),
         e.sku, round(-e.delta, 2), l.slug
    from tt_ev e join tt_loja l on l.canal = e.canal
   where not l.e_total and e.lado = 'queda' and e.est_pior and e.est_fim = 0 and e.delta <= -1500;

  insert into tt_dec
  select 'tend:' || l.slug || ':preco:' || e.sku, 'amber',
         'Rever o preço do SKU ' || e.sku || ' — ' || l.loja,
         left(e.nome, 60) || ': ' || e.txt_preco || '; receita de ' || tend_rs(e.r0) || ' para ' || tend_rs(e.r1),
         e.sku, round(-e.delta, 2), l.slug
    from tt_ev e join tt_loja l on l.canal = e.canal
   where not l.e_total and e.lado = 'queda' and e.preco_up and e.txt_preco is not null and not e.est_pior and e.delta <= -1500;

  insert into tt_dec
  select 'tend:' || z.slug || ':roas:' || z.item_id, 'amber',
         'Rever a meta de ROAS de "' || left(z.nome, 45) || '" (' || z.loja || ')',
         'meta de ' || replace(z.de, '.', ',') || ' para ' || replace(z.para, '.', ',') || ' em ' || to_char(z.dia, 'DD/MM')
           || '; receita semanal do anúncio de ' || tend_rs(z.rec_a) || ' para ' || tend_rs(z.rec_d7) || ' (seguindo a loja seria ' || tend_rs(z.esp7) || '); ADS de ' || tend_rs(z.g_a) || ' para ' || tend_rs(z.g_d7),
         z.sku, round(-z.delta7, 2), z.slug
    from (select e.*, row_number() over (order by e.delta7) rn from tt_ef e
           where e.grupo = 'roas' and e.efeito = 'piorou' and e.delta7 <= -500) z
   where z.rn <= 2;

  insert into tt_dec
  select 'tend:' || l.slug || ':parou:medio', 'gray',
         'Decidir se voltam os ' || g.n || ' produtos que pararam de vender — ' || l.loja,
         'vendiam ' || tend_rs(g.v) || ' nos 30 dias anteriores: ' || g.sk,
         null, round(g.v, 2), l.slug
    from (select s.canal, count(*) n, sum(s.r0) v, array_to_string((array_agg(s.sku order by s.r0 desc))[1:6], ', ') sk
            from tt_sku s where s.r1 = 0 and s.r0 >= 300 group by s.canal) g
    join tt_loja l on l.canal = g.canal
   where not l.e_total and g.n >= 3 and g.v >= 3000;

  select coalesce(jsonb_agg(jsonb_build_object('chave', d.chave, 'tom', d.tom, 'o_que', d.o_que, 'detalhe', d.detalhe, 'sku', d.sku,
                                               'valor', d.valor, 'prazo', null, 'dono', 'Renan') order by d.o), '[]'::jsonb)
    into v_dec
    from (select y.*, row_number() over (order by (y.tom = 'red') desc, y.valor desc nulls last, y.chave) o
            from (select x.*, row_number() over (partition by x.slug order by (x.tom = 'red') desc, x.valor desc nulls last, x.chave) rl
                    from (select distinct on (t.chave) t.* from tt_dec t order by t.chave, t.valor desc nulls last) x) y
           where y.rl <= 3) d
   where d.o <= 6;

  v_tp := v_tp || jsonb_build_object('ate_14', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  -- 14. qualidade ---------------------------------------------------------------------------------------------
  select min(k.dia), max(k.atualizado_em) into v_kpi_de, v_kpi_em from view_kpi_pedidos_dia k;
  select min(s.data) into v_snap_de from ads_anuncio_snapshot s where s.marketplace = 'shopee' and s.shop_id = 522186766 and s.variacao_id = '';
  select min(h.ate)::date into v_cfg_de from ads_config_historico h;
  select min(f.dia) into v_flash_de from flashsale_criadas f;
  select min(m.data) into v_adsm_de from ads_metrica_anuncio_dia m where m.marketplace = 'shopee' and m.nivel = 'anuncio';
  select min(d.data) into v_sads_de from shopee_ads_diario d;
  select min(d.data) into v_mlads_de from ml_ads_diario d;

  -- base incompleta por loja e horizonte
  select array_agg(l.loja || ': no horizonte de ' || h.n || ' dias a janela anterior tem ' || h.dias_ant || ' de ' || h.n
                   || ' dias com dado (loja com dado desde ' || to_char(l.inicio, 'DD/MM/YYYY') || ')'
                   || case when h.var_pct is null then '; sem base para comparar' else '; a variação compara médias por dia' end
                   order by l.ord, h.n)
    into v_tmp
    from tt_h h join tt_loja l on l.canal = h.canal
   where not l.e_total and (h.dias_ant < h.n or h.dias_cur < h.n);
  v_avisos := v_avisos || coalesce(v_tmp, '{}');

  if exists (select 1 from tt_loja l where not l.e_total and l.inicio > v_ref - 179) then
    select 'Total em 90 dias: a janela anterior não tem todas as lojas (' || string_agg(l.loja || ' desde ' || to_char(l.inicio, 'DD/MM'), ', ' order by l.ord)
           || '), então a variação do Total fica maior do que a real' into v_txt
      from tt_loja l where not l.e_total and l.inicio > v_ref - 179;
    v_avisos := v_avisos || v_txt;
  end if;

  -- sazonalidade: datas de campanha dentro das janelas
  select jsonb_object_agg(q.h, jsonb_build_object('atual', q.atual, 'anterior', q.anterior)),
         array_agg('Campanhas no horizonte de ' || q.n || ' dias: janela atual ' || coalesce(nullif(array_to_string(q.atual, ', '), ''), 'nenhuma')
                   || '; janela anterior ' || coalesce(nullif(array_to_string(q.anterior, ', '), ''), 'nenhuma') order by q.n)
           filter (where cardinality(q.atual) > 0 or cardinality(q.anterior) > 0)
    into v_saz, v_tmp
    from (select hz.h, hz.n,
                 coalesce((select array_agg(tend_campanha(d::date) order by d) from generate_series(v_ref - hz.n + 1, v_ref, interval '1 day') d
                            where tend_campanha(d::date) is not null), '{}') atual,
                 coalesce((select array_agg(tend_campanha(d::date) order by d) from generate_series(v_ref - 2 * hz.n + 1, v_ref - hz.n, interval '1 day') d
                            where tend_campanha(d::date) is not null), '{}') anterior
            from (values ('curto', 7), ('medio', 30), ('longo', 90)) hz(h, n)) q;
  v_avisos := v_avisos || coalesce(v_tmp, '{}');

  if v_snap_de is null or v_snap_de > v_ref - 59 then
    v_avisos := v_avisos || ('Retrato diário dos anúncios (preço, promoção, estoque) começa em ' || coalesce(to_char(v_snap_de, 'DD/MM/YYYY'), '—')
                 || ': a janela anterior de 30 dias (' || to_char(v_ref - 59, 'DD/MM') || ' a ' || to_char(v_ref - 30, 'DD/MM') || ') só tem '
                 || greatest(0, (v_ref - 30) - greatest(coalesce(v_snap_de, v_ref), v_ref - 59) + 1) || ' dias de retrato');
  end if;
  if v_cfg_de is not null and v_cfg_de > v_ref - 29 then
    v_avisos := v_avisos || ('Histórico de meta de ROAS e orçamento só existe desde ' || to_char(v_cfg_de, 'DD/MM/YYYY'));
  end if;
  if v_adsm_de is null or v_adsm_de > v_ref - 59 then
    v_avisos := v_avisos || ('ADS por anúncio disponível desde ' || coalesce(to_char(v_adsm_de, 'DD/MM/YYYY'), '—') || ': a comparação 30 × 30 do ADS por produto fica incompleta');
  end if;
  if p_ref is not null and v_ref < v_hoje - 1 then
    v_avisos := v_avisos || 'Relatório de data passada: ADS por anúncio (60 dias), retrato e lista de mudanças são relativos a hoje e podem estar incompletos'::text;
  end if;
  select count(*) into v_dias_lista from tt_mud m where m.oscilacao;
  if v_dias_lista > 0 then
    v_avisos := v_avisos || (v_dias_lista || ' oscilações de preço ou promoção desfeitas em até 2 dias (relâmpago) ficaram fora do bloco de mudanças');
  end if;
  v_avisos := v_avisos || array[
    'Últimos dias: pedido da Amazon ainda pendente entra sem valor e pedido do Mercado Livre só entra depois do detalhe do repasse — o horizonte de 7 dias dessas lojas pode estar abaixo do real',
    'Efeito das mudanças é antes × depois do próprio anúncio, descontado o movimento da loja no mesmo período; estoque e outras mudanças no mesmo anúncio se misturam, e anúncio mudado várias vezes em poucos dias tem janelas sobrepostas',
    'Impacto das causas por produto = variação de receita do próprio produto; quando há dois motivos no mesmo produto o valor não é dividido entre eles',
    'Mudança de foto, título ou preço feita direto no painel do marketplace só aparece se mexeu em preço de venda, promoção ou situação (o retrato não guarda fotos e texto)']::text[];

  v_qual := jsonb_build_object(
    'fontes', jsonb_build_object(
      'vendas_margem', jsonb_build_object('fonte', 'view_kpi_pedidos_dia', 'desde', v_kpi_de, 'atualizado_em', v_kpi_em),
      'lojas_desde', (select jsonb_object_agg(l.loja, l.inicio) from tt_loja l where not l.e_total),
      'ads_loja', jsonb_build_object('shopee_desde', v_sads_de, 'mercado_livre_desde', v_mlads_de,
                    'sem_ads_integrado', (select coalesce(jsonb_agg(l.loja order by l.ord), '[]'::jsonb) from tt_loja l where not l.tem_ads)),
      'retrato_anuncios', jsonb_build_object('desde', v_snap_de, 'cobre', 'Shopee Ottz, Shopee Bumi e Mercado Livre Ottz'),
      'ads_por_anuncio', jsonb_build_object('desde', v_adsm_de),
      'config_ads_historico', jsonb_build_object('desde', v_cfg_de),
      'relampago', jsonb_build_object('desde', v_flash_de),
      'produtos', 'pedidos_validos + pedido_itens (Shopee, Mercado Livre e Amazon)'),
    'faltou', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select 'ADS de Amazon e TikTok não está integrado' x
        union all select 'TikTok: sem quebra por produto e sem retrato de anúncio'
        union all select 'Mercado Livre SVL e Amazon: sem retrato de preço, promoção e estoque do anúncio'
        union all select 'Não há registro de visitas/tráfego orgânico por anúncio da Shopee nem de preço de concorrentes') q),
    'sazonalidade', v_saz,
    'avisos', to_jsonb(v_avisos),
    'tempos_ms', v_tp,
    'tempo_ms', round(extract(epoch from clock_timestamp() - v_t0) * 1000));

  return jsonb_build_object(
    'versao', 'v1', 'data_referencia', v_ref, 'gerado_em', now(),
    'lojas', coalesce(v_lojas, '[]'::jsonb), 'mudancas', v_mud, 'decisoes', v_dec, 'qualidade', v_qual);
end
$fn$;

-- ---------- destaque (1–2 frases) ----------
create or replace function public.tendencias_destaque(p jsonb)
returns text
language plpgsql
stable
set search_path = public, extensions
as $fn$
declare
  l jsonb; t jsonb; s text; x text; v_top3 numeric; v_n int;
begin
  if p is null or jsonb_typeof(p -> 'lojas') is distinct from 'array' then return 'Sem dados de tendência.'; end if;

  select e into l from jsonb_array_elements(p -> 'lojas') e
   where e ->> 'loja' <> 'Total' and e #>> '{tendencia,medio}' = 'queda'
   order by (e #>> '{medio,receita}')::numeric - (e #>> '{medio,receita_ant}')::numeric limit 1;

  if l is not null then
    s := (l ->> 'loja') || ' caiu ' || replace(tend_pc(abs((l #>> '{medio,var_pct}')::numeric)), '+', '') || ' em 30 dias ('
         || tend_rs((l #>> '{medio,receita_ant}')::numeric) || ' → ' || tend_rs((l #>> '{medio,receita}')::numeric) || ')';
    if l #>> '{tendencia,longo}' = 'queda' then
      s := s || ' e ' || replace(tend_pc(abs((l #>> '{longo,var_pct}')::numeric)), '+', '') || ' em 90 dias';
    elsif l ->> 'leitura' = 'queda_persistente' and (l #>> '{tendencia,vs_pico_pct}')::numeric <= -15 then
      s := s || ', ' || replace(tend_pc(abs((l #>> '{tendencia,vs_pico_pct}')::numeric)), '+', '') || ' abaixo do pico (4 semanas até ' || to_char((l #>> '{tendencia,pico_4_semanas_ate}')::date, 'DD/MM') || ')';
    end if;
    select sum((k ->> 'delta')::numeric), count(*) into v_top3, v_n
      from (select k from jsonb_array_elements(l -> 'skus_queda') with ordinality q(k, o) order by o limit 3) z;
    if v_n >= 2 then s := s || '; os ' || v_n || ' produtos que mais perderam somam ' || tend_rs(abs(v_top3)); end if;
    s := s || '.';
  else
    select e into l from jsonb_array_elements(p -> 'lojas') e
     where e ->> 'loja' <> 'Total' and e #>> '{tendencia,medio}' = 'alta'
     order by (e #>> '{medio,receita}')::numeric - (e #>> '{medio,receita_ant}')::numeric desc limit 1;
    if l is not null then
      s := (l ->> 'loja') || ' subiu ' || replace(tend_pc((l #>> '{medio,var_pct}')::numeric), '+', '') || ' em 30 dias ('
           || tend_rs((l #>> '{medio,receita_ant}')::numeric) || ' → ' || tend_rs((l #>> '{medio,receita}')::numeric) || ').';
    else
      s := 'Nenhuma loja saiu da faixa de 10% para cima ou para baixo em 30 dias.';
    end if;
  end if;

  select e into t from jsonb_array_elements(p -> 'lojas') e where e ->> 'loja' = 'Total' limit 1;
  if t is not null and (t #>> '{medio,var_pct}') is not null then
    x := ' No total, ' || case t #>> '{tendencia,medio}' when 'queda' then 'queda de ' when 'alta' then 'alta de ' else 'variação de ' end
         || replace(replace(tend_pc((t #>> '{medio,var_pct}')::numeric), '+', ''), '-', '') || ' em 30 dias (' || tend_rs((t #>> '{medio,receita}')::numeric) || ').';
    if length(s || x) <= 235 then s := s || x; end if;
  end if;

  if coalesce((p #>> '{mudancas,roas,piorou}')::int, 0) > 0 then
    x := ' ROAS: ' || (p #>> '{mudancas,roas,piorou}') || ' de ' || (p #>> '{mudancas,roas,n}') || ' mudanças de meta pioraram a receita do anúncio.';
    if length(s || x) <= 235 then s := s || x; end if;
  end if;
  return s;
end
$fn$;

-- ---------- HTML ----------
create or replace function public.tendencias_html(p jsonb)
returns text
language plpgsql
stable
set search_path = public, extensions
as $fn$
declare
  h text := '';
  l jsonb; k jsonb; g text; v_txt text;
  v_leitura text;
begin
  if p is null or jsonb_typeof(p -> 'lojas') is distinct from 'array' then return '<p>Sem dados de tendência.</p>'; end if;

  h := '<h3>Leitura do dia</h3><p>' || rel_esc(tendencias_destaque(p)) || '</p>'
    || '<p>Dia de referência: ' || to_char((p ->> 'data_referencia')::date, 'DD/MM/YYYY')
    || '. Curto = 7 dias contra os 7 anteriores; médio = 30 contra 30; longo = 90 contra 90.</p>';

  -- quadro geral
  h := h || '<h3>Lojas</h3><table><tr><th>Loja</th><th>Leitura</th><th>7 dias</th><th>Var.</th><th>30 dias</th><th>Var.</th><th>90 dias</th><th>Var.</th><th>Margem 30 dias</th><th>ADS 30 dias</th></tr>'
    || coalesce((select string_agg('<tr><td>' || rel_esc(e ->> 'loja') || '</td><td>'
           || rel_esc(case e ->> 'leitura' when 'queda_persistente' then 'queda persistente' when 'queda_recente' then 'queda recente'
                when 'recuperando' then 'recuperando' when 'alta_persistente' then 'alta persistente' when 'alta_recente' then 'alta recente'
                when 'estavel' then 'estável' when 'estavel_apos_queda' then 'estável depois de queda' when 'perdendo_folego' then 'perdendo fôlego'
                when 'sem_base' then 'sem base de comparação' when 'sem_venda' then 'sem venda' else e ->> 'leitura' end)
           || '</td><td>' || tend_rs((e #>> '{curto,receita}')::numeric) || '</td><td>' || tend_pc((e #>> '{curto,var_pct}')::numeric)
           || '</td><td>' || tend_rs((e #>> '{medio,receita}')::numeric) || '</td><td>' || tend_pc((e #>> '{medio,var_pct}')::numeric)
           || '</td><td>' || tend_rs((e #>> '{longo,receita}')::numeric) || '</td><td>' || tend_pc((e #>> '{longo,var_pct}')::numeric)
           || '</td><td>' || coalesce(tend_n2((e #>> '{medio,mc_pct}')::numeric) || '%', '—')
           || '</td><td>' || tend_rs((e #>> '{medio,ads}')::numeric) || '</td></tr>', '' order by o)
         from jsonb_array_elements(p -> 'lojas') with ordinality q(e, o)), '') || '</table>';

  -- cada loja
  for l in select e from jsonb_array_elements(p -> 'lojas') with ordinality q(e, o) order by o loop
    v_leitura := case l ->> 'leitura' when 'queda_persistente' then 'queda persistente' when 'queda_recente' then 'queda recente'
                when 'recuperando' then 'recuperando' when 'alta_persistente' then 'alta persistente' when 'alta_recente' then 'alta recente'
                when 'estavel' then 'estável' when 'estavel_apos_queda' then 'estável depois de queda' when 'perdendo_folego' then 'perdendo fôlego'
                when 'sem_base' then 'sem base de comparação' when 'sem_venda' then 'sem venda' else l ->> 'leitura' end;
    h := h || '<h3>' || rel_esc(l ->> 'loja') || ' — ' || rel_esc(v_leitura) || '</h3>'
      || '<table><tr><th>Horizonte</th><th>Receita</th><th>Antes</th><th>Variação</th><th>Pedidos</th><th>Antes</th><th>Ticket</th><th>Antes</th><th>Margem</th><th>Antes</th><th>ADS</th><th>Antes</th></tr>';
    foreach g in array array['curto', 'medio', 'longo'] loop
      k := l -> g;
      h := h || '<tr><td>' || (k ->> 'dias') || ' dias' || case when (k ->> 'base_incompleta')::boolean then ' (base incompleta)' else '' end
        || '</td><td>' || tend_rs((k ->> 'receita')::numeric) || '</td><td>' || tend_rs((k ->> 'receita_ant')::numeric)
        || '</td><td>' || tend_pc((k ->> 'var_pct')::numeric)
        || '</td><td>' || coalesce(k ->> 'pedidos', '—') || '</td><td>' || coalesce(k ->> 'pedidos_ant', '—')
        || '</td><td>' || coalesce('R$ ' || tend_n2((k ->> 'ticket')::numeric), '—') || '</td><td>' || coalesce('R$ ' || tend_n2((k ->> 'ticket_ant')::numeric), '—')
        || '</td><td>' || coalesce(tend_n2((k ->> 'mc_pct')::numeric) || '%', '—') || '</td><td>' || coalesce(tend_n2((k ->> 'mc_pct_ant')::numeric) || '%', '—')
        || '</td><td>' || tend_rs((k ->> 'ads')::numeric) || '</td><td>' || tend_rs((k ->> 'ads_ant')::numeric) || '</td></tr>';
    end loop;
    h := h || '</table>';

    v_txt := '';
    if (l #>> '{tendencia,inclinacao_13_semanas_pct}') is not null then
      v_txt := v_txt || 'Nas últimas 13 semanas a receita varia em média ' || tend_pc((l #>> '{tendencia,inclinacao_13_semanas_pct}')::numeric) || ' por semana. ';
    end if;
    if coalesce((l #>> '{tendencia,semanas_seguidas_de_queda}')::int, 0) >= 2 then
      v_txt := v_txt || (l #>> '{tendencia,semanas_seguidas_de_queda}') || ' semanas seguidas de queda. ';
    end if;
    if (l #>> '{tendencia,vs_pico_pct}') is not null and (l #>> '{tendencia,vs_pico_pct}')::numeric <= -10 then
      v_txt := v_txt || 'As últimas 4 semanas estão ' || tend_pc((l #>> '{tendencia,vs_pico_pct}')::numeric) || ' em relação às melhores 4 semanas da série (até '
               || to_char((l #>> '{tendencia,pico_4_semanas_ate}')::date, 'DD/MM') || '). ';
    end if;
    if v_txt <> '' then h := h || '<p>' || rel_esc(btrim(v_txt)) || '</p>'; end if;

    if jsonb_array_length(coalesce(l -> 'semanas', '[]'::jsonb)) > 0 then
      h := h || '<p>Receita por semana (últimas ' || least(jsonb_array_length(l -> 'semanas'), 13) || '): '
        || rel_esc((select string_agg(to_char((s ->> 'semana')::date, 'DD/MM') || ' ' || tend_rs((s ->> 'receita')::numeric), ' · ' order by o)
                      from (select s, o from jsonb_array_elements(l -> 'semanas') with ordinality q(s, o) order by o desc limit 13) z)) || '</p>';
    end if;

    if jsonb_array_length(coalesce(l -> 'causas', '[]'::jsonb)) > 0 then
      h := h || '<p>Possíveis motivos (30 dias):</p><table><tr><th>Efeito</th><th>Motivo</th><th>Detalhe</th><th>Impacto estimado</th></tr>'
        || (select string_agg('<tr><td>' || case c ->> 'sentido' when 'negativo' then 'para pior' else 'para melhor' end || '</td><td>' || rel_esc(c ->> 'titulo')
               || '</td><td>' || rel_esc(c ->> 'detalhe') || '</td><td>' || tend_rs((c ->> 'impacto_rs')::numeric) || '</td></tr>', '' order by o)
              from jsonb_array_elements(l -> 'causas') with ordinality q(c, o)) || '</table>';
    end if;

    if jsonb_array_length(coalesce(l -> 'skus_queda', '[]'::jsonb)) > 0 then
      h := h || '<p>Produtos que mais caíram (30 dias contra os 30 anteriores):</p><table><tr><th>SKU</th><th>Produto</th><th>Antes</th><th>Agora</th><th>Diferença</th><th>Unidades</th><th>O que mudou</th></tr>'
        || (select string_agg('<tr><td>' || rel_esc(c ->> 'sku') || '</td><td>' || rel_esc(left(c ->> 'nome', 70)) || '</td><td>' || tend_rs((c ->> 'receita_ant')::numeric)
               || '</td><td>' || tend_rs((c ->> 'receita')::numeric) || '</td><td>' || tend_rs((c ->> 'delta')::numeric)
               || '</td><td>' || round((c ->> 'unidades_ant')::numeric) || ' → ' || round((c ->> 'unidades')::numeric)
               || '</td><td>' || rel_esc(coalesce((select string_agg(m, '; ') from jsonb_array_elements_text(c -> 'o_que_mudou') m), 'nada encontrado nos dados')) || '</td></tr>', '' order by o)
              from jsonb_array_elements(l -> 'skus_queda') with ordinality q(c, o)) || '</table>';
    end if;
    if jsonb_array_length(coalesce(l -> 'skus_alta', '[]'::jsonb)) > 0 then
      h := h || '<p>Produtos que mais subiram:</p><table><tr><th>SKU</th><th>Produto</th><th>Antes</th><th>Agora</th><th>Diferença</th><th>Unidades</th><th>O que mudou</th></tr>'
        || (select string_agg('<tr><td>' || rel_esc(c ->> 'sku') || '</td><td>' || rel_esc(left(c ->> 'nome', 70)) || '</td><td>' || tend_rs((c ->> 'receita_ant')::numeric)
               || '</td><td>' || tend_rs((c ->> 'receita')::numeric) || '</td><td>' || tend_rs((c ->> 'delta')::numeric)
               || '</td><td>' || round((c ->> 'unidades_ant')::numeric) || ' → ' || round((c ->> 'unidades')::numeric)
               || '</td><td>' || rel_esc(coalesce((select string_agg(m, '; ') from jsonb_array_elements_text(c -> 'o_que_mudou') m), 'nada encontrado nos dados')) || '</td></tr>', '' order by o)
              from jsonb_array_elements(l -> 'skus_alta') with ordinality q(c, o)) || '</table>';
    end if;
  end loop;

  -- mudanças
  h := h || '<h3>Nossas mudanças e o efeito (30 dias)</h3><p>' || rel_esc(p #>> '{mudancas,como_mede}') || '</p>';
  foreach g in array array['roas', 'preco', 'promocao', 'orcamento', 'sistema', 'situacao'] loop
    k := p -> 'mudancas' -> g;
    continue when k is null;
    h := h || '<p>' || rel_esc(case g when 'roas' then 'Meta de ROAS' when 'preco' then 'Preço' when 'promocao' then 'Promoção' when 'orcamento' then 'Orçamento de ADS'
                                   when 'sistema' then 'Alterações do sistema' else 'Situação de anúncio e campanha' end || ': ' || coalesce(k ->> 'resumo', '')) || '</p>';
    if jsonb_array_length(coalesce(k -> 'exemplos', '[]'::jsonb)) > 0 then
      h := h || '<table><tr><th>Loja</th><th>Anúncio</th><th>Mudança</th><th>Quando</th><th>Receita 7 dias antes</th><th>Depois</th><th>ADS antes</th><th>Depois</th><th>Efeito</th></tr>'
        || (select string_agg('<tr><td>' || rel_esc(c ->> 'loja') || '</td><td>' || rel_esc(left(c ->> 'anuncio', 60)) || coalesce(' (SKU ' || rel_esc(c ->> 'sku') || ')', '')
               || '</td><td>' || rel_esc((c ->> 'o_que') || coalesce(': ' || replace(c ->> 'de', '.', ',') || ' → ' || replace(c ->> 'para', '.', ','), ''))
               || '</td><td>' || to_char((c ->> 'quando')::date, 'DD/MM')
               || '</td><td>' || tend_rs((c #>> '{antes,receita}')::numeric) || '</td><td>' || tend_rs((c #>> '{depois,receita}')::numeric)
               || '</td><td>' || tend_rs((c #>> '{antes,gasto}')::numeric) || '</td><td>' || tend_rs((c #>> '{depois,gasto}')::numeric)
               || '</td><td>' || rel_esc(case c ->> 'efeito' when 'melhorou' then 'melhorou' when 'piorou' then 'piorou' else 'sem efeito claro' end) || '</td></tr>', '' order by o)
              from jsonb_array_elements(k -> 'exemplos') with ordinality q(c, o)) || '</table>';
    end if;
  end loop;

  if jsonb_array_length(coalesce(p #> '{mudancas,destaques}', '[]'::jsonb)) > 0 then
    h := h || '<p>Mudanças de maior efeito:</p><table><tr><th>Loja</th><th>Anúncio</th><th>Mudança</th><th>Quando</th><th>Receita 7 dias antes</th><th>Depois</th><th>Efeito</th></tr>'
      || (select string_agg('<tr><td>' || rel_esc(c ->> 'loja') || '</td><td>' || rel_esc(left(c ->> 'anuncio', 60)) || coalesce(' (SKU ' || rel_esc(c ->> 'sku') || ')', '')
             || '</td><td>' || rel_esc(c ->> 'o_que') || '</td><td>' || to_char((c ->> 'quando')::date, 'DD/MM')
             || '</td><td>' || tend_rs((c #>> '{antes,receita}')::numeric) || '</td><td>' || tend_rs((c #>> '{depois,receita}')::numeric)
             || '</td><td>' || rel_esc(c ->> 'efeito') || '</td></tr>', '' order by o)
            from jsonb_array_elements(p #> '{mudancas,destaques}') with ordinality q(c, o)) || '</table>';
  end if;

  -- decisões
  if jsonb_array_length(coalesce(p -> 'decisoes', '[]'::jsonb)) > 0 then
    h := h || '<h3>Pede decisão</h3><table><tr><th>O quê</th><th>Detalhe</th><th>Valor em jogo</th></tr>'
      || (select string_agg('<tr><td>' || rel_esc(c ->> 'o_que') || '</td><td>' || rel_esc(c ->> 'detalhe') || '</td><td>' || tend_rs((c ->> 'valor')::numeric) || '</td></tr>', '' order by o)
            from jsonb_array_elements(p -> 'decisoes') with ordinality q(c, o)) || '</table>';
  end if;

  -- qualidade
  h := h || '<h3>Limites dos dados</h3>'
    || coalesce((select string_agg('<p>' || rel_esc(a) || '.</p>', '' order by o) from jsonb_array_elements_text(p #> '{qualidade,avisos}') with ordinality q(a, o)), '')
    || coalesce((select string_agg('<p>Faltou: ' || rel_esc(a) || '.</p>', '' order by o) from jsonb_array_elements_text(p #> '{qualidade,faltou}') with ordinality q(a, o)), '')
    || '<p><em>Relatório gerado automaticamente pelo sistema, por regra, com os números do banco. Os motivos são candidatos com evidência, não prova de causa.</em></p>';
  return h;
end
$fn$;

-- ---------- permissões: quem lê é o cron ----------
revoke all on function public.tend_rs(numeric) from public, anon, authenticated;
revoke all on function public.tend_n2(numeric) from public, anon, authenticated;
revoke all on function public.tend_pc(numeric) from public, anon, authenticated;
revoke all on function public.tend_num(text) from public, anon, authenticated;
revoke all on function public.tend_campanha(date) from public, anon, authenticated;
revoke all on function public.tendencias_relatorio(date) from public, anon, authenticated;
revoke all on function public.tendencias_destaque(jsonb) from public, anon, authenticated;
revoke all on function public.tendencias_html(jsonb) from public, anon, authenticated;
