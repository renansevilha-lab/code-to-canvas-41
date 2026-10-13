import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarVariacoesShopee, nomeEmpresa, urlsAssinadas } from "@/lib/iaAnuncio";
import { atualizarCatalogoShopee } from "@/components/promocoes/comum";

// ============================================================================
// "Variações no anúncio da Shopee" (12/out/2026, pedido do dono): o envio cria o anúncio do
// produto PAI como anúncio simples; este bloco é o 2º passo — cria nele as opções (4kg, 8kg…)
// com o SKU, o preço e o estoque de cada variação e, se houver, a foto de cada uma
// (edge fn `anuncio-shopee-variacoes` → `product/init_tier_variation`).
// Só para anúncio que ainda NÃO tem variações. Conferir antes de criar; a criação pede confirmação.
// ============================================================================

const LOJA: Record<string, number> = { ottz: 522186766, svl: 759046323 };
const TIPOS_FOTO = ["capa_ambientada_limpa", "capa_ambientada_texto"];
interface Linha { sku: string; opcao: string; preco: string; estoque: string; foto_path: string | null; foto_url: string | null }
interface Previa { anuncio: { item_id: number; nome: string; situacao: string; tem_variacao: boolean; url: string } | null; pendencias: string[]; avisos: string[] }

const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));

