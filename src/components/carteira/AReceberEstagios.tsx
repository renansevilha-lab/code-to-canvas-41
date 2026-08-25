// ============================================================================
// A receber por ESTÁGIO, por carteira (view_carteira_a_receber).
// Shopee: pedidos válidos (45d) sem crédito de escrow, estagiados pelo status —
// cada estágio tem prazo esperado diferente, e "a enviar" ainda pode cancelar
// (dinheiro condicionado). ML: pagamentos com liberação pendente em faixas de
// prazo, com a DATA REAL informada pelo Mercado Pago.
// ============================================================================
import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";

interface AReceberRow {
  carteira: string;
  marketplace: string;
  ordem: number;
  estagio: string;
  pedidos: number;
  valor: number;
  prazo_real: boolean;
}

const COR_ESTAGIO: Record<number, string> = {
  1: "#B7791F", // a enviar / liberação atrasada — atenção
  2: "#2F6FB0", // em trânsito / até 7 dias
  3: "#7A5CC7", // entregue / depois de 7 dias
  4: "#0E8A5F", // liberação pendente / avulso
};

export function AReceberEstagios() {
  const [rows, setRows] = useState<AReceberRow[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseExternal
        .from("view_carteira_a_receber")
        .select("*")
        .order("carteira")
        .order("ordem");
      if (error) { setErro(error.message); return; }
      setRows((data ?? []) as AReceberRow[]);
    })();
  }, []);

  if (erro) return null;

  const porCarteira = new Map<string, AReceberRow[]>();
  for (const r of rows ?? []) {
    if (!porCarteira.has(r.carteira)) porCarteira.set(r.carteira, []);
    porCarteira.get(r.carteira)!.push(r);
  }
  const totalGeral = (rows ?? []).reduce((s, r) => s + Number(r.valor), 0);

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h2 className="text-[14.5px] font-semibold tracking-[-0.015em]">
          A receber por estágio
          {rows !== null && (
            <span className="ml-2 tabular-nums font-mono text-muted-foreground font-normal">
              {formatBRL(totalGeral)}
            </span>
          )}
        </h2>
        <span className="text-[11.5px] text-muted-foreground">
          Shopee: pedidos sem crédito de escrow (45 dias) · ML: liberação pendente com data real
        </span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows === null ? (
          <Card className="p-4 text-sm text-muted-foreground">Carregando…</Card>
        ) : (
          [...porCarteira.entries()].map(([carteira, itens]) => {
            const total = itens.reduce((s2, r) => s2 + Number(r.valor), 0);
            const pedidosTot = itens.reduce((s2, r) => s2 + Number(r.pedidos), 0);
            return (
              <Card key={carteira} className="p-4 space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-semibold">{carteira}</span>
                  <span className="tabular-nums font-mono text-[15px] font-semibold">{formatBRL(total)}</span>
                </div>
                <div className="text-[11px] text-muted-foreground -mt-1.5">
                  {pedidosTot.toLocaleString("pt-BR")} {itens[0]?.prazo_real ? "pagamentos" : "pedidos"}
                </div>
                <div className="flex h-2 rounded-full overflow-hidden bg-muted">
                  {itens.map((r) => (
                    <div
                      key={r.ordem}
                      title={`${r.estagio}: ${formatBRL(Number(r.valor))}`}
                      style={{
                        width: `${total > 0 ? (Number(r.valor) / total) * 100 : 0}%`,
                        background: COR_ESTAGIO[r.ordem] ?? "#888",
                      }}
                    />
                  ))}
                </div>
                <div className="space-y-1">
                  {itens.map((r) => (
                    <div key={r.ordem} className="flex items-center gap-2 text-[12px]">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: COR_ESTAGIO[r.ordem] ?? "#888" }} />
                      <span className="flex-1 min-w-0 truncate" title={r.estagio}>{r.estagio}</span>
                      <span className="text-muted-foreground tabular-nums shrink-0">{Number(r.pedidos).toLocaleString("pt-BR")}</span>
                      <span className="tabular-nums font-mono w-[92px] text-right shrink-0">{formatBRL(Number(r.valor))}</span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
