# Anúncio Mágico → gestão · Fase 2 (geração na gestão) — PLANO

Status: **aprovado e implementado em 09/out/2026** (D1 do zero, D2 só Tiny, D3 encadeado + vigia 5 min,
D4 botão no Catálogo + /ia/anuncios, D5 fora). Edge fns no ar; tabelas em `docs/ia-fase2-migracao.sql`
(aplicar fora do horário comercial). Resumo no CLAUDE.md §5.11.1.
Fase 1 (prompts/contextos em `ia_*`) no ar desde 06/out; cópia conferida de novo em 07/out
por md5 — idêntica ao gerador, **não precisa re-sincronizar**.

Escopo da Fase 2: briefing → texto → prompts de imagem → imagens, com aprovação por etapa,
**dentro da gestão**. O envio ao Tiny fica para a **Fase 3** (aprovar marca a etapa como
aprovada; nada sai para o Tiny ainda). O gerador continua no ar até a Fase 4.

---

## 0. Levantamento do gerador (07/out, só leitura)

- **Tabelas de geração** (pequenas): `anuncio_draft` 15 linhas, `anuncio_draft_imagem` 58,
  `anuncio_etapa` 73, `anuncio_briefing` 14, `anuncio_prompt_imagem` 84 — juntas < 1,2 MB.
- **Storage:** `anuncios` 71 MB (privado: `originais/`, `comparacao/`, `{sku}/{draft}/…`),
  `publicadas` 17 MB (público, URL que o Tiny recebe), `contexto` 960 kB, `produtos` 95 kB.
- **Catálogo próprio:** `produto_atributos` (1.616) — cópia do Tiny que **não vem** para a gestão;
  a base passa a ser `produtos` + `produto_kits` (via `ia_produto`).
- **Funções:** `gerar-briefing` v8, `gerar-texto` v12, `gerar-prompts-imagem` v5,
  `gerar-imagens` v17 (só enfileira), `gerar-imagem-worker` v2 (1 imagem por chamada,
  encadeia em si mesmo + cron a cada minuto). Fontes salvas no scratchpad da sessão.
- **Front:** `_app.produto.$sku.tsx` = 3.564 linhas num arquivo só (6 etapas, CapaSelector,
  FotosSection, PromptsSection, lateral de contexto, polling de 3 s).

## 1. Decisões em aberto (dono)

| # | Tema | A | B | C |
|---|---|---|---|---|
| D1 | **Histórico do gerador** (15 rascunhos, 58 imagens, 71 MB) | **Começar do zero na gestão**; gerador fica só leitura (Fase 4) como arquivo — *recomendo* | Copiar tudo (tabelas + 88 MB de Storage) | Copiar só os rascunhos com imagem aprovada |
| D2 | **Produto manual** (1 no gerador) | **Não trazer** — só produto do Tiny (catálogo espelho) — *recomendo* | Tabela `ia_produto_manual` | — |
| D3 | **Worker de imagem** (gestão é NANO) | **Encadeado sob demanda + 1 cron de sobra a cada 5 min** — *recomendo* | Cron a cada minuto (igual ao gerador) | Sem cron (só encadeado) |
| D4 | **Entrada da tela** | **Pelo Catálogo novo** (botão "Gerar anúncio" na linha) + lista `/ia/anuncios` dos rascunhos — *recomendo* | Lista própria de produtos em `/ia` | — |
| D5 | **Comparar modelos** | **Deixar fora** (ferramenta defasada no gerador) — *recomendo* | Reescrever junto | — |

## 2. Banco (migração `ia_10_geracao`) — DDL depois das 19h

Mesmo padrão da Fase 1: RLS `tem_modulo('ia')` para authenticated, sem anon; escrita de
fila/etapa só por RPC `security definer` ou pela edge fn (service_role). Status em `text`
com CHECK (sem enum novo).

- **`ia_produto_extra`** (PK `sku` → `produtos.sku`): `publico_alvo`, `frete_adicional`
  (0), `custo_embalagem` (0,30), `foto_ref_path` + `fotos_ref` (cópia congelada da foto real —
  hoje 3 fontes diferentes no gerador; aqui **uma só**).
- **`ia_briefing`** (UNIQUE sku): persona, dores, objecoes, beneficios, angulo, tom,
  palavras_chave, fotos_recomendadas, modelo, bruto.
