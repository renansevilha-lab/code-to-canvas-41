// Manual de processos da produção (11/nov/2026): seções com passos (limpeza, conferência, envase, selagem…).
// Todos da produção leem e imprimem (treinamento); só o administrador (módulo "todos") edita.
// As seções "antes" e "ao terminar" viram os checklists da folha de controle impressa em cada lote.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { Botao, Campo, Entrada, Escolha, Selo } from "./ui";
import { abrirManual } from "./abrirFolha";
import { abrirAbaEspera } from "./folhaControle";
import { ETAPAS, QUANDO_MANUAL, dataBR, erroMsg, useManual, type ManualSecao } from "@/lib/producao";

type Rascunho = Omit<ManualSecao, "id" | "atualizado_em" | "atualizado_por"> & { id?: number };
const NOVA: Rascunho = { ordem: 0, titulo: "", quando: "durante", etapa: null, sku: null, passos: [], observacao: null, ativo: true };

export function ManualProcessos({ aberto, onFechar }: { aberto: boolean; onFechar: () => void }) {
  const qc = useQueryClient();
  const manual = useManual();
  const { perfil } = usePerfil();
  const podeEditar = !!perfil?.modulos.includes("todos");
  const [editando, setEditando] = useState<Rascunho | null>(null);
  const [passosTxt, setPassosTxt] = useState("");
  const [salvando, setSalvando] = useState(false);
  const lista = manual.data ?? [];
  const rascunhos = lista.filter((s) => s.ativo && s.atualizado_por === "rascunho").length;

  function editar(s: Rascunho) {
    setEditando(s);
    setPassosTxt(s.passos.join("\n"));
  }

  async function salvar() {
    if (!editando) return;
    const passos = passosTxt.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!editando.titulo.trim()) return toast.error("Dê um título à seção.");
    if (!passos.length) return toast.error("Escreva pelo menos um passo (um por linha).");
    const linha = {
      ordem: editando.id ? editando.ordem : Math.max(0, ...lista.map((x) => x.ordem)) + 10,
      titulo: editando.titulo.trim(), quando: editando.quando, etapa: editando.etapa || null, sku: editando.sku?.trim() || null,
      passos, observacao: editando.observacao?.trim() || null, ativo: editando.ativo,
      atualizado_em: new Date().toISOString(), atualizado_por: perfil?.nome ?? "app",
    };
    setSalvando(true);
    const r = editando.id
      ? await supabaseExternal.from("producao_manual" as never).update(linha as never).eq("id", editando.id)
      : await supabaseExternal.from("producao_manual" as never).insert(linha as never);
    setSalvando(false);
    if (r.error) return toast.error(erroMsg(r.error));
    toast.success("Manual salvo.");
    setEditando(null);
    void qc.invalidateQueries({ queryKey: ["producao", "manual"] });
  }

  async function mover(s: ManualSecao, dir: -1 | 1) {
    const ord = [...lista].sort((a, b) => a.ordem - b.ordem || a.id - b.id);
    const i = ord.findIndex((x) => x.id === s.id);
    const outro = ord[i + dir];
    if (!outro) return;
    const a = await supabaseExternal.from("producao_manual" as never).update({ ordem: outro.ordem } as never).eq("id", s.id);
    const b = await supabaseExternal.from("producao_manual" as never).update({ ordem: s.ordem === outro.ordem ? s.ordem + dir : s.ordem } as never).eq("id", outro.id);
    if (a.error || b.error) toast.error(erroMsg(a.error ?? b.error));
    void qc.invalidateQueries({ queryKey: ["producao", "manual"] });
  }

  async function excluir(s: ManualSecao) {
    if (!window.confirm(`Excluir a seção "${s.titulo}" do manual? (Para só tirar da folha, desmarque "Ativa".)`)) return;
    const { error } = await supabaseExternal.from("producao_manual" as never).delete().eq("id", s.id);
    if (error) return toast.error(erroMsg(error));
    setEditando(null);
    void qc.invalidateQueries({ queryKey: ["producao", "manual"] });
  }

  async function imprimir() {
    const w = abrirAbaEspera();
    try { await abrirManual(w); } catch (e) { toast.error(erroMsg(e)); }
  }

  const etapaNome = (e: string | null) => ETAPAS.find((x) => x.id === e)?.nome;

  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) { setEditando(null); onFechar(); } }}>
      <DialogContent className="pm-ui max-w-3xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)", maxHeight: "90vh", overflowY: "auto" }}>
        <DialogHeader><DialogTitle>{editando ? (editando.id ? "Editar seção do manual" : "Nova seção do manual") : "Manual de processos da produção"}</DialogTitle></DialogHeader>

        {editando ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Campo rotulo="Título">
              <Entrada value={editando.titulo} onChange={(e) => setEditando({ ...editando, titulo: e.target.value })} placeholder="ex.: Limpeza da seladora" />
            </Campo>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <Campo rotulo="Quando" dica={editando.quando === "antes" ? "vira o checklist “antes de começar” da folha" : editando.quando === "depois" ? "vira o checklist do encerramento da folha" : undefined}>
                <Escolha value={editando.quando} onChange={(e) => setEditando({ ...editando, quando: e.target.value as ManualSecao["quando"] })}>
                  {QUANDO_MANUAL.map((q) => <option key={q.id} value={q.id}>{q.nome}</option>)}
                </Escolha>
              </Campo>
              <Campo rotulo="Etapa" dica={editando.etapa === "etiquetagem" ? "só sai na folha quando a embalagem leva etiqueta" : undefined}>
                <Escolha value={editando.etapa ?? ""} onChange={(e) => setEditando({ ...editando, etapa: (e.target.value || null) as ManualSecao["etapa"] })}>
                  <option value="">geral</option>
                  {ETAPAS.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </Escolha>
              </Campo>
              <Campo rotulo="Só para o produto (SKU)" dica="em branco = todos">
                <Entrada value={editando.sku ?? ""} onChange={(e) => setEditando({ ...editando, sku: e.target.value })} placeholder="todos" />
              </Campo>
            </div>
            <Campo rotulo="Passos (um por linha)">
              <textarea value={passosTxt} onChange={(e) => setPassosTxt(e.target.value)} rows={9}
                style={{ padding: "8px 10px", borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 13.5, width: "100%", lineHeight: 1.45 }} />
            </Campo>
            <Campo rotulo="Observação (opcional)">
              <Entrada value={editando.observacao ?? ""} onChange={(e) => setEditando({ ...editando, observacao: e.target.value })} />
            </Campo>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={editando.ativo} onChange={(e) => setEditando({ ...editando, ativo: e.target.checked })} />
              Ativa (sai na folha de controle e no manual impresso)
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {editando.id && <Botao tom="fantasma" style={{ color: "var(--pm-r)" }} onClick={() => excluir(editando as ManualSecao)}>Excluir</Botao>}
              <div style={{ flex: 1 }} />
              <Botao onClick={() => setEditando(null)}>Cancelar</Botao>
              <Botao tom="primario" onClick={salvar} disabled={salvando}>{salvando ? "Salvando…" : "Salvar"}</Botao>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>
                As seções “antes de começar” e “ao terminar” viram os checklists da folha de controle de cada lote.
              </span>
              <div style={{ flex: 1 }} />
              {podeEditar && <Botao onClick={() => editar({ ...NOVA })}>+ Nova seção</Botao>}
              <Botao tom="primario" onClick={imprimir}>Imprimir manual (PDF)</Botao>
            </div>
            {rascunhos > 0 && podeEditar && (
              <div style={{ fontSize: 12.5, border: "1px solid var(--pm-am)", background: "var(--pm-ams)", color: "var(--pm-am)", borderRadius: 10, padding: "8px 10px" }}>
                {rascunhos} seção(ões) ainda com o texto inicial, escrito sem conhecer a bancada: revise e salve cada uma.
              </div>
            )}
            {manual.isLoading ? <p style={{ fontSize: 13, color: "var(--pm-t3)" }}>Carregando…</p> : QUANDO_MANUAL.map((q) => {
              const secoes = lista.filter((s) => s.quando === q.id);
              if (!secoes.length) return null;
              return (
                <div key={q.id}>
                  <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--pm-t3)", marginBottom: 6 }}>{q.nome}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {secoes.map((s) => (
                      <div key={s.id} style={{ border: "1px solid var(--pm-bs)", borderRadius: 10, padding: "9px 11px", opacity: s.ativo ? 1 : 0.55 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <b style={{ fontSize: 13.5 }}>{s.titulo}</b>
                          {s.etapa && <Selo tom="azul">{etapaNome(s.etapa)}</Selo>}
                          {s.sku && <Selo>só {s.sku}</Selo>}
                          {!s.ativo && <Selo>desligada</Selo>}
                          {s.atualizado_por === "rascunho" ? <Selo tom="a">rascunho</Selo> : <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>{s.atualizado_por} · {dataBR(s.atualizado_em)}</span>}
                          <div style={{ flex: 1 }} />
                          {podeEditar && (
                            <>
                              <Botao tom="fantasma" onClick={() => mover(s, -1)} title="Subir">↑</Botao>
                              <Botao tom="fantasma" onClick={() => mover(s, 1)} title="Descer">↓</Botao>
                              <Botao onClick={() => editar(s)}>Editar</Botao>
                            </>
                          )}
                        </div>
                        <ol style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13, color: "var(--pm-t2)" }}>
                          {s.passos.map((p, i) => <li key={i} style={{ margin: "2px 0" }}>{p}</li>)}
                        </ol>
                        {s.observacao && <div style={{ fontSize: 12, color: "var(--pm-t3)", marginTop: 4 }}>{s.observacao}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
