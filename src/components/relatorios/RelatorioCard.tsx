import { useId, useState } from "react";
import { ChevronDown, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { brl, horaSP, iconeDaCategoria, obj, type RelatorioLista } from "./comum";
import { RelatorioFinanceiro, venceEm7d } from "./RelatorioFinanceiro";
import { RelatorioCompras, resumoCompras } from "./RelatorioCompras";
import { RelatorioHtmlModal } from "./RelatorioHtmlModal";

// Mapa agente → mini-KPIs do card fechado + componente do card aberto.
// Agente novo = uma entrada aqui; sem entrada, o card aberto mostra só o
// botão "Ver versão completa".
interface MiniKpi { label: string; valor: string; tom?: "red" }
interface AgenteDef {
  mini: (rel: RelatorioLista) => MiniKpi[];
  Detalhe: React.ComponentType<{ rel: RelatorioLista }>;
}
const AGENTES: Record<string, AgenteDef> = {
  financeiro: {
    mini: (rel) => {
      const tot = obj(rel.resumo?.carteira_total);
      const v7 = venceEm7d(rel.resumo);
      return [
        { label: "Saldo em conta", valor: brl(tot.saldo_em_conta) },
        { label: "A receber", valor: brl(tot.a_receber) },
        { label: "Vence em 7d", valor: brl(v7.valor), tom: v7.atrasadoQtd > 0 ? "red" : undefined },
      ];
    },
    Detalhe: RelatorioFinanceiro,
  },
  compras: {
    mini: (rel) => {
      const c = resumoCompras(rel.resumo);
      return [
        { label: "Ruptura", valor: String(c.ruptura), tom: c.ruptura > 0 ? "red" : undefined },
        { label: "Urgente", valor: String(c.urgente) },
        { label: "Valor parado", valor: brl(c.valorParado) },
      ];
    },
    Detalhe: RelatorioCompras,
  },
};

export function RelatorioCard({
  rel, aberto, onToggle,
}: {
  rel: RelatorioLista;
  aberto: boolean;
  onToggle: () => void;
}) {
  const def = AGENTES[rel.agente];
  const Icone = iconeDaCategoria(rel.categoria);
  const corpoId = useId();
  const [htmlAberto, setHtmlAberto] = useState(false);
  // monta o conteúdo na primeira abertura e mantém (a transição de fechar fica suave)
  const [montado, setMontado] = useState(aberto);
  if (aberto && !montado) setMontado(true);
  const minis = def?.mini(rel) ?? [];

  return (
    <div className={cn(
      "rounded-xl border bg-card transition-colors",
      aberto ? "border-primary/60 ring-1 ring-primary/30" : "hover:border-foreground/20",
    )}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={aberto}
        aria-controls={corpoId}
        className="w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icone className="h-4.5 w-4.5" />
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold text-sm truncate">{rel.titulo ?? rel.agente}</span>
            {rel.gerado_em && <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{horaSP(rel.gerado_em)}</span>}
          </span>
          {rel.destaque && (
            <span className="text-[12.5px] text-muted-foreground line-clamp-2">{rel.destaque}</span>
          )}
        </span>
        {minis.length > 0 && (
          <span className="hidden md:flex items-stretch gap-4 shrink-0">
            {minis.map((m) => (
              <span key={m.label} className="flex flex-col items-end">
                <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground whitespace-nowrap">{m.label}</span>
                <span className={cn("text-sm font-bold tabular-nums whitespace-nowrap", m.tom === "red" && "text-red-700 dark:text-red-400")}>
                  {m.valor}
                </span>
              </span>
            ))}
          </span>
        )}
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200", aberto && "rotate-180")} />
      </button>

      {/* corpo: transição de altura com grid-rows 0fr → 1fr */}
      <div
        id={corpoId}
        role="region"
        aria-hidden={!aberto}
        className={cn("grid transition-[grid-template-rows] duration-300 ease-out", aberto ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        <div className="overflow-hidden min-w-0">
          {montado && (
            <div className="border-t px-4 py-4 flex flex-col gap-4" inert={!aberto}>
              {def ? <def.Detalhe rel={rel} /> : null}
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setHtmlAberto(true)}>
                  <FileText className="h-3.5 w-3.5" /> Ver versão completa
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {htmlAberto && <RelatorioHtmlModal rel={rel} open={htmlAberto} onOpenChange={setHtmlAberto} />}
    </div>
  );
}
