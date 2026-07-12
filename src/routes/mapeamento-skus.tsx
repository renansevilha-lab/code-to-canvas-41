import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  Pencil,
  Trash2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

export const Route = createFileRoute("/mapeamento-skus")({
  component: MapeamentoSkusPage,
});

interface SkuMapearRow {
  sku_amazon: string;
  nome_anuncio: string | null;
  pedidos: number | null;
  unidades: number | null;
  receita: number | null;
  preco_medio_un: number | null;
  sku_atual: string | null;
  sku_mapeado: string | null;
  produto_atual: string | null;
  cmv_atual: number | null;
  sem_cadastro: boolean | null;
  tem_prejuizo: boolean | null;
}

interface ProdutoOption {
  sku: string;
  nome: string | null;
}

type FiltroTipo =
  | "todos"
  | "sem_cadastro"
  | "com_prejuizo"
  | "nao_mapeados"
  | "ja_mapeados";

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function useSkusMapear() {
  return useQuery({
    queryKey: ["amazon", "view_amazon_skus_mapear"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_amazon_skus_mapear")
        .select("*")
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as SkuMapearRow[];
    },
  });
}

function MapeamentoSkusPage() {
  const { data, isLoading, error } = useSkusMapear();
  const [filtro, setFiltro] = useState<FiltroTipo>("todos");
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<SkuMapearRow | null>(null);
  const [removendo, setRemovendo] = useState<SkuMapearRow | null>(null);
  const queryClient = useQueryClient();

  const rows = data ?? [];

  const resumo = useMemo(() => {
    let semCadastro = 0;
    let comPrejuizo = 0;
    let jaMapeados = 0;
    for (const r of rows) {
      if (r.sem_cadastro) semCadastro++;
      if (r.tem_prejuizo) comPrejuizo++;
      if (r.sku_mapeado) jaMapeados++;
    }
    return { semCadastro, comPrejuizo, jaMapeados, total: rows.length };
  }, [rows]);

  const filtered = useMemo(() => {
    const buscaLower = busca.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (filtro === "sem_cadastro" && !r.sem_cadastro) return false;
      if (filtro === "com_prejuizo" && !r.tem_prejuizo) return false;
      if (filtro === "nao_mapeados" && r.sku_mapeado) return false;
      if (filtro === "ja_mapeados" && !r.sku_mapeado) return false;
      if (buscaLower) {
        const hay = `${r.sku_amazon} ${r.nome_anuncio ?? ""}`.toLowerCase();
        if (!hay.includes(buscaLower)) return false;
      }
      return true;
    });
    return list.sort((a, b) => {
      const pa = a.tem_prejuizo ? 1 : 0;
      const pb = b.tem_prejuizo ? 1 : 0;
      if (pb !== pa) return pb - pa;
      return num(b.receita) - num(a.receita);
    });
  }, [rows, filtro, busca]);

  const removeMutation = useMutation({
    mutationFn: async (sku_amazon: string) => {
      const { error } = await supabaseExternal
        .from("sku_mapeamento")
        .delete()
        .eq("marketplace", "amazon")
        .eq("sku_origem", sku_amazon);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Mapeamento removido");
      queryClient.invalidateQueries({
        queryKey: ["amazon", "view_amazon_skus_mapear"],
      });
      setRemovendo(null);
    },
    onError: (e: Error) => toast.error(`Erro ao remover: ${e.message}`),
  });

  return (
    <TooltipProvider>
      <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-purple-500 to-indigo-500 text-white">
            <Link2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Mapeamento de SKUs — Amazon</h1>
            <p className="text-sm text-muted-foreground">
              De-para entre SKU da Amazon e SKU do cadastro interno
            </p>
          </div>
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          A Amazon não permite alterar o SKU de anúncios já criados. Aqui você
          aponta cada SKU da Amazon para o SKU correto do cadastro interno — o
          custo e a margem passam a usar o SKU mapeado.
        </div>

        {/* Cards resumo */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <ResumoCard
            icon={<XCircle className="h-4 w-4" />}
            label="Sem cadastro"
            value={isLoading ? null : formatNumber(resumo.semCadastro)}
            color="text-red-600 bg-red-50"
            highlight={resumo.semCadastro > 0}
          />
          <ResumoCard
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Com prejuízo"
            value={isLoading ? null : formatNumber(resumo.comPrejuizo)}
            color="text-amber-600 bg-amber-50"
          />
          <ResumoCard
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Já mapeados"
            value={isLoading ? null : formatNumber(resumo.jaMapeados)}
            color="text-emerald-600 bg-emerald-50"
          />
          <ResumoCard
            icon={<Link2 className="h-4 w-4" />}
            label="Total SKUs Amazon"
            value={isLoading ? null : formatNumber(resumo.total)}
            color="text-blue-600 bg-blue-50"
          />
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-1 rounded-md border p-1 bg-muted/30 flex-wrap">
            {(
              [
                ["todos", "Todos"],
                ["sem_cadastro", "Sem cadastro"],
                ["com_prejuizo", "Com prejuízo"],
                ["nao_mapeados", "Não mapeados"],
                ["ja_mapeados", "Já mapeados"],
              ] as [FiltroTipo, string][]
            ).map(([k, label]) => (
              <Button
                key={k}
                size="sm"
                variant={filtro === k ? "default" : "ghost"}
                onClick={() => setFiltro(k)}
                className="h-7"
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[240px] max-w-[400px]">
            <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por SKU ou anúncio…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <div className="text-xs text-muted-foreground ml-auto">
            {formatNumber(filtered.length)} SKUs
          </div>
        </div>

        {/* Tabela */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU Amazon</TableHead>
                  <TableHead className="max-w-[320px]">Anúncio</TableHead>
                  <TableHead className="text-right">Un.</TableHead>
                  <TableHead className="text-right">Preço/un</TableHead>
                  <TableHead>SKU atual</TableHead>
                  <TableHead className="text-right">CMV atual</TableHead>
                  <TableHead>→ SKU correto</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell colSpan={8}>
                        <Skeleton className="h-6 w-full" />
                      </TableCell>
                    </TableRow>
                  ))}
                {error && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-red-600 py-8">
                      Erro ao carregar: {(error as Error).message}
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && !error && filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      Nenhum SKU encontrado
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((r) => {
                  const precoAbaixoCusto =
                    r.cmv_atual != null &&
                    r.preco_medio_un != null &&
                    r.preco_medio_un > 0 &&
                    r.preco_medio_un < num(r.cmv_atual) * 0.7;
                  const rowCls = cn(
                    r.tem_prejuizo || r.sem_cadastro
                      ? "bg-red-50/40 hover:bg-red-50/60"
                      : undefined,
                  );
                  return (
                    <TableRow key={r.sku_amazon} className={rowCls}>
                      <TableCell className="font-mono text-xs">
                        <div className="flex items-center gap-1.5">
                          {r.sku_amazon}
                          {r.sem_cadastro && (
                            <Badge className="bg-red-100 text-red-800 hover:bg-red-100 border-red-200 text-[10px] px-1.5 py-0">
                              sem cadastro
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[320px] truncate text-xs" title={r.nome_anuncio ?? ""}>
                        {r.nome_anuncio ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatNumber(num(r.unidades))}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        <div className="flex items-center justify-end gap-1">
                          {precoAbaixoCusto && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Preço abaixo do custo — SKU provavelmente errado
                              </TooltipContent>
                            </Tooltip>
                          )}
                          <span className="font-medium">
                            {r.preco_medio_un != null
                              ? formatBRL(num(r.preco_medio_un))
                              : "—"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.sku_atual ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {r.cmv_atual == null ? (
                          <span className="text-red-600">—</span>
                        ) : (
                          formatBRL(num(r.cmv_atual))
                        )}
                      </TableCell>
                      <TableCell>
                        {r.sku_mapeado ? (
                          <div className="flex flex-col text-xs">
                            <span className="font-mono font-medium">
                              {r.sku_mapeado}
                            </span>
                            {r.produto_atual && (
                              <span className="text-muted-foreground truncate max-w-[200px]">
                                {r.produto_atual}
                              </span>
                            )}
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            onClick={() => setEditando(r)}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Mapear
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.sku_mapeado && (
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => setEditando(r)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-red-600 hover:text-red-700"
                              onClick={() => setRemovendo(r)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>

        {editando && (
          <MapearModal
            row={editando}
            open={!!editando}
            onClose={() => setEditando(null)}
            onSaved={() => {
              queryClient.invalidateQueries({
                queryKey: ["amazon", "view_amazon_skus_mapear"],
              });
              setEditando(null);
            }}
          />
        )}

        <AlertDialog open={!!removendo} onOpenChange={(o) => !o && setRemovendo(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remover mapeamento?</AlertDialogTitle>
              <AlertDialogDescription>
                Isso remove o mapeamento do SKU{" "}
                <span className="font-mono">{removendo?.sku_amazon}</span>. O
                cálculo volta a usar o SKU original.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  removendo && removeMutation.mutate(removendo.sku_amazon)
                }
                className="bg-red-600 hover:bg-red-700"
              >
                Remover
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function MapearModal({
  row,
  open,
  onClose,
  onSaved,
}: {
  row: SkuMapearRow;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [termo, setTermo] = useState("");
  const [selecionado, setSelecionado] = useState<ProdutoOption | null>(
    row.sku_mapeado
      ? { sku: row.sku_mapeado, nome: row.produto_atual ?? null }
      : null,
  );
  const [observacao, setObservacao] = useState("");
  const [salvando, setSalvando] = useState(false);

  const { data: produtos, isFetching } = useQuery({
    queryKey: ["produtos-busca", termo],
    queryFn: async () => {
      const q = termo.trim();
      let query = supabaseExternal
        .from("produtos")
        .select("sku, nome")
        .limit(20);
      if (q) {
        query = query.or(`sku.ilike.%${q}%,nome.ilike.%${q}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as ProdutoOption[];
    },
    enabled: open,
  });

  async function handleSalvar() {
    if (!selecionado) {
      toast.error("Selecione um SKU do cadastro");
      return;
    }
    setSalvando(true);
    try {
      const { error } = await supabaseExternal.from("sku_mapeamento").upsert(
        {
          marketplace: "amazon",
          sku_origem: row.sku_amazon,
          sku_correto: selecionado.sku,
          nome_anuncio: row.nome_anuncio,
          observacao: observacao.trim() || null,
        },
        { onConflict: "marketplace,sku_origem" },
      );
      if (error) throw error;
      toast.success(
        "Mapeamento salvo. O CMV e a margem são recalculados no próximo sync.",
      );
      onSaved();
    } catch (e) {
      toast.error(`Erro ao salvar: ${(e as Error).message}`);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {row.nome_anuncio ?? "Sem título"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            SKU Amazon: {row.sku_amazon}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 rounded-md border bg-muted/30 p-3 text-xs">
          <div>
            <div className="text-muted-foreground">Preço médio/un</div>
            <div className="font-medium">
              {row.preco_medio_un != null
                ? formatBRL(num(row.preco_medio_un))
                : "—"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Unidades vendidas</div>
            <div className="font-medium">{formatNumber(num(row.unidades))}</div>
          </div>
          <div>
            <div className="text-muted-foreground">CMV atual</div>
            <div className="font-medium">
              {row.cmv_atual != null ? formatBRL(num(row.cmv_atual)) : "—"}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">SKU do cadastro interno</label>
          {selecionado && (
            <div className="flex items-center justify-between rounded-md border bg-emerald-50 border-emerald-200 p-2">
              <div className="text-sm">
                <span className="font-mono font-medium">{selecionado.sku}</span>
                {selecionado.nome && (
                  <span className="text-muted-foreground"> — {selecionado.nome}</span>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelecionado(null)}
              >
                Trocar
              </Button>
            </div>
          )}
          {!selecionado && (
            <>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Digite SKU ou nome do produto…"
                  value={termo}
                  onChange={(e) => setTermo(e.target.value)}
                  className="pl-8"
                />
              </div>
              <div className="max-h-[240px] overflow-y-auto rounded-md border">
                {isFetching && (
                  <div className="p-3 text-xs text-muted-foreground">Buscando…</div>
                )}
                {!isFetching && (produtos ?? []).length === 0 && (
                  <div className="p-3 text-xs text-muted-foreground">
                    Nenhum produto encontrado
                  </div>
                )}
                {(produtos ?? []).map((p) => (
                  <button
                    key={p.sku}
                    onClick={() => setSelecionado(p)}
                    className="w-full text-left px-3 py-2 hover:bg-muted text-sm border-b last:border-b-0"
                  >
                    <div className="font-mono font-medium">{p.sku}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {p.nome ?? "—"}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Observação (opcional)</label>
          <Textarea
            value={observacao}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="Ex.: anúncio de 1un apontava pra kit de 2"
            rows={2}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button onClick={handleSalvar} disabled={salvando || !selecionado}>
            {salvando ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResumoCard({
  icon,
  label,
  value,
  color,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  color: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={cn(
        "p-4",
        highlight && "border-red-200 bg-red-50/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          {value === null ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <p className="text-xl font-semibold truncate">{value}</p>
          )}
        </div>
        <div className={cn("rounded-md p-2 shrink-0", color)}>{icon}</div>
      </div>
    </Card>
  );
}
