-- =============================================================================
-- IA · Anúncios — Fase 2 (geração dentro da gestão) — migração `ia_10_geracao`
-- Plano: docs/ia-fase2-plano.md. Decisões do dono (09/out/2026): começar do zero
-- (sem copiar o histórico do gerador), só produto do Tiny, entrada pelo Catálogo,
-- fila de imagem encadeada + rede de segurança a cada 5 min.
-- Nada daqui altera tabela existente. Rollback no fim do arquivo.
-- Porte do gerador (pcobdzlpnaoqdbsdzhlq): anuncio_briefing → ia_briefing,
-- anuncio_draft → ia_rascunho, anuncio_draft_imagem → ia_rascunho_imagem,
-- anuncio_etapa → ia_etapa, anuncio_prompt_imagem → ia_prompt_imagem,
-- produto_atributos → produtos/ia_produto + ia_produto_extra (só o que a gestão não tem).
-- Envio ao Tiny = Fase 3: aqui "aprovar" só marca a etapa.
-- =============================================================================

-- ---------------------------------------------------------------- tabelas
create table if not exists public.ia_produto_extra (
  sku              text primary key,
  publico_alvo     text,
  frete_adicional  numeric not null default 0,
  custo_embalagem  numeric not null default 0.30,
  foto_ref_path    text,                       -- cópia congelada da foto real no bucket ia-anuncios (ref/{sku}/N.ext)
  fotos_ref        text[] not null default '{}',
  updated_at       timestamptz not null default now()
);
comment on table public.ia_produto_extra is 'IA · Anúncios: dados que a gestão não tem no cadastro (público-alvo, frete adicional, embalagem) + foto de referência congelada no bucket ia-anuncios.';

