// Folha de controle da produção (11/nov/2026, pedido do dono): impressa ao iniciar cada lote, fica na bancada.
// UMA página (o dono pediu o básico): ficha do produto, quantidades planejadas, equipe por etapa, mão de obra por
// saco e o checklist "antes de começar". O manual de processos (com o registro de treinamento) sai à parte (manualHtml).
// Só HTML (imprimir / salvar em PDF pelo navegador); os dados chegam prontos de abrirFolhaControle.
import type { Ficha, Lote, ManualSecao, OrdemProducao } from "@/lib/producao";
import { ETAPAS, QUANDO_MANUAL } from "@/lib/producao";

export interface DadosFolha {
  lote: Lote;
  ficha: Ficha | null;
  op: OrdemProducao | null;
  /** etapa → nome de quem foi escalado */
  equipe: Record<string, string>;
  manual: ManualSecao[];
  foto?: string | null;
  /** R$ por saco bom (producao_parametros.pagamento_saco), dividido igualmente entre quem estava no lote */
  pagamento_saco?: number | null;
  gerado_por?: string | null;
  /** folha tirada ANTES de iniciar (no diálogo "Iniciar produção"): o código do lote ainda não existe */
  previa?: boolean;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const n = (v: number | null | undefined, casas = 0) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
const kg = (v: number | null | undefined, casas = 1) => (v == null ? "—" : `${n(v, casas)} kg`);
const dataHora = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—";
const caixa = `<span class="cx"></span>`;
const linhaEscrever = (rot: string, larg = "") => `<div class="esc"><span>${esc(rot)}</span><i style="${larg}"></i></div>`;

/** Seções do manual que valem para este lote: ativas, do produto (ou de todos) e etiquetagem só com etiqueta. */
export function manualDoLote(manual: ManualSecao[], sku: string | null, comEtiqueta: boolean) {
  return manual.filter((m) => m.ativo && (!m.sku || m.sku === sku) && (m.etapa !== "etiquetagem" || comEtiqueta));
}

/** Quantos sacos pesar pela regra da ficha (os N primeiros + 1 a cada X). */
export function pesagensPlanejadas(qtd: number | null, primeiros: number, cada: number | null) {
  if (!qtd) return Math.max(24, primeiros);
  if (!cada) return qtd;
  return Math.min(qtd, primeiros) + Math.ceil(Math.max(0, qtd - primeiros) / cada);
}

const CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1f;margin:0;font-size:11px;line-height:1.3}
.pag{padding:8mm 10mm;page-break-after:always}
.pag:last-child{page-break-after:auto}
.pagto{display:grid;grid-template-columns:1fr 1fr 2fr;gap:6px;margin:4px 0 6px}.pagto div{border:1.5px solid #111;border-radius:6px;padding:5px 8px}.pagto span{display:block;font-size:9.5px;color:#555}.pagto b{font-size:15px}.pagto small{display:block;font-size:9px;color:#555}
h1{font-size:15px;margin:0} h2{font-size:12px;margin:8px 0 4px;padding-bottom:3px;border-bottom:2px solid #6E56CF;text-transform:uppercase;letter-spacing:.4px}
h3{font-size:12px;margin:8px 0 3px}
.topo{display:flex;gap:12px;align-items:center;border:2px solid #1d1d1f;border-radius:8px;padding:8px 10px}
.topo img{width:62px;height:62px;object-fit:cover;border-radius:6px;border:1px solid #ccc}
.codigo{font-family:'JetBrains Mono',ui-monospace,Consolas,monospace;font-size:26px;font-weight:800;letter-spacing:1px}
.cinza{color:#666} .peq{font-size:10px}
.grade{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.kpi{border:1px solid #bbb;border-radius:6px;padding:5px 7px} .kpi span{display:block;font-size:9.5px;color:#666;text-transform:uppercase;letter-spacing:.3px}
.kpi b{font-size:15px} .kpi small{display:block;font-size:9.5px;color:#666}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #999;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#efedf8;font-size:10.5px}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.alto td{height:18px}
.cx{display:inline-block;width:12px;height:12px;border:1.5px solid #1d1d1f;border-radius:2px;vertical-align:-2px;margin-right:6px}
ul.chk{list-style:none;margin:0;padding:0} ul.chk li{padding:3px 0;border-bottom:1px dotted #bbb;display:flex;gap:4px}
ul.chk li .cx{flex-shrink:0;margin-top:1px}
.esc{display:flex;gap:6px;align-items:flex-end;margin:6px 0} .esc span{white-space:nowrap} .esc i{flex:1;border-bottom:1px solid #1d1d1f;height:14px;min-width:60px}
.duas{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tres{display:grid;grid-template-columns:repeat(3,1fr);gap:10px} .tres ul.chk li{font-size:10.5px;padding:2px 0} .tres h3{margin-top:2px}
.pesos{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.pesos table td{height:19px;font-size:10px} .pesos th{font-size:9.5px;padding:3px}
.obs{border:1px solid #999;border-radius:6px;min-height:52px;padding:5px 7px;white-space:pre-wrap}
.aviso{background:#fff6e0;border:1px solid #e0a030;border-radius:6px;padding:6px 8px;margin-top:6px}
.manual ol{margin:2px 0 6px 18px;padding:0} .manual li{margin:2px 0}
.sec{border:1px solid #ccc;border-radius:6px;padding:6px 9px;margin-bottom:7px;page-break-inside:avoid}
.selo{display:inline-block;font-size:9.5px;padding:1px 6px;border-radius:9px;background:#efedf8;color:#4b3aa0;margin-left:6px;font-weight:600}
.rod{margin-top:8px;font-size:9.5px;color:#777}
@page{size:A4;margin:0}
@media screen{body{background:#e9e9ee}.pag{background:#fff;width:210mm;min-height:297mm;margin:10px auto;box-shadow:0 1px 6px rgba(0,0,0,.15)}}
`;

function blocoManual(secoes: ManualSecao[], titulo: string, pessoas: string[]) {
  const grupos = QUANDO_MANUAL.map((q) => ({ q, s: secoes.filter((x) => x.quando === q.id) })).filter((g) => g.s.length);
  const etapaNome = (e: string | null) => ETAPAS.find((x) => x.id === e)?.nome;
  const corpo = grupos.map((g) => `
    <h2>${esc(g.q.nome)}</h2>
    ${g.s.map((s) => `<div class="sec"><h3>${esc(s.titulo)}${s.etapa ? `<span class="selo">${esc(etapaNome(s.etapa))}</span>` : ""}${s.sku ? `<span class="selo">só ${esc(s.sku)}</span>` : ""}</h3>
      <ol>${s.passos.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
      ${s.observacao ? `<div class="cinza">${esc(s.observacao)}</div>` : ""}</div>`).join("")}`).join("");
  const nomes = [...new Set(pessoas.filter(Boolean))];
  const linhas = [...nomes, ...Array(Math.max(2, 5 - nomes.length)).fill("")];
  return `
  <div class="pag manual">
    <h1>${esc(titulo)}</h1>
    <div class="cinza peq">Procedimento padrão da produção. Quem participa do lote lê (ou recebe a orientação) e assina no fim.</div>
    ${corpo || `<p class="cinza">Nenhuma seção do manual cadastrada.</p>`}
    <h2>Registro de treinamento</h2>
    <table class="alto"><thead><tr><th style="width:30%">Nome</th><th style="width:22%">Etapa</th><th>Recebi a orientação deste procedimento (assinatura)</th><th style="width:14%">Data</th></tr></thead>
      <tbody>${linhas.map((x) => `<tr><td>${esc(x)}</td><td></td><td></td><td></td></tr>`).join("")}</tbody></table>
    ${linhaEscrever("Orientação dada por:")}
    ${linhaEscrever("Assinatura de quem orientou:")}
  </div>`;
}

export function folhaControleHtml(d: DadosFolha): string {
  const { lote: l, ficha: f, op } = d;
  const qtd = l.qtd_planejada ?? null;
  const comEtiqueta = !!l.precisa_etiqueta;
  const etapas = ETAPAS.filter((e) => e.id !== "etiquetagem" || comEtiqueta);
  const manual = manualDoLote(d.manual, l.sku, comEtiqueta);
  const antes = manual.filter((m) => m.quando === "antes");
  const minimo = l.nominal_g - l.tolerancia_g;
  const farinhaTotal = qtd ? qtd * Number(l.farinha_padrao_kg) : null;
  const pacotes = qtd && l.mistura_un_por_saco ? Math.ceil(qtd * Number(l.mistura_un_por_saco)) : null;
  const processo = [
    ...(f?.seladora_temp_c != null ? [{ nome: "Temperatura da seladora", valor: `${n(f.seladora_temp_c, 1)} °C` }] : []),
    ...(f?.processo ?? []).filter((x) => x.nome || x.valor),
  ];
  const fechado = l.status !== "aberta";
  // mão de obra: R$ por saco bom, dividido igualmente entre quem estava no lote
  const pag = d.pagamento_saco != null ? Number(d.pagamento_saco) : null;
  const pessoas = [...new Set(Object.values(d.equipe).flatMap((x) => x.split(" → ")).filter(Boolean))];
  const sacosPag = fechado ? Number(l.boas ?? 0) : qtd;
  const totalPag = pag != null && sacosPag ? pag * sacosPag : null;
  const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const pagto = pag == null
    ? `<div class="cinza peq">Mão de obra por saco não cadastrada na ficha deste produto (Editar ficha).</div>`
    : `<div class="pagto">
        <div><span>Pago por saco bom</span><b>${brl(pag)}</b></div>
        <div><span>${fechado ? `${n(sacosPag)} sacos bons` : qtd ? `Planejado: ${n(qtd)} sacos` : "Sacos do lote"}</span><b>${totalPag != null ? brl(totalPag) : "—"}</b></div>
        <div><span>Dividido igualmente entre quem estiver no lote</span><b>${totalPag != null && pessoas.length ? `${brl(totalPag / pessoas.length)} cada` : "—"}</b>
          <small>${pessoas.length ? `${pessoas.length} pessoa(s) escalada(s): ${esc(pessoas.join(", "))}` : "ninguém escalado ainda"}${fechado ? "" : " · o valor final é pelos sacos bons do encerramento"}</small></div>
      </div>`;
  const titulo = `Folha de controle ${l.codigo}`;

  const kpi = (rot: string, val: string, sub = "") => `<div class="kpi"><span>${esc(rot)}</span><b>${val}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;


  const materiais = [
    { item: `Farinha do big bag ${l.big_bag}`, det: f?.farinha ?? "", por: kg(l.farinha_padrao_kg, 3), total: farinhaTotal != null ? kg(farinhaTotal, 0) : "—" },
    ...(l.mistura_sku ? [{ item: `Pacotes ${l.mistura_sku}`, det: l.mistura_nome ?? "", por: `${n(l.mistura_un_por_saco, 3)} pct`, total: pacotes != null ? `${n(pacotes)} pct` : "—" }] : []),
    { item: "Embalagem", det: l.embalagem ?? "", por: "1 un", total: qtd ? `${n(qtd)} un` : "—" },
    ...(comEtiqueta ? [{ item: "Etiqueta", det: f?.etiqueta ?? "", por: "1 un", total: qtd ? `${n(qtd)} un` : "—" }] : []),
  ];

  const pag1 = `
  <div class="pag">
    <div class="topo">
      ${d.foto ? `<img src="${esc(d.foto)}" alt="">` : ""}
      <div style="flex:1">
        <div class="cinza peq">FOLHA DE CONTROLE DA PRODUÇÃO · ${d.previa ? "tirada antes de iniciar: o número final do lote sai ao iniciar (anote no lugar do __)" : "código para a datadora"}</div>
        <div class="codigo">${esc(l.codigo)}</div>
        <div><b>${esc(l.sku)}</b> · ${esc(l.produto)}</div>
      </div>
      <div style="text-align:right" class="peq">
        <div>Início: <b>${d.previa ? "____/____ ____:____" : dataHora(l.inicio_em)}</b></div>
        <div>Big bag: <b>${esc(l.big_bag)}</b>${l.nf_numero ? ` · NF ${esc(l.nf_numero)}` : ""}</div>
        ${op ? `<div>Ordem de produção <b>#${op.id}</b>${op.prioridade === "urgente" ? " · <b>URGENTE</b>" : ""}${op.prazo ? ` · prazo ${op.prazo.slice(8, 10)}/${op.prazo.slice(5, 7)}` : ""}</div>` : ""}
      </div>
    </div>
    ${op?.obs ? `<div class="aviso"><b>Observação da ordem:</b> ${esc(op.obs)}</div>` : ""}

    <h2>Ficha do produto</h2>
    <div class="grade">
      ${kpi("Peso no saco", `${n(l.nominal_g)} g`, `mínimo aceito ${n(minimo)} g`)}
      ${kpi("Vai no saco", kg(l.consumo_padrao_kg, 3), f ? `+${n(f.sobrepeso_pct * 100, 1)}% sobrepeso` : "")}
      ${kpi("Pesagem", l.pesar_cada ? `1 a cada ${n(l.pesar_cada)}` : "todos", `os ${n(l.pesar_primeiros)} primeiros`)}
      ${kpi("Embalagem", esc(l.embalagem ?? "—"), comEtiqueta ? "com etiqueta" : "sem etiqueta")}
    </div>
    ${processo.length ? `<table style="margin-top:6px"><tbody>${processo.map((x) => `<tr><td>${esc(x.nome)}</td><td class="num"><b>${esc(x.valor)}</b></td></tr>`).join("")}</tbody></table>` : ""}
    ${f?.instrucoes ? `<div class="aviso">${esc(f.instrucoes)}</div>` : ""}

    <h2>Planejado</h2>
    <table><thead><tr><th>Material</th><th>Qual</th><th class="num">Por saco</th><th class="num">Para ${qtd ? `${n(qtd)} sacos` : "o lote"}</th><th style="width:15%">Usado (anotar)</th></tr></thead>
      <tbody>${materiais.map((m) => `<tr><td><b>${esc(m.item)}</b></td><td>${esc(m.det)}</td><td class="num">${m.por}</td><td class="num"><b>${m.total}</b></td><td></td></tr>`).join("")}</tbody></table>
    ${qtd ? "" : `<div class="cinza peq">Sem quantidade planejada no lote: anote o total à mão.</div>`}

    <h2>Equipe e mão de obra</h2>
    ${pagto}
    <table class="alto"><thead><tr><th style="width:24%">Etapa</th><th style="width:26%">Escalado</th><th>Quem fez (se mudou)</th><th style="width:11%">Início</th><th style="width:11%">Fim</th><th style="width:13%">Rubrica</th></tr></thead>
      <tbody>${etapas.map((e) => `<tr><td>${esc(e.nome)}</td><td><b>${esc(d.equipe[e.id] ?? "")}</b></td><td></td><td></td><td></td><td></td></tr>`).join("")}</tbody></table>

    <h2>Antes de começar</h2>
    ${antes.length ? `<div class="${antes.length >= 3 ? "tres" : "duas"}">${antes.map((s) => `<div><h3>${esc(s.titulo)}</h3><ul class="chk">${s.passos.map((p) => `<li>${caixa}<span>${esc(p)}</span></li>`).join("")}</ul></div>`).join("")}</div>` : `<p class="cinza">Sem checklist cadastrado no manual.</p>`}
    <div class="duas" style="margin-top:4px">
      ${linhaEscrever("Balança conferida com peso de", "")}
      ${linhaEscrever("leu (g):")}
    </div>
    ${linhaEscrever("Conferido por (assinatura):")}
    <div class="rod">Gerada em ${dataHora(new Date().toISOString())}${d.gerado_por ? ` por ${esc(d.gerado_por)}` : ""} · Os números oficiais são os do app (contagem, pesagem, refugo e fardos). Manual de processos: Produção › Painel › Manual de processos.</div>
  </div>`;


  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title><style>${CSS}</style></head><body>
${pag1}
</body></html>`;
}

/** O manual sozinho (treinamento), com todas as seções ativas. */
export function manualHtml(manual: ManualSecao[]): string {
  const ativas = manual.filter((m) => m.ativo);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Manual de processos da produção</title><style>${CSS}</style></head><body>
${blocoManual(ativas, "Manual de processos da produção", [])}
</body></html>`;
}

/** Escreve o HTML numa aba (aberta no clique, para o navegador não bloquear) e chama a impressão. */
export function escreverEImprimir(w: Window, html: string) {
  w.document.open();
  w.document.write(html.replace("</body>", "<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>"));
  w.document.close();
}

/** Aba de espera aberta no clique (o navegador bloqueia window.open depois de um await). */
export function abrirAbaEspera(): Window | null {
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Gerando a folha…</title><p style="font-family:system-ui;padding:24px;color:#555">Gerando a folha de controle…</p>`);
  }
  return w;
}
