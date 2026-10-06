import { useState } from "react";

import {
  arr, brl, brlMil, ddmm, Foto, IconeRelogio, MONO, Notas, num, numOuNull, obj, Pill, Secao, str,
  useFotos, type RelatorioLista,
} from "./comum";
import { produtoCurto } from "./RelatorioCompras";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente de ADS (resumo = ads_relatorio_diario(), versao 'v1'):
// resumo_lojas[], alertas[] (com causas), margem{prejuizo, apertado, folgado},
// tendencias{subindo, caindo, organico_sem_ads, ctr_alto_orcamento_limitado},
// sugestoes[], qualidade{}. Layout "DetalheAds" do design. Só leitura —
// nenhuma ação em campanha. O registro v0 (05/10) só tem a versão completa.
// ============================================================================

const MKT: Record<string, string> = { shopee: "Shopee", mercadolivre: "Mercado Livre" };
const EMP: Record<string, string> = { "ACZ Pet": "Ottz", "SVL Store": "SVL" };
const roas = (x: unknown) => {
  const v = numOuNull(x);
  return v == null ? "—" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};
const pct = (x: unknown, casas = 1) => {
  const v = numOuNull(x);
  return v == null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: casas })}%`;
};
/** "Shopee Ottz" / "Shopee SVL" / "Mercado Livre" (ML SVL vira "Mercado Livre SVL"). */
export function nomeLoja(mk: unknown, emp: unknown): string {
  const m = str(mk);
  const e = EMP[str(emp)] ?? str(emp);
  if (m === "mercadolivre") return e && e !== "Ottz" ? `Mercado Livre ${e}` : "Mercado Livre";
  return `${MKT[m] ?? m}${e ? ` ${e}` : ""}`;
}

export const adsV0 = (rel: RelatorioLista) => str(rel.resumo?.versao).startsWith("v0");

/** Aviso "dado de ontem ainda não chegou" (Shopee entra ~03:30). */
export function adsPendente(rel: RelatorioLista): string | null {
  const res = rel.resumo ?? {};
  const aviso = obj(obj(res.qualidade).dado_de_ontem).aviso;
  if (aviso) return str(aviso);
  const faltando = arr(res.resumo_lojas).filter((l) => l.dado_de_ontem === false);
  if (faltando.length === 0) return null;
  const nomes = [...new Set(faltando.map((l) => MKT[str(l.marketplace)] ?? str(l.marketplace)))];
  return `ADS ${nomes.includes("Shopee") ? "da Shopee" : `do ${nomes.join(" e ")}`} de ontem ainda não chegou${nomes.includes("Shopee") ? " (~03:30)" : ""}.`;
}

export function miniAds(rel: RelatorioLista): MiniKpi[] {
  if (adsV0(rel)) return [];
  const res = rel.resumo ?? {};
  const lojas = arr(res.resumo_lojas);
  const g = lojas.reduce((s, l) => s + num(l.gasto_ontem), 0);
  const v = lojas.reduce((s, l) => s + num(l.vendas_ontem), 0);
  const total = num(res.alertas_total ?? arr(res.alertas).length);
  const alta = num(res.alertas_alta);
  return [
    { label: "Gasto ontem", valor: lojas.length ? brl(g) : "—" },
    { label: "ROAS ontem", valor: g > 0 ? roas(v / g) : "—" },
    { label: "Alertas", valor: alta > 0 ? `${total} · ${alta} altos` : String(total), risco: alta > 0 },
  ];
}

const ACAO: Record<string, string> = {
  pausar: "Pausar", reduzir_orcamento: "Reduzir orçamento", aumentar_orcamento: "Aumentar orçamento",
  revisar_lance: "Revisar lance", repor_variacao: "Repor estoque", renovar_promocao: "Renovar promoção",
  revisar_preco: "Revisar preço", criar_campanha: "Criar campanha", verificar: "Verificar",
};

/** "Pede decisão": sugestões de prioridade 1 com maior impacto. */
export function decisoesAds(rel: RelatorioLista): Decisao[] {
  if (adsV0(rel)) return [];
  const sug = arr(rel.resumo?.sugestoes)
    .sort((a, b) => num(a.prioridade) - num(b.prioridade) || num(b.impacto_estimado_rs) - num(a.impacto_estimado_rs));
  const vistos = new Set<string>();
  const out: Decisao[] = [];
  for (const s of sug) {
    const chave = `${str(s.anuncio_id)}|${str(s.tipo)}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push({
      tom: num(s.prioridade) <= 1 ? "red" : "amber",
      oQue: `${produtoCurto(s.anuncio ?? s.sku, 34)} (${nomeLoja(s.marketplace, s.empresa)}):`,
      detalhe: `${(ACAO[str(s.tipo)] ?? str(s.tipo)).toLowerCase()}${numOuNull(s.impacto_estimado_rs) != null ? `, ${brlMil(s.impacto_estimado_rs)}/mês` : ""}`,
      sku: str(s.sku),
    });
    if (out.length === 3) break;
  }
  return out;
}

