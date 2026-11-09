// Produção › Custos e Preços (09/nov/2026). Toda a conta está no banco
// (docs/producao-custos-precos.sql: custo_cenario_calcular, preco_cenario_matriz, preco_tabela_atacado).
// Aqui só tipos e leituras/gravações — o front NÃO recalcula custo nem preço.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabaseExternal } from "@/integrations/supabase/external-client";

const db = supabaseExternal as any;

async function ler<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as T;
}

export interface Cenario {
  id: number; nome: string; descricao: string | null; padrao: boolean; fator_encargos: number;
  horas_mes_mensalista: number; horas_dia_diarista: number; imposto_pct: number; volume_mes_un: number;
  criado_em: string; atualizado_em: string;
}

export interface CenarioSku {
  cenario_id: number; sku: string;
  fonte_materia: "padrao" | "medido" | "manual"; kg_un_manual: number | null;
  preco_kg_fonte: "ultima_entrada" | "referencia" | "media_90d" | "manual"; preco_kg_manual: number | null;
  preco_mistura_un_manual: number | null; embalagem_rs_un_manual: number | null; etiqueta_rs_un_manual: number | null;
  fonte_mod: "medido" | "manual_hora" | "manual_un"; mod_rs_hora_manual: number | null; un_homem_hora_manual: number | null;
  mod_rs_un_manual: number | null; premio_rs_lote: number; un_por_lote: number | null; cif_rs_un: number; observacao: string | null;
}

export interface CustoSku {
  sku: string; nome: string | null; peso_nominal_kg: number; mistura: boolean; farinha_id: number | null; farinha_nome: string | null;
  kg_un: number; kg_un_fonte: "padrao" | "medido" | "manual" | "padrao_sem_medida"; kg_un_padrao: number; kg_un_medido: number | null;
  bags_medidos: number | null; preco_kg: number; preco_kg_fonte: string; preco_kg_referencia: number | null;
  preco_kg_ultima: number | null; preco_kg_media_90d: number | null; kg_farinha: number; mistura_nome: string | null;
  un_mistura: number; preco_mistura_un: number; materia: number; embalagem_nome: string | null; embalagem: number; etiqueta: number;
  mod: number | null; mod_fonte: string; mod_un_homem_hora: number | null; mod_rs_hora: number | null; un_por_lote: number;
  premio: number; cif: number; cv: number; cv_padrao: number; cv_medido: number | null; desperdicio_un: number | null;
  desperdicio_mes: number | null; alerta_desperdicio: boolean; avisos: string[];
}

export interface PrecoMc { mc: number; preco: number | null; comissao: number; fixo: number; fora_faixa: boolean }
export interface LinhaMatriz {
  sku: string; nome: string | null; cv: number; canal: string; canal_nome: string; tipo: "marketplace" | "atacado"; ordem: number;
  imposto: number; piso: number | null; precos: PrecoMc[] | null; praticado: number | null; praticado_origem: string | null;
  praticado_em: string | null; mc_praticado: number | null; abaixo_alvo: boolean | null; abaixo_piso: boolean | null;
}

export interface Canal {
  id: number; canal: string; tipo: "marketplace" | "atacado"; nome_exibicao: string; comissao_fonte: string | null;
  comissao_pct: number; tarifa_fixa: number; comissao_extra_pct: number; custo_financeiro_pct: number; imposto_pct: number | null;
  condicao_padrao: string | null; mc_publicacao: number | null; ativo: boolean; ordem: number;
}

export interface TabelaAtacado {
  faixas: Array<{ canal: string; nome: string; condicao: string | null; mc: number; financeiro: number; imposto: number }>;
  itens: Array<{ sku: string; nome: string | null; cv: number; faixas: Record<string, { preco: number | null; piso: number | null }> }>;
  cenario?: string; gerado_em?: string;
}
export interface Publicada {
  id: number; cenario_id: number; nome: string; mc: Record<string, number>; publicado_em: string;
  publicado_por_nome: string | null; snapshot: TabelaAtacado;
}

export interface MateriaBag {
  entrada_id: number; codigo: string; insumo_id: number; insumo: string; kg_recebido: number; kg_consumido: number;
  peso_nominal_kg: number | null; skus: string | null; un: number | null; kg_un: number | null; ultima_medicao: string | null; situacao: string;
}
export interface ModMedida {
  grupo: string; sku: string | null; lotes: number; un_total: number; horas_linha: number; homem_horas: number;
  un_h_linha: number; un_homem_hora: number; rs_homem_hora_medio: number; mod_rs_un: number;
}
export interface ModDotacao { pessoas: number; lotes: number; un_total: number; homem_horas: number; un_h_linha: number; un_homem_hora: number; mod_rs_un: number }
export interface ModLote {
  ordem_id: number; codigo: string; sku: string; dia: string; mistura: boolean; un: number; min_linha: number; pessoas: number | null;
  quem: string | null; homem_horas: number | null; custo: number | null; un_h_linha: number | null; un_homem_hora: number | null;
  limpo: boolean; motivo: string | null;
}

export const useCenarios = () =>
  useQuery({
    queryKey: ["custos", "cenarios"],
    queryFn: () => ler<Cenario[]>(db.from("custo_cenario").select("*").order("padrao", { ascending: false }).order("nome")),
  });

