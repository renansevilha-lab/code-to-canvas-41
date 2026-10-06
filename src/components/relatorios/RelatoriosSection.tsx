import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useIsMobile } from "@/hooks/use-mobile";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  CATEGORIAS, categoriaDoSlug, Chevron, diaSemana, diaSP, ddmm, Foto, hojeSP, horaSP, IconeAgente,
  IconeRelogio, nomeDoAgente, QUERY_OPTS, rotuloDia, somaDias, useFotos, type RelatorioLista,
} from "./comum";
import { agenteDef, decisoesDe, ehV0, kindDe } from "./agentes";
import { BotaoCompleta, RelatorioCard } from "./RelatorioCard";
import { RelatorioHtmlModal } from "./RelatorioHtmlModal";

// ============================================================================
// Relatórios dos agentes — design "Faixa Hoje + histórico" (Claude Design,
// 06/out/2026). No topo, o último relatório de cada agente (Financeiro,
// Compras, ADS) com destaque, 3 mini-KPIs e "Pede decisão"; "Abrir relatório"
// mostra o detalhe num painel abaixo da faixa (no celular, dentro do card).
// Embaixo, o histórico por agente (abas com contagem do período), agrupado por
// dia. Usado na página /relatorios e na seção #relatorios da Visão Geral.
// Lista em view_relatorios_agentes_lista (sem HTML); o HTML só no modal.
// ============================================================================

