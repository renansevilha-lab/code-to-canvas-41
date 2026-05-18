import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";

export const Route = createFileRoute("/produtos")({
  component: ProdutosPage,
});

type Produto = {
  sku: string;
  nome: string | null;
  categoria: string | null;
  preco_venda: number | null;
  cmv_efetivo: number | null;
  margem_bruta: number | null;
  margem_pct: number | null;
  ativo: boolean | null;
  eh_kit: boolean | null;
};

function ProdutosPage() {
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<string>("todos");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabaseExternal
        .from("view_produtos_margem")
        .select("*")
        .order("margem_pct", { ascending: false, nullsFirst: false })
        .limit(1000);
      if (!error) setProdutos((data ?? []) as Produto[]);
      setLoading(false);
    })();
  }, []);

  const filtrados = useMemo(
    () =>
      produtos.filter((p) => {
        if (filtro === "ativos" && !p.ativo) return false;
        if (filtro === "kits" && !p.eh_kit) return false;
        if (filtro === "sem_cmv" && p.cmv_efetivo != null) return false;
        if (filtro === "margem_baixa" && (p.margem_pct == null || Number(p.margem_pct) >= 20)) return false;
        if (busca) {
          const q = busca.toLowerCase();
          return p.sku.toLowerCase().includes(q) || p.nome?.toLowerCase().includes(q);
        }
        return true;
      }),
    [produtos, busca, filtro]
  );

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Catálogo & Margem</h1>
        <p className="text-muted-foreground">
          Produtos com preço de venda, CMV efetivo e margem bruta calculada.
        </p>
      </header>

      <SyncStatusFooter area="catalogo" />

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Input
            placeholder="Buscar por SKU ou nome"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="md:col-span-2"
          />
          <Select value={filtro} onValueChange={setFiltro}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="ativos">Ativos</SelectItem>
              <SelectItem value="kits">Kits</SelectItem>
              <SelectItem value="sem_cmv">Sem CMV</SelectItem>
              <SelectItem value="margem_baixa">Margem &lt; 20%</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-3 pt-3 border-t text-sm text-muted-foreground">
          {formatNumber(filtrados.length)} produtos
        </div>
      </Card>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando…</div>
        ) : filtrados.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhum produto encontrado.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Produto</th>
                  <th className="px-4 py-3 font-medium text-right">Preço</th>
                  <th className="px-4 py-3 font-medium text-right">CMV</th>
                  <th className="px-4 py-3 font-medium text-right">Margem</th>
                  <th className="px-4 py-3 font-medium text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((p) => {
                  const pct = Number(p.margem_pct ?? 0);
                  const accent =
                    p.margem_pct == null
                      ? "bg-muted text-muted-foreground"
                      : pct >= 40
                      ? "bg-success/10 text-success border-success/20"
                      : pct >= 20
                      ? "bg-warning/10 text-warning border-warning/20"
                      : "bg-destructive/10 text-destructive border-destructive/20";
                  return (
                    <tr key={p.sku} className="border-t hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-mono text-xs">{p.sku}</td>
                      <td className="px-4 py-2.5 max-w-[420px]">
                        <div className="truncate">{p.nome ?? "—"}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {p.eh_kit && <Badge variant="secondary" className="text-[10px] py-0 px-1.5">kit</Badge>}
                          {p.ativo === false && (
                            <Badge variant="outline" className="text-[10px] py-0 px-1.5">inativo</Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{formatBRL(p.preco_venda ?? 0)}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {p.cmv_efetivo != null ? formatBRL(p.cmv_efetivo) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {p.margem_bruta != null ? formatBRL(p.margem_bruta) : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Badge variant="outline" className={accent}>
                          {p.margem_pct != null ? formatPercent(pct) : "—"}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
