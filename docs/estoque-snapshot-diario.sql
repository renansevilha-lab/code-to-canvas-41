-- Snapshot diário do estoque (pedido do dono, 14/out/2026). A tabela estoque_snapshot_diario já existe
-- (PK data_ref, origem, deposito, sku, sku_marketplace). Este arquivo cria a função e o agendamento.
-- Aplicar DEPOIS das 19h BRT, fora dos minutos :00/:15/:30/:45 (decisão do dono em 14/out).
-- Não altera nenhuma tabela, view ou cron existente.
--
-- Decisão do dono (14/out): linha do Full sem SKU nosso (anúncio sem vínculo; 6 linhas do ML Ottz na data,
-- 13 unidades) entra com sku = '-' e o sku_marketplace preenchido, sem custo. Sem isso o sku nulo quebraria
-- a PK e o snapshot do dia inteiro falharia.
-- Medido em 14/out (só leitura): Tiny 649 linhas com saldo, sem PK nula nem duplicada; Full 169 linhas,
-- sem duplicada; custo pela view_cmv_efetivo em 32 ms.

-- 1) migração (apply_migration, nome: estoque_snapshot_diario_fn)
create or replace function public.fn_snapshot_estoque_diario()
returns void
language plpgsql
set search_path = public
as $$
declare
  d date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  -- a) estoque da empresa (Tiny)
  insert into public.estoque_snapshot_diario
    (data_ref, origem, deposito, sku, sku_marketplace, nome, quantidade, reservado, em_transito, indisponivel,
     custo_unitario, valor_total, capturado_em)
  select d, 'tiny', t.deposito, t.sku, '-', t.nome_produto, t.saldo, t.saldo_reservado, null, null,
         t.custo_unitario, t.saldo * t.custo_unitario, now()
  from public.estoque_tiny t
  where t.desconsiderar = false and t.saldo <> 0
  on conflict (data_ref, origem, deposito, sku, sku_marketplace) do update set
    nome = excluded.nome, quantidade = excluded.quantidade, reservado = excluded.reservado,
    em_transito = excluded.em_transito, indisponivel = excluded.indisponivel,
    custo_unitario = excluded.custo_unitario, valor_total = excluded.valor_total, capturado_em = now();

  -- b) estoque nos fulfillments (Full ML, FBA, SBS)
  insert into public.estoque_snapshot_diario
    (data_ref, origem, deposito, sku, sku_marketplace, nome, quantidade, reservado, em_transito, indisponivel,
     custo_unitario, valor_total, capturado_em)
  select d, 'fulfillment',
         concat_ws('/', f.marketplace, f.shop_id::text, nullif(f.warehouse, '')),
         coalesce(f.sku, '-'), f.sku_marketplace, f.titulo,
         f.sellable, f.reserved, f.in_transit, f.unsellable,
         c.cmv_efetivo, (f.sellable + f.reserved + f.in_transit) * c.cmv_efetivo, now()
  from public.estoque_fulfillment f
  left join lateral (select v.cmv_efetivo from public.view_cmv_efetivo v where v.sku = f.sku limit 1) c on true
  where f.sellable + f.reserved + f.in_transit + f.unsellable <> 0
  on conflict (data_ref, origem, deposito, sku, sku_marketplace) do update set
    nome = excluded.nome, quantidade = excluded.quantidade, reservado = excluded.reservado,
    em_transito = excluded.em_transito, indisponivel = excluded.indisponivel,
    custo_unitario = excluded.custo_unitario, valor_total = excluded.valor_total, capturado_em = now();

  -- c) retenção: 120 dias corridos + o último dia de cada mês para sempre
  delete from public.estoque_snapshot_diario s
  where s.data_ref < d - 120
    and s.data_ref <> (date_trunc('month', s.data_ref) + interval '1 month - 1 day')::date;
end;
$$;

-- 2) agendamento (execute_sql): 02:50 UTC = 23:50 BRT
select cron.unschedule(jobid) from cron.job where jobname = 'snapshot-estoque-diario';
select cron.schedule('snapshot-estoque-diario', '50 2 * * *', 'SELECT fn_snapshot_estoque_diario()');

-- 3) primeira execução e conferência
select fn_snapshot_estoque_diario();
select origem, count(*), sum(quantidade), round(sum(valor_total), 2)
from estoque_snapshot_diario
where data_ref = (now() at time zone 'America/Sao_Paulo')::date
group by origem;
