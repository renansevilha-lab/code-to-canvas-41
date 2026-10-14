import { Link, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

// ============================================================================
// ADS — um item só no menu (14/out/2026, pedido do dono: menu lateral menor).
// As três telas continuam sendo rotas próprias (cada uma guarda seus filtros
// na URL); esta barra no topo de cada uma faz o papel das abas.
// ============================================================================

export const ADS_ABAS = [
  { url: "/ads-shopee", nome: "Shopee", cor: "#EE4D2D" },
  { url: "/ads-ml", nome: "Mercado Livre", cor: "#E8B500" },
  { url: "/saude-ml", nome: "Saúde dos anúncios ML", cor: "#E8B500" },
] as const;

export function AdsAbas({ className }: { className?: string }) {
  const atual = useRouterState({ select: (r) => r.location.pathname });
  return (
    <div className={cn("inline-flex h-10 items-center gap-1 rounded-md bg-muted p-1 text-muted-foreground", className)}>
      {ADS_ABAS.map((a) => {
        const ativo = atual.startsWith(a.url);
        return (
          <Link
            key={a.url}
            to={a.url as string}
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap rounded-sm px-4 py-1.5 text-sm font-medium transition-all",
              ativo ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
            )}
          >
            <i className="h-2.5 w-2.5 rounded-full" style={{ background: a.cor }} />
            {a.nome}
          </Link>
        );
      })}
    </div>
  );
}
