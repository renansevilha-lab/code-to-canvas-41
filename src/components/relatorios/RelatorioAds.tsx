import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";

import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { arr, Bloco, brl, ddmm, num, numOuNull, obj, Selo, type RelatorioLista } from "./comum";

// ============================================================================
// Card aberto do agente de ADS (resumo = ads_relatorio_diario(), versao 'v1'):
// resumo_lojas[], classificacao[], alertas[] (com causas), margem{prejuizo,
// apertado, folgado}, tendencias{subindo, caindo, ...}, sugestoes[],
// ml_campanhas[], qualidade{}. Só leitura — nenhuma ação em campanha.
// O registro v0 (05/10) tem outro formato: mostra só o corpo_html.
// ============================================================================

const MKT: Record<string, string> = { shopee: "Shopee", mercadolivre: "Mercado Livre" };
const pct = (x: unknown, casas = 1) => {
  const v = numOuNull(x);
  return v == null ? "—" : `${v.toLocaleString("pt-BR", { maximumFractionDigits: casas })}%`;
};
const roas = (x: unknown) => {
  const v = numOuNull(x);
  return v == null ? "—" : `${v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`;
};
const nomeLoja = (l: Record<string, unknown>) =>
  l.marketplace === "mercadolivre" ? "Mercado Livre" : `Shopee · ${String(l.empresa ?? "")}`;

/** Mini-KPIs do card fechado: gasto e ROAS de ontem (todas as lojas) e nº de alertas. */
export function resumoAds(resumo: Record<string, unknown> | null) {
  const lojas = arr(resumo?.resumo_lojas);
  const g = lojas.reduce((s, l) => s + num(l.gasto_ontem), 0);
  const v = lojas.reduce((s, l) => s + num(l.vendas_ontem), 0);
  return {
    v0: String(resumo?.versao ?? "").startsWith("v0"),
    gastoOntem: lojas.length ? g : null,
    roasOntem: g > 0 ? v / g : null,
    alertas: num(resumo?.alertas_total ?? arr(resumo?.alertas).length),
    alta: num(resumo?.alertas_alta),
  };
}

