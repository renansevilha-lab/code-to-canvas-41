import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Eye, Loader2, Package, RefreshCw, RotateCcw, Send, ShoppingBag, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Central de Atendimento — 26/nov/2026 (proposta aprovada pelo dono:
// https://claude.ai/artifact/5ZHj7f86s9RfSaieT9JuCL). Caixa única Shopee
// (shopee-chat) + Mercado Livre (ml-chat: perguntas e pós-venda), nas duas
// empresas. Fila → conversa com a resposta da IA pronta → contexto do pedido.
// A IA (GPT-5.5) escreve; a pessoa confere e envia. Tom de voz em
// atendimento_config (chave 'tom'). Envio registrado em shopee_chat_respostas
// (Shopee) e atendimento_respostas (ML).
// ============================================================================

type Mkt = "shopee" | "ml";
type Loja = "ottz" | "svl";
type Tipo = "pos" | "perg";
type FMkt = "todos" | Mkt;
type FTipo = "tudo" | Tipo | "atencao";

export const Route = createFileRoute("/atendimento")({
  validateSearch: (s: Record<string, unknown>): { mk?: Mkt; t?: Exclude<FTipo, "tudo">; c?: string } => ({
    mk: s.mk === "shopee" || s.mk === "ml" ? s.mk : undefined,
    t: s.t === "pos" || s.t === "perg" || s.t === "atencao" ? s.t : undefined,
    c: typeof s.c === "string" ? s.c : undefined,
  }),
  component: CentralAtendimento,
});

interface Item {
  chave: string; mkt: Mkt; loja: Loja; tipo: Tipo; ref: string;
  nome: string; foto: string | null; prev: string; em: string | null;
  naoLidas: number; deNos: boolean; bloqueada: boolean; motivoBloqueio: string | null;
  compradorId: string | null; produto: string | null;
}
interface Sug { sugestao?: string; precisa_humano?: boolean; motivo?: string | null; modelo?: string; erro?: string; contexto?: any }
interface Msg { id: string; deNos: boolean; texto: string; em: string | null; origem?: string | null }

const NOME_LOJA: Record<Mkt, Record<Loja, string>> = {
  shopee: { ottz: "Shopee Ottz", svl: "Shopee Bumi" },
  ml: { ottz: "Mercado Livre Ottz", svl: "Mercado Livre SVL" },
};
const LIMITE = (it: Item) => (it.mkt === "ml" ? (it.tipo === "perg" ? 2000 : 350) : 1000);
const TIPOS_TEXTO = new Set(["text", "image", "video", "order", "item", "product", "sticker", null as any]);
const AJUSTES: [string, string][] = [
  ["Mais curta", "Deixe a resposta mais curta e direta."],
  ["Mais simpática", "Deixe o tom um pouco mais simpático, sem exagero."],
  ["Pedir foto", "Peça uma foto do produto ou da embalagem para analisarmos."],
  ["Pedir nº do pedido", "Peça o número do pedido para conferirmos."],
  ["Informar prazo", "Informe o prazo de envio/entrega que aparece nos dados do pedido."],
];

async function chamar(fn: "shopee-chat" | "ml-chat", modulo: string, params: Record<string, string>, body?: Record<string, unknown>) {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const qs = new URLSearchParams({ modulo, ...params }).toString();
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/${fn}?${qs}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.erro || `HTTP ${r.status}`);
  return j;
}

