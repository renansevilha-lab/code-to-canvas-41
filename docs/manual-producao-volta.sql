-- =============================================================================
-- Manual de Operação: Produção de Areia (RESP-09) VOLTA às rotinas (17/nov/2026, dono:
-- "a produção deve estar no PDF ainda, o que não deve estar é a parte de controle da Ordem de
-- Produção — para essa parte temos um PDF à parte, gerado na produção").
-- Desfaz só o item RESP-09 de docs/manual-revisao-17nov.sql. O quadro "Registro da produção"
-- (Nº da ordem / Data / Quem produziu / Conferido por) saiu do PDF no código (src/lib/rotinas.ts).
-- Migração: manual_producao_volta
-- =============================================================================
update public.manual_secoes set ativo = true where code = 'RESP-09';

-- ROLLBACK: update public.manual_secoes set ativo = false where code = 'RESP-09';
