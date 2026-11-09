// Relatório da equipe da Produção (09/nov/2026): quem estava em cada lote e quanto cada um produziu.
// Os números vêm prontos de producao_relatorio_equipe (banco); aqui só o HTML (imprimir / salvar em PDF).
// Sem imports e sem JSX de propósito: o mesmo arquivo gera o PDF fora do app (node --experimental-strip-types).

export interface RelEquipe {
  de: string; ate: string; gerado_em: string;
  resumo: { lotes: number; sacos: number; horas_linha: number; homem_horas: number; lotes_limpos: number; sacos_limpos: number; horas_linha_limpas: number; homem_horas_limpas: number; un_h_linha: number | null; un_homem_hora: number | null };
  pessoas: Array<{ pessoa_id: string; nome: string; lotes: number; sacos_dos_lotes: number; parcela: number; horas: number; horas_limpas: number; lotes_limpos: number; un_hora: number | null }>;
  produtos: Array<{ sku: string; produto: string | null; lotes: number; sacos: number; lotes_limpos: number; un_h_linha: number | null; un_homem_hora: number | null }>;
  equipe: Array<{ pessoas: number; lotes: number; sacos: number; un_h_linha: number | null; un_homem_hora: number | null }>;
  lotes: Array<{ codigo: string; sku: string; produto: string | null; dia: string; sacos: number; min: number; homem_horas: number; un_h_linha: number | null;
    un_homem_hora: number | null; limpo: boolean; motivo: string | null; pessoas: Array<{ nome: string; horas: number; parcela: number }> }>;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const n = (v: number | null | undefined, casas = 0) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const data = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const dur = (min: number) => { const t = Math.round(min); return t < 60 ? `${t} min` : `${Math.floor(t / 60)}h${String(t % 60).padStart(2, "0")}`; };
const curto = (s: string | null) => (s ?? "").replace(/\s+/g, " ").replace(/Alta Absorção Anti Odor Gatos/i, "").replace(/\s+-\s*$/, "").trim();
const CORES = ["#6E56CF", "#E0A030", "#2F9E6E", "#D9534F", "#3B82F6", "#9C6ADE"];

export function relatorioEquipeHtml(r: RelEquipe): string {
  const cor = Object.fromEntries(r.pessoas.map((p, i) => [p.nome, CORES[i % CORES.length]]));
  const totalParcela = r.pessoas.reduce((s, p) => s + Number(p.parcela), 0) || 1;
  const maxParcela = Math.max(1, ...r.pessoas.map((p) => Number(p.parcela)));
  const gerado = new Date(r.gerado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

  const kpi = (rot: string, val: string, sub = "") => `<div class="kpi"><span>${esc(rot)}</span><b>${val}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;

  const pessoas = r.pessoas.map((p) => `
    <tr>
      <td class="nome"><span class="dot" style="background:${cor[p.nome]}"></span><b>${esc(p.nome)}</b></td>
      <td class="num">${n(p.lotes)}</td>
      <td class="num">${n(p.horas_limpas, 1)} h</td>
      <td class="barra"><div class="trilho"><div style="width:${(Number(p.parcela) / maxParcela) * 100}%;background:${cor[p.nome]}"></div></div>
        <b>${n(p.parcela)}</b> sacos <small>${n((Number(p.parcela) / totalParcela) * 100, 0)}%</small></td>
      <td class="num">${n(p.un_hora, 1)}</td>
      <td class="num">${n(p.sacos_dos_lotes)}</td>
    </tr>`).join("");

  const produtos = r.produtos.map((p) => `
    <tr><td><b>${esc(p.sku)}</b> <span class="cinza">${esc(curto(p.produto))}</span></td><td class="num">${n(p.lotes)}</td>
    <td class="num">${n(p.sacos)}</td><td class="num">${n(p.un_h_linha, 1)}</td><td class="num">${n(p.un_homem_hora, 1)}</td>
    <td class="num cinza">${n(p.lotes_limpos)}</td></tr>`).join("");

  const equipe = r.equipe.map((e) => `<div class="eq"><b>${e.pessoas} pessoas</b><span>${n(e.un_homem_hora, 1)} sacos por pessoa/hora</span>
    <small>linha ${n(e.un_h_linha, 1)} sacos/h · ${n(e.lotes)} lotes · ${n(e.sacos)} sacos</small></div>`).join("");

  const lotes = r.lotes.map((l) => `
    <tr class="${l.limpo ? "" : "fora"}">
      <td>${data(l.dia)}</td>
      <td><b>${esc(l.codigo)}</b><br><span class="cinza">${esc(l.sku)} · ${esc(curto(l.produto))}</span></td>
      <td class="num">${n(l.sacos)}</td>
      <td class="num">${dur(Number(l.min))}</td>
      <td>${l.pessoas.map((p) => `<span class="chip" style="border-color:${cor[p.nome] ?? "#999"}"><i style="background:${cor[p.nome] ?? "#999"}"></i>${esc(p.nome)} <b>${n(p.parcela)}</b></span>`).join(" ")}</td>
      <td class="num">${l.limpo ? n(l.un_h_linha, 1) : "—"}</td>
      <td>${l.limpo ? `<span class="ok">ok</span>` : `<span class="aviso">${esc(l.motivo)}</span>`}</td>
    </tr>`).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Produção — relatório da equipe ${data(r.de)} a ${data(r.ate)}</title>
<style>
@page{size:A4;margin:12mm}
*{box-sizing:border-box} body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;color:#1f1d2b;margin:0;font-size:11.5px}
.topo{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #6E56CF;padding-bottom:8px;margin-bottom:12px}
h1{font-size:20px;margin:0} .topo .sub{color:#666;font-size:12px} h2{font-size:13.5px;margin:18px 0 6px;color:#3d2f8f}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.kpi{background:#f4f2fb;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.kpi span{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.3px} .kpi b{font-size:18px} .kpi small{font-size:10px;color:#777}
table{width:100%;border-collapse:collapse} th{font-size:10px;text-transform:uppercase;letter-spacing:.3px;color:#777;text-align:left;padding:5px 6px;border-bottom:1.5px solid #ddd}
td{padding:6px;border-bottom:1px solid #eee;vertical-align:middle} .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap} th.num{text-align:right}
.cinza{color:#777;font-size:10.5px} td.nome{white-space:nowrap} .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.barra{width:42%} .trilho{background:#eee;border-radius:5px;height:9px;margin-bottom:3px;overflow:hidden} .trilho div{height:100%;border-radius:5px}
.barra small{color:#777;margin-left:4px}
.eqs{display:flex;gap:10px} .eq{flex:1;border:1px solid #e3def7;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px} .eq span{font-size:13px;font-weight:600} .eq small{color:#777}
.chip{display:inline-flex;align-items:center;gap:4px;border:1px solid;border-radius:12px;padding:1px 7px;margin:1px 0;font-size:10.5px;white-space:nowrap}
.chip i{width:7px;height:7px;border-radius:50%;display:inline-block}
tr.fora td{color:#888} .ok{color:#2F9E6E;font-weight:600} .aviso{color:#B7791F;font-size:10.5px}
.nota{margin-top:14px;font-size:10px;color:#777;line-height:1.5} tr{page-break-inside:avoid}
</style></head><body>
<div class="topo">
  <div><h1>Produção — relatório da equipe</h1><div class="sub">${data(r.de)} a ${data(r.ate)} · ${n(r.resumo.lotes)} lotes encerrados</div></div>
  <div class="sub">Gerado em ${esc(gerado)}</div>
</div>
<div class="kpis">
  ${kpi("Sacos produzidos", n(r.resumo.sacos))}
  ${kpi("Lotes", n(r.resumo.lotes), `${n(r.resumo.lotes_limpos)} com apontamento bom`)}
  ${kpi("Horas de linha", n(r.resumo.horas_linha_limpas, 1), "lotes bons")}
  ${kpi("Horas de pessoas", n(r.resumo.homem_horas_limpas, 1), "lotes bons")}
  ${kpi("Sacos por hora", n(r.resumo.un_h_linha, 1), "da linha, lotes bons")}
  ${kpi("Por pessoa/hora", n(r.resumo.un_homem_hora, 1), "sacos, lotes bons")}
</div>

<h2>Quem produziu quanto</h2>
<table><thead><tr><th>Pessoa</th><th class="num">Lotes</th><th class="num">Horas medidas</th><th>Sacos (parte dela)</th><th class="num">Sacos/hora</th><th class="num">Sacos dos lotes em que estava</th></tr></thead>
<tbody>${pessoas}</tbody></table>

<h2>Produtividade por produto</h2>
<table><thead><tr><th>Produto</th><th class="num">Lotes</th><th class="num">Sacos</th><th class="num">Sacos/h da linha</th><th class="num">Por pessoa/hora</th><th class="num">Lotes bons</th></tr></thead>
<tbody>${produtos}</tbody></table>

${equipe ? `<h2>Tamanho da equipe (mandioca pura, lotes bons)</h2><div class="eqs">${equipe}</div>` : ""}

<h2>Lote a lote</h2>
<table><thead><tr><th>Dia</th><th>Lote</th><th class="num">Sacos</th><th class="num">Duração</th><th>Quem estava (sacos de cada um)</th><th class="num">Sacos/h</th><th>Apontamento</th></tr></thead>
<tbody>${lotes}</tbody></table>

<div class="nota">
  <b>Como ler:</b> a parte de cada pessoa = sacos do lote × (horas dela no lote ÷ horas de todos no lote). Hoje as etapas são marcadas com a
  mesma janela do lote, então quem estava divide o lote em partes iguais; quando cada etapa tiver início e fim próprios, a divisão passa a seguir as horas.
  Sacos por hora usa só lotes com apontamento bom (entre 10 min e 4 h — misturas até 12 h — e, na mandioca pura, entre 40 e 150 sacos/h).
  Horas = só dos lotes bons (lote esquecido aberto inflaria as horas). Lote em cinza = apontamento que não serve para medir tempo (fechado na hora, esquecido aberto, sem quantidade); os sacos dele contam no total.
</div>
</body></html>`;
}
