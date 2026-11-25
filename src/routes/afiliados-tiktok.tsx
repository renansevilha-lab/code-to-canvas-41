import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2, MessageCircle, Search, Send, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

// ============================================================================
// Afiliados do TikTok Shop (loja ACZ) — 25/nov/2026. Criadores (retrato em
// tiktok_afiliados_criadores, ranking de Pets), conversas com criadores (ao vivo pela edge fn
// tiktok-afiliados?modulo=conversas) e as duas escritas: mensagem e convite (colaboração
// direcionada). Toda escrita passa por PRÉVIA (sem confirmar) e só vai ao TikTok com
// confirmar:true + sessão de usuário com o módulo ads; cada envio fica em debug_fulfillment
// (modulo tiktok-afiliados-envio).
// ============================================================================

type Aba = "criadores" | "conversas";
type Filtro = "todos" | "novos" | "sem_resposta" | "conosco";

export const Route = createFileRoute("/afiliados-tiktok")({
  validateSearch: (s: Record<string, unknown>): { aba?: "conversas"; f?: Filtro } => ({
    aba: s.aba === "conversas" ? "conversas" : undefined,
    f: s.f === "novos" || s.f === "sem_resposta" || s.f === "conosco" ? s.f : undefined,
  }),
  component: AfiliadosTikTok,
});

interface Criador {
  open_id: string; username: string; nome: string | null; seguidores: number | null; nivel: number | null;
  vendas_brl: number | null; parte_pets: number | null; vendas_pets_brl: number | null;
  dados: { com?: number | null; video?: number | null; live?: number | null; un?: number | null; amostra?: string | null; vendeu?: number; bio?: string; post?: number | null };
}
interface Msg { id: string; remetente: string; tipo: string; texto: string; quando: number }
interface Conversa { id: string; criador: { open_id?: string; username?: string; nome?: string } | null; mensagens: Msg[]; erro: string | null }

async function chamar(modulo: string, body: Record<string, unknown>, extra = ""): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (body.confirmar === true && !token) throw new Error("Faça login de novo para enviar ao TikTok.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiktok-afiliados?modulo=${modulo}${extra}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? EXTERNAL_PUBLISHABLE_KEY}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.previa) throw new Error(j.erro ?? j.message ?? `HTTP ${r.status}`);
  return j;
}

const reais = (v: number | null | undefined) =>
  v == null ? "—" : v >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: v >= 100000 ? 0 : 1 })} mil` : `R$ ${Math.round(v).toLocaleString("pt-BR")}`;
const compacto = (v: number | null | undefined) =>
  v == null ? "—" : v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi` : v >= 10_000 ? `${Math.round(v / 1000)} mil` : v.toLocaleString("pt-BR");
const quando = (s: number) => new Date(s * 1000).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

export const TEXTO_PADRAO = (nome: string) =>
  `Olá${nome ? `, ${nome}` : ""}! Aqui é a equipe da Ottz Pet, loja especializada em produtos para cães e gatos.\n\n` +
  `Estamos começando a vender no TikTok Shop os produtos da Bumi Pet Care, a nossa marca própria: areias higiênicas biodegradáveis ` +
  `(mandioca, esmectita com carvão ativado e tofu) e itens de higiene e adestramento.\n\n` +
  `Para esse lançamento, estamos com comissões especiais para criadores parceiros. Tem interesse em divulgar? ` +
  `Responda por aqui que te mandamos os detalhes.`;

