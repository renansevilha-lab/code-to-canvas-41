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
      // Uma rota que falha NÃO derruba as outras (17/set): antes, um erro na
      // 1ª rota abortava o resto e a tela dizia "falha" com metade sincronizada.
      const falhas: string[] = [];
      const avisos: string[] = [];
      for (const rota of rotas) {
        const nome = rota.split("?")[0].replace("fulfillment-sync", "").replace(/^-/, "") || rota.split("?")[0];
        const q = new URLSearchParams(rota.split("?")[1] ?? "");
        const rotuloRota = [q.get("modulo"), q.get("loja")].filter(Boolean).join(" ") || nome;
        try {
          const resp = await fetch(`${EXTERNAL_URL}/functions/v1/${rota}`, {
            headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
          });
          const corpo = (await resp.json().catch(() => ({}))) as { erro?: string; erros?: string[] };
          if (!resp.ok || corpo?.erro) falhas.push(`${rotuloRota}: ${corpo?.erro ?? `HTTP ${resp.status}`}`);
          else if (Array.isArray(corpo?.erros) && corpo.erros.length > 0) avisos.push(`${rotuloRota}: ${corpo.erros[0]}`);
        } catch (e) {
          falhas.push(`${rotuloRota}: ${(e as Error).message}`);
        }
      }
      if (invalidar) void qc.invalidateQueries({ queryKey: invalidar });
      onConcluido?.();
      if (falhas.length === rotas.length) {
        toast.error("Falha ao sincronizar", { description: falhas.join(" · "), duration: 10000 });
      } else if (falhas.length > 0) {
        toast.warning(`Sincronizado em parte — ${falhas.length} de ${rotas.length} falhou`, { description: falhas.join(" · "), duration: 10000 });
      } else if (avisos.length > 0) {
        toast.success("Sincronizado (com avisos)", { description: avisos.join(" · "), duration: 8000 });
      } else {
        toast.success("Sincronizado", { description: "Dados atualizados a partir da origem." });
      }
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
