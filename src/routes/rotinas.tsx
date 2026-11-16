import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useAuth } from "@/hooks/useAuth";
import { lerManual } from "@/lib/producao";
import {
  type Item, type Membro, type Progresso, type Secao,
  dataExtensoSP, diaSemanaSP, exigeDetalhe, hojeSP, itemCompleto,
} from "@/lib/manual";
import { montarRotinas, rotinasPdfHtml, type Etapa, type Rotina, type TagEtapa } from "@/lib/rotinas";
import "@/components/rotinas/rotinas.css";

// ============================================================================
// Rotinas da Operação (16/nov/2026) — a equipe segue cada rotina passo a passo (notebook dos fundos e celular).
// O conteúdo vem do manual (manual_secoes / manual_itens / producao_manual) pela montagem de src/lib/rotinas.ts;
// editar o manual (Equipe › Manual de Operação › modo edição) muda esta página e o PDF.
// Marcação: rotinas diárias gravam em manual_progresso (o mesmo registro do Checklist do Dia — unique dia+item,
// dia em America/Sao_Paulo); a Produção de Areia grava por produção em rotina_execucao/_marca ("Nova produção").
// ============================================================================

export const Route = createFileRoute("/rotinas")({ component: RotinasPage });

const CHAVE_EU = "manual.euId"; // o mesmo do /processos
type Execucao = { id: number; iniciada_em: string; iniciada_por: string | null };
type Marca = { execucao_id: number; chave: string; feito_em: string; por: string | null };

function RotinasPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const dia = hojeSP();
  const dow = diaSemanaSP();

  const estrutura = useQuery({
    queryKey: ["rotinas", "estrutura"],
    queryFn: async () => {
      const [m, s, i, pm] = await Promise.all([
        supabaseExternal.from("equipe_membros").select("*").eq("ativo", true).order("ordem"),
        supabaseExternal.from("manual_secoes").select("*").eq("ativo", true).order("ordem"),
        supabaseExternal.from("manual_itens").select("*").eq("ativo", true).order("ordem"),
        lerManual(),
      ]);
      if (m.error) throw m.error;
      if (s.error) throw s.error;
      if (i.error) throw i.error;
      return { membros: (m.data ?? []) as Membro[], secoes: (s.data ?? []) as Secao[], itens: (i.data ?? []) as Item[], producao: pm };
    },
  });

  const progresso = useQuery({
    queryKey: ["manual", "progresso", dia],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("manual_progresso").select("*").eq("dia", dia);
      if (error) throw error;
      return (data ?? []) as Progresso[];
    },
  });

  // produção em andamento (a última aberta) e o que já foi marcado nela
  const execucao = useQuery({
    queryKey: ["rotinas", "execucao"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("rotina_execucao" as never).select("id, iniciada_em, iniciada_por")
        .eq("secao_code", "RESP-09").is("encerrada_em", null).order("id", { ascending: false }).limit(1);
      if (error) throw error;
      const ex = ((data ?? []) as unknown as Execucao[])[0] ?? null;
      if (!ex) return { ex: null as Execucao | null, marcas: [] as Marca[] };
      const { data: mk, error: e2 } = await supabaseExternal.from("rotina_execucao_marca" as never).select("*").eq("execucao_id", ex.id);
      if (e2) throw e2;
      return { ex, marcas: (mk ?? []) as unknown as Marca[] };
    },
  });

  // tempo real: outra pessoa marcando em outro aparelho
  useEffect(() => {
    const canal = supabaseExternal.channel("rotinas-marcas")
      .on("postgres_changes", { event: "*", schema: "public", table: "manual_progresso" }, () => void qc.invalidateQueries({ queryKey: ["manual", "progresso", dia] }))
      .on("postgres_changes", { event: "*", schema: "public", table: "rotina_execucao_marca" }, () => void qc.invalidateQueries({ queryKey: ["rotinas", "execucao"] }))
      .subscribe();
    return () => { void supabaseExternal.removeChannel(canal); };
  }, [qc, dia]);

  const membros = estrutura.data?.membros ?? [];
  const rotinas = useMemo(() => (estrutura.data
    ? montarRotinas({ secoes: estrutura.data.secoes, itens: estrutura.data.itens, membros: estrutura.data.membros, producao: estrutura.data.producao, dow })
    : []), [estrutura.data, dow]);
  const prog = useMemo(() => new Map((progresso.data ?? []).map((p) => [p.item_id, p])), [progresso.data]);
  const marcas = useMemo(() => new Map((execucao.data?.marcas ?? []).map((m) => [m.chave, m])), [execucao.data]);

  // quem está marcando: e-mail do login → membro; senão a escolha guardada no aparelho (a mesma do /processos)
  const [euManual, setEuManual] = useState<string | null>(() => {
    try { return typeof window === "undefined" ? null : window.localStorage.getItem(CHAVE_EU); } catch { return null; }
  });
  const euPorEmail = useMemo(() => {
    const email = user?.email?.toLowerCase();
    return email ? membros.find((m) => m.email?.toLowerCase() === email)?.id ?? null : null;
  }, [user?.email, membros]);
  const euId = euPorEmail ?? euManual;
  const eu = membros.find((m) => m.id === euId) ?? null;
  const escolher = (id: string) => { setEuManual(id); try { window.localStorage.setItem(CHAVE_EU, id); } catch { /* sem armazenamento */ } };

  async function salvarItem(item: Item, patch: Partial<Progresso>) {
    if (!euId) return toast.error("Escolha quem é você antes de marcar.");
    const atual = prog.get(item.id);
    const linha = {
      dia, item_id: item.id,
      concluido: patch.concluido ?? atual?.concluido ?? false,
      resposta: (patch.resposta !== undefined ? patch.resposta : atual?.resposta ?? null) as "sim" | "nao" | null,
      detalhe: patch.detalhe !== undefined ? patch.detalhe : atual?.detalhe ?? null,
      por: euId, em: new Date().toISOString(),
    };
    const { error } = await supabaseExternal.from("manual_progresso").upsert(linha, { onConflict: "dia,item_id" });
    if (error) return toast.error("Não consegui salvar", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["manual", "progresso", dia] });
  }

  async function novaProducao(confirmar = true): Promise<number | null> {
    if (!euId) { toast.error("Escolha quem é você antes de marcar."); return null; }
    if (confirmar && execucao.data?.ex && !window.confirm("Começar uma produção nova? As marcações da produção atual ficam guardadas e a lista volta ao começo.")) return null;
    if (execucao.data?.ex) await supabaseExternal.from("rotina_execucao" as never).update({ encerrada_em: new Date().toISOString() } as never).eq("id", execucao.data.ex.id);
    const { data, error } = await supabaseExternal.from("rotina_execucao" as never).insert({ secao_code: "RESP-09", iniciada_por: euId } as never).select("id").single();
    if (error) { toast.error("Não consegui começar a produção", { description: error.message }); return null; }
    await qc.invalidateQueries({ queryKey: ["rotinas", "execucao"] });
    return (data as unknown as { id: number }).id;
  }

  async function marcarProducao(e: Etapa) {
    if (!euId) return toast.error("Escolha quem é você antes de marcar.");
    let exId = execucao.data?.ex?.id ?? null;
    if (!exId) exId = await novaProducao(false);
    if (!exId) return;
    const feito = marcas.has(e.chave);
    const r = feito
      ? await supabaseExternal.from("rotina_execucao_marca" as never).delete().eq("execucao_id", exId).eq("chave", e.chave)
      : await supabaseExternal.from("rotina_execucao_marca" as never).insert({ execucao_id: exId, chave: e.chave, por: euId } as never);
    if (r.error) return toast.error("Não consegui salvar", { description: r.error.message });
    void qc.invalidateQueries({ queryKey: ["rotinas", "execucao"] });
  }

  function baixarPdf() {
    const w = window.open("", "_blank");
    if (!w) return toast.error("O navegador bloqueou a nova aba. Libere pop-ups para este site e tente de novo.");
    const versao = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    w.document.open();
    w.document.write(rotinasPdfHtml(rotinas, versao));
    w.document.close();
  }

  const carregando = estrutura.isLoading || progresso.isLoading;
  const erro = (estrutura.error as Error | null)?.message ?? (progresso.error as Error | null)?.message;

  return (
    <div className="rot-ui">
      <header className="rot-topo">
        <div>
          <div className="rot-kicker">ACZ Pet · Manual de Processos</div>
          <h1 className="rot-h1">Rotinas da Operação</h1>
          <div className="rot-data">{dataExtensoSP()}</div>
        </div>
        <div className="rot-topo-acoes">
          {eu ? (
            <span className="rot-eu">Marcando como <b>{eu.nome}</b>{!euPorEmail && <button type="button" className="rot-link" onClick={() => setEuManual(null)}>trocar</button>}</span>
          ) : null}
          <button type="button" className="rot-btn" onClick={baixarPdf} disabled={!rotinas.length}>Baixar PDF</button>
        </div>
      </header>

      {!eu && membros.length > 0 && (
        <div className="rot-quem">
          <span>Quem é você? (para registrar quem marcou)</span>
          <div className="rot-quem-lista">
            {membros.filter((m) => m.id !== "equipe").map((m) => (
              <button key={m.id} type="button" className="rot-chip" onClick={() => escolher(m.id)}>{m.nome}</button>
            ))}
          </div>
        </div>
      )}

      {rotinas.length > 0 && (
        <nav className="rot-atalhos" aria-label="Rotinas">
          {rotinas.map((r) => (
            <a key={r.code} href={`#rot-${r.code}`} className="rot-chip">{r.titulo}</a>
          ))}
        </nav>
      )}

      {carregando && <p className="rot-muted">Carregando as rotinas…</p>}
      {erro && <p className="rot-erro">Não deu para ler o manual: {erro}</p>}

      {rotinas.map((r) => (
        <SecaoRotina key={r.code} r={r} prog={prog} marcas={marcas} execucao={execucao.data?.ex ?? null} membros={membros}
          onItem={salvarItem} onProducao={marcarProducao} onNovaProducao={() => void novaProducao(true)} />
      ))}
    </div>
  );
}

