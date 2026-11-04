-- Produção — ORDEM DE PRODUÇÃO (04/nov/2026, pedido do dono): o dono estipula o que produzir (produto, quantidade,
-- prazo, prioridade, observações) e a equipe recebe o aviso no Discord. Os lotes abertos a partir da ordem ficam
-- ligados a ela (producao_ordem.op_id) e a ordem mostra o produzido (sacos bons dos lotes encerrados) × o pedido.
-- Atenção ao nome: producao_ordem é o LOTE (histórico do MVP); a ordem de produção é producao_op.

begin;

create table if not exists public.producao_op (
  id bigserial primary key,
  sku text not null,
  qtd integer not null check (qtd > 0),
  prazo date,
  prioridade text not null default 'normal' check (prioridade in ('normal', 'urgente')),
  obs text,
  status text not null default 'aberta' check (status in ('aberta', 'concluida', 'cancelada')),
  criado_por text,
  criado_em timestamptz not null default now(),
  fechada_em timestamptz,
  fechada_por text,
  motivo text
);
create index if not exists producao_op_status on public.producao_op (status, criado_em desc);

alter table public.producao_ordem add column if not exists op_id bigint references public.producao_op (id);
create index if not exists producao_ordem_op on public.producao_ordem (op_id) where op_id is not null;

alter table public.producao_op enable row level security;
revoke all on public.producao_op from anon, public;
grant select, insert, update on public.producao_op to authenticated;
grant usage on sequence public.producao_op_id_seq to authenticated;
create policy ler on public.producao_op for select to authenticated using (tem_modulo('galpao'));
create policy criar on public.producao_op for insert to authenticated with check (tem_modulo('galpao'));
create policy alterar on public.producao_op for update to authenticated using (tem_modulo('galpao')) with check (tem_modulo('galpao'));

-- situação: cancelada/concluida (gravadas) · em_producao (tem lote aberto) · atingida (produzido >= pedido) · aberta
create or replace view public.view_producao_op with (security_invoker = true) as
select o.id, o.sku, pr.nome as produto, o.qtd, o.prazo, o.prioridade, o.obs, o.status, o.criado_por, o.criado_em,
  o.fechada_em, o.fechada_por, o.motivo,
  coalesce(l.produzido, 0)::int as produzido,
  greatest(o.qtd - coalesce(l.produzido, 0), 0)::int as falta,
  coalesce(l.envasando, 0)::int as envasando,
  coalesce(l.lotes, 0)::int as lotes,
  l.lote_aberto_id,
  case when o.status <> 'aberta' then o.status
       when l.lote_aberto_id is not null then 'em_producao'
       when coalesce(l.produzido, 0) >= o.qtd then 'atingida'
       else 'aberta' end as situacao,
  (o.status = 'aberta' and o.prazo is not null and o.prazo < (now() at time zone 'America/Sao_Paulo')::date) as atrasada
from producao_op o
left join produtos pr on pr.sku = o.sku
left join lateral (
  select sum(v.boas) filter (where v.status = 'encerrada') as produzido,
         sum(v.envasados) filter (where v.status = 'aberta') as envasando,
         count(*) filter (where v.status <> 'cancelada') as lotes,
         max(v.id) filter (where v.status = 'aberta') as lote_aberto_id
    from producao_ordem po join view_producao_lote v on v.id = po.id
   where po.op_id = o.id
) l on true;

revoke all on public.view_producao_op from anon, public;
grant select on public.view_producao_op to authenticated, service_role;

commit;

-- ROLLBACK:
-- drop view public.view_producao_op;
-- alter table public.producao_ordem drop column op_id;
-- drop table public.producao_op;
