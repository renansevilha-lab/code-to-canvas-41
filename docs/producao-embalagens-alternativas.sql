-- ============================================================================
-- Produção — embalagens alternativas na ficha e embalagem na ordem de produção (06/nov/2026, pedido do dono:
-- "na produção da Bumi 15984, dê mais uma opção para embalagem: em alguns marketplaces vamos continuar enviando
-- na embalagem transparente"). A ficha tem a embalagem PADRÃO (custo padrão) e passa a ter as ALTERNATIVAS que o
-- produto também usa; o lote já guardava a embalagem usada (producao_ordem.embalagem_id); a ordem de produção passa a
-- dizer em qual embalagem produzir.
-- Migração: producao_embalagens_alternativas
-- ============================================================================
alter table public.producao_parametros
  add column if not exists embalagens_alternativas bigint[] not null default '{}';
comment on column public.producao_parametros.embalagens_alternativas is
  'Outras embalagens (producao_insumo.id, tipo embalagem) que este produto também usa, além da embalagem_padrao_id';

alter table public.producao_op
  add column if not exists embalagem_id bigint references public.producao_insumo(id);
comment on column public.producao_op.embalagem_id is 'Em qual embalagem produzir (null = a padrão da ficha)';

-- 15984: padrão = saco impresso Gesoplast (4); também o saco transparente com etiqueta (5)
update public.producao_parametros set embalagens_alternativas = array[5]::bigint[] where sku = '15984';

create or replace view public.view_producao_op with (security_invoker = true) as
 SELECT o.id, o.sku, pr.nome AS produto, o.qtd, o.prazo, o.prioridade, o.obs, o.status, o.criado_por, o.criado_em,
    o.fechada_em, o.fechada_por, o.motivo,
    COALESCE(l.produzido, 0::bigint)::integer AS produzido,
    GREATEST(o.qtd - COALESCE(l.produzido, 0::bigint), 0::bigint)::integer AS falta,
    COALESCE(l.envasando, 0::bigint)::integer AS envasando,
    COALESCE(l.lotes, 0::bigint)::integer AS lotes,
    l.lote_aberto_id,
        CASE
            WHEN o.status <> 'aberta'::text THEN o.status
            WHEN l.lote_aberto_id IS NOT NULL THEN 'em_producao'::text
            WHEN COALESCE(l.produzido, 0::bigint) >= o.qtd THEN 'atingida'::text
            ELSE 'aberta'::text
        END AS situacao,
    o.status = 'aberta'::text AND o.prazo IS NOT NULL AND o.prazo < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS atrasada,
    o.embalagem_id,
    em.nome AS embalagem
   FROM producao_op o
     LEFT JOIN produtos pr ON pr.sku = o.sku
     LEFT JOIN producao_insumo em ON em.id = o.embalagem_id
     LEFT JOIN LATERAL ( SELECT sum(v.boas) FILTER (WHERE v.status = 'encerrada'::text) AS produzido,
            sum(v.envasados) FILTER (WHERE v.status = 'aberta'::text) AS envasando,
            count(*) FILTER (WHERE v.status <> 'cancelada'::text) AS lotes,
            max(v.id) FILTER (WHERE v.status = 'aberta'::text) AS lote_aberto_id
           FROM producao_ordem po
             JOIN view_producao_lote v ON v.id = po.id
          WHERE po.op_id = o.id) l ON true;

-- ---------------------------------------------------------------------------- ROLLBACK
-- create or replace não remove colunas: para voltar, drop + recria a view antiga (sem embalagem_id/embalagem) e:
-- alter table public.producao_op drop column embalagem_id;
-- alter table public.producao_parametros drop column embalagens_alternativas;
