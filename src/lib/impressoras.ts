import { supabaseExternal } from "@/integrations/supabase/external-client";

// A lista de impressoras das telas vem do PrintNode (shopee-sync-ads?modulo=
// impressoras) com o nome do Windows ("ZDesigner ZD220-203dpi ZPL"), igual em
// todos os PCs. O apelido cadastrado em `impressoras.apelido` (view
// view_impressoras_apelidos, por printnode_id) substitui o nome exibido.
// O filtro "zd220" das telas roda ANTES, no nome original.
export async function aplicarApelidos<T extends { printer_id: number; nome: string }>(
  lista: T[],
): Promise<T[]> {
  if (!lista.length) return lista;
  const { data, error } = await supabaseExternal
    .from("view_impressoras_apelidos")
    .select("printnode_id, apelido");
  if (error || !data?.length) return lista; // sem apelido: segue com o nome do PrintNode
  const porId = new Map(
    (data as { printnode_id: number; apelido: string }[]).map((a) => [Number(a.printnode_id), a.apelido]),
  );
  return lista.map((p) => {
    const apelido = porId.get(Number(p.printer_id));
    return apelido ? { ...p, nome: apelido } : p;
  });
}
