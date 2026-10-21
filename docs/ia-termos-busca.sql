-- ============================================================================
-- Termos de busca para os títulos dos anúncios (20/out/2026, pedido do dono)
-- Migração `ia_termos_busca`. Junta, para um produto, o que os compradores buscam nas três lojas:
--   Shopee   = palavras sugeridas pela Shopee Ads para os anúncios do produto, COM volume de busca
--              (shopee-ads-gestao ?modulo=palavras-sku grava em shopee_palavras)
--   Amazon   = relatório de buscas da Amazon (pesquisa_amz_brand_analytics, conta ACZ): posição no ranking
--   Mercado Livre = termos em alta por categoria (pesquisa_ml_tendencias): posição, sem volume
-- Termo com marca de outro fabricante (catbio, pipicat…) fica de fora: não pode ir no título.
-- Usado por: ia-anuncio (texto da IA), anuncio-publicar (palavras escondidas da Amazon e Modelo do
-- Mercado Livre) e a tela do anúncio (cobertura do título).
-- ROLLBACK: drop function public.ia_termos_busca(text, text); drop function public.ia_tokens(text);
--   drop function public.ia_norm(text); drop table public.shopee_palavras;
-- ============================================================================

create table if not exists public.shopee_palavras (
  shop_id bigint not null, item_id bigint not null, termo text not null,
  volume integer, qualidade integer, lance numeric, coletado_em timestamptz not null default now(),
  primary key (shop_id, item_id, termo)
);
revoke all on public.shopee_palavras from anon;
grant select on public.shopee_palavras to authenticated;
grant all on public.shopee_palavras to service_role;

