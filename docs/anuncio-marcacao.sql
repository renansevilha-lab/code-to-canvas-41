-- Marcação de anúncios para teste A/B (13/nov/2026, pedido do dono — teste "Areia Ottz Pet Mandioca - nov/2026").
-- O painel SÓ marca e confere: nada aqui escreve na Shopee. Cada anúncio do teste ganha braço, estratégia,
-- instrução e uma lista de tarefas; as tarefas com confere_auto são marcadas sozinhas quando o valor real
-- (espelho do catálogo Shopee + ads_config_atual) bate com o planejado. Tela: /ads-shopee (painel "Testes A/B",
-- etiqueta na linha do anúncio, bloco "O que fazer" na análise do anúncio).
-- Migração aplicada: anuncio_marcacao.
--
-- Formato de cada tarefa (jsonb): {id, texto, feito, feito_em, feito_por, confere_auto,
--   campo: preco | roas | status_campanha | titulo | null (manual), campanha, sku, de, para}
--   preco  = preço atual do anúncio (sem variação: shopee_anuncios.preco_min; com sku: a variação desse SKU)
--   roas   = ads_config_atual.roas_target da campanha
--   status_campanha = ads_config_atual.status da campanha ('paused' também aceita 'ended'/'closed')
--   titulo = shopee_anuncios.nome (sem diferença de maiúsculas e espaços)

create table if not exists public.anuncio_marcacao (
  id bigint generated always as identity primary key,
  marketplace text not null default 'shopee',
  shop_id bigint not null,
  item_id text,                       -- nulo = anúncio ainda não criado
  teste text not null,
  braco text not null,
  rotulo text,                        -- ex.: "kit 2x4kg", "variações 4 a 16kg"
  estrategia text not null,           -- vira a etiqueta
  instrucao text,
  tarefas jsonb not null default '[]'::jsonb,
  preco_planejado jsonb,              -- por variação/SKU
  roas_alvo_planejado numeric,
  ads_ligado boolean,
  titulo_planejado text,
  regra_parada text,
  data_leitura date,
  status text not null default 'pendente' check (status in ('pendente','em_andamento','aplicado','nao_mexer')),
  aplicado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);
create unique index if not exists anuncio_marcacao_uniq on public.anuncio_marcacao (teste, shop_id, item_id) where item_id is not null;
create index if not exists anuncio_marcacao_item on public.anuncio_marcacao (shop_id, item_id);

alter table public.anuncio_marcacao enable row level security;
drop policy if exists ler on public.anuncio_marcacao;
drop policy if exists criar on public.anuncio_marcacao;
drop policy if exists alterar on public.anuncio_marcacao;
drop policy if exists apagar on public.anuncio_marcacao;
create policy ler on public.anuncio_marcacao for select to authenticated using (public.tem_modulo('ads'));
create policy criar on public.anuncio_marcacao for insert to authenticated with check (public.tem_modulo('ads'));
create policy alterar on public.anuncio_marcacao for update to authenticated using (public.tem_modulo('ads')) with check (public.tem_modulo('ads'));
create policy apagar on public.anuncio_marcacao for delete to authenticated using (public.tem_modulo('ads'));
revoke all on public.anuncio_marcacao from anon, public;
grant select, insert, update, delete on public.anuncio_marcacao to authenticated;
grant all on public.anuncio_marcacao to service_role;

-- status segue as tarefas (menos "não mexer"): todas feitas = aplicado (grava a data); alguma = em andamento
create or replace function public.anuncio_marcacao_status() returns trigger
language plpgsql set search_path = public as $$
declare n int; f int;
begin
  new.atualizado_em := now();
  if new.status = 'nao_mexer' then return new; end if;
  select count(*), count(*) filter (where coalesce((t->>'feito')::boolean, false))
    into n, f from jsonb_array_elements(coalesce(new.tarefas, '[]'::jsonb)) t;
  if n > 0 and f = n then
    new.status := 'aplicado'; new.aplicado_em := coalesce(new.aplicado_em, now());
  elsif f > 0 then
    new.status := 'em_andamento'; new.aplicado_em := null;
  else
    new.status := 'pendente'; new.aplicado_em := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_anuncio_marcacao_status on public.anuncio_marcacao;
