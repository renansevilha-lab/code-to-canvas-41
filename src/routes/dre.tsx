import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Info, Loader2, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { usePerfil } from "@/hooks/usePerfil";
import { cn } from "@/lib/utils";

// Categorias válidas do bloco de despesas do DRE (para reclassificar 1 conta).
// Precisam bater com o que categoria_despesa_dre() e as views usam.
const DRE_CATEGORIAS_EDIT = [
  "Pessoal",
  "Aluguel",
  "Administrativas",
  "Embalagem",
  "Frete/Logística",
  "Financeiras",
  "Outras / a classificar",
  "Pessoal/Creative (revisar)",
];

export const Route = createFileRoute("/dre")({
  head: () => ({
    meta: [
      { title: "DRE — Demonstração de Resultado" },
      { name: "description", content: "DRE gerencial: receita, margem de contribuição e lucro líquido, com composição da receita e detalhamento." },
    ],
  }),
  component: DREPage,
});

interface DreRow {
  mes: string;
  receita_liquida: number | null;
  cmv: number | null;
  comissoes_frete: number | null;
  impostos: number | null;
  margem_contribuicao: number | null;
  ads: number | null;
  pessoal: number | null;
  aluguel: number | null;
  administrativas: number | null;
  embalagem: number | null;
  frete_logistica: number | null;
  financeiras: number | null;
  outras: number | null;
  creative_revisar: number | null;
  total_despesas: number | null;
  lucro_liquido: number | null;
  margem_liquida_pct: number | null;
}

interface DreOperacionalRow {
  mes: string;
  empresa: string;
  pedidos: number | null;
  receita_liquida: number | null;
  cmv: number | null;
  comissoes_frete: number | null;
  impostos: number | null;
  margem_contribuicao: number | null;
}

interface DespesaDetalheRow {
  mes: string;
  categoria: string;
  fornecedor_nome: string | null;
  descricao: string | null;
  valor_total: number | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status: string | null;
  tiny_id: number | null;
  excluida: boolean | null;
}

interface DeducaoMktRow {
  mes: string;
  empresa: string;
  canal: string;
  marketplace: string;
  comissao: number | null;
  taxa_servico: number | null;
  frete_vendedor: number | null;
  afiliados: number | null;
  ajuste_comercial: number | null;
  outras_escrow: number | null;
  total_deducao: number | null;
}

interface AdsMktRow {
  mes: string;
  canal: string;
  gasto: number | null;
}

type EmpresaFiltro = "consolidado" | "ACZ Pet" | "SVL Store";

