// ============================================================================
// Ordem de compra para imprimir / salvar em PDF (18/nov/2026, pedido do dono).
// Mesmo layout do "Modelo de Documento Bumi" que a skill agente-compras gera com
// scripts/ordem_compra_bumi.py: faixa ondulada verde + azul, logo BUMI pet care,
// "ORDEM DE COMPRA / Nº / Emitido em", régua preta, título coral (Anton), blocos
// creme Fornecedor e Faturamento/Entrega, faixa de condições, tabela com cabeçalho
// preto (foto, SKU, descrição + GTIN/cód./fardos, qtd, un, unitário, total),
// totais e assinaturas. Só HTML (sem imports): o app abre numa aba e imprime; o
// mesmo arquivo roda no Node para conferir o resultado.
// ============================================================================

export interface OcParte { razao: string; cnpj?: string | null; ie?: string | null; endereco?: string | null; cidade?: string | null; contato?: string | null; responsavel?: string | null }
export interface OcItem {
  sku: string; produto: string; gtin?: string | null; cod?: string | null;
  qtd: number; un: string; valor: number; foto?: string | null; detalhe?: string | null;
  /** quantos fardos/caixas a quantidade representa (só para o rodapé de totais) */
  fardos?: number | null;
}
export interface OcPdf {
  /** número da OC no Tiny (ex.: "749"); vazio = proposta (rascunho do app) */
  numero: string | null;
  /** referência interna quando não há número (ex.: "SUG-2") */
  referencia?: string | null;
  emissao: string;
  comprador: OcParte;
  fornecedor: OcParte;
  condicoes: { pagamento: string; frete: string; previsao: string; comprador: string };
  observacoes?: string[];
  itens: OcItem[];
  /** URL absoluta do logo oficial (public/logos/logotipo-bumi.png) */
  logoUrl: string;
}

/** Dados fixos do comprador (os mesmos da skill agente-compras). */
export const COMPRADOR_PADRAO: OcParte = {
  razao: "ACZ PET ARTIGOS PARA ANIMAIS DE ESTIMAÇÃO LTDA", cnpj: "37.393.638/0001-40", ie: "239.232.330.119",
  endereco: "Rua São Cristóvão, 62 · Jardim São Francisco", cidade: "Caieiras/SP · CEP 03.545-050",
  contato: "(11) 2791-8795 · www.ottzpet.com.br", responsavel: "Renan Sevilha",
};

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const num = (v: number, casas = 2) => v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const brl = (v: number) => "R$ " + num(v);

