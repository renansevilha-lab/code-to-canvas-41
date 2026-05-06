import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Hourglass,
  Receipt,
  Trash2,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { UploadDropzone } from "@/components/UploadDropzone";
import { KpiCard } from "@/components/KpiCard";

import { processarArquivosCarteira } from "@/lib/carteira/parser";
import {
  getAllCarteira,
  limparCarteira,
  salvarCarteira,
} from "@/lib/carteira/storage";
import {
  calcularResumoCarteira,
  calcularResumoConciliacao,
  conciliarPedidos,
  fluxoDiario,
} from "@/lib/carteira/aggregations";
import type {
  ConciliacaoPedido,
  TransacaoCarteira,
} from "@/lib/carteira/types";

import { getAllPedidos } from "@/lib/vendas/storage";
import type { Pedido } from "@/lib/vendas/types";

import { formatBRL, formatDate, formatNumber } from "@/lib/format";

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

export const Route = createFileRoute("/carteira")({
  component: CarteiraPage,
  head: () => ({
    meta: [
      { title: "Carteira — Shopee Analytics" },
      {
        name: "description",
        content:
          "Pago vs a receber por pedido cruzando o extrato da carteira Shopee com seus pedidos.",
      },
    ],
  }),
});

type StatusFiltro = "todos" | "Pago" | "A receber" | "Reembolsado" | "Cancelado";

