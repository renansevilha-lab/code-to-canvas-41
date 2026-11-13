-- ============================================================================
-- Bônus da equipe — cada pessoa vê SÓ o próprio bônus (13/nov/2026, pedido do dono)
-- Migração: producao_bonus_pessoal
--
-- A tela da bancada (login compartilhado do galpão) pergunta QUEM é a pessoa e pede a
-- senha dela. A senha é a MESMA do Ponto (ponto_pessoas, bcrypt): quem ainda não tem
-- escolhe uma no 1º acesso (ponto_definir_senha). Os ids do bônus (producao_etapa.pessoa_id)
-- são os mesmos do Ponto (kevin, niko, tania, vini, renan).
--
-- Peças:
--   producao_bonus_linhas_base(de, ate)   = o cálculo de sempre, SEM checar acesso (só
--                                            chamada por outras funções; nenhum grant ao app)
--   producao_bonus_linhas(de, ate)        = a mesma de antes (admin): base + producao_bonus_acesso()
--   producao_bonus_quem()                 = nomes para a pessoa escolher + se já tem senha
--                                            (módulo galpao; não mostra valor nenhum)
--   producao_bonus_minhas(pessoa, senha, de, ate) = confere a senha e devolve só as linhas e
--                                            os pagamentos dessa pessoa (senha errada = espera 0,6 s)
--   producao_bonus_zerar_senha(pessoa)    = administrador zera a senha (esqueceu); zera a do
--                                            Ponto também — é a mesma
-- ============================================================================

create or replace function public.producao_bonus_linhas_base(p_de date, p_ate date)
returns table(ordem_id bigint, codigo text, dia date, sku text, produto text, sacos_lote numeric, n_pessoas integer,
              pessoa_id text, pessoa text, sacos numeric, valor_saco numeric, valor numeric, pago boolean,
              pagamento_id bigint, pago_em date)
language sql stable security definer set search_path to 'public' as $$
  with lotes as (
    select l.id::bigint id, l.codigo::text codigo, (l.inicio_em at time zone 'America/Sao_Paulo')::date dia, l.sku::text sku, l.produto::text produto,
           coalesce(l.boas, 0)::numeric boas, coalesce(op.bonus_saco, pp.pagamento_saco, 0)::numeric tarifa
    from view_producao_lote l
    join producao_ordem o on o.id = l.id
    left join producao_op op on op.id = o.op_id
    left join producao_parametros pp on pp.sku = l.sku
    where l.status = 'encerrada'
      and (p_de is null or (l.inicio_em at time zone 'America/Sao_Paulo')::date >= p_de)
      and (p_ate is null or (l.inicio_em at time zone 'America/Sao_Paulo')::date <= p_ate)
  ), gente as (
    select distinct e.ordem_id::bigint ordem_id, e.pessoa_id::text pessoa_id from producao_etapa e join lotes on lotes.id = e.ordem_id where e.pessoa_id is not null
  ), n as (select gente.ordem_id, count(*)::int n from gente group by 1)
  select lt.id, lt.codigo, lt.dia, lt.sku, lt.produto, lt.boas, n.n, g.pessoa_id, coalesce(m.nome, g.pessoa_id)::text,
         coalesce(pl.sacos, round(lt.boas / n.n, 4))::numeric,
         coalesce(pl.valor_saco, lt.tarifa)::numeric,
         coalesce(pl.valor, round(lt.boas * lt.tarifa / n.n, 4))::numeric,
         pl.pagamento_id is not null, pl.pagamento_id, pg.pago_em
  from lotes lt
  join gente g on g.ordem_id = lt.id
  join n on n.ordem_id = lt.id
  left join equipe_membros m on m.id = g.pessoa_id
  left join producao_bonus_pago_lote pl on pl.ordem_id = lt.id and pl.pessoa_id = g.pessoa_id
  left join producao_bonus_pagamento pg on pg.id = pl.pagamento_id
$$;
revoke all on function public.producao_bonus_linhas_base(date, date) from public, anon, authenticated;
grant execute on function public.producao_bonus_linhas_base(date, date) to service_role;

create or replace function public.producao_bonus_linhas(p_de date, p_ate date)
returns table(ordem_id bigint, codigo text, dia date, sku text, produto text, sacos_lote numeric, n_pessoas integer,
              pessoa_id text, pessoa text, sacos numeric, valor_saco numeric, valor numeric, pago boolean,
              pagamento_id bigint, pago_em date)
