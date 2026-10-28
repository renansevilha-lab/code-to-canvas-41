-- Módulo de Produção — MVP (27/out/2026, APLICADO como migração `producao_mvp` em 28/out ~00h BRT)
-- Decisões do dono: 1 lote = 1 big bag; cada SKU usa uma farinha própria (a NF 19532 trouxe as duas farinhas
-- com o mesmo código do fornecedor — cada big bag é classificado na entrada); etiquetagem na hora, só quando a
-- embalagem precisa; fardos de 2, 3 ou 5 sacos; pessoas = Vinicius, Nikolas, Tânia, Kevin; saco transparente
-- R$ 0,70 + etiqueta R$ 0,40; ENTRADA de matérias-primas na própria Produção (farinha, sacos e etiquetas).
-- Fora deste SQL (em decisão): integração com o Tiny, custo médio no Tiny, regra de pesagem.
-- Rollback no fim do arquivo.

begin;

-- ── Configuração da planta (uma linha): MOD e CIF rateados pela capacidade normal (CPC 16)
create table public.producao_config (
  id                   int primary key default 1 check (id = 1),
  mod_mensal           numeric(12,2) not null,
  cif_mensal           numeric(12,2) not null,
  capacidade_normal_un int not null check (capacidade_normal_un > 0),
  custo_conversao_un   numeric(10,4) generated always as
                         (round((mod_mensal + cif_mensal) / capacidade_normal_un, 4)) stored,
  updated_at           timestamptz not null default now(),
  updated_by           uuid default auth.uid()
);

-- ── Matérias-primas: farinha (kg), embalagem e etiqueta (un)
create table public.producao_insumo (
  id               bigserial primary key,
  nome             text not null unique,
  tipo             text not null check (tipo in ('farinha','embalagem','etiqueta','outro')),
  unidade          text not null check (unidade in ('kg','un')),
  ncm              text,
  custo_referencia numeric(10,4),                       -- custo padrão (o real vem das entradas)
  precisa_etiqueta boolean not null default false,      -- só embalagem
  etiqueta_id      bigint references public.producao_insumo(id),  -- etiqueta usada nesta embalagem
  ativo            boolean not null default true,
  criado_em        timestamptz not null default now()
);

-- ── Ficha técnica por SKU acabado
create table public.producao_parametros (
  sku                 text primary key references public.produtos(sku),
  farinha_id          bigint references public.producao_insumo(id),
  embalagem_padrao_id bigint references public.producao_insumo(id),
  prefixo_lote        text not null unique,          -- BUMIM4 / BUMIG4 (vai na datadora)
  peso_nominal_kg     numeric(8,3) not null,
  sobrepeso_pct       numeric(6,4) not null default 0.005,
  perda_pct           numeric(6,4) not null default 0.02 check (perda_pct >= 0 and perda_pct < 1),
  consumo_padrao_kg   numeric(10,4) generated always as
                        (round(peso_nominal_kg * (1 + sobrepeso_pct) / (1 - perda_pct), 4)) stored,
  tolerancia_g        int not null,                   -- T do Inmetro
  custo_insumo_kg     numeric(10,4) not null,
  ncm_acabado         text,                           -- a definir com o contador
  pesar_cada          int check (pesar_cada is null or pesar_cada > 0),   -- null = pesa todo saco
  pesar_primeiros     int not null default 5,
  meta_estoque_un     int,
  ativo               boolean not null default true,
  updated_at          timestamptz not null default now(),
  updated_by          uuid default auth.uid()
);

-- ── Pessoas que podem aparecer nas etapas
create table public.producao_equipe (
  pessoa_id text primary key references public.equipe_membros(id),
  ativo     boolean not null default true
);

