import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Copy, ExternalLink, Loader2, RefreshCw, Tag, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Foto, GREEN, AMBER, RED } from "./comum";

// ============================================================================
// Promoções Amazon (20/out/2026, pedido do dono — opções B + C).
// A Amazon não cria Oferta Relâmpago, Cupom nem desconto Prime pela API: isso continua no Seller Central
// (atalhos no fim da tela, com a lista de produtos e o preço sugerido para copiar). Pela API (edge fn
// amazon-promocoes):
//   · promoções da conta (Promotions API) e os produtos de cada uma, com a MC no preço da promoção;
//   · catálogo FBA com estoque ou venda em 30 d: preço cheio, preço de oferta, taxas REAIS da Amazon no preço
//     (Product Fees API), CMV, MC e o preço para cada faixa de MC;
//   · PREÇO DE OFERTA com início e fim: conferido no validador da Amazon antes; aplicar exige login e confirmação.
// ============================================================================

type Conta = "acz" | "svl";
interface Mc { reais: number | null; pct: number | null }
interface ItemCat {
  sku_amazon: string; sku: string | null; asin: string | null; titulo: string | null; foto: string | null; status: string[];
  estoque: number; a_caminho: number; vendas_30d: number; preco_cheio: number | null; preco_atual: number | null;
  oferta: { preco: number; inicio: string | null; fim: string | null; vigente: boolean } | null;
  cmv: number | null; taxa: { total: number; comissao: number; outras: number; comissao_pct: number } | null; taxa_erro: string | null;
  mc_atual: Mc | null; preco_por_mc: Record<string, number | null> | null; problemas: string[];
}
interface Catalogo { ok: boolean; erro?: string; empresa: string; imposto: number; faixas: number[]; itens: ItemCat[]; tempo_ms: number }
interface Promo {
  promotionId: string; promotionTitle: string | null; promotionType: string; status: string;
  schedule?: { startDate?: string; endDate?: string };
}
interface ResOferta {
  sku: string; preco: number | null; inicio: string | null; fim: string | null; pendencias: string[]; preco_cheio?: number;
  taxa?: number | null; mc?: Mc | null; validacao?: { status: number; resultado: string | null; problemas: string[] };
  aplicado?: { status: number; resultado: string | null; submissao: string | null; problemas: string[] };
}

const TIPO: Record<string, string> = { PRICE_DISCOUNT: "Desconto de preço", DEAL: "Oferta relâmpago", COUPON: "Cupom", BASKET_BUILDING: "Leve mais" };
const ST: Record<string, { rotulo: string; cor: string }> = {
  RUNNING: { rotulo: "Em andamento", cor: GREEN }, SCHEDULED: { rotulo: "Programada", cor: AMBER }, UPCOMING: { rotulo: "Programada", cor: AMBER },
  EXPIRED: { rotulo: "Encerrada", cor: "#64748B" }, CANCELED: { rotulo: "Cancelada", cor: "#64748B" }, CANCELLED: { rotulo: "Cancelada", cor: "#64748B" },
};
const FAIXAS = [{ v: "0.1", r: "10%" }, { v: "0.15", r: "15%" }, { v: "0.1725", r: "17,25%" }, { v: "0.2", r: "20%" }];
// Seller Central (endereços não conferidos com login — se algum não abrir a tela certa, trocar aqui)
const SC = "https://sellercentral.amazon.com.br";
const ATALHOS = [
  { nome: "Criar cupom", url: `${SC}/coupons` },
  { nome: "Criar oferta relâmpago", url: `${SC}/merchandising-new` },
  { nome: "Promoções (desconto de preço)", url: `${SC}/promotions/manage` },
];

