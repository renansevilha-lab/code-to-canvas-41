import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw, Search, AlertTriangle, ExternalLink, X, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

// ============================================================================
// Central de Promoções — Mercado Livre (com Margem de Contribuição).
// Espelha as promoções do vendedor (SMART/DEAL/LIGHTNING) e mostra a MC que
// teríamos ao aplicar cada uma, no preço promocional. Fonte: view_ml_promocoes
// (MC no banco: recebido − CMV − imposto, comissão exata via listing_prices,
// co-financiamento do ML). Aplicar/remover escreve no ML (edge fn ml-promocoes),
// sempre com confirmação forte por item. Sync por cron (jobid 73).
// ============================================================================

interface PromoItem {
  promocao_id: string; mlb: string; sku: string | null; status: string;
  offer_id: string | null; original_price: number | null; promo_price: number | null;
  preco_min: number | null; preco_max: number | null; preco_sugerido: number | null;
  seller_percentage: number | null; meli_percentage: number | null;
  comissao_promo: number | null; frete: number | null; frete_estimado: boolean;
  cmv: number | null; imposto_promo: number | null; desconto_pct: number | null;
  promocao_nome: string | null; promocao_tipo: string | null; promocao_status: string | null;
  finish_date: string | null; titulo: string | null; foto: string | null; permalink: string | null;
  mc_atual: number | null; mc_promo: number | null; mc_promo_pct: number | null; mc_atual_pct: number | null;
  delta_mc: number | null; mc_negativa: boolean;
}
interface Promo {
  promocao_id: string; tipo: string; nome: string | null; status: string;
  finish_date: string | null; n_itens: number;
}

const num = (x: unknown): number => { const n = Number(x ?? 0); return Number.isFinite(n) ? n : 0; };
const pct = (x: number | null): string => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

// Cor por tipo de promoção (claro/escuro via tokens de acento fixos).
const TIPO: Record<string, { bg: string; fg: string; nome: string }> = {
  SMART: { bg: "#2F6FB0", fg: "#fff", nome: "Smart" },
  DEAL: { bg: "#6E56CF", fg: "#fff", nome: "Oferta" },
  LIGHTNING: { bg: "#E8791A", fg: "#fff", nome: "Relâmpago" },
  DOD: { bg: "#C9432F", fg: "#fff", nome: "Oferta do dia" },
};
const tipoInfo = (t: string | null) => TIPO[(t ?? "").toUpperCase()] ?? { bg: "#64748B", fg: "#fff", nome: t ?? "—" };

function iniciais(nome: string | null): string {
  return (nome ?? "?").split(" ").filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}
function Foto({ url, nome }: { url: string | null; nome: string | null }) {
  const [erro, setErro] = useState(false);
  return (
    <div className="w-11 h-11 rounded-lg shrink-0 overflow-hidden flex items-center justify-center bg-muted text-muted-foreground">
      {url && !erro ? (
        <img src={url} alt={nome ?? ""} loading="lazy" className="w-full h-full object-cover" onError={() => setErro(true)} />
      ) : (
        <span className="text-xs font-bold">{iniciais(nome)}</span>
      )}
    </div>
  );
}

