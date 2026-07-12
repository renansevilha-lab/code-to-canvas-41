import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  AlertTriangle,
  ImageOff,
  Info,
  Package,
  Search,
  ArrowUpDown,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";

export const Route = createFileRoute("/produtos-margem")({
  component: ProdutosDashboardPage,
});

interface ProdutoRow {
  marketplace: string;
  sku: string;
  produto: string | null;
  categoria: string | null;
  foto: string | null;
  nome_anuncio: string | null;
  anuncio_ativo: boolean | null;
  qtd_anuncios: number | null;
  preco_min: number | null;
  preco_max: number | null;
  estoque: number | null;
  cmv_unitario: number | null;
  qtd_vendida: number | null;
  pedidos: number | null;
  receita_30d: number | null;
  cobertura_pct: number | null;
  margem_bruta: number | null;
  gasto_ads: number | null;
  margem_liquida: number | null;
  margem_liquida_pct: number | null;
  acos_pct: number | null;
  cliques: number | null;
  impressoes: number | null;
  tem_ads: boolean | null;
  vira_prejuizo_com_ads: boolean | null;
  confiavel: boolean | null;
}

type MarketFilter = "todos" | "shopee" | "mercadolivre" | "amazon";
type SortKey = "receita" | "margem_liq" | "margem_liq_asc" | "ads" | "acos";

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function useProdutos() {
  return useQuery({
    queryKey: ["produtos-dashboard"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_produtos_dashboard")
        .select("*")
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as ProdutoRow[];
    },
  });
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-11 h-11 rounded bg-muted flex items-center justify-center shrink-0">
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
      className="w-11 h-11 rounded object-cover shrink-0 border"
    />
  );
}

function ChannelBadge({ marketplace }: { marketplace: string }) {
  const m = (marketplace ?? "").toLowerCase();
  if (m === "shopee")
    return (
      <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100 border-orange-200 text-[10px] px-1.5 py-0">
        Shopee
      </Badge>
    );
  if (m === "mercadolivre" || m === "mercado_livre" || m === "ml")
    return (
      <Badge className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-200 text-[10px] px-1.5 py-0">
        Mercado Livre
      </Badge>
    );
  if (m === "amazon")
    return (
      <Badge className="bg-blue-900 text-white hover:bg-blue-900 border-blue-900 text-[10px] px-1.5 py-0">
        Amazon
      </Badge>
    );
  return (
    <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
      {marketplace}
    </Badge>
  );
}

function AcosBadge({ pct, hasAds }: { pct: number | null; hasAds: boolean }) {
  if (!hasAds) return <span className="text-xs text-muted-foreground">—</span>;
  const v = num(pct);
  const cls =
    v < 10
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : v <= 20
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : "bg-red-100 text-red-800 border-red-200";
  return <Badge className={cn("hover:opacity-90", cls)}>{formatPercent(v, 1)}</Badge>;
}

function MargemPctBadge({ pct }: { pct: number | null }) {
  const v = num(pct);
  const cls =
    v > 15
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : v >= 5
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : v >= 0
          ? "bg-orange-100 text-orange-800 border-orange-200"
          : "bg-red-100 text-red-800 border-red-200";
  return <Badge className={cn("hover:opacity-90", cls)}>{formatPercent(v, 1)}</Badge>;
}

