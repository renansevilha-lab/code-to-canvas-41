import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { usePerfil } from "@/hooks/usePerfil";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";
import { rotuloCanal } from "@/lib/canais";

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
  // marcada pela edge fn quando é a do config_impressora (default do sistema)
  configurada?: boolean;
}

const STORAGE_PRINTER = "separacao.printerId";

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
      // Somente ZD220 (etiqueta Shopee ZPL). O filtro é pelo NOME — a API não
      // devolve `descricao` (filtrar por ela deixava a lista sempre vazia).
      return (data.impressoras ?? []).filter((p) =>
        (p.nome ?? "").toLowerCase().includes("zd220"),
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
  ja_impressos_pulados?: number;
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
 * Identidade de uma LINHA da fila. A linha é sku · envio · QUANTIDADE por
 * pedido (é o tag_sugerida das views, e é por ele que o tag-lote do servidor
 * seleciona). Agrupar só por sku|tipo_envio MISTURA linhas com quantidades
 * diferentes — bug real: pedido de 1un tratado dentro do grupo de 2un
 * (drill-down, selo de tag, imprimir e embalar da linha errados).
 */
function linhaKeyDe(r: {
  tag_sugerida?: string | null;
  sku?: string | null;
  sku_unico?: string | null;
  tipo_envio?: string | null;
}): string {
  return (
    r.tag_sugerida ??
    `${r.sku ?? r.sku_unico ?? ""}|${r.tipo_envio ?? ""}`
  );
}

/**
 * Lê tag_lote de todos os pedidos atualmente na fila de separação
 * (view_separacao_pedidos) e agrupa por linha (tag_sugerida).
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
        .select("sku_unico, tipo_envio, tag_lote, tag_sugerida")
        .limit(20000);
      if (error) throw error;
      const map = new Map<string, TagsPorLinha>();
      const buckets = new Map<string, { tags: Set<string>; sem: number; com: number }>();
      for (const p of (data ?? []) as { sku_unico: string | null; tipo_envio: string | null; tag_lote: string | null; tag_sugerida: string | null }[]) {
        const key = linhaKeyDe(p);
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

/**
 * Prazo de despacho (ship_by_date) por LINHA da fila (tag_sugerida). Guarda o
 * prazo MAIS PRÓXIMO (mínimo) do grupo — é o que decide a urgência da linha e
 * alimenta o filtro "prazo máximo de despacho".
 */
function usePrazosPorLinha() {
  return useQuery({
    queryKey: ["separacao", "prazos_por_linha"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_pedidos")
        .select("sku_unico, tipo_envio, tag_sugerida, ship_by_date")
        .limit(20000);
      if (error) throw error;
      const map = new Map<string, string>();
      for (const p of (data ?? []) as {
        sku_unico: string | null;
        tipo_envio: string | null;
        tag_sugerida: string | null;
        ship_by_date: string | null;
      }[]) {
        if (!p.ship_by_date) continue;
        const key = linhaKeyDe(p);
        const cur = map.get(key);
        if (!cur || p.ship_by_date < cur) map.set(key, p.ship_by_date);
      }
      return map;
    },
    refetchInterval: 60_000,
  });
}

// ============ Estado da impressão (impressao_etiquetas) ============

export type EstadoImpressao = "done" | "forcado" | "sent" | "error" | "ausente";

function rankEstado(e: EstadoImpressao): number {
  return e === "done" ? 4 : e === "forcado" ? 3 : e === "sent" ? 2 : e === "error" ? 1 : 0;
}

export interface AggImpressao {
  done: number;
  forcado: number;
  sent: number;
  error: number;
  ausente: number;
  total: number;
  seps: number[];
}

/**
 * Une view_separacao_pedidos + impressao_etiquetas para dizer, por SKU/tipo_envio
 * (linha da fila) e por separacao_id, em que estado está a impressão.
 * Polling curto (5s) enquanto houver 'sent' — o backend confirma em poucos segundos.
 */
function useImpressaoEstados() {
  return useQuery({
    queryKey: ["separacao", "impressao_estados"],
    queryFn: async () => {
      const { data: peds, error: e1 } = await supabaseExternal
        .from("view_separacao_pedidos")
        .select("separacao_id, sku_unico, tipo_envio, tag_sugerida")
        .limit(20000);
      if (e1) throw e1;
      const sepList = (peds ?? []) as {
        separacao_id: number | null;
        sku_unico: string | null;
        tipo_envio: string | null;
        tag_sugerida: string | null;
      }[];
      const sepIds = sepList.map((p) => p.separacao_id).filter((n): n is number => n != null);

      const porSep = new Map<number, EstadoImpressao>();
      // pega em chunks pra evitar URL gigante
      const chunk = 500;
      for (let i = 0; i < sepIds.length; i += chunk) {
        const slice = sepIds.slice(i, i + chunk);
        const { data: imps, error: e2 } = await supabaseExternal
          .from("impressao_etiquetas")
          .select("separacao_id, estado")
          .in("separacao_id", slice);
        if (e2) throw e2;
        for (const r of (imps ?? []) as { separacao_id: number; estado: string }[]) {
          const est = (r.estado as EstadoImpressao) ?? "ausente";
          const cur = porSep.get(r.separacao_id) ?? "ausente";
          if (rankEstado(est) > rankEstado(cur)) porSep.set(r.separacao_id, est);
        }
      }

      const porLinha = new Map<string, AggImpressao>();
      for (const p of sepList) {
        const key = linhaKeyDe(p);
        const agg =
          porLinha.get(key) ??
          ({ done: 0, forcado: 0, sent: 0, error: 0, ausente: 0, total: 0, seps: [] } as AggImpressao);
        agg.total++;
        if (p.separacao_id != null) agg.seps.push(p.separacao_id);
        const est: EstadoImpressao =
          p.separacao_id != null ? (porSep.get(p.separacao_id) ?? "ausente") : "ausente";
        agg[est]++;
        porLinha.set(key, agg);
      }

      const hasSent = [...porSep.values()].some((e) => e === "sent");
      return { porSep, porLinha, hasSent };
    },
    refetchInterval: (q) => {
      const d = q.state.data as { hasSent?: boolean } | undefined;
      return d?.hasSent ? 5_000 : 30_000;
    },
  });
}

/**
 * Deriva o estado do botão "Embalar" para uma linha de SKU.
 * - liberado: todos done/forcado
 * - aguardando: nenhum liberado ainda mas há 'sent'
 * - parcial: há liberados E bloqueados/aguardando
 * - bloqueado: nenhum liberado, sem sent (só error/ausente)
 */
export type EstadoBotao = "liberado" | "aguardando" | "parcial" | "bloqueado" | "vazio";
function estadoBotaoLinha(a: AggImpressao | undefined): EstadoBotao {
  if (!a || a.total === 0) return "vazio";
  const liberados = a.done + a.forcado;
  if (liberados === a.total) return "liberado";
  if (liberados > 0) return "parcial";
  if (a.sent > 0) return "aguardando";
  return "bloqueado";
}

// ============ Dialog: Forçar embalar ============

interface ForcarDialogProps {
  open: boolean;
  titulo: string;
  descricao: React.ReactNode;
  onCancel: () => void;
  onConfirm: (nome: string, motivo: string) => void;
  loading?: boolean;
}
function ForcarEmbalarDialog({
  open,
  titulo,
  descricao,
  onCancel,
  onConfirm,
  loading,
}: ForcarDialogProps) {
  const [nome, setNome] = useState("");
  const [motivo, setMotivo] = useState("");
  const [confirmado, setConfirmado] = useState(false);
  const podeConfirmar = nome.trim().length >= 2 && confirmado;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onCancel();
          setNome("");
          setMotivo("");
          setConfirmado(false);
        }
      }}
    >
      <AlertDialogContent className="border-destructive">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> {titulo}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm">
              <div>{descricao}</div>
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                Esta ação pula a trava de segurança "só embala quem imprimiu".
                Use só quando a etiqueta física já saiu mas o sistema não confirmou.
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Quem está forçando *</label>
                <Input
                  autoFocus
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="Seu nome"
                  className="h-8"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium">Motivo (opcional)</label>
                <Input
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ex.: impressora imprimiu mas não confirmou"
                  className="h-8"
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={confirmado}
                  onChange={(e) => setConfirmado(e.target.checked)}
                />
                Confirmo que a etiqueta física já saiu e quero forçar o embalado.
              </label>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            disabled={!podeConfirmar || loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              onConfirm(nome.trim(), motivo.trim());
            }}
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Forçar embalar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
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

interface SyncTinyResponse {
  total_na_fila?: number;
  revertidas_para_fila?: number;
  novos_detalhados?: number;
  pendentes_detalhe?: number;
}

function AtualizarDoTinyButton() {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const handleSyncTiny = async () => {
    setSyncing(true);
    try {
      const resp = await fetch(
        `${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=sync&max=150`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
        },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as SyncTinyResponse;
      const total = json.total_na_fila ?? 0;
      const rev = json.revertidas_para_fila ?? 0;
      const novos = json.novos_detalhados ?? 0;
      const pend = json.pendentes_detalhe ?? 0;
      toast.success(
        `Fila atualizada: ${formatNumber(total)} na fila, ${formatNumber(rev)} voltaram, ${formatNumber(novos)} novos`,
        pend > 0
          ? { description: `Ainda faltam ${formatNumber(pend)} — clique em Atualizar novamente.` }
          : undefined,
      );
      await queryClient.invalidateQueries({ queryKey: ["separacao"] });
    } catch {
      toast.error("Não foi possível sincronizar agora");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleSyncTiny}
      disabled={syncing}
      className="gap-2"
    >
      {syncing ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Sincronizando com o Tiny...
        </>
      ) : (
        <>
          <RefreshCw className="h-3.5 w-3.5" />
          Atualizar do Tiny
        </>
      )}
    </Button>
  );
}

