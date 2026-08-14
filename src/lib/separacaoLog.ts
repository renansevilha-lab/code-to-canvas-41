import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============ Log da separação (histórico) ============
// Append-only em separacao_log. Escrito no front, que conhece o usuário logado.
// Nunca trava a operação: erros são engolidos. Compartilhado entre a tela de
// Separação (tag/impressão/embalado) e a de Monitoramento (finalização de TAG).
export type EventoSep =
  | "tag_aplicada"
  | "etiqueta_impressa"
  | "tag_finalizada"
  | "embalado";

export async function registrarSeparacaoLog(entrada: {
  evento: EventoSep;
  usuario: string | null;
  tag?: string | null;
  order_sn?: string | null;
  separacao_id?: number | null;
  sku?: string | null;
  detalhe?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await supabaseExternal.from("separacao_log").insert({
      evento: entrada.evento,
      usuario: entrada.usuario ?? null,
      tag: entrada.tag ?? null,
      order_sn: entrada.order_sn ?? null,
      separacao_id: entrada.separacao_id ?? null,
      sku: entrada.sku ?? null,
      detalhe: entrada.detalhe ?? null,
    });
  } catch {
    /* log não deve travar a operação */
  }
}
