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
  Loader2,
  Trash2,
  Send,
  Printer,
  FileText,
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

type MktFiltro = "todos" | "amazon" | "mercadolivre" | "shopee";
type SubTab = "inventario" | "reposicao" | "envios";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

const rowKey = (r: { marketplace: string; sku: string }) => `${r.marketplace}|${r.sku}`;

// Busca fotos (produtos.foto_capa) apenas dos SKUs visíveis, em lotes ≤300 para
// nunca esbarrar no corte de 1.000 linhas do PostgREST. É lookup de imagem por
// SKU interno, não agregação — join no cliente é adequado aqui.
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
          .from("produtos")
          .select("sku,foto_capa")
          .in("sku", lote);
        if (error) throw error;
        for (const r of (data ?? []) as { sku: string; foto_capa: string | null }[]) {
          if (r.foto_capa) map[r.sku] = r.foto_capa;
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
      <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <Warehouse className="h-6 w-6" /> Fulfillment
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Estoque nos centros de distribuição e sugestão de reposição (envios Full)
            </p>
          </div>
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
        </header>

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
    <div className="space-y-3">
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

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-10">
                  <Checkbox
                    checked={todasMarcadas}
                    onCheckedChange={(c) => marcarTodas(c === true)}
                    aria-label="Selecionar todos"
                  />
                </th>
                <th className="text-left font-medium px-3 py-2">Produto</th>
                <th className="text-left font-medium px-3 py-2">Canal</th>
                <th className="text-right font-medium px-3 py-2">Estoque CD</th>
                <th className="text-right font-medium px-3 py-2">Em trânsito</th>
                <th className="text-right font-medium px-3 py-2">Cobertura</th>
                <th className="text-right font-medium px-3 py-2">Necessidade</th>
                <th className="text-right font-medium px-3 py-2">Sugestão</th>
                <th className="text-right font-medium px-3 py-2">A enviar</th>
                <th className="text-right font-medium px-3 py-2">Estoque empresa</th>
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
                      <td className="px-3 py-2">
                        <MktDot marketplace={r.marketplace} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(num(r.estoque_full))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(num(r.em_transito))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <CoberturaPill dias={num(r.cobertura_atual_dias)} alvo={num(r.cobertura_alvo_dias)} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(num(r.necessidade))}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">
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

  if (error) {
    return (
      <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
        Erro ao carregar inventário: {error}
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <InvKpi label="Disponível" value={totais.sellable} loading={loading} />
        <InvKpi label="Reservado" value={totais.reserved} loading={loading} muted />
        <InvKpi label="Em trânsito" value={totais.inTransit} loading={loading} muted />
        <InvKpi label="Inutilizável" value={totais.unsellable} loading={loading} muted />
      </section>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-sm font-semibold">
            Estoque nos CDs{" "}
            <span className="text-muted-foreground font-normal">({formatNumber(filtradas.length)})</span>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Produto</th>
                <th className="text-left font-medium px-3 py-2">Canal</th>
                <th className="text-left font-medium px-3 py-2">CD</th>
                <th className="text-right font-medium px-3 py-2">Disponível</th>
                <th className="text-right font-medium px-3 py-2">Reservado</th>
                <th className="text-right font-medium px-3 py-2">Em trânsito</th>
                <th className="text-right font-medium px-3 py-2">Inutilizável</th>
                <th className="text-left font-medium px-3 py-2">Atualizado</th>
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
                      <td className="px-3 py-2">
                        <MktDot marketplace={r.marketplace} />
                      </td>
                      <td className="px-3 py-2 text-xs">{r.warehouse}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{formatNumber(num(r.sellable))}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(num(r.reserved))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {formatNumber(num(r.in_transit))}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
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
}: {
  label: string;
  value: number;
  loading: boolean;
  muted?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground font-medium">{label}</div>
      {loading ? (
        <Skeleton className="h-7 w-20 mt-2" />
      ) : (
        <div className={cn("text-xl font-semibold mt-1 tabular-nums", muted && "text-muted-foreground")}>
          {formatNumber(value)}
        </div>
      )}
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
  etiquetas_zpl: string | null;
  criado_por: string | null;
  criado_em: string;
  atualizado_em: string;
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
  ean: string | null;
  titulo: string | null;
  titulo_pdf: string | null;
  qtd: number | null;
  no_cadastro: boolean;
  tem_foto: boolean;
  ordem: number;
}

const STATUS_ENVIO: Record<string, { label: string; cls: string }> = {
  separando: { label: "Separando", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300" },
  enviado: { label: "Enviado", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300" },
  recebido: { label: "Recebido", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" },
  cancelado: { label: "Cancelado", cls: "bg-muted text-muted-foreground" },
};

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

  const envios = enviosQ.data ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground max-w-xl">
          Envios criados para os CDs. Suba o PDF de preparação do marketplace e separe pelos cards.
        </p>
        <Button size="sm" className="gap-1.5" onClick={() => setView("novo")}>
          <Plus className="h-4 w-4" /> Novo envio
        </Button>
      </div>

      {enviosQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : envios.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Nenhum envio ainda. Clique em <strong>Novo envio</strong> e suba o PDF de preparação.
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {envios.map((e) => {
            const p = progressoQ.data?.get(e.id);
            const st = STATUS_ENVIO[e.status] ?? STATUS_ENVIO.separando;
            return (
              <button key={e.id} type="button" onClick={() => setPackingId(e.id)} className="text-left">
                <Card className="p-4 space-y-3 hover:border-primary/40 transition-colors h-full">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span aria-hidden className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: MKT_COLOR[e.marketplace] ?? "#888" }} />
                      <div className="min-w-0">
                        <div className="font-semibold text-sm truncate">{e.numero ? `#${e.numero}` : "(sem número)"}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {MKT_LABEL[e.marketplace] ?? e.marketplace}
                          {e.empresa ? ` · ${e.empresa}` : ""}
                        </div>
                      </div>
                    </div>
                    <Badge variant="secondary" className={cn("shrink-0", st.cls)}>{st.label}</Badge>
                  </div>
                  {e.centro && <div className="text-xs text-muted-foreground truncate">📦 {e.centro}</div>}
                  <div className="space-y-1">
                    <Barra valor={p?.sep ?? 0} total={p?.plan ?? 0} />
                    <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                      <span>{formatNumber(p?.sep ?? 0)} / {formatNumber(p?.plan ?? e.total_unidades ?? 0)} un</span>
                      <span>{p?.itens ?? 0} itens</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground">{format(parseISO(e.criado_em), "dd/MM/yyyy HH:mm")}</div>
                </Card>
              </button>
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
      setItens(parsed);
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
        sku: it.sku,
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
                  <tr key={`${it.sku}-${i}`} className="border-t border-border/50">
                    <td className="py-1.5 px-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Thumb url={fotos?.[it.sku]} alt={it.titulo ?? it.sku} />
                        <div className="min-w-0">
                          <div className="truncate">{it.titulo ?? it.titulo_pdf ?? "—"}</div>
                          {!it.no_cadastro && <span className="text-[10px] text-amber-600">SKU fora do cadastro</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-2 font-mono text-xs">{it.sku}</td>
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

  const itens = itensQ.data ?? [];
  const { data: fotos } = useFotos(itens.map((i) => i.sku));
  const plan = itens.reduce((s, i) => s + i.qtd_planejada, 0);
  const sep = itens.reduce((s, i) => s + i.qtd_separada, 0);
  const tudoSeparado = plan > 0 && sep >= plan;

  async function setSeparada(item: EnvioItem, novo: number) {
    const clamped = Math.max(0, Math.min(novo, item.qtd_planejada));
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
  const st = envio ? STATUS_ENVIO[envio.status] ?? STATUS_ENVIO.separando : null;

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
            {st && <Badge variant="secondary" className={st.cls}>{st.label}</Badge>}
            <span className="text-sm text-muted-foreground truncate">
              {MKT_LABEL[envio.marketplace] ?? envio.marketplace}
              {envio.centro ? ` · ${envio.centro}` : ""}
            </span>
          </div>
        )}
      </div>

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
          </div>
        </div>
        <Barra valor={sep} total={plan} />
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
}: {
  it: EnvioItem;
  url?: string;
  onSet: (novo: number) => void;
}) {
  const [txt, setTxt] = useState(String(it.qtd_separada));
  useEffect(() => {
    setTxt(String(it.qtd_separada));
  }, [it.qtd_separada]);

  const completo = it.qtd_planejada > 0 && it.qtd_separada >= it.qtd_planejada;
  const commit = () => {
    const n = Math.max(0, Math.min(parseInt(txt, 10) || 0, it.qtd_planejada));
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
        <div className="text-xs text-muted-foreground font-mono mt-0.5">SKU {it.sku}</div>
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
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => onSet(it.qtd_separada + 1)} disabled={completo}>
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
      </div>
    </Card>
  );
}
