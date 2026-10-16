import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Layers, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarPublicar, chamarVariacoes, chamarVariacoesShopee } from "@/lib/iaAnuncio";
import { extrairPeso } from "@/lib/prazo";

// ============================================================================
// Variações num anúncio que JÁ ESTÁ RODANDO na Shopee (16/out/2026, pedido do dono).
// Ex.: 15824 (kit 3×15679) tem o anúncio 49705431794 com as opções 3 un / 2 un; o dono quer pôr 4 e 5.
// Decisão do dono (opção B): no Tiny, o anúncio fica ligado a um PRODUTO PAI com as variações.
//   - Se o Tiny já tem um pai cujas variações são kits do mesmo produto base em todas as quantidades
//     (ex.: 16361 = 1× a 5× 15679), o anúncio passa a usar os SKUs dele — nada é criado no Tiny.
//   - Senão, cria um pai novo (`tiny-produto-variacoes`): uma variação (kit) por quantidade, inclusive
//     as que o anúncio já vende — a API do Tiny não transforma produto existente em variação.
// Na Shopee (`anuncio-shopee-variacoes` v7): anúncio com variações → `ampliar` (opções novas, SKU novo das
// de hoje, SKU do anúncio = pai); anúncio simples → `criar` (init_tier_variation com a opção de hoje + as
// novas) e depois `ampliar` só para o SKU do anúncio. O item_id, as vendas e as avaliações ficam.
// ============================================================================

interface Existente { item_id: string; nome: string | null; status: string | null; url: string; variacao: boolean }
interface Modelo { model_id: number; sku: string; opcao: string; preco: number | null; estoque: number | null; tier_index: number[] }
interface AnuncioAoVivo {
  item_id: number; nome: string; sku: string | null; situacao: string; tem_variacao: boolean; url: string;
  preco: number | null; estoque: number | null; grupos: { nome: string; opcoes: { opcao: string }[] }[]; variacoes: Modelo[];
}
interface Prod { sku: string; nome: string; tipo: string | null; sku_pai: string | null; ativo: boolean; estoque: number | null; preco: number | null }
interface Linha { qtd: string; rotulo: string; preco: string; estoque: string }
interface ResultadoTiny { pai: { sku: string; nome: string }; variacoes: { sku: string; rotulo: string; quantidade: number; base_sku: string; id?: number; ok: boolean; pendente?: boolean; erro: string | null }[]; aviso: string | null }

const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const kg = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");
const EH_AREIA = /areia|granulado|s[ií]lica/i;

/** Bloco na aba Anúncio (destino Shopee): abre o passo a passo. */
export function AmpliarVariacoes({ sku, empresa }: { sku: string; empresa: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <Card>
      <CardContent className="p-4 flex flex-wrap items-center gap-3 text-sm">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <b>Variações num anúncio que já está no ar</b>
          <div className="text-xs text-muted-foreground">
            Acrescenta opções (ex.: 4 e 5 unidades) a um anúncio da Shopee {empresa === "svl" ? "Bumi" : "Ottz"} que já vende, e liga tudo a um produto pai no Tiny. O anúncio mantém o ID, as vendas e as avaliações.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAberto(true)}>Adicionar variações</Button>
      </CardContent>
      {aberto && <DialogoAmpliar sku={sku} empresa={empresa} onFechar={() => setAberto(false)} />}
    </Card>
  );
}

