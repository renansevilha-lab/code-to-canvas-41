import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronRight as Seta, Loader2, Package, Search, Sparkles, X } from "lucide-react";

import { BotaoSincronizar } from "@/components/BotaoSincronizar";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePerfil } from "@/hooks/usePerfil";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// ============================================================================
// Catálogo = espelho dos produtos ATIVOS do Tiny (view_catalogo, situacao A).
// Paginação, filtros e números do topo vêm do banco (view_catalogo +
// catalogo_resumo) — nada de cortar em 1.000 linhas nem somar no navegador.
// Variações aparecem dentro do pai (sku_pai, gravado pelo detalhe do Tiny);
// kit abre a composição (produto_kits). Estado na URL. Sync: tiny-sync-produtos
// v28 (listagem retomável + inativos/excluídos marcados). No ar desde 12/out/2026
// (antes a tela lia view_produtos_margem inteira no navegador).
// ============================================================================

type Flag = "sem_foto" | "sem_custo" | "kit_sem_comp";
type Busca = { q?: string; tipo?: string; marca?: string; cat?: string; flag?: Flag; pag?: number };

export const Route = createFileRoute("/produtos")({
  validateSearch: (s: Record<string, unknown>): Busca => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    tipo: typeof s.tipo === "string" && s.tipo ? s.tipo : undefined,
    marca: typeof s.marca === "string" && s.marca ? s.marca : undefined,
    cat: typeof s.cat === "string" && s.cat ? s.cat : undefined,
    flag: s.flag === "sem_foto" || s.flag === "sem_custo" || s.flag === "kit_sem_comp" ? s.flag : undefined,
    pag: Number(s.pag) > 0 ? Math.floor(Number(s.pag)) : undefined,
  }),
  component: CatalogoPage,
});

const POR_PAGINA = 50;
const COLUNAS = "sku,nome,tipo,tipo_rotulo,sku_pai,marca,categoria_caminho,categoria_folha,foto,preco,custo,margem_bruta,margem_pct,estoque,estoque_atualizado_em,gtin,unidade,eh_kit,n_componentes,kit_sem_composicao,n_variacoes";

type Item = {
  sku: string; nome: string | null; tipo: string | null; tipo_rotulo: string; sku_pai: string | null;
  marca: string | null; categoria_caminho: string | null; categoria_folha: string | null; foto: string | null;
  preco: number | null; custo: number | null; margem_bruta: number | null; margem_pct: number | null;
  estoque: number | null; estoque_atualizado_em: string | null; gtin: string | null; unidade: string | null;
  eh_kit: boolean; n_componentes: number; kit_sem_composicao: boolean; n_variacoes: number;
};
type Resumo = {
  ativos_espelho: number; por_tipo: Record<string, number>; sem_foto: number; sem_custo: number;
  kit_sem_composicao: number; detalhe_mais_antigo: string | null; marcas: string[]; categorias: string[];
  sync: null | { fase: string; proximo_offset: number; ultima_completa_em: string | null; total_tiny_ativos: number | null;
    passada_iniciada_em: string | null; inativados_ultima: number | null };
};

const TIPOS: Array<{ v: string; rot: string }> = [
  { v: "S", rot: "Simples" }, { v: "K", rot: "Kit" }, { v: "V", rot: "Com variações" }, { v: "F", rot: "Fabricado" },
];
const FLAGS: Array<{ v: Flag; rot: string; chave: keyof Resumo }> = [
  { v: "sem_foto", rot: "Sem foto", chave: "sem_foto" },
  { v: "sem_custo", rot: "Sem custo", chave: "sem_custo" },
  { v: "kit_sem_comp", rot: "Kit sem composição", chave: "kit_sem_composicao" },
];

/** Termo seguro para o filtro .or() do PostgREST (vírgula/parêntese quebram a expressão). */
const limpar = (t: string) => t.replace(/[,()%_*\\]/g, " ").trim();
const dataHora = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

