// Produção (27/out/2026) — envase da areia Bumi a partir da farinha em big bag.
// Toda a regra mora no banco (docs/producao-mvp.sql): saldo dos big bags e das matérias-primas,
// código do lote, custo padrão × real, peso Inmetro. Aqui só tipos, leituras e textos.
import { useQuery } from "@tanstack/react-query";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

// --- Tiny (edge fn producao-tiny): só a entrada do produto acabado no depósito Geral; matéria-prima fica no app ---
export interface ItemTiny {
  papel: "acabado" | "farinha" | "embalagem" | "etiqueta" | "entrada"; tipo: "E" | "S"; nome: string;
  tiny_produto_id: number | null; sku: string | null; quantidade: number; unidade: string; preco_un: number;
  ja_lancado?: boolean; saldo_hoje?: number | null; saldo_depois?: number | null; problema?: string | null;
}
export interface RespostaTiny { ok: boolean; previa: boolean; codigo: string; itens: ItemTiny[]; bloqueio?: string | null; falhas?: number; completo?: boolean }

/** Chama a producao-tiny com a sessão do usuário. Erro vira exceção com a mensagem da função. */
export async function chamarProducaoTiny<T = any>(modulo: string, body: Record<string, unknown>): Promise<T> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Faça login de novo.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/producao-tiny?modulo=${modulo}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.erro) throw new Error(j.erro ?? `HTTP ${r.status}`);
  return j as T;
}

export const ETAPAS = [
  { id: "etiquetagem", nome: "Etiquetagem" },
  { id: "envase", nome: "Envase e pesagem" },
  { id: "selagem", nome: "Selagem" },
  { id: "fardos", nome: "Fechamento de fardos" },
] as const;
export type Etapa = (typeof ETAPAS)[number]["id"];

export const MOTIVOS_REFUGO: Array<{ id: string; nome: string; etapa: Etapa }> = [
  { id: "solda", nome: "Solda", etapa: "selagem" },
  { id: "peso", nome: "Peso fora", etapa: "envase" },
  { id: "embalagem_danificada", nome: "Embalagem danificada", etapa: "envase" },
  { id: "sujidade", nome: "Sujeira", etapa: "envase" },
  { id: "etiqueta", nome: "Etiqueta", etapa: "etiquetagem" },
  { id: "outro", nome: "Outro", etapa: "envase" },
];

export const MOTIVOS_PARADA: Array<{ id: string; nome: string }> = [
  { id: "troca_big_bag", nome: "Troca de big bag" },
  { id: "limpeza", nome: "Limpeza" },
  { id: "manutencao", nome: "Manutenção" },
  { id: "falta_embalagem", nome: "Falta de embalagem" },
  { id: "ajuste_dosagem", nome: "Ajuste de dosagem" },
  { id: "outro", nome: "Outro" },
];

export const nomeMotivoParada = (id: string | null) => MOTIVOS_PARADA.find((m) => m.id === id)?.nome ?? id ?? "";

