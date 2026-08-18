import { BotaoSincronizar } from "@/components/BotaoSincronizar";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Warehouse,
  PackagePlus,
  Search,
  AlertTriangle,
  RefreshCw,
  Package as PackageIcon,
  Truck,
  Upload,
  Plus,
  Minus,
  Check,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  Loader2,
  Trash2,
  Send,
  Printer,
  FileText,
  Pencil,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import {
  supabaseExternal,
  EXTERNAL_URL,
  EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos

interface InventarioRow {
  marketplace: string;
  shop_id: number | null;
  warehouse: string;
  sku_marketplace: string;
  sku: string | null;
  titulo: string | null;
  sellable: number | string | null;
  reserved: number | string | null;
  in_transit: number | string | null;
  unsellable: number | string | null;
  atualizado_em: string | null;
}

interface ReposicaoRow {
  marketplace: string;
  sku: string;
  produto: string | null;
  eh_kit: boolean | null;
  und_dia: number | string | null;
  unidades_30d: number | string | null;
  estoque_full: number | string | null;
  em_transito: number | string | null;
  cobertura_atual_dias: number | string | null;
  cobertura_alvo_dias: number | string | null;
  estoque_empresa: number | string | null;
  estoque_sincronizado: boolean | null;
  necessidade: number | string | null;
  sugestao_envio: number | string | null;
  estoque_atualizado_em: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes / helpers

const MKT_LABEL: Record<string, string> = {
  amazon: "Amazon",
  mercadolivre: "Mercado Livre",
  shopee: "Shopee",
};
const MKT_COLOR: Record<string, string> = {
  amazon: "#232F3E",
  mercadolivre: "#FFE600",
  shopee: "#EE4D2D",
};
const MKT_ORDER = ["amazon", "mercadolivre", "shopee"];

// Cores do design (paleta Claude Design) por marketplace — para barras/badges.
function MKT_COR(mkt: string): string {
  if (mkt === "shopee") return "#6E56CF";
  if (mkt === "mercadolivre") return "#E0A72E";
  if (mkt === "amazon") return "#2E9E8F";
  return "#8A93A3";
}
function MKT_SOFT(mkt: string): string {
  if (mkt === "shopee") return "#F1EEFC";
  if (mkt === "mercadolivre") return "#FDF6E6";
  if (mkt === "amazon") return "#EAF6F4";
  return "#F2F3F6";
}

type MktFiltro = "todos" | "amazon" | "mercadolivre" | "shopee";
type SubTab = "inventario" | "reposicao" | "envios";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

const rowKey = (r: { marketplace: string; sku: string }) => `${r.marketplace}|${r.sku}`;

// Busca a melhor foto por SKU (view_foto_produto = fallback Tiny-novo > Shopee CDN
// > ML CDN > Tiny-antigo) apenas dos SKUs visíveis, em lotes ≤300 para nunca
// esbarrar no corte de 1.000 linhas do PostgREST. Lookup por SKU, não agregação.
function useFotos(skus: (string | null | undefined)[]) {
  const chave = useMemo(
    () => Array.from(new Set(skus.filter((s): s is string => !!s))).sort(),
    [skus],
  );
  return useQuery({
    queryKey: ["fulfillment", "fotos", chave],
    enabled: chave.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      const map: Record<string, string> = {};
      for (let i = 0; i < chave.length; i += 300) {
        const lote = chave.slice(i, i + 300);
        const { data, error } = await supabaseExternal
          .from("view_foto_produto")
          .select("sku,foto")
          .in("sku", lote);
        if (error) throw error;
        for (const r of (data ?? []) as { sku: string; foto: string | null }[]) {
          if (r.foto) map[r.sku] = r.foto;
        }
      }
      return map;
    },
  });
}

function Thumb({ url, alt }: { url?: string | null; alt?: string }) {
  if (!url) {
    return (
      <div className="h-9 w-9 rounded bg-muted flex items-center justify-center shrink-0">
        <PackageIcon className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={alt ?? ""}
      loading="lazy"
      className="h-9 w-9 rounded object-cover bg-muted shrink-0"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route

type SearchParams = { tab: SubTab; mkt: MktFiltro; q: string; somenteSugestao: boolean };

export const Route = createFileRoute("/fulfillment")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: s.tab === "inventario" ? "inventario" : s.tab === "envios" ? "envios" : "reposicao",
    mkt: (["todos", "amazon", "mercadolivre", "shopee"].includes(s.mkt as string)
      ? (s.mkt as MktFiltro)
      : "todos"),
    q: typeof s.q === "string" ? s.q : "",
    somenteSugestao: s.somenteSugestao === false || s.somenteSugestao === "false" ? false : true,
  }),
  component: FulfillmentPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Page

function FulfillmentPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const tab = search.tab;
  const mkt = search.mkt;
  const q = search.q;
  const somenteSugestao = search.somenteSugestao;

  const update = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  const invQuery = useQuery({
    queryKey: ["fulfillment", "inventario", mkt],
    queryFn: async (): Promise<InventarioRow[]> => {
      let query = supabaseExternal
        .from("estoque_fulfillment")
        .select(
          "marketplace,shop_id,warehouse,sku_marketplace,sku,titulo,sellable,reserved,in_transit,unsellable,atualizado_em",
        )
        .order("sellable", { ascending: false });
      if (mkt !== "todos") query = query.eq("marketplace", mkt);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as InventarioRow[];
    },
    enabled: tab === "inventario",
  });

  const repQuery = useQuery({
    queryKey: ["fulfillment", "reposicao", mkt],
    queryFn: async (): Promise<ReposicaoRow[]> => {
      let query = supabaseExternal
        .from("view_reposicao_full")
        .select(
          "marketplace,sku,produto,eh_kit,und_dia,unidades_30d,estoque_full,em_transito,cobertura_atual_dias,cobertura_alvo_dias,estoque_empresa,estoque_sincronizado,necessidade,sugestao_envio,estoque_atualizado_em",
        )
        .order("sugestao_envio", { ascending: false });
      if (mkt !== "todos") query = query.eq("marketplace", mkt);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ReposicaoRow[];
    },
    enabled: tab === "reposicao",
  });

  return (
    <TooltipProvider delayDuration={200}>
      <div className="w-full flex flex-col gap-[18px] px-6 md:px-8 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Estoque nos centros de distribuição e sugestão de reposição (envios Full)
          </p>
          <div className="flex items-center gap-2">
            {/* "Atualizar" relê o que já está no banco; "Sincronizar CDs" vai
                buscar nos marketplaces (o cron faz isso 2x por dia). */}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={() => {
                invQuery.refetch();
                repQuery.refetch();
              }}
              disabled={invQuery.isFetching || repQuery.isFetching}
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  (invQuery.isFetching || repQuery.isFetching) && "animate-spin",
                )}
              />
              Atualizar
            </Button>
            <BotaoSincronizar
              rotulo="Sincronizar CDs"
              titulo="Puxa o estoque de Amazon FBA, Shopee SBS e ML Full agora. O cron faz isso às 8h e às 18h."
              rotas={[
                "fulfillment-sync?modulo=amazon",
                "fulfillment-sync?modulo=shopee",
                "fulfillment-sync?modulo=ml&limite=120",
              ]}
              invalidar={["fulfillment"]}
            />
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => update({ tab: v as SubTab })}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="reposicao" className="gap-1.5">
                <PackagePlus className="h-4 w-4" /> Reposição
              </TabsTrigger>
              <TabsTrigger value="inventario" className="gap-1.5">
                <Warehouse className="h-4 w-4" /> Inventário
              </TabsTrigger>
              <TabsTrigger value="envios" className="gap-1.5">
                <Truck className="h-4 w-4" /> Envios
              </TabsTrigger>
            </TabsList>

            {tab !== "envios" && (
              <div className="flex flex-wrap items-center gap-2">
                <MktSegment value={mkt} onChange={(m) => update({ mkt: m })} />
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={q}
                    onChange={(e) => update({ q: e.target.value })}
                    placeholder="Buscar por produto ou SKU..."
                    className="pl-8 h-9 bg-card"
                  />
                </div>
              </div>
            )}
          </div>

          <TabsContent value="reposicao" className="mt-4">
            <ReposicaoTab
              rows={repQuery.data ?? []}
              loading={repQuery.isLoading}
              error={(repQuery.error as Error | null)?.message ?? null}
              busca={q}
              somenteSugestao={somenteSugestao}
              onToggleSugestao={(v) => update({ somenteSugestao: v })}
            />
          </TabsContent>

          <TabsContent value="inventario" className="mt-4">
            <InventarioTab
              rows={invQuery.data ?? []}
              loading={invQuery.isLoading}
              error={(invQuery.error as Error | null)?.message ?? null}
              busca={q}
            />
          </TabsContent>

          <TabsContent value="envios" className="mt-4">
            <EnviosTab ativo={tab === "envios"} />
          </TabsContent>
        </Tabs>
      </div>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reposição

