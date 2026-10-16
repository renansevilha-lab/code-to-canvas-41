import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { ProdutoTopo, type ProdutoIa } from "@/components/ia/anuncio/ProdutoTopo";
import { EtapaTexto } from "@/components/ia/anuncio/EtapaTexto";
import { EtapaFotos } from "@/components/ia/anuncio/EtapaFotos";
import { FotosVariacoes } from "@/components/ia/anuncio/FotosVariacoes";
import { AnaliseProduto } from "@/components/ia/anuncio/AnaliseProduto";
import { PrecoPromocao } from "@/components/ia/anuncio/PrecoPromocao";
import { VariacoesShopee } from "@/components/ia/anuncio/VariacoesShopee";
import { AmpliarVariacoes } from "@/components/ia/anuncio/AmpliarVariacoes";
import { PromocaoNoEnvio } from "@/components/ia/anuncio/PromocaoNoEnvio";
import { FotosDeOutros } from "@/components/ia/anuncio/FotosDeOutros";
import { PainelPreco } from "@/components/ia/anuncio/PainelPreco";
import { Aproveitar } from "@/components/ia/anuncio/Aproveitar";
import { Publicar } from "@/components/ia/anuncio/Publicar";
import { Referencias } from "@/components/ia/anuncio/Referencias";
import {
  CANAIS, nomeCanal, type IaBriefing, type IaEtapa, type IaProdutoExtra, type IaPromptImagem, type IaRascunho, type IaRascunhoImagem,
} from "@/lib/iaAnuncio";

// ============================================================================
// /ia/gerar?sku= — gerar anúncio com IA dentro da gestão (Fase 2, 09/out/2026).
// Blocos: produto → preço (taxas reais dos pedidos, não depende da IA) → texto →
// fotos (prompts → imagens na fila → revisão) → enviar ao marketplace. O bloco "Aproveitar" traz texto e
// fotos de outro anúncio (outro canal ou a família de kit) sem gerar de novo. Entrada pela lista /ia/anuncios
// (catálogo ativo) ou pelo botão "Gerar anúncio" do Catálogo. O envio ao Tiny
// é a Fase 3 — aqui aprovar só marca a etapa.
// ============================================================================

type Aba = "fotos" | "analise" | "preco";
type Busca = { sku: string; canal: string; empresa: string; r?: string; aba?: Aba };
// abas da página (na URL): o anúncio em si, a análise do produto e o preço/promoção nos marketplaces
const ABAS: { id: Aba | undefined; rotulo: string }[] = [
  { id: undefined, rotulo: "Anúncio" },
  { id: "fotos", rotulo: "Fotos" },
  { id: "analise", rotulo: "Análise" },
  { id: "preco", rotulo: "Preço e promoção" },
];

export const Route = createFileRoute("/ia/gerar")({
  validateSearch: (s: Record<string, unknown>): Busca => ({
    sku: String(s.sku ?? ""),
    canal: CANAIS.some((c) => c.id === s.canal) ? String(s.canal) : "shopee",
    empresa: s.empresa === "svl" ? "svl" : "ottz",
    r: typeof s.r === "string" && s.r ? s.r : undefined,
    aba: s.aba === "fotos" || s.aba === "analise" || s.aba === "preco" ? s.aba : undefined,
  }),
  component: GerarAnuncioPage,
});

