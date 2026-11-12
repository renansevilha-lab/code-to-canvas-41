-- =====================================================================================================
-- Varredura HISTÓRICA de devoluções (12/nov/2026, opção A do dono: tudo que o Tiny dá —
-- SVL desde jan/2025, Ottz desde jul/2025). Migração `devolucoes_varredura_historica`.
--
-- Objetivo: inventário, só LEITURA no Tiny, de pedidos cancelados × NF de venda autorizada × NF de
-- devolução já existente, por conta e por mês — base para decidir/criar as devoluções que faltam.
-- Quem preenche: `devolucao-auto?modulo=varrer-historico&conta=svl|ottz` (crons 173/174), janela a
-- janela (estado em `devolucao_hist_estado`; janela que o Tiny recusa por "consulta levou muito tempo"
-- é dividida em dias). A listagem `/notas` do Tiny já traz `origem.id` (= pedido), chave e situação:
-- não precisa consultar pedido a pedido.
-- =====================================================================================================

create table if not exists public.devolucao_hist_estado (
  conta        text not null,
  tipo         text not null check (tipo in ('pedidos','notas_s','notas_e')),
  janela_de    date not null,
  janela_ate   date not null,
  total_api    int,
  lidos        int not null default 0,
  paginas      int not null default 0,
  concluido_em timestamptz,
  erro         text,
  tentativas   int not null default 0,
  atualizado_em timestamptz,
  primary key (conta, tipo, janela_de)
);

create table if not exists public.devolucao_hist_pedidos (
  conta            text not null,
  tiny_pedido_id   bigint not null,
  numero_pedido    int,
  numero_ecommerce text,
  canal            text,
  data_pedido      date,
  valor            numeric,
  cliente_nome     text,
  situacao         int,
  visto_em         timestamptz not null default now(),
  primary key (conta, tiny_pedido_id)
);
create index if not exists devolucao_hist_pedidos_ecom on public.devolucao_hist_pedidos (numero_ecommerce);

create table if not exists public.devolucao_hist_notas (
  conta            text not null,
  id_nota          bigint not null,
  tipo             text not null,          -- S venda · E devolução (só séries 12/13)
  serie            text,
  numero           text,
  chave            text,
  situacao         text,
  data_emissao     date,
  valor            numeric,
  cpf_cnpj         text,                   -- só dígitos
  cliente_nome     text,
  origem_pedido_id bigint,                 -- origem.id da listagem (pedido no Tiny)
  origem_tipo      text,
  numero_ecommerce text,
  canal            text,
  itens            jsonb,
  visto_em         timestamptz not null default now(),
  primary key (conta, id_nota)
);
create index if not exists devolucao_hist_notas_origem on public.devolucao_hist_notas (conta, origem_pedido_id);
create index if not exists devolucao_hist_notas_chave  on public.devolucao_hist_notas (chave);
create index if not exists devolucao_hist_notas_cpf    on public.devolucao_hist_notas (conta, tipo, cpf_cnpj);
create index if not exists devolucao_hist_notas_ecom   on public.devolucao_hist_notas (numero_ecommerce);

revoke all on public.devolucao_hist_estado, public.devolucao_hist_pedidos, public.devolucao_hist_notas from anon;
grant select on public.devolucao_hist_estado, public.devolucao_hist_pedidos, public.devolucao_hist_notas to authenticated;
grant all on public.devolucao_hist_estado, public.devolucao_hist_pedidos, public.devolucao_hist_notas to service_role;

-- Janelas (o que o Tiny devolve, medido em 11/nov: SVL pedidos desde 29/10/2024 e notas desde jan/2025;
-- Ottz pedidos desde 20/02/2025 e notas desde 30/06/2025). Ottz notas de saída = ~335/dia → janela de 2 dias
-- (7 dias estoura o tempo da consulta); SVL ~50/dia → 7 dias.
create or replace function public.devolucao_hist_semear(p_conta text, p_tipo text, p_de date, p_ate date, p_passo int)
returns int language plpgsql as $$
declare d date := p_de; n int := 0;
begin
  while d <= p_ate loop
    insert into public.devolucao_hist_estado (conta, tipo, janela_de, janela_ate)
    values (p_conta, p_tipo, d, least(d + (p_passo - 1), p_ate))
    on conflict do nothing;
    n := n + 1; d := d + p_passo;
  end loop;
  return n;
