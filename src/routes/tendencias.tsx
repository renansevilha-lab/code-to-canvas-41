import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Minus,
  Circle,
  Search,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/tendencias")({
  component: TendenciasPage,
});

type Janela = "rolling_7d" | "mom";
type Tendencia =
  | "subiu"
  | "caiu"
  | "estavel"
  | "sem_comparativo"
  | "sem_dado_atual";

interface BaseRow {
  empresa: string | null;
  janela: string;
  pedidos_atual: number | null;
  pedidos_anterior: number | null;
  receita_atual: number | null;
  receita_anterior: number | null;
  margem_atual: number | null;
  margem_anterior: number | null;
  mc_pct_atual: number | null;
  mc_pct_anterior: number | null;
  delta_pp: number | null;
  delta_pct: number | null;
  tendencia: Tendencia | string | null;
}
interface CategoriaRow extends BaseRow {
  categoria: string;
}
interface MarcaRow extends BaseRow {
  marca: string;
}
interface ProdutoRow extends BaseRow {
  sku: string;
  nome_produto: string | null;
  marca: string | null;
  categoria: string | null;
}

const JANELA_LABEL: Record<Janela, string> = {
  rolling_7d: "Últimos 7 dias",
  mom: "Últimos 30 dias",
};

function fmtPctDecimal(v: number | null | undefined, decimals = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(decimals).replace(".", ",")}%`;
}
function fmtPp(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1).replace(".", ",")}pp`;
}
function fmtDeltaPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1).replace(".", ",")}%`;
}

function TendenciaBadge({ t }: { t: string | null }) {
  switch (t) {
    case "subiu":
      return (
        <span className="inline-flex items-center gap-1 text-[#10B981]">
          <ArrowUp className="h-3.5 w-3.5" /> Subiu
        </span>
      );
    case "caiu":
      return (
        <span className="inline-flex items-center gap-1 text-[#EF4444]">
          <ArrowDown className="h-3.5 w-3.5" /> Caiu
        </span>
      );
    case "estavel":
      return (
        <span className="inline-flex items-center gap-1 text-[#6B7280]">
          <Minus className="h-3.5 w-3.5" /> Estável
        </span>
      );
    case "sem_comparativo":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Circle className="h-3.5 w-3.5" /> Sem comparativo
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Circle className="h-3.5 w-3.5" /> Sem dados
        </span>
      );
  }
}

function DeltaPp({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  const color =
    v > 0.05 ? "text-[#10B981]" : v < -0.05 ? "text-[#EF4444]" : "text-muted-foreground";
  return <span className={cn("font-medium", color)}>{fmtPp(v)}</span>;
}

const EMPRESAS_FIXAS = ["ACZ Pet", "SVL Store"];

function MultiEmpresaFilter({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: string[];
}) {
  const allSelected = value.length === 0 || value.length === options.length;
  const label =
    allSelected || value.length === 0
      ? "Todas as empresas"
      : value.length === 1
      ? value[0]
      : `${value.length} empresas`;
  const toggle = (e: string) => {
    if (value.includes(e)) onChange(value.filter((x) => x !== e));
    else onChange([...value, e]);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          {label}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Empresa</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={allSelected}
          onCheckedChange={() => onChange([])}
        >
          Todas
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o}
            checked={value.includes(o)}
            onCheckedChange={() => toggle(o)}
          >
            {o}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Aggregation across empresas for top/down + tabela ─────────────────────────
interface AggRow {
  key: string;
  nome: string;
  subtitulo?: string;
  pedidos: number;
  receita_atual: number;
  receita_anterior: number;
  margem_atual: number;
  margem_anterior: number;
  mc_pct_atual: number | null;
  mc_pct_anterior: number | null;
  delta_pp: number | null;
  delta_pct: number | null;
  tendencia: string;
}

function aggregateRows<T extends BaseRow>(
  rows: T[],
  keyFn: (r: T) => string,
  nomeFn: (r: T) => string,
  subFn?: (r: T) => string | undefined,
): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const r of rows) {
    const k = keyFn(r);
    let agg = map.get(k);
    if (!agg) {
      agg = {
        key: k,
        nome: nomeFn(r),
        subtitulo: subFn?.(r),
        pedidos: 0,
        receita_atual: 0,
        receita_anterior: 0,
        margem_atual: 0,
        margem_anterior: 0,
        mc_pct_atual: null,
        mc_pct_anterior: null,
        delta_pp: null,
        delta_pct: null,
        tendencia: "sem_comparativo",
      };
      map.set(k, agg);
    }
    agg.pedidos += Number(r.pedidos_atual ?? 0);
    agg.receita_atual += Number(r.receita_atual ?? 0);
    agg.receita_anterior += Number(r.receita_anterior ?? 0);
    agg.margem_atual += Number(r.margem_atual ?? 0);
    agg.margem_anterior += Number(r.margem_anterior ?? 0);
  }
  for (const a of map.values()) {
    a.mc_pct_atual = a.receita_atual > 0 ? a.margem_atual / a.receita_atual : null;
    a.mc_pct_anterior =
      a.receita_anterior > 0 ? a.margem_anterior / a.receita_anterior : null;
    if (a.mc_pct_atual != null && a.mc_pct_anterior != null) {
      a.delta_pp = a.mc_pct_atual - a.mc_pct_anterior;
      a.delta_pct =
        a.mc_pct_anterior !== 0
          ? (a.mc_pct_atual - a.mc_pct_anterior) / Math.abs(a.mc_pct_anterior)
          : null;
      a.tendencia =
        a.delta_pp > 0.005 ? "subiu" : a.delta_pp < -0.005 ? "caiu" : "estavel";
    } else if (a.mc_pct_atual == null) {
      a.tendencia = "sem_dado_atual";
    } else {
      a.tendencia = "sem_comparativo";
    }
  }
  return Array.from(map.values());
}

function useViewRows<T>(view: string, empresas: string[], janela: Janela) {
  return useQuery({
    queryKey: ["tendencia", view, janela, [...empresas].sort()],
    queryFn: async () => {
      let q = supabaseExternal.from(view).select("*").eq("janela", janela);
      if (empresas.length > 0) q = q.in("empresa", empresas);
      const { data, error } = await q.limit(5000);
      if (error) throw error;
      return (data ?? []) as T[];
    },
  });
}

function TopList({
  rows,
  direction,
}: {
  rows: AggRow[];
  direction: "up" | "down";
}) {
  const filtered = rows.filter((r) => r.delta_pp != null);
  filtered.sort((a, b) =>
    direction === "up"
      ? (b.delta_pp ?? 0) - (a.delta_pp ?? 0)
      : (a.delta_pp ?? 0) - (b.delta_pp ?? 0),
  );
  const top = filtered
    .filter((r) =>
      direction === "up" ? (r.delta_pp ?? 0) > 0 : (r.delta_pp ?? 0) < 0,
    )
    .slice(0, 10);
  const title = direction === "up" ? "Em alta" : "Em queda";
  const dot = direction === "up" ? "🟢" : "🔴";
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          {dot} {title} <span className="text-muted-foreground font-normal">(top 10)</span>
        </h3>
      </div>
      {top.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Sem dados suficientes
        </p>
      ) : (
        <div className="space-y-2">
          {top.map((r) => (
            <div
              key={r.key}
              className="flex items-start justify-between gap-3 py-2 border-b last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate" title={r.nome}>
                  {r.nome}
                </p>
                {r.subtitulo && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {r.subtitulo}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {formatNumber(r.pedidos)} pedidos
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-semibold tabular-nums">
                  {fmtPctDecimal(r.mc_pct_atual)}
                </p>
                <DeltaPp v={r.delta_pp} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

type SortKey = "nome" | "pedidos" | "mc_atual" | "mc_anterior" | "delta_pp" | "delta_pct";
const PAGE_SIZE = 25;

function FullTable({
  rows,
  showSubtitle,
}: {
  rows: AggRow[];
  showSubtitle?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("delta_pp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = rows;
    if (q) {
      arr = arr.filter(
        (r) =>
          r.nome.toLowerCase().includes(q) ||
          (r.subtitulo ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...arr].sort((a, b) => {
      const getter = (r: AggRow): number | string => {
        switch (sortKey) {
          case "nome":
            return r.nome.toLowerCase();
          case "pedidos":
            return r.pedidos;
          case "mc_atual":
            return r.mc_pct_atual ?? -Infinity;
          case "mc_anterior":
            return r.mc_pct_anterior ?? -Infinity;
          case "delta_pp":
            return r.delta_pp ?? Infinity; // null vai pro fim em asc
          case "delta_pct":
            return r.delta_pct ?? Infinity;
        }
      };
      const va = getter(a);
      const vb = getter(b);
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [rows, search, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "nome" ? "asc" : "asc");
    }
  };

  const Th = ({ k, children, align = "left" }: { k: SortKey; children: React.ReactNode; align?: "left" | "right" }) => (
    <th className={cn("px-3 py-2 text-xs font-medium text-muted-foreground", align === "right" && "text-right")}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {children}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    </th>
  );

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="relative w-72">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Buscar…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {filtered.length} registro(s)
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b">
            <tr>
              <Th k="nome">Nome</Th>
              <Th k="pedidos" align="right">Pedidos</Th>
              <Th k="mc_atual" align="right">MC% Atual</Th>
              <Th k="mc_anterior" align="right">MC% Anterior</Th>
              <Th k="delta_pp" align="right">Δpp</Th>
              <Th k="delta_pct" align="right">Δ%</Th>
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Tendência</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  Nenhum dado disponível para esse filtro. Verifique se há pedidos
                  suficientes (mínimo 10) no período selecionado.
                </td>
              </tr>
            ) : (
              pageRows.map((r) => (
                <tr key={r.key} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 max-w-md">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <p className="font-medium truncate">
                            {r.nome.length > 50 ? r.nome.slice(0, 50) + "…" : r.nome}
                          </p>
                        </TooltipTrigger>
                        {r.nome.length > 50 && (
                          <TooltipContent>{r.nome}</TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                    {showSubtitle && r.subtitulo && (
                      <p className="text-[11px] text-muted-foreground truncate">
                        {r.subtitulo}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(r.pedidos)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPctDecimal(r.mc_pct_atual)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtPctDecimal(r.mc_pct_anterior)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <DeltaPp v={r.delta_pp} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {fmtDeltaPct(r.delta_pct)}
                  </td>
                  <td className="px-3 py-2">
                    <TendenciaBadge t={r.tendencia} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-muted-foreground">
            Página {page} de {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Anterior
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
            >
              Próxima
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SectionContent({
  rows,
  showSubtitle,
  isLoading,
}: {
  rows: AggRow[];
  showSubtitle?: boolean;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TopList rows={rows} direction="up" />
        <TopList rows={rows} direction="down" />
      </div>
      <FullTable rows={rows} showSubtitle={showSubtitle} />
    </div>
  );
}

function TendenciasPage() {
  const [empresas, setEmpresas] = useState<string[]>([]);
  const [janela, setJanela] = useState<Janela>("rolling_7d");
  const [tab, setTab] = useState<"categoria" | "marca" | "produto">("categoria");

  const cat = useViewRows<CategoriaRow>("view_tendencia_categoria", empresas, janela);
  const mar = useViewRows<MarcaRow>("view_tendencia_marca", empresas, janela);
  const pro = useViewRows<ProdutoRow>("view_tendencia_produto", empresas, janela);

  const catAgg = useMemo(
    () => aggregateRows(cat.data ?? [], (r) => r.categoria, (r) => r.categoria),
    [cat.data],
  );
  const marAgg = useMemo(
    () => aggregateRows(mar.data ?? [], (r) => r.marca, (r) => r.marca),
    [mar.data],
  );
  const proAgg = useMemo(
    () =>
      aggregateRows(
        pro.data ?? [],
        (r) => r.sku,
        (r) => r.nome_produto ?? r.sku,
        (r) =>
          [r.marca, r.categoria, `SKU ${r.sku}`].filter(Boolean).join(" · "),
      ),
    [pro.data],
  );

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-2xl font-semibold">Tendências de Margem</h1>
        <p className="text-sm text-muted-foreground">
          Variação de MC% no período comparado ao anterior
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <MultiEmpresaFilter
          value={empresas}
          onChange={setEmpresas}
          options={EMPRESAS_FIXAS}
        />
        <Select value={janela} onValueChange={(v) => setJanela(v as Janela)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rolling_7d">{JANELA_LABEL.rolling_7d}</SelectItem>
            <SelectItem value="mom">{JANELA_LABEL.mom}</SelectItem>
          </SelectContent>
        </Select>
        {empresas.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {empresas.map((e) => (
              <Badge
                key={e}
                variant="secondary"
                className="cursor-pointer"
                onClick={() => setEmpresas(empresas.filter((x) => x !== e))}
              >
                {e} ✕
              </Badge>
            ))}
          </div>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="categoria">Categoria</TabsTrigger>
          <TabsTrigger value="marca">Marca</TabsTrigger>
          <TabsTrigger value="produto">Produto</TabsTrigger>
        </TabsList>
        <TabsContent value="categoria" className="mt-4">
          <SectionContent rows={catAgg} isLoading={cat.isLoading} />
          {cat.error && (
            <p className="text-sm text-destructive mt-2">{(cat.error as Error).message}</p>
          )}
        </TabsContent>
        <TabsContent value="marca" className="mt-4">
          <SectionContent rows={marAgg} isLoading={mar.isLoading} />
          {mar.error && (
            <p className="text-sm text-destructive mt-2">{(mar.error as Error).message}</p>
          )}
        </TabsContent>
        <TabsContent value="produto" className="mt-4">
          <SectionContent rows={proAgg} showSubtitle isLoading={pro.isLoading} />
          {pro.error && (
            <p className="text-sm text-destructive mt-2">{(pro.error as Error).message}</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
