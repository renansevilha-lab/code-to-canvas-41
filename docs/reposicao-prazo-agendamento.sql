-- ============================================================================
-- Reposição do Full: prazo de agendamento do envio (27/out/2026, pedido do dono)
-- "envios de produtos pesados levam pelo menos 2 semanas para serem agendados" (Amazon).
-- A necessidade passa a cobrir a cobertura-alvo + o prazo até o envio chegar ao CD:
--   necessidade = und_dia × (cobertura_base + prazo) − estoque_full − em_transito − em_envio_aberto
-- cobertura_alvo_dias = cobertura_base + prazo (a tela compara a cobertura atual com ele);
-- colunas novas no FIM: cobertura_base_dias, prazo_envio_dias, prazo_origem, peso_kg.
-- Regra em config_prazo_full: por SKU (vale sozinha) ou por marketplace com peso mínimo
-- (produto com peso > peso_acima_kg). Peso = soma dos componentes do kit (quando todos têm peso)
-- ou produtos.peso_bruto. Produto sem peso não ganha prazo.
-- Rollback: create or replace da definição salva em _bkp (seção ROLLBACK no fim).
-- ============================================================================

create table if not exists config_prazo_full (
  id bigserial primary key,
  marketplace text not null,           -- 'amazon' | 'mercadolivre' | 'shopee' | 'todos'
  sku text,                            -- preenchido = vale só para o SKU (ignora o peso)
  peso_acima_kg numeric,               -- regra por peso: produto com peso > este valor
  prazo_dias int not null check (prazo_dias >= 0),
  observacao text,
  atualizado_em timestamptz not null default now()
);
alter table config_prazo_full enable row level security;
create policy config_prazo_full_auth on config_prazo_full for all to authenticated using (true) with check (true);
grant select, insert, update, delete on config_prazo_full to authenticated;
grant usage, select on sequence config_prazo_full_id_seq to authenticated;
insert into config_prazo_full (marketplace, peso_acima_kg, prazo_dias, observacao)
values ('amazon', 4, 14, 'produto pesado: agendamento do envio leva pelo menos 2 semanas (dono, 27/out/2026)');