const METRICA: Record<string, string> = {
  impressoes: "impressões", ctr: "CTR", conversao: "conversão", vendas: "vendas", gasto: "gasto", roas: "ROAS",
  gasto_7d: "gasto na semana", vendas_7d: "vendas na semana", impressoes_7d: "impressões na semana",
};
const TIPO_ALERTA: Record<string, string> = {
  queda_impressoes: "Queda de impressões", queda_ctr: "Queda de CTR", queda_conversao: "Queda de conversão",
  queda_vendas: "Queda de vendas", gasto_sem_venda: "Gasto sem venda", orcamento_esgotando: "Orçamento esgotando",
  anuncio_parado: "Anúncio parado", queda_loja: "Queda da loja",
};

/** Rótulo curto da causa para o chip ("variação zerou 28/09", "preço 32,90 → 36,90"). */
function rotuloCausa(c: Record<string, unknown>): string {
  const t = str(c.tipo);
  const desde = c.desde ? ` ${ddmm(str(c.desde))}` : "";
  const ev = str(c.evidencia);
  switch (t) {
    case "variacao_sem_estoque": return `variação zerou${desde}`;
    case "preco_subiu": {
      const m = ev.match(/R\$ ([\d.,]+) → R\$ ([\d.,]+)/);
      return m ? `preço ${m[1].replace(".", ",")} → ${m[2].replace(".", ",")}` : "preço subiu";
    }
    case "saiu_de_promocao": return `saiu da promoção${desde}`;
    case "campanha_pausada_ou_orcamento": return ev.startsWith("orçamento") ? "orçamento esgotando" : "campanha pausada";
    case "ruptura_full": return "ruptura no Full";
    case "ruptura_empresa": return "ruptura na empresa";
    case "estoque_critico": return "estoque crítico";
    case "health_caiu": return "health caiu";
    case "catalogo_perdido": return "perdeu catálogo";
    case "visitas_cairam": return "visitas caíram";
    case "historico_insuficiente": return "histórico curto";
    case "sem_causa_interna": return "sem causa interna";
    case "contribuicao": return produtoCurto(c.anuncio ?? c.anuncio_id ?? "anúncio", 30);
    default: return t.replace(/_/g, " ");
  }
}

