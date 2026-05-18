import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { DashboardPeriodFilter } from "@/components/DashboardPeriodFilter";
import {
  PERIOD_SUFFIX,
  resolveRange,
  type PeriodPreset,
  type PeriodRange,
  BACKWARD_PRESETS,
} from "@/lib/dashboard/period";

type SearchParams = {
  period: PeriodPreset;
  from?: string;
  to?: string;
};

const VALID_PRESETS: PeriodPreset[] = [...BACKWARD_PRESETS, "custom"];

export const Route = createFileRoute("/pedidos")({
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const period = VALID_PRESETS.includes(search.period as PeriodPreset)
      ? (search.period as PeriodPreset)
      : "mtd";
    return {
      period,
      from: typeof search.from === "string" ? search.from : undefined,
      to: typeof search.to === "string" ? search.to : undefined,
    };
  },
  component: PedidosPage,
});

type Pedido = {
  id: string;
  numero_pedido: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  data_pedido: string | null;
  cliente_nome: string | null;
  cliente_uf: string | null;
  cliente_cidade: string | null;
  valor_total: number | null;
  situacao: string | null;
};

type ResumoPedidos = {
  pedidos_qtd: number;
  receita_total: number;
  ticket_medio: number;
  canais_ativos: number;
};

const SITUACAO_COLORS: Record<string, string> = {
  entregue: "bg-success/10 text-success border-success/20",
  enviada: "bg-primary/10 text-primary border-primary/20",
  preparando_envio: "bg-warning/10 text-warning border-warning/20",
  cancelada: "bg-destructive/10 text-destructive border-destructive/20",
  aprovada: "bg-accent text-foreground border-border",
};

function PedidosPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/pedidos" });

  const range: PeriodRange = useMemo(
    () => resolveRange(search.period, search.from, search.to),
    [search.period, search.from, search.to],
  );
  const suffix = PERIOD_SUFFIX[range.preset];

  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [resumo, setResumo] = useState<ResumoPedidos | null>(null);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [canal, setCanal] = useState<string>("todos");
  const [situacao, setSituacao] = useState<string>("todas");

  const handlePeriodChange = (next: PeriodRange) => {
    navigate({
      search: () =>
        next.preset === "custom"
          ? { period: next.preset, from: next.from, to: next.to }
          : { period: next.preset },
      replace: true,
    });
  };

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    (async () => {
      const fromIso = `${range.from}T00:00:00`;
      const toIso = `${range.to}T23:59:59`;
      const [p, r] = await Promise.all([
        supabaseExternal
          .from("pedidos_tiny")
          .select(
            "id,numero_pedido,numero_ecommerce,marca_canal,data_pedido,cliente_nome,cliente_uf,cliente_cidade,valor_total,situacao",
          )
          .gte("data_pedido", fromIso)
          .lte("data_pedido", toIso)
          .order("data_pedido", { ascending: false })
          .limit(1000),
        supabaseExternal.rpc("get_pedidos_resumo", {
          p_data_inicio: range.from,
          p_data_fim: range.to,
        }),
      ]);
      if (cancel) return;
      if (!p.error) setPedidos((p.data ?? []) as Pedido[]);
      if (!r.error) {
        const row = Array.isArray(r.data) ? r.data[0] : r.data;
        setResumo((row ?? null) as ResumoPedidos | null);
      }
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [range.from, range.to]);

  const canais = useMemo(
    () => Array.from(new Set(pedidos.map((p) => p.marca_canal).filter(Boolean))) as string[],
    [pedidos],
  );
  const situacoes = useMemo(
    () => Array.from(new Set(pedidos.map((p) => p.situacao).filter(Boolean))) as string[],
    [pedidos],
  );

  const filtrados = pedidos.filter((p) => {
    if (canal !== "todos" && p.marca_canal !== canal) return false;
    if (situacao !== "todas" && p.situacao !== situacao) return false;
    if (busca) {
      const q = busca.toLowerCase();
      return (
        p.numero_pedido?.toLowerCase().includes(q) ||
        p.numero_ecommerce?.toLowerCase().includes(q) ||
        p.cliente_nome?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalReceita = filtrados.reduce((acc, p) => acc + (p.valor_total ?? 0), 0);

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Pedidos</h1>
          <p className="text-muted-foreground">
            Pedidos sincronizados do Tiny ERP, multi-canal · {suffix}
          </p>
        </div>
        <DashboardPeriodFilter value={range} onChange={handlePeriodChange} />
      </header>

      <SyncStatusFooter area="pedidos_tiny" />

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniCard label={`Pedidos ${suffix}`} value={resumo ? formatNumber(resumo.pedidos_qtd) : "—"} />
        <MiniCard
          label="Receita"
          value={resumo ? formatBRL(resumo.receita_total, { compact: true }) : "—"}
          accent="success"
        />
        <MiniCard label="Ticket médio" value={resumo ? formatBRL(resumo.ticket_medio) : "—"} />
        <MiniCard label="Canais ativos" value={resumo ? formatNumber(resumo.canais_ativos) : "—"} />
      </section>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input
            placeholder="Buscar por nº pedido, ecommerce ou cliente"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={canal} onValueChange={setCanal}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os canais</SelectItem>
              {canais.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={situacao} onValueChange={setSituacao}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas as situações</SelectItem>
              {situacoes.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between mt-4 pt-4 border-t text-sm">
          <span className="text-muted-foreground">{formatNumber(filtrados.length)} pedidos exibidos</span>
          <span className="font-semibold tabular-nums">Total filtrado: {formatBRL(totalReceita)}</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando…</div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhum pedido encontrado no período.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Pedido</th>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Canal</th>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">UF</th>
                  <th className="px-4 py-3 font-medium">Situação</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-xs">{p.numero_pedido ?? "—"}</div>
                      {p.numero_ecommerce && (
                        <div className="text-[11px] text-muted-foreground">{p.numero_ecommerce}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {p.data_pedido ? new Date(p.data_pedido).toLocaleDateString("pt-BR") : "—"}
                    </td>
                    <td className="px-4 py-2.5">{p.marca_canal ?? "—"}</td>
                    <td className="px-4 py-2.5 truncate max-w-[200px]">{p.cliente_nome ?? "—"}</td>
                    <td className="px-4 py-2.5">{p.cliente_uf ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {p.situacao && (
                        <Badge variant="outline" className={SITUACAO_COLORS[p.situacao] ?? ""}>
                          {p.situacao}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatBRL(p.valor_total ?? 0)}
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

function MiniCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "danger" | "warning";
}) {
  const accentClass =
    accent === "success"
      ? "text-success"
      : accent === "danger"
      ? "text-destructive"
      : accent === "warning"
      ? "text-warning"
      : "text-foreground";
  return (
    <Card className="p-4">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-semibold mt-1 tabular-nums ${accentClass}`}>{value}</p>
    </Card>
  );
}
