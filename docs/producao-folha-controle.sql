-- Produção — manual de processos (11/nov/2026, pedido do dono)
-- Base da "folha de controle da produção" (PDF impresso ao iniciar cada lote) e do manual de treinamento.
-- Cada linha = uma seção do manual (limpeza, conferência, envase, selagem…), com os passos em ordem.
-- quando: antes (vira checklist "antes de começar" na folha) · durante · depois (checklist de encerramento) · sempre.
-- etapa: null = geral; senão a etapa do lote (etiquetagem, envase, selagem, fardos) — etiquetagem só sai na folha
--        quando a embalagem do lote leva etiqueta.
-- sku: null = vale para todos os produtos; preenchido = só para aquele produto.
-- O texto inicial é um RASCUNHO para o dono revisar pela tela (Produção › Manual de processos).

create table if not exists public.producao_manual (
  id bigserial primary key,
  ordem integer not null default 0,
  titulo text not null,
  quando text not null default 'durante' check (quando in ('antes', 'durante', 'depois', 'sempre')),
  etapa text check (etapa is null or etapa in ('etiquetagem', 'envase', 'selagem', 'fardos')),
  sku text,
  passos text[] not null default '{}',
  observacao text,
  ativo boolean not null default true,
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);

alter table public.producao_manual enable row level security;
create policy ler on public.producao_manual for select to authenticated using (tem_modulo('galpao'));
create policy alterar on public.producao_manual for all to authenticated using (tem_modulo('todos')) with check (tem_modulo('todos'));
revoke all on public.producao_manual from anon, public;
grant select, insert, update, delete on public.producao_manual to authenticated;
grant all on public.producao_manual to service_role;
grant usage, select on sequence public.producao_manual_id_seq to authenticated;
revoke all on sequence public.producao_manual_id_seq from anon, public;

insert into public.producao_manual (ordem, titulo, quando, etapa, passos, observacao, atualizado_por) values
(10, 'Limpeza e preparação da área', 'antes', null, array[
  'Tirar da área tudo que não é deste lote: sacos, etiquetas e fardos de outro produto.',
  'Varrer o piso e tirar o pó de farinha da bancada, do funil, da pá e da balança (pano seco ou aspirador — nunca água perto da farinha).',
  'Troca de produto ou de farinha: limpeza completa do funil e da pá, sem resto da farinha anterior.',
  'Lavar as mãos; touca, máscara e luvas colocadas.'
], null, 'rascunho'),
(20, 'Conferência dos equipamentos', 'antes', null, array[
  'Balança ligada, nivelada e zerada; tarar com um saco vazio.',
  'Conferir a balança com um peso conhecido e anotar o valor lido na folha.',
  'Seladora ligada na temperatura da ficha; testar a solda num saco vazio e puxar para ver se segura.',
  'Datadora com o código DESTE lote (está no topo da folha).'
], null, 'rascunho'),
(30, 'Conferência dos materiais', 'antes', null, array[
  'O big bag aberto é o da folha (código e tipo de farinha).',
  'A embalagem é a da folha; etiquetas do produto certo, quando a embalagem leva etiqueta.',
  'Produto com mistura: os pacotes do componente estão separados na quantidade da folha.',
  'Sacos e etiquetas suficientes para os sacos planejados.'
], null, 'rascunho'),
(40, 'Etiquetagem', 'durante', 'etiquetagem', array[
  'Etiqueta reta, no lugar marcado, sem bolha e sem dobra.',
  'Etiqueta torta ou do produto errado: o saco vai para o refugo (motivo "etiqueta").'
], null, 'rascunho'),
(50, 'Envase e pesagem', 'durante', 'envase', array[
  'Encher até o peso da ficha (o "vai no saco"); nunca abaixo do mínimo aceito.',
  'Pesar os primeiros sacos do lote e depois 1 a cada tanto, como diz a regra de pesagem da folha; anotar cada peso na folha e no app.',
  'Peso abaixo do mínimo: completar o saco e pesar de novo. Dois seguidos abaixo: parar e conferir a balança e a dosagem.',
  'Contar cada saco no app (+1) na hora em que é envasado.',
  'Saco furado, sujo ou rasgado vai para o refugo com o motivo.'
], null, 'rascunho'),
(60, 'Selagem', 'durante', 'selagem', array[
  'Limpar a boca do saco antes de selar (farinha na solda faz a solda abrir).',
  'Solda reta, sem rugas, ocupando a largura toda; puxar de leve para conferir.',
  'Solda falhou: refazer logo abaixo; se não der, refugo (motivo "solda").',
  'Conferir de tempos em tempos se a datadora está marcando o código do lote.'
], null, 'rascunho'),
(70, 'Fechamento de fardos', 'durante', 'fardos', array[
  'Montar o fardo com a quantidade pedida (2, 3 ou 5 sacos) e marcar no app cada fardo fechado.',
  'Fardo firme, sem saco amassado ou furado; identificação do produto visível.'
], null, 'rascunho'),
(80, 'Paradas e troca de big bag', 'durante', null, array[
  'Toda parada (troca de big bag, limpeza, manutenção, falta de embalagem) é marcada no app em "Parar" e anotada na folha.',
  'Troca de big bag: o big bag novo tem de ser da mesma farinha; anotar o código dele na folha.'
], null, 'rascunho'),
(90, 'Encerramento e limpeza final', 'depois', null, array[
  'Desligar a seladora e a balança.',
  'Fechar e identificar o big bag com o que sobrou (ou anotar que acabou).',
  'Descartar o refugo no lugar certo; guardar sacos e etiquetas que sobraram.',
  'Varrer e limpar bancada, funil, pá e balança.',
  'Conferir os números da folha com o app e encerrar o lote no app.'
], null, 'rascunho'),
(100, 'Segurança', 'sempre', null, array[
  'A seladora esquenta: não encostar na barra de solda e não deixar ligada sem ninguém.',
  'Não subir no big bag nem puxar o big bag pendurado sozinho.',
  'Piso com farinha escorrega: limpar na hora o que cair.'
], null, 'rascunho');

-- Rollback:
-- drop table if exists public.producao_manual;
