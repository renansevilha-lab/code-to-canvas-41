// Fechamento contábil ACZ Pet — leitura dos XMLs fiscais do mês.
//
// Lê ZIPs e/ou pastas (recursivo) com NF-e, eventos de NF-e e CT-e e grava um JSON:
//   { gerado_em, fontes, notas: [...], eventos: [...], ctes: [...], ignorados: [...] }
// Cada nota traz o cabeçalho (totais do ICMSTot), `cfops` = {cfop: soma do vProd} e `itens` (um por <det>).
//
// Uso:  node fechamento/scripts/parse_nfe.mjs <saida.json> <zip-ou-pasta> [<zip-ou-pasta> ...]
//
// Não decide nada de negócio (o que é da ACZ, cancelada, compra…): isso é do `fiscal_base.mjs`.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

// ---------- XML mínimo: árvore {tag: valor | objeto | lista}; prefixo de namespace e atributos (menos Id) fora ----------
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const txt = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
export function lerXml(xml) {
  const raiz = {}; const pilha = [{ no: raiz, nome: "" }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const topo = pilha[pilha.length - 1];
    if (m[1] != null) { topo.texto = (topo.texto ?? "") + m[1]; continue; }
    if (m[2] != null) {
      const f = pilha.pop(); const pai = pilha[pilha.length - 1];
      const vazio = Object.keys(f.no).length === 0;
      const valor = vazio ? txt((f.texto ?? "").trim()) : f.no;
      if (pai.no[f.nome] === undefined) pai.no[f.nome] = valor;
      else if (Array.isArray(pai.no[f.nome])) pai.no[f.nome].push(valor);
      else pai.no[f.nome] = [pai.no[f.nome], valor];
      continue;
    }
    if (m[3] != null) {
      const nome = m[3].includes(":") ? m[3].split(":").pop() : m[3];
      const no = {}; const id = /\bId="([^"]*)"/.exec(m[4] ?? ""); if (id) no["@Id"] = id[1];
      if (m[5] === "/") {
        const pai = topo; const valor = Object.keys(no).length ? no : "";
        if (pai.no[nome] === undefined) pai.no[nome] = valor;
        else if (Array.isArray(pai.no[nome])) pai.no[nome].push(valor);
        else pai.no[nome] = [pai.no[nome], valor];
      } else pilha.push({ no, nome });
      continue;
    }
    if (m[6] != null && m[6].trim()) topo.texto = (topo.texto ?? "") + m[6];
  }
  return raiz;
}
const lista = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
/** primeiro grupo filho de um nó de imposto (ex.: ICMS → ICMS00 | ICMS40 | ICMSSN102…) */
const grupo = (no) => { if (!no || typeof no !== "object") return {}; const k = Object.keys(no).find((x) => typeof no[x] === "object"); return k ? no[k] : {}; };

function notaDe(doc, arquivo) {
  const nfe = doc.nfeProc?.NFe ?? doc.NFe; const inf = nfe?.infNFe;
  if (!inf) return null;
  const ide = inf.ide ?? {}, emit = inf.emit ?? {}, dest = inf.dest ?? {}, tot = inf.total?.ICMSTot ?? {};
  const prot = doc.nfeProc?.protNFe?.infProt ?? {};
  const cfops = {};
  const itens = lista(inf.det).map((d, i) => {
    const p = d.prod ?? {}, imp = d.imposto ?? {};
    const icms = grupo(imp.ICMS), pis = grupo(imp.PIS), cof = grupo(imp.COFINS), uf = imp.ICMSUFDest ?? {};
    cfops[p.CFOP] = r2((cfops[p.CFOP] ?? 0) + num(p.vProd));
    return {
      n: i + 1, cProd: p.cProd ?? "", xProd: p.xProd ?? "", NCM: p.NCM ?? "", CFOP: p.CFOP ?? "", uCom: p.uCom ?? "", qCom: num(p.qCom),
      vProd: num(p.vProd), vDesc: num(p.vDesc), vFrete: num(p.vFrete), vOutro: num(p.vOutro),
      orig: icms.orig ?? "", cstICMS: icms.CST ?? icms.CSOSN ?? "", pICMS: num(icms.pICMS), vBC: num(icms.vBC), vICMS: num(icms.vICMS), vST: num(icms.vICMSST),
      vICMSUFDest: num(uf.vICMSUFDest), vFCPUFDest: num(uf.vFCPUFDest),
      cstPIS: pis.CST ?? "", vPIS: num(pis.vPIS), cstCOFINS: cof.CST ?? "", vCOFINS: num(cof.vCOFINS),
      vIPI: num(grupo(imp.IPI).vIPI),
    };
  });
  return {
    chave: String(inf["@Id"] ?? "").replace(/^NFe/, "") || prot.chNFe || "", numero: ide.nNF ?? "", serie: ide.serie ?? "",
    data: ide.dhEmi ?? ide.dEmi ?? "", tpNF: ide.tpNF ?? "", finNFe: ide.finNFe ?? "", natOp: ide.natOp ?? "",
    emit_cnpj: emit.CNPJ ?? emit.CPF ?? "", emit_nome: emit.xNome ?? "", emit_uf: emit.enderEmit?.UF ?? "",
    dest_doc: dest.CNPJ ?? dest.CPF ?? dest.idEstrangeiro ?? "", dest_nome: dest.xNome ?? "", dest_uf: dest.enderDest?.UF ?? "", indIEDest: dest.indIEDest ?? "",
    vProd: num(tot.vProd), vFrete: num(tot.vFrete), vDesc: num(tot.vDesc), vOutro: num(tot.vOutro), vICMS: num(tot.vICMS), vST: num(tot.vST),
    vIPI: num(tot.vIPI), vPIS: num(tot.vPIS), vCOFINS: num(tot.vCOFINS), vICMSUFDest: num(tot.vICMSUFDest), vFCPUFDest: num(tot.vFCPUFDest),
    vNF: num(tot.vNF), cStat: prot.cStat ?? "", refNFe: lista(ide.NFref).map((r) => r.refNFe).filter(Boolean),
    cfops, itens, arquivo,
  };
}
function eventosDe(doc, arquivo) {
  const evs = [...lista(doc.procEventoNFe), ...lista(doc.envEvento?.evento ? { evento: doc.envEvento.evento } : null)];
  const out = [];
  for (const e of evs) for (const ev of lista(e.evento)) {
    const i = ev.infEvento; if (!i) continue;
    out.push({ chave: i.chNFe ?? "", tpEvento: i.tpEvento ?? "", desc: i.detEvento?.descEvento ?? "", data: i.dhEvento ?? "", cStat: e.retEvento?.infEvento?.cStat ?? "", arquivo });
  }
  return out;
}
function cteDe(doc, arquivo) {
  const cte = doc.cteProc?.CTe ?? doc.CTe; const inf = cte?.infCte; if (!inf) return null;
  const ide = inf.ide ?? {}, emit = inf.emit ?? {}, icms = grupo(inf.imp?.ICMS);
  const toma = inf.ide?.toma3?.toma ?? inf.ide?.toma4?.toma ?? "";
  return {
    chave: String(inf["@Id"] ?? "").replace(/^CTe/, ""), numero: ide.nCT ?? "", serie: ide.serie ?? "", data: ide.dhEmi ?? "", CFOP: ide.CFOP ?? "", natOp: ide.natOp ?? "",
    emit_cnpj: emit.CNPJ ?? "", emit_nome: emit.xNome ?? "", toma, rem_doc: inf.rem?.CNPJ ?? inf.rem?.CPF ?? "", dest_doc: inf.dest?.CNPJ ?? inf.dest?.CPF ?? "",
    vTPrest: num(inf.vPrest?.vTPrest), cstICMS: icms.CST ?? "", pICMS: num(icms.pICMS), vICMS: num(icms.vICMS), cStat: doc.cteProc?.protCTe?.infProt?.cStat ?? "", arquivo,
  };
}

