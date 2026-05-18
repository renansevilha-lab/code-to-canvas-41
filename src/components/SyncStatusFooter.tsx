import { useEffect, useState } from "react";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type SyncArea =
  | "pedidos_integrados"
  | "contas_pagar"
  | "catalogo"
  | "pedidos_tiny"
  | "fluxo_caixa"
  | "vendas"
  | "ads"
  | "cmv"
  | "carteira"
  | "dashboard";

type SyncStatus = "ok" | "atrasado" | "critico" | "sem_dado";

type SyncRow = {
  area: string;
  label: string | null;
  ultima_atualizacao: string | null;
  frequencia: string | null;
  tempo_relativo: string | null;
  status_atualizacao: SyncStatus | null;
  segundos_atras: number | null;
};

const DOT: Record<SyncStatus, string> = {
  ok: "bg-emerald-500",
  atrasado: "bg-amber-500",
  critico: "bg-red-500",
  sem_dado: "bg-muted-foreground/40",
};

const REFRESH_MS = 30_000;

export function SyncStatusFooter({
  area,
  className,
  align = "right",
}: {
  area: SyncArea;
  className?: string;
  align?: "left" | "right";
}) {
  const [row, setRow] = useState<SyncRow | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancel = false;
    const load = async () => {
      const { data, error } = await supabaseExternal
        .from("view_sync_status")
        .select("*")
        .eq("area", area)
        .maybeSingle();
      if (cancel) return;
      if (error) {
        setMissing(true);
        return;
      }
      if (!data) {
        setMissing(true);
        return;
      }
      setMissing(false);
      setRow(data as SyncRow);
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [area]);

  if (missing || !row || !row.status_atualizacao) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs text-muted-foreground",
          align === "right" ? "justify-end" : "justify-start",
          className,
        )}
      >
        <span className={cn("inline-block h-2 w-2 rounded-full", DOT.sem_dado)} />
        <span>Configuração pendente</span>
      </div>
    );
  }

  const status = row.status_atualizacao;
  const tooltip = row.ultima_atualizacao
    ? new Date(row.ultima_atualizacao).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Sem data";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex items-center gap-2 text-xs text-muted-foreground cursor-default select-none",
              align === "right" ? "justify-end" : "justify-start",
              className,
            )}
          >
            <span className={cn("inline-block h-2 w-2 rounded-full", DOT[status])} />
            <span>
              Atualizado {row.tempo_relativo ?? "—"}
              {row.frequencia ? ` · ${row.frequencia}` : ""}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="text-xs">
            <div className="font-medium">{row.label ?? row.area}</div>
            <div className="text-muted-foreground">Última: {tooltip}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
