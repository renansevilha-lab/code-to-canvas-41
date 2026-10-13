import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Images, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { DialogoTrazer } from "@/components/ia/anuncio/Aproveitar";
import { chamarAproveitar, nomeCanal, nomeEmpresa, urlsAssinadas, type IaFonte, type IaFontes, type IaRascunho, type StatusEtapa } from "@/lib/iaAnuncio";

// ============================================================================
// "Usar fotos de outro anúncio" (13/out/2026, pedido do dono): as fotos já feitas para um produto
// parecido (ex.: o Granulado de 2 kg) servem a outro, sem gerar de novo. O bloco "Aproveitar" só
// enxerga a família de KIT (produto base e os kits dele); este mostra QUALQUER anúncio que já tem
// fotos — os mais parecidos pelo nome primeiro, com busca por nome ou SKU. A cópia é a mesma do
// Aproveitar (edge fn `ia-aproveitar?modulo=aplicar`): só dentro da gestão, sem IA e sem custo.
// ============================================================================

const SEM_PESO = new Set(["para", "com", "dos", "das", "kit", "por", "sem", "the", "und", "unidades", "unidade"]);
/** Palavras que identificam o produto (sem acento, minúsculas); número com unidade ("2kg") pesa mais. */
function palavras(texto: string): string[] {
  return [...new Set(texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/(\d)\s+(kg|g|ml|l|un)\b/g, "$1$2")
    .split(/[^a-z0-9]+/).filter((p) => (p.length >= 3 || /\d/.test(p)) && !SEM_PESO.has(p)))];
}
const peso = (p: string) => (/\d/.test(p) ? 2 : 1);

interface Linha { id: string; sku: string; canal: string; empresa: string; titulo: string | null; updated_at: string }

