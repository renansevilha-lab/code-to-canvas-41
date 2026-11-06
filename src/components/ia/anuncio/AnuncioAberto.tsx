import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import type { IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// Anúncio aberto pela busca por ID em /ia/anuncios (06/nov/2026, pedido do dono): "ao jogar o ID de um anúncio
// da Shopee ou do Meli, já conseguir fazer alterações nesses anúncios no app seguindo a nossa lógica". A página
// abre no produto do anúncio, com a conferência do envio já no modo ATUALIZAR daquele anúncio (mesma função
// anuncio-publicar de sempre: prévia hoje → vai ficar e confirmação antes de mandar). Este cartão só diz qual
// anúncio está aberto e, se o produto ainda não tem rascunho, começa um com o título que está no ar.
// ============================================================================

const SHOP: Record<string, number> = { ottz: 522186766, svl: 759046323 };

type Info = { titulo: string; status: string | null; foto: string | null; preco: string | null; url: string | null };

async function lerAnuncio(canal: string, empresa: string, item: string): Promise<Info | null> {
  if (canal === "shopee") {
    const { data } = await supabaseExternal.from("shopee_anuncios")
      .select("nome, status, imagem_url, preco_min, preco_max").eq("item_id", item).eq("shop_id", SHOP[empresa] ?? 0).maybeSingle();
    if (!data) return null;
    const a = data.preco_min != null ? Number(data.preco_min) : null, b = data.preco_max != null ? Number(data.preco_max) : null;
    return {
      titulo: data.nome ?? item, status: data.status, foto: data.imagem_url ?? null,
      preco: a == null ? null : b != null && b !== a ? `${formatBRL(a)} a ${formatBRL(b)}` : formatBRL(a),
      url: `https://shopee.com.br/product/${SHOP[empresa]}/${item}`,
    };
  }
  if (canal === "mercado_livre") {
    const { data } = await supabaseExternal.from("ml_anuncios").select("titulo, status, foto, preco, permalink").eq("mlb", item).maybeSingle();
    if (!data) return null;
    return { titulo: data.titulo ?? item, status: data.status, foto: data.foto ?? null, preco: data.preco != null ? formatBRL(Number(data.preco)) : null, url: data.permalink ?? null };
  }
  return null;
}

export function AnuncioAberto({ item, canal, empresa, sku, rascunho, onCriado, onFechar }: {
  item: string; canal: string; empresa: string; sku: string; rascunho: IaRascunho | null;
  onCriado: (id: string) => void; onFechar: () => void;
}) {
  const qc = useQueryClient();
  const [criando, setCriando] = useState(false);
  const q = useQuery({
    queryKey: ["ia-anuncio", "anuncio-aberto", canal, empresa, item],
    staleTime: 60_000,
    queryFn: () => lerAnuncio(canal, empresa, item),
  });
  const info = q.data;
  const loja = canal === "shopee" ? `Shopee · ${empresa === "svl" ? "Bumi" : "Ottz"}` : canal === "mercado_livre" ? `Mercado Livre · ${empresa === "svl" ? "SVL" : "Ottz"}` : canal;

  // sem rascunho a conferência não aparece: começa um com o título que está no ar (descrição em branco)
  async function comecar() {
    setCriando(true);
    try {
      const { data, error } = await supabaseExternal.rpc("ia_rascunho_criar", { p_sku: sku, p_canal: canal, p_empresa: empresa });
      if (error) throw error;
      const id = String(data);
      if (info?.titulo) {
        const u = await supabaseExternal.from("ia_rascunho").update({ titulo: info.titulo }).eq("id", id);
        if (u.error) throw u.error;
      }
      await qc.invalidateQueries({ queryKey: ["ia-anuncio", "rascunhos", sku] });
      onCriado(id);
      toast.success("Rascunho criado com o título do anúncio", { description: "Escreva a descrição no bloco de texto, ou desmarque Descrição na conferência." });
    } catch (e) {
      toast.error("Não foi possível criar o rascunho", { description: (e as Error).message });
    } finally { setCriando(false); }
  }

  return (
    <Card className="border-primary/50 bg-primary/5"><CardContent className="p-3 space-y-2 text-sm">
      <div className="flex items-start gap-3">
        {info?.foto && <img src={info.foto} alt="" className="h-12 w-12 rounded object-cover shrink-0" loading="lazy" />}
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">Alterando o anúncio <span className="font-mono">{item}</span> · {loja}</div>
          {q.isLoading ? <span className="text-muted-foreground"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> lendo…</span>
            : info ? (
              <div className="font-medium truncate" title={info.titulo}>
                {info.titulo}
                {info.preco && <span className="ml-2 font-normal text-muted-foreground">{info.preco}</span>}
                {info.status && !["NORMAL", "active"].includes(info.status) && <span className="ml-2 text-xs font-normal text-amber-600">fora do ar</span>}
              </div>
            ) : <div className="text-muted-foreground">Este anúncio não está no espelho desta loja — a conferência lê o marketplace ao vivo.</div>}
        </div>
        {info?.url && <a href={info.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Abrir no marketplace"><ExternalLink className="h-4 w-4" /></a>}
        <button type="button" onClick={onFechar} className="text-muted-foreground hover:text-foreground" title="Fechar"><X className="h-4 w-4" /></button>
      </div>
      {rascunho ? (
        <p className="text-xs text-muted-foreground">
          A conferência do envio (bloco "Enviar anúncio", mais abaixo) já abre neste anúncio, no modo <b>Atualizar</b>: marque o que mudar
          (título, descrição, fotos, preço), veja o hoje → vai ficar e confirme. O texto e as fotos que vão são os deste rascunho.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Este produto ainda não tem rascunho no app. Para alterar o anúncio, comece um com o título que está no ar:</span>
          <Button size="sm" className="h-7 text-xs" disabled={criando || q.isLoading} onClick={comecar}>
            {criando && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Começar com o título do anúncio
          </Button>
        </div>
      )}
    </CardContent></Card>
  );
}