-- ── Entradas de matéria-prima. Farinha = UMA linha por big bag (é o lote rastreável);
--    saco/etiqueta = uma linha por recebimento. Saldo = entrada − consumo (view), nunca digitado.
create sequence public.producao_entrada_codigo_seq;
create table public.producao_entrada (
  id                   bigserial primary key,
  codigo               text not null unique            -- LOTUS-19532-01 (big bag) ou ENT-00001 (automático)
                         default ('ENT-' || lpad(nextval('public.producao_entrada_codigo_seq')::text, 5, '0')),
  insumo_id            bigint references public.producao_insumo(id),   -- null = farinha ainda a classificar
  fornecedor_nome      text,
  fornecedor_cnpj      text,
  nf_numero            text,
  nf_serie             text,
  nf_chave             text,
  nf_emissao           date,
  nf_item_codigo       text,
  ncm                  text,
  cfop                 text,
  cst_icms             text,
  cst_pis_cofins       text,
  recebido_em          date not null default (now() at time zone 'America/Sao_Paulo')::date,
  quantidade           numeric(12,3) not null check (quantidade > 0),   -- kg ou un, conforme o insumo
  custo_un             numeric(10,4) not null,         -- R$ por kg ou por unidade
  densidade_aparente   numeric(6,3),                   -- só farinha; pendência
  compra_ordem_tiny_id bigint,                         -- ordem da entrada por NF em /compras, se houver
  obs                  text,
  criado_em            timestamptz not null default now(),
  criado_por           uuid default auth.uid()
);
create index on public.producao_entrada (insumo_id);

-- ── Ordem de produção = lote de produção = um big bag
create table public.producao_ordem (
  id                bigserial primary key,
  codigo            text not null unique,              -- BUMIM4-20261027-01
  sku               text not null references public.producao_parametros(sku),
  entrada_id        bigint not null references public.producao_entrada(id),   -- o big bag
  embalagem_id      bigint references public.producao_insumo(id),
  data              date not null default (now() at time zone 'America/Sao_Paulo')::date,
  turno             text,
  qtd_planejada     int,
  status            text not null default 'aberta' check (status in ('aberta','encerrada','cancelada')),
  inicio_em         timestamptz not null default now(),
  fim_em            timestamptz,
  qtd_boa_final     int,
  refugo_final      int,
  embalagens_usadas int,
  etiquetas_usadas  int,
  sobra_kg          numeric(10,3),
  tiny_lancado_em   timestamptz,
  tiny_lancado_por  text,
  tiny_resultado    jsonb,
  obs               text,
  criado_por        uuid default auth.uid(),
  criado_em         timestamptz not null default now()
);
create unique index producao_ordem_bag_aberta on public.producao_ordem (entrada_id) where status = 'aberta';
create index producao_ordem_data on public.producao_ordem (data desc);

-- ── Quem está em cada etapa (troca de pessoa = fecha a linha e abre outra)
create table public.producao_etapa (
  id        bigserial primary key,
  ordem_id  bigint not null references public.producao_ordem(id) on delete cascade,
  etapa     text not null check (etapa in ('etiquetagem','envase','selagem','fardos')),
  pessoa_id text not null references public.equipe_membros(id),
  inicio_em timestamptz not null default now(),
  fim_em    timestamptz
);
create index on public.producao_etapa (ordem_id);

-- ── Contagem do envase (+1, +10; negativo = desfazer)
create table public.producao_contagem (
  id        bigserial primary key,
  ordem_id  bigint not null references public.producao_ordem(id) on delete cascade,
  qtd       int not null check (qtd <> 0 and qtd between -10 and 50),
  pessoa_id text references public.equipe_membros(id),
  em        timestamptz not null default now()
);
create index on public.producao_contagem (ordem_id);

-- ── Pesagens (gramas)
create table public.producao_pesagem (
  id        bigserial primary key,
  ordem_id  bigint not null references public.producao_ordem(id) on delete cascade,
  peso_g    int not null check (peso_g between 100 and 20000),
  pessoa_id text references public.equipe_membros(id),
  em        timestamptz not null default now()
);
create index on public.producao_pesagem (ordem_id);

-- ── Refugos
create table public.producao_refugo (
  id        bigserial primary key,
  ordem_id  bigint not null references public.producao_ordem(id) on delete cascade,
  etapa     text check (etapa in ('etiquetagem','envase','selagem','fardos')),
  motivo    text not null check (motivo in ('solda','peso','embalagem_danificada','sujidade','etiqueta','outro')),
  qtd       int not null check (qtd > 0),
  pessoa_id text references public.equipe_membros(id),
  em        timestamptz not null default now()
);
create index on public.producao_refugo (ordem_id);

