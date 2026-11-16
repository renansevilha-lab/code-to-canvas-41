-- ============================================================================
-- Rotinas da Operação (16/nov/2026, decisões A–E do dono)
-- Migração: rotinas_operacao
--
-- A página /rotinas lê o MESMO manual do /processos (manual_secoes, manual_itens, producao_manual).
-- Nada de coluna nova no manual: a montagem usa as TAGS dos itens e os CALLOUTS das seções.
--   tags do item:
--     rotina:RESP-xx  → item da Rotina Matinal / Encerramento que aparece dentro dessa rotina
--     fase:<nome>     → em que fase da linha de etapas ele entra (sem tag: matinal = "Ao chegar",
--                       processo = "Durante o dia", pergunta = Encerramento)
--     lugar:sistema   → etiqueta "No sistema" no lugar do responsável
--     proibido        → vai para o quadro "Não é permitido" em vez da linha de etapas
--   callouts da seção (JSON editável no modo edição do manual):
--     {tipo:"warn"|"regra", titulo?, texto}  → regra fixa (a primeira "warn"/principal fica em laranja)
--     {tipo:"info", texto}                   → regra fixa comum
--     {tipo:"temporario", titulo?, texto}    → bloco "Medida temporária"
--     {tipo:"numerar"}                       → numerar as etapas (só onde a ordem importa)
-- Marcação: rotinas diárias gravam em manual_progresso (o mesmo do Checklist do Dia). A Produção de
-- Areia grava por produção em rotina_execucao / rotina_execucao_marca ("Nova produção" abre outra).
-- ============================================================================

-- 1) itens da Rotina Matinal / Encerramento → rotina de cada assunto (texto e responsável NÃO mudam)
update public.manual_itens set tags = array(select distinct unnest(coalesce(tags, '{}') || array[x.tag]))
from (values
  ('ROT-AM', 1, 'rotina:RESP-01'), ('ROT-AM', 3, 'rotina:RESP-01'), ('ROT-AM', 2, 'rotina:RESP-06'),
  ('ROT-AM', 4, 'rotina:RESP-05'), ('ROT-AM', 5, 'rotina:RESP-03'),
  ('ROT-PM', 1, 'rotina:RESP-01'), ('ROT-PM', 2, 'rotina:RESP-06'), ('ROT-PM', 3, 'rotina:RESP-02'),
  ('ROT-PM', 4, 'rotina:RESP-03'), ('ROT-PM', 5, 'rotina:RESP-05'), ('ROT-PM', 6, 'rotina:RESP-03'),
  ('ROT-PM', 7, 'rotina:RESP-03')
) as x(secao, ordem, tag)
where manual_itens.secao_code = x.secao and manual_itens.ordem = x.ordem and manual_itens.ativo;

-- fases dos processos que não são "durante o dia" (o nome é a frequência da própria seção)
update public.manual_itens set tags = array(select distinct unnest(coalesce(tags, '{}') || array['fase:Quando chega mercadoria']))
 where secao_code = 'RESP-02' and ativo;
update public.manual_itens set tags = array(select distinct unnest(coalesce(tags, '{}') || array['fase:Quando notificado']))
 where secao_code = 'RESP-04' and ativo;
-- "nunca no chão" é proibição → quadro "Não é permitido"
update public.manual_itens set tags = array(select distinct unnest(coalesce(tags, '{}') || array['proibido']))
 where secao_code = 'RESP-03' and ordem = 1 and ativo;
-- recebimento: a ordem das etapas importa
update public.manual_secoes set callouts = coalesce(callouts, '[]'::jsonb) || '[{"tipo":"numerar"}]'::jsonb
 where code = 'RESP-02' and not coalesce(callouts, '[]'::jsonb) @> '[{"tipo":"numerar"}]'::jsonb;

-- 2) Produção de Areia: seção RESP-09. Os passos vêm do Manual de processos da Produção (producao_manual);
--    aqui só os dois passos do SISTEMA que abrem a produção (o fluxo do app: Iniciar produção + folha).
insert into public.manual_secoes (code, tipo, titulo, descricao, frequencia, responsavel_id, ordem, callouts, tabela_ref, ativo)
values ('RESP-09', 'processo', 'Produção de Areia', 'Envase da areia a partir do big bag. Os passos da bancada estão no Manual de processos da Produção.',
        'A cada produção', null, 9, '[{"tipo":"numerar"}]'::jsonb, null, true)
