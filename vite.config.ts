// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

import { fileURLToPath } from "node:url";

// 05/nov/2026: o build da Cloudflare (Linux) parou de achar o pacote rou3 que o h3 importa
// ("Rollup failed to resolve import rou3 from node_modules/h3/dist/h3.mjs") — aqui e no Windows o
// mesmo lock monta. Apontar o caminho do arquivo resolve sem depender da busca em node_modules.
const rou3 = fileURLToPath(new URL("./node_modules/rou3/dist/index.mjs", import.meta.url));

export default defineConfig({ vite: { resolve: { alias: { rou3 } } } });
