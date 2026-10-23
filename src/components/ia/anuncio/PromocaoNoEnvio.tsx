import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Tag } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarPromocoes, traduzirErroShopee } from "@/components/promocoes/comum";
import { EV_PRONTO, EV_VAI_CRIAR, type AnuncioPronto, type VaiCriar } from "@/lib/iaEnvioEventos";

// ============================================================================
// "Minha Promoção" já no envio (13/out/2026, pedido do dono). Na conferência de CRIAR o anúncio
// na Shopee, o operador escolhe uma promoção em andamento (ou programada) e a margem de
// contribuição do preço promocional — 10%, 15%, 17,25% ou 20%. O preço de cada SKU vem do banco
// (`ia_calcular_preco`, a mesma conta do bloco Preço). Quando o anúncio fica pronto (criado, e
// com as variações criadas se for o caso), este bloco cadastra os itens na promoção
// (`shopee-promocoes?modulo=add-itens`). A escrita não é repetida sozinha: se falhar, fica o
// botão para tentar de novo.
// ATUALIZAR (20/out/2026, pedido do dono): o bloco também aparece na conferência de ATUALIZAR um
// anúncio que já existe. Ele procura em que promoção (em andamento ou programada) o anúncio já
// está e mostra o preço promocional de hoje; ao terminar a atualização (ou pelo botão "Só trocar
// agora"), troca o preço na promoção em que o item já está (`atualizar-itens`, mantendo o limite
// de compra e as outras variações) ou cadastra numa promoção nova (`add-itens`).
// "ATUALIZAR TAMBÉM" (20/out/2026, pedido do dono): cada anúncio marcado ali (outra loja, ex. Bumi) ganha
// o SEU bloco, com as promoções da loja dele e o botão "Só cadastrar na promoção agora". Os avisos do envio
// levam o `item_id`, e cada bloco só responde pelo seu anúncio.
// ============================================================================

/** O que o envio diz a este bloco: criar (o anúncio ainda não existe) ou atualizar o anúncio `itemId`.
 *  `precoCheio` = o preço cheio que vai valer depois do envio (o novo, se o preço for trocado). */
export interface EnvioAlvo { modo: "criar" | "atualizar"; itemId: string | null; precoCheio: number | null; /** preço cheio de HOJE (o "só trocar agora" vale antes da atualização) */ precoAtual?: number | null }
export const EnvioAlvoContext = createContext<EnvioAlvo>({ modo: "criar", itemId: null, precoCheio: null });

