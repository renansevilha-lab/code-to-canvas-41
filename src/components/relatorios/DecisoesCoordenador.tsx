import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { AnaliseAnuncioAds } from "@/components/ads/AnaliseAnuncioAds";
import { EditorPrecoPromo } from "@/components/pedidos/EditorPrecoPromo";
import {
  arr, brlMil, Chevron, ddmm, dec1, diaSP, Foto, hojeSP, horaSP, nomeDoAgente, obj, Pill, somaDias, str, useFotos,
} from "./comum";

// ============================================================================
// Decisões do dia — painel do agente COORDENADOR (23/nov/2026).
// O banco (coordenador_gerar, 08h45) junta o que os relatórios do dia pedem,
// cruza (ADS × estoque, compra × caixa) e guarda o estado de cada decisão.
// Cada decisão traz caminhos (A, B, C…) e botões que abrem o lugar certo do
// sistema (análise do ADS, preço e promoção, compras, contas a pagar).
// Aprovar vira tarefa; "agora não" some por 14 dias; "é de propósito" vira
// ESTRATÉGIA: o coordenador para de cobrar e passa a acompanhar.
// Nada é executado sozinho. Só administrador (a RPC recusa os demais).
// ============================================================================

interface Opcao { letra: string; titulo: string; texto?: string; abrir?: string; acao?: string }
interface Ref {
  tipo?: string; mkt?: string; campanha?: string | null; anuncio?: string | null; shop?: string | null;
  sku?: string | null; empresa?: string | null; nome?: string | null; loja?: string | null; filtro?: string; ordem?: string | null;
}
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
  opcoes?: Opcao[] | null;
  ref?: Ref | null;
}
interface Andamento extends Decisao {
  responsavel: string | null;
  responsavel_nome: string | null;
  prazo_tarefa: string | null;
  tarefa_id: string | null;
  sumiu_em: string | null;
  atrasada: boolean | null;
  opcao_escolhida: string | null;
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
interface Estrategia {
  id: number;
  mkt: string | null;
  sku: string | null;
  nome: string;
  objetivo: string;
  roas_piso: number | null;
  meta_posicao: number | null;
  revisar_em: string | null;
  criado_em: string | null;
  criado_por: string | null;
  hoje: string | null;
  ref: Ref | null;
}
interface Painel {
  dia: string;
  gerado_em: string | null;
  destaque: string | null;
  topo: Decisao[];
  outras: Decisao[];
  andamento: Andamento[];
  recentes: Recente[];
  estrategias: Estrategia[];
  equipe: { id: string; nome: string }[];
}
type TipoForm = "aprovar" | "recusar" | "concluir" | "estrategia" | "editar_est" | "encerrar_est";

const NOME_AGENTE: Record<string, string> = { tendencias: "Tendências", coordenador: "Coordenação", rh: "Equipe" };
const deQuem = (a: string) => NOME_AGENTE[a] ?? nomeDoAgente(a);
const corDoTom = (t: string) => (t === "red" ? "var(--rl-red)" : t === "amber" ? "var(--rl-amber)" : "var(--rl-text-3)");
const BTN = "text-[13px] font-medium px-3 py-[6px] rounded-[7px] border cursor-pointer disabled:opacity-50 disabled:cursor-default";
const BTN_SEC = `${BTN} border-(--rl-border-strong) text-(--rl-text) hover:border-(--rl-accent) bg-(--rl-surface)`;
const CAMPO = "text-[13px] px-2.5 py-[6px] rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) text-(--rl-text) min-w-0";
const ROTULO = "flex flex-col gap-1 text-[12px] text-(--rl-text-3)";
const ehAds = (r?: Ref | null) => r?.tipo === "ads" || r?.tipo === "ads_anuncio";
const numOuNulo = (s: string) => { const v = Number(s.replace(",", ".")); return s.trim() && Number.isFinite(v) ? v : null; };

export function DecisoesCoordenador({ mobile }: { mobile: boolean }) {
  const { temAcesso } = usePerfil();
  const admin = temAcesso("todos");
  const qc = useQueryClient();
  const [form, setForm] = useState<{ id: number; tipo: TipoForm } | null>(null);
  const [resp, setResp] = useState("");
  const [prazo, setPrazo] = useState("");
  const [texto, setTexto] = useState("");
  const [opcao, setOpcao] = useState("");
  const [piso, setPiso] = useState("");
  const [metaPos, setMetaPos] = useState("");
  const [revisar, setRevisar] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [verOutras, setVerOutras] = useState(false);
  const [verRecentes, setVerRecentes] = useState(false);
  const [adsAberto, setAdsAberto] = useState<Ref | null>(null);

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
        recentes: arr<Recente>(p.recentes), estrategias: arr<Estrategia>(p.estrategias), equipe: arr<{ id: string; nome: string }>(p.equipe),
      };
    },
  });
  const d = q.data;
  const fotos = useFotos(useMemo(
    () => [...(d?.topo ?? []), ...(d?.outras ?? []), ...(d?.andamento ?? []), ...(d?.estrategias ?? [])].map((x) => x.sku),
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
        <button type="button" className={BTN_SEC} onClick={() => void q.refetch()}>Tentar de novo</button>
      </div>
    );
  }

  const hoje = hojeSP();
  const abrir = (id: number, tipo: TipoForm, ini?: { dono?: string | null; est?: Estrategia }) => {
    setErro(null); setOpcao("");
    setResp(ini?.dono && d.equipe.some((e) => e.id === ini.dono) ? ini.dono : d.equipe[0]?.id ?? "");
    setPrazo(somaDias(hoje, 2));
    setTexto(tipo === "editar_est" ? ini?.est?.objetivo ?? "" : "");
    setPiso(ini?.est?.roas_piso != null ? String(ini.est.roas_piso).replace(".", ",") : "");
    setMetaPos(ini?.est?.meta_posicao != null ? String(ini.est.meta_posicao) : "");
    setRevisar(ini?.est?.revisar_em ?? somaDias(hoje, 30));
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
    const metaInt = numOuNulo(metaPos);
    if (form.tipo === "aprovar") void chamar("decisao_aprovar", { p_id: form.id, p_responsavel: resp, p_prazo: prazo, p_obs: texto || null, p_opcao: opcao || null });
    else if (form.tipo === "recusar") void chamar("decisao_recusar", { p_id: form.id, p_motivo: texto || null });
    else if (form.tipo === "concluir") void chamar("decisao_concluir", { p_id: form.id, p_obs: texto || null });
    else if (form.tipo === "estrategia") void chamar("decisao_estrategia", { p_id: form.id, p_objetivo: texto, p_roas_piso: numOuNulo(piso), p_meta_posicao: metaInt == null ? null : Math.round(metaInt), p_revisar_em: revisar || null });
    else if (form.tipo === "editar_est") void chamar("estrategia_atualizar", { p_id: form.id, p_objetivo: texto, p_roas_piso: numOuNulo(piso), p_meta_posicao: metaInt == null ? null : Math.round(metaInt), p_revisar_em: revisar || null });
    else void chamar("estrategia_encerrar", { p_id: form.id, p_motivo: texto || null });
  };

  // Botões que abrem o lugar certo do sistema para aquela decisão/estratégia.
  const atalhos = (r?: Ref | null) => {
    if (!r?.tipo) return null;
    if (ehAds(r)) {
      const telaAds = r.mkt === "ml"
        ? `/ads-ml${r.campanha ? `?campanha=${encodeURIComponent(r.campanha)}` : ""}`
        : `/ads-shopee${r.anuncio ? `?q=${encodeURIComponent(r.anuncio)}` : ""}`;
      return (
        <>
          {r.campanha && <button type="button" className={BTN_SEC} onClick={() => setAdsAberto(r)}>Abrir o ADS</button>}
          {r.sku && (
            <EditorPrecoPromo pedido={{
              order_sn: "", marketplace: r.mkt === "ml" ? "mercadolivre" : "shopee",
              empresa: r.empresa === "svl" ? "SVL Store" : "ACZ Pet", canal: r.loja ?? (r.mkt === "ml" ? "Mercado Livre" : "Shopee"), skus: r.sku,
            }} />
          )}
          <a href={telaAds} className="text-[12.5px] text-(--rl-accent-text) hover:underline">tela de ADS</a>
        </>
      );
    }
    if (r.tipo === "compra") return <a href="/compras" className={BTN_SEC}>Abrir Compras{r.ordem ? ` (${r.ordem})` : ""}</a>;
    if (r.tipo === "contas") return <a href={`/contas-pagar${r.filtro ? `?filtro=${r.filtro}` : ""}`} className={BTN_SEC}>Abrir Contas a pagar</a>;
    if (r.tipo === "caixa") return <a href="/fluxo-caixa" className={BTN_SEC}>Abrir Fluxo de caixa</a>;
    return null;
  };

  const formulario = (id: number, opcoes?: Opcao[] | null, tipos?: TipoForm[]) => {
    if (!form || form.id !== id || (tipos && !tipos.includes(form.tipo))) return null;
    const respNome = d.equipe.find((e) => e.id === resp)?.nome ?? "";
    const est = form.tipo === "estrategia" || form.tipo === "editar_est";
    const caminhos = (opcoes ?? []).filter((o) => o.acao !== "estrategia");
    return (
      <div className="mt-2.5 p-3 rounded-lg bg-(--rl-surface-2) border border-(--rl-border) flex flex-col gap-2.5">
        {form.tipo === "aprovar" && (
          <div className="flex gap-2.5 flex-wrap items-end">
            {caminhos.length > 0 && (
              <label className={`${ROTULO} min-w-[220px] flex-1`}>
                Caminho escolhido
                <select className={CAMPO} value={opcao} onChange={(e) => setOpcao(e.target.value)}>
                  <option value="">Sem definir (quem faz decide)</option>
                  {caminhos.map((o) => <option key={o.letra} value={o.letra}>{o.letra} — {o.titulo}</option>)}
                </select>
              </label>
            )}
            <label className={ROTULO}>
              Responsável
              <select className={CAMPO} value={resp} onChange={(e) => setResp(e.target.value)}>
                {d.equipe.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </select>
            </label>
            <label className={ROTULO}>
              Prazo
              <input type="date" className={CAMPO} value={prazo} min={hoje} onChange={(e) => setPrazo(e.target.value)} />
            </label>
          </div>
        )}
        {est && (
          <div className="flex gap-2.5 flex-wrap items-end">
            <label className={ROTULO} title="Se o ROAS de 7 dias cair abaixo disto, o coordenador volta a avisar. Em branco = sem piso.">
              ROAS mínimo aceito (opcional)
              <input className={`${CAMPO} w-[120px]`} inputMode="decimal" value={piso} onChange={(e) => setPiso(e.target.value)} placeholder="ex.: 5" />
            </label>
            <label className={ROTULO} title="Posição buscada no top 20 da categoria no Mercado Livre. Quando chegar lá, o coordenador avisa.">
              Posição buscada no ML (opcional)
              <input className={`${CAMPO} w-[120px]`} inputMode="numeric" value={metaPos} onChange={(e) => setMetaPos(e.target.value)} placeholder="ex.: 10" />
            </label>
            <label className={ROTULO}>
              Revisar em
              <input type="date" className={CAMPO} value={revisar} min={hoje} onChange={(e) => setRevisar(e.target.value)} />
            </label>
          </div>
        )}
        <input className={`${CAMPO} w-full`} value={texto} onChange={(e) => setTexto(e.target.value)}
          placeholder={form.tipo === "aprovar" ? "Observação para quem vai fazer (opcional)"
            : form.tipo === "recusar" ? "Por que não? (opcional — ajuda a não sugerir de novo)"
              : est ? "Qual é o objetivo? (ex.: chegar ao top 10 da categoria no Mercado Livre)"
                : form.tipo === "encerrar_est" ? "Por que encerrar? (opcional)" : "O que foi feito (opcional)"} />
        <div className="text-[12.5px] text-(--rl-text-3)">
          {form.tipo === "aprovar"
            ? resp === "renan"
              ? "Fica na sua lista de andamento, aqui embaixo. Nenhum aviso é enviado."
              : `Cria uma tarefa para ${respNome} no quadro de Tarefas e avisa no Discord.`
            : form.tipo === "recusar"
              ? "Some da lista e não volta por 14 dias, mesmo que os relatórios apontem de novo."
              : est
                ? "O coordenador para de cobrar este ADS e passa a acompanhar: só avisa se o ROAS cair do mínimo, se a posição for atingida ou no dia de revisar."
                : form.tipo === "encerrar_est"
                  ? "O ADS volta a ser cobrado pelo ROAS de empate a partir do próximo relatório."
                  : "Fecha a decisão. Se o problema continuar nos relatórios, ela volta em 2 dias."}
        </div>
        {erro && <div className="text-[12.5px] text-(--rl-red)">{erro}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={confirmar}
            disabled={ocupado || (form.tipo === "aprovar" && (!resp || !prazo)) || (est && !texto.trim())}
            className={`${BTN} border-(--rl-accent) bg-(--rl-accent) text-(--rl-on-accent)`}>
            {ocupado ? "Gravando…" : form.tipo === "aprovar" ? "Confirmar aprovação" : form.tipo === "recusar" ? "Confirmar"
              : form.tipo === "estrategia" ? "Registrar estratégia" : form.tipo === "editar_est" ? "Salvar"
                : form.tipo === "encerrar_est" ? "Encerrar estratégia" : "Marcar como feita"}
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
          {x.opcoes && x.opcoes.length > 0 && (
            <div className="flex flex-col gap-1 pt-0.5">
              <div className="text-[12px] font-semibold text-(--rl-text-2)">Caminhos</div>
              {x.opcoes.map((o) => (
                <div key={o.letra} className="grid grid-cols-[18px_minmax(0,1fr)] gap-1.5 text-[13px] leading-[1.45]">
                  <span className="font-semibold text-(--rl-text-3)">{o.letra}</span>
                  <span className="min-w-0 [text-wrap:pretty]">
                    <span className="font-medium">{o.titulo}</span>
                    {o.texto ? <span className="text-(--rl-text-3)"> — {o.texto}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 items-center flex-wrap pt-0.5">
            <Pill cor="gray">{deQuem(x.agente)}</Pill>
            {(x.dias_vista ?? 1) > 1 && <Pill cor="amber" title={`Aparece desde ${ddmm(x.primeira_vez)}`}>{x.dias_vista}º dia</Pill>}
            {x.reaberta_em && <Pill cor="amber">voltou</Pill>}
            {atalhos(x.ref)}
            <span className="flex-1" />
            <button type="button" onClick={() => abrir(x.id, "aprovar", { dono: x.dono })} className={`${BTN} border-(--rl-accent) text-(--rl-accent-text) hover:bg-(--rl-accent-soft)`}>Aprovar</button>
            {ehAds(x.ref) && (
              <button type="button" onClick={() => abrir(x.id, "estrategia")} className={BTN_SEC}
                title="O número está assim de propósito (estratégia): registrar o objetivo e parar de cobrar">É de propósito</button>
            )}
            <button type="button" onClick={() => abrir(x.id, "recusar")} className={`${BTN} border-(--rl-border-strong) text-(--rl-text-2) hover:border-(--rl-accent)`}>Agora não</button>
          </div>
          {formulario(x.id, x.opcoes, ["aprovar", "recusar", "estrategia"])}
        </div>
      </div>
    </div>
  );

  const px = mobile ? "px-3.5" : "px-5";
  return (
    <div className="rounded-[10px] border border-(--rl-border) bg-(--rl-surface) min-w-0 overflow-hidden">
      {adsAberto?.campanha && (
        adsAberto.mkt === "ml"
          ? <AnaliseAnuncioAds ml={{ item: null }} campaignId={adsAberto.campanha} nome={adsAberto.nome ?? "Campanha"} onFechar={() => setAdsAberto(null)} />
          : <AnaliseAnuncioAds shopId={adsAberto.shop ?? undefined} campaignId={adsAberto.campanha} nome={adsAberto.nome ?? "Anúncio"} onFechar={() => setAdsAberto(null)} />
      )}
      <div className={`${px} py-4 flex flex-col gap-1 border-b border-(--rl-border)`}>
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

      <div className={px}>
        {d.topo.length === 0 ? (
          <div className="py-5 text-[13.5px] text-(--rl-text-3)">Nada pedindo decisão agora.</div>
        ) : d.topo.map((x, i) => linha(x, i + 1))}
      </div>

      {d.outras.length > 0 && (
        <div className={`${px} border-t border-(--rl-border)`}>
          <button type="button" onClick={() => setVerOutras((v) => !v)} aria-expanded={verOutras}
            className="w-full flex items-center justify-between gap-2 py-3 text-[13.5px] font-medium text-(--rl-text-2) cursor-pointer">
            Outras em aberto ({d.outras.length})
            <Chevron aberto={verOutras} size={16} />
          </button>
          {verOutras && d.outras.map((x) => linha(x))}
        </div>
      )}

      {d.estrategias.length > 0 && (
        <div className={`${px} py-4 border-t border-(--rl-border)`}>
          <div className="text-[13.5px] font-semibold">Estratégias em acompanhamento ({d.estrategias.length})</div>
          <div className="text-[12.5px] text-(--rl-text-3) mb-1">Números fora do padrão de propósito. O coordenador não cobra; só acompanha e avisa se sair do combinado.</div>
          {d.estrategias.map((e) => (
            <div key={e.id} className="py-2.5 border-t border-(--rl-border) first:border-t-0 min-w-0">
              <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 items-start">
                <Foto src={e.sku ? fotos.get(e.sku) : null} size={40} rotulo="ADS" />
                <div className="min-w-0 flex flex-col gap-1.5">
                  <div className="flex gap-2 items-baseline flex-wrap">
                    <span className="text-[13.5px] font-semibold">{e.nome}</span>
                    {e.ref?.loja && <span className="text-[12.5px] text-(--rl-text-3)">{e.ref.loja}</span>}
                  </div>
                  <div className="text-[13px] leading-[1.45] [text-wrap:pretty]"><span className="text-(--rl-text-3)">Objetivo:</span> {e.objetivo}</div>
                  {e.hoje && <div className="text-[13px] leading-[1.45] text-(--rl-text-2) [text-wrap:pretty]"><span className="text-(--rl-text-3)">Hoje:</span> {e.hoje}</div>}
                  <div className="flex gap-2 items-center flex-wrap">
                    {e.meta_posicao != null && <Pill cor="accent">busca o top {e.meta_posicao}</Pill>}
                    <Pill cor="gray">{e.roas_piso != null ? `ROAS mínimo ${dec1(e.roas_piso)}` : "sem ROAS mínimo"}</Pill>
                    {e.revisar_em && <Pill cor={e.revisar_em <= hoje ? "amber" : "gray"}>revisar em {ddmm(e.revisar_em)}</Pill>}
                    <span className="text-[12px] text-(--rl-text-3)">desde {ddmm(diaSP(e.criado_em))}{e.criado_por ? ` · ${e.criado_por}` : ""}</span>
                    {atalhos(e.ref)}
                    <span className="flex-1" />
                    <button type="button" onClick={() => abrir(e.id, "editar_est", { est: e })} className={BTN_SEC}>Ajustar</button>
                    <button type="button" onClick={() => abrir(e.id, "encerrar_est")} className="text-[12.5px] text-(--rl-text-3) hover:underline cursor-pointer">encerrar</button>
                  </div>
                  {formulario(e.id, null, ["editar_est", "encerrar_est"])}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {d.andamento.length > 0 && (
        <div className={`${px} py-4 border-t border-(--rl-border) bg-(--rl-surface-2)`}>
          <div className="text-[13.5px] font-semibold mb-1">Aprovadas, em andamento ({d.andamento.length})</div>
          {d.andamento.map((x) => (
            <div key={x.id} className="py-2.5 border-t border-(--rl-border) first:border-t-0 min-w-0">
              <div className="flex gap-2 items-center flex-wrap">
                <span className="text-[13.5px] font-medium min-w-0 [text-wrap:pretty]">{x.o_que}</span>
                <Pill cor={x.atrasada ? "red" : "gray"}>{x.responsavel_nome ?? x.responsavel ?? "—"} · até {ddmm(x.prazo_tarefa)}{x.atrasada ? " · atrasada" : ""}</Pill>
                {x.sumiu_em && <Pill cor="green" title="Os relatórios pararam de apontar este problema">não aparece mais desde {ddmm(x.sumiu_em)}</Pill>}
                {atalhos(x.ref)}
                <span className="flex-1" />
                <button type="button" onClick={() => abrir(x.id, "concluir")} className={BTN_SEC}>Feita</button>
                <button type="button" disabled={ocupado} onClick={() => void chamar("decisao_reabrir", { p_id: x.id })}
                  className="text-[12.5px] text-(--rl-text-3) hover:underline cursor-pointer">voltar para a lista</button>
              </div>
              {x.opcao_escolhida && <div className="text-[12.5px] text-(--rl-text-3) mt-1 [text-wrap:pretty]">{x.opcao_escolhida}</div>}
              {formulario(x.id, null, ["concluir"])}
            </div>
          ))}
        </div>
      )}

      {d.recentes.length > 0 && (
        <div className={`${px} border-t border-(--rl-border)`}>
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
