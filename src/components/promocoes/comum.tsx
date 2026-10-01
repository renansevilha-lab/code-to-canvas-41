import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap } from "lucide-react";

import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";

// ============================================================================
// Peças comuns das Promoções Shopee (Minha Promoção + Relâmpago).
// ============================================================================

export const LOJAS = [
  { shop_id: 522186766, nome: "Ottz Pet" },
  { shop_id: 759046323, nome: "Bumi Pet" },
] as const;

export const num = (x: unknown): number => { const n = Number(x ?? 0); return Number.isFinite(n) ? n : 0; };
export const GREEN = "#0E8A5F", RED = "#C9432F", AMBER = "#B7791F";

/** Base de MC por SKU (RPC promo_mc_base / flashsale_mc_base — regra no banco). */
export interface McBase {
  sku: string; cmv: number | null; com_pct: number | null; imp_pct: number | null;
  n_pedidos: number; fonte: string;
  menor_preco_7d?: number | null; vendas_30d?: number | null;
}

/** Faixa da tabela de comissão Shopee (shopee_tarifa — vigência no banco). */
export interface Tarifa { vigencia_inicio: string; preco_min: number; preco_max: number | null; pct: number; fixo_unidade: number }

/**
 * Tabela de comissão vigente AMANHÃ (as promoções valem daqui pra frente).
 * Regra no banco (shopee_tarifa_vigente); o front só aplica pct·p + fixo.
 */
export function useTarifaShopee() {
  return useQuery({
    queryKey: ["shopee-tarifa"],
    staleTime: 60 * 60_000,
    queryFn: async (): Promise<Tarifa[]> => {
      const { data, error } = await supabaseExternal.rpc("shopee_tarifa_vigente");
      if (error) throw error;
      return ((data ?? []) as Tarifa[]).map((t) => ({ ...t, preco_min: num(t.preco_min), preco_max: t.preco_max == null ? null : num(t.preco_max), pct: num(t.pct), fixo_unidade: num(t.fixo_unidade) }));
    },
  });
}

/** Comissão + serviço Shopee de 1 unidade ao preço p; null sem tabela. */
export function comissaoShopee(preco: number, tarifa: Tarifa[] | undefined): { valor: number; faixa: Tarifa } | null {
  if (!tarifa || tarifa.length === 0 || preco <= 0) return null;
  const f = tarifa.find((t) => preco >= t.preco_min && (t.preco_max == null || preco < t.preco_max + 0.01));
  if (!f) return null;
  return { valor: Math.round((preco * f.pct + f.fixo_unidade) * 100) / 100, faixa: f };
}

export interface Mc { mc: number; pct: number; comissao: number; regra: string }

// MC estimada no preço dado; null quando falta base (sem CMV ou sem taxas).
// Comissão: tabela Shopee vigente (pct + fixo POR UNIDADE) quando houver;
// senão a % efetiva histórica do SKU. Imposto: % efetiva histórica.
export function calcMc(base: McBase | undefined, preco: number, tarifa?: Tarifa[]): Mc | null {
  if (!base || base.cmv == null || base.imp_pct == null || preco <= 0) return null;
  const tab = comissaoShopee(preco, tarifa);
  let comissao: number; let regra: string;
  if (tab) {
    comissao = tab.valor;
    regra = `comissão Shopee ${(tab.faixa.pct * 100).toFixed(0)}% + R$ ${tab.faixa.fixo_unidade.toFixed(2).replace(".", ",")}/un (tabela de ${tab.faixa.vigencia_inicio.split("-").reverse().join("/")})`;
  } else {
    if (base.com_pct == null) return null;
    comissao = preco * num(base.com_pct);
    regra = `comissão ${(num(base.com_pct) * 100).toFixed(1)}% (histórico)`;
  }
  const mc = preco - comissao - preco * num(base.imp_pct) - num(base.cmv);
  return { mc, pct: mc / preco, comissao, regra };
}
export function corMc(pct: number): string {
  return pct < 0 ? RED : pct < 0.1 ? AMBER : GREEN;
}
export function tituloMc(base: McBase | undefined, mc: Mc | null): string {
  if (mc && base) {
    const br = (x: number) => x.toFixed(2).replace(".", ",");
    return `MC estimada R$ ${br(mc.mc)} por unidade · ${mc.regra} = R$ ${br(mc.comissao)} · imposto ${(num(base.imp_pct) * 100).toFixed(1)}% (${base.fonte === "sku" ? `medido em ${base.n_pedidos} pedidos deste SKU` : "média da loja"}) · CMV R$ ${br(num(base.cmv))}`;
  }
  return base && base.cmv == null ? "Produto sem custo cadastrado — sem MC" : "Sem base para estimar";
}

