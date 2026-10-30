// ============================================================================
// Devoluções e reembolsos — reforma (29/out/2026). Tipos, rótulos e chamadas
// da aba "Pede resposta": a fila única Shopee + Mercado Livre
// (view_devolucoes_pede_resposta), o painel do caso (RPC devolucao_caso), as
// sugestões de resposta (RPC devolucao_sugestoes) e o registro do que foi
// respondido (devolucao_resposta — é o que ensina o sistema). Regra no banco:
// docs/devolucoes-reforma.sql; plano em docs/devolucoes-reforma-plano.md.
// ============================================================================
import { EXTERNAL_PUBLISHABLE_KEY, EXTERNAL_URL, supabaseExternal } from "@/integrations/supabase/external-client";

export type Marketplace = "shopee" | "mercadolivre";
export type Empresa = "ottz" | "svl";

export interface CasoFila {
  marketplace: Marketplace;
  conta: string;
  empresa: Empresa | null;
  case_id: string;
  order_sn: string | null;
  status_mkt: string | null;
  motivo: string | null;
  motivo_nome: string | null;
  texto_cliente: string | null;
  solucao: string | null;
  valor: number | null;
  fotos_cliente: number;
  criado_em: string | null;
  atualizado_em: string | null;
  acao_esperada: string;
  precisa_acao: boolean;
  prazo: string | null;
  acoes: Array<{ action: string; mandatory?: boolean; due_date?: string | null }>;
  itens: Array<{ sku: string | null; nome: string | null; qtd: number | null; preco?: number | null }>;
  logistica_reversa: string | null;
  rastreio_volta: string | null;
  volta_entregue_em: string | null;
  sku: string | null;
  nome_produto: string | null;
  foto: string | null;
  tiny_numero: string | null;
  tiny_pedido_id: number | null;
  tiny_situacao: string | null;
  entrada_em: string | null;
  entrada_problemas: Array<{ sku: string | null; estado: string | null; obs: string | null; qtd_esperada: number | null; qtd_recebida: number | null }> | null;
  entrada_causa: string | null;
  separador: string | null;
  respondido_em: string | null;
  respondido_acao: string | null;
  respondido_causa: string | null;
  causa_interna: string | null;
  causa_provavel: string | null;
  urgencia: "vencido" | "hoje" | "amanha" | "depois" | null;
}

export interface Causa { codigo: string; grupo: string; nome: string; ordem: number; ativo: boolean }

export const GRUPO_CAUSA_PT: Record<string, string> = {
  separacao: "Separação", embalagem: "Embalagem", transportadora: "Transportadora",
  produto: "Produto", cliente: "Cliente", outro: "Outro",
};

/** O que o marketplace espera de nós (coluna acao_esperada da view). */
export const ACAO_ESPERADA: Record<string, { rotulo: string; tom: "r" | "a" | "g" | "n" | "azul"; curto: string }> = {
  responder:           { rotulo: "Responder à solicitação", curto: "Responder", tom: "r" },
  validar_produto:     { rotulo: "Validar o produto devolvido", curto: "Validar produto", tom: "r" },
  validar_reembolso:   { rotulo: "Validar o reembolso (ou disputar)", curto: "Validar reembolso", tom: "r" },
  responder_mediador:  { rotulo: "Responder ao mediador do ML", curto: "Mediador", tom: "r" },
  responder_comprador: { rotulo: "Responder ao comprador", curto: "Comprador", tom: "a" },
  reembolsar:          { rotulo: "Decidir o reembolso", curto: "Reembolso", tom: "a" },
  abrir_disputa:       { rotulo: "Abrir disputa", curto: "Disputa", tom: "a" },
  aguardando_produto:  { rotulo: "Aguardando o produto voltar", curto: "Aguardando", tom: "n" },
  em_analise:          { rotulo: "Em análise da Shopee", curto: "Em análise", tom: "azul" },
  disputa_aberta:      { rotulo: "Disputa aberta", curto: "Disputa", tom: "azul" },
  acompanhar:          { rotulo: "Só acompanhar", curto: "Acompanhar", tom: "n" },
};
export const acaoEsperada = (a: string) => ACAO_ESPERADA[a] ?? { rotulo: a, curto: a, tom: "n" as const };

