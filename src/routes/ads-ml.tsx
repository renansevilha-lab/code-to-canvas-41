import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone, RefreshCw, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

interface Campanha {
  campaign_id: number;
  nome: string | null;
  status: string | null;
  strategy: string | null;
  acos_target: number | null;
  roas_target: number | null;
  budget: number | null;
  cliques: number | null;
  impressoes: number | null;
  gasto: number | null;
  cpc: number | null;
  vendas_diretas: number | null;
  vendas_indiretas: number | null;
  vendas_total: number | null;
  unidades: number | null;
  acos: number | null;
  roas: number | null;
  janela_de: string | null;
  janela_ate: string | null;
  atualizado_em: string | null;
}

const num = (v: number | null | undefined) => (v ?? 0).toLocaleString("pt-BR");

export const Route = createFileRoute("/ads-ml")({ component: AdsMlPage });

function AdsMlPage() {
  const [sincronizando, setSincronizando] = useState(false);

  const q = useQuery({
    queryKey: ["ads-ml", "campanhas"],
    queryFn: async (): Promise<Campanha[]> => {
      const { data, error } = await supabaseExternal
        .from("ml_ads_campanha")
        .select("*")
        .order("gasto", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Campanha[];
    },
  });
  const rows = q.data ?? [];

  const tot = useMemo(() => {
    const gasto = rows.reduce((s, r) => s + (r.gasto ?? 0), 0);
    const vendas = rows.reduce((s, r) => s + (r.vendas_total ?? 0), 0);
    const cliques = rows.reduce((s, r) => s + (r.cliques ?? 0), 0);
    const impressoes = rows.reduce((s, r) => s + (r.impressoes ?? 0), 0);
    return {
      gasto, vendas, cliques, impressoes,
      roas: gasto > 0 ? vendas / gasto : 0,
      acos: vendas > 0 ? (gasto / vendas) * 100 : 0,
    };
  }, [rows]);

  const janela = rows[0] ? `${rows[0].janela_de ?? ""} → ${rows[0].janela_ate ?? ""}` : null;

  async function sincronizar() {
    setSincronizando(true);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("ml-sync-ads", { body: {} });
      if (error) throw new Error(error.message);
      const d = data as { campanhas?: number; erros?: unknown[] };
      toast.success(`Sincronizado · ${d?.campanhas ?? 0} campanha(s)`);
      q.refetch();
    } catch (e) {
      toast.error("Falha ao sincronizar", { description: (e as Error).message });
    } finally {
      setSincronizando(false);
    }
  }

  // cor do ROAS vs meta: >= meta verde, >=1 âmbar, <1 vermelho (perde dinheiro)
  function corRoas(r: Campanha) {
    const roas = r.roas ?? 0;
    if ((r.gasto ?? 0) <= 0) return "text-muted-foreground";
    if (roas < 1) return "text-red-600 dark:text-red-400";
    if (r.roas_target && roas < r.roas_target) return "text-amber-600 dark:text-amber-400";
    return "text-emerald-600 dark:text-emerald-400";
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Megaphone className="h-6 w-6" /> ADS Mercado Livre
          </h1>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void sincronizar()} disabled={sincronizando}>
            {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sincronizar
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Campanhas do Mercado Ads (Product Ads){janela ? ` · janela ${janela}` : ""}. Atualiza sozinho a cada 6h.
        </p>
      </header>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiCard titulo="Investimento" valor={formatBRL(tot.gasto)} />
        <KpiCard titulo="Vendas atribuídas" valor={formatBRL(tot.vendas)} />
        <KpiCard
          titulo="ROAS geral"
          valor={tot.roas.toFixed(2)}
          icone={tot.roas >= 1 ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
        />
        <KpiCard titulo="ACOS geral" valor={`${tot.acos.toFixed(1)}%`} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4 border-b">
          <h3 className="text-sm font-semibold">Campanhas {q.data && <span className="text-muted-foreground font-normal">({rows.length})</span>}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Campanha</th>
                <th className="text-center font-medium px-3 py-2">Status</th>
                <th className="text-right font-medium px-3 py-2">Investimento</th>
                <th className="text-right font-medium px-3 py-2">Vendas</th>
                <th className="text-right font-medium px-3 py-2">ROAS</th>
                <th className="text-right font-medium px-3 py-2">Meta ROAS</th>
                <th className="text-right font-medium px-3 py-2">ACOS</th>
                <th className="text-right font-medium px-3 py-2">CPC</th>
                <th className="text-right font-medium px-3 py-2">Cliques</th>
                <th className="text-right font-medium px-3 py-2">Impr.</th>
                <th className="text-right font-medium px-3 py-2">Budget/dia</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-t"><td colSpan={11} className="px-3 py-3"><Skeleton className="h-5 w-full" /></td></tr>
                ))
              ) : rows.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-12 text-center text-sm text-muted-foreground">
                  Nenhuma campanha sincronizada. Clique em <strong>Sincronizar</strong>.
                </td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.campaign_id} className="border-t hover:bg-accent/40">
                    <td className="px-3 py-2 max-w-[260px] truncate font-medium">{r.nome ?? `#${r.campaign_id}`}</td>
                    <td className="px-3 py-2 text-center">
                      <Badge variant="outline" className={cn("text-[10px] h-5 px-1.5", r.status === "active" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                        {r.status === "active" ? "ativa" : (r.status ?? "—")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{formatBRL(r.gasto ?? 0)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.vendas_total ?? 0)}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums font-semibold", corRoas(r))}>{(r.roas ?? 0).toFixed(2)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.roas_target ? r.roas_target.toFixed(1) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.acos != null ? `${r.acos.toFixed(1)}%` : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.cpc != null ? formatBRL(r.cpc) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(r.cliques)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{num(r.impressoes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.budget != null ? formatBRL(r.budget) : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Vendas atribuídas = diretas + indiretas (janela do Mercado Ads). ROAS em <span className="text-red-600 dark:text-red-400">vermelho</span> = abaixo de 1 (gasta mais do que vende);
        <span className="text-amber-600 dark:text-amber-400"> âmbar</span> = abaixo da meta; <span className="text-emerald-600 dark:text-emerald-400">verde</span> = na meta ou acima.
      </p>
    </div>
  );
}

function KpiCard({ titulo, valor, icone }: { titulo: string; valor: string; icone?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{titulo}{icone}</div>
      <div className="text-2xl font-semibold tabular-nums mt-1">{valor}</div>
    </Card>
  );
}
