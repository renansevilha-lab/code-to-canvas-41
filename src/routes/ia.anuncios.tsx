import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ImageOff, Loader2, Search, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { ROTULO_ETAPA, nomeCanal, type IaEtapa, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// /ia/anuncios — rascunhos de anúncio gerados na gestão (Fase 2) + "novo anúncio"
// buscando o produto no catálogo (busca no banco, não no navegador).
// ============================================================================

export const Route = createFileRoute("/ia/anuncios")({ component: AnunciosPage });

type ProdutoBusca = { sku: string; nome: string; marca: string | null; foto: string | null };

function AnunciosPage() {
  const rascQ = useQuery({
    queryKey: ["ia-anuncio", "lista"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("ia_rascunho")
        .select("id, sku, canal, empresa, status, titulo, preco_sugerido, preco_aprovado, criado_por_nome, created_at, updated_at")
        .order("updated_at", { ascending: false }).limit(200);
      if (error) throw error;
      const lista = (data ?? []) as IaRascunho[];
      const ids = lista.map((x) => x.id); const skus = [...new Set(lista.map((x) => x.sku))];
      const [et, pr] = await Promise.all([
        ids.length ? supabaseExternal.from("ia_etapa").select("rascunho_id, etapa, status").in("rascunho_id", ids) : Promise.resolve({ data: [] }),
        skus.length ? supabaseExternal.from("ia_produto").select("sku, nome, foto").in("sku", skus) : Promise.resolve({ data: [] }),
      ]);
      const etapas = (et.data ?? []) as Pick<IaEtapa, "rascunho_id" | "etapa" | "status">[];
      const prod = new Map(((pr.data ?? []) as { sku: string; nome: string; foto: string | null }[]).map((p) => [p.sku, p]));
      return lista.map((x) => {
        const es = etapas.filter((e) => e.rascunho_id === x.id);
        const imgs = es.filter((e) => e.etapa === "imagem");
        return {
          ...x, produto: prod.get(x.sku),
          texto: es.find((e) => e.etapa === "texto")?.status,
          imgs: imgs.length, imgsAprovadas: imgs.filter((e) => e.status === "aprovado").length,
          imgsAndando: imgs.filter((e) => e.status === "na_fila" || e.status === "gerando").length,
        };
      });
    },
  });

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Anúncios com IA</h1>
        <p className="text-sm text-muted-foreground">Gere título, descrição, preço e fotos a partir da foto real e dos contextos do produto. O envio ao Tiny vem na próxima fase.</p>
      </header>

      <NovoAnuncio />

      <Card className="overflow-hidden">
        {rascQ.isLoading ? (
          <div className="p-10 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</div>
        ) : rascQ.isError ? (
          <div className="p-10 text-center text-destructive">Falha: {(rascQ.error as Error).message}</div>
        ) : !rascQ.data?.length ? (
          <div className="p-10 text-center text-muted-foreground">Nenhum anúncio gerado ainda.</div>
        ) : (
          <div className="divide-y">
            {rascQ.data.map((x) => {
              const st = x.texto ? ROTULO_ETAPA[x.texto] : null;
              return (
                <Link key={x.id} to="/ia/gerar" search={{ sku: x.sku, canal: x.canal, empresa: x.empresa, r: x.id }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30">
                  <div className="h-11 w-11 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                    {x.produto?.foto ? <img src={x.produto.foto} alt="" className="h-full w-full object-cover" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{x.titulo ?? x.produto?.nome ?? x.sku}</div>
                    <div className="text-[11px] text-muted-foreground">
                      <span className="font-mono">{x.sku}</span> · {nomeCanal(x.canal)} · {x.empresa === "svl" ? "SVL" : "Ottz"}
                      {x.criado_por_nome && <> · {x.criado_por_nome}</>} · {new Date(x.updated_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <span className="text-xs font-mono w-20 text-right">{x.preco_aprovado ?? x.preco_sugerido ? formatBRL(Number(x.preco_aprovado ?? x.preco_sugerido)) : "—"}</span>
                  {st && <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded w-24 text-center" style={{ background: `${st.cor}18`, color: st.cor }}>texto {st.rotulo}</span>}
                  <Badge variant="outline" className="text-[10.5px] w-28 justify-center">
                    {x.imgsAndando ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />{x.imgsAndando} gerando</> : `${x.imgsAprovadas}/${x.imgs} fotos ok`}
                  </Badge>
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function NovoAnuncio() {
  const [q, setQ] = useState("");
  const [termo, setTermo] = useState("");
  useEffect(() => { const t = setTimeout(() => setTermo(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const buscaQ = useQuery({
    queryKey: ["ia-anuncio", "busca", termo],
    enabled: termo.length >= 2,
    queryFn: async (): Promise<ProdutoBusca[]> => {
      const seguro = termo.replace(/[%,()]/g, " ");
      const { data, error } = await supabaseExternal.from("ia_produto").select("sku, nome, marca, foto")
        .or(`sku.eq.${seguro},nome.ilike.%${seguro}%`).limit(12);
      if (error) throw error;
      return (data ?? []) as ProdutoBusca[];
    },
  });
  return (
    <Card><CardContent className="p-4 space-y-2">
      <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><b className="text-sm">Novo anúncio</b></div>
      <div className="relative max-w-md">
        <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU ou nome do produto" />
      </div>
      {termo.length >= 2 && (
        <div className="rounded-md border divide-y max-w-2xl">
          {buscaQ.isLoading ? <div className="p-3 text-sm text-muted-foreground">Buscando…</div>
            : !buscaQ.data?.length ? <div className="p-3 text-sm text-muted-foreground">Nada encontrado.</div>
            : buscaQ.data.map((p) => (
              <div key={p.sku} className="flex items-center gap-2.5 px-3 py-1.5">
                <div className="h-9 w-9 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                  {p.foto ? <img src={p.foto} alt="" className="h-full w-full object-cover" /> : <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1 text-sm">
                  <div className="truncate">{p.nome}</div>
                  <div className="text-[11px] text-muted-foreground font-mono">{p.sku}{p.marca ? ` · ${p.marca}` : ""}</div>
                </div>
                <Button asChild size="sm" className="h-7"><Link to="/ia/gerar" search={{ sku: p.sku, canal: "shopee", empresa: "ottz" }}>Gerar</Link></Button>
              </div>
            ))}
        </div>
      )}
    </CardContent></Card>
  );
}
