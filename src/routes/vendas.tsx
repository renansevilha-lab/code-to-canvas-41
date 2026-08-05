import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUp, ArrowDown, RefreshCw, Loader2, Search } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import { resolveRange, type PeriodPreset, type PeriodRange } from "@/lib/dashboard/period";

// ---------------------------------------------------------------- tipos
interface SkuRow {
  sku: string; nome: string | null; marca: string | null; foto: string | null;
  qtd_atual: number; qtd_anterior: number; valor_atual: number; valor_anterior: number;
}
interface MarcaRow {
  marca: string; qtd_atual: number; qtd_anterior: number;
  valor_atual: number; valor_anterior: number; skus: number;
}

const VALID_PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];
type View = "sku" | "marca";
type SortKey = "valor" | "qtd" | "var";
const SORTS: SortKey[] = ["valor", "qtd", "var"];
const MK_OPCOES = [
  { v: "", l: "Todos os canais" },
  { v: "shopee", l: "Shopee" },
  { v: "mercadolivre", l: "Mercado Livre" },
  { v: "amazon", l: "Amazon" },
];

type SearchP = {
  period: PeriodPreset; from?: string; to?: string;
  view: View; mk?: string; marca?: string; q?: string; sort: SortKey;
};

export const Route = createFileRoute("/vendas")({
  validateSearch: (s: Record<string, unknown>): SearchP => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset) ? (s.period as PeriodPreset) : "mtd",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
    view: s.view === "marca" ? "marca" : "sku",
    mk: typeof s.mk === "string" && s.mk ? s.mk : undefined,
    marca: typeof s.marca === "string" && s.marca ? s.marca : undefined,
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    sort: SORTS.includes(s.sort as SortKey) ? (s.sort as SortKey) : "valor",
  }),
  component: VendasPage,
});

const varPct = (a: number, b: number): number => (!b ? (a > 0 ? Infinity : 0) : (a - b) / b);

function VendasPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.period, search.from, search.to);
  const setRange = (r: PeriodRange) =>
    navigate({ search: (p) => ({ ...p, period: r.preset, from: r.from, to: r.to }), replace: true });
  const patch = (p: Partial<SearchP>) => navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });

  const skuQ = useQuery({
    queryKey: ["vendas", "sku", range.from, range.to, search.mk ?? ""],
    queryFn: async (): Promise<SkuRow[]> => {
      const { data, error } = await supabaseExternal.rpc("vendas_por_sku", {
        data_inicial: range.from, data_final: range.to, p_marketplace: search.mk ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as SkuRow[];
    },
    staleTime: 5 * 60 * 1000,
  });
  const marcaQ = useQuery({
    queryKey: ["vendas", "marca", range.from, range.to, search.mk ?? ""],
    queryFn: async (): Promise<MarcaRow[]> => {
      const { data, error } = await supabaseExternal.rpc("vendas_por_marca", {
        data_inicial: range.from, data_final: range.to, p_marketplace: search.mk ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as MarcaRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const marcasDisponiveis = useMemo(() => {
    const s = new Set<string>();
    for (const r of skuQ.data ?? []) if (r.marca) s.add(r.marca);
    return Array.from(s).sort();
  }, [skuQ.data]);

  const skuRows = useMemo(() => {
    let r = skuQ.data ?? [];
    if (search.marca) r = r.filter((x) => x.marca === search.marca);
    if (search.q) {
      const t = search.q.toLowerCase();
      r = r.filter((x) => (x.nome ?? "").toLowerCase().includes(t) || x.sku.toLowerCase().includes(t));
    }
    const cmp: Record<SortKey, (a: SkuRow, b: SkuRow) => number> = {
      valor: (a, b) => b.valor_atual - a.valor_atual,
      qtd: (a, b) => b.qtd_atual - a.qtd_atual,
      var: (a, b) => varPct(b.qtd_atual, b.qtd_anterior) - varPct(a.qtd_atual, a.qtd_anterior),
    };
    return [...r].sort(cmp[search.sort]);
  }, [skuQ.data, search.marca, search.q, search.sort]);

  const marcaRows = useMemo(() => {
    let r = marcaQ.data ?? [];
    if (search.q) {
      const t = search.q.toLowerCase();
      r = r.filter((x) => x.marca.toLowerCase().includes(t));
    }
    const cmp: Record<SortKey, (a: MarcaRow, b: MarcaRow) => number> = {
      valor: (a, b) => b.valor_atual - a.valor_atual,
      qtd: (a, b) => b.qtd_atual - a.qtd_atual,
      var: (a, b) => varPct(b.qtd_atual, b.qtd_anterior) - varPct(a.qtd_atual, a.qtd_anterior),
    };
    return [...r].sort(cmp[search.sort]);
  }, [marcaQ.data, search.q, search.sort]);

  const isSku = search.view === "sku";
  const loading = isSku ? skuQ.isLoading : marcaQ.isLoading;
  const linhas = isSku ? skuRows : marcaRows;
  const totValor = linhas.reduce((s, r) => s + Number(r.valor_atual ?? 0), 0);
  const totQtd = linhas.reduce((s, r) => s + Number(r.qtd_atual ?? 0), 0);
  const maxValor = linhas.reduce((m, r) => Math.max(m, Number(r.valor_atual ?? 0)), 0) || 1;
  const erro = skuQ.error || marcaQ.error;

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/" className="text-muted-foreground hover:text-foreground" title="Voltar ao Dashboard">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">Vendas por produto</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Unidades e receita por {isSku ? "SKU" : "marca"}, com kits destrinchados · atual vs período anterior.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DashboardPeriodFilter value={range} onChange={setRange} />
          <Button
            variant="outline" size="sm" className="h-9 gap-2"
            onClick={() => { void skuQ.refetch(); void marcaQ.refetch(); }}
            disabled={skuQ.isFetching}
          >
            {skuQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi t="Receita" v={formatBRL(totValor, { compact: true })} loading={loading} />
        <Kpi t="Unidades" v={formatNumber(totQtd)} loading={loading} />
        <Kpi t={isSku ? "SKUs" : "Marcas"} v={formatNumber(linhas.length)} loading={loading} />
        <Kpi t="Receita / unid." v={totQtd > 0 ? formatBRL(totValor / totQtd) : "—"} loading={loading} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-card border rounded-[10px] p-[3px]">
          {(["sku", "marca"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => patch({ view: v })}
              className={cn(
                "text-[12.5px] font-medium px-3 py-1.5 rounded-[7px] transition-colors",
                search.view === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "sku" ? "Por SKU" : "Por marca"}
            </button>
          ))}
        </div>
        <select
          value={search.mk ?? ""}
          onChange={(e) => patch({ mk: e.target.value || undefined })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {MK_OPCOES.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
        {isSku && (
          <select
            value={search.marca ?? ""}
            onChange={(e) => patch({ marca: e.target.value || undefined })}
            className="h-9 rounded-md border bg-background px-2 text-sm max-w-[190px]"
          >
            <option value="">Todas as marcas</option>
            {marcasDisponiveis.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <select
          value={search.sort}
          onChange={(e) => patch({ sort: e.target.value as SortKey })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="valor">Maior receita</option>
          <option value="qtd">Mais unidades</option>
          <option value="var">Maior crescimento</option>
        </select>
        <div className="relative ml-auto">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search.q ?? ""}
            onChange={(e) => patch({ q: e.target.value || undefined })}
            placeholder={isSku ? "Buscar produto ou SKU…" : "Buscar marca…"}
            className="h-9 w-[220px] pl-8"
          />
        </div>
      </div>

      {erro && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {(erro as Error).message}
        </Card>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-4 flex flex-col gap-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : isSku ? (
          <SkuTable rows={skuRows} />
        ) : (
          <MarcaTable rows={marcaRows} maxValor={maxValor} />
        )}
      </Card>

      <p className="text-xs text-muted-foreground leading-relaxed">
        Kits destrinchados nos componentes; a receita do kit é rateada pelo peso de CMV de cada componente (a soma bate o
        total do período). "Variação" compara as unidades do período atual com o período imediatamente anterior de mesmo
        tamanho. Escopo: pedidos válidos de Shopee + Mercado Livre + Amazon.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- tabelas
function SkuTable({ rows }: { rows: SkuRow[] }) {
  if (rows.length === 0) return <div className="px-3 py-16 text-center text-sm text-muted-foreground">Nenhum produto com esses filtros.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2" colSpan={2}>Produto</th>
            <th className="text-right font-medium px-3 py-2 w-16">Ant.</th>
            <th className="text-right font-medium px-3 py-2 w-16">Atual</th>
            <th className="text-right font-medium px-3 py-2 w-24">Variação</th>
            <th className="text-right font-medium px-3 py-2 w-28">Receita</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.sku} className="border-t hover:bg-accent/40">
              <td className="pl-3 py-2 w-[52px]">
                {r.foto ? (
                  <img src={r.foto} alt="" className="h-10 w-10 rounded object-cover border" loading="lazy" />
                ) : (
                  <div className="h-10 w-10 rounded bg-muted" />
                )}
              </td>
              <td className="py-2 pr-3 min-w-0">
                <div className="font-medium truncate max-w-[440px]" title={r.nome ?? r.sku}>{r.nome ?? r.sku}</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {r.sku}{r.marca && r.marca !== "(sem marca)" ? ` · ${r.marca}` : ""}
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono">{formatNumber(r.qtd_anterior)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-mono font-medium">{formatNumber(r.qtd_atual)}</td>
              <td className="px-3 py-2 text-right"><VarBadge a={Number(r.qtd_atual ?? 0)} b={Number(r.qtd_anterior ?? 0)} /></td>
              <td className="px-3 py-2 text-right tabular-nums font-mono font-semibold">{formatBRL(r.valor_atual)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarcaTable({ rows, maxValor }: { rows: MarcaRow[]; maxValor: number }) {
  if (rows.length === 0) return <div className="px-3 py-16 text-center text-sm text-muted-foreground">Nenhuma marca com esses filtros.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Marca</th>
            <th className="text-right font-medium px-3 py-2 w-16">SKUs</th>
            <th className="text-right font-medium px-3 py-2 w-16">Ant.</th>
            <th className="text-right font-medium px-3 py-2 w-16">Atual</th>
            <th className="text-right font-medium px-3 py-2 w-24">Variação</th>
            <th className="text-right font-medium px-3 py-2 w-28">Receita</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const w = Math.max(2, (Number(r.valor_atual ?? 0) / maxValor) * 100);
            return (
              <tr key={r.marca} className="border-t hover:bg-accent/40">
                <td className="px-3 py-2 min-w-0">
                  <div className="font-medium truncate max-w-[280px]" title={r.marca}>{r.marca}</div>
                  <div className="mt-1 h-1.5 w-40 rounded bg-muted overflow-hidden">
                    <div className="h-full rounded bg-primary" style={{ width: `${w}%` }} />
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono">{formatNumber(r.skus)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground font-mono">{formatNumber(r.qtd_anterior)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-mono font-medium">{formatNumber(r.qtd_atual)}</td>
                <td className="px-3 py-2 text-right"><VarBadge a={Number(r.qtd_atual ?? 0)} b={Number(r.qtd_anterior ?? 0)} /></td>
                <td className="px-3 py-2 text-right tabular-nums font-mono font-semibold">{formatBRL(r.valor_atual)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VarBadge({ a, b }: { a: number; b: number }) {
  if (!b) return <span className="text-[11px] text-muted-foreground">{a > 0 ? "novo" : "—"}</span>;
  const v = (a - b) / b;
  const up = v > 0.005, down = v < -0.005;
  const cls = up ? "text-success" : down ? "text-destructive" : "text-muted-foreground";
  const Icon = up ? ArrowUp : down ? ArrowDown : null;
  return (
    <span className={cn("inline-flex items-center gap-0.5 justify-end text-[12px] font-medium font-mono tabular-nums", cls)}>
      {Icon && <Icon className="h-3 w-3" />}
      {`${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`}
    </span>
  );
}

function Kpi({ t, v, loading }: { t: string; v: string; loading: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{t}</div>
      {loading ? <Skeleton className="h-7 w-20 mt-1.5" /> : <div className="text-xl font-semibold tabular-nums mt-1 font-mono">{v}</div>}
    </Card>
  );
}
