-- Relatórios diários gerados pelo BANCO, sem depender de alguém pedir ao Claude (23/nov/2026, pedido do dono).
--
-- Antes: financeiro, compras e ADS só gravavam em relatorios_agentes quando alguém rodava a skill no Claude
-- (financeiro e compras parados desde 13/11, ADS desde 27/10). Agora o pg_cron chama relatorio_auto_gerar(agente)
-- toda manhã: os números vêm das MESMAS funções de sempre e a frase de destaque é montada por regra fixa.
--
--   financeiro -> financeiro_relatorio_diario() - 'fluxo_30d'
--   compras    -> compras_relatorio_diario()   (o formato que o cartão do app lê: resumo, por_fornecedor, atencao…
--                 — a skill antiga gravava relatorio_compras_json(), que o cartão não entende)
--   ads        -> ads_relatorio_diario()
--
-- O relatório automático leva resumo.origem = 'automatico'. Se alguém rodar a skill no mesmo dia, o relatório
-- escrito pela IA substitui o automático; o automático NUNCA passa por cima de um relatório escrito pela IA.
--
-- Rollback:
--   select cron.unschedule('relatorio-auto-ads'); select cron.unschedule('relatorio-auto-compras');
--   select cron.unschedule('relatorio-auto-financeiro'); select cron.unschedule('relatorio-auto-vigiar');
--   drop function public.relatorios_auto_vigiar(); drop function public.relatorio_auto_gerar(text);
--   drop function public.rel_rs(numeric); drop function public.rel_rs2(numeric); drop function public.rel_n1(numeric);
--   drop function public.rel_esc(text);

create or replace function public.rel_rs(v numeric) returns text language sql immutable as $$
  select case when v is null then '—'
    when abs(v) >= 1000 then 'R$ ' || replace(to_char(round(v / 1000.0, 1), 'FM999999990.0'), '.', ',') || ' mil'
    else 'R$ ' || to_char(round(v), 'FM999999990') end $$;

create or replace function public.rel_rs2(v numeric) returns text language sql immutable as $$
  select case when v is null then '—'
    else 'R$ ' || replace(replace(replace(to_char(v, 'FM999,999,990.00'), ',', '#'), '.', ','), '#', '.') end $$;

create or replace function public.rel_n1(v numeric) returns text language sql immutable as $$
  select case when v is null then '—' else replace(to_char(round(v, 1), 'FM999999990.0'), '.', ',') end $$;

