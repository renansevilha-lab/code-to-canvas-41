-- Aba Anúncios — visões "Anúncios no ar" e "Mudanças" (16/nov/2026, proposta aprovada pelo dono:
-- https://claude.ai/artifact/97jDGeVyqvZr6xZhfzwmj1 — "pode aplicar, abre em Anúncios no ar, começa pela Shopee").
-- Migração anuncios_no_ar. Só funções (nenhuma tabela nova); Shopee apenas, por anúncio (item_id) e loja.
--
-- anuncio_mudancas_lista(dias, itens?)  → tudo que mudou nos anúncios, de 4 origens:
--     app     = envios do sistema (ia_publicacao: criado, fotos, título, descrição, preço cheio)
--     fora    = visto pelo retrato diário (ads_anuncio_snapshot: preço de venda, promoção, situação) e mudança de
--               ADS capturada de fora (ads_config_historico origem externo)
--     teste   = teste A/B (anuncio_teste_log + ads_config_historico origem teste_ab)
--     (ADS pelo app = ads_config_historico origem app)
-- anuncio_mudanca_efeito(shop, item, dia) → receita dos 7 dias antes × dos 7 dias a partir do dia (só dias fechados)
-- anuncios_mudancas(...)        → a visão "Mudanças" (página + contagens), com o efeito de cada mudança
-- anuncios_no_ar(...)           → a visão "Anúncios no ar": linha por anúncio com vendas 7 d × 7 d antes, ADS, ROAS × meta,
--                                 margem antes/depois do ADS, estoque em dias, última mudança, teste; + faixa "Pede atenção"
-- anuncio_no_ar_detalhe(shop, item) → acompanhamento do anúncio aberto: série de 28 dias, histórico com efeito, campanhas
-- Regras da faixa (no banco): estoque = vende ≥ 7 un/7 d e o estoque do anúncio dura < 7 dias · caindo = ≥ R$ 500 nos
-- 7 d anteriores e −30% ou mais · prejuízo = ADS ≥ R$ 20 e margem depois do ADS negativa · medição = mudança do sistema
-- (app/teste) nos últimos 7 dias. Acesso: tem_modulo('ia') ou tem_modulo('ads').

create or replace function public.anuncio_mudancas_lista(p_dias int default 30, p_itens text[] default null)
returns table (quando timestamptz, shop_id bigint, item_id text, campo text, de text, para text, descricao text,
               origem text, quem text, ok boolean, log_id bigint, braco text, campanha text)
language sql stable security definer set search_path = public as $$
with lim as (select now() - make_interval(days => p_dias) as desde,
                    (now() at time zone 'America/Sao_Paulo')::date - p_dias - 1 as dia0),
pub as (
  select p.criado_em quando, p.shop_id, p.item_id, p.operacao, p.criado_por_nome quem, p.enviado e,
         case when jsonb_typeof(p.enviado->'fotos'->'novas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'novas') else 0 end n_novas,
         case when jsonb_typeof(p.enviado->'fotos'->'mantidas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'mantidas') else 0 end n_mant
    from ia_publicacao p, lim
   where p.estado = 'publicado' and p.canal = 'shopee' and p.item_id is not null and p.criado_em >= lim.desde
     and (p_itens is null or p.item_id = any(p_itens))),
tl as (
  select l.* from anuncio_teste_log l, lim
   where l.criado_em >= lim.desde and l.item_id is not null and (p_itens is null or l.item_id = any(p_itens))),
ret as (
  select ((s.data::timestamp + time '07:30') at time zone 'America/Sao_Paulo') quando, s.shop_id, s.anuncio_id item_id, x.campo, x.de, x.para, x.descricao
    from (select z.*, lag(z.preco) over w p0, lag(z.em_promocao) over w e0, lag(z.status) over w s0
            from ads_anuncio_snapshot z, lim
           where z.marketplace = 'shopee' and z.variacao_id = '' and z.data >= lim.dia0
             and (p_itens is null or z.anuncio_id = any(p_itens))
          window w as (partition by z.shop_id, z.anuncio_id order by z.data)) s
    cross join lateral (values
      ('preco_venda', s.p0::text, s.preco::text, 'preço de venda', s.p0 is not null and abs(s.preco - s.p0) >= 0.01),
      ('promocao', case when s.e0 then 'em promoção' else 'sem promoção' end, case when s.em_promocao then 'em promoção' else 'sem promoção' end,
         case when s.em_promocao then 'entrou em promoção' else 'saiu da promoção' end, s.e0 is not null and s.em_promocao is distinct from s.e0),
      ('status_anuncio', s.s0, s.status, 'situação do anúncio', s.s0 is not null and s.status is distinct from s.s0)
    ) x(campo, de, para, descricao, mudou)
   where x.mudou)
-- pelo app (envio do anúncio)
select quando, shop_id, item_id, 'anuncio_criado', null::text, null::text, 'anúncio criado pelo app', 'app', quem, true, null::bigint, null::text, null::text
  from pub where operacao = 'criar'
union all
select quando, shop_id, item_id, 'fotos', null, (n_novas + n_mant)::text,
       format('%s foto(s) nova(s)%s', n_novas, case when n_mant > 0 then format(', %s mantida(s)', n_mant) else '' end), 'app', quem, true, null, null, null
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'fotos')::boolean, false)
union all
select quando, shop_id, item_id, 'titulo', e->'antes'->>'titulo', coalesce(e->>'titulo', e->'corpo'->>'item_name'), 'título', 'app', quem, true, null, null, null
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'titulo')::boolean, false)
union all
select quando, shop_id, item_id, 'descricao', null, null, 'descrição trocada', 'app', quem, true, null, null, null
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'descricao')::boolean, false)
union all
select quando, shop_id, item_id, 'preco_cheio', e->'antes'->>'preco', e->>'preco', 'preço cheio', 'app', quem, true, null, null, null
  from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'preco')::boolean, false) and e->>'preco' is not null
