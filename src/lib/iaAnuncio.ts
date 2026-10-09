// ============================================================================
// IA · Anúncios — Fase 2 (geração dentro da gestão, 09/out/2026).
// Tipos das tabelas ia_rascunho / ia_etapa / ia_rascunho_imagem / ia_briefing /
// ia_prompt_imagem / ia_produto_extra e a chamada à edge fn `ia-anuncio`.
// Toda regra (preço, plano de fotos, guardrails, fila) mora no banco/edge fn;
// aqui só exibe e dispara.
// ============================================================================
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

export const BUCKET_ANUNCIOS = "ia-anuncios";

export type StatusEtapa = "pendente" | "na_fila" | "gerando" | "gerado" | "aprovado" | "rejeitado" | "erro" | "enviando" | "enviado";

export interface IaRascunho {
  id: string; sku: string; canal: string; empresa: string; status: string;
  titulo: string | null; descricao: string | null; bullet_points: string[];
  custo_snapshot: number | null; preco_sugerido: number | null; preco_aprovado: number | null;
  margem_estimada_pct: number | null; memoria_calculo: Record<string, any>;
  modelo_texto: string | null; erro: string | null; criado_por_nome: string | null;
  created_at: string; updated_at: string;
}
export interface IaEtapa {
  id: string; rascunho_id: string; etapa: "texto" | "imagem"; imagem_id: string | null; status: StatusEtapa;
  observacao: string | null; tentativas: number; erro: string | null; proxima_em: string | null;
  aprovado_em: string | null; atualizado_em: string;
}
export interface IaRascunhoImagem {
  id: string; rascunho_id: string; ordem: number; tipo: string | null; storage_path: string | null;
  prompt_usado: string | null; modelo: string | null; status: string; gerado_em: string | null;
}
export interface IaBriefing {
  id: string; sku: string; persona: string | null; dores: string[]; objecoes: string[]; beneficios: string[];
  angulo: string | null; tom: string | null; palavras_chave: string[]; fotos_recomendadas: string[]; updated_at: string;
}
export interface IaPromptImagem { id: string; sku: string; tipo: string; prompt: string; editado_mao: boolean; updated_at: string }
export interface IaProdutoExtra { sku: string; publico_alvo: string | null; frete_adicional: number; custo_embalagem: number; foto_ref_path: string | null }

export const ROTULO_ETAPA: Record<StatusEtapa, { rotulo: string; cor: string }> = {
  pendente: { rotulo: "pendente", cor: "#64748B" },
  na_fila: { rotulo: "na fila", cor: "#B7791F" },
  gerando: { rotulo: "gerando…", cor: "#B7791F" },
  gerado: { rotulo: "para revisar", cor: "#2563EB" },
  aprovado: { rotulo: "aprovado", cor: "#0E8A5F" },
  rejeitado: { rotulo: "rejeitado", cor: "#C9432F" },
  erro: { rotulo: "erro", cor: "#C9432F" },
  enviando: { rotulo: "enviando", cor: "#B7791F" },
  enviado: { rotulo: "enviado", cor: "#0E8A5F" },
};
export const CANAIS: { id: string; nome: string }[] = [
  { id: "shopee", nome: "Shopee" }, { id: "mercado_livre", nome: "Mercado Livre" }, { id: "amazon", nome: "Amazon" },
  { id: "tiktok", nome: "TikTok" }, { id: "temu", nome: "Temu" }, { id: "shein", nome: "Shein" }, { id: "olist", nome: "Olist" },
];
export const nomeCanal = (c: string) => CANAIS.find((x) => x.id === c)?.nome ?? c;
/** Rótulo legível do tipo de foto (template imagem_*). */
export const rotuloFoto = (t: string) => t.replace(/^imagem_/, "").replace(/_/g, " ");

/** Chama a edge fn ia-anuncio (exige login com o módulo IA). Erro vira exceção com a mensagem da função. */
export async function chamarIa(modulo: string, body: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/ia-anuncio?modulo=${modulo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.erro ?? `HTTP ${r.status}`);
  return j;
}

/** URLs assinadas (1 h) das imagens do bucket privado, em lote. */
export async function urlsAssinadas(paths: string[]): Promise<Record<string, string>> {
  const unicos = [...new Set(paths.filter(Boolean))];
  if (!unicos.length) return {};
  const { data, error } = await supabaseExternal.storage.from(BUCKET_ANUNCIOS).createSignedUrls(unicos, 3600);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}