create or replace function public.rel_esc(t text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;

create or replace function public.relatorio_auto_gerar(p_agente text)
returns jsonb language plpgsql set search_path = public, extensions as $fn$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  j jsonb; k jsonb; v_resumo jsonb; v_destaque text; v_html text; v_n int;
  v_a numeric; v_b numeric; v_c numeric; v_d numeric; v_e numeric; v_txt text;
  v_nota text := '<p><em>Relatório gerado automaticamente pelo sistema, com os números do banco. Os detalhes estão no cartão do relatório.</em></p>';
begin
  if p_agente = 'financeiro' then
    j := financeiro_relatorio_diario();
    v_a := (j #>> '{fluxo_resumo,saidas_7d}')::numeric;
    v_b := coalesce((j #>> '{contas_pagar_resumo,atrasado,valor}')::numeric, 0);
    v_c := (j #>> '{fluxo_resumo,entradas_ml_7d}')::numeric;
    v_d := (j #>> '{carteira_total,saldo_em_conta}')::numeric;
    select sum((c ->> 'a_receber')::numeric) into v_e
      from jsonb_array_elements(coalesce(j -> 'carteira', '[]'::jsonb)) c where c ->> 'marketplace' = 'shopee';
    v_destaque := format('Vencem %s em 7 dias%s e o Mercado Livre libera %s no período. Em conta nas carteiras: %s; a receber da Shopee: %s (estimativa).',
      rel_rs(v_a), case when v_b > 0 then format(' (%s já atrasados)', rel_rs(v_b)) else '' end, rel_rs(v_c), rel_rs(v_d), rel_rs(v_e));
    v_html := '<h3>Leitura do dia</h3><p>' || rel_esc(v_destaque) || '</p>'
      || '<h3>Caixa</h3><table><tr><th>Carteira</th><th>Em conta</th><th>A receber</th><th>Natureza</th></tr>'
      || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(c ->> 'carteira'),
            case when c ->> 'marketplace' = 'mercadolivre' then 'não informado pela API' else rel_rs2((c ->> 'saldo_em_conta')::numeric) end,
            rel_rs2((c ->> 'a_receber')::numeric), rel_esc(c ->> 'natureza')), '')
          from jsonb_array_elements(coalesce(j -> 'carteira', '[]'::jsonb)) c), '') || '</table>'
      || '<h3>Contas a pagar em aberto</h3><table><tr><th>Faixa</th><th>Contas</th><th>Valor</th></tr>'
      || (select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td></tr>', f.rotulo,
            coalesce(j #>> array['contas_pagar_resumo', f.chave, 'qtd'], '0'), rel_rs2((j #>> array['contas_pagar_resumo', f.chave, 'valor'])::numeric)), '' order by f.ord)
          from (values (1, 'atrasado', 'Atrasadas'), (2, 'hoje', 'Vencem hoje'), (3, 'ate_7d', 'Até 7 dias'), (4, 'ate_15d', 'De 8 a 15 dias'),
                       (5, 'ate_30d', 'De 16 a 30 dias'), (6, 'futuro', 'Depois de 30 dias'), (7, 'total_aberto', 'Total em aberto')) f(ord, chave, rotulo)) || '</table>'
      || '<h3>Precisa pagar (atrasadas, hoje e até 7 dias)</h3><table><tr><th>Fornecedor</th><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Dias</th></tr>'
      || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(u ->> 'fornecedor'), rel_esc(left(u ->> 'descricao', 90)),
            rel_rs2((u ->> 'valor')::numeric), to_char((u ->> 'vencimento')::date, 'DD/MM/YYYY'), u ->> 'dias'), '' order by o)
          from jsonb_array_elements(coalesce(j -> 'contas_pagar_urgentes', '[]'::jsonb)) with ordinality t(u, o)), '') || '</table>' || v_nota;
    v_resumo := (j - 'fluxo_30d') || jsonb_build_object('origem', 'automatico');

  elsif p_agente = 'compras' then
    j := compras_relatorio_diario();
    k := j -> 'resumo';
    select string_agg(format('%s (%s)', nome, n), ', ' order by n desc, nome) into v_txt from (
      select initcap(array_to_string((regexp_split_to_array(btrim(f ->> 'fornecedor'), '\s+'))[1:2], ' ')) nome,
             coalesce((f ->> 'ruptura')::int, 0) + coalesce((f ->> 'urgente')::int, 0) n
        from jsonb_array_elements(coalesce(j -> 'por_fornecedor', '[]'::jsonb)) f
       order by 2 desc limit 3) q where n > 0;
    v_destaque := format('%s SKUs em ruptura e %s urgentes.%s %s parados em excesso ou sem giro (%s%% do estoque).',
      coalesce(k ->> 'ruptura', '0'), coalesce(k ->> 'urgente', '0'),
      case when v_txt is not null then ' Onde mais falta: ' || v_txt || '.' else '' end,
      rel_rs((k ->> 'valor_parado')::numeric), rel_n1((k ->> 'valor_parado_pct')::numeric));
    v_html := '<h3>Leitura do dia</h3><p>' || rel_esc(v_destaque) || '</p>'
      || '<table><tr><th>Indicador</th><th>Valor</th></tr>'
      || format('<tr><td>Ruptura na empresa</td><td>%s</td></tr><tr><td>Urgentes (cobertura menor que o prazo)</td><td>%s</td></tr><tr><td>Atenção</td><td>%s</td></tr><tr><td>Excesso / sem giro</td><td>%s / %s</td></tr><tr><td>Estoque a custo</td><td>%s</td></tr><tr><td>Parado (excesso + sem giro)</td><td>%s</td></tr>',
           k ->> 'ruptura', k ->> 'urgente', k ->> 'atencao', k ->> 'excesso', k ->> 'sem_giro',
           rel_rs2((k ->> 'valor_estoque_total')::numeric), rel_rs2((k ->> 'valor_parado')::numeric)) || '</table>'
      || '<h3>Por fornecedor</h3><table><tr><th>Fornecedor</th><th>SKUs</th><th>Ruptura</th><th>Urgente</th><th>Atenção</th><th>Parado</th></tr>'
      || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(f ->> 'fornecedor'), f ->> 'skus',
            f ->> 'ruptura', f ->> 'urgente', f ->> 'atencao', rel_rs2((f ->> 'valor_parado')::numeric)), '' order by o)
          from jsonb_array_elements(coalesce(j -> 'por_fornecedor', '[]'::jsonb)) with ordinality t(f, o) where o <= 15), '') || '</table>' || v_nota;
    v_resumo := j || jsonb_build_object('origem', 'automatico');

  elsif p_agente = 'ads' then
    j := ads_relatorio_diario();
    k := j #> '{metas,resumo}';
    select sum((l ->> 'gasto_7d')::numeric), sum((l ->> 'vendas_7d')::numeric),
           string_agg(format('%s %s', case when l ->> 'marketplace' = 'shopee' then case when l ->> 'empresa' ilike 'SVL%' then 'Shopee Bumi' else 'Shopee Ottz' end
                                           else 'Mercado Livre' || case when l ->> 'empresa' ilike 'SVL%' then ' SVL' else '' end end,
                             rel_n1((l ->> 'roas_7d')::numeric)), '; ' order by o)
      into v_a, v_b, v_txt
      from jsonb_array_elements(coalesce(j -> 'resumo_lojas', '[]'::jsonb)) with ordinality t(l, o);
    v_destaque := format('ADS em 7 dias: %s investidos e %s em vendas (ROAS %s). Por loja: %s. %s campanhas no prejuízo (%s perdidos) e %s com meta abaixo do empate.',
      rel_rs(v_a), rel_rs(v_b), rel_n1(v_b / nullif(v_a, 0)), coalesce(v_txt, '—'),
      coalesce(k ->> 'prejuizo_7d', '0'), rel_rs((k ->> 'perda_7d_total')::numeric), coalesce(k ->> 'meta_abaixo_equilibrio', '0'));
    v_html := '<h3>Leitura do dia (dados até ' || to_char((j ->> 'data_referencia')::date, 'DD/MM') || ')</h3><p>' || rel_esc(v_destaque) || '</p>'
      || '<table><tr><th>Loja</th><th>Gasto 7d</th><th>Vendas 7d</th><th>Vendas vs 7d ant.</th><th>ROAS</th><th>ACOS</th></tr>'
      || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s%%</td><td>%s</td><td>%s%%</td></tr>',
            case when l ->> 'marketplace' = 'shopee' then case when l ->> 'empresa' ilike 'SVL%' then 'Shopee Bumi' else 'Shopee Ottz' end
                 else 'Mercado Livre' || case when l ->> 'empresa' ilike 'SVL%' then ' SVL' else '' end end,
            rel_rs2((l ->> 'gasto_7d')::numeric), rel_rs2((l ->> 'vendas_7d')::numeric), rel_n1((l ->> 'var_vendas_7d')::numeric),
            rel_n1((l ->> 'roas_7d')::numeric), rel_n1((l ->> 'acos_7d_pct')::numeric)), '' order by o)
          from jsonb_array_elements(coalesce(j -> 'resumo_lojas', '[]'::jsonb)) with ordinality t(l, o)), '') || '</table>'
      || '<h3>Metas de ROAS: as que mais perdem</h3><table><tr><th>Campanha</th><th>Loja</th><th>Meta</th><th>ROAS 7d</th><th>Empate</th><th>Perda 7d</th><th>Sugestão</th></tr>'
      || coalesce((select string_agg(format('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>', rel_esc(left(m ->> 'nome', 60)), rel_esc(m ->> 'loja'),
            rel_n1((m ->> 'meta')::numeric), rel_n1((m ->> 'roas_7d')::numeric), rel_n1((m ->> 'roas_equilibrio')::numeric), rel_rs2((m ->> 'perda_7d')::numeric), rel_esc(m ->> 'sugestao')), '' order by o)
          from jsonb_array_elements(coalesce(j #> '{metas,itens}', '[]'::jsonb)) with ordinality t(m, o) where o <= 10), '') || '</table>' || v_nota;
    v_resumo := j || jsonb_build_object('origem', 'automatico');

  else
    raise exception 'agente sem relatório automático: %', p_agente;
  end if;

  insert into relatorios_agentes (agente, data_referencia, destaque, resumo, corpo_html, corpo_texto)
  values (p_agente, v_hoje, v_destaque, v_resumo, v_html, v_destaque || E'\nRelatório gerado automaticamente pelo sistema.')
  on conflict (agente, data_referencia) do update
    set destaque = excluded.destaque, resumo = excluded.resumo, corpo_html = excluded.corpo_html,
        corpo_texto = excluded.corpo_texto, gerado_em = now()
    where relatorios_agentes.resumo ->> 'origem' = 'automatico';
  get diagnostics v_n = row_count;
  return jsonb_build_object('agente', p_agente, 'data', v_hoje, 'gravou', v_n > 0, 'destaque', v_destaque);
end $fn$;

-- Vigia: às 08h40, confere se os três relatórios do dia existem; tenta de novo o que falta e avisa no Discord
-- (canal erros) se mesmo assim não saiu. Sem falta, não posta nada.
create or replace function public.relatorios_auto_vigiar()
returns jsonb language plpgsql set search_path = public, extensions as $fn$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_chave text := 'sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA';
  a text; v_falhas text[] := '{}'; v_erro text;
begin
  foreach a in array array['ads', 'compras', 'financeiro'] loop
    if not exists (select 1 from relatorios_agentes where agente = a and data_referencia = v_hoje) then
      begin
        perform relatorio_auto_gerar(a);
      exception when others then
        get stacked diagnostics v_erro = message_text;
        v_falhas := v_falhas || format('%s: %s', a, left(v_erro, 160));
      end;
    end if;
  end loop;
  if array_length(v_falhas, 1) > 0 then
    perform net.http_post(
      url := 'https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/discord-notify',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_chave, 'apikey', v_chave),
      body := jsonb_build_object('canal', 'erros', 'nivel', 'erro', 'titulo', 'Relatório diário não foi gerado',
        'descricao', array_to_string(v_falhas, E'\n'), 'rodape', 'relatorios_auto_vigiar · rodar: select relatorio_auto_gerar(''<agente>'')'),
      timeout_milliseconds := 20000);
  end if;
  return jsonb_build_object('dia', v_hoje, 'falhas', to_jsonb(v_falhas));
end $fn$;

revoke all on function public.relatorio_auto_gerar(text) from public, anon, authenticated;
revoke all on function public.relatorios_auto_vigiar() from public, anon, authenticated;
revoke all on function public.rel_rs(numeric), public.rel_rs2(numeric), public.rel_n1(numeric), public.rel_esc(text) from public, anon;

-- Horários (UTC): depois do estoque do Tiny (até 10:50), do retrato de ADS (10:30) e dos alertas de ADS (10:45).
-- BRT: ADS 07h50 · compras 07h55 · financeiro 08h20 · vigia 08h40.
select cron.schedule('relatorio-auto-ads',        '50 10 * * *', $$select public.relatorio_auto_gerar('ads')$$);
select cron.schedule('relatorio-auto-compras',    '55 10 * * *', $$select public.relatorio_auto_gerar('compras')$$);
select cron.schedule('relatorio-auto-financeiro', '20 11 * * *', $$select public.relatorio_auto_gerar('financeiro')$$);
select cron.schedule('relatorio-auto-vigiar',     '40 11 * * *', $$select public.relatorios_auto_vigiar()$$);
