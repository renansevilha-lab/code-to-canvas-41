import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDown, ArrowUp, CalendarRange, Clock, Loader2, Plus, RefreshCw, Save, Search, Tag, Trash2, TrendingUp, Undo2, X, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import {
  AMBER, FAIXAS_MC, Foto, GREEN, RED, atualizarCatalogoShopee, sincronizarRecentesShopee, calcMc, chamarPromocoes, corMc, num, passaFaixa, tetoRelampago, tituloMc, traduzirErroShopee, useTarifaShopee, type McBase,
} from "./comum";
import { AdicionarAoDesconto } from "./AdicionarAoDesconto";
import { PainelPromoDiaria, RepetirDiario } from "./PromoDiaria";

// ============================================================================
// Minha Promoção (Shopee) — os DESCONTOS da loja (v2.discount), com CMV, MC e
// desconto por item. Fonte: edge fn shopee-promocoes (ao vivo na Shopee) +
// espelho shopee_anuncios(_variacao) p/ foto e SKU + RPC promo_mc_base
// (CMV kit-aware, imposto efetivo 60d, vendas 30d) + comissão pela TABELA
// Shopee vigente (shopee_tarifa: <R$80 = 20% + R$4,50/un desde 01/10/2026).
// Filtro por faixa de MC e "Adicionar produtos" (só os que não estão em
// nenhuma campanha — get_item_promotion via modulo=em-campanha).
// EDITAR funciona no desconto EM ANDAMENTO (update_discount_item): preço
// promocional e limite por comprador, sem recriar a promoção. Toda escrita
// passa por prévia + confirmação — muda o preço público na hora.
// Ordenação: "Mais vendidos" (vendas 30d, padrão) ou "Últimos adicionados"
// (RPC promo_itens_vistos: 1ª vez que o item apareceu no desconto — a API da
// Shopee não informa a data de inclusão).
// Clonar para a Relâmpago (07/out/2026, pedido do dono): botão ⚡ por produto
// grava TODAS as variações do anúncio na programação diária da relâmpago
// (flashsale_programacao) com o MAIOR preço que a Shopee deve aceitar
// (tetoRelampago sobre o preço promo daqui: 1% abaixo e ≤ menor preço vendido
// em 7 dias) e estoque 1000 — o programar da shopee-flashsale reduz ao saldo
// real do anúncio quando a Shopee recusa por estoque. Entra na relâmpago de
// amanhã pela automação das 18h ou pelo botão da aba Relâmpago.
// ============================================================================

interface Desconto {
  discount_id: number; discount_name: string; start_time: number; end_time: number; status: string; source?: number;
}
interface ModeloApi {
  model_id: number; model_name?: string; status?: number;
  model_original_price: number; model_promotion_price: number;
  model_promotion_stock?: number; model_normal_stock?: number;
}
interface ItemApi {
  item_id: number; item_name: string; purchase_limit: number;
  item_original_price?: number; item_promotion_price?: number;
  item_promotion_stock?: number; normal_stock?: number;
  model_list?: ModeloApi[];
}
interface Linha {
  key: string; item_id: number; model_id: number; nome: string; variacao: string | null;
  original: number; promo: number; estoque: number | null; limite: number;
  sku: string | null; imagem: string | null; primeiraDoItem: boolean;
  pos: number; // posição na lista da Shopee (desempate de "Últimos adicionados")
}

// Busca por palavras soltas, sem acento e em qualquer ordem: "areia bumi" acha
// "Areia Bumi Pet 4kg…" (todas as palavras precisam aparecer no nome/variação/SKU).
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function passaBusca(l: Linha, termos: string[]) {
  if (termos.length === 0) return true;
  const alvo = semAcento(`${l.nome} ${l.variacao ?? ""} ${l.sku ?? ""} ${l.item_id}`);
  return termos.every((t) => alvo.includes(t));
}

const STATUS: Array<{ id: string; rotulo: string }> = [
  { id: "ongoing", rotulo: "Em andamento" },
  { id: "upcoming", rotulo: "Próximas" },
  { id: "expired", rotulo: "Encerradas" },
];
const dataHora = (epoch: number) =>
  new Date(epoch * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function MinhaPromocao({ shopId }: { shopId: number }) {
  const [status, setStatus] = useState("ongoing");
  const [selId, setSelId] = useState<number | null>(null);
  // "Atualizar da Shopee" também relê a promoção aberta + o catálogo dos anúncios dela
  const [recarga, setRecarga] = useState(0);

  const listaQ = useQuery({
    queryKey: ["promo-shopee", "lista", shopId, status],
    staleTime: 2 * 60_000,
    queryFn: async (): Promise<Desconto[]> => {
      const r = await chamarPromocoes(`modulo=list&shop_id=${shopId}&status=${status}`);
      if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
      return ((r.descontos ?? []) as Desconto[]).sort((a, b) => b.start_time - a.start_time);
    },
  });
  const descontos = listaQ.data ?? [];
  const sel = descontos.find((d) => d.discount_id === selId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUS.map((s) => (
          <Button key={s.id} size="sm" variant={status === s.id ? "default" : "outline"} className="h-8 text-xs"
            onClick={() => { setStatus(s.id); setSelId(null); }}>
            {s.rotulo}
          </Button>
        ))}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" disabled={listaQ.isFetching}
          onClick={() => { void listaQ.refetch(); if (selId != null) setRecarga((n) => n + 1); }}
          title="Relê as promoções e, na promoção aberta, os itens e o cadastro dos anúncios (SKU/foto) direto da Shopee">
          <RefreshCw className={cn("h-3.5 w-3.5", listaQ.isFetching && "animate-spin")} /> Atualizar da Shopee
        </Button>
      </div>

      <PainelPromoDiaria shopId={shopId} />

      {listaQ.isLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Buscando promoções na Shopee…
        </div>
      ) : listaQ.isError ? (
        <p className="text-sm" style={{ color: RED }}>Falha ao listar: {(listaQ.error as Error).message}</p>
      ) : descontos.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma promoção {STATUS.find((s) => s.id === status)?.rotulo.toLowerCase()} nesta loja.</p>
      ) : (
        <div className="rounded-lg border divide-y">
          {descontos.map((d) => (
            <button key={d.discount_id} type="button"
              onClick={() => setSelId(selId === d.discount_id ? null : d.discount_id)}
              className={cn("w-full text-left px-3 py-2.5 flex items-center gap-3 text-[13px] hover:bg-muted/40",
                selId === d.discount_id && "bg-muted/50")}>
              <Tag className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium flex-1 min-w-0 truncate">{d.discount_name}</span>
              <span className="text-[11.5px] text-muted-foreground whitespace-nowrap flex items-center gap-1">
                <CalendarRange className="h-3.5 w-3.5" /> {dataHora(d.start_time)} → {dataHora(d.end_time)}
              </span>
              <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded"
                style={{ background: d.status === "ongoing" ? `${GREEN}18` : d.status === "upcoming" ? `${AMBER}18` : "#94A3B822",
                  color: d.status === "ongoing" ? GREEN : d.status === "upcoming" ? AMBER : "#64748B" }}>
                {d.status === "ongoing" ? "Em andamento" : d.status === "upcoming" ? "Próxima" : "Encerrada"}
              </span>
            </button>
          ))}
        </div>
      )}

      {sel && <DetalheDesconto key={sel.discount_id} shopId={shopId} desconto={sel} recarga={recarga} />}
    </div>
  );
}

