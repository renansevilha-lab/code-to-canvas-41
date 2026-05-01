import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ShoppingBag,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  ArrowRight,
  Sparkles,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { statsVendas } from "@/lib/vendas/storage";
import { formatDate, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [stats, setStats] = useState<{
    total_pedidos: number;
    total_itens: number;
    data_min: string | null;
    data_max: string | null;
  } | null>(null);

  useEffect(() => {
    statsVendas().then(setStats).catch(() => setStats(null));
  }, []);

  const temDados = stats && stats.total_pedidos > 0;

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-8">
      {/* Hero */}
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Sparkles className="h-3 w-3" />
          Plataforma visual do vendedor Shopee
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
          Visão geral
        </h1>
        <p className="text-muted-foreground max-w-2xl">
          Consolide vendas, anúncios e carteira da Shopee em um só lugar.
          Tudo processado no seu navegador — seus dados nunca saem do dispositivo.
        </p>
      </header>

      {/* Status do sistema */}
      {temDados ? (
        <Card className="p-6 bg-gradient-to-br from-primary/5 to-accent/30 border-primary/20">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium text-muted-foreground">
                Você tem dados de vendas carregados
              </p>
              <p className="text-2xl font-semibold mt-1 tabular-nums">
                {formatNumber(stats!.total_pedidos)} pedidos
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {stats!.data_min && stats!.data_max
                  ? `Período: ${formatDate(stats!.data_min)} – ${formatDate(stats!.data_max)}`
                  : ""}
              </p>
            </div>
            <Button asChild>
              <Link to="/vendas">
                Abrir dashboard
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="p-6 border-dashed">
          <p className="text-sm text-muted-foreground mb-3">
            Nenhum dado carregado ainda. Comece importando seus pedidos:
          </p>
          <Button asChild>
            <Link to="/vendas">
              Começar pelo módulo de Vendas
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
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
          />
          <ModuleCard
            icon={Wallet}
            title="Carteira"
            description="Conciliação entre transações da carteira Shopee e pedidos pagos."
            to="/carteira"
          />
          <ModuleCard
            icon={TrendingUp}
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
      </Card>
    </Link>
  );
}
