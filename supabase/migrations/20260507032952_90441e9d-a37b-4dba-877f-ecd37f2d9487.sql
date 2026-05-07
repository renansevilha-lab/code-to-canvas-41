alter view view_cmv_efetivo set (security_invoker = true);
alter view view_conciliacao set (security_invoker = true);
alter view view_cmv_pedido set (security_invoker = true);

create or replace function set_atualizado_em()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;