// ----------------------------------------------------------------------------

function DetalheDesconto({ shopId, desconto, recarga }: { shopId: number; desconto: Desconto; recarga: number }) {
  const qc = useQueryClient();
  const editavel = desconto.status === "ongoing" || desconto.status === "upcoming";
  const [precos, setPrecos] = useState<Map<string, number>>(new Map());
  const [limites, setLimites] = useState<Map<number, number>>(new Map());
  const [previa, setPrevia] = useState<null | { itemList: unknown[]; mudancas: Array<{ l: Linha; de: number; para: number; limDe: number; limPara: number }> }>(null);
  const [aplicando, setAplicando] = useState(false);
  const [removendo, setRemovendo] = useState<string | null>(null);
  const [faixa, setFaixa] = useState("todas");
  const [busca, setBusca] = useState("");
  const termos = useMemo(() => semAcento(busca).split(/\s+/).filter(Boolean), [busca]);
  const [ord, setOrd] = useState<{ col: ColOrd; dir: 1 | -1 }>({ col: "vendas", dir: -1 });
  const [dlgAdd, setDlgAdd] = useState(false);
  const [clonando, setClonando] = useState<number | null>(null);
  const tarifa = useTarifaShopee().data;
  const { perfil } = usePerfil();

  const detQ = useQuery({
    queryKey: ["promo-shopee", "detalhe", shopId, desconto.discount_id],
    staleTime: 60_000,
    queryFn: async (): Promise<Linha[]> => {
      const r = await chamarPromocoes(`modulo=detalhe&shop_id=${shopId}&discount_id=${desconto.discount_id}`);
      if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
      const itens = (r.itens ?? []) as ItemApi[];
      const ids = [...new Set(itens.map((i) => i.item_id))];
      // foto + SKU pelo espelho do catálogo
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
              key: `${it.item_id}:${m.model_id}`, item_id: it.item_id, model_id: m.model_id,
              nome: it.item_name, variacao: m.model_name || vv?.nome_variacao || null,
              original: num(m.model_original_price), promo: num(m.model_promotion_price),
              estoque: m.model_normal_stock ?? null, limite: num(it.purchase_limit),
              sku: vv?.sku ?? an?.sku_pai ?? null, imagem: an?.imagem_url ?? null, primeiraDoItem: idx === 0,
              pos: linhas.length,
            });
          });
        } else {
          linhas.push({
            key: `${it.item_id}:0`, item_id: it.item_id, model_id: 0, nome: it.item_name, variacao: null,
            original: num(it.item_original_price), promo: num(it.item_promotion_price),
            estoque: it.normal_stock ?? null, limite: num(it.purchase_limit),
            sku: an?.sku_pai ?? null, imagem: an?.imagem_url ?? null, primeiraDoItem: true,
            pos: linhas.length,
          });
        }
      }
      return linhas;
    },
  });
  const linhas = useMemo(() => detQ.data ?? [], [detQ.data]);

  const skus = useMemo(() => [...new Set(linhas.map((l) => l.sku).filter((s): s is string => !!s))].sort(), [linhas]);
  const baseQ = useQuery({
    queryKey: ["promo-shopee", "mc", shopId, skus],
    enabled: skus.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Map<string, McBase>> => {
      const { data, error } = await supabaseExternal.rpc("promo_mc_base", { p_shop_id: shopId, p_skus: skus });
      if (error) throw error;
      return new Map(((data ?? []) as McBase[]).map((r) => [r.sku, r]));
    },
  });
  const bases = baseQ.data ?? new Map<string, McBase>();

  // Programação diária da relâmpago destes anúncios (selo ⚡ e "re-clonar")
  const itemIds = useMemo(() => [...new Set(linhas.map((l) => l.item_id))].sort((a, b) => a - b), [linhas]);
  const relQ = useQuery({
    queryKey: ["flashsale", "prog-itens", shopId, itemIds],
    enabled: itemIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, ProgRel>> => {
      const m = new Map<string, ProgRel>();
      for (let i = 0; i < itemIds.length; i += 200) {
        const { data, error } = await supabaseExternal.from("flashsale_programacao")
          .select("item_id, model_id, preco_promo, ativo").eq("shop_id", shopId).in("item_id", itemIds.slice(i, i + 200));
        if (error) throw error;
        for (const r of (data ?? []) as Array<{ item_id: number; model_id: number; preco_promo: number; ativo: boolean }>) {
          m.set(`${r.item_id}:${r.model_id}`, { preco_promo: num(r.preco_promo), ativo: r.ativo });
        }
      }
      return m;
    },
  });
  const naRelampago = relQ.data ?? new Map<string, ProgRel>();

  /** Clona o anúncio (todas as variações desta promoção) para a relâmpago diária. */
  async function clonarRelampago(itemId: number) {
    const doItem = linhas.filter((l) => l.item_id === itemId);
    const planos: Array<{ l: Linha; teto: number; mc: ReturnType<typeof calcMc> }> = [];
    const pulados: string[] = [];
    for (const l of doItem) {
      const base = l.sku ? bases.get(l.sku) : undefined;
      const t = tetoRelampago(l.promo, base?.menor_preco_7d != null ? num(base.menor_preco_7d) : null);
      if (!t || !(t.teto > 0)) { pulados.push(l.sku ?? l.variacao ?? String(l.model_id)); continue; }
      planos.push({ l, teto: t.teto, mc: calcMc(base, t.teto, tarifa) });
    }
    if (planos.length === 0) { toast.error("Nada a clonar: variação sem preço promo"); return; }
    const negativos = planos.filter((x) => x.mc != null && x.mc.mc < 0);
    if (negativos.length > 0 && !window.confirm(
      `${negativos.length} variação(ões) ficam com MC NEGATIVA no preço relâmpago:\n` +
      negativos.slice(0, 6).map((x) => `${x.l.sku ?? x.l.variacao}: ${formatBRL(x.teto)} → MC ${formatBRL(x.mc!.mc)}`).join("\n") +
      "\n\nClonar assim mesmo?")) return;
    setClonando(itemId);
    try {
      const agora = new Date().toISOString();
      const { error } = await supabaseExternal.from("flashsale_programacao").upsert(planos.map(({ l, teto }) => ({
        shop_id: shopId, item_id: l.item_id, model_id: l.model_id,
        item_nome: l.nome, model_nome: l.variacao, sku: l.sku, imagem: l.imagem,
        // "preço atual" da relâmpago = o preço promo daqui (base do teto e da proteção de preço)
        preco_original: l.promo, preco_promo: teto,
        // estoque alto: a Shopee recusa acima do saldo e o programar reenvia com o saldo real
        estoque_promo: 1000, ativo: true, criado_por: perfil?.nome ?? null, atualizado_em: agora,
      })), { onConflict: "shop_id,item_id,model_id" });
      if (error) throw error;
      const { data: cfg } = await supabaseExternal.from("flashsale_config").select("automacao_ativa").eq("shop_id", shopId).maybeSingle();
      const auto = !!(cfg as { automacao_ativa?: boolean } | null)?.automacao_ativa;
      const resumo = planos.slice(0, 4).map(({ l, teto, mc }) =>
        `${l.sku ?? l.variacao ?? l.nome.slice(0, 24)}: ${formatBRL(l.promo)} → ${formatBRL(teto)}${mc ? ` · MC ${(mc.pct * 100).toFixed(1)}%` : ""}`).join("\n");
      toast.success(`${planos.length} variação(ões) na relâmpago diária · estoque 1000 (a Shopee reduz ao saldo)`, {
        description: `${resumo}${planos.length > 4 ? `\n+${planos.length - 4}` : ""}${pulados.length ? `\nSem preço, ficaram de fora: ${pulados.join(", ")}` : ""}\n` +
          (auto ? "Entra na relâmpago de amanhã na rodada das 18h." : "Automação desligada: use \"Programar amanhã agora\" na aba Relâmpago."),
        duration: 15000,
      });
      void qc.invalidateQueries({ queryKey: ["flashsale"] });
    } catch (e) {
      toast.error("Falha ao clonar para a relâmpago", { description: (e as Error).message });
    } finally { setClonando(null); }
  }

  // "Últimos adicionados": registra/lê a 1ª vez que cada item apareceu no desconto.
  const vistoQ = useQuery({
    queryKey: ["promo-shopee", "vistos", shopId, desconto.discount_id, detQ.dataUpdatedAt],
    enabled: detQ.isSuccess,
    staleTime: Infinity,
    queryFn: async (): Promise<Map<string, Visto>> => {
      const itens = linhas.map((l) => ({ item_id: l.item_id, model_id: l.model_id }));
      const { data, error } = await supabaseExternal.rpc("promo_itens_vistos", {
        p_shop_id: shopId, p_discount_id: desconto.discount_id, p_itens: itens,
      });
      if (error) throw error;
      return new Map(((data ?? []) as Array<{ item_id: number; model_id: number; visto_em: string; inicial: boolean }>)
        .map((r) => [`${r.item_id}:${r.model_id}`, { em: new Date(r.visto_em).getTime(), inicial: r.inicial }]));
    },
  });
  const vistos = vistoQ.data ?? new Map<string, Visto>();

  // Recarga completa (botão "Atualizar da Shopee"): itens da promoção → catálogo
  // desses anúncios (SKU/foto alterados no Seller Center) → itens de novo, já com
  // o espelho atualizado. Sem isso o SKU só muda no catálogo noturno.
  const [catalogo, setCatalogo] = useState<null | { feitos: number; total: number }>(null);
  const ultimaRecarga = useRef(recarga);
  useEffect(() => {
    if (recarga === ultimaRecarga.current) return;
    ultimaRecarga.current = recarga;
    void recarregarTudo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recarga]);
  async function recarregarTudo() {
    if (catalogo) return;
    try {
      const r1 = await detQ.refetch();
      const ids = [...new Set((r1.data ?? []).map((l) => l.item_id))];
      if (ids.length === 0) return;
      setCatalogo({ feitos: 0, total: ids.length });
      const res = await atualizarCatalogoShopee(shopId, ids, (f) => setCatalogo({ feitos: f, total: ids.length }));
      // + anúncios novos/alterados nos últimos 3 dias (produto recém-cadastrado aparece no "Adicionar produtos")
      try {
        const rec = await sincronizarRecentesShopee(shopId, 3);
        if (rec.feitos > 0) toast.success(`${rec.feitos} anúncio(s) novo(s)/alterado(s) trazido(s) da Shopee`);
        void qc.invalidateQueries({ queryKey: ["promo-shopee", "candidatos", shopId] });
        void qc.invalidateQueries({ queryKey: ["promo-shopee", "recentes", shopId] });
      } catch (e) {
        res.erros.push(`anúncios novos: ${(e as Error).message}`);
      }
      await detQ.refetch();
      if (res.erros.length) toast.warning(`Cadastro de ${res.feitos}/${ids.length} anúncio(s) atualizado`, { description: res.erros.slice(0, 4).join("\n"), duration: 12000 });
      else toast.success(`Atualizado da Shopee: ${res.feitos} anúncio(s), ${res.variacoes} variação(ões)`);
    } catch (e) {
      toast.error("Falha ao atualizar da Shopee", { description: (e as Error).message });
    } finally { setCatalogo(null); }
  }

  const precoDe = (l: Linha) => precos.get(l.key) ?? l.promo;
  const limiteDe = (l: Linha) => limites.get(l.item_id) ?? l.limite;
  const alterados = linhas.filter((l) => precoDe(l) !== l.promo || limiteDe(l) !== l.limite);

  // resumo no preço atual/digitado
  const resumo = useMemo(() => {
    let neg = 0; let semBase = 0;
    for (const l of linhas) {
      const mc = calcMc(l.sku ? bases.get(l.sku) : undefined, precos.get(l.key) ?? l.promo, tarifa);
      if (!mc) semBase++; else if (mc.mc < 0) neg++;
    }
    return { neg, semBase };
  }, [linhas, bases, precos, tarifa]);

  function montarPrevia() {
    const erros: string[] = [];
    const porItem = new Map<number, Linha[]>();
    for (const l of linhas) {
      if (!alterados.some((a) => a.item_id === l.item_id)) continue;
      if (!porItem.has(l.item_id)) porItem.set(l.item_id, []);
      porItem.get(l.item_id)!.push(l);
    }
    const itemList: unknown[] = [];
    for (const [itemId, ls] of porItem) {
      for (const l of ls) {
        const p = precoDe(l);
        if (!(p > 0)) erros.push(`${l.sku ?? l.nome}: preço inválido`);
        else if (l.original > 0 && p >= l.original) erros.push(`${l.sku ?? l.nome}: promo precisa ser menor que o preço cheio (${formatBRL(l.original)})`);
      }
      const lim = limiteDe(ls[0]);
      if (ls[0].model_id) {
        itemList.push({ item_id: itemId, purchase_limit: lim, model_list: ls.map((l) => ({ model_id: l.model_id, model_promotion_price: precoDe(l) })) });
      } else {
        itemList.push({ item_id: itemId, purchase_limit: lim, item_promotion_price: precoDe(ls[0]) });
      }
    }
    if (erros.length) { toast.error("Corrija antes de aplicar", { description: erros.slice(0, 5).join("\n") }); return; }
    setPrevia({
      itemList,
      mudancas: alterados.map((l) => ({ l, de: l.promo, para: precoDe(l), limDe: l.limite, limPara: limiteDe(l) })),
    });
  }

  async function aplicar() {
    if (!previa) return;
    setAplicando(true);
    try {
      // propagar=1: se este desconto é de uma promoção diária, o preço/limite aplicado
      // vai também para a lista da diária e para os dias já programados (servidor).
      const r = await chamarPromocoes(`modulo=atualizar-itens&shop_id=${shopId}&discount_id=${desconto.discount_id}&confirmar=1&propagar=1`,
        { item_list: previa.itemList });
      if (r.propagacao?.recorrente) {
        const ds = (r.propagacao.dias ?? []) as Array<{ dia: string; falhas: unknown[] }>;
        const comFalha = ds.filter((d) => d.falhas.length).map((d) => d.dia.split("-").reverse().slice(0, 2).join("/"));
        if (r.propagacao.erro) toast.error(`Promoção diária "${r.propagacao.recorrente}": não propagou`, { description: r.propagacao.erro });
        else if (comFalha.length) toast.warning(`Promoção diária "${r.propagacao.recorrente}": recusa em ${comFalha.length} dia(s)`, { description: `Dias: ${comFalha.join(", ")} — veja o motivo nos dias do painel.`, duration: 15000 });
        else if (ds.length) toast.success(`Também aplicado nos ${ds.length} dia(s) programado(s) da promoção diária "${r.propagacao.recorrente}"`);
      }
      const falhas = (r.response?.error_list ?? []) as Array<{ item_id: number; model_id?: number; fail_message?: string; fail_error?: string }>;
      // Recusa é POR variação: o resto da lista é aplicado normalmente.
      const falhou = (l: Linha) => falhas.some((f) => Number(f.item_id) === l.item_id && (!f.model_id || Number(f.model_id) === l.model_id));
      const nOk = r.erro ? 0 : previa.mudancas.filter(({ l }) => !falhou(l)).length;
      if (r.erro) {
        toast.error("A Shopee recusou tudo — nada foi alterado", { description: `${r.erro.error}: ${traduzirErroShopee(r.erro.message)}`, duration: 12000 });
      } else if (falhas.length > 0) {
        toast.warning(`${nOk} alteração(ões) aplicada(s) · ${falhas.length} recusada(s)`, {
          description: falhas.slice(0, 5).map((f) => {
            const l = linhas.find((x) => x.item_id === Number(f.item_id) && (!f.model_id || x.model_id === Number(f.model_id)));
            return `${l?.sku ?? f.item_id}: ${traduzirErroShopee(f.fail_message ?? f.fail_error)}`;
          }).join("\n") + "\nAs recusadas continuam marcadas na tabela para você ajustar.",
          duration: 20000,
        });
      } else {
        toast.success(`Promoção atualizada na Shopee — ${previa.mudancas.length} alteração(ões)`);
      }
      setPrevia(null);
      // mantém o rascunho só do que a Shopee recusou (o resto já é o valor real)
      if (r.erro) { /* nada aplicado: mantém tudo */ } else {
        setPrecos((m) => new Map([...m].filter(([k]) => { const l = linhas.find((x) => x.key === k); return !!l && falhou(l); })));
        setLimites((m) => new Map([...m].filter(([id]) => falhas.some((f) => Number(f.item_id) === id))));
      }
      void qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId, desconto.discount_id] });
    } catch (e) {
      toast.error("Falha ao aplicar", { description: (e as Error).message });
    } finally { setAplicando(false); }
  }

  async function remover(l: Linha) {
    if (!window.confirm(`Tirar "${l.nome}${l.variacao ? ` — ${l.variacao}` : ""}" desta promoção na Shopee? O preço volta ao cheio (${formatBRL(l.original)}) na hora.`)) return;
    setRemovendo(l.key);
    try {
      const r = await chamarPromocoes(`modulo=remover-item&shop_id=${shopId}&discount_id=${desconto.discount_id}&item_id=${l.item_id}&model_id=${l.model_id}&confirmar=1`, {});
      if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
      toast.success("Item removido da promoção");
      void qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId, desconto.discount_id] });
    } catch (e) {
      toast.error("Falha ao remover", { description: (e as Error).message });
    } finally { setRemovendo(null); }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[14px] font-semibold">{desconto.discount_name}</h3>
        <span className="text-[12px] text-muted-foreground">
          {linhas.length} item(ns)
          {resumo.neg > 0 && <span style={{ color: RED }}> · {resumo.neg} com MC negativa</span>}
          {resumo.semBase > 0 && !baseQ.isLoading && <span> · {resumo.semBase} sem custo/base</span>}
        </span>
        {catalogo && (
          <span className="text-[12px] text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Atualizando cadastro dos anúncios na Shopee… {catalogo.feitos}/{catalogo.total}
          </span>
        )}
        <div className="flex-1" />
        {editavel && linhas.length > 0 && (
          <RepetirDiario shopId={shopId} desconto={desconto}
            linhas={linhas.map((l) => ({ item_id: l.item_id, model_id: l.model_id, promo: l.promo, limite: l.limite }))} />
        )}
        {editavel && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setDlgAdd(true)}>
            <Plus className="h-3.5 w-3.5" /> Adicionar produtos
          </Button>
        )}
        {editavel && alterados.length > 0 && (
          <>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={() => { setPrecos(new Map()); setLimites(new Map()); }}>
              <Undo2 className="h-3.5 w-3.5" /> Descartar
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={montarPrevia}>
              <Save className="h-3.5 w-3.5" /> Revisar e aplicar ({alterados.length})
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative mr-2">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto (ex.: areia bumi)"
            className="h-7 w-[260px] pl-8 pr-7 text-[12px]" />
          {busca && (
            <button type="button" onClick={() => setBusca("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Limpar">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="text-[11.5px] text-muted-foreground mr-1">Margem de contribuição:</span>
        {FAIXAS_MC.map((f) => {
          const n = f.id === "todas" ? linhas.filter((l) => passaBusca(l, termos)).length
            : linhas.filter((l) => passaBusca(l, termos) && passaFaixa(f.id, calcMc(l.sku ? bases.get(l.sku) : undefined, precoDe(l), tarifa))).length;
          return (
            <Button key={f.id} size="sm" variant={faixa === f.id ? "default" : "outline"} className="h-7 text-[11.5px] px-2.5"
              onClick={() => setFaixa(f.id)}>
              {f.rotulo} <span className="ml-1 opacity-70 tabular-nums">{n}</span>
            </Button>
          );
        })}
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground mr-1">Ordenar:</span>
        {ORDENS.map((o) => (
          <Button key={o.col} size="sm" variant={ord.col === o.col ? "default" : "outline"} className="h-7 text-[11.5px] px-2.5 gap-1"
            title={o.titulo} onClick={() => setOrd({ col: o.col, dir: -1 })}>
            <o.icone className="h-3.5 w-3.5" /> {o.rotulo}
          </Button>
        ))}
      </div>

      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b bg-muted/40 text-muted-foreground text-[10.5px] uppercase tracking-wide">
              <th className="text-left font-medium px-3 py-2">Produto</th>
              <ThOrd col="cheio" ord={ord} setOrd={setOrd}>Preço cheio</ThOrd>
              <ThOrd col="promo" ord={ord} setOrd={setOrd}>Preço promo</ThOrd>
              <ThOrd col="desc" ord={ord} setOrd={setOrd}>Desc.</ThOrd>
              <ThOrd col="cmv" ord={ord} setOrd={setOrd} title="Custo do produto (kit = soma dos componentes)">CMV</ThOrd>
              <th className="text-right font-medium px-2 py-2" title="Comissão Shopee pela tabela vigente (por unidade, no preço promo) + imposto efetivo (mediana 60 dias)">Comissão + imp.</th>
              <ThOrd col="mc" ord={ord} setOrd={setOrd} title="Margem de contribuição por unidade no preço promo">MC R$</ThOrd>
              <ThOrd col="mcpct" ord={ord} setOrd={setOrd}>MC %</ThOrd>
              <ThOrd col="vendas" ord={ord} setOrd={setOrd} title="Unidades vendidas nos últimos 30 dias (nossos pedidos)">Vendas 30d</ThOrd>
              <ThOrd col="estoque" ord={ord} setOrd={setOrd}>Estoque</ThOrd>
              <th className="text-right font-medium px-2 py-2" title="Limite por comprador (0 = sem limite) — vale para o anúncio todo">Limite</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {detQ.isLoading ? (
              <tr><td colSpan={12} className="px-3 py-8 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando itens da Shopee…</td></tr>
            ) : detQ.isError ? (
              <tr><td colSpan={12} className="px-3 py-6 text-center" style={{ color: RED }}>Falha: {(detQ.error as Error).message}</td></tr>
            ) : agruparOrdenar(linhas.filter((l) => passaBusca(l, termos) && passaFaixa(faixa, calcMc(l.sku ? bases.get(l.sku) : undefined, precoDe(l), tarifa))),
                (l) => valorOrd(ord.col, l, l.sku ? bases.get(l.sku) : undefined, precoDe(l), calcMc(l.sku ? bases.get(l.sku) : undefined, precoDe(l), tarifa), vistos.get(l.key)),
                (l) => (l.sku ? bases.get(l.sku) : undefined)?.vendas_30d ?? null, ord.col, ord.dir)
              .map(({ l, primeiro, ultimo, nGrupo, vendasGrupo }) => {
              const base = l.sku ? bases.get(l.sku) : undefined;
              const p = precoDe(l);
              const mc = calcMc(base, p, tarifa);
              const desc = l.original > 0 ? 1 - p / l.original : null;
              const mudou = p !== l.promo;
              const taxas = mc && base ? mc.comissao + p * num(base.imp_pct) : null;
              return (
                <tr key={l.key} className={cn(ultimo ? "border-b last:border-0" : "border-b border-dashed border-border/40", mudou && "bg-amber-500/5")}>
                  <td className="px-3 py-1.5">
                    {primeiro ? (
                      <div className="flex items-center gap-2.5 min-w-[280px]">
                        <Foto url={l.imagem} size={38} />
                        <div className="min-w-0">
                          <div className="truncate max-w-[560px] font-medium" title={l.nome}>{l.nome}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {l.sku ?? "sem SKU"}{l.variacao ? ` · ${l.variacao}` : ""}
                            {nGrupo > 1 && <span className="ml-1.5 text-[10.5px] rounded bg-muted px-1.5 py-px">{nGrupo} variações</span>}
                            {ord.col === "recentes" && <Entrada v={vistos.get(l.key)} />}
                            <SeloRelampago r={naRelampago.get(l.key)} />
                          </div>
                        </div>
                      </div>
                    ) : (
                      // demais variações do mesmo anúncio: só o que muda, recuado sob a foto
                      <div className="pl-[48px] text-[11.5px] text-muted-foreground min-w-[280px]">
                        <span className="font-mono">{l.sku ?? "sem SKU"}</span>{l.variacao ? ` · ${l.variacao}` : ""}
                        {ord.col === "recentes" && <Entrada v={vistos.get(l.key)} />}
                        <SeloRelampago r={naRelampago.get(l.key)} />
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">{formatBRL(l.original)}</td>
                  <td className="px-2 py-1.5 text-right">
                    {editavel ? (
                      <CampoPreco valor={p} alterado={mudou}
                        onMudar={(v) => setPrecos((m) => { const n = new Map(m); if (v === l.promo) n.delete(l.key); else n.set(l.key, v); return n; })} />
                    ) : <span className="tabular-nums font-mono">{formatBRL(p)}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono"
                    style={{ color: desc == null || desc <= 0 ? RED : undefined }}>
                    {desc != null ? `${(desc * 100).toFixed(0)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">
                    {base?.cmv != null ? formatBRL(num(base.cmv)) : baseQ.isLoading ? "…" : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground"
                    title={mc && base ? `${mc.regra} = ${formatBRL(mc.comissao)} + imposto ${(num(base.imp_pct) * 100).toFixed(1)}% = ${formatBRL(p * num(base.imp_pct))}` : undefined}>
                    {taxas != null ? formatBRL(taxas) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono" style={{ color: mc ? corMc(mc.pct) : undefined }}
                    title={tituloMc(base, mc)}>
                    {mc ? formatBRL(mc.mc) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono font-semibold" style={{ color: mc ? corMc(mc.pct) : undefined }}
                    title={tituloMc(base, mc)}>
                    {mc ? `${(mc.pct * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {base ? num(base.vendas_30d) : "—"}
                    {primeiro && nGrupo > 1 && vendasGrupo != null && (
                      <div className="text-[10.5px] font-semibold text-foreground" title="Soma das variações do anúncio (usada na ordenação)">anúncio: {vendasGrupo}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{l.estoque ?? "—"}</td>
                  <td className="px-2 py-1.5 text-right">
                    {editavel && primeiro ? (
                      <CampoPreco valor={limiteDe(l)} inteiro alterado={limiteDe(l) !== l.limite}
                        onMudar={(v) => setLimites((m) => { const n = new Map(m); if (v === l.limite) n.delete(l.item_id); else n.set(l.item_id, Math.max(0, Math.round(v))); return n; })} />
                    ) : <span className="tabular-nums text-muted-foreground">{primeiro ? (l.limite || "—") : ""}</span>}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {primeiro && editavel && (
                      <Button variant="ghost" size="icon" className="h-7 w-7"
                        style={{ color: itemNaRelampago(naRelampago, l.item_id) ? AMBER : undefined }}
                        title={itemNaRelampago(naRelampago, l.item_id)
                          ? "Já está na relâmpago diária. Clicar de novo regrava preço (teto) e estoque de todas as variações"
                          : "Clonar para a Relâmpago: todas as variações, no maior preço que a Shopee deve aceitar e estoque alto"}
                        disabled={clonando === l.item_id || baseQ.isLoading}
                        onClick={() => void clonarRelampago(l.item_id)}>
                        {clonando === l.item_id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Zap className="h-3.5 w-3.5" fill={itemNaRelampago(naRelampago, l.item_id) ? "currentColor" : "none"} />}
                      </Button>
                    )}
                    {editavel && (
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Tirar da promoção"
                        disabled={removendo === l.key} onClick={() => void remover(l)}>
                        {removendo === l.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        {editavel
          ? "Edite o preço promo e o limite direto na tabela — nada vai para a Shopee até \"Revisar e aplicar\". A promoção continua a mesma (não precisa recriar)."
          : "Promoção encerrada — só consulta."}
        {ord.col === "recentes" && " \"Últimos adicionados\" usa a 1ª vez que o app viu o item neste desconto (a Shopee não informa a data de inclusão); os que já estavam na 1ª leitura ficam no fim, na ordem da Shopee."}
        {" "}⚡ clona o anúncio para a relâmpago diária no maior preço aceito (1% abaixo do promo daqui e no máximo o menor preço vendido em 7 dias), com estoque alto.
        {" "}MC = preço − comissão Shopee (tabela vigente: abaixo de R$ 80 = 20% + R$ 4,50 por unidade) − imposto (efetivo 60 dias) − CMV.
      </p>

      {dlgAdd && (
        <AdicionarAoDesconto shopId={shopId} desconto={desconto} onFechar={() => setDlgAdd(false)}
          onAdicionou={() => void qc.invalidateQueries({ queryKey: ["promo-shopee", "detalhe", shopId, desconto.discount_id] })} />
      )}

      <Dialog open={previa !== null} onOpenChange={(v) => { if (!v) setPrevia(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Aplicar na Shopee?</DialogTitle>
            <DialogDescription>
              “{desconto.discount_name}” — o preço público muda <b>na hora</b>.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[360px] overflow-y-auto rounded-md border divide-y text-[12.5px]">
            {previa?.mudancas.map(({ l, de, para, limDe, limPara }) => {
              const mc = calcMc(l.sku ? bases.get(l.sku) : undefined, para, tarifa);
              return (
                <div key={l.key} className="flex items-center gap-3 px-3 py-1.5">
                  <span className="flex-1 min-w-0 truncate">{l.sku ?? l.nome}{l.variacao ? ` · ${l.variacao}` : ""}</span>
                  {de !== para && <span className="tabular-nums font-mono whitespace-nowrap">{formatBRL(de)} → <b>{formatBRL(para)}</b></span>}
                  {limDe !== limPara && l.primeiraDoItem && <span className="text-muted-foreground whitespace-nowrap">limite {limDe || "∞"} → <b>{limPara || "∞"}</b></span>}
                  <span className="tabular-nums font-mono w-[64px] text-right" style={{ color: mc ? corMc(mc.pct) : undefined }}>
                    {mc ? `${(mc.pct * 100).toFixed(1)}%` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
          {previa?.mudancas.some(({ l, para }) => { const mc = calcMc(l.sku ? bases.get(l.sku) : undefined, para, tarifa); return mc != null && mc.mc < 0; }) && (
            <p className="text-[12px] flex items-center gap-1.5" style={{ color: RED }}>
              <AlertTriangle className="h-3.5 w-3.5" /> Há item com MC negativa no preço novo.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPrevia(null)}>Cancelar</Button>
            <Button size="sm" className="gap-1.5" disabled={aplicando} onClick={() => void aplicar()}>
              {aplicando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Aplicar na Shopee
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Campo numérico com edição local; confirma no blur/Enter.
function CampoPreco({ valor, onMudar, alterado, inteiro }: {
  valor: number; onMudar: (v: number) => void; alterado?: boolean; inteiro?: boolean;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const mostrado = txt ?? (inteiro ? String(valor) : valor.toFixed(2));
  return (
    <Input
      className={cn("h-7 text-[12.5px] tabular-nums font-mono text-right px-1.5 ml-auto", inteiro ? "w-[56px]" : "w-[84px]",
        alterado && "border-amber-500 bg-amber-500/10")}
      inputMode="decimal" value={mostrado}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        if (txt === null) return;
        const v = Number(txt.replace(",", "."));
        setTxt(null);
        if (Number.isFinite(v) && v >= 0) onMudar(inteiro ? Math.round(v) : Math.round(v * 100) / 100);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

// ---- ordenação da tabela (padrão: mais vendidos nos últimos 30 dias) --------
type ColOrd = "vendas" | "recentes" | "mcpct" | "mc" | "desc" | "cheio" | "promo" | "cmv" | "estoque";
type Visto = { em: number; inicial: boolean };

const ORDENS: Array<{ col: ColOrd; rotulo: string; titulo: string; icone: typeof TrendingUp }> = [
  { col: "vendas", rotulo: "Mais vendidos", titulo: "Unidades vendidas nos últimos 30 dias (soma das variações do anúncio)", icone: TrendingUp },
  { col: "recentes", rotulo: "Últimos adicionados", titulo: "Os que entraram por último nesta promoção primeiro", icone: Clock },
];

const dataCurta = (ms: number) =>
  new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function Entrada({ v }: { v: Visto | undefined }) {
  if (!v) return null;
  return v.inicial
    ? <span className="ml-1.5 text-[10.5px] text-muted-foreground" title="Já estava na promoção quando o app leu este desconto pela 1ª vez — data real de inclusão desconhecida">· já estava em {dataCurta(v.em)}</span>
    : <span className="ml-1.5 text-[10.5px] rounded px-1.5 py-px font-medium" style={{ background: `${GREEN}18`, color: GREEN }} title="Quando o item apareceu neste desconto">entrou {dataCurta(v.em)}</span>;
}

function valorOrd(col: ColOrd, l: Linha, base: McBase | undefined, promo: number, mc: ReturnType<typeof calcMc>, visto?: Visto): number | null {
  switch (col) {
    case "vendas": return base ? num(base.vendas_30d) : null;
    // segundos da 1ª leitura (os "inicial" vão para o fim) e, no empate, a ordem da Shopee
    case "recentes": return visto ? (visto.inicial ? 0 : Math.floor(visto.em / 1000)) * 1e5 + (1e5 - Math.min(l.pos, 99999)) : null;
    case "mcpct": return mc ? mc.pct : null;
    case "mc": return mc ? mc.mc : null;
    case "desc": return l.original > 0 ? 1 - promo / l.original : null;
    case "cheio": return l.original;
    case "promo": return promo;
    case "cmv": return base?.cmv != null ? num(base.cmv) : null;
    case "estoque": return l.estoque;
  }
}

// Agrupa as variações do MESMO anúncio e ordena os grupos: em "vendas" pela
// SOMA das variações; nas demais colunas pelo melhor valor do grupo no sentido
// escolhido. Dentro do grupo, as variações seguem a mesma coluna. Sem valor
// vai para o fim; empate = nome.
function agruparOrdenar<T extends { nome: string; item_id: number }>(
  xs: T[], val: (x: T) => number | null, vendas: (x: T) => number | null, col: ColOrd, dir: 1 | -1,
): Array<{ l: T; primeiro: boolean; ultimo: boolean; nGrupo: number; vendasGrupo: number | null }> {
  const cmp = (va: number | null, vb: number | null, na: string, nb: string) => {
    if (va == null && vb == null) return na.localeCompare(nb);
    if (va == null) return 1;
    if (vb == null) return -1;
    return va === vb ? na.localeCompare(nb) : (va - vb) * dir;
  };
  const grupos = new Map<number, T[]>();
  for (const x of xs) { if (!grupos.has(x.item_id)) grupos.set(x.item_id, []); grupos.get(x.item_id)!.push(x); }
  const lista = [...grupos.values()].map((ls) => {
    ls.sort((a, b) => cmp(val(a), val(b), a.nome, b.nome));
    const vs = ls.map(vendas).filter((v): v is number => v != null).map(Number);
    const vendasGrupo = vs.length ? vs.reduce((s, v) => s + v, 0) : null;
    const vals = ls.map(val).filter((v): v is number => v != null);
    const chave = col === "vendas" ? vendasGrupo : vals.length ? (dir === -1 ? Math.max(...vals) : Math.min(...vals)) : null;
    return { ls, chave, vendasGrupo, nome: ls[0].nome };
  });
  lista.sort((a, b) => cmp(a.chave, b.chave, a.nome, b.nome));
  return lista.flatMap((g) => g.ls.map((l, i) => ({
    l, primeiro: i === 0, ultimo: i === g.ls.length - 1, nGrupo: g.ls.length, vendasGrupo: g.vendasGrupo,
  })));
}

function ThOrd({ col, ord, setOrd, title, children }: {
  col: ColOrd; ord: { col: ColOrd; dir: 1 | -1 }; setOrd: (o: { col: ColOrd; dir: 1 | -1 }) => void;
  title?: string; children: React.ReactNode;
}) {
  const ativo = ord.col === col;
  return (
    <th className="text-right font-medium px-2 py-2" title={title}>
      <button type="button" className={cn("inline-flex items-center gap-0.5 uppercase hover:text-foreground", ativo && "text-foreground")}
        onClick={() => setOrd({ col, dir: ativo ? (ord.dir === -1 ? 1 : -1) : -1 })}>
        {children}
        {ativo && (ord.dir === -1 ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  );
}

// ---- clonar para a relâmpago ------------------------------------------------
type ProgRel = { preco_promo: number; ativo: boolean };

function itemNaRelampago(m: Map<string, ProgRel>, itemId: number) {
  for (const [k, v] of m) if (v.ativo && k.startsWith(`${itemId}:`)) return true;
  return false;
}

function SeloRelampago({ r }: { r: ProgRel | undefined }) {
  if (!r) return null;
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10.5px] rounded px-1.5 py-px font-medium"
      style={{ background: `${AMBER}18`, color: AMBER, opacity: r.ativo ? 1 : 0.5 }}
      title={r.ativo ? "Na programação diária da relâmpago" : "Na programação da relâmpago, mas desativado"}>
      <Zap className="h-2.5 w-2.5" /> {formatBRL(r.preco_promo)}{r.ativo ? "" : " (off)"}
    </span>
  );
}
