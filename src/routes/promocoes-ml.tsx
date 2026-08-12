import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw, Search, AlertTriangle, ExternalLink, X, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";

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
// com confirmação forte e seletor de preço na faixa. Sync por cron (jobid 73).
// Layout re-skinado do Claude Design "Central de Promoções - Mercado Livre.dc.html".
// ============================================================================

interface PromoItem {
  promocao_id: string; mlb: string; sku: string | null; status: string;
  offer_id: string | null; original_price: number | null; promo_price: number | null;
  preco_min: number | null; preco_max: number | null; preco_sugerido: number | null;
  seller_percentage: number | null; meli_percentage: number | null;
  comissao_promo: number | null; frete: number | null; frete_estimado: boolean;
  logistic_type: string | null; free_shipping: boolean | null; sold_quantity: number | null; date_created: string | null;
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

// Cores semânticas (do design) — separadas do acento; funcionam em claro/escuro.
const GREEN = "#0E8A5F", RED = "#C9432F", AMBER = "#B7791F";
const TIPO: Record<string, { nome: string; cor: string }> = {
  SMART: { nome: "Smart", cor: "#2F6FB0" },
  DEAL: { nome: "Oferta", cor: "#7A5CC7" },
  LIGHTNING: { nome: "Relâmpago", cor: "#DB6B1F" },
  DOD: { nome: "Oferta do dia", cor: "#C9432F" },
};
const tipoInfo = (t: string | null) => TIPO[(t ?? "").toUpperCase()] ?? { nome: t ?? "—", cor: "#64748B" };

function iniciais(nome: string | null): string {
  return (nome ?? "?").split(" ").filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}
function Foto({ url, nome, size = 54 }: { url: string | null; nome: string | null; size?: number }) {
  const [erro, setErro] = useState(false);
  return (
    <div className="rounded-[10px] shrink-0 overflow-hidden flex items-center justify-center bg-muted text-muted-foreground" style={{ width: size, height: size }}>
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
  const [soFull, setSoFull] = useState(false);
  const [busca, setBusca] = useState("");
  const [ordem, setOrdem] = useState<"delta" | "mc_promo" | "desconto" | "vendas" | "recentes">("delta");
  const [sincronizando, setSincronizando] = useState(false);
  const [buscandoElegiveis, setBuscandoElegiveis] = useState(false);
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
        .select("promocao_id, mlb, sku, status, offer_id, original_price, promo_price, preco_min, preco_max, preco_sugerido, seller_percentage, meli_percentage, comissao_promo, frete, frete_estimado, logistic_type, free_shipping, sold_quantity, date_created, cmv, imposto_promo, desconto_pct, promocao_nome, promocao_tipo, promocao_status, finish_date, titulo, foto, permalink, mc_atual, mc_promo, mc_promo_pct, mc_atual_pct, delta_mc, mc_negativa");
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
      if (soFull && i.logistic_type !== "fulfillment") return false;
      if (b && !(`${i.sku ?? ""} ${i.mlb} ${i.titulo ?? ""}`.toLowerCase().includes(b))) return false;
      return true;
    });
    arr = arr.sort((a, z) => {
      if (ordem === "mc_promo") return num(a.mc_promo) - num(z.mc_promo);
      if (ordem === "desconto") return num(z.desconto_pct) - num(a.desconto_pct);
      if (ordem === "vendas") return num(z.sold_quantity) - num(a.sold_quantity);
      if (ordem === "recentes") return (z.date_created ?? "").localeCompare(a.date_created ?? "");
      return num(a.delta_mc) - num(z.delta_mc); // delta: mais negativo primeiro
    });
    return arr;
  }, [itens, promoSel, statusFiltro, soPrejuizo, soFull, busca, ordem]);

  const resumo = useMemo(() => {
    const comMc = filtrados.filter((i) => i.mc_promo != null);
    const neg = comMc.filter((i) => i.mc_negativa).length;
    const mcMedia = comMc.length ? comMc.reduce((s, i) => s + num(i.mc_promo), 0) / comMc.length : null;
    return { total: filtrados.length, comMc: comMc.length, neg, mcMedia };
  }, [filtrados]);

  const limparFiltros = () => { setPromoSel("todas"); setStatusFiltro("todas"); setSoPrejuizo(false); setSoFull(false); setBusca(""); };

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

  // Puxa TODAS as promoções elegíveis do item buscado (item-promos) — inclui as que
  // o ML não colocou no listing curado da campanha. Aceita MLB ou SKU na busca.
  async function buscarElegiveis() {
    const termo = busca.trim();
    if (!termo) { toast.info("Digite um SKU ou MLB na busca primeiro."); return; }
    setBuscandoElegiveis(true);
    try {
      let mlbs: string[] = [];
      if (/^MLB\d+$/i.test(termo)) mlbs = [termo.toUpperCase()];
      else {
        const { data } = await supabaseExternal.from("ml_anuncios").select("mlb").eq("sku", termo).limit(8);
        mlbs = (data ?? []).map((r: { mlb: string }) => r.mlb);
      }
      if (mlbs.length === 0) { toast.warning("Nenhum anúncio ML encontrado para esse SKU/MLB."); return; }
      let add = 0;
      for (const mlb of mlbs) {
        const r = await fetch(`${EXTERNAL_URL}/functions/v1/ml-promocoes?modulo=item&mlb=${mlb}`, { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } });
        const d = await r.json().catch(() => ({}));
        if (d.erro) throw new Error(d.erro);
        add += d.adicionados ?? 0;
      }
      toast.success(add > 0 ? `${add} promoção(ões) elegível(is) adicionada(s)` : "Nenhuma promoção elegível nova para esse item");
      await qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) {
      toast.error("Falha ao buscar elegíveis", { description: (e as Error).message });
    } finally {
      setBuscandoElegiveis(false);
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
    <div className="flex flex-col gap-[18px] p-1">
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-5 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-[11px] flex items-center justify-center shrink-0 bg-primary/10 text-primary">
            <Zap className="h-4 w-4" />
          </div>
          <div className="flex flex-col gap-0.5">
            <h1 className="text-xl font-extrabold tracking-tight leading-tight">Central de Promoções — Mercado Livre</h1>
            <p className="text-sm text-muted-foreground leading-snug">Margem de contribuição que teríamos ao aplicar cada promoção, no preço promocional.</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap" style={{ background: GREEN + "16", color: GREEN }}>Sincronizado</span>
          <Button variant="outline" onClick={() => void sincronizar()} disabled={sincronizando}>
            {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sincronizar
          </Button>
        </div>
      </div>

      {/* Chips de promoção */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => setPromoSel("todas")}
          className={cn("flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-sm font-semibold border-[1.5px] transition-colors",
            promoSel === "todas" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:bg-muted")}
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
              className={cn("flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-sm font-medium border-[1.5px] transition-colors",
                ativo ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:bg-muted")}
              title={`${p.tipo} · ${p.status}`}
            >
              <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: ti.cor }} />
              <span className="truncate max-w-[180px]">{p.nome ?? p.promocao_id}</span>
              <span className="text-xs text-muted-foreground">{p.n_itens}</span>
              {p.status === "pending" && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: AMBER + "1c", color: AMBER }}>agendada</span>}
            </button>
          );
        })}
      </div>

      {/* Filtros + resumo */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="SKU, MLB ou produto" className="pl-8 w-56" />
        </div>
        <Button variant="outline" size="sm" onClick={() => void buscarElegiveis()} disabled={buscandoElegiveis || !busca.trim()}
          title="Puxa TODAS as promoções elegíveis deste item (SKU ou MLB), inclusive as que o ML não colocou no listing da campanha">
          {buscandoElegiveis ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Elegíveis do item
        </Button>
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
          <option value="vendas">Ordenar: mais vendas</option>
          <option value="recentes">Ordenar: anúncios mais recentes</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={soFull} onChange={(e) => setSoFull(e.target.checked)} className="accent-primary" />
          Só Fulfillment
        </label>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={soPrejuizo} onChange={(e) => setSoPrejuizo(e.target.checked)} className="accent-red-600" />
          Só com prejuízo
        </label>
        <div className="ml-auto text-sm text-muted-foreground flex items-center gap-4 whitespace-nowrap">
          <span><strong className="text-foreground">{resumo.total}</strong> {resumo.total === 1 ? "item" : "itens"}</span>
          {resumo.neg > 0 && <span className="font-semibold flex items-center gap-1" style={{ color: RED }}><AlertTriangle className="h-3.5 w-3.5" />{resumo.neg} no prejuízo</span>}
          {resumo.mcMedia != null && <span>MC média promo: <strong className="tabular-nums" style={{ color: resumo.mcMedia < 0 ? RED : GREEN }}>{formatBRL(resumo.mcMedia)}</strong></span>}
        </div>
      </div>

      {carregando ? (
        <div className="bg-card border border-border rounded-2xl py-16 flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Carregando promoções…</span>
        </div>
      ) : filtrados.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-2xl py-14 flex flex-col items-center gap-3.5 text-center px-6">
          <span className="text-sm text-muted-foreground">Nenhum item nesse filtro — ajuste os filtros ou sincronize</span>
          <div className="flex gap-2.5">
            <Button variant="outline" size="sm" onClick={limparFiltros}>Limpar filtros</Button>
            <Button size="sm" onClick={() => void sincronizar()}>Sincronizar</Button>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-x-auto">
          <div className="min-w-[1140px] flex flex-col">
            {filtrados.map((i) => {
              const ti = tipoInfo(i.promocao_tipo);
              const mcNull = i.mc_promo == null;
              const mcCor = i.mc_negativa ? RED : GREEN;
              const deltaNeg = num(i.delta_mc) < 0;
              return (
                <div
                  key={`${i.promocao_id}|${i.mlb}`}
                  className="grid border-b border-border last:border-b-0"
                  style={{ gridTemplateColumns: "minmax(240px,1fr) 1px 140px 1px 150px 1px 320px 1px 150px", background: i.mc_negativa ? RED + "0A" : undefined }}
                >
                  {/* Produto */}
                  <div className="flex items-center gap-3.5 px-5 py-4 min-w-0">
                    <Foto url={i.foto} nome={i.titulo} />
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <span className="text-[14.5px] font-semibold leading-tight truncate">{i.titulo ?? "—"}</span>
                      <a href={i.permalink ?? undefined} target="_blank" rel="noreferrer"
                        className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 min-w-0">
                        <span className="font-mono truncate">SKU {i.sku ?? "—"} · {i.mlb}</span>
                        {i.permalink && <ExternalLink className="h-3 w-3 shrink-0" />}
                      </a>
                      <span className="self-start text-[11px] font-semibold px-2 py-0.5 rounded" style={{ background: ti.cor + "18", color: ti.cor }}>{ti.nome}</span>
                    </div>
                  </div>
                  <div className="bg-border" />
                  {/* Preço → promo */}
                  <div className="flex flex-col justify-center gap-1.5 px-4 py-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Preço → promo</span>
                    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
                      <span className="text-xs text-muted-foreground line-through tabular-nums">{formatBRL(num(i.original_price))}</span>
                      <span className="text-base font-bold tabular-nums">{formatBRL(num(i.promo_price))}</span>
                    </div>
                    <span className="text-xs font-bold tabular-nums" style={{ color: RED }}>−{num(i.desconto_pct).toFixed(0)}%</span>
                  </div>
                  <div className="bg-border" />
                  {/* Custos (na promo): CMV + tarifas ML + imposto */}
                  <div className="flex flex-col justify-center gap-1.5 px-4 py-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Custos (promo)</span>
                    {mcNull && i.cmv == null ? (
                      <span className="text-xs text-muted-foreground">sem CMV</span>
                    ) : (
                      <div className="flex flex-col gap-1 text-xs tabular-nums">
                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">CMV</span><span className="font-semibold">{i.cmv == null ? "—" : formatBRL(i.cmv)}</span></div>
                        <div className="flex justify-between gap-2" title={`Comissão ${formatBRL(num(i.comissao_promo))} + Frete ${formatBRL(num(i.frete))}${i.frete_estimado ? " (estim.)" : ""}`}>
                          <span className="text-muted-foreground">Tarifas ML</span>
                          <span className="font-semibold">{i.comissao_promo == null ? "—" : formatBRL(num(i.comissao_promo) + num(i.frete))}</span>
                        </div>
                        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Imposto</span><span className="font-semibold">{i.imposto_promo == null ? "—" : formatBRL(i.imposto_promo)}</span></div>
                      </div>
                    )}
                  </div>
                  <div className="bg-border" />
                  {/* Margem de contribuição */}
                  <div className="flex flex-col justify-center gap-2 px-5 py-4">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Margem de contribuição</span>
                    {mcNull ? (
                      <span className="text-[13.5px] italic text-muted-foreground">sem CMV — margem não calculada</span>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <div className="flex flex-col gap-0.5 rounded-lg px-3 py-1.5 bg-muted">
                          <span className="text-sm font-semibold text-muted-foreground tabular-nums whitespace-nowrap">{i.mc_atual == null ? "—" : formatBRL(i.mc_atual)}</span>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">{pct(i.mc_atual_pct)}</span>
                        </div>
                        <span className="text-muted-foreground text-sm">→</span>
                        <div className="flex flex-col gap-0.5 rounded-lg px-3.5 py-2" style={{ background: mcCor + "14" }}>
                          <span className="text-lg font-extrabold tabular-nums whitespace-nowrap" style={{ color: mcCor }}>{formatBRL(num(i.mc_promo))}</span>
                          <span className="text-xs font-semibold whitespace-nowrap" style={{ color: mcCor }}>{pct(i.mc_promo_pct)}</span>
                        </div>
                        <div className="flex flex-col gap-1 items-start">
                          <span className="text-xs font-semibold whitespace-nowrap inline-flex items-center gap-0.5" style={{ color: deltaNeg ? RED : GREEN }}>
                            {deltaNeg ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}{formatBRL(num(i.delta_mc))}
                          </span>
                          {i.frete_estimado && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: AMBER + "1c", color: AMBER }} title="Frete estimado pela mediana (≥R$79 sem histórico de venda)">frete estim.</span>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="bg-border" />
                  {/* Status + Ação */}
                  <div className="flex flex-col justify-center items-start gap-2.5 px-5 py-4">
                    {i.status === "started" ? (
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap" style={{ background: GREEN + "18", color: GREEN }}>Aplicada</span>
                    ) : (
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-muted text-muted-foreground whitespace-nowrap">Candidata</span>
                    )}
                    {mcNull ? (
                      <span className="text-xs text-muted-foreground">Ação indisponível</span>
                    ) : i.status === "started" ? (
                      <Button size="sm" variant="outline" className="text-muted-foreground hover:text-red-600" onClick={() => setConfirmar({ item: i, acao: "remover" })}>Remover</Button>
                    ) : (
                      <Button size="sm" variant={i.mc_negativa ? "outline" : "default"}
                        className={i.mc_negativa ? "border-[1.5px]" : ""}
                        style={i.mc_negativa ? { borderColor: RED, color: RED } : undefined}
                        onClick={() => setConfirmar({ item: i, acao: "aplicar" })}>Aplicar</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
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
          <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: "rgba(15,18,22,.5)" }} onClick={() => !executando && setConfirmar(null)}>
            <div className="bg-card border border-border rounded-2xl p-6 max-w-md w-full flex flex-col gap-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-bold">{ehAplicar ? "Aplicar promoção" : "Remover promoção"}</h2>
                <button onClick={() => !executando && setConfirmar(null)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
              </div>
              <div className="flex items-center gap-3">
                <Foto url={item.foto} nome={item.titulo} size={48} />
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
                        {item.preco_sugerido != null && <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_sugerido)}>Sugerido</button>}
                        <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_min)}>Mín</button>
                        <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_max)}>Máx</button>
                      </div>
                    </div>
                  )}
                  <div className="bg-muted rounded-xl p-4 flex flex-col gap-3">
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-sm text-muted-foreground">Preço público</span>
                      <span className="text-sm font-semibold font-mono tabular-nums whitespace-nowrap">{formatBRL(num(item.original_price))} → <strong>{formatBRL(num(precoShow))}</strong>{descShow != null && <span style={{ color: RED }}> (−{descShow.toFixed(0)}%)</span>}</span>
                    </div>
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-sm text-muted-foreground">Margem de contribuição</span>
                      <span className="text-sm font-mono tabular-nums flex items-center gap-1 whitespace-nowrap">{formatBRL(num(item.mc_atual))} → <strong style={{ color: neg ? RED : GREEN }}>{mcShow == null ? "—" : formatBRL(mcShow)}</strong>{mcPctShow != null && <span className="text-muted-foreground">({pct(mcPctShow)})</span>}{simLoading && <Loader2 className="h-3 w-3 animate-spin" />}</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">O item volta ao preço cheio ({formatBRL(num(item.original_price))}) e sai desta promoção.</p>
              )}
              {ehAplicar && neg && (
                <div className="rounded-lg p-3 text-sm font-medium flex items-start gap-2" style={{ background: RED + "14", border: `1px solid ${RED}40`, color: RED }}>
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>Atenção: com este preço a margem fica <strong>negativa</strong> ({mcShow == null ? "—" : formatBRL(mcShow)}). Você venderia no prejuízo.</span>
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
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export const Route = createFileRoute("/promocoes-ml")({
  component: PromocoesMLPage,
});
