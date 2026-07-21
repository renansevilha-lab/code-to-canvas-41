import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ImageOff,
  Info,
  Loader2,
  Search,
  TrendingUp,
  X,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────

type Classificacao = "excelente" | "bom" | "ok" | "ruim" | "sem_dado";
const CLASSIF_ALL: Classificacao[] = ["excelente", "bom", "ok", "ruim", "sem_dado"];

const CLASSIF_META: Record<Classificacao, { label: string; emoji: string; badge: string; dot: string }> = {
  excelente: { label: "Excelente", emoji: "🟢", badge: "bg-emerald-100 text-emerald-800 border-emerald-200", dot: "bg-emerald-500" },
  bom:       { label: "Bom",       emoji: "🔵", badge: "bg-blue-100 text-blue-800 border-blue-200",           dot: "bg-blue-500" },
  ok:        { label: "OK",        emoji: "🟡", badge: "bg-amber-100 text-amber-800 border-amber-200",        dot: "bg-amber-500" },
  ruim:      { label: "Ruim",      emoji: "🔴", badge: "bg-red-100 text-red-800 border-red-200",              dot: "bg-red-500" },
  sem_dado:  { label: "Sem dado",  emoji: "⚪", badge: "bg-slate-100 text-slate-700 border-slate-200",        dot: "bg-slate-400" },
};

type SortKey =
  | "investimento" | "vendas" | "roas" | "ctr" | "acos" | "cpc"
  | "orcamento_diario" | "impressoes" | "cliques";

const SORTABLE: SortKey[] = ["investimento", "vendas", "roas", "ctr", "acos", "cpc", "orcamento_diario", "impressoes", "cliques"];

interface AnuncioRow {
  campaign_id: number | string;
  shop_id: number | string | null;
  empresa: string | null;
  anuncio: string | null;
  tipo_anuncio: string | null;
  status: string | null;
  posicionamento: string | null;
  orcamento_diario: number | null;
  item_id: number | string | null;
  foto: string | null;
  sku_pai: string | null;
  investimento: number | null;
  vendas: number | null;
  impressoes: number | null;
  cliques: number | null;
  pedidos: number | null;
  roas: number | null;
  acos: number | null;
  ctr: number | null;
  cpc: number | null;
  classificacao_roas: Classificacao | string | null;
  teve_gasto: boolean | null;
}

interface ResumoRow {
  empresa: string | null;
  classificacao_roas: Classificacao | string | null;
  anuncios: number | null;
  investimento: number | null;
  vendas: number | null;
  roas_medio: number | null;
  acos_medio: number | null;
}

interface ConfigFaixas {
  roas_excelente: number;
  roas_bom: number;
  roas_ok: number;
  acos_alvo: number;
}

interface DailyRow {
  empresa: string | null;
  data: string;
  gasto: number | null;
  gmv_direto: number | null;
}

const PAGE_SIZE = 50;

// ─── Search params ────────────────────────────────────────────────────────

type SearchParams = {
  classif: Classificacao[];
  inv_min?: number;
  inv_max?: number;
  roas_min?: number;
  roas_max?: number;
  acos_min?: number;
  acos_max?: number;
  empresa: string; // "all" or name
  status: "all" | "ongoing" | "paused" | "closed";
  tem_gasto: boolean;
  q: string;
  sort: SortKey;
  dir: "asc" | "desc";
  pagina: number;
  periodo: "ontem" | "7d" | "14d" | "30d";
};

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function parseClassif(v: unknown): Classificacao[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : [];
  return arr.filter((x): x is Classificacao => (CLASSIF_ALL as string[]).includes(x as string));
}

