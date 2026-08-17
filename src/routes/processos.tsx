import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, Pencil, Check, Plus, X, Trash2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useAuth } from "@/hooks/useAuth";
import { usePerfil } from "@/hooks/usePerfil";
import { toast } from "sonner";

// ============================================================================
// Manual de Processos — checklist operacional DIÁRIO do galpão/expedição.
// Import do design "Manual de Processos.dc.html" (Claude Design), portado para
// o tema do app (o toggle de tema do mock sai: o app já tem o seu).
//
// O checklist é INDIVIDUAL: cada pessoa marca o seu, e o progresso do dia é por
// pessoa (manual_progresso tem UNIQUE (data, tarefa_id, pessoa_id)).
//
// Fonte de dados:
//   manual_equipe    pessoas/funções (user_id liga a pessoa ao login)
//   manual_secoes    processos (avisos jsonb, tabela_ref jsonb)
//   manual_tarefas   tarefas da seção (responsavel_id null = herda da seção)
//   manual_progresso marcação do dia, por pessoa
// Editar a estrutura é só para admin (perfil com módulo `todos`); marcar tarefa
// é de qualquer um do galpão.
// ============================================================================

// ---- paleta de acento (do design; funciona em tema claro/escuro) ----
const PALETTE = ["#2F6FB0", "#7A5CC7", "#DB6B1F", "#0E8A5F", "#B7791F", "#0891B2", "#BE4B8F"];
const GREEN = "#0E8A5F", RED = "#C9432F", AMBER = "#B7791F", BLUE = "#2F6FB0";
const ACCENT = "#6E56CF";

type Aviso = { tipo: "info" | "warn"; texto: string };
type TabelaRef = { head: string[]; rows: string[][] };

type Pessoa = { id: number; nome: string; cor: string; user_id: string | null; ordem: number };
type Secao = {
  id: number; codigo: string; titulo: string; descricao: string | null;
  frequencia: string | null; responsavel_id: number | null;
  avisos: Aviso[]; tabela_ref: TabelaRef | null; ordem: number;
};
type Tarefa = {
  id: number; secao_id: number; texto: string; tags: string[];
  responsavel_id: number | null; ordem: number;
};

// Dia de hoje (SP) em YYYY-MM-DD — a virada do dia segue o fuso da operação.
function hojeSP(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
function dataExtenso(): string {
  const s = new Date().toLocaleDateString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", timeZone: "America/Sao_Paulo",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Alguns textos vieram do manual em HTML e usam <b> para o ponto crítico. Em vez
// de dangerouslySetInnerHTML (o texto é editável por admin — não confiar), só o
// <b> é reconhecido e vira <strong>; qualquer outra marcação segue como texto.
function comNegrito(texto: string) {
  const partes = texto.split(/(<b>.*?<\/b>)/gi);
  return partes.map((p, i) => {
    const m = /^<b>(.*)<\/b>$/is.exec(p);
    return m ? <strong key={i}>{m[1]}</strong> : <span key={i}>{p}</span>;
  });
}

// Cor da tag (do design): "Se ..." = âmbar (condicional), "Diária" = azul, resto neutro.
function tagStyle(tag: string): { bg: string; fg: string } {
  const t = tag.toLowerCase();
  if (t.startsWith("se ")) return { bg: AMBER + "16", fg: AMBER };
  if (tag === "Diária") return { bg: BLUE + "16", fg: BLUE };
  return { bg: "", fg: "" }; // neutro → usa classes do tema
}

type SearchParams = { q: string; pessoa: number | null };

export const Route = createFileRoute("/processos")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    q: typeof s.q === "string" ? s.q : "",
    pessoa: Number.isFinite(Number(s.pessoa)) && s.pessoa !== null && s.pessoa !== "" ? Number(s.pessoa) : null,
  }),
  component: ProcessosPage,
});