function ReposicaoTab({
  rows,
  loading,
  error,
  busca,
  somenteSugestao,
  onToggleSugestao,
}: {
  rows: ReposicaoRow[];
  loading: boolean;
  error: string | null;
  busca: string;
  somenteSugestao: boolean;
  onToggleSugestao: (v: boolean) => void;
}) {
  // seleção e quantidade a enviar — estado de trabalho (ação em andamento)
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [qtd, setQtd] = useState<Record<string, number>>({});
  const [envioAberto, setEnvioAberto] = useState(false);
  const { data: fotos = {} } = useFotos(rows.map((r) => r.sku));

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return rows.filter((r) => {
      if (somenteSugestao && num(r.sugestao_envio) <= 0) return false;
      if (!termo) return true;
      return (
        (r.produto ?? "").toLowerCase().includes(termo) ||
        (r.sku ?? "").toLowerCase().includes(termo)
      );
    });
  }, [rows, busca, somenteSugestao]);

  const valorAEnviar = (r: ReposicaoRow) => {
    const k = rowKey(r);
    return qtd[k] ?? num(r.sugestao_envio);
  };

  const selecionadas = useMemo(
    () => filtradas.filter((r) => sel[rowKey(r)] && valorAEnviar(r) > 0),
    [filtradas, sel, qtd],
  );
  const totalUnidades = selecionadas.reduce((s, r) => s + valorAEnviar(r), 0);

  const repKpis = useMemo(() => {
    let abaixo = 0, sugeridas = 0;
    for (const r of filtradas) {
      if (num(r.cobertura_atual_dias) < num(r.cobertura_alvo_dias)) abaixo++;
      sugeridas += num(r.sugestao_envio);
    }
    return { abaixo, sugeridas };
  }, [filtradas]);

  const todasMarcadas = filtradas.length > 0 && filtradas.every((r) => sel[rowKey(r)]);
  const marcarTodas = (v: boolean) => {
    const next: Record<string, boolean> = { ...sel };
    for (const r of filtradas) next[rowKey(r)] = v;
    setSel(next);
  };

  if (error) {
    return (
      <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
        Erro ao carregar reposição: {error}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-[14px]">
        <InvKpi label="SKUs abaixo da cobertura-alvo" value={repKpis.abaixo} loading={loading} color="var(--color-destructive)" />
        <InvKpi label="Unidades sugeridas" value={repKpis.sugeridas} loading={loading} color="var(--color-primary)" />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <Checkbox
            checked={somenteSugestao}
            onCheckedChange={(c) => onToggleSugestao(c === true)}
          />
          Mostrar só itens com sugestão de envio
        </label>
        <span className="text-xs text-muted-foreground">
          {loading ? "Carregando..." : `${formatNumber(filtradas.length)} SKUs`}
        </span>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-3 w-10">
                  <Checkbox
                    checked={todasMarcadas}
                    onCheckedChange={(c) => marcarTodas(c === true)}
                    aria-label="Selecionar todos"
                  />
                </th>
                <th className="text-left font-semibold px-3 py-3">Produto</th>
                <th className="text-left font-semibold px-3 py-3">Canal</th>
                <th className="text-right font-semibold px-3 py-3">Estoque CD</th>
                <th className="text-right font-semibold px-3 py-3">Em trânsito</th>
                <th className="text-right font-semibold px-3 py-3">Cobertura</th>
                <th className="text-right font-semibold px-3 py-3">Necessidade</th>
                <th className="text-right font-semibold px-3 py-3">Sugestão</th>
                <th className="text-right font-semibold px-3 py-3">A enviar</th>
                <th className="text-right font-semibold px-3 py-3">Estoque empresa</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={10} className="px-3 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : filtradas.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhum item para reposição com os filtros atuais
                  </td>
                </tr>
              ) : (
                filtradas.map((r) => {
                  const k = rowKey(r);
                  const enviar = valorAEnviar(r);
                  const estoqueEmpresa = num(r.estoque_empresa);
                  const semEstoque = enviar > estoqueEmpresa;
                  return (
                    <tr key={k} className={cn("border-t hover:bg-accent/40 transition", sel[k] && "bg-accent/30")}>
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={!!sel[k]}
                          onCheckedChange={(c) => setSel((s) => ({ ...s, [k]: c === true }))}
                        />
                      </td>
                      <td className="px-3 py-2 max-w-[340px]">
                        <div className="flex items-center gap-2.5">
                          <Thumb url={fotos[r.sku]} alt={r.produto ?? ""} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate">{r.produto ?? "—"}</span>
                              {r.eh_kit && (
                                <Badge variant="secondary" className="h-4 px-1 text-[10px] shrink-0">
                                  kit
                                </Badge>
                              )}
                            </div>
                            <span className="font-mono text-[11px] text-muted-foreground">{r.sku}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-[5px] whitespace-nowrap"
                          style={{ background: MKT_SOFT(r.marketplace), color: MKT_COR(r.marketplace) }}
                        >
                          {MKT_LABEL[r.marketplace] ?? r.marketplace}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] font-semibold">{formatNumber(num(r.estoque_full))}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] text-[#4A7BD9]">
                        {formatNumber(num(r.em_transito))}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <CoberturaPill dias={num(r.cobertura_atual_dias)} alvo={num(r.cobertura_alvo_dias)} />
                      </td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums font-mono text-[13px]", num(r.necessidade) > 0 ? "text-destructive font-semibold" : "text-muted-foreground")}>
                        {formatNumber(num(r.necessidade))}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] font-semibold">
                        {formatNumber(num(r.sugestao_envio))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={enviar}
                          onChange={(e) =>
                            setQtd((prev) => ({ ...prev, [k]: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))
                          }
                          className="h-8 w-20 text-right tabular-nums ml-auto"
                        />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {semEstoque ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {formatNumber(estoqueEmpresa)}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              Estoque na empresa ({formatNumber(estoqueEmpresa)}) menor que a quantidade a enviar
                              ({formatNumber(enviar)})
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className="text-muted-foreground">{formatNumber(estoqueEmpresa)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {selecionadas.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
            <span className="text-sm">
              <strong>{selecionadas.length}</strong> SKUs · <strong>{formatNumber(totalUnidades)}</strong> unidades
            </span>
            <Button size="sm" className="gap-2" onClick={() => setEnvioAberto(true)}>
              <PackagePlus className="h-4 w-4" /> Montar envio
            </Button>
          </div>
        )}
      </Card>

      <EnvioSheet
        aberto={envioAberto}
        onFechar={() => setEnvioAberto(false)}
        itens={selecionadas.map((r) => ({
          marketplace: r.marketplace,
          sku: r.sku,
          produto: r.produto,
          foto: fotos[r.sku] ?? null,
          quantidade: valorAEnviar(r),
        }))}
      />
    </div>
  );
}

function EnvioSheet({
  aberto,
  onFechar,
  itens,
}: {
  aberto: boolean;
  onFechar: () => void;
  itens: { marketplace: string; sku: string; produto: string | null; foto: string | null; quantidade: number }[];
}) {
  const porCanal = useMemo(() => {
    const map = new Map<string, typeof itens>();
    for (const it of itens) {
      const arr = map.get(it.marketplace) ?? [];
      arr.push(it);
      map.set(it.marketplace, arr);
    }
    return MKT_ORDER.filter((m) => map.has(m)).map((m) => ({ marketplace: m, itens: map.get(m)! }));
  }, [itens]);

  return (
    <Sheet open={aberto} onOpenChange={(o) => !o && onFechar()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5" /> Envio Full — rascunho
          </SheetTitle>
        </SheetHeader>

        <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          Primeira versão: este envio ainda <strong>não é gravado</strong>. A persistência (tabela de envios
          + integração com o marketplace) é o próximo passo — por ora serve para conferir e copiar.
        </div>

        <div className="mt-4 space-y-5">
          {porCanal.map(({ marketplace, itens }) => {
            const total = itens.reduce((s, i) => s + i.quantidade, 0);
            return (
              <div key={marketplace}>
                <div className="flex items-center justify-between mb-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                    <MktDot marketplace={marketplace} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {itens.length} SKUs · {formatNumber(total)} un.
                  </span>
                </div>
                <div className="space-y-1">
                  {itens.map((i) => (
                    <div key={`${marketplace}|${i.sku}`} className="flex items-center justify-between gap-2 text-sm py-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Thumb url={i.foto} alt={i.produto ?? ""} />
                        <div className="min-w-0">
                          <div className="truncate">{i.produto ?? "—"}</div>
                          <span className="font-mono text-[11px] text-muted-foreground">{i.sku}</span>
                        </div>
                      </div>
                      <span className="tabular-nums font-medium shrink-0">{formatNumber(i.quantidade)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <Button
          variant="outline"
          className="w-full mt-6 gap-2"
          onClick={() => {
            const linhas = itens.map((i) => `${i.marketplace}\t${i.sku}\t${i.quantidade}`).join("\n");
            navigator.clipboard?.writeText(`marketplace\tsku\tquantidade\n${linhas}`);
          }}
        >
          Copiar lista (TSV)
        </Button>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventário

function InventarioTab({
  rows,
  loading,
  error,
  busca,
}: {
  rows: InventarioRow[];
  loading: boolean;
  error: string | null;
  busca: string;
}) {
  const { data: fotos = {} } = useFotos(rows.map((r) => r.sku));
  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return rows;
    return rows.filter(
      (r) =>
        (r.titulo ?? "").toLowerCase().includes(termo) ||
        (r.sku ?? "").toLowerCase().includes(termo) ||
        (r.sku_marketplace ?? "").toLowerCase().includes(termo),
    );
  }, [rows, busca]);

  const totais = useMemo(() => {
    let sellable = 0, reserved = 0, inTransit = 0, unsellable = 0;
    for (const r of filtradas) {
      sellable += num(r.sellable);
      reserved += num(r.reserved);
      inTransit += num(r.in_transit);
      unsellable += num(r.unsellable);
    }
    return { sellable, reserved, inTransit, unsellable };
  }, [filtradas]);

  // Estoque sellable por marketplace — para a barra de participação.
  const mktShare = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of filtradas) map.set(r.marketplace, (map.get(r.marketplace) ?? 0) + num(r.sellable));
    const total = totais.sellable || 1;
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([mkt, val]) => ({ mkt, val, pct: (val / total) * 100, color: MKT_COR(mkt) }));
  }, [filtradas, totais.sellable]);

  if (error) {
    return (
      <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
        Erro ao carregar inventário: {error}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-[14px]">
        <InvKpi label="Disponível" value={totais.sellable} loading={loading} color="var(--color-success)" />
        <InvKpi label="Reservado" value={totais.reserved} loading={loading} muted color="var(--color-warning)" />
        <InvKpi label="Em trânsito" value={totais.inTransit} loading={loading} muted color="var(--color-chart-4)" />
        <InvKpi label="Inutilizável" value={totais.unsellable} loading={loading} muted color="var(--color-destructive)" />
      </section>

      {mktShare.length > 0 && (
        <Card className="p-5 flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold tracking-[-0.015em]">Estoque sellable por marketplace</span>
            <span className="text-[12px] text-muted-foreground">Participação das unidades disponíveis nos CDs do canal</span>
          </div>
          <div className="flex h-2.5 rounded-md overflow-hidden gap-0.5">
            {mktShare.map((m) => (
              <div key={m.mkt} style={{ width: `${m.pct}%`, background: m.color }} />
            ))}
          </div>
          <div className="flex items-center gap-x-6 gap-y-2 flex-wrap">
            {mktShare.map((m) => (
              <div key={m.mkt} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: m.color }} />
                <span className="text-[12.5px] font-medium">{MKT_LABEL[m.mkt] ?? m.mkt}</span>
                <span className="text-[12.5px] text-muted-foreground font-mono tabular-nums">{formatNumber(m.val)} un</span>
                <span className="text-[12px] font-semibold font-mono tabular-nums" style={{ color: m.color }}>{m.pct.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h3 className="text-[14.5px] font-semibold tracking-[-0.015em]">
            Estoque nos CDs{" "}
            <span className="text-muted-foreground font-normal">({formatNumber(filtradas.length)})</span>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left font-semibold px-3 py-3">Produto</th>
                <th className="text-left font-semibold px-3 py-3">Canal</th>
                <th className="text-left font-semibold px-3 py-3">CD</th>
                <th className="text-right font-semibold px-3 py-3">Sellable</th>
                <th className="text-right font-semibold px-3 py-3">Reservado</th>
                <th className="text-right font-semibold px-3 py-3">Em trânsito</th>
                <th className="text-right font-semibold px-3 py-3">Inutilizável</th>
                <th className="text-left font-semibold px-3 py-3">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={8} className="px-3 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : filtradas.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhum item de estoque encontrado
                  </td>
                </tr>
              ) : (
                filtradas.map((r) => {
                  const semSku = !r.sku;
                  return (
                    <tr
                      key={`${r.marketplace}|${r.shop_id}|${r.sku_marketplace}|${r.warehouse}`}
                      className={cn("border-t hover:bg-accent/40 transition", semSku && "opacity-70")}
                    >
                      <td className="px-3 py-2 max-w-[360px]">
                        <div className="flex items-center gap-2.5">
                          <Thumb url={r.sku ? fotos[r.sku] : null} alt={r.titulo ?? ""} />
                          <div className="min-w-0">
                            <div className="truncate">{r.titulo ?? "—"}</div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {r.sku ?? r.sku_marketplace}
                              </span>
                              {semSku && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge
                                      variant="outline"
                                      className="h-4 px-1 text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300"
                                    >
                                      sem SKU
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Item do CD sem SKU interno mapeado — não entra na reposição
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-[5px] whitespace-nowrap"
                          style={{ background: MKT_SOFT(r.marketplace), color: MKT_COR(r.marketplace) }}
                        >
                          {MKT_LABEL[r.marketplace] ?? r.marketplace}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-[12.5px] whitespace-nowrap text-secondary-foreground">{r.warehouse}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] font-semibold">{formatNumber(num(r.sellable))}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] text-secondary-foreground">
                        {formatNumber(num(r.reserved))}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[13px] text-[#4A7BD9]">
                        {formatNumber(num(r.in_transit))}
                      </td>
                      <td className={cn("px-3 py-2.5 text-right tabular-nums font-mono text-[13px]", num(r.unsellable) > 0 ? "text-destructive" : "text-muted-foreground")}>
                        {formatNumber(num(r.unsellable))}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {r.atualizado_em ? format(parseISO(r.atualizado_em), "dd/MM HH:mm") : "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes

function MktSegment({ value, onChange }: { value: MktFiltro; onChange: (v: MktFiltro) => void }) {
  const opts: { id: MktFiltro; label: string }[] = [
    { id: "todos", label: "Todos" },
    { id: "amazon", label: "Amazon" },
    { id: "mercadolivre", label: "Mercado Livre" },
    { id: "shopee", label: "Shopee" },
  ];
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-sm transition",
            value === o.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MktDot({ marketplace }: { marketplace: string }) {
  const color = MKT_COLOR[marketplace] ?? "#94a3b8";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
        style={{ backgroundColor: color, boxShadow: "0 0 0 1px rgba(0,0,0,0.08) inset" }}
      />
      {MKT_LABEL[marketplace] ?? marketplace}
    </span>
  );
}

function CoberturaPill({ dias, alvo }: { dias: number; alvo: number }) {
  const ratio = alvo > 0 ? dias / alvo : 1;
  const tone =
    ratio < 0.34
      ? "bg-red-500/15 text-red-700 dark:text-red-300"
      : ratio < 0.67
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-block rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums", tone)}>
          {dias.toFixed(1).replace(".", ",")} d
        </span>
      </TooltipTrigger>
      <TooltipContent>Cobertura atual vs. alvo de {formatNumber(alvo)} dias</TooltipContent>
    </Tooltip>
  );
}

function InvKpi({
  label,
  value,
  loading,
  muted,
  color,
}: {
  label: string;
  value: number;
  loading: boolean;
  muted?: boolean;
  color?: string;
}) {
  return (
    <Card className="relative overflow-hidden p-0">
      {color && <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: color }} />}
      <div className="p-4 pl-5 flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-muted-foreground">{label}</span>
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <span className={cn("text-[26px] font-semibold tracking-[-0.03em] tabular-nums leading-none", muted && "text-muted-foreground")}>
            {formatNumber(value)}
          </span>
        )}
      </div>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Envios / Packing de fulfillment
//
// O marketplace não expõe o inbound pendente por API (validado). O contorno:
// ao criar o envio no Seller Center, o operador sobe o PDF de "instruções de
// preparação"; a edge fn `fulfillment-inbound` lê SKU/qtd/título (posicional,
// casa com produtos) e o app vira um checklist visual de separação (packing).

interface Envio {
  id: string;
  marketplace: string;
  empresa: string | null;
  numero: string | null;
  centro: string | null;
  status: string;
  total_unidades: number | null;
  observacao: string | null;
  data_envio_agendada: string | null;
  etiquetas_zpl: string | null;
  criado_por: string | null;
  criado_em: string;
  atualizado_em: string;
  estoque_lancado_em: string | null;
  estoque_lancado_por: string | null;
}
interface EnvioItem {
  id: string;
  envio_id: string;
  sku: string | null;
  sku_origem: string | null;
  ean: string | null;
  titulo: string | null;
  qtd_planejada: number;
  qtd_separada: number;
  conferido: boolean;
  ordem: number | null;
}
interface ParsedItem {
  sku: string;
  sku_origem: string | null; // SKU original do PDF (preservado quando o operador corrige o sku)
  ean: string | null;
  titulo: string | null;
  titulo_pdf: string | null;
  qtd: number | null;
  no_cadastro: boolean;
  tem_foto: boolean;
  ordem: number;
}

// Etapas do Kanban de envios (espelha o Trello). A ordem define o avanço ←/→.
// 'separando' é a 1a etapa (compatível com envios já existentes).
const STAGES: Array<{ id: string; label: string; curto: string; cls: string; col: string; tint: string }> = [
  { id: "separando", label: "Verificar Estoque / Separar", curto: "Separando", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300", col: "#B7791F", tint: "#FDF6EA" },
  { id: "embalar", label: "Embalar", curto: "Embalar", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300", col: "#2F6FB0", tint: "#EEF5FC" },
  { id: "etiquetas", label: "Etiquetas de Volume / Finalização", curto: "Etiquetas", cls: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300", col: "#7A5CC7", tint: "#F4F1FB" },
  { id: "pronto_envio", label: "Pronto para Envio", curto: "Pronto", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300", col: "#0E8A5F", tint: "#EBF7F1" },
  { id: "enviado", label: "Enviado", curto: "Enviado", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-300", col: "#5C6470", tint: "#F2F3F5" },
];
const STAGE_MAP: Record<string, (typeof STAGES)[number] & { idx: number }> = Object.fromEntries(
  STAGES.map((s, i) => [s.id, { ...s, idx: i }]),
);
function stageDe(status: string) {
  return STAGE_MAP[status] ?? { ...STAGES[0], idx: 0 };
}

const DOC_TIPOS: Array<{ id: string; label: string }> = [
  { id: "danfe", label: "DANFE" },
  { id: "folha_envio", label: "Folha de envio" },
  { id: "etiquetas", label: "Etiquetas" },
  { id: "etiqueta_produto", label: "Etiqueta de produtos (Amazon)" },
  { id: "preparacao", label: "Prep. (SKUs)" },
  { id: "outro", label: "Outro" },
];
const DOC_TIPO_LABEL: Record<string, string> = Object.fromEntries(DOC_TIPOS.map((t) => [t.id, t.label]));

// Adivinha o tipo do documento pelo NOME do arquivo (best-effort; o operador corrige
// no seletor de cada linha se errar). Ordem importa: específico antes do genérico.
function detectarTipoDoc(nome: string): string {
  const n = (nome || "").toLowerCase();
  if (/danfe|nf-?e|nota.?fiscal/.test(n)) return "danfe";
  if (/fnsku|amazon|product.?label|etiqueta.?(de.?)?produto|unit.?label/.test(n)) return "etiqueta_produto";
  if (/etiqueta|volume|\blabels?\b|\.zpl/.test(n)) return "etiquetas";
  if (/prepar|instru|romaneio|packing|conte[úu]do|content/.test(n)) return "preparacao";
  if (/folha|remessa|\benvio\b|shipment/.test(n)) return "folha_envio";
  return "outro";
}

interface EnvioDoc {
  id: string;
  tipo: string;
  nome: string | null;
  mime: string | null;
  tamanho: number | null;
  criado_em: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:.*;base64,/, ""));
    r.onerror = () => reject(new Error("falha ao ler arquivo"));
    r.readAsDataURL(file);
  });
}

// Impressoras ZD220 (mesmo PrintNode das etiquetas Shopee). A escolha compartilha
// o localStorage com a tela de Separação, então a impressora selecionada lá vale aqui.
const STORAGE_PRINTER = "separacao.printerId";
interface ImpressoraFF {
  printer_id: number;
  nome: string;
  computador: string;
  estado: string;
  configurada?: boolean;
}
function useImpressorasFF(enabled: boolean) {
  return useQuery({
    queryKey: ["fulfillment", "impressoras"],
    enabled,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ImpressoraFF[]> => {
      const resp = await fetch(
        `${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras&loja=ottz`,
        { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
      );
      const data = (await resp.json().catch(() => ({}))) as { impressoras?: ImpressoraFF[] };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (data.impressoras ?? []).filter((p) => (p.nome ?? "").toLowerCase().includes("zd220"));
    },
  });
}

// Soma de cópias no ZPL (^PQ<n>) — quantas etiquetas físicas sairão.
function contarCopiasZpl(zpl: string | null | undefined): number {
  if (!zpl) return 0;
  let total = 0;
  for (const m of String(zpl).matchAll(/\^PQ(\d+)/g)) total += parseInt(m[1], 10) || 0;
  return total || (String(zpl).match(/\^XA/g) || []).length;
}

// Cada etiqueta do ML é um bloco ^XA…^XZ com "SKU: <x>" dentro. Fatia por SKU
// para permitir imprimir produto a produto.
function dividirZplPorSku(zpl: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!zpl) return map;
  for (const m of String(zpl).matchAll(/\^XA[\s\S]*?\^XZ/g)) {
    const bloco = m[0];
    const sku = (bloco.match(/SKU:\s*([A-Za-z0-9._\-]+)/) || [])[1];
    if (sku) map.set(sku, bloco);
  }
  return map;
}
// Troca a quantidade de cópias (^PQ<n>) de um bloco de etiqueta.
function comQuantidadeZpl(bloco: string, qty: number): string {
  return bloco.replace(/\^PQ\d+/, `^PQ${Math.max(1, qty)}`);
}

function Barra({ valor, total }: { valor: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((valor / total) * 100)) : 0;
  const cheio = total > 0 && valor >= total;
  return (
    <div className="h-2 rounded-full bg-muted overflow-hidden">
      <div
        className={cn("h-full transition-all", cheio ? "bg-emerald-500" : "bg-primary")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function EnviosTab({ ativo }: { ativo: boolean }) {
  const qc = useQueryClient();
  const [view, setView] = useState<"lista" | "novo">("lista");
  const [packingId, setPackingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const enviosQ = useQuery({
    queryKey: ["fulfillment", "envios"],
    enabled: ativo,
    queryFn: async (): Promise<Envio[]> => {
      const { data, error } = await supabaseExternal
        .from("fulfillment_envios")
        .select("*")
        .order("criado_em", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Envio[];
    },
  });

  const progressoQ = useQuery({
    queryKey: ["fulfillment", "envios-progresso"],
    enabled: ativo,
    queryFn: async (): Promise<Map<string, { plan: number; sep: number; itens: number }>> => {
      const { data, error } = await supabaseExternal
        .from("fulfillment_envio_itens")
        .select("envio_id, qtd_planejada, qtd_separada");
      if (error) throw error;
      const map = new Map<string, { plan: number; sep: number; itens: number }>();
      for (const r of (data ?? []) as { envio_id: string; qtd_planejada: number; qtd_separada: number }[]) {
        const g = map.get(r.envio_id) ?? { plan: 0, sep: 0, itens: 0 };
        g.plan += num(r.qtd_planejada);
        g.sep += num(r.qtd_separada);
        g.itens += 1;
        map.set(r.envio_id, g);
      }
      return map;
    },
  });

  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ["fulfillment", "envios"] });
    qc.invalidateQueries({ queryKey: ["fulfillment", "envios-progresso"] });
  };

  if (packingId) {
    return (
      <PackingEnvio
        envioId={packingId}
        onVoltar={() => {
          setPackingId(null);
          recarregar();
        }}
      />
    );
  }
  if (view === "novo") {
    return (
      <NovoEnvio
        onCancelar={() => setView("lista")}
        onCriado={(id) => {
          setView("lista");
          recarregar();
          setPackingId(id);
        }}
      />
    );
  }

  async function moverPara(id: string, stageId: string) {
    setDragId(null);
    setDragOver(null);
    const e = (enviosQ.data ?? []).find((x) => x.id === id);
    if (!e || e.status === stageId) return;
    qc.setQueryData<Envio[]>(["fulfillment", "envios"], (old) =>
      (old ?? []).map((x) => (x.id === id ? { ...x, status: stageId } : x)),
    );
    const { error } = await supabaseExternal
      .from("fulfillment_envios")
      .update({ status: stageId, atualizado_em: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      toast.error("Falha ao mover", { description: error.message });
      recarregar();
    }
  }

  async function excluirEnvio(e: Envio) {
    const rotulo = e.numero ? `#${e.numero}` : "(sem número)";
    if (!window.confirm(`Excluir o envio ${rotulo}? Remove também os itens e documentos anexados. Não dá para desfazer.`)) return;
    // Remoção otimista do quadro
    qc.setQueryData<Envio[]>(["fulfillment", "envios"], (old) => (old ?? []).filter((x) => x.id !== e.id));
    try {
      await supabaseExternal.from("fulfillment_envio_docs").delete().eq("envio_id", e.id);
      await supabaseExternal.from("fulfillment_envio_itens").delete().eq("envio_id", e.id);
      const { error } = await supabaseExternal.from("fulfillment_envios").delete().eq("id", e.id);
      if (error) throw error;
      toast.success(`Envio ${rotulo} excluído`);
    } catch (err) {
      toast.error("Falha ao excluir", { description: (err as Error).message });
    } finally {
      recarregar();
    }
  }

  const envios = enviosQ.data ?? [];
  const hoje = new Date().toISOString().slice(0, 10);
  const totPlan = envios.reduce((s, e) => s + (progressoQ.data?.get(e.id)?.plan ?? e.total_unidades ?? 0), 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-[#8B93A1]">
          {envios.length} envios abertos · {formatNumber(totPlan)} unidades planejadas · arraste os cartões entre as colunas para mudar o estágio
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setView("novo")}>
          <Plus className="h-4 w-4" /> Novo envio
        </Button>
      </div>

      {enviosQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : envios.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Nenhum envio ainda. Clique em <strong>Novo envio</strong> e suba o PDF de preparação.
        </Card>
      ) : (
        <div
          className="grid gap-3.5 overflow-x-auto pb-1.5 items-start"
          style={{ gridTemplateColumns: "repeat(5, minmax(196px, 1fr))" }}
        >
          {STAGES.map((stage) => {
            const doStage = envios.filter((e) => stageDe(e.status).id === stage.id);
            const over = !!dragId && dragOver === stage.id;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => { e.preventDefault(); if (dragOver !== stage.id) setDragOver(stage.id); }}
                onDragLeave={() => { if (dragOver === stage.id) setDragOver(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/plain") || dragId;
                  if (id) void moverPara(id, stage.id);
                }}
                className="flex flex-col gap-2.5 min-h-[180px] rounded-[14px] p-1.5 pb-2.5"
                style={{
                  background: over ? "#F7F6FD" : stage.tint,
                  border: over ? "1.5px dashed var(--color-primary)" : `1.5px solid ${stage.tint}`,
                  boxShadow: "0 1px 3px rgba(16,20,26,.03)",
                }}
              >
                <div className="flex items-center gap-2 px-2 py-2 -mx-1.5 -mt-1.5 rounded-t-[10px]" style={{ background: stage.col }}>
                  <span className="h-[7px] w-[7px] rounded-full bg-white shrink-0" />
                  <span className="text-[11.5px] font-bold uppercase tracking-wide text-white">{stage.curto}</span>
                  <div className="flex-1" />
                  <span className="text-[11px] font-bold text-white font-mono px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,.28)" }}>
                    {doStage.length}
                  </span>
                </div>

                {doStage.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#C9CFD8] py-5 px-4 flex flex-col items-center gap-1.5 text-center" style={{ background: "rgba(255,255,255,.5)" }}>
                    <span className="text-[#B8BEC8] text-base">◌</span>
                    <span className="text-[12px] font-medium text-[#8B93A1]">Nenhum envio</span>
                    <span className="text-[11px] text-[#A6ADBA]">Suba o PDF de preparação para criar</span>
                  </div>
                ) : (
                  doStage.map((e) => {
                    const p = progressoQ.data?.get(e.id);
                    const planT = p?.plan ?? e.total_unidades ?? 0;
                    const sepT = p?.sep ?? 0;
                    const pctD = planT > 0 ? (sepT / planT) * 100 : 0;
                    const atrasado = !!e.data_envio_agendada && e.status !== "enviado" && e.data_envio_agendada < hoje;
                    return (
                      <div
                        key={e.id}
                        draggable
                        onDragStart={(ev) => { ev.dataTransfer.setData("text/plain", e.id); ev.dataTransfer.effectAllowed = "move"; setDragId(e.id); }}
                        onDragEnd={() => { setDragId(null); setDragOver(null); }}
                        onClick={() => { if (!dragId) setPackingId(e.id); }}
                        className="bg-card rounded-xl p-3 pl-2.5 flex flex-col gap-2.5 cursor-grab"
                        style={{ border: "1px solid #E6E8EC", borderLeft: `4px solid ${stage.col}`, opacity: dragId === e.id ? 0.4 : 1, boxShadow: "0 1px 2px rgba(16,20,26,.04)" }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: MKT_COLOR[e.marketplace] ?? "#888" }} />
                          <span className="text-[12.5px] font-semibold font-mono whitespace-nowrap">{e.numero ? `#${e.numero}` : "(s/ nº)"}</span>
                          <div className="flex-1" />
                          <span className="text-[#C9CFD8] text-xs tracking-tighter">⠿</span>
                        </div>
                        <span
                          className="self-start text-[13px] font-bold px-2.5 py-1 rounded-lg font-mono"
                          style={{ background: atrasado ? "#FBEDEA" : "#F4F5F7", color: atrasado ? "#C9432F" : "#6C7481" }}
                        >
                          {e.data_envio_agendada ? (atrasado ? "atrasado · " : "coleta ") + format(parseISO(e.data_envio_agendada), "dd/MM") : "sem data"}
                        </span>
                        <span className="text-[11.5px] text-muted-foreground truncate">
                          {MKT_LABEL[e.marketplace] ?? e.marketplace}{e.centro ? ` · ${e.centro}` : ""}
                        </span>
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[11.5px] text-[#4B5462] font-mono">{formatNumber(sepT)} / {formatNumber(planT)} un</span>
                            <span className="text-[11px] font-semibold font-mono" style={{ color: stage.col }}>{Math.round(pctD)}%</span>
                          </div>
                          <div className="h-[5px] rounded-[3px] bg-[#F1F2F5] overflow-hidden">
                            <div className="h-full rounded-[3px]" style={{ width: `${Math.min(100, pctD)}%`, background: stage.col }} />
                          </div>
                        </div>
                        {e.observacao && (
                          <span className="text-[11px] text-muted-foreground leading-snug" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {e.observacao}
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NovoEnvio({ onCancelar, onCriado }: { onCancelar: () => void; onCriado: (id: string) => void }) {
  const { perfil } = usePerfil();
  const [marketplace, setMarketplace] = useState("mercadolivre");
  const [empresa, setEmpresa] = useState<string>("");
  const [numero, setNumero] = useState("");
  const [centro, setCentro] = useState("");
  const [itens, setItens] = useState<ParsedItem[]>([]);
  const [totalPdf, setTotalPdf] = useState<number | null>(null);
  const [etiquetasZpl, setEtiquetasZpl] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const zplRef = useRef<HTMLInputElement>(null);

  const { data: fotos } = useFotos(itens.map((i) => i.sku));
  const somaQtd = itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0);
  const confere = totalPdf == null || somaQtd === totalPdf;

  async function lerPdf(file: File) {
    setParsing(true);
    try {
      const b64 = await fileToBase64(file);
      const { data, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
        body: { pdf_base64: b64 },
      });
      if (error) throw new Error(error.message);
      if ((data as { erro?: string })?.erro) throw new Error((data as { erro?: string }).erro);
      const d = data as { itens?: ParsedItem[]; total?: number; numero?: string; aviso?: string };
      const parsed = d.itens ?? [];
      // Guarda o SKU original do PDF em sku_origem para preservar quando o operador corrigir o sku.
      setItens(parsed.map((p) => ({ ...p, sku_origem: p.sku_origem ?? p.sku })));
      setTotalPdf(d.total ?? null);
      if (d.numero && !numero) setNumero(String(d.numero));
      if (d.aviso) toast.warning(d.aviso);
      else toast.success(`PDF lido: ${parsed.length} itens · ${d.total} unidades`);
    } catch (e) {
      toast.error("Falha ao ler o PDF", { description: (e as Error).message });
    } finally {
      setParsing(false);
    }
  }

  function setQtd(idx: number, v: string) {
    const n = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
    setItens((prev) => prev.map((it, i) => (i === idx ? { ...it, qtd: n } : it)));
  }
  function setSku(idx: number, v: string) {
    setItens((prev) => prev.map((it, i) => (i === idx ? { ...it, sku: v } : it)));
  }
  // Ao sair do campo de SKU: re-resolve título e "fora do cadastro" pelo produto
  // do SKU corrigido (a foto re-resolve sozinha, pois useFotos depende da lista).
  async function resolverSku(idx: number) {
    const alvo = itens[idx];
    const sku = (alvo?.sku ?? "").trim();
    setItens((prev) => prev.map((x, i) => (i === idx ? { ...x, sku } : x)));
    if (!sku) return;
    const { data: prod } = await supabaseExternal
      .from("produtos").select("nome").eq("sku", sku).maybeSingle();
    const nome = (prod as { nome?: string } | null)?.nome ?? null;
    // no_cadastro = "está NO cadastro" (true = existe em produtos).
    setItens((prev) => prev.map((x, i) =>
      i === idx ? { ...x, titulo: nome ?? x.titulo_pdf, no_cadastro: !!prod } : x));
  }
  function remover(idx: number) {
    setItens((prev) => prev.filter((_, i) => i !== idx));
  }

  async function salvar() {
    if (itens.length === 0) {
      toast.warning("Suba a lista (PDF) antes de salvar.");
      return;
    }
    setSalvando(true);
    try {
      const { data: env, error: e1 } = await supabaseExternal
        .from("fulfillment_envios")
        .insert({
          marketplace,
          empresa: empresa || null,
          numero: numero || null,
          centro: centro || null,
          status: "separando",
          total_unidades: somaQtd,
          etiquetas_zpl: etiquetasZpl,
          criado_por: perfil?.nome ?? null,
        })
        .select("id")
        .single();
      if (e1) throw e1;
      const envioId = (env as { id: string }).id;
      const linhas = itens.map((it, i) => ({
        envio_id: envioId,
        sku: (it.sku ?? "").trim() || null,
        sku_origem: it.sku_origem ?? null,
        ean: it.ean,
        titulo: it.titulo ?? it.titulo_pdf,
        qtd_planejada: Number(it.qtd) || 0,
        qtd_separada: 0,
        ordem: it.ordem ?? i,
      }));
      const { error: e2 } = await supabaseExternal.from("fulfillment_envio_itens").insert(linhas);
      if (e2) throw e2;
      toast.success("Envio criado — bora separar!");
      onCriado(envioId);
    } catch (e) {
      toast.error("Erro ao salvar o envio", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="gap-1 -ml-2" onClick={onCancelar}>
          <ChevronLeft className="h-4 w-4" /> Voltar
        </Button>
        <h2 className="text-lg font-semibold">Novo envio</h2>
      </div>

      <Card className="p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Marketplace</label>
            <Select value={marketplace} onValueChange={setMarketplace}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mercadolivre">Mercado Livre</SelectItem>
                <SelectItem value="amazon">Amazon</SelectItem>
                <SelectItem value="shopee">Shopee</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Empresa</label>
            <Select value={empresa || "-"} onValueChange={(v) => setEmpresa(v === "-" ? "" : v)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="-">—</SelectItem>
                <SelectItem value="ACZ Pet">ACZ Pet</SelectItem>
                <SelectItem value="SVL Store">SVL Store</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Número do envio</label>
            <Input value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="ex: 72900192" className="h-9" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Centro (CD)</label>
            <Input value={centro} onChange={(e) => setCentro(e.target.value)} placeholder="ex: Perus - BRRC01" className="h-9" />
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void lerPdf(f);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={zplRef}
          type="file"
          accept=".txt,.zpl,text/plain"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = "";
            if (!f) return;
            try {
              const txt = await f.text();
              setEtiquetasZpl(txt);
              toast.success(`Etiquetas anexadas · ${contarCopiasZpl(txt)} etiquetas`);
            } catch {
              toast.error("Falha ao ler o arquivo de etiquetas");
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="gap-2" onClick={() => fileRef.current?.click()} disabled={parsing}>
            {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {itens.length ? "Trocar PDF" : "Subir PDF de preparação"}
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => zplRef.current?.click()}>
            <Printer className="h-4 w-4" />
            {etiquetasZpl ? "Trocar etiquetas" : "Subir etiquetas (ZPL, opcional)"}
          </Button>
          {etiquetasZpl && (
            <span className="text-xs text-emerald-600 inline-flex items-center gap-1">
              <FileText className="h-3.5 w-3.5" /> {contarCopiasZpl(etiquetasZpl)} etiquetas prontas
            </span>
          )}
        </div>
      </Card>

      {itens.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground bg-muted/40">
                <tr>
                  <th className="text-left font-medium py-2 px-3">Produto</th>
                  <th className="text-left font-medium px-2">SKU</th>
                  <th className="text-right font-medium px-2 w-28">Qtd</th>
                  <th className="px-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {itens.map((it, i) => (
                  <tr key={`it-${it.ordem}-${i}`} className="border-t border-border/50">
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Thumb url={fotos?.[it.sku]} alt={it.titulo ?? it.sku} />
                        <div className="min-w-0">
                          <div className="truncate">{it.titulo ?? it.titulo_pdf ?? "—"}</div>
                          {!it.no_cadastro && <span className="text-[10px] text-amber-600">SKU fora do cadastro</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-2">
                      <Input
                        value={it.sku}
                        onChange={(e) => setSku(i, e.target.value)}
                        onBlur={() => void resolverSku(i)}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
                        title="Corrija o SKU se o PDF veio errado (ex.: SKU da Amazon)"
                        className={cn("h-8 w-28 font-mono text-xs", !it.no_cadastro && "border-amber-500")}
                      />
                    </td>
                    <td className="px-2 text-right">
                      <Input
                        value={it.qtd ?? ""}
                        onChange={(e) => setQtd(i, e.target.value)}
                        inputMode="numeric"
                        className={cn("h-8 w-20 text-right tabular-nums ml-auto", it.qtd == null && "border-amber-500")}
                      />
                    </td>
                    <td className="px-2 text-center">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => remover(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-t bg-card">
            <div className="text-sm">
              <span className="text-muted-foreground">Total: </span>
              <span className="font-semibold tabular-nums">{formatNumber(somaQtd)} un</span>
              {totalPdf != null && (
                <span className={cn("ml-2 text-xs", confere ? "text-emerald-600" : "text-amber-600")}>
                  {confere ? "✓ confere com o PDF" : `≠ PDF diz ${formatNumber(totalPdf)}`}
                </span>
              )}
            </div>
            <Button className="gap-2" onClick={() => void salvar()} disabled={salvando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Criar envio e separar
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function PackingEnvio({ envioId, onVoltar }: { envioId: string; onVoltar: () => void }) {
  const qc = useQueryClient();
  const [enviando, setEnviando] = useState(false);
  const [imprimindo, setImprimindo] = useState(false);
  const zplRef = useRef<HTMLInputElement>(null);

  const { data: impressoras = [] } = useImpressorasFF(true);
  const [printerId, setPrinterId] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem(STORAGE_PRINTER));
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined" && printerId > 0) {
      window.localStorage.setItem(STORAGE_PRINTER, String(printerId));
    }
  }, [printerId]);
  useEffect(() => {
    if (!impressoras.length) return;
    if (impressoras.some((p) => p.printer_id === printerId)) return;
    const conf = impressoras.find((p) => p.configurada);
    const online = impressoras.find((p) => p.estado === "online");
    setPrinterId((conf ?? online ?? impressoras[0]).printer_id);
  }, [impressoras, printerId]);

  const envioQ = useQuery({
    queryKey: ["fulfillment", "envio", envioId],
    queryFn: async (): Promise<Envio | null> => {
      const { data, error } = await supabaseExternal.from("fulfillment_envios").select("*").eq("id", envioId).single();
      if (error) throw error;
      return (data ?? null) as Envio | null;
    },
  });
  const itensQ = useQuery({
    queryKey: ["fulfillment", "envio-itens", envioId],
    queryFn: async (): Promise<EnvioItem[]> => {
      const { data, error } = await supabaseExternal
        .from("fulfillment_envio_itens").select("*").eq("envio_id", envioId).order("ordem", { ascending: true });
      if (error) throw error;
      return (data ?? []) as EnvioItem[];
    },
  });

  // Campos editáveis "dentro do envio": data agendada + observações + etapa.
  const [dataAg, setDataAg] = useState("");
  const [obs, setObs] = useState("");
  // Lançamento de estoque no Tiny + adição manual de item.
  const [lancandoEstoque, setLancandoEstoque] = useState(false);
  const [novoSku, setNovoSku] = useState("");
  const [novoQtd, setNovoQtd] = useState("");
  const [addingItem, setAddingItem] = useState(false);
  useEffect(() => {
    const e = envioQ.data;
    if (e) { setDataAg(e.data_envio_agendada ?? ""); setObs(e.observacao ?? ""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envioQ.data?.id]);

  async function salvarMeta(patch: Partial<Envio>) {
    const { error } = await supabaseExternal
      .from("fulfillment_envios")
      .update({ ...patch, atualizado_em: new Date().toISOString() })
      .eq("id", envioId);
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    qc.setQueryData<Envio | null>(["fulfillment", "envio", envioId], (o) => (o ? ({ ...o, ...patch } as Envio) : o));
    qc.invalidateQueries({ queryKey: ["fulfillment", "envios"] });
  }

  // Documentos anexados (DANFE, folha de envio, etiquetas...). PDFs pequenos em base64.
  const docsQ = useQuery({
    queryKey: ["fulfillment", "envio-docs", envioId],
    queryFn: async (): Promise<EnvioDoc[]> => {
      const { data, error } = await supabaseExternal
        .from("fulfillment_envio_docs")
        .select("id, tipo, nome, mime, tamanho, criado_em")
        .eq("envio_id", envioId)
        .order("criado_em", { ascending: false });
      if (error) throw error;
      return (data ?? []) as EnvioDoc[];
    },
  });
  const [tipoDoc, setTipoDoc] = useState("danfe");
  const [subindoDoc, setSubindoDoc] = useState(false);
  const docRef = useRef<HTMLInputElement>(null);
  const etiqPdfRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);
  const [subindoVarios, setSubindoVarios] = useState(false);

  async function subirDoc(file: File, tipoOverride?: string) {
    setSubindoDoc(true);
    try {
      const b64 = await fileToBase64(file);
      const { error } = await supabaseExternal.from("fulfillment_envio_docs").insert({
        envio_id: envioId, tipo: tipoOverride ?? tipoDoc, nome: file.name, mime: file.type || "application/pdf",
        tamanho: file.size, conteudo_base64: b64,
      });
      if (error) throw error;
      toast.success(`"${file.name}" anexado`);
      docsQ.refetch();
    } catch (e) {
      toast.error("Falha ao anexar", { description: (e as Error).message });
    } finally {
      setSubindoDoc(false);
    }
  }
  // Sobe VÁRIOS de uma vez, detectando o tipo de cada pelo nome do arquivo.
  async function subirVarios(files: File[]) {
    const arr = files.filter((f) => f && f.size > 0);
    if (arr.length === 0) return;
    setSubindoVarios(true);
    const resumo: Record<string, number> = {};
    try {
      for (const f of arr) {
        const tipo = detectarTipoDoc(f.name);
        try {
          const b64 = await fileToBase64(f);
          const { error } = await supabaseExternal.from("fulfillment_envio_docs").insert({
            envio_id: envioId, tipo, nome: f.name, mime: f.type || "application/pdf", tamanho: f.size, conteudo_base64: b64,
          });
          if (error) throw error;
          resumo[tipo] = (resumo[tipo] ?? 0) + 1;
        } catch (e) {
          toast.error(`Falha em "${f.name}"`, { description: (e as Error).message });
        }
      }
      const total = Object.values(resumo).reduce((a, b) => a + b, 0);
      const partes = Object.entries(resumo).map(([t, n]) => `${n} ${DOC_TIPO_LABEL[t] ?? t}`);
      if (total > 0) toast.success(`${total} documento(s) anexado(s)`, { description: partes.join(" · ") });
      docsQ.refetch();
    } finally {
      setSubindoVarios(false);
    }
  }
  async function atualizarTipoDoc(id: string, tipo: string) {
    const { error } = await supabaseExternal.from("fulfillment_envio_docs").update({ tipo }).eq("id", id);
    if (error) { toast.error("Falha ao mudar o tipo", { description: error.message }); return; }
    docsQ.refetch();
  }
  async function abrirDoc(d: EnvioDoc) {
    try {
      const { data, error } = await supabaseExternal
        .from("fulfillment_envio_docs").select("conteudo_base64, mime").eq("id", d.id).single();
      if (error || !data) throw error ?? new Error("não encontrado");
      const bin = atob(data.conteudo_base64 as string);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: (data.mime as string) || d.mime || "application/pdf" });
      const urlObj = URL.createObjectURL(blob);
      window.open(urlObj, "_blank");
      setTimeout(() => URL.revokeObjectURL(urlObj), 60_000);
    } catch (e) {
      toast.error("Falha ao abrir", { description: (e as Error).message });
    }
  }
  async function excluirDoc(d: EnvioDoc) {
    if (!window.confirm(`Excluir "${d.nome ?? "documento"}"?`)) return;
    const { error } = await supabaseExternal.from("fulfillment_envio_docs").delete().eq("id", d.id);
    if (error) { toast.error("Falha ao excluir", { description: error.message }); return; }
    docsQ.refetch();
  }

  const itens = itensQ.data ?? [];
  const { data: fotos } = useFotos(itens.map((i) => i.sku));
  const plan = itens.reduce((s, i) => s + i.qtd_planejada, 0);
  const sep = itens.reduce((s, i) => s + i.qtd_separada, 0);
  const tudoSeparado = plan > 0 && sep >= plan;

  const zplPorSku = useMemo(() => dividirZplPorSku(envioQ.data?.etiquetas_zpl), [envioQ.data?.etiquetas_zpl]);
  const [imprimindoSku, setImprimindoSku] = useState<string | null>(null);

  async function imprimirSku(sku: string | null, qty: number) {
    if (!sku) return;
    const bloco = zplPorSku.get(sku);
    if (!bloco) {
      toast.warning("Não há etiqueta deste SKU no arquivo anexado.");
      return;
    }
    if (!printerId) {
      toast.warning("Escolha a impressora.");
      return;
    }
    if (qty <= 0) return;
    const imp = impressoras.find((p) => p.printer_id === printerId);
    if (!window.confirm(`Imprimir ${qty} etiqueta(s) do SKU ${sku} na ${imp?.nome ?? `impressora ${printerId}`}?`)) return;
    setImprimindoSku(sku);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
        body: { modulo: "imprimir", zpl: comQuantidadeZpl(bloco, qty), printer_id: printerId, title: `Etiqueta ${sku}` },
      });
      if (error) throw new Error(error.message);
      if (!(data as { ok?: boolean })?.ok) throw new Error(JSON.stringify((data as { resposta?: unknown })?.resposta ?? data));
      toast.success(`Enviado à impressora · ${qty} etiqueta(s) do SKU ${sku}`);
    } catch (e) {
      toast.error("Falha ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindoSku(null);
    }
  }

  async function setSeparada(item: EnvioItem, novo: number) {
    // Sem teto no planejado: a quantidade EMBALADA pode diferir/exceder o
    // planejado (é ela que vira estoque no Tiny).
    const clamped = Math.max(0, novo);
    const conferido = clamped >= item.qtd_planejada;
    qc.setQueryData<EnvioItem[]>(["fulfillment", "envio-itens", envioId], (old) =>
      (old ?? []).map((r) => (r.id === item.id ? { ...r, qtd_separada: clamped, conferido } : r)),
    );
    const { error } = await supabaseExternal
      .from("fulfillment_envio_itens")
      .update({ qtd_separada: clamped, conferido })
      .eq("id", item.id);
    if (error) {
      toast.error("Falha ao salvar", { description: error.message });
      itensQ.refetch();
    }
  }

  // Corrige o SKU de um item já criado (ex.: PDF da Amazon veio com o SKU
  // errado). Preserva o SKU original em sku_origem, re-resolve o título pelo
  // cadastro e persiste. Update otimista. A foto re-resolve sozinha (useFotos).
  async function trocarSku(item: EnvioItem, novoSkuRaw: string) {
    const novoSku = (novoSkuRaw ?? "").trim();
    if (!novoSku || novoSku === item.sku) return;
    const { data: prod } = await supabaseExternal
      .from("produtos").select("nome, id_tiny").eq("sku", novoSku).maybeSingle();
    const nome = (prod as { nome?: string } | null)?.nome ?? null;
    const origem = item.sku_origem ?? item.sku;
    const titulo = nome ?? item.titulo;
    qc.setQueryData<EnvioItem[]>(["fulfillment", "envio-itens", envioId], (old) =>
      (old ?? []).map((r) => (r.id === item.id ? { ...r, sku: novoSku, sku_origem: origem, titulo } : r)),
    );
    const { error } = await supabaseExternal
      .from("fulfillment_envio_itens")
      .update({ sku: novoSku, sku_origem: origem, titulo })
      .eq("id", item.id);
    if (error) {
      toast.error("Falha ao trocar o SKU", { description: error.message });
      itensQ.refetch();
      return;
    }
    if (!prod) toast.warning(`SKU ${novoSku} não está no cadastro — trocado assim mesmo (sem id_tiny não lança estoque).`);
    else if (!(prod as { id_tiny?: number }).id_tiny) toast.warning(`SKU ${novoSku} sem id_tiny — não será lançado no estoque.`);
    else toast.success(`SKU alterado para ${novoSku}.`);
  }

  async function marcarEnviado() {
    setEnviando(true);
    try {
      const { error } = await supabaseExternal
        .from("fulfillment_envios")
        .update({ status: "enviado", atualizado_em: new Date().toISOString() })
        .eq("id", envioId);
      if (error) throw error;
      toast.success("Envio marcado como enviado ✈️");
      onVoltar();
    } catch (e) {
      toast.error("Erro ao marcar enviado", { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }

  // Adiciona um item manual ao envio (SKU + qtd). Busca título no cadastro; a
  // qtd entra como planejada E separada (é um item que você decidiu embalar).
  async function addItemManual() {
    const sku = novoSku.trim();
    const qtd = Math.max(0, parseInt(novoQtd, 10) || 0);
    if (!sku) { toast.warning("Informe o SKU."); return; }
    if (qtd <= 0) { toast.warning("Informe uma quantidade > 0."); return; }
    setAddingItem(true);
    try {
      const { data: prod } = await supabaseExternal
        .from("produtos").select("sku, nome, id_tiny").eq("sku", sku).maybeSingle();
      const ordemMax = itens.reduce((m, i) => Math.max(m, i.ordem ?? 0), 0);
      const { error } = await supabaseExternal.from("fulfillment_envio_itens").insert({
        envio_id: envioId,
        sku,
        titulo: (prod as { nome?: string } | null)?.nome ?? null,
        qtd_planejada: qtd,
        qtd_separada: qtd,
        conferido: true,
        ordem: ordemMax + 1,
      });
      if (error) throw error;
      if (!prod) toast.warning(`SKU ${sku} não está no cadastro — adicionado mesmo assim (sem id_tiny não lança estoque).`);
      else if (!(prod as { id_tiny?: number }).id_tiny) toast.warning(`SKU ${sku} sem id_tiny — não será lançado no estoque.`);
      else toast.success(`Item ${sku} adicionado (${qtd} un).`);
      setNovoSku(""); setNovoQtd("");
      itensQ.refetch();
    } catch (e) {
      toast.error("Falha ao adicionar item", { description: (e as Error).message });
    } finally {
      setAddingItem(false);
    }
  }

  // Lança o EMBALADO (qtd_separada) no Tiny: transferência Geral → depósito Full
  // do marketplace. Faz preview (dry) primeiro e pede confirmação com o plano.
  async function lancarEstoque() {
    setLancandoEstoque(true);
    try {
      const { data: prev, error: e1 } = await supabaseExternal.functions.invoke("fulfillment-estoque", {
        body: { modulo: "preview", envio_id: envioId },
      });
      if (e1) throw new Error(e1.message);
      const pv = prev as {
        plano?: Array<{ sku: string; embalado: number; entrada_full: number }>;
        avisos?: Array<{ sku: string; motivo: string }>;
        deposito_full?: { nome: string };
        ja_lancado_em?: string | null;
      };
      const plano = pv?.plano ?? [];
      const avisos = pv?.avisos ?? [];
      if (plano.length === 0) {
        toast.info("Nada a lançar", {
          description: pv?.ja_lancado_em
            ? "Estoque deste envio já foi lançado."
            : "Nenhum item com quantidade embalada pendente (ou sem id_tiny).",
        });
        return;
      }
      const totalUn = plano.reduce((s, it) => s + (it.entrada_full || 0), 0);
      const linhas = plano.map((it) => `• ${it.sku} — ${it.embalado} un`).join("\n");
      const avisoTxt = avisos.length
        ? `\n\nIgnorados:\n${avisos.map((a) => `• ${a.sku}: ${a.motivo}`).join("\n")}`
        : "";
      const msg =
        `Lançar estoque no Tiny para o envio ${envio?.numero ?? ""}?\n\n` +
        `Transferência Geral → ${pv?.deposito_full?.nome}:\n${linhas}\n\n` +
        `Total: ${totalUn} un em ${plano.length} SKU(s). A mesma quantidade é baixada do Geral.` +
        `${avisoTxt}\n\nGrava no Tiny e não tem desfazer automático.`;
      if (!window.confirm(msg)) return;

      const { data: res, error: e2 } = await supabaseExternal.functions.invoke("fulfillment-estoque", {
        body: { modulo: "lancar", envio_id: envioId, confirmar: 1, forcar: 1, lancado_por: "app" },
      });
      if (e2) throw new Error(e2.message);
      const r = res as { ok?: boolean; movimentos?: number; erros?: string[] };
      if (r?.ok) toast.success(`Estoque lançado · ${r.movimentos} movimento(s) no Tiny`);
      else toast.error("Lançamento com erros", { description: (r?.erros ?? []).slice(0, 3).join(" | ") });
      envioQ.refetch();
    } catch (e) {
      toast.error("Falha ao lançar estoque", { description: (e as Error).message });
    } finally {
      setLancandoEstoque(false);
    }
  }

  async function anexarEtiquetas(file: File) {
    try {
      const txt = await file.text();
      const { error } = await supabaseExternal
        .from("fulfillment_envios")
        .update({ etiquetas_zpl: txt, atualizado_em: new Date().toISOString() })
        .eq("id", envioId);
      if (error) throw error;
      toast.success(`Etiquetas anexadas · ${contarCopiasZpl(txt)} etiquetas`);
      envioQ.refetch();
    } catch (e) {
      toast.error("Falha ao anexar etiquetas", { description: (e as Error).message });
    }
  }

  async function imprimirEtiquetas() {
    const zpl = envioQ.data?.etiquetas_zpl;
    if (!zpl) {
      toast.warning("Este envio não tem etiquetas anexadas.");
      return;
    }
    if (!printerId) {
      toast.warning("Escolha a impressora.");
      return;
    }
    const copias = contarCopiasZpl(zpl);
    const imp = impressoras.find((p) => p.printer_id === printerId);
    if (!window.confirm(`Imprimir ${copias} etiquetas na ${imp?.nome ?? `impressora ${printerId}`}?`)) return;
    setImprimindo(true);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
        body: { modulo: "imprimir", zpl, printer_id: printerId, title: `Etiquetas ${envioQ.data?.numero ?? envioId}` },
      });
      if (error) throw new Error(error.message);
      if (!(data as { ok?: boolean })?.ok) {
        throw new Error(JSON.stringify((data as { resposta?: unknown })?.resposta ?? data));
      }
      toast.success(`Enviado à impressora · ${copias} etiquetas`);
    } catch (e) {
      toast.error("Falha ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindo(false);
    }
  }

  const envio = envioQ.data;
  const temEtiquetas = !!envio?.etiquetas_zpl;
  const st = envio ? stageDe(envio.status) : null;

  async function excluirEnvio() {
    const rotulo = envio?.numero ? `#${envio.numero}` : "";
    if (!window.confirm(`Excluir o envio ${rotulo}? Remove também os itens e documentos anexados. Não dá para desfazer.`)) return;
    try {
      await supabaseExternal.from("fulfillment_envio_docs").delete().eq("envio_id", envioId);
      await supabaseExternal.from("fulfillment_envio_itens").delete().eq("envio_id", envioId);
      const { error } = await supabaseExternal.from("fulfillment_envios").delete().eq("id", envioId);
      if (error) throw error;
      toast.success("Envio excluído");
      qc.invalidateQueries({ queryKey: ["fulfillment", "envios"] });
      qc.invalidateQueries({ queryKey: ["fulfillment", "envios-progresso"] });
      onVoltar();
    } catch (e) {
      toast.error("Falha ao excluir", { description: (e as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="gap-1 -ml-2" onClick={onVoltar}>
          <ChevronLeft className="h-4 w-4" /> Voltar
        </Button>
        {envio && (
          <div className="flex items-center gap-2 min-w-0">
            <span aria-hidden className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: MKT_COLOR[envio.marketplace] ?? "#888" }} />
            <h2 className="text-lg font-semibold truncate">{envio.numero ? `#${envio.numero}` : "Envio"}</h2>
            {st && <Badge variant="secondary" className={st.cls}>{st.curto}</Badge>}
            <span className="text-sm text-muted-foreground truncate">
              {MKT_LABEL[envio.marketplace] ?? envio.marketplace}
              {envio.centro ? ` · ${envio.centro}` : ""}
            </span>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 ml-auto text-muted-foreground hover:text-destructive"
          onClick={() => void excluirEnvio()}
        >
          <Trash2 className="h-4 w-4" /> Excluir envio
        </Button>
      </div>

      {envio && (
        <Card className="p-3 grid gap-3 sm:grid-cols-[190px_180px_1fr] items-start">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Etapa</label>
            <select
              className="h-9 w-full rounded-md border bg-card px-2 text-sm"
              value={stageDe(envio.status).id}
              onChange={(ev) => void salvarMeta({ status: ev.target.value })}
            >
              {STAGES.map((s) => <option key={s.id} value={s.id}>{s.curto}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground flex items-center gap-1"><CalendarClock className="h-3 w-3" /> Data de envio agendada</label>
            <Input
              type="date"
              value={dataAg}
              onChange={(ev) => setDataAg(ev.target.value)}
              onBlur={() => { if ((envio.data_envio_agendada ?? "") !== dataAg) void salvarMeta({ data_envio_agendada: dataAg || null }); }}
              className="h-9"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Observações</label>
            <textarea
              rows={2}
              value={obs}
              onChange={(ev) => setObs(ev.target.value)}
              onBlur={() => { if ((envio.observacao ?? "") !== obs) void salvarMeta({ observacao: obs || null }); }}
              placeholder="Transportadora, nº de volumes, pendências, etc."
              className="w-full rounded-md border bg-card px-2 py-1.5 text-sm resize-y min-h-[38px]"
            />
          </div>
        </Card>
      )}

      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <FileText className="h-4 w-4" /> Documentos
            {docsQ.data && docsQ.data.length > 0 && <span className="text-muted-foreground font-normal">({docsQ.data.length})</span>}
          </h3>
          <div className="flex items-center gap-2">
            <select className="h-8 rounded-md border bg-card px-2 text-xs" value={tipoDoc} onChange={(e) => setTipoDoc(e.target.value)}>
              {DOC_TIPOS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <input
              ref={docRef}
              type="file"
              accept="application/pdf,.pdf,image/*"
              multiple
              className="hidden"
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.currentTarget.value = ""; if (fs.length) void subirVarios(fs); }}
            />
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={subindoDoc || subindoVarios} onClick={() => docRef.current?.click()}>
              {subindoDoc || subindoVarios ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Anexar PDFs
            </Button>
          </div>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); if (!arrastando) setArrastando(true); }}
          onDragLeave={() => setArrastando(false)}
          onDrop={(e) => { e.preventDefault(); setArrastando(false); const fs = Array.from(e.dataTransfer.files ?? []); if (fs.length) void subirVarios(fs); }}
          onClick={() => docRef.current?.click()}
          className={`rounded-md border border-dashed p-3 text-center text-xs cursor-pointer transition-colors ${arrastando ? "border-primary bg-primary/5 text-primary" : "text-muted-foreground hover:bg-muted/40"}`}
        >
          {subindoVarios
            ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Anexando e identificando…</span>
            : "Arraste todos os documentos aqui de uma vez — o sistema identifica cada um (DANFE, etiquetas, folha de envio, preparação…)"}
        </div>
        {docsQ.data && docsQ.data.length > 0 ? (
          <div className="divide-y">
            {docsQ.data.map((d) => (
              <div key={d.id} className="flex items-center gap-2 py-1.5 text-sm">
                <select value={d.tipo} onChange={(e) => void atualizarTipoDoc(d.id, e.target.value)}
                  title="Tipo detectado — corrija aqui se errou"
                  className="h-6 rounded border bg-card px-1 text-[10px] shrink-0 max-w-[150px]">
                  {DOC_TIPOS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  {!DOC_TIPO_LABEL[d.tipo] && <option value={d.tipo}>{d.tipo}</option>}
                </select>
                <span className="truncate flex-1">{d.nome ?? "documento"}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{d.tamanho ? `${Math.round(d.tamanho / 1024)} KB` : ""}</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void abrirDoc(d)}>Abrir</Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void excluirDoc(d)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Nenhum documento. Anexe a DANFE, a folha de envio, as etiquetas...</p>
        )}
      </Card>

      <Card className="p-4 space-y-2 sticky top-2 z-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Separado: </span>
            <span className="font-semibold tabular-nums">{formatNumber(sep)} / {formatNumber(plan)} un</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={zplRef}
              type="file"
              accept=".txt,.zpl,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.currentTarget.value = "";
                if (f) void anexarEtiquetas(f);
              }}
            />
            {temEtiquetas ? (
              <>
                <Select value={printerId ? String(printerId) : undefined} onValueChange={(v) => setPrinterId(Number(v))}>
                  <SelectTrigger className="h-9 w-[240px] text-xs">
                    <SelectValue placeholder="Impressora" />
                  </SelectTrigger>
                  <SelectContent>
                    {impressoras.map((p) => (
                      <SelectItem key={p.printer_id} value={String(p.printer_id)}>
                        <span className="flex items-center gap-1.5">
                          {p.configurada && <span className="text-emerald-600">★</span>}
                          <span>{p.nome} — {p.computador}</span>
                          <span className={p.estado === "online" ? "text-emerald-600" : "text-amber-600"}>({p.estado})</span>
                          <span className="font-mono text-[10px] text-muted-foreground">ID {p.printer_id}</span>
                        </span>
                      </SelectItem>
                    ))}
                    {impressoras.length === 0 && (
                      <SelectItem value="_" disabled>Nenhuma ZD220</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="gap-2 h-9" onClick={() => void imprimirEtiquetas()} disabled={imprimindo}>
                  {imprimindo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                  Imprimir etiquetas ({contarCopiasZpl(envio?.etiquetas_zpl)})
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" className="gap-2 h-9" onClick={() => zplRef.current?.click()}>
                <Printer className="h-4 w-4" /> Subir etiquetas (ZPL)
              </Button>
            )}
            <input
              ref={etiqPdfRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void subirDoc(f, "etiqueta_produto"); }}
            />
            <Button variant="outline" size="sm" className="gap-2 h-9" disabled={subindoDoc} onClick={() => etiqPdfRef.current?.click()}
              title="Amazon só deixa baixar a etiqueta de produtos em PDF. Suba aqui; imprima abrindo o PDF (Ctrl+P).">
              {subindoDoc ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              Etiqueta de produtos (PDF)
            </Button>
            <Button
              size="sm"
              className="gap-2 h-9"
              variant={tudoSeparado ? "default" : "outline"}
              disabled={enviando || envio?.status === "enviado"}
              onClick={() => void marcarEnviado()}
            >
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {envio?.status === "enviado" ? "Enviado" : "Marcar enviado"}
            </Button>
            {sep > 0 && (
              <Button
                size="sm"
                variant={envio?.estoque_lancado_em ? "outline" : "default"}
                className="gap-2 h-9"
                disabled={lancandoEstoque}
                onClick={() => void lancarEstoque()}
                title={
                  envio?.estoque_lancado_em
                    ? `Estoque lançado em ${format(parseISO(envio.estoque_lancado_em), "dd/MM/yyyy HH:mm")}`
                    : "Lança o EMBALADO no depósito Full do Tiny (transferência do Geral). Pode lançar parcial; relança só o que faltar."
                }
              >
                {lancandoEstoque ? <Loader2 className="h-4 w-4 animate-spin" /> : <Warehouse className="h-4 w-4" />}
                {envio?.estoque_lancado_em ? "Estoque lançado ✓" : "Lançar estoque no Tiny"}
              </Button>
            )}
          </div>
          {(() => {
            const etiqProd = (docsQ.data ?? []).filter((d) => d.tipo === "etiqueta_produto");
            if (etiqProd.length === 0) return null;
            return (
              <div className="mt-2 rounded-md border bg-muted/40 p-2 space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" /> Etiquetas de produtos (PDF)</div>
                {etiqProd.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 text-sm">
                    <span className="truncate flex-1">{d.nome ?? "etiqueta.pdf"}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{d.tamanho ? `${Math.round(d.tamanho / 1024)} KB` : ""}</span>
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => void abrirDoc(d)}><Printer className="h-3.5 w-3.5" /> Abrir / imprimir</Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void excluirDoc(d)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <Barra valor={sep} total={plan} />
      </Card>

      <Card className="p-3 flex flex-wrap items-end gap-2">
        <div className="text-sm font-medium mr-1 self-center">Adicionar item</div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">SKU</label>
          <Input
            value={novoSku}
            onChange={(e) => setNovoSku(e.target.value)}
            placeholder="ex.: 15984"
            className="h-9 w-40"
            onKeyDown={(e) => { if (e.key === "Enter") void addItemManual(); }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground">Qtd</label>
          <Input
            value={novoQtd}
            onChange={(e) => setNovoQtd(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            placeholder="0"
            className="h-9 w-24 text-center tabular-nums"
            onKeyDown={(e) => { if (e.key === "Enter") void addItemManual(); }}
          />
        </div>
        <Button size="sm" className="h-9 gap-1.5" disabled={addingItem} onClick={() => void addItemManual()}>
          {addingItem ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Adicionar
        </Button>
        <span className="text-[11px] text-muted-foreground self-center">
          A quantidade entra como embalada (é o que vira estoque no lançamento).
        </span>
      </Card>

      {itensQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {itens.map((it) => (
            <CardItemPacking
              key={it.id}
              it={it}
              url={it.sku ? fotos?.[it.sku] : undefined}
              onSet={(novo) => void setSeparada(it, novo)}
              onTrocarSku={(novo) => void trocarSku(it, novo)}
              temEtiqueta={!!it.sku && zplPorSku.has(it.sku)}
              imprimindo={imprimindoSku === it.sku}
              onImprimir={(qty) => void imprimirSku(it.sku, qty)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Card de item no packing: contador com +/− E campo digitável (o operador pode
// bater a quantidade separada direto). Estado local do texto sincroniza com o
// valor persistido; commit no blur/Enter (clamp entre 0 e o planejado).
function CardItemPacking({
  it,
  url,
  onSet,
  onTrocarSku,
  temEtiqueta,
  imprimindo,
  onImprimir,
}: {
  it: EnvioItem;
  url?: string;
  onSet: (novo: number) => void;
  onTrocarSku: (novoSku: string) => void;
  temEtiqueta: boolean;
  imprimindo: boolean;
  onImprimir: (qty: number) => void;
}) {
  const [txt, setTxt] = useState(String(it.qtd_separada));
  useEffect(() => {
    setTxt(String(it.qtd_separada));
  }, [it.qtd_separada]);
  const [editSku, setEditSku] = useState(false);
  const [skuTxt, setSkuTxt] = useState(it.sku ?? "");
  useEffect(() => {
    setSkuTxt(it.sku ?? "");
  }, [it.sku]);
  const commitSku = () => {
    const v = skuTxt.trim();
    setEditSku(false);
    if (v && v !== (it.sku ?? "")) onTrocarSku(v);
    else setSkuTxt(it.sku ?? "");
  };
  const [qtdImp, setQtdImp] = useState(String(it.qtd_planejada));
  useEffect(() => {
    setQtdImp(String(it.qtd_planejada));
  }, [it.qtd_planejada]);

  const completo = it.qtd_planejada > 0 && it.qtd_separada >= it.qtd_planejada;
  const commit = () => {
    // Sem teto no planejado — o embalado pode exceder o previsto.
    const n = Math.max(0, parseInt(txt, 10) || 0);
    setTxt(String(n));
    if (n !== it.qtd_separada) onSet(n);
  };

  return (
    <Card className={cn("p-3 flex gap-3 transition-colors", completo && "border-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20")}>
      <div className="shrink-0">
        {url ? (
          <img
            src={url}
            alt={it.titulo ?? ""}
            loading="lazy"
            className="h-16 w-16 rounded object-cover bg-muted"
            onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
          />
        ) : (
          <div className="h-16 w-16 rounded bg-muted flex items-center justify-center">
            <PackageIcon className="h-6 w-6 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="text-sm font-medium leading-tight line-clamp-2">{it.titulo ?? "—"}</div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5 flex items-center gap-1">
          {editSku ? (
            <>
              <Input
                value={skuTxt}
                onChange={(e) => setSkuTxt(e.target.value)}
                autoFocus
                onBlur={commitSku}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === "Escape") { setSkuTxt(it.sku ?? ""); setEditSku(false); }
                }}
                className="h-6 w-24 font-mono text-xs px-1"
              />
              <Button variant="ghost" size="icon" className="h-6 w-6" onMouseDown={(e) => e.preventDefault()} onClick={commitSku} title="Confirmar SKU">
                <Check className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <>
              <span>SKU {it.sku ?? "—"}</span>
              <button type="button" onClick={() => setEditSku(true)} className="opacity-50 hover:opacity-100" title="Corrigir SKU (ex.: veio errado da Amazon)">
                <Pencil className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
        <div className="mt-auto flex items-center gap-1.5 pt-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onSet(it.qtd_separada - 1)} disabled={it.qtd_separada <= 0}>
            <Minus className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1 tabular-nums font-semibold">
            <Input
              value={txt}
              onChange={(e) => setTxt(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              }}
              inputMode="numeric"
              className="h-8 w-14 text-center tabular-nums px-1"
            />
            <span className="text-muted-foreground font-normal">/ {it.qtd_planejada}</span>
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onSet(it.qtd_separada + 1)}>
            <Plus className="h-4 w-4" />
          </Button>
          {completo ? (
            <span className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
              <Check className="h-4 w-4" /> OK
            </span>
          ) : (
            <Button variant="ghost" size="sm" className="ml-auto h-8 text-xs" onClick={() => onSet(it.qtd_planejada)}>
              completar
            </Button>
          )}
        </div>

        {/* Impressão de etiqueta deste produto, com quantidade escolhível */}
        <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-border/50">
          <span className="text-[11px] text-muted-foreground">Etiquetas:</span>
          <Input
            value={qtdImp}
            onChange={(e) => setQtdImp(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            disabled={!temEtiqueta}
            className="h-7 w-14 text-center tabular-nums px-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!temEtiqueta || imprimindo}
            title={temEtiqueta ? "Imprimir etiquetas deste produto" : "Anexe o arquivo de etiquetas do envio"}
            onClick={() => onImprimir(Math.max(1, parseInt(qtdImp, 10) || 0))}
          >
            {imprimindo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
            Imprimir
          </Button>
        </div>
      </div>
    </Card>
  );
}
