import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  AlertTriangle,
  CircleDollarSign,
  Database,
  Package,
  Percent,
  Receipt,
  RefreshCw,
  ShoppingBag,
  Trash2,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { PeriodFilter } from "@/components/PeriodFilter";

import { processarArquivosVendas } from "@/lib/vendas/parser";
import {
  getAllItens,
  getAllPedidos,
  limparTudoVendas,
  salvarItens,
  salvarPedidos,
} from "@/lib/vendas/storage";
import {
  calcularCancelamentos,
  calcularComposicao,
  calcularKPIs,
  calcularPorEnvio,
  calcularPorUF,
  calcularResumoDiario,
  calcularTopSKUs,
  filtrarPeriodo,
  periodoAnterior,
  type PeriodoKey,
} from "@/lib/vendas/aggregations";
import type { ItemPedido, Pedido } from "@/lib/vendas/types";
import { formatBRL, formatDate, formatDelta, formatNumber, formatPercent } from "@/lib/format";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/vendas")({
  component: VendasPage,
  head: () => ({
    meta: [
      { title: "Vendas — Shopee Analytics" },
      {
        name: "description",
        content:
          "Dashboard de pedidos da Shopee: GMV, ticket médio, taxas, cancelamentos, top SKUs e vendas por UF.",
      },
    ],
  }),
});

