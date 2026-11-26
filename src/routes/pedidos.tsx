import { createFileRoute, redirect } from "@tanstack/react-router";

// 26/nov/2026 (dono): a aba Pedidos saiu; só a Pedidos Integrados é usada. Link antigo leva para lá.
export const Route = createFileRoute("/pedidos")({
  beforeLoad: () => {
    throw redirect({ to: "/pedidos-integrados", search: {} as any });
  },
});
