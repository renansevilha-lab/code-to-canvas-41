import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CirclePlus, ExternalLink, Loader2, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { useDecisoesML, type LinhaDecisao } from "./RegraAutoML";
import type { CabBase } from "./ShopeeMinha";
import {
  BRL, Btn, CabecalhoMkt, CartaoRobo, Chip, ErroLeitura, FaixaDecisao, INT, ListaPromos, PCT, PST, TabelaPromo,
  corMc, seg, type CartaoDecisao, type ContaMc, type EstadoLinha, type ItemLista, type LinhaPromo, type ModoRobo, type StatusPromo,
} from "./ui/kit";

// ============================================================================
// Mercado Livre › Central de Promoções no design novo (Claude Design "Promoções",
// fase 3, 21/out/2026). Mesmos dados e as mesmas escritas da tela antiga (PromocoesML.tsx):
//   · promoções do vendedor (ml_promocoes) e itens com a MC calculada no banco
//     (view_ml_promocoes: receita com co-financiamento − comissão − frete − imposto − CMV);
//   · decisão da regra por item (view_ml_promo_decisao) e o robô (ml_promo_regra, cron 139);
//   · aplicar / remover / trocar = ml-promocoes com confirmar=1 e sessão do usuário, sempre
//     depois de conferir AO VIVO no ML (faixa de preço, estoque do Relâmpago).
// O ML fixa o preço da maior parte das promoções (oferta com offer_id); só as com faixa
// mín–máx deixam escolher o preço, e isso é feito no diálogo de aplicar, item a item.
// ============================================================================

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

interface Item {
  promocao_id: string; mlb: string; sku: string | null; status: string;
  offer_id: string | null; original_price: number | null; promo_price: number | null;
  preco_min: number | null; preco_max: number | null; preco_sugerido: number | null;
  meli_percentage: number | null; comissao_promo: number | null; frete: number | null; frete_estimado: boolean;
  logistic_type: string | null; date_created: string | null; cmv: number | null; aliquota: number | null;
  receita_vend_promo: number | null; imposto_promo: number | null;
  promocao_nome: string | null; promocao_tipo: string | null; finish_date: string | null;
  titulo: string | null; foto: string | null; permalink: string | null;
  mc_atual: number | null; mc_promo: number | null; mc_promo_pct: number | null; mc_atual_pct: number | null;
  delta_mc: number | null; mc_negativa: boolean;
}
interface Promo { promocao_id: string; tipo: string; nome: string | null; status: string; start_date: string | null; finish_date: string | null; deadline_date: string | null; n_itens: number; atualizado_em: string | null }
interface Regra { modo: ModoRobo; mc_min_pct: number; ganho_min_troca: number; max_por_rodada: number }
interface Acao { acao: string; ok: boolean; criado_em: string }
interface Vivo { status: string | null; min: number | null; max: number | null; sugerido: number | null; preco: number | null; estoque_min: number | null; estoque_max: number | null; inicio: string | null; fim: string | null }
type Res = { tipo: "aplicado" | "recusado"; motivo: string };

const TZ = "America/Sao_Paulo";
const num = (x: unknown) => { const n = Number(x ?? 0); return Number.isFinite(n) ? n : 0; };
const chave = (i: { promocao_id: string; mlb: string }) => `${i.promocao_id}|${i.mlb}`;
const dia = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" }) : "—");
const diaHora = (iso: string) => new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const ymd = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const diasAte = (iso: string | null) => (iso ? Math.round((Date.parse(ymd(Date.parse(iso))) - Date.parse(ymd(Date.now()))) / 86400000) : 99);
const TIPO: Record<string, [string, string]> = {
  SMART: ["Smart", "#2F6FB0"], DEAL: ["Oferta", "#7A5CC7"], LIGHTNING: ["Relâmpago", "#DB6B1F"], DOD: ["Oferta do dia", "#C9432F"],
  SELLER_CAMPAIGN: ["Campanha do vendedor", "#0E8A5F"], PRICE_DISCOUNT: ["Desconto", "#64748B"],
  UNHEALTHY_STOCK: ["Estoque parado no Full", "#B7791F"], VOLUME: ["Desconto por volume", "#64748B"],
};
const tipoDe = (t: string | null) => TIPO[(t ?? "").toUpperCase()] ?? [t ?? "—", "#64748B"];
const ehRelampago = (t: string | null) => (t ?? "").toUpperCase() === "LIGHTNING";

type Filtro = "neg" | "baixa" | "aguardando" | "troca" | "auto" | "semcusto" | "acaba";
const FILTRO_NOME: Record<Filtro, string> = {
  neg: "MC negativa", baixa: "MC abaixo de 10%", aguardando: "aguardando você", troca: "sugestões de troca",
  auto: "entram automático", semcusto: "sem custo", acaba: "acabam hoje ou amanhã",
};
type Ordem = "vendas" | "novos" | "mc" | "queda";

/** Próxima rodada do robô (cron 139: 10h35, 14h35 e 18h35 UTC = 07h35, 11h35, 15h35 em Brasília). */
function proximaRodada(): string {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }));
  const m = Number(new Date().toLocaleString("en-US", { timeZone: TZ, minute: "2-digit" }));
  const agora = h * 60 + m;
  const prox = [7 * 60 + 35, 11 * 60 + 35, 15 * 60 + 35].find((x) => x > agora);
  return prox == null ? "amanhã 07:35" : `hoje ${String(Math.floor(prox / 60)).padStart(2, "0")}:${String(prox % 60).padStart(2, "0")}`;
}

/** Conta da MC por unidade no preço da promoção — os mesmos termos da view_ml_promocoes. */
function contaML(i: Item): ContaMc | null {
  if (i.mc_promo == null || i.mc_promo_pct == null) return null;
  const promo = num(i.promo_price), receita = num(i.receita_vend_promo), cofin = receita - promo;
  const linhas: ContaMc["linhas"] = [{ k: "Preço da promoção", v: promo }];
  if (Math.abs(cofin) > 0.004) linhas.push({ k: `Co-financiamento do ML${i.meli_percentage ? ` (${num(i.meli_percentage).toFixed(0)}%)` : ""}`, v: cofin });
  linhas.push({ k: "Comissão do ML", v: -num(i.comissao_promo) });
  linhas.push({ k: i.frete_estimado ? "Frete (estimado)" : "Frete", v: -num(i.frete) });
  linhas.push({ k: `Imposto (${PCT(num(i.aliquota), 1)})`, v: -num(i.imposto_promo) });
  linhas.push({ k: "CMV", v: -num(i.cmv) });
  return { v: num(i.mc_promo), pct: num(i.mc_promo_pct), linhas };
}