// Força o processo do cron (aplica a TAG + APROVA no Tiny os pedidos Shopee em
// aberto) sob demanda, sem esperar os 5 min. Depois puxa a separação recém-criada
// pra fila do app (aprovar gera a separação no Tiny).
function ProcessarAbertosButton() {
  const queryClient = useQueryClient();
  const [rodando, setRodando] = useState(false);

  const handle = async () => {
    setRodando(true);
    try {
      const resp = await fetch(
        `${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=processar-abertos&canal=shopee`,
        { method: "POST", headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
      );
      const d = (await resp.json().catch(() => ({}))) as { tags_aplicadas?: number; aprovados?: number; erro?: string; erros?: string[] };
      if (!resp.ok || d.erro) throw new Error(d.erro ?? `HTTP ${resp.status}`);
      const aprov = d.aprovados ?? 0;
      const tags = d.tags_aplicadas ?? 0;
      if (aprov === 0 && tags === 0) {
        toast.info("Nenhum pedido em aberto para processar agora");
      } else {
        toast.success(
          `${formatNumber(aprov)} pedido(s) aprovado(s) · ${formatNumber(tags)} tag(s)`,
          d.erros?.length ? { description: `${d.erros.length} com erro (ver logs)` } : undefined,
        );
        // aprovar gera a separação no Tiny -> puxa pra fila do app
        await fetch(`${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=sync&max=150`,
          { method: "POST", headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } });
      }
      await queryClient.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Falha ao processar abertos", { description: (e as Error).message });
    } finally {
      setRodando(false);
    }
  };

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handle}
      disabled={rodando}
      className="gap-2"
      title="Aplica a tag e aprova no Tiny os pedidos Shopee em aberto AGORA, sem esperar o cron (5 min)."
    >
      {rodando ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Processando abertos...
        </>
      ) : (
        <>
          <Zap className="h-3.5 w-3.5" />
          Processar abertos
        </>
      )}
    </Button>
  );
}

function SeparacaoTotaisCards() {
  const { data, isLoading, error } = useSeparacaoTotais();


  const cards = [
    {
      key: "aguardando",
      label: "Aguardando separação",
      value: data?.aguardando_separacao ?? 0,
      icon: Hourglass,
      bg: "bg-primary/[0.06] dark:bg-primary/10",
      text: "text-primary",
      border: "border-primary/20",
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-[14px]">
        {cards.map((c) => (
          <Card
            key={c.key}
            className={cn("p-4 border", c.bg, c.border)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn("text-[12px] font-semibold truncate", c.text)}>
                  {c.label}
                </p>
                {isLoading ? (
                  <Skeleton className="h-9 w-16 mt-1.5" />
                ) : (
                  <p className={cn("text-[34px] font-semibold tracking-[-0.035em] tabular-nums leading-none mt-1.5", c.text)}>
                    {formatNumber(c.value)}
                  </p>
                )}
              </div>
              <c.icon className={cn("h-5 w-5 shrink-0", c.text)} />
            </div>
          </Card>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Atualizado há {tempoRelativo(data?.atualizado_em ?? null)}
        </p>
        <AtualizarDoTinyButton />
      </div>
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

// Cor por quantidade de unidades por pedido (1un/2un/3un…) — ajuda a bancada a
// não confundir a quantidade na hora de embalar/imprimir. Escala fixa por nº.
function corUnidades(n: number): string {
  switch (n) {
    case 1: return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";
    case 2: return "bg-blue-500 text-white";
    case 3: return "bg-amber-500 text-white";
    case 4: return "bg-fuchsia-600 text-white";
    case 5: return "bg-emerald-600 text-white";
    default: return "bg-red-600 text-white";
  }
}
function UnBadge({ n, className }: { n: number; className?: string }) {
  const q = Number(n) || 1;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 font-mono font-bold tabular-nums leading-none",
        corUnidades(q),
        className,
      )}
      title={`${q} unidade${q === 1 ? "" : "s"} por pedido`}
    >
      {q}un
    </span>
  );
}

// ============ Prazo de despacho (ship_by_date) ============
// Diferença em DIAS (por data em São Paulo) entre o prazo de despacho e hoje.
// O ship_by_date é o fim do dia-limite (23:59 SP), então comparamos por DIA.
function diasAtePrazo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const diaSP = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // yyyy-mm-dd
  const hoje = diaSP(new Date());
  const prazo = diaSP(new Date(iso));
  return Math.round(
    (new Date(prazo + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) / 86400000,
  );
}

type PrazoNivel = "vencido" | "hoje" | "amanha" | "proximo" | "ok";
function nivelPrazo(dias: number | null): PrazoNivel | null {
  if (dias === null) return null;
  if (dias < 0) return "vencido";
  if (dias === 0) return "hoje";
  if (dias === 1) return "amanha";
  if (dias <= 3) return "proximo";
  return "ok";
}

const PRAZO_ESTILO: Record<PrazoNivel, string> = {
  vencido: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800",
  hoje: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800",
  amanha: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
  proximo: "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-300 dark:border-yellow-900",
  ok: "bg-muted text-muted-foreground border-transparent",
};

function fmtPrazoData(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
  });
}

// Selo do prazo de despacho, com cor de urgência.
function PrazoBadge({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const dias = diasAtePrazo(iso);
  const nivel = nivelPrazo(dias);
  if (!iso || nivel === null) {
    return <span className={cn("text-[10px] text-muted-foreground", className)}>—</span>;
  }
  const rotulo =
    nivel === "vencido" ? `Vencido · ${fmtPrazoData(iso)}`
    : nivel === "hoje" ? `Hoje · ${fmtPrazoData(iso)}`
    : nivel === "amanha" ? `Amanhã · ${fmtPrazoData(iso)}`
    : fmtPrazoData(iso);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums whitespace-nowrap",
        PRAZO_ESTILO[nivel],
        className,
      )}
      title={`Prazo de despacho: ${new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`}
    >
      {(nivel === "vencido" || nivel === "hoje") && <AlertTriangle className="h-2.5 w-2.5" />}
      {rotulo}
    </span>
  );
}

// Chip de envio: filtro + contagem. Ativo assume a cor da transportadora.
function ChipEnvio({
  label,
  count,
  color,
  textColor,
  active,
  isER,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  textColor?: string;
  active: boolean;
  isER?: boolean;
  onClick: () => void;
}) {
  const bg = color ?? "#0E1114";
  const fg = textColor ?? "#FFFFFF";
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-[9px] border pl-3.5 pr-2 py-[7px] text-[12.5px] font-semibold transition-[filter]",
        active ? "border-transparent hover:brightness-[.97]" : "bg-card text-secondary-foreground border-border hover:border-[#C9CFD8]",
      )}
      style={active ? { background: bg, color: fg } : undefined}
    >
      {isER && <Zap className="h-3 w-3" />}
      <span>{label}</span>
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold font-mono tabular-nums",
          !active && "bg-muted text-muted-foreground",
        )}
        style={active ? { background: "rgba(255,255,255,.22)" } : undefined}
      >
        {formatNumber(count)}
      </span>
    </button>
  );
}

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
  separacao_id: number | null;
  tag_lote: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  tipo_envio: string | null;
  sku_unico: string | null;
  venda_numero: string | null;
  ship_by_date?: string | null;
  days_to_ship?: number | null;
  embalado_em?: string | null;
  impresso_em?: string | null;
}

/** Qual LOJA Shopee — só faz sentido quando marcaToCanal() === "shopee". */
function marcaToLoja(m: string | null): "ottz" | "svl" | "tiktok" | null {
  if (!m) return null;
  const s = m.toLowerCase();
  // TikTok PRIMEIRO: o canal se chama "TikTok Shop l Bumi Pet" e casaria o
  // "bumi" da SVL logo abaixo, mandando pedido TikTok para a etiqueta Shopee.
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("ottz")) return "ottz";
  // "Bumi Pet [Shopee]" = a SVL renomeada no Tiny (mesmo shop 759046323).
  // Sem esta grafia o botão de imprimir morria com "TikTok não usa etiqueta"
  // e o fluxo por SKU pulava os lotes da SVL em silêncio.
  if (s.includes("svl") || s.includes("sevilla") || s.includes("bumi")) return "svl";
  return null;
}

/**
 * Qual MARKETPLACE — decide a rota de impressão (Shopee = ZPL pelo
 * shopee-sync-ads; ML = PDF pelo ml-etiqueta). Antes disso "Mercado Livre
 * (Ottz Pet)" casava o "ottz" do marcaToLoja e ia parar na rota da Shopee.
 */
/**
 * A etiqueta do ML sai pelo token da conta OTTZ. Os pedidos "[SVLL] Mercado
 * Livre" sao da segunda conta, que NAO esta integrada — a API do ML responde
 * 403 e nao ha o que fazer pelo app (tem que imprimir pelo painel do ML).
 * Saber disso aqui evita o operador clicar e tomar erro na bancada.
 */
