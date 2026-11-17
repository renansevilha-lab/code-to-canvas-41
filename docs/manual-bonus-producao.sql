-- =============================================================================
-- Manual de Operação: regra do BÔNUS na Produção de Areia (17/nov/2026, dono:
-- "os bônus vão entrar junto das ordens de produção")
--
-- RESP-09 ganha um callout "regra" (aparece no quadro de regras da rotina, no PDF e no /processos).
-- No sistema o bônus por saco já é campo da ordem de produção (producao_op.bonus_saco, só o
-- administrador grava; aparece na coluna Pedido de Ordens de produção). Fecha a lacuna
-- "bônus temporário" das Rotinas de 16/nov.
-- Migração: manual_bonus_producao
-- =============================================================================

begin;

update public.manual_secoes
   set callouts = coalesce(callouts, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
         'tipo', 'regra', 'titulo', 'Bônus',
         'texto', 'O bônus por saco de cada produção vem na ordem de produção. Confira o valor na ordem antes de começar.'))
 where code = 'RESP-09'
   and not coalesce(callouts, '[]'::jsonb) @> '[{"titulo": "Bônus"}]'::jsonb;

commit;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
update public.manual_secoes
   set callouts = (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(callouts) c where c->>'titulo' is distinct from 'Bônus')
 where code = 'RESP-09';
*/
