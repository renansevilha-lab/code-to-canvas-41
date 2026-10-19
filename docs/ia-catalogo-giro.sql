-- ============================================================================
-- Filtro "estoque parado" na aba /ia/anuncios (19/out/2026, pedido do dono)
-- Migração `ia_catalogo_giro`. Regra = a do agente de compras (view_cobertura_fornecedor.status):
--   sem_giro = tem estoque (Geral + Fulls) e não vendeu nada em 30 dias
--   excesso  = cobertura (estoque total + OC aguardando) / venda por dia > 120 dias
-- A lista lê o retrato do dia (ads_cobertura_sku, refeito por ads_metricas_atualizar() às 06h20 BRT,
-- cron 147) — a view ao vivo custa ~1,8 s e a lista é paginada a cada clique.
--
-- Passos:
--   1. ads_cobertura_sku ganha venda_30d, estoque_total, oc_aguardando, cobertura_com_oc_dias,
--      valor_estoque e custo (colunas a mais; quem lê, ads_diagnosticar, usa colunas pelo nome).
--   2. ia_catalogo passa a ter 9 parâmetros (p_giro no fim) — a de 8 é removida (duas com o mesmo nome
--      deixariam a chamada ambígua). Corpo em docs/catalogo-espelho-tiny/ia_catalogo_variacoes.sql (v2.2).
--
-- ROLLBACK: aplicar de novo o corpo v2.1 (git: ia_catalogo_variacoes.sql antes de 19/out) com
--   `drop function public.ia_catalogo(text,text,text,text,text,integer,integer,text,text);` antes, e
--   recriar a MV só com as colunas antigas (sku, produto, status, estoque_geral, full_ml, full_shopee,
--   full_amazon, cobertura_empresa_dias, atualizado_em). Grants iguais aos de baixo.
-- ============================================================================

begin;

drop materialized view public.ads_cobertura_sku;
create materialized view public.ads_cobertura_sku as
select sku, produto, status, estoque_geral, full_ml, full_shopee, full_amazon, cobertura_empresa_dias, now() as atualizado_em,
       venda_30d, estoque_total, oc_aguardando, cobertura_com_oc_dias, valor_estoque, custo
from public.view_cobertura_fornecedor cf;
create unique index ads_cobertura_sku_pk on public.ads_cobertura_sku (sku);
grant all on public.ads_cobertura_sku to authenticated, service_role;

drop function public.ia_catalogo(text, text, text, text, text, integer, integer, text);
-- (aqui entra o create function de docs/catalogo-espelho-tiny/ia_catalogo_variacoes.sql)
revoke all on function public.ia_catalogo(text, text, text, text, text, integer, integer, text, text) from public, anon;
grant execute on function public.ia_catalogo(text, text, text, text, text, integer, integer, text, text) to authenticated, service_role;

commit;
