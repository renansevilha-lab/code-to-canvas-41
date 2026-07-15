import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Info, Wallet } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/carteira-saldos")({
  component: CarteiraSaldosPage,
});

interface SaldoRow {
  carteira: string;
  marketplace: string;
  shop_id: number;
  saldo_em_conta: number;
  a_receber_estimado: number;
  pedidos_a_receber: number;
  natureza_a_receber: string;
}

interface LiberacaoRow {
  carteira: string;
  dia: string;
  pagamentos: number;
  valor_a_liberar: number;
}

const MKT_STYLE: Record<
  string,
  { border: string; bg: string; text: string; label: string }
> = {
  shopee: {
    border: "border-l-orange-500",
    bg: "bg-orange-500/10",
    text: "text-orange-600 dark:text-orange-400",
    label: "Shopee",
  },
  mercadolivre: {
    border: "border-l-yellow-400",
    bg: "bg-yellow-400/10",
    text: "text-yellow-700 dark:text-yellow-400",
    label: "Mercado Livre",
  },
};

function formatDia(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function CarteiraCard({ row }: { row: SaldoRow }) {
  const style = MKT_STYLE[row.marketplace] ?? {
    border: "border-l-muted",
    bg: "bg-muted",
    text: "text-foreground",
    label: row.marketplace,
  };
  const total = (row.saldo_em_conta ?? 0) + (row.a_receber_estimado ?? 0);
  const isML = row.marketplace === "mercadolivre";
  const isShopee = row.marketplace === "shopee";

  return (
    <Card className={cn("p-5 border-l-4 shadow-sm", style.border)}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className={cn("text-xs font-semibold uppercase tracking-wide", style.text)}>
            {style.label}
          </p>
          <p className="text-sm font-medium text-foreground">{row.carteira}</p>
        </div>
        <div className={cn("rounded-md w-9 h-9 flex items-center justify-center", style.bg)}>
          <Wallet className={cn("h-4 w-4", style.text)} />
        </div>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight mb-4">
        {formatBRL(total)}
      </p>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Disponível</span>
          <span className="font-medium tabular-nums">
            {isML ? "—" : formatBRL(row.saldo_em_conta ?? 0)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground flex items-center gap-1">
            A receber
            {isShopee && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="h-3 w-3 text-muted-foreground/70" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Estimativa — pedidos concluídos com repasse previsto ainda não creditado (superestima ~1,9%).
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </span>
          <span className="font-medium tabular-nums text-right">
            {formatBRL(row.a_receber_estimado ?? 0)}
            <span className="text-xs text-muted-foreground ml-1">
              ({formatNumber(row.pedidos_a_receber ?? 0)} ped.)
            </span>
          </span>
        </div>
      </div>
      {isML && (
        <p className="mt-3 text-[11px] text-muted-foreground italic">
          Saldo em conta do ML ainda não é coletado.
        </p>
      )}
    </Card>
  );
}

function TotalCard({ rows }: { rows: SaldoRow[] }) {
  const disponivel = rows
    .filter((r) => r.marketplace !== "mercadolivre")
    .reduce((s, r) => s + (r.saldo_em_conta ?? 0), 0);
  const aReceber = rows.reduce((s, r) => s + (r.a_receber_estimado ?? 0), 0);
  const total = disponivel + aReceber;
  return (
    <Card className="p-5 border-l-4 border-l-primary shadow-sm bg-primary/5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            Total
          </p>
          <p className="text-sm font-medium text-foreground">Todas as carteiras</p>
        </div>
        <div className="rounded-md w-9 h-9 flex items-center justify-center bg-primary/10">
          <Wallet className="h-4 w-4 text-primary" />
        </div>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight mb-4">
        {formatBRL(total)}
      </p>
      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Disponível</span>
          <span className="font-medium tabular-nums">{formatBRL(disponivel)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">A receber</span>
          <span className="font-medium tabular-nums">{formatBRL(aReceber)}</span>
        </div>
      </div>
    </Card>
  );
}

function CarteiraSaldosPage() {
  const [saldos, setSaldos] = useState<SaldoRow[] | null>(null);
  const [liberacoes, setLiberacoes] = useState<LiberacaoRow[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [s, l] = await Promise.all([
          supabaseExternal.from("view_carteira_saldo").select("*"),
          supabaseExternal
            .from("view_carteira_liberacao_diaria")
            .select("*")
            .order("dia", { ascending: true }),
        ]);
        if (cancel) return;
        if (s.error) throw s.error;
        if (l.error) throw l.error;
        setSaldos((s.data ?? []) as SaldoRow[]);
        setLiberacoes((l.data ?? []) as LiberacaoRow[]);
      } catch (e) {
        if (!cancel) setErro(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const totalLiberar = (liberacoes ?? []).reduce(
    (s, r) => s + (r.valor_a_liberar ?? 0),
    0,
  );

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Carteira</h1>
        <p className="text-sm text-muted-foreground">
          Saldo por marketplace: disponível hoje e o que ainda vai entrar.
        </p>
      </div>

      {erro && (
        <Card className="p-4 border-destructive text-destructive text-sm">
          Erro ao carregar: {erro}
        </Card>
      )}

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {saldos === null
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-44" />
            ))
          : (
            <>
              {saldos.map((r) => (
                <CarteiraCard key={r.shop_id} row={r} />
              ))}
              <TotalCard rows={saldos} />
            </>
          )}
      </div>

      <Card className="p-5">
        <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">
              Mercado Livre — o que ainda vai liberar
            </h2>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <Info className="h-3 w-3" />
              Apenas ML informa data de liberação. Shopee mostra só o total a
              receber (acima), sem cronograma.
            </p>
          </div>
          {liberacoes && (
            <div className="text-right">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                Total agendado
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {formatBRL(totalLiberar)}
              </p>
            </div>
          )}
        </div>

        {liberacoes === null ? (
          <Skeleton className="h-64 w-full" />
        ) : liberacoes.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Sem liberações agendadas.
          </p>
        ) : (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={liberacoes} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="dia"
                  tickFormatter={formatDia}
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis
                  tickFormatter={(v: number) =>
                    v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
                  }
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <RTooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v: number, _n, p) => [
                    formatBRL(v),
                    `${p.payload.pagamentos} pagamento${p.payload.pagamentos === 1 ? "" : "s"}`,
                  ]}
                  labelFormatter={(l: string) => `Dia ${formatDia(l)}`}
                />
                <Bar
                  dataKey="valor_a_liberar"
                  fill="hsl(48 96% 53%)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
