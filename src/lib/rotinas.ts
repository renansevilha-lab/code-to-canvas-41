// ============================================================================
// Rotinas da Operação (16/nov/2026) — monta as rotinas a partir do MESMO manual do /processos
// (manual_secoes, manual_itens, producao_manual). Uma fonte só para a página /rotinas e para o PDF:
// a página desenha `Rotina[]` e o PDF é `rotinasPdfHtml(Rotina[])`, então os dois nunca divergem.
// Convenções (sem coluna nova no manual — docs/rotinas-operacao.sql):
//   tags do item   rotina:RESP-xx · fase:<nome> · lugar:sistema · proibido
//   callouts seção {tipo:"warn"|"regra"|"info", titulo?, texto} · {tipo:"temporario", titulo?, texto} · {tipo:"numerar"}
// ============================================================================
import type { ManualSecao } from "@/lib/producao";
import { NOMES_DIAS, type Item, type Membro, type Secao } from "@/lib/manual";

export type CalloutRot = { tipo: string; titulo?: string; texto?: string };
export type TagEtapa = { texto: string; tipo: "pessoa" | "niko" | "sistema" | "producao" | "vazio" };

export type Etapa = {
  chave: string;              // 'mi:<uuid>' ou 'pm:<id>'
  item: Item | null;          // item do manual (rotinas diárias marcam por ele no manual_progresso)
  titulo: string;
  detalhe: string | null;
  tag: TagEtapa;
  hojeNao: boolean;           // item com dias definidos que não roda hoje
};
export type Fase = { nome: string; etapas: Etapa[] };
export type Pergunta = { item: Item; texto: string; abre: "sim" | "nao" | "nunca" | null; campo: string | null; tag: TagEtapa };
export type Regra = { titulo: string | null; texto: string; principal: boolean };
export type Rotina = {
  code: string;
  titulo: string;
  descricao: string | null;
  frequencia: string | null;
  responsavel: string | null;
  regras: Regra[];
  temporarias: Regra[];
  proibidos: Array<{ titulo: string; tag: TagEtapa }>;
  tabela: { head: string[]; rows: string[][] } | null;
  fases: Fase[];
  perguntas: Pergunta[];
  numerar: boolean;
  producao: boolean;          // marcação por produção (rotina_execucao), não por dia
};

const temTag = (i: Item, t: string) => (i.tags ?? []).includes(t);
const tagCom = (i: Item, prefixo: string) => (i.tags ?? []).find((t) => t.startsWith(prefixo))?.slice(prefixo.length) ?? null;

/** Tags de uso interno (montagem das rotinas) — não aparecem como etiqueta no /processos. */
export const tagInterna = (t: string) => t.includes(":") || t === "proibido";

const PRODUCAO = "RESP-09";
const FASE_PRODUCAO: Record<string, string> = { antes: "Antes de produzir", durante: "Produção", depois: "Para encerrar" };