function ProcessosPage() {
  const navigate = useNavigate({ from: "/processos" });
  const { q, pessoa: pessoaFiltro } = Route.useSearch();
  const { user } = useAuth();
  const { perfil } = usePerfil();
  const qc = useQueryClient();

  const isAdmin = !!perfil?.modulos?.includes("todos");
  const [editMode, setEditMode] = useState(false);
  const editOn = editMode && isAdmin;

  const dia = hojeSP();

  // ---- dados ----
  const equipeQ = useQuery({
    queryKey: ["manual", "equipe"],
    queryFn: async (): Promise<Pessoa[]> => {
      const { data, error } = await supabaseExternal
        .from("manual_equipe")
        .select("id, nome, cor, user_id, ordem")
        .eq("ativo", true)
        .order("ordem", { ascending: true }).order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Pessoa[];
    },
  });

  const secoesQ = useQuery({
    queryKey: ["manual", "secoes"],
    queryFn: async (): Promise<Secao[]> => {
      const { data, error } = await supabaseExternal
        .from("manual_secoes")
        .select("id, codigo, titulo, descricao, frequencia, responsavel_id, avisos, tabela_ref, ordem")
        .eq("ativo", true)
        .order("ordem", { ascending: true }).order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Secao[];
    },
  });

  const tarefasQ = useQuery({
    queryKey: ["manual", "tarefas"],
    queryFn: async (): Promise<Tarefa[]> => {
      const { data, error } = await supabaseExternal
        .from("manual_tarefas")
        .select("id, secao_id, texto, tags, responsavel_id, ordem")
        .eq("ativo", true)
        .order("ordem", { ascending: true }).order("id", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Tarefa[];
    },
  });

  const equipe = useMemo(() => equipeQ.data ?? [], [equipeQ.data]);
  const secoes = useMemo(() => secoesQ.data ?? [], [secoesQ.data]);
  const tarefas = useMemo(() => tarefasQ.data ?? [], [tarefasQ.data]);

  // ---- quem sou eu: pelo user_id; senão escolha manual (localStorage) ----
  const [euManual, setEuManual] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem("processos.euId");
    return v ? Number(v) : null;
  });
  const eu = useMemo(() => {
    const porLogin = user ? equipe.find((p) => p.user_id === user.id) : undefined;
    if (porLogin) return porLogin;
    return equipe.find((p) => p.id === euManual) ?? null;
  }, [equipe, user, euManual]);

  function escolherEu(id: number) {
    setEuManual(id);
    if (typeof window !== "undefined") window.localStorage.setItem("processos.euId", String(id));
  }

  // ---- progresso do dia (meu) ----
  const progressoQ = useQuery({
    queryKey: ["manual", "progresso", dia, eu?.id ?? 0],
    enabled: !!eu,
    queryFn: async (): Promise<Set<number>> => {
      const { data, error } = await supabaseExternal
        .from("manual_progresso")
        .select("tarefa_id, feito")
        .eq("data", dia).eq("pessoa_id", eu!.id);
      if (error) throw error;
      const s = new Set<number>();
      for (const r of (data ?? []) as { tarefa_id: number; feito: boolean }[]) {
        if (r.feito) s.add(r.tarefa_id);
      }
      return s;
    },
  });
  const feitas = progressoQ.data ?? new Set<number>();

  const pessoaPorId = useMemo(() => new Map(equipe.map((p) => [p.id, p])), [equipe]);
  const secaoPorId = useMemo(() => new Map(secoes.map((s) => [s.id, s])), [secoes]);
  // Responsável efetivo: o da tarefa, senão o da seção.
  const efetivo = (t: Tarefa): number | null =>
    t.responsavel_id ?? secaoPorId.get(t.secao_id)?.responsavel_id ?? null;

  const contarDe = (pid: number) => tarefas.filter((t) => efetivo(t) === pid).length;

  // ---- progresso global (minhas tarefas de hoje) ----
  const minhas = eu ? tarefas.filter((t) => efetivo(t) === eu.id) : [];
  const minhasTotal = minhas.length;
  const minhasFeitas = minhas.filter((t) => feitas.has(t.id)).length;
  const globalPct = minhasTotal ? Math.round((minhasFeitas / minhasTotal) * 100) : 0;
  const globalBar = globalPct === 100 ? GREEN : ACCENT;

  // ---- marcação (update otimista) ----
  const progKey = ["manual", "progresso", dia, eu?.id ?? 0];
  async function marcarTarefa(tarefaId: number, feito: boolean) {
    if (!eu) return;
    qc.setQueryData<Set<number>>(progKey, (old) => {
      const s = new Set(old ?? []);
      if (feito) s.add(tarefaId); else s.delete(tarefaId);
      return s;
    });
    const { error } = await supabaseExternal
      .from("manual_progresso")
      .upsert(
        { data: dia, tarefa_id: tarefaId, pessoa_id: eu.id, feito, feito_em: new Date().toISOString() },
        { onConflict: "data,tarefa_id,pessoa_id" },
      );
    if (error) {
      toast.error("Não deu para salvar", { description: error.message });
      void progressoQ.refetch();
    }
  }

  async function iniciarNovoDia() {
    if (!eu) return;
    if (!window.confirm("Iniciar novo dia? Isso desmarca todas as suas tarefas concluídas hoje. As atribuições continuam as mesmas.")) return;
    qc.setQueryData<Set<number>>(progKey, new Set<number>());
    const { error } = await supabaseExternal
      .from("manual_progresso").delete().eq("data", dia).eq("pessoa_id", eu.id);
    if (error) {
      toast.error("Falha ao reiniciar o dia", { description: error.message });
      void progressoQ.refetch();
    } else {
      toast.success("Novo dia iniciado");
    }
  }

  // ---- colapso das seções ----
  const [colapsadas, setColapsadas] = useState<Record<number, boolean>>({});
  const toggleColapso = (id: number) => setColapsadas((c) => ({ ...c, [id]: !c[id] }));

  // ---- filtros (URL) ----
  const setQ = (v: string) => navigate({ search: (s) => ({ ...s, q: v }), replace: true });
  const setPessoa = (v: number | null) => navigate({ search: (s) => ({ ...s, pessoa: v }), replace: true });
  const busca = q.trim().toLowerCase();

  // ---- CRUD (admin) ----
  const invalidar = (k: string) => qc.invalidateQueries({ queryKey: ["manual", k] });

  async function salvarPessoa(id: number, patch: Partial<Pessoa>) {
    qc.setQueryData<Pessoa[]>(["manual", "equipe"], (old) =>
      (old ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)));
    const { error } = await supabaseExternal.from("manual_equipe").update(patch).eq("id", id);
    if (error) { toast.error("Falha ao salvar pessoa", { description: error.message }); void invalidar("equipe"); }
  }
  async function adicionarPessoa(nome: string) {
    const usados = equipe.map((p) => p.cor);
    const cor = PALETTE.find((c) => !usados.includes(c)) ?? PALETTE[equipe.length % PALETTE.length];
    const ordem = equipe.reduce((m, p) => Math.max(m, p.ordem), 0) + 1;
    const { error } = await supabaseExternal.from("manual_equipe").insert({ nome, cor, ordem });
    if (error) toast.error("Falha ao adicionar", { description: error.message });
    void invalidar("equipe");
  }
  async function removerPessoa(p: Pessoa) {
    if (equipe.length <= 1) { toast.warning("Precisa haver ao menos uma pessoa na equipe."); return; }
    if (!window.confirm(`Remover "${p.nome}"? As tarefas dela ficam sem responsável até você reatribuir.`)) return;
    // Solta as referências antes de desativar (senão as tarefas ficam órfãs "invisíveis").
    await supabaseExternal.from("manual_tarefas").update({ responsavel_id: null }).eq("responsavel_id", p.id);
    await supabaseExternal.from("manual_secoes").update({ responsavel_id: null }).eq("responsavel_id", p.id);
    const { error } = await supabaseExternal.from("manual_equipe").update({ ativo: false }).eq("id", p.id);
    if (error) toast.error("Falha ao remover", { description: error.message });
    if (pessoaFiltro === p.id) setPessoa(null);
    void invalidar("equipe"); void invalidar("secoes"); void invalidar("tarefas");
  }

  async function salvarSecao(id: number, patch: Partial<Secao>) {
    qc.setQueryData<Secao[]>(["manual", "secoes"], (old) =>
      (old ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const { error } = await supabaseExternal.from("manual_secoes").update(patch).eq("id", id);
    if (error) { toast.error("Falha ao salvar seção", { description: error.message }); void invalidar("secoes"); }
  }
  async function adicionarSecao() {
    const ordem = secoes.reduce((m, s) => Math.max(m, s.ordem), 0) + 1;
    const { error } = await supabaseExternal.from("manual_secoes").insert({
      codigo: `NOVA-${String(secoes.length + 1).padStart(2, "0")}`,
      titulo: "Nova seção", descricao: "", frequencia: "Diária",
      responsavel_id: equipe[0]?.id ?? null, avisos: [], ordem,
    });
    if (error) toast.error("Falha ao criar seção", { description: error.message });
    void invalidar("secoes");
  }
  async function removerSecao(s: Secao) {
    if (!window.confirm(`Remover a seção "${s.titulo}" e todas as suas tarefas?`)) return;
    await supabaseExternal.from("manual_tarefas").update({ ativo: false }).eq("secao_id", s.id);
    const { error } = await supabaseExternal.from("manual_secoes").update({ ativo: false }).eq("id", s.id);
    if (error) toast.error("Falha ao remover seção", { description: error.message });
    void invalidar("secoes"); void invalidar("tarefas");
  }

  async function salvarTarefa(id: number, patch: Partial<Tarefa>) {
    qc.setQueryData<Tarefa[]>(["manual", "tarefas"], (old) =>
      (old ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const { error } = await supabaseExternal.from("manual_tarefas").update(patch).eq("id", id);
    if (error) { toast.error("Falha ao salvar tarefa", { description: error.message }); void invalidar("tarefas"); }
  }
  async function adicionarTarefa(secaoId: number, texto: string) {
    const daSecao = tarefas.filter((t) => t.secao_id === secaoId);
    const ordem = daSecao.reduce((m, t) => Math.max(m, t.ordem), 0) + 1;
    const { error } = await supabaseExternal.from("manual_tarefas")
      .insert({ secao_id: secaoId, texto, tags: [], ordem });
    if (error) toast.error("Falha ao adicionar tarefa", { description: error.message });
    void invalidar("tarefas");
  }
  async function removerTarefa(id: number) {
    qc.setQueryData<Tarefa[]>(["manual", "tarefas"], (old) => (old ?? []).filter((t) => t.id !== id));
    const { error } = await supabaseExternal.from("manual_tarefas").update({ ativo: false }).eq("id", id);
    if (error) { toast.error("Falha ao remover tarefa", { description: error.message }); void invalidar("tarefas"); }
  }

  // ---- montagem das seções visíveis ----
  const secoesVisiveis = useMemo(() => {
    return secoes
      .map((s) => {
        const daSecao = tarefas.filter((t) => t.secao_id === s.id);
        const visiveis = daSecao.filter((t) => {
          if (editOn) return true;
          if (pessoaFiltro != null && efetivo(t) !== pessoaFiltro) return false;
          if (busca) {
            const hay = `${t.texto} ${s.titulo} ${s.codigo} ${(t.tags ?? []).join(" ")}`.toLowerCase();
            if (!hay.includes(busca)) return false;
          }
          return true;
        });
        const done = daSecao.filter((t) => feitas.has(t.id)).length;
        const pct = daSecao.length ? Math.round((done / daSecao.length) * 100) : 0;
        return { secao: s, tarefas: visiveis, pct, completa: daSecao.length > 0 && pct === 100 };
      })
      .filter((x) => editOn || x.tarefas.length > 0);
  }, [secoes, tarefas, editOn, pessoaFiltro, busca, feitas, secaoPorId]);

  const carregando = equipeQ.isLoading || secoesQ.isLoading || tarefasQ.isLoading;
  const erro = equipeQ.error || secoesQ.error || tarefasQ.error;

  const totalTarefas = tarefas.length;

  return (
    <div className="w-full max-w-[900px] mx-auto px-4 md:px-6 py-6 flex flex-col gap-4">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-[21px] font-extrabold tracking-tight leading-tight">Manual de Processos</h1>
          <span className="text-[13px] font-semibold text-muted-foreground tracking-wide">
            Operação · Separação · Expedição
          </span>
        </div>
        <span className="text-[12.5px] font-semibold text-muted-foreground whitespace-nowrap mt-1">
          {dataExtenso()}
        </span>
      </div>

      {erro && (
        <Card className="p-4 border-destructive/30 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Erro ao carregar o manual</p>
          <p className="text-xs text-muted-foreground mt-1">{(erro as Error).message}</p>
        </Card>
      )}

      {/* Quem sou eu (quando o login não está ligado a uma pessoa) */}
      {!carregando && !eu && equipe.length > 0 && (
        <Card className="p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-bold">Quem é você?</span>
            <span className="text-xs text-muted-foreground">
              O checklist é individual. Escolha seu nome para marcar as suas tarefas do dia.
              {isAdmin && " (No modo edição dá para ligar cada pessoa a um login.)"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {equipe.map((p) => (
              <button
                key={p.id}
                onClick={() => escolherEu(p.id)}
                className="flex items-center gap-2 rounded-full border-[1.5px] px-3.5 py-2 text-[12.5px] font-bold transition-colors hover:bg-muted"
                style={{ borderColor: p.cor, color: p.cor }}
              >
                <span className="w-[7px] h-[7px] rounded-full" style={{ background: p.cor }} />
                {p.nome}
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Progresso do dia */}
      <Card className="p-[18px_20px] flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-2.5">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Progresso do dia</span>
          <span className="text-[26px] font-extrabold font-mono tracking-tight tabular-nums" style={{ color: globalBar }}>
            {globalPct}%
          </span>
        </div>
        <div className="h-2.5 rounded-md bg-muted overflow-hidden">
          <div className="h-full rounded-md transition-all duration-300" style={{ width: `${globalPct}%`, background: globalBar }} />
        </div>
        <span className="text-xs text-muted-foreground">
          {!eu
            ? "Escolha quem é você para acompanhar o seu progresso."
            : minhasTotal > 0
              ? `${minhasFeitas} de ${minhasTotal} tarefas suas concluídas hoje, ${eu.nome}`
              : "Nenhuma tarefa atribuída a você hoje."}
        </span>
      </Card>

      {/* Chips por pessoa */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {[{ id: null as number | null, nome: "Todos", cor: ACCENT, count: totalTarefas }]
          .concat(equipe.map((p) => ({ id: p.id as number | null, nome: p.nome, cor: p.cor, count: contarDe(p.id) })))
          .map((c) => {
            const ativo = pessoaFiltro === c.id;
            return (
              <button
                key={String(c.id)}
                onClick={() => setPessoa(c.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border-[1.5px] px-3 py-2 text-[12.5px] font-bold whitespace-nowrap transition-colors",
                  ativo ? "" : "bg-card border-border text-foreground hover:border-muted-foreground/40",
                )}
                style={ativo ? { background: c.cor + "18", color: c.cor, borderColor: c.cor } : undefined}
              >
                <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: c.cor }} />
                <span>{c.nome}</span>
                <span
                  className={cn("text-[10.5px] font-bold rounded-full px-[7px] py-px", !ativo && "bg-muted text-muted-foreground")}
                  style={ativo ? { background: c.cor + "2a", color: c.cor } : undefined}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
      </div>

      {/* Busca + ações */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="flex-1 min-w-[180px] flex items-center gap-2 bg-card border border-border rounded-[11px] px-3.5 py-3">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar tarefa, processo ou palavra-chave"
            className="border-0 outline-none bg-transparent text-[13.5px] flex-1 min-w-0 text-foreground"
          />
        </div>
        <button
          onClick={() => void iniciarNovoDia()}
          disabled={!eu}
          className="border border-border bg-card text-foreground text-[13px] font-bold px-4 py-3 rounded-[11px] whitespace-nowrap hover:bg-muted transition-colors disabled:opacity-50"
        >
          Iniciar novo dia
        </button>
        {isAdmin && (
          <button
            onClick={() => setEditMode((v) => !v)}
            className="text-[13px] font-bold px-4 py-3 rounded-[11px] whitespace-nowrap text-white inline-flex items-center gap-1.5"
            style={{ background: ACCENT }}
          >
            {editMode ? <><Check className="h-4 w-4" /> Concluir edição</> : <><Pencil className="h-3.5 w-3.5" /> Editar</>}
          </button>
        )}
      </div>

      {editOn && (
        <div
          className="text-[12.5px] font-bold px-3.5 py-2.5 rounded-[10px] text-center border"
          style={{ background: ACCENT + "1a", borderColor: ACCENT, color: ACCENT }}
        >
          Modo edição — gerencie a equipe, processos e responsáveis
        </div>
      )}

      {editOn && <Roster equipe={equipe} contarDe={contarDe} onSalvar={salvarPessoa} onAdicionar={adicionarPessoa} onRemover={removerPessoa} eu={eu} />}

      {carregando ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando o manual…
        </div>
      ) : secoes.length === 0 ? (
        <Card className="p-[60px_24px] border-dashed flex flex-col items-center gap-2.5 text-center">
          <span className="text-[14.5px] font-semibold">Nenhum processo cadastrado ainda</span>
          {editOn && (
            <button onClick={() => void adicionarSecao()} className="text-[13px] font-bold text-white px-4 py-2.5 rounded-[10px]" style={{ background: ACCENT }}>
              + Nova seção
            </button>
          )}
        </Card>
      ) : secoesVisiveis.length === 0 ? (
        <Card className="p-[50px_24px] border-dashed flex flex-col items-center gap-3.5 text-center">
          <span className="text-sm text-muted-foreground">Nenhuma tarefa encontrada com esse filtro ou busca</span>
          <button
            onClick={() => { setQ(""); setPessoa(null); }}
            className="border border-border bg-card text-[13px] font-semibold px-4 py-2.5 rounded-[9px] hover:bg-muted transition-colors"
          >
            Limpar filtros
          </button>
        </Card>
      ) : (
        <div className="flex flex-col gap-3.5">
          {secoesVisiveis.map(({ secao, tarefas: ts, pct, completa }) => (
            <SecaoCard
              key={secao.id}
              secao={secao}
              tarefas={ts}
              pct={pct}
              completa={completa}
              colapsada={!!colapsadas[secao.id]}
              onToggleColapso={() => toggleColapso(secao.id)}
              equipe={equipe}
              pessoaPorId={pessoaPorId}
              efetivo={efetivo}
              feitas={feitas}
              podeMarcar={!!eu}
              editOn={editOn}
              onMarcar={marcarTarefa}
              onSalvarSecao={salvarSecao}
              onRemoverSecao={removerSecao}
              onSalvarTarefa={salvarTarefa}
              onAdicionarTarefa={adicionarTarefa}
              onRemoverTarefa={removerTarefa}
            />
          ))}
        </div>
      )}

      {editOn && secoes.length > 0 && (
        <button
          onClick={() => void adicionarSecao()}
          className="border border-dashed text-[13px] font-bold px-4 py-3.5 rounded-[14px] bg-transparent"
          style={{ borderColor: ACCENT, color: ACCENT }}
        >
          + Nova seção
        </button>
      )}

      <span className="text-[11.5px] text-muted-foreground text-center leading-relaxed mt-1.5">
        Revisar este manual a cada 6 meses ou quando houver mudança de processo. · Versão 2.0
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Equipe (modo edição)

function Roster({
  equipe, contarDe, onSalvar, onAdicionar, onRemover, eu,
}: {
  equipe: Pessoa[];
  contarDe: (id: number) => number;
  onSalvar: (id: number, patch: Partial<Pessoa>) => void;
  onAdicionar: (nome: string) => void;
  onRemover: (p: Pessoa) => void;
  eu: Pessoa | null;
}) {
  const [novo, setNovo] = useState("");
  const [paletaDe, setPaletaDe] = useState<number | null>(null);

  return (
    <div className="rounded-2xl p-[18px_20px] flex flex-col gap-3 border-[1.5px]" style={{ background: ACCENT + "0d", borderColor: ACCENT }}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-extrabold" style={{ color: ACCENT }}>Equipe</span>
        <span className="text-xs text-muted-foreground">
          Renomeie clicando no nome, troque a cor no quadrado e remova pessoas. Tarefas de alguém removido ficam sem responsável.
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {equipe.map((p) => (
          <div key={p.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5 bg-card border border-border rounded-[11px] px-3 py-2.5 flex-wrap">
              <button
                onClick={() => setPaletaDe((v) => (v === p.id ? null : p.id))}
                title="Trocar cor"
                className="w-6 h-6 rounded-[7px] border-2 border-border shrink-0"
                style={{ background: p.cor }}
              />
              <input
                defaultValue={p.nome}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== p.nome) onSalvar(p.id, { nome: v }); }}
                className="flex-1 min-w-[90px] border-0 outline-none bg-transparent text-[13.5px] font-bold text-foreground"
              />
              <span className="text-[11px] font-semibold text-muted-foreground bg-muted rounded-full px-2.5 py-0.5 whitespace-nowrap">
                {contarDe(p.id)} tarefas
              </span>
              {equipe.length > 1 && p.id !== eu?.id && (
                <button onClick={() => onRemover(p)} title="Remover" className="p-1 rounded-md" style={{ color: RED }}>
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {paletaDe === p.id && (
              <div className="flex gap-1.5 flex-wrap p-2 bg-card border border-border rounded-[10px]">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    onClick={() => { onSalvar(p.id, { cor: c }); setPaletaDe(null); }}
                    className="w-6 h-6 rounded-[7px] border-2 border-transparent"
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          value={novo}
          onChange={(e) => setNovo(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && novo.trim()) { onAdicionar(novo.trim()); setNovo(""); } }}
          placeholder="Nome do novo integrante"
          className="flex-1 min-w-[160px] border border-border rounded-[9px] px-3 py-2.5 text-[13px] bg-card text-foreground outline-none"
        />
        <button
          onClick={() => { if (novo.trim()) { onAdicionar(novo.trim()); setNovo(""); } }}
          className="text-[13px] font-bold text-white px-3.5 py-2.5 rounded-[9px] whitespace-nowrap inline-flex items-center gap-1"
          style={{ background: ACCENT }}
        >
          <Plus className="h-4 w-4" /> Adicionar
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cartão de seção

function SecaoCard({
  secao, tarefas, pct, completa, colapsada, onToggleColapso, equipe, pessoaPorId, efetivo,
  feitas, podeMarcar, editOn, onMarcar, onSalvarSecao, onRemoverSecao, onSalvarTarefa,
  onAdicionarTarefa, onRemoverTarefa,
}: {
  secao: Secao; tarefas: Tarefa[]; pct: number; completa: boolean;
  colapsada: boolean; onToggleColapso: () => void;
  equipe: Pessoa[]; pessoaPorId: Map<number, Pessoa>;
  efetivo: (t: Tarefa) => number | null;
  feitas: Set<number>; podeMarcar: boolean; editOn: boolean;
  onMarcar: (id: number, feito: boolean) => void;
  onSalvarSecao: (id: number, patch: Partial<Secao>) => void;
  onRemoverSecao: (s: Secao) => void;
  onSalvarTarefa: (id: number, patch: Partial<Tarefa>) => void;
  onAdicionarTarefa: (secaoId: number, texto: string) => void;
  onRemoverTarefa: (id: number) => void;
}) {
  const [novaTarefa, setNovaTarefa] = useState("");
  const barra = pct === 100 ? GREEN : ACCENT;

  const chip = (pid: number | null) => {
    const p = pid != null ? pessoaPorId.get(pid) : undefined;
    if (!p) return { nome: "Não atribuído", bg: "", fg: "" };
    return { nome: p.nome, bg: p.cor + "18", fg: p.cor };
  };
  const respSecao = chip(secao.responsavel_id);

  return (
    <div className="bg-card border-[1.5px] border-border rounded-2xl overflow-hidden">
      {/* Cabeçalho da seção */}
      <div onClick={onToggleColapso} className="cursor-pointer p-[16px_18px] flex items-center gap-3.5 flex-wrap hover:bg-muted/40 transition-colors">
        <span className="text-[13px] font-extrabold font-mono px-2.5 py-1.5 rounded-lg shrink-0 bg-foreground text-background">
          {secao.codigo}
        </span>

        <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
          <span className="text-lg font-extrabold tracking-tight leading-tight">{secao.titulo}</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={cn("text-[11.5px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap", !respSecao.bg && "bg-muted text-muted-foreground")}
              style={respSecao.bg ? { background: respSecao.bg, color: respSecao.fg } : undefined}
            >
              Responsável: {respSecao.nome}
            </span>
            {secao.frequencia && <span className="text-xs text-muted-foreground">{secao.frequencia}</span>}
          </div>
        </div>

        {completa ? (
          <span className="text-xs font-bold px-3 py-1.5 rounded-full whitespace-nowrap shrink-0" style={{ background: GREEN + "18", color: GREEN }}>
            ✓ Concluído
          </span>
        ) : (
          <div className="flex flex-col items-end gap-1.5 shrink-0 min-w-[64px]">
            <span className="text-[15px] font-extrabold font-mono tabular-nums" style={{ color: barra }}>{pct}%</span>
            <div className="w-16 h-1.5 rounded bg-muted overflow-hidden">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: barra }} />
            </div>
          </div>
        )}

        <span className={cn("text-sm text-muted-foreground transition-transform shrink-0", colapsada && "-rotate-90")}>⌄</span>
      </div>

      {/* Conteúdo */}
      {!colapsada && (
        <div className="border-t border-border p-[4px_18px_18px] flex flex-col gap-1">
          {!editOn ? (
            secao.descricao && (
              <span className="text-[13px] text-muted-foreground py-2.5 px-0.5 border-b border-border mb-1">{secao.descricao}</span>
            )
          ) : (
            <div className="flex flex-col gap-2 py-2.5 px-0.5 pb-3.5 border-b border-border mb-1.5">
              <div className="flex gap-2 flex-wrap">
                <input
                  defaultValue={secao.codigo}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== secao.codigo) onSalvarSecao(secao.id, { codigo: v }); }}
                  placeholder="Código"
                  className="w-[110px] border border-border rounded-lg px-2.5 py-2 font-mono text-[12.5px] font-bold bg-muted text-foreground outline-none"
                />
                <input
                  defaultValue={secao.titulo}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== secao.titulo) onSalvarSecao(secao.id, { titulo: v }); }}
                  placeholder="Título da seção"
                  className="flex-1 min-w-[180px] border border-border rounded-lg px-2.5 py-2 text-sm font-bold bg-muted text-foreground outline-none"
                />
              </div>
              <input
                defaultValue={secao.descricao ?? ""}
                onBlur={(e) => { const v = e.target.value; if (v !== (secao.descricao ?? "")) onSalvarSecao(secao.id, { descricao: v }); }}
                placeholder="Descrição curta"
                className="border border-border rounded-lg px-2.5 py-2 text-[13px] bg-muted text-foreground outline-none"
              />
              <div className="flex gap-2 flex-wrap items-center">
                <span className="text-xs text-muted-foreground font-semibold">Responsável:</span>
                <select
                  value={secao.responsavel_id ?? ""}
                  onChange={(e) => onSalvarSecao(secao.id, { responsavel_id: e.target.value ? Number(e.target.value) : null })}
                  className="border rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold bg-card text-foreground cursor-pointer outline-none"
                  style={{ borderColor: ACCENT }}
                >
                  <option value="">— Não atribuído</option>
                  {equipe.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </select>
                <span className="text-xs text-muted-foreground font-semibold">Frequência:</span>
                <input
                  defaultValue={secao.frequencia ?? ""}
                  onBlur={(e) => { const v = e.target.value; if (v !== (secao.frequencia ?? "")) onSalvarSecao(secao.id, { frequencia: v }); }}
                  className="w-[140px] border border-border rounded-lg px-2.5 py-1.5 text-[12.5px] bg-muted text-foreground outline-none"
                />
                <div className="flex-1" />
                <button
                  onClick={() => onRemoverSecao(secao)}
                  className="border bg-transparent text-xs font-bold px-2.5 py-1.5 rounded-lg whitespace-nowrap"
                  style={{ borderColor: RED, color: RED }}
                >
                  Remover seção
                </button>
              </div>
            </div>
          )}

          {/* Avisos */}
          {(secao.avisos ?? []).map((a, i) => {
            const warn = a.tipo === "warn";
            const cor = warn ? RED : GREEN;
            return (
              <div
                key={i}
                className="flex gap-2.5 items-start rounded-[10px] px-3.5 py-2.5 text-[13px] font-medium my-1.5 border"
                style={{ background: cor + "14", borderColor: cor + "40", color: cor }}
              >
                <span className="shrink-0">{warn ? "⚠" : "✓"}</span>
                <span>{comNegrito(a.texto)}</span>
              </div>
            );
          })}

          {/* Tarefas */}
          <div className="flex flex-col">
            {tarefas.map((t) => {
              const done = feitas.has(t.id);
              const c = chip(efetivo(t));
              return (
                <div
                  key={t.id}
                  onClick={() => { if (!editOn && podeMarcar) onMarcar(t.id, !done); }}
                  className={cn(
                    "flex items-start gap-3 py-3 px-1.5 border-t border-border transition-colors",
                    !editOn && podeMarcar ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
                  )}
                >
                  <span
                    className="shrink-0 w-6 h-6 mt-px rounded-[7px] border-2 flex items-center justify-center"
                    style={{ background: done ? GREEN : "transparent", borderColor: done ? GREEN : "hsl(var(--border))" }}
                  >
                    <Check className="h-3.5 w-3.5 text-white" style={{ opacity: done ? 1 : 0 }} strokeWidth={3.4} />
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    {!editOn ? (
                      <>
                        <span className={cn("text-[14.5px] font-medium leading-snug", done && "line-through text-muted-foreground")}>
                          {t.texto}
                        </span>
                        <div className="flex gap-1.5 flex-wrap items-center">
                          <span
                            className={cn("text-[11px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap", !c.bg && "bg-muted text-muted-foreground")}
                            style={c.bg ? { background: c.bg, color: c.fg } : undefined}
                          >
                            {c.nome}
                          </span>
                          {(t.tags ?? []).map((tag) => {
                            const st = tagStyle(tag);
                            return (
                              <span
                                key={tag}
                                className={cn("text-[11px] font-semibold px-2.5 py-0.5 rounded-full", !st.bg && "bg-muted text-muted-foreground")}
                                style={st.bg ? { background: st.bg, color: st.fg } : undefined}
                              >
                                {tag}
                              </span>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        <input
                          defaultValue={t.texto}
                          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.texto) onSalvarTarefa(t.id, { texto: v }); }}
                          className="border border-border rounded-lg px-2.5 py-2 text-[13.5px] bg-muted text-foreground outline-none"
                        />
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11.5px] text-muted-foreground font-semibold">Responsável:</span>
                          <select
                            value={t.responsavel_id ?? ""}
                            onChange={(e) => onSalvarTarefa(t.id, { responsavel_id: e.target.value ? Number(e.target.value) : null })}
                            className="border rounded-lg px-2 py-1.5 text-xs font-semibold bg-card text-foreground cursor-pointer outline-none"
                            style={{ borderColor: ACCENT }}
                          >
                            <option value="">↳ Herda da seção</option>
                            {equipe.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                          </select>
                          <button
                            onClick={() => onRemoverTarefa(t.id)}
                            className="text-xs font-bold px-2 py-1.5 rounded-md inline-flex items-center gap-1"
                            style={{ color: RED }}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Remover
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {editOn && (
            <div className="flex gap-2 pt-2.5 px-1.5 flex-wrap">
              <input
                value={novaTarefa}
                onChange={(e) => setNovaTarefa(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && novaTarefa.trim()) { onAdicionarTarefa(secao.id, novaTarefa.trim()); setNovaTarefa(""); } }}
                placeholder="Nova tarefa…"
                className="flex-1 min-w-[180px] border border-border rounded-lg px-2.5 py-2.5 text-[13px] bg-muted text-foreground outline-none"
              />
              <button
                onClick={() => { if (novaTarefa.trim()) { onAdicionarTarefa(secao.id, novaTarefa.trim()); setNovaTarefa(""); } }}
                className="text-[12.5px] font-bold text-white px-3.5 py-2.5 rounded-lg whitespace-nowrap"
                style={{ background: ACCENT }}
              >
                + Adicionar tarefa
              </button>
            </div>
          )}

          {/* Tabela de referência */}
          {secao.tabela_ref && (
            <div className="overflow-x-auto mt-2.5 rounded-[10px] border border-border">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr>
                    {secao.tabela_ref.head.map((h, i) => (
                      <th key={i} className="text-left text-[10.5px] font-bold uppercase tracking-wider bg-foreground text-background px-3 py-2.5 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {secao.tabela_ref.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-2.5 border-t border-border">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
