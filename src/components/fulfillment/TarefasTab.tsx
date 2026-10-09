import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Archive, ArchiveRestore, CalendarClock, Check, ChevronLeft, ChevronRight, ClipboardCheck,
  ClipboardList, EyeOff, Eye, Camera, ImagePlus, ListChecks, Loader2, Package as PackageIcon, Plus, RefreshCw, Search, Trash2, User, X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { FotosTarefa, apagarFotosTarefa, enviarFotosTarefa } from "./FotosTarefa";

// ============================================================================
// Fulfillment › Tarefas (06/out/2026, pedido do dono): quadro A fazer /
// Fazendo / Feito com contagem de inventário e organização de estoque.
// - Contagem: produtos escolhidos por busca + filtros (fornecedor, marca,
//   categoria, só com saldo); a pessoa conta por SKU (contagem cega por padrão);
//   divergência contado × sistema vem pronta das views. O ajuste no Tiny
//   (balanço no depósito Geral) só sai pelo botão, com prévia AO VIVO e
//   confirmação — edge fn fulfillment-tarefas.
// - Organização / outra: descrição + checklist.
// - Fotos (09/out/2026): na criação e no detalhe de qualquer tarefa — FotosTarefa.tsx
//   (bucket fulfillment-docs, pasta tarefas/<id>/, reduzidas no navegador).
// - Responsável (equipe_membros) e prazo; aviso no Discord (canal fulfilment)
//   ao criar e ao concluir.
// Tabelas: fulfillment_tarefas / fulfillment_tarefa_itens. Views:
// view_fulfillment_tarefas, view_fulfillment_tarefa_itens,
// view_inventario_produtos, view_inventario_filtros.
// ============================================================================

type Tipo = "contagem" | "organizacao" | "outro";
type Status = "a_fazer" | "fazendo" | "feito";
interface ChecklistItem { texto: string; feito: boolean }
interface Tarefa {
  id: string; tipo: Tipo; titulo: string; descricao: string | null; status: Status;
  responsavel_id: string | null; responsavel: string | null; prazo: string | null;
  checklist: ChecklistItem[]; contagem_cega: boolean;
  criado_por: string | null; criado_em: string; concluido_em: string | null; concluido_por: string | null;
  arquivado_em: string | null; ajuste_em: string | null; ajuste_por: string | null;
  n_itens: number; n_contados: number; n_divergentes: number; unidades_divergentes: number; n_ajustados: number;
  n_checklist: number; n_checklist_feitos: number; atrasada: boolean;
}
interface ItemTarefa {
  id: number; tarefa_id: string; sku: string; nome: string | null; fornecedor: string | null; ordem: number;
  qtd_sistema: number | null; qtd_contada: number | null; contado_em: string | null; contado_por: string | null;
  obs: string | null; ajuste_status: "lancado" | "igual" | "erro" | null; ajuste_erro: string | null;
  ajuste_saldo_antes: number | null; ajuste_em: string | null; diferenca: number | null; foto: string | null;
}
interface ProdutoInv {
  sku: string; nome: string | null; fornecedor: string | null; marca: string | null; categoria: string | null;
  foto: string | null; saldo_geral: number | null;
}
interface Membro { id: string; nome: string }

