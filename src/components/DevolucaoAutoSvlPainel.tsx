// ============================================================================
// Painel da automação de NF de devolução da SVL (edge fn `devolucao-auto`).
// O motor CRIA a devolução (Pendente) no Tiny SVL para cancelados com NF,
// falha de entrega, extravio e reembolsos aceitos da Shopee Bumi; a EMISSÃO
// continua na lista logo abaixo, no clique da equipe. Aqui: quanto o motor já
// decidiu (por estado) e os casos que precisam de gente (revisar, erro, venda
// sem NF autorizada), com o motivo. Fonte: tabela `devolucao_auto`.
// ============================================================================
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { AlertTriangle, Bot, ChevronDown, ChevronRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";
import { CASO_DEVOLUCAO_PT as CASO_PT, type DevolucaoAuto as AutoInfo } from "@/lib/devolucaoAuto";


const ESTADOS: { id: string; rotulo: string; cor: string; atencao?: boolean }[] = [
  { id: "criada", rotulo: "Criadas pelo motor", cor: "#2F6FB0" },
  { id: "ja_existe", rotulo: "Já existiam", cor: "#0E8A5F" },
  { id: "sem_nf_venda", rotulo: "Sem NF de venda", cor: "#5C6470" },
  { id: "sem_pedido_svl", rotulo: "Aguardando faturar na SVL", cor: "#B7791F" },
  { id: "revisar", rotulo: "Revisar", cor: "#C9432F", atencao: true },
  { id: "venda_nao_autorizada", rotulo: "Venda não autorizada", cor: "#C9432F", atencao: true },
  { id: "erro", rotulo: "Erro (vai tentar de novo)", cor: "#C9432F", atencao: true },
  { id: "nao_cancelado", rotulo: "Voltou a ativo", cor: "#5C6470" },
];
const ATENCAO = ESTADOS.filter((e) => e.atencao).map((e) => e.id);

export function DevolucaoAutoSvlPainel() {
  const [aberto, setAberto] = useState(false);

  const contagemQ = useQuery({
    queryKey: ["devolucoes", "svl", "auto", "contagem"],
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const pares = await Promise.all(ESTADOS.map(async (e) => {
        const { count, error } = await supabaseExternal.from("devolucao_auto")
          .select("order_sn", { count: "exact", head: true }).eq("conta", "svl").eq("estado", e.id);
        if (error) throw error;
        return [e.id, count ?? 0] as const;
      }));
      const { count: fila } = await supabaseExternal.from("view_devolucao_auto_candidatos_svl")
        .select("order_sn", { count: "exact", head: true });
      return { ...Object.fromEntries(pares), fila: fila ?? 0 };
    },
  });

  const atencaoQ = useQuery({
    queryKey: ["devolucoes", "svl", "auto", "atencao"],
    enabled: aberto,
    staleTime: 60_000,
    queryFn: async (): Promise<AutoInfo[]> => {
      const { data, error } = await supabaseExternal.from("devolucao_auto")
        .select("order_sn,caso,estado,id_nota_devolucao,numero_nota,itens_parcial,detalhe,atualizado_em")
        .eq("conta", "svl").in("estado", ATENCAO)
        .order("atualizado_em", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as AutoInfo[];
    },
  });

  const c = contagemQ.data;
  const nAtencao = c ? ATENCAO.reduce((s, id) => s + (c[id] ?? 0), 0) : 0;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-4 w-4 text-blue-600" />
        <h3 className="text-sm font-semibold">Automação de devoluções</h3>
        <span className="text-xs text-muted-foreground">
          cria sozinha (Pendente) para cancelados com NF, falha de entrega, extravio e reembolsos Shopee Bumi — a emissão é na lista abaixo
        </span>
      </div>

      {contagemQ.isError ? (
        <p className="text-xs text-red-600">Erro ao carregar: {(contagemQ.error as Error).message}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <div className="rounded-lg border px-3 py-1.5 min-w-[120px]">
            <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Na fila</div>
            <div className="text-lg font-extrabold tabular-nums leading-tight">{c?.fila ?? "…"}</div>
          </div>
          {ESTADOS.filter((e) => (c?.[e.id] ?? 0) > 0 || e.id === "criada").map((e) => (
            <div key={e.id} className="rounded-lg border px-3 py-1.5 min-w-[120px]">
              <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: e.cor }}>{e.rotulo}</div>
              <div className="text-lg font-extrabold tabular-nums leading-tight">{c?.[e.id] ?? "…"}</div>
            </div>
          ))}
        </div>
      )}

      {nAtencao > 0 && (
        <div>
          <button onClick={() => setAberto((a) => !a)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
            {aberto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <AlertTriangle className="h-3.5 w-3.5" /> {nAtencao} caso(s) precisam de alguém
          </button>
          {aberto && (
            <div className="mt-2 max-h-[320px] overflow-y-auto rounded-md border divide-y">
              {(atencaoQ.data ?? []).map((r) => {
                const e = ESTADOS.find((x) => x.id === r.estado);
                return (
                  <div key={r.order_sn} className="px-3 py-2 text-xs flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="font-mono font-semibold">{r.order_sn}</span>
                    <span className="text-muted-foreground">{CASO_PT[r.caso] ?? r.caso}</span>
                    <span className={cn("font-semibold")} style={{ color: e?.cor }}>{e?.rotulo ?? r.estado}</span>
                    <span className="text-muted-foreground">{format(parseISO(r.atualizado_em), "dd/MM HH:mm")}</span>
                    {r.detalhe && <span className="basis-full text-muted-foreground">{r.detalhe}</span>}
                  </div>
                );
              })}
              {atencaoQ.isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">carregando…</div>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
