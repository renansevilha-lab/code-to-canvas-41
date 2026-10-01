import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tag, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LOJAS } from "@/components/promocoes/comum";
import { MinhaPromocao } from "@/components/promocoes/MinhaPromocao";
import { Relampago } from "@/components/promocoes/Relampago";

// ============================================================================
// Promoções Shopee (30/set/2026) — duas abas:
//   · Minha Promoção: descontos da loja (v2.discount) com CMV/MC/desconto,
//     edição de preço e limite no desconto em andamento;
//   · Relâmpago: programação diária da Promoção Relâmpago (antiga /flash-sale).
// Aba e loja ficam na URL (sobrevivem à remontagem).
// ============================================================================

type Aba = "minha" | "relampago";
interface SearchParams { aba: Aba; loja: number }

function PromocoesShopeePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const set = (patch: Partial<SearchParams>) => navigate({ search: (s: SearchParams) => ({ ...s, ...patch }), replace: true });

  return (
    <div className="p-4 md:p-6 space-y-5 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-[-0.02em] flex items-center gap-2">
            <Tag className="h-5 w-5 text-primary" /> Promoções Shopee
          </h1>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Descontos da loja e Promoção Relâmpago — com custo, margem de contribuição e desconto por produto.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {LOJAS.map((l) => (
            <Button key={l.shop_id} size="sm" variant={search.loja === l.shop_id ? "default" : "outline"}
              className="h-8" onClick={() => set({ loja: l.shop_id })}>
              {l.nome}
            </Button>
          ))}
        </div>
      </div>

      <Tabs value={search.aba} onValueChange={(v) => set({ aba: v as Aba })}>
        <TabsList>
          <TabsTrigger value="minha" className="gap-1.5"><Tag className="h-3.5 w-3.5" /> Minha Promoção</TabsTrigger>
          <TabsTrigger value="relampago" className="gap-1.5"><Zap className="h-3.5 w-3.5" /> Relâmpago</TabsTrigger>
        </TabsList>
        <TabsContent value="minha" className="mt-4">
          <MinhaPromocao key={search.loja} shopId={search.loja} />
        </TabsContent>
        <TabsContent value="relampago" className="mt-4">
          <Relampago key={search.loja} shopId={search.loja} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const Route = createFileRoute("/promocoes-shopee")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    aba: s.aba === "relampago" ? "relampago" : "minha",
    loja: LOJAS.some((l) => l.shop_id === Number(s.loja)) ? Number(s.loja) : LOJAS[0].shop_id,
  }),
  component: PromocoesShopeePage,
});
