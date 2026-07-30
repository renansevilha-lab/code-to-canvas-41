import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info, Loader2 } from "lucide-react";
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

interface DespesaDetalheRow {
  mes: string;
  categoria: string;
  fornecedor_nome: string | null;
  descricao: string | null;
  valor_total: number | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status: string | null;
}

type EmpresaFiltro = "consolidado" | "ACZ Pet" | "SVL Store";

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

// Mapeia label da linha → categoria EXATA emitida por categoria_despesa_dre()
// no banco. As strings precisam bater ao caractere, senão o drill-down volta
// vazio ("Sem itens detalhados"). Já custou isso: o front pedia "Outras",
// "A revisar" e "Frete / Logística", mas a função emite "Outras / a
// classificar", "Pessoal/Creative (revisar)" e "Frete/Logística" (sem espaços).
const DESPESA_CATEGORIAS: Record<string, string | null> = {
  "Marketing / ADS": null, // ADS não vem da view de detalhe (vem de shopee_ads_diario)
  Pessoal: "Pessoal",
  Aluguel: "Aluguel",
  Administrativas: "Administrativas",
  Embalagem: "Embalagem",
  "Frete / Logística": "Frete/Logística",
  Financeiras: "Financeiras",
  Outras: "Outras / a classificar",
  "A revisar": "Pessoal/Creative (revisar)",
};

