-- Bônus / mão de obra por saco na ordem de produção (11/nov/2026, pedido do dono).
-- producao_op.bonus_saco = R$ pagos por saco produzido naquela ordem. Só quem tem o módulo 'todos' (o dono) grava o
-- bônus e edita a ordem (produto, quantidade, prazo, prioridade, observações, embalagem); quem tem só 'galpao' continua
-- criando ordem (sem bônus) e concluindo/cancelando. Regra no banco (gatilho), não só na tela.
-- Migração aplicada: producao_op_bonus_saco.

alter table public.producao_op
  add column if not exists bonus_saco numeric(10,4) check (bonus_saco is null or bonus_saco >= 0),
  add column if not exists editado_em timestamptz,
  add column if not exists editado_por text;

create or replace function public.producao_op_guarda_edicao() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.tem_modulo('todos') then
    return new;  -- service role / cron / dono
  end if;
  if tg_op = 'INSERT' then
    if new.bonus_saco is not null then
      raise exception 'Só o administrador define o bônus por saco da ordem.';
    end if;
    return new;
  end if;
  if new.bonus_saco is distinct from old.bonus_saco
     or new.sku is distinct from old.sku or new.qtd is distinct from old.qtd
     or new.prazo is distinct from old.prazo or new.prioridade is distinct from old.prioridade
     or new.obs is distinct from old.obs or new.embalagem_id is distinct from old.embalagem_id then
    raise exception 'Só o administrador edita a ordem de produção.';
  end if;
  return new;
end $$;

drop trigger if exists trg_producao_op_guarda on public.producao_op;
create trigger trg_producao_op_guarda before insert or update on public.producao_op
  for each row execute function public.producao_op_guarda_edicao();

create or replace view public.view_producao_op as
 SELECT o.id, o.sku, pr.nome AS produto, o.qtd, o.prazo, o.prioridade, o.obs, o.status, o.criado_por, o.criado_em,
    o.fechada_em, o.fechada_por, o.motivo,
    COALESCE(l.produzido, 0::bigint)::integer AS produzido,
    GREATEST(o.qtd - COALESCE(l.produzido, 0::bigint), 0::bigint)::integer AS falta,
    COALESCE(l.envasando, 0::bigint)::integer AS envasando,
    COALESCE(l.lotes, 0::bigint)::integer AS lotes,
    l.lote_aberto_id,
        CASE
            WHEN o.status <> 'aberta'::text THEN o.status
            WHEN l.lote_aberto_id IS NOT NULL THEN 'em_producao'::text
            WHEN COALESCE(l.produzido, 0::bigint) >= o.qtd THEN 'atingida'::text
            ELSE 'aberta'::text
        END AS situacao,
    o.status = 'aberta'::text AND o.prazo IS NOT NULL AND o.prazo < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS atrasada,
    o.embalagem_id, em.nome AS embalagem,
    o.bonus_saco,
    round(o.bonus_saco * COALESCE(l.produzido, 0::bigint), 2) AS bonus_total,
    o.editado_em, o.editado_por
   FROM producao_op o
     LEFT JOIN produtos pr ON pr.sku = o.sku
     LEFT JOIN producao_insumo em ON em.id = o.embalagem_id
     LEFT JOIN LATERAL ( SELECT sum(v.boas) FILTER (WHERE v.status = 'encerrada'::text) AS produzido,
            sum(v.envasados) FILTER (WHERE v.status = 'aberta'::text) AS envasando,
            count(*) FILTER (WHERE v.status <> 'cancelada'::text) AS lotes,
            max(v.id) FILTER (WHERE v.status = 'aberta'::text) AS lote_aberto_id
           FROM producao_ordem po
             JOIN view_producao_lote v ON v.id = po.id
          WHERE po.op_id = o.id) l ON true;

-- Rollback:
-- drop trigger if exists trg_producao_op_guarda on public.producao_op; drop function if exists public.producao_op_guarda_edicao();
-- recriar a view sem as 4 colunas do fim (drop view + create, o create or replace não tira coluna);
-- alter table public.producao_op drop column bonus_saco, drop column editado_em, drop column editado_por;
