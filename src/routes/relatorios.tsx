import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { RelatoriosSection } from "@/components/relatorios/RelatoriosSection";

// ============================================================================
// Página própria dos relatórios dos agentes (financeiro, compras, ADS) —
// pedido do dono em 06/out/2026; layout "Faixa Hoje + histórico" do Claude
// Design. A aba do histórico (agente) fica na URL (?rel=financeiro|compras|marketing).
// ============================================================================

export const Route = createFileRoute("/relatorios")({
  validateSearch: (s: Record<string, unknown>): { rel?: string } => ({
    rel: typeof s.rel === "string" && s.rel ? s.rel : undefined,
  }),
  component: RelatoriosPage,
});

function RelatoriosPage() {
  const { rel } = Route.useSearch();
  const navigate = useNavigate({ from: "/relatorios" });
  return (
    <div className="w-full px-4 md:px-10 pt-5 md:pt-8 pb-8 md:pb-12">
      <RelatoriosSection
        modo="pagina"
        relSlug={rel}
        onRelChange={(slug) => navigate({ search: { rel: slug }, replace: true, resetScroll: false })}
      />
    </div>
  );
}
