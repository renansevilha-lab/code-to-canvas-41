# Tela "Devoluções Recebidas" — escopo, backend e prompt de design

> Estado em 10/ago/2026: **backend PRONTO** (tabelas + match validado ao vivo) e
> **lógica do front PRONTA** (`src/components/DevolucoesRecebidas.tsx`, sub-aba de
> `/devolucoes`). **Falta o VISUAL** — montar o mock no Claude Design com o prompt
> abaixo e re-skinar por cima. Decisões fechadas com o dono.

## 1. Objetivo
Quando um **pacote de devolução chega fisicamente na empresa**, o operador **bipa
o QR / rastreio da etiqueta** (ou digita o nº do pedido); o sistema **identifica o
pedido**, mostra **quais itens deveriam voltar**, e o operador **confere** (quantidade
recebida + estado: OK / Quebrado / Furado / Faltando) e **registra**. É um painel de
bancada, usado com leitor de código.

Cobre a população que hoje fica **de fora** da varredura de cancelados: **pedido
entregue que o cliente devolveu**. Fica **integrada** à área Devoluções, como
**sub-aba ao lado de "Cancelados (NF)"**.

## 2. Fases (o design deve acomodar as próximas sem redesenhar)
- **A (esta tela):** receber → conferir itens → registrar. *(agora)*
- **B (depois):** botão **"Gerar/Emitir NF de devolução"** por registro (reusa a
  `nf-devolucao` existente) — prever um espaço/rótulo de status de NF no card e na lista.
- **C (depois):** integração **Shopee/ML** (reembolsos/devoluções criados lá) — a
  lista pode receber itens com **origem = marketplace** (badge diferente).

## 3. Backend — JÁ CRIADO
- Tabelas **`devolucoes_recebidas`** (order_sn, tiny_numero, rastreio, marca_canal,
  empresa, status, recebido_em, recebido_por, conferido_ok, observacao, + reservado
  p/ fases B/C: origem, marketplace_return_id, nf_devolucao_id/status/gerada_em/emitida_em)
  e **`devolucao_recebida_itens`** (sku, nome_produto, qtd_esperada, qtd_recebida,
  estado, observacao).
- **Match validado ao vivo:** rastreio `BR…` (por prefixo) OU order_sn → `pedidos_tiny`
  → itens via `separacao_tiny`. Não precisa de foto nem de OCR (o rastreio/pedido
  resolvem). A NF **não** está no espelho, mas é puxável do Tiny na Fase B.

## 4. Estrutura da tela (3 blocos, de cima pra baixo)
1. **Barra de recebimento (scan-first):** campo de leitura grande com **foco
   automático**, aceita **bipe + Enter**, placeholder tipo "Rastreio (BR…) ou pedido".
   Ícone de scanner. Botão "Buscar". Estado de **erro amigável** quando não encontra.
2. **Card do pedido encontrado + conferência** (aparece após o match):
   - Cabeçalho: **order_sn grande (mono)** + badges (Tiny nº, canal, situação) + rastreio.
   - **Alerta** se "já registrada em DD/MM HH:mm".
   - **Checklist de itens:** por item → **foto + nome do produto + SKU**, "**Esperado: N**",
     campo "**Recebido**" (número), **select de estado** (OK / Quebrado / Furado /
     Faltando) com **cor semântica**, campo "obs do item". Divergências destacadas
     (recebido ≠ esperado em âmbar; estado ≠ OK em vermelho).
   - Observação geral + botões **Cancelar / Registrar devolução**.
3. **Lista de devoluções recebidas** (tabela/board): Recebido (data), Pedido (order_sn ·
   Tiny), Canal, **Conferência** ("Tudo certo ✓" verde / "Com ressalva ⚠" âmbar),
   Por (quem recebeu), Obs. *(Reservar coluna/rótulo futuro: status da NF.)*

## 5. Comportamento
- Foco automático no scan; **Enter dispara a busca** (fluxo de leitor de código).
- Ao registrar: some o card, limpa, volta o foco pro scan, atualiza a lista (fluxo rápido de bancada, um pacote atrás do outro).
- `conferido_ok` = todos os itens estado OK **e** qtd recebida = esperada.

## 6. Direção visual
Consistente com o app (fonte **Inter**, acento **roxo #6E56CF**, **claro/escuro**),
densidade de **bancada** (legível, ação rápida). **Cores por estado:** OK = verde,
Quebrado/Furado = vermelho, Faltando = âmbar. Foto do produto com peso visual. Estados
vazios amigáveis. Nada de tabela apertada — leitura confortável.

---

## 7. PROMPT PARA O CLAUDE DESIGN (copiar/colar)

```text
Crie uma tela "Devoluções Recebidas" — um painel de bancada para dar entrada em devoluções físicas que chegam na empresa, usado com leitor de código de barras. Deve ser lido e operado rápido, um pacote atrás do outro. Suporte a tema claro e escuro. Fonte Inter, acento roxo #6E56CF.

BLOCO 1 — RECEBIMENTO (scan-first): no topo, um campo de leitura grande e destacado (com ícone de scanner), placeholder "Rastreio (BR…) ou nº do pedido", e um botão "Buscar". A ideia é o operador bipar a etiqueta (o leitor digita e dá Enter). Abaixo, um estado de erro amigável quando não encontra o pedido.

BLOCO 2 — PEDIDO ENCONTRADO + CONFERÊNCIA (aparece depois de bipar): um card com destaque.
- Cabeçalho: número do pedido em destaque grande e monoespaçado (ex.: 260804EJRXP5TE), com badges ao lado: "Tiny 289324", canal ("Sevilla Store [SHOPEE]"), situação ("entregue"). Abaixo, o rastreio em fonte mono menor.
- Se já foi registrada antes, um selo âmbar de alerta: "Já registrada em 10/08 14:22".
- Checklist de itens (um card/linha por item): foto do produto (grande), nome + SKU, um número grande "Esperado: 2", um campo editável "Recebido" (número), um seletor de estado com cor (OK=verde, Quebrado=vermelho, Furado=vermelho, Faltando=âmbar) e um campo pequeno de observação do item. Destaque visual quando "Recebido" difere de "Esperado" ou o estado não é OK.
- Rodapé do card: campo "Observação geral" e dois botões: "Cancelar" (secundário) e "Registrar devolução" (primário, roxo).

BLOCO 3 — LISTA DE RECEBIDAS: abaixo, uma lista/tabela das devoluções já registradas: Recebido (data/hora), Pedido (número + Tiny), Canal, Conferência (selo verde "Tudo certo ✓" ou âmbar "Com ressalva ⚠"), Por (quem recebeu), Observação. Estado vazio amigável ("Nenhuma devolução recebida ainda — bipe uma etiqueta para começar").

COMPORTAMENTO: o foco fica no campo de leitura; ao registrar, o card some, limpa e volta o foco pro scan. Densidade de bancada, tipografia legível, cores por estado bem visíveis à distância.

DADOS (mock com esta forma):
- match: { order_sn, tiny_numero, marca_canal, situacao, rastreio, ja_recebida_em, itens: [{ sku, nome, foto, qtd_esperada }] }
- conferência (edição): [{ sku, nome, qtd_esperada, qtd_recebida, estado: 'ok'|'quebrado'|'furado'|'faltando', obs }]
- lista: [{ recebido_em, order_sn, tiny_numero, marca_canal, conferido_ok, recebido_por, observacao }]
- ações: buscar(termo), registrar() (grava e remove o card), cancelar().

Exemplo de item: { sku:'16054', nome:'Areia Ottz Pet 4kg Mandioca Natural Anti Odor', qtd_esperada:2 }.
```
