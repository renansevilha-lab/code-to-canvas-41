-- Coordenador, 2ª parte (23/nov/2026, pedidos do dono depois de ver a 1ª lista):
--   1. Compras: a decisão enxerga o RASCUNHO/orçamento do produto (ex.: Mya Cat 15983 tinha o SUG-2 de 18/11 e a decisão dizia
--      "sem ordem de compra aberta").
--   2. Cada decisão traz CAMINHOS (A, B, C…) em vez de uma saída só, e `ref` = para onde a tela abre (análise do ADS,
--      preço e promoção, compras, contas a pagar).
--   3. ESTRATÉGIA: "este ROAS está baixo de propósito" vira registro (objetivo, piso de ROAS, meta de posição no ML, quando
--      revisar). Com estratégia ativa o coordenador para de cobrar aquele ADS e passa a ACOMPANHAR: só volta a avisar se o
--      ROAS cair do piso, se a meta de posição for atingida ou quando chegar o dia de revisar.
--
-- Depende de docs/coordenador.sql. Rollback:
--   drop function public.decisao_estrategia(bigint, text, numeric, int, date); drop function public.estrategia_encerrar(bigint, text);
--   drop function public.estrategia_atualizar(bigint, text, numeric, int, date); drop function public.coord_estrategias(date);
--   drop function public.coord_posicao_ml(text); drop table public.agente_estrategias;
--   alter table public.agente_decisoes drop column opcoes, drop column ref, drop column opcao_escolhida;
--   e reaplicar docs/coordenador.sql (coordenador_candidatas, coordenador_gerar, coordenador_painel, decisao_aprovar de 4 parâmetros).

alter table public.agente_decisoes add column opcoes jsonb, add column ref jsonb, add column opcao_escolhida text;
alter table public.agente_decisoes drop constraint agente_decisoes_status_check;
alter table public.agente_decisoes add constraint agente_decisoes_status_check
  check (status in ('aberta', 'aprovada', 'recusada', 'feita', 'sumiu', 'estrategia'));

create table public.agente_estrategias (
  id            bigserial primary key,
  mkt           text,                 -- 'ml' | 'shopee' | null (vale para o produto em qualquer canal)
  campanha      text,                 -- id da campanha de ADS (ou null = pelo SKU)
  sku           text,
  nome          text not null,        -- como aparece na tela (nome da campanha/produto)
  objetivo      text not null,        -- nas palavras do dono
  roas_piso     numeric,              -- abaixo disso o coordenador volta a avisar (null = sem piso)
  meta_posicao  int,                  -- posição buscada no ranking da categoria do ML (ex.: 10 = top 10)
  revisar_em    date,
  ativo         boolean not null default true,
  decisao_id    bigint,
  ref           jsonb,
  criado_por    text,
  criado_em     timestamptz not null default now(),
  encerrada_em  timestamptz,
  encerrada_por text,
  motivo_fim    text
);
create index agente_estrategias_ativas on public.agente_estrategias (mkt, campanha) where ativo;
alter table public.agente_estrategias enable row level security;
create policy agente_estrategias_ler on public.agente_estrategias for select to authenticated using (public.tem_modulo('todos'));
revoke all on public.agente_estrategias from anon, authenticated;
grant select on public.agente_estrategias to authenticated;

-- Melhor posição do produto no top 20 da categoria dele no Mercado Livre (última coleta da pesquisa de produtos).
-- Conta o anúncio próprio, o catálogo em que participamos e o nosso user_product. posicao nula = fora do top 20.
create or replace function public.coord_posicao_ml(p_sku text, out categoria text, out posicao int, out coletado date)
language sql stable set search_path = public as $$
  with meus as (
    select a.mlb, m.category_id, m.catalog_product_id, m.user_product_id
      from ml_anuncios a join pesquisa_ml_meus m on m.mlb = a.mlb where a.sku = p_sku and a.status = 'active'),
  cat as (select category_id from meus group by 1 order by count(*) desc limit 1),
  ult as (select max(r.data_coleta) d from pesquisa_ml_ranking r where r.category_id = (select category_id from cat))
  select c.nome,
         (select min(r.posicao) from pesquisa_ml_ranking r
           where r.category_id = c.category_id and r.data_coleta = ult.d
             and (r.ml_id in (select mlb from meus) or r.ml_id in (select catalog_product_id from meus)
                  or r.ml_id in (select user_product_id from meus) or r.meu_mlb in (select mlb from meus)))::int,
         ult.d
    from cat join pesquisa_ml_categorias c on c.category_id = cat.category_id cross join ult $$;

