-- ============================================================================
-- Produção — ficha com MISTURA (28/out/2026, pedido do dono): SKU 16640 "Areia para Gatos Tofu e Mandioca
-- Bumi Pet Care 4kg". Receita: 4 kg de farinha de mandioca média (big bag) + 1 pacote de 2,5 kg da areia de
-- tofu Elo Imports Lavanda (SKU 16080, comprado e controlado no Tiny), misturados e envasados em sacos de
-- 4 kg (saco R$ 0,90 + etiqueta adesiva R$ 0,40). Cada saco leva ≈ 2,52 kg de farinha + 0,63 pacote de tofu.
-- Decisões do dono (28/out): mistura em saco de 4 kg; mandioca do big bag; ao lançar o lote no Tiny, além da
-- ENTRADA do 16640, dá SAÍDA dos pacotes de 16080 usados (o tofu também é vendido sozinho).
-- No encerramento a equipe informa os PACOTES de tofu abertos; a farinha do lote = pacotes × 4 kg.
-- Migração aplicada: producao_mistura_tofu.
-- ============================================================================

alter table producao_insumo drop constraint producao_insumo_tipo_check;
alter table producao_insumo add constraint producao_insumo_tipo_check
  check (tipo = any (array['farinha','embalagem','etiqueta','outro','produto']));
alter table producao_tiny_lanc drop constraint producao_tiny_lanc_papel_check;
alter table producao_tiny_lanc add constraint producao_tiny_lanc_papel_check
  check (papel = any (array['acabado','farinha','embalagem','etiqueta','entrada','mistura']));

-- Componente da mistura (produto do Tiny), embalagem e etiqueta do 16640.
insert into producao_insumo (nome, tipo, unidade, custo_referencia, tiny_sku, tiny_produto_id)
values ('Areia de tofu Elo Imports Lavanda 2,5 kg (16080)', 'produto', 'un', 16.89, '16080', 820094847);
insert into producao_insumo (nome, tipo, unidade, custo_referencia)
values ('Etiqueta adesiva — Tofu e Mandioca', 'etiqueta', 'un', 0.40);
insert into producao_insumo (nome, tipo, unidade, custo_referencia, precisa_etiqueta, etiqueta_id)
select 'Saco 4 kg — Tofu e Mandioca', 'embalagem', 'un', 0.90, true, id
  from producao_insumo where nome = 'Etiqueta adesiva — Tofu e Mandioca';

alter table producao_parametros
  add column mistura_insumo_id bigint references producao_insumo(id),
  add column mistura_un_kg numeric,        -- kg de UM pacote do componente (2,5)
  add column mistura_farinha_kg numeric;   -- kg de farinha que vão com cada pacote (4)
alter table producao_parametros add constraint producao_parametros_mistura_check
  check (mistura_insumo_id is null or (mistura_un_kg > 0 and mistura_farinha_kg > 0));
alter table producao_ordem add column mistura_un integer;  -- pacotes do componente usados no lote

insert into producao_parametros (sku, farinha_id, embalagem_padrao_id, prefixo_lote, peso_nominal_kg, sobrepeso_pct,
  perda_pct, tolerancia_g, custo_insumo_kg, pesar_cada, pesar_primeiros,
  mistura_insumo_id, mistura_un_kg, mistura_farinha_kg)
select '16640', 1, (select id from producao_insumo where nome = 'Saco 4 kg — Tofu e Mandioca'), 'BUMITM4', 4, 0.005,
  0.02, 60, 2.548, 10, 5, (select id from producao_insumo where tiny_sku = '16080' and tipo = 'produto'), 2.5, 4;

-- Estoque de matéria-prima do app: o componente 'produto' tem o estoque no Tiny, não aqui.
create or replace view view_producao_estoque as
 SELECT i.id AS insumo_id, i.nome, i.tipo, i.unidade, i.custo_referencia,
    COALESCE(e.qtd, 0::numeric) AS entradas, COALESCE(c.qtd, 0::numeric) AS consumido,
    COALESCE(e.qtd, 0::numeric) - COALESCE(c.qtd, 0::numeric) AS saldo,
    round(e.valor / NULLIF(e.qtd, 0::numeric), 4) AS custo_medio, e.ultima_entrada
   FROM producao_insumo i
     LEFT JOIN LATERAL ( SELECT sum(producao_entrada.quantidade) AS qtd,
            sum(producao_entrada.quantidade * producao_entrada.custo_un) AS valor,
            max(producao_entrada.recebido_em) AS ultima_entrada
           FROM producao_entrada WHERE producao_entrada.insumo_id = i.id) e ON true
     LEFT JOIN LATERAL ( SELECT sum(producao_consumo.quantidade) AS qtd
           FROM producao_consumo WHERE producao_consumo.insumo_id = i.id) c ON true
  WHERE i.ativo AND i.tipo <> 'produto';