function VendasPage() {
  const router = useRouter();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [itens, setItens] = useState<ItemPedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [periodo, setPeriodo] = useState<PeriodoKey>("30d");

  // Carrega dados do IndexedDB
  const recarregar = async () => {
    setLoading(true);
    try {
      const [p, i] = await Promise.all([getAllPedidos(), getAllItens()]);
      setPedidos(p);
      setItens(i);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recarregar();
  }, []);

  // Data máxima global (pra calcular janela)
  const dataMax = useMemo(() => {
    if (pedidos.length === 0) return null;
    return pedidos.reduce(
      (max, p) => (p.data_pedido > max ? p.data_pedido : max),
      ""
    ) || null;
  }, [pedidos]);

  // Filtragem por período
  const pedidosPeriodo = useMemo(
    () => filtrarPeriodo(pedidos, periodo, dataMax),
    [pedidos, periodo, dataMax]
  );
  const itensPeriodo = useMemo(
    () => filtrarPeriodo(itens, periodo, dataMax),
    [itens, periodo, dataMax]
  );
  const pedidosAnterior = useMemo(
    () => periodoAnterior(pedidos, periodo, dataMax),
    [pedidos, periodo, dataMax]
  );

  const kpis = useMemo(
    () => calcularKPIs(pedidosPeriodo, itensPeriodo),
    [pedidosPeriodo, itensPeriodo]
  );
  const kpisAnt = useMemo(
    () => calcularKPIs(pedidosAnterior, []),
    [pedidosAnterior]
  );

  const resumoDiario = useMemo(
    () => calcularResumoDiario(pedidosPeriodo),
    [pedidosPeriodo]
  );
  const composicao = useMemo(
    () => calcularComposicao(pedidosPeriodo),
    [pedidosPeriodo]
  );
  const topSkus = useMemo(() => calcularTopSKUs(itensPeriodo, 15), [itensPeriodo]);
  const porUF = useMemo(() => calcularPorUF(pedidosPeriodo), [pedidosPeriodo]);
  const porEnvio = useMemo(() => calcularPorEnvio(pedidosPeriodo), [pedidosPeriodo]);
  const cancelamentos = useMemo(
    () => calcularCancelamentos(pedidosPeriodo),
    [pedidosPeriodo]
  );

  // Upload
  const handleFiles = async (files: File[]) => {
    setImporting(true);
    try {
      const r = await processarArquivosVendas(files);
      if (r.pedidos.length === 0) {
        toast.error("Nenhum pedido encontrado nos arquivos.", {
          description: r.warnings[0] ?? "Verifique se é o relatório Order.all da Shopee.",
        });
        return;
      }
      const { novos, atualizados } = await salvarPedidos(r.pedidos);
      await salvarItens(r.itens);
      toast.success(`${r.pedidos_unicos} pedidos processados`, {
        description: `${novos} novos, ${atualizados} atualizados — ${r.itens.length} SKUs`,
      });
      if (r.warnings.length) {
        console.warn("Avisos:", r.warnings);
      }
      await recarregar();
      router.invalidate();
    } catch (e) {
      toast.error("Erro ao processar", {
        description: (e as Error).message,
      });
    } finally {
      setImporting(false);
    }
  };

  const handleLimpar = async () => {
    await limparTudoVendas();
    toast.success("Dados de vendas removidos");
    await recarregar();
  };

  // Estado inicial: sem dados (também mostra durante loading inicial pra evitar flash de "zeros")
  if (pedidos.length === 0) {
    if (loading) {
      return (
        <div className="p-10 text-center text-sm text-muted-foreground">
          Carregando…
        </div>
      );
    }
    return <EstadoVazio onFiles={handleFiles} importing={importing} />;
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
            Vendas
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {pedidos.length > 0 && dataMax && (
              <>
                Histórico de {formatNumber(pedidos.length)} pedidos · última data{" "}
                {formatDate(dataMax)}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodFilter value={periodo} onChange={setPeriodo} />
          <NovoUploadDialog onFiles={handleFiles} importing={importing} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" title="Limpar dados">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Apagar todos os dados de vendas?</AlertDialogTitle>
                <AlertDialogDescription>
                  Vai remover todos os {formatNumber(pedidos.length)} pedidos e{" "}
                  {formatNumber(itens.length)} itens armazenados localmente. Você
                  poderá importar novamente os arquivos depois.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleLimpar}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Apagar tudo
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      {/* KPIs */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KpiCard
          label="GMV"
          value={formatBRL(kpis.gmv)}
          delta={formatDelta(kpis.gmv, kpisAnt.gmv)}
          betterDirection="up"
          icon={<CircleDollarSign className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="Pedidos válidos"
          value={formatNumber(kpis.pedidos)}
          delta={formatDelta(kpis.pedidos, kpisAnt.pedidos)}
          betterDirection="up"
          icon={<ShoppingBag className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="Ticket médio"
          value={formatBRL(kpis.ticket_medio)}
          delta={formatDelta(kpis.ticket_medio, kpisAnt.ticket_medio)}
          betterDirection="up"
          icon={<Receipt className="h-4 w-4" />}
          accent="success"
        />
        <KpiCard
          label="Itens vendidos"
          value={formatNumber(kpis.itens_vendidos)}
          delta={formatDelta(kpis.itens_vendidos, kpisAnt.itens_vendidos)}
          betterDirection="up"
          icon={<Package className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="Taxas Shopee"
          value={formatBRL(kpis.total_taxas)}
          hint={`${formatPercent(kpis.pct_taxas)} do GMV`}
          delta={formatDelta(kpis.pct_taxas, kpisAnt.pct_taxas)}
          betterDirection="down"
          icon={<Percent className="h-4 w-4" />}
          accent="warning"
        />
        <KpiCard
          label="Renda estimada"
          value={formatBRL(kpis.renda_estimada)}
          hint="subtotal − taxas − imposto"
          delta={formatDelta(kpis.renda_estimada, kpisAnt.renda_estimada)}
          betterDirection="up"
          icon={<Wallet className="h-4 w-4" />}
          accent="success"
        />
        <KpiCard
          label="Margem estimada"
          value={formatPercent(kpis.margem_pct)}
          hint="renda / subtotal"
          delta={formatDelta(kpis.margem_pct, kpisAnt.margem_pct)}
          betterDirection="up"
          icon={<TrendingUp className="h-4 w-4" />}
          accent="success"
        />
        <KpiCard
          label="Cancelamentos"
          value={`${formatNumber(kpis.cancelados)}`}
          hint={`${formatPercent(kpis.taxa_cancelamento_pct)} do total`}
          delta={formatDelta(kpis.taxa_cancelamento_pct, kpisAnt.taxa_cancelamento_pct)}
          betterDirection="down"
          icon={<AlertTriangle className="h-4 w-4" />}
          accent="destructive"
        />
      </section>

      {/* Gráficos lado a lado */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <header className="mb-4">
            <h3 className="font-semibold text-foreground">Evolução diária</h3>
            <p className="text-xs text-muted-foreground">
              GMV (barras) e número de pedidos (linha)
            </p>
          </header>
          {resumoDiario.length === 0 ? (
            <EmptyChart />
          ) : (
            <div className="h-[280px] w-full">
              <ResponsiveContainer>
                <ComposedChart
                  data={resumoDiario}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="data"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(v: number) =>
                      formatBRL(v, { compact: true }).replace("R$", "")
                    }
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    yAxisId="left"
                    dataKey="gmv"
                    name="GMV"
                    fill="var(--chart-1)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="pedidos_validos"
                    name="Pedidos"
                    stroke="var(--chart-3)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "var(--chart-3)" }}
                    activeDot={{ r: 5 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <header className="mb-4">
            <h3 className="font-semibold text-foreground">
              Composição financeira
            </h3>
            <p className="text-xs text-muted-foreground">
              Pra onde vai cada R$ de GMV
            </p>
          </header>
          <DonutComposicao composicao={composicao} />
        </Card>
      </section>

      {/* Tabs analíticas */}
      <Tabs defaultValue="skus">
        <TabsList>
          <TabsTrigger value="skus">Top SKUs</TabsTrigger>
          <TabsTrigger value="uf">Por UF</TabsTrigger>
          <TabsTrigger value="envio">Por envio</TabsTrigger>
          <TabsTrigger value="cancel">
            Cancelamentos {cancelamentos.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                {cancelamentos.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="skus">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Qtd</TableHead>
                  <TableHead className="text-right">Pedidos</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topSkus.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      Nenhum dado no período
                    </TableCell>
                  </TableRow>
                ) : (
                  topSkus.map((s, i) => (
                    <TableRow key={`${s.sku}-${i}`}>
                      <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                      <TableCell className="font-mono text-xs">{s.sku}</TableCell>
                      <TableCell className="max-w-md truncate">{s.produto}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.qtd_vendida)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.pedidos)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatBRL(s.receita)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="uf">
          <Card className="p-5">
            {porUF.length === 0 ? (
              <EmptyChart />
            ) : (
              <div className="h-[340px] w-full">
                <ResponsiveContainer>
                  <BarChart
                    data={porUF.slice(0, 15)}
                    layout="vertical"
                    margin={{ top: 5, right: 24, left: 8, bottom: 5 }}
                  >
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickFormatter={(v: number) =>
                        formatBRL(v, { compact: true }).replace("R$", "")
                      }
                    />
                    <YAxis
                      type="category"
                      dataKey="uf"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      width={40}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="gmv" name="GMV" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="envio">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opção de envio</TableHead>
                  <TableHead className="text-right">Pedidos</TableHead>
                  <TableHead className="text-right">GMV</TableHead>
                  <TableHead className="text-right">Ticket médio</TableHead>
                  <TableHead className="text-right">Renda estimada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {porEnvio.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      Nenhum dado
                    </TableCell>
                  </TableRow>
                ) : (
                  porEnvio.map((e) => (
                    <TableRow key={e.opcao_envio}>
                      <TableCell className="font-medium">{e.opcao_envio}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(e.pedidos)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBRL(e.gmv)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBRL(e.ticket_medio)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatBRL(e.renda_estimada)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="cancel">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motivo</TableHead>
                  <TableHead className="text-right">Quantidade</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cancelamentos.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={2} className="text-center text-muted-foreground py-8">
                      Nenhum cancelamento no período 🎉
                    </TableCell>
                  </TableRow>
                ) : (
                  cancelamentos.map((c) => (
                    <TableRow key={c.motivo}>
                      <TableCell className="max-w-2xl">{c.motivo}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatNumber(c.quantidade)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Tabela completa de pedidos */}
      <TabelaPedidos pedidos={pedidosPeriodo} />
    </div>
  );
}

// ─── Sub-componentes ──────────────────────────────────────────────────────

function EstadoVazio({
  onFiles,
  importing,
}: {
  onFiles: (f: File[]) => void;
  importing: boolean;
}) {
  return (
    <div className="p-6 md:p-10 max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Vendas</h1>
        <p className="text-muted-foreground mt-2">
          Importe seus relatórios de pedidos da Shopee pra começar.
        </p>
      </header>

      <UploadDropzone
        title="Arraste os arquivos do Centro do Vendedor"
        hint="Aceita .zip (como vem por e-mail) ou .xlsx individuais. Pode importar vários de uma vez — o sistema deduplica automaticamente."
        accept=".zip,.xlsx,.xls"
        onFiles={onFiles}
        loading={importing}
      />

      <Card className="p-5 bg-muted/40 border-dashed">
        <h3 className="font-semibold text-sm mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          Como exportar na Shopee
        </h3>
        <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>Centro do Vendedor → Pedidos → Meus Pedidos</li>
          <li>Clique em <strong>Exportar</strong> (canto superior direito)</li>
          <li>Selecione o período (recomendado: 1 vez por semana ou mês)</li>
          <li>A Shopee envia um e-mail com link de download de um <code className="px-1.5 py-0.5 bg-background rounded text-xs font-mono">.zip</code></li>
          <li>Faça upload do <code className="px-1.5 py-0.5 bg-background rounded text-xs font-mono">.zip</code> aqui acima</li>
        </ol>
      </Card>
    </div>
  );
}

function NovoUploadDialog({
  onFiles,
  importing,
}: {
  onFiles: (f: File[]) => void;
  importing: boolean;
}) {
  return (
    <label>
      <input
        type="file"
        accept=".zip,.xlsx,.xls"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onFiles(Array.from(e.target.files));
            e.target.value = "";
          }
        }}
      />
      <Button asChild disabled={importing}>
        <span className="cursor-pointer gap-2">
          {importing ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Database className="h-4 w-4" />
          )}
          {importing ? "Importando..." : "Importar relatório"}
        </span>
      </Button>
    </label>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-popover/95 backdrop-blur shadow-lg p-3 text-xs">
      <p className="font-medium mb-1.5 text-foreground">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 tabular-nums">
          <span
            className="h-2 w-2 rounded-sm"
            style={{ backgroundColor: p.color || p.fill }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium text-foreground">
            {typeof p.value === "number" && p.name !== "Pedidos"
              ? formatBRL(p.value)
              : formatNumber(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground">
      Sem dados no período selecionado
    </div>
  );
}

function DonutComposicao({
  composicao,
}: {
  composicao: ReturnType<typeof calcularComposicao>;
}) {
  const data = [
    { name: "Renda estimada", value: composicao.receita_liquida, color: "var(--chart-2)" },
    { name: "Taxas Shopee", value: composicao.taxas_shopee, color: "var(--chart-3)" },
    { name: "Imposto (10%)", value: composicao.imposto, color: "var(--chart-4)" },
  ].filter((d) => d.value > 0);

  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) return <EmptyChart />;

  return (
    <>
      <div className="h-[200px] w-full">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={85}
              paddingAngle={2}
              dataKey="value"
            >
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} stroke="var(--card)" strokeWidth={2} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-2 mt-2">
        {data.map((d) => (
          <li key={d.name} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: d.color }} />
              {d.name}
            </span>
            <span className="tabular-nums font-medium">
              {formatBRL(d.value)}{" "}
              <span className="text-muted-foreground text-xs">
                ({formatPercent((d.value / total) * 100, 0)})
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function TabelaPedidos({ pedidos }: { pedidos: Pedido[] }) {
  const [busca, setBusca] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  const statusUnicos = useMemo(() => {
    const set = new Set(pedidos.map((p) => p.status).filter(Boolean));
    return Array.from(set).sort();
  }, [pedidos]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return pedidos
      .filter((p) => statusFilter === "all" || p.status === statusFilter)
      .filter(
        (p) =>
          !q ||
          p.id.toLowerCase().includes(q) ||
          p.primeiro_produto.toLowerCase().includes(q) ||
          p.uf.toLowerCase().includes(q)
      )
      .sort((a, b) => b.data_hora_pedido.localeCompare(a.data_hora_pedido));
  }, [pedidos, busca, statusFilter]);

  const pageRows = filtrados.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtrados.length / PAGE_SIZE));

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-4 flex items-center justify-between gap-3 flex-wrap border-b border-border">
        <div>
          <h3 className="font-semibold text-foreground">Pedidos</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatNumber(filtrados.length)} pedido(s) no período · página{" "}
            {page + 1} de {totalPages}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Buscar por ID, produto, UF…"
            value={busca}
            onChange={(e) => {
              setBusca(e.target.value);
              setPage(0);
            }}
            className="w-64 h-9"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-44 h-9">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os status</SelectItem>
              {statusUnicos.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Produto</TableHead>
              <TableHead className="text-center">Itens</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>UF</TableHead>
              <TableHead>Envio</TableHead>
              <TableHead className="text-right">GMV</TableHead>
              <TableHead className="text-right">Renda est.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  Nenhum pedido encontrado
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-xs text-muted-foreground tabular-nums">
                    {formatDate(p.data_pedido)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.id}</TableCell>
                  <TableCell className="max-w-xs truncate">
                    {p.primeiro_produto || "—"}
                    {p.n_skus > 1 && (
                      <span className="text-xs text-muted-foreground ml-1">
                        +{p.n_skus - 1}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">{p.total_itens}</TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} valido={p.pedido_valido} />
                  </TableCell>
                  <TableCell>{p.uf || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">
                    {p.opcao_envio || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatBRL(p.valor_total)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className={p.renda_estimada < 0 ? "text-destructive" : ""}>
                      {formatBRL(p.renda_estimada)}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="p-3 flex items-center justify-end gap-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
          >
            Próxima
          </Button>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status, valido }: { status: string; valido: boolean }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  if (!valido) {
    return (
      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
        {status}
      </Badge>
    );
  }
  if (status === "Concluído" || status === "Entregue") {
    return (
      <Badge variant="outline" className="bg-success/10 text-success border-success/20">
        {status}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-accent text-accent-foreground border-accent">
      {status}
    </Badge>
  );
}
