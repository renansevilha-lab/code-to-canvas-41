-- ============================================================================
-- DRE — linha "Antecipação Shopee Acelera" sem os ajustes de pedidos cancelados/devolvidos (29/out/2026, opção A do dono)
-- Migração aplicada: dre_acelera_sem_cancelados_devolvidos. Baseline antes: _bkp_dre_mensal_acelera_29out.
--
-- Achado (29/out): na carteira da Shopee NÃO existe lançamento de taxa/juros de antecipação. Só há os resgates
-- (FAST_ESCROW_DISBURSE, R$ 423,4 mil em 21 resgates, mai–set) e o "Ajuste do Shopee Acelera" por pedido
-- (FAST_ESCROW_DEDUCT, R$ 18,9 mil). Desses ajustes, ~R$ 11,6 mil são de pedido cancelado/devolvido (a Shopee pega
-- de volta o adiantamento — na mediana, o valor inteiro do pedido) e o resto, de pedido concluído que fechou com
-- valor menor que o adiantado (3–15%, sem relação com os dias antecipados — não é juros).
-- O DRE somava tudo como despesa → contava duas vezes a devolução (a receita desses pedidos já entra zerada/reduzida).
-- Resultado: despesa mai–set R$ 18.226,86 → R$ 6.661,33; nada mais mudou no DRE (receita, CMV, ADS etc. idênticos).
-- ============================================================================
create or replace view view_dre_acelera as
with t as (
  select t.data, t.shop_id, t.tipo, t.valor, t.pedido_id,
    (t.tipo = 'antecipacao_taxa' and t.pedido_id is not null and (
        exists (select 1 from shopee_devolucoes sd where sd.order_sn = t.pedido_id)
        or exists (select 1 from pedidos p where p.id = t.pedido_id and p.status_pedido in ('CANCELLED','TO_RETURN','UNPAID'))
    )) as devolvido
  from transacoes_carteira t
  where t.marketplace ~~* '%shopee%' and t.tipo = any (array['antecipacao_taxa','antecipacao_credito'])
)
select to_char(date_trunc('month', (data at time zone 'America/Sao_Paulo')), 'YYYY-MM') as mes,
  case shop_id when 522186766 then 'Shopee (ACZ Pet)' when 759046323 then 'Shopee (SVL Store)'
       else 'Shopee (' || shop_id || ')' end as canal,
  round(coalesce(sum(abs(valor)) filter (where tipo = 'antecipacao_taxa' and not devolvido), 0), 2) as taxa,
  count(*) filter (where tipo = 'antecipacao_taxa' and not devolvido) as lancamentos,
  round(sum(abs(valor)) filter (where tipo = 'antecipacao_credito'), 2) as valor_antecipado,
  round(sum(abs(valor)) filter (where tipo = 'antecipacao_taxa'), 2) as ajuste_bruto,
  round(coalesce(sum(abs(valor)) filter (where tipo = 'antecipacao_taxa' and devolvido), 0), 2) as devolvido_cancelado,
  count(*) filter (where tipo = 'antecipacao_taxa' and devolvido) as lancamentos_devolvidos
from t
group by 1, 2;

-- ROLLBACK: as colunas novas não podem sair com create or replace; para voltar exatamente, drop + recriar a de antes
-- E a view_dre_mensal (depende dela). A regra antiga era: taxa = sum(abs(valor)) filter (where tipo = 'antecipacao_taxa'),
-- lancamentos = count(*) filter (where tipo = 'antecipacao_taxa'). O mais simples é manter a view e trocar as duas
-- expressões de volta (sem o "and not devolvido").
