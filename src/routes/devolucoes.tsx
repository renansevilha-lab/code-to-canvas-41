import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Search, CheckCircle2, ExternalLink } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos / constantes

interface NotaCancelada {
  tiny_pedido_id: number;
  numero_pedido: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  data_pedido: string | null;
  valor_nf: number | null;
  numero_nf: string | null;
  serie_nf: string | null;
  data_emissao_nf: string | null;
  precisa_devolucao: boolean | null;
  devolucao_emitida: boolean | null;
}

const COLS =
  "tiny_pedido_id,numero_pedido,numero_ecommerce,marca_canal,data_pedido,valor_nf,numero_nf,serie_nf,data_emissao_nf,precisa_devolucao,devolucao_emitida";

const PAGE_SIZE = 50;

type Filtro = "todos" | "marcados" | "devolvidos";

// cor por marketplace (só visual — a lista tem vários canais)
function corCanal(canal: string | null | undefined): string {
  const c = (canal ?? "").toLowerCase();
  if (c.includes("shopee")) return "#EE4D2D";
  if (c.includes("mercado")) return "#FFE600";
  if (c.includes("amazon")) return "#232F3E";
  if (c.includes("magalu") || c.includes("magazine")) return "#0086FF";
  return "#94a3b8";
}

// ─────────────────────────────────────────────────────────────────────────────
// Route

type SearchParams = { pagina: number; q: string; filtro: Filtro };

export const Route = createFileRoute("/devolucoes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    pagina: Number.isFinite(Number(s.pagina)) ? Math.max(1, Math.floor(Number(s.pagina))) : 1,
    q: typeof s.q === "string" ? s.q : "",
    filtro: (["todos", "marcados", "devolvidos"].includes(s.filtro as string)
      ? (s.filtro as Filtro)
      : "todos"),
  }),
  component: DevolucoesPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Page

function DevolucoesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const page = search.pagina as number;
  const filtro = search.filtro as Filtro;
  const searchText = search.q as string;

  const [searchDraft, setSearchDraft] = useState(searchText);
  const [salvandoId, setSalvandoId] = useState<number | null>(null);

  const updateSearch = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  useEffect(() => setSearchDraft(searchText), [searchText]);
  useEffect(() => {
    const next = searchDraft.trim();
    if (next === searchText) return;
    const t = setTimeout(() => updateSearch({ q: next, pagina: 1 }), 250);
    return () => clearTimeout(t);
  }, [searchDraft, searchText]);

  const listKey = ["devolucoes", "lista", page, filtro, searchText] as const;

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;
      let q = supabaseExternal
        .from("notas_cancelados")
        .select(COLS, { count: "exact" })
        .eq("finalidade_nf", "1")
        .not("id_nota_fiscal", "is", null);
      if (filtro === "marcados") q = q.eq("precisa_devolucao", true);
      else if (filtro === "devolvidos") q = q.eq("devolucao_emitida", true);
      if (searchText) {
        const esc = searchText.replace(/[,%()]/g, " ").trim();
        if (esc) {
          q = q.or(
            `numero_pedido.ilike.%${esc}%,numero_ecommerce.ilike.%${esc}%,numero_nf.ilike.%${esc}%`,
          );
        }
      }
      q = q.order("data_emissao_nf", { ascending: false, nullsFirst: false }).range(start, end);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as unknown as NotaCancelada[], count: count ?? 0 };
    },
  });

  const rows = listQuery.data?.rows ?? [];
  const total = listQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Marcar/desmarcar precisa_devolucao — grava no banco, com atualização otimista.
  async function toggleDevolucao(row: NotaCancelada, valor: boolean) {
    setSalvandoId(row.tiny_pedido_id);
    // otimista
    queryClient.setQueryData(listKey, (old: { rows: NotaCancelada[]; count: number } | undefined) =>
      old
        ? {
            ...old,
            rows: old.rows.map((r) =>
              r.tiny_pedido_id === row.tiny_pedido_id ? { ...r, precisa_devolucao: valor } : r,
            ),
          }
        : old,
    );
    const { error } = await supabaseExternal
      .from("notas_cancelados")
      .update({ precisa_devolucao: valor })
      .eq("tiny_pedido_id", row.tiny_pedido_id);
    setSalvandoId(null);
    if (error) {
      // reverte
      queryClient.setQueryData(listKey, (old: { rows: NotaCancelada[]; count: number } | undefined) =>
        old
          ? {
              ...old,
              rows: old.rows.map((r) =>
                r.tiny_pedido_id === row.tiny_pedido_id ? { ...r, precisa_devolucao: !valor } : r,
              ),
            }
          : old,
      );
      toast.error("Não foi possível salvar", { description: error.message });
    }
  }

  const goToPage = (n: number) => updateSearch({ pagina: Math.max(1, Math.min(totalPages, n)) });

  const error = (listQuery.error as Error | null)?.message ?? null;
  const loading = listQuery.isLoading;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <RotateCcw className="h-6 w-6" /> Devolução de Pedidos
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pedidos cancelados que tiveram NF de venda emitida. Marque quais precisam de nota de
          devolução.
        </p>
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <FiltroSegment value={filtro} onChange={(f) => updateSearch({ filtro: f, pagina: 1 })} />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Buscar por pedido, order_sn ou NF..."
            className="pl-8 h-9 bg-card"
          />
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {error}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-sm font-semibold">
            Pedidos cancelados com NF{" "}
            <span className="text-muted-foreground font-normal">({total})</span>
          </h3>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-center font-medium px-3 py-2 w-24">Devolver?</th>
                <th className="text-left font-medium px-3 py-2">Pedido</th>
                <th className="text-left font-medium px-3 py-2">Order / e-commerce</th>
                <th className="text-left font-medium px-3 py-2">Canal</th>
                <th className="text-left font-medium px-3 py-2">Data</th>
                <th className="text-right font-medium px-3 py-2">Valor NF</th>
                <th className="text-left font-medium px-3 py-2">NF</th>
                <th className="text-left font-medium px-3 py-2">Emissão</th>
                <th className="text-center font-medium px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={9} className="px-3 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhum pedido cancelado com NF nesta visão.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const devolvido = r.devolucao_emitida === true;
                  return (
                    <tr
                      key={r.tiny_pedido_id}
                      className={cn(
                        "border-t hover:bg-accent/40 transition",
                        r.precisa_devolucao && "bg-amber-500/5",
                        devolvido && "opacity-60",
                      )}
                    >
                      <td className="px-3 py-2 text-center">
                        <Checkbox
                          checked={!!r.precisa_devolucao}
                          disabled={devolvido || salvandoId === r.tiny_pedido_id}
                          onCheckedChange={(c) => toggleDevolucao(r, c === true)}
                          aria-label="Marcar para devolução"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.numero_pedido ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground max-w-[200px] truncate">
                        {r.numero_ecommerce ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
                          <span
                            aria-hidden
                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: corCanal(r.marca_canal) }}
                          />
                          {r.marca_canal ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.data_pedido ? format(parseISO(r.data_pedido), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.valor_nf != null ? formatBRL(r.valor_nf) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {r.numero_nf ? `${r.numero_nf}${r.serie_nf ? ` / ${r.serie_nf}` : ""}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.data_emissao_nf ? format(parseISO(r.data_emissao_nf), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {devolvido ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] h-5 px-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 gap-1"
                          >
                            <CheckCircle2 className="h-3 w-3" /> devolvida
                          </Badge>
                        ) : r.precisa_devolucao ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] h-5 px-1.5 border-amber-500/40 text-amber-700 dark:text-amber-300"
                          >
                            a devolver
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
            <span className="text-muted-foreground">
              Página {page} de {totalPages} · {total} pedidos
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ExternalLink className="h-3 w-3" />
        Fase 1: identificação e marcação. A emissão da nota de devolução é feita no Tiny (fases
        seguintes).
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes

function FiltroSegment({ value, onChange }: { value: Filtro; onChange: (v: Filtro) => void }) {
  const opts: { id: Filtro; label: string }[] = [
    { id: "todos", label: "Todos" },
    { id: "marcados", label: "A devolver" },
    { id: "devolvidos", label: "Devolvidos" },
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