const brlS = (v: number | null | undefined) => {
  const n = v ?? 0;
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1_000_000) return `${s}R$ ${(a / 1_000_000).toFixed(2).replace(".", ",")} mi`;
  if (a >= 1_000) return `${s}R$ ${(a / 1_000).toFixed(1).replace(".", ",")} mil`;
  return `${s}R$ ${a.toFixed(0)}`;
};
const brlFull = (v: number | null | undefined) =>
  (v ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const pctStr = (part: number | null | undefined, total: number | null | undefined) => {
  const p = part ?? 0;
  const t = total ?? 0;
  if (!t) return "—";
  return `${((p / t) * 100).toFixed(1).replace(".", ",")}%`;
};

function pctVar(cur: number, prev: number | null | undefined): number | null {
  const p = prev ?? 0;
  if (!p || !Number.isFinite(p)) return null;
  return ((cur - p) / Math.abs(p)) * 100;
}

function sig(d: number | null): string {
  if (d == null || !Number.isFinite(d)) return "—";
  return `${d >= 0 ? "↑" : "↓"} ${Math.abs(d).toFixed(1).replace(".", ",")}%`;
}

// Pontos de sparkline (viewBox 0 0 120 30) a partir de uma série numérica.
function spark(vals: number[]): string {
  const v = vals.filter((n) => Number.isFinite(n));
  if (v.length < 2) return "";
  const mn = Math.min(...v);
  const mx = Math.max(...v);
  const r = mx - mn || 1;
  const sx = 120 / (v.length - 1);
  return v.map((n, i) => `${(i * sx).toFixed(1)},${(28 - ((n - mn) / r) * 26).toFixed(1)}`).join(" ");
}

function formatMes(m: string): string {
  const [y, mm] = m.split("-");
  if (!y || !mm) return m;
  const nomes = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${nomes[Number(mm) - 1] ?? mm}/${y.slice(2)}`;
}

// Mapeia label da linha → categoria EXATA emitida por categoria_despesa_dre()
// no banco. As strings precisam bater ao caractere, senão o drill-down volta
// vazio ("Sem itens detalhados"). Já custou isso: o front pedia "Outras",
// "A revisar" e "Frete / Logística", mas a função emite "Outras / a
// classificar", "Pessoal/Creative (revisar)" e "Frete/Logística" (sem espaços).
const DESPESA_CATEGORIAS: Record<string, string | null> = {
  "Marketing / ADS": null, // ADS não vem da view de detalhe (vem de shopee_ads_diario)
  Pessoal: "Pessoal",
  Aluguel: "Aluguel",
  Administrativas: "Administrativas",
  Embalagem: "Embalagem",
  "Frete / Logística": "Frete/Logística",
  Financeiras: "Financeiras",
  Outras: "Outras / a classificar",
  "A revisar": "Pessoal/Creative (revisar)",
};

function DREPage() {
  const [dre, setDre] = useState<DreRow[]>([]);
  const [operacional, setOperacional] = useState<DreOperacionalRow[]>([]);
  const [deducoes, setDeducoes] = useState<DeducaoMktRow[]>([]);
  const [adsDet, setAdsDet] = useState<AdsMktRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [mesSel, setMesSel] = useState<string | undefined>();
  const [empresaSel, setEmpresaSel] = useState<EmpresaFiltro>("consolidado");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [detalhes, setDetalhes] = useState<Record<string, DespesaDetalheRow[]>>({});
  const [loadingDet, setLoadingDet] = useState<Set<string>>(new Set());
  const { perfil } = usePerfil();

  // Carrega (ou recarrega) os agregados do DRE. `silent` não mexe no skeleton —
  // usado após um override, pra atualizar os totais sem piscar a tela toda.
  const carregar = useCallback(async (silent?: boolean) => {
    if (!silent) setLoading(true);
    try {
      const [r1, r2, r3, r4] = await Promise.all([
        supabaseExternal.from("view_dre_mensal").select("*").gte("mes", "2026-05").order("mes", { ascending: true }),
        supabaseExternal.from("view_dre_operacional").select("*").gte("mes", "2026-05").order("mes", { ascending: true }),
        supabaseExternal.from("view_dre_deducoes_marketplace").select("*").gte("mes", "2026-05"),
        supabaseExternal.from("view_dre_ads_marketplace").select("mes,canal,gasto").gte("mes", "2026-05"),
      ]);
      if (r1.error) throw r1.error;
      if (r2.error) throw r2.error;
      const rows = (r1.data ?? []) as DreRow[];
      setDre(rows);
      setOperacional((r2.data ?? []) as DreOperacionalRow[]);
      if (!r3.error) setDeducoes((r3.data ?? []) as DeducaoMktRow[]);
      if (!r4.error) setAdsDet((r4.data ?? []) as AdsMktRow[]);
      setMesSel((prev) => prev ?? (rows.length ? rows[rows.length - 1].mes : undefined));
    } catch (e) {
      console.error(e);
      toast.error("Erro ao carregar DRE", { description: (e as Error).message });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Busca os itens de uma categoria (drill-down). Extraído de toggleDespesa
  // para poder re-buscar após um override.
  const fetchDetalhe = useCallback(
    async (label: string) => {
      const categoria = DESPESA_CATEGORIAS[label];
      if (!categoria || !mesSel) return;
      const key = `${mesSel}::${label}`;
      setLoadingDet((prev) => new Set(prev).add(key));
      try {
        const { data, error } = await supabaseExternal
          .from("view_dre_despesas_detalhe")
          .select("*")
          .eq("mes", mesSel)
          .eq("categoria", categoria)
          .order("valor_total", { ascending: false });
        if (error) throw error;
        setDetalhes((prev) => ({ ...prev, [key]: (data ?? []) as DespesaDetalheRow[] }));
      } catch (e) {
        console.error(e);
        toast.error("Erro ao carregar detalhamento", { description: (e as Error).message });
      } finally {
        setLoadingDet((prev) => {
          const n = new Set(prev);
          n.delete(key);
          return n;
        });
      }
    },
    [mesSel],
  );

  // Grava um override (reclassificar/excluir/restaurar) e recarrega totais +
  // os drill-downs abertos. Chave = tiny_id (sobrevive ao re-sync do Tiny).
  const aplicarOverride = useCallback(
    async (tinyId: number, patch: { categoria_override?: string | null; excluir?: boolean }) => {
      try {
        const { error } = await supabaseExternal.from("dre_conta_override").upsert(
          { tiny_id: tinyId, ...patch, editado_por: perfil?.nome ?? null, editado_em: new Date().toISOString() },
          { onConflict: "tiny_id" },
        );
        if (error) throw error;
        await carregar(true);
        const abertos = [...expanded].filter((k) => k.startsWith(`${mesSel}::`));
        setDetalhes({});
        for (const k of abertos) {
          const label = k.slice(`${mesSel}::`.length);
          if (DESPESA_CATEGORIAS[label]) await fetchDetalhe(label);
        }
        toast.success("DRE atualizado");
      } catch (e) {
        console.error(e);
        toast.error("Falha ao atualizar conta", { description: (e as Error).message });
      }
    },
    [perfil, carregar, expanded, mesSel, fetchDetalhe],
  );

  // Ao mudar mês, reseta expansões
  useEffect(() => {
    setExpanded(new Set());
  }, [mesSel, empresaSel]);

  const mesAtual = useMemo(() => dre.find((r) => r.mes === mesSel), [dre, mesSel]);
  const mesAnterior = useMemo(() => {
    const idx = dre.findIndex((r) => r.mes === mesSel);
    return idx > 0 ? dre[idx - 1] : undefined;
  }, [dre, mesSel]);

  const opAtual = useMemo(
    () =>
      empresaSel !== "consolidado"
        ? operacional.find((r) => r.mes === mesSel && r.empresa === empresaSel)
        : undefined,
    [operacional, mesSel, empresaSel],
  );

  // Séries mensais para as sparklines dos cards âncora.
  const series = useMemo(
    () => ({
      receita: dre.map((r) => r.receita_liquida ?? 0),
      mc: dre.map((r) => r.margem_contribuicao ?? 0),
      lucro: dre.map((r) => r.lucro_liquido ?? 0),
    }),
    [dre],
  );

  // ACZ/SVL do mês selecionado — alimenta o drill-down por empresa de
  // Receita Líquida e CMV (soma bate com o consolidado: mesma view).
  const porEmpresaMes = useMemo(() => {
    let acz: DreOperacionalRow | undefined;
    let svl: DreOperacionalRow | undefined;
    for (const r of operacional) {
      if (r.mes !== mesSel) continue;
      const e = (r.empresa ?? "").toLowerCase();
      if (e.includes("acz")) acz = r;
      else if (e.includes("svl")) svl = r;
    }
    return { acz, svl };
  }, [operacional, mesSel]);

  const deducoesMes = useMemo(
    () =>
      deducoes
        .filter((r) => r.mes === mesSel)
        .sort((a, b) => Number(b.total_deducao ?? 0) - Number(a.total_deducao ?? 0)),
    [deducoes, mesSel],
  );
  const adsMes = useMemo(
    () =>
      adsDet
        .filter((r) => r.mes === mesSel)
        .sort((a, b) => Number(b.gasto ?? 0) - Number(a.gasto ?? 0)),
    [adsDet, mesSel],
  );

  const toggleDespesa = (label: string) => {
    if (!mesSel) return;
    const key = `${mesSel}::${label}`;
    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
      setExpanded(next);
      return;
    }
    next.add(key);
    setExpanded(next);
    if (!DESPESA_CATEGORIAS[label]) return; // ADS/Receita/CMV sem drill via view de despesa
    if (detalhes[key]) return;
    void fetchDetalhe(label);
  };

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-[18px]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Consolidado ACZ Pet + SVL Store · comparação com o mês anterior
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <AvisosPopover />
          <Select value={empresaSel} onValueChange={(v) => setEmpresaSel(v as EmpresaFiltro)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="consolidado">Consolidado</SelectItem>
              <SelectItem value="ACZ Pet">ACZ Pet</SelectItem>
              <SelectItem value="SVL Store">SVL Store</SelectItem>
            </SelectContent>
          </Select>
          <Select value={mesSel} onValueChange={setMesSel}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Selecione o mês" />
            </SelectTrigger>
            <SelectContent>
              {dre.map((r) => (
                <SelectItem key={r.mes} value={r.mes}>
                  {formatMes(r.mes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[500px] w-full rounded-[14px]" />
      ) : !mesAtual ? (
        <Card className="p-12 text-center text-muted-foreground text-sm">Nenhum mês disponível.</Card>
      ) : empresaSel === "consolidado" ? (
        <>
          <DreHero row={mesAtual} prev={mesAnterior} series={series} />
          <DestinoDaReceita row={mesAtual} />
          <DreDetalhado
            row={mesAtual}
            prev={mesAnterior}
            porEmpresa={porEmpresaMes}
            deducoesMes={deducoesMes}
            adsMes={adsMes}
            expanded={expanded}
            detalhes={detalhes}
            loadingDet={loadingDet}
            onToggle={toggleDespesa}
            onOverride={aplicarOverride}
            mesSel={mesSel!}
          />
        </>
      ) : (
        <CascataEmpresa mes={mesSel!} empresa={empresaSel} row={opAtual} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Camada 1 — cards âncora (Receita líquida · Margem de contribuição · Lucro líquido)

function DreHero({
  row,
  prev,
  series,
}: {
  row: DreRow;
  prev: DreRow | undefined;
  series: { receita: number[]; mc: number[]; lucro: number[] };
}) {
  const receita = row.receita_liquida ?? 0;
  const mc = row.margem_contribuicao ?? 0;
  const lucro = row.lucro_liquido ?? 0;

  const cards = [
    {
      label: "Receita líquida",
      value: brlS(receita),
      pct: "100,0% da receita",
      delta: pctVar(receita, prev?.receita_liquida),
      color: "var(--color-primary)",
      spark: spark(series.receita),
      valueCls: "",
    },
    {
      label: "Margem de contribuição",
      value: brlS(mc),
      pct: `${pctStr(mc, receita)} da receita`,
      delta: pctVar(mc, prev?.margem_contribuicao),
      color: "#0E8A5F",
      spark: spark(series.mc),
      valueCls: "",
    },
    {
      label: "Lucro líquido",
      value: brlS(lucro),
      pct: `${pctStr(lucro, receita)} da receita`,
      delta: pctVar(lucro, prev?.lucro_liquido),
      color: lucro >= 0 ? "#0E8A5F" : "#C9432F",
      spark: spark(series.lucro),
      valueCls: lucro < 0 ? "text-destructive" : "",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-[14px]">
      {cards.map((c) => {
        const bom = c.delta != null && c.delta >= 0;
        return (
          <Card key={c.label} className="relative overflow-hidden p-0">
            <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: c.color }} />
            <div className="p-5 pl-6 flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2.5">
                <span className="text-[12.5px] font-semibold text-muted-foreground">{c.label}</span>
                <span
                  className={cn("text-[11.5px] font-semibold font-mono", bom ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}
                >
                  {sig(c.delta)}
                </span>
              </div>
              <div className={cn("text-[32px] font-semibold tracking-[-0.035em] tabular-nums leading-none", c.valueCls)}>
                {c.value}
              </div>
              <div className="flex items-end justify-between gap-3">
                <span className="text-[11.5px] text-muted-foreground font-medium">{c.pct}</span>
                {c.spark && (
                  <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="w-[110px] h-[30px] overflow-visible shrink-0">
                    <polyline points={c.spark} fill="none" stroke={c.color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  </svg>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Camada 2 — "Para onde vai cada R$ 1,00 de receita"

function DestinoDaReceita({ row }: { row: DreRow }) {
  const receita = row.receita_liquida ?? 0;
  const lucro = row.lucro_liquido ?? 0;

  const segmentos = [
    { label: "CMV", val: row.cmv ?? 0, color: "#7B8494" },
    { label: "Deduções marketplace", val: row.comissoes_frete ?? 0, color: "var(--color-primary)" },
    { label: "Impostos", val: row.impostos ?? 0, color: "#E0A72E" },
    { label: "ADS / Marketing", val: row.ads ?? 0, color: "#C9432F" },
    { label: "Pessoal", val: (row.pessoal ?? 0) + (row.creative_revisar ?? 0), color: "#2E9E8F" },
    {
      label: "Outras fixas",
      val: (row.aluguel ?? 0) + (row.administrativas ?? 0) + (row.embalagem ?? 0) + (row.frete_logistica ?? 0) + (row.financeiras ?? 0) + (row.outras ?? 0),
      color: "#4A7BD9",
    },
    { label: "Lucro líquido", val: lucro, color: "#0E8A5F" },
  ];

  const somaCustos = segmentos.slice(0, 6).reduce((a, s) => a + Math.max(0, s.val), 0);
  const base = Math.max(receita, somaCustos + Math.max(0, lucro), 1);

  const centavos = (val: number) => {
    const share = receita ? val / receita : 0;
    return `${share < 0 ? "−" : ""}R$ ${Math.abs(share).toFixed(2).replace(".", ",")}`;
  };

  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Para onde vai cada R$ 1,00 de receita</div>
        <div className="text-[12px] text-muted-foreground">Composição da receita líquida do período</div>
      </div>

      <div className="flex h-[66px] rounded-[10px] overflow-hidden gap-0.5">
        {segmentos.map((s) => {
          const w = (Math.max(0, s.val) / base) * 100;
          if (w <= 0) return null;
          const wide = w > 9;
          return (
            <div
              key={s.label}
              className="flex flex-col items-center justify-center gap-0.5 text-white overflow-hidden"
              style={{ width: `${w}%`, background: s.color }}
              title={`${s.label}: ${brlFull(s.val)}`}
            >
              {wide && <span className="text-[16px] font-semibold font-mono tracking-[-0.02em]">{w.toFixed(0)}%</span>}
              {wide && <span className="text-[11px] font-medium opacity-90 whitespace-nowrap">{s.label}</span>}
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3.5">
        {segmentos.map((s) => (
          <div key={s.label} className="flex flex-col gap-1.5 pt-2.5" style={{ borderTop: `2px solid ${s.color}` }}>
            <span className="text-[11.5px] font-medium text-muted-foreground">{s.label}</span>
            <span className="text-[14px] font-semibold font-mono tabular-nums">{centavos(s.val)}</span>
            <span className="text-[11px] text-muted-foreground font-mono">{brlS(s.val)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Camada 3 — DRE detalhado

type LinhaDre = {
  label: string;
  val: number;
  prevVal: number | null | undefined;
  kind: "h" | "s";
  drill: "empresa" | "categoria" | "marketplace" | "ads" | null;
};

function DreDetalhado({
  row,
  prev,
  porEmpresa,
  deducoesMes,
  adsMes,
  expanded,
  detalhes,
  loadingDet,
  onToggle,
  onOverride,
  mesSel,
}: {
  row: DreRow;
  prev: DreRow | undefined;
  porEmpresa: { acz?: DreOperacionalRow; svl?: DreOperacionalRow };
  deducoesMes: DeducaoMktRow[];
  adsMes: AdsMktRow[];
  expanded: Set<string>;
  detalhes: Record<string, DespesaDetalheRow[]>;
  loadingDet: Set<string>;
  onToggle: (label: string) => void;
  onOverride: (tinyId: number, patch: { categoria_override?: string | null; excluir?: boolean }) => void;
  mesSel: string;
}) {
  const receita = row.receita_liquida ?? 0;

  const opex: { label: string; val: number | null; prev: number | null | undefined }[] = [
    { label: "Marketing / ADS", val: row.ads, prev: prev?.ads },
    { label: "Pessoal", val: row.pessoal, prev: prev?.pessoal },
    { label: "Aluguel", val: row.aluguel, prev: prev?.aluguel },
    { label: "Administrativas", val: row.administrativas, prev: prev?.administrativas },
    { label: "Embalagem", val: row.embalagem, prev: prev?.embalagem },
    { label: "Frete / Logística", val: row.frete_logistica, prev: prev?.frete_logistica },
    { label: "Financeiras", val: row.financeiras, prev: prev?.financeiras },
    { label: "Outras", val: row.outras, prev: prev?.outras },
    { label: "A revisar", val: row.creative_revisar, prev: prev?.creative_revisar },
  ];

  const linhas: LinhaDre[] = [
    { label: "RECEITA LÍQUIDA", val: receita, prevVal: prev?.receita_liquida, kind: "h", drill: "empresa" },
    { label: "(−) CMV", val: row.cmv ?? 0, prevVal: prev?.cmv, kind: "s", drill: "empresa" },
    { label: "(−) Deduções Marketplace", val: row.comissoes_frete ?? 0, prevVal: prev?.comissoes_frete, kind: "s", drill: "marketplace" },
    { label: "(−) Impostos", val: row.impostos ?? 0, prevVal: prev?.impostos, kind: "s", drill: null },
    { label: "Margem de contribuição", val: row.margem_contribuicao ?? 0, prevVal: prev?.margem_contribuicao, kind: "h", drill: null },
    ...opex
      .filter((d) => (d.val ?? 0) !== 0)
      .map((d): LinhaDre => ({
        label: d.label,
        val: d.val ?? 0,
        prevVal: d.prev,
        kind: "s",
        drill: d.label === "Marketing / ADS" ? "ads" : "categoria",
      })),
    { label: "Custo fixo total", val: row.total_despesas ?? 0, prevVal: prev?.total_despesas, kind: "h", drill: null },
    { label: "Lucro líquido", val: row.lucro_liquido ?? 0, prevVal: prev?.lucro_liquido, kind: "h", drill: null },
  ];

  const maxAbs = Math.max(...linhas.map((l) => Math.abs(l.val)), 1);
  const GRID = "grid-cols-[minmax(200px,1.2fr)_130px_64px_minmax(120px,1fr)_84px]";

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-col gap-0.5 px-6 pt-5 pb-4">
        <div className="text-[14.5px] font-semibold tracking-[-0.015em]">DRE detalhado</div>
        <div className="text-[12px] text-muted-foreground">Consolidado ACZ Pet + SVL Store · comparação com o mês anterior</div>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Cabeçalho */}
          <div className={cn("grid items-center gap-4 px-6 pb-2.5 border-b border-border", GRID)}>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Linha</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground text-right">Valor</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground text-right">% rec.</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Peso relativo</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground text-right">vs. ant.</span>
          </div>

          {linhas.map((l) => {
            const isH = l.kind === "h";
            const drillKey = `${mesSel}::${l.label}`;
            const isOpen = expanded.has(drillKey);
            const hasDrill =
              l.drill === "empresa" ||
              l.drill === "marketplace" ||
              l.drill === "ads" ||
              (l.drill === "categoria" && DESPESA_CATEGORIAS[l.label] != null);
            const delta = pctVar(l.val, l.prevVal);
            const bom = isH ? (delta ?? 0) >= 0 : (delta ?? 0) <= 0;
            const barW = (Math.abs(l.val) / maxAbs) * 100;
            const isMcOuLucro = l.label === "Margem de contribuição" || l.label === "Lucro líquido";
            const barColor = isH ? (isMcOuLucro ? "#0E8A5F" : "var(--color-primary)") : "#D9DDE4";

            return (
              <div key={l.label} className={cn(isH && "bg-muted/40 border-t border-border")}>
                <button
                  type="button"
                  onClick={() => hasDrill && onToggle(l.label)}
                  disabled={!hasDrill}
                  className={cn(
                    "w-full grid items-center gap-4 px-6 text-left",
                    isH ? "py-3.5" : "py-2.5",
                    hasDrill ? "hover:bg-muted/60 cursor-pointer" : "cursor-default",
                    GRID,
                  )}
                >
                  <span
                    className={cn(
                      "flex items-center gap-1 min-w-0",
                      isH ? "text-[13.5px] font-semibold text-foreground" : "text-[13px] text-secondary-foreground",
                    )}
                    style={{ paddingLeft: isH ? 0 : 14 }}
                  >
                    {hasDrill ? (
                      isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <span className="w-3.5 shrink-0" />
                    )}
                    <span className="truncate">{l.label}</span>
                  </span>
                  <span
                    className={cn(
                      "text-right tabular-nums font-mono",
                      isH ? "text-[13.5px] font-semibold text-foreground" : "text-[13px] text-muted-foreground",
                    )}
                  >
                    {(l.val < 0 ? "−" : "") + brlS(Math.abs(l.val)).replace("−", "")}
                  </span>
                  <span className="text-[12px] text-muted-foreground text-right tabular-nums font-mono">
                    {pctStr(Math.abs(l.val), receita)}
                  </span>
                  <div className="h-2 rounded-md bg-muted overflow-hidden">
                    <div className="h-full rounded-md" style={{ width: `${barW}%`, background: barColor }} />
                  </div>
                  <span
                    className={cn(
                      "text-[12px] font-semibold text-right tabular-nums font-mono",
                      delta == null ? "text-muted-foreground" : bom ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
                    )}
                  >
                    {sig(delta)}
                  </span>
                </button>

                {isOpen && hasDrill && (
                  <div className="px-6 pb-3 pt-1 bg-muted/25">
                    <div className="ml-6 border-l border-border pl-4 py-1 space-y-0.5">
                      {l.drill === "empresa" ? (
                        <>
                          <SubEmpresa nome="ACZ Pet" valor={l.label === "(−) CMV" ? porEmpresa.acz?.cmv : porEmpresa.acz?.receita_liquida} receita={receita} />
                          <SubEmpresa nome="SVL Store" valor={l.label === "(−) CMV" ? porEmpresa.svl?.cmv : porEmpresa.svl?.receita_liquida} receita={receita} />
                        </>
                      ) : l.drill === "marketplace" ? (
                        <DrillDeducoes itens={deducoesMes} />
                      ) : l.drill === "ads" ? (
                        <DrillAds itens={adsMes} total={l.val} />
                      ) : (
                        <DrillCategoria itens={detalhes[drillKey]} loading={loadingDet.has(drillKey)} onOverride={onOverride} />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function DrillCategoria({
  itens,
  loading,
  onOverride,
}: {
  itens: DespesaDetalheRow[] | undefined;
  loading: boolean;
  onOverride: (tinyId: number, patch: { categoria_override?: string | null; excluir?: boolean }) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Carregando…
      </div>
    );
  }
  if (!itens || itens.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">Sem itens detalhados.</p>;
  }
  return (
    <>
      {itens.map((it, i) => (
        <ItemDespesa key={it.tiny_id ?? i} it={it} onOverride={onOverride} />
      ))}
    </>
  );
}

// Componentes que somam as "Deduções Marketplace", com a explicação de cada um.
// A soma (comissão + taxa serviço + frete + afiliados − ajuste + outras) = total_deducao,
// que por sua vez fecha com a linha do DRE (view_dre_deducoes_marketplace).
const DEDUCAO_LEGENDA: { key: keyof DeducaoMktRow; label: string; hint: string; credito?: boolean }[] = [
  { key: "comissao", label: "Comissão", hint: "Comissão do marketplace sobre a venda." },
  { key: "taxa_servico", label: "Taxa de serviço", hint: "Taxa de programa/serviço (ex.: Programa de Frete Grátis da Shopee)." },
  { key: "frete_vendedor", label: "Frete vendedor", hint: "Frete pago pelo vendedor (ocorre no Mercado Livre; na Shopee costuma ser zero)." },
  { key: "afiliados", label: "Afiliados", hint: "Comissão do programa de afiliados/creators." },
  { key: "ajuste_comercial", label: "Ajuste comercial", hint: "Crédito/reembolso do marketplace — reduz a dedução (entra como −).", credito: true },
  { key: "outras_escrow", label: "Outras (escrow)", hint: "Diferença entre o repasse real e as taxas acima: cashback em moedas, vouchers e ajustes de escrow." },
];

function DrillDeducoes({ itens }: { itens: DeducaoMktRow[] }) {
  if (!itens || itens.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">Sem deduções no mês.</p>;
  }
  return (
    <div className="py-1 space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[560px]">
          <thead className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1 pr-2">Canal</th>
              {DEDUCAO_LEGENDA.map((c) => (
                <th key={String(c.key)} className="text-right font-medium py-1 px-1.5 whitespace-nowrap">
                  {c.label}
                </th>
              ))}
              <th className="text-right font-medium py-1 pl-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((r) => (
              <tr key={r.canal} className="border-t border-border/50">
                <td className="py-1 pr-2 font-medium whitespace-nowrap">{r.canal}</td>
                {DEDUCAO_LEGENDA.map((c) => {
                  const v = Number(r[c.key] ?? 0);
                  return (
                    <td
                      key={String(c.key)}
                      className="text-right tabular-nums font-mono py-1 px-1.5 text-muted-foreground whitespace-nowrap"
                    >
                      {v === 0 ? "—" : (c.credito ? "−" : "") + brlFull(v)}
                    </td>
                  );
                })}
                <td className="text-right tabular-nums font-mono py-1 pl-2 font-semibold whitespace-nowrap">
                  {brlFull(r.total_deducao)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-0.5 text-[11px] text-muted-foreground">
        {DEDUCAO_LEGENDA.map((c) => (
          <li key={String(c.key)}>
            <span className="font-medium text-foreground/80">{c.label}:</span> {c.hint}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DrillAds({ itens, total }: { itens: AdsMktRow[]; total: number }) {
  const soma = itens.reduce((s, r) => s + Number(r.gasto ?? 0), 0);
  return (
    <div className="py-1 space-y-2">
      {itens.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sem gasto de ADS no mês.</p>
      ) : (
        <div className="space-y-0.5">
          {itens.map((r) => (
            <div key={r.canal} className="flex items-center justify-between gap-4 py-0.5 text-xs">
              <span className="text-muted-foreground">{r.canal}</span>
              <span className="tabular-nums font-mono text-foreground/80">{brlFull(r.gasto)}</span>
            </div>
          ))}
          {Math.abs(soma - total) > 0.5 && (
            <div className="flex items-center justify-between gap-4 py-0.5 text-xs border-t border-border/50">
              <span className="text-muted-foreground">Total no DRE</span>
              <span className="tabular-nums font-mono font-semibold">{brlFull(total)}</span>
            </div>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground border-t border-border/50 pt-1.5">
        Só a Shopee tem ADS integrado (por loja, acima). O gasto de anúncio do{" "}
        <span className="font-medium text-foreground/80">Mercado Livre</span> e demais canais ainda não
        entra no sistema — o marketing real é maior que o mostrado aqui.
      </p>
    </div>
  );
}

function SubEmpresa({
  nome,
  valor,
  receita,
}: {
  nome: string;
  valor: number | null | undefined;
  receita: number;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5 text-xs">
      <span className="text-muted-foreground">{nome}</span>
      <div className="flex items-center gap-6">
        <span className="tabular-nums font-mono text-foreground/80">{brlFull(valor)}</span>
        <span className="w-16 text-right tabular-nums font-mono text-muted-foreground">{pctStr(valor, receita)}</span>
      </div>
    </div>
  );
}

// Item de despesa no drill-down, com reclassificar (Select) e excluir/restaurar.
// A escrita vai para dre_conta_override (chave tiny_id), que sobrevive ao
// re-sync do Tiny em contas_pagar. Excluída aparece riscada com opção de voltar.
function ItemDespesa({
  it,
  onOverride,
}: {
  it: DespesaDetalheRow;
  onOverride: (tinyId: number, patch: { categoria_override?: string | null; excluir?: boolean }) => void;
}) {
  const excl = !!it.excluida;
  const tid = it.tiny_id;
  return (
    <div className={cn("flex items-center justify-between gap-2 py-0.5 text-xs", excl && "opacity-60")}>
      <div className="min-w-0 flex-1">
        <span className={cn("text-foreground", excl && "line-through")}>{it.fornecedor_nome ?? "—"}</span>
        {it.descricao && <span className="text-muted-foreground"> — {it.descricao}</span>}
      </div>
      <span className={cn("tabular-nums font-mono text-foreground/80 shrink-0", excl && "line-through")}>
        {brlFull(it.valor_total)}
      </span>
      {tid != null && (
        <div className="flex items-center gap-1 shrink-0">
          <Select
            value={it.categoria ?? undefined}
            onValueChange={(v) => onOverride(tid, { categoria_override: v === "__auto__" ? null : v })}
            disabled={excl}
          >
            <SelectTrigger className="h-6 w-[132px] text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__auto__" className="text-xs italic">
                — automático
              </SelectItem>
              {DRE_CATEGORIAS_EDIT.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {excl ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Restaurar no DRE"
              onClick={() => onOverride(tid, { excluir: false })}
            >
              <RotateCcw className="h-3 w-3" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              title="Excluir do DRE"
              onClick={() => onOverride(tid, { excluir: true })}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modo empresa (ACZ/SVL) — só vai até a margem de contribuição

function CascataEmpresa({
  mes,
  empresa,
  row,
}: {
  mes: string;
  empresa: string;
  row: DreOperacionalRow | undefined;
}) {
  if (!row) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        Sem dados para {empresa} em {formatMes(mes)}.
      </Card>
    );
  }

  const receita = row.receita_liquida ?? 0;
  const mc = row.margem_contribuicao ?? 0;

  const linhas = [
    { label: "Receita líquida", val: receita, h: true },
    { label: "(−) CMV", val: row.cmv ?? 0, h: false },
    { label: "(−) Deduções Marketplace", val: row.comissoes_frete ?? 0, h: false },
    { label: "(−) Impostos", val: row.impostos ?? 0, h: false },
  ];

  return (
    <Card className="p-6 flex flex-col gap-1">
      <div className="flex flex-col gap-0.5 mb-3">
        <div className="text-[14.5px] font-semibold tracking-[-0.015em]">
          {formatMes(mes)} — {empresa}
        </div>
        <div className="text-[12px] text-muted-foreground">{row.pedidos ?? 0} pedidos no mês</div>
      </div>

      {linhas.map((l) => (
        <div key={l.label} className="flex items-center justify-between gap-4 py-1.5 border-b border-border/60 last:border-0">
          <span className={cn(l.h ? "text-[13.5px] font-semibold" : "text-[13px] text-muted-foreground")}>{l.label}</span>
          <div className="flex items-center gap-6">
            <span className={cn("tabular-nums font-mono", l.h && "font-semibold")}>{brlFull(l.val)}</span>
            <span className="text-xs w-16 text-right tabular-nums font-mono text-muted-foreground">{pctStr(Math.abs(l.val), receita)}</span>
          </div>
        </div>
      ))}

      <div className="mt-2 rounded-[10px] bg-[#F0F8F4] dark:bg-emerald-950/30 border border-[#D3EBE0] dark:border-emerald-900 px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[15px] font-semibold text-[#0E7A54] dark:text-emerald-400">= Margem de contribuição</span>
          <div className="flex items-center gap-6">
            <span className="text-[17px] font-semibold tabular-nums font-mono text-[#0E7A54] dark:text-emerald-400">{brlFull(mc)}</span>
            <span className="text-sm w-16 text-right tabular-nums font-mono text-[#0E7A54] dark:text-emerald-400">{pctStr(mc, receita)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-[10px] border border-dashed border-border p-3 text-xs text-muted-foreground flex gap-2 items-start">
        <Info className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          Despesas fixas (ADS, Pessoal, Aluguel, etc.) não são separadas por empresa — veja o Lucro Líquido no modo <strong>Consolidado</strong>.
        </span>
      </div>
    </Card>
  );
}

function AvisosPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Info className="h-4 w-4" />
          Ressalvas
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 text-sm space-y-3">
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">Backfill em andamento</p>
          <p>A receita de meses anteriores pode estar incompleta enquanto o histórico de repasses é processado. Junho é o mês mais completo.</p>
        </div>
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">ADS parcial</p>
          <p>O gasto com publicidade cobre apenas a Shopee e a partir de 16/06. Maio não tem ADS lançado, e o ADS do Mercado Livre ainda não está integrado.</p>
        </div>
        <div>
          <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-1">CMV</p>
          <p>O resultado considera apenas pedidos com custo de produto cadastrado. Pedidos sem custo ficam de fora (mesma regra dos Pedidos Integrados).</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
