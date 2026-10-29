-- ============================================================================
-- Devoluções e reembolsos — reforma (29/out/2026). Passo 1: banco.
-- Plano em docs/devolucoes-reforma-plano.md. Migração: devolucoes_reforma_01_banco.
-- O que entra: espelho das reclamações do ML (ml_claims, ml_claim_mensagens,
-- ml_claim_motivos), o histórico de respostas (devolucao_resposta +
-- devolucao_resposta_modelo), o dicionário de causa interna (devolucao_causa),
-- causa/separador nas entradas do galpão, a fila única "Pede resposta"
-- (view_devolucoes_pede_resposta) e as RPCs do painel do caso e das sugestões.
-- Nada aqui escreve em marketplace. Rollback no fim do arquivo.
-- ============================================================================

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Dicionário de causa interna (o que alimenta a aba Erros)
-- ---------------------------------------------------------------------------
create table if not exists public.devolucao_causa (
  codigo   text primary key,
  grupo    text not null check (grupo in ('separacao','embalagem','transportadora','produto','cliente','outro')),
  nome     text not null,
  ordem    int  not null default 100,
  ativo    boolean not null default true
);
insert into public.devolucao_causa (codigo, grupo, nome, ordem) values
  ('separacao_item_errado',        'separacao',      'Separação · item errado',                10),
  ('separacao_item_faltando',      'separacao',      'Separação · item ou quantidade faltando', 11),
  ('embalagem_furado',             'embalagem',      'Embalagem · chegou furado/rasgado',      20),
  ('embalagem_vazado',             'embalagem',      'Embalagem · vazou',                      21),
  ('embalagem_quebrado',           'embalagem',      'Embalagem · quebrado/amassado',          22),
  ('transportadora_nao_recebido',  'transportadora', 'Transportadora · não recebido/atraso',   30),
  ('transportadora_extravio',      'transportadora', 'Transportadora · extravio',              31),
  ('produto_defeito',              'produto',        'Produto · defeito/qualidade',            40),
  ('produto_validade',             'produto',        'Produto · validade/carunchos',           41),
  ('produto_anuncio',              'produto',        'Produto · diferente do anúncio',         42),
  ('cliente_desistiu',             'cliente',        'Cliente · desistiu',                     50),
  ('cliente_nao_serviu',           'cliente',        'Cliente · não serviu/tamanho',           51),
  ('cliente_suspeito',             'cliente',        'Cliente · suspeita de má-fé',            52),
  ('outro',                        'outro',          'Outro',                                  90)
on conflict (codigo) do nothing;

-- Causa PROVÁVEL pelo motivo do marketplace (vale até alguém classificar).
create or replace function public.devolucao_causa_provavel(p_marketplace text, p_motivo text)
returns text language sql immutable as $$
  select case
    when p_marketplace = 'shopee' then case p_motivo
      when 'NOT_RECEIPT'       then 'transportadora_nao_recebido'
      when 'ITEM_MISSING'      then 'separacao_item_faltando'
      when 'WRONG_ITEM'        then 'separacao_item_errado'
      when 'SPILLED_CONTENTS'  then 'embalagem_vazado'
      when 'DAMAGED_OTHERS'    then 'embalagem_quebrado'
      when 'PHYSICAL_DMG'      then 'embalagem_quebrado'
      when 'FUNCTIONAL_DMG'    then 'produto_defeito'
      when 'EXPIRED_PRODUCT'   then 'produto_validade'
      when 'ITEM_NOT_FIT'      then 'cliente_nao_serviu'
      when 'CHANGE_MIND'       then 'cliente_desistiu'
      when 'NOT_AS_DESCRIBED'  then 'produto_anuncio'
      when 'COUNTERFEIT'       then 'produto_anuncio'
      when 'SUSPICIOUS_PARCEL' then 'transportadora_nao_recebido'
      else 'outro' end
    -- ML: o motivo vem pelo "name" do catálogo de motivos (ml_claim_motivos)
    when p_marketplace = 'mercadolivre' then case
      -- nomes reais vistos em 29/out: selected_wrong_product = o COMPRADOR escolheu errado (cliente);
      -- different_item_other = recebeu outro produto (separacao); different_than_published = anuncio
      when p_motivo ~* 'selected_wrong|repentant|arrepend|regret|change_receiver' then 'cliente_desistiu'
      when p_motivo ~* 'not_receive|not_received|not_delivered|undelivered|out_of_time|delay' then 'transportadora_nao_recebido'
      when p_motivo ~* 'lost|extrav'                                   then 'transportadora_extravio'
      when p_motivo ~* 'different_than_published|published|not_as_described|description' then 'produto_anuncio'
      when p_motivo ~* 'different_item|different_product|wrong|incorrect' then 'separacao_item_errado'
      when p_motivo ~* 'missing|incomplete'                            then 'separacao_item_faltando'
      when p_motivo ~* 'damaged|broken'                                then 'embalagem_quebrado'
      when p_motivo ~* 'defect|not_working|malfunction|quality'        then 'produto_defeito'
      when p_motivo ~* 'expired'                                       then 'produto_validade'
      when p_motivo ~* 'size|fit'                                      then 'cliente_nao_serviu'
      else 'outro' end
    else 'outro' end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Espelho das reclamações do Mercado Livre (as duas contas)
