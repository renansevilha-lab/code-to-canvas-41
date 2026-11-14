-- ============================================================================
-- Ordens de produção — ordem de prioridade por arrastar (14/nov/2026, pedido do dono)
-- Migração: producao_op_posicao
--
-- producao_op.posicao = posição na fila (1 = produzir primeiro). A tela lista as ordens abertas
-- por ela e o administrador arrasta para mudar; a nova ordem entra no FIM da fila.
-- Só o administrador (módulo 'todos') muda a posição — mesma regra de editar a ordem
-- (gatilho trg_producao_op_guarda). view_producao_op ganhou a coluna no fim.
-- ============================================================================

alter table public.producao_op add column if not exists posicao integer;

-- ponto de partida = a ordem em que a tela mostrava (mais nova primeiro)
update public.producao_op o set posicao = x.n
from (select id, row_number() over (order by criado_em desc, id desc) n from public.producao_op) x
where x.id = o.id and o.posicao is null;

create or replace function public.producao_op_posicao_padrao()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.posicao is null then
    select coalesce(max(posicao), 0) + 1 into new.posicao from producao_op where status = 'aberta';
  end if;
  return new;
end $$;
drop trigger if exists trg_producao_op_posicao on public.producao_op;
create trigger trg_producao_op_posicao before insert on public.producao_op
  for each row execute function public.producao_op_posicao_padrao();

create or replace function public.producao_op_guarda_edicao()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if auth.uid() is null or public.tem_modulo('todos') then
    return new;
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
     or new.obs is distinct from old.obs or new.embalagem_id is distinct from old.embalagem_id
     or new.posicao is distinct from old.posicao then
    raise exception 'Só o administrador edita a ordem de produção.';
  end if;
  return new;
end $function$;

-- view: mesma definição de antes + posicao no fim
create or replace view public.view_producao_op as
 SELECT o.id, o.sku, pr.nome AS produto, o.qtd, o.prazo, o.prioridade, o.obs, o.status, o.criado_por, o.criado_em,
    o.fechada_em, o.fechada_por, o.motivo,
    (COALESCE(l.produzido, (0)::bigint))::integer AS produzido,
    (GREATEST((o.qtd - COALESCE(l.produzido, (0)::bigint)), (0)::bigint))::integer AS falta,
    (COALESCE(l.envasando, (0)::bigint))::integer AS envasando,
    (COALESCE(l.lotes, (0)::bigint))::integer AS lotes,
    l.lote_aberto_id,
        CASE
            WHEN (o.status <> 'aberta'::text) THEN o.status
            WHEN (l.lote_aberto_id IS NOT NULL) THEN 'em_producao'::text
            WHEN (COALESCE(l.produzido, (0)::bigint) >= o.qtd) THEN 'atingida'::text
            ELSE 'aberta'::text
        END AS situacao,
    ((o.status = 'aberta'::text) AND (o.prazo IS NOT NULL) AND (o.prazo < ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date)) AS atrasada,
    o.embalagem_id, em.nome AS embalagem, o.bonus_saco,
    round((o.bonus_saco * (COALESCE(l.produzido, (0)::bigint))::numeric), 2) AS bonus_total,
    o.editado_em, o.editado_por,
    o.posicao
   FROM (((producao_op o
     LEFT JOIN produtos pr ON ((pr.sku = o.sku)))
     LEFT JOIN producao_insumo em ON ((em.id = o.embalagem_id)))
     LEFT JOIN LATERAL ( SELECT sum(v.boas) FILTER (WHERE (v.status = 'encerrada'::text)) AS produzido,
            sum(v.envasados) FILTER (WHERE (v.status = 'aberta'::text)) AS envasando,
            count(*) FILTER (WHERE (v.status <> 'cancelada'::text)) AS lotes,
            max(v.id) FILTER (WHERE (v.status = 'aberta'::text)) AS lote_aberto_id
           FROM (producao_ordem po
             JOIN view_producao_lote v ON ((v.id = po.id)))
          WHERE (po.op_id = o.id)) l ON (true));

-- grava a fila inteira de uma vez (os ids na ordem nova)
create or replace function public.producao_op_reordenar(p_ids bigint[])
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not tem_modulo('todos') then raise exception 'Só o administrador muda a prioridade das ordens.'; end if;
  update producao_op o set posicao = x.n
  from unnest(p_ids) with ordinality as x(id, n)
  where o.id = x.id and o.posicao is distinct from x.n;
end $$;
revoke all on function public.producao_op_reordenar(bigint[]) from public, anon;
grant execute on function public.producao_op_reordenar(bigint[]) to authenticated, service_role;

-- ROLLBACK:
--   drop function public.producao_op_reordenar(bigint[]);
--   drop trigger trg_producao_op_posicao on public.producao_op; drop function public.producao_op_posicao_padrao();
--   recriar view_producao_op sem "o.posicao" (drop view + create, a coluna saiu do fim) e o guarda sem a linha de posicao;
--   alter table public.producao_op drop column posicao;
