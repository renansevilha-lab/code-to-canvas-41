# IA · Anúncios — ponto de parada (12/out/2026) para continuar em outro PC

Tudo o que foi feito está no `main` (último commit de código: `450b688`). Não há nada só
neste PC além do que está listado em "O que NÃO veio junto". O detalhe técnico de cada item
está no `CLAUDE.md` §5.11.1 a §5.11.5 e §5.9.1 (relâmpago).

Para retomar, abra uma sessão nova no outro PC, dê `git pull` e diga:
**"Leia docs/ia-continuar-sessao.md e continue de onde parou."**

## 1. Pendência nº 1 — publicar a função `anuncio-publicar` v4 (Mercado Livre)

- O código da v4 está no repositório (`supabase/functions/anuncio-publicar/index.ts`), mas
  **no ar ainda está a v3** (só Shopee). O deploy foi **bloqueado pelo classificador de
  permissões** ("Production Deploy") e ficou esperando o OK do dono.
- A tela (`Publicar.tsx`) já foi publicada: o cartão do Mercado Livre aparece como
  "disponível", mas ao abrir a conferência vem "o envio direto está pronto só para a Shopee"
  até a função subir. Não quebra nada.
- Como publicar (não há CLI/token nos PCs — é pelo MCP do Supabase, `deploy_edge_function`,
  projeto `vhogjofsxyhnyxdyglmq`, `verify_jwt: true`, um arquivo só, `index.ts`):
  1. `get_edge_function` e conferir que a linha 2 no ar ainda diz **v3** (se já disser v4,
     alguém publicou; se for outra coisa, outra sessão mexeu — parar e comparar).
  2. Publicar o conteúdo **com final de linha LF**. Atenção: o Git do Windows pode entregar o
     arquivo com CRLF no outro PC. A referência é o que está no Git:
     `git show HEAD:supabase/functions/anuncio-publicar/index.ts | sha256sum` →
     `a63a0d8bf0d7451ab5f6089fa1033d47acda2df5aea44395897272e0ae431fe2` (976 linhas, 69.371 bytes).
  3. Baixar de novo com `get_edge_function` e comparar o sha256 com o de cima.
  4. Trocar no `CLAUDE.md` (tabela da §6 e o aviso ⚠ da §5.11.5) "v3 no ar · v4 no
     repositório" por "v4".

## 2. O que está pronto e o que ainda não foi testado de verdade

| Peça | Estado |
|---|---|
| Texto (`gpt-5.5`) e imagens (`gpt-image-2.5-sunburst`) | funcionando; 1ª geração real feita (SKUs 16170 e 15819). Só a chave da OpenAI está cadastrada (a da Anthropic não) |
| Preço pelo histórico + por margem | funcionando |
| Referências/instruções por produto ou marca | funcionando; envio das imagens de contexto à OpenAI (worker v2) ainda não observado numa geração |
| Capas novas (selo flutuante, sem benefícios), Lifestyle com texto, sem etapa de confirmação | no ar; **efeito ainda não visto** numa imagem (clicar "prompt" e depois "refazer") |
| Shopee — conferência (criar e atualizar, seletor de fotos) | conferência vista pelo dono em tela |
| Shopee — **envio** (criar ou atualizar) | **nunca rodou**; reaproveitar id de foto antiga no `update_item` não testado |
| Mercado Livre — código | pronto, **não publicado** (item 1) |
| Mercado Livre — ensaio (leitura + validador do ML) | ok nas duas contas: `ml-anuncio-sonda?conta=ottz&sku=15984` e `conta=svl&sku=16170` |
| Mercado Livre — conferência pela tela e **envio** | nunca rodaram (dependem do item 1) |
| Relâmpago Shopee em dias alternados (`shopee-flashsale` v9) | corrigido; o reenvio novo só roda no cron das 18h07 — **falta conferir** `flashsale_criadas.detalhe.acoes` (`ler-reservas`, `add-retry`) do dia seguinte a 12/out |

Ordem sugerida de teste depois de publicar a v4:
1. Mercado Livre, produto que já tem anúncio na Ottz: abrir a conferência e atualizar **só a
   descrição** (o passo de menor risco).
2. Shopee: atualizar um anúncio existente só com 1 foto nova no fim.
3. Criar anúncio novo (Shopee fora do ar / ML pausado) e conferir no Tiny se ligou pelo SKU —
   é o que decide se criar direto serve (estoque e pedido dependem desse vínculo).

## 3. Oferecido e ainda não pedido

- Margem alvo por canal (hoje 17,5% para todos, em `ia_canal_config.margem_alvo_pct`).
- Envio para TikTok e Amazon; anúncio com variações na Shopee (criar).
- Merchant token da Amazon SVL (falta o dono informar).
- Refinar a taxa por faixa de preço × peso para produto novo no canal.

## 4. O que NÃO veio junto (ficou só no outro PC)

- **Memória do assistente** (pasta local do Claude). O que importa dela:
  (a) antes de todo push que mexe em `src/`, rodar `tsc --noEmit -p .` e `vite build` — erro
  no front trava a bancada; (b) margem canônica = `recebido_estimado − CMV − imposto`;
  (c) o `ml-sync` v21 corrigiu itens que sumiam.
- **Node portátil** usado para o tsc/build ficava numa pasta temporária daquele PC. No outro,
  usar o Node instalado (`npm ci` se não houver `node_modules`).
- Scripts de edição temporários — descartáveis, tudo o que geraram está commitado.

## 5. Regras que valeram a sessão inteira

- Escrita em API de marketplace (anúncio, preço, estoque, promoção) só com conferência na
  tela e confirmação do dono; escrita não é retentada (POST repetido cria em dobro).
- Chaves de IA e tokens nunca no chat; o dono cadastra nos secrets do Supabase.
- Migração/backfill fora do horário comercial e fora dos minutos :00/:15/:30/:45; banco em
  ~520 MB (teto 500).
- Antes de redeployar uma função, baixar a que está no ar e comparar (outra sessão pode ter
  mexido). Função grande vai colada inteira e é conferida por sha256.
- Edição de arquivo com acento: nunca por heredoc do bash (estraga a codificação).
