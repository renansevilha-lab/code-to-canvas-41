-- =============================================================================
-- Compras: sugestão de compra com parâmetros + histórico + rascunho de ordem no app
-- (17/nov/2026, pedido do dono: "módulo integrado ao Claude para gerar a ordem de compra pela
--  necessidade, ajustando cobertura, período de vendas etc.; aprovada aqui, nasce no app e é editável")
-- Migração: compras_sugestao_claude
--
-- Decisões do dono (17/nov): a ordem aprovada nasce como RASCUNHO no app (orçamento, tiny_id negativo,
-- igual à "entrada por NF"); só vai ao Tiny por um "Enviar ao Tiny" (fase seguinte). Preço = último
-- preço pago na ordem de compra do produto; sem compra anterior = custo do cadastro do Tiny.
--
-- 1) compra_sugestao_calcular(...)  — a conta (só leitura). Evolução da sugestao_compra v2 (que fica
--    como está, o agente antigo ainda a usa): período de vendas escolhível (7–180 d), método
--    ('maior' = maior entre o período e o histórico de 90 d sem ruptura | 'periodo' = só o período),
--    crescimento %, contar ou não os Fulls e os orçamentos abertos, filtro por texto do produto/SKU.
-- 2) compras_sugestoes               — histórico: parâmetros + itens de cada sugestão gerada.
-- 3) compra_sugestao_gerar(...)      — calcula, grava no histórico e devolve tudo num jsonb
--    (itens, total, configuração do fornecedor, pedido mínimo, ordens abertas do fornecedor).
-- 4) compra_sugestao_aprovar(id, itens?) — cria a ordem-rascunho em compras_ordens/compra_ordem_itens
--    (numero 'SUG-<id>', kanban 'orcamento', categoria 'Sugestão de compra (app)').
-- 5) compra_sugestao_descartar(id)
-- =============================================================================

begin;

create table if not exists public.compras_sugestoes (
  id            bigint generated always as identity primary key,
  criado_em     timestamptz not null default now(),
  criado_por    text,
  origem        text not null default 'claude',
  fornecedor    text not null,
  parametros    jsonb not null default '{}'::jsonb,
  itens         jsonb not null default '[]'::jsonb,
  total         numeric not null default 0,
  status        text not null default 'rascunho' check (status in ('rascunho', 'aprovada', 'descartada')),
  ordem_tiny_id bigint references public.compras_ordens(tiny_id) on delete set null,
  aprovado_em   timestamptz,
  aprovado_por  text,
  observacao    text
);
comment on table public.compras_sugestoes is
  'Histórico das sugestões de compra geradas (Claude/app): parâmetros, itens calculados e a ordem-rascunho criada ao aprovar.';
alter table public.compras_sugestoes enable row level security;
drop policy if exists app_logado on public.compras_sugestoes;
create policy app_logado on public.compras_sugestoes for all to authenticated using (true) with check (true);
revoke all on public.compras_sugestoes from anon;

-- ---------------------------------------------------------------------------
create or replace function public.compra_sugestao_calcular(
  p_fornecedor       text,
  p_cobertura_dias   integer default 30,
  p_periodo_dias     integer default 30,
  p_metodo           text    default 'maior',
  p_somar_lead_time  boolean default true,
  p_crescimento_pct  numeric default 0,
  p_contar_fulls     boolean default true,
  p_contar_orcamento boolean default false,
  p_filtro           text    default null)
 returns table(fornecedor text, sku text, produto text, venda_periodo numeric, venda_dia_periodo numeric, venda_dia_hist numeric,
               venda_dia numeric, saldo_geral numeric, reservado numeric, fulls numeric, oc_aguardando numeric, oc_orcamento numeric,
               disponivel numeric, cobertura_atual_dias numeric, lead_time_dias integer, dias_alvo integer, alvo_unidades numeric,
               necessidade numeric, multiplo_compra integer, sugestao numeric, preco numeric, preco_origem text, valor numeric, alerta text)
 language sql
 stable
 set search_path to 'public'
