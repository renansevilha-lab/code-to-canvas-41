import { createFileRoute, redirect } from "@tanstack/react-router";

// A Relâmpago Shopee virou a aba "Relâmpago" de /promocoes-shopee (30/set/2026).
// Mantida só para links/favoritos antigos.
export const Route = createFileRoute("/flash-sale")({
  beforeLoad: () => {
    throw redirect({ to: "/promocoes-shopee", search: { aba: "relampago", loja: 522186766 } });
  },
});
