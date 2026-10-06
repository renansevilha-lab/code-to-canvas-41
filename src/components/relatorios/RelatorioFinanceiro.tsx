import { useMemo } from "react";

import {
  arr, brl, brlMil, ddmm, Foto, Kpi, MONO, nomeCurto, Notas, num, numOuNull, obj, Pill, Secao, str,
  type RelatorioLista,
} from "./comum";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente financeiro (resumo de financeiro_relatorio_diario()).
// Layout "DetalheFinanceiro" do design. Só exibe o que vem no JSON; as contas
// aqui são de apresentação (somar faixas prontas, proporção das barras).
// ============================================================================

interface Urgente {
  tiny_id?: number; fornecedor?: string | null; descricao?: string | null; categoria?: string | null;
  valor?: number; vencimento?: string | null; dias?: number | null; faixa?: string | null;
}

/** Soma das faixas que vencem até 7 dias (atrasado + hoje + até 7 d). */
function venceEm7d(resumo: Record<string, unknown> | null) {
  const cp = obj(resumo?.contas_pagar_resumo);
  return {
    valor: num(obj(cp.atrasado).valor) + num(obj(cp.hoje).valor) + num(obj(cp.ate_7d).valor),
    atrasadoQtd: num(obj(cp.atrasado).qtd),
    atrasadoValor: num(obj(cp.atrasado).valor),
  };
}

export function miniFin(rel: RelatorioLista): MiniKpi[] {
  const tot = obj(rel.resumo?.carteira_total);
  const v7 = venceEm7d(rel.resumo);
  return [
    { label: "Saldo em conta", valor: brlMil(tot.saldo_em_conta) },
    { label: "A receber", valor: brlMil(tot.a_receber) },
    { label: "Vence em 7 dias", valor: brlMil(v7.valor), risco: v7.atrasadoQtd > 0 },
  ];
}

/** "Pede decisão": atrasadas, maior conta da semana, saldo projetado negativo. */
export function decisoesFin(rel: RelatorioLista): Decisao[] {
  const r = rel.resumo ?? {};
  const out: Decisao[] = [];
  const v7 = venceEm7d(r);
  const urg = arr<Urgente>(r.contas_pagar_urgentes);
  if (v7.atrasadoQtd > 0) {
    const forn = [...new Set(urg.filter((u) => u.faixa === "atrasado").sort((a, b) => num(b.valor) - num(a.valor))
      .map((u) => nomeCurto(u.fornecedor)))].slice(0, 2);
    out.push({
      tom: "red",
      oQue: `${v7.atrasadoQtd} ${v7.atrasadoQtd === 1 ? "conta atrasada" : "contas atrasadas"}:`,
      detalhe: `${brl(v7.atrasadoValor)}${forn.length ? `, maiores ${forn.join(" e ")}` : ""}`,
      rotulo: "R$",
    });
  }
  const proxima = urg.filter((u) => u.faixa !== "atrasado").sort((a, b) => num(b.valor) - num(a.valor))[0];
  if (proxima) {
    const d = numOuNull(proxima.dias);
    out.push({
      tom: "amber",
      oQue: `${nomeCurto(proxima.fornecedor)} ${d === 0 ? "vence hoje" : `vence ${ddmm(proxima.vencimento)}`}:`,
      detalhe: brl(proxima.valor),
      rotulo: nomeCurto(proxima.fornecedor),
    });
  }
  const fl = obj(r.fluxo_resumo);
  const pior = numOuNull(fl.pior_acumulado);
  if (pior != null && pior < 0) {
    out.push({
      tom: "amber",
      oQue: "Saldo projetado negativo:",
      detalhe: `${brl(pior)} em ${ddmm(str(fl.dia_pior_acumulado))}`,
      rotulo: "30d",
    });
  }
  return out.slice(0, 3);
}