function CarteiraPage() {
  const [carteira, setCarteira] = useState<TransacaoCarteira[]>([]);
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState<StatusFiltro>("todos");

  const recarregar = async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([getAllCarteira(), getAllPedidos()]);
      setCarteira(c);
      setPedidos(p);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recarregar();
  }, []);

  const periodoExtrato = useMemo(() => {
    if (carteira.length === 0) return { ini: null, fim: null };
    let ini = carteira[0].data;
    let fim = carteira[0].data;
    for (const r of carteira) {
      if (r.data < ini) ini = r.data;
      if (r.data > fim) fim = r.data;
    }
    return { ini, fim };
  }, [carteira]);

  const resumo = useMemo(() => calcularResumoCarteira(carteira), [carteira]);
  const fluxo = useMemo(() => fluxoDiario(carteira), [carteira]);

  // Conciliação só de pedidos do período do extrato
  const pedidosPeriodo = useMemo(() => {
    if (!periodoExtrato.ini || !periodoExtrato.fim) return [];
    return pedidos.filter(
      (p) =>
        p.data_pedido >= periodoExtrato.ini! &&
        p.data_pedido <= periodoExtrato.fim!
    );
  }, [pedidos, periodoExtrato]);

  const conciliacao = useMemo(
    () => conciliarPedidos(pedidosPeriodo, carteira),
    [pedidosPeriodo, carteira]
  );
  const resumoConc = useMemo(
    () => calcularResumoConciliacao(conciliacao),
    [conciliacao]
  );

  const conciliacaoFiltrada = useMemo(() => {
    let arr = conciliacao;
    if (statusFiltro !== "todos") {
      arr = arr.filter((c) => c.status_recebimento === statusFiltro);
    }
    if (busca) {
      const q = busca.toLowerCase();
      arr = arr.filter((c) => c.id_pedido.toLowerCase().includes(q));
    }
    return arr.sort((a, b) => (a.data_pedido < b.data_pedido ? 1 : -1));
  }, [conciliacao, statusFiltro, busca]);

  const handleFiles = async (files: File[]) => {
    setImporting(true);
    try {
      const r = await processarArquivosCarteira(files);
      if (r.rows.length === 0) {
        toast.error("Nenhuma transação encontrada", {
          description:
            r.warnings[0] ?? "Verifique se é o extrato 'Minha Carteira'.",
        });
        return;
      }
      const { novos, atualizados } = await salvarCarteira(r.rows);
      toast.success(`${r.rows.length} transações importadas`, {
        description: `${novos} novas, ${atualizados} atualizadas`,
      });
      if (r.warnings.length) console.warn("Carteira:", r.warnings);
      await recarregar();
    } catch (e) {
      toast.error("Erro ao importar", { description: (e as Error).message });
    } finally {
      setImporting(false);
    }
  };

  const handleLimpar = async () => {
    await limparCarteira();
    toast.success("Extrato removido");
    await recarregar();
  };

  if (loading) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        Carregando…
      </div>
    );
  }

  if (carteira.length === 0) {
    return <EstadoVazio onFiles={handleFiles} importing={importing} />;
  }

  const semPedidos = pedidos.length === 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
            Carteira
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatNumber(resumo.n_transacoes)} transações
            {periodoExtrato.ini && periodoExtrato.fim && (
              <>
                {" · "}
                {formatDate(periodoExtrato.ini)} → {formatDate(periodoExtrato.fim)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NovoUploadDialog onFiles={handleFiles} importing={importing} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" title="Limpar extrato">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Apagar todo o extrato?</AlertDialogTitle>
                <AlertDialogDescription>
                  Vai remover {formatNumber(resumo.n_transacoes)} transações.
                  Pedidos e CMV não são afetados.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleLimpar}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Apagar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      {semPedidos && (
        <Card className="p-4 border-warning/30 bg-warning/5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning-foreground shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Sem pedidos para cruzar.</p>
            <p className="text-muted-foreground mt-0.5">
              Importe pedidos no módulo Vendas para ver Pago vs A receber.
            </p>
          </div>
        </Card>
      )}

      {/* KPIs financeiros */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KpiCard
          label="Saldo atual"
          value={formatBRL(resumo.saldo_atual)}
          hint="último saldo registrado no extrato"
          icon={<Wallet className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="Entradas"
          value={formatBRL(resumo.entradas_total)}
          hint={`${formatNumber(carteira.filter((r) => r.valor >= 0).length)} créditos`}
          icon={<ArrowUpRight className="h-4 w-4" />}
          accent="success"
        />
        <KpiCard
          label="Saídas"
          value={formatBRL(Math.abs(resumo.saidas_total))}
          hint={`${formatNumber(carteira.filter((r) => r.valor < 0).length)} débitos`}
          icon={<ArrowDownLeft className="h-4 w-4" />}
          accent="destructive"
        />
        <KpiCard
          label="Resultado do período"
          value={formatBRL(resumo.saldo_periodo)}
          hint="entradas − saídas no extrato"
          icon={<Coins className="h-4 w-4" />}
          accent={resumo.saldo_periodo >= 0 ? "success" : "destructive"}
        />
      </section>

      {/* KPIs conciliação */}
      {!semPedidos && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <KpiCard
            label="Pedidos pagos"
            value={formatNumber(resumoConc.pagos.n)}
            hint={`recebido ${formatBRL(resumoConc.pagos.valor)}`}
            icon={<Receipt className="h-4 w-4" />}
            accent="success"
          />
          <KpiCard
            label="A receber"
            value={formatNumber(resumoConc.a_receber.n)}
            hint={`estimado ${formatBRL(resumoConc.a_receber.valor)}`}
            icon={<Hourglass className="h-4 w-4" />}
            accent="warning"
          />
          <KpiCard
            label="Reembolsados"
            value={formatNumber(resumoConc.reembolsados.n)}
            hint={`estornado ${formatBRL(resumoConc.reembolsados.valor)}`}
            icon={<ArrowDownLeft className="h-4 w-4" />}
            accent="destructive"
          />
          <KpiCard
            label="Diferença vs estimado"
            value={formatBRL(resumoConc.diferenca_total)}
            hint="recebido − renda estimada (pagos)"
            icon={<Coins className="h-4 w-4" />}
            accent={
              Math.abs(resumoConc.diferenca_total) < 1
                ? "success"
                : resumoConc.diferenca_total > 0
                  ? "success"
                  : "destructive"
            }
          />
        </section>
      )}

      {/* Fluxo diário */}
      <Card className="p-5">
        <header className="mb-4">
          <h3 className="font-semibold text-foreground">Fluxo diário</h3>
          <p className="text-xs text-muted-foreground">
            Entradas e saídas por dia, com saldo líquido (linha)
          </p>
        </header>
        {fluxo.length === 0 ? (
          <EmptyChart />
        ) : (
          <div className="h-[320px] w-full">
            <ResponsiveContainer>
              <ComposedChart
                data={fluxo}
                margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="data"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) =>
                    formatBRL(v, { compact: true }).replace("R$", "")
                  }
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  dataKey="entradas"
                  name="Entradas"
                  fill="var(--chart-1)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                />
                <Bar
                  dataKey="saidas"
                  name="Saídas"
                  fill="var(--chart-3)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                />
                <Line
                  type="monotone"
                  dataKey="liquido"
                  name="Líquido"
                  stroke="var(--chart-5)"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="pedidos">
        <TabsList>
          <TabsTrigger value="pedidos">
            Pedidos
            {!semPedidos && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                {formatNumber(conciliacao.length)}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="extrato">
            Extrato
            <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
              {formatNumber(carteira.length)}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="tipos">Por tipo</TabsTrigger>
        </TabsList>

        <TabsContent value="pedidos">
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <Input
              placeholder="Buscar ID do pedido…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="max-w-sm"
            />
            <div className="flex items-center gap-1 flex-wrap">
              {(
                ["todos", "Pago", "A receber", "Reembolsado", "Cancelado"] as StatusFiltro[]
              ).map((s) => (
                <Button
                  key={s}
                  variant={statusFiltro === s ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFiltro(s)}
                >
                  {s === "todos" ? "Todos" : s}
                </Button>
              ))}
            </div>
          </div>
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pedido</TableHead>
                  <TableHead>Data pedido</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">GMV</TableHead>
                  <TableHead className="text-right">Renda estimada</TableHead>
                  <TableHead className="text-right">Recebido</TableHead>
                  <TableHead className="text-right">Estornado</TableHead>
                  <TableHead className="text-right">Líquido</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                  <TableHead>Recebido em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conciliacaoFiltrada.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="text-center text-muted-foreground py-8"
                    >
                      Nenhum pedido encontrado
                    </TableCell>
                  </TableRow>
                ) : (
                  conciliacaoFiltrada.slice(0, 200).map((c) => (
                    <LinhaPedido key={c.id_pedido} c={c} />
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
          {conciliacaoFiltrada.length > 200 && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Mostrando 200 de {formatNumber(conciliacaoFiltrada.length)} pedidos
            </p>
          )}
        </TabsContent>

        <TabsContent value="extrato">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Pedido</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead className="text-right">Saldo após</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {carteira.slice(0, 300).map((t) => (
                  <TableRow key={t.chave}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {t.data_hora}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">
                        {t.tipo}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground">
                      {t.descricao}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {t.id_pedido || "—"}
                    </TableCell>
                    <TableCell
                      className={
                        "text-right tabular-nums font-medium " +
                        (t.valor >= 0 ? "text-success" : "text-destructive")
                      }
                    >
                      {formatBRL(t.valor)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatBRL(t.saldo_apos)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {carteira.length > 300 && (
            <p className="text-xs text-muted-foreground text-center mt-2">
              Mostrando 300 de {formatNumber(carteira.length)} transações
            </p>
          )}
        </TabsContent>

        <TabsContent value="tipos">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="text-right">Transações</TableHead>
                  <TableHead className="text-right">Valor líquido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resumo.por_tipo.map((t) => (
                  <TableRow key={t.tipo}>
                    <TableCell>{t.tipo}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(t.n)}
                    </TableCell>
                    <TableCell
                      className={
                        "text-right tabular-nums font-medium " +
                        (t.valor >= 0 ? "text-success" : "text-destructive")
                      }
                    >
                      {formatBRL(t.valor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LinhaPedido({ c }: { c: ConciliacaoPedido }) {
  const cor =
    c.status_recebimento === "Pago"
      ? "text-success border-success/40 bg-success/10"
      : c.status_recebimento === "A receber"
        ? "text-warning-foreground border-warning/40 bg-warning/10"
        : c.status_recebimento === "Reembolsado"
          ? "text-destructive border-destructive/40 bg-destructive/10"
          : "text-muted-foreground border-border bg-muted";
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{c.id_pedido}</TableCell>
      <TableCell className="text-xs whitespace-nowrap">
        {formatDate(c.data_pedido)}
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={"text-[10px] " + cor}>
          {c.status_recebimento}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatBRL(c.valor_total)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatBRL(c.renda_estimada)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-success">
        {c.recebido > 0 ? formatBRL(c.recebido) : "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums text-destructive">
        {c.estornado > 0 ? formatBRL(c.estornado) : "—"}
      </TableCell>
      <TableCell
        className={
          "text-right tabular-nums font-medium " +
          (c.liquido >= 0 ? "text-foreground" : "text-destructive")
        }
      >
        {formatBRL(c.liquido)}
      </TableCell>
      <TableCell
        className={
          "text-right tabular-nums " +
          (Math.abs(c.diferenca) < 0.01
            ? "text-muted-foreground"
            : c.diferenca > 0
              ? "text-success"
              : "text-destructive")
        }
      >
        {c.recebido > 0 ? formatBRL(c.diferenca) : "—"}
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
        {c.data_recebimento ?? "—"}
      </TableCell>
    </TableRow>
  );
}

function EstadoVazio({
  onFiles,
  importing,
}: {
  onFiles: (files: File[]) => void;
  importing: boolean;
}) {
  return (
    <div className="p-6 md:p-10 max-w-3xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          Carteira
        </h1>
        <p className="text-muted-foreground">
          Importe o extrato da Shopee (Minha Carteira → Extrato →{" "}
          <em>balance_transaction_report</em>) para ver Pago vs A receber por
          pedido.
        </p>
      </header>
      <UploadDropzone
        onFiles={onFiles}
        accept=".xlsx,.xls,.csv"
        title="Solte aqui o extrato da carteira"
        hint="Aceita o arquivo balance_transaction_report.shopee.*.xlsx exportado em Minha Carteira → Extrato."
        loading={importing}
      />
    </div>
  );
}

function NovoUploadDialog({
  onFiles,
  importing,
}: {
  onFiles: (files: File[]) => void;
  importing: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={importing}
      >
        Importar extrato
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFiles(Array.from(e.target.files));
            e.target.value = "";
          }
        }}
      />
    </>
  );
}

function EmptyChart() {
  return (
    <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
      Sem dados pra exibir.
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; dataKey: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border bg-popover p-2.5 text-xs shadow-md">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: p.color }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">{formatBRL(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
