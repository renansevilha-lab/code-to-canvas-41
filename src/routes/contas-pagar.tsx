import { BotaoSincronizar } from "@/components/BotaoSincronizar";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { SyncStatusFooter } from "@/components/SyncStatusFooter";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

type FiltroKey = "todas" | "vencido" | "hoje" | "a_vencer" | "pagas";
const VALID_FILTROS: FiltroKey[] = ["todas", "vencido", "hoje", "a_vencer", "pagas"];

type SearchParams = { filtro: FiltroKey; q: string };

export const Route = createFileRoute("/contas-pagar")({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    filtro: VALID_FILTROS.includes(search.filtro as FiltroKey) ? (search.filtro as FiltroKey) : "todas",
    q: typeof search.q === "string" ? search.q : "",
  }),
  component: ContasPagarPage,
});

type Conta = {
  id: string;
  numero_documento: string | null;
  fornecedor_nome: string | null;
  descricao: string | null;
  categoria: string | null;
  valor_total: number;
  valor_pago: number | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  status: string;
};

const PAGE_SIZE = 1000;

// ── Helpers de status (mesma semântica da versão anterior) ──────────────────
function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function isOpen(c: Conta): boolean {
  return c.status === "aberto" || c.status === "parcial";
}
function isPaid(c: Conta): boolean {
  return c.status === "paga" || c.status === "pago" || c.status === "liquidado";
}
function getSaldo(c: Conta): number {
  return Math.max(Number(c.valor_total ?? 0) - Number(c.valor_pago ?? 0), 0);
}
// Dias até o vencimento: negativo = vencido, 0 = hoje, positivo = a vencer.
function diasVenc(c: Conta): number | null {
  if (!c.data_vencimento) return null;
  const today = new Date(`${toDateKey(new Date())}T00:00:00`);
  const venc = new Date(`${c.data_vencimento}T00:00:00`);
  return Math.round((venc.getTime() - today.getTime()) / 86400000);
}
function dataDeDias(d: number): string {
  const x = new Date();
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + d);
  return `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`;
}