on conflict (code) do nothing;
insert into public.manual_itens (secao_code, tipo, texto, tags, turno, responsavel_id, dias, abre_quando, campo_label, ordem, ativo)
select 'RESP-09', 'check', x.texto, x.tags, null, null, null, 'nao', 'Descreva', x.ordem, true
from (values
  ('Iniciar a produção no sistema (Produção › Iniciar produção)', array['fase:Antes de produzir', 'lugar:sistema'], 1),
  ('Imprimir a folha de controle do lote', array['fase:Antes de produzir', 'lugar:sistema'], 2)
) as x(texto, tags, ordem)
where not exists (select 1 from public.manual_itens i where i.secao_code = 'RESP-09');

-- 3) marcação por produção (não por dia)
create table if not exists public.rotina_execucao (
  id bigserial primary key,
  secao_code text not null references public.manual_secoes(code),
  iniciada_em timestamptz not null default now(),
  iniciada_por text references public.equipe_membros(id) on delete set null,
  encerrada_em timestamptz
);
create table if not exists public.rotina_execucao_marca (
  execucao_id bigint not null references public.rotina_execucao(id) on delete cascade,
  chave text not null,          -- 'mi:<uuid do manual_itens>' ou 'pm:<id do producao_manual>'
  feito_em timestamptz not null default now(),
  por text references public.equipe_membros(id) on delete set null,
  primary key (execucao_id, chave)
);
alter table public.rotina_execucao enable row level security;
alter table public.rotina_execucao_marca enable row level security;
drop policy if exists p_all on public.rotina_execucao;
drop policy if exists p_all on public.rotina_execucao_marca;
create policy p_all on public.rotina_execucao for all to authenticated using (true) with check (true);
create policy p_all on public.rotina_execucao_marca for all to authenticated using (true) with check (true);
revoke all on public.rotina_execucao, public.rotina_execucao_marca from anon, public;
grant select, insert, update, delete on public.rotina_execucao, public.rotina_execucao_marca to authenticated, service_role;
grant usage, select on sequence public.rotina_execucao_id_seq to authenticated, service_role;

-- ROLLBACK:
--   drop table public.rotina_execucao_marca; drop table public.rotina_execucao;
--   delete from public.manual_itens where secao_code = 'RESP-09'; delete from public.manual_secoes where code = 'RESP-09';
--   update public.manual_itens set tags = array(select t from unnest(tags) t where t not like 'rotina:%' and t not like 'fase:%'
--     and t not in ('proibido', 'lugar:sistema'));
--   update public.manual_secoes set callouts = (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(callouts) c
--     where c->>'tipo' <> 'numerar') where code = 'RESP-02';

-- 16/nov/2026 (pedido do dono): nomes das rotinas = os do anexo de referência; produção = Kevin.
-- (só dado; vale também no /processos e no Checklist do Dia, que leem o mesmo manual_secoes)
update public.manual_secoes s set titulo = x.titulo, responsavel_id = coalesce(x.resp, s.responsavel_id)
from (values ('RESP-01','Pedidos a Enviar',null), ('RESP-03','Organização do Estoque',null),
             ('RESP-05','Reembolsos e Devoluções',null), ('RESP-06','Fulfillment',null),
             ('RESP-09','Produção de Areia','kevin')) as x(code, titulo, resp)
where s.code = x.code;
-- nomes anteriores: RESP-01 'Envios — Shopee · Mercado Livre · TikTok Shop', RESP-03 'Embalagens & Organização de Estoque',
--   RESP-05 'Logística Reversa & Devoluções', RESP-06 'Envios Fulfillment'; RESP-09 sem responsável.

-- 16/nov/2026 (pedido do dono): Compras (RESP-04) e Recebimento de mercadoria (RESP-02) = Nikolas e Kevin.
-- Migração manual_secoes_responsaveis_extra: coluna nova para mais de um responsável por seção.
alter table public.manual_secoes add column if not exists responsaveis_extra text[] not null default '{}';
update public.manual_secoes set responsavel_id = 'niko', responsaveis_extra = array['kevin'] where code in ('RESP-02','RESP-04');
-- (antes: RESP-02 = niko, RESP-04 = vini) · rollback: alter table public.manual_secoes drop column responsaveis_extra;
--   update public.manual_secoes set responsavel_id = 'vini' where code = 'RESP-04';
