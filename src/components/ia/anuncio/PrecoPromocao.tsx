import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { usePerfil } from "@/hooks/usePerfil";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import {
  calcMc, chamarPromocoes, corMc, Foto, LOJAS, num, tetoRelampago, tituloMc, traduzirErroShopee, useTarifaShopee,
  type McBase, type Tarifa,
} from "@/components/promocoes/comum";

// ============================================================================
// Aba "Preço e promoção" do anúncio (12/out/2026, pedido do dono) — começa pela SHOPEE.
// Para o SKU aberto mostra, por loja, os anúncios dele (e as variações), o preço atual, a
// margem de contribuição nesse preço e:
//   - as promoções "Minha Promoção" (descontos da loja) em que o anúncio está, com o preço
//     promocional EDITÁVEL — mesma chamada da tela Promoções (`shopee-promocoes
//     ?modulo=atualizar-itens`, com `propagar=1`: se o desconto é de uma promoção diária, os
//     dias seguintes acompanham);
//   - a OFERTA RELÂMPAGO diária: o preço fica em `flashsale_programacao` e vale para as
//     próximas relâmpagos que o app cria (a de hoje, já criada na Shopee, não muda — a API
//     não deixa trocar o preço de item que já está numa relâmpago).
// A MC usa a mesma regra da tela Promoções (`promo_mc_base` + tabela de comissão vigente).
// Nada aqui muda o preço CHEIO do anúncio: isso é no envio do anúncio.
// ============================================================================

interface Linha {
  item_id: number; model_id: number; sku: string; anuncio: string; opcao: string; status: string | null; imagem: string | null;
  preco: number; cheio: number; estoque: number | null;
}
interface ModeloApi { model_id: number; model_original_price?: number; model_promotion_price?: number }
interface ItemApi { item_id: number; purchase_limit?: number; item_original_price?: number; item_promotion_price?: number; model_list?: ModeloApi[] }
interface Desconto { discount_id: number; discount_name: string; start_time: number; end_time: number; status?: string }
interface EmDesconto { desconto: Desconto; item: ItemApi }
interface Programada { id: string; item_id: number; model_id: number; preco_promo: number; ativo: boolean }

