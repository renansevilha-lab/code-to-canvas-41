import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarPromocoes, traduzirErroShopee } from "@/components/promocoes/comum";
import { calcularPreco, chamarPublicar, lerRegrasLoja, regraDe, type IaRascunho, type RegraLoja } from "@/lib/iaAnuncio";

// ============================================================================
// ENVIO EM LOTE (24/nov/2026, pedido do dono): vários anúncios de uma vez, a partir dos produtos marcados
// na lista de IA › Anúncios. Uma TABELA ÚNICA de conferência (decisão do dono) — um envio por produto × loja,
// com título, fotos, preço cheio e promocional calculados e o que falta — e um só "Enviar"; depois vão um
// por vez, com o resultado de cada um. Regras:
//  - Preço SEMPRE pela regra da loja (ia_loja_preco: Shopee Ottz 30%, Shopee Bumi 40%, TikTok 30%), mesmo que
//    haja preço aprovado à mão no bloco Preço (decisão do dono).
//  - Shopee: sempre promocionado, na promoção EM ANDAMENTO da loja (decisão do dono), com a margem
//    promocional da loja (Ottz 17,5%, Bumi 15%) — `shopee-promocoes?modulo=add-itens` logo depois de criar.
//  - Só CRIA anúncio de produto simples, no ar. Já anunciado na loja, produto com variações ou com pendência
//    na prévia da `anuncio-publicar` fica de fora (vai pela tela do anúncio). Mesmas funções do envio de um
//    anúncio: `chamarPublicar("previa"|"enviar")` (TikTok vai para a `anuncio-tiktok`).
// ============================================================================

