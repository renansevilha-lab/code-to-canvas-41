import { useEffect, useRef } from "react";

// ============================================================================
// Logout por inatividade — SÓ FORA DO EXPEDIENTE.
//
// Pedido do dono (20/ago/2026): a sessão do Supabase se renova
// indefinidamente, então quem loga uma vez nunca mais é desconectado naquele
// navegador. Deslogar durante o dia atrapalharia a bancada no meio do
// trabalho, então a regra só vale a partir das 18h — e depois de 1 HORA
// parado, não de alguns minutos: no galpão é normal ficar longe da máquina.
//
// A janela vai das 18h às 7h — não só "depois das 18h". Se parasse na
// meia-noite, a máquina esquecida ligada à noite voltaria a ficar logada para
// sempre a partir das 00h, que é justamente o cenário que queremos evitar.
//
// Hora sempre em America/Sao_Paulo: o horário do computador do galpão pode
// estar em qualquer fuso, e a regra é sobre o expediente, não sobre o relógio
// da máquina.
// ============================================================================

const MINUTOS_INATIVIDADE = 60;
const HORA_INICIO_FORA = 18; // a partir das 18h
const HORA_FIM_FORA = 7; // até as 7h
const INTERVALO_CHECAGEM_MS = 60_000;

/** Hora cheia (0–23) em São Paulo. */
function horaSP(): number {
  return Number(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }),
  );
}

function foraDoExpediente(): boolean {
  const h = horaSP();
  return h >= HORA_INICIO_FORA || h < HORA_FIM_FORA;
}

/**
 * Desconecta a sessão após `MINUTOS_INATIVIDADE` sem interação, mas apenas
 * fora do expediente. Durante o dia o contador roda, só não desloga.
 */
export function useLogoutInatividade(signOut: () => void | Promise<unknown>) {
  const ultimaAtividade = useRef<number>(Date.now());
  const saindo = useRef(false);

  useEffect(() => {
    // Throttle: mousemove dispara centenas de vezes por segundo e não vale
    // gravar timestamp em todas — 1x por segundo já mantém o contador certo.
    let ultimoRegistro = 0;
    const marcar = () => {
      const agora = Date.now();
      if (agora - ultimoRegistro < 1000) return;
      ultimoRegistro = agora;
      ultimaAtividade.current = agora;
    };

    const eventos: Array<keyof WindowEventMap> = [
      "mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel", "focus",
    ];
    for (const ev of eventos) {
      window.addEventListener(ev, marcar, { passive: true });
    }

    const timer = window.setInterval(() => {
      if (saindo.current) return;
      if (!foraDoExpediente()) return;

      const paradoMs = Date.now() - ultimaAtividade.current;
      if (paradoMs >= MINUTOS_INATIVIDADE * 60_000) {
        saindo.current = true;
        void Promise.resolve(signOut());
      }
    }, INTERVALO_CHECAGEM_MS);

    return () => {
      for (const ev of eventos) window.removeEventListener(ev, marcar);
      window.clearInterval(timer);
    };
  }, [signOut]);
}
