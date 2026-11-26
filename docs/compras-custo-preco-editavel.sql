-- =============================================================================
-- Compras › Formação de custo: PREÇO NF UNITÁRIO EDITÁVEL por item (26/nov/2026, pedido do dono)
--
-- Caso: NF 10821 (Panther Gold) — o 15284 N1 Rosa veio a R$ 28,87 (o N1 Preto, igual, a R$ 18,02).
-- A edge fn compras-estoque v9 aceita precos={"sku":{"preco":18.02,"motivo":"..."}}: o preço digitado
-- substitui o da NF/OC ANTES do rateio (valor = preço × unidades), então IPI/frete/outras rateados por
-- valor se redistribuem. O preço original da nota segue no retorno (preco_nf_original).
-- Aqui só a coluna que guarda os preços digitados junto com os extras/ajustes/manuais da formação.
-- compras_custo_itens.origem_preco passa a aceitar 'manual' (texto livre, sem check).
-- Migração: compras_custo_preco_editavel
-- =============================================================================
alter table public.compras_custo_formacao add column if not exists precos jsonb not null default '{}'::jsonb;
comment on column public.compras_custo_formacao.precos is
  'Preço unitário digitado por SKU {"sku":{"preco":n,"motivo":t}} — substitui o da NF/OC antes do rateio (compras-estoque v9).';

-- ROLLBACK: alter table public.compras_custo_formacao drop column if exists precos;
--           (e voltar a edge fn compras-estoque para a v8)