/** Faixa verde com laços azuis em duas fileiras (trocoide), como no modelo. */
function faixaOndas(w: number, h: number): string {
  const a = h * 0.085, b = h * 0.17;
  const linhas: string[] = [];
  for (const [ycFrac, sinal, desloc] of [[0.71, 1, 0], [0.29, -1, Math.PI]] as const) {
    const pts: string[] = [];
    for (let th = -2 * Math.PI; ; th += 0.08) {
      const px = a * th - b * Math.sin(th + desloc);
      const pyPdf = h * ycFrac + sinal * b * Math.cos(th + desloc); // origem embaixo (PDF)
      pts.push(`${px.toFixed(2)},${(h - pyPdf).toFixed(2)}`);
      if (px > w + 2 * b) break;
    }
    linhas.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="#4EC3EA" stroke-width="${(h * 0.12).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  return `<svg class="ondas" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
  <defs><clipPath id="cf"><rect x="0" y="0" width="${w}" height="${h}" rx="7"/></clipPath></defs>
  <g clip-path="url(#cf)"><rect x="0" y="0" width="${w}" height="${h}" fill="#0F5B2E"/>${linhas.join("")}</g></svg>`;
}

export function ordemCompraHtml(d: OcPdf): string {
  const total = Math.round(d.itens.reduce((s, i) => s + i.qtd * i.valor, 0) * 100) / 100;
  const unidades = d.itens.reduce((s, i) => s + i.qtd, 0);
  const fardos = d.itens.reduce((s, i) => s + (i.fardos ?? 0), 0);
  const rotuloNum = d.numero ? `Nº OC-${esc(d.numero)}` : `Proposta${d.referencia ? ` ${esc(d.referencia)}` : ""}`;
  const titulo = d.numero ? `Ordem de Compra OC-${d.numero}` : `Ordem de Compra — Proposta${d.referencia ? ` ${d.referencia}` : ""}`;
  const comp = d.comprador, forn = d.fornecedor;

  const bloco = (tit: string, linhas: Array<string | null | undefined>) => {
    const [primeira, ...resto] = linhas;
    return `<div class="bloco"><div class="bt">${tit}</div><div class="b0">${esc(primeira)}</div>${resto.filter(Boolean).map((x) => `<div class="bx">${esc(x)}</div>`).join("")}</div>`;
  };
  const docF = [forn.cnpj ? `CNPJ ${forn.cnpj}` : null, forn.ie ? `IE ${forn.ie}` : null].filter(Boolean).join(" · ");
  const docC = [comp.cnpj ? `CNPJ ${comp.cnpj}` : null, comp.ie ? `IE ${comp.ie}` : null].filter(Boolean).join(" · ");

  const linhasItens = d.itens.map((i) => {
    const det = [i.detalhe, i.gtin ? `GTIN ${i.gtin}` : null, i.cod ? `Cód. fornecedor ${i.cod}` : null].filter(Boolean).join(" · ");
    const foto = i.foto
      ? `<img src="${esc(i.foto)}" alt="" onerror="this.outerHTML='<div class=&quot;semfoto&quot;>sem foto</div>'">`
      : `<div class="semfoto">sem foto</div>`;
    return `<tr><td class="ft">${foto}</td><td class="sku">${esc(i.sku)}</td>
      <td><div class="pd">${esc(i.produto)}</div>${det ? `<div class="dt">${esc(det)}</div>` : ""}</td>
      <td class="r q">${num(i.qtd, 0)}</td><td class="un">${esc(/^fd/i.test(i.un) ? i.un : i.un.toLowerCase())}</td>
      <td class="r">${brl(i.valor)}</td><td class="r t">${brl(i.qtd * i.valor)}</td></tr>`;
  }).join("");

  const totais = [
    ["Itens", String(d.itens.length)],
    ...(fardos ? [["Fardos", num(fardos, 0)]] : []),
    ["Unidades", num(unidades, 0)],
    ["Total de produtos", brl(total)],
    ["IPI", brl(0)],
  ].map(([r, v]) => `<tr><td class="tr">${r}</td><td class="tv">${v}</td></tr>`).join("");

  const obs = d.observacoes?.length
    ? `<div class="obs"><div class="bt">OBSERVAÇÕES</div>${d.observacoes.map((o) => `<div class="ob">• ${esc(o)}</div>`).join("")}</div>` : "";

  const rodape = `${comp.razao} · CNPJ ${comp.cnpj ?? ""} · ${comp.contato ?? ""}`.replace(/"/g, "'");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Figtree:wght@400;600;800&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:14mm 14.8mm 17mm;
  @bottom-left{content:"${esc(rodape)}";font:7pt Figtree,Arial,sans-serif;color:#6F6A63}
  @bottom-right{content:"Página " counter(page);font:7pt Figtree,Arial,sans-serif;color:#6F6A63}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:Figtree,Arial,sans-serif;color:#2B2B2B;font-size:8.6pt;line-height:1.35;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.folha{max-width:180.4mm;margin:0 auto}
@media screen{body{background:#eee}.folha{background:#fff;padding:14mm 14.8mm;margin:12px auto;max-width:210mm;box-shadow:0 2px 12px rgba(0,0,0,.15)}}
.ondas{display:block;width:100%;height:17.6mm}
.topo{display:flex;justify-content:space-between;align-items:flex-end;margin-top:4mm}
.topo img{height:12.7mm;width:auto;display:block}
.tdir{text-align:right;color:#111}
.tdir .k{font-weight:800;font-size:12.5pt;letter-spacing:.01em}
.tdir .n{font-size:8.4pt;margin-top:1.5mm}.tdir .n b{font-weight:800}
.regua{height:0;border-top:2.2pt solid #111;margin:3.6mm 0 5mm}
h1{font-family:Anton,Impact,sans-serif;font-weight:400;color:#F2471C;font-size:30pt;line-height:1.1;margin:0 0 4mm}
.blocos{display:grid;grid-template-columns:1fr 1fr;gap:3.5mm;margin-bottom:3.5mm}
.bloco{background:#F2E6CF;border-radius:7pt;padding:3.5mm 3.5mm 3.9mm 4.2mm}
.bt{font-weight:800;color:#111;font-size:8.6pt;margin-bottom:1mm}
.b0{font-weight:600;color:#111;font-size:8.6pt}
.bx{font-size:8.4pt}
.cond{display:grid;grid-template-columns:repeat(4,1fr);border:1pt solid #111;border-radius:7pt;margin-bottom:4.2mm;overflow:hidden}
.cond>div{padding:2.5mm 3.5mm 2.8mm;border-right:.6pt solid #111}.cond>div:last-child{border-right:0}
.cr{font-weight:600;font-size:6.8pt;color:#6F6A63;letter-spacing:.02em}
.cv{font-weight:800;font-size:9pt;color:#111}
table.itens{width:100%;border-collapse:separate;border-spacing:0}
table.itens thead th{background:#111;color:#fff;font-weight:600;font-size:8pt;text-align:left;padding:2.5mm 2.8mm;white-space:nowrap}
table.itens thead th:first-child{border-top-left-radius:6pt}table.itens thead th:last-child{border-top-right-radius:6pt}
table.itens thead th.r{text-align:right}
table.itens td{padding:1.4mm 2.8mm 1.6mm;border-bottom:.6pt solid #E6DCC6;vertical-align:middle}
table.itens tr{break-inside:avoid}
thead{display:table-header-group}
td.ft{width:13.4mm}td.ft img{width:10.6mm;height:10.6mm;object-fit:contain;display:block;background:#fff}
.semfoto{width:10.6mm;height:10.6mm;border:.6pt solid #E6DCC6;background:#FAF5EA;border-radius:4pt;font-size:5.2pt;color:#6F6A63;display:flex;align-items:center;justify-content:center}
td.sku{width:15.5mm;font-size:8.4pt}
.pd{font-size:8.4pt;color:#111;line-height:1.26}
.dt{font-size:6.9pt;color:#6F6A63;line-height:1.28;margin-top:.3mm}
td.r{text-align:right;white-space:nowrap;font-size:8.4pt}
td.q,td.t{font-weight:600}
td.un{font-size:7.6pt;white-space:nowrap}
.fim{break-inside:avoid;margin-top:3.5mm}
.totais{margin-left:auto;width:95mm;border-collapse:collapse}
.totais td{padding:.7mm 2.8mm;text-align:right;font-size:8.8pt}
.totais td.tr{color:#6F6A63}.totais td.tv{color:#111;font-weight:600;width:35mm}
.totais tr.tt td{border-top:1.4pt solid #111;padding-top:2.1mm}
.totais tr.tt td.tr{color:#111;font-weight:800}
.totais tr.tt td.tv{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:15pt}
.obs{background:#FAF5EA;border-radius:7pt;padding:3.2mm 4.2mm 3.5mm;margin-top:4.2mm}
.ob{font-size:8.4pt;line-height:1.38}
.ass{display:grid;grid-template-columns:1fr 1fr;margin-top:10mm;font-size:7.6pt;color:#6F6A63}
</style></head><body><div class="folha">
${faixaOndas(511.28, 50)}
<div class="topo"><img src="${esc(d.logoUrl)}" alt="BUMI pet care">
  <div class="tdir"><div class="k">ORDEM DE COMPRA</div><div class="n"><b>${rotuloNum} ·</b> Emitido em ${esc(d.emissao)}</div></div></div>
<div class="regua"></div>
<h1>Ordem de Compra</h1>
<div class="blocos">
  ${bloco("FORNECEDOR", [forn.razao, docF, forn.endereco, forn.cidade, forn.contato ? `Fone: ${forn.contato}` : null])}
  ${bloco("FATURAMENTO E ENTREGA", [comp.razao, docC, comp.endereco, comp.cidade, comp.contato])}
</div>
<div class="cond">
  <div><div class="cr">PAGAMENTO</div><div class="cv">${esc(d.condicoes.pagamento)}</div></div>
  <div><div class="cr">FRETE</div><div class="cv">${esc(d.condicoes.frete)}</div></div>
  <div><div class="cr">PREVISÃO DE ENTREGA</div><div class="cv">${esc(d.condicoes.previsao)}</div></div>
  <div><div class="cr">COMPRADOR</div><div class="cv">${esc(d.condicoes.comprador)}</div></div>
</div>
<table class="itens"><thead><tr><th></th><th>SKU</th><th>Descrição</th><th class="r">Qtd.</th><th>Un.</th><th class="r">Valor unit.</th><th class="r">Total</th></tr></thead>
<tbody>${linhasItens}</tbody></table>
<div class="fim">
  <table class="totais">${totais}<tr class="tt"><td class="tr">Total do pedido</td><td class="tv">${brl(total)}</td></tr></table>
  ${obs}
  <div class="ass"><div>______________________________<br>${esc(comp.responsavel ?? "Comprador")} · Comprador</div><div>______________________________<br>Fornecedor · de acordo</div></div>
</div>
</div></body></html>`;
}
