import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  arr, Bloco, brl, ddmm, KpiBox, num, numOuNull, obj, Selo, type RelatorioLista,
} from "./comum";

// ============================================================================
// Card aberto do agente financeiro (resumo de financeiro_relatorio_diario()).
// Só exibe o que vem no JSON; as únicas contas aqui são de apresentação
// (somar faixas já prontas, proporção das barras, total da tabela exibida).
// ============================================================================

interface Urgente {
  tiny_id?: number; fornecedor?: string | null; descricao?: string | null; categoria?: string | null;
  valor?: number; vencimento?: string | null; dias?: number | null; faixa?: string | null;
}
const FAIXA: Record<string, { label: string; cor: "red" | "orange" | "amber" }> = {
  atrasado: { label: "Atrasado", cor: "red" },
  hoje: { label: "Hoje", cor: "orange" },
  ate_7d: { label: "Até 7 dias", cor: "amber" },
};

/** Soma das faixas que vencem até 7 dias (atrasado + hoje + até 7 d) — usado no card fechado também. */
export function venceEm7d(resumo: Record<string, unknown> | null): { valor: number; atrasadoQtd: number } {
  const cp = obj(resumo?.contas_pagar_resumo);
  return {
    valor: num(obj(cp.atrasado).valor) + num(obj(cp.hoje).valor) + num(obj(cp.ate_7d).valor),
    atrasadoQtd: num(obj(cp.atrasado).qtd),
  };
}

function diasTxt(d: number | null | undefined): string {
  if (d == null) return "—";
  if (d < 0) return `há ${formatNumber(-d)} ${-d === 1 ? "dia" : "dias"}`;
  if (d === 0) return "hoje";
  return `em ${formatNumber(d)} ${d === 1 ? "dia" : "dias"}`;
}

function horasDesde(iso: unknown, ref: string | null): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = new Date(iso).getTime();
  const r = ref ? new Date(ref).getTime() : Date.now();
  if (!Number.isFinite(t) || !Number.isFinite(r)) return null;
  return (r - t) / 3_600_000;
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
function rotuloMes(m: unknown): string {
  if (typeof m !== "string" || !/^\d{4}-\d{2}/.test(m)) return "—";
  const [a, mm] = m.split("-");
  return `${MESES[Number(mm) - 1]}/${a}`;
}
function diasNoMes(m: string): number {
  const [a, mm] = m.split("-").map(Number);
  return new Date(Date.UTC(a, mm, 0)).getUTCDate();
}

export function RelatorioFinanceiro({ rel }: { rel: RelatorioLista }) {
  const r = rel.resumo ?? {};
  const tot = obj(r.carteira_total);
  const cp = obj(r.contas_pagar_resumo);
  const fluxo = obj(r.fluxo_resumo);
  const v7 = venceEm7d(r);
  const qtd7 = num(obj(cp.atrasado).qtd) + num(obj(cp.hoje).qtd) + num(obj(cp.ate_7d).qtd);
  const pior = numOuNull(fluxo.pior_acumulado);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-5">
        {/* 1. KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <KpiBox titulo="Saldo em conta" valor={brl(tot.saldo_em_conta)} />
          <KpiBox titulo="A receber" valor={brl(tot.a_receber)} sub="Shopee é estimativa" />
          <KpiBox titulo="Atrasado + 7 dias" valor={brl(v7.valor)}
            sub={`${formatNumber(qtd7)} conta(s)${v7.atrasadoQtd > 0 ? ` · ${formatNumber(v7.atrasadoQtd)} atrasada(s)` : ""}`}
            tom={v7.atrasadoQtd > 0 ? "red" : undefined} />
          <KpiBox titulo="Pior saldo projetado 30d" valor={brl(pior)}
            sub={fluxo.dia_pior_acumulado ? `em ${ddmm(String(fluxo.dia_pior_acumulado))}` : null}
            tom={pior != null && pior < 0 ? "red" : undefined}
            extra={
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" aria-label="Como é calculado" className="text-muted-foreground hover:text-foreground">
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  Pessimista: Shopee não entra no dia a dia por não ter data de liberação.
                </TooltipContent>
              </Tooltip>
            } />
        </div>

        {/* 2. Carteiras */}
        <Carteiras itens={arr(r.carteira)} />

        {/* 3. Precisa pagar */}
        <PrecisaPagar itens={arr<Urgente>(r.contas_pagar_urgentes)} />

        {/* 4. Próximos 30 dias */}
        <Proximos30 cp={cp} categorias={arr(r.contas_pagar_por_categoria_30d)} />

        {/* 5. DRE */}
        <Dre atual={obj(r.dre_mes_atual)} anterior={obj(r.dre_mes_anterior)} dataRef={rel.data_referencia} />

        {/* 6. Qualidade dos dados */}
        <Qualidade q={obj(r.qualidade)} geradoEm={rel.gerado_em} />
      </div>
    </TooltipProvider>
  );
}

