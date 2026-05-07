import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

/**
 * Client middleware: injeta o access_token do Supabase no header Authorization
 * antes de chamar uma server function protegida por requireSupabaseAuth.
 */
export const withSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return next({
      sendContext: {},
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