type Periodo = "7d" | "30d" | "tudo";
const PERIODOS: { id: Periodo; label: string }[] = [
  { id: "7d", label: "Últimos 7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "tudo", label: "Tudo" },
];
const COLUNAS = "id, agente, categoria, titulo, destaque, data_referencia, gerado_em, resumo";
const desdeDe = (p: Periodo) => (p === "tudo" ? null : somaDias(hojeSP(), p === "7d" ? -6 : -29));

export function RelatoriosSection({
  relSlug, onRelChange, modo = "secao",
}: {
  relSlug?: string;
  onRelChange: (slug: string) => void;
  modo?: "pagina" | "secao";
}) {
  const cat = categoriaDoSlug(relSlug);
  const mobile = useIsMobile();
  const [periodo, setPeriodo] = useState<Periodo>("7d");
  const [aberto, setAberto] = useState<number | null>(null);
  const [hojeAberto, setHojeAberto] = useState<string | null>(null);
  const [modal, setModal] = useState<RelatorioLista | null>(null);
  const hoje = hojeSP();

  // Âncora #relatorios: a seção nasce depois do resto do Dashboard; rola até ela.
  useEffect(() => {
    if (modo !== "secao" || typeof window === "undefined" || window.location.hash !== "#relatorios") return;
    const t = setTimeout(() => document.getElementById("relatorios")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => clearTimeout(t);
  }, [modo]);

  // Último relatório de cada agente (faixa Hoje).
  const ultimosQ = useQuery({
    queryKey: ["relatorios", "ultimos"],
    ...QUERY_OPTS,
    queryFn: async (): Promise<RelatorioLista[]> => {
      const { data, error } = await supabaseExternal.from("view_relatorios_agentes_lista")
        .select(COLUNAS).order("gerado_em", { ascending: false, nullsFirst: false }).limit(20);
      if (error) throw error;
      return (data ?? []) as RelatorioLista[];
    },
  });
  const faixa = useMemo(() => CATEGORIAS.map((c) => ({
    c, rel: (ultimosQ.data ?? []).find((r) => r.agente === c.agente) ?? null,
  })), [ultimosQ.data]);
  // Os de HOJE ficam só na faixa; os mais antigos seguem também no histórico.
  const idsHoje = faixa.filter((f) => f.rel && diaSP(f.rel.gerado_em) === hoje).map((f) => f.rel!.id);
  const chaveHoje = idsHoje.join(",");

  const contagensQ = useQuery({
    queryKey: ["relatorios", "contagens", periodo, chaveHoje],
    ...QUERY_OPTS,
    queryFn: async (): Promise<Record<string, number>> => {
      const desde = desdeDe(periodo);
      const res = await Promise.all(CATEGORIAS.map(async (c) => {
        let q = supabaseExternal.from("view_relatorios_agentes_lista")
          .select("id", { count: "exact", head: true }).eq("categoria", c.nome);
        if (desde) q = q.gte("data_referencia", desde);
        if (chaveHoje) q = q.not("id", "in", `(${chaveHoje})`);
        const { count, error } = await q;
        if (error) throw error;
        return [c.slug, count ?? 0] as const;
      }));
      return Object.fromEntries(res);
    },
    enabled: !ultimosQ.isLoading,
  });

  const listaQ = useQuery({
    queryKey: ["relatorios", "lista", cat.nome, periodo, chaveHoje],
    ...QUERY_OPTS,
    enabled: !ultimosQ.isLoading,
    queryFn: async (): Promise<RelatorioLista[]> => {
      let q = supabaseExternal.from("view_relatorios_agentes_lista").select(COLUNAS).eq("categoria", cat.nome);
      const desde = desdeDe(periodo);
      if (desde) q = q.gte("data_referencia", desde);
      if (chaveHoje) q = q.not("id", "in", `(${chaveHoje})`);
      const { data, error } = await q
        .order("data_referencia", { ascending: false })
        .order("gerado_em", { ascending: false })
        .limit(40);
      if (error) throw error;
      return (data ?? []) as RelatorioLista[];
    },
  });

  const grupos = useMemo(() => {
    const m = new Map<string, RelatorioLista[]>();
    for (const r of listaQ.data ?? []) {
      const g = m.get(r.data_referencia) ?? [];
      g.push(r);
      m.set(r.data_referencia, g);
    }
    return [...m.entries()];
  }, [listaQ.data]);

  const erro = ultimosQ.error || listaQ.error;
  const carregando = ultimosQ.isLoading || listaQ.isLoading;
  const tentarDeNovo = () => { void ultimosQ.refetch(); void listaQ.refetch(); void contagensQ.refetch(); };
  const relHojeAberto = faixa.find((f) => f.c.slug === hojeAberto)?.rel ?? null;

  return (
    <section id={modo === "secao" ? "relatorios" : undefined}
      className={`rl-ui flex flex-col min-w-0 ${mobile ? "gap-5" : "gap-7"} ${modo === "secao" ? "scroll-mt-6" : ""}`}>
      {/* Cabeçalho + período */}
      <div className="flex justify-between items-end gap-4 flex-wrap">
        <div className="min-w-0">
          {modo === "pagina" ? (
            <h1 className="m-0 text-[24px] font-semibold tracking-[-0.015em]">Relatórios</h1>
          ) : (
            <h2 className="m-0 text-[20px] font-semibold tracking-[-0.015em]">
              <a href="#relatorios" className="hover:underline underline-offset-4">Relatórios</a>
            </h2>
          )}
          <p className="mt-1 mb-0 text-[14px] text-(--rl-text-2) [text-wrap:pretty]">
            Os agentes analisam e sugerem toda manhã. Nada aqui é executado: a decisão é sua.
          </p>
        </div>
        <div role="radiogroup" aria-label="Período"
          className="flex gap-0.5 p-[3px] rounded-lg bg-(--rl-surface-2) border border-(--rl-border)"
          style={{ width: mobile ? "100%" : "auto" }}>
          {PERIODOS.map((p) => {
            const on = periodo === p.id;
            return (
              <button key={p.id} type="button" role="radio" aria-checked={on}
                onClick={() => { setPeriodo(p.id); setAberto(null); }}
                className="flex-1 text-[13px] font-medium px-3 py-[5px] rounded-md border whitespace-nowrap cursor-pointer"
                style={{
                  background: on ? "var(--rl-surface)" : "transparent",
                  color: on ? "var(--rl-text)" : "var(--rl-text-2)",
                  borderColor: on ? "var(--rl-border)" : "transparent",
                }}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Faixa Hoje */}
      {ultimosQ.isLoading ? (
        <FaixaEsqueleto mobile={mobile} />
      ) : !erro && (
        <FaixaHoje
          faixa={faixa} mobile={mobile} aberto={hojeAberto} hoje={hoje}
          onToggle={(slug) => setHojeAberto((a) => (a === slug ? null : slug))}
          onCompleta={setModal}
        />
      )}
      {!mobile && relHojeAberto && (
        <PainelHoje rel={relHojeAberto} onFechar={() => setHojeAberto(null)} onCompleta={() => setModal(relHojeAberto)} />
      )}

      {/* Histórico */}
      <div className="flex flex-col gap-4 min-w-0">
        {!erro && <div className="text-[16px] font-semibold pt-2">Histórico</div>}
        <div className="flex gap-2 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Agente">
          {CATEGORIAS.map((c) => {
            const on = c.slug === cat.slug;
            const n = contagensQ.data?.[c.slug];
            return (
              <button key={c.slug} type="button" role="tab" aria-selected={on}
                onClick={() => { onRelChange(c.slug); setAberto(null); }}
                className="flex items-center gap-2 shrink-0 text-[13.5px] font-medium py-1.5 pl-3.5 pr-2 rounded-full border whitespace-nowrap cursor-pointer hover:border-(--rl-accent)"
                style={{
                  background: on ? "var(--rl-accent-soft)" : "var(--rl-surface)",
                  color: on ? "var(--rl-accent-text)" : "var(--rl-text-2)",
                  borderColor: on ? "var(--rl-accent)" : "var(--rl-border)",
                }}>
                {c.nome}
                <span className="text-[12px] font-semibold min-w-[22px] px-1.5 py-px rounded-full text-center"
                  style={{ background: on ? "var(--rl-accent)" : "var(--rl-gray-soft)", color: on ? "var(--rl-on-accent)" : "var(--rl-text-2)" }}>
                  {n ?? "·"}
                </span>
              </button>
            );
          })}
        </div>

        {erro ? (
          <ErroBox onRetry={tentarDeNovo} />
        ) : carregando ? (
          <ListaEsqueleto mobile={mobile} />
        ) : grupos.length === 0 ? (
          <VazioBox
            texto={`O agente de ${cat.nome} não tem relatório ${periodo === "tudo" ? "no histórico" : periodo === "7d" ? "anterior nos últimos 7 dias" : "anterior nos últimos 30 dias"}.${idsHoje.length ? " O de hoje está na faixa acima." : ""}`}
            acao={periodo === "7d" ? { label: "Ver últimos 30 dias", fn: () => setPeriodo("30d") }
              : periodo === "30d" ? { label: "Ver tudo", fn: () => setPeriodo("tudo") } : null}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {grupos.map(([dia, rels]) => {
              const g = rotuloDia(dia);
              return (
                <div key={dia} className="flex flex-col gap-2">
                  <div className="flex items-baseline gap-2 pl-0.5">
                    <span className="text-[13px] font-semibold">{g.label}</span>
                    {g.sub && <span className="text-[12.5px] text-(--rl-text-3)">{g.sub}</span>}
                  </div>
                  {rels.map((r) => (
                    <RelatorioCard key={r.id} rel={r} mobile={mobile}
                      aberto={aberto === r.id}
                      onToggle={() => setAberto((a) => (a === r.id ? null : r.id))}
                      onCompleta={() => setModal(r)} />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {modal && <RelatorioHtmlModal rel={modal} open onOpenChange={(o) => { if (!o) setModal(null); }} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Faixa Hoje
// ---------------------------------------------------------------------------
function FaixaHoje({
  faixa, mobile, aberto, hoje, onToggle, onCompleta,
}: {
  faixa: { c: (typeof CATEGORIAS)[number]; rel: RelatorioLista | null }[];
  mobile: boolean;
  aberto: string | null;
  hoje: string;
  onToggle: (slug: string) => void;
  onCompleta: (r: RelatorioLista) => void;
}) {
  const comRel = faixa.filter((f) => f.rel);
  const deHoje = comRel.filter((f) => diaSP(f.rel!.gerado_em) === hoje);
  const ultimo = comRel.map((f) => f.rel!.gerado_em ?? "").sort().pop() ?? null;
  const decisoes = useMemo(() => Object.fromEntries(faixa.map((f) => [f.c.slug, f.rel ? decisoesDe(f.rel) : []])), [faixa]);
  const fotos = useFotos(Object.values(decisoes).flat().map((d) => d.sku));
  if (comRel.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-between items-baseline gap-3 flex-wrap">
        <div className="flex items-baseline gap-2">
          <span className="text-[16px] font-semibold">{deHoje.length > 0 ? "Hoje" : "Mais recentes"}</span>
          <span className="text-[13px] text-(--rl-text-3)">{diaSemana(hoje)}</span>
        </div>
        <div className="text-[12.5px] text-(--rl-text-3)">
          {deHoje.length} de {faixa.length} agentes rodaram hoje
          {ultimo ? ` · último ${diaSP(ultimo) === hoje ? "às" : `em ${ddmm(diaSP(ultimo))} às`} ${horaSP(ultimo)}` : ""}
        </div>
      </div>
      <div className={`grid gap-3 items-stretch ${mobile ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-3"}`}>
        {faixa.map(({ c, rel }) => {
          if (!rel) {
            return (
              <div key={c.slug} className="border border-dashed border-(--rl-border-strong) rounded-[10px] p-4 flex items-center gap-2.5 text-(--rl-text-3) min-w-0">
                <IconeAgente kind={c.kind} size={28} />
                <div className="text-[13.5px]"><span className="font-semibold text-(--rl-text-2)">{c.nome}</span> ainda não gerou relatório.</div>
              </div>
            );
          }
          const on = aberto === c.slug;
          const def = agenteDef(rel.agente);
          const v0 = ehV0(rel);
          const minis = v0 ? [] : def?.mini(rel) ?? [];
          const pend = def?.pendente?.(rel) ?? null;
          const dec = decisoes[c.slug] ?? [];
          const ehHoje = diaSP(rel.gerado_em) === hoje;
          return (
            <div key={c.slug} className="rounded-[10px] bg-(--rl-surface) flex flex-col min-w-0 overflow-hidden border"
              style={{ borderColor: on ? "var(--rl-accent)" : "var(--rl-border)" }}>
              {pend && (
                <div className="flex items-center gap-1.5 px-4 py-[7px] bg-(--rl-amber-soft) text-(--rl-amber) text-[12px] font-medium border-b border-(--rl-border)">
                  <IconeRelogio size={13} /> {pend}
                </div>
              )}
              <div className="p-4 flex flex-col gap-3.5 flex-1">
                <div className="flex items-center gap-2.5">
                  <IconeAgente kind={kindDe(rel)} size={28} />
                  <div className="text-[14px] font-semibold flex-1 min-w-0">{c.nome}</div>
                  <div className="text-[12px] whitespace-nowrap" style={{ color: ehHoje ? "var(--rl-text-3)" : "var(--rl-amber)" }}
                    title={ehHoje ? undefined : "O relatório de hoje ainda não chegou; este é o último gerado."}>
                    {ehHoje ? horaSP(rel.gerado_em) : `${ddmm(diaSP(rel.gerado_em))} ${horaSP(rel.gerado_em)}`}
                  </div>
                </div>
                <div className="text-[14px] leading-normal [text-wrap:pretty]" style={{ color: v0 ? "var(--rl-text-3)" : undefined }}>
                  {v0 ? "Relatório em formato antigo: só a versão completa está disponível." : rel.destaque ?? "—"}
                </div>
                {minis.length > 0 && (
                  <div className="grid grid-cols-3 gap-2.5 py-2.5 border-y border-(--rl-border)">
                    {minis.map((k) => (
                      <div key={k.label} className="min-w-0">
                        <div className="text-[11.5px] text-(--rl-text-3)">{k.label}</div>
                        <div className="text-[16px] font-semibold truncate" style={{ color: k.risco ? "var(--rl-red)" : undefined }}>{k.valor}</div>
                      </div>
                    ))}
                  </div>
                )}
                {!v0 && (
                  <div className="flex flex-col gap-2">
                    <div className="text-[12px] font-semibold text-(--rl-text-2)">Pede decisão</div>
                    {dec.length === 0 ? (
                      <div className="text-[13px] text-(--rl-text-3)">Nada urgente neste relatório.</div>
                    ) : dec.map((d, i) => (
                      <div key={i} className="grid grid-cols-[40px_minmax(0,1fr)] gap-2.5 items-center text-[13px] leading-[1.45]">
                        <div className="relative w-10 h-10">
                          <Foto src={d.sku ? fotos.get(d.sku) : null} size={40} rotulo={d.sku ? undefined : d.rotulo} />
                          <i className="absolute -top-[3px] -right-[3px] w-2.5 h-2.5 rounded-full border-2 border-(--rl-surface) pointer-events-none"
                            style={{ background: d.tom === "red" ? "var(--rl-red)" : d.tom === "amber" ? "var(--rl-amber)" : "var(--rl-text-3)" }} />
                        </div>
                        <span className="min-w-0"><span className="font-medium">{d.oQue}</span> <span className="text-(--rl-text-2)">{d.detalhe}</span></span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-auto flex gap-2 items-center pt-1">
                  {!v0 && (
                    <button type="button" onClick={() => onToggle(c.slug)} aria-expanded={on}
                      className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-[7px] rounded-[7px] border cursor-pointer hover:border-(--rl-accent)"
                      style={{
                        background: on ? "var(--rl-accent-soft)" : "var(--rl-surface)",
                        color: on ? "var(--rl-accent-text)" : "var(--rl-text)",
                        borderColor: on ? "var(--rl-accent)" : "var(--rl-border-strong)",
                      }}>
                      {on ? "Fechar relatório" : "Abrir relatório"}
                      <Chevron aberto={on} size={14} />
                    </button>
                  )}
                  <button type="button" onClick={() => onCompleta(rel)}
                    className="text-[13px] font-medium px-2 py-[7px] text-(--rl-accent-text) hover:underline cursor-pointer">
                    Versão completa
                  </button>
                </div>
              </div>
              {mobile && on && def && (
                <div className="border-t border-(--rl-border) px-3.5 py-4">
                  <def.Detalhe rel={rel} mobile />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PainelHoje({ rel, onFechar, onCompleta }: { rel: RelatorioLista; onFechar: () => void; onCompleta: () => void }) {
  const def = agenteDef(rel.agente);
  const ehHoje = diaSP(rel.gerado_em) === hojeSP();
  if (!def) return null;
  return (
    <div className="border border-(--rl-border-strong) rounded-[10px] bg-(--rl-surface) -mt-2">
      <div className="flex justify-between items-center gap-3 px-5 py-3.5 border-b border-(--rl-border)">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[15px] font-semibold">{nomeDoAgente(rel.agente)} · {ehHoje ? "relatório de hoje" : `relatório de ${ddmm(rel.data_referencia)}`}</span>
          <span className="text-[12px] text-(--rl-text-3)">{rel.titulo ? `${rel.titulo} · ` : ""}{horaSP(rel.gerado_em)}</span>
        </div>
        <div className="flex gap-1.5 items-center">
          <BotaoCompleta onClick={onCompleta} compacto />
          <button type="button" onClick={onFechar} aria-label="Fechar"
            className="grid place-items-center w-8 h-8 rounded-[7px] text-(--rl-text-2) hover:bg-(--rl-surface-2) cursor-pointer">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>
      </div>
      <div className="px-6 py-[22px] flex flex-col gap-6">
        <def.Detalhe rel={rel} />
        <div className="text-[12px] text-(--rl-text-3) pt-4 border-t border-(--rl-border)">
          Gerado {ehHoje ? "às" : `em ${ddmm(diaSP(rel.gerado_em))} às`} {horaSP(rel.gerado_em)} pelo agente {nomeDoAgente(rel.agente)}. Só análise e sugestão; o app não executa nada.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------
const Sk = ({ w, h, r = 4 }: { w: string | number; h: number; r?: number }) => (
  <div style={{ width: w, height: h, borderRadius: r }} className="bg-(--rl-skeleton) animate-pulse" />
);

function FaixaEsqueleto({ mobile }: { mobile: boolean }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Carregando relatórios">
      <Sk w={120} h={14} />
      <div className={`grid gap-3 ${mobile ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-3"}`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="border border-(--rl-border) rounded-[10px] bg-(--rl-surface) p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2.5"><Sk w={28} h={28} r={7} /><Sk w="40%" h={13} /></div>
            <Sk w="92%" h={11} /><Sk w="70%" h={11} />
            <div className="grid grid-cols-3 gap-2.5"><Sk w="100%" h={30} r={5} /><Sk w="100%" h={30} r={5} /><Sk w="100%" h={30} r={5} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListaEsqueleto({ mobile }: { mobile: boolean }) {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true">
      <Sk w={72} h={12} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-(--rl-border) rounded-[10px] bg-(--rl-surface) px-[18px] py-4 grid gap-3.5"
          style={{ gridTemplateColumns: mobile ? "32px minmax(0,1fr)" : "32px minmax(0,1fr) auto" }}>
          <Sk w={32} h={32} r={8} />
          <div className="flex flex-col gap-[9px]"><Sk w="46%" h={13} /><Sk w="92%" h={11} /><Sk w="70%" h={11} /></div>
          {!mobile && <div className="grid grid-cols-[repeat(3,96px)] gap-3"><Sk w="100%" h={34} r={5} /><Sk w="100%" h={34} r={5} /><Sk w="100%" h={34} r={5} /></div>}
        </div>
      ))}
    </div>
  );
}

function ErroBox({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="border border-(--rl-border) rounded-[10px] bg-(--rl-surface) px-6 py-10 flex flex-col items-center gap-2.5 text-center">
      <div className="w-10 h-10 rounded-[10px] grid place-items-center bg-(--rl-red-soft) text-(--rl-red)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
      </div>
      <div className="text-[15px] font-semibold">Não foi possível carregar os relatórios</div>
      <div className="text-[13.5px] text-(--rl-text-2) max-w-[44ch] leading-normal">O servidor não respondeu. Os relatórios já gerados continuam salvos.</div>
      <button type="button" onClick={onRetry}
        className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium px-3.5 py-2 rounded-[7px] bg-(--rl-accent) text-(--rl-on-accent) hover:opacity-90 cursor-pointer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
        Tentar de novo
      </button>
    </div>
  );
}

function VazioBox({ texto, acao }: { texto: string; acao: { label: string; fn: () => void } | null }) {
  return (
    <div className="border border-dashed border-(--rl-border-strong) rounded-[10px] px-6 py-10 flex flex-col items-center gap-2.5 text-center">
      <div className="w-10 h-10 rounded-[10px] grid place-items-center bg-(--rl-gray-soft) text-(--rl-text-3)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
      </div>
      <div className="text-[15px] font-semibold">Nenhum relatório neste período</div>
      <div className="text-[13.5px] text-(--rl-text-2) max-w-[46ch] leading-normal">{texto}</div>
      {acao && (
        <button type="button" onClick={acao.fn}
          className="mt-1.5 text-[13px] font-medium px-3 py-[7px] rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) hover:bg-(--rl-surface-2) cursor-pointer">
          {acao.label}
        </button>
      )}
    </div>
  );
}

