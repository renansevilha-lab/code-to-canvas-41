// ============================================================================
// IA · Anúncios (ex-"Anúncio Mágico", migrado para a gestão — Fase 1, out/2026).
// Tipos das tabelas ia_* (cópia fiel do gerador pcob…) e utilidades das telas
// /ia/prompts e /ia/contextos. Regra de quais contextos valem para um SKU mora
// no banco: ia_contextos_do_sku / ia_contexto_alcance.
// ============================================================================

export const BUCKET_CONTEXTO = "ia-contexto";

export type TipoPrompt = "imagem" | "titulo" | "descricao" | "bullet_points" | "briefing" | "meta_prompt";

export interface IaPromptTemplate {
  id: string;
  nome: string;
  tipo: TipoPrompt;
  canal: string | null;
  versao: number;
  conteudo: string;
  variaveis: unknown;
  modelo: string | null;
  ativo: boolean;
  updated_at: string;
}

export interface IaPromptGuardrail {
  id: string;
  nome: string;
  escopo: "global" | "canal" | "categoria";
  canal: string | null;
  categoria: string | null;
  tipo: string;
  padrao: string;
  substituto: string | null;
  acao: "bloquear" | "substituir" | "avisar";
  severidade: number;
  ativo: boolean;
}

export interface IaModeloImagem {
  id: string;
  label: string;
  provider: "gemini" | "openai";
  quality: string | null;
  custo_estimado_usd: number;
  nota: string | null;
  padrao: boolean;
  ativo: boolean;
  ordem: number;
}

export interface IaCanalConfig {
  id: string;
  canal: string;
  ativo: boolean;
  qtd_imagens_min: number;
  qtd_imagens_max: number;
  imagem_largura: number;
  imagem_altura: number;
  imagem_formato: string;
  titulo_max_chars: number;
  descricao_max_chars: number;
  comissao_pct: number;
  margem_alvo_pct: number;
  custos_fixos_pct: number;
}

export interface IaCanalFaixa {
  id: string;
  canal: string;
  ordem: number;
  preco_ate: number | null;
  comissao_pct: number;
  tarifa_fixa: number;
}

export interface IaEmpresa {
  codigo: string;
  nome: string;
  imposto_pct: number;
  ativo: boolean;
}

export type EscopoContexto = "global" | "marca" | "categoria" | "sku";
export type PapelContexto = "referencia_produto" | "identidade_visual" | "ficha_tecnica" | "diretriz";

export interface IaContexto {
  id: string;
  nome: string;
  escopo: EscopoContexto;
  chave: string | null;
  tipo: "texto" | "imagem" | "documento";
  conteudo: string | null;
  storage_path: string | null;
  media_type: string | null;
  aplica_em: string[];
  prioridade: number;
  ativo: boolean;
  papel: PapelContexto;
}

export const PAPEIS: Array<{ v: PapelContexto; label: string; hint: string }> = [
  {
    v: "referencia_produto",
    label: "referência do produto",
    hint: "Foto REAL do produto por dentro. Ex.: a areia solta, para a granulometria e a textura saírem corretas. Manda mais que o modelo.",
  },
  { v: "identidade_visual", label: "identidade visual", hint: "Manual de marca: paleta, tipografia, ícones. Ex.: Bumi Pet." },
  { v: "ficha_tecnica", label: "ficha técnica", hint: "PDF do fabricante: composição, modo de uso, rendimento." },
  { v: "diretriz", label: "diretriz", hint: "Instrução livre, em texto." },
];

export const APLICA_EM: Array<{ v: string; label: string }> = [
  { v: "briefing", label: "Briefing" },
  { v: "titulo", label: "Título" },
  { v: "descricao", label: "Descrição" },
  { v: "bullet_points", label: "Bullet points" },
  { v: "imagem", label: "Imagem" },
];

/** Variáveis {{x}} usadas num template. */
export function variaveisDoTexto(t: string): string[] {
  return [...new Set([...t.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
}

/** Backups de 03/out ficam inativos e escondidos por padrão. */
export const ehBackup = (nome: string) => /__bkp_/.test(nome);