function useVisivel() {
  const [v, setV] = useState(typeof document === "undefined" ? true : !document.hidden);
  useEffect(() => {
    const f = () => setV(!document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return v;
}

function GerarAnuncioPage() {
  const { sku, canal, empresa, r, aba } = Route.useSearch();
  const nav = useNavigate({ from: "/ia/gerar" });
  const visivel = useVisivel();
  // `resetScroll: false`: trocar de destino ou de aba não pode jogar a tela para o topo (13/out — parecia
  // que o anúncio tinha de ser aprovado de novo); texto e fotos são os mesmos, só o destino muda.
  const set = (p: Partial<Busca>) => void nav({ search: (s: Busca) => ({ ...s, ...p }), replace: true, resetScroll: false });

  const produtoQ = useQuery({
    queryKey: ["ia-anuncio", "produto", sku],
    enabled: !!sku,
    queryFn: async () => {
      const [p, cmv, ex, capa] = await Promise.all([
        supabaseExternal.from("ia_produto").select("sku, nome, marca, categoria_caminho, tipo, foto").eq("sku", sku).maybeSingle(),
        supabaseExternal.from("view_cmv_efetivo").select("cmv_efetivo").eq("sku", sku).maybeSingle(),
        supabaseExternal.from("ia_produto_extra").select("*").eq("sku", sku).maybeSingle(),
        // a foto do catálogo só é refeita a cada 3 h: a do cadastro (Tiny) vale na hora
        supabaseExternal.from("produtos").select("foto_capa").eq("sku", sku).maybeSingle(),
      ]);
      if (p.error) throw p.error;
      return {
        produto: (p.data ? { ...(p.data as ProdutoIa), foto: (p.data as ProdutoIa).foto ?? (capa.data?.foto_capa as string | null) ?? null } : null) as ProdutoIa | null,
        custo: cmv.data?.cmv_efetivo != null ? Number(cmv.data.cmv_efetivo) : null,
        extra: (ex.data ?? null) as IaProdutoExtra | null,
      };
    },
  });
  const rascunhosQ = useQuery({
    queryKey: ["ia-anuncio", "rascunhos", sku],
    enabled: !!sku,
    queryFn: async (): Promise<IaRascunho[]> => {
      const { data, error } = await supabaseExternal.from("ia_rascunho").select("*").eq("sku", sku).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return (data ?? []) as IaRascunho[];
    },
  });
  // UM anúncio por produto (12/out): sem rascunho exato deste canal, abre o mais recente do produto —
  // o canal/empresa da tela é só o DESTINO (preço e envio); texto e fotos são os mesmos.
  const lista = rascunhosQ.data ?? [];
  const rascunho = lista.find((x) => (r ? x.id === r : x.canal === canal && x.empresa === empresa)) ?? (r ? null : lista[0] ?? null);

  const etapasQ = useQuery({
    queryKey: ["ia-anuncio", "etapas", rascunho?.id],
    enabled: !!rascunho,
    queryFn: async () => {
      const [e, i] = await Promise.all([
        supabaseExternal.from("ia_etapa").select("*").eq("rascunho_id", rascunho!.id),
        supabaseExternal.from("ia_rascunho_imagem").select("*").eq("rascunho_id", rascunho!.id).order("ordem"),
      ]);
      if (e.error) throw e.error;
      return { etapas: (e.data ?? []) as IaEtapa[], imagens: (i.data ?? []) as IaRascunhoImagem[] };
    },
    // polling só enquanto há imagem na fila/gerando e a aba está visível
    refetchInterval: (q) => {
      const d = q.state.data as { etapas: IaEtapa[] } | undefined;
      return visivel && d?.etapas.some((x) => x.status === "na_fila" || x.status === "gerando") ? 3000 : false;
    },
  });
  const apoioQ = useQuery({
    queryKey: ["ia-anuncio", "apoio", sku, canal],
    enabled: !!sku,
    placeholderData: (anterior) => anterior,
    queryFn: async () => {
      const [b, pr, tp, cf, md] = await Promise.all([
        supabaseExternal.from("ia_briefing").select("*").eq("sku", sku).maybeSingle(),
        supabaseExternal.from("ia_prompt_imagem").select("*").eq("sku", sku),
        supabaseExternal.from("ia_prompt_template").select("nome").eq("ativo", true).eq("tipo", "imagem"),
        supabaseExternal.from("ia_canal_config").select("regras_extras").eq("canal", canal).maybeSingle(),
        supabaseExternal.from("ia_modelo_imagem").select("id, label, custo_estimado_usd, padrao").eq("ativo", true).order("ordem"),
      ]);
      return {
        briefing: (b.data ?? null) as IaBriefing | null,
        prompts: (pr.data ?? []) as IaPromptImagem[],
        tipos: [...new Set(((tp.data ?? []) as { nome: string }[]).map((t) => t.nome))].sort(),
        plano: ((cf.data as any)?.regras_extras?.plano_fotos ?? []) as string[],
        modelos: (md.data ?? []) as { id: string; label: string; custo_estimado_usd: number; padrao: boolean }[],
      };
    },
  });

  if (!sku) {
    return (
      <div className="p-6 md:p-10 max-w-3xl mx-auto">
        <p className="text-muted-foreground">Escolha um produto no <Link to="/produtos" className="underline">Catálogo</Link> ou em <Link to="/ia/anuncios" className="underline">Anúncios</Link>.</p>
      </div>
    );
  }
  if (produtoQ.isLoading) return <div className="p-10 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Carregando…</div>;
  const dados = produtoQ.data;
  if (!dados?.produto) return <div className="p-10 text-center text-muted-foreground">SKU {sku} não está no catálogo.</div>;

  const etapas = etapasQ.data?.etapas ?? [];
  const outros = (rascunhosQ.data ?? []).filter((x) => x.id !== rascunho?.id);
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="ghost" className="gap-1"><Link to="/ia/anuncios"><ArrowLeft className="h-4 w-4" />Anúncios</Link></Button>
        <h1 className="text-2xl font-bold tracking-tight">Gerar anúncio</h1>
        <span className="text-sm text-muted-foreground">· {nomeCanal(canal)} · {empresa === "svl" ? "SVL" : "Ottz/ACZ"}</span>
      </div>

      <ProdutoTopo key={sku} produto={dados.produto} custo={dados.custo} extra={dados.extra} canal={canal} empresa={empresa}
        onCanal={(c) => set({ canal: c, r: rascunho?.id })} onEmpresa={(e) => set({ empresa: e, r: rascunho?.id })} />

      <div className="flex flex-wrap gap-1 border-b">
        {ABAS.map((x) => (
          <button key={x.rotulo} type="button" onClick={() => set({ aba: x.id })}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${aba === x.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {x.rotulo}
          </button>
        ))}
      </div>

      {aba === "fotos" && (<>
        {/* 1) o que já existe: fotos da família de kit e de qualquer outro anúncio parecido */}
        {r !== "novo" && (
          <Aproveitar key={`apr-${sku}`} sku={sku} canal={canal} empresa={empresa} rascunho={rascunho}
            imagens={etapasQ.data?.imagens ?? []} etapas={etapas} onDestino={(id) => set({ r: id })} />
        )}
        <FotosDeOutros key={`fo-${sku}`} sku={sku} nome={dados.produto.nome ?? ""} canal={canal} empresa={empresa}
          rascunho={r === "novo" ? null : rascunho} onDestino={(id) => set({ r: id })} />

        {/* 2) as fotos deste anúncio: gerar com IA e revisar */}
        {rascunho && r !== "novo" && apoioQ.data ? (
          <EtapaFotos key={`ef-${sku}`} sku={sku} canal={canal} ehKit={dados.produto.tipo === "K"} rascunho={rascunho}
            ehPai={dados.produto.tipo === "V"} nomeProduto={dados.produto.nome ?? ""}
            briefing={apoioQ.data.briefing} prompts={apoioQ.data.prompts} imagens={etapasQ.data?.imagens ?? []} etapas={etapas}
            tiposAtivos={apoioQ.data.tipos} planoCanal={apoioQ.data.plano} modelos={apoioQ.data.modelos} />
        ) : (
          <Card><CardContent className="p-4 text-sm text-muted-foreground">
            Para GERAR fotos com IA, crie antes o texto na aba Anúncio (a IA usa o briefing do produto). Para usar fotos prontas de outro anúncio não precisa: escolha acima e o anúncio é criado com elas.
          </CardContent></Card>
        )}

        {/* produto com variações (pai): uma foto por variação, com a quantidade de embalagens de cada uma */}
        {dados.produto.tipo === "V" && apoioQ.data && (
          <FotosVariacoes key={`fv-${sku}`} sku={sku} nomePai={dados.produto.nome ?? ""} canal={canal} empresa={empresa}
            briefing={apoioQ.data.briefing} tiposAtivos={apoioQ.data.tipos} modelos={apoioQ.data.modelos} />
        )}
      </>)}
      {aba === "analise" && <AnaliseProduto key={`an-${sku}`} sku={sku} />}
      {aba === "preco" && <PrecoPromocao key={`pp-${sku}`} sku={sku} empresa={empresa} />}

      {!aba && (<>
      {outros.length > 0 && (
        <Card><CardContent className="p-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Outros rascunhos deste SKU:</span>
          {outros.slice(0, 8).map((x) => (
            <Button key={x.id} size="sm" variant="outline" className="h-6 text-[11px]"
              onClick={() => set({ r: x.id, canal: x.canal, empresa: x.empresa })}>
              {nomeCanal(x.canal)} · {new Date(x.created_at).toLocaleDateString("pt-BR")}
            </Button>
          ))}
          {rascunho && <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => set({ r: "novo" })}>+ novo rascunho neste canal</Button>}
        </CardContent></Card>
      )}

      <PainelPreco sku={sku} canal={canal} empresa={empresa} rascunho={r === "novo" ? null : rascunho} />

      <Referencias key={`ref-${sku}`} sku={sku} marca={dados.produto.marca} />

      <EtapaTexto sku={sku} canal={canal} empresa={empresa} rascunho={r === "novo" ? null : rascunho}
        etapa={etapas.find((e) => e.etapa === "texto")} briefing={apoioQ.data?.briefing ?? null}
        onCriado={(id) => set({ r: id })} />

      {/* as fotos têm aba própria: aqui fica só o resumo e o atalho */}
      <Card><CardContent className="p-4 flex flex-wrap items-center gap-3 text-sm">
        <b>2 · Fotos</b>
        {(() => {
          const comArquivo = (etapasQ.data?.imagens ?? []).filter((i) => i.storage_path);
          const aprovadas = comArquivo.filter((i) => etapas.some((e) => e.imagem_id === i.id && e.status === "aprovado")).length;
          return <span className="text-muted-foreground">{comArquivo.length === 0 ? "este anúncio ainda não tem fotos" : `${aprovadas} aprovada(s) de ${comArquivo.length}`} — gerar, revisar ou usar as de outro anúncio</span>;
        })()}
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => set({ aba: "fotos" })}>Abrir a aba Fotos</Button>
      </CardContent></Card>

      {/* produto pai na Shopee: as opções (variações) que entram no anúncio assim que ele é criado pelo envio abaixo */}
      {dados.produto.tipo === "V" && canal === "shopee" && (
        <VariacoesShopee key={`vs-${sku}`} sku={sku} nomePai={dados.produto.nome ?? ""} empresa={empresa} />
      )}
      {/* anúncio que já está rodando: acrescentar opções e ligar a um pai no Tiny (16/out) */}
      {canal === "shopee" && <AmpliarVariacoes key={`av-${sku}`} sku={sku} empresa={empresa} />}

      {rascunho && r !== "novo" && (
        <Publicar rascunho={rascunho} canal={canal} empresa={empresa} onDestino={(c, e) => set({ canal: c, empresa: e, r: rascunho.id })}
          noEnvio={<PromocaoNoEnvio key={`pe-${sku}-${empresa}`} sku={sku} nome={dados.produto.nome ?? ""} empresa={empresa} comVariacoes={dados.produto.tipo === "V"} />} />
      )}
      </>)}
    </div>
  );
}
