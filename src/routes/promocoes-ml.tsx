import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw, Search, AlertTriangle, ExternalLink, X, TrendingDown, TrendingUp, ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// Escrita no ML (aplicar/remover/elegíveis) exige a sessão do usuário (ml-promocoes v18+);
// leitura (sync/simular/estado) segue com a chave publicável.
async function chamarML(qs: string, escrita = false): Promise<any> {
  let bearer = EXTERNAL_PUBLISHABLE_KEY;
  if (escrita) {
    const { data } = await supabaseExternal.auth.getSession();
    if (!data.session?.access_token) throw new Error("Sessão expirada — entre de novo no app.");
    bearer = data.session.access_token;
  }
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/ml-promocoes?${qs}`, { headers: { Authorization: `Bearer ${bearer}`, apikey: EXTERNAL_PUBLISHABLE_KEY } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && !d.mensagem) throw new Error(d.erro ?? `HTTP ${r.status}`);
  return d;
}
// Estado AO VIVO da promoção no ML para o item (faixa de preço, estoque do Relâmpago, situação).
interface Vivo { status: string | null; min: number | null; max: number | null; sugerido: number | null; preco: number | null; estoque_min: number | null; estoque_max: number | null; inicio: string | null; fim: string | null }

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

type ColOrd = "vendas" | "criado" | "preco" | "desconto" | "mc_atual" | "mc_promo" | "mcpct" | "delta";

function ThOrd({ col, ord, setOrd, children, className, title, primeiro = -1 }: {
  col: ColOrd; ord: { col: ColOrd; dir: 1 | -1 }; setOrd: (o: { col: ColOrd; dir: 1 | -1 }) => void;
  children: React.ReactNode; className?: string; title?: string; primeiro?: 1 | -1;
}) {
  const ativo = ord.col === col;
  return (
    <th className={cn("px-3 py-2.5 font-semibold text-right whitespace-nowrap", className)} title={title}>
      <button type="button" onClick={() => setOrd({ col, dir: ativo ? (ord.dir === 1 ? -1 : 1) : primeiro })}
        className={cn("inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground", ativo && "text-foreground")}>
        {children}
        {ativo && (ord.dir === -1 ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
}
const dataBR = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Sao_Paulo" }) : "—");

function PromocoesMLPage() {
  const qc = useQueryClient();
  const [promoSel, setPromoSel] = useState<string>("todas");
  const [statusFiltro, setStatusFiltro] = useState<"todas" | "started" | "candidate">("todas");
  const [soPrejuizo, setSoPrejuizo] = useState(false);
  const [soFull, setSoFull] = useState(false);
  const [busca, setBusca] = useState("");
  const [ord, setOrd] = useState<{ col: ColOrd; dir: 1 | -1 }>({ col: "vendas", dir: -1 });
  const [sincronizando, setSincronizando] = useState(false);
  const [buscandoElegiveis, setBuscandoElegiveis] = useState(false);
  const [confirmar, setConfirmar] = useState<{ item: PromoItem; acao: "aplicar" | "remover" } | null>(null);
  const [executando, setExecutando] = useState(false);
  // Seletor de preço (promoções com faixa min↔max): simula a MC no preço escolhido.
  const [simPreco, setSimPreco] = useState<number | null>(null);
  const [simResult, setSimResult] = useState<{ mc: number | null; mc_pct: number | null } | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const { perfil } = usePerfil();
  // Ao abrir "Aplicar": confere no ML se a promoção ainda está disponível e com que faixa/estoque.
  const [vivo, setVivo] = useState<Vivo | null | "ausente">(null);
  const [vivoLoading, setVivoLoading] = useState(false);
  const [estoqueRes, setEstoqueRes] = useState<number | null>(null);

  useEffect(() => {
    if (confirmar?.acao !== "aplicar") { setVivo(null); return; }
    const it = confirmar.item;
    setSimPreco(it.promo_price ?? null); setSimResult(null); setVivo(null); setEstoqueRes(null);
    let cancelado = false;
    setVivoLoading(true);
    chamarML(`modulo=estado&mlb=${it.mlb}&promocao_id=${encodeURIComponent(it.promocao_id)}&tipo=${it.promocao_tipo ?? ""}`)
      .then((d) => {
        if (cancelado) return;
        const p = d.promocao as Vivo | null;
        if (!p) { setVivo("ausente"); return; }
        setVivo(p);
        // preço dentro da faixa que o ML aceita AGORA (o sugerido pode passar do máximo)
        const base = it.promo_price ?? p.sugerido ?? p.preco ?? null;
        if (base != null && p.max != null && base > p.max) setSimPreco(p.max);
        else if (base != null && p.min != null && base < p.min) setSimPreco(p.min);
        if (p.estoque_min != null) setEstoqueRes(p.estoque_min);
      })
      .catch(() => { if (!cancelado) setVivo(null); })
      .finally(() => { if (!cancelado) setVivoLoading(false); });
    return () => { cancelado = true; };
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
        .select("promocao_id, tipo, nome, status, finish_date, n_itens").neq("status", "finished").order("n_itens", { ascending: false });
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

  // Unidades vendidas no ML em 30 dias por SKU (nossos pedidos válidos) — o
  // sold_quantity do ML é vitalício e impreciso. RPC ml_vendas_30d_sku (~0,1 s).
  const vendasQ = useQuery({
    queryKey: ["promocoes-ml", "vendas30d"],
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabaseExternal.rpc("ml_vendas_30d_sku");
      if (error) throw error;
      return new Map(((data ?? []) as Array<{ sku: string; unidades: number }>).map((r) => [r.sku, Number(r.unidades)]));
    },
    staleTime: 10 * 60_000, refetchOnWindowFocus: false,
  });
  const vendas30 = vendasQ.data ?? new Map<string, number>();
  const vendasDe = (i: PromoItem) => (i.sku ? vendas30.get(i.sku) ?? 0 : 0);

  const promos = promosQ.data ?? [];
  const itens = itensQ.data ?? [];

  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase();
    let arr = itens.filter((i) => {
      if (promoSel !== "todas" && i.promocao_id !== promoSel) return false;
      if (statusFiltro !== "todas" && i.status !== statusFiltro) return false;
      if (soPrejuizo && !i.mc_negativa) return false;
      if (soFull && i.logistic_type !== "fulfillment") return false;
      // Relâmpago só para anúncios que vendem (decisão do dono, 05/out): candidata sem venda some
      if ((i.promocao_tipo ?? "").toUpperCase() === "LIGHTNING" && i.status !== "started" && vendasDe(i) === 0) return false;
      if (b && !(`${i.sku ?? ""} ${i.mlb} ${i.titulo ?? ""}`.toLowerCase().includes(b))) return false;
      return true;
    });
    const val = (i: PromoItem): number | string | null => {
      switch (ord.col) {
        case "vendas": return vendasDe(i);
        case "criado": return i.date_created ?? null;
        case "preco": return i.promo_price;
        case "desconto": return i.desconto_pct;
        case "mc_atual": return i.mc_atual;
        case "mc_promo": return i.mc_promo;
        case "mcpct": return i.mc_promo_pct;
        default: return i.delta_mc;
      }
    };
    arr = arr.sort((a, z) => {
      const va = val(a), vz = val(z);
      if (va == null && vz == null) return 0;
      if (va == null) return 1; // vazios sempre no fim
      if (vz == null) return -1;
      const c = typeof va === "string" ? va.localeCompare(String(vz)) : va - Number(vz);
      return c * ord.dir || vendasDe(z) - vendasDe(a);
    });
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itens, promoSel, statusFiltro, soPrejuizo, soFull, busca, ord, vendas30]);

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
      // Relâmpago: só anúncios com venda no ML em 30 dias, conferidos ao vivo (modulo=relampago)
      const rl = await chamarML("modulo=relampago").catch(() => null);
      toast.success(`Sincronizado: ${d.gravados ?? 0} itens atualizados`, {
        description: rl && !rl.erro ? `Relâmpago: ${rl.verificados} anúncios com venda conferidos · ${rl.com_relampago} com oferta disponível` : undefined,
      });
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
        const d = await chamarML(`modulo=item&mlb=${mlb}`, true);
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
      if (perfil?.nome) p.set("por", perfil.nome);
      if (acao === "aplicar") {
        if (item.offer_id) p.set("offer_id", item.offer_id);
        else { const dp = simPreco ?? item.promo_price; if (dp != null) p.set("deal_price", String(dp)); }
        if (estoqueRes != null) p.set("stock", String(estoqueRes));
      }
      const d = await chamarML(p.toString(), true);
      if (d.erro) throw new Error(d.erro);
      if (!d.ok) {
        // recusa do ML (ou lista desatualizada) — motivo já vem em português da função
        toast.error(acao === "aplicar" ? "O Mercado Livre não aceitou" : "Não foi possível remover", { description: d.mensagem ?? "sem detalhe", duration: 15000 });
        if (d.desatualizado) { setConfirmar(null); await qc.invalidateQueries({ queryKey: ["promocoes-ml"] }); }
        return;
      }
      if (d.ja_estava) toast.info(d.mensagem ?? "Este anúncio já estava nesta promoção.");
      else toast.success(acao === "aplicar" ? `Promoção aplicada em ${item.mlb}` : `Promoção removida de ${item.mlb}`);
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
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 bg-card">
          {([["vendas", -1, "Mais vendidos (30d)"], ["criado", -1, "Anúncios mais novos"], ["delta", 1, "Maior queda de MC"], ["mc_promo", 1, "Menor MC na promo"]] as const).map(([col, dir, rot]) => (
            <button key={col} type="button" onClick={() => setOrd({ col, dir })}
              className={cn("px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap", ord.col === col ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              {rot}
            </button>
          ))}
        </div>
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
        <div className="rounded-2xl border border-border bg-card overflow-auto max-h-[calc(100vh-150px)]">
          <table className="w-full min-w-[1280px] text-[13px]">
            {/* cabeçalho fixo ao rolar (fundo opaco + sombra pra separar das linhas) */}
            <thead className="sticky top-0 z-10 bg-card shadow-[0_1px_0_var(--border)]">
              <tr className="bg-muted/40 text-[10.5px] text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-semibold uppercase tracking-wide">Anúncio</th>
                <ThOrd col="vendas" ord={ord} setOrd={setOrd} title="Unidades vendidas no Mercado Livre nos últimos 30 dias (nossos pedidos, pelo SKU)">Vendas 30d</ThOrd>
                <ThOrd col="criado" ord={ord} setOrd={setOrd} title="Data de criação do anúncio no Mercado Livre">Criado em</ThOrd>
                <ThOrd col="preco" ord={ord} setOrd={setOrd}>Preço → promo</ThOrd>
                <ThOrd col="desconto" ord={ord} setOrd={setOrd}>Desc.</ThOrd>
                <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide" title="CMV + tarifas do ML (comissão + frete) + imposto, no preço da promoção">Custos na promo</th>
                <ThOrd col="mc_atual" ord={ord} setOrd={setOrd} title="Margem de contribuição no preço atual">MC hoje</ThOrd>
                <ThOrd col="mc_promo" ord={ord} setOrd={setOrd} primeiro={1} title="Margem de contribuição no preço da promoção">MC na promo</ThOrd>
                <ThOrd col="delta" ord={ord} setOrd={setOrd} primeiro={1} title="Quanto a margem por unidade muda ao entrar na promoção">Variação</ThOrd>
                <th className="px-4 py-2.5 text-left font-semibold uppercase tracking-wide">Situação</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map((i) => {
                const ti = tipoInfo(i.promocao_tipo);
                const mcNull = i.mc_promo == null;
                const mcCor = i.mc_negativa ? RED : GREEN;
                const deltaNeg = num(i.delta_mc) < 0;
                const v30 = vendasDe(i);
                const tarifas = i.comissao_promo == null ? null : num(i.comissao_promo) + num(i.frete);
                const custo = i.cmv == null || tarifas == null ? null : num(i.cmv) + tarifas + num(i.imposto_promo);
                return (
                  <tr key={`${i.promocao_id}|${i.mlb}`} className="border-b last:border-0 align-middle hover:bg-muted/30"
                    style={{ background: i.mc_negativa ? RED + "0A" : undefined }}>
                    {/* Anúncio */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 min-w-[300px] max-w-[440px]">
                        <Foto url={i.foto} nome={i.titulo} size={48} />
                        <div className="flex flex-col gap-1 min-w-0">
                          <span className="text-[13.5px] font-semibold leading-snug line-clamp-2">{i.titulo ?? "—"}</span>
                          <a href={i.permalink ?? undefined} target="_blank" rel="noreferrer"
                            className="text-[11px] text-muted-foreground hover:text-primary inline-flex items-center gap-1 font-mono">
                            SKU {i.sku ?? "—"} · {i.mlb}{i.permalink && <ExternalLink className="h-3 w-3 shrink-0" />}
                          </a>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded" style={{ background: ti.cor + "18", color: ti.cor }}>{ti.nome}</span>
                            {promoSel === "todas" && i.promocao_nome && <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground truncate max-w-[220px]" title={i.promocao_nome}>{i.promocao_nome}</span>}
                            {i.logistic_type === "fulfillment" && <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">Full</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Vendas 30d */}
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className={cn("font-semibold", v30 === 0 && "text-muted-foreground font-normal")}>{v30.toLocaleString("pt-BR")}</span>
                    </td>
                    {/* Criado em */}
                    <td className="px-3 py-3 text-right tabular-nums text-muted-foreground whitespace-nowrap">{dataBR(i.date_created)}</td>
                    {/* Preço → promo */}
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <div className="text-[11px] text-muted-foreground line-through tabular-nums">{formatBRL(num(i.original_price))}</div>
                      <div className="text-[14px] font-bold tabular-nums">{formatBRL(num(i.promo_price))}</div>
                    </td>
                    {/* Desconto */}
                    <td className="px-3 py-3 text-right tabular-nums font-bold whitespace-nowrap" style={{ color: RED }}>−{num(i.desconto_pct).toFixed(0)}%</td>
                    {/* Custos */}
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {custo == null ? <span className="text-xs text-muted-foreground">sem CMV</span> : (
                        <div className="inline-flex flex-col items-end gap-0.5 tabular-nums"
                          title={`CMV ${formatBRL(num(i.cmv))} · Comissão ${formatBRL(num(i.comissao_promo))} · Frete ${formatBRL(num(i.frete))}${i.frete_estimado ? " (estimado)" : ""} · Imposto ${formatBRL(num(i.imposto_promo))}`}>
                          <span className="font-semibold">{formatBRL(custo)}</span>
                          <span className="text-[10.5px] text-muted-foreground">CMV {formatBRL(num(i.cmv))} · ML {formatBRL(tarifas ?? 0)}</span>
                          {i.frete_estimado && <span className="text-[10px] font-semibold" style={{ color: AMBER }}>frete estimado</span>}
                        </div>
                      )}
                    </td>
                    {/* MC hoje */}
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      {i.mc_atual == null ? <span className="text-muted-foreground">—</span> : (
                        <>
                          <div className="font-semibold text-muted-foreground">{formatBRL(i.mc_atual)}</div>
                          <div className="text-[11px] text-muted-foreground">{pct(i.mc_atual_pct)}</div>
                        </>
                      )}
                    </td>
                    {/* MC na promo */}
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      {mcNull ? <span className="text-xs italic text-muted-foreground">sem CMV</span> : (
                        <div className="inline-flex flex-col items-end rounded-lg px-2.5 py-1" style={{ background: mcCor + "14" }}>
                          <span className="text-[15px] font-extrabold" style={{ color: mcCor }}>{formatBRL(num(i.mc_promo))}</span>
                          <span className="text-[11px] font-semibold" style={{ color: mcCor }}>{pct(i.mc_promo_pct)}</span>
                        </div>
                      )}
                    </td>
                    {/* Variação */}
                    <td className="px-3 py-3 text-right whitespace-nowrap tabular-nums">
                      {mcNull ? <span className="text-muted-foreground">—</span> : (
                        <span className="text-xs font-semibold inline-flex items-center gap-0.5" style={{ color: deltaNeg ? RED : GREEN }}>
                          {deltaNeg ? <TrendingDown className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}{formatBRL(num(i.delta_mc))}
                        </span>
                      )}
                    </td>
                    {/* Situação + ação */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {i.status === "started" ? (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: GREEN + "18", color: GREEN }}>Aplicada</span>
                        ) : (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Candidata</span>
                        )}
                        {mcNull ? null : i.status === "started" ? (
                          <Button size="sm" variant="outline" className="h-7 text-xs text-muted-foreground hover:text-red-600" onClick={() => setConfirmar({ item: i, acao: "remover" })}>Remover</Button>
                        ) : (
                          <Button size="sm" variant={i.mc_negativa ? "outline" : "default"}
                            className={cn("h-7 text-xs", i.mc_negativa && "border-[1.5px]")}
                            style={i.mc_negativa ? { borderColor: RED, color: RED } : undefined}
                            onClick={() => setConfirmar({ item: i, acao: "aplicar" })}>Aplicar</Button>
                        )}
                      </div>
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
        const vv = vivo && vivo !== "ausente" ? vivo : null;
        const fMin = vv?.min ?? item.preco_min, fMax = vv?.max ?? item.preco_max;
        const ajustavel = ehAplicar && fMin != null && fMax != null && !item.offer_id;
        const relampago = (item.promocao_tipo ?? "").toUpperCase() === "LIGHTNING";
        const indisponivel = ehAplicar && vivo === "ausente";
        const foraFaixa = ehAplicar && simPreco != null && ((fMin != null && simPreco < fMin - 0.001) || (fMax != null && simPreco > fMax + 0.001));
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
                      <span className="text-xs font-semibold text-muted-foreground">Preço da promoção — você escolhe (entre {formatBRL(num(fMin))} e {formatBRL(num(fMax))}{vv ? ", conferido agora no ML" : ""})</span>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Input type="number" step="0.01" min={item.preco_min ?? undefined} max={item.preco_max ?? undefined}
                          value={simPreco ?? ""} onChange={(e) => { const v = Number(e.target.value); setSimPreco(Number.isFinite(v) && v > 0 ? v : null); }}
                          className="w-28 font-mono" />
                        {item.preco_sugerido != null && <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(item.preco_sugerido)}>Sugerido</button>}
                        <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(fMin)}>Mín</button>
                        <button className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:bg-muted" onClick={() => setSimPreco(fMax)}>Máx</button>
                      </div>
                    </div>
                  )}
                  {vivoLoading && <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Conferindo a promoção no Mercado Livre…</span>}
                  {indisponivel && (
                    <div className="rounded-lg p-3 text-sm font-medium flex items-start gap-2" style={{ background: AMBER + "14", border: `1px solid ${AMBER}40`, color: AMBER }}>
                      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span>O Mercado Livre <strong>não oferece mais</strong> esta promoção para este anúncio — a lista estava desatualizada. Feche e sincronize.</span>
                    </div>
                  )}
                  {relampago && vv && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-muted-foreground">
                        Unidades reservadas para o Relâmpago{vv.estoque_min != null ? ` (mín. ${vv.estoque_min}${vv.estoque_max != null ? `, máx. ${vv.estoque_max}` : ""})` : ""} — quando acabam, a oferta encerra
                      </span>
                      <Input type="number" min={vv.estoque_min ?? 1} max={vv.estoque_max ?? undefined} value={estoqueRes ?? ""} className="w-28 font-mono"
                        onChange={(e) => { const v = Math.floor(Number(e.target.value)); setEstoqueRes(Number.isFinite(v) && v > 0 ? v : null); }} />
                      {vv.inicio && <span className="text-[11px] text-muted-foreground">Janela: {new Date(vv.inicio).toLocaleString("pt-BR")}{vv.fim ? ` → ${new Date(vv.fim).toLocaleString("pt-BR")}` : ""}</span>}
                    </div>
                  )}
                  {foraFaixa && <span className="text-xs font-semibold" style={{ color: RED }}>Preço fora da faixa aceita pelo ML ({formatBRL(num(fMin))} a {formatBRL(num(fMax))}).</span>}
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
                <Button variant={ehAplicar && neg ? "destructive" : "default"} onClick={() => void executar()}
                  disabled={executando || simLoading || (ehAplicar && (vivoLoading || indisponivel || foraFaixa || (relampago && !estoqueRes)))}>
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
