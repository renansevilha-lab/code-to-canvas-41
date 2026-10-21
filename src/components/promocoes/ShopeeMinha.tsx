import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import {
  AvisoCustoTiny, atualizarCatalogoShopee, calcMc, chamarPromocoes, comissaoShopee, num, sincronizarRecentesShopee,
  tetoRelampago, traduzirErroShopee, useCustoTinyAutomatico, useTarifaShopee, type McBase, type Tarifa,
} from "./comum";
import { AdicionarAoDesconto } from "./AdicionarAoDesconto";
import { PainelPromoDiaria, RepetirDiario } from "./PromoDiaria";
import {
  BRL, Btn, CabecalhoMkt, CartaoRobo, Chip, ErroLeitura, FaixaDecisao, IN, INT, ListaPromos, PCT, PST, PreviaAplicar, TabelaPromo,
  parseNum, seg, type CartaoDecisao, type ContaMc, type EstadoLinha, type ItemLista, type ItemPrevia, type LinhaPromo, type MktTab, type StatusPromo,
} from "./ui/kit";

// ============================================================================
// Shopee › Minha Promoção no design novo (Claude Design "Promoções", 21/out/2026).
// Mesmos dados e as mesmas escritas da tela antiga (MinhaPromocao.tsx):
//   · descontos da loja ao vivo (shopee-promocoes list/detalhe) + foto/SKU do espelho;
//   · MC = preço − comissão (tabela Shopee vigente) − imposto efetivo − CMV (RPC promo_mc_base);
//   · aplicar = atualizar-itens&confirmar=1&propagar=1 (preço + limite, promoção diária junto);
//     tirar = remover-item&confirmar=1, um por vez; sempre pela prévia "de → para".
// Novo: faixa "Pede decisão" com contadores das promoções vivas (em andamento + programadas),
// "Fora de promoção" (20+ vendas em 30 dias e em nenhuma campanha — modulo=em-campanha),
// resultado por linha (aplicado / recusado com o motivo da Shopee).
// ============================================================================

interface Desconto { discount_id: number; discount_name: string; start_time: number; end_time: number; status: string }
interface ModeloApi { model_id: number; model_name?: string; model_original_price: number; model_promotion_price: number; model_normal_stock?: number }
interface ItemApi {
  item_id: number; item_name: string; purchase_limit: number;
  item_original_price?: number; item_promotion_price?: number; normal_stock?: number; model_list?: ModeloApi[];
}
interface Linha {
  key: string; item_id: number; model_id: number; nome: string; variacao: string | null;
  original: number; promo: number; estoque: number | null; limite: number;
  sku: string | null; imagem: string | null; primeiraDoItem: boolean; pos: number;
}
interface AnuncioBusca { item_id: number; nome: string; sku_pai: string | null; tem_variacao: boolean; preco_min: number | null; preco_max: number | null; estoque_total: number | null; imagem_url: string | null; vendas_30d: number }
interface Recorrente { id: number; nome: string; ativo: boolean; dias_antecedencia: number; hora_inicio: string; origem_discount_id: number | null }
interface Criada { recorrente_id: number; dia: string; discount_id: number | null; status: string; itens_ok: number; itens_falha: number }

export interface CabBase {
  mkts: MktTab[]; mkt: string; onMkt: (id: string) => void;
  lojaRot: string; lojas: Array<{ id: number; nome: string }>; loja: number; onLoja: (id: string | number) => void;
  subtabs: Array<{ id: string; nome: string }>; sub: string; onSub: (id: string) => void;
}

const TZ = "America/Sao_Paulo";
const diaBR = (epoch: number) => new Date(epoch * 1000).toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const diaHoraBR = (epoch: number) => new Date(epoch * 1000).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const ymd = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
/** Dias entre hoje e o dia do fim (datas de Brasília): 0 = acaba hoje. */
const diasAte = (epoch: number) => Math.round((Date.parse(ymd(epoch * 1000)) - Date.parse(ymd(Date.now()))) / 86400000);
const MIN_VENDAS_FORA = 20;
const ID_FORA = "fora";

/** Itens de um desconto (ao vivo) + foto/SKU do espelho — mesma leitura da tela antiga. */
async function lerDesconto(shopId: number, discountId: number): Promise<Linha[]> {
  const r = await chamarPromocoes(`modulo=detalhe&shop_id=${shopId}&discount_id=${discountId}`);
  if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
  const itens = (r.itens ?? []) as ItemApi[];
  const ids = [...new Set(itens.map((i) => i.item_id))];
  const anun = new Map<number, { imagem_url: string | null; sku_pai: string | null }>();
  const vars = new Map<number, { sku: string | null; nome_variacao: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const lote = ids.slice(i, i + 200);
    const [{ data: a }, { data: v }] = await Promise.all([
      supabaseExternal.from("shopee_anuncios").select("item_id, imagem_url, sku_pai").eq("shop_id", shopId).in("item_id", lote),
      supabaseExternal.from("shopee_anuncios_variacao").select("model_id, sku, nome_variacao").eq("shop_id", shopId).in("item_id", lote),
    ]);
    for (const x of (a ?? []) as { item_id: number; imagem_url: string | null; sku_pai: string | null }[]) anun.set(x.item_id, x);
    for (const x of (v ?? []) as { model_id: number; sku: string | null; nome_variacao: string | null }[]) vars.set(x.model_id, x);
  }
  const linhas: Linha[] = [];
  for (const it of itens) {
    const an = anun.get(it.item_id);
    const modelos = it.model_list ?? [];
    if (modelos.length > 0) {
      modelos.forEach((m, idx) => {
        const vv = vars.get(m.model_id);
        linhas.push({
          key: `${it.item_id}:${m.model_id}`, item_id: it.item_id, model_id: m.model_id, nome: it.item_name,
          variacao: m.model_name || vv?.nome_variacao || null, original: num(m.model_original_price), promo: num(m.model_promotion_price),
          estoque: m.model_normal_stock ?? null, limite: num(it.purchase_limit), sku: vv?.sku ?? an?.sku_pai ?? null,
          imagem: an?.imagem_url ?? null, primeiraDoItem: idx === 0, pos: linhas.length,
        });
      });
    } else {
      linhas.push({
        key: `${it.item_id}:0`, item_id: it.item_id, model_id: 0, nome: it.item_name, variacao: null,
        original: num(it.item_original_price), promo: num(it.item_promotion_price), estoque: it.normal_stock ?? null,
        limite: num(it.purchase_limit), sku: an?.sku_pai ?? null, imagem: an?.imagem_url ?? null, primeiraDoItem: true, pos: linhas.length,
      });
    }
  }
  return linhas;
}