export interface Insumo {
  id: number; nome: string; tipo: "farinha" | "embalagem" | "etiqueta" | "outro" | "produto"; unidade: "kg" | "un";
  ncm: string | null; custo_referencia: number | null; precisa_etiqueta: boolean; etiqueta_id: number | null; ativo: boolean;
  tiny_produto_id: number | null; tiny_sku: string | null;
}
export interface Parametro {
  sku: string; farinha_id: number | null; embalagem_padrao_id: number | null; prefixo_lote: string;
  peso_nominal_kg: number; consumo_padrao_kg: number; tolerancia_g: number; custo_insumo_kg: number;
  pesar_cada: number | null; pesar_primeiros: number; meta_estoque_un: number | null; ativo: boolean;
  // mistura (16640): pacotes de um produto do Tiny entram junto com a farinha; null = só farinha
  mistura_insumo_id: number | null; mistura_un_kg: number | null; mistura_farinha_kg: number | null;
  /** 06/nov: outras embalagens que o produto também usa (ex.: 15984 no saco transparente em alguns marketplaces) */
  embalagens_alternativas: number[] | null;
}
/** As embalagens da ficha: a padrão primeiro, depois as alternativas (só as que existem e estão ativas). */
export function embalagensDaFicha(par: Pick<Parametro, "embalagem_padrao_id" | "embalagens_alternativas"> | null, insumos: Insumo[] | undefined): Array<Insumo & { padrao: boolean }> {
  if (!par || !insumos) return [];
  const ids = [par.embalagem_padrao_id, ...(par.embalagens_alternativas ?? [])].filter((x): x is number => x != null).map(Number);
  return [...new Set(ids)].map((id, i) => {
    const e = insumos.find((x) => Number(x.id) === id && x.tipo === "embalagem" && x.ativo);
    return e ? { ...e, padrao: i === 0 && Number(par.embalagem_padrao_id) === id } : null;
  }).filter((x): x is Insumo & { padrao: boolean } => x != null);
}
/** Nome da matéria-prima sem o "Farinha de mandioca" do começo: "BRANCA (JAJU) — média". */
export const farinhaCurta = (nome: string | null | undefined) => (nome ?? "").replace(/^farinha de mandioca\s*/i, "").trim() || (nome ?? "");
export interface BigBag {
  id: number; codigo: string; insumo_id: number | null; insumo: string | null; a_classificar: boolean;
  fornecedor_nome: string | null; nf_numero: string | null; recebido_em: string; qtd_inicial_kg: number;
  custo_kg: number; densidade_aparente: number | null; densidade_pendente: boolean; consumido_kg: number;
  saldo_kg: number; lote_aberto: string | null; sku: string | null; consumo_padrao_kg: number | null; sacos_possiveis: number | null;
}
export interface EntradaLinha {
  id: number; codigo: string; insumo_id: number | null; fornecedor_nome: string | null; nf_numero: string | null;
  recebido_em: string; quantidade: number; custo_un: number; tiny_lancado_em: string | null; tiny_lancado_por: string | null;
}
export const useEntradas = () =>
  useQuery({
    queryKey: ["producao", "entradas"],
    queryFn: () => ler<EntradaLinha[]>(supabaseExternal.from("producao_entrada")
      .select("id, codigo, insumo_id, fornecedor_nome, nf_numero, recebido_em, quantidade, custo_un, tiny_lancado_em, tiny_lancado_por")
      .order("recebido_em", { ascending: false }).order("codigo").limit(60)),
  });
export interface EstoqueMp {
  insumo_id: number; nome: string; tipo: string; unidade: string; custo_referencia: number | null;
  entradas: number; consumido: number; saldo: number; custo_medio: number | null; ultima_entrada: string | null;
}
export interface Lote {
  id: number; codigo: string; sku: string; produto: string | null; status: "aberta" | "encerrada" | "cancelada";
  data: string; qtd_planejada: number | null; inicio_em: string; fim_em: string | null; big_bag: string; nf_numero: string | null;
  embalagem: string | null; precisa_etiqueta: boolean | null; envasados: number; refugo: number; boas: number;
  sacos_em_fardo: number; fardos: Record<string, number> | null; nominal_g: number; tolerancia_g: number;
  pesar_cada: number | null; pesar_primeiros: number; pesagens: number; media_g: number | null; desvio_g: number | null;
  min_g: number | null; max_g: number | null; abaixo_t: number; ultima_pesagem_em: string | null;
  alerta_peso: "abaixo_nominal" | "atencao" | "ok" | null; minutos_total: number; minutos_parados: number;
  parado_agora: boolean; parada_motivo: string | null; un_hora: number | null; pessoas: Record<string, string> | null;
  consumo_padrao_kg: number; consumo_padrao_total_kg: number; consumo_real_kg: number | null; variacao_kg: number | null;
  custo_padrao_un: number; custo_real_un: number | null; sobra_kg: number | null; embalagens_usadas: number | null;
  etiquetas_usadas: number | null; tiny_lancado_em: string | null;
  /** farinha por saco: o saco inteiro sem mistura; só a parte de farinha da receita com mistura */
  farinha_padrao_kg: number;
  mistura_sku: string | null; mistura_nome: string | null; mistura_un_kg: number | null; mistura_farinha_kg: number | null;
  mistura_un_por_saco: number | null; mistura_un_usadas: number | null; mistura_custo_un: number | null;
}
/** Farinha por saco pela ficha: o saco inteiro, ou a parte de farinha da receita quando há mistura. */
export const farinhaPorSaco = (p: Pick<Parametro, "consumo_padrao_kg" | "mistura_un_kg" | "mistura_farinha_kg">) =>
  p.mistura_un_kg && p.mistura_farinha_kg ? (p.consumo_padrao_kg * p.mistura_farinha_kg) / (p.mistura_farinha_kg + p.mistura_un_kg) : p.consumo_padrao_kg;
