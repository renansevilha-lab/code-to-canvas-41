-- Extensões
create extension if not exists "uuid-ossp";

-- Lojas
create table if not exists lojas (
  id           bigint generated always as identity primary key,
  shop_id      bigint unique not null,
  nome         text not null,
  cnpj         text,
  ativa        boolean default true,
  criada_em    timestamptz default now()
);

-- OAuth tokens da Shopee
create table if not exists oauth_tokens_shopee (
  shop_id        bigint primary key references lojas(shop_id) on delete cascade,
  partner_id     bigint not null,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  refresh_expires_at timestamptz not null,
  atualizado_em  timestamptz default now()
);

-- Pedidos
create table if not exists pedidos (
  id                       text primary key,
  shop_id                  bigint references lojas(shop_id),
  status_pedido            text not null,
  data_pedido              timestamptz not null,
  data_pagamento_shopee    timestamptz,
  primeiro_produto         text,
  subtotal_produtos        numeric(12,2) default 0,
  subtotal_bruto           numeric(12,2) default 0,
  ajuste_acao_comercial    numeric(12,2) default 0,
  comissao_afiliados       numeric(12,2) default 0,
  taxa_comissao            numeric(12,2) default 0,
  taxa_servico             numeric(12,2) default 0,
  taxa_transacao           numeric(12,2) default 0,
  imposto_estimado         numeric(12,2) default 0,
  recebido_estimado        numeric(12,2) default 0,
  renda_estimada           numeric(12,2) default 0,
  uf                       text,
  cidade                   text,
  opcao_envio              text,
  motivo_cancelamento      text,
  valido                   boolean default true,
  fonte                    text default 'api',
  criado_em                timestamptz default now(),
  atualizado_em            timestamptz default now()
);
create index if not exists idx_pedidos_data on pedidos (data_pedido desc);
create index if not exists idx_pedidos_status on pedidos (status_pedido);
create index if not exists idx_pedidos_valido on pedidos (valido);
create index if not exists idx_pedidos_shop on pedidos (shop_id);

-- Itens
create table if not exists pedido_itens (
  id                  bigint generated always as identity primary key,
  pedido_id           text references pedidos(id) on delete cascade,
  sku_pai             text,
  sku_filho           text,
  nome_produto        text,
  quantidade          numeric(10,3) default 0,
  subtotal_produto    numeric(12,2) default 0
);
create index if not exists idx_itens_pedido on pedido_itens (pedido_id);
create index if not exists idx_itens_sku on pedido_itens (sku_filho, sku_pai);

-- Transações da carteira
create table if not exists transacoes_carteira (
  id                       bigint generated always as identity primary key,
  shop_id                  bigint references lojas(shop_id),
  shopee_transaction_id    text unique,
  data                     timestamptz not null,
  tipo                     text not null,
  classificacao            text not null,
  descricao                text,
  pedido_id                text references pedidos(id) on delete set null,
  direcao                  text not null check (direcao in ('Entrada', 'Saída')),
  valor                    numeric(12,2) not null,
  status                   text,
  saldo_apos               numeric(14,2),
  fonte                    text default 'api',
  criado_em                timestamptz default now()
);
create index if not exists idx_trans_data on transacoes_carteira (data desc);
create index if not exists idx_trans_pedido on transacoes_carteira (pedido_id);
create index if not exists idx_trans_classif on transacoes_carteira (classificacao);
create index if not exists idx_trans_tipo on transacoes_carteira (tipo);

-- Produtos
create table if not exists produtos (
  sku               text primary key,
  shop_id           bigint references lojas(shop_id),
  nome              text,
  categoria         text,
  preco             numeric(12,2),
  estoque           integer,
  ativo             boolean default true,
  atualizado_em     timestamptz default now()
);

-- CMV
create table if not exists cmv_skus (
  sku               text primary key,
  custo             numeric(12,2) not null,
  fonte             text default 'tiny',
  atualizado_em     timestamptz default now()
);

-- Kits
create table if not exists kits_composicao (
  id               bigint generated always as identity primary key,
  sku_kit          text not null,
  sku_componente   text not null,
  quantidade       numeric(10,3) not null,
  nome_kit         text,
  nome_componente  text,
  atualizado_em    timestamptz default now(),
  unique(sku_kit, sku_componente)
);
create index if not exists idx_kits_kit on kits_composicao (sku_kit);
create index if not exists idx_kits_comp on kits_composicao (sku_componente);

-- ADS diário
create table if not exists ads_diario (
  id                  bigint generated always as identity primary key,
  shop_id             bigint references lojas(shop_id),
  data                date not null,
  sku                 text,
  gasto               numeric(12,2) default 0,
  cliques             integer default 0,
  impressoes          integer default 0,
  conversoes          integer default 0,
  conversoes_diretas  integer default 0,
  itens_vendidos      integer default 0,
  gmv                 numeric(12,2) default 0,
  receita_direta      numeric(12,2) default 0,
  ctr                 numeric(8,4) default 0,
  roas                numeric(8,2) default 0,
  acos                numeric(8,2) default 0,
  cpc                 numeric(8,2) default 0,
  unique(shop_id, data, sku)
);
create index if not exists idx_ads_data on ads_diario (data desc);
create index if not exists idx_ads_sku on ads_diario (sku);