/** Motivos da Shopee (reason) e os nomes do catálogo do ML (ml_claim_motivos.nome). */
export const MOTIVO_PT: Record<string, string> = {
  ITEM_MISSING: "Item faltando", FUNCTIONAL_DMG: "Defeito funcional", PHYSICAL_DMG: "Dano físico",
  ITEM_WRONGDAMAGED: "Item errado/danificado", WRONG_ITEM: "Item errado", NOT_RECEIPT: "Não recebeu",
  DIFF: "Diferente do anunciado", NOT_AS_DESCRIBED: "Diferente do anunciado", CHANGE_MIND: "Desistiu da compra",
  ITEM_FAKE: "Alega falsificado", COUNTERFEIT: "Alega falsificado", USED: "Alega usado", EXPIRED_PRODUCT: "Produto vencido",
  SPILLED_CONTENTS: "Conteúdo vazou", DAMAGED_OTHERS: "Chegou danificado", ITEM_NOT_FIT: "Não serviu",
  SUSPICIOUS_PARCEL: "Pacote violado", OTHER: "Outro",
  // ML
  repentant_buyer: "Comprador desistiu", undelivered_repentant_buyer: "Desistiu antes de receber",
  different_item_other: "Recebeu outro produto", different_than_published: "Diferente do anúncio",
  broken_item: "Produto quebrado", sup_broken_item: "Produto quebrado", damaged_package_broken_item: "Embalagem danificada, produto quebrado",
  missing_accessories: "Faltou acessório", missing_item: "Faltou item", damaged_package_missing_item: "Embalagem danificada, faltou item",
  respondent_unanswered: "Vendedor não respondeu", estimated_delivery_out_of_time: "Entrega fora do prazo",
  change_receiver_address: "Mudou o endereço", undelivered_other: "Não entregue (outro)",
  delivered_but_not_receive_package: "Consta entregue, não recebeu", selected_wrong_product: "Escolheu o produto errado",
};
export const motivoPt = (m: string | null) => (m ? MOTIVO_PT[m] ?? m.replace(/_/g, " ") : "—");

export const SOLUCAO_PT: Record<string, string> = {
  devolucao: "Devolução e reembolso", reembolso: "Apenas reembolso", mediacao: "Mediação",
  cancelamento: "Cancelamento", returns: "Devolução",
};

export const lojaDe = (c: CasoFila) =>
  c.marketplace === "shopee" ? (c.empresa === "svl" ? "Bumi Pet" : "Ottz Pet") : (c.empresa === "svl" ? "SVL Store" : "Ottz Pet");

// ---------------------------------------------------------------------------
// Leituras
// ---------------------------------------------------------------------------

export async function listarFila(): Promise<CasoFila[]> {
  const { data, error } = await supabaseExternal.from("view_devolucoes_pede_resposta" as never).select("*").limit(2000);
  if (error) throw error;
  return ((data ?? []) as unknown as CasoFila[]).map((c) => ({
    ...c, valor: c.valor == null ? null : Number(c.valor), acoes: c.acoes ?? [], itens: c.itens ?? [],
  }));
}

export async function listarCausas(): Promise<Causa[]> {
  const { data, error } = await supabaseExternal.from("devolucao_causa" as never).select("*").eq("ativo", true).order("ordem");
  if (error) throw error;
  return (data ?? []) as unknown as Causa[];
}

export interface CasoDetalhe {
  caso: CasoFila & Record<string, unknown>;
  itens: Array<{ sku: string | null; nome: string | null; qtd: number | null; preco: number | null; foto: string | null }>;
  pedido: Record<string, unknown> | null;
  tiny: {
    tiny_pedido_id: number | null; numero_pedido: string | null; situacao: string | null; codigo_rastreamento: string | null;
    forma_envio: string | null; transportadora: string | null; numero_nota_fiscal: string | null; serie_nfe: string | null;
    data_emissao_nfe: string | null; cliente_nome: string | null; cliente_uf: string | null; cliente_cidade: string | null;
    data_envio: string | null; data_entrega: string | null;
  } | null;
  entrada: {
    id: string; recebido_em: string | null; recebido_por: string | null; status: string | null; conferido_ok: boolean | null;
    observacao: string | null; causa_interna: string | null; separador: string | null;
    itens: Array<{ sku: string | null; nome_produto: string | null; estado: string | null; observacao: string | null; qtd_esperada: number | null; qtd_recebida: number | null }>;
  } | null;
  separador: string | null;
  respostas: Array<{ id: number; acao: string; texto_resposta: string | null; causa_interna: string | null; respondido_por: string | null; respondido_em: string; ok: boolean | null; resultado: string | null; sugestao_usada: string | null; case_id: string }>;
  shopee?: Record<string, unknown> & { images?: string[] | null; text_reason?: string | null };
  reembolso?: { classe: string | null; valor_reembolsado: number | null; descontado_vendedor: number | null; compensado: number | null; cmv: number | null; teve_disputa: boolean | null } | null;
  outras_do_pedido?: Array<{ return_sn: string; status: string | null; reason: string | null; create_time: string | null }>;
  ml?: Record<string, unknown> & { motivo_nome?: string | null; motivo_detalhe?: string | null; expected_resolution?: string | null };
  mensagens?: Array<{ hash: string; de: string | null; para: string | null; texto: string | null; anexos: unknown[]; data: string | null; stage: string | null }>;
  envio_devolucao?: Array<Record<string, unknown>>;
  erro?: string;
}

