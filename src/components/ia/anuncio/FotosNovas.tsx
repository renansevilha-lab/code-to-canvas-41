import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Search, Store, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { prepararImagem } from "@/components/ia/anuncio/Referencias";
import { BUCKET_ANUNCIOS, chamarAproveitar, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// Fotos que não vêm da IA (18/out/2026, pedido do dono):
//  - SUBIR À MÃO: os arquivos vão para `ia-anuncios/manual/{sku}/{uuid}` e entram no anúncio para revisar;
//  - ANÚNCIOS NO AR: as fotos que estão hoje num anúncio publicado (Shopee/Mercado Livre, lidas ao vivo)
//    podem ser copiadas para este anúncio, também para revisar.
// As duas viram fotos do rascunho como as geradas (edge fn `ia-aproveitar`, módulos subir / no-ar /
// copiar-no-ar), então também aparecem em "Usar fotos de outro anúncio" para os demais produtos.
// ============================================================================

const LOJA_SHOPEE: Record<string, string> = { "522186766": "ottz", "759046323": "svl" };
const nomeLoja = (mkt: string, l: string) => mkt === "shopee" ? (l === "svl" ? "Shopee · Bumi" : "Shopee · Ottz") : (l === "svl" ? "Mercado Livre · SVL" : "Mercado Livre · Ottz");

interface AnuncioNoAr { mkt: "shopee" | "mercado_livre"; loja: string; item_id: string; titulo: string; sku: string | null; foto: string | null; doProduto: boolean }
interface FotosDoAnuncio { mkt: string; loja: string; item_id: string; titulo: string; sku: string | null; status: string | null; fotos: string[] }

export function FotosNovas({ sku, canal, empresa, rascunho, onDestino }: {
  sku: string; canal: string; empresa: string; rascunho: IaRascunho | null; onDestino: (id: string) => void;
}) {
  const qc = useQueryClient();
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [subindo, setSubindo] = useState<string | null>(null);

  async function subir(lista: File[]) {
    const imgs = lista.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) { toast.error("Escolha arquivos de imagem (JPG, PNG ou WEBP)"); return; }
    const caminhos: string[] = [];
    try {
      for (let i = 0; i < imgs.length; i++) {
        setSubindo(`enviando ${i + 1} de ${imgs.length}…`);
        const { blob, mime, ext } = await prepararImagem(imgs[i]);
        const caminho = `manual/${sku}/${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
        const { error } = await supabaseExternal.storage.from(BUCKET_ANUNCIOS).upload(caminho, blob, { contentType: mime, upsert: false });
        if (error) throw new Error(`${imgs[i].name}: ${error.message}`);
        caminhos.push(caminho);
      }
      setSubindo("guardando no anúncio…");
      const r = await chamarAproveitar("subir", { sku, canal, empresa, destino_id: rascunho?.id, caminhos });
      const puladas = (r.puladas ?? []) as { tipo: string; motivo: string }[];
      toast.success(`${(r.copiadas ?? []).length} foto(s) no anúncio — aprove na lista de fotos abaixo`, {
        description: puladas.map((p) => p.motivo).slice(0, 4).join("\n") || undefined,
      });
      if (r.rascunho_id && r.rascunho_id !== rascunho?.id) onDestino(String(r.rascunho_id));
      recarregar();
    } catch (e) {
      toast.error("Não consegui subir as fotos", { description: (e as Error).message, duration: 12000 });
      // arquivos que subiram e não entraram no anúncio não ficam soltos no armazenamento
      if (caminhos.length) void supabaseExternal.storage.from(BUCKET_ANUNCIOS).remove(caminhos);
    } finally { setSubindo(null); }
  }

  // ---------------- anúncios no ar
  const [busca, setBusca] = useState("");
  const termo = busca.trim();
  // sem busca: os anúncios deste produto, dos componentes (kit) e das variações (produto pai)
  const parentesQ = useQuery({
    queryKey: ["ia-anuncio", "no-ar-parentes", sku],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const [k, v] = await Promise.all([
        supabaseExternal.from("produto_kits").select("sku_componente").eq("sku_kit", sku),
        supabaseExternal.from("produtos").select("sku").eq("sku_pai", sku).eq("ativo", true),
      ]);
      return [...new Set([sku, ...((k.data ?? []) as { sku_componente: string }[]).map((x) => x.sku_componente), ...((v.data ?? []) as { sku: string }[]).map((x) => x.sku)])];
    },
  });
  const listaQ = useQuery({
    queryKey: ["ia-anuncio", "no-ar-lista", sku, termo, (parentesQ.data ?? []).join(",")],
    enabled: !!parentesQ.data,
    staleTime: 2 * 60_000,
    placeholderData: (a) => a,
    queryFn: async (): Promise<AnuncioNoAr[]> => {
      const skus = parentesQ.data ?? [sku];
      const limpo = termo.replace(/[%,()]/g, " ").trim();
      let sh = supabaseExternal.from("shopee_anuncios").select("item_id, shop_id, nome, sku_pai, imagem_url").eq("status", "NORMAL");
      let ml = supabaseExternal.from("ml_anuncios").select("mlb, sku, titulo, foto").eq("status", "active");
      if (!limpo) { sh = sh.in("sku_pai", skus); ml = ml.in("sku", skus); }
      else if (/^\d{6,15}$/.test(limpo)) { sh = sh.or(`item_id.eq.${limpo},sku_pai.eq.${limpo}`); ml = ml.or(`sku.eq.${limpo},mlb.eq.MLB${limpo}`); }
      else if (/^mlb\d+$/i.test(limpo)) { sh = sh.eq("item_id", -1); ml = ml.eq("mlb", limpo.toUpperCase()); }
      else {
        const palavras = limpo.split(/\s+/).filter((p) => p.length >= 2).slice(0, 5);
        for (const p of palavras) { sh = sh.ilike("nome", `%${p}%`); ml = ml.ilike("titulo", `%${p}%`); }
      }
      const [a, b] = await Promise.all([sh.limit(40), ml.limit(40)]);
      if (a.error) throw a.error;
      if (b.error) throw b.error;
      const meus = new Set(skus);
      const out: AnuncioNoAr[] = [
        ...((a.data ?? []) as any[]).map((x) => ({ mkt: "shopee" as const, loja: LOJA_SHOPEE[String(x.shop_id)] ?? "ottz", item_id: String(x.item_id), titulo: String(x.nome ?? ""), sku: x.sku_pai ?? null, foto: x.imagem_url ?? null, doProduto: meus.has(String(x.sku_pai)) })),
        ...((b.data ?? []) as any[]).map((x) => ({ mkt: "mercado_livre" as const, loja: "ottz", item_id: String(x.mlb), titulo: String(x.titulo ?? ""), sku: x.sku ?? null, foto: x.foto ? String(x.foto).replace(/^http:\/\//, "https://") : null, doProduto: meus.has(String(x.sku)) })),
      ];
      return out.sort((x, y) => Number(y.doProduto) - Number(x.doProduto) || x.titulo.localeCompare(y.titulo)).slice(0, 40);
    },
  });
  // ID digitado que não está no espelho (anúncio novo, ou Mercado Livre da SVL): dá para abrir direto
  const idDireto = useMemo(() => {
    if (/^\d{8,15}$/.test(termo)) return { mkt: "shopee" as const, id: termo };
    if (/^mlb\d{6,15}$/i.test(termo)) return { mkt: "mercado_livre" as const, id: termo.toUpperCase() };
    return null;
  }, [termo]);
  const [aberto, setAberto] = useState<{ mkt: string; item_id: string; loja?: string } | null>(null);

  return (
    <Card><CardContent className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ImagePlus className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold">Fotos prontas, sem IA</h3>
        <span className="text-xs text-muted-foreground">subir do computador ou trazer de um anúncio que já está no ar — entram para revisar e ficam disponíveis para os outros produtos</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (!subindo) void subir([...e.dataTransfer.files]); }}>
        <Upload className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm flex-1 min-w-[200px]">Arraste as fotos aqui ou</span>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={!!subindo} onClick={() => arquivoRef.current?.click()}>
          {subindo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}{subindo ?? "Escolher fotos"}
        </Button>
        <input ref={arquivoRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden"
          onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void subir(f); }} />
        <p className="basis-full text-[11px] text-muted-foreground">JPG, PNG ou WEBP; acima de 3 MB a foto é reduzida a 2.000 px. Até 20 por vez.</p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Store className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Fotos dos anúncios no ar</span>
          {listaQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="relative max-w-md">
          <Search className="h-4 w-4 absolute left-2.5 top-2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Nome, SKU ou ID do anúncio (em branco: os anúncios deste produto)" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        {listaQ.isError ? <p className="text-sm text-destructive">{(listaQ.error as Error).message}</p>
          : !listaQ.data ? <p className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Procurando…</p>
          : (
            <div className="divide-y rounded-md border max-h-[360px] overflow-y-auto">
              {idDireto && !listaQ.data.some((a) => a.item_id === idDireto.id) && (
                <div className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="flex-1">Abrir o anúncio <b className="font-mono">{idDireto.id}</b> ({idDireto.mkt === "shopee" ? "Shopee" : "Mercado Livre"}) direto no marketplace</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAberto({ mkt: idDireto.mkt, item_id: idDireto.id })}>Ver fotos</Button>
                </div>
              )}
              {listaQ.data.length === 0 && !idDireto && (
                <p className="px-3 py-2 text-sm text-muted-foreground">{termo ? "Nenhum anúncio no ar com essa busca." : "Este produto ainda não tem anúncio no ar. Busque por um parecido."}</p>
              )}
              {listaQ.data.map((a) => (
                <div key={`${a.mkt}-${a.item_id}`} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                  <div className="h-10 w-10 shrink-0 rounded border overflow-hidden bg-muted/30">
                    {a.foto && <img src={a.foto} alt="" loading="lazy" className="h-full w-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={a.titulo}>{a.titulo}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {nomeLoja(a.mkt, a.loja)} · <span className="font-mono">{a.item_id}</span>{a.sku ? ` · SKU ${a.sku}` : ""}
                      {a.doProduto && <span className="text-emerald-700 dark:text-emerald-400"> · deste produto</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => setAberto({ mkt: a.mkt, item_id: a.item_id, loja: a.loja })}>Ver fotos</Button>
                </div>
              ))}
            </div>
          )}
        <p className="text-[11px] text-muted-foreground">O Mercado Livre da SVL não tem espelho na gestão: digite o código MLB para abrir.</p>
      </div>

      {aberto && (
        <DialogoNoAr alvo={aberto} sku={sku} canal={canal} empresa={empresa} rascunho={rascunho}
          onFechar={() => setAberto(null)} onFeito={(id) => { if (id && id !== rascunho?.id) onDestino(id); recarregar(); }} />
      )}
    </CardContent></Card>
  );
}

function DialogoNoAr({ alvo, sku, canal, empresa, rascunho, onFechar, onFeito }: {
  alvo: { mkt: string; item_id: string; loja?: string }; sku: string; canal: string; empresa: string; rascunho: IaRascunho | null;
  onFechar: () => void; onFeito: (rascunhoId: string | null) => void;
}) {
  const q = useQuery({
    queryKey: ["ia-anuncio", "no-ar-fotos", alvo.mkt, alvo.item_id, alvo.loja ?? ""],
    staleTime: 5 * 60_000,
    placeholderData: undefined,
    queryFn: async () => (await chamarAproveitar("no-ar", { mkt: alvo.mkt, item_id: alvo.item_id, loja: alvo.loja })) as FotosDoAnuncio,
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [copiando, setCopiando] = useState(false);
  const fotos = q.data?.fotos ?? [];
  const alternar = (u: string) => setSel((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; });

  async function trazer() {
    setCopiando(true);
    try {
      const r = await chamarAproveitar("copiar-no-ar", {
        sku, canal, empresa, destino_id: rascunho?.id, mkt: alvo.mkt, item_id: q.data?.item_id ?? alvo.item_id, urls: fotos.filter((u) => sel.has(u)),
      });
      const puladas = (r.puladas ?? []) as { tipo: string; motivo: string }[];
      const n = (r.copiadas ?? []).length;
      if (n) toast.success(`${n} foto(s) trazida(s) — aprove na lista de fotos abaixo`, { description: puladas.map((p) => p.motivo).slice(0, 4).join("\n") || undefined });
      else toast.warning("Nenhuma foto entrou", { description: puladas.map((p) => p.motivo).slice(0, 4).join("\n") || undefined });
      onFeito(r.rascunho_id ? String(r.rascunho_id) : null);
      if (n) onFechar();
    } catch (e) { toast.error("Não consegui trazer as fotos", { description: (e as Error).message }); }
    finally { setCopiando(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-5xl w-[calc(100vw-1.5rem)] max-h-[92vh] overflow-y-auto overflow-x-hidden grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle className="pr-6">{q.data?.titulo || "Fotos do anúncio"}</DialogTitle>
          <DialogDescription>
            {q.data ? <>{nomeLoja(q.data.mkt, q.data.loja)} · <span className="font-mono">{q.data.item_id}</span>{q.data.sku ? ` · SKU ${q.data.sku}` : ""} · {fotos.length} foto(s), lidas agora no marketplace</> : "lendo o anúncio no marketplace…"}
          </DialogDescription>
        </DialogHeader>
        {q.isError ? <p className="text-sm text-destructive">{(q.error as Error).message}</p>
          : q.isLoading ? <p className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Lendo as fotos…</p>
          : fotos.length === 0 ? <p className="text-sm text-muted-foreground">Este anúncio não tem fotos.</p>
          : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSel(sel.size === fotos.length ? new Set() : new Set(fotos))}>
                  {sel.size === fotos.length ? "Desmarcar todas" : "Marcar todas"}
                </Button>
                <span className="text-muted-foreground">Clique para marcar; a lupa amplia. A 1ª é a capa do anúncio de origem (pode ter nome ou quantidade de outro produto).</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {fotos.map((u, i) => (
                  <div key={u} className={`relative rounded-lg border-2 overflow-hidden cursor-pointer ${sel.has(u) ? "border-primary" : "border-transparent"}`} onClick={() => alternar(u)}>
                    <img src={u} alt="" loading="lazy" className="aspect-square w-full object-cover bg-muted/30" />
                    <span className="absolute left-1.5 top-1.5 rounded bg-background/85 px-1.5 text-[11px] font-medium">{i === 0 ? "capa" : i + 1}</span>
                    {sel.has(u) && <span className="absolute right-1.5 top-1.5 rounded-full bg-primary text-primary-foreground p-0.5"><Check className="h-3.5 w-3.5" /></span>}
                    <a href={u} target="_blank" rel="noreferrer" className="absolute right-1.5 bottom-1.5 rounded bg-background/85 p-1" title="Ampliar (abre em outra aba)" onClick={(e) => e.stopPropagation()}>
                      <Search className="h-3.5 w-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            </>
          )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onFechar}>Fechar</Button>
          <Button disabled={!sel.size || copiando} onClick={() => void trazer()} className="gap-1.5">
            {copiando && <Loader2 className="h-4 w-4 animate-spin" />}Trazer {sel.size || ""} foto(s) para este anúncio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