language sql stable security definer set search_path to 'public' as $$
  select * from producao_bonus_linhas_base(p_de, p_ate) where producao_bonus_acesso()
$$;

create or replace function public.producao_bonus_quem()
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select case when not tem_modulo('galpao') then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('pessoa_id', g.pessoa_id, 'pessoa', coalesce(m.nome, pp.nome, g.pessoa_id),
                                        'tem_senha', pp.senha_hash is not null, 'tem_ponto', pp.id is not null)
                     order by coalesce(m.ordem, 99), coalesce(m.nome, g.pessoa_id))
    from (select distinct e.pessoa_id::text pessoa_id from producao_etapa e where e.pessoa_id is not null) g
    left join equipe_membros m on m.id = g.pessoa_id
    left join ponto_pessoas pp on pp.id = g.pessoa_id and pp.ativo), '[]'::jsonb) end
$$;

create or replace function public.producao_bonus_minhas(p_pessoa text, p_senha text, p_de date default null, p_ate date default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public', 'extensions' as $$
declare v ponto_pessoas%rowtype; r jsonb;
begin
  if not tem_modulo('galpao') then return jsonb_build_object('ok', false, 'erro', 'Sem acesso.'); end if;
  select * into v from ponto_pessoas where id = p_pessoa and ativo;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Pessoa não cadastrada no Ponto: peça ao administrador.'); end if;
  if v.senha_hash is null then return jsonb_build_object('ok', false, 'precisa_senha', true); end if;
  if p_senha is null or crypt(p_senha, v.senha_hash) <> v.senha_hash then
    perform pg_sleep(0.6);
    return jsonb_build_object('ok', false, 'erro', 'Senha incorreta.');
  end if;
  with li as (select * from producao_bonus_linhas_base(p_de, p_ate) where pessoa_id = p_pessoa)
  select jsonb_build_object(
    'ok', true, 'pessoa_id', p_pessoa, 'pessoa', v.nome, 'de', p_de, 'ate', p_ate,
    'linhas', coalesce((select jsonb_agg(to_jsonb(li) order by li.dia desc, li.codigo) from li), '[]'),
    'resumo', (select jsonb_build_object('lotes', count(*), 'sacos', round(coalesce(sum(li.sacos), 0), 2),
                 'total', round(coalesce(sum(li.valor), 0), 2),
                 'a_pagar', round(coalesce(sum(li.valor) filter (where not li.pago), 0), 2),
                 'pago', round(coalesce(sum(li.valor) filter (where li.pago), 0), 2),
                 'lotes_a_pagar', count(*) filter (where not li.pago)) from li),
    'pagamentos', coalesce((select jsonb_agg(jsonb_build_object('id', pg.id, 'valor', pg.valor, 'pago_em', pg.pago_em, 'obs', pg.obs,
          'lotes', (select count(*) from producao_bonus_pago_lote pl where pl.pagamento_id = pg.id)) order by pg.pago_em desc, pg.id desc)
        from producao_bonus_pagamento pg where pg.pessoa_id = p_pessoa), '[]')
  ) into r;
  return r;
end $$;

create or replace function public.producao_bonus_zerar_senha(p_pessoa text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $$
begin
  if not producao_bonus_acesso() then raise exception 'Só o administrador zera a senha.'; end if;
  update ponto_pessoas set senha_hash = null, senha_definida_em = null where id = p_pessoa;
  if not found then return jsonb_build_object('ok', false, 'erro', 'Pessoa não cadastrada no Ponto.'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.producao_bonus_quem() from public, anon;
revoke all on function public.producao_bonus_minhas(text, text, date, date) from public, anon;
revoke all on function public.producao_bonus_zerar_senha(text) from public, anon;
grant execute on function public.producao_bonus_quem() to authenticated, service_role;
grant execute on function public.producao_bonus_minhas(text, text, date, date) to authenticated, service_role;
grant execute on function public.producao_bonus_zerar_senha(text) to authenticated, service_role;

-- ROLLBACK (volta ao estado de 12/nov):
--   drop function if exists public.producao_bonus_quem();
--   drop function if exists public.producao_bonus_minhas(text, text, date, date);
--   drop function if exists public.producao_bonus_zerar_senha(text);
--   recriar producao_bonus_linhas com o corpo de producao_bonus_linhas_base + "where producao_bonus_acesso()"
--   (docs/producao-bonus.sql) e então: drop function public.producao_bonus_linhas_base(date, date);
