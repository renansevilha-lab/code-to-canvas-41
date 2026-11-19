-- Testes A/B: braço de anúncio ainda não criado abre direto no editor (/ia/gerar) com o rascunho certo (19/nov/2026, pedido do dono).
-- anuncio_marcacao.sku_planejado = SKU (pai ou kit) de onde o anúncio do braço vai nascer; a view devolve também o rascunho
-- (ia_rascunho mais recente do SKU, canal shopee, empresa da loja: 759046323 → svl, resto → ottz).

alter table anuncio_marcacao add column if not exists sku_planejado text;

update anuncio_marcacao set sku_planejado = v.sku
from (values ('Bumi 1','16799'), ('Bumi 2','16836'), ('Bumi 3','16832'), ('Ottz 1','16801'), ('Ottz 2','16812'), ('Ottz 3','16827')) v(braco, sku)
where anuncio_marcacao.braco = v.braco and anuncio_marcacao.teste = 'Areia Ottz Pet Fina - lançamento nov/2026' and anuncio_marcacao.sku_planejado is null;

create or replace view view_anuncio_marcacao with (security_invoker = true) as
 SELECT m.id, m.marketplace, m.shop_id, m.item_id, m.teste, m.braco, m.rotulo, m.estrategia, m.instrucao, m.tarefas,
    m.preco_planejado, m.roas_alvo_planejado, m.ads_ligado, m.titulo_planejado, m.regra_parada, m.data_leitura, m.status,
    m.aplicado_em, m.criado_em, m.atualizado_em, m.atualizado_por,
    a.nome AS nome_atual, a.imagem_url AS foto, a.status AS status_anuncio, a.sku_pai, a.atualizado_em AS espelho_em,
        CASE m.shop_id
            WHEN 522186766 THEN 'Ottz'::text
            WHEN 759046323 THEN 'Bumi'::text
            ELSE (m.shop_id)::text
        END AS loja,
    COALESCE(( SELECT jsonb_agg((x.t || anuncio_marcacao_tarefa_atual(m.shop_id, m.item_id, x.t)) ORDER BY x.o) AS jsonb_agg
           FROM jsonb_array_elements(m.tarefas) WITH ORDINALITY x(t, o)), '[]'::jsonb) AS tarefas_aval,
    jsonb_array_length(m.tarefas) AS n_tarefas,
    (( SELECT count(*) AS count
           FROM jsonb_array_elements(m.tarefas) t(value)
          WHERE COALESCE(((t.value ->> 'feito'::text))::boolean, false)))::integer AS n_feitas,
    (m.status = ANY (ARRAY['pendente'::text, 'em_andamento'::text])) AS pendente,
    COALESCE(m.sku_planejado, a.sku_pai) AS sku_editor,
    CASE WHEN m.shop_id = 759046323 THEN 'svl'::text ELSE 'ottz'::text END AS empresa_editor,
    ( SELECT r.id FROM ia_rascunho r
       WHERE r.sku = COALESCE(m.sku_planejado, a.sku_pai) AND r.canal = 'shopee'
         AND r.empresa = CASE WHEN m.shop_id = 759046323 THEN 'svl' ELSE 'ottz' END
       ORDER BY r.updated_at DESC NULLS LAST LIMIT 1) AS rascunho_id
   FROM (anuncio_marcacao m
     LEFT JOIN shopee_anuncios a ON (((a.shop_id = m.shop_id) AND (m.item_id ~ '^\d+$'::text) AND (a.item_id = (m.item_id)::bigint))));

-- ROLLBACK
-- create or replace não remove colunas: para voltar, drop view view_anuncio_marcacao; recriar com a definição de docs/anuncio-marcacao.sql
-- (a última antes desta) e depois: alter table anuncio_marcacao drop column sku_planejado;
