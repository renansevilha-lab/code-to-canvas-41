import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, RefreshCw, Loader2, Search, ExternalLink, Eye, TrendingDown, HeartPulse,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ---------------------------------------------------------------- tipos
interface SaudeRow {
  mlb: string;
  sku: string | null;
  titulo: string | null;
  foto: string | null;
  status: string;
  health: number | null;
  catalog_listing: boolean | null;
  logistic_type: string | null;
  permalink: string | null;
  visitas_30d: number | null;
  vendas_30d: number | null;
  unidades_30d: number | null;
  taxa_conversao: number | null;
  classificacao: "atrai_nao_vende" | "invisivel" | "saudavel";
  saude_baixa: boolean | null;
}
interface ResumoRow {
  classificacao: string;
  anuncios: number;
  visitas_30d: number | null;
  vendas_30d: number | null;
}

// ---------------------------------------------------------------- classes
type Classe = SaudeRow["classificacao"];
const CLASSE_META: Record<Classe, { label: string; stripe: string; badge: string; ordem: number }> = {
  atrai_nao_vende: {
    label: "Atrai e não vende",
    stripe: "#E5484D",
    badge: "border-rose-500/40 text-rose-600 dark:text-rose-300 bg-rose-500/5",
    ordem: 0,
  },
  invisivel: {
    label: "Invisível",
    stripe: "#E0A72E",
    badge: "border-amber-500/40 text-amber-600 dark:text-amber-300 bg-amber-500/5",
    ordem: 1,
  },
  saudavel: {
    label: "Saudável",
    stripe: "#2E9E8F",
    badge: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300 bg-emerald-500/5",
    ordem: 2,
  },
};
const CLASSES: Classe[] = ["atrai_nao_vende", "invisivel", "saudavel"];

