-- ia_analise_sku (12/out/2026) — dados da aba "Análise" do anúncio (/ia/gerar?aba=analise).
-- Uma chamada devolve, para o SKU (e, se ele é pai, para as variações dele):
--   * `dias`     — unidades e receita por dia e marketplace (pedidos válidos; dia em Brasília);
--   * `canais`   — 30 dias por marketplace/loja com margem de contribuição, ADS e margem pós-ADS
--                  (matview ads_margem_anuncio, a mesma fonte do Agente de ADS / Pedidos Integrados;
--                  cobre Shopee e Mercado Livre);
--   * `anuncios` — o mesmo, aberto por anúncio (de qual anúncio saiu a venda e quanto de ADS ele levou);
--   * `historico`— ia_hist_sku_canal (30/120 dias, todos os canais, inclusive Amazon e TikTok);
--   * `estoque`  — por SKU FÍSICO (kit = o componente): saldo do Geral no Tiny, Full, em trânsito,
--                  custo, valor em estoque e, quando o SKU está na view de cobertura, venda/dia e dias.
-- SKU vendido = sku_filho; sku_pai só quando não há variação (ou na Amazon, onde o filho vem cru).
-- Leitura pesada fica no banco (regra do projeto); o app só chama com o módulo `ia`.
create or replace function public.ia_analise_sku(p_sku text, p_dias integer default 60)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v jsonb; v_skus text[]; v_fis text[];
  v_dias int := least(greatest(coalesce(p_dias, 60), 7), 120);
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_de timestamptz := ((v_hoje - v_dias)::timestamp at time zone 'America/Sao_Paulo');
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  select array_agg(x.sku) into v_skus
  from (select p_sku as sku union select p.sku from public.produtos p where p.sku_pai = p_sku and p.ativo) x;
  select array_agg(distinct coalesce(k.sku_componente, s.sku)) into v_fis
  from unnest(v_skus) s(sku)
  join public.produtos p on p.sku = s.sku
  left join public.produto_kits k on k.sku_kit = s.sku
  where p.tipo is distinct from 'V';

  select jsonb_build_object(
    'sku', p_sku, 'skus', to_jsonb(v_skus), 'dias_janela', v_dias, 'hoje', v_hoje,
    'dias', (select coalesce(jsonb_agg(jsonb_build_object('data', z.d, 'marketplace', z.mk, 'unidades', z.un, 'receita', z.rc) order by z.d, z.mk), '[]'::jsonb)
      from (
        select (pv.data_pedido at time zone 'America/Sao_Paulo')::date as d, pv.marketplace as mk,
               sum(pi.quantidade) as un, round(sum(pi.subtotal_produto), 2) as rc
        from public.pedido_itens pi
        join public.pedidos_validos pv on pv.id = pi.pedido_id
        where pv.data_pedido >= v_de
          and (pi.sku_filho = any (v_skus)
               or ((pi.sku_filho is null or pi.sku_filho = '' or pv.marketplace = 'amazon') and pi.sku_pai = any (v_skus)))
        group by 1, 2
      ) z),
    'canais', (select coalesce(jsonb_agg(to_jsonb(c) order by c.receita desc), '[]'::jsonb)
      from (
        select a.marketplace, a.shop_id, max(a.empresa) as empresa, sum(a.receita) as receita, sum(a.unidades) as unidades,
               sum(a.pedidos) as pedidos, sum(a.cmv) as cmv, sum(a.margem_contribuicao) as margem, sum(a.gasto_ads) as gasto_ads,
               sum(a.margem_pos_ads) as margem_pos_ads, bool_and(a.confiavel) as confiavel
        from public.ads_margem_anuncio a
        where a.nivel = 'sku' and a.sku = any (v_skus)
        group by 1, 2
      ) c),
    'anuncios', (select coalesce(jsonb_agg(to_jsonb(n) order by n.receita desc), '[]'::jsonb)
      from (
        select a.marketplace, a.shop_id, a.empresa, a.anuncio_id, a.titulo, a.sku, a.receita, a.unidades, a.margem_contribuicao as margem,
               a.margem_contribuicao_pct as margem_pct, a.gasto_ads, a.margem_pos_ads, a.margem_pos_ads_pct, a.situacao, a.confiavel
        from public.ads_margem_anuncio a
        where a.nivel = 'sku' and a.sku = any (v_skus)
        order by a.receita desc limit 40
      ) n),
    'margem_em', (select max(atualizado_em) from public.ads_margem_anuncio),
    'historico', (select coalesce(jsonb_agg(jsonb_build_object('sku', h.sku, 'canal', h.canal, 'empresa', h.empresa, 'un30', h.unidades_30d,
                    'un120', h.unidades_120d, 'preco', coalesce(h.preco_unit_ult, h.preco_unit_med), 'taxa', h.taxa_med, 'mc_pct', h.mc_pct,
                    'ultima_venda', h.ultima_venda) order by h.unidades_120d desc), '[]'::jsonb)
      from public.ia_hist_sku_canal h where h.sku = any (v_skus)),
    'estoque', (select coalesce(jsonb_agg(to_jsonb(e) order by e.sku), '[]'::jsonb)
      from (
        select f.sku, pr.nome, pr.tipo, ce.cmv_efetivo as custo,
               t.geral, t.reservado, t.atualizado_em as tiny_em, fl.full_total, fl.em_transito, fl.por_canal,
               round((greatest(coalesce(t.geral, 0), 0) + coalesce(fl.full_total, 0) + coalesce(fl.em_transito, 0)) * coalesce(ce.cmv_efetivo, 0), 2) as valor,
               cb.full_amazon, cb.full_ml, cb.full_shopee, cb.full_em_transito, cb.estoque_geral as geral_disponivel, cb.estoque_total, cb.valor_estoque, cb.venda_30d, cb.venda_dia, cb.cobertura_total_dias, cb.oc_aguardando, cb.status as situacao,
               (select coalesce(jsonb_agg(jsonb_build_object('kit', k.sku_kit, 'quantidade', k.quantidade)), '[]'::jsonb)
                  from public.produto_kits k where k.sku_componente = f.sku and k.sku_kit = any (v_skus)) as usado_em
        from unnest(coalesce(v_fis, '{}'::text[])) f(sku)
        left join public.produtos pr on pr.sku = f.sku
        left join public.view_cmv_efetivo ce on ce.sku = f.sku
        left join lateral (
          select sum(et.saldo) filter (where et.deposito = 'Geral') as geral,
                 sum(et.saldo_reservado) filter (where et.deposito = 'Geral') as reservado, max(et.atualizado_em) as atualizado_em
          from public.estoque_tiny et where et.sku = f.sku
        ) t on true
        left join lateral (
          select sum(g.sellable) as full_total, sum(g.in_transit) as em_transito, jsonb_object_agg(g.marketplace, g.sellable) as por_canal
          from (select ef.marketplace, sum(ef.sellable) as sellable, sum(ef.in_transit) as in_transit
                from public.estoque_fulfillment ef where ef.sku = f.sku group by 1) g
        ) fl on true
        left join public.view_cobertura_fornecedor cb on cb.sku = f.sku
      ) e)
  ) into v;
  return v;
end $function$;

revoke all on function public.ia_analise_sku(text, integer) from public, anon;
grant execute on function public.ia_analise_sku(text, integer) to authenticated, service_role;
