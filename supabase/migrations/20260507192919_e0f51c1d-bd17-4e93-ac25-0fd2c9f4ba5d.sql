
-- ads_diario: drop uniques separados e cria composto
ALTER TABLE public.ads_diario DROP CONSTRAINT IF EXISTS ads_diario_sku_key;
ALTER TABLE public.ads_diario DROP CONSTRAINT IF EXISTS ads_diario_data_key;
ALTER TABLE public.ads_diario DROP CONSTRAINT IF EXISTS ads_diario_shop_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS ads_diario_shop_sku_data_uniq
  ON public.ads_diario (COALESCE(shop_id, 0), sku, data);

-- pedido_itens: unique por (pedido_id, sku_filho)
CREATE UNIQUE INDEX IF NOT EXISTS pedido_itens_pedido_sku_uniq
  ON public.pedido_itens (pedido_id, COALESCE(sku_filho, ''));

-- pedidos: índice por data
CREATE INDEX IF NOT EXISTS pedidos_data_idx ON public.pedidos (data_pedido);

-- transacoes_carteira: índices úteis
CREATE INDEX IF NOT EXISTS transacoes_data_idx ON public.transacoes_carteira (data);
CREATE INDEX IF NOT EXISTS transacoes_pedido_idx ON public.transacoes_carteira (pedido_id);
