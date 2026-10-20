# Funções apagadas do Supabase (20/out/2026)

Sondas e testes antigos sem uso (sem agendamento, sem chamada no app nem em outras funções, sem chamada nas últimas 24 h), apagadas para liberar vagas no limite de funções do plano. Código guardado aqui caso precise de novo.

Cada pasta tem o código exatamente como estava no ar (baixado com `get_edge_function` do projeto `vhogjofsxyhnyxdyglmq`). Para usar de novo, publique a pasta com o mesmo nome — e lembre que várias pegam "o token mais recente", o que não vale mais com duas contas (CLAUDE.md §2.1).

| slug | versão | verify_jwt | última atualização | arquivos | o que fazia |
|---|---|---|---|---|---|
| `tiny-test-produto` | 22 | false | 2026-05-15 | `index.ts` | Exploração da API v3 do Tiny: busca um produto pelo código, lê o detalhe e, se for kit, tenta os caminhos de composição — serviu para mapear os campos antes do sync de produtos e kits. |
| `ml-test-wallet` | 21 | false | 2026-06-15 | `index.ts` | Testa endpoints do Mercado Pago/Mercado Livre (pagamentos, saldo, saques, movimentos, liberações, faturamento) para ver o que o token do ML alcança. |
| `debug-etiqueta` | 17 | false | 2026-07-17 | `index.ts` | Diagnóstico da etiqueta Shopee (Ottz): cria o documento sem rastreio, espera ficar pronto, baixa o ZIP e grava cada etapa em `debug_etiqueta`. |
| `fulfillment-teste` | 21 | false | 2026-07-20 | `index.ts` | Diagnóstico da etiqueta Shopee testando a hipótese do `package_number`: lê os pacotes do pedido e cria/consulta o documento com o pacote, gravando em `debug_fulfillment`. |
| `svl-probe` | 13 | true | 2026-08-01 | `index.ts` | Já desativada (responde 410). Antes era um repasse só de leitura à API do Tiny da SVL, usado para descobrir a conta. |
| `ml-probe` | 23 | false | 2026-08-12 | `index.ts` | Sonda só de leitura da API do ML: destaques por categoria, produto de catálogo, anúncio, visitas, promoções do vendedor e tarifa por preço/categoria. |
| `ml-saude-probe` | 15 | false | 2026-08-05 | `index.ts` | Já desativada (responde 410). Foi usada para descobrir os formatos da API do ML no módulo Saúde de Anúncios. |
| `ml-debug` | 10 | false | 2026-08-21 | `index.ts` | Repasse só de leitura para qualquer caminho GET da API do ML (`?path=`), usado para procurar onde ficava o prazo de despacho. |
| `tiny-scope-probe` | 7 | true | 2026-08-31 | `index.ts` | Já desativada (responde 410). Conferiu se o app do Tiny de cada conta tinha permissão para emitir nota fiscal (as duas tinham). |
| `shopee-debug-download` | 6 | false | 2026-09-10 | `index.ts` | Mostra a resposta crua do download da etiqueta Shopee de um pedido (caso do documento pronto que baixava 0 bytes no 9.9). |
| `fulfillment-inbound-teste` | 4 | true | 2026-09-25 | `index.ts` | Cópia de ensaio da `fulfillment-inbound` v14 (leitura do PDF de preparação do Full — ML e Amazon — e impressão pelo PrintNode), usada para testar a correção da coluna de produto antes de publicar na função real. |
| `anuncio-publicar-sonda` | 2 | true | 2026-10-10 | `index.ts` | Estudo só de leitura para publicar anúncio direto no marketplace: o que Shopee, ML, Amazon e TikTok exigem e se os apps têm acesso (a única escrita era o validador do ML, que não publica). Igual a `supabase/functions/anuncio-publicar-sonda/` no repositório. |
| `tiny-fiscal-offers` | 6 | false | 2026-09-13 | `index.ts` | Preenchia a planilha temporária `tmp_fiscal_offers`: achava o id do produto no Tiny pelo SKU e puxava NCM, origem e GTIN. |
| `shopee-stock-movement` | 8 | true | 2026-09-01 | `index.ts` | Gravava em `estoque_fulfillment_historico` o estoque do Full da Shopee (SBS) numa data passada, pelo saldo inicial do relatório de movimentação. |
| `amazon-ledger-historico` | 6 | true | 2026-09-18 | `index.ts` | Gravava em `estoque_fulfillment_historico` o estoque FBA no fim de um mês, pelo relatório mensal do Inventory Ledger da Amazon (criar o relatório e depois baixar). |
