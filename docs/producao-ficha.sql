-- Produção — 30/out/2026 (pedido do dono)
-- 1) Fichas novas: 16723 (Areia Bumi 3 kg, grãos médios) e 15933 (Mandioca com Carvão Ativado Grãos Finos 4 kg =
--    50% farinha fina do big bag + 50% areia esmectita com carvão 15679, que sai do Tiny como a mistura do 16640).
-- 2) Os big bags da NF 19532 são 2 FINOS (01, 02) e 2 GROSSOS (03, 04): a farinha 1 passa a se chamar "fina".
-- 3) O lote BUMIM4-20261029-01 (id 7, ainda NÃO lançado no Tiny) foi do 16723 e não do 16581: troca o SKU, o saco
--    (Saco 3 kg) e refaz a baixa da farinha pelo padrão de 3 kg (108 × 3,0765 kg) — o big bag 01 NÃO acabou.
--    O código do lote fica como foi impresso na datadora.
-- 4) view_producao_ficha: a ficha técnica de cada produto (o que vai num saco, proporções e custo padrão),
--    com a MESMA conta do custo padrão da view_producao_lote.

begin;

update producao_insumo set nome = 'Farinha de mandioca Lotus — fina' where id = 1;

insert into producao_insumo (nome, tipo, unidade, custo_referencia, precisa_etiqueta, etiqueta_id)
values ('Saco 3 kg', 'embalagem', 'un', 0.70, true, 3);

insert into producao_insumo (nome, tipo, unidade, custo_referencia, tiny_produto_id, tiny_sku)
values ('Areia esmectita com carvão ativado Bumi 4 kg (15679)', 'produto', 'un', 4.38, 818146935, '15679');

insert into producao_parametros (sku, farinha_id, embalagem_padrao_id, prefixo_lote, peso_nominal_kg, tolerancia_g,
  custo_insumo_kg, pesar_cada, pesar_primeiros)
select '16723', 1, id, 'BUMIM3', 3, 45, 2.548, 10, 5 from producao_insumo where nome = 'Saco 3 kg';

insert into producao_parametros (sku, farinha_id, embalagem_padrao_id, prefixo_lote, peso_nominal_kg, tolerancia_g,
  custo_insumo_kg, pesar_cada, pesar_primeiros, mistura_insumo_id, mistura_un_kg, mistura_farinha_kg)
select '15933', 1, 5, 'BUMIC4', 4, 60, 2.548, 10, 5, id, 4, 4 from producao_insumo where tiny_sku = '15679';

-- lote 7 → 16723
update producao_ordem set sku = '16723', embalagem_id = (select id from producao_insumo where nome = 'Saco 3 kg'),
  sobra_kg = 1000 - 479.934 - 104 - round(108 * 3.0765, 3),
  obs = coalesce(obs || ' · ', '') || '30/out: era 16723 (3 kg), não 16581 — corrigido a pedido do dono'
 where id = 7 and tiny_lancado_em is null;
update producao_consumo set quantidade = round(108 * 3.0765, 3)   -- custo é coluna gerada (quantidade × custo_un)
 where ordem_id = 7 and insumo_id = 1;
update producao_consumo set insumo_id = (select id from producao_insumo where nome = 'Saco 3 kg')
 where ordem_id = 7 and insumo_id = 5;

create or replace view public.view_producao_ficha with (security_invoker = true) as
select p.sku, pr.nome as produto, p.ativo, p.prefixo_lote, p.peso_nominal_kg, p.sobrepeso_pct, p.perda_pct,
  p.consumo_padrao_kg, p.tolerancia_g, p.pesar_cada, p.pesar_primeiros, p.meta_estoque_un,
  f.nome as farinha, round(p.consumo_padrao_kg * mx.fp, 4) as farinha_kg, p.custo_insumo_kg as farinha_custo_kg,
  round(p.consumo_padrao_kg * mx.fp * p.custo_insumo_kg, 4) as farinha_custo,
  round(100 * mx.fp, 1) as farinha_pct,
  mi.nome as mistura, mi.tiny_sku as mistura_sku, p.mistura_un_kg, p.mistura_farinha_kg,
  round(mx.un_por_saco, 5) as mistura_un, round(mx.un_por_saco * p.mistura_un_kg, 4) as mistura_kg,
  mx.custo_un as mistura_custo_un, round(mx.un_por_saco * mx.custo_un, 4) as mistura_custo,
  case when mi.id is not null then round(100 * (1 - mx.fp), 1) end as mistura_pct,
  e.nome as embalagem, e.custo_referencia as embalagem_custo,
  case when e.precisa_etiqueta then et.nome end as etiqueta,
  case when e.precisa_etiqueta then et.custo_referencia end as etiqueta_custo,
  cfg.custo_conversao_un,
  round(p.consumo_padrao_kg * mx.fp * p.custo_insumo_kg + coalesce(mx.un_por_saco * mx.custo_un, 0)
        + coalesce(e.custo_referencia, 0)
        + case when e.precisa_etiqueta then coalesce(et.custo_referencia, 0) else 0 end
        + cfg.custo_conversao_un, 4) as custo_padrao_un
from producao_parametros p
left join produtos pr on pr.sku = p.sku
left join producao_insumo f on f.id = p.farinha_id
left join producao_insumo e on e.id = p.embalagem_padrao_id
left join producao_insumo et on et.id = e.etiqueta_id
left join producao_insumo mi on mi.id = p.mistura_insumo_id
left join produtos mp on mp.sku = mi.tiny_sku
cross join lateral (select
    coalesce(p.mistura_farinha_kg / nullif(p.mistura_farinha_kg + p.mistura_un_kg, 0), 1::numeric) as fp,
    p.consumo_padrao_kg / nullif(p.mistura_farinha_kg + p.mistura_un_kg, 0) as un_por_saco,
    case when mi.id is not null then coalesce(nullif(mp.custo, 0), mi.custo_referencia) end as custo_un) mx
cross join producao_config cfg;

revoke all on public.view_producao_ficha from anon, public;
grant select on public.view_producao_ficha to authenticated, service_role;

commit;

-- ROLLBACK (manual):
-- drop view view_producao_ficha;
-- update producao_consumo set insumo_id = 5 where ordem_id = 7 and insumo_id = (select id from producao_insumo where nome = 'Saco 3 kg');
-- update producao_consumo set quantidade = 416.066 where ordem_id = 7 and insumo_id = 1;
-- update producao_ordem set sku = '16581', embalagem_id = 5, sobra_kg = 0 where id = 7;
-- delete from producao_parametros where sku in ('16723','15933');
-- delete from producao_insumo where nome = 'Saco 3 kg' or tiny_sku = '15679';
-- update producao_insumo set nome = 'Farinha de mandioca Lotus — grãos médios' where id = 1;
