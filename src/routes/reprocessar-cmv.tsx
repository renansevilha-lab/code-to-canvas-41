import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, RefreshCw, Calculator, DownloadCloud } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";

export const Route = createFileRoute("/reprocessar-cmv")({ component: ReprocessarCmv });

const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const inicioMesSP = () => hojeSP().slice(0, 8) + "01";

type ProdInfo = { sku: string; nome: string | null; custo: number | null; tipo: string | null };
type Resultado = { pares: number; pedidos: number; custo_novo: number | null };

function ReprocessarCmv() {
  const [sku, setSku] = useState("");
  const [de, setDe] = useState(inicioMesSP());
  const [ate, setAte] = useState(hojeSP());
  const [puxando, setPuxando] = useState(false);
  const [reproc, setReproc] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  const skuTrim = sku.trim();
  const custoQ = useQuery({
    queryKey: ["reproc-custo", skuTrim],
    enabled: skuTrim.length > 0,
    queryFn: async (): Promise<ProdInfo | null> => {
      const { data, error } = await supabaseExternal
        .from("produtos").select("sku,nome,custo,tipo").eq("sku", skuTrim).maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as ProdInfo | null;
    },
  });

  async function puxarCusto() {
    if (!skuTrim) return;
    setPuxando(true);
    try {
      const { error } = await supabaseExternal.functions.invoke("tiny-sync-produtos", {
        body: { modulo: "detalhar", sku: skuTrim },
      });
      if (error) throw new Error(error.message);
      await custoQ.refetch();
      toast.success("Custo re-detalhado do Tiny");
    } catch (e) {
      toast.error("Falha ao puxar custo", { description: (e as Error).message });
    } finally {
      setPuxando(false);
    }
  }

  async function reprocessar() {
    if (!skuTrim || !de || !ate || de > ate) return;
    if (!window.confirm(
      `Reprocessar o CMV dos pedidos do SKU ${skuTrim} de ${de} até ${ate}?\n\n` +
      `Isso congela o custo ATUAL nesses pedidos — a margem histórica deles será recalculada.`,
    )) return;
    setReproc(true);
    setResultado(null);
    try {
      const { data, error } = await supabaseExternal.rpc("reprocessar_cmv", {
        p_sku: skuTrim, p_de: de, p_ate: ate,
      });
      if (error) throw new Error(error.message);
      const r = (Array.isArray(data) ? data[0] : data) as Resultado;
      setResultado(r);
      toast.success(`Reprocessado: ${r?.pares ?? 0} itens em ${r?.pedidos ?? 0} pedidos`);
    } catch (e) {
      toast.error("Falha ao reprocessar", { description: (e as Error).message });
    } finally {
      setReproc(false);
    }
  }

  const custo = custoQ.data;
  return (
    <div className="w-full px-6 md:px-8 py-6 max-w-3xl flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Calculator className="h-6 w-6 text-primary" /> Reprocessar CMV
        </h1>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          O custo é <strong>congelado no momento da venda</strong> (Shopee e Mercado Livre). Se você corrigiu o custo
          de um produto no Tiny, use esta ferramenta para reaplicar o novo custo aos pedidos de um período — a margem
          histórica daqueles pedidos é recalculada.
        </p>
      </div>

      <Card className="p-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">SKU interno</label>
          <div className="flex gap-2 flex-wrap">
            <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="ex.: 15984" className="max-w-[220px]" />
            <Button variant="outline" className="gap-2" disabled={!skuTrim || puxando} onClick={() => void puxarCusto()}>
              {puxando ? <Loader2 className="h-4 w-4 animate-spin" /> : <DownloadCloud className="h-4 w-4" />} Puxar custo do Tiny
            </Button>
          </div>
          {skuTrim && (
            <div className="text-[13px] mt-1">
              {custoQ.isLoading ? (
                <span className="text-muted-foreground">buscando…</span>
              ) : custo ? (
                <span className="text-muted-foreground">
                  {custo.nome ?? "(sem nome)"} · custo atual{" "}
                  <strong className="text-foreground font-mono">
                    {custo.tipo === "K" ? "kit (soma dos componentes)" : custo.custo != null ? formatBRL(custo.custo) : "—"}
                  </strong>
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">SKU não encontrado no cadastro</span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">De</label>
            <Input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="w-[170px]" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Até</label>
            <Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="w-[170px]" />
          </div>
        </div>

        <div>
          <Button className="gap-2" disabled={!skuTrim || !de || !ate || de > ate || reproc} onClick={() => void reprocessar()}>
            {reproc ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Reprocessar CMV
          </Button>
        </div>

        {resultado && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
            <div className="font-medium text-emerald-700 dark:text-emerald-300">Reprocessado ✓</div>
            <div className="text-muted-foreground mt-1 tabular-nums">
              {resultado.pares} itens · {resultado.pedidos} pedidos · custo unitário aplicado{" "}
              {resultado.custo_novo != null ? formatBRL(resultado.custo_novo) : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1.5">
              Pedidos Integrados reflete na hora; Dashboard e DRE em até ~10 min (refresh dos KPIs).
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Cobre o SKU vendido diretamente <strong>e</strong> os kits que o contêm como componente. Só afeta Shopee e
        Mercado Livre (a Amazon já usa custo próprio). Pedidos novos têm o custo congelado automaticamente (cron a cada 15 min).
      </p>
    </div>
  );
}
