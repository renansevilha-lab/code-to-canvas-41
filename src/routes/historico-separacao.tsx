import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PackageSearch, Search } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Histórico de Separação — registro visual e auditável do que aconteceu com cada
// LOTE (TAG) e cada PEDIDO. Import do design "Histórico de Separação.dc.html"
// (Claude Design), portado para o tema do app. Fonte de dados:
//   view_separacao_historico_tags     (cartões por TAG)
//   view_separacao_historico_pedidos  (linhas por pedido tagueado)
//   view_separacao_log_enriquecido    (log cru p/ a timeline expandida)
// ============================================================================

// ---- paleta de acento (do design; funciona em tema claro/escuro) ----
const PALETTE = ["#2F6FB0", "#7A5CC7", "#DB6B1F", "#0E8A5F", "#B7791F", "#0891B2", "#BE4B8F"];
const GREEN = "#0E8A5F", AMBER = "#B7791F", BLUE = "#2F6FB0", ROXO = "#7A5CC7";
const ENVIO_STYLE: Record<string, string> = { ER: "#3FA9F5", SPX: "#FF6A39", ML: "#FFD400" };

const EV_LABEL: Record<string, string> = {
  tag_aplicada: "TAG aplicada", etiqueta_impressa: "Etiqueta impressa",
  embalado: "Embalado", tag_finalizada: "TAG finalizada",
};
const EV_ICON: Record<string, string> = {
  tag_aplicada: "🏷", etiqueta_impressa: "🖨", embalado: "📦", tag_finalizada: "✓",
};
const EV_COLOR: Record<string, string> = {
  tag_aplicada: BLUE, etiqueta_impressa: AMBER, embalado: ROXO, tag_finalizada: GREEN,
};

const num = (x: unknown): number => {
  const n = Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function personColor(nome: string | null): string {
  if (!nome) return "#6C7481";
  return PALETTE[hashStr(nome) % PALETTE.length];
}
function envioColor(code: string | null): string {
  return ENVIO_STYLE[(code ?? "").toUpperCase()] ?? "#6C7481";
}
function canalColor(nome: string | null): string {
  const n = (nome ?? "").toLowerCase();
  if (n.includes("shopee") || n.includes("sevilla")) return "#EE4D2D";
  if (n.includes("mercado")) return "#C79A00";
  if (n.includes("amazon")) return "#FF9900";
  return "#6E56CF";
}

// Hora HH:MM no fuso de São Paulo (os timestamps das views são timestamptz).
function hm(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
  });
}

// Dia de hoje (SP) em YYYY-MM-DD, deslocado por `offset` dias.
function diaComOffset(offset: number): string {
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [y, m, d] = hojeSP.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}
function labelDia(dia: string, isToday: boolean): string {
  const [y, m, d] = dia.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const s = dt.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", timeZone: "UTC" });
  return (isToday ? "Hoje, " : "") + s;
}

function detalheTexto(evento: string, detalhe: Record<string, unknown> | null): string {
  const d = (detalhe ?? {}) as Record<string, unknown>;
  if (evento === "tag_aplicada")
    return d.pedidos_tagueados != null ? `${d.pedidos_tagueados} pedido(s) na TAG` : "TAG aplicada ao lote";
  if (evento === "etiqueta_impressa") {
    const via = d.via ? ` · ${d.via}` : "";
    if (d.enviadas != null) return `${d.enviadas} etiqueta(s)${via}`;
    return `Etiqueta impressa${via}`;
  }
  if (evento === "embalado") {
    if (d.embaladas != null) return `${d.embaladas} embalado(s)`;
    return d.forcado ? "Embalado (forçado)" : "Pedido embalado";
  }
  if (evento === "tag_finalizada") return "Lote finalizado — só monitoramento";
  return "";
}

