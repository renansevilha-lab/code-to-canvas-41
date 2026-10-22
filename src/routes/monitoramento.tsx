import { createFileRoute } from "@tanstack/react-router";
import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Hourglass, Loader2, PackageX, SearchX, Weight,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  FAIXAS_PRAZO, PRAZO_ESTILO, diasAtePrazo, extrairPeso, faixaPrazo, fmtPrazoData, nivelPrazo,
} from "@/lib/prazo";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";
import { rotuloCanal } from "@/lib/canais";

// ============================================================================
// Monitoramento de Lotes de Separação — painel de bancada ao vivo.
// Gêmeo digital da etiqueta identificadora física. Escopo: hoje, Shopee,
// single-SKU (MULTI SKU só no totalizador). Backend pronto:
//   view_monitoramento_totais (funil) · view_monitoramento_lotes (cards) ·
//   RPC monitoramento_finalizar_tag(p_tag, p_desfazer).
// Import do design "Monitoramento de Lotes.dc.html" (Claude Design).
// ============================================================================

interface Totais {
  a_separar_pedidos: number | string;
  a_separar_unidades: number | string;
  em_lote_lotes: number | string;
  em_lote_pedidos: number | string;
  em_lote_unidades: number | string;
  na_tela_lotes: number | string;
  na_tela_pedidos: number | string;
  na_tela_unidades: number | string;
  finalizadas_lotes: number | string;
  finalizadas_pedidos: number | string;
  finalizadas_unidades: number | string;
  multi_pedidos: number | string;
  multi_unidades: number | string;
}

interface Lote {
  tag: string;
  sku: string | null;
  tipo_envio: string | null;
  grupo_origem: string | null;
  produto_nome: string | null;
  foto: string | null;
  unidades_por_pedido: number | string;
  qtd_pedidos: number | string;
  total_unidades: number | string;
  etiquetas_impressas: number | string;
  etiquetas_confirmadas: number | string;
  sequencia: number | string;
  /** prazo de despacho MAIS PRÓXIMO entre os pedidos da TAG (min ship_by_date) */
  prazo: string | null;
  pedidos_com_prazo: number | string | null;
}

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// Pedidos de uma TAG (expansão do card) — mesma leitura da aba Separação.
//
// A fonte é `separacao_tiny`, NÃO `view_separacao_pedidos`: a view só devolve
// situação 1 (aguardando), e aqui os lotes já foram separados/embalados
// (situação 2 e 3). Ler a view perderia justamente os pedidos deste painel —
// é a armadilha da seção 5 do CLAUDE.md, a mesma que já quebrou a impressão
// de etiquetas por lote uma vez.
// ---------------------------------------------------------------------------

type EstadoImpressao = "done" | "forcado" | "sent" | "error" | "ausente";

// Um pedido pode ter mais de uma linha em impressao_etiquetas (retentativa,
// forçado): vale o estado mais avançado.
function rankEstado(e: EstadoImpressao): number {
  return e === "done" ? 4 : e === "forcado" ? 3 : e === "sent" ? 2 : e === "error" ? 1 : 0;
}

interface PedidoDaTag {
  separacao_id: number | null;
  numero_ecommerce: string | null;
  marca_canal: string | null;
  situacao: number | null;
  qtd_unidades: number | string | null;
  estado: EstadoImpressao;
}

const SITUACAO_LABEL: Record<number, string> = {
  1: "aguardando",
  2: "em separação",
  3: "embalada",
  9: "concluída",
};
const fmt = (x: unknown): string => num(x).toLocaleString("pt-BR");

/** Lista os pedidos de uma TAG com o estado de impressão de cada um. */
function PedidosDaTag({ tag }: { tag: string }) {
  const q = useQuery({
    queryKey: ["monitoramento", "pedidos-tag", tag],
    queryFn: async (): Promise<PedidoDaTag[]> => {
      const { data: seps, error } = await supabaseExternal
        .from("separacao_tiny")
        .select("separacao_id, numero_ecommerce, marca_canal, situacao, qtd_unidades")
        .eq("tag_lote", tag)
        .order("numero_ecommerce");
      if (error) throw error;

      const linhas = (seps ?? []) as Omit<PedidoDaTag, "estado">[];
      const ids = linhas.map((l) => l.separacao_id).filter((n): n is number => n != null);

      const porSep = new Map<number, EstadoImpressao>();
      if (ids.length > 0) {
        const { data: imps, error: e2 } = await supabaseExternal
          .from("impressao_etiquetas")
          .select("separacao_id, estado")
          .in("separacao_id", ids);
        if (e2) throw e2;
        for (const r of (imps ?? []) as { separacao_id: number; estado: string }[]) {
          const est = (r.estado as EstadoImpressao) ?? "ausente";
          const atual = porSep.get(r.separacao_id) ?? "ausente";
          if (rankEstado(est) > rankEstado(atual)) porSep.set(r.separacao_id, est);
        }
      }

      return linhas.map((l) => ({
        ...l,
        estado: l.separacao_id != null ? (porSep.get(l.separacao_id) ?? "ausente") : "ausente",
      }));
    },
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando pedidos…
      </div>
    );
  }
  if (q.error) {
    return <div className="py-3 text-sm text-destructive">{(q.error as Error).message}</div>;
  }

  const pedidos = q.data ?? [];
  const impressos = pedidos.filter((p) => p.estado === "done" || p.estado === "forcado").length;
  const pendentes = pedidos.length - impressos;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">{pedidos.length} pedidos</span>
        <span className="text-emerald-700 dark:text-emerald-400">{impressos} impressos</span>
        {pendentes > 0 && (
          <span className="text-amber-700 dark:text-amber-400">{pendentes} sem impressão</span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase text-muted-foreground border-b">
              <th className="py-1.5 pr-2 font-medium">Pedido</th>
              <th className="py-1.5 pr-2 font-medium">Canal</th>
              <th className="py-1.5 pr-2 font-medium">Situação</th>
              <th className="py-1.5 pr-2 font-medium text-right">Un.</th>
              <th className="py-1.5 font-medium">Impressão</th>
            </tr>
          </thead>
          <tbody>
            {pedidos.map((p) => (
              <tr key={p.separacao_id ?? p.numero_ecommerce} className="border-b last:border-0">
                <td className="py-1.5 pr-2 font-mono">{p.numero_ecommerce ?? "—"}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">{rotuloCanal(p.marca_canal)}</td>
                <td className="py-1.5 pr-2 text-muted-foreground">
                  {SITUACAO_LABEL[p.situacao ?? 0] ?? p.situacao ?? "—"}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{num(p.qtd_unidades)}</td>
                <td className="py-1.5">
                  <SeloImpressao estado={p.estado} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Mesmos rótulos e cores da aba Separação, para não criar dialeto novo. */
function SeloImpressao({ estado }: { estado: EstadoImpressao }) {
  if (estado === "done" || estado === "forcado") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300">
        <Check className="h-2.5 w-2.5" /> {estado === "done" ? "impresso" : "forçado"}
      </span>
    );
  }
  if (estado === "sent") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <Hourglass className="h-2.5 w-2.5" /> aguardando
      </span>
    );
  }
  if (estado === "error") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300">
        <AlertTriangle className="h-2.5 w-2.5" /> erro
      </span>
    );
  }
  return <span className="text-[10px] text-muted-foreground">sem impressão</span>;
}