function ProdutosDashboardPage() {
  const { data, isLoading, error } = useProdutos();

  const [market, setMarket] = useState<MarketFilter>("todos");
  const [soComAds, setSoComAds] = useState(false);
  const [soPrejuizo, setSoPrejuizo] = useState(false);
  const [soBaixaConf, setSoBaixaConf] = useState(false);
  const [busca, setBusca] = useState("");
  const [sort, setSort] = useState<SortKey>("receita");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const rows = data ?? [];

  const filtered = useMemo(() => {
    const q = busca.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (market !== "todos") {
        const m = (r.marketplace ?? "").toLowerCase();
        if (market === "mercadolivre") {
          if (!(m === "mercadolivre" || m === "mercado_livre" || m === "ml"))
            return false;
        } else if (m !== market) return false;
      }
      if (soComAds && !r.tem_ads) return false;
      if (soPrejuizo && !r.vira_prejuizo_com_ads) return false;
      if (soBaixaConf && r.confiavel) return false;
      if (q) {
        const hay = `${r.sku ?? ""} ${r.produto ?? ""} ${r.nome_anuncio ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = [...out].sort((a, b) => {
      switch (sort) {
        case "margem_liq":
          return num(b.margem_liquida) - num(a.margem_liquida);
        case "margem_liq_asc":
          return num(a.margem_liquida) - num(b.margem_liquida);
        case "ads":
          return num(b.gasto_ads) - num(a.gasto_ads);
        case "acos":
          return num(b.acos_pct) - num(a.acos_pct);
        case "receita":
        default:
          return num(b.receita_30d) - num(a.receita_30d);
      }
    });
    return out;
  }, [rows, market, soComAds, soPrejuizo, soBaixaConf, busca, sort]);

  const resumo = useMemo(() => {
    let receita = 0;
    let ads = 0;
    let margem = 0;
    let alertas = 0;
    let baixaConf = 0;
    for (const r of filtered) {
      receita += num(r.receita_30d);
      ads += num(r.gasto_ads);
      margem += num(r.margem_liquida);
      if (r.vira_prejuizo_com_ads) alertas++;
      if (r.confiavel === false) baixaConf++;
    }
    return {
      receita,
      ads,
      margem,
      margemPct: receita > 0 ? (margem / receita) * 100 : 0,
      alertas,
      baixaConf,
    };
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <TooltipProvider>
      <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-purple-500 text-white">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Produtos</h1>
            <p className="text-sm text-muted-foreground">
              Visão consolidada por SKU · vendas, ADS e margem líquida (30 dias)
            </p>
          </div>
        </div>

        {/* Resumo */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <ResumoCard
            icon={<DollarSign className="h-4 w-4" />}
            label="Receita 30d"
            value={isLoading ? null : formatBRL(resumo.receita)}
            hint={`${formatNumber(filtered.length)} SKUs`}
            color="text-blue-600 bg-blue-50"
          />
          <ResumoCard
            icon={<Megaphone className="h-4 w-4" />}
            label="Gasto ADS"
            value={isLoading ? null : formatBRL(resumo.ads)}
            hint={
              resumo.receita > 0
                ? `${formatPercent((resumo.ads / resumo.receita) * 100, 1)} da receita`
                : "—"
            }
            color="text-purple-600 bg-purple-50"
          />
          <ResumoCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Margem líquida"
            value={isLoading ? null : formatBRL(resumo.margem)}
            hint={`${formatPercent(resumo.margemPct, 1)} sobre receita`}
            color={
              resumo.margem >= 0
                ? "text-emerald-600 bg-emerald-50"
                : "text-red-600 bg-red-50"
            }
          />
          <ResumoCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Alertas"
            value={isLoading ? null : formatNumber(resumo.alertas)}
            hint="viram prejuízo por ADS"
            color={
              resumo.alertas > 0
                ? "text-red-600 bg-red-50"
                : "text-muted-foreground bg-muted"
            }
          />
        </div>

        {/* Filtros */}
        <Card className="p-4 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            {(
              [
                ["todos", "Todos"],
                ["shopee", "Shopee"],
                ["mercadolivre", "Mercado Livre"],
                ["amazon", "Amazon"],
              ] as [MarketFilter, string][]
            ).map(([k, label]) => (
              <Button
                key={k}
                size="sm"
                variant={market === k ? "default" : "outline"}
                onClick={() => {
                  setMarket(k);
                  setPage(0);
                }}
                className="h-8"
              >
                {label}
              </Button>
            ))}
            <div className="w-px h-6 bg-border mx-1" />
            <Button
              size="sm"
              variant={soComAds ? "default" : "outline"}
              onClick={() => {
                setSoComAds((v) => !v);
                setPage(0);
              }}
              className="h-8"
            >
              Só com ADS
            </Button>
            <Button
              size="sm"
              variant={soPrejuizo ? "default" : "outline"}
              onClick={() => {
                setSoPrejuizo((v) => !v);
                setPage(0);
              }}
              className="h-8"
            >
              Só prejuízo com ADS
            </Button>
            <Button
              size="sm"
              variant={soBaixaConf ? "default" : "outline"}
              onClick={() => {
                setSoBaixaConf((v) => !v);
                setPage(0);
              }}
              className="h-8"
            >
              Só baixa confiança
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[240px] max-w-[420px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={busca}
                onChange={(e) => {
                  setBusca(e.target.value);
                  setPage(0);
                }}
                placeholder="Buscar por SKU, produto ou anúncio"
                className="h-8 pl-7"
              />
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-8 w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="receita">Receita (maior primeiro)</SelectItem>
                  <SelectItem value="margem_liq">Margem líquida (maior)</SelectItem>
                  <SelectItem value="margem_liq_asc">Margem líquida (menor)</SelectItem>
                  <SelectItem value="ads">Gasto de ADS (maior)</SelectItem>
                  <SelectItem value="acos">ACOS (maior)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </Card>

        {/* Alertas topo */}
        {resumo.alertas > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4" />
            <span>
              <strong>{resumo.alertas} produtos</strong> ficam com margem negativa
              por causa do ADS — revisar lance ou preço.
            </span>
          </div>
        )}
        {resumo.baixaConf > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
            <Info className="h-4 w-4" />
            <span>
              <strong>{resumo.baixaConf} produtos</strong> têm cobertura de custo
              abaixo de 80% — a margem deles é estimativa.
            </span>
          </div>
        )}

        {/* Tabela */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Foto</TableHead>
                  <TableHead>SKU / Produto</TableHead>
                  <TableHead>Canal</TableHead>
                  <TableHead className="text-right">Anúncios</TableHead>
                  <TableHead className="text-right">Vendas</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">ADS</TableHead>
                  <TableHead className="text-right">ACOS</TableHead>
                  <TableHead className="text-right">Margem líq.</TableHead>
                  <TableHead className="text-right">%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={10}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {error && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-red-600 py-8">
                      Erro ao carregar: {(error as Error).message}
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && !error && pageRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                      Nenhum produto encontrado
                    </TableCell>
                  </TableRow>
                )}
                {pageRows.map((r, idx) => {
                  const margem = num(r.margem_liquida);
                  const conf = r.confiavel !== false;
                  const prej = !!r.vira_prejuizo_com_ads;
                  const margemCls = !conf
                    ? "text-muted-foreground"
                    : margem > 0
                      ? "text-emerald-700"
                      : margem < 0
                        ? "text-red-700"
                        : "text-muted-foreground";
                  return (
                    <TableRow
                      key={`${r.marketplace}-${r.sku}-${idx}`}
                      className={cn(prej && "bg-red-50/60 hover:bg-red-50")}
                    >
                      <TableCell>
                        <Thumb src={r.foto} alt={r.produto ?? r.sku} />
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        <div className="font-mono text-[11px] text-muted-foreground truncate">
                          {r.sku}
                        </div>
                        <div className="text-xs truncate" title={r.produto ?? ""}>
                          {r.produto ?? "—"}
                        </div>
                        {r.nome_anuncio && (
                          <div
                            className="text-[11px] text-muted-foreground truncate italic"
                            title={r.nome_anuncio}
                          >
                            {r.nome_anuncio}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ChannelBadge marketplace={r.marketplace} />
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {num(r.qtd_anuncios) > 1 ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="text-amber-700 font-medium cursor-help">
                                {formatNumber(num(r.qtd_anuncios))}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              SKU anunciado em {num(r.qtd_anuncios)} anúncios —
                              pode indicar canibalização
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">
                            {formatNumber(num(r.qtd_anuncios))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatNumber(num(r.qtd_vendida))}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatBRL(num(r.receita_30d))}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {num(r.gasto_ads) > 0 ? (
                          formatBRL(num(r.gasto_ads))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <AcosBadge pct={r.acos_pct} hasAds={!!r.tem_ads} />
                      </TableCell>
                      <TableCell className={cn("text-right text-xs font-semibold", margemCls)}>
                        <div className="flex items-center justify-end gap-1">
                          {prej && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Este produto só fica negativo por causa do ADS
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {!conf && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="h-3.5 w-3.5 text-slate-400" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Apenas {formatPercent(num(r.cobertura_pct), 0)} da
                                receita tem custo conhecido — margem pouco confiável
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <span className={cn(!conf && "italic opacity-70")}>
                            {formatBRL(margem)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <MargemPctBadge pct={r.margem_liquida_pct} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20 text-sm">
              <span className="text-muted-foreground">
                Página {page + 1} de {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Anterior
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </Card>

        <p className="text-xs text-muted-foreground">
          Margem líquida = receita − custo − taxas do marketplace − imposto − gasto
          de ADS. Período: últimos 30 dias. Publicidade disponível hoje apenas
          para a Shopee.
        </p>
      </div>
    </TooltipProvider>
  );
}

function ResumoCard({
  icon,
  label,
  value,
  hint,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  hint?: string;
  color: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          {value === null ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <p className="text-xl font-semibold truncate">{value}</p>
          )}
          {hint && <p className="text-xs text-muted-foreground truncate">{hint}</p>}
        </div>
        <div className={cn("rounded-md p-2 shrink-0", color)}>{icon}</div>
      </div>
    </Card>
  );
}
