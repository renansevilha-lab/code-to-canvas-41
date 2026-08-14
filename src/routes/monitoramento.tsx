import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PackageX } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";

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
}

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const fmt = (x: unknown): string => num(x).toLocaleString("pt-BR");

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

function MonitoramentoPage() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [finalizando, setFinalizando] = useState<string | null>(null);
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
  const lotes = lotesQ.data ?? [];

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
    const { error } = await supabaseExternal.rpc("monitoramento_finalizar_tag", { p_tag: tag });
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
  const semLotes = !carregando && lotes.length === 0;

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

      {/* Sub-título */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Lotes na tela</span>
        <span className="text-sm text-muted-foreground">· {lotes.length} etiquetas impressas aguardando bipagem</span>
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
            return (
              <Card
                key={c.tag}
                className={cn(
                  "p-5 flex flex-col gap-3.5 border-[1.5px] transition-all duration-300",
                  saindo && "opacity-40 scale-[0.97]",
                )}
              >
                {/* TAG + tipo */}
                <div className="flex items-center justify-between gap-2.5">
                  <span className="text-3xl font-extrabold tracking-tight font-mono">{c.tag}</span>
                  <span
                    className="text-[13px] font-extrabold tracking-wide px-3 py-1.5 rounded-[9px]"
                    style={{ background: ts.bg, color: ts.fg }}
                  >
                    {(c.tipo_envio ?? "—").toUpperCase()}
                  </span>
                </div>

                {/* Foto + produto */}
                <div className="flex gap-3.5 items-center">
                  <FotoProduto url={c.foto} nome={c.produto_nome} tipo={c.tipo_envio} />
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium leading-snug line-clamp-2">{c.produto_nome ?? "—"}</span>
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

export const Route = createFileRoute("/monitoramento")({
  component: MonitoramentoPage,
});