export function VariacoesShopee({ sku, nomePai, empresa }: { sku: string; nomePai: string; empresa: string }) {
  const shopId = LOJA[empresa] ?? LOJA.ottz;
  const q = useQuery({
    queryKey: ["ia-anuncio", "variacoes-shopee", sku, empresa],
    queryFn: async () => {
      const { data: vs } = await supabaseExternal.from("produtos").select("sku, nome, preco").eq("sku_pai", sku).eq("ativo", true).order("sku");
      const vars = (vs ?? []) as { sku: string; nome: string | null; preco: number | null }[];
      const skus = vars.map((v) => v.sku);
      const [k, pub, esp, rasc] = await Promise.all([
        skus.length ? supabaseExternal.from("produto_kits").select("sku_kit, quantidade").in("sku_kit", skus) : Promise.resolve({ data: [] }),
        supabaseExternal.from("ia_publicacao").select("item_id, operacao, criado_em").eq("sku", sku).eq("canal", "shopee").eq("empresa", empresa).eq("estado", "publicado").order("criado_em", { ascending: false }).limit(5),
        supabaseExternal.from("shopee_anuncios").select("item_id, nome, tem_variacao, status").eq("shop_id", shopId).eq("sku_pai", sku).in("status", ["NORMAL", "UNLIST"]),
        skus.length ? supabaseExternal.from("ia_rascunho").select("id, sku").in("sku", skus) : Promise.resolve({ data: [] }),
      ]);
      const rascunhos = (rasc.data ?? []) as { id: string; sku: string }[];
      const im = rascunhos.length
        ? await supabaseExternal.from("ia_rascunho_imagem").select("rascunho_id, storage_path, gerado_em, status").in("rascunho_id", rascunhos.map((r) => r.id)).in("tipo", TIPOS_FOTO).not("storage_path", "is", null)
        : { data: [] };
      const imagens = ((im.data ?? []) as { rascunho_id: string; storage_path: string; gerado_em: string | null; status: string }[])
        .sort((a, z) => Number(z.status === "aprovada") - Number(a.status === "aprovada") || String(z.gerado_em ?? "").localeCompare(String(a.gerado_em ?? "")));
      const urls = await urlsAssinadas(imagens.map((i) => i.storage_path)).catch(() => ({} as Record<string, string>));
      const qtd = new Map(((k.data ?? []) as { sku_kit: string; quantidade: number }[]).map((x) => [x.sku_kit, Number(x.quantidade) || 1]));
      const linhas: Linha[] = vars.map((v) => {
        const nome = v.nome ?? v.sku;
        const meus = new Set(rascunhos.filter((r) => r.sku === v.sku).map((r) => r.id));
        const foto = imagens.find((i) => meus.has(i.rascunho_id)) ?? null;
        return {
          sku: v.sku, opcao: (nome.startsWith(`${nomePai} - `) ? nome.slice(nomePai.length + 3) : nome).trim().slice(0, 20),
          preco: v.preco != null ? dinheiro(Number(v.preco)) : "", estoque: "0",
          foto_path: foto?.storage_path ?? null, foto_url: foto ? urls[foto.storage_path] ?? null : null,
        };
      }).sort((a, z) => (qtd.get(a.sku) ?? 1) - (qtd.get(z.sku) ?? 1) || a.sku.localeCompare(z.sku));
      const criado = ((pub.data ?? []) as { item_id: string | null; operacao: string | null }[]).find((p) => p.item_id)?.item_id ?? null;
      const espelho = (esp.data ?? []) as { item_id: number; nome: string | null; tem_variacao: boolean | null }[];
      return { linhas, item: criado ?? (espelho[0] ? String(espelho[0].item_id) : ""), espelho };
    },
  });

  const [itemId, setItemId] = useState("");
  const [grade, setGrade] = useState("Tamanho");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [comFotos, setComFotos] = useState(true);
  const [previa, setPrevia] = useState<{ chave: string; dados: Previa } | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "criando">("");
  const [feito, setFeito] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setLinhas(q.data.linhas); setItemId(q.data.item);
    setComFotos(q.data.linhas.length > 0 && q.data.linhas.every((l) => l.foto_path));
  }, [q.data]);

  if (q.isLoading || !q.data || q.data.linhas.length < 2) return null;
  const todasComFoto = linhas.every((l) => l.foto_path);
  const mandarFotos = comFotos && todasComFoto;
  const corpo = () => ({
    empresa, item_id: itemId.trim(), grade: grade.trim(),
    variacoes: linhas.map((l) => ({ sku: l.sku, opcao: l.opcao.trim(), preco: paraNumero(l.preco) || 0, estoque: Number(l.estoque) || 0, foto_path: mandarFotos ? l.foto_path : null })),
  });
  const chave = JSON.stringify(corpo());
  const conferido = previa?.chave === chave ? previa.dados : null;
  const mudar = (i: number, x: Partial<Linha>) => setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, ...x } : l)));

  async function conferir() {
    setOcupado("conferindo");
    try { setPrevia({ chave, dados: (await chamarVariacoesShopee("previa", corpo())) as Previa }); }
    catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message, duration: 12000 }); }
    finally { setOcupado(""); }
  }
  async function criar() {
    if (!conferido?.anuncio) return;
    if (!window.confirm(`Criar na Shopee as ${linhas.length} variações no anúncio "${conferido.anuncio.nome}"?\n\n${linhas.map((l) => `${l.opcao} · SKU ${l.sku} · ${formatBRL(paraNumero(l.preco))} · estoque ${l.estoque}`).join("\n")}\n\nDepois de criadas, as opções não devem ser trocadas (o anúncio perderia o histórico delas).`)) return;
    setOcupado("criando");
    try {
      const r = (await chamarVariacoesShopee("criar", { ...corpo(), confirmar: true })) as { ok: boolean; erro?: string; anuncio?: { url: string } };
      if (!r.ok) { toast.error("As variações não foram criadas", { description: r.erro, duration: 20000 }); return; }
      setFeito(r.anuncio?.url ?? conferido.anuncio.url);
      toast.success(`${linhas.length} variações criadas na Shopee`);
      // o espelho do app passa a enxergar as variações sem esperar a sincronização da madrugada
      void atualizarCatalogoShopee(shopId, [Number(itemId)]).catch(() => undefined);
    } catch (e) { toast.error("As variações não foram criadas", { description: (e as Error).message, duration: 20000 }); }
    finally { setOcupado(""); }
  }
  const jaTem = q.data.espelho.find((e) => String(e.item_id) === itemId.trim())?.tem_variacao;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2"><Layers className="h-4 w-4" />Variações no anúncio da Shopee · {nomeEmpresa(empresa)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            O envio acima cria o anúncio deste produto como anúncio simples. Aqui você cria nele as opções (uma por variação), com SKU, preço e estoque.
            Faça logo depois de criar o anúncio, antes de colocá-lo no ar.
          </p>
        </div>
        {feito ? (
          <p className="text-sm text-emerald-600 flex flex-wrap items-center gap-2"><CheckCircle2 className="h-4 w-4" />Variações criadas.
            <a className="underline inline-flex items-center gap-1" href={feito} target="_blank" rel="noreferrer">ver o anúncio<ExternalLink className="h-3.5 w-3.5" /></a>
            <span className="text-xs text-muted-foreground">Confira no Tiny se o anúncio foi ligado aos produtos pelo SKU.</span></p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[220px_200px_1fr] items-end">
              <label className="text-xs font-medium">ID do anúncio na Shopee
                <Input className="h-8 mt-1 font-mono" value={itemId} placeholder="crie o anúncio acima primeiro" onChange={(e) => setItemId(e.target.value)} />
              </label>
              <label className="text-xs font-medium">Nome do grupo de opções
                <Input className="h-8 mt-1" value={grade} maxLength={14} onChange={(e) => setGrade(e.target.value)} />
              </label>
              <label className={`flex items-center gap-2 text-xs select-none ${todasComFoto ? "cursor-pointer" : "text-muted-foreground"}`}>
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={mandarFotos} disabled={!todasComFoto} onChange={(e) => setComFotos(e.target.checked)} />
                {todasComFoto ? "Usar a foto de cada variação como foto da opção" : "Sem foto por opção: nem todas as variações têm foto gerada (bloco Fotos das variações)"}
              </label>
            </div>
            {jaTem && <p className="text-xs text-destructive">No cadastro do app este anúncio já aparece com variações — a Shopee vai recusar.</p>}

            <div className="space-y-1.5">
              <div className="grid grid-cols-[44px_1fr_90px_110px_90px] gap-2 text-[11px] text-muted-foreground">
                <span /><span>Opção (até 20 letras)</span><span>SKU</span><span>Preço (R$)</span><span>Estoque</span>
              </div>
              {linhas.map((l, i) => (
                <div key={l.sku} className="grid grid-cols-[44px_1fr_90px_110px_90px] gap-2 items-center">
                  <div className="h-10 w-10 rounded border bg-muted/40 overflow-hidden">{l.foto_url && <img src={l.foto_url} alt="" className="h-full w-full object-cover" />}</div>
                  <Input className="h-8" value={l.opcao} maxLength={20} onChange={(e) => mudar(i, { opcao: e.target.value })} />
                  <span className="font-mono text-xs">{l.sku}</span>
                  <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={l.preco} onChange={(e) => mudar(i, { preco: e.target.value })} />
                  <Input className="h-8 text-right tabular-nums" inputMode="numeric" value={l.estoque} onChange={(e) => mudar(i, { estoque: e.target.value.replace(/\D/g, "") })} />
                </div>
              ))}
            </div>

            {conferido && (
              <div className="space-y-2">
                {conferido.anuncio && (
                  <p className="text-xs">Anúncio: <b>{conferido.anuncio.nome}</b> · {conferido.anuncio.situacao === "UNLIST" ? "fora do ar" : conferido.anuncio.situacao}
                    {" · "}<a className="underline" href={conferido.anuncio.url} target="_blank" rel="noreferrer">abrir</a></p>
                )}
                {conferido.pendencias.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-sm text-destructive">
                    <div className="font-medium flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Falta resolver</div>
                    {conferido.pendencias.map((x) => <div key={x}>• {x}</div>)}
                  </div>
                )}
                {conferido.avisos.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">{conferido.avisos.map((x) => <div key={x}>• {x}</div>)}</div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={!!ocupado || !itemId.trim()} onClick={() => void conferir()}>
                {ocupado === "conferindo" && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Conferir
              </Button>
              <Button size="sm" disabled={!!ocupado || !conferido || conferido.pendencias.length > 0} onClick={() => void criar()}>
                {ocupado === "criando" && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Criar as variações na Shopee
              </Button>
              {!conferido && itemId.trim() && <span className="text-xs text-muted-foreground">Confira antes de criar (se mudar algo, confira de novo).</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
