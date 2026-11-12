-- Produção — acompanhamento do bônus da equipe (12/nov/2026, pedido do dono)
-- Regra (a mesma do PDF da 1ª leva e da folha de controle): cada lote ENCERRADO paga
--   R$/saco × sacos bons, dividido igualmente entre quem trabalhou no lote (pessoas distintas em producao_etapa).
--   R$/saco = producao_op.bonus_saco da ordem do lote, se houver; senão producao_parametros.pagamento_saco do produto.
-- Pagamento: o dono marca o que pagou; cada (lote, pessoa) só pode ser pago uma vez (PK em producao_bonus_pago_lote)
-- e o valor fica CONGELADO no pagamento (mudar o R$/saco da ficha depois não muda o que já foi pago).
-- Acesso: por enquanto só o módulo 'todos' (o dono). Para cada pessoa ver só a própria tela: ligar
-- equipe_membros.user_id ao login e trocar a checagem em producao_bonus_acesso().

create table if not exists public.producao_bonus_pagamento (
  id bigserial primary key,
  pessoa_id text not null references public.equipe_membros(id),
  valor numeric(12,2) not null,
  pago_em date not null,
  obs text,
  criado_em timestamptz not null default now(),
  criado_por text
);
create table if not exists public.producao_bonus_pago_lote (
  pagamento_id bigint not null references public.producao_bonus_pagamento(id) on delete cascade,
  ordem_id bigint not null references public.producao_ordem(id),
  pessoa_id text not null references public.equipe_membros(id),
  sacos numeric(12,2) not null,      -- parte da pessoa (sacos bons ÷ pessoas)
  valor_saco numeric(10,2) not null,
  valor numeric(12,2) not null,
  primary key (ordem_id, pessoa_id)
);
create index if not exists producao_bonus_pago_lote_pag on public.producao_bonus_pago_lote(pagamento_id);

alter table public.producao_bonus_pagamento enable row level security;
alter table public.producao_bonus_pago_lote enable row level security;
-- sem política para o app: leitura e escrita só pelas funções abaixo
revoke all on public.producao_bonus_pagamento, public.producao_bonus_pago_lote from anon, public, authenticated;
grant all on public.producao_bonus_pagamento, public.producao_bonus_pago_lote to service_role;
revoke all on sequence public.producao_bonus_pagamento_id_seq from anon, public, authenticated;

-- quem pode ver: 'todos' (o dono) vê todo mundo; ninguém mais por enquanto
create or replace function public.producao_bonus_acesso() returns boolean
language sql stable security definer set search_path = public as $$ select tem_modulo('todos') $$;

-- uma linha por (lote encerrado × pessoa)
create or replace function public.producao_bonus_linhas(p_de date, p_ate date)
returns table (ordem_id bigint, codigo text, dia date, sku text, produto text, sacos_lote numeric, n_pessoas int,
               pessoa_id text, pessoa text, sacos numeric, valor_saco numeric, valor numeric,
               pago boolean, pagamento_id bigint, pago_em date)
language sql stable security definer set search_path = public as $$
  with lotes as (
    select l.id, l.codigo, (l.inicio_em at time zone 'America/Sao_Paulo')::date dia, l.sku, l.produto, coalesce(l.boas, 0)::numeric boas,
           coalesce(op.bonus_saco, pp.pagamento_saco, 0)::numeric tarifa
    from view_producao_lote l
    join producao_ordem o on o.id = l.id
    left join producao_op op on op.id = o.op_id
    left join producao_parametros pp on pp.sku = l.sku
    where l.status = 'encerrada'
      and (p_de is null or (l.inicio_em at time zone 'America/Sao_Paulo')::date >= p_de)
      and (p_ate is null or (l.inicio_em at time zone 'America/Sao_Paulo')::date <= p_ate)
  ), gente as (
    select distinct e.ordem_id, e.pessoa_id from producao_etapa e join lotes on lotes.id = e.ordem_id where e.pessoa_id is not null
  ), n as (select ordem_id, count(*)::int n from gente group by 1)
  select lt.id, lt.codigo, lt.dia, lt.sku, lt.produto, lt.boas, n.n, g.pessoa_id, coalesce(m.nome, g.pessoa_id),
         coalesce(pl.sacos, round(lt.boas / n.n, 2)),
         coalesce(pl.valor_saco, lt.tarifa),
         coalesce(pl.valor, round(lt.boas * lt.tarifa / n.n, 2)),
         pl.pagamento_id is not null, pl.pagamento_id, pg.pago_em
  from lotes lt
  join gente g on g.ordem_id = lt.id
  join n on n.ordem_id = lt.id
  left join equipe_membros m on m.id = g.pessoa_id
  left join producao_bonus_pago_lote pl on pl.ordem_id = lt.id and pl.pessoa_id = g.pessoa_id
  left join producao_bonus_pagamento pg on pg.id = pl.pagamento_id
  where producao_bonus_acesso()