end $$;
revoke all on function public.devolucao_hist_semear(text,text,date,date,int) from public, anon, authenticated;

select public.devolucao_hist_semear('svl',  'pedidos', '2024-10-29', '2026-11-11', 7);
select public.devolucao_hist_semear('svl',  'notas_s', '2025-01-01', '2026-11-11', 7);
select public.devolucao_hist_semear('svl',  'notas_e', '2025-01-01', '2026-11-11', 14);
select public.devolucao_hist_semear('ottz', 'pedidos', '2025-02-20', '2026-11-11', 7);
select public.devolucao_hist_semear('ottz', 'notas_s', '2025-06-30', '2026-11-11', 2);
select public.devolucao_hist_semear('ottz', 'notas_e', '2025-06-30', '2026-11-11', 7);

-- Candidatos: NF de venda AUTORIZADA cujo pedido está cancelado (na mesma conta, na outra conta — cópia
-- fiscal da Bumi — ou no espelho dos marketplaces), e o que já existe de devolução para ela.
create or replace view public.view_devolucao_hist_candidatos with (security_invoker = true) as
with s as (
  select n.* from public.devolucao_hist_notas n where n.tipo = 'S' and n.situacao in ('6','7')
),
c as (
  select s.*,
    exists (select 1 from public.devolucao_hist_pedidos p where p.conta = s.conta and p.tiny_pedido_id = s.origem_pedido_id) as canc_conta,
    exists (select 1 from public.devolucao_hist_pedidos p where p.conta <> s.conta and s.numero_ecommerce <> '' and p.numero_ecommerce = s.numero_ecommerce) as canc_outra_conta,
    exists (select 1 from public.pedidos pd where pd.id = s.numero_ecommerce and pd.status_pedido ilike 'cancel%') as canc_marketplace
  from s
  where s.numero_ecommerce is not null
),
k as (
  select c.* from c where c.canc_conta or c.canc_outra_conta or c.canc_marketplace
)
select
  k.conta, date_trunc('month', k.data_emissao)::date as mes, k.canal, k.id_nota, k.numero, k.serie, k.chave,
  k.data_emissao, k.valor, k.cpf_cnpj, k.cliente_nome, k.origem_pedido_id, k.numero_ecommerce, k.itens,
  k.canc_conta, k.canc_outra_conta, k.canc_marketplace,
  dv.numero as devolucao_numero, dv.situacao as devolucao_situacao, dv.data_emissao as devolucao_data,
  case
    when dv.id_nota is not null then 'exata'
    when exists (select 1 from public.devolucoes_svl_base b where b.chave_referenciada = k.chave)
      or exists (select 1 from public.notas_cancelados nc where nc.chave_nfe = k.chave and nc.id_nota_devolucao is not null)
      or exists (select 1 from public.devolucao_auto a where a.chave_venda = k.chave and a.estado in ('criada','ja_existe'))
      or exists (select 1 from public.devolucao_clonadas cl where cl.refnfe = k.chave) then 'chave'
    when exists (select 1 from public.devolucao_hist_notas e where e.conta = k.conta and e.tipo = 'E' and e.cpf_cnpj = k.cpf_cnpj
                   and e.data_emissao >= k.data_emissao and e.valor < k.valor) then 'parcial_possivel'
    else 'nenhuma'
  end as devolucao
from k
left join lateral (
  select e.id_nota, e.numero, e.situacao, e.data_emissao
  from public.devolucao_hist_notas e
  where e.conta = k.conta and e.tipo = 'E' and e.cpf_cnpj = k.cpf_cnpj and e.valor = k.valor and e.data_emissao >= k.data_emissao
  order by e.data_emissao limit 1
) dv on true;
revoke all on public.view_devolucao_hist_candidatos from anon;
grant select on public.view_devolucao_hist_candidatos to authenticated, service_role;

-- Rollback:
-- drop view if exists public.view_devolucao_hist_candidatos;
-- drop function if exists public.devolucao_hist_semear(text,text,date,date,int);
-- drop table if exists public.devolucao_hist_notas, public.devolucao_hist_pedidos, public.devolucao_hist_estado;