const pct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2)}%`);
const int = (v: number | null | undefined) => (v ?? 0).toLocaleString("pt-BR");

// ---------------------------------------------------------------- rota / URL
type SortKey = "prioridade" | "visitas" | "vendas" | "conversao" | "saude";
type SearchParams = { classe?: Classe; q?: string; sort: SortKey; page: number };
const SORTS: SortKey[] = ["prioridade", "visitas", "vendas", "conversao", "saude"];
const PAGE_SIZE = 50;

export const Route = createFileRoute("/saude-ml")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    classe: CLASSES.includes(s.classe as Classe) ? (s.classe as Classe) : undefined,
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    sort: SORTS.includes(s.sort as SortKey) ? (s.sort as SortKey) : "prioridade",
    page: Number.isFinite(Number(s.page)) && Number(s.page) > 0 ? Math.floor(Number(s.page)) : 1,
  }),
  component: SaudeMlPage,
});

function SaudeMlPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const patch = (p: Partial<SearchParams>) =>
    navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });

  const resumoQ = useQuery({
    queryKey: ["saude-ml", "resumo"],
    queryFn: async (): Promise<ResumoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_ml_ads_resumo")
        .select("classificacao, anuncios, visitas_30d, vendas_30d");
      if (error) throw new Error(error.message);
      return (data ?? []) as ResumoRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const listaQ = useQuery({
    queryKey: ["saude-ml", "lista"],
    queryFn: async (): Promise<SaudeRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_ml_saude_anuncio")
        .select(
          "mlb, sku, titulo, foto, status, health, catalog_listing, logistic_type, permalink, visitas_30d, vendas_30d, unidades_30d, taxa_conversao, classificacao, saude_baixa",
        )
        .limit(1000);
      if (error) throw new Error(error.message);
      return (data ?? []) as SaudeRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const resumoMap = useMemo(() => {
    const m = new Map<string, ResumoRow>();
    for (const r of resumoQ.data ?? []) m.set(r.classificacao, r);
    return m;
  }, [resumoQ.data]);
  const totalAnuncios = useMemo(
    () => (resumoQ.data ?? []).reduce((s, r) => s + (r.anuncios ?? 0), 0),
    [resumoQ.data],
  );

  const linhas = useMemo(() => {
    let rows = listaQ.data ?? [];
    if (search.classe) rows = rows.filter((r) => r.classificacao === search.classe);
    if (search.q) {
      const t = search.q.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.titulo ?? "").toLowerCase().includes(t) ||
          (r.sku ?? "").toLowerCase().includes(t) ||
          r.mlb.toLowerCase().includes(t),
      );
    }
    const cmp: Record<SortKey, (a: SaudeRow, b: SaudeRow) => number> = {
      prioridade: (a, b) =>
        CLASSE_META[a.classificacao].ordem - CLASSE_META[b.classificacao].ordem ||
        (b.visitas_30d ?? 0) - (a.visitas_30d ?? 0),
      visitas: (a, b) => (b.visitas_30d ?? 0) - (a.visitas_30d ?? 0),
      vendas: (a, b) => (b.vendas_30d ?? 0) - (a.vendas_30d ?? 0),
      conversao: (a, b) => (a.taxa_conversao ?? 1e9) - (b.taxa_conversao ?? 1e9),
      saude: (a, b) => (a.health ?? 2) - (b.health ?? 2),
    };
    return [...rows].sort(cmp[search.sort]);
  }, [listaQ.data, search.classe, search.q, search.sort]);

  const totalPaginas = Math.max(1, Math.ceil(linhas.length / PAGE_SIZE));
  const pagina = Math.min(search.page, totalPaginas);
  const visiveis = linhas.slice((pagina - 1) * PAGE_SIZE, pagina * PAGE_SIZE);

  const atrai = resumoMap.get("atrai_nao_vende");
  const invis = resumoMap.get("invisivel");
  const saud = resumoMap.get("saudavel");
  const carregando = listaQ.isLoading || resumoQ.isLoading;

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-6">
      {/* Header */}
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" /> Saúde de Anúncios · Mercado Livre
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Visitas × conversão + qualidade por anúncio (30 dias). Prioriza o tráfego que não vira venda.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2"
          onClick={() => {
            void resumoQ.refetch();
            void listaQ.refetch();
          }}
          disabled={listaQ.isFetching}
        >
          {listaQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Atualizar
        </Button>
      </header>

      {/* KPIs */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi titulo="Anúncios ativos" valor={int(totalAnuncios)} carregando={carregando} />
        <Kpi
          titulo="Atrai e não vende"
          valor={int(atrai?.anuncios)}
          stripe={CLASSE_META.atrai_nao_vende.stripe}
          sub={`${int(atrai?.visitas_30d)} visitas · ${formatBRL(atrai?.vendas_30d ?? 0)}`}
          icone={<TrendingDown className="h-4 w-4 text-rose-500" />}
          carregando={carregando}
        />
        <Kpi
          titulo="Invisíveis"
          valor={int(invis?.anuncios)}
          stripe={CLASSE_META.invisivel.stripe}
          sub={`${int(invis?.visitas_30d)} visitas`}
          icone={<Eye className="h-4 w-4 text-amber-500" />}
          carregando={carregando}
        />
        <Kpi
          titulo="Saudáveis"
          valor={int(saud?.anuncios)}
          stripe={CLASSE_META.saudavel.stripe}
          sub={`${formatBRL(saud?.vendas_30d ?? 0)} em vendas`}
          icone={<HeartPulse className="h-4 w-4 text-emerald-500" />}
          carregando={carregando}
        />
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <Chip ativo={!search.classe} onClick={() => patch({ classe: undefined, page: 1 })}>
          Todos <span className="opacity-60">{int(totalAnuncios)}</span>
        </Chip>
        {CLASSES.map((c) => (
          <Chip
            key={c}
            ativo={search.classe === c}
            cor={CLASSE_META[c].stripe}
            onClick={() => patch({ classe: search.classe === c ? undefined : c, page: 1 })}
          >
            {CLASSE_META[c].label} <span className="opacity-60">{int(resumoMap.get(c)?.anuncios)}</span>
          </Chip>
        ))}
        <div className="relative ml-auto">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search.q ?? ""}
            onChange={(e) => patch({ q: e.target.value || undefined, page: 1 })}
            placeholder="Buscar título, SKU ou MLB…"
            className="h-9 w-[240px] pl-8"
          />
        </div>
      </div>

      {(listaQ.error || resumoQ.error) && (
        <Card className="p-4 border-red-500/40 bg-red-500/5 text-sm text-red-600 dark:text-red-300">
          Erro ao carregar: {((listaQ.error || resumoQ.error) as Error).message}
        </Card>
      )}

      {/* Tabela */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-4 border-b">
          <h3 className="text-sm font-semibold">
            Anúncios{" "}
            {listaQ.data && <span className="text-muted-foreground font-normal">({int(linhas.length)})</span>}
          </h3>
          <select
            value={search.sort}
            onChange={(e) => patch({ sort: e.target.value as SortKey, page: 1 })}
            className="h-8 rounded-md border bg-background px-2 text-xs text-muted-foreground"
          >
            <option value="prioridade">Prioridade (dinheiro perdido)</option>
            <option value="visitas">Mais visitas</option>
            <option value="vendas">Mais vendas</option>
            <option value="conversao">Pior conversão</option>
            <option value="saude">Menor saúde</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Anúncio</th>
                <th className="text-right font-medium px-3 py-2">Visitas 30d</th>
                <th className="text-right font-medium px-3 py-2">Vendas 30d</th>
                <th className="text-right font-medium px-3 py-2">Conversão</th>
                <th className="text-center font-medium px-3 py-2">Saúde</th>
                <th className="text-left font-medium px-3 py-2">Classificação</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {carregando ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-t">
                    <td colSpan={7} className="px-3 py-3">
                      <Skeleton className="h-8 w-full" />
                    </td>
                  </tr>
                ))
              ) : visiveis.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-sm text-muted-foreground">
                    Nenhum anúncio com esses filtros.
                  </td>
                </tr>
              ) : (
                visiveis.map((r) => (
                  <tr key={r.mlb} className="border-t hover:bg-accent/40">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {r.foto ? (
                          <img src={r.foto} alt="" className="h-9 w-9 rounded object-cover border shrink-0" loading="lazy" />
                        ) : (
                          <div className="h-9 w-9 rounded bg-muted shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate max-w-[360px] font-medium">{r.titulo ?? r.mlb}</div>
                          <div className="text-[11px] text-muted-foreground font-mono flex items-center gap-1.5">
                            {r.mlb}
                            {r.sku && <span className="text-muted-foreground/70">· SKU {r.sku}</span>}
                            {r.catalog_listing && <span className="text-muted-foreground/70">· catálogo</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{int(r.visitas_30d)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatBRL(r.vendas_30d ?? 0)}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right tabular-nums font-semibold",
                        r.classificacao === "atrai_nao_vende" && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {pct(r.taxa_conversao)}
                    </td>
                    <td className="px-3 py-2">
                      <Saude health={r.health} catalogo={!!r.catalog_listing} />
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={cn("text-[10.5px] h-5 px-1.5 font-medium", CLASSE_META[r.classificacao].badge)}>
                        {CLASSE_META[r.classificacao].label}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 text-center">
                      {r.permalink && (
                        <a href={r.permalink} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary" title="Abrir no Mercado Livre">
                          <ExternalLink className="h-3.5 w-3.5 inline" />
                        </a>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {totalPaginas > 1 && (
          <div className="flex items-center justify-between gap-3 p-3 border-t text-xs text-muted-foreground">
            <span>
              Página {pagina} de {totalPaginas}
            </span>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" className="h-8" disabled={pagina <= 1} onClick={() => patch({ page: pagina - 1 })}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" className="h-8" disabled={pagina >= totalPaginas} onClick={() => patch({ page: pagina + 1 })}>
                Próxima
              </Button>
            </div>
          </div>
        )}
      </Card>

      <p className="text-xs text-muted-foreground leading-relaxed">
        <span className="text-rose-600 dark:text-rose-400 font-medium">Atrai e não vende</span> = muitas visitas, quase nenhuma venda (problema de preço ou ficha —
        o dinheiro perdido). <span className="text-amber-600 dark:text-amber-400 font-medium">Invisível</span> = pouco tráfego (problema de posição/relevância).
        <span className="text-emerald-600 dark:text-emerald-400 font-medium"> Saudável</span> = converte bem. Vendas de um SKU em vários anúncios são rateadas pelas
        visitas de cada um (sem dupla contagem). Saúde é a nota de qualidade do ML (anúncios de catálogo não têm nota individual). Dados atualizados por cron.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- subcomponentes
function Kpi({
  titulo, valor, sub, icone, stripe, carregando,
}: { titulo: string; valor: string; sub?: string; icone?: ReactNode; stripe?: string; carregando?: boolean }) {
  return (
    <Card className="relative p-4 overflow-hidden">
      {stripe && <span className="absolute left-0 top-0 h-full w-[3px]" style={{ background: stripe }} />}
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        {titulo}
        {icone}
      </div>
      {carregando ? (
        <Skeleton className="h-8 w-20 mt-1.5" />
      ) : (
        <div className="text-2xl font-semibold tabular-nums mt-1 font-mono">{valor}</div>
      )}
      {sub && !carregando && <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">{sub}</div>}
    </Card>
  );
}

function Saude({ health, catalogo }: { health: number | null; catalogo: boolean }) {
  if (health == null) {
    return <div className="text-center text-[11px] text-muted-foreground">{catalogo ? "catálogo" : "—"}</div>;
  }
  const p = Math.round(health * 100);
  const cor = p >= 80 ? "#2E9E8F" : p >= 60 ? "#E0A72E" : "#E5484D";
  return (
    <div className="flex items-center gap-2 justify-center">
      <div className="h-1.5 w-14 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${p}%`, background: cor }} />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground w-8">{p}%</span>
    </div>
  );
}

function Chip({ children, ativo, cor, onClick }: { children: ReactNode; ativo: boolean; cor?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium border transition-colors",
        ativo ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent text-muted-foreground border-border",
      )}
    >
      {cor && <span className="h-2 w-2 rounded-full" style={{ background: cor }} />}
      {children}
    </button>
  );
}
