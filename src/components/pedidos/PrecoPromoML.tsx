// Pedidos Integrados › "Preço e promoção" › Mercado Livre (18/nov/2026, pedido do dono).
// Para o SKU do pedido mostra os anúncios dele no Mercado Livre (conta Ottz — a única com as promoções
// espelhadas), a promoção em que cada um está e as que ainda pode entrar, com a margem de contribuição
// calculada no banco (view_ml_promocoes). As escritas são as MESMAS da tela Promoções › Mercado Livre
// (DialogoAcaoML): mudar o desconto de quem já está numa campanha tradicional, escolher o desconto ao
// entrar, tirar da promoção — sempre com a conferência ao vivo e a confirmação.
// O pedido do ML não diz de qual anúncio (MLB) saiu a venda: a tela lista todos os anúncios ativos do SKU.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CirclePlus, ExternalLink, Loader2, Percent, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePerfil } from "@/hooks/usePerfil";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import {
  COLS_ITEM_ML, DialogoAcaoML, descDe, escolheDesconto, pctTxtDe, podeMudarDesconto, tipoDe,
  type Item, type TipoAcao,
} from "@/components/promocoes/MercadoLivrePromo";

interface Anuncio {
  mlb: string; titulo: string | null; foto: string | null; permalink: string | null;
  preco: number | null; preco_original: number | null; estoque: number | null; logistic_type: string | null; catalog_listing: boolean | null;
}