$$;

-- a tela: lotes × pessoas, totais por pessoa (a pagar / pago) e os pagamentos registrados
create or replace function public.producao_bonus(p_de date default null, p_ate date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not producao_bonus_acesso() then raise exception 'Sem acesso ao bônus da produção.'; end if;
  with li as (select * from producao_bonus_linhas(p_de, p_ate))
  select jsonb_build_object(
    'de', p_de, 'ate', p_ate,
    'linhas', coalesce((select jsonb_agg(to_jsonb(li) order by li.dia desc, li.codigo, li.pessoa) from li), '[]'),
    'pessoas', coalesce((select jsonb_agg(x order by (x->>'total')::numeric desc) from (
        select jsonb_build_object('pessoa_id', pessoa_id, 'pessoa', max(pessoa), 'lotes', count(*),
          'sacos', sum(sacos), 'total', sum(valor),
          'a_pagar', sum(valor) filter (where not pago), 'pago', coalesce(sum(valor) filter (where pago), 0),
          'lotes_a_pagar', count(*) filter (where not pago)) x
        from li group by pessoa_id) s), '[]'),
    'pagamentos', coalesce((select jsonb_agg(jsonb_build_object('id', pg.id, 'pessoa_id', pg.pessoa_id, 'pessoa', coalesce(m.nome, pg.pessoa_id),
          'valor', pg.valor, 'pago_em', pg.pago_em, 'obs', pg.obs, 'criado_por', pg.criado_por, 'criado_em', pg.criado_em,
          'lotes', (select count(*) from producao_bonus_pago_lote pl where pl.pagamento_id = pg.id)) order by pg.pago_em desc, pg.id desc)
        from producao_bonus_pagamento pg left join equipe_membros m on m.id = pg.pessoa_id
        where (p_de is null or pg.pago_em >= p_de) or exists (select 1 from li where li.pagamento_id = pg.id)), '[]')
  ) into r;
  return r;
end $$;

-- registrar pagamento: lotes ainda não pagos dessa pessoa, com o valor de hoje (congelado)
create or replace function public.producao_bonus_pagar(p_pessoa text, p_ordens bigint[], p_pago_em date, p_obs text default null, p_por text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_total numeric; v_n int;
begin
  if not producao_bonus_acesso() then raise exception 'Sem acesso ao bônus da produção.'; end if;
  if coalesce(array_length(p_ordens, 1), 0) = 0 then raise exception 'Escolha ao menos um lote.'; end if;
  drop table if exists _b;
  create temp table _b on commit drop as
    select * from producao_bonus_linhas(null, null) l where l.pessoa_id = p_pessoa and l.ordem_id = any(p_ordens);
  select count(*), sum(valor) into v_n, v_total from _b;
  if v_n < array_length(p_ordens, 1) then raise exception 'Algum lote não está encerrado ou % não trabalhou nele.', p_pessoa; end if;
  if exists (select 1 from _b where pago) then raise exception 'Algum desses lotes já foi pago para essa pessoa.'; end if;
  insert into producao_bonus_pagamento (pessoa_id, valor, pago_em, obs, criado_por)
    values (p_pessoa, v_total, coalesce(p_pago_em, (now() at time zone 'America/Sao_Paulo')::date), nullif(btrim(p_obs), ''), p_por)
    returning id into v_id;
  insert into producao_bonus_pago_lote (pagamento_id, ordem_id, pessoa_id, sacos, valor_saco, valor)
    select v_id, ordem_id, pessoa_id, sacos, valor_saco, valor from _b;
  return v_id;
end $$;

create or replace function public.producao_bonus_desfazer(p_pagamento bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not producao_bonus_acesso() then raise exception 'Sem acesso ao bônus da produção.'; end if;
  delete from producao_bonus_pagamento where id = p_pagamento;
end $$;

revoke all on function public.producao_bonus_acesso(), public.producao_bonus_linhas(date, date), public.producao_bonus(date, date),
  public.producao_bonus_pagar(text, bigint[], date, text, text), public.producao_bonus_desfazer(bigint) from public, anon;
grant execute on function public.producao_bonus_acesso(), public.producao_bonus(date, date),
  public.producao_bonus_pagar(text, bigint[], date, text, text), public.producao_bonus_desfazer(bigint) to authenticated, service_role;
grant execute on function public.producao_bonus_linhas(date, date) to service_role;

-- Rollback:
-- drop function if exists public.producao_bonus_desfazer(bigint), public.producao_bonus_pagar(text, bigint[], date, text, text),
--   public.producao_bonus(date, date), public.producao_bonus_linhas(date, date), public.producao_bonus_acesso();
-- drop table if exists public.producao_bonus_pago_lote, public.producao_bonus_pagamento;
