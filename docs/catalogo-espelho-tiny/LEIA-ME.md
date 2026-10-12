# Catálogo espelho do Tiny + variações agrupadas — pacote PREPARADO, NÃO APLICADO

Estado em 12/out/2026. Aprovado pelo dono ("A") em 07/out; ficou para fora do horário
comercial porque é DDL + deploy de função crítica (`tiny-sync-produtos`). Guardado aqui porque
a pasta temporária da sessão foi limpa uma vez e o pacote teve de ser reconstruído.

## O que resolve

1. **Catálogo = Tiny.** O espelho `produtos` tem mais "ativos" do que o Tiny (2.318 × ~2.231):
   a listagem parava em ~1.000 e nunca marcava inativo. A v28 lista de forma retomável
   (ativos → inativos → excluídos) e só inativa o que o Tiny devolveu como inativo/excluído.
2. **Variações como no Tiny.** Hoje o espelho não sabe quem é o pai de cada variação. A v28
   grava `produtos.sku_pai` (pelo detalhe do filho e, de uma vez, pelo detalhe do pai).
3. **Lista /ia/anuncios agrupada.** `ia_catalogo` v2 põe as variações dentro do pai. A tela já
   está pronta (campo `variacoes`); enquanto o banco não muda, nada aparece diferente.

## Arquivos

| Arquivo | O que é |
|---|---|
| `catalogo_01.sql` | colunas novas em `produtos` (situacao, gtin, unidade, tipo_variacao, **sku_pai**, id_tiny_pai, tiny_alterado_em, tiny_visto_em, estoque_atualizado_em), `tiny_sync_estado`, `view_catalogo`, RPC `catalogo_resumo()` |
| `tiny-sync-produtos-v27-no-ar.ts` | a função como estava no ar em 12/out (versão 32 da plataforma, `verify_jwt` **false**) — base da comparação |
| `tiny-sync-produtos-v28.ts` | v27 + listagem retomável + detalhe gravando estoque/pai/situação + `detalhar&pais=1` |
| `ia_catalogo_variacoes.sql` | `ia_catalogo` v2 (variações dentro do pai). Testada em 12/out como função temporária: total 2.318 = v1; pai simulado com 3 filhas soma a venda e aparece na busca pela filha; 0,8–1,4 s |
| `carga_09out_noite.sql` | outro assunto, mesma janela: 2 índices parciais + janela de 30 dias em `pedidos_sem_escrow_componente` (as duas consultas que mais pesam no banco) |
| `catalogo_produtos_novo.tsx.txt` | tela `/produtos` nova (lê `view_catalogo` + `catalogo_resumo`). Falta juntar o botão "Gerar anúncio" que a tela atual ganhou e mostrar kit/variações |

## Ordem para aplicar (depois das 19h, fora dos minutos :00/:15/:30/:45)

1. `get_edge_function tiny-sync-produtos` e comparar com `tiny-sync-produtos-v27-no-ar.ts`
   (sha256). Se mudou, outra sessão mexeu: refazer a v28 em cima da nova.
2. Aplicar `carga_09out_noite.sql` e `catalogo_01.sql` (só acrescentam).
3. Publicar a v28 com **`verify_jwt: false`** (como está hoje; os crons chamam sem sessão).
4. `tiny-sync-produtos?modulo=produtos&forcar=1` até `ultima_completa_em` preencher (cada
   chamada anda ~25 s). Esperado: ativos no espelho = total do Tiny; ~58 produtos viram
   inativos — conferir antes o efeito em `view_cobertura_fornecedor`,
   `view_compras_skus_alvo`, `view_inventario_produtos` e `view_produtos_margem`.
5. `tiny-sync-produtos?modulo=detalhar&pais=1&limite=40` até todos os ~235 produtos tipo V
   terem sido detalhados (uns 6 disparos). Conferir: `select count(*) from produtos where
   sku_pai is not null`.
6. Aplicar `ia_catalogo_variacoes.sql`. Baseline antes/depois: `total` e `contagem` só mudam
   pelas variações que saíram do topo.
7. Cron 19 (`tiny-sync-produtos?modulo=produtos`) → `0,10,20,30,40 8 * * *` (a passada do dia
   termina em algumas rodadas; depois de completa as outras saem sem chamar o Tiny).
8. Medir `view_catalogo` selecionando colunas de verdade (nunca `count(*)`), adaptar e
   publicar a tela nova do Catálogo, atualizar o `CLAUDE.md`.

## Reverter

Função: publicar de novo `tiny-sync-produtos-v27-no-ar.ts`. Banco: as colunas novas são
ignoradas pela v27; `ia_catalogo` volta com a definição da v1 (`docs/ia-fase2b-preco-historico.sql`).
