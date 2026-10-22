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
export interface IaProdutoExtra {
  sku: string; publico_alvo: string | null; frete_adicional: number; custo_embalagem: number; foto_ref_path: string | null;
  /** fotos reais de referência: a principal (= foto_ref_path) + as extras (outras cores, ângulos, o conteúdo) */
  fotos_ref?: string[] | null;
}
/** Nome fixo do contexto que guarda as "Instruções extras para a IA" de um produto (ia_contexto, escopo sku). */
export const NOME_INSTRUCOES = "Instruções extras do anúncio";
export const USOS_INSTRUCOES = ["briefing", "titulo", "descricao", "bullet_points", "imagem"];

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
export const nomeEmpresa = (e: string) => (e === "svl" ? "SVL" : "Ottz");
/** Canais com pedidos integrados na gestão (têm histórico de taxa, preço e margem). */
export const CANAIS_COM_HISTORICO = ["shopee", "mercado_livre", "amazon", "tiktok"];

// ---- Catálogo da tela /ia/anuncios (RPC ia_catalogo) e histórico de venda (ia_hist_sku_canal).
// Preenchidos 1×/dia por ia_historico_atualizar() a partir da margem real dos pedidos (120 dias).
export interface IaCanalHist { canal: string; empresa: string; un30: number; un120: number; preco: number | null; mc_pct: number | null }
export interface IaRascunhoResumo {
  id: string; canal: string; empresa: string; texto: StatusEtapa | null; imgs: number; imgs_ok: number; andando: number;
  preco: number | null; atualizado: string;
}
export interface IaCatalogoLinha {
  sku: string; nome: string; marca: string | null; tipo: string | null; foto: string | null; custo: number | null;
  un30: number; un120: number; canais: IaCanalHist[]; rascunhos: IaRascunhoResumo[]; situacao: "sem" | "andamento" | "pronto";
  // variações dentro do pai, como no Tiny — só vêm depois que o banco souber o pai de cada variação
  // (produtos.sku_pai; ver docs/catalogo-espelho-tiny). Até lá ficam ausentes.
  n_variacoes?: number; variacoes?: IaCatalogoLinha[];
  /** recebeu fotos aproveitadas da família e ainda não tem capa própria aprovada (RPC v1.1+). */
  sem_capa?: boolean;
  /** produto criado pelo app em "Criar produto com variações" (RPC versao 5). */
  criado_app?: boolean;
  /** estoque parado (RPC versao 6): os produtos FÍSICOS sem giro / em excesso — ele mesmo, o componente do kit ou as variações. */
  giro?: IaGiroFis[] | null;
  /** soma do valor em estoque desses produtos físicos (custo × estoque total) */
  giro_valor?: number | null;
}
/** Um produto físico parado, na regra do agente de compras (view_cobertura_fornecedor, retrato do dia). */
export interface IaGiroFis {
  sku: string; nome: string | null; status: "sem_giro" | "excesso";
  /** cobertura em dias (estoque total + OC aguardando ÷ venda por dia); nulo quando não vendeu */
  dias: number | null; estoque: number | null; venda_30d: number | null; valor: number | null;
}
export interface IaCatalogo {
  total: number; contagem: Record<string, number>; marcas: string[]; historico_em: string | null; linhas: IaCatalogoLinha[];
  /** 2 = a RPC já entende o filtro "sem_capa" e a ordem "vendas120"; 3 = também o filtro por tipo. */
  versao?: number;
  /** quantos produtos de cada tipo (S simples, K kit, V com variações) dentro da situação escolhida. */
  tipos?: Record<string, number>;
  /** versao 6: quantos produtos estão parados (parado = sem giro OU excesso), dentro da situação e do tipo escolhidos */
  giro?: Record<string, number>;
  /** quando o retrato de estoque/cobertura foi tirado (ads_cobertura_sku) */
  giro_em?: string | null;
}
export interface IaHistSku {
  sku: string; canal: string; empresa: string; unidades_30d: number; unidades_120d: number; pedidos_mono: number;
  preco_unit_med: number | null; preco_unit_ult: number | null; taxa_med: number | null; mc_pct: number | null; ultima_venda: string | null;
}
/** Resposta de ia_calcular_preco (preço sugerido pelas taxas reais do canal). */
export interface IaPreco {
  erro?: string; preco_sugerido?: number; lucro_reais?: number; margem_estimada_pct?: number;
  memoria_calculo?: Record<string, any>; historico?: Record<string, any> | null;
  /** produto PAI (com variações): o preço é o desta variação, a MAIS CARA na margem pedida */
  da_variacao?: string; n_variacoes?: number;
}