export async function lerCaso(marketplace: Marketplace, caseId: string): Promise<CasoDetalhe> {
  const { data, error } = await supabaseExternal.rpc("devolucao_caso" as never, { p_marketplace: marketplace, p_case_id: caseId } as never);
  if (error) throw error;
  return data as unknown as CasoDetalhe;
}

export interface Sugestoes {
  historico: Array<{ id: number; texto_resposta: string; acao: string | null; causa_interna: string | null; vezes: number; ultima_em: string; score: number; ultimo_pedido: string | null }>;
  modelos: Array<{ id: number; nome: string; texto: string; acao: string | null; causa_interna: string | null; usos: number }>;
  total_respostas: number;
}

export async function lerSugestoes(p: { marketplace: Marketplace; motivo: string | null; causa: string | null; acao: string | null; texto: string | null }): Promise<Sugestoes> {
  const { data, error } = await supabaseExternal.rpc("devolucao_sugestoes" as never, {
    p_marketplace: p.marketplace, p_motivo: p.motivo, p_causa: p.causa, p_acao: p.acao, p_texto: p.texto, p_n: 5,
  } as never);
  if (error) throw error;
  return data as unknown as Sugestoes;
}

// ---------------------------------------------------------------------------
// Escritas na gestão (o histórico que ensina)
// ---------------------------------------------------------------------------

export type AcaoResposta =
  | "aprovar" | "disputar" | "oferta" | "mensagem_comprador" | "mensagem_mediador"
  | "reembolsar" | "validar_ok" | "validar_recusa" | "so_causa" | "registro_manual";

export interface NovaResposta {
  caso: CasoFila;
  acao: AcaoResposta;
  causa_interna: string | null;
  texto_resposta?: string | null;
  motivo_disputa_id?: string | null;
  sugestao_usada?: "nenhuma" | "historico" | "modelo" | "ia" | "ia_editada";
  respondido_por: string | null;
  enviado?: unknown;
  resposta_mkt?: unknown;
  ok?: boolean | null;
  entrada_estado?: string | null;
}

/** Grava a resposta (ou só a causa) no histórico. Vale para Shopee e ML. */
export async function registrarResposta(r: NovaResposta): Promise<void> {
  const c = r.caso;
  const { error } = await supabaseExternal.from("devolucao_resposta" as never).insert({
    marketplace: c.marketplace, conta: c.conta, case_id: c.case_id, order_sn: c.order_sn,
    motivo_mkt: c.motivo_nome ?? c.motivo, texto_cliente: c.texto_cliente, solucao: c.solucao, valor: c.valor,
    fotos_cliente: c.fotos_cliente, tem_entrada_galpao: !!c.entrada_em, estado_item: r.entrada_estado ?? null,
    causa_interna: r.causa_interna, separador: c.separador, acao: r.acao, texto_resposta: r.texto_resposta ?? null,
    motivo_disputa_id: r.motivo_disputa_id ?? null, sugestao_usada: r.sugestao_usada ?? "nenhuma",
    respondido_por: r.respondido_por, enviado: r.enviado ?? null, resposta_mkt: r.resposta_mkt ?? null, ok: r.ok ?? null,
  } as never);
  if (error) throw error;
}

/** Causa interna também na entrada do galpão do mesmo pedido (quando existe). */
export async function marcarCausaNaEntrada(entradaId: string, causa: string | null): Promise<void> {
  const { error } = await supabaseExternal.from("devolucoes_recebidas" as never).update({ causa_interna: causa } as never).eq("id", entradaId);
  if (error) throw error;
}

