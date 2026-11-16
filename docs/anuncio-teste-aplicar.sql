-- Teste A/B — aplicação na Shopee pela API (16/nov/2026, pedido do dono: "aplicar, tira da relâmpago e sobe o lance para 1,02").
-- Migração anuncio_teste_aplicar. Complementa docs/anuncio-marcacao.sql.
--
-- 1) anuncio_marcacao: status ganha 'divergente' (valor relido na Shopee não bateu) e 'revertido' (braço desfeito);
--    aplicado_em passa a ser "todas as tarefas POR API feitas" — gravado pela função, nunca apagado pelo gatilho.
--    Cada tarefa ganha "tipo": 'api' (o sistema aplica e confere) ou 'manual' (fica no painel).
-- 2) anuncio_teste_log: cada alteração (de → para, o que foi enviado, a resposta, se conferiu). Base do "reverter".
-- 3) anuncio_teste_chave: chave interna (só service_role) para a função do banco chamar a edge function.
-- 4) reverter_braco_teste(braco, confirmar): chama a edge function (slot tiny-scope-probe, modulo=reverter).

alter table public.anuncio_marcacao drop constraint if exists anuncio_marcacao_status_check;
alter table public.anuncio_marcacao add constraint anuncio_marcacao_status_check
  check (status in ('pendente','em_andamento','aplicado','nao_mexer','divergente','revertido'));

create or replace function public.anuncio_marcacao_status() returns trigger
language plpgsql set search_path = public as $$
declare n int; f int;
begin
  new.atualizado_em := now();
  if new.status in ('nao_mexer', 'revertido') then return new; end if;
  select count(*), count(*) filter (where coalesce((t->>'feito')::boolean, false))
    into n, f from jsonb_array_elements(coalesce(new.tarefas, '[]'::jsonb)) t;
  if new.status = 'divergente' and (n = 0 or f < n) then return new; end if;
  if n > 0 and f = n then new.status := 'aplicado';
  elsif f > 0 then new.status := 'em_andamento';
  else new.status := 'pendente'; end if;
  return new;
end $$;

-- tipo das tarefas + lance do T2 subiu para 1,02 (decisão do dono)
update public.anuncio_marcacao m set tarefas = (
  select coalesce(jsonb_agg(
    case
      when t->>'campo' is not null then t || '{"tipo":"api"}'
      when m.braco = 'T2' and t->>'id' = 't2' then t || jsonb_build_object('tipo', 'api', 'campo', 'criar_campanha',
        'texto', 'Criar campanha manual por palavra-chave, correspondência exata, lance 1,02, orçamento 15/dia, 10 dias, com os termos: areia para gato; areia biodegradável gato; areia de gato; areia higiênica para gatos; areia para gato biodegradável; areia de mandioca para gatos; areia para gato milho e mandioca; areia gato mandioca; areia mandioca; areia para gato mandioca')
      else t || '{"tipo":"manual"}'
    end order by o), '[]'::jsonb)
  from jsonb_array_elements(m.tarefas) with ordinality x(t, o))
where m.teste = 'Areia Ottz Pet Mandioca - nov/2026';

create table if not exists public.anuncio_teste_log (
  id bigint generated always as identity primary key,
  teste text not null,
  braco text not null,
  marcacao_id bigint references public.anuncio_marcacao(id) on delete set null,
  tarefa_id text,
  shop_id bigint not null,
  item_id text,
  campaign_id text,
  acao text not null,          -- preco | roas | pausar | titulo | criar_campanha | relampago_programacao | relampago_remover | reverter:*
  de jsonb,
  para jsonb,
  enviado jsonb,
  resposta jsonb,
  ok boolean,
  conferido boolean,
  valor_relido jsonb,
  erro text,
  origem text not null default 'teste_ab',
  quem text,
  revertido_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists anuncio_teste_log_braco on public.anuncio_teste_log (teste, braco, criado_em desc);
create index if not exists anuncio_teste_log_item on public.anuncio_teste_log (shop_id, item_id, criado_em desc);
alter table public.anuncio_teste_log enable row level security;
drop policy if exists ler on public.anuncio_teste_log;
create policy ler on public.anuncio_teste_log for select to authenticated using (public.tem_modulo('ads'));
revoke all on public.anuncio_teste_log from anon, public;
grant select on public.anuncio_teste_log to authenticated;
grant all on public.anuncio_teste_log to service_role;

create table if not exists public.anuncio_teste_chave (id int primary key default 1 check (id = 1), chave text not null);
alter table public.anuncio_teste_chave enable row level security;
revoke all on public.anuncio_teste_chave from anon, authenticated, public;
grant all on public.anuncio_teste_chave to service_role;
insert into public.anuncio_teste_chave (id, chave) values (1, encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (id) do nothing;

-- Desfaz um braço na Shopee (volta preço, ROAS, título, reativa campanha pausada, pausa a campanha criada, religa a relâmpago).
-- Sem confirmar = prévia. Devolve o id do pedido HTTP; o resultado fica em anuncio_teste_log (acao 'reverter:*').
create or replace function public.reverter_braco_teste(p_braco text, p_confirmar boolean default false) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare v_chave text; v_id bigint;
begin
  if auth.uid() is not null and not public.tem_modulo('ads') then raise exception 'sem acesso'; end if;
  select chave into v_chave from anuncio_teste_chave where id = 1;
  select net.http_post(
    url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/tiny-scope-probe?modulo=reverter',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-chave', v_chave,
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZob2dqb2ZzeHlobnl4ZHlnbG1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxOTc1OTMsImV4cCI6MjA5Mzc3MzU5M30.PxDFBdwabPDrZWzbVkj-2lE92BUIfHxUeH80Q1vNEQU'),
    body := jsonb_build_object('braco', p_braco, 'confirmar', p_confirmar, 'quem', coalesce((select nome from perfis_usuario where user_id = auth.uid()), 'sistema')),
    timeout_milliseconds := 60000) into v_id;
  return v_id;
end $$;
revoke all on function public.reverter_braco_teste(text, boolean) from public, anon;
grant execute on function public.reverter_braco_teste(text, boolean) to authenticated, service_role;

-- Rollback:
-- drop function if exists public.reverter_braco_teste(text, boolean);
-- drop table if exists public.anuncio_teste_chave; drop table if exists public.anuncio_teste_log;
-- (status/gatilho: voltar à versão de docs/anuncio-marcacao.sql)
