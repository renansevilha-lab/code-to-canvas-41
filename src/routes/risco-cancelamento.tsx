import { createFileRoute } from "@tanstack/react-router";
import { PedidosShopeeLista } from "@/components/separacao/PedidosShopeeLista";

// Só os pedidos Shopee que cancelam hoje/amanhã (view_pedidos_risco_cancelamento).
export const Route = createFileRoute("/risco-cancelamento")({
  component: () => <PedidosShopeeLista modo="risco" />,
});