function CatalogoPage() {
  const busca = Route.useSearch();
  const navigate = useNavigate({ from: "/produtos" });
  const setBusca = (patch: Partial<Busca>) =>
    navigate({ search: (b: Busca) => ({ ...b, ...patch, pag: "pag" in patch ? patch.pag : undefined }), replace: true });
  const pag = busca.pag ?? 0;
  // "Gerar anúncio" (IA · Anúncios) só para quem tem o módulo IA
  const podeIa = usePerfil().temAcesso("ia");

  const [texto, setTexto] = useState(busca.q ?? "");
  useEffect(() => {
    const t = setTimeout(() => { if ((busca.q ?? "") !== texto.trim()) setBusca({ q: texto.trim() || undefined }); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto]);

  const resumoQ = useQuery({
    queryKey: ["catalogo", "resumo"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Resumo> => {
      const { data, error } = await supabaseExternal.rpc("catalogo_resumo");
      if (error) throw error;
      return data as Resumo;
    },
  });
  const r = resumoQ.data;

  const listaQ = useQuery({
    queryKey: ["catalogo", "lista", busca],
    staleTime: 5 * 60_000,
    placeholderData: (ant) => ant,
    queryFn: async (): Promise<{ itens: Item[]; total: number }> => {
      let q = supabaseExternal.from("view_catalogo").select(COLUNAS, { count: "exact" });
      const termos = limpar(busca.q ?? "").split(/\s+/).filter(Boolean);
      // Sem busca: só o nível de cima (variações ficam dentro do pai). Com busca: tudo.
      if (termos.length === 0) q = q.is("sku_pai", null);
      for (const t of termos) q = q.or(`sku.ilike.${t}%,nome.ilike.%${t}%,gtin.eq.${t}`);
      if (busca.tipo) q = q.eq("tipo", busca.tipo);
      if (busca.marca) q = q.eq("marca", busca.marca);
      if (busca.cat) q = q.eq("categoria_caminho", busca.cat);
      if (busca.flag === "sem_foto") q = q.is("foto", null);
      if (busca.flag === "sem_custo") q = q.or("custo.is.null,custo.lte.0").neq("tipo", "V");
      if (busca.flag === "kit_sem_comp") q = q.eq("kit_sem_composicao", true);
      const { data, error, count } = await q.order("nome", { ascending: true }).order("sku")
        .range(pag * POR_PAGINA, pag * POR_PAGINA + POR_PAGINA - 1);
      if (error) throw error;
      return { itens: (data ?? []) as Item[], total: count ?? 0 };
    },
  });
  const itens = listaQ.data?.itens ?? [];
  const total = listaQ.data?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const temFiltro = !!(busca.q || busca.tipo || busca.marca || busca.cat || busca.flag);

  const sync = r?.sync;
  const diferenca = sync?.total_tiny_ativos != null && r ? r.ativos_espelho - sync.total_tiny_ativos : null;

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tight">Catálogo</h1>
          <p className="text-muted-foreground text-sm">
            Espelho dos produtos <b>ativos no Tiny</b>, com custo (kit pela composição), preço, estoque, variações e kits.
          </p>
        </div>
        <BotaoSincronizar
          rotulo="Sincronizar com o Tiny"
          titulo="Lê a listagem do Tiny (marca inativos e excluídos), detalha os produtos novos e relê o detalhe dos mais antigos. Leva 1 a 2 minutos. Sozinho: listagem 1x/dia de madrugada, detalhe a cada 30 min."
          rotas={[
            "tiny-sync-produtos?modulo=produtos&forcar=1",
            "tiny-sync-produtos?modulo=produtos",
            "tiny-sync-produtos?modulo=detalhar&limite=20",
            "tiny-sync-produtos?modulo=detalhar&refresh=1&limite=20",
            "tiny-sync?modulo=kits&max_kits=20",
          ]}
          invalidar={["catalogo"]}
        />
      </header>

      {/* Números do topo (banco) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-[12px] font-medium text-muted-foreground">Ativos no catálogo</div>
          <div className="text-2xl font-semibold tabular-nums mt-1">{r ? formatNumber(r.ativos_espelho) : "…"}</div>
          <div className="text-[12px] text-muted-foreground mt-0.5">
            {sync?.total_tiny_ativos != null
              ? <>Tiny: {formatNumber(sync.total_tiny_ativos)}{diferenca ? <span className={cn("ml-1", diferenca !== 0 && "text-warning")}>({diferenca > 0 ? "+" : ""}{diferenca})</span> : " · bate"}</>
              : "Total do Tiny após a 1ª passada"}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] font-medium text-muted-foreground">Por tipo</div>
          <div className="text-[13px] mt-1.5 space-y-0.5">
            {r ? Object.entries(r.por_tipo).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
              <div key={t} className="flex justify-between gap-2"><span>{t}</span><span className="tabular-nums text-muted-foreground">{formatNumber(n)}</span></div>
            )) : "…"}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] font-medium text-muted-foreground">Pendências de cadastro</div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {FLAGS.map((f) => (
              <Button key={f.v} size="sm" variant={busca.flag === f.v ? "default" : "outline"} className="h-7 text-[11.5px] px-2"
                onClick={() => setBusca({ flag: busca.flag === f.v ? undefined : f.v })}>
                {f.rot} <span className="ml-1 opacity-70 tabular-nums">{r ? formatNumber(Number(r[f.chave] ?? 0)) : "…"}</span>
              </Button>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[12px] font-medium text-muted-foreground">Sincronização com o Tiny</div>
          <div className="text-[12.5px] mt-1.5 space-y-0.5">
            <div>Listagem completa: <b>{dataHora(sync?.ultima_completa_em)}</b></div>
            {sync && (sync.fase !== "ativos" || sync.proximo_offset > 0) && (
              <div className="text-warning">Passada em andamento ({sync.fase}, {formatNumber(sync.proximo_offset)})</div>
            )}
            <div className="text-muted-foreground">Detalhe mais antigo: {dataHora(r?.detalhe_mais_antigo)}</div>
          </div>
        </Card>
      </div>

      {/* Filtros */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-9 pl-8" placeholder="Buscar por nome, SKU ou GTIN" value={texto} onChange={(e) => setTexto(e.target.value)} />
          </div>
          <Select value={busca.tipo ?? "todos"} onValueChange={(v) => setBusca({ tipo: v === "todos" ? undefined : v })}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os tipos</SelectItem>
              {TIPOS.map((t) => <SelectItem key={t.v} value={t.v}>{t.rot}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={busca.marca ?? "todas"} onValueChange={(v) => setBusca({ marca: v === "todas" ? undefined : v })}>
            <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <SelectItem value="todas">Todas as marcas</SelectItem>
              {(r?.marcas ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={busca.cat ?? "todas"} onValueChange={(v) => setBusca({ cat: v === "todas" ? undefined : v })}>
            <SelectTrigger className="h-9 w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-[320px]">
              <SelectItem value="todas">Todas as categorias</SelectItem>
              {(r?.categorias ?? []).map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          {temFiltro && (
            <Button variant="ghost" size="sm" className="h-9 gap-1" onClick={() => { setTexto(""); navigate({ search: {}, replace: true }); }}>
              <X className="h-3.5 w-3.5" /> Limpar
            </Button>
          )}
        </div>
        <div className="mt-2.5 text-[12.5px] text-muted-foreground">
          {listaQ.isLoading ? "Carregando…" : `${formatNumber(total)} produto(s)${!busca.q ? " · variações dentro do produto pai" : ""}`}
        </div>
      </Card>

      {/* Tabela */}
      <Card className="overflow-hidden">
        {listaQ.isError ? (
          <div className="p-8 text-center text-destructive text-sm">Falha ao carregar: {(listaQ.error as Error).message}</div>
        ) : listaQ.isLoading ? (
          <div className="p-12 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando catálogo…</div>
        ) : itens.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Nenhum produto neste filtro.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5 font-medium w-8" />
                  <th className="px-3 py-2.5 font-medium">Produto</th>
                  <th className="px-3 py-2.5 font-medium">Marca · categoria</th>
                  <th className="px-3 py-2.5 font-medium text-right">Custo</th>
                  <th className="px-3 py-2.5 font-medium text-right">Preço</th>
                  <th className="px-3 py-2.5 font-medium text-right" title="Preço de tabela − custo (CMV efetivo)">Margem</th>
                  <th className="px-3 py-2.5 font-medium text-right" title="Estoque total no Tiny (do detalhe do produto)">Estoque</th>
                  {podeIa && <th className="px-3 py-2.5 font-medium w-8" />}
                </tr>
              </thead>
              <tbody>
                {itens.map((p) => <LinhaCatalogo key={p.sku} p={p} mostrarPai={!!busca.q} podeIa={podeIa} />)}
              </tbody>
            </table>
          </div>
        )}
        {paginas > 1 && (
          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t text-[12.5px] text-muted-foreground">
            Página {pag + 1} de {paginas}
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={pag === 0} onClick={() => setBusca({ pag: pag - 1 || undefined })}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={pag + 1 >= paginas} onClick={() => setBusca({ pag: pag + 1 })}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Foto({ url }: { url: string | null }) {
  const [erro, setErro] = useState(false);
  return (
    <div className="h-10 w-10 rounded-md overflow-hidden bg-muted flex items-center justify-center shrink-0 border">
      {url && !erro
        ? <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setErro(true)} />
        : <Package className="h-4 w-4 text-muted-foreground" />}
    </div>
  );
}

function corMargem(pct: number | null) {
  if (pct == null) return "text-muted-foreground";
  return pct >= 40 ? "text-success" : pct >= 20 ? "text-warning" : "text-destructive";
}

function LinhaCatalogo({ p, mostrarPai, filho, podeIa }: { p: Item; mostrarPai?: boolean; filho?: boolean; podeIa?: boolean }) {
  const [aberto, setAberto] = useState(false);
  const abre = (p.tipo === "V" && p.n_variacoes > 0) || (p.eh_kit && p.n_componentes > 0);
  return (
    <>
      <tr className={cn("border-t hover:bg-muted/30", filho && "bg-muted/15")}>
        <td className="px-3 py-2 align-middle">
          {abre && (
            <button type="button" onClick={() => setAberto((a) => !a)} className="text-muted-foreground hover:text-foreground"
              title={p.tipo === "V" ? "Ver variações" : "Ver composição do kit"} aria-expanded={aberto}>
              {aberto ? <ChevronDown className="h-4 w-4" /> : <Seta className="h-4 w-4" />}
            </button>
          )}
        </td>
        <td className="px-3 py-2">
          <div className={cn("flex items-center gap-2.5 min-w-[280px] max-w-[460px]", filho && "pl-5")}>
            <Foto url={p.foto} />
            <div className="min-w-0">
              <div className="truncate font-medium" title={p.nome ?? ""}>{p.nome ?? "—"}</div>
              <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11.5px] text-muted-foreground">
                <span className="font-mono">{p.sku}</span>
                <Badge variant="secondary" className="text-[10px] py-0 px-1.5">{p.tipo_rotulo}</Badge>
                {p.tipo === "V" && p.n_variacoes > 0 && <span>{p.n_variacoes} variações</span>}
                {p.eh_kit && p.n_componentes > 0 && <span>{p.n_componentes} componente(s)</span>}
                {p.kit_sem_composicao && <Badge variant="outline" className="text-[10px] py-0 px-1.5 text-destructive border-destructive/30">kit sem composição</Badge>}
                {mostrarPai && p.sku_pai && <span>variação de <span className="font-mono">{p.sku_pai}</span></span>}
                {p.gtin && <span title="GTIN/EAN">GTIN {p.gtin}</span>}
              </div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2 text-[12.5px]">
          <div className="truncate max-w-[220px]">{p.marca ?? <span className="text-muted-foreground">sem marca</span>}</div>
          <div className="truncate max-w-[220px] text-muted-foreground text-[11.5px]" title={p.categoria_caminho ?? ""}>{p.categoria_folha ?? "—"}</div>
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {p.tipo === "V" ? <span className="text-muted-foreground">—</span>
            : p.custo != null && Number(p.custo) > 0 ? formatBRL(Number(p.custo)) : <span className="text-destructive text-[12px]">sem custo</span>}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{p.preco != null ? formatBRL(Number(p.preco)) : "—"}</td>
        <td className={cn("px-3 py-2 text-right tabular-nums", corMargem(p.margem_pct != null ? Number(p.margem_pct) : null))}>
          {p.margem_pct != null ? `${Number(p.margem_pct).toFixed(1).replace(".", ",")}%` : "—"}
        </td>
        <td className="px-3 py-2 text-right tabular-nums" title={p.estoque_atualizado_em ? `Atualizado ${dataHora(p.estoque_atualizado_em)}` : "Ainda não lido do Tiny"}>
          {p.estoque != null ? formatNumber(p.estoque) : <span className="text-muted-foreground">—</span>}
        </td>
        {podeIa && (
          <td className="px-3 py-2 text-right">
            {/* o anúncio é do produto vendido (simples, kit ou variação); o pai só agrupa */}
            {p.tipo !== "V" && (
              <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11.5px] whitespace-nowrap">
                <Link to="/ia/gerar" search={{ sku: p.sku, canal: "shopee", empresa: "ottz" }} title="Gerar anúncio com IA">
                  <Sparkles className="h-3.5 w-3.5" />Gerar anúncio
                </Link>
              </Button>
            )}
          </td>
        )}
      </tr>
      {aberto && p.tipo === "V" && <Variacoes skuPai={p.sku} podeIa={podeIa} />}
      {aberto && p.eh_kit && <Composicao skuKit={p.sku} colunas={podeIa ? 7 : 6} />}
    </>
  );
}

function Variacoes({ skuPai, podeIa }: { skuPai: string; podeIa?: boolean }) {
  const q = useQuery({
    queryKey: ["catalogo", "variacoes", skuPai],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Item[]> => {
      const { data, error } = await supabaseExternal.from("view_catalogo").select(COLUNAS).eq("sku_pai", skuPai).order("sku");
      if (error) throw error;
      return (data ?? []) as Item[];
    },
  });
  if (q.isLoading) return <tr><td colSpan={podeIa ? 8 : 7} className="px-12 py-2 text-[12px] text-muted-foreground">Carregando variações…</td></tr>;
  return <>{(q.data ?? []).map((v) => <LinhaCatalogo key={v.sku} p={v} filho podeIa={podeIa} />)}</>;
}

function Composicao({ skuKit, colunas }: { skuKit: string; colunas: number }) {
  const q = useQuery({
    queryKey: ["catalogo", "kit", skuKit],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("produto_kits")
        .select("sku_componente, nome_componente, quantidade").eq("sku_kit", skuKit).order("sku_componente");
      if (error) throw error;
      const comps = (data ?? []) as Array<{ sku_componente: string; nome_componente: string | null; quantidade: number }>;
      const { data: custos } = comps.length
        ? await supabaseExternal.from("produtos").select("sku, custo").in("sku", comps.map((c) => c.sku_componente))
        : { data: [] };
      const custo = new Map(((custos ?? []) as Array<{ sku: string; custo: number | null }>).map((c) => [c.sku, c.custo]));
      return comps.map((c) => ({ ...c, custo: custo.get(c.sku_componente) ?? null }));
    },
  });
  return (
    <tr className="bg-muted/15">
      <td />
      <td colSpan={colunas} className="px-3 py-2">
        {q.isLoading ? <span className="text-[12px] text-muted-foreground">Carregando composição…</span> : (
          <div className="pl-5 text-[12.5px] space-y-1">
            {(q.data ?? []).map((c) => (
              <div key={c.sku_componente} className="flex items-center gap-3">
                <span className="tabular-nums w-10 text-right font-medium">{formatNumber(Number(c.quantidade))}×</span>
                <span className="font-mono text-muted-foreground w-16">{c.sku_componente}</span>
                <span className="flex-1 truncate">{c.nome_componente ?? "—"}</span>
                <span className="tabular-nums text-muted-foreground w-24 text-right">
                  {c.custo != null && Number(c.custo) > 0 ? `${formatBRL(Number(c.custo))} un` : <span className="text-destructive">sem custo</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
