-- Margem do Flex (ML self_service) com o crédito de frete do ML e o custo da transportadora (SOS Envios Express)
-- Aplicado em 26/nov/2026 (opção A do dono). Migrações: flex_frete_fatura, flex_frete_pedido_funcao, margem_flex_transportadora.
--
-- Antes: a margem do Flex = recebido_estimado − CMV − imposto. O recebido NÃO tem o crédito de frete que o ML paga ao
-- vendedor no Flex nem o custo da transportadora, que é paga à parte (fatura quinzenal da SOS, P 10,99 / G1 21,98 / G2 32,97).
-- Agora, só nos pedidos ML self_service:
--   recebido_estimado (e margem, mc_pct, custo_pct, roi) = recebido + crédito − custo;  custo_total = custo_total − (crédito − custo)
--   colunas novas no fim: frete_flex_credito, frete_flex_custo, frete_flex_origem ('extrato|estimado' / 'fatura|estimado')
--
-- CRÉDITO do ML (por envio; carrinho = dividido igual entre os pedidos):
--   real = soma do que o extrato do Mercado Pago liberou para os pedidos (descricao payment + shipping) − recebido_estimado.
--   ARMADILHA: quando o comprador paga o frete, os 10,99 vêm DENTRO do lançamento payment (e o ML ainda soma 4,00 em shipping);
--   olhar só o shipping subestima o crédito. Sem payment no extrato (extrato só desde 24/09/2026, ou dinheiro ainda não liberado)
--   = estimativa de flex_frete_regra: venda ≥ 79 → 14,99; comprador pagou frete → 14,99; senão 10,99 (medido em 26/nov: 557 de 599
--   pedidos padrão = 10,99; 158 de 170 com frete do comprador = 14,99; 52 de 61 acima de 79 = 14,99).
-- CUSTO da transportadora: fatura importada (flex_frete_fatura, ligada ao pedido pelo shipping_id do extrato) ÷ pedidos do envio;
--   sem fatura = tabela por peso (produtos.peso_bruto, kit pelos componentes): ≤ 8,05 kg P, ≤ 20 kg G1, acima G2.
--   Envio cancelado antes da coleta também é cobrado pela SOS, mas o pedido cancelado não está na view (fica fora da margem).
--
-- Efeito (margem do Flex, pedidos válidos): set 2.698 → 2.432 · out 3.401 → 3.239 · nov (até 26) 3.119 → 3.191. Resto idêntico (md5).
-- Fatura de 16/11: crédito real 2.793,77 × SOS 2.714,52 dos pedidos válidos (+ 76,94 de cancelados/avulsos).
--
-- Importar fatura nova: a planilha vira linhas "id_envio,fatura,data_bipe,tamanho,valor,E|C,m|a" separadas por "|":
--   select flex_frete_importar('<linhas>');   -- upsert + liga os pedidos (flex_frete_ligar_pedidos)
-- Depois: refresh de view_kpi_pedidos_dia e mv_dre_pedidos_mes (ou esperar o cron 62).

create table if not exists public.flex_frete_fatura (
  id_envio text primary key, fatura date, data_bipe date, tamanho text, valor numeric(12,2),
  status_canal text, canal text, order_ids text[], importado_em timestamptz default now());
create index if not exists flex_frete_fatura_orders on public.flex_frete_fatura using gin (order_ids);
-- flex_frete_regra (id=1): preco_p 10,99 · preco_g1 21,98 · preco_g2 32,97 · limite_p_kg 8,05 · limite_g1_kg 20 ·
--   credito_ml_padrao 10,99 · credito_ml_acima_79 14,99 · credito_ml_comprador_pagou 14,99
-- RLS: leitura authenticated; sem anon. flex_frete_importar/ligar: security definer, só service_role.

