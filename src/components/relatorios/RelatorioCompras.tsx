import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";

import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { arr, Bloco, brl, KpiBox, num, numOuNull, obj, Selo, type RelatorioLista } from "./comum";

// ============================================================================
// Card aberto do agente de compras (resumo de compras_relatorio_diario()):
// resumo{ruptura, urgente, atencao, valor_estoque_total, valor_parado},
// por_fornecedor[], atencao[], excesso_sem_giro[], qualidade{}.
// ============================================================================

const STATUS: Record<string, { label: string; cor: "red" | "orange" | "amber" | "gray" }> = {
  ruptura_empresa: { label: "ruptura", cor: "red" },
  comprar_urgente: { label: "urgente", cor: "orange" },
  atencao: { label: "atenção", cor: "amber" },
  excesso: { label: "excesso", cor: "gray" },
  sem_giro: { label: "sem giro", cor: "gray" },
};
function SeloStatus({ s }: { s: unknown }) {
  const st = STATUS[String(s ?? "")] ?? { label: String(s ?? "—"), cor: "gray" as const };
  return <Selo cor={st.cor}>{st.label}</Selo>;
}
const dias = (x: unknown) => {
  const v = numOuNull(x);
  return v == null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} d`;
};
const qtd = (x: unknown) => {
  const v = numOuNull(x);
  return v == null ? "—" : formatNumber(v);
};

/** Mini-KPIs do card fechado. */
export function resumoCompras(resumo: Record<string, unknown> | null) {
  const r = obj(resumo?.resumo);
  return { ruptura: num(r.ruptura), urgente: num(r.urgente), valorParado: numOuNull(r.valor_parado) };
}

export function RelatorioCompras({ rel }: { rel: RelatorioLista }) {
  const res = rel.resumo ?? {};
  const r = obj(res.resumo);
  const porForn = arr(res.por_fornecedor);
  const atencao = arr(res.atencao);
  const excesso = arr(res.excesso_sem_giro).slice(0, 10);
  const q = obj(res.qualidade);
  const [forn, setForn] = useState<string | null>(null);
  const atencaoFiltrada = forn ? atencao.filter((a) => String(a.fornecedor ?? "") === forn) : atencao;

  return (
    <div className="flex flex-col gap-5">
      {/* 1. KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
        <KpiBox titulo="Ruptura" valor={qtd(r.ruptura)} tom={num(r.ruptura) > 0 ? "red" : undefined} sub="SKUs" />
        <KpiBox titulo="Urgente" valor={qtd(r.urgente)} tom={num(r.urgente) > 0 ? "amber" : undefined} sub="SKUs" />
        <KpiBox titulo="Atenção" valor={qtd(r.atencao)} sub="SKUs" />
        <KpiBox titulo="Valor em estoque" valor={brl(r.valor_estoque_total)} />
        <KpiBox titulo="Valor parado" valor={brl(r.valor_parado)} sub="excesso e sem giro" />
      </div>

      {/* 2. Por fornecedor */}
      {porForn.length > 0 && (
        <Bloco titulo="Por fornecedor" direita={forn && (
          <button type="button" onClick={() => setForn(null)} className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" /> limpar filtro ({forn})
          </button>
        )}>
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                  <th className="py-2 px-3 font-semibold">Fornecedor</th>
                  <th className="py-2 px-3 font-semibold text-right">SKUs</th>
                  <th className="py-2 px-3 font-semibold text-right">Ruptura</th>
                  <th className="py-2 px-3 font-semibold text-right">Urgente</th>
                  <th className="py-2 px-3 font-semibold text-right">Atenção</th>
                  <th className="py-2 px-3 font-semibold text-right">Valor em estoque</th>
                  <th className="py-2 px-3 font-semibold text-right">Menor cobertura</th>
                </tr>
              </thead>
              <tbody>
                {porForn.map((f, i) => {
                  const nome = String(f.fornecedor ?? "—");
                  const ativo = forn === nome;
                  const valor = num(f.valor_estoque);
                  const cob = numOuNull(f.menor_cobertura_dias);
                  return (
                    <tr key={`${nome}-${i}`} tabIndex={0}
                      onClick={() => setForn(ativo ? null : nome)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setForn(ativo ? null : nome); } }}
                      className={cn("border-b last:border-0 cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/60", ativo && "bg-primary/10")}>
                      <td className="py-1.5 px-3 font-medium">{nome}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{qtd(f.skus)}</td>
                      <td className={cn("py-1.5 px-3 text-right tabular-nums", num(f.ruptura) > 0 && "text-red-700 dark:text-red-400 font-semibold")}>{qtd(f.ruptura)}</td>
                      <td className={cn("py-1.5 px-3 text-right tabular-nums", num(f.urgente) > 0 && "text-orange-700 dark:text-orange-400 font-semibold")}>{qtd(f.urgente)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{qtd(f.atencao)}</td>
                      <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums whitespace-nowrap", valor < 0 && "text-muted-foreground")}
                        title={valor < 0 ? "saldo negativo no Tiny" : undefined}>{brl(f.valor_estoque)}</td>
                      <td className="py-1.5 px-3 text-right whitespace-nowrap">
                        {cob != null && cob <= 0 ? <Selo cor="red">ruptura</Selo> : dias(cob)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Bloco>
      )}

      {/* 3. Atenção */}
      <Bloco titulo={`Ruptura, urgente e atenção (${formatNumber(atencaoFiltrada.length)}${forn ? ` · ${forn}` : ""})`}>
        {atencaoFiltrada.length === 0 ? (
          <span className="text-sm text-muted-foreground">Nenhum SKU nesta situação.</span>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm min-w-[1100px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                  <th className="py-2 px-3 font-semibold">Fornecedor</th>
                  <th className="py-2 px-3 font-semibold">SKU</th>
                  <th className="py-2 px-3 font-semibold">Produto</th>
                  <th className="py-2 px-3 font-semibold">Status</th>
                  <th className="py-2 px-3 font-semibold text-right">Venda/dia</th>
                  <th className="py-2 px-3 font-semibold text-right">Geral</th>
                  <th className="py-2 px-3 font-semibold text-right">Full A</th>
                  <th className="py-2 px-3 font-semibold text-right">Full ML</th>
                  <th className="py-2 px-3 font-semibold text-right">Full S</th>
                  <th className="py-2 px-3 font-semibold text-right">Trânsito</th>
                  <th className="py-2 px-3 font-semibold text-right">OC aguardando</th>
                  <th className="py-2 px-3 font-semibold text-right">Cobertura</th>
                  <th className="py-2 px-3 font-semibold text-right">Com OC</th>
                </tr>
              </thead>
              <tbody>
                {atencaoFiltrada.map((a, i) => (
                  <tr key={`${String(a.sku)}-${i}`} className="border-b last:border-0">
                    <td className="py-1.5 px-3 whitespace-nowrap">{String(a.fornecedor ?? "—")}</td>
                    <td className="py-1.5 px-3 font-mono whitespace-nowrap">{String(a.sku ?? "—")}</td>
                    <td className="py-1.5 px-3 max-w-[280px] truncate" title={String(a.produto ?? "")}>{String(a.produto ?? "—")}</td>
                    <td className="py-1.5 px-3"><SeloStatus s={a.status} /></td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{numOuNull(a.venda_dia)?.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) ?? "—"}</td>
                    <td className={cn("py-1.5 px-3 text-right tabular-nums", num(a.estoque_geral) < 0 && "text-muted-foreground")}>{qtd(a.estoque_geral)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(a.full_amazon)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(a.full_ml)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(a.full_shopee)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(a.full_em_transito)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(a.oc_aguardando)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{dias(a.cobertura_total_dias)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap font-semibold">{dias(a.cobertura_com_oc_dias)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>

      {/* 4. Excesso e sem giro */}
      {excesso.length > 0 && (
        <Bloco titulo="Excesso e sem giro (top 10 por valor)">
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                  <th className="py-2 px-3 font-semibold">Fornecedor</th>
                  <th className="py-2 px-3 font-semibold">Produto</th>
                  <th className="py-2 px-3 font-semibold">Status</th>
                  <th className="py-2 px-3 font-semibold text-right">Estoque</th>
                  <th className="py-2 px-3 font-semibold text-right">Cobertura</th>
                  <th className="py-2 px-3 font-semibold text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {excesso.map((e, i) => (
                  <tr key={`${String(e.sku)}-${i}`} className="border-b last:border-0">
                    <td className="py-1.5 px-3 whitespace-nowrap">{String(e.fornecedor ?? "—")}</td>
                    <td className="py-1.5 px-3 max-w-[300px] truncate" title={String(e.produto ?? "")}>
                      <span className="font-mono text-muted-foreground mr-1.5">{String(e.sku ?? "")}</span>{String(e.produto ?? "—")}
                    </td>
                    <td className="py-1.5 px-3"><SeloStatus s={e.status} /></td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{qtd(e.estoque_total)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums whitespace-nowrap">{dias(e.cobertura_total_dias)}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">{brl(e.valor_estoque)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Bloco>
      )}

      {/* 5. Qualidade */}
      <QualidadeCompras q={q} geradoEm={rel.gerado_em} />
    </div>
  );
}

function QualidadeCompras({ q, geradoEm }: { q: Record<string, unknown>; geradoEm: string | null }) {
  const ref = geradoEm ? new Date(geradoEm).getTime() : Date.now();
  const horas = (x: unknown) => (typeof x === "string" && x ? (ref - new Date(x).getTime()) / 3_600_000 : null);
  const hEst = horas(q.estoque_atualizado_em);
  const hFull = horas(q.full_atualizado_em);
  const naoSinc = arr(q.nao_sincronizados_com_venda);
  const prazoPadrao = arr<string>(q.fornecedores_lead_time_padrao);
  const avisos: string[] = [];
  if (hEst != null && hEst > 24) avisos.push(`Estoque do Tiny sem atualizar há ${Math.floor(hEst)} h quando o relatório foi gerado.`);
  if (hFull != null && hFull > 24) avisos.push(`Estoque do Full sem atualizar há ${Math.floor(hFull)} h quando o relatório foi gerado.`);
  if (avisos.length === 0 && naoSinc.length === 0 && prazoPadrao.length === 0) return null;
  return (
    <Bloco titulo="Qualidade dos dados">
      <div className="rounded-lg border border-amber-300/60 dark:border-amber-900/60 bg-amber-500/5 px-3 py-2.5 flex flex-col gap-2 text-xs">
        {avisos.map((a, i) => (
          <div key={i} className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> <span>{a}</span>
          </div>
        ))}
        {naoSinc.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-semibold">SKUs com venda sem estoque sincronizado ({naoSinc.length})</span>
            {naoSinc.map((s, i) => (
              <div key={i} className="flex justify-between gap-3 text-muted-foreground">
                <span className="truncate"><span className="font-mono">{String(s.sku ?? "")}</span> · {String(s.produto ?? "—")}</span>
                <span className="tabular-nums whitespace-nowrap">{qtd(s.venda_30d)} vendidas em 30 d</span>
              </div>
            ))}
          </div>
        )}
        {prazoPadrao.length > 0 && (
          <div className="text-muted-foreground">
            <span className="font-semibold text-foreground">Fornecedores com prazo de entrega padrão (sem cadastro): </span>
            {prazoPadrao.join(", ")}
          </div>
        )}
      </div>
    </Bloco>
  );
}
