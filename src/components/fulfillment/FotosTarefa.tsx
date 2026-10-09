import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronLeft, ChevronRight, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Fotos das tarefas do galpão (Fulfillment › Tarefas, 09/out/2026, pedido do dono).
// Ficam no bucket privado `fulfillment-docs` (o mesmo dos PDFs de envio; policy
// anon+authenticated), pasta `tarefas/<tarefa_id>/`. Sem tabela: a lista vem do
// próprio Storage. O nome do arquivo guarda quando e quem enviou:
// `<epoch ms>__<autor>.jpg`. A foto é reduzida no navegador (lado maior 1600 px,
// JPEG 82%) — foto de celular tem 4–8 MB e subiria devagar no 4G do galpão.
// ============================================================================

const BUCKET = "fulfillment-docs";
const pasta = (tarefaId: string) => `tarefas/${tarefaId}`;
const LADO_MAX = 1600;

/** Reduz a imagem no navegador; se não conseguir (formato que o navegador não lê), manda o original. */
async function reduzir(arquivo: File): Promise<{ blob: Blob; ext: string; tipo: string }> {
  try {
    const bmp = await createImageBitmap(arquivo);
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * escala), h = Math.round(bmp.height * escala);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.82));
    if (blob) return { blob, ext: "jpg", tipo: "image/jpeg" };
  } catch { /* cai no original */ }
  const ext = (arquivo.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  return { blob: arquivo, ext, tipo: arquivo.type || "image/jpeg" };
}

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";

/** Envia fotos para a pasta da tarefa. Devolve quantas subiram. */
export async function enviarFotosTarefa(tarefaId: string, arquivos: File[], autor: string): Promise<number> {
  let ok = 0;
  for (const [i, a] of arquivos.entries()) {
    if (!a.type.startsWith("image/") && !/\.(jpe?g|png|webp|heic|heif)$/i.test(a.name)) continue;
    const { blob, ext, tipo } = await reduzir(a);
    const nome = `${Date.now() + i}__${slug(autor)}.${ext}`;
    const { error } = await supabaseExternal.storage.from(BUCKET).upload(`${pasta(tarefaId)}/${nome}`, blob, { contentType: tipo, upsert: false });
    if (error) throw new Error(`${a.name}: ${error.message}`);
    ok++;
  }
  return ok;
}

/** Apaga todas as fotos da tarefa (ao excluir a tarefa). Melhor-esforço. */
export async function apagarFotosTarefa(tarefaId: string) {
  const { data } = await supabaseExternal.storage.from(BUCKET).list(pasta(tarefaId), { limit: 1000 });
  const paths = (data ?? []).map((f) => `${pasta(tarefaId)}/${f.name}`);
  if (paths.length) await supabaseExternal.storage.from(BUCKET).remove(paths);
}

interface FotoArq { path: string; url: string; quando: Date | null; autor: string }

function lerNome(nome: string): { quando: Date | null; autor: string } {
  const m = nome.match(/^(\d{10,})__([^.]*)\./);
  if (!m) return { quando: null, autor: "" };
  return { quando: new Date(Number(m[1])), autor: m[2].replace(/-/g, " ") };
}

