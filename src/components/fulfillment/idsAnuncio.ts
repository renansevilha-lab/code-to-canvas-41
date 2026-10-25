import { useQuery } from "@tanstack/react-query";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// Números do anúncio no marketplace por conta + SKU, para a busca da Reposição achar o produto também pelo
// código que aparece no Seller Center: Amazon = SKU do vendedor e ASIN; Mercado Livre = MLB e inventory_id;
// Shopee = id do anúncio e da variação. Vem do estoque dos CDs (estoque_fulfillment, paginado: passa de 900
// linhas e o corte é 1.000) + ml_full_itens (inventory_id → MLB) + pesquisa_amz_meus_skus (SKU → ASIN).

export const chaveIds = (shop: number | null | undefined, sku: string | null | undefined) => `${shop ?? ""}|${sku ?? ""}`;

async function paginar<T>(tabela: string, colunas: string): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabaseExternal.from(tabela).select(colunas).range(de, de + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export function useIdsAnuncio(ligado = true) {
  return useQuery({
    queryKey: ["fulfillment", "ids-anuncio"],
    enabled: ligado,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const [ef, ml, amz] = await Promise.all([
        paginar<{ marketplace: string; shop_id: number | null; sku: string | null; sku_marketplace: string | null }>("estoque_fulfillment", "marketplace,shop_id,sku,sku_marketplace"),
        paginar<{ item_id: string | null; inventory_id: string | null }>("ml_full_itens", "item_id,inventory_id").catch(() => []),
        paginar<{ sku_amazon: string | null; asin: string | null }>("pesquisa_amz_meus_skus", "sku_amazon,asin").catch(() => []),
      ]);
      const mlb = new Map<string, string[]>();
      for (const r of ml) if (r.inventory_id && r.item_id) mlb.set(r.inventory_id, [...(mlb.get(r.inventory_id) ?? []), r.item_id]);
      const asin = new Map<string, string>();
      for (const r of amz) if (r.sku_amazon && r.asin) asin.set(r.sku_amazon.toLowerCase(), r.asin);
      const m = new Map<string, string>();
      for (const r of ef) {
        if (!r.sku || !r.sku_marketplace) continue;
        const ids = [r.sku_marketplace];
        if (r.marketplace === "mercadolivre") ids.push(...(mlb.get(r.sku_marketplace) ?? []));
        if (r.marketplace === "amazon") { const a = asin.get(r.sku_marketplace.toLowerCase()); if (a) ids.push(a); }
        if (r.marketplace === "shopee") ids.push(...r.sku_marketplace.split("_"));
        const k = chaveIds(r.shop_id, r.sku);
        m.set(k, `${m.get(k) ?? ""} ${ids.join(" ")}`.toLowerCase());
      }
      return m;
    },
  });
}
