import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dre")({
  head: () => ({
    meta: [
      { title: "DRE — Demonstração de Resultado" },
      { name: "description", content: "DRE mensal em cascata: receita, CMV, comissões, impostos, despesas e lucro líquido." },
    ],
  }),
  component: DREPage,
});

interface DreRow {
  mes: string;
  receita_liquida: number | null;
  cmv: number | null;
  comissoes_frete: number | null;
  impostos: number | null;
  margem_contribuicao: number | null;
  ads: number | null;
  pessoal: number | null;
  aluguel: number | null;
  administrativas: number | null;
  embalagem: number | null;
  frete_logistica: number | null;
  financeiras: number | null;
  outras: number | null;
  creative_revisar: number | null;
  total_despesas: number | null;
  lucro_liquido: number | null;
  margem_liquida_pct: number | null;
}

interface DreOperacionalRow {
  mes: string;
  empresa: string;
  pedidos: number | null;
  receita_liquida: number | null;
  cmv: number | null;
  comissoes_frete: number | null;
  impostos: number | null;
  margem_contribuicao: number | null;
}

const brl = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const brlFull = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pct = (part: number | null | undefined, total: number | null | undefined) => {
  const p = part ?? 0;
  const t = total ?? 0;
  if (!t) return "—";
  return `${((p / t) * 100).toFixed(1).replace(".", ",")}%`;
};

