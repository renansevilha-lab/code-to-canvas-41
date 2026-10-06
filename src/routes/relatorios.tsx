import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileText } from "lucide-react";

import { RelatoriosSection } from "@/components/relatorios/RelatoriosSection";

// ============================================================================
// Página própria dos relatórios dos agentes (financeiro, compras, ADS) —
// pedido do dono em 06/out/2026. Mesma seção da Visão Geral, em página cheia;
// a aba (categoria) fica na URL (?rel=financeiro|compras|marketing).
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
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <FileText className="h-6 w-6 text-primary" /> Relatórios
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Relatórios diários dos agentes — financeiro, compras e ADS. Abra um card para ver o detalhe.
        </p>
      </div>
      <RelatoriosSection
        relSlug={rel}
        onRelChange={(slug) => navigate({ search: { rel: slug }, replace: true, resetScroll: false })}
      />
    </div>
  );
}
