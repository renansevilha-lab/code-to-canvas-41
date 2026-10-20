// ============================================================================
// Edge Function: ml-debug — TEMPORARIA, so leitura.
// Explora endpoints da API do ML para descobrir onde vive o prazo de despacho.
// Uso: ?path=/shipments/123/sla   (qualquer caminho GET da API do ML)
// Nao grava nada. Apagar depois da investigacao.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ML_API = "https://api.mercadolibre.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async (req: Request) => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: tok } = await supabase
    .from("oauth_tokens_ml").select("access_token, expires_at")
    .order("atualizado_em", { ascending: false }).limit(1).single();
  if (!tok) return Response.json({ erro: "token ML nao encontrado" }, { status: 401 });
  if (new Date(tok.expires_at) < new Date()) {
    return Response.json({ erro: `token expirado em ${tok.expires_at}` }, { status: 401 });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return Response.json({ uso: "?path=/shipments/ID/sla" }, { status: 400 });

  const resp = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
  });
  const texto = await resp.text();
  let corpo: unknown;
  try { corpo = JSON.parse(texto); } catch { corpo = texto.slice(0, 1000); }

  return Response.json({ path, status: resp.status, corpo });
});
