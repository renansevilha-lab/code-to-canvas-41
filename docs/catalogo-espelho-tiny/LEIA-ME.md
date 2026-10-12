# Catálogo espelho do Tiny + variações agrupadas — APLICADO em 12/out/2026 (19h50–20h10)

Aprovado pelo dono ("A") em 07/out; "pode rodar" em 12/out à noite. O relato do que ficou no
ar, com os números medidos, está no `CLAUDE.md` §5.11.9. Esta pasta fica como **fonte** das
funções e como roteiro de reversão.

## Arquivos

| Arquivo | O que é | Estado |
|---|---|---|
| `carga_09out_noite.sql` | 2 índices parciais + janela de 30 dias em `pedidos_sem_escrow_componente` | aplicado (migração `carga_09out_indices_escrow`) |
| `catalogo_01.sql` | colunas novas em `produtos`, `tiny_sync_estado`, `view_catalogo`, RPC `catalogo_resumo()` | aplicado (migração `catalogo_01_espelho_tiny`) |
| `tiny-sync-produtos-v27-no-ar.ts` | a função como estava antes (versão 32 da plataforma) | base da reversão |
| `tiny-sync-produtos-v28.ts` | v27 + listagem retomável + detalhe gravando estoque/pai/situação + `detalhar&pais=1` | ficou no ar por ~10 min |
| `tiny-sync-produtos-v29.ts` | v28 + 404 no detalhe = produto apagado no Tiny (inativa e tira da fila) | **NO AR** (versão 34 da plataforma, `verify_jwt` false, sha256 `ed604ff4031fb639…`) |
| `ia_catalogo_variacoes.sql` | `ia_catalogo` v2 (variações dentro do pai, `versao: 4`) | aplicado (migração `ia_catalogo_v2_variacoes_no_pai`, com conferência na própria transação) |
| `catalogo_produtos_novo.tsx.txt` | rascunho da tela `/produtos` | virou `src/routes/produtos.tsx` (+ botão "Gerar anúncio") |

## O que a aplicação mostrou (para a próxima vez)

- A listagem inteira do Tiny (2.261 ativos + 444 inativos + 682 excluídos) coube em **2
  chamadas** (26 s e 6 s) — a estimativa era ~10.
- **Produto apagado de vez no Tiny não vem em lista nenhuma** (nem na de excluídos): o GET
  pelo ID dá 404. Eram 26 "ativos" no espelho que travavam a frente da fila do detalhe
  (cada rodada gastava 12 a 26 vagas com eles). Daí a v29.
- O detalhe da variação traz `produtoPai {id, sku}`; o do pai traz `variacoes[]`. Ligar os 223
  pais levou 11 rodadas de ~50 s (15 a 30 pais por rodada).

## Reverter

- Função: publicar de novo `tiny-sync-produtos-v27-no-ar.ts` (as colunas novas são ignoradas).
- Quem ficou inativo: `_bkp_produtos_ativo_12out` (sku, ativo, tipo, custo, preco, nome de
  antes) — `update produtos p set ativo = b.ativo from _bkp_produtos_ativo_12out b where
  b.sku = p.sku and b.ativo and not p.ativo`. A listagem do dia seguinte volta a inativar o que
  o Tiny listar como I/E.
- `ia_catalogo`: a versão anterior (v1.2, 8 parâmetros, sem variações) não tem arquivo
  próprio — é a `docs/ia-catalogo-filtros.sql` + o parâmetro `p_tipo` (migração
  `ia_catalogo_filtro_tipo` no histórico do Supabase).