-- ── Paradas (uma aberta por lote)
create table public.producao_parada (
  id        bigserial primary key,
  ordem_id  bigint not null references public.producao_ordem(id) on delete cascade,
  motivo    text not null check (motivo in ('troca_big_bag','limpeza','manutencao','falta_embalagem','ajuste_dosagem','outro')),
  inicio_em timestamptz not null default now(),
  fim_em    timestamptz,
  pessoa_id text references public.equipe_membros(id)
);
create index on public.producao_parada (ordem_id);
create unique index producao_parada_aberta on public.producao_parada (ordem_id) where fim_em is null;

-- ── Fardos (2, 3 ou 5 sacos, conforme o dia)
create table public.producao_fardo (
  id              bigserial primary key,
  ordem_id        bigint not null references public.producao_ordem(id) on delete cascade,
  sacos_por_fardo int not null check (sacos_por_fardo between 1 and 12),
  qtd_fardos      int not null check (qtd_fardos <> 0),     -- negativo = desfazer
  pessoa_id       text references public.equipe_membros(id),
  em              timestamptz not null default now()
);
create index on public.producao_fardo (ordem_id);

-- ── Consumo valorizado, gravado no encerramento: farinha pelo big bag (entrada_id);
--    saco e etiqueta pelo insumo, ao custo médio das entradas
create table public.producao_consumo (
  id         bigserial primary key,
  ordem_id   bigint not null references public.producao_ordem(id) on delete cascade,
  insumo_id  bigint not null references public.producao_insumo(id),
  entrada_id bigint references public.producao_entrada(id),
  quantidade numeric(12,3) not null check (quantidade >= 0),
  custo_un   numeric(10,4) not null,
  custo      numeric(12,2) generated always as (round(quantidade * custo_un, 2)) stored,
  em         timestamptz not null default now()
);
create index on public.producao_consumo (insumo_id);
create index on public.producao_consumo (entrada_id);

create trigger producao_config_upd before update on public.producao_config
  for each row execute function public.ia_set_updated_at();
create trigger producao_parametros_upd before update on public.producao_parametros
  for each row execute function public.ia_set_updated_at();

-- ── View: estoque de matéria-prima por insumo (saldo e custo médio)
create view public.view_producao_estoque with (security_invoker = true) as
select i.id as insumo_id, i.nome, i.tipo, i.unidade, i.custo_referencia,
       coalesce(e.qtd, 0) as entradas, coalesce(c.qtd, 0) as consumido,
       coalesce(e.qtd, 0) - coalesce(c.qtd, 0) as saldo,
       round(e.valor / nullif(e.qtd, 0), 4) as custo_medio,
       e.ultima_entrada
from public.producao_insumo i
left join lateral (select sum(quantidade) qtd, sum(quantidade * custo_un) valor, max(recebido_em) ultima_entrada
                   from public.producao_entrada where insumo_id = i.id) e on true
left join lateral (select sum(quantidade) qtd from public.producao_consumo where insumo_id = i.id) c on true
where i.ativo;

-- ── View: big bags (entradas de farinha) com saldo
create view public.view_producao_big_bag with (security_invoker = true) as
select b.id, b.codigo, b.insumo_id, i.nome as insumo, (b.insumo_id is null) as a_classificar,
       b.fornecedor_nome, b.nf_numero, b.nf_serie, b.nf_chave, b.nf_emissao, b.recebido_em,
       b.quantidade as qtd_inicial_kg, b.custo_un as custo_kg, b.densidade_aparente,
       (b.densidade_aparente is null) as densidade_pendente,
       coalesce(c.kg, 0) as consumido_kg,
       b.quantidade - coalesce(c.kg, 0) as saldo_kg,
       o.codigo as lote_aberto,
       par.sku, par.consumo_padrao_kg,
       floor((b.quantidade - coalesce(c.kg, 0)) / nullif(par.consumo_padrao_kg, 0))::int as sacos_possiveis
from public.producao_entrada b
left join public.producao_insumo i on i.id = b.insumo_id
left join lateral (select sum(quantidade) kg from public.producao_consumo where entrada_id = b.id) c on true
left join lateral (select codigo from public.producao_ordem where entrada_id = b.id and status = 'aberta' limit 1) o on true
left join lateral (select sku, consumo_padrao_kg from public.producao_parametros
                   where farinha_id = b.insumo_id and ativo order by sku limit 1) par on true
