import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Termos de busca (20/out/2026, pedido do dono): o que os compradores REALMENTE
// digitam, para o título e o texto do anúncio.
// - Shopee: volume mensal da API de anúncios patrocinados (sugestão de palavras
//   por anúncio do produto, tabela shopee_palavras).
// - Amazon: posição no relatório de buscas (Brand Analytics, só a conta ACZ).
// - Mercado Livre: termos em alta das categorias em que vendemos (sem volume).
// Tudo vem pronto da RPC ia_termos_busca: "confirmado" = todas as palavras do
// termo já são do vocabulário do produto (nome, categoria, textos); "a conferir"
// só entra se a foto/rótulo confirmar; marca de outro fabricante nunca.
// A IA de texto recebe os confirmados (ia-anuncio v5); o envio usa as palavras
// que o título não cobre na Amazon (palavras escondidas) e no Modelo do ML.
// ============================================================================

interface Termo { termo: string; volume?: number | null; rank?: number | null; posicao?: number | null; no_titulo: boolean; confirmado: boolean; concorrente?: boolean }
interface Termos {
  erro?: string; nucleo?: string | null;
  shopee: Termo[]; amazon: Termo[]; ml: Termo[];
  palavras_ocultas: string; modelo_sugerido: string;
  cobertura: { total: number; no_titulo: number };
  fontes: { shopee_em: string | null; shopee_itens: number; amazon_semana: string | null; ml_categorias: number; ml_em: string | null };
}

const LOJAS = ["ottz", "svl"] as const;
const FONTES = [
  { k: "shopee" as const, canal: "shopee", nome: "Shopee", medida: "buscas/mês" },
  { k: "amazon" as const, canal: "amazon", nome: "Amazon", medida: "posição no ranking" },
  { k: "ml" as const, canal: "mercado_livre", nome: "Mercado Livre", medida: "em alta" },
];
const VELHO_DIAS = 30;

