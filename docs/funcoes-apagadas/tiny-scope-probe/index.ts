// DESATIVADA (31/ago). Sonda temporaria que verificou, sem emitir nada, se o
// app do Tiny de cada conta tem permissao de ESCRITA em notas fiscais
// (POST /notas/0/emitir: 403 = falta escopo, 404 = escopo ok).
// Resultado: Ottz e SVL tem a permissao — a falha de emissao era outra coisa
// (espelho `devolucoes_svl` congelado desde 01/ago, sem cron).
// Se precisar de novo, reescreva por deploy.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(() =>
  new Response(
    JSON.stringify({ desativada: true, motivo: "diagnostico concluido em 31/ago" }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
);
