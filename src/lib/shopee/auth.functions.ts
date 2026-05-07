/**
 * Server functions relacionadas ao OAuth Shopee.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { withSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { buildAuthUrl } from "./sign.server";

export const getShopeeAuthUrl = createServerFn({ method: "GET" })
  .middleware([withSupabaseAuth, requireSupabaseAuth])
  .inputValidator((data: { redirectUrl: string }) => data)
  .handler(async ({ data }) => {
    return { url: buildAuthUrl(data.redirectUrl) };
  });

export const listShopeeConnections = createServerFn({ method: "GET" })
  .middleware([withSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("oauth_tokens_shopee")
      .select("shop_id, partner_id, expires_at, refresh_expires_at, atualizado_em");
    if (error) throw new Error(error.message);
    return { connections: data ?? [] };
  });
