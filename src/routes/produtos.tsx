import { createFileRoute } from "@tanstack/react-router";
import { EmBreve } from "@/components/EmBreve";

export const Route = createFileRoute("/produtos")({
  component: () => (
    <EmBreve
      title="Catálogo de Produtos"
      description="Vai importar o arquivo 'sales_info' do Centro do Vendedor pra mapear SKU principal × variações × ID do produto."
    />
  ),
});
