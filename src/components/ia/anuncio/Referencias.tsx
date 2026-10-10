import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlignLeft, FileText, Loader2, Paperclip, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { APLICA_EM, BUCKET_CONTEXTO, PAPEIS, type IaContexto, type PapelContexto } from "@/lib/ia";

// ============================================================================
// Referências e instruções do anúncio (10/out/2026, pedido do dono): subir
// arquivos extras (identidade visual, foto de referência, ficha técnica) ou
// escrever instruções para os prompts, sem sair da tela do produto.
// É o MESMO cadastro de /ia/contextos (tabela ia_contexto + bucket ia-contexto):
// aqui cria com escopo "este produto" ou "toda a marca". Quais contextos valem
// para o SKU é regra do banco (ia_contextos_do_sku).
// ============================================================================

const USOS_TEXTO = ["briefing", "titulo", "descricao", "bullet_points"];
const LIMITE_IMAGEM = 3_000_000; // acima disso a imagem é reduzida no navegador
const LIMITE_PDF = 10_000_000;

type Linha = IaContexto & { valendo: boolean };

/** Imagem grande demais para a IA: reduz para 2.000 px (JPEG) no navegador. */
async function prepararImagem(arquivo: File): Promise<{ blob: Blob; mime: string; ext: string }> {
  const ext = arquivo.type.includes("png") ? "png" : arquivo.type.includes("webp") ? "webp" : "jpg";
  if (arquivo.size <= LIMITE_IMAGEM) return { blob: arquivo, mime: arquivo.type, ext };
  const bmp = await createImageBitmap(arquivo);
  const escala = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * escala); canvas.height = Math.round(bmp.height * escala);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); // transparência vira branco
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.9));
  if (!blob) throw new Error(`não consegui reduzir ${arquivo.name}`);
  return { blob, mime: "image/jpeg", ext: "jpg" };
}

const resumoUso = (aplica: string[]) => {
  const txt = USOS_TEXTO.filter((u) => aplica.includes(u)).length;
  const partes = [txt === USOS_TEXTO.length ? "textos" : txt > 0 ? `textos (${APLICA_EM.filter((a) => USOS_TEXTO.includes(a.v) && aplica.includes(a.v)).map((a) => a.label.toLowerCase()).join(", ")})` : "",
    aplica.includes("imagem") ? "imagens" : ""].filter(Boolean);
  return partes.join(" e ") || "nada";
};
const origem = (c: IaContexto) => (c.escopo === "sku" ? "só este produto" : c.escopo === "marca" ? `marca ${c.chave}` : c.escopo === "categoria" ? `categoria ${c.chave}` : "todos os produtos");

