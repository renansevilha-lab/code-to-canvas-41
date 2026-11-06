// Ordens de produção (04/nov/2026, pedido do dono): o que deve ser produzido, com quantidade, prazo, prioridade e
// observações; cada ordem avisa a equipe no Discord. "Produzir" abre o Iniciar produção já com o produto e a ordem,
// e os lotes ficam ligados a ela (o produzido vem da view_producao_op).
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { Botao, Campo, Cartao, Entrada, Escolha, Selo, tabela, td, th } from "./ui";
import {
  embalagensDaFicha, useInsumos, avisarProducao, erroMsg, int, useEquipeDiscord, useOrdensProducao, useParametros, type OrdemProducao,
} from "@/lib/producao";

const dia = (d: string | null) => (d ? d.slice(0, 10).split("-").reverse().slice(0, 2).join("/") : "—");
const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const SITUACAO: Record<OrdemProducao["situacao"], { nome: string; tom: "r" | "a" | "g" | "n" | "azul" }> = {
  aberta: { nome: "a produzir", tom: "n" },
  em_producao: { nome: "em produção", tom: "azul" },
  atingida: { nome: "quantidade atingida", tom: "g" },
  concluida: { nome: "concluída", tom: "g" },
  cancelada: { nome: "cancelada", tom: "r" },
};

export function OrdensProducao({ fotos, onProduzir, onIrLote, novaPara, onNovaFechada }: {
  fotos: Record<string, string>;
  onProduzir: (op: OrdemProducao) => void;
  onIrLote: (id: number) => void;
  /** SKU vindo do "O que produzir" para abrir a nova ordem já com o produto */
  novaPara: string | null;
  onNovaFechada: () => void;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [comFechadas, setComFechadas] = useState(false);
  const ops = useOrdensProducao(comFechadas);
  const [nova, setNova] = useState<string | null>(null);
  useEffect(() => { if (novaPara != null) setNova(novaPara); }, [novaPara]);

  async function fechar(op: OrdemProducao, status: "concluida" | "cancelada") {
    let motivo: string | null = null;
    if (status === "cancelada") {
      motivo = window.prompt(`Cancelar a ordem #${op.id} (${op.sku}, ${int(op.qtd)} sacos)? Motivo:`);
      if (motivo == null) return;
    } else if (!window.confirm(`Concluir a ordem #${op.id}? Produzido ${int(op.produzido)} de ${int(op.qtd)}.`)) return;
    const { error } = await supabaseExternal.from("producao_op" as never).update({
      status, fechada_em: new Date().toISOString(), fechada_por: perfil?.nome ?? null, motivo: motivo?.trim() || null,
    } as never).eq("id", op.id);
    if (error) return toast.error(erroMsg(error));
    toast.success(status === "concluida" ? "Ordem concluída." : "Ordem cancelada.");
    void avisarProducao({
      titulo: `Ordem de produção #${op.id} ${status === "concluida" ? "concluída" : "cancelada"}`,
      descricao: `**${op.sku}** · ${op.produto ?? ""}`,
      nivel: status === "concluida" ? "ok" : "aviso",
      campos: [
        { nome: "Produzido", valor: `${int(op.produzido)} de ${int(op.qtd)} sacos`, inline: true },
        { nome: "Por", valor: perfil?.nome ?? "—", inline: true },
        ...(motivo?.trim() ? [{ nome: "Motivo", valor: motivo.trim() }] : []),
      ],
    });
    void qc.invalidateQueries({ queryKey: ["producao"] });
  }

  const lista = ops.data ?? [];
  return (
    <Cartao
      titulo="Ordens de produção"
      direita={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12.5, display: "flex", gap: 5, alignItems: "center", color: "var(--pm-t2)" }}>
            <input type="checkbox" checked={comFechadas} onChange={(e) => setComFechadas(e.target.checked)} /> mostrar concluídas e canceladas
          </label>
          <Botao tom="primario" onClick={() => setNova("")}>Nova ordem</Botao>
        </div>
      }
    >
      {ops.isLoading ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--pm-t3)" }}>Carregando…</p>
      ) : ops.error ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--pm-r)" }}>Não deu para ler as ordens ({(ops.error as Error).message}).</p>
      ) : !lista.length ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--pm-t3)" }}>Nenhuma ordem {comFechadas ? "" : "aberta"}. Use “Nova ordem” para dizer o que deve ser produzido.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <th style={th}>Ordem</th><th style={th}>Produto</th><th style={{ ...th, textAlign: "right" }}>Pedido</th>
              <th style={{ ...th, minWidth: 150 }}>Produzido</th><th style={th}>Prazo</th><th style={th}>Observações</th><th style={th} />
            </tr></thead>
            <tbody>
              {lista.map((op) => {
                const pct = Math.min(100, (op.produzido / op.qtd) * 100);
                const s = SITUACAO[op.situacao];
                const fechada = op.status !== "aberta";
                return (
                  <tr key={op.id} style={{ opacity: fechada ? 0.65 : 1 }}>
                    <td style={td}>
                      <div style={{ fontWeight: 700 }}>#{op.id}</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 3 }}>
                        <Selo tom={s.tom}>{s.nome}</Selo>
                        {op.prioridade === "urgente" && !fechada && <Selo tom="r">urgente</Selo>}
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {fotos[op.sku] ? <img src={fotos[op.sku]} alt="" width={34} height={34} style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 7, border: "1px solid var(--pm-bs)", background: "#fff" }} />
                          : <div style={{ width: 34, height: 34, borderRadius: 7, background: "var(--pm-s2)" }} />}
                        <div>
                          <div style={{ fontWeight: 700 }}>{op.sku}</div>
                          <div style={{ fontSize: 12, color: "var(--pm-t2)", maxWidth: 320 }}>{op.produto}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{int(op.qtd)}</td>
                    <td style={td}>
                      <div style={{ height: 8, borderRadius: 6, background: "var(--pm-s2)", overflow: "hidden", border: "1px solid var(--pm-bs)" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--pm-g)" : "var(--pm-a)" }} />
                      </div>
                      <div style={{ fontSize: 12, marginTop: 3 }}>
                        {int(op.produzido)} feitos{op.falta > 0 ? ` · faltam ${int(op.falta)}` : ""}
                        {op.envasando > 0 && <span style={{ color: "var(--pm-t3)" }}> · {int(op.envasando)} no lote aberto</span>}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: op.atrasada ? "var(--pm-r)" : undefined, fontWeight: op.atrasada ? 650 : undefined }}>
                      {dia(op.prazo)}{op.atrasada ? " · atrasada" : ""}
                    </td>
                    <td style={{ ...td, maxWidth: 300 }}>
                      {op.embalagem && <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 2 }}>Embalagem: {op.embalagem}</div>}
                      {op.obs && <div style={{ fontSize: 12.5, whiteSpace: "pre-wrap" }}>{op.obs}</div>}
                      <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
                        por {op.criado_por ?? "—"} em {quando(op.criado_em)}
                        {fechada && ` · ${op.status === "concluida" ? "concluída" : "cancelada"} por ${op.fechada_por ?? "—"} em ${quando(op.fechada_em)}`}
                        {op.motivo ? ` · ${op.motivo}` : ""}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", textAlign: "right" }}>
                      {!fechada && (
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          {op.lote_aberto_id
                            ? <Botao onClick={() => onIrLote(op.lote_aberto_id!)}>Ver lote</Botao>
                            : op.falta > 0 && <Botao tom="primario" onClick={() => onProduzir(op)}>Produzir</Botao>}
                          <Botao tom={op.situacao === "atingida" ? "ok" : "secundario"} onClick={() => fechar(op, "concluida")}>Concluir</Botao>
                          <Botao tom="fantasma" onClick={() => fechar(op, "cancelada")}>Cancelar</Botao>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <NovaOrdem sku={nova} onFechar={() => { setNova(null); onNovaFechada(); }} />
    </Cartao>
  );
}

