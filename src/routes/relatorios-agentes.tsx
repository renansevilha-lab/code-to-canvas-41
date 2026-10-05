import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, FileText, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// ============================================================================
// Relatórios dos agentes (05/out/2026). Hoje só o agente "financeiro": a
// função financeiro_relatorio_diario() monta o JSON (`resumo`) e o agente grava
// em relatorios_agentes (resumo + corpo_html). Esta tela SÓ EXIBE — todos os
// números já vêm prontos no JSON; nada é somado aqui.
// Último relatório: view_relatorio_agente_ultimo. Anteriores: relatorios_agentes
// por data_referencia (seletor no canto, data na URL).
// ============================================================================

const AGENTE = "financeiro";

interface Faixa { qtd?: number; valor?: number }
interface Urgente {
  tiny_id?: number | null;
  fornecedor?: string | null;
  descricao?: string | null;
  valor?: number | null;
  vencimento?: string | null;
  dias?: number | null;
  faixa?: string | null;
}
interface Resumo {
  carteira_total?: { saldo_em_conta?: number; a_receber?: number };
  contas_pagar_resumo?: { atrasado?: Faixa; hoje?: Faixa; ate_7d?: Faixa; ate_30d?: Faixa };
  contas_pagar_urgentes?: Urgente[];
  fluxo_resumo?: { pior_acumulado?: number | null; dia_pior_acumulado?: string | null };
}
interface Relatorio {
  id: number;
  agente: string;
  data_referencia: string;
  gerado_em: string | null;
  resumo: Resumo | null;
  corpo_html: string | null;
}

interface SearchParams { data?: string }

export const Route = createFileRoute("/relatorios-agentes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    data: typeof s.data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.data) ? s.data : undefined,
  }),
  component: RelatoriosAgentesPage,
});

