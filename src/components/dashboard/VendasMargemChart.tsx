import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

type Row = {
  data: string;
  receita: number | null;
  margem: number | null;
  receita_sem_margem: number | null;
  margem_pct: number | null;
  pedidos: number | null;
  meta_dia: number | null;
  meta_mes: number | null;
};

type Visibility = {
  venda: boolean;
  margem: boolean;
  margemPct: boolean;
  meta: boolean;
};

const COR_MARGEM = "var(--color-success)"; // verde — porção de margem da barra
const COR_VENDA = "var(--color-primary)"; // roxo — restante da receita
const COR_MARGEM_PCT = "var(--color-warning)"; // âmbar — linha MC%
const COR_META = "var(--color-muted-foreground)"; // cinza — meta (tracejada)

function brCompact(v: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}

export function VendasMargemChart({
  range,
  isMesAtual,
}: {
  range: { from: string; to: string };
  isMesAtual: boolean;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [vis, setVis] = useState<Visibility>({
    venda: true,
    margem: true,
    margemPct: true,
    meta: true,
  });

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setErro(null);
    (async () => {
      const { data, error } = await supabaseExternal
        .from("view_grafico_vendas_margem_dia")
        .select("*")
        .gte("data", range.from)
        .lte("data", range.to)
        .order("data", { ascending: true });
      if (cancel) return;
      if (error) {
        setErro(error.message);
        setRows([]);
      } else {
        setRows((data ?? []) as Row[]);
      }
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [range.from, range.to]);

  const chartData = useMemo(
    () =>
      rows.map((r) => {
        const receita = Number(r.receita ?? 0);
        const margem = Number(r.margem ?? 0);
        // Se ocultar "Margem R$", a barra vira só "venda" (usa receita total).
        const semMargem = vis.margem
          ? Number(r.receita_sem_margem ?? Math.max(0, receita - margem))
          : receita;
        return {
          data: r.data,
          receita,
          margemBar: vis.margem ? margem : 0,
          semMargemBar: vis.venda ? semMargem : 0,
          margem_pct: r.margem_pct != null ? Number(r.margem_pct) : null,
          meta_dia: r.meta_dia != null ? Number(r.meta_dia) : null,
        };
      }),
    [rows, vis.margem, vis.venda],
  );

  const resumo = useMemo(() => {
    let realizado = 0;
    let metaPeriodo = 0;
    let metaMes: number | null = null;
    let menor: { data: string; valor: number } | null = null;
    let maior: { data: string; valor: number } | null = null;
    for (const r of rows) {
      const rec = Number(r.receita ?? 0);
      realizado += rec;
      if (r.meta_dia != null) metaPeriodo += Number(r.meta_dia);
      if (r.meta_mes != null) metaMes = Number(r.meta_mes);
      const mg = Number(r.margem ?? 0);
      if (rec > 0) {
        if (!menor || mg < menor.valor) menor = { data: r.data, valor: mg };
        if (!maior || mg > maior.valor) maior = { data: r.data, valor: mg };
      }
    }
    const pct = metaPeriodo > 0 ? (realizado / metaPeriodo) * 100 : null;
    return { realizado, metaPeriodo, metaMes, menor, maior, pct };
  }, [rows]);

  const atingCor =
    resumo.pct == null
      ? "text-muted-foreground"
      : resumo.pct >= 100
        ? "text-success"
        : resumo.pct >= 80
          ? "text-warning"
          : "text-destructive";

  const toggle = (k: keyof Visibility) => setVis((v) => ({ ...v, [k]: !v[k] }));

  return (
    <Card className="p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[14.5px] font-semibold tracking-[-0.015em]">Vendas × Margem × Meta</p>
          <p className="text-3xl font-semibold tabular-nums mt-1">
            {formatBRL(resumo.realizado, { compact: true })}
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
            {resumo.metaPeriodo > 0 && (
              <span>
                Meta do período: <span className="tabular-nums text-foreground">{formatBRL(resumo.metaPeriodo, { compact: true })}</span>
              </span>
            )}
            {isMesAtual && resumo.metaMes != null && (
              <span>
                Meta do mês: <span className="tabular-nums text-foreground">{formatBRL(resumo.metaMes, { compact: true })}</span>
              </span>
            )}
            {resumo.pct != null && (
              <span className={cn("font-medium", atingCor)}>
                Atingimento: {formatPercent(resumo.pct)}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {resumo.maior && (
            <Badge variant="outline" className="gap-1 text-xs bg-success/5 border-success/20 text-success">
              <ArrowUp className="h-3 w-3" />
              Maior margem: {formatBRL(resumo.maior.valor, { compact: true })} · {format(parseISO(resumo.maior.data), "dd/MM")}
            </Badge>
          )}
          {resumo.menor && (
            <Badge variant="outline" className="gap-1 text-xs bg-destructive/5 border-destructive/20 text-destructive">
              <ArrowDown className="h-3 w-3" />
              Menor margem: {formatBRL(resumo.menor.valor, { compact: true })} · {format(parseISO(resumo.menor.data), "dd/MM")}
            </Badge>
          )}
        </div>
      </div>

      {loading ? (
        <div className="h-64 animate-pulse bg-muted/40 rounded-md" />
      ) : erro ? (
        <p className="text-sm text-destructive py-12 text-center">{erro}</p>
      ) : chartData.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">Sem vendas no período.</p>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="data"
                tickFormatter={(v) => format(parseISO(v), "dd/MM")}
                stroke="var(--color-muted-foreground)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="left"
                tickFormatter={(v) => brCompact(Number(v))}
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={55}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                stroke="var(--color-muted-foreground)"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-popover)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelFormatter={(v) => format(parseISO(String(v)), "dd 'de' MMM", { locale: ptBR })}
                formatter={(value, name, item) => {
                  const n = Number(value ?? 0);
                  if (name === "Margem %") return [formatPercent(n), name];
                  // A serie "Venda" plota a FATIA empilhada (receita − margem)
                  // para a barra somar a receita. No tooltip, porem, "Venda"
                  // tem que ser a receita CHEIA — mostrar a fatia fazia o
                  // grafico parecer divergente dos cards (15,9k vs 18,9k).
                  if (name === "Venda") {
                    const receita = Number(
                      (item as { payload?: { receita?: number } })?.payload?.receita ?? n,
                    );
                    return [formatBRL(receita), name];
                  }
                  return [formatBRL(n), name];
                }}
                itemSorter={(item) => {
                  const order: Record<string, number> = {
                    Venda: 0,
                    "Margem R$": 1,
                    "Margem %": 2,
                    "Meta do dia": 3,
                  };
                  return order[String(item.name)] ?? 99;
                }}
              />
              <Legend
                onClick={(e) => {
                  const map: Record<string, keyof Visibility> = {
                    Venda: "venda",
                    "Margem R$": "margem",
                    "Margem %": "margemPct",
                    Meta: "meta",
                  };
                  const k = map[String(e.value)];
                  if (k) toggle(k);
                }}
                formatter={(value) => {
                  const map: Record<string, keyof Visibility> = {
                    Venda: "venda",
                    "Margem R$": "margem",
                    "Margem %": "margemPct",
                    Meta: "meta",
                  };
                  const k = map[String(value)];
                  const active = k ? vis[k] : true;
                  return (
                    <span
                      style={{
                        opacity: active ? 1 : 0.35,
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {value}
                    </span>
                  );
                }}
              />
              {vis.margem && (
                <Bar
                  yAxisId="left"
                  dataKey="margemBar"
                  name="Margem R$"
                  stackId="a"
                  fill={COR_MARGEM}
                  radius={[0, 0, 0, 0]}
                />
              )}
              {vis.venda && (
                <Bar
                  yAxisId="left"
                  dataKey="semMargemBar"
                  name="Venda"
                  stackId="a"
                  fill={COR_VENDA}
                  radius={[4, 4, 0, 0]}
                />
              )}
              {vis.margemPct && (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="margem_pct"
                  name="Margem %"
                  stroke={COR_MARGEM_PCT}
                  strokeWidth={2}
                  dot={{ r: 3, fill: COR_MARGEM_PCT }}
                  connectNulls
                />
              )}
              {vis.meta && (
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="meta_dia"
                  name="Meta"
                  stroke={COR_META}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  dot={false}
                  connectNulls
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
