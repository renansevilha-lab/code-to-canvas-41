-- Títulos dos anúncios da IA com a inicial de cada palavra em maiúscula (pedido do dono, 06/nov/2026):
-- "Areia para Gatos Bumi Pet Care", nunca "Areia para gato bumi pet care".
-- Vale para TODO caminho que grava ia_rascunho.titulo (IA, edição na conferência, "Trazer", anúncio aberto pelo ID),
-- e a anuncio-publicar lê o título daqui — então todo envio sai assim.
--
-- Regras, palavra por palavra:
--   * conectivo no meio do título fica minúsculo (e, de, da, do, para, com, em, no, na, ou, a, o, por, ao, x, c/, p/);
--   * palavra que começa com número fica como está (4kg, 100%, 1,5kg, 2x4kg);
--   * unidade solta fica como está (kg, g, ml, l, cm, mm, un, pçs);
--   * palavra que já tem maiúscula depois da 1ª letra fica como está (PetLike, SVL, XL);
--   * o resto ganha a inicial maiúscula (também depois de - / ( + : "Cães/Gatos", "Anti-Odor");
--   * a 1ª palavra sempre começa com maiúscula; espaços repetidos viram um.

create or replace function public.ia_titulo_capitalizar(p text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  conectivos constant text[] := array['e','de','da','do','das','dos','para','pra','com','em','no','na','nos','nas',
    'ou','a','o','as','os','à','às','por','ao','aos','x','c/','p/','+','&','-','|'];
  unidades constant text[] := array['kg','g','mg','ml','l','cm','mm','m','un','und','unid','unidades','pç','pçs','pc','pcs','lt'];
  palavras text[];
  w text; lw text; i int; saida text[] := '{}';
begin
  if p is null then return null; end if;
  palavras := regexp_split_to_array(btrim(regexp_replace(p, '\s+', ' ', 'g')), ' ');
  for i in 1 .. coalesce(array_length(palavras, 1), 0) loop
    w := palavras[i]; lw := lower(w);
    if w = '' then continue; end if;
    if i > 1 and lw = any(conectivos) then
      w := lw;
    elsif w ~ '^[0-9]' or lw = any(unidades) then
      null;                                  -- 4kg, 100%, 1,5kg, kg, ml…
    elsif substr(w, 2) ~ '[[:upper:]]' then
      w := upper(left(w, 1)) || substr(w, 2); -- PetLike, SVL, XL: só garante a 1ª
    else
      w := initcap(w);                       -- só minúsculas depois da 1ª: initcap não estraga nada
    end if;
    saida := saida || w;
  end loop;
  return array_to_string(saida, ' ');
end $$;

create or replace function public.ia_trg_titulo_capitalizar()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.titulo is not null and (tg_op = 'INSERT' or new.titulo is distinct from old.titulo) then
    new.titulo := public.ia_titulo_capitalizar(new.titulo);
  end if;
  return new;
end $$;

drop trigger if exists trg_ia_rascunho_titulo_maiusculas on public.ia_rascunho;
create trigger trg_ia_rascunho_titulo_maiusculas
  before insert or update of titulo on public.ia_rascunho
  for each row execute function public.ia_trg_titulo_capitalizar();

-- ROLLBACK:
-- drop trigger if exists trg_ia_rascunho_titulo_maiusculas on public.ia_rascunho;
-- drop function if exists public.ia_trg_titulo_capitalizar();
-- drop function if exists public.ia_titulo_capitalizar(text);