/** Galeria de fotos da tarefa: enviar (câmera ou arquivo), ver ampliada e apagar. */
export function FotosTarefa({ tarefaId, autor }: { tarefaId: string; autor: string }) {
  const qc = useQueryClient();
  const inputCamera = useRef<HTMLInputElement>(null);
  const inputArquivo = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState<{ feitas: number; total: number } | null>(null);
  const [aberta, setAberta] = useState<number | null>(null);
  const [apagando, setApagando] = useState<string | null>(null);

  const fotosQ = useQuery({
    queryKey: ["fulfillment", "tarefa-fotos", tarefaId],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<FotoArq[]> => {
      const { data, error } = await supabaseExternal.storage.from(BUCKET).list(pasta(tarefaId), { limit: 500, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      const arqs = (data ?? []).filter((f) => f.name && !f.name.startsWith("."));
      if (!arqs.length) return [];
      const paths = arqs.map((f) => `${pasta(tarefaId)}/${f.name}`);
      const { data: urls, error: eU } = await supabaseExternal.storage.from(BUCKET).createSignedUrls(paths, 3600);
      if (eU) throw eU;
      const porPath = new Map((urls ?? []).map((u) => [u.path, u.signedUrl]));
      return arqs.map((f) => {
        const path = `${pasta(tarefaId)}/${f.name}`;
        return { path, url: porPath.get(path) ?? "", ...lerNome(f.name) };
      }).filter((f) => f.url);
    },
  });
  const fotos = fotosQ.data ?? [];

  async function enviar(lista: FileList | null) {
    const arquivos = [...(lista ?? [])];
    if (!arquivos.length) return;
    setEnviando({ feitas: 0, total: arquivos.length });
    try {
      let feitas = 0;
      for (const a of arquivos) {
        feitas += await enviarFotosTarefa(tarefaId, [a], autor);
        setEnviando({ feitas, total: arquivos.length });
      }
      toast.success(feitas === 1 ? "Foto enviada" : `${feitas} fotos enviadas`);
    } catch (e) {
      toast.error("Não foi possível enviar a foto", { description: (e as Error).message });
    } finally {
      setEnviando(null);
      void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefa-fotos", tarefaId] });
    }
  }
  async function apagar(f: FotoArq) {
    if (!window.confirm("Apagar esta foto da tarefa?")) return;
    setApagando(f.path);
    const { error } = await supabaseExternal.storage.from(BUCKET).remove([f.path]);
    setApagando(null);
    if (error) { toast.error("Não foi possível apagar", { description: error.message }); return; }
    setAberta(null);
    void qc.invalidateQueries({ queryKey: ["fulfillment", "tarefa-fotos", tarefaId] });
  }

  const atual = aberta != null ? fotos[aberta] : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">Fotos{fotos.length ? ` (${fotos.length})` : ""}</span>
        <div className="flex-1" />
        <input ref={inputCamera} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => { void enviar(e.target.files); e.target.value = ""; }} />
        <input ref={inputArquivo} type="file" accept="image/*" multiple className="hidden"
          onChange={(e) => { void enviar(e.target.files); e.target.value = ""; }} />
        <Button size="sm" variant="outline" className="gap-1.5" disabled={!!enviando} onClick={() => inputCamera.current?.click()}>
          <Camera className="h-4 w-4" /> Tirar foto
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={!!enviando} onClick={() => inputArquivo.current?.click()}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
          {enviando ? `Enviando ${enviando.feitas}/${enviando.total}…` : "Escolher fotos"}
        </Button>
      </div>
      {fotosQ.isLoading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />Carregando fotos…</div>
      ) : fotosQ.isError ? (
        <p className="text-xs text-destructive">Falha ao carregar as fotos: {(fotosQ.error as Error).message}</p>
      ) : fotos.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma foto ainda. No celular, "Tirar foto" abre a câmera.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-2">
          {fotos.map((f, i) => (
            <button key={f.path} type="button" className="aspect-square rounded-md overflow-hidden border bg-muted hover:opacity-90" onClick={() => setAberta(i)}
              title={[f.autor, f.quando?.toLocaleString("pt-BR")].filter(Boolean).join(" · ")}>
              <img src={f.url} alt="" loading="lazy" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}

      <Dialog open={atual != null} onOpenChange={(o) => { if (!o) setAberta(null); }}>
        <DialogContent className="max-w-4xl w-[calc(100vw-1rem)] p-3 sm:p-4">
          <DialogHeader className="text-left">
            <DialogTitle className="text-sm">Foto {aberta != null ? aberta + 1 : ""} de {fotos.length}</DialogTitle>
            <DialogDescription>
              {atual ? [atual.autor ? `enviada por ${atual.autor}` : "", atual.quando ? atual.quando.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""].filter(Boolean).join(" · ") : ""}
            </DialogDescription>
          </DialogHeader>
          {atual && (
            <div className="flex flex-col gap-2">
              <a href={atual.url} target="_blank" rel="noreferrer" className="block">
                <img src={atual.url} alt="" className="w-full max-h-[70vh] object-contain rounded bg-muted" />
              </a>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={aberta === 0} onClick={() => setAberta((x) => (x ?? 1) - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                <Button size="sm" variant="outline" disabled={aberta === fotos.length - 1} onClick={() => setAberta((x) => (x ?? 0) + 1)}><ChevronRight className="h-4 w-4" /></Button>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" disabled={apagando === atual.path} onClick={() => void apagar(atual)}>
                  {apagando === atual.path ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Apagar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