export interface Pessoa { id: string; nome: string }

const ler = async <T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as T;
};

export const useInsumos = () =>
  useQuery({ queryKey: ["producao", "insumos"], queryFn: () => ler<Insumo[]>(supabaseExternal.from("producao_insumo").select("*").order("tipo").order("nome")) });

export const useParametros = () =>
  useQuery({ queryKey: ["producao", "parametros"], queryFn: () => ler<Parametro[]>(supabaseExternal.from("producao_parametros").select("*").eq("ativo", true).order("sku")) });

export const useBigBags = () =>
  useQuery({ queryKey: ["producao", "bigbags"], queryFn: () => ler<BigBag[]>(supabaseExternal.from("view_producao_big_bag").select("*").order("codigo")) });

export const useEstoqueMp = () =>
  useQuery({ queryKey: ["producao", "estoque"], queryFn: () => ler<EstoqueMp[]>(supabaseExternal.from("view_producao_estoque").select("*").order("tipo").order("nome")) });

export const useLotes = (status: "aberta" | "todas", limite = 40) =>
  useQuery({
    queryKey: ["producao", "lotes", status, limite],
    queryFn: () => {
      let q = supabaseExternal.from("view_producao_lote").select("*").order("inicio_em", { ascending: false }).limit(limite);
      if (status === "aberta") q = q.eq("status", "aberta");
      return ler<Lote[]>(q);
    },
    refetchInterval: status === "aberta" ? 20_000 : false,
  });

export const useLote = (id: number | null) =>
  useQuery({
    queryKey: ["producao", "lote", id],
    enabled: id != null,
    // O chão de fábrica pode estar aberto em dois celulares ao mesmo tempo (envase e selagem):
    // relê a cada 5 s e nunca mostra o lote anterior enquanto carrega outro.
    placeholderData: undefined,
    refetchInterval: 5_000,
    queryFn: async () => {
      const r = await ler<Lote[]>(supabaseExternal.from("view_producao_lote").select("*").eq("id", id!).limit(1));
      return r[0] ?? null;
    },
  });

export const usePessoas = () =>
  useQuery({
    queryKey: ["producao", "pessoas"],
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const eq = await ler<Array<{ pessoa_id: string }>>(supabaseExternal.from("producao_equipe").select("pessoa_id").eq("ativo", true));
      const ids = eq.map((e) => e.pessoa_id);
      if (!ids.length) return [] as Pessoa[];
      return ler<Pessoa[]>(supabaseExternal.from("equipe_membros").select("id, nome").in("id", ids).order("ordem"));
    },
  });

/** Estoque do produto ACABADO pelo nosso sistema (04/nov/2026, decisão do dono — não pelo Tiny):
 *  RPC producao_estoque_acabado = última contagem + sacos bons dos lotes encerrados − vendas que saem do galpão
 *  (Full/FBA fora, kits abertos) − envios ao Full; venda de 30 dias de todos os canais. SQL em docs/producao-estoque-acabado.sql. */