const corTag = (t: TagEtapa) => `rot-tag rot-tag-${t.tipo}`;

function SecaoRotina({ r, prog, marcas, execucao, membros, onItem, onProducao, onNovaProducao }: {
  r: Rotina; prog: Map<string, Progresso>; marcas: Map<string, Marca>; execucao: Execucao | null; membros: Membro[];
  onItem: (item: Item, patch: Partial<Progresso>) => void; onProducao: (e: Etapa) => void; onNovaProducao: () => void;
}) {
  const etapas = r.fases.flatMap((f) => f.etapas).filter((e) => !e.hojeNao);
  const feitaEtapa = (e: Etapa) => (r.producao ? marcas.has(e.chave) : !!e.item && itemCompleto(e.item, prog.get(e.item.id)));
  const total = etapas.length + (r.producao ? 0 : r.perguntas.length);
  const feitas = etapas.filter(feitaEtapa).length + (r.producao ? 0 : r.perguntas.filter((p) => itemCompleto(p.item, prog.get(p.item.id))).length);
  const pct = total ? Math.round((feitas / total) * 100) : 0;
  const nome = (id: string | null) => membros.find((m) => m.id === id)?.nome ?? id ?? "";
  let num = 0;

  return (
    <section id={`rot-${r.code}`} className="rot-secao">
      <div className="rot-faixa">
        <div className="rot-faixa-esq">
          <span className="rot-code">{r.code}</span>
          <h2 className="rot-h2">{r.titulo}</h2>
        </div>
        <div className="rot-faixa-dir">
          {r.frequencia && <span>{r.frequencia}</span>}
          {r.responsavel && <span>Responsável: <b>{r.responsavel}</b></span>}
        </div>
      </div>
      {r.descricao && <p className="rot-desc">{r.descricao}</p>}

      <div className="rot-grade">
        <aside className="rot-regras">
          {(r.regras.length > 0 || r.temporarias.length > 0 || r.proibidos.length > 0 || r.tabela) && <div className="rot-bt">Regras fixas</div>}
          {r.regras.map((g, k) => (
            <div key={k} className={`rot-regra${g.principal ? " rot-regra-pri" : ""}`}>
              {g.titulo && <div className="rot-regra-t">{g.titulo}</div>}
              <div className="rot-regra-x">{g.texto}</div>
            </div>
          ))}
          {r.temporarias.map((g, k) => (
            <div key={`t${k}`} className="rot-temp">
              <span className="rot-temp-et">Medida temporária</span>
              {g.titulo && <div className="rot-regra-t">{g.titulo}</div>}
              <div className="rot-regra-x">{g.texto}</div>
            </div>
          ))}
          {r.proibidos.length > 0 && (
            <div className="rot-proib">
              <div className="rot-proib-c">Não é permitido</div>
              <div className="rot-proib-i">
                {r.proibidos.map((p, k) => (
                  <div key={k} className="rot-proib-item"><b>{p.titulo}</b>{p.tag.texto && <span className={corTag(p.tag)}>{p.tag.texto}</span>}</div>
                ))}
              </div>
            </div>
          )}
          {r.tabela && (
            <table className="rot-tabela">
              <thead><tr>{r.tabela.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{r.tabela.rows.map((row, k) => <tr key={k}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          )}
        </aside>

        <div className="rot-etapas">
          <div className="rot-progresso">
            <div className="rot-progresso-txt">
              <b>{feitas} de {total}</b> {r.producao ? "etapas desta produção" : "etapas hoje"}
              {r.producao && execucao && <span className="rot-muted"> · começou {new Date(execucao.iniciada_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{execucao.iniciada_por ? ` por ${nome(execucao.iniciada_por)}` : ""}</span>}
            </div>
            {r.producao && <button type="button" className="rot-btn rot-btn-sec" onClick={onNovaProducao}>Nova produção</button>}
            <div className="rot-barra" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={feitas} aria-label={`${feitas} de ${total} etapas`}>
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>

          {r.fases.map((f) => (
            <div key={f.nome} className="rot-fase">
              <div className="rot-fase-nome">{f.nome}</div>
              <ol className="rot-linha">
                {f.etapas.map((e) => {
                  if (!e.hojeNao) num++;
                  const feita = !e.hojeNao && feitaEtapa(e);
                  const quem = r.producao ? marcas.get(e.chave)?.por : e.item ? prog.get(e.item.id)?.por : null;
                  return (
                    <li key={e.chave}>
                      <button type="button" className={`rot-etapa${feita ? " feita" : ""}${e.hojeNao ? " hoje-nao" : ""}`} aria-pressed={feita}
                        disabled={e.hojeNao}
                        onClick={() => (r.producao ? onProducao(e) : e.item && onItem(e.item, { concluido: !feita }))}>
                        <span className={`rot-marca${r.numerar ? " num" : ""}`} aria-hidden>{feita ? "✓" : r.numerar ? num : ""}</span>
                        <span className="rot-etapa-corpo">
                          <span className="rot-etapa-t">{e.titulo}</span>
                          {e.detalhe && <span className="rot-etapa-d">{e.detalhe}{e.hojeNao ? " — não é hoje" : ""}</span>}
                          {feita && quem && <span className="rot-etapa-quem">feito por {nome(quem)}</span>}
                        </span>
                        {e.tag.texto && <span className={corTag(e.tag)}>{e.tag.texto}</span>}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}

          {r.perguntas.length > 0 && (
            <div className="rot-fase">
              <div className="rot-fase-nome">Encerramento</div>
              {r.perguntas.map((p) => <PerguntaRot key={p.item.id} p={p} prog={prog.get(p.item.id)} onItem={onItem} />)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PerguntaRot({ p, prog, onItem }: { p: Rotina["perguntas"][number]; prog?: Progresso; onItem: (item: Item, patch: Partial<Progresso>) => void }) {
  const [detalhe, setDetalhe] = useState(prog?.detalhe ?? "");
  useEffect(() => { setDetalhe(prog?.detalhe ?? ""); }, [prog?.detalhe]);
  const resp = prog?.resposta ?? null;
  const abre = exigeDetalhe(p.item, resp);
  const completa = itemCompleto(p.item, prog);
  return (
    <div className={`rot-perg${completa ? " feita" : resp ? " pendente" : ""}`}>
      <div className="rot-perg-t">
        <span>{p.texto}</span>
        {p.tag.texto && <span className={corTag(p.tag)}>{p.tag.texto}</span>}
      </div>
      <div className="rot-perg-op" role="group" aria-label={p.texto}>
        {(["sim", "nao"] as const).map((v) => (
          <button key={v} type="button" className={`rot-sn${resp === v ? " ativo" : ""}`} aria-pressed={resp === v}
            onClick={() => onItem(p.item, { resposta: v })}>{v === "sim" ? "Sim" : "Não"}</button>
        ))}
      </div>
      {abre && (
        <label className="rot-perg-det">
          <span>{p.campo ?? "Descreva"}</span>
          <textarea value={detalhe} rows={2} onChange={(e) => setDetalhe(e.target.value)}
            onBlur={() => { if ((detalhe ?? "") !== (prog?.detalhe ?? "")) onItem(p.item, { detalhe: detalhe.trim() || null }); }} />
        </label>
      )}
      {!abre && p.abre && p.abre !== "nunca" && !resp && <div className="rot-perg-dica">Se {p.abre === "sim" ? "SIM" : "NÃO"}: {p.campo ?? "descreva"}</div>}
    </div>
  );
}