union all
-- visto pelo retrato diário (feito fora do app); o que o teste A/B mudou não repete aqui
select r.quando, r.shop_id, r.item_id, r.campo, r.de, r.para, r.descricao, 'fora', null, true, null, null, null
  from ret r, lim
 where r.quando >= lim.desde
   and not (r.campo = 'preco_venda' and exists (
         select 1 from tl where tl.item_id = r.item_id and tl.acao in ('preco', 'reverter:preco') and tl.ok
            and tl.criado_em <= r.quando and tl.criado_em >= r.quando - interval '2 days'))
union all
-- ADS: meta de ROAS, orçamento e situação da campanha
select h.ate, h.shop_id, c.item_id,
       case h.campo when 'roas_target' then 'roas' when 'budget' then 'orcamento' when 'status' then 'campanha' else h.campo end,
       h.de, h.para,
       case h.campo when 'roas_target' then 'ROAS alvo' when 'budget' then 'orçamento diário de ADS' when 'status' then 'campanha de ADS' else h.campo end,
       case h.origem when 'externo' then 'fora' when 'teste_ab' then 'teste' else 'app' end, h.quem, true, null, null, h.campaign_id
  from ads_config_historico h
  join ads_config_atual c on c.mkt = h.mkt and c.shop_id = h.shop_id and c.campaign_id = h.campaign_id, lim
 where h.mkt = 'shopee' and h.ate >= lim.desde and c.item_id is not null and (p_itens is null or c.item_id = any(p_itens))
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
       'teste', l.quem, coalesce(l.ok, false) and coalesce(l.conferido, true), l.id, l.braco, l.campaign_id
  from tl l
 where (l.acao in ('preco', 'titulo', 'criar_campanha', 'relampago_programacao', 'relampago_remover') or l.acao like 'reverter:%')
   and not (coalesce(l.ok, false) and l.enviado is null and l.acao in ('preco', 'titulo'))
$$;