-- minúsculas e sem acento
create or replace function public.ia_norm(t text) returns text language sql immutable as $$
  select lower(translate(coalesce(t, ''), 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn'))
$$;

-- palavras que importam: sem acento, sem palavra vazia (de, para, kit…), sem número/medida, plural simples cortado
create or replace function public.ia_tokens(t text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct w), '{}') from (
    select case when length(p) > 4 and p ~ '[^s]s$' then left(p, -1) else p end as w
    from regexp_split_to_table(public.ia_norm(t), '[^a-z0-9]+') p
    where length(p) >= 3 and p !~ '^[0-9]+([a-z]{0,3})$'
      and p not in ('para','pra','com','sem','dos','das','por','uma','uns','kit','combo','atacado','unidade','und','pct',
                    'pacote','pet','pets','que','mais','tipo','cor','tamanho','novo','nova','original','oferta','promocao')
  ) x
$$;

create or replace function public.ia_termos_busca(p_sku text, p_titulo text default null)
returns jsonb language plpgsql stable set search_path to 'public' as $function$
declare
  v_nome text; v_marca text; v_tok text[]; v_nucleo text; v_tit text[]; v_voc text[];
  v jsonb;
begin
  select p.nome, coalesce(p.marca_manual, p.marca) into v_nome, v_marca from produtos p where p.sku = p_sku;
  if v_nome is null then return jsonb_build_object('erro', 'produto não encontrado'); end if;
  v_tok := ia_tokens(v_nome);
  -- o núcleo é a 1ª palavra que importa do nome ("Areia …", "Educador …", "Toalhas …")
  select w into v_nucleo from (
    select case when length(p) > 4 and p ~ '[^s]s$' then left(p, -1) else p end as w, n
    from regexp_split_to_table(ia_norm(v_nome), '[^a-z0-9]+') with ordinality as t(p, n)
  ) x where w = any (v_tok) order by n limit 1;
  v_tit := ia_tokens(coalesce(p_titulo, ''));
  -- vocabulário CONFIRMADO do produto: nome, categoria e o texto já escrito dos anúncios dele (e o das variações)
  -- (sem palavras genéricas de bicho: "cães" num produto só para gatos não pode virar confirmado). Termo com palavra fora
  -- disso fica "a conferir" (a IA só usa se a foto/rótulo confirmar)
  select ia_tokens(concat_ws(' ', max(p.nome), max(p.categoria_caminho), max(p.categoria),
           string_agg(concat_ws(' ', r.titulo, r.descricao, r.bullet_points::text), ' ')))
    into v_voc
    from produtos p left join ia_rascunho r on r.sku = p.sku or r.sku in (select x.sku from produtos x where x.sku_pai = p.sku)
   where p.sku = p_sku;

  with recursive
  skus as (
    -- o produto, as variações dele e os componentes (kit): os anúncios deles falam do mesmo produto físico
    select p_sku as sku
    union select p.sku from produtos p where p.sku_pai = p_sku and p.ativo
    union select k.sku_componente from produto_kits k where k.sku_kit = p_sku
    union select k.sku_componente from produto_kits k join produtos p on p.sku = k.sku_kit where p.sku_pai = p_sku and p.ativo
  ),
  marcas as (
    select distinct m from (
      select ia_norm(coalesce(marca_manual, marca)) m from produtos
      union select ia_norm(marca) from pesquisa_amz_asins
      union select unnest(array['catbio','cat bio','pipicat','viva verde','bionature','kets','gatissimo','mr miau','petlove','cobasi','petz','whiskas','golden','premier','dog chow','cat chow','pedigree','friskies','tofu cat','chalesco','sanol','procao','canigatos'])
    ) z
    where length(m) >= 4 and m not in ('generico','generica','sem marca','nao se aplica','outros','outro','pet','gato','gatos','cao','caes','areia','mandioca','natural','premium')
      and m <> ia_norm(coalesce(v_marca, '-'))
  ),
  -- SHOPEE: palavras sugeridas para os anúncios do produto (as duas lojas), maior volume visto
  itens_shopee as (
    select distinct a.shop_id, a.item_id from shopee_anuncios a where a.sku_pai in (select sku from skus)
    union select distinct v.shop_id, v.item_id from shopee_anuncios_variacao v where v.sku in (select sku from skus)
  ),
  sp as (
    select s.termo, max(s.volume) as volume, max(s.coletado_em) as em
    from shopee_palavras s join itens_shopee i on i.shop_id = s.shop_id and i.item_id = s.item_id
    where s.coletado_em > now() - interval '45 days'
    group by 1
  ),
  -- AMAZON: última semana do relatório de buscas, termos que falam deste produto
  amz_semana as (select max(semana) s from pesquisa_amz_brand_analytics),
  amz as (
    select b.termo, b.rank_busca from pesquisa_amz_brand_analytics b, amz_semana w where b.semana = w.s
  ),
  -- MERCADO LIVRE: última coleta de cada categoria; as categorias dos anúncios do produto (e as de cima) primeiro
  ml_cat_base as (
    select distinct m.category_id from ml_anuncios a join pesquisa_ml_meus m on m.mlb = a.mlb where a.sku in (select sku from skus)
  ),
  ml_cats(category_id, grau) as (
    select category_id, 0 from ml_cat_base
    union select c.pai_id, mc.grau + 1 from ml_cats mc join pesquisa_ml_categorias c on c.category_id = mc.category_id
      where c.pai_id is not null and mc.grau < 2
  ),
  ml_ult as (select category_id, max(data_coleta) d from pesquisa_ml_tendencias group by 1),
  ml as (
    select distinct on (ia_norm(t.palavra)) t.palavra as termo, t.posicao, t.tipo, t.category_id,
           (select min(grau) from ml_cats c where c.category_id = t.category_id) as grau
    from pesquisa_ml_tendencias t join ml_ult u on u.category_id = t.category_id and u.d = t.data_coleta
    order by ia_norm(t.palavra), (select min(grau) from ml_cats c where c.category_id = t.category_id) nulls last, t.posicao
  ),
  todos as (
    select 'shopee' as fonte, termo, volume::numeric as peso, null::int as posicao, null::text as tipo, null::text as categoria, null::int as grau from sp
    union all select 'amazon', termo, null, rank_busca, null, null, null from amz
    union all select 'ml', termo, null, posicao, tipo, category_id, grau from ml
  ),
  aval as (
    select t.*, ia_tokens(t.termo) as tk,
           exists (select 1 from marcas m where ' ' || ia_norm(t.termo) || ' ' like '% ' || m.m || ' %') as concorrente
    from todos t
  ),
  -- relevância: o termo tem o núcleo do produto e (todas as palavras confirmadas OU ao menos metade no nome)
  rel as (
    select a.*, (a.tk <@ v_tit and cardinality(a.tk) > 0) as no_titulo, (a.tk <@ v_voc) as confirmado
    from aval a
    where cardinality(a.tk) > 0 and v_nucleo = any (a.tk)
      and (a.tk <@ v_voc or (select count(*) from unnest(a.tk) x where x = any (v_tok))::numeric / cardinality(a.tk) >= 0.5)
  ),
  shopee_l as (select * from rel where fonte = 'shopee' order by peso desc nulls last limit 30),
  amazon_l as (select * from rel where fonte = 'amazon' and not concorrente order by posicao limit 20),
  ml_l as (select * from rel where fonte = 'ml' and not concorrente order by grau nulls last, posicao limit 20),
  -- ordem de força para montar palavras escondidas / modelo (SÓ termos confirmados): Shopee pelo volume, depois
  -- Amazon e Mercado Livre
  fortes as (
    select termo, tk, no_titulo, 1 as o, row_number() over (order by peso desc nulls last) as r from shopee_l where not concorrente and confirmado
    union all select termo, tk, no_titulo, 2, row_number() over (order by posicao) from amazon_l where confirmado
    union all select termo, tk, no_titulo, 3, row_number() over (order by grau nulls last, posicao) from ml_l where confirmado
  ),
  -- Amazon: palavras dos termos fortes que NÃO estão no título, sem repetir, até 249 bytes (campo generic_keyword)
  palavras as (
    select w, min(o * 1000 + r) as ordem, min(case o when 3 then 0 when 1 then 1 else 2 end * 1000 + r) as ordem_ml from (
      select lower(p) as w, f.o, f.r from fortes f, regexp_split_to_table(f.termo, '\s+') p
    ) z
    where cardinality(ia_tokens(w)) = 1 and not (ia_tokens(w) <@ (case when v_tit = '{}' then v_tok else v_tit end))
    group by w
  ),
  palavras_dedup as (
    select distinct on ((ia_tokens(w))[1]) w, ordem, ordem_ml from palavras order by (ia_tokens(w))[1], ordem
  ),
  palavras_acum as (
    select w, ordem, sum(octet_length(w) + 1) over (order by ordem) as tam from palavras_dedup
  ),
  -- Mercado Livre: Modelo = as mesmas palavras que o título não cobre, na ordem dos termos em alta do ML
  -- (depois Shopee e Amazon), até 60 caracteres
  modelo_acum as (
    select w, ordem_ml, sum(length(w) + 1) over (order by ordem_ml) as tam from palavras_dedup
  )
  select jsonb_build_object(
    'sku', p_sku, 'nome', v_nome, 'marca', v_marca, 'nucleo', v_nucleo,
    'shopee', coalesce((select jsonb_agg(jsonb_build_object('termo', termo, 'volume', peso, 'no_titulo', no_titulo, 'concorrente', concorrente, 'confirmado', confirmado)
                         order by peso desc nulls last) from shopee_l), '[]'),
    'amazon', coalesce((select jsonb_agg(jsonb_build_object('termo', termo, 'rank', posicao, 'no_titulo', no_titulo, 'confirmado', confirmado) order by posicao) from amazon_l), '[]'),
    'ml', coalesce((select jsonb_agg(jsonb_build_object('termo', termo, 'posicao', posicao, 'tipo', tipo, 'categoria', categoria,
                     'da_categoria', grau is not null, 'no_titulo', no_titulo, 'confirmado', confirmado) order by grau nulls last, posicao) from ml_l), '[]'),
    'palavras_ocultas', coalesce((select string_agg(w, ' ' order by ordem) from palavras_acum where tam <= 249), ''),
    'modelo_sugerido', coalesce((select string_agg(w, ' ' order by ordem_ml) from modelo_acum where tam <= 61), ''),
    'cobertura', jsonb_build_object(
      'total', (select count(*) from fortes where r <= 10),
      'no_titulo', (select count(*) from fortes where r <= 10 and no_titulo)),
    'fontes', jsonb_build_object(
      'shopee_em', (select max(em) from sp), 'shopee_itens', (select count(*) from itens_shopee),
      'amazon_semana', (select s from amz_semana), 'ml_categorias', (select count(*) from ml_cat_base),
      'ml_em', (select max(d) from ml_ult))
  ) into v;
  return v;
end $function$;

revoke all on function public.ia_termos_busca(text, text) from public, anon;
grant execute on function public.ia_termos_busca(text, text) to authenticated, service_role;
revoke all on function public.ia_tokens(text) from public, anon;
grant execute on function public.ia_tokens(text) to authenticated, service_role;
revoke all on function public.ia_norm(text) from public, anon;
grant execute on function public.ia_norm(text) to authenticated, service_role;
