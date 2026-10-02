import { supabaseExternal } from "@/integrations/supabase/external-client";
import type { NfXml } from "@/lib/nfe";

// ============================================================================
// NF de ENTRADA do espelho do Tiny (compras_nf_entrada + compras_nf_itens) no
// mesmo formato do XML (NfXml) — sem unidade comercial nem EAN (o Tiny não
// devolve). Usada na conciliação da OC e na "Nova entrada por NF".
// ============================================================================

export const normNf = (s: string | null | undefined) => String(s ?? "").trim().replace(/^0+/, "");

export async function carregarNfTiny(nfTinyId: number): Promise<{ nf: NfXml; nfTinyId: number }> {
  const [cab, its] = await Promise.all([
    supabaseExternal.from("compras_nf_entrada")
      .select("tiny_id, numero, serie, chave_acesso, data_emissao, fornecedor_nome, fornecedor_cnpj, valor")
      .eq("tiny_id", nfTinyId).maybeSingle(),
    supabaseExternal.from("compras_nf_itens")
      .select("id_item, sku, descricao, quantidade, valor_total").eq("nf_tiny_id", nfTinyId).order("id_item"),
  ]);
  if (cab.error) throw cab.error;
  if (its.error) throw its.error;
  const c = cab.data as { numero: string | null; serie: string | null; chave_acesso: string | null; data_emissao: string | null;
    fornecedor_nome: string | null; fornecedor_cnpj: string | null; valor: number | null } | null;
  if (!c) throw new Error("NF não encontrada no espelho");
  const itens = (its.data ?? []) as { sku: string | null; descricao: string | null; quantidade: number | null; valor_total: number | null }[];
  if (itens.length === 0) throw new Error("Os itens desta NF ainda não foram lidos do Tiny — tente de novo em alguns minutos");
  const nf: NfXml = {
    chave: c.chave_acesso, numero: normNf(c.numero) || String(c.numero ?? ""), numeroBruto: String(c.numero ?? ""),
    serie: c.serie ?? "", emissao: c.data_emissao, emitente: c.fornecedor_nome ?? "", razaoSocial: c.fornecedor_nome ?? "",
    cnpj: c.fornecedor_cnpj ?? "", valor: Number(c.valor ?? 0),
    itens: itens.map((i, idx) => ({
      n: idx + 1, cProd: i.sku ?? "", ean: null, eanTrib: null, xProd: i.descricao ?? "", uCom: "",
      qCom: Number(i.quantidade ?? 0), uTrib: "", qTrib: 0, vProd: Number(i.valor_total ?? 0),
    })),
  };
  return { nf, nfTinyId };
}

export interface NfEncontrada {
  tiny_id: number; numero: string | null; data_emissao: string | null; valor: number | null;
  fornecedor_nome: string | null; ordem_tiny_id: number | null; chave_acesso: string | null;
}

/** Procura NF de entrada no espelho do Tiny pelo número (com ou sem zeros) ou pela chave de 44 dígitos. */
export async function buscarNfTiny(termo: string): Promise<NfEncontrada[]> {
  const dig = termo.replace(/\D/g, "");
  if (!dig) return [];
  const campos = "tiny_id, numero, data_emissao, valor, fornecedor_nome, ordem_tiny_id, chave_acesso";
  if (dig.length === 44) {
    const { data, error } = await supabaseExternal.from("compras_nf_entrada").select(campos).eq("chave_acesso", dig).limit(5);
    if (error) throw error;
    return (data ?? []) as NfEncontrada[];
  }
  const num = normNf(dig);
  const { data, error } = await supabaseExternal.from("compras_nf_entrada").select(campos)
    .ilike("numero", `%${num}`).eq("ignorar", false).order("data_emissao", { ascending: false }).limit(30);
  if (error) throw error;
  return ((data ?? []) as NfEncontrada[]).filter((n) => normNf(n.numero) === num);
}