create or replace function public.anuncio_mudanca_efeito(p_shop bigint, p_item text, p_dia date)
returns table (antes numeric, depois numeric, dias_depois int)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.venda_total) filter (where d.data < p_dia), 0),
         coalesce(sum(d.venda_total) filter (where d.data >= p_dia), 0),
         greatest(least(((now() at time zone 'America/Sao_Paulo')::date - p_dia), 7), 0)::int
    from ads_metrica_anuncio_dia d
   where d.marketplace = 'shopee' and d.shop_id = p_shop and d.nivel = 'anuncio' and d.anuncio_id = p_item
     and d.data >= p_dia - 7 and d.data <= p_dia + 6 and d.data < (now() at time zone 'America/Sao_Paulo')::date
$$;

create or replace function public.anuncios_mudancas(p_dias int default 30, p_filtro text default null, p_campo text default null,
  p_empresa text default null, p_busca text default null, p_offset int default 0, p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  with m as materialized (
    select x.*, a.nome, a.imagem_url foto, a.sku_pai sku, (x.quando at time zone 'America/Sao_Paulo')::date dia,
           case x.shop_id when 522186766 then 'Ottz' else 'Bumi' end loja
      from anuncio_mudancas_lista(least(greatest(p_dias, 1), 90)) x
      left join shopee_anuncios a on a.shop_id = x.shop_id and x.item_id ~ '^\d+$' and a.item_id = x.item_id::bigint
     where x.shop_id in (522186766, 759046323)
       and (p_empresa is null or (p_empresa = 'ottz' and x.shop_id = 522186766) or (p_empresa = 'svl' and x.shop_id = 759046323))
       and (p_busca is null or btrim(p_busca) = '' or x.item_id = btrim(p_busca) or public.ia_bate_busca(a.sku_pai, a.nome, p_busca))
       and (p_campo is null
            or (p_campo = 'preco' and x.campo in ('preco_venda', 'preco_cheio'))
            or (p_campo = 'conteudo' and x.campo in ('titulo', 'descricao', 'fotos', 'anuncio_criado'))
            or (p_campo = 'ads' and x.campo in ('roas', 'orcamento', 'campanha', 'campanha_nova'))
            or (p_campo = 'promocao' and x.campo in ('promocao', 'relampago', 'status_anuncio')))),
  e as materialized (
    select m.*, ef.antes, ef.depois, ef.dias_depois,
           (ef.dias_depois >= 3 and ef.antes >= 200 and ef.depois / nullif(ef.dias_depois, 0) < 0.7 * ef.antes / 7) piorou,
           (ef.dias_depois >= 3 and ef.depois / nullif(ef.dias_depois, 0) > 1.3 * greatest(ef.antes, 1) / 7 and ef.depois >= 200) melhorou
      from m left join lateral public.anuncio_mudanca_efeito(m.shop_id, m.item_id, m.dia) ef on true),
  f as (
    select * from e
     where p_filtro is null or (p_filtro = 'app' and origem = 'app') or (p_filtro = 'teste' and origem = 'teste')
        or (p_filtro = 'fora' and origem = 'fora') or (p_filtro = 'piorou' and piorou) or (p_filtro = 'falhou' and not ok))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'contagem', (select jsonb_build_object('tudo', count(*), 'app', count(*) filter (where origem = 'app'), 'teste', count(*) filter (where origem = 'teste'),
                   'fora', count(*) filter (where origem = 'fora'), 'piorou', count(*) filter (where piorou), 'falhou', count(*) filter (where not ok)) from e),
    'linhas', coalesce((select jsonb_agg(to_jsonb(z) order by z.quando desc, z.item_id) from (
        select quando, shop_id, loja, item_id, nome, foto, sku, campo, de, para, descricao, origem, quem, ok, log_id, braco, campanha,
               antes, depois, dias_depois, piorou, melhorou, (dia + 7) completo_em
          from f order by quando desc, item_id offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 200)) z), '[]'::jsonb),
    'hoje', hoje) into v;
  return v;
end $$;

