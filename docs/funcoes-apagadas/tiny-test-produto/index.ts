// ============================================================================
// Edge Function: tiny-test-produto
// ----------------------------------------------------------------------------
// Exploratoria. Recebe ?sku=X e:
//   1) Lista produtos com aquele codigo via GET /produtos?codigo=X
//   2) Para o 1o resultado, busca detalhe via GET /produtos/{id}
//   3) Se for kit (tipo K), tenta GET /produtos/{id}/kit
//
// Retorna o JSON cru de cada etapa pra mapearmos os campos reais antes de
// codar o sync de produtos + kits.
// ============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const TINY_API_BASE = "https://api.tiny.com.br/public-api/v3";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function pegarTokenTiny(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("oauth_tokens_tiny")
    .select("access_token, expires_at")
    .order("atualizado_em", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error("Token Tiny nao encontrado");
  const exp = new Date(data.expires_at);
  if (exp < new Date()) {
    throw new Error(`Token Tiny expirado em ${exp.toISOString()}. Roda tiny-refresh-token.`);
  }
  return data.access_token;
}

async function tinyGet(path: string, token: string, params: Record<string, any> = {}) {
  const url = new URL(`${TINY_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });
  const txt = await resp.text();
  let payload: any;
  try { payload = JSON.parse(txt); } catch { payload = { _raw: txt }; }
  return { status: resp.status, ok: resp.ok, url: url.toString(), payload };
}

serve(async (req: Request) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response("Faltam secrets Supabase", { status: 500 });
  }

  const url = new URL(req.url);
  const sku = url.searchParams.get("sku");
  if (!sku) return new Response("Forneca ?sku=NUMERO", { status: 400 });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let token: string;
  try { token = await pegarTokenTiny(supabase); }
  catch (err) { return new Response((err as Error).message, { status: 401 }); }

  const out: any = { sku, etapas: {} };

  // Etapa 1: lista produtos por codigo
  const lista = await tinyGet("/produtos", token, { codigo: sku, limit: 5 });
  out.etapas.lista = lista;

  if (!lista.ok) {
    return Response.json(out);
  }

  // Tenta achar o id (a estrutura pode variar: items[], produtos[], data[])
  const candidatos =
    lista.payload?.itens ||
    lista.payload?.items ||
    lista.payload?.produtos ||
    lista.payload?.data ||
    [];

  if (!Array.isArray(candidatos) || candidatos.length === 0) {
    out.etapas.lista_erro = "Nenhum produto encontrado com esse codigo (estrutura desconhecida)";
    return Response.json(out);
  }

  const primeiroId = candidatos[0]?.id;
  if (!primeiroId) {
    out.etapas.lista_erro = "Primeiro item nao tem campo 'id'";
    return Response.json(out);
  }

  // Etapa 2: detalhe do produto
  const detalhe = await tinyGet(`/produtos/${primeiroId}`, token);
  out.etapas.detalhe = detalhe;

  // Etapa 3: se for kit, busca estrutura
  // Possiveis campos que indicam kit: tipo, classeProduto, classe_produto
  const tipo =
    detalhe.payload?.tipo ||
    detalhe.payload?.classeProduto ||
    detalhe.payload?.classe_produto ||
    detalhe.payload?.tipoProduto;

  out.etapas.tipo_detectado = tipo;

  if (tipo === "K" || tipo === "kit" || tipo === "KIT") {
    // Tenta 3 paths possiveis em paralelo
    const tentativas = await Promise.all([
      tinyGet(`/produtos/${primeiroId}/kit`, token),
      tinyGet(`/produtos/${primeiroId}/estrutura`, token),
      tinyGet(`/produtos/${primeiroId}/componentes`, token),
    ]);
    out.etapas.kit_tentativas = {
      "/kit": tentativas[0],
      "/estrutura": tentativas[1],
      "/componentes": tentativas[2],
    };
  }

  return Response.json(out);
});
