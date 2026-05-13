import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/pedidos")({
  component: PedidosPage,
});

type Pedido = {
  id: string;
  numero_pedido: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  data_pedido: string | null;
  cliente_nome: string | null;
  cliente_uf: string | null;
  cliente_cidade: string | null;
  valor_total: number | null;
  situacao: string | null;
};

const SITUACAO_COLORS: Record<string, string> = {
  entregue: "bg-success/10 text-success border-success/20",
  enviada: "bg-primary/10 text-primary border-primary/20",
  preparando_envio: "bg-warning/10 text-warning border-warning/20",
  cancelada: "bg-destructive/10 text-destructive border-destructive/20",
  aprovada: "bg-accent text-foreground border-border",
};

function PedidosPage() {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [canal, setCanal] = useState<string>("todos");
  const [situacao, setSituacao] = useState<string>("todas");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseExternal
        .from("pedidos_tiny")
        .select(
          "id,numero_pedido,numero_ecommerce,marca_canal,data_pedido,cliente_nome,cliente_uf,cliente_cidade,valor_total,situacao"
        )
        .order("data_pedido", { ascending: false })
        .limit(500);
      if (!error) setPedidos((data ?? []) as Pedido[]);
      setLoading(false);
    })();
  }, []);

  const canais = useMemo(
    () => Array.from(new Set(pedidos.map((p) => p.marca_canal).filter(Boolean))) as string[],
    [pedidos]
  );
  const situacoes = useMemo(
    () => Array.from(new Set(pedidos.map((p) => p.situacao).filter(Boolean))) as string[],
    [pedidos]
  );

  const filtrados = pedidos.filter((p) => {
    if (canal !== "todos" && p.marca_canal !== canal) return false;
    if (situacao !== "todas" && p.situacao !== situacao) return false;
    if (busca) {
      const q = busca.toLowerCase();
      return (
        p.numero_pedido?.toLowerCase().includes(q) ||
        p.numero_ecommerce?.toLowerCase().includes(q) ||
        p.cliente_nome?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalReceita = filtrados.reduce((acc, p) => acc + (p.valor_total ?? 0), 0);

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Pedidos</h1>
        <p className="text-muted-foreground">
          Últimos 500 pedidos sincronizados do Tiny ERP, multi-canal.
        </p>
      </header>

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Input
            placeholder="Buscar por nº pedido, ecommerce ou cliente"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={canal} onValueChange={setCanal}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os canais</SelectItem>
              {canais.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={situacao} onValueChange={setSituacao}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas as situações</SelectItem>
              {situacoes.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between mt-4 pt-4 border-t text-sm">
          <span className="text-muted-foreground">{formatNumber(filtrados.length)} pedidos</span>
          <span className="font-semibold tabular-nums">Total: {formatBRL(totalReceita)}</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando…</div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhum pedido encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Pedido</th>
                  <th className="px-4 py-3 font-medium">Data</th>
                  <th className="px-4 py-3 font-medium">Canal</th>
                  <th className="px-4 py-3 font-medium">Cliente</th>
                  <th className="px-4 py-3 font-medium">UF</th>
                  <th className="px-4 py-3 font-medium">Situação</th>
                  <th className="px-4 py-3 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-xs">{p.numero_pedido ?? "—"}</div>
                      {p.numero_ecommerce && (
                        <div className="text-[11px] text-muted-foreground">{p.numero_ecommerce}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {p.data_pedido ? new Date(p.data_pedido).toLocaleDateString("pt-BR") : "—"}
                    </td>
                    <td className="px-4 py-2.5">{p.marca_canal ?? "—"}</td>
                    <td className="px-4 py-2.5 truncate max-w-[200px]">{p.cliente_nome ?? "—"}</td>
                    <td className="px-4 py-2.5">{p.cliente_uf ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      {p.situacao && (
                        <Badge variant="outline" className={SITUACAO_COLORS[p.situacao] ?? ""}>
                          {p.situacao}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {formatBRL(p.valor_total ?? 0)}
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
