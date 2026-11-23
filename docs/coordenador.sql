-- Agente COORDENADOR (23/nov/2026, pedido do dono — opção B do plano).
--
-- Todo dia, depois dos relatórios dos outros agentes (financeiro, compras, ADS, pesquisa, tendências), ele:
--   1. tira de cada relatório o que pede decisão, num formato único;
--   2. cruza (ADS × estoque do produto, compra × caixa projetado);
--   3. entrega até 7 decisões por prioridade (no máximo 3 por agente);
--   4. guarda o estado de cada decisão (aberta, aprovada, recusada, feita, sumiu) entre os dias.
-- Aprovar vira tarefa (com responsável e prazo); recusar silencia por 14 dias; tarefa concluída fecha a decisão.
-- Nada é executado em marketplace nem no Tiny: o coordenador só organiza o que os outros apontam.
--
--   agente_decisoes          uma linha por assunto (chave estável), com o estado
--   agente_dono_padrao       quem é o dono sugerido das decisões de cada agente
--   coordenador_candidatas(dia)   o que os relatórios do dia pedem (com as notas do cruzamento)
--   coordenador_gerar(dia)        grava/atualiza as decisões e o relatório do coordenador (cron 08h45)
--   coordenador_painel()          o que a tela mostra (só administrador)
--   decisao_aprovar / decisao_recusar / decisao_concluir / decisao_reabrir
--
-- Rollback:
--   select cron.unschedule('coordenador-gerar');
--   drop trigger trg_coord_tarefa_concluida on public.fulfillment_tarefas; drop function public.coord_tarefa_concluida();
--   drop function public.decisao_aprovar(bigint, text, date, text); drop function public.decisao_recusar(bigint, text);
--   drop function public.decisao_concluir(bigint, text); drop function public.decisao_reabrir(bigint);
--   drop function public.coordenador_painel(); drop function public.coordenador_gerar(date);
--   drop function public.coordenador_candidatas(date); drop function public.coord_cobertura_min(text); drop function public.coord_curto(text, int);
--   drop table public.agente_decisoes; drop table public.agente_dono_padrao;
--   (o gatilho relatorios_agentes_defaults e a view_relatorios_categorias só ganharam linhas; não precisam voltar.)

create table public.agente_dono_padrao (agente text primary key, dono text not null);
insert into public.agente_dono_padrao (agente, dono) values
  ('financeiro', 'renan'), ('ads', 'renan'), ('compras', 'vini'), ('pesquisa_ml', 'renan'), ('tendencias', 'renan'), ('rh', 'renan');

