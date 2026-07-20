// Único cliente Supabase do app. Aponta para o projeto de dados externo
// e cuida também da autenticação (signIn/signOut/session).
import { createClient } from "@supabase/supabase-js";

export const EXTERNAL_URL = "https://vhogjofsxyhnyxdyglmq.supabase.co";
export const EXTERNAL_PUBLISHABLE_KEY = "sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA";

export const supabaseExternal = createClient(EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY, {
  auth: {
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    storageKey: "sb-vhogjofsxyhnyxdyglmq-auth-token",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
