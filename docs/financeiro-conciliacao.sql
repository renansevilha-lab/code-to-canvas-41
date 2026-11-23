-- =====================================================================================
-- Conciliação do agente financeiro (23/nov/2026)
-- =====================================================================================
-- O que é
--   financeiro_conciliacao(p_dias)            -> jsonb com seis conciliações feitas no NOSSO sistema
--   financeiro_conciliacao_html(jsonb)        -> o mesmo conteúdo em HTML simples (h3, p, table)
--   financeiro_conciliacao_destaque(jsonb)    -> uma frase com o que mais importa
--   auxiliares: fin_conc_brl, fin_conc_brl_curto (formatação de R$) e fin_conc_esc (escape de HTML)
--
-- Só LEITURA. Nenhuma tabela, view, índice, cron ou dado é criado/alterado. Cada bloco roda dentro
-- de begin/exception: se um falhar, devolve {"erro": "..."} e os outros seguem.
--
-- Janela: os p_dias dias FECHADOS antes de hoje (dia de Brasília). Hoje nunca entra.
--
-- Blocos
--   mercado_pago  extrato de liberações (mp_extrato) x carteira (transacoes_carteira, marketplace
--                 'mercadolivre'). O par é source_id do extrato = transaction_id da carteira, na mesma
--                 conta. O extrato registra a LIBERAÇÃO; a carteira guarda o pagamento com
--                 data_liberacao. Por isso o lado da carteira é olhado pelo dia de data_liberacao
--                 (status_liberacao = 'released'), nunca pelo dia do pagamento.
--                 Regras de comparação (medidas com 60 dias de extrato, contas Ottz e SVL):
--                   * a unidade é o PAGAMENTO (conta + source_id) com linha na janela; o valor do
--                     extrato é a soma das linhas dele que não são reserva, no extrato INTEIRO
--                     carregado (a liberação e o frete podem cair em dias diferentes)
--                   * ok: carteira.valor = essa soma (ou a soma só da janela), tolerância R$ 0,01
--                   * reembolso: a carteira guarda UMA linha por pagamento e, quando há estorno, ela
--                     vira o estorno negativo; o extrato mostra a venda entrando e o reembolso saindo
--                     em linhas/dias separados -> o par é achado, o valor NÃO é comparado
--                   * valor_diferente com sinal invertido: o extrato mostra SAÍDA e a carteira guarda o
--                     mesmo valor como ENTRADA (boleto, PIX enviado, dinheiro mandado para reserva)
--                   * sem par esperado (não é divergência): saque (payout), reservas (reserve_for_*),
--                     frete cobrado à parte (id de envio) e transferência para a nossa outra conta
--                   * a entender (listado à parte): descrição que ainda não conhecemos,
--                     reserve_for_debt_payment e lançamento da carteira que não é venda nem
--                     transferência (ex.: estorno de dinheiro que nunca foi liberado)
--                   * lado da carteira: só dias cobertos por arquivo do extrato já gravado
--                     (mp_extrato_pedido) - dia sem arquivo não vira "falta no extrato"
--                   * saldo: saldo inicial + créditos - débitos = saldo final, e o inicial de um dia
--                     = o final do dia anterior
--   shopee        view_conciliacao_shopee: pedidos com crédito na janela e repasse diferente do
--                 esperado; pedidos concluídos há 30-60 dias sem crédito (a entender)
--   fornecedor    notas de fornecedor (compras_nf_entrada, ignorar = false, 60 dias) x ordem de compra
--                 x contas a pagar (view_cp_parcela_origem: parcela que cita a nota + CNPJ)
--   devolucoes    view_shopee_reembolsos (30 dias) + notas de devolução (devolucao_auto,
--                 devolucoes_svl_base, notas_cancelados)
--   fluxo         view_fluxo_caixa_previsto_realizado na janela
--   contas_pagas  qualidade do cadastro de contas_pagar (data de pagamento, conta bancária)
--
-- Quem chama: o cron (papel postgres). As funções não têm permissão para public/anon/authenticated.
--
-- Rollback
--   drop function if exists public.financeiro_conciliacao_destaque(jsonb);
--   drop function if exists public.financeiro_conciliacao_html(jsonb);
--   drop function if exists public.financeiro_conciliacao(integer);
--   drop function if exists public.fin_conc_brl_curto(numeric);
--   drop function if exists public.fin_conc_brl(numeric);
--   drop function if exists public.fin_conc_esc(text);
-- =====================================================================================