create table public.agente_decisoes (
  id            bigserial primary key,
  chave         text not null unique,       -- assunto estável: 'compras:ruptura:15984', 'ads:meta:ml:357393245'…
  agente        text not null,
  tom           text not null default 'amber' check (tom in ('red', 'amber', 'gray')),
  o_que         text not null,
  detalhe       text,
  nota          text,                        -- o que o cruzamento com os outros agentes acrescentou
  sku           text,
  valor         numeric(14,2),               -- R$ em jogo (por semana, quando é recorrente)
  prazo         date,
  dono          text,                        -- sugestão de responsável (equipe_membros.id)
  status        text not null default 'aberta' check (status in ('aberta', 'aprovada', 'recusada', 'feita', 'sumiu')),
  primeira_vez  date not null,
  ultima_vez    date not null,
  dias_vista    int not null default 1,
  sumiu_em      date,                        -- deixou de aparecer nos relatórios
  no_topo       boolean not null default false,
  posicao       int,
  prioridade    numeric,
  decidido_em   timestamptz,
  decidido_por  text,
  motivo        text,
  silenciar_ate date,
  responsavel   text,
  prazo_tarefa  date,
  tarefa_id     uuid,
  concluida_em  timestamptz,
  concluida_por text,
  obs_conclusao text,
  reaberta_em   timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index agente_decisoes_status on public.agente_decisoes (status);

alter table public.agente_dono_padrao enable row level security;
alter table public.agente_decisoes enable row level security;
create policy agente_dono_padrao_adm on public.agente_dono_padrao for all to authenticated using (public.tem_modulo('todos')) with check (public.tem_modulo('todos'));
create policy agente_decisoes_ler on public.agente_decisoes for select to authenticated using (public.tem_modulo('todos'));
revoke all on public.agente_dono_padrao, public.agente_decisoes from anon, authenticated;
grant select, insert, update, delete on public.agente_dono_padrao to authenticated;
grant select on public.agente_decisoes to authenticated;

create or replace function public.coord_curto(t text, n int) returns text language sql immutable as $$
  select case when length(x) <= n then x else rtrim(left(x, n - 1)) || '…' end
    from (select regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g') x) q $$;

-- Menor cobertura de estoque (dias) entre os produtos físicos de um SKU: ele mesmo, os componentes do kit e as variações.
create or replace function public.coord_cobertura_min(p_sku text, out dias numeric, out ruptura boolean)
language sql stable set search_path = public as $$
  with fis as (
    select p_sku as s
    union select k.sku_componente from produto_kits k where k.sku_kit = p_sku
    union select v.sku from produtos v where v.sku_pai = p_sku
    union select k.sku_componente from produtos v join produto_kits k on k.sku_kit = v.sku where v.sku_pai = p_sku)
  select min(c.cobertura_empresa_dias), coalesce(bool_or(c.status = 'ruptura_empresa'), false)
    from ads_cobertura_sku c join fis on fis.s = c.sku $$;

create or replace function public.coordenador_candidatas(p_dia date)
returns table (d_chave text, d_agente text, d_tom text, d_o_que text, d_detalhe text, d_sku text, d_valor numeric, d_prazo date, d_nota text)
language plpgsql set search_path = public, extensions as $fn$
declare
  fin jsonb; com jsonb; ads jsonb; pes jsonb; ten jsonb; pos jsonb;
  v_neg_dia date; v_neg_saldo numeric; v_neg_saidas numeric;
  v_q int; v_v numeric; v_t text; r record; cob record;
begin
  select r1.resumo into fin from relatorios_agentes r1 where r1.agente = 'financeiro' and r1.data_referencia = p_dia;
  select r1.resumo into com from relatorios_agentes r1 where r1.agente = 'compras' and r1.data_referencia = p_dia;
  select r1.resumo into ads from relatorios_agentes r1 where r1.agente = 'ads' and r1.data_referencia = p_dia;
  select r1.resumo into pes from relatorios_agentes r1 where r1.agente = 'pesquisa_ml' and r1.data_referencia = p_dia;
  select r1.resumo into ten from relatorios_agentes r1 where r1.agente = 'tendencias' and r1.data_referencia = p_dia;

  -- Caixa projetado dos próximos 7 dias (a mesma conta da tela Fluxo de Caixa)
  begin
    pos := dashboard_posicao_empresa();
    select (d ->> 'dia')::date, (d ->> 'saldo')::numeric, (d ->> 'saidas')::numeric into v_neg_dia, v_neg_saldo, v_neg_saidas
      from jsonb_array_elements(coalesce(pos #> '{fluxo,dias}', '[]'::jsonb)) d
     where (d ->> 'saldo')::numeric < 0 and (d ->> 'dia')::date <= p_dia + 7
     order by (d ->> 'dia')::date limit 1;
  exception when others then v_neg_dia := null; end;

  -- ============ FINANCEIRO ============
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
      d_sku := null; d_valor := v_v; d_prazo := p_dia; d_nota := null; return next;
    end if;
    v_q := coalesce((fin #>> '{contas_pagar_resumo,hoje,qtd}')::int, 0);
    v_v := coalesce((fin #>> '{contas_pagar_resumo,hoje,valor}')::numeric, 0);
    if v_q > 0 then
      d_chave := 'fin:vence_hoje'; d_agente := 'financeiro'; d_tom := 'amber';
      d_o_que := format('Pagar %s conta%s que vence%s hoje', v_q, case when v_q = 1 then '' else 's' end, case when v_q = 1 then '' else 'm' end);
      d_detalhe := rel_rs(v_v); d_sku := null; d_valor := v_v; d_prazo := p_dia; d_nota := null; return next;
    end if;
    for r in select d from jsonb_array_elements(coalesce(fin #> '{conciliacao,decisoes}', '[]'::jsonb)) d loop
      d_chave := coalesce(r.d ->> 'chave', 'fin:conc:' || md5(coalesce(r.d ->> 'o_que', ''))); d_agente := 'financeiro';
      d_tom := case when r.d ->> 'tom' in ('red', 'amber', 'gray') then r.d ->> 'tom' else 'amber' end;
      d_o_que := r.d ->> 'o_que'; d_detalhe := r.d ->> 'detalhe'; d_sku := nullif(r.d ->> 'sku', '');
      d_valor := nullif(r.d ->> 'valor', '')::numeric; d_prazo := nullif(r.d ->> 'prazo', '')::date; d_nota := null;
      if d_o_que is not null then return next; end if;
    end loop;
  end if;
  if v_neg_dia is not null then
    d_chave := 'fin:caixa_negativo'; d_agente := 'financeiro'; d_tom := 'red';
    d_o_que := 'Cobrir o caixa de ' || to_char(v_neg_dia, 'DD/MM');
    d_detalhe := format('saldo projetado de −%s nesse dia (saídas de %s)', rel_rs(abs(v_neg_saldo)), rel_rs(v_neg_saidas));
    d_sku := null; d_valor := abs(v_neg_saldo); d_prazo := v_neg_dia; d_nota := null; return next;
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
    d_agente := 'compras'; d_sku := r.sku; d_prazo := null;
    d_valor := case when r.preco is not null then round(r.vd * r.preco * 7, 2) end;
    if r.st = 'ruptura_empresa' then
      d_chave := 'compras:ruptura:' || r.sku;
      d_tom := case when r.oc > 0 then 'amber' else 'red' end;
      d_o_que := case when r.oc > 0 then 'Acompanhar a entrega de ' else 'Comprar ' end || coord_curto(r.produto, 48);
      d_detalhe := format('sem estoque no galpão; vende %s por dia%s; %s', rel_n1(r.vd),
        case when r.preco is not null then ' (' || rel_rs(r.vd * r.preco) || ' por dia)' else '' end,
        case when r.oc > 0 then round(r.oc)::text || ' unidades em ordem de compra' else 'sem ordem de compra aberta' end);
    else
      d_chave := 'compras:urgente:' || r.sku; d_tom := 'amber';
      d_o_que := 'Comprar ' || coord_curto(r.produto, 48);
      d_detalhe := format('estoque para %s dias e o fornecedor leva %s; vende %s por dia', rel_n1(greatest(r.cobertura, 0)), coalesce(round(r.lead)::text, '15'), rel_n1(r.vd));
    end if;
    d_nota := case when v_neg_dia is not null and r.oc = 0
      then 'Caixa projetado negativo em ' || to_char(v_neg_dia, 'DD/MM') || ': negociar prazo com o fornecedor ou comprar o mínimo.' end;
    return next;
  end loop;

  -- ============ ADS ============
  for r in
    select m from jsonb_array_elements(coalesce(ads #> '{metas,itens}', '[]'::jsonb)) m
     where m ->> 'tom' = 'ruim' and coalesce((m ->> 'perda_7d')::numeric, 0) >= 30
     order by (m ->> 'perda_7d')::numeric desc limit 4
  loop
    d_chave := 'ads:meta:' || coalesce(r.m ->> 'mkt', '') || ':' || coalesce(r.m ->> 'campanha', '');
    d_agente := 'ads'; d_sku := nullif(r.m ->> 'sku', ''); d_valor := (r.m ->> 'perda_7d')::numeric; d_prazo := null; d_nota := null;
    d_tom := case when d_valor >= 100 then 'red' else 'amber' end;
    d_o_que := 'Rever o ADS de ' || coord_curto(r.m ->> 'nome', 46);
    d_detalhe := format('%s · meta %s · ROAS %s em 7 dias%s · perdeu %s — %s', r.m ->> 'loja', rel_n1((r.m ->> 'meta')::numeric), rel_n1((r.m ->> 'roas_7d')::numeric),
      case when r.m ->> 'roas_equilibrio' is not null then ' (empate em ' || rel_n1((r.m ->> 'roas_equilibrio')::numeric) || ')' else '' end,
      rel_rs(d_valor), coalesce(r.m ->> 'sugestao', 'rever'));
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
  for r in
    select s from jsonb_array_elements(coalesce(ads -> 'sugestoes', '[]'::jsonb)) s
     where s ->> 'tipo' in ('pausar', 'reduzir_orcamento', 'revisar_lance')
     order by (s ->> 'prioridade')::int, (s ->> 'impacto_estimado_rs')::numeric desc nulls last limit 2
  loop
    d_chave := 'ads:sug:' || (r.s ->> 'tipo') || ':' || coalesce(r.s ->> 'anuncio_id', '');
    d_agente := 'ads'; d_tom := 'amber'; d_sku := nullif(r.s ->> 'sku', ''); d_valor := null; d_prazo := null; d_nota := null;
    d_o_que := case r.s ->> 'tipo' when 'pausar' then 'Pausar o ADS de ' when 'reduzir_orcamento' then 'Reduzir o orçamento de ADS de ' else 'Rever o lance do ADS de ' end
               || coord_curto(r.s ->> 'anuncio', 44);
    d_detalhe := r.s ->> 'justificativa';
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
    if d_o_que is not null then return next; end if;
  end loop;
end $fn$;

create or replace function public.coordenador_gerar(p_dia date default null)
returns jsonb language plpgsql set search_path = public, extensions as $fn$
declare
  v_dia date := coalesce(p_dia, (now() at time zone 'America/Sao_Paulo')::date);
  v_chave text := 'sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA';
  v_topo int; v_red int; v_novas int; v_abertas int; v_and int; v_atras int; v_sumiu int;
  v_destaque text; v_html text; v_resumo jsonb; p record; v_cobranca text; v_marcar jsonb;
begin
  create temp table _cand on commit drop as
    select distinct on (d_chave) * from coordenador_candidatas(v_dia) where d_chave is not null and d_o_que is not null
     order by d_chave, d_valor desc nulls last;

  select count(*) into v_novas from _cand c where not exists (select 1 from agente_decisoes a where a.chave = c.d_chave);

  insert into agente_decisoes (chave, agente, tom, o_que, detalhe, nota, sku, valor, prazo, dono, status, primeira_vez, ultima_vez)
  select c.d_chave, c.d_agente, c.d_tom, c.d_o_que, c.d_detalhe, c.d_nota, c.d_sku, c.d_valor, c.d_prazo, coalesce(dp.dono, 'renan'), 'aberta', v_dia, v_dia
    from _cand c left join agente_dono_padrao dp on dp.agente = c.d_agente
  on conflict (chave) do update set
    agente = excluded.agente, tom = excluded.tom, o_que = excluded.o_que, detalhe = excluded.detalhe, nota = excluded.nota,
    sku = excluded.sku, valor = excluded.valor, prazo = excluded.prazo,
    dias_vista = agente_decisoes.dias_vista + case when agente_decisoes.ultima_vez < excluded.ultima_vez then 1 else 0 end,
    ultima_vez = excluded.ultima_vez, sumiu_em = null,
    status = case
      when agente_decisoes.status = 'sumiu' then 'aberta'
      when agente_decisoes.status = 'recusada' and coalesce(agente_decisoes.silenciar_ate, excluded.ultima_vez) < excluded.ultima_vez then 'aberta'
      when agente_decisoes.status = 'feita' and agente_decisoes.concluida_em < now() - interval '2 days' then 'aberta'
      else agente_decisoes.status end,
    reaberta_em = case when agente_decisoes.status = 'feita' and agente_decisoes.concluida_em < now() - interval '2 days' then now() else agente_decisoes.reaberta_em end,
    atualizado_em = now();

  update agente_decisoes d set status = 'sumiu', sumiu_em = v_dia, no_topo = false, posicao = null, atualizado_em = now()
   where d.status = 'aberta' and not exists (select 1 from _cand c where c.d_chave = d.chave);
  get diagnostics v_sumiu = row_count;
  update agente_decisoes d set sumiu_em = coalesce(d.sumiu_em, v_dia)
   where d.status = 'aprovada' and not exists (select 1 from _cand c where c.d_chave = d.chave);

  update agente_decisoes set no_topo = false, posicao = null where no_topo;
  with pri as (
    select id, agente, (case tom when 'red' then 3 when 'amber' then 2 else 1 end) * 1e7 + coalesce(valor, 0) pr
      from agente_decisoes where status = 'aberta' and ultima_vez = v_dia),
  por_ag as (select id, pr, row_number() over (partition by agente order by pr desc, id) rn from pri),
  top as (select id, pr, row_number() over (order by pr desc, id) pos from por_ag where rn <= 3 order by pr desc, id limit 7)
  update agente_decisoes d set no_topo = true, posicao = top.pos, prioridade = top.pr from top where top.id = d.id;

  select count(*), count(*) filter (where tom = 'red') into v_topo, v_red from agente_decisoes where no_topo;
  select count(*) into v_abertas from agente_decisoes where status = 'aberta';
  select count(*), count(*) filter (where prazo_tarefa < v_dia) into v_and, v_atras from agente_decisoes where status = 'aprovada';

  select * into p from agente_decisoes where no_topo order by posicao limit 1;
  v_destaque := case when v_topo = 0 then 'Nenhuma decisão nova hoje.'
    else format('%s decis%s para hoje%s. Primeira: %s (%s).', v_topo, case when v_topo = 1 then 'ão' else 'ões' end,
           case when v_red > 0 then format(', %s urgente%s', v_red, case when v_red = 1 then '' else 's' end) else '' end,
           p.o_que, coord_curto(p.detalhe, 90)) end
    || case when v_atras > 0 then format(' %s tarefa%s aprovada%s está%s atrasada%s.', v_atras, case when v_atras = 1 then '' else 's' end,
           case when v_atras = 1 then '' else 's' end, case when v_atras = 1 then '' else 'o' end, case when v_atras = 1 then '' else 's' end) else '' end
    || case when v_and - v_atras > 0 then format(' %s em andamento.', v_and - v_atras) else '' end;

  v_resumo := jsonb_build_object('versao', 'v1', 'origem', 'automatico',
    'contagem', jsonb_build_object('topo', v_topo, 'urgentes', v_red, 'abertas', v_abertas, 'novas', v_novas, 'andamento', v_and, 'atrasadas', v_atras, 'sumiram', v_sumiu),
    'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('tom', tom, 'o_que', o_que || ':', 'detalhe', detalhe, 'sku', sku, 'rotulo', agente) order by posicao), '[]'::jsonb)
                   from agente_decisoes where no_topo));

  v_html := '<h3>Decisões do dia</h3><p>' || rel_esc(v_destaque) || '</p>'
    || '<table><tr><th>#</th><th>O que fazer</th><th>Detalhe</th><th>Cruzamento</th><th>De quem veio</th><th>Em jogo</th></tr>'
    || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', posicao, rel_esc(o_que), rel_esc(detalhe),
                    rel_esc(coalesce(nota, '')), rel_esc(agente), case when valor is not null then rel_rs2(valor) else '—' end), '' order by posicao)
                   from agente_decisoes where no_topo), '<tr><td colspan="6">Nada pede decisão hoje.</td></tr>') || '</table>'
    || '<h3>Aprovadas em andamento</h3><table><tr><th>O que</th><th>Responsável</th><th>Prazo</th><th>Situação</th></tr>'
    || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(o_que), rel_esc(coalesce(responsavel, '')),
                    coalesce(to_char(prazo_tarefa, 'DD/MM'), '—'),
                    case when prazo_tarefa < v_dia then 'atrasada' when sumiu_em is not null then 'não aparece mais nos relatórios desde ' || to_char(sumiu_em, 'DD/MM') else 'no prazo' end), '' order by prazo_tarefa)
                   from agente_decisoes where status = 'aprovada'), '<tr><td colspan="4">Nenhuma.</td></tr>') || '</table>'
    || '<p><em>Gerado automaticamente a partir dos relatórios do dia. Nada é executado: aprovar vira tarefa.</em></p>';

  insert into relatorios_agentes (agente, data_referencia, destaque, resumo, corpo_html, corpo_texto)
  values ('coordenador', v_dia, v_destaque, v_resumo, v_html, v_destaque)
  on conflict (agente, data_referencia) do update
    set destaque = excluded.destaque, resumo = excluded.resumo, corpo_html = excluded.corpo_html, corpo_texto = excluded.corpo_texto, gerado_em = now();

  -- Cobrança: tarefas aprovadas e atrasadas de quem não é o dono (uma mensagem por dia, só quando roda pelo cron do dia)
  if p_dia is null then
    select string_agg(format('• %s — %s, prazo %s', d.o_que, m.nome, to_char(d.prazo_tarefa, 'DD/MM')), E'\n' order by d.prazo_tarefa),
           jsonb_agg(distinct m.discord_user_id) filter (where m.discord_user_id is not null)
      into v_cobranca, v_marcar
      from agente_decisoes d join equipe_membros m on m.id = d.responsavel
     where d.status = 'aprovada' and d.prazo_tarefa < v_dia and d.responsavel <> 'renan';
    if v_cobranca is not null then
      perform net.http_post(
        url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/discord-notify',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_chave, 'apikey', v_chave),
        body := jsonb_build_object('canal', 'fulfilment', 'nivel', 'aviso', 'titulo', 'Tarefas atrasadas', 'descricao', v_cobranca, 'marcar', coalesce(v_marcar, '[]'::jsonb)),
        timeout_milliseconds := 20000);
    end if;
  end if;

  return jsonb_build_object('dia', v_dia, 'destaque', v_destaque, 'contagem', v_resumo -> 'contagem');
end $fn$;

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
        select id, chave, agente, tom, o_que, detalhe, nota, sku, valor, prazo, dono, primeira_vez, dias_vista, posicao, reaberta_em
          from agente_decisoes where no_topo and status = 'aberta') x),
    'outras', (select coalesce(jsonb_agg(to_jsonb(x) order by x.prioridade desc), '[]'::jsonb) from (
        select id, chave, agente, tom, o_que, detalhe, nota, sku, valor, prazo, dono, primeira_vez, dias_vista,
               (case tom when 'red' then 3 when 'amber' then 2 else 1 end) * 1e7 + coalesce(valor, 0) prioridade
          from agente_decisoes where status = 'aberta' and not no_topo order by 14 desc limit 40) x),
    'andamento', (select coalesce(jsonb_agg(to_jsonb(x) order by x.prazo_tarefa nulls last), '[]'::jsonb) from (
        select d.id, d.agente, d.tom, d.o_que, d.detalhe, d.nota, d.sku, d.valor, d.responsavel, m.nome responsavel_nome, d.prazo_tarefa, d.decidido_em,
               d.decidido_por, d.tarefa_id, d.sumiu_em, (d.prazo_tarefa < v_dia) atrasada
          from agente_decisoes d left join equipe_membros m on m.id = d.responsavel where d.status = 'aprovada') x),
    'recentes', (select coalesce(jsonb_agg(to_jsonb(x) order by x.atualizado_em desc), '[]'::jsonb) from (
        select id, agente, o_que, status, motivo, silenciar_ate, concluida_em, concluida_por, obs_conclusao, decidido_por, atualizado_em
          from agente_decisoes where status in ('feita', 'recusada') and atualizado_em > now() - interval '10 days' order by atualizado_em desc limit 15) x),
    'equipe', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome) order by ordem), '[]'::jsonb) from equipe_membros where ativo and id <> 'equipe'));