function Carteiras({ itens }: { itens: Record<string, unknown>[] }) {
  if (itens.length === 0) return null;
  return (
    <Bloco titulo="Carteiras">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
        {itens.map((c, i) => {
          const real = String(c.natureza ?? "").toLowerCase().startsWith("real");
          const semSaldo = c.saldo_em == null;
          return (
            <div key={`${String(c.carteira)}-${i}`} className="rounded-lg border bg-card px-3.5 py-3 flex flex-col gap-1.5 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold truncate">{String(c.carteira ?? "—")}</span>
                <Selo cor={real ? "green" : "amber"} title={String(c.natureza ?? "")}>{real ? "real" : "estimativa"}</Selo>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex flex-col">
                  <span className="text-muted-foreground">Saldo em conta</span>
                  <span className="font-mono tabular-nums font-semibold">
                    {semSaldo ? <span className="text-muted-foreground" title="Sem leitura de saldo desta carteira">n/d</span> : brl(c.saldo_em_conta)}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-muted-foreground">A receber</span>
                  <span className="font-mono tabular-nums font-semibold">{brl(c.a_receber)}</span>
                </div>
              </div>
              {c.pedidos_a_receber != null && (
                <span className="text-[11px] text-muted-foreground">{formatNumber(num(c.pedidos_a_receber))} pedidos a receber</span>
              )}
            </div>
          );
        })}
      </div>
    </Bloco>
  );
}

type Ordem = { campo: "vencimento" | "valor"; dir: "asc" | "desc" };