/** Conta da MC por unidade (para o balão) — mesma regra do calcMc. */
export function contaShopee(base: McBase | undefined, preco: number, tarifa: Tarifa[] | undefined): ContaMc | null {
  const mc = calcMc(base, preco, tarifa);
  if (!mc || !base) return null;
  const tab = comissaoShopee(preco, tarifa);
  const rot = tab ? `Comissão Shopee ${(tab.faixa.pct * 100).toFixed(0)}% + ${BRL(tab.faixa.fixo_unidade)}` : `Comissão ${(num(base.com_pct) * 100).toFixed(1)}% (histórico)`;
  return {
    v: mc.mc, pct: mc.pct,
    linhas: [
      { k: "Preço", v: preco }, { k: `− ${rot}`, v: mc.comissao },
      { k: `− Imposto (${(num(base.imp_pct) * 100).toFixed(1).replace(".", ",")}%)`, v: preco * num(base.imp_pct) }, { k: "− CMV", v: num(base.cmv) },
    ],
  };
}
/** Menor preço que dá a MC alvo (iterando a faixa da tabela de comissão). */
export function precoParaShopee(base: McBase | undefined, tarifa: Tarifa[] | undefined, alvo: number, cheio: number): number | null {
  if (!base || base.cmv == null || base.imp_pct == null) return null;
  let p = cheio > 0 ? cheio : 50;
  for (let i = 0; i < 8; i++) {
    const tab = comissaoShopee(p, tarifa);
    const pct = tab ? tab.faixa.pct : num(base.com_pct); const fixo = tab ? tab.faixa.fixo_unidade : 0;
    const d = 1 - pct - num(base.imp_pct) - alvo;
    if (d <= 0) return null;
    p = (fixo + num(base.cmv)) / d;
  }
  return Math.ceil(p * 100) / 100;
}

type Filtro = "neg" | "lt10" | "fim" | "rec" | "semc";
const FILTRO_NOME: Record<Filtro, string> = { neg: "MC negativa", lt10: "MC abaixo de 10%", fim: "acabam hoje ou amanhã", rec: "recusados", semc: "sem custo" };

interface PreviaEstado {
  fase: "revisar" | "aplicando" | "resultado"; promoId: number; promoNome: string;
  itens: Array<{ tipo: "preco" | "saida"; l: Linha; lp: LinhaPromo; de: number; para: number; limDe: number; limPara: number; res?: ItemPrevia["res"] }>;
}