export function montarRotinas(p: { secoes: Secao[]; itens: Item[]; membros: Membro[]; producao: ManualSecao[]; dow: number }): Rotina[] {
  const nome = (id: string | null) => (id ? p.membros.find((m) => m.id === id)?.nome ?? id : null);
  const tagDe = (i: Item, secao: Secao | undefined): TagEtapa => {
    if (temTag(i, "lugar:sistema")) return { texto: "No sistema", tipo: "sistema" };
    const r = i.responsavel_id ?? secao?.responsavel_id ?? null;
    if (!r) return { texto: "", tipo: "vazio" };
    return { texto: nome(r) ?? r, tipo: r === "niko" ? "niko" : "pessoa" };
  };
  const roda = (i: Item) => !i.dias?.length || i.dias.includes(p.dow);
  const diasTxt = (i: Item) => (i.dias?.length ? `Só ${i.dias.map((d) => NOMES_DIAS[d].toLowerCase()).join(" e ")}` : null);

  return p.secoes
    .filter((s) => s.ativo && s.tipo === "processo")
    .sort((a, b) => a.ordem - b.ordem)
    .map((s): Rotina => {
      const callouts = ((s.callouts ?? []) as unknown as CalloutRot[]);
      const proprios = p.itens.filter((i) => i.ativo && i.secao_code === s.code);
      const deFora = p.itens.filter((i) => i.ativo && i.secao_code !== s.code && temTag(i, `rotina:${s.code}`));
      const secaoDo = (i: Item) => p.secoes.find((x) => x.code === i.secao_code);
      const todos = [...deFora, ...proprios];

      const fasesMap = new Map<string, Etapa[]>();
      const pushFase = (f: string, e: Etapa) => { if (!fasesMap.has(f)) fasesMap.set(f, []); fasesMap.get(f)!.push(e); };
      // ordem: itens da Rotina Matinal primeiro (já vêm em "Ao chegar"), depois os da própria seção
      for (const i of todos.filter((x) => x.tipo === "check" && !temTag(x, "proibido"))
        .sort((a, b) => (a.secao_code === s.code ? 1 : 0) - (b.secao_code === s.code ? 1 : 0) || a.ordem - b.ordem)) {
        const sec = secaoDo(i);
        const fase = tagCom(i, "fase:") ?? (i.turno === "inicio" ? "Ao chegar" : i.turno === "fim" ? "Para encerrar" : "Durante o dia");
        pushFase(fase, { chave: `mi:${i.id}`, item: i, titulo: i.texto, detalhe: diasTxt(i), tag: tagDe(i, sec?.code === s.code ? s : sec), hojeNao: !roda(i) });
      }

      let fases: Fase[] = [...fasesMap.entries()].map(([nome, etapas]) => ({ nome, etapas }));
      const producao = s.code === PRODUCAO;
      if (producao) {
        // passos do sistema (itens RESP-09) na fase deles + as seções do Manual de processos da Produção
        const out: Fase[] = [];
        for (const q of ["antes", "durante", "depois"] as const) {
          const nomeFase = FASE_PRODUCAO[q];
          const doSistema = fasesMap.get(nomeFase) ?? [];
          const doManual = p.producao.filter((m) => m.ativo && m.quando === q && !m.sku).sort((a, b) => a.ordem - b.ordem)
            .map((m): Etapa => ({ chave: `pm:${m.id}`, item: null, titulo: m.titulo, detalhe: m.passos.join(" · "), tag: { texto: "Na produção", tipo: "producao" }, hojeNao: false }));
          const etapas = q === "depois" ? [...doManual, ...doSistema] : [...doSistema, ...doManual];
          if (etapas.length) out.push({ nome: nomeFase, etapas });
          fasesMap.delete(nomeFase);
        }
        for (const [nomeF, etapas] of fasesMap) out.push({ nome: nomeF, etapas });
        fases = out;
      } else {
        const ordemFase = (n: string) => (n === "Ao chegar" ? 0 : n === "Para encerrar" ? 2 : 1);
        fases.sort((a, b) => ordemFase(a.nome) - ordemFase(b.nome));
      }

      const regras: Regra[] = [];
      let principal = false;
      for (const c of callouts) {
        if (!c.texto || !["warn", "regra", "info"].includes(c.tipo)) continue;
        const ehPrincipal = !principal && (c.tipo === "warn" || c.tipo === "regra");
        if (ehPrincipal) principal = true;
        regras.push({ titulo: c.titulo ?? null, texto: c.texto, principal: ehPrincipal });
      }
      if (producao) {
        for (const m of p.producao.filter((x) => x.ativo && x.quando === "sempre" && !x.sku).sort((a, b) => a.ordem - b.ordem)) {
          regras.push({ titulo: m.titulo, texto: m.passos.join(" "), principal: !principal });
          principal = true;
        }
      }
      regras.sort((a, b) => Number(b.principal) - Number(a.principal));

      return {
        code: s.code,
        titulo: s.titulo,
        descricao: s.descricao,
        frequencia: s.frequencia,
        responsavel: nome(s.responsavel_id),
        regras,
        temporarias: callouts.filter((c) => c.tipo === "temporario" && c.texto).map((c) => ({ titulo: c.titulo ?? null, texto: c.texto!, principal: false })),
        proibidos: todos.filter((i) => i.tipo === "check" && temTag(i, "proibido")).map((i) => ({ titulo: i.texto, tag: tagDe(i, secaoDo(i)?.code === s.code ? s : secaoDo(i)) })),
        tabela: s.tabela_ref,
        fases,
        perguntas: todos.filter((i) => i.tipo === "pergunta").sort((a, b) => a.ordem - b.ordem)
          .map((i) => ({ item: i, texto: i.texto, abre: i.abre_quando, campo: i.campo_label, tag: tagDe(i, secaoDo(i)) })),
        numerar: callouts.some((c) => c.tipo === "numerar"),
        producao,
      };
    })
    .filter((r) => r.fases.length || r.perguntas.length || r.proibidos.length);
}

