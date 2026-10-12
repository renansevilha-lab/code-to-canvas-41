-- carga_09out_indices_escrow (aplicar depois das 19h BRT)
-- 1) Sync do Tiny: "pedidos sem valor" percorria ~10 mil linhas para achar 20 (0,8 s sozinho, 3,7 s sob carga).
create index if not exists idx_pedidos_tiny_sem_valor
  on public.pedidos_tiny (data_pedido desc) where valor_produtos is null;

-- 2) Escrow Shopee: a função percorria os ~32 mil pedidos da loja para achar ~6 de hoje (~4 s, 2 lojas, a cada 15/20 min).
--    Janela de 30 dias (em 09/out todos os pendentes eram do próprio dia) + índice do recorte.
create index if not exists idx_pedidos_shopee_api_shop_data
  on public.pedidos (shop_id, data_pedido desc) where marketplace = 'shopee' and fonte = 'api';

create or replace function public.pedidos_sem_escrow_componente(p_shop_id bigint, p_limite integer default 300)
 returns table(id text) language sql stable as $function$
  select p.id
  from pedidos p
  where p.marketplace = 'shopee'
    and p.fonte = 'api'
    and p.shop_id = p_shop_id
    and p.data_pedido >= now() - interval '30 days'   -- 09/out: antes varria a loja inteira
    and not exists (select 1 from escrow_componentes ec where ec.order_sn = p.id)
  order by p.data_pedido desc
  limit p_limite;
$function$;
