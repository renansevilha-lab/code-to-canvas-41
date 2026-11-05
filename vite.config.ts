// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// 05/nov/2026: o build da Cloudflare passou a falhar com "EMFILE: too many open files" (limite de
// arquivos abertos menor na máquina de build). Às vezes o erro aparecia disfarçado de "Rollup failed to
// resolve import" (rou3, sonner, date-fns). O padrão do Rollup é abrir até 1.000 arquivos ao mesmo tempo;
// com 32 o build fica praticamente com o mesmo tempo e não esbarra no limite.
export default defineConfig({
  vite: {
    build: {
      rollupOptions: { maxParallelFileOps: 32 },
    },
  },
});