-- Lote: farinha padrão = consumo × fração de farinha da receita; custo padrão inclui o componente.
create or replace view view_producao_lote as
 SELECT o.id, o.codigo, o.sku, pr.nome AS produto, o.status, o.data, o.turno, o.qtd_planejada, o.inicio_em, o.fim_em,
    b.codigo AS big_bag, b.nf_numero, e.nome AS embalagem, e.precisa_etiqueta, cnt.envasados,
    COALESCE(rf.refugo, 0) AS refugo,
    COALESCE(o.qtd_boa_final, cnt.envasados - COALESCE(rf.refugo, 0)) AS boas,
    COALESCE(fd.sacos_em_fardo, 0) AS sacos_em_fardo, fd.fardos,
    p.peso_nominal_kg * 1000::numeric AS nominal_g, p.tolerancia_g, p.pesar_cada, p.pesar_primeiros,
    ps.n AS pesagens, ps.media_g, ps.desvio_g, ps.min_g, ps.max_g, ps.abaixo_t, ps.ultima_em AS ultima_pesagem_em,
        CASE
            WHEN ps.n = 0 THEN NULL::text
            WHEN ps.media_g < (p.peso_nominal_kg * 1000::numeric) THEN 'abaixo_nominal'::text
            WHEN ps.media_g < (p.peso_nominal_kg * 1000::numeric * (1::numeric + p.sobrepeso_pct / 2::numeric)) THEN 'atencao'::text
            ELSE 'ok'::text
        END AS alerta_peso,
    round(EXTRACT(epoch FROM COALESCE(o.fim_em, now()) - o.inicio_em) / 60::numeric) AS minutos_total,
    COALESCE(pa.minutos, 0::numeric) AS minutos_parados,
    pa.aberta IS NOT NULL AS parado_agora, pa.aberta AS parada_motivo,
    round(cnt.envasados::numeric / NULLIF((EXTRACT(epoch FROM COALESCE(o.fim_em, now()) - o.inicio_em) / 60::numeric - COALESCE(pa.minutos, 0::numeric)) / 60::numeric, 0::numeric), 1) AS un_hora,
    et.pessoas,
    p.consumo_padrao_kg,
    round(COALESCE(o.qtd_boa_final, cnt.envasados - COALESCE(rf.refugo, 0))::numeric * p.consumo_padrao_kg * mx.fp, 3) AS consumo_padrao_total_kg,
    cs.farinha_kg AS consumo_real_kg,
    cs.farinha_kg - round(COALESCE(o.qtd_boa_final, cnt.envasados - COALESCE(rf.refugo, 0))::numeric * p.consumo_padrao_kg * mx.fp, 3) AS variacao_kg,
    round(p.consumo_padrao_kg * mx.fp * p.custo_insumo_kg + COALESCE(mx.un_por_saco * mx.custo_un, 0::numeric)
        + COALESCE(e.custo_referencia, 0::numeric) +
        CASE WHEN e.precisa_etiqueta THEN COALESCE(et_i.custo_referencia, 0::numeric) ELSE 0::numeric END
        + cfg.custo_conversao_un, 4) AS custo_padrao_un,
        CASE
            WHEN o.status = 'encerrada'::text AND COALESCE(o.qtd_boa_final, 0) > 0 THEN round(COALESCE(cs.custo, 0::numeric) / o.qtd_boa_final::numeric + cfg.custo_conversao_un, 4)
            ELSE NULL::numeric
        END AS custo_real_un,
    o.sobra_kg, o.embalagens_usadas, o.etiquetas_usadas, o.tiny_lancado_em,
    -- novas (28/out): mistura
    round(p.consumo_padrao_kg * mx.fp, 4) AS farinha_padrao_kg,
    mi.tiny_sku AS mistura_sku,
    mi.nome AS mistura_nome,
    p.mistura_un_kg,
    p.mistura_farinha_kg,
    round(mx.un_por_saco, 5) AS mistura_un_por_saco,
    o.mistura_un AS mistura_un_usadas,
    mx.custo_un AS mistura_custo_un
   FROM producao_ordem o
     JOIN producao_parametros p ON p.sku = o.sku
     JOIN producao_entrada b ON b.id = o.entrada_id
     LEFT JOIN produtos pr ON pr.sku = o.sku
     LEFT JOIN producao_insumo e ON e.id = o.embalagem_id
     LEFT JOIN producao_insumo et_i ON et_i.id = e.etiqueta_id
     LEFT JOIN producao_insumo mi ON mi.id = p.mistura_insumo_id
     LEFT JOIN produtos mp ON mp.sku = mi.tiny_sku
     CROSS JOIN LATERAL ( SELECT
            COALESCE(p.mistura_farinha_kg / NULLIF(p.mistura_farinha_kg + p.mistura_un_kg, 0::numeric), 1::numeric) AS fp,
            p.consumo_padrao_kg / NULLIF(p.mistura_farinha_kg + p.mistura_un_kg, 0::numeric) AS un_por_saco,
            CASE WHEN mi.id IS NOT NULL THEN COALESCE(NULLIF(mp.custo, 0::numeric), mi.custo_referencia) END AS custo_un) mx
     CROSS JOIN producao_config cfg
     LEFT JOIN LATERAL ( SELECT COALESCE(sum(producao_contagem.qtd), 0::bigint)::integer AS envasados
           FROM producao_contagem WHERE producao_contagem.ordem_id = o.id) cnt ON true
     LEFT JOIN LATERAL ( SELECT sum(producao_refugo.qtd)::integer AS refugo
           FROM producao_refugo WHERE producao_refugo.ordem_id = o.id) rf ON true
     LEFT JOIN LATERAL ( SELECT sum(f.sacos_por_fardo * f.n)::integer AS sacos_em_fardo,
            jsonb_object_agg(f.sacos_por_fardo, f.n) AS fardos
           FROM ( SELECT producao_fardo.sacos_por_fardo, sum(producao_fardo.qtd_fardos) AS n
                   FROM producao_fardo WHERE producao_fardo.ordem_id = o.id
                  GROUP BY producao_fardo.sacos_por_fardo) f) fd ON true
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS n, round(avg(producao_pesagem.peso_g), 1) AS media_g,
            round(stddev_samp(producao_pesagem.peso_g), 1) AS desvio_g, min(producao_pesagem.peso_g) AS min_g,
            max(producao_pesagem.peso_g) AS max_g,
            count(*) FILTER (WHERE producao_pesagem.peso_g::numeric < (p.peso_nominal_kg * 1000::numeric - p.tolerancia_g::numeric))::integer AS abaixo_t,
            max(producao_pesagem.em) AS ultima_em
           FROM producao_pesagem WHERE producao_pesagem.ordem_id = o.id) ps ON true
     LEFT JOIN LATERAL ( SELECT round(sum(EXTRACT(epoch FROM COALESCE(producao_parada.fim_em, now()) - producao_parada.inicio_em)) / 60::numeric) AS minutos,
            max(producao_parada.motivo) FILTER (WHERE producao_parada.fim_em IS NULL) AS aberta
           FROM producao_parada WHERE producao_parada.ordem_id = o.id) pa ON true
     LEFT JOIN LATERAL ( SELECT jsonb_object_agg(producao_etapa.etapa, producao_etapa.pessoa_id) AS pessoas
           FROM producao_etapa WHERE producao_etapa.ordem_id = o.id AND producao_etapa.fim_em IS NULL) et ON true
     LEFT JOIN LATERAL ( SELECT sum(c.quantidade) FILTER (WHERE i2.tipo = 'farinha'::text) AS farinha_kg, sum(c.custo) AS custo
           FROM producao_consumo c JOIN producao_insumo i2 ON i2.id = c.insumo_id
          WHERE c.ordem_id = o.id) cs ON true;