function formatMes(m: string): string {
  const [y, mm] = m.split("-");
  if (!y || !mm) return m;
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${nomes[Number(mm) - 1] ?? mm}/${y.slice(2)}`;
}

function DREPage() {
  const [dre, setDre] = useState<DreRow[]>([]);
  const [operacional, setOperacional] = useState<DreOperacionalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mesSel, setMesSel] = useState<string | undefined>();

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const [r1, r2] = await Promise.all([
          supabaseExternal
            .from("view_dre_mensal")
            .select("*")
            .gte("mes", "2026-05")
            .order("mes", { ascending: true }),
          supabaseExternal
            .from("view_dre_operacional")
            .select("*")
            .gte("mes", "2026-05")
            .order("mes", { ascending: true }),
        ]);
        if (cancel) return;
        if (r1.error) throw r1.error;
        if (r2.error) throw r2.error;
        const rows = (r1.data ?? []) as DreRow[];
        setDre(rows);
        setOperacional((r2.data ?? []) as DreOperacionalRow[]);
        if (rows.length && !mesSel) setMesSel(rows[rows.length - 1].mes);
      } catch (e) {
        console.error(e);
        toast.error("Erro ao carregar DRE", { description: (e as Error).message });
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mesAtual = useMemo(() => dre.find((r) => r.mes === mesSel), [dre, mesSel]);

  const evolucao = useMemo(
    () =>
      dre.map((r) => ({
        mes: formatMes(r.mes),
        receita: r.receita_liquida ?? 0,
        lucro: r.lucro_liquido ?? 0,
        margem: r.margem_liquida_pct ?? 0,
      })),
    [dre],
  );

  const porEmpresaAgrupado = useMemo(() => {
    const map = new Map<string, { acz?: DreOperacionalRow; svl?: DreOperacionalRow }>();
    for (const r of operacional) {
      const g = map.get(r.mes) ?? {};
      const e = (r.empresa ?? "").toLowerCase();
      if (e.includes("acz")) g.acz = r;
      else if (e.includes("svl")) g.svl = r;
      map.set(r.mes, g);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [operacional]);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">DRE — Demonstração de Resultado</h1>
          <p className="text-sm text-muted-foreground">Cascata mensal: receita → margem de contribuição → lucro líquido.</p>
        </div>
        <div className="flex items-center gap-2">
          <AvisosPopover />
          <Select value={mesSel} onValueChange={setMesSel}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Selecione o mês" />
            </SelectTrigger>
            <SelectContent>
              {dre.map((r) => (
                <SelectItem key={r.mes} value={r.mes}>
                  {formatMes(r.mes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[500px] w-full" />
      ) : !mesAtual ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            Nenhum mês disponível.
          </CardContent>
        </Card>
      ) : (
        <Cascata row={mesAtual} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evolução mensal</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : evolucao.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Sem dados</p>
          ) : (
            <div className="h-[320px] w-full">
              <ResponsiveContainer>
                <ComposedChart data={evolucao}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="mes" tick={{ fontSize: 12 }} />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => (v / 1000).toFixed(0) + "k"}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                  />
                  <RTooltip
                    formatter={(v: unknown, name: string) => {
                      const n = Number(v);
                      if (name === "Margem %") return `${n.toFixed(1).replace(".", ",")}%`;
                      return brlFull(n);
                    }}
                  />
                  <Legend />
                  <Bar yAxisId="left" dataKey="receita" name="Receita" fill="hsl(var(--primary))" />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="lucro"
                    name="Lucro líquido"
                    stroke="#16a34a"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="margem"
                    name="Margem %"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {porEmpresaAgrupado.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Margem de contribuição por empresa</CardTitle>
            <p className="text-xs text-muted-foreground">
              Despesas fixas ainda não são separadas por empresa — a quebra vai até a margem de contribuição.
            </p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2 px-2">Mês</th>
                  <th className="text-right py-2 px-2">ACZ — Receita</th>
                  <th className="text-right py-2 px-2">ACZ — MC</th>
                  <th className="text-right py-2 px-2">SVL — Receita</th>
                  <th className="text-right py-2 px-2">SVL — MC</th>
                </tr>
              </thead>
              <tbody>
                {porEmpresaAgrupado.map(([mes, g]) => (
                  <tr key={mes} className="border-b last:border-0">
                    <td className="py-2 px-2 font-medium">{formatMes(mes)}</td>
                    <td className="text-right py-2 px-2 tabular-nums">{brl(g.acz?.receita_liquida)}</td>
                    <td className="text-right py-2 px-2 tabular-nums">{brl(g.acz?.margem_contribuicao)}</td>
                    <td className="text-right py-2 px-2 tabular-nums">{brl(g.svl?.receita_liquida)}</td>
                    <td className="text-right py-2 px-2 tabular-nums">{brl(g.svl?.margem_contribuicao)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Cascata({ row }: { row: DreRow }) {
  const receita = row.receita_liquida ?? 0;
  const lucroPos = (row.lucro_liquido ?? 0) >= 0;

  const linhasTop: Array<{ label: string; valor: number | null; negativo?: boolean }> = [
    { label: "RECEITA LÍQUIDA", valor: row.receita_liquida },
    { label: "(−) CMV", valor: row.cmv, negativo: true },
    { label: "(−) Comissões + Frete", valor: row.comissoes_frete, negativo: true },
    { label: "(−) Impostos", valor: row.impostos, negativo: true },
  ];

  const despesas: Array<{ label: string; valor: number | null }> = [
    { label: "(−) Marketing / ADS", valor: row.ads },
    { label: "(−) Pessoal", valor: row.pessoal },
    { label: "(−) Aluguel", valor: row.aluguel },
    { label: "(−) Administrativas", valor: row.administrativas },
    { label: "(−) Embalagem", valor: row.embalagem },
    { label: "(−) Frete / Logística", valor: row.frete_logistica },
    { label: "(−) Financeiras", valor: row.financeiras },
    { label: "(−) Outras", valor: row.outras },
    { label: "(−) A revisar", valor: row.creative_revisar },
  ].filter((d) => (d.valor ?? 0) !== 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{formatMes(row.mes)}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {linhasTop.map((l) => (
          <Linha key={l.label} label={l.label} valor={l.valor} receita={receita} bold={l.label.startsWith("RECEITA")} />
        ))}

        <div className="border-t my-2" />

        <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 px-3 py-2 border border-blue-200 dark:border-blue-900">
          <Linha
            label="= MARGEM DE CONTRIBUIÇÃO"
            valor={row.margem_contribuicao}
            receita={receita}
            bold
            larger
          />
        </div>

        {despesas.map((d) => (
          <Linha key={d.label} label={d.label} valor={d.valor} receita={receita} muted />
        ))}

        <div className="border-t my-2" />

        <div
          className={cn(
            "rounded-md px-3 py-3 border",
            lucroPos
              ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900"
              : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
          )}
        >
          <div className="flex items-center justify-between gap-4">
            <span className={cn("font-bold text-lg", lucroPos ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
              = LUCRO LÍQUIDO
            </span>
            <div className="flex items-center gap-6">
              <span className={cn("font-bold text-xl tabular-nums", lucroPos ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
                {brlFull(row.lucro_liquido)}
              </span>
              <span className={cn("font-semibold text-sm w-16 text-right tabular-nums", lucroPos ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
                {row.margem_liquida_pct != null
                  ? `${row.margem_liquida_pct.toFixed(1).replace(".", ",")}%`
                  : pct(row.lucro_liquido, receita)}
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Linha({
  label,
  valor,
  receita,
  bold,
  larger,
  muted,
}: {
  label: string;
  valor: number | null | undefined;
  receita: number;
  bold?: boolean;
  larger?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4 py-1", muted && "text-muted-foreground")}>
      <span className={cn(bold && "font-semibold", larger && "text-base")}>{label}</span>
      <div className="flex items-center gap-6">
        <span className={cn("tabular-nums", bold && "font-semibold", larger && "text-base")}>
          {brlFull(valor)}
        </span>
        <span className={cn("text-xs w-16 text-right tabular-nums text-muted-foreground", bold && "font-medium")}>
          {pct(valor, receita)}
        </span>
      </div>
    </div>
  );
}

function AvisosPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Info className="h-4 w-4" />
          Ressalvas
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 text-sm space-y-3">
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">Backfill em andamento</p>
          <p>A receita de meses anteriores pode estar incompleta enquanto o histórico de repasses é processado. Junho é o mês mais completo.</p>
        </div>
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">ADS parcial</p>
          <p>O gasto com publicidade cobre apenas a Shopee e a partir de 16/06. Maio não tem ADS lançado, e o ADS do Mercado Livre ainda não está integrado.</p>
        </div>
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">CMV</p>
          <p>O resultado considera apenas pedidos com custo de produto cadastrado. Pedidos sem custo ficam de fora (mesma regra dos Pedidos Integrados).</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
