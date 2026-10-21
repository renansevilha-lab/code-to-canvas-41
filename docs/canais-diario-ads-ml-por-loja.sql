-- ============================================================================
-- mv_canais_diario: ADS do ML só na conta ACZ + nome certo das contas SVL (21/out/2026)
--
-- O ADS do Mercado Livre (ml_ads_diario) é só da conta Ottz/ACZ (1107117809) e não tem coluna de conta.
-- A MV juntava ml_ads_diario em TODO pedido mercadolivre pela data: nos dias em que a conta SVL do ML
-- (1299638625) vendia, ela recebia o MESMO gasto da ACZ (em 180 dias: R$ 4.271,58 a mais; 7 dias: R$ 792
-- de ADS sobre R$ 157 de venda). Era a armadilha já descrita no CLAUDE.md §3 (dashboard_visao_geral).
-- Também: ML SVL saía "Mercado Livre · Ottz" e Amazon SVL (900002) "Amazon · Ottz".
-- Receita, pedidos, CMV e margem não mudam (conferido por shop_id antes/depois).
-- Rollback: recriar com a definição anterior (join ml sem o shop_id e os rótulos antigos).
-- ============================================================================

drop view public.view_canais_diario;
drop materialized view public.mv_canais_diario;

create materialized view public.mv_canais_diario as
 WITH ped AS (
         SELECT
                CASE
                    WHEN p.marketplace = 'shopee' AND p.shop_id = 522186766 THEN 'Shopee · Ottz Pet'
                    WHEN p.marketplace = 'shopee' AND p.shop_id = 759046323 THEN 'Shopee · SVL Store'
                    WHEN p.marketplace = 'mercadolivre' AND p.shop_id = 1299638625 THEN 'Mercado Livre · SVL Store'
                    WHEN p.marketplace = 'mercadolivre' THEN 'Mercado Livre · Ottz'
                    WHEN p.marketplace = 'amazon' AND p.shop_id = 900002 THEN 'Amazon · SVL Store'
                    WHEN p.marketplace = 'amazon' THEN 'Amazon · Ottz'
                    ELSE initcap(p.marketplace)
                END AS canal,
            p.marketplace,
            p.shop_id,
            (p.data_pedido AT TIME ZONE 'America/Sao_Paulo')::date AS data,
            count(*) AS pedidos,
            sum(p.subtotal_produtos) AS receita,
            sum(p.subtotal_produtos) FILTER (WHERE p.cmv_total > 0 AND p.recebido_estimado IS NOT NULL) AS receita_com_custo,
            sum(p.cmv_total) FILTER (WHERE p.cmv_total > 0 AND p.recebido_estimado IS NOT NULL) AS cmv,
            sum(p.renda_estimada) FILTER (WHERE p.cmv_total > 0 AND p.recebido_estimado IS NOT NULL) AS margem
           FROM pedidos_validos p
          WHERE p.data_pedido >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - '180 days'::interval)
          GROUP BY 1, p.marketplace, p.shop_id, 4
        ), ads AS (
         SELECT shopee_ads_diario.shop_id, shopee_ads_diario.data, sum(shopee_ads_diario.gasto) AS ads
           FROM shopee_ads_diario
          GROUP BY shopee_ads_diario.shop_id, shopee_ads_diario.data
        )
 SELECT pd.canal, pd.marketplace, pd.shop_id, pd.data, pd.pedidos,
    round(pd.receita, 2) AS receita,
    round(COALESCE(pd.receita_com_custo, 0), 2) AS receita_com_custo,
    round(COALESCE(pd.cmv, 0), 2) AS cmv,
    round(COALESCE(pd.margem, 0), 2) AS margem,
    round(COALESCE(a.ads, ml.gasto, 0), 2) AS ads
   FROM ped pd
     LEFT JOIN ads a ON a.shop_id = pd.shop_id AND a.data = pd.data AND pd.marketplace = 'shopee'
     -- ADS do ML é só da conta ACZ (ml_ads_diario não tem conta)
     LEFT JOIN ml_ads_diario ml ON pd.marketplace = 'mercadolivre' AND pd.shop_id = 1107117809 AND ml.data = pd.data
UNION ALL
 SELECT 'TikTok · ACZ Pet' AS canal, 'tiktok' AS marketplace, t.shop_id,
    (t.data_pedido AT TIME ZONE 'America/Sao_Paulo')::date AS data,
    count(*) AS pedidos,
    round(sum(t.venda), 2) AS receita,
    round(COALESCE(sum(t.venda) FILTER (WHERE t.cobertura_cmv = 'completo'), 0), 2) AS receita_com_custo,
    round(COALESCE(sum(t.custo_prod) FILTER (WHERE t.cobertura_cmv = 'completo'), 0), 2) AS cmv,
    round(COALESCE(sum(t.margem) FILTER (WHERE t.cobertura_cmv = 'completo'), 0), 2) AS margem,
    0::numeric AS ads
   FROM view_margem_tiktok t
  WHERE t.data_pedido >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - '180 days'::interval)
  GROUP BY t.shop_id, 4;

create unique index mv_canais_diario_uk on public.mv_canais_diario (canal, shop_id, data);
create index mv_canais_diario_data on public.mv_canais_diario (data);
revoke all on public.mv_canais_diario from anon, public;

create view public.view_canais_diario as
 select canal, marketplace, shop_id, data, pedidos, receita, receita_com_custo, cmv, margem, ads
 from public.mv_canais_diario;
revoke all on public.view_canais_diario from anon, public;
grant select on public.view_canais_diario to authenticated, service_role;
