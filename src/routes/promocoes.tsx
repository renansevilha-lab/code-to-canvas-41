import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tag } from "lucide-react";

import { LOJAS } from "@/components/promocoes/comum";
import { type AbaShopee } from "@/components/promocoes/PromocoesShopee";
import { Relampago } from "@/components/promocoes/Relampago";
import { ShopeeMinha, type CabBase } from "@/components/promocoes/ShopeeMinha";
import { PromocoesML } from "@/components/promocoes/PromocoesML";
import { PromocoesTikTok } from "@/components/promocoes/PromocoesTikTok";
import { PromocoesAmazon } from "@/components/promocoes/PromocoesAmazon";
import { CabecalhoMkt } from "@/components/promocoes/ui/kit";

// ============================================================================
// Promoções — todas as promoções num lugar só (07/out/2026, pedido do dono),
// uma sub-aba por marketplace:
//   · Shopee: Minha Promoção / Relâmpago (antes /promocoes-shopee);
//   · Mercado Livre: Central de Promoções (antes /promocoes-ml);
//   · Amazon (20/out/2026): promoções da conta, MC por produto e preço de oferta com início e fim;
//   · TikTok: promoções da loja ACZ.
// /promocoes-shopee, /promocoes-ml e /flash-sale redirecionam para cá.
// Sub-aba, aba da Shopee e loja ficam na URL (sobrevivem à remontagem).
// 21/out/2026 — design novo do Claude Design ("Promoções"): cabeçalho único com o
// marketplace (logo), loja e sincronização; tokens --pm-* em .pm-ui. Migrado por partes:
// fase 1 = Shopee › Minha Promoção (ShopeeMinha). Relâmpago, Mercado Livre, Amazon e
// TikTok ainda são as telas de antes, abaixo do cabeçalho novo.
// ============================================================================

type Mkt = "shopee" | "ml" | "amazon" | "tiktok";
interface SearchParams { mkt: Mkt; aba: AbaShopee; loja: number }

const MKTS: Array<{ id: Mkt; nome: string; logo: string }> = [
  { id: "shopee", nome: "Shopee", logo: "/logos/shopee-icon.png" },
  { id: "ml", nome: "Mercado Livre", logo: "/logos/ml-icon.png" },
  { id: "amazon", nome: "Amazon", logo: "/logos/amazon-icon.png" },
  { id: "tiktok", nome: "TikTok Shop", logo: "/logos/tiktok-icon.png" },
];

export const Route = createFileRoute("/promocoes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    mkt: MKTS.some((m) => m.id === s.mkt) ? (s.mkt as Mkt) : "shopee",
    aba: s.aba === "relampago" ? "relampago" : "minha",
    // `shop` = parâmetro da antiga /promocoes (relâmpago manual)
    loja: LOJAS.some((l) => l.shop_id === Number(s.loja ?? s.shop)) ? Number(s.loja ?? s.shop) : LOJAS[0].shop_id,
  }),
  component: PromocoesPage,
});

function PromocoesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const set = (patch: Partial<SearchParams>) =>
    navigate({ search: (s: SearchParams) => ({ ...s, ...patch }), replace: true, resetScroll: false });

  const ehShopee = search.mkt === "shopee";
  const cab: CabBase = {
    mkts: MKTS, mkt: search.mkt, onMkt: (id) => set({ mkt: id as Mkt }),
    lojaRot: "Loja", lojas: ehShopee ? LOJAS.map((l) => ({ id: l.shop_id, nome: l.nome })) : [], loja: search.loja,
    onLoja: (id) => set({ loja: Number(id) }),
    subtabs: ehShopee ? [{ id: "minha", nome: "Minha Promoção" }, { id: "relampago", nome: "Relâmpago" }] : [],
    sub: search.aba, onSub: (id) => set({ aba: id as AbaShopee }),
  };

  return (
    <div className="pm-ui p-4 md:p-6 w-full" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", display: "flex", alignItems: "center", gap: 8 }}>
          <Tag style={{ width: 20, height: 20, color: "var(--pm-a)" }} strokeWidth={1.75} />Promoções
        </h1>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--pm-t3)" }}>Promoções e campanhas de cada marketplace, com custo e margem de contribuição por produto.</p>
      </header>

      {ehShopee && search.aba === "minha" ? (
        <ShopeeMinha key={search.loja} shopId={search.loja} cab={cab} onIrRelampago={() => set({ aba: "relampago" })} />
      ) : (
        <>
          <CabecalhoMkt {...cab} />
          <div style={{ fontSize: 13 }}>
            {ehShopee && <Relampago key={search.loja} shopId={search.loja} />}
            {search.mkt === "ml" && <PromocoesML />}
            {search.mkt === "amazon" && <PromocoesAmazon />}
            {search.mkt === "tiktok" && <PromocoesTikTok />}
          </div>
        </>
      )}
    </div>
  );
}