function PrecisaPagar({ itens }: { itens: Urgente[] }) {
  const [ordem, setOrdem] = useState<Ordem>({ campo: "vencimento", dir: "asc" });
  const linhas = useMemo(() => {
    const l = [...itens];
    l.sort((a, b) => {
      const va = ordem.campo === "valor" ? num(a.valor) : String(a.vencimento ?? "");
      const vb = ordem.campo === "valor" ? num(b.valor) : String(b.vencimento ?? "");
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return ordem.dir === "asc" ? c : -c;
    });
    return l;
  }, [itens, ordem]);
  const total = itens.reduce((s, u) => s + num(u.valor), 0);

  function alternar(campo: Ordem["campo"]) {
    setOrdem((o) => (o.campo === campo ? { campo, dir: o.dir === "asc" ? "desc" : "asc" } : { campo, dir: campo === "valor" ? "desc" : "asc" }));
  }
  const Seta = ({ campo }: { campo: Ordem["campo"] }) =>
    ordem.campo !== campo ? <ArrowUpDown className="h-3 w-3 opacity-50" />
      : ordem.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  return (
    <Bloco titulo={`Precisa pagar (${formatNumber(itens.length)})`}>
      {itens.length === 0 ? (
        <div className="text-sm text-muted-foreground rounded-lg border px-3 py-3">Nada atrasado nem vencendo em 7 dias.</div>
      ) : (
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-sm min-w-[660px]">
            <thead>
              <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                <th className="py-2 px-3 font-semibold">
                  <button type="button" onClick={() => alternar("vencimento")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Vencimento <Seta campo="vencimento" />
                  </button>
                </th>
                <th className="py-2 px-3 font-semibold">Dias</th>
                <th className="py-2 px-3 font-semibold">Fornecedor</th>
                <th className="py-2 px-3 font-semibold">Descrição</th>
                <th className="py-2 px-3 font-semibold">Categoria</th>
                <th className="py-2 px-3 font-semibold text-right">
                  <button type="button" onClick={() => alternar("valor")} className="inline-flex items-center gap-1 hover:text-foreground">
                    Valor <Seta campo="valor" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((u, i) => {
                const f = FAIXA[u.faixa ?? ""];
                const d = u.dias == null ? null : num(u.dias);
                return (
                  <tr key={`${u.tiny_id ?? "x"}-${i}`} className="border-b last:border-0 align-top">
                    <td className="py-1.5 px-3 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        {ddmm(u.vencimento)}
                        {f && <Selo cor={f.cor}>{f.label}</Selo>}
                      </span>
                    </td>
                    <td className={cn("py-1.5 px-3 whitespace-nowrap tabular-nums", d != null && d < 0 && "text-red-700 dark:text-red-400 font-semibold")}>{diasTxt(d)}</td>
                    <td className="py-1.5 px-3 max-w-[200px] truncate" title={u.fornecedor ?? ""}>{u.fornecedor ?? "—"}</td>
                    <td className="py-1.5 px-3 max-w-[200px] truncate text-muted-foreground" title={u.descricao ?? ""}>{u.descricao ?? "—"}</td>
                    <td className="py-1.5 px-3 whitespace-nowrap text-muted-foreground">{u.categoria ?? "—"}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">{brl(u.valor)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/40 font-semibold">
                <td className="py-2 px-3" colSpan={5}>Total</td>
                <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">{brl(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Bloco>
  );
}

function Proximos30({ cp, categorias }: { cp: Record<string, unknown>; categorias: Record<string, unknown>[] }) {
  const faixas = [
    { k: "atrasado", label: "Atrasado", cor: "bg-red-500" },
    { k: "hoje", label: "Hoje", cor: "bg-orange-500" },
    { k: "ate_7d", label: "Até 7 dias", cor: "bg-amber-400" },
    { k: "ate_15d", label: "8 a 15 dias", cor: "bg-sky-500" },
    { k: "ate_30d", label: "16 a 30 dias", cor: "bg-slate-400" },
  ].map((f) => ({ ...f, qtd: num(obj(cp[f.k]).qtd), valor: num(obj(cp[f.k]).valor) }))
    .filter((f) => f.k !== "hoje" || f.valor > 0);
  const totalBarra = faixas.reduce((s, f) => s + f.valor, 0);
  const maxCat = Math.max(0, ...categorias.map((c) => num(c.valor)));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Bloco titulo="Próximos 30 dias">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img"
          aria-label={faixas.map((f) => `${f.label}: ${brl(f.valor)}`).join("; ")}>
          {totalBarra > 0 && faixas.map((f) => f.valor > 0 && (
            <div key={f.k} className={cn("h-full", f.cor)} style={{ width: `${(f.valor / totalBarra) * 100}%` }} title={`${f.label}: ${brl(f.valor)}`} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {faixas.map((f) => (
            <div key={f.k} className="flex items-center gap-2 min-w-0">
              <span className={cn("h-2.5 w-2.5 rounded-sm shrink-0", f.cor)} />
              <span className="text-muted-foreground truncate">{f.label}</span>
              <span className="ml-auto font-mono tabular-nums whitespace-nowrap">
                {brl(f.valor)} <span className="text-muted-foreground">· {formatNumber(f.qtd)}</span>
              </span>
            </div>
          ))}
        </div>
      </Bloco>
      <Bloco titulo="Por categoria (30 dias)">
        {categorias.length === 0 ? (
          <span className="text-sm text-muted-foreground">Sem contas nos próximos 30 dias.</span>
        ) : (
          <div className="flex flex-col gap-2">
            {categorias.map((c, i) => (
              <div key={`${String(c.categoria)}-${i}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{String(c.categoria ?? "—")} <span className="text-muted-foreground">· {formatNumber(num(c.qtd))}</span></span>
                  <span className="font-mono tabular-nums whitespace-nowrap">{brl(c.valor)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${maxCat > 0 ? (num(c.valor) / maxCat) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Bloco>
    </div>
  );
}

function Dre({ atual, anterior, dataRef }: { atual: Record<string, unknown>; anterior: Record<string, unknown>; dataRef: string }) {
  if (Object.keys(atual).length === 0 && Object.keys(anterior).length === 0) return null;
  const mesAtual = typeof atual.mes === "string" ? atual.mes : null;
  const parcial = mesAtual && dataRef.slice(0, 7) === mesAtual && Number(dataRef.slice(8, 10)) < diasNoMes(mesAtual)
    ? Number(dataRef.slice(8, 10)) : null;

  const pct = (m: unknown, r: unknown) => {
    const rv = num(r);
    return rv ? `${((num(m) / rv) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : null;
  };
  const linhas: { label: string; k: string; pct?: (d: Record<string, unknown>) => string | null; lucro?: boolean }[] = [
    { label: "Receita líquida", k: "receita_liquida" },
    { label: "Margem de contribuição", k: "margem_contribuicao", pct: (d) => pct(d.margem_contribuicao, d.receita_liquida) },
    { label: "ADS", k: "ads" },
    { label: "Despesas fixas", k: "custo_fixo_sem_ads" },
    {
      label: "Lucro líquido", k: "lucro_liquido", lucro: true,
      pct: (d) => (d.margem_liquida_pct == null ? null : `${num(d.margem_liquida_pct).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`),
    },
  ];
  const Celula = ({ d, l }: { d: Record<string, unknown>; l: (typeof linhas)[number] }) => {
    const v = numOuNull(d[l.k]);
    const p = l.pct?.(d);
    return (
      <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums whitespace-nowrap",
        l.lucro && v != null && v < 0 && "text-red-700 dark:text-red-400 font-semibold",
        l.lucro && "font-semibold")}>
        {v == null ? "—" : brl(v)}
        {p && <span className="ml-1.5 text-[11px] text-muted-foreground">{p}</span>}
      </td>
    );
  };
  return (
    <Bloco titulo="DRE">
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-sm min-w-[460px]">
          <thead>
            <tr className="text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
              <th className="py-2 px-3 text-left font-semibold" />
              <th className="py-2 px-3 text-right font-semibold">
                <span className="inline-flex items-center gap-1.5 justify-end">
                  {rotuloMes(atual.mes)}
                  {parcial != null && <Selo cor="amber">parcial · {parcial} {parcial === 1 ? "dia" : "dias"}</Selo>}
                </span>
              </th>
              <th className="py-2 px-3 text-right font-semibold">{rotuloMes(anterior.mes)}</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.k} className={cn("border-b last:border-0", l.lucro && "bg-muted/20")}>
                <td className={cn("py-1.5 px-3", l.lucro && "font-semibold")}>{l.label}</td>
                <Celula d={atual} l={l} />
                <Celula d={anterior} l={l} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Bloco>
  );
}

function Qualidade({ q, geradoEm }: { q: Record<string, unknown>; geradoEm: string | null }) {
  const aClassificar = arr(q.contas_a_classificar);
  const duplicadas = arr(q.possiveis_duplicadas);
  const semVenc = num(q.contas_sem_vencimento);
  const hCp = horasDesde(q.contas_pagar_atualizado_em, geradoEm);
  const hShopee = horasDesde(q.carteira_shopee_atualizada_em, geradoEm);
  const avisos: React.ReactNode[] = [];
  if (hCp != null && hCp > 24) avisos.push(`Contas a pagar sem atualizar há ${Math.floor(hCp)} h quando o relatório foi gerado.`);
  if (hShopee != null && hShopee > 6) avisos.push(`Saldo da carteira Shopee sem atualizar há ${Math.floor(hShopee)} h quando o relatório foi gerado.`);
  if (semVenc > 0) avisos.push(`${formatNumber(semVenc)} conta(s) em aberto sem data de vencimento.`);
  if (aClassificar.length === 0 && duplicadas.length === 0 && avisos.length === 0) return null;

  return (
    <Bloco titulo="Qualidade dos dados">
      <div className="rounded-lg border border-amber-300/60 dark:border-amber-900/60 bg-amber-500/5 px-3 py-2.5 flex flex-col gap-2 text-xs">
        {avisos.map((a, i) => (
          <div key={i} className="flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" /> <span>{a}</span>
          </div>
        ))}
        {aClassificar.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-semibold">Contas a classificar ({aClassificar.length})</span>
            {aClassificar.map((c, i) => (
              <div key={i} className="flex justify-between gap-3 text-muted-foreground">
                <span className="truncate">{String(c.fornecedor ?? "—")} · vence {ddmm(String(c.vencimento ?? ""))}</span>
                <span className="font-mono tabular-nums whitespace-nowrap">{brl(c.valor)}</span>
              </div>
            ))}
          </div>
        )}
        {duplicadas.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="font-semibold">Possíveis duplicadas ({duplicadas.length})</span>
            {duplicadas.map((c, i) => (
              <div key={i} className="flex justify-between gap-3 text-muted-foreground">
                <span className="truncate">{String(c.fornecedor ?? "—")} · vence {ddmm(String(c.vencimento ?? ""))} · {formatNumber(num(c.qtd))}×</span>
                <span className="font-mono tabular-nums whitespace-nowrap">{brl(c.valor)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Bloco>
  );
}