as $function$
  with par as (
    select least(greatest(coalesce(p_periodo_dias, 30), 7), 180) as periodo,
           greatest(coalesce(p_cobertura_dias, 30), 1) as cobertura,
           1 + coalesce(p_crescimento_pct, 0) / 100.0 as fator,
           (now() at time zone 'America/Sao_Paulo')::date as hoje
  ),
  alvo_skus as (
    select v.* from view_cobertura_fornecedor v
     where (v.fornecedor ilike '%' || p_fornecedor || '%' or v.apelido ilike '%' || p_fornecedor || '%')
       and (p_filtro is null or btrim(p_filtro) = '' or v.produto ilike '%' || btrim(p_filtro) || '%' or v.sku = btrim(p_filtro))
  ),
  it as (
    select coalesce(k.sku_folha, i.sku) as sku, pt.data_pedido::date as d,
           i.quantidade * coalesce(k.qtd_por_unidade, 1) as q
      from pedidos_tiny pt
      join pedido_itens_tiny i on i.pedido_tiny_id = pt.id
      left join view_kit_componentes k on k.sku_raiz = i.sku
     where coalesce(pt.situacao, '') not in ('cancelada', 'dados_incompletos')
       and pt.data_pedido::date >= (select hoje - greatest(periodo, 90) from par)
       and pt.data_pedido::date < (select hoje from par)
       and coalesce(k.sku_folha, i.sku) in (select a.sku from alvo_skus a)
  ),
  jan as (
    select it.sku,
      coalesce(sum(q) filter (where d >= (select hoje from par) - 90 and d < (select hoje from par) - 60), 0) as j1,
      coalesce(sum(q) filter (where d >= (select hoje from par) - 60 and d < (select hoje from par) - 30), 0) as j2,
      coalesce(sum(q) filter (where d >= (select hoje from par) - 30), 0) as j3,
      coalesce(sum(q) filter (where d >= (select hoje - periodo from par)), 0) as jp
    from it group by it.sku
  ),
  hist as (
    select j.sku, j.jp,
      case when greatest(j1, j2, j3) = 0 then 0 else
        ( (case when j1 >= 0.5 * greatest(j1,j2,j3) then j1 else 0 end)
        + (case when j2 >= 0.5 * greatest(j1,j2,j3) then j2 else 0 end)
        + (case when j3 >= 0.5 * greatest(j1,j2,j3) then j3 else 0 end) )
        / ( (case when j1 >= 0.5 * greatest(j1,j2,j3) then 1 else 0 end)
          + (case when j2 >= 0.5 * greatest(j1,j2,j3) then 1 else 0 end)
          + (case when j3 >= 0.5 * greatest(j1,j2,j3) then 1 else 0 end) )::numeric / 30.0
      end as dia_hist
    from jan j
  ),
  est as (
    select e.sku, sum(e.saldo) as saldo, sum(coalesce(e.saldo_reservado, 0)) as reservado
      from estoque_tiny e where e.deposito = 'Geral' group by e.sku
  ),
  ult as (
    select distinct on (i.sku) i.sku, i.preco, o.numero, o.data_pedido
      from compra_ordem_itens i
      join compras_ordens o on o.tiny_id = i.ordem_tiny_id
     where i.preco > 0 and coalesce(i.sku, '') <> '' and o.tiny_id > 0 and o.kanban_status <> 'excluida'
       and i.sku in (select a.sku from alvo_skus a)
     order by i.sku, o.data_pedido desc nulls last, o.tiny_id desc
  ),
  base as (
    select a.fornecedor, a.sku, a.produto, a.custo, a.multiplo_compra, a.lead_time_dias, a.estoque_sincronizado, a.estoque_atualizado_em,
      coalesce(h.jp, 0) as venda_periodo,
      round(coalesce(h.jp, 0) / (select periodo from par)::numeric, 2) as dia_per,
      round(coalesce(h.dia_hist, 0), 2) as dia_hist,
      coalesce(e.saldo, 0) as saldo, coalesce(e.reservado, 0) as reservado,
      a.full_total as fulls, a.oc_aguardando as oc, a.oc_orcamento as orc,
      u.preco as preco_oc, u.numero as oc_numero, u.data_pedido as oc_data
    from alvo_skus a
    left join hist h on h.sku = a.sku
    left join est e on e.sku = a.sku
    left join ult u on u.sku = a.sku
  ),
  dem as (
    select b.*,
      round((case when lower(coalesce(p_metodo, 'maior')) = 'periodo' then b.dia_per else greatest(b.dia_per, b.dia_hist) end)
            * (select fator from par), 2) as dia,
      (select cobertura from par) + case when coalesce(p_somar_lead_time, true) then b.lead_time_dias else 0 end as dias_alvo,
      coalesce(b.preco_oc, nullif(b.custo, 0)) as preco_uso
    from base b
  ),
  calc as (
    select d.*,
      greatest(d.saldo, 0) - d.reservado
        + case when coalesce(p_contar_fulls, true) then d.fulls else 0 end
        + d.oc
        + case when coalesce(p_contar_orcamento, false) then d.orc else 0 end as disp,
      ceil(d.dia * d.dias_alvo) as alvo
    from dem d
    where d.dia > 0
  ),
  fim as (
    select c.*, greatest(0, c.alvo - c.disp) as nec,
      case when not c.estoque_sincronizado then 0
           else ceil(greatest(0, c.alvo - c.disp) / c.multiplo_compra::numeric) * c.multiplo_compra end as sug
    from calc c
  )
  select f.fornecedor, f.sku, f.produto, f.venda_periodo, f.dia_per, f.dia_hist, f.dia,
    f.saldo, f.reservado, f.fulls, f.oc, f.orc, f.disp,
    round(f.disp / f.dia, 1),
    f.lead_time_dias, f.dias_alvo, f.alvo, f.nec, f.multiplo_compra, f.sug,
    f.preco_uso,
    case when f.preco_oc is not null then 'última OC ' || f.oc_numero || coalesce(' (' || to_char(f.oc_data, 'DD/MM/YY') || ')', '')
         when f.preco_uso is not null then 'custo do Tiny' else 'sem preço' end,
    round(f.sug * coalesce(f.preco_uso, 0), 2),
    nullif(concat_ws('; ',
      case when not f.estoque_sincronizado then 'estoque não sincronizado com o Tiny: fora da sugestão' end,
      case when f.preco_uso is null and f.sug > 0 then 'sem preço (nunca comprado e sem custo no Tiny): informar na ordem' end,
      case when f.preco_oc is not null and coalesce(f.custo, 0) > 0 and abs(f.preco_oc / f.custo - 1) > 0.3
           then 'preço da última OC difere ' || round(abs(f.preco_oc / f.custo - 1) * 100) || '% do custo do Tiny (R$ ' || to_char(f.custo, 'FM999990D00') || '): conferir unidade/fardo' end,
      case when f.saldo < 0 and f.reservado = 0 then 'saldo negativo sem reserva: conferir SKU (anúncio genérico/variação?)' end,
      case when lower(coalesce(p_metodo, 'maior')) <> 'periodo' and f.dia_hist > f.dia_per * 1.3 then 'período abaixo do histórico de 90 d: provável ruptura, usado o histórico' end,
      case when lower(coalesce(p_metodo, 'maior')) = 'periodo' and f.dia_hist > f.dia_per * 1.3 then 'venda do período bem abaixo do histórico de 90 d (' || f.dia_hist || '/dia): pode ter havido ruptura' end,
      case when f.orc > 0 and not coalesce(p_contar_orcamento, false) then 'já há ' || f.orc || ' un em orçamento aberto (não descontadas)' end,
      case when f.estoque_atualizado_em < now() - interval '36 hours' then 'estoque do Tiny lido há mais de 36 h' end
    ), '')
  from fim f
  order by 23 desc nulls last, f.nec desc, f.sku;
