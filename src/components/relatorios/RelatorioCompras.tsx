import { useMemo, useRef, useState } from "react";

import {
  arr, brl, brlMil, dec1, Foto, intBR, Kpi, MONO, nomeCurto, Notas, num, numOuNull, obj, pctBR, Pill, Secao, str,
  useFotos, type RelatorioLista,
} from "./comum";
import { cn } from "@/lib/utils";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente de compras (resumo de compras_relatorio_diario()):
// resumo{ruptura, urgente, atencao, valor_estoque_total, valor_parado},
// por_fornecedor[], atencao[], excesso_sem_giro[] (top 10), qualidade{}.
// Desde 06/out: resumo.valor_excesso/valor_sem_giro/valor_parado_pct,
// excesso_sem_giro_todos[] (lista completa, valor desc) e
// por_fornecedor[].valor_parado. Relatórios antigos caem no top 10.
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
  const [forn, setForn] = useState<string | null>(null);
  const [fornParado, setFornParado] = useState("");
  const refParado = useRef<HTMLDivElement>(null);
  const temParado = porForn.some((f) => f.valor_parado != null);
  const [todos, setTodos] = useState(false);

  const filtrada = useMemo(
    () => (forn ? atencao.filter((a) => str(a.fornecedor) === forn) : atencao),
    [atencao, forn],
  );
  const visiveis = todos || forn ? filtrada : filtrada.slice(0, LIMITE);
  const fotos = useFotos(visiveis.map((a) => str(a.sku)));
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
                  {temParado && <th className="rl-th text-right">Parado</th>}
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
                      {temParado && (
                        <td className={`rl-td text-right whitespace-nowrap ${MONO}`}>
                          {num(f.valor_parado) > 0 ? (
                            <button type="button" title="Ver o excesso e sem giro deste fornecedor"
                              className="underline decoration-dotted underline-offset-2 hover:text-(--rl-accent-text) cursor-pointer"
                              onClick={(e) => {
                                e.stopPropagation();
                                setFornParado(nome);
                                refParado.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }}>
                              {brl(f.valor_parado)}
                            </button>
                          ) : <span className="text-(--rl-text-3)">—</span>}
                        </td>
                      )}
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

      <div ref={refParado} className="scroll-mt-4">
        <ExcessoSemGiro res={res} mobile={mobile} forn={fornParado} setForn={setFornParado} />
      </div>

      <Secao titulo="Qualidade dos dados">
        <Notas itens={notasCompras(obj(res.qualidade), rel.gerado_em)} />
      </Secao>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Excesso e sem giro: mini-cards (total/excesso/sem giro, clicáveis = filtro),
