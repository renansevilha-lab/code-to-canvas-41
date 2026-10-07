import { createFileRoute, redirect } from "@tanstack/react-router";

// A Central de Promoções do Mercado Livre virou a sub-aba "Mercado Livre" de
// /promocoes (07/out/2026). Mantido para links e favoritos antigos.
export const Route = createFileRoute("/promocoes-ml")({
  beforeLoad: () => {
    throw redirect({ to: "/promocoes", search: { mkt: "ml", aba: "minha", loja: 522186766 } });
  },
});
