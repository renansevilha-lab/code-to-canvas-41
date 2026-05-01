import { createFileRoute } from "@tanstack/react-router";
import { EmBreve } from "@/components/EmBreve";

export const Route = createFileRoute("/carteira")({
  component: () => (
    <EmBreve
      title="Módulo Carteira"
      description="Vai processar o extrato de transações da carteira Shopee e cruzar com seus pedidos pra mostrar pagos vs aguardando."
    />
  ),
});
