-- ============================================================================
-- Balanço patrimonial GERENCIAL (26/nov/2026; decisão do dono: ACZ + SVL juntas)
-- O sistema já sabe: carteiras, Mercado Pago, a receber, estoque, matéria-prima,
-- fornecedores e contas a pagar. O que só o dono sabe (bancos, imobilizado,
-- empréstimos, cartão, capital) é digitado na tela de saldos do mês e vale até
-- ser atualizado (o saldo mais recente até o mês pedido).
-- Rollback:
--   select cron.unschedule('fin-balanco-fechar');
--   drop function if exists public.financeiro_balanco(date), public.fin_saldo_gravar(text, date, numeric, text),
--     public.fin_balanco_conta_salvar(text, text, text, int, boolean), public.fin_balanco_fechar(date), public.fin_balanco_sistema();
--   drop table if exists public.fin_balanco_fechado, public.fin_saldo_manual, public.fin_balanco_conta;
-- ============================================================================

create table if not exists public.fin_balanco_conta (
  chave text primary key,
  grupo text not null check (grupo in ('ativo_circulante','ativo_nao_circulante','passivo_circulante','passivo_nao_circulante','patrimonio')),
  nome text not null,
  ordem int not null default 100,
  ativo boolean not null default true,
  dica text
);
create table if not exists public.fin_saldo_manual (
  chave text not null references public.fin_balanco_conta(chave) on update cascade,
  competencia date not null,                 -- 1º dia do mês a que o saldo se refere (saldo no fim do mês)
  valor numeric(14,2) not null,
  obs text,
  por text,
  em timestamptz not null default now(),
  primary key (chave, competencia)
);
create table if not exists public.fin_balanco_fechado (
  competencia date primary key,
  sistema jsonb not null,                    -- os valores do sistema no fechamento
  fechado_em timestamptz not null default now(),
  por text
);
alter table public.fin_balanco_conta enable row level security;
alter table public.fin_saldo_manual enable row level security;
alter table public.fin_balanco_fechado enable row level security;
drop policy if exists fin_bc_ler on public.fin_balanco_conta;
create policy fin_bc_ler on public.fin_balanco_conta for select to authenticated using (tem_modulo('financeiro'));
drop policy if exists fin_sm_ler on public.fin_saldo_manual;
create policy fin_sm_ler on public.fin_saldo_manual for select to authenticated using (tem_modulo('financeiro'));
drop policy if exists fin_bf_ler on public.fin_balanco_fechado;
create policy fin_bf_ler on public.fin_balanco_fechado for select to authenticated using (tem_modulo('financeiro'));
revoke all on public.fin_balanco_conta, public.fin_saldo_manual, public.fin_balanco_fechado from anon, public;
grant select on public.fin_balanco_conta, public.fin_saldo_manual, public.fin_balanco_fechado to authenticated;

insert into public.fin_balanco_conta (chave, grupo, nome, ordem, dica) values
  ('banco_olist',   'ativo_circulante', 'Olist Conta Digital', 10, 'Saldo no último dia do mês'),
  ('banco_nubank',  'ativo_circulante', 'Nubank', 11, 'Saldo no último dia do mês'),
  ('banco_inter',   'ativo_circulante', 'Banco Inter', 12, 'Saldo no último dia do mês'),
  ('banco_itau',    'ativo_circulante', 'Itaú', 13, 'Saldo no último dia do mês'),
  ('aplicacoes',    'ativo_circulante', 'Aplicações financeiras', 14, 'CDB, fundos, caixinhas'),
  ('outros_creditos','ativo_circulante', 'Outros valores a receber', 30, 'Adiantamentos a fornecedor, impostos a recuperar'),
  ('imobilizado',   'ativo_nao_circulante', 'Máquinas, equipamentos e móveis', 10, 'Valor de compra menos o desgaste; pode ser o valor de revenda'),
  ('veiculos',      'ativo_nao_circulante', 'Veículos', 11, null),
  ('cartao',        'passivo_circulante', 'Cartão de crédito (fatura em aberto)', 20, 'Faturas ainda não pagas'),
  ('emprestimos_cp','passivo_circulante', 'Empréstimos — parcelas dos próximos 12 meses', 21, null),
  ('impostos_pagar','passivo_circulante', 'Impostos a pagar', 22, 'Em branco, o sistema usa a estimativa do DRE do mês'),
  ('emprestimos_lp','passivo_nao_circulante', 'Empréstimos — parcelas depois de 12 meses', 10, null),
  ('parcelamentos', 'passivo_nao_circulante', 'Parcelamentos de impostos', 11, null),
  ('capital_social','patrimonio', 'Capital social', 10, 'O valor do contrato social (ACZ + SVL)')