/**
 * Preço pela margem (`ia_calcular_preco`; margem nula = a padrão do canal). O produto PAI, que tem variações,
 * não tem custo próprio na gestão: para ele vale o preço da variação MAIS CARA na mesma margem (13/out/2026,
 * pedido do dono) — é o preço padrão do anúncio antes de as variações entrarem com o preço de cada uma.
 */
export async function calcularPreco(sku: string, canal: string, empresa: string, margem: number | null): Promise<IaPreco> {
  const chamar = (s: string) => supabaseExternal.rpc("ia_calcular_preco", { p_sku: s, p_canal: canal, p_empresa: empresa, p_margem: margem });
  const { data, error } = await chamar(sku);
  if (error) throw error;
  const p = (data ?? {}) as IaPreco;
  if (!p.erro) return p;
  const { data: vs } = await supabaseExternal.from("produtos").select("sku").eq("sku_pai", sku).eq("ativo", true);
  const skus = ((vs ?? []) as { sku: string }[]).map((v) => v.sku);
  if (!skus.length) return p;
  const rs = await Promise.all(skus.map((s) => chamar(s)));
  let melhor: IaPreco | null = null; let de = "";
  rs.forEach((r, i) => {
    const x = (r.data ?? {}) as IaPreco;
    if (x.preco_sugerido != null && (!melhor || Number(x.preco_sugerido) > Number(melhor.preco_sugerido))) { melhor = x; de = skus[i]; }
  });
  return melhor ? { ...(melhor as IaPreco), da_variacao: de, n_variacoes: skus.length } : p;
}
/** Rótulo legível do tipo de foto (template imagem_*). */
/** Foto que não vem da IA: subida à mão (manual_…) ou trazida de um anúncio no ar (anuncio_…). Não tem "refazer". */
export const fotoSemIa = (t: string) => /^(imagem_)?(manual|anuncio)_/.test(t);
export const rotuloFoto = (t: string) => {
  const x = t.replace(/^imagem_/, "");
  if (x.startsWith("manual_")) return "foto enviada";
  if (x.startsWith("anuncio_")) return "foto de anúncio no ar";
  return x.replace(/_/g, " ");
};
/** O que é cada foto, em uma linha (resumo do template de mesmo nome em /ia/prompts). */
export const DESCRICAO_FOTO: Record<string, string> = {
  imagem_principal: "Foto de catálogo: o produto igual ao real, em fundo branco.",
  imagem_angulo: "O mesmo produto girado, mostrando a lateral e o verso da embalagem.",
  imagem_detalhe: "Close de um detalhe real: textura, material ou fecho.",
  imagem_beneficios: "Cartão com o produto e 3 benefícios em ícones (só os do briefing).",
  imagem_conteudo: "O que vem dentro da embalagem.",
  imagem_uso: "O produto sendo usado, para mostrar que é fácil.",
  imagem_passo_a_passo: "Infográfico de como usar, em 3 ou 4 passos.",
  imagem_lifestyle: "Cena em casa, com o pet usando o produto.",
  imagem_emocional: "Vínculo entre tutor e pet: vende o sentimento, não a ficha técnica.",
  imagem_publico: "Deixa claro para quem o produto serve.",
  imagem_escala: "Referência de tamanho, para o comprador não imaginar maior ou menor.",
  imagem_variantes: "A linha completa: sabores, tamanhos ou versões.",
  imagem_kit: "Os itens do kit lado a lado, vistos de cima.",
  imagem_cta: "Foto de fechamento, reunindo os argumentos principais.",
  imagem_capa_shopee_basica: "Estilo 1: fiel à foto real, com o selo \"Preço de Atacado\".",
  imagem_capa_ml_branca: "Estilo 2: fundo branco puro, no padrão do Mercado Livre.",
  imagem_capa_shopee_livre: "Estilo 3: selo \"Preço de Atacado\", com fundo e composição livres.",
  imagem_capa_ambientada_texto: "Estilo 4: produto no ambiente de uso, com o selo de título do produto (sem benefícios).",
  imagem_capa_ambientada_limpa: "Estilo 5: produto no ambiente de uso, sem nenhum texto.",
  imagem_capa_ambientada_shopee: "Estilo 6: ambiente de uso com o selo \"Preço de Atacado\".",
};

