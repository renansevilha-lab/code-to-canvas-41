// Tabela de atacado em HTML simples (imprimir / salvar em PDF pelo navegador).
// completa = com MC e piso (uso interno); sem = só preços e condições (para o representante).
import type { TabelaAtacado } from "@/lib/custos";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const brl = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (n: number) => `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

export function tabelaHtml(t: TabelaAtacado, nome: string, completa: boolean): string {
  const data = t.gerado_em ? new Date(t.gerado_em).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
  const cab = t.faixas.map((f) => `<th>${esc(f.nome)}<small>${esc(f.condicao ?? "")}${completa ? ` · MC ${pct(f.mc)}` : ""}</small></th>`).join("");
  const linhas = t.itens.map((i) => `<tr><td><b>${esc(i.sku)}</b><br><span class="n">${esc(i.nome)}</span></td>${t.faixas.map((f) => {
    const x = i.faixas[f.canal];
    return `<td class="v"><b>${brl(x?.preco)}</b>${completa ? `<small>piso ${brl(x?.piso)}</small>` : ""}</td>`;
  }).join("")}</tr>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(nome)}</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1f;margin:32px;}
h1{font-size:20px;margin:0 0 4px} .sub{color:#666;font-size:13px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{border-bottom:1px solid #ddd;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f4f2fb;font-size:12.5px} th small,td small{display:block;font-weight:400;color:#777;font-size:11px}
td.v{text-align:right;font-variant-numeric:tabular-nums} th:not(:first-child){text-align:right} .n{color:#666;font-size:12px}
.rod{margin-top:16px;font-size:11.5px;color:#777} @media print{body{margin:12mm}}
</style></head><body>
<h1>${esc(nome)}</h1>
<div class="sub">Preço por saco${data ? ` · ${esc(data)}` : ""}${completa && t.cenario ? ` · cenário ${esc(t.cenario)}` : ""}</div>
<table><thead><tr><th>Produto</th>${cab}</tr></thead><tbody>${linhas}</tbody></table>
<div class="rod">${completa ? "Uso interno: MC = margem de contribuição; piso = preço com margem zero." : "Valores sujeitos a confirmação no pedido."}</div>
<script>setTimeout(function(){window.print()},300)</script>
</body></html>`;
}

/** Abre a tabela numa aba (passe a aba já aberta no clique para o navegador não bloquear). */
export function abrirTabelaHtml(t: TabelaAtacado, nome: string, completa: boolean, janela?: Window | null) {
  const w = janela ?? window.open("", "_blank");
  if (!w) return;
  w.document.open();
  w.document.write(tabelaHtml(t, nome, completa));
  w.document.close();
}
