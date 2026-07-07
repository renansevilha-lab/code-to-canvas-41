import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PackageCheck,
  Zap,
  Copy,
  RefreshCw,
  Search,
  Check,
  Boxes as BoxesIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatNumber } from "@/lib/format";

export const Route = createFileRoute("/separacao")({
  component: SeparacaoPage,
});

interface SeparacaoRow {
  separacao_id: number;
  numero_pedido: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  tipo: "unitario" | "multi_sku" | string;
  sku: string | null;
  nome_produto: string | null;
  qtd_unidades: number | null;
  tipo_envio: string | null;
  tag_sugerida: string | null;
  data_criacao: string | null;
  detalhado_em: string | null;
}

const ENVIO_COLOR: Record<string, string> = {
  ER: "#EF4444",
  SPX: "#EE4D2D",
  ML: "#FFE600",
  TEMU: "#F97316",
  SHEIN: "#111827",
  TIKTOK: "#000000",
};

function envioColor(t: string | null): string {
  if (!t) return "#9CA3AF";
  return ENVIO_COLOR[t] ?? "#9CA3AF";
}

function EnvioDot({ tipo }: { tipo: string | null }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
      style={{ backgroundColor: envioColor(tipo) }}
      aria-hidden
    />
  );
}

function useSeparacaoRows() {
  return useQuery({
    queryKey: ["separacao", "view_separacao_analise"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_analise")
        .select("*")
        .limit(10000);
      if (error) throw error;
      return (data ?? []) as SeparacaoRow[];
    },
  });
}

