-- =============================================================================
-- IA · Anúncios — Fase 2b (10/out/2026) — migração `ia_11_preco_historico_catalogo`
-- Pedido do dono: (1) o preço usa o que a gestão JÁ SABE dos pedidos (taxas reais
-- por canal e faixa de preço, e o histórico do próprio produto), em vez de uma
-- tabela de faixas mantida à mão; (2) a lista de Anúncios espelha o catálogo ativo.
-- Não altera tabela existente. `ia_canal_faixa` fica sem uso (não é apagada).
-- APLICADA em 10/out/2026 + cron 153 `ia-historico`.
-- ATENÇÃO: logo depois veio a migração `ia_12_taxa_faixas_finas`, que SUBSTITUIU
-- ia_faixa_preco / ia_faixas / ia_historico_atualizar / ia_faixas_taxa deste arquivo:
--   * faixas finas (R$ 5 até 100, R$ 10 até 200, R$ 50 até 500) no lugar das 6 largas;
--   * ia_hist_taxa_faixa ganhou taxa_suave / n_suave (média ponderada com as faixas a
--     ±15% do preço, sem atravessar R$ 80) e linhas para TODAS as faixas de cada canal;
--   * ia_hist_sku_canal ganhou pedidos_1un / preco_1un_med (taxa_med só de pedidos de 1 un.);
--   * ia_faixas_taxa: taxa da faixa × (taxa do produto ÷ taxa do canal no preço dele)
--     quando o produto já vende no canal.
-- A versão em vigor está no banco (supabase_migrations) e descrita em CLAUDE.md §5.11.2.
-- Rollback no fim.
-- =============================================================================

-- ---------------------------------------------------------------- faixas de preço
-- Degraus reais das tarifas: R$ 80 (Shopee e ML mudam de regra), R$ 100 e R$ 200.
create or replace function public.ia_faixa_preco(p numeric)
returns smallint language sql immutable as $$
  select (case when p < 30 then 1 when p < 50 then 2 when p < 80 then 3
               when p < 100 then 4 when p < 200 then 5 else 6 end)::smallint
$$;

create or replace function public.ia_faixas()
returns table (faixa smallint, preco_min numeric, preco_max numeric) language sql immutable as $$
  values (1::smallint, 0::numeric, 29.99::numeric), (2::smallint, 30, 49.99), (3::smallint, 50, 79.99),
         (4::smallint, 80, 99.99), (5::smallint, 100, 199.99), (6::smallint, 200, null)
$$;

-- ---------------------------------------------------------------- histórico (preenchido 1×/dia)
-- Taxa = (venda − recebido) / venda do pedido: tudo que o marketplace desconta
-- (comissão, tarifa fixa, frete do vendedor). Só pedidos de 1 SKU e 1 unidade.
-- empresa '*' = as duas; faixa 0 = todas as faixas (usadas quando falta amostra).
create table if not exists public.ia_hist_taxa_faixa (
  canal         text not null,
  empresa       text not null,
  faixa         smallint not null,
  n             integer not null,
  taxa_med      numeric not null,
  taxa_p25      numeric,
  taxa_p75      numeric,
  preco_med     numeric,
  atualizado_em timestamptz not null default now(),
  primary key (canal, empresa, faixa)
);

-- Como cada produto vende hoje em cada canal/empresa (120 dias).
create table if not exists public.ia_hist_sku_canal (
  sku            text not null,
  canal          text not null,
  empresa        text not null,
  unidades_30d   numeric not null default 0,   -- todos os pedidos
  unidades_120d  numeric not null default 0,
  pedidos_mono   integer not null default 0,   -- pedidos só deste SKU (base de preço/taxa/margem)
  preco_unit_med numeric,
  preco_unit_ult numeric,                      -- preço unitário do pedido mais recente
  taxa_med       numeric,
  mc_pct         numeric,                      -- soma da margem / soma da venda (custo completo)
  ultima_venda   date,
  atualizado_em  timestamptz not null default now(),
  primary key (sku, canal, empresa)
);