create table if not exists public.ia_briefing (
  id                 uuid primary key default gen_random_uuid(),
  sku                text not null unique,
  persona            text,
  dores              jsonb not null default '[]',
  objecoes           jsonb not null default '[]',
  beneficios         jsonb not null default '[]',
  angulo             text,
  tom                text,
  palavras_chave     jsonb not null default '[]',
  fotos_recomendadas jsonb not null default '[]',
  modelo             text,
  bruto              jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.ia_rascunho (
  id                  uuid primary key default gen_random_uuid(),
  sku                 text not null,
  canal               text not null,
  empresa             text not null default 'ottz',
  status              text not null default 'rascunho'
                        check (status in ('rascunho','gerando','aguardando_revisao','aprovado','rejeitado','publicado','erro')),
  titulo              text,
  descricao           text,
  bullet_points       jsonb not null default '[]',
  custo_snapshot      numeric,
  preco_sugerido      numeric,
  preco_aprovado      numeric,
  margem_estimada_pct numeric,
  memoria_calculo     jsonb not null default '{}',
  briefing_id         uuid references public.ia_briefing(id) on delete set null,
  prompt_template_id  uuid,
  modelo_texto        text,
  erro                text,
  criado_por          uuid,
  criado_por_nome     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists ia_rascunho_sku on public.ia_rascunho (sku, created_at desc);

create table if not exists public.ia_prompt_imagem (
  id          uuid primary key default gen_random_uuid(),
  sku         text not null,
  tipo        text not null,                  -- nome do template: imagem_principal, imagem_capa_...
  prompt      text not null,
  editado_mao boolean not null default false,
  modelo      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (sku, tipo)
);

create table if not exists public.ia_rascunho_imagem (
  id                uuid primary key default gen_random_uuid(),
  rascunho_id       uuid not null references public.ia_rascunho(id) on delete cascade,
  ordem             smallint not null,
  tipo              text,                     -- sem o prefixo imagem_
  storage_path      text,
  prompt_usado      text,
  modelo            text,
  status            text not null default 'gerada' check (status in ('gerada','aprovada','rejeitada')),
  referencia_path   text,
  referencia_bytes  integer,
  referencia_sha256 text,
  gerado_em         timestamptz,
  revisado_em       timestamptz,
  created_at        timestamptz not null default now(),
  unique (rascunho_id, ordem)
);

create table if not exists public.ia_etapa (
  id            uuid primary key default gen_random_uuid(),
  rascunho_id   uuid not null references public.ia_rascunho(id) on delete cascade,
  etapa         text not null check (etapa in ('texto','imagem')),
  imagem_id     uuid references public.ia_rascunho_imagem(id) on delete cascade,
  status        text not null default 'pendente'
                  check (status in ('pendente','na_fila','gerando','gerado','aprovado','rejeitado','erro','enviando','enviado')),
  conteudo_hash text,
  observacao    text,
  tentativas    smallint not null default 0,
  erro          text,
  pegado_em     timestamptz,
  proxima_em    timestamptz,                -- backoff: na fila, mas só pode ser pega a partir daqui
  aprovado_em   timestamptz,
  aprovado_por  uuid,
  created_at    timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists ia_etapa_texto_uniq on public.ia_etapa (rascunho_id) where etapa = 'texto';
create unique index if not exists ia_etapa_imagem_uniq on public.ia_etapa (imagem_id) where imagem_id is not null;
create index if not exists ia_etapa_fila on public.ia_etapa (status, created_at) where etapa = 'imagem';

-- updated_at
create trigger trg_ia_produto_extra_upd before update on public.ia_produto_extra for each row execute function public.ia_set_updated_at();
create trigger trg_ia_briefing_upd      before update on public.ia_briefing      for each row execute function public.ia_set_updated_at();
create trigger trg_ia_rascunho_upd      before update on public.ia_rascunho      for each row execute function public.ia_set_updated_at();
create trigger trg_ia_prompt_imagem_upd before update on public.ia_prompt_imagem for each row execute function public.ia_set_updated_at();

-- ---------------------------------------------------------------- acesso (mesmo padrão da Fase 1)
do $$
declare t text;
begin
  foreach t in array array['ia_produto_extra','ia_briefing','ia_rascunho','ia_prompt_imagem','ia_rascunho_imagem'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.tem_modulo(''ia'')) with check (public.tem_modulo(''ia''))', t || '_modulo_ia', t);
  end loop;
end $$;
-- etapa: o app só LÊ; muda por RPC (aprovar/rejeitar) ou pela edge fn (service role)
alter table public.ia_etapa enable row level security;
grant select on public.ia_etapa to authenticated;
grant all on public.ia_etapa to service_role;
create policy ia_etapa_ler on public.ia_etapa for select to authenticated using (public.tem_modulo('ia'));

-- ---------------------------------------------------------------- triggers de etapa
-- texto gerado/alterado → etapa 'texto' (gerado). Se mudou depois de aprovada, volta para revisão.
create or replace function public.ia_trg_rascunho_texto()
returns trigger language plpgsql security definer set search_path = public as $$
declare h text; v_id uuid; v_mudou boolean;
begin
  if new.titulo is null then return new; end if;
  h := md5(coalesce(new.titulo,'') || '|' || coalesce(new.descricao,'') || '|' || coalesce(new.bullet_points::text,'[]'));
  insert into public.ia_etapa (rascunho_id, etapa, status, conteudo_hash)
  values (new.id, 'texto', 'gerado', h)
  on conflict (rascunho_id) where etapa = 'texto' do nothing;
  select id, (conteudo_hash is distinct from h) into v_id, v_mudou
  from public.ia_etapa where rascunho_id = new.id and etapa = 'texto';
  if v_mudou then
    update public.ia_etapa set status = 'gerado', conteudo_hash = h, erro = null, tentativas = 0,
           aprovado_em = null, aprovado_por = null, atualizado_em = now()
    where id = v_id;
  end if;
  return new;
end $$;
create trigger trg_ia_rascunho_texto after insert or update of titulo, descricao, bullet_points
  on public.ia_rascunho for each row execute function public.ia_trg_rascunho_texto();

-- status da etapa de imagem espelhado na linha da imagem
create or replace function public.ia_trg_etapa_imagem()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.etapa = 'imagem' and new.status is distinct from old.status then
    update public.ia_rascunho_imagem
    set status = case when new.status in ('aprovado','enviando','enviado') then 'aprovada'
                      when new.status = 'rejeitado' then 'rejeitada' else 'gerada' end,
        revisado_em = case when new.status in ('aprovado','rejeitado') then now() else revisado_em end
    where id = new.imagem_id;
  end if;
  return new;
end $$;
create trigger trg_ia_etapa_imagem after update of status on public.ia_etapa
  for each row execute function public.ia_trg_etapa_imagem();

-- ---------------------------------------------------------------- RPCs
-- Custo da mercadoria = regra da GESTÃO (view_cmv_efetivo: kit pela composição).
create or replace function public.ia_calcular_preco(p_sku text, p_canal text, p_empresa text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_custo numeric; v_frete numeric := 0; v_emb numeric := 0.30;
  v_cfg public.ia_canal_config%rowtype; v_emp public.ia_empresa%rowtype; v_faixa record;
  v_piso numeric := 0; v_ct numeric; v_denom numeric; v_preco numeric; v_lucro numeric;
begin
  select cmv_efetivo into v_custo from public.view_cmv_efetivo where sku = p_sku;
  if v_custo is null then return jsonb_build_object('erro', 'sku sem custo: ' || p_sku); end if;
  select coalesce(frete_adicional, 0), coalesce(custo_embalagem, 0.30) into v_frete, v_emb
  from public.ia_produto_extra where sku = p_sku;
  v_frete := coalesce(v_frete, 0); v_emb := coalesce(v_emb, 0.30);
  select * into v_cfg from public.ia_canal_config where canal = p_canal;
  if not found then return jsonb_build_object('erro', 'canal inexistente: ' || p_canal); end if;
  select * into v_emp from public.ia_empresa where codigo = p_empresa;
  if not found then return jsonb_build_object('erro', 'empresa inexistente: ' || p_empresa); end if;
  v_ct := v_custo + v_frete + v_emb;
  for v_faixa in select * from public.ia_canal_faixa where canal = p_canal order by ordem loop
    v_denom := 1 - v_emp.imposto_pct - v_faixa.comissao_pct - v_cfg.custos_fixos_pct - v_cfg.margem_alvo_pct;
    if v_denom <= 0 then continue; end if;
    v_preco := (v_ct + v_faixa.tarifa_fixa) / v_denom;
    if v_faixa.preco_ate is null or v_preco <= v_faixa.preco_ate then
      v_preco := round(greatest(v_preco, v_piso), 2);
      v_lucro := round(v_preco * (1 - v_emp.imposto_pct - v_faixa.comissao_pct - v_cfg.custos_fixos_pct) - v_ct - v_faixa.tarifa_fixa, 2);
      return jsonb_build_object(
        'preco_sugerido', v_preco, 'lucro_reais', v_lucro, 'margem_estimada_pct', round(v_lucro / v_preco, 4),
        'memoria_calculo', jsonb_build_object(
          'empresa', v_emp.codigo, 'custo_mercadoria', v_custo, 'fonte_custo', 'view_cmv_efetivo',
          'frete_adicional', v_frete, 'embalagem', v_emb, 'custo_total', v_ct,
          'faixa', v_faixa.ordem, 'comissao_pct', v_faixa.comissao_pct, 'tarifa_fixa', v_faixa.tarifa_fixa,
          'imposto_pct', v_emp.imposto_pct, 'custos_fixos_pct', v_cfg.custos_fixos_pct,
          'margem_alvo_pct', v_cfg.margem_alvo_pct,
          'formula', '(custo_total + tarifa_fixa) / (1 - imposto - comissao - custos_fixos - margem_alvo)',
          'calculado_em', now()));
    end if;
    v_piso := v_faixa.preco_ate + 0.01;
  end loop;
  return jsonb_build_object('erro', 'nenhuma faixa viavel para ' || p_canal);
end $$;

create or replace function public.ia_analisar_preco(p_sku text, p_canal text, p_empresa text, p_preco numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_custo numeric; v_frete numeric := 0; v_emb numeric := 0.30;
  v_cfg public.ia_canal_config%rowtype; v_emp public.ia_empresa%rowtype; v_faixa public.ia_canal_faixa%rowtype;
  v_ct numeric; v_lucro numeric; v_lucro_p numeric; v_custo_mx numeric;
begin
  select cmv_efetivo into v_custo from public.view_cmv_efetivo where sku = p_sku;
  if v_custo is null then return jsonb_build_object('erro', 'sku sem custo: ' || p_sku); end if;
  if p_preco is null or p_preco <= 0 then return jsonb_build_object('erro', 'preço inválido'); end if;
  select coalesce(frete_adicional, 0), coalesce(custo_embalagem, 0.30) into v_frete, v_emb
  from public.ia_produto_extra where sku = p_sku;
  v_frete := coalesce(v_frete, 0); v_emb := coalesce(v_emb, 0.30);
  select * into v_cfg from public.ia_canal_config where canal = p_canal;
  select * into v_emp from public.ia_empresa where codigo = p_empresa;
  select * into v_faixa from public.ia_canal_faixa
  where canal = p_canal and (preco_ate is null or p_preco <= preco_ate) order by ordem limit 1;
  if not found then return jsonb_build_object('erro', 'sem faixa para o preço'); end if;
  v_ct := v_custo + v_frete + v_emb;
  v_lucro := round(p_preco * (1 - v_emp.imposto_pct - v_faixa.comissao_pct - v_cfg.custos_fixos_pct) - v_ct - v_faixa.tarifa_fixa, 2);
  v_lucro_p := round(v_lucro / p_preco, 4);
  v_custo_mx := round(p_preco * (1 - v_emp.imposto_pct - v_faixa.comissao_pct - v_cfg.custos_fixos_pct - v_cfg.margem_alvo_pct)
                - v_faixa.tarifa_fixa - v_frete - v_emb, 2);
  return jsonb_build_object(
    'preco_praticado', p_preco, 'lucro_reais', v_lucro, 'lucro_pct', v_lucro_p,
    'status', case when v_lucro_p >= v_cfg.margem_alvo_pct then 'ok' when v_lucro_p > 0 then 'baixo' else 'prejuizo' end,
    'custo_max_mercadoria', v_custo_mx, 'folga_reais', round(v_custo_mx - v_custo, 2),
    'faixa', v_faixa.ordem, 'comissao_pct', v_faixa.comissao_pct, 'tarifa_fixa', v_faixa.tarifa_fixa,
    'imposto_pct', v_emp.imposto_pct, 'margem_alvo_pct', v_cfg.margem_alvo_pct);
end $$;

-- Aprovar/rejeitar = só marca (Fase 2). Envio ao Tiny entra na Fase 3.
create or replace function public.ia_etapa_aprovar(p_etapa uuid)
returns text language plpgsql security definer set search_path = public as $$
declare e public.ia_etapa;
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  select * into e from public.ia_etapa where id = p_etapa for update;
  if not found then raise exception 'Etapa não encontrada.'; end if;
  if e.status in ('pendente','na_fila','gerando','enviando') then
    raise exception 'Nada para aprovar agora (status: %).', e.status;
  end if;
  if e.etapa = 'imagem' and not exists (select 1 from public.ia_rascunho_imagem where id = e.imagem_id and storage_path is not null) then
    raise exception 'Imagem ainda não gerada.';
  end if;
  update public.ia_etapa set status = 'aprovado', aprovado_em = now(), aprovado_por = auth.uid(), erro = null, atualizado_em = now()
  where id = e.id;
  return 'aprovado';
end $$;

create or replace function public.ia_etapa_rejeitar(p_etapa uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.tem_modulo('ia') then raise exception 'Sem acesso ao módulo IA.'; end if;
  update public.ia_etapa set status = 'rejeitado', erro = null, aprovado_em = null, aprovado_por = null, atualizado_em = now()
  where id = p_etapa and status not in ('na_fila','gerando','enviando');
  if not found then raise exception 'Não dá para rejeitar agora (etapa na fila/gerando ou inexistente).'; end if;
  return 'rejeitado';
end $$;

-- Fila de imagem: devolve à fila o que travou em 'gerando' (> 5 min) e pega UM item.
create or replace function public.ia_imagem_fila_pegar(p_etapa uuid default null)
returns setof public.ia_etapa language plpgsql security definer set search_path = public as $$
begin
  update public.ia_etapa set status = 'na_fila', pegado_em = null, atualizado_em = now()
  where etapa = 'imagem' and status = 'gerando' and (pegado_em is null or pegado_em < now() - interval '5 minutes');
  return query
  update public.ia_etapa e
  set status = 'gerando', pegado_em = now(), tentativas = e.tentativas + 1, atualizado_em = now()
  where e.id = (
    select id from public.ia_etapa
    where etapa = 'imagem' and status = 'na_fila' and (p_etapa is null or id = p_etapa)
      and (proxima_em is null or proxima_em <= now())
    order by created_at limit 1 for update skip locked)
  returning e.*;
end $$;

-- Rede de segurança (cron a cada 5 min): só chama o worker se houver imagem PARADA.
-- Fila andando normalmente (encadeada) = não faz nada.
create or replace function public.ia_fila_vigiar()
returns text language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from public.ia_etapa
  where etapa = 'imagem'
    and ((status = 'na_fila' and coalesce(proxima_em, atualizado_em + interval '3 minutes') <= now())
      or (status = 'gerando' and pegado_em < now() - interval '5 minutes'));
  if n = 0 then return 'ok'; end if;
  perform net.http_post(
    url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/ia-imagem-worker',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA',
      'apikey','sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA'),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
  return 'retomada: ' || n;
end $$;

revoke all on function public.ia_imagem_fila_pegar(uuid) from public, anon, authenticated;
revoke all on function public.ia_fila_vigiar() from public, anon, authenticated;
grant execute on function public.ia_imagem_fila_pegar(uuid) to service_role;
grant execute on function public.ia_fila_vigiar() to service_role;
grant execute on function public.ia_calcular_preco(text, text, text) to authenticated, service_role;
grant execute on function public.ia_analisar_preco(text, text, text, numeric) to authenticated, service_role;
grant execute on function public.ia_etapa_aprovar(uuid) to authenticated, service_role;
grant execute on function public.ia_etapa_rejeitar(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- Storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ia-anuncios', 'ia-anuncios', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
create policy ia_anuncios_obj_sel on storage.objects for select to authenticated using (bucket_id = 'ia-anuncios' and public.tem_modulo('ia'));
create policy ia_anuncios_obj_ins on storage.objects for insert to authenticated with check (bucket_id = 'ia-anuncios' and public.tem_modulo('ia'));
create policy ia_anuncios_obj_upd on storage.objects for update to authenticated using (bucket_id = 'ia-anuncios' and public.tem_modulo('ia')) with check (bucket_id = 'ia-anuncios' and public.tem_modulo('ia'));
create policy ia_anuncios_obj_del on storage.objects for delete to authenticated using (bucket_id = 'ia-anuncios' and public.tem_modulo('ia'));

-- ---------------------------------------------------------------- cron (aplicado à parte, depois do deploy da ia-imagem-worker)
-- select cron.schedule('ia-fila-vigiar', '2-59/5 * * * *', $$select public.ia_fila_vigiar()$$);

-- =============================================================================
-- ROLLBACK
-- select cron.unschedule('ia-fila-vigiar');
-- drop table if exists public.ia_etapa, public.ia_rascunho_imagem, public.ia_prompt_imagem,
--   public.ia_rascunho, public.ia_briefing, public.ia_produto_extra cascade;
-- drop function if exists public.ia_trg_rascunho_texto(), public.ia_trg_etapa_imagem(),
--   public.ia_calcular_preco(text,text,text), public.ia_analisar_preco(text,text,text,numeric),
--   public.ia_etapa_aprovar(uuid), public.ia_etapa_rejeitar(uuid),
--   public.ia_imagem_fila_pegar(uuid), public.ia_fila_vigiar();
-- drop policy if exists ia_anuncios_obj_sel on storage.objects; (idem _ins, _upd, _del)
-- Bucket: esvaziar e apagar pelo painel do Storage. Edge fns: apagar ia-anuncio e ia-imagem-worker.
-- =============================================================================