function DREPage() {
  const [dre, setDre] = useState<DreRow[]>([]);
  const [operacional, setOperacional] = useState<DreOperacionalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mesSel, setMesSel] = useState<string | undefined>();
  const [empresaSel, setEmpresaSel] = useState<EmpresaFiltro>("consolidado");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detalhes, setDetalhes] = useState<Record<string, DespesaDetalheRow[]>>({});
  const [loadingDet, setLoadingDet] = useState<Set<string>>(new Set());

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

  // Ao mudar mês, reseta expansões
  useEffect(() => {
    setExpanded(new Set());
  }, [mesSel, empresaSel]);

  const mesAtual = useMemo(() => dre.find((r) => r.mes === mesSel), [dre, mesSel]);
  const opAtual = useMemo(
    () =>
      empresaSel !== "consolidado"
        ? operacional.find((r) => r.mes === mesSel && r.empresa === empresaSel)
        : undefined,
    [operacional, mesSel, empresaSel],
  );

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

  // ACZ/SVL do mês selecionado — alimenta o drill-down por empresa de
  // Receita Líquida e CMV (soma bate com o consolidado: ambos vêm da mesma view).
  const porEmpresaMes = useMemo(() => {
    let acz: DreOperacionalRow | undefined;
    let svl: DreOperacionalRow | undefined;
    for (const r of operacional) {
      if (r.mes !== mesSel) continue;
      const e = (r.empresa ?? "").toLowerCase();
      if (e.includes("acz")) acz = r;
      else if (e.includes("svl")) svl = r;
    }
    return { acz, svl };
  }, [operacional, mesSel]);

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

  const toggleDespesa = async (label: string) => {
    if (!mesSel) return;
    const categoria = DESPESA_CATEGORIAS[label];
    const key = `${mesSel}::${label}`;
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
      setExpanded(next);
      return;
    }
    next.add(key);
    setExpanded(next);
    if (!categoria) return; // ADS/Impostos sem drill
    if (detalhes[key]) return;
    const ld = new Set(loadingDet);
    ld.add(key);
    setLoadingDet(ld);
    try {
      const { data, error } = await supabaseExternal
        .from("view_dre_despesas_detalhe")
        .select("*")
        .eq("mes", mesSel)
        .eq("categoria", categoria)
        .order("valor_total", { ascending: false });
      if (error) throw error;
      setDetalhes((prev) => ({ ...prev, [key]: (data ?? []) as DespesaDetalheRow[] }));
    } catch (e) {
      console.error(e);
      toast.error("Erro ao carregar detalhamento", { description: (e as Error).message });
    } finally {
      setLoadingDet((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">DRE — Demonstração de Resultado</h1>
          <p className="text-sm text-muted-foreground">Cascata mensal: receita → margem de contribuição → lucro líquido.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AvisosPopover />
          <Select value={empresaSel} onValueChange={(v) => setEmpresaSel(v as EmpresaFiltro)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="consolidado">Consolidado</SelectItem>
              <SelectItem value="ACZ Pet">ACZ Pet</SelectItem>
              <SelectItem value="SVL Store">SVL Store</SelectItem>
            </SelectContent>
          </Select>
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
      ) : empresaSel === "consolidado" ? (
        <Cascata
          row={mesAtual}
          porEmpresa={porEmpresaMes}
          expanded={expanded}
          detalhes={detalhes}
          loadingDet={loadingDet}
          onToggle={toggleDespesa}
          mesSel={mesSel!}
        />
      ) : (
        <CascataEmpresa mes={mesSel!} empresa={empresaSel} row={opAtual} />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evolução mensal (consolidado)</CardTitle>
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
                    formatter={(v: unknown, name: unknown) => {
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

function Cascata({
  row,
  porEmpresa,
  expanded,
  detalhes,
  loadingDet,
  onToggle,
  mesSel,
}: {
  row: DreRow;
  porEmpresa: { acz?: DreOperacionalRow; svl?: DreOperacionalRow };
  expanded: Set<string>;
  detalhes: Record<string, DespesaDetalheRow[]>;
  loadingDet: Set<string>;
  onToggle: (label: string) => void;
  mesSel: string;
}) {
  const receita = row.receita_liquida ?? 0;
  const lucroPos = (row.lucro_liquido ?? 0) >= 0;

  // Custo fixo = soma de tudo abaixo da MC (inclui ADS, que neste DRE é uma
  // linha de despesa operacional). Reconcilia: MC − custo fixo = lucro líquido.
  const custoFixo = row.total_despesas ?? 0;

  const despesas: Array<{ label: string; valor: number | null }> = [
    { label: "Marketing / ADS", valor: row.ads },
    { label: "Pessoal", valor: row.pessoal },
    { label: "Aluguel", valor: row.aluguel },
    { label: "Administrativas", valor: row.administrativas },
    { label: "Embalagem", valor: row.embalagem },
    { label: "Frete / Logística", valor: row.frete_logistica },
    { label: "Financeiras", valor: row.financeiras },
    { label: "Outras", valor: row.outras },
    { label: "A revisar", valor: row.creative_revisar },
  ].filter((d) => (d.valor ?? 0) !== 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{formatMes(row.mes)} — Consolidado</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <LinhaTopo
          label="RECEITA LÍQUIDA"
          valor={row.receita_liquida}
          receita={receita}
          bold
          breakdown={{ acz: porEmpresa.acz?.receita_liquida, svl: porEmpresa.svl?.receita_liquida }}
          isOpen={expanded.has(`${mesSel}::RECEITA LÍQUIDA`)}
          onToggle={() => onToggle("RECEITA LÍQUIDA")}
        />
        <LinhaTopo
          label="(−) CMV"
          valor={row.cmv}
          receita={receita}
          breakdown={{ acz: porEmpresa.acz?.cmv, svl: porEmpresa.svl?.cmv }}
          isOpen={expanded.has(`${mesSel}::(−) CMV`)}
          onToggle={() => onToggle("(−) CMV")}
        />
        <Linha label="(−) Comissões + Frete" valor={row.comissoes_frete} receita={receita} />
        <Linha label="(−) Impostos" valor={row.impostos} receita={receita} />

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

        {despesas.map((d) => {
          const key = `${mesSel}::${d.label}`;
          const isOpen = expanded.has(key);
          const hasDrill = DESPESA_CATEGORIAS[d.label] != null;
          const items = detalhes[key];
          const isLoading = loadingDet.has(key);
          return (
            <div key={d.label}>
              <button
                type="button"
                onClick={() => onToggle(d.label)}
                className={cn(
                  "w-full flex items-center justify-between gap-4 py-1 text-left rounded px-1 -mx-1",
                  "text-muted-foreground hover:bg-accent/50 transition-colors",
                  !hasDrill && "cursor-default hover:bg-transparent",
                )}
                disabled={!hasDrill}
              >
                <span className="flex items-center gap-1">
                  {hasDrill ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )
                  ) : (
                    <span className="w-3.5" />
                  )}
                  (−) {d.label}
                </span>
                <div className="flex items-center gap-6">
                  <span className="tabular-nums">{brlFull(d.valor)}</span>
                  <span className="text-xs w-16 text-right tabular-nums">{pct(d.valor, receita)}</span>
                </div>
              </button>
              {isOpen && hasDrill && (
                <div className="ml-6 border-l border-border pl-3 py-1 space-y-0.5">
                  {isLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                      <Loader2 className="h-3 w-3 animate-spin" /> Carregando…
                    </div>
                  ) : !items || items.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">Sem itens detalhados.</p>
                  ) : (
                    items.map((it, i) => (
                      <div
                        key={`${it.fornecedor_nome ?? "—"}-${i}`}
                        className="flex items-start justify-between gap-4 py-0.5 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="text-foreground">{it.fornecedor_nome ?? "—"}</span>
                          {it.descricao && (
                            <span className="text-muted-foreground"> — {it.descricao}</span>
                          )}
                        </div>
                        <span className="tabular-nums text-foreground/80 shrink-0">
                          {brlFull(it.valor_total)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="rounded-md bg-muted/50 px-3 py-2 border border-border mt-1">
          <div className="flex items-center justify-between gap-4">
            <span className="font-semibold">= CUSTO FIXO TOTAL</span>
            <div className="flex items-center gap-6">
              <span className="tabular-nums font-semibold">{brlFull(custoFixo)}</span>
              <span className="text-xs w-16 text-right tabular-nums text-muted-foreground">
                {pct(custoFixo, receita)}
              </span>
            </div>
          </div>
        </div>

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

function CascataEmpresa({
  mes,
  empresa,
  row,
}: {
  mes: string;
  empresa: string;
  row: DreOperacionalRow | undefined;
}) {
  if (!row) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {formatMes(mes)} — {empresa}
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Sem dados para {empresa} em {formatMes(mes)}.
        </CardContent>
      </Card>
    );
  }

  const receita = row.receita_liquida ?? 0;
  const mc = row.margem_contribuicao ?? 0;
  const mcPos = mc >= 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {formatMes(mes)} — {empresa}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {row.pedidos ?? 0} pedidos no mês.
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        <Linha label="RECEITA LÍQUIDA" valor={row.receita_liquida} receita={receita} bold />
        <Linha label="(−) CMV" valor={row.cmv} receita={receita} />
        <Linha label="(−) Comissões + Frete" valor={row.comissoes_frete} receita={receita} />
        <Linha label="(−) Impostos" valor={row.impostos} receita={receita} />

        <div className="border-t my-2" />

        <div
          className={cn(
            "rounded-md px-3 py-2 border",
            mcPos
              ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900"
              : "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900",
          )}
        >
          <Linha label="= MARGEM DE CONTRIBUIÇÃO" valor={mc} receita={receita} bold larger />
        </div>

        <div className="mt-4 rounded-md border border-dashed p-3 text-xs text-muted-foreground flex gap-2 items-start">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Despesas fixas (ADS, Pessoal, Aluguel, etc.) não são separadas por empresa —
            veja o Lucro Líquido no modo <strong>Consolidado</strong>.
          </span>
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

// Linha do topo (Receita/CMV) com drill-down por empresa. Se não houver quebra
// por empresa para o mês, cai no <Linha> simples. Os %s usam a mesma base
// (receita consolidada) das outras linhas — os subtotais somam ao % da linha-pai.
function LinhaTopo({
  label,
  valor,
  receita,
  bold,
  breakdown,
  isOpen,
  onToggle,
}: {
  label: string;
  valor: number | null | undefined;
  receita: number;
  bold?: boolean;
  breakdown: { acz: number | null | undefined; svl: number | null | undefined };
  isOpen: boolean;
  onToggle: () => void;
}) {
  const temQuebra = breakdown.acz != null || breakdown.svl != null;
  if (!temQuebra) {
    return <Linha label={label} valor={valor} receita={receita} bold={bold} />;
  }
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-4 py-1 text-left rounded px-1 -mx-1 hover:bg-accent/50 transition-colors"
      >
        <span className={cn("flex items-center gap-1", bold && "font-semibold")}>
          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {label}
        </span>
        <div className="flex items-center gap-6">
          <span className={cn("tabular-nums", bold && "font-semibold")}>{brlFull(valor)}</span>
          <span className="text-xs w-16 text-right tabular-nums text-muted-foreground">{pct(valor, receita)}</span>
        </div>
      </button>
      {isOpen && (
        <div className="ml-6 border-l border-border pl-3 py-1 space-y-0.5">
          <SubEmpresa nome="ACZ Pet" valor={breakdown.acz} receita={receita} />
          <SubEmpresa nome="SVL Store" valor={breakdown.svl} receita={receita} />
        </div>
      )}
    </div>
  );
}

function SubEmpresa({
  nome,
  valor,
  receita,
}: {
  nome: string;
  valor: number | null | undefined;
  receita: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5 text-xs">
      <span className="text-muted-foreground">{nome}</span>
      <div className="flex items-center gap-6">
        <span className="tabular-nums text-foreground/80">{brlFull(valor)}</span>
        <span className="w-16 text-right tabular-nums text-muted-foreground">{pct(valor, receita)}</span>
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
