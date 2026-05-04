import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  AlertTriangle,
  CircleDollarSign,
  Coins,
  Database,
  Megaphone,
  Package,
  Percent,
  Receipt,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
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

import { processarArquivosCmv } from "@/lib/cmv/parser";
import { getAllCmv, limparCmv, salvarCmv } from "@/lib/cmv/storage";
import {
  calcularMargemDiaria,
  calcularMargemPorItem,
  calcularMargemPorSKU,
  calcularResumoMargem,
  gastoAdsPeriodo,
} from "@/lib/cmv/aggregations";
import type { CmvRow } from "@/lib/cmv/types";

import { getAllItens, getAllPedidos } from "@/lib/vendas/storage";
import { getAllAds } from "@/lib/ads/storage";
import {
  filtrarPeriodo,
  PERIODOS,
  type PeriodoKey,
} from "@/lib/vendas/aggregations";
import { filtrarPeriodoAds } from "@/lib/ads/aggregations";
import type { ItemPedido, Pedido } from "@/lib/vendas/types";
import type { AdRow } from "@/lib/ads/types";

import {
  formatBRL,
  formatDate,
  formatNumber,
  formatPercent,
} from "@/lib/format";

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

export const Route = createFileRoute("/cmv")({
  component: CmvPage,
  head: () => ({
    meta: [
      { title: "Margem real — Shopee Analytics" },
      {
        name: "description",
        content:
          "Margem por SKU cruzando vendas, taxas Shopee, imposto, gasto com anúncios e CMV (custo da mercadoria).",
      },
    ],
  }),
});

