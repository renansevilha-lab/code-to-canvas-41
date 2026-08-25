// ============================================================================
// Fluxo de Caixa projetado — 60 dias, pedido a pedido (reescrito 26/ago).
//
// A versão anterior usava as RPCs get_kpis_fluxo_caixa/get_projecao_fluxo_caixa
// (anteriores à conciliação da carteira). Esta lê as views novas:
//   · view_fluxo_caixa_diario  — agregado por dia (entradas/saídas/acumulado)
//   · view_fluxo_caixa_eventos — o drill (origem, real × estimado)
//   · view_carteira_saldo      — saldo inicial (Shopee Ottz + Bumi)
//
// ENTRADAS: ML = data REAL de liberação do Mercado Pago; Shopee = estimada
// (data do pedido + 8 dias, mediana medida em 12,7 mil créditos reais; piso
// por estágio). SAÍDAS: contas a pagar em aberto pelo vencimento (vencidas
// caem em hoje) + gastos recorrentes (dia 5, premissa).
//
// HONESTIDADE DO MODELO: só projetamos pedidos que JÁ EXISTEM — as entradas
// Shopee se esgotam em ~10 dias (o funil atual drena); depois disso o saldo
// projetado é CONSERVADOR (sem vendas futuras inventadas).
// ============================================================================
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  Bar, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ChevronDown, ChevronRight, Info, TrendingDown, TrendingUp, Wallet } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/fluxo-caixa")({
  component: FluxoCaixaPage,
});

interface DiaRow {
  dia: string;
  entradas: number | null;
  entradas_reais: number | null;
  saidas: number | null;
  liquido: number | null;
  acumulado: number | null;
}
interface EventoRow {
  dia: string;
  fluxo: "entrada" | "saida";
  origem: string;
  confianca: "real" | "estimado";
  valor: number;
  itens: number;
  detalhe: string | null;
}
interface SaldoRow { carteira: string; saldo_em_conta: number; marketplace: string }

const n = (v: unknown): number => Number(v ?? 0) || 0;

