import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ImageOff,
  Info,
  Loader2,
  Search,
  TrendingUp,
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

export const Route = createFileRoute("/ads-shopee")({
  component: AdsShopeePage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-red-600">
      Erro ao carregar ADS: {error.message}
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Não encontrado</div>,
});

// ─── Types ────────────────────────────────────────────────────────────────

interface DailyRow {
  shop_id: number | string | null;
  empresa: string | null;
  data: string;
  impressoes: number | null;
  cliques: number | null;
  gasto: number | null;
  gmv_direto: number | null;
  pedidos_diretos: number | null;
  itens_vendidos_direto: number | null;
}

interface AnuncioRow {
  shop_id: number | string | null;
  empresa: string | null;
  data: string;
  campaign_id: string | number | null;
  item_id: string | number | null;
  anuncio: string | null;
  ad_name: string | null;
  foto: string | null;
  skus: string | null;
  status: string | null;
  placement: string | null;
  orcamento_diario: number | null;
  impressoes: number | null;
  cliques: number | null;
  investimento: number | null;
  vendas_direto: number | null;
  pedidos_direto: number | null;
}

type PresetKey = "ontem" | "7d" | "14d" | "30d" | "custom";

// ─── Helpers ──────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

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

function computePreset(preset: PresetKey): { de: string; ate: string } {
  const ate = ontemKey();
  switch (preset) {
    case "ontem":
      return { de: ate, ate };
    case "7d":
      return { de: daysAgoKey(7), ate };
    case "14d":
      return { de: daysAgoKey(14), ate };
    case "30d":
      return { de: daysAgoKey(30), ate };
    default:
      return { de: daysAgoKey(7), ate };
  }
}