interface Destino { canal: string; empresa: string; rotulo: string }
const DESTINOS: Destino[] = [
  { canal: "shopee", empresa: "ottz", rotulo: "Shopee · Ottz" },
  { canal: "shopee", empresa: "svl", rotulo: "Shopee · Bumi" },
  { canal: "tiktok", empresa: "ottz", rotulo: "TikTok · ACZ" },
];
const LOJA_SHOPEE: Record<string, number> = { ottz: 522186766, svl: 759046323 };
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1).replace(".0", "").replace(".", ",")}%`);
const chave = (sku: string, d: Destino) => `${sku}|${d.canal}|${d.empresa}`;

interface Promo { discount_id: number; discount_name: string }
interface Linha {
  sku: string; destino: Destino; rascunho: IaRascunho | null; titulo: string | null; nFotos: number;
  preco: number | null; promo: number | null; promocao: Promo | null; pendencias: string[]; fora: string | null;
}
type Estado = { fase: "fila" | "enviando" | "ok" | "erro"; msg?: string; item?: string };

async function montarLinha(sku: string, d: Destino, rascunhos: IaRascunho[], regra: RegraLoja | null, promocao: Promo | null): Promise<Linha> {
  const base: Linha = { sku, destino: d, rascunho: null, titulo: null, nFotos: 0, preco: null, promo: null, promocao, pendencias: [], fora: null };
  const doSku = rascunhos.filter((r) => r.sku === sku);
  const rasc = doSku.find((r) => r.canal === d.canal && r.empresa === d.empresa) ?? doSku[0] ?? null;
  if (!rasc) return { ...base, fora: "sem anúncio gerado pela IA (texto e fotos)" };
  base.rascunho = rasc;
  const p = await calcularPreco(sku, d.canal, d.empresa, null);
  if (p.erro || p.preco_sugerido == null) return { ...base, fora: p.erro ?? "sem preço calculado" };
  if (p.da_variacao) return { ...base, fora: "produto com variações: envie pela tela do anúncio" };
  base.preco = Number(p.preco_sugerido);
  if (d.canal === "shopee" && regra?.promo_sempre && regra.margem_promo_pct != null) {
    const pr = await calcularPreco(sku, d.canal, d.empresa, regra.margem_promo_pct);
    base.promo = pr.preco_sugerido != null ? Number(pr.preco_sugerido) : null;
  }
  const r = (await chamarPublicar("previa", { rascunho_id: rasc.id, destino: { canal: d.canal, empresa: d.empresa }, opcoes: { preco: String(base.preco), fora_do_ar: false, modo: "criar" } })) as {
    disponivel?: boolean; motivo?: string; modo?: string; previa?: { titulo?: string; fotos?: unknown[] }; pendencias?: string[];
  };
  if (r.disponivel === false) return { ...base, fora: r.motivo ?? "loja indisponível para envio" };
  if (r.modo === "atualizar") return { ...base, fora: "já tem anúncio nesta loja: atualize pela tela do anúncio" };
  base.titulo = r.previa?.titulo ?? null;
  base.nFotos = r.previa?.fotos?.length ?? 0;
  base.pendencias = r.pendencias ?? [];
  if (d.canal === "shopee" && regra?.promo_sempre) {
    if (!promocao) base.pendencias = [...base.pendencias, "nenhuma promoção em andamento nesta loja"];
    else if (base.promo == null || base.promo >= base.preco) base.pendencias = [...base.pendencias, "preço promocional não fica abaixo do cheio"];
  }
  return base;
}

export function EnvioLote({ skus, onFechar }: { skus: string[]; onFechar: () => void }) {
  const qc = useQueryClient();
  const [destinos, setDestinos] = useState<string[]>([`shopee|ottz`]);
  const [estados, setEstados] = useState<Record<string, Estado>>({});
  const [enviando, setEnviando] = useState(false);
  const escolhidos = DESTINOS.filter((d) => destinos.includes(`${d.canal}|${d.empresa}`));

  const regrasQ = useQuery({ queryKey: ["ia-anuncio", "regras-loja"], staleTime: 10 * 60_000, queryFn: lerRegrasLoja });
  const conferenciaQ = useQuery({
    queryKey: ["ia-anuncio", "envio-lote", skus.join(","), destinos.join(",")],
    enabled: regrasQ.isSuccess && escolhidos.length > 0,
    staleTime: 0, gcTime: 0, retry: false,
    queryFn: async (): Promise<Linha[]> => {
      const { data, error } = await supabaseExternal.from("ia_rascunho").select("*").in("sku", skus).order("created_at", { ascending: false });
      if (error) throw error;
      const rascunhos = (data ?? []) as IaRascunho[];
      // promoção em andamento de cada loja Shopee escolhida (a primeira da lista da Shopee)
      const promocoes: Record<string, Promo | null> = {};
      for (const d of escolhidos.filter((x) => x.canal === "shopee")) {
        const r = await chamarPromocoes(`modulo=list&shop_id=${LOJA_SHOPEE[d.empresa]}&status=ongoing`);
        const lista = (r.erro ? [] : (r.descontos ?? [])) as Promo[];
        promocoes[d.empresa] = lista[0] ?? null;
      }
      const linhas: Linha[] = [];
      for (const sku of skus) for (const d of escolhidos) {
        try { linhas.push(await montarLinha(sku, d, rascunhos, regraDe(regrasQ.data, d.canal, d.empresa), d.canal === "shopee" ? promocoes[d.empresa] ?? null : null)); }
        catch (e) { linhas.push({ sku, destino: d, rascunho: null, titulo: null, nFotos: 0, preco: null, promo: null, promocao: null, pendencias: [], fora: (e as Error).message }); }
      }
      return linhas;
    },
  });
  const linhas = useMemo(() => conferenciaQ.data ?? [], [conferenciaQ.data]);
  const prontas = linhas.filter((l) => !l.fora && l.pendencias.length === 0 && l.rascunho && l.preco != null);
  const terminou = prontas.length > 0 && prontas.every((l) => ["ok", "erro"].includes(estados[chave(l.sku, l.destino)]?.fase ?? ""));

  async function enviarTodos() {
    const resumo = prontas.map((l) => `• ${l.sku} → ${l.destino.rotulo}: ${formatBRL(l.preco!)}${l.promocao && l.promo != null ? ` · promo ${formatBRL(l.promo)} em "${l.promocao.discount_name}"` : ""}`).join("\n");
    if (!window.confirm(`Criar ${prontas.length} anúncio(s), NO AR, visíveis para os compradores?\n\n${resumo}\n\nVão um por vez; os que ficaram de fora na tabela não são enviados.`)) return;
    setEnviando(true);
    setEstados(Object.fromEntries(prontas.map((l) => [chave(l.sku, l.destino), { fase: "fila" } as Estado])));
    let ok = 0; let erros = 0;
    for (const l of prontas) {
      const k = chave(l.sku, l.destino);
      setEstados((s) => ({ ...s, [k]: { fase: "enviando" } }));
      try {
        const r = await chamarPublicar("enviar", {
          rascunho_id: l.rascunho!.id, destino: { canal: l.destino.canal, empresa: l.destino.empresa },
          opcoes: { preco: String(l.preco), fora_do_ar: false, modo: "criar" }, confirmar: true,
        });
        const item = r?.item_id ? String(r.item_id) : "";
        let msg = `criado · código ${item}`;
        if (item && l.promocao && l.promo != null) {
          const pr = await chamarPromocoes(`modulo=add-itens&shop_id=${LOJA_SHOPEE[l.destino.empresa]}&discount_id=${l.promocao.discount_id}&confirmar=1&propagar=1`,
            { item_list: [{ item_id: Number(item), purchase_limit: 0, item_promotion_price: l.promo }] });
          const falha = pr.erro ? traduzirErroShopee(typeof pr.erro === "string" ? pr.erro : `${pr.erro?.error ?? ""}: ${pr.erro?.message ?? ""}`)
            : ((pr.response?.error_list ?? []) as { fail_message?: string; fail_error?: string }[]).map((e) => traduzirErroShopee(e.fail_message || e.fail_error)).join("; ");
          msg += falha ? ` · NÃO entrou na promoção: ${falha}` : ` · na promoção a ${formatBRL(l.promo)}`;
        }
        for (const av of ((r?.avisos ?? []) as string[]).filter((x) => /^(ATENÇÃO|o anúncio foi criado, mas)/.test(x))) msg += ` · ${av}`;
        ok++;
        setEstados((s) => ({ ...s, [k]: { fase: "ok", msg, item } }));
      } catch (e) {
        erros++;
        setEstados((s) => ({ ...s, [k]: { fase: "erro", msg: (e as Error).message } }));
      }
    }
    setEnviando(false);
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    if (erros) toast.warning(`Envio em lote: ${ok} criado(s), ${erros} com erro`, { duration: 20000 });
    else toast.success(`Envio em lote: ${ok} anúncio(s) criado(s)`);
  }

  const alternarDestino = (k: string) => setDestinos((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k]));

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !enviando) onFechar(); }}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enviar {skus.length} anúncio(s) de uma vez</DialogTitle>
          <DialogDescription>
            Cria um anúncio novo, no ar, para cada produto em cada loja marcada. Preço pela regra da loja; na Shopee entra
            sempre na promoção em andamento. Confira a tabela: nada é enviado antes do botão "Enviar".
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Lojas:</span>
          {DESTINOS.map((d) => {
            const k = `${d.canal}|${d.empresa}`;
            const rg = regraDe(regrasQ.data, d.canal, d.empresa);
            return (
              <label key={k} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 cursor-pointer ${destinos.includes(k) ? "border-primary bg-primary/5" : ""}`}>
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={destinos.includes(k)} disabled={enviando} onChange={() => alternarDestino(k)} />
                <span className="font-medium">{d.rotulo}</span>
                {rg && <span className="text-[11px] text-muted-foreground">cheio {pct(rg.margem_cheio_pct)}{rg.promo_sempre && rg.margem_promo_pct != null ? ` · promo ${pct(rg.margem_promo_pct)}` : ""}</span>}
              </label>
            );
          })}
        </div>

        {escolhidos.length === 0 ? <p className="text-sm text-muted-foreground">Marque ao menos uma loja.</p>
          : conferenciaQ.isLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />Conferindo {skus.length * escolhidos.length} envio(s): preço, prévia da loja e promoção…</div>
          : conferenciaQ.isError ? <div className="text-sm text-destructive">Não consegui conferir: {(conferenciaQ.error as Error).message} <Button size="sm" variant="ghost" onClick={() => void conferenciaQ.refetch()}>Tentar de novo</Button></div>
          : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr><th className="text-left px-3 py-2">Produto</th><th className="text-left px-3 py-2">Loja</th><th className="text-left px-3 py-2">Título</th>
                    <th className="text-right px-3 py-2">Fotos</th><th className="text-right px-3 py-2">Preço cheio</th><th className="text-right px-3 py-2">Promocional</th><th className="text-left px-3 py-2">Situação</th></tr>
                </thead>
                <tbody>
                  {linhas.map((l) => {
                    const est = estados[chave(l.sku, l.destino)];
                    const pronto = !l.fora && l.pendencias.length === 0;
                    return (
                      <tr key={chave(l.sku, l.destino)} className="border-t align-top">
                        <td className="px-3 py-2 font-mono text-xs">{l.sku}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{l.destino.rotulo}</td>
                        <td className="px-3 py-2 max-w-[280px]"><span className="line-clamp-2">{l.titulo ?? "—"}</span></td>
                        <td className="px-3 py-2 text-right tabular-nums">{l.nFotos || "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{l.preco != null ? formatBRL(l.preco) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {l.promo != null ? <>{formatBRL(l.promo)}{l.promocao && <div className="text-[11px] text-muted-foreground truncate max-w-[160px]" title={l.promocao.discount_name}>{l.promocao.discount_name}</div>}</> : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {est?.fase === "enviando" ? <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />enviando…</span>
                            : est?.fase === "ok" ? <span className="flex items-start gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5 mt-px shrink-0" />{est.msg}</span>
                            : est?.fase === "erro" ? <span className="flex items-start gap-1 text-destructive"><X className="h-3.5 w-3.5 mt-px shrink-0" />{est.msg}</span>
                            : est?.fase === "fila" ? <span className="text-muted-foreground">na fila</span>
                            : l.fora ? <span className="text-muted-foreground">fica de fora: {l.fora}</span>
                            : !pronto ? <span className="flex items-start gap-1 text-amber-700"><AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />{l.pendencias.join("; ")}</span>
                            : <span className="text-emerald-700">pronto para enviar</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        <DialogFooter className="items-center gap-2">
          <span className="text-xs text-muted-foreground mr-auto">{linhas.length ? `${prontas.length} de ${linhas.length} prontos` : ""}</span>
          <Button variant="ghost" disabled={enviando} onClick={onFechar}>{terminou ? "Fechar" : "Cancelar"}</Button>
          {!terminou && (
            <Button disabled={enviando || prontas.length === 0 || conferenciaQ.isFetching} onClick={() => void enviarTodos()} className="gap-1.5">
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Enviar {prontas.length} anúncio(s)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
