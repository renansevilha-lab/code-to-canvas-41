import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp, Info, Loader2, Package as PackageIcon, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber, formatPercent } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { parseNfe, similaridade, soDigitos, unidadesDe, valorLiquido, type ItemXml, type NfXml } from "@/lib/nfe";
import { buscarDepara, normDesc, salvarDepara } from "@/lib/comprasDepara";
import { buscarNfTiny, carregarNfTiny, normNf, type NfEncontrada } from "@/lib/nfTiny";

// ============================================================================
// Nova entrada de recebimento a partir da NF-e (30/set/2026) — para mercadoria
// que chega com nota mas SEM ordem de compra no Tiny. O operador sobe o XML e
// o app cria uma "ordem" só do app, já na coluna Conferência:
//   - tiny_id NEGATIVO (-epoch em segundos): o compras-sync só mexe nos ids
//     que vêm do Tiny, então a ordem do app nunca é sobrescrita nem apagada;
//   - itens da NF viram compra_ordem_itens com o NOSSO SKU, casado por EAN
//     (histórico de compras) → código do fornecedor = SKU → descrição (itens
//     que o mesmo fornecedor já vendeu). Tudo editável antes de criar.
// Não cria nada no Tiny e não lança estoque.
// ============================================================================

interface Linha {
  xml: ItemXml;
  sku: string;
  metodo: "ean" | "codigo" | "descricao" | "manual" | "depara" | null;
  fator: number; // unidades do SKU por 1 unidade da NF (fardo com 5 = 5)
  unidades: number;
  nota: string | null;
  incluir: boolean;
}
interface Fornecedor {
  fornecedor_id: number | null;
  fornecedor_nome: string | null;
  fornecedor_fantasia: string | null;
}
interface ItemHist { sku: string | null; gtin: string | null; descricao: string | null }
interface Produto { sku: string; nome: string | null; id_tiny: number | null; foto_capa: string | null; custo: number | null; tipo: string | null }

// Histórico de custo de um SKU, para comparar com o que a NF traz.
interface CompraAnterior { numero: string; data: string | null; fornecedor: string | null; preco: number; qtd: number }
interface HistCusto {
  manual: { custo: number; desde: string } | null; // cmv_manual vigente hoje
  formacao: { custo: number; anterior: number | null; em: string | null; ordem: string | null } | null;
  compras: CompraAnterior[]; // últimas compras (preço por unidade), fora esta NF
}
interface CustoLinha { liq: number; porFardo: number; un: number; unCom: number; extra: number }
interface ExtrasNf { total: number; base: number; partes: { frete: number; ipi: number; st: number; outras: number; desconto: number } }

const R4 = (v: number) => Math.round(v * 10000) / 10000;
const brl4 = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dataBr = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

function Delta({ novo, base, compacto }: { novo: number; base: number | null | undefined; compacto?: boolean }) {
  if (base == null || !(base > 0) || !(novo > 0)) return null;
  const d = novo - base;
  const pct = (d / base) * 100;
  const igual = Math.abs(pct) < 0.5;
  const cor = igual ? "text-muted-foreground" : d > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400";
  return (
    <span className={cn("tabular-nums font-semibold", cor)}>
      {igual ? "igual" : `${d > 0 ? "+" : "−"}${formatPercent(Math.abs(pct))}`}
      {!compacto && !igual && <span className="font-normal"> ({d > 0 ? "+" : "−"}{brl4(Math.abs(d))})</span>}
    </span>
  );
}