export function RelatorioAds({ rel }: { rel: RelatorioLista }) {
  const res = rel.resumo ?? {};
  if (String(res.versao ?? "").startsWith("v0")) return <HtmlInline rel={rel} />;
  const lojas = arr(res.resumo_lojas);
  const alertas = arr(res.alertas);
  const margem = obj(res.margem);
  const tend = obj(res.tendencias);
  const sug = arr(res.sugestoes);
  const q = obj(res.qualidade);

  return (
    <div className="flex flex-col gap-5">
      <AvisoDado q={q} />

      {/* 1. KPIs por loja */}
      <div className="grid gap-2.5 md:grid-cols-3">
        {lojas.map((l, i) => <CardLoja key={i} l={l} />)}
      </div>

      {/* 2. Alertas */}
      <Bloco titulo={`Alertas (${formatNumber(num(res.alertas_total ?? alertas.length))})`}
        direita={num(res.alertas_total) > alertas.length && <span className="text-[11px] text-muted-foreground">mostrando {alertas.length}</span>}>
        {alertas.length === 0 ? <span className="text-sm text-muted-foreground">Nenhum alerta ontem.</span> : (
          <div className="rounded-lg border divide-y">
            {alertas.map((a, i) => <LinhaAlerta key={i} a={a} />)}
          </div>
        )}
      </Bloco>

      {/* 3. Margem */}
      <Bloco titulo="Margem × ADS (30 dias)">
        <div className="grid gap-2.5 lg:grid-cols-3">
          <ColunaMargem titulo="Prejuízo" cor="red" itens={arr(margem.prejuizo)} />
          <ColunaMargem titulo="Apertado" cor="amber" itens={arr(margem.apertado)} />
          <ColunaMargem titulo="Folgado" cor="green" itens={arr(margem.folgado)} />
        </div>
      </Bloco>

      {/* 4. Sugestões */}
      <Bloco titulo={`Sugestões (${formatNumber(num(res.sugestoes_total ?? sug.length))})`}
        direita={<span className="text-[11px] text-muted-foreground">o app não executa — decisão sua</span>}>
        {sug.length === 0 ? <span className="text-sm text-muted-foreground">Nenhuma sugestão hoje.</span> : (
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                  <th className="py-2 px-3 font-semibold">P</th>
                  <th className="py-2 px-3 font-semibold">Ação</th>
                  <th className="py-2 px-3 font-semibold">Anúncio</th>
                  <th className="py-2 px-3 font-semibold">Justificativa</th>
                  <th className="py-2 px-3 font-semibold text-right">Impacto/mês</th>
                </tr>
              </thead>
              <tbody>
                {sug.map((s, i) => (
                  <tr key={i} className="border-b last:border-0 align-top">
                    <td className="py-1.5 px-3"><Selo cor={num(s.prioridade) === 1 ? "red" : num(s.prioridade) === 2 ? "amber" : "gray"}>{String(s.prioridade ?? "—")}</Selo></td>
                    <td className="py-1.5 px-3 whitespace-nowrap font-medium">{ACAO[String(s.tipo)] ?? String(s.tipo)}</td>
                    <td className="py-1.5 px-3 max-w-[240px]">
                      <div className="truncate" title={String(s.anuncio ?? "")}>{String(s.anuncio ?? s.sku ?? "—")}</div>
                      <div className="text-[11px] text-muted-foreground">{MKT[String(s.marketplace)] ?? String(s.marketplace ?? "")}{s.empresa ? ` · ${String(s.empresa)}` : ""}{s.sku ? ` · ${String(s.sku)}` : ""}</div>
                    </td>
                    <td className="py-1.5 px-3 text-[12.5px] text-muted-foreground">{String(s.justificativa ?? "")}</td>
                    <td className="py-1.5 px-3 text-right font-mono tabular-nums whitespace-nowrap">{brl(s.impacto_estimado_rs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Bloco>

      {/* 5. Tendências */}
      <Bloco titulo="Tendências (4 semanas)">
        <div className="grid gap-2.5 lg:grid-cols-2">
          <ListaTendencia titulo="Subindo" cor="green" itens={arr(tend.subindo)} />
          <ListaTendencia titulo="Caindo" cor="red" itens={arr(tend.caindo)} />
        </div>
        {(arr(tend.organico_sem_ads).length > 0 || arr(tend.ctr_alto_orcamento_limitado).length > 0) && (
          <div className="grid gap-2.5 lg:grid-cols-2 mt-1">
            <ListaTendencia titulo="Orgânico forte sem ADS" cor="gray" itens={arr(tend.organico_sem_ads)} />
            <ListaTendencia titulo="CTR alto, orçamento limitado" cor="gray" itens={arr(tend.ctr_alto_orcamento_limitado)} />
          </div>
        )}
      </Bloco>

      {/* 6. Qualidade */}
      <Qualidade q={q} />
    </div>
  );
}

const ACAO: Record<string, string> = {
  pausar: "Pausar", reduzir_orcamento: "Reduzir orçamento", aumentar_orcamento: "Aumentar orçamento",
  revisar_lance: "Revisar lance", repor_variacao: "Repor estoque", renovar_promocao: "Renovar promoção",
  revisar_preco: "Revisar preço", criar_campanha: "Criar campanha", verificar: "Verificar",
};

function Variacao({ v }: { v: unknown }) {
  const n = numOuNull(v);
  if (n == null) return <span className="text-muted-foreground">—</span>;
  const sobe = n >= 0;
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums", sobe ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
      {sobe ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {pct(n)}
    </span>
  );
}

function CardLoja({ l }: { l: Record<string, unknown> }) {
  return (
    <div className="rounded-lg border bg-card px-3.5 py-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-bold uppercase tracking-wide text-muted-foreground truncate">{nomeLoja(l)}</span>
        <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">vendas {String(l.rotulo_vendas ?? "")}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm">
        <Mini rotulo="Gasto ontem" valor={brl(l.gasto_ontem)} />
        <Mini rotulo="Vendas ontem" valor={brl(l.vendas_ontem)} />
        <Mini rotulo="ROAS / ACOS" valor={`${roas(l.roas_ontem)} · ${pct(l.acos_ontem_pct)}`} />
        <Mini rotulo="Gasto 7d" valor={brl(l.gasto_7d)} extra={<Variacao v={l.var_gasto_7d} />} />
        <Mini rotulo="Vendas 7d" valor={brl(l.vendas_7d)} extra={<Variacao v={l.var_vendas_7d} />} />
        <Mini rotulo="ROAS 7d" valor={roas(l.roas_7d)} extra={<span className="text-muted-foreground">TACOS {pct(l.tacos_7d_pct)}</span>} />
      </div>
      <div className="text-[11px] text-muted-foreground">
        Mês: {brl(l.gasto_mes)} → {brl(l.vendas_mes)} · ROAS {roas(l.roas_mes)} (mês anterior {roas(l.roas_mes_anterior)})
        {l.provisorio ? " · últimos dias provisórios (ML reatribui)" : ""}
      </div>
    </div>
  );
}
function Mini({ rotulo, valor, extra }: { rotulo: string; valor: string; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">{rotulo}</span>
      <span className="font-semibold tabular-nums truncate">{valor}</span>
      {extra && <span className="text-[11px]">{extra}</span>}
    </div>
  );
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
  const t = String(c.tipo ?? "");
  const desde = c.desde ? ` ${ddmm(String(c.desde))}` : "";
  const ev = String(c.evidencia ?? "");
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
    case "contribuicao": return String(c.anuncio ?? c.anuncio_id ?? "anúncio").slice(0, 28);
    default: return t.replace(/_/g, " ");
  }
}
const corCausa = (t: string): "red" | "amber" | "gray" =>
  ["variacao_sem_estoque", "ruptura_full", "ruptura_empresa", "preco_subiu", "saiu_de_promocao", "catalogo_perdido"].includes(t) ? "red"
    : ["campanha_pausada_ou_orcamento", "estoque_critico", "health_caiu", "visitas_cairam"].includes(t) ? "amber" : "gray";

function LinhaAlerta({ a }: { a: Record<string, unknown> }) {
  const [aberta, setAberta] = useState<number | null>(null);
  const causas = arr(a.causas);
  const sev = String(a.severidade ?? "");
  const met = String(a.metrica ?? "");
  const ehPct = met === "ctr" || met === "conversao";
  const fmt = (x: unknown) => {
    const v = numOuNull(x);
    if (v == null) return "—";
    if (ehPct) return pct(v * 100, 2);
    if (met === "roas") return roas(v);
    if (met.startsWith("impressoes") || met === "cliques") return formatNumber(Math.round(v));
    return brl(v);
  };
  const titulo = a.nivel === "anuncio" ? String(a.anuncio ?? a.anuncio_id ?? "—")
    : a.nivel === "marketplace" ? `${MKT[String(a.marketplace)] ?? a.marketplace} (todas as lojas)`
    : `${MKT[String(a.marketplace)] ?? a.marketplace} · ${String(a.empresa ?? "")}`;
  return (
    <div className="px-3 py-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Selo cor={sev === "alta" ? "red" : sev === "media" ? "amber" : "gray"}>{sev}</Selo>
        <span className="font-medium truncate max-w-[340px]" title={titulo}>{titulo}</span>
        {a.nivel === "anuncio" && (
          <span className="text-[11px] text-muted-foreground">{MKT[String(a.marketplace)] ?? ""}{a.empresa ? ` · ${String(a.empresa)}` : ""}{a.sku ? ` · ${String(a.sku)}` : ""}</span>
        )}
        <span className="ml-auto text-[12.5px] whitespace-nowrap">
          <span className="text-muted-foreground">{TIPO_ALERTA[String(a.tipo)] ?? String(a.tipo)} · {METRICA[met] ?? met}: </span>
          <span className="tabular-nums">{fmt(a.valor_base)} → {fmt(a.valor_ontem)}</span>{" "}
          <Variacao v={a.variacao_pct} />
          {numOuNull(a.dias_em_queda) != null && <span className="text-muted-foreground"> · {String(a.dias_em_queda)} d</span>}
        </span>
      </div>
      {causas.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {causas.map((c, i) => (
            <button key={i} type="button" onClick={() => setAberta(aberta === i ? null : i)} aria-expanded={aberta === i}
              className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Selo cor={corCausa(String(c.tipo ?? ""))} title={String(c.evidencia ?? "")}>{rotuloCausa(c)}</Selo>
            </button>
          ))}
        </div>
      )}
      {aberta != null && causas[aberta] && (
        <div className="text-[12px] text-muted-foreground rounded-md bg-muted/50 px-2.5 py-1.5">
          {String(causas[aberta].evidencia ?? "")}
          {numOuNull(causas[aberta].impacto_estimado) != null && <> · impacto {brl(causas[aberta].impacto_estimado)}</>}
        </div>
      )}
    </div>
  );
}

function ColunaMargem({ titulo, cor, itens }: { titulo: string; cor: "red" | "amber" | "green"; itens: Record<string, unknown>[] }) {
  return (
    <div className="rounded-lg border flex flex-col min-w-0">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
        <Selo cor={cor}>{titulo}</Selo>
        <span className="text-[11px] text-muted-foreground">{itens.length} · ACOS vs máx.</span>
      </div>
      {itens.length === 0 ? <span className="px-3 py-2 text-sm text-muted-foreground">—</span> : (
        <div className="divide-y max-h-80 overflow-y-auto">
          {itens.map((m, i) => (
            <div key={i} className="px-3 py-1.5 flex items-center gap-2 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <div className="truncate" title={String(m.titulo ?? "")}>{String(m.titulo ?? m.sku ?? m.anuncio_id ?? "—")}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {MKT[String(m.marketplace)] ?? ""}{m.empresa ? ` · ${String(m.empresa)}` : ""}{m.sku ? ` · ${String(m.sku)}` : ""}
                  {m.roas_enganoso ? " · ROAS bom, margem ruim" : ""}{m.confiavel === false ? " · CMV incompleto" : ""}
                </div>
              </div>
              <div className="text-right tabular-nums whitespace-nowrap">
                <div className="font-semibold">{pct(m.acos_pct)} <span className="text-muted-foreground font-normal">/ {pct(m.acos_maximo_tolerado)}</span></div>
                <div className={cn("text-[11px]", num(m.margem_pos_ads) < 0 ? "text-red-700 dark:text-red-400" : "text-muted-foreground")}>{brl(m.margem_pos_ads)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Sparkline({ valores, cor }: { valores: number[]; cor: string }) {
  if (valores.length < 2) return null;
  const max = Math.max(...valores, 1);
  const w = 64, h = 20;
  const pts = valores.map((v, i) => `${(i / (valores.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn("shrink-0", cor)} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function ListaTendencia({ titulo, cor, itens }: { titulo: string; cor: "green" | "red" | "gray"; itens: Record<string, unknown>[] }) {
  const corLinha = cor === "green" ? "text-emerald-600 dark:text-emerald-400" : cor === "red" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
  return (
    <div className="rounded-lg border flex flex-col min-w-0">
      <div className="px-3 py-2 border-b bg-muted/40 flex items-center justify-between">
        <Selo cor={cor}>{titulo}</Selo>
        <span className="text-[11px] text-muted-foreground">{itens.length}</span>
      </div>
      {itens.length === 0 ? <span className="px-3 py-2 text-sm text-muted-foreground">—</span> : (
        <div className="divide-y max-h-72 overflow-y-auto">
          {itens.map((t, i) => (
            <div key={i} className="px-3 py-1.5 flex items-center gap-2 text-[12.5px]" title={String(t.detalhe ?? "")}>
              <Sparkline valores={arr(t.semanas).map((s) => num(s.receita))} cor={corLinha} />
              <div className="min-w-0 flex-1">
                <div className="truncate">{String(t.titulo ?? t.chave ?? "—")}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {MKT[String(t.marketplace)] ?? ""}{t.empresa ? ` · ${String(t.empresa)}` : ""} · {t.nivel === "sku" ? `SKU ${String(t.chave)}` : "anúncio"}
                </div>
              </div>
              <span className="tabular-nums whitespace-nowrap text-muted-foreground">{brl(t.receita_4s)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AvisoDado({ q }: { q: Record<string, unknown> }) {
  const aviso = obj(q.dado_de_ontem).aviso;
  if (!aviso) return null;
  return (
    <div className="rounded-lg border border-amber-300/60 dark:border-amber-900/60 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {String(aviso)}
    </div>
  );
}

function Qualidade({ q }: { q: Record<string, unknown> }) {
  const avisos: string[] = [];
  const falta = arr(q.dias_faltando);
  for (const f of falta) avisos.push(`${String(f.fonte)}: faltam ${String(f.n)} dia(s) — ${String(f.dias)}`);
  if (q.snapshot_diagnostico_completo === false)
    avisos.push(`Retrato diário com ${String(q.snapshot_dias_historico ?? 0)} dia(s): causas de preço, promoção, estoque de variação e health ficam "histórico curto" até completar 8 dias.`);
  if (num(q.anuncios_sem_sku) > 0) avisos.push(`${String(q.anuncios_sem_sku)} anúncio(s) com gasto e sem SKU mapeado.`);
  if (num(q.skus_sem_cmv) > 0) avisos.push(`${String(q.skus_sem_cmv)} SKU(s) com CMV incompleto (margem não confiável).`);
  if (avisos.length === 0) return null;
  return (
    <Bloco titulo="Qualidade dos dados">
      <div className="flex flex-col gap-1 text-[11.5px] text-muted-foreground">
        {avisos.map((a, i) => <div key={i} className="flex items-start gap-1.5"><AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" /> {a}</div>)}
      </div>
    </Bloco>
  );
}

/** v0: só o corpo_html (o resumo tem outro formato). */
function HtmlInline({ rel }: { rel: RelatorioLista }) {
  const q = useQuery({
    queryKey: ["relatorios", "html", rel.id],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("relatorios_agentes").select("corpo_html, corpo_texto").eq("id", rel.id).maybeSingle();
      if (error) throw error;
      return (data ?? { corpo_html: null, corpo_texto: null }) as { corpo_html: string | null; corpo_texto: string | null };
    },
  });
  const limpo = useMemo(() => q.data?.corpo_html ? DOMPurify.sanitize(q.data.corpo_html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "link", "meta"],
  }) : "", [q.data?.corpo_html]);
  if (q.isLoading) return <div className="flex items-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Carregando…</div>;
  if (!limpo) return <span className="text-sm text-muted-foreground">Versão inicial do relatório — sem conteúdo detalhado.</span>;
  return <div className="overflow-x-auto rounded-lg border"><div className="relatorio-html p-4" dangerouslySetInnerHTML={{ __html: limpo }} /></div>;
}
