-- Crons 43 (refresh-cmv-materializado, 00:00 BRT) e 46 (recalcular-margem, 00:20 BRT)
-- PREPARADO em 13/out/2026 — NÃO APLICADO. Aplicar = rodar o bloco "APLICAR" (vale na rodada da meia-noite).
--
-- Problema: os dois reescrevem TODOS os pedidos dos últimos 90 dias toda noite, mesmo quando o
-- valor não mudou. Medido em 13/out: cron 43 = UPDATE 37.745 (43 s); cron 46 = dois UPDATEs de
-- ~37.077 cada (13 s). São ~111 mil versões de linha por noite para mudar, na prática, 4 linhas
-- (simulação do cron 46 no mesmo dia: imposto mudaria em 3 pedidos, renda em 1). É o que fazia
-- a tabela `pedidos` ocupar 40 MB para 17 MB de dado vivo (compactada em 13/out: 54 → 25 MB) e
-- inchava os 10 índices dela.
--
-- Mudança: o mesmo cálculo, gravando só a linha cujo valor é diferente (IS DISTINCT FROM).
-- Resultado nas colunas: idêntico. Efeito colateral único: `pedidos.atualizado_em` (gatilho
-- trg_pedidos_atualizado) deixa de ser carimbado toda noite em pedido que não mudou — nenhuma
-- view, função ou cron do banco usa esse campo como filtro (só exibição: view_fluxo_caixa_fontes
-- usa o max(), view_margem_pedido_v2 mostra a coluna).
-- Como conferir depois da 1ª noite: cron.job_run_details dos jobs 43 e 46 deve mostrar
-- "UPDATE" com poucas dezenas de linhas, e a duração deve cair.

-- ============================== APLICAR ==============================
select cron.alter_job(43, command := $cmd$
  UPDATE pedidos p
     SET cmv_total = c.cmv_total,
         cmv_incompleto = COALESCE(c.itens_sem_cmv,0) > 0
    FROM view_cmv_pedido c
   WHERE c.pedido_id = p.id
     AND p.data_pedido >= CURRENT_DATE - INTERVAL '90 days'
     AND (p.cmv_total IS DISTINCT FROM c.cmv_total
          OR p.cmv_incompleto IS DISTINCT FROM (COALESCE(c.itens_sem_cmv,0) > 0));
$cmd$);

select cron.alter_job(46, command := $cmd$
  UPDATE pedidos p
  SET imposto_estimado = ROUND(p.subtotal_produtos * COALESCE(
        (select l.aliquota_imposto from lojas l where l.shop_id = p.shop_id),
        CASE WHEN p.fonte LIKE '%46176256000155%' THEN 0.075 ELSE 0.10 END), 2)
  WHERE p.valido = true AND p.subtotal_produtos > 0
    AND p.data_pedido >= CURRENT_DATE - INTERVAL '90 days'
    AND p.imposto_estimado IS DISTINCT FROM ROUND(p.subtotal_produtos * COALESCE(
        (select l.aliquota_imposto from lojas l where l.shop_id = p.shop_id),
        CASE WHEN p.fonte LIKE '%46176256000155%' THEN 0.075 ELSE 0.10 END), 2);

  UPDATE pedidos
  SET renda_estimada = ROUND(COALESCE(recebido_estimado,0) - COALESCE(cmv_total,0) - COALESCE(imposto_estimado,0), 2)
  WHERE valido = true AND recebido_estimado IS NOT NULL AND subtotal_produtos > 0
    AND data_pedido >= CURRENT_DATE - INTERVAL '90 days'
    AND renda_estimada IS DISTINCT FROM ROUND(COALESCE(recebido_estimado,0) - COALESCE(cmv_total,0) - COALESCE(imposto_estimado,0), 2);
$cmd$);

-- ============================== VOLTAR (comandos como estavam em 13/out) ==============================
-- select cron.alter_job(43, command := $cmd$
--   UPDATE pedidos p
--      SET cmv_total = c.cmv_total,
--          cmv_incompleto = COALESCE(c.itens_sem_cmv,0) > 0
--      FROM view_cmv_pedido c
--      WHERE c.pedido_id = p.id
--        AND p.data_pedido >= CURRENT_DATE - INTERVAL '90 days';
-- $cmd$);
-- select cron.alter_job(46, command := $cmd$
--   UPDATE pedidos p
--   SET imposto_estimado = ROUND(p.subtotal_produtos * COALESCE(
--         (select l.aliquota_imposto from lojas l where l.shop_id = p.shop_id),
--         CASE WHEN p.fonte LIKE '%46176256000155%' THEN 0.075 ELSE 0.10 END), 2)
--   WHERE p.valido = true AND p.subtotal_produtos > 0
--     AND p.data_pedido >= CURRENT_DATE - INTERVAL '90 days';
--
--   UPDATE pedidos
--   SET renda_estimada = ROUND(COALESCE(recebido_estimado,0) - COALESCE(cmv_total,0) - COALESCE(imposto_estimado,0), 2)
--   WHERE valido = true AND recebido_estimado IS NOT NULL AND subtotal_produtos > 0
--     AND data_pedido >= CURRENT_DATE - INTERVAL '90 days';
-- $cmd$);
