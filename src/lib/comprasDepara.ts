import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// De-para do fornecedor (compras_depara_fornecedor): item da NF (descrição do
// fornecedor) → NOSSO SKU + fator (unidades do SKU por 1 unidade da NF, ex.:
// "FARINHA DE MAND. FINA CRUA (4X5) 20 KG" FD → 5 un do SKU). Chave =
// fornecedor (id do Tiny ou CNPJ) + descrição normalizada IGUAL à função SQL
// compras_norm_desc (a view de conciliação usa a mesma regra).
// ============================================================================

export interface Depara { sku: string; fator: number }

/** Mesma regra de compras_norm_desc(): espaços colapsados, sem bordas, MAIÚSCULAS. */
export const normDesc = (t: string | null | undefined): string =>
  String(t ?? "").replace(/\s+/g, " ").trim().toUpperCase();
const soDig = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");

/** De-para conhecido para as descrições dadas (por fornecedor_id e/ou CNPJ). */
export async function buscarDepara(
  fornecedorId: number | null | undefined, cnpj: string | null | undefined, descricoes: string[],
): Promise<Map<string, Depara>> {
  const chaves = [...new Set(descricoes.map(normDesc).filter(Boolean))];
  const mapa = new Map<string, Depara>();
  if (chaves.length === 0 || (!fornecedorId && !soDig(cnpj))) return mapa;
  let q = supabaseExternal.from("compras_depara_fornecedor")
    .select("fornecedor_id, fornecedor_cnpj, descricao_norm, sku, fator, atualizado_em")
    .in("descricao_norm", chaves);
  const filtros: string[] = [];
  if (fornecedorId) filtros.push(`fornecedor_id.eq.${fornecedorId}`);
  if (soDig(cnpj)) filtros.push(`fornecedor_cnpj.eq.${soDig(cnpj)}`);
  q = q.or(filtros.join(","));
  const { data } = await q;
  // o do fornecedor_id ganha do só-CNPJ; o mais recente ganha
  const linhas = ((data ?? []) as Array<{ fornecedor_id: number | null; descricao_norm: string; sku: string; fator: number; atualizado_em: string }>)
    .sort((a, b) => (Number(!!b.fornecedor_id) - Number(!!a.fornecedor_id)) || b.atualizado_em.localeCompare(a.atualizado_em));
  for (const r of linhas) if (!mapa.has(r.descricao_norm)) mapa.set(r.descricao_norm, { sku: r.sku, fator: Number(r.fator) });
  return mapa;
}

export interface NovoDepara {
  descricao: string; codigo?: string | null; unidade?: string | null; sku: string; fator: number;
}

/** Grava/atualiza o de-para (upsert manual: o índice único é por expressão). */
export async function salvarDepara(
  fornecedorId: number | null | undefined, cnpj: string | null | undefined, itens: NovoDepara[], por: string | null,
): Promise<number> {
  const cnpjD = soDig(cnpj) || null;
  if (!fornecedorId && !cnpjD) return 0;
  let gravados = 0;
  for (const it of itens) {
    const chave = normDesc(it.descricao);
    if (!chave || !it.sku || !(it.fator > 0)) continue;
    let q = supabaseExternal.from("compras_depara_fornecedor").select("id").eq("descricao_norm", chave);
    q = fornecedorId ? q.eq("fornecedor_id", fornecedorId) : q.is("fornecedor_id", null).eq("fornecedor_cnpj", cnpjD!);
    const { data: ex } = await q.limit(1);
    const linha = {
      fornecedor_id: fornecedorId ?? null, fornecedor_cnpj: cnpjD, descricao_norm: chave,
      descricao_fornecedor: it.descricao, codigo_fornecedor: it.codigo ?? null, unidade_nf: it.unidade ?? null,
      sku: it.sku, fator: it.fator, atualizado_em: new Date().toISOString(),
    };
    const { error } = ex && ex.length
      ? await supabaseExternal.from("compras_depara_fornecedor").update(linha).eq("id", (ex[0] as { id: number }).id)
      : await supabaseExternal.from("compras_depara_fornecedor").insert({ ...linha, criado_por: por });
    if (!error) gravados++;
  }
  return gravados;
}
