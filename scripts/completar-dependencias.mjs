// 05/nov/2026: no build da Cloudflare (Workers Builds) o `npm clean-install` passou a terminar
// incompleto — a cada build faltava um pacote diferente (rou3, depois sonner) e o vite parava em
// "Rollup failed to resolve import". O mesmo lock instala completo aqui. Só no CI: confere os pacotes
// do lock e, se faltar algum, roda `npm install --no-save` (completa sem mexer no package-lock).
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

if (!process.env.CI && !process.env.WORKERS_CI) process.exit(0);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const plataforma = (v) =>
  !(v.os && !v.os.includes(process.platform)) && !(v.cpu && !v.cpu.includes(process.arch));
const faltam = Object.entries(lock.packages)
  .filter(([k, v]) => k && !v.link && !v.optional && !v.peer && plataforma(v))
  .map(([k]) => k)
  .filter((k) => !existsSync(`${k}/package.json`));

console.log(`[completar-dependencias] ${faltam.length} pacote(s) do lock sem instalar${faltam.length ? ": " + faltam.slice(0, 20).join(", ") : ""}`);
if (faltam.length) {
  execSync("npm install --no-save --no-audit --no-fund --prefer-offline", { stdio: "inherit" });
  const ainda = faltam.filter((k) => !existsSync(`${k}/package.json`));
  console.log(`[completar-dependencias] depois do install: ${ainda.length} ainda faltando${ainda.length ? ": " + ainda.join(", ") : ""}`);
}