const situacao = (c: Criador) => {
  const d = c.dados || {};
  if ((d.vendeu ?? 0) > 0) return { rotulo: `já vendeu ${reais(d.vendeu)}`, cor: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" };
  if (d.amostra === "concluida") return { rotulo: "amostra entregue", cor: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" };
  if (d.amostra === "sem_resposta") return { rotulo: "amostra sem resposta", cor: "bg-rose-500/10 text-rose-700 dark:text-rose-400" };
  if (d.amostra) return { rotulo: "pediu amostra", cor: "bg-amber-500/10 text-amber-700 dark:text-amber-400" };
  return { rotulo: "contato novo", cor: "bg-muted text-muted-foreground" };
};

function AfiliadosTikTok() {
  const { aba: abaUrl, f } = Route.useSearch();
  const aba: Aba = abaUrl === "conversas" ? "conversas" : "criadores";
  const nav = useNavigate({ from: Route.fullPath });
  const [msgPara, setMsgPara] = useState<{ open_id?: string; conversa?: string; username?: string; nome?: string } | null>(null);
  const [convidar, setConvidar] = useState<Criador[] | null>(null);
  const botao = (ativo: boolean) => cn("flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px", ativo ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">Afiliados do TikTok</h1>
        <p className="text-xs text-muted-foreground">TikTok Shop · loja ACZ Pet · criadores de Pets, conversas, mensagem e convite. Todo envio mostra a prévia antes.</p>
      </div>
      <div className="flex gap-1 border-b">
        <button type="button" className={botao(aba === "criadores")} onClick={() => nav({ search: (s) => ({ ...s, aba: undefined }), resetScroll: false })}><UserPlus className="h-4 w-4" />Criadores</button>
        <button type="button" className={botao(aba === "conversas")} onClick={() => nav({ search: (s) => ({ ...s, aba: "conversas" }), resetScroll: false })}><MessageCircle className="h-4 w-4" />Conversas</button>
      </div>
      {aba === "criadores"
        ? <Criadores filtro={f ?? "todos"} setFiltro={(x) => nav({ search: (s) => ({ ...s, f: x === "todos" ? undefined : x }), resetScroll: false })}
            onMensagem={(c) => setMsgPara({ open_id: c.open_id, username: c.username, nome: c.nome ?? c.username })} onConvidar={setConvidar} />
        : <Conversas onResponder={(cv) => setMsgPara({ conversa: cv.id, username: cv.criador?.username, nome: cv.criador?.nome ?? cv.criador?.username })} />}
      {msgPara && <MensagemDialog alvo={msgPara} onFechar={() => setMsgPara(null)} />}
      {convidar && <ConviteDialog criadores={convidar} onFechar={() => setConvidar(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- Criadores
function Criadores({ filtro, setFiltro, onMensagem, onConvidar }: { filtro: Filtro; setFiltro: (f: Filtro) => void; onMensagem: (c: Criador) => void; onConvidar: (c: Criador[]) => void }) {
  const [busca, setBusca] = useState("");
  const [marcados, setMarcados] = useState<Record<string, Criador>>({});
  const [limite, setLimite] = useState(60);
  const q = useQuery({
    queryKey: ["tiktok-afiliados", "criadores"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("tiktok_afiliados_criadores")
        .select("open_id, username, nome, seguidores, nivel, vendas_brl, parte_pets, vendas_pets_brl, dados")
        .order("vendas_pets_brl", { ascending: false, nullsFirst: false }).limit(1000);
      if (error) throw error;
      return (data ?? []) as Criador[];
    },
  });
  const todos = q.data ?? [];
  const testa: Record<Filtro, (c: Criador) => boolean> = {
    todos: () => true,
    novos: (c) => !c.dados?.amostra && !((c.dados?.vendeu ?? 0) > 0),
    sem_resposta: (c) => c.dados?.amostra === "sem_resposta",
    conosco: (c) => (c.dados?.vendeu ?? 0) > 0 || c.dados?.amostra === "concluida",
  };
  const lista = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return todos.filter(testa[filtro]).filter((c) => !t || `${c.username} ${c.nome ?? ""}`.toLowerCase().includes(t));
  }, [todos, filtro, busca]); // eslint-disable-line react-hooks/exhaustive-deps
  const nMarcados = Object.keys(marcados).length;
  const FILTROS: [Filtro, string][] = [["todos", "Todos"], ["novos", "Contatos novos"], ["sem_resposta", "Amostra sem resposta"], ["conosco", "Já trabalham conosco"]];
  if (q.isLoading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Carregando criadores…</p>;
  if (q.error) return <p className="text-sm text-rose-600">Não consegui ler os criadores: {(q.error as Error).message}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTROS.map(([id, rot]) => (
          <button key={id} type="button" onClick={() => { setFiltro(id); setLimite(60); }}
            className={cn("rounded-full border px-3 py-1.5 text-sm font-medium", filtro === id ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
            {rot} <span className="ml-1 text-xs opacity-75">{todos.filter(testa[id]).length}</span>
          </button>
        ))}
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome ou @" className="pl-8" />
        </div>
      </div>
      {nMarcados > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-lg bg-foreground px-4 py-2 text-sm text-background">
          <span>{nMarcados} criador(es) marcado(s)</span>
          <Button size="sm" variant="secondary" onClick={() => onConvidar(Object.values(marcados))}><UserPlus className="mr-1 h-4 w-4" />Convidar com comissão</Button>
          <button type="button" className="underline" onClick={() => setMarcados({})}>limpar</button>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-8 px-3 py-2" /><th className="px-3 py-2">Criador</th><th className="px-3 py-2 text-right">Vendas em Pets</th>
              <th className="px-3 py-2">Como vende</th><th className="px-3 py-2 text-right">Comissão média</th><th className="px-3 py-2 text-right">Seguidores</th>
              <th className="px-3 py-2">Conosco</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {lista.slice(0, limite).map((c) => {
              const s = situacao(c); const d = c.dados || {};
              const v = d.video != null ? Math.round(d.video * 100) : null;
              return (
                <tr key={c.open_id} className="border-t">
                  <td className="px-3 py-2"><Checkbox checked={!!marcados[c.open_id]} onCheckedChange={(x) => setMarcados((m) => { const n = { ...m }; if (x) n[c.open_id] = c; else delete n[c.open_id]; return n; })} aria-label={`Marcar ${c.username}`} /></td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.nome || c.username}</div>
                    <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={`https://www.tiktok.com/@${encodeURIComponent(c.username)}`} target="_blank" rel="noopener">@{c.username}<ExternalLink className="h-3 w-3" /></a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{reais(c.vendas_pets_brl)}{c.parte_pets != null && c.parte_pets < 0.9 && <div className="text-xs text-muted-foreground">{Math.round(c.parte_pets * 100)}% das vendas</div>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{v == null ? "—" : v >= 95 ? "só vídeo" : v <= 5 ? "só live" : `${v}% vídeo · ${100 - v}% live`}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{d.com != null ? `${d.com.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{compacto(c.seguidores)}</td>
                  <td className="px-3 py-2"><span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", s.cor)}>{s.rotulo}</span></td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant="outline" onClick={() => onMensagem(c)}><Send className="mr-1 h-3.5 w-3.5" />Mensagem</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!lista.length && <p className="p-6 text-center text-sm text-muted-foreground">Nenhum criador com esse filtro.</p>}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Mostrando {Math.min(limite, lista.length)} de {lista.length}. Vendas em reais = dólar da API × 5,5; período não informado pelo TikTok.</span>
        {lista.length > limite && <Button size="sm" variant="outline" onClick={() => setLimite((x) => x + 60)}>Mostrar mais</Button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Conversas
function Conversas({ onResponder }: { onResponder: (c: Conversa) => void }) {
  const [paginas, setPaginas] = useState<string[]>([""]);
  const q = useQuery({
    queryKey: ["tiktok-afiliados", "conversas", paginas],
    queryFn: async () => {
      const todas: Conversa[] = []; let prox = "";
      for (const p of paginas) {
        const j = await chamar("conversas", {}, p ? `&page_token=${encodeURIComponent(p)}` : "");
        todas.push(...(j.conversas ?? [])); prox = j.proxima ?? "";
      }
      return { conversas: todas, proxima: prox };
    },
    staleTime: 60_000,
  });
  const conversas = q.data?.conversas ?? [];
  // a loja é o remetente que aparece em mais conversas (a API não diz quem é quem)
  const loja = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of conversas) for (const s of new Set(c.mensagens.filter((m) => m.tipo !== "NOTIFICATION").map((m) => m.remetente))) n[s] = (n[s] ?? 0) + 1;
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 3 ? top[0] : "";
  }, [conversas]);
  const semResposta = (c: Conversa) => {
    const ult = [...c.mensagens].reverse().find((m) => m.tipo !== "NOTIFICATION");
    return !!ult && ult.remetente !== loja;
  };
  const [so, setSo] = useState(true);
  const lista = so ? conversas.filter(semResposta) : conversas;
  if (q.isLoading) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Lendo as conversas no TikTok…</p>;
  if (q.error) return <p className="text-sm text-rose-600">Não consegui ler as conversas: {(q.error as Error).message}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2"><Checkbox checked={so} onCheckedChange={(x) => setSo(!!x)} />Só as que esperam resposta da loja ({conversas.filter(semResposta).length} de {conversas.length})</label>
        <span className="text-xs text-muted-foreground">O TikTok não devolve o texto das mensagens da loja, só as do criador. A loja pode mandar até 5 mensagens antes de o criador responder.</span>
      </div>
      <div className="space-y-2">
        {lista.map((c) => {
          const ult = c.mensagens[c.mensagens.length - 1];
          return (
            <div key={c.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{c.criador?.nome || c.criador?.username || "Criador não identificado"}</span>
                  {c.criador?.username && <a className="ml-2 text-xs text-primary hover:underline" href={`https://www.tiktok.com/@${encodeURIComponent(c.criador.username)}`} target="_blank" rel="noopener">@{c.criador.username}</a>}
                  {semResposta(c) && <span className="ml-2 rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-semibold text-rose-700 dark:text-rose-400">sem resposta</span>}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {ult && quando(ult.quando)}
                  <Button size="sm" variant="outline" onClick={() => onResponder(c)}><Send className="mr-1 h-3.5 w-3.5" />Responder</Button>
                </div>
              </div>
              <div className="mt-2 space-y-1.5">
                {c.mensagens.filter((m) => m.tipo !== "NOTIFICATION").slice(-4).map((m) => {
                  const daLoja = m.remetente === loja;
                  const corpo = m.tipo === "TEXT" ? (m.texto || (daLoja ? "(mensagem da loja — o TikTok não devolve o texto)" : "(sem texto)"))
                    : m.tipo === "FREE_SAMPLE_CARD" ? "pediu amostra grátis" : m.tipo === "PRODUCT_CARD" ? "mandou um produto" : m.tipo === "IMAGE" ? "mandou uma imagem" : m.tipo.toLowerCase();
                  return (
                    <div key={m.id} className={cn("max-w-[85%] whitespace-pre-wrap rounded-md px-2.5 py-1.5 text-sm", daLoja ? "ml-auto bg-primary/10" : "bg-muted")}>
                      <span className="mr-1 text-[11px] font-semibold text-muted-foreground">{daLoja ? "Loja" : "Criador"} · {quando(m.quando)}</span>
                      <div className={m.tipo === "TEXT" && m.texto ? "" : "italic text-muted-foreground"}>{corpo.slice(0, 600)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!lista.length && <p className="p-6 text-center text-sm text-muted-foreground">Nenhuma conversa esperando resposta nesta página.</p>}
      </div>
      {q.data?.proxima && <Button variant="outline" size="sm" disabled={q.isFetching} onClick={() => setPaginas((p) => [...p, q.data!.proxima])}>{q.isFetching && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Carregar conversas mais antigas</Button>}
    </div>
  );
}

// ---------------------------------------------------------------------------- Mensagem
function MensagemDialog({ alvo, onFechar }: { alvo: { open_id?: string; conversa?: string; username?: string; nome?: string }; onFechar: () => void }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState(TEXTO_PADRAO(alvo.nome && !/^\d+$/.test(alvo.nome) ? alvo.nome.split(" ")[0] : ""));
  const [conferido, setConferido] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const corpo = { creator_open_id: alvo.open_id, conversation_id: alvo.conversa, username: alvo.username, texto };
  async function conferir() {
    try { const j = await chamar("mensagem", corpo); setConferido(j.vai_enviar?.texto ?? texto); } catch (e) { toast.error((e as Error).message); }
  }
  async function enviar() {
    setEnviando(true);
    try {
      const j = await chamar("mensagem", { ...corpo, confirmar: true });
      if (!j.enviado) throw new Error(j.message ?? "o TikTok recusou");
      toast.success(`Mensagem enviada para ${alvo.username ? "@" + alvo.username : "o criador"}.`);
      qc.invalidateQueries({ queryKey: ["tiktok-afiliados", "conversas"] });
      onFechar();
    } catch (e) { toast.error(`Não enviou: ${(e as Error).message}`); } finally { setEnviando(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mensagem para {alvo.nome || (alvo.username ? "@" + alvo.username : "o criador")}</DialogTitle>
          <DialogDescription>{alvo.conversa ? "Responde na conversa que já existe." : "Abre uma conversa nova com o criador no TikTok."} A loja pode mandar até 5 mensagens antes de o criador responder.</DialogDescription>
        </DialogHeader>
        <Textarea id="tt-msg" rows={10} value={texto} onChange={(e) => { setTexto(e.target.value); setConferido(null); }} maxLength={2000} />
        <div className="text-right text-xs text-muted-foreground">{texto.length}/2000</div>
        {conferido == null ? (
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={onFechar}>Cancelar</Button><Button onClick={conferir} disabled={!texto.trim()}>Conferir</Button></div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle className="h-4 w-4" />Vai ser enviado no TikTok, sem volta:</div>
              <div className="text-xs text-muted-foreground">Para: {alvo.username ? "@" + alvo.username : `conversa ${alvo.conversa}`}</div>
              <div className="mt-1 whitespace-pre-wrap">{conferido}</div>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConferido(null)}>Voltar e editar</Button><Button onClick={enviar} disabled={enviando}>{enviando && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Enviar no TikTok</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Convite
function ConviteDialog({ criadores, onFechar }: { criadores: Criador[]; onFechar: () => void }) {
  const em30 = new Date(Date.now() + 30 * 86_400_000);
  const [nome, setNome] = useState("Lançamento Bumi Pet Care no TikTok");
  const [mensagem, setMensagem] = useState("Comissão especial nos produtos Bumi Pet Care no lançamento da Ottz Pet no TikTok Shop.");
  const [fim, setFim] = useState(em30.toISOString().slice(0, 10));
  const [email, setEmail] = useState("");
  const [amostra, setAmostra] = useState(false);
  const [semAprov, setSemAprov] = useState(false);
  const [busca, setBusca] = useState("");
  const [escolhidos, setEscolhidos] = useState<Record<string, number>>({});
  const [previa, setPrevia] = useState<{ pendencias: string[]; vai_enviar: any } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const prodQ = useQuery({
    queryKey: ["tiktok-afiliados", "produtos"],
    queryFn: async () => {
      const { data } = await supabaseExternal.from("tiktok_produtos").select("product_id, titulo, preco, status").eq("status", "ACTIVATE").limit(1000);
      const m = new Map<string, { id: string; titulo: string; preco: number | null }>();
      for (const p of (data ?? []) as { product_id: string; titulo: string | null; preco: number | null }[]) if (!m.has(p.product_id)) m.set(p.product_id, { id: p.product_id, titulo: p.titulo ?? p.product_id, preco: p.preco });
      return [...m.values()].sort((a, b) => a.titulo.localeCompare(b.titulo));
    },
  });
  const prods = (prodQ.data ?? []).filter((p) => !busca.trim() || p.titulo.toLowerCase().includes(busca.toLowerCase()));
  const corpo = {
    nome, mensagem, fim, email, amostra_gratis: amostra, amostra_sem_aprovacao: semAprov,
    criadores: criadores.map((c) => c.open_id),
    produtos: Object.entries(escolhidos).map(([id, pct]) => ({ id, comissao_pct: pct })),
  };
  async function conferir() { try { setPrevia(await chamar("convite", corpo)); } catch (e) { toast.error((e as Error).message); } }
  async function enviar() {
    setEnviando(true);
    try {
      const j = await chamar("convite", { ...corpo, confirmar: true });
      if (!j.enviado) throw new Error(j.message ?? "o TikTok recusou");
      toast.success(`Convite enviado a ${criadores.length} criador(es).`);
      onFechar();
    } catch (e) { toast.error(`Não enviou: ${(e as Error).message}`); } finally { setEnviando(false); }
  }
  const titulo = (id: string) => prodQ.data?.find((p) => p.id === id)?.titulo ?? id;
  return (
    <Dialog open onOpenChange={(o) => !o && onFechar()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Convite com comissão para {criadores.length} criador(es)</DialogTitle>
          <DialogDescription>{criadores.slice(0, 6).map((c) => "@" + c.username).join(", ")}{criadores.length > 6 ? ` e mais ${criadores.length - 6}` : ""}. Colaboração direcionada do TikTok: o criador recebe o convite no Affiliate Center.</DialogDescription>
        </DialogHeader>
        {previa == null || previa.pendencias.length ? (
          <div className="space-y-3 text-sm">
            <label className="block"><span className="text-xs text-muted-foreground">Nome do convite</span><Input id="tt-conv-nome" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={100} /></label>
            <label className="block"><span className="text-xs text-muted-foreground">Mensagem que o criador vê</span><Textarea id="tt-conv-msg" rows={3} value={mensagem} onChange={(e) => setMensagem(e.target.value)} maxLength={500} /></label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="text-xs text-muted-foreground">Vale até</span><Input id="tt-conv-fim" type="date" value={fim} onChange={(e) => setFim(e.target.value)} /></label>
              <label className="block"><span className="text-xs text-muted-foreground">E-mail de contato da loja (o criador vê)</span><Input id="tt-conv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="contato@…" /></label>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2"><Checkbox checked={amostra} onCheckedChange={(x) => setAmostra(!!x)} />Oferecer amostra grátis</label>
              {amostra && <label className="flex items-center gap-2"><Checkbox checked={semAprov} onCheckedChange={(x) => setSemAprov(!!x)} />Aprovar amostra sem revisão</label>}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">Produtos e comissão (%)</span><Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Filtrar produtos" className="h-8 max-w-[220px]" /></div>
              <div className="max-h-56 overflow-y-auto rounded border">
                {prodQ.isLoading && <p className="p-3 text-muted-foreground">Carregando produtos…</p>}
                {prods.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 border-b px-2 py-1.5 last:border-0">
                    <Checkbox checked={p.id in escolhidos} onCheckedChange={(x) => setEscolhidos((m) => { const n = { ...m }; if (x) n[p.id] = 15; else delete n[p.id]; return n; })} />
                    <span className="flex-1 truncate">{p.titulo}</span>
                    {p.id in escolhidos && <Input type="number" min={1} max={80} step={0.5} value={escolhidos[p.id]} onChange={(e) => setEscolhidos((m) => ({ ...m, [p.id]: Number(e.target.value) }))} className="h-7 w-20 text-right" aria-label="Comissão em %" />}
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Nossas colaborações abertas pagam de 8% a 15%; os criadores do ranking costumam receber de 6% a 9%.</p>
            </div>
            {previa?.pendencias.length ? <div className="rounded-md bg-rose-500/10 p-2 text-xs text-rose-700 dark:text-rose-400">Falta: {previa.pendencias.join(", ")}.</div> : null}
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={onFechar}>Cancelar</Button><Button onClick={conferir}>Conferir</Button></div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="mb-2 flex items-center gap-1 font-semibold"><AlertTriangle className="h-4 w-4" />Vai ser enviado no TikTok, sem volta:</div>
              <div><b>{previa.vai_enviar.name}</b> · vale até {fim.split("-").reverse().join("/")}</div>
              <div className="mt-1 whitespace-pre-wrap">{previa.vai_enviar.message}</div>
              <ul className="mt-2 list-disc pl-5">{previa.vai_enviar.products.map((p: { id: string; target_commission_rate: number }) => <li key={p.id}>{titulo(p.id)}: {(p.target_commission_rate / 100).toLocaleString("pt-BR")}% de comissão</li>)}</ul>
              <div className="mt-2 text-xs text-muted-foreground">Para {criadores.length} criador(es) · contato {email} · {amostra ? (semAprov ? "amostra grátis sem revisão" : "amostra grátis com aprovação") : "sem amostra grátis"}</div>
            </div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPrevia(null)}>Voltar e editar</Button><Button onClick={enviar} disabled={enviando}>{enviando && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Enviar convite</Button></div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