alter table public.ia_hist_taxa_faixa enable row level security;
alter table public.ia_hist_sku_canal enable row level security;
grant select on public.ia_hist_taxa_faixa, public.ia_hist_sku_canal to authenticated;
grant all on public.ia_hist_taxa_faixa, public.ia_hist_sku_canal to service_role;
create policy ia_hist_taxa_faixa_ler on public.ia_hist_taxa_faixa for select to authenticated using (public.tem_modulo('ia'));
create policy ia_hist_sku_canal_ler on public.ia_hist_sku_canal for select to authenticated using (public.tem_modulo('ia'));

create or replace function public.ia_historico_atualizar()
returns text language plpgsql security definer set search_path = public as $$
declare v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; n1 int; n2 int;
begin
  -- uma leitura só da margem por pedido (~7 s para 120 dias)
  create temp table _ia_b on commit drop as
  select m.order_sn, m.marketplace,
         case m.marketplace when 'mercadolivre' then 'mercado_livre' else m.marketplace end as canal,
         case m.empresa when 'SVL Store' then 'svl' else 'ottz' end as empresa,
         (m.data_pedido at time zone 'America/Sao_Paulo')::date as dia,
         m.venda, m.recebido_estimado as rec, m.margem, m.cobertura_cmv
  from public.view_margem_pedido_v2 m
  where m.data_pedido >= now() - interval '120 days' and m.venda > 0 and m.empresa in ('ACZ Pet', 'SVL Store');

  -- SKU vendido por pedido (mesma resolução da view de margem)
  create temp table _ia_i on commit drop as
  select b.order_sn,
         case when b.marketplace = 'amazon' then pi.sku_pai else coalesce(nullif(pi.sku_filho, ''), pi.sku_pai) end as sku,
         sum(pi.quantidade) as qtd
  from _ia_b b join public.pedido_itens pi on pi.pedido_id = b.order_sn
  where b.marketplace <> 'tiktok'
  group by 1, 2
  union all
  select b.order_sn, ti.sku, count(*)::numeric
  from _ia_b b join public.tiktok_pedido_itens ti on ti.pedido_id = b.order_sn
  where b.marketplace = 'tiktok' and not coalesce(ti.is_gift, false)
  group by 1, 2;

  -- pedidos de um SKU só, com repasse conhecido
  create temp table _ia_m on commit drop as
  select b.canal, b.empresa, b.dia, b.venda, b.rec, b.margem, b.cobertura_cmv, x.sku, x.qtd
  from _ia_b b
  join (select order_sn, min(sku) as sku, sum(qtd) as qtd from _ia_i where sku is not null group by 1 having count(*) = 1) x using (order_sn)
  where x.qtd > 0 and b.rec is not null and b.rec > 0 and b.rec < b.venda;

  delete from public.ia_hist_taxa_faixa;
  insert into public.ia_hist_taxa_faixa (canal, empresa, faixa, n, taxa_med, taxa_p25, taxa_p75, preco_med)
  select canal, coalesce(empresa, '*'), coalesce(faixa, 0), count(*),
         round((percentile_cont(0.5)  within group (order by (venda - rec) / venda))::numeric, 4),
         round((percentile_cont(0.25) within group (order by (venda - rec) / venda))::numeric, 4),
         round((percentile_cont(0.75) within group (order by (venda - rec) / venda))::numeric, 4),
         round((percentile_cont(0.5)  within group (order by venda))::numeric, 2)
  from (select canal, empresa, public.ia_faixa_preco(venda) as faixa, venda, rec from _ia_m where qtd = 1) x
  group by grouping sets ((canal, empresa, faixa), (canal, faixa), (canal, empresa), (canal));
  get diagnostics n1 = row_count;

  delete from public.ia_hist_sku_canal;
  insert into public.ia_hist_sku_canal
    (sku, canal, empresa, unidades_30d, unidades_120d, pedidos_mono, preco_unit_med, preco_unit_ult, taxa_med, mc_pct, ultima_venda)
  select u.sku, u.canal, u.empresa, u.un30, u.un120, coalesce(s.pedidos, 0), s.preco_med, s.preco_ult, s.taxa_med, s.mc_pct, u.ultima
  from (
    select i.sku, b.canal, b.empresa,
           coalesce(sum(i.qtd) filter (where b.dia >= v_hoje - 30), 0) as un30, sum(i.qtd) as un120, max(b.dia) as ultima
    from _ia_i i join _ia_b b using (order_sn)
    where i.sku is not null group by 1, 2, 3
  ) u
  left join (
    select sku, canal, empresa, count(*) as pedidos,
           round((percentile_cont(0.5) within group (order by venda / qtd))::numeric, 2) as preco_med,
           round(((array_agg(venda / qtd order by dia desc))[1])::numeric, 2) as preco_ult,
           round((percentile_cont(0.5) within group (order by (venda - rec) / venda))::numeric, 4) as taxa_med,
           round(sum(margem) filter (where cobertura_cmv = 'completo')
                 / nullif(sum(venda) filter (where cobertura_cmv = 'completo'), 0), 4) as mc_pct
    from _ia_m group by 1, 2, 3
  ) s using (sku, canal, empresa);
  get diagnostics n2 = row_count;

  return format('faixas: %s · sku×canal: %s', n1, n2);
