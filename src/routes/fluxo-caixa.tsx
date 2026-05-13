import { createFileRoute } from "@tanstack/react-router";
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
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertTriangle, TrendingDown, TrendingUp, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/fluxo-caixa")({
  component: FluxoCaixaPage,
});

type KpisFC = {
  saldo_7d: number;
  saldo_30d: number;
  saldo_60d: number;
  saldo_90d: number;
  total_a_receber_30d: number;
  total_a_pagar_30d: number;
  contas_atrasadas_qtd: number;
  contas_atrasadas_valor: number;
  pior_dia: string | null;
  pior_dia_saldo: number | null;
};

type ProjecaoRow = {
  dia: string;
  entradas_projetadas: number;
  saidas_planejadas: number;
  saldo_acumulado: number;
};

type ProximoVencimento = {
  id: string;
  data_vencimento: string;
  fornecedor_nome: string | null;
  numero_documento: string | null;
  descricao: string | null;
  valor_total: number;
};

const HORIZONS = [30, 60, 90, 180] as const;
type Horizon = (typeof HORIZONS)[number];

function FluxoCaixaPage() {
  const [kpis, setKpis] = useState<KpisFC | null>(null);
  const [horizon, setHorizon] = useState<Horizon>(90);
  const [projecao, setProjecao] = useState<ProjecaoRow[]>([]);
  const [proximos, setProximos] = useState<ProximoVencimento[]>([]);
  const [loadingKpis, setLoadingKpis] = useState(true);
  const [loadingChart, setLoadingChart] = useState(true);
  const [loadingProx, setLoadingProx] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseExternal.rpc("get_kpis_fluxo_caixa");
      if (error) setErro(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      setKpis((row ?? null) as KpisFC | null);
      setLoadingKpis(false);
    })();
  }, []);

  useEffect(() => {
    let cancel = false;
    setLoadingChart(true);
    (async () => {
      const { data, error } = await supabaseExternal.rpc("get_projecao_fluxo_caixa", {
        p_dias_futuro: horizon,
      });
      if (cancel) return;
      if (error) setErro(error.message);
      // Convertemos saídas para negativo no gráfico
      const rows = ((data ?? []) as ProjecaoRow[]).map((r) => ({
        ...r,
        entradas_projetadas: Number(r.entradas_projetadas ?? 0),
        saidas_planejadas: -Math.abs(Number(r.saidas_planejadas ?? 0)),
        saldo_acumulado: Number(r.saldo_acumulado ?? 0),
      }));
      setProjecao(rows);
      setLoadingChart(false);
    })();
    return () => {
      cancel = true;
    };
  }, [horizon]);

  useEffect(() => {
    (async () => {
      const today = format(new Date(), "yyyy-MM-dd");
      const in30 = format(new Date(Date.now() + 30 * 86400000), "yyyy-MM-dd");
      const { data } = await supabaseExternal
        .from("contas_pagar")
        .select("id,data_vencimento,fornecedor_nome,numero_documento,descricao,valor_total")
        .in("status", ["aberto", "parcial"])
        .gte("data_vencimento", today)
        .lte("data_vencimento", in30)
        .order("data_vencimento", { ascending: true })
        .limit(200);
      setProximos((data ?? []) as ProximoVencimento[]);
      setLoadingProx(false);
    })();
  }, []);

  const piorDiaInfo = useMemo(() => {
    if (!kpis?.pior_dia || kpis.pior_dia_saldo == null || kpis.pior_dia_saldo >= 0) return null;
    const days = differenceInCalendarDays(parseISO(kpis.pior_dia), new Date());
    if (days < 0 || days > 90) return null;
    return { date: kpis.pior_dia, saldo: kpis.pior_dia_saldo };
  }, [kpis]);

  if (erro && !kpis && projecao.length === 0) {
    return (
      <div className="p-6 md:p-10 max-w-7xl mx-auto">
        <Card className="p-6 border-destructive/30 bg-destructive/5">
          <h2 className="font-semibold text-destructive">Erro ao carregar fluxo de caixa</h2>
          <p className="text-sm text-muted-foreground mt-1">{erro}</p>
          <p className="text-xs text-muted-foreground mt-3">
            Pode faltar rodar o SQL das funções <code>get_kpis_fluxo_caixa</code> ou{" "}
            <code>get_projecao_fluxo_caixa</code>.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Fluxo de Caixa</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Projeção baseada em média histórica de receita e contas a pagar com vencimentos confirmados.
        </p>
      </header>

      {/* Linha 1 — saldos previstos */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SaldoCard label="Saldo 7 dias" value={kpis?.saldo_7d} loading={loadingKpis} />
        <SaldoCard label="Saldo 30 dias" value={kpis?.saldo_30d} loading={loadingKpis} />
        <SaldoCard label="Saldo 60 dias" value={kpis?.saldo_60d} loading={loadingKpis} />
        <SaldoCard label="Saldo 90 dias" value={kpis?.saldo_90d} loading={loadingKpis} />
      </section>

      {/* Linha 2 — receber x pagar */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FlowCard
          icon={TrendingUp}
          label="A receber · próx. 30 dias"
          value={kpis ? formatBRL(kpis.total_a_receber_30d) : "—"}
          accent="success"
        />
        <FlowCard
          icon={TrendingDown}
          label="A pagar · próx. 30 dias"
          value={kpis ? formatBRL(kpis.total_a_pagar_30d) : "—"}
          accent="danger"
        />
      </section>

      {/* Linha 3 — alertas */}
      {kpis && kpis.contas_atrasadas_qtd > 0 && (
        <Card className="p-4 border-destructive/40 bg-destructive/5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-destructive">
              {formatNumber(kpis.contas_atrasadas_qtd)} contas atrasadas
            </p>
            <p className="text-muted-foreground">
              Total em atraso: {formatBRL(kpis.contas_atrasadas_valor)}
            </p>
          </div>
        </Card>
      )}
      {piorDiaInfo && (
        <Card className="p-4 border-warning/40 bg-warning/5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-warning">
              Pior dia projetado: {format(parseISO(piorDiaInfo.date), "dd/MM/yyyy", { locale: ptBR })}
            </p>
            <p className="text-muted-foreground">
              Saldo negativo de {formatBRL(piorDiaInfo.saldo)}
            </p>
          </div>
        </Card>
      )}

      {/* Linha 4 — gráfico */}
      <section>
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div>
              <h2 className="font-semibold">Projeção diária</h2>
              <p className="text-xs text-muted-foreground">
                Entradas previstas, contas a pagar e saldo acumulado
              </p>
            </div>
            <div className="flex items-center gap-1">
              {HORIZONS.map((h) => (
                <Button
                  key={h}
                  size="sm"
                  variant={horizon === h ? "default" : "outline"}
                  onClick={() => setHorizon(h)}
                  className="h-7 px-2.5 text-xs"
                >
                  {h}d
                </Button>
              ))}
            </div>
          </div>
          {loadingChart ? (
            <div className="h-80 animate-pulse bg-muted/40 rounded-md" />
          ) : projecao.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem dados de projeção.</p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={projecao} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis
                    dataKey="dia"
                    tickFormatter={(v) => format(parseISO(v), "dd/MM", { locale: ptBR })}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                  />
                  <YAxis
                    yAxisId="left"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(v) => formatBRL(Number(v), { compact: true })}
                    width={80}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={11}
                    tickFormatter={(v) => formatBRL(Number(v), { compact: true })}
                    width={80}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(v) => format(parseISO(String(v)), "dd 'de' MMM", { locale: ptBR })}
                    formatter={(value, name) => {
                      const label =
                        name === "entradas_projetadas"
                          ? "Entradas"
                          : name === "saidas_planejadas"
                          ? "Saídas"
                          : "Saldo acumulado";
                      return [formatBRL(Math.abs(Number(value ?? 0))), label];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar
                    yAxisId="left"
                    dataKey="entradas_projetadas"
                    fill="hsl(142 71% 45%)"
                    name="Entradas"
                    radius={[2, 2, 0, 0]}
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="saidas_planejadas"
                    fill="hsl(0 84% 60%)"
                    name="Saídas"
                    radius={[0, 0, 2, 2]}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="saldo_acumulado"
                    stroke="hsl(217 91% 60%)"
                    strokeWidth={2}
                    dot={false}
                    name="Saldo acumulado"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      {/* Linha 5 — próximos vencimentos */}
      <section>
        <Card className="overflow-hidden">
          <div className="p-6 pb-3">
            <h2 className="font-semibold">Próximos vencimentos · 30 dias</h2>
            <p className="text-xs text-muted-foreground">
              Contas a pagar em aberto/parcial nos próximos 30 dias.
            </p>
          </div>
          {loadingProx ? (
            <div className="p-12 text-center text-muted-foreground">Carregando…</div>
          ) : proximos.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              Nenhum vencimento nos próximos 30 dias.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs uppercase text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Vencimento</th>
                    <th className="px-4 py-3 font-medium">Fornecedor</th>
                    <th className="px-4 py-3 font-medium">Documento</th>
                    <th className="px-4 py-3 font-medium">Descrição</th>
                    <th className="px-4 py-3 font-medium text-right">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {proximos.map((c) => {
                    const dias = differenceInCalendarDays(
                      parseISO(c.data_vencimento),
                      new Date(),
                    );
                    return (
                      <tr key={c.id} className="border-t hover:bg-muted/30">
                        <td className="px-4 py-2.5">
                          <div>{format(parseISO(c.data_vencimento), "dd/MM", { locale: ptBR })}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {dias === 0 ? "hoje" : `em ${dias}d`}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 max-w-[240px] truncate">
                          {c.fornecedor_nome ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {c.numero_documento ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 max-w-[300px] truncate text-muted-foreground">
                          {c.descricao ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-destructive">
                          {formatBRL(c.valor_total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}

function SaldoCard({
  label,
  value,
  loading,
}: {
  label: string;
  value?: number | null;
  loading: boolean;
}) {
  const positive = (value ?? 0) >= 0;
  return (
    <Card className="p-5">
      <div
        className={`h-9 w-9 rounded-lg flex items-center justify-center mb-3 ${
          positive ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
        }`}
      >
        <Wallet className="h-4 w-4" />
      </div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p
        className={`text-2xl font-semibold mt-1 tabular-nums ${
          loading || value == null
            ? "text-muted-foreground"
            : positive
            ? "text-success"
            : "text-destructive"
        }`}
      >
        {loading || value == null ? "—" : formatBRL(value, { compact: true })}
      </p>
    </Card>
  );
}

function FlowCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  accent: "success" | "danger";
}) {
  const accentClasses = {
    success: "bg-success/10 text-success",
    danger: "bg-destructive/10 text-destructive",
  } as const;
  const valueClasses = {
    success: "text-success",
    danger: "text-destructive",
  } as const;
  return (
    <Card className="p-5 flex items-center gap-4">
      <div className={`h-11 w-11 rounded-lg flex items-center justify-center ${accentClasses[accent]}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1">
        <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`text-2xl font-semibold mt-0.5 tabular-nums ${valueClasses[accent]}`}>{value}</p>
      </div>
    </Card>
  );
}