const STATUS: { id: Status; label: string; cor: string }[] = [
  { id: "a_fazer", label: "A fazer", cor: "#B7791F" },
  { id: "fazendo", label: "Fazendo", cor: "#2F6FB0" },
  { id: "feito", label: "Feito", cor: "#0E8A5F" },
];
const TIPOS: { id: Tipo; label: string; cls: string }[] = [
  { id: "contagem", label: "Contagem de inventário", cls: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300" },
  { id: "organizacao", label: "Organização de estoque", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300" },
  { id: "outro", label: "Outra tarefa", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800/50 dark:text-slate-300" },
];
const tipoDe = (t: string) => TIPOS.find((x) => x.id === t) ?? TIPOS[2];
const n = (x: unknown) => { const v = Number(x ?? 0); return Number.isFinite(v) ? v : 0; };
const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const fmtQtd = (x: number | null | undefined) => (x == null ? "—" : formatNumber(x, Number.isInteger(x) ? 0 : 2));

async function chamarEdge(modulo: string, body: Record<string, unknown>, extra = ""): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/fulfillment-tarefas?modulo=${modulo}${extra}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}
/** Aviso no Discord é melhor-esforço: falha não trava a tarefa. */
function avisar(tarefaId: string, evento: "criada" | "concluida") {
  chamarEdge("avisar", { tarefa_id: tarefaId, evento }).catch(() => { /* silencioso */ });
}

function Foto({ url, size = 36 }: { url?: string | null; size?: number }) {
  if (!url) {
    return (
      <div style={{ width: size, height: size }} className="rounded bg-muted flex items-center justify-center shrink-0">
        <PackageIcon className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return <img src={url} alt="" loading="lazy" style={{ width: size, height: size }} className="rounded object-cover border shrink-0 bg-muted" />;
}

function useEquipe() {
  return useQuery({
    queryKey: ["fulfillment", "equipe"],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Membro[]> => {
      const { data, error } = await supabaseExternal.from("equipe_membros").select("id, nome").eq("ativo", true).order("ordem");
      if (error) throw error;
      return (data ?? []) as Membro[];
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Quadro

export function TarefasTab({ ativo }: { ativo: boolean }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [nova, setNova] = useState(false);
  const [abertaId, setAbertaId] = useState<string | null>(null);
  const [filtroTipo, setFiltroTipo] = useState<"todos" | Tipo>("todos");
  const [filtroResp, setFiltroResp] = useState<string>("todos");
  const [arquivadas, setArquivadas] = useState(false);

  const q = useQuery({
    queryKey: ["fulfillment", "tarefas", arquivadas],
    enabled: ativo,
    queryFn: async (): Promise<Tarefa[]> => {
      let qq = supabaseExternal.from("view_fulfillment_tarefas").select("*").order("criado_em", { ascending: false }).limit(500);
      qq = arquivadas ? qq.not("arquivado_em", "is", null) : qq.is("arquivado_em", null);
      const { data, error } = await qq;
      if (error) throw error;
      return (data ?? []) as Tarefa[];
    },
  });

  const lista = useMemo(() => (q.data ?? []).filter((t) =>
    (filtroTipo === "todos" || t.tipo === filtroTipo) &&
    (filtroResp === "todos" || (filtroResp === "_sem" ? !t.responsavel : t.responsavel === filtroResp)),
  ), [q.data, filtroTipo, filtroResp]);
  const responsaveis = useMemo(() => [...new Set((q.data ?? []).map((t) => t.responsavel).filter(Boolean) as string[])].sort(), [q.data]);

  async function mover(t: Tarefa, para: Status) {
    if (t.status === para) return;
    if (para === "feito") { setAbertaId(t.id); toast.info("Confira e conclua pela tarefa"); return; }
    const agora = new Date().toISOString();
    const campos: Record<string, unknown> = { status: para, atualizado_em: agora };
    if (para === "fazendo" && !t.status.startsWith("fazendo")) campos.iniciado_em = agora;
    if (t.status === "feito") { campos.concluido_em = null; campos.concluido_por = null; }
    const { error } = await supabaseExternal.from("fulfillment_tarefas").update(campos).eq("id", t.id);
    if (error) { toast.error("Não foi possível mover", { description: error.message }); return; }
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefas"] });
  }

  const contagem = (s: Status) => lista.filter((t) => t.status === s);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filtroTipo} onValueChange={(v) => setFiltroTipo(v as typeof filtroTipo)}>
            <SelectTrigger className="h-9 w-[210px] bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os tipos</SelectItem>
              {TIPOS.map((t) => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filtroResp} onValueChange={setFiltroResp}>
            <SelectTrigger className="h-9 w-[180px] bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os responsáveis</SelectItem>
              <SelectItem value="_sem">Sem responsável</SelectItem>
              {responsaveis.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setArquivadas((a) => !a)}>
            {arquivadas ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            {arquivadas ? "Voltar ao quadro" : "Arquivadas"}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} /> Atualizar
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setNova(true)}>
            <Plus className="h-4 w-4" /> Nova tarefa
          </Button>
        </div>
      </div>

      {q.error ? (
        <div className="rounded-xl border bg-card p-6 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {(q.error as Error).message}
        </div>
      ) : q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}</div>
      ) : arquivadas ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {lista.length === 0 && <div className="text-sm text-muted-foreground">Nenhuma tarefa arquivada.</div>}
          {lista.map((t) => <CardTarefa key={t.id} t={t} onAbrir={() => setAbertaId(t.id)} />)}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-3 items-start">
          {STATUS.map((s, idx) => (
            <div key={s.id} className="rounded-xl border bg-muted/30 flex flex-col min-w-0">
              <div className="px-3 py-2.5 border-b flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <i className="h-2.5 w-2.5 rounded-full" style={{ background: s.cor }} /> {s.label}
                </span>
                <Badge variant="secondary" className="tabular-nums">{contagem(s.id).length}</Badge>
              </div>
              <div className="p-2 flex flex-col gap-2 min-h-[120px]">
                {contagem(s.id).length === 0 && <div className="text-xs text-muted-foreground px-1 py-3">Nada aqui.</div>}
                {contagem(s.id).map((t) => (
                  <CardTarefa key={t.id} t={t} onAbrir={() => setAbertaId(t.id)}
                    onEsquerda={idx > 0 ? () => void mover(t, STATUS[idx - 1].id) : undefined}
                    onDireita={idx < STATUS.length - 1 ? () => void mover(t, STATUS[idx + 1].id) : undefined} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {nova && (
        <NovaTarefa
          onFechar={() => setNova(false)}
          onCriada={(id) => { setNova(false); setAbertaId(id); void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefas"] }); }}
          criadoPor={perfil?.nome ?? "app"}
        />
      )}
      {abertaId && <DetalheTarefa id={abertaId} onFechar={() => setAbertaId(null)} />}
    </div>
  );
}

function CardTarefa({ t, onAbrir, onEsquerda, onDireita }: {
  t: Tarefa; onAbrir: () => void; onEsquerda?: () => void; onDireita?: () => void;
}) {
  const tp = tipoDe(t.tipo);
  const contagem = t.tipo === "contagem";
  const total = contagem ? n(t.n_itens) : n(t.n_checklist);
  const feitos = contagem ? n(t.n_contados) : n(t.n_checklist_feitos);
  return (
    <div className="rounded-lg border bg-card p-3 flex flex-col gap-2 hover:border-foreground/25 transition-colors">
      <button type="button" onClick={onAbrir} className="text-left flex flex-col gap-1.5">
        <span className={cn("self-start text-[10.5px] font-semibold px-2 py-0.5 rounded-full", tp.cls)}>{tp.label}</span>
        <span className="text-sm font-semibold leading-snug">{t.titulo}</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />{t.responsavel ?? "sem responsável"}</span>
          {t.prazo && (
            <span className={cn("inline-flex items-center gap-1", t.atrasada && "text-red-600 dark:text-red-400 font-semibold")}>
              <CalendarClock className="h-3 w-3" />{t.atrasada ? "atrasada · " : ""}{ddmm(t.prazo)}
            </span>
          )}
        </span>
        {total > 0 && (
          <span className="flex flex-col gap-1">
            <span className="h-1.5 rounded-full bg-muted overflow-hidden">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (feitos / total) * 100)}%` }} />
            </span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {contagem ? `${feitos} de ${total} SKUs contados` : `${feitos} de ${total} itens`}
              {contagem && n(t.n_divergentes) > 0 && <span className="text-amber-700 dark:text-amber-400 font-semibold"> · {t.n_divergentes} divergência(s)</span>}
              {contagem && t.ajuste_em && <span className="text-emerald-700 dark:text-emerald-400"> · ajuste lançado</span>}
            </span>
          </span>
        )}
      </button>
      {(onEsquerda || onDireita) && (
        <div className="flex justify-between">
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!onEsquerda} onClick={onEsquerda} aria-label="Voltar etapa">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!onDireita} onClick={onDireita} aria-label="Avançar etapa">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Escolha de produtos (busca + filtros) — usada ao criar e para adicionar depois

function SeletorProdutos({ selecionados, onChange, jaNaTarefa }: {
  selecionados: Map<string, ProdutoInv>;
  onChange: (m: Map<string, ProdutoInv>) => void;
  jaNaTarefa?: Set<string>;
}) {
  const [busca, setBusca] = useState("");
  const [buscaDeb, setBuscaDeb] = useState("");
  const [forn, setForn] = useState("_todos");
  const [marca, setMarca] = useState("_todos");
  const [cat, setCat] = useState("_todos");
  const [comSaldo, setComSaldo] = useState(false);
  useEffect(() => { const t = setTimeout(() => setBuscaDeb(busca.trim()), 300); return () => clearTimeout(t); }, [busca]);

  const filtrosQ = useQuery({
    queryKey: ["fulfillment", "inv-filtros"],
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_inventario_filtros").select("campo, valor, n").order("valor");
      if (error) throw error;
      const rows = (data ?? []) as { campo: string; valor: string; n: number }[];
      return {
        fornecedor: rows.filter((r) => r.campo === "fornecedor"),
        marca: rows.filter((r) => r.campo === "marca"),
        categoria: rows.filter((r) => r.campo === "categoria"),
      };
    },
  });

  const algumFiltro = buscaDeb.length >= 2 || forn !== "_todos" || marca !== "_todos" || cat !== "_todos";
  const LIMITE = 300;
  const prodQ = useQuery({
    queryKey: ["fulfillment", "inv-produtos", buscaDeb, forn, marca, cat, comSaldo],
    enabled: algumFiltro,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ProdutoInv[]> => {
      let qq = supabaseExternal.from("view_inventario_produtos").select("sku, nome, fornecedor, marca, categoria, foto, saldo_geral");
      if (forn !== "_todos") qq = qq.eq("fornecedor", forn);
      if (marca !== "_todos") qq = qq.eq("marca", marca);
      if (cat !== "_todos") qq = qq.eq("categoria", cat);
      if (comSaldo) qq = qq.gt("saldo_geral", 0);
      if (buscaDeb.length >= 2) {
        const termo = buscaDeb.replace(/[%,()]/g, " ").trim();
        qq = qq.or(`nome.ilike.%${termo}%,sku.ilike.%${termo}%`);
      }
      const { data, error } = await qq.order("nome").limit(LIMITE + 1);
      if (error) throw error;
      return (data ?? []) as ProdutoInv[];
    },
  });
  const resultados = (prodQ.data ?? []).slice(0, LIMITE);
  const disponiveis = resultados.filter((p) => !jaNaTarefa?.has(p.sku));
  const todosMarcados = disponiveis.length > 0 && disponiveis.every((p) => selecionados.has(p.sku));

  function alternar(p: ProdutoInv) {
    const m = new Map(selecionados);
    if (m.has(p.sku)) m.delete(p.sku); else m.set(p.sku, p);
    onChange(m);
  }
  function alternarTodos() {
    const m = new Map(selecionados);
    if (todosMarcados) disponiveis.forEach((p) => m.delete(p.sku));
    else disponiveis.forEach((p) => m.set(p.sku, p));
    onChange(m);
  }

  const SelFiltro = ({ valor, set, rotulo, itens }: {
    valor: string; set: (v: string) => void; rotulo: string; itens: { valor: string; n: number }[] | undefined;
  }) => (
    <Select value={valor} onValueChange={set}>
      <SelectTrigger className="h-9 bg-card"><SelectValue placeholder={rotulo} /></SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value="_todos">{rotulo}: todos</SelectItem>
        {(itens ?? []).map((i) => <SelectItem key={i.valor} value={i.valor}>{i.valor} ({i.n})</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar nome ou SKU…" className="pl-8 h-9 bg-card" />
        </div>
        <SelFiltro valor={forn} set={setForn} rotulo="Fornecedor" itens={filtrosQ.data?.fornecedor} />
        <SelFiltro valor={marca} set={setMarca} rotulo="Marca" itens={filtrosQ.data?.marca} />
        <SelFiltro valor={cat} set={setCat} rotulo="Categoria" itens={filtrosQ.data?.categoria} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={comSaldo} onCheckedChange={setComSaldo} /> Só com saldo no depósito Geral
        </label>
        {algumFiltro && disponiveis.length > 0 && (
          <Button variant="outline" size="sm" onClick={alternarTodos}>
            {todosMarcados ? "Desmarcar os filtrados" : `Selecionar os ${disponiveis.length} filtrados`}
          </Button>
        )}
      </div>

      <div className="rounded-lg border max-h-[340px] overflow-y-auto divide-y bg-card">
        {!algumFiltro ? (
          <div className="p-4 text-sm text-muted-foreground">Escolha um fornecedor, marca ou categoria, ou busque pelo nome/SKU.</div>
        ) : prodQ.isLoading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Buscando…</div>
        ) : prodQ.error ? (
          <div className="p-4 text-sm text-destructive">{(prodQ.error as Error).message}</div>
        ) : resultados.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">Nenhum produto com esses filtros.</div>
        ) : resultados.map((p) => {
          const ja = jaNaTarefa?.has(p.sku);
          return (
            <label key={p.sku} className={cn("flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40", ja && "opacity-50 cursor-default")}>
              <Checkbox checked={ja || selecionados.has(p.sku)} disabled={ja} onCheckedChange={() => alternar(p)} />
              <Foto url={p.foto} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate" title={p.nome ?? ""}>{p.nome ?? "—"}</span>
                <span className="block text-[11px] text-muted-foreground truncate">
                  <span className="font-mono">{p.sku}</span>{p.fornecedor ? ` · ${p.fornecedor}` : ""}{ja ? " · já está na tarefa" : ""}
                </span>
              </span>
              <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap" title="Saldo no depósito Geral (espelho do Tiny)">
                Geral {fmtQtd(p.saldo_geral)}
              </span>
            </label>
          );
        })}
      </div>
      {(prodQ.data?.length ?? 0) > LIMITE && (
        <div className="text-[11px] text-muted-foreground">Mostrando os primeiros {LIMITE}. Refine a busca para ver o resto.</div>
      )}
      {selecionados.size > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold">{selecionados.size} selecionado(s):</span>
          {[...selecionados.values()].slice(0, 12).map((p) => (
            <Badge key={p.sku} variant="secondary" className="gap-1 font-mono text-[11px]">
              {p.sku}
              <button type="button" onClick={() => alternar(p)} aria-label={`Tirar ${p.sku}`}><X className="h-3 w-3" /></button>
            </Badge>
          ))}
          {selecionados.size > 12 && <span className="text-xs text-muted-foreground">+{selecionados.size - 12}</span>}
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onChange(new Map())}>limpar</Button>
        </div>
      )}
    </div>
  );
}

async function inserirItens(tarefaId: string, produtos: ProdutoInv[], ordemInicial = 0) {
  const linhas = produtos.map((p, i) => ({
    tarefa_id: tarefaId, sku: p.sku, nome: p.nome, fornecedor: p.fornecedor,
    qtd_sistema: p.saldo_geral, ordem: ordemInicial + i,
  }));
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await supabaseExternal.from("fulfillment_tarefa_itens").insert(linhas.slice(i, i + 500));
    if (error) throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Nova tarefa

function EditorChecklist({ itens, onChange }: { itens: ChecklistItem[]; onChange: (c: ChecklistItem[]) => void }) {
  const [novo, setNovo] = useState("");
  function add() {
    const t = novo.trim();
    if (!t) return;
    onChange([...itens, { texto: t, feito: false }]);
    setNovo("");
  }
  return (
    <div className="flex flex-col gap-1.5">
      {itens.map((c, i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5">
          <Checkbox checked={c.feito} onCheckedChange={(v) => onChange(itens.map((x, j) => (j === i ? { ...x, feito: !!v } : x)))} />
          <span className={cn("flex-1 text-sm", c.feito && "line-through text-muted-foreground")}>{c.texto}</span>
          <button type="button" onClick={() => onChange(itens.filter((_, j) => j !== i))} aria-label="Remover item" className="text-muted-foreground hover:text-destructive">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <Input value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="Novo item (ex.: etiquetar a prateleira B)"
          className="h-9 bg-card" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <Button type="button" variant="outline" size="sm" onClick={add} className="h-9"><Plus className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function NovaTarefa({ onFechar, onCriada, criadoPor }: { onFechar: () => void; onCriada: (id: string) => void; criadoPor: string }) {
  const equipeQ = useEquipe();
  const [tipo, setTipo] = useState<Tipo>("contagem");
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [resp, setResp] = useState("_sem");
  const [prazo, setPrazo] = useState("");
  const [cega, setCega] = useState(true);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [selecionados, setSelecionados] = useState<Map<string, ProdutoInv>>(new Map());
  const [fotos, setFotos] = useState<File[]>([]);
  const [salvando, setSalvando] = useState(false);

  // título sugerido para a contagem: o fornecedor dominante da seleção
  const sugestao = useMemo(() => {
    if (tipo !== "contagem" || selecionados.size === 0) return "";
    const cont = new Map<string, number>();
    for (const p of selecionados.values()) if (p.fornecedor) cont.set(p.fornecedor, (cont.get(p.fornecedor) ?? 0) + 1);
    const top = [...cont.entries()].sort((a, b) => b[1] - a[1])[0];
    const base = top && top[1] === selecionados.size ? top[0].split(" ").slice(0, 3).join(" ") : `${selecionados.size} SKUs`;
    return `Contagem — ${base} · ${ddmm(hojeSP())}`;
  }, [tipo, selecionados]);

  async function salvar() {
    const tituloFinal = (titulo.trim() || sugestao).trim();
    if (!tituloFinal) { toast.error("Dê um título à tarefa"); return; }
    if (tipo === "contagem" && selecionados.size === 0) { toast.error("Escolha ao menos um produto para contar"); return; }
    setSalvando(true);
    try {
      const membro = equipeQ.data?.find((m) => m.id === resp);
      const { data, error } = await supabaseExternal.from("fulfillment_tarefas").insert({
        tipo, titulo: tituloFinal, descricao: descricao.trim() || null,
        responsavel_id: membro?.id ?? null, responsavel: membro?.nome ?? null,
        prazo: prazo || null, checklist: tipo === "contagem" ? [] : checklist, contagem_cega: cega,
        criado_por: criadoPor,
      }).select("id").single();
      if (error) throw error;
      const id = (data as { id: string }).id;
      if (tipo === "contagem") {
        try { await inserirItens(id, [...selecionados.values()]); }
        catch (e) {
          await supabaseExternal.from("fulfillment_tarefas").delete().eq("id", id);
          throw e;
        }
      }
      if (fotos.length) {
        // a tarefa já existe: falha na foto não desfaz a tarefa, só avisa
        try { await enviarFotosTarefa(id, fotos, criadoPor); }
        catch (e) { toast.warning("Tarefa criada, mas alguma foto não subiu", { description: (e as Error).message }); }
      }
      avisar(id, "criada");
      toast.success("Tarefa criada", { description: membro ? `Responsável: ${membro.nome}` : undefined });
      onCriada(id);
    } catch (e) {
      toast.error("Não foi possível criar a tarefa", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-3xl w-[calc(100vw-1.5rem)] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nova tarefa</DialogTitle>
          <DialogDescription>Aparece no quadro de Tarefas e avisa no Discord (canal de fulfillment).</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {TIPOS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTipo(t.id)}
                className={cn("rounded-lg border px-3 py-2.5 text-left text-sm flex items-center gap-2",
                  tipo === t.id ? "border-primary bg-primary/5 ring-1 ring-primary/40" : "hover:border-foreground/30")}>
                {t.id === "contagem" ? <ClipboardCheck className="h-4 w-4" /> : t.id === "organizacao" ? <ListChecks className="h-4 w-4" /> : <ClipboardList className="h-4 w-4" />}
                <span className="font-medium">{t.label}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_180px_160px]">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Título</span>
              <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={sugestao || (tipo === "organizacao" ? "Ex.: Reorganizar prateleira B" : "Título da tarefa")} className="bg-card" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Responsável</span>
              <Select value={resp} onValueChange={setResp}>
                <SelectTrigger className="bg-card"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_sem">Sem responsável</SelectItem>
                  {(equipeQ.data ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.nome}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Prazo</span>
              <Input type="date" value={prazo} min={hojeSP()} onChange={(e) => setPrazo(e.target.value)} className="bg-card" />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Descrição (opcional)</span>
            <Textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={2} className="bg-card"
              placeholder={tipo === "contagem" ? "Ex.: contar só a prateleira do galpão de cima" : "O que precisa ser feito"} />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Fotos (opcional — ex.: como está a prateleira)</span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50">
                <Camera className="h-4 w-4" /> Tirar foto
                <input type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; setFotos((x) => [...x, ...f]); }} />
              </label>
              <label className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50">
                <ImagePlus className="h-4 w-4" /> Escolher fotos
                <input type="file" accept="image/*" multiple className="hidden"
                  onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; setFotos((x) => [...x, ...f]); }} />
              </label>
              {fotos.map((f, i) => (
                <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-xs max-w-[180px]">
                  <span className="truncate">{f.name}</span>
                  <button type="button" className="text-muted-foreground hover:text-foreground" title="Tirar" onClick={() => setFotos((x) => x.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          </div>

          {tipo === "contagem" ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-semibold">Produtos a contar</span>
                <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Quem conta não vê o saldo do sistema — evita contar 'para bater'">
                  <Switch checked={cega} onCheckedChange={setCega} /> Contagem cega (esconde o saldo do sistema)
                </label>
              </div>
              <SeletorProdutos selecionados={selecionados} onChange={setSelecionados} />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold">Checklist</span>
              <EditorChecklist itens={checklist} onChange={setChecklist} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onFechar}>Cancelar</Button>
          <Button onClick={() => void salvar()} disabled={salvando} className="gap-1.5">
            {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
            Criar tarefa{tipo === "contagem" && selecionados.size > 0 ? ` (${selecionados.size} SKUs)` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detalhe da tarefa

function DetalheTarefa({ id, onFechar }: { id: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const equipeQ = useEquipe();
  const [confirmarConcluir, setConfirmarConcluir] = useState(false);
  const [confirmarExcluir, setConfirmarExcluir] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const tQ = useQuery({
    queryKey: ["fulfillment", "tarefa", id],
    queryFn: async (): Promise<Tarefa | null> => {
      const { data, error } = await supabaseExternal.from("view_fulfillment_tarefas").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data as Tarefa | null;
    },
  });
  const t = tQ.data;

  function recarregar() {
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefa", id] });
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefas"] });
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefa-itens", id] });
  }

  async function atualizar(campos: Record<string, unknown>, msg?: string) {
    setSalvando(true);
    const { error } = await supabaseExternal.from("fulfillment_tarefas").update({ ...campos, atualizado_em: new Date().toISOString() }).eq("id", id);
    setSalvando(false);
    if (error) { toast.error("Não foi possível salvar", { description: error.message }); return false; }
    if (msg) toast.success(msg);
    recarregar();
    return true;
  }

  async function concluir() {
    setConfirmarConcluir(false);
    const ok = await atualizar({ status: "feito", concluido_em: new Date().toISOString(), concluido_por: perfil?.nome ?? "app" }, "Tarefa concluída");
    if (ok) avisar(id, "concluida");
  }

  async function excluir() {
    setConfirmarExcluir(false);
    const { error } = await supabaseExternal.from("fulfillment_tarefas").delete().eq("id", id);
    if (error) { toast.error("Não foi possível excluir", { description: error.message }); return; }
    void apagarFotosTarefa(id).catch(() => { /* melhor-esforço */ });
    toast.success("Tarefa excluída");
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefas"] });
    onFechar();
  }

  const faltaContar = t?.tipo === "contagem" ? n(t.n_itens) - n(t.n_contados) : 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-4xl w-[calc(100vw-1rem)] max-h-[94vh] overflow-y-auto p-4 sm:p-6">
        {!t ? (
          <div className="py-10 flex justify-center text-muted-foreground">
            {tQ.isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Tarefa não encontrada."}
          </div>
        ) : (
          <>
            <DialogHeader className="text-left">
              <span className={cn("self-start text-[10.5px] font-semibold px-2 py-0.5 rounded-full", tipoDe(t.tipo).cls)}>{tipoDe(t.tipo).label}</span>
              <DialogTitle className="text-lg leading-snug pr-6">{t.titulo}</DialogTitle>
              <DialogDescription>
                Criada por {t.criado_por ?? "—"} em {new Date(t.criado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                {t.concluido_em ? ` · concluída por ${t.concluido_por ?? "—"}` : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Responsável</span>
                <Select value={t.responsavel_id ?? "_sem"} onValueChange={(v) => {
                  const m = equipeQ.data?.find((x) => x.id === v);
                  void atualizar({ responsavel_id: m?.id ?? null, responsavel: m?.nome ?? null });
                }}>
                  <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_sem">Sem responsável</SelectItem>
                    {(equipeQ.data ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.nome}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">Prazo</span>
                <Input type="date" className={cn("h-9 w-[160px]", t.atrasada && "border-red-400 text-red-700 dark:text-red-400")}
                  defaultValue={t.prazo ?? ""} onBlur={(e) => { if ((e.target.value || null) !== t.prazo) void atualizar({ prazo: e.target.value || null }); }} />
              </div>
              <div className="flex flex-wrap gap-2 ml-auto">
                {t.status === "a_fazer" && (
                  <Button size="sm" variant="outline" disabled={salvando} onClick={() => void atualizar({ status: "fazendo", iniciado_em: new Date().toISOString() }, "Tarefa iniciada")}>Iniciar</Button>
                )}
                {t.status !== "feito" ? (
                  <Button size="sm" disabled={salvando} className="gap-1.5" onClick={() => setConfirmarConcluir(true)}><Check className="h-4 w-4" /> Concluir</Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={salvando} onClick={() => void atualizar({ status: "fazendo", concluido_em: null, concluido_por: null }, "Tarefa reaberta")}>Reabrir</Button>
                )}
                {t.arquivado_em ? (
                  <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => void atualizar({ arquivado_em: null, arquivado_por: null }, "Tarefa voltou ao quadro")}><ArchiveRestore className="h-4 w-4" /> Desarquivar</Button>
                ) : (
                  <Button size="sm" variant="ghost" className="gap-1.5" onClick={async () => { if (await atualizar({ arquivado_em: new Date().toISOString(), arquivado_por: perfil?.nome ?? "app" }, "Tarefa arquivada")) onFechar(); }}><Archive className="h-4 w-4" /> Arquivar</Button>
                )}
                <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setConfirmarExcluir(true)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>

            {t.descricao && <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">{t.descricao}</p>}

            {t.tipo === "contagem" ? (
              <Contagem tarefa={t} onMudou={recarregar} />
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-semibold">Checklist</span>
                <EditorChecklist itens={t.checklist ?? []} onChange={(c) => void atualizar({ checklist: c })} />
              </div>
            )}

            <FotosTarefa tarefaId={t.id} autor={perfil?.nome ?? "app"} />

            <AlertDialog open={confirmarConcluir} onOpenChange={setConfirmarConcluir}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Concluir a tarefa?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t.tipo === "contagem" && faltaContar > 0
                      ? `Ainda faltam ${faltaContar} SKU(s) sem contagem — eles ficam de fora do ajuste. `
                      : ""}
                    {t.tipo === "contagem"
                      ? "Concluir NÃO mexe no Tiny: o ajuste de estoque é um passo separado, com prévia, mais abaixo. "
                      : ""}
                    Um aviso vai para o Discord.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Voltar</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void concluir()}>Concluir</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={confirmarExcluir} onOpenChange={setConfirmarExcluir}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir a tarefa?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Apaga a tarefa, as contagens e as fotos dela. Não desfaz ajuste já lançado no Tiny. Para só tirar do quadro, use Arquivar.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Voltar</AlertDialogCancel>
                  <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void excluir()}>Excluir</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contagem

type FiltroItens = "todos" | "faltam" | "divergentes";

function Contagem({ tarefa, onMudou }: { tarefa: Tarefa; onMudou: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [cega, setCega] = useState(tarefa.contagem_cega);
  const [filtro, setFiltro] = useState<FiltroItens>("todos");
  const [busca, setBusca] = useState("");
  const [adicionar, setAdicionar] = useState(false);
  const [novos, setNovos] = useState<Map<string, ProdutoInv>>(new Map());
  const [ajuste, setAjuste] = useState(false);
  const inputs = useRef(new Map<number, HTMLInputElement>());

  const itensQ = useQuery({
    queryKey: ["fulfillment", "tarefa-itens", tarefa.id],
    queryFn: async (): Promise<ItemTarefa[]> => {
      const { data, error } = await supabaseExternal.from("view_fulfillment_tarefa_itens").select("*")
        .eq("tarefa_id", tarefa.id).order("ordem").order("id").limit(2000);
      if (error) throw error;
      return (data ?? []) as ItemTarefa[];
    },
  });
  const itens = itensQ.data ?? [];
  const termo = busca.trim().toLowerCase();
  const visiveis = itens.filter((i) =>
    (filtro === "todos" || (filtro === "faltam" ? i.qtd_contada == null : i.diferenca != null && i.diferenca !== 0)) &&
    (!termo || i.sku.toLowerCase().includes(termo) || (i.nome ?? "").toLowerCase().includes(termo)),
  );
  const mostrarSistema = !cega || tarefa.status === "feito";

  async function salvarContagem(item: ItemTarefa, valor: string) {
    const txt = valor.trim().replace(",", ".");
    const nova = txt === "" ? null : Number(txt);
    if (nova != null && (!Number.isFinite(nova) || nova < 0)) { toast.error("Quantidade inválida"); return; }
    if (nova === item.qtd_contada) return;
    const { error } = await supabaseExternal.from("fulfillment_tarefa_itens").update({
      qtd_contada: nova, contado_em: nova == null ? null : new Date().toISOString(), contado_por: nova == null ? null : (perfil?.nome ?? "app"),
    }).eq("id", item.id);
    if (error) { toast.error("Não salvou a contagem", { description: error.message }); return; }
    // otimista na lista; o resto (contadores do card) recarrega em segundo plano
    qc.setQueryData<ItemTarefa[]>(["fulfillment", "tarefa-itens", tarefa.id], (old) => (old ?? []).map((x) => x.id === item.id
      ? { ...x, qtd_contada: nova, diferenca: nova == null || x.qtd_sistema == null ? null : nova - x.qtd_sistema }
      : x));
    if (tarefa.status === "a_fazer") {
      await supabaseExternal.from("fulfillment_tarefas").update({ status: "fazendo", iniciado_em: new Date().toISOString() }).eq("id", tarefa.id);
    }
    onMudou();
  }

  function proximo(idx: number) {
    const prox = visiveis[idx + 1];
    if (prox) inputs.current.get(prox.id)?.focus();
  }

  async function adicionarProdutos() {
    try {
      await inserirItens(tarefa.id, [...novos.values()], (itens.at(-1)?.ordem ?? 0) + 1);
      toast.success(`${novos.size} produto(s) adicionado(s)`);
      setNovos(new Map());
      setAdicionar(false);
      void itensQ.refetch();
      onMudou();
    } catch (e) { toast.error("Não foi possível adicionar", { description: (e as Error).message }); }
  }

  async function removerItem(item: ItemTarefa) {
    const { error } = await supabaseExternal.from("fulfillment_tarefa_itens").delete().eq("id", item.id);
    if (error) { toast.error("Não foi possível remover", { description: error.message }); return; }
    void itensQ.refetch();
    onMudou();
  }

  async function alternarCega(v: boolean) {
    setCega(v);
    await supabaseExternal.from("fulfillment_tarefas").update({ contagem_cega: v }).eq("id", tarefa.id);
  }

  const contados = itens.filter((i) => i.qtd_contada != null).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">Contagem</span>
          <span className="text-muted-foreground tabular-nums">{contados} de {itens.length} SKUs</span>
          {mostrarSistema && n(tarefa.n_divergentes) > 0 && (
            <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 hover:bg-amber-100">{tarefa.n_divergentes} divergente(s)</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tarefa.status !== "feito" && (
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => void alternarCega(!cega)}
              title="Contagem cega: quem conta não vê o saldo do sistema">
              {cega ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />} {cega ? "Mostrar sistema" : "Esconder sistema"}
            </Button>
          )}
          {tarefa.status !== "feito" && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdicionar((a) => !a)}>
              <Plus className="h-4 w-4" /> Produtos
            </Button>
          )}
          {contados > 0 && (
            <Button size="sm" variant={tarefa.status === "feito" ? "default" : "outline"} className="gap-1.5" onClick={() => setAjuste(true)}>
              <RefreshCw className="h-4 w-4" /> Conferir com o Tiny e ajustar
            </Button>
          )}
        </div>
      </div>

      {adicionar && (
        <div className="rounded-lg border p-3 flex flex-col gap-3 bg-muted/20">
          <SeletorProdutos selecionados={novos} onChange={setNovos} jaNaTarefa={new Set(itens.map((i) => i.sku))} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setAdicionar(false); setNovos(new Map()); }}>Cancelar</Button>
            <Button size="sm" disabled={novos.size === 0} onClick={() => void adicionarProdutos()}>Adicionar {novos.size || ""}</Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {(["todos", "faltam", "divergentes"] as FiltroItens[]).filter((f) => f !== "divergentes" || mostrarSistema).map((f) => (
          <Button key={f} size="sm" variant={filtro === f ? "default" : "outline"} className="h-8" onClick={() => setFiltro(f)}>
            {f === "todos" ? "Todos" : f === "faltam" ? `Faltam contar (${itens.length - contados})` : "Divergentes"}
          </Button>
        ))}
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar na lista…" className="pl-8 h-8" />
        </div>
      </div>

      {itensQ.isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (
        <div className="rounded-lg border divide-y">
          {visiveis.length === 0 && <div className="p-4 text-sm text-muted-foreground">Nada nesta lista.</div>}
          {visiveis.map((i, idx) => {
            const dif = i.diferenca;
            return (
              <div key={i.id} className="flex items-center gap-3 px-3 py-2">
                <Foto url={i.foto} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-snug line-clamp-2" title={i.nome ?? ""}>{i.nome ?? "—"}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    <span className="font-mono">{i.sku}</span>
                    {i.fornecedor ? ` · ${i.fornecedor}` : ""}
                    {i.ajuste_status === "lancado" && <span className="text-emerald-700 dark:text-emerald-400"> · ajustado no Tiny ({fmtQtd(i.ajuste_saldo_antes)} → {fmtQtd(i.qtd_contada)})</span>}
                    {i.ajuste_status === "igual" && <span className="text-emerald-700 dark:text-emerald-400"> · Tiny já batia</span>}
                    {i.ajuste_status === "erro" && <span className="text-red-600 dark:text-red-400" title={i.ajuste_erro ?? ""}> · erro no ajuste</span>}
                  </div>
                </div>
                {mostrarSistema && (
                  <div className="hidden sm:flex flex-col items-end text-[11px] text-muted-foreground w-20 shrink-0" title="Saldo no depósito Geral quando a tarefa foi criada (espelho do Tiny)">
                    <span>sistema</span>
                    <span className="tabular-nums text-sm text-foreground">{fmtQtd(i.qtd_sistema)}</span>
                  </div>
                )}
                <Input
                  ref={(el) => { if (el) inputs.current.set(i.id, el); else inputs.current.delete(i.id); }}
                  key={`${i.id}-${i.qtd_contada ?? ""}`}
                  defaultValue={i.qtd_contada ?? ""}
                  inputMode="decimal"
                  placeholder="contado"
                  disabled={!!i.ajuste_status && i.ajuste_status !== "erro"}
                  className="w-24 h-11 text-center text-base tabular-nums shrink-0"
                  onBlur={(e) => void salvarContagem(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); proximo(idx); } }}
                />
                {mostrarSistema && (
                  <span className={cn("w-14 text-right text-sm font-semibold tabular-nums shrink-0",
                    dif == null ? "text-muted-foreground" : dif === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                    {dif == null ? "" : dif === 0 ? "ok" : `${dif > 0 ? "+" : ""}${fmtQtd(dif)}`}
                  </span>
                )}
                {tarefa.status !== "feito" && i.qtd_contada == null && (
                  <button type="button" onClick={() => void removerItem(i)} className="text-muted-foreground hover:text-destructive shrink-0" aria-label={`Tirar ${i.sku} da contagem`}>
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {mostrarSistema && (
        <p className="text-[11px] text-muted-foreground">
          "Sistema" é o saldo do depósito Geral quando a tarefa foi criada. Antes de ajustar, o app relê o saldo atual no Tiny.
        </p>
      )}

      {ajuste && <AjusteTiny tarefa={tarefa} onFechar={() => setAjuste(false)} onAplicado={() => { void itensQ.refetch(); onMudou(); }} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ajuste no Tiny (prévia ao vivo → confirmação → balanço)

interface LinhaPrevia {
  sku: string; nome: string | null; contada: number; sistema_na_criacao: number | null; ajuste_status: string | null;
  saldo?: number; reservado?: number; disponivel?: number; diferenca?: number; erro?: string;
}

function AjusteTiny({ tarefa, onFechar, onAplicado }: { tarefa: Tarefa; onFechar: () => void; onAplicado: () => void }) {
  const { perfil } = usePerfil();
  const [linhas, setLinhas] = useState<LinhaPrevia[] | null>(null);
  const [lendo, setLendo] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [confirmar, setConfirmar] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [progresso, setProgresso] = useState<{ feitos: number; total: number } | null>(null);
  const [resultado, setResultado] = useState<{ lancados: number; iguais: number; erros: number } | null>(null);

  async function ler() {
    setLendo(true); setErro(null); setResultado(null);
    try {
      const acc: LinhaPrevia[] = [];
      let pendentes: string[] | undefined;
      for (let rodada = 0; rodada < 20; rodada++) {
        const r = await chamarEdge("ajuste-preview", { tarefa_id: tarefa.id, ...(pendentes ? { skus: pendentes } : {}) });
        acc.push(...(r.linhas ?? []));
        setLinhas([...acc]);
        if (!r.restantes?.length) break;
        pendentes = r.restantes;
      }
      setLinhas(acc);
      setMarcados(new Set(acc.filter((l) => l.diferenca != null && l.diferenca !== 0 && !l.erro && l.ajuste_status !== "lancado").map((l) => l.sku)));
    } catch (e) { setErro((e as Error).message); }
    finally { setLendo(false); }
  }
  useEffect(() => { void ler(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function aplicar() {
    setConfirmar(false); setAplicando(true);
    let pend = [...marcados];
    const total = pend.length;
    const tot = { lancados: 0, iguais: 0, erros: 0 };
    try {
      for (let rodada = 0; rodada < 30 && pend.length > 0; rodada++) {
        const r = await chamarEdge("ajuste-aplicar", { tarefa_id: tarefa.id, skus: pend, por: perfil?.nome ?? "app" }, "&confirmar=1");
        for (const x of r.resultados ?? []) {
          if (x.status === "lancado") tot.lancados++; else if (x.status === "igual") tot.iguais++; else tot.erros++;
        }
        pend = r.restantes ?? [];
        setProgresso({ feitos: total - pend.length, total });
      }
      setResultado(tot);
      if (tot.erros) toast.warning(`Ajuste com ${tot.erros} erro(s)`, { description: `${tot.lancados} lançado(s) no Tiny` });
      else toast.success(`Ajuste lançado no Tiny — ${tot.lancados} SKU(s)`);
      onAplicado();
      await ler();
    } catch (e) {
      toast.error("O ajuste parou", { description: (e as Error).message });
    } finally { setAplicando(false); setProgresso(null); }
  }

  const divergentes = (linhas ?? []).filter((l) => l.diferenca != null && l.diferenca !== 0);
  const iguais = (linhas ?? []).filter((l) => l.diferenca === 0);
  const comErro = (linhas ?? []).filter((l) => l.erro);

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !aplicando) onFechar(); }}>
      <DialogContent className="max-w-3xl w-[calc(100vw-1rem)] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Conferir com o Tiny e ajustar</DialogTitle>
          <DialogDescription>
            Saldo do depósito <b>Geral</b> lido agora no Tiny × quantidade contada. Só os marcados recebem balanço — o saldo
            passa a ser exatamente o contado. Os depósitos Full não são tocados.
          </DialogDescription>
        </DialogHeader>

        {erro && <div className="text-sm text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {erro}</div>}
        {lendo && <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Lendo o Tiny… {linhas ? `${linhas.length} SKU(s)` : ""}</div>}
        {resultado && (
          <div className="rounded-md border border-emerald-300/60 bg-emerald-500/5 px-3 py-2 text-sm">
            Lançado: {resultado.lancados} · já batia: {resultado.iguais}{resultado.erros ? ` · erro: ${resultado.erros}` : ""}
          </div>
        )}

        {linhas && !lendo && (
          <div className="flex flex-col gap-3">
            <div className="text-xs text-muted-foreground">
              {divergentes.length} divergente(s) · {iguais.length} batendo{comErro.length ? ` · ${comErro.length} com erro de leitura` : ""}
            </div>
            <div className="rounded-md border border-amber-300/60 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-300 flex gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>Pedido já separado ou embalado que ainda não saiu do saldo no Tiny não está na prateleira. Se a separação andou durante a contagem, confira esses SKUs antes de ajustar.</span>
            </div>
            {divergentes.length > 0 && (
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                      <th className="py-2 px-3 w-8">
                        <Checkbox checked={divergentes.every((l) => marcados.has(l.sku))}
                          onCheckedChange={(v) => setMarcados(v ? new Set(divergentes.filter((l) => l.ajuste_status !== "lancado").map((l) => l.sku)) : new Set())} />
                      </th>
                      <th className="py-2 px-3">Produto</th>
                      <th className="py-2 px-3 text-right">Tiny agora</th>
                      <th className="py-2 px-3 text-right">Contado</th>
                      <th className="py-2 px-3 text-right">Diferença</th>
                    </tr>
                  </thead>
                  <tbody>
                    {divergentes.map((l) => (
                      <tr key={l.sku} className="border-b last:border-0">
                        <td className="py-1.5 px-3">
                          <Checkbox checked={marcados.has(l.sku)} onCheckedChange={(v) => {
                            const m = new Set(marcados); if (v) m.add(l.sku); else m.delete(l.sku); setMarcados(m);
                          }} />
                        </td>
                        <td className="py-1.5 px-3">
                          <div className="truncate max-w-[280px]" title={l.nome ?? ""}>{l.nome ?? "—"}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{l.sku}{l.ajuste_status === "lancado" ? " · já ajustado" : ""}</div>
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums">
                          {fmtQtd(l.saldo)}{n(l.reservado) > 0 && <div className="text-[11px] text-muted-foreground">{fmtQtd(l.reservado)} reservado</div>}
                        </td>
                        <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{fmtQtd(l.contada)}</td>
                        <td className={cn("py-1.5 px-3 text-right tabular-nums font-semibold", n(l.diferenca) > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
                          {n(l.diferenca) > 0 ? "+" : ""}{fmtQtd(l.diferenca)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {comErro.length > 0 && (
              <div className="text-xs text-red-700 dark:text-red-400 flex flex-col gap-0.5">
                {comErro.map((l) => <span key={l.sku}><span className="font-mono">{l.sku}</span>: {l.erro}</span>)}
              </div>
            )}
            {divergentes.length === 0 && comErro.length === 0 && (
              <div className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2"><Check className="h-4 w-4" /> Tudo o que foi contado bate com o Tiny.</div>
            )}
          </div>
        )}

        {progresso && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Lançando no Tiny… {progresso.feitos} de {progresso.total}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onFechar} disabled={aplicando}>Fechar</Button>
          <Button variant="outline" onClick={() => void ler()} disabled={lendo || aplicando} className="gap-1.5">
            <RefreshCw className={cn("h-4 w-4", lendo && "animate-spin")} /> Reler
          </Button>
          <Button onClick={() => setConfirmar(true)} disabled={lendo || aplicando || marcados.size === 0}>
            Lançar ajuste ({marcados.size})
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmar} onOpenChange={setConfirmar}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Lançar balanço no Tiny para {marcados.size} SKU(s)?</AlertDialogTitle>
              <AlertDialogDescription>
                O saldo do depósito Geral de cada SKU marcado vira a quantidade contada. O Tiny repassa o estoque aos anúncios
                dos marketplaces. O app relê o saldo antes de cada lançamento e pula quem já bate. Não há desfazer automático.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Voltar</AlertDialogCancel>
              <AlertDialogAction onClick={() => void aplicar()}>Lançar ajuste</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
