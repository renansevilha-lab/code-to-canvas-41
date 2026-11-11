// Lê o que a folha de controle precisa (lote, ficha, ordem, equipe, manual, foto) e abre para imprimir.
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { lerManual, type Ficha, type Lote, type OrdemProducao } from "@/lib/producao";
import { abrirAbaEspera, escreverEImprimir, folhaControleHtml, manualHtml } from "./folhaControle";

async function um<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return ((data as T[] | null) ?? [])[0] ?? null;
}

/** Abre a folha de controle do lote. Passe a aba aberta no clique (abrirAbaEspera) quando houver await antes. */
export async function abrirFolhaControle(loteId: number, janela?: Window | null, geradoPor?: string | null) {
  const w = janela ?? abrirAbaEspera();
  if (!w) throw new Error("O navegador bloqueou a nova aba. Libere pop-ups para este site e tente de novo.");
  try {
    const lote = await um<Lote>(supabaseExternal.from("view_producao_lote").select("*").eq("id", loteId).limit(1));
    if (!lote) throw new Error("Lote não encontrado.");
    const [ficha, ordem, manual, foto, param] = await Promise.all([
      um<Ficha>(supabaseExternal.from("view_producao_ficha").select("*").eq("sku", lote.sku).limit(1)),
      um<{ op_id: number | null }>(supabaseExternal.from("producao_ordem").select("op_id").eq("id", loteId).limit(1)),
      lerManual(),
      um<{ foto: string | null }>(supabaseExternal.from("view_foto_produto").select("foto").eq("sku", lote.sku).limit(1)),
      um<{ pagamento_saco: number | null }>(supabaseExternal.from("producao_parametros" as never).select("pagamento_saco").eq("sku", lote.sku).limit(1)),
    ]);
    const op = ordem?.op_id
      ? await um<OrdemProducao>(supabaseExternal.from("view_producao_op" as never).select("*").eq("id", ordem.op_id).limit(1))
      : null;
    // quem esteve em cada etapa (producao_etapa; o "pessoas" da view só existe com o lote aberto)
    const { data: et, error: eEt } = await supabaseExternal.from("producao_etapa").select("etapa, pessoa_id, inicio_em").eq("ordem_id", loteId).order("inicio_em");
    if (eEt) throw new Error(eEt.message);
    const etapas = ((et ?? []) as Array<{ etapa: string; pessoa_id: string | null }>).filter((x) => x.pessoa_id);
    const ids = [...new Set(etapas.map((x) => x.pessoa_id as string))];
    const { data: pes } = ids.length
      ? await supabaseExternal.from("equipe_membros").select("id, nome").in("id", ids)
      : { data: [] as Array<{ id: string; nome: string }> };
    const nome = Object.fromEntries(((pes ?? []) as Array<{ id: string; nome: string }>).map((p) => [p.id, p.nome]));
    const equipe: Record<string, string> = {};
    for (const x of etapas) {
      const nm = nome[x.pessoa_id as string] ?? (x.pessoa_id as string);
      const lista = equipe[x.etapa] ? equipe[x.etapa].split(" → ") : [];
      if (lista[lista.length - 1] !== nm) equipe[x.etapa] = [...lista, nm].join(" → ");
    }
    escreverEImprimir(w, folhaControleHtml({ lote, ficha, op, equipe, manual, foto: foto?.foto ?? null, pagamento_saco: param?.pagamento_saco ?? null, gerado_por: geradoPor }));
  } catch (e) {
    w.close();
    throw e;
  }
}

/** Abre o manual de processos sozinho (treinamento). */
export async function abrirManual(janela?: Window | null) {
  const w = janela ?? abrirAbaEspera();
  if (!w) throw new Error("O navegador bloqueou a nova aba. Libere pop-ups para este site e tente de novo.");
  try {
    escreverEImprimir(w, manualHtml(await lerManual()));
  } catch (e) {
    w.close();
    throw e;
  }
}