export function ShopeeMinha({ shopId, cab, onIrRelampago }: { shopId: number; cab: CabBase; onIrRelampago: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const tarifa = useTarifaShopee().data;
  const [selId, setSelId] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<Filtro | null>(null);
  const [busca, setBusca] = useState("");
  const [faixa, setFaixa] = useState("todas");
  const [ordem, setOrdem] = useState<"vendas" | "recentes">("vendas");
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [limDrafts, setLimDrafts] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [res, setRes] = useState<Map<string, { tipo: "aplicado" | "recusado" | "pulado"; motivo: string }>>(new Map());
  const [previa, setPrevia] = useState<PreviaEstado | null>(null);
  const [addPara, setAddPara] = useState<Desconto | null>(null);
  const [gerenciarDiaria, setGerenciarDiaria] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [clonando, setClonando] = useState<number | null>(null);

  // ---------------------------------------------------------------- promoções (listas ao vivo)
  const STATUS = ["ongoing", "upcoming", "expired"] as const;
  const listas = useQueries({
    queries: STATUS.map((st) => ({
      queryKey: ["promo-shopee", "lista", shopId, st], staleTime: 2 * 60_000,
      queryFn: async (): Promise<Desconto[]> => {
        const r = await chamarPromocoes(`modulo=list&shop_id=${shopId}&status=${st}`);
        if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
        return (r.descontos ?? []) as Desconto[];
      },
    })),
  });
  const [qOn, qUp, qEx] = listas;
  const andamento = useMemo(() => [...(qOn.data ?? [])].sort((a, b) => a.end_time - b.end_time), [qOn.data]);
  const programadas = useMemo(() => [...(qUp.data ?? [])].sort((a, b) => a.start_time - b.start_time), [qUp.data]);
  const encerradas = useMemo(() => [...(qEx.data ?? [])].sort((a, b) => b.end_time - a.end_time).slice(0, 5), [qEx.data]);
  const vivas = useMemo(() => [...andamento, ...programadas].slice(0, 15), [andamento, programadas]);
  const todasDesc = useMemo(() => [...andamento, ...programadas, ...encerradas], [andamento, programadas, encerradas]);
  const statusDe = (d: Desconto): StatusPromo => (d.status === "ongoing" ? "andamento" : d.status === "upcoming" ? "programada" : "encerrada");

  // seleção padrão: 1ª em andamento → programada → fora de promoção
  const selEfetivo = selId ?? (vivas[0] ? String(vivas[0].discount_id) : ID_FORA);
  const descSel = todasDesc.find((d) => String(d.discount_id) === selEfetivo) ?? null;
  const ehFora = selEfetivo === ID_FORA;

  // ---------------------------------------------------------------- itens das promoções vivas (+ a encerrada aberta)
  const paraLer = useMemo(() => {
    const ids = vivas.map((d) => d.discount_id);
    if (descSel && !ids.includes(descSel.discount_id)) ids.push(descSel.discount_id);
    return ids;
  }, [vivas, descSel]);
  const detalhes = useQueries({
    queries: paraLer.map((id) => ({
      queryKey: ["promo-shopee", "detalhe", shopId, id], staleTime: 60_000,
      queryFn: () => lerDesconto(shopId, id),
    })),
  });
  const linhasDe = useMemo(() => {
    const m = new Map<number, Linha[]>();
    paraLer.forEach((id, i) => { const d = detalhes[i]?.data; if (d) m.set(id, d); });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paraLer, ...detalhes.map((d) => d.dataUpdatedAt)]);
  const carregandoDet = (id: number) => { const i = paraLer.indexOf(id); return i < 0 || detalhes[i]?.isLoading; };

  // ---------------------------------------------------------------- fora de promoção (vendendo bem, em nenhuma campanha)
  const campQ = useQuery({
    queryKey: ["promo-shopee", "em-campanha", shopId], staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ ids: number[]; anuncios: number; lidos: number; erros: unknown[] }> => {
      const r = await chamarPromocoes(`modulo=em-campanha&shop_id=${shopId}`);
      if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
      return { ids: (r.em_campanha ?? []).map((x: { item_id: number }) => Number(x.item_id)), anuncios: r.anuncios, lidos: r.lidos, erros: r.erros ?? [] };
    },
  });
  const foraQ = useQuery({
    queryKey: ["promo-shopee", "fora", shopId, campQ.data?.ids.length ?? -1],
    enabled: campQ.isSuccess, staleTime: 10 * 60_000,
    queryFn: async (): Promise<AnuncioBusca[]> => {
      const { data, error } = await supabaseExternal.rpc("shopee_anuncios_busca", {
        p_shop_id: shopId, p_busca: null, p_ordem: "vendas", p_offset: 0, p_limit: 300, p_excluir: campQ.data?.ids ?? [],
      });
      if (error) throw error;
      return ((data ?? []) as AnuncioBusca[]).filter((a) => num(a.vendas_30d) >= MIN_VENDAS_FORA);
    },
  });
  const fora = foraQ.data ?? [];

  // ---------------------------------------------------------------- base de MC (CMV, imposto, vendas 30d)
  const skus = useMemo(() => {
    const s = new Set<string>();
    for (const ls of linhasDe.values()) for (const l of ls) if (l.sku) s.add(l.sku);
    for (const a of fora) if (a.sku_pai) s.add(a.sku_pai);
    return [...s].sort();
  }, [linhasDe, fora]);
  const baseQ = useQuery({
    queryKey: ["promo-shopee", "mc", shopId, skus], enabled: skus.length > 0, staleTime: 10 * 60_000,
    queryFn: async (): Promise<Map<string, McBase>> => {
      const { data, error } = await supabaseExternal.rpc("promo_mc_base", { p_shop_id: shopId, p_skus: skus });
      if (error) throw error;
      return new Map(((data ?? []) as McBase[]).map((r) => [r.sku, r]));
    },
  });
  const bases = baseQ.data ?? new Map<string, McBase>();
  const custoTiny = useCustoTinyAutomatico(skus, baseQ.data, ["promo-shopee", "mc", shopId, skus]);

  // ---------------------------------------------------------------- relâmpago (vagas de amanhã + selo ⚡)
  const progQ = useQuery({
    queryKey: ["flashsale", "prog-loja", shopId], staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("flashsale_programacao").select("item_id, model_id, preco_promo, ativo").eq("shop_id", shopId);
      if (error) throw error;
      return (data ?? []) as Array<{ item_id: number; model_id: number; preco_promo: number; ativo: boolean }>;
    },
  });
  const progAtivas = (progQ.data ?? []).filter((p) => p.ativo);
  const itemNaRel = (itemId: number) => progAtivas.some((p) => p.item_id === itemId);

  // ---------------------------------------------------------------- promoção diária (robô)
  const recQ = useQuery({
    queryKey: ["promo-shopee", "recorrentes", shopId],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("promo_recorrente").select("*").eq("shop_id", shopId).order("criado_em");
      if (error) throw error;
      const regras = (data ?? []) as Recorrente[];
      let criadas: Criada[] = [];
      if (regras.length) {
        const desde = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        const { data: c } = await supabaseExternal.from("promo_recorrente_criadas")
          .select("recorrente_id, dia, discount_id, status, itens_ok, itens_falha, detalhe").in("recorrente_id", regras.map((r) => r.id)).gte("dia", desde).order("dia");
        criadas = (c ?? []) as Criada[];
      }
      return { regras, criadas };
    },
  });
  const diarias = new Set((recQ.data?.criadas ?? []).map((c) => c.discount_id).filter(Boolean) as number[]);
  for (const r of recQ.data?.regras ?? []) if (r.origem_discount_id) diarias.add(r.origem_discount_id);

  // ---------------------------------------------------------------- "Últimos adicionados" do desconto aberto
  const linhasSel = descSel ? linhasDe.get(descSel.discount_id) ?? [] : [];
  const vistoQ = useQuery({
    queryKey: ["promo-shopee", "vistos", shopId, descSel?.discount_id, linhasSel.length],
    enabled: ordem === "recentes" && !!descSel && linhasSel.length > 0, staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("promo_itens_vistos", {
        p_shop_id: shopId, p_discount_id: descSel!.discount_id, p_itens: linhasSel.map((l) => ({ item_id: l.item_id, model_id: l.model_id })),
      });
      if (error) throw error;
      return new Map(((data ?? []) as Array<{ item_id: number; model_id: number; visto_em: string; inicial: boolean }>)
        .map((r) => [`${r.item_id}:${r.model_id}`, r.inicial ? 0 : new Date(r.visto_em).getTime()]));
    },
  });

  // ---------------------------------------------------------------- linhas no formato do kit
  const keyDe = (discId: number | string, l: { key: string }) => `${discId}|${l.key}`;
  const toLinhaPromo = (d: Desconto, l: Linha): LinhaPromo => {
    const base = l.sku ? bases.get(l.sku) : undefined;
    const k = keyDe(d.discount_id, l);
    const r = res.get(k);
    const st = statusDe(d);
    const estado: EstadoLinha = r ? r.tipo : st === "andamento" ? "na" : st === "programada" ? "programado" : "encerrada";
    return {
      key: k, grupo: `${d.discount_id}|${l.item_id}`, nome: l.nome, sub: l.variacao, foto: l.imagem, sku: l.sku, code: `ID ${l.item_id}`,
      cheio: l.original, promo: l.promo, estado, motivo: r && r.tipo !== "aplicado" ? r.motivo : null,
      v30: base ? num(base.vendas_30d) : null, estoque: l.estoque,
      conta: (p) => contaShopee(base, p, tarifa), semCusto: !!base && base.cmv == null || (!base && !!l.sku && baseQ.isSuccess),
      precoPara: (a) => precoParaShopee(base, tarifa, a, l.original),
    };
  };
  const linhasForaKit: LinhaPromo[] = fora.map((a) => {
    const base = a.sku_pai ? bases.get(a.sku_pai) : undefined;
    const cheio = num(a.preco_max ?? a.preco_min);
    return {
      key: `${ID_FORA}|${a.item_id}:0`, grupo: `${ID_FORA}|${a.item_id}`, nome: a.nome, foto: a.imagem_url, sku: a.sku_pai, code: `ID ${a.item_id}`,
      sub: a.tem_variacao ? "com variações" : null, cheio, promo: cheio, estado: "fora", v30: num(a.vendas_30d), estoque: a.estoque_total,
      conta: (p) => (a.tem_variacao ? null : contaShopee(base, p, tarifa)), semCusto: !a.tem_variacao && !!base && base.cmv == null,
      mcNota: a.tem_variacao ? "MC por variação ao colocar em promoção" : null,
    };
  });

  // todas as linhas das promoções vivas (contadores da faixa)
  const vivasLinhas = useMemo(() => vivas.flatMap((d) => (linhasDe.get(d.discount_id) ?? []).map((l) => ({ d, l, lp: toLinhaPromo(d, l) }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vivas, linhasDe, bases, tarifa, res, baseQ.isSuccess]);
  const predicado = (f: Filtro | null) => (lp: LinhaPromo): boolean => {
    if (!f || f === "fim") return true;
    const m = lp.conta(lp.promo);
    if (f === "neg") return !!m && m.pct < 0;
    if (f === "lt10") return !!m && m.pct >= 0 && m.pct < 0.1;
    if (f === "semc") return lp.semCusto;
    if (f === "rec") return lp.estado === "recusado";
    return true;
  };
  const contar = (f: Filtro) => vivasLinhas.filter((x) => predicado(f)(x.lp)).length;
  const acabam = andamento.filter((d) => diasAte(d.end_time) <= 1);

  // filtro de linha muda a promoção aberta para a 1ª que tem casamento
  useEffect(() => {
    if (!filtro || filtro === "fim") return;
    const p = predicado(filtro);
    const atual = descSel ? vivasLinhas.filter((x) => x.d.discount_id === descSel.discount_id && p(x.lp)).length : 0;
    if (atual > 0) return;
    const prim = vivasLinhas.find((x) => p(x.lp));
    if (prim) setSelId(String(prim.d.discount_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtro]);

  // ---------------------------------------------------------------- linhas do desconto aberto (ordenadas)
  const linhasTabela: LinhaPromo[] = useMemo(() => {
    if (ehFora) return linhasForaKit;
    if (!descSel) return [];
    const ls = linhasSel.map((l) => ({ l, lp: toLinhaPromo(descSel, l) }));
    const vistos = vistoQ.data;
    const grupos = new Map<number, typeof ls>();
    for (const x of ls) { if (!grupos.has(x.l.item_id)) grupos.set(x.l.item_id, []); grupos.get(x.l.item_id)!.push(x); }
    const chave = (g: typeof ls) => ordem === "recentes" && vistos
      ? Math.max(...g.map((x) => vistos.get(x.l.key) ?? 0)) * 1e5 + (1e5 - Math.min(...g.map((x) => x.l.pos)))
      : g.reduce((s, x) => s + (x.lp.v30 ?? 0), 0);
    return [...grupos.values()].sort((a, b) => chave(b) - chave(a) || a[0].l.nome.localeCompare(b[0].l.nome)).flatMap((g) => g.map((x) => x.lp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ehFora, descSel, linhasSel, bases, tarifa, res, ordem, vistoQ.data, fora, baseQ.isSuccess]);
  const linhaBruta = new Map(linhasSel.map((l) => [descSel ? keyDe(descSel.discount_id, l) : l.key, l]));

  // ---------------------------------------------------------------- rascunhos (preço + limite por anúncio)
  const editavel = !!descSel && (descSel.status === "ongoing" || descSel.status === "upcoming");
  const setDraft = (key: string, txt: string | null) => setDrafts((m) => { const n = new Map(m); if (txt == null) n.delete(key); else n.set(key, txt); return n; });
  const precoDe = (lp: LinhaPromo) => { const t = drafts.get(lp.key); const v = t != null ? parseNum(t) : null; return v ?? lp.promo; };
  const limKey = (itemId: number) => `${descSel?.discount_id}|${itemId}`;
  const limiteDe = (l: Linha) => { const t = limDrafts.get(limKey(l.item_id)); if (t == null) return l.limite; const n = Math.round(Number(t.replace(",", "."))); return Number.isFinite(n) && n >= 0 ? n : l.limite; };
  const alteradosPreco = editavel ? linhasTabela.filter((lp) => precoDe(lp) !== lp.promo) : [];
  const alteradosLimite = editavel ? linhasSel.filter((l) => l.primeiraDoItem && limiteDe(l) !== l.limite) : [];
  const nAlterados = alteradosPreco.length + alteradosLimite.filter((l) => !alteradosPreco.some((lp) => linhaBruta.get(lp.key)?.item_id === l.item_id)).length;

  // ---------------------------------------------------------------- prévia e aplicação
  const avisosDe = (it: PreviaEstado["itens"][number]): ItemPrevia["avisos"] => {
    const a: ItemPrevia["avisos"] = [];
    if (it.tipo === "saida") { a.push({ t: "o preço volta ao cheio na hora", tom: "at" }); return a; }
    const m = it.lp.conta(it.para);
    if (it.lp.semCusto) a.push({ t: "sem custo cadastrado: MC não calculada", tom: "am" });
    else if (m && it.para !== it.de) { if (m.pct < 0) a.push({ t: "MC negativa no preço novo", tom: "r" }); else if (m.pct < 0.1) a.push({ t: "MC abaixo de 10%", tom: "am" }); }
    if (it.para >= it.lp.cheio) a.push({ t: "precisa ser menor que o preço cheio: será pulado", tom: "r" });
    if (it.limDe !== it.limPara) a.push({ t: `limite ${it.limDe || "sem"} → ${it.limPara || "sem limite"} por comprador`, tom: "at" });
    if (descSel && diarias.has(descSel.discount_id)) a.push({ t: "vale também para os dias programados da promoção diária", tom: "at" });
    return a;
  };
  function revisar() {
    if (!descSel || nAlterados === 0) return;
    const itensLim = new Set(alteradosLimite.map((l) => l.item_id));
    const itens: PreviaEstado["itens"] = [];
    for (const lp of linhasTabela) {
      const l = linhaBruta.get(lp.key); if (!l) continue;
      const mudouP = precoDe(lp) !== lp.promo;
      const mudouL = l.primeiraDoItem && itensLim.has(l.item_id);
      if (!mudouP && !mudouL) continue;
      itens.push({ tipo: "preco", l, lp, de: lp.promo, para: precoDe(lp), limDe: l.limite, limPara: limiteDe(l) });
    }
    setPrevia({ fase: "revisar", promoId: descSel.discount_id, promoNome: descSel.discount_name, itens });
  }
  function previaSaida(lps: LinhaPromo[]) {
    if (!descSel) return;
    const itens = lps.map((lp) => ({ lp, l: linhaBruta.get(lp.key) })).filter((x): x is { lp: LinhaPromo; l: Linha } => !!x.l)
      .map(({ lp, l }) => ({ tipo: "saida" as const, l, lp, de: precoDe(lp), para: lp.cheio, limDe: l.limite, limPara: l.limite }));
    if (itens.length) setPrevia({ fase: "revisar", promoId: descSel.discount_id, promoNome: descSel.discount_name, itens });
  }
  async function aplicar() {
    if (!previa) return;
    const pv = previa;
    setPrevia({ ...pv, fase: "aplicando" });
    const out = pv.itens.map((it) => ({ ...it }));
    const marcar = (it: typeof out[number], tipo: "aplicado" | "recusado" | "pulado", motivo: string) => { it.res = { tipo, motivo }; };
    try {
      // 1) preço/limite: o anúncio vai inteiro (todas as variações do desconto); só a alterada muda
      const precos = out.filter((it) => it.tipo === "preco");
      for (const it of precos) if (it.para >= it.lp.cheio) marcar(it, "pulado", "preço promo precisa ser menor que o preço cheio");
      const validos = precos.filter((it) => !it.res);
      if (validos.length) {
        const todas = linhasDe.get(pv.promoId) ?? [];
        const porItem = new Map<number, Linha[]>();
        for (const it of validos) if (!porItem.has(it.l.item_id)) porItem.set(it.l.item_id, todas.filter((x) => x.item_id === it.l.item_id));
        const precoNovo = (l: Linha) => { const it = validos.find((x) => x.l.key === l.key); return it ? it.para : (() => { const t = drafts.get(keyDe(pv.promoId, l)); const v = t != null ? parseNum(t) : null; return v != null && v < l.original ? v : l.promo; })(); };
        const limNovo = (itemId: number) => { const it = validos.find((x) => x.l.item_id === itemId && x.limPara !== x.limDe); return it ? it.limPara : (todas.find((x) => x.item_id === itemId)?.limite ?? 0); };
        const itemList = [...porItem.entries()].map(([itemId, ls]) => ls[0].model_id
          ? { item_id: itemId, purchase_limit: limNovo(itemId), model_list: ls.map((l) => ({ model_id: l.model_id, model_promotion_price: precoNovo(l) })) }
          : { item_id: itemId, purchase_limit: limNovo(itemId), item_promotion_price: precoNovo(ls[0]) });
        const r = await chamarPromocoes(`modulo=atualizar-itens&shop_id=${shopId}&discount_id=${pv.promoId}&confirmar=1&propagar=1`, { item_list: itemList });
        if (r.propagacao?.recorrente) {
          const ds = (r.propagacao.dias ?? []) as Array<{ dia: string; falhas: unknown[] }>;
          const comFalha = ds.filter((d) => d.falhas.length).map((d) => d.dia.split("-").reverse().slice(0, 2).join("/"));
          if (r.propagacao.erro) toast.error(`Promoção diária "${r.propagacao.recorrente}": não propagou`, { description: r.propagacao.erro });
          else if (comFalha.length) toast.warning(`Promoção diária "${r.propagacao.recorrente}": recusa em ${comFalha.length} dia(s)`, { description: `Dias: ${comFalha.join(", ")}`, duration: 15000 });
          else if (ds.length) toast.success(`Também aplicado nos ${ds.length} dia(s) programado(s) da promoção diária "${r.propagacao.recorrente}"`);
        }
        if (r.erro) {
          for (const it of validos) marcar(it, "recusado", `a Shopee recusou tudo: ${traduzirErroShopee(r.erro.message ?? r.erro.error)}`);
        } else {
          const falhas = (r.response?.error_list ?? []) as Array<{ item_id: number; model_id?: number; fail_message?: string; fail_error?: string }>;
          for (const it of validos) {
            const f = falhas.find((x) => Number(x.item_id) === it.l.item_id && (!x.model_id || Number(x.model_id) === it.l.model_id));
            if (f) marcar(it, "recusado", traduzirErroShopee(f.fail_message ?? f.fail_error));
            else marcar(it, "aplicado", "aplicado na Shopee");
          }
        }
      }
      // 2) saídas: uma por vez
      for (const it of out.filter((x) => x.tipo === "saida")) {
        try {
          const r = await chamarPromocoes(`modulo=remover-item&shop_id=${shopId}&discount_id=${pv.promoId}&item_id=${it.l.item_id}&model_id=${it.l.model_id}&confirmar=1`, {});
          if (r.erro) marcar(it, "recusado", traduzirErroShopee(r.erro.message ?? r.erro.error));
          else marcar(it, "aplicado", "saiu da promoção");
        } catch (e) { marcar(it, "recusado", (e as Error).message); }
      }
    } catch (e) {
      for (const it of out) if (!it.res) marcar(it, "recusado", (e as Error).message);
    }
    // estado da tabela: aplicado some do rascunho; recusado/pulado fica marcado
    setRes((m) => { const n = new Map(m); for (const it of out) { if (it.tipo === "saida" && it.res?.tipo === "aplicado") n.delete(it.lp.key); else if (it.res) n.set(it.lp.key, it.res); } return n; });
    setDrafts((m) => { const n = new Map(m); for (const it of out) if (it.res?.tipo === "aplicado") n.delete(it.lp.key); return n; });
    setLimDrafts((m) => { const n = new Map(m); for (const it of out) if (it.res?.tipo === "aplicado") n.delete(`${pv.promoId}|${it.l.item_id}`); return n; });
    setSel((s) => { const n = new Set(s); for (const it of out) n.delete(it.lp.key); return n; });
    setPrevia({ ...pv, fase: "resultado", itens: out });
    void qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId, pv.promoId] });
    void qc.invalidateQueries({ queryKey: ["promo-shopee", "em-campanha", shopId] });
  }

  // ---------------------------------------------------------------- clonar para a relâmpago (igual à tela antiga)
  async function clonarRelampago(itemId: number) {
    if (!descSel) return;
    const doItem = linhasSel.filter((l) => l.item_id === itemId);
    const planos: Array<{ l: Linha; teto: number; mc: ReturnType<typeof calcMc> }> = [];
    for (const l of doItem) {
      const base = l.sku ? bases.get(l.sku) : undefined;
      const t = tetoRelampago(l.promo, base?.menor_preco_7d != null ? num(base.menor_preco_7d) : null);
      if (t && t.teto > 0) planos.push({ l, teto: t.teto, mc: calcMc(base, t.teto, tarifa) });
    }
    if (planos.length === 0) { toast.error("Nada a clonar: variação sem preço promo"); return; }
    const negativos = planos.filter((x) => x.mc != null && x.mc.mc < 0);
    if (!window.confirm(
      `Clonar ${planos.length} variação(ões) para a relâmpago diária no maior preço que a Shopee deve aceitar?\n` +
      planos.slice(0, 6).map(({ l, teto, mc }) => `${l.sku ?? l.variacao ?? l.nome.slice(0, 24)}: ${BRL(l.promo)} → ${BRL(teto)}${mc ? ` · MC ${PCT(mc.pct)}` : ""}`).join("\n") +
      (negativos.length ? `\n\nATENÇÃO: ${negativos.length} com MC NEGATIVA no preço relâmpago.` : ""))) return;
    setClonando(itemId);
    try {
      const agora = new Date().toISOString();
      const { error } = await supabaseExternal.from("flashsale_programacao").upsert(planos.map(({ l, teto }) => ({
        shop_id: shopId, item_id: l.item_id, model_id: l.model_id, item_nome: l.nome, model_nome: l.variacao, sku: l.sku, imagem: l.imagem,
        preco_original: l.promo, preco_promo: teto, estoque_promo: 1000, ativo: true, criado_por: perfil?.nome ?? null, atualizado_em: agora,
      })), { onConflict: "shop_id,item_id,model_id" });
      if (error) throw error;
      toast.success(`${planos.length} variação(ões) na relâmpago diária`, { description: "Entra na relâmpago de amanhã na rodada das 18h (se a automação da loja estiver ligada) ou pelo \"Programar amanhã agora\" na aba Relâmpago." });
      void qc.invalidateQueries({ queryKey: ["flashsale"] });
    } catch (e) { toast.error("Falha ao clonar para a relâmpago", { description: (e as Error).message }); }
    finally { setClonando(null); }
  }

  // ---------------------------------------------------------------- sincronizar
  async function sincronizar() {
    setSincronizando(true);
    try {
      await Promise.all(listas.map((q) => q.refetch()));
      await qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId] });
      if (descSel) {
        const ids = [...new Set(linhasSel.map((l) => l.item_id))];
        if (ids.length) {
          const r = await atualizarCatalogoShopee(shopId, ids);
          if (r.erros.length) toast.warning(`Cadastro de ${r.feitos}/${ids.length} anúncio(s) atualizado`, { description: r.erros.slice(0, 4).join("\n") });
        }
      }
      const rec = await sincronizarRecentesShopee(shopId, 3).catch(() => null);
      if (rec && rec.feitos > 0) toast.success(`${rec.feitos} anúncio(s) novo(s)/alterado(s) trazido(s) da Shopee`);
      void qc.invalidateQueries({ queryKey: ["promo-shopee", "em-campanha", shopId] });
      void qc.invalidateQueries({ queryKey: ["flashsale", "prog-loja", shopId] });
      await qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId] });
    } catch (e) { toast.error("Falha ao sincronizar com a Shopee", { description: (e as Error).message }); }
    finally { setSincronizando(false); }
  }
  const atualizadoEm = Math.max(...listas.map((q) => q.dataUpdatedAt || 0));
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setAgora(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const minAtras = atualizadoEm ? Math.max(0, Math.round((agora - atualizadoEm) / 60000)) : null;
  const erroLista = qOn.isError ? (qOn.error as Error).message : null;
  const girando = sincronizando || listas.some((q) => q.isFetching);

  // ---------------------------------------------------------------- cabeçalho, faixa, lista
  const ongoingLinhas = vivasLinhas.filter((x) => x.d.status === "ongoing");
  let ws = 0, ms = 0; const skusAtivos = new Map<string, number>();
  for (const { lp } of ongoingLinhas) {
    const m = lp.conta(lp.promo); const v = lp.v30 ?? 0;
    if (m && v > 0) { ws += lp.promo * v; ms += m.v * v; }
    if (lp.sku) skusAtivos.set(lp.sku, v);
  }
  const carregandoTudo = qOn.isLoading || qUp.isLoading;
  const resumo = carregandoTudo || erroLista ? [] : [
    { v: String(andamento.length), k: andamento.length === 1 ? "promoção ativa" : "promoções ativas" },
    { v: String(skusAtivos.size), k: "produtos em promoção" },
    { v: ws ? PCT(ms / ws) : "—", k: "MC média ponderada por vendas" },
    { v: INT([...skusAtivos.values()].reduce((a, b) => a + b, 0)), k: "vendas em 30 dias" },
  ];
  const nNeg = contar("neg"); const nRec = contar("rec");
  const nVagas = progAtivas.length;
  const cards: CartaoDecisao[] = [
    { id: "neg", n: String(nNeg), label: "MC negativa", sub: "vendendo com prejuízo", tom: "var(--pm-r)" },
    { id: "lt10", n: String(contar("lt10")), label: "MC abaixo de 10%", sub: "entre 0% e 10%", tom: "var(--pm-am)" },
    { id: "fim", n: String(acabam.length), label: "Acabam hoje ou amanhã", sub: "promoções", tom: "var(--pm-am)" },
    { id: "vagas", n: `${Math.min(nVagas, 50)}/50`, label: "Relâmpago de amanhã", sub: nVagas > 50 ? `${nVagas - 50} ficam de fora` : `${50 - nVagas} vagas livres`, tom: "var(--pm-at)" },
    { id: "fora", n: foraQ.isSuccess ? String(fora.length) : "…", label: "Vendendo bem, fora de promoção", sub: foraQ.isSuccess ? `${MIN_VENDAS_FORA}+ vendas em 30 dias` : "conferindo campanhas", tom: "var(--pm-at)" },
    { id: "rec", n: String(nRec), label: "Recusados pela Shopee", sub: "veja o motivo na linha", tom: "var(--pm-r)" },
    { id: "semc", n: String(contar("semc")), label: "Sem custo cadastrado", sub: "MC não calculada", tom: "var(--pm-am)" },
  ].map((c) => ({
    ...c,
    n: erroLista ? "—" : c.n,
    ativo: c.id === filtro || (c.id === "fora" && ehFora),
    onClick: () => {
      if (erroLista) return;
      if (c.id === "vagas") return onIrRelampago();
      if (c.id === "fora") { setFiltro(null); setSelId(ID_FORA); return; }
      setFiltro(filtro === c.id ? null : (c.id as Filtro)); setBusca(""); setFaixa("todas");
    },
  }));

  const filtroF = filtro && filtro !== "fim" ? predicado(filtro) : null;
  const matchDe = (d: Desconto) => (filtroF ? vivasLinhas.filter((x) => x.d.discount_id === d.discount_id && filtroF(x.lp)).length : 0);
  const listaDesc = filtro === "fim" ? acabam : todasDesc;
  const itensLista: ItemLista[] = [
    ...listaDesc.map((d) => {
      const st = statusDe(d); const ls = linhasDe.get(d.discount_id);
      const dias = diasAte(d.end_time);
      return {
        id: String(d.discount_id), nome: d.discount_name, periodo: `${diaBR(d.start_time)} → ${diaBR(d.end_time)}`, status: st,
        itensTxt: ls ? `${new Set(ls.map((l) => l.item_id)).size} ${new Set(ls.map((l) => l.item_id)).size === 1 ? "produto" : "produtos"}` : st === "encerrada" ? "" : "…",
        fimTxt: st === "andamento" && dias <= 1 ? (dias <= 0 ? "acaba hoje" : "acaba amanhã") : null,
        match: matchDe(d), apagada: !!filtroF && matchDe(d) === 0,
      };
    }),
    ...(filtro ? [] : [{ id: ID_FORA, nome: "Fora de promoção", periodo: "últimos 30 dias", status: "fora" as StatusPromo, itensTxt: foraQ.isSuccess ? `${fora.length} ${fora.length === 1 ? "produto" : "produtos"}` : "…" }]),
  ];

  // ---------------------------------------------------------------- robô (promoção diária)
  const regras = recQ.data?.regras ?? [];
  const criadas = recQ.data?.criadas ?? [];
  const ultimaCriada = [...criadas].sort((a, b) => b.dia.localeCompare(a.dia))[0];
  const proximaRodada = (() => {
    const h = Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }));
    const m = Number(new Date().toLocaleString("en-US", { timeZone: TZ, minute: "2-digit" }));
    const min = h * 60 + m;
    return min < 6 * 60 + 23 ? "hoje 06:23" : min < 18 * 60 + 23 ? "hoje 18:23" : "amanhã 06:23";
  })();
  async function mudarModoDiaria(modo: "ligado" | "desligado") {
    if (!regras.length) { toast.info("Abra uma promoção e use “Repetir todo dia” para criar a promoção diária."); return; }
    const ativo = modo === "ligado";
    if (!window.confirm(ativo ? `Religar ${regras.length} promoção(ões) diária(s)? A próxima rodada volta a criar os descontos dos próximos dias.` : `Pausar ${regras.length} promoção(ões) diária(s)? As já criadas na Shopee continuam valendo.`)) return;
    const { error } = await supabaseExternal.from("promo_recorrente").update({ ativo, atualizado_em: new Date().toISOString() }).in("id", regras.map((r) => r.id));
    if (error) toast.error("Falha", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["promo-shopee", "recorrentes", shopId] });
  }
  const regraDe = ultimaCriada ? regras.find((r) => r.id === ultimaCriada.recorrente_id) : undefined;

  // ---------------------------------------------------------------- detalhe
  const nLinhas = linhasTabela.length;
  let wsc = 0, msc = 0, v30c = 0;
  for (const lp of linhasTabela) { const p = precoDe(lp); const m = lp.conta(p); v30c += lp.v30 ?? 0; if (m && (lp.v30 ?? 0) > 0) { wsc += p * (lp.v30 ?? 0); msc += m.v * (lp.v30 ?? 0); } }
  const dres: Array<{ t: string; cor: string }> = [
    { t: `${nLinhas} ${nLinhas === 1 ? "produto" : "produtos"}`, cor: "var(--pm-t2)" },
    { t: `MC média ${wsc ? PCT(msc / wsc) : "—"}`, cor: "var(--pm-t2)" },
    { t: `${INT(v30c)} vendas em 30 dias`, cor: "var(--pm-t2)" },
  ];
  const nNegSel = linhasTabela.filter((lp) => { const m = lp.conta(precoDe(lp)); return m && m.pct < 0; }).length;
  const nSemSel = linhasTabela.filter((lp) => lp.semCusto).length;
  if (nNegSel) dres.push({ t: `${nNegSel} com MC negativa`, cor: "var(--pm-r)" });
  if (nSemSel) dres.push({ t: `${nSemSel} sem custo cadastrado`, cor: "var(--pm-am)" });
  if (nAlterados) dres.push({ t: `${nAlterados} alterado(s), ainda não aplicado(s)`, cor: "var(--pm-am)" });

  const stSel: StatusPromo | null = ehFora ? "fora" : descSel ? statusDe(descSel) : null;
  const primeiroVivo = vivas.find((d) => d.status === "ongoing") ?? vivas[0] ?? null;
  const cabecalhoDetalhe: ReactNode = (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{ehFora ? "Fora de promoção" : descSel?.discount_name}</h3>
        {stSel && <Chip bg={PST[stSel][1]} cor={PST[stSel][2]} size={10.5}>{PST[stSel][0]}</Chip>}
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>
          {ehFora ? `Vendendo bem, sem desconto · ${MIN_VENDAS_FORA}+ vendas em 30 dias` : (
            <>{descSel && diarias.has(descSel.discount_id) ? "Promoção diária" : "Desconto da loja"} · <span className="pm-mono">{descSel ? `${diaHoraBR(descSel.start_time)} → ${diaHoraBR(descSel.end_time)}` : ""}</span></>
          )}
        </span>
        <div style={{ flex: 1 }} />
        {editavel && descSel && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {linhasSel.length > 0 && (
              <RepetirDiario shopId={shopId} desconto={descSel}
                linhas={linhasSel.map((l) => ({ item_id: l.item_id, model_id: l.model_id, promo: l.promo, limite: l.limite }))} />
            )}
            <Btn onClick={() => setAddPara(descSel)}><Plus style={{ width: 14, height: 14 }} />Adicionar produtos</Btn>
            {nAlterados > 0 && (
              <button type="button" onClick={() => { setDrafts((m) => new Map([...m].filter(([k]) => !k.startsWith(`${descSel.discount_id}|`)))); setLimDrafts((m) => new Map([...m].filter(([k]) => !k.startsWith(`${descSel.discount_id}|`)))); }}
                className="hover:bg-[var(--pm-s2)]" style={{ height: 32, padding: "0 10px", borderRadius: 8, border: 0, background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)" }}>Descartar</button>
            )}
            <Btn primario disabled={nAlterados === 0} onClick={revisar}>Revisar e aplicar ({nAlterados})</Btn>
          </div>
        )}
        {ehFora && primeiroVivo && <Btn primario onClick={() => setAddPara(primeiroVivo)}>Colocar em promoção</Btn>}
        {stSel === "encerrada" && <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Encerrada: só consulta</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12 }}>
        {dres.map((d) => <span key={d.t} style={{ color: d.cor }}>{d.t}</span>)}
      </div>
      <AvisoCustoTiny estado={custoTiny} />
      {ehFora && campQ.isError && <span style={{ fontSize: 12, color: "var(--pm-r)" }}>Não consegui conferir as campanhas na Shopee: {(campQ.error as Error).message}</span>}
    </>
  );

  const extra = (lp: LinhaPromo) => {
    if (ehFora) return <span className="pm-mono" style={{ fontSize: 12, color: "var(--pm-t3)" }}>—</span>;
    const l = linhaBruta.get(lp.key);
    if (!l) return null;
    const lim = limiteDe(l);
    if (editavel && l.primeiraDoItem) {
      const k = limKey(l.item_id); const mudou = lim !== l.limite;
      return (
        <>
          <input value={limDrafts.get(k) ?? String(l.limite)} inputMode="numeric" className="pm-mono"
            onChange={(e) => setLimDrafts((m) => { const n = new Map(m); const t = e.target.value; if (t === String(l.limite)) n.delete(k); else n.set(k, t); return n; })}
            style={{ width: 52, height: 26, borderRadius: 7, border: `1px solid ${mudou ? "var(--pm-am)" : "var(--pm-b)"}`, background: mudou ? "var(--pm-ams)" : "var(--pm-s)", color: "var(--pm-t)", fontSize: 12, textAlign: "right", padding: "0 6px", outline: "none" }} />
          <span style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>{lim ? "por comprador" : "sem limite"}</span>
        </>
      );
    }
    return <span className="pm-mono" style={{ fontSize: 12, color: "var(--pm-t2)" }}>{l.limite ? `${l.limite} / comprador` : "sem limite"}</span>;
  };
  const acoes = (lp: LinhaPromo) => {
    if (!editavel) return null;
    const l = linhaBruta.get(lp.key); if (!l) return null;
    const naRel = itemNaRel(l.item_id);
    return (
      <>
        {l.primeiraDoItem && (
          <button type="button" title={naRel ? "Já está na relâmpago diária: clicar de novo regrava preço (teto) e estoque" : "Clonar para a Relâmpago de amanhã"}
            disabled={clonando === l.item_id} onClick={() => void clonarRelampago(l.item_id)} className="hover:bg-[var(--pm-s2)] hover:text-[var(--pm-am)]"
            style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: naRel ? "var(--pm-am)" : "var(--pm-t3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
            {clonando === l.item_id ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <Zap style={{ width: 14, height: 14 }} fill={naRel ? "currentColor" : "none"} />}
          </button>
        )}
        <button type="button" title="Tirar da promoção" onClick={() => previaSaida([lp])} className="hover:bg-[var(--pm-rs)] hover:text-[var(--pm-r)]"
          style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: "var(--pm-t3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          <Trash2 style={{ width: 14, height: 14 }} />
        </button>
      </>
    );
  };
  const selDaTabela = linhasTabela.filter((lp) => sel.has(lp.key));

  const previaItens: ItemPrevia[] = (previa?.itens ?? []).map((it) => ({
    key: it.lp.key, nome: it.lp.nome + (it.lp.sub ? ` · ${it.lp.sub}` : ""), sku: `${it.lp.sku ?? "—"} · ${it.lp.code}`, foto: it.lp.foto,
    op: it.tipo === "saida" ? "sai da promoção" : it.para !== it.de ? "novo preço promo" : "novo limite por comprador",
    de: it.de, para: it.para, mcDe: it.lp.conta(it.de), mcPara: it.tipo === "saida" ? it.lp.conta(it.lp.cheio) : it.lp.conta(it.para), semCusto: it.lp.semCusto,
    avisos: avisosDe(it), res: it.res,
  }));

  return (
    <>
      <CabecalhoMkt {...cab} mkts={cab.mkts.map((m) => (m.id === "shopee" ? { ...m, alerta: erroLista ? 0 : nNeg + nRec } : m))}
        sync={{ txt: girando ? "sincronizando…" : erroLista ? "falhou" : minAtras == null ? "—" : minAtras === 0 ? "agora" : `há ${minAtras} min`, tom: erroLista ? "r" : "ok", girando, onClick: () => void sincronizar() }}
        resumo={resumo} />

      <FaixaDecisao sub={`hoje, ${new Date().toLocaleDateString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" })} · Shopee · ${cab.lojas.find((l) => l.id === cab.loja)?.nome ?? ""} · clique num contador para filtrar`}
        cards={cards} carregando={carregandoTudo} filtroNome={filtro ? FILTRO_NOME[filtro] : null} onLimpar={() => setFiltro(null)} />

      {erroLista ? <ErroLeitura mktDe="da Shopee" msg={erroLista} onTentar={() => void sincronizar()} /> : (
        <div className="grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)]" style={{ gap: 16, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <ListaPromos titulo="Promoções" itens={itensLista} sel={selEfetivo} carregando={carregandoTudo}
              onSel={(id) => { setSelId(id); setBusca(""); setFaixa("todas"); }}
              vazio={(
                <div style={{ padding: "18px 8px", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>Nenhuma promoção em andamento nesta loja.</span>
                  <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Crie a promoção no Seller Center e sincronize.</span>
                </div>
              )} />
            <CartaoRobo nome="Promoção diária" modos={["desligado", "ligado"]} onModo={(m) => void mudarModoDiaria(m as "ligado" | "desligado")}
              desc={regras.length ? `Repete “${regras[0].nome}”${regras.length > 1 ? ` e mais ${regras.length - 1}` : ""} todo dia` : "Nenhuma promoção repetida todo dia"}
              modo={regras.some((r) => r.ativo) ? "ligado" : "desligado"}
              ultima={ultimaCriada ? `${ultimaCriada.dia.slice(8, 10)}/${ultimaCriada.dia.slice(5, 7)} · ${ultimaCriada.status === "ok" ? "criada" : ultimaCriada.status}` : "—"} proxima={proximaRodada}
              params={regras[0] ? [{ k: "Dias à frente", v: String(regras[0].dias_antecedencia) }, { k: "Horário", v: regras[0].hora_inicio.slice(0, 5) }] : []}
              fez={!regras.length ? "Abra uma promoção e use “Repetir todo dia” para a Shopee ganhar um desconto novo por dia."
                : ultimaCriada ? `Na última rodada: ${ultimaCriada.status === "criada" || ultimaCriada.status === "ok" ? "criou" : ultimaCriada.status} “${regraDe?.nome ?? ""} ${ultimaCriada.dia.slice(8, 10)}/${ultimaCriada.dia.slice(5, 7)}” com ${ultimaCriada.itens_ok} produto(s). ${ultimaCriada.itens_falha ? `${ultimaCriada.itens_falha} recusa(s).` : "Nenhuma recusa."}`
                  : "Ainda não criou nenhum dia."}
              rodape={regras.length > 0 ? (
                <button type="button" onClick={() => setGerenciarDiaria(true)} className="hover:bg-[var(--pm-s2)]"
                  style={{ height: 28, borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)" }}>Gerenciar promoções diárias</button>
              ) : undefined} />
          </div>

          {itensLista.length === 0 && !carregandoTudo ? (
            <div className="pm-card" style={{ padding: "48px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, textAlign: "center" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Nada para mostrar aqui</span>
              <span style={{ fontSize: 12.5, color: "var(--pm-t3)", maxWidth: "44ch" }}>Quando houver uma promoção, os produtos aparecem nesta tabela com preço, MC e estado.</span>
            </div>
          ) : (
            <TabelaPromo
              cabecalho={cabecalhoDetalhe} linhas={linhasTabela} editavel={editavel} fora={ehFora}
              drafts={drafts} setDraft={setDraft} sel={sel} setSel={setSel}
              busca={busca} setBusca={setBusca} faixa={faixa} setFaixa={setFaixa}
              precoLabel={ehFora ? "Preço atual" : "Cheio → promo"} extraLabel={ehFora ? "Limite" : "Limite"}
              extra={(lp) => extra(lp)} acoes={(lp) => acoes(lp)} filtroLinha={ehFora ? null : filtroF}
              carregando={carregandoTudo || (ehFora ? !foraQ.isSuccess && !campQ.isError : !!descSel && carregandoDet(descSel.discount_id))}
              carregandoTxt={ehFora ? "Conferindo na Shopee quais anúncios já estão em campanha…" : "Buscando promoções da Shopee…"}
              ordem={!ehFora ? (
                <div style={{ display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8 }}>
                  {([["vendas", "Mais vendidos"], ["recentes", "Últimos adicionados"]] as const).map(([id, nome]) => (
                    <button key={id} type="button" onClick={() => setOrdem(id)} style={{ border: 0, cursor: "pointer", padding: "3px 9px", borderRadius: 6, fontSize: 11.5, ...seg(ordem === id) }}>{nome}</button>
                  ))}
                </div>
              ) : undefined}
              lote={{
                onAlvo: (a) => setDrafts((m) => { const n = new Map(m); for (const lp of selDaTabela) { const pz = lp.precoPara?.(a); if (pz != null && pz < lp.cheio) n.set(lp.key, IN(pz)); } return n; }),
                onDesc: (x) => setDrafts((m) => { const n = new Map(m); for (const lp of selDaTabela) n.set(lp.key, IN(Math.round(lp.cheio * (1 - x) * 100) / 100)); return n; }),
                onTirar: () => previaSaida(selDaTabela),
                onColocar: primeiroVivo ? () => setAddPara(primeiroVivo) : undefined,
              }}
              rodape={ehFora
                ? `Produtos com ${MIN_VENDAS_FORA}+ vendas em 30 dias que não estão em nenhuma campanha da Shopee (desconto, relâmpago, combo). “Colocar em promoção” abre a lista para escolher preço e margem.`
                : "MC = preço − comissão Shopee (tabela vigente) − imposto (efetivo 60 dias) − CMV, por unidade. Passe o mouse na MC para ver a conta. ⚡ clona o anúncio para a relâmpago diária. Nada vai para a Shopee até “Revisar e aplicar”."} />
          )}
        </div>
      )}

      {previa && (
        <PreviaAplicar fase={previa.fase} mktNa="na Shopee" promoNome={previa.promoNome} itens={previaItens}
          onAplicar={() => void aplicar()} onFechar={() => setPrevia(null)} />
      )}
      {addPara && (
        <AdicionarAoDesconto shopId={shopId} desconto={addPara} onFechar={() => setAddPara(null)}
          onAdicionou={() => { void qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId, addPara.discount_id] }); void qc.invalidateQueries({ queryKey: ["promo-shopee", "fora", shopId] }); }} />
      )}
      <Dialog open={gerenciarDiaria} onOpenChange={setGerenciarDiaria}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Promoções diárias</DialogTitle></DialogHeader>
          <PainelPromoDiaria shopId={shopId} />
        </DialogContent>
      </Dialog>
    </>
  );
}
