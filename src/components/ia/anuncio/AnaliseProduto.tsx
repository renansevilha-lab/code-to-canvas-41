import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";

// ============================================================================
// Aba "Análise" do anúncio (12/out/2026, pedido do dono): vendas do produto por dia e por
// canal, margem e ADS dos últimos 30 dias, de qual anúncio a venda saiu e o estoque (com o
// valor parado). Tudo vem pronto da RPC `ia_analise_sku` (docs/ia-analise-sku.sql) — o
// navegador só soma os dias do período escolhido. Produto com variações = soma das variações;
// kit = o estoque é o do componente.
// Margem/ADS: matview do Agente de ADS (30 dias fechados até ontem; cobre Shopee e Mercado
// Livre). Amazon e TikTok aparecem pelo histórico de 30/120 dias, sem ADS.
// ============================================================================

interface Dia { data: string; marketplace: string; unidades: number; receita: number }
interface Canal {
  marketplace: string; shop_id: number; empresa: string | null; receita: number; unidades: number; pedidos: number; cmv: number;
  margem: number; gasto_ads: number; margem_pos_ads: number; confiavel: boolean;
}
interface Anuncio {
  marketplace: string; shop_id: number; empresa: string | null; anuncio_id: string; titulo: string | null; sku: string; receita: number; unidades: number;
  margem: number; margem_pct: number | null; gasto_ads: number; margem_pos_ads: number; margem_pos_ads_pct: number | null; situacao: string | null;
}
interface Hist { sku: string; canal: string; empresa: string; un30: number; un120: number; preco: number | null; taxa: number | null; mc_pct: number | null; ultima_venda: string | null }
interface Estoque {
  sku: string; nome: string | null; custo: number | null; geral: number | null; reservado: number | null; tiny_em: string | null;
  full_total: number | null; em_transito: number | null; valor: number | null;
  full_amazon: number | null; full_ml: number | null; full_shopee: number | null; full_em_transito: number | null; estoque_total: number | null;
  valor_estoque: number | null; venda_30d: number | null; venda_dia: number | null; cobertura_total_dias: number | null; oc_aguardando: number | null;
  situacao: string | null; usado_em: { kit: string; quantidade: number }[];
}
interface Analise {
  skus: string[]; dias_janela: number; hoje: string; margem_em: string | null;
  dias: Dia[]; canais: Canal[]; anuncios: Anuncio[]; historico: Hist[]; estoque: Estoque[];
}

const n = (x: unknown) => { const v = Number(x ?? 0); return Number.isFinite(v) ? v : 0; };
const pct = (parte: number, todo: number) => (todo > 0 ? `${((parte / todo) * 100).toFixed(1).replace(".", ",")}%` : "—");
const MKT: Record<string, { nome: string; cor: string }> = {
  shopee: { nome: "Shopee", cor: "#EE4D2D" },
  mercadolivre: { nome: "Mercado Livre", cor: "#D9A400" },
  mercado_livre: { nome: "Mercado Livre", cor: "#D9A400" },
  amazon: { nome: "Amazon", cor: "#2F6FB3" },
  tiktok: { nome: "TikTok", cor: "#111827" },
};
const mkt = (m: string) => MKT[m] ?? { nome: m, cor: "#8B8B8B" };
const SITUACAO_ADS: Record<string, string> = { prejuizo: "text-destructive", apertado: "text-amber-600", saudavel: "text-emerald-600", folgado: "text-emerald-600" };
const dm = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