-- ---------------------------------------------------------------------------
create table if not exists public.ml_claim_motivos (
  reason_id     text primary key,
  nome          text,
  detalhe       text,
  flow          text,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.ml_claims (
  claim_id            bigint primary key,
  conta               bigint not null,            -- user_id da conta ML (Ottz 1107117809 / SVL 1299638625)
  order_id            text,
  pack_id             text,
  tipo                text,                       -- mediations | returns | cancel_purchase | ...
  stage               text,                       -- claim | dispute | ...
  status              text,                       -- opened | closed
  reason_id           text,
  claimed_quantity    int,
  quantity_type       text,
  fulfilled           boolean,
  resolucao           jsonb,                      -- {reason, benefited[], closed_by, applied_coverage, date_created}
  acoes_disponiveis   jsonb not null default '[]'::jsonb, -- available_actions do respondent (nós)
  acao_obrigatoria    text,
  prazo_acao          timestamptz,                -- menor due_date entre as ações
  expected_resolution text,
  return_id           bigint,
  related_entities    text[],
  criado_em           timestamptz,
  atualizado_em       timestamptz,                -- last_updated do ML
  fechado_em          timestamptz,
  mensagens_n         int not null default 0,
  ultima_msg_de       text,
  ultima_msg_em       timestamptz,
  mensagens_lidas_em  timestamptz,
  visto_em            timestamptz not null default now()
);
create index if not exists ml_claims_order_idx  on public.ml_claims (order_id);
create index if not exists ml_claims_pack_idx   on public.ml_claims (pack_id);
create index if not exists ml_claims_status_idx on public.ml_claims (status, prazo_acao);

create table if not exists public.ml_claim_mensagens (
  hash       text primary key,                    -- hash do ML (único por mensagem)
  claim_id   bigint not null references public.ml_claims(claim_id) on delete cascade,
  de         text,                                -- sender_role: complainant | respondent | mediator
  para       text,                                -- receiver_role
  texto      text,                                -- HTML convertido em texto
  html       text,
  anexos     jsonb not null default '[]'::jsonb,
  stage      text,
  status     text,
  data       timestamptz,
  lida_em    timestamptz,
  visto_em   timestamptz not null default now()
);
create index if not exists ml_claim_mensagens_claim_idx on public.ml_claim_mensagens (claim_id, data);

-- ---------------------------------------------------------------------------
-- 3. Histórico de respostas (o que ensina o sistema) + modelos
-- ---------------------------------------------------------------------------
create table if not exists public.devolucao_resposta (
  id                 bigserial primary key,
  marketplace        text not null check (marketplace in ('shopee','mercadolivre')),
  conta              text not null,               -- shop_id (Shopee) ou user_id (ML), em texto
  case_id            text not null,               -- return_sn | claim_id
  order_sn           text,
  motivo_mkt         text,
  texto_cliente      text,
  solucao            text,                        -- devolucao | reembolso | mediacao | ...
  valor              numeric,
  fotos_cliente      int,
  tem_entrada_galpao boolean,
  estado_item        text,
  causa_interna      text references public.devolucao_causa(codigo),
  separador          text,
  acao               text not null,               -- aprovar | disputar | oferta | mensagem_comprador | mensagem_mediador | reembolsar | validar_ok | validar_recusa | so_causa
  texto_resposta     text,
  motivo_disputa_id  text,
  sugestao_usada     text check (sugestao_usada in ('nenhuma','historico','modelo','ia','ia_editada')) default 'nenhuma',
  respondido_por     text,
  respondido_em      timestamptz not null default now(),
  enviado            jsonb,                       -- o que foi mandado ao marketplace
  resposta_mkt       jsonb,                       -- resposta crua
  ok                 boolean,                     -- o marketplace aceitou a ação
  resultado          text,                        -- preenchido depois pelo sync: reembolso_aprovado | disputa_ganha | disputa_perdida | oferta_aceita | ...
  resultado_em       timestamptz
);
create index if not exists devolucao_resposta_case_idx  on public.devolucao_resposta (marketplace, case_id);
create index if not exists devolucao_resposta_order_idx on public.devolucao_resposta (order_sn);
create index if not exists devolucao_resposta_busca_idx on public.devolucao_resposta (marketplace, motivo_mkt, acao) where texto_resposta is not null;
create index if not exists devolucao_resposta_trgm_idx  on public.devolucao_resposta using gin (texto_cliente extensions.gin_trgm_ops);

create table if not exists public.devolucao_resposta_modelo (
  id            bigserial primary key,
  nome          text not null,
  marketplace   text check (marketplace in ('shopee','mercadolivre')),   -- null = os dois
  causa_interna text references public.devolucao_causa(codigo),
  acao          text,
  texto         text not null,
  usos          int not null default 0,
  ativo         boolean not null default true,
  criado_por    text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Causa e separador nas entradas do galpão
-- ---------------------------------------------------------------------------
alter table public.devolucoes_recebidas add column if not exists causa_interna text references public.devolucao_causa(codigo);
alter table public.devolucoes_recebidas add column if not exists separador text;

-- Quem finalizou a TAG do pedido (tags_lote.finalizada_por). ML de carrinho: o Tiny
-- registra pelo pack_id — aceita os dois.
create or replace function public.devolucao_separador(p_order_sn text)
returns text language sql stable set search_path = public as $$
  select tl.finalizada_por
  from separacao_tiny st
  join tags_lote tl on tl.tag = st.tag_lote
  where st.numero_ecommerce in (
          select p_order_sn
          union select p.pack_id from pedidos p where p.id = p_order_sn and p.pack_id is not null)
    and tl.finalizada_por is not null
  order by tl.finalizada_em desc nulls last
  limit 1;
$$;

create or replace function public.trg_devolucoes_recebidas_separador()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.separador is null and new.order_sn is not null then
    new.separador := devolucao_separador(new.order_sn);
  end if;
  return new;
end $$;
drop trigger if exists trg_devolucoes_recebidas_separador on public.devolucoes_recebidas;
create trigger trg_devolucoes_recebidas_separador
  before insert on public.devolucoes_recebidas
  for each row execute function public.trg_devolucoes_recebidas_separador();

-- preenche o histórico (só quem casa com TAG finalizada)
update public.devolucoes_recebidas d set separador = devolucao_separador(d.order_sn)
 where d.separador is null and d.order_sn is not null;

-- ---------------------------------------------------------------------------
-- 5. A fila única: tudo que pede (ou pode pedir) resposta, Shopee + ML
-- ---------------------------------------------------------------------------
create or replace view public.view_devolucoes_pede_resposta as
with shopee as (
  select
    'shopee'::text                                   as marketplace,
    d.shop_id::text                                  as conta,
    case d.shop_id when 522186766 then 'ottz' when 759046323 then 'svl' else null end as empresa,
    d.return_sn                                      as case_id,
    d.order_sn,
    d.status                                         as status_mkt,
    d.reason                                         as motivo,
    d.reason                                         as motivo_nome,
    d.text_reason                                    as texto_cliente,
    case d.solucao when 0 then 'devolucao' when 1 then 'reembolso' else null end as solucao,
    d.refund_amount                                  as valor,
    coalesce(jsonb_array_length(d.images), 0)        as fotos_cliente,
    d.create_time                                    as criado_em,
    d.update_time                                    as atualizado_em,
    -- o que a Shopee espera de nós
    case
      when d.status = 'REQUESTED' then 'responder'
      when d.status = 'PROCESSING' and d.logistica_reversa = 'LOGISTICS_DELIVERY_DONE' then 'validar_produto'
      when d.status = 'PROCESSING' then 'aguardando_produto'
      when d.status = 'JUDGING' then 'em_analise'
      when d.status = 'SELLER_DISPUTE' then 'disputa_aberta'
      when d.status = 'ACCEPTED' and d.compensacao_status = 'PENDING_REQUEST' then 'validar_reembolso'
      else 'acompanhar' end                          as acao_esperada,
    case
      when d.status = 'REQUESTED' then true
      when d.status = 'PROCESSING' and d.logistica_reversa = 'LOGISTICS_DELIVERY_DONE' then true
      when d.status = 'ACCEPTED' and d.compensacao_status = 'PENDING_REQUEST' and coalesce(d.prazo_disputa, d.due_date) > now() then true
      else false end                                 as precisa_acao,
    coalesce(d.prazo_disputa,
             case when d.status <> 'ACCEPTED' then d.prazo_vendedor end,
             d.due_date)                             as prazo,
    '[]'::jsonb                                      as acoes,
    d.itens,
    d.logistica_reversa,
    d.tracking_number                                as rastreio_volta,
    d.volta_entregue_em
  from shopee_devolucoes d
  where (d.status in ('REQUESTED','PROCESSING','JUDGING','SELLER_DISPUTE') and d.create_time >= now() - interval '60 days')
     or (d.status = 'ACCEPTED' and d.compensacao_status = 'PENDING_REQUEST' and coalesce(d.prazo_disputa, d.due_date) > now())
),
ml as (
  select
    'mercadolivre'::text                             as marketplace,
    c.conta::text                                    as conta,
    case c.conta when 1107117809 then 'ottz' when 1299638625 then 'svl' else null end as empresa,
    c.claim_id::text                                 as case_id,
    c.order_id                                       as order_sn,
    c.status || '/' || coalesce(c.stage, '')         as status_mkt,
    c.reason_id                                      as motivo,
    coalesce(m.nome, c.reason_id)                    as motivo_nome,
    nullif(concat_ws(E'\n', m.detalhe, msg.texto), '') as texto_cliente,
    case c.tipo when 'returns' then 'devolucao' when 'mediations' then 'mediacao' when 'cancel_purchase' then 'cancelamento' else c.tipo end as solucao,
    p.subtotal_produtos                              as valor,
    0                                                as fotos_cliente,
    c.criado_em,
    c.atualizado_em,
    case coalesce(c.acao_obrigatoria, c.acoes_disponiveis->0->>'action')
      when 'send_message_to_mediator'    then 'responder_mediador'
      when 'send_message_to_complainant' then 'responder_comprador'
      when 'recontact'                   then 'responder_comprador'
      when 'refund'                      then 'reembolsar'
      when 'open_dispute'                then 'abrir_disputa'
      when 'return_review_ok'            then 'validar_produto'
      when 'return_review_unified_ok'    then 'validar_produto'
      when 'return_review_fail'          then 'validar_produto'
      when 'return_review_unified_fail'  then 'validar_produto'
      else coalesce(c.acao_obrigatoria, c.acoes_disponiveis->0->>'action', 'acompanhar') end as acao_esperada,
    (jsonb_array_length(c.acoes_disponiveis) > 0 and (c.prazo_acao is null or c.prazo_acao > now() - interval '2 days')) as precisa_acao,
    c.prazo_acao                                     as prazo,
    c.acoes_disponiveis                              as acoes,
    (select coalesce(jsonb_agg(jsonb_build_object('sku', pi.sku_pai, 'nome', pi.nome_produto, 'qtd', pi.quantidade, 'preco', case when pi.quantidade > 0 then round(pi.subtotal_produto / pi.quantidade, 2) end)), '[]'::jsonb)
       from pedido_itens pi where pi.pedido_id = c.order_id) as itens,
    null::text                                       as logistica_reversa,
    e.tracking                                       as rastreio_volta,
    null::timestamptz                                as volta_entregue_em
  from ml_claims c
  left join ml_claim_motivos m on m.reason_id = c.reason_id
  left join pedidos p on p.id = c.order_id
  left join lateral (select mm.texto from ml_claim_mensagens mm where mm.claim_id = c.claim_id and mm.de = 'complainant' order by mm.data asc limit 1) msg on true
  left join lateral (select ev.tracking from ml_envio_devolucao ev where ev.claim_id = c.claim_id and ev.encontrado order by ev.atualizado_em desc limit 1) e on true
  where (c.status = 'opened' and c.atualizado_em >= now() - interval '90 days')
     or (jsonb_array_length(c.acoes_disponiveis) > 0 and (c.prazo_acao is null or c.prazo_acao > now() - interval '2 days'))
),
u as (select * from shopee union all select * from ml)
select
  u.*,
  (u.itens->0->>'sku')                                    as sku,
  (u.itens->0->>'nome')                                   as nome_produto,
  f.foto,
  pt.numero_pedido                                        as tiny_numero,
  pt.tiny_pedido_id,
  pt.situacao                                             as tiny_situacao,
  r.recebido_em                                           as entrada_em,
  r.itens_problema                                        as entrada_problemas,
  r.causa_interna                                         as entrada_causa,
  r.separador,
  resp.ultima_em                                          as respondido_em,
  resp.acao                                               as respondido_acao,
  resp.causa_interna                                      as respondido_causa,
  coalesce(resp.causa_interna, r.causa_interna)           as causa_interna,
  devolucao_causa_provavel(u.marketplace, u.motivo_nome)  as causa_provavel,
  case when u.prazo is null then null
       when u.prazo < now() then 'vencido'
       when (u.prazo at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date then 'hoje'
       when (u.prazo at time zone 'America/Sao_Paulo')::date = (now() at time zone 'America/Sao_Paulo')::date + 1 then 'amanha'
       else 'depois' end                                  as urgencia
from u
left join lateral (select vf.foto from view_foto_produto vf where vf.sku = (u.itens->0->>'sku') limit 1) f on true
left join lateral (
  select pt.numero_pedido, pt.tiny_pedido_id, pt.situacao
  from pedidos_tiny pt
  where pt.numero_ecommerce = u.order_sn
     or (u.marketplace = 'mercadolivre' and pt.numero_ecommerce = (select p2.pack_id from pedidos p2 where p2.id = u.order_sn))
  order by pt.data_pedido desc limit 1) pt on true
left join lateral (
  select dr.recebido_em, dr.causa_interna, dr.separador,
         (select coalesce(jsonb_agg(jsonb_build_object('sku', i.sku, 'estado', i.estado, 'obs', i.observacao, 'qtd_esperada', i.qtd_esperada, 'qtd_recebida', i.qtd_recebida)), '[]'::jsonb)
            from devolucao_recebida_itens i
           where i.devolucao_id = dr.id and (coalesce(i.estado,'ok') <> 'ok' or (i.qtd_recebida is not null and i.qtd_esperada is not null and i.qtd_recebida <> i.qtd_esperada))) as itens_problema
  from devolucoes_recebidas dr where dr.order_sn = u.order_sn order by dr.recebido_em desc limit 1) r on true
left join lateral (
  select max(x.respondido_em) as ultima_em,
         (array_agg(x.acao order by x.respondido_em desc))[1] as acao,
         (array_agg(x.causa_interna order by x.respondido_em desc) filter (where x.causa_interna is not null))[1] as causa_interna
  from devolucao_resposta x where x.marketplace = u.marketplace and x.case_id = u.case_id) resp on true;

-- ---------------------------------------------------------------------------
-- 6. Painel do caso em uma chamada
-- ---------------------------------------------------------------------------
create or replace function public.devolucao_caso(p_marketplace text, p_case_id text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_caso jsonb; v_order text; v_out jsonb;
begin
  if not tem_modulo('devolucoes') and not tem_modulo('financeiro') and not tem_modulo('galpao') then
    raise exception 'sem acesso' using errcode = '42501';
  end if;
  select to_jsonb(v) into v_caso from view_devolucoes_pede_resposta v
   where v.marketplace = p_marketplace and v.case_id = p_case_id;
  -- caso que já saiu da fila: monta o mínimo pelo espelho
  if v_caso is null and p_marketplace = 'shopee' then
    select to_jsonb(d) into v_caso from shopee_devolucoes d where d.return_sn = p_case_id;
  elsif v_caso is null and p_marketplace = 'mercadolivre' then
    select to_jsonb(c) into v_caso from ml_claims c where c.claim_id::text = p_case_id;
  end if;
  if v_caso is null then return jsonb_build_object('erro', 'caso não encontrado'); end if;
  v_order := coalesce(v_caso->>'order_sn', v_caso->>'order_id');

  v_out := jsonb_build_object(
    'caso', v_caso,
    'itens', (
      select coalesce(jsonb_agg(jsonb_build_object('sku', i.sku, 'nome', i.nome, 'qtd', i.qtd, 'preco', i.preco, 'foto', vf.foto)), '[]'::jsonb)
      from jsonb_to_recordset(coalesce(v_caso->'itens', '[]'::jsonb)) as i(sku text, nome text, qtd numeric, preco numeric)
      left join lateral (select foto from view_foto_produto where sku = i.sku limit 1) vf on true),
    'pedido', (select to_jsonb(x) from (
      select p.id, p.shop_id, p.status_pedido, p.data_pedido, p.subtotal_produtos, p.recebido_estimado, p.uf, p.cidade, p.opcao_envio, p.logistica_tipo, p.motivo_cancelamento, p.pack_id, p.marketplace
      from pedidos p where p.id = v_order) x),
    'tiny', (select to_jsonb(x) from (
      select pt.tiny_pedido_id, pt.numero_pedido, pt.situacao, pt.codigo_rastreamento, pt.forma_envio, pt.transportadora, pt.numero_nota_fiscal, pt.serie_nfe, pt.data_emissao_nfe, pt.cliente_nome, pt.cliente_uf, pt.cliente_cidade, pt.data_envio, pt.data_entrega
      from pedidos_tiny pt
      where pt.numero_ecommerce = v_order
         or pt.numero_ecommerce = (select pack_id from pedidos where id = v_order)
      order by pt.data_pedido desc limit 1) x),
    'entrada', (select to_jsonb(x) from (
      select dr.id, dr.recebido_em, dr.recebido_por, dr.status, dr.conferido_ok, dr.observacao, dr.causa_interna, dr.separador,
             (select coalesce(jsonb_agg(to_jsonb(i) order by i.criado_em), '[]'::jsonb) from devolucao_recebida_itens i where i.devolucao_id = dr.id) as itens
      from devolucoes_recebidas dr where dr.order_sn = v_order order by dr.recebido_em desc limit 1) x),
    'separador', devolucao_separador(v_order),
    'respostas', (select coalesce(jsonb_agg(to_jsonb(x) order by x.respondido_em desc), '[]'::jsonb) from (
      select r.id, r.acao, r.texto_resposta, r.causa_interna, r.respondido_por, r.respondido_em, r.ok, r.resultado, r.sugestao_usada, r.case_id
      from devolucao_resposta r where r.order_sn = v_order or (r.marketplace = p_marketplace and r.case_id = p_case_id)) x)
  );

  if p_marketplace = 'shopee' then
    v_out := v_out || jsonb_build_object(
      'shopee', (select to_jsonb(x) from (
        select d.return_sn, d.status, d.reason, d.text_reason, d.images, d.tem_video, d.refund_amount, d.solucao, d.tipo_reembolso, d.needs_logistics,
               d.tracking_number, d.due_date, d.prazo_disputa, d.prazo_vendedor, d.volta_entregue_em, d.compensacao_status, d.compensacao_valor,
               d.frete_responsavel, d.frete_resp_motivo, d.logistica_reversa, d.logistica_status, d.negociacao_status, d.prova_status, d.validacao,
               d.disputa_motivo, d.disputa_texto, d.ida_status, d.ida_ultimo_evento, d.ida_ultimo_em, d.ida_entregue_em, d.ida_devolvido_em, d.ida_falha_em,
               d.esc_escrow, d.esc_reembolso_vendedor, d.esc_frete_reverso, d.create_time, d.update_time
        from shopee_devolucoes d where d.return_sn = p_case_id) x),
      'reembolso', (select to_jsonb(x) from (
        select vr.classe, vr.valor_reembolsado, vr.descontado_vendedor, vr.compensado, vr.cmv, vr.teve_disputa
        from view_shopee_reembolsos vr where vr.order_sn = v_order and (vr.return_sn = p_case_id or vr.return_sn is null) limit 1) x),
      'outras_do_pedido', (select coalesce(jsonb_agg(jsonb_build_object('return_sn', d2.return_sn, 'status', d2.status, 'reason', d2.reason, 'create_time', d2.create_time)), '[]'::jsonb)
        from shopee_devolucoes d2 where d2.order_sn = v_order and d2.return_sn <> p_case_id));
  else
    v_out := v_out || jsonb_build_object(
      'ml', (select to_jsonb(x) from (
        select c.*, m.nome as motivo_nome, m.detalhe as motivo_detalhe from ml_claims c left join ml_claim_motivos m on m.reason_id = c.reason_id where c.claim_id::text = p_case_id) x),
      'mensagens', (select coalesce(jsonb_agg(jsonb_build_object('hash', mm.hash, 'de', mm.de, 'para', mm.para, 'texto', mm.texto, 'anexos', mm.anexos, 'data', mm.data, 'stage', mm.stage) order by mm.data), '[]'::jsonb)
        from ml_claim_mensagens mm where mm.claim_id::text = p_case_id),
      'envio_devolucao', (select coalesce(jsonb_agg(to_jsonb(ev)), '[]'::jsonb) from ml_envio_devolucao ev where ev.claim_id::text = p_case_id or ev.order_id = v_order));
  end if;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 7. Sugestões: respostas anteriores parecidas + modelos
-- ---------------------------------------------------------------------------
create or replace function public.devolucao_sugestoes(
  p_marketplace text, p_motivo text, p_causa text, p_acao text, p_texto text, p_n int default 5)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  with hist as (
    select r.id, r.texto_resposta, r.acao, r.causa_interna, r.motivo_mkt, r.respondido_em, r.respondido_por, r.resultado, r.texto_cliente, r.order_sn,
           (case when r.motivo_mkt = p_motivo then 3 else 0 end)
         + (case when r.causa_interna = p_causa then 2 else 0 end)
         + (case when r.acao = p_acao then 1 else 0 end)
         + (case when r.marketplace = p_marketplace then 1 else 0 end)
         + (case when r.resultado in ('reembolso_aprovado','disputa_ganha','oferta_aceita','encerrado_favoravel') then 1 else 0 end)
         + coalesce(similarity(coalesce(r.texto_cliente,''), coalesce(p_texto,'')), 0) * 3 as score
    from devolucao_resposta r
    where r.texto_resposta is not null and length(r.texto_resposta) > 10 and coalesce(r.ok, true)
      and (r.marketplace = p_marketplace or p_marketplace is null)
    order by score desc, r.respondido_em desc
    limit greatest(p_n, 1) * 4
  ),
  agrupado as (
    -- o mesmo texto repetido conta uma vez, com quantas vezes foi usado
    select min(t.id) as id, t.texto_resposta, (array_agg(t.acao))[1] acao, (array_agg(t.causa_interna))[1] causa_interna,
           count(*) as vezes, max(t.respondido_em) as ultima_em, max(t.score) as score,
           (array_agg(t.order_sn order by t.respondido_em desc))[1] as ultimo_pedido
    from (select h.* from hist h
          union all
          select r.id, r.texto_resposta, r.acao, r.causa_interna, r.motivo_mkt, r.respondido_em, r.respondido_por, r.resultado, r.texto_cliente, r.order_sn, 0
          from devolucao_resposta r where r.texto_resposta in (select texto_resposta from hist) and r.id not in (select id from hist)) t
    group by t.texto_resposta
    order by score desc, vezes desc
    limit greatest(p_n, 1)
  )
  select jsonb_build_object(
    'historico', (select coalesce(jsonb_agg(to_jsonb(a) order by a.score desc, a.vezes desc), '[]'::jsonb) from agrupado a),
    'modelos', (select coalesce(jsonb_agg(to_jsonb(m) order by m.usos desc, m.nome), '[]'::jsonb)
                  from devolucao_resposta_modelo m
                 where m.ativo and (m.marketplace is null or m.marketplace = p_marketplace)
                   and (m.causa_interna is null or m.causa_interna = p_causa or p_causa is null)
                   and (m.acao is null or m.acao = p_acao or p_acao is null)),
    'total_respostas', (select count(*) from devolucao_resposta where texto_resposta is not null));
$$;

-- ---------------------------------------------------------------------------
-- 8. Acesso: tudo só para quem está logado (nunca anon). Escrita do espelho
--    do ML = service_role (edge fn); histórico/modelos o app também grava
--    (mesma política das tabelas irmãs de devolução).
-- ---------------------------------------------------------------------------
alter table public.ml_claims                 enable row level security;
alter table public.ml_claim_mensagens        enable row level security;
alter table public.ml_claim_motivos          enable row level security;
alter table public.devolucao_resposta        enable row level security;
alter table public.devolucao_resposta_modelo enable row level security;
alter table public.devolucao_causa           enable row level security;

drop policy if exists app_le on public.ml_claims;                     create policy app_le on public.ml_claims for select to authenticated using (true);
drop policy if exists app_marca_lida on public.ml_claims;             create policy app_marca_lida on public.ml_claims for update to authenticated using (true) with check (true);
drop policy if exists app_le on public.ml_claim_mensagens;            create policy app_le on public.ml_claim_mensagens for select to authenticated using (true);
drop policy if exists app_le on public.ml_claim_motivos;              create policy app_le on public.ml_claim_motivos for select to authenticated using (true);
drop policy if exists app_logado on public.devolucao_resposta;        create policy app_logado on public.devolucao_resposta for all to authenticated using (true) with check (true);
drop policy if exists app_logado on public.devolucao_resposta_modelo; create policy app_logado on public.devolucao_resposta_modelo for all to authenticated using (true) with check (true);
drop policy if exists app_le on public.devolucao_causa;               create policy app_le on public.devolucao_causa for select to authenticated using (true);

revoke all on public.ml_claims, public.ml_claim_mensagens, public.ml_claim_motivos, public.devolucao_resposta, public.devolucao_resposta_modelo, public.devolucao_causa, public.view_devolucoes_pede_resposta from anon, public;
grant select on public.ml_claims, public.ml_claim_mensagens, public.ml_claim_motivos, public.devolucao_causa, public.view_devolucoes_pede_resposta to authenticated;
grant update (mensagens_lidas_em) on public.ml_claims to authenticated;
grant select, insert, update, delete on public.devolucao_resposta, public.devolucao_resposta_modelo to authenticated;
grant usage, select on sequence public.devolucao_resposta_id_seq, public.devolucao_resposta_modelo_id_seq to authenticated;
grant all on public.ml_claims, public.ml_claim_mensagens, public.ml_claim_motivos, public.devolucao_resposta, public.devolucao_resposta_modelo, public.devolucao_causa to service_role;
grant select on public.view_devolucoes_pede_resposta to service_role;

revoke all on function public.devolucao_caso(text, text) from public, anon;
revoke all on function public.devolucao_sugestoes(text, text, text, text, text, int) from public, anon;
revoke all on function public.devolucao_separador(text) from public, anon;
revoke all on function public.devolucao_causa_provavel(text, text) from public, anon;
grant execute on function public.devolucao_caso(text, text) to authenticated, service_role;
grant execute on function public.devolucao_sugestoes(text, text, text, text, text, int) to authenticated, service_role;
grant execute on function public.devolucao_separador(text) to authenticated, service_role;
grant execute on function public.devolucao_causa_provavel(text, text) to authenticated, service_role;

-- Cron: espelho das reclamacoes do ML a cada 20 min, fora do minuto cheio.
-- select cron.schedule('ml-claims-sync', '9,29,49 * * * *', <http_get ml-devolucao-lookup?modulo=claims&dias=2 com Bearer publicavel>);

-- ============================================================================
-- ROLLBACK (na ordem inversa; não apaga pg_trgm)
-- ============================================================================
-- select cron.unschedule('ml-claims-sync');
-- drop function if exists public.devolucao_sugestoes(text, text, text, text, text, int);
-- drop function if exists public.devolucao_caso(text, text);
-- drop view if exists public.view_devolucoes_pede_resposta;
-- drop trigger if exists trg_devolucoes_recebidas_separador on public.devolucoes_recebidas;
-- drop function if exists public.trg_devolucoes_recebidas_separador();
-- drop function if exists public.devolucao_separador(text);
-- alter table public.devolucoes_recebidas drop column if exists separador, drop column if exists causa_interna;
-- drop table if exists public.devolucao_resposta_modelo;
-- drop table if exists public.devolucao_resposta;
-- drop table if exists public.ml_claim_mensagens;
-- drop table if exists public.ml_claims;
-- drop table if exists public.ml_claim_motivos;
-- drop function if exists public.devolucao_causa_provavel(text, text);
-- drop table if exists public.devolucao_causa;
