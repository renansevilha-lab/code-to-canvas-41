import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageOff, Loader2, RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { BUCKET_ANUNCIOS, CANAIS, chamarIa, urlsAssinadas, type IaProdutoExtra } from "@/lib/iaAnuncio";

export interface ProdutoIa {
  sku: string; nome: string; marca: string | null; categoria_caminho: string | null; tipo: string | null; foto: string | null;
}

/** Cabeçalho do anúncio: produto, canal/empresa, foto real de referência e dados que a gestão não tem. */
export function ProdutoTopo({ produto, custo, extra, canal, empresa, onCanal, onEmpresa }: {
  produto: ProdutoIa; custo: number | null; extra: IaProdutoExtra | null;
  canal: string; empresa: string; onCanal: (c: string) => void; onEmpresa: (e: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-col lg:flex-row gap-5">
        <FotoReferencia sku={produto.sku} fotoCatalogo={produto.foto} refPath={extra?.foto_ref_path ?? null} />
        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{produto.sku}</span>
              {produto.tipo === "K" && <Badge variant="secondary" className="text-[10px] py-0">kit</Badge>}
              {produto.marca && <Badge variant="outline" className="text-[10px] py-0">{produto.marca}</Badge>}
            </div>
            <h2 className="text-lg font-semibold leading-snug mt-1">{produto.nome}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{produto.categoria_caminho ?? "sem categoria no Tiny"}</p>
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
        </div>
      </CardContent>
    </Card>
  );
}

function FotoReferencia({ sku, fotoCatalogo, refPath }: { sku: string; fotoCatalogo: string | null; refPath: string | null }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [ocupado, setOcupado] = useState(false);
  const urlQ = useQuery({
    queryKey: ["ia-anuncio", "ref-url", refPath],
    enabled: !!refPath,
    staleTime: 30 * 60_000,
    queryFn: async () => (await urlsAssinadas([refPath!]))[refPath!] ?? null,
  });
  const src = refPath ? urlQ.data : fotoCatalogo;

  async function enviar(arquivo: File) {
    if (!/^image\/(jpeg|png|webp)$/.test(arquivo.type)) { toast.error("Use JPG, PNG ou WEBP"); return; }
    if (arquivo.size > 8_000_000) { toast.error("Foto acima de 8 MB"); return; }
    setOcupado(true);
    try {
      const ext = arquivo.type.includes("png") ? "png" : arquivo.type.includes("webp") ? "webp" : "jpg";
      const path = `ref/${sku}/${Date.now()}.${ext}`;
      const { error } = await supabaseExternal.storage.from(BUCKET_ANUNCIOS).upload(path, arquivo, { contentType: arquivo.type });
      if (error) throw error;
      await chamarIa("foto-ref", { sku, path });
      toast.success("Foto de referência trocada");
      void qc.invalidateQueries({ queryKey: ["ia-anuncio", "produto", sku] });
    } catch (e) {
      toast.error("Não foi possível trocar a foto", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }
  async function usarTiny() {
    setOcupado(true);
    try {
      await chamarIa("foto-ref", { sku, refazer: true });
      toast.success("Foto do Tiny copiada como referência");
      void qc.invalidateQueries({ queryKey: ["ia-anuncio", "produto", sku] });
    } catch (e) {
      toast.error("Não foi possível usar a foto do Tiny", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }

  return (
    <div className="w-full lg:w-[180px] shrink-0 space-y-2">
      <div className="aspect-square rounded-lg border bg-muted/30 overflow-hidden flex items-center justify-center">
        {src ? <img src={src} alt="" className="w-full h-full object-contain" /> : <ImageOff className="h-8 w-8 text-muted-foreground" />}
      </div>
      <p className="text-[10.5px] text-muted-foreground leading-tight">
        {refPath ? "Foto real congelada: todas as etapas usam esta." : "Ainda sem cópia congelada: na 1ª geração o app copia a foto do Tiny."}
      </p>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void enviar(f); }} />
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-[11px] flex-1 gap-1" disabled={ocupado} onClick={() => input.current?.click()}>
          {ocupado ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}Trocar
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-[11px] px-2" title="Copiar de novo a foto do Tiny" disabled={ocupado} onClick={() => void usarTiny()}>
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