// busca + fornecedor, ordenação (valor/cobertura/estoque), top 10 com "Mostrar
// todos", total do rodapé (só soma da lista filtrada) e CSV. Relatório antigo
// (sem excesso_sem_giro_todos) mostra só o top 10, como antes.
// ---------------------------------------------------------------------------
type StatusParado = "excesso" | "sem_giro";
type ColParado = "valor" | "cobertura" | "estoque";
const TOP_PARADO = 10;
const ST_PARADO: Record<StatusParado, { label: string; cor: "amber" | "gray"; ponto: string }> = {
  excesso: { label: "Excesso", cor: "amber", ponto: "var(--rl-amber)" },
  sem_giro: { label: "Sem giro", cor: "gray", ponto: "var(--rl-text-3)" },
};
const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const textoCob = (x: unknown) => {
  const c = numOuNull(x);
  return c == null ? "sem venda" : c > 999 ? "999+ d" : `${Math.max(0, Math.round(c))} d`;
};
/** R$ com centavos (o total do rodapé confere com o resumo ao centavo). */
const brlCent = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function ExcessoSemGiro({ res, mobile, forn, setForn }: {
  res: Record<string, unknown>; mobile?: boolean; forn: string; setForn: (f: string) => void;
}) {
  const r = obj(res.resumo);
  const completo = Array.isArray(res.excesso_sem_giro_todos) && r.valor_excesso != null;
  const itens = useMemo(
    () => (completo ? arr(res.excesso_sem_giro_todos) : arr(res.excesso_sem_giro).slice(0, TOP_PARADO)),
    [completo, res.excesso_sem_giro_todos, res.excesso_sem_giro],
  );

  const [status, setStatus] = useState<StatusParado | null>(null);
  const [busca, setBusca] = useState("");
  const [ord, setOrd] = useState<{ col: ColParado; dir: 1 | -1 }>({ col: "valor", dir: -1 });
  const [aberto, setAberto] = useState(false);

  const fornecedores = useMemo(
    () => [...new Set(itens.map((e) => str(e.fornecedor)).filter(Boolean))].sort((a, b) => nomeCurto(a).localeCompare(nomeCurto(b))),
    [itens],
  );
  const filtrados = useMemo(() => {
    const termos = semAcento(busca).split(/\s+/).filter(Boolean);
    const val = (e: Record<string, unknown>) =>
      ord.col === "valor" ? num(e.valor_estoque)
        : ord.col === "estoque" ? num(e.estoque_total)
        : numOuNull(e.cobertura_total_dias) ?? Number.POSITIVE_INFINITY; // sem venda = cobertura infinita
    return itens
      .filter((e) => (!status || e.status === status) && (!forn || str(e.fornecedor) === forn)
        && termos.every((t) => semAcento(`${str(e.produto)} ${str(e.sku)}`).includes(t)))
      .sort((a, b) => {
        const va = val(a); const vb = val(b);
        return va === vb ? num(b.valor_estoque) - num(a.valor_estoque) : (va < vb ? -1 : 1) * ord.dir;
      });
  }, [itens, status, forn, busca, ord]);
  const visiveis = aberto ? filtrados : filtrados.slice(0, TOP_PARADO);
  const fotos = useFotos(visiveis.map((e) => str(e.sku)));
  // único somatório do front: a soma da lista já carregada e filtrada
  const totValor = filtrados.reduce((s, e) => s + num(e.valor_estoque), 0);
  const totEstoque = filtrados.reduce((s, e) => s + num(e.estoque_total), 0);
  const temFiltro = !!(status || forn || busca);

  const alternarOrd = (col: ColParado) => setOrd((o) => ({ col, dir: o.col === col ? (o.dir === -1 ? 1 : -1) : -1 }));
  const seta = (col: ColParado) => (ord.col === col ? (ord.dir === -1 ? " ↓" : " ↑") : "");

  function exportarCsv() {
    const cab = ["Produto", "SKU", "Fornecedor", "Status", "Estoque empresa", "Full", "Estoque total", "Venda/dia", "Cobertura (dias)", "Valor"];
    const n = (x: unknown, casas = 2) => { const v = numOuNull(x); return v == null ? "" : v.toFixed(casas).replace(".", ","); };
    const esc = (t: string) => (/[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    const linhas = filtrados.map((e) => [
      str(e.produto), str(e.sku), str(e.fornecedor), ST_PARADO[e.status as StatusParado]?.label ?? str(e.status),
      n(e.estoque_geral, 0), n(e.full_total, 0), n(e.estoque_total, 0), n(e.venda_dia), n(e.cobertura_total_dias, 0), n(e.valor_estoque),
    ].map((c) => esc(String(c))).join(";"));
    const blob = new Blob(["﻿" + [cab.join(";"), ...linhas].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `excesso-sem-giro${status ? `-${status}` : ""}${forn ? `-${nomeCurto(forn).toLowerCase().replace(/\s+/g, "-")}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const th = "text-[12px] font-medium text-(--rl-text-3) pb-2 border-b border-(--rl-border) whitespace-nowrap";
  const td = "py-[7px] border-b border-(--rl-border)";
  const thOrd = (col: ColParado, rotulo: string) => (
    <th className={`${th} text-right pl-3`}>
      {completo ? (
        <button type="button" onClick={() => alternarOrd(col)}
          className={cn("cursor-pointer hover:text-(--rl-text)", ord.col === col && "text-(--rl-text)")}>{rotulo}{seta(col)}</button>
      ) : rotulo}
    </th>
  );

  return (
    <Secao titulo="Excesso e sem giro"
      nota={completo ? undefined : `top ${itens.length} por valor · ${brl(itens.reduce((s, e) => s + num(e.valor_estoque), 0))}`}>
      {completo && (
        <div className={cn("grid gap-3 mb-3.5", mobile ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-3")}>
          <MiniParado titulo="Total parado" valor={r.valor_parado} skus={num(r.excesso) + num(r.sem_giro)}
            sub={`${pctBR(r.valor_parado_pct)} do estoque`} />
          <MiniParado titulo="Excesso" valor={r.valor_excesso} skus={r.excesso} sub="vende, mas com estoque demais"
            ponto={ST_PARADO.excesso.ponto} ativo={status === "excesso"}
            onClick={() => setStatus((x) => (x === "excesso" ? null : "excesso"))} />
          <MiniParado titulo="Sem giro" valor={r.valor_sem_giro} skus={r.sem_giro} sub="sem venda em 30 dias"
            ponto={ST_PARADO.sem_giro.ponto} ativo={status === "sem_giro"}
            onClick={() => setStatus((x) => (x === "sem_giro" ? null : "sem_giro"))} />
        </div>
      )}

      {itens.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nada parado.</div> : (
        <>
          {completo && (
            <div className="flex flex-wrap items-center gap-2 mb-2.5">
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto ou SKU"
                className="h-8 w-full sm:w-[220px] rounded-md border border-(--rl-border-strong) bg-(--rl-surface) px-2.5 text-[13px] text-(--rl-text) placeholder:text-(--rl-text-3)" />
              <select value={forn} onChange={(e) => setForn(e.target.value)}
                className="h-8 max-w-full sm:max-w-[240px] rounded-md border border-(--rl-border-strong) bg-(--rl-surface) px-2 text-[13px] text-(--rl-text)">
                <option value="">Todos os fornecedores</option>
                {fornecedores.map((f) => <option key={f} value={f}>{nomeCurto(f)}</option>)}
              </select>
              {status && <Pill cor={ST_PARADO[status].cor}>{ST_PARADO[status].label}</Pill>}
              {temFiltro && (
                <button type="button" onClick={() => { setStatus(null); setForn(""); setBusca(""); }}
                  className="text-[12.5px] text-(--rl-accent-text) hover:underline cursor-pointer">Limpar filtros</button>
              )}
              <div className="flex-1" />
              <span className="text-[12px] text-(--rl-text-3)">{filtrados.length} de {itens.length} SKUs</span>
              <button type="button" onClick={exportarCsv} disabled={filtrados.length === 0}
                className="h-8 flex items-center gap-1.5 text-[13px] font-medium rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) px-3 text-(--rl-text) cursor-pointer hover:bg-(--rl-surface-2) disabled:opacity-50">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 15V3" /><path d="m7 10 5 5 5-5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></svg>
                Exportar CSV
              </button>
            </div>
          )}

          {filtrados.length === 0 ? <div className="text-[13px] text-(--rl-text-3) py-3">Nenhum item com esses filtros.</div> : (
            <div className="overflow-x-auto">
              <table className={cn("w-full border-collapse text-[13px]", mobile ? "min-w-[560px]" : "min-w-[860px]")}>
                <thead>
                  <tr>
                    <th className={`${th} text-left`}>Produto</th>
                    <th className={`${th} text-left pl-3`}>Fornecedor</th>
                    {!mobile && <th className={`${th} text-left pl-3`}>Status</th>}
                    {thOrd("estoque", "Estoque")}
                    {!mobile && <th className={`${th} text-right pl-3`}>Venda/dia</th>}
                    {thOrd("cobertura", "Cobertura")}
                    {thOrd("valor", "Valor")}
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((e, i) => {
                    const sku = str(e.sku);
                    const st = ST_PARADO[e.status as StatusParado];
                    const full = num(e.full_total);
                    return (
                      <tr key={`${sku}-${i}`}>
                        <td className={`${td} pr-3`}>
                          <div className="flex items-center gap-2.5 min-w-[200px]" title={str(e.produto)}>
                            {mobile && st && <span aria-label={st.label} title={st.label} className="size-2 rounded-full shrink-0" style={{ background: st.ponto }} />}
                            <Foto src={fotos.get(sku)} size={36} />
                            <div className="min-w-0">
                              <div className="font-medium line-clamp-2">{produtoCurto(e.produto, 60)}</div>
                              <div className="font-mono text-[11.5px] text-(--rl-text-3)">{sku}</div>
                            </div>
                          </div>
                        </td>
                        <td className={`${td} pl-3 text-(--rl-text-2) whitespace-nowrap`} title={str(e.fornecedor)}>{nomeCurto(e.fornecedor)}</td>
                        {!mobile && <td className={`${td} pl-3`}>{st ? <Pill cor={st.cor}>{st.label}</Pill> : "—"}</td>}
                        <td className={`${td} pl-3 text-right whitespace-nowrap ${MONO}`}>
                          {e.estoque_geral != null ? (
                            <>
                              <div>{intBR(e.estoque_geral)} un</div>
                              {full > 0 && <div className="text-[11.5px] text-(--rl-text-3)">Full {intBR(full)}</div>}
                            </>
                          ) : `${intBR(e.estoque_total)} un`}
                        </td>
                        {!mobile && <td className={`${td} pl-3 text-right whitespace-nowrap ${MONO}`}>{num(e.venda_dia) > 0 ? dec1(e.venda_dia) : "—"}</td>}
                        <td className={`${td} pl-3 text-right whitespace-nowrap text-(--rl-text-2) ${MONO}`}>{textoCob(e.cobertura_total_dias)}</td>
                        <td className={`${td} pl-3 text-right whitespace-nowrap ${MONO}`}>{brl(e.valor_estoque)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {completo && (
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="pt-2 pr-3 text-[12.5px]" colSpan={mobile ? 2 : 3}>
                        Total{temFiltro ? " filtrado" : ""} · {intBR(filtrados.length)} SKUs
                      </td>
                      <td className={`pt-2 pl-3 text-right whitespace-nowrap ${MONO}`}>{intBR(totEstoque)} un</td>
                      {!mobile && <td />}
                      <td />
                      <td className={`pt-2 pl-3 text-right whitespace-nowrap ${MONO}`}>{brlCent(totValor)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {completo && filtrados.length > TOP_PARADO && (
            <button type="button" onClick={() => setAberto((a) => !a)}
              className="mt-2 text-[13px] font-medium text-(--rl-accent-text) hover:underline cursor-pointer">
              {aberto ? "Mostrar menos" : `Mostrar todos (${filtrados.length})`}
            </button>
          )}
        </>
      )}
    </Secao>
  );
}

function MiniParado({ titulo, valor, skus, sub, ponto, ativo, onClick }: {
  titulo: string; valor: unknown; skus: unknown; sub: string; ponto?: string; ativo?: boolean; onClick?: () => void;
}) {
  const corpo = (
    <>
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-(--rl-text-3)">
        {ponto && <span className="size-2 rounded-full" style={{ background: ponto }} aria-hidden />}
        {titulo}
        {ativo && <span className="ml-auto text-[11px] text-(--rl-accent-text)">filtrando · clique para limpar</span>}
      </span>
      <span className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[20px] font-semibold tracking-[-0.01em] text-(--rl-text)">{brlCent(num(valor))}</span>
        <span className="text-[12.5px] text-(--rl-text-2)">{intBR(skus)} SKUs</span>
      </span>
      <span className="text-[12px] text-(--rl-text-3)">{sub}</span>
    </>
  );
  const cls = "border rounded-lg px-4 py-3 flex flex-col gap-1 min-w-0 text-left";
  if (!onClick) return <div className={cn(cls, "border-(--rl-border)")}>{corpo}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={ativo}
      className={cn(cls, "cursor-pointer hover:bg-(--rl-surface-2)", ativo ? "border-(--rl-accent) bg-(--rl-accent-soft)" : "border-(--rl-border)")}>
      {corpo}
    </button>
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