export function MercadoLivrePromo({ cab }: { cab: CabBase }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [selId, setSelId] = useState<string>("todas");
  const [filtro, setFiltro] = useState<Filtro | null>(null);
  const [busca, setBusca] = useState("");
  const [faixa, setFaixa] = useState("todas");
  const [statusF, setStatusF] = useState<"todos" | "started" | "candidate">("todos");
  const [soFull, setSoFull] = useState(false);
  const [ordem, setOrdem] = useState<Ordem>("vendas");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [girando, setGirando] = useState(false);
  const [buscandoEleg, setBuscandoEleg] = useState(false);
  const [rodandoRobo, setRodandoRobo] = useState(false);
  const [acao, setAcao] = useState<{ item: Item; tipo: "aplicar" | "remover" | "trocar"; d?: LinhaDecisao } | null>(null);
  const [res, setRes] = useState<Map<string, Res>>(new Map());

  const promosQ = useQuery({
    queryKey: ["promocoes-ml", "promos"],
    queryFn: async (): Promise<Promo[]> => {
      const { data, error } = await supabaseExternal.from("ml_promocoes")
        .select("promocao_id, tipo, nome, status, start_date, finish_date, deadline_date, n_itens, atualizado_em").neq("status", "finished");
      if (error) throw error;
      return (data ?? []) as Promo[];
    },
    staleTime: 5 * 60_000,
  });
  const itensQ = useQuery({
    queryKey: ["promocoes-ml", "itens-v2"],
    queryFn: async (): Promise<Item[]> => {
      const { data, error } = await supabaseExternal.from("view_ml_promocoes")
        .select("promocao_id, mlb, sku, status, offer_id, original_price, promo_price, preco_min, preco_max, preco_sugerido, meli_percentage, comissao_promo, frete, frete_estimado, logistic_type, date_created, cmv, aliquota, receita_vend_promo, imposto_promo, promocao_nome, promocao_tipo, finish_date, titulo, foto, permalink, mc_atual, mc_promo, mc_promo_pct, mc_atual_pct, delta_mc, mc_negativa");
      if (error) throw error;
      return (data ?? []) as Item[];
    },
    staleTime: 5 * 60_000,
  });
  const vendasQ = useQuery({
    queryKey: ["promocoes-ml", "vendas30d"],
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabaseExternal.rpc("ml_vendas_30d_sku");
      if (error) throw error;
      return new Map(((data ?? []) as Array<{ sku: string; unidades: number }>).map((r) => [r.sku, Number(r.unidades)]));
    },
    staleTime: 10 * 60_000,
  });
  const mlbs = useMemo(() => [...new Set((itensQ.data ?? []).map((i) => i.mlb))].sort(), [itensQ.data]);
  const estoqueQ = useQuery({
    queryKey: ["promocoes-ml", "estoque", mlbs.join(",")],
    enabled: mlbs.length > 0,
    queryFn: async (): Promise<Map<string, number>> => {
      const m = new Map<string, number>();
      for (let k = 0; k < mlbs.length; k += 200) {
        const { data, error } = await supabaseExternal.from("ml_anuncios").select("mlb, estoque").in("mlb", mlbs.slice(k, k + 200));
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ mlb: string; estoque: number | null }>) if (r.estoque != null) m.set(r.mlb, Number(r.estoque));
      }
      return m;
    },
    staleTime: 10 * 60_000,
  });
  const regraQ = useQuery({
    queryKey: ["promocoes-ml", "regra"],
    queryFn: async (): Promise<Regra> => {
      const { data, error } = await supabaseExternal.from("ml_promo_regra").select("modo, mc_min_pct, ganho_min_troca, max_por_rodada").eq("id", 1).single();
      if (error) throw error;
      return { ...(data as Regra), mc_min_pct: Number(data.mc_min_pct), ganho_min_troca: Number(data.ganho_min_troca) };
    },
    staleTime: 60_000,
  });
  const acoesQ = useQuery({
    queryKey: ["promocoes-ml", "acoes-robo"],
    queryFn: async (): Promise<Acao[]> => {
      const { data, error } = await supabaseExternal.from("ml_promocao_acoes").select("acao, ok, criado_em")
        .like("por", "automático%").order("criado_em", { ascending: false }).limit(40);
      if (error) throw error;
      return (data ?? []) as Acao[];
    },
    staleTime: 5 * 60_000,
  });
  const decisoesQ = useDecisoesML();
  const decisoes = decisoesQ.data ?? new Map<string, LinhaDecisao>();
  const vendas = vendasQ.data ?? new Map<string, number>();
  const estoque = estoqueQ.data ?? new Map<string, number>();
  const regra = regraQ.data;
  const v30De = (i: Item) => (i.sku ? vendas.get(i.sku) ?? 0 : 0);

  // Relâmpago só para anúncios que vendem (decisão do dono, 05/out): candidata sem venda some
  const itens = useMemo(() => (itensQ.data ?? []).filter((i) => !(ehRelampago(i.promocao_tipo) && i.status !== "started" && v30De(i) === 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itensQ.data, vendas]);
  const promos = useMemo(() => {
    const nossos = new Map<string, { na: number; cand: number }>();
    for (const i of itens) { const c = nossos.get(i.promocao_id) ?? { na: 0, cand: 0 }; if (i.status === "started") c.na++; else c.cand++; nossos.set(i.promocao_id, c); }
    return (promosQ.data ?? []).map((p) => ({ ...p, ...(nossos.get(p.promocao_id) ?? { na: 0, cand: 0 }) }))
      .sort((a, b) => b.na - a.na || b.cand - a.cand);
  }, [promosQ.data, itens]);

  // ---------------------------------------------------------------- filtros da faixa
  const passa = (i: Item, f: Filtro): boolean => {
    const d = decisoes.get(chave(i));
    switch (f) {
      case "neg": return i.status === "started" && i.mc_negativa;
      case "baixa": return i.status === "started" && i.mc_promo_pct != null && i.mc_promo_pct >= 0 && i.mc_promo_pct < 0.1;
      case "aguardando": return i.status !== "started" && d?.decisao === "confirmar";
      case "troca": return i.status !== "started" && d?.decisao === "trocar";
      case "auto": return i.status !== "started" && d?.decisao === "auto";
      case "semcusto": return i.cmv == null;
      case "acaba": return i.status === "started" && diasAte(i.finish_date) <= 1;
    }
  };
  const conta = (f: Filtro) => itens.filter((i) => passa(i, f)).length;
  const nNeg = conta("neg");
  const cards: CartaoDecisao[] = ([
    ["neg", "MC negativa", "na promoção, vendendo no prejuízo", "var(--pm-r)"],
    ["baixa", "MC abaixo de 10%", "na promoção, margem apertada", "var(--pm-am)"],
    ["aguardando", "Aguardando você", `MC abaixo de ${regra ? PCT(regra.mc_min_pct, 0) : "15%"}: só entra se você aplicar`, "var(--pm-am)"],
    ["troca", "Sugestões de troca", "outra promoção rende mais", "var(--pm-at)"],
    ["auto", "Entram automático", regra?.modo === "ligado" ? "o robô aplica na próxima rodada" : "passam na regra (robô não está ligado)", "var(--pm-g)"],
    ["semcusto", "Sem custo", "MC não calculada", "var(--pm-am)"],
    ["acaba", "Acabam hoje ou amanhã", "anúncios em promoção que terminam", "var(--pm-at)"],
  ] as Array<[Filtro, string, string, string]>).map(([id, label, sub, tom]) => ({
    id, label, sub, tom, n: itensQ.isSuccess ? String(conta(id)) : "—", ativo: filtro === id,
    onClick: () => { setFiltro(filtro === id ? null : id); setSelId("todas"); setSel(new Set()); },
  }));

  // ---------------------------------------------------------------- lista de promoções
  const matchDe = (pid: string) => (filtro ? itens.filter((i) => i.promocao_id === pid && passa(i, filtro)).length : 0);
  const itensLista: ItemLista[] = [
    { id: "todas", nome: "Todas as promoções", periodo: `${promos.length} ativas`, status: "andamento", itensTxt: `${itens.length} itens`, match: filtro ? conta(filtro) : 0 },
    ...promos.map((p) => {
      const st: StatusPromo = p.status === "pending" ? "programada" : p.na > 0 ? "andamento" : "adesao";
      const dias = diasAte(p.finish_date);
      return {
        id: p.promocao_id, nome: p.nome ?? p.promocao_id, status: st,
        periodo: `${tipoDe(p.tipo)[0]} · ${p.start_date || p.finish_date ? `${dia(p.start_date)} → ${dia(p.finish_date)}` : "sem data"}`,
        itensTxt: [p.na ? `${p.na} na promoção` : null, p.cand ? `${p.cand} candidatos` : null].filter(Boolean).join(" · ") || "sem itens",
        fimTxt: st === "andamento" && dias <= 1 ? (dias <= 0 ? "acaba hoje" : "acaba amanhã") : null,
        match: matchDe(p.promocao_id), apagada: !!filtro && matchDe(p.promocao_id) === 0,
      };
    }),
  ];
  const promoSel = promos.find((p) => p.promocao_id === selId) ?? null;

  // ---------------------------------------------------------------- linhas da tabela
  const estadoDe = (i: Item): [EstadoLinha, string | null] => {
    const r = res.get(chave(i));
    if (r) return [r.tipo, r.motivo];
    const fe = i.frete_estimado ? "frete estimado" : null;
    const junta = (...x: Array<string | null>) => x.filter(Boolean).join(" · ") || null;
    if (i.status === "started") return ["na", junta(i.mc_negativa ? "no prejuízo: avalie tirar" : null, fe)];
    const d = decisoes.get(chave(i));
    const min = regra ? PCT(regra.mc_min_pct, 0) : "15%";
    switch (d?.decisao) {
      case "auto": return ["auto", junta(`MC ≥ ${min}`, regra?.modo === "ligado" ? "entra na próxima rodada" : "o robô não está ligado", fe)];
      case "confirmar": return ["aguardando", junta(`MC abaixo de ${min}: só entra se você aplicar`, fe)];
      case "trocar": return ["troca", junta(`sai de “${d.ativo_nome ?? "promoção atual"}”${d.ganho_troca != null ? ` · +${BRL(num(d.ganho_troca))}/un` : ""}`, fe)];
      case "outra_melhor": return ["melhor", "rende mais em outra promoção desta lista"];
      case "manter_atual": return ["outra", `já em “${d.ativo_nome ?? "outra promoção"}”, que rende igual ou mais`];
      default: return ["candidata", fe];
    }
  };
  const base = itens.filter((i) => {
    if (selId !== "todas" && i.promocao_id !== selId) return false;
    if (filtro && !passa(i, filtro)) return false;
    if (statusF !== "todos" && (statusF === "started" ? i.status !== "started" : i.status === "started")) return false;
    if (soFull && i.logistic_type !== "fulfillment") return false;
    return true;
  });
  const ordenados = [...base].sort((a, z) => {
    const nulo = (x: number | null | undefined) => x == null;
    switch (ordem) {
      case "novos": return (z.date_created ?? "").localeCompare(a.date_created ?? "");
      case "mc": return nulo(a.mc_promo_pct) ? 1 : nulo(z.mc_promo_pct) ? -1 : num(a.mc_promo_pct) - num(z.mc_promo_pct);
      case "queda": return nulo(a.delta_mc) ? 1 : nulo(z.delta_mc) ? -1 : num(a.delta_mc) - num(z.delta_mc);
      default: return v30De(z) - v30De(a);
    }
  });
  const porChave = new Map(ordenados.map((i) => [chave(i), i]));
  const linhas: LinhaPromo[] = ordenados.map((i) => {
    const [estado, motivo] = estadoDe(i);
    const t = tipoDe(i.promocao_tipo)[0];
    const sub = [selId === "todas" ? i.promocao_nome ?? t : t, i.logistic_type === "fulfillment" ? "Full" : null,
      i.meli_percentage ? `ML banca ${num(i.meli_percentage).toFixed(0)}%` : null].filter(Boolean).join(" · ");
    const m = contaML(i);
    return {
      key: chave(i), grupo: i.mlb, nome: i.titulo ?? i.mlb, sub, foto: i.foto, sku: i.sku, code: i.mlb,
      cheio: num(i.original_price), promo: num(i.promo_price), estado, motivo,
      v30: i.sku ? v30De(i) : null, estoque: estoque.get(i.mlb) ?? null,
      conta: () => m, cmv: i.cmv ?? null, semCusto: i.cmv == null,
      mcNota: i.cmv != null && i.comissao_promo == null ? "comissão ainda não calculada (sincronize)" : null,
    };
  });

  // ---------------------------------------------------------------- ações
  async function sincronizar() {
    if (girando) return;
    setGirando(true);
    try {
      const d = await chamarML("modulo=sync");
      if (d.erro) throw new Error(d.erro);
      const rl = await chamarML("modulo=relampago").catch(() => null);
      toast.success(`Sincronizado: ${d.gravados ?? 0} itens atualizados`, {
        description: rl && !rl.erro ? `Relâmpago: ${rl.verificados} anúncios com venda conferidos · ${rl.com_relampago} com oferta disponível` : undefined,
      });
      setRes(new Map());
      await qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) { toast.error("Falha ao sincronizar", { description: (e as Error).message }); }
    finally { setGirando(false); }
  }
  // Puxa TODAS as promoções elegíveis do item buscado — inclui as que o ML não pôs no listing curado.
  async function buscarElegiveis() {
    const termo = busca.trim();
    if (!termo) { toast.info("Digite um SKU ou MLB na busca primeiro."); return; }
    setBuscandoEleg(true);
    try {
      let lista: string[] = [];
      if (/^MLB\d+$/i.test(termo)) lista = [termo.toUpperCase()];
      else {
        const { data } = await supabaseExternal.from("ml_anuncios").select("mlb").eq("sku", termo).limit(8);
        lista = (data ?? []).map((r: { mlb: string }) => r.mlb);
      }
      if (!lista.length) { toast.warning("Nenhum anúncio do Mercado Livre com esse SKU ou MLB."); return; }
      let add = 0;
      for (const mlb of lista) { const d = await chamarML(`modulo=item&mlb=${mlb}`, true); if (d.erro) throw new Error(d.erro); add += d.adicionados ?? 0; }
      toast.success(add > 0 ? `${add} promoção(ões) elegível(is) adicionada(s)` : "Nenhuma promoção elegível nova para esse item");
      await qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) { toast.error("Falha ao buscar elegíveis", { description: (e as Error).message }); }
    finally { setBuscandoEleg(false); }
  }
  async function mudarModo(modo: ModoRobo) {
    if (!regra || modo === regra.modo) return;
    const nAuto = conta("auto");
    if (modo === "ligado" && !window.confirm(
      `Ligar a entrada automática?\n\nO sistema vai entrar SOZINHO, 3 vezes ao dia, nas promoções do Mercado Livre em que a margem de contribuição no preço da promoção for ≥ ${PCT(regra.mc_min_pct, 0)} (até ${regra.max_por_rodada} por rodada).\n\nHoje entrariam ${nAuto} anúncio(s). Relâmpago ativo não pode ser removido depois. Cada entrada avisa no Discord (#atualizacoes).`,
    )) return;
    const { error } = await supabaseExternal.from("ml_promo_regra").update({ modo, atualizado_por: perfil?.nome ?? null, atualizado_em: new Date().toISOString() }).eq("id", 1);
    if (error) { toast.error("Falha ao mudar o modo", { description: error.message }); return; }
    toast.success(modo === "ligado" ? "Entrada automática LIGADA" : modo === "simulacao" ? "Modo simulação" : "Entrada automática desligada");
    void qc.invalidateQueries({ queryKey: ["promocoes-ml", "regra"] });
  }
  async function rodarRobo() {
    if (!regra || regra.modo === "desligado") return;
    if (regra.modo === "ligado" && !window.confirm(`Rodar o robô agora?\n\nEle entra DE VERDADE nas promoções que passam na regra (hoje ${conta("auto")} anúncio(s), até ${regra.max_por_rodada}).`)) return;
    setRodandoRobo(true);
    try {
      const r = await chamarML("modulo=auto");
      if (r.erro) throw new Error(r.erro);
      if (r.modo !== "ligado") toast.info(`Simulação: entrariam ${r.aplicaria} anúncio(s) agora`, { description: (r.itens ?? []).slice(0, 6).map((i: any) => `${i.sku ?? i.mlb} · ${i.promocao_nome ?? "Relâmpago"} · MC ${PCT(Number(i.mc_promo_pct))}`).join("\n") });
      else toast.success(`Entraram ${r.entraram} anúncio(s)${r.falhas ? ` · ${r.falhas} recusa(s)` : ""}`, { description: (r.itens ?? []).filter((i: any) => !i.ok).slice(0, 4).map((i: any) => `${i.sku ?? i.mlb}: ${i.mensagem}`).join("\n") || undefined, duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) { toast.error("Falha ao rodar a regra", { description: (e as Error).message }); }
    finally { setRodandoRobo(false); }
  }

  // ---------------------------------------------------------------- robô (última rodada)
  const acoes = acoesQ.data ?? [];
  const ultima = acoes[0];
  const rodada = ultima ? acoes.filter((a) => Math.abs(Date.parse(a.criado_em) - Date.parse(ultima.criado_em)) < 10 * 60_000) : [];
  const nEnt = rodada.filter((a) => a.ok && a.acao === "auto").length, nPreco = rodada.filter((a) => a.ok && a.acao === "auto-preco").length;
  const nTrocou = rodada.filter((a) => a.ok && a.acao.startsWith("auto-troca")).length, nRecusa = rodada.filter((a) => !a.ok).length;

  // ---------------------------------------------------------------- cabeçalho e detalhe
  const ultSync = (promosQ.data ?? []).reduce<string | null>((m, p) => (p.atualizado_em && (!m || p.atualizado_em > m) ? p.atualizado_em : m), null);
  const minAtras = ultSync ? Math.max(0, Math.round((Date.now() - Date.parse(ultSync)) / 60000)) : null;
  const erro = (promosQ.error ?? itensQ.error) as Error | null;
  const nNa = itens.filter((i) => i.status === "started").length;
  const resumo = [{ v: INT(nNa), k: "anúncios em promoção" }, { v: INT(itens.length - nNa), k: "candidatos" }, { v: INT(promos.length), k: "promoções ativas" }];

  let wsc = 0, msc = 0, v30c = 0;
  for (const i of base) { const v = v30De(i); v30c += v; if (i.mc_promo != null && v > 0) { wsc += num(i.promo_price) * v; msc += num(i.mc_promo) * v; } }
  const dres: Array<{ t: string; cor: string }> = [
    { t: `${base.length} ${base.length === 1 ? "item" : "itens"}`, cor: "var(--pm-t2)" },
    { t: `MC média ${wsc ? PCT(msc / wsc) : "—"} (pesada pelas vendas)`, cor: "var(--pm-t2)" },
    { t: `${INT(v30c)} vendas em 30 dias`, cor: "var(--pm-t2)" },
  ];
  const nNegB = base.filter((i) => i.mc_negativa).length, nSemB = base.filter((i) => i.cmv == null).length;
  if (nNegB) dres.push({ t: `${nNegB} com MC negativa`, cor: "var(--pm-r)" });
  if (nSemB) dres.push({ t: `${nSemB} sem custo cadastrado`, cor: "var(--pm-am)" });

  const stSel: StatusPromo | null = promoSel ? (promoSel.status === "pending" ? "programada" : promoSel.na > 0 ? "andamento" : "adesao") : null;
  const cabecalho: ReactNode = (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{promoSel ? promoSel.nome ?? promoSel.promocao_id : filtro ? `Todas · ${FILTRO_NOME[filtro]}` : "Todas as promoções"}</h3>
        {stSel && <Chip bg={PST[stSel][1]} cor={PST[stSel][2]} size={10.5}>{PST[stSel][0]}</Chip>}
        {promoSel && <Chip bg={`${tipoDe(promoSel.tipo)[1]}1c`} cor={tipoDe(promoSel.tipo)[1]} size={10.5}>{tipoDe(promoSel.tipo)[0]}</Chip>}
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>
          {promoSel
            ? <><span className="pm-mono">{promoSel.start_date || promoSel.finish_date ? `${dia(promoSel.start_date)} → ${dia(promoSel.finish_date)}` : "sem data"}</span>{promoSel.deadline_date ? ` · adesão até ${dia(promoSel.deadline_date)}` : ""}</>
            : "cada anúncio aparece uma vez por promoção em que pode entrar"}
        </span>
        <div style={{ flex: 1 }} />
        <Btn onClick={() => void buscarElegiveis()} disabled={buscandoEleg || !busca.trim()}
          title="Puxa TODAS as promoções elegíveis do SKU ou MLB digitado na busca, inclusive as que o ML não pôs na lista da campanha">
          {buscandoEleg ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <Search style={{ width: 14, height: 14 }} />}Elegíveis do item
        </Btn>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12 }}>
        {dres.map((d) => <span key={d.t} style={{ color: d.cor }}>{d.t}</span>)}
      </div>
    </>
  );
  const extra = (lp: LinhaPromo) => {
    const i = porChave.get(lp.key); if (!i) return null;
    if (i.mc_atual_pct == null) return <span className="pm-mono" style={{ fontSize: 12, color: "var(--pm-t3)" }}>—</span>;
    return (
      <>
        <span className="pm-mono" style={{ fontSize: 12.5, color: corMc(num(i.mc_atual_pct)) }}>{PCT(num(i.mc_atual_pct))}</span>
        {i.delta_mc != null && <span className="pm-mono" style={{ fontSize: 10.5, color: num(i.delta_mc) < 0 ? "var(--pm-r)" : "var(--pm-g)", whiteSpace: "nowrap" }}>{num(i.delta_mc) < 0 ? "" : "+"}{BRL(num(i.delta_mc))}/un</span>}
      </>
    );
  };
  const btnIcone = (title: string, onClick: () => void, icone: ReactNode, hover: string, cor = "var(--pm-t3)") => (
    <button type="button" title={title} onClick={onClick} className={hover}
      style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: cor, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>{icone}</button>
  );
  const acoesLinha = (lp: LinhaPromo) => {
    const i = porChave.get(lp.key); if (!i) return null;
    const d = decisoes.get(lp.key);
    const ic = { width: 14, height: 14 };
    let principal: ReactNode = null;
    if (i.status === "started") principal = btnIcone("Tirar desta promoção", () => setAcao({ item: i, tipo: "remover" }), <Trash2 style={ic} />, "hover:bg-[var(--pm-rs)] hover:text-[var(--pm-r)]");
    else if (d?.decisao === "trocar" && d.ativo_promocao_id) principal = btnIcone(`Trocar: sai de ${d.ativo_nome ?? "promoção atual"} e entra nesta`, () => setAcao({ item: i, tipo: "trocar", d }), <ArrowLeftRight style={ic} />, "hover:bg-[var(--pm-as)]", "var(--pm-at)");
    else if (i.mc_promo != null) principal = btnIcone("Aplicar esta promoção", () => setAcao({ item: i, tipo: "aplicar" }), <CirclePlus style={ic} />, "hover:bg-[var(--pm-as)] hover:text-[var(--pm-at)]", i.mc_negativa ? "var(--pm-r)" : "var(--pm-t2)");
    return (
      <>
        {principal}
        {i.permalink && btnIcone("Abrir o anúncio no Mercado Livre", () => window.open(i.permalink!, "_blank", "noopener"), <ExternalLink style={ic} />, "hover:bg-[var(--pm-s2)]")}
      </>
    );
  };
  const segBtn = <T extends string>(atual: T, set: (v: T) => void, ops: ReadonlyArray<readonly [T, string]>) => (
    <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8 }}>
      {ops.map(([id, nome]) => (
        <button key={id} type="button" onClick={() => set(id)} style={{ border: 0, cursor: "pointer", padding: "3px 9px", borderRadius: 6, fontSize: 11.5, whiteSpace: "nowrap", ...seg(atual === id) }}>{nome}</button>
      ))}
    </div>
  );

  const carregando = promosQ.isLoading || itensQ.isLoading;
  return (
    <>
      <CabecalhoMkt {...cab} mkts={cab.mkts.map((m) => (m.id === "ml" ? { ...m, alerta: nNeg } : m))}
        sync={{ txt: girando ? "sincronizando…" : erro ? "falhou" : minAtras == null ? "—" : minAtras < 1 ? "agora" : minAtras < 120 ? `há ${minAtras} min` : `há ${Math.round(minAtras / 60)} h`, tom: erro ? "r" : minAtras != null && minAtras > 26 * 60 ? "am" : "ok", girando, onClick: () => void sincronizar() }}
        resumo={resumo} />

      <FaixaDecisao sub={`hoje, ${new Date().toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" })} · Mercado Livre · Ottz · clique num contador para filtrar`}
        cards={cards} carregando={carregando} filtroNome={filtro ? FILTRO_NOME[filtro] : null} onLimpar={() => setFiltro(null)} />

      {erro ? <ErroLeitura mktDe="do Mercado Livre" msg={erro.message} onTentar={() => void qc.invalidateQueries({ queryKey: ["promocoes-ml"] })} /> : (
        <div className="grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)]" style={{ gap: 16, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <ListaPromos titulo="Promoções" itens={itensLista} sel={selId} carregando={carregando}
              onSel={(id) => { setSelId(id); setBusca(""); setFaixa("todas"); setSel(new Set()); }} />
            <CartaoRobo nome="Entrada automática" desc="Entra sozinho nas promoções em que a MC passa na regra"
              modo={regra?.modo ?? "desligado"} modos={["desligado", "simulacao", "ligado"]} onModo={regra ? (m) => void mudarModo(m) : undefined}
              ultima={ultima ? diaHora(ultima.criado_em) : "—"} proxima={proximaRodada()}
              params={regra ? [
                { k: "MC mínima", v: PCT(regra.mc_min_pct, 0) },
                { k: "Troca se ganhar", v: `+${BRL(regra.ganho_min_troca)}/un` },
                { k: "Por rodada", v: `até ${regra.max_por_rodada}` },
              ] : []}
              fez={`${conta("auto")} ${regra?.modo === "ligado" ? "entram na próxima rodada" : "entrariam"}, ${conta("aguardando")} aguardando você, ${conta("troca")} sugestão(ões) de troca.${ultima ? ` Na última rodada: ${nEnt} entrada(s)${nPreco ? `, ${nPreco} com preço ajustado` : ""}${nTrocou ? `, ${nTrocou} troca(s)` : ""}${nRecusa ? `, ${nRecusa} recusa(s)` : ""}.` : ""}`}
              rodape={regra && regra.modo !== "desligado" ? (
                <button type="button" onClick={() => void rodarRobo()} disabled={rodandoRobo} className="hover:bg-[var(--pm-s2)]"
                  style={{ height: 28, borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  {rodandoRobo && <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />}{regra.modo === "ligado" ? "Rodar agora" : "Simular agora"}
                </button>
              ) : undefined} />
          </div>

          <TabelaPromo
            cabecalho={cabecalho} linhas={linhas} editavel={false}
            drafts={new Map()} setDraft={() => undefined} sel={sel} setSel={setSel}
            busca={busca} setBusca={setBusca} faixa={faixa} setFaixa={setFaixa}
            precoLabel="Cheio → promo" extraLabel="MC hoje"
            extra={(lp) => extra(lp)} acoes={(lp) => acoesLinha(lp)}
            carregando={carregando} carregandoTxt="Lendo as promoções do Mercado Livre…"
            ordem={(
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {segBtn(statusF, setStatusF, [["todos", "Todos"], ["started", "Na promoção"], ["candidate", "Candidatos"]] as const)}
                <button type="button" onClick={() => setSoFull(!soFull)}
                  style={{ height: 26, padding: "0 9px", borderRadius: 7, border: `1px solid ${soFull ? "var(--pm-a)" : "var(--pm-b)"}`, background: soFull ? "var(--pm-as)" : "var(--pm-s)", color: soFull ? "var(--pm-at)" : "var(--pm-t2)", cursor: "pointer", fontSize: 11.5 }}>Só Full</button>
                {segBtn(ordem, setOrdem, [["vendas", "Mais vendidos"], ["novos", "Mais novos"], ["mc", "Menor MC"], ["queda", "Maior queda"]] as const)}
              </div>
            )}
            lote={{ onAlvo: () => undefined, onDesc: () => undefined }}
            rodape="MC = receita (preço da promoção + co-financiamento do ML) − comissão − frete − imposto − CMV, por unidade, calculada no banco. Passe o mouse na MC para ver a conta. “MC hoje” é a margem no preço cheio e, embaixo, quanto ela muda por unidade ao entrar. O ML define o preço da maioria das promoções; quando há faixa, o preço é escolhido ao aplicar. Nada vai para o Mercado Livre sem a sua confirmação." />
        </div>
      )}

      {acao && (
        <DialogoAcaoML key={chave(acao.item) + acao.tipo} acao={acao} nomeUsuario={perfil?.nome ?? null}
          onFechar={() => setAcao(null)}
          onResultado={(r) => {
            setRes((m) => new Map(m).set(chave(acao.item), r));
            if (r.tipo === "aplicado") void qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
          }} />
      )}
    </>
  );
}

// ============================================================================
// Diálogo de aplicar / remover / trocar — confere a promoção AO VIVO no ML antes
// (faixa de preço, estoque do Relâmpago, se ainda está disponível) e simula a MC
// no preço escolhido. Mesma lógica do modal da tela antiga.
// ============================================================================
function DialogoAcaoML({ acao, nomeUsuario, onFechar, onResultado }: {
  acao: { item: Item; tipo: "aplicar" | "remover" | "trocar"; d?: LinhaDecisao };
  nomeUsuario: string | null; onFechar: () => void; onResultado: (r: Res) => void;
}) {
  const { item, tipo, d } = acao;
  const aplicar = tipo === "aplicar";
  const [vivo, setVivo] = useState<Vivo | null | "ausente">(null);
  const [vivoLoading, setVivoLoading] = useState(aplicar);
  const [preco, setPreco] = useState<number | null>(item.promo_price);
  const [precoTxt, setPrecoTxt] = useState(item.promo_price != null ? String(item.promo_price) : "");
  const [sim, setSim] = useState<{ mc: number | null; mc_pct: number | null } | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [estoque, setEstoque] = useState<number | null>(null);
  const [executando, setExecutando] = useState(false);
  const [fim, setFim] = useState<Res | null>(null);

  useEffect(() => {
    if (!aplicar) return;
    let cancelado = false;
    chamarML(`modulo=estado&mlb=${item.mlb}&promocao_id=${encodeURIComponent(item.promocao_id)}&tipo=${item.promocao_tipo ?? ""}`)
      .then((r) => {
        if (cancelado) return;
        const p = r.promocao as Vivo | null;
        if (!p) { setVivo("ausente"); return; }
        setVivo(p);
        // preço dentro da faixa que o ML aceita AGORA (o sugerido pode passar do máximo)
        const b = item.promo_price ?? p.sugerido ?? p.preco ?? null;
        const ajuste = b != null && p.max != null && b > p.max ? p.max : b != null && p.min != null && b < p.min ? p.min : null;
        if (ajuste != null) { setPreco(ajuste); setPrecoTxt(String(ajuste)); }
        if (p.estoque_min != null) setEstoque(p.estoque_min);
      })
      .catch(() => { if (!cancelado) setVivo(null); })
      .finally(() => { if (!cancelado) setVivoLoading(false); });
    return () => { cancelado = true; };
  }, [aplicar, item]);

  useEffect(() => {
    if (!aplicar || preco == null) return;
    if (preco === item.promo_price) { setSim(null); return; } // usa a MC já calculada
    const t = setTimeout(async () => {
      setSimLoading(true);
      try {
        const r = await chamarML(new URLSearchParams({ modulo: "simular", mlb: item.mlb, promocao_id: item.promocao_id, preco: String(preco) }).toString());
        setSim({ mc: r.mc ?? null, mc_pct: r.mc_pct ?? null });
      } catch { setSim(null); } finally { setSimLoading(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [aplicar, preco, item]);

  const vv = vivo && vivo !== "ausente" ? vivo : null;
  const fMin = vv?.min ?? item.preco_min, fMax = vv?.max ?? item.preco_max;
  const ajustavel = aplicar && fMin != null && fMax != null && !item.offer_id;
  const relampago = ehRelampago(item.promocao_tipo);
  const indisponivel = aplicar && vivo === "ausente";
  const foraFaixa = aplicar && preco != null && ((fMin != null && preco < fMin - 0.001) || (fMax != null && preco > fMax + 0.001));
  const usandoSim = ajustavel && sim != null && preco != null && preco !== item.promo_price;
  const mcPara = tipo === "remover" ? item.mc_atual : usandoSim ? sim!.mc : item.mc_promo;
  const mcParaPct = tipo === "remover" ? item.mc_atual_pct : usandoSim ? sim!.mc_pct : item.mc_promo_pct;
  const mcDe = tipo === "remover" ? item.mc_promo : tipo === "trocar" ? d?.ativo_mc ?? null : item.mc_atual;
  const mcDePct = tipo === "remover" ? item.mc_promo_pct : tipo === "trocar" ? null : item.mc_atual_pct;
  const precoDe = tipo === "remover" ? num(item.promo_price) : tipo === "trocar" ? null : num(item.original_price);
  const precoPara = tipo === "remover" ? num(item.original_price) : num(preco ?? item.promo_price);
  const neg = tipo !== "remover" && mcPara != null && mcPara < 0;
  const bloqueado = executando || simLoading || (aplicar && (vivoLoading || indisponivel || foraFaixa || (relampago && !estoque)));

  async function executar() {
    setExecutando(true);
    try {
      let p: URLSearchParams;
      if (tipo === "trocar") {
        p = new URLSearchParams({ modulo: "trocar", mlb: item.mlb, de_promocao_id: d!.ativo_promocao_id!, de_tipo: d!.ativo_tipo ?? "", para_promocao_id: item.promocao_id, para_tipo: item.promocao_tipo ?? "", confirmar: "1" });
        if (item.offer_id) p.set("offer_id", item.offer_id); else if (item.promo_price != null) p.set("deal_price", String(item.promo_price));
      } else {
        p = new URLSearchParams({ modulo: tipo, mlb: item.mlb, promocao_id: item.promocao_id, tipo: item.promocao_tipo ?? "", confirmar: "1" });
        if (aplicar) {
          if (item.offer_id) p.set("offer_id", item.offer_id);
          else { const dp = preco ?? item.promo_price; if (dp != null) p.set("deal_price", String(dp)); }
          if (estoque != null) p.set("stock", String(estoque));
        }
      }
      if (nomeUsuario) p.set("por", nomeUsuario);
      const r = await chamarML(p.toString(), true);
      if (r.erro) throw new Error(r.erro);
      const resultado: Res = r.ok
        ? { tipo: "aplicado", motivo: r.ja_estava ? r.mensagem ?? "já estava nesta promoção" : tipo === "remover" ? "saiu da promoção" : tipo === "trocar" ? r.mensagem ?? "troca feita" : "entrou na promoção" }
        : { tipo: "recusado", motivo: r.mensagem ?? "o Mercado Livre não deu o motivo" };
      setFim(resultado); onResultado(resultado);
    } catch (e) {
      const resultado: Res = { tipo: "recusado", motivo: (e as Error).message };
      setFim(resultado); onResultado(resultado);
    } finally { setExecutando(false); }
  }

  const titulo = tipo === "aplicar" ? "Aplicar promoção no Mercado Livre" : tipo === "remover" ? "Tirar da promoção no Mercado Livre" : "Trocar de promoção no Mercado Livre";
  const linha = (k: string, v: ReactNode) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, fontSize: 12.5 }}>
      <span style={{ color: "var(--pm-t2)" }}>{k}</span><span className="pm-mono" style={{ whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
  const aviso = (txt: ReactNode, tom: "r" | "am") => (
    <div style={{ fontSize: 12.5, padding: "8px 10px", borderRadius: 8, background: tom === "r" ? "var(--pm-rs)" : "var(--pm-ams)", color: tom === "r" ? "var(--pm-r)" : "var(--pm-am)", textWrap: "pretty" }}>{txt}</div>
  );
  const inputSt = { height: 30, width: 110, borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 12.5, padding: "0 8px", outline: "none", textAlign: "right" as const };
  const chipBtn = (rot: string, v: number | null) => v == null ? null : (
    <button type="button" onClick={() => { setPreco(v); setPrecoTxt(String(v)); }} className="hover:bg-[var(--pm-s2)]"
      style={{ height: 28, padding: "0 9px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t2)", cursor: "pointer", fontSize: 11.5 }}>{rot} {BRL(v)}</button>
  );

  return (
    <div className="pm-ui" style={{ position: "fixed", inset: 0, zIndex: 50, background: "oklch(0.15 0.01 285 / 0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={(e) => { if (e.target === e.currentTarget && !executando) onFechar(); }}>
      <div style={{ width: "min(480px,100%)", maxHeight: "calc(100vh - 48px)", overflow: "auto", display: "flex", flexDirection: "column", gap: 12, padding: "16px 18px", background: "var(--pm-s)", color: "var(--pm-t)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-shl)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <h3 style={{ margin: 0, flex: 1, fontSize: 16, fontWeight: 600 }}>{titulo}</h3>
          {!executando && <button type="button" onClick={onFechar} className="hover:bg-[var(--pm-s2)]" style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", cursor: "pointer", color: "var(--pm-t3)", display: "flex", alignItems: "center", justifyContent: "center" }}><X style={{ width: 16, height: 16 }} /></button>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {item.foto ? <img src={item.foto} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover", border: "1px solid var(--pm-b)" }} /> : null}
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 500, fontSize: 13 }}>{item.titulo ?? item.mlb}</span>
            <span className="pm-mono" style={{ fontSize: 11, color: "var(--pm-t3)" }}>SKU {item.sku ?? "—"} · {item.mlb} · {item.promocao_nome ?? tipoDe(item.promocao_tipo)[0]}</span>
          </div>
        </div>

        {tipo === "trocar" && d && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 10px", borderRadius: 8, background: "var(--pm-s2)", fontSize: 12.5 }}>
            <span>Sai de <b style={{ fontWeight: 600 }}>{d.ativo_nome ?? d.ativo_promocao_id}</b>{d.ativo_mc != null && <span className="pm-mono"> · MC {BRL(num(d.ativo_mc))}/un</span>}</span>
            <span>Entra em <b style={{ fontWeight: 600 }}>{item.promocao_nome ?? item.promocao_id}</b><span className="pm-mono"> · MC {BRL(num(item.mc_promo))}/un{d.ganho_troca != null ? ` (+${BRL(num(d.ganho_troca))})` : ""}</span></span>
            <span style={{ color: "var(--pm-t3)", fontSize: 11.5 }}>Se a nova recusar, o app tenta voltar para a anterior.</span>
          </div>
        )}

        {aplicar && vivoLoading && <span style={{ fontSize: 12, color: "var(--pm-t3)", display: "flex", alignItems: "center", gap: 6 }}><Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />Conferindo a promoção no Mercado Livre…</span>}
        {indisponivel && aviso(<>O Mercado Livre <b>não oferece mais</b> esta promoção para este anúncio — a lista estava desatualizada. Feche e sincronize.</>, "am")}
        {ajustavel && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>Preço da promoção — entre {BRL(num(fMin))} e {BRL(num(fMax))}{vv ? ", conferido agora no ML" : ""}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input value={precoTxt} inputMode="decimal" className="pm-mono" style={inputSt}
                onChange={(e) => { setPrecoTxt(e.target.value); const v = Number(e.target.value.replace(",", ".")); setPreco(Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null); }} />
              {chipBtn("Sugerido", item.preco_sugerido)}{chipBtn("Mín", fMin)}{chipBtn("Máx", fMax)}
            </div>
          </div>
        )}
        {aplicar && relampago && vv && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>Unidades reservadas para o Relâmpago{vv.estoque_min != null ? ` (mín. ${vv.estoque_min}${vv.estoque_max != null ? `, máx. ${vv.estoque_max}` : ""})` : ""} — quando acabam, a oferta encerra</span>
            <input value={estoque ?? ""} inputMode="numeric" className="pm-mono" style={inputSt}
              onChange={(e) => { const v = Math.floor(Number(e.target.value)); setEstoque(Number.isFinite(v) && v > 0 ? v : null); }} />
            {vv.inicio && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Janela: {diaHora(vv.inicio)}{vv.fim ? ` → ${diaHora(vv.fim)}` : ""}</span>}
          </div>
        )}
        {foraFaixa && aviso(`Preço fora da faixa aceita pelo ML (${BRL(num(fMin))} a ${BRL(num(fMax))}).`, "r")}

        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 10, background: "var(--pm-s2)" }}>
          {linha("Preço público", <>{precoDe != null ? `${BRL(precoDe)} → ` : ""}<b style={{ fontWeight: 600 }}>{BRL(precoPara)}</b></>)}
          {linha("MC por unidade", (
            <>
              {mcDe != null ? <span style={{ color: "var(--pm-t3)" }}>{BRL(num(mcDe))}{mcDePct != null ? ` (${PCT(num(mcDePct))})` : ""} → </span> : null}
              <b style={{ fontWeight: 600, color: mcPara == null ? "var(--pm-t3)" : corMc(num(mcParaPct ?? mcPara)) }}>{mcPara == null ? "—" : BRL(num(mcPara))}</b>
              {mcParaPct != null && <span style={{ color: "var(--pm-t3)" }}> ({PCT(num(mcParaPct))})</span>}
              {simLoading && <Loader2 className="animate-spin" style={{ width: 11, height: 11, marginLeft: 4, display: "inline" }} />}
            </>
          ))}
        </div>
        {neg && aviso(<>Com este preço a margem fica <b>negativa</b> ({BRL(num(mcPara))}/un): venderia no prejuízo.</>, "r")}

        {fim ? (
          <>
            {fim.tipo === "aplicado"
              ? <div style={{ fontSize: 12.5, padding: "8px 10px", borderRadius: 8, background: "var(--pm-gs)", color: "var(--pm-g)" }}>Feito: {fim.motivo}.</div>
              : aviso(<>O Mercado Livre não aceitou: {fim.motivo}</>, "r")}
            <div style={{ display: "flex", justifyContent: "flex-end" }}><Btn primario onClick={onFechar}>Fechar</Btn></div>
          </>
        ) : (
          <>
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Muda o preço público do anúncio no Mercado Livre na hora.</span>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onFechar} disabled={executando}>Cancelar</Btn>
              <Btn primario onClick={() => void executar()} disabled={bloqueado}>
                {executando && <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />}
                {tipo === "aplicar" ? (neg ? "Aplicar mesmo assim" : "Confirmar e aplicar") : tipo === "remover" ? "Confirmar e tirar" : "Confirmar troca"}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
