-- ============================================================================
-- Custos e Preços — coluna ENVASE e matéria-prima pelo peso do saco (16/nov/2026, pedido do dono)
-- Migração: producao_custo_envase_sem_perdas
--
-- 1) Matéria-prima = R$/kg × kg do saco (peso nominal; nas misturas, a parte de farinha × R$/kg + os
--    pacotes do componente pela mesma proporção). SEM perdas/sobrepeso da ficha e SEM o consumo medido
--    no fechamento do big bag. Antes o custo variável somava uma "perda" escondida (2,55% da matéria,
--    a diferença consumo da ficha 4,102 kg ÷ 4 kg) que não aparecia em coluna nenhuma.
--    O prêmio por big bag passa a ratear por 1.000 kg ÷ kg de farinha do saco (também sem perda).
-- 2) Coluna nova ENVASE = producao_parametros.pagamento_saco (o R$ por saco pago à equipe — Mix 2,50,
--    100% mandioca 1,80), somada no custo variável.
-- cv_padrao passa a ser a mesma conta (não há mais "padrão com perdas"); cv_medido segue só informativo.
-- Aviso novo quando a mão de obra manual do cenário é igual ao envase (contaria duas vezes).
--
-- Feito trocando trechos da função NO AR (cada trecho tem de existir uma vez, senão aborta).
-- ROLLBACK: o corpo anterior está em pg (versão de 09–10/nov, docs/producao-custos-precos.sql + migração
-- producao_custos_mod_grupo_por_peso); recriar a de antes e reaplicar os grants.
-- ============================================================================
do $mig$
declare s text := pg_get_functiondef('public.custo_cenario_calcular(bigint)'::regprocedure);
  procedure_ok boolean;
  pares text[][] := array[
    array['perda_fonte text, perda_pct_ficha numeric)', 'perda_fonte text, perda_pct_ficha numeric, envase numeric)'],
    array['           s.perda_pct perda_pct_cen,', '           s.perda_pct perda_pct_cen, coalesce(p.pagamento_saco, 0) envase_rs,'],
    array['coalesce(m.un_por_lote_manual, 1000 / nullif(m.kg * (1 + m.ppct) * m.frac, 0)) upl,', 'coalesce(m.un_por_lote_manual, 1000 / nullif(m.kg * m.frac, 0)) upl,'],
    array['select f.*, f.mat * f.ppct perd from f', 'select f.*, 0::numeric perd from f'],
    array['round(g.mat + g.perd + g.emb + g.etq + coalesce(g.modv, 0) + coalesce(g.premio_rs_lote / nullif(g.upl, 0), 0) + g.cif_rs_un, 4),',
          'round(g.mat + g.emb + g.etq + coalesce(g.modv, 0) + g.envase_rs + coalesce(g.premio_rs_lote / nullif(g.upl, 0), 0) + g.cif_rs_un, 4),'],
    array['round(g.mat_pad + g.emb + g.etq + coalesce(g.modv, 0) + coalesce(g.premio_rs_lote / nullif(1000 / nullif(g.consumo_padrao_kg * g.frac, 0), 0), 0) + g.cif_rs_un, 4),',
          'round(g.mat + g.emb + g.etq + coalesce(g.modv, 0) + g.envase_rs + coalesce(g.premio_rs_lote / nullif(g.upl, 0), 0) + g.cif_rs_un, 4),'],
    array['round(g.mat_med + g.emb + g.etq + coalesce(g.modv, 0) + coalesce(g.premio_rs_lote', 'round(g.mat_med + g.emb + g.etq + coalesce(g.modv, 0) + g.envase_rs + coalesce(g.premio_rs_lote'],
    array['case when g.perda_pct_cen is null and g.consumo_padrao_kg < g.peso_nominal_kg then ''consumo padrão da ficha menor que o peso do saco: perdas zeradas'' end',
          'case when g.fonte_mod = ''manual_un'' and g.envase_rs > 0 and abs(coalesce(g.mod_rs_un_manual, -1) - g.envase_rs) < 0.005 then ''mão de obra manual igual ao envase (R$ '' || to_char(g.envase_rs, ''FM990D00'') || ''/saco): pode estar contando duas vezes'' end'],
    array['round(g.kg * g.ppct, 4),', '0::numeric,'],
    array['round(g.ppct, 4),', '0::numeric,'],
    array['round(g.perd, 4),', '0::numeric,'],
    array['case when g.perda_pct_cen is not null then ''cenario'' else ''ficha'' end,', '''desconsiderada''::text,'],
    array['round(g.ppct_ficha, 4)
    from g', 'round(g.ppct_ficha, 4),
         round(g.envase_rs, 4)
    from g']
  ];
  i int;
begin
  for i in 1 .. array_length(pares, 1) loop
    if (length(s) - length(replace(s, pares[i][1], ''))) / length(pares[i][1]) <> 1 then
      raise exception 'trecho % não encontrado exatamente uma vez: %', i, left(pares[i][1], 90);
    end if;
    s := replace(s, pares[i][1], pares[i][2]);
  end loop;
  drop function public.custo_cenario_calcular(bigint);
  execute s;
  revoke all on function public.custo_cenario_calcular(bigint) from public, anon;
  grant execute on function public.custo_cenario_calcular(bigint) to authenticated, service_role;
end $mig$;
