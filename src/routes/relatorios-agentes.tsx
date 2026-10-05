import { createFileRoute, redirect } from "@tanstack/react-router";

// A página própria virou a seção "Relatórios" da Visão Geral (05/out/2026).
// Link antigo cai na seção, na aba Financeiro.
export const Route = createFileRoute("/relatorios-agentes")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { rel: "financeiro" }, hash: "relatorios", replace: true });
  },
});