const LOJA: Record<string, number> = { ottz: 522186766, svl: 759046323 };
const NOME_LOJA: Record<string, string> = { ottz: "Ottz", svl: "Bumi" };
export const FAIXAS_PROMO = [0.1, 0.15, 0.1725, 0.2];
const FAIXA_PADRAO = 0.1725;
// A Shopee recusa variações quando o preço promocional da mais cara fica muito acima do da mais barata
// ("difference between the maximum price and the minimum price"). 22/out/2026: 2 un a R$ 58,85 × 10 un a
// R$ 270,08 (4,6×) — só as de 4 un entraram, nas duas lojas. O limite exato não é publicado: avisa acima de 4×.
const LIMITE_DIFERENCA = 4;
const rotulo = (f: number) => `${(f * 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",")}%`;
const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const dia = (t: number) => new Date(t * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

interface Desconto { discount_id: number; discount_name: string; start_time: number; end_time: number; status: string }
interface Resultado { ok: number; falhas: string[]; nome: string }
interface ModeloApi { model_id: number; model_promotion_price?: number | string }
interface ItemApi { item_id: number; purchase_limit?: number | string; item_promotion_price?: number | string; model_list?: ModeloApi[] }
interface ModeloEspelho { model_id: number; sku: string | null; nome_variacao: string | null; preco: number | null; preco_original: number | null }
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

/** A margem de contribuição que o SKU dá neste preço promocional (a conta do bloco Preço: `ia_analisar_preco`).
 *  Acompanha o que é digitado, com um pequeno atraso para não consultar a cada tecla. */
function MargemDoPreco({ sku, empresa, preco }: { sku: string; empresa: string; preco: number | null }) {
  const [p, setP] = useState(preco);
  useEffect(() => { const x = setTimeout(() => setP(preco), 450); return () => clearTimeout(x); }, [preco]);
  const q = useQuery({
    queryKey: ["ia-anuncio", "margem-do-preco", sku, empresa, p],
    enabled: p != null && p > 0,
    staleTime: 5 * 60_000,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<{ lucro_pct?: number; lucro_reais?: number; erro?: string }> => {
      const { data, error } = await supabaseExternal.rpc("ia_analisar_preco", { p_sku: sku, p_canal: "shopee", p_empresa: empresa, p_preco: p, p_margem: null });
      if (error) throw error;
      return (data ?? {}) as { lucro_pct?: number; lucro_reais?: number; erro?: string };
    },
  });
  if (!(preco != null && preco > 0)) return <span className="text-[11px] text-muted-foreground">—</span>;
  const d = q.data;
  if (!d) return q.isError ? <span className="text-[11px] text-destructive">sem margem</span> : <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />;
  if (d.erro || d.lucro_pct == null) return <span className="text-[11px] text-muted-foreground truncate" title={d.erro ?? ""}>sem margem ({d.erro ?? "sem custo"})</span>;
  const cor = d.lucro_pct < 0 ? "#C9432F" : d.lucro_pct < 0.1 ? "#B7791F" : "#0E8A5F";
  return (
    <span className={`text-xs font-semibold tabular-nums whitespace-nowrap ${q.isFetching || p !== preco ? "opacity-50" : ""}`} style={{ color: cor }}
      title="margem de contribuição neste preço promocional: depois de custo, comissão da Shopee e imposto">
      margem {(d.lucro_pct * 100).toFixed(1).replace(".", ",")}% · {formatBRL(Number(d.lucro_reais ?? 0))}
    </span>
  );
}

export function PromocaoNoEnvio({ sku, nome, empresa, comVariacoes }: { sku: string; nome: string; empresa: string; comVariacoes: boolean }) {
  const shopId = LOJA[empresa] ?? LOJA.ottz;
  const alvo = useContext(EnvioAlvoContext);
  const atualizar = alvo.modo === "atualizar" && !!alvo.itemId;
  const escolheu = useRef(false); // a pessoa mexeu na promoção nesta tela: a detecção não passa por cima
  const guarda = `ia.envio.promo.${empresa}`;
  const [descontoId, setDescontoId] = useState<number | null>(null);
  const [faixa, setFaixa] = useState(FAIXA_PADRAO);
  const [mao, setMao] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [ultimo, setUltimo] = useState<AnuncioPronto | null>(null);
  // a última escolha (promoção e margem) volta ao abrir — só conveniência de quem usa esta tela
  useEffect(() => {
    try {
      const g = JSON.parse(localStorage.getItem(guarda) ?? "null") as { id?: number; faixa?: number } | null;
      if (g?.id) setDescontoId(Number(g.id));
      if (g?.faixa && FAIXAS_PROMO.includes(g.faixa)) setFaixa(g.faixa);
    } catch { /* sem armazenamento: segue sem lembrar */ }
  }, [guarda]);
  const lembrar = (id: number | null, f: number) => { try { localStorage.setItem(guarda, JSON.stringify({ id, faixa: f })); } catch { /* idem */ } };

  const descQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promocoes", shopId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Desconto[]> => {
      const out: Desconto[] = [];
      for (const status of ["ongoing", "upcoming"]) {
        const r = await chamarPromocoes(`modulo=list&shop_id=${shopId}&status=${status}`);
        if (r.erro) throw new Error(typeof r.erro === "string" ? r.erro : `${r.erro?.error ?? ""} ${r.erro?.message ?? ""}`.trim());
        for (const d of (r.descontos ?? []) as Desconto[]) out.push({ ...d, status });
      }
      return out.sort((a, z) => Number(z.status === "ongoing") - Number(a.status === "ongoing") || a.start_time - z.start_time);
    },
  });
  const descontos = descQ.data ?? [];
  const desconto = descontos.find((d) => d.discount_id === descontoId) ?? null;

  // ATUALIZAR: as variações do anúncio (espelho) e em que promoção ele já está (lido na Shopee)
  const modelosQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promo-modelos", shopId, alvo.itemId],
    enabled: atualizar, placeholderData: undefined, gcTime: 0,
    queryFn: async (): Promise<ModeloEspelho[]> => {
      const { data, error } = await supabaseExternal.from("shopee_anuncios_variacao").select("model_id, sku, nome_variacao, preco, preco_original")
        .eq("shop_id", shopId).eq("item_id", String(alvo.itemId));
      if (error) throw error;
      return ((data ?? []) as ModeloEspelho[]).filter((m) => Number(m.model_id) > 0).map((m) => ({ ...m, model_id: Number(m.model_id) }));
    },
  });
  const modelos = atualizar ? (modelosQ.data ?? []) : [];
  const ondeQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promo-onde", shopId, alvo.itemId, descontos.map((d) => d.discount_id).join(",")],
    enabled: atualizar && descontos.length > 0, placeholderData: undefined, gcTime: 0, staleTime: 0,
    queryFn: async (): Promise<{ desconto: Desconto; item: ItemApi }[]> => {
      const rs = await Promise.all(descontos.map((d) => chamarPromocoes(`modulo=detalhe&shop_id=${shopId}&discount_id=${d.discount_id}`).then((r) => ({ d, r }))));
      const achados: { desconto: Desconto; item: ItemApi }[] = [];
      for (const { d, r } of rs) for (const it of (r.itens ?? []) as ItemApi[]) if (String(it.item_id) === String(alvo.itemId)) achados.push({ desconto: d, item: it });
      return achados;
    },
  });
  const onde = atualizar ? (ondeQ.data ?? []) : [];
  // o anúncio já está numa promoção: ela vem escolhida (a memória da última escolha não vale aqui)
  useEffect(() => {
    if (!atualizar || escolheu.current || !ondeQ.data?.length) return;
    setDescontoId(ondeQ.data[0].desconto.discount_id);
  }, [atualizar, ondeQ.data]);
  const noEscolhido = onde.find((x) => x.desconto.discount_id === descontoId) ?? null;
  const promoHoje = (s: string): number | null => {
    if (!noEscolhido) return null;
    const ml = noEscolhido.item.model_list ?? [];
    if (ml.length) {
      const m = modelos.find((x) => x.sku === s);
      const pm = m ? ml.find((x) => Number(x.model_id) === m.model_id) : null;
      return pm ? num(pm.model_promotion_price) || null : null;
    }
    return num(noEscolhido.item.item_promotion_price) || null;
  };

  const skusQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promo-skus", sku, comVariacoes],
    queryFn: async (): Promise<{ sku: string; nome: string }[]> => {
      if (!comVariacoes) return [{ sku, nome }];
      const { data } = await supabaseExternal.from("produtos").select("sku, nome").eq("sku_pai", sku).eq("ativo", true).order("sku");
      const vs = ((data ?? []) as { sku: string; nome: string | null }[]).map((v) => {
        const n = v.nome ?? v.sku;
        return { sku: v.sku, nome: (n.startsWith(`${nome} - `) ? n.slice(nome.length + 3) : n).trim() };
      });
      return vs.length ? vs : [{ sku, nome }];
    },
  });
  // atualizar anúncio com variações: as variações DESTE anúncio na Shopee (não as do cadastro)
  const skusModelos = modelos.filter((m) => m.sku).map((m) => ({ sku: String(m.sku), nome: m.nome_variacao ?? String(m.sku) }));
  const skus = atualizar && skusModelos.length ? skusModelos : (skusQ.data ?? []);
  const precosQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promo-precos", empresa, faixa, skus.map((s) => s.sku).join(",")],
    enabled: skus.length > 0 && desconto != null,
    placeholderData: undefined,
    queryFn: async (): Promise<Record<string, { preco: number | null; erro: string | null }>> => {
      const rs = await Promise.all(skus.map((s) => supabaseExternal.rpc("ia_calcular_preco", { p_sku: s.sku, p_canal: "shopee", p_empresa: empresa, p_margem: faixa })));
      return Object.fromEntries(skus.map((s, i) => {
        const d = (rs[i].data ?? {}) as { preco_sugerido?: number; erro?: string };
        return [s.sku, { preco: d.preco_sugerido != null ? Number(d.preco_sugerido) : null, erro: rs[i].error?.message ?? d.erro ?? null }];
      }));
    },
  });
  const calc = precosQ.data ?? {};
  const promoDe = (s: string): number | null => {
    const m = mao[s];
    if (m != null && m.trim() !== "") { const v = paraNumero(m); return v > 0 ? v : null; }
    return calc[s]?.preco ?? null;
  };
  // diferença entre o promocional mais caro e o mais barato do anúncio (regra da Shopee, ver LIMITE_DIFERENCA)
  const comPreco = skus.map((s) => ({ sku: s.sku, nome: s.nome, v: promoDe(s.sku) }))
    .filter((x): x is { sku: string; nome: string; v: number } => x.v != null && x.v > 0);
  const diferenca = comPreco.length > 1 ? (() => {
    const min = comPreco.reduce((a, b) => (b.v < a.v ? b : a));
    const max = comPreco.reduce((a, b) => (b.v > a.v ? b : a));
    const piso = Math.ceil((max.v / LIMITE_DIFERENCA) * 100) / 100;
    return { min, max, razao: max.v / min.v, piso, abaixo: comPreco.filter((x) => x.v < piso) };
  })() : null;
  const diferencaAlta = diferenca && diferenca.razao > LIMITE_DIFERENCA ? diferenca : null;
  const vezes = (r: number) => `${r.toFixed(1).replace(".", ",")}×`;

  async function cadastrar(d0: AnuncioPronto) {
    if (!desconto) return;
    // atualizar: o envio não sabe as variações nem o preço cheio de cada uma — vêm do espelho
    const d: AnuncioPronto = atualizar && !d0.modelos?.length && modelos.some((m) => m.sku)
      ? { ...d0, modelos: modelos.filter((m) => m.sku).map((m) => ({ model_id: m.model_id, sku: String(m.sku) })),
          precos: { ...Object.fromEntries(modelos.filter((m) => m.sku && (m.preco_original ?? m.preco)).map((m) => [String(m.sku), Number(m.preco_original ?? m.preco)])), ...d0.precos } }
      : d0;
    const pulados: string[] = [];
    const vale = (s: string): number | null => {
      const promo = promoDe(s); const cheio = d.precos[s];
      if (!(promo && promo > 0)) { pulados.push(`${s}: sem preço promocional`); return null; }
      if (cheio != null && promo >= cheio) { pulados.push(`${s}: o promocional (${formatBRL(promo)}) não fica abaixo do preço cheio (${formatBRL(cheio)})`); return null; }
      return promo;
    };
    // o item já está NESTA promoção: troca o preço nela (limite de compra e as outras variações ficam)
    const ja = atualizar ? noEscolhido?.item ?? null : null;
    const chamadas: { modulo: string; item: Record<string, unknown>; n: number }[] = [];
    if (d.modelos?.length) {
      const lista = d.modelos.map((m) => ({ model_id: m.model_id, sku: m.sku, promo: vale(m.sku) }))
        .filter((x): x is { model_id: number; sku: string; promo: number } => x.promo != null);
      const naPromo = new Set((ja?.model_list ?? []).map((m) => Number(m.model_id)));
      const trocar = lista.filter((x) => naPromo.has(x.model_id));
      const novos = lista.filter((x) => !naPromo.has(x.model_id));
      if (ja && trocar.length) {
        const novo = new Map(trocar.map((x) => [x.model_id, x.promo]));
        chamadas.push({ modulo: "atualizar-itens", n: trocar.length, item: { item_id: Number(d.item_id), purchase_limit: num(ja.purchase_limit),
          model_list: (ja.model_list ?? []).map((m) => ({ model_id: Number(m.model_id), model_promotion_price: novo.get(Number(m.model_id)) ?? num(m.model_promotion_price) })) } });
      }
      if (novos.length) chamadas.push({ modulo: "add-itens", n: novos.length, item: { item_id: Number(d.item_id), purchase_limit: ja ? num(ja.purchase_limit) : 0,
        model_list: novos.map((x) => ({ model_id: x.model_id, model_promotion_price: x.promo })) } });
    } else {
      const promo = vale(d.sku);
      if (promo != null) chamadas.push(ja
        ? { modulo: "atualizar-itens", n: 1, item: { item_id: Number(d.item_id), purchase_limit: num(ja.purchase_limit), item_promotion_price: promo } }
        : { modulo: "add-itens", n: 1, item: { item_id: Number(d.item_id), purchase_limit: 0, item_promotion_price: promo } });
    }
    setUltimo(d0);
    if (!chamadas.length) { setResultado({ ok: 0, falhas: pulados.length ? pulados : ["nenhum preço promocional para cadastrar"], nome: desconto.discount_name }); return; }
    setOcupado(true);
    const falhas = [...pulados]; let ok = 0;
    try {
      for (const c of chamadas) {
        const r = await chamarPromocoes(`modulo=${c.modulo}&shop_id=${shopId}&discount_id=${desconto.discount_id}&confirmar=1&propagar=1`, { item_list: [c.item] });
        if (r.erro) { falhas.push(traduzirErroShopee(typeof r.erro === "string" ? r.erro : `${r.erro?.error ?? ""}: ${r.erro?.message ?? ""}`)); continue; }
        const errs = (r.response?.error_list ?? []) as Array<{ item_id: number; model_id?: number; fail_message?: string; fail_error?: string }>;
        for (const e of errs) {
          const s = d.modelos?.find((m) => m.model_id === Number(e.model_id))?.sku ?? d.sku;
          falhas.push(`${s}: ${traduzirErroShopee(e.fail_message || e.fail_error)}`);
        }
        ok += Math.max(0, c.n - errs.length);
      }
      setResultado({ ok, falhas, nome: desconto.discount_name });
      const verbo = chamadas.every((c) => c.modulo === "atualizar-itens") ? "Preço promocional trocado" : "Cadastrado";
      if (ok > 0 && !falhas.length) toast.success(`${verbo} na promoção "${desconto.discount_name}"`, { description: `${ok} preço(s) promocional(is) · margem de ${rotulo(faixa)}` });
      else toast.warning(`Promoção "${desconto.discount_name}": ${ok} cadastrado(s), ${falhas.length} pendência(s)`, { duration: 20000 });
      if (atualizar) void ondeQ.refetch();
    } catch (e) {
      setResultado({ ok, falhas: [...falhas, (e as Error).message], nome: desconto.discount_name });
      toast.error("Não consegui cadastrar na promoção", { description: (e as Error).message, duration: 20000 });
    } finally { setOcupado(false); }
  }

  // os avisos do envio leem sempre o estado atual
  const agora = useRef({ desconto, faixa, cadastrar, skus: skus.length, troca: false, alvo, diferencaAlta });
  agora.current = { desconto, faixa, cadastrar, skus: skus.length, troca: !!noEscolhido, alvo, diferencaAlta };
  useEffect(() => {
    // no atualizar, cada bloco responde só pelo SEU anúncio (o principal e os de "Atualizar também" podem ser da mesma loja)
    const eDaqui = (d: { canal?: string; empresa?: string; sku?: string; item_id?: string | null }) => {
      if (!(d.canal === "shopee" && d.empresa === empresa && d.sku === sku)) return false;
      const a = agora.current.alvo;
      return !(a.modo === "atualizar" && a.itemId && d.item_id && String(d.item_id) !== String(a.itemId));
    };
    const vaiCriar = (ev: Event) => {
      const d = (ev as CustomEvent).detail as VaiCriar;
      const a = agora.current;
      const dif = a.diferencaAlta;
      if (!eDaqui(d) || !a.desconto) return;
      d.promocao = `"${a.desconto.discount_name}" com margem de ${rotulo(a.faixa)}${a.troca ? " (troca o preço promocional de hoje)" : ""}`;
      d.promocao_aviso = dif
        ? `ATENÇÃO, promoção: o preço promocional mais caro (${dif.max.sku}, ${formatBRL(dif.max.v)}) fica ${vezes(dif.razao)} o mais barato (${dif.min.sku}, ${formatBRL(dif.min.v)}) — a Shopee deve recusar parte das variações. Para evitar, cancele e deixe o mais barato em pelo menos ${formatBRL(dif.piso)} no bloco Minha Promoção.`
        : null;
    };
    const pronto = (ev: Event) => {
      const d = (ev as CustomEvent).detail as AnuncioPronto;
      const a = agora.current;
      // sem o preço cheio no aviso, vale o que o envio disse a este bloco (o de depois da atualização)
      if (eDaqui(d) && d.item_id && a.desconto) void a.cadastrar(a.alvo.precoCheio != null && d.precos[sku] == null ? { ...d, precos: { ...d.precos, [sku]: a.alvo.precoCheio } } : d);
    };
    window.addEventListener(EV_VAI_CRIAR, vaiCriar); window.addEventListener(EV_PRONTO, pronto);
    return () => { window.removeEventListener(EV_VAI_CRIAR, vaiCriar); window.removeEventListener(EV_PRONTO, pronto); };
  }, [sku, empresa]);

  return (
    <div className="rounded-md border p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Tag className="h-4 w-4" /><b>Minha Promoção</b>
        <span className="text-xs text-muted-foreground">{atualizar
          ? `— o preço promocional do anúncio ${alvo.itemId} (Shopee ${NOME_LOJA[empresa] ?? empresa}), enviado junto com a atualização`
          : "— cadastrar o anúncio numa promoção assim que ele for criado"}</span>
        {(descQ.isFetching || precosQ.isFetching || ondeQ.isFetching || ocupado) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {atualizar && !ondeQ.isFetching && ondeQ.data && (
        <p className="text-xs">
          {onde.length
            ? <>Hoje o anúncio está {onde.length > 1 ? "nas promoções" : "na promoção"} {onde.map((x) => `"${x.desconto.discount_name}"`).join(", ")}
                {noEscolhido ? <span className="text-muted-foreground"> — o preço promocional é trocado nela.</span> : null}</>
            : <span className="text-muted-foreground">Hoje o anúncio não está em nenhuma promoção em andamento ou programada.</span>}
        </p>
      )}
      {ondeQ.isError && <p className="text-xs text-destructive">Não consegui ver em que promoção o anúncio está: {(ondeQ.error as Error).message}</p>}
      {descQ.isError
        ? <p className="text-xs text-destructive">Não consegui ler as promoções da Shopee: {(descQ.error as Error).message}</p>
        : (
          <select className="h-8 w-full max-w-xl rounded-md border bg-background px-2 text-xs" value={descontoId ?? ""}
            onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; escolheu.current = true; setDescontoId(id); setResultado(null); lembrar(id, faixa); }}>
            <option value="">Não cadastrar em promoção</option>
            {descontos.map((d) => (
              <option key={d.discount_id} value={d.discount_id}>
                {d.discount_name} · {d.status === "ongoing" ? `em andamento, até ${dia(d.end_time)}` : `começa ${dia(d.start_time)}`}
              </option>
            ))}
          </select>
        )}
      {descontoId != null && !desconto && !descQ.isFetching && <p className="text-xs text-amber-600">A promoção escolhida da última vez não está mais ativa: escolha outra.</p>}
      {atualizar && desconto && !noEscolhido && onde.length > 0 && (
        <p className="text-xs text-amber-600">O anúncio já está em "{onde[0].desconto.discount_name}": a Shopee costuma recusar o mesmo anúncio em duas promoções ao mesmo tempo.</p>
      )}

      {desconto && (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground mr-1">Margem de contribuição no preço promocional:</span>
            {FAIXAS_PROMO.map((f) => (
              <Button key={f} size="sm" variant={faixa === f ? "default" : "outline"} className="h-7 px-2.5 text-xs"
                onClick={() => { setFaixa(f); setMao({}); setResultado(null); lembrar(descontoId, f); }}>{rotulo(f)}</Button>
            ))}
          </div>
          <div className="space-y-1">
            {skus.map((s) => {
              const c = calc[s.sku]; const v = promoDe(s.sku);
              return (
                <div key={s.sku} className={`grid ${atualizar ? "grid-cols-[70px_1fr_100px_110px_170px]" : "grid-cols-[70px_1fr_110px_170px]"} gap-2 items-center text-xs`}>
                  <span className="font-mono">{s.sku}</span>
                  <span className="truncate text-muted-foreground" title={s.nome}>{s.nome}{c?.erro ? <span className="text-destructive"> · {c.erro}</span> : null}</span>
                  {atualizar && (() => { const h = promoHoje(s.sku); return <span className="text-right text-muted-foreground tabular-nums" title="preço promocional de hoje nesta promoção">{h != null ? `hoje ${formatBRL(h)}` : "—"}</span>; })()}
                  <Input className="h-7 text-right tabular-nums text-xs" inputMode="decimal" placeholder={c?.preco != null ? dinheiro(c.preco) : "sem preço"}
                    value={mao[s.sku] ?? (c?.preco != null ? dinheiro(c.preco) : "")} onChange={(e) => setMao({ ...mao, [s.sku]: e.target.value })}
                    title={v != null ? `preço promocional: ${formatBRL(v)}` : "sem preço promocional: fica de fora"} />
                  <MargemDoPreco sku={s.sku} empresa={empresa} preco={v} />
                </div>
              );
            })}
          </div>
          {diferencaAlta && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs space-y-1.5">
              <div className="flex items-start gap-1.5 font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>A Shopee deve recusar parte das variações: o promocional mais caro ({diferencaAlta.max.sku}, {formatBRL(diferencaAlta.max.v)}) fica {vezes(diferencaAlta.razao)} o mais barato ({diferencaAlta.min.sku}, {formatBRL(diferencaAlta.min.v)}).</span>
              </div>
              <p className="text-muted-foreground">
                Ela limita a diferença de preço entre as variações do mesmo anúncio na promoção (com 4,6× entraram só as do meio). Para passar, deixe {diferencaAlta.abaixo.length > 1 ? "os mais baratos" : "o mais barato"} em pelo menos {formatBRL(diferencaAlta.piso)}
                {" "}({diferencaAlta.abaixo.map((x) => x.sku).join(", ")}) — ou tire da promoção a variação mais cara.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={() => setMao({ ...mao, ...Object.fromEntries(diferencaAlta.abaixo.map((x) => [x.sku, dinheiro(diferencaAlta.piso)])) })}>
                Subir {diferencaAlta.abaixo.length > 1 ? "os mais baratos" : "o mais barato"} para {formatBRL(diferencaAlta.piso)}
              </Button>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            Preço promocional de cada SKU pela margem escolhida (custo, comissão e imposto do bloco Preço); se você mudar o preço à mão, a margem ao lado mostra quanto ele rende. Quem ficar sem preço, ou com o promocional igual ou acima do preço cheio{atualizar && alvo.precoCheio != null ? ` (${formatBRL(alvo.precoCheio)} depois desta atualização)` : ""}, fica de fora. O preço promocional vale para os compradores assim que é cadastrado.
            {atualizar ? " Vai junto com o botão de atualizar, depois da troca do anúncio. Cada anúncio marcado em “Atualizar também” tem o seu próprio bloco de promoção." : ""}
          </p>
          {atualizar && (
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={ocupado || precosQ.isFetching || ondeQ.isFetching}
              onClick={() => {
                const cheio = alvo.precoAtual ?? alvo.precoCheio;
                if (!window.confirm(`${noEscolhido ? "Trocar o preço promocional do" : "Cadastrar o"} anúncio ${alvo.itemId} na promoção "${desconto.discount_name}" AGORA, sem atualizar o resto do anúncio?\n\nO preço promocional vale para os compradores na hora.`)) return;
                void cadastrar({ canal: "shopee", empresa, sku, item_id: String(alvo.itemId), precos: cheio != null ? { [sku]: cheio } : {} });
              }}>
              {noEscolhido ? "Só trocar o preço promocional agora" : "Só cadastrar na promoção agora"}
            </Button>
          )}
        </>
      )}

      {resultado && (
        <div className={`rounded-md border p-2.5 text-xs ${resultado.falhas.length ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5"}`}>
          <div className="flex items-center gap-1.5 font-medium">
            {resultado.falhas.length ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
            Promoção "{resultado.nome}": {resultado.ok} preço(s) cadastrado(s){resultado.falhas.length ? ` · ${resultado.falhas.length} ficou(aram) de fora` : ""}
          </div>
          {resultado.falhas.map((x) => <div key={x}>• {x}</div>)}
          {resultado.falhas.length > 0 && ultimo && desconto && (
            <Button size="sm" variant="outline" className="h-7 mt-1.5 text-xs" disabled={ocupado}
              onClick={() => { if (window.confirm(`Tentar de novo cadastrar o anúncio ${ultimo.item_id} na promoção "${desconto.discount_name}"?\n\nO que já entrou a Shopee recusa como repetido (não duplica).`)) void cadastrar(ultimo); }}>
              Tentar cadastrar de novo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
