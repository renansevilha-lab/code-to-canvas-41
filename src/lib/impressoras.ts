import { supabaseExternal } from "@/integrations/supabase/external-client";

// Impressoras das telas = as NOSSAS (impressão própria, §5.9 do CLAUDE.md), sem
// PrintNode desde 05/nov/2026. Vem da view_impressoras_app: Zebras vistas pelos
// agentes nos últimos 7 dias, com o apelido no lugar do nome do Windows.
// `printer_id` = o id antigo do PrintNode quando a impressora tem (mantém a
// escolha guardada no navegador), senão o id da tabela `impressoras`. As edge
// functions mandam esse id para a rpc print_enfileirar_se_proprio, que resolve
// os dois. Online = o programa do PC deu sinal nos últimos 90 s.
export interface ImpressoraApp {
  printer_id: number;
  nome: string;
  computador: string;
  estado: "online" | "offline";
  configurada?: boolean;
}

export async function listarImpressoras(): Promise<ImpressoraApp[]> {
  const { data, error } = await supabaseExternal
    .from("view_impressoras_app")
    .select("printer_id, nome, computador, estado")
    .order("nome");
  if (error) throw new Error(error.message);
  return ((data ?? []) as { printer_id: number; nome: string; computador: string | null; estado: string }[]).map((p) => ({
    printer_id: Number(p.printer_id),
    nome: p.nome,
    computador: p.computador ?? "",
    estado: p.estado === "online" ? "online" : "offline",
  }));
}
