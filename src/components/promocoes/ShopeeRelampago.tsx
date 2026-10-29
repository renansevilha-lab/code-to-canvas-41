import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Plus, Power, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { AvisoCustoTiny, chamarFlashsale, num, tetoRelampago, useCustoTinyAutomatico, useTarifaShopee, type McBase } from "./comum";
import { AdicionarProduto } from "./Relampago";
import { contaShopee, precoParaShopee, type CabBase } from "./ShopeeMinha";
import {
  BRL, Btn, CabecalhoMkt, CartaoRobo, Chip, FaixaDecisao, IN, INT, ListaPromos, PCT, PST, PreviaAplicar, TabelaPromo,
  parseNum, type CartaoDecisao, type EstadoLinha, type ItemLista, type ItemPrevia, type LinhaPromo, type StatusPromo,
} from "./ui/kit";

// ============================================================================
// Shopee › Relâmpago no design novo (Claude Design "Promoções", 21/out/2026, fase 2).
// Mesma regra da tela antiga (Relampago.tsx):
//   · "Amanhã" = a programação diária (flashsale_programacao) que o robô (cron 87, 18h07,
//     shopee-flashsale?modulo=programar&auto=1) reconcilia com a relâmpago de amanhã;
//     editar preço/estoque/limite/ativo grava SÓ na programação (não mexe na Shopee);
//     "Programar amanhã agora" = prévia do programar → confirmar=1 (escrita na Shopee);
//   · dias anteriores = flashsale_criadas (resultado de cada rodada) + itens da relâmpago
//     ao vivo (modulo=sale, só leitura).
// Teto relâmpago = tetoRelampago (1% abaixo do preço atual e ≤ menor preço vendido em 7 dias).
// ============================================================================

interface ProgItem {
  id: string; item_id: number; model_id: number; item_nome: string | null; model_nome: string | null; sku: string | null; imagem: string | null;
  preco_original: number | null; preco_promo: number; estoque_promo: number; limite_compra: number; ativo: boolean;
}
interface Criada {
  id: number; dia: string; flash_sale_id: number | null; status: string; itens_ok: number; itens_falha: number; criado_em: string;
  detalhe: { problemas?: Array<{ sku: string; motivo: string }> } | null;
}
interface ModeloSale { item_id: number; model_id: number; model_name?: string; status: number; original_price: number; input_promotion_price: number; campaign_stock: number; stock: number; purchase_limit: number }

const TZ = "America/Sao_Paulo";
const hojeISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const amanhaISO = () => new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ID_PROG = "prog";

type Filtro = "neg" | "lt10" | "teto" | "rec" | "semc";
const FILTRO_NOME: Record<Filtro, string> = { neg: "MC negativa", lt10: "MC abaixo de 10%", teto: "acima do teto", rec: "recusados na última rodada", semc: "sem custo" };