on conflict (chave) do nothing;

-- Valores que o SISTEMA sabe, agora.
create or replace function public.fin_balanco_sistema()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_pos jsonb := '{}'::jsonb; v_est jsonb := '{}'::jsonb;
  v_mp numeric := 0; v_mp_dia date; v_mat numeric := 0;
  v_forn numeric; v_outras numeric; v_imp numeric;
begin
  begin v_pos := dashboard_posicao_empresa(); exception when others then null; end;
  begin v_est := dashboard_estoque_valor();   exception when others then null; end;
  begin
    select coalesce(sum(saldo_final), 0), max(dia) into v_mp, v_mp_dia
    from (select distinct on (conta) conta, dia, saldo_final from view_mp_extrato_dia order by conta, dia desc) s;
  exception when others then v_mp := 0; end;
  begin
    select coalesce(sum(greatest(saldo, 0) * coalesce(custo_medio, custo_referencia, 0)), 0) into v_mat from view_producao_estoque;
  exception when others then v_mat := 0; end;
  -- Fornecedor de mercadoria: tudo em aberto (a mercadoria já chegou). Demais contas: só o que
  -- venceu ou vence em 30 dias (salário/aluguel de meses à frente ainda não é dívida).
  select coalesce(sum(saldo_aberto) filter (where categoria ilike 'Mercadoria%'), 0),
         coalesce(sum(saldo_aberto) filter (where coalesce(categoria, '') not ilike 'Mercadoria%'
                                              and faixa in ('atrasado','hoje','ate_7d','ate_15d','ate_30d')), 0)
    into v_forn, v_outras from view_fin_contas_pagar;
  select impostos into v_imp from view_dre_mensal order by mes desc limit 1;
  return jsonb_build_object(
    'carteiras', coalesce((v_pos #>> '{caixa,valor}')::numeric, 0),
    'mercado_pago', round(coalesce(v_mp, 0), 2), 'mercado_pago_dia', v_mp_dia,
    'receber', coalesce((v_pos #>> '{receber,valor}')::numeric, 0),
    'estoque', coalesce((v_est ->> 'valor_total')::numeric, 0),
    'materia_prima', round(coalesce(v_mat, 0), 2),
    'fornecedores', round(v_forn, 2), 'outras_contas', round(v_outras, 2),
    'impostos_estimados', round(coalesce(v_imp, 0), 2),
    'lido_em', now());
end $$;

-- Balanço de um mês (nulo = agora). Mês fechado usa a foto guardada.
create or replace function public.financeiro_balanco(p_mes date default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_atual date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_mes date := coalesce(date_trunc('month', p_mes)::date, v_atual);
  v_vivo boolean; s jsonb; v_fechado timestamptz;
  v_man jsonb; v_linhas jsonb := '[]'::jsonb; r record;
  v_imp_manual numeric;
  t_ac numeric := 0; t_anc numeric := 0; t_pc numeric := 0; t_pnc numeric := 0; v_capital numeric := 0;
  v_disp numeric; v_est numeric; v_pend int := 0; v_meses jsonb;
begin
  if not tem_modulo('financeiro') then raise exception 'sem acesso ao financeiro'; end if;
  v_vivo := v_mes >= v_atual;
  if v_vivo then
    v_mes := v_atual; s := fin_balanco_sistema();
  else
    select sistema, fechado_em into s, v_fechado from fin_balanco_fechado where competencia = v_mes;
    if s is null then return jsonb_build_object('mes', v_mes, 'sem_fechamento', true); end if;
  end if;

  -- linhas do sistema
  v_linhas := jsonb_build_array(
    jsonb_build_object('grupo','ativo_circulante','chave','carteiras','nome','Carteiras Shopee','valor',(s->>'carteiras')::numeric,'origem','sistema','ordem',1),
    jsonb_build_object('grupo','ativo_circulante','chave','mercado_pago','nome','Mercado Pago','valor',(s->>'mercado_pago')::numeric,'origem','sistema','ordem',2),
    jsonb_build_object('grupo','ativo_circulante','chave','receber','nome','A receber dos marketplaces','valor',(s->>'receber')::numeric,'origem','sistema','ordem',20),
    jsonb_build_object('grupo','ativo_circulante','chave','estoque','nome','Estoque de produtos (a custo)','valor',(s->>'estoque')::numeric,'origem','sistema','ordem',40),
    jsonb_build_object('grupo','ativo_circulante','chave','materia_prima','nome','Matéria-prima da produção','valor',(s->>'materia_prima')::numeric,'origem','sistema','ordem',41),
    jsonb_build_object('grupo','passivo_circulante','chave','fornecedores','nome','Fornecedores de mercadoria','valor',(s->>'fornecedores')::numeric,'origem','sistema','ordem',1),
    jsonb_build_object('grupo','passivo_circulante','chave','outras_contas','nome','Demais contas (vencidas ou a vencer em 30 dias)','valor',(s->>'outras_contas')::numeric,'origem','sistema','ordem',2));

  -- linhas digitadas: o saldo mais recente até o mês pedido
  for r in
    select c.chave, c.grupo, c.nome, c.ordem, c.dica, m.valor, m.competencia, m.obs, m.por, m.em
    from fin_balanco_conta c
    left join lateral (select * from fin_saldo_manual x where x.chave = c.chave and x.competencia <= v_mes
                       order by x.competencia desc limit 1) m on true
    where c.ativo order by c.ordem
  loop
    if r.chave = 'impostos_pagar' then
      v_imp_manual := r.valor;
      v_linhas := v_linhas || jsonb_build_object('grupo', r.grupo, 'chave', r.chave, 'nome', r.nome, 'ordem', r.ordem, 'dica', r.dica,
        'valor', coalesce(r.valor, (s->>'impostos_estimados')::numeric),
        'origem', case when r.valor is null then 'estimativa' else 'manual' end,
        'de_mes', r.competencia, 'obs', r.obs, 'por', r.por, 'em', r.em);
    else
      if r.valor is null then v_pend := v_pend + 1; end if;
      v_linhas := v_linhas || jsonb_build_object('grupo', r.grupo, 'chave', r.chave, 'nome', r.nome, 'ordem', r.ordem, 'dica', r.dica,
        'valor', r.valor, 'origem', 'manual', 'falta', r.valor is null,
        'de_mes', r.competencia, 'obs', r.obs, 'por', r.por, 'em', r.em);
    end if;
  end loop;

  select coalesce(sum((l->>'valor')::numeric) filter (where l->>'grupo' = 'ativo_circulante'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'grupo' = 'ativo_nao_circulante'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'grupo' = 'passivo_circulante'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'grupo' = 'passivo_nao_circulante'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'chave' = 'capital_social'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'chave' in ('carteiras','mercado_pago','receber','aplicacoes','outros_creditos') or l->>'chave' like 'banco_%'), 0),
         coalesce(sum((l->>'valor')::numeric) filter (where l->>'chave' in ('estoque','materia_prima')), 0)
    into t_ac, t_anc, t_pc, t_pnc, v_capital, v_disp, v_est
  from jsonb_array_elements(v_linhas) l;

  select jsonb_agg(to_char(competencia, 'YYYY-MM-DD') order by competencia desc) into v_meses from fin_balanco_fechado;

  return jsonb_build_object(
    'mes', v_mes, 'ao_vivo', v_vivo, 'fechado_em', v_fechado, 'lido_em', s->>'lido_em',
    'mercado_pago_dia', s->>'mercado_pago_dia',
    'linhas', (select jsonb_agg(l order by (l->>'grupo'), (l->>'ordem')::int) from jsonb_array_elements(v_linhas) l),
    'totais', jsonb_build_object(
      'ativo_circulante', round(t_ac, 2), 'ativo_nao_circulante', round(t_anc, 2), 'ativo', round(t_ac + t_anc, 2),
      'passivo_circulante', round(t_pc, 2), 'passivo_nao_circulante', round(t_pnc, 2), 'passivo', round(t_pc + t_pnc, 2),
      'patrimonio', round(t_ac + t_anc - t_pc - t_pnc, 2),
      'capital_social', round(v_capital, 2),
      'resultado_acumulado', round(t_ac + t_anc - t_pc - t_pnc - v_capital, 2)),
    'indicadores', jsonb_build_object(
      'liquidez_corrente', case when t_pc > 0 then round(t_ac / t_pc, 2) end,
      'liquidez_seca', case when t_pc > 0 then round(v_disp / t_pc, 2) end,
      'endividamento_pct', case when t_ac + t_anc > 0 then round(100 * (t_pc + t_pnc) / (t_ac + t_anc), 1) end,
      'capital_giro_liquido', round(t_ac - t_pc, 2),
      'estoque_pct_ativo', case when t_ac + t_anc > 0 then round(100 * v_est / (t_ac + t_anc), 1) end),
    'pendentes', v_pend, 'meses_fechados', coalesce(v_meses, '[]'::jsonb));
end $$;

-- Grava (ou apaga, com valor nulo) o saldo digitado de uma conta num mês.
create or replace function public.fin_saldo_gravar(p_chave text, p_mes date, p_valor numeric, p_obs text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_mes date := date_trunc('month', p_mes)::date; v_por text;
begin
  if not tem_modulo('financeiro') then raise exception 'sem acesso ao financeiro'; end if;
  select nome into v_por from perfis_usuario where user_id = auth.uid();
  if p_valor is null then
    delete from fin_saldo_manual where chave = p_chave and competencia = v_mes;
  else
    insert into fin_saldo_manual (chave, competencia, valor, obs, por) values (p_chave, v_mes, p_valor, p_obs, v_por)
    on conflict (chave, competencia) do update set valor = excluded.valor, obs = excluded.obs, por = excluded.por, em = now();
  end if;
end $$;

-- Cria ou altera uma conta digitada (banco novo, outro bem, outra dívida).
create or replace function public.fin_balanco_conta_salvar(p_chave text, p_grupo text, p_nome text, p_ordem int default 100, p_ativo boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not tem_modulo('financeiro') then raise exception 'sem acesso ao financeiro'; end if;
  insert into fin_balanco_conta (chave, grupo, nome, ordem, ativo) values (p_chave, p_grupo, p_nome, p_ordem, p_ativo)
  on conflict (chave) do update set grupo = excluded.grupo, nome = excluded.nome, ordem = excluded.ordem, ativo = excluded.ativo;
end $$;

-- Guarda a foto do sistema para um mês (cron no dia 1, 00h10 de Brasília, fecha o mês anterior).
create or replace function public.fin_balanco_fechar(p_mes date default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_mes date := coalesce(date_trunc('month', p_mes)::date,
  (date_trunc('month', (now() at time zone 'America/Sao_Paulo')) - interval '1 month')::date);
begin
  insert into fin_balanco_fechado (competencia, sistema, por) values (v_mes, fin_balanco_sistema(), 'automático')
  on conflict (competencia) do nothing;
end $$;

revoke all on function public.fin_balanco_sistema(), public.financeiro_balanco(date), public.fin_saldo_gravar(text, date, numeric, text),
  public.fin_balanco_conta_salvar(text, text, text, int, boolean), public.fin_balanco_fechar(date) from public, anon;
grant execute on function public.financeiro_balanco(date), public.fin_saldo_gravar(text, date, numeric, text),
  public.fin_balanco_conta_salvar(text, text, text, int, boolean) to authenticated, service_role;
grant execute on function public.fin_balanco_sistema(), public.fin_balanco_fechar(date) to service_role;

select cron.schedule('fin-balanco-fechar', '10 3 1 * *', $c$select public.fin_balanco_fechar()$c$);
