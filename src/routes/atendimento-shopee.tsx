import { createFileRoute, redirect } from "@tanstack/react-router";

// 26/nov/2026: a tela virou a Central de Atendimento (/atendimento), com Shopee e
// Mercado Livre juntos. Link antigo leva para lá já filtrado na Shopee.
export const Route = createFileRoute("/atendimento-shopee")({
  beforeLoad: () => {
    throw redirect({ to: "/atendimento", search: { mk: "shopee" } as any });
  },
});