/** Chama uma edge fn da IA (exige login com o módulo IA). Erro vira exceção com a mensagem da função. */
async function chamarFuncao(funcao: string, modulo: string, body: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/${funcao}?modulo=${modulo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const pend = Array.isArray(j.pendencias) && j.pendencias.length ? `: ${j.pendencias.join("; ")}` : "";
    // o motivo de cada foto pulada (ex.: capa sem prompt, prompt com [CONFIRMAR])
    const puladas = Array.isArray(j.puladas) && j.puladas.length
      ? `: ${(j.puladas as { tipo: string; motivo: string }[]).map((x) => `${x.tipo.replace(/_/g, " ")} — ${x.motivo}`).join("; ")}` : "";
    throw new Error((j.erro ?? `HTTP ${r.status}`) + pend + puladas);
  }
  return j;
}
/** Geração: briefing, texto, prompts de imagem, imagens, foto de referência. */
export const chamarIa = (modulo: string, body: Record<string, unknown>) => chamarFuncao("ia-anuncio", modulo, body);
/** Resultado de um código no "Importar do Tiny" (edge fn tiny-produto-importar). */
export interface ItemImportado {
  sku: string; ok: boolean; origem: string; erro?: string; novo?: boolean; nome?: string | null; tipo?: string | null;
  situacao?: string | null; custo?: number | null; preco?: number | null; estoque?: number | null; foto?: string | null;
  sku_pai?: string | null; componentes?: number; variacoes?: number;
}
/** Lê o produto no Tiny e grava (ou atualiza) no cadastro do sistema na hora — sem esperar a sincronização da madrugada. */
export const importarDoTiny = (skus: string[]) =>
  chamarFuncao("tiny-produto-importar", "importar", { skus }) as Promise<{ itens: ItemImportado[]; faltam: string[]; tudo_ok: boolean }>;
/**
 * Variações na Amazon (edge fn `amazon-variacoes`, 18/out/2026): `ler` e `previa` só leem/validam; `aplicar`
 * escreve. Devolve a resposta mesmo com `ok: false` (o `aplicar` diz o que já foi feito antes de parar).
 */
export async function chamarAmazonVariacoes(modulo: "ler" | "previa" | "aplicar" | "fiscal-previa" | "fiscal-aplicar", body: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/amazon-variacoes?modulo=${modulo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.envios && !j.feitos) throw new Error((j.erro ?? `HTTP ${r.status}`) + (Array.isArray(j.pendencias) && j.pendencias.length ? `: ${j.pendencias.join("; ")}` : ""));
  return j;
}
/** Envio do anúncio ao marketplace: `existentes` e `previa` só leem; `enviar` cria ou atualiza o anúncio. */
export const chamarPublicar = (modulo: "existentes" | "previa" | "enviar", body: Record<string, unknown>) => chamarFuncao("anuncio-publicar", modulo, body);

