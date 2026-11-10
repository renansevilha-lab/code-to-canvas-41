-- ============================================================================
-- Produção › Custos e Preços — "Lançar no sistema" (10/nov/2026, pedido do dono: "dê a opção de lançar esse custo no
-- sistema, assim já temos a alteração nos Pedidos Integrados e também na aba de promoção").
-- O custo vai como CUSTO MANUAL VIGENTE (cmv_manual, a mesma camada do "Reprocessar CMV por período"):
--   * Pedidos Integrados / DRE: cmv_na_data = manual vigente > cadastro (kit = soma dos componentes, com o manual deles);
--     reprocessar_cmv_periodo recongela os pedidos do período (Shopee + ML) e grava o manual.
--   * Promoções (Minha Promoção, Relâmpago): promo_mc_base e flashsale_mc_base passam a usar cmv_na_data de HOJE
--     (antes liam produtos.custo direto, que vem do Tiny e é regravado todo dia às 05h).
--   * O custo do Tiny (precoCusto) NÃO é mexido (decisão de 28/out: custo médio do acabado em aberto).
-- Migração: producao_lancar_custo
-- ============================================================================

-- 1) o custo que o sistema usa hoje (para a tela comparar com o custo do cenário)
create or replace function public.producao_cmv_sistema(p_skus text[])
returns table(sku text, cmv_hoje numeric, origem text, manual_desde date, manual_custo numeric, custo_cadastro numeric, kits_que_usam integer)
language sql stable security invoker set search_path = public as $$
  with h as (select (now() at time zone 'America/Sao_Paulo')::date as d)
  select s.sku,
         public.cmv_na_data(s.sku, h.d),
         case when m.custo is not null then 'manual' when pr.tipo = 'K' then 'kit' else 'cadastro' end,
         m.vigente_desde, m.custo, nullif(pr.custo, 0),
         (select count(*)::int from public.produto_kits pk where pk.sku_componente = s.sku)
  from unnest(p_skus) as s(sku)
  cross join h
  left join public.produtos pr on pr.sku = s.sku
  left join lateral (
    select cm.custo, cm.vigente_desde from public.cmv_manual cm
    where cm.sku = s.sku and cm.vigente_desde <= h.d order by cm.vigente_desde desc limit 1
  ) m on true;
$$;
revoke all on function public.producao_cmv_sistema(text[]) from public, anon;
grant execute on function public.producao_cmv_sistema(text[]) to authenticated, service_role;

-- 2) lançar: grava o manual desde p_desde e recongela os pedidos de p_desde até hoje
create or replace function public.producao_lancar_custo(p_sku text, p_custo numeric, p_desde date default null, p_obs text default null)
returns table(pares integer, pedidos integer, sem_custo integer, custo_manual_gravado boolean)
language plpgsql security invoker set search_path = public as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_desde date := coalesce(p_desde, (now() at time zone 'America/Sao_Paulo')::date);
  v_quem text;
begin
  if not public.tem_modulo('custos') then raise exception 'sem acesso a Custos e Preços'; end if;
  if p_custo is null or p_custo <= 0 then raise exception 'custo deve ser maior que zero'; end if;
  if v_desde > v_hoje then raise exception 'a data não pode ser no futuro'; end if;
  if v_desde < v_hoje - 400 then raise exception 'data muito antiga'; end if;
  select coalesce(pu.nome, auth.jwt() ->> 'email') into v_quem from public.perfis_usuario pu where pu.user_id = auth.uid();
  return query select * from public.reprocessar_cmv_periodo(p_sku, v_desde, v_hoje, round(p_custo, 4), coalesce(v_quem, 'custos'),
    coalesce(p_obs, 'custo da produção (Custos e Preços)'));
end $$;
revoke all on function public.producao_lancar_custo(text, numeric, date, text) from public, anon;
grant execute on function public.producao_lancar_custo(text, numeric, date, text) to authenticated, service_role;

-- 3) promoções: o CMV passa a ser o de hoje pela regra do sistema (manual vigente > cadastro; kit pelos componentes)
--    (só o trecho do "cmv" mudou nas duas funções; o resto idêntico)
-- promo_mc_base: ... select a.sku, public.cmv_na_data(a.sku, (now() at time zone 'America/Sao_Paulo')::date) as cmv, ...
-- flashsale_mc_base: idem (aplicado pela migração com o corpo inteiro)

-- ---------------------------------------------------------------------------- ROLLBACK
-- drop function public.producao_lancar_custo(text, numeric, date, text);
-- drop function public.producao_cmv_sistema(text[]);
-- promo_mc_base / flashsale_mc_base: voltar o "cmv" para
--   (select case when p.tipo = 'K' then (select sum(pk.quantidade * pf.custo) from produto_kits pk join produtos pf
--      on pf.sku = pk.sku_componente where pk.sku_kit = p.sku) else p.custo end from produtos p where p.sku = a.sku)
-- O que já foi lançado fica em cmv_manual (apagar a linha + reprocessar_cmv_periodo sem custo desfaz).
