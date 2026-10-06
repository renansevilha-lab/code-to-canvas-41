import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { FileText, Image as ImageIcon, Info, Layers, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { APLICA_EM, BUCKET_CONTEXTO, PAPEIS, type EscopoContexto, type IaContexto } from "@/lib/ia";
import { cn } from "@/lib/utils";

// ============================================================================
// /ia/contextos — materiais de apoio do gerador (cenas por categoria,
// identidade de marca, fotos de referência). Porta da tela Contextos do
// Anúncio Mágico. Quantos SKUs cada contexto atinge e as listas de marca/
// categoria vêm do banco (ia_contexto_alcance / ia_chaves_contexto), com a
// MESMA regra da ia_contextos_do_sku (categoria por prefixo do caminho).
// ============================================================================

export const Route = createFileRoute("/ia/contextos")({ component: IaContextosPage });

const QOPTS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;
const ESCOPOS: EscopoContexto[] = ["global", "categoria", "marca", "sku"];
const COLS = "id,nome,escopo,chave,tipo,conteudo,storage_path,media_type,aplica_em,prioridade,ativo,papel";

function IaContextosPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<IaContexto> | null>(null);

  const ctxQ = useQuery({
    queryKey: ["ia", "contexto"],
    ...QOPTS,
    queryFn: async (): Promise<IaContexto[]> => {
      const { data, error } = await supabaseExternal.from("ia_contexto").select(COLS).order("escopo").order("chave").order("nome");
      if (error) throw error;
      return (data ?? []) as IaContexto[];
    },
  });
  const alcanceQ = useQuery({
    queryKey: ["ia", "contexto_alcance"],
    ...QOPTS,
    queryFn: async (): Promise<Map<string, number>> => {
      const { data, error } = await supabaseExternal.from("ia_contexto_alcance").select("id,skus");
      if (error) throw error;
      return new Map(((data ?? []) as { id: string; skus: number }[]).map((r) => [r.id, Number(r.skus)]));
    },
  });

  const grupos = useMemo(() => {
    const g: Partial<Record<EscopoContexto, IaContexto[]>> = {};
    for (const c of ctxQ.data ?? []) (g[c.escopo] ??= []).push(c);
    return g;
  }, [ctxQ.data]);

  async function alternar(c: IaContexto) {
    const { error } = await supabaseExternal.from("ia_contexto").update({ ativo: !c.ativo }).eq("id", c.id);
    if (error) { toast.error(error.message); return; }
    void qc.invalidateQueries({ queryKey: ["ia"] });
  }
  async function excluir(c: IaContexto) {
    if (!window.confirm(`Excluir o contexto "${c.nome}"?${c.storage_path ? "\n\nO arquivo anexado também é apagado." : ""}`)) return;
    const { error } = await supabaseExternal.from("ia_contexto").delete().eq("id", c.id);
    if (error) { toast.error(error.message); return; }
    if (c.storage_path) await supabaseExternal.storage.from(BUCKET_CONTEXTO).remove([c.storage_path]);
    toast.success("Contexto excluído");
    void qc.invalidateQueries({ queryKey: ["ia"] });
  }

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" /> Contextos de anúncio (IA)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cenas por categoria, identidade de marca e fotos de referência que entram nos prompts.
            {ctxQ.data ? ` ${ctxQ.data.length} entradas.` : ""}
          </p>
        </div>
        <Button size="sm" className="gap-1.5"
          onClick={() => setEditing({ escopo: "categoria", tipo: "texto", papel: "diretriz", ativo: true, prioridade: 110, aplica_em: ["imagem"] })}>
          <Plus className="h-3.5 w-3.5" /> Novo contexto
        </Button>
      </div>

      <ContextosDoSku />

      {ctxQ.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {ESCOPOS.map((esc) => {
        const itens = grupos[esc] ?? [];
        if (itens.length === 0) return null;
        return (
          <section key={esc} className="flex flex-col gap-2">
            <h2 className="text-[12px] font-bold uppercase tracking-wide text-muted-foreground">Escopo · {esc} · {itens.length}</h2>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {itens.map((c) => (
                <Card key={c.id} className={cn(!c.ativo && "opacity-60")}>
                  <CardContent className="flex flex-col gap-2 p-3">
                    <div className="flex items-start gap-2">
                      <Miniatura c={c} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-semibold" title={c.nome}>{c.nome}</span>
                          <Switch checked={c.ativo} onCheckedChange={() => void alternar(c)} className="ml-auto" />
                        </div>
                        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.tipo}</Badge>
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">{c.papel}</Badge>
                          {c.chave && <span className="font-mono truncate" title={c.chave}>{c.chave}</span>}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          Atinge {alcanceQ.data?.get(c.id) ?? "…"} SKUs · prioridade {c.prioridade} · {c.aplica_em.join(", ")}
                        </div>
                      </div>
                    </div>
                    {c.tipo === "texto" && c.conteudo && (
                      <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{c.conteudo}</p>
                    )}
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditing(c)}>Editar</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-xs text-red-600 dark:text-red-400" onClick={() => void excluir(c)}
                        aria-label="Excluir contexto">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        );
      })}

      <EditorContexto valor={editing} onFechar={() => setEditing(null)} onSalvo={() => void qc.invalidateQueries({ queryKey: ["ia"] })} />
    </div>
  );
}

/** Miniatura: imagem do bucket privado por signed URL (cache 50 min). */
function Miniatura({ c }: { c: IaContexto }) {
  const url = useUrlAssinada(c.tipo === "imagem" ? c.storage_path : null);
  if (c.tipo === "imagem" && url) return <img src={url} alt="" className="h-12 w-12 rounded border object-cover shrink-0" loading="lazy" />;
  const Icone = c.tipo === "documento" ? FileText : c.tipo === "imagem" ? ImageIcon : Info;
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded border bg-muted">
      <Icone className="h-5 w-5 text-muted-foreground" />
    </span>
  );
}
function useUrlAssinada(path: string | null) {
  const q = useQuery({
    queryKey: ["ia", "signed", path],
    enabled: !!path,
    staleTime: 50 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.storage.from(BUCKET_CONTEXTO).createSignedUrl(path!, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
  return q.data ?? null;
}

/** "Quais contextos valem para este SKU?" — ia_contextos_do_sku (regra no banco). */
function ContextosDoSku() {
  const [sku, setSku] = useState("");
  const [busca, setBusca] = useState<string | null>(null);
  const [aplica, setAplica] = useState("imagem");
  const produtoQ = useQuery({
    queryKey: ["ia", "produto", busca],
    enabled: !!busca,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("ia_produto")
        .select("sku,nome,marca,categoria_caminho,foto").eq("sku", busca!).maybeSingle();
      if (error) throw error;
      return data as { sku: string; nome: string | null; marca: string | null; categoria_caminho: string | null; foto: string | null } | null;
    },
  });
  const ctxQ = useQuery({
    queryKey: ["ia", "contextos_do_sku", busca, aplica],
    enabled: !!busca,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("ia_contextos_do_sku", { p_sku: busca!, p_aplica_em: aplica });
      if (error) throw error;
      return (data ?? []) as IaContexto[];
    },
  });
  const p = produtoQ.data;
  return (
    <Card>
      <CardContent className="p-3 flex flex-col gap-2">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); setBusca(sku.trim() || null); }}>
          <span className="text-sm font-semibold">Ver contextos de um SKU</span>
          <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" className="h-8 w-32 text-sm" />
          <Select value={aplica} onValueChange={setAplica}>
            <SelectTrigger className="h-8 w-40 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{APLICA_EM.map((a) => <SelectItem key={a.v} value={a.v}>{a.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" size="sm" variant="outline" className="h-8 gap-1.5"><Search className="h-3.5 w-3.5" /> Ver</Button>
        </form>
        {busca && produtoQ.isFetched && !p && <span className="text-xs text-muted-foreground">SKU {busca} não está no catálogo.</span>}
        {p && (
          <div className="flex items-start gap-3">
            {p.foto ? <img src={p.foto} alt="" className="h-14 w-14 rounded border object-cover shrink-0" /> : <span className="h-14 w-14 rounded border bg-muted shrink-0" />}
            <div className="min-w-0 flex-1 text-xs">
              <div className="text-sm font-medium truncate">{p.nome ?? p.sku}</div>
              <div className="text-muted-foreground">Marca: {p.marca ?? "—"} · Categoria: {p.categoria_caminho ?? "—"}</div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {ctxQ.isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {(ctxQ.data ?? []).map((c, i) => (
                  <Badge key={c.id} variant="outline" className="text-[11px] gap-1" title={c.chave ?? "global"}>
                    <span className="text-muted-foreground">{i + 1}.</span> {c.nome} <span className="text-muted-foreground">({c.escopo})</span>
                  </Badge>
                ))}
                {ctxQ.data && ctxQ.data.length === 0 && <span className="text-muted-foreground">Nenhum contexto para “{aplica}”.</span>}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EditorContexto({ valor, onFechar, onSalvo }: { valor: Partial<IaContexto> | null; onFechar: () => void; onSalvo: () => void }) {
  const [form, setForm] = useState<Partial<IaContexto>>(valor ?? {});
  const [arquivo, setArquivo] = useState<File | null>(null);
  useEffect(() => { setForm(valor ?? {}); setArquivo(null); }, [valor]);

  const chavesQ = useQuery({
    queryKey: ["ia", "chaves"],
    enabled: !!valor,
    ...QOPTS,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("ia_chaves_contexto").select("tipo,valor,skus").order("valor");
      if (error) throw error;
      return (data ?? []) as { tipo: "marca" | "categoria"; valor: string; skus: number }[];
    },
  });
  const opcoes = (chavesQ.data ?? []).filter((c) => c.tipo === form.escopo);

  const salvar = useMutation({
    mutationFn: async () => {
      let storage_path = form.storage_path ?? null;
      let media_type = form.media_type ?? null;
      if (form.tipo !== "texto" && arquivo) {
        const ext = arquivo.name.split(".").pop();
        const pasta = form.escopo === "sku" && form.chave ? `sku/${form.chave}` : form.escopo ?? "global";
        const path = `${pasta}/${crypto.randomUUID()}.${ext}`;
        const { error } = await supabaseExternal.storage.from(BUCKET_CONTEXTO).upload(path, arquivo, { upsert: false, contentType: arquivo.type });
        if (error) throw error;
        storage_path = path;
        media_type = arquivo.type;
      }
      if (form.tipo !== "texto" && !storage_path) throw new Error("Escolha o arquivo.");
      const payload = {
        nome: form.nome,
        escopo: form.escopo,
        chave: form.escopo === "global" ? null : form.chave ?? null,
        tipo: form.tipo,
        papel: form.papel,
        conteudo: form.tipo === "texto" ? form.conteudo ?? null : null,
        storage_path: form.tipo === "texto" ? null : storage_path,
        media_type: form.tipo === "texto" ? null : media_type,
        aplica_em: form.aplica_em && form.aplica_em.length ? form.aplica_em : APLICA_EM.map((a) => a.v),
        prioridade: form.prioridade ?? 100,
        ativo: form.ativo ?? true,
      };
      const { error } = form.id
        ? await supabaseExternal.from("ia_contexto").update(payload).eq("id", form.id)
        : await supabaseExternal.from("ia_contexto").insert(payload);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Contexto salvo"); onSalvo(); onFechar(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const dica = PAPEIS.find((p) => p.v === form.papel)?.hint;
  const marcados = new Set(form.aplica_em ?? []);
  return (
    <Dialog open={!!valor} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{form.id ? "Editar contexto" : "Novo contexto"}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Campo rotulo="Nome"><Input value={form.nome ?? ""} onChange={(e) => setForm({ ...form, nome: e.target.value })} className="h-8 text-sm" /></Campo>
            <Campo rotulo="Prioridade"><Input type="number" value={form.prioridade ?? 100} onChange={(e) => setForm({ ...form, prioridade: Number(e.target.value) })} className="h-8 text-sm" /></Campo>
            <Campo rotulo="Escopo">
              <Select value={form.escopo ?? "global"} onValueChange={(v) => setForm({ ...form, escopo: v as EscopoContexto, chave: null })}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{ESCOPOS.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}</SelectContent>
              </Select>
            </Campo>
            <Campo rotulo={form.escopo === "categoria" ? "Chave (prefixo do caminho)" : "Chave"}>
              {form.escopo === "global" ? (
                <Input disabled className="h-8 text-sm" placeholder="—" />
              ) : (
                <>
                  <Input value={form.chave ?? ""} onChange={(e) => setForm({ ...form, chave: e.target.value })} className="h-8 text-sm font-mono"
                    list="ia-chaves" placeholder={form.escopo === "sku" ? "SKU" : form.escopo === "marca" ? "Marca" : "Ex.: Gatos -> Higiene e Limpeza -> Areia"} />
                  <datalist id="ia-chaves">
                    {opcoes.map((o) => <option key={o.valor} value={o.valor}>{`${o.skus} SKUs`}</option>)}
                  </datalist>
                </>
              )}
            </Campo>
            <Campo rotulo="Tipo">
              <Select value={form.tipo ?? "texto"} onValueChange={(v) => setForm({ ...form, tipo: v as IaContexto["tipo"] })}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="texto">texto</SelectItem><SelectItem value="imagem">imagem</SelectItem><SelectItem value="documento">documento</SelectItem>
                </SelectContent>
              </Select>
            </Campo>
            <Campo rotulo="Papel">
              <Select value={form.papel ?? "diretriz"} onValueChange={(v) => setForm({ ...form, papel: v as IaContexto["papel"] })}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{PAPEIS.map((p) => <SelectItem key={p.v} value={p.v}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </Campo>
          </div>
          {form.escopo === "categoria" && (
            <span className="text-[11px] text-muted-foreground">
              Vale para todo SKU cujo caminho de categoria COMEÇA com a chave. Termine com " -&gt; " para não pegar irmãos de nome
              parecido (ex.: "Cães -&gt; Acessórios -&gt; " não pega "Cães -&gt; Acessórios Alimentação").
            </span>
          )}
          {dica && <div className="rounded border-l-2 border-l-primary bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">{dica}</div>}
          <Campo rotulo="Entra em">
            <div className="flex flex-wrap gap-3">
              {APLICA_EM.map((a) => (
                <label key={a.v} className="flex items-center gap-1.5 text-sm">
                  <Checkbox checked={marcados.has(a.v)} onCheckedChange={(v) => {
                    const n = new Set(marcados); if (v === true) n.add(a.v); else n.delete(a.v);
                    setForm({ ...form, aplica_em: APLICA_EM.map((x) => x.v).filter((x) => n.has(x)) });
                  }} />
                  {a.label}
                </label>
              ))}
            </div>
          </Campo>
          {form.tipo === "texto" ? (
            <Campo rotulo="Conteúdo">
              <Textarea rows={8} value={form.conteudo ?? ""} onChange={(e) => setForm({ ...form, conteudo: e.target.value })} className="text-sm" />
            </Campo>
          ) : (
            <Campo rotulo={form.tipo === "imagem" ? "Imagem (jpg, png, webp)" : "Documento (pdf)"}>
              <div className="flex items-center gap-2">
                <Input type="file" className="h-8 text-xs"
                  accept={form.tipo === "imagem" ? "image/jpeg,image/png,image/webp" : "application/pdf"}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (f && f.size > 20 * 1024 * 1024) { toast.error("Máximo 20 MB"); return; }
                    setArquivo(f);
                  }} />
                {form.storage_path && !arquivo && (
                  <span className="truncate text-[11px] text-muted-foreground" title={form.storage_path}>Atual: {form.storage_path.split("/").pop()}</span>
                )}
              </div>
            </Campo>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Switch checked={form.ativo ?? true} onCheckedChange={(v) => setForm({ ...form, ativo: v })} /> Ativo
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onFechar}>Cancelar</Button>
          <Button size="sm" onClick={() => salvar.mutate()} disabled={salvar.isPending || !form.nome || (form.escopo !== "global" && !form.chave)}>
            {salvar.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{rotulo}</Label>
      {children}
    </div>
  );
}
