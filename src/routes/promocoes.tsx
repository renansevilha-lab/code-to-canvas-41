import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tag } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LOJAS } from "@/components/promocoes/comum";
import { PromocoesShopee, type AbaShopee } from "@/components/promocoes/PromocoesShopee";
import { PromocoesML } from "@/components/promocoes/PromocoesML";
import { PromocoesEmBreve } from "@/components/promocoes/PromocoesEmBreve";

// ============================================================================
// Promoções — todas as promoções num lugar só (07/out/2026, pedido do dono),
// uma sub-aba por marketplace:
//   · Shopee: Minha Promoção / Relâmpago / Relâmpago manual (antes
//     /promocoes-shopee e a antiga /promocoes);
//   · Mercado Livre: Central de Promoções (antes /promocoes-ml);
//   · Amazon e TikTok: o que a API permite e o que falta (estudo).
// /promocoes-shopee, /promocoes-ml e /flash-sale redirecionam para cá.
// Sub-aba, aba da Shopee e loja ficam na URL (sobrevivem à remontagem).
// ============================================================================

type Mkt = "shopee" | "ml" | "amazon" | "tiktok";
interface SearchParams { mkt: Mkt; aba: AbaShopee; loja: number }

const MKTS: Array<{ id: Mkt; nome: string; cor: string }> = [
  { id: "shopee", nome: "Shopee", cor: "#EE4D2D" },
  { id: "ml", nome: "Mercado Livre", cor: "#E8B500" },
  { id: "amazon", nome: "Amazon", cor: "#FF9900" },
  { id: "tiktok", nome: "TikTok Shop", cor: "#111111" },
];

export const Route = createFileRoute("/promocoes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    mkt: MKTS.some((m) => m.id === s.mkt) ? (s.mkt as Mkt) : "shopee",
    aba: s.aba === "relampago" || s.aba === "manual" ? s.aba : "minha",
    // `shop` = parâmetro da antiga /promocoes (relâmpago manual)
    loja: LOJAS.some((l) => l.shop_id === Number(s.loja ?? s.shop)) ? Number(s.loja ?? s.shop) : LOJAS[0].shop_id,
  }),
  component: PromocoesPage,
});

function PromocoesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const set = (patch: Partial<SearchParams>) =>
    navigate({ search: (s: SearchParams) => ({ ...s, ...patch }), replace: true });

  return (
    <div className="p-4 md:p-6 space-y-5 w-full">
      <div>
        <h1 className="text-[19px] font-semibold tracking-[-0.02em] flex items-center gap-2">
          <Tag className="h-5 w-5 text-primary" /> Promoções
        </h1>
        <p className="text-[12.5px] text-muted-foreground mt-0.5">
          Promoções e campanhas de cada marketplace, com custo e margem de contribuição por produto.
        </p>
      </div>

      <Tabs value={search.mkt} onValueChange={(v) => set({ mkt: v as Mkt })}>
        <TabsList className="h-10">
          {MKTS.map((m) => (
            <TabsTrigger key={m.id} value={m.id} className="gap-2 px-4">
              <i className="h-2.5 w-2.5 rounded-full" style={{ background: m.cor }} />
              {m.nome}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="shopee" className="mt-5">
          <PromocoesShopee aba={search.aba} loja={search.loja} onChange={(p) => set(p)} />
        </TabsContent>
        <TabsContent value="ml" className="mt-5">
          <PromocoesML />
        </TabsContent>
        <TabsContent value="amazon" className="mt-5">
          <PromocoesEmBreve marketplace="amazon" />
        </TabsContent>
        <TabsContent value="tiktok" className="mt-5">
          <PromocoesEmBreve marketplace="tiktok" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
