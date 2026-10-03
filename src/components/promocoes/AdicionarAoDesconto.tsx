import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  FAIXAS_MC, Foto, RED, calcMc, chamarPromocoes, corMc, num, passaFaixa, tituloMc, traduzirErroShopee, useTarifaShopee, type McBase,
} from "./comum";

// ============================================================================
// Adicionar produtos a um desconto ("Minha Promoção") — por padrão SÓ os
// anúncios que não estão em nenhuma campanha em andamento/próxima (desconto,
// relâmpago, combo… — get_item_promotion via shopee-promocoes?modulo=em-campanha).
// Preço promo = preço cheio − desconto padrão (editável por linha); MC na
// comissão da tabela Shopee vigente; filtro por faixa de MC; 20 por página.
// Gravação: add_discount_item (confirmar=1) — muda o preço público na hora.
// ============================================================================

interface AnuncioBusca {
  item_id: number; nome: string; sku_pai: string | null; tem_variacao: boolean;
  preco_min: number | null; preco_max: number | null; estoque_total: number | null;
  imagem_url: string | null; criado_em_shopee: string | null; vendas_30d: number;
}
interface Variacao {
  item_id: number; model_id: number; sku: string | null; nome_variacao: string | null;
  preco: number | null; preco_original: number | null; estoque: number | null;
}
interface Linha {
  key: string; item_id: number; model_id: number; nome: string; variacao: string | null;
  sku: string | null; imagem: string | null; cheio: number; estoque: number; vendas: number | null;
}

const POR_PAGINA = 20;
const r2 = (x: number) => Math.round(x * 100) / 100;

