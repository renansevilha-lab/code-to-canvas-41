-- Devolução automática da Ottz/ACZ — só vendas do Lucro Real (26/nov/2026, pedido do dono)
-- Natureza no Tiny: "Devolução de Venda de Mercadoria - Lucro Real" (nf-devolucao v3.27; série 20, regime 3).
-- Motor: devolucao-auto v11 ?modulo=processar-historico&conta=ottz (cria e emite na mesma rodada; 656 pausa 1 h).
-- Cron 196 devolucao-hist-criar-ottz '4-54/10 * * * *' max=6 orcamento=25.
-- Migração: devolucao_auto_candidatos_ottz.
-- Rollback: select cron.unschedule('devolucao-hist-criar-ottz'); drop view public.view_devolucao_auto_candidatos_ottz;
--           e republicar nf-devolucao v3.26 / devolucao-auto v10 (git).

create or replace view public.view_devolucao_auto_candidatos_ottz as
 WITH dev_fiscal AS (
         SELECT DISTINCT unnest(fiscal_nfe.ref_nfe) AS chave
           FROM fiscal_nfe
          WHERE fiscal_nfe.fin_nfe = '4'::smallint AND fiscal_nfe.emit_doc = '37393638000140'::text AND COALESCE(fiscal_nfe.cancelada, false) = false
        ), canc AS (
         SELECT nc.numero_ecommerce AS order_sn, nc.tiny_pedido_id, nc.marca_canal AS canal,
                CASE
                    WHEN p.motivo_cancelamento ~~* 'Parcel lost%'::text THEN 'extravio'::text
                    WHEN p.motivo_cancelamento = ANY (ARRAY['Failed Delivery'::text, 'shipment_not_delivered'::text]) THEN 'falha_entrega'::text
                    ELSE 'cancelado'::text
                END AS caso,
            nc.data_emissao_nf::timestamp with time zone AS data_ref, nc.id_nota_fiscal AS id_nota_venda, nc.chave_nfe, 1 AS prioridade
           FROM notas_cancelados nc
             LEFT JOIN pedidos p ON p.id = nc.numero_ecommerce
          WHERE nc.finalidade_nf = '1'::text AND nc.id_nota_fiscal IS NOT NULL AND (nc.situacao_nf = ANY (ARRAY['6'::text, '7'::text]))
            AND substr(nc.chave_nfe, 7, 14) = '37393638000140'::text AND nc.data_emissao_nf >= '2026-08-10'::date
            AND nc.numero_ecommerce IS NOT NULL AND nc.id_nota_devolucao IS NULL
            AND COALESCE(p.motivo_cancelamento, ''::text) <> 'Unpaid Order'::text
            AND NOT (EXISTS ( SELECT 1 FROM dev_fiscal d WHERE d.chave = nc.chave_nfe))
        ), reemb AS (
         SELECT d.order_sn, pt.tiny_pedido_id, pt.marca_canal AS canal,
                CASE WHEN d.solucao = 0 THEN 'reembolso_produto'::text ELSE 'reembolso_dinheiro'::text END AS caso,
            d.create_time AS data_ref, NULL::bigint AS id_nota_venda, NULL::text AS chave_nfe, 2 AS prioridade
           FROM ( SELECT DISTINCT ON (shopee_devolucoes.order_sn) shopee_devolucoes.order_sn, shopee_devolucoes.solucao, shopee_devolucoes.create_time
                   FROM shopee_devolucoes
                  WHERE shopee_devolucoes.shop_id = 522186766 AND shopee_devolucoes.status = 'ACCEPTED'::text AND shopee_devolucoes.solucao IS NOT NULL
                    AND shopee_devolucoes.create_time >= '2026-08-10 00:00:00+00'::timestamp with time zone
                  ORDER BY shopee_devolucoes.order_sn, shopee_devolucoes.create_time DESC) d
             JOIN pedidos_tiny pt ON pt.numero_ecommerce = d.order_sn
          WHERE pt.situacao <> 'cancelada'::text
        ), todos AS (
         SELECT DISTINCT ON (u.order_sn) u.order_sn, u.tiny_pedido_id, u.canal, u.caso, u.data_ref, u.id_nota_venda, u.chave_nfe, u.prioridade
           FROM ( SELECT * FROM canc UNION ALL SELECT * FROM reemb) u
          ORDER BY u.order_sn, u.prioridade
        )
 SELECT t.order_sn, t.tiny_pedido_id, t.canal, t.caso, t.data_ref, t.id_nota_venda, t.chave_nfe, a.estado AS estado_atual, a.tentativas
   FROM todos t
     LEFT JOIN devolucao_auto a ON a.conta = 'ottz'::text AND a.order_sn = t.order_sn
  WHERE a.order_sn IS NULL OR (a.estado = ANY (ARRAY['pendente'::text, 'erro'::text])) AND COALESCE(a.proxima_em, now()) <= now();

revoke all on public.view_devolucao_auto_candidatos_ottz from anon;
grant select on public.view_devolucao_auto_candidatos_ottz to authenticated, service_role;
