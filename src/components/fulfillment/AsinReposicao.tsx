import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";

// ASIN de cada produto na Reposição da Amazon, para copiar na hora de montar o envio no Seller Central
// (pedido do dono, 10/nov/2026). Fonte: pesquisa_amz_meus_skus (conta × SKU da Amazon → ASIN → nosso SKU,
// refeita toda semana pela pesquisa-amz). Um SKU nosso pode ter mais de um anúncio na mesma conta (ex.: 15825 e
// FBA-15825): o primeiro é o anúncio que tem estoque no CD (estoque_fulfillment), depois os que terminam em FBA.

export interface AsinAmz {
  asin: string;
  msku: string;
  cd: number | null;
}

const CONTA_SHOP: Record<string, number> = { ottz: 900001, svl: 900002 };
export const chaveAsin = (shopId: number | null | undefined, sku: string) => `${shopId ?? 0}|${sku}`;

async function lerTudo<T>(consulta: (de: number, ate: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await consulta(de, de + 999);
    if (error) throw error;
    const lote = (data ?? []) as T[];
    out.push(...lote);
    if (lote.length < 1000) break;
  }
  return out;
}

export function useAsinsAmazon(ligado: boolean) {
  return useQuery({
    queryKey: ["reposicao-asins-amazon"],
    enabled: ligado,
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<Map<string, AsinAmz[]>> => {
      const [skus, cds] = await Promise.all([
        lerTudo<{ conta: string; sku_amazon: string; asin: string | null; sku: string | null }>((de, ate) =>
          supabaseExternal.from("pesquisa_amz_meus_skus").select("conta, sku_amazon, asin, sku").not("asin", "is", null).range(de, ate)),
        lerTudo<{ shop_id: number; sku_marketplace: string; sellable: number | null; reserved: number | null; in_transit: number | null }>((de, ate) =>
          supabaseExternal.from("estoque_fulfillment").select("shop_id, sku_marketplace, sellable, reserved, in_transit").eq("marketplace", "amazon").range(de, ate)),
      ]);
      const noCd = new Map<string, number>();
      for (const e of cds) {
        const k = `${e.shop_id}|${e.sku_marketplace}`;
        noCd.set(k, (noCd.get(k) ?? 0) + (e.sellable ?? 0) + (e.reserved ?? 0) + (e.in_transit ?? 0));
      }
      const mapa = new Map<string, AsinAmz[]>();
      for (const s of skus) {
        const shop = CONTA_SHOP[s.conta];
        if (!shop || !s.sku || !s.asin) continue;
        const k = chaveAsin(shop, s.sku);
        const lista = mapa.get(k) ?? [];
        const cd = noCd.has(`${shop}|${s.sku_amazon}`) ? noCd.get(`${shop}|${s.sku_amazon}`)! : null;
        lista.push({ asin: s.asin, msku: s.sku_amazon, cd });
        mapa.set(k, lista);
      }
      const fba = (m: string) => /fba/i.test(m);
      for (const lista of mapa.values()) {
        lista.sort((a, b) =>
          (b.cd != null ? 1 : 0) - (a.cd != null ? 1 : 0) || (b.cd ?? 0) - (a.cd ?? 0) || (fba(b.msku) ? 1 : 0) - (fba(a.msku) ? 1 : 0) || a.msku.localeCompare(b.msku));
      }
      return mapa;
    },
  });
}

/** ASINs distintos, o principal primeiro (o mesmo ASIN pode aparecer em dois anúncios). */
export function asinsDistintos(lista: AsinAmz[] | undefined): AsinAmz[] {
  const vistos = new Set<string>();
  return (lista ?? []).filter((a) => (vistos.has(a.asin) ? false : (vistos.add(a.asin), true)));
}

export function copiarAsin(asin: string) {
  void navigator.clipboard?.writeText(asin).then(
    () => toast.success(`ASIN ${asin} copiado`),
    () => toast.error("Não consegui copiar"),
  );
}

/** Selo "ASIN B0… ⧉" que copia ao clicar. */
export function SeloAsin({ a, extra }: { a: AsinAmz; extra?: number }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copiarAsin(a.asin); }}
      title={`Copiar o ASIN ${a.asin} · anúncio ${a.msku}${a.cd != null ? ` · ${a.cd} no CD` : ""}${extra ? ` · mais ${extra} ASIN${extra > 1 ? "s" : ""} no detalhe da linha` : ""}`}
      className="pm-mono pm-hv"
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--pm-bc)", borderRadius: 5, background: "var(--pm-s)",
        padding: "0 5px", height: 18, fontSize: 10.5, color: "var(--pm-t2)", cursor: "pointer", flex: "none",
      }}
    >
      {a.asin}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {extra ? <span style={{ color: "var(--pm-t3)" }}>+{extra}</span> : null}
    </button>
  );
}
