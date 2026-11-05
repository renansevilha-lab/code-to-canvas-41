// 05/nov/2026: no build da Cloudflare (Workers Builds, Node 24.18 + npm 10.9.2) o `npm clean-install`
// passou a deixar pacotes quebrados — a cada build um diferente (rou3, sonner, date-fns): o package.json
// existe, mas falta o arquivo de entrada, e o vite para em "Rollup failed to resolve import". O mesmo lock
// instala completo aqui. Só no CI: confere a entrada de cada pacote do lock e, se algum estiver faltando
// ou quebrado, apaga e instala de novo esses pacotes (npm install --no-save, sem mexer no package-lock).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

if (!process.env.CI && !process.env.WORKERS_CI) process.exit(0);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const plataforma = (v) =>
  !(v.os && !v.os.includes(process.platform)) && !(v.cpu && !v.cpu.includes(process.arch));

/** Arquivos de entrada declarados no package.json (main/module/exports["."]), só os caminhos simples. */
function entradas(pj) {
  const out = new Set();
  const add = (x) => { if (typeof x === "string" && x.startsWith(".") && !x.includes("*") && !/\.d\.[cm]?ts$|\.tsx?$/.test(x)) out.add(x); };
  add(pj.main); add(pj.module);
  const e = pj.exports;
  const raiz = !e ? null : typeof e === "string" || Array.isArray(e) ? e
    : "." in e ? e["."] : Object.keys(e).some((k) => k.startsWith(".")) ? null : e;
  const varrer = (x) => {
    if (!x) return;
    if (typeof x === "string") return add(x);
    if (Array.isArray(x)) return x.forEach(varrer);
    if (typeof x === "object") Object.entries(x).forEach(([c, y]) => { if (c !== "types" && c !== "typings") varrer(y); });
  };
  varrer(raiz);
  return [...out];
}

function quebrados() {
  const ruins = [];
  for (const [k, v] of Object.entries(lock.packages)) {
    if (!k || v.link || v.optional || v.peer || !plataforma(v)) continue;
    const pjPath = join(k, "package.json");
    if (!existsSync(pjPath)) { ruins.push(`${k} (sem package.json)`); continue; }
    let pj;
    try { pj = JSON.parse(readFileSync(pjPath, "utf8")); } catch { ruins.push(`${k} (package.json ilegível)`); continue; }
    const existe = (f) => ["", ".js", ".cjs", ".mjs", ".json", "/index.js"].some((ext) => existsSync(join(k, f + ext)));
    const falta = entradas(pj).filter((f) => !existe(f));
    if (falta.length) ruins.push(`${k} (faltam ${falta.slice(0, 3).join(", ")})`);
  }
  return ruins;
}

let limite = "?";
try { limite = execSync("sh -c \"ulimit -n; ulimit -Hn\"").toString().trim().replace(/\s+/, " / "); } catch {}
console.log(`[completar-dependencias] node ${process.version} · arquivos abertos (atual / máximo): ${limite}`);
let ruins = quebrados();
console.log(`[completar-dependencias] ${ruins.length} pacote(s) quebrados ou ausentes${ruins.length ? ": " + ruins.slice(0, 30).join(" · ") : ""}`);
for (let tentativa = 1; ruins.length && tentativa <= 2; tentativa++) {
  for (const r of ruins) rmSync(r.split(" (")[0], { recursive: true, force: true });
  execSync("npm install --no-save --no-audit --no-fund", { stdio: "inherit" });
  ruins = quebrados();
  console.log(`[completar-dependencias] depois da tentativa ${tentativa}: ${ruins.length} ainda quebrados${ruins.length ? ": " + ruins.join(" · ") : ""}`);
}