export interface EstoqueAcabado {
  sku: string; nome: string; custo_tiny: number | null; estoque_tiny: number | null;
  contagem_qtd: number | null; contagem_em: string | null; contagem_por: string | null;
  produzido: number | null; vendido_galpao: number | null; enviado_full: number | null; saldo: number | null;
  venda_30d: number; venda_30d_galpao: number; venda_30d_full: number; full_estoque: number; cobertura_dias: number | null;
}
export const useEstoqueAcabado = (skus: string[]) =>
  useQuery({
    queryKey: ["producao", "acabado", skus.join(",")],
    enabled: skus.length > 0,
    queryFn: async () => {
      const [prod, est] = await Promise.all([
        ler<Array<{ sku: string; nome: string; estoque: number | null; custo: number | null }>>(
          supabaseExternal.from("produtos").select("sku, nome, estoque, custo").in("sku", skus)),
        ler<Array<Omit<EstoqueAcabado, "nome" | "custo_tiny" | "estoque_tiny">>>(supabaseExternal.rpc("producao_estoque_acabado" as never)),
      ]);
      return skus.map((s): EstoqueAcabado => {
        const p = prod.find((x) => x.sku === s);
        const e = est.find((x) => x.sku === s);
        return {
          sku: s, nome: p?.nome ?? s, custo_tiny: p?.custo ?? null, estoque_tiny: p?.estoque ?? null,
          contagem_qtd: e?.contagem_qtd ?? null, contagem_em: e?.contagem_em ?? null, contagem_por: e?.contagem_por ?? null,
          produzido: e?.produzido ?? null, vendido_galpao: e?.vendido_galpao ?? null, enviado_full: e?.enviado_full ?? null,
          saldo: e?.saldo ?? null, venda_30d: Number(e?.venda_30d ?? 0), venda_30d_galpao: Number(e?.venda_30d_galpao ?? 0),
          venda_30d_full: Number(e?.venda_30d_full ?? 0), full_estoque: Number(e?.full_estoque ?? 0),
          cobertura_dias: e?.cobertura_dias != null ? Number(e.cobertura_dias) : null,
        };
      });
    },
  });

/** Ficha de produção (view_producao_ficha): o que vai num saco, proporções e custo padrão. */
export interface Ficha {
  sku: string; produto: string | null; ativo: boolean; prefixo_lote: string; peso_nominal_kg: number; sobrepeso_pct: number;
  perda_pct: number; consumo_padrao_kg: number; tolerancia_g: number; pesar_cada: number | null; pesar_primeiros: number;
  meta_estoque_un: number | null; farinha: string | null; farinha_kg: number; farinha_custo_kg: number; farinha_custo: number;
  farinha_pct: number; mistura: string | null; mistura_sku: string | null; mistura_un_kg: number | null; mistura_farinha_kg: number | null;
  mistura_un: number | null; mistura_kg: number | null; mistura_custo_un: number | null; mistura_custo: number | null;
  mistura_pct: number | null; embalagem: string | null; embalagem_custo: number | null; etiqueta: string | null;
  etiqueta_custo: number | null; custo_conversao_un: number; custo_padrao_un: number;
  seladora_temp_c: number | null; processo: Array<{ nome: string; valor: string }> | null; instrucoes: string | null;
}
export const useFicha = (sku: string | null) =>
  useQuery({
    queryKey: ["producao", "ficha", sku],
    enabled: sku != null,
    placeholderData: undefined,
    queryFn: async () => {
      const r = await ler<Ficha[]>(supabaseExternal.from("view_producao_ficha").select("*").eq("sku", sku!).limit(1));
      return r[0] ?? null;
    },
  });

