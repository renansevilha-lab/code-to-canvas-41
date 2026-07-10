import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DollarSign,
  TrendingUp,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ShoppingCart,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";

export const Route = createFileRoute("/amazon")({
  component: AmazonPage,
});

interface AmazonRow {
  pedido: string;
  data_pedido: string;
  status_pedido: string | null;
  logistica_tipo: string | null;
  uf: string | null;
  cidade: string | null;
  primeiro_produto: string | null;
  receita: number | null;
  taxa_comissao: number | null;
  taxa_fba: number | null;
  promocoes: number | null;
  imposto: number | null;
  recebido: number | null;
  cmv: number | null;
  margem: number | null;
  margem_pct: number | null;
  origem_margem: string | null;
  cmv_incompleto: boolean | null;
  cnpj: string | null;
}

type OrigemFilter = "todos" | "real" | "estimado" | "pendente";
type LogFilter = "todos" | "FBA" | "FBM";

function useAmazonRows() {
  return useQuery({
    queryKey: ["amazon", "view_amazon_dashboard"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_amazon_dashboard")
        .select("*")
        .order("data_pedido", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as AmazonRow[];
    },
  });
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function formatDateBR(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  } catch {
    return iso;
  }
}

function OrigemBadge({ origem }: { origem: string | null }) {
  if (origem === "real")
    return (
      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200">
        ✅ Real
      </Badge>
    );
  if (origem === "estimado")
    return (
      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 border-blue-200">
        ≈ Estimado
      </Badge>
    );
  return (
    <Badge variant="secondary" className="bg-muted text-muted-foreground">
      ⏳ Pendente
    </Badge>
  );
}

function LogisticaBadge({ tipo }: { tipo: string | null }) {
  if (tipo === "FBA")
    return (
      <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100 border-orange-200 text-[10px] px-1.5 py-0">
        FBA
      </Badge>
    );
  if (tipo === "FBM")
    return (
      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 border-blue-200 text-[10px] px-1.5 py-0">
        FBM
      </Badge>
    );
  return <span className="text-xs text-muted-foreground">—</span>;
}

function PercentBadge({ pct }: { pct: number | null }) {
  const v = num(pct);
  const cls =
    v > 15
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : v >= 0
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : "bg-red-100 text-red-800 border-red-200";
  return (
    <Badge className={cn("hover:opacity-90", cls)}>
      {formatPercent(v, 1)}
    </Badge>
  );
}

function AmazonPage() {
  const { data, isLoading, error } = useAmazonRows();
  const [origem, setOrigem] = useState<OrigemFilter>("todos");
  const [log, setLog] = useState<LogFilter>("todos");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const rows = data ?? [];

  const resumo = useMemo(() => {
    let receita = 0;
    let margem = 0;
    let margemReal = 0;
    let margemEst = 0;
    let liquidados = 0;
    let estimados = 0;
    let pctSum = 0;
    let pctN = 0;
    let negativos = 0;
    for (const r of rows) {
      receita += num(r.receita);
      margem += num(r.margem);
      if (r.origem_margem === "real") {
        margemReal += num(r.margem);
        liquidados++;
      } else if (r.origem_margem === "estimado") {
        margemEst += num(r.margem);
        estimados++;
      }
      if (typeof r.margem_pct === "number" && Number.isFinite(r.margem_pct)) {
        pctSum += r.margem_pct;
        pctN++;
      }
      if (num(r.margem) < 0) negativos++;
    }
    return {
      receita,
      margem,
      margemReal,
      margemEst,
      liquidados,
      estimados,
      margemMediaPct: pctN > 0 ? pctSum / pctN : 0,
      negativos,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (origem !== "todos" && r.origem_margem !== origem) return false;
      if (log !== "todos" && r.logistica_tipo !== log) return false;
      return true;
    });
  }, [rows, origem, log]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <TooltipProvider>
      <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-orange-500 to-amber-500 text-white">
            <ShoppingCart className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Amazon</h1>
            <p className="text-sm text-muted-foreground">
              Dashboard de pedidos e margem
            </p>
          </div>
        </div>

        {/* Cards resumo */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <ResumoCard
            icon={<DollarSign className="h-4 w-4" />}
            label="Receita Total"
            value={isLoading ? null : formatBRL(resumo.receita)}
            hint={`${formatNumber(rows.length)} pedidos`}
            color="text-blue-600 bg-blue-50"
          />
          <ResumoCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Margem Total"
            value={isLoading ? null : formatBRL(resumo.margem)}
            hint={`margem média ${formatPercent(resumo.margemMediaPct, 1)}`}
            color={
              resumo.margem >= 0
                ? "text-emerald-600 bg-emerald-50"
                : "text-red-600 bg-red-50"
            }
          />
          <ResumoCard
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Liquidados"
            value={isLoading ? null : formatNumber(resumo.liquidados)}
            hint={`margem real ${formatBRL(resumo.margemReal)}`}
            color="text-emerald-600 bg-emerald-50"
          />
          <ResumoCard
            icon={<Clock className="h-4 w-4" />}
            label="Estimados"
            value={isLoading ? null : formatNumber(resumo.estimados)}
            hint={`margem estimada ${formatBRL(resumo.margemEst)}`}
            color="text-blue-600 bg-blue-50"
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Margem <strong>"estimada"</strong> usa taxas médias por faixa de preço.
          Quando a Amazon liquida o repasse (alguns dias após o envio), a margem
          vira <strong>"real"</strong> com as taxas exatas.
        </p>

        {/* Filtros */}
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex gap-1 rounded-md border p-1 bg-muted/30">
            {(["todos", "real", "estimado", "pendente"] as OrigemFilter[]).map(
              (o) => (
                <Button
                  key={o}
                  size="sm"
                  variant={origem === o ? "default" : "ghost"}
                  onClick={() => {
                    setOrigem(o);
                    setPage(0);
                  }}
                  className="h-7 capitalize"
                >
                  {o}
                </Button>
              ),
            )}
          </div>
          <div className="flex gap-1 rounded-md border p-1 bg-muted/30">
            {(["todos", "FBA", "FBM"] as LogFilter[]).map((l) => (
              <Button
                key={l}
                size="sm"
                variant={log === l ? "default" : "ghost"}
                onClick={() => {
                  setLog(l);
                  setPage(0);
                }}
                className="h-7"
              >
                {l === "todos" ? "Todos" : l}
              </Button>
            ))}
          </div>
          <div className="text-xs text-muted-foreground ml-auto">
            {formatNumber(filtered.length)} pedidos
          </div>
        </div>

        {/* Alerta margens negativas */}
        {resumo.negativos > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4" />
            <span>
              <strong>{resumo.negativos} pedidos</strong> com margem negativa —
              revisar preço ou custo
            </span>
          </div>
        )}

        {/* Tabela */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead>Log.</TableHead>
                  <TableHead className="max-w-[280px]">Produto</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">Comissão</TableHead>
                  <TableHead className="text-right">FBA</TableHead>
                  <TableHead className="text-right">Recebido</TableHead>
                  <TableHead className="text-right">CMV</TableHead>
                  <TableHead className="text-right">Margem</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead>Origem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={12}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {error && (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center text-red-600 py-8">
                      Erro ao carregar: {(error as Error).message}
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && !error && pageRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                      Nenhum pedido encontrado
                    </TableCell>
                  </TableRow>
                )}
                {pageRows.map((r) => {
                  const margem = num(r.margem);
                  const margemCls =
                    margem > 0
                      ? "text-emerald-700 font-medium"
                      : margem < 0
                        ? "text-red-700 font-medium"
                        : "text-muted-foreground";
                  return (
                    <TableRow key={r.pedido}>
                      <TableCell className="font-mono text-xs">{r.pedido}</TableCell>
                      <TableCell className="text-xs">{formatDateBR(r.data_pedido)}</TableCell>
                      <TableCell>
                        <LogisticaBadge tipo={r.logistica_tipo} />
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate text-xs" title={r.primeiro_produto ?? ""}>
                        {r.primeiro_produto ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatBRL(num(r.receita))}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatBRL(num(r.taxa_comissao))}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {formatBRL(num(r.taxa_fba))}
                      </TableCell>
                      <TableCell className="text-right text-xs">{formatBRL(num(r.recebido))}</TableCell>
                      <TableCell className="text-right text-xs">{formatBRL(num(r.cmv))}</TableCell>
                      <TableCell className={cn("text-right text-xs", margemCls)}>
                        <div className="flex items-center justify-end gap-1">
                          {r.cmv_incompleto && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              </TooltipTrigger>
                              <TooltipContent>
                                CMV incompleto — margem pode estar inflada
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {formatBRL(margem)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <PercentBadge pct={r.margem_pct} />
                      </TableCell>
                      <TableCell>
                        <OrigemBadge origem={r.origem_margem} />
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
