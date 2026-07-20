// Re-export do único cliente Supabase do app (projeto externo).
// Toda autenticação e leitura de dados passa por essa mesma instância.
export { supabaseExternal as supabase } from "./external-client";