function PromocoesMLPage() {
  const qc = useQueryClient();
  const [promoSel, setPromoSel] = useState<string>("todas");
  const [statusFiltro, setStatusFiltro] = useState<"todas" | "started" | "candidate">("todas");
  const [soPrejuizo, setSoPrejuizo] = useState(false);
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState<"delta" | "mc_promo" | "desconto">("delta");
  const [sincronizando, setSincronizando] = useState(false);
  const [confirmar, setConfirmar] = useState<{ item: PromoItem; acao: "aplicar" | "remover" } | null>(null);
  const [executando, setExecutando] = useState(false);
  // Seletor de preço (promoções com faixa min↔max): simula a MC no preço escolhido.
  const [simPreco, setSimPreco] = useState<number | null>(null);
  const [simResult, setSimResult] = useState<{ mc: number | null; mc_pct: number | null } | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  useEffect(() => {
    if (confirmar?.acao === "aplicar") { setSimPreco(confirmar.item.promo_price ?? null); setSimResult(null); }
  }, [confirmar]);

  useEffect(() => {
    if (!confirmar || confirmar.acao !== "aplicar" || simPreco == null) return;
    if (simPreco === confirmar.item.promo_price) { setSimResult(null); return; } // usa a MC já calculada
    const t = setTimeout(async () => {
      setSimLoading(true);
      try {
        const p = new URLSearchParams({ modulo: "simular", mlb: confirmar.item.mlb, promocao_id: confirmar.item.promocao_id, preco: String(simPreco) });
        const r = await fetch(`${EXTERNAL_URL}/functions/v1/ml-promocoes?${p.toString()}`, { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } });
        const d = await r.json();
        setSimResult({ mc: d.mc ?? null, mc_pct: d.mc_pct ?? null });
      } catch { setSimResult(null); } finally { setSimLoading(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [simPreco, confirmar]);

  const promosQ = useQuery({
    queryKey: ["promocoes-ml", "promos"],
    queryFn: async (): Promise<Promo[]> => {
      const { data, error } = await supabaseExternal.from("ml_promocoes")
        .select("promocao_id, tipo, nome, status, finish_date, n_itens").order("n_itens", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Promo[];
    },
    staleTime: 5 * 60_000, refetchOnWindowFocus: false,
  });

  const itensQ = useQuery({
    queryKey: ["promocoes-ml", "itens"],
    queryFn: async (): Promise<PromoItem[]> => {
      const { data, error } = await supabaseExternal.from("view_ml_promocoes")
        .select("promocao_id, mlb, sku, status, offer_id, original_price, promo_price, preco_min, preco_max, preco_sugerido, seller_percentage, meli_percentage, comissao_promo, frete, frete_estimado, cmv, imposto_promo, desconto_pct, promocao_nome, promocao_tipo, promocao_status, finish_date, titulo, foto, permalink, mc_atual, mc_promo, mc_promo_pct, mc_atual_pct, delta_mc, mc_negativa");
      if (error) throw error;
      return (data ?? []) as PromoItem[];
    },
    staleTime: 5 * 60_000, refetchOnWindowFocus: false,
  });

  const promos = promosQ.data ?? [];
  const itens = itensQ.data ?? [];

  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase();
    let arr = itens.filter((i) => {
      if (promoSel !== "todas" && i.promocao_id !== promoSel) return false;
      if (statusFiltro !== "todas" && i.status !== statusFiltro) return false;
      if (soPrejuizo && !i.mc_negativa) return false;
      if (b && !(`${i.sku ?? ""} ${i.mlb} ${i.titulo ?? ""}`.toLowerCase().includes(b))) return false;
      return true;
    });
    arr = arr.sort((a, z) => {
      if (ordem === "delta") return num(a.delta_mc) - num(z.delta_mc); // mais negativo primeiro
      if (ordem === "mc_promo") return num(a.mc_promo) - num(z.mc_promo);
      return num(z.desconto_pct) - num(a.desconto_pct);
    });
    return arr;
  }, [itens, promoSel, statusFiltro, soPrejuizo, busca, ordem]);

  const resumo = useMemo(() => {
    const comMc = filtrados.filter((i) => i.mc_promo != null);
    const neg = comMc.filter((i) => i.mc_negativa).length;
    const mcMedia = comMc.length ? comMc.reduce((s, i) => s + num(i.mc_promo), 0) / comMc.length : null;
    return { total: filtrados.length, comMc: comMc.length, neg, mcMedia };
  }, [filtrados]);

  async function sincronizar() {
    if (sincronizando) return;
    setSincronizando(true);
    try {
      const r = await fetch(`${EXTERNAL_URL}/functions/v1/ml-promocoes?modulo=sync`, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.erro) throw new Error(d.erro ?? `HTTP ${r.status}`);
      toast.success(`Sincronizado: ${d.gravados ?? 0} itens atualizados`);
      await qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) {
      toast.error("Falha ao sincronizar", { description: (e as Error).message });
    } finally {
      setSincronizando(false);
    }
  }

  async function executar() {
    if (!confirmar || executando) return;
    const { item, acao } = confirmar;
    setExecutando(true);
    try {
      const p = new URLSearchParams({ modulo: acao, mlb: item.mlb, promocao_id: item.promocao_id, tipo: item.promocao_tipo ?? "", confirmar: "1" });
      if (acao === "aplicar") {
        if (item.offer_id) p.set("offer_id", item.offer_id);
        else { const dp = simPreco ?? item.promo_price; if (dp != null) p.set("deal_price", String(dp)); }
      }
      const r = await fetch(`${EXTERNAL_URL}/functions/v1/ml-promocoes?${p.toString()}`, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.erro || (d.status && d.status >= 400)) {
        throw new Error(d.erro ?? (d.body ? JSON.stringify(d.body).slice(0, 160) : `HTTP ${r.status}`));
      }
      toast.success(acao === "aplicar" ? `Promoção aplicada em ${item.mlb}` : `Promoção removida de ${item.mlb}`);
      setConfirmar(null);
      await qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) {
      toast.error(`Falha ao ${confirmar.acao}`, { description: (e as Error).message });
    } finally {
      setExecutando(false);
    }
  }

  const carregando = promosQ.isLoading || itensQ.isLoading;

  return (
    <div className="flex flex-col gap-5 p-1">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" /> Central de Promoções — Mercado Livre
          </h1>
          <p className="text-sm text-muted-foreground">
            Margem de contribuição que teríamos ao aplicar cada promoção, no preço promocional.
          </p>
        </div>
        <Button variant="outline" onClick={() => void sincronizar()} disabled={sincronizando}>
          {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Sincronizar
        </Button>
      </div>

      {/* Chips de promoção */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setPromoSel("todas")}
          className={cn("px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors",
            promoSel === "todas" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border hover:bg-muted")}
        >
          Todas ({itens.length})
        </button>
        {promos.map((p) => {
          const ti = tipoInfo(p.tipo);
          const ativo = promoSel === p.promocao_id;
          return (
            <button
              key={p.promocao_id}
              onClick={() => setPromoSel(p.promocao_id)}
              className={cn("px-3 py-1.5 rounded-full text-sm font-medium border transition-colors flex items-center gap-2",
                ativo ? "border-primary ring-1 ring-primary" : "border-border hover:bg-muted")}
              title={`${p.tipo} · ${p.status}`}
            >
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: ti.bg, color: ti.fg }}>{ti.nome}</span>
              <span className="truncate max-w-[160px]">{p.nome ?? p.promocao_id}</span>
              <span className="text-xs text-muted-foreground">{p.n_itens}</span>
              {p.status === "pending" && <span className="text-[10px] text-amber-600 font-semibold">agendada</span>}
            </button>
          );
        })}
      </div>

      {/* Filtros + resumo */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="SKU, MLB ou produto" className="pl-8 w-56" />
        </div>
        <select value={statusFiltro} onChange={(e) => setStatusFiltro(e.target.value as typeof statusFiltro)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="todas">Todos os status</option>
          <option value="started">Aplicadas</option>
          <option value="candidate">Candidatas</option>
        </select>
        <select value={ordem} onChange={(e) => setOrdem(e.target.value as typeof ordem)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm">
          <option value="delta">Ordenar: maior queda de MC</option>
          <option value="mc_promo">Ordenar: menor MC na promo</option>
          <option value="desconto">Ordenar: maior desconto</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={soPrejuizo} onChange={(e) => setSoPrejuizo(e.target.checked)} className="accent-red-600" />
          Só com prejuízo
        </label>
        <div className="ml-auto text-sm text-muted-foreground flex items-center gap-3">
          <span><strong className="text-foreground">{resumo.total}</strong> itens</span>
          {resumo.neg > 0 && <span className="text-red-600 font-semibold flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />{resumo.neg} no prejuízo</span>}
          {resumo.mcMedia != null && <span>MC média promo: <strong className={cn(resumo.mcMedia < 0 ? "text-red-600" : "text-emerald-600")}>{formatBRL(resumo.mcMedia)}</strong></span>}
        </div>
      </div>

      {carregando ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando promoções…</div>
      ) : filtrados.length === 0 ? (
        <Card className="border-dashed py-16 flex flex-col items-center gap-2 text-center">
          <Zap className="h-8 w-8 text-muted-foreground" />
          <span className="font-bold">Nenhum item nesse filtro</span>
          <span className="text-sm text-muted-foreground">Ajuste os filtros ou clique em Sincronizar para puxar as promoções do ML.</span>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-muted/60 text-muted-foreground text-xs">
                <th className="text-left font-semibold px-3 py-2.5">Produto</th>
                <th className="text-left font-semibold px-2 py-2.5">Status</th>
                <th className="text-right font-semibold px-2 py-2.5">Preço → promo</th>
                <th className="text-right font-semibold px-2 py-2.5">MC atual</th>
                <th className="text-right font-semibold px-2 py-2.5">MC% atual</th>
                <th className="text-right font-semibold px-2 py-2.5">MC na promo</th>
                <th className="text-right font-semibold px-2 py-2.5">MC% promo</th>
                <th className="text-right font-semibold px-2 py-2.5">Δ MC</th>
                <th className="text-right font-semibold px-3 py-2.5">Ação</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((i) => {
                const ti = tipoInfo(i.promocao_tipo);
                const mcNull = i.mc_promo == null;
                return (
                  <tr key={`${i.promocao_id}|${i.mlb}`} className={cn("border-t border-border hover:bg-muted/30", i.mc_negativa && "bg-red-500/5")}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Foto url={i.foto} nome={i.titulo} />
                        <div className="flex flex-col min-w-0">
                          <span className="font-medium leading-tight line-clamp-1">{i.titulo ?? "—"}</span>
                          <span className="text-[11px] text-muted-foreground font-mono flex items-center gap-1.5">
                            SKU {i.sku ?? "—"} · {i.mlb}
                            {i.permalink && <a href={i.permalink} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex"><ExternalLink className="h-3 w-3" /></a>}
                          </span>
                          <span className="text-[10px]"><span className="px-1 py-0.5 rounded font-bold" style={{ background: ti.bg, color: ti.fg }}>{ti.nome}</span></span>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      {i.status === "started" ? (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600">Aplicada</span>
                      ) : (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Candidata</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                      <span className="text-muted-foreground line-through">{formatBRL(num(i.original_price))}</span>
                      <span className="mx-1">→</span>
                      <span className="font-semibold">{formatBRL(num(i.promo_price))}</span>
                      <div className="text-[10px] text-red-600 font-semibold">−{num(i.desconto_pct).toFixed(0)}%</div>
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{i.mc_atual == null ? "—" : formatBRL(num(i.mc_atual))}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {i.mc_atual_pct == null ? <span className="text-muted-foreground">—</span> :
                        <span className={cn("font-semibold", num(i.mc_atual_pct) < 0 ? "text-red-600" : "text-muted-foreground")}>{pct(i.mc_atual_pct)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {mcNull ? <span className="text-muted-foreground">sem CMV</span> : (
                        <div className="flex flex-col items-end">
                          <span className={cn("font-bold", i.mc_negativa ? "text-red-600" : "text-emerald-600")}>{formatBRL(num(i.mc_promo))}</span>
                          {i.frete_estimado && <span className="text-[10px] text-amber-600">s/ frete</span>}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {i.mc_promo_pct == null ? <span className="text-muted-foreground">—</span> :
                        <span className={cn("font-bold", num(i.mc_promo_pct) < 0 ? "text-red-600" : "text-emerald-600")}>{pct(i.mc_promo_pct)}</span>}
                    </td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">
                      {i.delta_mc == null ? "—" : (
                        <span className={cn("inline-flex items-center gap-0.5 font-semibold", num(i.delta_mc) < 0 ? "text-red-600" : "text-emerald-600")}>
                          {num(i.delta_mc) < 0 ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
                          {formatBRL(num(i.delta_mc))}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {i.status === "started" ? (
                        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-red-600" onClick={() => setConfirmar({ item: i, acao: "remover" })}>Remover</Button>
                      ) : (
                        <Button size="sm" variant={i.mc_negativa ? "outline" : "default"} onClick={() => setConfirmar({ item: i, acao: "aplicar" })}>Aplicar</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal de confirmação (ação escreve no ML — muda o preço público) */}
      {confirmar && (() => {
        const item = confirmar.item;
        const ehAplicar = confirmar.acao === "aplicar";
        const ajustavel = ehAplicar && item.preco_min != null && item.preco_max != null && !item.offer_id;
        const usandoSim = ajustavel && simResult != null && simPreco != null && simPreco !== item.promo_price;
        const precoShow = simPreco ?? item.promo_price;
        const mcShow = usandoSim ? simResult!.mc : item.mc_promo;
        const mcPctShow = usandoSim ? simResult!.mc_pct : item.mc_promo_pct;
        const neg = mcShow != null && mcShow < 0;
        const descShow = item.original_price && precoShow ? 100 * (1 - num(precoShow) / num(item.original_price)) : null;
        return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !executando && setConfirmar(null)}>
          <Card className="max-w-md w-full p-5 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-bold">{ehAplicar ? "Aplicar promoção" : "Remover promoção"}</h2>
              <button onClick={() => !executando && setConfirmar(null)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex items-center gap-3">
              <Foto url={item.foto} nome={item.titulo} />
              <div className="min-w-0">
                <div className="font-medium line-clamp-2 leading-tight">{item.titulo ?? "—"}</div>
                <div className="text-[11px] text-muted-foreground font-mono">SKU {item.sku ?? "—"} · {item.mlb}</div>
              </div>
            </div>
            {ehAplicar ? (
              <>
                {ajustavel && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">Preço da promoção — você escolhe (entre {formatBRL(num(item.preco_min))} e {formatBRL(num(item.preco_max))})</span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Input type="number" step="0.01" min={item.preco_min ?? undefined} max={item.preco_max ?? undefined}
                        value={simPreco ?? ""} onChange={(e) => { const v = Number(e.target.value); setSimPreco(Number.isFinite(v) && v > 0 ? v : null); }}
                        className="w-28 font-mono" />
                      {item.preco_sugerido != null && <button className="text-xs px-2 py-1 rounded border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_sugerido)}>Sugerido</button>}
                      <button className="text-xs px-2 py-1 rounded border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_min)}>Mín</button>
                      <button className="text-xs px-2 py-1 rounded border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_max)}>Máx</button>
                    </div>
                  </div>
                )}
                <div className="text-sm bg-muted/60 rounded-lg p-3 flex flex-col gap-1.5">
                  <div className="flex justify-between"><span className="text-muted-foreground">Preço público</span>
                    <span className="font-mono">{formatBRL(num(item.original_price))} → <strong>{formatBRL(num(precoShow))}</strong>{descShow != null && <span className="text-red-600"> (−{descShow.toFixed(0)}%)</span>}</span></div>
                  <div className="flex justify-between items-center"><span className="text-muted-foreground">Margem de contribuição</span>
                    <span className="font-mono flex items-center gap-1">{formatBRL(num(item.mc_atual))} → <strong className={cn(neg ? "text-red-600" : "text-emerald-600")}>{mcShow == null ? "—" : formatBRL(mcShow)}</strong>{mcPctShow != null && <span className="text-muted-foreground">({pct(mcPctShow)})</span>}{simLoading && <Loader2 className="h-3 w-3 animate-spin" />}</span></div>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">O item volta ao preço cheio ({formatBRL(num(item.original_price))}) e sai desta promoção.</p>
            )}
            {ehAplicar && neg && (
              <div className="text-sm bg-red-500/10 text-red-600 rounded-lg p-3 flex items-start gap-2 font-medium">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                Atenção: com este preço a margem fica <strong>negativa</strong> ({mcShow == null ? "—" : formatBRL(mcShow)}). Você venderia no prejuízo.
              </div>
            )}
            <p className="text-xs text-muted-foreground">Esta ação altera o preço público do anúncio no Mercado Livre imediatamente.</p>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setConfirmar(null)} disabled={executando}>Cancelar</Button>
              <Button variant={ehAplicar && neg ? "destructive" : "default"} onClick={() => void executar()} disabled={executando || simLoading}>
                {executando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {ehAplicar ? "Confirmar e aplicar" : "Confirmar remoção"}
              </Button>
            </div>
          </Card>
        </div>
        );
      })()}
    </div>
  );
}

export const Route = createFileRoute("/promocoes-ml")({
  component: PromocoesMLPage,
});