async function chamar<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseExternal.functions.invoke("amazon-promocoes", { body });
  if (error) {
    let msg = error.message;
    try { const j = await (error as { context?: Response }).context?.json(); if (j?.erro) msg = j.erro; } catch { /* corpo não-JSON */ }
    throw new Error(msg);
  }
  const d = data as T & { ok?: boolean; erro?: string };
  if (d && d.ok === false && d.erro) throw new Error(d.erro);
  return d;
}
const corPct = (p: number | null | undefined) => (p == null ? "#64748B" : p < 0 ? RED : p < 10 ? AMBER : GREEN);
const dataBR = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "—");
const comprável = (i: ItemCat) => i.status.includes("BUYABLE");
/** "2026-10-21T00:00" (datetime-local, horário de Brasília) → ISO com -03:00 */
const brtIso = (v: string) => (v ? `${v}:00-03:00` : "");
function padraoDatas() {
  const brt = new Date(Date.now() - 3 * 3600000);
  const amanha = new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate() + 1));
  const fim = new Date(amanha.getTime() + 6 * 86400000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return { inicio: `${d(amanha)}T00:00`, fim: `${d(fim)}T23:59` };
}

export function PromocoesAmazon() {
  const [conta, setConta] = useState<Conta>("acz");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [dialogo, setDialogo] = useState<"oferta" | "remover" | null>(null);
  const [busca, setBusca] = useState("");
  const qc = useQueryClient();

  const cat = useQuery({
    queryKey: ["promo-amazon", "catalogo", conta],
    queryFn: () => chamar<Catalogo>({ modulo: "catalogo", conta }),
    staleTime: 5 * 60 * 1000,
  });
  const itens = useMemo(() => {
    const b = busca.trim().toLowerCase();
    return (cat.data?.itens ?? []).filter((i) => !b || [i.titulo, i.sku, i.sku_amazon, i.asin].some((x) => String(x ?? "").toLowerCase().includes(b)));
  }, [cat.data, busca]);
  const selecionados = (cat.data?.itens ?? []).filter((i) => sel.has(i.sku_amazon));
  const bloqueados = (cat.data?.itens ?? []).filter((i) => !comprável(i) && i.vendas_30d > 0);

  const trocarConta = (c: Conta) => { setConta(c); setSel(new Set()); };
  const alternar = (s: string) => setSel((x) => { const n = new Set(x); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const copiarLista = () => {
    const linhas = selecionados.map((i) => [i.sku_amazon, i.asin ?? "", i.titulo ?? "", i.preco_cheio ?? "", i.preco_por_mc?.["0.15"] ?? ""].join("\t"));
    void navigator.clipboard?.writeText(["SKU\tASIN\tProduto\tPreço cheio\tPreço p/ MC 15%", ...linhas].join("\n"));
    toast.success(`${selecionados.length} produto(s) copiados (SKU, ASIN, preço cheio e preço para MC 15%)`);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {(["acz", "svl"] as Conta[]).map((c) => (
            <Button key={c} size="sm" variant={conta === c ? "default" : "outline"} className="h-8" onClick={() => trocarConta(c)}>
              {c === "acz" ? "ACZ Pet (Ottz)" : "SVL Store"}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={cat.isFetching}
          onClick={() => { void qc.invalidateQueries({ queryKey: ["promo-amazon"] }); }}>
          {cat.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Atualizar da Amazon
        </Button>
      </div>

      <Promocoes conta={conta} />

      {bloqueados.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-[12.5px]">
          <div className="font-semibold text-red-700 dark:text-red-300 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> {bloqueados.length} anúncio(s) que vendem e hoje NÃO estão compráveis na Amazon</div>
          <ul className="mt-1 space-y-0.5">
            {bloqueados.slice(0, 6).map((i) => (
              <li key={i.sku_amazon}><b>{i.sku_amazon}</b> ({i.vendas_30d} vendidos em 30 d) — {i.problemas.find((p) => !/outras limita/i.test(p)) ?? i.problemas[0] ?? "sem o status BUYABLE"}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center justify-between gap-3 p-3 border-b flex-wrap">
          <div>
            <div className="text-sm font-semibold">Produtos FBA {cat.data && <span className="text-muted-foreground font-normal">({itens.length})</span>}</div>
            <div className="text-[11.5px] text-muted-foreground">
              Com estoque no CD ou venda em 30 dias. Taxas lidas da Amazon no preço atual; imposto {cat.data ? `${(cat.data.imposto * 100).toFixed(1).replace(".", ",")}%` : "—"}.
              Preço por faixa = o preço que dá aquela margem de contribuição (estimativa; a conferência recalcula com a taxa exata).
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input className="h-8 w-56" placeholder="Buscar SKU, ASIN ou nome" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
        </div>
        {sel.size > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-accent/40 flex-wrap text-[12.5px]">
            <b>{sel.size} selecionado(s)</b>
            <Button size="sm" className="h-7 gap-1.5" onClick={() => setDialogo("oferta")}><Tag className="h-3.5 w-3.5" /> Preço de oferta…</Button>
            {selecionados.some((i) => i.oferta) && <Button size="sm" variant="outline" className="h-7" onClick={() => setDialogo("remover")}>Tirar preço de oferta…</Button>}
            <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={copiarLista}><Copy className="h-3.5 w-3.5" /> Copiar para o Seller Central</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSel(new Set())}><X className="h-3.5 w-3.5" /></Button>
          </div>
        )}
        {cat.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Lendo anúncios, preços e taxas na Amazon (~15 s)…</div>
        ) : cat.error ? (
          <div className="p-4 text-sm text-red-600">Erro: {(cat.error as Error).message}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 w-8" />
                  <th className="text-left font-medium px-2 py-2">Produto</th>
                  <th className="text-right font-medium px-2 py-2">Estoque</th>
                  <th className="text-right font-medium px-2 py-2">Vendas 30d</th>
                  <th className="text-right font-medium px-2 py-2">Preço cheio</th>
                  <th className="text-right font-medium px-2 py-2">Oferta</th>
                  <th className="text-right font-medium px-2 py-2">Taxas Amazon</th>
                  <th className="text-right font-medium px-2 py-2">CMV</th>
                  <th className="text-right font-medium px-2 py-2">MC hoje</th>
                  {FAIXAS.map((f) => <th key={f.v} className="text-right font-medium px-2 py-2">MC {f.r}</th>)}
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.sku_amazon} className={cn("border-t", sel.has(i.sku_amazon) && "bg-accent/30")}>
                    <td className="px-2 py-1.5"><Checkbox checked={sel.has(i.sku_amazon)} onCheckedChange={() => alternar(i.sku_amazon)} /></td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2 min-w-[280px] max-w-[440px]">
                        <Foto url={i.foto} size={36} />
                        <div className="min-w-0">
                          <div className="truncate" title={i.titulo ?? ""}>{i.titulo ?? i.sku_amazon}</div>
                          <div className="text-[10.5px] text-muted-foreground flex gap-1.5 flex-wrap">
                            <span className="font-mono">{i.sku_amazon}</span>
                            {i.sku && i.sku !== i.sku_amazon && <span>· nosso {i.sku}</span>}
                            {i.asin && <a className="hover:underline" href={`https://www.amazon.com.br/dp/${i.asin}`} target="_blank" rel="noreferrer">· {i.asin}</a>}
                            {!comprável(i) && <span className="text-red-600 font-semibold">· não comprável</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.estoque}{i.a_caminho ? <span className="text-muted-foreground"> +{i.a_caminho}</span> : null}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.vendas_30d}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.preco_cheio != null ? formatBRL(i.preco_cheio) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {i.oferta ? <span title={`${dataBR(i.oferta.inicio)} → ${dataBR(i.oferta.fim)}`} className={i.oferta.vigente ? "font-semibold" : "text-muted-foreground"}>
                        {formatBRL(i.oferta.preco)}<span className="block text-[10px] text-muted-foreground">{i.oferta.vigente ? "até " : "de "}{dataBR(i.oferta.vigente ? i.oferta.fim : i.oferta.inicio)}</span></span> : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums" title={i.taxa ? `comissão ${formatBRL(i.taxa.comissao)} (${i.taxa.comissao_pct}%) + FBA/outras ${formatBRL(i.taxa.outras)}` : i.taxa_erro ?? ""}>
                      {i.taxa ? formatBRL(i.taxa.total) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.cmv != null ? formatBRL(i.cmv) : <span className="text-amber-600">sem custo</span>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold" style={{ color: corPct(i.mc_atual?.pct) }}>
                      {i.mc_atual?.pct != null ? `${i.mc_atual.pct.toFixed(1).replace(".", ",")}%` : "—"}
                      {i.mc_atual?.reais != null && <span className="block text-[10px] font-normal text-muted-foreground">{formatBRL(i.mc_atual.reais)}</span>}
                    </td>
                    {FAIXAS.map((f) => {
                      const v = i.preco_por_mc?.[f.v] ?? null;
                      const acima = v != null && i.preco_cheio != null && v >= i.preco_cheio;
                      return <td key={f.v} className={cn("px-2 py-1.5 text-right tabular-nums", acima && "text-muted-foreground line-through")} title={acima ? "acima do preço cheio: não dá oferta nessa margem" : ""}>{v != null ? formatBRL(v) : "—"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border p-4 flex flex-col gap-2">
        <div className="text-sm font-semibold">Cupom e oferta relâmpago — só no Seller Central</div>
        <p className="text-[12.5px] text-muted-foreground">
          A Amazon não deixa criar cupom, oferta relâmpago nem desconto Prime pela API. Selecione os produtos na tabela e use
          "Copiar para o Seller Central" (SKU, ASIN, preço cheio e o preço que dá MC de 15%); depois abra a tela certa:
        </p>
        <div className="flex gap-2 flex-wrap">
          {ATALHOS.map((a) => (
            <Button key={a.nome} asChild size="sm" variant="outline" className="h-8 gap-1.5">
              <a href={a.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> {a.nome}</a>
            </Button>
          ))}
        </div>
      </div>

      {dialogo && (
        <OfertaDialog conta={conta} itens={selecionados} remover={dialogo === "remover"}
          onFechar={(feito) => { setDialogo(null); if (feito) { setSel(new Set()); void qc.invalidateQueries({ queryKey: ["promo-amazon", "catalogo", conta] }); } }} />
      )}
    </div>
  );
}

/** Promoções da conta (Promotions API); expandir mostra os produtos com o preço da promoção. */
function Promocoes({ conta }: { conta: Conta }) {
  const [verEncerradas, setVerEncerradas] = useState(false);
  const [aberta, setAberta] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["promo-amazon", "promocoes", conta],
    queryFn: () => chamar<{ promocoes: Promo[] }>({ modulo: "promocoes", conta }),
    staleTime: 5 * 60 * 1000,
  });
  const todas = (q.data?.promocoes ?? []).slice().sort((a, z) => String(z.schedule?.endDate ?? "").localeCompare(String(a.schedule?.endDate ?? "")));
  const ativas = todas.filter((p) => !["EXPIRED", "CANCELED", "CANCELLED"].includes(p.status));
  const lista = verEncerradas ? todas : ativas;
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b">
        <div>
          <div className="text-sm font-semibold">Promoções na Amazon {q.data && <span className="text-muted-foreground font-normal">({ativas.length} ativas · {todas.length} no total)</span>}</div>
          <div className="text-[11.5px] text-muted-foreground">Criadas no Seller Central. Clique para ver os produtos e o preço de cada um.</div>
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setVerEncerradas((v) => !v)}>{verEncerradas ? "Só as ativas" : "Ver encerradas"}</Button>
      </div>
      {q.isLoading ? <div className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Lendo promoções…</div>
        : q.error ? <div className="p-4 text-sm text-red-600">Erro: {(q.error as Error).message}</div>
        : lista.length === 0 ? <div className="p-4 text-sm text-muted-foreground">Nenhuma promoção {verEncerradas ? "" : "ativa "}nesta conta.</div>
        : (
          <div className="divide-y">
            {lista.map((p) => {
              const st = ST[p.status] ?? { rotulo: p.status, cor: "#64748B" };
              return (
                <Fragment key={p.promotionId}>
                  <button className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent/40 text-[12.5px]" onClick={() => setAberta(aberta === p.promotionId ? null : p.promotionId)}>
                    <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", aberta === p.promotionId && "rotate-90")} />
                    <span className="font-medium flex-1 truncate">{p.promotionTitle || "(sem nome)"}</span>
                    <span className="text-muted-foreground">{TIPO[p.promotionType] ?? p.promotionType}</span>
                    <span className="text-muted-foreground tabular-nums">{dataBR(p.schedule?.startDate)} → {dataBR(p.schedule?.endDate)}</span>
                    <span className="text-[11px] font-semibold" style={{ color: st.cor }}>{st.rotulo}</span>
                  </button>
                  {aberta === p.promotionId && <ItensDaPromocao conta={conta} id={p.promotionId} />}
                </Fragment>
              );
            })}
          </div>
        )}
    </div>
  );
}

interface ItemPromo { asin: string | null; sku_amazon: string | null; sku: string | null; cmv: number | null; beneficio: string | null; preco: number | null; percentual: number | null; limite_unidades: number | null }
function ItensDaPromocao({ conta, id }: { conta: Conta; id: string }) {
  const q = useQuery({
    queryKey: ["promo-amazon", "selecao", conta, id],
    queryFn: async () => {
      const r = await chamar<{ itens: ItemPromo[] }>({ modulo: "selecao", conta, promocao: id });
      const com = r.itens.filter((x) => x.sku_amazon && x.preco);
      const sim = com.length ? await chamar<{ itens: { sku: string; preco: number; taxa: number | null; mc: Mc | null }[] }>({ modulo: "simular", conta, itens: com.map((x) => ({ sku: x.sku_amazon, preco: x.preco })) }) : { itens: [] };
      const mcDe = new Map(sim.itens.map((s) => [`${s.sku}|${s.preco}`, s]));
      return r.itens.map((x) => ({ ...x, sim: mcDe.get(`${x.sku_amazon}|${x.preco}`) ?? null }));
    },
    staleTime: 5 * 60 * 1000,
  });
  if (q.isLoading) return <div className="px-10 py-3 text-[12px] text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Lendo produtos e taxas…</div>;
  if (q.error) return <div className="px-10 py-3 text-[12px] text-red-600">Erro: {(q.error as Error).message}</div>;
  const lista = q.data ?? [];
  if (!lista.length) return <div className="px-10 py-3 text-[12px] text-muted-foreground">Sem produtos nesta promoção (ou a Amazon não devolveu a lista).</div>;
  return (
    <div className="px-10 py-2 bg-muted/20">
      <table className="w-full text-[12px]">
        <thead className="text-muted-foreground"><tr>
          <th className="text-left font-medium py-1">SKU Amazon</th><th className="text-left font-medium py-1">ASIN</th>
          <th className="text-right font-medium py-1">Preço na promoção</th><th className="text-right font-medium py-1">Limite (un.)</th>
          <th className="text-right font-medium py-1">Taxas</th><th className="text-right font-medium py-1">CMV</th><th className="text-right font-medium py-1">MC</th>
        </tr></thead>
        <tbody>
          {lista.map((x, k) => (
            <tr key={k} className="border-t">
              <td className="py-1 font-mono">{x.sku_amazon ?? "—"}{x.sku && x.sku !== x.sku_amazon ? <span className="text-muted-foreground font-sans"> · {x.sku}</span> : null}</td>
              <td className="py-1">{x.asin ?? "—"}</td>
              <td className="py-1 text-right tabular-nums">{x.preco != null ? formatBRL(x.preco) : x.percentual != null ? `${x.percentual}% off` : (x.beneficio ?? "—")}</td>
              <td className="py-1 text-right tabular-nums">{x.limite_unidades ?? "—"}</td>
              <td className="py-1 text-right tabular-nums">{x.sim?.taxa != null ? formatBRL(x.sim.taxa) : "—"}</td>
              <td className="py-1 text-right tabular-nums">{x.cmv != null ? formatBRL(x.cmv) : "—"}</td>
              <td className="py-1 text-right tabular-nums font-semibold" style={{ color: corPct(x.sim?.mc?.pct) }}>
                {x.sim?.mc?.pct != null ? `${x.sim.mc.pct.toFixed(1).replace(".", ",")}% · ${formatBRL(x.sim.mc.reais ?? 0)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Preço de oferta com início e fim (ou tirar a oferta): faixa de MC → preço por produto (editável) → conferir na Amazon → aplicar. */
function OfertaDialog({ conta, itens, remover, onFechar }: { conta: Conta; itens: ItemCat[]; remover: boolean; onFechar: (feito: boolean) => void }) {
  const [faixa, setFaixa] = useState("0.15");
  const datas = padraoDatas();
  const [inicio, setInicio] = useState(datas.inicio);
  const [fim, setFim] = useState(datas.fim);
  const sugerido = (i: ItemCat, f: string) => { const v = i.preco_por_mc?.[f] ?? null; return v != null && i.preco_cheio != null && v < i.preco_cheio ? v.toFixed(2).replace(".", ",") : ""; };
  const [precos, setPrecos] = useState<Record<string, string>>(() => Object.fromEntries(itens.map((i) => [i.sku_amazon, sugerido(i, "0.15")])));
  const [res, setRes] = useState<{ confirmar: boolean; resultados: ResOferta[] } | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "aplicando">("");
  const alvo = remover ? itens.filter((i) => i.oferta) : itens;
  const corpo = (confirmar: boolean) => remover
    ? { modulo: "remover-oferta", conta, skus: alvo.map((i) => i.sku_amazon), confirmar }
    : { modulo: "oferta", conta, confirmar, itens: alvo.map((i) => ({ sku: i.sku_amazon, preco: Number(String(precos[i.sku_amazon] ?? "").replace(/\./g, "").replace(",", ".")) || 0, inicio: brtIso(inicio), fim: brtIso(fim) })) };
  const aplicarFaixa = (f: string) => { setFaixa(f); setPrecos(Object.fromEntries(itens.map((i) => [i.sku_amazon, sugerido(i, f)]))); setRes(null); };
  const conferir = async () => {
    setOcupado("conferindo");
    try { setRes(await chamar<{ confirmar: boolean; resultados: ResOferta[] }>(corpo(false))); }
    catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message }); }
    finally { setOcupado(""); }
  };
  const prontos = (res?.resultados ?? []).filter((r) => !r.pendencias.length && r.validacao?.resultado === "VALID");
  const aplicar = async () => {
    const txt = remover ? `Tirar o preço de oferta de ${prontos.length} anúncio(s) na Amazon (${conta.toUpperCase()})?`
      : `Aplicar preço de oferta em ${prontos.length} anúncio(s) na Amazon (${conta.toUpperCase()}), de ${inicio.replace("T", " ")} até ${fim.replace("T", " ")}?\n\n${prontos.map((r) => `${r.sku}: ${formatBRL(r.preco_cheio ?? 0)} → ${formatBRL(r.preco ?? 0)} (MC ${r.mc?.pct ?? "?"}%)`).join("\n")}`;
    if (!window.confirm(txt)) return;
    setOcupado("aplicando");
    try {
      const r = await chamar<{ confirmar: boolean; resultados: ResOferta[] }>({ ...corpo(true), ...(remover ? { skus: prontos.map((x) => x.sku) } : { itens: (corpo(true) as { itens: { sku: string }[] }).itens.filter((x) => prontos.some((p) => p.sku === x.sku)) }) });
      setRes(r);
      const ok = r.resultados.filter((x) => x.aplicado && x.aplicado.status < 300 && !x.aplicado.problemas.length).length;
      toast.success(`${ok} de ${r.resultados.length} enviado(s) à Amazon`, { description: "A Amazon processa em alguns minutos — use \"Atualizar da Amazon\" para conferir." });
    } catch (e) { toast.error("Falha ao aplicar", { description: (e as Error).message }); }
    finally { setOcupado(""); }
  };
  const aplicado = !!res?.confirmar;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(aplicado); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{remover ? "Tirar preço de oferta" : "Preço de oferta na Amazon"} · {conta === "acz" ? "ACZ Pet" : "SVL Store"}</DialogTitle>
          <DialogDescription>
            {remover ? "O anúncio volta ao preço cheio." : "Preço promocional com início e fim, anúncio a anúncio (não é cupom nem oferta relâmpago)."} A Amazon confere cada anúncio antes; nada muda até você aplicar.
          </DialogDescription>
        </DialogHeader>
        {!remover && (
          <div className="flex items-end gap-3 flex-wrap text-[12.5px]">
            <div>
              <div className="text-muted-foreground mb-1">Preço pela margem de contribuição</div>
              <div className="flex gap-1">{FAIXAS.map((f) => <Button key={f.v} size="sm" className="h-7" variant={faixa === f.v ? "default" : "outline"} onClick={() => aplicarFaixa(f.v)}>MC {f.r}</Button>)}</div>
            </div>
            <label>Início (Brasília)<Input type="datetime-local" className="h-8 mt-1" value={inicio} onChange={(e) => { setInicio(e.target.value); setRes(null); }} /></label>
            <label>Fim (Brasília)<Input type="datetime-local" className="h-8 mt-1" value={fim} onChange={(e) => { setFim(e.target.value); setRes(null); }} /></label>
          </div>
        )}
        <div className="max-h-[50vh] overflow-auto rounded border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/50 text-muted-foreground sticky top-0"><tr>
              <th className="text-left font-medium px-2 py-1.5">Anúncio</th><th className="text-right font-medium px-2 py-1.5">Cheio</th>
              {!remover && <th className="text-right font-medium px-2 py-1.5">Oferta (R$)</th>}
              <th className="text-right font-medium px-2 py-1.5">Taxas</th><th className="text-right font-medium px-2 py-1.5">MC</th><th className="text-left font-medium px-2 py-1.5">Conferência</th>
            </tr></thead>
            <tbody>
              {alvo.map((i) => {
                const r = res?.resultados.find((x) => x.sku === i.sku_amazon);
                return (
                  <tr key={i.sku_amazon} className="border-t">
                    <td className="px-2 py-1.5"><div className="font-mono">{i.sku_amazon}</div><div className="text-muted-foreground truncate max-w-[260px]">{i.titulo}</div></td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.preco_cheio != null ? formatBRL(i.preco_cheio) : "—"}</td>
                    {!remover && <td className="px-2 py-1.5 text-right"><Input className="h-7 w-24 ml-auto text-right" value={precos[i.sku_amazon] ?? ""} onChange={(e) => { setPrecos((p) => ({ ...p, [i.sku_amazon]: e.target.value })); setRes(null); }} /></td>}
                    <td className="px-2 py-1.5 text-right tabular-nums">{r?.taxa != null ? formatBRL(r.taxa) : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold" style={{ color: corPct(r?.mc?.pct) }}>{r?.mc?.pct != null ? `${r.mc.pct.toFixed(1).replace(".", ",")}%` : "—"}</td>
                    <td className="px-2 py-1.5">
                      {!r ? <span className="text-muted-foreground">—</span>
                        : r.aplicado ? <span className={r.aplicado.status < 300 && !r.aplicado.problemas.length ? "text-emerald-600" : "text-red-600"}>{r.aplicado.status < 300 && !r.aplicado.problemas.length ? `enviado (${r.aplicado.resultado ?? "ok"})` : r.aplicado.problemas[0] ?? `erro ${r.aplicado.status}`}</span>
                        : r.pendencias.length ? <span className="text-red-600">{r.pendencias[0]}</span>
                        : <span className="text-emerald-600">a Amazon aceita</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onFechar(aplicado)}>Fechar</Button>
          {!aplicado && <Button variant="outline" onClick={conferir} disabled={!!ocupado || !alvo.length}>{ocupado === "conferindo" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Conferir na Amazon</Button>}
          {!aplicado && <Button onClick={aplicar} disabled={!!ocupado || !prontos.length}>{ocupado === "aplicando" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {remover ? "Tirar oferta" : "Aplicar"} ({prontos.length})</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