// ---- tipos das views ----
interface TagRow {
  tag: string; sku: string | null; foto_capa: string | null;
  aplicada_em: string | null; aplicada_por: string | null;
  primeira_impressao_em: string | null; ultima_impressao_em: string | null;
  qtd_impressoes: number | string; impressa_por: string[] | null;
  embalado_em: string | null; embalada_por: string[] | null;
  finalizada_em: string | null; finalizada_por: string | null;
  ultimo_evento_em: string | null; dia: string;
}
interface PedidoRow {
  separacao_id: number; numero_ecommerce: string | null; venda_numero: string | null;
  sku: string | null; nome_produto: string | null; qtd_unidades: number | string;
  marca_canal: string | null; forma_envio: string | null; tag_lote: string | null;
  situacao: number | null; foto_capa: string | null;
  aplicada_em: string | null; aplicada_por: string | null;
  impressao_em: string | null; impressa_por: string | null;
  embalado_em: string | null; embalado_por: string | null;
  finalizada_em: string | null; finalizada_por: string | null; dia: string;
}
interface LogRow {
  id: number; criado_em: string; evento: string; usuario: string | null;
  tag: string | null; order_sn: string | null; separacao_id: number | null;
  sku: string | null; detalhe: Record<string, unknown> | null; foto_capa: string | null;
}

// ---- mini componentes ----
function Foto({ url, nome, size }: { url: string | null; nome: string | null; size: number }) {
  const [erro, setErro] = useState(false);
  const ok = !!url && !erro;
  const iniciais = (nome ?? "?").split(" ").filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  return (
    <div
      className="rounded-[10px] shrink-0 overflow-hidden flex items-center justify-center bg-muted text-muted-foreground"
      style={{ width: size, height: size }}
    >
      {ok ? (
        <img src={url!} alt={nome ?? ""} loading="lazy" className="w-full h-full object-cover" onError={() => setErro(true)} />
      ) : (
        <span className="text-xs font-extrabold">{iniciais}</span>
      )}
    </div>
  );
}

function PessoaBadge({ nome }: { nome: string }) {
  const c = personColor(nome);
  return (
    <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: c + "18", color: c }}>{nome}</span>
  );
}

