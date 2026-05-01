import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  BarChart3,
  CircleDollarSign,
  Database,
  MousePointerClick,
  Megaphone,
  Percent,
  RefreshCw,
  Target,
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

import { processarArquivosAds } from "@/lib/ads/parser";
import { getAllAds, limparTudoAds, salvarAds } from "@/lib/ads/storage";
import {
  calcularAdsKPIs,
  calcularAdsPorTipo,
  calcularResumoDiarioAds,
  calcularTopAnuncios,
  filtrarPeriodoAds,
  periodoAnteriorAds,
  type PeriodoKey,
} from "@/lib/ads/aggregations";
import type { AdRow } from "@/lib/ads/types";
import {
  formatBRL,
  formatDate,
  formatDelta,
  formatNumber,
  formatPercent,
} from "@/lib/format";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/ads")({
  component: AdsPage,
  head: () => ({
    meta: [
      { title: "Anúncios — Shopee Analytics" },
      {
        name: "description",
        content:
          "Dashboard de anúncios da Shopee: ROAS, CTR, CPC, gasto, top anúncios e evolução por período.",
      },
    ],
  }),
});

function AdsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<AdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [periodo, setPeriodo] = useState<PeriodoKey>("30d");

  const recarregar = async () => {
    setLoading(true);
    try {
      const r = await getAllAds();
      setRows(r);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    recarregar();
  }, []);

  const dataMax = useMemo(() => {
    if (rows.length === 0) return null;
    let max = "";
    for (const r of rows) if (r.data && r.data > max) max = r.data;
    return max || null;
  }, [rows]);

  const rowsPeriodo = useMemo(
    () => filtrarPeriodoAds(rows, periodo, dataMax),
    [rows, periodo, dataMax]
  );
  const rowsAnterior = useMemo(
    () => periodoAnteriorAds(rows, periodo, dataMax),
    [rows, periodo, dataMax]
  );

  const kpis = useMemo(() => calcularAdsKPIs(rowsPeriodo), [rowsPeriodo]);
  const kpisAnt = useMemo(() => calcularAdsKPIs(rowsAnterior), [rowsAnterior]);
  const resumoDiario = useMemo(
    () => calcularResumoDiarioAds(rowsPeriodo),
    [rowsPeriodo]
  );
  const topAnuncios = useMemo(
    () => calcularTopAnuncios(rowsPeriodo, 30),
    [rowsPeriodo]
  );
  const porTipo = useMemo(() => calcularAdsPorTipo(rowsPeriodo), [rowsPeriodo]);

  const handleFiles = async (files: File[]) => {
    setImporting(true);
    try {
      const r = await processarArquivosAds(files);
      if (r.rows.length === 0) {
        toast.error("Nenhuma linha de anúncio encontrada.", {
          description:
            r.warnings[0] ??
            "Verifique se é o relatório 'Dados Gerais de Anúncios' do Painel.",
        });
        return;
      }
      const { novos, atualizados } = await salvarAds(r.rows);
      toast.success(`${r.rows.length} linhas processadas`, {
        description: `${novos} novas, ${atualizados} atualizadas`,
      });
      if (r.warnings.length) console.warn("Avisos ADS:", r.warnings);
      await recarregar();
      router.invalidate();
    } catch (e) {
      toast.error("Erro ao processar", { description: (e as Error).message });
    } finally {
      setImporting(false);
    }
  };

  const handleLimpar = async () => {
    await limparTudoAds();
    toast.success("Dados de anúncios removidos");
    await recarregar();
  };

  if (rows.length === 0) {
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
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Anúncios
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {dataMax ? (
              <>
                {formatNumber(rows.length)} linhas · última data{" "}
                {formatDate(dataMax)}
              </>
            ) : (
              <>{formatNumber(rows.length)} linhas importadas</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodFilter value={periodo} onChange={setPeriodo} />
          <NovoUploadButton onFiles={handleFiles} importing={importing} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" title="Limpar dados">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Apagar todos os dados de anúncios?</AlertDialogTitle>
                <AlertDialogDescription>
                  Vai remover todas as {formatNumber(rows.length)} linhas de
                  anúncios armazenadas localmente.
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
          label="Gasto"
          value={formatBRL(kpis.gasto)}
          delta={formatDelta(kpis.gasto, kpisAnt.gasto)}
          betterDirection="down"
          icon={<CircleDollarSign className="h-4 w-4" />}
          accent="warning"
        />
        <KpiCard
          label="GMV de anúncios"
          value={formatBRL(kpis.gmv)}
          delta={formatDelta(kpis.gmv, kpisAnt.gmv)}
          betterDirection="up"
          icon={<TrendingUp className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="ROAS"
          value={`${kpis.roas.toFixed(2).replace(".", ",")}x`}
          hint={kpis.roas >= 1 ? "lucrativo" : "abaixo de 1×"}
          delta={formatDelta(kpis.roas, kpisAnt.roas)}
          betterDirection="up"
          icon={<Target className="h-4 w-4" />}
          accent={kpis.roas >= 2 ? "success" : kpis.roas >= 1 ? "primary" : "destructive"}
        />
        <KpiCard
          label="Pedidos"
          value={formatNumber(kpis.pedidos)}
          delta={formatDelta(kpis.pedidos, kpisAnt.pedidos)}
          betterDirection="up"
          icon={<BarChart3 className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="Impressões"
          value={formatNumber(kpis.impressoes)}
          delta={formatDelta(kpis.impressoes, kpisAnt.impressoes)}
          betterDirection="up"
          icon={<Megaphone className="h-4 w-4" />}
          accent="muted"
        />
        <KpiCard
          label="Cliques"
          value={formatNumber(kpis.cliques)}
          hint={`CTR ${formatPercent(kpis.ctr_pct, 2)}`}
          delta={formatDelta(kpis.cliques, kpisAnt.cliques)}
          betterDirection="up"
          icon={<MousePointerClick className="h-4 w-4" />}
          accent="primary"
        />
        <KpiCard
          label="CPC médio"
          value={formatBRL(kpis.cpc)}
          delta={formatDelta(kpis.cpc, kpisAnt.cpc)}
          betterDirection="down"
          icon={<Percent className="h-4 w-4" />}
          accent="warning"
        />
        <KpiCard
          label="CPA"
          value={formatBRL(kpis.cpa)}
          hint={`Conv. ${formatPercent(kpis.taxa_conversao_pct, 2)}`}
          delta={formatDelta(kpis.cpa, kpisAnt.cpa)}
          betterDirection="down"
          icon={<Target className="h-4 w-4" />}
          accent="success"
        />
      </section>

      {/* Gráficos */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <header className="mb-4">
            <h3 className="font-semibold text-foreground">
              Gasto vs GMV por dia
            </h3>
            <p className="text-xs text-muted-foreground">
              Barras = valores · linha = ROAS
            </p>
          </header>
          {resumoDiario.length === 0 ? (
            <EmptyChart hint="Sem datas no período (relatório pode ter vindo agregado)" />
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
                    tickFormatter={(v: number) => `${v.toFixed(1)}x`}
                  />
                  <Tooltip content={<AdsTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    yAxisId="left"
                    dataKey="gasto"
                    name="Gasto"
                    fill="var(--chart-3)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={30}
                  />
                  <Bar
                    yAxisId="left"
                    dataKey="gmv"
                    name="GMV"
                    fill="var(--chart-1)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={30}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="roas"
                    name="ROAS"
                    stroke="var(--chart-2)"
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: "var(--chart-2)" }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <header className="mb-4">
            <h3 className="font-semibold text-foreground">CTR & CPC por dia</h3>
            <p className="text-xs text-muted-foreground">
              Eficiência do tráfego pago
            </p>
          </header>
          {resumoDiario.length === 0 ? (
            <EmptyChart hint="Sem datas no período" />
          ) : (
            <div className="h-[280px] w-full">
              <ResponsiveContainer>
                <LineChart
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
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(v: number) =>
                      formatBRL(v, { compact: true }).replace("R$", "")
                    }
                  />
                  <Tooltip content={<AdsTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="ctr_pct"
                    name="CTR (%)"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="cpc"
                    name="CPC"
                    stroke="var(--chart-4)"
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      {/* Tabs analíticas */}
      <Tabs defaultValue="top">
        <TabsList>
          <TabsTrigger value="top">Top anúncios</TabsTrigger>
          <TabsTrigger value="tipo">
            Por tipo {porTipo.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                {porTipo.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="top">
          <TopAnunciosTabela rows={topAnuncios} />
        </TabsContent>

        <TabsContent value="tipo">
          <Card className="p-5">
            {porTipo.length === 0 ? (
              <EmptyChart hint="Relatório não trouxe a coluna 'Tipo de anúncio'" />
            ) : (
              <div className="h-[320px] w-full">
                <ResponsiveContainer>
                  <BarChart
                    data={porTipo}
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
                      dataKey="tipo"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      width={140}
                    />
                    <Tooltip content={<AdsTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="gasto" name="Gasto" fill="var(--chart-3)" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="gmv" name="GMV" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
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
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Anúncios</h1>
        <p className="text-muted-foreground mt-2">
          Importe o relatório <strong>Dados Gerais de Anúncios</strong> do
          Painel da Shopee pra acompanhar ROAS, CTR, CPC e gasto.
        </p>
      </header>

      <UploadDropzone
        title="Arraste o relatório de anúncios"
        hint="Aceita .xlsx individuais ou .zip. O parser detecta automaticamente as colunas (impressões, cliques, gasto, GMV...)."
        accept=".zip,.xlsx,.xls"
        onFiles={onFiles}
        loading={importing}
      />

      <Card className="p-5 bg-muted/40 border-dashed">
        <h3 className="font-semibold text-sm mb-2 flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          Como exportar
        </h3>
        <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>Painel da Shopee → Marketing → Anúncios</li>
          <li>Aba <strong>Dados Gerais de Anúncios</strong></li>
          <li>Selecione o período e clique em <strong>Exportar</strong></li>
          <li>Faça upload do arquivo aqui</li>
        </ol>
      </Card>
    </div>
  );
}

function NovoUploadButton({
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

function AdsTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-popover/95 backdrop-blur shadow-lg p-3 text-xs">
      <p className="font-medium mb-1.5 text-foreground">{label}</p>
      {payload.map((p: any, i: number) => {
        const v = p.value as number;
        let rendered: string;
        if (p.name === "ROAS") rendered = `${v.toFixed(2)}x`;
        else if (p.name === "CTR (%)") rendered = `${v.toFixed(2)}%`;
        else if (
          p.name === "Gasto" ||
          p.name === "GMV" ||
          p.name === "CPC"
        )
          rendered = formatBRL(v);
        else rendered = formatNumber(v);
        return (
          <div key={i} className="flex items-center gap-2 tabular-nums">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: p.color || p.fill }}
            />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="font-medium text-foreground">{rendered}</span>
          </div>
        );
      })}
    </div>
  );
}

function EmptyChart({ hint }: { hint?: string }) {
  return (
    <div className="h-[280px] flex items-center justify-center text-sm text-muted-foreground text-center px-6">
      {hint ?? "Sem dados no período selecionado"}
    </div>
  );
}

function TopAnunciosTabela({
  rows,
}: {
  rows: ReturnType<typeof calcularTopAnuncios>;
}) {
  const [busca, setBusca] = useState("");
  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.nome.toLowerCase().includes(q) ||
        r.id_anuncio.toLowerCase().includes(q) ||
        (r.tipo ?? "").toLowerCase().includes(q)
    );
  }, [rows, busca]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="p-4 flex items-center justify-between gap-3 flex-wrap border-b border-border">
        <div>
          <h3 className="font-semibold text-foreground">Top anúncios por gasto</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatNumber(filtrados.length)} anúncio(s)
          </p>
        </div>
        <Input
          placeholder="Buscar nome, ID ou tipo…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="w-64 h-9"
        />
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Anúncio</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="text-right">Impressões</TableHead>
              <TableHead className="text-right">Cliques</TableHead>
              <TableHead className="text-right">CTR</TableHead>
              <TableHead className="text-right">CPC</TableHead>
              <TableHead className="text-right">Pedidos</TableHead>
              <TableHead className="text-right">Gasto</TableHead>
              <TableHead className="text-right">GMV</TableHead>
              <TableHead className="text-right">ROAS</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtrados.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                  Nenhum anúncio
                </TableCell>
              </TableRow>
            ) : (
              filtrados.map((r, i) => (
                <TableRow key={`${r.id_anuncio}-${i}`}>
                  <TableCell className="text-muted-foreground tabular-nums">{i + 1}</TableCell>
                  <TableCell className="max-w-xs truncate font-medium">{r.nome}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.tipo || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.impressoes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.cliques)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(r.ctr_pct, 2)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBRL(r.cpc)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.pedidos)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBRL(r.gasto)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatBRL(r.gmv)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <RoasBadge roas={r.roas} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function RoasBadge({ roas }: { roas: number }) {
  if (!roas) return <span className="text-muted-foreground">—</span>;
  const txt = `${roas.toFixed(2).replace(".", ",")}x`;
  if (roas >= 2)
    return (
      <Badge variant="outline" className="bg-success/10 text-success border-success/20">
        {txt}
      </Badge>
    );
  if (roas >= 1)
    return (
      <Badge variant="outline" className="bg-accent text-accent-foreground border-accent">
        {txt}
      </Badge>
    );
  return (
    <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
      {txt}
    </Badge>
  );
}