const minutosDesde = (s: string | null) => (s ? (Date.now() - new Date(s).getTime()) / 60000 : 0);
const espera = (s: string | null) => {
  const m = minutosDesde(s);
  if (!s) return "";
  if (m < 60) return `há ${Math.max(1, Math.round(m))} min`;
  if (m < 48 * 60) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} d`;
};
const dataHora = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "");
const dataBR = (s: string | null | undefined) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");

// "marcar como resolvida" sem resposta: some da fila até chegar mensagem nova
const RESOLVIDAS = "atendimento.resolvidas";
const lerResolvidas = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(RESOLVIDAS) || "{}"); } catch { return {}; } };

function CentralAtendimento() {
  const s = Route.useSearch();
  const nav = useNavigate({ from: "/atendimento" });
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const fMkt: FMkt = s.mk ?? "todos";
  const fTipo: FTipo = s.t ?? "tudo";
  const set = (v: Partial<{ mk: Mkt | undefined; t: Exclude<FTipo, "tudo"> | undefined; c: string | undefined }>) =>
    nav({ search: (p: any) => ({ ...p, ...v }), resetScroll: false, replace: true });
  const [busca, setBusca] = useState("");
  const [resolvidas, setResolvidas] = useState<Record<string, string>>(() => lerResolvidas());
  const [respondidas, setRespondidas] = useState<Set<string>>(new Set());
  const [sugs, setSugs] = useState<Record<string, Sug>>({});

  const fontes = useQueries({
    queries: ([["shopee", "ottz"], ["shopee", "svl"], ["ml", "ottz"], ["ml", "svl"]] as [Mkt, Loja][]).map(([mkt, loja]) => ({
      queryKey: ["atendimento", "caixa", mkt, loja],
      queryFn: () => mkt === "shopee" ? chamar("shopee-chat", "conversas", { loja, limite: "60" }) : chamar("ml-chat", "caixa", { conta: loja }),
      refetchInterval: 90_000, staleTime: 30_000, placeholderData: undefined,
      meta: { mkt, loja },
    })),
  });
  const carregando = fontes.some((q) => q.isLoading);
  const errosFonte = fontes.map((q, i) => q.error ? `${["Shopee Ottz", "Shopee Bumi", "Mercado Livre Ottz", "Mercado Livre SVL"][i]}: ${(q.error as Error).message}` : null).filter(Boolean);

  const itens: Item[] = useMemo(() => {
    const out: Item[] = [];
    const [so, ss, mo, ms] = fontes.map((q) => q.data);
    for (const [d, loja] of [[so, "ottz"], [ss, "svl"]] as [any, Loja][]) {
      for (const c of (d?.conversas ?? [])) {
        if (!TIPOS_TEXTO.has(c.ultima_msg_tipo)) continue;
        out.push({ chave: `shopee:${loja}:${c.conversation_id}`, mkt: "shopee", loja, tipo: "pos", ref: c.conversation_id,
          nome: c.comprador ?? "comprador", foto: c.foto, prev: c.ultima_msg || "", em: c.ultima_msg_em,
          naoLidas: c.nao_lidas ?? 0, deNos: !!c.ultima_msg_de_nos, bloqueada: false, motivoBloqueio: null, compradorId: c.comprador_id, produto: null });
      }
    }
    for (const [d, loja] of [[mo, "ottz"], [ms, "svl"]] as [any, Loja][]) {
      for (const q of (d?.perguntas ?? [])) {
        out.push({ chave: `ml:${loja}:perg:${q.id}`, mkt: "ml", loja, tipo: "perg", ref: q.id,
          nome: q.anuncio?.titulo ? "Pergunta no anúncio" : "Pergunta", foto: q.anuncio?.foto ?? null, prev: q.texto, em: q.em,
          naoLidas: 1, deNos: false, bloqueada: false, motivoBloqueio: null, compradorId: q.comprador_id, produto: q.anuncio?.titulo ?? null });
      }
      for (const v of (d?.pos_venda ?? [])) {
        out.push({ chave: `ml:${loja}:pos:${v.pack}`, mkt: "ml", loja, tipo: "pos", ref: v.pack,
          nome: "Cliente do pedido", foto: null, prev: v.ultima_msg || "", em: v.ultima_em,
          naoLidas: v.nao_lidas ?? 0, deNos: !!v.ultima_de_nos, bloqueada: !!v.bloqueada, motivoBloqueio: v.motivo_bloqueio ?? null,
          compradorId: v.comprador_id, produto: v.produto ?? null });
      }
    }
    return out.sort((a, b) => String(b.em).localeCompare(String(a.em)));
  }, [fontes.map((q) => q.dataUpdatedAt).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendente = (it: Item) => !it.deNos && !respondidas.has(it.chave) && resolvidas[it.chave] !== String(it.em);
  const fila = useMemo(() => itens.filter((it) => {
    if (!pendente(it)) return false;
    if (fMkt !== "todos" && it.mkt !== fMkt) return false;
    if (fTipo === "pos" && it.tipo !== "pos") return false;
    if (fTipo === "perg" && it.tipo !== "perg") return false;
    if (fTipo === "atencao" && !(it.bloqueada || sugs[it.chave]?.precisa_humano)) return false;
    if (busca && !`${it.nome} ${it.prev} ${it.produto ?? ""} ${it.ref}`.toLowerCase().includes(busca.toLowerCase())) return false;
    return true;
  }), [itens, fMkt, fTipo, busca, respondidas, resolvidas, sugs]); // eslint-disable-line react-hooks/exhaustive-deps

  const todosPend = itens.filter(pendente);
  const cont = {
    todos: todosPend.length,
    shopee: todosPend.filter((i) => i.mkt === "shopee").length,
    ml: todosPend.filter((i) => i.mkt === "ml").length,
    pos: todosPend.filter((i) => i.tipo === "pos").length,
    perg: todosPend.filter((i) => i.tipo === "perg").length,
    atencao: todosPend.filter((i) => i.bloqueada || sugs[i.chave]?.precisa_humano).length,
    atrasadas: todosPend.filter((i) => minutosDesde(i.em) > 12 * 60).length,
  };

  const kpiQ = useQuery({
    queryKey: ["atendimento", "kpi"],
    queryFn: async () => {
      const ini = new Date(); ini.setHours(0, 0, 0, 0);
      const sete = new Date(Date.now() - 7 * 864e5).toISOString();
      const [a, b] = await Promise.all([
        supabaseExternal.from("shopee_chat_respostas" as any).select("criado_em, ok, editado").gte("criado_em", sete).limit(2000),
        supabaseExternal.from("atendimento_respostas" as any).select("criado_em, ok, editado").gte("criado_em", sete).limit(2000),
      ]);
      const rows = [...((a.data as any[]) ?? []), ...((b.data as any[]) ?? [])].filter((r) => r.ok);
      const hoje = rows.filter((r) => new Date(r.criado_em) >= ini).length;
      const comIa = rows.filter((r) => r.editado !== null && r.editado !== undefined);
      const semMudar = comIa.length ? Math.round(100 * comIa.filter((r) => r.editado === false).length / comIa.length) : null;
      return { hoje, semMudar };
    },
    refetchInterval: 120_000,
  });

  const atual = fila.find((i) => i.chave === s.c) ?? itens.find((i) => i.chave === s.c) ?? fila[0] ?? null;
  const idx = atual ? fila.findIndex((i) => i.chave === atual.chave) : -1;
  const irPara = (it: Item | undefined) => it && set({ c: it.chave });
  const proxima = () => irPara(fila[idx + 1] ?? fila[idx - 1]);

  // gera (ou regenera) a sugestão de um item
  const gerar = useCallback(async (it: Item, instrucao = "") => {
    setSugs((m) => ({ ...m, [it.chave]: { ...(m[it.chave] ?? {}), sugestao: m[it.chave]?.sugestao, erro: undefined, modelo: "…" } }));
    try {
      const r: Sug = it.mkt === "shopee"
        ? await chamar("shopee-chat", "sugerir", { loja: it.loja, conversa: it.ref }, instrucao ? { instrucao } : {})
        : await chamar("ml-chat", "sugerir", { conta: it.loja, tipo: it.tipo === "perg" ? "pergunta" : "pos_venda", referencia: it.ref }, instrucao ? { instrucao } : {});
      if (r.erro) throw new Error(r.erro);
      setSugs((m) => ({ ...m, [it.chave]: r }));
    } catch (e) {
      setSugs((m) => ({ ...m, [it.chave]: { ...(m[it.chave] ?? {}), erro: (e as Error).message, modelo: undefined } }));
    }
  }, []);

  // ao abrir: sugere a atual e já prepara a próxima
  useEffect(() => {
    if (!atual || atual.bloqueada) return;
    if (!sugs[atual.chave]) void gerar(atual);
    const prox = fila[idx + 1];
    if (prox && !prox.bloqueada && !sugs[prox.chave]) void gerar(prox);
  }, [atual?.chave]); // eslint-disable-line react-hooks/exhaustive-deps

  const enviar = async (it: Item, texto: string) => {
    const sug = sugs[it.chave]?.sugestao ?? null;
    if (it.mkt === "shopee") {
      const comprador = it.compradorId ?? sugs[it.chave]?.contexto?.comprador_id;
      if (!comprador) throw new Error("Não achei o comprador desta conversa.");
      await chamar("shopee-chat", "responder", { loja: it.loja, conversa: it.ref },
        { comprador_id: comprador, texto, sugestao_ia: sug, confirmar: "1", por: perfil?.nome ?? null });
    } else {
      await chamar("ml-chat", "responder", { conta: it.loja },
        { tipo: it.tipo === "perg" ? "pergunta" : "pos_venda", referencia: it.ref, texto, comprador_id: it.compradorId ?? undefined,
          sugestao_ia: sug, confirmar: "1", por: perfil?.nome ?? null });
    }
    setRespondidas((x) => new Set(x).add(it.chave));
    void qc.invalidateQueries({ queryKey: ["atendimento", "kpi"] });
  };

  const resolver = (it: Item) => {
    const n = { ...resolvidas, [it.chave]: String(it.em) };
    setResolvidas(n);
    try { localStorage.setItem(RESOLVIDAS, JSON.stringify(n)); } catch { /* sem armazenamento: vale só nesta sessão */ }
    proxima();
  };

  // atalhos J/K fora de campos de texto
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "j") irPara(fila[idx + 1]);
      if (e.key === "k") irPara(fila[idx - 1]);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const Chip = ({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button onClick={onClick} aria-pressed={ativo}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        ativo ? "border-[var(--pm-a)] bg-[var(--pm-a)] text-[var(--pm-oa)]" : "border-[var(--pm-bc)] hover:bg-[var(--pm-hv)]")}>
      {children}
    </button>
  );

  return (
    <div className="pm-ui mx-auto max-w-[1400px] space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold text-[var(--pm-t)]">Central de Atendimento</h1>
        <Kpi rotulo="Sem resposta" valor={cont.todos} alerta={cont.todos > 0} />
        <Kpi rotulo="Atrasadas (+12 h)" valor={cont.atrasadas} alerta={cont.atrasadas > 0} />
        <Kpi rotulo="Respondidas hoje" valor={kpiQ.data?.hoje ?? "—"} />
        <Kpi rotulo="IA usada sem mudar (7 d)" valor={kpiQ.data?.semMudar != null ? `${kpiQ.data.semMudar}%` : "—"} />
        <button onClick={() => fontes.forEach((q) => q.refetch())} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--pm-bc)] px-3 py-1.5 text-sm hover:bg-[var(--pm-hv)]">
          <RefreshCw className={cn("h-4 w-4", fontes.some((q) => q.isFetching) && "animate-spin")} /> Atualizar
        </button>
      </div>
      {errosFonte.length > 0 && (
        <div className="rounded-lg border border-[var(--pm-r)] bg-[var(--pm-rs)] px-3 py-2 text-sm text-[var(--pm-r)]">Não consegui ler: {errosFonte.join(" · ")}</div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[330px_minmax(0,1fr)] xl:grid-cols-[330px_minmax(0,1fr)_290px]">
        {/* fila */}
        <aside className="min-w-0 rounded-2xl border border-[var(--pm-b)] bg-[var(--pm-s)]">
          <div className="space-y-2 border-b border-[var(--pm-b)] p-3">
            <div className="flex flex-wrap gap-1">
              <Chip ativo={fMkt === "todos"} onClick={() => set({ mk: undefined, c: undefined })}>Todos <span className="opacity-80">{cont.todos}</span></Chip>
              <Chip ativo={fMkt === "shopee"} onClick={() => set({ mk: "shopee", c: undefined })}><img src="/logos/shopee-icon.png" alt="" className="h-3.5 w-3.5" />Shopee <span className="opacity-80">{cont.shopee}</span></Chip>
              <Chip ativo={fMkt === "ml"} onClick={() => set({ mk: "ml", c: undefined })}><img src="/logos/ml-icon.png" alt="" className="h-3.5 w-3.5" />Mercado Livre <span className="opacity-80">{cont.ml}</span></Chip>
            </div>
            <div className="flex flex-wrap gap-1">
              <Chip ativo={fTipo === "tudo"} onClick={() => set({ t: undefined, c: undefined })}>Tudo</Chip>
              <Chip ativo={fTipo === "pos"} onClick={() => set({ t: "pos", c: undefined })}>Pós-venda {cont.pos}</Chip>
              <Chip ativo={fTipo === "perg"} onClick={() => set({ t: "perg", c: undefined })}>Perguntas {cont.perg}</Chip>
              <Chip ativo={fTipo === "atencao"} onClick={() => set({ t: "atencao", c: undefined })}>Precisa de atenção {cont.atencao}</Chip>
            </div>
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar cliente, pedido ou produto"
              className="w-full rounded-lg border border-[var(--pm-bc)] bg-[var(--pm-s)] px-3 py-1.5 text-sm outline-none focus:border-[var(--pm-a)]" />
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {carregando && <div className="flex items-center gap-2 p-4 text-sm text-[var(--pm-t3)]"><Loader2 className="h-4 w-4 animate-spin" /> Lendo Shopee e Mercado Livre…</div>}
            {!carregando && fila.length === 0 && <div className="p-4 text-sm text-[var(--pm-t3)]">Nada esperando resposta neste filtro.</div>}
            {fila.map((it) => {
              const sg = sugs[it.chave];
              const atraso = minutosDesde(it.em) > 12 * 60;
              const ativo = atual?.chave === it.chave;
              return (
                <button key={it.chave} onClick={() => set({ c: it.chave })}
                  className={cn("relative grid w-full grid-cols-[34px_minmax(0,1fr)] gap-2.5 border-b border-[var(--pm-b)] px-3 py-2.5 text-left hover:bg-[var(--pm-hv)]", ativo && "bg-[var(--pm-as)]")}>
                  {ativo && <span className="absolute inset-y-2 left-0 w-[3px] rounded bg-[var(--pm-a)]" />}
                  <MarcaIcone it={it} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{it.nome}</span>
                      <span className={cn("ml-auto shrink-0 text-[11px] tabular-nums", atraso ? "font-semibold text-[var(--pm-r)]" : "text-[var(--pm-t3)]")}>{espera(it.em)}</span>
                    </span>
                    <span className="block truncate text-xs text-[var(--pm-t2)]">{it.prev || "—"}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Etiqueta>{NOME_LOJA[it.mkt][it.loja]}</Etiqueta>
                      <Etiqueta>{it.tipo === "perg" ? "Pergunta" : "Pós-venda"}</Etiqueta>
                      {it.bloqueada ? <Etiqueta cor="r">Bloqueada</Etiqueta>
                        : sg?.precisa_humano ? <Etiqueta cor="am">Atenção</Etiqueta>
                        : sg?.sugestao && sg.modelo !== "…" ? <Etiqueta cor="a">Resposta pronta</Etiqueta> : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* conversa */}
        <section className="min-w-0 rounded-2xl border border-[var(--pm-b)] bg-[var(--pm-s)]">
          {atual ? (
            <Conversa key={atual.chave} it={atual} sug={sugs[atual.chave]} gerar={gerar}
              enviar={enviar} resolver={resolver} proxima={proxima} />
          ) : (
            <div className="flex min-h-[420px] items-center justify-center p-6 text-sm text-[var(--pm-t3)]">{carregando ? "Carregando…" : "Tudo respondido por aqui."}</div>
          )}
        </section>

        {/* contexto */}
        <aside className="hidden min-w-0 space-y-3 xl:block">
          {atual && <Contexto it={atual} sug={sugs[atual.chave]} />}
        </aside>
      </div>
    </div>
  );
}

function Kpi({ rotulo, valor, alerta }: { rotulo: string; valor: number | string; alerta?: boolean }) {
  return (
    <div className="min-w-[112px] rounded-xl border border-[var(--pm-b)] bg-[var(--pm-s)] px-3 py-1.5">
      <div className="text-[10.5px] uppercase tracking-wide text-[var(--pm-t3)]">{rotulo}</div>
      <div className={cn("text-lg font-semibold tabular-nums", alerta && "text-[var(--pm-r)]")}>{valor}</div>
    </div>
  );
}
function Etiqueta({ children, cor }: { children: React.ReactNode; cor?: "a" | "am" | "r" }) {
  const c = cor === "a" ? "bg-[var(--pm-as)] text-[var(--pm-at)]" : cor === "am" ? "bg-[var(--pm-ams)] text-[var(--pm-am)]" : cor === "r" ? "bg-[var(--pm-rs)] text-[var(--pm-r)]" : "bg-[var(--pm-s2)] text-[var(--pm-t3)]";
  return <span className={cn("rounded-md px-1.5 py-px text-[10.5px]", c)}>{children}</span>;
}
function MarcaIcone({ it }: { it: Item }) {
  return it.foto
    ? <span className="relative h-[34px] w-[34px]"><img src={it.foto} alt="" className="h-[34px] w-[34px] rounded-lg object-cover" />
        <img src={it.mkt === "shopee" ? "/logos/shopee-icon.png" : "/logos/ml-icon.png"} alt="" className="absolute -bottom-1 -right-1 h-4 w-4 rounded-sm bg-[var(--pm-s)]" /></span>
    : <span className="grid h-[34px] w-[34px] place-items-center rounded-lg bg-[var(--pm-s2)]"><img src={it.mkt === "shopee" ? "/logos/shopee-icon.png" : "/logos/ml-icon.png"} alt="" className="h-5 w-5" /></span>;
}

function useMensagens(it: Item) {
  return useQuery({
    queryKey: ["atendimento", "msgs", it.chave],
    gcTime: 60_000, staleTime: 0, placeholderData: undefined,
    queryFn: async (): Promise<{ msgs: Msg[]; extra: any }> => {
      if (it.mkt === "shopee") {
        const r = await chamar("shopee-chat", "mensagens", { loja: it.loja, conversa: it.ref, limite: "40" });
        return { msgs: (r.mensagens ?? []).slice().reverse().map((m: any) => ({ id: m.message_id, deNos: m.de_nos, texto: m.texto || `[${m.tipo}]`, em: m.em, origem: m.origem })), extra: null };
      }
      if (it.tipo === "perg") {
        const r = await chamar("ml-chat", "pergunta", { conta: it.loja, id: it.ref });
        return { msgs: [{ id: it.ref, deNos: false, texto: r.pergunta?.texto ?? it.prev, em: r.pergunta?.em ?? it.em }], extra: r };
      }
      const r = await chamar("ml-chat", "conversa", { conta: it.loja, pack: it.ref });
      return { msgs: (r.mensagens ?? []).map((m: any) => ({ id: m.id, deNos: m.de_nos, texto: m.texto || (m.anexos?.length ? `[anexo: ${m.anexos.join(", ")}]` : ""), em: m.em })), extra: r };
    },
  });
}

function Conversa({ it, sug, gerar, enviar, resolver, proxima }: {
  it: Item; sug?: Sug; gerar: (it: Item, instrucao?: string) => Promise<void>;
  enviar: (it: Item, texto: string) => Promise<void>; resolver: (it: Item) => void; proxima: () => void;
}) {
  const q = useMensagens(it);
  const [texto, setTexto] = useState("");
  const [editado, setEditado] = useState(false);
  const [orient, setOrient] = useState("");
  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef<HTMLDivElement>(null);
  const gerando = sug?.modelo === "…";
  const lim = LIMITE(it);
  const bloqueada = it.bloqueada || !!q.data?.extra?.bloqueada;

  useEffect(() => { if (sug?.sugestao != null && !editado) setTexto(sug.sugestao); }, [sug?.sugestao]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fimRef.current?.scrollIntoView({ block: "end" }); }, [q.data]);

  const mandar = async () => {
    const t = texto.trim();
    if (!t || t.length > lim || enviando) return;
    setEnviando(true);
    try { await enviar(it, t); toast.success(`Enviado para ${it.mkt === "shopee" ? it.nome : NOME_LOJA[it.mkt][it.loja]}.`); proxima(); }
    catch (e) { toast.error(`Não enviou: ${(e as Error).message}`); }
    finally { setEnviando(false); }
  };

  return (
    <div className="flex min-h-[640px] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--pm-b)] px-4 py-3">
        <MarcaIcone it={it} />
        <div className="min-w-0">
          <div className="truncate font-medium">{it.nome}</div>
          <div className="truncate text-xs text-[var(--pm-t3)]">{NOME_LOJA[it.mkt][it.loja]} · {it.tipo === "perg" ? "pergunta pública no anúncio" : it.mkt === "ml" ? `pedido ${it.ref}` : "chat do comprador"}</div>
        </div>
        <button onClick={() => resolver(it)} className="ml-auto rounded-lg border border-[var(--pm-bc)] px-3 py-1.5 text-sm hover:bg-[var(--pm-hv)]">Marcar como resolvida</button>
      </div>

      <div className="flex max-h-[44vh] min-h-[220px] flex-1 flex-col gap-2.5 overflow-y-auto bg-[var(--pm-s2)] p-4">
        {q.isLoading && <div className="flex items-center gap-2 text-sm text-[var(--pm-t3)]"><Loader2 className="h-4 w-4 animate-spin" /> Lendo a conversa…</div>}
        {q.error && <div className="text-sm text-[var(--pm-r)]">Não consegui ler a conversa: {(q.error as Error).message}</div>}
        {(q.data?.msgs ?? []).map((m) => {
          const auto = m.origem === "server";
          return (
            <div key={m.id} className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-[13.5px] leading-relaxed shadow-[var(--pm-sh)]",
              auto ? "self-center border border-dashed border-[var(--pm-bc)] bg-transparent text-xs text-[var(--pm-t3)]"
                : m.deNos ? "self-end rounded-br-sm bg-[var(--pm-a)] text-[var(--pm-oa)]" : "self-start rounded-bl-sm bg-[var(--pm-s)]")}>
              <div className="whitespace-pre-wrap break-words">{m.texto}</div>
              <div className={cn("mt-1 text-[10.5px]", m.deNos && !auto ? "opacity-75" : "text-[var(--pm-t3)]")}>
                {dataHora(m.em)}{m.origem === "openapi" ? " · sistema" : auto ? " · automático Shopee" : ""}
              </div>
            </div>
          );
        })}
        <div ref={fimRef} />
      </div>

      <div className="space-y-2.5 border-t border-[var(--pm-b)] p-4">
        {bloqueada ? (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--pm-rs)] px-3 py-2 text-sm text-[var(--pm-r)]">
            <Ban className="mt-0.5 h-4 w-4 shrink-0" />
            <span>O Mercado Livre bloqueou esta conversa ({it.motivoBloqueio ?? q.data?.extra?.motivo_bloqueio ?? "sem motivo"}): ela não aceita resposta. Se houver reclamação aberta, responda pela aba Devoluções.</span>
          </div>
        ) : (
          <>
            {sug?.precisa_humano && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--pm-ams)] px-3 py-2 text-sm text-[var(--pm-am)]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span><b>Precisa de atenção:</b> {sug.motivo ?? "a IA recomenda que uma pessoa avalie antes de enviar"}. Confira antes de enviar.</span>
              </div>
            )}
            {it.tipo === "perg" && (
              <div className="flex items-center gap-2 rounded-lg bg-[var(--pm-as)] px-3 py-2 text-sm text-[var(--pm-at)]">
                <Eye className="h-4 w-4 shrink-0" /> Esta resposta fica <b>pública</b> no anúncio do Mercado Livre.
              </div>
            )}
            {sug?.erro && <div className="text-sm text-[var(--pm-r)]">A IA não respondeu: {sug.erro}</div>}
            <div className="rounded-xl border border-[var(--pm-a)] bg-[var(--pm-as)] p-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-[var(--pm-at)]">
                <Sparkles className="h-3.5 w-3.5" /> Resposta sugerida pela IA
                <span className="ml-auto font-normal text-[var(--pm-t3)]">{gerando ? "escrevendo…" : "usa o pedido, o envio e o produto"}</span>
              </div>
              <div className="relative">
                <textarea value={texto} onChange={(e) => { setTexto(e.target.value); setEditado(true); }}
                  onKeyDown={(e) => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); void mandar(); } }}
                  rows={5} aria-label="Resposta"
                  placeholder={gerando ? "A IA está escrevendo…" : "Escreva a resposta"}
                  className="w-full resize-y rounded-lg border border-[var(--pm-bc)] bg-[var(--pm-s)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--pm-a)]" />
                {gerando && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-[var(--pm-t3)]" />}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-[var(--pm-t3)]">Ajustar:</span>
              {AJUSTES.map(([rot, inst]) => (
                <button key={rot} disabled={gerando} onClick={() => { setEditado(false); void gerar(it, inst); }}
                  className="rounded-full border border-[var(--pm-bc)] px-2.5 py-1 text-xs hover:bg-[var(--pm-hv)] disabled:opacity-50">{rot}</button>
              ))}
              <button disabled={gerando} onClick={() => { setEditado(false); void gerar(it, orient.trim()); }}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--pm-bc)] px-2.5 py-1 text-xs hover:bg-[var(--pm-hv)] disabled:opacity-50">
                <RotateCcw className="h-3 w-3" /> Refazer
              </button>
              <input value={orient} onChange={(e) => setOrient(e.target.value)} placeholder="ou diga à IA o que mudar"
                onKeyDown={(e) => { if (e.key === "Enter" && orient.trim()) { setEditado(false); void gerar(it, orient.trim()); } }}
                className="min-w-[180px] flex-1 rounded-full border border-[var(--pm-bc)] bg-[var(--pm-s)] px-3 py-1 text-xs outline-none focus:border-[var(--pm-a)]" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("text-xs tabular-nums", texto.length > lim ? "font-semibold text-[var(--pm-r)]" : "text-[var(--pm-t3)]")}>{texto.length} / {lim}</span>
              <span className="hidden text-[11px] text-[var(--pm-t3)] sm:inline">Ctrl+Enter envia · J / K troca de conversa</span>
              <div className="ml-auto flex gap-2">
                <button onClick={proxima} className="rounded-lg border border-[var(--pm-bc)] px-3 py-1.5 text-sm hover:bg-[var(--pm-hv)]">Pular</button>
                <button onClick={mandar} disabled={!texto.trim() || texto.length > lim || enviando || gerando}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--pm-a)] px-3.5 py-1.5 text-sm font-medium text-[var(--pm-oa)] hover:bg-[var(--pm-ah)] disabled:opacity-50">
                  {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar e ir para a próxima
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--pm-b)] bg-[var(--pm-s)] p-3.5">
      <h3 className="mb-2 text-[13px] font-semibold">{titulo}</h3>
      {children}
    </div>
  );
}
function Linha({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3 text-[12.5px]"><span className="text-[var(--pm-t3)]">{k}</span><span className="text-right tabular-nums">{v ?? "—"}</span></div>;
}

const STATUS_ENVIO: Record<string, string> = {
  ready_to_ship: "Pronto para envio", shipped: "A caminho", delivered: "Entregue", not_delivered: "Não entregue",
  handling: "Em preparação", pending: "Pendente", cancelled: "Cancelado",
};

function Contexto({ it, sug }: { it: Item; sug?: Sug }) {
  const q = useMensagens(it);
  const extra = q.data?.extra;
  if (it.mkt === "ml" && it.tipo === "perg") {
    const a = extra?.anuncio;
    return (
      <>
        <Bloco titulo="Anúncio">
          <div className="flex items-center gap-2.5">
            {a?.foto ? <img src={a.foto} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-lg bg-[var(--pm-s2)]"><Package className="h-5 w-5 text-[var(--pm-t3)]" /></div>}
            <div className="min-w-0 text-[13px] font-medium leading-snug">{a?.titulo ?? it.produto ?? "—"}</div>
          </div>
          <div className="mt-2 space-y-1">
            <Linha k="Preço" v={a?.preco != null ? `R$ ${Number(a.preco).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : null} />
            <Linha k="Estoque" v={a?.estoque} />
          </div>
          {a?.link && <a href={a.link} target="_blank" rel="noreferrer" className="mt-2 block text-xs text-[var(--pm-at)] underline">Ver anúncio</a>}
        </Bloco>
        {(extra?.anteriores ?? []).length > 0 && (
          <Bloco titulo="Respostas anteriores da loja">
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {extra.anteriores.slice(0, 5).map((x: any, i: number) => (
                <div key={i} className="text-xs"><div className="text-[var(--pm-t3)]">P: {x.p}</div><div>R: {x.r}</div></div>
              ))}
            </div>
          </Bloco>
        )}
      </>
    );
  }
  if (it.mkt === "ml") {
    const pedidos: any[] = extra?.pedidos ?? [];
    return (
      <>
        {pedidos.map((p) => (
          <Bloco key={p.pedido} titulo={`Pedido ${p.pedido}`}>
            {(p.itens ?? []).map((i: any) => (
              <div key={i.mlb} className="mb-2 flex items-center gap-2.5">
                {i.foto ? <img src={i.foto} alt="" className="h-11 w-11 rounded-lg object-cover" /> : <div className="grid h-11 w-11 place-items-center rounded-lg bg-[var(--pm-s2)]"><Package className="h-4 w-4 text-[var(--pm-t3)]" /></div>}
                <div className="min-w-0 text-xs leading-snug"><div className="font-medium">{i.qtd}× {i.titulo}</div>{i.variacao && <div className="text-[var(--pm-t3)]">{i.variacao}</div>}</div>
              </div>
            ))}
            <div className="space-y-1">
              <Linha k="Situação" v={p.status} />
              <Linha k="Envio" v={p.envio ? (STATUS_ENVIO[p.envio.status] ?? p.envio.status) : null} />
              <Linha k="Despachar até" v={dataBR(p.envio?.despachar_ate)} />
              <Linha k="Previsão de entrega" v={dataBR(p.envio?.previsao)} />
              <Linha k="Rastreio" v={p.envio?.rastreio} />
            </div>
          </Bloco>
        ))}
        {q.isLoading && <Bloco titulo="Pedido"><div className="text-xs text-[var(--pm-t3)]">Carregando…</div></Bloco>}
        {!q.isLoading && pedidos.length === 0 && <Bloco titulo="Pedido"><div className="text-xs text-[var(--pm-t3)]">{it.produto ?? "Sem dados do pedido."}</div></Bloco>}
      </>
    );
  }
  // Shopee: o contexto vem junto da sugestão da IA (pedidos citados na conversa + produto de origem)
  const ctx = sug?.contexto;
  return (
    <>
      {(ctx?.produtos ?? []).map((p: any) => (
        <Bloco key={p.anuncio} titulo="Produto">
          <div className="flex gap-2.5">
            {p.foto && <img src={p.foto} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
            <div className="text-[13px] font-medium leading-snug">{p.nome}</div>
          </div>
          <div className="mt-2 space-y-1"><Linha k="Preço" v={p.preco != null ? `R$ ${p.preco}` : null} /><Linha k="Estoque" v={p.estoque} /></div>
          {(p.variacoes ?? []).length > 0 && (
            <div className="mt-2 space-y-0.5 border-t border-[var(--pm-b)] pt-2 text-xs">
              {p.variacoes.map((v: any, k: number) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="min-w-0 truncate">{v.nome || v.sku}</span>
                  <span className="shrink-0 text-[var(--pm-t2)]">{v.preco != null ? `R$ ${Number(v.preco).toFixed(2).replace(".", ",")}` : "—"} · {v.estoque ?? "—"} un</span>
                </div>
              ))}
            </div>
          )}
        </Bloco>
      ))}
      {(ctx?.pedidos ?? []).map((p: any) => (
        <Bloco key={p.pedido} titulo={`Pedido ${p.pedido}`}>
          <div className="mb-2 space-y-0.5 text-xs">{(p.itens ?? []).map((i: string, k: number) => <div key={k} className="flex gap-1.5"><ShoppingBag className="mt-0.5 h-3 w-3 shrink-0 text-[var(--pm-t3)]" />{i}</div>)}</div>
          <div className="space-y-1">
            <Linha k="Situação" v={p.status_shopee} />
            <Linha k="Enviar até" v={dataBR(p.enviar_ate)} />
            <Linha k="No galpão" v={p.situacao_no_galpao} />
            <Linha k="Rastreio" v={p.rastreio} />
            {p.devolucao && <Linha k="Devolução" v={`${p.devolucao.status}${p.devolucao.solucao ? ` · ${p.devolucao.solucao}` : ""}`} />}
          </div>
        </Bloco>
      ))}
      {!ctx && <Bloco titulo="Pedido"><div className="text-xs text-[var(--pm-t3)]">Os dados do pedido aparecem junto com a resposta da IA.</div></Bloco>}
      {ctx && (ctx.pedidos ?? []).length === 0 && <Bloco titulo="Pedido"><div className="text-xs text-[var(--pm-t3)]">Nenhum pedido citado nesta conversa.</div></Bloco>}
    </>
  );
}