-- Estratégias ativas com os números de hoje (ADS do relatório do dia + posição no ML).
create or replace function public.coord_estrategias(p_dia date)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare ads jsonb; e record; m jsonb; v_cat text; v_pos int; v_col date; v_hoje text; v_out jsonb := '[]'::jsonb;
begin
  select r.resumo into ads from relatorios_agentes r where r.agente = 'ads' and r.data_referencia <= p_dia order by r.data_referencia desc limit 1;
  for e in select * from agente_estrategias where ativo order by criado_em loop
    m := null; v_cat := null; v_pos := null; v_col := null;
    select x into m from jsonb_array_elements(coalesce(ads #> '{metas,itens}', '[]'::jsonb)) x
     where (e.campanha is not null and x ->> 'campanha' = e.campanha and x ->> 'mkt' = coalesce(e.mkt, x ->> 'mkt'))
        or (e.campanha is null and x ->> 'sku' = e.sku and x ->> 'mkt' = coalesce(e.mkt, x ->> 'mkt'))
     order by (x ->> 'gasto_7d')::numeric desc nulls last limit 1;
    if e.sku is not null and coalesce(e.mkt, 'ml') = 'ml' then select p.categoria, p.posicao, p.coletado into v_cat, v_pos, v_col from coord_posicao_ml(e.sku) p; end if;
    v_hoje := concat_ws(' · ',
      case when m is not null then format('ROAS %s em 7 dias%s', rel_n1((m ->> 'roas_7d')::numeric),
             case when m ->> 'roas_equilibrio' is not null then ' (empate em ' || rel_n1((m ->> 'roas_equilibrio')::numeric) || ')' else '' end) end,
      case when m is not null then rel_rs((m ->> 'gasto_7d')::numeric) || ' de ADS e ' || (m ->> 'pedidos_7d') || ' pedidos na semana' end,
      case when m is not null and coalesce((m ->> 'perda_7d')::numeric, 0) > 0 then 'custo da estratégia: ' || rel_rs((m ->> 'perda_7d')::numeric) || ' na semana' end,
      case when v_cat is not null then
        case when v_pos is not null then v_pos || 'º em ' || v_cat else 'fora do top 20 em ' || v_cat end
        || ' (ML, ' || to_char(v_col, 'DD/MM') || ')' end);
    v_out := v_out || jsonb_build_object(
      'id', e.id, 'mkt', e.mkt, 'campanha', e.campanha, 'sku', e.sku, 'nome', e.nome, 'objetivo', e.objetivo,
      'roas_piso', e.roas_piso, 'meta_posicao', e.meta_posicao, 'revisar_em', e.revisar_em, 'criado_em', e.criado_em, 'criado_por', e.criado_por,
      'ref', e.ref, 'roas_7d', (m ->> 'roas_7d')::numeric, 'gasto_7d', (m ->> 'gasto_7d')::numeric, 'perda_7d', (m ->> 'perda_7d')::numeric,
      'roas_equilibrio', (m ->> 'roas_equilibrio')::numeric, 'posicao', v_pos, 'categoria', v_cat, 'coletado', v_col,
      'hoje', nullif(v_hoje, ''));
  end loop;
  return v_out;
end $fn$;

drop function public.coordenador_candidatas(date);
create function public.coordenador_candidatas(p_dia date)
returns table (d_chave text, d_agente text, d_tom text, d_o_que text, d_detalhe text, d_sku text, d_valor numeric, d_prazo date, d_nota text,
               d_opcoes jsonb, d_ref jsonb)
language plpgsql set search_path = public, extensions as $fn$
declare
  fin jsonb; com jsonb; ads jsonb; pes jsonb; ten jsonb; pos jsonb;
  v_neg_dia date; v_neg_saldo numeric; v_neg_saidas numeric;
  v_q int; v_v numeric; v_t text; r record; cob record; rasc record; est record; pm record; v_rec numeric; v_cmv numeric; v_un numeric;
  v_mkt text; v_shop bigint; v_emp text; v_roas numeric; v_eq numeric; v_delta numeric; v_k numeric; v_pct numeric; v_pm numeric; v_tem_rasc boolean;
begin
  select r1.resumo into fin from relatorios_agentes r1 where r1.agente = 'financeiro' and r1.data_referencia = p_dia;
  select r1.resumo into com from relatorios_agentes r1 where r1.agente = 'compras' and r1.data_referencia = p_dia;
  select r1.resumo into ads from relatorios_agentes r1 where r1.agente = 'ads' and r1.data_referencia = p_dia;
  select r1.resumo into pes from relatorios_agentes r1 where r1.agente = 'pesquisa_ml' and r1.data_referencia = p_dia;
  select r1.resumo into ten from relatorios_agentes r1 where r1.agente = 'tendencias' and r1.data_referencia = p_dia;

  begin
    pos := dashboard_posicao_empresa();
    select (d ->> 'dia')::date, (d ->> 'saldo')::numeric, (d ->> 'saidas')::numeric into v_neg_dia, v_neg_saldo, v_neg_saidas
      from jsonb_array_elements(coalesce(pos #> '{fluxo,dias}', '[]'::jsonb)) d
     where (d ->> 'saldo')::numeric < 0 and (d ->> 'dia')::date <= p_dia + 7
     order by (d ->> 'dia')::date limit 1;
  exception when others then v_neg_dia := null; end;

  -- ============ FINANCEIRO ============
  d_sku := null; d_nota := null;
  if fin is not null then
    v_q := coalesce((fin #>> '{contas_pagar_resumo,atrasado,qtd}')::int, 0);
    v_v := coalesce((fin #>> '{contas_pagar_resumo,atrasado,valor}')::numeric, 0);
    if v_q > 0 then
      select string_agg(f, ' e ' order by s desc) into v_t from (
        select initcap(array_to_string((regexp_split_to_array(btrim(u ->> 'fornecedor'), '\s+'))[1:2], ' ')) f, sum((u ->> 'valor')::numeric) s
          from jsonb_array_elements(coalesce(fin -> 'contas_pagar_urgentes', '[]'::jsonb)) u where u ->> 'faixa' = 'atrasado'
         group by 1 order by 2 desc limit 2) x;
      d_chave := 'fin:atrasadas'; d_agente := 'financeiro'; d_tom := 'red';
      d_o_que := format('Pagar %s conta%s atrasada%s', v_q, case when v_q = 1 then '' else 's' end, case when v_q = 1 then '' else 's' end);
      d_detalhe := rel_rs(v_v) || ' em atraso' || coalesce('; maiores: ' || v_t, '');
      d_valor := v_v; d_prazo := p_dia;
      d_opcoes := jsonb_build_array(
        jsonb_build_object('letra', 'A', 'titulo', 'Pagar tudo hoje', 'texto', 'zera o atraso; confira antes se o caixa cobre'),
        jsonb_build_object('letra', 'B', 'titulo', 'Pagar as maiores e negociar o resto', 'texto', 'pedir novo vencimento ao fornecedor para o que não couber no caixa'),
        jsonb_build_object('letra', 'C', 'titulo', 'Já foram pagas: dar baixa no Tiny', 'texto', 'se o pagamento saiu e a conta segue aberta, o problema é só o registro'));
      d_ref := jsonb_build_object('tipo', 'contas', 'filtro', 'vencido');
      return next;
    end if;
    v_q := coalesce((fin #>> '{contas_pagar_resumo,hoje,qtd}')::int, 0);
    v_v := coalesce((fin #>> '{contas_pagar_resumo,hoje,valor}')::numeric, 0);
    if v_q > 0 then
      d_chave := 'fin:vence_hoje'; d_agente := 'financeiro'; d_tom := 'amber';
      d_o_que := format('Pagar %s conta%s que vence%s hoje', v_q, case when v_q = 1 then '' else 's' end, case when v_q = 1 then '' else 'm' end);
      d_detalhe := rel_rs(v_v); d_valor := v_v; d_prazo := p_dia; d_opcoes := null;
      d_ref := jsonb_build_object('tipo', 'contas', 'filtro', 'hoje');
      return next;
    end if;
    for r in select d from jsonb_array_elements(coalesce(fin #> '{conciliacao,decisoes}', '[]'::jsonb)) d loop
      d_chave := coalesce(r.d ->> 'chave', 'fin:conc:' || md5(coalesce(r.d ->> 'o_que', ''))); d_agente := 'financeiro';
      d_tom := case when r.d ->> 'tom' in ('red', 'amber', 'gray') then r.d ->> 'tom' else 'amber' end;
      d_o_que := r.d ->> 'o_que'; d_detalhe := r.d ->> 'detalhe'; d_sku := nullif(r.d ->> 'sku', '');
      d_valor := nullif(r.d ->> 'valor', '')::numeric; d_prazo := nullif(r.d ->> 'prazo', '')::date;
      d_opcoes := case when jsonb_typeof(r.d -> 'opcoes') = 'array' then r.d -> 'opcoes' end;
      d_ref := case when jsonb_typeof(r.d -> 'ref') = 'object' then r.d -> 'ref' end;
      if d_o_que is not null then return next; end if;
    end loop;
    d_sku := null;
  end if;
  if v_neg_dia is not null then
    d_chave := 'fin:caixa_negativo'; d_agente := 'financeiro'; d_tom := 'red';
    d_o_que := 'Cobrir o caixa de ' || to_char(v_neg_dia, 'DD/MM');
    d_detalhe := format('saldo projetado de −%s nesse dia (saídas de %s)', rel_rs(abs(v_neg_saldo)), rel_rs(v_neg_saidas));
    d_valor := abs(v_neg_saldo); d_prazo := v_neg_dia;
    d_opcoes := jsonb_build_array(
      jsonb_build_object('letra', 'A', 'titulo', 'Sacar o saldo das carteiras (Shopee e Mercado Pago)', 'texto', 'é o caminho mais rápido; o saldo está no relatório financeiro'),
      jsonb_build_object('letra', 'B', 'titulo', 'Empurrar vencimentos', 'texto', 'negociar com os fornecedores das maiores contas da semana'),
      jsonb_build_object('letra', 'C', 'titulo', 'Segurar compras novas', 'texto', 'comprar só o que está em ruptura até o caixa virar'));
    d_ref := jsonb_build_object('tipo', 'caixa');
    return next;
  end if;

  -- ============ COMPRAS ============
  for r in
    select a ->> 'sku' sku, a ->> 'produto' produto, a ->> 'status' st, (a ->> 'venda_dia')::numeric vd,
           coalesce((a ->> 'oc_aguardando')::numeric, 0) oc, (a ->> 'cobertura_total_dias')::numeric cobertura,
           (a ->> 'lead_time_dias')::numeric lead, e.preco_medio preco
      from jsonb_array_elements(coalesce(com -> 'atencao', '[]'::jsonb)) a
      left join mv_estoque_valor e on e.sku = a ->> 'sku'
     where a ->> 'status' in ('ruptura_empresa', 'comprar_urgente') and (a ->> 'venda_dia')::numeric >= 1
     order by (a ->> 'status' = 'ruptura_empresa') desc, (a ->> 'venda_dia')::numeric * coalesce(e.preco_medio, 1) desc
     limit 6
  loop
    -- rascunho de compra (sugestão do app) ou orçamento do Tiny com o produto: ainda não é pedido feito, mas existe
    select o.numero, o.data_pedido, o.data_prevista, i.quantidade,
           case when o.numero like 'SUG-%' then 'rascunho ' else 'orçamento ' end || o.numero as rotulo
      into rasc
      from compras_ordens o join compra_ordem_itens i on i.ordem_tiny_id = o.tiny_id
     where i.sku = r.sku and o.kanban_status = 'orcamento' and o.arquivada_em is null and not coalesce(i.so_na_nf, false) and i.quantidade > 0
     order by o.data_pedido desc limit 1;
    v_tem_rasc := found;

    d_agente := 'compras'; d_sku := r.sku; d_prazo := null;
    d_valor := case when r.preco is not null then round(r.vd * r.preco * 7, 2) end;
    d_ref := jsonb_build_object('tipo', 'compra', 'sku', r.sku, 'ordem', case when v_tem_rasc then rasc.numero end);
    if r.st = 'ruptura_empresa' then
      d_chave := 'compras:ruptura:' || r.sku;
      d_tom := case when r.oc > 0 then 'amber' else 'red' end;
      d_o_que := case when r.oc > 0 then 'Acompanhar a entrega de ' when v_tem_rasc then 'Fechar o pedido de ' else 'Comprar ' end || coord_curto(r.produto, 48);
      d_detalhe := format('sem estoque no galpão; vende %s por dia%s; %s', rel_n1(r.vd),
        case when r.preco is not null then ' (' || rel_rs(r.vd * r.preco) || ' por dia)' else '' end,
        case when r.oc > 0 then round(r.oc)::text || ' unidades em ordem de compra'
             when v_tem_rasc then format('o %s de %s tem %s unidades%s, mas ainda não consta como pedido feito ao fornecedor', rasc.rotulo,
                    to_char(rasc.data_pedido, 'DD/MM'), round(rasc.quantidade), coalesce(' (previsão ' || to_char(rasc.data_prevista, 'DD/MM') || ')', ''))
             else 'sem ordem de compra nem rascunho' end);
    else
      d_chave := 'compras:urgente:' || r.sku; d_tom := 'amber';
      d_o_que := case when v_tem_rasc then 'Fechar o pedido de ' else 'Comprar ' end || coord_curto(r.produto, 48);
      d_detalhe := format('estoque para %s dias e o fornecedor leva %s; vende %s por dia%s', rel_n1(greatest(r.cobertura, 0)), coalesce(round(r.lead)::text, '15'), rel_n1(r.vd),
        case when v_tem_rasc then format('; há o %s de %s com %s unidades, ainda não confirmado', rasc.rotulo, to_char(rasc.data_pedido, 'DD/MM'), round(rasc.quantidade)) else '' end);
    end if;
    d_opcoes := case
      when r.oc > 0 then jsonb_build_array(
        jsonb_build_object('letra', 'A', 'titulo', 'Cobrar a entrega do fornecedor', 'texto', 'confirmar a data e lançar a previsão na ordem de compra'),
        jsonb_build_object('letra', 'B', 'titulo', 'Pausar os anúncios e o ADS do produto até chegar', 'texto', 'evita vender o que não tem e gastar ADS à toa'))
      when v_tem_rasc then jsonb_build_array(
        jsonb_build_object('letra', 'A', 'titulo', 'Pedir ao fornecedor o que está no ' || rasc.rotulo, 'texto', 'depois lançar a ordem de compra no Tiny: a partir daí o sistema conta como mercadoria a caminho'),
        jsonb_build_object('letra', 'B', 'titulo', 'Já foi pedido: só lançar a ordem no Tiny', 'texto', 'no rascunho, usar "Já lancei no Tiny"; o aviso some quando a ordem chegar pelo espelho'),
        jsonb_build_object('letra', 'C', 'titulo', 'Pausar os anúncios e o ADS do produto até chegar', 'texto', 'evita vender o que não tem e gastar ADS à toa'))
      else jsonb_build_array(
        jsonb_build_object('letra', 'A', 'titulo', 'Montar a sugestão de compra e pedir ao fornecedor', 'texto', 'a cobertura em dias é escolha sua; o rascunho nasce em Compras'),
        jsonb_build_object('letra', 'B', 'titulo', 'Pausar os anúncios e o ADS do produto até chegar', 'texto', 'evita vender o que não tem e gastar ADS à toa'),
        jsonb_build_object('letra', 'C', 'titulo', 'Não repor', 'texto', 'se o produto está saindo de linha, recuse a decisão dizendo isso')) end;
    d_nota := case when v_neg_dia is not null and r.oc = 0
      then 'Caixa projetado negativo em ' || to_char(v_neg_dia, 'DD/MM') || ': negociar prazo com o fornecedor ou comprar o mínimo.' end;
    return next;
  end loop;

  -- ============ ADS (metas de ROAS por campanha) ============
  for r in
    select m from jsonb_array_elements(coalesce(ads #> '{metas,itens}', '[]'::jsonb)) m
     where m ->> 'tom' = 'ruim' and coalesce((m ->> 'perda_7d')::numeric, 0) >= 30
     order by (m ->> 'perda_7d')::numeric desc limit 8
  loop
    v_mkt := r.m ->> 'mkt'; v_roas := (r.m ->> 'roas_7d')::numeric; v_eq := (r.m ->> 'roas_equilibrio')::numeric;
    v_emp := case when (r.m ->> 'loja') ~* 'bumi|svl' then 'svl' else 'ottz' end;
    v_shop := case when v_mkt = 'ml' then 1107117809 when v_emp = 'svl' then 759046323 else 522186766 end;
    d_sku := nullif(r.m ->> 'sku', '');
    if d_sku is null and v_mkt = 'shopee' and (r.m ->> 'anuncio') ~ '^\d+$' then
      select a.sku_pai into d_sku from shopee_anuncios a where a.item_id = (r.m ->> 'anuncio')::bigint limit 1;
    end if;
    d_ref := jsonb_build_object('tipo', 'ads', 'mkt', v_mkt, 'campanha', r.m ->> 'campanha', 'anuncio', r.m ->> 'anuncio', 'shop', v_shop::text,
                                'sku', d_sku, 'empresa', v_emp, 'nome', r.m ->> 'nome', 'loja', r.m ->> 'loja');

    -- estratégia ativa para a campanha (ou para o produto naquele canal): só avisa se cair do piso combinado
    select e.* into est from agente_estrategias e
     where e.ativo and coalesce(e.mkt, v_mkt) = v_mkt
       and (e.campanha = r.m ->> 'campanha' or (e.campanha is null and e.sku is not null and e.sku = d_sku))
     order by (e.campanha is not null) desc limit 1;
    if found then
      if est.roas_piso is not null and v_roas < est.roas_piso then
        d_chave := 'ads:piso:' || v_mkt || ':' || coalesce(r.m ->> 'campanha', '');
        d_agente := 'ads'; d_tom := 'red'; d_valor := (r.m ->> 'perda_7d')::numeric; d_prazo := null; d_nota := null;
        d_o_que := 'ADS de ' || coord_curto(r.m ->> 'nome', 40) || ' abaixo do piso combinado';
        d_detalhe := format('%s · ROAS %s em 7 dias × piso %s · estratégia: %s', r.m ->> 'loja', rel_n1(v_roas), rel_n1(est.roas_piso), est.objetivo);
        d_opcoes := jsonb_build_array(
          jsonb_build_object('letra', 'A', 'titulo', 'Subir o objetivo de ROAS até voltar ao piso', 'texto', 'mantém a estratégia com menos gasto'),
          jsonb_build_object('letra', 'B', 'titulo', 'Baixar o piso da estratégia', 'texto', 'se o custo ainda vale a posição, ajuste o piso em Estratégias'),
          jsonb_build_object('letra', 'C', 'titulo', 'Encerrar a estratégia', 'texto', 'o ADS volta a ser cobrado pelo empate'));
        return next;
      end if;
      continue;
    end if;

    d_chave := 'ads:meta:' || coalesce(v_mkt, '') || ':' || coalesce(r.m ->> 'campanha', '');
    d_agente := 'ads'; d_valor := (r.m ->> 'perda_7d')::numeric; d_prazo := null; d_nota := null;
    d_tom := case when d_valor >= 100 then 'red' else 'amber' end;
    d_o_que := 'Rever o ADS de ' || coord_curto(r.m ->> 'nome', 46);
    d_detalhe := format('%s · objetivo de ROAS %s · ROAS real %s em 7 dias%s · %s de ADS, %s pedidos · perdeu %s', r.m ->> 'loja', rel_n1((r.m ->> 'meta')::numeric), rel_n1(v_roas),
      case when v_eq is not null then ' (empata em ' || rel_n1(v_eq) || ')' else ' (sem margem nem antes do ADS)' end,
      rel_rs((r.m ->> 'gasto_7d')::numeric), r.m ->> 'pedidos_7d', rel_rs(d_valor));

    -- Caminho "subir o preço": quanto o preço teria de subir para o ADS empatar no ROAS de hoje.
    -- margem(P) = (1 − taxas) − custo/P; custo/P de hoje = CMV ÷ receita dos últimos 30 dias (estimativa: taxas e venda constantes).
    v_pct := null; v_pm := null;
    if v_eq is not null and v_roas > 0 then
      v_rec := null; v_cmv := null; v_un := null;
      if v_mkt = 'ml' and d_sku is not null then
        select m.receita, m.cmv, m.unidades into v_rec, v_cmv, v_un from ads_margem_anuncio m where m.marketplace = 'mercadolivre' and m.nivel = 'sku' and m.sku = d_sku limit 1;
      elsif v_mkt = 'shopee' and (r.m ->> 'anuncio') is not null then
        select m.receita, m.cmv, m.unidades into v_rec, v_cmv, v_un from ads_margem_anuncio m
         where m.marketplace = 'shopee' and m.nivel = 'anuncio' and m.anuncio_id::text = r.m ->> 'anuncio' and m.shop_id = v_shop limit 1;
      end if;
      if v_rec > 0 and v_cmv > 0 and v_un > 0 then
        v_k := v_cmv / v_rec; v_delta := 1 / v_roas - 1 / v_eq;
        if v_delta > 0 and v_k > v_delta + 0.05 then
          v_pct := round((v_k / (v_k - v_delta) - 1) * 100, 0); v_pm := v_rec / v_un;
          if v_pct > 40 or v_pct < 1 then v_pct := null; end if;
        end if;
      end if;
    end if;

    d_opcoes := '[]'::jsonb;
    if v_eq is null then
      d_opcoes := d_opcoes || jsonb_build_object('titulo', 'Rever o preço ou o custo do produto', 'texto', 'ele não dá margem nem sem ADS: qualquer gasto de ADS aumenta o prejuízo', 'abrir', 'preco');
    else
      if r.m ->> 'meta_minima' is not null then
        d_opcoes := d_opcoes || jsonb_build_object('titulo', 'Subir o objetivo de ROAS para ' || rel_n1((r.m ->> 'meta_minima')::numeric),
          'texto', 'gasta menos e perde alcance' || case when v_mkt = 'ml' then '; no Mercado Livre a troca é só no painel do Mercado Ads' else '; na Shopee dá para trocar pela tela de ADS do sistema' end, 'abrir', 'ads');
      end if;
      if v_pct is not null then
        d_opcoes := d_opcoes || jsonb_build_object('titulo', format('Subir o preço em cerca de %s%% (de ~%s para ~%s)', v_pct, rel_rs2(v_pm), rel_rs2(v_pm * (1 + v_pct / 100))),
          'texto', 'com esse preço o ADS empata no ROAS de hoje sem mexer no investimento; tende a vender menos. É estimativa', 'abrir', 'preco');
      end if;
    end if;
    d_opcoes := d_opcoes || jsonb_build_object('titulo', 'Pausar a campanha',
      'texto', format('deixa de gastar %s por semana; o ADS trouxe %s pedidos em 7 dias', rel_rs((r.m ->> 'gasto_7d')::numeric), r.m ->> 'pedidos_7d'), 'abrir', 'ads');
    d_opcoes := d_opcoes || jsonb_build_object('titulo', 'Manter de propósito',
      'texto', 'se o ROAS baixo é estratégia (ganhar posição, lançar produto), registre o objetivo: o coordenador para de cobrar e passa a acompanhar', 'acao', 'estrategia');
    select jsonb_agg(o || jsonb_build_object('letra', chr(64 + n::int)) order by n) into d_opcoes from jsonb_array_elements(d_opcoes) with ordinality t(o, n);

    if d_sku is not null then
      select * into cob from coord_cobertura_min(d_sku);
      if cob.ruptura or cob.dias < 7 then
        d_tom := 'red';
        d_nota := case when cob.ruptura or cob.dias <= 0 then 'Produto sem estoque no galpão: o ADS gasta sem ter o que vender. Pausar até repor.'
                       else 'Estoque para só ' || rel_n1(cob.dias) || ' dias: segurar o ADS até repor (não subir orçamento).' end;
      end if;
    end if;
    return next;
  end loop;

  -- ============ ADS (sugestões por anúncio) ============
  for r in
    select s from jsonb_array_elements(coalesce(ads -> 'sugestoes', '[]'::jsonb)) s
     where s ->> 'tipo' in ('pausar', 'reduzir_orcamento', 'revisar_lance')
     order by (s ->> 'prioridade')::int, (s ->> 'impacto_estimado_rs')::numeric desc nulls last limit 4
  loop
    v_mkt := case when (r.s ->> 'marketplace') like 'merc%' then 'ml' else r.s ->> 'marketplace' end;
    d_sku := nullif(r.s ->> 'sku', '');
    continue when exists (select 1 from agente_estrategias e where e.ativo and coalesce(e.mkt, v_mkt) = v_mkt
                         and ((e.sku is not null and e.sku = d_sku) or e.campanha = r.s ->> 'anuncio_id' or e.nome = r.s ->> 'anuncio'));
    v_emp := case when (r.s ->> 'empresa') ~* 'svl|bumi' then 'svl' else 'ottz' end;
    d_chave := 'ads:sug:' || (r.s ->> 'tipo') || ':' || coalesce(r.s ->> 'anuncio_id', '');
    d_agente := 'ads'; d_tom := 'amber'; d_valor := null; d_prazo := null; d_nota := null; d_opcoes := null;
    d_o_que := case r.s ->> 'tipo' when 'pausar' then 'Pausar o ADS de ' when 'reduzir_orcamento' then 'Reduzir o orçamento de ADS de ' else 'Rever o lance do ADS de ' end
               || coord_curto(r.s ->> 'anuncio', 44);
    d_detalhe := r.s ->> 'justificativa';
    d_ref := jsonb_build_object('tipo', 'ads_anuncio', 'mkt', v_mkt, 'anuncio', r.s ->> 'anuncio_id', 'sku', d_sku, 'empresa', v_emp, 'nome', r.s ->> 'anuncio');
    return next;
  end loop;

  -- ============ PESQUISA e TENDÊNCIAS (as decisões já vêm prontas no relatório) ============
  for r in
    select 'pesquisa_ml' ag, d, o from jsonb_array_elements(coalesce(pes -> 'decisoes', '[]'::jsonb)) with ordinality t(d, o) where o <= 2
    union all
    select 'tendencias', d, o from jsonb_array_elements(coalesce(ten -> 'decisoes', '[]'::jsonb)) with ordinality t(d, o) where o <= 6
  loop
    d_agente := r.ag;
    d_chave := coalesce(nullif(r.d ->> 'chave', ''), case r.ag when 'pesquisa_ml' then 'pesq:' else 'tend:' end || md5(coalesce(r.d ->> 'o_que', '')));
    d_tom := case when r.d ->> 'tom' in ('red', 'amber', 'gray') then r.d ->> 'tom' else 'gray' end;
    d_o_que := r.d ->> 'o_que'; d_detalhe := r.d ->> 'detalhe'; d_sku := nullif(r.d ->> 'sku', '');
    d_valor := nullif(r.d ->> 'valor', '')::numeric; d_prazo := nullif(r.d ->> 'prazo', '')::date; d_nota := null;
    d_opcoes := case when jsonb_typeof(r.d -> 'opcoes') = 'array' then r.d -> 'opcoes' end;
    d_ref := case when jsonb_typeof(r.d -> 'ref') = 'object' then r.d -> 'ref' end;
    if d_o_que is not null then return next; end if;
  end loop;

  -- ============ ESTRATÉGIAS: dia de revisar e meta de posição atingida ============
  for est in select * from agente_estrategias where ativo loop
    d_agente := 'ads'; d_sku := est.sku; d_valor := null; d_nota := null; d_ref := est.ref;
    if est.revisar_em is not null and est.revisar_em <= p_dia then
      d_chave := 'estrategia:revisar:' || est.id; d_tom := 'amber'; d_prazo := est.revisar_em;
      d_o_que := 'Revisar a estratégia de ' || coord_curto(est.nome, 44);
      d_detalhe := format('%s · combinada em %s por %s; chegou o dia de revisar', est.objetivo, to_char(est.criado_em at time zone 'America/Sao_Paulo', 'DD/MM'), coalesce(est.criado_por, '—'));
      d_opcoes := jsonb_build_array(
        jsonb_build_object('letra', 'A', 'titulo', 'Manter mais um período', 'texto', 'em Estratégias, mudar a data de revisão'),
        jsonb_build_object('letra', 'B', 'titulo', 'Encerrar a estratégia', 'texto', 'o ADS volta a ser cobrado pelo ROAS de empate'));
      return next;
    end if;
    if est.meta_posicao is not null and est.sku is not null and coalesce(est.mkt, 'ml') = 'ml' then
      select * into pm from coord_posicao_ml(est.sku);
      if pm.posicao is not null and pm.posicao <= est.meta_posicao then
        d_chave := 'estrategia:meta:' || est.id; d_tom := 'amber'; d_prazo := null;
        d_o_que := coord_curto(est.nome, 40) || ' chegou ao top ' || est.meta_posicao;
        d_detalhe := format('%sº em %s no Mercado Livre (coleta de %s) · objetivo: %s', pm.posicao, pm.categoria, to_char(pm.coletado, 'DD/MM'), est.objetivo);
        d_opcoes := jsonb_build_array(
          jsonb_build_object('letra', 'A', 'titulo', 'Reduzir o investimento aos poucos', 'texto', 'subir o objetivo de ROAS em degraus e ver se a posição se mantém'),
          jsonb_build_object('letra', 'B', 'titulo', 'Manter para consolidar', 'texto', 'em Estratégias, marcar nova data de revisão'),
          jsonb_build_object('letra', 'C', 'titulo', 'Encerrar a estratégia', 'texto', 'o ADS volta a ser cobrado pelo ROAS de empate'));
        return next;
      end if;
    end if;
  end loop;
end $fn$;
revoke all on function public.coordenador_candidatas(date), public.coord_estrategias(date), public.coord_posicao_ml(text) from public, anon, authenticated;

-- coordenador_gerar: grava os caminhos e o `ref`, e leva as estratégias para o relatório (troca de trechos conferida).
do $do$
declare s text;
begin
  s := pg_get_functiondef('public.coordenador_gerar(date)'::regprocedure);
  if position('dono, status, primeira_vez, ultima_vez)' in s) = 0 or position($a$'aberta', v_dia, v_dia$a$ in s) = 0
     or position('sku = excluded.sku, valor = excluded.valor, prazo = excluded.prazo,' in s) = 0
     or position($a$'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('tom'$a$ in s) = 0
     or position($a$|| '<p><em>Gerado automaticamente$a$ in s) = 0 then
    raise exception 'coordenador_gerar: trecho esperado não encontrado';
  end if;
  s := replace(s, 'dono, status, primeira_vez, ultima_vez)', 'dono, status, primeira_vez, ultima_vez, opcoes, ref)');
  s := replace(s, $a$'aberta', v_dia, v_dia$a$, $a$'aberta', v_dia, v_dia, c.d_opcoes, c.d_ref$a$);
  s := replace(s, 'sku = excluded.sku, valor = excluded.valor, prazo = excluded.prazo,',
                  'sku = excluded.sku, valor = excluded.valor, prazo = excluded.prazo, opcoes = excluded.opcoes, ref = excluded.ref,');
  s := replace(s, $a$'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('tom'$a$,
                  $a$'estrategias', coord_estrategias(v_dia), 'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('tom'$a$);
  s := replace(s, $a$|| '<p><em>Gerado automaticamente$a$,
    $a$|| '<h3>Estratégias em acompanhamento</h3><table><tr><th>O que</th><th>Objetivo</th><th>Hoje</th><th>Revisar em</th></tr>'
    || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(e ->> 'nome'), rel_esc(e ->> 'objetivo'),
                    rel_esc(coalesce(e ->> 'hoje', '—')), coalesce(to_char((e ->> 'revisar_em')::date, 'DD/MM'), '—')), '')
                   from jsonb_array_elements(coord_estrategias(v_dia)) e), '<tr><td colspan="4">Nenhuma.</td></tr>') || '</table>'
    || '<p><em>Gerado automaticamente$a$);
  execute s;
end $do$;

create or replace function public.coordenador_painel()
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  return jsonb_build_object(
    'dia', v_dia,
    'gerado_em', (select gerado_em from relatorios_agentes where agente = 'coordenador' order by data_referencia desc limit 1),
    'destaque', (select destaque from relatorios_agentes where agente = 'coordenador' order by data_referencia desc limit 1),
    'topo', (select coalesce(jsonb_agg(to_jsonb(x) order by x.posicao), '[]'::jsonb) from (
        select id, chave, agente, tom, o_que, detalhe, nota, sku, valor, prazo, dono, primeira_vez, dias_vista, posicao, reaberta_em, opcoes, ref
          from agente_decisoes where no_topo and status = 'aberta') x),
    'outras', (select coalesce(jsonb_agg(to_jsonb(x) order by x.prioridade desc), '[]'::jsonb) from (
        select id, chave, agente, tom, o_que, detalhe, nota, sku, valor, prazo, dono, primeira_vez, dias_vista, opcoes, ref,
               (case tom when 'red' then 3 when 'amber' then 2 else 1 end) * 1e7 + coalesce(valor, 0) as prioridade
          from agente_decisoes where status = 'aberta' and not no_topo
         order by (case tom when 'red' then 3 when 'amber' then 2 else 1 end) * 1e7 + coalesce(valor, 0) desc limit 40) x),
    'andamento', (select coalesce(jsonb_agg(to_jsonb(x) order by x.prazo_tarefa nulls last), '[]'::jsonb) from (
        select d.id, d.agente, d.tom, d.o_que, d.detalhe, d.nota, d.sku, d.valor, d.responsavel, m.nome responsavel_nome, d.prazo_tarefa, d.decidido_em,
               d.decidido_por, d.tarefa_id, d.sumiu_em, (d.prazo_tarefa < v_dia) atrasada, d.opcao_escolhida, d.ref
          from agente_decisoes d left join equipe_membros m on m.id = d.responsavel where d.status = 'aprovada') x),
    'recentes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.atualizado_em desc), '[]'::jsonb) from (
        select id, agente, o_que, status, motivo, silenciar_ate, concluida_em, concluida_por, obs_conclusao, decidido_por, atualizado_em
          from agente_decisoes where status in ('feita', 'recusada') and atualizado_em > now() - interval '10 days' order by atualizado_em desc limit 15) x),
    'estrategias', coord_estrategias(v_dia),
    'equipe', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome) order by ordem), '[]'::jsonb) from equipe_membros where ativo and id <> 'equipe'));
end $fn$;

drop function public.decisao_aprovar(bigint, text, date, text);
create function public.decisao_aprovar(p_id bigint, p_responsavel text, p_prazo date, p_obs text default null, p_opcao text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare
  d agente_decisoes; m equipe_membros; v_quem text; v_tarefa uuid; v_caminho text;
  v_chave text := 'sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA';
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  select * into d from agente_decisoes where id = p_id for update;
  if not found then raise exception 'decisão não encontrada'; end if;
  if d.status not in ('aberta', 'recusada', 'sumiu') then raise exception 'esta decisão já está %', d.status; end if;
  select * into m from equipe_membros where id = p_responsavel and ativo;
  if not found then raise exception 'responsável inválido'; end if;
  if p_prazo is null then raise exception 'informe o prazo'; end if;
  select nome into v_quem from perfis_usuario where user_id = auth.uid() limit 1;
  select 'Caminho escolhido: ' || (o ->> 'letra') || ' — ' || (o ->> 'titulo') || coalesce(' (' || (o ->> 'texto') || ')', '') into v_caminho
    from jsonb_array_elements(coalesce(d.opcoes, '[]'::jsonb)) o where o ->> 'letra' = p_opcao limit 1;

  if m.id <> 'renan' then
    insert into fulfillment_tarefas (tipo, titulo, descricao, status, responsavel_id, responsavel, prazo, criado_por)
    values ('outro', left(d.o_que, 140),
            concat_ws(E'\n', d.detalhe, 'SKU ' || d.sku, v_caminho, d.nota, nullif(btrim(coalesce(p_obs, '')), ''), 'Origem: decisão aprovada no coordenador (' || d.agente || ').'),
            'a_fazer', m.id, m.nome, p_prazo, coalesce(v_quem, 'Coordenador'))
    returning id into v_tarefa;
    perform net.http_post(
      url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/discord-notify',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_chave, 'apikey', v_chave),
      body := jsonb_build_object('canal', 'fulfilment', 'nivel', 'info', 'titulo', 'Nova tarefa: ' || left(d.o_que, 120),
        'descricao', concat_ws(E'\n', d.detalhe, v_caminho, d.nota, 'Responsável: ' || m.nome || ' · prazo ' || to_char(p_prazo, 'DD/MM')),
        'marcar', case when m.discord_user_id is not null then jsonb_build_array(m.discord_user_id) else '[]'::jsonb end),
      timeout_milliseconds := 20000);
  end if;

  update agente_decisoes set status = 'aprovada', decidido_em = now(), decidido_por = v_quem, responsavel = m.id, prazo_tarefa = p_prazo,
         tarefa_id = v_tarefa, motivo = nullif(btrim(coalesce(p_obs, '')), ''), opcao_escolhida = v_caminho,
         silenciar_ate = null, no_topo = false, posicao = null, atualizado_em = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'tarefa_id', v_tarefa, 'responsavel', m.nome);
end $fn$;

-- "É de propósito": a decisão vira estratégia acompanhada.
create or replace function public.decisao_estrategia(p_id bigint, p_objetivo text, p_roas_piso numeric default null, p_meta_posicao int default null, p_revisar_em date default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare d agente_decisoes; v_quem text; v_id bigint;
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  if nullif(btrim(coalesce(p_objetivo, '')), '') is null then raise exception 'escreva o objetivo'; end if;
  select * into d from agente_decisoes where id = p_id for update;
  if not found then raise exception 'decisão não encontrada'; end if;
  if coalesce(d.ref ->> 'tipo', '') not in ('ads', 'ads_anuncio') then raise exception 'esta decisão não é de ADS'; end if;
  select nome into v_quem from perfis_usuario where user_id = auth.uid() limit 1;
  insert into agente_estrategias (mkt, campanha, sku, nome, objetivo, roas_piso, meta_posicao, revisar_em, decisao_id, ref, criado_por)
  values (d.ref ->> 'mkt', nullif(d.ref ->> 'campanha', ''), coalesce(nullif(d.ref ->> 'sku', ''), d.sku), coalesce(nullif(d.ref ->> 'nome', ''), d.o_que),
          btrim(p_objetivo), p_roas_piso, p_meta_posicao, p_revisar_em, d.id, d.ref, v_quem)
  returning id into v_id;
  update agente_decisoes set status = 'estrategia', decidido_em = now(), decidido_por = v_quem, motivo = btrim(p_objetivo),
         no_topo = false, posicao = null, atualizado_em = now() where id = p_id;
  return jsonb_build_object('ok', true, 'estrategia_id', v_id);
end $fn$;

create or replace function public.estrategia_atualizar(p_id bigint, p_objetivo text, p_roas_piso numeric, p_meta_posicao int, p_revisar_em date)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  update agente_estrategias set objetivo = coalesce(nullif(btrim(coalesce(p_objetivo, '')), ''), objetivo), roas_piso = p_roas_piso,
         meta_posicao = p_meta_posicao, revisar_em = p_revisar_em where id = p_id and ativo;
  if not found then raise exception 'estratégia não encontrada'; end if;
  delete from agente_decisoes where chave in ('estrategia:revisar:' || p_id, 'estrategia:meta:' || p_id) and status in ('aberta', 'sumiu');
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.estrategia_encerrar(p_id bigint, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare v_quem text; v_dec bigint;
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  select nome into v_quem from perfis_usuario where user_id = auth.uid() limit 1;
  update agente_estrategias set ativo = false, encerrada_em = now(), encerrada_por = v_quem, motivo_fim = nullif(btrim(coalesce(p_motivo, '')), '')
   where id = p_id and ativo returning decisao_id into v_dec;
  if not found then raise exception 'estratégia não encontrada'; end if;
  -- a decisão volta a poder aparecer se os relatórios seguirem apontando
  update agente_decisoes set status = 'sumiu', atualizado_em = now() where id = v_dec and status = 'estrategia';
  delete from agente_decisoes where chave in ('estrategia:revisar:' || p_id, 'estrategia:meta:' || p_id) and status in ('aberta', 'sumiu');
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function public.coordenador_painel(), public.decisao_aprovar(bigint, text, date, text, text), public.decisao_estrategia(bigint, text, numeric, int, date),
              public.estrategia_atualizar(bigint, text, numeric, int, date), public.estrategia_encerrar(bigint, text) from public, anon;
grant execute on function public.coordenador_painel(), public.decisao_aprovar(bigint, text, date, text, text), public.decisao_estrategia(bigint, text, numeric, int, date),
              public.estrategia_atualizar(bigint, text, numeric, int, date), public.estrategia_encerrar(bigint, text) to authenticated;
