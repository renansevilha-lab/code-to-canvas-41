import { createFileRoute } from "@tanstack/react-router";
import { PedidosShopeeLista } from "@/components/separacao/PedidosShopeeLista";

// Tudo que consta como "A enviar" no Seller Center da Shopee, atrasado ou não
// (view_pedidos_a_enviar) — mesma tela do risco, com filtros de prazo.
export const Route = createFileRoute("/a-enviar")({
  component: () => <PedidosShopeeLista modo="a-enviar" />,
});
