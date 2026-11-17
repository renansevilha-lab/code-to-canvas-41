// Observações e apontamentos da ordem (16/nov/2026, pedido do dono): histórico com
// quem, quando, em que etapa e fotos. Tabela compras_apontamentos; fotos no bucket
// privado `fulfillment-docs`, pasta `compras/<ordem>/` (reduzidas no navegador).
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Spinner } from "@/components/separacao/ui/kit";
import { type Apontamento, diaHora } from "./defs";
import { BotaoR, SeloR, cartaoR, kicker, mini } from "./pecas";

const BUCKET = "fulfillment-docs";
const LADO_MAX = 1600;

async function reduzir(arquivo: File): Promise<{ blob: Blob; ext: string; tipo: string }> {
  try {
    const bmp = await createImageBitmap(arquivo);
    const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * escala); canvas.height = Math.round(bmp.height * escala);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.82));
    if (blob) return { blob, ext: "jpg", tipo: "image/jpeg" };
  } catch { /* manda o original */ }
  const ext = (arquivo.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  return { blob: arquivo, ext, tipo: arquivo.type || "image/jpeg" };
}

export function Apontamentos({ ordemTinyId, autor, etapa, antiga, podeApagar }: {
  ordemTinyId: number; autor: string | null; etapa: string;
  /** observação única do modelo antigo (compras_ordens.observacao_recebimento) */
  antiga?: string | null;
  podeApagar: boolean;
}) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState("");
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [salvando, setSalvando] = useState(false);
  const inputFoto = useRef<HTMLInputElement>(null);

  const listaQ = useQuery({
    queryKey: ["compras", "apontamentos", ordemTinyId],
    queryFn: async (): Promise<Array<Apontamento & { urls: string[] }>> => {
      const { data, error } = await supabaseExternal.from("compras_apontamentos").select("*")
        .eq("ordem_tiny_id", ordemTinyId).order("criado_em", { ascending: false });
      if (error) throw error;
      const linhas = (data ?? []) as Apontamento[];
      const paths = linhas.flatMap((l) => l.fotos ?? []);
      const mapa: Record<string, string> = {};
      if (paths.length) {
        const { data: urls } = await supabaseExternal.storage.from(BUCKET).createSignedUrls(paths, 3600);
        for (const u of urls ?? []) if (u.path && u.signedUrl) mapa[u.path] = u.signedUrl;
      }
      return linhas.map((l) => ({ ...l, urls: (l.fotos ?? []).map((f) => mapa[f]).filter(Boolean) }));
    },
  });

  async function registrar() {
    const t = texto.trim();
    if (!t && arquivos.length === 0) return;
    setSalvando(true);
    try {
      const fotos: string[] = [];
      for (const [i, a] of arquivos.entries()) {
        const { blob, ext, tipo } = await reduzir(a);
        const caminho = `compras/${ordemTinyId}/${Date.now() + i}.${ext}`;
        const { error } = await supabaseExternal.storage.from(BUCKET).upload(caminho, blob, { contentType: tipo, upsert: false });
        if (error) throw new Error(`${a.name}: ${error.message}`);
        fotos.push(caminho);
      }
      const { error } = await supabaseExternal.from("compras_apontamentos").insert({
        ordem_tiny_id: ordemTinyId, texto: t || "(foto)", etapa, autor, fotos,
      });
      if (error) throw error;
      setTexto(""); setArquivos([]);
      void qc.invalidateQueries({ queryKey: ["compras", "apontamentos", ordemTinyId] });
      void qc.invalidateQueries({ queryKey: ["compras", "quadro"] });
    } catch (e) {
      toast.error("Não consegui registrar o apontamento", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  async function apagar(a: Apontamento) {
    const { error } = await supabaseExternal.from("compras_apontamentos").delete().eq("id", a.id);
    if (error) { toast.error("Não consegui apagar", { description: error.message }); return; }
    if (a.fotos?.length) void supabaseExternal.storage.from(BUCKET).remove(a.fotos);
    void qc.invalidateQueries({ queryKey: ["compras", "apontamentos", ordemTinyId] });
    void qc.invalidateQueries({ queryKey: ["compras", "quadro"] });
  }

  const lista = listaQ.data ?? [];
  const bolha: React.CSSProperties = { background: "var(--pm-s2)", borderRadius: 14, padding: "8px 12px" };

  return (
    <section style={{ ...cartaoR, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...kicker, flex: 1 }}>Observações e apontamentos</span>
        {lista.length > 0 && <SeloR>{lista.length}</SeloR>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <textarea id={`cp-apont-${ordemTinyId}`} value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder="Escreva uma observação ou apontamento desta ordem"
          aria-label="Nova observação"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void registrar(); }}
          style={{
            width: "100%", border: "1px solid var(--pm-bc)", borderRadius: 14, background: "var(--pm-s)", color: "var(--pm-t)",
            fontFamily: "inherit", fontSize: 13, padding: "8px 12px", resize: "vertical", minHeight: 58,
          }} />
        <input ref={inputFoto} type="file" accept="image/*" capture="environment" multiple hidden
          onChange={(e) => { setArquivos((a) => [...a, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <BotaoR pequeno onClick={() => inputFoto.current?.click()}><Camera size={13} /> Foto</BotaoR>
          {arquivos.length > 0 && (
            <span style={mini}>
              {arquivos.length} {arquivos.length === 1 ? "foto" : "fotos"} ·{" "}
              <button type="button" onClick={() => setArquivos([])} style={{ border: 0, background: "none", color: "var(--pm-at)", cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 11.5 }}>tirar</button>
            </span>
          )}
          <div style={{ flex: 1 }} />
          <BotaoR pequeno tom="primario" disabled={salvando || (!texto.trim() && arquivos.length === 0)} onClick={() => void registrar()}>
            {salvando && <Spinner size={12} />} Registrar
          </BotaoR>
        </div>

        {listaQ.isLoading && <span style={mini}>Lendo…</span>}
        {lista.map((a) => (
          <div key={a.id} style={bolha}>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{a.texto}</div>
            {a.urls.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                {a.urls.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer">
                    <img src={u} alt="Foto do apontamento" loading="lazy" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, display: "block" }} />
                  </a>
                ))}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--pm-t3)", marginTop: 3 }}>
              <span style={{ flex: 1 }}>
                <b style={{ fontWeight: 600, color: "var(--pm-t2)" }}>{a.autor ?? "sem nome"}</b> · {diaHora(a.criado_em)}{a.etapa ? ` · ${a.etapa.toLowerCase()}` : ""}
              </span>
              {(podeApagar || (autor && a.autor === autor)) && (
                <button type="button" onClick={() => void apagar(a)} title="Apagar este apontamento" aria-label="Apagar apontamento"
                  style={{ border: 0, background: "none", color: "var(--pm-t3)", cursor: "pointer", padding: 2 }}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
        {antiga?.trim() && (
          <div style={bolha}>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{antiga}</div>
            <div style={{ fontSize: 11, color: "var(--pm-t3)", marginTop: 3 }}>observação anterior da ordem</div>
          </div>
        )}
        {!listaQ.isLoading && lista.length === 0 && !antiga?.trim() && <span style={mini}>Nenhum apontamento ainda.</span>}
      </div>
    </section>
  );
}