export function TermosBusca({ sku, canal, titulo }: { sku: string; canal: string; titulo: string | null }) {
  const [verTodos, setVerTodos] = useState(false);
  const [lendo, setLendo] = useState(false);
  const tentou = useRef(false);
  const q = useQuery({
    queryKey: ["ia-termos-busca", sku, titulo ?? ""],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("ia_termos_busca" as never, { p_sku: sku, p_titulo: titulo || null } as never);
      if (error) throw new Error(error.message);
      return data as unknown as Termos;
    },
  });
  const t = q.data;

  async function atualizarShopee(silencioso = false) {
    setLendo(true);
    try {
      let gravadas = 0; const erros: string[] = [];
      for (const loja of LOJAS) {
        const { data, error } = await supabaseExternal.functions.invoke("shopee-flashsale-probe", { body: { modulo: "palavras-sku", loja, sku } });
        if (error) { erros.push(`${loja}: ${error.message}`); continue; }
        gravadas += Number((data as { gravadas?: number })?.gravadas ?? 0);
        for (const e of ((data as { erros?: string[] })?.erros ?? [])) erros.push(`${loja}: ${e}`);
      }
      await q.refetch();
      if (!silencioso) {
        if (gravadas) toast.success(`Palavras da Shopee atualizadas (${gravadas})`);
        else toast.info("A Shopee não devolveu palavras para os anúncios deste produto", { description: erros.join(" · ") || undefined });
      }
    } catch (e) {
      if (!silencioso) toast.error("Não consegui ler as palavras da Shopee", { description: (e as Error).message });
    } finally {
      setLendo(false);
    }
  }

  // a sugestão da Shopee é leitura pura: se o produto tem anúncio e o dado falta ou está velho, busca sozinho (1× por tela)
  useEffect(() => {
    if (!t || tentou.current || t.erro) return;
    const velho = !t.fontes.shopee_em || Date.now() - Date.parse(t.fontes.shopee_em) > VELHO_DIAS * 86_400_000;
    if (t.fontes.shopee_itens > 0 && velho) { tentou.current = true; void atualizarShopee(true); }
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps

  const copiar = (s: string) => { void navigator.clipboard.writeText(s); toast.success("Copiado"); };

  if (q.isLoading) return <Card><CardContent className="p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Lendo os termos de busca…</CardContent></Card>;
  if (q.isError) return <Card><CardContent className="p-4 text-sm text-destructive">Termos de busca: {(q.error as Error).message}</CardContent></Card>;
  if (!t || t.erro) return null;

  const ordem = [...FONTES].sort((a, b) => (a.canal === canal ? -1 : b.canal === canal ? 1 : 0));
  const total = t.shopee.length + t.amazon.length + t.ml.length;
  const limite = verTodos ? 50 : 12;
  const valor = (k: "shopee" | "amazon" | "ml", x: Termo) =>
    k === "shopee" ? (x.volume ? Number(x.volume).toLocaleString("pt-BR") : "") : k === "amazon" ? (x.rank ? `#${x.rank.toLocaleString("pt-BR")}` : "") : "";

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <b className="text-sm">Termos de busca</b>
          {titulo && t.cobertura.total > 0 && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${t.cobertura.no_titulo / t.cobertura.total >= 0.6 ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400"}`}>
              o título cobre {t.cobertura.no_titulo} de {t.cobertura.total} termos fortes
            </span>
          )}
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={lendo} onClick={() => void atualizarShopee()}>
            {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Atualizar palavras da Shopee
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          O que os compradores digitam, com o marketplace deste anúncio primeiro. A IA usa os <b>confirmados</b> no título e no texto;
          os <b>a conferir</b> só se a foto ou o rótulo confirmarem. <span className="inline-flex items-center gap-0.5"><Check className="h-3 w-3 text-emerald-600" />= já está no título</span>.
        </p>

        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum termo achado para este produto ainda
            {t.fontes.shopee_itens === 0 ? " (sem anúncio na Shopee para pedir a sugestão de palavras)" : ""}.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {ordem.map((f) => {
              const lista = t[f.k];
              return (
                <div key={f.k} className="min-w-0 space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {f.nome} <span className="normal-case">· {f.medida}</span>
                    {f.k === "shopee" && t.fontes.shopee_em && <span className="normal-case"> · lido {new Date(t.fontes.shopee_em).toLocaleDateString("pt-BR")}</span>}
                    {f.k === "amazon" && t.fontes.amazon_semana && <span className="normal-case"> · semana de {new Date(`${t.fontes.amazon_semana}T12:00:00`).toLocaleDateString("pt-BR")}</span>}
                  </div>
                  {lista.length === 0 ? <p className="text-xs text-muted-foreground">—</p> : (
                    <ul className="space-y-0.5">
                      {lista.slice(0, limite).map((x) => (
                        <li key={x.termo} className={`flex items-center gap-1.5 text-xs ${x.concorrente ? "line-through text-muted-foreground" : ""}`}
                          title={x.concorrente ? "marca de outro fabricante: não usar" : x.confirmado ? "confirmado: todas as palavras são deste produto" : "a conferir: tem palavra que o cadastro não confirma"}>
                          {x.no_titulo ? <Check className="h-3 w-3 shrink-0 text-emerald-600" /> : <span className="w-3 shrink-0" />}
                          <span className={`min-w-0 flex-1 truncate ${!x.confirmado && !x.concorrente ? "italic text-amber-700 dark:text-amber-400" : ""}`}>{x.termo}</span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">{valor(f.k, x)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {total > 36 && !verTodos && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setVerTodos(true)}>ver todos</Button>}
        <p className="text-[11px] text-muted-foreground"><i className="text-amber-700 dark:text-amber-400">itálico</i> = a conferir · <s>riscado</s> = marca de concorrente</p>

        {(t.palavras_ocultas || t.modelo_sugerido) && (
          <div className="grid gap-2 md:grid-cols-2 border-t pt-3">
            {t.palavras_ocultas && (
              <Pronto rotulo="Amazon · palavras de busca escondidas" texto={t.palavras_ocultas} nota="vão no envio para a Amazon (dá para desmarcar na conferência)" onCopiar={copiar} />
            )}
            {t.modelo_sugerido && (
              <Pronto rotulo="Mercado Livre · Modelo" texto={t.modelo_sugerido} nota="preenche o campo Modelo ao criar o anúncio (dá para editar)" onCopiar={copiar} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Pronto({ rotulo, texto, nota, onCopiar }: { rotulo: string; texto: string; nota: string; onCopiar: (s: string) => void }) {
  return (
    <div className="min-w-0 rounded-md border p-2 text-xs space-y-1">
      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground flex-1">{rotulo}</span>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => onCopiar(texto)} title="copiar"><Copy className="h-3 w-3" /></Button>
      </div>
      <p className="break-words">{texto}</p>
      <p className="text-[10px] text-muted-foreground">{nota}</p>
    </div>
  );
}