export const Route = createFileRoute("/ads-shopee")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    classif: parseClassif(s.classif),
    inv_min: optNum(s.inv_min),
    inv_max: optNum(s.inv_max),
    roas_min: optNum(s.roas_min),
    roas_max: optNum(s.roas_max),
    acos_min: optNum(s.acos_min),
    acos_max: optNum(s.acos_max),
    empresa: typeof s.empresa === "string" && s.empresa ? s.empresa : "all",
    status: ["all", "ongoing", "paused", "closed"].includes(s.status as string)
      ? (s.status as SearchParams["status"])
      : "all",
    tem_gasto: s.tem_gasto === undefined ? true : s.tem_gasto === true || s.tem_gasto === "true",
    q: typeof s.q === "string" ? s.q : "",
    sort: SORTABLE.includes(s.sort as SortKey) ? (s.sort as SortKey) : "investimento",
    dir: s.dir === "asc" ? "asc" : "desc",
    pagina: Math.max(1, Math.floor(Number(s.pagina) || 1)),
    periodo: (["ontem", "7d", "14d", "30d"] as const).includes(s.periodo as never)
      ? (s.periodo as SearchParams["periodo"])
      : "7d",
  }),
  component: AdsShopeePage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-red-600">Erro ao carregar ADS: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Não encontrado</div>,
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function ontemKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function daysAgoKey(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function computePeriodo(p: SearchParams["periodo"]): { de: string; ate: string } {
  const ate = ontemKey();
  const map = { ontem: ate, "7d": daysAgoKey(7), "14d": daysAgoKey(14), "30d": daysAgoKey(30) } as const;
  return { de: map[p], ate };
}
function fmtDate(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}
function fmtRoas(v: number) {
  return `${v.toFixed(2).replace(".", ",")}x`;
}

// ─── Small UI bits ────────────────────────────────────────────────────────

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-12 h-12 rounded bg-muted flex items-center justify-center shrink-0">
        <ImageOff className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-12 h-12 rounded object-cover shrink-0 border"
    />
  );
}

function LojaBadge({ empresa }: { empresa: string | null }) {
  if (!empresa) return <span className="text-muted-foreground">—</span>;
  const isOttz = /ottz/i.test(empresa);
  const isSvl = /svl/i.test(empresa);
  const cls = isOttz
    ? "bg-orange-100 text-orange-800 border-orange-200"
    : isSvl
      ? "bg-purple-100 text-purple-800 border-purple-200"
      : "bg-slate-100 text-slate-800 border-slate-200";
  return <Badge variant="outline" className={cls}>{empresa}</Badge>;
}

function ClassifBadge({ c }: { c: Classificacao | string | null }) {
  const key = (c ?? "sem_dado") as Classificacao;
  const meta = CLASSIF_META[key] ?? CLASSIF_META.sem_dado;
  return <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", meta.badge)}>{meta.label}</Badge>;
}

function StatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "ongoing") return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">Em andamento</Badge>;
  if (s === "paused") return <Badge className="bg-amber-500 text-white hover:bg-amber-500">Pausado</Badge>;
  if (s === "closed") return <Badge variant="secondary" className="text-muted-foreground">Encerrado</Badge>;
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

function SortableHead({
  label, keyId, sort, dir, onSort, align = "right",
}: {
  label: string; keyId: SortKey; sort: SortKey; dir: "asc" | "desc";
  onSort: (k: SortKey) => void; align?: "right" | "center" | "left";
}) {
  const active = sort === keyId;
  const Icon = !active ? ArrowUpDown : dir === "desc" ? ArrowDown : ArrowUp;
  return (
    <TableHead className={align === "right" ? "text-right" : align === "center" ? "text-center" : ""}>
      <button
        type="button"
        onClick={() => onSort(keyId)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
          active ? "text-foreground font-semibold" : "text-muted-foreground",
        )}
      >
        {label} <Icon className="h-3 w-3" />
      </button>
    </TableHead>
  );
}

// ─── Data hooks (server-side filters/order/pagination) ────────────────────

