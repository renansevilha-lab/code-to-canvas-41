import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Search } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Pesquisa de produtos — Amazon (19/out/2026). Só lê as views do banco; quem coleta é a edge fn
// pesquisa-amz (BSR diário 06h31 BRT, nossos ASINs e busca dos termos no domingo, Brand Analytics da
// semana fechada). Vendas/mês dos concorrentes = curva BSR → unidades calibrada com as NOSSAS vendas
// de 30 dias (view_pesquisa_amz_curva): é estimativa, e o selo diz quanto confiar.
// ============================================================================

export type AbaAmz = "meus" | "concorrentes" | "oportunidades" | "brand";
export const ABAS_AMZ: { id: AbaAmz; rotulo: string }[] = [
  { id: "meus", rotulo: "Meus produtos" },
  { id: "concorrentes", rotulo: "Concorrentes" },
  { id: "oportunidades", rotulo: "Oportunidades" },
  { id: "brand", rotulo: "Buscas (Brand Analytics)" },
];

const urlAmz = (asin: string) => `https://www.amazon.com.br/dp/${asin}`;
const fmtData = (d: string | null) => (d ? d.split("-").reverse().slice(0, 2).join("/") : "—");
const carregando = <p className="p-4 text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin mr-2" />Carregando…</p>;

/** Melhora de posição no BSR (número menor = melhor). */
function DeltaRank({ hoje, antes }: { hoje: number | null; antes: number | null }) {
  if (hoje == null || antes == null) return <span className="text-[11px] text-muted-foreground">—</span>;
  const d = antes - hoje;
  if (d === 0) return <span className="text-[11px] text-muted-foreground">=</span>;
  return d > 0
    ? <span className="inline-flex items-center text-[11px] font-semibold text-emerald-700 dark:text-emerald-400"><ArrowUp className="h-3 w-3" />{formatNumber(d)}</span>
    : <span className="inline-flex items-center text-[11px] font-semibold text-rose-700 dark:text-rose-400"><ArrowDown className="h-3 w-3" />{formatNumber(-d)}</span>;
}

function Estimativa({ v, minima, confianca }: { v: number | null; minima?: boolean | null; confianca: string | null }) {
  if (v == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="tabular-nums font-medium">{minima ? "≥ " : ""}{formatNumber(Number(v))}</span>
      {confianca && confianca !== "ok" && (
        <span className="ml-1.5 rounded bg-amber-500/10 px-1 text-[10px] text-amber-700 dark:text-amber-400" title="Curva com poucos pontos ou emprestada do Pet Shop inteiro">{confianca}</span>
      )}
    </span>
  );
}

export function PesquisaAmazon({ aba }: { aba: AbaAmz }) {
  if (aba === "concorrentes") return <Concorrentes />;
  if (aba === "oportunidades") return <Oportunidades />;
  if (aba === "brand") return <BrandAnalytics />;
  return <Meus />;
}

// ---------------------------------------------------------------- meus produtos
interface MeuRow { asin: string; nome: string | null; marca: string | null; categoria: string; tipo: string; data_coleta: string; rank_hoje: number | null; rank_7d: number | null; rank_30d: number | null; unidades_30d: number | null; skus: string | null; contas: string | null }

