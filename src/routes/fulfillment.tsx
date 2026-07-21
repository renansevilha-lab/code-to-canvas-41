import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Warehouse,
  PackagePlus,
  Search,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { format, parseISO } from "date-fns";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
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
import { supabaseExternal } from "@/integrations/supabase/external-client";

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
type SubTab = "inventario" | "reposicao";

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
};

const rowKey = (r: { marketplace: string; sku: string }) => `${r.marketplace}|${r.sku}`;

// ─────────────────────────────────────────────────────────────────────────────
// Route

type SearchParams = { tab: SubTab; mkt: MktFiltro; q: string; somenteSugestao: boolean };

export const Route = createFileRoute("/fulfillment")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tab: s.tab === "inventario" ? "inventario" : "reposicao",
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
            </TabsList>

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
                      <td className="px-3 py-2 max-w-[320px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{r.produto ?? "—"}</span>
                          {r.eh_kit && (
                            <Badge variant="secondary" className="h-4 px-1 text-[10px] shrink-0">
                              kit
                            </Badge>
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-muted-foreground">{r.sku}</span>
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
  itens: { marketplace: string; sku: string; produto: string | null; quantidade: number }[];
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
                      <div className="min-w-0">
                        <div className="truncate">{i.produto ?? "—"}</div>
                        <span className="font-mono text-[11px] text-muted-foreground">{i.sku}</span>
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
                      <td className="px-3 py-2 max-w-[340px]">
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