function CmvPage() {
  const router = useRouter();
  const [cmv, setCmv] = useState<CmvRow[]>([]);
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [itens, setItens] = useState<ItemPedido[]>([]);
  const [ads, setAds] = useState<AdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [periodo, setPeriodo] = useState<PeriodoKey>("30d");
  const [busca, setBusca] = useState("");

  const recarregar = async () => {
    setLoading(true);
    try {
      const [c, p, i, a] = await Promise.all([
        getAllCmv(),
        getAllPedidos(),
        getAllItens(),
        getAllAds(),
      ]);
      setCmv(c);
      setPedidos(p);
      setItens(i);
      setAds(a);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recarregar();
  }, []);

  const dataMax = useMemo(() => {
    if (pedidos.length === 0) return null;
    let max = "";
    for (const p of pedidos) if (p.data_pedido > max) max = p.data_pedido;
    return max || null;
  }, [pedidos]);

  const pedidosPeriodo = useMemo(
    () => filtrarPeriodo(pedidos, periodo, dataMax),
    [pedidos, periodo, dataMax]
  );
  const itensPeriodo = useMemo(
    () => filtrarPeriodo(itens, periodo, dataMax),
    [itens, periodo, dataMax]
  );
  const adsPeriodo = useMemo(
    () => filtrarPeriodoAds(ads, periodo, dataMax),
    [ads, periodo, dataMax]
  );

  const adsTotal = useMemo(() => gastoAdsPeriodo(adsPeriodo), [adsPeriodo]);
  const gmvTotal = useMemo(() => {
    let s = 0;
    for (const p of pedidosPeriodo) if (p.pedido_valido) s += p.valor_total || 0;
    return s;
  }, [pedidosPeriodo]);

  const margens = useMemo(
    () =>
      calcularMargemPorItem(pedidosPeriodo, itensPeriodo, cmv, adsTotal, gmvTotal),
    [pedidosPeriodo, itensPeriodo, cmv, adsTotal, gmvTotal]
  );
  const resumo = useMemo(() => calcularResumoMargem(margens), [margens]);
  const margemDiaria = useMemo(() => calcularMargemDiaria(margens), [margens]);
  const margemSku = useMemo(() => calcularMargemPorSKU(margens), [margens]);

  // Upload
  const handleFiles = async (files: File[]) => {
    setImporting(true);
    try {
      const r = await processarArquivosCmv(files);
      if (r.rows.length === 0) {
        toast.error("Nenhum SKU com CMV encontrado", {
          description: r.warnings[0] ?? "Verifique colunas (sku/valor) ou (Código (SKU)/Preço de custo).",
        });
        return;
      }
      const { novos, atualizados } = await salvarCmv(r.rows);
      toast.success(`${r.rows.length} SKUs importados`, {
        description: `${novos} novos, ${atualizados} atualizados`,
      });
      if (r.warnings.length) console.warn("CMV:", r.warnings);
      await recarregar();
      router.invalidate();
    } catch (e) {
      toast.error("Erro ao importar", { description: (e as Error).message });
    } finally {
      setImporting(false);
    }
  };

  const handleLimpar = async () => {
    await limparCmv();
    toast.success("CMV removido");
    await recarregar();
  };

  if (loading) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        Carregando…
      </div>
    );
  }

  if (cmv.length === 0) {
    return <EstadoVazio onFiles={handleFiles} importing={importing} />;
  }

  const cmvFiltrado = busca
    ? cmv.filter(
        (c) =>
          c.sku.toLowerCase().includes(busca.toLowerCase()) ||
          (c.nome_erp ?? "").toLowerCase().includes(busca.toLowerCase())
      )
    : cmv;

  const semDadosVendas = pedidos.length === 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">
            Margem real
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatNumber(cmv.length)} SKUs com CMV cadastrado · cobertura de{" "}
            {formatPercent(resumo.cobertura_cmv_pct)} da receita do período
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodFilter value={periodo} onChange={setPeriodo} />
          <NovoUploadDialog onFiles={handleFiles} importing={importing} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" title="Limpar CMV">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Apagar todos os CMVs?</AlertDialogTitle>
                <AlertDialogDescription>
                  Vai remover os {formatNumber(cmv.length)} SKUs com CMV
                  cadastrado. Os dados de vendas e ADS não são afetados.
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

      {semDadosVendas && (
        <Card className="p-4 border-warning/30 bg-warning/5 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-warning-foreground shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">Sem dados de vendas para cruzar.</p>
            <p className="text-muted-foreground mt-0.5">
              Importe pedidos no módulo Vendas pra calcular a margem por SKU.
            </p>
          </div>
        </Card>
      )}

      {/* KPIs de margem */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        <KpiCard
          label="Receita (itens)"
          value={formatBRL(resumo.receita)}
          hint={`período: ${PERIODOS.find((p) => p.key === periodo)?.label}`}
          icon={<CircleDollarSign className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="CMV total"
          value={formatBRL(resumo.cmv)}
          hint={`${formatPercent(resumo.receita > 0 ? (resumo.cmv / resumo.receita) * 100 : 0)} da receita`}
          icon={<Package className="h-4 w-4" />}
          accent="warning"
        />
        <KpiCard
          label="Taxas + imposto"
          value={formatBRL(resumo.taxas + resumo.imposto)}
          hint={`taxas ${formatBRL(resumo.taxas)} + imposto ${formatBRL(resumo.imposto)}`}
          icon={<Percent className="h-4 w-4" />}
          accent="warning"
        />
        <KpiCard
          label="Gasto com ADS"
          value={formatBRL(resumo.ads)}
          hint={
            adsTotal > 0
              ? `total ${formatBRL(adsTotal)} rateado pelo GMV`
              : "sem dados de ADS no período"
          }
          icon={<Megaphone className="h-4 w-4" />}
          accent="destructive"
        />
        <KpiCard
          label="Margem real"
          value={formatBRL(resumo.margem)}
          hint="receita − cmv − taxas − imposto − ads"
          icon={<Coins className="h-4 w-4" />}
          accent={resumo.margem >= 0 ? "success" : "destructive"}
        />
        <KpiCard
          label="Margem %"
          value={formatPercent(resumo.margem_pct)}
          hint={`${formatNumber(resumo.itens_total)} itens analisados`}
          icon={<TrendingUp className="h-4 w-4" />}
          accent={resumo.margem_pct >= 0 ? "success" : "destructive"}
        />
        <KpiCard
          label="Cobertura CMV"
          value={formatPercent(resumo.cobertura_cmv_pct)}
          hint={`${formatNumber(resumo.itens_sem_cmv)} itens sem CMV`}
          icon={<Database className="h-4 w-4" />}
          accent={resumo.cobertura_cmv_pct >= 80 ? "success" : "warning"}
        />
        <KpiCard
          label="Ticket × margem"
          value={formatBRL(resumo.itens_total > 0 ? resumo.margem / resumo.itens_total : 0)}
          hint="margem média por item"
          icon={<Receipt className="h-4 w-4" />}
          accent="primary"
        />
      </section>

      {/* Gráfico margem diária */}
      <Card className="p-5">
        <header className="mb-4">
          <h3 className="font-semibold text-foreground">Margem diária</h3>
          <p className="text-xs text-muted-foreground">
            Receita (barra), margem (barra) e margem % (linha)
          </p>
        </header>
        {margemDiaria.length === 0 ? (
          <EmptyChart />
        ) : (
          <div className="h-[320px] w-full">
            <ResponsiveContainer>
              <ComposedChart data={margemDiaria} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="data"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) => formatBRL(v, { compact: true }).replace("R$", "")}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar
                  yAxisId="left"
                  dataKey="receita"
                  name="Receita"
                  fill="var(--chart-1)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                />
                <Bar
                  yAxisId="left"
                  dataKey="margem"
                  name="Margem"
                  fill="var(--chart-3)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={28}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="margem_pct"
                  name="Margem %"
                  stroke="var(--chart-5)"
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Tabs analíticas */}
      <Tabs defaultValue="margemSku">
        <TabsList>
          <TabsTrigger value="margemSku">Margem por SKU</TabsTrigger>
          <TabsTrigger value="cmvCadastrado">
            CMV cadastrado
            <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
              {formatNumber(cmv.length)}
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="margemSku">
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Qtd</TableHead>
                  <TableHead className="text-right">Receita</TableHead>
                  <TableHead className="text-right">CMV</TableHead>
                  <TableHead className="text-right">Taxas+Imp.</TableHead>
                  <TableHead className="text-right">ADS</TableHead>
                  <TableHead className="text-right">Margem</TableHead>
                  <TableHead className="text-right">Margem %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {margemSku.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                      Nenhum dado no período
                    </TableCell>
                  </TableRow>
                ) : (
                  margemSku.slice(0, 100).map((s, i) => (
                    <TableRow key={`${s.sku}-${i}`}>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {i + 1}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.sku}
                        {!s.tem_cmv && (
                          <Badge variant="outline" className="ml-1 text-[10px] h-4 px-1 text-warning-foreground border-warning/40">
                            sem cmv
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-md truncate">{s.produto}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(s.qtd_vendida)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBRL(s.receita)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatBRL(s.cmv_total)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatBRL(s.taxas + s.imposto)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatBRL(s.ads)}
                      </TableCell>
                      <TableCell
                        className={
                          "text-right tabular-nums font-medium " +
                          (s.margem >= 0 ? "text-success" : "text-destructive")
                        }
                      >
                        {formatBRL(s.margem)}
                      </TableCell>
                      <TableCell
                        className={
                          "text-right tabular-nums " +
                          (s.margem_pct >= 0 ? "text-success" : "text-destructive")
                        }
                      >
                        {formatPercent(s.margem_pct)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="cmvCadastrado">
          <div className="mb-3">
            <Input
              placeholder="Buscar SKU ou nome…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="max-w-sm"
            />
          </div>
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Marca</TableHead>
                  <TableHead className="text-right">Preço ERP</TableHead>
                  <TableHead className="text-right">CMV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cmvFiltrado.slice(0, 200).map((c) => (
                  <TableRow key={c.sku}>
                    <TableCell className="font-mono text-xs">{c.sku}</TableCell>
                    <TableCell className="max-w-md truncate">{c.nome_erp ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.categoria ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.marca ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.preco_venda_erp ? formatBRL(c.preco_venda_erp) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatBRL(c.cmv)}
                    </TableCell>
                  </TableRow>
                ))}
                {cmvFiltrado.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      Nenhum SKU encontrado
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {dataMax && (
        <p className="text-xs text-muted-foreground text-center">
          Última data de vendas: {formatDate(dataMax)}
        </p>
      )}
    </div>
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
          Margem real (CMV)
        </h1>
        <p className="text-muted-foreground">
          Importe seus custos por SKU pra calcular a margem real cruzando vendas, taxas Shopee, imposto e gasto com anúncios.
        </p>
      </header>
      <UploadDropzone
        onFiles={onFiles}
        accept=".xlsx,.xls,.csv"
        title="Solte aqui sua planilha de custos"
        hint="Aceita formato simples (colunas sku, valor) ou export do Tiny ERP (Código (SKU), Preço de custo)."
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
  const inputRef = useState<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => inputRef[0]?.click()}
        disabled={importing}
      >
        Importar CMV
      </Button>
      <input
        ref={(el) => inputRef[1](el)}
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
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium tabular-nums">
            {p.dataKey === "margem_pct"
              ? formatPercent(p.value)
              : formatBRL(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
}