function iniciais(nome: string | null): string {
  return (nome ?? "?")
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase() || "?";
}

// Cor por quantidade de unidades por pedido — MESMA escala fixa da Separação
// (ajuda a bancada a não confundir quantidades). 1=neutro, 2=azul, 3=âmbar,
// 4=fúcsia, 5=esmeralda, 6+=vermelho.
function corUnidades(n: number): string {
  switch (Number(n) || 1) {
    case 1: return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";
    case 2: return "bg-blue-500 text-white";
    case 3: return "bg-amber-500 text-white";
    case 4: return "bg-fuchsia-600 text-white";
    case 5: return "bg-emerald-600 text-white";
    default: return "bg-red-600 text-white";
  }
}

// Cores por tipo de envio (do design). Funcionam em tema claro/escuro.
const TIPO_STYLE: Record<string, { bg: string; fg: string }> = {
  ER: { bg: "#3FA9F5", fg: "#04263F" },
  SPX: { bg: "#FF6A39", fg: "#3A0F00" },
  ML: { bg: "#FFD400", fg: "#3A2E00" },
};
function tipoStyle(t: string | null) {
  return TIPO_STYLE[(t ?? "").toUpperCase()] ?? TIPO_STYLE.ER;
}

// Selo do prazo de despacho — mesmos rótulos e cores da aba Separação.
function PrazoBadge({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const dias = diasAtePrazo(iso);
  const nivel = nivelPrazo(dias);
  if (!iso || nivel === null) {
    return <span className={cn("text-[10px] text-muted-foreground", className)}>sem prazo</span>;
  }
  const rotulo =
    nivel === "vencido" ? `Vencido · ${fmtPrazoData(iso)}`
    : nivel === "hoje" ? `Hoje · ${fmtPrazoData(iso)}`
    : nivel === "amanha" ? `Amanhã · ${fmtPrazoData(iso)}`
    : fmtPrazoData(iso);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums whitespace-nowrap",
        PRAZO_ESTILO[nivel],
        className,
      )}
      title={`Prazo de despacho mais próximo da TAG: ${new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`}
    >
      {(nivel === "vencido" || nivel === "hoje") && <AlertTriangle className="h-3 w-3" />}
      {rotulo}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PESO em destaque. Produtos que só diferem no peso ("Areia ... 4kg" × "10kg")
// têm foto e nome quase iguais — na bancada isso vira troca de produto. O peso
// sai do NOME (não há coluna de peso no cadastro) e ganha um selo grande ao
// lado da foto; no nome, o trecho do peso fica marcado.
// ---------------------------------------------------------------------------
function PesoDestaque({ nome }: { nome: string | null }) {
  const peso = extrairPeso(nome);
  if (!peso) {
    return (
      <div
        className="w-[72px] h-[72px] rounded-[14px] shrink-0 flex flex-col items-center justify-center border border-dashed text-muted-foreground"
        title="Peso não identificado no nome do produto"
      >
        <Weight className="h-5 w-5" />
        <span className="text-[9px] font-semibold uppercase mt-1">s/ peso</span>
      </div>
    );
  }
  const grande = peso.valor.length + peso.unidade.length > 5;
  return (
    <div
      className="w-[72px] h-[72px] rounded-[14px] shrink-0 flex flex-col items-center justify-center bg-violet-600 text-white shadow-sm"
      title={`Peso/volume lido do nome: ${peso.rotulo}`}
    >
      <span className={cn("font-black leading-none tabular-nums", grande ? "text-[20px]" : "text-[26px]")}>{peso.valor}</span>
      <span className="text-[13px] font-extrabold uppercase leading-none mt-1">{peso.unidade}</span>
    </div>
  );
}

function NomeComPeso({ nome }: { nome: string | null }) {
  const peso = extrairPeso(nome);
  if (!nome) return <>—</>;
  if (!peso) return <>{nome}</>;
  return (
    <>
      {nome.slice(0, peso.inicio)}
      <mark className="rounded px-1 bg-violet-200 text-violet-950 font-extrabold dark:bg-violet-700 dark:text-white">
        {nome.slice(peso.inicio, peso.fim)}
      </mark>
      {nome.slice(peso.fim)}
    </>
  );
}

function FotoProduto({ url, nome, tipo }: { url: string | null; nome: string | null; tipo: string | null }) {
  const [erro, setErro] = useState(false);
  const ts = tipoStyle(tipo);
  const mostrarImg = !!url && !erro;
  return (
    <div
      className="w-[72px] h-[72px] rounded-[14px] shrink-0 overflow-hidden flex items-center justify-center"
      style={{ background: `${ts.bg}22`, color: ts.bg }}
    >
      {mostrarImg ? (
        <img src={url!} alt={nome ?? ""} loading="lazy" className="w-full h-full object-cover" onError={() => setErro(true)} />
      ) : (
        <span className="text-xl font-extrabold">{iniciais(nome)}</span>
      )}
    </div>
  );
}