CREATE OR REPLACE FUNCTION public.flex_frete_pedido(p_id text, p_pack_id text)
 RETURNS TABLE(credito numeric, custo numeric, credito_origem text, custo_origem text)
 LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  with grupo as (
    select g.id, g.subtotal_produtos, coalesce(g.frete_pago_comprador,0) fpc, coalesce(g.recebido_estimado,0) r
    from pedidos g
    where g.marketplace = 'mercadolivre' and g.logistica_tipo = 'self_service'
      and g.status_pedido <> 'CANCELLED'
      and (g.id = p_id or (p_pack_id is not null and g.pack_id::text = p_pack_id))
  ),
  n as (select greatest(count(*),1) n, array_agg(id) ids, sum(subtotal_produtos) venda, max(fpc) fpc, sum(r) r from grupo),
  ext as (
    select sum(coalesce(e.credito,0) - coalesce(e.debito,0)) liberado, bool_or(e.descricao = 'payment') tem_pag
    from mp_extrato e, n where e.order_id = any(n.ids) and e.descricao in ('payment','shipping')
  ),
  fat as (select sum(f.valor) valor from flex_frete_fatura f, n where f.order_ids && n.ids),
  peso as (
    select sum(pi.quantidade * coalesce(nullif(pr.peso_bruto,0),
             (select sum(pk.quantidade * coalesce(pc.peso_bruto,0)) from produto_kits pk join produtos pc on pc.sku = pk.sku_componente
               where pk.sku_kit = pr.sku), 0)) kg
    from pedido_itens pi, n
    left join lateral (select 1) z on true
    left join produtos pr on true
    where pi.pedido_id = any(n.ids) and pr.sku = coalesce(nullif(pi.sku_filho,''), pi.sku_pai)
  ),
  rg as (select * from flex_frete_regra where id = 1)
  select
    round(case when ext.tem_pag then greatest(ext.liberado - n.r, 0)
               when n.venda >= 79 then rg.credito_ml_acima_79
               when n.fpc > 0 then rg.credito_ml_comprador_pagou
               else rg.credito_ml_padrao end / n.n, 2),
    round(case when fat.valor is not null then fat.valor
               when coalesce(peso.kg,0) <= rg.limite_p_kg then rg.preco_p
               when peso.kg <= rg.limite_g1_kg then rg.preco_g1
               else rg.preco_g2 end / n.n, 2),
    case when ext.tem_pag then 'extrato' else 'estimado' end,
    case when fat.valor is not null then 'fatura' else 'estimado' end
  from n, ext, fat, peso, rg
$function$;

-- A view foi alterada por troca de texto sobre a definição de 26/nov (guardada em _bkp_view_margem_v2_flex):
--   'p.recebido_estimado'   → '(p.recebido_estimado + COALESCE(ff.ajuste, 0))'
--   'END AS custo_total,'   → 'END - COALESCE(ff.ajuste, 0) AS custo_total,'
--   + LEFT JOIN LATERAL (SELECT f.credito, f.custo, origem, f.credito - f.custo AS ajuste
--       FROM flex_frete_pedido(p.id, p.pack_id::text) f WHERE p.marketplace = 'mercadolivre' AND p.logistica_tipo = 'self_service') ff
--   + colunas frete_flex_credito/_custo/_origem no fim (NULL no ramo TikTok)

-- ROLLBACK (volta o cálculo antigo; as 3 colunas novas ficam, sempre nulas — CREATE OR REPLACE não remove coluna):
-- do $$ declare d text; begin
--   d := (select definicao from _bkp_view_margem_v2_flex order by em limit 1);
--   d := replace(d, E'END AS modo_envio\n   FROM', E'END AS modo_envio, NULL::numeric AS frete_flex_credito, NULL::numeric AS frete_flex_custo, NULL::text AS frete_flex_origem\n   FROM');
--   d := replace(d, E't.modo_envio\n   FROM', E't.modo_envio, NULL::numeric, NULL::numeric, NULL::text\n   FROM');
--   execute 'create or replace view public.view_margem_pedido_v2 as ' || d;
-- end $$;
-- refresh materialized view view_kpi_pedidos_dia; refresh materialized view mv_dre_pedidos_mes;