export async function salvarModelo(m: { nome: string; marketplace: Marketplace | null; causa_interna: string | null; acao: string | null; texto: string; criado_por: string | null }) {
  const { error } = await supabaseExternal.from("devolucao_resposta_modelo" as never).insert(m as never);
  if (error) throw error;
}

export async function contarUsoModelo(id: number, usos: number) {
  await supabaseExternal.from("devolucao_resposta_modelo" as never).update({ usos: usos + 1 } as never).eq("id", id);
}

// ---------------------------------------------------------------------------
// Chamadas às edge functions (com a sessão do usuário; a chave publicável só
// como reserva — as escritas no marketplace passam a exigir login no passo 4)
// ---------------------------------------------------------------------------

async function tokenSessao(): Promise<string> {
  const { data } = await supabaseExternal.auth.getSession();
  return data.session?.access_token ?? EXTERNAL_PUBLISHABLE_KEY;
}

export async function chamarFn(fn: string, qs: string, body?: unknown): Promise<Record<string, unknown>> {
  const token = await tokenSessao();
  const resp = await fetch(`${EXTERNAL_URL}/functions/v1/${fn}?${qs}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = (await resp.json().catch(() => ({}))) as { ok?: boolean; erro?: string; error?: string; resposta?: { message?: string }; message?: string };
  if (!resp.ok || d.ok === false) throw new Error(d.erro ?? d.error ?? d.resposta?.message ?? d.message ?? `HTTP ${resp.status}`);
  return d as Record<string, unknown>;
}

export const chamarShopee = (qs: string, body?: unknown) => chamarFn("shopee-devolucao-probe", qs, body);
export const chamarMl = (qs: string, body?: unknown) => chamarFn("ml-devolucao-lookup", qs, body);

/** Ações do vendedor na reclamação do ML (ml-devolucao-lookup v6). Sem `confirmar` = prévia. */
export type ModuloMl = "claim-mensagem" | "claim-reembolsar" | "claim-devolucao" | "claim-disputa" | "claim-review";
export interface RespostaAcaoMl {
  ok: boolean; previa?: boolean; erro?: string | null; acoes?: string[]; status?: number;
  ofertas_parciais?: { currency_id: string; available_offers: Array<{ amount: number; percentage: number }> } | null;
  return_id?: number; devolucao?: { status: string; status_money: string; shipments: Array<{ shipment_id: number; status: string; tracking_number: string | null }> };
  motivos_falha?: Array<{ id: string; name: string; detail: string; apply: string[] }>;
  resposta?: unknown;
}
export function acaoMl(modulo: ModuloMl, body: Record<string, unknown>): Promise<RespostaAcaoMl> {
  return chamarMl(`modulo=${modulo}`, { modulo, ...body }) as unknown as Promise<RespostaAcaoMl>;
}

export const ACAO_ML_PT: Record<string, string> = {
  send_message_to_mediator: "responder ao mediador", send_message_to_complainant: "responder ao comprador", recontact: "falar com o comprador",
  refund: "reembolsar", allow_partial_refund: "reembolso parcial", open_dispute: "pedir mediação", allow_return: "aceitar a devolução",
  return_review_ok: "validar o produto devolvido", return_review_fail: "recusar o produto devolvido",
  return_review_unified_ok: "validar o produto devolvido", return_review_unified_fail: "recusar o produto devolvido",
};

export function arquivoParaBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ""));
    r.onerror = () => reject(new Error("falha ao ler o arquivo"));
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

export const brl = (v: number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function prazoTexto(iso: string | null): { txt: string; tom: "r" | "a" | "n" } {
  if (!iso) return { txt: "sem prazo", tom: "n" };
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { txt: "venceu", tom: "r" };
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return { txt: `${Math.max(1, Math.floor(ms / 60_000))} min`, tom: "r" };
  if (h < 24) return { txt: `${h} h`, tom: "r" };
  const d = Math.floor(h / 24);
  return { txt: `${d} dia${d > 1 ? "s" : ""}`, tom: d <= 1 ? "a" : "n" };
}

export const diaHora = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const dia = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

/** Link do caso no painel do marketplace. */
export function linkMarketplace(c: CasoFila): string | null {
  if (c.marketplace === "shopee") return c.order_sn ? `https://seller.shopee.com.br/portal/sale/order/${c.order_sn}` : null;
  if (c.order_sn) return `https://www.mercadolivre.com.br/vendas/${c.order_sn}/detalhe`;
  return null;
}
