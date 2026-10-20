import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, Loader2, Lightbulb, TrendingDown } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { textoOrcamento } from "@/components/ads/ShopeeAdsConfig";

// ============================================================================
// Análise de ADS por anúncio (20/out/2026, pedido do dono). Tudo vem da RPC `ads_analise_anuncio`
// (as regras do diagnóstico ficam no banco): série diária com investimento, receita, ROAS e a meta/orçamento
// VIGENTES no dia (histórico capturado a cada 2 h — a Shopee não informa a meta de dias passados), margem do
// anúncio, ROAS de equilíbrio, efeito de cada mudança de meta/orçamento e o diagnóstico.
// Mercado Livre (20/out): prop `ml` → RPC `ads_analise_anuncio_ml` (anúncio MLB ou campanha inteira), mesmo formato.
// No ML a meta/orçamento de antes de 20/10 vêm do registro diário da campanha (aproximado: "≈").
// ============================================================================

interface Dia {
  data: string; gasto: number; receita: number; pedidos: number; impressoes: number; cliques: number;
  roas: number | null; meta: number | null; meta_conhecida: boolean; meta_aproximada?: boolean; orcamento: number | null; orcamento_aproximado: boolean;
  uso_orcamento: number | null; venda_total: number | null; margem: number | null; margem_pos_ads: number | null;
}
interface Bloco { gasto: number; receita: number; pedidos: number; roas: number | null; dias?: number }
interface Analise {
  ok: boolean; erro?: string; nome: string | null; item_id: string | null;
  config: { roas_target: number | null; budget: number | null; status: string | null; bidding_method: string | null; primeira_vez: string } | null;
  margem: { mc_pct: number | null; confiavel: boolean | null; roas_equilibrio: number | null; meta_minima: number | null };
  resumo: { u7: Bloco & { dias_gasto: number; dias_orcamento_esgotado: number }; a7: Bloco };
  dias: Dia[];
  mudancas: { campo: string; de: string | null; para: string | null; quando: string; origem: string; quem: string | null; aproximada?: boolean; antes: Bloco; depois: Bloco }[];
  skus?: string[] | null;
  diagnostico: { tom: "ruim" | "atencao" | "oportunidade" | "info"; titulo: string; texto: string; acao: string | null }[];
}

const x = (v: number | null | undefined, casas = 2) => (v == null ? "—" : `${Number(v).toFixed(casas).replace(".", ",")}x`);
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const varPct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
const CAMPO: Record<string, string> = { roas_target: "Meta de ROAS", budget: "Orçamento", status: "Status", bidding_method: "Lance" };
const TOM: Record<string, { cls: string; icone: typeof Info }> = {
  ruim: { cls: "border-red-500/40 bg-red-500/5 text-red-800 dark:text-red-300", icone: AlertTriangle },
  atencao: { cls: "border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300", icone: TrendingDown },
  oportunidade: { cls: "border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300", icone: Lightbulb },
  info: { cls: "border-border bg-muted/30 text-muted-foreground", icone: Info },
};