/** Filtros de margem de contribuição (MC % no preço da promoção). */
export const FAIXAS_MC: Array<{ id: string; rotulo: string; testa: (pct: number) => boolean }> = [
  { id: "todas", rotulo: "Todas", testa: () => true },
  { id: "lt10", rotulo: "MC < 10%", testa: (p) => p < 0.10 },
  { id: "10a15", rotulo: "10–15%", testa: (p) => p >= 0.10 && p < 0.15 },
  { id: "15a20", rotulo: "15–20%", testa: (p) => p >= 0.15 && p < 0.20 },
  { id: "20a25", rotulo: "20–25%", testa: (p) => p >= 0.20 && p < 0.25 },
  { id: "gt25", rotulo: "> 25%", testa: (p) => p >= 0.25 },
];
export function passaFaixa(faixa: string, mc: Mc | null): boolean {
  if (faixa === "todas") return true;
  if (!mc) return false;
  return (FAIXAS_MC.find((f) => f.id === faixa) ?? FAIXAS_MC[0]).testa(mc.pct);
}

/**
 * Maior preço relâmpago que DEVE passar no critério da Shopee (estimativa):
 *  - desconto mínimo de 1% (get_item_criteria da loja: min_discount = 1) → 1% abaixo do preço atual;
 *  - não pode passar do MENOR preço dos últimos 7 dias (erro 10014) → menor preço vendido em 7 dias
 *    nos nossos pedidos (a Shopee não expõe esse piso pela API).
 * Conservador: usa o preço atual do anúncio como base do 1%.
 */
export function tetoRelampago(precoAtual: number, menor7d: number | null | undefined): { teto: number; motivo: string } | null {
  if (precoAtual <= 0) return null;
  const umPorCento = Math.floor(precoAtual * 0.99 * 100) / 100;
  if (menor7d != null && menor7d > 0 && menor7d < umPorCento) {
    return { teto: menor7d, motivo: `menor preço vendido nos últimos 7 dias (${menor7d.toFixed(2).replace(".", ",")}) — a Shopee recusa acima dele` };
  }
  return { teto: umPorCento, motivo: `1% abaixo do preço atual (${precoAtual.toFixed(2).replace(".", ",")}) — desconto mínimo do critério` };
}

export function Foto({ url, size = 44 }: { url: string | null | undefined; size?: number }) {
  const [erro, setErro] = useState(false);
  return (
    <div className="rounded-[8px] shrink-0 overflow-hidden flex items-center justify-center bg-muted" style={{ width: size, height: size }}>
      {url && !erro
        ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setErro(true)} />
        : <Zap className="h-4 w-4 text-muted-foreground" />}
    </div>
  );
}

/** shopee-flashsale (relâmpago) — mesma chamada de sempre. */
export async function chamarFlashsale(qs: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-flashsale?${qs}`, {
    ...init,
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** shopee-promocoes (Minha Promoção) — exige a sessão do usuário (escreve preço público). */
export async function chamarPromocoes(qs: string, body?: unknown): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-promocoes?${qs}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}

/** Traduz as recusas mais comuns da API de promoções da Shopee. */
export function traduzirErroShopee(msg: string | null | undefined): string {
  const m = String(msg ?? "");
  if (/difference between the maximum price and the minimum price/i.test(m)) {
    return "diferença entre a variação mais cara e a mais barata do anúncio ficou grande demais (a Shopee limita) — aproxime os preços promo das variações";
  }
  if (/price.*(higher|greater).*original|promotion price.*original/i.test(m)) return "preço promo precisa ser menor que o preço cheio";
  if (/already.*(exist|in).*promotion|in other promotion|conflict/i.test(m)) return "produto já está em outra promoção no mesmo período";
  if (/stock/i.test(m)) return `estoque: ${m}`;
  return m || "recusado pela Shopee";
}