function useAnuncios(sp: SearchParams) {
  const [rows, setRows] = useState<AnuncioRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let q = supabaseExternal
        .from("view_ads_anuncios")
        .select("*", { count: "exact" })
        .order(sp.sort, { ascending: sp.dir === "asc", nullsFirst: false });

      if (sp.classif.length && sp.classif.length < CLASSIF_ALL.length) {
        q = q.in("classificacao_roas", sp.classif);
      }
      if (sp.inv_min !== undefined) q = q.gte("investimento", sp.inv_min);
      if (sp.inv_max !== undefined) q = q.lte("investimento", sp.inv_max);
      if (sp.roas_min !== undefined) q = q.gte("roas", sp.roas_min);
      if (sp.roas_max !== undefined) q = q.lte("roas", sp.roas_max);
      if (sp.acos_min !== undefined) q = q.gte("acos", sp.acos_min);
      if (sp.acos_max !== undefined) q = q.lte("acos", sp.acos_max);
      if (sp.empresa !== "all") q = q.eq("empresa", sp.empresa);
      if (sp.status !== "all") q = q.eq("status", sp.status);
      if (sp.tem_gasto) q = q.is("teve_gasto", true);
      if (sp.q.trim()) {
        const term = sp.q.trim().replace(/[%,]/g, " ");
        q = q.or(`anuncio.ilike.%${term}%,sku_pai.ilike.%${term}%`);
      }

      const from = (sp.pagina - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, error, count } = await q.range(from, to);

      if (cancelled) return;
      if (error) setError(error.message);
      else {
        setRows((data ?? []) as AnuncioRow[]);
        setTotal(count ?? 0);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [sp]);

  return { rows, total, loading, error };
}

function useResumo(empresa: string) {
  const [rows, setRows] = useState<ResumoRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabaseExternal.from("view_ads_resumo").select("*");
      if (empresa !== "all") q = q.eq("empresa", empresa);
      const { data } = await q;
      if (!cancelled) setRows((data ?? []) as ResumoRow[]);
    })();
    return () => { cancelled = true; };
  }, [empresa]);
  return rows;
}

function useFaixas() {
  const [cfg, setCfg] = useState<ConfigFaixas | null>(null);
  useEffect(() => {
    (async () => {
      const { data } = await supabaseExternal
        .from("config_roas_faixas")
        .select("roas_excelente,roas_bom,roas_ok,acos_alvo")
        .eq("id", 1)
        .maybeSingle();
      if (data) setCfg(data as ConfigFaixas);
    })();
  }, []);
  return cfg;
}

function useEmpresas() {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    (async () => {
      const { data } = await supabaseExternal
        .from("view_ads_resumo")
        .select("empresa");
      const s = new Set<string>();
      for (const r of (data ?? []) as { empresa: string | null }[]) {
        if (r.empresa) s.add(r.empresa);
      }
      setList(Array.from(s).sort());
    })();
  }, []);
  return list;
}

function useDaily(empresa: string, periodo: SearchParams["periodo"]) {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { de, ate } = computePeriodo(periodo);
      let q = supabaseExternal
        .from("shopee_ads_diario")
        .select("empresa,data,gasto,gmv_direto")
        .gte("data", de).lte("data", ate)
        .order("data", { ascending: true });
      if (empresa !== "all") q = q.eq("empresa", empresa);
      const { data } = await q;
      if (!cancelled) { setRows((data ?? []) as DailyRow[]); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [empresa, periodo]);
  return { rows, loading };
}

// ─── Page ─────────────────────────────────────────────────────────────────

