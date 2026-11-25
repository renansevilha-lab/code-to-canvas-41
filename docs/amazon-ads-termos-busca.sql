-- ============================================================================
-- Amazon Ads — termos de busca (25/nov/2026, opção C do dono)
-- Relatório spSearchTerm (Sponsored Products) por dia: qual BUSCA do comprador
-- trouxe clique, gasto e venda, em cada palavra-chave/alvo de cada campanha.
-- Gravado pela amazon-ads-sync v4 (pedir &produtos=SP,SP_TERMO; coletar).
-- Migração: amazon_ads_termos_busca
-- ============================================================================

create table if not exists public.amazon_ads_termo_diario (
  chave        text primary key,          -- md5(data|conta|campanha|grupo|palavra/alvo|termo)
  data         date not null,
  conta        text not null,
  shop_id      bigint,
  campaign_id  text not null,
  campanha     text,
  ad_group_id  text,
  grupo        text,
  keyword_id   text,
  alvo         text,                      -- palavra-chave (keyword) ou expressão do alvo (targeting)
  match_type   text,                      -- EXACT | PHRASE | BROAD | TARGETING_EXPRESSION | …
  termo        text not null,             -- o que o comprador digitou (ou ASIN, em alvo de produto)
  impressoes   bigint not null default 0,
  cliques      bigint not null default 0,
  gasto        numeric(12,2) not null default 0,
  vendas       numeric(12,2) not null default 0,   -- vendas atribuídas em 7 dias
  pedidos      integer not null default 0,
  unidades     integer not null default 0,
  atualizado_em timestamptz not null default now()
);
create index if not exists amazon_ads_termo_diario_data on public.amazon_ads_termo_diario (data);
create index if not exists amazon_ads_termo_diario_camp on public.amazon_ads_termo_diario (campaign_id, data);
create index if not exists amazon_ads_termo_diario_termo on public.amazon_ads_termo_diario (termo);

alter table public.amazon_ads_termo_diario enable row level security;
drop policy if exists app_ler on public.amazon_ads_termo_diario;
create policy app_ler on public.amazon_ads_termo_diario for select to authenticated using (true);
revoke all on public.amazon_ads_termo_diario from anon, authenticated;
grant select on public.amazon_ads_termo_diario to authenticated;
grant all on public.amazon_ads_termo_diario to service_role;

-- Resumo por termo (soma de absolutos; ROAS/ACOS recalculados)
create or replace view public.view_amazon_ads_termos
with (security_invoker = true) as
select conta, campaign_id, max(campanha) campanha, termo, max(match_type) match_type, max(alvo) alvo,
       min(data) desde, max(data) ate,
       sum(impressoes) impressoes, sum(cliques) cliques, sum(gasto) gasto, sum(vendas) vendas,
       sum(pedidos) pedidos, sum(unidades) unidades,
       round(sum(vendas) / nullif(sum(gasto), 0), 2) roas,
       round(100 * sum(gasto) / nullif(sum(vendas), 0), 1) acos,
       round(sum(gasto) / nullif(sum(cliques), 0), 2) cpc,
       round(100.0 * sum(pedidos) / nullif(sum(cliques), 0), 1) conversao
from public.amazon_ads_termo_diario
group by conta, campaign_id, termo;
revoke all on public.view_amazon_ads_termos from anon;
grant select on public.view_amazon_ads_termos to authenticated, service_role;

-- Rollback:
-- drop view if exists public.view_amazon_ads_termos;
-- drop table if exists public.amazon_ads_termo_diario;
