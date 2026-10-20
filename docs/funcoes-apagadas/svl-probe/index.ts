// DESATIVADA. Era ferramenta temporaria de descoberta (proxy read-only do Tiny).
// Mantida como stub inerte ate ser removida no painel. Nao proxia mais nada.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
serve(() => new Response(JSON.stringify({ disabled: true, msg: "svl-probe desativada" }), { status: 410, headers: { "Content-Type": "application/json" } }));