export function AdicionarAoDesconto({ shopId, desconto, onFechar, onAdicionou }: {
  shopId: number;
  desconto: { discount_id: number; discount_name: string };
  onFechar: () => void;
  onAdicionou: () => void;
}) {
  const qc = useQueryClient();
  const tarifa = useTarifaShopee().data;
  const [soSemCampanha, setSoSemCampanha] = useState(true);
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");
  const [ordem, setOrdem] = useState<"vendas" | "recentes">("vendas");
  const [faixa, setFaixa] = useState("todas");
  const [descPadrao, setDescPadrao] = useState("10");
  const [precos, setPrecos] = useState<Map<string, number>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pagina, setPagina] = useState(0);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { setBuscaAtiva(busca.trim()); setPagina(0); }, 350);
    return () => clearTimeout(t);
  }, [busca]);

  // 1) quais anúncios já estão em alguma campanha (ao vivo na Shopee)
  const campQ = useQuery({
    queryKey: ["promo-shopee", "em-campanha", shopId],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ ids: number[]; anuncios: number; lidos: number; erros: unknown[] }> => {
      const r = await chamarPromocoes(`modulo=em-campanha&shop_id=${shopId}`);
      if (r.erro) throw new Error(`${r.erro.error}: ${r.erro.message ?? ""}`);
      return { ids: (r.em_campanha ?? []).map((x: { item_id: number }) => Number(x.item_id)), anuncios: r.anuncios, lidos: r.lidos, erros: r.erros ?? [] };
    },
  });

  // 2) catálogo (espelho) — já sem os que estão em campanha, se marcado
  const anunQ = useQuery({
    queryKey: ["promo-shopee", "candidatos", shopId, buscaAtiva, ordem, soSemCampanha, campQ.data?.ids.length ?? -1],
    enabled: !soSemCampanha || campQ.isSuccess,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ anuncios: AnuncioBusca[]; vars: Map<number, Variacao[]> }> => {
      const { data, error } = await supabaseExternal.rpc("shopee_anuncios_busca", {
        p_shop_id: shopId, p_busca: buscaAtiva.replace(/[%_]/g, " ") || null, p_ordem: ordem,
        p_offset: 0, p_limit: 1000, p_excluir: soSemCampanha ? (campQ.data?.ids ?? []) : null,
      });
      if (error) throw error;
      const anuncios = (data ?? []) as AnuncioBusca[];
      const vars = new Map<number, Variacao[]>();
      const comVar = anuncios.filter((a) => a.tem_variacao).map((a) => a.item_id);
      for (let i = 0; i < comVar.length; i += 200) {
        const { data: v } = await supabaseExternal.from("shopee_anuncios_variacao")
          .select("item_id, model_id, sku, nome_variacao, preco, preco_original, estoque")
          .eq("shop_id", shopId).in("item_id", comVar.slice(i, i + 200));
        for (const x of (v ?? []) as Variacao[]) {
          if (!vars.has(x.item_id)) vars.set(x.item_id, []);
          vars.get(x.item_id)!.push(x);
        }
      }
      return { anuncios, vars };
    },
  });

  const linhas = useMemo((): Linha[] => {
    const out: Linha[] = [];
    for (const a of anunQ.data?.anuncios ?? []) {
      if (a.tem_variacao) {
        for (const v of anunQ.data?.vars.get(a.item_id) ?? []) {
          out.push({
            key: `${a.item_id}:${v.model_id}`, item_id: a.item_id, model_id: v.model_id, nome: a.nome,
            variacao: v.nome_variacao, sku: v.sku ?? a.sku_pai, imagem: a.imagem_url,
            cheio: num(v.preco_original ?? v.preco), estoque: num(v.estoque), vendas: null,
          });
        }
      } else {
        out.push({
          key: `${a.item_id}:0`, item_id: a.item_id, model_id: 0, nome: a.nome, variacao: null,
          sku: a.sku_pai, imagem: a.imagem_url, cheio: num(a.preco_max ?? a.preco_min),
          estoque: num(a.estoque_total), vendas: num(a.vendas_30d),
        });
      }
    }
    return out;
  }, [anunQ.data]);

  // 3) CMV / imposto / vendas por SKU (regra no banco)
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

  const d = Math.min(90, Math.max(0, Number(descPadrao.replace(",", ".")) || 0)) / 100;
  const promoDe = (l: Linha) => precos.get(l.key) ?? r2(l.cheio * (1 - d));
  const mcDe = (l: Linha) => calcMc(l.sku ? bases.get(l.sku) : undefined, promoDe(l), tarifa);

  const filtradas = linhas.filter((l) => passaFaixa(faixa, mcDe(l)));
  const paginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA));
  const pag = Math.min(pagina, paginas - 1);
  const visiveis = filtradas.slice(pag * POR_PAGINA, pag * POR_PAGINA + POR_PAGINA);
  const todasPagSel = visiveis.length > 0 && visiveis.every((l) => sel.has(l.key));
  const selecionadas = linhas.filter((l) => sel.has(l.key));

  function alternar(key: string, v: boolean) {
    setSel((s) => { const n = new Set(s); if (v) n.add(key); else n.delete(key); return n; });
  }

  async function adicionar() {
    if (selecionadas.length === 0) return;
    const invalidas = selecionadas.filter((l) => !(promoDe(l) > 0) || promoDe(l) >= l.cheio);
    if (invalidas.length) {
      toast.error("Preço promo precisa ser menor que o cheio", { description: invalidas.slice(0, 5).map((l) => l.sku ?? l.nome).join(", ") });
      return;
    }
    const negativas = selecionadas.filter((l) => { const m = mcDe(l); return m != null && m.mc < 0; }).length;
    if (!window.confirm(
      `Adicionar ${selecionadas.length} produto(s) à promoção "${desconto.discount_name}" na Shopee?\n` +
      `O preço público muda na hora.${negativas ? `\n\nATENÇÃO: ${negativas} com margem NEGATIVA no preço promo.` : ""}`,
    )) return;

    const porItem = new Map<number, Linha[]>();
    for (const l of selecionadas) { if (!porItem.has(l.item_id)) porItem.set(l.item_id, []); porItem.get(l.item_id)!.push(l); }
    const itemList = [...porItem.entries()].map(([itemId, ls]) => ls[0].model_id
      ? { item_id: itemId, purchase_limit: 0, model_list: ls.map((l) => ({ model_id: l.model_id, model_promotion_price: promoDe(l) })) }
      : { item_id: itemId, purchase_limit: 0, item_promotion_price: promoDe(ls[0]) });

    setSalvando(true);
    const falhas: string[] = [];
    let ok = 0;
    // v5: se o desconto é de uma promoção diária, o servidor também leva os
    // produtos para a lista da diária e para os dias já programados.
    let diaria: string | null = null; let diasProp = 0; const falhasProp = new Set<string>();
    try {
      for (let i = 0; i < itemList.length; i += 50) {
        const lote = itemList.slice(i, i + 50);
        const r = await chamarPromocoes(`modulo=add-itens&shop_id=${shopId}&discount_id=${desconto.discount_id}&confirmar=1&propagar=1`, { item_list: lote });
        if (r.erro) { falhas.push(`${r.erro.error}: ${r.erro.message ?? ""}`); continue; }
        if (r.propagacao?.recorrente) {
          diaria = r.propagacao.recorrente;
          const ds = (r.propagacao.dias ?? []) as Array<{ dia: string; falhas: unknown[] }>;
          diasProp = Math.max(diasProp, ds.length);
          for (const d of ds) if (d.falhas.length) falhasProp.add(d.dia.split("-").reverse().slice(0, 2).join("/"));
        }
        const errs = (r.response?.error_list ?? []) as Array<{ item_id: number; model_id?: number; fail_message?: string; fail_error?: string }>;
        for (const e of errs) {
          const l = selecionadas.find((x) => x.item_id === Number(e.item_id) && (!e.model_id || x.model_id === Number(e.model_id)));
          falhas.push(`${l?.sku ?? e.item_id}: ${traduzirErroShopee(e.fail_message ?? e.fail_error)}`);
        }
        ok += lote.length - new Set(errs.map((e) => e.item_id)).size;
      }
      if (diaria) {
        if (falhasProp.size === 0) toast.success(`Também incluído(s) na promoção diária "${diaria}"`, { description: `${diasProp} dia(s) já programado(s) atualizados.` });
        else toast.warning(`Promoção diária "${diaria}": recusa em ${falhasProp.size} dia(s)`, { description: `Dias: ${[...falhasProp].join(", ")} — veja o motivo passando o mouse nos dias do painel.`, duration: 15000 });
      }
      if (falhas.length === 0) toast.success(`${ok} produto(s) adicionados à promoção`);
      else toast.warning(`${ok} adicionado(s) · ${falhas.length} recusa(s)`, { description: falhas.slice(0, 6).join("\n"), duration: 15000 });
      void qc.invalidateQueries({ queryKey: ["promo-shopee", "em-campanha", shopId] });
      onAdicionou();
      if (falhas.length === 0) onFechar();
      else setSel(new Set());
    } catch (e) {
      toast.error("Falha ao adicionar", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  const carregando = (soSemCampanha && campQ.isLoading) || anunQ.isLoading;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-w-[min(1400px,96vw)] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adicionar produtos — {desconto.discount_name}</DialogTitle>
          <DialogDescription>
            Preço promo = preço cheio − desconto padrão (ajuste por linha). Margem com a comissão Shopee vigente
            (abaixo de R$ 80: 20% + R$ 4,50 por unidade). Nada vai para a Shopee até “Adicionar”.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12.5px] mr-2">
            <Switch checked={soSemCampanha} onCheckedChange={(v) => { setSoSemCampanha(v); setPagina(0); }} />
            Só produtos sem nenhuma campanha
          </label>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-8 text-sm" placeholder="nome ou SKU" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
          {([["vendas", "Mais vendidos"], ["recentes", "Mais recentes"]] as const).map(([k, rot]) => (
            <Button key={k} size="sm" variant={ordem === k ? "default" : "outline"} className="h-8 text-xs"
              onClick={() => { setOrdem(k); setPagina(0); }}>{rot}</Button>
          ))}
          <span className="text-[12px] text-muted-foreground ml-1">Desconto padrão</span>
          <Input className="h-8 w-[56px] text-center font-mono text-xs" value={descPadrao} inputMode="decimal"
            onChange={(e) => setDescPadrao(e.target.value)} />
          <span className="text-[12px] text-muted-foreground">%</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground mr-1">MC no preço promo:</span>
          {FAIXAS_MC.map((f) => (
            <Button key={f.id} size="sm" variant={faixa === f.id ? "default" : "outline"} className="h-7 text-[11.5px] px-2.5"
              onClick={() => { setFaixa(f.id); setPagina(0); }}>
              {f.rotulo}
              {!baseQ.isLoading && <span className="ml-1 opacity-70 tabular-nums">{f.id === "todas" ? linhas.length : linhas.filter((l) => passaFaixa(f.id, mcDe(l))).length}</span>}
            </Button>
          ))}
        </div>

        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-muted/60 text-muted-foreground text-[10.5px] uppercase tracking-wide">
              <tr>
                <th className="px-2 py-1.5 w-8">
                  <Checkbox checked={todasPagSel} onCheckedChange={(v) => visiveis.forEach((l) => alternar(l.key, v === true))} />
                </th>
                <th className="text-left font-medium px-2 py-1.5">Produto</th>
                <th className="text-right font-medium px-2 py-1.5">{ordem === "recentes" ? "Criado" : "Vendas 30d"}</th>
                <th className="text-right font-medium px-2 py-1.5">Preço cheio</th>
                <th className="text-right font-medium px-2 py-1.5">Preço promo</th>
                <th className="text-right font-medium px-2 py-1.5">CMV</th>
                <th className="text-right font-medium px-2 py-1.5">MC R$</th>
                <th className="text-right font-medium px-2 py-1.5">MC %</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {carregando ? (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  {soSemCampanha && campQ.isLoading ? "Conferindo na Shopee quais anúncios já estão em campanha…" : "Carregando catálogo…"}
                </td></tr>
              ) : campQ.isError && soSemCampanha ? (
                <tr><td colSpan={8} className="p-4 text-center" style={{ color: RED }}>Não consegui conferir as campanhas: {(campQ.error as Error).message}</td></tr>
              ) : visiveis.length === 0 ? (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Nenhum produto neste filtro.</td></tr>
              ) : visiveis.map((l) => {
                const base = l.sku ? bases.get(l.sku) : undefined;
                const promo = promoDe(l);
                const mc = mcDe(l);
                const anun = anunQ.data?.anuncios.find((a) => a.item_id === l.item_id);
                return (
                  <tr key={l.key} className={cn(sel.has(l.key) && "bg-primary/5")}>
                    <td className="px-2 py-1.5"><Checkbox checked={sel.has(l.key)} onCheckedChange={(v) => alternar(l.key, v === true)} /></td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Foto url={l.imagem} size={34} />
                        <div className="min-w-0">
                          <div className="truncate max-w-[520px]" title={l.nome}>{l.nome}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {l.sku ?? "sem SKU"}{l.variacao ? ` · ${l.variacao}` : ""} · estoque {l.estoque}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                      {ordem === "recentes"
                        ? (anun?.criado_em_shopee ? new Date(anun.criado_em_shopee).toLocaleDateString("pt-BR") : "—")
                        : `${l.vendas ?? (base ? num(base.vendas_30d) : 0)} un`}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">{formatBRL(l.cheio)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <CampoPreco valor={promo} alterado={precos.has(l.key)}
                        onMudar={(v) => { setPrecos((m) => new Map(m).set(l.key, v)); alternar(l.key, true); }} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">
                      {base?.cmv != null ? formatBRL(num(base.cmv)) : baseQ.isLoading ? "…" : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-mono" style={{ color: mc ? corMc(mc.pct) : undefined }} title={tituloMc(base, mc)}>
                      {mc ? formatBRL(mc.mc) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-mono font-semibold" style={{ color: mc ? corMc(mc.pct) : undefined }} title={tituloMc(base, mc)}>
                      {mc ? `${(mc.pct * 100).toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[11.5px] text-muted-foreground">
            {filtradas.length} produto(s) no filtro
            {soSemCampanha && campQ.data ? ` · ${campQ.data.ids.length} de ${campQ.data.anuncios} anúncios já estão em campanha (fora da lista)` : ""}
            {campQ.data && campQ.data.erros.length > 0 ? " · conferência parcial (limite de tempo/Shopee)" : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={pag === 0} onClick={() => setPagina(pag - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="text-[12px] tabular-nums">{pag + 1} / {paginas}</span>
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={pag + 1 >= paginas} onClick={() => setPagina(pag + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
            <Button size="sm" className="h-8 gap-1.5 ml-2" disabled={selecionadas.length === 0 || salvando} onClick={() => void adicionar()}>
              {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Adicionar {selecionadas.length || ""} à promoção
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CampoPreco({ valor, onMudar, alterado }: { valor: number; onMudar: (v: number) => void; alterado?: boolean }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <Input
      className={cn("h-7 w-[84px] ml-auto text-[12.5px] tabular-nums font-mono text-right px-1.5", alterado && "border-amber-500 bg-amber-500/10")}
      inputMode="decimal" value={txt ?? valor.toFixed(2)}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        if (txt === null) return;
        const v = Number(txt.replace(",", "."));
        setTxt(null);
        if (Number.isFinite(v) && v > 0) onMudar(r2(v));
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}
