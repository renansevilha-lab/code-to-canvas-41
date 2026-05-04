import { useEffect, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  ShoppingBag,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { UploadDropzone } from "@/components/UploadDropzone";

import { statsVendas } from "@/lib/vendas/storage";
import { statsAds } from "@/lib/ads/storage";
import { getAllCmv } from "@/lib/cmv/storage";
import {
  processarArquivosSmart,
  type ResultadoSmart,
} from "@/lib/storage/smartUpload";
import { ROTULOS } from "@/lib/storage/detectarTipo";
import { formatDate, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/")({
  component: Index,
});

interface Stats {
  pedidos: number;
  data_min: string | null;
  data_max: string | null;
  ads_rows: number;
  cmv_skus: number;
}

function Index() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [importing, setImporting] = useState(false);

  const carregar = async () => {
    try {
      const [v, a, c] = await Promise.all([
        statsVendas(),
        statsAds(),
        getAllCmv(),
      ]);
      setStats({
        pedidos: v.total_pedidos,
        data_min: v.data_min,
        data_max: v.data_max,
        ads_rows: a.total_rows,
        cmv_skus: c.length,
      });
    } catch {
      setStats(null);
    }
  };

  useEffect(() => {
    carregar();
  }, []);

  const handleFiles = async (files: File[]) => {
    setImporting(true);
    try {
      const resultados = await processarArquivosSmart(files);
      for (const r of resultados) {
        const titulo =
          r.tipo === "desconhecido"
            ? `${r.arquivos.length} arquivo(s) não identificado(s)`
            : `${ROTULOS[r.tipo]}: ${r.arquivos.length} arquivo(s)`;
        if (r.tipo === "desconhecido") {
          toast.error(titulo, { description: r.resumo });
        } else {
          toast.success(titulo, { description: r.resumo });
        }
        if (r.warnings.length) console.warn(r.tipo, r.warnings);
      }
      await carregar();
      router.invalidate();
    } catch (e) {
      toast.error("Erro ao importar", { description: (e as Error).message });
    } finally {
      setImporting(false);
    }
  };

  const temDados = stats && stats.pedidos > 0;

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Sparkles className="h-3 w-3" />
          Plataforma visual do vendedor Shopee
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
          Visão geral
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Consolide vendas, anúncios e margem da Shopee em um só lugar.
          Tudo processado no seu navegador — seus dados nunca saem do dispositivo.
        </p>
      </header>

      {/* Upload unificado */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Importar dados</h2>
        <UploadDropzone
          onFiles={handleFiles}
          accept=".xlsx,.xls,.csv,.zip"
          title="Solte qualquer relatório Shopee aqui"
          hint="Detecta automaticamente Vendas (Order.all), Anúncios (Dados Gerais) ou CMV (custos por SKU). Aceita .xlsx, .xls, .csv e .zip."
          loading={importing}
        />
      </section>

      {/* Status do sistema */}
      {temDados && (
        <Card className="p-6 bg-gradient-to-br from-primary/5 to-accent/30 border-primary/20">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase">
                Vendas
              </p>
              <p className="text-2xl font-semibold mt-1 tabular-nums">
                {formatNumber(stats!.pedidos)}{" "}
                <span className="text-sm font-normal text-muted-foreground">pedidos</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {stats!.data_min && stats!.data_max
                  ? `${formatDate(stats!.data_min)} – ${formatDate(stats!.data_max)}`
                  : ""}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase">
                Anúncios
              </p>
              <p className="text-2xl font-semibold mt-1 tabular-nums">
                {formatNumber(stats!.ads_rows)}{" "}
                <span className="text-sm font-normal text-muted-foreground">linhas</span>
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase">
                CMV
              </p>
              <p className="text-2xl font-semibold mt-1 tabular-nums">
                {formatNumber(stats!.cmv_skus)}{" "}
                <span className="text-sm font-normal text-muted-foreground">SKUs</span>
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Módulos */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Módulos</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ModuleCard
            icon={ShoppingBag}
            title="Vendas"
            description="Pedidos, GMV, ticket médio, taxas, cancelamentos, top SKUs e vendas por UF."
            to="/vendas"
            ready
          />
          <ModuleCard
            icon={Megaphone}
            title="Anúncios"
            description="Gasto, ROAS, CTR, CPC e top anúncios dos relatórios de ADS."
            to="/ads"
            ready
          />
          <ModuleCard
            icon={TrendingUp}
            title="Margem (CMV)"
            description="Margem real por SKU cruzando vendas, taxas, imposto, ADS e CMV importado."
            to="/cmv"
            ready
          />
          <ModuleCard
            icon={Wallet}
            title="Carteira"
            description="Conciliação entre transações da carteira Shopee e pedidos pagos."
            to="/carteira"
          />
          <ModuleCard
            icon={Package}
            title="Resultado"
            description="Cruzamento Vendas × ADS = lucro efetivo (subtotal – taxas – imposto – ADS)."
            to="/resultado"
          />
          <ModuleCard
            icon={Package}
            title="Catálogo"
            description="Importação do catálogo (SKU principal × variações × ID do produto)."
            to="/produtos"
          />
        </div>
      </section>
    </div>
  );
}

function ModuleCard({
  icon: Icon,
  title,
  description,
  to,
  ready,
}: {
  icon: typeof ShoppingBag;
  title: string;
  description: string;
  to: string;
  ready?: boolean;
}) {
  return (
    <Link to={to} className="group">
      <Card className="p-5 h-full hover:shadow-md hover:border-primary/30 transition-all">
        <div className="flex items-start justify-between mb-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Icon className="h-5 w-5" />
          </div>
          {ready ? (
            <Badge className="bg-success/10 text-success hover:bg-success/15 border-success/20">
              disponível
            </Badge>
          ) : (
            <Badge variant="secondary">em breve</Badge>
          )}
        </div>
        <h3 className="font-semibold text-foreground mb-1.5">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {description}
        </p>
        {ready && (
          <div className="mt-3 text-xs text-primary inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
            Abrir <ArrowRight className="h-3 w-3" />
          </div>
        )}
      </Card>
    </Link>
  );
}
