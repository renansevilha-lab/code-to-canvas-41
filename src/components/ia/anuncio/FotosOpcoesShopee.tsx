import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ImageIcon, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { chamarVariacoesShopee, urlsAssinadas } from "@/lib/iaAnuncio";
import { listaDeExistentes, useExistentesAnuncio } from "@/components/ia/anuncio/Publicar";

// ============================================================================
// Fotos das OPÇÕES de um anúncio da Shopee que já tem variações (06/nov/2026, pedido do dono: "a foto das variações
// não funcionou para atualizar"). A atualização do envio troca só a galeria do anúncio; a foto de cada opção (8kg,
// 10kg, 20kg…) é outro campo (tier_variation). Aqui: lê o anúncio ao vivo, mostra a foto de hoje de cada opção e as
// fotos APROVADAS do rascunho de cada variação (bloco "Fotos das variações"), confere e troca — anuncio-shopee-variacoes
// ?modulo=fotos-opcoes (prévia + confirmação, uma chamada à Shopee).
// ============================================================================

interface Variacao { model_id: number; tier_index: number[]; sku: string; opcao: string }
interface Grupo { nome: string; opcoes: { opcao: string; image_id: string | null; foto: string | null }[] }
interface AoVivo { item_id: number; nome: string; tem_variacao: boolean; grupos: Grupo[]; variacoes: Variacao[] }
interface Foto { sku: string; path: string; tipo: string; criado: string }

// a capa ambientada com o selo é a que o bloco "Fotos das variações" gera por padrão
const PREFERIDA = ["capa_ambientada_texto", "capa_ambientada_limpa"];

