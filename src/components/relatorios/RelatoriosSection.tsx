import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";
import {
  CATEGORIAS, categoriaDoSlug, hojeSP, QUERY_OPTS, rotuloDia, somaDias,
  type CategoriaRel, type RelatorioLista,
} from "./comum";
import { RelatorioCard } from "./RelatorioCard";

// ============================================================================
// Seção "Relatórios" da Visão Geral (#relatorios). Abas por categoria (ordem
// e contagem de view_relatorios_categorias), período 7 d / 30 d / tudo, cards
// agrupados por dia, em accordion (abrir um fecha o outro). Lista em
// view_relatorios_agentes_lista (sem HTML); o HTML só no "Ver versão completa".
// ============================================================================

type Periodo = "7d" | "30d" | "tudo";
const PERIODOS: { id: Periodo; label: string }[] = [
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "tudo", label: "Tudo" },
];

export function RelatoriosSection({ relSlug, onRelChange }: { relSlug?: string; onRelChange: (slug: string) => void }) {
  const cat = categoriaDoSlug(relSlug);
  const [periodo, setPeriodo] = useState<Periodo>("7d");
  const [aberto, setAberto] = useState<number | null>(null);

  // Âncora #relatorios: a seção nasce depois do resto do Dashboard; rola até ela.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#relatorios") return;
    const t = setTimeout(() => document.getElementById("relatorios")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => clearTimeout(t);
  }, []);

  const catsQ = useQuery({
    queryKey: ["relatorios", "categorias"],
    ...QUERY_OPTS,
    queryFn: async (): Promise<CategoriaRel[]> => {
      const { data, error } = await supabaseExternal.from("view_relatorios_categorias")
        .select("ordem, categoria, total_relatorios, ultimo_relatorio");
      if (error) throw error;
      return ((data ?? []) as CategoriaRel[]).sort((a, b) => a.ordem - b.ordem);
    },
  });

  const listaQ = useQuery({
    queryKey: ["relatorios", "lista", cat.nome, periodo],
    ...QUERY_OPTS,
    queryFn: async (): Promise<RelatorioLista[]> => {
      let q = supabaseExternal.from("view_relatorios_agentes_lista")
        .select("id, agente, categoria, titulo, destaque, data_referencia, gerado_em, resumo")
        .eq("categoria", cat.nome);
      if (periodo !== "tudo") q = q.gte("data_referencia", somaDias(hojeSP(), periodo === "7d" ? -6 : -29));
      const { data, error } = await q
        .order("data_referencia", { ascending: false })
        .order("gerado_em", { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as RelatorioLista[];
    },
  });

  const grupos = useMemo(() => {
    const m = new Map<string, RelatorioLista[]>();
    for (const r of listaQ.data ?? []) {
      const g = m.get(r.data_referencia) ?? [];
      g.push(r);
      m.set(r.data_referencia, g);
    }
    return [...m.entries()];
  }, [listaQ.data]);

  // ordem/contagem da view; se ela falhar, mostra as 3 abas fixas sem contagem
  const abas = CATEGORIAS
    .map((c) => ({ ...c, info: catsQ.data?.find((x) => x.categoria === c.nome) }))
    .sort((a, b) => (a.info?.ordem ?? 99) - (b.info?.ordem ?? 99));

  return (
    <section id="relatorios" className="flex flex-col gap-3 scroll-mt-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold tracking-tight">
          <a href="#relatorios" className="hover:underline underline-offset-4">Relatórios</a>
        </h2>
        <div className="flex items-center gap-1 bg-card border border-border rounded-[10px] p-[3px]" role="radiogroup" aria-label="Período">
          {PERIODOS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={periodo === p.id}
              onClick={() => { setPeriodo(p.id); setAberto(null); }}
              className={cn(
                "text-[12.5px] font-medium px-3 py-1.5 rounded-[7px] transition-colors",
                periodo === p.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Abas por categoria (pills) */}
      <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Categoria de relatório">
        {abas.map((a) => {
          const ativo = a.slug === cat.slug;
          const Icone = a.icone;
          return (
            <button
              key={a.slug}
              type="button"
              role="tab"
              aria-selected={ativo}
              onClick={() => { onRelChange(a.slug); setAberto(null); }}
              className={cn(
                "inline-flex items-center gap-2 text-[13px] font-medium px-3.5 py-1.5 rounded-full border transition-colors",
                ativo ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground hover:text-foreground border-border",
              )}
            >
              <Icone className="h-3.5 w-3.5" />
              {a.nome}
              {a.info && (
                <span className={cn(
                  "text-[11px] font-bold px-1.5 rounded-full tabular-nums",
                  ativo ? "bg-primary-foreground/20" : "bg-muted",
                )}>{a.info.total_relatorios}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Lista */}
      {listaQ.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)}
        </div>
      ) : listaQ.error ? (
        <div className="rounded-xl border bg-card px-4 py-6 flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Não deu para carregar os relatórios.</span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void listaQ.refetch()}>
            <RotateCw className="h-3.5 w-3.5" /> Tentar de novo
          </Button>
        </div>
      ) : grupos.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card px-4 py-10 flex flex-col items-center gap-2 text-center">
          <cat.icone className="h-7 w-7 text-muted-foreground/60" />
          <span className="text-sm text-muted-foreground max-w-md">
            {(categoriaDoSlug(cat.slug).slug === "marketing" || (catsQ.data?.find((x) => x.categoria === cat.nome)?.total_relatorios ?? 0) === 0)
              ? cat.vazio
              : "Nenhum relatório neste período."}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {grupos.map(([dia, rels]) => (
            <div key={dia} className="flex flex-col gap-2">
              <span className="text-[12px] font-semibold text-muted-foreground">{rotuloDia(dia)}</span>
              {rels.map((r) => (
                <RelatorioCard
                  key={r.id}
                  rel={r}
                  aberto={aberto === r.id}
                  onToggle={() => setAberto((a) => (a === r.id ? null : r.id))}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
