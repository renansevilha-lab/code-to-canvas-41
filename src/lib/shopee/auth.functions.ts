/**
 * Server functions relacionadas ao OAuth Shopee.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildAuthUrl } from "./sign.server";

export const getShopeeAuthUrl = createServerFn({ method: "GET" })
  .middleware([withSupabaseAuth, requireSupabaseAuth])
  .inputValidator((data: { redirectUrl: string }) => data)
  .handler(async ({ data }) => {
    return { url: buildAuthUrl(data.redirectUrl) };
  });

export const listShopeeConnections = createServerFn({ method: "GET" })
  .middleware([withSupabaseAuth, requireSupabaseAuth])
  .handler(async () => {
    // Le SO metadados (nunca access_token/refresh_token) via service_role.
    // A tabela oauth_tokens_shopee fica travada para anon/authenticated (so
    // service_role) — por seguranca dos secrets. O login ja e exigido pelo
    // middleware requireSupabaseAuth acima.
    const { data, error } = await supabaseAdmin
      .from("oauth_tokens_shopee")
      .select("shop_id, partner_id, expires_at, refresh_expires_at, atualizado_em");
    if (error) throw new Error(error.message);
    return { connections: data ?? [] };
  });