export function AnaliseAnuncioAds({ shopId, campaignId, nome, onFechar, ml }: {
  shopId?: number | string; campaignId: number | string; nome: string; onFechar: () => void;
  /** Mercado Livre: anúncio (MLB) ou, sem item, a campanha inteira */
  ml?: { item?: string | null };
}) {
  const ehMl = !!ml;
  const q = useQuery({
    queryKey: ["ads-analise", ehMl ? "ml" : "shopee", String(shopId ?? ""), String(campaignId), ml?.item ?? ""],
    staleTime: 5 * 60_000, placeholderData: undefined,
    queryFn: async (): Promise<Analise> => {
      const { data, error } = ehMl
        ? await supabaseExternal.rpc("ads_analise_anuncio_ml", { p_item: ml?.item ?? null, p_campaign: String(campaignId), p_dias: 30 })
        : await supabaseExternal.rpc("ads_analise_anuncio", { p_shop: Number(shopId), p_campaign: String(campaignId), p_dias: 30 });
      if (error) throw error;
      return data as Analise;
    },
  });
  const MK = ehMl ? "Mercado Livre" : "Shopee";
  const a = q.data;
  const u7 = a?.resumo.u7; const a7 = a?.resumo.a7;
  const eq = a?.margem.roas_equilibrio ?? null;
  const serie = (a?.dias ?? []).map((d) => ({ ...d, rotulo: dm(d.data) }));
  const tabela = [...(a?.dias ?? [])].reverse().filter((d) => d.gasto > 0 || d.receita > 0 || d.meta != null);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6 leading-snug">{ehMl && !ml?.item ? "Análise da campanha" : "Análise do anúncio"} · {MK}</DialogTitle>
          <DialogDescription className="line-clamp-2">
            {a?.nome ?? nome}{a?.item_id ? ` · ${ehMl ? "" : "item "}${a.item_id}` : ""}{a?.skus?.length ? ` · SKU ${a.skus.join(", ")}` : ""} · campanha {String(campaignId)}
          </DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <div className="py-16 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Calculando…</div>
        ) : q.isError || !a?.ok ? (
          <div className="text-sm text-destructive">Não consegui analisar: {(q.error as Error)?.message ?? a?.erro}</div>
        ) : (
          <div className="space-y-4">
            {/* resumo */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Bloco titulo="Investimento 7 dias" valor={formatBRL(u7!.gasto)} sub={comparacao(u7!.gasto, a7!.gasto, true)} />
              <Bloco titulo="Receita do ADS 7 dias" valor={formatBRL(u7!.receita)} sub={comparacao(u7!.receita, a7!.receita)} />
              <Bloco titulo="ROAS 7 dias" valor={x(u7!.roas)} sub={a7!.roas != null ? `antes ${x(a7!.roas)}` : ""} />
              <Bloco titulo={ehMl ? "ROAS objetivo hoje (campanha)" : "Meta de ROAS hoje"} valor={a.config?.roas_target != null ? x(a.config.roas_target, 1) : "—"}
                sub={`orçamento ${textoOrcamento(a.config?.budget)}`} />
              <Bloco titulo="ROAS de equilíbrio" valor={eq != null ? x(eq) : "—"}
                sub={a.margem.mc_pct != null ? `margem sem ADS ${String(a.margem.mc_pct).replace(".", ",")}%${a.margem.meta_minima != null ? ` · meta mín. ${x(a.margem.meta_minima, 1)}` : ""}` : "sem margem calculada"} />
            </div>

            {/* diagnóstico */}
            <div className="space-y-1.5">
              {a.diagnostico.map((d, i) => {
                const t = TOM[d.tom] ?? TOM.info; const Ic = t.icone;
                return (
                  <div key={i} className={`rounded-md border p-2.5 text-sm ${t.cls}`}>
                    <div className="flex items-center gap-1.5 font-medium"><Ic className="h-4 w-4 shrink-0" />{d.titulo}</div>
                    <div className="text-xs mt-0.5 text-foreground/80">{d.texto}</div>
                    {d.acao && <div className="text-xs mt-1 font-medium">→ {d.acao}</div>}
                  </div>
                );
              })}
              {a.diagnostico.length === 0 && <div className="text-xs text-muted-foreground">Nada fora do normal nos últimos 7 dias.</div>}
            </div>

            {/* gráfico */}
            <div className="h-64 rounded-md border p-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={serie} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="rotulo" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="r" tick={{ fontSize: 10 }} width={56} tickFormatter={(v) => `R$${Math.round(v)}`} />
                  <YAxis yAxisId="x" orientation="right" tick={{ fontSize: 10 }} width={36} tickFormatter={(v) => `${v}x`} />
                  <Tooltip formatter={(v, n) => (n === "Investimento" || n === "Receita" ? formatBRL(Number(v)) : x(Number(v)))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="r" dataKey="gasto" name="Investimento" fill="#7C5CD6" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="r" dataKey="receita" name="Receita" stroke="#0E8A5F" dot={false} strokeWidth={1.5} />
                  <Line yAxisId="x" dataKey="roas" name="ROAS" stroke="#D97706" dot={{ r: 2 }} strokeWidth={2} connectNulls />
                  <Line yAxisId="x" dataKey="meta" name="Meta de ROAS" stroke="#2563EB" strokeDasharray="5 4" dot={false} type="stepAfter" connectNulls={false} />
                  {eq != null && <ReferenceLine yAxisId="x" y={eq} stroke="#C9432F" strokeDasharray="2 3" label={{ value: `equilíbrio ${x(eq, 1)}`, fontSize: 10, fill: "#C9432F", position: "insideTopLeft" }} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* mudanças */}
            <div>
              <div className="text-sm font-medium mb-1">Alterações de meta e orçamento</div>
              {a.mudancas.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  Nenhuma alteração registrada. O registro começou em {a.config?.primeira_vez ? new Date(a.config.primeira_vez).toLocaleDateString("pt-BR") : "20/10/2026"} (o {MK} não informa alterações passadas).
                </div>
              ) : (
                <div className="space-y-1">
                  {a.mudancas.map((m, i) => (
                    <div key={i} className="text-xs rounded border px-2 py-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className="font-medium">{new Date(m.quando).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      <span>{CAMPO[m.campo] ?? m.campo}: {fmtCampo(m.campo, m.de)} → <b>{fmtCampo(m.campo, m.para)}</b></span>
                      <span className="text-muted-foreground">{m.origem === "app" ? `pelo sistema${m.quem ? ` (${m.quem})` : ""}`
                        : m.aproximada ? "registro diário (data aproximada, pode estar adiantada até ~8 dias)"
                        : `no painel ${ehMl ? "do Mercado Ads" : "da Shopee"} ou automático`}</span>
                      {(m.campo === "roas_target" || m.campo === "budget") && (
                        <span className="text-muted-foreground">7 dias antes: ROAS {x(m.antes?.roas)} · {formatBRL(m.antes?.gasto ?? 0)} → depois ({m.depois?.dias ?? 0} d): ROAS {x(m.depois?.roas)} · {formatBRL(m.depois?.gasto ?? 0)}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* por dia */}
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium">Dia</th>
                    <th className="text-right px-2 py-1.5 font-medium">Investimento</th>
                    <th className="text-right px-2 py-1.5 font-medium">Receita ADS</th>
                    <th className="text-right px-2 py-1.5 font-medium">Pedidos</th>
                    <th className="text-right px-2 py-1.5 font-medium">ROAS</th>
                    <th className="text-right px-2 py-1.5 font-medium">Meta</th>
                    <th className="text-right px-2 py-1.5 font-medium">Orçamento</th>
                    <th className="text-right px-2 py-1.5 font-medium" title={ehMl
                      ? "Venda total do SKU no Mercado Livre (todos os anúncios, com e sem ADS) e a margem dele menos o ADS desta linha"
                      : "Venda total do anúncio (todas as campanhas e orgânico) e margem depois do ADS"}>{ehMl ? "Venda do SKU · margem − ADS" : "Venda · margem pós-ADS"}</th>
                  </tr>
                </thead>
                <tbody>
                  {tabela.map((d) => {
                    const abaixoEq = d.roas != null && eq != null && d.roas < eq;
                    return (
                      <tr key={d.data} className="border-t">
                        <td className="px-2 py-1">{dm(d.data)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{formatBRL(d.gasto)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{formatBRL(d.receita)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{d.pedidos}</td>
                        <td className={`px-2 py-1 text-right tabular-nums font-medium ${abaixoEq ? "text-red-700" : d.meta != null && d.roas != null && d.roas < d.meta ? "text-amber-700" : ""}`}>{x(d.roas)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground" title={d.meta_aproximada ? "do registro diário da campanha (aproximado)" : ""}>
                          {d.meta != null ? <>{d.meta_aproximada ? "≈" : ""}{x(d.meta, 1)}</> : <span title="O marketplace não informa a meta de dias passados; o registro começou em 20/10/2026">sem registro</span>}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground" title={d.orcamento_aproximado ? "valor registrado pelo sync do dia (aproximado)" : ""}>
                          {textoOrcamento(d.orcamento)}{d.uso_orcamento != null ? ` · ${d.uso_orcamento}%` : ""}{d.orcamento_aproximado ? "*" : ""}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">
                          {d.venda_total != null ? <>{formatBRL(d.venda_total)} · <span className={Number(d.margem_pos_ads) < 0 ? "text-red-700" : ""}>{formatBRL(Number(d.margem_pos_ads ?? 0))}</span></> : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {ehMl
                ? <>Receita e ROAS = vendas atribuídas ao ADS pelo Mercado Livre (diretas + indiretas). Os últimos ~8 dias ainda podem mudar (o ML reatribui vendas).
                    A margem é do SKU (o ML não liga a venda ao anúncio): a venda e a margem da tabela são de todas as vendas do SKU no ML.
                    ROAS de equilíbrio = 100 ÷ margem de contribuição sem ADS do SKU (30 dias). Meta e orçamento com ≈ / * = registro diário da campanha (aproximado). O ROAS objetivo e o orçamento só mudam no painel do Mercado Ads (a API do ML recusa a escrita).</>
                : <>Receita e ROAS = vendas atribuídas ao ADS pela Shopee. Os últimos ~4 dias ainda podem mudar (a Shopee reatribui vendas).
                    ROAS de equilíbrio = 100 ÷ margem de contribuição sem ADS (30 dias): abaixo dele o ADS custa mais do que a margem paga.
                    Orçamento com * = valor registrado no dia pelo sync (aproximado). Meta de dias antes de 20/10/2026: sem registro (a Shopee não informa).</>}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function fmtCampo(campo: string, v: string | null) {
  if (v == null || v === "") return "—";
  if (campo === "roas_target") return x(Number(v), 1);
  if (campo === "budget") return textoOrcamento(Number(v));
  return v;
}

function comparacao(atual: number, antes: number, inverso = false) {
  const p = varPct(atual, antes);
  if (p == null) return "";
  const cor = p === 0 ? "" : (p > 0) !== inverso ? "text-emerald-700" : "text-red-700";
  return <span className={cor}>{p > 0 ? "+" : ""}{p}% vs 7 dias antes</span>;
}

function Bloco({ titulo, valor, sub }: { titulo: string; valor: string; sub?: ReactNode }) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="text-[11px] text-muted-foreground">{titulo}</div>
      <div className="text-lg font-semibold tabular-nums">{valor}</div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
