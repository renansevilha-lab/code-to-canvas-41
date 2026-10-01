import { useState } from "react";
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

// MC estimada no preço dado; null quando falta base (sem CMV ou sem taxas).
export function calcMc(base: McBase | undefined, preco: number): { mc: number; pct: number } | null {
  if (!base || base.cmv == null || base.com_pct == null || base.imp_pct == null || preco <= 0) return null;
  const mc = preco * (1 - num(base.com_pct) - num(base.imp_pct)) - num(base.cmv);
  return { mc, pct: mc / preco };
}
export function corMc(pct: number): string {
  return pct < 0 ? RED : pct < 0.1 ? AMBER : GREEN;
}
export function tituloMc(base: McBase | undefined, mc: { mc: number; pct: number } | null): string {
  if (mc && base) {
    return `MC estimada ${mc.mc.toFixed(2).replace(".", ",")} por unidade · comissão ${(num(base.com_pct) * 100).toFixed(1)}% + imposto ${(num(base.imp_pct) * 100).toFixed(1)}% (${base.fonte === "sku" ? `medidos em ${base.n_pedidos} pedidos deste SKU` : "média da loja — SKU sem pedidos recentes"}) · CMV ${num(base.cmv).toFixed(2).replace(".", ",")}`;
  }
  return base && base.cmv == null ? "Produto sem custo cadastrado — sem MC" : "Sem base para estimar";
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
