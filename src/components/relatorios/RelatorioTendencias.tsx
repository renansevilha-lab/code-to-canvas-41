import { useState } from "react";

import {
  arr, brlMil, Chevron, ddmm, Notas, num, numOuNull, obj, Pill, Secao, str, type RelatorioLista,
} from "./comum";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente de Tendências e mudanças (resumo = tendencias_relatorio(),
// versao 'v1'; docs/tendencias-relatorio.sql): lojas[] (7 / 30 / 90 dias contra
// a janela anterior, série semanal, leitura, causas candidatas, produtos que mais
// caíram e subiram — a última linha é o Total), mudancas{} (o que NÓS mudamos em
// 30 dias — meta de ROAS, preço, promoção, orçamento, envios do sistema — e como
// os anúncios ficaram depois, descontado o movimento da loja), decisoes[] e
// qualidade{avisos}. Só apresentação: nenhum número é calculado aqui.
// ============================================================================

const LEITURA: Record<string, { t: string; cor: "red" | "amber" | "green" | "gray" }> = {
  queda_persistente: { t: "queda há um tempo", cor: "red" },
  queda_recente: { t: "queda recente", cor: "amber" },
  perdendo_folego: { t: "perdendo fôlego", cor: "amber" },
  recuperando: { t: "recuperando", cor: "green" },
  alta_persistente: { t: "alta há um tempo", cor: "green" },
  alta_recente: { t: "alta recente", cor: "green" },
  estavel: { t: "estável", cor: "gray" },
  estavel_apos_queda: { t: "estável depois de cair", cor: "gray" },
  sem_base: { t: "sem base para comparar", cor: "gray" },
  sem_venda: { t: "sem venda", cor: "gray" },
};
const GRUPOS: { k: string; nome: string }[] = [
  { k: "roas", nome: "Meta de ROAS" },
  { k: "preco", nome: "Preço (3% ou mais)" },
  { k: "promocao", nome: "Promoção (entrou ou saiu)" },
  { k: "orcamento", nome: "Orçamento de ADS" },
  { k: "sistema", nome: "Envios do sistema (texto, fotos)" },
  { k: "situacao", nome: "Anúncio ou campanha pausado/ativado" },
];
const EFEITO: Record<string, { t: string; cor: "red" | "green" | "gray" | "amber" }> = {
  melhorou: { t: "melhorou", cor: "green" }, piorou: { t: "piorou", cor: "red" },
  sem_efeito: { t: "sem efeito claro", cor: "gray" }, medindo: { t: "medindo", cor: "amber" },
};

const pct = (x: unknown): string => {
  const v = numOuNull(x);
  if (v == null) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
};
const corVar = (x: unknown) => {
  const v = numOuNull(x);
  return v == null || Math.abs(v) < 3 ? "var(--rl-text-2)" : v > 0 ? "var(--rl-green)" : "var(--rl-red)";
};
const emQueda = (l: Record<string, unknown>) => /queda|perdendo/.test(str(l.leitura));

function lojasDe(rel: RelatorioLista) {
  const todas = arr(rel.resumo?.lojas);
  return { lojas: todas.filter((l) => str(l.loja) !== "Total"), total: todas.find((l) => str(l.loja) === "Total") ?? null };
}

export function miniTend(rel: RelatorioLista): MiniKpi[] {
  const { lojas, total } = lojasDe(rel);
  // maior queda em R$ nos 30 dias (lojas com base)
  const pior = lojas
    .map((l) => ({ l, d: num(obj(l.medio).receita) - num(obj(l.medio).receita_ant) }))
    .filter((x) => emQueda(x.l) && x.d < 0).sort((a, b) => a.d - b.d)[0];
  const mud = obj(rel.resumo?.mudancas);
  const nMud = GRUPOS.reduce((s, g) => s + num(obj(mud[g.k]).n), 0);
  return [
    { label: "Total em 30 dias", valor: pct(obj(total?.medio).var_pct), risco: num(obj(total?.medio).var_pct) < -3 },
    { label: "Maior queda", valor: pior ? `${str(pior.l.loja)} ${pct(obj(pior.l.medio).var_pct)}` : "nenhuma", risco: !!pior },
    { label: "Mudanças nossas", valor: String(nMud) },
  ];
}

/** O relatório manda pronto em resumo.decisoes (agentes.ts lê de lá); aqui é só o reserva. */
export function decisoesTend(rel: RelatorioLista): Decisao[] {
  return arr(rel.resumo?.decisoes).slice(0, 3).map((d) => ({
    tom: d.tom === "red" || d.tom === "amber" ? d.tom : "gray", oQue: str(d.o_que), detalhe: str(d.detalhe), sku: d.sku ? str(d.sku) : null,
  }));
}

function Horizonte({ h }: { h: Record<string, unknown> }) {
  if (numOuNull(h.receita) == null) return <span className="text-(--rl-text-3)">—</span>;
  return (
    <div className="flex flex-col">
      <span className="font-semibold" style={{ color: corVar(h.var_pct) }}>{pct(h.var_pct)}{h.base_incompleta ? "*" : ""}</span>
      <span className="text-[11.5px] text-(--rl-text-3) whitespace-nowrap">{brlMil(h.receita_ant)} → {brlMil(h.receita)}</span>
    </div>
  );
}

/** Barras das últimas semanas (receita), com a mesma altura máxima para a loja. */
function Semanas({ semanas }: { semanas: Record<string, unknown>[] }) {
  const ult = semanas.slice(-13);
  const max = Math.max(1, ...ult.map((s) => num(s.receita)));
  if (ult.length < 3) return null;
  return (
    <div className="flex items-end gap-[3px] h-9" aria-label="Receita por semana, últimas 13 semanas">
      {ult.map((s, i) => (
        <div key={i} title={`semana de ${ddmm(str(s.semana))}: ${brlMil(s.receita)}`}
          className="w-[7px] rounded-[2px]"
          style={{ height: `${Math.max(6, Math.round((num(s.receita) / max) * 100))}%`, background: i >= ult.length - 4 ? "var(--rl-accent)" : "var(--rl-border-strong)" }} />
      ))}
    </div>
  );
}

function BlocoLoja({ l, aberto, onToggle }: { l: Record<string, unknown>; aberto: boolean; onToggle: () => void }) {
  const lei = LEITURA[str(l.leitura)] ?? { t: str(l.leitura), cor: "gray" as const };
  const t = obj(l.tendencia);
  const causas = arr(l.causas);
  const queda = arr(l.skus_queda);
  const alta = arr(l.skus_alta);
  return (
    <div className="border border-(--rl-border) rounded-lg min-w-0 overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={aberto}
        className="w-full text-left px-3.5 py-3 flex items-center gap-3 flex-wrap cursor-pointer hover:bg-(--rl-surface-2)">
        <div className="min-w-[150px] flex-1">
          <div className="text-[14px] font-semibold">{str(l.loja)}</div>
          <div className="mt-1 flex gap-1.5 items-center flex-wrap">
            <Pill cor={lei.cor}>{lei.t}</Pill>
            {numOuNull(t.vs_pico_pct) != null && num(t.vs_pico_pct) <= -15 && (
              <span className="text-[11.5px] text-(--rl-text-3)">{pct(t.vs_pico_pct)} contra o pico (4 semanas até {ddmm(str(t.pico_4_semanas_ate))})</span>
            )}
          </div>
        </div>
        <Semanas semanas={arr(l.semanas)} />
        <div className="grid grid-cols-3 gap-4 text-[13px]">
          <div><div className="text-[11px] text-(--rl-text-3)">7 dias</div><Horizonte h={obj(l.curto)} /></div>
          <div><div className="text-[11px] text-(--rl-text-3)">30 dias</div><Horizonte h={obj(l.medio)} /></div>
          <div><div className="text-[11px] text-(--rl-text-3)">90 dias</div><Horizonte h={obj(l.longo)} /></div>
        </div>
        <Chevron aberto={aberto} size={16} />
      </button>
      {aberto && (
        <div className="px-3.5 py-3.5 border-t border-(--rl-border) flex flex-col gap-4">
          {causas.length > 0 && (
            <div>
              <div className="text-[12px] font-semibold text-(--rl-text-2) mb-1.5">Motivos prováveis (30 dias) — são candidatos, não prova</div>
              <div className="flex flex-col gap-2">
                {causas.map((c, i) => (
                  <div key={i} className="grid grid-cols-[84px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[1.45]">
                    <span className="font-semibold whitespace-nowrap" style={{ color: num(c.impacto_rs) < 0 ? "var(--rl-red)" : "var(--rl-green)" }}>
                      {numOuNull(c.impacto_rs) == null ? "—" : brlMil(c.impacto_rs)}
                    </span>
                    <span className="min-w-0 [text-wrap:pretty]"><span className="font-medium">{str(c.titulo)}.</span> <span className="text-(--rl-text-2)">{str(c.detalhe)}</span></span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {[{ nome: "Produtos que mais caíram", itens: queda }, { nome: "Produtos que mais subiram", itens: alta }].map((g) => g.itens.length > 0 && (
            <div key={g.nome}>
              <div className="text-[12px] font-semibold text-(--rl-text-2) mb-1.5">{g.nome} (30 dias)</div>
              <div className="flex flex-col divide-y divide-(--rl-border)">
                {g.itens.map((s) => (
                  <div key={str(s.sku)} className="py-1.5 grid grid-cols-[84px_minmax(0,1fr)] gap-2.5 text-[13px] leading-[1.45]">
                    <span className="font-semibold whitespace-nowrap" style={{ color: num(s.delta) < 0 ? "var(--rl-red)" : "var(--rl-green)" }}>{brlMil(s.delta)}</span>
                    <span className="min-w-0">
                      <span className="font-mono text-[12px] text-(--rl-text-3)">{str(s.sku)}</span> <span className="font-medium">{str(s.nome)}</span>
                      <span className="text-(--rl-text-3)"> · {brlMil(s.receita_ant)} → {brlMil(s.receita)}</span>
                      {arr<string>(s.o_que_mudou).length > 0 && (
                        <span className="block text-[12.5px] text-(--rl-text-2) [text-wrap:pretty]">{arr<string>(s.o_que_mudou).join(" · ")}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {causas.length === 0 && queda.length === 0 && alta.length === 0 && (
            <div className="text-[13px] text-(--rl-text-3)">Sem quebra por produto para esta loja.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function RelatorioTendencias({ rel, mobile }: { rel: RelatorioLista; mobile?: boolean }) {
  const { lojas, total } = lojasDe(rel);
  const mud = obj(rel.resumo?.mudancas);
  const destaques = arr(mud.destaques);
  const avisos = arr<string>(obj(rel.resumo?.qualidade).avisos);
  // abre de início as lojas em queda com base relevante
  const [abertas, setAbertas] = useState<Set<string>>(
    () => new Set(lojas.filter((l) => emQueda(l) && num(obj(l.medio).receita_ant) >= 5000).map((l) => str(l.loja))),
  );
  const toggle = (nome: string) => setAbertas((s) => { const n = new Set(s); if (n.has(nome)) n.delete(nome); else n.add(nome); return n; });
  const ordenadas = [...lojas].sort((a, b) => num(obj(b.medio).receita_ant) + num(obj(b.medio).receita) - num(obj(a.medio).receita_ant) - num(obj(a.medio).receita));

  return (
    <div className="flex flex-col gap-7">
      <Secao titulo="Vendas por loja: curto, médio e longo prazo"
        nota={`até ${ddmm(str(rel.resumo?.data_referencia))} · cada janela contra a anterior do mesmo tamanho · barras = receita por semana (roxo = últimas 4)`}>
        <div className="flex flex-col gap-2.5">
          {total && (
            <div className="px-3.5 py-2.5 rounded-lg bg-(--rl-surface-2) flex items-center gap-3 flex-wrap">
              <div className="min-w-[150px] flex-1 text-[14px] font-semibold">Todas as lojas</div>
              <div className="grid grid-cols-3 gap-4 text-[13px]">
                <div><div className="text-[11px] text-(--rl-text-3)">7 dias</div><Horizonte h={obj(total.curto)} /></div>
                <div><div className="text-[11px] text-(--rl-text-3)">30 dias</div><Horizonte h={obj(total.medio)} /></div>
                <div><div className="text-[11px] text-(--rl-text-3)">90 dias</div><Horizonte h={obj(total.longo)} /></div>
              </div>
              <span className="w-4" />
            </div>
          )}
          {ordenadas.map((l) => <BlocoLoja key={str(l.loja)} l={l} aberto={abertas.has(str(l.loja))} onToggle={() => toggle(str(l.loja))} />)}
          <div className="text-[12px] text-(--rl-text-3)">* janela anterior incompleta (a loja entrou no sistema depois): compara a média por dia.</div>
        </div>
      </Secao>

      <Secao titulo="O que mudamos e como os anúncios ficaram depois" nota={`${ddmm(str(mud.de))} a ${ddmm(str(mud.ate))} · já descontado o movimento da loja`}>
        <div className="flex flex-col gap-3">
          {GRUPOS.map((g) => {
            const x = obj(mud[g.k]);
            if (num(x.n) === 0) return null;
            return (
              <div key={g.k} className="border border-(--rl-border) rounded-lg px-3.5 py-3 flex flex-col gap-1.5 min-w-0">
                <div className="flex gap-2 items-center flex-wrap">
                  <span className="text-[13.5px] font-semibold">{g.nome}</span>
                  <span className="text-[12.5px] text-(--rl-text-3)">{num(x.n)} mudanças em {num(x.anuncios)} anúncios</span>
                  <span className="flex-1" />
                  <Pill cor="green">{num(x.melhorou)} melhoraram</Pill>
                  <Pill cor="red">{num(x.piorou)} pioraram</Pill>
                  <Pill cor="gray">{num(x.sem_efeito)} sem efeito claro</Pill>
                  {num(x.medindo) > 0 && <Pill cor="amber">{num(x.medindo)} medindo</Pill>}
                </div>
                {x.resumo ? <div className="text-[13px] leading-[1.5] text-(--rl-text-2) [text-wrap:pretty]">{str(x.resumo)}</div> : null}
              </div>
            );
          })}
          {destaques.length > 0 && (
            <div>
              <div className="text-[12px] font-semibold text-(--rl-text-2) mb-1.5">Mudanças com maior efeito</div>
              <div className={mobile ? "flex flex-col divide-y divide-(--rl-border)" : "flex flex-col divide-y divide-(--rl-border)"}>
                {destaques.map((m, i) => {
                  const ef = EFEITO[str(m.efeito)] ?? { t: str(m.efeito), cor: "gray" as const };
                  return (
                    <div key={i} className="py-2 flex gap-2.5 items-center flex-wrap text-[13px] leading-[1.45]">
                      <Pill cor={ef.cor}>{ef.t}</Pill>
                      <span className="min-w-0 flex-1 [text-wrap:pretty]">
                        <span className="font-medium">{str(m.o_que)}</span> em {ddmm(str(m.quando))} · {str(m.anuncio)}
                        <span className="text-(--rl-text-3)"> · {str(m.loja)}</span>
                      </span>
                      <span className="whitespace-nowrap text-(--rl-text-2)">
                        {brlMil(obj(m.antes).receita)} → {brlMil(obj(m.depois).receita)} por semana
                        <span className="text-(--rl-text-3)"> (loja {pct(m.loja_var_pct)})</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {mud.como_mede ? <div className="text-[12px] leading-[1.5] text-(--rl-text-3) [text-wrap:pretty]">Como mede: {str(mud.como_mede)}</div> : null}
        </div>
      </Secao>

      <Secao titulo="Qualidade dos dados">
        <Notas itens={avisos} />
      </Secao>
    </div>
  );
}