where b.insumo_id is null or i.tipo = 'farinha';

-- ── View: lote ao vivo e fechamento
create view public.view_producao_lote with (security_invoker = true) as
select o.id, o.codigo, o.sku, pr.nome as produto, o.status, o.data, o.turno, o.qtd_planejada,
       o.inicio_em, o.fim_em, b.codigo as big_bag, b.nf_numero, e.nome as embalagem, e.precisa_etiqueta,
       cnt.envasados,
       coalesce(rf.refugo, 0) as refugo,
       coalesce(o.qtd_boa_final, cnt.envasados - coalesce(rf.refugo, 0)) as boas,
       coalesce(fd.sacos_em_fardo, 0) as sacos_em_fardo,
       fd.fardos,
       p.peso_nominal_kg * 1000 as nominal_g, p.tolerancia_g, p.pesar_cada, p.pesar_primeiros,
       ps.n as pesagens, ps.media_g, ps.desvio_g, ps.min_g, ps.max_g, ps.abaixo_t, ps.ultima_em as ultima_pesagem_em,
       case when ps.n = 0 then null
            when ps.media_g < p.peso_nominal_kg * 1000 then 'abaixo_nominal'
            when ps.media_g < p.peso_nominal_kg * 1000 * (1 + p.sobrepeso_pct / 2) then 'atencao'
            else 'ok' end as alerta_peso,
       round(extract(epoch from (coalesce(o.fim_em, now()) - o.inicio_em)) / 60) as minutos_total,
       coalesce(pa.minutos, 0) as minutos_parados,
       (pa.aberta is not null) as parado_agora, pa.aberta as parada_motivo,
       round(cnt.envasados / nullif((extract(epoch from (coalesce(o.fim_em, now()) - o.inicio_em)) / 60
                                     - coalesce(pa.minutos, 0)) / 60, 0), 1) as un_hora,
       et.pessoas,
       p.consumo_padrao_kg,
       round(coalesce(o.qtd_boa_final, cnt.envasados - coalesce(rf.refugo, 0)) * p.consumo_padrao_kg, 3) as consumo_padrao_total_kg,
       cs.farinha_kg as consumo_real_kg,
       cs.farinha_kg - round(coalesce(o.qtd_boa_final, cnt.envasados - coalesce(rf.refugo, 0)) * p.consumo_padrao_kg, 3) as variacao_kg,
       -- padrão: farinha + saco + (etiqueta se a embalagem pede) + conversão
       round(p.consumo_padrao_kg * p.custo_insumo_kg + coalesce(e.custo_referencia, 0)
             + case when e.precisa_etiqueta then coalesce(et_i.custo_referencia, 0) else 0 end
             + cfg.custo_conversao_un, 4) as custo_padrao_un,
       case when o.status = 'encerrada' and coalesce(o.qtd_boa_final, 0) > 0 then
         round(coalesce(cs.custo, 0) / o.qtd_boa_final + cfg.custo_conversao_un, 4) end as custo_real_un,
       o.sobra_kg, o.embalagens_usadas, o.etiquetas_usadas, o.tiny_lancado_em
from public.producao_ordem o
join public.producao_parametros p on p.sku = o.sku
join public.producao_entrada b on b.id = o.entrada_id
left join public.produtos pr on pr.sku = o.sku
left join public.producao_insumo e on e.id = o.embalagem_id
left join public.producao_insumo et_i on et_i.id = e.etiqueta_id
cross join public.producao_config cfg
left join lateral (select coalesce(sum(qtd), 0)::int envasados from public.producao_contagem where ordem_id = o.id) cnt on true
left join lateral (select sum(qtd)::int refugo from public.producao_refugo where ordem_id = o.id) rf on true
left join lateral (select sum(sacos_por_fardo * n)::int sacos_em_fardo,
                          jsonb_object_agg(sacos_por_fardo, n) fardos
                   from (select sacos_por_fardo, sum(qtd_fardos) n from public.producao_fardo
                         where ordem_id = o.id group by 1) f) fd on true