export const useCenarioSkus = (cenario: number | null) =>
  useQuery({
    queryKey: ["custos", "cenario-sku", cenario],
    enabled: cenario != null,
    placeholderData: undefined,
    queryFn: () => ler<CenarioSku[]>(db.from("custo_cenario_sku").select("*").eq("cenario_id", cenario)),
  });

export const useCusto = (cenario: number | null) =>
  useQuery({
    queryKey: ["custos", "calculo", cenario],
    enabled: cenario != null,
    queryFn: () => ler<CustoSku[]>(db.rpc("custo_cenario_calcular", { p_cenario: cenario })),
  });

export const useMatriz = (cenario: number | null) =>
  useQuery({
    queryKey: ["custos", "matriz", cenario],
    enabled: cenario != null,
    queryFn: () => ler<LinhaMatriz[]>(db.rpc("preco_cenario_matriz", { p_cenario: cenario })),
  });

export const useTabelaAtacado = (cenario: number | null, mc: Record<string, number> | null) =>
  useQuery({
    queryKey: ["custos", "tabela-atacado", cenario, mc],
    enabled: cenario != null,
    queryFn: () => ler<TabelaAtacado>(db.rpc("preco_tabela_atacado", { p_cenario: cenario, p_mc: mc })),
  });

export const useCanais = () =>
  useQuery({ queryKey: ["custos", "canais"], queryFn: () => ler<Canal[]>(db.from("preco_canal").select("*").order("ordem")) });

export const useMargens = () =>
  useQuery({
    queryKey: ["custos", "margens"],
    queryFn: () => ler<Array<{ id: number; mc_pct: number; ativo: boolean; ordem: number }>>(db.from("preco_margem_alvo").select("*").order("mc_pct")),
  });

export const usePublicadas = () =>
  useQuery({
    queryKey: ["custos", "publicadas"],
    queryFn: () => ler<Publicada[]>(db.from("preco_tabela_publicada").select("*").order("publicado_em", { ascending: false }).limit(50)),
  });

export const useMedicoes = () =>
  useQuery({
    queryKey: ["custos", "medicoes"],
    queryFn: async () => {
      const [bags, mod, dot, lotes] = await Promise.all([
        ler<MateriaBag[]>(db.from("view_custo_materia_bags").select("*").order("insumo_id").order("entrada_id")),
        ler<ModMedida[]>(db.from("view_custo_mod_medida").select("*")),
        ler<ModDotacao[]>(db.from("view_custo_mod_dotacao").select("*").order("pessoas")),
        ler<ModLote[]>(db.from("view_custo_mod_lote").select("*").order("dia", { ascending: false })),
      ]);
      return { bags, mod, dot, lotes };
    },
  });

/** Depois de gravar algo que muda o custo: recalcula tudo do cenário (e o comparador). */
export function useRecalcular() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["custos", "calculo"] });
    void qc.invalidateQueries({ queryKey: ["custos", "matriz"] });
    void qc.invalidateQueries({ queryKey: ["custos", "tabela-atacado"] });
    void qc.invalidateQueries({ queryKey: ["custos", "cenario-sku"] });
  };
}

export async function salvarSku(cenario: number, sku: string, campos: Partial<CenarioSku>) {
  const { error } = await db.from("custo_cenario_sku")
    .upsert({ cenario_id: cenario, sku, ...campos, atualizado_em: new Date().toISOString() }, { onConflict: "cenario_id,sku" });
  if (error) throw new Error(error.message);
}

export async function salvarSkus(cenario: number, skus: string[], campos: Partial<CenarioSku>) {
  if (!skus.length) return;
  const { error } = await db.from("custo_cenario_sku")
    .upsert(skus.map((sku) => ({ cenario_id: cenario, sku, ...campos, atualizado_em: new Date().toISOString() })), { onConflict: "cenario_id,sku" });
  if (error) throw new Error(error.message);
}

export async function salvarCenario(id: number, campos: Partial<Cenario>) {
  const { error } = await db.from("custo_cenario").update(campos).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function rpc<T = unknown>(nome: string, args: Record<string, unknown>): Promise<T> {
  return ler<T>(db.rpc(nome, args));
}

export async function inserir(tabela: string, linha: Record<string, unknown>) {
  const { error } = await db.from(tabela).insert(linha);
  if (error) throw new Error(error.message);
}

export async function excluirCenario(id: number) {
  const { error } = await db.from("custo_cenario").delete().eq("id", id);
  if (error) throw new Error(error.message.includes("foreign key") ? "Este cenário tem tabela publicada: não pode ser excluído." : error.message);
}

// --- formatação ---------------------------------------------------------------
export const pct = (n: number | null | undefined, casas = 1) =>
  n == null ? "—" : `${(Number(n) * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
export const num = (n: number | null | undefined, casas = 2) =>
  n == null ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });

export const FONTE_KG: Record<string, string> = {
  medido: "medido", padrao: "padrão", manual: "manual", padrao_sem_medida: "padrão (sem medição)",
};
export const FONTE_PRECO_KG: Record<string, string> = {
  ultima_entrada: "última entrada", referencia: "referência", media_90d: "média 90 dias", manual: "manual",
};
export const FONTE_MOD: Record<string, string> = {
  sku: "medida no produto", agregado_mandioca_pura: "medida (mandioca pura)", agregado_misturas: "medida (misturas)",
  manual_hora: "manual (R$/h)", manual_un: "manual (R$/un)", sem_medida: "sem medição",
};
