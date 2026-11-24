-- =============================================================================
-- IA › Anúncios: REGRA DE PREÇO POR LOJA (24/nov/2026, pedido do dono)
--   "TikTok: preço cheio com 30% de margem de contribuição.
--    Ottz Pet (Shopee): sempre preço cheio de 30% e sempre promocionado com 17,5%.
--    Bumi Pet (Shopee): sempre promocionado também, preço cheio de 40% e promoção de 15%."
--
-- ia_loja_preco (canal, empresa): margem do preço CHEIO, margem do preço PROMOCIONAL e se o anúncio
-- entra sempre na promoção em andamento. ia_calcular_preco(sku, canal, empresa, NULL) passa a usar a
-- margem da loja antes da padrão do canal (ia_canal_config.margem_alvo_pct) — vale para todo lugar
-- que pede "o preço da margem padrão" (conferência do envio, variações, envio em lote, bloco Preço).
-- Empresa: ottz = Ottz Pet / ACZ · svl = Bumi Pet (Shopee 759046323) / SVL Store.
-- Migração: ia_loja_preco
-- =============================================================================

create table if not exists public.ia_loja_preco (
  canal             text not null,
  empresa           text not null references public.ia_empresa(codigo),
  margem_cheio_pct  numeric(6,4) not null check (margem_cheio_pct >= 0 and margem_cheio_pct < 0.6),
  margem_promo_pct  numeric(6,4) check (margem_promo_pct is null or (margem_promo_pct >= 0 and margem_promo_pct < 0.6)),
  promo_sempre      boolean not null default false,
  atualizado_em     timestamptz not null default now(),
  primary key (canal, empresa)
);
comment on table public.ia_loja_preco is 'Regra de preço por loja no envio de anúncio (pedido do dono, 24/nov/2026).';
alter table public.ia_loja_preco enable row level security;
drop policy if exists ia_loja_preco_ler on public.ia_loja_preco;
create policy ia_loja_preco_ler on public.ia_loja_preco for select to authenticated using (true);
drop policy if exists ia_loja_preco_editar on public.ia_loja_preco;
create policy ia_loja_preco_editar on public.ia_loja_preco for all to authenticated
  using (public.tem_modulo('todos')) with check (public.tem_modulo('todos'));
grant select, insert, update, delete on public.ia_loja_preco to authenticated;

insert into public.ia_loja_preco (canal, empresa, margem_cheio_pct, margem_promo_pct, promo_sempre) values
  ('shopee', 'ottz', 0.30, 0.175, true),
  ('shopee', 'svl',  0.40, 0.15,  true),
  ('tiktok', 'ottz', 0.30, null,  false)
on conflict (canal, empresa) do update set
  margem_cheio_pct = excluded.margem_cheio_pct, margem_promo_pct = excluded.margem_promo_pct,
  promo_sempre = excluded.promo_sempre, atualizado_em = now();

-- ia_calcular_preco: margem nula = a da loja, senão a do canal (troca de trechos da função NO AR)
do $mig$
declare
  s text := pg_get_functiondef('public.ia_calcular_preco(text,text,text,numeric)'::regprocedure);
  loja text := '(select l.margem_cheio_pct from public.ia_loja_preco l where l.canal = p_canal and l.empresa = p_empresa)';
  a1 text := 'v_mg := coalesce(p_margem, v_cfg.margem_alvo_pct);';
  a2 text := '''margem_padrao_pct'', v_cfg.margem_alvo_pct';
begin
  if position(a1 in s) = 0 then raise exception 'trecho da margem não encontrado em ia_calcular_preco'; end if;
  if position(a2 in s) = 0 then raise exception 'trecho margem_padrao_pct não encontrado em ia_calcular_preco'; end if;
  s := replace(s, a1, 'v_mg := coalesce(p_margem, ' || loja || ', v_cfg.margem_alvo_pct);');
  s := replace(s, a2, '''margem_padrao_pct'', coalesce(' || loja || ', v_cfg.margem_alvo_pct)');
  execute s;
end $mig$;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
do $rb$
declare
  s text := pg_get_functiondef('public.ia_calcular_preco(text,text,text,numeric)'::regprocedure);
  loja text := '(select l.margem_cheio_pct from public.ia_loja_preco l where l.canal = p_canal and l.empresa = p_empresa)';
begin
  s := replace(s, 'v_mg := coalesce(p_margem, ' || loja || ', v_cfg.margem_alvo_pct);', 'v_mg := coalesce(p_margem, v_cfg.margem_alvo_pct);');
  s := replace(s, '''margem_padrao_pct'', coalesce(' || loja || ', v_cfg.margem_alvo_pct)', '''margem_padrao_pct'', v_cfg.margem_alvo_pct');
  execute s;
end $rb$;
drop table if exists public.ia_loja_preco;
*/
