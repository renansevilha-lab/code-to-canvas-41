-- Extrato do Mercado Pago no nosso sistema, todo dia (23/nov/2026, pedido do dono).
--
-- Base da conciliação bancária feita NO NOSSO SISTEMA (não pelo Tiny). O relatório é o "Liberações"
-- (release_report) do Mercado Pago: cada lançamento que mexe no saldo disponível, com o saldo depois dele.
--
--   mp_extrato_conta   contas que têm a configuração do relatório criada no Mercado Pago (hoje só a Ottz)
--   mp_extrato_pedido  um pedido de relatório por conta e período (estado: pedido -> gravado | erro)
--   mp_extrato         os lançamentos (uma linha por movimento)
--   view_mp_extrato_dia  resumo por dia (dia de Brasília)
--
-- Quem faz: edge fn `mp-extrato` (`pedir` = pede o dia anterior; `coletar` = baixa e grava quando o arquivo existe).
-- Crons: mp-extrato-pedir (00h20 BRT) e mp-extrato-coletar (minutos 24 e 54; só chama a função se há pedido aberto).
--
-- Rollback:
--   select cron.unschedule('mp-extrato-pedir'); select cron.unschedule('mp-extrato-coletar');
--   drop view public.view_mp_extrato_dia; drop function public.mp_extrato_tick(text);
--   drop function public.mp_extrato_gravar(bigint, jsonb, boolean);
--   drop table public.mp_extrato; drop table public.mp_extrato_pedido; drop table public.mp_extrato_conta;
--   (a configuração do relatório na conta do Mercado Pago continua lá; não atrapalha nada.)

create table public.mp_extrato_conta (
  user_id   bigint primary key,
  apelido   text not null,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);
insert into public.mp_extrato_conta (user_id, apelido) values (1107117809, 'Ottz');

create table public.mp_extrato_pedido (
  id            bigserial primary key,
  conta         bigint not null references public.mp_extrato_conta (user_id),
  de            date not null,            -- primeiro dia (Brasília)
  ate           date not null,            -- último dia (Brasília)
  inicio        timestamptz not null,
  fim           timestamptz not null,
  task_id       text,                     -- id do pedido no Mercado Pago
  status        text not null default 'pedido' check (status in ('pedido', 'gravado', 'erro')),
  status_mp     text,
  arquivo       text,
  pedido_em     timestamptz not null default now(),
  verificado_em timestamptz,
  baixado_em    timestamptz,
  linhas        int,
  saldo_final   numeric(14,2),
  resumo        jsonb,                    -- linhas do arquivo sem data (saldo inicial, totais)
  cabecalho     jsonb,
  erro          text,
  tentativas    int not null default 0,
  avisado_em    timestamptz
);
create index mp_extrato_pedido_abertos on public.mp_extrato_pedido (pedido_em) where status = 'pedido';

create table public.mp_extrato (
  id                  bigserial primary key,
  conta               bigint not null,
  pedido_id           bigint references public.mp_extrato_pedido (id) on delete set null,
  linha               int,
  data                timestamptz not null,   -- momento em que o lançamento mexeu no saldo
  record_type         text,
  descricao           text,                   -- tipo do movimento (payment, refund, payout, shipping…)
  source_id           text,                   -- id do pagamento no Mercado Pago
  external_reference  text,
  order_id            text,
  pack_id             text,
  shipping_id         text,
  credito             numeric(14,2),
  debito              numeric(14,2),
  bruto               numeric(14,2),
  valor_vendedor      numeric(14,2),
  tarifa_mp           numeric(14,2),
  tarifa_parcelamento numeric(14,2),
  frete               numeric(14,2),
  impostos            numeric(14,2),
  cupom               numeric(14,2),
  saldo               numeric(14,2),          -- saldo disponível logo depois do lançamento
  meio_pagamento      text,
  conta_saque         text,
  aprovado_em         timestamptz,
  extras              jsonb                   -- colunas do arquivo que não têm campo próprio
);
create index mp_extrato_conta_data on public.mp_extrato (conta, data);
create index mp_extrato_order on public.mp_extrato (order_id) where order_id is not null;
create index mp_extrato_source on public.mp_extrato (source_id) where source_id is not null;

alter table public.mp_extrato_conta enable row level security;
alter table public.mp_extrato_pedido enable row level security;
alter table public.mp_extrato enable row level security;
create policy mp_extrato_conta_ler on public.mp_extrato_conta for select to authenticated using (public.tem_modulo('financeiro'));
create policy mp_extrato_pedido_ler on public.mp_extrato_pedido for select to authenticated using (public.tem_modulo('financeiro'));
create policy mp_extrato_ler on public.mp_extrato for select to authenticated using (public.tem_modulo('financeiro'));
revoke all on public.mp_extrato_conta, public.mp_extrato_pedido, public.mp_extrato from anon, authenticated;
grant select on public.mp_extrato_conta, public.mp_extrato_pedido, public.mp_extrato to authenticated;

