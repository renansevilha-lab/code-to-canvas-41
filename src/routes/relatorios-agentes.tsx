import { createFileRoute, redirect } from "@tanstack/react-router";

// Link antigo dos relatórios: agora existe a página própria /relatorios
// (06/out/2026). Cai nela, na aba Financeiro.
export const Route = createFileRoute("/relatorios-agentes")({
  beforeLoad: () => {
    throw redirect({ to: "/relatorios", search: { rel: "financeiro" }, replace: true });
  },
});
