// Encaixotamento do envio da Amazon (22/out/2026, pedido do dono): o mesmo conteúdo da "folha da remessa" do Seller
// Central, direto no envio — caixas iguais agrupadas (quantas, o que vai em cada, medidas, peso, nomes) e o preparo que a
// Amazon exige por produto. Os dados vêm de amazon_envio_plano.envios_amazon[].encaixotamento, gravado pela
// amazon-inbound (v11) ao criar o envio ou na rodada de 10 min.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

interface CaixaEnc { id: string | null; nome: string | null; qtd: number; kg: number | null; c: number | null; l: number | null; a: number | null; unidade: string; itens: { msku: string; q: number }[] }
interface ItemEnc { msku: string; asin: string | null; fnsku: string | null; q: number; etiqueta: string | null; validade: string | null; preparo: { tipo: string; quem: string | null }[] }
interface Encaixotamento { lido_em: string; caixas: CaixaEnc[]; itens: ItemEnc[] }

const PREPARO: Record<string, string> = {
  ITEM_LABELING: "etiqueta FNSKU", ITEM_POLYBAGGING: "saco plástico", ITEM_BUBBLEWRAP: "plástico bolha", ITEM_TAPING: "fita",
  ITEM_BLACK_SHRINKWRAP: "filme preto", ITEM_BOXING: "caixa", ITEM_SETCREAT: "montar conjunto", ITEM_SETSTK: "etiqueta de conjunto",
  ITEM_CAP_SEALING: "lacre da tampa", ITEM_SUFFOSTK: "aviso de sufocamento", ITEM_HANG_GARMENT: "cabide", ITEM_DEBUNDLE: "desfazer conjunto",
  ITEM_NO_PREP: "sem preparo", ITEM_RMOVHANG: "tirar cabide", ITEM_SIOC: "embalagem própria",
};
const nomePreparo = (t: string) => PREPARO[t] ?? t.replace(/^ITEM_/, "").toLowerCase().replace(/_/g, " ");

/** "P1 - B1", "P1 - B2"… → "B1–B3, B7"; nomes que não seguem o padrão saem como vieram. */
function faixas(nomes: string[]): string {
  const nums = nomes.map((n) => Number(n.match(/B(\d+)\s*$/)?.[1])).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length !== nomes.length) return nomes.join(", ");
  const partes: string[] = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    partes.push(j > i ? `B${nums[i]}–B${nums[j]}` : `B${nums[i]}`);
    i = j;
  }
  return partes.join(", ");
}

