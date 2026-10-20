-- ============================================================================
-- Análise de ADS — outras mudanças do anúncio (20/out/2026, pedido do dono)
-- ads_mudancas_anuncio(mkt 'shopee'|'ml', shop, itens[]) → eventos {tipo 'anuncio', campo, item_id, de, para, descricao,
-- quando, origem, quem}: o que o SISTEMA enviou ao anúncio (ia_publicacao publicado: criado, fotos, título, descrição,
-- preço cheio — origem 'app') e o que o RETRATO DIÁRIO viu mudar (ads_anuncio_snapshot, linha do anúncio: preço de venda,
-- entrou/saiu de promoção, situação — origem 'retrato', quando = dia do retrato às 07h30 BRT). 120 dias.
-- ads_analise_anuncio e ads_analise_anuncio_ml juntam esses eventos a `mudancas` (migração ads_analise_mudancas_anuncio,
-- troca de texto na função no ar), com antes/depois de 7 dias: Shopee = campanha; ML = o anúncio quando escolhido, senão
-- a campanha (eventos de todos os MLB da campanha em 120 d). Na tela: selo "anúncio" na lista de alterações.
-- ============================================================================
create or replace function public.ads_mudancas_anuncio(p_mkt text, p_shop bigint, p_itens text[])
returns jsonb language sql stable security definer set search_path = public as $$
with pub as (
  select p.criado_em quando, p.operacao, p.criado_por_nome quem, p.item_id, p.enviado e,
         case when jsonb_typeof(p.enviado->'fotos'->'novas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'novas') else 0 end n_novas,
         case when jsonb_typeof(p.enviado->'fotos'->'mantidas') = 'array' then jsonb_array_length(p.enviado->'fotos'->'mantidas') else 0 end n_mant,
         case when jsonb_typeof(p.enviado->'antes'->'fotos') = 'array' then jsonb_array_length(p.enviado->'antes'->'fotos') end n_antes
    from public.ia_publicacao p
   where p.estado = 'publicado' and p.item_id = any(p_itens)
     and p.canal = case when p_mkt = 'shopee' then 'shopee' else 'mercado_livre' end
     and (p_mkt <> 'shopee' or p.shop_id = p_shop)
     and p.criado_em >= now() - interval '120 days'),
ev as (
  select quando, item_id, quem, 'app'::text origem, 'anuncio_criado'::text campo, null::text de, null::text para,
         'anúncio criado pelo sistema'::text descricao from pub where operacao = 'criar'
  union all
  select quando, item_id, quem, 'app', 'fotos', n_antes::text, (n_novas + n_mant)::text,
         format('%s foto(s) nova(s) do sistema%s', n_novas, case when n_mant > 0 then format(', %s mantida(s)', n_mant) else ', as anteriores saíram' end)
    from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'fotos')::boolean, false)
  union all
  select quando, item_id, quem, 'app', 'titulo', e->'antes'->>'titulo', coalesce(e->>'titulo', e->'corpo'->>'item_name'), 'título trocado'
    from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'titulo')::boolean, false)
  union all
  select quando, item_id, quem, 'app', 'descricao', null, null, 'descrição trocada'
    from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'descricao')::boolean, false)
  union all
  select quando, item_id, quem, 'app', 'preco', e->'antes'->>'preco', e->>'preco', 'preço cheio trocado'
    from pub where operacao = 'atualizar' and coalesce((e->'campos'->>'preco')::boolean, false) and e->>'preco' is not null
  union all
  select ((s.data::timestamp + time '07:30') at time zone 'America/Sao_Paulo'), s.anuncio_id, null, 'retrato', x.campo, x.de, x.para, x.descricao
    from (select z.*, lag(z.preco) over w p0, lag(z.em_promocao) over w e0, lag(z.status) over w s0
            from public.ads_anuncio_snapshot z
           where z.marketplace = case when p_mkt = 'shopee' then 'shopee' else 'mercadolivre' end
             and z.anuncio_id = any(p_itens) and z.variacao_id = '' and (p_mkt <> 'shopee' or z.shop_id = p_shop)
          window w as (partition by z.shop_id, z.anuncio_id order by z.data)) s
    cross join lateral (values
      ('preco_venda', s.p0::text, s.preco::text, 'preço de venda mudou', s.p0 is not null and abs(s.preco - s.p0) >= 0.01),
      ('promocao', case when s.e0 then 'em promoção' else 'sem promoção' end, case when s.em_promocao then 'em promoção' else 'sem promoção' end,
         case when s.em_promocao then 'entrou em promoção' else 'saiu da promoção' end, s.e0 is not null and s.em_promocao is distinct from s.e0),
      ('status_anuncio', s.s0, s.status, 'situação do anúncio mudou', s.s0 is not null and s.status is distinct from s.s0)
    ) x(campo, de, para, descricao, mudou)
   where x.mudou)
select coalesce(jsonb_agg(jsonb_build_object('tipo', 'anuncio', 'campo', campo, 'item_id', item_id, 'de', de, 'para', para,
         'descricao', descricao, 'quando', quando, 'origem', origem, 'quem', quem, 'aproximada', false) order by quando desc), '[]'::jsonb)
  from ev;
$$;
revoke all on function public.ads_mudancas_anuncio(text, bigint, text[]) from public, anon;
grant execute on function public.ads_mudancas_anuncio(text, bigint, text[]) to authenticated, service_role;
