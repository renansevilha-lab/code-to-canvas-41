import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Regra de entrada automática nas promoções do ML (dono, 05/out/2026): MC na
// promoção >= 15% entra sozinho; abaixo, a tela pede confirmação; se outra
// promoção der MC melhor que a atual, sugere troca. A decisão vem pronta do
// banco (view_ml_promo_decisao); o robô é ml-promocoes?modulo=auto (cron 139).
// ============================================================================

export type Decisao = "auto" | "confirmar" | "trocar" | "manter_atual" | "outra_melhor" | "sem_cmv";
export interface LinhaDecisao {
  promocao_id: string; mlb: string; decisao: Decisao; ganho_troca: number | null;
  ativo_promocao_id: string | null; ativo_nome: string | null; ativo_tipo: string | null; ativo_mc: number | null;
}
interface Regra { modo: "desligado" | "simulacao" | "ligado"; mc_min_pct: number; ganho_min_troca: number; exigir_frete_real: boolean; max_por_rodada: number; atualizado_por: string | null }

export function useDecisoesML() {
  return useQuery({
    queryKey: ["promocoes-ml", "decisao"],
    queryFn: async (): Promise<Map<string, LinhaDecisao>> => {
      const { data, error } = await supabaseExternal.from("view_ml_promo_decisao")
        .select("promocao_id, mlb, decisao, ganho_troca, ativo_promocao_id, ativo_nome, ativo_tipo, ativo_mc");
      if (error) throw error;
      return new Map(((data ?? []) as LinhaDecisao[]).map((d) => [`${d.promocao_id}|${d.mlb}`, d]));
    },
    staleTime: 5 * 60_000, refetchOnWindowFocus: false,
  });
}

const MODOS: Array<{ id: Regra["modo"]; rot: string; dica: string }> = [
  { id: "desligado", rot: "Desligado", dica: "O robô não faz nada" },
  { id: "simulacao", rot: "Simulação", dica: "Mostra o que entraria, sem mexer no Mercado Livre" },
  { id: "ligado", rot: "Ligado", dica: "Entra sozinho nas promoções que passam na regra (3× ao dia)" },
];

export function PainelRegraAuto({ decisoes, chamarML, nomeUsuario }: {
  decisoes: Map<string, LinhaDecisao>; chamarML: (qs: string, escrita?: boolean) => Promise<any>; nomeUsuario: string | null;
}) {
  const qc = useQueryClient();
  const [rodando, setRodando] = useState(false);
  const regraQ = useQuery({
    queryKey: ["promocoes-ml", "regra"],
    queryFn: async (): Promise<Regra> => {
      const { data, error } = await supabaseExternal.from("ml_promo_regra").select("modo, mc_min_pct, ganho_min_troca, exigir_frete_real, max_por_rodada, atualizado_por").eq("id", 1).single();
      if (error) throw error;
      return data as Regra;
    },
    staleTime: 60_000,
  });
  const regra = regraQ.data;
  const conta = (d: Decisao) => [...decisoes.values()].filter((x) => x.decisao === d).length;
  const nAuto = conta("auto"), nConf = conta("confirmar"), nTroca = conta("trocar");

  async function mudarModo(modo: Regra["modo"]) {
    if (!regra || modo === regra.modo) return;
    if (modo === "ligado" && !window.confirm(
      `Ligar a entrada automática?\n\nO sistema vai entrar SOZINHO, 3 vezes ao dia, nas promoções do Mercado Livre em que a margem de contribuição no preço da promoção for ≥ ${(regra.mc_min_pct * 100).toFixed(0)}% (até ${regra.max_por_rodada} por rodada).\n\nHoje entrariam ${nAuto} anúncio(s). Relâmpago ativo não pode ser removido depois. Cada entrada avisa no Discord (#atualizacoes).`,
    )) return;
    const { error } = await supabaseExternal.from("ml_promo_regra").update({ modo, atualizado_por: nomeUsuario, atualizado_em: new Date().toISOString() }).eq("id", 1);
    if (error) { toast.error("Falha ao mudar o modo", { description: error.message }); return; }
    toast.success(modo === "ligado" ? "Entrada automática LIGADA" : modo === "simulacao" ? "Modo simulação" : "Entrada automática desligada");
    void qc.invalidateQueries({ queryKey: ["promocoes-ml", "regra"] });
  }

  async function rodarAgora() {
    setRodando(true);
    try {
      const r = await chamarML("modulo=auto");
      if (r.erro) throw new Error(r.erro);
      if (r.modo !== "ligado") toast.info(`Simulação: entrariam ${r.aplicaria} anúncio(s) agora`, { description: (r.itens ?? []).slice(0, 6).map((i: any) => `${i.sku ?? i.mlb} · ${i.promocao_nome ?? "Relâmpago"} · MC ${(Number(i.mc_promo_pct) * 100).toFixed(1)}%`).join("\n") });
      else toast.success(`Entraram ${r.entraram} anúncio(s)${r.falhas ? ` · ${r.falhas} recusa(s)` : ""}`, { description: (r.itens ?? []).filter((i: any) => !i.ok).slice(0, 4).map((i: any) => `${i.sku ?? i.mlb}: ${i.mensagem}`).join("\n") || undefined, duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["promocoes-ml"] });
    } catch (e) { toast.error("Falha ao rodar a regra", { description: (e as Error).message }); }
    finally { setRodando(false); }
  }

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Entrada automática</span>
        {regra && <span className="text-xs text-muted-foreground">MC na promoção ≥ <b className="text-foreground">{(regra.mc_min_pct * 100).toFixed(0)}%</b> entra sozinho · abaixo, pede confirmação</span>}
      </div>
      <div className="inline-flex rounded-lg border border-border p-0.5">
        {MODOS.map((m) => (
          <button key={m.id} type="button" title={m.dica} disabled={!regra} onClick={() => void mudarModo(m.id)}
            className={cn("px-2.5 py-1 rounded-md text-xs font-semibold",
              regra?.modo === m.id ? (m.id === "ligado" ? "bg-emerald-600 text-white" : m.id === "simulacao" ? "bg-amber-500 text-white" : "bg-muted text-foreground") : "text-muted-foreground hover:bg-muted")}>
            {m.rot}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span><b className="text-emerald-700 dark:text-emerald-400">{nAuto}</b> {regra?.modo === "ligado" ? "entram na próxima rodada" : "entrariam"}</span>
        <span><b className="text-amber-700 dark:text-amber-400">{nConf}</b> aguardando confirmação</span>
        <span><b className="text-violet-700 dark:text-violet-400">{nTroca}</b> sugestão(ões) de troca</span>
      </div>
      <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 ml-auto" disabled={rodando || !regra || regra.modo === "desligado"} onClick={() => void rodarAgora()}
        title={regra?.modo === "ligado" ? "Roda a regra agora (entra de verdade)" : "Mostra o que entraria agora"}>
        {rodando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} {regra?.modo === "ligado" ? "Rodar agora" : "Simular agora"}
      </Button>
    </div>
  );
}