function DialogoAmpliar({ sku, empresa, onFechar }: { sku: string; empresa: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const loja = empresa === "svl" ? "Shopee Bumi" : "Shopee Ottz";

  // 1) os anúncios deste produto na loja
  const existQ = useQuery({
    queryKey: ["ia-ampliar", "existentes", sku, empresa],
    staleTime: 0, gcTime: 0, placeholderData: undefined,
    queryFn: async () => {
      const j = await chamarPublicar("existentes", { sku });
      return ((j.existentes?.shopee?.[empresa] ?? []) as Existente[]);
    },
  });
  const [itemId, setItemId] = useState("");
  useEffect(() => { if (!itemId && existQ.data?.[0]) setItemId(existQ.data[0].item_id); }, [existQ.data]);

  // 2) o anúncio AO VIVO (sem reaproveitar resultado de outro anúncio/loja: §5.11.11.9)
  const lerQ = useQuery({
    queryKey: ["ia-ampliar", "ler", empresa, itemId],
    enabled: /^\d{6,}$/.test(itemId),
    staleTime: 0, gcTime: 0, placeholderData: undefined,
    queryFn: async () => ({ itemId, anuncio: (await chamarVariacoesShopee("ler", { empresa, item_id: itemId })).anuncio as AnuncioAoVivo }),
  });
  const anuncio = lerQ.data?.itemId === itemId ? lerQ.data.anuncio : null;
  // as opções de hoje (anúncio simples = uma opção, a do próprio anúncio)
  const hoje: Modelo[] = anuncio
    ? (anuncio.tem_variacao ? anuncio.variacoes
      : [{ model_id: 0, sku: anuncio.sku || sku, opcao: "", preco: anuncio.preco, estoque: anuncio.estoque, tier_index: [] }])
    : [];

  // 3) o que é cada opção no cadastro: produto base + quantidade; e os pais do Tiny que já têm esse produto base
  const cadQ = useQuery({
    queryKey: ["ia-ampliar", "cadastro", hoje.map((m) => m.sku).join(",")],
    enabled: hoje.length > 0,
    staleTime: 0, gcTime: 0, placeholderData: undefined,
    queryFn: async () => {
      const skus = hoje.map((m) => m.sku).filter(Boolean);
      const [k, p] = await Promise.all([
        supabaseExternal.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_kit", skus),
        supabaseExternal.from("produtos").select("sku, nome, tipo, sku_pai, ativo, estoque, preco").in("sku", skus),
      ]);
      const kits = (k.data ?? []) as { sku_kit: string; sku_componente: string; quantidade: number }[];
      const prods = new Map(((p.data ?? []) as Prod[]).map((x) => [x.sku, x]));
      const deQual = new Map<string, { base: string; qtd: number } | null>();
      for (const s of skus) {
        const comp = kits.filter((x) => x.sku_kit === s);
        if (comp.length === 1) deQual.set(s, { base: comp[0].sku_componente, qtd: Number(comp[0].quantidade) || 1 });
        else if (comp.length === 0 && prods.get(s) && prods.get(s)!.tipo !== "K" && prods.get(s)!.tipo !== "V") deQual.set(s, { base: s, qtd: 1 });
        else deQual.set(s, null);
      }
      const bases = [...new Set([...deQual.values()].map((x) => x?.base ?? "?"))];
      const base = bases.length === 1 && bases[0] !== "?" ? bases[0] : null;
      if (!base) return { deQual, base: null, baseProd: null, pais: [] as { sku: string; nome: string; porQtd: Map<number, string> }[] };
      // kits de 1 componente deste produto base que são VARIAÇÃO de um pai ativo
      const { data: kb } = await supabaseExternal.from("produto_kits").select("sku_kit, quantidade").eq("sku_componente", base).limit(500);
      const kitsBase = (kb ?? []) as { sku_kit: string; quantidade: number }[];
      const idsKit = kitsBase.map((x) => x.sku_kit);
      const [todos, pk] = await Promise.all([
        idsKit.length ? supabaseExternal.from("produto_kits").select("sku_kit").in("sku_kit", idsKit) : Promise.resolve({ data: [] as any[] }),
        supabaseExternal.from("produtos").select("sku, nome, tipo, sku_pai, ativo, estoque, preco").in("sku", [base, ...idsKit]),
      ]);
      const nComp = new Map<string, number>();
      for (const r of (todos.data ?? []) as { sku_kit: string }[]) nComp.set(r.sku_kit, (nComp.get(r.sku_kit) ?? 0) + 1);
      const pr = new Map(((pk.data ?? []) as Prod[]).map((x) => [x.sku, x]));
      const porPai = new Map<string, Map<number, string>>();
      for (const kt of kitsBase) {
        const x = pr.get(kt.sku_kit);
        if (!x?.ativo || !x.sku_pai || nComp.get(kt.sku_kit) !== 1) continue;
        const m = porPai.get(x.sku_pai) ?? new Map<number, string>();
        if (!m.has(Number(kt.quantidade))) m.set(Number(kt.quantidade), kt.sku_kit);
        porPai.set(x.sku_pai, m);
      }
      const { data: np } = porPai.size
        ? await supabaseExternal.from("produtos").select("sku, nome, ativo").in("sku", [...porPai.keys()])
        : { data: [] as any[] };
      const pais = ((np ?? []) as { sku: string; nome: string; ativo: boolean }[]).filter((x) => x.ativo)
        .map((x) => ({ sku: x.sku, nome: x.nome, porQtd: porPai.get(x.sku)! }));
      return { deQual, base, baseProd: pr.get(base) ?? null, pais };
    },
  });
  const cad = cadQ.data;
  const base = cad?.base ?? null;
  const baseProd = cad?.baseProd ?? null;
  const qtdHoje = hoje.map((m) => cad?.deQual.get(m.sku)?.qtd ?? 0);

  // areia vende por peso: a opção é "8kg", não "2 unidades"
  const peso = useMemo(() => {
    if (!baseProd || !EH_AREIA.test(baseProd.nome)) return null;
    const p = extrairPeso(baseProd.nome);
    const v = p ? Number(p.valor.replace(",", ".")) : 0;
    if (!p || !(v > 0) || (p.unidade !== "kg" && p.unidade !== "g")) return null;
    return { kg: p.unidade === "g" ? v / 1000 : v, inicio: p.inicio, fim: p.fim };
  }, [baseProd]);
  const rotuloDe = (n: number) => (peso ? `${kg(peso.kg * n)}kg` : `${n} ${n === 1 ? "unidade" : "unidades"}`);
  // preço sugerido da opção nova: o preço por unidade das opções de hoje × a quantidade
  const precoUnit = useMemo(() => {
    const xs = hoje.map((m, i) => (m.preco && qtdHoje[i] ? m.preco / qtdHoje[i] : 0)).filter((x) => x > 0);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }, [hoje.map((m) => `${m.sku}:${m.preco}`).join(","), qtdHoje.join(",")]);

  // 4) as opções novas
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [rotuloHoje, setRotuloHoje] = useState(""); // anúncio simples: nome da opção que ele vende hoje
  const [grade, setGrade] = useState("");
  const novaLinha = (n: number): Linha => ({
    qtd: String(n), rotulo: rotuloDe(n), preco: precoUnit ? dinheiro(precoUnit * n) : "",
    estoque: String(baseProd?.estoque ? Math.max(0, Math.floor(Number(baseProd.estoque) / n)) : 0),
  });
  useEffect(() => {
    if (!cad || !anuncio) return;
    setRotuloHoje(anuncio.tem_variacao ? "" : rotuloDe(qtdHoje[0] || 1));
    setGrade(anuncio.grupos[0]?.nome || (peso ? "Peso" : "Quantidade"));
    const usadas = new Set(qtdHoje);
    const prox = [1, 2, 3, 4, 5, 6].filter((n) => !usadas.has(n)).slice(0, 2);
    setLinhas(prox.map(novaLinha));
  }, [cad, anuncio?.item_id]);
  const mudar = (i: number, x: Partial<Linha>) => setLinhas((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const n = Number(x.qtd);
    const acompanha = x.qtd !== undefined && n >= 1 && l.rotulo === rotuloDe(Number(l.qtd));
    return { ...l, ...x, ...(acompanha ? { rotulo: rotuloDe(n), preco: precoUnit ? dinheiro(precoUnit * n) : l.preco, estoque: novaLinha(n).estoque } : {}) };
  }));
  const qtdNovas = linhas.map((l) => Number(l.qtd) || 0);
  const todasQtd = [...new Set([...qtdHoje, ...qtdNovas])].filter((n) => n > 0).sort((a, b) => a - b);

  // 5) o pai no Tiny: um que já existe (cobre todas as quantidades) ou um novo
  const paisQueServem = (cad?.pais ?? []).filter((p) => todasQtd.every((n) => p.porQtd.has(n)));
  const [modoPai, setModoPai] = useState<string>(""); // sku do pai existente ou "novo"
  useEffect(() => { if (cad) setModoPai((m) => (m && (m === "novo" || paisQueServem.some((p) => p.sku === m)) ? m : paisQueServem[0]?.sku ?? "novo")); }, [cad, todasQtd.join(",")]);
  const paiExistente = paisQueServem.find((p) => p.sku === modoPai) ?? null;

  const sugQ = useQuery({
    queryKey: ["ia-ampliar", "sugerir", base],
    enabled: !!base && modoPai === "novo",
    staleTime: 0, gcTime: 0, placeholderData: undefined,
    queryFn: async () => (await chamarVariacoes("sugerir", { base_sku: base, n: 13 })) as { skus: string[] },
  });
  const [nomePai, setNomePai] = useState("");
  const [skuPai, setSkuPai] = useState("");
  const [gradeTiny, setGradeTiny] = useState("Tamanho");
  useEffect(() => {
    if (!baseProd) return;
    if (!peso || !todasQtd.length) { setNomePai(baseProd.nome); return; }
    const min = todasQtd[0], max = todasQtd[todasQtd.length - 1];
    setNomePai(`${baseProd.nome.slice(0, peso.inicio)}${kg(peso.kg * min)}kg a ${kg(peso.kg * max)}kg${baseProd.nome.slice(peso.fim)}`.replace(/\s+/g, " ").trim());
  }, [baseProd, todasQtd.join(",")]);
  useEffect(() => { if (sugQ.data?.skus?.[0]) setSkuPai(sugQ.data.skus[0]); }, [sugQ.data]);
  /** SKU final de cada quantidade: o da variação do pai que já existe, ou os próximos livres do Tiny. */
  const skuDaQtd = useMemo(() => {
    const m = new Map<number, string>();
    if (paiExistente) for (const n of todasQtd) m.set(n, paiExistente.porQtd.get(n)!);
    else {
      const livres = (sugQ.data?.skus ?? []).filter((x) => x !== skuPai);
      todasQtd.forEach((n, i) => { if (livres[i]) m.set(n, livres[i]); });
    }
    return m;
  }, [paiExistente?.sku, sugQ.data, skuPai, todasQtd.join(",")]);

  // pendências que a tela já enxerga
  const pend: string[] = [];
  if (anuncio && cad && !base) pend.push("as opções deste anúncio não são todas kits de UM mesmo produto base: o pai no Tiny não dá para montar por aqui");
  if (cad && hoje.some((m) => !m.sku)) pend.push("há variação sem SKU no anúncio: corrija no Seller Center antes");
  if (qtdNovas.some((n) => !(n >= 1))) pend.push("quantidade inválida numa opção nova");
  if (new Set([...qtdHoje, ...qtdNovas]).size !== qtdHoje.length + qtdNovas.length) pend.push("há quantidade repetida (cada quantidade aparece uma vez no anúncio)");
  if (!linhas.length) pend.push("acrescente ao menos uma opção nova");
  if (modoPai === "novo" && todasQtd.some((n) => !skuDaQtd.get(n))) pend.push("faltam SKUs livres no Tiny para as variações");
  if (anuncio && !anuncio.tem_variacao && !rotuloHoje.trim()) pend.push("dê nome à opção que o anúncio vende hoje");

  // 6) conferir (Tiny + Shopee) e aplicar
  const [conferido, setConferido] = useState<{ chave: string; pendencias: string[]; avisos: string[] } | null>(null);
  const [ocupado, setOcupado] = useState("");
  const [fim, setFim] = useState<{ tiny: ResultadoTiny | null; shopee: string[]; erro: string | null } | null>(null);

  const corpoTiny = () => ({
    base_sku: base, nome: nomePai.trim(), sku_pai: skuPai.trim(), grade: gradeTiny.trim() || "Tamanho",
    variacoes: todasQtd.map((n) => {
      const nova = linhas.find((l) => Number(l.qtd) === n);
      const ix = qtdHoje.indexOf(n);
      const preco = nova ? paraNumero(nova.preco) : (hoje[ix]?.preco ?? (precoUnit * n));
      return { sku: skuDaQtd.get(n) ?? "", rotulo: rotuloDe(n), quantidade: n, preco: Math.round((preco || 0) * 100) / 100 };
    }),
  });
  const novasShopee = () => linhas.map((l) => ({
    opcao: l.rotulo.trim(), sku: skuDaQtd.get(Number(l.qtd)) ?? "", preco: paraNumero(l.preco) || 0, estoque: Number(l.estoque) || 0,
  }));
  const trocas = () => hoje.map((m, i) => ({ model_id: m.model_id, sku: skuDaQtd.get(qtdHoje[i]) ?? "" })).filter((x) => x.model_id && x.sku && x.sku !== hoje.find((m) => m.model_id === x.model_id)?.sku);
  const skuDoPai = () => (paiExistente ? paiExistente.sku : skuPai.trim());
  /** anúncio simples: todas as opções vão no init_tier_variation (a de hoje primeiro). */
  const corpoCriarSimples = () => ({
    empresa, item_id: itemId, grade: grade.trim(),
    variacoes: [
      { opcao: rotuloHoje.trim(), sku: skuDaQtd.get(qtdHoje[0]) ?? hoje[0]?.sku, preco: hoje[0]?.preco ?? 0, estoque: hoje[0]?.estoque ?? 0 },
      ...novasShopee(),
    ],
  });
  const chave = JSON.stringify([itemId, modoPai, corpoTiny(), novasShopee(), rotuloHoje, grade]);
  const ok = conferido?.chave === chave && conferido.pendencias.length === 0;

  async function conferir() {
    setOcupado("conferindo");
    try {
      const pendencias = [...pend]; const avisos: string[] = [];
      if (modoPai === "novo") {
        // nome repetido no Tiny barra a criação do kit (lição do 16523): confere no espelho
        const nomes = [nomePai.trim(), ...corpoTiny().variacoes.map((v) => `${nomePai.trim()} - ${v.rotulo}`)];
        const { data: rep } = await supabaseExternal.from("produtos").select("sku, nome").in("nome", nomes).eq("ativo", true);
        for (const r of (rep ?? []) as { sku: string; nome: string }[]) pendencias.push(`o Tiny já tem um produto com o nome "${r.nome}" (SKU ${r.sku}): mude o nome do pai`);
        const t = await chamarVariacoes("previa", corpoTiny());
        pendencias.push(...((t.pendencias ?? []) as string[]).map((x) => `Tiny: ${x}`));
        avisos.push(...((t.avisos ?? []) as string[]).map((x) => `Tiny: ${x}`));
      }
      const s = anuncio?.tem_variacao
        ? await chamarVariacoesShopee("ampliar", { empresa, item_id: itemId, novas: novasShopee(), trocar_sku: trocas(), item_sku: skuDoPai() })
        : await chamarVariacoesShopee("previa", corpoCriarSimples());
      pendencias.push(...((s.pendencias ?? []) as string[]).map((x) => `Shopee: ${x}`));
      avisos.push(...((s.avisos ?? []) as string[]).map((x) => `Shopee: ${x}`));
      setConferido({ chave, pendencias: [...new Set(pendencias)], avisos: [...new Set(avisos)] });
    } catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message, duration: 15000 }); }
    finally { setOcupado(""); }
  }

  async function aplicar() {
    if (!ok || !anuncio) return;
    const linhasTexto = todasQtd.map((n) => {
      const ix = qtdHoje.indexOf(n);
      const sk = skuDaQtd.get(n);
      return ix >= 0
        ? `• ${hoje[ix].opcao || rotuloHoje} (já vende) — SKU ${hoje[ix].sku}${sk && sk !== hoje[ix].sku ? ` → ${sk}` : ""}`
        : `• NOVA ${linhas.find((l) => Number(l.qtd) === n)?.rotulo} — SKU ${sk} — R$ ${linhas.find((l) => Number(l.qtd) === n)?.preco}`;
    });
    if (!window.confirm([
      `Mudar o anúncio ${anuncio.item_id} da ${loja} (está ${anuncio.situacao === "NORMAL" ? "NO AR" : anuncio.situacao})?`, "",
      ...linhasTexto, "",
      paiExistente ? `No Tiny: liga ao pai ${paiExistente.sku} (já existe; nada é criado).`
        : `No Tiny: cria o pai ${skuPai} "${nomePai}" com ${todasQtd.length} variações (kits do ${base}). Produto criado não se apaga pela API.`,
      `Na Shopee: ${anuncio.tem_variacao ? "acrescenta as opções novas" : "transforma o anúncio em anúncio com variações"} e troca o SKU do anúncio para ${skuDoPai()}.`,
    ].join("\n"))) return;
    setOcupado("aplicando");
    let tiny: ResultadoTiny | null = null;
    const feitosShopee: string[] = [];
    try {
      if (!paiExistente) {
        setOcupado("criando o pai no Tiny…");
        tiny = (await chamarVariacoes("criar", { ...corpoTiny(), confirmar: true })) as ResultadoTiny;
        // o que não coube na chamada vira kit aqui, um a um (como na criação por cores)
        for (let rodada = 0; rodada < 3 && tiny.variacoes.some((v) => !v.ok && v.pendente && v.id); rodada++) {
          for (const v of tiny.variacoes.filter((x) => !x.ok && x.pendente && x.id)) {
            setOcupado(`transformando em kit: ${v.rotulo}…`);
            const k = await chamarVariacoes("kit", { id_variacao: v.id, quantidade: v.quantidade, base_sku: v.base_sku || base, confirmar: true }).catch((e) => ({ ok: false, erro: (e as Error).message }));
            tiny = { ...tiny!, variacoes: tiny!.variacoes.map((x) => (x.sku === v.sku ? { ...x, ok: k.ok === true, pendente: !k.ok && k.limite === true, erro: k.erro ?? null } : x)) };
            if (k.limite === true) { setOcupado("o Tiny pediu para esperar: retomo em 60 s…"); await new Promise((r) => setTimeout(r, 60_000)); }
          }
        }
        for (let rodada = 0; rodada < 6; rodada++) {
          setOcupado("pondo a foto nas variações…");
          const f = await chamarVariacoes("foto", { sku_pai: tiny.pai.sku, confirmar: true }).catch(() => null);
          if (!f || !((f.itens ?? []) as { pendente?: boolean }[]).some((i) => i.pendente)) break;
        }
        if (tiny.variacoes.some((v) => !v.ok)) {
          setFim({ tiny, shopee: [], erro: "o pai foi criado no Tiny, mas nem todas as variações viraram kit — a Shopee NÃO foi alterada. Resolva no Tiny e aplique de novo escolhendo este pai." });
          return;
        }
      }
      setOcupado("mudando o anúncio na Shopee…");
      if (anuncio.tem_variacao) {
        const r = await chamarVariacoesShopee("ampliar", { empresa, item_id: itemId, novas: novasShopee(), trocar_sku: trocas(), item_sku: skuDoPai(), confirmar: true });
        feitosShopee.push(...(r.feitos ?? []));
      } else {
        await chamarVariacoesShopee("criar", { ...corpoCriarSimples(), confirmar: true });
        feitosShopee.push("opções criadas");
        const r = await chamarVariacoesShopee("ampliar", { empresa, item_id: itemId, item_sku: skuDoPai(), confirmar: true }).catch((e) => ({ feitos: [], erro: (e as Error).message }));
        feitosShopee.push(...(r.feitos ?? []));
        if (r.erro) throw new Error(`opções criadas, mas o SKU do anúncio não mudou: ${r.erro}`);
      }
      setFim({ tiny, shopee: feitosShopee, erro: null });
      toast.success("Variações aplicadas", { description: `${loja} · anúncio ${anuncio.item_id}`, duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) {
      setFim({ tiny, shopee: feitosShopee, erro: (e as Error).message });
    } finally { setOcupado(""); }
  }

  const carregando = existQ.isLoading || (lerQ.isFetching && !anuncio) || cadQ.isLoading;
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adicionar variações a um anúncio no ar · {loja}</DialogTitle>
          <DialogDescription>O anúncio continua o mesmo (ID, vendas e avaliações). No Tiny, as opções ficam ligadas a um produto pai com variações.</DialogDescription>
        </DialogHeader>

        {fim ? (
          <div className="space-y-3 text-sm">
            {fim.erro
              ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3"><b className="text-destructive">Parou:</b> {fim.erro}</div>
              : <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3"><b className="text-emerald-700 dark:text-emerald-400">Pronto.</b> Shopee: {fim.shopee.join(", ") || "—"}.</div>}
            {fim.tiny && (
              <div className="rounded-md border p-3 space-y-1">
                <b>Tiny: pai {fim.tiny.pai.sku}</b> <span className="text-muted-foreground">{fim.tiny.pai.nome}</span>
                {fim.tiny.variacoes.map((v) => (
                  <div key={v.sku} className="text-xs flex items-center gap-1.5">
                    {v.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
                    {v.rotulo} · <span className="font-mono">{v.sku}</span> · kit de {v.quantidade}× {v.base_sku || base}{!v.ok && v.erro ? ` — ${v.erro}` : ""}
                  </div>
                ))}
              </div>
            )}
            {!fim.erro && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
                No Tiny, confira se o anúncio {itemId} ficou ligado ao produto {skuDoPai()} (Integrações › Shopee › anúncios). O vínculo de anúncio do Tiny não é feito pela API: se não estiver ligado, o estoque das opções novas não sobe.
              </p>
            )}
          </div>
        ) : carregando ? (
          <div className="p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Lendo o anúncio e o cadastro…</div>
        ) : (
          <div className="space-y-4 text-sm">
            {/* anúncio */}
            <div className="space-y-1.5">
              <span className="font-medium">Anúncio</span>
              <div className="flex flex-wrap gap-1.5">
                {(existQ.data ?? []).map((e) => (
                  <Button key={e.item_id} size="sm" variant={itemId === e.item_id ? "default" : "outline"} className="h-7 text-xs" onClick={() => { setItemId(e.item_id); setConferido(null); }}>
                    {e.item_id}{e.status === "UNLIST" ? " · fora do ar" : ""}
                  </Button>
                ))}
                <Input className="h-7 w-44 text-xs font-mono" placeholder="ou digite o ID" value={itemId} onChange={(e) => { setItemId(e.target.value.replace(/\D/g, "")); setConferido(null); }} />
              </div>
              {lerQ.isError && <p className="text-xs text-destructive">{(lerQ.error as Error).message}</p>}
              {anuncio && (
                <div className="rounded-md border bg-muted/20 p-2.5">
                  <div className="flex items-center gap-2"><b className="min-w-0 truncate">{anuncio.nome}</b>
                    <a href={anuncio.url} target="_blank" rel="noreferrer" className="text-xs text-primary inline-flex items-center gap-0.5 shrink-0">ver <ExternalLink className="h-3 w-3" /></a></div>
                  <div className="text-xs text-muted-foreground">SKU do anúncio {anuncio.sku ?? "—"} · {anuncio.situacao === "NORMAL" ? "no ar" : anuncio.situacao} · {anuncio.tem_variacao ? `${anuncio.variacoes.length} variações (${anuncio.grupos.map((g) => g.nome).join(" + ")})` : "anúncio simples"}</div>
                  <div className="mt-2 grid grid-cols-[1fr_90px_80px_70px_1fr] gap-x-2 gap-y-1 text-xs">
                    <span className="text-muted-foreground">Opção de hoje</span><span className="text-muted-foreground">SKU</span><span className="text-muted-foreground">Preço</span><span className="text-muted-foreground">Estoque</span><span className="text-muted-foreground">No cadastro</span>
                    {hoje.map((m, i) => {
                      const q = cad?.deQual.get(m.sku);
                      return [
                        anuncio.tem_variacao ? <span key={`o${i}`}>{m.opcao}</span>
                          : <Input key={`o${i}`} className="h-7 text-xs" value={rotuloHoje} onChange={(e) => { setRotuloHoje(e.target.value); setConferido(null); }} placeholder="nome da opção" />,
                        <span key={`s${i}`} className="font-mono">{m.sku || "—"}</span>,
                        <span key={`p${i}`}>{m.preco != null ? formatBRL(m.preco) : "—"}</span>,
                        <span key={`e${i}`}>{m.estoque ?? "—"}</span>,
                        <span key={`c${i}`} className={q ? "" : "text-destructive"}>{q ? (q.base === m.sku ? "o próprio produto" : `kit de ${q.qtd}× ${q.base}`) : "não é kit de um produto só"}</span>,
                      ];
                    })}
                  </div>
                </div>
              )}
            </div>

            {anuncio && base && (<>
              {/* opções novas */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Opções novas</span>
                  <span className="text-xs text-muted-foreground">kits de {baseProd?.nome ?? base} ({base}{baseProd?.estoque != null ? ` · ${baseProd.estoque} em estoque` : ""})</span>
                </div>
                <div className="grid grid-cols-[70px_1fr_100px_80px_28px] gap-1.5 text-[11px] text-muted-foreground">
                  <span>Qtd. no kit</span><span>Nome da opção</span><span>Preço</span><span>Estoque</span><span />
                </div>
                {linhas.map((l, i) => (
                  <div key={i} className="grid grid-cols-[70px_1fr_100px_80px_28px] gap-1.5">
                    <Input className="h-8 font-mono" value={l.qtd} onChange={(e) => { mudar(i, { qtd: e.target.value.replace(/\D/g, "") }); setConferido(null); }} />
                    <Input className="h-8" value={l.rotulo} onChange={(e) => { mudar(i, { rotulo: e.target.value }); setConferido(null); }} />
                    <Input className="h-8 font-mono" value={l.preco} onChange={(e) => { mudar(i, { preco: e.target.value }); setConferido(null); }} />
                    <Input className="h-8 font-mono" value={l.estoque} onChange={(e) => { mudar(i, { estoque: e.target.value.replace(/\D/g, "") }); setConferido(null); }} />
                    <Button size="sm" variant="ghost" className="h-8 w-7 p-0" onClick={() => { setLinhas((ls) => ls.filter((_, j) => j !== i)); setConferido(null); }}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => { setLinhas((ls) => [...ls, novaLinha(Math.max(0, ...qtdHoje, ...ls.map((x) => Number(x.qtd) || 0)) + 1)]); setConferido(null); }}>
                  <Plus className="h-3.5 w-3.5" />opção
                </Button>
                <p className="text-[11px] text-muted-foreground">Preço sugerido = preço por unidade das opções de hoje × a quantidade. Estoque inicial = estoque do produto base ÷ quantidade (depois o Tiny assume).</p>
                {!anuncio.tem_variacao && (
                  <label className="block w-48"><span className="text-[11px] text-muted-foreground">Nome do grupo na Shopee</span>
                    <Input className="h-8 mt-1" value={grade} onChange={(e) => { setGrade(e.target.value); setConferido(null); }} /></label>
                )}
              </div>

              {/* pai no Tiny */}
              <div className="space-y-1.5">
                <span className="font-medium">Produto pai no Tiny</span>
                <div className="space-y-1">
                  {paisQueServem.map((p) => (
                    <label key={p.sku} className="flex items-start gap-2 rounded-md border p-2 cursor-pointer">
                      <input type="radio" className="mt-1" checked={modoPai === p.sku} onChange={() => { setModoPai(p.sku); setConferido(null); }} />
                      <span className="text-xs"><b>Usar o pai {p.sku}</b> (já existe) · {p.nome}
                        <span className="block text-muted-foreground">{todasQtd.map((n) => `${rotuloDe(n)} → ${p.porQtd.get(n)}`).join(" · ")}</span></span>
                    </label>
                  ))}
                  {(cad?.pais ?? []).filter((p) => !paisQueServem.includes(p)).map((p) => (
                    <div key={p.sku} className="text-[11px] text-muted-foreground px-2">O pai {p.sku} tem só {[...p.porQtd.keys()].sort((a, b) => a - b).map(rotuloDe).join(", ")}: não cobre todas as opções (variação nova em pai existente não é feita pela API).</div>
                  ))}
                  <label className="flex items-start gap-2 rounded-md border p-2 cursor-pointer">
                    <input type="radio" className="mt-1" checked={modoPai === "novo"} onChange={() => { setModoPai("novo"); setConferido(null); }} />
                    <span className="text-xs"><b>Criar um pai novo</b> com uma variação por quantidade, inclusive as que o anúncio já vende (com SKU novo — os produtos de hoje continuam existindo, com o histórico deles).</span>
                  </label>
                </div>
                {modoPai === "novo" && (
                  <div className="grid sm:grid-cols-[1fr_110px_120px] gap-2">
                    <label><span className="text-[11px] text-muted-foreground">Nome do pai</span><Input className="h-8 mt-1" value={nomePai} onChange={(e) => { setNomePai(e.target.value); setConferido(null); }} /></label>
                    <label><span className="text-[11px] text-muted-foreground">SKU do pai</span><Input className="h-8 mt-1 font-mono" value={skuPai} onChange={(e) => { setSkuPai(e.target.value); setConferido(null); }} /></label>
                    <label><span className="text-[11px] text-muted-foreground">Grade no Tiny</span><Input className="h-8 mt-1" value={gradeTiny} onChange={(e) => { setGradeTiny(e.target.value); setConferido(null); }} /></label>
                    <div className="sm:col-span-3 text-[11px] text-muted-foreground">
                      {sugQ.isFetching ? "conferindo SKUs livres no Tiny…" : todasQtd.map((n) => `${rotuloDe(n)} → ${skuDaQtd.get(n) ?? "?"}`).join(" · ")}
                    </div>
                  </div>
                )}
              </div>
            </>)}

            {(pend.length > 0 && anuncio && cad) && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs space-y-0.5">{pend.map((x) => <div key={x}>• {x}</div>)}</div>
            )}
            {conferido?.chave === chave && (
              <div className="space-y-2">
                {conferido.pendencias.length > 0 ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs space-y-0.5">
                    <b className="text-destructive flex items-center gap-1.5 text-sm"><AlertTriangle className="h-4 w-4" />Falta resolver</b>
                    {conferido.pendencias.map((x) => <div key={x}>• {x}</div>)}
                  </div>
                ) : (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2.5 text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" />Conferido no Tiny e na Shopee: pronto para aplicar
                  </div>
                )}
                {conferido.avisos.length > 0 && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs space-y-0.5 text-amber-700 dark:text-amber-400">{conferido.avisos.map((x) => <div key={x}>• {x}</div>)}</div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {fim ? <Button onClick={onFechar}>Fechar</Button> : (<>
            {ocupado && ocupado !== "conferindo" && <span className="text-xs text-muted-foreground mr-auto"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />{ocupado}</span>}
            <Button variant="ghost" disabled={!!ocupado} onClick={onFechar}>Cancelar</Button>
            <Button variant="outline" disabled={!!ocupado || !anuncio || !base || pend.length > 0} onClick={() => void conferir()} className="gap-1.5">
              {ocupado === "conferindo" && <Loader2 className="h-4 w-4 animate-spin" />}Conferir
            </Button>
            <Button disabled={!!ocupado || !ok} onClick={() => void aplicar()}>Aplicar no Tiny e na Shopee</Button>
          </>)}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