export function FotosOpcoesShopee({ sku, empresa, itemInicial }: { sku: string; empresa: string; itemInicial?: string }) {
  const qc = useQueryClient();
  const exQ = useExistentesAnuncio(sku);
  const lista = listaDeExistentes(exQ.data, "shopee", empresa) ?? [];
  const [itemId, setItemId] = useState<string>(itemInicial ?? "");
  useEffect(() => { if (!itemId && lista.length) setItemId(itemInicial ?? lista[0].item_id); }, [lista.length, itemInicial]); // eslint-disable-line react-hooks/exhaustive-deps
  const [aberto, setAberto] = useState(false);
  const [escolha, setEscolha] = useState<Record<string, string | null>>({}); // sku → caminho (null = manter)
  const [previa, setPrevia] = useState<{ pendencias: string[]; avisos: string[] } | null>(null);
  const [enviando, setEnviando] = useState(false);

  const vivoQ = useQuery({
    queryKey: ["ia-anuncio", "fotos-opcoes", empresa, itemId],
    enabled: aberto && !!itemId, retry: false, staleTime: 60_000, placeholderData: undefined, gcTime: 0,
    queryFn: async () => (await chamarVariacoesShopee("ler", { empresa, item_id: itemId })).anuncio as AoVivo,
  });
  const vivo = vivoQ.data && String(vivoQ.data.item_id) === String(itemId) ? vivoQ.data : null;
  const skus = useMemo(() => [...new Set((vivo?.variacoes ?? []).map((v) => v.sku).filter(Boolean))], [vivo]);

  // fotos aprovadas dos rascunhos de cada variação
  const fotosQ = useQuery({
    queryKey: ["ia-anuncio", "fotos-opcoes-aprovadas", skus.join(",")],
    enabled: skus.length > 0,
    queryFn: async (): Promise<{ porSku: Record<string, Foto[]>; urls: Record<string, string> }> => {
      const { data: rs } = await supabaseExternal.from("ia_rascunho").select("id, sku").in("sku", skus);
      const rasc = (rs ?? []) as { id: string; sku: string }[];
      if (!rasc.length) return { porSku: {}, urls: {} };
      const { data: im } = await supabaseExternal.from("ia_rascunho_imagem").select("id, rascunho_id, tipo, storage_path, created_at")
        .in("rascunho_id", rasc.map((r) => r.id)).not("storage_path", "is", null);
      const imgs = (im ?? []) as { id: string; rascunho_id: string; tipo: string; storage_path: string; created_at: string }[];
      const { data: et } = imgs.length
        ? await supabaseExternal.from("ia_etapa").select("imagem_id, status").in("imagem_id", imgs.map((i) => i.id))
        : { data: [] };
      const aprovadas = new Set(((et ?? []) as { imagem_id: string; status: string }[]).filter((e) => e.status === "aprovado").map((e) => e.imagem_id));
      const porSku: Record<string, Foto[]> = {};
      for (const i of imgs) {
        if (!aprovadas.has(i.id)) continue;
        const s = rasc.find((r) => r.id === i.rascunho_id)?.sku;
        if (!s) continue;
        (porSku[s] ??= []).push({ sku: s, path: i.storage_path, tipo: i.tipo, criado: i.created_at });
      }
      for (const s of Object.keys(porSku)) {
        porSku[s].sort((a, b) => {
          const pa = PREFERIDA.indexOf(a.tipo), pb = PREFERIDA.indexOf(b.tipo);
          return (pa < 0 ? 9 : pa) - (pb < 0 ? 9 : pb) || b.criado.localeCompare(a.criado);
        });
      }
      const urls = await urlsAssinadas(Object.values(porSku).flat().map((f) => f.path));
      return { porSku, urls };
    },
  });
  const porSku = fotosQ.data?.porSku ?? {};
  const urls = fotosQ.data?.urls ?? {};
  // padrão: a foto preferida de cada variação (quem não tem foto aprovada fica como está)
  useEffect(() => {
    if (!fotosQ.data) return;
    setEscolha((a) => {
      const n = { ...a };
      for (const s of skus) if (!(s in n)) n[s] = porSku[s]?.[0]?.path ?? null;
      return n;
    });
    setPrevia(null);
  }, [fotosQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pedidos = skus.filter((s) => escolha[s]).map((s) => ({ sku: s, path: escolha[s]! }));
  const linhas = (vivo?.variacoes ?? []).map((v) => ({ v, hoje: vivo?.grupos?.[0]?.opcoes?.[v.tier_index?.[0]]?.foto ?? null }));

  async function conferir() {
    try {
      const r = await chamarVariacoesShopee("fotos-opcoes", { empresa, item_id: itemId, fotos: pedidos });
      setPrevia({ pendencias: r.pendencias ?? [], avisos: r.avisos ?? [] });
    } catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message }); }
  }
  async function enviar() {
    const nomes = linhas.filter((l) => escolha[l.v.sku]).map((l) => l.v.opcao).join(", ");
    if (!window.confirm(`Trocar na Shopee (anúncio ${itemId}) a foto das opções: ${nomes}?\n\nAs outras opções, os preços, os estoques e a galeria do anúncio não mudam.`)) return;
    setEnviando(true);
    try {
      const r = await chamarVariacoesShopee("fotos-opcoes", { empresa, item_id: itemId, fotos: pedidos, confirmar: true });
      toast.success(`${r.trocadas ?? pedidos.length} foto(s) de opção trocada(s) na Shopee`, { description: r.aviso ?? undefined });
      setPrevia(null);
      await qc.invalidateQueries({ queryKey: ["ia-anuncio", "fotos-opcoes", empresa, itemId] });
    } catch (e) {
      toast.error("A troca não foi feita", { description: (e as Error).message });
    } finally { setEnviando(false); }
  }

  if (!exQ.isLoading && !lista.length && !itemInicial) return null;
  return (
    <Card><CardContent className="p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
        <b>Fotos das opções no anúncio da Shopee</b>
        <span className="text-xs text-muted-foreground">— a foto de cada variação (8kg, 10kg…), que a atualização do envio não troca</span>
        {!aberto && <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" disabled={!itemId} onClick={() => setAberto(true)}>Ver as fotos das opções</Button>}
      </div>
      {aberto && (<>
        {lista.length > 1 && (
          <select className="h-8 rounded-md border bg-background px-2 text-xs" value={itemId} onChange={(e) => { setItemId(e.target.value); setEscolha({}); setPrevia(null); }}>
            {lista.map((e) => <option key={e.item_id} value={e.item_id}>{e.item_id} · {e.nome ?? ""}</option>)}
          </select>
        )}
        {vivoQ.isLoading && <p className="text-xs text-muted-foreground"><Loader2 className="inline h-3.5 w-3.5 animate-spin mr-1" />Lendo o anúncio {itemId} na Shopee…</p>}
        {vivoQ.isError && <p className="text-xs text-destructive">{(vivoQ.error as Error).message}</p>}
        {vivo && !vivo.tem_variacao && <p className="text-xs text-muted-foreground">O anúncio {itemId} não tem variações: a foto dele é a da galeria, que vai pelo envio.</p>}
        {vivo?.tem_variacao && (<>
          <div className="space-y-2">
            {linhas.map(({ v, hoje }) => {
              const fotos = porSku[v.sku] ?? [];
              const sel = escolha[v.sku] ?? null;
              return (
                <div key={v.model_id} className="flex flex-wrap items-center gap-3 rounded-md border p-2">
                  <div className="w-28 shrink-0">
                    <div className="font-medium">{v.opcao}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{v.sku || "sem SKU"}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-[10px] text-muted-foreground mb-0.5">hoje</div>
                    {hoje ? <img src={hoje} alt="" className="h-16 w-16 rounded object-cover border" /> : <div className="h-16 w-16 rounded border grid place-items-center text-[10px] text-muted-foreground">sem foto</div>}
                  </div>
                  <span className="text-muted-foreground">→</span>
                  <div className="flex flex-wrap items-end gap-1.5">
                    <button type="button" onClick={() => { setEscolha({ ...escolha, [v.sku]: null }); setPrevia(null); }}
                      className={`h-16 w-16 rounded border text-[10px] ${sel == null ? "ring-2 ring-primary" : "text-muted-foreground"}`}>manter</button>
                    {fotosQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    {fotos.map((f) => (
                      <button key={f.path} type="button" title={f.tipo.replace(/_/g, " ")} onClick={() => { setEscolha({ ...escolha, [v.sku]: f.path }); setPrevia(null); }}
                        className={`rounded ${sel === f.path ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"}`}>
                        {urls[f.path] ? <img src={urls[f.path]} alt="" className="h-16 w-16 rounded object-cover border" /> : <div className="h-16 w-16 rounded border" />}
                      </button>
                    ))}
                    {!fotosQ.isLoading && fotos.length === 0 && <span className="text-[11px] text-muted-foreground">nenhuma foto aprovada desta variação (gere na aba Fotos › Fotos das variações)</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {previa && (previa.pendencias.length > 0 || previa.avisos.length > 0) && (
            <div className="space-y-1 text-xs">
              {previa.pendencias.map((p) => <div key={p} className="text-destructive">• {p}</div>)}
              {previa.avisos.map((p) => <div key={p} className="text-amber-700 dark:text-amber-400">• {p}</div>)}
            </div>
          )}
          {previa && previa.pendencias.length === 0 && (
            <p className="text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="inline h-3.5 w-3.5 mr-1" />Conferido: {pedidos.length} foto(s) de opção prontas para trocar.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!pedidos.length || enviando} onClick={conferir}>Conferir</Button>
            <Button size="sm" className="h-8 text-xs" disabled={!previa || previa.pendencias.length > 0 || !pedidos.length || enviando} onClick={enviar}>
              {enviando && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Trocar as fotos na Shopee
            </Button>
          </div>
        </>)}
      </>)}
    </CardContent></Card>
  );
}
