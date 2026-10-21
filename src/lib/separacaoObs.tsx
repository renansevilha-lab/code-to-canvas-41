import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { StickyNote } from "lucide-react";

import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============ Observações da equipe (pedido / linha / lote) ============
// Anotação de resolução de problema (ex.: falta de estoque — "comprado,
// chega amanhã"), visível na fila. Uma ativa por alvo; vazio remove.
// Usada pela fila (separacao.tsx) e pela aba Multi SKU — a observação de um
// pedido (escopo "pedido", chave = separacao_id) aparece nas duas.
export interface ObsSep { texto: string; autor: string | null; em: string }
export function useObsSeparacao() {
  return useQuery({
    queryKey: ["separacao", "obs"],
    queryFn: async (): Promise<Map<string, ObsSep>> => {
      const { data, error } = await supabaseExternal
        .from("separacao_obs")
        .select("escopo, chave, texto, autor, criado_em")
        .limit(2000);
      if (error) throw error;
      const map = new Map<string, ObsSep>();
      for (const r of (data ?? []) as { escopo: string; chave: string; texto: string; autor: string | null; criado_em: string }[]) {
        map.set(`${r.escopo}|${r.chave}`, { texto: r.texto, autor: r.autor, em: r.criado_em });
      }
      return map;
    },
  });
}

/** prompt() com o texto atual; vazio remove. Devolve true se algo mudou. */
export async function editarObsSeparacao(
  escopo: "pedido" | "linha" | "lote", chave: string,
  atual: string | undefined, autor: string | null,
): Promise<boolean> {
  const texto = window.prompt(
    "Observação — visível para toda a equipe na fila. Deixe vazio para remover.",
    atual ?? "",
  );
  if (texto === null) return false;
  const t = texto.trim();
  if (!t) {
    if (!atual) return false;
    const { error } = await supabaseExternal
      .from("separacao_obs").delete().eq("escopo", escopo).eq("chave", chave);
    if (error) { toast.error("Falha ao remover observação", { description: error.message }); return false; }
    toast.success("Observação removida");
    return true;
  }
  const { error } = await supabaseExternal.from("separacao_obs").upsert(
    { escopo, chave, texto: t, autor, criado_em: new Date().toISOString() },
    { onConflict: "escopo,chave" },
  );
  if (error) { toast.error("Falha ao salvar observação", { description: error.message }); return false; }
  toast.success("Observação salva");
  return true;
}

/** Linha visual padrão da observação (fila, pedidos e lotes). */
export function ObsLinha({ obs }: { obs: ObsSep | undefined }) {
  if (!obs) return null;
  return (
    <span
      className="inline-flex items-start gap-1 text-[11.5px] leading-tight"
      style={{ color: "#7A5CC7" }}
      title={`${obs.autor ?? "equipe"} · ${new Date(obs.em).toLocaleString("pt-BR")}`}
    >
      <StickyNote className="h-3 w-3 mt-[1px] shrink-0" />
      <span className="font-medium">{obs.texto}</span>
      {obs.autor && <span className="text-muted-foreground">— {obs.autor}</span>}
    </span>
  );
}
