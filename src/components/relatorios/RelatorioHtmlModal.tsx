import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { Copy, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { nomeDoAgente, quandoGerado, type RelatorioLista } from "./comum";

// "Ver versão completa" (design: modal até 880 px, corpo em "papel" branco).
// O corpo_html (e o corpo_texto para copiar) só é buscado aqui, sob demanda, e
// fica em cache. O HTML do agente é e-mail com estilos inline: passa pelo
// DOMPurify (sem script/style/iframe/form) e o CSS .relatorio-html.rl-papel
// (styles.css) ajusta fonte, tabelas e bordas.

export function RelatorioHtmlModal({
  rel, open, onOpenChange,
}: {
  rel: RelatorioLista;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["relatorios", "html", rel.id],
    enabled: open,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("relatorios_agentes").select("corpo_html, corpo_texto").eq("id", rel.id).maybeSingle();
      if (error) throw error;
      return (data ?? { corpo_html: null, corpo_texto: null }) as { corpo_html: string | null; corpo_texto: string | null };
    },
  });

  const limpo = useMemo(() => {
    const html = q.data?.corpo_html;
    if (!html) return "";
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input", "button", "link", "meta"],
    });
  }, [q.data?.corpo_html]);

  async function copiar() {
    const t = q.data?.corpo_texto;
    if (!t) { toast.error("Este relatório não tem versão em texto"); return; }
    try {
      await navigator.clipboard.writeText(t);
      toast.success("Texto do relatório copiado");
    } catch {
      toast.error("Não foi possível copiar");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rl-ui max-w-[880px] w-[calc(100vw-24px)] max-h-[calc(100vh-48px)] p-0 gap-0 overflow-hidden flex flex-col rounded-xl border-(--rl-border) bg-(--rl-surface)">
        <div className="flex justify-between items-center gap-3 pl-[18px] pr-12 py-3.5 border-b border-(--rl-border)">
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-semibold truncate">{rel.titulo ?? "Relatório"}</DialogTitle>
            <DialogDescription className="text-[12px] text-(--rl-text-3)">
              Versão completa (HTML gerado pelo agente){rel.gerado_em ? ` · ${quandoGerado(rel.gerado_em)}` : ""}
            </DialogDescription>
          </div>
          <button type="button" onClick={() => void copiar()} disabled={!q.data?.corpo_texto}
            className="flex items-center gap-1.5 shrink-0 text-[13px] font-medium px-2.5 py-1.5 rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) hover:bg-(--rl-surface-2) disabled:opacity-50 cursor-pointer">
            <Copy className="h-3.5 w-3.5" /> Copiar texto
          </button>
        </div>
        <div className="flex-1 overflow-auto px-7 py-6" style={{ background: "oklch(1 0 0)", color: "oklch(0.25 0.01 285)" }}>
          <div className="text-[11px] tracking-[0.06em] uppercase mb-2" style={{ color: "oklch(0.5 0.01 285)" }}>
            Agente {nomeDoAgente(rel.agente)}
          </div>
          {q.isLoading && (
            <div className="flex items-center justify-center py-16 text-sm" style={{ color: "oklch(0.5 0.01 285)" }}>
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Carregando versão completa…
            </div>
          )}
          {q.error && (
            <div className="flex flex-col items-center gap-3 py-12 text-sm" style={{ color: "oklch(0.5 0.01 285)" }}>
              Não deu para carregar o relatório completo.
              <button type="button" onClick={() => void q.refetch()}
                className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[7px] border cursor-pointer">
                <RotateCw className="h-3.5 w-3.5" /> Tentar de novo
              </button>
            </div>
          )}
          {q.data && !limpo && !q.isLoading && (
            <div className="py-12 text-center text-sm" style={{ color: "oklch(0.5 0.01 285)" }}>Este relatório não tem versão completa.</div>
          )}
          {limpo && (
            <div className="relatorio-html rl-papel overflow-x-auto" dangerouslySetInnerHTML={{ __html: limpo }} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
