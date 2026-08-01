import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Search, CheckCircle2, ExternalLink, Send, Loader2, RefreshCw, FilePlus2, FileCheck2, Clock } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos / constantes

interface NotaCancelada {
  tiny_pedido_id: number;
  numero_pedido: string | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  data_pedido: string | null;
  valor_nf: number | null;
  numero_nf: string | null;
  serie_nf: string | null;
  data_emissao_nf: string | null;
  id_nota_fiscal: number | null;
  id_nota_devolucao: number | null;
  precisa_devolucao: boolean | null;
  devolucao_emitida: boolean | null;
}

const COLS =
  "tiny_pedido_id,numero_pedido,numero_ecommerce,marca_canal,data_pedido,valor_nf,numero_nf,serie_nf,data_emissao_nf,id_nota_fiscal,id_nota_devolucao,precisa_devolucao,devolucao_emitida";

const PAGE_SIZE = 50;

type Filtro = "todos" | "marcados" | "geradas" | "devolvidos";
type Periodo = "mes_atual" | "mes_anterior" | "90dias" | "todos";
type Empresa = "ottz" | "svl";
type SvlSit = "pendentes" | "autorizadas" | "todas";

// Intervalo de data_pedido para cada período. O varredor cobre 90 dias.
function rangePeriodo(p: Periodo): { ini?: string; fim?: string } {
  const now = new Date();
  if (p === "mes_atual") return { ini: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
  if (p === "mes_anterior")
    return {
      ini: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
      fim: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    };
  if (p === "90dias") return { ini: new Date(Date.now() - 90 * 86400000).toISOString() };
  return {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BulkItem {
  id_nota_fiscal: number | null;
  id_nota_devolucao: number | null;
  numero_pedido: string | null;
  valor_nf: number | string | null;
}
const somaValor = (itens: BulkItem[]) => itens.reduce((s, i) => s + (Number(i.valor_nf) || 0), 0);

interface PendenteEmissao {
  id_nota: number;
  numero: string | null;
  serie: string | null;
  valor: number | null;
  data_emissao: string | null;
  cliente: string | null;
  chave_referenciada: string | null;
  pedido_cancelado: {
    numero_pedido: string | null;
    numero_ecommerce: string | null;
    marca_canal: string | null;
    precisa_devolucao: boolean | null;
  } | null;
}

// cor por marketplace (só visual — a lista tem vários canais)
function corCanal(canal: string | null | undefined): string {
  const c = (canal ?? "").toLowerCase();
  if (c.includes("shopee")) return "#EE4D2D";
  if (c.includes("mercado")) return "#FFE600";
  if (c.includes("amazon")) return "#232F3E";
  if (c.includes("magalu") || c.includes("magazine")) return "#0086FF";
  return "#94a3b8";
}

// ─────────────────────────────────────────────────────────────────────────────
// Route

type SearchParams = {
  pagina: number;
  q: string;
  filtro: Filtro;
  periodo: Periodo;
  empresa: Empresa;
  svlsit: SvlSit;
};

export const Route = createFileRoute("/devolucoes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    pagina: Number.isFinite(Number(s.pagina)) ? Math.max(1, Math.floor(Number(s.pagina))) : 1,
    q: typeof s.q === "string" ? s.q : "",
    filtro: (["todos", "marcados", "geradas", "devolvidos"].includes(s.filtro as string)
      ? (s.filtro as Filtro)
      : "todos"),
    periodo: (["mes_atual", "mes_anterior", "90dias", "todos"].includes(s.periodo as string)
      ? (s.periodo as Periodo)
      : "mes_atual"),
    empresa: (["ottz", "svl"].includes(s.empresa as string) ? (s.empresa as Empresa) : "ottz"),
    svlsit: (["pendentes", "autorizadas", "todas"].includes(s.svlsit as string)
      ? (s.svlsit as SvlSit)
      : "pendentes"),
  }),
  component: DevolucoesPage,
});

// ─────────────────────────────────────────────────────────────────────────────
// Page

function DevolucoesPage() {
  const { empresa } = Route.useSearch();
  return empresa === "svl" ? <SvlDevolucoes /> : <OttzDevolucoes />;
}

