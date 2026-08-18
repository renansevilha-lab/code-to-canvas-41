import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

type Props = {
  /**
   * Rotas das edge functions, com query, na ordem em que devem rodar.
   * Ex.: "tiny-sync-produtos?modulo=produtos&limite=5000"
   */
  rotas: string[];
  rotulo?: string;
  /** Tooltip — bom lugar para dizer de quanto em quanto tempo o cron roda sozinho. */
  titulo?: string;
  /** Prefixo de queryKey a invalidar (telas com react-query). */
  invalidar?: string[];
  /** Callback para telas que carregam com useEffect/useState. */
  onConcluido?: () => void;
};

/**
 * Dispara na mão a mesma edge function que o cron roda.
 *
 * Os crons de catálogo, contas a pagar, Full e promoções foram reduzidos para
 * 1–2x por dia (o compute é NANO e o excesso de execuções derrubou o banco em
 * 17/ago/2026). Este botão é a válvula de escape: quem precisa do dado fresco
 * agora puxa na hora, sem manter dezenas de execuções por hora rodando à toa.
 */
export function BotaoSincronizar({ rotas, rotulo = "Sincronizar", titulo, invalidar, onConcluido }: Props) {
  const [rodando, setRodando] = useState(false);
  const qc = useQueryClient();

  async function sincronizar() {
    if (rodando) return;
    setRodando(true);
    try {
      // Em sequência de propósito: cada função abre conexão no banco, e o
      // objetivo aqui é justamente não empilhar carga no compute.
      for (const rota of rotas) {
        const resp = await fetch(`${EXTERNAL_URL}/functions/v1/${rota}`, {
          headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
        });
        const corpo = (await resp.json().catch(() => ({}))) as { erro?: string };
        if (!resp.ok || corpo?.erro) {
          throw new Error(corpo?.erro ?? `HTTP ${resp.status} em ${rota.split("?")[0]}`);
        }
      }
      toast.success("Sincronizado", { description: "Dados atualizados a partir da origem." });
      if (invalidar) void qc.invalidateQueries({ queryKey: invalidar });
      onConcluido?.();
    } catch (e) {
      toast.error("Falha ao sincronizar", { description: (e as Error).message });
    } finally {
      setRodando(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 gap-2"
      title={titulo}
      onClick={() => void sincronizar()}
      disabled={rodando}
    >
      {rodando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      {rodando ? "Sincronizando…" : rotulo}
    </Button>
  );
}
