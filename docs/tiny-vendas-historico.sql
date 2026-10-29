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
