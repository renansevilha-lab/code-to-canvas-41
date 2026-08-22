import {
  EXTERNAL_URL,
  EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";

/**
 * Aviso no Discord a partir do front.
 *
 * Passa só o TEMA (`canal`) — a URL do webhook fica no secret da edge function
 * `discord-notify`, nunca aqui. Trocar de canal no Discord não mexe em código,
 * e a credencial não vai para o bundle do navegador.
 *
 * É deliberadamente **fire-and-forget**: notificação nunca pode derrubar a
 * operação. Se o Discord estiver fora do ar, o envio continua criado e o
 * operador não vê erro nenhum — só um aviso no console.
 */
export type CanalDiscord =
  | "geral" | "pedidos" | "fulfilment" | "erros"
  | "estoque" | "devolucoes" | "compras";

export interface AvisoDiscord {
  canal: CanalDiscord;
  titulo: string;
  descricao?: string;
  /** pinta o embed: ok verde · info azul · aviso âmbar · erro vermelho */
  nivel?: "ok" | "info" | "aviso" | "erro";
  campos?: { nome: string; valor: string; inline?: boolean }[];
  url?: string;
  rodape?: string;
}

export function avisarDiscord(aviso: AvisoDiscord): void {
  void (async () => {
    try {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/discord-notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify(aviso),
      });
      if (!resp.ok) {
        console.warn("discord-notify falhou", resp.status, await resp.text().catch(() => ""));
      }
    } catch (e) {
      console.warn("discord-notify indisponível", (e as Error).message);
    }
  })();
}
