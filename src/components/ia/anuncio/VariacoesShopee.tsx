import { useEffect, useRef, useState } from "react";
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
import { EV_CRIADO, EV_PRONTO, EV_VAI_CRIAR, type AnuncioCriado, type AnuncioPronto, type VaiCriar } from "@/lib/iaEnvioEventos";

// ============================================================================
// "Variações deste anúncio na Shopee" (12/out/2026, pedido do dono). A Shopee cria anúncio com
// variações em dois tempos: o anúncio (edge fn `anuncio-publicar`) e depois as opções
// (`anuncio-shopee-variacoes` → `product/init_tier_variation`). Para o operador é UM envio:
// ele ajusta aqui as opções (nome, preço, estoque e foto de cada variação) e envia o anúncio
// logo abaixo; quando o envio termina, o `Publicar` avisa (evento `ia-anuncio-criado`) e este
// bloco cria as variações no anúncio recém-criado, sem outro clique.
// Também serve para um anúncio simples que já existe: informar o ID, Conferir e Criar.
// Só para anúncio que ainda NÃO tem variações.
// ============================================================================

const LOJA: Record<string, number> = { ottz: 522186766, svl: 759046323 };
const TIPOS_FOTO = ["capa_ambientada_limpa", "capa_ambientada_texto"];
export const EVENTO_ANUNCIO_CRIADO = EV_CRIADO;
interface Linha {
  sku: string; opcao: string; preco: string; estoque: string; foto_path: string | null; foto_url: string | null;
  /** peso e medidas DESTA variação (em branco = valem os do anúncio) */
  peso: string; comp: string; larg: string; alt: string;
}
/** "8kg" / "500g" no nome da opção → peso em kg (sugestão para o campo de peso da variação). */
const pesoDaOpcao = (opcao: string): string => {
  const m = /^(\d+(?:[.,]\d+)?)\s*(kg|g)$/i.exec(opcao.trim());
  if (!m) return "";
  const v = Number(m[1].replace(",", ".")) / (m[2].toLowerCase() === "g" ? 1000 : 1);
  return v > 0 ? String(v).replace(".", ",") : "";
};
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
      // PREÇO PADRÃO (13/out, pedido do dono): o da margem padrão da Shopee (30%), SKU a SKU; sem custo, o do Tiny
      const calc = await Promise.all(skus.map((s) => supabaseExternal.rpc("ia_calcular_preco", { p_sku: s, p_canal: "shopee", p_empresa: empresa, p_margem: null })));
      const pelaMargem = new Map(skus.map((s, i) => [s, Number((calc[i].data as { preco_sugerido?: number } | null)?.preco_sugerido) || 0]));
      const margemPadrao = Number((calc.map((c) => (c.data as { memoria_calculo?: { margem_padrao_pct?: number } } | null)?.memoria_calculo?.margem_padrao_pct).find((x) => x != null)) ?? 0) || null;
      const [k, pub, esp, rasc, med] = await Promise.all([
        skus.length ? supabaseExternal.from("produto_kits").select("sku_kit, quantidade").in("sku_kit", skus) : Promise.resolve({ data: [] }),
        supabaseExternal.from("ia_publicacao").select("item_id, operacao, criado_em").eq("sku", sku).eq("canal", "shopee").eq("empresa", empresa).eq("estado", "publicado").order("criado_em", { ascending: false }).limit(5),
        supabaseExternal.from("shopee_anuncios").select("item_id, nome, tem_variacao, status").eq("shop_id", shopId).eq("sku_pai", sku).in("status", ["NORMAL", "UNLIST"]),
        skus.length ? supabaseExternal.from("ia_rascunho").select("id, sku").in("sku", skus) : Promise.resolve({ data: [] }),
        // peso e medidas já conferidos de cada variação (gravados no 1º envio): valem para a outra loja e para depois
        skus.length ? supabaseExternal.from("ia_produto_extra").select("sku, peso_kg, comprimento_cm, largura_cm, altura_cm").in("sku", skus) : Promise.resolve({ data: [] }),
      ]);
      const conferidas = new Map(((med.data ?? []) as { sku: string; peso_kg: number | null; comprimento_cm: number | null; largura_cm: number | null; altura_cm: number | null }[]).map((m) => [m.sku, m]));
      const emTexto = (x: number | null | undefined) => (x != null && Number(x) > 0 ? String(Number(x)).replace(".", ",") : "");
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
        const opcao = (nome.startsWith(`${nomePai} - `) ? nome.slice(nomePai.length + 3) : nome).trim().slice(0, 20);
        return {
          sku: v.sku, opcao, peso: emTexto(conferidas.get(v.sku)?.peso_kg) || pesoDaOpcao(opcao),
          comp: emTexto(conferidas.get(v.sku)?.comprimento_cm), larg: emTexto(conferidas.get(v.sku)?.largura_cm), alt: emTexto(conferidas.get(v.sku)?.altura_cm),
          preco: pelaMargem.get(v.sku) ? dinheiro(pelaMargem.get(v.sku)!) : v.preco != null ? dinheiro(Number(v.preco)) : "", estoque: "0",
          foto_path: foto?.storage_path ?? null, foto_url: foto ? urls[foto.storage_path] ?? null : null,
        };
      }).sort((a, z) => (qtd.get(a.sku) ?? 1) - (qtd.get(z.sku) ?? 1) || a.sku.localeCompare(z.sku));
      const criado = ((pub.data ?? []) as { item_id: string | null; operacao: string | null }[]).find((p) => p.item_id)?.item_id ?? null;
      const espelho = (esp.data ?? []) as { item_id: number; nome: string | null; tem_variacao: boolean | null; status: string | null }[];
      return { linhas, item: criado ?? (espelho[0] ? String(espelho[0].item_id) : ""), espelho, margemPadrao, semMargem: skus.filter((s) => !pelaMargem.get(s)) };
    },
  });

  const [itemId, setItemId] = useState("");
  const [grade, setGrade] = useState("Tamanho");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [comFotos, setComFotos] = useState(true);
  const [auto, setAuto] = useState(true);
  const [previa, setPrevia] = useState<{ chave: string; dados: Previa } | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "criando">("");
  const [feito, setFeito] = useState<string | null>(null);
  const [recemCriado, setRecemCriado] = useState<{ item: string; ativar: boolean } | null>(null);
  const [noAr, setNoAr] = useState<boolean | null>(null);
  // preenche uma vez por LOJA: recarregar a consulta não pode apagar o que o operador já ajustou.
  // Ao trocar de loja (Ottz ↔ Bumi) o preço, o anúncio e a foto são os da loja nova; o nome da opção, o
  // estoque, o PESO e as MEDIDAS que já estavam na tela ficam (13/out, pedido do dono).
  const iniciado = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data || iniciado.current === empresa) return;
    const nova = q.data.linhas;
    if (iniciado.current === null) { setLinhas(nova); setComFotos(nova.length > 0 && nova.every((l) => l.foto_path)); }
    else {
      setLinhas((antes) => nova.map((n) => {
        const a = antes.find((x) => x.sku === n.sku);
        return a ? { ...n, opcao: a.opcao, estoque: a.estoque, peso: a.peso, comp: a.comp, larg: a.larg, alt: a.alt } : n;
      }));
      setFeito(null); setPrevia(null); setNoAr(null);
    }
    setItemId(q.data.item);
    iniciado.current = empresa;
  }, [q.data, empresa]);
  // o envio do anúncio (bloco de baixo) avisa quando criou: as variações entram em seguida
  useEffect(() => {
    const ouvir = (ev: Event) => {
      const d = ((ev as CustomEvent).detail ?? {}) as Partial<AnuncioCriado>;
      if (d.canal !== "shopee" || d.empresa !== empresa || d.sku !== sku || !d.item_id) return;
      setItemId(String(d.item_id)); setFeito(null); setRecemCriado({ item: String(d.item_id), ativar: d.ativar === true });
    };
    // antes de o envio confirmar: digo se as variações vão junto (aí o anúncio só vai ao ar depois delas)
    const vaiCriar = (ev: Event) => {
      const d = (ev as CustomEvent).detail as VaiCriar;
      if (d.canal === "shopee" && d.empresa === empresa && d.sku === sku) d.variacoes = junto.current;
    };
    window.addEventListener(EV_CRIADO, ouvir); window.addEventListener(EV_VAI_CRIAR, vaiCriar);
    return () => { window.removeEventListener(EV_CRIADO, ouvir); window.removeEventListener(EV_VAI_CRIAR, vaiCriar); };
  }, [sku, empresa]);
  const junto = useRef(false);
  junto.current = auto && linhas.length >= 2;

  const todasComFoto = linhas.length > 0 && linhas.every((l) => l.foto_path);
  const mandarFotos = comFotos && todasComFoto;
  const corpo = (item = itemId) => ({
    empresa, item_id: item.trim(), grade: grade.trim(),
    variacoes: linhas.map((l) => ({
      sku: l.sku, opcao: l.opcao.trim(), preco: paraNumero(l.preco) || 0, estoque: Number(l.estoque) || 0, foto_path: mandarFotos ? l.foto_path : null,
      peso_kg: paraNumero(l.peso) || null, comprimento_cm: paraNumero(l.comp) || null, largura_cm: paraNumero(l.larg) || null, altura_cm: paraNumero(l.alt) || null,
    })),
  });

  /** `doEnvio`: veio do envio do anúncio (ativa se pedido e avisa a promoção); o caminho manual só cria. */
  async function criar(item: string, doEnvio?: { ativar: boolean }) {
    setOcupado("criando");
    try {
      const r = (await chamarVariacoesShopee("criar", { ...corpo(item), confirmar: true, ativar: doEnvio?.ativar === true })) as {
        anuncio?: { url: string }; modelos?: { model_id: number; sku: string }[]; ativado?: boolean | null; aviso_ativar?: string | null;
      };
      setFeito(r.anuncio?.url ?? `https://shopee.com.br/product/${shopId}/${item}`);
      setNoAr(doEnvio?.ativar ? r.ativado === true : null);
      toast.success(`${linhas.length} variações criadas no anúncio ${item}${r.ativado ? " · anúncio no ar" : ""}`);
      if (r.aviso_ativar) toast.warning(r.aviso_ativar, { duration: 30000 });
      // peso e medidas conferidos ficam guardados por SKU: servem à outra loja e aos outros marketplaces
      void Promise.all(linhas.map(async (l) => {
        const m: Record<string, number> = {};
        if (paraNumero(l.peso) > 0) m.peso_kg = paraNumero(l.peso);
        if (paraNumero(l.comp) > 0 && paraNumero(l.larg) > 0 && paraNumero(l.alt) > 0) { m.comprimento_cm = paraNumero(l.comp); m.largura_cm = paraNumero(l.larg); m.altura_cm = paraNumero(l.alt); }
        if (Object.keys(m).length) await supabaseExternal.from("ia_produto_extra").upsert({ sku: l.sku, ...m }, { onConflict: "sku" });
      })).catch(() => undefined);
      // o espelho do app passa a enxergar as variações sem esperar a sincronização da madrugada
      const espelhar = atualizarCatalogoShopee(shopId, [Number(item)]).catch(() => undefined);
      if (doEnvio) {
        // a promoção (se escolhida no envio) precisa do código de cada variação: o da resposta ou, sem ele, o do espelho
        let modelos = (r.modelos ?? []).filter((m) => m.model_id && m.sku).map((m) => ({ model_id: Number(m.model_id), sku: String(m.sku) }));
        if (modelos.length < linhas.length) {
          await espelhar;
          const { data } = await supabaseExternal.from("shopee_anuncios_variacao").select("model_id, sku").eq("shop_id", shopId).eq("item_id", Number(item));
          modelos = ((data ?? []) as { model_id: number; sku: string | null }[]).filter((m) => m.sku).map((m) => ({ model_id: Number(m.model_id), sku: String(m.sku) }));
        }
        const pronto: AnuncioPronto = { canal: "shopee", empresa, sku, item_id: item, modelos, precos: Object.fromEntries(linhas.map((l) => [l.sku, paraNumero(l.preco) || 0])) };
        window.dispatchEvent(new CustomEvent(EV_PRONTO, { detail: pronto }));
      }
    } catch (e) {
      toast.error("O anúncio existe, mas as variações NÃO foram criadas", { description: `${(e as Error).message} — ajuste aqui e use "Criar as variações na Shopee".`, duration: 30000 });
    } finally { setOcupado(""); }
  }
  useEffect(() => {
    if (!recemCriado) return;
    const { item, ativar } = recemCriado; setRecemCriado(null);
    if (auto && linhas.length >= 2) void criar(item, { ativar });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recemCriado]);

  /** Põe no ar um anúncio que ficou fora (a ativação automática falhou, ou ele foi criado sem listar). */
  async function ativar(item: string) {
    if (!window.confirm(`Pôr o anúncio ${item} NO AR na Shopee · ${nomeEmpresa(empresa)}?\n\nEle passa a aparecer para os compradores.`)) return;
    setOcupado("criando");
    try {
      const r = (await chamarVariacoesShopee("ativar", { empresa, item_id: item, confirmar: true })) as { ativado?: boolean; erro?: string | null };
      if (r.ativado) {
        setNoAr(true); toast.success(`Anúncio ${item} no ar`);
        void atualizarCatalogoShopee(shopId, [Number(item)]).then(() => q.refetch()).catch(() => undefined);
      } else toast.error("A Shopee não deixou pôr o anúncio no ar", { description: r.erro ?? "sem detalhe", duration: 30000 });
    } catch (e) { toast.error("Não consegui pôr o anúncio no ar", { description: (e as Error).message, duration: 20000 }); }
    finally { setOcupado(""); }
  }

  if (q.isLoading || !q.data || q.data.linhas.length < 2) return null;
  // fora do ar: a ativação desta tela falhou agora, ou o cadastro do app mostra o anúncio como não listado
  const foraDoAr = !!itemId.trim() && (noAr === false || (noAr === null && q.data.espelho.find((e) => String(e.item_id) === itemId.trim())?.status === "UNLIST"));
  const chave = JSON.stringify(corpo());
  const conferido = previa?.chave === chave ? previa.dados : null;
  const mudar = (i: number, x: Partial<Linha>) => setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, ...x } : l)));
  const semAnuncio = !itemId.trim();
  // o que já dá para ver daqui, antes de enviar (o servidor confere de novo)
  const faltas = [
    !grade.trim() ? "dê um nome ao grupo de opções" : "",
    linhas.some((l) => !l.opcao.trim()) ? "há opção sem nome" : "",
    new Set(linhas.map((l) => l.opcao.trim().toLowerCase())).size !== linhas.length ? "há duas opções com o mesmo nome" : "",
    linhas.some((l) => !(paraNumero(l.preco) > 0)) ? "há variação sem preço" : "",
    linhas.some((l) => { const n = [l.comp, l.larg, l.alt].filter((x) => paraNumero(x) > 0).length; return n > 0 && n < 3; }) ? "medidas da variação: preencha comprimento, largura e altura juntos (ou deixe os três em branco)" : "",
  ].filter(Boolean);
  const semEstoque = linhas.filter((l) => !(Number(l.estoque) > 0)).length;

  async function conferir() {
    setOcupado("conferindo");
    try { setPrevia({ chave, dados: (await chamarVariacoesShopee("previa", corpo())) as Previa }); }
    catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message, duration: 12000 }); }
    finally { setOcupado(""); }
  }
  async function criarComConfirmacao() {
    if (!conferido?.anuncio) return;
    if (!window.confirm(`Criar na Shopee as ${linhas.length} variações no anúncio "${conferido.anuncio.nome}"?\n\n${linhas.map((l) => `${l.opcao} · SKU ${l.sku} · ${formatBRL(paraNumero(l.preco))} · estoque ${l.estoque}`).join("\n")}\n\nDepois de criadas, as opções não devem ser trocadas (o anúncio perderia o histórico delas).`)) return;
    await criar(itemId.trim());
  }
  const jaTem = q.data.espelho.find((e) => String(e.item_id) === itemId.trim())?.tem_variacao;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2"><Layers className="h-4 w-4" />Variações deste anúncio na Shopee · {nomeEmpresa(empresa)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {semAnuncio
              ? <>Ajuste aqui as opções e depois <b>envie o anúncio no bloco logo abaixo</b>: assim que ele for criado, as {linhas.length} variações entram nele sozinhas, com SKU, preço, estoque e foto.</>
              : <>Este produto já tem anúncio na Shopee ({itemId.trim()}). Confira e crie nele as {linhas.length} variações — só funciona em anúncio que ainda não tem variações.</>}
          </p>
        </div>
        {ocupado === "criando" && <p className="text-sm flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Enviando para a Shopee…</p>}
        {foraDoAr && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/5 p-2.5 text-sm flex flex-wrap items-center gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span>O anúncio <b className="font-mono">{itemId.trim()}</b> está <b>fora do ar</b> na Shopee.</span>
            <Button size="sm" className="h-7 text-xs" disabled={!!ocupado} onClick={() => void ativar(itemId.trim())}>Pôr no ar agora</Button>
          </div>
        )}
        {feito ? (
          <p className="text-sm text-emerald-600 flex flex-wrap items-center gap-2"><CheckCircle2 className="h-4 w-4" />Variações criadas.
            <a className="underline inline-flex items-center gap-1" href={feito} target="_blank" rel="noreferrer">ver o anúncio<ExternalLink className="h-3.5 w-3.5" /></a>
            <span className="text-xs text-muted-foreground">{noAr === true ? "O anúncio já está no ar. Confira no Tiny se foi ligado aos produtos pelo SKU." : "Confira no Tiny se o anúncio foi ligado aos produtos pelo SKU e ative no Seller Center."}</span></p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[200px_1fr] items-end">
              <label className="text-xs font-medium">Nome do grupo de opções
                <Input className="h-8 mt-1" value={grade} maxLength={14} onChange={(e) => setGrade(e.target.value)} />
              </label>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                <label className={`flex items-center gap-2 text-xs select-none ${todasComFoto ? "cursor-pointer" : "text-muted-foreground"}`}>
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={mandarFotos} disabled={!todasComFoto} onChange={(e) => setComFotos(e.target.checked)} />
                  {todasComFoto ? "Usar a foto de cada variação como foto da opção" : "Sem foto por opção: nem todas as variações têm foto gerada (bloco Fotos das variações)"}
                </label>
                <label className="flex items-center gap-2 text-xs select-none cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                  Criar as variações junto com o anúncio (ao enviar)
                </label>
              </div>
            </div>
            {jaTem && <p className="text-xs text-destructive">No cadastro do app este anúncio já aparece com variações — a Shopee vai recusar.</p>}

            <div className="overflow-x-auto">
              <div className="space-y-1.5 min-w-[860px]">
                <div className="grid grid-cols-[56px_1fr_70px_100px_80px_84px_64px_64px_64px] gap-2 text-[11px] text-muted-foreground">
                  <span /><span>Opção (até 20 letras)</span><span>SKU</span><span>Preço (R$)</span><span>Estoque</span><span>Peso (kg)</span><span>Compr.</span><span>Larg.</span><span>Alt. (cm)</span>
                </div>
                {linhas.map((l, i) => (
                  <div key={l.sku} className="grid grid-cols-[56px_1fr_70px_100px_80px_84px_64px_64px_64px] gap-2 items-center">
                    <div className="h-14 w-14 rounded border bg-muted/40 overflow-hidden">{l.foto_url && <a href={l.foto_url} target="_blank" rel="noreferrer" title="abrir a foto"><img src={l.foto_url} alt="" className="h-full w-full object-cover" /></a>}</div>
                    <Input className="h-8" value={l.opcao} maxLength={20} onChange={(e) => mudar(i, { opcao: e.target.value })} />
                    <span className="font-mono text-xs">{l.sku}</span>
                    <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={l.preco} onChange={(e) => mudar(i, { preco: e.target.value })} />
                    <Input className="h-8 text-right tabular-nums" inputMode="numeric" value={l.estoque} onChange={(e) => mudar(i, { estoque: e.target.value.replace(/\D/g, "") })} />
                    <Input className="h-8 text-right tabular-nums" inputMode="decimal" placeholder="anúncio" value={l.peso} onChange={(e) => mudar(i, { peso: e.target.value })} />
                    <Input className="h-8 text-right tabular-nums px-1.5" inputMode="decimal" placeholder="—" value={l.comp} onChange={(e) => mudar(i, { comp: e.target.value })} />
                    <Input className="h-8 text-right tabular-nums px-1.5" inputMode="decimal" placeholder="—" value={l.larg} onChange={(e) => mudar(i, { larg: e.target.value })} />
                    <Input className="h-8 text-right tabular-nums px-1.5" inputMode="decimal" placeholder="—" value={l.alt} onChange={(e) => mudar(i, { alt: e.target.value })} />
                  </div>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Preço: já vem pela margem de contribuição padrão da Shopee{q.data.margemPadrao ? ` (${(q.data.margemPadrao * 100).toFixed(0)}%)` : ""}, variação a variação{q.data.semMargem.length ? ` — sem custo na gestão, ${q.data.semMargem.join(", ")} ficou com o preço do Tiny` : ""}.
              Peso e medidas por variação: é o que a Shopee usa para o frete de cada opção; em branco, valem os do anúncio.
            </p>
            {faltas.length > 0 && <p className="text-xs text-destructive">Antes de enviar: {faltas.join(" · ")}.</p>}
            {semEstoque > 0 && <p className="text-[11px] text-amber-600">{semEstoque} variação(ões) com estoque 0: nascem esgotadas até o Tiny mandar o estoque (depois do vínculo pelo SKU).</p>}

            {semAnuncio ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs">
                {auto
                  ? <>Pronto para enviar: use <b>“Conferir e enviar para a Shopee”</b> logo abaixo. O aviso de lá (“criar gera um anúncio simples”) é só o 1º tempo — as variações acima são criadas em seguida, automaticamente.</>
                  : <>Com a caixa desmarcada, o envio cria só o anúncio simples; depois volte aqui para criar as variações.</>}
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-[220px_1fr] items-end">
                  <label className="text-xs font-medium">ID do anúncio na Shopee
                    <Input className="h-8 mt-1 font-mono" value={itemId} onChange={(e) => setItemId(e.target.value)} />
                  </label>
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
                  <Button size="sm" variant="outline" disabled={!!ocupado} onClick={() => void conferir()}>
                    {ocupado === "conferindo" && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Conferir
                  </Button>
                  <Button size="sm" disabled={!!ocupado || !conferido || conferido.pendencias.length > 0} onClick={() => void criarComConfirmacao()}>
                    Criar as variações na Shopee
                  </Button>
                  {!conferido && <span className="text-xs text-muted-foreground">Confira antes de criar (se mudar algo, confira de novo).</span>}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