function Foto({ url }: { url?: string | null }) {
  const [erro, setErro] = useState(false);
  if (!url || erro) {
    return (
      <div className="h-14 w-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <PackageIcon className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }
  return <img src={url} alt="" loading="lazy" onError={() => setErro(true)} className="h-14 w-14 rounded-lg object-cover bg-muted shrink-0 border" />;
}

// Palavras que não identificam fornecedor ("X COMERCIO LTDA" × "Y COMERCIO LTDA").
const GENERICAS = new Set([
  "ltda", "limitada", "comercio", "industria", "produtos", "para", "eireli", "epp",
  "distribuidora", "importacao", "exportacao", "animais", "pet", "pets", "servicos", "cia",
]);
function simFornecedor(a: string | null | undefined, b: string | null | undefined): number {
  const limpa = (s: string | null | undefined) =>
    String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERICAS.has(w)).join(" ");
  return similaridade(limpa(a), limpa(b));
}
const variantesEan = (e: string) => [...new Set([e, e.padStart(13, "0"), e.padStart(14, "0")])];

export function NovaEntradaNf({
  open, onOpenChange, onCriada,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCriada: (tinyId: number) => void;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [nf, setNf] = useState<NfXml | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [fornecedor, setFornecedor] = useState<Fornecedor | null>(null);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [lendo, setLendo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [jaRecebido, setJaRecebido] = useState(false);
  const [termo, setTermo] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [encontradas, setEncontradas] = useState<NfEncontrada[] | null>(null);
  const [nfTinyId, setNfTinyId] = useState<number | null>(null);
  const [lembrar, setLembrar] = useState(true);
  const [salvando, setSalvando] = useState(false);

  function limpar() {
    setNf(null); setLinhas([]); setFornecedor(null); setAvisos([]); setErro(null); setJaRecebido(false);
    setEncontradas(null); setNfTinyId(null);
  }

  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    setErro(null); setLendo(true);
    let nota: NfXml;
    try { nota = parseNfe(await f.text()); }
    catch (e) { limpar(); setErro((e as Error).message); setLendo(false); return; }
    setNfTinyId(null);
    await processar(nota);
  }

  // NF já no espelho do Tiny, achada pelo número ou pela chave (sem precisar do XML)
  async function buscar() {
    setErro(null); setEncontradas(null);
    if (!termo.trim()) return;
    setBuscando(true);
    try {
      const r = await buscarNfTiny(termo);
      setEncontradas(r);
      if (r.length === 1) await usarNfTiny(r[0]);
    } catch (e) { setErro((e as Error).message); }
    finally { setBuscando(false); }
  }
  async function usarNfTiny(n: NfEncontrada) {
    setErro(null); setLendo(true);
    try {
      const { nf: nota } = await carregarNfTiny(n.tiny_id);
      setNfTinyId(n.tiny_id);
      await processar(nota);
    } catch (e) { setErro((e as Error).message); setLendo(false); }
  }

  async function processar(nota: NfXml) {
    setLendo(true);
    try {
      const av: string[] = [];

      // 1) Fornecedor: OC mais parecida pelo nome (dá o fornecedor_id do Tiny,
      //    que a conciliação automática de NFs usa) + os itens que ele já vendeu.
      const { data: ocs } = await supabaseExternal.from("compras_ordens")
        .select("tiny_id, fornecedor_id, fornecedor_nome, fornecedor_fantasia")
        .gt("tiny_id", 0).order("data_pedido", { ascending: false }).limit(1000);
      let forn: Fornecedor | null = null;
      let melhor = 0;
      for (const o of (ocs ?? []) as (Fornecedor & { tiny_id: number })[]) {
        const s = Math.max(simFornecedor(nota.razaoSocial, o.fornecedor_nome), simFornecedor(nota.emitente, o.fornecedor_fantasia));
        if (s > melhor) { melhor = s; forn = o; }
      }
      if (melhor < 0.6) forn = null;
      const idsForn = forn
        ? ((ocs ?? []) as (Fornecedor & { tiny_id: number })[])
          .filter((o) => (forn!.fornecedor_id != null ? o.fornecedor_id === forn!.fornecedor_id : o.fornecedor_nome === forn!.fornecedor_nome))
          .map((o) => o.tiny_id).slice(0, 60)
        : [];

      // 2) Histórico de itens: EAN → SKU (qualquer fornecedor) e itens deste fornecedor.
      const eans = [...new Set(nota.itens.flatMap((x) => [x.ean, x.eanTrib]).filter((e): e is string => !!e))];
      const hist: ItemHist[] = [];
      if (eans.length) {
        const { data } = await supabaseExternal.from("compra_ordem_itens")
          .select("sku, gtin, descricao").in("gtin", eans.flatMap(variantesEan)).limit(2000);
        hist.push(...((data ?? []) as ItemHist[]));
      }
      const doForn: ItemHist[] = [];
      if (idsForn.length) {
        const { data } = await supabaseExternal.from("compra_ordem_itens")
          .select("sku, gtin, descricao").in("ordem_tiny_id", idsForn).limit(3000);
        doForn.push(...((data ?? []) as ItemHist[]));
      }
      const skuPorEan = new Map<string, string>();
      for (const h of [...hist, ...doForn]) {
        const g = soDigitos(h.gtin);
        if (g && h.sku) skuPorEan.set(g, h.sku);
      }

      // 3) Código do fornecedor que já é o nosso SKU.
      const cods = [...new Set(nota.itens.map((x) => x.cProd.trim()).filter(Boolean))];
      const skusCod = new Set<string>();
      if (cods.length) {
        const { data } = await supabaseExternal.from("produtos").select("sku").in("sku", cods.slice(0, 300));
        for (const p of (data ?? []) as { sku: string }[]) skusCod.add(p.sku);
      }

      // 0) De-para salvo deste fornecedor (descrição da NF → nosso SKU + fator) ganha de tudo.
      const dp = await buscarDepara(forn?.fornecedor_id, nota.cnpj, nota.itens.map((x) => x.xProd));

      const casadas = nota.itens.map((x): Omit<Linha, "unidades" | "nota" | "fator"> & { viaTrib: boolean; fatorDp?: number } => {
        const d = dp.get(normDesc(x.xProd));
        if (d) return { xml: x, sku: d.sku, metodo: "depara", incluir: true, viaTrib: false, fatorDp: d.fator };
        if (x.ean && skuPorEan.has(x.ean)) return { xml: x, sku: skuPorEan.get(x.ean)!, metodo: "ean", incluir: true, viaTrib: false };
        if (x.eanTrib && skuPorEan.has(x.eanTrib)) return { xml: x, sku: skuPorEan.get(x.eanTrib)!, metodo: "ean", incluir: true, viaTrib: true };
        if (skusCod.has(x.cProd.trim())) return { xml: x, sku: x.cProd.trim(), metodo: "codigo", incluir: true, viaTrib: false };
        let best: ItemHist | null = null;
        let sc = 0;
        for (const h of doForn) {
          if (!h.sku) continue;
          const s = similaridade(x.xProd, h.descricao);
          if (s > sc) { sc = s; best = h; }
        }
        if (best && sc >= 0.6) return { xml: x, sku: best.sku!, metodo: "descricao", incluir: true, viaTrib: false };
        return { xml: x, sku: "", metodo: null, incluir: true, viaTrib: false };
      });

      // 4) Encaixotamento lembrado (NF em caixa/fardo → unidades).
      const skusCasados = [...new Set(casadas.map((c) => c.sku).filter(Boolean))];
      const emb = new Map<string, number | null>();
      if (skusCasados.length) {
        const { data } = await supabaseExternal.from("produto_embalagem").select("sku, emb_unidades").in("sku", skusCasados);
        for (const r of (data ?? []) as { sku: string; emb_unidades: number | null }[]) emb.set(r.sku, r.emb_unidades);
      }

      // 5) Já existe? (mesma NF criada antes pelo app, ou já casada com uma OC do Tiny)
      if (nota.chave) {
        const { data: dup } = await supabaseExternal.from("compras_ordens")
          .select("numero, kanban_status").ilike("observacoes", `%${nota.chave}%`).neq("kanban_status", "excluida").limit(1);
        if (dup && dup.length) av.push(`Esta NF já gerou a entrada #${(dup[0] as { numero: string }).numero} no app.`);
      }
      const { data: vinc } = await supabaseExternal.from("compras_nf_entrada")
        .select("ordem_tiny_id, fornecedor_nome").in("numero", [...new Set([nota.numero, nota.numeroBruto])])
        .not("ordem_tiny_id", "is", null).limit(10);
      for (const v of (vinc ?? []) as { ordem_tiny_id: number; fornecedor_nome: string | null }[]) {
        if (simFornecedor(v.fornecedor_nome, nota.razaoSocial) >= 0.6) {
          const { data: oc } = await supabaseExternal.from("compras_ordens").select("numero").eq("tiny_id", v.ordem_tiny_id).maybeSingle();
          av.push(`Esta NF já está casada com a OC #${(oc as { numero: string } | null)?.numero ?? v.ordem_tiny_id} do Tiny — se for essa compra, use "Entrada pelo XML da NF" dentro dela.`);
          break;
        }
      }

      setNf(nota);
      setFornecedor(forn);
      setAvisos(av);
      setLinhas(casadas.map((c): Linha => {
        if (c.fatorDp) {
          return { xml: c.xml, sku: c.sku, metodo: c.metodo, incluir: c.incluir, fator: c.fatorDp, unidades: c.xml.qCom * c.fatorDp,
            nota: `${c.xml.qCom} ${c.xml.uCom} × ${c.fatorDp} (de-para salvo)` };
        }
        const u = unidadesDe(c.xml, c.viaTrib, c.sku ? emb.get(c.sku) : null);
        return { xml: c.xml, sku: c.sku, metodo: c.metodo, incluir: c.incluir, fator: c.xml.qCom > 0 ? u.q / c.xml.qCom : 1, unidades: u.q, nota: u.nota };
      }));
    } catch (e) {
      limpar();
      setErro((e as Error).message);
    } finally {
      setLendo(false);
    }
  }

  // Confere os SKUs digitados/casados contra o cadastro (nome + id do Tiny).
  const skusLinhas = useMemo(
    () => [...new Set(linhas.map((l) => l.sku.trim()).filter(Boolean))].sort(),
    [linhas],
  );
  const prodQ = useQuery({
    queryKey: ["compras", "nova-nf-produtos", skusLinhas],
    enabled: skusLinhas.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, Produto>> => {
      const { data, error } = await supabaseExternal.from("produtos").select("sku, nome, id_tiny, foto_capa, custo, tipo").in("sku", skusLinhas);
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as Produto[]).map((p) => [p.sku, p]));
    },
  });
  const prods = prodQ.data ?? {};

  // Histórico de custo dos SKUs da nota: custo manual vigente, última formação de custo e últimas compras.
  const histQ = useQuery({
    queryKey: ["compras", "nova-nf-hist-custo", skusLinhas, nf?.numero ?? ""],
    enabled: skusLinhas.length > 0 && !!nf,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, HistCusto>> => {
      const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      const [man, form, its] = await Promise.all([
        supabaseExternal.from("cmv_manual").select("sku, custo, vigente_desde").in("sku", skusLinhas)
          .lte("vigente_desde", hoje).order("vigente_desde", { ascending: false }),
        supabaseExternal.from("compras_custo_itens").select("sku, ordem_tiny_id, custo_final, custo_anterior, aplicado_em")
          .in("sku", skusLinhas).not("custo_final", "is", null).order("aplicado_em", { ascending: false, nullsFirst: false }).limit(200),
        supabaseExternal.from("compra_ordem_itens").select("sku, ordem_tiny_id, preco, quantidade")
          .in("sku", skusLinhas).gt("preco", 0).limit(2000),
      ]);
      const itens = (its.data ?? []) as { sku: string; ordem_tiny_id: number; preco: number; quantidade: number }[];
      const formacoes = (form.data ?? []) as { sku: string; ordem_tiny_id: number; custo_final: number; custo_anterior: number | null; aplicado_em: string | null }[];
      type Ordem = { tiny_id: number; numero: string; data_pedido: string | null; fornecedor_nome: string | null; fornecedor_fantasia: string | null; kanban_status: string | null };
      const ids = [...new Set([...itens.map((i) => i.ordem_tiny_id), ...formacoes.map((x) => x.ordem_tiny_id)])];
      const ordens = new Map<number, Ordem>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabaseExternal.from("compras_ordens")
          .select("tiny_id, numero, data_pedido, fornecedor_nome, fornecedor_fantasia, kanban_status").in("tiny_id", ids.slice(i, i + 300));
        for (const o of (data ?? []) as Ordem[]) ordens.set(o.tiny_id, o);
      }
      const estaNf = nf ? new Set([`NF-${nf.numero}`, `NF-${nf.numeroBruto}`]) : new Set<string>();
      const out: Record<string, HistCusto> = {};
      for (const sku of skusLinhas) {
        const m = ((man.data ?? []) as { sku: string; custo: number; vigente_desde: string }[]).find((x) => x.sku === sku);
        const fo = formacoes.find((x) => x.sku === sku);
        const compras = itens.filter((i) => i.sku === sku)
          .map((i) => ({ i, o: ordens.get(i.ordem_tiny_id) }))
          .filter(({ o }) => o && o.kanban_status !== "excluida" && !estaNf.has(o.numero))
          .map(({ i, o }) => ({ numero: o!.numero, data: o!.data_pedido, fornecedor: o!.fornecedor_fantasia || o!.fornecedor_nome, preco: Number(i.preco), qtd: Number(i.quantidade) }))
          .sort((a, b) => String(b.data ?? "").localeCompare(String(a.data ?? "")))
          .slice(0, 5);
        out[sku] = {
          manual: m ? { custo: Number(m.custo), desde: m.vigente_desde } : null,
          formacao: fo ? { custo: Number(fo.custo_final), anterior: fo.custo_anterior == null ? null : Number(fo.custo_anterior), em: fo.aplicado_em, ordem: ordens.get(fo.ordem_tiny_id)?.numero ?? null } : null,
          compras,
        };
      }
      return out;
    },
  });
  const hist = histQ.data ?? {};

  // Despesas da nota fora das linhas (frete, IPI, ST, outras − desconto do cabeçalho), rateadas
  // pelo valor líquido de cada linha — a mesma regra padrão da Formação de custo.
  const extrasNf = useMemo((): ExtrasNf | null => {
    if (!nf?.totais) return null;
    const t = nf.totais;
    const descItens = nf.itens.reduce((acc, x) => acc + (x.vDesc ?? 0), 0);
    const total = t.frete + t.ipi + t.st + t.outras - Math.max(0, t.desconto - descItens);
    const base = nf.itens.reduce((acc, x) => acc + valorLiquido(x), 0);
    return { total, base, partes: t };
  }, [nf]);
  function custoLinha(l: Linha): CustoLinha {
    const liq = valorLiquido(l.xml);
    const extra = extrasNf && extrasNf.base > 0 ? (extrasNf.total * liq) / extrasNf.base : 0;
    return {
      liq,
      porFardo: R4(l.xml.qCom > 0 ? liq / l.xml.qCom : 0),
      un: R4(l.unidades > 0 ? liq / l.unidades : 0),
      unCom: R4(l.unidades > 0 ? (liq + extra) / l.unidades : 0),
      extra,
    };
  }
  // Custo de referência hoje: custo manual vigente (é o que Pedidos/DRE usam), senão o cadastro do Tiny.
  function referencia(sku: string): { valor: number; origem: string } | null {
    const h = hist[sku];
    if (h?.manual) return { valor: h.manual.custo, origem: "custo manual vigente" };
    const p = prods[sku];
    if (p && p.custo != null && Number(p.custo) > 0 && p.tipo !== "K") return { valor: Number(p.custo), origem: "custo no cadastro (Tiny)" };
    return null;
  }

  const incluidas = linhas.filter((l) => l.incluir && l.unidades > 0);
  const semSku = incluidas.filter((l) => !l.sku.trim()).length;
  const skuDesconhecido = prodQ.isSuccess
    ? incluidas.filter((l) => l.sku.trim() && !prods[l.sku.trim()]).length
    : 0;

  async function criar() {
    if (!nf || incluidas.length === 0) return;
    setSalvando(true);
    const tinyId = -Math.floor(Date.now() / 1000);
    try {
      // Agrupa por SKU (duas linhas da NF podem ser o mesmo produto).
      const porSku = new Map<string, { sku: string | null; descricao: string; gtin: string | null; qtd: number; valor: number; tinyProd: number }>();
      incluidas.forEach((l, i) => {
        const sku = l.sku.trim() || null;
        const chave = sku ?? `__sem_sku_${i}`;
        const g = porSku.get(chave);
        // valor LÍQUIDO da linha (vProd − desconto do item): o preço da entrada já sai com o desconto
        if (g) { g.qtd += l.unidades; g.valor += valorLiquido(l.xml); return; }
        const p = sku ? prods[sku] : undefined;
        porSku.set(chave, {
          sku, descricao: p?.nome ?? l.xml.xProd, gtin: l.xml.ean ?? l.xml.eanTrib,
          qtd: l.unidades, valor: valorLiquido(l.xml), tinyProd: p?.id_tiny ?? 0,
        });
      });
      const totalUn = [...porSku.values()].reduce((s, g) => s + g.qtd, 0);
      const agora = new Date().toISOString();

      const { error: eOc } = await supabaseExternal.from("compras_ordens").insert({
        tiny_id: tinyId,
        numero: `NF-${nf.numero}`,
        data_pedido: nf.emissao,
        data_prevista: null,
        situacao_tiny: null,
        fornecedor_id: fornecedor?.fornecedor_id ?? null,
        fornecedor_nome: fornecedor?.fornecedor_nome ?? nf.razaoSocial,
        fornecedor_fantasia: fornecedor?.fornecedor_fantasia ?? (nf.emitente !== nf.razaoSocial ? nf.emitente : null),
        categoria: "Entrada por NF (app)",
        total_produtos: nf.itens.reduce((s, x) => s + x.vProd, 0),
        total_pedido: nf.valor,
        itens_qtd: totalUn,
        observacoes: `Criada no app a partir da NF-e ${nf.numero}${nf.serie ? `/${nf.serie}` : ""}${nf.chave ? ` · chave ${nf.chave}` : ""}${perfil?.nome ? ` · por ${perfil.nome}` : ""}`,
        kanban_status: "conferencia",
        nf_numero: nf.numero,
        recebido_em: null,
        arquivada_em: null,
        atualizado_em: agora,
      });
      if (eOc) throw eOc;

      const { error: eIt } = await supabaseExternal.from("compra_ordem_itens").insert(
        [...porSku.values()].map((g) => ({
          ordem_tiny_id: tinyId,
          tiny_produto_id: g.tinyProd,
          sku: g.sku,
          descricao: g.descricao,
          gtin: g.gtin,
          quantidade: g.qtd,
          preco: g.qtd > 0 ? Math.round((g.valor / g.qtd) * 100) / 100 : 0,
          qtd_recebida: jaRecebido ? g.qtd : 0,
          conferido: jaRecebido,
          atualizado_em: agora,
        })),
      );
      if (eIt) {
        await supabaseExternal.from("compras_ordens").delete().eq("tiny_id", tinyId);
        throw eIt;
      }

      // Cabeçalho da NF (frete, IPI, ST, outras, desconto) para a formação de custo.
      // XML: totais da nota; o desconto dos itens já está no preço. NF do Tiny:
      // o servidor lê o cabeçalho na API (lá o desconto só existe no total).
      // todas as linhas da nota: o desconto de linha ignorada também não é do cabeçalho
      const descItens = Math.round(nf.itens.reduce((s2, x) => s2 + (x.vDesc ?? 0), 0) * 100) / 100;
      const { error: eCab } = await supabaseExternal.from("compras_nf_aplicada").upsert({
        ordem_tiny_id: tinyId, nf_numero: nf.numero.replace(/^0+/, "") || nf.numero,
        origem: nf.totais ? "xml" : "tiny", nf_tiny_id: nfTinyId,
        frete: nf.totais?.frete ?? null, ipi: nf.totais?.ipi ?? null, st: nf.totais?.st ?? null,
        outras: nf.totais?.outras ?? null, desconto_total: nf.totais?.desconto ?? null,
        desconto_itens: nf.totais ? descItens : 0, lido_em: nf.totais ? agora : null,
      }, { onConflict: "ordem_tiny_id,nf_numero" });
      if (eCab) console.warn("cabeçalho da NF não gravado:", eCab.message);

      // NF escolhida do espelho do Tiny: vincula direto pelo id.
      if (nfTinyId) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: tinyId, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("tiny_id", nfTinyId).is("ordem_tiny_id", null);
      }
      // Se a NF já está no espelho do Tiny sem OC, casa com esta entrada.
      if (!nfTinyId && fornecedor?.fornecedor_id) {
        await supabaseExternal.from("compras_nf_entrada").update({
          ordem_tiny_id: tinyId, match_metodo: "manual", match_score: null,
          conciliado_por: perfil?.nome ?? null, conciliado_em: agora,
        }).eq("fornecedor_id", fornecedor.fornecedor_id)
          .in("numero", [...new Set([nf.numero, nf.numeroBruto])]).is("ordem_tiny_id", null);
      }

      let lembrados = 0;
      if (lembrar) {
        const novos = incluidas
          .filter((l) => l.sku.trim() && l.fator > 0 && ((l.metodo !== "ean" && l.metodo !== "codigo") || l.fator !== 1))
          .map((l) => ({ descricao: l.xml.xProd, codigo: l.xml.cProd, unidade: l.xml.uCom, sku: l.sku.trim(), fator: l.fator }));
        if (novos.length) lembrados = await salvarDepara(fornecedor?.fornecedor_id, nf.cnpj, novos, perfil?.nome ?? null);
      }

      toast.success(`Entrada NF-${nf.numero} criada`, {
        description: `${porSku.size} item(ns) · ${formatNumber(totalUn)} un — já na coluna Conferência${lembrados ? ` · ${lembrados} de-para salvo(s)` : ""}`,
      });
      void qc.invalidateQueries({ queryKey: ["compras"] });
      limpar();
      onOpenChange(false);
      onCriada(tinyId);
    } catch (e) {
      toast.error("Falha ao criar a entrada", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  function setLinha(idx: number, patch: Partial<Linha>) {
    setLinhas((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) limpar(); onOpenChange(o); }}>
      <DialogContent className="max-w-[min(1320px,96vw)] w-full max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Nova entrada de recebimento pela NF</DialogTitle>
          <DialogDescription>
            Para mercadoria que chegou com nota e sem ordem de compra. Suba o XML da NF-e: os itens
            viram uma entrada na coluna Conferência, com o nosso SKU. Não cria nada no Tiny nem lança estoque.
          </DialogDescription>
        </DialogHeader>

        {!nf && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Buscar a NF pelo número ou pela chave</span>
              <div className="flex gap-2">
                <Input value={termo} onChange={(e) => setTermo(e.target.value)} placeholder="ex.: 16648 ou a chave de 44 dígitos"
                  className="h-9 font-mono text-sm" onKeyDown={(e) => { if (e.key === "Enter") void buscar(); }} disabled={lendo} />
                <Button variant="outline" className="h-9 gap-1.5" onClick={() => void buscar()} disabled={buscando || lendo || !termo.trim()}>
                  {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">Procura nas NFs de entrada que já estão no Tiny (atualizadas a cada 30 min). Nota que ainda não entrou no Tiny: use o XML.</span>
              {encontradas && encontradas.length === 0 && (
                <span className="text-xs text-amber-700 dark:text-amber-400">Nenhuma NF com esse número/chave no Tiny ainda — use o XML abaixo.</span>
              )}
              {encontradas && encontradas.length > 1 && (
                <div className="rounded-md border divide-y">
                  {encontradas.map((n) => (
                    <button key={n.tiny_id} type="button" disabled={lendo} onClick={() => void usarNfTiny(n)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40">
                      <span className="min-w-0 truncate"><b>NF {normNf(n.numero)}</b> · {n.fornecedor_nome} · {n.data_emissao ? n.data_emissao.split("-").reverse().join("/") : "—"}</span>
                      <span className="font-mono tabular-nums shrink-0">{formatBRL(Number(n.valor ?? 0))}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground"><div className="h-px flex-1 bg-border" />ou<div className="h-px flex-1 bg-border" /></div>
          <label
            className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-sm text-muted-foreground cursor-pointer hover:bg-muted/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void lerArquivo(e.dataTransfer.files?.[0]); }}
          >
            {lendo ? <Loader2 className="h-6 w-6 animate-spin" /> : <FileUp className="h-6 w-6" />}
            <span>{lendo ? "Lendo a nota e casando os produtos…" : <>Arraste o XML da NF-e aqui ou <span className="text-primary font-semibold">clique para escolher</span></>}</span>
            <input type="file" accept=".xml,text/xml,application/xml" className="hidden" disabled={lendo}
              onChange={(e) => { void lerArquivo(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          </div>
        )}
        {erro && <div className="text-sm text-red-700 dark:text-red-400 flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {erro}</div>}

        {nf && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border p-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold">NF {nf.numero}{nf.serie ? `/${nf.serie}` : ""}</span>
              <span>{nf.razaoSocial}</span>
              <span className="text-muted-foreground text-xs">{nf.emissao ? nf.emissao.split("-").reverse().join("/") : "—"}</span>
              <span className="font-mono tabular-nums">{formatBRL(nf.valor)}</span>
              <Button variant="ghost" size="sm" className="h-7 text-xs ml-auto" onClick={limpar}>trocar arquivo</Button>
              <span className="basis-full text-xs text-muted-foreground">
                {fornecedor
                  ? <>Fornecedor reconhecido: <b>{fornecedor.fornecedor_fantasia || fornecedor.fornecedor_nome}</b> (compras anteriores no Tiny)</>
                  : "Fornecedor sem compras anteriores no app — os produtos só casam por EAN ou código."}
              </span>
            </div>
            {avisos.map((a) => (
              <div key={a} className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {a}
              </div>
            ))}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] uppercase text-muted-foreground border-b">
                    <th className="py-1 pr-2 font-medium w-6" />
                    <th className="py-1 pr-2 font-medium">Item da NF</th>
                    <th className="py-1 pr-2 font-medium text-right">Qtd NF</th>
                    <th className="py-1 pr-2 font-medium">Nosso SKU</th>
                    <th className="py-1 pr-2 font-medium text-right" title="Quantas unidades do nosso SKU vêm em 1 unidade da NF (fardo com 5 = 5)">Un. por FD/CX</th>
                    <th className="py-1 pr-2 font-medium text-right">Unidades</th>
                    <th className="py-1 pl-3 font-medium text-right" title="Custo pelo valor líquido da linha da NF (já com o desconto do item). c/ frete+IPI = despesas da nota rateadas pelo valor">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l, idx) => {
                    const sku = l.sku.trim();
                    const p = sku ? prods[sku] : undefined;
                    return (
                      <tr key={idx} className={cn("border-b last:border-0 align-top", !l.incluir && "opacity-50")}>
                        <td className="py-2 pr-2">
                          <Checkbox checked={l.incluir} onCheckedChange={(v) => setLinha(idx, { incluir: v === true })} />
                        </td>
                        <td className="py-2 pr-3 w-[34%]">
                          <div className="text-[13px] font-medium leading-snug break-words">{l.xml.xProd}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            cód {l.xml.cProd || "—"}{l.xml.ean ? ` · EAN ${l.xml.ean}` : ""} · {formatBRL(l.xml.vProd)}
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">
                          {formatNumber(l.xml.qCom)} {l.xml.uCom}
                        </td>
                        <td className="py-2 pr-3">
                          <div className="flex items-start gap-3">
                          <Foto url={p?.foto_capa} />
                          <div className="min-w-0 flex-1">
                          <Input
                            value={l.sku}
                            placeholder="SKU (ex.: 15102)"
                            disabled={!l.incluir}
                            onChange={(e) => setLinha(idx, { sku: e.target.value, metodo: "manual" })}
                            className="h-8 w-40 font-mono text-xs"
                          />
                          <div className="text-[11.5px] mt-1 leading-snug break-words">
                            {!sku ? (
                              <span className="text-amber-700 dark:text-amber-400 font-semibold">sem SKU — entra só com a descrição da NF</span>
                            ) : p ? (
                              <span className="text-foreground/80">
                                {l.metodo === "ean" ? "pelo EAN · " : l.metodo === "codigo" ? "pelo código · " : l.metodo === "depara" ? "de-para salvo · " : ""}
                                {l.metodo === "descricao" && <span className="text-amber-700 dark:text-amber-400 font-semibold">pela descrição, confira · </span>}
                                {p.nome}
                              </span>
                            ) : prodQ.isFetching ? (
                              <span className="text-muted-foreground">conferindo…</span>
                            ) : (
                              <span className="text-red-700 dark:text-red-400 font-semibold">SKU não encontrado no cadastro</span>
                            )}
                          </div>
                          </div>
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-right">
                          <Input
                            value={String(Math.round(l.fator * 1000) / 1000)}
                            disabled={!l.incluir}
                            onChange={(e) => {
                              const v = Number(e.target.value.replace(",", "."));
                              const f = Number.isFinite(v) && v > 0 ? v : 0;
                              setLinha(idx, { fator: f, unidades: l.xml.qCom * f, nota: f !== 1 ? `${l.xml.qCom} ${l.xml.uCom} × ${f}` : null });
                            }}
                            className="h-8 w-16 ml-auto text-center font-mono text-xs"
                            inputMode="decimal"
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <Input
                            value={String(l.unidades)}
                            disabled={!l.incluir}
                            onChange={(e) => {
                              const v = Number(e.target.value.replace(",", "."));
                              const u = Number.isFinite(v) && v >= 0 ? v : 0;
                              setLinha(idx, { unidades: u, fator: l.xml.qCom > 0 ? u / l.xml.qCom : l.fator });
                            }}
                            className="h-8 w-24 ml-auto text-center font-mono text-xs"
                            inputMode="numeric"
                          />
                          {l.nota && <div className="text-[10px] text-muted-foreground mt-0.5 max-w-[180px] ml-auto">{l.nota}</div>}
                        </td>
                        <td className="py-1.5 pl-3 text-right whitespace-nowrap">
                          {(() => {
                            const c = custoLinha(l);
                            const ref = sku ? referencia(sku) : null;
                            const comExtras = !!extrasNf && Math.abs(c.unCom - c.un) >= 0.005;
                            const novo = comExtras ? c.unCom : c.un;
                            return (
                              <div className="flex items-start justify-end gap-1.5">
                                <div className="flex flex-col items-end leading-tight">
                                  <span className="text-[11px] text-muted-foreground tabular-nums">{brl4(c.porFardo)} / {l.xml.uCom || "un NF"}</span>
                                  <span className="text-[13px] font-semibold tabular-nums">{brl4(c.un)} / un</span>
                                  {comExtras && <span className="text-[11px] tabular-nums text-foreground/80" title="Com frete, IPI, ST e outras despesas da nota rateadas pelo valor">c/ frete+IPI {brl4(c.unCom)}</span>}
                                  {ref && <span className="text-[11px]">vs atual <Delta novo={novo} base={ref.valor} compacto /></span>}
                                </div>
                                {sku && (
                                  <InfoCusto
                                    sku={sku} nome={p?.nome ?? null} tipo={p?.tipo ?? null}
                                    cadastro={p?.custo == null ? null : Number(p.custo)}
                                    hist={hist[sku]} carregando={histQ.isFetching}
                                    linha={c} uCom={l.xml.uCom} fator={l.fator} comExtras={comExtras}
                                    extras={extrasNf} referencia={ref}
                                  />
                                )}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(semSku > 0 || skuDesconhecido > 0) && (
              <div className="text-xs text-amber-800 dark:text-amber-300">
                {semSku > 0 && <span>{semSku} item(ns) sem SKU. </span>}
                {skuDesconhecido > 0 && <span>{skuDesconhecido} SKU(s) não existem no cadastro — confira antes de criar. </span>}
                Desmarque o que não deve entrar (brinde, material de uso).
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-3 sm:justify-between items-center">
          {nf ? (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={jaRecebido} onCheckedChange={(v) => setJaRecebido(v === true)} />
                Já conferi — lançar as quantidades da NF como recebidas
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox checked={lembrar} onCheckedChange={(v) => setLembrar(v === true)} />
                Lembrar o de-para (produto e fator) para as próximas notas deste fornecedor
              </label>
            </div>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
            <Button onClick={() => void criar()} disabled={!nf || incluidas.length === 0 || salvando} className="gap-2">
              {salvando && <Loader2 className="h-4 w-4 animate-spin" />}
              Criar entrada ({incluidas.length} item{incluidas.length === 1 ? "" : "s"})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Botão de INFO: cruza o custo desta NF com o custo de hoje e as compras anteriores.
function InfoCusto({
  sku, nome, tipo, cadastro, hist, carregando, linha, uCom, fator, comExtras, extras, referencia,
}: {
  sku: string; nome: string | null; tipo: string | null; cadastro: number | null;
  hist: HistCusto | undefined; carregando: boolean;
  linha: CustoLinha; uCom: string; fator: number; comExtras: boolean;
  extras: ExtrasNf | null;
  referencia: { valor: number; origem: string } | null;
}) {
  const novo = comExtras ? linha.unCom : linha.un;
  const ultima = hist?.compras[0];
  const Item = ({ rot, valor, sub, destaque }: { rot: string; valor: number | null | undefined; sub?: string; destaque?: boolean }) => (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b last:border-0">
      <div className="min-w-0">
        <div className={cn("text-[12px]", destaque && "font-semibold")}>{rot}</div>
        {sub && <div className="text-[10.5px] text-muted-foreground">{sub}</div>}
      </div>
      <div className="text-right shrink-0">
        <div className={cn("text-[12px] tabular-nums", destaque && "font-semibold")}>{valor != null && valor > 0 ? brl4(valor) : "—"}</div>
        {valor != null && valor > 0 && <div className="text-[10.5px]">nesta NF <Delta novo={novo} base={valor} /></div>}
      </div>
    </div>
  );
  const un = uCom || "un da NF";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title="Comparar com o custo atual e as compras anteriores"
          className="mt-0.5 h-6 w-6 shrink-0 rounded-md border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted">
          <Info className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] p-3 text-xs">
        <div className="font-semibold text-[13px] leading-snug">{sku} · {nome ?? "—"}</div>
        <div className="mt-2 rounded-md bg-muted/50 p-2 space-y-0.5">
          <div className="flex justify-between gap-3"><span>Valor líquido da linha</span><span className="tabular-nums">{formatBRL(linha.liq)}</span></div>
          <div className="flex justify-between gap-3"><span>Por {un}</span><span className="tabular-nums">{brl4(linha.porFardo)}</span></div>
          <div className="flex justify-between gap-3"><span>Por unidade ({formatNumber(fator, 3)} un por {un})</span><span className="tabular-nums font-semibold">{brl4(linha.un)}</span></div>
          {extras && (
            <div className="flex justify-between gap-3" title={`Frete ${formatBRL(extras.partes.frete)} · IPI ${formatBRL(extras.partes.ipi)} · ST ${formatBRL(extras.partes.st)} · outras ${formatBRL(extras.partes.outras)}`}>
              <span>+ despesas da nota rateadas ({formatBRL(linha.extra)})</span>
              <span className="tabular-nums font-semibold">{brl4(linha.unCom)}</span>
            </div>
          )}
          {!extras && <div className="text-[10.5px] text-muted-foreground">NF do Tiny: frete e IPI do cabeçalho só entram na Formação de custo.</div>}
        </div>

        <div className="mt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">Comparando (custo por unidade)</div>
        {carregando && !hist && <div className="py-2 text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> carregando…</div>}
        <div>
          {tipo === "K"
            ? <Item rot="Cadastro (Tiny)" valor={null} sub="produto é kit — o custo do Tiny não vale para kit" />
            : <Item rot="Cadastro (Tiny)" valor={cadastro} sub="custo do produto no Tiny (copiado todo dia às 05h)" destaque={referencia?.origem === "custo no cadastro (Tiny)"} />}
          {hist?.manual && <Item rot="Custo manual vigente" valor={hist.manual.custo} sub={`desde ${dataBr(hist.manual.desde)} — é o que Pedidos e DRE usam`} destaque />}
          {hist?.formacao && (
            <Item rot="Última formação de custo" valor={hist.formacao.custo}
              sub={`OC #${hist.formacao.ordem ?? "?"} · ${dataBr(hist.formacao.em)}${hist.formacao.anterior ? ` · antes era ${brl4(hist.formacao.anterior)}` : ""}`} />
          )}
          {ultima && <Item rot="Última compra" valor={ultima.preco} sub={`#${ultima.numero} · ${dataBr(ultima.data)} · ${ultima.fornecedor ?? ""} · ${formatNumber(ultima.qtd)} un`} />}
        </div>
        {hist && hist.compras.length > 1 && (
          <>
            <div className="mt-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">Compras anteriores</div>
            <table className="w-full mt-0.5">
              <tbody>
                {hist.compras.map((c, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-0.5 pr-2 whitespace-nowrap">{dataBr(c.data)}</td>
                    <td className="py-0.5 pr-2 truncate max-w-[160px]" title={c.fornecedor ?? ""}>#{c.numero} · {c.fornecedor ?? "—"}</td>
                    <td className="py-0.5 pr-2 text-right tabular-nums">{formatNumber(c.qtd)} un</td>
                    <td className="py-0.5 text-right tabular-nums">{brl4(c.preco)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {hist && !hist.compras.length && !hist.formacao && <div className="mt-1 text-muted-foreground">Sem compra anterior deste SKU no app.</div>}
        <div className="mt-2 text-[10.5px] text-muted-foreground leading-snug">
          {referencia
            ? <>Referência do "vs atual": {referencia.origem}. Diferença grande costuma ser fator errado (fardo × unidade) — confira "Un. por FD/CX".</>
            : "Sem custo de referência para comparar."}
          {" "}Criar a entrada não muda o custo: isso é feito na Formação de custo da ordem.
        </div>
      </PopoverContent>
    </Popover>
  );
}
