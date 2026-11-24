-- ============================================================================
-- Histórico de vendas pelo Tiny — só os TOTAIS (29/out/2026, pedido do dono)
-- ----------------------------------------------------------------------------
-- O app só tem pedido a pedido a partir de fev/2026 (espelho pedidos_tiny, conta
-- ottz) e dos marketplaces integrados a partir de mar–mai/2026. O Tiny guarda mais:
-- a conta SVL devolve pedidos a partir de 29/10/2024 (limite do plano, janela de
-- 2 anos que ANDA todo dia) e a conta Ottz começa entre nov/2024 e fev/2025.
--
-- A edge fn `tiny-vendas-historico` lê a LISTAGEM do Tiny (GET /pedidos, 100 por
-- página: valor, situação, canal, data — sem abrir pedido) dia a dia e grava só a
-- soma por conta × dia × canal × situação. Nada de cliente nem de pedido.
--
-- Armadilha (conferida em 29/out): desde jun/2026 a conta SVL do Tiny recebe uma
-- CÓPIA FISCAL dos pedidos da Bumi que já estão na conta Ottz (160 de 166 em
-- 20/out casam por cliente + valor), sempre SEM canal. A view tira da conta SVL o
-- que vem sem canal; antes disso a SVL tinha as lojas dela com canal (Sevilla
-- Store, ML_JUSSARA…, Amazon [SVLL Store]).
--
-- Rollback:
--   drop view if exists view_vendas_tiny_mensal;
--   drop table if exists tiny_vendas_dia, tiny_vendas_dia_estado;
-- ============================================================================

create table if not exists public.tiny_vendas_dia (
  conta text not null check (conta in ('ottz', 'svl')),
  dia date not null,
  canal text not null default '',          -- ecommerce.nome da listagem ('' = sem canal)
  situacao smallint not null,              -- enum v3 do Tiny (2 = cancelada)
  pedidos integer not null,
  valor numeric(14, 2) not null default 0,
  sem_valor integer not null default 0,    -- pedidos que vieram com valor vazio
  atualizado_em timestamptz not null default now(),
  primary key (conta, dia, canal, situacao)
);

create table if not exists public.tiny_vendas_dia_estado (
  conta text not null,
  dia date not null,
  total_api integer,                       -- paginacao.total que o Tiny informou
  lidos integer,                           -- pedidos efetivamente somados
  concluido_em timestamptz,
  fora_do_plano boolean not null default false,
  erro text,
  tentativas integer not null default 0,
  primary key (conta, dia)
);

alter table public.tiny_vendas_dia enable row level security;
alter table public.tiny_vendas_dia_estado enable row level security;
create policy tiny_vendas_dia_ler on public.tiny_vendas_dia for select to authenticated using (true);
create policy tiny_vendas_dia_estado_ler on public.tiny_vendas_dia_estado for select to authenticated using (true);
revoke all on public.tiny_vendas_dia, public.tiny_vendas_dia_estado from anon;
grant select on public.tiny_vendas_dia, public.tiny_vendas_dia_estado to authenticated;

-- Marketplace e empresa pelo NOME do canal (o mesmo nome dura o histórico todo).
create or replace view public.view_vendas_tiny_mensal
with (security_invoker = true) as
with base as (
  select v.*,
    case
      when v.canal ~* 'shopee|sevilla store' then 'shopee'
      when v.canal ~* 'mercado ?livre|^ml_' then 'mercadolivre'
      when v.canal ~* 'amazon' then 'amazon'
      when v.canal ~* 'tiktok' then 'tiktok'
      when v.canal ~* 'temu|olist' then 'temu'
      when v.canal ~* 'shein' then 'shein'
      when v.canal = '' then 'sem_canal'
      else 'outros'
    end as marketplace,
    case when v.conta = 'svl' or v.canal ~* 'bumi|sevilla|svl' then 'SVL Store' else 'ACZ Pet' end as empresa
  from public.tiny_vendas_dia v
  where not (v.conta = 'svl' and v.canal = '')   -- cópia fiscal da Bumi (ver cabeçalho)
)
select date_trunc('month', dia)::date as mes, empresa, marketplace, canal,
  coalesce(sum(pedidos) filter (where situacao <> 2), 0)::int as pedidos,
  coalesce(sum(valor) filter (where situacao <> 2), 0) as valor,
  coalesce(sum(pedidos) filter (where situacao = 2), 0)::int as pedidos_cancelados,
  coalesce(sum(valor) filter (where situacao = 2), 0) as valor_cancelado,
  count(distinct dia)::int as dias_com_venda
from base
group by 1, 2, 3, 4;

revoke all on public.view_vendas_tiny_mensal from anon;
grant select on public.view_vendas_tiny_mensal to authenticated;

-- ============================================================================
-- 23–24/nov/2026 — histórico mais antigo (pedido do dono, opção A)
-- ----------------------------------------------------------------------------
-- 1. O Tiny voltou a devolver datas que em 29/out recusava ("fora do período permitido pelo plano").
--    tiny-vendas-historico v2: início POR CONTA — SVL 2022-06-01 (1º pedido 26/06/2022; 0 de 2019 a 2021),
--    Ottz 2025-01-01 (0 em 2024 e antes: a conta não existe neste Tiny). As marcas fora_do_plano foram
--    apagadas (delete from tiny_vendas_dia_estado where fora_do_plano) e os crons 170/171 leram tudo.
-- 2. Antes de 2025 a Ottz vem direto da SHOPEE (loja 522186766): edge fn shopee-vendas-historico →
--    shopee_vendas_dia (shop_id, dia, status, pedidos, valor = total_amount, valor_itens = produtos) e
--    shopee_vendas_dia_estado. Conferido em 12–31/01/2025 contra o Tiny: pedidos e cancelados idênticos
--    todo dia; valor_itens 0,1–1,5% acima do Tiny; total_amount (com frete) 7–15% acima → a view usa valor_itens.
--    A loja SVL/Bumi não entra: já está no Tiny da SVL (25/11/2024: 99 na Shopee = 99 no Tiny).
--    Carga única: cron `shopee-vendas-historico` ('2-28/2,32-58/2 * * * *') chama shopee_vendas_hist_tick(),
--    que se desagenda quando 2020-01-01..2025-01-31 estiver lido (jan/2025 fica só para conferência).
-- 3. view_vendas_tiny_mensal = Tiny (duas contas) + Shopee Ottz com dia < 2025-01-01 (canal
--    'Shopee (Ottz Pet) · direto da Shopee'). view_vendas_hist_estado = andamento das duas leituras.
-- 4. Mercado Livre: a API só devolve os últimos 12 meses (/orders/search e /archived = 0 antes disso).
--    Antes de 2025 a Ottz fica SEM Mercado Livre no histórico.
-- Migrações: shopee_vendas_historico, shopee_vendas_historico_valor_itens, shopee_vendas_historico_view_valor_itens.
-- Rollback: select cron.unschedule('shopee-vendas-historico'); drop function shopee_vendas_hist_tick();
--   drop view view_vendas_hist_estado; recriar view_vendas_tiny_mensal como acima (sem o union);
--   drop table shopee_vendas_dia, shopee_vendas_dia_estado.