$function$;

-- ---------------------------------------------------------------------------
create or replace function public.compra_sugestao_gerar(
  p_fornecedor       text,
  p_cobertura_dias   integer default 30,
  p_periodo_dias     integer default 30,
  p_metodo           text    default 'maior',
  p_somar_lead_time  boolean default true,
  p_crescimento_pct  numeric default 0,
  p_contar_fulls     boolean default true,
  p_contar_orcamento boolean default false,
  p_filtro           text    default null,
  p_por              text    default 'claude',
  p_obs              text    default null,
  p_gravar           boolean default true)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_itens jsonb; v_total numeric; v_id bigint; v_par jsonb; v_cfg jsonb; v_abertas jsonb; v_min numeric; v_nforn int;
begin
  if coalesce(btrim(p_fornecedor), '') = '' then raise exception 'informe o fornecedor (nome ou apelido)'; end if;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb), coalesce(sum(s.valor), 0), count(distinct s.fornecedor)
    into v_itens, v_total, v_nforn
    from compra_sugestao_calcular(p_fornecedor, p_cobertura_dias, p_periodo_dias, p_metodo, p_somar_lead_time,
                                  p_crescimento_pct, p_contar_fulls, p_contar_orcamento, p_filtro) s;

  v_par := jsonb_build_object(
    'fornecedor', p_fornecedor, 'cobertura_dias', greatest(coalesce(p_cobertura_dias, 30), 1),
    'periodo_dias', least(greatest(coalesce(p_periodo_dias, 30), 7), 180), 'metodo', lower(coalesce(p_metodo, 'maior')),
    'somar_lead_time', coalesce(p_somar_lead_time, true), 'crescimento_pct', coalesce(p_crescimento_pct, 0),
    'contar_fulls', coalesce(p_contar_fulls, true), 'contar_orcamento', coalesce(p_contar_orcamento, false), 'filtro', nullif(btrim(p_filtro), ''));

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb), max(c.pedido_minimo)
    into v_cfg, v_min
    from compras_config_fornecedor c
   where c.fornecedor_nome in (select distinct x->>'fornecedor' from jsonb_array_elements(v_itens) x)
      or c.fornecedor_nome ilike '%' || p_fornecedor || '%' or c.apelido ilike '%' || p_fornecedor || '%';

  select coalesce(jsonb_agg(jsonb_build_object('numero', o.numero, 'data_pedido', o.data_pedido, 'data_prevista', o.data_prevista,
           'situacao', o.kanban_status, 'total', o.total_pedido, 'fornecedor', o.fornecedor_nome) order by o.data_pedido desc), '[]'::jsonb)
    into v_abertas
    from compras_ordens o
   where o.kanban_status in ('orcamento', 'aguardando', 'conferencia', 'divergente') and o.arquivada_em is null
     and o.fornecedor_nome in (select distinct x->>'fornecedor' from jsonb_array_elements(v_itens) x);

  if coalesce(p_gravar, true) and jsonb_array_length(v_itens) > 0 then
    insert into compras_sugestoes (criado_por, fornecedor, parametros, itens, total, observacao)
    values (p_por, p_fornecedor, v_par, v_itens, v_total, p_obs)
    returning id into v_id;
  end if;

  return jsonb_build_object(
    'sugestao_id', v_id, 'parametros', v_par, 'total', v_total,
    'itens_com_compra', (select count(*) from jsonb_array_elements(v_itens) x where (x->>'sugestao')::numeric > 0),
    'fornecedores_nos_itens', v_nforn,
    'pedido_minimo', v_min, 'abaixo_do_minimo', coalesce(v_min, 0) > 0 and v_total < v_min,
    'config_fornecedor', v_cfg, 'ordens_abertas', v_abertas, 'itens', v_itens);
