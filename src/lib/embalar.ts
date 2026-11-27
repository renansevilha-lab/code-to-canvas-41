// Embalar sem esperar o Tiny (27/nov/2026, pedido do dono).
// 1) A RPC separacao_embalar_marcar marca EMBALADO no sistema na hora (situacao 3)
//    e põe o pedido na fila separacao_embalar_fila.
// 2) A tiny-separacao?modulo=embalar-fila manda ao Tiny depois. A tela só dá o
//    empurrão (sem esperar); o cron de 1 em 1 minuto garante o resto.
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

export type EmbalarResultado = {
  marcados: number;
  total: number;
  bloqueados: number[]; // separacao_id sem etiqueta confirmada (ficaram na fila)
};

export async function embalarNoSistema(opts: {
  ids?: number[];
  tag?: string;
  forcar?: boolean;
  por?: string | null;
  motivo?: string | null;
}): Promise<EmbalarResultado> {
  const { data, error } = await supabaseExternal.rpc("separacao_embalar_marcar" as never, {
    p_ids: opts.ids ?? null,
    p_tag: opts.tag ?? null,
    p_forcar: !!opts.forcar,
    p_por: opts.por ?? null,
    p_motivo: opts.motivo ?? null,
  } as never);
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Partial<EmbalarResultado>;
  const res: EmbalarResultado = {
    marcados: Number(r.marcados ?? 0),
    total: Number(r.total ?? 0),
    bloqueados: ((r.bloqueados ?? []) as unknown[]).map(Number),
  };
  if (res.marcados > 0) empurrarFilaTiny();
  return res;
}

/** Dispara o envio ao Tiny sem esperar a resposta (o cron cobre se falhar). */
export function empurrarFilaTiny() {
  void fetch(`${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=embalar-fila`, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
    keepalive: true,
  }).catch(() => {});
}
