# Tela "Central de Promoções — Mercado Livre" (com Margem de Contribuição)

> Estado em 12/ago/2026: **no ar** em `/promocoes-ml` (rota `src/routes/promocoes-ml.tsx`),
> ligada a `view_ml_promocoes` + `ml_promocoes` e à edge fn `ml-promocoes`
> (sync + aplicar/remover). Este doc guarda o **prompt de design** pra remockar a tela
> no Claude Design. Ao reimplementar o `.dc.html`, manter a mesma forma de dados abaixo.

## Contexto (o que a tela resolve)
Painel de **decisão comercial**: o Mercado Livre oferece promoções (campanhas) ao
vendedor; para cada item elegível o ML sugere um **preço promocional**. A tela espelha
essas promoções e mostra, por item, a **Margem de Contribuição (MC) que teríamos ao
aplicar** — comparando **MC atual (preço cheio) × MC no preço promocional**. O objetivo
é o operador bater o olho e ver **onde vale a pena** e **onde venderia no prejuízo**
(MC negativa) antes de aderir. Dá pra **aplicar/remover** a promoção por item (muda o
preço público no ML), sempre com confirmação.

## Direção visual
Consistente com o app: fonte **Inter**, acento **roxo #6E56CF**, **tema claro e escuro**.
Densidade de **planilha de decisão** (muitos itens, leitura rápida, comparação de números).
Cores **semânticas** (separadas do acento): **MC positiva = verde**, **MC negativa =
vermelho**, **aviso/estimado = âmbar**. O contraste **atual → promo** é o coração visual —
a queda de margem tem que saltar. Números monoespaçados e alinhados (`tabular-nums`).

---

## PROMPT PARA O CLAUDE DESIGN (copiar/colar)

