-- =============================================================================
-- Manual de Operação: Trello saiu — "agora é tudo pelo sistema" (17/nov/2026, dono)
--
-- RESP-02 #2  conferência pela ordem em Compras e Recebimento (tela nova de 16–17/nov)
-- RESP-02 #4  foto do problema = apontamento com foto na ordem (compras_apontamentos)
-- RESP-04 #2  previsão de entrega é lida da OC do Tiny (data_prevista; a tela diz
--             "previsão não informada no Tiny" quando falta) → lançar no Tiny
-- RESP-06 #3  texto já dizia "no Sistema"; só a tag Trello sai
-- Tag "Trello" sai dos itens; "lugar:sistema" (etiqueta "No sistema" nas rotinas) entra onde o passo é no app.
-- Migração: manual_sem_trello
-- =============================================================================

begin;

update public.manual_itens set
  texto = 'Abrir a ordem de compra em Compras e Recebimento no sistema e fazer a conferência por lá',
  tags  = array['fase:Quando chega mercadoria', 'lugar:sistema']
 where id = '7cf03e76-7c42-495a-832b-dd8f8ac2205d';

update public.manual_itens set
  texto = 'Se houver problema: ressalva na FRENTE da NF/CTE, apontamento com foto na ordem (Compras e Recebimento) e aviso no Discord'
 where id = '864343b6-5f50-4013-980a-63e3bf95a326';

update public.manual_itens set
  texto = 'Lançar a previsão de entrega na ordem de compra do Tiny (aparece em Compras e Recebimento no sistema)',
  tags  = array['fase:Quando notificado', 'Tiny']
 where id = '7d0d979f-70c6-412f-8e0d-4780a9b0cf7f';

update public.manual_itens set
  tags  = array['lugar:sistema']
 where id = '61a03529-e615-4ec8-a22a-6a25ad1ce409';

commit;

-- =============================================================================
-- ROLLBACK (textos e tags de antes)
-- =============================================================================
/*
begin;
update public.manual_itens set texto = 'Apontar no Trello o responsável pela conferência e lançar a NF ou ordem de compra',
  tags = array['fase:Quando chega mercadoria', 'Trello'] where id = '7cf03e76-7c42-495a-832b-dd8f8ac2205d';
update public.manual_itens set texto = 'Se houver problema: ressalva na FRENTE da NF/CTE, foto no Trello e aviso no Discord'
  where id = '864343b6-5f50-4013-980a-63e3bf95a326';
update public.manual_itens set texto = 'Atualizar no Trello com a previsão de entrega',
  tags = array['fase:Quando notificado', 'Trello'] where id = '7d0d979f-70c6-412f-8e0d-4780a9b0cf7f';
update public.manual_itens set tags = array['Trello'] where id = '61a03529-e615-4ec8-a22a-6a25ad1ce409';
commit;
*/
