import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarIcon,
  Coins,
  Download,
  FileSpreadsheet,
  Receipt,
  Scale,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import * as XLSX from "xlsx";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { KpiCard } from "@/components/KpiCard";
import { SyncStatusFooter } from "@/components/SyncStatusFooter";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { inicioDoDiaSP, fimDoDiaSP } from "@/lib/date";
import { formatBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/carteira")({
  component: CarteiraPage,
});

// ---------- Tipos ----------
type Transacao = {
  id: number;
  shopee_transaction_id: string | null;
  data: string;
  tipo: string;
  classificacao: string | null;
  descricao: string | null;
  pedido_id: string | null;
  direcao: "Entrada" | "Saída" | string;
  valor: number;
  status: string | null;
  saldo_apos: number | null;
};

type TipoMeta = {
  label: string;
  variant: "success" | "destructive" | "info" | "warning" | "muted";
};

const TIPO_META: Record<string, TipoMeta> = {
  recebimento_pedido: { label: "Recebimento", variant: "success" },
  ressarcimento: { label: "Ressarcimento", variant: "info" },
  imposto_difal: { label: "DIFAL", variant: "destructive" },
  estorno_credito: { label: "Estorno crédito", variant: "warning" },
  antecipacao_taxa: { label: "Taxa antecipação", variant: "destructive" },
  antecipacao_credito: { label: "Crédito antecipação", variant: "success" },
  ajuste_pedido: { label: "Ajuste pedido", variant: "warning" },
  ajuste: { label: "Ajuste", variant: "warning" },
  saque: { label: "Saque/PIX", variant: "destructive" },
  taxa_servico: { label: "Taxa FBS", variant: "destructive" },
  deposito: { label: "Depósito", variant: "success" },
  estorno: { label: "Estorno", variant: "warning" },
  credito: { label: "Crédito", variant: "muted" },
  outros: { label: "Outros", variant: "muted" },
};

const TIPO_BADGE_CLASS: Record<TipoMeta["variant"], string> = {
  success: "bg-success/15 text-success border-success/30",
  destructive: "bg-destructive/15 text-destructive border-destructive/30",
  info: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  warning: "bg-warning/20 text-warning-foreground border-warning/40",
  muted: "bg-muted text-muted-foreground border-border",
};

// ---------- Período ----------
type PeriodoKey = "hoje" | "7d" | "30d" | "mes" | "custom";

const PERIODOS: { key: PeriodoKey; label: string }[] = [
  { key: "hoje", label: "Hoje" },
  { key: "7d", label: "7 dias" },
  { key: "30d", label: "30 dias" },
  { key: "mes", label: "Mês atual" },
  { key: "custom", label: "Personalizado" },
];

function rangeFromKey(key: PeriodoKey, custom: { from?: Date; to?: Date }): { from: Date; to: Date } {
  const now = new Date();
  switch (key) {
    case "hoje":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "7d":
      return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    case "30d":
      return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    case "mes":
      return { from: startOfMonth(now), to: endOfMonth(now) };
    case "custom":
      return {
        from: custom.from ? startOfDay(custom.from) : startOfDay(subDays(now, 29)),
        to: custom.to ? endOfDay(custom.to) : endOfDay(now),
      };
  }
}

// ---------- Página ----------
const PAGE_SIZE = 50;