function NovaOrdem({ sku: skuInicial, onFechar }: { sku: string | null; onFechar: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const params = useParametros();
  const equipe = useEquipeDiscord();
  const [sku, setSku] = useState("");
  const [qtd, setQtd] = useState("");
  const [prazo, setPrazo] = useState("");
  const [prioridade, setPrioridade] = useState<"normal" | "urgente">("normal");
  const [obs, setObs] = useState("");
  const [emb, setEmb] = useState("");
  const insumos = useInsumos();
  const daFicha = embalagensDaFicha(params.data?.find((p) => p.sku === sku) ?? null, insumos.data);
  useEffect(() => { setEmb(""); }, [sku]);
  const embEscolhida = daFicha.find((e) => String(e.id) === emb) ?? null;
  const [marcar, setMarcar] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("producao.op.marcar") || "[]"); } catch { return []; }
  });
  const [salvando, setSalvando] = useState(false);
  useEffect(() => {
    if (skuInicial == null) return;
    setSku(skuInicial); setQtd(""); setPrazo(""); setPrioridade("normal"); setObs("");
  }, [skuInicial]);

  const comDiscord = (equipe.data ?? []).filter((p) => p.discord_user_id);
  const semDiscord = (equipe.data ?? []).filter((p) => !p.discord_user_id && p.id !== "equipe");

  async function criar() {
    const n = Number(qtd);
    if (!sku) return toast.error("Escolha o produto.");
    if (!Number.isInteger(n) || n <= 0) return toast.error("Informe quantos sacos produzir.");
    setSalvando(true);
    const { data, error } = await supabaseExternal.from("producao_op" as never).insert({
      sku, qtd: n, prazo: prazo || null, prioridade, obs: obs.trim() || null, criado_por: perfil?.nome ?? null,
      embalagem_id: embEscolhida ? embEscolhida.id : null,
    } as never).select("id").single();
    if (error) { setSalvando(false); return toast.error(erroMsg(error)); }
    const id = (data as unknown as { id: number }).id;
    try { localStorage.setItem("producao.op.marcar", JSON.stringify(marcar)); } catch { /* sem armazenamento local */ }
    const nome = (await supabaseExternal.from("produtos").select("nome").eq("sku", sku).maybeSingle()).data?.nome ?? "";
    const ids = comDiscord.filter((p) => marcar.includes(p.id)).map((p) => p.discord_user_id!);
    const foi = await avisarProducao({
      titulo: `${prioridade === "urgente" ? "URGENTE · " : ""}Nova ordem de produção #${id}`,
      descricao: `**${sku}** · ${nome}`,
      nivel: prioridade === "urgente" ? "aviso" : "info",
      campos: [
        { nome: "Quantidade", valor: `${int(n)} sacos`, inline: true },
        { nome: "Prazo", valor: prazo ? prazo.split("-").reverse().join("/") : "sem prazo", inline: true },
        { nome: "Pedida por", valor: perfil?.nome ?? "—", inline: true },
        ...(embEscolhida ? [{ nome: "Embalagem", valor: embEscolhida.nome, inline: true }] : []),
        ...(obs.trim() ? [{ nome: "Observações", valor: obs.trim() }] : []),
      ],
      marcar: ids,
    });
    setSalvando(false);
    toast.success(foi ? `Ordem #${id} criada e avisada no Discord.` : `Ordem #${id} criada (o aviso no Discord não foi).`);
    void qc.invalidateQueries({ queryKey: ["producao"] });
    onFechar();
  }

  return (
    <Dialog open={skuInicial != null} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-lg" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Nova ordem de produção</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Campo rotulo="Produto">
            <Escolha value={sku} onChange={(e) => setSku(e.target.value)}>
              <option value="">Escolha…</option>
              {(params.data ?? []).map((p) => <option key={p.sku} value={p.sku}>{p.sku} · {p.prefixo_lote}</option>)}
            </Escolha>
          </Campo>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Campo rotulo="Quantidade (sacos)"><Entrada inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value.replace(/\D/g, "").slice(0, 6))} /></Campo>
            <Campo rotulo="Prazo"><Entrada type="date" value={prazo} onChange={(e) => setPrazo(e.target.value)} /></Campo>
            <Campo rotulo="Prioridade">
              <Escolha value={prioridade} onChange={(e) => setPrioridade(e.target.value as "normal" | "urgente")}>
                <option value="normal">normal</option>
                <option value="urgente">urgente</option>
              </Escolha>
            </Campo>
          </div>
          {daFicha.length > 1 && (
            <Campo rotulo="Embalagem" dica="este produto sai em mais de uma embalagem (ex.: transparente para alguns marketplaces)">
              <Escolha value={emb} onChange={(e) => setEmb(e.target.value)}>
                <option value="">a padrão ({daFicha.find((e) => e.padrao)?.nome ?? daFicha[0].nome})</option>
                {daFicha.filter((e) => !e.padrao).map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </Escolha>
            </Campo>
          )}
          <Campo rotulo="Observações">
            <textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={3} placeholder="ex.: usar o big bag 02; fechar em fardos de 2"
              style={{ padding: 10, borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 13.5, resize: "vertical" }} />
          </Campo>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)", marginBottom: 4 }}>Marcar no Discord</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {comDiscord.map((p) => (
                <label key={p.id} style={{ fontSize: 13, display: "flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" checked={marcar.includes(p.id)}
                    onChange={(e) => setMarcar((m) => (e.target.checked ? [...m, p.id] : m.filter((x) => x !== p.id)))} /> {p.nome}
                </label>
              ))}
              {!comDiscord.length && <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>ninguém com o Discord cadastrado</span>}
            </div>
            {semDiscord.length > 0 && (
              <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 3 }}>
                Sem o ID do Discord cadastrado (não dá para marcar): {semDiscord.map((p) => p.nome).join(", ")}.
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Botao onClick={onFechar} disabled={salvando}>Cancelar</Botao>
            <Botao tom="primario" onClick={criar} disabled={salvando}>{salvando ? "Criando…" : "Criar e avisar no Discord"}</Botao>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