export function EncaixotamentoAmazon({ numero }: { numero: string }) {
  const [lendo, setLendo] = useState(false);
  const q = useQuery({
    queryKey: ["fulfillment", "encaixotamento-amazon", numero],
    staleTime: 60_000,
    placeholderData: undefined,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("amazon_envio_plano").select("id, itens, envios_amazon")
        .contains("envios_amazon", JSON.stringify([{ fba: numero }])).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const envio = ((data.envios_amazon ?? []) as { fba: string; encaixotamento?: Encaixotamento }[]).find((e) => e.fba === numero);
      const nomes = new Map(((data.itens ?? []) as { msku: string; sku: string; titulo: string | null }[]).map((l) => [String(l.msku), l]));
      return { plano: String(data.id), enc: envio?.encaixotamento ?? null, nomes };
    },
  });
  if (q.isLoading) return null;
  if (!q.data) return null; // envio que não nasceu de um plano do app (importado do Seller Central): sem estes dados

  async function lerAgora() {
    setLendo(true);
    try {
      const { data } = await supabaseExternal.auth.getSession();
      const r = await fetch(`${EXTERNAL_URL}/functions/v1/amazon-inbound`, {
        method: "POST",
        headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ modulo: "nf-remessa", plano: q.data!.plano }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { erro?: string }).erro ?? `HTTP ${r.status}`);
      await q.refetch();
    } catch (e) { toast.error("Não consegui ler da Amazon", { description: (e as Error).message }); } finally { setLendo(false); }
  }

  const enc = q.data.enc;
  const nome = (msku: string) => q.data!.nomes.get(msku);
  // caixas iguais (mesmo conteúdo, medidas e peso) numa linha só
  const grupos = new Map<string, { caixas: CaixaEnc[]; total: number }>();
  for (const cx of enc?.caixas ?? []) {
    const chave = [cx.itens.map((i) => `${i.msku}×${i.q}`).sort().join("+"), cx.c, cx.l, cx.a, cx.kg].join("|");
    const g = grupos.get(chave) ?? { caixas: [], total: 0 };
    g.caixas.push(cx);
    g.total += cx.qtd;
    grupos.set(chave, g);
  }
  const totalCaixas = (enc?.caixas ?? []).reduce((s, c) => s + c.qtd, 0);
  const totalUn = (enc?.caixas ?? []).reduce((s, c) => s + c.qtd * c.itens.reduce((t, i) => t + i.q, 0), 0);
  const totalKg = (enc?.caixas ?? []).reduce((s, c) => s + c.qtd * (c.kg ?? 0), 0);
  const especiais = (enc?.itens ?? []).filter((i) => i.preparo.some((p) => p.tipo !== "ITEM_LABELING" && p.tipo !== "ITEM_NO_PREP"));

  return (
    <Card className="p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Boxes className="h-4 w-4" /> Encaixotamento (Amazon)</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {enc && <span>{formatNumber(totalCaixas)} caixas · {formatNumber(totalUn)} un · {formatNumber(Math.round(totalKg))} kg</span>}
          <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={lendo} onClick={() => void lerAgora()}
            title="Relê as caixas, a NF e a coleta na Amazon">
            {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Ler da Amazon
          </Button>
        </div>
      </div>
      {!enc ? (
        <p className="text-sm text-muted-foreground">Ainda não lido da Amazon — aparece em até 10 minutos, ou clique em "Ler da Amazon".</p>
      ) : (
        <>
          {especiais.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> Preparo exigido pela Amazon:{" "}
              {especiais.map((i) => `${nome(i.msku)?.sku ?? i.msku}: ${i.preparo.map((p) => nomePreparo(p.tipo)).join(" + ")}`).join(" · ")}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-right font-semibold">Caixas</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Cada caixa leva</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Medidas</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Peso/cx</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Nomes</th>
                </tr>
              </thead>
              <tbody>
                {[...grupos.values()].map((g, k) => {
                  const cx = g.caixas[0];
                  return (
                    <tr key={k} className="border-t align-top">
                      <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums">{formatNumber(g.total)}</td>
                      <td className="px-2 py-1.5">
                        {cx.itens.map((i) => (
                          <div key={i.msku}>
                            <b>{i.q} un</b> · <span className="font-mono text-[12px]">{nome(i.msku)?.sku ?? i.msku}</span>
                            {nome(i.msku)?.sku && nome(i.msku)?.sku !== i.msku && <span className="font-mono text-[11px] text-muted-foreground"> ({i.msku})</span>}
                            {nome(i.msku)?.titulo && <span className="text-muted-foreground"> — {nome(i.msku)!.titulo}</span>}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{cx.c ?? "?"}×{cx.l ?? "?"}×{cx.a ?? "?"} {String(cx.unidade).toLowerCase()}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{cx.kg != null ? `${formatNumber(cx.kg)} kg` : "—"}</td>
                      <td className="px-2 py-1.5 text-[12px] text-muted-foreground">{faixas(g.caixas.map((c) => c.nome ?? c.id ?? ""))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            {(enc.itens ?? []).map((i) => (
              <span key={i.msku} className="mr-3 inline-block">
                <span className="font-mono">{i.msku}</span> · FNSKU {i.fnsku ?? "—"} · {formatNumber(i.q)} un
                {i.validade ? ` · validade ${i.validade.slice(8, 10)}/${i.validade.slice(5, 7)}/${i.validade.slice(0, 4)}` : ""}
                {` · ${i.preparo.length ? i.preparo.map((p) => nomePreparo(p.tipo)).join(" + ") : "sem preparo"}`}
              </span>
            ))}
            <span>· lido em {new Date(enc.lido_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        </>
      )}
    </Card>
  );
}
