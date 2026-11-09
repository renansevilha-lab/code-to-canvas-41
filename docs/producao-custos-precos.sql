-- ============================================================================
-- Produção › Custos e Preços (09/nov/2026, briefing do dono)
-- Custo variável por unidade dos produtos fabricados, cenários, preços por canal
-- (marketplace e atacado), margem reversa, piso e tabela de atacado publicada.
-- Acesso: módulo 'custos' (ou 'todos') — tem_modulo('custos'). RLS em todas as tabelas.
-- Toda a conta mora aqui; o front só lê.
--
-- Decisões do dono na conferência do briefing (09/nov):
--  * Comissão da Shopee = shopee_tarifa (vigência; R$ 4,50 desde 01/10), NÃO ia_canal_faixa (parada em R$ 4,00).
--  * Produtos = os da Produção (producao_parametros) com os dados reais de cadastro (sem "Roxa" fictícia).
--  * MOD = custo real das pessoas de cada lote (diária ÷ horas do dia; mensal × encargos ÷ horas do mês).
--  * producao_config NÃO é alterado: o custo medido é registrado/exibido; o cenário escolhe o que usar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------
create table if not exists public.custo_cenario (
  id bigserial primary key,
  nome text not null,
  descricao text,
  padrao boolean not null default false,
  fator_encargos numeric not null default 1.35,
  horas_mes_mensalista numeric not null default 220,
  horas_dia_diarista numeric not null default 8,
  imposto_pct numeric not null default 0.115,
  volume_mes_un numeric not null default 3800,   -- base do "desperdício por mês"
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists custo_cenario_um_padrao on public.custo_cenario ((true)) where padrao;

create table if not exists public.custo_cenario_sku (
  cenario_id bigint not null references public.custo_cenario(id) on delete cascade,
  sku text not null references public.producao_parametros(sku),
  fonte_materia text not null default 'medido' check (fonte_materia in ('padrao','medido','manual')),
  kg_un_manual numeric,
  preco_kg_fonte text not null default 'ultima_entrada' check (preco_kg_fonte in ('ultima_entrada','referencia','media_90d','manual')),
  preco_kg_manual numeric,
  preco_mistura_un_manual numeric,
  embalagem_rs_un_manual numeric,
  etiqueta_rs_un_manual numeric,
  fonte_mod text not null default 'medido' check (fonte_mod in ('medido','manual_hora','manual_un')),
  mod_rs_hora_manual numeric,
  un_homem_hora_manual numeric,
  mod_rs_un_manual numeric,
  premio_rs_lote numeric not null default 50,
  un_por_lote numeric,
  cif_rs_un numeric not null default 0,
  observacao text,
  atualizado_em timestamptz not null default now(),
  primary key (cenario_id, sku)
);

create table if not exists public.preco_canal (
  id bigserial primary key,
  canal text not null unique,
  tipo text not null check (tipo in ('marketplace','atacado')),
  nome_exibicao text not null,
  comissao_fonte text,                     -- 'shopee_tarifa' = faixas da tabela shopee_tarifa (vigência)
  comissao_pct numeric not null default 0,
  tarifa_fixa numeric not null default 0,
  comissao_extra_pct numeric not null default 0,
  custo_financeiro_pct numeric not null default 0,
  imposto_pct numeric,                     -- nulo = o do cenário
  condicao_padrao text,
  mc_publicacao numeric,                   -- MC padrão desta faixa na tabela de atacado publicada
  ativo boolean not null default true,
  ordem smallint not null default 0
);

create table if not exists public.preco_margem_alvo (
  id bigserial primary key,
  mc_pct numeric not null unique,
  ordem smallint not null default 0,
  ativo boolean not null default true
);

create table if not exists public.preco_praticado (
  id bigserial primary key,
  sku text not null,
  canal text not null references public.preco_canal(canal),
  preco numeric not null check (preco > 0),
  vigencia date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  origem text not null default 'manual' check (origem in ('manual','shopee_anuncios','tabela_atacado')),
  obs text,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now()
);
create index if not exists preco_praticado_sku_canal on public.preco_praticado (sku, canal, vigencia desc, id desc);

create table if not exists public.preco_tabela_publicada (
  id bigserial primary key,
  cenario_id bigint not null references public.custo_cenario(id) on delete restrict,
  nome text not null,
  mc jsonb not null,                       -- {"atacado_loja":0.283,...}
  publicado_em timestamptz not null default now(),
  publicado_por uuid default auth.uid(),
  publicado_por_nome text,
  snapshot jsonb not null                  -- congelado: nunca recalcula
);

-- um cenário padrão por vez
create or replace function public.custo_cenario_um_padrao() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.padrao then
    update public.custo_cenario set padrao = false where padrao and id <> coalesce(new.id, -1);
  end if;
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists trg_custo_cenario_um_padrao on public.custo_cenario;
create trigger trg_custo_cenario_um_padrao before insert or update on public.custo_cenario
  for each row execute function public.custo_cenario_um_padrao();

-- publicação é imutável
create or replace function public.preco_tabela_imutavel() returns trigger
language plpgsql as $$ begin raise exception 'Tabela publicada não muda: publique outra.'; end $$;
drop trigger if exists trg_preco_tabela_imutavel on public.preco_tabela_publicada;
create trigger trg_preco_tabela_imutavel before update on public.preco_tabela_publicada
  for each row execute function public.preco_tabela_imutavel();

-- RLS: módulo custos (ou todos), nunca anon
do $$
declare t text;
begin
  foreach t in array array['custo_cenario','custo_cenario_sku','preco_canal','preco_margem_alvo','preco_praticado','preco_tabela_publicada'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists custos on public.%I', t);
    execute format('create policy custos on public.%I for all to authenticated using (public.tem_modulo(''custos'')) with check (public.tem_modulo(''custos''))', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage on sequence public.custo_cenario_id_seq, public.preco_canal_id_seq, public.preco_margem_alvo_id_seq,
  public.preco_praticado_id_seq, public.preco_tabela_publicada_id_seq to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Medições (views só leitura)
-- ---------------------------------------------------------------------------

-- 2.1 Preço do kg (e da unidade) de cada matéria-prima: referência, última entrada, média 90 d
create or replace view public.view_custo_preco_kg with (security_invoker = true) as
select i.id insumo_id, i.nome, i.tipo, i.unidade, i.custo_referencia,
       u.custo_un ultima_custo, u.recebido_em ultima_em, u.nf_numero ultima_nf, u.fornecedor_nome ultima_fornecedor,
       m.media_90d, m.qtd_90d
  from public.producao_insumo i
  left join lateral (select e.custo_un, e.recebido_em, e.nf_numero, e.fornecedor_nome from public.producao_entrada e
                      where e.insumo_id = i.id and e.custo_un > 0 order by e.recebido_em desc nulls last, e.id desc limit 1) u on true
  left join lateral (select sum(e.custo_un * e.quantidade) / nullif(sum(e.quantidade), 0) media_90d, sum(e.quantidade) qtd_90d
                       from public.producao_entrada e
                      where e.insumo_id = i.id and e.custo_un > 0 and e.recebido_em >= (now() at time zone 'America/Sao_Paulo')::date - 90) m on true
 where public.tem_modulo('custos');

-- 2.2 Consumo real de farinha pelo FECHAMENTO do big bag (a baixa por ordem não é medição)
create or replace view public.view_custo_materia_bags with (security_invoker = true) as
with consumo as (
  select e.id entrada_id, e.codigo, e.insumo_id, e.quantidade kg_recebido, sum(c.quantidade) kg_consumido
    from public.producao_entrada e
    join public.producao_insumo i on i.id = e.insumo_id and i.tipo = 'farinha'
    join public.producao_consumo c on c.entrada_id = e.id and c.insumo_id = e.insumo_id
   group by e.id, e.codigo, e.insumo_id, e.quantidade
), uso as (
  select o.entrada_id, count(distinct p.peso_nominal_kg) pesos, max(p.peso_nominal_kg) peso,
         bool_or(p.mistura_insumo_id is not null) mistura, bool_or(o.status <> 'encerrada') aberta,
         sum(o.qtd_boa_final) filter (where o.status = 'encerrada') un,
         string_agg(distinct o.sku, ', ') skus, max(o.fim_em) ultima
    from public.producao_ordem o join public.producao_parametros p on p.sku = o.sku
   where o.status <> 'cancelada'
   group by o.entrada_id
)
select c.entrada_id, c.codigo, c.insumo_id, i.nome insumo, c.kg_recebido, round(c.kg_consumido, 3) kg_consumido,
       u.peso peso_nominal_kg, u.skus, u.un, round(c.kg_consumido / nullif(u.un, 0), 4) kg_un,
       (u.ultima at time zone 'America/Sao_Paulo')::date ultima_medicao,
       case when abs(c.kg_consumido - c.kg_recebido) >= 0.5 then 'aberto'
            when u.entrada_id is null or coalesce(u.un, 0) = 0 then 'sem_producao'
            when u.aberta then 'lote_aberto'
            when u.pesos > 1 then 'contaminada'
            when u.mistura then 'mistura'
            else 'ok' end situacao
  from consumo c
  join public.producao_insumo i on i.id = c.insumo_id
  left join uso u on u.entrada_id = c.entrada_id
 where public.tem_modulo('custos');

create or replace view public.view_custo_materia_medida with (security_invoker = true) as
select b.insumo_id, b.insumo nome, b.peso_nominal_kg, count(*) bags, sum(b.kg_consumido) kg_total, sum(b.un) un_total,
       round(sum(b.kg_consumido) / sum(b.un), 4) kg_un_medido,
       round(sum(b.kg_consumido) / sum(b.un) / b.peso_nominal_kg - 1, 4) perda_real_pct,
       min(b.kg_un) kg_un_min_bag, max(b.kg_un) kg_un_max_bag,
       count(*) >= 2 amostra_ok, max(b.ultima_medicao) ultima_medicao
  from public.view_custo_materia_bags b
 where b.situacao = 'ok'
 group by b.insumo_id, b.insumo, b.peso_nominal_kg;

-- 2.3 Mão de obra por lote (custo real das pessoas; parâmetros de horas/encargos vêm do cenário)
create or replace function public.custo_mod_lotes(p_fator numeric, p_horas_mes numeric, p_horas_dia numeric)
returns table (ordem_id bigint, codigo text, sku text, dia date, mistura boolean, peso_nominal_kg numeric, un integer,
               min_linha numeric, horas_linha numeric, pessoas integer, quem text, homem_horas numeric, custo numeric,
               un_h_linha numeric, un_homem_hora numeric, limpo boolean, motivo text)
language sql stable set search_path = public as $$
  with o as (
    select o.id, o.codigo, o.sku, o.qtd_boa_final un, o.inicio_em, o.fim_em,
           extract(epoch from (o.fim_em - o.inicio_em)) / 60.0 min,
           p.mistura_insumo_id is not null mist, p.peso_nominal_kg peso
      from producao_ordem o join producao_parametros p on p.sku = o.sku
     where o.status = 'encerrada' and o.inicio_em is not null and o.fim_em is not null
  ), pes as (   -- por pessoa: do 1º início ao último fim das etapas dela (hoje = janela da ordem)
    select e.ordem_id, e.pessoa_id, extract(epoch from (max(coalesce(e.fim_em, o.fim_em)) - min(coalesce(e.inicio_em, o.inicio_em)))) / 3600.0 h,
           case r.vinculo when 'diaria' then r.valor_base / nullif(p_horas_dia, 0)
                          when 'mensal' then r.valor_base * p_fator / nullif(p_horas_mes, 0) end rs_h
      from producao_etapa e join o on o.id = e.ordem_id
      left join rh_colaboradores r on r.pessoa_id = e.pessoa_id
     where e.pessoa_id is not null
     group by e.ordem_id, e.pessoa_id, r.vinculo, r.valor_base
  ), agg as (
    select ordem_id, count(*)::int pessoas, string_agg(pessoa_id, ', ' order by pessoa_id) quem,
           sum(h) homem_horas, sum(h * coalesce(rs_h, 0)) custo, bool_or(rs_h is null) sem_custo
      from pes group by ordem_id
  )
  select o.id, o.codigo, o.sku, (o.inicio_em at time zone 'America/Sao_Paulo')::date, o.mist, o.peso, o.un,
         round(o.min::numeric, 1), round((o.min / 60.0)::numeric, 3), a.pessoas, a.quem,
         round(a.homem_horas::numeric, 3), round(a.custo::numeric, 2),
         round((o.un / nullif(o.min / 60.0, 0))::numeric, 1), round((o.un / nullif(a.homem_horas, 0))::numeric, 1),
         m.motivo is null, m.motivo
    from o left join agg a on a.ordem_id = o.id
    cross join lateral (select case
        when coalesce(o.un, 0) <= 0 then 'sem quantidade'
        when a.ordem_id is null then 'sem pessoas nas etapas'
        when a.sem_custo then 'pessoa sem custo cadastrado'
        when o.min < 10 then 'fechamento retroativo (< 10 min)'
        when not o.mist and o.min > 240 then 'lote deixado aberto (> 4 h)'
        when o.mist and o.min > 720 then 'lote deixado aberto (> 12 h)'
        when not o.mist and (o.un / (o.min / 60.0) < 40 or o.un / (o.min / 60.0) > 150) then 'ritmo fora de 40–150 un/h'
      end motivo) m
$$;

create or replace view public.view_custo_mod_lote with (security_invoker = true) as
select l.* from public.custo_cenario c
 cross join lateral public.custo_mod_lotes(c.fator_encargos, c.horas_mes_mensalista, c.horas_dia_diarista) l
 where c.padrao and public.tem_modulo('custos');

-- agregado (cenário padrão): por SKU e pelos grupos "mandioca pura" e "misturas"
create or replace view public.view_custo_mod_medida with (security_invoker = true) as
select grupo, sku, count(*) lotes, sum(un) un_total, round(sum(horas_linha), 2) horas_linha, round(sum(homem_horas), 2) homem_horas,
       round(sum(un) / nullif(sum(horas_linha), 0), 1) un_h_linha, round(sum(un) / nullif(sum(homem_horas), 0), 1) un_homem_hora,
       round(sum(custo) / nullif(sum(homem_horas), 0), 2) rs_homem_hora_medio, round(sum(custo) / nullif(sum(un), 0), 4) mod_rs_un
  from (select case when mistura then 'Misturas' else 'Mandioca pura ' || trim(to_char(peso_nominal_kg, 'FM990.##')) || ' kg' end grupo,
               sku, un, horas_linha, homem_horas, custo
          from public.view_custo_mod_lote where limpo) x
 group by grouping sets ((grupo, sku), (grupo));

-- produtividade por tamanho de equipe (lotes limpos de mandioca pura)
create or replace view public.view_custo_mod_dotacao with (security_invoker = true) as
select pessoas, count(*) lotes, sum(un) un_total, round(sum(homem_horas), 2) homem_horas,
       round(sum(un) / nullif(sum(horas_linha), 0), 1) un_h_linha, round(sum(un) / nullif(sum(homem_horas), 0), 1) un_homem_hora,
       round(sum(custo) / nullif(sum(un), 0), 4) mod_rs_un
  from public.view_custo_mod_lote where limpo and not mistura group by pessoas;

-- 2.4 Apontamentos que não servem para medir
create or replace view public.view_producao_apontamento_suspeito with (security_invoker = true) as
select o.id ordem_id, o.codigo, o.sku, (o.inicio_em at time zone 'America/Sao_Paulo')::date dia, o.qtd_boa_final un,
       round((extract(epoch from (o.fim_em - o.inicio_em)) / 60)::numeric, 1) min_linha,
       coalesce(et.n, 0) etapas, coalesce(et.carimbadas_juntas, false) etapas_carimbadas_juntas,
       l.motivo, (l.motivo is not null) inutil_para_medir
  from public.producao_ordem o
  left join lateral (select count(*) n,
                            count(*) > 1 and count(distinct (e.inicio_em, e.fim_em)) = 1 carimbadas_juntas
                       from public.producao_etapa e where e.ordem_id = o.id) et on true
  left join public.view_custo_mod_lote l on l.ordem_id = o.id
 where o.status = 'encerrada' and public.tem_modulo('custos');

-- ---------------------------------------------------------------------------
-- 3. Custo variável por unidade (fonte única)
-- ---------------------------------------------------------------------------
create or replace function public.custo_cenario_calcular(p_cenario bigint)
returns table (
  sku text, nome text, peso_nominal_kg numeric, mistura boolean, farinha_id bigint, farinha_nome text,
  kg_un numeric, kg_un_fonte text, kg_un_padrao numeric, kg_un_medido numeric, bags_medidos bigint,
  preco_kg numeric, preco_kg_fonte text, preco_kg_referencia numeric, preco_kg_ultima numeric, preco_kg_media_90d numeric,
  kg_farinha numeric, mistura_nome text, un_mistura numeric, preco_mistura_un numeric,
  materia numeric, embalagem_nome text, embalagem numeric, etiqueta numeric,
  mod numeric, mod_fonte text, mod_un_homem_hora numeric, mod_rs_hora numeric,
  un_por_lote numeric, premio numeric, cif numeric, cv numeric, cv_padrao numeric, cv_medido numeric,
  desperdicio_un numeric, desperdicio_mes numeric, alerta_desperdicio boolean, avisos text[])
language plpgsql stable security definer set search_path = public as $$
declare c custo_cenario;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  select * into c from custo_cenario where id = p_cenario;
  if not found then raise exception 'cenário % não existe', p_cenario; end if;

  return query
  with lotes as (select * from custo_mod_lotes(c.fator_encargos, c.horas_mes_mensalista, c.horas_dia_diarista) lx where lx.limpo),
  mod_sku as (select l.sku, count(*) n, sum(l.un) un, sum(l.custo) / nullif(sum(l.un), 0) rs_un,
                     sum(l.un) / nullif(sum(l.homem_horas), 0) un_hh, sum(l.custo) / nullif(sum(l.homem_horas), 0) rs_h
                from lotes l group by l.sku),
  mod_grupo as (select l.mistura, case when l.mistura then 0 else l.peso_nominal_kg end gpeso, sum(l.custo) / nullif(sum(l.un), 0) rs_un,
                       sum(l.un) / nullif(sum(l.homem_horas), 0) un_hh, sum(l.custo) / nullif(sum(l.homem_horas), 0) rs_h
                  from lotes l group by 1, 2),
  base as (
    select p.sku, pr.nome, p.peso_nominal_kg, p.mistura_insumo_id is not null mist, p.farinha_id, fi.nome farinha_nome,
           p.consumo_padrao_kg, p.mistura_un_kg, p.mistura_farinha_kg,
           coalesce(s.fonte_materia, 'medido') fonte_materia, s.kg_un_manual,
           coalesce(s.preco_kg_fonte, 'ultima_entrada') preco_kg_fonte, s.preco_kg_manual,
           s.preco_mistura_un_manual, s.embalagem_rs_un_manual, s.etiqueta_rs_un_manual,
           coalesce(s.fonte_mod, 'medido') fonte_mod, s.mod_rs_hora_manual, s.un_homem_hora_manual, s.mod_rs_un_manual,
           coalesce(s.premio_rs_lote, 50) premio_rs_lote, s.un_por_lote un_por_lote_manual, coalesce(s.cif_rs_un, 0) cif_rs_un,
           mm.kg_un_medido, mm.bags, coalesce(mm.amostra_ok, false) amostra_ok,
           pk.custo_referencia pk_ref, pk.ultima_custo pk_ult, pk.media_90d pk_med,
           mi.nome mistura_nome, coalesce(nullif(pm.custo, 0), mi.custo_referencia) mistura_custo,
           em.nome embalagem_nome, em.custo_referencia embalagem_ref,
           case when em.precisa_etiqueta then et.custo_referencia else 0 end etiqueta_ref,
           ms.n mod_n, ms.un mod_un, ms.rs_un ms_rs_un, ms.un_hh ms_un_hh, ms.rs_h ms_rs_h,
           mg.rs_un mg_rs_un, mg.un_hh mg_un_hh, mg.rs_h mg_rs_h
      from producao_parametros p
      left join produtos pr on pr.sku = p.sku
      left join custo_cenario_sku s on s.cenario_id = c.id and s.sku = p.sku
      left join producao_insumo fi on fi.id = p.farinha_id
      left join view_custo_materia_medida mm on mm.insumo_id = p.farinha_id and mm.peso_nominal_kg = p.peso_nominal_kg
      left join view_custo_preco_kg pk on pk.insumo_id = p.farinha_id
      left join producao_insumo mi on mi.id = p.mistura_insumo_id
      left join produtos pm on pm.sku = mi.tiny_sku
      left join producao_insumo em on em.id = p.embalagem_padrao_id
      left join producao_insumo et on et.id = em.etiqueta_id
      left join mod_sku ms on ms.sku = p.sku and ms.n >= 2 and ms.un >= 200
      left join mod_grupo mg on mg.mistura = (p.mistura_insumo_id is not null) and mg.gpeso = case when p.mistura_insumo_id is not null then 0 else p.peso_nominal_kg end
     where p.ativo
  ), k as (
    select b.*,
           case when b.fonte_materia = 'manual' and b.kg_un_manual > 0 then b.kg_un_manual
                when b.fonte_materia = 'medido' and b.amostra_ok then b.kg_un_medido
                else b.consumo_padrao_kg end kg,
           case when b.fonte_materia = 'manual' and b.kg_un_manual > 0 then 'manual'
                when b.fonte_materia = 'medido' and b.amostra_ok then 'medido'
                when b.fonte_materia = 'medido' then 'padrao_sem_medida'
                else 'padrao' end kg_fonte,
           case b.preco_kg_fonte when 'manual' then coalesce(b.preco_kg_manual, b.pk_ult, b.pk_ref)
                                 when 'referencia' then b.pk_ref
                                 when 'media_90d' then coalesce(b.pk_med, b.pk_ult, b.pk_ref)
                                 else coalesce(b.pk_ult, b.pk_ref) end pkg,
           case when b.mist then b.mistura_farinha_kg / nullif(b.mistura_farinha_kg + b.mistura_un_kg, 0) else 1 end frac
      from base b
  ), m as (
    select k.*,
           k.kg * k.frac kg_far,
           case when k.mist then (k.kg - k.kg * k.frac) / nullif(k.mistura_un_kg, 0) else 0 end un_mist,
           coalesce(k.preco_mistura_un_manual, k.mistura_custo, 0) pmist,
           coalesce(k.embalagem_rs_un_manual, k.embalagem_ref, 0) emb,
           coalesce(k.etiqueta_rs_un_manual, k.etiqueta_ref, 0) etq,
           case k.fonte_mod
             when 'manual_un' then k.mod_rs_un_manual
             when 'manual_hora' then k.mod_rs_hora_manual / nullif(k.un_homem_hora_manual, 0)
             else coalesce(k.ms_rs_un, k.mg_rs_un) end modv,
           case k.fonte_mod
             when 'manual_un' then 'manual_un' when 'manual_hora' then 'manual_hora'
             else case when k.ms_rs_un is not null then 'sku'
                       when k.mg_rs_un is not null then case when k.mist then 'agregado_misturas' else 'agregado_mandioca_pura' end
                       else 'sem_medida' end end mod_f,
           case when k.fonte_mod = 'manual_hora' then k.un_homem_hora_manual else coalesce(k.ms_un_hh, k.mg_un_hh) end m_unhh,
           case when k.fonte_mod = 'manual_hora' then k.mod_rs_hora_manual else coalesce(k.ms_rs_h, k.mg_rs_h) end m_rsh
      from k
  ), f as (
    select m.*,
           m.kg_far * m.pkg + m.un_mist * m.pmist mat,
           coalesce(m.un_por_lote_manual, 1000 / nullif(m.kg_far, 0)) upl,
           -- custo da matéria com o consumo PADRÃO e com o MEDIDO (mesmo preço do kg), para comparar
           m.consumo_padrao_kg * m.frac * m.pkg + case when m.mist then (m.consumo_padrao_kg - m.consumo_padrao_kg * m.frac) / nullif(m.mistura_un_kg, 0) * m.pmist else 0 end mat_pad,
           case when m.kg_un_medido is not null then
             m.kg_un_medido * m.frac * m.pkg + case when m.mist then (m.kg_un_medido - m.kg_un_medido * m.frac) / nullif(m.mistura_un_kg, 0) * m.pmist else 0 end end mat_med
      from m
  )
  select f.sku, f.nome, f.peso_nominal_kg, f.mist, f.farinha_id, f.farinha_nome,
         round(f.kg, 4), f.kg_fonte, f.consumo_padrao_kg, f.kg_un_medido, f.bags,
         round(f.pkg, 4), f.preco_kg_fonte, f.pk_ref, f.pk_ult, round(f.pk_med, 4),
         round(f.kg_far, 4), f.mistura_nome, round(f.un_mist, 4), round(f.pmist, 4),
         round(f.mat, 4), f.embalagem_nome, round(f.emb, 4), round(f.etq, 4),
         round(f.modv, 4), f.mod_f, round(f.m_unhh, 1), round(f.m_rsh, 2),
         round(f.upl, 1), round(f.premio_rs_lote / nullif(f.upl, 0), 4), round(f.cif_rs_un, 4),
         round(f.mat + f.emb + f.etq + coalesce(f.modv, 0) + coalesce(f.premio_rs_lote / nullif(f.upl, 0), 0) + f.cif_rs_un, 4),
         round(f.mat_pad + f.emb + f.etq + coalesce(f.modv, 0) + coalesce(f.premio_rs_lote / nullif(1000 / nullif(f.consumo_padrao_kg * f.frac, 0), 0), 0) + f.cif_rs_un, 4),
         round(f.mat_med + f.emb + f.etq + coalesce(f.modv, 0) + coalesce(f.premio_rs_lote / nullif(1000 / nullif(f.kg_un_medido * f.frac, 0), 0), 0) + f.cif_rs_un, 4),
         round(f.mat_med - f.mat_pad, 4), round((f.mat_med - f.mat_pad) * c.volume_mes_un, 2),
         coalesce(f.kg_un_medido > f.consumo_padrao_kg * 1.05, false),
         array_remove(array[
           case when f.kg_fonte = 'padrao_sem_medida' then
             case when f.kg_un_medido is null then 'sem big bag fechado desta farinha: usando o consumo padrão'
                  else 'só 1 big bag fechado (amostra insuficiente): usando o consumo padrão' end end,
           case when f.mod_f like 'agregado%' then 'mão de obra do grupo (este produto tem menos de 2 lotes / 200 un limpos)' end,
           case when f.mod_f = 'sem_medida' then 'sem mão de obra medida' end,
           case when f.pk_ult is null and f.preco_kg_fonte = 'ultima_entrada' then 'farinha sem entrada com custo: usando a referência' end,
           case when f.mist and f.preco_mistura_un_manual is null and f.mistura_custo is null then 'componente da mistura sem custo' end
         ], null)
    from f
   order by f.sku;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Preço: P = (cv + fixo) / (1 − comissão − extra − financeiro − imposto − MC)
-- ---------------------------------------------------------------------------
-- faixas do canal: Shopee = shopee_tarifa vigente hoje; demais = uma faixa só
create or replace function public.preco_faixas_canal(p_canal text)
returns table (preco_min numeric, preco_max numeric, comissao numeric, fixo numeric, extra numeric, financeiro numeric, imposto numeric)
language sql stable set search_path = public as $$
  select t.preco_min, t.preco_max, t.pct, t.fixo_unidade, pc.comissao_extra_pct, pc.custo_financeiro_pct, pc.imposto_pct
    from preco_canal pc cross join lateral shopee_tarifa_vigente((now() at time zone 'America/Sao_Paulo')::date) t
   where pc.canal = p_canal and pc.comissao_fonte = 'shopee_tarifa'
  union all
  select 0, null, pc.comissao_pct, pc.tarifa_fixa, pc.comissao_extra_pct, pc.custo_financeiro_pct, pc.imposto_pct
    from preco_canal pc where pc.canal = p_canal and coalesce(pc.comissao_fonte, '') <> 'shopee_tarifa'
$$;

-- preço para uma MC (null = piso, MC 0): a faixa cujo intervalo contém o preço calculado; senão a 1ª (fora_faixa)
create or replace function public.preco_para_mc(p_canal text, p_cv numeric, p_mc numeric, p_imposto numeric)
returns table (preco numeric, comissao numeric, fixo numeric, fora_faixa boolean)
language sql stable set search_path = public as $$
  with f as (
    select x.*, (p_cv + x.fixo) / nullif(1 - x.comissao - x.extra - x.financeiro - coalesce(x.imposto, p_imposto) - coalesce(p_mc, 0), 0) p
      from preco_faixas_canal(p_canal) x
  )
  select * from (
    select round(f.p, 2), f.comissao, f.fixo, false from f
     where f.p > 0 and f.p >= f.preco_min and (f.preco_max is null or f.p <= f.preco_max + 0.005)
     order by f.p limit 1) ok
  union all
  select round(f.p, 2), f.comissao, f.fixo, true from (select * from f order by f.preco_min limit 1) f
   where not exists (select 1 from f where f.p > 0 and f.p >= f.preco_min and (f.preco_max is null or f.p <= f.preco_max + 0.005))
$$;

-- MC de um preço praticado (faixa = a que contém o preço)
create or replace function public.preco_mc_reversa(p_canal text, p_cv numeric, p_preco numeric, p_imposto numeric)
returns numeric language sql stable set search_path = public as $$
  select round((p_preco * (1 - x.comissao - x.extra - x.financeiro - coalesce(x.imposto, p_imposto)) - x.fixo - p_cv) / nullif(p_preco, 0), 4)
    from preco_faixas_canal(p_canal) x
   where p_preco >= x.preco_min and (x.preco_max is null or p_preco <= x.preco_max + 0.005)
   order by x.preco_min desc limit 1
$$;

-- matriz: SKU × canal ativo × margens-alvo, piso e praticado
create or replace function public.preco_cenario_matriz(p_cenario bigint)
returns table (sku text, nome text, cv numeric, canal text, canal_nome text, tipo text, ordem smallint, imposto numeric,
               piso numeric, precos jsonb, praticado numeric, praticado_origem text, praticado_em date, mc_praticado numeric,
               abaixo_alvo boolean, abaixo_piso boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_imp numeric;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  select cc.imposto_pct into v_imp from custo_cenario cc where cc.id = p_cenario;
  return query
  with cs as (select x.sku, x.nome, x.cv from custo_cenario_calcular(p_cenario) x),
  pc as (select * from preco_canal pcx where pcx.ativo),
  ma as (select mx.mc_pct from preco_margem_alvo mx where mx.ativo),
  prat as (
    select distinct on (pp.sku, pp.canal) pp.sku, pp.canal, pp.preco, pp.origem, pp.vigencia
      from preco_praticado pp order by pp.sku, pp.canal, pp.vigencia desc, pp.id desc
  ),
  shopee_auto as (   -- menor preço ativo nos anúncios Shopee (se não houver praticado manual)
    select v.sku, min(v.preco) preco from shopee_anuncios_variacao v join shopee_anuncios a on a.item_id = v.item_id
     where a.status = 'NORMAL' and v.preco > 0 group by v.sku
    union all
    select a.sku_pai, min(a.preco_min) from shopee_anuncios a
     where a.status = 'NORMAL' and not coalesce(a.tem_variacao, false) and a.preco_min > 0 group by a.sku_pai
  )
  select cs.sku, cs.nome, cs.cv, pc.canal, pc.nome_exibicao, pc.tipo, pc.ordem, coalesce(pc.imposto_pct, v_imp),
         pis.preco,
         (select jsonb_agg(jsonb_build_object('mc', ma.mc_pct, 'preco', q.preco, 'comissao', q.comissao, 'fixo', q.fixo, 'fora_faixa', q.fora_faixa) order by ma.mc_pct)
            from ma cross join lateral preco_para_mc(pc.canal, cs.cv, ma.mc_pct, v_imp) q),
         pr.preco, pr.origem, pr.dia,
         case when pr.preco is not null then preco_mc_reversa(pc.canal, cs.cv, pr.preco, v_imp) end,
         case when pr.preco is not null then preco_mc_reversa(pc.canal, cs.cv, pr.preco, v_imp) < (select min(m2.mc_pct) from ma m2) end,
         case when pr.preco is not null then pr.preco < pis.preco end
    from cs cross join pc
    left join lateral preco_para_mc(pc.canal, cs.cv, null, v_imp) pis on true
    left join lateral (
      select p1.preco, p1.origem, p1.vigencia dia from prat p1 where p1.sku = cs.sku and p1.canal = pc.canal
      union all
      select min(sa.preco), 'shopee_anuncios', null::date from shopee_auto sa
       where pc.canal = 'shopee' and sa.sku = cs.sku
         and not exists (select 1 from prat p2 where p2.sku = cs.sku and p2.canal = 'shopee')
      having min(sa.preco) is not null
      limit 1
    ) pr on true
   order by cs.sku, pc.ordem;
end $$;

-- tabela de atacado (Loja / 7 t / 14 t) com a MC escolhida por faixa — o que vai ao representante
create or replace function public.preco_tabela_atacado(p_cenario bigint, p_mc jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_imp numeric; v jsonb;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  select imposto_pct into v_imp from custo_cenario where id = p_cenario;
  select jsonb_build_object(
    'faixas', (select jsonb_agg(jsonb_build_object('canal', pc.canal, 'nome', pc.nome_exibicao, 'condicao', pc.condicao_padrao,
                 'mc', coalesce((p_mc ->> pc.canal)::numeric, pc.mc_publicacao, 0.25), 'financeiro', pc.custo_financeiro_pct,
                 'imposto', coalesce(pc.imposto_pct, v_imp)) order by pc.ordem)
                 from preco_canal pc where pc.ativo and pc.tipo = 'atacado'),
    'itens', (select jsonb_agg(jsonb_build_object('sku', x.sku, 'nome', x.nome, 'cv', round(x.cv, 2), 'faixas', (
                 select jsonb_object_agg(pc.canal, jsonb_build_object(
                          'preco', (select q.preco from preco_para_mc(pc.canal, x.cv, coalesce((p_mc ->> pc.canal)::numeric, pc.mc_publicacao, 0.25), v_imp) q),
                          'piso', (select q.preco from preco_para_mc(pc.canal, x.cv, null, v_imp) q)))
                   from preco_canal pc where pc.ativo and pc.tipo = 'atacado')) order by x.sku)
                from custo_cenario_calcular(p_cenario) x where x.cv > 0)
  ) into v;
  return v;
end $$;

create or replace function public.preco_publicar_tabela(p_cenario bigint, p_nome text, p_mc jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_snap jsonb; v_cen text; v_quem text;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  select nome into v_cen from custo_cenario where id = p_cenario;
  if v_cen is null then raise exception 'cenário % não existe', p_cenario; end if;
  v_snap := preco_tabela_atacado(p_cenario, p_mc) || jsonb_build_object('cenario', v_cen, 'gerado_em', now());
  select nome into v_quem from perfis_usuario where user_id = auth.uid();
  insert into preco_tabela_publicada (cenario_id, nome, mc, snapshot, publicado_por_nome)
  values (p_cenario, coalesce(nullif(trim(p_nome), ''), 'Tabela de atacado ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY')),
          (select jsonb_object_agg(f ->> 'canal', (f ->> 'mc')::numeric) from jsonb_array_elements(v_snap -> 'faixas') f),
          v_snap, v_quem)
  returning id into v_id;
  return v_id;
end $$;

-- duplicar cenário (com os ajustes por SKU)
create or replace function public.custo_cenario_duplicar(p_cenario bigint, p_nome text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  insert into custo_cenario (nome, descricao, padrao, fator_encargos, horas_mes_mensalista, horas_dia_diarista, imposto_pct, volume_mes_un)
  select p_nome, descricao, false, fator_encargos, horas_mes_mensalista, horas_dia_diarista, imposto_pct, volume_mes_un
    from custo_cenario where id = p_cenario returning id into v_id;
  insert into custo_cenario_sku select v_id, sku, fonte_materia, kg_un_manual, preco_kg_fonte, preco_kg_manual, preco_mistura_un_manual,
         embalagem_rs_un_manual, etiqueta_rs_un_manual, fonte_mod, mod_rs_hora_manual, un_homem_hora_manual, mod_rs_un_manual,
         premio_rs_lote, un_por_lote, cif_rs_un, observacao, now()
    from custo_cenario_sku where cenario_id = p_cenario;
  return v_id;
end $$;

revoke all on function public.custo_mod_lotes(numeric, numeric, numeric), public.custo_cenario_calcular(bigint),
  public.preco_faixas_canal(text), public.preco_para_mc(text, numeric, numeric, numeric), public.preco_mc_reversa(text, numeric, numeric, numeric),
  public.preco_cenario_matriz(bigint), public.preco_tabela_atacado(bigint, jsonb), public.preco_publicar_tabela(bigint, text, jsonb),
  public.custo_cenario_duplicar(bigint, text) from public, anon;
grant execute on function public.custo_mod_lotes(numeric, numeric, numeric), public.custo_cenario_calcular(bigint),
  public.preco_faixas_canal(text), public.preco_para_mc(text, numeric, numeric, numeric), public.preco_mc_reversa(text, numeric, numeric, numeric),
  public.preco_cenario_matriz(bigint), public.preco_tabela_atacado(bigint, jsonb), public.preco_publicar_tabela(bigint, text, jsonb),
  public.custo_cenario_duplicar(bigint, text) to authenticated;
revoke all on public.view_custo_preco_kg, public.view_custo_materia_bags, public.view_custo_materia_medida, public.view_custo_mod_lote,
  public.view_custo_mod_medida, public.view_custo_mod_dotacao, public.view_producao_apontamento_suspeito from anon, public;
grant select on public.view_custo_preco_kg, public.view_custo_materia_bags, public.view_custo_materia_medida, public.view_custo_mod_lote,
  public.view_custo_mod_medida, public.view_custo_mod_dotacao, public.view_producao_apontamento_suspeito to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Seed (09/nov/2026)
-- ---------------------------------------------------------------------------
insert into public.custo_cenario (nome, descricao, padrao)
select 'Medido nov/26', 'Consumo pelo fechamento dos big bags, farinha pela última entrada, MOD medida dos lotes limpos.', true
 where not exists (select 1 from public.custo_cenario);

insert into public.custo_cenario_sku (cenario_id, sku)
select c.id, p.sku from public.custo_cenario c cross join public.producao_parametros p
 where c.padrao and p.ativo on conflict do nothing;

insert into public.preco_canal (canal, tipo, nome_exibicao, comissao_fonte, comissao_pct, tarifa_fixa, custo_financeiro_pct, condicao_padrao, mc_publicacao, ativo, ordem) values
  ('shopee',        'marketplace', 'Shopee',          'shopee_tarifa', 0,    0, 0,      'faixas da Shopee (shopee_tarifa)', null,  true,  1),
  ('mercado_livre', 'marketplace', 'Mercado Livre',   null,            0.17, 0, 0,      'confirmar comissão e tarifa',      null,  true,  2),
  ('amazon',        'marketplace', 'Amazon',          null,            0.15, 0, 0,      'confirmar comissão',               null,  true,  3),
  ('tiktok',        'marketplace', 'TikTok Shop',     null,            0.35, 0, 0,      'taxa efetiva medida ~35% (confirmar)', null, false, 4),
  ('atacado_loja',  'atacado',     'Atacado · Loja',  null,            0,    0, 0.0387, 'boleto 3x 30/60/90',               0.283, true,  5),
  ('atacado_7t',    'atacado',     'Atacado · 7 t',   null,            0,    0, 0.0205, '30% entrada + 30/60',              0.257, true,  6),
  ('atacado_14t',   'atacado',     'Atacado · 14 t',  null,            0,    0, 0.0205, '30% entrada + 30/60',              0.228, true,  7)
on conflict (canal) do nothing;

insert into public.preco_margem_alvo (mc_pct, ordem) values (0.20, 1), (0.25, 2), (0.283, 3), (0.30, 4), (0.35, 5)
on conflict (mc_pct) do nothing;

-- preços de atacado praticados (Bumi saco transparente; 15984 = saco impresso Gesoplast)
insert into public.preco_praticado (sku, canal, preco, origem, obs)
select s.sku, v.canal, v.preco, 'tabela_atacado', 'seed do briefing 09/nov'
  from (values ('15984T'), ('16581'), ('16678'), ('16746')) s(sku)
 cross join (values ('atacado_loja', 20.90), ('atacado_7t', 19.40), ('atacado_14t', 18.50)) v(canal, preco)
 where not exists (select 1 from public.preco_praticado)
union all
select '15984', v.canal, v.preco, 'tabela_atacado', 'seed do briefing 09/nov (Roxa)'
  from (values ('atacado_loja', 25.90), ('atacado_7t', 24.10), ('atacado_14t', 22.90)) v(canal, preco)
 where not exists (select 1 from public.preco_praticado);

-- ---------------------------------------------------------------------------
-- 6. Correções de base (item 9 do briefing) — antes: saco 0,40 / etiqueta 0,40
-- ---------------------------------------------------------------------------
update public.producao_insumo set custo_referencia = 0.4377 where id = 5 and custo_referencia = 0.4000;
update public.producao_insumo set custo_referencia = 0.0200 where id = 3 and custo_referencia = 0.4000;
update public.producao_parametros p set custo_insumo_kg = i.custo_referencia
  from public.producao_insumo i where i.id = p.farinha_id and p.custo_insumo_kg is distinct from i.custo_referencia;

-- ============================================================================
-- ROLLBACK
-- drop function if exists public.custo_cenario_duplicar(bigint, text), public.preco_publicar_tabela(bigint, text, jsonb),
--   public.preco_tabela_atacado(bigint, jsonb), public.preco_cenario_matriz(bigint), public.preco_mc_reversa(text, numeric, numeric, numeric),
--   public.preco_para_mc(text, numeric, numeric, numeric), public.preco_faixas_canal(text), public.custo_cenario_calcular(bigint);
-- drop view if exists public.view_producao_apontamento_suspeito, public.view_custo_mod_dotacao, public.view_custo_mod_medida,
--   public.view_custo_mod_lote, public.view_custo_materia_medida, public.view_custo_materia_bags, public.view_custo_preco_kg;
-- drop function if exists public.custo_mod_lotes(numeric, numeric, numeric);
-- drop table if exists public.preco_tabela_publicada, public.preco_praticado, public.preco_margem_alvo, public.preco_canal,
--   public.custo_cenario_sku, public.custo_cenario;
-- drop function if exists public.custo_cenario_um_padrao(), public.preco_tabela_imutavel();
-- update public.producao_insumo set custo_referencia = 0.40 where id in (3, 5);
-- update public.producao_parametros set custo_insumo_kg = 2.5480 where sku in ('15933','16746');
-- update public.producao_parametros set custo_insumo_kg = 3.4100 where sku = '16054';
-- ============================================================================
