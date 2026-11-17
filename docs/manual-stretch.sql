-- =============================================================================
-- Manual de Operação: STRETCH no recebimento e nos paletes da produção (17/nov/2026, pedido do dono:
-- "usam o stretch nos paletes, também" / "o recebimento de mercadoria também precisa passar por stretch")
--
-- 1) RESP-02 (Conferência de Notas de Entrada): passo novo no fim da fase "Quando chega mercadoria" —
--    pallet conferido recebe stretch antes de ir para o estoque.
-- 2) Produção (producao_manual id 7, "Fechamento de fardos"): passo novo — fardos no palete e palete
--    envolvido com stretch. O bloco segue marcado como rascunho (o resto do texto não foi revisado).
-- Aparece em /rotinas, no PDF, no /processos, no Checklist do Dia e na folha/manual da produção.
-- Migração: manual_stretch
-- =============================================================================

begin;

insert into public.manual_itens (secao_code, tipo, texto, tags, ordem)
select 'RESP-02', 'check', 'Depois de conferido, passar stretch no pallet antes de guardar no estoque',
       array['fase:Quando chega mercadoria'], 5
 where not exists (select 1 from public.manual_itens
                    where secao_code = 'RESP-02' and ativo and texto ilike '%stretch%');

update public.producao_manual
   set passos = passos || array['Fardos prontos vão para o palete; envolver o palete com stretch antes de guardar.']
 where id = 7
   and not exists (select 1 from unnest(passos) p where p ilike '%stretch%');

commit;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
begin;
delete from public.manual_progresso where item_id in (select id from public.manual_itens where secao_code = 'RESP-02' and texto ilike '%stretch%');
delete from public.manual_itens where secao_code = 'RESP-02' and texto ilike '%stretch no pallet%';
update public.producao_manual set passos = array(select p from unnest(passos) p where p not ilike '%stretch%') where id = 7;
commit;
*/
