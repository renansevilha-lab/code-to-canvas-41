import { useEffect, useRef, useState } from "react";
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
// ============================================================================

const LOJA: Record<string, number> = { ottz: 522186766, svl: 759046323 };
export const FAIXAS_PROMO = [0.1, 0.15, 0.1725, 0.2];
const FAIXA_PADRAO = 0.1725;
const rotulo = (f: number) => `${(f * 100).toFixed(2).replace(/\.?0+$/, "").replace(".", ",")}%`;
const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const dia = (t: number) => new Date(t * 1000).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

interface Desconto { discount_id: number; discount_name: string; start_time: number; end_time: number; status: string }
interface Resultado { ok: number; falhas: string[]; nome: string }

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
  const skus = skusQ.data ?? [];
  const precosQ = useQuery({
    queryKey: ["ia-anuncio", "envio-promo-precos", empresa, faixa, skus.map((s) => s.sku).join(",")],
    enabled: skus.length > 0 && desconto != null,
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

  async function cadastrar(d: AnuncioPronto) {
    if (!desconto) return;
    const pulados: string[] = [];
    const vale = (s: string): number | null => {
      const promo = promoDe(s); const cheio = d.precos[s];
      if (!(promo && promo > 0)) { pulados.push(`${s}: sem preço promocional`); return null; }
      if (cheio != null && promo >= cheio) { pulados.push(`${s}: o promocional (${formatBRL(promo)}) não fica abaixo do preço cheio (${formatBRL(cheio)})`); return null; }
      return promo;
    };
    let item: Record<string, unknown> | null = null; let n = 0;
    if (d.modelos?.length) {
      const lista = d.modelos.map((m) => ({ model_id: m.model_id, sku: m.sku, promo: vale(m.sku) })).filter((x) => x.promo != null);
      n = lista.length;
      if (n) item = { item_id: Number(d.item_id), purchase_limit: 0, model_list: lista.map((x) => ({ model_id: x.model_id, model_promotion_price: x.promo })) };
    } else {
      const promo = vale(d.sku);
      if (promo != null) { n = 1; item = { item_id: Number(d.item_id), purchase_limit: 0, item_promotion_price: promo }; }
    }
    setUltimo(d);
    if (!item) { setResultado({ ok: 0, falhas: pulados.length ? pulados : ["nenhum preço promocional para cadastrar"], nome: desconto.discount_name }); return; }
    setOcupado(true);
    try {
      const r = await chamarPromocoes(`modulo=add-itens&shop_id=${shopId}&discount_id=${desconto.discount_id}&confirmar=1&propagar=1`, { item_list: [item] });
      const falhas = [...pulados];
      if (r.erro) falhas.push(traduzirErroShopee(typeof r.erro === "string" ? r.erro : `${r.erro?.error ?? ""}: ${r.erro?.message ?? ""}`));
      const errs = (r.response?.error_list ?? []) as Array<{ item_id: number; model_id?: number; fail_message?: string; fail_error?: string }>;
      for (const e of errs) {
        const s = d.modelos?.find((m) => m.model_id === Number(e.model_id))?.sku ?? d.sku;
        falhas.push(`${s}: ${traduzirErroShopee(e.fail_message || e.fail_error)}`);
      }
      const ok = r.erro ? 0 : Math.max(0, n - errs.length);
      setResultado({ ok, falhas, nome: desconto.discount_name });
      if (ok > 0 && !falhas.length) toast.success(`Cadastrado na promoção "${desconto.discount_name}"`, { description: `${ok} preço(s) promocional(is) · margem de ${rotulo(faixa)}` });
      else toast.warning(`Promoção "${desconto.discount_name}": ${ok} cadastrado(s), ${falhas.length} pendência(s)`, { duration: 20000 });
    } catch (e) {
      setResultado({ ok: 0, falhas: [...pulados, (e as Error).message], nome: desconto.discount_name });
      toast.error("Não consegui cadastrar na promoção", { description: (e as Error).message, duration: 20000 });
    } finally { setOcupado(false); }
  }

  // os avisos do envio leem sempre o estado atual
  const agora = useRef({ desconto, faixa, cadastrar, skus: skus.length });
  agora.current = { desconto, faixa, cadastrar, skus: skus.length };
  useEffect(() => {
    const eDaqui = (d: { canal?: string; empresa?: string; sku?: string }) => d.canal === "shopee" && d.empresa === empresa && d.sku === sku;
    const vaiCriar = (ev: Event) => {
      const d = (ev as CustomEvent).detail as VaiCriar;
      const a = agora.current;
      if (eDaqui(d) && a.desconto) d.promocao = `"${a.desconto.discount_name}" com margem de ${rotulo(a.faixa)}`;
    };
    const pronto = (ev: Event) => {
      const d = (ev as CustomEvent).detail as AnuncioPronto;
      if (eDaqui(d) && d.item_id && agora.current.desconto) void agora.current.cadastrar(d);
    };
    window.addEventListener(EV_VAI_CRIAR, vaiCriar); window.addEventListener(EV_PRONTO, pronto);
    return () => { window.removeEventListener(EV_VAI_CRIAR, vaiCriar); window.removeEventListener(EV_PRONTO, pronto); };
  }, [sku, empresa]);

  return (
    <div className="rounded-md border p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Tag className="h-4 w-4" /><b>Minha Promoção</b>
        <span className="text-xs text-muted-foreground">— cadastrar o anúncio numa promoção assim que ele for criado</span>
        {(descQ.isFetching || precosQ.isFetching || ocupado) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      {descQ.isError
        ? <p className="text-xs text-destructive">Não consegui ler as promoções da Shopee: {(descQ.error as Error).message}</p>
        : (
          <select className="h-8 w-full max-w-xl rounded-md border bg-background px-2 text-xs" value={descontoId ?? ""}
            onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; setDescontoId(id); setResultado(null); lembrar(id, faixa); }}>
            <option value="">Não cadastrar em promoção</option>
            {descontos.map((d) => (
              <option key={d.discount_id} value={d.discount_id}>
                {d.discount_name} · {d.status === "ongoing" ? `em andamento, até ${dia(d.end_time)}` : `começa ${dia(d.start_time)}`}
              </option>
            ))}
          </select>
        )}
      {descontoId != null && !desconto && !descQ.isFetching && <p className="text-xs text-amber-600">A promoção escolhida da última vez não está mais ativa: escolha outra.</p>}

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
                <div key={s.sku} className="grid grid-cols-[70px_1fr_110px_170px] gap-2 items-center text-xs">
                  <span className="font-mono">{s.sku}</span>
                  <span className="truncate text-muted-foreground" title={s.nome}>{s.nome}{c?.erro ? <span className="text-destructive"> · {c.erro}</span> : null}</span>
                  <Input className="h-7 text-right tabular-nums text-xs" inputMode="decimal" placeholder={c?.preco != null ? dinheiro(c.preco) : "sem preço"}
                    value={mao[s.sku] ?? (c?.preco != null ? dinheiro(c.preco) : "")} onChange={(e) => setMao({ ...mao, [s.sku]: e.target.value })}
                    title={v != null ? `preço promocional: ${formatBRL(v)}` : "sem preço promocional: fica de fora"} />
                  <MargemDoPreco sku={s.sku} empresa={empresa} preco={v} />
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Preço promocional de cada SKU pela margem escolhida (custo, comissão e imposto do bloco Preço); se você mudar o preço à mão, a margem ao lado mostra quanto ele rende. Quem ficar sem preço, ou com o promocional igual ou acima do preço cheio, fica de fora. O preço promocional vale para os compradores assim que é cadastrado.
          </p>
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
