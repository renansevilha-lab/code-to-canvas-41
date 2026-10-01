import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, PackageCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatBRL, formatNumber } from "@/lib/format";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Lançar no Tiny a ENTRADA de estoque da compra pelo que foi CONFERIDO no app
// (decisão do dono, 01/out/2026: o app lança, mas só com clique). Edge fn
// compras-estoque: preview → confirmar; depósito Geral; idempotente (ledger
// compras_estoque_lancamentos) — clicar de novo lança só a diferença.
// A equipe NÃO lança mais o estoque pela NF no Tiny (senão dobra).
// ============================================================================

interface ItemPlano {
  sku: string; nome: string | null; origem: string; recebido: number; ja_lancado: number; a_lancar: number; preco_unitario: number;
}
interface Preview {
  plano: ItemPlano[]; avisos: Array<{ sku: string | null; motivo: string }>;
  ordem: { numero: string | null; estoque_lancado_em: string | null };
}

async function chamar(qs: string): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/compras-estoque?${qs}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}

export function LancarEstoqueTiny({ ordemTinyId, numero, lancadoEm }: {
  ordemTinyId: number; numero: string | null; lancadoEm: string | null;
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [prev, setPrev] = useState<Preview | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [lancando, setLancando] = useState(false);

  async function abrir() {
    setCarregando(true);
    try { setPrev(await chamar(`modulo=preview&ordem_tiny_id=${ordemTinyId}`)); }
    catch (e) { toast.error("Falha ao montar a prévia", { description: (e as Error).message }); }
    finally { setCarregando(false); }
  }

  async function lancar() {
    setLancando(true);
    try {
      const r = await chamar(`modulo=lancar&ordem_tiny_id=${ordemTinyId}&confirmar=1&lancado_por=${encodeURIComponent(perfil?.nome ?? "app")}`);
      if (r.ok) toast.success(`Estoque lançado no Tiny — ${r.movimentos} SKU(s)`, { description: `OC #${numero ?? ordemTinyId} · depósito Geral` });
      else toast.warning(`${r.movimentos} lançado(s) · ${r.erros?.length ?? 0} erro(s)`, { description: (r.erros ?? []).slice(0, 5).join("\n"), duration: 15000 });
      setPrev(null);
      void qc.invalidateQueries({ queryKey: ["compras", "ordem", ordemTinyId] });
    } catch (e) {
      toast.error("Falha ao lançar no Tiny", { description: (e as Error).message });
    } finally { setLancando(false); }
  }

  const fila = (prev?.plano ?? []).filter((p) => p.a_lancar > 0);

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" disabled={carregando} onClick={() => void abrir()}
        title={lancadoEm ? `Último lançamento: ${new Date(lancadoEm).toLocaleString("pt-BR")}` : "Lançar no Tiny a entrada do que foi conferido"}>
        {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageCheck className="h-4 w-4" />}
        {lancadoEm ? "Estoque lançado ✓" : "Lançar estoque no Tiny"}
      </Button>

      <Dialog open={prev !== null} onOpenChange={(v) => { if (!v) setPrev(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Lançar estoque no Tiny — OC #{numero ?? ordemTinyId}</DialogTitle>
            <DialogDescription>
              Entrada no depósito <b>Geral</b> das unidades <b>conferidas</b> (já convertidas de fardo/caixa).
              Só lança o que ainda não foi lançado. <b>Não lance também pela NF no Tiny</b> — o estoque dobraria.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-muted-foreground text-[10px] uppercase">
                <tr>
                  <th className="text-left px-2 py-1.5 font-medium">SKU</th>
                  <th className="text-left px-2 py-1.5 font-medium">Produto</th>
                  <th className="text-right px-2 py-1.5 font-medium">Conferido</th>
                  <th className="text-right px-2 py-1.5 font-medium">Já lançado</th>
                  <th className="text-right px-2 py-1.5 font-medium">A lançar</th>
                  <th className="text-right px-2 py-1.5 font-medium" title="Custo unitário enviado ao Tiny (preço da OC)">Custo un.</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(prev?.plano ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Nada conferido nesta OC ainda.</td></tr>
                ) : prev!.plano.map((p) => (
                  <tr key={p.sku} className={p.a_lancar > 0 ? "" : "opacity-50"}>
                    <td className="px-2 py-1.5 font-mono">{p.sku}</td>
                    <td className="px-2 py-1.5 max-w-[280px] truncate" title={p.nome ?? ""}>{p.nome ?? "—"}{p.origem !== "direto" ? <span className="text-muted-foreground"> · {p.origem}</span> : null}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatNumber(p.recebido)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatNumber(p.ja_lancado)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{formatNumber(p.a_lancar)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">{p.preco_unitario > 0 ? formatBRL(p.preco_unitario) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(prev?.avisos ?? []).length > 0 && (
            <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
              <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> Fora do lançamento</div>
              {prev!.avisos.slice(0, 12).map((a, i) => <div key={i}><span className="font-mono">{a.sku ?? "—"}</span>: {a.motivo}</div>)}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPrev(null)}>Cancelar</Button>
            <Button size="sm" className="gap-1.5" disabled={fila.length === 0 || lancando} onClick={() => void lancar()}>
              {lancando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
              Lançar {fila.length} SKU(s) no Tiny
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