-- Abrir lote: com mistura, o saldo do big bag é comparado à farinha por saco (não ao saco inteiro).
CREATE OR REPLACE FUNCTION public.producao_abrir_lote(p_sku text, p_big_bag bigint, p_embalagem bigint DEFAULT NULL::bigint, p_qtd_planejada integer DEFAULT NULL::integer, p_pessoas jsonb DEFAULT '{}'::jsonb, p_turno text DEFAULT NULL::text)
 RETURNS producao_ordem
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_par producao_parametros; v_bag view_producao_big_bag; v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
  v_n int; v_op producao_ordem; v_emb bigint; k text; v text; v_far numeric;
begin
  if not tem_modulo('galpao') then raise exception 'sem acesso à produção'; end if;
  select * into v_par from producao_parametros where sku = p_sku and ativo;
  if not found then raise exception 'SKU % sem ficha técnica', p_sku; end if;
  -- farinha por saco: o saco inteiro, ou só a parte de farinha da receita quando há mistura
  v_far := v_par.consumo_padrao_kg * coalesce(v_par.mistura_farinha_kg / nullif(v_par.mistura_farinha_kg + v_par.mistura_un_kg, 0), 1);
  select * into v_bag from view_producao_big_bag where id = p_big_bag;
  if not found then raise exception 'big bag não encontrado'; end if;
  if v_bag.a_classificar then raise exception 'classifique a farinha do big bag % antes de abrir o lote', v_bag.codigo; end if;
  if v_bag.insumo_id is distinct from v_par.farinha_id then raise exception 'o big bag % não é da farinha do SKU %', v_bag.codigo, p_sku; end if;
  if v_bag.lote_aberto is not null then raise exception 'big bag já está no lote %', v_bag.lote_aberto; end if;
  if v_bag.saldo_kg < v_far then raise exception 'big bag sem saldo'; end if;
  v_emb := coalesce(p_embalagem, v_par.embalagem_padrao_id);
  perform pg_advisory_xact_lock(hashtext('producao_lote:' || v_par.prefixo_lote || v_dia));
  select count(*) + 1 into v_n from producao_ordem where codigo like v_par.prefixo_lote || '-' || to_char(v_dia, 'YYYYMMDD') || '-%';
  insert into producao_ordem (codigo, sku, entrada_id, embalagem_id, data, turno, qtd_planejada)
  values (v_par.prefixo_lote || '-' || to_char(v_dia, 'YYYYMMDD') || '-' || lpad(v_n::text, 2, '0'), p_sku, p_big_bag, v_emb, v_dia, p_turno,
          coalesce(p_qtd_planejada, floor(v_bag.saldo_kg / v_far)::int)) returning * into v_op;
  for k, v in select * from jsonb_each_text(p_pessoas) loop
    if v is not null and v <> '' then insert into producao_etapa (ordem_id, etapa, pessoa_id) values (v_op.id, k, v); end if;
  end loop;
  return v_op;
