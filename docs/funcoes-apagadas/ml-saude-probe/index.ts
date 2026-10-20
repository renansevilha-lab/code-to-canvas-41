// ml-saude-probe — DESATIVADO (era descartavel, usado so p/ travar os formatos da API ML).
// Mantido como stub 410 ate poder ser deletado pelo dono no painel do Supabase.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
serve(() => new Response(JSON.stringify({ gone: true, msg: "probe desativado; pode deletar" }), { status: 410, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }));
