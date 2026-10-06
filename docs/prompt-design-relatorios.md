# Prompt para o Claude Design — página "Relatórios" (app de gestão Ottz Pet)

Cole o texto abaixo no Claude Design.

---

Desenhe a página **Relatórios** do app de gestão da Ottz Pet (pet shop que vende em Shopee, Mercado Livre, Amazon e TikTok, com duas empresas: Ottz/ACZ Pet e SVL Store/Bumi Pet). É uma ferramenta interna de operação, em português do Brasil, usada no computador do escritório e às vezes no celular. O leitor principal é o dono (Renan), que abre a página de manhã para decidir o dia.

## O que a página faz

Todo dia, três "agentes" (rotinas automáticas) escrevem um relatório cada: **Financeiro**, **Compras e Recebimentos** e **Marketing e ADS**. A página lista esses relatórios por categoria e por dia. Cada relatório é um card que abre no lugar (accordion: abrir um fecha o outro) e mostra o detalhe; existe também "Ver versão completa", que abre o relatório em HTML num modal. **Os agentes só analisam e sugerem — a página nunca executa ação** (sem botões de pausar, comprar, pagar etc.).

Hoje a estrutura é:
- Cabeçalho: título "Relatórios", subtítulo curto; à direita, filtro de período em segmentos ("Últimos 7 dias" · "30 dias" · "Tudo").
- Abas por categoria em pílulas, com contador: Financeiro (n) · Compras e Recebimentos (n) · Marketing e ADS (n). A aba fica na URL.
- Lista agrupada por dia ("Hoje", "Ontem", "Seg, 05/10").
- Card fechado: ícone da categoria, título ("Desempenho de ADS · 05/10/2026"), hora de geração, **destaque** (1–2 frases, até 220 caracteres, começando pelo problema do dia) e **3 mini-KPIs** à direita (um pode ficar vermelho).

Quero que você **repense a página** para leitura rápida pela manhã. Explore 2 ou 3 direções (por exemplo: (a) a lista atual refinada; (b) uma faixa "Hoje" no topo com os três agentes lado a lado — destaque + mini-KPIs + o que pede decisão — e o histórico abaixo; (c) uma linha do tempo por dia). Diga qual recomenda e por quê.

## Conteúdo de cada relatório (dados reais — use estes campos)

**Financeiro** — mini-KPIs: Saldo em conta · A receber · Vence em 7 dias (vermelho se há atrasado).
Aberto: 4 KPIs (Saldo em conta, A receber, Atrasado + 7 dias, Pior saldo projetado em 30 dias); Carteiras (saldo por marketplace); "Precisa pagar" (tabela de contas: fornecedor, vencimento, valor, atraso); Próximos 30 dias (fluxo projetado por semana); Por categoria (30 dias, barras); DRE resumida do mês; Qualidade dos dados (avisos discretos).

**Compras e Recebimentos** — mini-KPIs: Ruptura (nº de SKUs, vermelho se > 0) · Urgente · Valor parado (R$).
Aberto: 5 KPIs (Ruptura, Urgente, Atenção, Valor em estoque, Valor parado); tabela "Por fornecedor" (SKUs, ruptura, urgente, atenção, valor em estoque, menor cobertura em dias — clicar filtra a tabela seguinte); tabela "Ruptura, urgente e atenção" (fornecedor, SKU, produto, status em selo, venda/dia, estoque geral, Full Amazon/ML/Shopee, em trânsito, OC aguardando, cobertura, cobertura com OC — tabela larga); "Excesso e sem giro" (top 10 por valor); Qualidade dos dados.

**Marketing e ADS** — mini-KPIs: Gasto ontem · ROAS ontem · Alertas (vermelho se há alerta alto).
Aberto:
1. KPIs por loja (3 cards: Shopee Ottz, Shopee SVL, Mercado Livre): gasto, vendas e ROAS/ACOS de ontem; gasto, vendas e ROAS de 7 dias com variação vs 7 dias anteriores (seta verde/vermelha); TACOS; linha "Mês: gasto → vendas · ROAS (mês anterior)". Shopee leva o rótulo "vendas diretas"; ML "atribuídas, últimos dias provisórios".
2. Alertas (até 25): selo de severidade (alta/média/baixa), anúncio (nome, loja, SKU), tipo ("Queda de vendas", "Orçamento esgotando"…), métrica "base → ontem" e variação %, dias em queda; **chips de causa** clicáveis ("ruptura na empresa", "variação zerou 28/09", "preço 32,90 → 36,90", "saiu da promoção", "histórico curto") que expandem a evidência em texto.
3. Margem × ADS (30 dias) em três colunas: Prejuízo · Apertado · Folgado — cada item com nome, loja, ACOS vs ACOS máximo tolerado e margem pós-ADS em R$ (marca "ROAS bom, margem ruim" quando for o caso).
4. Sugestões (até 25): prioridade 1–3, ação ("Repor estoque", "Reduzir orçamento", "Revisar lance", "Pausar"…), anúncio, justificativa com números, impacto R$/mês. Aviso: "o app não executa — decisão sua".
5. Tendências (4 semanas): listas "Subindo" e "Caindo" com sparkline de 4 pontos e receita; listas menores "Orgânico forte sem ADS" e "CTR alto, orçamento limitado".
6. Qualidade dos dados: avisos discretos ("ADS da Shopee de ontem ainda não chegou (~03:30)", "14 SKUs com CMV incompleto", "retrato com 1 dia: causas de preço/promoção ficam 'histórico curto' até completar 8 dias").

Exemplo real de destaque: "Ruptura derruba a SVL: Esconde Aí 4kg −96% e Tofu sem estoque; vendas ADS da SVL −40% há 2 dias. ML gastou 40% menos na semana. 51 itens em prejuízo pós-ADS (−R$ 4,2 mil em 30 dias)."

## Estados para desenhar

- Carregando (skeleton dos cards).
- Categoria sem relatório no período ("Nenhum relatório neste período").
- Erro ao carregar (mensagem + "Tentar de novo").
- Relatório antigo em formato v0: só o HTML, sem os blocos.
- Dado do dia que ainda não chegou (aviso no topo do card de ADS).
- Card fechado × aberto, para cada um dos três agentes.

## Regras visuais (do app atual — manter)

- Acento **roxo** (#6E56CF); cores definidas em **oklch** como tokens; **modo claro e escuro** obrigatórios.
- Tipografia Inter; números tabulares; JetBrains Mono para SKU e valores em tabela.
- Card sem sombra (a borda separa); sombra só no que flutua (modal, popover).
- Verde = melhorou, vermelho = piorou/risco, âmbar = atenção, cinza = informativo. Para gasto, subir não é "verde".
- Selos pequenos e arredondados; KPIs grandes só no topo de cada card aberto.
- Menu lateral escuro já existe (grupo "Visão" → "Relatórios"); desenhe só a área de conteúdo.
- **Celular** (375 px): margens de 16 px, sem rolagem horizontal da página — tabelas largas rolam dentro do próprio contêiner; mini-KPIs do card fechado vão para baixo do destaque.

## Entregáveis

Boards: desktop (1440) com a lista fechada; os três cards abertos (um board cada); a direção recomendada da página inteira; celular (lista + um card aberto); estados vazios/erro/carregando; modo escuro de pelo menos um board. Notas curtas por board dizendo o que muda em relação ao atual.