function situacao(u: Urgente): { txt: string; cor: "red" | "amber" | "gray" } {
  const d = numOuNull(u.dias);
  if (u.faixa === "atrasado" || (d != null && d < 0)) {
    const n = d == null ? null : Math.abs(d);
    return { txt: n == null ? "atrasado" : `${n} ${n === 1 ? "dia" : "dias"} atrasado`, cor: "red" };
  }
  if (d === 0 || u.faixa === "hoje") return { txt: "vence hoje", cor: "amber" };
  return { txt: d == null ? "até 7 dias" : `em ${d} ${d === 1 ? "dia" : "dias"}`, cor: "gray" };
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
function diasNoMes(m: string): number {
  const [a, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(a, mm, 0)).getUTCDate();
}

function horasDesde(iso: unknown, ref: string | null): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = new Date(iso).getTime();
  const r = ref ? new Date(ref).getTime() : Date.now();
  if (!Number.isFinite(t) || !Number.isFinite(r)) return null;
  return (r - t) / 3_600_000;
}

export function RelatorioFinanceiro({ rel, mobile }: { rel: RelatorioLista; mobile?: boolean }) {
  const r = rel.resumo ?? {};
  const tot = obj(r.carteira_total);
  const fluxo = obj(r.fluxo_resumo);
  const v7 = venceEm7d(r);
  const pior = numOuNull(fluxo.pior_acumulado);
  const split = mobile ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2";

  return (
    <div className="flex flex-col gap-7">
      <div className={mobile ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 lg:grid-cols-4 gap-3"}>
        <Kpi label="Saldo em conta" valor={brl(tot.saldo_em_conta)} sub="carteiras com leitura de saldo" />
        <Kpi label="A receber" valor={brl(tot.a_receber)} sub="carteiras; Shopee é estimativa" />
        <Kpi label="Atrasado + 7 dias" valor={brl(v7.valor)} tom={v7.atrasadoQtd > 0 ? "red" : undefined}
          sub={v7.atrasadoQtd > 0 ? `${brl(v7.atrasadoValor)} já atrasado` : "nada atrasado"} />
        <Kpi label="Pior saldo projetado" valor={brl(pior)} tom={pior != null && pior < 0 ? "red" : undefined}
          sub={fluxo.dia_pior_acumulado ? `em ${ddmm(str(fluxo.dia_pior_acumulado))}, nos próximos 30 dias` : null} />
      </div>

      <div className={`grid ${split} gap-7`}>
        <Carteiras itens={arr(r.carteira)} />
        <PrecisaPagar itens={arr<Urgente>(r.contas_pagar_urgentes)} />
      </div>

      <div className={`grid ${split} gap-7`}>
        <Proximos30 cp={obj(r.contas_pagar_resumo)} fluxo={fluxo} />
        <PorCategoria itens={arr(r.contas_pagar_por_categoria_30d)} />
      </div>

      <div className={`grid ${split} gap-7`}>
        <Dre atual={obj(r.dre_mes_atual)} anterior={obj(r.dre_mes_anterior)} dataRef={rel.data_referencia} />
        <Secao titulo="Qualidade dos dados">
          <Notas itens={notasQualidade(obj(r.qualidade), rel.gerado_em)} />
        </Secao>
      </div>
    </div>
  );
}

function Carteiras({ itens }: { itens: Record<string, unknown>[] }) {
  return (
    <Secao titulo="Carteiras" nota="a receber por marketplace">
      {itens.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Sem carteiras no relatório.</div> : (
        <div className="flex flex-col">
          {itens.map((c, i) => {
            const real = str(c.natureza).toLowerCase().startsWith("real");
            const nota = [
              c.saldo_em != null ? `saldo ${brl(c.saldo_em_conta)}` : null,
              c.pedidos_a_receber != null ? `${num(c.pedidos_a_receber).toLocaleString("pt-BR")} pedidos` : null,
              real ? "valor real" : "estimativa",
            ].filter(Boolean).join(" · ");
            return (
              <div key={`${str(c.carteira)}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-[9px] border-b border-(--rl-border) items-baseline">
                <div className="min-w-0 flex items-center gap-2.5">
                  <Foto size={28} rotulo={str(c.marketplace) === "mercadolivre" ? "ML" : str(c.carteira)} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{str(c.carteira) || "—"}</div>
                    <div className="text-[12px] text-(--rl-text-3) truncate" title={str(c.natureza)}>{nota}</div>
                  </div>
                </div>
                <div className={MONO}>{brl(c.a_receber)}</div>
              </div>
            );
          })}
        </div>
      )}
    </Secao>
  );
}

function PrecisaPagar({ itens }: { itens: Urgente[] }) {
  const linhas = useMemo(
    () => [...itens].sort((a, b) => str(a.vencimento).localeCompare(str(b.vencimento)) || num(b.valor) - num(a.valor)),
    [itens],
  );
  const total = itens.reduce((s, u) => s + num(u.valor), 0);
  return (
    <Secao titulo="Precisa pagar" nota={`atrasadas e próximos 7 dias · ${brl(total)}`}>
      {linhas.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nada atrasado nem vencendo em 7 dias.</div> : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full min-w-[420px] border-collapse text-[13px]">
            <thead>
              <tr className="text-[12px] text-(--rl-text-3)">
                <th className="text-left font-medium pb-2 border-b border-(--rl-border) sticky top-0 bg-(--rl-surface)">Fornecedor</th>
                <th className="text-left font-medium pb-2 border-b border-(--rl-border) sticky top-0 bg-(--rl-surface)">Vencimento</th>
                <th className="text-right font-medium pb-2 border-b border-(--rl-border) sticky top-0 bg-(--rl-surface)">Valor</th>
                <th className="text-right font-medium pb-2 border-b border-(--rl-border) sticky top-0 bg-(--rl-surface)">Situação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((u, i) => {
                const s = situacao(u);
                const nome = nomeCurto(u.fornecedor);
                return (
                  <tr key={`${u.tiny_id ?? "x"}-${i}`}>
                    <td className="py-[7px] pr-3 border-b border-(--rl-border) font-medium">
                      <div className="flex items-center gap-2 min-w-0" title={[u.fornecedor, u.categoria, u.descricao].filter(Boolean).join(" · ")}>
                        <Foto size={24} rotulo={nome} />
                        <span className="truncate max-w-[180px]">{nome}</span>
                      </div>
                    </td>
                    <td className={`py-[9px] border-b border-(--rl-border) text-(--rl-text-2) ${MONO}`}>{ddmm(u.vencimento)}</td>
                    <td className={`py-[9px] border-b border-(--rl-border) text-right whitespace-nowrap ${MONO}`}>{brl(u.valor)}</td>
                    <td className="py-[9px] border-b border-(--rl-border) text-right"><Pill cor={s.cor}>{s.txt}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Secao>
  );
}

function Proximos30({ cp, fluxo }: { cp: Record<string, unknown>; fluxo: Record<string, unknown> }) {
  const faixas = [
    { k: "atrasado", label: "Atrasado" },
    { k: "hoje", label: "Hoje" },
    { k: "ate_7d", label: "Até 7 dias" },
    { k: "ate_15d", label: "8 a 15 dias" },
    { k: "ate_30d", label: "16 a 30 dias" },
  ].map((f) => ({ ...f, qtd: num(obj(cp[f.k]).qtd), valor: num(obj(cp[f.k]).valor) }))
    .filter((f) => f.k !== "hoje" || f.valor > 0);
  const max = Math.max(1, ...faixas.map((f) => f.valor));
  const e7 = numOuNull(fluxo.entradas_ml_7d);
  const s7 = numOuNull(fluxo.saidas_7d);
  return (
    <Secao titulo="Próximos 30 dias" nota={
      <span className="flex gap-3 items-center">
        <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-[2px] bg-(--rl-border-strong)" />sai (contas a pagar)</span>
      </span>
    }>
      <div className="flex flex-col gap-0.5">
        {faixas.map((f) => (
          <div key={f.k} className="grid grid-cols-[96px_minmax(0,1fr)_92px] gap-3 items-center p-2 rounded-md"
            style={{ background: f.k === "atrasado" && f.valor > 0 ? "var(--rl-red-soft)" : "transparent" }}>
            <div className="text-[12.5px] text-(--rl-text-2)">{f.label}</div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 rounded-[3px]" style={{
                width: `${(f.valor / max) * 82}%`, minWidth: f.valor > 0 ? 2 : 0,
                background: f.k === "atrasado" ? "var(--rl-red)" : "var(--rl-border-strong)",
              }} />
              <span className="text-[11.5px] text-(--rl-text-3) whitespace-nowrap">{f.qtd} {f.qtd === 1 ? "conta" : "contas"}</span>
            </div>
            <div className={`${MONO} text-right font-medium`} style={{ color: f.k === "atrasado" && f.valor > 0 ? "var(--rl-red)" : undefined }}>{brlMil(f.valor)}</div>
          </div>
        ))}
      </div>
      {(e7 != null || s7 != null) && (
        <div className="mt-2 px-2 text-[12px] text-(--rl-text-3)">
          Em 7 dias: saem {brl(s7)} · o Mercado Livre libera {brl(e7)} (Shopee fora da projeção diária)
        </div>
      )}
    </Secao>
  );
}

function PorCategoria({ itens }: { itens: Record<string, unknown>[] }) {
  const max = Math.max(1, ...itens.map((c) => num(c.valor)));
  return (
    <Secao titulo="Por categoria" nota="contas a pagar dos próximos 30 dias">
      {itens.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Sem contas nos próximos 30 dias.</div> : (
        <div className="flex flex-col gap-2.5">
          {itens.map((c, i) => (
            <div key={`${str(c.categoria)}-${i}`} className="grid grid-cols-[132px_minmax(0,1fr)_96px] gap-3 items-center">
              <div className="text-[13px] text-(--rl-text-2) truncate" title={`${str(c.categoria)} · ${num(c.qtd)} contas`}>{str(c.categoria) || "—"}</div>
              <div className="h-2 rounded bg-(--rl-surface-2)">
                <div className="h-2 rounded bg-(--rl-accent) opacity-75" style={{ width: `${(num(c.valor) / max) * 100}%` }} />
              </div>
              <div className={`${MONO} text-right whitespace-nowrap`}>{brlMil(c.valor)}</div>
            </div>
          ))}
        </div>
      )}
    </Secao>
  );
}

function Dre({ atual, anterior, dataRef }: { atual: Record<string, unknown>; anterior: Record<string, unknown>; dataRef: string }) {
  if (Object.keys(atual).length === 0) {
    return <Secao titulo="DRE resumida"><div className="text-[13px] text-(--rl-text-3)">Sem DRE no relatório.</div></Secao>;
  }
  const mes = str(atual.mes);
  const nomeMes = /^\d{4}-\d{2}/.test(mes) ? MESES[Number(mes.slice(5, 7)) - 1] : "mês";
  const parcial = mes && dataRef.slice(0, 7) === mes && Number(dataRef.slice(8, 10)) < diasNoMes(mes);
  const receita = num(atual.receita_liquida);
  const pct = (v: number) => (receita ? `${Math.abs((v / receita) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "");
  const linhas: { label: string; v: number | null; forte?: boolean; negativo?: boolean }[] = [
    { label: "Receita líquida", v: numOuNull(atual.receita_liquida) },
    { label: "Deduções de marketplace", v: numOuNull(atual.comissoes_frete), negativo: true },
    { label: "CMV", v: numOuNull(atual.cmv), negativo: true },
    { label: "Impostos", v: numOuNull(atual.impostos), negativo: true },
    { label: "Margem de contribuição", v: numOuNull(atual.margem_contribuicao), forte: true },
    { label: "ADS", v: numOuNull(atual.ads), negativo: true },
    { label: "Despesas fixas", v: numOuNull(atual.custo_fixo_sem_ads), negativo: true },
    { label: "Lucro líquido", v: numOuNull(atual.lucro_liquido), forte: true },
  ];
  const ant = obj(anterior);
  const mesAnt = str(ant.mes);
  return (
    <Secao titulo="DRE resumida" nota={`${nomeMes}${parcial ? `, 01 a ${ddmm(dataRef)}` : ""}`}>
      <div className="flex flex-col">
        {linhas.map((l) => {
          const v = l.v == null ? null : l.negativo ? -Math.abs(l.v) : l.v;
          return (
            <div key={l.label} className="grid grid-cols-[minmax(0,1fr)_100px_56px] gap-3 py-[7px] text-[13px]"
              style={{ borderTop: `1px solid ${l.forte ? "var(--rl-border-strong)" : "transparent"}`, fontWeight: l.forte ? 600 : 400 }}>
              <div className="text-(--rl-text-2)">{l.label}</div>
              <div className={`${MONO} text-right`} style={{ color: l.forte && v != null && v < 0 ? "var(--rl-red)" : undefined }}>{brl(v)}</div>
              <div className="text-[12px] text-(--rl-text-3) text-right">{v == null ? "" : pct(v)}</div>
            </div>
          );
        })}
        {numOuNull(ant.lucro_liquido) != null && (
          <div className="pt-2 text-[12px] text-(--rl-text-3)">
            {/^\d{4}-\d{2}/.test(mesAnt) ? `${MESES_CURTOS[Number(mesAnt.slice(5, 7)) - 1]}/${mesAnt.slice(0, 4)}` : "Mês anterior"}:
            {" "}receita {brl(ant.receita_liquida)} · lucro {brl(ant.lucro_liquido)}
            {ant.margem_liquida_pct != null ? ` (${num(ant.margem_liquida_pct).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)` : ""}
          </div>
        )}
      </div>
    </Secao>
  );
}

function notasQualidade(q: Record<string, unknown>, geradoEm: string | null): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const hCp = horasDesde(q.contas_pagar_atualizado_em, geradoEm);
  const hShopee = horasDesde(q.carteira_shopee_atualizada_em, geradoEm);
  if (hCp != null && hCp > 24) out.push(`Contas a pagar sem atualizar há ${Math.floor(hCp)} h quando o relatório foi gerado.`);
  if (hShopee != null && hShopee > 6) out.push(`Saldo da carteira Shopee sem atualizar há ${Math.floor(hShopee)} h quando o relatório foi gerado.`);
  const semVenc = num(q.contas_sem_vencimento);
  if (semVenc > 0) out.push(`${semVenc} conta(s) em aberto sem data de vencimento.`);
  const aClass = arr(q.contas_a_classificar);
  if (aClass.length > 0) {
    const tot = aClass.reduce((s, c) => s + num(c.valor), 0);
    out.push(`${aClass.length} conta(s) sem categoria no DRE (${brl(tot)}): ${aClass.map((c) => `${nomeCurto(c.fornecedor)} ${brl(c.valor)}`).join(", ")}.`);
  }
  const dup = arr(q.possiveis_duplicadas);
  if (dup.length > 0) {
    out.push(`${dup.length} possível(is) duplicada(s): ${dup.map((c) => `${nomeCurto(c.fornecedor)} ${brl(c.valor)} vence ${ddmm(str(c.vencimento))}`).join("; ")}.`);
  }
  out.push("Pior saldo projetado é pessimista: a Shopee não entra no dia a dia por não ter data de liberação.");
  return out;
}