export function FotosDeOutros({ sku, nome, canal, empresa, rascunho, onDestino }: {
  sku: string; nome: string; canal: string; empresa: string; rascunho: IaRascunho | null; onDestino: (id: string) => void;
}) {
  const [busca, setBusca] = useState("");
  const [trazer, setTrazer] = useState<IaFonte | null>(null);
  // a mesma consulta do bloco Aproveitar (mesma chave): o que este anúncio já tem e quem é da família de kit
  const fontesQ = useQuery({
    queryKey: ["ia-anuncio", "aproveitar", sku, canal, empresa, rascunho?.id ?? ""],
    enabled: !!sku,
    queryFn: async () => (await chamarAproveitar("fontes", { sku, canal, empresa, destino_id: rascunho?.id })) as IaFontes,
  });
  const baseQ = useQuery({
    queryKey: ["ia-anuncio", "outros-anuncios"],
    staleTime: 2 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("ia_rascunho").select("id, sku, canal, empresa, titulo, updated_at").order("updated_at", { ascending: false }).limit(400);
      if (error) throw error;
      const rs = (data ?? []) as Linha[];
      const skus = [...new Set(rs.map((r) => r.sku))];
      const nomes: Record<string, string> = {};
      for (let i = 0; i < skus.length; i += 200) {
        const { data: ps } = await supabaseExternal.from("produtos").select("sku, nome").in("sku", skus.slice(i, i + 200));
        for (const p of (ps ?? []) as { sku: string; nome: string | null }[]) nomes[p.sku] = p.nome ?? p.sku;
      }
      return { rs, nomes };
    },
  });

  // candidatos: fora este produto e a família de kit (essa já aparece no bloco de cima); os mais parecidos primeiro
  const candidatos = useMemo(() => {
    const fora = new Set([sku, ...(fontesQ.data?.familia ?? []).map((f) => f.sku)]);
    const meu = palavras(nome);
    const termos = palavras(busca);
    const cru = busca.trim().toLowerCase();
    return (baseQ.data?.rs ?? []).filter((r) => !fora.has(r.sku)).map((r) => {
      const dele = new Set(palavras(`${baseQ.data?.nomes[r.sku] ?? ""} ${r.titulo ?? ""}`));
      return { r, pontos: meu.filter((p) => dele.has(p)).reduce((s, p) => s + peso(p), 0), dele };
    }).filter((x) => !cru || x.r.sku.toLowerCase().includes(cru) || termos.every((t) => [...x.dele].some((p) => p.includes(t))))
      .sort((a, z) => z.pontos - a.pontos || z.r.updated_at.localeCompare(a.r.updated_at)).slice(0, 30);
  }, [baseQ.data, fontesQ.data, sku, nome, busca]);

  const ids = candidatos.map((c) => c.r.id);
  const fotosQ = useQuery({
    queryKey: ["ia-anuncio", "outros-anuncios-fotos", ids.join(",")],
    enabled: ids.length > 0,
    staleTime: 2 * 60_000,
    placeholderData: (anterior) => anterior,
    queryFn: async () => {
      const [im, et] = await Promise.all([
        supabaseExternal.from("ia_rascunho_imagem").select("id, rascunho_id, ordem, tipo, storage_path").in("rascunho_id", ids).not("storage_path", "is", null).order("ordem").limit(1000),
        supabaseExternal.from("ia_etapa").select("imagem_id, status").in("rascunho_id", ids).eq("etapa", "imagem").limit(1000),
      ]);
      const situacao = new Map(((et.data ?? []) as { imagem_id: string; status: StatusEtapa }[]).map((e) => [String(e.imagem_id), e.status]));
      const imagens = ((im.data ?? []) as { id: string; rascunho_id: string; ordem: number; tipo: string | null; storage_path: string }[])
        .map((i) => ({ id: String(i.id), rascunho_id: i.rascunho_id, ordem: Number(i.ordem), tipo: String(i.tipo ?? ""), storage_path: i.storage_path, status: situacao.get(String(i.id)) ?? null }));
      const amostra = [...new Set(ids.flatMap((id) => imagens.filter((i) => i.rascunho_id === id).slice(0, 5).map((i) => i.storage_path)))];
      const urls = await urlsAssinadas(amostra).catch(() => ({} as Record<string, string>));
      return { imagens, urls };
    },
  });

  const fontes: (IaFonte & { pontos: number })[] = candidatos.map((c) => {
    const imagens = (fotosQ.data?.imagens ?? []).filter((i) => i.rascunho_id === c.r.id).map(({ rascunho_id: _r, ...i }) => i);
    return {
      rascunho_id: c.r.id, sku: c.r.sku, nome: baseQ.data?.nomes[c.r.sku] ?? c.r.sku, relacao: "irmao" as const, quantidade: null, n_componentes: 0,
      canal: c.r.canal, empresa: c.r.empresa, atualizado: c.r.updated_at,
      texto: c.r.titulo ? { status: null, titulo: c.r.titulo, n_titulo: c.r.titulo.length } : null, imagens, pontos: c.pontos,
    };
  }).filter((f) => f.imagens.length > 0).slice(0, 12);

  const carregando = baseQ.isLoading || (ids.length > 0 && fotosQ.isLoading);
  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Images className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold">Usar fotos de outro anúncio</h3>
        <span className="text-xs text-muted-foreground">as fotos já feitas para um produto parecido servem a este, sem gerar de novo e sem custo de IA</span>
        {(baseQ.isFetching || fotosQ.isFetching) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="relative max-w-md">
        <Search className="h-4 w-4 absolute left-2.5 top-2 text-muted-foreground" />
        <Input className="h-8 pl-8 text-sm" placeholder="Buscar por nome ou SKU (em branco: os mais parecidos com este produto)" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>

      {baseQ.isError ? <p className="text-sm text-destructive">Não consegui ler os outros anúncios: {(baseQ.error as Error).message}</p>
        : carregando ? <p className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Procurando anúncios com fotos…</p>
        : fontes.length === 0 ? <p className="text-sm text-muted-foreground">{busca.trim() ? "Nenhum anúncio com fotos para essa busca." : "Ainda não há outro anúncio com fotos."}</p>
        : (
          <div className="divide-y rounded-md border">
            {fontes.map((f) => {
              const aprovadas = f.imagens.filter((i) => i.status === "aprovado").length;
              return (
                <div key={f.rascunho_id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
                  <div className="flex gap-1 shrink-0">
                    {f.imagens.slice(0, 5).map((i) => (
                      <div key={i.id} className="h-12 w-12 rounded border overflow-hidden bg-muted/30">
                        {fotosQ.data?.urls[i.storage_path] && <img src={fotosQ.data.urls[i.storage_path]} alt="" loading="lazy" className="h-full w-full object-cover" />}
                      </div>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1 basis-[220px]">
                    <div className="truncate" title={f.nome}><span className="font-mono text-xs text-muted-foreground mr-1.5">{f.sku}</span>{f.nome}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {nomeCanal(f.canal)} · {nomeEmpresa(f.empresa)} · {f.imagens.length} foto(s), {aprovadas} aprovada(s)
                      {!busca.trim() && f.pontos > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · parecido com este</span>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={!fontesQ.data} onClick={() => setTrazer(f)}>
                    <ArrowDownToLine className="h-3.5 w-3.5" />Escolher fotos
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      <p className="text-[11px] text-muted-foreground">
        Na escolha, as capas vêm desmarcadas (a capa de outro produto pode mostrar nome, peso ou quantidade diferentes): marque só se servir. As fotos entram neste anúncio já aprovadas e valem para criar ou atualizar em qualquer marketplace.
      </p>

      {trazer && fontesQ.data && (
        <DialogoTrazer fonte={trazer} dados={fontesQ.data} sku={sku} canal={canal} empresa={empresa} rascunho={rascunho}
          onFechar={() => setTrazer(null)} onDestino={onDestino} />
      )}
    </CardContent></Card>
  );
}