export function AnaliseProduto({ sku }: { sku: string }) {
  const [periodo, setPeriodo] = useState(30);
  const q = useQuery({
    queryKey: ["ia-anuncio", "analise", sku],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Analise> => {
      const { data, error } = await supabaseExternal.rpc("ia_analise_sku", { p_sku: sku, p_dias: 60 });
      if (error) throw error;
      return data as Analise;
    },
  });
  const a = q.data;

  // série do período: um ponto por dia (inclusive os sem venda), empilhado por marketplace
  const serie = useMemo(() => {
    if (!a) return { dias: [] as { data: string; partes: { m: string; receita: number; unidades: number }[]; receita: number; unidades: number }[], maior: 0, receita: 0, unidades: 0, porMkt: [] as { m: string; receita: number; unidades: number }[] };
    const fim = new Date(`${a.hoje}T12:00:00`);
    const dias = Array.from({ length: periodo }, (_, i) => {
      const d = new Date(fim); d.setDate(fim.getDate() - (periodo - 1 - i));
      const data = d.toISOString().slice(0, 10);
      const partes = a.dias.filter((x) => x.data === data).map((x) => ({ m: x.marketplace, receita: n(x.receita), unidades: n(x.unidades) }));
      return { data, partes, receita: partes.reduce((s, p) => s + p.receita, 0), unidades: partes.reduce((s, p) => s + p.unidades, 0) };
    });
    const acc = new Map<string, { m: string; receita: number; unidades: number }>();
    for (const d of dias) for (const p of d.partes) { const t = acc.get(p.m) ?? { m: p.m, receita: 0, unidades: 0 }; t.receita += p.receita; t.unidades += p.unidades; acc.set(p.m, t); }
    return {
      dias, maior: Math.max(0, ...dias.map((d) => d.receita)), receita: dias.reduce((s, d) => s + d.receita, 0), unidades: dias.reduce((s, d) => s + d.unidades, 0),
      porMkt: [...acc.values()].sort((x, z) => z.receita - x.receita),
    };
  }, [a, periodo]);

  if (q.isLoading) return <Card><CardContent className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Montando a análise…</CardContent></Card>;
  if (q.isError || !a) return <Card><CardContent className="p-6 text-sm text-destructive">Não consegui montar a análise: {(q.error as Error)?.message}</CardContent></Card>;

  const t30 = a.canais.reduce((s, c) => ({ receita: s.receita + n(c.receita), margem: s.margem + n(c.margem), ads: s.ads + n(c.gasto_ads), pos: s.pos + n(c.margem_pos_ads), un: s.un + n(c.unidades) }), { receita: 0, margem: 0, ads: 0, pos: 0, un: 0 });
  const valorEstoque = a.estoque.reduce((s, e) => s + n(e.valor_estoque ?? e.valor), 0);
  // canais que só existem no histórico (Amazon, TikTok): sem margem em R$ nem ADS nesta fonte
  const comMargem = new Set(a.canais.map((c) => mkt(c.marketplace).nome));
  const soHistorico = Object.values(a.historico.filter((h) => !comMargem.has(mkt(h.canal).nome)).reduce((acc, h) => {
    const k = `${h.canal}|${h.empresa}`; const t = acc[k] ?? { canal: h.canal, empresa: h.empresa, un30: 0, un120: 0, mc: 0, peso: 0 };
    t.un30 += n(h.un30); t.un120 += n(h.un120); if (h.mc_pct != null) { t.mc += n(h.mc_pct) * Math.max(1, n(h.un120)); t.peso += Math.max(1, n(h.un120)); }
    acc[k] = t; return acc;
  }, {} as Record<string, { canal: string; empresa: string; un30: number; un120: number; mc: number; peso: number }>));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Kpi rotulo={`Unidades · ${periodo} dias`} valor={formatNumber(serie.unidades)} />
        <Kpi rotulo={`Receita · ${periodo} dias`} valor={formatBRL(serie.receita)} />
        <Kpi rotulo="Margem · 30 dias" valor={formatBRL(t30.margem)} sub={pct(t30.margem, t30.receita)} />
        <Kpi rotulo="ADS · 30 dias" valor={formatBRL(t30.ads)} sub={t30.ads > 0 ? `${pct(t30.ads, t30.receita)} da receita` : "sem gasto"} />
        <Kpi rotulo="Margem pós-ADS · 30 dias" valor={formatBRL(t30.pos)} sub={pct(t30.pos, t30.receita)} alerta={t30.pos < 0} />
        <Kpi rotulo="Valor em estoque" valor={formatBRL(valorEstoque)} sub="ao custo" />
      </div>

      <Card><CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Vendas por dia</h2>
          {a.skus.length > 1 && <span className="text-xs text-muted-foreground">soma das {a.skus.length - 1} variações</span>}
          <div className="flex-1" />
          {[7, 30, 60].map((p) => (
            <Button key={p} size="sm" variant={periodo === p ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setPeriodo(p)}>{p} dias</Button>
          ))}
        </div>
        {serie.receita === 0 ? <p className="text-sm text-muted-foreground py-6 text-center">Sem venda nos últimos {periodo} dias.</p> : (
          <>
            <div className="flex items-end gap-[2px] h-36">
              {serie.dias.map((d) => (
                <div key={d.data} className="flex-1 h-full flex flex-col justify-end min-w-0"
                  title={`${dm(d.data)} · ${formatNumber(d.unidades)} un. · ${formatBRL(d.receita)}${d.partes.map((p) => `\n${mkt(p.m).nome}: ${formatNumber(p.unidades)} un. · ${formatBRL(p.receita)}`).join("")}`}>
                  {d.partes.map((p) => (
                    <div key={p.m} style={{ height: `${serie.maior ? (p.receita / serie.maior) * 100 : 0}%`, background: mkt(p.m).cor }} className="w-full first:rounded-t-[2px]" />
                  ))}
                  {d.receita === 0 && <div className="w-full h-px bg-border" />}
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[10.5px] text-muted-foreground"><span>{dm(serie.dias[0].data)}</span><span>{dm(serie.dias[serie.dias.length - 1].data)}</span></div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {serie.porMkt.map((p) => (
                <span key={p.m} className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: mkt(p.m).cor }} />{mkt(p.m).nome}: <b>{formatNumber(p.unidades)}</b> un. · {formatBRL(p.receita)}
                </span>
              ))}
            </div>
          </>
        )}
      </CardContent></Card>

      <Card><CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-semibold">Por canal · 30 dias</h2>
          <span className="text-[11px] text-muted-foreground">margem de contribuição e ADS — até ontem</span>
        </div>
        {a.canais.length === 0 && soHistorico.length === 0 ? <p className="text-sm text-muted-foreground">Sem venda em 30 dias.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Canal</th><th className="py-1.5 px-3 font-medium text-right">Unidades</th>
                <th className="py-1.5 px-3 font-medium text-right">Receita</th><th className="py-1.5 px-3 font-medium text-right">Margem</th>
                <th className="py-1.5 px-3 font-medium text-right">ADS</th><th className="py-1.5 pl-3 font-medium text-right">Margem pós-ADS</th>
              </tr></thead>
              <tbody>
                {a.canais.map((c) => (
                  <tr key={`${c.marketplace}-${c.shop_id}`} className="border-t">
                    <td className="py-1.5 pr-3"><span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: mkt(c.marketplace).cor }} />{mkt(c.marketplace).nome} <span className="text-muted-foreground">· {c.empresa ?? ""}</span>
                      {!c.confiavel && <Badge variant="outline" className="ml-1.5 text-[9.5px] py-0 px-1" title="Parte das vendas está sem custo: a margem pode estar errada">custo incompleto</Badge>}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatNumber(n(c.unidades))}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatBRL(n(c.receita))}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatBRL(n(c.margem))} <span className="text-[11px] text-muted-foreground">{pct(n(c.margem), n(c.receita))}</span></td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{n(c.gasto_ads) > 0 ? <>{formatBRL(n(c.gasto_ads))} <span className="text-[11px] text-muted-foreground">{pct(n(c.gasto_ads), n(c.receita))}</span></> : <span className="text-muted-foreground">—</span>}</td>
                    <td className={`py-1.5 pl-3 text-right tabular-nums font-medium ${n(c.margem_pos_ads) < 0 ? "text-destructive" : ""}`}>{formatBRL(n(c.margem_pos_ads))} <span className="text-[11px] font-normal text-muted-foreground">{pct(n(c.margem_pos_ads), n(c.receita))}</span></td>
                  </tr>
                ))}
                {soHistorico.map((h) => (
                  <tr key={`${h.canal}-${h.empresa}`} className="border-t text-muted-foreground">
                    <td className="py-1.5 pr-3"><span className="inline-block h-2 w-2 rounded-sm mr-1.5" style={{ background: mkt(h.canal).cor }} /><span className="text-foreground">{mkt(h.canal).nome}</span> · {h.empresa === "svl" ? "SVL" : "Ottz"}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums text-foreground">{formatNumber(h.un30)}</td>
                    <td className="py-1.5 px-3 text-right text-[11px]">{formatNumber(h.un120)} un. em 120 dias</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{h.peso ? `${((h.mc / h.peso) * 100).toFixed(1).replace(".", ",")}%` : "—"}</td>
                    <td className="py-1.5 px-3 text-right text-[11px]">ADS não integrado</td><td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent></Card>

      {a.anuncios.length > 0 && (
        <Card><CardContent className="p-4 space-y-2">
          <h2 className="text-base font-semibold">De qual anúncio a venda saiu · 30 dias</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3 font-medium">Anúncio</th><th className="py-1.5 px-3 font-medium text-right">Unidades</th><th className="py-1.5 px-3 font-medium text-right">Receita</th>
                <th className="py-1.5 px-3 font-medium text-right">Margem</th><th className="py-1.5 px-3 font-medium text-right">ADS</th><th className="py-1.5 pl-3 font-medium text-right">Pós-ADS</th>
              </tr></thead>
              <tbody>
                {a.anuncios.map((x) => (
                  <tr key={`${x.marketplace}-${x.shop_id}-${x.anuncio_id}-${x.sku}`} className="border-t">
                    <td className="py-1.5 pr-3 max-w-[380px]">
                      <div className="truncate" title={x.titulo ?? ""}>{x.titulo ?? x.anuncio_id}</div>
                      <div className="text-[11px] text-muted-foreground">{mkt(x.marketplace).nome} · {x.empresa ?? ""} · <span className="font-mono">{x.anuncio_id}</span>{a.skus.length > 1 && <> · SKU <span className="font-mono">{x.sku}</span></>}</div>
                    </td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatNumber(n(x.unidades))}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatBRL(n(x.receita))}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{x.margem_pct != null ? `${n(x.margem_pct).toFixed(1).replace(".", ",")}%` : "—"}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{n(x.gasto_ads) > 0 ? formatBRL(n(x.gasto_ads)) : <span className="text-muted-foreground">—</span>}</td>
                    <td className={`py-1.5 pl-3 text-right tabular-nums ${SITUACAO_ADS[x.situacao ?? ""] ?? ""}`} title={x.situacao ?? ""}>
                      {formatBRL(n(x.margem_pos_ads))}{x.margem_pos_ads_pct != null && <span className="text-[11px]"> · {n(x.margem_pos_ads_pct).toFixed(1).replace(".", ",")}%</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent></Card>
      )}

      <Card><CardContent className="p-4 space-y-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-semibold">Estoque</h2>
          <span className="text-[11px] text-muted-foreground">do produto físico (no kit, o componente) — Geral do Tiny + Full</span>
        </div>
        {a.estoque.length === 0 ? <p className="text-sm text-muted-foreground">Sem produto físico ligado a este SKU.</p> : a.estoque.map((e) => {
          const geral = n(e.geral); const full = e.estoque_total != null ? n(e.full_amazon) + n(e.full_ml) + n(e.full_shopee) : n(e.full_total);
          const transito = e.estoque_total != null ? n(e.full_em_transito) : n(e.em_transito);
          const livre = Math.max(0, geral - n(e.reservado));
          return (
            <div key={e.sku} className="rounded-lg border p-3 space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs">{e.sku}</span><span className="text-sm font-medium truncate">{e.nome ?? ""}</span>
                {e.situacao && e.situacao !== "ok" && <Badge variant="outline" className="text-[10px] py-0 px-1.5">{e.situacao.replace(/_/g, " ")}</Badge>}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-x-4 gap-y-2 text-sm">
                <Dado rotulo="Geral (Tiny)" valor={e.geral == null ? "não lido" : formatNumber(geral)} sub={n(e.reservado) > 0 ? `${formatNumber(n(e.reservado))} reservados` : undefined} />
                <Dado rotulo="Full" valor={formatNumber(full)} sub={e.estoque_total != null ? `AMZ ${formatNumber(n(e.full_amazon))} · ML ${formatNumber(n(e.full_ml))} · SHP ${formatNumber(n(e.full_shopee))}` : undefined} />
                <Dado rotulo="Indo para o Full" valor={formatNumber(transito)} />
                <Dado rotulo="Custo" valor={e.custo != null ? formatBRL(n(e.custo)) : "sem custo"} />
                <Dado rotulo="Valor em estoque" valor={formatBRL(n(e.valor_estoque ?? e.valor))} />
                <Dado rotulo="Venda por dia" valor={e.venda_dia != null ? formatNumber(n(e.venda_dia), 1) : "—"} sub={e.venda_30d != null ? `${formatNumber(n(e.venda_30d))} em 30 dias (com os kits)` : undefined} />
                <Dado rotulo="Cobertura" valor={e.cobertura_total_dias != null ? `${formatNumber(n(e.cobertura_total_dias), 1)} dias` : "—"} sub={n(e.oc_aguardando) > 0 ? `${formatNumber(n(e.oc_aguardando))} chegando (compra)` : undefined} />
              </div>
              {e.usado_em.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Com o disponível no Geral ({formatNumber(livre)}) dá para montar: {e.usado_em.slice().sort((x, z) => n(x.quantidade) - n(z.quantidade)).map((k) => `${formatNumber(Math.floor(livre / Math.max(1, n(k.quantidade))))} × ${k.kit}`).join(" · ")}
                </div>
              )}
            </div>
          );
        })}
      </CardContent></Card>
    </div>
  );
}

function Kpi({ rotulo, valor, sub, alerta }: { rotulo: string; valor: string; sub?: string; alerta?: boolean }) {
  return (
    <Card><CardContent className="p-3">
      <div className="text-[11px] font-medium text-muted-foreground">{rotulo}</div>
      <div className={`text-lg font-semibold tabular-nums mt-0.5 ${alerta ? "text-destructive" : ""}`}>{valor}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </CardContent></Card>
  );
}
function Dado({ rotulo, valor, sub }: { rotulo: string; valor: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{rotulo}</div>
      <div className="tabular-nums font-medium">{valor}</div>
      {sub && <div className="text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
