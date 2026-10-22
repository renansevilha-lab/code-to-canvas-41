import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Loader2, Plus, RefreshCw, Star, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { BUCKET_ANUNCIOS, CANAIS, chamarIa, urlsAssinadas, type IaProdutoExtra } from "@/lib/iaAnuncio";
import { InstrucoesIa } from "./InstrucoesIa";
import { prepararImagem } from "./Referencias";

export interface ProdutoIa {
  sku: string; nome: string; marca: string | null; categoria_caminho: string | null; tipo: string | null; foto: string | null;
}

/** Cabeçalho do anúncio: produto, canal/empresa, foto real de referência e dados que a gestão não tem. */
export function ProdutoTopo({ produto, custo, extra, canal, empresa, onCanal, onEmpresa, compacto }: {
  produto: ProdutoIa; custo: number | null; extra: IaProdutoExtra | null;
  canal: string; empresa: string; onCanal: (c: string) => void; onEmpresa: (e: string) => void;
  /** visual novo: nome, SKU, custo e destino já estão no cabeçalho fixo — aqui ficam só as fotos reais, a composição e os dados para a IA */
  compacto?: boolean;
}) {
  if (compacto) {
    return (
      <Card>
        <CardContent className="p-4 flex flex-col lg:flex-row gap-5">
          <FotoReferencia sku={produto.sku} fotoCatalogo={produto.foto} refPath={extra?.foto_ref_path ?? null} refs={extra?.fotos_ref ?? []} />
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <h3 className="text-[15px] font-bold">Produto e referências da IA</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{produto.categoria_caminho ?? "sem categoria no Tiny"}</p>
              {produto.tipo === "K" && <ComposicaoKit sku={produto.sku} canal={canal} empresa={empresa} />}
            </div>
            <DadosExtras sku={produto.sku} extra={extra} />
            <InstrucoesIa sku={produto.sku} />
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-4 flex flex-col lg:flex-row gap-5">
        <FotoReferencia sku={produto.sku} fotoCatalogo={produto.foto} refPath={extra?.foto_ref_path ?? null} refs={extra?.fotos_ref ?? []} />
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{produto.sku}</span>
              {produto.tipo === "K" && <Badge variant="secondary" className="text-[10px] py-0">kit</Badge>}
              {produto.marca && <Badge variant="outline" className="text-[10px] py-0">{produto.marca}</Badge>}
            </div>
            <h2 className="text-lg font-semibold leading-snug mt-1">{produto.nome}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{produto.categoria_caminho ?? "sem categoria no Tiny"}</p>
            {produto.tipo === "K" && <ComposicaoKit sku={produto.sku} canal={canal} empresa={empresa} />}
          </div>
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Canal</span>
              <Select value={canal} onValueChange={onCanal}>
                <SelectTrigger className="h-8 w-[170px] mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{CANAIS.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Empresa (imposto)</span>
              <Select value={empresa} onValueChange={onEmpresa}>
                <SelectTrigger className="h-8 w-[150px] mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ottz">Ottz / ACZ</SelectItem>
                  <SelectItem value="svl">SVL / Sevilla</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="pb-1">
              <span className="text-[11px] text-muted-foreground block">Custo (CMV da gestão)</span>
              <span className="font-mono">{custo != null ? formatBRL(custo) : <span className="text-destructive">sem custo</span>}</span>
            </div>
          </div>
          <DadosExtras sku={produto.sku} extra={extra} />
          <InstrucoesIa sku={produto.sku} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Composição do kit como no Tiny: quantidade × componente (com atalho para o anúncio do componente). */
function ComposicaoKit({ sku, canal, empresa }: { sku: string; canal: string; empresa: string }) {
  const q = useQuery({
    queryKey: ["ia-anuncio", "composicao", sku],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("produto_kits").select("sku_componente, quantidade, nome_componente").eq("sku_kit", sku).order("sku_componente");
      if (error) throw error;
      return (data ?? []) as { sku_componente: string; quantidade: number; nome_componente: string | null }[];
    },
  });
  if (!q.data) return null;
  if (!q.data.length) return <p className="text-xs text-amber-600 mt-1.5">Kit sem composição cadastrada no Tiny.</p>;
  return (
    <div className="mt-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs space-y-0.5">
      <div className="text-[10.5px] font-medium text-muted-foreground">Composição do kit</div>
      {q.data.map((c) => (
        <div key={c.sku_componente} className="flex items-baseline gap-1.5">
          <b className="tabular-nums shrink-0">{Number(c.quantidade).toLocaleString("pt-BR")}×</b>
          <Link to="/ia/gerar" search={{ sku: c.sku_componente, canal, empresa }} className="font-mono text-muted-foreground hover:underline shrink-0">{c.sku_componente}</Link>
          <span className="truncate" title={c.nome_componente ?? ""}>{c.nome_componente ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

// a principal + até 3 extras: é o que o servidor manda à IA (fotosReaisExtras, max 3)
const MAX_REFS = 4;

/**
 * Fotos reais de referência (14/out/2026, pedido do dono: mais de 1 foto). A 1ª é a principal (rótulo,
 * embalagem); as outras mostram o MESMO produto em outras cores/opções, outros ângulos ou o conteúdo.
 * Todas vão para a IA de texto, para quem escreve os prompts e para o modelo de imagem.
 */
function FotoReferencia({ sku, fotoCatalogo, refPath, refs }: { sku: string; fotoCatalogo: string | null; refPath: string | null; refs: string[] }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const inputMais = useRef<HTMLInputElement>(null);
  const [ocupado, setOcupado] = useState(false);
  const lista = useMemo(() => [...new Set([...(refPath ? [refPath] : []), ...refs.filter(Boolean)])].slice(0, 8), [refPath, refs.join("|")]);
  const urlQ = useQuery({
    queryKey: ["ia-anuncio", "ref-urls", lista.join("|")],
    enabled: lista.length > 0,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas(lista),
  });
  const principal = lista[0] ?? null;
  const src = principal ? urlQ.data?.[principal] : fotoCatalogo;
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["ia-anuncio", "produto", sku] });

  /** Grava a lista (a 1ª vira a principal). */
  async function gravar(nova: string[]) {
    const { error } = await supabaseExternal.from("ia_produto_extra")
      .upsert({ sku, foto_ref_path: nova[0] ?? null, fotos_ref: nova }, { onConflict: "sku" });
    if (error) throw error;
    recarregar();
  }
  async function subir(arquivo: File, sufixo = ""): Promise<string> {
    if (!/^image\/(jpeg|png|webp)$/.test(arquivo.type)) throw new Error(`${arquivo.name}: use JPG, PNG ou WEBP`);
    if (arquivo.size > 15_000_000) throw new Error(`${arquivo.name}: foto acima de 15 MB`);
    const pronto = await prepararImagem(arquivo);
    const path = `ref/${sku}/${Date.now()}${sufixo}.${pronto.ext}`;
    const { error } = await supabaseExternal.storage.from(BUCKET_ANUNCIOS).upload(path, pronto.blob, { contentType: pronto.mime });
    if (error) throw new Error(`${arquivo.name}: ${error.message}`);
    return path;
  }

  async function enviar(arquivo: File) {
    setOcupado(true);
    try {
      const path = await subir(arquivo);
      await chamarIa("foto-ref", { sku, path });
      toast.success("Foto principal trocada");
      recarregar();
    } catch (e) {
      toast.error("Não foi possível trocar a foto", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }
  async function adicionar(arquivos: File[]) {
    const vagas = MAX_REFS - lista.length;
    if (vagas <= 0) { toast.error(`Já são ${MAX_REFS} fotos: tire uma antes de pôr outra`); return; }
    setOcupado(true);
    try {
      // sem principal congelada ainda: congela a do Tiny primeiro, para as novas entrarem como EXTRAS
      let base = lista;
      if (!base.length && fotoCatalogo) {
        try {
          const r = await chamarIa("foto-ref", { sku, refazer: true });
          if (r.foto_ref_path) base = [String(r.foto_ref_path)];
        } catch { /* sem foto no Tiny: a 1ª enviada vira a principal */ }
      }
      const escolhidas = arquivos.slice(0, MAX_REFS - base.length);
      const novos: string[] = [];
      for (const [i, a] of escolhidas.entries()) novos.push(await subir(a, `-${i + 1}`));
      await gravar([...base, ...novos]);
      toast.success(`${novos.length} foto(s) de referência adicionada(s)`, {
        description: [
          arquivos.length > escolhidas.length ? `Só cabem ${MAX_REFS} fotos: ${arquivos.length - escolhidas.length} ficaram de fora.` : "",
          "As próximas imagens já usam estas fotos. Para um prompt já escrito considerá-las, clique em \"prompt\" na foto.",
        ].filter(Boolean).join(" "),
      });
    } catch (e) {
      toast.error("Não foi possível adicionar as fotos", { description: (e as Error).message });
      recarregar();
    } finally { setOcupado(false); }
  }
  async function mudar(nova: string[], msg: string) {
    setOcupado(true);
    try { await gravar(nova); toast.success(msg); }
    catch (e) { toast.error("Não foi possível alterar", { description: (e as Error).message }); }
    finally { setOcupado(false); }
  }
  async function usarTiny() {
    setOcupado(true);
    try {
      await chamarIa("foto-ref", { sku, refazer: true });
      toast.success("Foto do Tiny copiada como principal");
      recarregar();
    } catch (e) {
      toast.error("Não foi possível usar a foto do Tiny", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }

  return (
    <div className="w-full lg:w-[180px] shrink-0 space-y-2">
      <div className="aspect-square rounded-lg border bg-muted/30 overflow-hidden flex items-center justify-center">
        {src ? <img src={src} alt="" className="w-full h-full object-contain" /> : <ImageOff className="h-8 w-8 text-muted-foreground" />}
      </div>
      {lista.length > 0 && (
        <div className="grid grid-cols-4 gap-1">
          {lista.map((c, i) => (
            <div key={c} className={`group relative aspect-square rounded border overflow-hidden bg-muted/30 ${i === 0 ? "ring-2 ring-primary" : ""}`}>
              <button type="button" className="h-full w-full" disabled={ocupado || i === 0} title={i === 0 ? "foto principal" : "tornar esta a principal"}
                onClick={() => void mudar([c, ...lista.filter((x) => x !== c)], "Foto principal trocada")}>
                {urlQ.data?.[c] && <img src={urlQ.data[c]} alt="" className="h-full w-full object-cover" />}
              </button>
              {i === 0 && <Star className="absolute left-0.5 top-0.5 h-3 w-3 fill-primary text-primary" />}
              <button type="button" disabled={ocupado} title="tirar esta foto da referência"
                className="absolute right-0.5 top-0.5 h-4 w-4 rounded-full bg-background/90 border flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
                onClick={() => void mudar(lista.filter((x) => x !== c), i === 0 && lista.length > 1 ? "Foto tirada; a próxima virou a principal" : "Foto tirada da referência")}>
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10.5px] text-muted-foreground leading-tight">
        {lista.length > 1
          ? `${lista.length} fotos reais: a com ★ é a principal; as outras (outras cores, ângulos, o conteúdo) também vão para a IA. Clique numa para torná-la a principal.`
          : refPath ? "Foto real congelada: todas as etapas usam esta. Dá para pôr mais fotos (outras cores, ângulos)." : "Ainda sem cópia congelada: na 1ª geração o app copia a foto do Tiny."}
      </p>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void enviar(f); }} />
      <input ref={inputMais} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void adicionar(fs); }} />
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1 gap-1 px-1.5" disabled={ocupado} title="Trocar a foto principal" onClick={() => input.current?.click()}>
          {ocupado ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}Trocar
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1 gap-1 px-1.5" disabled={ocupado || lista.length >= MAX_REFS}
          title={lista.length >= MAX_REFS ? `Até ${MAX_REFS} fotos` : "Adicionar fotos reais (outras cores, ângulos, o conteúdo)"} onClick={() => inputMais.current?.click()}>
          <Plus className="h-3 w-3" />Fotos
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-[11px] px-1.5" title="Usar de novo a foto do Tiny como principal" disabled={ocupado} onClick={() => void usarTiny()}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function DadosExtras({ sku, extra }: { sku: string; extra: IaProdutoExtra | null }) {
  const qc = useQueryClient();
  const [publico, setPublico] = useState(extra?.publico_alvo ?? "");
  const [frete, setFrete] = useState(String(extra?.frete_adicional ?? 0));
  const [emb, setEmb] = useState(String(extra?.custo_embalagem ?? 0.3));
  const [salvando, setSalvando] = useState(false);
  const mudou = publico !== (extra?.publico_alvo ?? "") || Number(frete) !== Number(extra?.frete_adicional ?? 0)
    || Number(emb) !== Number(extra?.custo_embalagem ?? 0.3);

  async function salvar() {
    setSalvando(true);
    const { error } = await supabaseExternal.from("ia_produto_extra").upsert({
      sku, publico_alvo: publico.trim() || null,
      frete_adicional: Number(String(frete).replace(",", ".")) || 0,
      custo_embalagem: Number(String(emb).replace(",", ".")) || 0,
    }, { onConflict: "sku" });
    setSalvando(false);
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    toast.success("Dados do produto salvos (valem para o próximo preço calculado)");
    void qc.invalidateQueries({ queryKey: ["ia-anuncio", "produto", sku] });
  }

  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="block flex-1 min-w-[220px]">
        <span className="text-[11px] text-muted-foreground">Público-alvo (opcional, ajuda o texto)</span>
        <Input className="h-8 mt-1" value={publico} onChange={(e) => setPublico(e.target.value)} placeholder="Ex.: tutores de gatos em apartamento" />
      </label>
      <label className="block">
        <span className="text-[11px] text-muted-foreground">Frete adicional R$</span>
        <Input className="h-8 mt-1 w-24 font-mono" value={frete} onChange={(e) => setFrete(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-[11px] text-muted-foreground">Embalagem R$</span>
        <Input className="h-8 mt-1 w-24 font-mono" value={emb} onChange={(e) => setEmb(e.target.value)} />
      </label>
      <Button size="sm" variant="outline" className="h-8" disabled={!mudou || salvando} onClick={() => void salvar()}>
        {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Salvar
      </Button>
    </div>
  );
}