function AdsShopeePage() {
  const sp = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const update = (patch: Partial<SearchParams>, resetPage = true) => {
    navigate({
      search: (prev: SearchParams) => ({
        ...prev,
        ...patch,
        ...(resetPage && "pagina" in patch === false ? { pagina: 1 } : {}),
      }),
      replace: true,
    });
  };

  const empresas = useEmpresas();
  const resumo = useResumo(sp.empresa);
  const faixas = useFaixas();
  const acosAlvo = faixas?.acos_alvo ?? 20;
  const { rows: daily, loading: loadingDaily } = useDaily(sp.empresa, sp.periodo);
  const { rows: anuncios, total, loading: loadingAds, error: errAds } = useAnuncios(sp);

  // Contadores por classificação (totais dentro do escopo empresa)
  const countsByClassif = useMemo(() => {
    const m: Record<Classificacao, number> = { excelente: 0, bom: 0, ok: 0, ruim: 0, sem_dado: 0 };
    for (const r of resumo) {
      const k = (r.classificacao_roas ?? "sem_dado") as Classificacao;
      if (k in m) m[k] += num(r.anuncios);
    }
    return m;
  }, [resumo]);

  // KPIs globais (somando resumo)
  const totais = useMemo(() => {
    let inv = 0, vendas = 0, anunciosCount = 0;
    for (const r of resumo) {
      inv += num(r.investimento);
      vendas += num(r.vendas);
      anunciosCount += num(r.anuncios);
    }
    return {
      inv, vendas, anuncios: anunciosCount,
      roas: inv > 0 ? vendas / inv : 0,
      acos: vendas > 0 ? (inv / vendas) * 100 : 0,
    };
  }, [resumo]);

  const serie = useMemo(() => {
    const map = new Map<string, { inv: number; vendas: number }>();
    for (const r of daily) {
      const cur = map.get(r.data) ?? { inv: 0, vendas: 0 };
      cur.inv += num(r.gasto); cur.vendas += num(r.gmv_direto);
      map.set(r.data, cur);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([data, v]) => ({
        data: fmtDate(data),
        investimento: v.inv, vendas: v.vendas,
        roas: v.inv > 0 ? v.vendas / v.inv : 0,
      }));
  }, [daily]);

  // Alerta ACOS alto (usa acos_alvo)
  const altoAcos = useMemo(
    () => anuncios.filter((a) => num(a.acos) > acosAlvo && num(a.investimento) > 0).length,
    [anuncios, acosAlvo],
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleClassif = (c: Classificacao) => {
    const set = new Set<Classificacao>(sp.classif);
    if (set.has(c)) set.delete(c); else set.add(c);
    update({ classif: Array.from(set) as Classificacao[] });
  };

  const onSort = (k: SortKey) => {
    if (sp.sort === k) update({ dir: sp.dir === "desc" ? "asc" : "desc" }, false);
    else update({ sort: k, dir: "desc" }, false);
  };

  // Chips de filtros ativos
  const chips: { label: string; onRemove: () => void }[] = [];
  if (sp.classif.length && sp.classif.length < CLASSIF_ALL.length) {
    chips.push({
      label: `Classificação: ${sp.classif.map((c) => CLASSIF_META[c].label).join(", ")}`,
      onRemove: () => update({ classif: [] }),
    });
  }
  if (sp.inv_min !== undefined || sp.inv_max !== undefined) {
    chips.push({
      label: `Investimento ${sp.inv_min ?? "0"}–${sp.inv_max ?? "∞"}`,
      onRemove: () => update({ inv_min: undefined, inv_max: undefined }),
    });
  }
  if (sp.roas_min !== undefined || sp.roas_max !== undefined) {
    chips.push({
      label: `ROAS ${sp.roas_min ?? "0"}–${sp.roas_max ?? "∞"}`,
      onRemove: () => update({ roas_min: undefined, roas_max: undefined }),
    });
  }
  if (sp.acos_min !== undefined || sp.acos_max !== undefined) {
    chips.push({
      label: `ACOS ${sp.acos_min ?? "0"}–${sp.acos_max ?? "∞"}%`,
      onRemove: () => update({ acos_min: undefined, acos_max: undefined }),
    });
  }
  if (sp.empresa !== "all") chips.push({ label: `Loja: ${sp.empresa}`, onRemove: () => update({ empresa: "all" }) });
  if (sp.status !== "all") chips.push({
    label: `Status: ${sp.status === "ongoing" ? "Em andamento" : sp.status === "paused" ? "Pausado" : "Encerrado"}`,
    onRemove: () => update({ status: "all" }),
  });
  if (!sp.tem_gasto) chips.push({ label: "Incluindo sem gasto", onRemove: () => update({ tem_gasto: true }) });
  if (sp.q.trim()) chips.push({ label: `Busca: "${sp.q}"`, onRemove: () => update({ q: "" }) });

  const limparTudo = () => update({
    classif: [], inv_min: undefined, inv_max: undefined,
    roas_min: undefined, roas_max: undefined, acos_min: undefined, acos_max: undefined,
    empresa: "all", status: "all", tem_gasto: true, q: "",
  });

  return (
    <TooltipProvider>
      <div className="p-4 md:p-6 space-y-4">
        {/* Cabeçalho */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <TrendingUp className="h-6 w-6" /> ADS Shopee
            </h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
              <Info className="h-3.5 w-3.5" />
              Últimos 30 dias por anúncio · classificação, ROAS e ACOS vêm do banco.
            </p>
          </div>
        </div>

        {/* Resumo por classificação — clicável */}
        <Card className="p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Anúncios</span>
            {CLASSIF_ALL.map((c) => {
              const meta = CLASSIF_META[c];
              const active = sp.classif.includes(c);
              const n = countsByClassif[c];
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggleClassif(c)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition",
                    active ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted",
                  )}
                >
                  <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                  {meta.label} <span className="font-semibold">{formatNumber(n)}</span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="Anúncios" value={formatNumber(totais.anuncios)} />
          <Kpi label="Investimento" value={formatBRL(totais.inv)} />
          <Kpi label="Vendas" value={formatBRL(totais.vendas)} />
          <Kpi
            label="ROAS"
            value={totais.roas > 0 ? fmtRoas(totais.roas) : "—"}
            highlight={faixas ? totais.roas >= faixas.roas_bom : totais.roas >= 5}
          />
          <Kpi
            label="ACOS"
            value={totais.acos > 0 ? formatPercent(totais.acos) : "—"}
            highlight={totais.acos > 0 && totais.acos <= acosAlvo}
          />
        </div>

        {/* Filtros principais */}
        <Card className="p-3 md:p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Loja</span>
            <Button size="sm" variant={sp.empresa === "all" ? "default" : "outline"} onClick={() => update({ empresa: "all" })}>
              Todas
            </Button>
            {empresas.map((e) => (
              <Button key={e} size="sm" variant={sp.empresa === e ? "default" : "outline"} onClick={() => update({ empresa: e })}>
                {e}
              </Button>
            ))}
            <div className="w-px h-6 bg-border mx-1" />
            <span className="text-xs uppercase tracking-wider text-muted-foreground">Período (gráfico)</span>
            {(["ontem", "7d", "14d", "30d"] as const).map((p) => (
              <Button key={p} size="sm" variant={sp.periodo === p ? "default" : "outline"} onClick={() => update({ periodo: p }, false)}>
                {p === "ontem" ? "Ontem" : p}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">Status</span>
            {([
              ["all", "Todos"], ["ongoing", "Em andamento"], ["paused", "Pausado"], ["closed", "Encerrado"],
            ] as [SearchParams["status"], string][]).map(([k, label]) => (
              <Button key={k} size="sm" variant={sp.status === k ? "default" : "outline"} onClick={() => update({ status: k })}>
                {label}
              </Button>
            ))}
            <div className="flex items-center gap-2 ml-2">
              <Switch id="so-gasto" checked={sp.tem_gasto} onCheckedChange={(v) => update({ tem_gasto: v })} />
              <Label htmlFor="so-gasto" className="text-xs">Só com gasto</Label>
            </div>
            <div className="relative flex-1 min-w-[220px] ml-auto">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar anúncio ou SKU…"
                defaultValue={sp.q}
                onBlur={(e) => e.target.value !== sp.q && update({ q: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") update({ q: (e.target as HTMLInputElement).value }); }}
                className="pl-8 h-8"
              />
            </div>
          </div>

          {/* Ranges numéricos */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <RangeInput
              label="Investimento (R$)"
              min={sp.inv_min} max={sp.inv_max}
              onChange={(mn, mx) => update({ inv_min: mn, inv_max: mx })}
            />
            <RangeInput
              label="ROAS (x)"
              min={sp.roas_min} max={sp.roas_max} step={0.1}
              onChange={(mn, mx) => update({ roas_min: mn, roas_max: mx })}
            />
            <RangeInput
              label="ACOS (%)"
              min={sp.acos_min} max={sp.acos_max} step={0.1}
              onChange={(mn, mx) => update({ acos_min: mn, acos_max: mx })}
            />
          </div>

          {/* Chips filtros ativos */}
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t">
              <span className="text-xs text-muted-foreground mr-1">Filtros ativos:</span>
              {chips.map((c, i) => (
                <button
                  key={i}
                  onClick={c.onRemove}
                  className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] hover:bg-muted-foreground/10"
                >
                  {c.label} <X className="h-3 w-3" />
                </button>
              ))}
              <Button size="sm" variant="ghost" className="h-6 text-xs ml-1" onClick={limparTudo}>
                Limpar filtros
              </Button>
            </div>
          )}
        </Card>

        {errAds && (
          <div className="p-3 border border-red-200 bg-red-50 text-red-800 rounded text-sm">{errAds}</div>
        )}

        {/* Gráfico */}
        <Card className="p-4">
          <div className="text-sm font-medium mb-2">Investimento e ROAS por dia</div>
          <div className="w-full h-[280px]">
            {loadingDaily ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Carregando…
              </div>
            ) : serie.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                Sem dados no período.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={serie}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="data" tick={{ fontSize: 12 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 12 }} tickFormatter={(v) => formatBRL(v, { compact: true })} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} tickFormatter={(v) => `${Number(v).toFixed(1).replace(".", ",")}x`} />
                  <RTooltip
                    formatter={(value, name) => {
                      const v = Number(value) || 0;
                      if (name === "ROAS") return [fmtRoas(v), name];
                      return [formatBRL(v), name];
                    }}
                  />
                  <Legend />
                  <Bar yAxisId="left" dataKey="investimento" name="Investimento" fill="hsl(var(--primary))" />
                  <Line yAxisId="right" type="monotone" dataKey="roas" name="ROAS" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Alerta ACOS alto usa acos_alvo */}
        {altoAcos > 0 && (
          <div className="p-3 border border-amber-200 bg-amber-50 text-amber-900 rounded text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {altoAcos} {altoAcos === 1 ? "anúncio" : "anúncios"} com ACOS acima de {formatPercent(acosAlvo)} (nesta página).
          </div>
        )}

        {/* Lista */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Foto</TableHead>
                  <TableHead>Anúncio</TableHead>
                  <TableHead>Loja</TableHead>
                  <SortableHead label="Orç. diário" keyId="orcamento_diario" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="Impr." keyId="impressoes" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="Cliques" keyId="cliques" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="CTR" keyId="ctr" sort={sp.sort} dir={sp.dir} onSort={onSort} align="center" />
                  <SortableHead label="CPC" keyId="cpc" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="Investimento" keyId="investimento" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="Vendas" keyId="vendas" sort={sp.sort} dir={sp.dir} onSort={onSort} />
                  <SortableHead label="ROAS" keyId="roas" sort={sp.sort} dir={sp.dir} onSort={onSort} align="center" />
                  <SortableHead label="ACOS" keyId="acos" sort={sp.sort} dir={sp.dir} onSort={onSort} align="center" />
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingAds && (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center py-8">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" /> Carregando…
                    </TableCell>
                  </TableRow>
                )}
                {!loadingAds && anuncios.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={13} className="text-center py-8 text-muted-foreground">
                      Nenhum anúncio no filtro atual.
                    </TableCell>
                  </TableRow>
                )}
                {!loadingAds && anuncios.map((a) => {
                  const roasVal = num(a.roas);
                  const acosVal = num(a.acos);
                  const semRetorno = num(a.investimento) > 0 && num(a.vendas) === 0;
                  const acosAlto = acosVal > acosAlvo && num(a.investimento) > 0;
                  const rowCls = semRetorno ? "bg-red-50/60" : acosAlto ? "bg-amber-50/40" : "";
                  return (
                    <TableRow key={String(a.campaign_id)} className={rowCls}>
                      <TableCell><Thumb src={a.foto} alt={a.anuncio ?? ""} /></TableCell>
                      <TableCell className="max-w-[280px]">
                        <div className="font-medium text-sm truncate" title={a.anuncio ?? ""}>{a.anuncio}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {a.sku_pai && <span className="font-mono mr-2">{a.sku_pai}</span>}
                          {a.tipo_anuncio && <span className="capitalize">{a.tipo_anuncio}</span>}
                        </div>
                      </TableCell>
                      <TableCell><LojaBadge empresa={a.empresa} /></TableCell>
                      <TableCell className="text-right text-sm">
                        {num(a.orcamento_diario) > 0 ? formatBRL(num(a.orcamento_diario)) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatNumber(num(a.impressoes))}</TableCell>
                      <TableCell className="text-right text-xs">{formatNumber(num(a.cliques))}</TableCell>
                      <TableCell className="text-center text-xs">{num(a.ctr) > 0 ? formatPercent(num(a.ctr)) : "—"}</TableCell>
                      <TableCell className="text-right text-xs">{num(a.cpc) > 0 ? formatBRL(num(a.cpc)) : "—"}</TableCell>
                      <TableCell className="text-right text-sm font-medium">{formatBRL(num(a.investimento))}</TableCell>
                      <TableCell className="text-right text-sm">{formatBRL(num(a.vendas))}</TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {roasVal > 0 && <span className="text-xs font-medium tabular-nums">{fmtRoas(roasVal)}</span>}
                          <ClassifBadge c={a.classificacao_roas} />
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-xs">
                        {num(a.investimento) > 0 && num(a.vendas) > 0 ? (
                          <span className={cn(acosAlto && "text-red-700 font-medium")}>{formatPercent(acosVal)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell><StatusBadge status={a.status} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20 text-sm">
              <span className="text-muted-foreground">
                Página {sp.pagina} de {totalPages} · {formatNumber(total)} anúncios
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={sp.pagina <= 1}
                  onClick={() => update({ pagina: sp.pagina - 1 }, false)}>Anterior</Button>
                <Button size="sm" variant="outline" disabled={sp.pagina >= totalPages}
                  onClick={() => update({ pagina: sp.pagina + 1 }, false)}>Próxima</Button>
              </div>
            </div>
          )}
        </Card>

        <Tooltip>
          <TooltipTrigger asChild>
            <p className="text-xs text-muted-foreground">
              Faixas: excelente ≥ {faixas?.roas_excelente ?? "—"}x · bom ≥ {faixas?.roas_bom ?? "—"}x · ok ≥ {faixas?.roas_ok ?? "—"}x · teto ACOS {formatPercent(acosAlvo)} — configurável em Metas.
            </p>
          </TooltipTrigger>
          <TooltipContent>Definido em Metas → Metas de ADS</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function RangeInput({
  label, min, max, step = 1, onChange,
}: {
  label: string; min: number | undefined; max: number | undefined;
  step?: number; onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const [mn, setMn] = useState(min?.toString() ?? "");
  const [mx, setMx] = useState(max?.toString() ?? "");
  useEffect(() => { setMn(min?.toString() ?? ""); setMx(max?.toString() ?? ""); }, [min, max]);

  const commit = () => {
    const parse = (v: string) => {
      if (!v.trim()) return undefined;
      const n = Number(v.replace(",", "."));
      return Number.isFinite(n) ? n : undefined;
    };
    onChange(parse(mn), parse(mx));
  };

  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1 mt-1">
        <Input type="number" step={step} placeholder="Min" value={mn}
          onChange={(e) => setMn(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          className="h-8" />
        <span className="text-muted-foreground text-xs">–</span>
        <Input type="number" step={step} placeholder="Max" value={mx}
          onChange={(e) => setMx(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
          className="h-8" />
      </div>
    </div>
  );
}

function Kpi({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-1 ${highlight ? "text-emerald-600" : ""}`}>{value}</div>
    </Card>
  );
}
