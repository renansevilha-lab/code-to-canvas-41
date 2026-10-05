import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { Copy, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { ddmm, horaSP, type RelatorioLista } from "./comum";

// "Ver versão completa": o corpo_html (e o corpo_texto para copiar) só é
// buscado aqui, sob demanda, e fica em cache. O HTML do agente é e-mail com
// estilos inline: passa pelo DOMPurify (sem script/style/iframe/form) e o CSS
// .relatorio-html (styles.css) troca fonte, largura de tabela, bordas e, no
// modo escuro, fundo/cor do texto pelos tokens do app.

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
      <DialogContent className="max-w-5xl w-[calc(100vw-2rem)] max-h-[90vh] flex flex-col gap-3 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0 flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex flex-col gap-1 min-w-0">
            <DialogTitle className="truncate">{rel.titulo ?? "Relatório"}</DialogTitle>
            <DialogDescription>
              Referência {ddmm(rel.data_referencia)}{rel.gerado_em ? ` · gerado às ${horaSP(rel.gerado_em)}` : ""}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 shrink-0 mr-6" onClick={() => void copiar()}
            disabled={!q.data?.corpo_texto}>
            <Copy className="h-3.5 w-3.5" /> Copiar texto
          </Button>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {q.isLoading && (
            <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Carregando versão completa…
            </div>
          )}
          {q.error && (
            <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
              Não deu para carregar o relatório completo.
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void q.refetch()}>
                <RotateCw className="h-3.5 w-3.5" /> Tentar de novo
              </Button>
            </div>
          )}
          {q.data && !limpo && !q.isLoading && (
            <div className="py-12 text-center text-sm text-muted-foreground">Este relatório não tem versão completa.</div>
          )}
          {limpo && (
            <div className="overflow-x-auto rounded-lg border">
              <div className="relatorio-html p-4" dangerouslySetInnerHTML={{ __html: limpo }} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
