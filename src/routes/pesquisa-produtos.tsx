import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Search, Shield, Sparkles, Telescope, TrendingUp } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { ABAS_AMZ, PesquisaAmazon, type AbaAmz } from "@/components/pesquisa/PesquisaAmazon";

// ============================================================================
// Pesquisa de produtos — Mercado Livre (18/out/2026) e Amazon (19/out/2026, ?mkt=amazon). Lê só as
// views do banco (edge fn pesquisa-ml: diário 07h13 BRT nas categorias em que estamos no top 20;
// semanal domingo de madrugada na árvore inteira do Pet Shop + tendências; pesquisa-amz: ver
// src/components/pesquisa/PesquisaAmazon.tsx). Comparação sempre entre snapshots:
// defesa = hoje × 7 dias antes; descoberta/tendências = coleta da semana × a anterior.
// ============================================================================

type Aba = "defesa" | "descoberta" | "tendencias";
const ABAS: { id: Aba; rotulo: string; icone: typeof Shield }[] = [
  { id: "defesa", rotulo: "Defesa (onde lidero)", icone: Shield },
  { id: "descoberta", rotulo: "Descoberta (categorias novas)", icone: Telescope },
  { id: "tendencias", rotulo: "Buscas em alta", icone: TrendingUp },
];
type Mkt = "ml" | "amazon";

export const Route = createFileRoute("/pesquisa-produtos")({
  validateSearch: (s: Record<string, unknown>): { mkt?: "amazon"; aba?: Aba | AbaAmz } => {
    const amz = s.mkt === "amazon";
    const aba = amz
      ? (ABAS_AMZ.some((a) => a.id === s.aba && a.id !== "meus") ? (s.aba as AbaAmz) : undefined)
      : (s.aba === "descoberta" || s.aba === "tendencias" ? s.aba : undefined);
    return { mkt: amz ? "amazon" : undefined, aba };
  },
  component: PesquisaProdutos,
});

const fmtData = (d: string | null) => (d ? d.split("-").reverse().slice(0, 2).join("/") : "—");
const urlMl = (tipo: string | null, id: string) =>
  tipo === "PRODUCT" ? `https://www.mercadolivre.com.br/p/${id}` : tipo === "ITEM" ? `https://produto.mercadolivre.com.br/${id.replace(/^MLB/, "MLB-")}` : null;

function Movimento({ m, v }: { m: string; v?: number | null }) {
  if (m === "novo") return <span className="rounded bg-sky-500/10 px-1.5 text-[11px] font-semibold text-sky-700 dark:text-sky-400">novo</span>;
  if (m === "saiu") return <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">saiu</span>;
  if (m === "subiu") return <span className="inline-flex items-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-400"><ArrowUp className="h-3 w-3" />{v ?? ""}</span>;
  if (m === "caiu") return <span className="inline-flex items-center text-[11px] font-semibold text-rose-700 dark:text-rose-400"><ArrowDown className="h-3 w-3" />{v != null ? Math.abs(v) : ""}</span>;
  if (m === "igual") return <span className="text-[11px] text-muted-foreground">=</span>;
  return <span className="text-[11px] text-muted-foreground">1ª coleta</span>;
}

