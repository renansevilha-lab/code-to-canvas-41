import { BotaoSincronizar } from "@/components/BotaoSincronizar";
import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePerfil } from "@/hooks/usePerfil";
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
  // Incrementado pelo botão "Sincronizar" para reler a view depois do sync.
  const [recarga, setRecarga] = useState(0);
  // "Gerar anúncio" (IA · Anúncios, Fase 2) só para quem tem o módulo IA
  const podeIa = usePerfil().temAcesso("ia");

  useEffect(() => {
    (async () => {
      // Paginado: são ~2,3 mil produtos e o PostgREST corta em 1.000 — com um
      // .limit(1000) só, a busca não achava mais da metade do catálogo.
      const todos: Produto[] = [];
      for (let de = 0; de < 20_000; de += 1000) {
        const { data, error } = await supabaseExternal
          .from("view_produtos_margem")
          .select("*")
          .order("margem_pct", { ascending: false, nullsFirst: false })
          .order("sku")
          .range(de, de + 999);
        if (error) break;
        todos.push(...((data ?? []) as Produto[]));
        if (!data || data.length < 1000) break;
      }
      setProdutos(todos);
      setLoading(false);
    })();
  }, [recarga]);

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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Catálogo & Margem</h1>
          <p className="text-muted-foreground">
            Produtos com preço de venda, CMV efetivo e margem bruta calculada.
          </p>
        </div>
        <BotaoSincronizar
          rotulo="Sincronizar catálogo"
          titulo="Puxa produtos, detalhes e kits do Tiny agora. O cron faz isso 1x por dia (madrugada)."
          rotas={[
            "tiny-sync-produtos?modulo=produtos&limite=5000",
            "tiny-sync-produtos?modulo=detalhar&limite=200",
            "tiny-sync?modulo=kits&max_kits=20",
          ]}
          onConcluido={() => setRecarga((n) => n + 1)}
        />
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
                  {podeIa && <th className="px-4 py-3 font-medium" />}
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
                      {podeIa && (
                        <td className="px-2 py-2 text-right">
                          <Button asChild size="sm" variant="ghost" className="h-7 gap-1 text-xs">
                            <Link to="/ia/gerar" search={{ sku: p.sku, canal: "shopee", empresa: "ottz" }} title="Gerar anúncio com IA">
                              <Sparkles className="h-3.5 w-3.5" />Gerar anúncio
                            </Link>
                          </Button>
                        </td>
                      )}
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
