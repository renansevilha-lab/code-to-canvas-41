import { createFileRoute, redirect } from "@tanstack/react-router";

// 26/nov/2026 (dono): o item Produtos saiu do menu; a lista de produtos agora é IA › Anúncios (visão Produtos).
export const Route = createFileRoute("/produtos-margem")({
  beforeLoad: () => {
    throw redirect({ to: "/ia/anuncios", search: { ver: "produtos" } as any });
  },
});
