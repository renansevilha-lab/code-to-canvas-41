# Fechamento contábil mensal — ACZ Pet

Rotina mensal para a contabilidade (Super Goiás, grupo "105 - SG ACZ PET"). Só a **ACZ PET** — CNPJ 37.393.638/0001-40.
SVL Store e as notas da Jussara ficam fora.

## Pastas

```
fechamento/
  README.md                         este checklist
  config/classificacao_entradas.json  quem é revenda, embalagem, imobilizado… (editável)
  scripts/
    parse_nfe.mjs                   lê os ZIPs/pastas de XML → JSON (notas, itens, eventos, CT-e)
  saidas/AAAA-MM/                   tudo o que é gerado no mês (fora do git: tem dado fiscal)
```

## De onde vêm as notas

Desde 18/nov/2026 as NF-e são lidas **direto do Tiny, toda noite** (edge function `fiscal-nfe`, cron 22h–6h): os dados ficam nas tabelas `fiscal_nfe` e `fiscal_nfe_item` e o XML original, compactado, no bucket privado `fiscal-xml`. A carga das notas antigas anda para trás, do mês mais recente para o mais antigo. Detalhes em `docs/fiscal-nfe.sql`.
O `parse_nfe.mjs` (ZIP exportado à mão) fica como reserva e para conferência.

Os scripts são em Node (o `node` do projeto, sem instalar nada). Rodar sempre da raiz do repositório.

## Regras fixas

1. Fora de todo fechamento: pagamentos à RVA (aluguel pessoal) e qualquer lançamento do cartão XP.
2. No ZIP de saída do Tiny vêm notas da Jussara Sevilha Marangoni (46.176.256/0001-55): só conta emitente 37393638000140.
3. Canceladas = evento 110111 no próprio ZIP: fora do faturamento, com quantidade e valor informados à parte.
4. Faturamento oficial = XML. Número de API (view_kpi_pedidos_dia) é gerencial e de conferência; sempre rotular.
5. Nunca digitar senha. A Shopee pede a senha a cada aba do financeiro: parar e pedir ao Renan.
6. Chrome: para a ACZ, o navegador com o logo (Ottz). O com a foto é o da Bumi.
7. Imposto é ESTIMATIVA para discutir com a contabilidade, nunca apuração.

## Os quatro números que a contabilidade confirma (conferidos com jul e ago/2026)

- **Faturamento Bruto** = soma do `vNF` das NF-e de saída (tpNF 1) emitidas pela ACZ, autorizadas (cStat 100 ou 150), sem as canceladas.
- **Devoluções de venda** = soma do `vNF` das NF-e de entrada emitidas pela própria ACZ com finalidade 4 (CFOP 1202/2202).
  Vêm num ZIP à parte do Tiny (notas de entrada emitidas pela empresa). "Retorno de depósito" (1949/2949) não entra.
- **Compras** = soma do `vNF` das NF-e de terceiros no ZIP de entrada.
  Em ago/2026 o confirmado foi o total menos a NF 16381 da Santa Lucia (R$ 57.000,00): conferir com a contabilidade o motivo.
- **Faturamento Líquido** = Bruto − Devoluções.

Histórico confirmado: 07/2026 Compras 303.671,13 · Bruto 360.491,17 · Devoluções 4.859,75 — 08/2026 229.754,98 · 309.396,12 · 276,61 — 09/2026 178.549,83 · 253.138,50 · 421,81.

## Rotina

1. **Dia 1–2** — exportar do Tiny (Chrome da Ottz) os XMLs do mês: saída, entrada de terceiros e entrada emitida pela ACZ (devoluções). CT-e se houver.
   `node fechamento/scripts/parse_nfe.mjs fechamento/saidas/AAAA-MM/xml.json <zips…>` · subir os ZIPs no Drive do mês · avisar no grupo.
2. **Até o dia 8** — NFS-e da Shopee (pedir a senha), fatura do ML que fecha dia 19, faturas da Amazon; relatório de taxas com a diferença NF × sistema.
3. Gerar: Excel fiscal, despesas (PDF + planilha), imobilizado, pagamentos a fornecedores, estimativa de impostos.
4. Rodar as checagens e mostrar os alertas ANTES de enviar.
5. Montar a pasta do Drive do mês (ou `saidas/AAAA-MM/` para arrastar) e o texto do WhatsApp, sem markdown.
6. Quando a contabilidade mandar os quatro números, comparar com o XML.
7. Mar/jun/set/dez: estoque trimestral (apoio: `estoque_snapshot_diario`, gravado todo dia 23h50).

Prazos: XMLs até o 2º dia útil; documentos contábeis até o dia 10.