function Meus() {
  const [busca, setBusca] = useState("");
  const [soComVenda, setSoComVenda] = useState(false);
  const q = useQuery({
    queryKey: ["pesquisa-amz", "meus"],
    queryFn: async () => {
      const out: MeuRow[] = [];
      for (let de = 0; ; de += 1000) {
        const { data, error } = await supabaseExternal.from("view_pesquisa_amz_meus").select("*").eq("tipo", "subcategoria").range(de, de + 999);
        if (error) throw error;
        out.push(...((data ?? []) as MeuRow[]));
        if (!data || data.length < 1000) return out;
      }
    },
  });
  const termo = busca.trim().toLowerCase();
  const grupos = useMemo(() => {
    const linhas = (q.data ?? []).filter((l) => (!soComVenda || Number(l.unidades_30d) > 0)
      && (!termo || `${l.categoria} ${l.nome} ${l.marca} ${l.skus} ${l.asin}`.toLowerCase().includes(termo)));
    const m = new Map<string, MeuRow[]>();
    for (const l of linhas) m.set(l.categoria, [...(m.get(l.categoria) ?? []), l]);
    return [...m.entries()]
      .map(([cat, ls]) => ({ cat, ls: ls.sort((a, b) => (a.rank_hoje ?? 1e9) - (b.rank_hoje ?? 1e9)), un: ls.reduce((s, l) => s + Number(l.unidades_30d ?? 0), 0) }))
      .sort((a, b) => b.un - a.un || a.cat.localeCompare(b.cat));
  }, [q.data, termo, soComVenda]);
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
        <p className="text-xs text-muted-foreground flex-1 min-w-[260px]">
          Nossos ASINs (estoque FBA das duas contas + anúncios da ACZ) com o BSR de cada subcategoria: hoje × 7 e × 30 dias antes. Seta verde = subiu no ranking. Unidades = nossas vendas de 30 dias pelo SKU.
        </p>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={soComVenda} onChange={(e) => setSoComVenda(e.target.checked)} />só com venda</label>
        <div className="relative w-64"><Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Produto, SKU, ASIN ou categoria" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>
      </div>
      {q.isLoading ? carregando : q.isError ? <p className="p-4 text-sm text-destructive">{(q.error as Error).message}</p> : grupos.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nada para mostrar.</p> : (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
            <th className="px-3 py-2 text-left">Produto</th><th className="px-2 text-right">BSR hoje</th><th className="px-2 text-center">× 7 dias</th><th className="px-2 text-center">× 30 dias</th><th className="px-2 text-right pr-4">Vendas 30 d</th>
          </tr></thead>
          <tbody>
            {grupos.map((g) => (
              <Fragment key={g.cat}>
                <tr className="bg-muted/40"><td colSpan={5} className="px-3 py-1.5 text-xs font-semibold">{g.cat} <span className="font-normal text-muted-foreground">· {g.ls.length} ASIN{g.ls.length > 1 ? "s" : ""} · {formatNumber(g.un)} un. em 30 dias</span></td></tr>
                {g.ls.map((l) => (
                  <tr key={`${g.cat}-${l.asin}`} className="border-b">
                    <td className="px-3 py-1.5">
                      <a href={urlAmz(l.asin)} target="_blank" rel="noreferrer" className="hover:underline line-clamp-1" title={l.nome ?? ""}>{l.nome ?? l.asin}</a>
                      <div className="text-[11px] text-muted-foreground">{l.marca ?? "—"} · {l.asin}{l.skus ? ` · SKU ${l.skus}` : ""}{l.contas ? ` · ${l.contas.replace("ottz", "ACZ").replace("svl", "SVL")}` : ""}</div>
                    </td>
                    <td className="px-2 text-right tabular-nums font-medium">{l.rank_hoje != null ? `${formatNumber(l.rank_hoje)}º` : "—"}</td>
                    <td className="px-2 text-center"><DeltaRank hoje={l.rank_hoje} antes={l.rank_7d} /></td>
                    <td className="px-2 text-center"><DeltaRank hoje={l.rank_hoje} antes={l.rank_30d} /></td>
                    <td className="px-2 pr-4 text-right tabular-nums">{Number(l.unidades_30d) > 0 ? formatNumber(Number(l.unidades_30d)) : <span className="text-muted-foreground">0</span>}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </CardContent></Card>
  );
}

// ---------------------------------------------------------------- concorrentes
interface ConcRow { categoria: string; posicao: number; asin: string; nome: string | null; marca: string | null; e_meu: boolean; rank_atual: number; vendas_mes_est: number | null; confianca: string | null; curva: string | null; n_pontos: number; minhas_unidades_30d: number | null; rank_7d: number | null; melhora_7d: number | null; estimativa_minima: boolean | null }
interface CurvaRow { categoria: string; n_pontos: number; a: number | null; b: number | null; r2: number | null; situacao: string; metodo: string | null; rank_min: number | null; rank_max: number | null }

function useCurvas() {
  return useQuery({
    queryKey: ["pesquisa-amz", "curvas"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_amz_curva").select("categoria, n_pontos, a, b, r2, situacao, metodo, rank_min, rank_max");
      if (error) throw error;
      return new Map(((data ?? []) as CurvaRow[]).map((c) => [c.categoria, c]));
    },
  });
}

function TextoCurva({ c, geral }: { c: CurvaRow | undefined; geral: CurvaRow | undefined }) {
  if (!c) {
    return <>Sem venda nossa nesta subcategoria: a estimativa usa a curva do <b>Pet Shop inteiro</b> pelo BSR geral de cada produto{geral ? ` (${geral.n_pontos} pontos, r² ${Number(geral.r2 ?? 0).toFixed(2).replace(".", ",")})` : ""} — <b>baixa confiança</b>.</>;
  }
  const f = `vendas/mês = e^${Number(c.a).toFixed(2).replace(".", ",")} × BSR^${Number(c.b).toFixed(2).replace(".", ",")}`;
  if (c.metodo === "regressao") {
    return <>Curva própria com <b>{c.n_pontos} pontos</b> (nossas vendas × BSR, marcas próprias), r² {Number(c.r2 ?? 0).toFixed(2).replace(".", ",")}: {f}. Medida entre o BSR {formatNumber(Number(c.rank_min))} e {formatNumber(Number(c.rank_max))}; quem está muito acima disso aparece como mínimo (≥).</>;
  }
  return <>Só <b>{c.n_pontos} ponto{c.n_pontos > 1 ? "s" : ""}</b> nesta subcategoria (menos de 3): inclinação comum das categorias ancorada nas nossas vendas daqui — <b>baixa confiança</b>. {f}.</>;
}

function Concorrentes() {
  const q = useQuery({
    queryKey: ["pesquisa-amz", "concorrentes"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_pesquisa_amz_concorrentes").select("*").lte("posicao", 20).order("categoria").order("posicao").limit(5000);
      if (error) throw error;
      return (data ?? []) as ConcRow[];
    },
  });
  const curvas = useCurvas();
  const cats = useMemo(() => {
    const m = new Map<string, { n: number; meus: number }>();
    for (const r of q.data ?? []) {
      const e = m.get(r.categoria) ?? { n: 0, meus: 0 };
      e.n++; if (r.e_meu) e.meus++;
      m.set(r.categoria, e);
    }
    return [...m.entries()].sort((a, b) => b[1].meus - a[1].meus || a[0].localeCompare(b[0]));
  }, [q.data]);
  const [escolhida, setEscolhida] = useState<string | null>(null);
  const cat = escolhida ?? (cats.find(([c]) => c === "Areia para Gatos")?.[0] ?? cats[0]?.[0] ?? null);
  const linhas = (q.data ?? []).filter((r) => r.categoria === cat);
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
        <select className="h-8 rounded-md border bg-background px-2 text-sm max-w-[420px]" value={cat ?? ""} onChange={(e) => setEscolhida(e.target.value)}>
          {cats.map(([c, e]) => <option key={c} value={c}>{c}{e.meus ? ` (${e.meus} nossos)` : ""}</option>)}
        </select>
        <span className="text-xs text-muted-foreground flex-1 min-w-[260px]">
          Top 20 da subcategoria entre os ASINs que acompanhamos (nossos, os achados na busca dos termos e os mais clicados do Brand Analytics) — não é o ranking completo da Amazon.
        </span>
      </div>
      {cat && <p className="px-4 py-2 text-xs text-muted-foreground border-b bg-muted/20"><TextoCurva c={curvas.data?.get(cat)} geral={curvas.data?.get("*")} /></p>}
      {q.isLoading ? carregando : q.isError ? <p className="p-4 text-sm text-destructive">{(q.error as Error).message}</p> : (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
            <th className="px-3 py-2 text-left w-10">#</th><th className="text-left">Produto</th><th className="px-2 text-left">Marca</th>
            <th className="px-2 text-right">BSR</th><th className="px-2 text-center">Semana</th><th className="px-2 text-right pr-4">Vendas/mês (est.)</th>
          </tr></thead>
          <tbody>
            {linhas.map((r) => (
              <tr key={r.asin} className={cn("border-b", r.e_meu && "bg-primary/5")}>
                <td className="px-3 py-1.5 tabular-nums">{r.posicao}</td>
                <td className="py-1.5 pr-2">
                  <a href={urlAmz(r.asin)} target="_blank" rel="noreferrer" className="hover:underline line-clamp-1" title={r.nome ?? ""}>{r.nome ?? r.asin}</a>
                  {r.e_meu && <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">nosso anúncio{Number(r.minhas_unidades_30d) > 0 ? ` · vendemos ${formatNumber(Number(r.minhas_unidades_30d))} em 30 d` : ""}</span>}
                </td>
                <td className="px-2 text-xs">{r.marca ?? "—"}</td>
                <td className="px-2 text-right tabular-nums">{formatNumber(r.rank_atual)}º</td>
                <td className="px-2 text-center"><DeltaRank hoje={r.rank_atual} antes={r.rank_7d} /></td>
                <td className="px-2 pr-4 text-right"><Estimativa v={r.vendas_mes_est} minima={r.estimativa_minima} confianca={r.confianca} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardContent></Card>
  );
}

// ---------------------------------------------------------------- oportunidades
interface OpRow { categoria: string; n_top30: number; n_acima: number; vendas_est_top30: number | null; maior_est: number | null; lider_asin: string | null; lider_nome: string | null; lider_marca: string | null; confianca: string | null }

function Oportunidades() {
  const [minimo, setMinimo] = useState(100);
  const [valor, setValor] = useState("100");
  const q = useQuery({
    queryKey: ["pesquisa-amz", "oportunidades", minimo],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("pesquisa_amz_oportunidades", { p_min: minimo });
      if (error) throw error;
      return (data ?? []) as OpRow[];
    },
  });
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
        <form className="flex items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); const n = Number(valor.replace(",", ".")); if (n > 0) setMinimo(n); }}>
          Concorrentes vendendo mais de
          <Input className="h-8 w-24 text-sm" inputMode="numeric" value={valor} onChange={(e) => setValor(e.target.value)} onBlur={() => { const n = Number(valor.replace(",", ".")); if (n > 0) setMinimo(n); }} />
          un./mês
        </form>
        <p className="text-xs text-muted-foreground flex-1 min-w-[260px]">
          Subcategorias em que <b>não</b> temos produto entre os 30 primeiros acompanhados e algum concorrente passa do mínimo. Como não vendemos nelas, a estimativa vem da curva do Pet Shop inteiro: serve para comparar categorias entre si, não como número exato.
        </p>
      </div>
      {q.isLoading ? carregando : q.isError ? <p className="p-4 text-sm text-destructive">{(q.error as Error).message}</p> : (q.data ?? []).length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nenhuma subcategoria passa desse mínimo.</p> : (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
            <th className="px-3 py-2 text-left">Subcategoria</th><th className="px-2 text-center">Acompanhados</th><th className="px-2 text-center">Acima de {formatNumber(minimo)}</th>
            <th className="px-2 text-right">Soma do top 30 (est.)</th><th className="px-2 text-right">Maior</th><th className="px-2 text-left pr-4">1º lugar</th>
          </tr></thead>
          <tbody>
            {(q.data ?? []).map((o) => (
              <tr key={o.categoria} className="border-b">
                <td className="px-3 py-1.5 font-medium">{o.categoria}</td>
                <td className="px-2 text-center tabular-nums">{o.n_top30}</td>
                <td className="px-2 text-center tabular-nums">{o.n_acima}</td>
                <td className="px-2 text-right"><Estimativa v={o.vendas_est_top30} confianca={o.confianca} /></td>
                <td className="px-2 text-right tabular-nums">{o.maior_est != null ? formatNumber(Number(o.maior_est)) : "—"}</td>
                <td className="px-2 pr-4 text-xs max-w-[360px]">
                  {o.lider_asin ? <a href={urlAmz(o.lider_asin)} target="_blank" rel="noreferrer" className="hover:underline line-clamp-1" title={o.lider_nome ?? ""}><b>{o.lider_marca ?? "—"}</b> · {o.lider_nome ?? o.lider_asin}</a> : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardContent></Card>
  );
}

// ---------------------------------------------------------------- Brand Analytics
interface BrandRow { semana: string; termo: string; rank_busca: number | null; [k: string]: unknown }
interface RelRow { conta: string; semana: string; estado: string; erro: string | null; atualizado_em: string }

function Clicado({ r, i }: { r: BrandRow; i: 1 | 2 | 3 }) {
  const asin = r[`asin_${i}`] as string | null;
  if (!asin) return <td className="px-2 text-xs text-muted-foreground">—</td>;
  const nome = r[`nome_${i}`] as string | null; const marca = r[`marca_${i}`] as string | null; const meu = r[`meu_${i}`] as boolean;
  const cs = r[`click_share_${i}`] as number | null; const cv = r[`conv_share_${i}`] as number | null;
  return (
    <td className={cn("px-2 py-1.5 text-xs max-w-[220px]", meu && "bg-primary/5")}>
      <a href={urlAmz(asin)} target="_blank" rel="noreferrer" className="hover:underline line-clamp-1" title={nome ?? asin}><b>{marca ?? "—"}</b> · {nome ?? asin}</a>
      <div className="text-[10px] text-muted-foreground">
        {cs != null ? `${(Number(cs) * 100).toFixed(1).replace(".", ",")}% dos cliques` : ""}{cv != null ? ` · ${(Number(cv) * 100).toFixed(1).replace(".", ",")}% das vendas` : ""}
        {meu && <span className="ml-1 rounded bg-primary/15 px-1 text-primary" title="Temos anúncio neste ASIN (inclusive revenda)">nosso</span>}
      </div>
    </td>
  );
}

function BrandAnalytics() {
  const [busca, setBusca] = useState("");
  const [soMeus, setSoMeus] = useState(false);
  const relQ = useQuery({
    queryKey: ["pesquisa-amz", "relatorios"],
    queryFn: async () => {
      const { data } = await supabaseExternal.from("pesquisa_amz_relatorios").select("conta, semana, estado, erro, atualizado_em").order("semana", { ascending: false }).limit(10);
      return (data ?? []) as RelRow[];
    },
  });
  const termo = busca.trim();
  const q = useQuery({
    queryKey: ["pesquisa-amz", "brand", termo, soMeus],
    queryFn: async () => {
      let qq = supabaseExternal.from("view_pesquisa_amz_brand").select("*").order("rank_busca", { ascending: true, nullsFirst: false }).limit(300);
      if (termo) qq = qq.ilike("termo", `%${termo}%`);
      if (soMeus) qq = qq.or("meu_1.eq.true,meu_2.eq.true,meu_3.eq.true");
      const { data, error } = await qq;
      if (error) throw error;
      return (data ?? []) as BrandRow[];
    },
  });
  const semana = q.data?.[0]?.semana ?? null;
  const pendentes = (relQ.data ?? []).filter((r) => r.estado !== "gravado" && (!semana || r.semana > semana));
  return (
    <Card><CardContent className="p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b">
        <p className="text-xs text-muted-foreground flex-1 min-w-[260px]">
          Termos de pet mais buscados na Amazon{semana ? ` na semana de ${fmtData(semana)}` : ""} (posição 1 = o mais buscado do site) e os 3 ASINs mais clicados em cada um.
          Destaque = temos anúncio nesse ASIN.
          {pendentes.length > 0 && ` Semana seguinte: ${pendentes.map((p) => `${p.conta === "svl" ? "SVL" : "ACZ"} ${p.estado === "aguardando_dados" ? "aguardando a Amazon liberar" : p.estado === "FATAL" ? "recusado" : p.estado}`).join(" · ")}.`}
        </p>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={soMeus} onChange={(e) => setSoMeus(e.target.checked)} />só onde aparecemos</label>
        <div className="relative w-56"><Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Filtrar termo" value={busca} onChange={(e) => setBusca(e.target.value)} /></div>
      </div>
      {q.isLoading ? carregando : q.isError ? <p className="p-4 text-sm text-destructive">{(q.error as Error).message}</p> : (q.data ?? []).length === 0 ? <p className="p-4 text-sm text-muted-foreground">Nenhum termo.</p> : (
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase text-muted-foreground"><tr className="border-b">
            <th className="px-3 py-2 text-right w-20">Posição</th><th className="px-2 text-left">Termo</th><th className="px-2 text-left">1º mais clicado</th><th className="px-2 text-left">2º</th><th className="px-2 text-left">3º</th>
          </tr></thead>
          <tbody>
            {(q.data ?? []).map((r) => (
              <tr key={r.termo} className="border-b align-top">
                <td className="px-3 py-1.5 text-right tabular-nums">{r.rank_busca != null ? formatNumber(r.rank_busca) : "—"}</td>
                <td className="px-2 py-1.5 font-medium"><a className="hover:underline" target="_blank" rel="noreferrer" href={`https://www.amazon.com.br/s?k=${encodeURIComponent(r.termo)}`}>{r.termo}</a></td>
                <Clicado r={r} i={1} /><Clicado r={r} i={2} /><Clicado r={r} i={3} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardContent></Card>
  );
}