end $$;

-- ---------------------------------------------------------------- taxa por faixa para um produto/canal
-- Shopee: tabela de comissão em vigor (a MESMA das telas de promoção — `shopee_tarifa`).
-- Demais canais: histórico, do mais específico para o mais geral.
create or replace function public.ia_faixas_taxa(p_sku text, p_canal text, p_empresa text)
returns table (faixa smallint, preco_min numeric, preco_max numeric, pct numeric, fixo numeric, fonte text, nivel text, n integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_canal = 'shopee' then
    return query
    select (row_number() over (order by t.preco_min))::smallint, t.preco_min, t.preco_max, t.pct, t.fixo_unidade,
           'tabela de comissão da Shopee em vigor'::text, 'tabela'::text, null::integer
    from public.shopee_tarifa_vigente() t;
    return;
  end if;
  return query
  select f.faixa, f.preco_min, f.preco_max, x.pct, 0::numeric, x.fonte, x.nivel, x.n
  from public.ia_faixas() f
  cross join lateral (
    select z.pct, z.fonte, z.nivel, z.n from (
      select 1 as ord, h.taxa_med as pct, 'pedidos deste produto neste canal'::text as fonte, 'sku'::text as nivel, h.pedidos_mono as n
        from public.ia_hist_sku_canal h
        where h.sku = p_sku and h.canal = p_canal and h.empresa = p_empresa and h.pedidos_mono >= 5
          and h.taxa_med is not null and public.ia_faixa_preco(h.preco_unit_med) = f.faixa
      union all
      select 2, t.taxa_med, 'pedidos do canal nesta faixa de preço', 'faixa', t.n
        from public.ia_hist_taxa_faixa t where t.canal = p_canal and t.empresa = p_empresa and t.faixa = f.faixa and t.n >= 20
      union all
      select 3, t.taxa_med, 'pedidos do canal nesta faixa (as duas empresas)', 'faixa_geral', t.n
        from public.ia_hist_taxa_faixa t where t.canal = p_canal and t.empresa = '*' and t.faixa = f.faixa and t.n >= 20
      union all
      select 4, t.taxa_med, 'média do canal (poucos pedidos nesta faixa)', 'canal', t.n
        from public.ia_hist_taxa_faixa t where t.canal = p_canal and t.empresa = p_empresa and t.faixa = 0 and t.n >= 20
      union all
      select 5, t.taxa_med, 'média do canal (poucos pedidos nesta faixa)', 'canal', t.n
        from public.ia_hist_taxa_faixa t where t.canal = p_canal and t.empresa = '*' and t.faixa = 0 and t.n >= 10
      union all
      select 6, c.comissao_pct, 'comissão cadastrada em IA › Prompts › Canais (sem pedidos do canal)', 'cadastro', null::integer
        from public.ia_canal_config c where c.canal = p_canal and c.comissao_pct > 0
    ) z order by z.ord limit 1
  ) x;
end $$;

-- ---------------------------------------------------------------- preço sugerido
create or replace function public.ia_calcular_preco(p_sku text, p_canal text, p_empresa text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_custo numeric; v_frete numeric := 0; v_emb numeric := 0.30;
  v_cfg public.ia_canal_config%rowtype; v_emp public.ia_empresa%rowtype; v record; v_hist jsonb;
  v_ct numeric; v_denom numeric; v_preco numeric; v_lucro numeric; v_tem boolean := false;
begin
  select cmv_efetivo into v_custo from public.view_cmv_efetivo where sku = p_sku;
  if v_custo is null then return jsonb_build_object('erro', 'produto sem custo na gestão (SKU ' || p_sku || ')'); end if;
  select coalesce(frete_adicional, 0), coalesce(custo_embalagem, 0.30) into v_frete, v_emb
  from public.ia_produto_extra where sku = p_sku;
  v_frete := coalesce(v_frete, 0); v_emb := coalesce(v_emb, 0.30);
  select * into v_cfg from public.ia_canal_config where canal = p_canal;
  if not found then return jsonb_build_object('erro', 'canal inexistente: ' || p_canal); end if;
  select * into v_emp from public.ia_empresa where codigo = p_empresa;
  if not found then return jsonb_build_object('erro', 'empresa inexistente: ' || p_empresa); end if;
  v_ct := v_custo + v_frete + v_emb;

  select jsonb_build_object('preco', coalesce(h.preco_unit_ult, h.preco_unit_med), 'preco_mediano', h.preco_unit_med,
           'unidades_30d', h.unidades_30d, 'unidades_120d', h.unidades_120d, 'mc_pct', h.mc_pct,
           'taxa_pct', h.taxa_med, 'pedidos', h.pedidos_mono, 'ultima_venda', h.ultima_venda)
    into v_hist
  from public.ia_hist_sku_canal h where h.sku = p_sku and h.canal = p_canal and h.empresa = p_empresa;

  for v in select * from public.ia_faixas_taxa(p_sku, p_canal, p_empresa) order by faixa loop
    v_tem := true;
    v_denom := 1 - v_emp.imposto_pct - v.pct - v_cfg.custos_fixos_pct - v_cfg.margem_alvo_pct;
    if v_denom <= 0 then continue; end if;
    v_preco := greatest((v_ct + v.fixo) / v_denom, v.preco_min);
    if v.preco_max is null or v_preco <= v.preco_max then
      v_preco := round(v_preco, 2);
      v_lucro := round(v_preco * (1 - v_emp.imposto_pct - v.pct - v_cfg.custos_fixos_pct) - v_ct - v.fixo, 2);
      return jsonb_build_object(
        'preco_sugerido', v_preco, 'lucro_reais', v_lucro, 'margem_estimada_pct', round(v_lucro / v_preco, 4),
        'historico', v_hist,
        'memoria_calculo', jsonb_build_object(
          'empresa', v_emp.codigo, 'custo_mercadoria', v_custo, 'fonte_custo', 'view_cmv_efetivo',
          'frete_adicional', v_frete, 'embalagem', v_emb, 'custo_total', v_ct,
          'faixa', v.faixa, 'faixa_min', v.preco_min, 'faixa_max', v.preco_max,
          'comissao_pct', v.pct, 'tarifa_fixa', v.fixo,
          'fonte_taxa', v.fonte, 'nivel_taxa', v.nivel, 'amostra', v.n,
          'imposto_pct', v_emp.imposto_pct, 'custos_fixos_pct', v_cfg.custos_fixos_pct,
          'margem_alvo_pct', v_cfg.margem_alvo_pct,
          'formula', '(custo_total + tarifa_fixa) / (1 - imposto - taxa_do_canal - custos_fixos - margem_alvo)',
          'calculado_em', now()));
    end if;
  end loop;
  if not v_tem then
    return jsonb_build_object('historico', v_hist, 'erro',
      'ainda não há pedidos deste canal com repasse na gestão para medir a taxa. Informe a comissão em IA › Prompts › Canais.');
  end if;
  return jsonb_build_object('historico', v_hist, 'erro', 'com este custo e a margem alvo, nenhum preço fecha neste canal');
end $$;

create or replace function public.ia_analisar_preco(p_sku text, p_canal text, p_empresa text, p_preco numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_custo numeric; v_frete numeric := 0; v_emb numeric := 0.30;
  v_cfg public.ia_canal_config%rowtype; v_emp public.ia_empresa%rowtype; v record;
  v_ct numeric; v_lucro numeric; v_lucro_p numeric; v_custo_mx numeric;
begin
  select cmv_efetivo into v_custo from public.view_cmv_efetivo where sku = p_sku;
  if v_custo is null then return jsonb_build_object('erro', 'produto sem custo na gestão (SKU ' || p_sku || ')'); end if;
  if p_preco is null or p_preco <= 0 then return jsonb_build_object('erro', 'preço inválido'); end if;
  select coalesce(frete_adicional, 0), coalesce(custo_embalagem, 0.30) into v_frete, v_emb
  from public.ia_produto_extra where sku = p_sku;
  v_frete := coalesce(v_frete, 0); v_emb := coalesce(v_emb, 0.30);
  select * into v_cfg from public.ia_canal_config where canal = p_canal;
  if not found then return jsonb_build_object('erro', 'canal inexistente: ' || p_canal); end if;
  select * into v_emp from public.ia_empresa where codigo = p_empresa;
  if not found then return jsonb_build_object('erro', 'empresa inexistente: ' || p_empresa); end if;
  select * into v from public.ia_faixas_taxa(p_sku, p_canal, p_empresa) t
  where p_preco >= t.preco_min and (t.preco_max is null or p_preco <= t.preco_max + 0.009)
  order by t.faixa limit 1;
  if not found then
    return jsonb_build_object('erro', 'ainda não há pedidos deste canal com repasse na gestão para medir a taxa');
  end if;
  v_ct := v_custo + v_frete + v_emb;
  v_lucro := round(p_preco * (1 - v_emp.imposto_pct - v.pct - v_cfg.custos_fixos_pct) - v_ct - v.fixo, 2);
  v_lucro_p := round(v_lucro / p_preco, 4);
  v_custo_mx := round(p_preco * (1 - v_emp.imposto_pct - v.pct - v_cfg.custos_fixos_pct - v_cfg.margem_alvo_pct)
                - v.fixo - v_frete - v_emb, 2);
  return jsonb_build_object(
    'preco_praticado', p_preco, 'lucro_reais', v_lucro, 'lucro_pct', v_lucro_p,
    'status', case when v_lucro_p >= v_cfg.margem_alvo_pct then 'ok' when v_lucro_p > 0 then 'baixo' else 'prejuizo' end,
    'custo_max_mercadoria', v_custo_mx, 'folga_reais', round(v_custo_mx - v_custo, 2),
    'faixa', v.faixa, 'comissao_pct', v.pct, 'tarifa_fixa', v.fixo, 'fonte_taxa', v.fonte, 'nivel_taxa', v.nivel, 'amostra', v.n,
    'custo_total', v_ct, 'imposto_pct', v_emp.imposto_pct, 'margem_alvo_pct', v_cfg.margem_alvo_pct);
end $$;

-- ---------------------------------------------------------------- rascunho sem IA (escrever à mão)
create or replace function public.ia_rascunho_criar(p_sku text, p_canal text, p_empresa text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_pr jsonb; v_id uuid; v_nome text; v_custo numeric;
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  if not exists (select 1 from public.produtos where sku = p_sku) then raise exception 'SKU % não está no catálogo.', p_sku; end if;
  if not exists (select 1 from public.ia_canal_config where canal = p_canal) then raise exception 'Canal inexistente: %', p_canal; end if;
  if not exists (select 1 from public.ia_empresa where codigo = p_empresa) then raise exception 'Empresa inexistente: %', p_empresa; end if;
  v_pr := public.ia_calcular_preco(p_sku, p_canal, p_empresa);
  select cmv_efetivo into v_custo from public.view_cmv_efetivo where sku = p_sku;
  select nome into v_nome from public.perfis_usuario where user_id = auth.uid();
  insert into public.ia_rascunho (sku, canal, empresa, status, custo_snapshot, preco_sugerido, margem_estimada_pct, memoria_calculo, criado_por, criado_por_nome)
  values (p_sku, p_canal, p_empresa, 'rascunho', v_custo, (v_pr->>'preco_sugerido')::numeric, (v_pr->>'margem_estimada_pct')::numeric,
          coalesce(v_pr->'memoria_calculo', '{}'::jsonb) || jsonb_build_object('origem', 'manual'), auth.uid(), v_nome)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- catálogo para a tela /ia/anuncios
-- Produtos ATIVOS do catálogo + onde cada um vende hoje + situação do anúncio com IA.
-- Busca, filtro, ordenação e paginação no banco (são ~2,3 mil produtos).
create or replace function public.ia_catalogo(
  p_busca text default null, p_marca text default null, p_situacao text default 'todos',
  p_sem_canal text default null, p_ordem text default 'vendas', p_offset integer default 0, p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb; v_b text := nullif(btrim(coalesce(p_busca, '')), '');
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200); v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  with base as (
    select p.sku, p.nome, coalesce(p.marca_manual, p.marca) as marca, p.tipo
    from public.produtos p
    where p.ativo and not coalesce(p.arquivado, false)
  ), hist as (
    select h.sku, sum(h.unidades_30d) as un30, sum(h.unidades_120d) as un120, array_agg(distinct h.canal) as lista,
           jsonb_agg(jsonb_build_object('canal', h.canal, 'empresa', h.empresa, 'un30', h.unidades_30d, 'un120', h.unidades_120d,
             'preco', coalesce(h.preco_unit_ult, h.preco_unit_med), 'mc_pct', h.mc_pct) order by h.unidades_120d desc) as canais
    from public.ia_hist_sku_canal h group by 1
  ), rasc as (
    select r.sku, max(r.updated_at) as ultimo,
           bool_or(e.texto = 'aprovado' and e.imgs > 0 and e.imgs_ok = e.imgs) as pronto,
           jsonb_agg(jsonb_build_object('id', r.id, 'canal', r.canal, 'empresa', r.empresa, 'texto', e.texto,
             'imgs', e.imgs, 'imgs_ok', e.imgs_ok, 'andando', e.andando,
             'preco', coalesce(r.preco_aprovado, r.preco_sugerido), 'atualizado', r.updated_at) order by r.updated_at desc) as lista
    from public.ia_rascunho r
    left join lateral (
      select max(t.status) filter (where t.etapa = 'texto') as texto,
             count(*) filter (where t.etapa = 'imagem') as imgs,
             count(*) filter (where t.etapa = 'imagem' and t.status = 'aprovado') as imgs_ok,
             count(*) filter (where t.etapa = 'imagem' and t.status in ('na_fila', 'gerando')) as andando
      from public.ia_etapa t where t.rascunho_id = r.id
    ) e on true
    group by 1
  ), f as (
    select b.sku, b.nome, b.marca, b.tipo, coalesce(h.un30, 0) as un30, coalesce(h.un120, 0) as un120, h.canais,
           r.lista as rascunhos, r.ultimo,
           case when r.sku is null then 'sem' when r.pronto then 'pronto' else 'andamento' end as situacao
    from base b left join hist h using (sku) left join rasc r using (sku)
    where (v_b is null or b.sku ilike v_b || '%' or b.nome ilike '%' || v_b || '%')
      and (coalesce(p_marca, '') = '' or b.marca = p_marca)
      and (coalesce(p_sem_canal, '') = '' or not (p_sem_canal = any (coalesce(h.lista, '{}'::text[]))))
  ), g as (
    select * from f where coalesce(p_situacao, 'todos') in ('todos', '') or situacao = p_situacao
  ), num as (
    select g.*, row_number() over (order by
        case when p_ordem = 'nome' then g.nome end asc nulls last,
        case when p_ordem = 'recentes' then g.ultimo end desc nulls last,
        case when p_ordem = 'novos' then g.sku end desc nulls last,
        g.un30 desc, g.un120 desc, g.sku) as rn
    from g
  ), pag as (
    select * from num where rn > v_off and rn <= v_off + v_lim
  )
  select jsonb_build_object(
    'total', (select count(*) from g),
    'contagem', (select jsonb_build_object('todos', count(*), 'sem', count(*) filter (where situacao = 'sem'),
                   'andamento', count(*) filter (where situacao = 'andamento'), 'pronto', count(*) filter (where situacao = 'pronto')) from f),
    'marcas', (select coalesce(jsonb_agg(z.m order by z.m), '[]'::jsonb) from (select distinct marca as m from base where coalesce(marca, '') <> '') z),
    'historico_em', (select max(atualizado_em) from public.ia_hist_sku_canal),
    'linhas', (select coalesce(jsonb_agg(jsonb_build_object(
                 'sku', pag.sku, 'nome', pag.nome, 'marca', pag.marca, 'tipo', pag.tipo, 'foto', ft.foto, 'custo', c.cmv_efetivo,
                 'un30', pag.un30, 'un120', pag.un120, 'canais', coalesce(pag.canais, '[]'::jsonb),
                 'rascunhos', coalesce(pag.rascunhos, '[]'::jsonb), 'situacao', pag.situacao) order by pag.rn), '[]'::jsonb)
               from pag
               left join public.view_foto_produto ft on ft.sku = pag.sku
               left join public.view_cmv_efetivo c on c.sku = pag.sku)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------- permissões
revoke all on function public.ia_historico_atualizar() from public, anon, authenticated;
grant execute on function public.ia_historico_atualizar() to service_role;
revoke all on function public.ia_faixas_taxa(text, text, text) from public, anon;
revoke all on function public.ia_rascunho_criar(text, text, text) from public, anon;
revoke all on function public.ia_catalogo(text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.ia_faixas_taxa(text, text, text) to authenticated, service_role;
grant execute on function public.ia_rascunho_criar(text, text, text) to authenticated, service_role;
grant execute on function public.ia_catalogo(text, text, text, text, text, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------- cron (06h23 BRT, depois do custo do Tiny das 05h)
-- select cron.schedule('ia-historico', '23 9 * * *', $$select public.ia_historico_atualizar()$$);

-- =============================================================================
-- ROLLBACK
-- select cron.unschedule('ia-historico');
-- drop function if exists public.ia_catalogo(text,text,text,text,text,integer,integer), public.ia_rascunho_criar(text,text,text),
--   public.ia_faixas_taxa(text,text,text), public.ia_historico_atualizar(), public.ia_faixas(), public.ia_faixa_preco(numeric);
-- drop table if exists public.ia_hist_taxa_faixa, public.ia_hist_sku_canal;
-- ia_calcular_preco / ia_analisar_preco: reaplicar as versões de docs/ia-fase2-migracao.sql (faixas de ia_canal_faixa).
-- =============================================================================