-- Imports log
create table if not exists imports_log (
  id              bigint generated always as identity primary key,
  tipo            text not null,
  arquivo         text,
  qtd_registros   integer default 0,
  qtd_erros       integer default 0,
  status          text default 'sucesso',
  detalhes        jsonb,
  iniciado_em     timestamptz default now(),
  finalizado_em   timestamptz
);

-- Views
create or replace view view_cmv_efetivo as
select c.sku, c.custo as cmv_efetivo, 'simples'::text as tipo, null::text as detalhes
from cmv_skus c
where c.sku not in (select distinct sku_kit from kits_composicao)
union all
select k.sku_kit as sku,
  round(sum(k.quantidade * coalesce(c.custo, 0))::numeric, 2) as cmv_efetivo,
  'kit'::text as tipo,
  string_agg(k.sku_componente || ' x' || k.quantidade || ' (R$' || coalesce(c.custo, 0) || ')', ' + ') as detalhes
from kits_composicao k
left join cmv_skus c on c.sku = k.sku_componente
group by k.sku_kit
having sum(coalesce(c.custo, 0)) > 0;

create or replace view view_conciliacao as
select
  p.id as pedido_id, p.status_pedido, p.data_pedido, p.primeiro_produto,
  p.subtotal_produtos, p.renda_estimada, p.recebido_estimado, p.uf, p.opcao_envio,
  coalesce((
    select sum(case
      when t.classificacao = 'Renda do pedido' and t.direcao = 'Entrada' then t.valor
      when t.classificacao = 'Ajuste Acelera' then abs(t.valor)
      when t.classificacao = 'Estorno renda' then -abs(t.valor)
      else 0 end)
    from transacoes_carteira t
    where t.pedido_id = p.id and (t.status = 'Transação completa' or t.status is null)
  ), 0) as valor_recebido_shopee,
  exists(select 1 from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Ajuste Acelera') as via_acelera,
  case
    when exists(select 1 from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Estorno renda') then 'Estornado'
    when exists(select 1 from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Ajuste Acelera') then 'Pago via Acelera'
    when exists(select 1 from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Renda do pedido' and t.direcao = 'Entrada') then 'Pago pela Shopee'
    else 'Aguardando pagamento'
  end as status_pagamento,
  (select max(t.data) from transacoes_carteira t where t.pedido_id = p.id and t.classificacao in ('Renda do pedido', 'Ajuste Acelera')) as data_pagamento,
  coalesce((select sum(t.valor) from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Rebate/Incentivo Shopee'), 0) as rebate_carteira,
  coalesce((select sum(abs(t.valor)) from transacoes_carteira t where t.pedido_id = p.id and t.classificacao = 'Comissão Afiliados'), 0) as afiliados_carteira
from pedidos p;

create or replace view view_cmv_pedido as
select
  i.pedido_id,
  round(sum(i.quantidade * coalesce(c.cmv_efetivo, 0))::numeric, 2) as cmv_total,
  count(*) filter (where c.cmv_efetivo is null or c.cmv_efetivo = 0) as itens_sem_cmv,
  count(*) as total_itens
from pedido_itens i
left join view_cmv_efetivo c on c.sku in (i.sku_filho, i.sku_pai)
group by i.pedido_id;

-- RLS
alter table lojas              enable row level security;
alter table oauth_tokens_shopee enable row level security;
alter table pedidos            enable row level security;
alter table pedido_itens       enable row level security;
alter table transacoes_carteira enable row level security;
alter table produtos           enable row level security;
alter table cmv_skus           enable row level security;
alter table kits_composicao    enable row level security;
alter table ads_diario         enable row level security;
alter table imports_log        enable row level security;

create policy "auth users full access" on lojas              for all to authenticated using (true) with check (true);
create policy "auth users full access" on oauth_tokens_shopee for all to authenticated using (true) with check (true);
create policy "auth users full access" on pedidos            for all to authenticated using (true) with check (true);
create policy "auth users full access" on pedido_itens       for all to authenticated using (true) with check (true);
create policy "auth users full access" on transacoes_carteira for all to authenticated using (true) with check (true);
create policy "auth users full access" on produtos           for all to authenticated using (true) with check (true);
create policy "auth users full access" on cmv_skus           for all to authenticated using (true) with check (true);
create policy "auth users full access" on kits_composicao    for all to authenticated using (true) with check (true);
create policy "auth users full access" on ads_diario         for all to authenticated using (true) with check (true);
create policy "auth users full access" on imports_log        for all to authenticated using (true) with check (true);

-- Triggers
create or replace function set_atualizado_em()
returns trigger as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pedidos_atualizado on pedidos;
create trigger trg_pedidos_atualizado     before update on pedidos       for each row execute function set_atualizado_em();
drop trigger if exists trg_oauth_atualizado on oauth_tokens_shopee;
create trigger trg_oauth_atualizado       before update on oauth_tokens_shopee for each row execute function set_atualizado_em();
drop trigger if exists trg_produtos_atualizado on produtos;
create trigger trg_produtos_atualizado    before update on produtos      for each row execute function set_atualizado_em();
drop trigger if exists trg_cmv_atualizado on cmv_skus;
create trigger trg_cmv_atualizado         before update on cmv_skus      for each row execute function set_atualizado_em();
drop trigger if exists trg_kits_atualizado on kits_composicao;
create trigger trg_kits_atualizado        before update on kits_composicao for each row execute function set_atualizado_em();

-- Loja inicial
insert into lojas (shop_id, nome, cnpj, ativa) values (0, 'ACZ Pet', '37393638000140', true)
on conflict (shop_id) do nothing;