import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Loader2, MessageCircle, Package, RefreshCw, Send, ShoppingBag } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Atendimento Shopee — 26/nov/2026. Caixa de conversas das duas lojas (Ottz e
// Bumi) com resposta sugerida pela IA (shopee-chat ?modulo=sugerir: conversa +
// pedidos citados + produto -> GPT-5.5, assinatura "Equipe Ottz"/"Equipe Bumi",
// nunca promete reembolso/troca/desconto). A pessoa confere, ajusta e envia
// (?modulo=responder&confirmar=1, só com login); cada envio fica em
// shopee_chat_respostas com a sugestão e se foi editada.
// ============================================================================

type Loja = "ottz" | "svl";
type Filtro = "sem_resposta" | "nao_lidas" | "todas";

export const Route = createFileRoute("/atendimento-shopee")({
  validateSearch: (s: Record<string, unknown>): { loja?: Loja; f?: Filtro; c?: string } => ({
    loja: s.loja === "svl" ? "svl" : undefined,
    f: s.f === "nao_lidas" || s.f === "todas" ? s.f : undefined,
    c: typeof s.c === "string" && /^\d+$/.test(s.c) ? s.c : undefined,
  }),
  component: AtendimentoShopee,
});

interface Conversa {
  conversation_id: string; comprador_id: string | null; comprador: string | null; foto: string | null;
  nao_lidas: number; ultima_msg: string; ultima_msg_tipo: string | null; ultima_msg_de_nos: boolean; ultima_msg_em: string | null;
}
interface Mensagem { message_id: string; de_nos: boolean; tipo: string; texto: string; em: string | null; origem: string | null; item_id: string | null; order_sn: string | null }
interface Sugestao {
  sugestao?: string; precisa_humano?: boolean; motivo?: string | null; modelo?: string; erro?: string;
  contexto?: { pedidos: any[]; produtos: any[]; comprador_id: string | null };
}

const NOME_LOJA: Record<Loja, string> = { ottz: "Ottz", svl: "Bumi" };

async function chamar(modulo: string, params: Record<string, string>, body?: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const qs = new URLSearchParams({ modulo, ...params }).toString();
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-chat?${qs}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.erro || `HTTP ${r.status}`);
  return j;
}

const hora = (s: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const dia = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const h = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  return dia === hoje ? h : `${dia.slice(0, 5)} ${h}`;
};

const ORIGEM: Record<string, string> = { openapi: "sistema", server: "automático Shopee" };