function LogTimeline({ eventos, chaveLabel }: { eventos: LogRow[]; chaveLabel: string }) {
  return (
    <div className="border-t border-border bg-muted/50 px-5 py-4 flex flex-col">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-2">
        Log completo — {chaveLabel}
      </span>
      {eventos.length === 0 && (
        <span className="text-xs text-muted-foreground py-2">Sem eventos registrados.</span>
      )}
      {eventos.map((ev) => {
        const c = EV_COLOR[ev.evento] ?? "#6C7481";
        return (
          <div key={ev.id} className="flex items-start gap-3 py-2 border-b border-border last:border-b-0">
            <span className="text-[12.5px] font-bold font-mono shrink-0 w-[46px]">{hm(ev.criado_em)}</span>
            <span className="w-[22px] h-[22px] rounded-md shrink-0 flex items-center justify-center text-[11px]"
              style={{ background: c + "1c", color: c }}>{EV_ICON[ev.evento] ?? "•"}</span>
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold">{EV_LABEL[ev.evento] ?? ev.evento}</span>
                {ev.usuario && <PessoaBadge nome={ev.usuario} />}
              </div>
              <span className="text-xs text-muted-foreground">{detalheTexto(ev.evento, ev.detalhe)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

type Modo = "tag" | "pedido";
type EventoFiltro = "todos" | "aplicada" | "impressao" | "embalado" | "finalizada";

function HistoricoPage() {
  const { modo } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setModo = (m: Modo) => navigate({ search: (p) => ({ ...p, modo: m }), replace: true });

  const [dayOffset, setDayOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [eventoFiltro, setEventoFiltro] = useState<EventoFiltro>("todos");
  const [pessoaFiltro, setPessoaFiltro] = useState<string | null>(null);
  const [expTag, setExpTag] = useState<Set<string>>(new Set());
  const [expPed, setExpPed] = useState<Set<number>>(new Set());

  const dia = diaComOffset(dayOffset);
  const isToday = dayOffset === 0;

  const tagsQ = useQuery({
    queryKey: ["historico-sep", "tags", dia],
    queryFn: async (): Promise<TagRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_historico_tags").select("*").eq("dia", dia);
      if (error) throw error;
      return (data ?? []) as TagRow[];
    },
  });
  const pedidosQ = useQuery({
    queryKey: ["historico-sep", "pedidos", dia],
    queryFn: async (): Promise<PedidoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_historico_pedidos").select("*").eq("dia", dia);
      if (error) throw error;
      return (data ?? []) as PedidoRow[];
    },
  });
  const logQ = useQuery({
    queryKey: ["historico-sep", "log", dia],
    queryFn: async (): Promise<LogRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_separacao_log_enriquecido").select("*").eq("dia", dia).order("criado_em", { ascending: true });
      if (error) throw error;
      return (data ?? []) as LogRow[];
    },
  });

  const tags = useMemo(() => tagsQ.data ?? [], [tagsQ.data]);
  const pedidos = useMemo(() => pedidosQ.data ?? [], [pedidosQ.data]);
  const log = useMemo(() => logQ.data ?? [], [logQ.data]);

  const carregando = tagsQ.isLoading || pedidosQ.isLoading;

  // log agrupado por TAG e por pedido (para as timelines expandidas)
  const logPorTag = useMemo(() => {
    const m = new Map<string, LogRow[]>();
    for (const ev of log) {
      if (!ev.tag) continue;
      const arr = m.get(ev.tag) ?? [];
      arr.push(ev);
      m.set(ev.tag, arr);
    }
    return m;
  }, [log]);
  function logDoPedido(p: PedidoRow): LogRow[] {
    return log.filter(
      (ev) => ev.separacao_id === p.separacao_id || (ev.tag === p.tag_lote && ev.separacao_id == null),
    );
  }

  const contadores = useMemo(() => {
    const total = tags.length;
    const finalizadas = tags.filter((t) => !!t.finalizada_em).length;
    return { total, finalizadas, em_aberto: total - finalizadas };
  }, [tags]);

  const pessoas = useMemo(() => {
    const s = new Set<string>();
    for (const ev of log) if (ev.usuario) s.add(ev.usuario);
    return Array.from(s).sort();
  }, [log]);

  // ---- filtros ----
  const q = search.trim().toLowerCase();
  const filteredTags = useMemo(() => {
    let out = tags;
    if (q) out = out.filter((t) => t.tag.toLowerCase().includes(q) || (t.sku ?? "").toLowerCase().includes(q));
    if (pessoaFiltro)
      out = out.filter((t) =>
        [t.aplicada_por, ...(t.impressa_por ?? []), ...(t.embalada_por ?? []), t.finalizada_por]
          .filter(Boolean).includes(pessoaFiltro),
      );
    if (eventoFiltro !== "todos")
      out = out.filter((t) =>
        eventoFiltro === "aplicada" ? !!t.aplicada_em
          : eventoFiltro === "impressao" ? num(t.qtd_impressoes) > 0
            : eventoFiltro === "embalado" ? !!t.embalado_em
              : !!t.finalizada_em,
      );
    return out.slice().sort((a, b) => (b.ultimo_evento_em ?? "").localeCompare(a.ultimo_evento_em ?? ""));
  }, [tags, q, pessoaFiltro, eventoFiltro]);

  const filteredPedidos = useMemo(() => {
    let out = pedidos;
    if (q)
      out = out.filter((p) =>
        (p.tag_lote ?? "").toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q) ||
        (p.numero_ecommerce ?? "").toLowerCase().includes(q) || (p.venda_numero ?? "").toLowerCase().includes(q),
      );
    if (pessoaFiltro)
      out = out.filter((p) =>
        [p.aplicada_por, p.impressa_por, p.embalado_por, p.finalizada_por].filter(Boolean).includes(pessoaFiltro),
      );
    if (eventoFiltro !== "todos")
      out = out.filter((p) =>
        eventoFiltro === "aplicada" ? !!p.aplicada_em
          : eventoFiltro === "impressao" ? !!p.impressao_em
            : eventoFiltro === "embalado" ? !!p.embalado_em
              : !!p.finalizada_em,
      );
    return out.slice().sort((a, b) => (b.aplicada_em ?? "").localeCompare(a.aplicada_em ?? ""));
  }, [pedidos, q, pessoaFiltro, eventoFiltro]);

  const isDayEmpty = !carregando && tags.length === 0 && pedidos.length === 0;
  const listaVazia = modo === "tag" ? filteredTags.length === 0 : filteredPedidos.length === 0;
  const isFilterEmpty = !isDayEmpty && !carregando && listaVazia;

  function toggleTag(tag: string) {
    setExpTag((prev) => { const n = new Set(prev); n.has(tag) ? n.delete(tag) : n.add(tag); return n; });
  }
  function togglePed(id: number) {
    setExpPed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function limparFiltros() { setSearch(""); setEventoFiltro("todos"); setPessoaFiltro(null); }
  function irParaTag(tag: string) { setModo("tag"); setSearch(tag); }

  return (
    <div className="flex flex-col gap-5 p-1">
      {/* Cabeçalho */}
      <div className="flex flex-col gap-0.5">
        <h1 className="text-xl font-extrabold tracking-tight">Histórico de Separação</h1>
        <span className="text-sm text-muted-foreground">Quem fez o quê, e quando</span>
      </div>

      {/* Toggle de modo */}
      <div className="inline-flex items-center gap-1 bg-muted rounded-xl p-1 w-fit">
        {(["tag", "pedido"] as Modo[]).map((m) => (
          <button key={m} onClick={() => setModo(m)}
            className={cn("px-4 py-2 rounded-lg text-sm font-bold transition-colors",
              modo === m ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {m === "tag" ? "Por TAG (lote)" : "Por pedido"}
          </button>
        ))}
      </div>

      {/* Dia + contadores */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 bg-card border border-border rounded-xl p-1">
          <button onClick={() => setDayOffset((v) => v - 1)}
            className="px-3 py-2 rounded-lg text-base font-bold hover:bg-muted transition-colors">‹</button>
          <span className="text-sm font-bold px-2 min-w-[190px] text-center whitespace-nowrap capitalize">{labelDia(dia, isToday)}</span>
          <button onClick={() => setDayOffset((v) => v + 1)} disabled={isToday}
            className="px-3 py-2 rounded-lg text-base font-bold hover:bg-muted transition-colors disabled:opacity-30">›</button>
          {!isToday && (
            <button onClick={() => setDayOffset(0)}
              className="ml-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border border-border text-primary hover:bg-muted transition-colors">hoje</button>
          )}
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          {[
            { label: "TAGs no dia", value: contadores.total, color: undefined as string | undefined },
            { label: "Finalizadas", value: contadores.finalizadas, color: GREEN },
            { label: "Em aberto", value: contadores.em_aberto, color: AMBER },
          ].map((c) => (
            <Card key={c.label} className="px-4 py-2.5 flex flex-col gap-0.5 min-w-[96px]">
              <span className="text-xl font-extrabold tabular-nums leading-none" style={c.color ? { color: c.color } : undefined}>{c.value}</span>
              <span className="text-[11px] text-muted-foreground font-semibold">{c.label}</span>
            </Card>
          ))}
        </div>
      </div>

      {/* Busca + filtros */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="flex-[0_1_280px] min-w-[210px] flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por TAG, pedido ou SKU"
            className="border-0 outline-0 bg-transparent text-sm flex-1 min-w-0" />
        </div>
        <select value={eventoFiltro} onChange={(e) => setEventoFiltro(e.target.value as EventoFiltro)}
          className="border border-border bg-card rounded-lg px-3 py-2.5 text-sm font-medium cursor-pointer">
          <option value="todos">Todos os eventos</option>
          <option value="aplicada">TAG aplicada</option>
          <option value="impressao">Etiquetas impressas</option>
          <option value="embalado">Embalado</option>
          <option value="finalizada">Finalizada</option>
        </select>
        {pessoas.length > 0 && (
          <>
            <div className="w-px self-stretch bg-border" />
            <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">Pessoa:</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {pessoas.map((nome) => {
                const sel = pessoaFiltro === nome;
                const c = personColor(nome);
                return (
                  <button key={nome} onClick={() => setPessoaFiltro(sel ? null : nome)}
                    className="flex items-center gap-1.5 rounded-full text-[12.5px] font-semibold px-2.5 py-1.5 border-[1.5px] transition-colors"
                    style={{ borderColor: sel ? c : "hsl(var(--border))", background: sel ? c + "18" : "transparent", color: sel ? c : undefined }}>
                    <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: c }} />
                    {nome}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {carregando && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando histórico…
        </div>
      )}

      {isDayEmpty && (
        <Card className="border-dashed py-16 px-8 flex flex-col items-center gap-2.5 text-center">
          <PackageSearch className="h-8 w-8 text-muted-foreground" />
          <span className="text-[14.5px] font-semibold">Nenhuma separação registrada neste dia</span>
          <span className="text-[13px] text-muted-foreground">Escolha outro dia ou volte para hoje</span>
        </Card>
      )}

      {isFilterEmpty && (
        <Card className="border-dashed py-14 px-8 flex flex-col items-center gap-3.5 text-center">
          <span className="text-sm text-muted-foreground">Nenhum resultado encontrado com esses filtros</span>
          <button onClick={limparFiltros}
            className="border border-border bg-card rounded-lg px-4 py-2 text-[13px] font-semibold hover:bg-muted transition-colors">Limpar filtros</button>
        </Card>
      )}

      {/* MODO TAG */}
      {modo === "tag" && !isDayEmpty && !isFilterEmpty && (
        <div className="flex flex-col gap-3.5">
          {filteredTags.map((t) => {
            const expanded = expTag.has(t.tag);
            const imprOk = num(t.qtd_impressoes) > 0;
            const embOk = !!t.embalado_em;
            const finOk = !!t.finalizada_em;
            const imprTime = imprOk
              ? hm(t.primeira_impressao_em) + (t.ultima_impressao_em !== t.primeira_impressao_em ? ` → ${hm(t.ultima_impressao_em)}` : "")
              : "—";
            const marcos = [
              { label: "TAG aplicada", color: BLUE, done: !!t.aplicada_em, time: hm(t.aplicada_em), sub: null as string | null, pessoas: t.aplicada_por ? [t.aplicada_por] : [] },
              { label: "Etiquetas impressas", color: AMBER, done: imprOk, time: imprTime, sub: imprOk ? `${num(t.qtd_impressoes)} ${num(t.qtd_impressoes) === 1 ? "impressão" : "impressões"}` : null, pessoas: t.impressa_por ?? [] },
              { label: "Embalado", color: ROXO, done: embOk, time: hm(t.embalado_em), sub: null, pessoas: t.embalada_por ?? [] },
              { label: "Finalizada", color: GREEN, done: finOk, time: hm(t.finalizada_em), sub: null, pessoas: t.finalizada_por ? [t.finalizada_por] : [] },
            ];
            return (
              <Card key={t.tag} className="overflow-hidden border-[1.5px] p-0">
                <div onClick={() => toggleTag(t.tag)} className="cursor-pointer p-5 flex flex-col gap-4">
                  <div className="flex items-center gap-3.5 flex-wrap">
                    <Foto url={t.foto_capa} nome={t.sku} size={52} />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[11px] font-semibold text-muted-foreground">SKU {t.sku ?? "—"}</span>
                      <span className="text-[12.5px] font-extrabold font-mono px-2.5 py-0.5 rounded-md w-fit bg-foreground text-background">{t.tag}</span>
                    </div>
                    <div className="flex-1" />
                    {finOk ? (
                      <span className="text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap" style={{ background: GREEN + "18", color: GREEN }}>✓ Finalizada</span>
                    ) : (
                      <span className="text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap" style={{ background: AMBER + "18", color: AMBER }}>Em aberto</span>
                    )}
                    <span className="text-sm text-muted-foreground transition-transform" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>⌄</span>
                  </div>

                  <div className="flex flex-wrap">
                    {marcos.map((m) => (
                      <div key={m.label}
                        className={cn("flex-[1_1_220px] min-w-[210px] px-4 flex flex-col gap-2 border-l-2", !m.done && "border-border")}
                        style={m.done ? { borderLeftColor: m.color } : undefined}>
                        <div className="flex items-center gap-2">
                          <span className={cn("w-6 h-6 rounded-md shrink-0 flex items-center justify-center text-[12.5px]", !m.done && "bg-muted text-muted-foreground")}
                            style={m.done ? { background: m.color + "1c", color: m.color } : undefined}>
                            {m.label === "TAG aplicada" ? "🏷" : m.label === "Etiquetas impressas" ? "🖨" : m.label === "Embalado" ? "📦" : "✓"}
                          </span>
                          <span className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">{m.label}</span>
                        </div>
                        <span className={cn("text-[17px] font-extrabold font-mono tracking-tight", !m.done && "text-muted-foreground")}
                          style={m.done && m.label === "Finalizada" ? { color: GREEN } : undefined}>{m.time}</span>
                        {m.sub && <span className="text-[11.5px] text-muted-foreground">{m.sub}</span>}
                        <div className="flex flex-wrap gap-1.5">
                          {m.pessoas.map((nome) => <PessoaBadge key={nome} nome={nome} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {expanded && <LogTimeline eventos={logPorTag.get(t.tag) ?? []} chaveLabel={t.tag} />}
              </Card>
            );
          })}
        </div>
      )}

      {/* MODO PEDIDO */}
      {modo === "pedido" && !isDayEmpty && !isFilterEmpty && (
        <div className="flex flex-col gap-2.5">
          {filteredPedidos.map((p) => {
            const expanded = expPed.has(p.separacao_id);
            const finOk = !!p.finalizada_em;
            const marcos = [
              { label: "TAG aplicada", time: p.aplicada_em, pessoa: p.aplicada_por },
              { label: "Impressão", time: p.impressao_em, pessoa: p.impressa_por },
              { label: "Embalado", time: p.embalado_em, pessoa: p.embalado_por },
              { label: "Finalizada", time: p.finalizada_em, pessoa: p.finalizada_por },
            ];
            return (
              <Card key={p.separacao_id} className="overflow-hidden border-[1.5px] p-0">
                <div onClick={() => togglePed(p.separacao_id)} className="cursor-pointer p-3.5 flex items-stretch flex-wrap gap-4">
                  <div className="flex items-center gap-3 flex-[1_1_260px] min-w-[230px]">
                    <Foto url={p.foto_capa} nome={p.sku} size={44} />
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Produto</span>
                      <span className="text-[11.5px] font-semibold truncate max-w-[220px]">{p.nome_produto ?? "—"}</span>
                      <span className="text-[11px] text-muted-foreground font-mono">SKU {p.sku ?? "—"} · {num(p.qtd_unidades)}un</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 flex-[0_0_170px] justify-center">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Pedido</span>
                    <span className="text-sm font-extrabold font-mono">{p.numero_ecommerce ?? "—"}</span>
                    <span className="text-[11px] text-muted-foreground font-mono">venda {p.venda_numero ?? "—"}</span>
                    <div className="flex gap-1.5 mt-0.5">
                      {p.marca_canal && <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap" style={{ background: canalColor(p.marca_canal) + "20", color: canalColor(p.marca_canal) }}>{p.marca_canal}</span>}
                      {p.forma_envio && <span className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap" style={{ background: envioColor(p.forma_envio) + "20", color: envioColor(p.forma_envio) }}>{p.forma_envio}</span>}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 flex-[0_0_110px] justify-center">
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">TAG</span>
                    <button onClick={(e) => { e.stopPropagation(); if (p.tag_lote) irParaTag(p.tag_lote); }}
                      className="font-mono text-[12.5px] font-extrabold px-2.5 py-1 rounded-md w-fit bg-foreground text-background hover:opacity-80 transition-opacity">
                      {p.tag_lote ?? "—"}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-3.5 flex-[2_1_460px]">
                    {marcos.map((m) => (
                      <div key={m.label} className="flex flex-col gap-0.5 flex-[1_1_100px] min-w-[100px] justify-center">
                        <span className="text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">{m.label}</span>
                        <span className={cn("text-[12.5px] font-bold font-mono", !m.time && "text-muted-foreground")}>{hm(m.time)}</span>
                        {m.pessoa && <PessoaBadge nome={m.pessoa} />}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
                    <span className="text-[11.5px] font-bold px-3 py-1 rounded-full whitespace-nowrap"
                      style={{ background: (finOk ? GREEN : AMBER) + "18", color: finOk ? GREEN : AMBER }}>
                      {finOk ? "✓ Finalizada" : "Em aberto"}
                    </span>
                    <span className="text-[13px] text-muted-foreground transition-transform" style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}>⌄</span>
                  </div>
                </div>
                {expanded && <LogTimeline eventos={logDoPedido(p)} chaveLabel={`pedido ${p.numero_ecommerce ?? p.separacao_id}`} />}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/historico-separacao")({
  validateSearch: (s: Record<string, unknown>): { modo: Modo } => ({
    modo: s.modo === "pedido" ? "pedido" : "tag",
  }),
  component: HistoricoPage,
});