end $function$;

-- ---------------------------------------------------------------------------
-- Aprovar: cria a ordem-rascunho no app. p_itens (opcional) = [{sku, quantidade, preco?}] substitui as
-- quantidades calculadas (o que o dono ajustou na conversa); sem ele vão os itens com sugestão > 0.
create or replace function public.compra_sugestao_aprovar(
  p_id            bigint,
  p_itens         jsonb default null,
  p_por           text  default 'claude',
  p_data_prevista date  default null,
  p_obs           text  default null)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  s compras_sugestoes; v_linhas jsonb; v_forn text; v_nforn int; v_forn_id bigint; v_tiny bigint; v_total numeric; v_qtd numeric;
  v_lead int; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_sem text;
begin
  select * into s from compras_sugestoes where id = p_id for update;
  if not found then raise exception 'sugestão % não existe', p_id; end if;
  if s.status <> 'rascunho' then raise exception 'sugestão % já está % (ordem %)', p_id, s.status, s.ordem_tiny_id; end if;

  -- linhas finais: sku, quantidade, preco (do ajuste, senão o calculado)
  with pedida as (
    select x->>'sku' sku, (x->>'quantidade')::numeric quantidade, nullif(x->>'preco', '')::numeric preco
      from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) x
  ), calc as (
    select x->>'sku' sku, (x->>'sugestao')::numeric quantidade, nullif(x->>'preco', '')::numeric preco
      from jsonb_array_elements(s.itens) x
  ), fim as (
    select p.sku, p.quantidade, coalesce(p.preco, c.preco) preco from pedida p left join calc c on c.sku = p.sku
     where p_itens is not null
    union all
    select c.sku, c.quantidade, c.preco from calc c where p_itens is null
  )
  select jsonb_agg(jsonb_build_object('sku', f.sku, 'quantidade', f.quantidade, 'preco', coalesce(f.preco, nullif(pr.custo, 0), 0),
                                      'descricao', pr.nome, 'gtin', pr.gtin, 'id_tiny', nullif(pr.id_tiny::text, ''), 'fornecedor', pr.fornecedor)),
         count(distinct pr.fornecedor), max(pr.fornecedor),
         string_agg(f.sku, ', ') filter (where pr.sku is null)
    into v_linhas, v_nforn, v_forn, v_sem
    from fim f left join produtos pr on pr.sku = f.sku
   where f.quantidade > 0;

  if v_linhas is null then raise exception 'nenhum item com quantidade maior que zero'; end if;
  if v_sem is not null then raise exception 'SKU não encontrado no cadastro: %', v_sem; end if;
  if v_nforn > 1 then raise exception 'os itens são de mais de um fornecedor no cadastro: aprove um fornecedor por vez (passe p_itens só com os dele)'; end if;

  select o.fornecedor_id into v_forn_id from compras_ordens o
   where o.tiny_id > 0 and o.fornecedor_nome = v_forn and o.fornecedor_id is not null
   order by o.data_pedido desc nulls last limit 1;
  select coalesce(c.lead_time_dias, 15) into v_lead from compras_config_fornecedor c where c.fornecedor_nome = v_forn;

  select sum((x->>'quantidade')::numeric * (x->>'preco')::numeric), sum((x->>'quantidade')::numeric)
    into v_total, v_qtd from jsonb_array_elements(v_linhas) x;

  v_tiny := -(extract(epoch from clock_timestamp())::bigint);
  while exists (select 1 from compras_ordens where tiny_id = v_tiny) loop v_tiny := v_tiny - 1; end loop;

  insert into compras_ordens (tiny_id, numero, data_pedido, data_prevista, fornecedor_id, fornecedor_nome, categoria,
                              total_produtos, total_pedido, frete, observacoes, itens_qtd, kanban_status)
  values (v_tiny, 'SUG-' || p_id, v_hoje, coalesce(p_data_prevista, v_hoje + coalesce(v_lead, 15)), v_forn_id, v_forn,
          'Sugestão de compra (app)', round(v_total, 2), round(v_total, 2), 0,
          concat_ws(' · ', 'Sugestão de compra nº ' || p_id,
                    'cobertura ' || (s.parametros->>'cobertura_dias') || ' d',
                    'vendas de ' || (s.parametros->>'periodo_dias') || ' d (' || (s.parametros->>'metodo') || ')',
                    nullif(p_obs, ''), nullif(s.observacao, '')),
          v_qtd, 'orcamento');

  insert into compra_ordem_itens (ordem_tiny_id, tiny_produto_id, sku, descricao, gtin, quantidade, preco)
  select v_tiny, (x->>'id_tiny')::bigint, x->>'sku', x->>'descricao', x->>'gtin', (x->>'quantidade')::numeric, (x->>'preco')::numeric
    from jsonb_array_elements(v_linhas) x;

  update compras_sugestoes
     set status = 'aprovada', ordem_tiny_id = v_tiny, aprovado_em = now(), aprovado_por = p_por,
         parametros = parametros || jsonb_build_object('itens_aprovados', v_linhas)
   where id = p_id;

  return jsonb_build_object('ordem_tiny_id', v_tiny, 'numero', 'SUG-' || p_id, 'fornecedor', v_forn,
                            'total', round(v_total, 2), 'unidades', v_qtd, 'itens', jsonb_array_length(v_linhas),
                            'data_prevista', coalesce(p_data_prevista, v_hoje + coalesce(v_lead, 15)));
