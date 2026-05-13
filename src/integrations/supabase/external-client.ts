// External Supabase client (read-only data project).
// Auth continues being handled by the main Lovable Cloud client.
// This client only reads views/tables that have RLS open for anon.
import { createClient } from "@supabase/supabase-js";

const EXTERNAL_URL = "https://vhogjofsxyhnyxdyglmq.supabase.co";
const EXTERNAL_PUBLISHABLE_KEY = "sb_publishable_p9wUZdS4TdWF6cRgP8QwEA_Rh5jhqmA";

export const supabaseExternal = createClient(EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    storage: undefined,
  },
});
