import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Modelos de caixa da Amazon (14/out/2026, pedido do dono): por anúncio (msku) e conta — unidades por
// caixa, medidas, peso e a validade a informar. Base do "Criar envio na Amazon" (amazon-inbound). Os
// de origem "histórico" vieram das caixas dos envios já despachados (a API não lista os modelos do
// Seller Central); editar aqui vira "manual".
// ============================================================================

export interface ModeloCaixa {
  shop_id: number; msku: string; sku: string | null; nome: string | null; un_por_caixa: number;
  comprimento_cm: number; largura_cm: number; altura_cm: number; peso_kg: number; validade: string | null;
  origem: string; caixas_historico: number | null; atualizado_em: string; atualizado_por: string | null;
}
type Rascunho = Omit<ModeloCaixa, "origem" | "caixas_historico" | "atualizado_em" | "atualizado_por"> & { novo?: boolean };

const CONTA_NOME: Record<number, string> = { 900001: "Amazon · ACZ Pet", 900002: "Amazon · SVL" };
const EMPRESA_DE: Record<number, string> = { 900001: "ACZ Pet", 900002: "SVL Store" };

export function ModelosCaixaAmazon({ shopId, aberto, onFechar, novoMsku, novoSku }: {
  shopId: number; aberto: boolean; onFechar: () => void; novoMsku?: string | null; novoSku?: string | null;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const q = useQuery({
    queryKey: ["amazon-modelos", shopId],
    enabled: aberto,
    placeholderData: undefined,
    queryFn: async (): Promise<ModeloCaixa[]> => {
      const { data, error } = await supabaseExternal.from("amazon_modelo_caixa").select("*").eq("shop_id", shopId).order("msku");
      if (error) throw error;
      return (data ?? []) as ModeloCaixa[];
    },
  });
  const [linhas, setLinhas] = useState<Rascunho[]>([]);
  const [salvando, setSalvando] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [importando, setImportando] = useState(false);
  /** v8 (20/out/2026): lê as caixas dos envios já despachados da conta e cria os modelos que faltam (amazon-inbound
   *  modelos-importar). Primeiro mostra o que criaria; nunca mexe em modelo que já existe. */
  async function importarHistorico() {
    const empresa = EMPRESA_DE[shopId];
    if (!empresa) return;
    setImportando(true);
    try {
      const chamar = async (dry: boolean) => {
        const { data, error } = await supabaseExternal.functions.invoke("amazon-inbound", { body: { modulo: "modelos-importar", empresa, dry, planos: 60 } });
        if (error) throw new Error(error.message);
        const d = data as { ok: boolean; erro?: string; novos: (ModeloCaixa & { origem: string; caixas_historico: number })[]; planos_lidos: number; planos_encontrados: number; faltou_tempo: boolean };
        if (!d.ok) throw new Error(d.erro ?? "falhou");
        return d;
      };
      const previa = await chamar(true);
      if (!previa.novos.length) { toast.info(`Nenhum modelo novo nos ${previa.planos_lidos} envios lidos — os anúncios enviados já têm modelo.`); return; }
      const lista = previa.novos.slice(0, 25).map((n) => `${n.msku}: ${n.nome ?? ""} (${n.un_por_caixa} un/caixa)${n.validade ? "" : " — sem validade"}`).join("\n");
      if (!window.confirm(`Criar ${previa.novos.length} modelo(s) de caixa a partir de ${previa.planos_lidos} envio(s) já despachado(s)?\n\n${lista}${previa.novos.length > 25 ? "\n…" : ""}\n\nModelos que já existem não mudam. Confira a validade dos produtos que exigem (areia exige).`)) return;
      // grava a própria prévia (a leitura recomeça sempre pelos envios mais recentes); quem já existe é ignorado
      const { error: eIns } = await supabaseExternal.from("amazon_modelo_caixa").upsert(
        previa.novos.map((n) => ({ ...n, atualizado_por: perfil?.nome ?? "importação" })),
        { onConflict: "shop_id,msku", ignoreDuplicates: true },
      );
      if (eIns) throw new Error(eIns.message);
      toast.success(`${previa.novos.length} modelo(s) criados`, { description: `Dos ${previa.planos_lidos} envios mais recentes (de ${previa.planos_encontrados}). Anúncio que não aparece neles: cadastre à mão.` });
      void qc.invalidateQueries({ queryKey: ["amazon-modelos", shopId] });
    } catch (e) {
      toast.error("Não consegui importar", { description: (e as Error).message });
    } finally { setImportando(false); }
  }

  useEffect(() => {
    if (!q.data) return;
    const base: Rascunho[] = q.data.map((m) => ({ ...m }));
    if (novoMsku && !base.some((m) => m.msku === novoMsku)) {
      base.unshift({ shop_id: shopId, msku: novoMsku, sku: novoSku ?? null, nome: "", un_por_caixa: 1, comprimento_cm: 30, largura_cm: 50, altura_cm: 40, peso_kg: 1, validade: null, novo: true });
    }
    setLinhas(base);
    if (novoMsku) setBusca(novoMsku);
  }, [q.data, novoMsku, novoSku, shopId]);

  const mudar = (msku: string, campo: keyof Rascunho, valor: string) =>
    setLinhas((ls) => ls.map((l) => (l.msku === msku ? { ...l, [campo]: ["un_por_caixa", "comprimento_cm", "largura_cm", "altura_cm", "peso_kg"].includes(campo as string) ? Number(valor.replace(",", ".")) : (valor || null) } : l)));

  async function salvar(l: Rascunho) {
    if (!l.msku.trim()) return toast.error("Informe o anúncio (SKU da Amazon)");
    for (const c of ["un_por_caixa", "comprimento_cm", "largura_cm", "altura_cm", "peso_kg"] as const) {
      if (!(Number(l[c]) > 0)) return toast.error("Unidades, medidas e peso precisam ser maiores que zero");
    }
    if (!Number.isInteger(Number(l.un_por_caixa))) return toast.error("Unidades por caixa precisa ser número inteiro");
    setSalvando(l.msku);
    const { error } = await supabaseExternal.from("amazon_modelo_caixa").upsert({
      shop_id: shopId, msku: l.msku.trim(), sku: l.sku || null, nome: l.nome || null, un_por_caixa: Number(l.un_por_caixa),
      comprimento_cm: Number(l.comprimento_cm), largura_cm: Number(l.largura_cm), altura_cm: Number(l.altura_cm), peso_kg: Number(l.peso_kg),
      validade: l.validade || null, origem: "manual", atualizado_em: new Date().toISOString(), atualizado_por: perfil?.nome ?? null,
    }, { onConflict: "shop_id,msku" });
    setSalvando(null);
    if (error) return toast.error("Não salvou o modelo", { description: error.message });
    toast.success(`Modelo de ${l.msku} salvo`);
    void qc.invalidateQueries({ queryKey: ["amazon-modelos", shopId] });
    void qc.invalidateQueries({ queryKey: ["amazon-inbound"] });
  }
  async function excluir(l: Rascunho) {
    if (l.novo) return setLinhas((ls) => ls.filter((x) => x.msku !== l.msku));
    if (!window.confirm(`Excluir o modelo de caixa de ${l.msku}?`)) return;
    const { error } = await supabaseExternal.from("amazon_modelo_caixa").delete().eq("shop_id", shopId).eq("msku", l.msku);
    if (error) return toast.error("Não excluiu", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["amazon-modelos", shopId] });
    void qc.invalidateQueries({ queryKey: ["amazon-inbound"] });
  }
  function adicionar() {
    const msku = window.prompt("SKU do anúncio na Amazon (msku), como aparece no Seller Central:")?.trim();
    if (!msku) return;
    if (linhas.some((l) => l.msku === msku)) { setBusca(msku); return; }
    setLinhas((ls) => [{ shop_id: shopId, msku, sku: null, nome: "", un_por_caixa: 1, comprimento_cm: 30, largura_cm: 50, altura_cm: 40, peso_kg: 1, validade: null, novo: true }, ...ls]);
    setBusca(msku);
  }

  const termo = busca.trim().toLowerCase();
  const visiveis = termo ? linhas.filter((l) => [l.msku, l.sku, l.nome].some((x) => (x ?? "").toLowerCase().includes(termo))) : linhas;
  const num = "h-8 w-[72px] px-2 text-right tabular-nums";

  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-w-6xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Modelos de caixa · {CONTA_NOME[shopId] ?? shopId}</DialogTitle>
          <DialogDescription>
            Quantas unidades vão em cada caixa, as medidas e o peso da caixa cheia, e a validade a informar à Amazon. O envio pela API usa
            estes números para preencher as caixas. Os marcados "histórico" vieram dos envios já despachados.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar anúncio, SKU ou modelo" className="h-9 max-w-xs" />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={adicionar}><Plus className="h-4 w-4" /> Novo modelo</Button>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={importando} onClick={() => void importarHistorico()}>
            {importando ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />} Importar dos envios anteriores
          </Button>
          {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left">Anúncio (msku)</th>
                <th className="px-2 py-2 text-left">Nosso SKU</th>
                <th className="px-2 py-2 text-left">Nome do modelo</th>
                <th className="px-2 py-2 text-right">Un./caixa</th>
                <th className="px-2 py-2 text-right" title="Comprimento × largura × altura, em cm">Medidas (cm)</th>
                <th className="px-2 py-2 text-right">Peso (kg)</th>
                <th className="px-2 py-2 text-left">Validade</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.msku} className="border-t">
                  <td className="px-2 py-1.5 font-mono text-[12px] whitespace-nowrap">
                    {l.msku}
                    {l.novo && <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px]">novo</Badge>}
                  </td>
                  <td className="px-2 py-1.5"><Input className="h-8 w-[90px] px-2" value={l.sku ?? ""} onChange={(e) => mudar(l.msku, "sku", e.target.value)} /></td>
                  <td className="px-2 py-1.5"><Input className="h-8 min-w-[150px] px-2" value={l.nome ?? ""} onChange={(e) => mudar(l.msku, "nome", e.target.value)} placeholder="Ex.: Fardo com 2" /></td>
                  <td className="px-2 py-1.5 text-right"><Input className={num} inputMode="numeric" value={String(l.un_por_caixa)} onChange={(e) => mudar(l.msku, "un_por_caixa", e.target.value)} /></td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      <Input className={num} inputMode="decimal" value={String(l.comprimento_cm)} onChange={(e) => mudar(l.msku, "comprimento_cm", e.target.value)} />×
                      <Input className={num} inputMode="decimal" value={String(l.largura_cm)} onChange={(e) => mudar(l.msku, "largura_cm", e.target.value)} />×
                      <Input className={num} inputMode="decimal" value={String(l.altura_cm)} onChange={(e) => mudar(l.msku, "altura_cm", e.target.value)} />
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right"><Input className={num} inputMode="decimal" value={String(l.peso_kg)} onChange={(e) => mudar(l.msku, "peso_kg", e.target.value)} /></td>
                  <td className="px-2 py-1.5"><Input type="date" className="h-8 w-[140px] px-2" value={l.validade ?? ""} onChange={(e) => mudar(l.msku, "validade", e.target.value)} /></td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <Button size="icon" variant="ghost" className="h-8 w-8" title="Salvar" disabled={salvando === l.msku} onClick={() => void salvar(l)}>
                      {salvando === l.msku ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" title="Excluir" onClick={() => void excluir(l)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!q.isLoading && visiveis.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">Nenhum modelo{termo ? " com essa busca" : ""}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