/** O que o lote consumiu (gravado no encerramento): farinha do big bag, pacotes da mistura, sacos e etiquetas. */
export interface ConsumoLote { insumo_id: number; quantidade: number; custo_un: number | null; custo: number | null }
export const useConsumoLote = (id: number | null, encerrado: boolean) =>
  useQuery({
    queryKey: ["producao", "consumo", id],
    enabled: id != null && encerrado,
    placeholderData: undefined,
    queryFn: () => ler<ConsumoLote[]>(supabaseExternal.from("producao_consumo").select("insumo_id, quantidade, custo_un, custo").eq("ordem_id", id!)),
  });

/** Foto por SKU (view_foto_produto: Tiny primeiro), só dos SKUs pedidos. */
export const useFotos = (skus: string[]) => {
  const lista = [...new Set(skus.filter(Boolean))].sort();
  return useQuery({
    queryKey: ["producao", "fotos", lista.join(",")],
    enabled: lista.length > 0,
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const r = await ler<Array<{ sku: string; foto: string | null }>>(supabaseExternal.from("view_foto_produto").select("sku, foto").in("sku", lista));
      return Object.fromEntries(r.filter((x) => x.foto).map((x) => [x.sku, x.foto as string])) as Record<string, string>;
    },
  });
};

/** Início e fim do lote: "29/10 15:07 → 16:01" (o dia do fim só aparece se for outro). */
export const periodoBR = (ini: string | null, fim: string | null) => {
  if (!ini) return "—";
  const d = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
  const a = `${d(ini)} ${horaBR(ini)}`;
  if (!fim) return `${a} → em andamento`;
  return `${a} → ${d(fim) === d(ini) ? "" : d(fim) + " "}${horaBR(fim)}`;
};

// --- formatação --------------------------------------------------------------
export const int = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("pt-BR"));
export const kg = (n: number | null | undefined, casas = 1) =>
  n == null ? "—" : `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })} kg`;
export const brl = (n: number | null | undefined, casas = 2) =>
  n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: casas, maximumFractionDigits: casas });
export const minutos = (m: number | null | undefined) => {
  if (m == null) return "—";
  const t = Math.max(0, Math.round(m));
  return t < 60 ? `${t} min` : `${Math.floor(t / 60)}h${String(t % 60).padStart(2, "0")}`;
};
export const hojeSP = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
export const dataBR = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
export const horaBR = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }) : "—";

/** Quantos sacos faltam até a próxima pesagem pela regra da ficha (os N primeiros e depois a cada X). */
export function proximaPesagem(l: Lote): { devida: boolean; faltam: number | null } {
  if (l.pesar_cada == null) return { devida: true, faltam: 0 };
  if (l.pesagens < l.pesar_primeiros) return { devida: l.envasados > l.pesagens, faltam: 0 };
  const esperadas = l.pesar_primeiros + Math.floor(Math.max(0, l.envasados - l.pesar_primeiros) / l.pesar_cada);
  if (l.pesagens < esperadas) return { devida: true, faltam: 0 };
  const proximo = l.pesar_primeiros + (l.pesagens - l.pesar_primeiros + 1) * l.pesar_cada;
  return { devida: false, faltam: Math.max(0, proximo - l.envasados) };
}

export function erroMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
  return m.replace(/^.*?ERROR:\s*/i, "");
}

