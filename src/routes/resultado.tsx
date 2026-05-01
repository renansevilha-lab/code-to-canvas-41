import { createFileRoute } from "@tanstack/react-router";
import { EmBreve } from "@/components/EmBreve";

export const Route = createFileRoute("/resultado")({
  component: () => (
    <EmBreve
      title="Módulo Resultado"
      description="Vai cruzar Vendas × Anúncios pra calcular o lucro efetivo do período: subtotal – taxas – imposto – gasto com ADS."
    />
  ),
});