function AtendimentoShopee() {
  const s = Route.useSearch();
  const nav = useNavigate({ from: "/atendimento-shopee" });
  const loja: Loja = s.loja ?? "ottz";
  const filtro: Filtro = s.f ?? "sem_resposta";
  const set = (v: Partial<{ loja: Loja | undefined; f: Filtro | undefined; c: string | undefined }>) =>
    nav({ search: (p: any) => ({ ...p, ...v }), resetScroll: false });

  const convQ = useQuery({
    queryKey: ["atend-shopee", "conversas", loja],
    queryFn: () => chamar("conversas", { loja, limite: "60" }),
    refetchInterval: 60_000,
    placeholderData: undefined,
    staleTime: 20_000,
  });
  const conversas: Conversa[] = convQ.data?.loja === loja ? convQ.data.conversas ?? [] : [];
  const visiveis = useMemo(() => conversas.filter((c) => {
    if (c.ultima_msg_tipo && !["text", "image", "video", "order", "item", "product", "sticker"].includes(c.ultima_msg_tipo) && filtro !== "todas") return false;
    if (filtro === "sem_resposta") return !c.ultima_msg_de_nos;
    if (filtro === "nao_lidas") return c.nao_lidas > 0;
    return true;
  }), [conversas, filtro]);
  const contSemResposta = conversas.filter((c) => !c.ultima_msg_de_nos && (!c.ultima_msg_tipo || ["text", "image", "video", "order", "item", "product", "sticker"].includes(c.ultima_msg_tipo))).length;
  const atual = conversas.find((c) => c.conversation_id === s.c) ?? null;

  return (
    <div className="pm-ui mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <MessageCircle className="h-6 w-6 text-[var(--pm-ac)]" />
        <div className="mr-auto">
          <h1 className="text-xl font-semibold">Atendimento Shopee</h1>
          <p className="text-sm text-muted-foreground">Conversas com os compradores. A IA sugere a resposta; você confere e envia.</p>
        </div>
        <div className="flex rounded-full border p-0.5">
          {(["ottz", "svl"] as Loja[]).map((l) => (
            <button key={l} onClick={() => set({ loja: l === "ottz" ? undefined : l, c: undefined })}
              className={cn("rounded-full px-4 py-1.5 text-sm", loja === l ? "bg-[var(--pm-ac)] text-white" : "hover:bg-muted")}>
              Shopee {NOME_LOJA[l]}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={() => convQ.refetch()} disabled={convQ.isFetching}>
          <RefreshCw className={cn("mr-1 h-4 w-4", convQ.isFetching && "animate-spin")} /> Atualizar
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-[340px_1fr]">
        <div className="rounded-xl border bg-card">
          <div className="flex gap-1 border-b p-2 text-sm">
            {([["sem_resposta", `Sem resposta (${contSemResposta})`], ["nao_lidas", "Não lidas"], ["todas", "Todas"]] as [Filtro, string][]).map(([k, t]) => (
              <button key={k} onClick={() => set({ f: k === "sem_resposta" ? undefined : k })}
                className={cn("rounded-full px-3 py-1", filtro === k ? "bg-[var(--pm-ac)] text-white" : "hover:bg-muted")}>{t}</button>
            ))}
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {convQ.isLoading && <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lendo conversas…</div>}
            {convQ.error && <div className="p-4 text-sm text-red-600">Erro ao ler: {(convQ.error as Error).message}</div>}
            {!convQ.isLoading && visiveis.length === 0 && !convQ.error && <div className="p-4 text-sm text-muted-foreground">Nenhuma conversa neste filtro.</div>}
            {visiveis.map((c) => (
              <button key={c.conversation_id} onClick={() => set({ c: c.conversation_id })}
                className={cn("flex w-full items-start gap-3 border-b px-3 py-2.5 text-left hover:bg-muted/60", s.c === c.conversation_id && "bg-muted")}>
                {c.foto ? <img src={c.foto} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <div className="h-9 w-9 shrink-0 rounded-full bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.comprador ?? "comprador"}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{hora(c.ultima_msg_em)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate text-xs", c.ultima_msg_de_nos ? "text-muted-foreground" : "text-foreground")}>
                      {c.ultima_msg_de_nos ? "Você: " : ""}{c.ultima_msg || `[${c.ultima_msg_tipo}]`}
                    </span>
                    {c.nao_lidas > 0 && <span className="ml-auto shrink-0 rounded-full bg-[var(--pm-ac)] px-1.5 text-[10px] font-semibold text-white">{c.nao_lidas}</span>}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card">
          {!s.c ? (
            <div className="flex h-full min-h-[300px] items-center justify-center p-6 text-sm text-muted-foreground">Escolha uma conversa à esquerda.</div>
          ) : (
            <PainelConversa key={`${loja}-${s.c}`} loja={loja} conversa={s.c} resumo={atual} />
          )}
        </div>
      </div>
    </div>
  );
}

function PainelConversa({ loja, conversa, resumo }: { loja: Loja; conversa: string; resumo: Conversa | null }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const msgQ = useQuery({
    queryKey: ["atend-shopee", "mensagens", loja, conversa],
    queryFn: () => chamar("mensagens", { loja, conversa, limite: "40" }),
    placeholderData: undefined, gcTime: 0, staleTime: 0,
  });
  const mensagens: Mensagem[] = ((msgQ.data?.mensagens ?? []) as Mensagem[]).slice().reverse();
  const [sug, setSug] = useState<Sugestao | null>(null);
  const [gerando, setGerando] = useState(false);
  const [texto, setTexto] = useState("");
  const [instrucao, setInstrucao] = useState("");
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const gerar = async (inst = "") => {
    setGerando(true);
    try {
      const r: Sugestao = await chamar("sugerir", { loja, conversa }, inst ? { instrucao: inst } : {});
      if (r.erro) throw new Error(r.erro);
      setSug(r); setTexto(r.sugestao ?? "");
    } catch (e) { toast.error(`IA: ${(e as Error).message}`); }
    finally { setGerando(false); }
  };
  // rascunho automático ao abrir uma conversa em que o cliente espera resposta
  useEffect(() => { if (resumo && !resumo.ultima_msg_de_nos) void gerar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conversa]);

  const compradorId = sug?.contexto?.comprador_id ?? resumo?.comprador_id ?? null;
  const enviar = async () => {
    if (!compradorId) { toast.error("Não achei o comprador desta conversa."); return; }
    setEnviando(true);
    try {
      await chamar("responder", { loja, conversa }, {
        comprador_id: compradorId, texto: texto.trim(), sugestao_ia: sug?.sugestao ?? null, confirmar: "1", por: perfil?.nome ?? null,
      });
      toast.success("Resposta enviada.");
      setConfirmar(false); setSug(null); setTexto("");
      await qc.invalidateQueries({ queryKey: ["atend-shopee"] });
    } catch (e) { toast.error(`Não enviou: ${(e as Error).message}`); }
    finally { setEnviando(false); }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {resumo?.foto ? <img src={resumo.foto} alt="" className="h-8 w-8 rounded-full object-cover" /> : <div className="h-8 w-8 rounded-full bg-muted" />}
        <div className="font-medium">{resumo?.comprador ?? "Conversa"}</div>
        <span className="text-xs text-muted-foreground">Shopee {NOME_LOJA[loja]}</span>
      </div>

      <div className="max-h-[42vh] min-h-[200px] space-y-2 overflow-y-auto bg-muted/30 p-4">
        {msgQ.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lendo mensagens…</div>}
        {msgQ.error && <div className="text-sm text-red-600">Erro: {(msgQ.error as Error).message}</div>}
        {mensagens.map((m) => (
          <div key={m.message_id} className={cn("flex", m.de_nos ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm",
              m.de_nos ? "bg-[var(--pm-ac)] text-white" : "bg-card")}>
              <div className="whitespace-pre-wrap break-words">{m.texto || `[${m.tipo}]`}</div>
              <div className={cn("mt-1 text-[10px]", m.de_nos ? "text-white/80" : "text-muted-foreground")}>
                {hora(m.em)}{m.de_nos && m.origem && ORIGEM[m.origem] ? ` · ${ORIGEM[m.origem]}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3 border-t p-4">
        {sug?.contexto && (sug.contexto.pedidos.length > 0 || sug.contexto.produtos.length > 0) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {sug.contexto.pedidos.map((p: any) => (
              <span key={p.pedido} className="inline-flex items-center gap-1 rounded-full border px-2 py-1">
                <ShoppingBag className="h-3 w-3" /> {p.pedido} · {p.status_shopee}{p.enviar_ate ? ` · enviar até ${p.enviar_ate.split("-").reverse().join("/")}` : ""}{p.rastreio ? ` · ${p.rastreio}` : ""}
              </span>
            ))}
            {sug.contexto.produtos.map((p: any) => (
              <span key={p.anuncio} className="inline-flex items-center gap-1 rounded-full border px-2 py-1" title={p.nome}>
                <Package className="h-3 w-3" /> <span className="max-w-[260px] truncate">{p.nome}</span>
              </span>
            ))}
          </div>
        )}

        {sug?.precisa_humano && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span><b>Precisa de atenção:</b> {sug.motivo ?? "a IA recomenda que uma pessoa avalie antes de responder."}</span>
          </div>
        )}

        <div className="relative">
          <Textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5} maxLength={1000}
            placeholder={gerando ? "A IA está escrevendo…" : "Escreva a resposta ou peça uma sugestão à IA."} />
          {gerando && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted-foreground" />}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input value={instrucao} onChange={(e) => setInstrucao(e.target.value)} className="h-9 min-w-[220px] flex-1"
            placeholder="Orientação para a IA (opcional): ex. diga que o pedido sai amanhã" />
          <Button variant="outline" size="sm" onClick={() => gerar(instrucao.trim())} disabled={gerando}>
            <Bot className="mr-1 h-4 w-4" /> {sug ? "Refazer com a IA" : "Sugerir com a IA"}
          </Button>
          <Button size="sm" onClick={() => setConfirmar(true)} disabled={!texto.trim() || enviando || !compradorId}>
            <Send className="mr-1 h-4 w-4" /> Enviar
          </Button>
        </div>
        {sug?.modelo && <p className="text-[11px] text-muted-foreground">Sugestão gerada por {sug.modelo}. Confira antes de enviar.</p>}
      </div>

      <Dialog open={confirmar} onOpenChange={setConfirmar}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enviar para {resumo?.comprador ?? "o comprador"}?</DialogTitle>
            <DialogDescription>Vai pelo chat da Shopee {NOME_LOJA[loja]}. Depois de enviada, a mensagem não pode ser apagada.</DialogDescription>
          </DialogHeader>
          <div className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">{texto.trim()}</div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmar(false)}>Voltar</Button>
            <Button onClick={enviar} disabled={enviando}>{enviando ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />} Enviar agora</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
