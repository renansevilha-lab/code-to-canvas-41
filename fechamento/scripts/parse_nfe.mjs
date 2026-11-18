// Fechamento contábil ACZ Pet — leitura de XMLs fiscais a partir de ZIPs/pastas (caminho manual, de reserva).
// O caminho normal é o espelho automático (edge function `fiscal-nfe`, que lê o Tiny toda noite).
//
// Lê ZIPs e/ou pastas (recursivo) com NF-e, eventos de NF-e e CT-e e grava um JSON:
//   { gerado_em, fontes, notas: [...], eventos: [...], ctes: [...], ignorados: [...] }
// Cada nota traz o cabeçalho (totais do ICMSTot), `cfops` = {cfop: soma do vProd} e `itens` (um por <det>).
//
// Uso:  node fechamento/scripts/parse_nfe.mjs <saida.json> <zip-ou-pasta> [<zip-ou-pasta> ...]
//
// O leitor de XML é o mesmo da edge function (supabase/functions/_shared/nfe.ts).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { lerXml, notaDe, eventosDe, cteDe } from "../../supabase/functions/_shared/nfe.ts";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [saida, ...fontes] = process.argv.slice(2);
  if (!saida || !fontes.length) { console.error("uso: node parse_nfe.mjs <saida.json> <zip-ou-pasta> [...]"); process.exit(1); }
  const r = await parseFontes(fontes);
  fs.mkdirSync(path.dirname(path.resolve(saida)), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(r));
  console.log(`${r.notas.length} notas · ${r.eventos.length} eventos · ${r.ctes.length} CT-e · ${r.ignorados.length} ignorados → ${saida}`);
}