left join lateral (select count(*)::int n, round(avg(peso_g), 1) media_g, round(stddev_samp(peso_g), 1) desvio_g,
                          min(peso_g) min_g, max(peso_g) max_g,
                          count(*) filter (where peso_g < p.peso_nominal_kg * 1000 - p.tolerancia_g)::int abaixo_t,
                          max(em) ultima_em
                   from public.producao_pesagem where ordem_id = o.id) ps on true
left join lateral (select round(sum(extract(epoch from (coalesce(fim_em, now()) - inicio_em))) / 60) minutos,
                          max(motivo) filter (where fim_em is null) aberta
                   from public.producao_parada where ordem_id = o.id) pa on true
left join lateral (select jsonb_object_agg(etapa, pessoa_id) pessoas
                   from public.producao_etapa where ordem_id = o.id and fim_em is null) et on true
left join lateral (select sum(c.quantidade) filter (where i2.tipo = 'farinha') farinha_kg, sum(c.custo) custo
                   from public.producao_consumo c join public.producao_insumo i2 on i2.id = c.insumo_id
                   where c.ordem_id = o.id) cs on true;

-- ── Abrir lote: gera o código (prefixo-AAAAMMDD-NN) e registra quem está em cada etapa
create function public.producao_abrir_lote(
  p_sku text, p_big_bag bigint, p_embalagem bigint default null, p_qtd_planejada int default null,
  p_pessoas jsonb default '{}'::jsonb, p_turno text default null)
returns public.producao_ordem
language plpgsql security invoker set search_path = public as $$
declare
  v_par producao_parametros;
  v_bag view_producao_big_bag;
  v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_n   int;
  v_op  producao_ordem;
  v_emb bigint;
  k text; v text;
begin
  if not tem_modulo('galpao') then raise exception 'sem acesso à produção'; end if;
  select * into v_par from producao_parametros where sku = p_sku and ativo;
  if not found then raise exception 'SKU % sem ficha técnica', p_sku; end if;
  select * into v_bag from view_producao_big_bag where id = p_big_bag;
  if not found then raise exception 'big bag não encontrado'; end if;
  if v_bag.a_classificar then raise exception 'classifique a farinha do big bag % antes de abrir o lote', v_bag.codigo; end if;
  if v_bag.insumo_id is distinct from v_par.farinha_id then raise exception 'o big bag % não é da farinha do SKU %', v_bag.codigo, p_sku; end if;
  if v_bag.lote_aberto is not null then raise exception 'big bag já está no lote %', v_bag.lote_aberto; end if;
  if v_bag.saldo_kg < v_par.consumo_padrao_kg then raise exception 'big bag sem saldo'; end if;
  v_emb := coalesce(p_embalagem, v_par.embalagem_padrao_id);

  perform pg_advisory_xact_lock(hashtext('producao_lote:' || v_par.prefixo_lote || v_dia));
  select count(*) + 1 into v_n from producao_ordem
   where codigo like v_par.prefixo_lote || '-' || to_char(v_dia, 'YYYYMMDD') || '-%';

  insert into producao_ordem (codigo, sku, entrada_id, embalagem_id, data, turno, qtd_planejada)
  values (v_par.prefixo_lote || '-' || to_char(v_dia, 'YYYYMMDD') || '-' || lpad(v_n::text, 2, '0'),
          p_sku, p_big_bag, v_emb, v_dia, p_turno,
          coalesce(p_qtd_planejada, floor(v_bag.saldo_kg / v_par.consumo_padrao_kg)::int))
  returning * into v_op;

  for k, v in select * from jsonb_each_text(p_pessoas) loop
    if v is not null and v <> '' then
      insert into producao_etapa (ordem_id, etapa, pessoa_id) values (v_op.id, k, v);
    end if;
  end loop;
  return v_op;
end $$;

-- ── Encerrar lote: confirma as quantidades e grava o consumo valorizado numa transação só.
--    Farinha = saldo do big bag − sobra (lote = big bag), ao custo do big bag; saco e etiqueta ao custo
--    médio das entradas (sem entrada ainda = custo de referência). Fecha etapas e paradas abertas.
create function public.producao_encerrar_lote(
  p_ordem bigint, p_boas int, p_refugo int, p_embalagens int,
  p_etiquetas int default 0, p_sobra_kg numeric default 0, p_obs text default null)
