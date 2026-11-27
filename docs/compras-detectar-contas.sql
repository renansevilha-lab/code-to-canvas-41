-- =============================================================================
-- Compras: detecta sozinho as contas a pagar lançadas no Tiny (24/nov/2026, dono:
-- "verificar se é possível o próprio sistema identificar se as contas foram lançadas no Tiny").
-- Quando a conta é lançada pela nota, o Tiny grava o histórico "Ref. a NF nº N, FORNECEDOR
-- (parcela i/N)" — o espelho contas_pagar (tiny-sync-contas-pagar, 07h) traz esse texto.
-- A função cruza o nº da NF da ordem (nota ligada pelo compras-sync, nota aplicada à
-- conferência ou nf_numero digitado) + CNPJ do fornecedor (ou o nome, quando a nota não tem
-- CNPJ) e marca contas_lancadas_em / contas_lancadas_por = 'detectado no Tiny'.
-- Só ordens das últimas ~13 semanas, chegadas (conferência/divergente/concluída) e sem contas.
-- Testado em 24/nov: 17 de 19 notas ligadas (ago–nov) têm conta achada por essa regra.
-- Migração: compras_detectar_contas
-- =============================================================================
create or replace function public.compras_detectar_contas(p_dry boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  with ordens as (
    select o.tiny_id, o.numero, o.fornecedor_nome
    from compras_ordens o
    where o.contas_lancadas_em is null
      and o.arquivada_em is null
      and o.kanban_status in ('conferencia', 'divergente', 'concluida')
      and coalesce(o.recebido_em, o.criado_em, o.data_pedido::timestamptz) > now() - interval '90 days'
  ),
  nfs as (
    select o.tiny_id, ltrim(n.numero, '0') as nf, regexp_replace(coalesce(n.fornecedor_cnpj, ''), '\D', '', 'g') as cnpj, o.fornecedor_nome
      from ordens o join compras_nf_entrada n on n.ordem_tiny_id = o.tiny_id
    union
    select o.tiny_id, ltrim(a.nf_numero, '0'), regexp_replace(coalesce(n.fornecedor_cnpj, ''), '\D', '', 'g'), o.fornecedor_nome
      from ordens o join compras_nf_aplicada a on a.ordem_tiny_id = o.tiny_id
      left join compras_nf_entrada n on n.tiny_id = a.nf_tiny_id
    union
    select o.tiny_id, ltrim(co.nf_numero, '0'), '', o.fornecedor_nome
      from ordens o join compras_ordens co on co.tiny_id = o.tiny_id
      where co.nf_numero is not null
  ),
  achadas as (
    select n.tiny_id, string_agg(distinct n.nf, ', ') as nfs, count(distinct c.tiny_id) as parcelas, min(c.atualizado_em) as visto_em
    from nfs n
    join contas_pagar c
      on n.nf <> ''
     and c.descricao ilike 'Ref. a NF nº ' || n.nf || ',%'
     and (
       (n.cnpj <> '' and regexp_replace(coalesce(c.fornecedor_cnpj_cpf, ''), '\D', '', 'g') = n.cnpj)
       or (n.cnpj = '' and upper(c.fornecedor_nome) = upper(n.fornecedor_nome))
     )
    group by n.tiny_id
  ),
  marcadas as (
    update compras_ordens o
       set contas_lancadas_em = now(),
           contas_lancadas_por = 'detectado no Tiny (NF ' || a.nfs || ', ' || a.parcelas || ' parcela' || case when a.parcelas = 1 then '' else 's' end || ')'
      from achadas a
     where o.tiny_id = a.tiny_id and not p_dry and o.contas_lancadas_em is null
    returning o.tiny_id
  )
  select jsonb_build_object(
    'dry', p_dry,
    'marcadas', (select count(*) from marcadas),
    'ordens', coalesce((select jsonb_agg(jsonb_build_object('tiny_id', a.tiny_id, 'numero', o.numero, 'fornecedor', o.fornecedor_nome, 'nfs', a.nfs, 'parcelas', a.parcelas))
                        from achadas a join compras_ordens o on o.tiny_id = a.tiny_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end;
$$;

revoke all on function public.compras_detectar_contas(boolean) from public, anon, authenticated;

-- Roda 2x/dia, logo depois das leituras das contas do Tiny (07h contas; 07h23 e 19h23 liquidação).
-- (24/nov: dono achou de hora em hora demais.)
select cron.schedule('compras-detectar-contas', '45 7,19 * * *', $$ select public.compras_detectar_contas(); $$);

-- ROLLBACK:
-- select cron.unschedule('compras-detectar-contas');
-- drop function public.compras_detectar_contas(boolean);
-- update compras_ordens set contas_lancadas_em = null, contas_lancadas_por = null where contas_lancadas_por like 'detectado no Tiny%';
