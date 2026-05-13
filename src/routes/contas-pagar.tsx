import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, CheckCircle2, Wallet } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/contas-pagar")({
  component: ContasPagarPage,
});

type Conta = {
  id: string;
  numero_documento: string | null;
  fornecedor_nome: string | null;
  descricao: string | null;
  categoria: string | null;
  valor_total: number;
  valor_pago: number | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status: string;
  alerta: string | null;
  dias_atraso: number | null;
};

type Situacao = {
  status: string;
  qtd: number;
  valor_total: number;
};

const ALERT_COLORS: Record<string, string> = {
  atrasada: "bg-destructive/10 text-destructive border-destructive/20",
  vence_hoje: "bg-warning/10 text-warning border-warning/20",
  vence_7dias: "bg-warning/10 text-warning border-warning/20",
  futuro: "bg-muted text-muted-foreground border-border",
  paga: "bg-success/10 text-success border-success/20",
};

function ContasPagarPage() {
  const [contas, setContas] = useState<Conta[]>([]);
  const [situacoes, setSituacoes] = useState<Situacao[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<string>("aberto");

  useEffect(() => {
    (async () => {
      const [c, s] = await Promise.all([
        supabaseExternal
          .from("contas_pagar")
          .select(
            "id,numero_documento,fornecedor_nome,descricao,categoria,valor_total,valor_pago,data_emissao,data_vencimento,data_pagamento,status,alerta,dias_atraso"
          )
          .order("data_vencimento", { ascending: true })
          .limit(500),
        supabaseExternal.from("view_contas_pagar_situacao").select("*"),
      ]);
      if (!c.error) setContas((c.data ?? []) as Conta[]);
      if (!s.error) setSituacoes((s.data ?? []) as Situacao[]);
      setLoading(false);
    })();
  }, []);

  const totals = useMemo(() => {
    const atrasadas = contas.filter((c) => c.alerta === "atrasada");
    const vencendo = contas.filter((c) => c.alerta === "vence_7dias" || c.alerta === "vence_hoje");
    const aberto = contas.filter((c) => c.status === "aberto" || c.status === "parcial");
    const pagas = contas.filter((c) => c.status === "paga");
    return {
      atrasadas: { qtd: atrasadas.length, valor: atrasadas.reduce((a, c) => a + c.valor_total, 0) },
      vencendo: { qtd: vencendo.length, valor: vencendo.reduce((a, c) => a + c.valor_total, 0) },
      aberto: { qtd: aberto.length, valor: aberto.reduce((a, c) => a + c.valor_total, 0) },
      pagas: { qtd: pagas.length, valor: pagas.reduce((a, c) => a + (c.valor_pago ?? c.valor_total), 0) },
    };
  }, [contas]);

  const filtradas = contas.filter((c) => {
    if (filtro === "atrasadas" && c.alerta !== "atrasada") return false;
    if (filtro === "7dias" && c.alerta !== "vence_7dias" && c.alerta !== "vence_hoje") return false;
    if (filtro === "aberto" && c.status !== "aberto" && c.status !== "parcial") return false;
    if (filtro === "pagas" && c.status !== "paga") return false;
    if (busca) {
      const q = busca.toLowerCase();
      return (
        c.fornecedor_nome?.toLowerCase().includes(q) ||
        c.numero_documento?.toLowerCase().includes(q) ||
        c.descricao?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Contas a Pagar</h1>
        <p className="text-muted-foreground">
          Contas sincronizadas do Tiny — atrasadas, vencendo e em aberto.
        </p>
      </header>

      {/* Resumo */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <SummaryCard
          icon={AlertTriangle}
          label="Atrasadas"
          qtd={totals.atrasadas.qtd}
          valor={totals.atrasadas.valor}
          accent="danger"
        />
        <SummaryCard
          icon={Clock}
          label="Vencem em 7 dias"
          qtd={totals.vencendo.qtd}
          valor={totals.vencendo.valor}
          accent="warning"
        />
        <SummaryCard
          icon={Wallet}
          label="Em aberto"
          qtd={totals.aberto.qtd}
          valor={totals.aberto.valor}
        />
        <SummaryCard
          icon={CheckCircle2}
          label="Pagas"
          qtd={totals.pagas.qtd}
          valor={totals.pagas.valor}
          accent="success"
        />
      </div>

      {situacoes.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3 text-muted-foreground uppercase tracking-wide">
            Por status
          </h3>
          <div className="flex flex-wrap gap-2">
            {situacoes.map((s) => (
              <Badge key={s.status} variant="outline" className="gap-2 py-1.5 px-3">
                <span className="capitalize">{s.status}</span>
                <span className="text-muted-foreground">{formatNumber(s.qtd)}</span>
                <span className="font-semibold tabular-nums">{formatBRL(s.valor_total, { compact: true })}</span>
              </Badge>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Buscar por fornecedor, documento ou descrição"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={filtro} onValueChange={setFiltro}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="aberto">Em aberto</SelectItem>
              <SelectItem value="atrasadas">Atrasadas</SelectItem>
              <SelectItem value="7dias">Vencem em 7 dias</SelectItem>
              <SelectItem value="pagas">Pagas</SelectItem>
              <SelectItem value="todas">Todas</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando…</div>
        ) : filtradas.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhuma conta nesse filtro.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Fornecedor</th>
                  <th className="px-4 py-3 font-medium">Documento</th>
                  <th className="px-4 py-3 font-medium">Vencimento</th>
                  <th className="px-4 py-3 font-medium">Alerta</th>
                  <th className="px-4 py-3 font-medium text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {filtradas.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2.5 max-w-[260px] truncate">
                      <div className="font-medium truncate">{c.fornecedor_nome ?? "—"}</div>
                      {c.descricao && (
                        <div className="text-[11px] text-muted-foreground truncate">{c.descricao}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{c.numero_documento ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {c.data_vencimento
                        ? new Date(c.data_vencimento).toLocaleDateString("pt-BR")
                        : "—"}
                      {c.dias_atraso != null && c.dias_atraso > 0 && (
                        <div className="text-[11px] text-destructive">
                          {c.dias_atraso} dia{c.dias_atraso > 1 ? "s" : ""} atrasada
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {c.alerta && (
                        <Badge variant="outline" className={ALERT_COLORS[c.alerta] ?? ""}>
                          {c.alerta.replace("_", " ")}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                      {formatBRL(c.valor_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  qtd,
  valor,
  accent,
}: {
  icon: typeof AlertTriangle;
  label: string;
  qtd: number;
  valor: number;
  accent?: "success" | "warning" | "danger";
}) {
  const accentClasses = {
    success: "bg-success/10 text-success",
    warning: "bg-warning/10 text-warning",
    danger: "bg-destructive/10 text-destructive",
  } as const;
  const iconClass = accent ? accentClasses[accent] : "bg-primary/10 text-primary";
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-3">
        <div className={`h-9 w-9 rounded-lg flex items-center justify-center ${iconClass}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1 tabular-nums">{formatBRL(valor, { compact: true })}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{formatNumber(qtd)} contas</p>
    </Card>
  );
}