// --- Ordem de produção (04/nov/2026): o dono estipula o que produzir; lotes abertos a partir dela ficam ligados
//     (producao_ordem.op_id) e a view soma o produzido. SQL em docs/producao-ordem-producao.sql. ---
export interface OrdemProducao {
  id: number; sku: string; produto: string | null; qtd: number; prazo: string | null; prioridade: "normal" | "urgente";
  obs: string | null; status: "aberta" | "concluida" | "cancelada"; criado_por: string | null; criado_em: string;
  fechada_em: string | null; fechada_por: string | null; motivo: string | null;
  produzido: number; falta: number; envasando: number; lotes: number; lote_aberto_id: number | null;
  situacao: "aberta" | "em_producao" | "atingida" | "concluida" | "cancelada"; atrasada: boolean;
  /** 06/nov: em qual embalagem produzir (null = a padrão da ficha) */
  embalagem_id: number | null; embalagem: string | null;
  /** 11/nov: R$ pagos por saco (bônus/mão de obra); só o administrador grava. bonus_total = bônus × produzido. */
  bonus_saco: number | null; bonus_total: number | null; editado_em: string | null; editado_por: string | null;
}
export const useOrdensProducao = (comFechadas = false) =>
  useQuery({
    queryKey: ["producao", "ops", comFechadas],
    queryFn: () => {
      let q = supabaseExternal.from("view_producao_op" as never).select("*").order("criado_em", { ascending: false }).limit(60);
      if (!comFechadas) q = q.eq("status", "aberta");
      return ler<OrdemProducao[]>(q);
    },
    refetchInterval: 60_000,
  });

/** Pessoas da equipe com o ID do Discord (para marcar no aviso). */
export const useEquipeDiscord = () =>
  useQuery({
    queryKey: ["producao", "equipe-discord"],
    staleTime: 30 * 60_000,
    queryFn: () => ler<Array<{ id: string; nome: string; discord_user_id: string | null }>>(
      supabaseExternal.from("equipe_membros").select("id, nome, discord_user_id").eq("ativo", true).order("ordem")),
  });

/** Aviso no Discord pela porta única (discord-notify, canal "producao"; sem o secret DISCORD_WEBHOOK_PRODUCAO cai no GERAL).
 *  Melhor-esforço: devolve false se não foi, sem derrubar o que já foi gravado. */
export async function avisarProducao(payload: { titulo: string; descricao?: string; nivel?: "info" | "aviso" | "ok" | "erro"; campos?: Array<{ nome: string; valor: string; inline?: boolean }>; marcar?: string[] }): Promise<boolean> {
  try {
    const { data, error } = await supabaseExternal.functions.invoke("discord-notify", {
      body: { canal: "producao", rodape: "Produção · ordem de produção", ...payload },
    });
    return !error && !!(data as { enviado?: boolean } | null)?.enviado;
  } catch {
    return false;
  }
}

/** A ordem de produção de um lote (null = lote aberto sem ordem). */
export const useOpDoLote = (loteId: number | null) =>
  useQuery({
    queryKey: ["producao", "op-do-lote", loteId],
    enabled: loteId != null,
    queryFn: async () => {
      const r = await ler<Array<{ op_id: number | null }>>(supabaseExternal.from("producao_ordem").select("op_id").eq("id", loteId!).limit(1));
      const id = r[0]?.op_id;
      if (!id) return null;
      const o = await ler<OrdemProducao[]>(supabaseExternal.from("view_producao_op" as never).select("*").eq("id", id).limit(1));
      return o[0] ?? null;
    },
  });

// --- Manual de processos (11/nov/2026): seções com passos (limpeza, conferência, envase…), base da folha de controle
//     impressa ao iniciar o lote e do manual de treinamento. SQL em docs/producao-folha-controle.sql. ---
export interface ManualSecao {
  id: number; ordem: number; titulo: string; quando: "antes" | "durante" | "depois" | "sempre";
  etapa: Etapa | null; sku: string | null; passos: string[]; observacao: string | null; ativo: boolean;
  atualizado_em: string; atualizado_por: string | null;
}
export const QUANDO_MANUAL: Array<{ id: ManualSecao["quando"]; nome: string }> = [
  { id: "antes", nome: "Antes de começar" },
  { id: "durante", nome: "Durante a produção" },
  { id: "depois", nome: "Ao terminar" },
  { id: "sempre", nome: "Sempre" },
];
export const lerManual = () =>
  ler<ManualSecao[]>(supabaseExternal.from("producao_manual" as never).select("*").order("ordem").order("id"));
export const useManual = () => useQuery({ queryKey: ["producao", "manual"], queryFn: lerManual });
