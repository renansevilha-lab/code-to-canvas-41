import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============ Mercado Livre Flex na separação (21/out/2026) ============
// A fila só sabe "ML" (tipo_envio); a modalidade vem do espelho do ML:
// pedidos.logistica_tipo = 'self_service' = Flex (sai no mesmo dia, entregador
// do Flex). O numero_ecommerce do Tiny é o order_id OU o pack_id (carrinho),
// por isso casa pelos dois. Devolve os numero_ecommerce que são Flex.
export async function buscarMlFlex(numeros: Array<string | null | undefined>): Promise<Set<string>> {
  const lista = Array.from(new Set(numeros.filter((n): n is string => !!n && /^\d+$/.test(n))));
  const flex = new Set<string>();
  for (let i = 0; i < lista.length; i += 150) {
    const lote = lista.slice(i, i + 150).join(",");
    const { data, error } = await supabaseExternal
      .from("pedidos")
      .select("id, pack_id")
      .eq("logistica_tipo", "self_service")
      .or(`id.in.(${lote}),pack_id.in.(${lote})`);
    if (error) throw error;
    for (const r of (data ?? []) as { id: string; pack_id: string | null }[]) {
      flex.add(String(r.id));
      if (r.pack_id) flex.add(String(r.pack_id));
    }
  }
  return flex;
}