export function Referencias({ sku, marca }: { sku: string; marca: string | null }) {
  const qc = useQueryClient();
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["ia-anuncio", "referencias", sku] });

  const refQ = useQuery({
    queryKey: ["ia-anuncio", "referencias", sku],
    queryFn: async () => {
      const [porUso, doSku] = await Promise.all([
        Promise.all(APLICA_EM.map((a) => supabaseExternal.rpc("ia_contextos_do_sku", { p_sku: sku, p_aplica_em: a.v }))),
        supabaseExternal.from("ia_contexto").select("*").eq("escopo", "sku").eq("chave", sku),
      ]);
      const mapa = new Map<string, Linha>();
      for (const r of porUso) { if (r.error) throw r.error; for (const c of (r.data ?? []) as IaContexto[]) mapa.set(c.id, { ...c, valendo: true }); }
      for (const c of (doSku.data ?? []) as IaContexto[]) if (!mapa.has(c.id)) mapa.set(c.id, { ...c, valendo: false }); // desligados deste produto
      const ordem = { sku: 0, marca: 1, categoria: 2, global: 3 } as Record<string, number>;
      const linhas = [...mapa.values()].sort((a, b) => ordem[a.escopo] - ordem[b.escopo] || a.nome.localeCompare(b.nome));
      const paths = linhas.filter((l) => l.tipo === "imagem" && l.storage_path).map((l) => l.storage_path!) ;
      const urls: Record<string, string> = {};
      if (paths.length) {
        const { data } = await supabaseExternal.storage.from(BUCKET_CONTEXTO).createSignedUrls(paths, 3600);
        for (const d of data ?? []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl;
      }
      return { linhas, urls };
    },
  });
  const linhas = refQ.data?.linhas ?? [];

  async function alternar(c: Linha) {
    const { error } = await supabaseExternal.from("ia_contexto").update({ ativo: !c.ativo }).eq("id", c.id);
    if (error) { toast.error("Não foi possível", { description: error.message }); return; }
    recarregar();
  }
  async function excluir(c: Linha) {
    if (!window.confirm(`Excluir "${c.nome}"?${c.escopo === "marca" ? `\n\nEle vale para toda a marca ${c.chave}.` : ""}`)) return;
    const { error } = await supabaseExternal.from("ia_contexto").delete().eq("id", c.id);
    if (error) { toast.error("Não foi possível excluir", { description: error.message }); return; }
    if (c.storage_path) await supabaseExternal.storage.from(BUCKET_CONTEXTO).remove([c.storage_path]);
    recarregar();
  }

  return (
    <Card><CardContent className="p-5 space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">Referências e instruções</h3>
        <span className="text-xs text-muted-foreground">o que a IA recebe além da foto do produto</span>
        <div className="flex-1" />
        <Link to="/ia/contextos" className="text-xs text-muted-foreground underline">gerenciar todos os contextos</Link>
      </div>

      {refQ.isLoading ? (
        <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</div>
      ) : refQ.isError ? (
        <p className="text-sm text-destructive">Falha: {(refQ.error as Error).message}</p>
      ) : linhas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada cadastrado para este produto, a marca ou a categoria dele.</p>
      ) : (
        <div className="rounded-md border divide-y">
          {linhas.map((c) => {
            const url = c.storage_path ? refQ.data?.urls[c.storage_path] : undefined;
            const editavel = c.escopo === "sku" || c.escopo === "marca";
            return (
              <div key={c.id} className={`flex items-start gap-3 px-3 py-2 ${c.ativo ? "" : "opacity-55"}`}>
                <div className="h-11 w-11 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                  {url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="" className="h-11 w-11 object-cover" /></a>
                    : c.tipo === "documento" ? <FileText className="h-4 w-4 text-muted-foreground" />
                    : c.tipo === "imagem" ? <Paperclip className="h-4 w-4 text-muted-foreground" /> : <AlignLeft className="h-4 w-4 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium truncate">{c.nome}</span>
                    <Badge variant="outline" className="text-[10px] py-0 px-1.5">{PAPEIS.find((p) => p.v === c.papel)?.label ?? c.papel}</Badge>
                    {!c.ativo && <Badge variant="secondary" className="text-[10px] py-0 px-1.5">desligado</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">vale para {origem(c)} · usado em {resumoUso(c.aplica_em)}</div>
                  {c.tipo === "texto" && c.conteudo && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 whitespace-pre-line">{c.conteudo}</p>}
                </div>
                {editavel && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 text-[11px] px-2" onClick={() => void alternar(c)}>{c.ativo ? "desligar" : "ligar"}</Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" title="Excluir" onClick={() => void excluir(c)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Adicionar sku={sku} marca={marca} onSalvo={recarregar} />
    </CardContent></Card>
  );
}

function Adicionar({ sku, marca, onSalvo }: { sku: string; marca: string | null; onSalvo: () => void }) {
  const [modo, setModo] = useState<"arquivo" | "instrucao" | null>(null);
  const [papel, setPapel] = useState<PapelContexto>("identidade_visual");
  const [alcance, setAlcance] = useState<"sku" | "marca">("sku");
  const [emTexto, setEmTexto] = useState(true);
  const [emImagem, setEmImagem] = useState(true);
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [nome, setNome] = useState("");
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function abrir(m: "arquivo" | "instrucao") {
    setModo(m); setPapel(m === "arquivo" ? "identidade_visual" : "diretriz");
    setArquivos([]); setNome(""); setTexto(""); setAlcance("sku"); setEmTexto(true); setEmImagem(true);
  }
  async function salvar() {
    const aplica_em = [...(emTexto ? USOS_TEXTO : []), ...(emImagem ? ["imagem"] : [])];
    if (!aplica_em.length) { toast.error("Marque onde usar: textos, imagens ou os dois"); return; }
    const escopo = alcance === "marca" && marca ? "marca" : "sku";
    const chave = escopo === "marca" ? marca! : sku;
    try {
      if (modo === "instrucao") {
        if (!texto.trim()) { toast.error("Escreva a instrução"); return; }
        setSalvando("Salvando…");
        const { error } = await supabaseExternal.from("ia_contexto").insert({
          nome: nome.trim() || (escopo === "marca" ? `Instrução da marca ${marca}` : `Instrução do produto ${sku}`),
          escopo, chave, tipo: "texto", papel, conteudo: texto.trim(), aplica_em, prioridade: 100, ativo: true,
        });
        if (error) throw error;
      } else {
        if (!arquivos.length) { toast.error("Escolha ao menos um arquivo"); return; }
        for (const [i, a] of arquivos.entries()) {
          setSalvando(`Enviando ${i + 1} de ${arquivos.length}…`);
          const ehPdf = a.type === "application/pdf";
          if (!ehPdf && !/^image\/(jpeg|png|webp)$/.test(a.type)) throw new Error(`${a.name}: use JPG, PNG, WEBP ou PDF`);
          if (ehPdf && a.size > LIMITE_PDF) throw new Error(`${a.name}: PDF acima de 10 MB`);
          const pronto = ehPdf ? { blob: a as Blob, mime: a.type, ext: "pdf" } : await prepararImagem(a);
          const path = `${escopo === "sku" ? `sku/${sku}` : "marca"}/${crypto.randomUUID()}.${pronto.ext}`;
          const up = await supabaseExternal.storage.from(BUCKET_CONTEXTO).upload(path, pronto.blob, { upsert: false, contentType: pronto.mime });
          if (up.error) throw new Error(`${a.name}: ${up.error.message}`);
          const { error } = await supabaseExternal.from("ia_contexto").insert({
            nome: (arquivos.length === 1 && nome.trim()) || a.name.replace(/\.[^.]+$/, ""),
            escopo, chave, tipo: ehPdf ? "documento" : "imagem", papel, storage_path: path, media_type: pronto.mime,
            aplica_em, prioridade: 100, ativo: true,
          });
          if (error) throw error;
        }
      }
      toast.success(modo === "instrucao" ? "Instrução salva" : arquivos.length === 1 ? "Arquivo salvo" : `${arquivos.length} arquivos salvos`,
        { description: "Vale a partir da próxima geração (texto, prompts ou imagens)." });
      setModo(null);
      onSalvo();
    } catch (e) {
      toast.error("Não foi possível salvar", { description: (e as Error).message });
      onSalvo();
    } finally { setSalvando(null); }
  }

  if (!modo) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => abrir("arquivo")}><Paperclip className="h-3.5 w-3.5" />Subir arquivos de referência</Button>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => abrir("instrucao")}><Plus className="h-3.5 w-3.5" />Escrever instrução</Button>
      </div>
    );
  }
  const dica = PAPEIS.find((p) => p.v === papel)?.hint;
  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">O que é</span>
          <Select value={papel} onValueChange={(v) => setPapel(v as PapelContexto)}>
            <SelectTrigger className="h-8 w-[210px] mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>{PAPEIS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <label className="block">
          <span className="text-[11px] text-muted-foreground">Vale para</span>
          <Select value={alcance} onValueChange={(v) => setAlcance(v as "sku" | "marca")}>
            <SelectTrigger className="h-8 w-[230px] mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sku">Só este produto ({sku})</SelectItem>
              {marca && <SelectItem value="marca">Toda a marca {marca}</SelectItem>}
            </SelectContent>
          </Select>
        </label>
        <div className="flex items-center gap-3 pb-1.5">
          <span className="text-[11px] text-muted-foreground">Usar em</span>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer"><Checkbox checked={emTexto} onCheckedChange={(v) => setEmTexto(v === true)} />textos</label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer"><Checkbox checked={emImagem} onCheckedChange={(v) => setEmImagem(v === true)} />imagens</label>
        </div>
      </div>
      {dica && <p className="text-[11px] text-muted-foreground">{dica}</p>}

      {modo === "arquivo" ? (
        <div className="space-y-2">
          <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="hidden"
            onChange={(e) => { setArquivos([...(e.target.files ?? [])]); e.target.value = ""; }} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => input.current?.click()}><Paperclip className="h-3.5 w-3.5" />Escolher arquivos</Button>
            <span className="text-xs text-muted-foreground">
              {arquivos.length ? arquivos.map((a) => a.name).join(", ") : "JPG, PNG, WEBP ou PDF (manual da marca, ficha técnica). Pode escolher vários."}
            </span>
          </div>
          {arquivos.length === 1 && <Input className="h-8 text-sm max-w-md" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Nome para identificar (opcional)" />}
          <p className="text-[11px] text-muted-foreground">
            Imagens vão para a IA que escreve os textos e os prompts e para o modelo que gera as fotos. PDF é lido só pela IA de texto e de prompts.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Input className="h-8 text-sm max-w-md" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Título curto (opcional). Ex.: Tom de voz, Não usar a palavra X" />
          <Textarea className="min-h-[110px] text-sm" value={texto} onChange={(e) => setTexto(e.target.value)}
            placeholder="Ex.: Sempre citar que rende 30 dias para 1 gato. Fundo das fotos em tons de verde. Nunca prometer controle total de odor." />
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" disabled={!!salvando} onClick={() => void salvar()}>
          {salvando ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />{salvando}</> : "Salvar"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!!salvando} onClick={() => setModo(null)}>Cancelar</Button>
      </div>
    </div>
  );
}
