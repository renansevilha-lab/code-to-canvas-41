import { useQuery } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";

// Unidades por caixa da Amazon (amazon_modelo_caixa) por conta e SKU interno, para a Reposição já
// sugerir quantidades que fecham caixa. SKU com mais de um anúncio de modelos diferentes fica sem
// arredondamento (não dá para saber qual anúncio vai no envio).
export interface CaixaSku {
  un: number;
  nome: string | null;
}

const skuDoMsku = (m: string) => m.replace(/^FBA[-_]/i, "").replace(/[-_](FBA|FBAA|FBM)$/i, "").trim();
export const chaveCaixa = (shopId: number | null | undefined, sku: string) => `${shopId ?? 0}|${sku}`;

export function useCaixasAmazon() {
  return useQuery({
    queryKey: ["amazon-modelos", "reposicao"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Map<string, CaixaSku>> => {
      const { data, error } = await supabaseExternal
        .from("amazon_modelo_caixa")
        .select("shop_id, msku, sku, nome, un_por_caixa");
      if (error) throw error;
      const vistos = new Map<string, CaixaSku | null>();
      for (const m of (data ?? []) as { shop_id: number; msku: string; sku: string | null; nome: string | null; un_por_caixa: number }[]) {
        const un = Number(m.un_por_caixa);
        if (!(un > 0)) continue;
        const k = chaveCaixa(m.shop_id, m.sku || skuDoMsku(m.msku));
        const atual = vistos.get(k);
        if (atual === undefined) vistos.set(k, { un, nome: m.nome });
        else if (atual && atual.un !== un) vistos.set(k, null);
      }
      const mapa = new Map<string, CaixaSku>();
      for (const [k, v] of vistos) if (v) mapa.set(k, v);
      return mapa;
    },
  });
}

/** Sugestão em caixas fechadas: múltiplo mais próximo (no mínimo 1 caixa); se passar do disponível, desce uma caixa. */
export function arredondarCaixa(sugestao: number, un: number, disponivel: number): number {
  if (!(sugestao > 0) || !(un > 1)) return sugestao;
  let caixas = Math.max(1, Math.round(sugestao / un));
  while (caixas > 1 && caixas * un > disponivel) caixas--;
  return caixas * un;
}