end $function$;

create or replace function public.compra_sugestao_descartar(p_id bigint, p_por text default 'claude')
 returns void language sql set search_path to 'public' as $function$
  update compras_sugestoes set status = 'descartada', aprovado_por = p_por, aprovado_em = now()
   where id = p_id and status = 'rascunho';
$function$;

revoke all on function public.compra_sugestao_calcular(text, integer, integer, text, boolean, numeric, boolean, boolean, text) from public, anon;
revoke all on function public.compra_sugestao_gerar(text, integer, integer, text, boolean, numeric, boolean, boolean, text, text, text, boolean) from public, anon;
revoke all on function public.compra_sugestao_aprovar(bigint, jsonb, text, date, text) from public, anon;
revoke all on function public.compra_sugestao_descartar(bigint, text) from public, anon;
grant execute on function public.compra_sugestao_calcular(text, integer, integer, text, boolean, numeric, boolean, boolean, text) to authenticated, service_role;
grant execute on function public.compra_sugestao_gerar(text, integer, integer, text, boolean, numeric, boolean, boolean, text, text, text, boolean) to authenticated, service_role;
grant execute on function public.compra_sugestao_aprovar(bigint, jsonb, text, date, text) to authenticated, service_role;
grant execute on function public.compra_sugestao_descartar(bigint, text) to authenticated, service_role;

commit;

-- =============================================================================
-- ROLLBACK (as ordens SUG-* já criadas ficam; para tirá-las: excluir pelo app)
-- =============================================================================
/*
begin;
drop function if exists public.compra_sugestao_descartar(bigint, text);
drop function if exists public.compra_sugestao_aprovar(bigint, jsonb, text, date, text);
drop function if exists public.compra_sugestao_gerar(text, integer, integer, text, boolean, numeric, boolean, boolean, text, text, text, boolean);
drop function if exists public.compra_sugestao_calcular(text, integer, integer, text, boolean, numeric, boolean, boolean, text);
drop table if exists public.compras_sugestoes;
commit;
*/
