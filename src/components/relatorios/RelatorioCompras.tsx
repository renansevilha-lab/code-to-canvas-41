import { useMemo, useState } from "react";

import {
  arr, brl, brlMil, dec1, Foto, intBR, Kpi, MONO, nomeCurto, Notas, num, numOuNull, obj, Pill, Secao, str,
  useFotos, type RelatorioLista,
} from "./comum";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente de compras (resumo de compras_relatorio_diario()):
// resumo{ruptura, urgente, atencao, valor_estoque_total, valor_parado},
// por_fornecedor[], atencao[], excesso_sem_giro[], qualidade{}.
// Layout "DetalheCompras" do design.
// ============================================================================

const STATUS: Record<string, { label: string; cor: "red-solid" | "red" | "amber" | "gray" }> = {
  ruptura_empresa: { label: "Ruptura", cor: "red-solid" },
  comprar_urgente: { label: "Urgente", cor: "red" },
  atencao: { label: "Atenção", cor: "amber" },
  excesso: { label: "Excesso", cor: "gray" },
  sem_giro: { label: "Sem giro", cor: "gray" },
};
/** Cobertura ≤ 0 (estoque negativo no Tiny) aparece como 0 d. */
const cobDias = (x: unknown) => {
  const v = numOuNull(x);
  return v == null ? null : Math.max(0, Math.round(v));
};
const corCob = (d: number | null) => (d == null ? undefined : d === 0 ? "var(--rl-red)" : d <= 7 ? "var(--rl-amber)" : undefined);

export function produtoCurto(p: unknown, max = 44): string {
  const s = str(p).replace(/^\[[^\]]*\]\s*/, "").trim();
  if (s.length <= max) return s || "—";
  const corte = s.slice(0, max);
  return `${corte.slice(0, Math.max(corte.lastIndexOf(" "), 24))}…`;
}

export function miniCompras(rel: RelatorioLista): MiniKpi[] {
  const r = obj(rel.resumo?.resumo);
  return [
    { label: "Ruptura", valor: `${intBR(r.ruptura)} SKUs`, risco: num(r.ruptura) > 0 },
    { label: "Urgente", valor: intBR(r.urgente) },
    { label: "Valor parado", valor: brlMil(r.valor_parado) },
  ];
}

/** "Pede decisão": rupturas que mais vendem e a urgência de menor cobertura. */
export function decisoesCompras(rel: RelatorioLista): Decisao[] {
  const at = arr(rel.resumo?.atencao);
  const rupt = at.filter((a) => a.status === "ruptura_empresa" && num(a.venda_dia) >= 0.5)
    .sort((a, b) => num(b.venda_dia) - num(a.venda_dia)).slice(0, 2);
  const urg = at.filter((a) => a.status === "comprar_urgente")
    .sort((a, b) => num(a.cobertura_total_dias) - num(b.cobertura_total_dias) || num(b.venda_dia) - num(a.venda_dia));
  const out: Decisao[] = rupt.map((a) => ({
    tom: "red" as const,
    oQue: `${produtoCurto(a.produto, 36)} sem estoque:`,
    detalhe: `vende ${dec1(a.venda_dia)}/dia${num(a.oc_aguardando) > 0 ? `, ${intBR(a.oc_aguardando)} un em OC` : ", sem OC aberta"}`,
    sku: str(a.sku),
  }));
  for (const a of urg) {
    if (out.length >= 3) break;
    out.push({
      tom: "amber",
      oQue: `${produtoCurto(a.produto, 36)}:`,
      detalhe: `${cobDias(a.cobertura_total_dias) ?? "—"} dias de cobertura, vende ${dec1(a.venda_dia)}/dia`,
      sku: str(a.sku),
    });
  }
  return out.slice(0, 3);
}

const LIMITE = 15;

