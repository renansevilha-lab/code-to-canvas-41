-- Relatório da equipe da Produção (09/nov/2026, pedido do dono): quem estava em cada lote e quanto cada um produziu.
-- Migrações producao_relatorio_equipe + producao_relatorio_equipe_horas_boas. Usado em Produção › Custos e Preços
-- (faixa "Produtividade da produção" e botão "Relatório da equipe (PDF)", src/components/producao/custos/relatorioEquipe.ts).
-- Parcela da pessoa no lote = sacos × (horas dela no lote ÷ homem-horas do lote). Hoje as etapas têm a janela da ordem,
-- então a parcela é igual entre quem estava; com início/fim próprios por etapa, passa a pesar as horas.
-- Produtividade por hora e "horas medidas" só com lotes limpos (regra de custo_mod_lotes).
CREATE OR REPLACE FUNCTION public.producao_relatorio_equipe(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v jsonb; c custo_cenario;
begin
  if not tem_modulo('custos') then raise exception 'sem acesso ao módulo de custos'; end if;
  select * into c from custo_cenario where padrao;
  with l as (
    select x.*, pr.nome produto from custo_mod_lotes(coalesce(c.fator_encargos, 1.35), coalesce(c.horas_mes_mensalista, 220), coalesce(c.horas_dia_diarista, 8)) x
      left join produtos pr on pr.sku = x.sku
     where x.dia between coalesce(p_de, date '2000-01-01') and coalesce(p_ate, date '2100-01-01')
  ), pl as (
    select e.ordem_id, e.pessoa_id, coalesce(m.nome, e.pessoa_id) nome,
           extract(epoch from (max(coalesce(e.fim_em, o.fim_em)) - min(coalesce(e.inicio_em, o.inicio_em)))) / 3600.0 h
      from producao_etapa e
      join producao_ordem o on o.id = e.ordem_id
      join l on l.ordem_id = e.ordem_id
      left join equipe_membros m on m.id = e.pessoa_id
     where e.pessoa_id is not null
     group by e.ordem_id, e.pessoa_id, m.nome
  ), pl2 as (
    select pl.*, l.un * pl.h / nullif(l.homem_horas, 0) parcela, l.limpo, l.un, l.codigo, l.sku, l.dia
      from pl join l on l.ordem_id = pl.ordem_id
  )
  select jsonb_build_object(
    'de', coalesce(p_de, (select min(dia) from l)), 'ate', coalesce(p_ate, (select max(dia) from l)), 'gerado_em', now(),
    'resumo', (select jsonb_build_object(
        'lotes', count(*), 'sacos', coalesce(sum(un), 0), 'horas_linha', round(coalesce(sum(horas_linha), 0), 2),
        'homem_horas', round(coalesce(sum(homem_horas), 0), 2), 'lotes_limpos', count(*) filter (where limpo),
        'sacos_limpos', coalesce(sum(un) filter (where limpo), 0), 'horas_linha_limpas', round(coalesce(sum(horas_linha) filter (where limpo), 0), 2), 'homem_horas_limpas', round(coalesce(sum(homem_horas) filter (where limpo), 0), 2),
        'un_h_linha', round(sum(un) filter (where limpo) / nullif(sum(horas_linha) filter (where limpo), 0), 1),
        'un_homem_hora', round(sum(un) filter (where limpo) / nullif(sum(homem_horas) filter (where limpo), 0), 1)) from l),
    'pessoas', (select coalesce(jsonb_agg(p order by p.parcela desc), '[]') from (
        select pessoa_id, nome, count(*) lotes, sum(un) sacos_dos_lotes, round(sum(parcela), 1) parcela, round(sum(h), 2) horas,
               count(*) filter (where limpo) lotes_limpos, round(coalesce(sum(h) filter (where limpo), 0), 2) horas_limpas,
               round(sum(parcela) filter (where limpo) / nullif(sum(h) filter (where limpo), 0), 1) un_hora
          from pl2 group by pessoa_id, nome) p),
    'produtos', (select coalesce(jsonb_agg(q order by q.sacos desc), '[]') from (
        select sku, max(produto) produto, count(*) lotes, sum(un) sacos, count(*) filter (where limpo) lotes_limpos,
               round(sum(un) filter (where limpo) / nullif(sum(horas_linha) filter (where limpo), 0), 1) un_h_linha,
               round(sum(un) filter (where limpo) / nullif(sum(homem_horas) filter (where limpo), 0), 1) un_homem_hora
          from l group by sku) q),
    'equipe', (select coalesce(jsonb_agg(d order by d.pessoas), '[]') from (
        select pessoas, count(*) lotes, sum(un) sacos,
               round(sum(un) / nullif(sum(horas_linha), 0), 1) un_h_linha, round(sum(un) / nullif(sum(homem_horas), 0), 1) un_homem_hora
          from l where limpo and not mistura group by pessoas) d),
    'lotes', (select coalesce(jsonb_agg(jsonb_build_object(
        'codigo', l.codigo, 'sku', l.sku, 'produto', l.produto, 'dia', l.dia, 'sacos', l.un, 'min', l.min_linha,
        'homem_horas', l.homem_horas, 'un_h_linha', l.un_h_linha, 'un_homem_hora', l.un_homem_hora, 'limpo', l.limpo, 'motivo', l.motivo,
        'pessoas', (select coalesce(jsonb_agg(jsonb_build_object('nome', p.nome, 'horas', round(p.h, 2), 'parcela', round(p.parcela, 1)) order by p.nome), '[]')
                      from pl2 p where p.ordem_id = l.ordem_id)) order by l.dia, l.codigo), '[]') from l)
  ) into v;
  return v;
end $function$;
revoke all on function public.producao_relatorio_equipe(date, date) from public, anon;
grant execute on function public.producao_relatorio_equipe(date, date) to authenticated;
-- ROLLBACK: drop function if exists public.producao_relatorio_equipe(date, date);
