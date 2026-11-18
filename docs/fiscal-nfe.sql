-- ============================================================================
-- Espelho fiscal das NF-e do Tiny para o fechamento contábil da ACZ Pet (18/nov/2026, opção A do dono)
-- Migrações: fiscal_nfe, fiscal_nfe_funcoes · Edge function: fiscal-nfe · Cron 179 fiscal-nfe-noite
--
-- Dados enxutos no banco; XML ORIGINAL compactado no Storage (bucket privado fiscal-xml:
-- nfe/AAAA-MM/<chave>.xml.gz e <chave>-canc.xml.gz). Só a função escreve. Leitura das tabelas: tem_modulo('financeiro').
-- Peso medido em out/2026: 7.994 notas de saída no mês, ~4,3 KB por XML compactado (≈ 36 MB/mês de arquivo),
-- ~6 MB/mês de banco (estimativa).
-- ============================================================================

create table if not exists public.fiscal_nfe (
  chave          text primary key,               -- chave de acesso (44 dígitos)
  tiny_id        bigint not null unique,
  conta          text not null default 'ottz',
  tipo           text not null,                   -- S | E (como o Tiny lista)
  numero         text, serie text,
  dia            date not null,                   -- data de emissão (dia local da nota)
  data_emissao   timestamptz,
  situacao_tiny  text,                            -- 3 = cancelada no Tiny; 6/7 = autorizada
  v_nf_lista     numeric(14,2),                   -- valor que a LISTA do Tiny informa (conferência)
  tp_nf smallint, fin_nfe smallint, nat_op text,
  emit_doc text, emit_nome text, emit_uf text,
  dest_doc text,                                  -- só quando é CNPJ (CPF de consumidor não é guardado)
  dest_uf text, ind_ie_dest text,
  v_prod numeric(14,2), v_frete numeric(14,2), v_desc numeric(14,2), v_outro numeric(14,2),
  v_icms numeric(14,2), v_st numeric(14,2), v_ipi numeric(14,2), v_pis numeric(14,2), v_cofins numeric(14,2),
  v_difal numeric(14,2), v_fcp numeric(14,2), v_nf numeric(14,2),
  c_stat text, ref_nfe text[],
  cancelada boolean not null default false, cancelada_em timestamptz,   -- pelo EVENTO 110111 (xmlCancelamento), não pela situação do Tiny
  xml_path text, xml_bytes integer, canc_path text,
  xml_em timestamptz, xml_tentativas smallint not null default 0, xml_erro text,   -- xml_em nulo = na fila
  visto_em timestamptz not null default now()
);
create index if not exists fiscal_nfe_por_dia on public.fiscal_nfe (dia);
create index if not exists fiscal_nfe_pendente on public.fiscal_nfe (dia desc) where xml_em is null and xml_tentativas < 4;

create table if not exists public.fiscal_nfe_item (
  chave text not null references public.fiscal_nfe(chave) on delete cascade,
  n smallint not null,
  c_prod text, x_prod text, ncm text, cfop text, u_com text, q_com numeric(14,4),
  v_prod numeric(14,2), v_desc numeric(14,2), v_frete numeric(14,2), v_outro numeric(14,2),
  orig text, cst_icms text, p_icms numeric(7,4), v_bc numeric(14,2), v_icms numeric(14,2), v_st numeric(14,2),
  v_difal numeric(14,2), v_fcp numeric(14,2),
  cst_pis text, v_pis numeric(14,2), cst_cofins text, v_cofins numeric(14,2), v_ipi numeric(14,2),
  primary key (chave, n)
);
create index if not exists fiscal_nfe_item_ncm on public.fiscal_nfe_item (ncm);

-- dias já listados no Tiny (tipo S/E) e o marcador diário da releitura das canceladas (tipo C)
create table if not exists public.fiscal_nfe_dia (
  conta text not null default 'ottz', tipo text not null, dia date not null,
  total_api integer, com_chave integer, listado_em timestamptz not null default now(),
  fora_do_plano boolean not null default false, erro text,
  primary key (conta, tipo, dia)
);

alter table public.fiscal_nfe enable row level security;
alter table public.fiscal_nfe_item enable row level security;
alter table public.fiscal_nfe_dia enable row level security;
create policy ler on public.fiscal_nfe for select to authenticated using (public.tem_modulo('financeiro'));
create policy ler on public.fiscal_nfe_item for select to authenticated using (public.tem_modulo('financeiro'));
create policy ler on public.fiscal_nfe_dia for select to authenticated using (public.tem_modulo('financeiro'));
revoke all on public.fiscal_nfe, public.fiscal_nfe_item, public.fiscal_nfe_dia from anon, public;
grant select on public.fiscal_nfe, public.fiscal_nfe_item, public.fiscal_nfe_dia to authenticated;
grant all on public.fiscal_nfe, public.fiscal_nfe_item, public.fiscal_nfe_dia to service_role;

insert into storage.buckets (id, name, public) values ('fiscal-xml', 'fiscal-xml', false) on conflict (id) do nothing;

-- dias ainda não listados, do mais novo para o mais antigo (os 3 últimos dias são relidos à parte, toda noite)
create or replace function public.fiscal_nfe_dias_a_listar(p_piso date, p_n integer)
returns table (tipo text, dia date) language sql stable set search_path to 'public' as $f$
  with lim as (
    select t.tipo, coalesce((select max(d.dia) from public.fiscal_nfe_dia d where d.conta = 'ottz' and d.tipo = t.tipo and d.fora_do_plano), date '1900-01-01') as corte
    from (values ('S'), ('E')) t(tipo)
  )
  select l.tipo, g.dia::date
  from lim l
  cross join lateral generate_series(greatest(p_piso, l.corte + 1), ((now() at time zone 'America/Sao_Paulo')::date - 3), interval '1 day') g(dia)
  where not exists (select 1 from public.fiscal_nfe_dia d where d.conta = 'ottz' and d.tipo = l.tipo and d.dia = g.dia::date)
  order by g.dia desc, l.tipo desc
  limit greatest(coalesce(p_n, 6), 0)
$f$;
-- fiscal_nfe_resumo(): contagens para o modulo=status (ver a migração fiscal_nfe_funcoes)

-- Cron 179 `fiscal-nfe-noite`: '1-14,16-29,31-44,46-59 1-8 * * *' (22h–05h59 de Brasília, fora dos minutos cheios)
--   → fiscal-nfe?modulo=rodar&max=30&folga=15&listar_dias=6 (Bearer publicável, timeout 58 s)

-- ROLLBACK:
--   select cron.unschedule('fiscal-nfe-noite');
--   drop function public.fiscal_nfe_dias_a_listar(date, integer); drop function public.fiscal_nfe_resumo();
--   drop table public.fiscal_nfe_item; drop table public.fiscal_nfe; drop table public.fiscal_nfe_dia;
--   (os arquivos do bucket fiscal-xml saem pelo painel do Storage)