async function* arquivosDe(entrada) {
  const st = fs.statSync(entrada);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(entrada, { recursive: true })) {
      const p = path.join(entrada, String(f));
      if (fs.statSync(p).isFile()) yield* arquivosDe(p);
    }
  } else if (/\.zip$/i.test(entrada)) {
    const zip = await JSZip.loadAsync(fs.readFileSync(entrada));
    for (const nome of Object.keys(zip.files)) {
      const z = zip.files[nome]; if (z.dir) continue;
      if (/\.xml$/i.test(nome)) yield { nome: `${path.basename(entrada)}!${nome}`, texto: await z.async("string") };
      else if (/\.zip$/i.test(nome)) {
        const dentro = await JSZip.loadAsync(await z.async("nodebuffer"));
        for (const n2 of Object.keys(dentro.files)) if (/\.xml$/i.test(n2)) yield { nome: `${path.basename(entrada)}!${nome}!${n2}`, texto: await dentro.files[n2].async("string") };
      }
    }
  } else if (/\.xml$/i.test(entrada)) yield { nome: entrada, texto: fs.readFileSync(entrada, "utf8") };
}

export async function parseFontes(fontes) {
  const notas = new Map(), eventos = [], ctes = new Map(), ignorados = [];
  for (const fonte of fontes) for await (const a of arquivosDe(fonte)) {
    let doc; try { doc = lerXml(a.texto); } catch (e) { ignorados.push({ arquivo: a.nome, motivo: String(e.message ?? e) }); continue; }
    const n = notaDe(doc, a.nome); if (n) { if (n.chave) notas.set(n.chave, n); else ignorados.push({ arquivo: a.nome, motivo: "NF-e sem chave" }); continue; }
    const ev = eventosDe(doc, a.nome); if (ev.length) { eventos.push(...ev); continue; }
    const c = cteDe(doc, a.nome); if (c) { ctes.set(c.chave, c); continue; }
    ignorados.push({ arquivo: a.nome, motivo: `raiz desconhecida: ${Object.keys(doc).join(",")}` });
  }
  // o mesmo evento pode vir duas vezes (envio + retorno)
  const vistos = new Set(); const evs = eventos.filter((e) => { const k = `${e.chave}|${e.tpEvento}|${e.data}`; if (vistos.has(k)) return false; vistos.add(k); return true; });
  return { gerado_em: new Date().toISOString(), fontes, notas: [...notas.values()], eventos: evs, ctes: [...ctes.values()], ignorados };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const [saida, ...fontes] = process.argv.slice(2);
  if (!saida || !fontes.length) { console.error("uso: node parse_nfe.mjs <saida.json> <zip-ou-pasta> [...]"); process.exit(1); }
  const r = await parseFontes(fontes);
  fs.mkdirSync(path.dirname(path.resolve(saida)), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(r));
  console.log(`${r.notas.length} notas · ${r.eventos.length} eventos · ${r.ctes.length} CT-e · ${r.ignorados.length} ignorados → ${saida}`);
}