const n = (x: unknown) => { const v = Number(x ?? 0); return Number.isFinite(v) ? v : 0; };
const corMc = (pct: number | null) => (pct == null ? "text-muted-foreground" : pct < 0 ? "text-red-600" : pct < 0.1 ? "text-amber-600" : "text-emerald-600");
const pct1 = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1).replace(".", ",")}%`);
const mediana = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

function Mc({ v, pct }: { v: number | null; pct: number | null }) {
  if (v == null) return <span className="text-xs text-muted-foreground">MC —</span>;
  return <span className={`text-xs font-medium tabular-nums ${corMc(pct)}`}>MC {formatBRL(n(v))}{pct != null ? ` (${pct1(n(pct))})` : ""}</span>;
}

export function PrecoPromoML({ sku }: { sku: string }) {
  const qc = useQueryClient();
  const quem = usePerfil().perfil?.nome ?? null;
  const [acao, setAcao] = useState<{ item: Item; tipo: TipoAcao } | null>(null);
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const chave = ["pedido-preco-ml", sku];

  const q = useQuery({
    queryKey: chave, staleTime: 60_000, placeholderData: undefined,
    queryFn: async () => {
      const [p, a] = await Promise.all([
        supabaseExternal.from("view_ml_promocoes").select(COLS_ITEM_ML).eq("sku", sku),
        supabaseExternal.from("ml_anuncios").select("mlb, titulo, foto, permalink, preco, preco_original, estoque, logistic_type, catalog_listing").eq("sku", sku).eq("status", "active"),
      ]);
      if (p.error) throw p.error;
      if (a.error) throw a.error;
      return { itens: (p.data ?? []) as unknown as Item[], anuncios: (a.data ?? []) as Anuncio[] };
    },
  });

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />Lendo os anúncios e as promoções do Mercado Livre…</div>;
  if (q.isError) return <div className="text-sm text-red-600">Não consegui ler as promoções do Mercado Livre: {(q.error as Error).message}</div>;
  const itens = q.data?.itens ?? [], anuncios = q.data?.anuncios ?? [];

  // faixa de desconto das campanhas (o ML não informa a faixa de quem já entrou): mediana dos candidatos da mesma campanha
  const faixaEstDe = (i: Item) => {
    const cand = itens.filter((x) => x.promocao_id === i.promocao_id && escolheDesconto(x));
    const c = n(i.original_price);
    const rMin = mediana(cand.map((x) => n(x.preco_min) / n(x.original_price))) ?? 0.2;
    const rMax = mediana(cand.map((x) => n(x.preco_max) / n(x.original_price))) ?? 0.97;
    return { min: Math.round(c * rMin * 100) / 100, max: Math.round(c * rMax * 100) / 100 };
  };

  if (acao) {
    return (
      <DialogoAcaoML embutido key={`${acao.item.promocao_id}|${acao.item.mlb}|${acao.tipo}`} acao={acao} nomeUsuario={quem}
        faixaEst={acao.tipo === "mudar" ? faixaEstDe(acao.item) : null}
        onFechar={() => setAcao(null)}
        onResultado={() => { void qc.invalidateQueries({ queryKey: chave }); void qc.invalidateQueries({ queryKey: ["promocoes-ml"] }); }} />
    );
  }

  const mlbs = [...new Set([...anuncios.map((a) => a.mlb), ...itens.map((i) => i.mlb)])];
  if (!mlbs.length) {
    return (
      <div className="space-y-2 text-sm">
        <p>Não achei anúncio ativo deste SKU no Mercado Livre (conta Ottz), nem promoção disponível para ele.</p>
        <Button asChild size="sm" variant="outline"><Link to="/promocoes" search={{ mkt: "ml" } as never} target="_blank">Abrir Promoções do Mercado Livre <ExternalLink className="h-3.5 w-3.5 ml-1" /></Link></Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {mlbs.map((mlb) => {
        const an = anuncios.find((a) => a.mlb === mlb) ?? null;
        const doMlb = itens.filter((i) => i.mlb === mlb);
        const dentro = doMlb.filter((i) => i.status === "started");
        const cand = doMlb.filter((i) => i.status !== "started").sort((a, z) => n(z.mc_promo) - n(a.mc_promo));
        const ref = doMlb[0] ?? null;
        const cheio = n(ref?.original_price ?? an?.preco_original ?? an?.preco);
        const aberto = abertos.has(mlb);
        const full = (an?.logistic_type ?? ref?.logistic_type) === "fulfillment";
        return (
          <div key={mlb} className="rounded-lg border bg-card">
            <div className="flex items-center gap-3 p-3 border-b">
              {(an?.foto ?? ref?.foto) ? <img src={(an?.foto ?? ref?.foto)!} alt="" className="h-11 w-11 rounded-md object-cover border" /> : <div className="h-11 w-11 rounded-md bg-muted" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{an?.titulo ?? ref?.titulo ?? mlb}</div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground font-mono">
                  <span>{mlb}</span><span>SKU {sku}</span>
                  {full && <Badge variant="outline" className="h-4 px-1 text-[10px] font-sans">Full</Badge>}
                  {an?.catalog_listing && <Badge variant="outline" className="h-4 px-1 text-[10px] font-sans">catálogo</Badge>}
                  {an?.estoque != null && <span className="font-sans">{an.estoque} em estoque</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-muted-foreground">preço cheio</div>
                <div className="text-sm font-semibold tabular-nums">{cheio ? formatBRL(cheio) : "—"}</div>
              </div>
              {(an?.permalink ?? ref?.permalink) && (
                <a href={(an?.permalink ?? ref?.permalink)!} target="_blank" rel="noopener noreferrer" title="Abrir o anúncio no Mercado Livre" className="text-muted-foreground hover:text-foreground"><ExternalLink className="h-4 w-4" /></a>
              )}
            </div>

            <div className="p-3 space-y-2">
              {dentro.length === 0 && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Badge variant="secondary">Fora de promoção</Badge>
                  <span className="text-muted-foreground">vende pelo preço cheio</span>
                  {ref && <Mc v={ref.mc_atual} pct={ref.mc_atual_pct} />}
                </div>
              )}
              {dentro.map((i) => {
                const [tNome] = tipoDe(i.promocao_tipo);
                const d = descDe(i.promo_price, i.original_price);
                return (
                  <div key={i.promocao_id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Badge className="bg-emerald-600 hover:bg-emerald-600">Na promoção</Badge>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{i.promocao_nome ?? tNome}</div>
                      <div className="text-[11px] text-muted-foreground">{tNome}{i.meli_percentage ? ` · ML banca ${n(i.meli_percentage).toFixed(0)}%` : ""}</div>
                    </div>
                    <div className="flex-1" />
                    <div className="text-sm tabular-nums">
                      <span className="text-muted-foreground line-through mr-1.5">{formatBRL(n(i.original_price))}</span>
                      <b>{formatBRL(n(i.promo_price))}</b>{d != null && d > 0.05 && <span className="text-muted-foreground"> (−{pctTxtDe(d)}%)</span>}
                    </div>
                    <Mc v={i.mc_promo} pct={i.mc_promo_pct} />
                    {podeMudarDesconto(i)
                      ? <Button size="sm" className="h-8 gap-1.5" onClick={() => setAcao({ item: i, tipo: "mudar" })}><Percent className="h-3.5 w-3.5" />Mudar desconto</Button>
                      : <span className="text-[11px] text-muted-foreground max-w-[150px]" title="O Mercado Livre define o preço desta promoção: só dá para sair dela.">preço definido pelo Mercado Livre</span>}
                    <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setAcao({ item: i, tipo: "remover" })}><Trash2 className="h-3.5 w-3.5" />Tirar</Button>
                  </div>
                );
              })}

              {cand.length > 0 && (
                <div className="pt-1">
                  <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setAbertos((s) => { const z = new Set(s); if (z.has(mlb)) z.delete(mlb); else z.add(mlb); return z; })}>
                    {aberto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {cand.length} {cand.length === 1 ? "promoção disponível" : "promoções disponíveis"} para este anúncio
                  </button>
                  {aberto && (
                    <div className="mt-2 space-y-1.5">
                      {dentro.length > 0 && <p className="text-[11px] text-muted-foreground">Este anúncio já está numa promoção. Para trocar por outra, use a tela de Promoções (ela sai de uma e entra na outra, e volta se a nova recusar).</p>}
                      {cand.map((i) => {
                        const [tNome] = tipoDe(i.promocao_tipo);
                        const escolhe = escolheDesconto(i);
                        const d = descDe(i.promo_price, i.original_price);
                        const pode = dentro.length === 0 && i.mc_promo != null;
                        return (
                          <div key={i.promocao_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5">
                            <div className="min-w-0">
                              <div className="text-sm truncate">{i.promocao_nome ?? tNome}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {tNome}{escolhe ? ` · você escolhe: ${pctTxtDe(descDe(i.preco_max, i.original_price))}% a ${pctTxtDe(descDe(i.preco_min, i.original_price))}%` : " · preço fixo do Mercado Livre"}
                                {i.meli_percentage ? ` · ML banca ${n(i.meli_percentage).toFixed(0)}%` : ""}
                              </div>
                            </div>
                            <div className="flex-1" />
                            <div className="text-sm tabular-nums"><b>{formatBRL(n(i.promo_price))}</b>{d != null && d > 0.05 && <span className="text-muted-foreground"> (−{pctTxtDe(d)}%{escolhe ? ", sugerido" : ""})</span>}</div>
                            <Mc v={i.mc_promo} pct={i.mc_promo_pct} />
                            {pode
                              ? <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setAcao({ item: i, tipo: "aplicar" })}>{escolhe ? <Percent className="h-3.5 w-3.5" /> : <CirclePlus className="h-3.5 w-3.5" />}{escolhe ? "Escolher desconto" : "Aplicar"}</Button>
                              : dentro.length === 0 ? <span className="text-[11px] text-muted-foreground">sem custo cadastrado</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>MC = margem de contribuição por unidade no preço da promoção (comissão, frete, imposto e custo), a mesma conta da tela de Promoções. O pedido do Mercado Livre não informa de qual anúncio saiu a venda, por isso aparecem todos os anúncios ativos do SKU.</span>
        <Link to="/promocoes" search={{ mkt: "ml" } as never} target="_blank" className="inline-flex items-center gap-1 underline">Abrir Promoções do Mercado Livre <ExternalLink className="h-3 w-3" /></Link>
      </div>
    </div>
  );
}