end $function$;

-- Encerrar: + p_mistura_un (pacotes do componente abertos). Com mistura, farinha = pacotes × kg de farinha por pacote.
drop function public.producao_encerrar_lote(bigint, integer, integer, integer, integer, numeric, text, boolean);
CREATE FUNCTION public.producao_encerrar_lote(p_ordem bigint, p_boas integer, p_refugo integer, p_embalagens integer,
  p_etiquetas integer DEFAULT 0, p_sobra_kg numeric DEFAULT 0, p_obs text DEFAULT NULL::text, p_bag_acabou boolean DEFAULT false,
  p_mistura_un integer DEFAULT NULL::integer)
 RETURNS producao_ordem
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare o producao_ordem; b view_producao_big_bag; emb producao_insumo; v_kg numeric; v_eti bigint;
  par producao_parametros; mi producao_insumo; v_un int := null; v_custo_mi numeric;
begin
  if not tem_modulo('galpao') then raise exception 'sem acesso à produção'; end if;
  select * into o from producao_ordem where id = p_ordem for update;
  if not found then raise exception 'lote não encontrado'; end if;
  if o.status <> 'aberta' then raise exception 'o lote % já está %', o.codigo, o.status; end if;
  if coalesce(p_boas, -1) < 0 or coalesce(p_refugo, 0) < 0 or coalesce(p_embalagens, 0) < 0
     or coalesce(p_etiquetas, 0) < 0 or coalesce(p_sobra_kg, 0) < 0 or coalesce(p_mistura_un, 0) < 0 then
    raise exception 'quantidades não podem ser negativas'; end if;
  select * into b from view_producao_big_bag where id = o.entrada_id;
  if coalesce(p_sobra_kg, 0) > b.saldo_kg then raise exception 'sobra de % kg é maior que o saldo do big bag (% kg)', p_sobra_kg, b.saldo_kg; end if;
  select * into par from producao_parametros where sku = o.sku;
  if par.mistura_insumo_id is not null then
    select * into mi from producao_insumo where id = par.mistura_insumo_id;
    -- pacotes abertos: o informado, senão o padrão da receita
    v_un := coalesce(p_mistura_un, round((coalesce(p_boas, 0) + coalesce(p_refugo, 0)) * par.consumo_padrao_kg
                                           / (par.mistura_farinha_kg + par.mistura_un_kg))::int);
  end if;
  if coalesce(p_bag_acabou, false) then
    v_kg := b.saldo_kg;
  elsif coalesce(p_sobra_kg, 0) > 0 then
    v_kg := b.saldo_kg - p_sobra_kg;
  elsif v_un is not null then
    v_kg := least(b.saldo_kg, round(v_un * par.mistura_farinha_kg, 3));
  else
    if par.consumo_padrao_kg is null then raise exception 'o SKU % não tem consumo padrão na ficha técnica', o.sku; end if;
    v_kg := least(b.saldo_kg, round((coalesce(p_boas, 0) + coalesce(p_refugo, 0)) * par.consumo_padrao_kg, 3));
  end if;
  insert into producao_consumo (ordem_id, insumo_id, entrada_id, quantidade, custo_un) values (o.id, b.insumo_id, b.id, v_kg, b.custo_kg);
  if v_un is not null and v_un > 0 then
    select coalesce(nullif(custo, 0), mi.custo_referencia, 0) into v_custo_mi from produtos where sku = mi.tiny_sku;
    insert into producao_consumo (ordem_id, insumo_id, quantidade, custo_un)
    values (o.id, mi.id, v_un, coalesce(v_custo_mi, mi.custo_referencia, 0));
  end if;
  if o.embalagem_id is not null then select * into emb from producao_insumo where id = o.embalagem_id; end if;
  if coalesce(p_embalagens, 0) > 0 then
    if emb.id is null then raise exception 'o lote não tem embalagem definida'; end if;
    insert into producao_consumo (ordem_id, insumo_id, quantidade, custo_un)
    values (o.id, emb.id, p_embalagens, coalesce((select custo_medio from view_producao_estoque where insumo_id = emb.id), emb.custo_referencia, 0));
  end if;
  if coalesce(p_etiquetas, 0) > 0 then
    v_eti := emb.etiqueta_id;
    if v_eti is null then raise exception 'a embalagem do lote não usa etiqueta'; end if;
    insert into producao_consumo (ordem_id, insumo_id, quantidade, custo_un)
    values (o.id, v_eti, p_etiquetas, coalesce((select custo_medio from view_producao_estoque where insumo_id = v_eti),
                                                 (select custo_referencia from producao_insumo where id = v_eti), 0));
  end if;
  update producao_etapa set fim_em = now() where ordem_id = o.id and fim_em is null;
  update producao_parada set fim_em = now() where ordem_id = o.id and fim_em is null;
  update producao_ordem set status = 'encerrada', fim_em = now(), qtd_boa_final = p_boas, refugo_final = coalesce(p_refugo, 0),
         embalagens_usadas = coalesce(p_embalagens, 0), etiquetas_usadas = coalesce(p_etiquetas, 0),
         sobra_kg = b.saldo_kg - v_kg, mistura_un = v_un,
         obs = coalesce(nullif(p_obs, ''), obs)
   where id = o.id returning * into o;
  return o;
end $function$;
revoke all on function public.producao_encerrar_lote(bigint, integer, integer, integer, integer, numeric, text, boolean, integer) from public, anon;
grant execute on function public.producao_encerrar_lote(bigint, integer, integer, integer, integer, numeric, text, boolean, integer) to authenticated, service_role;

-- ROLLBACK (manual):
--   delete from producao_parametros where sku = '16640';
--   drop function producao_encerrar_lote(bigint,int,int,int,int,numeric,text,boolean,int); recriar a de 8 args (migração producao_consumo_pelo_produzido)
--   view_producao_lote / view_producao_estoque / producao_abrir_lote: versões da migração anterior
--   alter table producao_ordem drop column mistura_un; alter table producao_parametros drop column mistura_insumo_id, drop column mistura_un_kg, drop column mistura_farinha_kg;
--   delete from producao_insumo where nome in ('Saco 4 kg — Tofu e Mandioca','Etiqueta adesiva — Tofu e Mandioca') or (tipo='produto' and tiny_sku='16080');