create view public.view_mp_extrato_dia with (security_invoker = true) as
select conta,
       (data at time zone 'America/Sao_Paulo')::date as dia,
       count(*) filter (where record_type = 'release') as lancamentos,
       -- a 1a linha do arquivo (initial_available_balance) é o saldo de abertura, não um crédito
       (array_agg(saldo order by data, linha) filter (where record_type = 'initial_available_balance'))[1] as saldo_inicial,
       coalesce(sum(credito) filter (where record_type = 'release'), 0) as creditos,
       coalesce(sum(debito) filter (where record_type = 'release'), 0) as debitos,
       coalesce(sum(tarifa_mp) filter (where record_type = 'release'), 0) as tarifas_mp,
       coalesce(sum(frete) filter (where record_type = 'release'), 0) as frete,
       (array_agg(saldo order by data desc, linha desc) filter (where saldo is not null))[1] as saldo_final,
       max(data) as ultimo_lancamento
  from public.mp_extrato
 group by 1, 2;
revoke all on public.view_mp_extrato_dia from anon, authenticated;
grant select on public.view_mp_extrato_dia to authenticated;

-- Grava um pedaço do arquivo. No primeiro pedaço apaga o que já havia do mesmo período (reprocessar não duplica).
create or replace function public.mp_extrato_gravar(p_pedido bigint, p_linhas jsonb, p_primeiro boolean)
returns int language plpgsql set search_path = public as $fn$
declare v public.mp_extrato_pedido; v_n int;
begin
  select * into v from mp_extrato_pedido where id = p_pedido;
  if not found then raise exception 'pedido % não existe', p_pedido; end if;
  if p_primeiro then
    delete from mp_extrato where conta = v.conta and ((data >= v.inicio and data <= v.fim) or pedido_id = p_pedido);
  end if;
  insert into mp_extrato (conta, pedido_id, linha, data, record_type, descricao, source_id, external_reference, order_id, pack_id, shipping_id,
                          credito, debito, bruto, valor_vendedor, tarifa_mp, tarifa_parcelamento, frete, impostos, cupom, saldo,
                          meio_pagamento, conta_saque, aprovado_em, extras)
  select v.conta, p_pedido, (x ->> 'linha')::int, (x ->> 'data')::timestamptz, nullif(x ->> 'record_type', ''), nullif(x ->> 'descricao', ''),
         nullif(x ->> 'source_id', ''), nullif(x ->> 'external_reference', ''), nullif(x ->> 'order_id', ''), nullif(x ->> 'pack_id', ''), nullif(x ->> 'shipping_id', ''),
         (x ->> 'credito')::numeric, (x ->> 'debito')::numeric, (x ->> 'bruto')::numeric, (x ->> 'valor_vendedor')::numeric, (x ->> 'tarifa_mp')::numeric,
         (x ->> 'tarifa_parcelamento')::numeric, (x ->> 'frete')::numeric, (x ->> 'impostos')::numeric, (x ->> 'cupom')::numeric, (x ->> 'saldo')::numeric,
         nullif(x ->> 'meio_pagamento', ''), nullif(x ->> 'conta_saque', ''), (x ->> 'aprovado_em')::timestamptz, nullif(x -> 'extras', 'null'::jsonb)
    from jsonb_array_elements(coalesce(p_linhas, '[]'::jsonb)) x;
  get diagnostics v_n = row_count;
  return v_n;
end $fn$;
revoke all on function public.mp_extrato_gravar(bigint, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.mp_extrato_gravar(bigint, jsonb, boolean) to service_role;

-- Chamado pelo pg_cron. 'coletar' só vai à função quando há pedido esperando arquivo.
create or replace function public.mp_extrato_tick(p_modo text)
returns void language plpgsql set search_path = public, extensions as $fn$
declare v_chave text := 'sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA';
begin
  if p_modo not in ('pedir', 'coletar') then raise exception 'modo inválido: %', p_modo; end if;
  if p_modo = 'coletar' and not exists (select 1 from mp_extrato_pedido where status = 'pedido') then return; end if;
  perform net.http_post(
    url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/mp-extrato?modulo=' || p_modo,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_chave, 'apikey', v_chave),
    body := '{}'::jsonb, timeout_milliseconds := 40000);
end $fn$;
revoke all on function public.mp_extrato_tick(text) from public, anon, authenticated;

-- O pedido de teste de 23/nov (dia 22/11) entra na fila para a rotina coletar quando o arquivo sair.
insert into public.mp_extrato_pedido (conta, de, ate, inicio, fim, task_id, status, status_mp, pedido_em)
values (1107117809, '2026-11-22', '2026-11-22', '2026-11-22T03:00:00Z', '2026-11-23T02:59:59Z', '893150765', 'pedido', 'data-ready', '2026-11-23T16:01:23Z');

select cron.schedule('mp-extrato-pedir',   '20 3 * * *',     $$select public.mp_extrato_tick('pedir')$$);
select cron.schedule('mp-extrato-coletar', '24,54 * * * *',  $$select public.mp_extrato_tick('coletar')$$);
