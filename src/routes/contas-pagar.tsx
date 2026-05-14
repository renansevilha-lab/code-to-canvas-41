import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, CheckCircle2, Wallet, CalendarRange } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatDate, formatNumber } from "@/lib/format";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import {
  FORWARD_PRESETS,
  PERIOD_LABELS,
  resolveRange,
  type PeriodPreset,
  type PeriodRange,
} from "@/lib/dashboard/period";

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
};

const VALID_PRESETS: PeriodPreset[] = [...FORWARD_PRESETS, "custom"];

export const Route = createFileRoute("/contas-pagar")({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const period = VALID_PRESETS.includes(search.period as PeriodPreset)
      ? (search.period as PeriodPreset)
      : "next30";
    return {
      period,
      from: typeof search.from === "string" ? search.from : undefined,
      to: typeof search.to === "string" ? search.to : undefined,
    };
  },
  component: ContasPagarPage,
});

type Conta = {
  id: string;
  numero_documento: string | null;
  fornecedor_nome: string | null;
  descricao: string | null;
  categoria: string | null;
  valor_total: number;
  valor_pago: number | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status: string;
};

type Snapshot = {
  qtd: number;
  valor: number;
};

const PAGE_SIZE = 1000;

const STATUS_BADGE: Record<string, string> = {
  paga: "bg-success/10 text-success border-success/20",
  parcial: "bg-warning/10 text-warning border-warning/20",
  aberto: "bg-muted text-muted-foreground border-border",
  cancelada: "bg-muted text-muted-foreground border-border line-through",
};

function statusBadgeFor(c: Conta): string {
  if (isPaid(c)) return STATUS_BADGE.paga;
  if (isOverdue(c)) return "bg-destructive/10 text-destructive border-destructive/20";
  if (isDueWithinDays(c, 7))
    return "bg-warning/10 text-warning border-warning/20";
  return STATUS_BADGE[c.status] ?? STATUS_BADGE.aberto;
}

