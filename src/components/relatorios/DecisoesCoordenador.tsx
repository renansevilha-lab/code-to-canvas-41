import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import {
  arr, brlMil, Chevron, ddmm, diaSP, Foto, hojeSP, horaSP, nomeDoAgente, obj, Pill, somaDias, str, useFotos,
} from "./comum";

// ============================================================================
// Decisões do dia — painel do agente COORDENADOR (23/nov/2026).
// O banco (coordenador_gerar, 08h45) junta o que os relatórios do dia pedem,
// cruza (ADS × estoque, compra × caixa) e guarda o estado de cada decisão.
// Aqui: aprovar (vira tarefa com responsável e prazo), recusar (some por 14
// dias) e concluir. Nada é executado em marketplace nem no Tiny.
// Só administrador (a RPC coordenador_painel recusa os demais).
// ============================================================================

interface Decisao {
  id: number;
  agente: string;
  tom: "red" | "amber" | "gray";
  o_que: string;
  detalhe: string | null;
  nota: string | null;
  sku: string | null;
  valor: number | null;
  dono: string | null;
  primeira_vez: string | null;
  dias_vista: number | null;
  reaberta_em?: string | null;
}
interface Andamento extends Decisao {
  responsavel: string | null;
  responsavel_nome: string | null;
  prazo_tarefa: string | null;
  tarefa_id: string | null;
  sumiu_em: string | null;
  atrasada: boolean | null;
}
interface Recente {
  id: number;
  agente: string;
  o_que: string;
  status: "feita" | "recusada";
  motivo: string | null;
  silenciar_ate: string | null;
  concluida_por: string | null;
  obs_conclusao: string | null;
  atualizado_em: string | null;
}
interface Painel {
  dia: string;
  gerado_em: string | null;
  destaque: string | null;
  topo: Decisao[];
  outras: Decisao[];
  andamento: Andamento[];
  recentes: Recente[];
  equipe: { id: string; nome: string }[];
}

const NOME_AGENTE: Record<string, string> = { tendencias: "Tendências", coordenador: "Coordenação", rh: "Equipe" };
const deQuem = (a: string) => NOME_AGENTE[a] ?? nomeDoAgente(a);
const corDoTom = (t: string) => (t === "red" ? "var(--rl-red)" : t === "amber" ? "var(--rl-amber)" : "var(--rl-text-3)");
const BTN = "text-[13px] font-medium px-3 py-[6px] rounded-[7px] border cursor-pointer disabled:opacity-50 disabled:cursor-default";
const CAMPO = "text-[13px] px-2.5 py-[6px] rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) text-(--rl-text) min-w-0";

