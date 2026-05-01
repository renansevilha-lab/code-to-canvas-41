import { createFileRoute } from "@tanstack/react-router";
import { EmBreve } from "@/components/EmBreve";

export const Route = createFileRoute("/ads")({
  component: () => (
    <EmBreve
      title="Módulo Anúncios"
      description="Vai processar os relatórios 'Dados Gerais de Anúncios' do Painel da Shopee — gasto, ROAS, CTR, CPC, top anúncios."
    />
  ),
});