export function RelatorioCompras({ rel, mobile }: { rel: RelatorioLista; mobile?: boolean }) {
  const res = rel.resumo ?? {};
  const r = obj(res.resumo);
  const porForn = arr(res.por_fornecedor);
  const atencao = arr(res.atencao);
  const excesso = arr(res.excesso_sem_giro).slice(0, 10);
  const [forn, setForn] = useState<string | null>(null);
  const [todos, setTodos] = useState(false);

  const filtrada = useMemo(
    () => (forn ? atencao.filter((a) => str(a.fornecedor) === forn) : atencao),
    [atencao, forn],
  );
  const visiveis = todos || forn ? filtrada : filtrada.slice(0, LIMITE);
  const fotos = useFotos([...visiveis.map((a) => str(a.sku)), ...excesso.map((e) => str(e.sku))]);
  const excessoTotal = excesso.reduce((s, e) => s + num(e.valor_estoque), 0);
  const topRupt = porForn.filter((f) => num(f.ruptura) > 0).sort((a, b) => num(b.ruptura) - num(a.ruptura))[0];

  return (
    <div className="flex flex-col gap-7">
      <div className={mobile ? "grid grid-cols-2 gap-3" : "grid grid-cols-2 lg:grid-cols-5 gap-3"}>
        <Kpi label="Ruptura" valor={`${intBR(r.ruptura)} SKUs`} tom={num(r.ruptura) > 0 ? "red" : undefined}
          sub={topRupt ? `${intBR(topRupt.ruptura)} da ${nomeCurto(topRupt.fornecedor)}` : "sem estoque na empresa"} />
        <Kpi label="Urgente" valor={intBR(r.urgente)} sub="comprar já" />
        <Kpi label="Atenção" valor={intBR(r.atencao)} sub="cobertura apertada" />
        <Kpi label="Valor em estoque" valor={brlMil(r.valor_estoque_total)} sub={`${intBR(r.skus_analisados)} SKUs analisados`} />
        <Kpi label="Valor parado" valor={brlMil(r.valor_parado)} sub="excesso e sem giro" />
      </div>

      {porForn.length > 0 && (
        <Secao titulo="Por fornecedor" nota="clique num fornecedor para filtrar a tabela abaixo">
          <div className="overflow-x-auto border border-(--rl-border) rounded-lg">
            <table className="w-full min-w-[640px] border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="rl-th text-left">Fornecedor</th>
                  <th className="rl-th text-right">SKUs</th>
                  <th className="rl-th text-right">Ruptura</th>
                  <th className="rl-th text-right">Urgente</th>
                  <th className="rl-th text-right">Atenção</th>
                  <th className="rl-th text-right">Valor em estoque</th>
                  <th className="rl-th text-right">Menor cobertura</th>
                </tr>
              </thead>
              <tbody>
                {porForn.map((f, i) => {
                  const nome = str(f.fornecedor);
                  const ativo = forn === nome;
                  const cob = cobDias(f.menor_cobertura_dias);
                  const alternar = () => { setForn(ativo ? null : nome); };
                  return (
                    <tr key={`${nome}-${i}`} tabIndex={0} onClick={alternar}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternar(); } }}
                      className="cursor-pointer hover:bg-(--rl-accent-soft)"
                      style={{ background: ativo ? "var(--rl-accent-soft)" : undefined }}>
                      <td className="rl-td font-medium" title={nome} style={{ color: ativo ? "var(--rl-accent-text)" : undefined }}>{nomeCurto(nome)}</td>
                      <td className={`rl-td text-right ${MONO}`}>{intBR(f.skus)}</td>
                      <td className={`rl-td text-right ${MONO}`} style={{ color: num(f.ruptura) > 0 ? "var(--rl-red)" : "var(--rl-text-3)", fontWeight: num(f.ruptura) > 0 ? 600 : 400 }}>{intBR(f.ruptura)}</td>
                      <td className={`rl-td text-right ${MONO}`}>{intBR(f.urgente)}</td>
                      <td className={`rl-td text-right ${MONO}`}>{intBR(f.atencao)}</td>
                      <td className={`rl-td text-right whitespace-nowrap ${MONO}`} title={num(f.valor_estoque) < 0 ? "saldo negativo no Tiny" : undefined}>{brl(f.valor_estoque)}</td>
                      <td className={`rl-td text-right ${MONO}`} style={{ color: corCob(cob) }}>{cob == null ? "—" : `${cob} d`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Secao>
      )}

      <Secao
        titulo="Ruptura, urgente e atenção"
        acao={forn ? (
          <button type="button" onClick={() => setForn(null)}
            className="flex items-center gap-1.5 text-[12px] font-medium py-[3px] pl-2.5 pr-1.5 rounded-full border border-(--rl-accent) bg-(--rl-accent-soft) text-(--rl-accent-text) cursor-pointer">
            {nomeCurto(forn)}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-label="Limpar filtro"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        ) : null}
        nota={forn ? `${filtrada.length} itens de ${nomeCurto(forn)}` : `mostrando ${visiveis.length} de ${filtrada.length}`}
      >
        {filtrada.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nenhum SKU nesta situação.</div> : (
          <>
            <div className="overflow-x-auto border border-(--rl-border) rounded-lg">
              <table className="w-full min-w-[1240px] border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className="rl-th text-left">Fornecedor</th>
                    <th className="rl-th text-left">SKU</th>
                    <th className="rl-th text-left">Produto</th>
                    <th className="rl-th text-left">Status</th>
                    <th className="rl-th text-right">Venda/dia</th>
                    <th className="rl-th text-right">Estoque geral</th>
                    <th className="rl-th text-right border-l border-(--rl-border)">Full Amazon</th>
                    <th className="rl-th text-right">Full ML</th>
                    <th className="rl-th text-right border-r border-(--rl-border)">Full Shopee</th>
                    <th className="rl-th text-right">Em trânsito</th>
                    <th className="rl-th text-right">OC aguardando</th>
                    <th className="rl-th text-right">Cobertura</th>
                    <th className="rl-th text-right">Com OC</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((a, i) => {
                    const st = STATUS[str(a.status)] ?? { label: str(a.status) || "—", cor: "gray" as const };
                    const cob = cobDias(a.cobertura_total_dias);
                    const coc = cobDias(a.cobertura_com_oc_dias);
                    const sku = str(a.sku);
                    return (
                      <tr key={`${sku}-${i}`}>
                        <td className="rl-td whitespace-nowrap" title={str(a.fornecedor)}>{nomeCurto(a.fornecedor)}</td>
                        <td className="rl-td font-mono text-[12px] text-(--rl-text-2) whitespace-nowrap">{sku || "—"}</td>
                        <td className="rl-td font-medium py-1.5">
                          <div className="flex items-center gap-2.5 min-w-[220px] max-w-[340px]" title={str(a.produto)}>
                            <Foto src={fotos.get(sku)} size={36} />
                            <span className="line-clamp-2">{str(a.produto) || "—"}</span>
                          </div>
                        </td>
                        <td className="rl-td"><Pill cor={st.cor}>{st.label}</Pill></td>
                        <td className={`rl-td text-right ${MONO}`}>{dec1(a.venda_dia)}</td>
                        <td className={`rl-td text-right ${MONO}`} style={{ color: num(a.estoque_geral) < 0 ? "var(--rl-text-3)" : undefined }}>{intBR(a.estoque_geral)}</td>
                        <td className={`rl-td text-right ${MONO} border-l border-(--rl-border)`}>{intBR(a.full_amazon)}</td>
                        <td className={`rl-td text-right ${MONO}`}>{intBR(a.full_ml)}</td>
                        <td className={`rl-td text-right ${MONO} border-r border-(--rl-border)`}>{intBR(a.full_shopee)}</td>
                        <td className={`rl-td text-right ${MONO}`}>{intBR(a.full_em_transito)}</td>
                        <td className={`rl-td text-right whitespace-nowrap ${MONO}`}>{num(a.oc_aguardando) > 0 ? intBR(a.oc_aguardando) : "—"}</td>
                        <td className={`rl-td text-right font-semibold ${MONO}`} style={{ color: corCob(cob) }}>{cob == null ? "—" : `${cob} d`}</td>
                        <td className={`rl-td text-right ${MONO}`} style={{ color: corCob(coc) }}>{coc == null ? "—" : `${coc} d`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!forn && filtrada.length > LIMITE && (
              <button type="button" onClick={() => setTodos((t) => !t)}
                className="mt-2 text-[13px] font-medium text-(--rl-accent-text) hover:underline cursor-pointer">
                {todos ? "Mostrar menos" : `Mostrar todos (${filtrada.length})`}
              </button>
            )}
          </>
        )}
      </Secao>

      <div className={mobile ? "grid grid-cols-1 gap-7" : "grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-7"}>
        <Secao titulo="Excesso e sem giro" nota={`top ${excesso.length} por valor · ${brl(excessoTotal)}`}>
          {excesso.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nada parado.</div> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-[13px]">
                <thead>
                  <tr className="text-[12px] text-(--rl-text-3)">
                    <th className="text-left font-medium pb-2 border-b border-(--rl-border)">Produto</th>
                    <th className="text-left font-medium pb-2 border-b border-(--rl-border)">Fornecedor</th>
                    <th className="text-right font-medium pb-2 border-b border-(--rl-border)">Estoque</th>
                    <th className="text-right font-medium pb-2 border-b border-(--rl-border)">Cobertura</th>
                    <th className="text-right font-medium pb-2 border-b border-(--rl-border)">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {excesso.map((e, i) => {
                    const sku = str(e.sku);
                    const cob = numOuNull(e.cobertura_total_dias);
                    return (
                      <tr key={`${sku}-${i}`}>
                        <td className="py-[7px] pr-3 border-b border-(--rl-border)">
                          <div className="flex items-center gap-2.5 min-w-0" title={str(e.produto)}>
                            <Foto src={fotos.get(sku)} size={36} />
                            <div className="min-w-0">
                              <div className="font-medium line-clamp-2">{produtoCurto(e.produto, 60)}</div>
                              <div className="font-mono text-[11.5px] text-(--rl-text-3)">{sku}{e.status === "sem_giro" ? " · sem giro" : ""}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-[7px] pr-3 border-b border-(--rl-border) text-(--rl-text-2) whitespace-nowrap" title={str(e.fornecedor)}>{nomeCurto(e.fornecedor)}</td>
                        <td className={`py-[7px] border-b border-(--rl-border) text-right whitespace-nowrap ${MONO}`}>{intBR(e.estoque_total)} un</td>
                        <td className={`py-[7px] border-b border-(--rl-border) text-right whitespace-nowrap text-(--rl-text-2) ${MONO}`}>
                          {cob == null ? "sem venda" : cob > 999 ? "999+ d" : `${Math.round(cob)} d`}
                        </td>
                        <td className={`py-[7px] border-b border-(--rl-border) text-right whitespace-nowrap ${MONO}`}>{brl(e.valor_estoque)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Secao>
        <Secao titulo="Qualidade dos dados">
          <Notas itens={notasCompras(obj(res.qualidade), rel.gerado_em)} />
        </Secao>
      </div>
    </div>
  );
}

function notasCompras(q: Record<string, unknown>, geradoEm: string | null): React.ReactNode[] {
  const ref = geradoEm ? new Date(geradoEm).getTime() : Date.now();
  const horas = (x: unknown) => (typeof x === "string" && x ? (ref - new Date(x).getTime()) / 3_600_000 : null);
  const out: React.ReactNode[] = [];
  const hEst = horas(q.estoque_atualizado_em);
  const hFull = horas(q.full_atualizado_em);
  if (hEst != null && hEst > 24) out.push(`Estoque do Tiny sem atualizar há ${Math.floor(hEst)} h quando o relatório foi gerado.`);
  if (hFull != null && hFull > 24) out.push(`Estoque do Full sem atualizar há ${Math.floor(hFull)} h quando o relatório foi gerado.`);
  const naoSinc = arr(q.nao_sincronizados_com_venda);
  if (naoSinc.length > 0) {
    out.push(`${naoSinc.length} SKU(s) com venda e sem estoque sincronizado: ${naoSinc.map((s) => str(s.sku)).join(", ")}.`);
  }
  const padrao = arr<string>(q.fornecedores_lead_time_padrao);
  if (padrao.length > 0) {
    out.push(`${padrao.length} fornecedores usam o prazo de entrega padrão (sem cadastro): ${padrao.map(nomeCurto).join(", ")}.`);
  }
  out.push("Cobertura negativa (estoque negativo no Tiny) aparece como 0 d.");
  return out;
}
