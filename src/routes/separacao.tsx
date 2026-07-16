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
  ImageOff,
  Hourglass,
  Loader2,
  CheckCircle2,
  Package,
  Tag as TagIcon,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Printer,
  AlertTriangle,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  supabaseExternal,
  EXTERNAL_URL,
  EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { formatNumber } from "@/lib/format";

// ============ Edge function helpers ============

interface TagLoteResponse {
  tag: string;
  grupo: string;
  pedidos_tagueados: number;
  pedidos_pulados: number;
  aviso: string | null;
  proximo_passo: string;
}

interface EmbalarLoteResponse {
  tag: string;
  embaladas: number;
  total: number;
  erros: unknown[];
}

async function callSeparacaoFn<T>(qs: string): Promise<T> {
  const url = `${EXTERNAL_URL}/functions/v1/tiny-separacao?${qs}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const data = (await resp.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!resp.ok) {
    const err = new Error(
      (data as { error?: string; message?: string }).error ??
        (data as { message?: string }).message ??
        `HTTP ${resp.status}`,
    ) as Error & { status?: number; body?: unknown };
    err.status = resp.status;
    err.body = data;
    throw err;
  }
  return data as T;
}

interface TagLoteRow {
  id: number;
  data: string;
  sequencia: number;
  tag: string;
  grupo_origem: string;
  sku: string | null;
  tipo_envio: string | null;
  qtd_pedidos: number;
  qtd_pulados: number;
  status: "aplicada" | "embalada" | string;
  embalado_em: string | null;
  impresso_em?: string | null;
  criado_em: string;
}

// ============ Impressoras (PrintNode via edge fn) ============

interface Impressora {
  printer_id: number;
  nome: string;
  computador: string;
  estado: "online" | "offline" | string;
  descricao: string;
}

const DEFAULT_PRINTER_ID = 75638226;

function useImpressoras() {
  return useQuery({
    queryKey: ["separacao", "impressoras"],
    queryFn: async () => {
      const resp = await fetch(
        `${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras`,
        { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
      );
      const data = (await resp.json().catch(() => ({}))) as {
        impressoras?: Impressora[];
      };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // Somente ZD220 (etiqueta Shopee ZPL)
      return (data.impressoras ?? []).filter((p) =>
        (p.descricao ?? "").toLowerCase().includes("zdesigner zd220"),
      );
    },
    refetchInterval: 60_000,
  });
}

interface ImprimirResponse {
  modulo: string;
  tag: string;
  printnode_job_id: number;
  etiquetas_enviadas: number;
  pedidos_no_lote: number;
  etiquetas_prontas: number;
  aviso: string | null;
  erro?: string;
}

function useTagsDoDia() {
  return useQuery({
    queryKey: ["separacao", "tags_lote", "hoje"],
    queryFn: async () => {
      const hoje = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabaseExternal
        .from("tags_lote")
        .select("*")
        .eq("data", hoje)
        .order("sequencia", { ascending: true });
      if (error) throw error;
      return (data ?? []) as TagLoteRow[];
    },
    refetchInterval: 30_000,
  });
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("TAG copiada", { description: text });
  } catch {
    toast.error("Não foi possível copiar");
  }
}


interface PriorizadaRow {
  prioridade: number;
  tipo_grupo: string | null;
  ordem_envio: number;
  tipo_envio: string | null;
  sku: string | null;
  nome_produto: string | null;
  qtd_unidades: number | null;
  qtd_pedidos: number | null;
  total_unidades: number | null;
  tag_sugerida: string | null;
  foto_capa: string | null;
}

function usePriorizadaRows() {
  return useQuery({
    queryKey: ["separacao", "view_separacao_priorizada"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_priorizada")
        .select("*")
        .order("prioridade", { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as PriorizadaRow[];
    },
  });
}

/**
 * Lê tag_lote de todos os pedidos atualmente na fila de separação
 * (view_separacao_pedidos) e agrupa por `${sku_unico}|${tipo_envio}`.
 *
 * Fonte da verdade para decidir se a linha mostra selo de TAG ou botão
 * "Aplicar TAG". Nunca use lotesHoje (tags_lote) pra isso — aquilo é
 * histórico do dia e mantém tags de lotes já impressos, o que faz aparecer
 * tag velha em linhas com pedidos novos sem tag.
 */
interface TagsPorLinha {
  estado: "sem_tag" | "com_tag" | "tags_mistas" | "parcial";
  tag?: string;
  semTag: number;
  comTag: number;
}
function useTagsPorLinha() {
  return useQuery({
    queryKey: ["separacao", "tags_por_linha"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_pedidos")
        .select("sku_unico, tipo_envio, tag_lote")
        .limit(20000);
      if (error) throw error;
      const map = new Map<string, TagsPorLinha>();
      const buckets = new Map<string, { tags: Set<string>; sem: number; com: number }>();
      for (const p of (data ?? []) as { sku_unico: string | null; tipo_envio: string | null; tag_lote: string | null }[]) {
        const key = `${p.sku_unico ?? ""}|${p.tipo_envio ?? ""}`;
        const b = buckets.get(key) ?? { tags: new Set<string>(), sem: 0, com: 0 };
        if (p.tag_lote) { b.tags.add(p.tag_lote); b.com++; }
        else { b.sem++; }
        buckets.set(key, b);
      }
      for (const [key, b] of buckets) {
        const tagsArr = [...b.tags];
        let estado: TagsPorLinha["estado"];
        let tag: string | undefined;
        if (tagsArr.length === 0) estado = "sem_tag";
        else if (tagsArr.length === 1 && b.sem === 0) { estado = "com_tag"; tag = tagsArr[0]; }
        else if (tagsArr.length === 1 && b.sem > 0) { estado = "parcial"; tag = tagsArr[0]; }
        else estado = "tags_mistas";
        map.set(key, { estado, tag, semTag: b.sem, comTag: b.com });
      }
      return map;
    },
  });
}

function useFullCount() {
  return useQuery({
    queryKey: ["separacao", "full_count"],
    queryFn: async () => {
      const { count, error } = await supabaseExternal
        .from("pedidos_tiny")
        .select("*", { count: "exact", head: true })
        .or("marca_canal.ilike.*Fulfillment*,marca_canal.ilike.*Full*")
        .in("situacao", ["preparando_envio", "aprovada"]);
      if (error) return 0;
      return count ?? 0;
    },
  });
}

interface SeparacaoTotais {
  id: number;
  aguardando_separacao: number | null;
  em_separacao: number | null;
  separadas_hoje: number | null;
  embaladas_hoje: number | null;
  atualizado_em: string | null;
}

function useSeparacaoTotais() {
  return useQuery({
    queryKey: ["separacao", "separacao_totais"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("separacao_totais")
        .select("*")
        .eq("id", 1)
        .single();
      if (error) throw error;
      return data as SeparacaoTotais;
    },
  });
}

function tempoRelativo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  if (!Number.isFinite(then)) return "—";
  const diffMin = Math.floor(Math.max(0, now - then) / 60000);
  if (diffMin < 1) return "agora mesmo";
  if (diffMin === 1) return "1 minuto";
  if (diffMin < 60) return `${diffMin} minutos`;
  const h = Math.floor(diffMin / 60);
  if (h === 1) return "1 hora";
  if (h < 24) return `${h} horas`;
  const d = Math.floor(h / 24);
  if (d === 1) return "1 dia";
  return `${d} dias`;
}

function SeparacaoTotaisCards() {
  const { data, isLoading, error } = useSeparacaoTotais();

  const cards = [
    {
      key: "aguardando",
      label: "Aguardando separação",
      value: data?.aguardando_separacao ?? 0,
      icon: Hourglass,
      bg: "bg-blue-50 dark:bg-blue-950/30",
      text: "text-blue-700 dark:text-blue-300",
      border: "border-blue-200 dark:border-blue-900",
    },
    {
      key: "em_separacao",
      label: "Em separação",
      value: data?.em_separacao ?? 0,
      icon: Loader2,
      bg: "bg-amber-50 dark:bg-amber-950/30",
      text: "text-amber-700 dark:text-amber-300",
      border: "border-amber-200 dark:border-amber-900",
    },
    {
      key: "separadas_hoje",
      label: "Separadas hoje",
      value: data?.separadas_hoje ?? 0,
      icon: CheckCircle2,
      bg: "bg-green-50 dark:bg-green-950/30",
      text: "text-green-700 dark:text-green-300",
      border: "border-green-200 dark:border-green-900",
    },
    {
      key: "embaladas_hoje",
      label: "Embaladas hoje",
      value: data?.embaladas_hoje ?? 0,
      icon: Package,
      bg: "bg-emerald-50 dark:bg-emerald-950/40",
      text: "text-emerald-800 dark:text-emerald-300",
      border: "border-emerald-200 dark:border-emerald-900",
    },
  ];

  if (error) {
    return (
      <Card className="p-3 border-destructive text-destructive text-xs">
        Erro ao carregar totais: {(error as Error).message}
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <Card
            key={c.key}
            className={cn("p-4 border", c.bg, c.border)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("text-xs font-medium truncate", c.text)}>
                  {c.label}
                </p>
                {isLoading ? (
                  <Skeleton className="h-8 w-16 mt-1" />
                ) : (
                  <p className={cn("text-2xl font-semibold tabular-nums mt-1", c.text)}>
                    {formatNumber(c.value)}
                  </p>
                )}
              </div>
              <c.icon className={cn("h-5 w-5 shrink-0", c.text)} />
            </div>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Atualizado há {tempoRelativo(data?.atualizado_em ?? null)}
      </p>
    </div>
  );
}

const ENVIO_HEADER: Record<
  string,
  { bg: string; text: string; label: string; icon?: boolean }
> = {
  ER: { bg: "#EF4444", text: "#FFFFFF", label: "ENTREGA RÁPIDA (ER) — PRIORIDADE", icon: true },
  SPX: { bg: "#EE4D2D", text: "#FFFFFF", label: "SHOPEE EXPRESS (SPX)" },
  ML: { bg: "#FFE600", text: "#111827", label: "MERCADO LIVRE (ML)" },
};

function ProdutoFoto({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="w-20 h-20 rounded-md bg-muted flex flex-col items-center justify-center text-muted-foreground shrink-0">
        <ImageOff className="h-5 w-5" />
        <span className="text-[9px] mt-0.5">sem foto</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-20 h-20 rounded-md object-cover bg-muted shrink-0"
    />
  );
}

// ============ Impressão helpers (compartilhados) ============

interface PedidoSepRow {
  tag_lote: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  tipo_envio: string | null;
  sku_unico: string | null;
  venda_numero: string | null;
  embalado_em?: string | null;
  impresso_em?: string | null;
}

function marcaToLoja(m: string | null): "ottz" | "svl" | "tiktok" | null {
  if (!m) return null;
  const s = m.toLowerCase();
  if (s.includes("ottz")) return "ottz";
  if (s.includes("svl") || s.includes("sevilla")) return "svl";
  if (s.includes("tiktok")) return "tiktok";
  return null;
}

async function imprimirLoteApi(
  loja: "ottz" | "svl",
  tag: string,
  printerId: number,
  printerNome?: string,
) {
  const url =
    `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
    `?modulo=imprimir&loja=${loja}&tag=${encodeURIComponent(tag)}&printer_id=${printerId}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const data = (await resp.json().catch(() => ({}))) as ImprimirResponse;
  if (!resp.ok || data.erro) {
    toast.error(`Falha ao imprimir lote ${tag}`, {
      description: data.erro ?? `HTTP ${resp.status}`,
    });
    return;
  }
  if ((data.etiquetas_prontas ?? 0) < (data.pedidos_no_lote ?? 0)) {
    toast.warning(
      `Lote ${tag}: ${data.etiquetas_enviadas} de ${data.pedidos_no_lote} etiquetas`,
      {
        description:
          data.aviso ?? "Alguns pedidos não tinham etiqueta pronta na Shopee.",
        duration: 10000,
      },
    );
  } else {
    toast.success(
      `Lote ${tag}: ${data.etiquetas_enviadas} etiqueta(s) enviadas`,
      { description: printerNome ?? "" },
    );
  }
}

async function imprimirPedidoApi(
  loja: "ottz" | "svl",
  orderSn: string,
  printerId: number,
  printerNome?: string,
) {
  const url =
    `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
    `?modulo=imprimir&loja=${loja}&order_sn=${encodeURIComponent(orderSn)}&printer_id=${printerId}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const data = (await resp.json().catch(() => ({}))) as ImprimirResponse;
  if (!resp.ok || data.erro) {
    toast.error(`Falha ao imprimir ${orderSn}`, {
      description: data.erro ?? `HTTP ${resp.status}`,
    });
    return;
  }
  if ((data.etiquetas_prontas ?? 0) < (data.pedidos_no_lote ?? 1)) {
    toast.warning(`Etiqueta ${orderSn} não estava pronta na Shopee`, {
      description: data.aviso ?? "Pedido não foi impresso.",
      duration: 10000,
    });
  } else {
    toast.success(`Etiqueta ${orderSn} enviada`, {
      description: printerNome ?? "",
    });
  }
}

// ============ Pedidos individuais expandidos (por SKU) ============

interface PedidosDoSkuProps {
  sku: string | null;
  tipoEnvio: string | null;
  imprimindoKey: string | null;
  embalandoKey: string | null;
  onImprimir: (p: PedidoSepRow) => void;
  onEmbalar: (p: PedidoSepRow) => void;
}

function PedidosDoSku({
  sku,
  tipoEnvio,
  imprimindoKey,
  embalandoKey,
  onImprimir,
  onEmbalar,
}: PedidosDoSkuProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["separacao", "view_separacao_pedidos", sku, tipoEnvio],
    enabled: !!sku,
    queryFn: async () => {
      let q = supabaseExternal.from("view_separacao_pedidos").select("*");
      if (sku) q = q.eq("sku_unico", sku);
      if (tipoEnvio) q = q.eq("tipo_envio", tipoEnvio);
      const { data: d, error: e } = await q.limit(1000);
      if (e) throw e;
      return (d ?? []) as PedidoSepRow[];
    },
  });

  if (isLoading) {
    return (
      <div className="pl-8 py-2">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="pl-8 py-2 text-xs text-destructive">
        Erro: {(error as Error).message}
      </div>
    );
  }
  const pedidos = data ?? [];
  if (pedidos.length === 0) {
    return (
      <div className="pl-8 py-2 text-xs text-muted-foreground">
        Nenhum pedido encontrado.
      </div>
    );
  }
  return (
    <div className="ml-8 mt-1 mb-2 border-l-2 border-muted pl-3">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase text-muted-foreground">
          <tr className="border-b">
            <th className="text-left py-1 pr-2 font-medium">Pedido</th>
            <th className="text-left py-1 pr-2 font-medium">Canal</th>
            <th className="text-left py-1 pr-2 font-medium">Lote</th>
            <th className="text-left py-1 pr-2 font-medium">Status</th>
            <th className="text-right py-1 font-medium">Ação</th>
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p, i) => {
            const loja = marcaToLoja(p.marca_canal);
            const isTiktok = loja === "tiktok";
            const key = `ped:${p.numero_ecommerce}`;
            const busyImp = imprimindoKey === key;
            const busyEmb = embalandoKey === key;
            return (
              <tr key={`${p.numero_ecommerce}-${i}`} className="border-b last:border-0">
                <td className="py-1 pr-2 font-mono">{p.numero_ecommerce ?? "—"}</td>
                <td className="py-1 pr-2">
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded",
                      isTiktok
                        ? "bg-black text-white"
                        : loja === "svl"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                          : "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300",
                    )}
                  >
                    {p.marca_canal ?? "—"}
                  </span>
                </td>
                <td className="py-1 pr-2 font-mono">{p.tag_lote ?? "—"}</td>
                <td className="py-1 pr-2">
                  <div className="flex items-center gap-1">
                    {p.impresso_em && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-green-700 dark:text-green-400">
                        <Printer className="h-2.5 w-2.5" /> impresso
                      </span>
                    )}
                    {p.embalado_em && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-green-700 dark:text-green-400">
                        <CheckCircle2 className="h-2.5 w-2.5" /> embalado
                      </span>
                    )}
                    {!p.impresso_em && !p.embalado_em && (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </div>
                </td>
                <td className="py-1 text-right">
                  <div className="inline-flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={isTiktok || busyImp || imprimindoKey !== null}
                      onClick={() => onImprimir(p)}
                      title={
                        isTiktok
                          ? "TikTok não usa etiqueta Shopee"
                          : "Imprimir etiqueta"
                      }
                    >
                      {busyImp ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Printer className="h-3 w-3" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={busyEmb || embalandoKey !== null}
                      onClick={() => onEmbalar(p)}
                      title="Marcar embalado"
                    >
                      {busyEmb ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Package className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============ Lotes do dia panel ============

interface LotesDoDiaProps {
  printerId: number;
  setPrinterId: (id: number) => void;
  impressoras: Impressora[];
  loadingImpressoras: boolean;
  impressoraSelecionada: Impressora | undefined;
}

function LotesDoDia({
  printerId,
  setPrinterId,
  impressoras,
  loadingImpressoras,
  impressoraSelecionada,
}: LotesDoDiaProps) {
  const qc = useQueryClient();
  const { data: lotes, isLoading, error } = useTagsDoDia();
  const [ajudaAberta, setAjudaAberta] = useState(false);
  const [confirmar, setConfirmar] = useState<TagLoteRow | null>(null);
  const [embalando, setEmbalando] = useState<string | null>(null);
  const [imprimindo, setImprimindo] = useState<string | null>(null);
  const [lojaPorTag, setLojaPorTag] = useState<Record<string, "ottz" | "svl">>({});

  function lojaDoLote(lote: TagLoteRow): "ottz" | "svl" {
    if (lojaPorTag[lote.tag]) return lojaPorTag[lote.tag];
    const g = (lote.grupo_origem ?? "").toLowerCase();
    if (g.includes("svl") || g.includes("sevilla")) return "svl";
    return "ottz";
  }

  async function imprimirLote(lote: TagLoteRow) {
    if (imprimindo) return;
    setImprimindo(lote.tag);
    try {
      const loja = lojaDoLote(lote);
      const url =
        `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
        `?modulo=imprimir&loja=${loja}` +
        `&tag=${encodeURIComponent(lote.tag)}` +
        `&printer_id=${printerId}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const data = (await resp.json().catch(() => ({}))) as ImprimirResponse;
      if (!resp.ok || data.erro) {
        toast.error("Erro ao imprimir", {
          description: data.erro ?? `HTTP ${resp.status}`,
        });
        return;
      }
      if (data.etiquetas_prontas < data.pedidos_no_lote) {
        toast.warning(
          `Lote ${data.tag}: ${data.etiquetas_enviadas} de ${data.pedidos_no_lote} etiquetas`,
          {
            description:
              data.aviso ??
              "Alguns pedidos não tinham etiqueta pronta na Shopee e não foram impressos.",
            duration: 10000,
          },
        );
      } else {
        toast.success(
          `Lote ${data.tag} enviado para impressão (${data.etiquetas_enviadas} etiquetas)`,
          { description: impressoraSelecionada?.nome ?? "" },
        );
      }
      await qc.invalidateQueries({ queryKey: ["separacao", "tags_lote", "hoje"] });
    } catch (e) {
      toast.error("Erro ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindo(null);
    }
  }

  async function marcarEmbalado(lote: TagLoteRow) {
    setEmbalando(lote.tag);
    try {
      const data = await callSeparacaoFn<EmbalarLoteResponse>(
        `modulo=embalar-lote&tag=${encodeURIComponent(lote.tag)}&confirmar=1`,
      );
      if (data.erros && data.erros.length > 0) {
        toast.warning(
          `${data.embaladas} de ${data.total} embalados — ${data.erros.length} erro(s)`,
          { description: JSON.stringify(data.erros).slice(0, 200) },
        );
      } else {
        toast.success(
          `${data.embaladas} de ${data.total} pedidos marcados como embalados`,
          { description: `Lote ${data.tag}` },
        );
      }
      await qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      const err = e as Error;
      toast.error("Erro ao marcar embalado", { description: err.message });
    } finally {
      setEmbalando(null);
      setConfirmar(null);
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <TagIcon className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-sm">Lotes do dia</h2>
          {lotes && lotes.length > 0 && (
            <Badge variant="secondary">{lotes.length}</Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAjudaAberta((v) => !v)}
          className="text-xs h-7"
        >
          Como usar
          {ajudaAberta ? (
            <ChevronUp className="h-3 w-3 ml-1" />
          ) : (
            <ChevronDown className="h-3 w-3 ml-1" />
          )}
        </Button>
      </div>

      {/* Impressora */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Printer className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Impressora:</span>
        <Select
          value={String(printerId)}
          onValueChange={(v) => setPrinterId(Number(v))}
          disabled={loadingImpressoras}
        >
          <SelectTrigger className="h-8 w-[320px] text-xs">
            <SelectValue placeholder={loadingImpressoras ? "Carregando..." : "Selecione"} />
          </SelectTrigger>
          <SelectContent>
            {(impressoras ?? []).map((p) => (
              <SelectItem key={p.printer_id} value={String(p.printer_id)}>
                {p.nome} — {p.computador} ({p.estado})
              </SelectItem>
            ))}
            {!loadingImpressoras && (impressoras ?? []).length === 0 && (
              <SelectItem value="_" disabled>
                Nenhuma ZD220 encontrada
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {impressoraSelecionada?.estado === "offline" && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            Impressora offline — o job pode ficar preso na fila até ela reconectar.
          </span>
        )}
      </div>

      {ajudaAberta && (
        <div className="text-xs bg-muted/40 rounded-md p-3 space-y-1 text-muted-foreground">
          <p><strong className="text-foreground">1.</strong> Escolha a impressora acima (só precisa uma vez).</p>
          <p><strong className="text-foreground">2.</strong> Na fila, clique em <strong>Aplicar TAG</strong> num bloco → você recebe uma tag como <span className="font-mono">1307-01</span>.</p>
          <p><strong className="text-foreground">3.</strong> Aqui no painel, clique em <strong>Imprimir</strong> — as etiquetas saem na Zebra.</p>
          <p><strong className="text-foreground">4.</strong> Confira as etiquetas e clique em <strong>Marcar embalado</strong>.</p>
        </div>
      )}

      {isLoading && <Skeleton className="h-16 w-full" />}

      {error && (
        <div className="text-xs text-destructive">
          Erro ao carregar lotes: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && (lotes?.length ?? 0) === 0 && (
        <p className="text-xs text-muted-foreground">
          Nenhum lote aplicado hoje ainda. Clique em <strong>Aplicar TAG</strong> num bloco abaixo pra começar.
        </p>
      )}

      {!isLoading && lotes && lotes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2 pr-3 font-medium">TAG</th>
                <th className="text-left py-2 pr-3 font-medium">Bloco</th>
                <th className="text-right py-2 pr-3 font-medium">Pedidos</th>
                <th className="text-left py-2 pr-3 font-medium">Status</th>
                <th className="text-right py-2 font-medium">Ação</th>
              </tr>
            </thead>
            <tbody>
              {lotes.map((l) => {
                const embalada = l.status === "embalada";
                return (
                  <tr key={l.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-base font-semibold tabular-nums">
                          {l.tag}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => copyToClipboard(l.tag)}
                          title="Copiar tag"
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{l.grupo_origem}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNumber(l.qtd_pedidos)}
                      {l.qtd_pulados > 0 && (
                        <span className="text-xs text-amber-600 ml-1">
                          (+{l.qtd_pulados} pulados)
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {embalada ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300">
                          <CheckCircle2 className="h-3 w-3" /> Embalada
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          <Hourglass className="h-3 w-3" /> Aguardando impressão
                        </span>
                      )}
                      {l.impresso_em && (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400 ml-2"
                          title={`Impresso em ${new Date(l.impresso_em).toLocaleString("pt-BR")}`}
                        >
                          <Check className="h-3 w-3" /> Impresso
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {!embalada && (
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          <Select
                            value={lojaDoLote(l)}
                            onValueChange={(v) =>
                              setLojaPorTag((prev) => ({
                                ...prev,
                                [l.tag]: v as "ottz" | "svl",
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 w-[90px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ottz">Ottz</SelectItem>
                              <SelectItem value="svl">SVL</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="default"
                            disabled={imprimindo === l.tag || imprimindo !== null}
                            onClick={() => void imprimirLote(l)}
                          >
                            {imprimindo === l.tag ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <Printer className="h-3 w-3 mr-1" />
                                Imprimir
                              </>
                            )}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={embalando === l.tag}
                            onClick={() => setConfirmar(l)}
                          >
                            {embalando === l.tag ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Marcar embalado"
                            )}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={confirmar !== null}
        onOpenChange={(o) => !o && setConfirmar(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Marcar o lote{" "}
              <span className="font-mono">{confirmar?.tag}</span> como embalado?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  <strong>{confirmar?.qtd_pedidos ?? 0} pedidos</strong> sairão
                  da fila de separação e passarão para <strong>EMBALADO</strong>{" "}
                  no Tiny.
                </p>
                <p className="text-amber-600 dark:text-amber-400">
                  ⚠️ Só faça isso depois de imprimir as etiquetas. Esta ação
                  não pode ser desfeita.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={embalando !== null}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={embalando !== null}
              onClick={(e) => {
                e.preventDefault();
                if (confirmar) void marcarEmbalado(confirmar);
              }}
            >
              Confirmar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}


function FilaPriorizada() {
  const qc = useQueryClient();
  const { data: rows, isLoading, error } = usePriorizadaRows();
  const { data: fullCount } = useFullCount();
  const { data: lotesHoje } = useTagsDoDia();
  const { data: tagsPorLinha } = useTagsPorLinha();
  const { data: impressorasData, isLoading: loadingImpressoras } = useImpressoras();
  const impressoras = impressorasData ?? [];
  const [printerId, setPrinterId] = useState<number>(DEFAULT_PRINTER_ID);
  const impressoraSelecionada = useMemo(
    () => impressoras.find((p) => p.printer_id === printerId),
    [impressoras, printerId],
  );
  const [selectedEnvios, setSelectedEnvios] = useState<string[] | null>(null);
  const [buscaSku, setBuscaSku] = useState("");
  const [aplicando, setAplicando] = useState<string | null>(null);
  const [bloqueados, setBloqueados] = useState<Set<string>>(new Set());
  const [imprimindoKey, setImprimindoKey] = useState<string | null>(null);
  const [embalandoKey, setEmbalandoKey] = useState<string | null>(null);
  const [expandedSku, setExpandedSku] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpandedSku((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  async function imprimirPorSku(item: PriorizadaRow) {
    const key = `sku:${item.sku}:${item.tipo_envio}`;
    if (imprimindoKey) return;
    if (impressoraSelecionada?.estado === "offline") {
      if (!window.confirm("Impressora offline. O job pode ficar preso na fila. Continuar?")) return;
    }
    setImprimindoKey(key);
    try {
      const { data, error: e1 } = await supabaseExternal
        .from("view_separacao_pedidos")
        .select("tag_lote, marca_canal, numero_ecommerce")
        .eq("sku_unico", item.sku ?? "")
        .eq("tipo_envio", item.tipo_envio ?? "");
      if (e1) throw e1;
      const groups = new Map<string, { loja: "ottz" | "svl"; tag: string }>();
      let skTiktok = 0, skNoLote = 0;
      for (const p of (data ?? []) as PedidoSepRow[]) {
        const loja = marcaToLoja(p.marca_canal);
        if (loja === "tiktok" || loja === null) { skTiktok++; continue; }
        if (!p.tag_lote) { skNoLote++; continue; }
        groups.set(`${loja}|${p.tag_lote}`, { loja, tag: p.tag_lote });
      }
      if (groups.size === 0) {
        toast.warning("Nada para imprimir", {
          description: skNoLote > 0 ? "Nenhum pedido com TAG aplicada ainda." : "Só há pedidos TikTok neste SKU.",
        });
        return;
      }
      for (const g of groups.values()) {
        await imprimirLoteApi(g.loja, g.tag, printerId, impressoraSelecionada?.nome);
      }
      if (skTiktok > 0) toast.info(`${skTiktok} pedido(s) TikTok ignorados (não usam etiqueta Shopee)`);
      if (skNoLote > 0) toast.warning(`${skNoLote} pedido(s) sem TAG ignorados`);
      await qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindoKey(null);
    }
  }

  async function embalarPorSku(item: PriorizadaRow) {
    const key = `sku:${item.sku}:${item.tipo_envio}`;
    if (embalandoKey) return;
    setEmbalandoKey(key);
    try {
      const { data, error: e1 } = await supabaseExternal
        .from("view_separacao_pedidos")
        .select("tag_lote")
        .eq("sku_unico", item.sku ?? "")
        .eq("tipo_envio", item.tipo_envio ?? "");
      if (e1) throw e1;
      const tags = Array.from(
        new Set(
          ((data ?? []) as { tag_lote: string | null }[])
            .map((p) => p.tag_lote)
            .filter((t): t is string => !!t),
        ),
      );
      if (tags.length === 0) {
        toast.warning("Nenhum lote encontrado para este SKU");
        return;
      }
      let ok = 0, tot = 0, errs = 0;
      for (const tag of tags) {
        try {
          const r = await callSeparacaoFn<EmbalarLoteResponse>(
            `modulo=embalar-lote&tag=${encodeURIComponent(tag)}&confirmar=1`,
          );
          ok += r.embaladas; tot += r.total; errs += r.erros?.length ?? 0;
        } catch (e) {
          toast.error(`Lote ${tag}`, { description: (e as Error).message });
        }
      }
      toast.success(`${ok}/${tot} pedidos embalados em ${tags.length} lote(s)`, {
        description: errs > 0 ? `${errs} erro(s)` : undefined,
      });
      await qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao marcar embalado", { description: (e as Error).message });
    } finally {
      setEmbalandoKey(null);
    }
  }

  async function imprimirPedido(p: PedidoSepRow) {
    const key = `ped:${p.numero_ecommerce}`;
    const loja = marcaToLoja(p.marca_canal);
    if (loja === "tiktok" || !loja) { toast.error("TikTok não usa etiqueta Shopee"); return; }
    if (!p.numero_ecommerce) { toast.error("Sem número do pedido"); return; }
    if (imprimindoKey) return;
    if (impressoraSelecionada?.estado === "offline") {
      if (!window.confirm("Impressora offline. Continuar?")) return;
    }
    setImprimindoKey(key);
    try {
      await imprimirPedidoApi(loja, p.numero_ecommerce, printerId, impressoraSelecionada?.nome);
      await qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindoKey(null);
    }
  }

  async function embalarPedido(p: PedidoSepRow) {
    const key = `ped:${p.numero_ecommerce}`;
    if (embalandoKey || !p.numero_ecommerce) return;
    setEmbalandoKey(key);
    try {
      try {
        await callSeparacaoFn(
          `modulo=embalar-pedido&order_sn=${encodeURIComponent(p.numero_ecommerce)}&confirmar=1`,
        );
        toast.success(`Pedido ${p.numero_ecommerce} marcado como embalado`);
      } catch (e) {
        const err = e as Error & { status?: number };
        if ((err.status === 404 || err.status === 400) && p.tag_lote) {
          await callSeparacaoFn(
            `modulo=embalar-lote&tag=${encodeURIComponent(p.tag_lote)}&confirmar=1`,
          );
          toast.warning(
            `Módulo por-pedido indisponível — lote ${p.tag_lote} inteiro embalado`,
          );
        } else {
          throw e;
        }
      }
      await qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao marcar embalado", { description: (e as Error).message });
    } finally {
      setEmbalandoKey(null);
    }
  }

  const tagsPorGrupo = useMemo(() => {
    const m = new Map<string, TagLoteRow>();
    (lotesHoje ?? []).forEach((l) => m.set(l.grupo_origem, l));
    return m;
  }, [lotesHoje]);

  async function aplicarTag(grupo: string) {
    if (aplicando || bloqueados.has(grupo)) return;
    setAplicando(grupo);
    try {
      const data = await callSeparacaoFn<TagLoteResponse>(
        `modulo=tag-lote&grupo=${encodeURIComponent(grupo)}`,
      );
      toast.success(`TAG ${data.tag} aplicada em ${data.pedidos_tagueados} pedidos`, {
        description: `${data.proximo_passo}${data.aviso ? ` · ${data.aviso}` : ""}`,
        action: {
          label: "Copiar tag",
          onClick: () => void copyToClipboard(data.tag),
        },
        duration: 8000,
      });
      if (data.pedidos_pulados > 0 && data.aviso) {
        toast.warning(`${data.pedidos_pulados} pedidos pulados`, {
          description: data.aviso,
        });
      }
      await qc.invalidateQueries({ queryKey: ["separacao", "tags_lote", "hoje"] });
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        toast.warning("Todos os pedidos já receberam tag hoje", {
          description: err.message,
        });
      } else if (err.status === undefined) {
        // Falha de rede — a requisição pode ter chegado ao servidor mesmo assim.
        // Bloqueia novo clique automático pra evitar criar lote duplicado sobre pedidos já tagueados.
        setBloqueados((prev) => {
          const next = new Set(prev);
          next.add(grupo);
          return next;
        });
        toast.error("Falha de rede ao aplicar TAG", {
          description:
            "Verifique no painel de Lotes se a TAG foi criada antes de tentar de novo.",
          duration: 12000,
        });
        await qc.invalidateQueries({ queryKey: ["separacao", "tags_lote", "hoje"] });
      } else {
        toast.error("Erro ao aplicar TAG", { description: err.message });
      }
    } finally {
      setAplicando(null);
    }
  }

  function desbloquear(grupo: string) {
    setBloqueados((prev) => {
      const next = new Set(prev);
      next.delete(grupo);
      return next;
    });
  }



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

  function toggleEnvio(env: string) {
    const base = selectedEnvios ?? enviosDisponiveis;
    if (base.includes(env)) {
      setSelectedEnvios(base.filter((e) => e !== env));
    } else {
      setSelectedEnvios([...base, env]);
    }
  }

  const filteredRows = useMemo(() => {
    const q = buscaSku.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (r.tipo_envio && !enviosAtivosSet.has(r.tipo_envio)) return false;
      if (q) {
        const hit =
          (r.sku ?? "").toLowerCase().includes(q) ||
          (r.nome_produto ?? "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, enviosAtivosSet, buscaSku]);

  const unitarios = useMemo(
    () => filteredRows.filter((r) => (r.tipo_grupo ?? "unitario") === "unitario"),
    [filteredRows],
  );
  const multis = useMemo(
    () => filteredRows.filter((r) => r.tipo_grupo === "multi"),
    [filteredRows],
  );

  const grupos = useMemo(() => {
    const map = new Map<
      string,
      { tipo_envio: string; ordem: number; items: PriorizadaRow[] }
    >();
    for (const r of unitarios) {
      const key = r.tipo_envio ?? "—";
      const cur = map.get(key);
      if (cur) cur.items.push(r);
      else map.set(key, { tipo_envio: key, ordem: r.ordem_envio ?? 99, items: [r] });
    }
    return Array.from(map.values()).sort((a, b) => a.ordem - b.ordem);
  }, [unitarios]);

  const totais = useMemo(() => {
    return {
      tags: filteredRows.length,
      pedidos: filteredRows.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0),
      unidades: filteredRows.reduce((s, r) => s + Number(r.total_unidades ?? 0), 0),
    };
  }, [filteredRows]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-4 border-destructive text-destructive text-sm">
        Erro ao carregar fila priorizada: {(error as Error).message}
      </Card>
    );
  }

  if ((rows?.length ?? 0) === 0) {
    return (
      <Card className="p-12 text-center">
        <PackageCheck className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-muted-foreground">Fila vazia. Nada pra separar.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <SeparacaoTotaisCards />
      <LotesDoDia
        printerId={printerId}
        setPrinterId={setPrinterId}
        impressoras={impressoras}
        loadingImpressoras={loadingImpressoras}
        impressoraSelecionada={impressoraSelecionada}
      />


      {/* Resumo */}
      <Card className="p-4 space-y-3">
        <div className="text-sm">
          <span className="font-semibold">Total:</span>{" "}
          {formatNumber(totais.tags)} TAGs ·{" "}
          {formatNumber(totais.pedidos)} pedidos ·{" "}
          {formatNumber(totais.unidades)} unidades
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {grupos.map((g) => {
            const cfg = ENVIO_HEADER[g.tipo_envio];
            const pedidos = g.items.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0);
            return (
              <span
                key={g.tipo_envio}
                className="text-xs font-medium px-2.5 py-1 rounded-full"
                style={{
                  backgroundColor: cfg?.bg ?? "#E5E7EB",
                  color: cfg?.text ?? "#111827",
                }}
              >
                {g.tipo_envio}: {formatNumber(pedidos)}
              </span>
            );
          })}
          {multis.length > 0 && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300">
              MULTI: {formatNumber(multis.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0))}
            </span>
          )}
          {fullCount != null && fullCount > 0 && (
            <>
              <span className="text-muted-foreground text-xs mx-1">|</span>
              <span
                className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground border border-dashed"
                title="Full é separado pelo marketplace, não no galpão"
              >
                Full (não separado aqui): {formatNumber(fullCount)} pedidos
              </span>
            </>
          )}
        </div>
      </Card>

      {/* Filtros */}
      <Card className="p-3 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground mr-1">Envio:</span>
          <Button
            size="sm"
            variant={
              selectedEnvios === null ||
              selectedEnvios.length === enviosDisponiveis.length
                ? "default"
                : "outline"
            }
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
              >
                {isER && <Zap className="h-3 w-3 mr-1" />}
                {env}
              </Button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={buscaSku}
                onChange={(e) => setBuscaSku(e.target.value)}
                placeholder="Buscar por SKU ou nome…"
                className="pl-8 h-8 text-sm"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled
              title="em breve"
              className="opacity-60"
            >
              Peso
            </Button>
          </div>
        </div>
      </Card>

      {/* Blocos unitários por envio */}
      {grupos.map((g) => {
        const cfg = ENVIO_HEADER[g.tipo_envio];
        const bg = cfg?.bg ?? "#6B7280";
        const color = cfg?.text ?? "#FFFFFF";
        const label = cfg?.label ?? g.tipo_envio;
        const tags = g.items.length;
        const pedidos = g.items.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0);
        const unidades = g.items.reduce(
          (s, r) => s + Number(r.total_unidades ?? 0),
          0,
        );
        return (
          <div key={g.tipo_envio} className="space-y-2">
            <div
              className="rounded-md px-4 py-3 flex items-center justify-between gap-4"
              style={{ backgroundColor: bg, color }}
            >
              <div className="flex items-center gap-2 font-semibold text-sm md:text-base">
                {cfg?.icon && <Zap className="h-4 w-4" />}
                {label}
              </div>
              <div className="text-xs md:text-sm opacity-90">
                {formatNumber(tags)} TAGs · {formatNumber(pedidos)} pedidos ·{" "}
                {formatNumber(unidades)} unidades
              </div>
            </div>

            <div className="grid gap-2">
              {g.items.map((item) => {
                const isER = item.tipo_envio === "ER";
                const skuKey = `${item.sku}|${item.tipo_envio}`;
                const busyImprimir = imprimindoKey === `sku:${item.sku}:${item.tipo_envio}`;
                const busyEmbalar = embalandoKey === `sku:${item.sku}:${item.tipo_envio}`;
                const isExpanded = expandedSku.has(skuKey);
                return (
                  <div key={`${item.prioridade}-${item.sku}-${item.tipo_envio}-${item.qtd_unidades}`}>
                  <Card
                    className={cn(
                      "p-3 flex items-center gap-4",
                      isER && "border-destructive/40",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggleExpand(skuKey)}
                      className="p-1 rounded hover:bg-muted shrink-0"
                      title={isExpanded ? "Recolher" : "Ver pedidos"}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                    <div className="text-2xl md:text-3xl font-bold text-muted-foreground w-14 text-center tabular-nums shrink-0">
                      #{item.prioridade}
                    </div>
                    <ProdutoFoto src={item.foto_capa} alt={item.sku ?? "produto"} />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm md:text-base font-semibold">
                        {item.tag_sugerida ?? "—"}
                      </div>
                      <div
                        className="text-sm text-muted-foreground truncate"
                        title={item.nome_produto ?? ""}
                      >
                        {item.nome_produto ?? "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div
                        className={cn(
                          "px-4 py-2 rounded-lg font-bold text-lg md:text-xl tabular-nums",
                          isER
                            ? "bg-destructive text-destructive-foreground"
                            : "bg-primary text-primary-foreground",
                        )}
                      >
                        {formatNumber(item.qtd_pedidos ?? 0)} pedidos
                      </div>
                      <div className="text-right text-xs text-muted-foreground w-20">
                        <div className="font-semibold text-sm text-foreground tabular-nums">
                          {formatNumber(Number(item.total_unidades ?? 0))}
                        </div>
                        unidades
                      </div>
                      {(() => {
                        const grupo = item.tag_sugerida ?? "";
                        const loteAplicado = grupo ? tagsPorGrupo.get(grupo) : undefined;
                        if (loteAplicado) {
                          return (
                            <button
                              type="button"
                              onClick={() => void copyToClipboard(loteAplicado.tag)}
                              className={cn(
                                "inline-flex items-center gap-1 font-mono font-semibold text-sm px-3 py-2 rounded-md w-28 justify-center",
                                loteAplicado.status === "embalada"
                                  ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                                  : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
                              )}
                              title="Copiar tag"
                            >
                              <TagIcon className="h-3 w-3" />
                              {loteAplicado.tag}
                            </button>
                          );
                        }
                        return (
                          <div className="flex flex-col items-end gap-1">
                            <Button
                              size="sm"
                              variant={bloqueados.has(grupo) ? "secondary" : "outline"}
                              disabled={!grupo || aplicando === grupo || bloqueados.has(grupo)}
                              onClick={() => void aplicarTag(grupo)}
                              className="w-28"
                            >
                              {aplicando === grupo ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <>
                                  <TagIcon className="h-3 w-3 mr-1" />
                                  Aplicar TAG
                                </>
                              )}
                            </Button>
                            {bloqueados.has(grupo) && (
                              <div className="text-[10px] text-amber-700 dark:text-amber-400 max-w-[220px] text-right leading-tight">
                                Verifique no painel de Lotes se a TAG foi criada antes de tentar de novo.
                                <button
                                  type="button"
                                  onClick={() => desbloquear(grupo)}
                                  className="ml-1 underline"
                                >
                                  Reabilitar
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <div className="flex flex-col gap-1">
                        <Button
                          size="sm"
                          variant="default"
                          disabled={busyImprimir || imprimindoKey !== null}
                          onClick={() => void imprimirPorSku(item)}
                          className="w-36"
                          title="Imprime todas as etiquetas Shopee deste SKU"
                        >
                          {busyImprimir ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Printer className="h-3 w-3 mr-1" />
                              Imprimir etiqueta
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyEmbalar || embalandoKey !== null}
                          onClick={() => void embalarPorSku(item)}
                          className="w-36"
                        >
                          {busyEmbalar ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <>
                              <Package className="h-3 w-3 mr-1" />
                              Marcar embalado
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  </Card>
                  {isExpanded && (
                    <PedidosDoSku
                      sku={item.sku}
                      tipoEnvio={item.tipo_envio}
                      imprimindoKey={imprimindoKey}
                      embalandoKey={embalandoKey}
                      onImprimir={imprimirPedido}
                      onEmbalar={embalarPedido}
                    />
                  )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Bloco Multi-SKU */}
      {multis.length > 0 && (
        <div className="space-y-2">
          <div className="rounded-md px-4 py-3 flex items-center justify-between gap-4 bg-purple-600 text-white">
            <div className="flex items-center gap-2 font-semibold text-sm md:text-base">
              <BoxesIcon className="h-4 w-4" />
              📦 MÚLTIPLOS SKUs
            </div>
            <div className="text-xs md:text-sm opacity-90">
              {formatNumber(multis.length)} combinações ·{" "}
              {formatNumber(multis.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0))} pedidos
            </div>
          </div>
          <div className="grid gap-2">
            {multis.map((item) => (
              <Card
                key={`multi-${item.prioridade}-${item.sku}-${item.tipo_envio}`}
                className="p-3 flex items-center gap-4 border-purple-300/60 dark:border-purple-900/60"
              >
                <div className="text-2xl md:text-3xl font-bold text-muted-foreground w-14 text-center tabular-nums shrink-0">
                  #{item.prioridade}
                </div>
                <div className="w-20 h-20 rounded-md bg-purple-50 dark:bg-purple-950/30 flex flex-col items-center justify-center text-purple-700 dark:text-purple-300 shrink-0 border border-purple-200 dark:border-purple-900">
                  <BoxesIcon className="h-6 w-6" />
                  <span className="text-[9px] mt-0.5">combo</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm md:text-base font-semibold break-words">
                    {item.nome_produto ?? item.sku ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-medium"
                      style={{
                        backgroundColor:
                          ENVIO_HEADER[item.tipo_envio ?? ""]?.bg ?? "#6B7280",
                        color:
                          ENVIO_HEADER[item.tipo_envio ?? ""]?.text ?? "#FFFFFF",
                      }}
                    >
                      {item.tipo_envio ?? "—"}
                    </span>
                    <span className="font-mono">{item.sku ?? ""}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="px-4 py-2 rounded-lg font-bold text-lg md:text-xl tabular-nums bg-purple-600 text-white">
                    {formatNumber(item.qtd_pedidos ?? 0)} pedidos
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

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
    try {
      await qc.invalidateQueries({ queryKey: ["separacao"] });
      await refetch();
      toast.success("Fila atualizada");
    } catch (e) {
      toast.error("Erro ao atualizar fila", {
        description: (e as Error).message,
      });
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
        <Button onClick={atualizarFila} disabled={isFetching} variant="outline">
          <RefreshCw className={cn("h-4 w-4 mr-2", isFetching && "animate-spin")} />
          Atualizar fila
        </Button>
      </div>

      <Tabs defaultValue="priorizada" className="space-y-4">
        <TabsList>
          <TabsTrigger value="priorizada">Fila Priorizada</TabsTrigger>
          <TabsTrigger value="detalhado">Detalhado</TabsTrigger>
        </TabsList>

        <TabsContent value="priorizada" className="space-y-4 mt-2">
          <FilaPriorizada />
        </TabsContent>

        <TabsContent value="detalhado" className="space-y-6 mt-2">
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
