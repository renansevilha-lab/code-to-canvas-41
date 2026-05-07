/**
 * Callback OAuth da Shopee.
 * A Shopee redireciona aqui com ?code=XXX&shop_id=YYY após o vendedor
 * autorizar o app. Trocamos o code por access_token + refresh_token e
 * salvamos em oauth_tokens_shopee.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  shopeeHost,
  shopeePartnerId,
  signPublic,
} from "@/lib/shopee/sign.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/shopee/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const shopIdStr = url.searchParams.get("shop_id");

        if (!code || !shopIdStr) {
          return htmlResponse(
            "Erro: Faltam parâmetros code/shop_id no callback.",
            400
          );
        }
        const shopId = Number(shopIdStr);

        try {
          const path = "/api/v2/auth/token/get";
          const timestamp = Math.floor(Date.now() / 1000);
          const sign = signPublic(path, timestamp);
          const partnerId = shopeePartnerId();

          const apiUrl = `${shopeeHost()}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
          const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              shop_id: shopId,
              partner_id: partnerId,
            }),
          });
          const json = (await res.json()) as {
            access_token?: string;
            refresh_token?: string;
            expire_in?: number;
            error?: string;
            message?: string;
          };

          if (!json.access_token || !json.refresh_token) {
            return htmlResponse(
              `Erro Shopee: ${json.error ?? "?"} - ${json.message ?? JSON.stringify(json)}`,
              502
            );
          }

          const now = Date.now();
          const expiresAt = new Date(
            now + (json.expire_in ?? 14400) * 1000
          ).toISOString();
          // Refresh token Shopee = 30 dias
          const refreshExpiresAt = new Date(
            now + 30 * 24 * 3600 * 1000
          ).toISOString();

          const { error: dbErr } = await supabaseAdmin
            .from("oauth_tokens_shopee")
            .upsert(
              {
                shop_id: shopId,
                partner_id: partnerId,
                access_token: json.access_token,
                refresh_token: json.refresh_token,
                expires_at: expiresAt,
                refresh_expires_at: refreshExpiresAt,
              },
              { onConflict: "shop_id" }
            );

          if (dbErr) {
            return htmlResponse(`Erro ao salvar token: ${dbErr.message}`, 500);
          }

          // Garante registro em lojas
          await supabaseAdmin.from("lojas").upsert(
            {
              shop_id: shopId,
              nome: `Loja Shopee ${shopId}`,
              ativa: true,
            },
            { onConflict: "shop_id" }
          );

          return htmlResponse(
            `<h1>✅ Loja conectada</h1>
             <p>Shop ID: <b>${shopId}</b></p>
             <p>Você já pode fechar esta janela e voltar ao app.</p>
             <script>setTimeout(()=>{window.location.href="/conexoes?ok=1&shop_id=${shopId}"},1500)</script>`,
            200
          );
        } catch (e) {
          return htmlResponse(`Erro inesperado: ${(e as Error).message}`, 500);
        }
      },
    },
  },
});

function htmlResponse(body: string, status: number): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Shopee Callback</title>
     <style>body{font-family:system-ui;padding:2rem;max-width:600px;margin:auto;color:#0f172a}</style>
     </head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