function MonitoramentoAntigo() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [finalizando, setFinalizando] = useState<string | null>(null);
  // TAGs abertas — a lista de pedidos só é buscada quando a TAG expande.
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());
  const alternarTag = (tag: string) =>
    setExpandidas((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(tag)) proximo.delete(tag);
      else proximo.add(tag);
      return proximo;
    });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const totaisQ = useQuery({
    queryKey: ["monitoramento", "totais"],
    queryFn: async (): Promise<Totais | null> => {
      const { data, error } = await supabaseExternal.from("view_monitoramento_totais").select("*").maybeSingle();
      if (error) throw error;
      return (data ?? null) as Totais | null;
    },
    refetchInterval: 20000,
  });

  const lotesQ = useQuery({
    queryKey: ["monitoramento", "lotes"],
    queryFn: async (): Promise<Lote[]> => {
      const { data, error } = await supabaseExternal.from("view_monitoramento_lotes").select("*");
      if (error) throw error;
      return (data ?? []) as Lote[];
    },
    refetchInterval: 20000,
  });

  const totais = totaisQ.data ?? null;
  const todosLotes = lotesQ.data ?? [];

  // ---- Filtros: modo de envio (ER/SPX/ML) e faixa de prazo (multi-seleção;
  // vazio = todos). Só no estado da tela: o painel fica aberto na bancada.
  const [tipoFiltro, setTipoFiltro] = useState<string[]>([]);
  const [prazoFiltro, setPrazoFiltro] = useState<string[]>([]);
  const tiposDisponiveis = useMemo(() => {
    const set = new Map<string, number>();
    for (const l of todosLotes) {
      const t = (l.tipo_envio ?? "—").toUpperCase();
      set.set(t, (set.get(t) ?? 0) + 1);
    }
    return Array.from(set.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [todosLotes]);
  const lotes = useMemo(() => {
    return todosLotes.filter((l) => {
      if (tipoFiltro.length > 0 && !tipoFiltro.includes((l.tipo_envio ?? "—").toUpperCase())) return false;
      if (prazoFiltro.length > 0 && !prazoFiltro.includes(faixaPrazo(diasAtePrazo(l.prazo)))) return false;
      return true;
    });
  }, [todosLotes, tipoFiltro, prazoFiltro]);
  const filtrando = tipoFiltro.length > 0 || prazoFiltro.length > 0;

  // Funil do dia (ordem do fluxo). Cores de acento do design.
  const funil = [
    { label: "A separar", accent: "#64748B", pedidos: totais?.a_separar_pedidos, unidades: totais?.a_separar_unidades },
    { label: "Em lote (aguardando etiqueta)", accent: "#B7791F", pedidos: totais?.em_lote_pedidos, unidades: totais?.em_lote_unidades },
    { label: "Na tela / etiqueta impressa", accent: "#2F6FB0", pedidos: totais?.na_tela_pedidos, unidades: totais?.na_tela_unidades },
    { label: "Finalizadas", accent: "#0E8A5F", pedidos: totais?.finalizadas_pedidos, unidades: totais?.finalizadas_unidades },
  ];

  async function finalizar(tag: string) {
    if (finalizando) return;
    setFinalizando(tag);
    const prevLotes = qc.getQueryData<Lote[]>(["monitoramento", "lotes"]);
    const prevTotais = qc.getQueryData<Totais>(["monitoramento", "totais"]);
    const card = (prevLotes ?? []).find((c) => c.tag === tag);
    // Update otimista: some o card + ajusta o funil na hora.
    qc.setQueryData<Lote[]>(["monitoramento", "lotes"], (old) => (old ?? []).filter((c) => c.tag !== tag));
    if (card) {
      qc.setQueryData<Totais>(["monitoramento", "totais"], (old) => {
        if (!old) return old;
        const p = num(card.qtd_pedidos);
        const u = num(card.total_unidades);
        return {
          ...old,
          na_tela_lotes: num(old.na_tela_lotes) - 1,
          na_tela_pedidos: num(old.na_tela_pedidos) - p,
          na_tela_unidades: num(old.na_tela_unidades) - u,
          finalizadas_lotes: num(old.finalizadas_lotes) + 1,
          finalizadas_pedidos: num(old.finalizadas_pedidos) + p,
          finalizadas_unidades: num(old.finalizadas_unidades) + u,
        };
      });
    }
    // p_por: quem finaliza a TAG é creditado como separador/embalador do lote
    // (tags_lote.finalizada_por) — decisão do dono em 19/set/2026.
    const { error } = await supabaseExternal.rpc("monitoramento_finalizar_tag", {
      p_tag: tag,
      p_desfazer: false,
      p_por: perfil?.nome ?? null,
    });
    if (error) {
      qc.setQueryData(["monitoramento", "lotes"], prevLotes);
      qc.setQueryData(["monitoramento", "totais"], prevTotais);
      toast.error(`Falha ao finalizar a TAG ${tag}`, { description: error.message });
    } else {
      void registrarSeparacaoLog({
        evento: "tag_finalizada", usuario: perfil?.nome ?? null, tag,
        detalhe: card
          ? { qtd_pedidos: num(card.qtd_pedidos), total_unidades: num(card.total_unidades), sku: card.sku }
          : null,
      });
      toast.success(`TAG ${tag} finalizada`, {
        description: "Saiu do painel — só monitoramento, não muda nada no Tiny.",
      });
      void qc.invalidateQueries({ queryKey: ["monitoramento"] });
    }
    setFinalizando(null);
  }

  const clock = new Date(nowMs).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateLabel = new Date(nowMs).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  const secs = Math.max(0, Math.floor((nowMs - (lotesQ.dataUpdatedAt || nowMs)) / 1000));
  const agoLabel = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}min`;

  const carregando = totaisQ.isLoading || lotesQ.isLoading;
  const semLotes = !carregando && todosLotes.length === 0;
  const semResultado = !carregando && todosLotes.length > 0 && lotes.length === 0;

  return (
    <div className="flex flex-col gap-5 p-1">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-5 flex-wrap">
        <div className="flex flex-col gap-1.5 min-w-[280px] flex-1">
          <h1 className="text-xl font-extrabold tracking-tight leading-tight">Monitoramento de Lotes de Separação</h1>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            Painel ao vivo · atualizado há {agoLabel}
          </div>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-2xl font-bold font-mono tabular-nums tracking-tight">{clock}</span>
          <span className="text-xs text-muted-foreground capitalize">{dateLabel}</span>
        </div>
      </div>

      {/* Funil */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {funil.map((f) => (
          <Card key={f.label} className="relative overflow-hidden p-4 flex flex-col gap-2.5">
            <span className="absolute left-0 top-0 bottom-0 w-1" style={{ background: f.accent }} />
            <span className="text-xs font-semibold text-muted-foreground">{f.label}</span>
            <span className="text-4xl font-extrabold tabular-nums leading-none">{fmt(f.pedidos)}</span>
            <span className="text-xs text-muted-foreground font-mono">{fmt(f.unidades)} unidades</span>
          </Card>
        ))}
        <Card className="p-4 flex flex-col gap-2.5 border-dashed opacity-70">
          <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Multi SKU (fora do sistema)</span>
          <span className="text-3xl font-extrabold tabular-nums leading-none text-muted-foreground">{fmt(totais?.multi_pedidos)}</span>
          <span className="text-[11px] text-muted-foreground font-mono">{fmt(totais?.multi_unidades)} un · separação manual</span>
        </Card>
      </div>

      {/* Sub-título + filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Lotes na tela</span>
        <span className="text-sm text-muted-foreground">
          · {filtrando ? `${lotes.length} de ${todosLotes.length}` : todosLotes.length} etiquetas impressas aguardando bipagem
        </span>
        <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
          {/* Modo de envio: clique = alterna a faixa; vazio = todos */}
          {tiposDisponiveis.map(([t, n]) => {
            const ts = tipoStyle(t);
            const ativo = tipoFiltro.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() =>
                  setTipoFiltro((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
                }
                className={cn(
                  "text-[12px] font-extrabold tracking-wide px-2.5 py-1 rounded-[8px] border-2 transition-opacity",
                  !ativo && tipoFiltro.length > 0 && "opacity-40",
                )}
                style={{ background: ts.bg, color: ts.fg, borderColor: ativo ? ts.fg : "transparent" }}
                title={ativo ? `Só ${t} — clique para tirar do filtro` : `Filtrar por ${t}`}
              >
                {t} <span className="font-mono font-semibold opacity-80">{n}</span>
              </button>
            );
          })}
          {tipoFiltro.length > 0 && (
            <button
              type="button"
              onClick={() => setTipoFiltro([])}
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline px-1"
            >
              todos os envios
            </button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn("h-8 min-w-[150px] justify-start text-xs bg-card font-normal", prazoFiltro.length > 0 && "border-primary text-primary font-medium")}
                title="Filtra os lotes pelo prazo de despacho mais próximo da TAG — pode marcar mais de uma faixa"
              >
                <Hourglass className="h-3.5 w-3.5 mr-1 shrink-0" />
                {prazoFiltro.length === 0
                  ? "Prazo: todos"
                  : FAIXAS_PRAZO.filter((f) => prazoFiltro.includes(f.id)).map((f) => f.curto).join(" + ")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuCheckboxItem
                checked={prazoFiltro.length === 0}
                onCheckedChange={() => setPrazoFiltro([])}
                onSelect={(e) => e.preventDefault()}
              >
                Todos os prazos
              </DropdownMenuCheckboxItem>
              {FAIXAS_PRAZO.map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.id}
                  checked={prazoFiltro.includes(f.id)}
                  onCheckedChange={(on) =>
                    setPrazoFiltro((prev) => (on ? [...prev, f.id] : prev.filter((x) => x !== f.id)))
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {f.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {carregando && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando painel…
        </div>
      )}

      {semLotes && (
        <Card className="border-dashed py-16 px-10 flex flex-col items-center gap-3 text-center">
          <PackageX className="h-9 w-9 text-muted-foreground" />
          <span className="text-lg font-bold">Nenhum lote na tela — tudo finalizado 🎉</span>
          <span className="text-sm text-muted-foreground">Novos lotes aparecem aqui assim que a etiqueta for impressa.</span>
        </Card>
      )}

      {semResultado && (
        <Card className="border-dashed py-12 px-10 flex flex-col items-center gap-3 text-center">
          <SearchX className="h-8 w-8 text-muted-foreground" />
          <span className="text-base font-bold">Nenhum lote nesse filtro</span>
          <span className="text-sm text-muted-foreground">
            {todosLotes.length} lote(s) na tela ficaram de fora do filtro de envio/prazo.
          </span>
          <button
            type="button"
            onClick={() => { setTipoFiltro([]); setPrazoFiltro([]); }}
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            Limpar filtros
          </button>
        </Card>
      )}

      {!carregando && lotes.length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
          {lotes.map((c) => {
            const ts = tipoStyle(c.tipo_envio);
            const ped = num(c.qtd_pedidos);
            const imp = num(c.etiquetas_impressas);
            const conf = num(c.etiquetas_confirmadas);
            const printW = ped > 0 ? Math.min(100, (imp / ped) * 100) : 0;
            const confirmW = ped > 0 ? Math.min(100, (conf / ped) * 100) : 0;
            const completo = imp >= ped;
            const progColor = completo ? "#0E8A5F" : "#B7791F";
            const saindo = finalizando === c.tag;
            const expandida = expandidas.has(c.tag);
            return (
              <Card
                key={c.tag}
                className={cn(
                  "p-5 flex flex-col gap-3.5 border-[1.5px] transition-all duration-300",
                  saindo && "opacity-40 scale-[0.97]",
                )}
                // Expandida ocupa a linha toda: a tabela de pedidos não cabe
                // na coluna de 300px do grid.
                style={expandida ? { gridColumn: "1 / -1" } : undefined}
              >
                {/* TAG + tipo — clicar na TAG abre a lista de pedidos */}
                <div className="flex items-center justify-between gap-2.5">
                  <button
                    onClick={() => alternarTag(c.tag)}
                    className="flex items-center gap-1.5 text-left hover:opacity-70 transition-opacity"
                    title={expandida ? "Recolher pedidos" : "Ver pedidos da TAG"}
                  >
                    {expandida ? (
                      <ChevronDown className="h-5 w-5 shrink-0" />
                    ) : (
                      <ChevronRight className="h-5 w-5 shrink-0" />
                    )}
                    <span className="text-3xl font-extrabold tracking-tight font-mono">{c.tag}</span>
                  </button>
                  <div className="flex items-center gap-2">
                    <PrazoBadge iso={c.prazo} />
                    <span
                      className="text-[13px] font-extrabold tracking-wide px-3 py-1.5 rounded-[9px]"
                      style={{ background: ts.bg, color: ts.fg }}
                    >
                      {(c.tipo_envio ?? "—").toUpperCase()}
                    </span>
                  </div>
                </div>

                {/* Foto + produto */}
                <div className="flex gap-3 items-center">
                  <FotoProduto url={c.foto} nome={c.produto_nome} tipo={c.tipo_envio} />
                  <PesoDestaque nome={c.produto_nome} />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium leading-snug line-clamp-3">
                      <NomeComPeso nome={c.produto_nome} />
                    </span>
                    <span className="text-[11px] text-muted-foreground font-mono">SKU {c.sku ?? "—"}</span>
                  </div>
                </div>

                {/* Números */}
                <div className="flex items-center gap-3.5 bg-muted/60 rounded-[14px] p-3">
                  <div
                    className={cn(
                      "w-[66px] h-[66px] rounded-[15px] shrink-0 flex flex-col items-center justify-center",
                      corUnidades(num(c.unidades_por_pedido)),
                    )}
                    title={`${num(c.unidades_por_pedido)} unidade(s) por pedido`}
                  >
                    <span className="text-[27px] font-extrabold leading-none tabular-nums">{num(c.unidades_por_pedido)}</span>
                    <span className="text-[9px] font-bold uppercase tracking-wide opacity-90">un/ped</span>
                  </div>
                  <div className="w-px self-stretch bg-border" />
                  <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-base font-extrabold tabular-nums">{fmt(c.qtd_pedidos)}</span>
                      <span className="text-[11px] text-muted-foreground">pedidos no lote</span>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-base font-extrabold tabular-nums">{fmt(c.total_unidades)}</span>
                      <span className="text-[11px] text-muted-foreground">unidades totais</span>
                    </div>
                  </div>
                </div>

                {/* Etiquetas */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">Etiquetas</span>
                    <span className="text-[12px] font-bold font-mono" style={{ color: progColor }}>
                      {imp}/{ped} impressas · {conf} confirmadas
                    </span>
                  </div>
                  <div className="h-2 rounded bg-muted relative overflow-hidden">
                    <div className="h-full rounded absolute left-0 top-0 bg-primary" style={{ width: `${confirmW}%` }} />
                    <div className="h-full rounded absolute left-0 top-0" style={{ width: `${printW}%`, background: progColor, opacity: 0.35 }} />
                  </div>
                </div>

                {/* Pedidos da TAG (carrega só quando abre) */}
                {expandida && (
                  <div className="border-t pt-3">
                    <PedidosDaTag tag={c.tag} />
                  </div>
                )}

                {/* Finalizar */}
                <button
                  onClick={() => void finalizar(c.tag)}
                  disabled={saindo}
                  className="border-0 cursor-pointer text-sm font-bold py-3 rounded-xl bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {saindo ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Finalizar TAG
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// VISUAL NOVO (design "Separação · Monitoramento da bancada", 22/out/2026).
// Mesmas leituras e o mesmo RPC de finalizar; muda a apresentação, entra o
// "Finalizando como" (crédito da TAG de quem está na bancada, não do login
// compartilhado) e um "Desfazer" de 8 s logo depois de finalizar.
// O visual antigo (MonitoramentoAntigo) fica de reserva se este quebrar.
// ============================================================================

const STORAGE_QUEM = "monitoramento.quem";
const MONO_M = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" } as const;

/** Peso por PEDIDO lido do nome (peso da embalagem × un por pedido). */
function pesoPorPedido(nome: string | null, un: number): { txt: string; pesado: boolean | null } | null {
  const p = extrairPeso(nome);
  if (!p) return null;
  const v = Number(String(p.valor).replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const u = p.unidade.toLowerCase();
  const fmtN = (x: number) => (Math.round(x * 100) / 100).toLocaleString("pt-BR");
  if (u === "kg" || u === "g") {
    const kg = (u === "g" ? v / 1000 : v) * un;
    return { txt: `${fmtN(kg)} kg`, pesado: kg > 4 };
  }
  const l = (u === "ml" ? v / 1000 : v) * un;
  return { txt: `${fmtN(l)} l`, pesado: null };
}

function corUn(n: number): { bg: string; fg: string } {
  switch (n) {
    case 1: return { bg: "var(--pm-s2)", fg: "var(--pm-t)" };
    case 2: return { bg: "#3b82f6", fg: "#fff" };
    case 3: return { bg: "#f59e0b", fg: "#fff" };
    case 4: return { bg: "#c026d3", fg: "#fff" };
    case 5: return { bg: "#059669", fg: "#fff" };
    default: return { bg: "#dc2626", fg: "#fff" };
  }
}

function FotoM({ url, nome }: { url: string | null; nome: string | null }) {
  const [erro, setErro] = useState(false);
  const caixa = { width: 56, height: 56, flex: "none" as const, borderRadius: 10, border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" };
  if (!url || erro) return <span style={{ ...caixa, background: "var(--pm-s2)", fontSize: 13, fontWeight: 600, color: "var(--pm-t3)" }}>{iniciais(nome)}</span>;
  return <span style={{ ...caixa, background: "#fff" }}><img src={url} alt={nome ?? ""} loading="lazy" onError={() => setErro(true)} style={{ width: "100%", height: "100%", objectFit: "contain" }} /></span>;
}

interface Recente { lote: Lote; por: string; ate: number }

function MonitoramentoNovo() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const raiz = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 1000); return () => clearInterval(t); }, []);

  const equipeQ = useQuery({
    queryKey: ["separacao", "equipe"],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("equipe_membros").select("nome").eq("ativo", true).order("ordem");
      if (error) throw error;
      return ((data ?? []) as { nome: string }[]).map((r) => r.nome);
    },
  });
  const [quem, setQuem] = useState<string>(() => { try { return localStorage.getItem(STORAGE_QUEM) ?? ""; } catch { return ""; } });
  const quemEfetivo = quem || perfil?.nome || "";
  useEffect(() => { try { if (quem) localStorage.setItem(STORAGE_QUEM, quem); } catch { /* noop */ } }, [quem]);
  const equipe = [...new Set([...(equipeQ.data ?? []), ...(perfil?.nome ? [perfil.nome] : []), ...(quem ? [quem] : [])])];

  const totaisQ = useQuery({
    queryKey: ["monitoramento", "totais"],
    queryFn: async (): Promise<Totais | null> => {
      const { data, error } = await supabaseExternal.from("view_monitoramento_totais").select("*").maybeSingle();
      if (error) throw error;
      return (data ?? null) as Totais | null;
    },
    refetchInterval: 20000,
  });
  const lotesQ = useQuery({
    queryKey: ["monitoramento", "lotes"],
    queryFn: async (): Promise<Lote[]> => {
      const { data, error } = await supabaseExternal.from("view_monitoramento_lotes").select("*");
      if (error) throw error;
      return (data ?? []) as Lote[];
    },
    refetchInterval: 20000,
  });
  const totais = totaisQ.data ?? null;
  const todosLotes = lotesQ.data ?? [];

  const [tipoFiltro, setTipoFiltro] = useState<string | null>(null);
  const [prazoFiltro, setPrazoFiltro] = useState<string[]>([]);
  const [expandidas, setExpandidas] = useState<Set<string>>(new Set());
  const [finalizando, setFinalizando] = useState<string | null>(null);
  const [recentes, setRecentes] = useState<Record<string, Recente>>({});

  // some o "Desfazer" depois de 8 s
  useEffect(() => {
    const vencidos = Object.entries(recentes).filter(([, r]) => r.ate <= nowMs).map(([t]) => t);
    if (vencidos.length) setRecentes((cur) => { const n = { ...cur }; for (const t of vencidos) delete n[t]; return n; });
  }, [nowMs, recentes]);

  const tipos = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of todosLotes) { const t = (l.tipo_envio ?? "—").toUpperCase(); m.set(t, (m.get(t) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [todosLotes]);
  const passa = (l: Lote) =>
    (!tipoFiltro || (l.tipo_envio ?? "—").toUpperCase() === tipoFiltro) &&
    (prazoFiltro.length === 0 || prazoFiltro.includes(faixaPrazo(diasAtePrazo(l.prazo))));
  const visiveis = [
    ...Object.values(recentes).filter((r) => !todosLotes.some((l) => l.tag === r.lote.tag)).map((r) => r.lote),
    ...todosLotes,
  ].filter(passa).sort((a, b) => num(a.sequencia) - num(b.sequencia));

  async function finalizar(lote: Lote) {
    if (finalizando || !quemEfetivo) { if (!quemEfetivo) toast.warning("Escolha quem está finalizando"); return; }
    setFinalizando(lote.tag);
    const prevLotes = qc.getQueryData<Lote[]>(["monitoramento", "lotes"]);
    const prevTotais = qc.getQueryData<Totais>(["monitoramento", "totais"]);
    const p = num(lote.qtd_pedidos), u = num(lote.total_unidades);
    qc.setQueryData<Lote[]>(["monitoramento", "lotes"], (old) => (old ?? []).filter((c) => c.tag !== lote.tag));
    qc.setQueryData<Totais>(["monitoramento", "totais"], (old) => old ? {
      ...old,
      na_tela_lotes: num(old.na_tela_lotes) - 1, na_tela_pedidos: num(old.na_tela_pedidos) - p, na_tela_unidades: num(old.na_tela_unidades) - u,
      finalizadas_lotes: num(old.finalizadas_lotes) + 1, finalizadas_pedidos: num(old.finalizadas_pedidos) + p, finalizadas_unidades: num(old.finalizadas_unidades) + u,
    } : old);
    const { error } = await supabaseExternal.rpc("monitoramento_finalizar_tag", { p_tag: lote.tag, p_desfazer: false, p_por: quemEfetivo });
    if (error) {
      qc.setQueryData(["monitoramento", "lotes"], prevLotes);
      qc.setQueryData(["monitoramento", "totais"], prevTotais);
      toast.error(`Falha ao finalizar a TAG ${lote.tag}`, { description: error.message });
    } else {
      setRecentes((cur) => ({ ...cur, [lote.tag]: { lote, por: quemEfetivo, ate: Date.now() + 8000 } }));
      void registrarSeparacaoLog({
        evento: "tag_finalizada", usuario: quemEfetivo, tag: lote.tag,
        detalhe: { qtd_pedidos: p, total_unidades: u, sku: lote.sku, login: perfil?.nome ?? null },
      });
      void qc.invalidateQueries({ queryKey: ["monitoramento"] });
    }
    setFinalizando(null);
  }

  async function desfazer(tag: string) {
    const r = recentes[tag];
    setRecentes((cur) => { const n = { ...cur }; delete n[tag]; return n; });
    const { error } = await supabaseExternal.rpc("monitoramento_finalizar_tag", { p_tag: tag, p_desfazer: true, p_por: null });
    if (error) {
      toast.error(`Não deu para desfazer a TAG ${tag}`, { description: error.message });
      if (r) setRecentes((cur) => ({ ...cur, [tag]: r }));
      return;
    }
    toast.success(`TAG ${tag} voltou para a tela`);
    void qc.invalidateQueries({ queryKey: ["monitoramento"] });
  }

  const relogio = new Date(nowMs).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  const idadeS = Math.max(0, Math.floor((nowMs - (lotesQ.dataUpdatedAt || nowMs)) / 1000));
  const prox = Math.max(0, 20 - idadeS);
  const funil = [
    { label: "A separar", n: totais?.a_separar_pedidos, sub: `pedidos · ${fmt(totais?.a_separar_unidades)} un · ${fmt(totais?.multi_pedidos)} multi SKU à parte`, cor: "var(--pm-t)" },
    { label: "Em lote, aguardando etiqueta", n: totais?.em_lote_pedidos, sub: `pedidos · ${fmt(totais?.em_lote_lotes)} TAGs`, cor: "var(--pm-am)" },
    { label: "Na tela · etiqueta impressa", n: totais?.na_tela_pedidos, sub: `pedidos · ${fmt(totais?.na_tela_lotes)} TAGs`, cor: "var(--pm-at)" },
    { label: "Finalizadas hoje", n: totais?.finalizadas_pedidos, sub: `pedidos · ${fmt(totais?.finalizadas_lotes)} TAGs`, cor: "var(--pm-g)" },
  ];
  const corEnvio = (t: string | null) => {
    const k = (t ?? "").toUpperCase();
    return k === "ER" ? "var(--pm-er)" : k === "SPX" ? "var(--pm-spx)" : k === "ML" ? "var(--pm-ml)" : k === "TIKTOK" ? "var(--pm-tt)" : "var(--pm-t3)";
  };
  const carregando = totaisQ.isLoading || lotesQ.isLoading;
  const cartao = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 16, boxShadow: "var(--pm-sh)" } as const;

  return (
    <div ref={raiz} className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px clamp(12px, 2vw, 28px) 32px", background: "var(--pm-bg)", minHeight: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 18px" }}>
        <span style={{ ...MONO_M, fontSize: "clamp(40px, 6vw, 64px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{relogio}</span>
        <span style={{ display: "flex", flexDirection: "column" }}>
          <b style={{ fontSize: 15, fontWeight: 600 }}>Monitoramento da bancada</b>
          <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>atualiza a cada 20 s · {lotesQ.isFetching ? "atualizando…" : `próxima em ${prox} s`}</span>
        </span>
        <div style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
          Finalizando como
          <select
            value={quemEfetivo}
            onChange={(e) => setQuem(e.target.value)}
            style={{ height: 44, borderRadius: 10, border: "1.5px solid var(--pm-a)", background: "var(--pm-s)", padding: "0 12px", fontSize: 15, fontWeight: 600, color: "var(--pm-t)" }}
          >
            {!quemEfetivo && <option value="">escolha…</option>}
            {equipe.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => { try { if (document.fullscreenElement) void document.exitFullscreen(); else void raiz.current?.requestFullscreen(); } catch { /* noop */ } }}
          style={{ height: 44, padding: "0 14px", borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "var(--pm-t)" }}
        >
          Tela cheia
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,180px),1fr))", gap: 10 }}>
        {funil.map((f) => (
          <div key={f.label} style={{ ...cartao, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--pm-t2)" }}>{f.label}</span>
            <span style={{ ...MONO_M, fontSize: 44, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.05, color: f.cor }}>{carregando ? "…" : fmt(f.n)}</span>
            <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>{f.sub}</span>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px" }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Lotes na tela</span>
        <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>o crédito da TAG é de quem está em “Finalizando como”</span>
        <div style={{ flex: 1 }} />
        {tipos.length > 1 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {[["", "Todos", todosLotes.length] as const, ...tipos.map(([t, n]) => [t, t, n] as const)].map(([id, nome, n]) => {
              const on = (tipoFiltro ?? "") === id;
              return (
                <button key={id || "todos"} type="button" onClick={() => setTipoFiltro(id || null)}
                  style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 11px", borderRadius: 17, border: `1.5px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? "var(--pm-at)" : "var(--pm-t)" }}>
                  {id && <i style={{ width: 8, height: 8, borderRadius: 2, background: corEnvio(id) }} />}{nome}<span style={{ ...MONO_M, fontSize: 11.5, color: "var(--pm-t3)" }}>{n}</span>
                </button>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {FAIXAS_PRAZO.filter((f) => ["vencidos", "0", "1"].includes(f.id)).map((f) => {
            const on = prazoFiltro.includes(f.id);
            return (
              <button key={f.id} type="button" onClick={() => setPrazoFiltro((cur) => (on ? cur.filter((x) => x !== f.id) : [...cur, f.id]))}
                style={{ height: 34, padding: "0 11px", borderRadius: 17, border: `1.5px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: on ? 600 : 500, color: on ? "var(--pm-at)" : "var(--pm-t)" }}>
                {f.curto}
              </button>
            );
          })}
        </div>
      </div>

      {carregando && <div style={{ ...cartao, height: 280 }} />}
      {!carregando && visiveis.length === 0 && (
        <div style={{ ...cartao, padding: "40px 16px", textAlign: "center", display: "flex", flexDirection: "column", gap: 6 }}>
          <b style={{ fontSize: 18, fontWeight: 600 }}>{todosLotes.length === 0 ? "Nenhum lote na tela: tudo finalizado 🎉" : "Nenhum lote neste filtro"}</b>
          <span style={{ fontSize: 13, color: "var(--pm-t2)" }}>{todosLotes.length === 0 ? "Os lotes aparecem aqui assim que a etiqueta é impressa." : `${todosLotes.length} lote(s) na tela ficaram fora do filtro.`}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,300px),1fr))", gap: 12, alignItems: "start" }}>
        {visiveis.map((c) => {
          const r = recentes[c.tag];
          const ped = num(c.qtd_pedidos), imp = num(c.etiquetas_impressas), conf = num(c.etiquetas_confirmadas);
          const un = num(c.unidades_por_pedido) || 1;
          const peso = pesoPorPedido(c.produto_nome, un);
          const cu = corUn(un);
          const dias = diasAtePrazo(c.prazo);
          const prazo = !c.prazo || dias === null ? { t: "sem prazo", bg: "var(--pm-s2)", c: "var(--pm-t2)" }
            : dias < 0 ? { t: `Vencido · ${fmtPrazoData(c.prazo)}`, bg: "var(--pm-rs)", c: "var(--pm-r)" }
            : dias === 0 ? { t: "Hoje", bg: "var(--pm-ams)", c: "var(--pm-am)" }
            : dias === 1 ? { t: "Amanhã", bg: "var(--pm-s2)", c: "var(--pm-t2)" }
            : { t: fmtPrazoData(c.prazo), bg: "var(--pm-s2)", c: "var(--pm-t2)" };
          const etCor = conf >= ped ? "var(--pm-g)" : "var(--pm-am)";
          const aberta = expandidas.has(c.tag);
          return (
            <div key={c.tag} style={{ ...cartao, background: r ? "var(--pm-gs)" : "var(--pm-s)", border: `1px solid ${r ? "var(--pm-g)" : "var(--pm-b)"}`, borderTop: `6px solid ${corEnvio(c.tipo_envio)}`, padding: 14, display: "flex", flexDirection: "column", gap: 8, gridColumn: aberta ? "1 / -1" : undefined, opacity: finalizando === c.tag ? 0.5 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--pm-t2)" }}>{(c.tipo_envio ?? "—").toUpperCase()}</span>
                <span style={{ fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 6, background: prazo.bg, color: prazo.c }}>{prazo.t}</span>
                <div style={{ flex: 1 }} />
                <span style={{ ...MONO_M, fontSize: 12, color: "var(--pm-t3)" }}>SKU {c.sku ?? "—"}</span>
              </div>
              <button type="button" onClick={() => setExpandidas((cur) => { const n = new Set(cur); if (n.has(c.tag)) n.delete(c.tag); else n.add(c.tag); return n; })}
                title={aberta ? "Esconder os pedidos" : "Ver os pedidos da TAG"}
                style={{ ...MONO_M, border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", fontSize: 46, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: r ? "var(--pm-g)" : "var(--pm-t)", display: "flex", alignItems: "center", gap: 6 }}>
                {c.tag}<ChevronDown className="h-5 w-5" style={{ color: "var(--pm-t3)", transform: aberta ? "rotate(180deg)" : "none" }} />
              </button>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <FotoM url={c.foto} nome={c.produto_nome} />
                <span style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.25 }}><NomeComPeso nome={c.produto_nome} /></span>
              </div>
              <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
                <div style={{ flex: 1, padding: "8px 10px", borderRadius: 10, background: peso?.pesado ? "var(--pm-t)" : "var(--pm-s2)", color: peso?.pesado ? "var(--pm-s)" : "var(--pm-t)", display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", opacity: 0.8 }}>{!peso ? "PESO ?" : peso.pesado === null ? "VOLUME" : peso.pesado ? "PESADO" : "LEVE"}</span>
                  <b style={{ ...MONO_M, fontSize: 24, fontWeight: 700 }}>{peso?.txt ?? "—"}</b>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>{peso ? "por pedido" : "sem peso no nome"}</span>
                </div>
                <div style={{ flex: 1, padding: "8px 10px", borderRadius: 10, background: cu.bg, color: cu.fg, display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.03em", opacity: 0.85 }}>UN POR PEDIDO</span>
                  <b style={{ ...MONO_M, fontSize: 24, fontWeight: 700 }}>{un}</b>
                  <span style={{ fontSize: 11, opacity: 0.85 }}>{fmt(ped)} pedidos · {fmt(c.total_unidades)} un</span>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span style={{ color: "var(--pm-t2)" }}>Etiquetas</span>
                  <span style={{ ...MONO_M, fontWeight: 600, color: etCor }}>{imp}/{ped} impressas · {conf} confirmadas</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--pm-sk)", overflow: "hidden" }}>
                  <i style={{ display: "block", height: "100%", width: `${ped ? Math.min(100, (conf / ped) * 100) : 0}%`, background: etCor }} />
                </div>
              </div>
              {aberta && <div style={{ borderTop: "1px solid var(--pm-b)", paddingTop: 8 }}><PedidosDaTag tag={c.tag} /></div>}
              {r ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, height: 52, padding: "0 6px 0 14px", borderRadius: 12, background: "var(--pm-g)", color: "var(--pm-s)" }}>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>✓ Finalizada por {r.por}</span>
                  <button type="button" onClick={() => void desfazer(c.tag)} style={{ height: 40, padding: "0 12px", borderRadius: 9, border: 0, background: "var(--pm-s)", color: "var(--pm-g)", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                    Desfazer · {Math.max(1, Math.ceil((r.ate - nowMs) / 1000))} s
                  </button>
                </div>
              ) : (
                <>
                  {conf < ped && <span style={{ fontSize: 12, color: "var(--pm-am)", fontWeight: 600 }}>{ped - conf} etiqueta(s) ainda sem confirmação da impressora</span>}
                  <button type="button" disabled={finalizando !== null || !quemEfetivo} onClick={() => void finalizar(c)}
                    style={{ height: 52, borderRadius: 12, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 15, fontWeight: 700, opacity: finalizando !== null || !quemEfetivo ? 0.6 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {finalizando === c.tag && <Loader2 className="h-4 w-4 animate-spin" />}
                    {quemEfetivo ? `Finalizar TAG como ${quemEfetivo}` : "Escolha quem está finalizando"}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

class ProtecaoMonitor extends Component<{ children: ReactNode }, { erro: string | null }> {
  state = { erro: null as string | null };
  static getDerivedStateFromError(e: Error) { return { erro: e?.message ?? String(e) }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error("Monitoramento (visual novo) quebrou", e, info.componentStack); }
  render() {
    if (!this.state.erro) return this.props.children;
    return (
      <div className="flex flex-col gap-3">
        <Card className="p-3 border-amber-400 bg-amber-50 text-amber-900 text-sm dark:bg-amber-950/30 dark:text-amber-200">
          O visual novo do Monitoramento deu erro e voltou para o antigo: <span className="font-mono">{this.state.erro}</span>
        </Card>
        <MonitoramentoAntigo />
      </div>
    );
  }
}

function MonitoramentoPage() {
  return <ProtecaoMonitor><MonitoramentoNovo /></ProtecaoMonitor>;
}

export const Route = createFileRoute("/monitoramento")({
  component: MonitoramentoPage,
});