create trigger trg_anuncio_marcacao_status before insert or update on public.anuncio_marcacao
  for each row execute function public.anuncio_marcacao_status();

-- valor real de uma tarefa e se bate com o planejado
create or replace function public.anuncio_marcacao_tarefa_atual(p_shop bigint, p_item text, p_t jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare v_atual text; v_bate boolean := false; v_num numeric; v_em timestamptz;
begin
  if p_t->>'campo' = 'preco' and p_item is not null then
    if coalesce(p_t->>'sku', '') <> '' then
      select v.preco, v.atualizado_em into v_num, v_em from shopee_anuncios_variacao v
       where v.shop_id = p_shop and v.item_id = p_item::bigint and v.sku = p_t->>'sku' limit 1;
    else
      select a.preco_min, a.atualizado_em into v_num, v_em from shopee_anuncios a
       where a.shop_id = p_shop and a.item_id = p_item::bigint;
    end if;
    v_atual := v_num::text;
    v_bate := v_num is not null and abs(v_num - (p_t->>'para')::numeric) < 0.005;
  elsif p_t->>'campo' in ('roas', 'status_campanha') then
    select case when p_t->>'campo' = 'roas' then c.roas_target::text else c.status end, c.visto_em
      into v_atual, v_em
      from ads_config_atual c where c.mkt = 'shopee' and c.shop_id = p_shop and c.campaign_id = p_t->>'campanha';
    if p_t->>'campo' = 'roas' then
      v_bate := v_atual is not null and abs(v_atual::numeric - (p_t->>'para')::numeric) < 0.05;
    else
      v_bate := v_atual is not null and (v_atual = p_t->>'para'
                or (p_t->>'para' = 'paused' and v_atual in ('paused', 'ended', 'closed')));
    end if;
  elsif p_t->>'campo' = 'titulo' and p_item is not null then
    select a.nome, a.atualizado_em into v_atual, v_em from shopee_anuncios a
     where a.shop_id = p_shop and a.item_id = p_item::bigint;
    v_bate := v_atual is not null and lower(regexp_replace(btrim(v_atual), '\s+', ' ', 'g'))
                                     = lower(regexp_replace(btrim(p_t->>'para'), '\s+', ' ', 'g'));
  else
    return jsonb_build_object('atual', null, 'bate', null, 'lido_em', null);
  end if;
  return jsonb_build_object('atual', v_atual, 'bate', v_bate, 'lido_em', v_em);
end $$;

create or replace view public.view_anuncio_marcacao with (security_invoker = true) as
select m.*,
  a.nome as nome_atual, a.imagem_url as foto, a.status as status_anuncio, a.sku_pai, a.atualizado_em as espelho_em,
  case m.shop_id when 522186766 then 'Ottz' when 759046323 then 'Bumi' else m.shop_id::text end as loja,
  coalesce((select jsonb_agg(t || public.anuncio_marcacao_tarefa_atual(m.shop_id, m.item_id, t) order by o)
              from jsonb_array_elements(m.tarefas) with ordinality x(t, o)), '[]'::jsonb) as tarefas_aval,
  jsonb_array_length(m.tarefas) as n_tarefas,
  (select count(*) from jsonb_array_elements(m.tarefas) t where coalesce((t->>'feito')::boolean, false))::int as n_feitas,
  (m.status in ('pendente', 'em_andamento')) as pendente
from public.anuncio_marcacao m
left join public.shopee_anuncios a on a.shop_id = m.shop_id and m.item_id ~ '^\d+$' and a.item_id = m.item_id::bigint;
revoke all on public.view_anuncio_marcacao from anon, public;
grant select on public.view_anuncio_marcacao to authenticated, service_role;

-- marca sozinhas as tarefas automáticas que já batem (cron + botão "Conferir agora")
create or replace function public.anuncio_marcacao_conferir(p_id bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; nova jsonb; t jsonb; av jsonb; mudou boolean; marcadas int := 0;
begin
  if auth.uid() is not null and not public.tem_modulo('ads') then
    raise exception 'sem acesso';
  end if;
  for r in select * from anuncio_marcacao where status in ('pendente', 'em_andamento') and (p_id is null or id = p_id) loop
    nova := '[]'::jsonb; mudou := false;
    for t in select x from jsonb_array_elements(r.tarefas) x loop
      if coalesce((t->>'confere_auto')::boolean, false) and not coalesce((t->>'feito')::boolean, false) then
        av := anuncio_marcacao_tarefa_atual(r.shop_id, r.item_id, t);
        if coalesce((av->>'bate')::boolean, false) then
          t := t || jsonb_build_object('feito', true, 'feito_em', now(), 'feito_por', 'conferência automática');
          mudou := true; marcadas := marcadas + 1;
        end if;
      end if;
      nova := nova || jsonb_build_array(t);
    end loop;
    if mudou then update anuncio_marcacao set tarefas = nova, atualizado_por = 'conferência automática' where id = r.id; end if;
  end loop;
  return jsonb_build_object('marcadas', marcadas);
end $$;
revoke all on function public.anuncio_marcacao_conferir(bigint) from public, anon;
grant execute on function public.anuncio_marcacao_conferir(bigint) to authenticated, service_role;
revoke all on function public.anuncio_marcacao_tarefa_atual(bigint, text, jsonb) from public, anon;
grant execute on function public.anuncio_marcacao_tarefa_atual(bigint, text, jsonb) to authenticated, service_role;

-- cron fora do minuto cheio
select cron.schedule('anuncio-marcacao-conferir', '8,38 * * * *', $$select public.anuncio_marcacao_conferir()$$);

-- ==================== marcações do teste "Areia Ottz Pet Mandioca - nov/2026" ====================
insert into public.anuncio_marcacao (shop_id, item_id, teste, braco, rotulo, estrategia, instrucao, tarefas, preco_planejado,
  roas_alvo_planejado, ads_ligado, titulo_planejado, regra_parada, data_leitura, status, atualizado_por) values
(759046323, '41632450730', 'Areia Ottz Pet Mandioca - nov/2026', 'T1-A', 'kit 2x4kg', 'Preço menor + ROAS 17',
 'Não alterar título, fotos nem descrição.',
 '[{"id":"t1","texto":"Baixar o preço de 65,90 para 63,90","campo":"preco","de":65.9,"para":63.9,"confere_auto":true,"feito":false},
   {"id":"t2","texto":"ROAS alvo 17 na campanha 110855297","campo":"roas","campanha":"110855297","para":17,"confere_auto":true,"feito":false}]',
 '{"16055":63.9}', 17, true, null, null, '2026-11-28', 'pendente', 'importação do teste'),
(522186766, '51013400283', 'Areia Ottz Pet Mandioca - nov/2026', 'T1-B', 'kit 2x4kg', 'Preço maior + ROAS 10',
 'Não alterar título. Próximo degrau, se converter: 74,90.',
 '[{"id":"t1","texto":"Subir o preço de 64,90 para 69,90","campo":"preco","de":64.9,"para":69.9,"confere_auto":true,"feito":false},
   {"id":"t2","texto":"Baixar o ROAS alvo de 13,1 para 10 na campanha 110376031","campo":"roas","campanha":"110376031","de":13.1,"para":10,"confere_auto":true,"feito":false}]',
 '{"16055":69.9}', 10, true, null, '150 cliques com ROAS real abaixo de 6,1: voltar ao preço anterior (64,90).', '2026-11-28', 'pendente', 'importação do teste'),