create or replace function public.anuncios_no_ar(p_empresa text default null, p_busca text default null, p_atencao text default null,
  p_so_teste boolean default false, p_mudou7 boolean default false, p_ordem text default 'receita', p_offset int default 0, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  with ml as materialized (select * from anuncio_mudancas_lista(30)),
  mud as (select shop_id, item_id, max(quando) ultima, count(*) filter (where quando >= now() - interval '7 days') n7,
                 count(*) filter (where quando >= now() - interval '7 days' and origem in ('app', 'teste') and ok and campo <> 'desfeito') n7_sis
            from ml group by 1, 2),
  met as (select d.shop_id, d.anuncio_id,
                 sum(d.venda_total) filter (where d.data >= hoje - 7) v7, sum(d.venda_total) filter (where d.data < hoje - 7) v7a,
                 sum(d.unidades) filter (where d.data >= hoje - 7) u7, sum(d.gasto) filter (where d.data >= hoje - 7) g7,
                 sum(d.vendas_ads) filter (where d.data >= hoje - 7) va7, sum(d.margem) filter (where d.data >= hoje - 7) m7,
                 sum(d.margem_pos_ads) filter (where d.data >= hoje - 7) mp7
            from ads_metrica_anuncio_dia d
           where d.marketplace = 'shopee' and d.nivel = 'anuncio' and d.data >= hoje - 14 and d.data < hoje group by 1, 2),
  var as (select shop_id, item_id, min(preco) pmin, max(preco) pmax, count(*) n, sum(estoque) est from shopee_anuncios_variacao group by 1, 2),
  cfg as (select distinct on (shop_id, item_id) shop_id, item_id, campaign_id, roas_target, status, budget
            from ads_config_atual where mkt = 'shopee' and item_id is not null
           order by shop_id, item_id, (status = 'ongoing') desc, visto_em desc),
  marc as (select shop_id, item_id, jsonb_agg(jsonb_build_object('id', id, 'braco', braco, 'estrategia', estrategia, 'status', status) order by id) lista,
                  bool_or(status in ('pendente', 'em_andamento', 'divergente')) pend
             from anuncio_marcacao where item_id is not null group by 1, 2),
  j as materialized (
    select a.shop_id, a.item_id, a.nome, a.imagem_url foto, a.sku_pai sku, case a.shop_id when 522186766 then 'Ottz' else 'Bumi' end loja,
           coalesce(var.n, 0) n_var,
           case when coalesce(var.n, 0) > 0 then var.pmin else a.preco_min end preco,
           case when coalesce(var.n, 0) > 0 and var.pmax > var.pmin then var.pmax end preco_ate,
           case when coalesce(var.n, 0) = 0 and a.preco_max > a.preco_min then a.preco_max end preco_cheio,
           (case when coalesce(var.n, 0) > 0 then var.est else a.estoque_total end) estoque,
           coalesce(met.v7, 0) v7, coalesce(met.v7a, 0) v7a, coalesce(met.u7, 0) u7, coalesce(met.g7, 0) g7,
           case when met.g7 > 0 then round(met.va7 / met.g7, 1) end roas,
           case when met.v7 > 0 then round(100 * met.m7 / met.v7, 1) end mc_pct,
           case when met.v7 > 0 then round(100 * met.mp7 / met.v7, 1) end mc_pos_pct,
           coalesce(met.mp7, 0) mp7,
           cfg.campaign_id, cfg.roas_target meta, cfg.status campanha_status, cfg.budget orcamento,
           case when met.u7 > 0 and (case when coalesce(var.n, 0) > 0 then var.est else a.estoque_total end) is not null then round((case when coalesce(var.n, 0) > 0 then var.est else a.estoque_total end) / (met.u7 / 7.0), 1) end dias_estoque,
           (coalesce(met.u7, 0) >= 7 and (case when coalesce(var.n, 0) > 0 then var.est else a.estoque_total end) is not null and (case when coalesce(var.n, 0) > 0 then var.est else a.estoque_total end) < met.u7) f_estoque,
           (coalesce(met.v7a, 0) >= 500 and coalesce(met.v7, 0) < 0.7 * met.v7a) f_caindo,
           (coalesce(met.g7, 0) >= 20 and coalesce(met.mp7, 0) < 0) f_prejuizo,
           (marc.lista is not null) f_teste, coalesce(marc.pend, false) f_teste_pend, marc.lista marcacoes,
           coalesce(mud.n7, 0) n7, coalesce(mud.n7_sis, 0) n7_sis, mud.ultima
      from shopee_anuncios a
      left join met on met.shop_id = a.shop_id and met.anuncio_id = a.item_id::text
      left join var on var.shop_id = a.shop_id and var.item_id = a.item_id
      left join cfg on cfg.shop_id = a.shop_id and cfg.item_id = a.item_id::text
      left join marc on marc.shop_id = a.shop_id and marc.item_id = a.item_id::text
      left join mud on mud.shop_id = a.shop_id and mud.item_id = a.item_id::text
     where a.status = 'NORMAL' and a.shop_id in (522186766, 759046323)
       and (p_empresa is null or (p_empresa = 'ottz' and a.shop_id = 522186766) or (p_empresa = 'svl' and a.shop_id = 759046323))),
  f as (
    select j.* from j
     where (p_busca is null or btrim(p_busca) = '' or j.item_id::text = btrim(p_busca) or public.ia_bate_busca(j.sku, j.nome, p_busca)
            or exists (select 1 from shopee_anuncios_variacao vv where vv.shop_id = j.shop_id and vv.item_id = j.item_id and vv.sku = btrim(p_busca)))
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
              f.v7 desc, f.item_id
     offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 100))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'no_ar', (select count(*) from j),
    'resumo', (select jsonb_build_object('vendendo', count(*) filter (where v7 > 0), 'receita7', round(sum(v7)), 'receita7a', round(sum(v7a)), 'ads7', round(sum(g7))) from j),
    'atencao', (select jsonb_build_object(
        'estoque', count(*) filter (where f_estoque), 'zerado', count(*) filter (where f_estoque and estoque = 0),
        'caindo', count(*) filter (where f_caindo), 'caindo_rs', round(coalesce(sum(v7a - v7) filter (where f_caindo), 0)),
        'prejuizo', count(*) filter (where f_prejuizo), 'prejuizo_rs', round(coalesce(-sum(mp7) filter (where f_prejuizo), 0)),
        'medicao', coalesce(sum(n7_sis), 0), 'medicao_anuncios', count(*) filter (where n7_sis > 0)) from j)
      || (select jsonb_build_object('teste', count(*), 'teste_bracos', coalesce(string_agg(braco, ', ' order by id), ''))
            from anuncio_marcacao where status in ('pendente', 'em_andamento', 'divergente')),
    'linhas', coalesce((select jsonb_agg((to_jsonb(p) - 'mp7'::text) || jsonb_build_object(
          'ultima_mudanca', (select to_jsonb(u) from (select ml.quando, ml.campo, ml.de, ml.para, ml.descricao, ml.origem, ml.ok
                               from ml where ml.shop_id = p.shop_id and ml.item_id = p.item_id::text order by ml.quando desc limit 1) u),
          'sku_editar', coalesce(
              (select pr.sku from produtos pr where pr.sku = p.sku and pr.ativo limit 1),
              (select pr.sku_pai from produtos pr join shopee_anuncios_variacao vv on vv.sku = pr.sku
                where vv.shop_id = p.shop_id and vv.item_id = p.item_id and pr.ativo and pr.sku_pai is not null group by pr.sku_pai order by count(*) desc limit 1),
              (select pr.sku from produtos pr join shopee_anuncios_variacao vv on vv.sku = pr.sku
                where vv.shop_id = p.shop_id and vv.item_id = p.item_id and pr.ativo limit 1)))
        order by case when p_ordem = 'queda' then p.v7 - p.v7a end asc nulls last,
                 case when p_ordem = 'mexido' then p.ultima end desc nulls last,
                 case when p_ordem = 'margem' and p.v7 > 0 then p.mp7 / p.v7 end asc nulls last,
                 case when p_ordem = 'estoque' then p.dias_estoque end asc nulls last,
                 p.v7 desc, p.item_id) from pag p), '[]'::jsonb),
    'ate', hoje - 1, 'de', hoje - 7) into v;
  return v;