const brl = (v: number) => formatBRL(v);
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const dia = (seg: number) => new Date(seg * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const COLS_ANUNCIO = "item_id, nome, status, sku_pai, tem_variacao, preco_min, preco_max, estoque_total, imagem_url";

export function PrecoPromocao({ sku, empresa }: { sku: string; empresa: string }) {
  // a loja da tela vem primeiro; a outra aparece logo abaixo
  const lojas = [...LOJAS].sort((a, z) => Number(z.shop_id === (empresa === "svl" ? 759046323 : 522186766)) - Number(a.shop_id === (empresa === "svl" ? 759046323 : 522186766)));
  return (
    <div className="space-y-4">
      {lojas.map((l) => <Loja key={l.shop_id} sku={sku} shopId={l.shop_id} nome={l.nome} />)}
      <p className="text-[11px] text-muted-foreground">
        Mercado Livre, Amazon e TikTok entram depois — por enquanto as promoções deles continuam nas telas próprias.
      </p>
    </div>
  );
}

function Loja({ sku, shopId, nome }: { sku: string; shopId: number; nome: string }) {
  const qc = useQueryClient();
  const tarifa = useTarifaShopee().data;
  const quem = usePerfil().perfil?.nome ?? null;
  const chave = ["ia-anuncio", "preco-promo", sku, shopId];

  // 1) anúncios e variações deste SKU no espelho, base de MC e programação da relâmpago
  const baseQ = useQuery({
    queryKey: chave,
    queryFn: async () => {
      const [a, v] = await Promise.all([
        supabaseExternal.from("shopee_anuncios").select(COLS_ANUNCIO).eq("shop_id", shopId).eq("sku_pai", sku).in("status", ["NORMAL", "UNLIST"]),
        supabaseExternal.from("shopee_anuncios_variacao").select("item_id, model_id, sku, nome_variacao, preco, preco_original, estoque").eq("shop_id", shopId).eq("sku", sku),
      ]);
      if (a.error) throw a.error;
      const doSku = (a.data ?? []) as any[];
      const idsDoSku = new Set(doSku.map((x) => Number(x.item_id)));
      const soVariacao = ((v.data ?? []) as any[]).filter((x) => !idsDoSku.has(Number(x.item_id)));
      const idsFora = [...new Set(soVariacao.map((x) => Number(x.item_id)))];
      const [pais, todas] = await Promise.all([
        idsFora.length ? supabaseExternal.from("shopee_anuncios").select(COLS_ANUNCIO).eq("shop_id", shopId).in("item_id", idsFora).in("status", ["NORMAL", "UNLIST"]) : Promise.resolve({ data: [] as any[] }),
        // anúncio cujo SKU principal é este produto: entram TODAS as variações dele
        idsDoSku.size ? supabaseExternal.from("shopee_anuncios_variacao").select("item_id, model_id, sku, nome_variacao, preco, preco_original, estoque").eq("shop_id", shopId).in("item_id", [...idsDoSku]) : Promise.resolve({ data: [] as any[] }),
      ]);
      const anuncios = new Map<number, any>([...doSku, ...((pais.data ?? []) as any[])].map((x) => [Number(x.item_id), x]));
      const linhas: Linha[] = [];
      const deVariacao = (x: any): Linha | null => {
        const an = anuncios.get(Number(x.item_id));
        if (!an) return null;
        return {
          item_id: Number(x.item_id), model_id: Number(x.model_id), sku: String(x.sku ?? ""), anuncio: an.nome ?? "", opcao: String(x.nome_variacao ?? ""),
          status: an.status, imagem: an.imagem_url, preco: num(x.preco), cheio: num(x.preco_original) || num(x.preco), estoque: x.estoque == null ? null : num(x.estoque),
        };
      };
      for (const an of doSku) {
        const vs = ((todas.data ?? []) as any[]).filter((x) => Number(x.item_id) === Number(an.item_id));
        if (vs.length) { for (const x of vs) { const l = deVariacao(x); if (l) linhas.push(l); } continue; }
        linhas.push({
          item_id: Number(an.item_id), model_id: 0, sku, anuncio: an.nome ?? "", opcao: "", status: an.status, imagem: an.imagem_url,
          preco: num(an.preco_min), cheio: num(an.preco_max) || num(an.preco_min), estoque: an.estoque_total == null ? null : num(an.estoque_total),
        });
      }
      for (const x of soVariacao) { const l = deVariacao(x); if (l) linhas.push(l); }
      linhas.sort((p, q) => p.item_id - q.item_id || p.preco - q.preco);

      const skus = [...new Set(linhas.map((l) => l.sku).filter(Boolean))];
      const ids = [...new Set(linhas.map((l) => l.item_id))];
      const [mc, prog, cfg, nomes] = await Promise.all([
        skus.length ? supabaseExternal.rpc("promo_mc_base", { p_shop_id: shopId, p_skus: skus }) : Promise.resolve({ data: [] }),
        ids.length ? supabaseExternal.from("flashsale_programacao").select("id, item_id, model_id, preco_promo, ativo").eq("shop_id", shopId).in("item_id", ids) : Promise.resolve({ data: [] }),
        supabaseExternal.from("flashsale_config").select("automacao_ativa").eq("shop_id", shopId).maybeSingle(),
        skus.length ? supabaseExternal.from("produtos").select("sku, nome").in("sku", skus) : Promise.resolve({ data: [] }),
      ]);
      return {
        linhas, ids,
        bases: new Map(((mc.data ?? []) as McBase[]).map((b) => [b.sku, b])),
        programadas: ((prog.data ?? []) as any[]).map((p) => ({ id: String(p.id), item_id: Number(p.item_id), model_id: Number(p.model_id), preco_promo: num(p.preco_promo), ativo: !!p.ativo })) as Programada[],
        automacao: !!(cfg.data as any)?.automacao_ativa,
        nomes: new Map(((nomes.data ?? []) as { sku: string; nome: string | null }[]).map((p) => [p.sku, p.nome ?? ""])),
      };
    },
  });
  const ids = baseQ.data?.ids ?? [];

  // 2) em quais descontos da loja (em andamento e programados) estes anúncios estão — lido ao vivo na Shopee
  const descQ = useQuery({
    queryKey: [...chave, "descontos", ids.join(",")],
    enabled: ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ achados: EmDesconto[]; lidos: number; total: number; erro: string | null }> => {
      const descontos: Desconto[] = []; let erro: string | null = null;
      for (const status of ["ongoing", "upcoming"]) {
        const r = await chamarPromocoes(`modulo=list&shop_id=${shopId}&status=${status}`);
        if (r.erro) erro = typeof r.erro === "string" ? r.erro : r.erro?.message ?? "erro da Shopee";
        for (const d of (r.descontos ?? []) as Desconto[]) descontos.push({ ...d, status });
      }
      const alvo = new Set(ids);
      const achados: EmDesconto[] = []; let lidos = 0;
      for (const d of descontos.slice(0, 15)) {
        const r = await chamarPromocoes(`modulo=detalhe&shop_id=${shopId}&discount_id=${d.discount_id}`);
        lidos++;
        for (const it of (r.itens ?? []) as ItemApi[]) if (alvo.has(Number(it.item_id))) achados.push({ desconto: d, item: it });
      }
      return { achados, lidos, total: descontos.length, erro };
    },
  });

  if (baseQ.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Shopee · {nome}…</CardContent></Card>;
  if (baseQ.isError) return <Card><CardContent className="p-4 text-sm text-destructive">Shopee · {nome}: {(baseQ.error as Error).message}</CardContent></Card>;
  const d = baseQ.data!;
  const recarregar = () => { void qc.invalidateQueries({ queryKey: chave }); };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Shopee · {nome}</h2>
          <span className="text-xs text-muted-foreground">{d.linhas.length ? `${d.ids.length} anúncio(s)` : "sem anúncio deste SKU nesta loja"}</span>
          <div className="flex-1" />
          {descQ.isFetching && <span className="text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin inline mr-1" />lendo as promoções na Shopee…</span>}
          {d.linhas.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" disabled={descQ.isFetching} onClick={() => { recarregar(); void descQ.refetch(); }}>
              <RefreshCw className="h-3.5 w-3.5" />Atualizar
            </Button>
          )}
        </div>
        {descQ.data?.erro && <p className="text-xs text-destructive">Promoções: {descQ.data.erro}</p>}
        {descQ.isError && <p className="text-xs text-destructive">Promoções: {(descQ.error as Error).message}</p>}
        {descQ.data && descQ.data.total > descQ.data.lidos && (
          <p className="text-[11px] text-amber-600">A loja tem {descQ.data.total} descontos abertos; li os {descQ.data.lidos} primeiros.</p>
        )}

        {d.linhas.map((l) => (
          <LinhaPreco key={`${l.item_id}-${l.model_id}`} l={l} shopId={shopId} base={d.bases.get(l.sku)} tarifa={tarifa} nomeSku={d.nomes.get(l.sku) ?? ""}
            descontos={(descQ.data?.achados ?? []).filter((x) => Number(x.item.item_id) === l.item_id)} lendo={descQ.isLoading}
            programada={d.programadas.find((p) => p.item_id === l.item_id && p.model_id === l.model_id) ?? null} automacao={d.automacao}
            quem={quem} onMudou={() => { recarregar(); void descQ.refetch(); }} />
        ))}
      </CardContent>
    </Card>
  );
}

