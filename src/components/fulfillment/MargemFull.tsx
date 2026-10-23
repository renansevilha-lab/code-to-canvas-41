import { useQuery } from "@tanstack/react-query";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// Margem de contribuição dos últimos 30 dias por conta e SKU, separada em vendas que saíram
// do Full/FBA e vendas fora dele. Calculada no banco (mv_reposicao_margem_30d, 2×/dia): margem do
// Pedidos Integrados rateada pelos itens do pedido; sem ADS e sem custo de armazenagem do Full.
export interface MargemFull {
  shop_id: number;
  sku: string;
  un_full: number | string;
  pedidos_full: number;
  venda_full: number | string;
  margem_full: number | string;
  mc_pct_full: number | string | null;
  un_fora: number | string;
  pedidos_fora: number;
  venda_fora: number | string;
  margem_fora: number | string;
  mc_pct_fora: number | string | null;
  atualizado_em: string;
}

const n = (v: unknown) => (v == null || v === "" ? 0 : Number(v));
export const chaveMargem = (shopId: number | null | undefined, sku: string) => `${shopId ?? 0}|${sku}`;

export function useMargemFull() {
  return useQuery({
    queryKey: ["reposicao-margem-30d"],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Map<string, MargemFull>> => {
      const mapa = new Map<string, MargemFull>();
      // ~500 linhas hoje; pagina de 1.000 para não ser cortada pelo PostgREST se crescer
      for (let de = 0; ; de += 1000) {
        const { data, error } = await supabaseExternal
          .from("mv_reposicao_margem_30d")
          .select("*")
          .range(de, de + 999);
        if (error) throw error;
        for (const r of (data ?? []) as MargemFull[]) mapa.set(chaveMargem(r.shop_id, r.sku), r);
        if (!data || data.length < 1000) break;
      }
      return mapa;
    },
  });
}

const pct = (v: number) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
const corPct = (v: number) =>
  v < 0 ? "text-destructive" : v < 0.1 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";

export function MargemFullCell({ m }: { m: MargemFull | undefined }) {
  const unFull = n(m?.un_full);
  const unFora = n(m?.un_fora);
  if (!m || (unFull === 0 && unFora === 0)) {
    return <span className="text-muted-foreground text-[12px]">—</span>;
  }
  const temFull = unFull > 0 && m.mc_pct_full != null;
  const temFora = unFora > 0 && m.mc_pct_fora != null;
  const mcFull = n(m.mc_pct_full);
  const mcFora = n(m.mc_pct_fora);
  const porUn = unFull > 0 ? n(m.margem_full) / unFull : 0;
  const diff = temFull && temFora ? mcFull - mcFora : 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help">
          {temFull ? (
            <div className={cn("tabular-nums font-mono text-[13px] font-semibold", corPct(mcFull))}>{pct(mcFull)}</div>
          ) : (
            <div className="text-[11px] text-muted-foreground">sem venda Full</div>
          )}
          {/* uma informação por linha: juntas na mesma linha passavam da coluna e invadiam a vizinha */}
          <div className="text-[10.5px] leading-tight text-muted-foreground whitespace-nowrap">
            {temFull && <div>{formatBRL(porUn)}/un</div>}
            {temFora && (
              <div className={cn(Math.abs(diff) >= 0.03 && (diff < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"))}>
                fora {pct(mcFora)}
              </div>
            )}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        <div className="font-semibold mb-1">Margem de contribuição · últimos 30 dias nesta conta</div>
        {temFull ? (
          <div>
            Pelo Full: {pct(mcFull)} — {formatNumber(unFull)} un em {formatNumber(m.pedidos_full)} pedidos, venda{" "}
            {formatBRL(n(m.venda_full))}, margem {formatBRL(n(m.margem_full))}
          </div>
        ) : (
          <div>Pelo Full: sem venda com custo completo nos últimos 30 dias</div>
        )}
        {temFora && (
          <div>
            Fora do Full (coleta, agência, Flex, envio próprio): {pct(mcFora)} — {formatNumber(unFora)} un, margem{" "}
            {formatBRL(n(m.margem_fora))}
          </div>
        )}
        {temFull && temFora && Math.abs(diff) >= 0.03 && (
          <div className="mt-1 font-medium">
            {diff < 0
              ? `O Full rende ${pct(-diff)} a menos que o envio próprio neste produto.`
              : `O Full rende ${pct(diff)} a mais que o envio próprio neste produto.`}
          </div>
        )}
        <div className="mt-1 text-muted-foreground">
          Margem = recebido − custo − imposto (a mesma do Pedidos Integrados), rateada pelos itens do pedido. Não inclui
          ADS nem a armazenagem do Full. Só pedidos com custo completo. Atualiza às 06h41 e 12h41.
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