function SeparacaoPage() {
  const { data: rows, isLoading, error, refetch, isFetching } = useSeparacaoRows();
  const qc = useQueryClient();
  const [selectedEnvios, setSelectedEnvios] = useState<string[] | null>(null);
  const [busca, setBusca] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const enviosDisponiveis = useMemo(() => {
    const set = new Set<string>();
    (rows ?? []).forEach((r) => r.tipo_envio && set.add(r.tipo_envio));
    return Array.from(set).sort((a, b) => {
      if (a === "ER") return -1;
      if (b === "ER") return 1;
      return a.localeCompare(b);
    });
  }, [rows]);

  const enviosAtivos = selectedEnvios ?? enviosDisponiveis;
  const enviosAtivosSet = useMemo(() => new Set(enviosAtivos), [enviosAtivos]);

  const filtered = useMemo(() => {
    return (rows ?? []).filter((r) =>
      r.tipo_envio ? enviosAtivosSet.has(r.tipo_envio) : true,
    );
  }, [rows, enviosAtivosSet]);

  // KPIs
  const totalPedidos = filtered.length;
  const totalUnidades = filtered.reduce((s, r) => s + (r.qtd_unidades ?? 0), 0);
  const totalUnitarios = filtered.filter((r) => r.tipo === "unitario").length;
  const totalMulti = filtered.filter((r) => r.tipo === "multi_sku").length;
  const totalER = filtered.filter((r) => r.tipo_envio === "ER").length;

  // Picking list agrupada por SKU + tipo_envio
  const pickingList = useMemo(() => {
    const map = new Map<
      string,
      {
        sku: string;
        nome_produto: string | null;
        tipo_envio: string | null;
        qtd_pedidos: number;
        unidades: number;
      }
    >();
    for (const r of filtered) {
      if (r.tipo !== "unitario" || !r.sku) continue;
      const key = `${r.sku}||${r.tipo_envio ?? ""}`;
      const cur = map.get(key);
      if (cur) {
        cur.qtd_pedidos += 1;
        cur.unidades += r.qtd_unidades ?? 0;
      } else {
        map.set(key, {
          sku: r.sku,
          nome_produto: r.nome_produto,
          tipo_envio: r.tipo_envio,
          qtd_pedidos: 1,
          unidades: r.qtd_unidades ?? 0,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const aER = a.tipo_envio === "ER" ? 1 : 0;
      const bER = b.tipo_envio === "ER" ? 1 : 0;
      if (aER !== bER) return bER - aER;
      return b.qtd_pedidos - a.qtd_pedidos;
    });
  }, [filtered]);

  // Lista de pedidos individuais
  const pedidos = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const list = filtered.filter((r) => {
      if (!q) return true;
      return (
        (r.numero_pedido ?? "").toLowerCase().includes(q) ||
        (r.numero_ecommerce ?? "").toLowerCase().includes(q) ||
        (r.sku ?? "").toLowerCase().includes(q)
      );
    });
    return list.sort((a, b) => {
      const aER = a.tipo_envio === "ER" ? 1 : 0;
      const bER = b.tipo_envio === "ER" ? 1 : 0;
      if (aER !== bER) return bER - aER;
      const ad = a.data_criacao ?? "";
      const bd = b.data_criacao ?? "";
      return ad.localeCompare(bd);
    });
  }, [filtered, busca]);

  function toggleEnvio(env: string) {
    const base = selectedEnvios ?? enviosDisponiveis;
    if (base.includes(env)) {
      setSelectedEnvios(base.filter((e) => e !== env));
    } else {
      setSelectedEnvios([...base, env]);
    }
  }

  async function copiarTag(id: string, tag: string) {
    try {
      await navigator.clipboard.writeText(tag);
      setCopiedId(id);
      toast.success("TAG copiada", { description: tag });
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      toast.error("Não foi possível copiar");
    }
  }

  async function atualizarFila() {
    setSyncing(true);
    try {
      const res = await fetch(
        "https://vhogjofsxyhnyxdyglmq.supabase.co/functions/v1/tiny-separacao?modulo=sync&max=200",
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Fila sincronizada");
      await qc.invalidateQueries({ queryKey: ["separacao"] });
      await refetch();
    } catch (e) {
      toast.error("Erro ao atualizar fila", {
        description: (e as Error).message,
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PackageCheck className="h-6 w-6 text-primary" />
            Separação
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Fila de pedidos aguardando separação no galpão (Full excluído).
          </p>
        </div>
        <Button onClick={atualizarFila} disabled={syncing || isFetching} variant="outline">
          <RefreshCw className={cn("h-4 w-4 mr-2", (syncing || isFetching) && "animate-spin")} />
          Atualizar fila
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Total a separar
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-24 mt-2" />
          ) : (
            <>
              <div className="text-2xl font-semibold mt-1">
                {formatNumber(totalPedidos)} <span className="text-sm font-normal text-muted-foreground">pedidos</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {formatNumber(totalUnidades)} unidades
              </div>
            </>
          )}
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Unitários
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16 mt-2" />
          ) : (
            <div className="text-2xl font-semibold mt-1">{formatNumber(totalUnitarios)}</div>
          )}
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
            <BoxesIcon className="h-3 w-3" /> Multi SKU
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16 mt-2" />
          ) : (
            <div className="text-2xl font-semibold mt-1">{formatNumber(totalMulti)}</div>
          )}
        </Card>
        <Card className="p-4 border-destructive/40 bg-destructive/5">
          <div className="text-xs uppercase tracking-wide flex items-center gap-1 text-destructive font-medium">
            <Zap className="h-3 w-3" /> Entrega Rápida (ER)
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16 mt-2" />
          ) : (
            <div className="text-2xl font-semibold mt-1 text-destructive">
              {formatNumber(totalER)} <span className="text-sm font-normal">pedidos ⚡</span>
            </div>
          )}
        </Card>
      </div>

      {/* Filtro tipo de envio */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-muted-foreground mr-1">Tipo de envio:</span>
        <Button
          size="sm"
          variant={selectedEnvios === null || selectedEnvios.length === enviosDisponiveis.length ? "default" : "outline"}
          onClick={() => setSelectedEnvios(null)}
        >
          Todos
        </Button>
        {enviosDisponiveis.map((env) => {
          const active = enviosAtivosSet.has(env);
          const isER = env === "ER";
          return (
            <Button
              key={env}
              size="sm"
              variant={active ? (isER ? "destructive" : "default") : "outline"}
              onClick={() => toggleEnvio(env)}
              className={cn(isER && !active && "border-destructive/50 text-destructive hover:bg-destructive/10")}
            >
              {isER && <Zap className="h-3 w-3 mr-1" />}
              {!isER && <EnvioDot tipo={env} />}
              <span className={isER ? "" : "ml-1.5"}>{env}</span>
            </Button>
          );
        })}
      </div>

      {/* Empty state */}
      {!isLoading && !error && (rows?.length ?? 0) === 0 && (
        <Card className="p-12 text-center">
          <PackageCheck className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">
            Nenhum pedido aguardando separação no momento.
          </p>
        </Card>
      )}

      {error && (
        <Card className="p-4 border-destructive text-destructive text-sm">
          Erro ao carregar: {(error as Error).message}
        </Card>
      )}

      {/* Picking list */}
      {!isLoading && pickingList.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-sm">Resumo por SKU (picking list)</h2>
              <p className="text-xs text-muted-foreground">
                Somente unitários. ER destacado e ordenado primeiro.
              </p>
            </div>
            <Badge variant="secondary">{pickingList.length} linhas</Badge>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">SKU</th>
                  <th className="text-left px-4 py-2 font-medium">Produto</th>
                  <th className="text-left px-4 py-2 font-medium">Envio</th>
                  <th className="text-right px-4 py-2 font-medium">Nº Pedidos</th>
                  <th className="text-right px-4 py-2 font-medium">Unidades</th>
                </tr>
              </thead>
              <tbody>
                {pickingList.map((row, i) => {
                  const isER = row.tipo_envio === "ER";
                  return (
                    <tr
                      key={`${row.sku}-${row.tipo_envio}-${i}`}
                      className={cn(
                        "border-t",
                        isER ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/30",
                      )}
                    >
                      <td className="px-4 py-2 font-mono text-xs">{row.sku}</td>
                      <td className="px-4 py-2">{row.nome_produto ?? "—"}</td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          {isER ? (
                            <Zap className="h-3 w-3 text-destructive" />
                          ) : (
                            <EnvioDot tipo={row.tipo_envio} />
                          )}
                          <span className={cn(isER && "font-semibold text-destructive")}>
                            {row.tipo_envio ?? "—"}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {formatNumber(row.qtd_pedidos)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">
                        {formatNumber(row.unidades)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Lista de pedidos individuais */}
      {!isLoading && (rows?.length ?? 0) > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold text-sm">Pedidos individuais</h2>
              <p className="text-xs text-muted-foreground">
                Copie a TAG sugerida pra colar no Tiny.
              </p>
            </div>
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por pedido ou SKU..."
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Nº Pedido</th>
                  <th className="text-left px-4 py-2 font-medium">Canal</th>
                  <th className="text-left px-4 py-2 font-medium">Tipo</th>
                  <th className="text-left px-4 py-2 font-medium">Envio</th>
                  <th className="text-left px-4 py-2 font-medium">TAG Sugerida</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {pedidos.slice(0, 500).map((r) => {
                  const isER = r.tipo_envio === "ER";
                  const isMulti = r.tipo === "multi_sku";
                  const id = String(r.separacao_id);
                  return (
                    <tr
                      key={id}
                      className={cn(
                        "border-t",
                        isER ? "bg-destructive/5 hover:bg-destructive/10" : "hover:bg-muted/30",
                      )}
                    >
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.numero_pedido ?? r.numero_ecommerce ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-xs">{r.marca_canal ?? "—"}</td>
                      <td className="px-4 py-2">
                        {isMulti ? (
                          <Badge variant="secondary" className="text-[10px]">
                            <BoxesIcon className="h-3 w-3 mr-1" />
                            multi
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">unitário</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          {isER ? (
                            <Zap className="h-3 w-3 text-destructive" />
                          ) : (
                            <EnvioDot tipo={r.tipo_envio} />
                          )}
                          <span
                            className={cn(
                              "text-xs",
                              isER && "font-semibold text-destructive",
                            )}
                          >
                            {r.tipo_envio ?? "—"}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <code
                          className={cn(
                            "font-mono text-xs px-2 py-1 rounded",
                            isMulti
                              ? "bg-muted text-muted-foreground"
                              : isER
                                ? "bg-destructive/10 text-destructive"
                                : "bg-muted",
                          )}
                        >
                          {r.tag_sugerida ?? "—"}
                        </code>
                      </td>
                      <td className="px-2 py-2">
                        {r.tag_sugerida && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => copiarTag(id, r.tag_sugerida!)}
                            title="Copiar TAG"
                          >
                            {copiedId === id ? (
                              <Check className="h-3.5 w-3.5 text-green-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pedidos.length > 500 && (
              <div className="px-4 py-2 text-xs text-muted-foreground border-t">
                Mostrando 500 de {formatNumber(pedidos.length)} pedidos. Refine a busca ou o filtro.
              </div>
            )}
          </div>
        </Card>
      )}

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
    </div>
  );
}

// unused import guard
void DropdownMenu;
void DropdownMenuCheckboxItem;
void DropdownMenuContent;
void DropdownMenuLabel;
void DropdownMenuSeparator;
void DropdownMenuTrigger;
