# Handoff — estado atual e próximos passos

> Atualizado 11/ago/2026 (HEAD `76f9ffb`). Este doc viaja no `git` — leia ao
> continuar de outra máquina. **Ao começar: `git pull --ff-only`.** Backend
> (Supabase: migrations, edge functions, crons) é compartilhado, já aplicado —
> não precisa reaplicar.

## Feito nas últimas sessões

### Devoluções (foco atual)
- **Aba `/devolucoes` virou 2 sub-abas:** "Cancelados (NF)" (tela antiga) +
  **"Recebidas"** (`src/components/DevolucoesRecebidas.tsx`).
- **Recebidas (Fase A):** bipa rastreio (BR…, por prefixo) ou order_sn → casa em
  `pedidos_tiny` → mostra itens (foto/SKU/qtd) → confere (qtd stepper + estado
  OK/Quebrado/Furado/Faltando) → registra. Tabelas `devolucoes_recebidas` +
  `devolucao_recebida_itens`.
  - **Dois fluxos:** "Só registrar" (status `recebida`, a conferir) e "Registrar
    conferido". Lista permite **Conferir** depois (UPDATE, não duplica).
  - Mostra **status Shopee**, **forma de envio** (`opcao_envio`: Full/Xpress/ER/
    Turbo; fallback `forma_envio`), **motivo de cancelamento** e **motivo de
    devolução** (ver abaixo).
- **Motivo de cancelamento:** JÁ estava em `pedidos.motivo_cancelamento` (Shopee +
  ML). Surfaçado em Cancelados (subtexto sob o order_sn; view_devolucoes_lista
  ganhou a coluna) e no card de Recebidas.
- **Motivo de DEVOLUÇÃO (≠ cancelamento):** pedido entregue-e-devolvido tem
  motivo_cancelamento NULL. O motivo vem da **API de Returns da Shopee** → espelho
  **`shopee_devolucoes`** (reason + `text_reason` do comprador + fotos + refund),
  populado por **`shopee-devolucao-probe?modulo=sync`** (**cron jobid 70, `*/30`**).
  Card e lista de Recebidas mostram; gravado em
  `devolucoes_recebidas.motivo_devolucao/texto_devolucao`.
- **Identificação por rastreio — CAUSA RAIZ do "não identifica" (12/ago):** o
  bipado é o **prefixo do rastreio de ida** (`BR…SPXLM…`), mas **43,6% dos pedidos
  Shopee vêm com `codigo_rastreamento` NULL** do Tiny (NULL permanente, ~1/3). Fix:
  tabela **`shopee_rastreio`** (order_sn→tracking_number) populada pela edge fn
  **`shopee-rastreio`** (`logistics.get_tracking_number`) — **cron jobid 71 `*/10`**,
  janela 30d, throttled, **sem backfill histórico** (decisão do dono). O `buscar()`
  agora tem 4 camadas: forward em pedidos_tiny → forward em `shopee_rastreio` →
  reverso em `shopee_devolucoes` → card mínimo por order_sn. Também casa blocos
  alfanuméricos do valor bipado (QR com sufixo/prefixo diferente do texto).

### Outras telas recentes
- **`/monitoramento`** (painel de bancada ao vivo, importado do Claude Design):
  funil do dia + cards de lote; cor por qtd (escala da Separação). Views
  `view_monitoramento_lotes/totais` + RPC `monitoramento_finalizar_tag`.
- **Fulfillment › lançar estoque no Tiny** (transferência Geral→Full pelo
  embalado, com explosão de kits) — `fulfillment-estoque` v2.
- **Separação:** prazo de despacho (Shopee) + etiqueta identificadora do lote.
- **Design:** fonte global do app trocada p/ **Inter**; **menu do shell recolhível**
  (botão PanelLeft no header).

## Backend criado (Supabase — já aplicado, compartilhado)
- Tabelas: `devolucoes_recebidas`, `devolucao_recebida_itens`, `shopee_devolucoes`
  (+ `tracking_number`/`needs_logistics`), **`shopee_rastreio`** (order_sn→forward),
  `fulfillment_estoque_lancamentos`.
- Edge functions: `fulfillment-estoque` (v2), `shopee-devolucao-probe` (**v6** — sync
  de produção de devoluções, janelas encadeadas até 90d; renomear p/ `shopee-devolucao`
  é pendência cosmética), **`shopee-rastreio`** (v1 — `sync`/`tracking`, puxa
  `get_tracking_number`).
- Funções SQL: `shopee_rastreio_pendentes(dias,limite)`, `shopee_rastreio_marcar_falha`.
- Crons: **jobid 70** `shopee-devolucoes-sync` (`*/30`), **jobid 71**
  `shopee-rastreio-sync` (`*/10`, janela 30d, throttled). *(jobid 69 já removido.)*
- Views: `view_devolucoes_lista` (+ motivo_cancelamento), `view_monitoramento_*`.

## Próximos passos (pendentes)
1. **ML — sync de Claims** (`GET /post-purchase/v1/claims/{id}` → `reason_id`) pra
   gravar o motivo de DEVOLUÇÃO do ML (mesmo padrão do Shopee Returns). Escopo já
   validado ao vivo (funciona). Falta a tabela/sync + surfaçar.
2. **Full Meli:** puxar `logistic_type` do envio ML pra distinguir "Full Meli" do
   normal (hoje forma_envio ML = "Mercado Envios", não distingue).
3. **Devoluções Fase B:** botão "Gerar/Emitir NF de devolução" no registro
   recebido (reusa `nf-devolucao`); schema já reserva `nf_devolucao_*`.
4. Renomear `shopee-devolucao-probe` → `shopee-devolucao` (cosmético).
5. Pendências antigas: Monitoramento (só Shopee single-SKU); reconciliar
   "recebido" no Fulfillment; AuthProvider único (ver docs/memória).

## Avisos / gotchas
- **Tokens ML expiram rápido** — se um probe der 401, rode `ml-refresh-token`
  antes (e espere ~5s o token gravar).
- **Cuidado com escrita concorrente** (Lovable + Claude Code + outra sessão) —
  `git pull` antes de começar; combine quem mexe em quê.
- **Não deixar query pesada/cron travar o banco** — em 10/ago um refresh de
  matview (`view_kpi_pedidos_dia`, jobid 62) saturou o banco por ~14 min e derrubou
  o app (só o dado não carregava; shell/menu ok). Recuperado com restart + limpeza.
  Se o app parar de carregar dado, checar `pg_stat_activity` / logs Postgres.
- Tokens Shopee em `oauth_tokens_shopee`; assinatura HMAC = a do `shopee-sync`
  (secrets SHOPEE_PARTNER_KEY[_SVL]). Returns API: janela máx **15 dias**/chamada.