(522186766, '55713397643', 'Areia Ottz Pet Mandioca - nov/2026', 'T2', 'variações 4 a 16kg', 'Teste de termos (campanha manual)',
 'Não alterar preços nem título.',
 '[{"id":"t1","texto":"Pausar a campanha GMV Max 110376034","campo":"status_campanha","campanha":"110376034","para":"paused","confere_auto":true,"feito":false},
   {"id":"t2","texto":"Criar campanha manual por palavra-chave, correspondência exata, lance 0,60, orçamento 15/dia, 10 dias, com os termos: areia para gato; areia biodegradável gato; areia de gato; areia higiênica para gatos; areia para gato biodegradável; areia de mandioca para gatos; areia para gato milho e mandioca; areia gato mandioca; areia mandioca; areia para gato mandioca","campo":null,"confere_auto":false,"feito":false}]',
 null, null, true, null, null, '2026-11-28', 'pendente', 'importação do teste'),
(759046323, '48963736980', 'Areia Ottz Pet Mandioca - nov/2026', 'T3-A', '4kg', 'Preço agressivo sem ADS (anúncio existente alterado)',
 null,
 '[{"id":"t1","texto":"Baixar o preço de 38,99 para 33,90","campo":"preco","de":38.99,"para":33.9,"confere_auto":true,"feito":false},
   {"id":"t2","texto":"Pausar a campanha 110843494","campo":"status_campanha","campanha":"110843494","para":"paused","confere_auto":true,"feito":false},
   {"id":"t3","texto":"Trocar o título","campo":"titulo","para":"Areia para Gato Biodegradável Mandioca 4kg Ottz Pet Higiênica para Gatos Natural Anti Odor","confere_auto":true,"feito":false},
   {"id":"t4","texto":"Descrição nova","campo":null,"confere_auto":false,"feito":false},
   {"id":"t5","texto":"Capa com o peso e \"100% mandioca\"","campo":null,"confere_auto":false,"feito":false},
   {"id":"t6","texto":"Vídeo","campo":null,"confere_auto":false,"feito":false}]',
 '{"16054":33.9}', null, false, 'Areia para Gato Biodegradável Mandioca 4kg Ottz Pet Higiênica para Gatos Natural Anti Odor', null, '2026-11-28', 'pendente', 'importação do teste'),