create or replace function public.fin_conc_brl(v numeric) returns text
language sql immutable set search_path = public, extensions as $f$
  select case when v is null then '—'
    else case when v < 0 then '-' else '' end || 'R$ ' ||
      replace(replace(replace(to_char(abs(round(v, 2)), 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.') end
$f$;

create or replace function public.fin_conc_brl_curto(v numeric) returns text
language sql immutable set search_path = public, extensions as $f$
  select case when v is null then '—'
    when abs(v) >= 1000000 then case when v < 0 then '-' else '' end || 'R$ ' || replace(to_char(round(abs(v) / 1000000, 1), 'FM999990.0'), '.', ',') || ' mi'
    when abs(v) >= 100000 then case when v < 0 then '-' else '' end || 'R$ ' || to_char(round(abs(v) / 1000), 'FM999990') || ' mil'
    when abs(v) >= 1000 then case when v < 0 then '-' else '' end || 'R$ ' || replace(to_char(round(abs(v) / 1000, 1), 'FM999990.0'), '.', ',') || ' mil'
    else public.fin_conc_brl(v) end
$f$;

create or replace function public.fin_conc_esc(t text) returns text
language sql immutable set search_path = public, extensions as $f$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$f$;

-- -------------------------------------------------------------------------------------
create or replace function public.financeiro_conciliacao(p_dias integer default 7)
returns jsonb
language plpgsql stable
set search_path = public, extensions
as $fn$
#variable_conflict use_column
declare
  v_dias   int := least(greatest(coalesce(p_dias, 7), 1), 60);
  v_hoje   date := (now() at time zone 'America/Sao_Paulo')::date;
  v_de     date;
  v_ts_de  timestamptz;
  v_ts_ate timestamptz;
  b_mp jsonb; b_shopee jsonb; b_forn jsonb; b_dev jsonb; b_fluxo jsonb; b_contas jsonb;
  v_resumo jsonb; v_dec jsonb := '[]'::jsonb;
  v_erros text[] := '{}';
  v_itens int := 0; v_valor numeric := 0;
  r record; n1 int; n2 int; n3 int; x1 numeric; x2 numeric; t1 text;
begin
  v_de     := v_hoje - v_dias;
  v_ts_de  := (v_de::timestamp at time zone 'America/Sao_Paulo');
  v_ts_ate := (v_hoje::timestamp at time zone 'America/Sao_Paulo');

  -- ================================================================= Mercado Pago
  begin
    with contas as (
      select user_id, apelido from mp_extrato_conta where ativo
    ),
    cob as (  -- dias cobertos por um arquivo já gravado
      select distinct p.conta, d::date as dia
      from mp_extrato_pedido p
      cross join lateral generate_series(greatest(p.de, v_de)::timestamp, least(p.ate, v_hoje - 1)::timestamp, interval '1 day') d
      where p.status = 'gravado' and p.ate >= v_de and p.de <= v_hoje - 1
    ),
    ex as (
      select e.id, e.conta, (e.data at time zone 'America/Sao_Paulo')::date as dia, e.data, e.linha,
             coalesce(e.source_id, 'sem-id-' || e.id) as source_id,
             coalesce(e.descricao, '(sem descrição)') as descricao,
             coalesce(e.credito, 0) as credito, coalesce(e.debito, 0) as debito, e.saldo, e.order_id
      from mp_extrato e
      where e.record_type = 'release' and e.data >= v_ts_de - interval '1 day' and e.data < v_ts_ate
    ),
    dia as (
      select conta, dia, count(*) as lancamentos, sum(credito) as creditos, sum(debito) as debitos,
             (array_agg(saldo - credito + debito order by data, linha))[1] as saldo_inicial,
             (array_agg(saldo order by data desc, linha desc))[1] as saldo_final
      from ex group by 1, 2
    ),
    dia2 as (
      select d.*, lag(d.saldo_final) over (partition by d.conta order by d.dia) as saldo_ant,
             lag(d.dia) over (partition by d.conta order by d.dia) as dia_ant
      from dia d
    ),
    gj as (  -- por pagamento (source_id): só o que tem linha na janela; o dia é o da última linha
      select conta, source_id, max(dia) as dia,
             coalesce(sum(credito - debito) filter (where descricao not like 'reserve%'), 0) as tot_jan,
             coalesce(sum(credito - debito) filter (where descricao like 'reserve%'), 0) as res_jan,
             bool_or(descricao not like 'reserve%' and descricao not in ('payment', 'shipping', 'cashback', 'fee_for_divergence_in_package_dimensions',
                     'shipping_cancel', 'refund', 'mediation', 'mediation_cancel', 'chargeback', 'cashback_cancel', 'payout')) as desc_nova,
             bool_and(descricao like 'reserve%') as so_reserva,
             bool_or(descricao = 'payout') as tem_saque,
             bool_and(descricao like 'reserve%' or descricao in ('shipping', 'shipping_cancel')) as so_frete,
             string_agg(distinct descricao, ' + ' order by descricao) as descs,
             max(order_id) as order_id
      from ex where dia >= v_de group by 1, 2
    ),
    gt as (  -- total do mesmo pagamento em todo o extrato gravado (liberação e ajuste podem cair em dias diferentes)
      select g.*,
             case when g.source_id like 'sem-id-%' then g.tot_jan
                  else coalesce((select sum(coalesce(e.credito, 0) - coalesce(e.debito, 0)) from mp_extrato e
                                 where e.source_id = g.source_id and e.conta = g.conta and e.record_type = 'release'
                                   and coalesce(e.descricao, '') not like 'reserve%' and e.data < v_ts_ate), 0) end as tot
      from gj g
    ),
    j as (
      select g.*, (t.transaction_id is not null) as tem, (t2.transaction_id is not null) as outra_conta, t.tipo, t.classificacao, t.status as t_status,
             t.valor as t_valor, t.pedido_id as t_pedido, t.descricao as t_desc
      from gt g
      left join transacoes_carteira t
        on t.transaction_id = g.source_id and t.marketplace = 'mercadolivre' and t.shop_id = g.conta
      left join transacoes_carteira t2  -- o mesmo pagamento registrado na nossa OUTRA conta (transferência entre contas próprias)
        on t2.transaction_id = g.source_id and t2.marketplace = 'mercadolivre' and t2.shop_id <> g.conta
    ),
    cl as (
      select j.*,
        case
          when so_reserva then case when abs(res_jan) <= 0.01 then 'reserva_zerada'
                                    when descs like '%reserve_for_debt_payment%' then 'a_entender'
                                    else 'reserva_aberta' end
          when desc_nova then 'a_entender'
          when not tem then case when tem_saque then 'saque' when outra_conta then 'transferencia_propria'
                                 when so_frete and (tot_jan < 0 or descs like '%shipping_cancel%') then 'frete_avulso'
                                 else 'extrato_sem_carteira' end
          when tipo in ('estorno', 'cancelado') or t_status in ('refunded', 'in_mediation', 'charged_back', 'cancelled', 'rejected') then 'reembolso'
          when abs(t_valor - tot) <= 0.01 or abs(t_valor - tot_jan) <= 0.01 then 'ok'
          else 'valor_diferente'
        end as sit,
        case when so_reserva then res_jan when tem and not desc_nova then tot else tot_jan end as v_extrato
      from j
    ),
    cs as (  -- carteira liberada no dia e que não aparece em nenhum dia do extrato
      select t.shop_id as conta, (t.data_liberacao at time zone 'America/Sao_Paulo')::date as dia,
             t.transaction_id as source_id, t.tipo, t.classificacao, t.valor as t_valor, t.pedido_id as t_pedido, t.descricao as t_desc,
             case when t.status = 'approved' and (t.tipo in ('recebimento_pedido', 'recebimento_avulso')
                    or (t.tipo = 'outro_mp' and t.classificacao in ('OP_MONEY_TRANSFER', 'OP_PARTITION_TRANSFER', 'OP_RECURRING_PAYMENT')))
                  then 'carteira_sem_extrato' else 'a_entender' end as sit
      from transacoes_carteira t
      where t.marketplace = 'mercadolivre' and t.status_liberacao = 'released'
        and t.data_liberacao >= v_ts_de and t.data_liberacao < v_ts_ate
        and exists (select 1 from cob c where c.conta = t.shop_id and c.dia = (t.data_liberacao at time zone 'America/Sao_Paulo')::date)
        and not exists (select 1 from mp_extrato e where e.source_id = t.transaction_id and e.conta = t.shop_id)
    ),
    it as (
      select conta, dia, 'extrato'::text as lado, sit, source_id, order_id, descs as descricao,
             v_extrato, case when tem then t_valor end as v_carteira, t_pedido, t_desc,
             (sit = 'valor_diferente' and tot < 0 and abs(t_valor + tot) <= 0.01) as invertido
      from cl
      union all
      select conta, dia, 'carteira', sit, source_id, null::text,
             coalesce(tipo, '?') || ' / ' || coalesce(classificacao, '?'), null::numeric, t_valor, t_pedido, t_desc, false
      from cs
    ),
    ag as (
      select conta, dia,
             count(*) filter (where sit = 'ok') as ok_n,
             count(*) filter (where sit = 'reembolso') as reemb_n,
             count(*) filter (where sit = 'extrato_sem_carteira') as esc_n,
             coalesce(sum(abs(v_extrato)) filter (where sit = 'extrato_sem_carteira'), 0) as esc_v,
             count(*) filter (where sit = 'carteira_sem_extrato') as cse_n,
             coalesce(sum(abs(v_carteira)) filter (where sit = 'carteira_sem_extrato'), 0) as cse_v,
             count(*) filter (where sit = 'valor_diferente') as dif_n,
             coalesce(sum(abs(v_extrato - v_carteira)) filter (where sit = 'valor_diferente'), 0) as dif_v,
             count(*) filter (where invertido) as inv_n,
             coalesce(sum(abs(v_extrato)) filter (where invertido), 0) as inv_v,
             coalesce(sum(abs(v_extrato - v_carteira)) filter (where invertido), 0) as inv_err,
             count(*) filter (where sit = 'saque') as saq_n,
             coalesce(sum(abs(v_extrato)) filter (where sit = 'saque'), 0) as saq_v,
             count(*) filter (where sit in ('frete_avulso', 'reserva_zerada', 'reserva_aberta', 'transferencia_propria')) as esp_n,
             coalesce(sum(abs(v_extrato)) filter (where sit in ('frete_avulso', 'reserva_aberta', 'transferencia_propria')), 0) as esp_v,
             count(*) filter (where sit = 'a_entender') as ae_n,
             coalesce(sum(abs(coalesce(v_extrato, v_carteira))) filter (where sit = 'a_entender'), 0) as ae_v
      from it group by 1, 2
    ),
    pd as (
      select c.apelido, k.conta, k.dia, coalesce(d.lancamentos, 0) as lancamentos,
             d.saldo_inicial, d.creditos, d.debitos, d.saldo_final,
             case when d.lancamentos is null then null
                  else abs(d.saldo_inicial + d.creditos - d.debitos - d.saldo_final) <= 0.01
                       and (d.saldo_ant is null or d.dia_ant <> d.dia - 1 or abs(d.saldo_ant - d.saldo_inicial) <= 0.01) end as confere_saldo,
             coalesce(a.ok_n, 0) as ok_n, coalesce(a.reemb_n, 0) as reemb_n, coalesce(a.esc_n, 0) as esc_n, coalesce(a.esc_v, 0) as esc_v,
             coalesce(a.cse_n, 0) as cse_n, coalesce(a.cse_v, 0) as cse_v, coalesce(a.dif_n, 0) as dif_n, coalesce(a.dif_v, 0) as dif_v,
             coalesce(a.inv_n, 0) as inv_n, coalesce(a.inv_v, 0) as inv_v, coalesce(a.inv_err, 0) as inv_err,
             coalesce(a.saq_n, 0) as saq_n, coalesce(a.saq_v, 0) as saq_v,
             coalesce(a.esp_n, 0) as esp_n, coalesce(a.esp_v, 0) as esp_v, coalesce(a.ae_n, 0) as ae_n, coalesce(a.ae_v, 0) as ae_v
      from cob k
      join contas c on c.user_id = k.conta
      left join dia2 d on d.conta = k.conta and d.dia = k.dia
      left join ag a on a.conta = k.conta and a.dia = k.dia
    )
    select jsonb_build_object(
      'janela', jsonb_build_object('de', v_de, 'ate', v_hoje - 1),
      'contas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'conta', c.apelido, 'user_id', c.user_id, 'primeiro_dia', u.dia0, 'ultimo_dia', u.dia1,
                 'saldo', u.saldo, 'lancamentos', u.n,
                 'arquivos_aguardando', (select count(*) from mp_extrato_pedido p where p.conta = c.user_id and p.status = 'pedido'),
                 'arquivos_com_erro', (select count(*) from mp_extrato_pedido p where p.conta = c.user_id and p.status = 'erro')
               ) order by c.apelido)
        from contas c
        left join lateral (
          select min((e.data at time zone 'America/Sao_Paulo')::date) as dia0,
                 max((e.data at time zone 'America/Sao_Paulo')::date) as dia1,
                 count(*) filter (where e.record_type = 'release') as n,
                 (array_agg(e.saldo order by e.data desc, e.linha desc) filter (where e.saldo is not null))[1] as saldo
          from mp_extrato e where e.conta = c.user_id
        ) u on true), '[]'::jsonb),
      'por_dia', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'conta', apelido, 'dia', dia, 'lancamentos', lancamentos,
                 'saldo_inicial', round(saldo_inicial, 2), 'creditos', round(creditos, 2), 'debitos', round(debitos, 2),
                 'saldo_final', round(saldo_final, 2), 'confere_saldo', confere_saldo,
                 'pares_ok', ok_n, 'pares_reembolso', reemb_n,
                 'extrato_sem_carteira', jsonb_build_object('n', esc_n, 'valor', round(esc_v, 2)),
                 'carteira_sem_extrato', jsonb_build_object('n', cse_n, 'valor', round(cse_v, 2)),
                 'diferenca_valor', jsonb_build_object('n', dif_n, 'valor', round(dif_v, 2)),
                 'saida_lancada_como_entrada', jsonb_build_object('n', inv_n, 'valor', round(inv_v, 2)),
                 'saques', jsonb_build_object('n', saq_n, 'valor', round(saq_v, 2)),
                 'sem_par_esperado', jsonb_build_object('n', esp_n, 'valor', round(esp_v, 2)),
                 'a_entender', jsonb_build_object('n', ae_n, 'valor', round(ae_v, 2)),
                 'fecha', (confere_saldo is not false and esc_n = 0 and cse_n = 0 and dif_n = 0)
               ) order by dia desc, apelido)
        from pd), '[]'::jsonb),
      'pendencias', coalesce((
        select jsonb_agg(to_jsonb(q) - 'ordem' order by q.ordem)
        from (
          select c.apelido as conta, i.dia, i.sit as tipo, i.source_id,
                 coalesce(i.order_id, case when i.t_pedido ~ '^\d{16}$' then i.t_pedido end) as order_id,
                 case i.sit
                   when 'extrato_sem_carteira' then 'Está no extrato (' || i.descricao || ') e não está na carteira'
                   when 'carteira_sem_extrato' then 'Na carteira como liberado (' || i.descricao || coalesce(' · ' || left(i.t_desc, 50), '') || ') e não está no extrato'
                        || case when i.t_pedido ~ '^2000\d{12}$' and not exists (select 1 from pedidos pp where pp.id = i.t_pedido)
                                then ' — o pedido não é venda nossa (parece compra feita com a conta)' else '' end
                   else case when i.invertido
                             then 'Saiu dinheiro no extrato e a carteira lançou como entrada (pagamento ou transferência feita pela conta'
                                  || coalesce(': ' || nullif(btrim(left(i.t_desc, 50)), ''), '') || ')'
                             else 'Valor do extrato diferente do valor da carteira (' || i.descricao || coalesce(' · ' || nullif(btrim(left(i.t_desc, 40)), ''), '') || ')' end
                 end as descricao,
                 i.invertido as sinal_invertido,
                 round(i.v_extrato, 2) as valor_extrato, round(i.v_carteira, 2) as valor_carteira,
                 row_number() over (order by abs(coalesce(i.v_extrato, 0) - coalesce(i.v_carteira, 0)) desc, i.dia desc, i.source_id) as ordem
          from it i join contas c on c.user_id = i.conta
          where i.sit in ('extrato_sem_carteira', 'carteira_sem_extrato', 'valor_diferente')
          order by ordem limit 25
        ) q), '[]'::jsonb),
      'tipos_sem_par_esperado', jsonb_build_object(
        'explicacao', jsonb_build_array(
          'O extrato registra o dia em que o dinheiro foi LIBERADO; a carteira guarda uma linha por pagamento, com a data de liberação. O par é o número do pagamento; do lado da carteira vale o dia da liberação, nunca o dia da venda.',
          'Casam e são comparados pelo valor: venda liberada (payment), frete pago pelo comprador e bônus de frete (shipping, cashback), PIX e transferências recebidas. O valor da carteira é comparado com a soma de todas as linhas daquele pagamento no extrato (a liberação e um ajuste podem cair em dias diferentes).',
          'Casam, mas o valor NÃO é comparado: reembolso, mediação, estorno e contestação (refund, mediation, chargeback). A carteira troca a linha da venda pelo estorno negativo, enquanto o extrato mostra a entrada da venda e a saída do reembolso em linhas (e às vezes dias) separados. Ficam contados como "par de reembolso".',
          'Não têm par na carteira e isso é esperado: saque para o banco (payout), transferência para a nossa outra conta do Mercado Pago (a carteira registra só na conta que recebe), bloqueios de saldo que entram e saem (todos os reserve_for_...), e frete cobrado ou devolvido à parte pelo número do envio (shipping com débito, shipping_cancel). A carteira não guarda esses lançamentos.',
          'Pagamento ou transferência FEITA pela conta (boleto, PIX enviado, compra, dinheiro guardado em reserva): no extrato é SAÍDA; a carteira lança como ENTRADA. Aparece como valor diferente, marcado "saída lançada como entrada". Quando a compra foi paga por outro meio (cartão), aparece só na carteira.',
          'A entender (fora da conta de divergência): tipo de lançamento do extrato que ainda não tinha aparecido, reserva para pagamento de dívida (reserve_for_debt_payment, sai e não volta) e, do lado da carteira, estorno de dinheiro que talvez nunca tenha sido liberado e aporte na conta (OP_ACCOUNT_FUND), que ainda não vimos no extrato.'
        ),
        'observado', coalesce((
          select jsonb_agg(jsonb_build_object('lado', lado, 'situacao', sit, 'tipo', descricao, 'n', n, 'valor', round(v, 2)) order by sit, v desc)
          from (select lado, sit, descricao, count(*) as n, sum(abs(coalesce(v_extrato, v_carteira))) as v
                from it where sit in ('frete_avulso', 'reserva_zerada', 'reserva_aberta', 'transferencia_propria', 'saque', 'reembolso', 'a_entender') group by 1, 2, 3) o), '[]'::jsonb)
      ),
      'resumo', (
        select jsonb_build_object(
          'dias', count(*), 'contas', count(distinct conta), 'dias_que_fecham', count(*) filter (where confere_saldo is not false and esc_n = 0 and cse_n = 0 and dif_n = 0),
          'dias_saldo_nao_confere', count(*) filter (where confere_saldo is false),
          'pares_ok', coalesce(sum(ok_n), 0), 'pares_reembolso', coalesce(sum(reemb_n), 0),
          'extrato_sem_carteira', jsonb_build_object('n', coalesce(sum(esc_n), 0), 'valor', round(coalesce(sum(esc_v), 0), 2)),
          'carteira_sem_extrato', jsonb_build_object('n', coalesce(sum(cse_n), 0), 'valor', round(coalesce(sum(cse_v), 0), 2)),
          'diferenca_valor', jsonb_build_object('n', coalesce(sum(dif_n), 0), 'valor', round(coalesce(sum(dif_v), 0), 2)),
          'saida_lancada_como_entrada', jsonb_build_object('n', coalesce(sum(inv_n), 0), 'valor', round(coalesce(sum(inv_v), 0), 2),
                                                           'erro_na_carteira', round(coalesce(sum(inv_err), 0), 2)),
          'saques', jsonb_build_object('n', coalesce(sum(saq_n), 0), 'valor', round(coalesce(sum(saq_v), 0), 2)),
          'sem_par', jsonb_build_object('n', coalesce(sum(esc_n + cse_n + dif_n), 0), 'valor', round(coalesce(sum(esc_v + cse_v + dif_v), 0), 2)),
          'sem_par_esperado', jsonb_build_object('n', coalesce(sum(esp_n), 0), 'valor', round(coalesce(sum(esp_v), 0), 2)),
          'a_entender', jsonb_build_object('n', coalesce(sum(ae_n), 0), 'valor', round(coalesce(sum(ae_v), 0), 2)),
          'historico_aguardando', (select count(*) from mp_extrato_pedido where status = 'pedido')
        ) from pd)
    ) into b_mp;
  exception when others then
    b_mp := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'mercado_pago'::text;
  end;

  -- ================================================================= Shopee
  begin
    with v as (
      select pedido_id, shop_id, loja, data_pedido, status_pedido, recebido_estimado, repasse_real, reembolsos,
             diferenca, ultima_movimentacao, status_conciliacao
      from view_conciliacao_shopee
      where data_pedido >= v_hoje - 75 and loja is not null
    ),
    jan as (select * from v where ultima_movimentacao >= v_de and ultima_movimentacao < v_hoje),
    agg as (
      select loja, max(shop_id) as shop_id,
             count(*) filter (where status_conciliacao in ('conciliado', 'divergente_taxa', 'divergente_reembolso')) as creditados,
             count(*) filter (where status_conciliacao = 'conciliado') as conciliados,
             coalesce(sum(recebido_estimado) filter (where status_conciliacao in ('conciliado', 'divergente_taxa', 'divergente_reembolso')), 0) as esperado,
             coalesce(sum(repasse_real) filter (where status_conciliacao in ('conciliado', 'divergente_taxa', 'divergente_reembolso')), 0) as recebido,
             count(*) filter (where status_conciliacao = 'divergente_taxa' and diferenca < 0) as abaixo_n,
             coalesce(sum(diferenca) filter (where status_conciliacao = 'divergente_taxa' and diferenca < 0), 0) as abaixo_v,
             count(*) filter (where status_conciliacao = 'divergente_taxa' and diferenca > 0) as acima_n,
             coalesce(sum(diferenca) filter (where status_conciliacao = 'divergente_taxa' and diferenca > 0), 0) as acima_v,
             count(*) filter (where status_conciliacao = 'divergente_reembolso') as reemb_n,
             coalesce(sum(diferenca) filter (where status_conciliacao = 'divergente_reembolso'), 0) as reemb_v,
             count(*) filter (where status_conciliacao = 'so_reembolso_sem_credito') as sr_n,
             coalesce(sum(diferenca) filter (where status_conciliacao = 'so_reembolso_sem_credito'), 0) as sr_v
      from jan group by 1
    ),
    velhos as (
      select loja, max(shop_id) as shop_id, count(*) as n, sum(recebido_estimado) as v
      from v where status_conciliacao = 'a_receber' and data_pedido >= v_hoje - 60 and data_pedido < v_hoje - 30 group by 1
    ),
    acel as (
      select shop_id, max((data at time zone 'America/Sao_Paulo')::date) as ultimo, sum(valor) as valor
      from transacoes_carteira
      where marketplace = 'shopee' and classificacao like '%FAST_ESCROW_DISBURSE%' and data >= now() - interval '60 days' group by 1
    ),
    mai as (
      select loja, pedido_id, data_pedido, recebido_estimado, repasse_real, diferenca, status_conciliacao,
             row_number() over (partition by loja order by diferenca) as rn
      from jan where status_conciliacao in ('divergente_taxa', 'divergente_reembolso') and diferenca < -1
    ),
    lj as (select loja, max(shop_id) as shop_id from v group by 1)
    select jsonb_build_object(
      'janela', jsonb_build_object('de', v_de, 'ate', v_hoje - 1, 'criterio', 'pedidos dos últimos 75 dias com movimento na carteira dentro da janela'),
      'lojas', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'loja', l.loja,
                 'pedidos_creditados', coalesce(a.creditados, 0), 'conciliados', coalesce(a.conciliados, 0),
                 'esperado', round(coalesce(a.esperado, 0), 2), 'recebido', round(coalesce(a.recebido, 0), 2),
                 'repasse_abaixo', jsonb_build_object('n', coalesce(a.abaixo_n, 0), 'valor', round(coalesce(a.abaixo_v, 0), 2)),
                 'repasse_acima', jsonb_build_object('n', coalesce(a.acima_n, 0), 'valor', round(coalesce(a.acima_v, 0), 2)),
                 'divergente_com_reembolso', jsonb_build_object('n', coalesce(a.reemb_n, 0), 'valor', round(coalesce(a.reemb_v, 0), 2)),
                 'so_reembolso_sem_credito', jsonb_build_object('n', coalesce(a.sr_n, 0), 'valor', round(coalesce(a.sr_v, 0), 2),
                    'nota', 'a entender: venda devolvida antes do crédito; o pedido segue como válido no sistema'),
                 'sem_credito_30_a_60_dias', jsonb_build_object('n', coalesce(o.n, 0), 'valor', round(coalesce(o.v, 0), 2),
                    'resgate_acelera_60d', c.ultimo, 'resgate_acelera_valor', round(c.valor, 2),
                    'nota', case when c.ultimo is not null
                                 then 'a entender: a loja resgatou pelo Shopee Acelera nos últimos 60 dias; o resgate paga pedidos sem citar o número'
                                 else 'a entender: pedidos válidos de 30 a 60 dias atrás sem nenhum crédito na carteira e sem resgate do Acelera na loja' end),
                 'maiores', coalesce((
                    select jsonb_agg(jsonb_build_object('pedido_id', m.pedido_id, 'data_pedido', m.data_pedido, 'esperado', m.recebido_estimado,
                             'recebido', m.repasse_real, 'diferenca', m.diferenca, 'tipo', m.status_conciliacao) order by m.rn)
                    from mai m where m.loja = l.loja and m.rn <= 8), '[]'::jsonb)
               ) order by l.loja)
        from lj l
        left join agg a on a.loja = l.loja
        left join velhos o on o.loja = l.loja
        left join acel c on c.shop_id = l.shop_id), '[]'::jsonb),
      'nota', 'Esperado = repasse estimado do pedido; recebido = soma do que entrou e saiu na carteira pelo número do pedido. Negativo = recebeu menos.'
    ) into b_shopee;
  exception when others then
    b_shopee := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'shopee'::text;
  end;

  -- ================================================================= Fornecedor
  begin
    with nf as (
      select n.tiny_id, n.numero, n.data_emissao, n.fornecedor_nome, n.valor, n.ordem_tiny_id,
             regexp_replace(coalesce(n.fornecedor_cnpj, ''), '\D', '', 'g') as cnpj,
             o.numero as oc_numero, o.total_pedido as oc_valor, o.contas_lancadas_em
      from compras_nf_entrada n
      left join compras_ordens o on o.tiny_id = n.ordem_tiny_id
      where not n.ignorar and n.data_emissao >= v_hoje - 60 and coalesce(n.valor, 0) > 0
    ),
    cp as (
      select nf_tiny_id, count(*) as parcelas, sum(valor_total) as valor
      from view_cp_parcela_origem
      where nf_tiny_id is not null and data_nf >= v_hoje - 60 group by 1
    ),
    oc as (
      select n.ordem_tiny_id, max(o.numero) as oc_numero, max(o.fornecedor_nome) as fornecedor, max(o.total_pedido) as oc_valor,
             sum(n.valor) as nfs_valor, count(*) as nfs, string_agg(n.numero, ', ' order by n.data_emissao) as notas
      from compras_nf_entrada n
      join compras_ordens o on o.tiny_id = n.ordem_tiny_id
      where not n.ignorar and n.ordem_tiny_id > 0   -- ordem criada só no app a partir da nota (id negativo) não é um pedido combinado
        and n.ordem_tiny_id in (select ordem_tiny_id from nf where ordem_tiny_id is not null)
      group by 1
    ),
    ocd as (
      select *, round(nfs_valor - oc_valor, 2) as dif from oc
      where abs(nfs_valor - oc_valor) > greatest(1, 0.01 * coalesce(oc_valor, 0))
    ),
    x as (
      select nf.*, cp.parcelas, cp.valor as cp_valor, fc.n as forn_contas_n, fc.valor as forn_contas_valor,
             (cp.nf_tiny_id is null and nf.contas_lancadas_em is null and not coalesce(fc.mesmo_valor, false) and nf.data_emissao <= v_hoje - 3) as sem_contas
      from nf
      left join cp on cp.nf_tiny_id = nf.tiny_id
      left join lateral (  -- contas do mesmo CNPJ lançadas depois da nota, mesmo sem citar a nota
        select count(*) as n, sum(c.valor_total) as valor, bool_or(abs(c.valor_total - nf.valor) <= 0.05) as mesmo_valor
        from contas_pagar c
        where cp.nf_tiny_id is null and nf.cnpj <> '' and c.status <> 'cancelada' and c.data_emissao >= nf.data_emissao - 5
          and regexp_replace(coalesce(c.fornecedor_cnpj_cpf, ''), '\D', '', 'g') = nf.cnpj
      ) fc on true
    )
    select jsonb_build_object(
      'janela', jsonb_build_object('de', v_hoje - 60, 'ate', v_hoje, 'criterio', 'notas de fornecedor emitidas nos últimos 60 dias (frete, retorno do Full e as marcadas como não-compra ficam de fora)'),
      'notas', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(valor), 0), 2),
                  'novas_na_janela', count(*) filter (where data_emissao >= v_de),
                  'novas_valor', round(coalesce(sum(valor) filter (where data_emissao >= v_de), 0), 2)) from x),
      'sem_ordem', (select jsonb_build_object(
                  'n', count(*), 'valor', round(coalesce(sum(valor), 0), 2),
                  'acima_de_500', jsonb_build_object('n', count(*) filter (where valor >= 500), 'valor', round(coalesce(sum(valor) filter (where valor >= 500), 0), 2)),
                  'maiores', coalesce((select jsonb_agg(to_jsonb(q)) from (
                      select numero as nota, left(fornecedor_nome, 40) as fornecedor, data_emissao, valor
                      from x where ordem_tiny_id is null order by valor desc limit 8) q), '[]'::jsonb))
                from x where ordem_tiny_id is null),
      'diferenca_ordem', jsonb_build_object(
                  'n', (select count(*) from ocd),
                  'notas_acima_da_ordem', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(dif), 0), 2)) from ocd where dif > 0),
                  'notas_abaixo_da_ordem', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(dif), 0), 2),
                        'nota', 'a entender: pode ser entrega parcial (ainda falta nota)') from ocd where dif < 0),
                  'casos', coalesce((select jsonb_agg(to_jsonb(q)) from (
                      select oc_numero as ordem, left(fornecedor, 40) as fornecedor, oc_valor as valor_ordem, round(nfs_valor, 2) as valor_notas, dif as diferenca, nfs as qtd_notas, notas
                      from ocd order by abs(dif) desc limit 8) q), '[]'::jsonb)),
      'sem_contas', (select jsonb_build_object(
                  'n', count(*), 'valor', round(coalesce(sum(valor), 0), 2),
                  'acima_de_500', jsonb_build_object('n', count(*) filter (where valor >= 500), 'valor', round(coalesce(sum(valor) filter (where valor >= 500), 0), 2)),
                  'maiores', coalesce((select jsonb_agg(to_jsonb(q)) from (
                      select numero as nota, left(fornecedor_nome, 40) as fornecedor, data_emissao, valor, (v_hoje - data_emissao) as dias, oc_numero as ordem,
                             coalesce(forn_contas_n, 0) as outras_contas_do_fornecedor, round(coalesce(forn_contas_valor, 0), 2) as outras_contas_valor
                      from x where sem_contas order by valor desc limit 8) q), '[]'::jsonb),
                  'sem_nenhuma_conta_do_fornecedor', jsonb_build_object('n', count(*) filter (where coalesce(forn_contas_n, 0) = 0 and valor >= 500),
                        'valor', round(coalesce(sum(valor) filter (where coalesce(forn_contas_n, 0) = 0 and valor >= 500), 0), 2)),
                  'nota', 'Nota emitida há 3 dias ou mais, sem conta a pagar que cite o número dela, sem conta do mesmo CNPJ com o mesmo valor lançada depois da nota e sem a marca de contas lançadas na ordem. "Outras contas do fornecedor" = contas do mesmo CNPJ lançadas depois da nota (podem ser de outras notas). Pagamento à vista sem conta lançada e boleto cedido a banco aparecem aqui.')
                from x where sem_contas),
      'contas_diferentes_da_nota', (select jsonb_build_object(
                  'n', count(*), 'valor', round(coalesce(sum(abs(cp_valor - valor)), 0), 2),
                  'casos', coalesce((select jsonb_agg(to_jsonb(q)) from (
                      select numero as nota, left(fornecedor_nome, 40) as fornecedor, valor as valor_nota, round(cp_valor, 2) as valor_contas, round(cp_valor - valor, 2) as diferenca, parcelas
                      from x where cp_valor is not null and abs(cp_valor - valor) > 1 order by abs(cp_valor - valor) desc limit 5) q), '[]'::jsonb))
                from x where cp_valor is not null and abs(cp_valor - valor) > 1)
    ) into b_forn;
  exception when others then
    b_forn := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'fornecedor'::text;
  end;

  -- ================================================================= Devoluções
  begin
    with re as (
      select order_sn, shop_id, data_pedido, classe, solucao, status_devolucao, valor_reembolsado, descontado_vendedor,
             compensado, cmv, produto_recebido_em, devolucao_em, coalesce(devolucao_em, data_pedido) as ref_em
      from view_shopee_reembolsos
      where coalesce(devolucao_em, data_pedido) >= now() - interval '30 days'
    ),
    nv as (  -- produto que deveria voltar e ainda não deu entrada no galpão
      select * from re
      where produto_recebido_em is null and ref_em < now() - interval '15 days'
        and ((classe like '08%' and solucao = 0) or classe like '11%')
    ),
    nfs as (
      select a.estado, a.caso, b.situacao, b.valor, a.criado_em
      from devolucao_auto a left join devolucoes_svl_base b on b.id_nota = a.id_nota_devolucao
      where a.conta = 'svl' and a.estado in ('criada', 'revisar')
    ),
    nco as (
      select nc.valor_nf
      from notas_cancelados nc
      left join pedidos_tiny pt on pt.tiny_pedido_id = nc.tiny_pedido_id
      where nc.finalidade_nf = '1' and nc.id_nota_fiscal is not null and nc.situacao_nf in ('6', '7')
        and not coalesce(nc.devolucao_emitida, false) and nc.data_pedido >= now() - interval '60 days'
        and (pt.tiny_pedido_id is null or pt.situacao = 'cancelada')
    )
    select jsonb_build_object(
      'shopee_30_dias', jsonb_build_object(
        'casos', (select count(*) from re),
        'reembolsado', (select round(coalesce(sum(valor_reembolsado), 0), 2) from re),
        'descontado_de_nos', (select round(coalesce(sum(descontado_vendedor), 0), 2) from re),
        'compensado_pela_shopee', (select round(coalesce(sum(compensado), 0), 2) from re),
        'saiu_do_bolso', (select round(coalesce(sum(descontado_vendedor), 0) - coalesce(sum(compensado), 0), 2) from re),
        'por_classe', coalesce((select jsonb_agg(to_jsonb(q) order by q.classe) from (
            select classe, count(*) as n, round(coalesce(sum(valor_reembolsado), 0), 2) as reembolsado,
                   round(coalesce(sum(descontado_vendedor), 0), 2) as descontado, round(coalesce(sum(compensado), 0), 2) as compensado,
                   count(produto_recebido_em) as produto_recebido
            from re group by 1) q), '[]'::jsonb)),
      'em_andamento', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(valor_reembolsado), 0), 2))
                       from re where classe like '01%' or classe like '02%'),
      'produto_nao_voltou', jsonb_build_object(
        'n', (select count(*) from nv), 'custo_do_produto', (select round(coalesce(sum(cmv), 0), 2) from nv),
        'criterio', 'Shopee: reembolso com devolução do produto ou falha na entrega, há mais de 15 dias, sem entrada registrada em Devoluções › Recebidas',
        'maiores', coalesce((select jsonb_agg(to_jsonb(q)) from (
            select order_sn as pedido, case shop_id when 522186766 then 'Ottz' when 759046323 then 'SVL' end as loja,
                   (ref_em at time zone 'America/Sao_Paulo')::date as desde, left(classe, 2) as classe, round(cmv, 2) as custo
            from nv order by cmv desc nulls last limit 8) q), '[]'::jsonb)),
      'nota_de_devolucao', jsonb_build_object(
        'svl_aguardando_emissao', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(valor), 0), 2),
              'mais_antiga', min((criado_em at time zone 'America/Sao_Paulo')::date),
              'nota', 'criadas pelo sistema e na fila da emissão automática (cerca de 12 por hora)')
            from nfs where estado = 'criada' and situacao = '1'),
        'svl_rejeitadas', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(valor), 0), 2)) from nfs where estado = 'criada' and situacao = '5'),
        'svl_para_revisar', (select jsonb_build_object('n', count(*)) from nfs where estado = 'revisar'),
        'ottz_para_revisar', (select jsonb_build_object('n', count(*)) from devolucao_auto where conta = 'ottz' and estado = 'revisar'),
        'ottz_cancelados_com_nota_sem_devolucao', (select jsonb_build_object('n', count(*), 'valor', round(coalesce(sum(valor_nf), 0), 2),
              'nota', 'pedidos cancelados nos últimos 60 dias com nota de venda autorizada e sem nota de devolução (a emissão automática da Ottz está parada pelo regime tributário)')
            from nco))
    ) into b_dev;
  exception when others then
    b_dev := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'devolucoes'::text;
  end;

  -- ================================================================= Fluxo previsto x realizado
  begin
    with f as (
      select dia, entradas_previstas as previsto, coalesce(entradas_reais, 0) as realizado
      from view_fluxo_caixa_previsto_realizado where dia >= v_de and dia < v_hoje
    ),
    nvd as (
      select count(*) as n, coalesce(sum(valor), 0) as v
      from transacoes_carteira
      where marketplace = 'mercadolivre' and direcao = 'Entrada' and classificacao in ('OP_PARTITION_TRANSFER', 'OP_ACCOUNT_FUND')
        and data_liberacao >= v_ts_de and data_liberacao < v_ts_ate
    )
    select case when (select count(*) from f) = 0
      then jsonb_build_object('indisponivel', 'não há projeção gravada para os dias da janela (fluxo_caixa_snapshots)')
      else jsonb_build_object(
        'janela', jsonb_build_object('de', v_de, 'ate', v_hoje - 1),
        'por_dia', (select jsonb_agg(jsonb_build_object('dia', dia, 'previsto', round(previsto, 2), 'realizado', round(realizado, 2),
                      'desvio', round(realizado - previsto, 2),
                      'desvio_pct', case when previsto > 0 then round(100 * (realizado - previsto) / previsto, 1) end) order by dia) from f),
        'acumulado', (select jsonb_build_object('dias', count(*), 'previsto', round(sum(previsto), 2), 'realizado', round(sum(realizado), 2),
                      'desvio', round(sum(realizado) - sum(previsto), 2),
                      'desvio_pct', case when sum(previsto) > 0 then round(100 * (sum(realizado) - sum(previsto)) / sum(previsto), 1) end,
                      'dias_acima', count(*) filter (where realizado > previsto), 'dias_abaixo', count(*) filter (where realizado < previsto)) from f),
        'realizado_que_nao_e_venda', (select jsonb_build_object('n', n, 'valor', round(v, 2),
                      'nota', 'transferências entre reservas e aportes no Mercado Pago que o realizado conta como entrada') from nvd),
        'maiores_entradas', coalesce((select jsonb_agg(to_jsonb(q)) from (
            select marketplace, case when marketplace = 'mercadolivre' then (data_liberacao at time zone 'America/Sao_Paulo')::date
                                     else (data at time zone 'America/Sao_Paulo')::date end as dia,
                   tipo, classificacao, left(descricao, 60) as descricao, pedido_id, valor
            from transacoes_carteira
            where direcao = 'Entrada' and tipo is distinct from 'recebimento_avulso'
              and ((marketplace = 'mercadolivre' and data_liberacao >= v_ts_de and data_liberacao < v_ts_ate)
                or (marketplace <> 'mercadolivre' and data >= v_ts_de and data < v_ts_ate))
            order by valor desc limit 5) q), '[]'::jsonb),
        'nota', 'Previsto = entradas projetadas no próprio dia; realizado = entradas da carteira (Mercado Livre pelo dia de liberação; PIX avulso fica de fora).')
      end into b_fluxo;
  exception when others then
    b_fluxo := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'fluxo'::text;
  end;

  -- ================================================================= Contas pagas (qualidade do cadastro)
  begin
    select jsonb_build_object(
      'pagas', count(*) filter (where status = 'pago'),
      'sem_data_pagamento', jsonb_build_object(
          'n', count(*) filter (where status = 'pago' and data_pagamento is null),
          'valor', round(coalesce(sum(coalesce(valor_pago, valor_total)) filter (where status = 'pago' and data_pagamento is null), 0), 2),
          'vencidas_nos_ultimos_90_dias', count(*) filter (where status = 'pago' and data_pagamento is null and data_vencimento >= v_hoje - 90)),
      'sem_conta_bancaria', jsonb_build_object(
          'n', count(*) filter (where status = 'pago' and nullif(btrim(conta_bancaria), '') is null),
          'valor', round(coalesce(sum(coalesce(valor_pago, valor_total)) filter (where status = 'pago' and nullif(btrim(conta_bancaria), '') is null), 0), 2)),
      'sem_forma_pagamento', count(*) filter (where status = 'pago' and nullif(btrim(forma_pagamento), '') is null),
      'pagas_na_janela', jsonb_build_object(
          'n', count(*) filter (where status = 'pago' and data_pagamento >= v_de and data_pagamento < v_hoje),
          'valor', round(coalesce(sum(coalesce(valor_pago, valor_total)) filter (where status = 'pago' and data_pagamento >= v_de and data_pagamento < v_hoje), 0), 2)),
      'pago_diferente_do_valor_90_dias', jsonb_build_object(
          'n', count(*) filter (where status = 'pago' and data_pagamento >= v_hoje - 90 and abs(coalesce(valor_pago, 0) - coalesce(valor_total, 0)) > 0.01),
          'valor', round(coalesce(sum(valor_pago - valor_total) filter (where status = 'pago' and data_pagamento >= v_hoje - 90 and abs(coalesce(valor_pago, 0) - coalesce(valor_total, 0)) > 0.01), 0), 2)),
      'nota', 'Qualidade de cadastro. Não há extrato de banco no sistema: só dá para conferir pagamento contra o Mercado Pago, e nenhuma conta paga informa de qual conta bancária saiu.'
    ) into b_contas
    from contas_pagar;
  exception when others then
    b_contas := jsonb_build_object('erro', sqlerrm); v_erros := v_erros || 'contas_pagas'::text;
  end;

  -- ================================================================= Resumo e decisões
  begin
    -- Mercado Pago
    if b_mp ? 'resumo' then
      n1 := coalesce((b_mp #>> '{resumo,sem_par,n}')::int, 0);
      x1 := coalesce((b_mp #>> '{resumo,sem_par,valor}')::numeric, 0);
      n2 := coalesce((b_mp #>> '{resumo,dias_saldo_nao_confere}')::int, 0);
      v_itens := v_itens + n1; v_valor := v_valor + x1;
      if n2 > 0 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:mp:saldo', 'tom', 'red',
          'o_que', 'Conferir o extrato do Mercado Pago: o saldo não fecha em ' || n2 || ' dia(s)',
          'detalhe', 'Saldo inicial + entradas − saídas não bate com o saldo final (ou com o dia anterior) em ' || n2 || ' de ' || (b_mp #>> '{resumo,dias}') || ' dias',
          'sku', null, 'valor', 0, 'prazo', null, 'dono', 'Renan'));
      end if;
      -- saída que a carteira lançou como entrada (o erro na carteira é o dobro do valor pago)
      n3 := coalesce((b_mp #>> '{resumo,saida_lancada_como_entrada,n}')::int, 0);
      x2 := coalesce((b_mp #>> '{resumo,saida_lancada_como_entrada,valor}')::numeric, 0);
      if n3 > 0 and x2 >= 100 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:mp:saida_como_entrada', 'tom', case when x2 >= 1000 then 'red' else 'amber' end,
          'o_que', 'Corrigir a carteira do Mercado Pago: ' || n3 || ' pagamento(s) feitos pela conta estão lançados como entrada',
          'detalhe', fin_conc_brl(x2) || ' que saíram da conta nos últimos ' || v_dias || ' dias aparecem como recebimento; a carteira (e o realizado do fluxo de caixa) fica '
                     || fin_conc_brl((b_mp #>> '{resumo,saida_lancada_como_entrada,erro_na_carteira}')::numeric) || ' acima do extrato',
          'sku', null, 'valor', x2, 'prazo', null, 'dono', 'Renan'));
      end if;
      -- o resto do que não bate
      n1 := n1 - n3;
      x1 := x1 - coalesce((b_mp #>> '{resumo,saida_lancada_como_entrada,erro_na_carteira}')::numeric, 0);
      if n1 > 0 and x1 >= 50 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:mp:nao_bate', 'tom', case when x1 >= 1000 then 'red' else 'amber' end,
          'o_que', 'Conferir ' || n1 || ' lançamento(s) do Mercado Pago que não batem com a carteira',
          'detalhe', (b_mp #>> '{resumo,extrato_sem_carteira,n}') || ' só no extrato, ' || (b_mp #>> '{resumo,carteira_sem_extrato,n}') || ' só na carteira e '
                     || ((b_mp #>> '{resumo,diferenca_valor,n}')::int - n3) || ' com valor diferente — ' || fin_conc_brl(x1) || ' nos últimos ' || v_dias || ' dias',
          'sku', null, 'valor', x1, 'prazo', null, 'dono', 'Renan'));
      end if;
      -- o realizado do fluxo usa a carteira: leva junto o que é saída lançada como entrada
      if n3 > 0 and b_fluxo ? 'acumulado' then
        b_fluxo := b_fluxo || jsonb_build_object('saidas_do_mercado_pago_contadas_como_entrada', b_mp #> '{resumo,saida_lancada_como_entrada}');
      end if;
    end if;

    -- Shopee
    if b_shopee ? 'lojas' then
      for r in select l from jsonb_array_elements(b_shopee -> 'lojas') as l(l) loop
        n1 := coalesce((r.l #>> '{repasse_abaixo,n}')::int, 0) + coalesce((r.l #>> '{divergente_com_reembolso,n}')::int, 0);
        x1 := abs(coalesce((r.l #>> '{repasse_abaixo,valor}')::numeric, 0)) + abs(least(coalesce((r.l #>> '{divergente_com_reembolso,valor}')::numeric, 0), 0));
        v_itens := v_itens + n1; v_valor := v_valor + x1;
        if n1 > 0 and x1 >= 200 then
          v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:shopee:repasse:' || lower(r.l ->> 'loja'),
            'tom', case when x1 >= 2000 then 'red' else 'amber' end,
            'o_que', 'Conferir ' || n1 || ' pedido(s) da Shopee ' || (r.l ->> 'loja') || ' que receberam menos que o esperado',
            'detalhe', fin_conc_brl(x1) || ' a menos em ' || n1 || ' de ' || (r.l ->> 'pedidos_creditados') || ' pedidos creditados nos últimos ' || v_dias || ' dias'
                       || coalesce('; maior: pedido ' || (r.l #>> '{maiores,0,pedido_id}') || ' (' || fin_conc_brl((r.l #>> '{maiores,0,diferenca}')::numeric) || ')', ''),
            'sku', null, 'valor', x1, 'prazo', null, 'dono', 'Renan'));
        end if;
        n2 := coalesce((r.l #>> '{sem_credito_30_a_60_dias,n}')::int, 0);
        x2 := coalesce((r.l #>> '{sem_credito_30_a_60_dias,valor}')::numeric, 0);
        if n2 > 0 and x2 >= 1000 and (r.l #>> '{sem_credito_30_a_60_dias,resgate_acelera_60d}') is null then
          v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:shopee:sem_credito:' || lower(r.l ->> 'loja'), 'tom', 'amber',
            'o_que', 'Verificar ' || n2 || ' pedido(s) da Shopee ' || (r.l ->> 'loja') || ' de 30 a 60 dias atrás que não têm crédito na carteira',
            'detalhe', fin_conc_brl(x2) || ' esperados e nenhum lançamento pelo número do pedido; a loja não resgatou pelo Acelera no período',
            'sku', null, 'valor', x2, 'prazo', null, 'dono', 'Renan'));
        end if;
      end loop;
    end if;

    -- Fornecedor
    if b_forn ? 'sem_contas' then
      n1 := coalesce((b_forn #>> '{sem_contas,acima_de_500,n}')::int, 0);
      x1 := coalesce((b_forn #>> '{sem_contas,acima_de_500,valor}')::numeric, 0);
      v_itens := v_itens + n1; v_valor := v_valor + x1;
      if n1 > 0 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:fornecedor:contas_nao_lancadas',
          'tom', case when x1 >= 20000 then 'red' else 'amber' end,
          'o_que', 'Conferir se as contas a pagar de ' || n1 || ' nota(s) de fornecedor foram lançadas',
          'detalhe', fin_conc_brl(x1) || ' em notas dos últimos 60 dias sem conta que cite a nota; maior: '
                     || coalesce(b_forn #>> '{sem_contas,maiores,0,fornecedor}', '?') || ', nota ' || coalesce(b_forn #>> '{sem_contas,maiores,0,nota}', '?')
                     || ' (' || fin_conc_brl((b_forn #>> '{sem_contas,maiores,0,valor}')::numeric) || ')',
          'sku', null, 'valor', x1, 'prazo', null, 'dono', 'Renan'));
      end if;
      n2 := coalesce((b_forn #>> '{diferenca_ordem,notas_acima_da_ordem,n}')::int, 0);
      x2 := coalesce((b_forn #>> '{diferenca_ordem,notas_acima_da_ordem,valor}')::numeric, 0);
      v_itens := v_itens + n2; v_valor := v_valor + x2;
      if n2 > 0 and x2 >= 100 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:fornecedor:nota_acima_da_ordem', 'tom', 'amber',
          'o_que', 'Conferir ' || n2 || ' ordem(ns) de compra em que as notas somam mais que o pedido',
          'detalhe', fin_conc_brl(x2) || ' acima do combinado; maior: ordem ' || coalesce(b_forn #>> '{diferenca_ordem,casos,0,ordem}', '?') || ' — '
                     || coalesce(b_forn #>> '{diferenca_ordem,casos,0,fornecedor}', '?') || ' (' || fin_conc_brl((b_forn #>> '{diferenca_ordem,casos,0,diferenca}')::numeric) || ')',
          'sku', null, 'valor', x2, 'prazo', null, 'dono', 'Renan'));
      end if;
    end if;

    -- Devoluções
    if b_dev ? 'produto_nao_voltou' then
      n1 := coalesce((b_dev #>> '{produto_nao_voltou,n}')::int, 0);
      x1 := coalesce((b_dev #>> '{produto_nao_voltou,custo_do_produto}')::numeric, 0);
      v_itens := v_itens + n1; v_valor := v_valor + x1;
      if n1 > 0 and x1 >= 300 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:devolucoes:produto_nao_voltou', 'tom', 'amber',
          'o_que', 'Localizar ' || n1 || ' produto(s) de devolução ou falha de entrega que não deram entrada no galpão',
          'detalhe', fin_conc_brl(x1) || ' em produto (a custo) há mais de 15 dias sem entrada em Devoluções › Recebidas',
          'sku', null, 'valor', x1, 'prazo', null, 'dono', 'Renan'));
      end if;
      n2 := coalesce((b_dev #>> '{nota_de_devolucao,svl_rejeitadas,n}')::int, 0) + coalesce((b_dev #>> '{nota_de_devolucao,svl_para_revisar,n}')::int, 0)
            + coalesce((b_dev #>> '{nota_de_devolucao,ottz_para_revisar,n}')::int, 0);
      x2 := coalesce((b_dev #>> '{nota_de_devolucao,svl_rejeitadas,valor}')::numeric, 0);
      v_itens := v_itens + n2;
      if n2 > 0 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:devolucoes:nota_travada', 'tom', 'amber',
          'o_que', 'Corrigir ' || n2 || ' nota(s) de devolução rejeitadas ou paradas para revisão',
          'detalhe', (b_dev #>> '{nota_de_devolucao,svl_rejeitadas,n}') || ' rejeitada(s) na SVL (' || fin_conc_brl(x2) || '), '
                     || (b_dev #>> '{nota_de_devolucao,svl_para_revisar,n}') || ' para revisar na SVL e ' || (b_dev #>> '{nota_de_devolucao,ottz_para_revisar,n}') || ' na Ottz',
          'sku', null, 'valor', x2, 'prazo', null, 'dono', 'Renan'));
      end if;
    end if;

    -- Fluxo
    if b_fluxo ? 'acumulado' then
      x1 := coalesce((b_fluxo #>> '{acumulado,desvio_pct}')::numeric, 0);
      if abs(x1) >= 30 and coalesce((b_fluxo #>> '{acumulado,dias}')::int, 0) >= 3 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:fluxo:desvio', 'tom', 'gray',
          'o_que', 'Rever a projeção de entradas do fluxo de caixa',
          'detalhe', 'Entrou ' || fin_conc_brl((b_fluxo #>> '{acumulado,realizado}')::numeric) || ' contra ' || fin_conc_brl((b_fluxo #>> '{acumulado,previsto}')::numeric)
                     || ' previstos em ' || (b_fluxo #>> '{acumulado,dias}') || ' dias (' || case when x1 > 0 then '+' else '' end || replace(x1::text, '.', ',') || '%)',
          'sku', null, 'valor', abs(coalesce((b_fluxo #>> '{acumulado,desvio}')::numeric, 0)), 'prazo', null, 'dono', 'Renan'));
      end if;
    end if;

    -- Contas pagas
    if b_contas ? 'sem_conta_bancaria' then
      n1 := coalesce((b_contas #>> '{sem_data_pagamento,vencidas_nos_ultimos_90_dias}')::int, 0);
      if n1 > 0 then
        v_dec := v_dec || jsonb_build_array(jsonb_build_object('chave', 'fin:conc:contas:sem_data', 'tom', 'gray',
          'o_que', 'Preencher a data de pagamento de ' || n1 || ' conta(s) paga(s) recentes',
          'detalhe', n1 || ' contas com vencimento nos últimos 90 dias estão como pagas sem a data do pagamento',
          'sku', null, 'valor', 0, 'prazo', null, 'dono', 'Renan'));
      end if;
    end if;

    select coalesce(jsonb_agg(s.d order by case s.d ->> 'tom' when 'red' then 0 when 'amber' then 1 else 2 end, (s.d ->> 'valor')::numeric desc), '[]'::jsonb)
      into v_dec
    from (select e.d from jsonb_array_elements(v_dec) as e(d)
          order by case e.d ->> 'tom' when 'red' then 0 when 'amber' then 1 else 2 end, (e.d ->> 'valor')::numeric desc limit 5) s;

    v_resumo := jsonb_build_object('itens', v_itens, 'valor_em_aberto', round(v_valor, 2), 'blocos_com_erro', to_jsonb(v_erros),
      'composicao', 'Mercado Pago sem par + pedidos Shopee com repasse abaixo + notas de fornecedor (acima de R$ 500) sem conta e acima da ordem + produtos de devolução que não voltaram (a custo) + notas de devolução travadas. O que está "a entender" não entra.');
  exception when others then
    v_resumo := jsonb_build_object('itens', v_itens, 'valor_em_aberto', round(v_valor, 2), 'blocos_com_erro', to_jsonb(v_erros || 'resumo'::text), 'erro', sqlerrm);
  end;

  return jsonb_build_object(
    'versao', 'v1', 'gerado_em', now(), 'dias', v_dias,
    'janela', jsonb_build_object('de', v_de, 'ate', v_hoje - 1),
    'mercado_pago', b_mp, 'shopee', b_shopee, 'fornecedor', b_forn, 'devolucoes', b_dev,
    'fluxo', b_fluxo, 'contas_pagas', b_contas, 'resumo', v_resumo, 'decisoes', coalesce(v_dec, '[]'::jsonb));
end;
$fn$;

-- -------------------------------------------------------------------------------------
create or replace function public.financeiro_conciliacao_destaque(p jsonb)
returns text
language plpgsql stable
set search_path = public, extensions
as $fn$
declare
  s text := ''; parte text;
  n int; v numeric; d int; df int;
begin
  -- Mercado Pago
  if p -> 'mercado_pago' ? 'resumo' then
    d  := coalesce((p #>> '{mercado_pago,resumo,dias}')::int, 0);
    df := coalesce((p #>> '{mercado_pago,resumo,dias_que_fecham}')::int, 0);
    n  := coalesce((p #>> '{mercado_pago,resumo,sem_par,n}')::int, 0);
    v  := coalesce((p #>> '{mercado_pago,resumo,sem_par,valor}')::numeric, 0);
    if d = 0 then
      s := 'Mercado Pago: ainda sem extrato gravado nos dias da janela.';
    else
      s := 'Mercado Pago fecha com a carteira em ' || df || ' de ' || d || ' dia' || case when d > 1 then 's' else '' end
           || case when coalesce((p #>> '{mercado_pago,resumo,contas}')::int, 1) > 1 then ' (' || (p #>> '{mercado_pago,resumo,contas}') || ' contas)' else '' end
           || case when n > 0 then '; ' || public.fin_conc_brl_curto(v) || ' em ' || n || ' lançamento' || case when n > 1 then 's' else '' end || ' sem par' else '' end || '.';
    end if;
  elsif p -> 'mercado_pago' ? 'erro' then
    s := 'Mercado Pago: conciliação não calculada.';
  end if;

  -- Shopee
  if p -> 'shopee' ? 'lojas' then
    select coalesce(sum((l #>> '{repasse_abaixo,n}')::int + (l #>> '{divergente_com_reembolso,n}')::int), 0),
           coalesce(sum(abs((l #>> '{repasse_abaixo,valor}')::numeric) + abs(least((l #>> '{divergente_com_reembolso,valor}')::numeric, 0))), 0)
      into n, v
    from jsonb_array_elements(p #> '{shopee,lojas}') l;
    parte := case when n > 0 then ' Shopee: ' || n || ' pedido' || case when n > 1 then 's' else '' end || ' com repasse ' || public.fin_conc_brl_curto(v) || ' abaixo do esperado.'
                  else ' Shopee: repasses da janela conferem.' end;
    s := s || parte;
  end if;

  -- Fornecedor (só se couber)
  if p -> 'fornecedor' ? 'sem_contas' then
    n := coalesce((p #>> '{fornecedor,sem_contas,acima_de_500,n}')::int, 0);
    v := coalesce((p #>> '{fornecedor,sem_contas,acima_de_500,valor}')::numeric, 0);
    if n > 0 then
      parte := ' Fornecedor: ' || n || ' nota' || case when n > 1 then 's' else '' end || ' (' || public.fin_conc_brl_curto(v) || ') sem conta lançada.';
      if length(s || parte) <= 175 then s := s || parte; end if;
    end if;
  end if;

  return nullif(btrim(s), '');
end;
$fn$;

-- -------------------------------------------------------------------------------------
create or replace function public.financeiro_conciliacao_html(p jsonb)
returns text
language plpgsql stable
set search_path = public, extensions
as $fn$
declare
  h text := '';
  b jsonb;
  t text;
  r record;
begin
  h := '<h3>Conciliação — ' || to_char((p #>> '{janela,de}')::date, 'DD/MM') || ' a ' || to_char((p #>> '{janela,ate}')::date, 'DD/MM') || '</h3>';
  t := public.financeiro_conciliacao_destaque(p);
  if t is not null then h := h || '<p>' || public.fin_conc_esc(t) || '</p>'; end if;

  -- decisões
  if jsonb_array_length(coalesce(p -> 'decisoes', '[]'::jsonb)) > 0 then
    h := h || '<h3>O que pede ação</h3><table><tr><th>O que fazer</th><th>Detalhe</th><th>Valor</th></tr>';
    for r in select d from jsonb_array_elements(p -> 'decisoes') d loop
      h := h || '<tr><td>' || public.fin_conc_esc(r.d ->> 'o_que') || '</td><td>' || public.fin_conc_esc(r.d ->> 'detalhe') || '</td><td>'
             || case when coalesce((r.d ->> 'valor')::numeric, 0) > 0 then public.fin_conc_brl((r.d ->> 'valor')::numeric) else '—' end || '</td></tr>';
    end loop;
    h := h || '</table>';
  end if;

  -- ---------------- Mercado Pago
  b := p -> 'mercado_pago';
  h := h || '<h3>Mercado Pago: extrato × carteira</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    for r in select c from jsonb_array_elements(b -> 'contas') c loop
      h := h || '<p>Conta ' || public.fin_conc_esc(r.c ->> 'conta') || ': '
             || case when r.c ->> 'ultimo_dia' is null then 'sem extrato gravado ainda'
                     else 'saldo de ' || public.fin_conc_brl((r.c ->> 'saldo')::numeric) || ' no fim de ' || to_char((r.c ->> 'ultimo_dia')::date, 'DD/MM')
                          || ' (extrato desde ' || to_char((r.c ->> 'primeiro_dia')::date, 'DD/MM') || ')' end
             || case when (r.c ->> 'arquivos_aguardando')::int > 0 then '; ' || (r.c ->> 'arquivos_aguardando') || ' arquivo(s) pedido(s) ao Mercado Pago ainda não chegaram' else '' end
             || case when (r.c ->> 'arquivos_com_erro')::int > 0 then '; ' || (r.c ->> 'arquivos_com_erro') || ' arquivo(s) com erro' else '' end || '.</p>';
    end loop;
    if jsonb_array_length(b -> 'por_dia') = 0 then
      h := h || '<p>Nenhum dia da janela tem extrato gravado.</p>';
    else
      h := h || '<table><tr><th>Conta</th><th>Dia</th><th>Saldo inicial</th><th>Entradas</th><th>Saídas</th><th>Saldo final</th><th>Saldo confere</th><th>Pares certos</th><th>Reembolsos</th><th>Só no extrato</th><th>Só na carteira</th><th>Valor diferente</th><th>Saída lançada como entrada</th><th>Saques</th><th>A entender</th></tr>';
      for r in select d from jsonb_array_elements(b -> 'por_dia') d loop
        h := h || '<tr><td>' || public.fin_conc_esc(r.d ->> 'conta') || '</td><td>' || to_char((r.d ->> 'dia')::date, 'DD/MM') || '</td><td>'
               || public.fin_conc_brl((r.d ->> 'saldo_inicial')::numeric) || '</td><td>' || public.fin_conc_brl((r.d ->> 'creditos')::numeric) || '</td><td>'
               || public.fin_conc_brl((r.d ->> 'debitos')::numeric) || '</td><td>' || public.fin_conc_brl((r.d ->> 'saldo_final')::numeric) || '</td><td>'
               || case r.d ->> 'confere_saldo' when 'true' then 'sim' when 'false' then 'NÃO' else 'sem lançamentos' end || '</td><td>' || (r.d ->> 'pares_ok') || '</td><td>'
               || (r.d ->> 'pares_reembolso') || '</td><td>'
               || (r.d #>> '{extrato_sem_carteira,n}') || case when (r.d #>> '{extrato_sem_carteira,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{extrato_sem_carteira,valor}')::numeric) || ')' else '' end || '</td><td>'
               || (r.d #>> '{carteira_sem_extrato,n}') || case when (r.d #>> '{carteira_sem_extrato,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{carteira_sem_extrato,valor}')::numeric) || ')' else '' end || '</td><td>'
               || (r.d #>> '{diferenca_valor,n}') || case when (r.d #>> '{diferenca_valor,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{diferenca_valor,valor}')::numeric) || ')' else '' end || '</td><td>'
               || (r.d #>> '{saida_lancada_como_entrada,n}') || case when (r.d #>> '{saida_lancada_como_entrada,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{saida_lancada_como_entrada,valor}')::numeric) || ')' else '' end || '</td><td>'
               || (r.d #>> '{saques,n}') || case when (r.d #>> '{saques,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{saques,valor}')::numeric) || ')' else '' end || '</td><td>'
               || (r.d #>> '{a_entender,n}') || case when (r.d #>> '{a_entender,n}')::int > 0 then ' (' || public.fin_conc_brl((r.d #>> '{a_entender,valor}')::numeric) || ')' else '' end || '</td></tr>';
      end loop;
      h := h || '</table>';
    end if;
    if coalesce((b #>> '{resumo,saida_lancada_como_entrada,n}')::int, 0) > 0 then
      h := h || '<p>Atenção: ' || (b #>> '{resumo,saida_lancada_como_entrada,n}') || ' pagamento(s) ou transferência(s) feitos pela conta, somando '
             || public.fin_conc_brl((b #>> '{resumo,saida_lancada_como_entrada,valor}')::numeric) || ', estão na carteira como ENTRADA. No extrato são saída. A carteira fica '
             || public.fin_conc_brl((b #>> '{resumo,saida_lancada_como_entrada,erro_na_carteira}')::numeric) || ' acima do que realmente entrou.</p>';
    end if;
    if jsonb_array_length(b -> 'pendencias') > 0 then
      h := h || '<p>Lançamentos sem par (os maiores):</p><table><tr><th>Conta</th><th>Dia</th><th>O que é</th><th>Pagamento</th><th>Pedido</th><th>Extrato</th><th>Carteira</th></tr>';
      for r in select d from jsonb_array_elements(b -> 'pendencias') d loop
        h := h || '<tr><td>' || public.fin_conc_esc(r.d ->> 'conta') || '</td><td>' || to_char((r.d ->> 'dia')::date, 'DD/MM') || '</td><td>' || public.fin_conc_esc(r.d ->> 'descricao')
               || '</td><td>' || public.fin_conc_esc(r.d ->> 'source_id') || '</td><td>' || public.fin_conc_esc(coalesce(r.d ->> 'order_id', '—')) || '</td><td>'
               || public.fin_conc_brl((r.d ->> 'valor_extrato')::numeric) || '</td><td>' || public.fin_conc_brl((r.d ->> 'valor_carteira')::numeric) || '</td></tr>';
      end loop;
      h := h || '</table>';
    end if;
    if jsonb_array_length(b #> '{tipos_sem_par_esperado,observado}') > 0 then
      h := h || '<p>Lançamentos que não contam como divergência:</p><table><tr><th>Onde</th><th>Situação</th><th>Tipo</th><th>Quantos</th><th>Valor</th></tr>';
      for r in select d from jsonb_array_elements(b #> '{tipos_sem_par_esperado,observado}') d loop
        h := h || '<tr><td>' || public.fin_conc_esc(r.d ->> 'lado') || '</td><td>'
               || case r.d ->> 'situacao' when 'frete_avulso' then 'frete cobrado ou devolvido à parte (esperado)'
                    when 'reserva_zerada' then 'bloqueio que entra e sai no dia (esperado)'
                    when 'reserva_aberta' then 'bloqueio ou desbloqueio de saldo (esperado)'
                    when 'transferencia_propria' then 'transferência para a nossa outra conta (esperado)'
                    when 'saque' then 'saque para o banco (esperado)'
                    when 'reembolso' then 'reembolso: par encontrado, valor não comparado'
                    else 'a entender' end
               || '</td><td>' || public.fin_conc_esc(r.d ->> 'tipo') || '</td><td>' || (r.d ->> 'n') || '</td><td>' || public.fin_conc_brl((r.d ->> 'valor')::numeric) || '</td></tr>';
      end loop;
      h := h || '</table>';
    end if;
    for r in select e from jsonb_array_elements_text(b #> '{tipos_sem_par_esperado,explicacao}') e loop
      h := h || '<p>' || public.fin_conc_esc(r.e) || '</p>';
    end loop;
  end if;

  -- ---------------- Shopee
  b := p -> 'shopee';
  h := h || '<h3>Shopee: repasse esperado × recebido</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    h := h || '<table><tr><th>Loja</th><th>Pedidos creditados</th><th>Conferem</th><th>Receberam menos</th><th>Receberam mais</th><th>Com reembolso</th><th>Só reembolso, sem crédito</th><th>30 a 60 dias sem crédito</th></tr>';
    for r in select l from jsonb_array_elements(b -> 'lojas') l loop
      h := h || '<tr><td>' || public.fin_conc_esc(r.l ->> 'loja') || '</td><td>' || (r.l ->> 'pedidos_creditados') || '</td><td>' || (r.l ->> 'conciliados') || '</td><td>'
             || (r.l #>> '{repasse_abaixo,n}') || ' (' || public.fin_conc_brl((r.l #>> '{repasse_abaixo,valor}')::numeric) || ')</td><td>'
             || (r.l #>> '{repasse_acima,n}') || ' (' || public.fin_conc_brl((r.l #>> '{repasse_acima,valor}')::numeric) || ')</td><td>'
             || (r.l #>> '{divergente_com_reembolso,n}') || ' (' || public.fin_conc_brl((r.l #>> '{divergente_com_reembolso,valor}')::numeric) || ')</td><td>'
             || (r.l #>> '{so_reembolso_sem_credito,n}') || ' (' || public.fin_conc_brl((r.l #>> '{so_reembolso_sem_credito,valor}')::numeric) || ')</td><td>'
             || (r.l #>> '{sem_credito_30_a_60_dias,n}') || ' (' || public.fin_conc_brl((r.l #>> '{sem_credito_30_a_60_dias,valor}')::numeric) || ')</td></tr>';
    end loop;
    h := h || '</table>';
    for r in select l from jsonb_array_elements(b -> 'lojas') l where jsonb_array_length(l -> 'maiores') > 0 loop
      h := h || '<p>Maiores diferenças — ' || public.fin_conc_esc(r.l ->> 'loja') || ':</p><table><tr><th>Pedido</th><th>Data</th><th>Esperado</th><th>Recebido</th><th>Diferença</th></tr>';
      h := h || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'pedido_id') || '</td><td>' || to_char((m ->> 'data_pedido')::date, 'DD/MM') || '</td><td>'
                   || public.fin_conc_brl((m ->> 'esperado')::numeric) || '</td><td>' || public.fin_conc_brl((m ->> 'recebido')::numeric) || '</td><td>'
                   || public.fin_conc_brl((m ->> 'diferenca')::numeric) || '</td></tr>', '') from jsonb_array_elements(r.l -> 'maiores') m);
      h := h || '</table>';
      h := h || '<p>' || public.fin_conc_esc(r.l ->> 'loja') || ', 30 a 60 dias sem crédito: ' || public.fin_conc_esc(r.l #>> '{sem_credito_30_a_60_dias,nota}') || '.</p>';
    end loop;
    h := h || '<p>' || public.fin_conc_esc(b ->> 'nota') || '</p>';
  end if;

  -- ---------------- Fornecedor
  b := p -> 'fornecedor';
  h := h || '<h3>Fornecedor: nota × ordem de compra × contas a pagar</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    h := h || '<p>' || (b #>> '{notas,n}') || ' notas de fornecedor em 60 dias (' || public.fin_conc_brl((b #>> '{notas,valor}')::numeric) || '); '
           || (b #>> '{notas,novas_na_janela}') || ' novas na janela. Sem ordem de compra: ' || (b #>> '{sem_ordem,n}') || ' ('
           || public.fin_conc_brl((b #>> '{sem_ordem,valor}')::numeric) || '), das quais ' || (b #>> '{sem_ordem,acima_de_500,n}') || ' acima de R$ 500. Sem conta a pagar que cite a nota: '
           || (b #>> '{sem_contas,n}') || ' (' || public.fin_conc_brl((b #>> '{sem_contas,valor}')::numeric) || '), das quais ' || (b #>> '{sem_contas,acima_de_500,n}')
           || ' acima de R$ 500 (' || public.fin_conc_brl((b #>> '{sem_contas,acima_de_500,valor}')::numeric) || ').</p>';
    if jsonb_array_length(b #> '{sem_contas,maiores}') > 0 then
      h := h || '<p>Notas sem conta a pagar (as maiores):</p><table><tr><th>Fornecedor</th><th>Nota</th><th>Emissão</th><th>Valor</th><th>Ordem</th></tr>'
             || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'fornecedor') || '</td><td>' || public.fin_conc_esc(m ->> 'nota') || '</td><td>'
                   || to_char((m ->> 'data_emissao')::date, 'DD/MM') || '</td><td>' || public.fin_conc_brl((m ->> 'valor')::numeric) || '</td><td>'
                   || public.fin_conc_esc(coalesce(m ->> 'ordem', 'sem ordem')) || '</td></tr>', '') from jsonb_array_elements(b #> '{sem_contas,maiores}') m)
             || '</table><p>' || public.fin_conc_esc(b #>> '{sem_contas,nota}') || '</p>';
    end if;
    if jsonb_array_length(b #> '{diferenca_ordem,casos}') > 0 then
      h := h || '<p>Ordens em que a soma das notas difere do pedido:</p><table><tr><th>Ordem</th><th>Fornecedor</th><th>Pedido</th><th>Notas</th><th>Diferença</th><th>Notas nº</th></tr>'
             || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'ordem') || '</td><td>' || public.fin_conc_esc(m ->> 'fornecedor') || '</td><td>'
                   || public.fin_conc_brl((m ->> 'valor_ordem')::numeric) || '</td><td>' || public.fin_conc_brl((m ->> 'valor_notas')::numeric) || '</td><td>'
                   || public.fin_conc_brl((m ->> 'diferenca')::numeric) || '</td><td>' || public.fin_conc_esc(m ->> 'notas') || '</td></tr>', '') from jsonb_array_elements(b #> '{diferenca_ordem,casos}') m)
             || '</table><p>Nota abaixo da ordem pode ser entrega parcial (ainda falta nota).</p>';
    end if;
    if jsonb_array_length(b #> '{contas_diferentes_da_nota,casos}') > 0 then
      h := h || '<p>Contas lançadas com valor diferente da nota:</p><table><tr><th>Fornecedor</th><th>Nota</th><th>Valor da nota</th><th>Contas</th><th>Diferença</th></tr>'
             || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'fornecedor') || '</td><td>' || public.fin_conc_esc(m ->> 'nota') || '</td><td>'
                   || public.fin_conc_brl((m ->> 'valor_nota')::numeric) || '</td><td>' || public.fin_conc_brl((m ->> 'valor_contas')::numeric) || '</td><td>'
                   || public.fin_conc_brl((m ->> 'diferenca')::numeric) || '</td></tr>', '') from jsonb_array_elements(b #> '{contas_diferentes_da_nota,casos}') m)
             || '</table>';
    end if;
    if jsonb_array_length(b #> '{sem_ordem,maiores}') > 0 then
      h := h || '<p>Notas sem ordem de compra (as maiores):</p><table><tr><th>Fornecedor</th><th>Nota</th><th>Emissão</th><th>Valor</th></tr>'
             || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'fornecedor') || '</td><td>' || public.fin_conc_esc(m ->> 'nota') || '</td><td>'
                   || to_char((m ->> 'data_emissao')::date, 'DD/MM') || '</td><td>' || public.fin_conc_brl((m ->> 'valor')::numeric) || '</td></tr>', '') from jsonb_array_elements(b #> '{sem_ordem,maiores}') m)
             || '</table>';
    end if;
  end if;

  -- ---------------- Devoluções
  b := p -> 'devolucoes';
  h := h || '<h3>Devoluções: reembolso × produto × nota de devolução</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    h := h || '<p>Shopee, 30 dias: ' || (b #>> '{shopee_30_dias,casos}') || ' casos; reembolsado ao cliente ' || public.fin_conc_brl((b #>> '{shopee_30_dias,reembolsado}')::numeric)
           || '; descontado de nós ' || public.fin_conc_brl((b #>> '{shopee_30_dias,descontado_de_nos}')::numeric) || '; a Shopee compensou '
           || public.fin_conc_brl((b #>> '{shopee_30_dias,compensado_pela_shopee}')::numeric) || '; saiu do bolso ' || public.fin_conc_brl((b #>> '{shopee_30_dias,saiu_do_bolso}')::numeric)
           || '. Em andamento ou em disputa: ' || (b #>> '{em_andamento,n}') || ' (' || public.fin_conc_brl((b #>> '{em_andamento,valor}')::numeric) || ').</p>';
    h := h || '<table><tr><th>Como terminou</th><th>Casos</th><th>Reembolsado</th><th>Descontado de nós</th><th>Compensado</th><th>Produto recebido</th></tr>'
           || coalesce((select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'classe') || '</td><td>' || (m ->> 'n') || '</td><td>' || public.fin_conc_brl((m ->> 'reembolsado')::numeric)
                 || '</td><td>' || public.fin_conc_brl((m ->> 'descontado')::numeric) || '</td><td>' || public.fin_conc_brl((m ->> 'compensado')::numeric) || '</td><td>'
                 || (m ->> 'produto_recebido') || '</td></tr>', '') from jsonb_array_elements(b #> '{shopee_30_dias,por_classe}') m), '') || '</table>';
    h := h || '<p>Produto que deveria ter voltado e não deu entrada: ' || (b #>> '{produto_nao_voltou,n}') || ' (' || public.fin_conc_brl((b #>> '{produto_nao_voltou,custo_do_produto}')::numeric)
           || ' a custo). ' || public.fin_conc_esc(b #>> '{produto_nao_voltou,criterio}') || '.</p>';
    if jsonb_array_length(b #> '{produto_nao_voltou,maiores}') > 0 then
      h := h || '<table><tr><th>Pedido</th><th>Loja</th><th>Desde</th><th>Custo</th></tr>'
             || (select string_agg('<tr><td>' || public.fin_conc_esc(m ->> 'pedido') || '</td><td>' || public.fin_conc_esc(coalesce(m ->> 'loja', '—')) || '</td><td>'
                   || to_char((m ->> 'desde')::date, 'DD/MM') || '</td><td>' || public.fin_conc_brl((m ->> 'custo')::numeric) || '</td></tr>', '') from jsonb_array_elements(b #> '{produto_nao_voltou,maiores}') m)
             || '</table>';
    end if;
    h := h || '<p>Notas de devolução — SVL: ' || (b #>> '{nota_de_devolucao,svl_aguardando_emissao,n}') || ' na fila de emissão ('
           || public.fin_conc_brl((b #>> '{nota_de_devolucao,svl_aguardando_emissao,valor}')::numeric) || '), ' || (b #>> '{nota_de_devolucao,svl_rejeitadas,n}') || ' rejeitadas ('
           || public.fin_conc_brl((b #>> '{nota_de_devolucao,svl_rejeitadas,valor}')::numeric) || ') e ' || (b #>> '{nota_de_devolucao,svl_para_revisar,n}') || ' para revisar. Ottz: '
           || (b #>> '{nota_de_devolucao,ottz_para_revisar,n}') || ' para revisar e ' || (b #>> '{nota_de_devolucao,ottz_cancelados_com_nota_sem_devolucao,n}')
           || ' pedidos cancelados com nota de venda e sem nota de devolução (' || public.fin_conc_brl((b #>> '{nota_de_devolucao,ottz_cancelados_com_nota_sem_devolucao,valor}')::numeric) || ').</p>';
  end if;

  -- ---------------- Fluxo
  b := p -> 'fluxo';
  h := h || '<h3>Fluxo de caixa: previsto × realizado</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    h := h || '<table><tr><th>Dia</th><th>Previsto</th><th>Realizado</th><th>Desvio</th><th>%</th></tr>'
           || (select string_agg('<tr><td>' || to_char((m ->> 'dia')::date, 'DD/MM') || '</td><td>' || public.fin_conc_brl((m ->> 'previsto')::numeric) || '</td><td>'
                 || public.fin_conc_brl((m ->> 'realizado')::numeric) || '</td><td>' || public.fin_conc_brl((m ->> 'desvio')::numeric) || '</td><td>'
                 || coalesce(replace(m ->> 'desvio_pct', '.', ',') || '%', '—') || '</td></tr>', '' order by m ->> 'dia') from jsonb_array_elements(b -> 'por_dia') m)
           || '<tr><td>Acumulado</td><td>' || public.fin_conc_brl((b #>> '{acumulado,previsto}')::numeric) || '</td><td>' || public.fin_conc_brl((b #>> '{acumulado,realizado}')::numeric)
           || '</td><td>' || public.fin_conc_brl((b #>> '{acumulado,desvio}')::numeric) || '</td><td>' || coalesce(replace(b #>> '{acumulado,desvio_pct}', '.', ',') || '%', '—') || '</td></tr></table>';
    if coalesce((b #>> '{saidas_do_mercado_pago_contadas_como_entrada,n}')::int, 0) > 0 then
      h := h || '<p>O realizado inclui ' || public.fin_conc_brl((b #>> '{saidas_do_mercado_pago_contadas_como_entrada,valor}')::numeric)
             || ' de pagamentos feitos pela conta do Mercado Pago que a carteira lança como entrada (ver o bloco do Mercado Pago).</p>';
    end if;
    if coalesce((b #>> '{realizado_que_nao_e_venda,n}')::int, 0) > 0 then
      h := h || '<p>Do realizado, ' || public.fin_conc_brl((b #>> '{realizado_que_nao_e_venda,valor}')::numeric) || ' em ' || (b #>> '{realizado_que_nao_e_venda,n}')
             || ' lançamento(s) são ' || public.fin_conc_esc(b #>> '{realizado_que_nao_e_venda,nota}') || '.</p>';
    end if;
    if jsonb_array_length(b -> 'maiores_entradas') > 0 then
      h := h || '<p>Maiores entradas da janela:</p><table><tr><th>Dia</th><th>Onde</th><th>Tipo</th><th>Descrição</th><th>Valor</th></tr>'
             || (select string_agg('<tr><td>' || to_char((m ->> 'dia')::date, 'DD/MM') || '</td><td>' || public.fin_conc_esc(m ->> 'marketplace') || '</td><td>'
                   || public.fin_conc_esc(coalesce(m ->> 'tipo', '') || ' / ' || coalesce(m ->> 'classificacao', '')) || '</td><td>' || public.fin_conc_esc(coalesce(m ->> 'descricao', '—'))
                   || '</td><td>' || public.fin_conc_brl((m ->> 'valor')::numeric) || '</td></tr>', '') from jsonb_array_elements(b -> 'maiores_entradas') m)
             || '</table>';
    end if;
    h := h || '<p>' || public.fin_conc_esc(b ->> 'nota') || '</p>';
  end if;

  -- ---------------- Contas pagas
  b := p -> 'contas_pagas';
  h := h || '<h3>Contas pagas: qualidade do cadastro</h3>';
  if b ? 'erro' then
    h := h || '<p>Não foi possível calcular: ' || public.fin_conc_esc(b ->> 'erro') || '</p>';
  elsif b ? 'indisponivel' then
    h := h || '<p>' || public.fin_conc_esc(b ->> 'indisponivel') || '</p>';
  else
    h := h || '<p>' || (b ->> 'pagas') || ' contas pagas no cadastro. Sem data de pagamento: ' || (b #>> '{sem_data_pagamento,n}') || ' ('
           || public.fin_conc_brl((b #>> '{sem_data_pagamento,valor}')::numeric) || '), das quais ' || (b #>> '{sem_data_pagamento,vencidas_nos_ultimos_90_dias}')
           || ' com vencimento nos últimos 90 dias. Sem conta bancária: ' || (b #>> '{sem_conta_bancaria,n}') || '. Pagas na janela: ' || (b #>> '{pagas_na_janela,n}') || ' ('
           || public.fin_conc_brl((b #>> '{pagas_na_janela,valor}')::numeric) || '). Pagas com valor diferente do título (90 dias): ' || (b #>> '{pago_diferente_do_valor_90_dias,n}') || ' ('
           || public.fin_conc_brl((b #>> '{pago_diferente_do_valor_90_dias,valor}')::numeric) || ').</p><p>' || public.fin_conc_esc(b ->> 'nota') || '</p>';
  end if;

  if jsonb_array_length(coalesce(p #> '{resumo,blocos_com_erro}', '[]'::jsonb)) > 0 then
    h := h || '<p>Blocos que não puderam ser calculados: ' || public.fin_conc_esc((select string_agg(e, ', ') from jsonb_array_elements_text(p #> '{resumo,blocos_com_erro}') e)) || '.</p>';
  end if;

  return h;
end;
$fn$;

revoke all on function public.financeiro_conciliacao(integer) from public, anon, authenticated;
revoke all on function public.financeiro_conciliacao_html(jsonb) from public, anon, authenticated;
revoke all on function public.financeiro_conciliacao_destaque(jsonb) from public, anon, authenticated;
revoke all on function public.fin_conc_brl(numeric) from public, anon, authenticated;
revoke all on function public.fin_conc_brl_curto(numeric) from public, anon, authenticated;
revoke all on function public.fin_conc_esc(text) from public, anon, authenticated;