```text
Crie uma tela "Central de Promoções — Mercado Livre" — um painel de decisão comercial denso, estilo planilha, para um app de gestão de e-commerce. Fonte Inter, acento roxo #6E56CF, suporte a tema claro e escuro. Cores semânticas separadas do acento: margem positiva = verde, margem negativa = vermelho, aviso = âmbar.

PROPÓSITO: o Mercado Livre oferece promoções (campanhas) ao vendedor; por item ele sugere um preço promocional. A tela mostra, para cada item, a Margem de Contribuição (MC) que teríamos ao aplicar a promoção, comparando a MC no preço cheio (atual) com a MC no preço promocional. O operador precisa ver rápido onde vale a pena e onde venderia no prejuízo (MC negativa).

BLOCO 1 — CABEÇALHO: título "Central de Promoções — Mercado Livre" com um ícone de raio à esquerda, e um subtítulo "Margem de contribuição que teríamos ao aplicar cada promoção, no preço promocional". À direita, um botão "Sincronizar" (ícone de refresh) e um selo discreto de status "Sincronizado".

BLOCO 2 — CHIPS DE PROMOÇÃO (filtro): uma faixa de chips selecionáveis, um por campanha, mais um chip "Todas (N)" no início (selecionado por padrão). Cada chip de campanha tem: um mini-badge colorido do TIPO (Smart = azul, Oferta/Deal = roxo, Relâmpago = laranja), o nome da campanha (ex.: "Aumente suas vendas", "LGH-MLB1000", "9.9"), a contagem de itens, e um marcador âmbar "agendada" quando a campanha ainda não começou. O chip selecionado ganha anel/realce roxo.

BLOCO 3 — BARRA DE FILTROS + RESUMO: à esquerda, um campo de busca (placeholder "SKU, MLB ou produto"), um select de status ("Todos os status" / "Aplicadas" / "Candidatas"), um select de ordenação ("maior queda de MC" / "menor MC na promo" / "maior desconto") e um checkbox "Só com prejuízo". À direita, um resumo em texto: "N itens", "N no prejuízo" (em vermelho, com ícone de alerta), e "MC média promo: R$ X" (verde se positiva, vermelho se negativa).

BLOCO 4 — TABELA (o foco): uma tabela densa, uma linha por item, colunas:
- Produto: foto pequena (thumbnail) + nome do produto (1 linha, truncado) + linha secundária mono "SKU 14749 · MLB3746928601" com um ícone de link externo, e abaixo um badge colorido do tipo da promoção.
- Status: pílula "Aplicada" (verde suave) ou "Candidata" (cinza).
- Preço → promo: preço cheio riscado, seta, preço promocional em destaque; abaixo um "-30%" em vermelho.
- MC atual: valor em R$ (mono).
- MC na promo: valor em R$ em destaque, VERDE se positivo / VERMELHO se negativo; abaixo, quando o frete não foi estimado, um marcador âmbar "s/ frete".
- MC %: a margem percentual no preço promocional, em destaque colorido por sinal; abaixo, menor e cinza, "de X%" (a margem % no preço cheio, como base de comparação).
- Δ MC: a variação (promo − atual) com uma seta (para baixo/vermelho quando piora, para cima/verde quando melhora).
- Ação: botão "Aplicar" (roxo) para candidatas; botão "Remover" (discreto) para aplicadas. Quando a MC na promo é negativa, o "Aplicar" fica com aparência de alerta (contorno em vez de preenchido).
As linhas com MC negativa têm um leve fundo avermelhado. A tabela rola horizontalmente em telas estreitas.

BLOCO 5 — MODAL DE CONFIRMAÇÃO (ao clicar Aplicar/Remover): um card centralizado com a foto e nome do item, um resumo "Preço público: R$ cheio → R$ promo" e "Margem de contribuição: R$ atual → R$ promo" (a MC promo colorida por sinal). Se a MC ficar negativa, uma faixa vermelha de alerta: "Atenção: com este preço a margem fica negativa (R$ X). Você venderia no prejuízo." Um aviso menor: "Esta ação altera o preço público do anúncio no Mercado Livre imediatamente." Botões "Cancelar" e "Confirmar e aplicar" (o confirmar fica vermelho/destrutivo quando a margem é negativa).

ESTADOS: carregando (spinner + "Carregando promoções…"); vazio ("Nenhum item nesse filtro — ajuste os filtros ou sincronize"); item sem custo cadastrado mostra "sem CMV" no lugar da MC.

COMPORTAMENTO: leitura rápida de muitos itens; o contraste atual→promo é o destaque visual; MC negativa tem que saltar aos olhos; números alinhados e monoespaçados.

DADOS (mock com esta forma):
- promocoes: [{ promocao_id, tipo: 'SMART'|'DEAL'|'LIGHTNING', nome, status: 'started'|'pending', n_itens }]
- itens: [{
    mlb, sku, titulo, foto, permalink, promocao_tipo, promocao_nome,
    status: 'started'|'candidate',
    original_price, promo_price, desconto_pct,
    mc_atual, mc_promo, mc_atual_pct, mc_promo_pct, delta_mc,
    mc_negativa: boolean, frete_estimado: boolean,
    offer_id
  }]
- resumo: { total, no_prejuizo, mc_media_promo }
- ações: sincronizar(), aplicar(item), remover(item), confirmar(item, acao).

Exemplos de item (reais):
{ titulo:'Tapete Higiênico Tapetim Great Pets 60x60 30un Branco', sku:'14749', mlb:'MLB3746928601', promocao_tipo:'LIGHTNING', status:'candidate', original_price:48.72, promo_price:34.25, desconto_pct:30, mc_atual:11.29, mc_promo:0.07, mc_atual_pct:0.232, mc_promo_pct:0.002, delta_mc:-11.22, mc_negativa:false, frete_estimado:true }
{ titulo:'Condicionador Pet Clean Cachorros E Gatos 700ml', sku:'10888', mlb:'MLB3953550848', promocao_tipo:'LIGHTNING', status:'candidate', original_price:16.90, promo_price:8.00, desconto_pct:53, mc_atual:-4.24, mc_promo:-15.13, mc_atual_pct:-0.25, mc_promo_pct:-1.89, delta_mc:-10.89, mc_negativa:true, frete_estimado:false }
```