function SeloMc({ base, preco, tarifa }: { base: McBase | undefined; preco: number; tarifa: Tarifa[] | undefined }) {
  const mc = calcMc(base, preco, tarifa);
  if (!mc) return <span className="text-[11px] text-muted-foreground" title={tituloMc(base, mc)}>MC —</span>;
  return (
    <span className="text-[11.5px] font-medium tabular-nums" style={{ color: corMc(mc.pct) }} title={tituloMc(base, mc)}>
      MC {brl(mc.mc)} · {(mc.pct * 100).toFixed(1).replace(".", ",")}%
    </span>
  );
}

function LinhaPreco({ l, shopId, base, tarifa, nomeSku, descontos, lendo, programada, automacao, quem, onMudou }: {
  l: Linha; shopId: number; base: McBase | undefined; tarifa: Tarifa[] | undefined; nomeSku: string; descontos: EmDesconto[]; lendo: boolean;
  programada: Programada | null; automacao: boolean; quem: string | null; onMudou: () => void;
}) {
  const teto = tetoRelampago(l.preco, base?.menor_preco_7d);
  return (
    <div className="rounded-lg border p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <Foto url={l.imagem} size={40} />
        <div className="min-w-0 flex-1 basis-[240px]">
          <div className="truncate text-sm font-medium" title={l.anuncio}>{l.anuncio || `Anúncio ${l.item_id}`}</div>
          <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-1.5">
            <span className="font-mono">{l.sku}</span>
            {l.model_id > 0 && <span className="truncate max-w-[280px]" title={nomeSku}>· {nomeSku || `variação ${l.opcao}`}</span>}
            {l.status === "UNLIST" && <Badge variant="outline" className="text-[9.5px] py-0 px-1">fora do ar</Badge>}
            <a className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline" target="_blank" rel="noreferrer"
              href={`https://shopee.com.br/product/${shopId}/${l.item_id}`}>ver<ExternalLink className="h-3 w-3" /></a>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">{brl(l.preco)}</div>
          {l.cheio > l.preco + 0.005 && <div className="text-[11px] text-muted-foreground line-through tabular-nums">{brl(l.cheio)}</div>}
        </div>
        <div className="w-[150px] text-right"><SeloMc base={base} preco={l.preco} tarifa={tarifa} /><div className="text-[10.5px] text-muted-foreground">no preço de hoje</div></div>
        <div className="w-[70px] text-right text-xs text-muted-foreground">{l.estoque != null ? `${l.estoque} un.` : "—"}</div>
      </div>

      {/* Minha Promoção (descontos da loja) */}
      {lendo && <div className="text-[11px] text-muted-foreground pl-[52px]">procurando as promoções deste anúncio…</div>}
      {!lendo && descontos.length === 0 && <div className="text-[11px] text-muted-foreground pl-[52px]">Fora das promoções da loja (em andamento ou programadas).</div>}
      {descontos.map((x) => (
        <EditarDesconto key={x.desconto.discount_id} x={x} l={l} shopId={shopId} base={base} tarifa={tarifa} onMudou={onMudou} />
      ))}

      {/* Oferta relâmpago diária */}
      <EditarRelampago l={l} shopId={shopId} base={base} tarifa={tarifa} programada={programada} automacao={automacao} teto={teto} quem={quem} onMudou={onMudou} />
    </div>
  );
}

