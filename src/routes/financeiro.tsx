// Painel financeiro (26/nov/2026): indicadores de lucro, equilíbrio, capital de giro,
// liquidez e ciclo de caixa, cada um com o detalhe ao clicar. Ver CLAUDE.md §5.16.
import { createFileRoute } from "@tanstack/react-router";

import { PainelFinanceiro } from "@/components/financeiro/PainelFinanceiro";

export const Route = createFileRoute("/financeiro")({
  component: FinanceiroPage,
});

function FinanceiroPage() {
  return (
    <div className="pm-ui" style={{ color: "var(--pm-t)", fontSize: 13, padding: "18px 24px 48px", maxWidth: 1400, margin: "0 auto" }}>
      <PainelFinanceiro />
    </div>
  );
}
