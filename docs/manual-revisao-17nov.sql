-- =============================================================================
-- Manual de Operação — revisão do dono sobre o PDF das Rotinas (17/nov/2026)
--
-- RESP-02 Conferência de Notas de Entrada: Nikolas E Kevin; acompanham ordens de compra, previsão,
--   atrasos, preveem o espaço de estoque e planejam o recebimento; checklist refeito pela tela de
--   Compras e Recebimento (Chegou → contagem por fardo/caixa ou bipe → Concluir conferência →
--   Divergência/Resolver).
-- RESP-01 Pedidos a Enviar: sai "Organizar as TAGs de envio" (não existem mais); entra acompanhar
--   erros rotineiros / o que atrasa / apontar melhorias e processos que não funcionam.
-- RESP-03 Organização do Estoque: "nunca no chão" passa para a Tânia; regra "Conferência" (Tânia) e
--   regra "Inventário" (Areia: Nikolas e Kevin · Pequenos: Tânia e Vinicius).
-- RESP-09 Produção de Areia: sai das rotinas (seção desativada) — tem documento próprio (folha de
--   controle + manual de processos da produção). Itens e callouts ficam guardados.
-- Migração: manual_revisao_17nov
-- =============================================================================

begin;

-- ---------- RESP-02 ----------
update public.manual_secoes set
  responsavel_id = 'niko',
  responsaveis_extra = array['kevin'],
  descricao = 'Acompanhamento das compras até a chegada, planejamento do espaço, recebimento e conferência das mercadorias.',
  frequencia = 'Diário e quando chega mercadoria'
 where code = 'RESP-02';

-- itens existentes (mantêm o id → histórico de marcações)
update public.manual_itens set ordem = 3 where id = '8b590f36-7138-4858-ba34-f663047d51e3';           -- receber em pallets
update public.manual_itens set ordem = 4, texto = 'No quadro de Compras e Recebimento, clicar "Chegou" na ordem da carga',
  tags = array['fase:Quando chega mercadoria', 'lugar:sistema'] where id = '7cf03e76-7c42-495a-832b-dd8f8ac2205d';
update public.manual_itens set ordem = 6, texto = 'Conferir o estado dos produtos'
 where id = 'e62b670c-9acc-4b4a-9258-be0d2bbb7a8f';
update public.manual_itens set ordem = 7 where id = '864343b6-5f50-4013-980a-63e3bf95a326';           -- problema: ressalva + foto + Discord
update public.manual_itens set ordem = 9 where id = '7f7d5d84-72b8-4095-b0f1-aeb803a63602';           -- stretch

insert into public.manual_itens (secao_code, tipo, texto, tags, ordem) values
  ('RESP-02', 'check', 'Acompanhar as ordens de compra em Compras e Recebimento: previsão de entrega e atrasos do fornecedor',
     array['fase:Acompanhamento diário', 'lugar:sistema'], 1),
  ('RESP-02', 'check', 'Prever o espaço de estoque que as próximas entregas vão ocupar e planejar o recebimento das mercadorias',
     array['fase:Acompanhamento diário'], 2),
  ('RESP-02', 'check', 'Contar a carga no sistema, item por item: por fardo/caixa ou bipando o código de barras',
     array['fase:Quando chega mercadoria', 'lugar:sistema'], 5),
  ('RESP-02', 'check', 'Concluir a conferência no sistema (com diferença, a ordem vai para Divergência)',
     array['fase:Quando chega mercadoria', 'lugar:sistema'], 8),
  ('RESP-02', 'check', 'Resolver as ordens em Divergência no sistema (botão Resolver)',
     array['fase:Depois da conferência', 'lugar:sistema'], 10);

-- ---------- RESP-01 ----------
update public.manual_itens set ativo = false, desativado_em = now()
 where id = '0c7fc2ab-56ff-4a95-8110-78ed90eba388';                                                  -- Organizar as TAGs de envio
insert into public.manual_itens (secao_code, tipo, texto, tags, ordem) values
  ('RESP-01', 'check', 'Acompanhar os erros rotineiros e o que está atrasando a rotina; apontar melhorias e processos que não funcionam',
     array[]::text[], 4);

-- ---------- RESP-03 ----------
update public.manual_itens set responsavel_id = 'tania' where id = 'ceff56bf-ba0f-4540-9929-97052cbfa2c0';  -- nunca no chão
update public.manual_secoes set callouts = coalesce(callouts, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object('tipo', 'regra', 'titulo', 'Conferência', 'texto', 'A conferência da organização do estoque é da Tânia.'),
    jsonb_build_object('tipo', 'regra', 'titulo', 'Inventário', 'texto', 'Inventário de Areia: Nikolas e Kevin. Inventário de Pequenos: Tânia e Vinicius.'))
 where code = 'RESP-03';

-- ---------- RESP-09 ----------
update public.manual_secoes set ativo = false where code = 'RESP-09';

commit;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
begin;
update public.manual_secoes set responsavel_id = 'niko', responsaveis_extra = '{}',
  descricao = 'Recebimento, conferência e documentação das mercadorias.', frequencia = 'Quando chega mercadoria' where code = 'RESP-02';
delete from public.manual_progresso where item_id in (select id from public.manual_itens where criado_em >= '2026-11-17' and secao_code in ('RESP-01','RESP-02') and texto not ilike '%stretch%');
delete from public.manual_itens where criado_em >= '2026-11-17' and secao_code in ('RESP-01','RESP-02') and texto not ilike '%stretch%';
update public.manual_itens set ordem = 1 where id = '8b590f36-7138-4858-ba34-f663047d51e3';
update public.manual_itens set ordem = 2, texto = 'Abrir a ordem de compra em Compras e Recebimento no sistema e fazer a conferência por lá',
  tags = array['fase:Quando chega mercadoria','lugar:sistema'] where id = '7cf03e76-7c42-495a-832b-dd8f8ac2205d';
update public.manual_itens set ordem = 3, texto = 'Conferir quantidade e estado dos produtos' where id = 'e62b670c-9acc-4b4a-9258-be0d2bbb7a8f';
update public.manual_itens set ordem = 4 where id = '864343b6-5f50-4013-980a-63e3bf95a326';
update public.manual_itens set ordem = 5 where id = '7f7d5d84-72b8-4095-b0f1-aeb803a63602';
update public.manual_itens set ativo = true, desativado_em = null where id = '0c7fc2ab-56ff-4a95-8110-78ed90eba388';
update public.manual_itens set responsavel_id = 'niko' where id = 'ceff56bf-ba0f-4540-9929-97052cbfa2c0';
update public.manual_secoes set callouts = '[]'::jsonb where code = 'RESP-03';
update public.manual_secoes set ativo = true where code = 'RESP-09';
commit;
*/