(759046323, null, 'Areia Ottz Pet Mandioca - nov/2026', 'T3-B', 'variações 4 a 20kg', 'Preço agressivo sem ADS (anúncio novo do zero)',
 'Não ligar ADS.',
 '[{"id":"t1","texto":"Criar o anúncio com as variações 4kg 33,90 / 8kg 63,90 / 12kg 94,90 / 16kg 124,90 / 20kg 149,90","campo":null,"confere_auto":false,"feito":false},
   {"id":"t2","texto":"Título \"Areia para Gato Biodegradável Mandioca 4kg 8kg 12kg 16kg 20kg Ottz Pet Higiênica Natural Anti Odor\"","campo":null,"confere_auto":false,"feito":false},
   {"id":"t3","texto":"Mesma descrição, capa e vídeo do T3-A","campo":null,"confere_auto":false,"feito":false},
   {"id":"t4","texto":"Colar aqui o ID do anúncio depois de publicar","campo":null,"confere_auto":false,"feito":false}]',
 '{"4kg":33.9,"8kg":63.9,"12kg":94.9,"16kg":124.9,"20kg":149.9}', null, false,
 'Areia para Gato Biodegradável Mandioca 4kg 8kg 12kg 16kg 20kg Ottz Pet Higiênica Natural Anti Odor', null, '2026-11-28', 'pendente', 'importação do teste'),
(759046323, '53713653947', 'Areia Ottz Pet Mandioca - nov/2026', 'CONTROLE', null, 'Controle - não mexer', 'Não alterar preço, título nem campanha até 28/11.', '[]', null, null, null, null, null, '2026-11-28', 'nao_mexer', 'importação do teste'),
(759046323, '49813727245', 'Areia Ottz Pet Mandioca - nov/2026', 'CONTROLE', null, 'Controle - não mexer', 'Não alterar preço, título nem campanha até 28/11.', '[]', null, null, null, null, null, '2026-11-28', 'nao_mexer', 'importação do teste'),
(522186766, '52763388482', 'Areia Ottz Pet Mandioca - nov/2026', 'CONTROLE', null, 'Controle - não mexer', 'Não alterar preço, título nem campanha até 28/11.', '[]', null, null, null, null, null, '2026-11-28', 'nao_mexer', 'importação do teste'),
(522186766, '46713408425', 'Areia Ottz Pet Mandioca - nov/2026', 'CONTROLE', null, 'Controle - não mexer', 'Não alterar preço, título nem campanha até 28/11.', '[]', null, null, null, null, null, '2026-11-28', 'nao_mexer', 'importação do teste');

-- Rollback:
-- select cron.unschedule('anuncio-marcacao-conferir');
-- drop view if exists public.view_anuncio_marcacao;
-- drop function if exists public.anuncio_marcacao_conferir(bigint);
-- drop function if exists public.anuncio_marcacao_tarefa_atual(bigint, text, jsonb);
-- drop table if exists public.anuncio_marcacao;  -- (leva o gatilho junto)
-- drop function if exists public.anuncio_marcacao_status();
