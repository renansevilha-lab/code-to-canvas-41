// Financeiro (26/nov/2026): Painel (indicadores com detalhe ao clicar) e Balanço patrimonial
// gerencial (?aba=balanco). Ver CLAUDE.md §5.16.
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { BalancoPatrimonial } from "@/components/financeiro/BalancoPatrimonial";
import { PainelFinanceiro } from "@/components/financeiro/PainelFinanceiro";

type Busca = { aba?: "balanco" };

export const Route = createFileRoute("/financeiro")({
  validateSearch: (s: Record<string, unknown>): Busca => (s.aba === "balanco" ? { aba: "balanco" } : {}),
  component: FinanceiroPage,
});

function FinanceiroPage() {
  const { aba } = Route.useSearch();
  const nav = useNavigate({ from: "/financeiro" });
  const ir = (a?: "balanco") => nav({ search: a ? { aba: a } : {}, resetScroll: false });
  const botao = (ativa: boolean, nome: string, a?: "balanco") => (
    <button key={nome} type="button" onClick={() => ir(a)}
      style={{ height: 30, padding: "0 16px", borderRadius: 8, border: 0, cursor: "pointer", fontSize: 13, fontWeight: 600, background: ativa ? "var(--pm-a)" : "transparent", color: ativa ? "var(--pm-oa)" : "var(--pm-t2)" }}>{nome}</button>
  );
  return (
    <div className="pm-ui" style={{ color: "var(--pm-t)", fontSize: 13, padding: "18px 24px 48px", maxWidth: 1400, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "inline-flex", alignSelf: "flex-start", gap: 4, background: "var(--pm-s2)", borderRadius: 10, padding: 3 }}>
        {botao(aba !== "balanco", "Painel")}
        {botao(aba === "balanco", "Balanço", "balanco")}
      </div>
      {aba === "balanco"
        ? <><h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Balanço patrimonial</h1><BalancoPatrimonial /></>
        : <PainelFinanceiro />}
    </div>
  );
}
