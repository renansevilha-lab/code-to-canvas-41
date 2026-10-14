import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { NOME_INSTRUCOES, USOS_INSTRUCOES } from "@/lib/iaAnuncio";

// ============================================================================
// Instruções extras para a IA, por produto (14/out/2026, pedido do dono).
// Ex.: "Este produto tem 3 opções de cores; a capa deve mostrar as três."
// Mora no cadastro de contextos (ia_contexto: escopo sku, papel diretriz, tipo texto,
// nome fixo NOME_INSTRUCOES) — sem tabela nova. Vale para textos e fotos; nas fotos o
// servidor trata como OBRIGATÓRIA (ia-anuncio v4 / ia-imagem-worker v3) e diz a cada
// prompt qual é a foto, para a instrução "a capa…" valer só para as capas.
// ============================================================================

export interface InstrucaoProduto { id: string; conteudo: string | null; ativo: boolean; updated_at: string }

/** A instrução do produto (a mais recente com o nome fixo). */
export function useInstrucoesProduto(sku: string) {
  return useQuery({
    queryKey: ["ia-anuncio", "instrucoes", sku],
    enabled: !!sku,
    staleTime: 60_000,
    queryFn: async (): Promise<InstrucaoProduto | null> => {
      const { data, error } = await supabaseExternal.from("ia_contexto").select("id, conteudo, ativo, updated_at")
        .eq("escopo", "sku").eq("chave", sku).eq("nome", NOME_INSTRUCOES).order("updated_at", { ascending: false }).limit(1);
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as InstrucaoProduto | null;
    },
  });
}

export function InstrucoesIa({ sku }: { sku: string }) {
  const qc = useQueryClient();
  const q = useInstrucoesProduto(sku);
  const salvo = q.data?.ativo ? (q.data.conteudo ?? "") : "";
  const [texto, setTexto] = useState(salvo);
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setTexto(salvo); }, [salvo]);
  const mudou = texto.trim() !== salvo.trim();

  async function salvar() {
    setSalvando(true);
    try {
      const conteudo = texto.trim();
      if (q.data) {
        const { error } = await supabaseExternal.from("ia_contexto")
          .update({ conteudo: conteudo || q.data.conteudo, ativo: !!conteudo, aplica_em: USOS_INSTRUCOES }).eq("id", q.data.id);
        if (error) throw error;
      } else if (conteudo) {
        const { error } = await supabaseExternal.from("ia_contexto").insert({
          nome: NOME_INSTRUCOES, escopo: "sku", chave: sku, tipo: "texto", papel: "diretriz", conteudo,
          aplica_em: USOS_INSTRUCOES, prioridade: 100, ativo: true,
        });
        if (error) throw error;
      }
      toast.success(conteudo ? "Instruções salvas" : "Instruções apagadas", {
        description: conteudo
          ? "Valem para os próximos textos e imagens. Foto com prompt escrito antes desta mudança tem o prompt reescrito sozinho ao gerar a imagem."
          : undefined,
      });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio", "instrucoes", sku] });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio", "referencias", sku] });
    } catch (e) {
      toast.error("Não foi possível salvar as instruções", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">Instruções extras para a IA (valem para os textos e as fotos deste produto)</span>
      <Textarea rows={2} className="text-sm" value={texto} onChange={(e) => setTexto(e.target.value)} disabled={q.isLoading}
        placeholder="Ex.: Este produto tem 3 opções de cores (azul, rosa e verde); a capa deve mostrar as três lado a lado." />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!mudou || salvando} onClick={() => void salvar()}>
          {salvando && <Loader2 className="h-3 w-3 animate-spin mr-1" />}Salvar instruções
        </Button>
        <span className="text-[10.5px] text-muted-foreground">Diga a qual foto se refere ("a capa", "a lifestyle"); sem citar, vale para todas.</span>
      </div>
    </div>
  );
}
