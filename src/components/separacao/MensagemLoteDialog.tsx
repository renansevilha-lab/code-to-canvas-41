import { useEffect, useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { EXTERNAL_PUBLISHABLE_KEY, EXTERNAL_URL } from "@/integrations/supabase/external-client";

// ============================================================================
// Mensagem em massa aos compradores Shopee de um LOTE (tag) — item 1, 10/set.
// Backend: shopee-chat (preview lista os destinatários; enviar&confirmar=1 manda
// 1 mensagem por pedido via sellerchat/send_message, com dedupe por texto).
// Só Shopee (ML não tem chat de vendedor→comprador por API). Enviar é ação
// externa e irreversível — confirmação forte com contagem.
// ============================================================================

interface Alvo { loja: string; order_sn: string; buyer_user_id: number | null; buyer_username: string | null; produto: string | null }
interface Preview { pedidos_no_lote: number; pedidos_shopee: number; com_buyer_id: number; alvos: Alvo[]; erros: string[] }

const MODELOS: { rotulo: string; texto: string }[] = [
  {
    rotulo: "Despachado",
    texto: "Olá! Seu pedido já foi separado e despachado hoje. 🐾 Assim que a transportadora atualizar o rastreio você recebe a notificação por aqui. Qualquer dúvida é só chamar!",
  },
  {
    rotulo: "Agradecimento",
    texto: "Olá! Obrigado pela compra. 🐾 Seu pedido está sendo preparado com carinho e sai em breve. Se precisar de algo, estamos por aqui!",
  },
  {
    rotulo: "Atraso",
    texto: "Olá! Passando para avisar que seu pedido teve um pequeno atraso na separação e sai no próximo despacho. Pedimos desculpas e agradecemos a paciência. 🐾",
  },
];

export function MensagemLoteDialog({ tag, onClose, enviadoPor }: { tag: string | null; onClose: () => void; enviadoPor: string | null }) {
  const aberto = tag != null;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [texto, setTexto] = useState(MODELOS[0].texto);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!tag) { setPreview(null); return; }
    let vivo = true;
    setCarregando(true);
    fetch(`${EXTERNAL_URL}/functions/v1/shopee-chat?modulo=preview&tag=${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
    })
      .then((r) => r.json())
      .then((d: Preview) => { if (vivo) setPreview(d); })
      .catch((e) => toast.error("Falha ao listar destinatários", { description: (e as Error).message }))
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [tag]);

  const destinatarios = preview?.com_buyer_id ?? 0;

  async function enviar() {
    if (!tag) return;
    const t = texto.trim();
    if (t.length < 10) { toast.error("Mensagem muito curta"); return; }
    const resumo = `${t.slice(0, 160)}${t.length > 160 ? "…" : ""}`;
    if (!window.confirm(
      `Enviar esta mensagem para ${destinatarios} comprador(es) do lote ${tag} na Shopee?\n\n"${resumo}"\n\n` +
      "É irreversível: a mensagem chega no chat de cada cliente. Quem já recebeu este mesmo texto não recebe de novo.",
    )) return;
    setEnviando(true);
    try {
      const r = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-chat?modulo=enviar&tag=${encodeURIComponent(tag)}&confirmar=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ texto: t, por: enviadoPor }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        enviadas?: number; puladas?: number; erro?: string;
        falhas?: { order_sn: string; erro?: string; msg?: string }[];
      };
      if (!r.ok || d.erro) throw new Error(d.erro ?? `HTTP ${r.status}`);
      const falhas = d.falhas ?? [];
      if (falhas.length === 0) {
        toast.success(`${d.enviadas ?? 0} mensagem(ns) enviada(s)`, {
          description: d.puladas ? `${d.puladas} pulada(s) — já tinham recebido este texto ou sem comprador` : undefined,
        });
      } else {
        toast.warning(`${d.enviadas ?? 0} enviada(s), ${falhas.length} falha(s)`, {
          description: `${falhas[0].order_sn}: ${falhas[0].erro ?? ""} ${falhas[0].msg ?? ""}`.trim(),
          duration: 10000,
        });
      }
      onClose();
    } catch (e) {
      toast.error("Falha ao enviar", { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o && !enviando) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Mensagem aos clientes — lote {tag}
          </DialogTitle>
          <DialogDescription>
            Vai pelo chat da Shopee, uma mensagem por pedido. Só pedidos Shopee do lote entram; Mercado Livre não tem chat por API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
            {carregando ? (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> listando destinatários…
              </span>
            ) : preview ? (
              <>
                <span className="font-semibold">{destinatarios}</span> destinatário(s)
                <span className="text-muted-foreground"> · {preview.pedidos_shopee} de {preview.pedidos_no_lote} pedidos do lote são Shopee</span>
                {preview.erros?.length > 0 && <div className="text-destructive mt-1">{preview.erros.join(" · ")}</div>}
                {preview.alvos?.length > 0 && (
                  <div className="text-muted-foreground mt-1 truncate">
                    {preview.alvos.slice(0, 6).map((a) => a.buyer_username ?? a.order_sn).join(", ")}
                    {preview.alvos.length > 6 ? "…" : ""}
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {MODELOS.map((m) => (
              <button
                key={m.rotulo}
                type="button"
                onClick={() => setTexto(m.texto)}
                className={`text-[11px] rounded-full border px-2.5 py-1 hover:bg-accent ${texto === m.texto ? "bg-accent font-medium" : "text-muted-foreground"}`}
              >
                {m.rotulo}
              </button>
            ))}
          </div>

          <Textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5} className="text-sm" maxLength={1000} />
          <p className="text-[11px] text-muted-foreground">{texto.length}/1000 · o mesmo texto nunca é reenviado ao mesmo pedido.</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button onClick={() => void enviar()} disabled={enviando || carregando || destinatarios === 0} className="gap-1.5">
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Enviar para {destinatarios}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