returns public.producao_ordem
language plpgsql security invoker set search_path = public as $$
declare
  o     producao_ordem;
  b     view_producao_big_bag;
  emb   producao_insumo;
  v_kg  numeric;
  v_eti bigint;
begin
  if not tem_modulo('galpao') then raise exception 'sem acesso à produção'; end if;
  select * into o from producao_ordem where id = p_ordem for update;
  if not found then raise exception 'lote não encontrado'; end if;
  if o.status <> 'aberta' then raise exception 'o lote % já está %', o.codigo, o.status; end if;
  if coalesce(p_boas, -1) < 0 or coalesce(p_refugo, 0) < 0 or coalesce(p_embalagens, 0) < 0
     or coalesce(p_etiquetas, 0) < 0 or coalesce(p_sobra_kg, 0) < 0 then
    raise exception 'quantidades não podem ser negativas';
  end if;
  select * into b from view_producao_big_bag where id = o.entrada_id;
  if coalesce(p_sobra_kg, 0) > b.saldo_kg then
    raise exception 'sobra de % kg é maior que o saldo do big bag (% kg)', p_sobra_kg, b.saldo_kg;
  end if;
  v_kg := b.saldo_kg - coalesce(p_sobra_kg, 0);
  insert into producao_consumo (ordem_id, insumo_id, entrada_id, quantidade, custo_un)
  values (o.id, b.insumo_id, b.id, v_kg, b.custo_kg);

  if o.embalagem_id is not null then select * into emb from producao_insumo where id = o.embalagem_id; end if;
  if coalesce(p_embalagens, 0) > 0 then
    if emb.id is null then raise exception 'o lote não tem embalagem definida'; end if;
    insert into producao_consumo (ordem_id, insumo_id, quantidade, custo_un)
    values (o.id, emb.id, p_embalagens,
            coalesce((select custo_medio from view_producao_estoque where insumo_id = emb.id), emb.custo_referencia, 0));
  end if;
  if coalesce(p_etiquetas, 0) > 0 then
    v_eti := emb.etiqueta_id;
    if v_eti is null then raise exception 'a embalagem do lote não usa etiqueta'; end if;
    insert into producao_consumo (ordem_id, insumo_id, quantidade, custo_un)
    values (o.id, v_eti, p_etiquetas,
            coalesce((select custo_medio from view_producao_estoque where insumo_id = v_eti),
                     (select custo_referencia from producao_insumo where id = v_eti), 0));
  end if;

  update producao_etapa  set fim_em = now() where ordem_id = o.id and fim_em is null;
  update producao_parada set fim_em = now() where ordem_id = o.id and fim_em is null;
  update producao_ordem set status = 'encerrada', fim_em = now(), qtd_boa_final = p_boas,
         refugo_final = coalesce(p_refugo, 0), embalagens_usadas = coalesce(p_embalagens, 0),
         etiquetas_usadas = coalesce(p_etiquetas, 0), sobra_kg = coalesce(p_sobra_kg, 0),
         obs = coalesce(nullif(p_obs, ''), obs)
   where id = o.id returning * into o;
  return o;
end $$;