// ---- Aproveitar o que já foi gerado (edge fn `ia-aproveitar`, 12/out/2026): o mesmo produto em outro
// canal (texto + fotos) e a família de kit (fotos do produto base nos kits dele). Não chama IA.
export type RelacaoFamilia = "mesmo" | "componente" | "kit" | "irmao";
export interface IaParente {
  sku: string; nome: string; tipo: string | null; relacao: RelacaoFamilia; quantidade: number | null; n_componentes: number;
}
export interface IaFonteImagem { id: string; ordem: number; tipo: string; storage_path: string; status: StatusEtapa | null }
export interface IaFonte {
  rascunho_id: string; sku: string; nome: string; relacao: RelacaoFamilia; quantidade: number | null; n_componentes: number;
  canal: string; empresa: string; atualizado: string;
  texto: { status: StatusEtapa | null; titulo: string; n_titulo: number } | null; imagens: IaFonteImagem[];
}
export interface IaFontes {
  limite_titulo: number;
  destino: { rascunho_id: string; tem_texto: boolean; tipos: string[]; n_fotos: number } | null;
  familia: IaParente[]; fontes: IaFonte[];
}
export interface IaDestino extends IaParente { foto: string | null; rascunho_id: string | null; n_fotos: number; tipos: string[] }
/** "kit com 3 un.", "produto base do kit"… — como o produto se liga ao que está aberto. */
export function rotuloRelacao(p: { relacao: RelacaoFamilia; quantidade: number | null; n_componentes: number }): string {
  const q = p.quantidade && p.quantidade > 1 ? ` (${p.quantidade} un.)` : "";
  if (p.relacao === "mesmo") return "este produto";
  if (p.relacao === "componente") return `produto base do kit${q}`;
  if (p.n_componentes > 1) return "kit misto";
  return p.relacao === "kit" ? `kit deste produto${q}` : `kit do mesmo produto${q}`;
}
/** Fotos que carregam o selo da Shopee: não servem para outro canal. */
export const temSeloShopee = (tipo: string) => /shopee/.test(tipo);
export const chamarAproveitar = (modulo: "fontes" | "destinos" | "aplicar" | "aplicar-lote" | "subir" | "no-ar" | "copiar-no-ar", body: Record<string, unknown>) =>
  chamarFuncao("ia-aproveitar", modulo, body);

/** Criar no Tiny um produto com variações (cada variação = kit do produto base) — edge fn `tiny-produto-variacoes`. */
export const chamarVariacoes = (modulo: "sugerir" | "previa" | "criar" | "kit" | "foto" | "fotos-anuncio" | "grade", body: Record<string, unknown>) =>
  chamarFuncao("tiny-produto-variacoes", modulo, body);
/** Cria as variações (opções) num anúncio simples da Shopee — edge fn anuncio-shopee-variacoes.
 *  v7: `ler` (o anúncio ao vivo) e `ampliar` (opções novas num anúncio que já tem variações). */
export const chamarVariacoesShopee = (modulo: "previa" | "criar" | "ativar" | "ler" | "ampliar", body: Record<string, unknown>) =>
  chamarFuncao("anuncio-shopee-variacoes", modulo, body);

/** URLs assinadas (1 h) das imagens do bucket privado, em lote.
 *  20/out/2026 — a cota de tráfego do Supabase estourou (18 GB): cada leitura gerava um token novo, a URL mudava e o
 *  navegador baixava de novo o PNG inteiro (~1,3 MB) — 114 fotos baixadas 1.376 vezes num dia. Agora a mesma URL é
 *  reaproveitada enquanto faltar mais de 10 min para vencer, e o navegador usa o próprio cache. Caminho de foto não é
 *  regravado (o worker grava cada versão com hash no nome), então reaproveitar não mostra foto velha. */
const cacheAssinadas = new Map<string, { url: string; vence: number }>();
export async function urlsAssinadas(paths: string[]): Promise<Record<string, string>> {
  const unicos = [...new Set(paths.filter(Boolean))];
  if (!unicos.length) return {};
  const agora = Date.now();
  const out: Record<string, string> = {};
  const faltam: string[] = [];
  for (const p of unicos) {
    const c = cacheAssinadas.get(p);
    if (c && c.vence - agora > 10 * 60_000) out[p] = c.url;
    else faltam.push(p);
  }
  if (!faltam.length) return out;
  const { data, error } = await supabaseExternal.storage.from(BUCKET_ANUNCIOS).createSignedUrls(faltam, 3600);
  if (error) throw error;
  for (const d of data ?? []) {
    if (!d.path || !d.signedUrl) continue;
    out[d.path] = d.signedUrl;
    cacheAssinadas.set(d.path, { url: d.signedUrl, vence: agora + 3600_000 });
  }
  return out;
}