- **`ia_rascunho`** (= draft): sku, canal → `ia_canal_config`, empresa → `ia_empresa`,
  status, titulo, descricao, bullet_points, custo_snapshot, preco_sugerido, preco_aprovado,
  margem_estimada_pct, memoria_calculo, briefing_id, prompt_template_id, modelo_texto, erro,
  criado_por/criado_em/atualizado_em. (`preco_minimo` sai: no gerador era igual ao sugerido.)
- **`ia_prompt_imagem`** (UNIQUE sku+tipo): prompt, editado_mao, modelo.
- **`ia_rascunho_imagem`** (UNIQUE rascunho+ordem): tipo, storage_path, prompt_usado, modelo,
  referencia_path/bytes/sha256, gerado_em.
- **`ia_etapa`**: rascunho_id, etapa ('texto'|'imagem'), imagem_id, status
  (pendente→na_fila→gerando→gerado→aprovado; erro/rejeitado; `enviando/enviado` reservados p/
  Fase 3), conteudo_hash, observacao, tentativas, proxima_tentativa_em, erro, aprovado_por/em.
- **RPCs:** `ia_etapa_aprovar/rejeitar` (sem enfileirar Tiny na Fase 2), `ia_imagem_fila_pegar`
  (SKIP LOCKED + libera presos > 5 min + respeita backoff), `ia_calcular_preco`/`ia_analisar_preco`
  (custo de **`view_cmv_efetivo`** — kit pela composição, regra da gestão — + frete/embalagem de
  `ia_produto_extra` + `ia_canal_faixa`/`ia_empresa`). Triggers: texto→etapa (hash), etapa→imagem.
- **Storage:** bucket **`ia-anuncios`** (privado; `ref/{sku}/…`, `{sku}/{rascunho}/{ordem}-{tipo}`).
- **Peso no banco:** < 2 MB no primeiro mês. Imagens no Storage, fora do banco. **Atenção:** o
  banco está em 506 MB (investigação separada aberta) — aplicar a Fase 2 depois de baixar.

## 3. Edge functions (gestão)

Prefixo `ia-`, JWT de usuário **e** `tem_modulo('ia')` checado no código; leem `ia_*`,
`ia_produto`, `ia_contextos_do_sku`; foto pela `view_foto_produto` + cópia congelada.

| Nova | Vem de | Muda |
|---|---|---|
| `ia-briefing` | gerar-briefing v8 | usa a foto congelada (hoje só `foto_capa_url`) |
| `ia-texto` | gerar-texto v12 | contextos baixados 1× (hoje 3×); recalcula preço ao refazer; erro de preço aparece |
| `ia-prompts-imagem` | gerar-prompts-imagem v5 | barra vazia **sem exemplo**; "sem barra" explícito; ícones vazios = livre (3–5); meta_prompt único com erro claro; concorrência limitada |
| `ia-imagens` | gerar-imagens v17 | só enfileira; trava `[CONFIRMAR` também no servidor |
| `ia-imagem-worker` | gerar-imagem-worker v2 | backoff entre tentativas; sem regras de IMAGEM duplicadas; mede tempo (limite da função) |

**Secrets a cadastrar pelo dono no projeto da gestão:** `ANTHROPIC_API_KEY`,
`GOOGLE_API_KEY`, `OPENAI_API_KEY` (nunca no chat). Modelos: os de `ia_modelo_imagem`.

## 4. Front

- `/ia/anuncios` (lista de rascunhos) e `/ia/gerar/$sku` (canal/empresa/modelo no topo).
- Página dividida em componentes (`src/components/ia/…`): hook de dados, stepper, Briefing,
  Texto, Prompts, Capas+Fotos (CapaSelector), Preço, lateral de contexto (pela RPC — corrige os
  "herdados" que hoje não mostram as 35 cenas).
- Polling só enquanto há etapa em fila/gerando (3 s), parado na aba oculta.
- Correções levadas junto: refazer capa respeita `[CONFIRMAR`; sem listas cortadas em 1.000.

## 5. Ordem e validação

1. DDL `ia_10_geracao` (noite) → 2. secrets (dono) → 3. deploy das 5 fns → 4. teste de
referência **SKU 15984, capa estilo 5, 5 sacos, modelo Sunburst** comparado com o gerador →
5. front → 6. dono gera 2–3 anúncios reais na gestão antes da Fase 3.

## 6. Rollback

Front: reverter o commit. Fns: apagar as `ia-*` (gerador segue intacto). Banco: `drop` das
tabelas/RPCs `ia_*` da Fase 2 (nenhuma tabela existente é alterada) + apagar o bucket.