-- ── Acesso: login com o módulo galpao; ficha técnica, insumos e configuração só o administrador altera
do $$
declare t text;
begin
  foreach t in array array['producao_config','producao_insumo','producao_parametros','producao_equipe',
    'producao_entrada','producao_ordem','producao_etapa','producao_contagem','producao_pesagem',
    'producao_refugo','producao_parada','producao_fardo','producao_consumo'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if t not in ('producao_config','producao_parametros','producao_equipe') then
      execute format('grant usage on sequence public.%I to authenticated', t || '_id_seq');
    end if;
    execute format('create policy ler on public.%I for select to authenticated using (tem_modulo(''galpao''))', t);
    if t in ('producao_config','producao_insumo','producao_parametros','producao_equipe') then
      execute format('create policy alterar on public.%I for all to authenticated using (tem_modulo(''todos'')) with check (tem_modulo(''todos''))', t);
    else
      execute format('create policy alterar on public.%I for all to authenticated using (tem_modulo(''galpao'')) with check (tem_modulo(''galpao''))', t);
    end if;
  end loop;
end $$;
revoke all on public.view_producao_estoque, public.view_producao_big_bag, public.view_producao_lote from anon;
grant select on public.view_producao_estoque, public.view_producao_big_bag, public.view_producao_lote to authenticated;
revoke all on function public.producao_abrir_lote(text, bigint, bigint, int, jsonb, text) from public, anon;
grant execute on function public.producao_abrir_lote(text, bigint, bigint, int, jsonb, text) to authenticated;
revoke all on function public.producao_encerrar_lote(bigint, int, int, int, int, numeric, text) from public, anon;
grant execute on function public.producao_encerrar_lote(bigint, int, int, int, int, numeric, text) to authenticated;
grant usage on sequence public.producao_entrada_codigo_seq to authenticated;

-- ── Dados iniciais
insert into public.producao_config (mod_mensal, cif_mensal, capacidade_normal_un) values (5500, 3436, 10000);

insert into public.producao_insumo (nome, tipo, unidade, ncm, custo_referencia) values
  ('Farinha de mandioca Lotus — grãos médios', 'farinha', 'kg', '11062000', 2.548),
  ('Farinha de mandioca Lotus — grossa',       'farinha', 'kg', '11062000', 2.548),
  ('Etiqueta do saco transparente',            'etiqueta','un', null,       0.40),
  ('Saco impresso Gesoplast 4 kg',             'embalagem','un', null,      1.12);
insert into public.producao_insumo (nome, tipo, unidade, custo_referencia, precisa_etiqueta, etiqueta_id)
values ('Saco transparente 4 kg', 'embalagem', 'un', 0.70, true,
        (select id from public.producao_insumo where nome = 'Etiqueta do saco transparente'));

insert into public.producao_parametros (sku, farinha_id, embalagem_padrao_id, prefixo_lote, peso_nominal_kg,
  tolerancia_g, custo_insumo_kg, pesar_cada) values
  ('16581', (select id from public.producao_insumo where nome like '%grãos médios'),
            (select id from public.producao_insumo where nome = 'Saco transparente 4 kg'), 'BUMIM4', 4, 60, 2.548, 10),
  ('16678', (select id from public.producao_insumo where nome like '%grossa'),
            (select id from public.producao_insumo where nome = 'Saco transparente 4 kg'), 'BUMIG4', 4, 60, 2.548, 10);

insert into public.producao_equipe (pessoa_id) values ('vini'), ('niko'), ('tania'), ('kevin');

-- Os 4 big bags da NF 19532 entram SEM farinha definida: a NF trouxe os dois tipos com o mesmo código
-- (02557); cada um é classificado na tela de Entradas (ou aqui, se o dono disser quantos de cada).
insert into public.producao_entrada (codigo, insumo_id, fornecedor_nome, fornecedor_cnpj, nf_numero, nf_serie,
  nf_chave, nf_emissao, nf_item_codigo, ncm, cfop, cst_icms, cst_pis_cofins, recebido_em, quantidade, custo_un,
  compra_ordem_tiny_id, obs)
select 'LOTUS-19532-0' || n, null,
  'LOTUS COMERCIO E INDUSTRIA DE PRODS DE MANDIOCA LTDA', '49.119.969/0001-75', '19532', '1',
  '35261049119969000175550010000195321723051390', '2026-10-23', '02557', '11062000', '5101', '40', '06',
  '2026-10-26', 1000, 2.548, -1793120443, 'Big bag ' || n || ' de 4 da NF 19532 (frete CIF, Modal Transportes)'
from generate_series(1, 4) n;

commit;

-- ── ROLLBACK
-- begin;
-- drop function if exists public.producao_abrir_lote(text, bigint, bigint, int, jsonb, text);
-- drop function if exists public.producao_encerrar_lote(bigint, int, int, int, int, numeric, text);
-- drop view if exists public.view_producao_lote, public.view_producao_big_bag, public.view_producao_estoque;
-- drop table if exists public.producao_consumo, public.producao_fardo, public.producao_parada, public.producao_refugo,
--   public.producao_pesagem, public.producao_contagem, public.producao_etapa, public.producao_ordem,
--   public.producao_entrada, public.producao_equipe, public.producao_parametros, public.producao_insumo,
--   public.producao_config;
-- drop sequence if exists public.producao_entrada_codigo_seq;
-- commit;