export function ShopeeRelampago({ shopId, cab }: { shopId: number; cab: CabBase }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const tarifa = useTarifaShopee().data;
  const [selId, setSelId] = useState<string>(ID_PROG);
  const [filtro, setFiltro] = useState<Filtro | null>(null);
  const [busca, setBusca] = useState("");
  const [faixa, setFaixa] = useState("todas");
  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [res, setRes] = useState<Map<string, { tipo: "aplicado" | "recusado" | "pulado"; motivo: string }>>(new Map());
  const [previa, setPrevia] = useState<null | { fase: "revisar" | "aplicando" | "resultado"; itens: Array<{ p: ProgItem; lp: LinhaPromo; de: number; para: number; res?: ItemPrevia["res"] }> }>(null);
  const [dlgAdd, setDlgAdd] = useState(false);
  const [dlgProg, setDlgProg] = useState<null | { dia: string; resultados: any[] }>(null);
  const [programando, setProgramando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  // ---------------------------------------------------------------- dados
  const progQ = useQuery({
    queryKey: ["flashsale", "prog", shopId],
    queryFn: async (): Promise<ProgItem[]> => {
      const { data, error } = await supabaseExternal.from("flashsale_programacao").select("*").eq("shop_id", shopId).order("item_nome").order("model_nome");
      if (error) throw error;
      return (data ?? []) as ProgItem[];
    },
  });
  const cfgQ = useQuery({
    queryKey: ["flashsale", "cfg"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("flashsale_config").select("*");
      if (error) throw error;
      return (data ?? []) as { shop_id: number; automacao_ativa: boolean }[];
    },
  });
  const histQ = useQuery({
    queryKey: ["flashsale", "hist", shopId],
    queryFn: async (): Promise<Criada[]> => {
      const { data, error } = await supabaseExternal.from("flashsale_criadas").select("*").eq("shop_id", shopId).order("dia", { ascending: false }).limit(7);
      if (error) throw error;
      return (data ?? []) as Criada[];
    },
  });
  const prog = useMemo(() => progQ.data ?? [], [progQ.data]);
  const hist = useMemo(() => histQ.data ?? [], [histQ.data]);
  const automacao = !!(cfgQ.data ?? []).find((c) => Number(c.shop_id) === shopId)?.automacao_ativa;
  const ativos = prog.filter((p) => p.ativo);

  // itens da relâmpago aberta (dia anterior/hoje), ao vivo na Shopee
  const criadaSel = selId !== ID_PROG ? hist.find((c) => String(c.id) === selId) ?? null : null;
  const saleQ = useQuery({
    queryKey: ["flashsale", "sale", shopId, criadaSel?.flash_sale_id],
    enabled: !!criadaSel?.flash_sale_id, staleTime: 2 * 60_000,
    queryFn: async () => {
      const r = await chamarFlashsale(`modulo=sale&shop_id=${shopId}&flash_sale_id=${criadaSel!.flash_sale_id}`);
      const modelos = ((r.itens?.models ?? []) as ModeloSale[]);
      const ids = [...new Set(modelos.map((m) => m.item_id))];
      const anun = new Map<number, { nome: string; imagem_url: string | null; sku_pai: string | null }>();
      const vars = new Map<number, string | null>();
      if (ids.length) {
        const [{ data: a }, { data: v }] = await Promise.all([
          supabaseExternal.from("shopee_anuncios").select("item_id, nome, imagem_url, sku_pai").eq("shop_id", shopId).in("item_id", ids),
          supabaseExternal.from("shopee_anuncios_variacao").select("model_id, sku").eq("shop_id", shopId).in("item_id", ids),
        ]);
        for (const x of (a ?? []) as Array<{ item_id: number; nome: string; imagem_url: string | null; sku_pai: string | null }>) anun.set(x.item_id, x);
        for (const x of (v ?? []) as Array<{ model_id: number; sku: string | null }>) vars.set(x.model_id, x.sku);
      }
      return { modelos, anun, vars };
    },
  });

  // base de MC (CMV, imposto, menor preço 7d, vendas 30d)
  const skus = useMemo(() => {
    const s = new Set<string>();
    for (const p of prog) if (p.sku) s.add(p.sku);
    for (const m of saleQ.data?.modelos ?? []) { const k = saleQ.data?.vars.get(m.model_id) ?? saleQ.data?.anun.get(m.item_id)?.sku_pai; if (k) s.add(k); }
    return [...s].sort();
  }, [prog, saleQ.data]);
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

  // última rodada (motivos por SKU)
  const ultima = hist[0];
  const motivoDe = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of ultima?.detalhe?.problemas ?? []) if (x.sku && !/ja estava/i.test(x.motivo)) m.set(x.sku, x.motivo);
    return m;
  }, [ultima]);

  // ---------------------------------------------------------------- linhas
  const tetoDe = (p: ProgItem) => {
    const base = p.sku ? bases.get(p.sku) : undefined;
    return tetoRelampago(num(p.preco_original), base?.menor_preco_7d != null ? num(base.menor_preco_7d) : null);
  };
  async function salvarCampo(p: ProgItem, patch: Record<string, unknown>, rotulo: string) {
    const { error } = await supabaseExternal.from("flashsale_programacao").update({ ...patch, atualizado_em: new Date().toISOString() }).eq("id", p.id);
    if (error) toast.error(`Falha ao salvar ${rotulo}`, { description: error.message });
    void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });
  }
  const linhaProg = (p: ProgItem): LinhaPromo => {
    const base = p.sku ? bases.get(p.sku) : undefined;
    const k = `${ID_PROG}|${p.id}`;
    const r = res.get(k);
    const t = tetoDe(p);
    const ult = p.sku ? motivoDe.get(p.sku) : undefined;
    let estado: EstadoLinha = p.ativo ? "programado" : "pausado";
    let motivo: string | null = null;
    if (r) { estado = r.tipo; motivo = r.tipo === "aplicado" ? null : r.motivo; }
    else if (p.ativo && t && num(p.preco_promo) > t.teto + 0.001) { estado = "aguardando"; motivo = "acima do teto: a Shopee deve recusar"; }
    else if (p.ativo && ult) { estado = /coube/i.test(ult) ? "aguardando" : "recusado"; motivo = `última rodada: ${ult}`; }
    return {
      key: k, grupo: `${p.item_id}`, nome: p.item_nome ?? "—", sub: p.model_nome && !/^[d-]+$/.test(p.model_nome) ? p.model_nome : null, foto: p.imagem, sku: p.sku, code: `ID ${p.item_id}`,
      cheio: num(p.preco_original), promo: num(p.preco_promo), estado, motivo, apagada: !p.ativo,
      v30: base ? num(base.vendas_30d) : null, estoque: null,
      conta: (preco) => contaShopee(base, preco, tarifa), cmv: base?.cmv ?? null, semCusto: !!base && base.cmv == null,
      precoPara: (a) => { const pz = precoParaShopee(base, tarifa, a, num(p.preco_original)); return pz != null && t ? Math.min(pz, t.teto) : pz; },
      estadoExtra: (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--pm-t3)" }}>
          est.<CampoMini valor={p.estoque_promo} onSalvar={(v) => void salvarCampo(p, { estoque_promo: Math.max(1, Math.min(1000, Math.round(v))) }, "estoque")} />
          lim.<CampoMini valor={p.limite_compra} onSalvar={(v) => void salvarCampo(p, { limite_compra: Math.max(0, Math.round(v)) }, "limite")} />
        </div>
      ),
    };
  };
  const linhasProg = useMemo(() => prog.map(linhaProg)
    .sort((a, b) => (Number(b.estado !== "pausado") - Number(a.estado !== "pausado")) || ((b.v30 ?? 0) - (a.v30 ?? 0)) || a.nome.localeCompare(b.nome)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prog, bases, tarifa, res, motivoDe]);
  const progDe = new Map(prog.map((p) => [`${ID_PROG}|${p.id}`, p]));

  const linhasSale: LinhaPromo[] = useMemo(() => {
    if (!criadaSel || !saleQ.data) return [];
    const hoje = criadaSel.dia === hojeISO();
    return saleQ.data.modelos.map((m) => {
      const an = saleQ.data!.anun.get(m.item_id);
      const sku = saleQ.data!.vars.get(m.model_id) ?? an?.sku_pai ?? null;
      const base = sku ? bases.get(sku) : undefined;
      // relâmpago encerrada: a Shopee zera o status de todas; vale quem tinha preço promocional
      const naPromo = criadaSel.dia < hojeISO() ? num(m.input_promotion_price) < num(m.original_price) - 0.001 : m.status === 1;
      return {
        key: `${criadaSel.id}|${m.item_id}:${m.model_id}`, grupo: `${m.item_id}`, nome: an?.nome ?? `Item ${m.item_id}`, sub: m.model_name || null, foto: an?.imagem_url ?? null,
        sku, code: `ID ${m.item_id}`, cheio: num(m.original_price), promo: num(m.input_promotion_price),
        estado: (naPromo ? (hoje ? "na" : "encerrada") : "pausado") as EstadoLinha,
        motivo: naPromo ? null : "variação fora desta relâmpago",
        v30: base ? num(base.vendas_30d) : null, estoque: num(m.stock), apagada: !naPromo,
        conta: (preco: number) => contaShopee(base, preco, tarifa), cmv: base?.cmv ?? null, semCusto: !!base && base.cmv == null,
        estadoExtra: naPromo ? <span style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>estoque na campanha {INT(num(m.campaign_stock))}</span> : undefined,
      };
    }).sort((a, b) => Number(b.estado !== "pausado") - Number(a.estado !== "pausado") || (b.v30 ?? 0) - (a.v30 ?? 0));
  }, [criadaSel, saleQ.data, bases, tarifa]);

  // ---------------------------------------------------------------- contadores
  const predicado = (f: Filtro | null) => (lp: LinhaPromo): boolean => {
    if (!f) return true;
    if (lp.estado === "pausado") return false;
    const m = lp.conta(lp.promo);
    if (f === "neg") return !!m && m.pct < 0;
    if (f === "lt10") return !!m && m.pct >= 0 && m.pct < 0.1;
    if (f === "teto") return /teto/.test(lp.motivo ?? "");
    if (f === "rec") return lp.estado === "recusado" || (lp.estado === "aguardando" && /última rodada/.test(lp.motivo ?? ""));
    if (f === "semc") return lp.semCusto;
    return true;
  };
  const contar = (f: Filtro) => linhasProg.filter(predicado(f)).length;
  const nVagas = ativos.length;
  // a Shopee também limita a relâmpago a 20 ANÚNCIOS (shopee-flashsale v12): passar de qualquer um derruba o envio
  const nAnuncios = new Set(ativos.map((p: any) => String(p.item_id))).size;
  const cards: CartaoDecisao[] = [
    { id: "neg", n: String(contar("neg")), label: "MC negativa", sub: "no preço relâmpago", tom: "var(--pm-r)" },
    { id: "lt10", n: String(contar("lt10")), label: "MC abaixo de 10%", sub: "entre 0% e 10%", tom: "var(--pm-am)" },
    { id: "vagas", n: `${Math.min(nVagas, 50)}/50`, label: "Relâmpago de amanhã", sub: nVagas > 50 ? `${nVagas - 50} ficam de fora` : `${50 - nVagas} vagas livres`, tom: "var(--pm-at)" },
    { id: "teto", n: String(contar("teto")), label: "Acima do teto", sub: "a Shopee recusa", tom: "var(--pm-r)" },
    { id: "rec", n: String(contar("rec")), label: "Recusados na última rodada", sub: ultima ? `rodada de ${dm(ultima.dia)}` : "sem rodada", tom: "var(--pm-r)" },
    { id: "semc", n: String(contar("semc")), label: "Sem custo cadastrado", sub: "MC não calculada", tom: "var(--pm-am)" },
  ].map((c) => ({
    ...c, ativo: c.id === filtro || (c.id === "vagas" && selId === ID_PROG && !filtro),
    onClick: () => { setSelId(ID_PROG); if (c.id === "vagas") { setFiltro(null); return; } setFiltro(filtro === c.id ? null : (c.id as Filtro)); setBusca(""); setFaixa("todas"); },
  }));

  // ---------------------------------------------------------------- lista
  const amanha = amanhaISO(); const hoje = hojeISO();
  const criadaAmanha = hist.find((c) => c.dia === amanha);
  const filtroF = filtro ? predicado(filtro) : null;
  const statusCriada = (c: Criada): StatusPromo => (c.dia === hoje ? "andamento" : c.dia > hoje ? "programada" : "encerrada");
  const itensLista: ItemLista[] = [
    {
      id: ID_PROG, nome: `Amanhã · ${dm(amanha)}`, status: "programada",
      periodo: automacao ? `${dm(amanha)} · montada pelo robô às 18:07` : `${dm(amanha)} · robô desligado: programe à mão`,
      itensTxt: `${Math.min(nVagas, 50)}/50 vagas`, match: filtroF ? linhasProg.filter(filtroF).length : 0,
      fimTxt: criadaAmanha ? (criadaAmanha.status === "erro" ? "falhou" : "já criada") : null,
    },
    ...(filtro ? [] : hist.filter((c) => c.dia !== amanha).map((c) => ({
      id: String(c.id), nome: c.dia === hoje ? `Hoje · ${dm(c.dia)}` : dm(c.dia), status: statusCriada(c),
      periodo: `${dm(c.dia)} · ${c.status === "ok" ? "completa" : c.status === "em_dia" ? "em dia" : c.status}`,
      itensTxt: `${c.itens_ok} ok${c.itens_falha ? ` · ${c.itens_falha} recusados` : ""}`,
      fimTxt: c.status === "erro" ? "falhou" : null,
    }))),
  ];

  // ---------------------------------------------------------------- rascunhos e prévia
  const ehProg = selId === ID_PROG;
  const precoDe = (lp: LinhaPromo) => { const t = drafts.get(lp.key); const v = t != null ? parseNum(t) : null; return v ?? lp.promo; };
  const alterados = ehProg ? linhasProg.filter((lp) => precoDe(lp) !== lp.promo) : [];
  const setDraft = (key: string, txt: string | null) => setDrafts((m) => { const n = new Map(m); if (txt == null) n.delete(key); else n.set(key, txt); return n; });
  function revisar() {
    const itens = alterados.map((lp) => ({ p: progDe.get(lp.key)!, lp, de: lp.promo, para: precoDe(lp) })).filter((x) => x.p);
    if (itens.length) setPrevia({ fase: "revisar", itens });
  }
  const avisosDe = (it: { p: ProgItem; lp: LinhaPromo; para: number }): ItemPrevia["avisos"] => {
    const a: ItemPrevia["avisos"] = [];
    const t = tetoDe(it.p); const m = it.lp.conta(it.para);
    if (it.para >= it.lp.cheio) a.push({ t: "precisa ser menor que o preço atual: o robô pula", tom: "r" });
    else if (it.para < it.lp.cheio * 0.5) a.push({ t: "abaixo de 50% do preço atual: o robô pula (proteção)", tom: "r" });
    if (t && it.para > t.teto + 0.001) a.push({ t: `acima do teto (${BRL(t.teto)}): a Shopee recusa`, tom: "r" });
    if (it.lp.semCusto) a.push({ t: "sem custo cadastrado: MC não calculada", tom: "am" });
    else if (m) { if (m.pct < 0) a.push({ t: "MC negativa no preço novo", tom: "r" }); else if (m.pct < 0.1) a.push({ t: "MC abaixo de 10%", tom: "am" }); }
    if (!it.p.ativo) a.push({ t: "item pausado: só entra se reativar", tom: "at" });
    return a;
  };
  async function aplicar() {
    if (!previa) return;
    const pv = previa; setPrevia({ ...pv, fase: "aplicando" });
    const out = pv.itens.map((x) => ({ ...x }));
    for (const it of out) {
      const { error } = await supabaseExternal.from("flashsale_programacao").update({ preco_promo: it.para, atualizado_em: new Date().toISOString() }).eq("id", it.p.id);
      it.res = error ? { tipo: "recusado", motivo: error.message } : { tipo: "aplicado", motivo: "salvo na programação" };
    }
    setRes((m) => { const n = new Map(m); for (const it of out) if (it.res) n.set(it.lp.key, it.res); return n; });
    setDrafts((m) => { const n = new Map(m); for (const it of out) if (it.res?.tipo === "aplicado") n.delete(it.lp.key); return n; });
    setSel((s) => { const n = new Set(s); for (const it of out) n.delete(it.lp.key); return n; });
    setPrevia({ fase: "resultado", itens: out });
    void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });
  }
  async function remover(lps: LinhaPromo[]) {
    const ps = lps.map((lp) => progDe.get(lp.key)).filter((p): p is ProgItem => !!p);
    if (!ps.length || !window.confirm(`Tirar ${ps.length} item(ns) da programação diária?\nNão tira da relâmpago que já foi criada na Shopee.`)) return;
    const { error } = await supabaseExternal.from("flashsale_programacao").delete().in("id", ps.map((p) => p.id));
    if (error) toast.error("Falha ao remover", { description: error.message });
    else toast.success(`${ps.length} item(ns) fora da programação`);
    setSel(new Set());
    void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });
  }
  async function alternarAtivo(lps: LinhaPromo[], ativo: boolean) {
    const ps = lps.map((lp) => progDe.get(lp.key)).filter((p): p is ProgItem => !!p);
    const { error } = await supabaseExternal.from("flashsale_programacao").update({ ativo, atualizado_em: new Date().toISOString() }).in("id", ps.map((p) => p.id));
    if (error) toast.error("Falha", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });
  }

  // ---------------------------------------------------------------- programar amanhã (escrita na Shopee)
  async function abrirProgramar() {
    setProgramando(true);
    try { const r = await chamarFlashsale(`modulo=programar&shop_id=${shopId}`); setDlgProg({ dia: r.dia, resultados: r.resultados ?? [] }); }
    catch (e) { toast.error("Falha ao montar a prévia", { description: (e as Error).message }); }
    finally { setProgramando(false); }
  }
  async function confirmarProgramar() {
    setConfirmando(true);
    try {
      const r = await chamarFlashsale(`modulo=programar&shop_id=${shopId}&confirmar=1`);
      const x = (r.resultados ?? [])[0] ?? {};
      const motivos = ((x.problemas ?? []) as { sku: string; motivo: string }[]).slice(0, 4).map((y) => `${y.sku}: ${y.motivo}`).join("\n") || undefined;
      if (x.status === "ok") toast.success(`+${x.itens_ok} item(ns) na relâmpago de ${r.dia}`);
      else if (x.status === "em_dia") toast.info(`Tudo em dia: os itens programados já estão na relâmpago de ${r.dia}.`);
      else if (x.status === "parcial") toast.warning(`${x.itens_ok} ok e ${x.itens_falha} recusa(s)`, { description: motivos, duration: 12000 });
      else toast.error(`Falhou: ${x.erro ?? x.message ?? x.status}`, { description: motivos, duration: 12000 });
      setDlgProg(null);
      void qc.invalidateQueries({ queryKey: ["flashsale", "hist", shopId] });
    } catch (e) { toast.error("Falha ao programar", { description: (e as Error).message }); }
    finally { setConfirmando(false); }
  }
  async function mudarRobo(modo: "ligado" | "desligado") {
    const v = modo === "ligado";
    if (v === automacao) return;
    if (!window.confirm(v ? "Ligar o robô? Às 18:07 ele monta/completa a relâmpago de amanhã com os itens ativos." : "Desligar o robô? A relâmpago de amanhã só sai pelo botão “Programar amanhã agora”.")) return;
    const { error } = await supabaseExternal.from("flashsale_config").upsert({ shop_id: shopId, automacao_ativa: v, atualizado_em: new Date().toISOString() });
    if (error) toast.error("Falha ao salvar", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["flashsale", "cfg"] });
  }
  async function sincronizar() {
    setSincronizando(true);
    await Promise.all([progQ.refetch(), histQ.refetch(), cfgQ.refetch(), criadaSel ? saleQ.refetch() : null]);
    setSincronizando(false);
  }
  const [agora, setAgora] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setAgora(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const minAtras = progQ.dataUpdatedAt ? Math.max(0, Math.round((agora - progQ.dataUpdatedAt) / 60000)) : null;
  const proxima = (() => {
    const h = Number(new Date().toLocaleString("en-US", { timeZone: TZ, hour: "2-digit", hour12: false }));
    const m = Number(new Date().toLocaleString("en-US", { timeZone: TZ, minute: "2-digit" }));
    return h * 60 + m < 18 * 60 + 7 ? "hoje 18:07" : "amanhã 18:07";
  })();

  // ---------------------------------------------------------------- resumo e detalhe
  let ws = 0, ms = 0; let v30 = 0;
  for (const lp of linhasProg) { if (lp.estado === "pausado") continue; const m = lp.conta(lp.promo); const v = lp.v30 ?? 0; v30 += v; if (m && v > 0) { ws += lp.promo * v; ms += m.v * v; } }
  const resumo = progQ.isLoading ? [] : [
    { v: String(ativos.length), k: ativos.length === 1 ? "item ativo" : "itens ativos" },
    { v: `${Math.min(nVagas, 50)}/50`, k: "vagas de amanhã" },
    { v: ws ? PCT(ms / ws) : "—", k: "MC média ponderada por vendas" },
    { v: INT(v30), k: "vendas em 30 dias" },
  ];
  const linhasTabela = ehProg ? linhasProg : linhasSale;
  const selTabela = linhasTabela.filter((lp) => sel.has(lp.key));
  const dres: Array<{ t: string; cor: string }> = [{ t: `${linhasTabela.length} ${linhasTabela.length === 1 ? "variação" : "variações"}`, cor: "var(--pm-t2)" }];
  if (ehProg) {
    const nNeg = contar("neg"), nTeto = contar("teto");
    if (nNeg) dres.push({ t: `${nNeg} com MC negativa`, cor: "var(--pm-r)" });
    if (nTeto) dres.push({ t: `${nTeto} acima do teto`, cor: "var(--pm-r)" });
    if (alterados.length) dres.push({ t: `${alterados.length} alterado(s), ainda não salvo(s)`, cor: "var(--pm-am)" });
  } else if (criadaSel) {
    dres.push({ t: `${criadaSel.itens_ok} entraram · ${criadaSel.itens_falha} recusados nesta rodada`, cor: "var(--pm-t2)" });
  }
  const st: StatusPromo = ehProg ? "programada" : criadaSel ? statusCriada(criadaSel) : "encerrada";
  const usadas = Math.min(nVagas, 50);
  const cabecalho: ReactNode = (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>{ehProg ? `Amanhã · ${dm(amanha)}` : criadaSel ? (criadaSel.dia === hoje ? `Hoje · ${dm(criadaSel.dia)}` : dm(criadaSel.dia)) : ""}</h3>
        <Chip bg={PST[st][1]} cor={PST[st][2]} size={10.5}>{PST[st][0]}</Chip>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Relâmpago · <span className="pm-mono">{ehProg ? (automacao ? "montada pelo robô às 18:07" : "robô desligado") : criadaSel?.flash_sale_id ? `#${criadaSel.flash_sale_id}` : "sem relâmpago criada"}</span></span>
        <div style={{ flex: 1 }} />
        {ehProg && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <Btn onClick={() => void abrirProgramar()} disabled={programando || ativos.length === 0} title="Prévia do que o robô faria agora; confirmando, completa a relâmpago de amanhã na Shopee">
              {programando ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : <CalendarClock style={{ width: 14, height: 14 }} />}Programar amanhã agora
            </Btn>
            <Btn onClick={() => setDlgAdd(true)}><Plus style={{ width: 14, height: 14 }} />Adicionar produto</Btn>
            {alterados.length > 0 && (
              <button type="button" onClick={() => setDrafts(new Map())} className="hover:bg-[var(--pm-s2)]"
                style={{ height: 32, padding: "0 10px", borderRadius: 8, border: 0, background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)" }}>Descartar</button>
            )}
            <Btn primario disabled={alterados.length === 0} onClick={revisar}>Revisar e salvar ({alterados.length})</Btn>
          </div>
        )}
        {!ehProg && st === "encerrada" && <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Encerrada: só consulta</span>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 12 }}>
        {dres.map((d) => <span key={d.t} style={{ color: d.cor }}>{d.t}</span>)}
      </div>
      {ehProg && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 10, background: "var(--pm-s2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, fontSize: 12 }}>
            <span><b className="pm-mono" style={{ fontSize: 13 }}>{usadas}</b> de 50 vagas usadas · <b className="pm-mono" style={{ fontSize: 13, color: nAnuncios > 20 ? "var(--pm-am)" : undefined }}>{Math.min(nAnuncios, 20)}</b> de 20 anúncios{nAnuncios > 20 && <b style={{ color: "var(--pm-am)", fontWeight: 600 }}> · {nAnuncios - 20} anúncio(s) ficam de fora</b>}</span>
            <span style={{ color: "var(--pm-t3)" }}>{50 - usadas} livres{nVagas > 50 && <> · <b style={{ color: "var(--pm-am)", fontWeight: 600 }}>{nVagas - 50} ficam de fora por falta de vaga (entram os que mais vendem)</b></>}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(50,1fr)", gap: 2, height: 10 }}>
            {Array.from({ length: 50 }, (_, i) => <i key={i} style={{ borderRadius: 2, background: i < usadas ? "var(--pm-a)" : "var(--pm-b)" }} />)}
          </div>
        </div>
      )}
      <AvisoCustoTiny estado={custoTiny} />
    </>
  );

  const previaItens: ItemPrevia[] = (previa?.itens ?? []).map((it) => ({
    key: it.lp.key, nome: it.lp.nome + (it.lp.sub ? ` · ${it.lp.sub}` : ""), sku: `${it.lp.sku ?? "—"} · ${it.lp.code}`, foto: it.lp.foto,
    op: "novo preço relâmpago", de: it.de, para: it.para, mcDe: it.lp.conta(it.de), mcPara: it.lp.conta(it.para), semCusto: it.lp.semCusto,
    avisos: avisosDe(it), res: it.res,
  }));

  return (
    <>
      <CabecalhoMkt {...cab}
        sync={{ txt: sincronizando ? "sincronizando…" : minAtras == null ? "—" : minAtras === 0 ? "agora" : `há ${minAtras} min`, tom: progQ.isError ? "r" : "ok", girando: sincronizando, onClick: () => void sincronizar() }}
        resumo={resumo} />
      <FaixaDecisao sub={`hoje, ${dm(hoje)} · Shopee · Relâmpago · ${cab.lojas.find((l) => l.id === cab.loja)?.nome ?? ""} · clique num contador para filtrar`}
        cards={cards} carregando={progQ.isLoading} filtroNome={filtro ? FILTRO_NOME[filtro] : null} onLimpar={() => setFiltro(null)} />
      <div className="grid grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)]" style={{ gap: 16, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <ListaPromos titulo="Programações" itens={itensLista} sel={selId} carregando={histQ.isLoading}
            onSel={(id) => { setSelId(id); setBusca(""); setFaixa("todas"); setSel(new Set()); }} />
          <CartaoRobo nome="Relâmpago diária" desc="Monta a relâmpago de amanhã" modos={["desligado", "ligado"]} onModo={(m) => void mudarRobo(m as "ligado" | "desligado")}
            modo={automacao ? "ligado" : "desligado"}
            ultima={ultima ? new Date(ultima.criado_em).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
            proxima={proxima}
            params={[{ k: "Itens ativos", v: String(ativos.length) }]}
            fez={ultima ? `Na última rodada: programou ${ultima.itens_ok} variação(ões) para ${dm(ultima.dia)}${ultima.itens_falha ? `; ${ultima.itens_falha} recusada(s) ou de fora` : ""}${ultima.status === "erro" ? ". A relâmpago desse dia ficou vazia." : "."}` : "Ainda não rodou nesta loja."} />
        </div>
        <TabelaPromo cabecalho={cabecalho} linhas={linhasTabela} editavel={ehProg}
          drafts={drafts} setDraft={setDraft} sel={sel} setSel={setSel} busca={busca} setBusca={setBusca} faixa={faixa} setFaixa={setFaixa}
          precoLabel="Atual → relâmpago" extraLabel={ehProg ? "Teto relâmpago" : "Estoque"}
          extra={(lp, preco) => {
            if (!ehProg) return <span className="pm-mono" style={{ fontSize: 12, color: "var(--pm-t2)" }}>{lp.estoque != null ? INT(lp.estoque) : "—"}</span>;
            const p = progDe.get(lp.key); const t = p ? tetoDe(p) : null;
            if (!t) return <span className="pm-mono" style={{ fontSize: 12, color: "var(--pm-t3)" }}>—</span>;
            const acima = preco > t.teto + 0.001;
            return (
              <>
                <span className="pm-mono" title={t.motivo} style={{ fontSize: 12, color: acima ? "var(--pm-r)" : "var(--pm-t2)" }}>{BRL(t.teto)}</span>
                {acima && <span style={{ fontSize: 10.5, color: "var(--pm-r)" }}>acima do teto</span>}
              </>
            );
          }}
          acoes={ehProg ? (lp) => {
            const p = progDe.get(lp.key); if (!p) return null;
            return (
              <>
                <button type="button" title={p.ativo ? "Pausar (sai da próxima relâmpago)" : "Reativar"} onClick={() => void alternarAtivo([lp], !p.ativo)} className="hover:bg-[var(--pm-s2)]"
                  style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: p.ativo ? "var(--pm-g)" : "var(--pm-t3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                  <Power style={{ width: 14, height: 14 }} />
                </button>
                <button type="button" title="Tirar da programação" onClick={() => void remover([lp])} className="hover:bg-[var(--pm-rs)] hover:text-[var(--pm-r)]"
                  style={{ width: 28, height: 28, borderRadius: 8, border: 0, background: "transparent", color: "var(--pm-t3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                  <Trash2 style={{ width: 14, height: 14 }} />
                </button>
              </>
            );
          } : undefined}
          filtroLinha={ehProg ? filtroF : null}
          carregando={progQ.isLoading || (!ehProg && saleQ.isLoading)}
          carregandoTxt={ehProg ? "Carregando a programação…" : "Lendo a relâmpago na Shopee…"}
          ordem={ehProg && selTabela.length > 0 ? (
            <div style={{ display: "flex", gap: 6 }}>
              <Btn onClick={() => void alternarAtivo(selTabela, true)}>Reativar ({selTabela.length})</Btn>
              <Btn onClick={() => void alternarAtivo(selTabela, false)}>Pausar ({selTabela.length})</Btn>
            </div>
          ) : undefined}
          lote={{
            onAlvo: (a) => setDrafts((m) => { const n = new Map(m); for (const lp of selTabela) { const pz = lp.precoPara?.(a); if (pz != null && pz < lp.cheio) n.set(lp.key, IN(pz)); } return n; }),
            onDesc: (x) => setDrafts((m) => { const n = new Map(m); for (const lp of selTabela) n.set(lp.key, IN(Math.round(lp.cheio * (1 - x) * 100) / 100)); return n; }),
            onTirar: () => void remover(selTabela),
          }}
          rodape={ehProg
            ? "Teto = maior preço que a Shopee deve aceitar: 1% abaixo do preço atual e no máximo o menor preço vendido em 7 dias. A Shopee aceita até 20 anúncios e 50 variações por relâmpago (entram os que mais vendem). Salvar muda só a programação; a Shopee recebe às 18:07 (robô ligado) ou pelo “Programar amanhã agora”. MC = preço − comissão − imposto − CMV; passe o mouse na MC para ver a conta."
            : "Itens desta relâmpago como estão na Shopee (só leitura). Variação fora = a Shopee lista o anúncio inteiro, mas só as marcadas entram na promoção."} />
      </div>

      {previa && (
        <PreviaAplicar fase={previa.fase} mktNa="na programação" promoNome={`Relâmpago de amanhã · ${dm(amanha)}`} itens={previaItens}
          descRevisar="muda só a programação; a Shopee recebe na próxima rodada (18:07) ou pelo “Programar amanhã agora”."
          botao={`Salvar na programação (${previa.itens.length})`} onAplicar={() => void aplicar()} onFechar={() => setPrevia(null)} />
      )}
      <AdicionarProduto aberto={dlgAdd} onFechar={() => setDlgAdd(false)} shopId={shopId}
        jaProgramados={new Set(prog.map((p) => `${p.item_id}:${p.model_id}`))} criadoPor={perfil?.nome ?? null}
        onAdicionou={() => void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] })} />
      <Dialog open={dlgProg !== null} onOpenChange={(v) => { if (!v) setDlgProg(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Programar relâmpago de {dlgProg?.dia ? dm(dlgProg.dia) : ""}</DialogTitle>
            <DialogDescription>Prévia do robô agora. Confirmando, o que falta entra na relâmpago de amanhã <b>na Shopee</b> e ela é ativada.</DialogDescription>
          </DialogHeader>
          {dlgProg?.resultados.map((r: any, i: number) => (
            <div key={i} className="text-[13px] space-y-1.5">
              {r.status === "dry" ? (
                <p>
                  {r.itens_ja_na_promo > 0 && <><b>{r.itens_ja_na_promo}</b> já estão na relâmpago de amanhã. </>}
                  Faltam <b>{r.faltam}</b>{r.sales_existentes > 0 ? " — entram na relâmpago existente" : " — a relâmpago do dia será criada e ativada"}.
                  {r.nao_cabem > 0 && <span style={{ color: "var(--pm-am)" }}> {r.nao_cabem} variações não cabem (50 por relâmpago).</span>}
                  {(r.pulados ?? []).length > 0 && <span style={{ color: "var(--pm-am)" }}> {r.pulados.length} pulado(s) pela proteção de preço.</span>}
                </p>
              ) : r.status === "em_dia" ? <p>Tudo em dia: os itens programados já estão na relâmpago de amanhã.</p>
                : r.status === "sem_itens_programados" ? <p>Nenhum item ativo na programação desta loja.</p>
                  : <p style={{ color: "var(--pm-r)" }}>Não dá para programar: {r.erro ?? r.status}</p>}
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setDlgProg(null)}>Cancelar</Button>
            <Button size="sm" className="gap-1.5" disabled={confirmando || !(dlgProg?.resultados ?? []).some((r: any) => r.status === "dry")} onClick={() => void confirmarProgramar()}>
              {confirmando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}Completar relâmpago na Shopee
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Campo numérico pequeno que grava ao sair (estoque/limite da programação). */
function CampoMini({ valor, onSalvar }: { valor: number; onSalvar: (v: number) => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <input value={txt ?? String(valor)} inputMode="numeric" className="pm-mono"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => { if (txt == null) return; const v = Number(txt.replace(",", ".")); setTxt(null); if (Number.isFinite(v) && v !== valor) onSalvar(v); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{ width: 42, height: 22, borderRadius: 6, border: "1px solid var(--pm-b)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 11, textAlign: "right", padding: "0 4px", outline: "none" }} />
  );
}