function FluxoCaixaPage() {
  const [expandido, setExpandido] = useState<Set<string>>(new Set());

  const diarioQ = useQuery({
    queryKey: ["fluxo", "diario"],
    queryFn: async (): Promise<DiaRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_fluxo_caixa_diario").select("*").order("dia");
      if (error) throw error;
      return (data ?? []) as DiaRow[];
    },
  });
  const eventosQ = useQuery({
    queryKey: ["fluxo", "eventos"],
    queryFn: async (): Promise<EventoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_fluxo_caixa_eventos").select("*").order("dia").limit(2000);
      if (error) throw error;
      return (data ?? []) as EventoRow[];
    },
  });
  const saldosQ = useQuery({
    queryKey: ["fluxo", "saldos"],
    queryFn: async (): Promise<SaldoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_carteira_saldo").select("carteira, saldo_em_conta, marketplace");
      if (error) throw error;
      return (data ?? []) as SaldoRow[];
    },
  });

  const dias = diarioQ.data ?? [];
  const saldoInicial = useMemo(
    () => (saldosQ.data ?? []).reduce((s, r) => s + n(r.saldo_em_conta), 0),
    [saldosQ.data],
  );

  const chartData = useMemo(() => dias.map((d) => ({
    dia: d.dia,
    entradaReal: n(d.entradas_reais),
    entradaEstimada: Math.max(0, n(d.entradas) - n(d.entradas_reais)),
    saida: -n(d.saidas),
    saldoProjetado: saldoInicial + n(d.acumulado),
  })), [dias, saldoInicial]);

  const resumo = useMemo(() => {
    let e7 = 0, s7 = 0, liq30 = 0;
    let vale: { dia: string; valor: number } | null = null;
    dias.forEach((d, i) => {
      const saldo = saldoInicial + n(d.acumulado);
      if (i < 7) { e7 += n(d.entradas); s7 += n(d.saidas); }
      if (i < 30) liq30 += n(d.liquido);
      if (!vale || saldo < vale.valor) vale = { dia: d.dia, valor: saldo };
    });
    return { e7, s7, liq30, vale: vale as { dia: string; valor: number } | null };
  }, [dias, saldoInicial]);

  const eventosPorDia = useMemo(() => {
    const m = new Map<string, EventoRow[]>();
    for (const e of eventosQ.data ?? []) {
      if (!m.has(e.dia)) m.set(e.dia, []);
      m.get(e.dia)!.push(e);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.fluxo === b.fluxo ? n(b.valor) - n(a.valor) : a.fluxo === "entrada" ? -1 : 1));
    }
    return m;
  }, [eventosQ.data]);

  const toggle = (dia: string) => setExpandido((prev) => {
    const nx = new Set(prev);
    if (nx.has(dia)) nx.delete(dia); else nx.add(dia);
    return nx;
  });

  const carregando = diarioQ.isLoading || saldosQ.isLoading;

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-[18px]">
      <p className="text-sm text-muted-foreground">
        Projeção de 60 dias, pedido a pedido — ML com data real de liberação; Shopee estimada (ciclo mediano de 8 dias)
      </p>

      {/* Cards */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <CardKpi rotulo="Saldo em carteiras" valor={saldoInicial} icone={<Wallet className="h-4 w-4" />}
          hint="Shopee Ottz + Bumi (ML não expõe saldo)" />
        <CardKpi rotulo="Entradas 7 dias" valor={resumo.e7} icone={<TrendingUp className="h-4 w-4" />} positivo />
        <CardKpi rotulo="Saídas 7 dias" valor={resumo.s7} icone={<TrendingDown className="h-4 w-4" />} negativo />
        <CardKpi rotulo="Líquido 30 dias" valor={resumo.liq30} icone={<TrendingUp className="h-4 w-4" />}
          positivo={resumo.liq30 >= 0} negativo={resumo.liq30 < 0} />
        <CardKpi
          rotulo="Menor saldo projetado"
          valor={resumo.vale?.valor ?? 0}
          icone={<TrendingDown className="h-4 w-4" />}
          negativo={(resumo.vale?.valor ?? 0) < 0}
          hint={resumo.vale ? format(parseISO(resumo.vale.dia), "dd 'de' MMM", { locale: ptBR }) : ""}
        />
      </div>

      {/* Como a projeção é calculada — legenda completa, colapsável */}
      <ComoCalculado />

      {carregando ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <Card className="p-5">
          <p className="text-[14.5px] font-semibold tracking-[-0.015em] mb-3">Entradas × Saídas × Saldo projetado</p>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="dia" tickFormatter={(v) => format(parseISO(v), "dd/MM")}
                  stroke="var(--color-muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`}
                  stroke="var(--color-muted-foreground)" fontSize={10} tickLine={false} axisLine={false} width={44} />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const row = (payload[0]?.payload ?? {}) as (typeof chartData)[number];
                    return (
                      <div style={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 12, padding: "8px 12px" }}>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>{format(parseISO(String(label)), "dd 'de' MMM", { locale: ptBR })}</p>
                        <p style={{ color: "#0E8A5F" }}>Entrada real: {formatBRL(row.entradaReal)}</p>
                        <p style={{ color: "#7A5CC7" }}>Entrada estimada: {formatBRL(row.entradaEstimada)}</p>
                        <p style={{ color: "#C9432F" }}>Saídas: {formatBRL(Math.abs(row.saida))}</p>
                        <p style={{ fontWeight: 600 }}>Saldo projetado: {formatBRL(row.saldoProjetado)}</p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="var(--color-border)" />
                <Bar dataKey="entradaReal" name="Entrada real" stackId="f" fill="#0E8A5F" />
                <Bar dataKey="entradaEstimada" name="Entrada estimada" stackId="f" fill="#7A5CC7" />
                <Bar dataKey="saida" name="Saídas" stackId="f" fill="#C9432F" />
                <Line type="monotone" dataKey="saldoProjetado" name="Saldo projetado" stroke="#B7791F" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Tabela por dia com drill de eventos */}
      <Card className="p-4">
        <p className="text-[14.5px] font-semibold tracking-[-0.015em] mb-2">Dia a dia</p>
        <table className="w-full text-sm">
          <thead className="text-[10.5px] uppercase text-muted-foreground">
            <tr className="border-b">
              <th className="w-7"></th>
              <th className="text-left py-1.5 pr-2 font-medium">Dia</th>
              <th className="text-right py-1.5 pr-2 font-medium">Entradas</th>
              <th className="text-right py-1.5 pr-2 font-medium">Saídas</th>
              <th className="text-right py-1.5 pr-2 font-medium">Líquido</th>
              <th className="text-right py-1.5 font-medium">Saldo projetado</th>
            </tr>
          </thead>
          <tbody>
            {dias.map((d) => {
              const aberto = expandido.has(d.dia);
              const eventos = eventosPorDia.get(d.dia) ?? [];
              const saldo = saldoInicial + n(d.acumulado);
              return [
                <tr key={d.dia} className="border-b last:border-0 cursor-pointer hover:bg-muted/40" onClick={() => toggle(d.dia)}>
                  <td className="py-1.5">{aberto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</td>
                  <td className="py-1.5 pr-2 font-medium whitespace-nowrap">
                    {format(parseISO(d.dia), "EEE dd/MM", { locale: ptBR })}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-mono text-emerald-700 dark:text-emerald-400">
                    {n(d.entradas) > 0 ? formatBRL(n(d.entradas)) : "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-mono text-red-700 dark:text-red-400">
                    {n(d.saidas) > 0 ? formatBRL(n(d.saidas)) : "—"}
                  </td>
                  <td className={cn("py-1.5 pr-2 text-right tabular-nums font-mono", n(d.liquido) < 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
                    {formatBRL(n(d.liquido))}
                  </td>
                  <td className={cn("py-1.5 text-right tabular-nums font-mono font-semibold", saldo < 0 && "text-red-700 dark:text-red-400")}>
                    {formatBRL(saldo)}
                  </td>
                </tr>,
                aberto ? (
                  <tr key={`${d.dia}-ev`}>
                    <td></td>
                    <td colSpan={5} className="pb-2">
                      <div className="flex flex-col gap-0.5 pl-1 border-l-2 border-muted ml-1">
                        {eventos.map((e, i) => (
                          <div key={i} className="flex items-center gap-2 text-[12px] pl-2">
                            <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", e.fluxo === "entrada" ? "bg-emerald-500" : "bg-red-500")} />
                            <span className="flex-1 min-w-0 truncate">
                              {e.origem}
                              {e.detalhe && (
                                <span className="text-muted-foreground text-[11px]"> — {e.detalhe}</span>
                              )}
                            </span>
                            {e.confianca === "estimado" && (
                              <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground shrink-0">estimado</span>
                            )}
                            <span className="text-muted-foreground text-[11px] tabular-nums shrink-0">{e.itens}×</span>
                            <span className={cn("tabular-nums font-mono w-[96px] text-right shrink-0", e.fluxo === "saida" && "text-red-700 dark:text-red-400")}>
                              {e.fluxo === "saida" ? "−" : ""}{formatBRL(n(e.valor))}
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ComoCalculado() {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="text-[12px] text-muted-foreground bg-muted/40 border rounded-md px-3 py-2">
      <button type="button" onClick={() => setAberto((v) => !v)} className="flex items-center gap-2 w-full text-left">
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium text-foreground">Como esta projeção é calculada</span>
        {aberto ? <ChevronDown className="h-3.5 w-3.5 ml-auto" /> : <ChevronRight className="h-3.5 w-3.5 ml-auto" />}
      </button>
      {aberto && (
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li><strong className="text-foreground">Entradas ML</strong> — data <em>real</em> de liberação informada pelo Mercado Pago, pagamento a pagamento.</li>
          <li><strong className="text-foreground">Entradas Shopee</strong> — estimadas por pedido: data do pedido + 8 dias (mediana medida em 12,7 mil créditos reais das duas lojas). Pedidos "atrasados" no funil são distribuídos na janela típica do estágio: liberação 1–2 dias, entregue 1–4, em trânsito 3–7, a enviar 6–11.</li>
          <li><strong className="text-foreground">Contas a pagar</strong> — cada conta em aberto do Tiny, no vencimento; <em>vencida cai em HOJE</em>. Expanda o dia para ver fornecedor e categoria.</li>
          <li><strong className="text-foreground">ADS</strong> — regra da casa: dia <strong>10</strong> paga o gasto de ADS do mês anterior (Shopee + ML). Competência em curso é extrapolada pro-rata.</li>
          <li><strong className="text-foreground">Impostos</strong> — regra da casa: dia <strong>20</strong> paga o imposto sobre vendas do mês anterior. Competência em curso extrapolada pro-rata.</li>
          <li><strong className="text-foreground">Gastos recorrentes</strong> — cadastrados no DRE, lançados no dia 5 de cada mês (premissa).</li>
          <li><strong className="text-foreground">Limite do modelo</strong> — só entram pedidos que <em>já existem</em>: as entradas Shopee drenam em ~10 dias e, além disso, o saldo projetado é <em>conservador</em> (vendas futuras não são inventadas). Saldo inicial = carteiras Shopee (o ML não expõe saldo).</li>
        </ul>
      )}
    </div>
  );
}

function CardKpi({ rotulo, valor, icone, hint, positivo, negativo }: {
  rotulo: string; valor: number; icone: React.ReactNode; hint?: string;
  positivo?: boolean; negativo?: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icone} {rotulo}
      </div>
      <p className={cn("text-xl font-semibold tabular-nums mt-1",
        negativo ? "text-red-700 dark:text-red-400" : positivo ? "text-emerald-700 dark:text-emerald-400" : "")}>
        {formatBRL(valor)}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5">{hint}</p>}
    </Card>
  );
}
