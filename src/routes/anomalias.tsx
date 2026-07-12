import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  AlertCircle,
  Search,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Package,
  Info,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

// ─────────────────────────────────────────────────────────────
// Types & config

interface AnomaliaRow {
  escopo: "pedido" | "produto";
  tipo: string;
  severidade: "alta" | "media";
  chave: string;
  marketplace: string | null;
  data_ref: string | null;
  descricao: string | null;
  receita: number | null;
  motivo: string | null;
}

type EscopoFilter = "todos" | "pedido" | "produto";
type SeveridadeFilter = "todas" | "alta" | "media";
type CanalFilter = "todos" | "shopee" | "mercadolivre" | "amazon";

const TIPO_LABELS: Record<string, string> = {
  sku_sem_custo: "SKUs cadastrados sem CMV",
  sku_sem_cadastro: "SKUs vendidos sem cadastro",
  sem_cmv: "Pedidos sem CMV",
  cmv_maior_que_receita: "Pedidos com custo maior que a venda",
  prejuizo_extremo: "Pedidos com prejuízo extremo",
  sem_recebido: "Pedidos sem repasse (+3 dias)",
  cmv_parcial: "Pedidos com CMV parcial",
  preco_abaixo_custo: "Produtos com preço abaixo do custo",
};

const TIPO_ACAO: Record<
  string,
  { label: string; to: string } | null
> = {
  sku_sem_custo: { label: "Cadastrar custo", to: "/produtos" },
  sku_sem_cadastro: { label: "Mapear SKU", to: "/mapeamento-skus" },
  preco_abaixo_custo: { label: "Ver produto", to: "/produtos-margem" },
  sem_cmv: { label: "Ver pedido", to: "/pedidos-integrados" },
  cmv_maior_que_receita: { label: "Ver pedido", to: "/pedidos-integrados" },
  prejuizo_extremo: { label: "Ver pedido", to: "/pedidos-integrados" },
  sem_recebido: { label: "Ver pedido", to: "/pedidos-integrados" },
  cmv_parcial: { label: "Ver pedido", to: "/pedidos-integrados" },
};

const PAGE_SIZE_GRUPO = 50;

// ─────────────────────────────────────────────────────────────
// Route

type SearchParams = {
  tipo?: string;
  severidade?: SeveridadeFilter;
};

export const Route = createFileRoute("/anomalias")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    tipo: typeof s.tipo === "string" ? s.tipo : undefined,
    severidade:
      s.severidade === "alta" || s.severidade === "media"
        ? s.severidade
        : undefined,
  }),
  component: AnomaliasPage,
});

function AnomaliasPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const [data, setData] = useState<AnomaliaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [escopo, setEscopo] = useState<EscopoFilter>("todos");
  const [severidade, setSeveridade] = useState<SeveridadeFilter>(
    search.severidade ?? "todas",
  );
  const [canal, setCanal] = useState<CanalFilter>("todos");
  const [busca, setBusca] = useState("");
  const [debounced, setDebounced] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(search.tipo ? [search.tipo] : []),
  );
  const [gruposPage, setGruposPage] = useState<Record<string, number>>({});

  useEffect(() => {
    const t = setTimeout(() => setDebounced(busca.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    (async () => {
      try {
        // A view já vem filtrada no banco por regras de anomalia — carregamos tudo (cap 10k por segurança)
        const { data: rows, error } = await supabaseExternal
          .from("view_anomalias")
          .select("*")
          .limit(10000);
        if (cancel) return;
        if (error) throw error;
        setData((rows ?? []) as AnomaliaRow[]);
      } catch (e) {
        if (!cancel) setErro(e instanceof Error ? e.message : "Erro desconhecido");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const filtered = useMemo(() => {
    return data.filter((r) => {
      if (escopo !== "todos" && r.escopo !== escopo) return false;
      if (severidade !== "todas" && r.severidade !== severidade) return false;
      if (canal !== "todos" && r.marketplace !== canal) return false;
      if (debounced) {
        const hay = `${r.chave} ${r.descricao ?? ""}`.toLowerCase();
        if (!hay.includes(debounced)) return false;
      }
      return true;
    });
  }, [data, escopo, severidade, canal, debounced]);

  const resumo = useMemo(() => {
    let alta = 0;
    let media = 0;
    let receita = 0;
    const produtos = new Set<string>();
    for (const r of filtered) {
      if (r.severidade === "alta") alta++;
      else if (r.severidade === "media") media++;
      receita += Number(r.receita ?? 0);
      if (r.escopo === "produto") produtos.add(r.chave);
    }
    return { alta, media, receita, produtos: produtos.size };
  }, [filtered]);

  const grupos = useMemo(() => {
    const map = new Map<
      string,
      {
        tipo: string;
        severidade: "alta" | "media";
        count: number;
        receita: number;
        rows: AnomaliaRow[];
      }
    >();
    for (const r of filtered) {
      const g = map.get(r.tipo) ?? {
        tipo: r.tipo,
        severidade: r.severidade,
        count: 0,
        receita: 0,
        rows: [],
      };
      g.count++;
      g.receita += Number(r.receita ?? 0);
      // severidade do grupo = pior severidade encontrada
      if (r.severidade === "alta") g.severidade = "alta";
      g.rows.push(r);
      map.set(r.tipo, g);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.severidade !== b.severidade) return a.severidade === "alta" ? -1 : 1;
      return b.receita - a.receita;
    });
  }, [filtered]);

  const toggle = (tipo: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tipo)) next.delete(tipo);
      else next.add(tipo);
      return next;
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Anomalias</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Estes registros ficam de fora dos totalizadores do Dashboard para não
            distorcer os números — mas continuam listados nas telas de origem.
            Corrigir os itens de severidade alta melhora a precisão da margem.
          </p>
        </header>

        {/* Cards de resumo */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ResumoCard
            label="Anomalias graves"
            value={formatNumber(resumo.alta)}
            tone="red"
            icon={AlertTriangle}
            loading={loading}
          />
          <ResumoCard
            label="Anomalias médias"
            value={formatNumber(resumo.media)}
            tone="amber"
            icon={AlertCircle}
            loading={loading}
          />
          <ResumoCard
            label="Receita afetada"
            value={formatBRL(resumo.receita, { compact: true })}
            tone="neutral"
            loading={loading}
            hint="Quanto de faturamento está fora dos totalizadores"
          />
          <ResumoCard
            label="Produtos a corrigir"
            value={formatNumber(resumo.produtos)}
            tone="neutral"
            icon={Package}
            loading={loading}
          />
        </section>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-2">
          <SegmentGroup
            value={escopo}
            onChange={(v) => setEscopo(v as EscopoFilter)}
            options={[
              { value: "todos", label: "Todos" },
              { value: "pedido", label: "Pedidos" },
              { value: "produto", label: "Produtos" },
            ]}
          />
          <SegmentGroup
            value={severidade}
            onChange={(v) => {
              setSeveridade(v as SeveridadeFilter);
              navigate({
                search: {
                  ...search,
                  severidade:
                    v === "todas" ? undefined : (v as "alta" | "media"),
                },
                replace: true,
              });
            }}
            options={[
              { value: "todas", label: "Todas" },
              { value: "alta", label: "Alta" },
              { value: "media", label: "Média" },
            ]}
          />
          <SegmentGroup
            value={canal}
            onChange={(v) => setCanal(v as CanalFilter)}
            options={[
              { value: "todos", label: "Todos canais" },
              { value: "shopee", label: "Shopee" },
              { value: "mercadolivre", label: "ML" },
              { value: "amazon", label: "Amazon" },
            ]}
          />
          <div className="relative ml-auto w-full max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar SKU, pedido ou produto…"
              className="pl-8 h-9 bg-card"
            />
          </div>
        </div>

        {erro && (
          <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
            Erro ao carregar anomalias: {erro}
          </Card>
        )}

        {/* Grupos */}
        <section className="flex flex-col gap-3">
          {loading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : grupos.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Nenhuma anomalia com esses filtros. ✅
            </Card>
          ) : (
            grupos.map((g) => {
              const isOpen = expanded.has(g.tipo);
              const page = gruposPage[g.tipo] ?? 1;
              const totalPages = Math.max(1, Math.ceil(g.rows.length / PAGE_SIZE_GRUPO));
              const paged = g.rows.slice(
                (page - 1) * PAGE_SIZE_GRUPO,
                page * PAGE_SIZE_GRUPO,
              );
              return (
                <Card key={g.tipo} className="overflow-hidden">
                  <button
                    onClick={() => toggle(g.tipo)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/40 transition text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span
                      className={cn(
                        "inline-block h-2 w-2 rounded-full shrink-0",
                        g.severidade === "alta"
                          ? "bg-red-500"
                          : "bg-amber-500",
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">
                        {formatNumber(g.count)}{" "}
                        <span className="text-muted-foreground font-normal">
                          — {TIPO_LABELS[g.tipo] ?? g.tipo}
                        </span>
                      </div>
                    </div>
                    <div className="text-sm tabular-nums text-muted-foreground shrink-0">
                      {formatBRL(g.receita, { compact: true })} afetados
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        g.severidade === "alta"
                          ? "border-red-500/40 text-red-700 dark:text-red-300 bg-red-500/10"
                          : "border-amber-500/40 text-amber-700 dark:text-amber-300 bg-amber-500/10",
                      )}
                    >
                      {g.severidade}
                    </Badge>
                  </button>

                  {isOpen && (
                    <div className="border-t">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/40 text-xs text-muted-foreground">
                            <tr>
                              <th className="text-left font-medium px-3 py-2">Chave</th>
                              <th className="text-left font-medium px-3 py-2">Descrição</th>
                              <th className="text-left font-medium px-3 py-2">Canal</th>
                              <th className="text-left font-medium px-3 py-2">Data</th>
                              <th className="text-right font-medium px-3 py-2">Receita</th>
                              <th className="text-left font-medium px-3 py-2">Motivo</th>
                              <th className="text-right font-medium px-3 py-2">Ação</th>
                            </tr>
                          </thead>
                          <tbody>
                            {paged.map((r, i) => {
                              const acao = TIPO_ACAO[r.tipo];
                              return (
                                <tr
                                  key={`${r.tipo}-${r.chave}-${i}`}
                                  className="border-t hover:bg-accent/30"
                                >
                                  <td className="px-3 py-2 font-mono text-xs">
                                    {r.chave}
                                  </td>
                                  <td className="px-3 py-2 max-w-[280px] truncate">
                                    {r.descricao ?? "—"}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-muted-foreground">
                                    {r.marketplace ?? "—"}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                    {r.data_ref
                                      ? new Date(
                                          r.data_ref + "T00:00:00",
                                        ).toLocaleDateString("pt-BR")
                                      : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {r.receita != null
                                      ? formatBRL(Number(r.receita))
                                      : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-[240px]">
                                    {r.motivo ?? "—"}
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    {acao ? (
                                      <Button
                                        asChild
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 text-xs gap-1"
                                      >
                                        <Link to={acao.to}>
                                          {acao.label}
                                          <ExternalLink className="h-3 w-3" />
                                        </Link>
                                      </Button>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {totalPages > 1 && (
                        <div className="flex items-center justify-between px-3 py-2 border-t bg-muted/20 text-xs">
                          <span className="text-muted-foreground">
                            Página {page} de {totalPages} · {formatNumber(g.rows.length)} ocorrências
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={page <= 1}
                              onClick={() =>
                                setGruposPage((p) => ({ ...p, [g.tipo]: page - 1 }))
                              }
                            >
                              Anterior
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={page >= totalPages}
                              onClick={() =>
                                setGruposPage((p) => ({ ...p, [g.tipo]: page + 1 }))
                              }
                            >
                              Próxima
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })
          )}
        </section>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="h-3 w-3" />
          <span>
            Os grupos vêm ordenados por severidade e receita afetada — o que mais
            impacta o resultado aparece primeiro.
          </span>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────
// Sub-components

function ResumoCard({
  label,
  value,
  tone,
  icon: Icon,
  loading,
  hint,
}: {
  label: string;
  value: string;
  tone: "red" | "amber" | "neutral";
  icon?: typeof AlertTriangle;
  loading?: boolean;
  hint?: string;
}) {
  const toneClasses =
    tone === "red"
      ? "text-red-600 dark:text-red-400"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {Icon && <Icon className={cn("h-4 w-4", toneClasses)} />}
      </div>
      {loading ? (
        <Skeleton className="h-7 w-20" />
      ) : (
        <div className={cn("text-2xl font-semibold tabular-nums", toneClasses)}>
          {value}
        </div>
      )}
      {hint && (
        <div className="text-[11px] text-muted-foreground mt-1">{hint}</div>
      )}
    </Card>
  );
}

function SegmentGroup({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "px-3 h-8 text-xs rounded-sm transition",
            value === o.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