end $$;

create or replace function public.anuncio_no_ar_detalhe(p_shop bigint, p_item text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not (public.tem_modulo('ia') or public.tem_modulo('ads')) then raise exception 'sem acesso'; end if;
  select jsonb_build_object(
    'serie', (select jsonb_agg(jsonb_build_object('data', g.d::date, 'venda', coalesce(d.venda_total, 0), 'gasto', coalesce(d.gasto, 0), 'un', coalesce(d.unidades, 0)) order by g.d)
                from generate_series(hoje - 28, hoje - 1, interval '1 day') g(d)
                left join ads_metrica_anuncio_dia d on d.marketplace = 'shopee' and d.shop_id = p_shop and d.nivel = 'anuncio' and d.anuncio_id = p_item and d.data = g.d::date),
    'mudancas', coalesce((select jsonb_agg(to_jsonb(z) order by z.quando desc) from (
        select x.quando, x.campo, x.de, x.para, x.descricao, x.origem, x.quem, x.ok, x.log_id, x.braco, x.campanha,
               ef.antes, ef.depois, ef.dias_depois, ((x.quando at time zone 'America/Sao_Paulo')::date + 7) completo_em
          from anuncio_mudancas_lista(90, array[p_item]) x
          left join lateral public.anuncio_mudanca_efeito(p_shop, p_item, (x.quando at time zone 'America/Sao_Paulo')::date) ef on true
         where x.shop_id = p_shop order by x.quando desc limit 60) z), '[]'::jsonb),
    'campanhas', coalesce((select jsonb_agg(jsonb_build_object('campaign_id', c.campaign_id, 'status', c.status, 'roas_target', c.roas_target, 'budget', c.budget, 'nome', c.nome) order by (c.status = 'ongoing') desc, c.visto_em desc)
                   from ads_config_atual c where c.mkt = 'shopee' and c.shop_id = p_shop and c.item_id = p_item), '[]'::jsonb),
    'variacoes', coalesce((select jsonb_agg(jsonb_build_object('sku', vv.sku, 'preco', vv.preco, 'preco_cheio', vv.preco_original, 'estoque', vv.estoque) order by vv.preco)
                   from shopee_anuncios_variacao vv where vv.shop_id = p_shop and p_item ~ '^\d+$' and vv.item_id = p_item::bigint), '[]'::jsonb),
    'hoje', hoje) into v;
  return v;
end $$;

revoke all on function public.anuncio_mudancas_lista(int, text[]) from public, anon, authenticated;
revoke all on function public.anuncio_mudanca_efeito(bigint, text, date) from public, anon, authenticated;
grant execute on function public.anuncio_mudancas_lista(int, text[]) to service_role;
grant execute on function public.anuncio_mudanca_efeito(bigint, text, date) to service_role;
revoke all on function public.anuncios_mudancas(int, text, text, text, text, int, int) from public, anon;
revoke all on function public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int) from public, anon;
revoke all on function public.anuncio_no_ar_detalhe(bigint, text) from public, anon;
grant execute on function public.anuncios_mudancas(int, text, text, text, text, int, int) to authenticated, service_role;
grant execute on function public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int) to authenticated, service_role;
grant execute on function public.anuncio_no_ar_detalhe(bigint, text) to authenticated, service_role;

-- Rollback:
-- drop function if exists public.anuncio_no_ar_detalhe(bigint, text);
-- drop function if exists public.anuncios_no_ar(text, text, text, boolean, boolean, text, int, int);
-- drop function if exists public.anuncios_mudancas(int, text, text, text, text, int, int);
-- drop function if exists public.anuncio_mudanca_efeito(bigint, text, date);
-- drop function if exists public.anuncio_mudancas_lista(int, text[]);
