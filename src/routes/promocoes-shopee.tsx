import { createFileRoute, redirect } from "@tanstack/react-router";

import { LOJAS } from "@/components/promocoes/comum";

// Promoções Shopee virou a sub-aba "Shopee" de /promocoes (07/out/2026).
// Mantido para links antigos — preserva aba e loja.
export const Route = createFileRoute("/promocoes-shopee")({
  validateSearch: (s: Record<string, unknown>): { aba?: string; loja?: number } => ({
    aba: typeof s.aba === "string" ? s.aba : undefined,
    loja: LOJAS.some((l) => l.shop_id === Number(s.loja)) ? Number(s.loja) : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/promocoes",
      search: { mkt: "shopee", aba: search.aba === "relampago" ? "relampago" : "minha", loja: search.loja ?? LOJAS[0].shop_id },
    });
  },
});