function statusLabel(c: Conta): string {
  if (isPaid(c)) return "Paga";
  const diasAtraso = getDiasAtraso(c);
  if (diasAtraso > 0) return `Atrasada (${diasAtraso}d)`;
  if (isDueToday(c)) return "Vence hoje";
  if (isDueWithinDays(c, 7)) return "Vence em 7 dias";
  if (c.status === "parcial") return "Parcial";
  if (c.status === "cancelada") return "Cancelada";
  return "Aberto";
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isOpen(c: Conta): boolean {
  return c.status === "aberto" || c.status === "parcial";
}

function isPaid(c: Conta): boolean {
  return c.status === "paga" || c.status === "pago" || c.status === "liquidado";
}

function isOverdue(c: Conta): boolean {
  return isOpen(c) && Boolean(c.data_vencimento) && c.data_vencimento! < toDateKey(new Date());
}

function isDueToday(c: Conta): boolean {
  return isOpen(c) && c.data_vencimento === toDateKey(new Date());
}

function isDueWithinDays(c: Conta, days: number): boolean {
  if (!isOpen(c) || !c.data_vencimento) return false;
  const today = toDateKey(new Date());
  const limit = toDateKey(addLocalDays(new Date(), days));
  return c.data_vencimento >= today && c.data_vencimento <= limit;
}

function getDiasAtraso(c: Conta): number {
  if (!isOpen(c) || !c.data_vencimento) return 0;
  const today = new Date(`${toDateKey(new Date())}T00:00:00`);
  const vencimento = new Date(`${c.data_vencimento}T00:00:00`);
  return Math.max(0, Math.floor((today.getTime() - vencimento.getTime()) / 86400000));
}

function getSaldo(c: Conta): number {
  return Math.max(Number(c.valor_total ?? 0) - Number(c.valor_pago ?? 0), 0);
}

function inRange(c: Conta, range: PeriodRange): boolean {
  return Boolean(c.data_vencimento) && c.data_vencimento! >= range.from && c.data_vencimento! <= range.to;
}

async function fetchAllContas(): Promise<Conta[]> {
  const rows: Conta[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabaseExternal
      .from("contas_pagar")
      .select(
        "id,numero_documento,fornecedor_nome,descricao,categoria,valor_total,valor_pago,data_emissao,data_vencimento,data_pagamento,status",
      )
      .order("data_vencimento", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as Conta[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function ContasPagarPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/contas-pagar" });

  const range: PeriodRange = useMemo(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );

  const [contas, setContas] = useState<Conta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("todos");

  const handlePeriodChange = (next: PeriodRange) => {
    navigate({
      search: () =>
        next.preset === "custom"
          ? { period: next.preset, from: next.from, to: next.to }
          : { period: next.preset },
      replace: true,
    });
  };

  // Fonte única da página: banco externo vhogjofsxyhnyxdyglmq, tabela contas_pagar.
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    (async () => {
      if (cancel) return;
      try {
        const rows = await fetchAllContas();
        if (!cancel) setContas(rows);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  // Snapshots dos cards calculados localmente da mesma consulta externa.
  const snap = useMemo(() => {
    const build = (items: Conta[]): Snapshot => ({
      qtd: items.length,
      valor: items.reduce((acc, c) => acc + (isPaid(c) ? Number(c.valor_total ?? 0) : getSaldo(c)), 0),
    });
    return {
      atrasadas: build(contas.filter(isOverdue)),
      vencendo: build(contas.filter((c) => isDueWithinDays(c, 7))),
      aberto: build(contas.filter(isOpen)),
      paga: build(contas.filter(isPaid)),
    };
  }, [contas]);

  const contasPeriodo = useMemo(() => contas.filter((c) => inRange(c, range)), [contas, range]);

  const totalPeriodo = useMemo(() => ({
    qtd: contasPeriodo.length,
    valor: contasPeriodo.reduce((acc, c) => acc + getSaldo(c), 0),
  }), [contasPeriodo]);

  const baseTabela = statusFilter === "atrasadas" || statusFilter === "vencendo" ? contas : contasPeriodo;

  const filtradas = baseTabela.filter((c) => {
    if (statusFilter !== "todos") {
      if (statusFilter === "atrasadas" && !isOverdue(c)) return false;
      if (statusFilter === "vencendo" && !isDueWithinDays(c, 7)) return false;
      if (statusFilter === "aberto" && !isOpen(c)) return false;
      if (statusFilter === "paga" && !isPaid(c)) return false;
    }
    if (busca) {
      const q = busca.toLowerCase();
      return (
        c.fornecedor_nome?.toLowerCase().includes(q) ||
        c.numero_documento?.toLowerCase().includes(q) ||
        c.descricao?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Contas a Pagar</h1>
          <p className="text-muted-foreground">
            Contas sincronizadas do Tiny — atrasadas, vencendo e em aberto.
          </p>
        </div>
        <DashboardPeriodFilter
          value={range}
          onChange={handlePeriodChange}
          presets={FORWARD_PRESETS}
        />
      </header>

      {/* Cards snapshots (globais) + 1 do período */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <SummaryCard
          icon={AlertTriangle}
          label="Atrasadas"
          qtd={snap.atrasadas.qtd}
          valor={snap.atrasadas.valor}
          accent="danger"
        />
        <SummaryCard
          icon={Clock}
          label="Vencem em 7 dias"
          qtd={snap.vencendo.qtd}
          valor={snap.vencendo.valor}
          accent="warning"
        />
        <SummaryCard
          icon={Wallet}
          label="Em aberto"
          qtd={snap.aberto.qtd}
          valor={snap.aberto.valor}
        />
        <SummaryCard
          icon={CheckCircle2}
          label="Pagas"
          qtd={snap.paga.qtd}
          valor={snap.paga.valor}
          accent="success"
        />
        <SummaryCard
          icon={CalendarRange}
          label={`Total · ${PERIOD_LABELS[range.preset]}`}
          qtd={totalPeriodo.qtd}
          valor={totalPeriodo.valor}
          accent="primary"
        />
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Buscar por fornecedor, documento ou descrição"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os status</SelectItem>
              <SelectItem value="atrasadas">Atrasadas</SelectItem>
              <SelectItem value="vencendo">Vencendo (7 dias)</SelectItem>
              <SelectItem value="aberto">Em aberto / parcial</SelectItem>
              <SelectItem value="paga">Pagas</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : filtradas.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhuma conta nesse período/filtro.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Fornecedor</th>
                  <th className="px-4 py-3 font-medium">Documento</th>
                  <th className="px-4 py-3 font-medium">Vencimento</th>
                  <th className="px-4 py-3 font-medium text-right">Valor</th>
                  <th className="px-4 py-3 font-medium text-right">Saldo</th>
                  <th className="px-4 py-3 font-medium">Descrição</th>
                </tr>
              </thead>
              <tbody>
                {filtradas.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Badge variant="outline" className={statusBadgeFor(c)}>
                        {statusLabel(c)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 max-w-[240px]">
                      <div className="font-medium truncate">{c.fornecedor_nome ?? "—"}</div>
                      {c.categoria && (
                        <div className="text-[11px] text-muted-foreground truncate">{c.categoria}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{c.numero_documento ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {c.data_vencimento ? formatDate(c.data_vencimento) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                      {formatBRL(c.valor_total)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatBRL(getSaldo(c))}
                    </td>
                    <td className="px-4 py-2.5 max-w-[260px] truncate text-muted-foreground">
                      {c.descricao ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  qtd,
  valor,
  accent,
}: {
  icon: typeof AlertTriangle;
  label: string;
  qtd: number;
  valor: number;
  accent?: "success" | "warning" | "danger" | "primary";
}) {
  const accentClasses = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
    primary: "bg-primary/10 text-primary",
  } as const;
  const iconClass = accent ? accentClasses[accent] : "bg-muted text-muted-foreground";
  return (
    <Card className="p-5">
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center mb-3 ${iconClass}`}>
        <Icon className="h-4 w-4" />
      </div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1 tabular-nums">{formatBRL(valor, { compact: true })}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{formatNumber(qtd)} contas</p>
    </Card>
  );
}