create or replace view view_reposicao_full as
 WITH velocidade AS (
         SELECT p.marketplace, p.shop_id, pi.sku_pai AS sku,
            sum(pi.quantidade) AS unidades_30d,
            round(sum(pi.quantidade) / 30.0, 2) AS und_dia
           FROM pedido_itens pi
             JOIN pedidos p ON p.id = pi.pedido_id
          WHERE ((p.logistica_tipo = ANY (ARRAY['fulfillment'::text, 'FBA'::text])) OR p.opcao_envio = 'Full'::text)
            AND p.data_pedido >= (now() - '30 days'::interval) AND p.valido = true AND pi.sku_pai IS NOT NULL
          GROUP BY p.marketplace, p.shop_id, pi.sku_pai
        ), estoque_full AS (
         SELECT estoque_fulfillment.marketplace, estoque_fulfillment.shop_id, estoque_fulfillment.sku,
            sum(estoque_fulfillment.sellable) AS sellable,
            sum(estoque_fulfillment.in_transit) AS in_transit,
            max(estoque_fulfillment.atualizado_em) AS estoque_atualizado_em
           FROM estoque_fulfillment
          WHERE estoque_fulfillment.sku IS NOT NULL
          GROUP BY estoque_fulfillment.marketplace, estoque_fulfillment.shop_id, estoque_fulfillment.sku
        ), empresa_loja AS (
         SELECT lojas.shop_id, lojas.empresa FROM lojas
        ), envios_abertos AS (
         SELECT e.marketplace, COALESCE(e.empresa, 'ACZ Pet'::text) AS empresa, i.sku, sum(i.qtd_planejada) AS em_envio
           FROM fulfillment_envios e
             JOIN fulfillment_envio_itens i ON i.envio_id = e.id
          WHERE e.status <> 'enviado'::text AND e.arquivado_em IS NULL AND i.sku IS NOT NULL
          GROUP BY e.marketplace, (COALESCE(e.empresa, 'ACZ Pet'::text)), i.sku
        ), empresa AS (
         SELECT estoque_tiny.sku, sum(estoque_tiny.saldo_disponivel) AS disponivel, max(estoque_tiny.atualizado_em) AS atualizado_em
           FROM estoque_tiny
          WHERE COALESCE(estoque_tiny.desconsiderar, false) = false AND estoque_tiny.deposito !~~* '%full%'::text
            AND estoque_tiny.deposito !~~* '%fulfillment%'::text AND estoque_tiny.deposito !~~* '%fullfilment%'::text
          GROUP BY estoque_tiny.sku
        ), kit_montavel AS (
         SELECT c.sku_raiz AS sku,
            floor(min(GREATEST(COALESCE(e.disponivel, 0::numeric), 0::numeric) / NULLIF(c.qtd_por_unidade, 0::numeric))) AS montavel,
            bool_and(e.sku IS NOT NULL) AS componentes_sincronizados,
            min(e.atualizado_em) AS atualizado_em,
            count(*) AS qtd_componentes
           FROM view_kit_componentes c
             LEFT JOIN empresa e ON e.sku = c.sku_folha
          GROUP BY c.sku_raiz
        ), kit_peso AS (
         SELECT c.sku_raiz AS sku,
            CASE WHEN bool_and(COALESCE(pc.peso_bruto, 0::numeric) > 0::numeric) THEN sum(c.qtd_por_unidade * pc.peso_bruto) END AS peso
           FROM view_kit_componentes c
             LEFT JOIN produtos pc ON pc.sku = c.sku_folha
          GROUP BY c.sku_raiz
        ), base AS (
         SELECT COALESCE(v.marketplace, e.marketplace) AS marketplace,
            COALESCE(v.shop_id, e.shop_id) AS shop_id,
            COALESCE(v.sku, e.sku) AS sku,
            COALESCE(v.unidades_30d, 0::numeric) AS unidades_30d,
            COALESCE(v.und_dia, 0::numeric) AS und_dia,
            COALESCE(e.sellable, 0::numeric) AS estoque_full,
            COALESCE(e.in_transit, 0::numeric) AS em_transito,
            e.estoque_atualizado_em
           FROM velocidade v
             FULL JOIN estoque_full e ON e.marketplace = v.marketplace AND e.shop_id = v.shop_id AND e.sku = v.sku
        ), calc AS (
         SELECT b.marketplace, b.shop_id, b.sku, b.unidades_30d, b.und_dia, b.estoque_full, b.em_transito,
            COALESCE(el.empresa,
                CASE
                    WHEN b.shop_id = ANY (ARRAY[900002::bigint, 759046323::bigint, 1299638625::bigint]) THEN 'SVL Store'::text
                    ELSE 'ACZ Pet'::text
                END) AS empresa,
            COALESCE(ea.em_envio::numeric, 0::numeric) AS em_envio_aberto,
            b.estoque_atualizado_em,
            pr.nome AS produto,
            pr.tipo AS tipo_produto,
            km.sku IS NOT NULL AS eh_kit,
            km.qtd_componentes,
                CASE
                    WHEN km.sku IS NOT NULL THEN COALESCE(km.montavel, 0::numeric)
                    ELSE COALESCE(emp.disponivel, 0::numeric)
                END AS estoque_empresa,
                CASE
                    WHEN km.sku IS NOT NULL THEN COALESCE(km.componentes_sincronizados, false)
                    ELSE emp.sku IS NOT NULL
                END AS estoque_sincronizado,
            COALESCE(km.atualizado_em, emp.atualizado_em) AS estoque_empresa_atualizado_em,
            cob.cobertura_dias,
            cob.origem AS cobertura_origem,
            COALESCE(kp.peso, NULLIF(pr.peso_bruto, 0::numeric)) AS peso_kg,
            COALESCE(pz.prazo_dias, 0) AS prazo_dias,
            pz.origem AS prazo_origem
           FROM base b
             LEFT JOIN empresa_loja el ON el.shop_id = b.shop_id
             LEFT JOIN produtos pr ON pr.sku = b.sku
             LEFT JOIN empresa emp ON emp.sku = b.sku
             LEFT JOIN kit_montavel km ON km.sku = b.sku
             LEFT JOIN kit_peso kp ON kp.sku = b.sku
             LEFT JOIN envios_abertos ea ON ea.marketplace = b.marketplace AND ea.sku = b.sku AND ea.empresa = COALESCE(el.empresa,
                CASE
                    WHEN b.shop_id = ANY (ARRAY[900002::bigint, 759046323::bigint, 1299638625::bigint]) THEN 'SVL Store'::text
                    ELSE 'ACZ Pet'::text
                END)
             CROSS JOIN LATERAL ( SELECT c.cobertura_dias, c.origem
                   FROM ( SELECT config_cobertura_full.cobertura_dias, 'sku+marketplace'::text AS origem, 1 AS ord
                           FROM config_cobertura_full
                          WHERE config_cobertura_full.marketplace = b.marketplace AND config_cobertura_full.sku = b.sku
                        UNION ALL
                         SELECT config_cobertura_full.cobertura_dias, 'marketplace'::text, 2
                           FROM config_cobertura_full
                          WHERE config_cobertura_full.marketplace = b.marketplace AND config_cobertura_full.sku IS NULL
                        UNION ALL
                         SELECT config_cobertura_full.cobertura_dias, 'padrao'::text, 3
                           FROM config_cobertura_full
                          WHERE config_cobertura_full.marketplace = 'todos'::text AND config_cobertura_full.sku IS NULL
                        UNION ALL
                         SELECT 30, 'default'::text, 4) c
                  ORDER BY c.ord
                 LIMIT 1) cob
             LEFT JOIN LATERAL ( SELECT x.prazo_dias, x.origem
                   FROM ( SELECT cp.prazo_dias, 'sku'::text AS origem, 1 AS ord, 0::numeric AS peso
                           FROM config_prazo_full cp
                          WHERE cp.sku = b.sku AND cp.marketplace = ANY (ARRAY[b.marketplace, 'todos'::text])
                        UNION ALL
                         SELECT cp.prazo_dias, 'peso > ' || cp.peso_acima_kg::text || ' kg', 2, cp.peso_acima_kg
                           FROM config_prazo_full cp
                          WHERE cp.sku IS NULL AND cp.peso_acima_kg IS NOT NULL AND cp.marketplace = ANY (ARRAY[b.marketplace, 'todos'::text])
                            AND COALESCE(kp.peso, NULLIF(pr.peso_bruto, 0::numeric)) > cp.peso_acima_kg
                        UNION ALL
                         SELECT cp.prazo_dias, 'marketplace'::text, 3, 0::numeric
                           FROM config_prazo_full cp
                          WHERE cp.sku IS NULL AND cp.peso_acima_kg IS NULL AND cp.marketplace = ANY (ARRAY[b.marketplace, 'todos'::text])) x
                  ORDER BY x.ord, x.peso DESC
                 LIMIT 1) pz ON true
        )
 SELECT marketplace,
    sku,
    produto,
    eh_kit,
    qtd_componentes,
    und_dia,
    unidades_30d,
    estoque_full,
    em_transito,
        CASE
            WHEN und_dia > 0::numeric THEN round((estoque_full + em_transito + em_envio_aberto) / und_dia, 1)
            ELSE NULL::numeric
        END AS cobertura_atual_dias,
    cobertura_dias + prazo_dias AS cobertura_alvo_dias,
    cobertura_origem,
    estoque_empresa::integer AS estoque_empresa,
    estoque_sincronizado,
    GREATEST(ceil(und_dia * (cobertura_dias + prazo_dias)::numeric) - estoque_full - em_transito - em_envio_aberto, 0::numeric)::integer AS necessidade,
    LEAST(GREATEST(ceil(und_dia * (cobertura_dias + prazo_dias)::numeric) - estoque_full - em_transito - em_envio_aberto, 0::numeric), GREATEST(estoque_empresa, 0::numeric))::integer AS sugestao_envio,
    estoque_atualizado_em,
    estoque_empresa_atualizado_em,
    em_envio_aberto::integer AS em_envio_aberto,
    shop_id,
    empresa,
    cobertura_dias AS cobertura_base_dias,
    prazo_dias AS prazo_envio_dias,
    prazo_origem,
    round(peso_kg, 2) AS peso_kg
   FROM calc
  ORDER BY (LEAST(GREATEST(ceil(und_dia * (cobertura_dias + prazo_dias)::numeric) - estoque_full - em_transito - em_envio_aberto, 0::numeric), GREATEST(estoque_empresa, 0::numeric))::integer) DESC, und_dia DESC;

-- ROLLBACK (definição de antes, 27/out/2026): rodar a definição da view sem kit_peso/config_prazo_full —
-- igual à de cima trocando "cobertura_dias + prazo_dias" por "cobertura_dias" e sem as 4 colunas do fim
-- (create or replace não remove colunas: para tirar as 4, drop view + recriar + grants authenticated/service_role).