function CarteiraPage() {
  const [periodoKey, setPeriodoKey] = useState<PeriodoKey>("30d");
  const [custom, setCustom] = useState<{ from?: Date; to?: Date }>({});

  const range = useMemo(() => rangeFromKey(periodoKey, custom), [periodoKey, custom]);

  const [todasNoPeriodo, setTodasNoPeriodo] = useState<Transacao[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [saldoAtual, setSaldoAtual] = useState<{ valor: number | null; data: string | null }>({
    valor: null,
    data: null,
  });

  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<"data" | "valor">("data");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Saldo atual (independente do período)
  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseExternal
        .from("view_carteira")
        .select("saldo_apos, data")
        .not("saldo_apos", "is", null)
        .order("data", { ascending: false })
        .limit(1);
      if (error) return;
      const row = data?.[0];
      if (row) {
        setSaldoAtual({ valor: Number(row.saldo_apos), data: row.data as string });
      }
    })();
  }, []);

  // Fetch transações do período (uma vez por range; paginação client-side)
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    setPage(1);
    (async () => {
      const fromIso = inicioDoDiaSP(range.from);
      const toIso = fimDoDiaSP(range.to);

      // Pode haver muitas linhas; busca em páginas de 1000 (limite Supabase)
      const acc: Transacao[] = [];
      let offset = 0;
      const CHUNK = 1000;
      while (true) {
        const { data, error } = await supabaseExternal
          .from("view_carteira")
          .select(
            "id, shopee_transaction_id, data, tipo, classificacao, descricao, pedido_id, direcao, valor, status, saldo_apos"
          )
          .gte("data", fromIso)
          .lte("data", toIso)
          .order("data", { ascending: false })
          .range(offset, offset + CHUNK - 1);
        if (cancel) return;
        if (error) {
          setErro(error.message);
          break;
        }
        const rows = (data ?? []) as Transacao[];
        acc.push(...rows);
        if (rows.length < CHUNK) break;
        offset += CHUNK;
        if (offset > 50_000) break; // sanidade
      }
      if (!cancel) {
        setTodasNoPeriodo(acc);
        setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [range.from, range.to]);

  // KPIs
  const kpis = useMemo(() => {
    const rows = todasNoPeriodo ?? [];
    const sumWhere = (pred: (r: Transacao) => boolean) =>
      rows.filter(pred).reduce((acc, r) => acc + Number(r.valor || 0), 0);

    return {
      totalRecebido: sumWhere((r) => r.tipo === "recebimento_pedido"),
      totalRessarcimentos: sumWhere((r) => r.tipo === "ressarcimento"),
      totalDifal: sumWhere((r) => r.tipo === "imposto_difal"),
      totalAntecipacao: sumWhere((r) => r.tipo === "antecipacao_taxa"),
      totalAjustes: sumWhere((r) =>
        ["ajuste", "ajuste_pedido", "estorno_credito"].includes(r.tipo)
      ),
    };
  }, [todasNoPeriodo]);

  // Ordenação + paginação
  const sorted = useMemo(() => {
    const rows = [...(todasNoPeriodo ?? [])];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "data") {
        cmp = new Date(a.data).getTime() - new Date(b.data).getTime();
      } else {
        const va = signedValue(a);
        const vb = signedValue(b);
        cmp = va - vb;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [todasNoPeriodo, sortBy, sortDir]);

  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const toggleSort = (col: "data" | "valor") => {
    if (sortBy === col) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  // Export
  const exportRows = () =>
    sorted.map((r) => ({
      Data: format(new Date(r.data), "dd/MM/yyyy HH:mm"),
      Tipo: TIPO_META[r.tipo]?.label ?? r.tipo,
      Classificação: r.classificacao ?? "",
      Descrição: r.descricao ?? "",
      Pedido: r.pedido_id ?? "",
      Direção: r.direcao,
      Valor: signedValue(r),
      "Saldo após": r.saldo_apos ?? "",
      Status: r.status ?? "",
    }));

  const baseFilename = `carteira_shopee_${format(range.from, "yyyy-MM-dd")}_a_${format(range.to, "yyyy-MM-dd")}`;

  const exportCSV = () => {
    const rows = exportRows();
    if (rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(";"),
      ...rows.map((row) =>
        headers
          .map((h) => {
            const v = (row as any)[h];
            const s = v == null ? "" : String(v);
            return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(";")
      ),
    ].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    triggerDownload(blob, `${baseFilename}.csv`);
  };

  const exportXLSX = () => {
    const rows = exportRows();
    if (rows.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Carteira");
    XLSX.writeFile(wb, `${baseFilename}.xlsx`);
  };

  return (
    <div className="space-y-6 p-6">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Carteira Shopee</h1>
          <p className="text-sm text-muted-foreground">
            Transações sincronizadas automaticamente da Shopee
          </p>
        </div>
        <SeletorPeriodo
          value={periodoKey}
          custom={custom}
          onChangeKey={setPeriodoKey}
          onChangeCustom={setCustom}
          range={range}
        />
      </div>

      {erro && (
        <Card className="border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Erro ao carregar carteira: {erro}
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <KpiCard
          label="Saldo atual"
          value={saldoAtual.valor != null ? formatBRL(saldoAtual.valor) : "—"}
          hint={
            saldoAtual.data
              ? `em ${format(new Date(saldoAtual.data), "dd/MM/yyyy HH:mm")}`
              : "sem dados"
          }
          icon={<Wallet className="h-5 w-5" />}
          accent="primary"
        />
        <KpiCard
          label="Total recebido"
          value={loading ? "…" : formatBRL(kpis.totalRecebido)}
          icon={<TrendingUp className="h-5 w-5" />}
          accent="success"
        />
        <KpiCard
          label="Ressarcimentos"
          value={loading ? "…" : formatBRL(kpis.totalRessarcimentos)}
          icon={<Coins className="h-5 w-5" />}
          accent="primary"
        />
        <KpiCard
          label="Impostos DIFAL"
          value={loading ? "…" : formatBRL(kpis.totalDifal)}
          icon={<Receipt className="h-5 w-5" />}
          accent="destructive"
        />
        <KpiCard
          label="Taxas antecipação"
          value={loading ? "…" : formatBRL(kpis.totalAntecipacao)}
          icon={<Zap className="h-5 w-5" />}
          accent="warning"
        />
        <KpiCard
          label="Total ajustes"
          value={loading ? "…" : formatBRL(kpis.totalAjustes)}
          icon={<Scale className="h-5 w-5" />}
          accent="warning"
        />
      </div>

      {/* Tabela */}
      <Card className="p-4">
        <div className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {loading
              ? "Carregando…"
              : totalRows === 0
                ? "Nenhuma transação no período selecionado."
                : `Mostrando ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, totalRows)} de ${totalRows.toLocaleString("pt-BR")}`}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={exportCSV}
              disabled={totalRows === 0}
            >
              <Download className="mr-1.5 h-4 w-4" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportXLSX}
              disabled={totalRows === 0}
            >
              <FileSpreadsheet className="mr-1.5 h-4 w-4" />
              Excel
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="Data" active={sortBy === "data"} dir={sortDir} onClick={() => toggleSort("data")} />
                <TableHead>Tipo</TableHead>
                <TableHead>Classificação</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Pedido</TableHead>
                <TableHead>Direção</TableHead>
                <SortableHead label="Valor" active={sortBy === "valor"} dir={sortDir} onClick={() => toggleSort("valor")} align="right" />
                <TableHead className="text-right">Saldo após</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading &&
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {Array.from({ length: 9 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!loading && totalRows === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    Nenhuma transação no período selecionado.
                  </TableCell>
                </TableRow>
              )}

              {!loading &&
                pageRows.map((r) => {
                  const meta = TIPO_META[r.tipo] ?? { label: r.tipo, variant: "muted" as const };
                  const isEntrada = r.direcao === "Entrada";
                  const signed = signedValue(r);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {format(new Date(r.data), "dd/MM/yyyy HH:mm")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("font-medium", TIPO_BADGE_CLASS[meta.variant])}>
                          {meta.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {r.classificacao ?? "—"}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        {r.descricao ? (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate">{r.descricao}</span>
                              </TooltipTrigger>
                              {r.descricao.length > 60 && (
                                <TooltipContent side="top" className="max-w-md">
                                  <p className="text-xs">{r.descricao}</p>
                                </TooltipContent>
                              )}
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.pedido_id ? (
                          <span className="font-mono text-xs">{r.pedido_id}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-medium",
                            isEntrada
                              ? "bg-success/15 text-success border-success/30"
                              : "bg-destructive/15 text-destructive border-destructive/30"
                          )}
                        >
                          {isEntrada ? (
                            <ArrowDown className="mr-1 h-3 w-3" />
                          ) : (
                            <ArrowUp className="mr-1 h-3 w-3" />
                          )}
                          {r.direcao}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "whitespace-nowrap text-right font-medium tabular-nums",
                          isEntrada ? "text-success" : "text-destructive"
                        )}
                      >
                        {(signed >= 0 ? "+" : "−") + " " + formatBRL(Math.abs(signed))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                        {r.saldo_apos != null ? formatBRL(Number(r.saldo_apos)) : "—"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-normal",
                            r.status === "COMPLETED"
                              ? "bg-success/10 text-success border-success/30"
                              : "bg-muted text-muted-foreground border-border"
                          )}
                        >
                          {r.status ?? "—"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>

        {/* Paginação */}
        {!loading && totalRows > PAGE_SIZE && (
          <div className="flex items-center justify-between pt-4">
            <div className="text-xs text-muted-foreground">
              Página {page} de {totalPages}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={page === 1}>
                «
              </Button>
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
                Próximo
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(totalPages)}
                disabled={page === totalPages}
              >
                »
              </Button>
            </div>
          </div>
        )}
      </Card>

      <SyncStatusFooter area="carteira" />
    </div>
  );
}

// ---------- Helpers ----------
function signedValue(r: Transacao): number {
  const v = Math.abs(Number(r.valor || 0));
  return r.direcao === "Entrada" ? v : -v;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SortableHead({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "right";
}) {
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </button>
    </TableHead>
  );
}

// ---------- Seletor de período ----------
function SeletorPeriodo({
  value,
  custom,
  onChangeKey,
  onChangeCustom,
  range,
}: {
  value: PeriodoKey;
  custom: { from?: Date; to?: Date };
  onChangeKey: (k: PeriodoKey) => void;
  onChangeCustom: (c: { from?: Date; to?: Date }) => void;
  range: { from: Date; to: Date };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => v && onChangeKey(v as PeriodoKey)}
        variant="outline"
        size="sm"
        className="bg-card"
      >
        {PERIODOS.filter((p) => p.key !== "custom").map((p) => (
          <ToggleGroupItem
            key={p.key}
            value={p.key}
            className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
          >
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={value === "custom" ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
          >
            <CalendarIcon className="h-4 w-4" />
            {value === "custom" && custom.from && custom.to
              ? `${format(custom.from, "dd/MM/yy")} – ${format(custom.to, "dd/MM/yy")}`
              : "Personalizado"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="range"
            selected={{ from: custom.from, to: custom.to }}
            onSelect={(r: any) => {
              onChangeCustom({ from: r?.from, to: r?.to });
              if (r?.from && r?.to) onChangeKey("custom");
            }}
            numberOfMonths={2}
            locale={ptBR}
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">
        {format(range.from, "dd/MM/yyyy")} – {format(range.to, "dd/MM/yyyy")}
      </span>
    </div>
  );
}
