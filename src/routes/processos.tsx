import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ClipboardCheck, Info, Loader2, Pencil, Search, LifeBuoy,
  ChevronDown, ChevronRight, ClipboardList, Copy, Users,
} from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useAuth } from "@/hooks/useAuth";
import { usePerfil } from "@/hooks/usePerfil";
import { ManualAdmin } from "@/components/manual/ManualAdmin";
import {
  type ErroCatalogo, type Item, type Membro, type Progresso, type Secao,
  dataExtensoSP, diaSemanaSP, faltaDetalhe, hojeSP, horaCurtaSP, itemCompleto,
  montarRelatorio, exigeDetalhe, responsavelDe, rodaHoje, saudacao, turnoSugerido,
} from "@/lib/manual";

// ============================================================================
// Manual de Operação — três telas numa rota só:
//   1. Checklist do Dia         (rotina marcável: matinal + encerramento)
//   2. Responsabilidades        (documentação, sem marcação)
//   3. Solução de problemas     (catálogo de erros)
// + modo edição (admin) para a estrutura.
//
// Substituiu o modelo de 14/ago (manual_equipe/tarefas). O progresso agora é do
// TIME — unique(dia, item_id) — e a coluna `por` guarda quem marcou.
// ============================================================================

const ABAS = ["dia", "processos", "problemas"] as const;
type Aba = (typeof ABAS)[number];
const TURNOS = ["inicio", "fim", "todos"] as const;
type TurnoFiltro = (typeof TURNOS)[number];

type SearchParams = { aba: Aba; turno: TurnoFiltro; membro: string; q: string };

export const Route = createFileRoute("/processos")({
  // Estado na URL: sobrevive a remontagem da árvore ao voltar para a aba.
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    aba: ABAS.includes(s.aba as Aba) ? (s.aba as Aba) : "dia",
    turno: TURNOS.includes(s.turno as TurnoFiltro) ? (s.turno as TurnoFiltro) : "todos",
    membro: typeof s.membro === "string" ? s.membro : "",
    q: typeof s.q === "string" ? s.q : "",
  }),
  component: ManualPage,
});

const CHAVE_EU = "manual.euId";

function ManualPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/processos" });
  const setSearch = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  const qc = useQueryClient();
  const { user } = useAuth();
  const { perfil } = usePerfil();
  const isAdmin = !!perfil?.modulos?.includes("todos");
  const [editando, setEditando] = useState(false);

  const dia = hojeSP();
  const dow = diaSemanaSP();

  // ---- estrutura (muda pouco; o staleTime do QueryClient já segura) ----
  const estrutura = useQuery({
    queryKey: ["manual", "estrutura"],
    queryFn: async () => {
      const [m, s, i] = await Promise.all([
        supabaseExternal.from("equipe_membros").select("*").eq("ativo", true).order("ordem"),
        supabaseExternal.from("manual_secoes").select("*").eq("ativo", true).order("ordem"),
        supabaseExternal.from("manual_itens").select("*").eq("ativo", true).order("ordem"),
      ]);
      if (m.error) throw m.error;
      if (s.error) throw s.error;
      if (i.error) throw i.error;
      return {
        membros: (m.data ?? []) as Membro[],
        secoes: (s.data ?? []) as Secao[],
        itens: (i.data ?? []) as Item[],
      };
    },
  });

  // ---- progresso do dia ----
  const progressoQuery = useQuery({
    queryKey: ["manual", "progresso", dia],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("manual_progresso")
        .select("*")
        .eq("dia", dia);
      if (error) throw error;
      return (data ?? []) as Progresso[];
    },
  });

  // Realtime: duas pessoas em máquinas diferentes marcando o mesmo checklist.
  useEffect(() => {
    const canal = supabaseExternal
      .channel("manual-progresso")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "manual_progresso" },
        () => void qc.invalidateQueries({ queryKey: ["manual", "progresso", dia] }),
      )
      .subscribe();
    return () => {
      void supabaseExternal.removeChannel(canal);
    };
  }, [qc, dia]);

  const membros = estrutura.data?.membros ?? [];
  const secoes = estrutura.data?.secoes ?? [];
  const itens = estrutura.data?.itens ?? [];

  const progressoPorItem = useMemo(() => {
    const mapa = new Map<string, Progresso>();
    for (const p of progressoQuery.data ?? []) mapa.set(p.item_id, p);
    return mapa;
  }, [progressoQuery.data]);

  // ---- quem sou eu: e-mail do login -> membro; senão escolha manual ----
  const [euManual, setEuManual] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(CHAVE_EU),
  );
  const euPorEmail = useMemo(() => {
    const email = user?.email?.toLowerCase();
    if (!email) return null;
    return membros.find((m) => m.email?.toLowerCase() === email)?.id ?? null;
  }, [user?.email, membros]);
  const euId = euPorEmail ?? euManual;
  const eu = membros.find((m) => m.id === euId) ?? null;

  function escolherMembro(id: string) {
    setEuManual(id);
    if (typeof window !== "undefined") window.localStorage.setItem(CHAVE_EU, id);
  }

  // ---- gravação (upsert por dia+item) ----
  async function salvar(item: Item, patch: Partial<Progresso>) {
    if (!euId) {
      toast.error("Escolha quem é você antes de marcar.");
      return;
    }
    const atual = progressoPorItem.get(item.id);
    const linha = {
      dia,
      item_id: item.id,
      concluido: patch.concluido ?? atual?.concluido ?? false,
      resposta: (patch.resposta ?? atual?.resposta ?? null) as "sim" | "nao" | null,
      detalhe: patch.detalhe ?? atual?.detalhe ?? null,
      por: euId,
      em: new Date().toISOString(),
    };
    const { error } = await supabaseExternal
      .from("manual_progresso")
      .upsert(linha, { onConflict: "dia,item_id" });
    if (error) {
      toast.error("Não consegui salvar", { description: error.message });
      return;
    }
    void qc.invalidateQueries({ queryKey: ["manual", "progresso", dia] });
  }

  const carregando = estrutura.isLoading || progressoQuery.isLoading;
  const erro = (estrutura.error as Error | null)?.message ?? (progressoQuery.error as Error | null)?.message;

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6" /> Manual de Operação
          </h1>
          <p className="text-sm text-muted-foreground">{dataExtensoSP()}</p>
        </div>
        {isAdmin && (
          <Button
            variant={editando ? "default" : "outline"}
            size="sm"
            className="h-9 gap-2"
            onClick={() => setEditando((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {editando ? "Sair da edição" : "Editar estrutura"}
          </Button>
        )}
      </header>

      {erro && (
        <Card className="p-4 border-destructive/40 bg-destructive/5 text-sm text-destructive">
          {erro}
        </Card>
      )}

      {editando && isAdmin ? (
        <ManualAdmin
          membros={membros}
          secoes={secoes}
          itens={itens}
          onMudou={() => void qc.invalidateQueries({ queryKey: ["manual", "estrutura"] })}
        />
      ) : (
        <Tabs value={search.aba} onValueChange={(v) => setSearch({ aba: v as Aba })}>
          <TabsList>
            <TabsTrigger value="dia" className="gap-1.5">
              <ClipboardCheck className="h-4 w-4" /> Checklist do Dia
            </TabsTrigger>
            <TabsTrigger value="processos" className="gap-1.5">
              <ClipboardList className="h-4 w-4" /> Responsabilidades
            </TabsTrigger>
            <TabsTrigger value="problemas" className="gap-1.5">
              <LifeBuoy className="h-4 w-4" /> Solução de problemas
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dia" className="mt-4">
            {carregando ? (
              <EsqueletoLista />
            ) : !eu ? (
              <SeletorMembro membros={membros} onEscolher={escolherMembro} />
            ) : (
              <ChecklistDoDia
                eu={eu}
                membros={membros}
                secoes={secoes}
                itens={itens}
                progresso={progressoPorItem}
                dow={dow}
                turnoFiltro={search.turno}
                onTurno={(t) => setSearch({ turno: t })}
                busca={search.q}
                onBusca={(q) => setSearch({ q })}
                onSalvar={salvar}
                onTrocarMembro={() => setEuManual(null)}
                podeTrocar={!euPorEmail}
              />
            )}
          </TabsContent>

          <TabsContent value="processos" className="mt-4">
            {carregando ? (
              <EsqueletoLista />
            ) : (
              <Responsabilidades
                membros={membros}
                secoes={secoes}
                itens={itens}
                membroFiltro={search.membro}
                onMembro={(m) => setSearch({ membro: m })}
                busca={search.q}
                onBusca={(q) => setSearch({ q })}
              />
            )}
          </TabsContent>

          <TabsContent value="problemas" className="mt-4">
            <SolucaoProblemas busca={search.q} onBusca={(q) => setSearch({ q })} isAdmin={isAdmin} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ============================================================================
// Seletor de "quem sou eu" (quando o e-mail do login não casa com um membro)
// ============================================================================
function SeletorMembro({ membros, onEscolher }: { membros: Membro[]; onEscolher: (id: string) => void }) {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-1">
        <Users className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Quem é você?</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Seu login ainda não está ligado a um membro da equipe. Escolha seu nome — fica guardado
        neste computador. (Um admin pode preencher o e-mail no modo edição para ligar automaticamente.)
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {membros.map((m) => (
          <button
            key={m.id}
            onClick={() => onEscolher(m.id)}
            className="rounded-lg border p-4 text-left hover:bg-muted/50 transition-colors"
            style={{ borderLeftWidth: 4, borderLeftColor: m.cor }}
          >
            <div className="font-semibold">{m.nome}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}

// ============================================================================
// TELA 1 — Checklist do Dia
// ============================================================================
function ChecklistDoDia(props: {
  eu: Membro;
  membros: Membro[];
  secoes: Secao[];
  itens: Item[];
  progresso: Map<string, Progresso>;
  dow: number;
  turnoFiltro: TurnoFiltro;
  onTurno: (t: TurnoFiltro) => void;
  busca: string;
  onBusca: (q: string) => void;
  onSalvar: (item: Item, patch: Partial<Progresso>) => Promise<void>;
  onTrocarMembro: () => void;
  podeTrocar: boolean;
}) {
  const { eu, membros, secoes, itens, progresso, dow, turnoFiltro, busca } = props;
  const secaoDe = useMemo(() => new Map(secoes.map((s) => [s.code, s])), [secoes]);
  const [verEquipe, setVerEquipe] = useState(false);

  // Só rotina, só o que roda hoje.
  const doDia = useMemo(
    () => itens.filter((i) => secaoDe.get(i.secao_code)?.tipo === "rotina" && rodaHoje(i, dow)),
    [itens, secaoDe, dow],
  );

  const meus = useMemo(
    () => doDia.filter((i) => responsavelDe(i, secaoDe.get(i.secao_code)) === eu.id),
    [doDia, secaoDe, eu.id],
  );
  const dosOutros = useMemo(
    () => doDia.filter((i) => responsavelDe(i, secaoDe.get(i.secao_code)) !== eu.id),
    [doDia, secaoDe, eu.id],
  );

  const feitos = meus.filter((i) => itemCompleto(i, progresso.get(i.id))).length;
  const total = meus.length;
  const pct = total > 0 ? Math.round((feitos / total) * 100) : 0;

  // Mensagem contextual: o que falta no turno de agora.
  const turnoAgora = turnoSugerido();
  const pendentesTurno = meus.filter(
    (i) => i.turno === turnoAgora && !itemCompleto(i, progresso.get(i.id)),
  ).length;

  const filtrar = (lista: Item[]) =>
    lista.filter((i) => {
      if (turnoFiltro !== "todos" && i.turno !== turnoFiltro) return false;
      if (busca) {
        const q = busca.toLowerCase();
        return i.texto.toLowerCase().includes(q) || (i.tags ?? []).some((t) => t.toLowerCase().includes(q));
      }
      return true;
    });

  function copiarRelatorio() {
    const txt = montarRelatorio({
      itens, secoes, membros, progresso, dow, dataLabel: dataExtensoSP(),
    });
    navigator.clipboard.writeText(txt).then(
      () => toast.success("Relatório copiado", { description: "Cole no WhatsApp ou Discord." }),
      () => toast.error("Não consegui copiar"),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Saudação + progresso */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">
              {saudacao()}, {eu.nome}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {total === 0
                ? "Nada na sua rotina hoje."
                : pendentesTurno > 0
                  ? `Faltam ${pendentesTurno} ${pendentesTurno === 1 ? "item" : "itens"} ${turnoAgora === "inicio" ? "na rotina matinal" : "no encerramento"}.`
                  : feitos === total
                    ? "Tudo concluído. Dia fechado."
                    : "Turno atual em dia — confira o outro turno."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {props.podeTrocar && (
              <Button variant="ghost" size="sm" className="h-9" onClick={props.onTrocarMembro}>
                Trocar
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-9 gap-2" onClick={copiarRelatorio}>
              <Copy className="h-3.5 w-3.5" /> Relatório do dia
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: eu.cor }}
            />
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {feitos}/{total}
          </span>
        </div>
      </Card>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {(["inicio", "fim", "todos"] as const).map((t) => (
            <button
              key={t}
              onClick={() => props.onTurno(t)}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                turnoFiltro === t ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {t === "inicio" ? "Matinal" : t === "fim" ? "Encerramento" : "Dia todo"}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar item…"
            value={busca}
            onChange={(e) => props.onBusca(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>

      {/* Meus itens */}
      <div className="flex flex-col gap-2">
        {filtrar(meus).length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Nenhum item seu com esse filtro.
          </Card>
        ) : (
          filtrar(meus).map((item) => (
            <LinhaItem
              key={item.id}
              item={item}
              prog={progresso.get(item.id)}
              membros={membros}
              onSalvar={props.onSalvar}
            />
          ))
        )}
      </div>

      {/* Resto da equipe (recolhido) */}
      {dosOutros.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <button
            onClick={() => setVerEquipe((v) => !v)}
            className="w-full flex items-center justify-between p-4 hover:bg-muted/40 transition-colors"
          >
            <span className="text-sm font-medium flex items-center gap-2">
              {verEquipe ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Resto da equipe
            </span>
            <span className="text-xs text-muted-foreground">
              {dosOutros.filter((i) => itemCompleto(i, progresso.get(i.id))).length}/{dosOutros.length} concluídos
            </span>
          </button>
          {verEquipe && (
            <div className="border-t p-3 flex flex-col gap-2">
              {filtrar(dosOutros).map((item) => (
                <LinhaItem
                  key={item.id}
                  item={item}
                  prog={progresso.get(item.id)}
                  membros={membros}
                  onSalvar={props.onSalvar}
                  dono={membros.find(
                    (m) => m.id === responsavelDe(item, secaoDe.get(item.secao_code)),
                  )}
                />
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uma linha do checklist — check (caixa) ou pergunta (Sim/Não + campo)
// ---------------------------------------------------------------------------
function LinhaItem(props: {
  item: Item;
  prog: Progresso | undefined;
  membros: Membro[];
  onSalvar: (item: Item, patch: Partial<Progresso>) => Promise<void>;
  dono?: Membro;
}) {
  const { item, prog, membros, dono } = props;
  const completo = itemCompleto(item, prog);
  const pendenteDetalhe = faltaDetalhe(item, prog);
  const [rascunho, setRascunho] = useState(prog?.detalhe ?? "");
  const [salvando, setSalvando] = useState(false);

  // Se outra pessoa editar (realtime), o campo local acompanha.
  useEffect(() => {
    setRascunho(prog?.detalhe ?? "");
  }, [prog?.detalhe]);

  const quem = membros.find((m) => m.id === prog?.por);

  async function acao(patch: Partial<Progresso>) {
    setSalvando(true);
    try {
      await props.onSalvar(item, patch);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card
      className={cn(
        "p-4 transition-colors",
        completo && "bg-emerald-500/5 border-emerald-500/30",
        pendenteDetalhe && "bg-amber-500/5 border-amber-500/40",
      )}
    >
      <div className="flex items-start gap-3">
        {item.tipo === "check" ? (
          <Checkbox
            checked={completo}
            disabled={salvando}
            onCheckedChange={(v) => void acao({ concluido: v === true })}
            className="mt-0.5 h-5 w-5"
          />
        ) : (
          <div className="mt-0.5 h-5 w-5 flex items-center justify-center">
            {salvando ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : completo ? (
              <span className="text-emerald-600 dark:text-emerald-400 font-bold">✓</span>
            ) : pendenteDetalhe ? (
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            ) : (
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("text-sm", completo && "text-muted-foreground line-through")}>
              {item.texto}
            </span>
            {dono && (
              <Badge variant="outline" className="text-[10px] py-0" style={{ borderColor: dono.cor, color: dono.cor }}>
                {dono.nome}
              </Badge>
            )}
            {(item.tags ?? []).map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px] py-0">
                {t}
              </Badge>
            ))}
          </div>

          {item.tipo === "pergunta" && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {(["sim", "nao"] as const).map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={prog?.resposta === r ? "default" : "outline"}
                    className="h-8 px-4"
                    disabled={salvando}
                    onClick={() => void acao({ resposta: r })}
                  >
                    {r === "sim" ? "Sim" : "Não"}
                  </Button>
                ))}
              </div>

              {exigeDetalhe(item, prog?.resposta) && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    {item.campo_label ?? "Descreva"} — obrigatório
                  </label>
                  <Textarea
                    value={rascunho}
                    onChange={(e) => setRascunho(e.target.value)}
                    onBlur={() => {
                      if ((rascunho ?? "") !== (prog?.detalhe ?? "")) void acao({ detalhe: rascunho });
                    }}
                    rows={2}
                    placeholder="O que aconteceu…"
                    className="text-sm"
                  />
                </div>
              )}
            </div>
          )}

          {prog?.em && (completo || prog.resposta) && (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              ✓ {quem?.nome ?? "—"} · {horaCurtaSP(prog.em)}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ============================================================================
// TELA 2 — Responsabilidades & Processos (documentação, sem marcação)
// ============================================================================
function Responsabilidades(props: {
  membros: Membro[];
  secoes: Secao[];
  itens: Item[];
  membroFiltro: string;
  onMembro: (m: string) => void;
  busca: string;
  onBusca: (q: string) => void;
}) {
  const { membros, secoes, itens, membroFiltro, busca } = props;

  const processos = secoes.filter((s) => s.tipo === "processo");
  const visiveis = processos.filter((s) => {
    if (membroFiltro && s.responsavel_id !== membroFiltro) return false;
    if (busca) {
      const q = busca.toLowerCase();
      const nosPassos = itens.some(
        (i) => i.secao_code === s.code && i.texto.toLowerCase().includes(q),
      );
      return s.titulo.toLowerCase().includes(q) || nosPassos;
    }
    return true;
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => props.onMembro("")}
          className={cn(
            "px-3 py-1.5 text-sm rounded-full border transition-colors",
            !membroFiltro ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted",
          )}
        >
          Todos
        </button>
        {membros.map((m) => (
          <button
            key={m.id}
            onClick={() => props.onMembro(m.id === membroFiltro ? "" : m.id)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border transition-colors",
              membroFiltro === m.id ? "text-white" : "hover:bg-muted",
            )}
            style={membroFiltro === m.id ? { background: m.cor, borderColor: m.cor } : { borderColor: m.cor }}
          >
            {m.nome}
          </button>
        ))}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar processo ou passo…"
            value={busca}
            onChange={(e) => props.onBusca(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>

      {visiveis.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum processo com esse filtro.</Card>
      ) : (
        visiveis.map((s) => {
          const dono = membros.find((m) => m.id === s.responsavel_id);
          const passos = itens.filter((i) => i.secao_code === s.code);
          return (
            <Card key={s.code} className="p-5" style={{ borderLeftWidth: 4, borderLeftColor: dono?.cor ?? "var(--color-border)" }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px] font-mono py-0">{s.code}</Badge>
                    <h3 className="text-lg font-semibold">{s.titulo}</h3>
                  </div>
                  {s.descricao && <p className="text-sm text-muted-foreground mt-1">{s.descricao}</p>}
                </div>
                <div className="text-right">
                  {dono && (
                    <div className="text-sm font-semibold" style={{ color: dono.cor }}>
                      {dono.nome}
                    </div>
                  )}
                  {s.frequencia && <div className="text-xs text-muted-foreground">{s.frequencia}</div>}
                </div>
              </div>

              {(s.callouts ?? []).map((c, idx) => (
                <div
                  key={idx}
                  className={cn(
                    "mt-3 rounded-lg p-3 text-sm flex items-start gap-2",
                    c.tipo === "warn"
                      ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
                      : "bg-blue-500/10 text-blue-800 dark:text-blue-300",
                  )}
                >
                  {c.tipo === "warn" ? (
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  ) : (
                    <Info className="h-4 w-4 mt-0.5 shrink-0" />
                  )}
                  <span>{c.texto}</span>
                </div>
              ))}

              {passos.length > 0 && (
                <ol className="mt-4 flex flex-col gap-2">
                  {passos.map((p, idx) => {
                    const donoPasso = p.responsavel_id
                      ? membros.find((m) => m.id === p.responsavel_id)
                      : undefined;
                    return (
                      <li key={p.id} className="flex items-start gap-3 text-sm">
                        <span className="shrink-0 h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-semibold tabular-nums">
                          {idx + 1}
                        </span>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <span>{p.texto}</span>
                          {donoPasso && (
                            <Badge variant="outline" className="text-[10px] py-0" style={{ borderColor: donoPasso.cor, color: donoPasso.cor }}>
                              {donoPasso.nome}
                            </Badge>
                          )}
                          {(p.tags ?? []).map((t) => (
                            <Badge key={t} variant="secondary" className="text-[10px] py-0">{t}</Badge>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}

              {s.tabela_ref && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm border rounded-lg overflow-hidden">
                    <thead className="bg-muted/40">
                      <tr>
                        {s.tabela_ref.head.map((h) => (
                          <th key={h} className="text-left px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.tabela_ref.rows.map((r, i) => (
                        <tr key={i} className="border-t">
                          {r.map((celula, j) => (
                            <td key={j} className="px-3 py-2">{celula}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

// ============================================================================
// TELA 3 — Solução de problemas (catálogo de erros)
// ============================================================================
function SolucaoProblemas(props: { busca: string; onBusca: (q: string) => void; isAdmin: boolean }) {
  const { busca } = props;
  const [aberto, setAberto] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["manual", "erros"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("erros_catalogo")
        .select("*")
        .eq("ativo", true)
        .order("ordem");
      if (error) throw error;
      return (data ?? []) as ErroCatalogo[];
    },
  });

  const lista = (q.data ?? []).filter((e) => {
    if (!busca) return true;
    const t = busca.toLowerCase();
    return e.titulo.toLowerCase().includes(t) || (e.tags ?? []).some((x) => x.toLowerCase().includes(t));
  });

  if (q.isLoading) return <EsqueletoLista />;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar erro por título ou tag…"
          value={busca}
          onChange={(e) => props.onBusca(e.target.value)}
          className="pl-8 h-9"
        />
      </div>

      {lista.length === 0 ? (
        <Card className="p-8 text-center">
          <LifeBuoy className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            {(q.data ?? []).length === 0
              ? "Nenhum erro cadastrado ainda. Um admin pode cadastrar em “Editar estrutura”."
              : "Nenhum erro com esse filtro."}
          </p>
        </Card>
      ) : (
        lista.map((e) => {
          const expandido = aberto === e.id;
          return (
            <Card key={e.id} className="overflow-hidden">
              <button
                onClick={() => setAberto(expandido ? null : e.id)}
                className="w-full flex items-start justify-between gap-3 p-4 text-left hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-start gap-2">
                  {expandido ? (
                    <ChevronDown className="h-4 w-4 mt-1 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 mt-1 shrink-0" />
                  )}
                  <div>
                    <div className="font-medium">{e.titulo}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {(e.tags ?? []).map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px] py-0">{t}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </button>

              {expandido && (
                <div className="border-t p-4 flex flex-col gap-4 text-sm">
                  <BlocoLista titulo="Sintomas" itens={e.sintomas} />
                  <BlocoTexto titulo="Teste rápido" texto={e.teste_rapido} />
                  <BlocoTexto titulo="Causa raiz" texto={e.causa_raiz} />
                  <BlocoLista titulo="Solução" itens={e.solucao} numerado />
                  <BlocoTexto titulo="Como confirmar" texto={e.como_confirmar} />
                  <BlocoTexto titulo="Quando escalar" texto={e.quando_escalar} />
                  <BlocoTexto titulo="Prevenção" texto={e.prevencao} />
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}

function BlocoTexto({ titulo, texto }: { titulo: string; texto: string | null }) {
  if (!texto) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">{titulo}</h4>
      <p className="whitespace-pre-wrap">{texto}</p>
    </div>
  );
}

function BlocoLista({
  titulo, itens, numerado,
}: { titulo: string; itens: string[] | null; numerado?: boolean }) {
  if (!itens || itens.length === 0) return null;
  const Lista = numerado ? "ol" : "ul";
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">{titulo}</h4>
      <Lista className={cn("flex flex-col gap-1", numerado ? "list-decimal" : "list-disc", "pl-5")}>
        {itens.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </Lista>
    </div>
  );
}

function EsqueletoLista() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