// Segmento Ottz / SVL — troca a empresa na URL (sobrevive a remontagem).
function EmpresaToggle() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const opts: { id: Empresa; label: string }[] = [
    { id: "ottz", label: "Ottz / ACZ" },
    { id: "svl", label: "SVL Store" },
  ];
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => navigate({ search: { ...search, empresa: o.id, pagina: 1 }, replace: true })}
          className={cn(
            "px-3 py-1 text-xs font-medium rounded-sm transition",
            search.empresa === o.id
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function OttzDevolucoes() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  const page = search.pagina as number;
  const filtro = search.filtro as Filtro;
  const searchText = search.q as string;
  const periodo = search.periodo as Periodo;

  const [searchDraft, setSearchDraft] = useState(searchText);
  const [salvandoId, setSalvandoId] = useState<number | null>(null);
  const [criandoId, setCriandoId] = useState<number | null>(null);
  const [emitindoId, setEmitindoId] = useState<number | null>(null);
  const [bulk, setBulk] = useState<{ tipo: "gerar" | "emitir"; total: number; feito: number; ok: number; falha: number } | null>(null);

  const updateSearch = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  useEffect(() => setSearchDraft(searchText), [searchText]);
  useEffect(() => {
    const next = searchDraft.trim();
    if (next === searchText) return;
    const t = setTimeout(() => updateSearch({ q: next, pagina: 1 }), 250);
    return () => clearTimeout(t);
  }, [searchDraft, searchText]);

  const listKey = ["devolucoes", "lista", page, filtro, searchText, periodo] as const;

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;
      const { ini, fim } = rangePeriodo(periodo);
      // Lê da VIEW (reflete o status atual do pedido): exclui pedidos que
      // deixaram de estar cancelados (falso-positivo por flicker de status).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabaseExternal
        .from("view_devolucoes_lista")
        .select(COLS, { count: "exact" })
        .eq("finalidade_nf", "1")
        .not("id_nota_fiscal", "is", null);
      if (ini) q = q.gte("data_pedido", ini);
      if (fim) q = q.lt("data_pedido", fim);
      if (filtro === "marcados")
        q = q.eq("precisa_devolucao", true).is("id_nota_devolucao", null).not("devolucao_emitida", "is", true);
      else if (filtro === "geradas")
        q = q.not("id_nota_devolucao", "is", null).not("devolucao_emitida", "is", true);
      else if (filtro === "devolvidos") q = q.eq("devolucao_emitida", true);
      if (searchText) {
        const esc = searchText.replace(/[,%()]/g, " ").trim();
        if (esc) {
          q = q.or(
            `numero_pedido.ilike.%${esc}%,numero_ecommerce.ilike.%${esc}%,numero_nf.ilike.%${esc}%`,
          );
        }
      }
      q = q.order("data_emissao_nf", { ascending: false, nullsFirst: false }).range(start, end);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as unknown as NotaCancelada[], count: count ?? 0 };
    },
  });

  const rows = listQuery.data?.rows ?? [];
  const total = listQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Conjuntos para ações em massa (todo o período, não só a página).
  const bulkQuery = useQuery({
    queryKey: ["devolucoes", "bulk", periodo],
    queryFn: async (): Promise<{ aGerar: BulkItem[]; geradas: BulkItem[] }> => {
      const { ini, fim } = rangePeriodo(periodo);
      const base = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let q: any = supabaseExternal
          .from("view_devolucoes_lista")
          .select("id_nota_fiscal,id_nota_devolucao,numero_pedido,valor_nf")
          .eq("finalidade_nf", "1")
          .not("id_nota_fiscal", "is", null);
        if (ini) q = q.gte("data_pedido", ini);
        if (fim) q = q.lt("data_pedido", fim);
        return q;
      };
      const [g, e] = await Promise.all([
        base().eq("precisa_devolucao", true).is("id_nota_devolucao", null).not("devolucao_emitida", "is", true),
        base().not("id_nota_devolucao", "is", null).not("devolucao_emitida", "is", true),
      ]);
      return {
        aGerar: (g.data ?? []) as BulkItem[],
        geradas: (e.data ?? []) as BulkItem[],
      };
    },
  });
  const aGerar = bulkQuery.data?.aGerar ?? [];
  const geradas = bulkQuery.data?.geradas ?? [];

  // GERAR EM MASSA (baixo risco: só cria Pendentes). Sequencial + throttle ~1,5s
  // para respeitar o limite da API v2 (60/min). Pausa se a v2 bloquear seguidas.
  async function gerarEmMassa() {
    if (!aGerar.length) return;
    if (
      !window.confirm(
        `Gerar ${aGerar.length} nota(s) de devolução (Pendentes) no Tiny?\n\n` +
          `Valor total: ${formatBRL(somaValor(aGerar))}\n` +
          `NÃO autoriza na SEFAZ — só cria as notas. Leva ~${Math.ceil((aGerar.length * 1.8) / 60)} min.`,
      )
    )
      return;
    setBulk({ tipo: "gerar", total: aGerar.length, feito: 0, ok: 0, falha: 0 });
    let ok = 0, falha = 0, blocosSeguidos = 0;
    for (let i = 0; i < aGerar.length; i++) {
      const it = aGerar[i];
      try {
        const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
          body: { modulo: "criar", id_nota_venda: it.id_nota_fiscal, confirmar: "1" },
        });
        if (error) throw new Error(error.message);
        const d = data as { ok?: boolean; bloqueada?: boolean };
        if (d?.ok) { ok++; blocosSeguidos = 0; }
        else if (d?.bloqueada) {
          blocosSeguidos++;
          if (blocosSeguidos >= 2) {
            toast.warning("API v2 do Tiny bloqueada — lote pausado.", {
              description: "Aguarde alguns minutos e clique novamente para continuar de onde parou.",
            });
            break;
          }
          await sleep(10000);
          i--; // repete o mesmo item
          continue;
        } else { falha++; blocosSeguidos = 0; }
      } catch { falha++; }
      setBulk({ tipo: "gerar", total: aGerar.length, feito: i + 1, ok, falha });
      await sleep(1500);
    }
    setBulk(null);
    toast.success(`Geração em massa: ${ok} criada(s), ${falha} falha(s)`);
    queryClient.invalidateQueries({ queryKey: ["devolucoes"] });
  }

  // EMITIR EM MASSA (SEFAZ, irreversível) — confirmação forte (qtd + valor).
  async function emitirEmMassa() {
    if (!geradas.length) return;
    if (
      !window.confirm(
        `EMITIR ${geradas.length} NF-e de devolução na SEFAZ?\n\n` +
          `Valor total: ${formatBRL(somaValor(geradas))}\n\n` +
          `⚠️ É DEFINITIVO e irreversível — cada uma vira uma NF-e real autorizada.`,
      )
    )
      return;
    setBulk({ tipo: "emitir", total: geradas.length, feito: 0, ok: 0, falha: 0 });
    let ok = 0, falha = 0;
    for (let i = 0; i < geradas.length; i++) {
      const it = geradas[i];
      try {
        const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
          body: { modulo: "emitir", id_nota: it.id_nota_devolucao, confirmar: "1" },
        });
        if (error) throw new Error(error.message);
        if ((data as { autorizada?: boolean })?.autorizada) ok++;
        else falha++;
      } catch { falha++; }
      setBulk({ tipo: "emitir", total: geradas.length, feito: i + 1, ok, falha });
      await sleep(800);
    }
    setBulk(null);
    toast.success(`Emissão em massa: ${ok} autorizada(s), ${falha} falha(s)`);
    queryClient.invalidateQueries({ queryKey: ["devolucoes"] });
  }

  // Marcar/desmarcar precisa_devolucao — grava no banco, com atualização otimista.
  async function toggleDevolucao(row: NotaCancelada, valor: boolean) {
    setSalvandoId(row.tiny_pedido_id);
    // otimista
    queryClient.setQueryData(listKey, (old: { rows: NotaCancelada[]; count: number } | undefined) =>
      old
        ? {
            ...old,
            rows: old.rows.map((r) =>
              r.tiny_pedido_id === row.tiny_pedido_id ? { ...r, precisa_devolucao: valor } : r,
            ),
          }
        : old,
    );
    const { error } = await supabaseExternal
      .from("notas_cancelados")
      .update({ precisa_devolucao: valor })
      .eq("tiny_pedido_id", row.tiny_pedido_id);
    setSalvandoId(null);
    if (error) {
      // reverte
      queryClient.setQueryData(listKey, (old: { rows: NotaCancelada[]; count: number } | undefined) =>
        old
          ? {
              ...old,
              rows: old.rows.map((r) =>
                r.tiny_pedido_id === row.tiny_pedido_id ? { ...r, precisa_devolucao: !valor } : r,
              ),
            }
          : old,
      );
      toast.error("Não foi possível salvar", { description: error.message });
    }
  }

  // Fase 3: cria a devolução PELO APP (API v2) a partir da NF de venda. Nasce
  // Pendente no Tiny — NÃO vai à SEFAZ aqui; a emissão continua sendo o passo
  // explícito do card "Pendentes de emissão" (dupla confirmação).
  async function criarDevolucao(row: NotaCancelada) {
    if (row.id_nota_fiscal == null) {
      toast.warning("Este pedido não tem NF de venda vinculada.");
      return;
    }
    if (
      !window.confirm(
        `Gerar a nota de devolução do pedido ${row.numero_pedido ?? ""} no Tiny?\n\n` +
          `Copia cliente e itens da NF ${row.numero_nf ?? ""} e cria a nota como Pendente (aguardando emissão). NÃO autoriza na SEFAZ ainda.`,
      )
    )
      return;
    setCriandoId(row.tiny_pedido_id);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
        body: { modulo: "criar", id_nota_venda: row.id_nota_fiscal, confirmar: "1" },
      });
      if (error) throw new Error(error.message);
      const d = data as {
        ok?: boolean;
        registro?: { numero?: string; serie?: string };
        erros?: unknown;
        erro?: string;
      };
      if (!d?.ok) {
        throw new Error(
          d?.erro ||
            (Array.isArray(d?.erros) && d.erros.length
              ? JSON.stringify(d.erros)
              : "o Tiny não confirmou a criação"),
        );
      }
      const reg = d.registro;
      toast.success(
        `Nota de devolução ${reg?.numero ?? ""}/${reg?.serie ?? ""} gerada (Pendente)`,
        { description: 'Agora abra "Pendentes de emissão" e clique em Emitir para autorizar na SEFAZ.' },
      );
      queryClient.invalidateQueries({ queryKey: ["devolucoes"] });
    } catch (e) {
      toast.error(`Falha ao criar a devolução do pedido ${row.numero_pedido ?? ""}`, {
        description: (e as Error).message,
      });
    } finally {
      setCriandoId(null);
    }
  }

  // Emite (autoriza na SEFAZ) a nota de devolução JÁ gerada, direto da linha.
  // Usa o id_nota_devolucao (não precisa passar pelo card "Pendentes"). SEFAZ =
  // irreversível, por isso confirmação dupla.
  async function emitirDireto(row: NotaCancelada) {
    if (row.id_nota_devolucao == null) return;
    if (
      !window.confirm(
        `Emitir (autorizar na SEFAZ) a nota de devolução do pedido ${row.numero_pedido ?? ""}?\n\n` +
          `É DEFINITIVO — gera uma NF-e real na SEFAZ.`,
      )
    )
      return;
    setEmitindoId(row.tiny_pedido_id);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
        body: { modulo: "emitir", id_nota: row.id_nota_devolucao, confirmar: "1" },
      });
      if (error) throw new Error(error.message);
      const d = data as {
        autorizada?: boolean;
        situacao?: string;
        motivo?: string;
        numero?: string;
        serie?: string;
      };
      if (d?.autorizada) {
        toast.success(`NF de devolução ${d.numero ?? ""}/${d.serie ?? ""} autorizada na SEFAZ`);
        queryClient.invalidateQueries({ queryKey: ["devolucoes"] });
      } else {
        toast.warning(`Ainda não autorizou (situação ${d?.situacao ?? "?"})`, {
          description: d?.motivo || "Tente novamente em instantes.",
        });
      }
    } catch (e) {
      toast.error(`Falha ao emitir o pedido ${row.numero_pedido ?? ""}`, {
        description: (e as Error).message,
      });
    } finally {
      setEmitindoId(null);
    }
  }

  const goToPage = (n: number) => updateSearch({ pagina: Math.max(1, Math.min(totalPages, n)) });

  const error = (listQuery.error as Error | null)?.message ?? null;
  const loading = listQuery.isLoading;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <RotateCcw className="h-6 w-6" /> Devolução de Pedidos
          </h1>
          <EmpresaToggle />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Fluxo: <strong>marque</strong> o pedido → <strong>gere a nota</strong> de devolução →{" "}
          <strong>emita</strong> a NF na SEFAZ (card "Pendentes de emissão").
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <FilePlus2 className="h-3 w-3" /> Gerar nota = cria no Tiny (Pendente)
          </span>
          <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
            <Clock className="h-3 w-3" /> Nota gerada = aguardando emissão
          </span>
          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3 w-3" /> NF autorizada = concluída na SEFAZ
          </span>
        </div>
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <FiltroSegment value={filtro} onChange={(f) => updateSearch({ filtro: f, pagina: 1 })} />
        <Select value={periodo} onValueChange={(v) => updateSearch({ periodo: v as Periodo, pagina: 1 })}>
          <SelectTrigger className="h-9 w-[160px] bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mes_atual">Mês atual</SelectItem>
            <SelectItem value="mes_anterior">Mês anterior</SelectItem>
            <SelectItem value="90dias">Últimos 90 dias</SelectItem>
            <SelectItem value="todos">Todos</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Buscar por pedido, order_sn ou NF..."
            className="pl-8 h-9 bg-card"
          />
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {error}
        </Card>
      )}

      <PendentesEmissaoCard onEmitiu={() => queryClient.invalidateQueries({ queryKey: ["devolucoes"] })} />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
          <h3 className="text-sm font-semibold">
            Pedidos cancelados com NF{" "}
            <span className="text-muted-foreground font-normal">({total})</span>
          </h3>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={bulk !== null || aGerar.length === 0}
              title="Gera as notas de devolução (Pendentes) de todos os marcados do período"
              onClick={() => void gerarEmMassa()}
            >
              {bulk?.tipo === "gerar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus2 className="h-3.5 w-3.5" />}
              Gerar em massa ({aGerar.length})
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-blue-500/50 text-blue-700 dark:text-blue-300 hover:bg-blue-500/10"
              disabled={bulk !== null || geradas.length === 0}
              title="Autoriza na SEFAZ todas as notas já geradas do período (definitivo)"
              onClick={() => void emitirEmMassa()}
            >
              {bulk?.tipo === "emitir" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Emitir em massa ({geradas.length})
            </Button>
          </div>
        </div>

        {bulk && (
          <div className="px-4 py-2 border-b bg-muted/40 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium">
                {bulk.tipo === "gerar" ? "Gerando notas…" : "Emitindo NF-e…"} {bulk.feito}/{bulk.total}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {bulk.ok} ok{bulk.falha > 0 ? ` · ${bulk.falha} falha(s)` : ""}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${bulk.total > 0 ? Math.round((bulk.feito / bulk.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-center font-medium px-3 py-2 w-24">Devolver?</th>
                <th className="text-left font-medium px-3 py-2">Pedido</th>
                <th className="text-left font-medium px-3 py-2">Order / e-commerce</th>
                <th className="text-left font-medium px-3 py-2">Canal</th>
                <th className="text-left font-medium px-3 py-2">Data</th>
                <th className="text-right font-medium px-3 py-2">Valor NF</th>
                <th className="text-left font-medium px-3 py-2">NF</th>
                <th className="text-left font-medium px-3 py-2">Emissão</th>
                <th className="text-center font-medium px-3 py-2 w-52">Devolução</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={9} className="px-3 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhum pedido cancelado com NF nesta visão.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const devolvido = r.devolucao_emitida === true;
                  const notaGerada = !devolvido && r.id_nota_devolucao != null;
                  return (
                    <tr
                      key={r.tiny_pedido_id}
                      className={cn(
                        "border-t hover:bg-accent/40 transition",
                        r.precisa_devolucao && !notaGerada && !devolvido && "bg-amber-500/5",
                        notaGerada && "bg-blue-500/5",
                        devolvido && "opacity-60",
                      )}
                    >
                      <td className="px-3 py-2 text-center">
                        <Checkbox
                          checked={!!r.precisa_devolucao}
                          disabled={devolvido || salvandoId === r.tiny_pedido_id}
                          onCheckedChange={(c) => toggleDevolucao(r, c === true)}
                          aria-label="Marcar para devolução"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.numero_pedido ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground max-w-[200px] truncate">
                        {r.numero_ecommerce ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
                          <span
                            aria-hidden
                            className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: corCanal(r.marca_canal) }}
                          />
                          {r.marca_canal ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.data_pedido ? format(parseISO(r.data_pedido), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.valor_nf != null ? formatBRL(r.valor_nf) : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {r.numero_nf ? `${r.numero_nf}${r.serie_nf ? ` / ${r.serie_nf}` : ""}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.data_emissao_nf ? format(parseISO(r.data_emissao_nf), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {devolvido ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] h-5 px-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 gap-1"
                            title="NF de devolução autorizada na SEFAZ"
                          >
                            <CheckCircle2 className="h-3 w-3" /> NF autorizada
                          </Badge>
                        ) : notaGerada ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1.5 text-xs border-blue-500/50 text-blue-700 dark:text-blue-300 hover:bg-blue-500/10"
                            disabled={emitindoId !== null || bulk !== null}
                            title="Nota já gerada (Pendente). Clique para autorizar a NF na SEFAZ — definitivo."
                            onClick={() => void emitirDireto(r)}
                          >
                            {emitindoId === r.tiny_pedido_id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="h-3.5 w-3.5" />
                            )}
                            Emitir NF
                          </Button>
                        ) : r.precisa_devolucao ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1.5 text-xs"
                            disabled={criandoId !== null || bulk !== null || r.id_nota_fiscal == null}
                            title="Gera a nota de devolução (Pendente) no Tiny a partir da NF de venda. (uma por vez, para respeitar o limite da API v2)"
                            onClick={() => void criarDevolucao(r)}
                          >
                            {criandoId === r.tiny_pedido_id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <FilePlus2 className="h-3.5 w-3.5" />
                            )}
                            Gerar nota de devolução
                          </Button>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
            <span className="text-muted-foreground">
              Página {page} de {totalPages} · {total} pedidos
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ExternalLink className="h-3 w-3" />
        Fase 1: identificação e marcação. A emissão da nota de devolução é feita no Tiny (fases
        seguintes).
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponentes

// Devoluções criadas manualmente no Tiny (tipo E, Pendentes) aguardando emissão.
// Busca sob demanda (a varredura no Tiny leva ~15s) e emissão 1 a 1 com
// confirmação dupla — emitir é NF-e real na SEFAZ, irreversível.
function PendentesEmissaoCard({ onEmitiu }: { onEmitiu: () => void }) {
  const [pendentes, setPendentes] = useState<PendenteEmissao[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [armado, setArmado] = useState<number | null>(null);
  const [emitindo, setEmitindo] = useState<number | null>(null);

  async function buscar() {
    setBuscando(true);
    setArmado(null);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
        body: { modulo: "pendentes", dias: 30 },
      });
      if (error) throw new Error(error.message);
      setPendentes((data?.pendentes ?? []) as PendenteEmissao[]);
    } catch (e) {
      toast.error("Falha ao buscar pendentes no Tiny", { description: (e as Error).message });
    } finally {
      setBuscando(false);
    }
  }

  async function emitir(p: PendenteEmissao) {
    setEmitindo(p.id_nota);
    setArmado(null);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
        body: { modulo: "emitir", id_nota: p.id_nota, confirmar: "1" },
      });
      if (error) throw new Error(error.message);
      if (data?.autorizada) {
        toast.success(`Devolução ${data.numero}/${data.serie} autorizada na SEFAZ`, {
          description: data.registrado_no_app
            ? "Pedido marcado como devolvido no app."
            : "Nota emitida (pedido fora da lista de cancelados — ex.: devolução de entrega).",
        });
        setPendentes((prev) => (prev ?? []).filter((x) => x.id_nota !== p.id_nota));
        onEmitiu();
      } else {
        toast.warning(`Nota ${p.numero}: situação ${data?.situacao ?? "desconhecida"}`, {
          description: "A SEFAZ não autorizou de imediato — confira no Tiny.",
        });
      }
    } catch (e) {
      toast.error(`Erro ao emitir a nota ${p.numero}`, { description: (e as Error).message });
    } finally {
      setEmitindo(null);
    }
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Send className="h-4 w-4" /> Pendentes de emissão
            {pendentes && <Badge variant="secondary">{pendentes.length}</Badge>}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Devoluções criadas no Tiny aguardando autorização na SEFAZ. A emissão é definitiva.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-2" onClick={buscar} disabled={buscando}>
          {buscando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {pendentes ? "Atualizar" : "Buscar no Tiny"}
        </Button>
      </div>

      {buscando && !pendentes && (
        <p className="text-xs text-muted-foreground">Varrendo notas no Tiny (~15s)...</p>
      )}

      {pendentes && pendentes.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma devolução pendente de emissão. 🎉</p>
      )}

      {pendentes && pendentes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-1.5 px-2">NF</th>
                <th className="text-left font-medium px-2">Cliente</th>
                <th className="text-right font-medium px-2">Valor</th>
                <th className="text-left font-medium px-2">Pedido de origem</th>
                <th className="text-right font-medium px-2 w-44">Ação</th>
              </tr>
            </thead>
            <tbody>
              {pendentes.map((p) => {
                const busy = emitindo === p.id_nota;
                const estaArmado = armado === p.id_nota;
                return (
                  <tr key={p.id_nota} className="border-t border-border/50">
                    <td className="py-1.5 px-2 font-mono text-xs whitespace-nowrap">
                      {p.numero}/{p.serie}
                    </td>
                    <td className="px-2 text-xs max-w-[220px] truncate">{p.cliente ?? "—"}</td>
                    <td className="px-2 text-right tabular-nums">
                      {p.valor != null ? formatBRL(p.valor) : "—"}
                    </td>
                    <td className="px-2 text-xs">
                      {p.pedido_cancelado ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: corCanal(p.pedido_cancelado.marca_canal) }}
                          />
                          <span className="font-mono">{p.pedido_cancelado.numero_pedido}</span>
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">cancelado</Badge>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">devolução de entrega</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {estaArmado ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs gap-1.5"
                          disabled={busy || emitindo !== null}
                          onClick={() => emitir(p)}
                        >
                          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                          Confirmar (SEFAZ)
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1.5"
                          disabled={emitindo !== null}
                          onClick={() => setArmado(p.id_nota)}
                        >
                          <Send className="h-3 w-3" /> Emitir
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FiltroSegment({ value, onChange }: { value: Filtro; onChange: (v: Filtro) => void }) {
  const opts: { id: Filtro; label: string }[] = [
    { id: "todos", label: "Todos" },
    { id: "marcados", label: "A gerar" },
    { id: "geradas", label: "Nota gerada" },
    { id: "devolvidos", label: "NF autorizada" },
  ];
  return (
    <div className="inline-flex rounded-md border bg-card p-0.5">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-sm transition",
            value === o.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Aba SVL — devoluções do Tiny de faturamento da SVL (série 12). Lê o espelho
// `devolucoes_svl` (sync leve) e emite via nf-devolucao (conta=svl). Emitir é
// NF-e real na SEFAZ (irreversível): individual com confirmação, ou em massa
// pelas selecionadas com confirmação forte (qtd + valor).

interface DevSvl {
  id_nota: number;
  numero: string | null;
  serie: string | null;
  valor: number | null;
  cliente_nome: string | null;
  data_emissao: string | null;
  situacao: string | null;
  autorizada: boolean | null;
  chave_devolucao: string | null;
}
const SVL_COLS = "id_nota,numero,serie,valor,cliente_nome,data_emissao,situacao,autorizada,chave_devolucao";

function SvlDevolucoes() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const qc = useQueryClient();

  const page = search.pagina as number;
  const svlsit = search.svlsit as SvlSit;
  const searchText = search.q as string;

  const [searchDraft, setSearchDraft] = useState(searchText);
  const [emitindoId, setEmitindoId] = useState<number | null>(null);
  const [sincronizando, setSincronizando] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [bulk, setBulk] = useState<{ total: number; feito: number; ok: number; falha: number } | null>(null);

  const updateSearch = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  useEffect(() => setSearchDraft(searchText), [searchText]);
  useEffect(() => {
    const next = searchDraft.trim();
    if (next === searchText) return;
    const t = setTimeout(() => updateSearch({ q: next, pagina: 1 }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, searchText]);

  const listKey = ["devolucoes", "svl", "lista", page, svlsit, searchText] as const;
  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const start = (page - 1) * PAGE_SIZE;
      const end = start + PAGE_SIZE - 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabaseExternal.from("devolucoes_svl").select(SVL_COLS, { count: "exact" });
      if (svlsit === "pendentes") q = q.eq("situacao", "1");
      else if (svlsit === "autorizadas") q = q.eq("autorizada", true);
      if (searchText) {
        const esc = searchText.replace(/[,%()]/g, " ").trim();
        if (esc) q = q.or(`numero.ilike.%${esc}%,cliente_nome.ilike.%${esc}%`);
      }
      q = q
        .order("data_emissao", { ascending: false, nullsFirst: false })
        .order("numero", { ascending: false })
        .range(start, end);
      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as unknown as DevSvl[], count: count ?? 0 };
    },
  });
  const rows = listQuery.data?.rows ?? [];
  const total = listQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const statsQuery = useQuery({
    queryKey: ["devolucoes", "svl", "stats"],
    queryFn: async () => {
      const [p, a] = await Promise.all([
        supabaseExternal.from("devolucoes_svl").select("id_nota", { count: "exact", head: true }).eq("situacao", "1"),
        supabaseExternal.from("devolucoes_svl").select("id_nota", { count: "exact", head: true }).eq("autorizada", true),
      ]);
      return { pendentes: p.count ?? 0, autorizadas: a.count ?? 0 };
    },
  });

  async function sincronizar() {
    setSincronizando(true);
    try {
      const { error } = await supabaseExternal.functions.invoke("devolucoes-svl-sync", { body: { dias: 180 } });
      if (error) throw new Error(error.message);
      toast.success("Sincronizado com o Tiny da SVL");
      qc.invalidateQueries({ queryKey: ["devolucoes", "svl"] });
    } catch (e) {
      toast.error("Falha ao sincronizar", { description: (e as Error).message });
    } finally {
      setSincronizando(false);
    }
  }

  async function persistirAutorizada(id_nota: number, chave: string | null, sit: string) {
    await supabaseExternal
      .from("devolucoes_svl")
      .update({ situacao: sit, autorizada: true, chave_devolucao: chave, emitida_via_app: true, atualizado_em: new Date().toISOString() })
      .eq("id_nota", id_nota);
  }

  async function emitir(r: DevSvl) {
    if (
      !window.confirm(
        `Emitir (autorizar na SEFAZ) a devolução ${r.numero}/${r.serie} — SVL?\n\n` +
          `Cliente: ${r.cliente_nome ?? "—"}\nValor: ${r.valor != null ? formatBRL(r.valor) : "—"}\n\n` +
          `⚠️ É DEFINITIVO e irreversível — gera uma NF-e real na SEFAZ.`,
      )
    )
      return;
    setEmitindoId(r.id_nota);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
        body: { modulo: "emitir", conta: "svl", id_nota: r.id_nota, confirmar: "1" },
      });
      if (error) throw new Error(error.message);
      const d = data as { autorizada?: boolean; situacao?: string; motivo?: string; chave_devolucao?: string; numero?: string; serie?: string };
      if (d?.autorizada) {
        await persistirAutorizada(r.id_nota, d.chave_devolucao ?? null, d.situacao ?? "6");
        toast.success(`Devolução ${d.numero}/${d.serie} autorizada na SEFAZ (SVL)`);
        qc.invalidateQueries({ queryKey: ["devolucoes", "svl"] });
      } else {
        toast.warning(`Ainda não autorizou (situação ${d?.situacao ?? "?"})`, { description: d?.motivo || "Tente novamente em instantes." });
      }
    } catch (e) {
      toast.error(`Falha ao emitir a devolução ${r.numero ?? ""}`, { description: (e as Error).message });
    } finally {
      setEmitindoId(null);
    }
  }

  const pendentesNaPagina = rows.filter((r) => r.situacao === "1");
  const selecionadas = rows.filter((r) => sel.has(r.id_nota) && r.situacao === "1");
  const somaSel = selecionadas.reduce((s, i) => s + (Number(i.valor) || 0), 0);
  const todosSelecionados = pendentesNaPagina.length > 0 && pendentesNaPagina.every((r) => sel.has(r.id_nota));

  function toggleTodos() {
    setSel((prev) => {
      const n = new Set(prev);
      if (todosSelecionados) pendentesNaPagina.forEach((r) => n.delete(r.id_nota));
      else pendentesNaPagina.forEach((r) => n.add(r.id_nota));
      return n;
    });
  }
  function toggleUm(id: number) {
    setSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function emitirSelecionadas() {
    const alvo = selecionadas;
    if (!alvo.length) return;
    if (
      !window.confirm(
        `EMITIR ${alvo.length} NF-e de devolução (SVL) na SEFAZ?\n\n` +
          `Valor total: ${formatBRL(somaSel)}\n\n` +
          `⚠️ É DEFINITIVO e irreversível — cada uma vira uma NF-e real autorizada.`,
      )
    )
      return;
    setBulk({ total: alvo.length, feito: 0, ok: 0, falha: 0 });
    let ok = 0, falha = 0;
    for (let i = 0; i < alvo.length; i++) {
      const r = alvo[i];
      try {
        const { data, error } = await supabaseExternal.functions.invoke("nf-devolucao", {
          body: { modulo: "emitir", conta: "svl", id_nota: r.id_nota, confirmar: "1" },
        });
        if (error) throw new Error(error.message);
        const d = data as { autorizada?: boolean; situacao?: string; chave_devolucao?: string };
        if (d?.autorizada) {
          ok++;
          await persistirAutorizada(r.id_nota, d.chave_devolucao ?? null, d.situacao ?? "6");
        } else falha++;
      } catch {
        falha++;
      }
      setBulk({ total: alvo.length, feito: i + 1, ok, falha });
      await sleep(800);
    }
    setBulk(null);
    setSel(new Set());
    toast.success(`Emissão SVL: ${ok} autorizada(s), ${falha} falha(s)`);
    qc.invalidateQueries({ queryKey: ["devolucoes", "svl"] });
  }

  const goToPage = (n: number) => updateSearch({ pagina: Math.max(1, Math.min(totalPages, n)) });
  const loading = listQuery.isLoading;
  const error = (listQuery.error as Error | null)?.message ?? null;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <RotateCcw className="h-6 w-6" /> Devolução de Pedidos
          </h1>
          <EmpresaToggle />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          <strong>SVL Store</strong> — devoluções (série 12) do Tiny de faturamento próprio. Emitir
          autoriza a NF-e na SEFAZ (definitivo).
        </p>
        {statsQuery.data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
              <Clock className="h-3 w-3" /> {statsQuery.data.pendentes} pendentes de emissão
            </span>
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> {statsQuery.data.autorizadas} autorizadas
            </span>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5">
          {([
            { id: "pendentes", label: "Pendentes" },
            { id: "autorizadas", label: "Autorizadas" },
            { id: "todas", label: "Todas" },
          ] as { id: SvlSit; label: string }[]).map((o) => (
            <button
              key={o.id}
              onClick={() => updateSearch({ svlsit: o.id, pagina: 1 })}
              className={cn(
                "px-2.5 py-1 text-xs font-medium rounded-sm transition",
                svlsit === o.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void sincronizar()} disabled={sincronizando}>
          {sincronizando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sincronizar
        </Button>
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Buscar por nº da nota ou cliente..."
            className="pl-8 h-9 bg-card"
          />
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {error}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
          <h3 className="text-sm font-semibold">
            Devoluções SVL <span className="text-muted-foreground font-normal">({total})</span>
          </h3>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-blue-500/50 text-blue-700 dark:text-blue-300 hover:bg-blue-500/10"
            disabled={bulk !== null || selecionadas.length === 0}
            title="Autoriza na SEFAZ as devoluções selecionadas (definitivo)"
            onClick={() => void emitirSelecionadas()}
          >
            {bulk ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Emitir selecionadas ({selecionadas.length}
            {selecionadas.length > 0 ? ` · ${formatBRL(somaSel)}` : ""})
          </Button>
        </div>

        {bulk && (
          <div className="px-4 py-2 border-b bg-muted/40 text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium">Emitindo NF-e… {bulk.feito}/{bulk.total}</span>
              <span className="text-muted-foreground tabular-nums">
                {bulk.ok} ok{bulk.falha > 0 ? ` · ${bulk.falha} falha(s)` : ""}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${bulk.total > 0 ? Math.round((bulk.feito / bulk.total) * 100) : 0}%` }}
              />
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-center font-medium px-3 py-2 w-10">
                  <Checkbox
                    checked={todosSelecionados}
                    disabled={pendentesNaPagina.length === 0 || bulk !== null}
                    onCheckedChange={() => toggleTodos()}
                    aria-label="Selecionar pendentes da página"
                  />
                </th>
                <th className="text-left font-medium px-3 py-2">Nota (nº/série)</th>
                <th className="text-left font-medium px-3 py-2">Cliente</th>
                <th className="text-right font-medium px-3 py-2">Valor</th>
                <th className="text-left font-medium px-3 py-2">Emissão</th>
                <th className="text-center font-medium px-3 py-2">Situação</th>
                <th className="text-center font-medium px-3 py-2 w-40">Ação</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={7} className="px-3 py-3">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhuma devolução nesta visão. Clique em <strong>Sincronizar</strong> para puxar do Tiny da SVL.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const autorizada = r.autorizada === true;
                  const pendente = r.situacao === "1";
                  return (
                    <tr
                      key={r.id_nota}
                      className={cn("border-t hover:bg-accent/40 transition", autorizada && "opacity-60", pendente && sel.has(r.id_nota) && "bg-blue-500/5")}
                    >
                      <td className="px-3 py-2 text-center">
                        <Checkbox
                          checked={sel.has(r.id_nota)}
                          disabled={!pendente || bulk !== null}
                          onCheckedChange={() => toggleUm(r.id_nota)}
                          aria-label="Selecionar"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                        {r.numero ?? "—"}/{r.serie ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[280px] truncate">{r.cliente_nome ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.valor != null ? formatBRL(r.valor) : "—"}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                        {r.data_emissao ? format(parseISO(r.data_emissao), "dd/MM/yyyy") : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {autorizada ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Autorizada
                          </Badge>
                        ) : pendente ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-blue-500/40 text-blue-700 dark:text-blue-300 gap-1">
                            <Clock className="h-3 w-3" /> Pendente
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">sit. {r.situacao ?? "?"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {autorizada ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1.5 text-xs border-blue-500/50 text-blue-700 dark:text-blue-300 hover:bg-blue-500/10"
                            disabled={emitindoId !== null || bulk !== null || !pendente}
                            title="Autoriza a NF de devolução na SEFAZ — definitivo."
                            onClick={() => void emitir(r)}
                          >
                            {emitindoId === r.id_nota ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                            Emitir NF
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
            <span className="text-muted-foreground">
              Página {page} de {totalPages} · {total} devoluções
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ExternalLink className="h-3 w-3" />
        Emissão no ambiente/certificado da SVL. Selecione as devoluções e emita em massa (confirmação
        única com valor total) ou uma a uma.
      </p>
    </div>
  );
}
