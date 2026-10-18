import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ImageOff, Loader2, RotateCcw, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  DESCRICAO_FOTO, ROTULO_ETAPA, chamarIa, fotoSemIa, rotuloFoto, urlsAssinadas, type IaBriefing, type IaEtapa, type IaPromptImagem, type IaRascunho, type IaRascunhoImagem,
} from "@/lib/iaAnuncio";
import { SeloEtapa, decidirEtapa } from "./EtapaTexto";
import { useInstrucoesProduto } from "./InstrucoesIa";

interface ModeloImg { id: string; label: string; custo_estimado_usd: number; padrao: boolean }

/**
 * Etapa 2: plano de fotos → prompts (editáveis) → imagens geradas na fila → revisão.
 * Dá para fazer tudo de uma vez (botões de baixo) ou UMA foto por vez (botões de cada linha).
 */
export function EtapaFotos({ sku, canal, ehKit, ehPai, nomeProduto, rascunho, briefing, prompts, imagens, etapas, tiposAtivos, planoCanal, modelos }: {
  sku: string; canal: string; ehKit: boolean; rascunho: IaRascunho; briefing: IaBriefing | null;
  /** produto com variações (pai): a capa já vem com as variações na barra e a maior quantidade de embalagens */
  ehPai?: boolean; nomeProduto?: string;
  prompts: IaPromptImagem[]; imagens: IaRascunhoImagem[]; etapas: IaEtapa[];
  tiposAtivos: string[]; planoCanal: string[]; modelos: ModeloImg[];
}) {
  const qc = useQueryClient();
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });

  // plano sugerido: o que o briefing recomenda, senão o plano do canal (mesma regra da edge fn)
  const sugerido = useMemo(() => {
    const norm = (f: string) => (f.startsWith("imagem_") ? f : `imagem_${f}`);
    const rec = (briefing?.fotos_recomendadas ?? []).map(norm);
    const base = (rec.length ? rec : planoCanal.map(norm)).filter((t) => tiposAtivos.includes(t));
    return [...new Set(ehKit ? base : base.filter((t) => t !== "imagem_kit"))];
  }, [briefing, planoCanal, tiposAtivos, ehKit]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => { setSel(new Set(sugerido)); }, [sugerido.join("|")]);

  const capas = tiposAtivos.filter((t) => t.startsWith("imagem_capa_"));
  const outros = tiposAtivos.filter((t) => !t.startsWith("imagem_capa_") && (ehKit || t !== "imagem_kit"));
  const promptPor = new Map(prompts.map((p) => [p.tipo, p]));
  // prompt escrito ANTES das instruções do produto (salvas ou mudadas depois) não as conhece: ao gerar a
  // imagem ele é reescrito sozinho (menos o editado à mão)
  const instrQ = useInstrucoesProduto(sku);
  const marcoInstr = instrQ.data?.updated_at ? Date.parse(instrQ.data.updated_at) : 0;
  const promptVelho = (t: string) => { const p = promptPor.get(t); return !!p && !p.editado_mao && marcoInstr > Date.parse(p.updated_at); };
  const etapaPorImagem = new Map(etapas.filter((e) => e.etapa === "imagem").map((e) => [e.imagem_id, e]));

  const [capa, setCapa] = useState({ quantidade: "", peso: "", barra: "", faixa: "", icones: "", fundo: "", sem_texto: false });
  // PRODUTO COM VARIAÇÕES (13/out, pedido do dono): a barra da capa já nasce com as variações (na ordem da
  // quantidade) e a composição mostra a MAIOR quantidade de embalagens. Só preenche o que está vazio.
  const varsQ = useQuery({
    queryKey: ["ia-anuncio", "capa-variacoes", sku],
    enabled: ehPai === true,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ barra: string; quantidade: string } | null> => {
      const { data: vs } = await supabaseExternal.from("produtos").select("sku, nome").eq("sku_pai", sku).eq("ativo", true);
      const vars = (vs ?? []) as { sku: string; nome: string | null }[];
      if (vars.length < 2) return null;
      const { data: ks } = await supabaseExternal.from("produto_kits").select("sku_kit, quantidade").in("sku_kit", vars.map((v) => v.sku));
      const qtd = new Map(((ks ?? []) as { sku_kit: string; quantidade: number }[]).map((k) => [k.sku_kit, Number(k.quantidade) || 1]));
      const base = nomeProduto ?? "";
      const lista = vars.map((v) => {
        const n = v.nome ?? v.sku;
        return { rotulo: (base && n.startsWith(`${base} - `) ? n.slice(base.length + 3) : n.includes(" - ") ? n.slice(n.lastIndexOf(" - ") + 3) : n).trim(), q: qtd.get(v.sku) ?? 1 };
      }).sort((a, z) => a.q - z.q);
      return { barra: lista.map((l) => l.rotulo).join(lista.some((l) => l.rotulo.includes(" ")) ? ", " : " "), quantidade: String(Math.max(...lista.map((l) => l.q))) };
    },
  });
  useEffect(() => {
    const v = varsQ.data;
    if (v) setCapa((c) => ({ ...c, barra: c.barra || v.barra, quantidade: c.quantidade || v.quantidade }));
  }, [varsQ.data]);
  /** Capa com o selo "Menor Preço da Shopee": o título digitado NÃO vale para ela (só para a Ambientada Texto). */
  const seloShopee = (x: string) => x.startsWith("imagem_capa_") && x.includes("shopee");
  /** Escreve os prompts; se há título digitado e capas dos dois tipos, manda as da Shopee à parte, sem o título. */
  async function escreverPrompts(fotos: string[], forcarAgora: boolean) {
    const grupos = fotos.some(seloShopee) && fotos.some((x) => !seloShopee(x)) ? [fotos.filter((x) => !seloShopee(x)), fotos.filter(seloShopee)] : [fotos];
    const out = { prompts_escritos: [] as { tipo: string; confirmar: boolean }[], pulados: [] as { tipo: string; motivo: string }[] };
    for (const g of grupos) {
      const dados = !g.some((x) => x.startsWith("imagem_capa_")) ? null : g.every(seloShopee) ? { ...capa, faixa: "" } : capa;
      const r = await chamarIa("prompts-imagem", { sku, canal, fotos: g, forcar: forcarAgora, capa: dados });
      out.prompts_escritos.push(...((r.prompts_escritos ?? []) as { tipo: string; confirmar: boolean }[]));
      out.pulados.push(...((r.pulados ?? []) as { tipo: string; motivo: string }[]));
    }
    return out;
  }
  const [forcar, setForcar] = useState(false);
  const [preparando, setPreparando] = useState(false);
  const [modelo, setModelo] = useState(modelos.find((m) => m.padrao)?.id ?? modelos[0]?.id ?? "");
  const [obs, setObs] = useState("");
  const [enfileirando, setEnfileirando] = useState(false);
  // foto que está sendo feita sozinha pelos botões da linha: tipo → o que está rodando
  const [umaVez, setUmaVez] = useState<Record<string, "prompt" | "imagem">>({});
  const imagemPor = new Map(imagens.map((i) => [`imagem_${i.tipo}`, i]));
  const alternar = (t: string) => setSel((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const temCapaSel = [...sel].some((t) => t.startsWith("imagem_capa_"));

  async function prepararPrompts(so?: string) {
    const fotos = so ? [so] : [...sel];
    if (!fotos.length) { toast.error("Escolha ao menos uma foto"); return; }
    if (so) setUmaVez((u) => ({ ...u, [so]: "prompt" })); else setPreparando(true);
    try {
      // pela linha, refazer é o esperado quando o prompt já existe (o editado à mão só é trocado com a caixa marcada)
      const r = await escreverPrompts(fotos, so ? (forcar || !promptPor.get(so)?.editado_mao) : forcar);
      const feitos = r.prompts_escritos;
      const pulados = r.pulados;
      toast.success(`${feitos.length} prompt(s) preparado(s)`, {
        description: [...feitos.filter((f) => f.confirmar).map((f) => `${rotuloFoto(f.tipo)}: tem [CONFIRMAR] — revise`),
          ...pulados.map((p) => `${rotuloFoto(p.tipo)}: ${p.motivo}`)].slice(0, 6).join("\n") || undefined,
      });
      recarregar();
    } catch (e) { toast.error("Falha ao preparar os prompts", { description: (e as Error).message }); }
    finally { if (so) setUmaVez((u) => { const n = { ...u }; delete n[so]; return n; }); else setPreparando(false); }
  }
  async function gerarImagens(fotos: string[], observacao?: string, so?: string) {
    // foto sem prompt escrito sairia do modelo genérico (cena crua, sem o texto de venda), e capa sem
    // prompt nem é gerada: escreve antes o prompt das que faltam, com os dados da capa do formulário
    const semPrompt = fotos.filter((t) => !promptPor.has(t));
    const velhos = fotos.filter(promptVelho);
    if (so) setUmaVez((u) => ({ ...u, [so]: semPrompt.length || velhos.length ? "prompt" : "imagem" })); else setEnfileirando(true);
    try {
      if (semPrompt.length || velhos.length) {
        const rp = semPrompt.length ? await escreverPrompts(semPrompt, false) : { prompts_escritos: [], pulados: [] as { tipo: string; motivo: string }[] };
        // os anteriores às instruções são reescritos (forçar), para a imagem seguir o que foi pedido
        if (velhos.length) { const rv = await escreverPrompts(velhos, true); rp.pulados.push(...rv.pulados); }
        const falhou = rp.pulados.filter((x) => !/já existe|preservado/.test(x.motivo));
        if (falhou.length) toast.warning("Alguns prompts não foram escritos", { description: falhou.map((x) => `${rotuloFoto(x.tipo)}: ${x.motivo}`).slice(0, 5).join("\n") });
        recarregar();
        if (so) setUmaVez((u) => ({ ...u, [so]: "imagem" }));
      }
      const r = await chamarIa("imagens", { rascunho_id: rascunho.id, fotos, modelo, observacao: observacao ?? (obs || undefined) });
      const puladas = (r.puladas ?? []) as { tipo: string; motivo: string }[];
      toast.success(`${(r.enfileiradas ?? []).length} imagem(ns) na fila`, {
        description: [`custo estimado US$ ${r.custo_estimado_usd}`, r.aviso, ...puladas.map((p) => `${p.tipo}: ${p.motivo}`)].filter(Boolean).slice(0, 6).join("\n"),
      });
      recarregar();
    } catch (e) { toast.error("Não foi possível gerar", { description: (e as Error).message, duration: 12000 }); recarregar(); }
    finally { if (so) setUmaVez((u) => { const n = { ...u }; delete n[so]; return n; }); else setEnfileirando(false); }
  }

  const linha = (t: string) => {
    const p = promptPor.get(t);
    const img = imagemPor.get(t);
    const et = img ? etapaPorImagem.get(img.id) : undefined;
    const andando = et && ["na_fila", "gerando"].includes(et.status);
    const st = et ? ROTULO_ETAPA[et.status] : null;
    const rodando = umaVez[t];
    return (
      <div key={t} className="flex items-start gap-2 py-1.5">
        <Checkbox className="mt-0.5" checked={sel.has(t)} onCheckedChange={() => alternar(t)} id={`foto-${t}`} />
        <label htmlFor={`foto-${t}`} className="min-w-0 flex-1 cursor-pointer">
          <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
            <span className="capitalize font-medium">{rotuloFoto(t)}</span>
            {p && <span className="text-[10px] text-muted-foreground">{p.editado_mao ? "prompt editado" : "prompt pronto"}</span>}
            {promptVelho(t) && <span className="text-[10px] text-amber-700 dark:text-amber-400" title="O prompt foi escrito antes das instruções do produto; ao gerar a imagem ele é reescrito com elas.">· instruções novas: o prompt será reescrito</span>}
            {p?.prompt.includes("[CONFIRMAR") && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-label="prompt pede confirmação" />}
            {st && <span className="text-[10px] font-semibold" style={{ color: st.cor }}>· imagem {st.rotulo}</span>}
          </div>
          {DESCRICAO_FOTO[t] && <div className="text-[11px] text-muted-foreground leading-snug">{DESCRICAO_FOTO[t]}</div>}
        </label>
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" disabled={!!rodando || preparando}
            title={p ? "Escrever de novo o prompt só desta foto" : "Escrever o prompt só desta foto"} onClick={() => void prepararPrompts(t)}>
            {rodando === "prompt" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}{rodando === "prompt" ? "escrevendo…" : "prompt"}
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] gap-1" disabled={!!rodando || enfileirando || !!andando}
            title={img?.storage_path ? "Gerar de novo só esta imagem" : "Gerar só esta imagem"} onClick={() => void gerarImagens([t], undefined, t)}>
            {rodando || andando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}{img?.storage_path ? "refazer" : "imagem"}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Card><CardContent className="p-5 space-y-5">
      <h3 className="font-semibold">2 · Fotos</h3>

      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
        <p><b className="text-foreground">Prompt</b> é a instrução que a IA escreve para o modelo de imagem, a partir do briefing, da foto real e das referências. Você pode ler e editar antes de gerar.</p>
        <p><b className="text-foreground">Imagem</b>: ao clicar, o prompt é escrito (se ainda não existe) e a imagem é gerada em seguida, sem etapa de confirmação. O que a IA não conseguir ler na foto (peso, por exemplo) simplesmente fica de fora da arte. Cada imagem é cobrada à parte.</p>
        <p>Faça <b className="text-foreground">uma foto por vez</b> pelos botões de cada linha, ou marque várias e use os botões de baixo.</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Fotos do anúncio (marcadas = plano sugerido)</p>
          <div className="divide-y">{outros.map(linha)}</div>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground mb-1">Capas (a primeira foto do anúncio; escolha um estilo)</p>
          <div className="divide-y">{capas.map(linha)}</div>
          {temCapaSel && (
            <div className="rounded-md border p-2.5 mt-2 space-y-1.5">
              <p className="text-[11px] font-medium">Dados da capa (vazio = a IA decide; barra vazia = sem barra; ícones vazios = sem ícones)</p>
              <div className="grid grid-cols-2 gap-1.5">
                <Input className="h-7 text-xs" placeholder="Qtd. de embalagens" value={capa.quantidade} onChange={(e) => setCapa({ ...capa, quantidade: e.target.value })} />
                <Input className="h-7 text-xs" placeholder="Peso na embalagem (ex. 4kg)" value={capa.peso} onChange={(e) => setCapa({ ...capa, peso: e.target.value })} />
                <Input className="h-7 text-xs" placeholder="Barra de variações (ex. 4kg 8kg 12kg)" value={capa.barra} onChange={(e) => setCapa({ ...capa, barra: e.target.value })} disabled={capa.sem_texto} />
                <Input className="h-7 text-xs" placeholder="Título do selo (vazio = pelo nome do produto)" title="Só vale na Capa Ambientada Texto (as da Shopee levam sempre MENOR PREÇO DA SHOPEE). Vazio: a IA escreve o tipo de produto e o diferencial, tirados do nome. Use | para separar a 2ª linha." value={capa.faixa} onChange={(e) => setCapa({ ...capa, faixa: e.target.value })} disabled={capa.sem_texto} />
                <Input className="h-7 text-xs" placeholder="Ícones de benefício (vazio = nenhum)" value={capa.icones} onChange={(e) => setCapa({ ...capa, icones: e.target.value })} disabled={capa.sem_texto} />
                <Input className="h-7 text-xs" placeholder="Fundo / composição" value={capa.fundo} onChange={(e) => setCapa({ ...capa, fundo: e.target.value })} />
              </div>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <Checkbox checked={capa.sem_texto} onCheckedChange={(v) => setCapa({ ...capa, sem_texto: v === true })} />capa sem nenhum texto
              </label>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <Button size="sm" variant="outline" className="gap-1.5" disabled={preparando || !sel.size} onClick={() => void prepararPrompts()}>
          {preparando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}Preparar prompts das marcadas ({sel.size})
        </Button>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <Checkbox checked={forcar} onCheckedChange={(v) => setForcar(v === true)} />refazer os que já existem (inclusive editados à mão)
        </label>
        <div className="flex-1" />
        <select className="h-8 rounded-md border bg-background px-2 text-xs" value={modelo} onChange={(e) => setModelo(e.target.value)}>
          {modelos.map((m) => <option key={m.id} value={m.id}>{m.label} · US$ {Number(m.custo_estimado_usd).toFixed(3)}/img</option>)}
        </select>
        <Input className="h-8 max-w-[240px] text-xs" value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observação para a imagem (opcional)" />
        <Button size="sm" className="gap-1.5" disabled={enfileirando || !sel.size} onClick={() => void gerarImagens([...sel])}>
          {enfileirando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Gerar imagens das marcadas ({sel.size})
        </Button>
      </div>

      {[...sel].some((t) => promptPor.has(t)) && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">Prompts das fotos marcadas (edite à vontade — editado à mão não é sobrescrito)</p>
          {[...sel].filter((t) => promptPor.has(t)).map((t) => <EditorPrompt key={t} prompt={promptPor.get(t)!} />)}
        </div>
      )}

      <GradeImagens imagens={imagens} etapaPorImagem={etapaPorImagem} onRefazer={(tipo, o) => void gerarImagens([`imagem_${tipo}`], o)} />
    </CardContent></Card>
  );
}

function EditorPrompt({ prompt }: { prompt: IaPromptImagem }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState(prompt.prompt);
  const [aberto, setAberto] = useState(prompt.prompt.includes("[CONFIRMAR"));
  useEffect(() => { setTexto(prompt.prompt); }, [prompt.updated_at]);
  async function salvar() {
    const { error } = await supabaseExternal.from("ia_prompt_imagem").update({ prompt: texto, editado_mao: true }).eq("id", prompt.id);
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    toast.success(`Prompt de ${rotuloFoto(prompt.tipo)} salvo`);
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  }
  const confirmar = texto.includes("[CONFIRMAR");
  return (
    <div className="rounded-md border">
      <button type="button" className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left" onClick={() => setAberto((v) => !v)}>
        <span className="capitalize font-medium">{rotuloFoto(prompt.tipo)}</span>
        {prompt.editado_mao && <span className="text-[10px] text-muted-foreground">editado à mão</span>}
        {confirmar && <span className="text-[10.5px] text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />tem [CONFIRMAR …] — corrija antes de gerar</span>}
      </button>
      {aberto && (
        <div className="px-3 pb-2 space-y-1.5">
          <Textarea className="min-h-[160px] text-xs font-mono" value={texto} onChange={(e) => setTexto(e.target.value)} />
          <Button size="sm" variant="outline" className="h-7" disabled={texto === prompt.prompt} onClick={() => void salvar()}>Salvar prompt</Button>
        </div>
      )}
    </div>
  );
}

function GradeImagens({ imagens, etapaPorImagem, onRefazer }: {
  imagens: IaRascunhoImagem[]; etapaPorImagem: Map<string | null, IaEtapa>; onRefazer: (tipo: string, obs?: string) => void;
}) {
  const qc = useQueryClient();
  const paths = imagens.map((i) => i.storage_path).filter(Boolean) as string[];
  const urlsQ = useQuery({
    queryKey: ["ia-anuncio", "urls", paths.join("|")],
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas(paths),
  });
  const [obsPor, setObsPor] = useState<Record<string, string>>({});
  if (!imagens.length) return null;
  async function decidir(etapa: IaEtapa, aprovar: boolean) {
    try { await decidirEtapa(etapa.id, aprovar); void qc.invalidateQueries({ queryKey: ["ia-anuncio"] }); }
    catch (e) { toast.error("Não foi possível", { description: (e as Error).message }); }
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
      {[...imagens].sort((a, b) => a.ordem - b.ordem).map((img) => {
        const et = etapaPorImagem.get(img.id);
        const url = img.storage_path ? urlsQ.data?.[img.storage_path] : null;
        const ocupada = et && ["na_fila", "gerando"].includes(et.status);
        return (
          <div key={img.id} className="rounded-lg border overflow-hidden flex flex-col">
            <div className="aspect-square bg-muted/30 flex items-center justify-center relative">
              {url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="" className="w-full h-full object-cover" /></a>
                : ocupada ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /> : <ImageOff className="h-6 w-6 text-muted-foreground" />}
              {url && ocupada && <div className="absolute inset-0 bg-background/60 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>}
            </div>
            <div className="p-2 space-y-1.5 text-xs flex-1 flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="capitalize font-medium flex-1 truncate">{img.ordem}. {rotuloFoto(img.tipo ?? "")}</span>
                <SeloEtapa etapa={et} />
              </div>
              {et?.erro && <p className="text-destructive text-[11px] line-clamp-3" title={et.erro}>{et.erro}</p>}
              {et?.status === "na_fila" && et.proxima_em && <p className="text-[11px] text-muted-foreground">nova tentativa às {new Date(et.proxima_em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p>}
              <div className="flex-1" />
              {et && !ocupada && (
                <>
                  <div className="flex gap-1">
                    {img.storage_path && et.status !== "aprovado" && <Button size="sm" className="h-6 px-2 text-[11px] gap-0.5" onClick={() => void decidir(et, true)}><Check className="h-3 w-3" />Aprovar</Button>}
                    {img.storage_path && et.status !== "rejeitado" && <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] gap-0.5" onClick={() => void decidir(et, false)}><X className="h-3 w-3" />Rejeitar</Button>}
                  </div>
                  {!fotoSemIa(img.tipo ?? "") && <div className="flex gap-1">
                    <Input className="h-6 text-[11px]" placeholder="o que mudar?" value={obsPor[img.id] ?? ""} onChange={(e) => setObsPor({ ...obsPor, [img.id]: e.target.value })} />
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" title="Refazer esta imagem" onClick={() => onRefazer(img.tipo ?? "", obsPor[img.id] || undefined)}>
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  </div>}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