// ---------------------------------------------------------------------------
// PDF (A4, uma página por rotina) — mesmo conteúdo da página
// ---------------------------------------------------------------------------
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const corTag = (t: TagEtapa) => (t.tipo === "niko" ? "t-niko" : t.tipo === "sistema" ? "t-sis" : t.tipo === "producao" ? "t-prod" : "t-pes");

export function rotinasPdfHtml(rotinas: Rotina[], versao: string): string {
  const total = rotinas.length;
  const pagina = (r: Rotina, n: number) => {
    let num = 0;
    const fases = r.fases.map((f) => `
      <div class="fase">${esc(f.nome)}</div>
      ${f.etapas.map((e) => { num++; return `
        <div class="etapa">
          ${r.numerar ? `<span class="num">${num}</span>` : `<span class="ponto"></span>`}
          <span class="caixa"></span>
          <div class="et"><div class="et-t">${esc(e.titulo)}</div>${e.detalhe ? `<div class="et-d">${esc(e.detalhe)}</div>` : ""}</div>
          ${e.tag.texto ? `<span class="tag ${corTag(e.tag)}">${esc(e.tag.texto)}</span>` : ""}
        </div>`; }).join("")}`).join("");
    const regras = r.regras.map((g) => `<div class="regra ${g.principal ? "pri" : ""}">${g.titulo ? `<div class="rg-t">${esc(g.titulo)}</div>` : ""}<div class="rg-x">${esc(g.texto)}</div></div>`).join("");
    const temp = r.temporarias.map((g) => `<div class="temp"><span class="temp-et">Medida temporária</span>${g.titulo ? `<div class="rg-t">${esc(g.titulo)}</div>` : ""}<div class="rg-x">${esc(g.texto)}</div></div>`).join("");
    const proib = r.proibidos.length ? `<div class="proib"><div class="pb-c">Não é permitido</div><div class="pb-i">${r.proibidos.map((p) => `<div class="pb"><b>${esc(p.titulo)}</b>${p.tag.texto ? `<em>${esc(p.tag.texto)}</em>` : ""}</div>`).join("")}</div></div>` : "";
    const tabela = r.tabela ? `<table class="ref"><thead><tr>${r.tabela.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${r.tabela.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
    const perguntas = r.perguntas.length ? `<div class="bt">Encerramento</div>${r.perguntas.map((p) => `
      <div class="perg"><div class="pg-t"><span>${esc(p.texto)}</span>${p.tag.texto ? `<span class="tag ${corTag(p.tag)}">${esc(p.tag.texto)}</span>` : ""}</div>
      <div class="pg-o"><span class="cx"></span> Sim <span class="cx"></span> Não</div>
      ${p.abre && p.abre !== "nunca" ? `<div class="pg-s">Se ${p.abre === "sim" ? "SIM" : "NÃO"}: ${esc(p.campo ?? "descreva")} <span class="ln"></span></div>` : ""}</div>`).join("")}` : "";
    const verifs = [...r.fases.flatMap((f) => f.etapas.map((e) => e.titulo)), ...r.perguntas.map((p) => p.texto)].slice(0, 8);
    const rodapeBloco = r.producao ? `
      <div class="bt">Registro da produção</div>
      <table class="sem prod"><tbody>
        <tr><th>Nº da ordem</th><td></td><th>Data</th><td></td></tr>
        <tr><th>Quem produziu</th><td colspan="3"></td></tr>
        <tr><th>Conferido por</th><td colspan="3"></td></tr>
      </tbody></table>` : `
      <div class="bt">Conferência da semana</div>
      <table class="sem"><thead><tr><th>Verificação</th>${["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((d) => `<th class="d">${d}</th>`).join("")}</tr></thead>
      <tbody>${verifs.map((v) => `<tr><td>${esc(v.length > 72 ? v.slice(0, 70) + "…" : v)}</td>${"<td></td>".repeat(6)}</tr>`).join("")}
      <tr class="quem"><td>Quem conferiu</td>${"<td></td>".repeat(6)}</tr></tbody></table>`;
    return `
    <section class="pag ${r.producao ? "compacta" : ""}">
      <header class="faixa"><div class="fx-e"><span class="code">${esc(r.code)}</span><h1>${esc(r.titulo)}</h1></div>
        <div class="fx-d">${r.frequencia ? `<div>${esc(r.frequencia)}</div>` : ""}${r.responsavel ? `<div>Responsável: <b>${esc(r.responsavel)}</b></div>` : ""}</div></header>
      ${r.descricao ? `<div class="sub">${esc(r.descricao)}</div>` : ""}
      <div class="corpo">
        <div>${regras || temp || proib || tabela ? `<div class="bt">Regras fixas</div>${regras}${temp}${proib}${tabela}` : ""}</div>
        <div><div class="bt">Etapas</div>${r.fases.length ? `<div class="linha">${fases}</div>` : ""}${perguntas}</div>
      </div>
      ${rodapeBloco}
      <footer class="rod"><span>ACZ Pet · Manual de Processos · ${esc(r.titulo)}</span><span>Versão ${esc(versao)}</span><span>${n} / ${total}</span></footer>
    </section>`;
  };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Rotinas da Operação</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:0}*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,sans-serif;color:#1B2733;background:#F4F1E9;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pag{width:210mm;height:297mm;padding:9mm 10mm 8mm;background:#F4F1E9;page-break-after:always;display:flex;flex-direction:column;gap:3.2mm;overflow:hidden}
.faixa{background:#1B2733;color:#fff;border-radius:3mm;padding:4mm 5mm;display:flex;justify-content:space-between;align-items:center;gap:4mm}
.fx-e{display:flex;align-items:baseline;gap:3mm}.code{white-space:nowrap;font-family:"Barlow Condensed";font-weight:700;font-size:13pt;background:#E8611C;color:#fff;padding:.6mm 2.2mm;border-radius:1.5mm}
h1{margin:0;font-family:"Barlow Condensed";font-weight:700;font-size:23pt;text-transform:uppercase;line-height:1}
.fx-d{text-align:right;font-size:8.5pt;color:#DCD6C8;line-height:1.5}.fx-d b{color:#fff}
.sub{font-size:8pt;color:#5A6572;margin-top:-1mm}
.corpo{display:grid;grid-template-columns:62mm 1fr;gap:4mm;align-items:start}
.bt{font-family:"Barlow Condensed";font-weight:700;font-size:11pt;text-transform:uppercase;letter-spacing:.06em;color:#5A6572;margin:0 0 1.5mm}
.regra,.temp{background:#fff;border:1px solid #DCD6C8;border-radius:2mm;padding:2.4mm 3mm;margin-bottom:2mm}
.regra.pri{background:#FBE9DD;border-color:#E8611C;border-left:1.4mm solid #E8611C}
.temp{border:1.5px dashed #E8611C}.temp-et{display:inline-block;font-size:6.8pt;font-weight:700;text-transform:uppercase;background:#E8611C;color:#fff;border-radius:1mm;padding:.3mm 1.5mm;margin-bottom:1mm}
.rg-t{font-family:"Barlow Condensed";font-weight:700;font-size:11pt;text-transform:uppercase}.regra.pri .rg-t{color:#B94A10}
.rg-x{font-size:8.3pt;line-height:1.35;margin-top:.5mm}
.proib{border:1px solid #A3302A;border-radius:2mm;overflow:hidden;margin-bottom:2mm;background:#fff}
.pb-c{background:#A3302A;color:#fff;font-family:"Barlow Condensed";font-weight:700;text-transform:uppercase;font-size:11pt;padding:1.4mm 3mm}
.pb-i{display:flex;gap:2mm;padding:2.2mm;flex-wrap:wrap}.pb{flex:1;min-width:20mm;background:#FBEDEC;border-radius:1.5mm;padding:2mm;font-size:8pt;display:flex;flex-direction:column;gap:.6mm}
.pb b{color:#A3302A}.pb em{font-style:normal;font-size:7pt;color:#5A6572;font-weight:600}
table.ref{width:100%;border-collapse:collapse;font-size:7.8pt;background:#fff;border:1px solid #DCD6C8}
table.ref th,table.ref td{border-bottom:1px solid #DCD6C8;padding:1.3mm 2mm;text-align:left}table.ref th{background:#F4F1E9;color:#5A6572}
.linha{background:#fff;border:1px solid #DCD6C8;border-radius:2mm;padding:2.2mm 3mm}
.fase{font-family:"Barlow Condensed";font-weight:700;font-size:10pt;text-transform:uppercase;color:#B94A10;letter-spacing:.05em;margin:1.2mm 0 1mm}.fase:first-child{margin-top:0}
.etapa{display:grid;grid-template-columns:6mm 4.6mm 1fr auto;gap:2mm;align-items:start;padding:1.1mm 0;border-bottom:1px solid #F0ECE2}.etapa:last-child{border-bottom:0}
.num{display:inline-flex;width:5.4mm;height:5.4mm;border-radius:50%;background:#1B2733;color:#fff;font-size:7.5pt;font-weight:700;align-items:center;justify-content:center}
.ponto{display:inline-block;width:2mm;height:2mm;border-radius:50%;background:#E8611C;margin:1.6mm 0 0 1.7mm}
.caixa{width:4.2mm;height:4.2mm;border:1.3px solid #1B2733;border-radius:.8mm;margin-top:.6mm}
.et-t{font-size:8.7pt;font-weight:600;line-height:1.3}.et-d{font-size:7.3pt;color:#5A6572;line-height:1.3;margin-top:.4mm}
.tag{font-size:6.8pt;font-weight:700;padding:.5mm 1.8mm;border-radius:1.2mm;white-space:nowrap;margin-top:.4mm}
.t-niko{background:#E4F0E9;color:#2F6F4F}.t-pes{background:#FBE9DD;color:#B94A10}.t-sis{background:#E8EFF5;color:#2E5A7D}.t-prod{background:#F4F1E9;color:#1B2733;border:1px solid #DCD6C8}
.perg{background:#fff;border:1px solid #DCD6C8;border-radius:2mm;padding:2mm 3mm;margin-top:1.6mm;font-size:8.3pt}
.pg-t{font-weight:600;display:flex;gap:2mm;align-items:center;justify-content:space-between}.pg-o{margin-top:1mm;display:flex;align-items:center;gap:1.5mm;font-size:8pt}
.cx{display:inline-block;width:3.6mm;height:3.6mm;border:1.2px solid #1B2733;border-radius:.7mm;margin-left:2mm}
.pg-s{margin-top:1mm;font-size:7.6pt;color:#5A6572;display:flex;gap:1.5mm;align-items:flex-end}.ln{flex:1;border-bottom:1px solid #5A6572;height:3mm}
table.sem{width:100%;border-collapse:collapse;background:#fff;border:1px solid #DCD6C8;font-size:7.6pt}
table.sem th,table.sem td{border:1px solid #DCD6C8;padding:1.3mm 2mm;height:5.6mm;text-align:left}
table.sem th{background:#1B2733;color:#fff;font-weight:600}table.sem th.d{width:13mm;text-align:center}table.sem tr.quem td{font-weight:700;background:#F4F1E9}
table.sem.prod th{background:#F4F1E9;color:#1B2733;width:34mm}table.sem.prod td{height:8mm}
.compacta .corpo{grid-template-columns:52mm 1fr}.compacta .et-d{font-size:6.6pt;line-height:1.22}.compacta .etapa{padding:.6mm 0}.compacta .et-t{font-size:8.2pt}
.compacta table.sem.prod td,.compacta table.sem.prod th{height:6.5mm;padding:1mm 2mm}
.rod{margin-top:auto;display:flex;justify-content:space-between;font-size:7pt;color:#5A6572;border-top:1px solid #DCD6C8;padding-top:1.6mm}
</style></head><body>${rotinas.map((r, k) => pagina(r, k + 1)).join("")}
<script>(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(function(){setTimeout(function(){window.print()},300)})</script>
</body></html>`;
}
