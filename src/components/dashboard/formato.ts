// Formatação comum dos blocos novos do Dashboard (design "Visão geral", 21/out/2026).
import { supabaseExternal } from "@/integrations/supabase/external-client";

/** R$ compacto do design: ≥ 10 mil vira "R$ 233,7 mil". */
export function L(v: number): string {
  const a = Math.abs(v), s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}R$ ${(a / 1e6).toFixed(2).replace(".", ",")} mi`;
  if (a >= 1e4) return `${s}R$ ${(a / 1e3).toFixed(1).replace(".", ",")} mil`;
  return `${s}R$ ${Math.round(a).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}
/** valor já em pontos percentuais (6,1 → "6,1%") */
export const pct = (v: number, d = 1) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d).replace(".", ",")}%`;
export const int = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
export const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
export const LOGO: Record<string, string> = { shopee: "/logos/shopee-icon.png", mercadolivre: "/logos/ml-icon.png", amazon: "/logos/amazon-icon.png", tiktok: "/logos/tiktok-icon.png" };

/** "há 12 min", "há 3 h", "hoje 06h20", "20/10 06h20" — e se passou de 1 dia (dado velho). */
export function idade(iso: string | null | undefined): { txt: string; velho: boolean } {
  if (!iso) return { txt: "—", velho: false };
  const ms = Date.now() - Date.parse(iso);
  const min = Math.max(0, Math.round(ms / 60000));
  const hm = new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  if (min < 1) return { txt: "agora", velho: false };
  if (min < 60) return { txt: `há ${min} min`, velho: false };
  if (min < 12 * 60) return { txt: `há ${Math.round(min / 60)} h`, velho: false };
  const dia = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  if (dia === hojeSP()) return { txt: `hoje ${hm}`, velho: false };
  return { txt: `${ddmm(dia)} ${hm}`, velho: min > 24 * 60 };
}

/** RPC sem argumentos que devolve jsonb pronto. */
export async function rpc<T>(nome: string): Promise<T> {
  const { data, error } = await supabaseExternal.rpc(nome as never);
  if (error) throw error;
  return data as T;
}