export function DecisoesCoordenador({ mobile }: { mobile: boolean }) {
  const { temAcesso } = usePerfil();
  const admin = temAcesso("todos");
  const qc = useQueryClient();
  const [form, setForm] = useState<{ id: number; tipo: "aprovar" | "recusar" | "concluir" } | null>(null);
  const [resp, setResp] = useState("");
  const [prazo, setPrazo] = useState("");
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [verOutras, setVerOutras] = useState(false);
  const [verRecentes, setVerRecentes] = useState(false);

  const q = useQuery({
    queryKey: ["relatorios", "coordenador"],
    enabled: admin,
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<Painel> => {
      const { data, error } = await supabaseExternal.rpc("coordenador_painel");
      if (error) throw error;
      const p = obj(data);
      return {
        dia: str(p.dia), gerado_em: p.gerado_em ? str(p.gerado_em) : null, destaque: p.destaque ? str(p.destaque) : null,
        topo: arr<Decisao>(p.topo), outras: arr<Decisao>(p.outras), andamento: arr<Andamento>(p.andamento),
        recentes: arr<Recente>(p.recentes), equipe: arr<{ id: string; nome: string }>(p.equipe),
      };
    },
  });
  const d = q.data;
  const fotos = useFotos(useMemo(
    () => [...(d?.topo ?? []), ...(d?.outras ?? []), ...(d?.andamento ?? [])].map((x) => x.sku),
    [d],
  ));

  if (!admin) return null;
  if (q.isLoading) {
    return <div className="rounded-[10px] border border-(--rl-border) bg-(--rl-surface) h-[120px] animate-pulse" aria-busy />;
  }
  if (q.error || !d) {
    return (
      <div className="rounded-[10px] border border-(--rl-border) bg-(--rl-surface) p-4 text-[13.5px] text-(--rl-text-2) flex items-center gap-3 flex-wrap">
        Não consegui ler as decisões do dia.
        <button type="button" className={`${BTN} border-(--rl-border-strong)`} onClick={() => void q.refetch()}>Tentar de novo</button>
      </div>
    );
  }

  const hoje = hojeSP();
  const abrir = (id: number, tipo: "aprovar" | "recusar" | "concluir", dono?: string | null) => {
    setErro(null); setTexto("");
    setResp(dono && d.equipe.some((e) => e.id === dono) ? dono : d.equipe[0]?.id ?? "");
    setPrazo(somaDias(hoje, 2));
    setForm((f) => (f && f.id === id && f.tipo === tipo ? null : { id, tipo }));
  };
  const chamar = async (fn: string, args: Record<string, unknown>) => {
    setOcupado(true); setErro(null);
    const { error } = await supabaseExternal.rpc(fn, args);
    setOcupado(false);
    if (error) { setErro(error.message); return; }
    setForm(null);
    await qc.invalidateQueries({ queryKey: ["relatorios", "coordenador"] });
  };
  const confirmar = () => {
    if (!form) return;
    if (form.tipo === "aprovar") void chamar("decisao_aprovar", { p_id: form.id, p_responsavel: resp, p_prazo: prazo, p_obs: texto || null });
    else if (form.tipo === "recusar") void chamar("decisao_recusar", { p_id: form.id, p_motivo: texto || null });
    else void chamar("decisao_concluir", { p_id: form.id, p_obs: texto || null });
  };

  const formulario = (id: number) => {
    if (!form || form.id !== id) return null;
    const respNome = d.equipe.find((e) => e.id === resp)?.nome ?? "";
    return (
      <div className="mt-2.5 p-3 rounded-lg bg-(--rl-surface-2) border border-(--rl-border) flex flex-col gap-2.5">
        {form.tipo === "aprovar" && (
          <div className="flex gap-2.5 flex-wrap items-end">
            <label className="flex flex-col gap-1 text-[12px] text-(--rl-text-3)">
              Responsável
              <select className={CAMPO} value={resp} onChange={(e) => setResp(e.target.value)}>
                {d.equipe.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-(--rl-text-3)">
              Prazo
              <input type="date" className={CAMPO} value={prazo} min={hoje} onChange={(e) => setPrazo(e.target.value)} />
            </label>
          </div>
        )}
        <input className={`${CAMPO} w-full`} value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder={form.tipo === "aprovar" ? "Observação para quem vai fazer (opcional)"
            : form.tipo === "recusar" ? "Por que não? (opcional — ajuda a não sugerir de novo)" : "O que foi feito (opcional)"} />
        <div className="text-[12.5px] text-(--rl-text-3)">
          {form.tipo === "aprovar"
            ? resp === "renan"
              ? "Fica na sua lista de andamento, aqui embaixo. Nenhum aviso é enviado."
              : `Cria uma tarefa para ${respNome} no quadro de Tarefas e avisa no Discord.`
            : form.tipo === "recusar"
              ? "Some da lista e não volta por 14 dias, mesmo que os relatórios apontem de novo."
              : "Fecha a decisão. Se o problema continuar nos relatórios, ela volta em 2 dias."}
        </div>
        {erro && <div className="text-[12.5px] text-(--rl-red)">{erro}</div>}
        <div className="flex gap-2">
          <button type="button" disabled={ocupado || (form.tipo === "aprovar" && (!resp || !prazo))} onClick={confirmar}
            className={`${BTN} border-(--rl-accent) bg-(--rl-accent) text-(--rl-on-accent)`}>
            {ocupado ? "Gravando…" : form.tipo === "aprovar" ? "Confirmar aprovação" : form.tipo === "recusar" ? "Confirmar recusa" : "Marcar como feita"}
          </button>
          <button type="button" disabled={ocupado} onClick={() => setForm(null)} className={`${BTN} border-(--rl-border-strong) text-(--rl-text-2)`}>Cancelar</button>
        </div>
      </div>
    );
  };

  const linha = (x: Decisao, n?: number) => (
    <div key={x.id} className="py-3 border-t border-(--rl-border) first:border-t-0 min-w-0">
      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 items-start">
        <div className="relative w-11 h-11">
          <Foto src={x.sku ? fotos.get(x.sku) : null} size={44} rotulo={x.sku ? undefined : deQuem(x.agente)} />
          <i className="absolute -top-[3px] -right-[3px] w-2.5 h-2.5 rounded-full border-2 border-(--rl-surface)" style={{ background: corDoTom(x.tom) }} />
        </div>
        <div className="min-w-0 flex flex-col gap-1.5">
          <div className="flex gap-2 items-baseline flex-wrap">
            {n != null && <span className="text-[12px] font-semibold text-(--rl-text-3)">{n}.</span>}
            <span className="text-[14px] font-semibold [text-wrap:pretty]">{x.o_que}</span>
            {x.valor != null && Number(x.valor) > 0 && (
              <span className="text-[12.5px] font-medium" style={{ color: corDoTom(x.tom) }}>{brlMil(x.valor)} em jogo</span>
            )}
          </div>
          {x.detalhe && <div className="text-[13px] leading-[1.45] text-(--rl-text-2) [text-wrap:pretty]">{x.detalhe}</div>}
          {x.nota && (
            <div className="text-[13px] leading-[1.45] px-2.5 py-1.5 rounded-md bg-(--rl-accent-soft) text-(--rl-accent-text)">
              <span className="font-semibold">Cruzando com os outros agentes:</span> {x.nota}
            </div>
          )}
          <div className="flex gap-2 items-center flex-wrap">
            <Pill cor="gray">{deQuem(x.agente)}</Pill>
            {(x.dias_vista ?? 1) > 1 && <Pill cor="amber" title={`Aparece desde ${ddmm(x.primeira_vez)}`}>{x.dias_vista}º dia</Pill>}
            {x.reaberta_em && <Pill cor="amber">voltou</Pill>}
            <span className="flex-1" />
            <button type="button" onClick={() => abrir(x.id, "aprovar", x.dono)} className={`${BTN} border-(--rl-accent) text-(--rl-accent-text) hover:bg-(--rl-accent-soft)`}>Aprovar</button>
            <button type="button" onClick={() => abrir(x.id, "recusar")} className={`${BTN} border-(--rl-border-strong) text-(--rl-text-2) hover:border-(--rl-accent)`}>Agora não</button>
          </div>
          {formulario(x.id)}
        </div>
      </div>
    </div>
  );

  return (
    <div className="rounded-[10px] border border-(--rl-border) bg-(--rl-surface) min-w-0 overflow-hidden">
      <div className={`${mobile ? "px-3.5" : "px-5"} py-4 flex flex-col gap-1 border-b border-(--rl-border)`}>
        <div className="flex justify-between items-baseline gap-3 flex-wrap">
          <div className="text-[16px] font-semibold">Decisões do dia</div>
          <div className="text-[12.5px] text-(--rl-text-3)">
            {d.gerado_em ? `montado ${diaSP(d.gerado_em) === hoje ? "hoje" : "em " + ddmm(diaSP(d.gerado_em))} às ${horaSP(d.gerado_em)}` : "ainda não montado"}
          </div>
        </div>
        <div className="text-[13.5px] text-(--rl-text-2) [text-wrap:pretty]">
          O que os relatórios de hoje pedem, por ordem de urgência e de dinheiro em jogo. Aprovar vira tarefa com responsável e prazo; nada é executado sozinho.
        </div>
      </div>

      <div className={mobile ? "px-3.5" : "px-5"}>
        {d.topo.length === 0 ? (
          <div className="py-5 text-[13.5px] text-(--rl-text-3)">Nada pedindo decisão agora.</div>
        ) : d.topo.map((x, i) => linha(x, i + 1))}
      </div>

      {d.outras.length > 0 && (
        <div className={`${mobile ? "px-3.5" : "px-5"} border-t border-(--rl-border)`}>
          <button type="button" onClick={() => setVerOutras((v) => !v)} aria-expanded={verOutras}
            className="w-full flex items-center justify-between gap-2 py-3 text-[13.5px] font-medium text-(--rl-text-2) cursor-pointer">
            Outras em aberto ({d.outras.length})
            <Chevron aberto={verOutras} size={16} />
          </button>
          {verOutras && d.outras.map((x) => linha(x))}
        </div>
      )}

      {d.andamento.length > 0 && (
        <div className={`${mobile ? "px-3.5" : "px-5"} py-4 border-t border-(--rl-border) bg-(--rl-surface-2)`}>
          <div className="text-[13.5px] font-semibold mb-1">Aprovadas, em andamento ({d.andamento.length})</div>
          {d.andamento.map((x) => (
            <div key={x.id} className="py-2.5 border-t border-(--rl-border) first:border-t-0 min-w-0">
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-[13.5px] font-medium min-w-0 [text-wrap:pretty]">{x.o_que}</span>
                <Pill cor={x.atrasada ? "red" : "gray"}>{x.responsavel_nome ?? x.responsavel ?? "—"} · até {ddmm(x.prazo_tarefa)}{x.atrasada ? " · atrasada" : ""}</Pill>
                {x.sumiu_em && <Pill cor="green" title="Os relatórios pararam de apontar este problema">não aparece mais desde {ddmm(x.sumiu_em)}</Pill>}
                <span className="flex-1" />
                <button type="button" onClick={() => abrir(x.id, "concluir")} className={`${BTN} border-(--rl-border-strong) text-(--rl-text) hover:border-(--rl-accent)`}>Feita</button>
                <button type="button" disabled={ocupado} onClick={() => void chamar("decisao_reabrir", { p_id: x.id })}
                  className="text-[12.5px] text-(--rl-text-3) hover:underline cursor-pointer">voltar para a lista</button>
              </div>
              {formulario(x.id)}
            </div>
          ))}
        </div>
      )}

      {d.recentes.length > 0 && (
        <div className={`${mobile ? "px-3.5" : "px-5"} border-t border-(--rl-border)`}>
          <button type="button" onClick={() => setVerRecentes((v) => !v)} aria-expanded={verRecentes}
            className="w-full flex items-center justify-between gap-2 py-3 text-[13.5px] font-medium text-(--rl-text-2) cursor-pointer">
            Decididas nos últimos 10 dias ({d.recentes.length})
            <Chevron aberto={verRecentes} size={16} />
          </button>
          {verRecentes && d.recentes.map((x) => (
            <div key={x.id} className="py-2 border-t border-(--rl-border) flex gap-2 items-center flex-wrap text-[13px]">
              <Pill cor={x.status === "feita" ? "green" : "gray"}>{x.status === "feita" ? "feita" : `recusada · volta em ${ddmm(x.silenciar_ate)}`}</Pill>
              <span className="min-w-0">{x.o_que}</span>
              {(x.obs_conclusao || x.motivo) && <span className="text-(--rl-text-3)">— {x.obs_conclusao || x.motivo}</span>}
              <span className="flex-1" />
              <button type="button" disabled={ocupado} onClick={() => void chamar("decisao_reabrir", { p_id: x.id })}
                className="text-[12.5px] text-(--rl-text-3) hover:underline cursor-pointer">reabrir</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