end $fn$;

create or replace function public.decisao_aprovar(p_id bigint, p_responsavel text, p_prazo date, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare
  d agente_decisoes; m equipe_membros; v_quem text; v_tarefa uuid;
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

  -- O dono acompanha as dele no próprio painel; as da equipe viram tarefa no quadro (Fulfillment › Tarefas) com aviso no Discord.
  if m.id <> 'renan' then
    insert into fulfillment_tarefas (tipo, titulo, descricao, status, responsavel_id, responsavel, prazo, criado_por)
    values ('outro', left(d.o_que, 140),
            concat_ws(E'\n', d.detalhe, d.nota, nullif(btrim(coalesce(p_obs, '')), ''), 'Origem: decisão aprovada no coordenador (' || d.agente || ').'),
            'a_fazer', m.id, m.nome, p_prazo, coalesce(v_quem, 'Coordenador'))
    returning id into v_tarefa;
    perform net.http_post(
      url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/discord-notify',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_chave, 'apikey', v_chave),
      body := jsonb_build_object('canal', 'fulfilment', 'nivel', 'info', 'titulo', 'Nova tarefa: ' || left(d.o_que, 120),
        'descricao', concat_ws(E'\n', d.detalhe, d.nota, 'Responsável: ' || m.nome || ' · prazo ' || to_char(p_prazo, 'DD/MM')),
        'marcar', case when m.discord_user_id is not null then jsonb_build_array(m.discord_user_id) else '[]'::jsonb end),
      timeout_milliseconds := 20000);
  end if;

  update agente_decisoes set status = 'aprovada', decidido_em = now(), decidido_por = v_quem, responsavel = m.id, prazo_tarefa = p_prazo,
         tarefa_id = v_tarefa, motivo = nullif(btrim(coalesce(p_obs, '')), ''), silenciar_ate = null, no_topo = false, posicao = null, atualizado_em = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'tarefa_id', v_tarefa, 'responsavel', m.nome);
