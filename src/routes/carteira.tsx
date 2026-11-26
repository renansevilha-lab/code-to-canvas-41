import { createFileRoute, redirect } from "@tanstack/react-router";

// 26/nov/2026 (dono): a Carteira foi substituída pelo Fluxo de Caixa. Link antigo leva para lá.
export const Route = createFileRoute("/carteira")({
  beforeLoad: () => {
    throw redirect({ to: "/fluxo-caixa" });
  },
});