function formatDate(iso: string): string {
  try {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}`;
  } catch {
    return iso;
  }
}

// ─── Data hooks ───────────────────────────────────────────────────────────

function useDaily(de: string, ate: string, shopId: string) {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let q = supabaseExternal
        .from("shopee_ads_diario")
        .select(
          "shop_id,empresa,data,impressoes,cliques,gasto,gmv_direto,pedidos_diretos,itens_vendidos_direto",
        )
        .gte("data", de)
        .lte("data", ate)
        .order("data", { ascending: true });
      if (shopId !== "all") q = q.eq("shop_id", shopId);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) setError(error.message);
      else setRows((data ?? []) as DailyRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [de, ate, shopId]);

  return { rows, loading, error };
}

function useAnuncios(de: string, ate: string, shopId: string) {
  const [rows, setRows] = useState<AnuncioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      let q = supabaseExternal
        .from("view_shopee_ads_anuncios")
        .select(
          "shop_id,empresa,data,campaign_id,item_id,anuncio,ad_name,foto,skus,status,placement,orcamento_diario,impressoes,cliques,investimento,vendas_direto,pedidos_direto",
        )
        .gte("data", de)
        .lte("data", ate);
      if (shopId !== "all") q = q.eq("shop_id", shopId);
      const { data, error } = await q.limit(20000);
      if (cancelled) return;
      if (error) setError(error.message);
      else setRows((data ?? []) as AnuncioRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [de, ate, shopId]);

  return { rows, loading, error };
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
  return (
    <Badge variant="outline" className={cls}>
      {empresa}
    </Badge>
  );
}

function RoasBadge({ roas }: { roas: number }) {
  if (!Number.isFinite(roas) || roas === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const cls =
    roas >= 10
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : roas >= 5
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : "bg-red-100 text-red-800 border-red-200";
  return (
    <Badge variant="outline" className={cls}>
      {roas.toFixed(2).replace(".", ",")}x
    </Badge>
  );
}

function AcosBadge({ acos }: { acos: number }) {
  if (!Number.isFinite(acos) || acos === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const cls =
    acos < 10
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : acos <= 20
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : "bg-red-100 text-red-800 border-red-200";
  return (
    <Badge variant="outline" className={cls}>
      {formatPercent(acos)}
    </Badge>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (s === "ongoing")
    return (
      <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
        Em andamento
      </Badge>
    );
  if (s === "paused")
    return (
      <Badge className="bg-amber-500 text-white hover:bg-amber-500">
        Pausado
      </Badge>
    );
  if (s === "closed")
    return (
      <Badge variant="secondary" className="text-muted-foreground">
        Encerrado
      </Badge>
    );
  return <Badge variant="outline">{status ?? "—"}</Badge>;
}

function SkuChips({ skus }: { skus: string | null }) {
  if (!skus) return <span className="text-muted-foreground text-xs">—</span>;
  const lista = skus
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const shown = lista.slice(0, 3);
  const rest = lista.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1 max-w-[220px]">
      {shown.map((s) => (
        <span
          key={s}
          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted"
        >
          {s}
        </span>
      ))}
      {rest > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          +{rest}
        </span>
      )}
    </div>
  );
}

// ─── Aggregations ─────────────────────────────────────────────────────────

interface CardMetrics {
  impressoes: number;
  cliques: number;
  ctr: number;
  pedidos: number;
  itens: number;
  vendas: number;
  investimento: number;
  roas: number;
}

function aggDaily(rows: DailyRow[]): CardMetrics {
  let imp = 0,
    cli = 0,
    ped = 0,
    itens = 0,
    vendas = 0,
    gasto = 0;
  for (const r of rows) {
    imp += num(r.impressoes);
    cli += num(r.cliques);
    ped += num(r.pedidos_diretos);
    itens += num(r.itens_vendidos_direto);
    vendas += num(r.gmv_direto);
    gasto += num(r.gasto);
  }
  return {
    impressoes: imp,
    cliques: cli,
    ctr: imp > 0 ? (cli / imp) * 100 : 0,
    pedidos: ped,
    itens,
    vendas,
    investimento: gasto,
    roas: gasto > 0 ? vendas / gasto : 0,
  };
}

interface SerieDia {
  data: string;
  investimento: number;
  vendas: number;
  roas: number;
}

function serieDiaria(rows: DailyRow[]): SerieDia[] {
  const map = new Map<string, { inv: number; vendas: number }>();
  for (const r of rows) {
    const cur = map.get(r.data) ?? { inv: 0, vendas: 0 };
    cur.inv += num(r.gasto);
    cur.vendas += num(r.gmv_direto);
    map.set(r.data, cur);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, v]) => ({
      data: formatDate(data),
      investimento: v.inv,
      vendas: v.vendas,
      roas: v.inv > 0 ? v.vendas / v.inv : 0,
    }));
}

interface AnuncioAgg {
  campaign_id: string;
  anuncio: string;
  ad_name: string;
  foto: string | null;
  skus: string | null;
  empresa: string | null;
  status: string | null;
  orcamento_diario: number;
  impressoes: number;
  cliques: number;
  investimento: number;
  vendas: number;
  pedidos: number;
  ctr: number;
  roas: number;
  acos: number;
}

function aggAnuncios(rows: AnuncioRow[]): AnuncioAgg[] {
  const map = new Map<string, AnuncioAgg>();
  for (const r of rows) {
    const key = String(r.campaign_id ?? r.item_id ?? r.anuncio ?? "?");
    let cur = map.get(key);
    if (!cur) {
      cur = {
        campaign_id: key,
        anuncio: r.anuncio ?? "—",
        ad_name: r.ad_name ?? "",
        foto: r.foto,
        skus: r.skus,
        empresa: r.empresa,
        status: r.status,
        orcamento_diario: num(r.orcamento_diario),
        impressoes: 0,
        cliques: 0,
        investimento: 0,
        vendas: 0,
        pedidos: 0,
        ctr: 0,
        roas: 0,
        acos: 0,
      };
      map.set(key, cur);
    }
    cur.impressoes += num(r.impressoes);
    cur.cliques += num(r.cliques);
    cur.investimento += num(r.investimento);
    cur.vendas += num(r.vendas_direto);
    cur.pedidos += num(r.pedidos_direto);
    // manter último orçamento/status/foto observado (mais recente)
    if (r.orcamento_diario != null)
      cur.orcamento_diario = num(r.orcamento_diario);
    if (r.status) cur.status = r.status;
    if (r.foto) cur.foto = r.foto;
    if (r.skus) cur.skus = r.skus;
  }
  for (const a of map.values()) {
    a.ctr = a.impressoes > 0 ? (a.cliques / a.impressoes) * 100 : 0;
    a.roas = a.investimento > 0 ? a.vendas / a.investimento : 0;
    a.acos = a.vendas > 0 ? (a.investimento / a.vendas) * 100 : 0;
  }
  return Array.from(map.values()).sort(
    (a, b) => b.investimento - a.investimento,
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

function AdsShopeePage() {
  const [preset, setPreset] = useState<PresetKey>("7d");
  const init = computePreset("7d");
  const [de, setDe] = useState(init.de);
  const [ate, setAte] = useState(init.ate);
  const [shopId, setShopId] = useState<string>("all");

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [busca, setBusca] = useState("");
  const [soComGasto, setSoComGasto] = useState(true);

  function applyPreset(p: PresetKey) {
    setPreset(p);
    if (p !== "custom") {
      const r = computePreset(p);
      setDe(r.de);
      setAte(r.ate);
    }
  }

  const { rows: daily, loading: loadingDaily, error: errDaily } = useDaily(
    de,
    ate,
    shopId,
  );
  const { rows: anuncios, loading: loadingAds, error: errAds } = useAnuncios(
    de,
    ate,
    shopId,
  );

  // lojas disponíveis (a partir do daily p/ não fazer query extra)
  const lojas = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of daily) {
      if (r.shop_id != null && r.empresa) {
        m.set(String(r.shop_id), r.empresa);
      }
    }
    for (const r of anuncios) {
      if (r.shop_id != null && r.empresa) {
        m.set(String(r.shop_id), r.empresa);
      }
    }
    return Array.from(m.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [daily, anuncios]);

  const cards = useMemo(() => aggDaily(daily), [daily]);
  const serie = useMemo(() => serieDiaria(daily), [daily]);
  const anunciosAgg = useMemo(() => aggAnuncios(anuncios), [anuncios]);

  const anunciosFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return anunciosAgg.filter((a) => {
      if (statusFilter !== "all" && (a.status ?? "").toLowerCase() !== statusFilter)
        return false;
      if (soComGasto && a.investimento <= 0) return false;
      if (q) {
        const hay =
          `${a.anuncio} ${a.ad_name} ${a.skus ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [anunciosAgg, statusFilter, busca, soComGasto]);

  const anunciosAltoAcos = anunciosFiltrados.filter(
    (a) => a.acos > 20 && a.investimento > 0,
  ).length;

  const loading = loadingDaily || loadingAds;
  const errorMsg = errDaily ?? errAds;

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
              Dados disponíveis até ontem (a Shopee não fornece o dia corrente).
            </p>
          </div>
        </div>

        {/* Filtros */}
        <Card className="p-3 md:p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">
              Loja
            </span>
            <Button
              size="sm"
              variant={shopId === "all" ? "default" : "outline"}
              onClick={() => setShopId("all")}
            >
              Todas
            </Button>
            {lojas.map(([id, nome]) => (
              <Button
                key={id}
                size="sm"
                variant={shopId === id ? "default" : "outline"}
                onClick={() => setShopId(id)}
              >
                {nome}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1">
              Período
            </span>
            {(
              [
                ["ontem", "Ontem"],
                ["7d", "7 dias"],
                ["14d", "14 dias"],
                ["30d", "30 dias"],
              ] as [PresetKey, string][]
            ).map(([k, label]) => (
              <Button
                key={k}
                size="sm"
                variant={preset === k ? "default" : "outline"}
                onClick={() => applyPreset(k)}
              >
                {label}
              </Button>
            ))}
            <div className="flex items-center gap-2 ml-2">
              <Label htmlFor="de" className="text-xs">
                De
              </Label>
              <Input
                id="de"
                type="date"
                value={de}
                max={ate}
                onChange={(e) => {
                  setPreset("custom");
                  setDe(e.target.value);
                }}
                className="h-8 w-[140px]"
              />
              <Label htmlFor="ate" className="text-xs">
                Até
              </Label>
              <Input
                id="ate"
                type="date"
                value={ate}
                max={ontemKey()}
                onChange={(e) => {
                  setPreset("custom");
                  setAte(e.target.value);
                }}
                className="h-8 w-[140px]"
              />
            </div>
          </div>
        </Card>

        {errorMsg && (
          <div className="p-3 border border-red-200 bg-red-50 text-red-800 rounded text-sm">
            {errorMsg}
          </div>
        )}

        {/* Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <Kpi label="Impressões" value={formatNumber(cards.impressoes)} />
          <Kpi label="Cliques" value={formatNumber(cards.cliques)} />
          <Kpi label="CTR" value={formatPercent(cards.ctr)} />
          <Kpi label="Pedidos" value={formatNumber(cards.pedidos)} />
          <Kpi label="Itens vendidos" value={formatNumber(cards.itens)} />
          <Kpi label="Vendas" value={formatBRL(cards.vendas)} />
          <Kpi label="Investimento" value={formatBRL(cards.investimento)} />
          <Kpi
            label="ROAS"
            value={
              cards.roas > 0 ? `${cards.roas.toFixed(2).replace(".", ",")}x` : "—"
            }
            highlight={cards.roas >= 5}
          />
        </div>

        {/* Gráfico */}
        <Card className="p-4">
          <div className="text-sm font-medium mb-2">
            Investimento e ROAS por dia
          </div>
          <div className="w-full h-[280px]">
            {loading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Carregando…
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
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => formatBRL(v, { compact: true })}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) =>
                      `${Number(v).toFixed(1).replace(".", ",")}x`
                    }
                  />
                  <RTooltip
                    formatter={(value, name) => {
                      const v = Number(value) || 0;
                      if (name === "ROAS")
                        return [`${v.toFixed(2).replace(".", ",")}x`, name];
                      return [formatBRL(v), name];
                    }}
                  />
                  <Legend />
                  <Bar
                    yAxisId="left"
                    dataKey="investimento"
                    name="Investimento"
                    fill="hsl(var(--primary))"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="roas"
                    name="ROAS"
                    stroke="#059669"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Alertas */}
        {anunciosAltoAcos > 0 && (
          <div className="p-3 border border-amber-200 bg-amber-50 text-amber-900 rounded text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {anunciosAltoAcos}{" "}
            {anunciosAltoAcos === 1
              ? "anúncio com ACOS acima de 20%"
              : "anúncios com ACOS acima de 20%"}
            .
          </div>
        )}

        {/* Filtros da lista */}
        <Card className="p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ["all", "Todos"],
                ["ongoing", "Em andamento"],
                ["paused", "Pausado"],
                ["closed", "Encerrado"],
              ] as [string, string][]
            ).map(([k, label]) => (
              <Button
                key={k}
                size="sm"
                variant={statusFilter === k ? "default" : "outline"}
                onClick={() => setStatusFilter(k)}
              >
                {label}
              </Button>
            ))}
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar anúncio, campanha ou SKU…"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                className="pl-8 h-8"
              />
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Switch
                id="so-gasto"
                checked={soComGasto}
                onCheckedChange={setSoComGasto}
              />
              <Label htmlFor="so-gasto" className="text-xs">
                Só com gasto
              </Label>
            </div>
          </div>
        </Card>

        {/* Lista */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Foto</TableHead>
                  <TableHead>Anúncio</TableHead>
                  <TableHead>SKUs</TableHead>
                  <TableHead>Loja</TableHead>
                  <TableHead className="text-right">Orç. diário</TableHead>
                  <TableHead className="text-right">Investimento</TableHead>
                  <TableHead className="text-right">Vendas</TableHead>
                  <TableHead className="text-center">ROAS</TableHead>
                  <TableHead className="text-center">CTR</TableHead>
                  <TableHead className="text-center">ACOS</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center py-8">
                      <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
                      Carregando…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && anunciosFiltrados.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={11}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Nenhum anúncio no filtro atual.
                    </TableCell>
                  </TableRow>
                )}
                {!loading &&
                  anunciosFiltrados.map((a) => {
                    const semRetorno = a.investimento > 0 && a.vendas === 0;
                    const acosAlto = a.acos > 20 && a.investimento > 0;
                    const rowCls = semRetorno
                      ? "bg-red-50/60"
                      : acosAlto
                        ? "bg-amber-50/40"
                        : "";
                    const row = (
                      <TableRow key={a.campaign_id} className={rowCls}>
                        <TableCell>
                          <Thumb src={a.foto} alt={a.anuncio} />
                        </TableCell>
                        <TableCell className="max-w-[280px]">
                          <div className="font-medium text-sm truncate">
                            {a.anuncio}
                          </div>
                          {a.ad_name && (
                            <div className="text-[11px] text-muted-foreground truncate">
                              {a.ad_name}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <SkuChips skus={a.skus} />
                        </TableCell>
                        <TableCell>
                          <LojaBadge empresa={a.empresa} />
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {a.orcamento_diario > 0
                            ? formatBRL(a.orcamento_diario)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm font-medium">
                          {formatBRL(a.investimento)}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {formatBRL(a.vendas)}
                        </TableCell>
                        <TableCell className="text-center">
                          <RoasBadge roas={a.roas} />
                        </TableCell>
                        <TableCell className="text-center text-xs">
                          {formatPercent(a.ctr)}
                        </TableCell>
                        <TableCell className="text-center">
                          <AcosBadge acos={a.acos} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={a.status} />
                        </TableCell>
                      </TableRow>
                    );
                    if (semRetorno) {
                      return (
                        <Tooltip key={a.campaign_id}>
                          <TooltipTrigger asChild>{row}</TooltipTrigger>
                          <TooltipContent>
                            Gasto sem retorno no período
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                    return row;
                  })}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function Kpi({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Card className="p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-lg font-semibold mt-1 ${
          highlight ? "text-emerald-600" : ""
        }`}
      >
        {value}
      </div>
    </Card>
  );
}