export function RelatorioAds({ rel, mobile }: { rel: RelatorioLista; mobile?: boolean }) {
  const res = rel.resumo ?? {};
  const lojas = arr(res.resumo_lojas);
  const alertas = arr(res.alertas);
  const margem = obj(res.margem);
  const tend = obj(res.tendencias);
  const sug = arr(res.sugestoes);
  const q = obj(res.qualidade);
  const pendente = adsPendente(rel);

  const skus = [
    ...alertas.map((a) => str(a.sku)), ...sug.map((s) => str(s.sku)),
    ...["prejuizo", "apertado", "folgado"].flatMap((k) => arr(margem[k]).map((m) => str(m.sku))),
    ...["subindo", "caindo", "organico_sem_ads", "ctr_alto_orcamento_limitado"].flatMap((k) => arr(tend[k]).map((t) => str(t.sku))),
  ];
  const fotos = useFotos(skus);

  return (
    <div className="flex flex-col gap-7">
      <div className={mobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 lg:grid-cols-3 gap-3"}>
        {lojas.map((l, i) => <CardLoja key={i} l={l} />)}
      </div>

      <Alertas alertas={alertas} total={num(res.alertas_total ?? alertas.length)} alta={num(res.alertas_alta)} fotos={fotos} mobile={mobile} />

      <Secao titulo="Margem × ADS" nota="30 dias · ACOS real vs ACOS máximo que a margem tolera">
        <div className={mobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 lg:grid-cols-3 gap-3"}>
          <ColunaMargem titulo="Prejuízo" dot="var(--rl-red)" itens={arr(margem.prejuizo)} fotos={fotos} />
          <ColunaMargem titulo="Apertado" dot="var(--rl-amber)" itens={arr(margem.apertado)} fotos={fotos} />
          <ColunaMargem titulo="Folgado" dot="var(--rl-green)" itens={arr(margem.folgado)} fotos={fotos} />
        </div>
      </Secao>

      <Sugestoes sug={sug} total={num(res.sugestoes_total ?? sug.length)} fotos={fotos} />

      <Secao titulo="Tendências" nota="4 semanas · receita das 4 semanas">
        <div className={mobile ? "grid grid-cols-1 gap-x-7 gap-y-3" : "grid grid-cols-1 lg:grid-cols-2 gap-x-7 gap-y-3"}>
          <ListaTendencia titulo="Subindo" cor="var(--rl-green)" itens={arr(tend.subindo)} fotos={fotos} />
          <ListaTendencia titulo="Caindo" cor="var(--rl-red)" itens={arr(tend.caindo)} fotos={fotos} />
          <ListaPequena titulo="Orgânico forte sem ADS" itens={arr(tend.organico_sem_ads)} fotos={fotos} />
          <ListaPequena titulo="CTR alto, orçamento limitado" itens={arr(tend.ctr_alto_orcamento_limitado)} fotos={fotos} />
        </div>
      </Secao>

      <Secao titulo="Qualidade dos dados">
        <Notas itens={notasAds(q, pendente)} />
      </Secao>
    </div>
  );
}

function Delta({ v, neutro }: { v: unknown; neutro?: boolean }) {
  const n = numOuNull(v);
  if (n == null) return <div className="text-[12px] text-(--rl-text-3)">—</div>;
  const cor = neutro ? "var(--rl-text-3)" : n < 0 ? "var(--rl-red)" : "var(--rl-green)";
  return (
    <div className="text-[12px] font-medium" style={{ color: cor }}>
      {n < 0 ? "↓" : "↑"} {Math.abs(n).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%
    </div>
  );
}

function CardLoja({ l }: { l: Record<string, unknown> }) {
  const nome = nomeLoja(l.marketplace, l.empresa);
  const ml = str(l.marketplace) === "mercadolivre";
  const semDado = l.dado_de_ontem === false;
  const nota = `vendas ${str(l.rotulo_vendas) || "—"}${l.provisorio ? ", últimos dias provisórios" : ""}`;
  return (
    <div className="border border-(--rl-border) rounded-lg px-4 py-3.5 flex flex-col gap-3 min-w-0">
      <div className="flex justify-between items-baseline gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Foto size={24} rotulo={ml ? "ML" : "SH"} />
          <div className="text-[14px] font-semibold">{nome}</div>
        </div>
        <div className="text-[11.5px] text-(--rl-text-3)">{nota}</div>
      </div>
      <div>
        <div className="text-[11.5px] font-medium text-(--rl-text-3) mb-1">Ontem{l.ultimo_dado ? ` · dado de ${ddmm(str(l.ultimo_dado))}` : ""}</div>
        {semDado ? (
          <div className="flex items-center gap-1.5 text-[13px] text-(--rl-amber) py-1.5">
            <IconeRelogio /> Dados de ontem ainda não chegaram{ml ? "" : " (~03:30)"}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <div><div className="text-[12px] text-(--rl-text-3)">Gasto</div><div className="text-[20px] font-semibold tracking-[-0.01em]">{brl(l.gasto_ontem)}</div></div>
            <div><div className="text-[12px] text-(--rl-text-3)">Vendas</div><div className="text-[20px] font-semibold tracking-[-0.01em]">{brl(l.vendas_ontem)}</div></div>
            <div><div className="text-[12px] text-(--rl-text-3)">{ml ? "ACOS" : "ROAS"}</div><div className="text-[20px] font-semibold tracking-[-0.01em]">{ml ? pct(l.acos_ontem_pct) : roas(l.roas_ontem)}</div></div>
          </div>
        )}
      </div>
      <div className="border-t border-(--rl-border) pt-2.5">
        <div className="text-[11.5px] font-medium text-(--rl-text-3) mb-1">7 dias · vs 7 dias anteriores</div>
        <div className="grid grid-cols-3 gap-2">
          <div><div className="text-[12px] text-(--rl-text-3)">Gasto</div><div className="text-[14px] font-semibold">{brl(l.gasto_7d)}</div><Delta v={l.var_gasto_7d} neutro /></div>
          <div><div className="text-[12px] text-(--rl-text-3)">Vendas</div><div className="text-[14px] font-semibold">{brl(l.vendas_7d)}</div><Delta v={l.var_vendas_7d} /></div>
          <div><div className="text-[12px] text-(--rl-text-3)">ROAS</div><div className="text-[14px] font-semibold">{roas(l.roas_7d)}</div><div className="text-[12px] text-(--rl-text-3)">ACOS {pct(l.acos_7d_pct)}</div></div>
        </div>
      </div>
      <div className="border-t border-(--rl-border) pt-2.5 flex flex-col gap-1 text-[12.5px] text-(--rl-text-2)">
        <div className="flex justify-between"><span>TACOS (7 dias)</span><span className="font-semibold text-(--rl-text)">{pct(l.tacos_7d_pct)}</span></div>
        <div><span className="text-(--rl-text-3)">Mês:</span> {brl(l.gasto_mes)} → {brl(l.vendas_mes)} · ROAS {roas(l.roas_mes)} (anterior {roas(l.roas_mes_anterior)})</div>
      </div>
    </div>
  );
}

const SEV: Record<string, "red" | "amber" | "gray"> = { alta: "red", media: "amber", "média": "amber", baixa: "gray" };
const LIM_ALERTAS = 8;

function Alertas({ alertas, total, alta, fotos, mobile }: {
  alertas: Record<string, unknown>[]; total: number; alta: number; fotos: Map<string, string>; mobile?: boolean;
}) {
  // evidência aberta por alerta (o 1º chip do 1º alerta já nasce aberto, como no design)
  const [ev, setEv] = useState<Record<number, number | undefined>>({ 0: 0 });
  const [todos, setTodos] = useState(false);
  const vis = todos ? alertas : alertas.slice(0, LIM_ALERTAS);
  return (
    <Secao titulo="Alertas" nota={`${total} alertas${alta ? ` · ${alta} altos` : ""} · clique numa causa para ver a evidência`}>
      {alertas.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nenhum alerta ontem.</div> : (
        <div className="border border-(--rl-border) rounded-lg overflow-hidden">
          {vis.map((a, i) => {
            const met = str(a.metrica);
            const ehPct = met === "ctr" || met === "conversao";
            const fmt = (x: unknown) => {
              const v = numOuNull(x);
              if (v == null) return "—";
              if (ehPct) return pct(v * 100, 2);
              if (met === "roas") return roas(v);
              if (met.startsWith("impressoes") || met === "cliques") return Math.round(v).toLocaleString("pt-BR");
              return brl(v);
            };
            const anuncio = a.nivel === "anuncio";
            const titulo = anuncio ? str(a.anuncio ?? a.anuncio_id)
              : a.nivel === "marketplace" ? `${MKT[str(a.marketplace)] ?? str(a.marketplace)} (todas as lojas)`
              : `Loja ${nomeLoja(a.marketplace, a.empresa)}`;
            const causas = arr(a.causas);
            const aberta = ev[i];
            const variacao = numOuNull(a.variacao_pct);
            const sev = str(a.severidade);
            return (
              <div key={i} className="flex flex-col gap-2 px-3.5 py-3" style={{ borderTop: i ? "1px solid var(--rl-border)" : "none" }}>
                <div className={mobile ? "grid grid-cols-[auto_minmax(0,1fr)] gap-3 items-start" : "grid grid-cols-[58px_minmax(0,1fr)_150px_170px] gap-3 items-start"}>
                  <span className="justify-self-start"><Pill cor={SEV[sev] ?? "gray"}>{sev === "media" ? "média" : sev || "—"}</Pill></span>
                  <div className="min-w-0 flex gap-2.5 items-center">
                    <Foto src={fotos.get(str(a.sku))} size={44} rotulo={anuncio ? undefined : nomeLoja(a.marketplace, a.empresa).replace("Mercado Livre", "ML")} />
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-medium line-clamp-2" title={titulo}>{titulo}</div>
                      <div className="flex gap-2 flex-wrap text-[12px] text-(--rl-text-3)">
                        {anuncio && <span>{nomeLoja(a.marketplace, a.empresa)}</span>}
                        {a.sku ? <span className="font-mono text-[11.5px]">{str(a.sku)}</span> : null}
                        {mobile && <span>{TIPO_ALERTA[str(a.tipo)] ?? str(a.tipo)}</span>}
                      </div>
                    </div>
                  </div>
                  {!mobile && <div className="text-[13px] text-(--rl-text-2)">{TIPO_ALERTA[str(a.tipo)] ?? str(a.tipo)}<div className="text-[12px] text-(--rl-text-3)">{METRICA[met] ?? met}</div></div>}
                  <div className={mobile ? "col-span-2 flex justify-between gap-2" : "flex flex-col items-end gap-0.5"}>
                    <div className={MONO}>{fmt(a.valor_base)} → {fmt(a.valor_ontem)}</div>
                    <div className="text-[12px] text-(--rl-text-3)">
                      <span className="font-semibold" style={{ color: variacao != null && variacao > 0 ? "var(--rl-text-3)" : "var(--rl-red)" }}>
                        {variacao == null ? "—" : `${variacao > 0 ? "+" : "−"}${Math.abs(variacao).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`}
                      </span>
                      {numOuNull(a.dias_em_queda) != null ? ` · ${str(a.dias_em_queda)} ${num(a.dias_em_queda) === 1 ? "dia" : "dias"} em queda` : ""}
                    </div>
                  </div>
                </div>
                {causas.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap" style={{ paddingLeft: mobile ? 0 : 70 }}>
                    {causas.map((c, j) => {
                      const on = aberta === j;
                      return (
                        <button key={j} type="button" aria-expanded={on}
                          onClick={() => setEv((s) => ({ ...s, [i]: s[i] === j ? undefined : j }))}
                          className="text-[12px] px-2.5 py-[3px] rounded-full border cursor-pointer hover:border-(--rl-accent)"
                          style={{
                            borderColor: on ? "var(--rl-accent)" : "var(--rl-border)",
                            background: on ? "var(--rl-accent-soft)" : "transparent",
                            color: on ? "var(--rl-accent-text)" : "var(--rl-text-2)",
                          }}>
                          {rotuloCausa(c)}
                        </button>
                      );
                    })}
                  </div>
                )}
                {aberta != null && causas[aberta] && (
                  <div className="text-[12.5px] leading-normal text-(--rl-text-2) bg-(--rl-surface-2) rounded-md px-2.5 py-2"
                    style={{ marginLeft: mobile ? 0 : 70 }}>
                    {str(causas[aberta].evidencia)}
                    {numOuNull(causas[aberta].impacto_estimado) != null && <> · impacto {brl(causas[aberta].impacto_estimado)}</>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {alertas.length > LIM_ALERTAS && (
        <button type="button" onClick={() => setTodos((t) => !t)}
          className="mt-2 text-[13px] font-medium text-(--rl-accent-text) hover:underline cursor-pointer">
          {todos ? "Mostrar menos" : `Mostrar todos (${alertas.length})`}
        </button>
      )}
    </Secao>
  );
}

const LIM_MARGEM = 4;

function ColunaMargem({ titulo, dot, itens, fotos }: {
  titulo: string; dot: string; itens: Record<string, unknown>[]; fotos: Map<string, string>;
}) {
  const [todos, setTodos] = useState(false);
  const soma = itens.reduce((s, m) => s + num(m.margem_pos_ads), 0);
  const vis = todos ? itens : itens.slice(0, LIM_MARGEM);
  return (
    <div className="border border-(--rl-border) rounded-lg min-w-0 flex flex-col">
      <div className="flex justify-between items-baseline gap-2 px-3.5 py-2.5 border-b border-(--rl-border)">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold"><i className="w-2 h-2 rounded-full" style={{ background: dot }} />{titulo}</div>
        <div className="text-[12px] text-(--rl-text-3)">{itens.length} itens · {brlMil(soma)}</div>
      </div>
      {itens.length === 0 ? <div className="px-3.5 py-2.5 text-[13px] text-(--rl-text-3)">—</div> : (
        <div className={todos ? "max-h-[420px] overflow-y-auto" : ""}>
          {vis.map((m, k) => {
            const mv = numOuNull(m.margem_pos_ads);
            return (
              <div key={k} className="px-3.5 py-2.5 flex gap-2.5 items-center" style={{ borderTop: k ? "1px solid var(--rl-border)" : "none" }}>
                <Foto src={fotos.get(str(m.sku))} size={40} />
                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex justify-between gap-2 items-baseline">
                    <div className="text-[13px] font-medium min-w-0 truncate" title={str(m.titulo)}>{produtoCurto(m.titulo ?? m.sku ?? m.anuncio_id, 40)}</div>
                    <div className={`${MONO} font-medium whitespace-nowrap`} style={{ color: mv != null && mv < 0 ? "var(--rl-red)" : undefined }}>{brl(mv)}</div>
                  </div>
                  <div className="flex gap-2 flex-wrap items-center text-[12px] text-(--rl-text-3)">
                    <span>{nomeLoja(m.marketplace, m.empresa)}</span>
                    <span>ACOS {pct(m.acos_pct, 0)} · máx {pct(m.acos_maximo_tolerado, 0)}</span>
                    {m.roas_enganoso ? <Pill cor="amber">ROAS bom, margem ruim</Pill> : null}
                    {m.confiavel === false ? <Pill cor="gray">CMV incompleto</Pill> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {itens.length > LIM_MARGEM && (
        <button type="button" onClick={() => setTodos((t) => !t)}
          className="mt-auto px-3.5 py-2 text-left text-[12.5px] font-medium text-(--rl-accent-text) border-t border-(--rl-border) hover:underline cursor-pointer">
          {todos ? "Mostrar menos" : `Ver os ${itens.length}`}
        </button>
      )}
    </div>
  );
}

const PRIO: Record<number, { bg: string; fg: string }> = {
  1: { bg: "var(--rl-accent)", fg: "var(--rl-on-accent)" },
  2: { bg: "var(--rl-accent-soft)", fg: "var(--rl-accent-text)" },
  3: { bg: "var(--rl-gray-soft)", fg: "var(--rl-text-2)" },
};
const LIM_SUG = 8;

function Sugestoes({ sug, total, fotos }: { sug: Record<string, unknown>[]; total: number; fotos: Map<string, string> }) {
  const [todos, setTodos] = useState(false);
  const vis = todos ? sug : sug.slice(0, LIM_SUG);
  return (
    <Secao titulo="Sugestões" nota={`${vis.length} de ${total} · o app não executa — decisão sua`}>
      {sug.length === 0 ? <div className="text-[13px] text-(--rl-text-3)">Nenhuma sugestão hoje.</div> : (
        <div className="overflow-x-auto border border-(--rl-border) rounded-lg">
          <table className="w-full min-w-[860px] border-collapse text-[13px]">
            <thead>
              <tr>
                <th className="rl-th text-left w-10">Prio.</th>
                <th className="rl-th text-left">Ação sugerida</th>
                <th className="rl-th text-left">Anúncio</th>
                <th className="rl-th text-left">Por quê</th>
                <th className="rl-th text-right">Impacto/mês</th>
              </tr>
            </thead>
            <tbody>
              {vis.map((s, i) => {
                const p = PRIO[num(s.prioridade)] ?? PRIO[3];
                const imp = numOuNull(s.impacto_estimado_rs);
                return (
                  <tr key={i}>
                    <td className="rl-td align-top py-2.5">
                      <span className="inline-grid place-items-center w-[22px] h-[22px] rounded-md text-[12px] font-semibold" style={{ background: p.bg, color: p.fg }}>{str(s.prioridade) || "—"}</span>
                    </td>
                    <td className="rl-td align-top py-2.5 font-medium whitespace-nowrap">{ACAO[str(s.tipo)] ?? str(s.tipo)}</td>
                    <td className="rl-td align-top py-2.5">
                      <div className="flex gap-2.5 items-center min-w-[200px] max-w-[300px]" title={str(s.anuncio)}>
                        <Foto src={fotos.get(str(s.sku))} size={40} />
                        <div className="min-w-0">
                          <div className="font-medium line-clamp-2">{produtoCurto(s.anuncio ?? s.sku, 60)}</div>
                          <div className="text-[12px] text-(--rl-text-3)">{nomeLoja(s.marketplace, s.empresa)}{s.sku ? ` · ${str(s.sku)}` : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="rl-td align-top py-2.5 text-(--rl-text-2) leading-[1.45] max-w-[380px]">{str(s.justificativa)}</td>
                    <td className={`rl-td align-top py-2.5 text-right whitespace-nowrap ${MONO}`} style={{ color: "var(--rl-green)" }}>{imp == null ? "—" : `+${brl(imp)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sug.length > LIM_SUG && (
        <button type="button" onClick={() => setTodos((t) => !t)}
          className="mt-2 text-[13px] font-medium text-(--rl-accent-text) hover:underline cursor-pointer">
          {todos ? "Mostrar menos" : `Mostrar todas (${sug.length})`}
        </button>
      )}
    </Secao>
  );
}

function pontos(v: number[]): string {
  const mx = Math.max(...v), mn = Math.min(...v), r = (mx - mn) || 1;
  const passo = v.length > 1 ? 58 / (v.length - 1) : 0;
  return v.map((x, i) => `${(3 + i * passo).toFixed(1)},${(19 - ((x - mn) / r) * 16).toFixed(1)}`).join(" ");
}

function ListaTendencia({ titulo, cor, itens, fotos }: {
  titulo: string; cor: string; itens: Record<string, unknown>[]; fotos: Map<string, string>;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[12.5px] font-semibold text-(--rl-text-2) pb-1.5 border-b border-(--rl-border)">{titulo} <span className="font-normal text-(--rl-text-3)">· {itens.length}</span></div>
      {itens.length === 0 ? <div className="py-2 text-[13px] text-(--rl-text-3)">—</div> : itens.slice(0, 6).map((t, i) => {
        const sem = arr(t.semanas).map((s) => num(s.receita));
        return (
          <div key={i} className="grid grid-cols-[36px_minmax(0,1fr)_64px_84px] gap-3 items-center py-2 border-b border-(--rl-border)" title={str(t.detalhe)}>
            <Foto src={fotos.get(str(t.sku))} size={36} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium truncate">{produtoCurto(t.titulo ?? t.chave, 48)}</div>
              <div className="text-[12px] text-(--rl-text-3) truncate">{nomeLoja(t.marketplace, t.empresa)}</div>
            </div>
            {sem.length > 1 ? (
              <svg width="64" height="22" viewBox="0 0 64 22" fill="none" aria-hidden>
                <polyline points={pontos(sem)} stroke={cor} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : <span />}
            <div className={`${MONO} text-right`}>{brl(t.receita_4s)}</div>
          </div>
        );
      })}
    </div>
  );
}

function ListaPequena({ titulo, itens, fotos }: { titulo: string; itens: Record<string, unknown>[]; fotos: Map<string, string> }) {
  if (itens.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-[12.5px] font-semibold text-(--rl-text-2) pb-1.5 border-b border-(--rl-border)">{titulo} <span className="font-normal text-(--rl-text-3)">· {itens.length}</span></div>
      {itens.slice(0, 5).map((t, i) => (
        <div key={i} className="flex justify-between items-center gap-3 py-[7px] border-b border-(--rl-border) text-[13px]" title={str(t.detalhe)}>
          <span className="flex items-center gap-2.5 font-medium min-w-0">
            <Foto src={fotos.get(str(t.sku))} size={32} />
            <span className="truncate">{produtoCurto(t.titulo ?? t.chave, 40)}</span>
          </span>
          <span className="text-(--rl-text-3) text-[12px] text-right whitespace-nowrap">{nomeLoja(t.marketplace, t.empresa)} · {brl(t.receita_4s)}</span>
        </div>
      ))}
    </div>
  );
}

function notasAds(q: Record<string, unknown>, pendente: string | null): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  if (pendente) out.push(pendente);
  for (const f of arr(q.dias_faltando)) out.push(`${str(f.fonte)}: falta(m) ${str(f.n)} dia(s) — ${str(f.dias)}.`);
  if (q.snapshot_diagnostico_completo === false) {
    out.push(`Retrato diário com ${str(q.snapshot_dias_historico ?? 0)} dia(s): causas de preço, promoção, estoque de variação e health ficam "histórico curto" até completar 8 dias.`);
  }
  if (num(q.anuncios_sem_sku) > 0) out.push(`${str(q.anuncios_sem_sku)} anúncio(s) com gasto e sem SKU mapeado.`);
  if (num(q.skus_sem_cmv) > 0) out.push(`${str(q.skus_sem_cmv)} SKU(s) com CMV incompleto: a margem deles não é confiável.`);
  if (q.ml_ultimos_dias_provisorios) out.push("Mercado Livre reatribui vendas por alguns dias: os últimos dias são provisórios.");
  return out;
}
