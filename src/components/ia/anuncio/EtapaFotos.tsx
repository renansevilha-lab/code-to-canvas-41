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
  chamarIa, rotuloFoto, urlsAssinadas, type IaBriefing, type IaEtapa, type IaPromptImagem, type IaRascunho, type IaRascunhoImagem,
} from "@/lib/iaAnuncio";
import { SeloEtapa, decidirEtapa } from "./EtapaTexto";

interface ModeloImg { id: string; label: string; custo_estimado_usd: number; padrao: boolean }

/** Etapa 2: plano de fotos → prompts (editáveis) → imagens geradas na fila → revisão. */
export function EtapaFotos({ sku, canal, ehKit, rascunho, briefing, prompts, imagens, etapas, tiposAtivos, planoCanal, modelos }: {
  sku: string; canal: string; ehKit: boolean; rascunho: IaRascunho; briefing: IaBriefing | null;
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
  const etapaPorImagem = new Map(etapas.filter((e) => e.etapa === "imagem").map((e) => [e.imagem_id, e]));

  const [capa, setCapa] = useState({ quantidade: "", peso: "", barra: "", faixa: "", icones: "", fundo: "", sem_texto: false });
  const [forcar, setForcar] = useState(false);
  const [preparando, setPreparando] = useState(false);
  const [modelo, setModelo] = useState(modelos.find((m) => m.padrao)?.id ?? modelos[0]?.id ?? "");
  const [obs, setObs] = useState("");
  const [enfileirando, setEnfileirando] = useState(false);
  const alternar = (t: string) => setSel((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const temCapaSel = [...sel].some((t) => t.startsWith("imagem_capa_"));

  async function prepararPrompts() {
    if (!sel.size) { toast.error("Escolha ao menos uma foto"); return; }
    setPreparando(true);
    try {
      const r = await chamarIa("prompts-imagem", { sku, canal, fotos: [...sel], forcar, capa: temCapaSel ? capa : null });
      const feitos = (r.prompts_escritos ?? []) as { tipo: string; confirmar: boolean }[];
      const pulados = (r.pulados ?? []) as { tipo: string; motivo: string }[];
      toast.success(`${feitos.length} prompt(s) preparado(s)`, {
        description: [...feitos.filter((f) => f.confirmar).map((f) => `${rotuloFoto(f.tipo)}: tem [CONFIRMAR] — revise`),
          ...pulados.map((p) => `${rotuloFoto(p.tipo)}: ${p.motivo}`)].slice(0, 6).join("\n") || undefined,
      });
      recarregar();
    } catch (e) { toast.error("Falha ao preparar os prompts", { description: (e as Error).message }); }
    finally { setPreparando(false); }
  }
  async function gerarImagens(fotos: string[], observacao?: string) {
    setEnfileirando(true);
    try {
      const r = await chamarIa("imagens", { rascunho_id: rascunho.id, fotos, modelo, observacao: observacao ?? (obs || undefined) });
      const puladas = (r.puladas ?? []) as { tipo: string; motivo: string }[];
      toast.success(`${(r.enfileiradas ?? []).length} imagem(ns) na fila`, {
        description: [`custo estimado US$ ${r.custo_estimado_usd}`, r.aviso, ...puladas.map((p) => `${p.tipo}: ${p.motivo}`)].filter(Boolean).slice(0, 6).join("\n"),
      });
      recarregar();
    } catch (e) { toast.error("Falha ao enfileirar", { description: (e as Error).message }); }
    finally { setEnfileirando(false); }
  }

  const linha = (t: string) => {
    const p = promptPor.get(t);
    return (
      <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
        <Checkbox checked={sel.has(t)} onCheckedChange={() => alternar(t)} />
        <span className="capitalize">{rotuloFoto(t)}</span>
        {p && <span className="text-[10px] text-muted-foreground">{p.editado_mao ? "prompt editado" : "prompt pronto"}</span>}
        {p?.prompt.includes("[CONFIRMAR") && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-label="prompt pede confirmação" />}
      </label>
    );
  };

  return (
    <Card><CardContent className="p-5 space-y-5">
      <h3 className="font-semibold">2 · Fotos</h3>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">Fotos do anúncio (marcadas = plano sugerido)</p>
          {outros.map(linha)}
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground">Capas (estilos)</p>
          {capas.map(linha)}
          {temCapaSel && (
            <div className="rounded-md border p-2.5 mt-2 space-y-1.5">
              <p className="text-[11px] font-medium">Dados da capa (vazio = a IA decide; barra vazia = sem barra)</p>
              <div className="grid grid-cols-2 gap-1.5">
                <Input className="h-7 text-xs" placeholder="Qtd. de embalagens" value={capa.quantidade} onChange={(e) => setCapa({ ...capa, quantidade: e.target.value })} />
                <Input className="h-7 text-xs" placeholder="Peso na embalagem (ex. 4kg)" value={capa.peso} onChange={(e) => setCapa({ ...capa, peso: e.target.value })} />
                <Input className="h-7 text-xs" placeholder="Barra de variações (ex. 4kg 8kg 12kg)" value={capa.barra} onChange={(e) => setCapa({ ...capa, barra: e.target.value })} disabled={capa.sem_texto} />
                <Input className="h-7 text-xs" placeholder="Faixa superior" value={capa.faixa} onChange={(e) => setCapa({ ...capa, faixa: e.target.value })} disabled={capa.sem_texto} />
                <Input className="h-7 text-xs" placeholder="Ícones (vazio = 3–5 do briefing)" value={capa.icones} onChange={(e) => setCapa({ ...capa, icones: e.target.value })} disabled={capa.sem_texto} />
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
          {preparando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}Preparar prompts ({sel.size})
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
          {enfileirando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Gerar imagens ({sel.size})
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
                  <div className="flex gap-1">
                    <Input className="h-6 text-[11px]" placeholder="o que mudar?" value={obsPor[img.id] ?? ""} onChange={(e) => setObsPor({ ...obsPor, [img.id]: e.target.value })} />
                    <Button size="sm" variant="ghost" className="h-6 px-1.5" title="Refazer esta imagem" onClick={() => onRefazer(img.tipo ?? "", obsPor[img.id] || undefined)}>
                      <RotateCcw className="h-3 w-3" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
