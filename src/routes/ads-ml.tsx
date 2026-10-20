import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Megaphone, RefreshCw, Loader2, TrendingUp, TrendingDown, ChevronRight, ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import { resolveRange, type PeriodPreset, type PeriodRange } from "@/lib/dashboard/period";

interface Campanha {
  campaign_id: number;
  nome: string | null;
  status: string | null;
  acos_target: number | null;
  roas_target: number | null;
  budget: number | null;
  cliques: number | null;
  impressoes: number | null;
  gasto: number | null;
  cpc: number | null;
  vendas_total: number | null;
  acos: number | null;
  roas: number | null;
}

const num = (v: number | null | undefined) => (v ?? 0).toLocaleString("pt-BR");
const VALID_PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];

type SearchParams = { period: PeriodPreset; from?: string; to?: string; campanha?: number };

/** Página da campanha no painel do Mercado Ads. Endereço não conferido com login — se não abrir a campanha,
 *  trocar aqui pelo endereço que o navegador mostra ao abrir uma campanha no painel. */
const urlCampanhaML = (id: number) => `https://ads.mercadolivre.com.br/product-ads/campaigns/${id}`;

interface AnuncioCampanha {
  item_id: string; titulo: string | null; status: string | null; preco: number | null; catalogo: boolean | null;
  logistica: string | null; foto: string | null; link: string | null;
  gasto: number; cliques: number; impressoes: number; vendas: number; unidades: number; roas: number | null;
}

export const Route = createFileRoute("/ads-ml")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset) ? (s.period as PeriodPreset) : "last30",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
    campanha: Number(s.campanha) > 0 ? Number(s.campanha) : undefined,
  }),
  component: AdsMlPage,
});

function AdsMlPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.period, search.from, search.to);
  const setRange = (r: PeriodRange) => navigate({ search: { period: r.preset, from: r.from, to: r.to, campanha: search.campanha }, replace: true });
  // campanha aberta na URL: sobrevive à remontagem e dá para mandar o link
  const abrir = (id: number) => navigate({ search: { ...search, campanha: search.campanha === id ? undefined : id }, replace: true, resetScroll: false });

  const q = useQuery({
    queryKey: ["ads-ml", "campanhas", range.from, range.to],
    queryFn: async (): Promise<Campanha[]> => {
      const { data, error } = await supabaseExternal.functions.invoke("ml-sync-ads", {
        body: { date_from: range.from, date_to: range.to, persist: false },
      });
      if (error) throw new Error(error.message);
      const d = data as { erro?: string; lista?: Campanha[] };
      if (d?.erro) throw new Error(d.erro);
      return (d?.lista ?? []).sort((a, b) => (b.gasto ?? 0) - (a.gasto ?? 0));
    },
  });
  const rows = q.data ?? [];

  const tot = useMemo(() => {
    const gasto = rows.reduce((s, r) => s + (r.gasto ?? 0), 0);
    const vendas = rows.reduce((s, r) => s + (r.vendas_total ?? 0), 0);
    return { gasto, vendas, roas: gasto > 0 ? vendas / gasto : 0, acos: vendas > 0 ? (gasto / vendas) * 100 : 0 };
  }, [rows]);

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
          <div className="flex items-center gap-2">
            <DashboardPeriodFilter value={range} onChange={setRange} />
            <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => q.refetch()} disabled={q.isFetching}>
              {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Atualizar
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Campanhas do Mercado Ads (Product Ads) · janela {range.from} → {range.to}.
        </p>
      </header>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiCard titulo="Investimento" valor={formatBRL(tot.gasto)} carregando={q.isLoading} />
        <KpiCard titulo="Vendas atribuídas" valor={formatBRL(tot.vendas)} carregando={q.isLoading} />
        <KpiCard
          titulo="ROAS geral"
          valor={tot.roas.toFixed(2)}
          carregando={q.isLoading}
          icone={tot.roas >= 1 ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
        />
        <KpiCard titulo="ACOS geral" valor={`${tot.acos.toFixed(1)}%`} carregando={q.isLoading} />
      </div>

      {q.error && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {(q.error as Error).message}
        </Card>
      )}

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
                  Nenhuma campanha nesta janela.
                </td></tr>
              ) : (
                rows.map((r) => (
                  <Fragment key={r.campaign_id}>
                  <tr className={cn("border-t hover:bg-accent/40 cursor-pointer", search.campanha === r.campaign_id && "bg-accent/40")} onClick={() => abrir(r.campaign_id)}>
                    <td className="px-3 py-2 max-w-[260px] font-medium">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", search.campanha === r.campaign_id && "rotate-90")} />
                        <span className="truncate">{r.nome ?? `#${r.campaign_id}`}</span>
                      </span>
                    </td>
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
                  {search.campanha === r.campaign_id && (
                    <tr className="border-t bg-muted/20">
                      <td colSpan={11} className="px-3 py-3"><AnunciosDaCampanha campanha={r} de={range.from} ate={range.to} /></td>
                    </tr>
                  )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        Vendas atribuídas = diretas + indiretas. ROAS <span className="text-red-600 dark:text-red-400">vermelho</span> = abaixo de 1 (gasta mais do que vende);
        <span className="text-amber-600 dark:text-amber-400"> âmbar</span> = abaixo da meta; <span className="text-emerald-600 dark:text-emerald-400">verde</span> = na meta ou acima.
        A tabela `ml_ads_campanha` é atualizada por cron (30 dias) para outros usos; esta tela consulta ao vivo o período escolhido.
        Clique numa campanha para ver os produtos dela (lidos ao vivo no Mercado Ads, com as métricas do mesmo período). O ROAS objetivo
        só muda pelo painel do Mercado Ads — a API do ML recusa a escrita para a nossa conta (19/out).
      </p>
    </div>
  );
}

/** Produtos (anúncios) de uma campanha com as métricas do período — lidos ao vivo no Mercado Ads,
 *  inclusive os que não tiveram impressão; SKU e estoque vêm do espelho `ml_anuncios` (conta Ottz). */
function AnunciosDaCampanha({ campanha, de, ate }: { campanha: Campanha; de: string; ate: string }) {
  const q = useQuery({
    queryKey: ["ads-ml", "anuncios", campanha.campaign_id, de, ate],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.functions.invoke("ml-sync-ads", {
        body: { modulo: "campanha-anuncios", campanha: campanha.campaign_id, de, ate },
      });
      if (error) throw new Error(error.message);
      const d = data as { erro?: string | null; anuncios?: AnuncioCampanha[] };
      if (!d?.anuncios && d?.erro) throw new Error(d.erro);
      const anuncios = d?.anuncios ?? [];
      const ids = anuncios.map((a) => a.item_id);
      const esp = ids.length
        ? await supabaseExternal.from("ml_anuncios").select("mlb, sku, estoque").in("mlb", ids)
        : { data: [] };
      const porMlb = new Map(((esp.data ?? []) as { mlb: string; sku: string | null; estoque: number | null }[]).map((x) => [x.mlb, x]));
      return anuncios.map((a) => ({ ...a, sku: porMlb.get(a.item_id)?.sku ?? null, estoque: porMlb.get(a.item_id)?.estoque ?? null }));
    },
  });
  const lista = q.data ?? [];
  const comGasto = lista.filter((a) => a.gasto > 0).length;
  const copiarId = () => {
    void navigator.clipboard?.writeText(String(campanha.campaign_id));
    toast.success(`ID da campanha copiado: ${campanha.campaign_id}`);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {q.isLoading ? "Lendo os produtos da campanha no Mercado Ads…"
            : `${lista.length} produto(s) na campanha · ${comGasto} com gasto no período`}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={copiarId}>
            <Copy className="h-3.5 w-3.5" /> ID {campanha.campaign_id}
          </Button>
          <Button asChild size="sm" className="h-8 gap-1.5">
            <a href={urlCampanhaML(campanha.campaign_id)} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" /> Abrir no Mercado Ads
            </a>
          </Button>
        </div>
      </div>
      {q.error ? (
        <div className="text-sm text-red-600 dark:text-red-300">Erro ao ler os produtos: {(q.error as Error).message}</div>
      ) : q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : lista.length === 0 ? (
        <div className="text-sm text-muted-foreground py-4 text-center">Nenhum produto nesta campanha.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-background">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-2 py-1.5">Produto</th>
                <th className="text-left font-medium px-2 py-1.5">SKU</th>
                <th className="text-center font-medium px-2 py-1.5">Status</th>
                <th className="text-right font-medium px-2 py-1.5">Preço</th>
                <th className="text-right font-medium px-2 py-1.5">Investimento</th>
                <th className="text-right font-medium px-2 py-1.5">Vendas</th>
                <th className="text-right font-medium px-2 py-1.5">ROAS</th>
                <th className="text-right font-medium px-2 py-1.5">Unid.</th>
                <th className="text-right font-medium px-2 py-1.5">Cliques</th>
                <th className="text-right font-medium px-2 py-1.5">Impr.</th>
                <th className="text-right font-medium px-2 py-1.5">Estoque</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((a) => {
                const meta = campanha.roas_target ?? 0;
                const cor = a.gasto <= 0 ? "text-muted-foreground"
                  : (a.roas ?? 0) < 1 ? "text-red-600 dark:text-red-400"
                  : meta && (a.roas ?? 0) < meta ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400";
                return (
                  <tr key={a.item_id} className="border-t">
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2 min-w-[260px] max-w-[420px]">
                        {a.foto ? <img src={a.foto.replace(/^http:/, "https:")} alt="" className="h-9 w-9 rounded object-cover shrink-0 bg-muted" loading="lazy" />
                          : <div className="h-9 w-9 rounded bg-muted shrink-0" />}
                        <div className="min-w-0">
                          <div className="truncate" title={a.titulo ?? ""}>{a.titulo ?? a.item_id}</div>
                          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            {a.link ? <a href={a.link} target="_blank" rel="noreferrer" className="hover:underline" onClick={(e) => e.stopPropagation()}>{a.item_id}</a> : a.item_id}
                            {a.logistica === "fulfillment" && <span>· Full</span>}
                            {a.catalogo && <span>· catálogo</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[11px]">{a.sku ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      <Badge variant="outline" className={cn("text-[10px] h-5 px-1.5", a.status === "active" ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>
                        {a.status === "active" ? "ativo" : a.status === "paused" ? "pausado" : (a.status ?? "—")}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{a.preco != null ? formatBRL(a.preco) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">{formatBRL(a.gasto)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatBRL(a.vendas)}</td>
                    <td className={cn("px-2 py-1.5 text-right tabular-nums font-semibold", cor)}>{a.roas != null ? a.roas.toFixed(2) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{num(a.unidades)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{num(a.cliques)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{num(a.impressoes)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{a.estoque != null ? num(a.estoque) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KpiCard({ titulo, valor, icone, carregando }: { titulo: string; valor: string; icone?: ReactNode; carregando?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{titulo}{icone}</div>
      {carregando ? <Skeleton className="h-8 w-24 mt-1" /> : <div className="text-2xl font-semibold tabular-nums mt-1">{valor}</div>}
    </Card>
  );
}