async function fetchAllContas(): Promise<Conta[]> {
  const rows: Conta[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabaseExternal
      .from("contas_pagar")
      .select(
        "id,numero_documento,fornecedor_nome,descricao,categoria,valor_total,valor_pago,data_emissao,data_vencimento,data_pagamento,status",
      )
      .order("data_vencimento", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as Conta[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

// Cores de categoria (design v2) + paleta de fallback.
const CAT_CORES: Record<string, string> = {
  Mercadoria: "var(--color-primary)",
  Pessoal: "#2E9E8F",
  Ocupação: "#4A7BD9",
  Aluguel: "#4A7BD9",
  Frete: "#E0A72E",
  "Frete/Logística": "#E0A72E",
  Marketing: "#C9432F",
  Serviços: "#7B8494",
  Software: "#B8BEC8",
};
const CAT_PALETTE = ["var(--color-primary)", "#2E9E8F", "#4A7BD9", "#E0A72E", "#C9432F", "#7B8494", "#B8BEC8", "#8A93A3"];

function ContasPagarPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/contas-pagar" });
  const filtro = search.filtro;
  const q = search.q;

  const [contas, setContas] = useState<Conta[]>([]);
  const [loading, setLoading] = useState(true);
  const [buscaDraft, setBuscaDraft] = useState(q);
  // Incrementado pelo botão "Sincronizar" para reler as contas depois do sync.
  const [recarga, setRecarga] = useState(0);

  const setSearch = (next: Partial<SearchParams>) =>
    navigate({ search: { ...search, ...next }, replace: true });

  useEffect(() => setBuscaDraft(q), [q]);
  useEffect(() => {
    const next = buscaDraft.trim();
    if (next === q) return;
    const t = setTimeout(() => setSearch({ q: next }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buscaDraft]);

  // Fonte única: banco externo vhogjofsxyhnyxdyglmq, tabela contas_pagar.
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await fetchAllContas();
        if (!cancel) setContas(rows);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [recarga]);

  // Universo em aberto (aberto + parcial), cada uma com dias e saldo.
  const abertas = useMemo(
    () => contas.filter(isOpen).map((c) => ({ c, dias: diasVenc(c), saldo: getSaldo(c) })),
    [contas],
  );
  const pagas = useMemo(() => contas.filter(isPaid), [contas]);

  const soma = (arr: { saldo: number }[]) => arr.reduce((a, x) => a + x.saldo, 0);

  const vencidas = useMemo(() => abertas.filter((x) => x.dias != null && x.dias < 0), [abertas]);
  const hojeArr = useMemo(() => abertas.filter((x) => x.dias === 0), [abertas]);
  const sete = useMemo(() => abertas.filter((x) => x.dias != null && x.dias > 0 && x.dias <= 7), [abertas]);
  const maxAtraso = useMemo(
    () => vencidas.reduce((m, x) => Math.max(m, Math.abs(x.dias ?? 0)), 0),
    [vencidas],
  );

  const kpis = [
    {
      key: "vencido",
      label: "Vencido",
      value: formatBRL(soma(vencidas), { compact: true }),
      sub: `${formatNumber(vencidas.length)} títulos${maxAtraso > 0 ? ` · maior atraso ${maxAtraso}d` : ""}`,
      tone: "danger" as const,
    },
    {
      key: "hoje",
      label: "Vence hoje",
      value: formatBRL(soma(hojeArr), { compact: true }),
      sub: `${formatNumber(hojeArr.length)} títulos a liquidar`,
      tone: "warning" as const,
    },
    {
      key: "sete",
      label: "Próximos 7 dias",
      value: formatBRL(soma(sete), { compact: true }),
      sub: `${formatNumber(sete.length)} títulos programados`,
      tone: "plain" as const,
    },
    {
      key: "total",
      label: "Total em aberto",
      value: formatBRL(soma(abertas), { compact: true }),
      sub: `${formatNumber(abertas.length)} títulos`,
      tone: "plain" as const,
    },
  ];

  // Desembolso previsto — 4 semanas (vencidos somados à semana atual).
  const fluxo = useMemo(() => {
    const semanas: [number, number, string][] = [
      [0, 6, "Esta semana"],
      [7, 13, "Semana 2"],
      [14, 20, "Semana 3"],
      [21, 27, "Semana 4"],
    ];
    const totalVencidas = soma(vencidas);
    const raw = semanas.map(([a, b, label]) => ({
      label,
      periodo: `${dataDeDias(a)} – ${dataDeDias(b)}`,
      valor: soma(abertas.filter((x) => x.dias != null && x.dias >= a && x.dias <= b)),
      atraso: a === 0 ? totalVencidas : 0,
    }));
    const max = Math.max(...raw.map((f) => f.valor + f.atraso), 1);
    return raw.map((f) => ({
      ...f,
      total: formatBRL(f.valor + f.atraso, { compact: true }),
      w: (f.valor / max) * 100,
      wAtraso: (f.atraso / max) * 100,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abertas, vencidas]);

  // Por categoria — top 7 + "Outras".
  const categorias = useMemo(() => {
    const agg = new Map<string, number>();
    for (const x of abertas) {
      const nome = x.c.categoria?.trim() || "Sem categoria";
      agg.set(nome, (agg.get(nome) ?? 0) + x.saldo);
    }
    const total = soma(abertas) || 1;
    const ordenado = [...agg.entries()].sort((a, b) => b[1] - a[1]);
    const top = ordenado.slice(0, 7);
    const resto = ordenado.slice(7).reduce((a, [, v]) => a + v, 0);
    const linhas = top.map(([nome, valor], i) => ({
      nome,
      valor,
      color: CAT_CORES[nome] ?? CAT_PALETTE[i % CAT_PALETTE.length],
      pct: (valor / total) * 100,
    }));
    if (resto > 0) linhas.push({ nome: "Outras", valor: resto, color: "#8A93A3", pct: (resto / total) * 100 });
    return { linhas, total };
  }, [abertas]);

  const chips: { key: FiltroKey; label: string; count: number; tone: "danger" | "warning" | "info" | "success" | "plain" }[] = [
    { key: "todas", label: "Todas", count: abertas.length, tone: "plain" },
    { key: "vencido", label: "Vencido", count: vencidas.length, tone: "danger" },
    { key: "hoje", label: "Vence hoje", count: hojeArr.length, tone: "warning" },
    { key: "a_vencer", label: "A vencer", count: abertas.filter((x) => x.dias != null && x.dias > 0).length, tone: "info" },
    { key: "pagas", label: "Pagas", count: pagas.length, tone: "success" },
  ];

  // Tabela: aplica chip + busca, ordena por dias asc (mais atrasado primeiro).
  const linhasTabela = useMemo(() => {
    let base: { c: Conta; dias: number | null; saldo: number }[];
    if (filtro === "pagas") {
      base = pagas.map((c) => ({ c, dias: diasVenc(c), saldo: getSaldo(c) }));
    } else {
      base = abertas.filter((x) => {
        if (filtro === "vencido") return x.dias != null && x.dias < 0;
        if (filtro === "hoje") return x.dias === 0;
        if (filtro === "a_vencer") return x.dias != null && x.dias > 0;
        return true;
      });
    }
    const term = q.trim().toLowerCase();
    if (term) {
      base = base.filter(
        (x) =>
          x.c.fornecedor_nome?.toLowerCase().includes(term) ||
          x.c.numero_documento?.toLowerCase().includes(term) ||
          x.c.descricao?.toLowerCase().includes(term) ||
          x.c.categoria?.toLowerCase().includes(term),
      );
    }
    return [...base].sort((a, b) => {
      const da = a.dias ?? 9999;
      const db = b.dias ?? 9999;
      return da - db;
    });
  }, [abertas, pagas, filtro, q]);

  const GRID = "grid-cols-[6px_minmax(200px,1.4fr)_130px_120px_140px_130px_120px]";

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SyncStatusFooter area="contas_pagar" />
        <BotaoSincronizar
          rotulo="Sincronizar contas"
          titulo="Puxa as contas a pagar do Tiny agora. O cron faz isso 1x por dia (madrugada)."
          rotas={["tiny-sync-contas-pagar?modulo=contas&limite=5000"]}
          onConcluido={() => setRecarga((n) => n + 1)}
        />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[14px]">
        {kpis.map((k) => (
          <PagKpiCard key={k.key} label={k.label} value={k.value} sub={k.sub} tone={k.tone} loading={loading} />
        ))}
      </div>

      {/* Desembolso previsto + Por categoria */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.3fr_1fr] gap-4 items-start">
        <Card className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Desembolso previsto</div>
            <div className="text-[12px] text-muted-foreground">Próximas 4 semanas · vencidos somados à semana atual</div>
          </div>
          <div className="flex flex-col gap-3">
            {fluxo.map((f) => (
              <div key={f.label} className="grid grid-cols-[110px_1fr_110px] items-center gap-3.5">
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-medium">{f.label}</span>
                  <span className="text-[11px] text-muted-foreground font-mono">{f.periodo}</span>
                </div>
                <div className="flex h-[26px] rounded-[7px] bg-muted overflow-hidden gap-0.5">
                  {f.wAtraso > 0 && <div style={{ width: `${f.wAtraso}%`, background: "#C9432F" }} className="rounded-l-[5px]" />}
                  {f.w > 0 && <div style={{ width: `${f.w}%`, background: "var(--color-primary)" }} className="rounded-[5px]" />}
                </div>
                <span className="text-[13px] font-semibold text-right tabular-nums font-mono">{f.total}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 pt-1">
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "#C9432F" }} /> Em atraso
            </span>
            <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--color-primary)" }} /> A vencer no período
            </span>
          </div>
        </Card>

        <Card className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <div className="text-[14.5px] font-semibold tracking-[-0.015em]">Por categoria</div>
            <div className="text-[12px] text-muted-foreground">{formatBRL(categorias.total, { compact: true })} em aberto</div>
          </div>
          {categorias.linhas.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nada em aberto.</p>
          ) : (
            <>
              <div className="flex h-2.5 rounded-md overflow-hidden gap-0.5">
                {categorias.linhas.map((c) => (
                  <div key={c.nome} style={{ width: `${c.pct}%`, background: c.color }} />
                ))}
              </div>
              <div className="flex flex-col">
                {categorias.linhas.map((c) => (
                  <div key={c.nome} className="grid grid-cols-[10px_1fr_auto_52px] items-center gap-2.5 py-[9px] border-b border-border last:border-0">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />
                    <span className="text-[12.5px] font-medium truncate" title={c.nome}>{c.nome}</span>
                    <span className="text-[12.5px] text-muted-foreground tabular-nums font-mono">{formatBRL(c.valor, { compact: true })}</span>
                    <span className="text-[12.5px] text-muted-foreground text-right tabular-nums font-mono">{c.pct.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Chips de filtro + busca */}
      <div className="flex items-center gap-2.5 flex-wrap">
        {chips.map((chip) => (
          <FiltroChip
            key={chip.key}
            label={chip.label}
            count={chip.count}
            tone={chip.tone}
            active={filtro === chip.key}
            onClick={() => setSearch({ filtro: chip.key })}
          />
        ))}
        <div className="flex-1" />
        <div className="relative w-full sm:w-auto sm:min-w-[260px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={buscaDraft}
            onChange={(e) => setBuscaDraft(e.target.value)}
            placeholder="Buscar fornecedor, documento ou categoria…"
            className="pl-8 h-9 bg-card"
          />
        </div>
      </div>

      {/* Tabela */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : linhasTabela.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">Nenhuma conta neste filtro.</div>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[840px]">
              <div className={cn("grid items-center bg-muted/40 border-b border-border pr-5", GRID)}>
                <span />
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3 pl-4">Fornecedor</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3">Categoria</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3">Documento</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3">Vencimento</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3 text-right">Valor</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground px-3 py-3 text-right">Status</span>
              </div>
              {linhasTabela.map(({ c, dias, saldo }) => (
                <ContaRow key={c.id} c={c} dias={dias} saldo={saldo} paga={isPaid(c)} grid={GRID} />
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function PagKpiCard({
  label,
  value,
  sub,
  tone,
  loading,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "danger" | "warning" | "plain";
  loading: boolean;
}) {
  const toneCls = {
    danger: "bg-destructive/5 border-destructive/25",
    warning: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/60",
    plain: "",
  }[tone];
  const valueCls = {
    danger: "text-destructive",
    warning: "text-amber-700 dark:text-amber-400",
    plain: "",
  }[tone];
  const labelCls = {
    danger: "text-destructive",
    warning: "text-amber-700 dark:text-amber-400",
    plain: "text-muted-foreground",
  }[tone];
  return (
    <Card className={cn("p-4 flex flex-col gap-2", toneCls)}>
      <span className={cn("text-[12.5px] font-semibold", labelCls)}>{label}</span>
      {loading ? (
        <Skeleton className="h-7 w-28" />
      ) : (
        <span className={cn("text-[30px] font-semibold tracking-[-0.035em] tabular-nums leading-none", valueCls)}>{value}</span>
      )}
      <span className="text-[11.5px] text-muted-foreground">{sub}</span>
    </Card>
  );
}

function FiltroChip({
  label,
  count,
  tone,
  active,
  onClick,
}: {
  label: string;
  count: number;
  tone: "danger" | "warning" | "info" | "success" | "plain";
  active: boolean;
  onClick: () => void;
}) {
  const activeBg = {
    danger: "#C9432F",
    warning: "#B7791F",
    info: "#4A7BD9",
    success: "#0E8A5F",
    plain: "#0E1114",
  }[tone];
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-[9px] border pl-3.5 pr-2 py-[7px] text-[12.5px] font-semibold transition-[filter]",
        active ? "text-white border-transparent hover:brightness-[.97]" : "bg-card text-secondary-foreground border-border hover:border-[#C9CFD8]",
      )}
      style={active ? { background: activeBg } : undefined}
    >
      <span>{label}</span>
      <span
        className={cn("rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold font-mono tabular-nums", !active && "bg-muted text-muted-foreground")}
        style={active ? { background: "rgba(255,255,255,.22)" } : undefined}
      >
        {count}
      </span>
    </button>
  );
}

function ContaRow({
  c,
  dias,
  saldo,
  paga,
  grid,
}: {
  c: Conta;
  dias: number | null;
  saldo: number;
  paga: boolean;
  grid: string;
}) {
  const info = statusInfo(dias, paga);
  return (
    <div className={cn("grid items-center border-b border-border last:border-0 hover:bg-muted/40 pr-5", grid)}>
      <span className="self-stretch" style={{ background: info.stripe }} />
      <div className="px-3 py-3 pl-4 min-w-0">
        <div className="text-[13px] font-medium truncate" title={c.fornecedor_nome ?? "—"}>{c.fornecedor_nome ?? "—"}</div>
        {c.descricao && <div className="text-[11px] text-muted-foreground truncate">{c.descricao}</div>}
      </div>
      <span className="px-3 py-3 text-[12.5px] text-secondary-foreground truncate" title={c.categoria ?? ""}>
        {c.categoria ?? "—"}
      </span>
      <span className="px-3 py-3 text-[12.5px] text-muted-foreground font-mono truncate">{c.numero_documento ?? "—"}</span>
      <div className="px-3 py-2.5 flex flex-col">
        <span className="text-[12.5px] font-mono tabular-nums">{c.data_vencimento ? formatDate(c.data_vencimento) : "—"}</span>
        <span className="text-[11px]" style={{ color: info.prazoColor }}>{info.prazo}</span>
      </div>
      <span className="px-3 py-3 text-[13px] font-semibold text-right tabular-nums font-mono">{formatBRL(saldo)}</span>
      <div className="px-3 py-3 flex justify-end">
        <span className={cn("text-[11.5px] font-medium px-2.5 py-1 rounded-full whitespace-nowrap", info.pillCls)}>{info.label}</span>
      </div>
    </div>
  );
}

function statusInfo(dias: number | null, paga: boolean): {
  label: string;
  stripe: string;
  pillCls: string;
  prazo: string;
  prazoColor: string;
} {
  if (paga) {
    return {
      label: "Paga",
      stripe: "#0E8A5F",
      pillCls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      prazo: "liquidada",
      prazoColor: "var(--color-muted-foreground)",
    };
  }
  if (dias == null) {
    return { label: "Sem venc.", stripe: "#8A93A3", pillCls: "bg-muted text-muted-foreground", prazo: "—", prazoColor: "var(--color-muted-foreground)" };
  }
  if (dias < 0) {
    return {
      label: "Vencido",
      stripe: "#C9432F",
      pillCls: "bg-red-500/15 text-red-700 dark:text-red-300",
      prazo: `${Math.abs(dias)} dias em atraso`,
      prazoColor: "#C9432F",
    };
  }
  if (dias === 0) {
    return {
      label: "Vence hoje",
      stripe: "#E0A72E",
      pillCls: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      prazo: "hoje",
      prazoColor: "#96631A",
    };
  }
  return {
    label: "A vencer",
    stripe: "#8A93A3",
    pillCls: "bg-muted text-muted-foreground",
    prazo: `em ${dias} dias`,
    prazoColor: "var(--color-muted-foreground)",
  };
}
