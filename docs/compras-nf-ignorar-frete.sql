-- NF de entrada de FRETE (CT-e da logística dos marketplaces) marcadas como ignoradas (12/nov/2026, pedido do dono).
-- SHPS/SHPX (Shopee), TikTok Logistics e nota sem fornecedor abaixo de R$ 100 = "Serviço CTe" de R$ 2–15 cada (~9,3 mil
-- notas desde set/26). A compras-sync só aplica a regra própria (EBAZAR/ML/SHOPEE/pessoa física) ao INSERIR e não casava
-- "SHPS"; o gatilho abaixo completa a regra sem redeployar a função (o upsert dela não mexe em `ignorar`).
-- Migração aplicada: compras_nf_ignorar_frete_cte.
create or replace function public.compras_nf_eh_frete(p_nome text, p_valor numeric) returns boolean
language sql immutable as $$
  select coalesce(p_nome, '') ~* '^\s*(SHPS TECNOLOGIA|SHPX LOGISTICA|TIKTOK LOGISTICS)'
      or (btrim(coalesce(p_nome, '')) = '' and coalesce(p_valor, 0) < 100)
$$;
create or replace function public.compras_nf_marca_frete() returns trigger language plpgsql as $$
begin
  if public.compras_nf_eh_frete(new.fornecedor_nome, new.valor) then new.ignorar := true; end if;
  return new;
end $$;
create trigger trg_compras_nf_marca_frete before insert on public.compras_nf_entrada
  for each row execute function public.compras_nf_marca_frete();
update public.compras_nf_entrada set ignorar = true where not coalesce(ignorar, false) and public.compras_nf_eh_frete(fornecedor_nome, valor);
-- Rollback: drop trigger trg_compras_nf_marca_frete on public.compras_nf_entrada; drop function public.compras_nf_marca_frete();
--   update public.compras_nf_entrada set ignorar = false where public.compras_nf_eh_frete(fornecedor_nome, valor);
--   drop function public.compras_nf_eh_frete(text, numeric);