// Data pura (YYYY-MM-DD) → dd/mm/aaaa sem `new Date()` (o fuso jogaria o dia para trás).
function dataBR(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : iso;
}
function horaBR(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
const n = (x: unknown): number => {
  const v = Number(x ?? 0);
  return Number.isFinite(v) ? v : 0;
};

const FAIXA: Record<string, { label: string; cls: string }> = {
  atrasado: { label: "Atrasado", cls: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300" },
  hoje: { label: "Vence hoje", cls: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300" },
  ate_7d: { label: "Até 7 dias", cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300" },
};

function RelatoriosAgentesPage() {
  const { data: dataSel } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Datas disponíveis (para o seletor).
  const datasQ = useQuery({
    queryKey: ["relatorios-agentes", AGENTE, "datas"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("relatorios_agentes")
        .select("data_referencia")
        .eq("agente", AGENTE)
        .order("data_referencia", { ascending: false })
        .limit(180);
      if (error) throw error;
      return [...new Set((data ?? []).map((r: { data_referencia: string }) => r.data_referencia))];
    },
  });

  // Relatório exibido: o último (view) ou o da data escolhida.
  const relQ = useQuery({
    queryKey: ["relatorios-agentes", AGENTE, "rel", dataSel ?? "ultimo"],
    queryFn: async (): Promise<Relatorio | null> => {
      const q = dataSel
        ? supabaseExternal.from("relatorios_agentes").select("*")
            .eq("agente", AGENTE).eq("data_referencia", dataSel)
            .order("gerado_em", { ascending: false }).limit(1)
        : supabaseExternal.from("view_relatorio_agente_ultimo").select("*")
            .eq("agente", AGENTE).limit(1);
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as Relatorio | null;
    },
  });

  const rel = relQ.data;
  const r = rel?.resumo ?? {};
  const cp = r.contas_pagar_resumo ?? {};
  const urgentes = r.contas_pagar_urgentes ?? [];
  const datas = datasQ.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Cabeçalho + seletor de data */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" /> Relatórios dos agentes
          </h1>
          <span className="text-sm text-muted-foreground">
            Agente financeiro
            {rel ? ` · referência ${dataBR(rel.data_referencia)}` : ""}
            {rel?.gerado_em ? ` · gerado ${horaBR(rel.gerado_em)}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <Select
            value={dataSel ?? "__ultimo__"}
            onValueChange={(v) => navigate({ search: { data: v === "__ultimo__" ? undefined : v }, replace: true })}
            disabled={datas.length === 0}
          >
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Data do relatório" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__ultimo__">Último relatório</SelectItem>
              {datas.map((d) => (
                <SelectItem key={d} value={d}>{dataBR(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {relQ.isLoading && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando relatório…
        </div>
      )}
      {relQ.error && (
        <Card className="p-4 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Erro ao carregar: {(relQ.error as Error).message}
        </Card>
      )}
      {!relQ.isLoading && !relQ.error && !rel && (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          {dataSel ? `Nenhum relatório do agente financeiro em ${dataBR(dataSel)}.` : "O agente financeiro ainda não gravou nenhum relatório."}
        </Card>
      )}

      {rel && (
        <>
          {/* Cards — valores prontos do JSON */}
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <Kpi titulo="Saldo em conta" valor={r.carteira_total?.saldo_em_conta} />
            <Kpi titulo="A receber" valor={r.carteira_total?.a_receber} />
            <Kpi titulo="Contas atrasadas" valor={cp.atrasado?.valor} sub={cp.atrasado?.qtd != null ? `${formatNumber(n(cp.atrasado.qtd))} conta(s)` : undefined}
              tom={n(cp.atrasado?.valor) > 0 ? "red" : undefined} />
            <Kpi titulo="A pagar em até 7 dias" valor={cp.ate_7d?.valor} sub={cp.ate_7d?.qtd != null ? `${formatNumber(n(cp.ate_7d.qtd))} conta(s)` : undefined} />
            <Kpi titulo="A pagar em até 30 dias" valor={cp.ate_30d?.valor} sub={cp.ate_30d?.qtd != null ? `${formatNumber(n(cp.ate_30d.qtd))} conta(s)` : undefined} />
            <Kpi titulo="Pior saldo projetado (30 d)" valor={r.fluxo_resumo?.pior_acumulado}
              sub={r.fluxo_resumo?.dia_pior_acumulado ? `em ${dataBR(r.fluxo_resumo.dia_pior_acumulado)}` : undefined}
              tom={n(r.fluxo_resumo?.pior_acumulado) < 0 ? "red" : undefined} />
          </div>

          {/* Contas urgentes */}
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <span className="text-sm font-bold">Contas a pagar urgentes</span>
              <span className="text-xs text-muted-foreground">atrasadas, vencendo hoje e nos próximos 7 dias</span>
            </div>
            {urgentes.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Nenhuma conta urgente neste relatório.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
                      <th className="py-2 px-4 font-semibold">Fornecedor</th>
                      <th className="py-2 px-3 font-semibold">Descrição</th>
                      <th className="py-2 px-3 font-semibold text-right">Valor</th>
                      <th className="py-2 px-3 font-semibold">Vencimento</th>
                      <th className="py-2 px-3 font-semibold text-right">Dias</th>
                      <th className="py-2 px-4 font-semibold">Faixa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {urgentes.map((u, i) => {
                      const f = FAIXA[u.faixa ?? ""] ?? { label: u.faixa ?? "—", cls: "bg-muted text-muted-foreground" };
                      const dias = u.dias == null ? null : n(u.dias);
                      return (
                        <tr key={`${u.tiny_id ?? i}-${i}`} className="border-b last:border-0 align-top">
                          <td className="py-2 px-4 font-medium max-w-[260px]">{u.fornecedor ?? "—"}</td>
                          <td className="py-2 px-3 text-muted-foreground max-w-[360px]">{u.descricao ?? "—"}</td>
                          <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">{formatBRL(n(u.valor))}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{dataBR(u.vencimento)}</td>
                          <td className={cn("py-2 px-3 text-right tabular-nums whitespace-nowrap", dias != null && dias < 0 && "text-red-700 dark:text-red-400 font-semibold")}>
                            {dias == null ? "—" : dias < 0 ? `${formatNumber(-dias)} atrasado` : dias === 0 ? "hoje" : formatNumber(dias)}
                          </td>
                          <td className="py-2 px-4">
                            <span className={cn("text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap", f.cls)}>{f.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Corpo do relatório (HTML do agente) */}
          {rel.corpo_html ? (
            <Card className="p-0 overflow-hidden">
              <div className="px-4 py-3 border-b text-sm font-bold">Relatório completo</div>
              <div className="overflow-x-auto bg-white">
                <CorpoHtml key={rel.id} html={rel.corpo_html} />
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

function Kpi({ titulo, valor, sub, tom }: { titulo: string; valor: number | null | undefined; sub?: string; tom?: "red" }) {
  return (
    <Card className={cn("px-4 py-3 flex flex-col gap-1", tom === "red" && "border-red-300 dark:border-red-900 bg-red-500/5")}>
      <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{titulo}</span>
      <span className={cn("text-xl font-extrabold tabular-nums leading-tight", tom === "red" && "text-red-700 dark:text-red-400")}>
        {valor == null ? "—" : formatBRL(n(valor))}
      </span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </Card>
  );
}

// O HTML do agente vai num iframe SEM scripts (sandbox sem allow-scripts): os
// estilos dele não vazam para o app e texto vindo do Tiny (nome de fornecedor,
// descrição) não executa nada. allow-same-origin só para medir a altura/largura
// e o container de fora fazer a rolagem horizontal.
function CorpoHtml({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [tam, setTam] = useState<{ h: number; w: number | null }>({ h: 400, w: null });
  function medir() {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const el = doc.documentElement;
    const h = Math.max(el.scrollHeight, doc.body?.scrollHeight ?? 0);
    const w = Math.max(el.scrollWidth, doc.body?.scrollWidth ?? 0);
    setTam({ h: h + 8, w: w > (ref.current?.parentElement?.clientWidth ?? 0) ? w : null });
  }
  return (
    <iframe
      ref={ref}
      title="Relatório do agente"
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={medir}
      className="block border-0"
      style={{ height: tam.h, width: tam.w ? `${tam.w}px` : "100%" }}
    />
  );
}