function PesquisaProdutos() {
  const { mkt: mktUrl, aba: abaUrl } = Route.useSearch();
  const mkt: Mkt = mktUrl === "amazon" ? "amazon" : "ml";
  const nav = useNavigate({ from: Route.fullPath });
  const tabela = mkt === "amazon" ? "pesquisa_amz_execucoes" : "pesquisa_ml_execucoes";
  const execQ = useQuery({
    queryKey: ["pesquisa", mkt, "execucoes"],
    queryFn: async () => {
      const { data } = await supabaseExternal.from(tabela).select("modo, fim, erros").not("fim", "is", null).order("id", { ascending: false }).limit(40);
      const ult: Record<string, { fim: string; erros: unknown }> = {};
      for (const e of (data ?? []) as { modo: string; fim: string; erros: unknown }[]) if (!ult[e.modo]) ult[e.modo] = e;
      return ult;
    },
  });
  const quando = (m: string) => {
    const e = execQ.data?.[m];
    return e ? new Date(e.fim).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
  };
  const abaMl: Aba = mkt === "ml" && (abaUrl === "descoberta" || abaUrl === "tendencias") ? abaUrl : "defesa";
  const abaAmz: AbaAmz = mkt === "amazon" && ABAS_AMZ.some((a) => a.id === abaUrl) ? (abaUrl as AbaAmz) : "meus";
  const botao = (ativo: boolean) => cn("flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px", ativo ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pesquisa de produtos · {mkt === "amazon" ? "Amazon" : "Mercado Livre"}</h1>
          <p className="text-xs text-muted-foreground">
            {mkt === "amazon"
              ? <>BSR (ranking de vendas) das subcategorias, vendas estimadas e buscas da Amazon. BSR diário: {quando("diario")} · nossos ASINs: {quando("meus")} · busca dos termos: {quando("descobrir")} · Brand Analytics: {quando("brand_analytics")}</>
              : <>Top 20 mais vendidos e buscas em alta, da API do Mercado Livre. Diário: {quando("diario")} · semanal (Pet Shop inteiro): {quando("semanal")} · liderança: {quando("descobrir_lideranca")}</>}
          </p>
        </div>
        <div className="inline-flex rounded-md border p-0.5 text-sm">
          {(["ml", "amazon"] as Mkt[]).map((m) => (
            <button key={m} type="button" onClick={() => void nav({ search: { mkt: m === "amazon" ? "amazon" : undefined }, resetScroll: false })}
              className={cn("rounded px-3 py-1 font-medium", mkt === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {m === "amazon" ? "Amazon" : "Mercado Livre"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 border-b">
        {mkt === "ml"
          ? ABAS.map((a) => (
            <button key={a.id} type="button" onClick={() => void nav({ search: { aba: a.id === "defesa" ? undefined : a.id }, resetScroll: false })} className={botao(abaMl === a.id)}>
              <a.icone className="h-4 w-4" />{a.rotulo}
            </button>
          ))
          : ABAS_AMZ.map((a) => (
            <button key={a.id} type="button" onClick={() => void nav({ search: { mkt: "amazon", aba: a.id === "meus" ? undefined : a.id }, resetScroll: false })} className={botao(abaAmz === a.id)}>
              {a.rotulo}
            </button>
          ))}
      </div>
      {mkt === "amazon" ? <PesquisaAmazon aba={abaAmz} /> : (
        <>
          {abaMl === "defesa" && <Defesa />}
          {abaMl === "descoberta" && <Descoberta />}
          {abaMl === "tendencias" && <Tendencias />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- defesa
interface DefesaRow { category_id: string; categoria: string | null; caminho: string | null; data_coleta: string; data_base: string | null; minha_posicao: number | null; minha_posicao_base: number | null; meus_no_top: number; novos: number; sairam: number; catalogos_que_participo: number | null; melhor_catalogo: number | null }
interface TopRow { category_id: string; posicao: number | null; posicao_base: number | null; tipo: string | null; ml_id: string; titulo: string | null; preco: number | null; e_meu: boolean; meu_conta: string | null; meu_mlb: string | null; movimento: string; variacao: number | null; anuncio_proprio?: boolean; participo_catalogo?: boolean }

function Defesa() {
  const q = useQuery({
    queryKey: ["pesquisa-ml", "defesa"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_ml_defesa").select("*");
      if (error) throw error;
      // nosso anúncio no top primeiro; depois quem só participa de catálogo
      return ((data ?? []) as DefesaRow[]).sort((a, b) => (a.minha_posicao ?? 99) - (b.minha_posicao ?? 99) || (a.melhor_catalogo ?? 99) - (b.melhor_catalogo ?? 99));
    },
  });
  const [aberta, setAberta] = useState<string | null>(null);
  if (q.isLoading) return <p className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Carregando…</p>;
  if (q.isError) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  const linhas = q.data ?? [];
  return (
    <Card><CardContent className="p-0">
      <div className="px-4 py-3 text-xs text-muted-foreground border-b">
        Categorias em que aparecemos no top 20 (Ottz ou SVL). <b>Minha posição</b> = o NOSSO anúncio está no ranking; <b>Catálogo</b> = o produto de catálogo em que anunciamos está no ranking — participar do catálogo não quer dizer que a venda é nossa. Hoje × 7 dias antes; clique para ver o top 20.
      </div>
      {linhas.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nenhuma categoria monitorada ainda.</p> : (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
            <th className="w-6" /><th className="px-2 py-2 text-left">Categoria</th><th className="px-2 text-center">Minha posição</th>
            <th className="px-2 text-center">7 dias antes</th><th className="px-2 text-center">Catálogo</th><th className="px-2 text-center">Meus no top</th><th className="px-2 text-center">Novos</th><th className="px-2 text-center">Saíram</th><th className="px-2 text-right">Coleta</th>
          </tr></thead>
          <tbody>
            {linhas.map((l) => {
              const delta = l.minha_posicao != null && l.minha_posicao_base != null ? l.minha_posicao_base - l.minha_posicao : null;
              const abre = aberta === l.category_id;
              return (
                <Fragment key={l.category_id}>
                  <tr className="border-b cursor-pointer hover:bg-muted/40" onClick={() => setAberta(abre ? null : l.category_id)}>
                    <td className="pl-3">{abre ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="px-2 py-2"><div className="font-medium">{l.categoria ?? l.category_id}</div><div className="text-[11px] text-muted-foreground">{l.caminho}</div></td>
                    <td className="px-2 text-center">
                      {l.minha_posicao != null ? <span className="text-base font-semibold">{l.minha_posicao}º</span> : <span className="text-rose-600 text-xs">fora do top 20</span>}
                      {delta != null && delta !== 0 && <span className={cn("ml-1 text-xs font-semibold", delta > 0 ? "text-emerald-600" : "text-rose-600")}>{delta > 0 ? `+${delta}` : delta}</span>}
                    </td>
                    <td className="px-2 text-center text-muted-foreground">{l.data_base ? (l.minha_posicao_base != null ? `${l.minha_posicao_base}º` : "fora") : "sem base"}</td>
                    <td className="px-2 text-center">{l.melhor_catalogo != null ? <span title={`${l.catalogos_que_participo} catálogo(s) em que anunciamos no top 20`}>{l.melhor_catalogo}º{Number(l.catalogos_que_participo) > 1 ? <span className="text-[11px] text-muted-foreground"> +{Number(l.catalogos_que_participo) - 1}</span> : null}</span> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-2 text-center">{l.meus_no_top}</td>
                    <td className="px-2 text-center">{l.data_base ? l.novos : "—"}</td>
                    <td className="px-2 text-center">{l.data_base ? l.sairam : "—"}</td>
                    <td className="px-2 text-right text-xs text-muted-foreground pr-4">{fmtData(l.data_coleta)}{l.data_base ? ` × ${fmtData(l.data_base)}` : ""}</td>
                  </tr>
                  {abre && <tr><td colSpan={9} className="bg-muted/20 px-4 py-3"><TopCategoria categoria={l.category_id} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </CardContent></Card>
  );
}

function TopCategoria({ categoria }: { categoria: string }) {
  const q = useQuery({
    queryKey: ["pesquisa-ml", "top", categoria],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_ml_top_monitorado").select("*").eq("category_id", categoria);
      if (error) throw error;
      return ((data ?? []) as TopRow[]).sort((a, b) => (a.posicao ?? 99) - (b.posicao ?? 99) || (a.posicao_base ?? 99) - (b.posicao_base ?? 99));
    },
  });
  if (q.isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  return <TabelaRanking linhas={(q.data ?? []).map((r) => ({ ...r }))} />;
}

function TabelaRanking({ linhas, comMovimento = true }: { linhas: (TopRow | DescRow)[]; comMovimento?: boolean }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-[10px] uppercase text-muted-foreground"><tr>
        <th className="py-1 text-left w-10">Pos.</th>{comMovimento && <th className="text-left w-16">Mudança</th>}<th className="text-left">Produto / anúncio</th><th className="text-right w-24">Preço</th><th className="text-left w-24 pl-3">Tipo</th>
      </tr></thead>
      <tbody>
        {linhas.map((r) => {
          const meu = "e_meu" in r && r.e_meu;
          // linha gravada antes de 19/out não tem as colunas: tipo PRODUCT = catálogo
          const soCatalogo = meu && ("participo_catalogo" in r && r.participo_catalogo != null ? r.participo_catalogo && !r.anuncio_proprio : r.tipo === "PRODUCT");
          const url = urlMl(r.tipo, r.ml_id);
          return (
            <tr key={`${r.ml_id}-${r.posicao ?? "x"}`} className={cn("border-t", meu && !soCatalogo && "bg-primary/5 font-medium", soCatalogo && "bg-amber-500/5")}>
              <td className="py-1">{r.posicao != null ? `${r.posicao}º` : <span className="text-muted-foreground">({r.posicao_base}º)</span>}</td>
              {comMovimento && <td><Movimento m={r.movimento} v={"variacao" in r ? r.variacao : null} /></td>}
              <td className="pr-2">
                {url ? <a href={url} target="_blank" rel="noreferrer" className="hover:underline">{r.titulo ?? r.ml_id}</a> : <span>{r.titulo ?? <span className="text-muted-foreground">{r.ml_id} (o ML não libera os dados deste vendedor)</span>}</span>}
                {meu && (soCatalogo
                  ? <span className="ml-1.5 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-400" title="Anunciamos neste produto de catálogo; a posição é do catálogo, não do nosso anúncio">participamos do catálogo{"meu_conta" in r && r.meu_conta ? ` · ${r.meu_conta === "svl" ? "SVL" : "Ottz"}` : ""}</span>
                  : <span className="ml-1.5 rounded bg-primary/15 px-1 text-[10px] text-primary">nosso anúncio{"meu_conta" in r && r.meu_conta ? ` · ${r.meu_conta === "svl" ? "SVL" : "Ottz"}` : ""}</span>)}
              </td>
              <td className="text-right tabular-nums">{r.preco != null ? formatBRL(Number(r.preco)) : "—"}</td>
              <td className="pl-3 text-muted-foreground">{r.tipo === "PRODUCT" ? "catálogo" : r.tipo === "USER_PRODUCT" ? "user product" : r.tipo === "ITEM" ? "anúncio" : r.tipo}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- descoberta
interface ResumoRow { category_id: string; categoria: string | null; caminho: string | null; data_coleta: string; data_base: string | null; n_itens: number; novos: number; n_catalogo: number; preco_min: number | null; preco_max: number | null; preco_medio: number | null; lider_titulo: string | null }
interface DescRow { category_id: string; posicao: number | null; posicao_base: number | null; tipo: string | null; ml_id: string; titulo: string | null; preco: number | null; movimento: string }

function Descoberta() {
  const [busca, setBusca] = useState("");
  const [aberta, setAberta] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["pesquisa-ml", "descoberta-resumo"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_ml_descoberta_resumo").select("*").order("novos", { ascending: false }).order("preco_medio", { ascending: false, nullsFirst: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as ResumoRow[];
    },
  });
  const termo = busca.trim().toLowerCase();
  const linhas = (q.data ?? []).filter((l) => !termo || `${l.caminho} ${l.lider_titulo}`.toLowerCase().includes(termo));
  const semBase = (q.data ?? []).every((l) => !l.data_base);
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
        <p className="text-xs text-muted-foreground flex-1 min-w-[260px]">
          Folhas do Pet Shop em que <b>não</b> temos anúncio ativo, com o top 20 da última coleta semanal e a faixa de preço (preço da 1ª oferta dos produtos de catálogo).
          {semBase && " Ainda é a 1ª semana: \"novo\" só aparece a partir da próxima coleta."}
        </p>
        <div className="relative w-64"><Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Filtrar categoria ou produto" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>
      </div>
      {q.isLoading ? <p className="p-4 text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Carregando…</p>
        : q.isError ? <p className="p-4 text-sm text-destructive">{(q.error as Error).message}</p>
        : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
              <th className="w-6" /><th className="px-2 py-2 text-left">Categoria</th><th className="px-2 text-center">Novos no top 20</th>
              <th className="px-2 text-right">Faixa de preço</th><th className="px-2 text-right">Médio</th><th className="px-2 text-left">1º lugar</th>
            </tr></thead>
            <tbody>
              {linhas.map((l) => {
                const abre = aberta === l.category_id;
                return (
                  <Fragment key={l.category_id}>
                    <tr className="border-b cursor-pointer hover:bg-muted/40" onClick={() => setAberta(abre ? null : l.category_id)}>
                      <td className="pl-3">{abre ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                      <td className="px-2 py-2"><div className="font-medium">{l.categoria}</div><div className="text-[11px] text-muted-foreground">{l.caminho}</div></td>
                      <td className="px-2 text-center">{l.data_base ? (l.novos > 0 ? <b className="text-sky-700 dark:text-sky-400">{l.novos}</b> : 0) : "—"}</td>
                      <td className="px-2 text-right tabular-nums whitespace-nowrap">{l.preco_min != null ? `${formatBRL(Number(l.preco_min))} – ${formatBRL(Number(l.preco_max))}` : "—"}</td>
                      <td className="px-2 text-right tabular-nums">{l.preco_medio != null ? formatBRL(Number(l.preco_medio)) : "—"}</td>
                      <td className="px-2 text-xs text-muted-foreground max-w-[320px] truncate" title={l.lider_titulo ?? ""}>{l.lider_titulo ?? "—"}</td>
                    </tr>
                    {abre && <tr><td colSpan={6} className="bg-muted/20 px-4 py-3"><TopDescoberta categoria={l.category_id} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
    </CardContent></Card>
  );
}
function TopDescoberta({ categoria }: { categoria: string }) {
  const q = useQuery({
    queryKey: ["pesquisa-ml", "desc-top", categoria],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_ml_descoberta").select("category_id, posicao, posicao_base, tipo, ml_id, titulo, preco, movimento").eq("category_id", categoria).order("posicao");
      if (error) throw error;
      return (data ?? []) as DescRow[];
    },
  });
  if (q.isLoading) return <Loader2 className="h-4 w-4 animate-spin" />;
  return <TabelaRanking linhas={q.data ?? []} />;
}

// ---------------------------------------------------------------- tendências
interface TendRow { category_id: string; categoria: string | null; nivel: number | null; caminho: string | null; data_coleta: string; data_base: string | null; posicao: number; palavra: string; tipo: string; posicao_base: number | null; movimento: string }
const ROTULO_TIPO: Record<string, string> = { maior_crescimento: "maior crescimento", mais_desejadas: "mais desejada", populares: "popular" };

function Tendencias() {
  const [cat, setCat] = useState("MLB1071");
  const [so, setSo] = useState<"todas" | "novas">("todas");
  const catsQ = useQuery({
    queryKey: ["pesquisa-ml", "tend-cats"],
    queryFn: async () => {
      const { data } = await supabaseExternal.from("pesquisa_ml_categorias").select("category_id, nome, caminho, nivel").lte("nivel", 2).eq("ativa", true).order("caminho");
      return (data ?? []) as { category_id: string; nome: string | null; caminho: string | null; nivel: number }[];
    },
  });
  const q = useQuery({
    queryKey: ["pesquisa-ml", "tend", cat],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_ml_tendencias").select("*").eq("category_id", cat).order("posicao");
      if (error) throw error;
      return (data ?? []) as TendRow[];
    },
  });
  const linhas = (q.data ?? []).filter((t) => so === "todas" || t.movimento === "novo" || t.movimento === "subiu");
  const base = q.data?.[0]?.data_base ?? null;
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
        <select className="h-8 rounded-md border bg-background px-2 text-sm max-w-[420px]" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="MLB">Geral (todo o site)</option>
          {(catsQ.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.caminho ?? c.nome}</option>)}
        </select>
        <select className="h-8 rounded-md border bg-background px-2 text-sm" value={so} onChange={(e) => setSo(e.target.value as "todas" | "novas")}>
          <option value="todas">Todas as 50</option>
          <option value="novas">Só novas ou subindo</option>
        </select>
        <span className="text-xs text-muted-foreground flex-1">
          As 50 buscas da semana na ordem do Mercado Livre: 1–10 maior crescimento, 11–30 mais desejadas, 31–50 populares.
          {q.data?.length ? ` Coleta ${fmtData(q.data[0].data_coleta)}${base ? ` × ${fmtData(base)}` : " (1ª semana, sem comparação)"}.` : ""}
        </span>
      </div>
      {q.isLoading ? <p className="p-4 text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Carregando…</p>
        : linhas.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nada para mostrar.</p>
        : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
              <th className="px-3 py-2 text-left w-12">Pos.</th><th className="text-left w-20">Mudança</th><th className="text-left">Busca</th><th className="text-left w-40">Tipo</th><th className="w-24" />
            </tr></thead>
            <tbody>
              {linhas.map((t) => (
                <tr key={t.palavra} className="border-b">
                  <td className="px-3 py-1.5 tabular-nums">{t.posicao}º</td>
                  <td><Movimento m={t.movimento} v={t.posicao_base != null ? t.posicao_base - t.posicao : null} /></td>
                  <td className="font-medium">{t.palavra}</td>
                  <td className="text-xs text-muted-foreground">{t.tipo === "maior_crescimento" && <Sparkles className="inline h-3 w-3 mr-1 text-amber-500" />}{ROTULO_TIPO[t.tipo] ?? t.tipo}</td>
                  <td className="pr-3 text-right"><a className="text-xs text-primary hover:underline" target="_blank" rel="noreferrer" href={`https://lista.mercadolivre.com.br/${encodeURIComponent(t.palavra.replace(/\s+/g, "-"))}`}>ver no ML</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </CardContent></Card>
  );
}