end $fn$;

create or replace function public.decisao_recusar(p_id bigint, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare v_quem text; v_dia date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  select nome into v_quem from perfis_usuario where user_id = auth.uid() limit 1;
  update agente_decisoes set status = 'recusada', decidido_em = now(), decidido_por = v_quem, motivo = nullif(btrim(coalesce(p_motivo, '')), ''),
         silenciar_ate = v_dia + 14, no_topo = false, posicao = null, atualizado_em = now()
   where id = p_id and status in ('aberta', 'sumiu');
  if not found then raise exception 'decisão não encontrada ou já decidida'; end if;
  return jsonb_build_object('ok', true, 'silenciada_ate', v_dia + 14);
end $fn$;

create or replace function public.decisao_concluir(p_id bigint, p_obs text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
declare v_quem text;
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  select nome into v_quem from perfis_usuario where user_id = auth.uid() limit 1;
  update agente_decisoes set status = 'feita', concluida_em = now(), concluida_por = v_quem, obs_conclusao = nullif(btrim(coalesce(p_obs, '')), ''),
         no_topo = false, posicao = null, atualizado_em = now()
   where id = p_id and status in ('aprovada', 'aberta');
  if not found then raise exception 'decisão não encontrada ou já fechada'; end if;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.decisao_reabrir(p_id bigint)
returns jsonb language plpgsql security definer set search_path = public, extensions as $fn$
begin
  if not tem_modulo('todos') then raise exception 'sem permissão'; end if;
  update agente_decisoes set status = 'aberta', silenciar_ate = null, reaberta_em = now(), atualizado_em = now()
   where id = p_id and status in ('recusada', 'feita', 'aprovada');
  if not found then raise exception 'decisão não encontrada'; end if;
  return jsonb_build_object('ok', true);
end $fn$;

-- Tarefa concluída no quadro fecha a decisão que a criou.
create or replace function public.coord_tarefa_concluida() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'feito' and old.status is distinct from 'feito' then
    update agente_decisoes set status = 'feita', concluida_em = now(), concluida_por = coalesce(new.concluido_por, new.responsavel),
           no_topo = false, atualizado_em = now()
     where tarefa_id = new.id and status = 'aprovada';
  end if;
  return new;
end $fn$;
create trigger trg_coord_tarefa_concluida after update of status on public.fulfillment_tarefas
  for each row execute function public.coord_tarefa_concluida();

revoke all on function public.coordenador_candidatas(date), public.coordenador_gerar(date), public.coord_cobertura_min(text), public.coord_tarefa_concluida() from public, anon, authenticated;
revoke all on function public.coordenador_painel(), public.decisao_aprovar(bigint, text, date, text), public.decisao_recusar(bigint, text),
              public.decisao_concluir(bigint, text), public.decisao_reabrir(bigint) from public, anon;
grant execute on function public.coordenador_painel(), public.decisao_aprovar(bigint, text, date, text), public.decisao_recusar(bigint, text),
              public.decisao_concluir(bigint, text), public.decisao_reabrir(bigint) to authenticated;

-- Nome e categoria dos dois agentes novos nos relatórios
create or replace function public.relatorios_agentes_defaults() returns trigger language plpgsql as $function$
begin
  if new.categoria is null then
    new.categoria := case new.agente
      when 'financeiro' then 'Financeiro'
      when 'compras' then 'Compras e Recebimentos'
      when 'recebimentos' then 'Compras e Recebimentos'
      when 'marketing' then 'Marketing e ADS'
      when 'ads' then 'Marketing e ADS'
      when 'pesquisa_ml' then 'Pesquisa de produtos'
      when 'rh' then 'RH e Equipe'
      when 'tendencias' then 'Tendências e mudanças'
      when 'coordenador' then 'Coordenação'
      else 'Outros' end;
  end if;
  if new.titulo is null then
    new.titulo := case new.agente
      when 'financeiro' then 'Posição financeira'
      when 'compras' then 'Cobertura de estoque por fornecedor'
      when 'ads' then 'Desempenho de ADS'
      when 'pesquisa_ml' then 'Pesquisa de produtos ML'
      when 'rh' then 'Fechamento semanal da equipe'
      when 'tendencias' then 'Tendências e mudanças'
      when 'coordenador' then 'Decisões do dia'
      else initcap(new.agente) end
      || ' · ' || to_char(new.data_referencia, 'DD/MM/YYYY');
  end if;
  return new;
end $function$;

create or replace view public.view_relatorios_categorias as
 select c.ordem, c.categoria, count(r.id) as total_relatorios, max(r.data_referencia) as ultimo_relatorio
   from (values (1, 'Financeiro'::text), (2, 'Compras e Recebimentos'::text), (3, 'Marketing e ADS'::text), (4, 'Pesquisa de produtos'::text),
                (5, 'Tendências e mudanças'::text)) c(ordem, categoria)
   left join public.relatorios_agentes r on r.categoria = c.categoria
  group by c.ordem, c.categoria;

select cron.schedule('coordenador-gerar', '45 11 * * *', $$select public.coordenador_gerar()$$);
