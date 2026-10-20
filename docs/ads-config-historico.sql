-- ============================================================================
-- Histórico de configuração das campanhas de ADS (20/out/2026, opção A do dono)
-- Nenhum marketplace dá histórico de alterações pela API (Shopee: 25 APIs de ADS, nenhuma de log;
-- Mercado Livre: só a configuração atual). Então NÓS fotografamos a configuração e guardamos o que mudou:
--   Shopee  → edge fn shopee-ads-gestao (slot shopee-flashsale-probe) ?modulo=capturar, cron a cada 2 h
--   ML      → gatilho em ml_ads_campanha (o ml-sync-ads regrava as campanhas a cada 6 h)
--   App     → shopee-ads-gestao ?modulo=editar registra com origem 'app' e o nome de quem alterou
-- A mudança aconteceu ENTRE `desde` (última vez visto com o valor antigo) e `ate` (quando vimos o novo).
-- ============================================================================

create table if not exists public.ads_config_atual (
  mkt text not null,                 -- shopee | ml
  shop_id bigint not null,
  campaign_id text not null,
  nome text, item_id text, ad_type text,
  bidding_method text,               -- Shopee: auto|manual (lance); ML: strategy (PROFITABILITY…)
  status text,
  budget numeric,                    -- Shopee: 0 = sem limite
  roas_target numeric,
  primeira_vez timestamptz not null default now(),
  visto_em timestamptz not null default now(),
  primary key (mkt, shop_id, campaign_id)
);

create table if not exists public.ads_config_historico (
  id bigserial primary key,
  mkt text not null,
  shop_id bigint not null,
  campaign_id text not null,
  nome text,
  campo text not null,               -- roas_target | budget | status | bidding_method
  de text, para text,
  desde timestamptz,                 -- última vez visto com o valor antigo
  ate timestamptz not null default now(),
  origem text not null default 'externo',   -- externo (painel do marketplace / automático) | app
  quem text,
  criado_em timestamptz not null default now()
);
create index if not exists ads_config_historico_camp on public.ads_config_historico (mkt, shop_id, campaign_id, ate desc);

alter table public.ads_config_atual enable row level security;
alter table public.ads_config_historico enable row level security;
revoke all on public.ads_config_atual, public.ads_config_historico from anon;
grant select on public.ads_config_atual, public.ads_config_historico to authenticated;
drop policy if exists ads_config_atual_ler on public.ads_config_atual;
create policy ads_config_atual_ler on public.ads_config_atual for select to authenticated using (true);
drop policy if exists ads_config_historico_ler on public.ads_config_historico;
create policy ads_config_historico_ler on public.ads_config_historico for select to authenticated using (true);

-- Recebe a configuração atual de várias campanhas e grava o que mudou.
-- p_lista = [{campaign_id, nome, item_id, ad_type, bidding_method, status, budget, roas_target}]
-- Campo ausente no objeto = não é comparado (ex.: ML não manda item_id).
create or replace function public.ads_config_registrar(
  p_mkt text, p_shop bigint, p_lista jsonb, p_origem text default 'externo', p_quem text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; a public.ads_config_atual%rowtype; agora timestamptz := now();
  n_novas int := 0; n_mud int := 0; c text; v_de text; v_para text; mudou boolean;
begin
  for r in select * from jsonb_array_elements(coalesce(p_lista, '[]'::jsonb)) loop
    continue when coalesce(r->>'campaign_id', '') = '';
    select * into a from public.ads_config_atual where mkt = p_mkt and shop_id = p_shop and campaign_id = r->>'campaign_id';
    if not found then
      insert into public.ads_config_atual (mkt, shop_id, campaign_id, nome, item_id, ad_type, bidding_method, status, budget, roas_target, primeira_vez, visto_em)
      values (p_mkt, p_shop, r->>'campaign_id', r->>'nome', r->>'item_id', r->>'ad_type', r->>'bidding_method', r->>'status',
              nullif(r->>'budget', '')::numeric, nullif(r->>'roas_target', '')::numeric, agora, agora);
      n_novas := n_novas + 1;
      continue;
    end if;
    foreach c in array array['roas_target', 'budget', 'status', 'bidding_method'] loop
      continue when not (r ? c);
      v_para := r->>c;
      v_de := case c when 'roas_target' then a.roas_target::text when 'budget' then a.budget::text
                     when 'status' then a.status else a.bidding_method end;
      mudou := case when c in ('roas_target', 'budget')
                    then nullif(v_de, '')::numeric is distinct from nullif(v_para, '')::numeric
                    else v_de is distinct from v_para end;
      if mudou then
        insert into public.ads_config_historico (mkt, shop_id, campaign_id, nome, campo, de, para, desde, ate, origem, quem)
        values (p_mkt, p_shop, a.campaign_id, coalesce(r->>'nome', a.nome), c, v_de, v_para, a.visto_em, agora, coalesce(p_origem, 'externo'), p_quem);
        n_mud := n_mud + 1;
      end if;
    end loop;
    update public.ads_config_atual set
      nome = coalesce(r->>'nome', nome), item_id = coalesce(r->>'item_id', item_id), ad_type = coalesce(r->>'ad_type', ad_type),
      bidding_method = case when r ? 'bidding_method' then r->>'bidding_method' else bidding_method end,
      status = case when r ? 'status' then r->>'status' else status end,
      budget = case when r ? 'budget' then nullif(r->>'budget', '')::numeric else budget end,
      roas_target = case when r ? 'roas_target' then nullif(r->>'roas_target', '')::numeric else roas_target end,
      visto_em = agora
    where mkt = p_mkt and shop_id = p_shop and campaign_id = a.campaign_id;
  end loop;
  return jsonb_build_object('novas', n_novas, 'mudancas', n_mud);
end $$;
revoke all on function public.ads_config_registrar(text, bigint, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.ads_config_registrar(text, bigint, jsonb, text, text) to service_role;

-- Mercado Livre: o ml-sync-ads (cron 64, a cada 6 h) regrava ml_ads_campanha → o gatilho registra mudanças.
-- ADS do ML é só a conta Ottz (user 1107117809).
create or replace function public.trg_ml_ads_campanha_historico()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.ads_config_registrar('ml', 1107117809, jsonb_build_array(jsonb_build_object(
    'campaign_id', new.campaign_id::text, 'nome', new.nome, 'status', new.status,
    'bidding_method', new.strategy, 'budget', new.budget, 'roas_target', new.roas_target)), 'externo', null);
  return new;
exception when others then
  return new;   -- histórico nunca pode derrubar o sync
end $$;
drop trigger if exists ml_ads_campanha_historico on public.ml_ads_campanha;
create trigger ml_ads_campanha_historico after insert or update on public.ml_ads_campanha
  for each row execute function public.trg_ml_ads_campanha_historico();

-- ponto de partida do ML: a configuração de hoje
select public.ads_config_registrar('ml', 1107117809, coalesce((
  select jsonb_agg(jsonb_build_object('campaign_id', campaign_id::text, 'nome', nome, 'status', status,
         'bidding_method', strategy, 'budget', budget, 'roas_target', roas_target))
  from public.ml_ads_campanha), '[]'::jsonb), 'externo', null);