function mlContaIntegrada(m: string | null): boolean {
  const s = (m ?? "").toLowerCase();
  return !(s.includes("svl") || s.includes("sevilla") || s.includes("bumi"));
}

function marcaToCanal(m: string | null): "shopee" | "mercadolivre" | "tiktok" | "outro" {
  if (!m) return "outro";
  const s = m.toLowerCase();
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("mercado livre") || s.includes("mercadolivre") || s.includes("meli")) {
    return "mercadolivre";
  }
  if (s.includes("shopee")) return "shopee";
  return "outro";
}

async function imprimirLoteApi(
  loja: "ottz" | "svl",
  tag: string,
  printerId: number,
  printerNome?: string,
): Promise<{ enviadas: number; jaPulados: number }> {
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
    return { enviadas: 0, jaPulados: 0 };
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
  return { enviadas: data.etiquetas_enviadas ?? 0, jaPulados: data.ja_impressos_pulados ?? 0 };
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

/**
 * Etiqueta do Mercado Livre. Rota separada da Shopee de propósito: o ML entrega
 * PDF (o PrintNode imprime nativamente) e a Shopee entrega ZPL. Não há lote —
 * o ML dá uma etiqueta por envio, então aqui é sempre um pedido por vez.
 * O envio só tem etiqueta quando o ML libera (`ready_to_ship`); antes disso a
 * função devolve 409 com o substatus, que mostramos como aviso e não como erro.
 */
async function imprimirPedidoMlApi(
  orderId: string,
  printerId: number,
  printerNome?: string,
) {
  const url =
    `${EXTERNAL_URL}/functions/v1/ml-etiqueta` +
    `?modulo=imprimir&order_id=${encodeURIComponent(orderId)}&printer_id=${printerId}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const data = (await resp.json().catch(() => ({}))) as {
    erro?: string; enviado?: boolean; status?: string; substatus?: string; dica?: string;
  };
  if (resp.status === 409) {
    toast.warning(`ML ${orderId}: envio ainda não liberado`, {
      description: data.dica ?? `status ${data.status ?? "?"}`,
      duration: 10000,
    });
    return;
  }
  if (!resp.ok || data.erro) {
    toast.error(`Falha ao imprimir ML ${orderId}`, {
      description: data.erro ?? `HTTP ${resp.status}`,
    });
    return;
  }
  toast.success(`Etiqueta ML ${orderId} enviada`, { description: printerNome ?? "" });
}

// ============ Pedidos individuais expandidos (por SKU) ============

interface PedidosDoSkuProps {
  sku: string | null;
  tipoEnvio: string | null;
  tagSugerida: string | null;
  imprimindoKey: string | null;
  embalandoKey: string | null;
  onImprimir: (p: PedidoSepRow) => void;
  onEmbalar: (p: PedidoSepRow, forcado?: { nome: string; motivo: string }) => void;
  estadosPorSep?: Map<number, EstadoImpressao>;
}

function PedidosDoSku({
  sku,
  tipoEnvio,
  tagSugerida,
  imprimindoKey,
  embalandoKey,
  onImprimir,
  onEmbalar,
  estadosPorSep,
}: PedidosDoSkuProps) {
  const [forcar, setForcar] = useState<PedidoSepRow | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["separacao", "view_separacao_pedidos", sku, tipoEnvio, tagSugerida],
    enabled: !!sku,
    queryFn: async () => {
      let q = supabaseExternal.from("view_separacao_pedidos").select("*");
      // a linha é sku·envio·qtd (tag_sugerida). Filtrar só por sku+envio
      // mistura pedidos de quantidades diferentes no drill-down (pedido de
      // 1un aparecendo dentro do grupo de 2un).
      if (tagSugerida) {
        q = q.eq("tag_sugerida", tagSugerida);
      } else {
        if (sku) q = q.eq("sku_unico", sku);
        if (tipoEnvio) q = q.eq("tipo_envio", tipoEnvio);
      }
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
            <th className="text-left py-1 pr-2 font-medium">Prazo despacho</th>
            <th className="text-left py-1 pr-2 font-medium">Lote</th>
            <th className="text-left py-1 pr-2 font-medium">Impressão</th>
            <th className="text-right py-1 font-medium">Ação</th>
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p, i) => {
            const loja = marcaToLoja(p.marca_canal);
            const canal = marcaToCanal(p.marca_canal);
            const isTiktok = canal === "tiktok";
            // Canal que o app não sabe etiquetar (Temu, etc.) — botão desligado
            // em vez de deixar clicar e falhar na cara do operador.
            const mlNaoIntegrado = canal === "mercadolivre" && !mlContaIntegrada(p.marca_canal);
            const semEtiqueta = canal === "tiktok" || canal === "outro" || mlNaoIntegrado ||
              (canal === "shopee" && (loja === null || loja === "tiktok"));
            const key = `ped:${p.numero_ecommerce}`;
            const busyImp = imprimindoKey === key;
            const busyEmb = embalandoKey === key;
            const estado: EstadoImpressao =
              p.separacao_id != null
                ? (estadosPorSep?.get(p.separacao_id) ?? "ausente")
                : "ausente";
            const liberado = estado === "done" || estado === "forcado";
            const aguardando = estado === "sent";
            const bloqueado = estado === "error" || estado === "ausente";
            return (
              <tr key={`${p.numero_ecommerce}-${i}`} className="border-b last:border-0">
                <td className="py-1 pr-2 font-mono">{p.numero_ecommerce ?? "—"}</td>
                <td className="py-1 pr-2">
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded",
                      isTiktok
                        ? "bg-black text-white"
                        : canal === "mercadolivre"
                          ? "bg-yellow-100 text-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-300"
                          : loja === "svl"
                            ? "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                            : "bg-orange-100 text-orange-800 dark:bg-orange-950/40 dark:text-orange-300",
                    )}
                  >
                    {rotuloCanal(p.marca_canal)}
                  </span>
                </td>
                <td className="py-1 pr-2">
                  <PrazoBadge iso={p.ship_by_date} />
                </td>
                <td className="py-1 pr-2 font-mono">{p.tag_lote ?? "—"}</td>
                <td className="py-1 pr-2">
                  {estado === "done" && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300">
                      <Check className="h-2.5 w-2.5" /> impresso
                    </span>
                  )}
                  {estado === "forcado" && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300">
                      <Check className="h-2.5 w-2.5" /> forçado
                    </span>
                  )}
                  {estado === "sent" && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      <Hourglass className="h-2.5 w-2.5" /> aguardando
                    </span>
                  )}
                  {estado === "error" && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300">
                      <AlertTriangle className="h-2.5 w-2.5" /> erro
                    </span>
                  )}
                  {estado === "ausente" && (
                    <span className="text-[10px] text-muted-foreground">sem impressão</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  <div className="inline-flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={semEtiqueta || busyImp || imprimindoKey !== null}
                      onClick={() => onImprimir(p)}
                      title={
                        isTiktok
                          ? "TikTok não usa etiqueta do app"
                          : mlNaoIntegrado
                            ? "Conta SVL do Mercado Livre não integrada — imprima pelo painel do ML"
                            : semEtiqueta
                            ? `Sem etiqueta pelo app: ${rotuloCanal(p.marca_canal)}`
                            : canal === "mercadolivre"
                              ? "Imprimir etiqueta ML (PDF)"
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
                      variant={liberado ? "default" : "ghost"}
                      className={cn(
                        "h-7 px-2",
                        aguardando && "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
                        bloqueado && "opacity-50",
                      )}
                      disabled={busyEmb || embalandoKey !== null || !liberado}
                      onClick={() => onEmbalar(p)}
                      title={
                        liberado
                          ? "Marcar embalado"
                          : aguardando
                            ? "Aguardando confirmação de impressão"
                            : "Bloqueado — imprima antes ou force embalado"
                      }
                    >
                      {busyEmb ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Package className="h-3 w-3" />
                      )}
                    </Button>
                    {bloqueado && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        disabled={busyEmb || embalandoKey !== null}
                        onClick={() => setForcar(p)}
                        title="Forçar embalado (pula trava)"
                      >
                        <AlertTriangle className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ForcarEmbalarDialog
        open={forcar !== null}
        titulo={`Forçar embalado do pedido ${forcar?.numero_ecommerce ?? ""}`}
        descricao={
          <p>
            A impressão deste pedido não foi confirmada
            {forcar?.tag_lote ? (
              <> (lote <span className="font-mono">{forcar.tag_lote}</span>)</>
            ) : null}
            . Ao confirmar, ele será marcado como embalado no Tiny mesmo sem
            confirmação de etiqueta.
          </p>
        }
        loading={embalandoKey === `ped:${forcar?.numero_ecommerce}`}
        onCancel={() => setForcar(null)}
        onConfirm={(nome, motivo) => {
          if (forcar) onEmbalar(forcar, { nome, motivo });
          setForcar(null);
        }}
      />
    </div>
  );
}

// ============ Etiqueta identificadora do lote (ZPL) ============

const STORAGE_IDENT = "separacao.identificadorLote";

// Dedup da etiqueta identificadora. Os dois fluxos AUTOMÁTICOS (painel "Lotes do
// dia" ao fim do imprimirLote, e a fila por SKU) podem disparar o mesmo lote em
// sequência — saíam 2 identificadoras iguais. Guarda o último envio por tag; no
// modo auto, pula se saiu nos últimos 60s. Botão manual (sem auto) nunca bloqueia.
const IDENT_JANELA_MS = 60000;
const identImpressoEm = new Map<string, number>();

// Sanitiza texto pra ZPL: tira os caracteres de controle (^ ~) e troca o "·"
// (que a fonte da Zebra não tem) por "-". ^CI28 cuida dos acentos.
function zplSan(s: string): string {
  return (s || "").replace(/[\^~]/g, " ").replace(/·/g, "-").replace(/\s+/g, " ").trim();
}

// Gera 1 etiqueta ZPL (bobina 10x15, 203dpi / 812x1218 dots) com:
// LOTE (grande) + código de barras Code128 do tag + tag SKU/qtd + nome do
// produto + nº de pedidos + nº de produtos + método de envio. Calibrar layout
// na ZD220 física (tamanho/fonte/acentos) — este é o primeiro corte.
function gerarZplIdentificador(o: {
  tag: string;
  grupo: string;
  produtoNome: string;
  pedidos: number;
  produtos: number | null;
  envio: string;
}): string {
  const tag = zplSan(o.tag);
  const grupo = zplSan(o.grupo);
  const nome = zplSan(o.produtoNome).slice(0, 90);
  const envio = zplSan(o.envio || "-");
  const prod = o.produtos == null ? "-" : String(o.produtos);
  return [
    "^XA",
    "^CI28",
    "^PW812",
    "^LL1218",
    "^LH0,0",
    "^FO0,50^A0N,44,44^FB812,1,0,C,0^FDLOTE^FS",
    `^FO0,100^A0N,150,150^FB812,1,0,C,0^FD${tag}^FS`,
    `^FO156,270^BY4,2,120^BCN,120,N,N,N^FD${tag}^FS`,
    `^FO0,400^A0N,34,34^FB812,1,0,C,0^FD${tag}^FS`,
    "^FO40,470^GB732,74,3^FS",
    `^FO40,488^A0N,50,50^FB732,1,0,C,0^FD${grupo}^FS`,
    `^FO40,575^A0N,40,40^FB732,3,6,L,0^FD${nome}^FS`,
    "^FO40,740^GB350,140,3^FS",
    "^FO40,752^A0N,30,30^FB350,1,0,C,0^FDPEDIDOS^FS",
    `^FO40,790^A0N,80,80^FB350,1,0,C,0^FD${o.pedidos}^FS`,
    "^FO422,740^GB350,140,3^FS",
    "^FO422,752^A0N,30,30^FB350,1,0,C,0^FDPRODUTOS^FS",
    `^FO422,790^A0N,80,80^FB350,1,0,C,0^FD${prod}^FS`,
    "^FO40,910^GB732,90,90^FS",
    `^FO40,930^A0N,50,50^FB732,1,0,C,0^FR^FDENVIO: ${envio}^FS`,
    "^XZ",
  ].join("");
}

// Imprime a etiqueta identificadora de UM lote (ZPL cru via fulfillment-inbound
// -> PrintNode). Reutilizada pelos dois fluxos de impressão: por lote ("Lotes do
// dia") e por SKU (fila priorizada). No modo automático pula lote de 1 pedido.
async function imprimirIdentificadorApi(
  lote: TagLoteRow,
  printerId: number,
  opts?: { auto?: boolean },
): Promise<void> {
  // Conta SEMPRE pela TAG do sistema (lote.qtd_pedidos) — fonte da verdade.
  // NÃO usar a contagem de etiquetas enviadas: a etiqueta Shopee tem ~2 blocos
  // ^XA por pedido, então "enviadas" dava ~2x (8 pedidos apareciam como 14/16).
  const pedidosReal = lote.qtd_pedidos;
  if (opts?.auto && pedidosReal < 2) return;
  if (!printerId) {
    if (!opts?.auto) toast.warning("Escolha a impressora primeiro.");
    return;
  }
  // Dedup no modo auto: pula se a identificadora deste lote já saiu nos últimos
  // 60s (evita as 2 iguais quando painel + por-SKU disparam em sequência).
  // Reserva o slot ANTES do await pra também barrar chamadas quase simultâneas.
  const ultimoIdent = identImpressoEm.get(lote.tag);
  if (opts?.auto && ultimoIdent != null && Date.now() - ultimoIdent < IDENT_JANELA_MS) return;
  identImpressoEm.set(lote.tag, Date.now());
  try {
    let produtoNome = "Vários itens";
    if (lote.sku) {
      const { data } = await supabaseExternal
        .from("produtos").select("nome").eq("sku", lote.sku).maybeSingle();
      produtoNome = (data as { nome?: string } | null)?.nome || `SKU ${lote.sku}`;
    }
    const mUn = /(\d+)\s*un\s*$/i.exec(lote.grupo_origem ?? "");
    const unPorPedido = mUn ? Number(mUn[1]) : null;
    const produtos = unPorPedido != null ? unPorPedido * pedidosReal : null;
    const zpl = gerarZplIdentificador({
      tag: lote.tag,
      grupo: lote.grupo_origem ?? "",
      produtoNome,
      pedidos: pedidosReal,
      produtos,
      envio: lote.tipo_envio ?? "-",
    });
    const { data: res, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
      body: { modulo: "imprimir", zpl, printer_id: printerId, title: `Identificador ${lote.tag}` },
    });
    if (error) throw new Error(error.message);
    if (!(res as { ok?: boolean })?.ok) {
      throw new Error(JSON.stringify((res as { resposta?: unknown })?.resposta ?? res));
    }
    if (!opts?.auto) toast.success(`Identificador do lote ${lote.tag} enviado à impressora`);
  } catch (e) {
    identImpressoEm.delete(lote.tag); // libera pra retentar se falhou
    toast.error(`Falha no identificador do lote ${lote.tag}`, { description: (e as Error).message });
  }
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
  const { perfil } = usePerfil();
  const { data: lotes, isLoading, error } = useTagsDoDia();
  const [ajudaAberta, setAjudaAberta] = useState(false);
  const [corpoAberto, setCorpoAberto] = useState(true);
  const [confirmar, setConfirmar] = useState<TagLoteRow | null>(null);
  const [embalando, setEmbalando] = useState<string | null>(null);
  const [imprimindo, setImprimindo] = useState<string | null>(null);
  const [lojaPorTag, setLojaPorTag] = useState<Record<string, "ottz" | "svl">>({});
  const [imprimindoIdent, setImprimindoIdent] = useState<string | null>(null);
  const [selLotes, setSelLotes] = useState<Set<string>>(new Set());
  const [embalandoLote, setEmbalandoLote] = useState(false);
  const [identificadorAtivo, setIdentificadorAtivo] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_IDENT) === "1"; } catch { return false; }
  });

  // Imprime a etiqueta identificadora de UM lote (ZPL cru via fulfillment-inbound
  // -> PrintNode). No modo automático pula lote de 1 pedido (não faz sentido).
  async function imprimirIdentificador(lote: TagLoteRow, opts?: { auto?: boolean }) {
    if (opts?.auto && lote.qtd_pedidos < 2) return; // evita piscar o spinner à toa
    setImprimindoIdent(lote.tag);
    try {
      await imprimirIdentificadorApi(lote, printerId, opts);
    } finally {
      setImprimindoIdent(null);
    }
  }

  function lojaDoLote(lote: TagLoteRow): "ottz" | "svl" {
    if (lojaPorTag[lote.tag]) return lojaPorTag[lote.tag];
    const g = (lote.grupo_origem ?? "").toLowerCase();
    if (g.includes("svl") || g.includes("sevilla")) return "svl";
    return "ottz";
  }

  async function imprimirLote(lote: TagLoteRow, forcar = false) {
    if (imprimindo) return;
    setImprimindo(lote.tag);
    try {
      const loja = lojaDoLote(lote);
      const url =
        `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
        `?modulo=imprimir&loja=${loja}` +
        `&tag=${encodeURIComponent(lote.tag)}` +
        `&printer_id=${printerId}` +
        (forcar ? `&forcar=1` : ``);
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
      if ((data.etiquetas_enviadas ?? 0) > 0) {
        void registrarSeparacaoLog({
          evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
          tag: lote.tag, sku: lote.sku,
          detalhe: { loja, enviadas: data.etiquetas_enviadas, forcar, via: "lote" },
        });
      }
      // Etiqueta identificadora junto do lote (se ligado e teve envio).
      // AWAIT (não void): como é um job SEPARADO no PrintNode, disparar em segundo
      // plano corria com o envio — a identificadora saía no meio/antes ou se perdia.
      // Await garante que ela entre na fila DEPOIS das etiquetas de envio do lote.
      // Normal: modo auto (com dedup de 60s contra a duplicada). Reimpressão
      // forçada: deliberada, SEM dedup (o operador quer o controle na pilha).
      // Identificadora quando o lote foi impresso AGORA (enviadas>0) OU já estava
      // todo impresso (ja_impressos_pulados>0 — o v51 pulou etiquetas já enviadas).
      // Nos dois casos o lote está pronto e merece o controle. Conta pela TAG.
      const loteImpresso =
        (data.etiquetas_enviadas ?? 0) > 0 || (data.ja_impressos_pulados ?? 0) > 0;
      if (identificadorAtivo && loteImpresso) {
        await imprimirIdentificador(lote, forcar ? {} : { auto: true });
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
      if ((data.embaladas ?? 0) > 0) {
        void registrarSeparacaoLog({
          evento: "embalado", usuario: perfil?.nome ?? null,
          tag: lote.tag, sku: lote.sku,
          detalhe: { embaladas: data.embaladas, total: data.total, via: "lote" },
        });
      }
      // recarrega em segundo plano — NÃO bloqueia a UI. O await aqui segurava
      // o estado "embalando" (que desabilita os botões) por vários segundos
      // enquanto a lista de 5000 linhas recarregava.
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      const err = e as Error;
      toast.error("Erro ao marcar embalado", { description: err.message });
    } finally {
      setEmbalando(null);
      setConfirmar(null);
    }
  }

  function toggleLote(tag: string, on: boolean) {
    setSelLotes((prev) => { const n = new Set(prev); if (on) n.add(tag); else n.delete(tag); return n; });
  }

  // Marca EMBALADO no Tiny os lotes selecionados de uma vez (loop no embalar-lote,
  // que respeita a trava de impressao confirmada — os sem etiqueta confirmada caem
  // em "com pendencia"; use o botao individual + forcar se precisar).
  async function marcarEmbaladoVarios() {
    const tags = [...selLotes];
    if (tags.length === 0 || embalandoLote) return;
    if (!window.confirm(`Marcar ${tags.length} lote(s) como EMBALADO no Tiny? Não tem desfazer.`)) return;
    setEmbalandoLote(true);
    let okLotes = 0, totalEmb = 0;
    const comPendencia: string[] = [];
    try {
      for (const tag of tags) {
        try {
          const data = await callSeparacaoFn<EmbalarLoteResponse>(
            `modulo=embalar-lote&tag=${encodeURIComponent(tag)}&confirmar=1`,
          );
          okLotes++;
          totalEmb += data.embaladas ?? 0;
          if ((data.embaladas ?? 0) > 0) {
            void registrarSeparacaoLog({
              evento: "embalado", usuario: perfil?.nome ?? null,
              tag, detalhe: { embaladas: data.embaladas, total: data.total, via: "lote-varios" },
            });
          }
          if (data.erros && data.erros.length > 0) comPendencia.push(tag);
        } catch {
          comPendencia.push(tag);
        }
      }
      toast.success(`${formatNumber(totalEmb)} pedido(s) embalado(s) em ${okLotes} lote(s)`,
        comPendencia.length ? { description: `${comPendencia.length} lote(s) com pendência (sem impressão confirmada): ${comPendencia.slice(0, 6).join(", ")}` } : undefined);
      setSelLotes(new Set());
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } finally {
      setEmbalandoLote(false);
    }
  }

  const lotesPendentes = (lotes ?? []).filter((l) => l.status !== "embalada");

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setCorpoAberto((v) => !v)}
          className="flex items-center gap-2 text-left"
          title={corpoAberto ? "Recolher" : "Expandir"}
        >
          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", !corpoAberto && "-rotate-90")} />
          <TagIcon className="h-4 w-4 text-primary" />
          <h2 className="font-semibold text-sm">Lotes do dia</h2>
          {lotes && lotes.length > 0 && (
            <Badge variant="secondary">{lotes.length}</Badge>
          )}
        </button>
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

      {corpoAberto && (<div className="space-y-3">
      {/* Impressora */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <Printer className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Impressora:</span>
        <Select
          value={printerId ? String(printerId) : undefined}
          onValueChange={(v) => setPrinterId(Number(v))}
          disabled={loadingImpressoras}
        >
          <SelectTrigger className="h-8 w-[380px] text-xs">
            <SelectValue placeholder={loadingImpressoras ? "Carregando..." : "Selecione a impressora"} />
          </SelectTrigger>
          <SelectContent>
            {(impressoras ?? []).map((p) => (
              <SelectItem key={p.printer_id} value={String(p.printer_id)}>
                <span className="flex items-center gap-1.5">
                  {p.configurada && (
                    <span title="Configurada no sistema (padrão)" className="text-emerald-600">★</span>
                  )}
                  <span>{p.nome} — {p.computador}</span>
                  <span className={p.estado === "online" ? "text-emerald-600" : "text-amber-600"}>
                    ({p.estado})
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">ID {p.printer_id}</span>
                </span>
              </SelectItem>
            ))}
            {!loadingImpressoras && (impressoras ?? []).length === 0 && (
              <SelectItem value="_" disabled>
                Nenhuma ZD220 encontrada
              </SelectItem>
            )}
          </SelectContent>
        </Select>
        {impressoraSelecionada && (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono px-1.5 py-0.5 rounded bg-muted text-foreground">
              PrintNode ID {impressoraSelecionada.printer_id}
            </span>
            {impressoraSelecionada.configurada ? (
              <span className="text-emerald-600" title="É a impressora configurada como padrão no sistema">
                ★ configurada
              </span>
            ) : (
              <span className="text-muted-foreground" title="Impressão sai nesta, mas o padrão do sistema é outra (★)">
                ≠ padrão do sistema
              </span>
            )}
          </span>
        )}
        {impressoraSelecionada?.estado === "offline" && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            Impressora offline — o job pode ficar preso na fila até ela reconectar.
          </span>
        )}
      </div>

      {/* Etiqueta identificadora do lote */}
      <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={identificadorAtivo}
          onChange={(e) => {
            setIdentificadorAtivo(e.target.checked);
            try { localStorage.setItem(STORAGE_IDENT, e.target.checked ? "1" : "0"); } catch { /* noop */ }
          }}
        />
        <span className="text-muted-foreground">
          Imprimir <strong className="text-foreground">etiqueta identificadora</strong> ao final do lote
          <span className="text-muted-foreground"> (só 2+ pedidos)</span>
        </span>
      </label>

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
        <div>
          {selLotes.size > 0 && (
            <div className="flex items-center gap-2 mb-2 p-2 rounded-md bg-primary/10 border border-primary/30 flex-wrap">
              <span className="text-sm font-medium">{selLotes.size} lote(s) selecionado(s)</span>
              <Button size="sm" onClick={() => void marcarEmbaladoVarios()} disabled={embalandoLote} className="gap-1.5">
                {embalandoLote ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                Marcar embalado no Tiny (em massa)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelLotes(new Set())}>Limpar</Button>
            </div>
          )}
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr className="border-b">
                <th className="py-2 pr-2 w-6">
                  <input
                    type="checkbox"
                    className="align-middle cursor-pointer"
                    checked={lotesPendentes.length > 0 && lotesPendentes.every((l) => selLotes.has(l.tag))}
                    onChange={(e) => setSelLotes(e.target.checked ? new Set(lotesPendentes.map((l) => l.tag)) : new Set())}
                    title="Selecionar todos os aguardando impressão"
                  />
                </th>
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
                    <td className="py-2 pr-2">
                      {!embalada && (
                        <input
                          type="checkbox"
                          className="align-middle cursor-pointer"
                          checked={selLotes.has(l.tag)}
                          onChange={(e) => toggleLote(l.tag, e.target.checked)}
                        />
                      )}
                    </td>
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
                    <td className="py-2 pr-3 text-muted-foreground">
                      {(() => {
                        const m = /^(.*?)(\d+)un\s*$/.exec(l.grupo_origem ?? "");
                        if (!m) return <span className="font-mono">{l.grupo_origem}</span>;
                        return (
                          <span className="inline-flex items-center gap-1.5 font-mono">
                            <span>{m[1]}</span>
                            <UnBadge n={Number(m[2])} className="text-[11px]" />
                          </span>
                        );
                      })()}
                    </td>
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
                            disabled={imprimindo !== null}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Reimprimir as etiquetas de envio do lote ${l.tag} (+ a identificadora)? ` +
                                    `Use só se travaram/não saíram — pode gerar etiquetas duplicadas.`,
                                )
                              ) {
                                void imprimirLote(l, true);
                              }
                            }}
                            title="Reimprime as etiquetas de envio já impressas deste lote (forçar)"
                          >
                            <Printer className="h-3 w-3 mr-1" />
                            Reimprimir
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={imprimindoIdent === l.tag}
                            onClick={() => void imprimirIdentificador(l)}
                            title="Imprimir a etiqueta identificadora deste lote"
                          >
                            {imprimindoIdent === l.tag ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <TagIcon className="h-3 w-3 mr-1" />
                                Identificador
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
        </div>
      )}
      </div>)}

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
  const { perfil } = usePerfil();
  const { data: rows, isLoading, error } = usePriorizadaRows();
  const { data: fullCount } = useFullCount();
  const { data: lotesHoje } = useTagsDoDia();
  const { data: tagsPorLinha } = useTagsPorLinha();
  const { data: prazosPorLinha } = usePrazosPorLinha();
  const { data: impressaoEstados } = useImpressaoEstados();
  const { data: impressorasData, isLoading: loadingImpressoras } = useImpressoras();
  const impressoras = impressorasData ?? [];
  // escolha do operador persiste entre reloads (não é troca de usuário)
  const [printerId, setPrinterId] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem(STORAGE_PRINTER));
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined" && printerId > 0) {
      window.localStorage.setItem(STORAGE_PRINTER, String(printerId));
    }
  }, [printerId]);
  // se a seleção salva não existe mais na lista (ex.: default antigo inválido),
  // cai na impressora CONFIGURADA no sistema; senão, na primeira online.
  useEffect(() => {
    if (!impressoras.length) return;
    if (impressoras.some((p) => p.printer_id === printerId)) return;
    const conf = impressoras.find((p) => p.configurada);
    const online = impressoras.find((p) => p.estado === "online");
    setPrinterId((conf ?? online ?? impressoras[0]).printer_id);
  }, [impressoras, printerId]);
  const impressoraSelecionada = useMemo(
    () => impressoras.find((p) => p.printer_id === printerId),
    [impressoras, printerId],
  );
  const [selectedEnvios, setSelectedEnvios] = useState<string[] | null>(null);
  const [buscaSku, setBuscaSku] = useState("");
  // filtro por prazo máximo de despacho: "todos" | "vencidos" | "0"(hoje) | "1" | "2" | "3" | "5" (dias)
  const [prazoFiltro, setPrazoFiltro] = useState<string>("todos");
  const [aplicando, setAplicando] = useState<string | null>(null);
  const [bloqueados, setBloqueados] = useState<Set<string>>(new Set());
  const [selGrupos, setSelGrupos] = useState<Set<string>>(new Set());
  const [aplicandoLote, setAplicandoLote] = useState(false);
  const [imprimindoKey, setImprimindoKey] = useState<string | null>(null);
  const [embalandoKey, setEmbalandoKey] = useState<string | null>(null);
  const [expandedSku, setExpandedSku] = useState<Set<string>>(new Set());
  const [forcarSku, setForcarSku] = useState<PriorizadaRow | null>(null);

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
      let qImp = supabaseExternal
        .from("view_separacao_pedidos")
        .select("tag_lote, marca_canal, numero_ecommerce");
      // a linha é sku·envio·qtd (tag_sugerida) — filtrar só por sku+envio
      // imprimiria também os lotes das outras quantidades
      if (item.tag_sugerida) qImp = qImp.eq("tag_sugerida", item.tag_sugerida);
      else qImp = qImp.eq("sku_unico", item.sku ?? "").eq("tipo_envio", item.tipo_envio ?? "");
      const { data, error: e1 } = await qImp;
      if (e1) throw e1;
      const groups = new Map<string, { loja: "ottz" | "svl"; tag: string }>();
      let skTiktok = 0, skNoLote = 0;
      for (const p of (data ?? []) as PedidoSepRow[]) {
        // Só Shopee entra aqui: a impressão por lote é da API da Shopee. Sem
        // este filtro um pedido ML casava o "ottz" do nome do canal e entraria
        // num lote Shopee. (ML não tem lote — imprime pedido a pedido.)
        if (marcaToCanal(p.marca_canal) !== "shopee") { skTiktok++; continue; }
        const loja = marcaToLoja(p.marca_canal);
        if (loja === "tiktok" || loja === null) { skTiktok++; continue; }
        if (!p.tag_lote) { skNoLote++; continue; }
        groups.set(`${loja}|${p.tag_lote}`, { loja, tag: p.tag_lote });
      }
      if (groups.size === 0) {
        toast.warning("Nada para imprimir", {
          description: skNoLote > 0
            ? "Nenhum pedido com TAG aplicada ainda."
            : "Nenhum pedido Shopee neste SKU (lote é só da Shopee).",
        });
        return;
      }
      let identOn = false;
      try { identOn = localStorage.getItem(STORAGE_IDENT) === "1"; } catch { /* noop */ }
      for (const g of groups.values()) {
        // imprime o lote — a dedup no backend (v51) pula quem já saiu (done/sent),
        // então reimprimir NÃO duplica e o reprocessamento só retenta os pendentes.
        const { enviadas, jaPulados } = await imprimirLoteApi(g.loja, g.tag, printerId, impressoraSelecionada?.nome);
        void registrarSeparacaoLog({
          evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
          tag: g.tag, sku: item.sku, detalhe: { loja: g.loja, enviadas, jaPulados, via: "sku" },
        });
        // identificadora por lote (impresso agora OU já estava todo impresso).
        // AWAIT (não void): sai DEPOIS das etiquetas de envio deste lote e antes
        // do próximo lote (não intercala no PrintNode). Conta pela TAG.
        if (identOn && (enviadas > 0 || jaPulados > 0)) {
          const loteRow = (lotesHoje ?? []).find((l) => l.tag === g.tag);
          if (loteRow) await imprimirIdentificadorApi(loteRow, printerId, { auto: true });
        }
      }
      if (skTiktok > 0) toast.info(`${skTiktok} pedido(s) não-Shopee ignorados (imprima pedido a pedido)`);
      if (skNoLote > 0) toast.warning(`${skNoLote} pedido(s) sem TAG ignorados`);
      // recarrega em segundo plano — NÃO bloqueia a UI. O await aqui segurava
      // o estado "embalando" (que desabilita os botões) por vários segundos
      // enquanto a lista de 5000 linhas recarregava.
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindoKey(null);
    }
  }

  async function embalarPorSku(
    item: PriorizadaRow,
    forcado?: { nome: string; motivo: string },
  ) {
    const key = `sku:${item.sku}:${item.tipo_envio}`;
    if (embalandoKey) return;
    const linhaKey = linhaKeyDe(item);
    const agg = impressaoEstados?.porLinha.get(linhaKey);
    const seps = agg?.seps ?? [];
    // Sem "forcar", só embala as separações cujo estado é done/forcado.
    const alvos = forcado
      ? seps
      : seps.filter((id) => {
          const e = impressaoEstados?.porSep.get(id) ?? "ausente";
          return e === "done" || e === "forcado";
        });
    if (alvos.length === 0) {
      toast.warning("Nada pra embalar", {
        description: forcado
          ? "Nenhum pedido nesta linha."
          : "Nenhum pedido teve impressão confirmada ainda.",
      });
      return;
    }
    setEmbalandoKey(key);
    try {
      let ok = 0, errs = 0;
      const qs = forcado
        ? `&forcar=1&forcado_por=${encodeURIComponent(forcado.nome)}&forcado_motivo=${encodeURIComponent(forcado.motivo)}`
        : "";
      // Batelada: chama embalar-um separacao_id por id
      for (const id of alvos) {
        try {
          await callSeparacaoFn(
            `modulo=embalar-um&separacao_id=${id}&confirmar=1${qs}`,
          );
          ok++;
          void registrarSeparacaoLog({
            evento: "embalado", usuario: perfil?.nome ?? null,
            separacao_id: id, sku: item.sku, detalhe: { via: "sku", forcado: !!forcado },
          });
        } catch (e) {
          errs++;
          console.warn("embalar-um falhou", id, (e as Error).message);
        }
      }
      if (errs > 0) {
        toast.warning(`${ok}/${alvos.length} embalados — ${errs} erro(s)`);
      } else {
        toast.success(`${ok} pedido(s) marcados como embalados`);
      }
      // recarrega em segundo plano — NÃO bloqueia a UI. O await aqui segurava
      // o estado "embalando" (que desabilita os botões) por vários segundos
      // enquanto a lista de 5000 linhas recarregava.
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao marcar embalado", { description: (e as Error).message });
    } finally {
      setEmbalandoKey(null);
    }
  }

  async function imprimirPedido(p: PedidoSepRow) {
    const key = `ped:${p.numero_ecommerce}`;
    const canal = marcaToCanal(p.marca_canal);
    const loja = marcaToLoja(p.marca_canal);
    if (canal === "tiktok") { toast.error("TikTok não usa etiqueta do app"); return; }
    if (canal === "outro") {
      toast.error(`Canal sem etiqueta pelo app: ${rotuloCanal(p.marca_canal)}`);
      return;
    }
    if (canal === "shopee" && (!loja || loja === "tiktok")) {
      toast.error(`Loja Shopee não reconhecida em "${rotuloCanal(p.marca_canal)}"`);
      return;
    }
    if (canal === "mercadolivre" && !mlContaIntegrada(p.marca_canal)) {
      toast.error("Conta SVL do Mercado Livre não integrada", {
        description: "A etiqueta sai pelo token da Ottz. Imprima este pedido pelo painel do ML.",
        duration: 8000,
      });
      return;
    }
    if (!p.numero_ecommerce) { toast.error("Sem número do pedido"); return; }
    if (imprimindoKey) return;
    if (impressoraSelecionada?.estado === "offline") {
      if (!window.confirm("Impressora offline. Continuar?")) return;
    }
    setImprimindoKey(key);
    try {
      if (canal === "mercadolivre") {
        await imprimirPedidoMlApi(p.numero_ecommerce, printerId, impressoraSelecionada?.nome);
      } else {
        await imprimirPedidoApi(loja as "ottz" | "svl", p.numero_ecommerce, printerId, impressoraSelecionada?.nome);
      }
      void registrarSeparacaoLog({
        evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
        order_sn: p.numero_ecommerce, separacao_id: p.separacao_id, sku: p.sku_unico,
        detalhe: { loja, canal, via: "pedido" },
      });
      // recarrega em segundo plano — NÃO bloqueia a UI. O await aqui segurava
      // o estado "embalando" (que desabilita os botões) por vários segundos
      // enquanto a lista de 5000 linhas recarregava.
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      toast.error("Erro ao imprimir", { description: (e as Error).message });
    } finally {
      setImprimindoKey(null);
    }
  }

  async function embalarPedido(
    p: PedidoSepRow,
    forcado?: { nome: string; motivo: string },
  ) {
    const key = `ped:${p.numero_ecommerce}`;
    if (embalandoKey || p.separacao_id == null) {
      if (p.separacao_id == null) toast.error("Sem separacao_id");
      return;
    }
    setEmbalandoKey(key);
    try {
      const qs = forcado
        ? `&forcar=1&forcado_por=${encodeURIComponent(forcado.nome)}&forcado_motivo=${encodeURIComponent(forcado.motivo)}`
        : "";
      await callSeparacaoFn(
        `modulo=embalar-um&separacao_id=${p.separacao_id}&confirmar=1${qs}`,
      );
      void registrarSeparacaoLog({
        evento: "embalado", usuario: perfil?.nome ?? null,
        order_sn: p.numero_ecommerce, separacao_id: p.separacao_id, sku: p.sku_unico,
        detalhe: { via: "pedido", forcado: !!forcado },
      });
      toast.success(
        forcado
          ? `Pedido ${p.numero_ecommerce} embalado (forçado)`
          : `Pedido ${p.numero_ecommerce} marcado como embalado`,
      );
      // recarrega em segundo plano — NÃO bloqueia a UI. O await aqui segurava
      // o estado "embalando" (que desabilita os botões) por vários segundos
      // enquanto a lista de 5000 linhas recarregava.
      void qc.invalidateQueries({ queryKey: ["separacao"] });
    } catch (e) {
      const err = e as Error & { status?: number; body?: unknown };
      if (err.status === 409) {
        toast.error("Bloqueado: impressão não confirmada", {
          description:
            "Imprima a etiqueta primeiro, ou use ⚠️ Forçar embalar se a etiqueta física já saiu.",
        });
      } else {
        toast.error("Erro ao marcar embalado", { description: err.message });
      }
    } finally {
      setEmbalandoKey(null);
    }
  }

  const lotesPorTag = useMemo(() => {
    const m = new Map<string, TagLoteRow>();
    (lotesHoje ?? []).forEach((l) => m.set(l.tag, l));
    return m;
  }, [lotesHoje]);

  async function aplicarTag(grupo: string) {
    if (aplicando || bloqueados.has(grupo)) return;
    setAplicando(grupo);
    try {
      const data = await callSeparacaoFn<TagLoteResponse>(
        `modulo=tag-lote&grupo=${encodeURIComponent(grupo)}`,
      );
      void registrarSeparacaoLog({
        evento: "tag_aplicada", usuario: perfil?.nome ?? null,
        tag: data.tag, detalhe: { grupo, pedidos_tagueados: data.pedidos_tagueados },
      });
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

  function toggleGrupo(grupo: string, on: boolean) {
    setSelGrupos((prev) => { const n = new Set(prev); if (on) n.add(grupo); else n.delete(grupo); return n; });
  }

  // Aplica TAG em vários blocos selecionados de uma vez (loop no tag-lote) — pra
  // não perder tempo aplicando TAG a TAG no início do dia.
  async function aplicarTagVarios() {
    const grupos = [...selGrupos].filter((g) => g && !bloqueados.has(g));
    if (grupos.length === 0 || aplicandoLote) return;
    setAplicandoLote(true);
    let okTags = 0, totalPed = 0;
    const comErro: string[] = [];
    try {
      for (const grupo of grupos) {
        try {
          const data = await callSeparacaoFn<TagLoteResponse>(`modulo=tag-lote&grupo=${encodeURIComponent(grupo)}`);
          okTags++;
          totalPed += data.pedidos_tagueados ?? 0;
          void registrarSeparacaoLog({
            evento: "tag_aplicada", usuario: perfil?.nome ?? null,
            tag: data.tag, detalhe: { grupo, pedidos_tagueados: data.pedidos_tagueados, via: "varios" },
          });
        } catch (e) {
          const err = e as Error & { status?: number };
          if (err.status !== 409) comErro.push(grupo); // 409 = já tagueados hoje, ok
        }
      }
      toast.success(`${okTags} TAG(s) aplicada(s) · ${formatNumber(totalPed)} pedidos`,
        comErro.length ? { description: `${comErro.length} bloco(s) com erro` } : undefined);
      setSelGrupos(new Set());
      await qc.invalidateQueries({ queryKey: ["separacao", "tags_lote", "hoje"] });
    } finally {
      setAplicandoLote(false);
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
      if (prazoFiltro !== "todos") {
        const dias = diasAtePrazo(prazosPorLinha?.get(linhaKeyDe(r)) ?? null);
        if (dias === null) return false; // sem prazo não entra num filtro por prazo
        if (prazoFiltro === "vencidos") {
          if (dias >= 0) return false;
        } else if (dias > Number(prazoFiltro)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, enviosAtivosSet, buscaSku, prazoFiltro, prazosPorLinha]);

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
      {selGrupos.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-card border shadow-lg">
          <span className="text-sm font-medium">{selGrupos.size} bloco(s) selecionado(s)</span>
          <Button size="sm" onClick={() => void aplicarTagVarios()} disabled={aplicandoLote} className="gap-1.5">
            {aplicandoLote ? <Loader2 className="h-4 w-4 animate-spin" /> : <TagIcon className="h-4 w-4" />}
            Aplicar TAG em massa
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelGrupos(new Set())}>Limpar</Button>
        </div>
      )}
      <SeparacaoTotaisCards />
      <LotesDoDia
        printerId={printerId}
        setPrinterId={setPrinterId}
        impressoras={impressoras}
        loadingImpressoras={loadingImpressoras}
        impressoraSelecionada={impressoraSelecionada}
      />


      {/* Chips de envio (filtro + contagem) + busca — os chips SÃO o filtro */}
      <div className="flex flex-wrap items-center gap-2">
        <ChipEnvio
          label="Todos"
          count={totais.pedidos}
          active={selectedEnvios === null || selectedEnvios.length === enviosDisponiveis.length}
          onClick={() => setSelectedEnvios(null)}
        />
        {enviosDisponiveis.map((env) => {
          const cfg = ENVIO_HEADER[env];
          const grupo = grupos.find((g) => g.tipo_envio === env);
          const pedidos = grupo ? grupo.items.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0) : 0;
          return (
            <ChipEnvio
              key={env}
              label={env}
              count={pedidos}
              color={cfg?.bg}
              textColor={cfg?.text}
              active={enviosAtivosSet.has(env)}
              isER={env === "ER"}
              onClick={() => toggleEnvio(env)}
            />
          );
        })}
        {multis.length > 0 && (
          <span className="flex items-center gap-2 rounded-[9px] border border-border bg-card pl-3.5 pr-2 py-[7px] text-[12.5px] font-semibold text-secondary-foreground">
            MULTI
            <span className="rounded-md bg-muted text-muted-foreground px-1.5 py-0.5 text-[11.5px] font-mono tabular-nums">
              {formatNumber(multis.reduce((s, r) => s + (r.qtd_pedidos ?? 0), 0))}
            </span>
          </span>
        )}
        {fullCount != null && fullCount > 0 && (
          <span
            className="rounded-[9px] border border-dashed border-border bg-muted/40 px-3 py-[7px] text-[11.5px] text-muted-foreground"
            title="Full é separado pelo marketplace, não no galpão"
          >
            Full (fora do galpão): {formatNumber(fullCount)}
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[12px] text-muted-foreground tabular-nums hidden md:inline">
          {formatNumber(totais.tags)} TAGs · {formatNumber(totais.pedidos)} pedidos · {formatNumber(totais.unidades)} un.
        </span>
        <Select value={prazoFiltro} onValueChange={setPrazoFiltro}>
          <SelectTrigger
            className={cn(
              "h-9 w-[168px] text-sm bg-card",
              prazoFiltro !== "todos" && "border-primary text-primary font-medium",
            )}
            title="Filtra os SKUs pelo prazo de despacho mais próximo do grupo"
          >
            <Hourglass className="h-3.5 w-3.5 mr-1 shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Prazo: todos</SelectItem>
            <SelectItem value="vencidos">⚠ Vencidos</SelectItem>
            <SelectItem value="0">Vence hoje</SelectItem>
            <SelectItem value="1">Até amanhã</SelectItem>
            <SelectItem value="2">Até 2 dias</SelectItem>
            <SelectItem value="3">Até 3 dias</SelectItem>
            <SelectItem value="5">Até 5 dias</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative w-full sm:w-auto sm:min-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={buscaSku}
            onChange={(e) => setBuscaSku(e.target.value)}
            placeholder="Buscar por SKU ou nome…"
            className="pl-8 h-9 text-sm bg-card"
          />
        </div>
      </div>

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
              className="rounded-[12px] px-4 py-3 flex items-center justify-between gap-4 border"
              style={{ backgroundColor: `${bg}14`, borderColor: `${bg}33` }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="inline-flex items-center gap-1 font-mono font-bold text-[11.5px] tracking-[0.04em] px-2 py-1 rounded-md shrink-0"
                  style={{ backgroundColor: bg, color }}
                >
                  {cfg?.icon && <Zap className="h-3 w-3" />}
                  {g.tipo_envio}
                </span>
                <span className="text-[14px] font-semibold text-foreground truncate">{label}</span>
              </div>
              <div className="text-[12px] text-muted-foreground font-mono tabular-nums shrink-0">
                {formatNumber(tags)} TAGs · {formatNumber(pedidos)} pedidos · {formatNumber(unidades)} unidades
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
                      <div className="flex items-center gap-1.5 font-mono text-sm md:text-base font-semibold">
                        <span>{item.sku ?? "—"}</span>
                        <span className="text-muted-foreground">·</span>
                        <span>{item.tipo_envio ?? ""}</span>
                        <span className="text-muted-foreground">·</span>
                        <UnBadge n={item.qtd_unidades ?? 1} />
                      </div>
                      <div
                        className="text-sm text-muted-foreground truncate"
                        title={item.nome_produto ?? ""}
                      >
                        {item.nome_produto ?? "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex flex-col items-center gap-0.5 w-24">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Prazo</span>
                        <PrazoBadge iso={prazosPorLinha?.get(linhaKeyDe(item)) ?? null} />
                      </div>
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
                        // Fonte da verdade: tag_lote dos pedidos ATUAIS da linha
                        // (view_separacao_pedidos), não lotesHoje. Isso evita mostrar
                        // tag velha quando pedidos novos entraram sem tag.
                        const linhaKey = linhaKeyDe(item);
                        const info = tagsPorLinha?.get(linhaKey);
                        const estado = info?.estado ?? "sem_tag";
                        const tagAtual = info?.tag;
                        const lote = tagAtual ? lotesPorTag.get(tagAtual) : undefined;

                        if (estado === "com_tag" && tagAtual) {
                          return (
                            <button
                              type="button"
                              onClick={() => void copyToClipboard(tagAtual)}
                              className={cn(
                                "inline-flex items-center gap-1 font-mono font-semibold text-sm px-3 py-2 rounded-md w-28 justify-center",
                                lote?.status === "embalada"
                                  ? "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                                  : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
                              )}
                              title="Copiar tag"
                            >
                              <TagIcon className="h-3 w-3" />
                              {tagAtual}
                            </button>
                          );
                        }
                        // sem_tag, parcial ou tags_mistas → oferecer Aplicar TAG
                        // (pedidos sem tag na linha sempre podem receber uma tag nova)
                        return (
                          <div className="flex flex-col items-end gap-1">
                            <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={selGrupos.has(grupo)}
                                disabled={!grupo || bloqueados.has(grupo)}
                                onChange={(e) => toggleGrupo(grupo, e.target.checked)}
                              />
                              marcar p/ TAG em massa
                            </label>
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
                            {estado === "parcial" && tagAtual && (
                              <div className="text-[10px] text-amber-700 dark:text-amber-400 max-w-[220px] text-right leading-tight">
                                {info?.comTag} c/ TAG <span className="font-mono">{tagAtual}</span>, {info?.semTag} sem TAG
                              </div>
                            )}
                            {estado === "tags_mistas" && (
                              <div className="text-[10px] text-amber-700 dark:text-amber-400 max-w-[220px] text-right leading-tight">
                                Pedidos com TAGs diferentes nesta linha
                              </div>
                            )}
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
                        {(() => {
                          const linhaKey = linhaKeyDe(item);
                          const agg = impressaoEstados?.porLinha.get(linhaKey);
                          const estBtn = estadoBotaoLinha(agg);
                          const liberados = (agg?.done ?? 0) + (agg?.forcado ?? 0);
                          const total = agg?.total ?? 0;
                          const bloq = (agg?.error ?? 0) + (agg?.ausente ?? 0);
                          const aguard = agg?.sent ?? 0;

                          if (estBtn === "vazio") {
                            return (
                              <Button size="sm" variant="outline" disabled className="w-36">
                                <Package className="h-3 w-3 mr-1" />
                                Marcar embalado
                              </Button>
                            );
                          }
                          if (estBtn === "aguardando") {
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled
                                className="w-36 bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300"
                                title={`${aguard} pedido(s) aguardando confirmação de impressão`}
                              >
                                <Hourglass className="h-3 w-3 mr-1" />
                                Aguardando {aguard}
                              </Button>
                            );
                          }
                          if (estBtn === "bloqueado") {
                            return (
                              <div className="flex flex-col gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled
                                  className="w-36 opacity-60"
                                  title="Nenhuma etiqueta confirmada — imprima antes"
                                >
                                  <Package className="h-3 w-3 mr-1" />
                                  Bloqueado ({bloq})
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="w-36 text-destructive hover:text-destructive text-xs h-7"
                                  disabled={busyEmbalar || embalandoKey !== null}
                                  onClick={() => setForcarSku(item)}
                                >
                                  <AlertTriangle className="h-3 w-3 mr-1" />
                                  Forçar embalar
                                </Button>
                              </div>
                            );
                          }
                          // liberado ou parcial
                          return (
                            <div className="flex flex-col gap-1">
                              <Button
                                size="sm"
                                variant={estBtn === "liberado" ? "default" : "secondary"}
                                disabled={busyEmbalar || embalandoKey !== null}
                                onClick={() => void embalarPorSku(item)}
                                className="w-36"
                                title={
                                  estBtn === "liberado"
                                    ? "Todos os pedidos com impressão confirmada"
                                    : `Só ${liberados} de ${total} pedidos serão embalados agora`
                                }
                              >
                                {busyEmbalar ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <Package className="h-3 w-3 mr-1" />
                                    {estBtn === "liberado"
                                      ? "Marcar embalado"
                                      : `Embalar ${liberados}/${total}`}
                                  </>
                                )}
                              </Button>
                              {estBtn === "parcial" && (bloq > 0 || aguard > 0) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="w-36 text-destructive hover:text-destructive text-xs h-7"
                                  disabled={busyEmbalar || embalandoKey !== null}
                                  onClick={() => setForcarSku(item)}
                                  title={`${bloq} bloqueado(s), ${aguard} aguardando`}
                                >
                                  <AlertTriangle className="h-3 w-3 mr-1" />
                                  Forçar restante
                                </Button>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </Card>
                  {isExpanded && (
                    <PedidosDoSku
                      sku={item.sku}
                      tipoEnvio={item.tipo_envio}
                      tagSugerida={item.tag_sugerida}
                      imprimindoKey={imprimindoKey}
                      embalandoKey={embalandoKey}
                      onImprimir={imprimirPedido}
                      onEmbalar={embalarPedido}
                      estadosPorSep={impressaoEstados?.porSep}
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

      <ForcarEmbalarDialog
        open={forcarSku !== null}
        titulo={`Forçar embalado — ${forcarSku?.sku ?? ""} · ${forcarSku?.tipo_envio ?? ""}`}
        descricao={
          (() => {
            const linhaKey = forcarSku ? linhaKeyDe(forcarSku) : "";
            const agg = impressaoEstados?.porLinha.get(linhaKey);
            const bloq = (agg?.error ?? 0) + (agg?.ausente ?? 0);
            const aguard = agg?.sent ?? 0;
            const total = agg?.total ?? 0;
            return (
              <p>
                <strong>{total}</strong> pedido(s) nesta linha serão marcados
                como embalados no Tiny — incluindo <strong>{bloq}</strong> sem
                confirmação de impressão e <strong>{aguard}</strong> ainda
                aguardando.
              </p>
            );
          })()
        }
        loading={embalandoKey === `sku:${forcarSku?.sku}:${forcarSku?.tipo_envio}`}
        onCancel={() => setForcarSku(null)}
        onConfirm={(nome, motivo) => {
          if (forcarSku) void embalarPorSku(forcarSku, { nome, motivo });
          setForcarSku(null);
        }}
      />
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
    <div className="w-full px-6 md:px-8 py-6 space-y-[18px]">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Fila de pedidos aguardando separação no galpão (Full excluído).
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <ProcessarAbertosButton />
          <AtualizarDoTinyButton />
          <Button onClick={atualizarFila} disabled={isFetching} variant="outline">
            <RefreshCw className={cn("h-4 w-4 mr-2", isFetching && "animate-spin")} />
            Atualizar fila
          </Button>
        </div>
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-[14px]">

        <Card className="p-4 flex flex-col gap-1.5">
          <div className="text-[12px] font-semibold text-muted-foreground">Total a separar</div>
          {isLoading ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <>
              <div className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums leading-none">
                {formatNumber(totalPedidos)} <span className="text-sm font-normal text-muted-foreground">pedidos</span>
              </div>
              <div className="text-[11.5px] text-muted-foreground">{formatNumber(totalUnidades)} unidades</div>
            </>
          )}
        </Card>
        <Card className="p-4 flex flex-col gap-1.5">
          <div className="text-[12px] font-semibold text-muted-foreground">Unitários</div>
          {isLoading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <div className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums leading-none">{formatNumber(totalUnitarios)}</div>
          )}
        </Card>
        <Card className="p-4 flex flex-col gap-1.5">
          <div className="text-[12px] font-semibold text-muted-foreground flex items-center gap-1.5">
            <BoxesIcon className="h-3.5 w-3.5" /> Multi SKU
          </div>
          {isLoading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <div className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums leading-none">{formatNumber(totalMulti)}</div>
          )}
        </Card>
        <Card className="p-4 flex flex-col gap-1.5 border-destructive/40 bg-destructive/5">
          <div className="text-[12px] font-semibold flex items-center gap-1.5 text-destructive">
            <Zap className="h-3.5 w-3.5" /> Entrega Rápida (ER)
          </div>
          {isLoading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <div className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums leading-none text-destructive">
              {formatNumber(totalER)} <span className="text-sm font-normal">⚡</span>
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
                      <td className="px-4 py-2 text-xs">{rotuloCanal(r.marca_canal)}</td>
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