function EditarDesconto({ x, l, shopId, base, tarifa, onMudou }: {
  x: EmDesconto; l: Linha; shopId: number; base: McBase | undefined; tarifa: Tarifa[] | undefined; onMudou: () => void;
}) {
  const modelo = l.model_id > 0 ? (x.item.model_list ?? []).find((m) => Number(m.model_id) === l.model_id) : null;
  const atual = l.model_id > 0 ? num(modelo?.model_promotion_price) : num(x.item.item_promotion_price);
  const cheio = l.model_id > 0 ? num(modelo?.model_original_price) || l.cheio : num(x.item.item_original_price) || l.cheio;
  const [txt, setTxt] = useState("");
  const [salvando, setSalvando] = useState(false);
  // variação que não está neste desconto: nada a editar
  if (l.model_id > 0 && !modelo) return null;
  const novo = txt.trim() ? paraNumero(txt) : atual;
  const mudou = txt.trim() !== "" && Math.abs(novo - atual) > 0.004;
  const invalido = mudou && (!(novo > 0) || novo >= cheio);

  async function aplicar() {
    const mcNova = calcMc(base, novo, tarifa);
    if (!window.confirm(`Mudar na Shopee o preço desta promoção?\n\n${x.desconto.discount_name}\n${l.sku}: ${brl(atual)} → ${brl(novo)}${mcNova ? `\nMC estimada ${brl(mcNova.mc)} (${(mcNova.pct * 100).toFixed(1).replace(".", ",")}%)` : ""}\n\nSe for uma promoção diária, os próximos dias acompanham.`)) return;
    setSalvando(true);
    try {
      const lim = num(x.item.purchase_limit);
      // o anúncio vai inteiro (todas as variações do desconto); só a alterada muda de preço
      const item = (x.item.model_list ?? []).length
        ? { item_id: x.item.item_id, purchase_limit: lim, model_list: (x.item.model_list ?? []).map((m) => ({ model_id: m.model_id, model_promotion_price: Number(m.model_id) === l.model_id ? novo : num(m.model_promotion_price) })) }
        : { item_id: x.item.item_id, purchase_limit: lim, item_promotion_price: novo };
      const r = await chamarPromocoes(`modulo=atualizar-itens&shop_id=${shopId}&discount_id=${x.desconto.discount_id}&confirmar=1&propagar=1`, { item_list: [item] });
      const recusas = ((r.response?.error_list ?? []) as { model_id?: number; fail_message?: string; fail_error?: string }[]);
      const erroGeral = r.erro ? (typeof r.erro === "string" ? r.erro : `${r.erro.error ?? ""} ${r.erro.message ?? ""}`.trim()) : "";
      if (erroGeral || recusas.length) {
        toast.error("A Shopee não aceitou", { description: traduzirErroShopee(erroGeral || recusas.map((e) => e.fail_message ?? e.fail_error ?? "").join(" · ")), duration: 15000 });
      } else {
        const dias = (r.propagacao?.dias ?? []) as { falhas?: unknown[] }[];
        toast.success(`Promoção atualizada: ${brl(novo)}`, { description: dias.length ? `Também nos ${dias.length} próximos dia(s) da promoção diária.` : undefined });
        setTxt(""); onMudou();
      }
    } catch (e) { toast.error("Não consegui atualizar a promoção", { description: (e as Error).message, duration: 12000 }); }
    finally { setSalvando(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pl-[52px]">
      <Badge variant="secondary" className="text-[10px] py-0 px-1.5">{x.desconto.status === "upcoming" ? "programada" : "em andamento"}</Badge>
      <div className="min-w-0 flex-1 basis-[200px]">
        <div className="truncate text-xs font-medium" title={x.desconto.discount_name}>{x.desconto.discount_name}</div>
        <div className="text-[10.5px] text-muted-foreground">{dia(x.desconto.start_time)} → {dia(x.desconto.end_time)} · hoje {brl(atual)}</div>
      </div>
      <Input className="h-8 w-[110px] text-right tabular-nums" inputMode="decimal" placeholder={atual.toFixed(2).replace(".", ",")} value={txt} disabled={salvando}
        onChange={(e) => setTxt(e.target.value)} />
      <div className="w-[150px] text-right"><SeloMc base={base} preco={novo} tarifa={tarifa} /></div>
      <Button size="sm" className="h-8" disabled={!mudou || invalido || salvando} onClick={() => void aplicar()}
        title={invalido ? `O preço da promoção precisa ser menor que o preço cheio (${brl(cheio)})` : undefined}>
        {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : "Aplicar"}
      </Button>
    </div>
  );
}

function EditarRelampago({ l, shopId, base, tarifa, programada, automacao, teto, quem, onMudou }: {
  l: Linha; shopId: number; base: McBase | undefined; tarifa: Tarifa[] | undefined; programada: Programada | null; automacao: boolean;
  teto: { teto: number; motivo: string } | null; quem: string | null; onMudou: () => void;
}) {
  const atual = programada?.preco_promo ?? 0;
  const [txt, setTxt] = useState("");
  const [salvando, setSalvando] = useState(false);
  const sugerido = teto?.teto ?? 0;
  const novo = txt.trim() ? paraNumero(txt) : (programada ? atual : sugerido);
  const mudou = programada ? txt.trim() !== "" && Math.abs(novo - atual) > 0.004 : novo > 0;
  // mesma guarda do robô: preço relâmpago abaixo do preço de hoje e não menos que a metade dele
  const invalido = !(novo > 0) || novo >= l.preco || novo < l.preco * 0.5;

  async function salvar(ativo?: boolean) {
    setSalvando(true);
    try {
      const agora = new Date().toISOString();
      const r = programada
        ? await supabaseExternal.from("flashsale_programacao").update(ativo === undefined ? { preco_promo: novo, atualizado_em: agora } : { ativo, atualizado_em: agora }).eq("id", programada.id)
        : await supabaseExternal.from("flashsale_programacao").insert({
          shop_id: shopId, item_id: l.item_id, model_id: l.model_id, item_nome: l.anuncio, model_nome: l.opcao || null, sku: l.sku, imagem: l.imagem,
          preco_original: l.preco, preco_promo: novo, estoque_promo: 1000, ativo: true, criado_por: quem, atualizado_em: agora,
        });
      if (r.error) throw r.error;
      toast.success(ativo === undefined ? `Relâmpago diária: ${brl(novo)}` : ativo ? "Voltou para a relâmpago diária" : "Saiu da relâmpago diária", {
        description: ativo === false ? undefined : "Vale a partir da próxima relâmpago que o app criar (a de hoje não muda).",
      });
      setTxt(""); onMudou();
    } catch (e) { toast.error("Não consegui salvar", { description: (e as Error).message, duration: 12000 }); }
    finally { setSalvando(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pl-[52px]">
      <Badge variant="outline" className="text-[10px] py-0 px-1.5 gap-1"><Zap className="h-3 w-3" />relâmpago diária</Badge>
      <div className="min-w-0 flex-1 basis-[200px] text-[10.5px] text-muted-foreground">
        {programada
          ? <>{programada.ativo ? "na programação" : "pausada"} · hoje {brl(atual)}{!automacao && " · a criação automática desta loja está desligada"}</>
          : <>fora da programação{teto ? <> · sugestão {brl(teto.teto)} <span title={teto.motivo}>(teto estimado)</span></> : null}</>}
      </div>
      <Input className="h-8 w-[110px] text-right tabular-nums" inputMode="decimal" placeholder={(programada ? atual : sugerido).toFixed(2).replace(".", ",")} value={txt}
        disabled={salvando} onChange={(e) => setTxt(e.target.value)} />
      <div className="w-[150px] text-right"><SeloMc base={base} preco={novo} tarifa={tarifa} /></div>
      <Button size="sm" variant={programada ? "default" : "outline"} className="h-8" disabled={!mudou || invalido || salvando} onClick={() => void salvar()}
        title={invalido ? `O preço relâmpago precisa ficar abaixo do preço de hoje (${brl(l.preco)}) e não menos que a metade dele` : undefined}>
        {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : programada ? "Salvar" : "Pôr na relâmpago"}
      </Button>
      {programada && (
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={salvando} onClick={() => void salvar(!programada.ativo)}>
          {programada.ativo ? "Pausar" : "Reativar"}
        </Button>
      )}
    </div>
  );
}
