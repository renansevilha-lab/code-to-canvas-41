import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PackageCheck, XCircle } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ============================================================================
// Lançar no Tiny, de uma vez, o estoque dos envios JÁ ENVIADOS que ainda não
// foram lançados (dono, 05/out/2026). Mesma edge fn do botão do envio
// (fulfillment-estoque: transferência Geral → depósito Full, pelo EMBALADO),
// chamada envio a envio — é idempotente pelo ledger, então repetir não duplica.
// ============================================================================

interface EnvioMin {
  id: string; numero: string | null; marketplace: string; empresa: string | null;
  status: string; data_envio_agendada: string | null; estoque_lancado_em: string | null; arquivado_em: string | null;
}
type Resultado = { ok: boolean; movimentos?: number; erro?: string };

const MKT: Record<string, string> = { amazon: "Amazon", mercadolivre: "Mercado Livre", shopee: "Shopee" };

export function LancarEstoqueEmMassa({ envios, embalado, nomeUsuario, onConcluido }: {
  envios: EnvioMin[];
  embalado: (id: string) => number;
  nomeUsuario: string | null;
  onConcluido: () => void;
}) {
  // enviados, fora do arquivo, sem lançamento e com algo embalado
  const pendentes = useMemo(
    () => envios.filter((e) => e.status === "enviado" && !e.arquivado_em && !e.estoque_lancado_em && embalado(e.id) > 0)
      .sort((a, b) => (a.data_envio_agendada ?? "").localeCompare(b.data_envio_agendada ?? "")),
    [envios, embalado],
  );
  const [aberto, setAberto] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [rodando, setRodando] = useState(false);
  const [feito, setFeito] = useState<Map<string, Resultado>>(new Map());
  const [atual, setAtual] = useState<string | null>(null);

  function abrir() { setSel(new Set(pendentes.map((e) => e.id))); setFeito(new Map()); setAberto(true); }
  const escolhidos = pendentes.filter((e) => sel.has(e.id));
  const totalUn = escolhidos.reduce((s, e) => s + embalado(e.id), 0);

  async function lancar() {
    if (escolhidos.length === 0) return;
    if (!window.confirm(
      `Lançar no Tiny o estoque de ${escolhidos.length} envio(s) — ${formatNumber(totalUn)} unidades embaladas?\n\n` +
      "Para cada envio: entrada no depósito Full do marketplace e baixa do Geral. Grava no Tiny e não tem desfazer automático.\n\n" +
      "Se algum desses envios já foi lançado À MÃO no Tiny, desmarque antes — o app não sabe e o estoque dobraria.",
    )) return;
    setRodando(true);
    const res = new Map<string, Resultado>();
    for (const e of escolhidos) {
      setAtual(e.id);
      try {
        const { data, error } = await supabaseExternal.functions.invoke("fulfillment-estoque", {
          body: { modulo: "lancar", envio_id: e.id, confirmar: 1, lancado_por: nomeUsuario ?? "app" },
        });
        if (error) throw new Error(error.message);
        const r = data as { ok?: boolean; movimentos?: number; erros?: string[]; erro?: string };
        res.set(e.id, r?.ok ? { ok: true, movimentos: r.movimentos } : { ok: false, erro: r?.erro ?? (r?.erros ?? []).slice(0, 2).join(" | ") ?? "erro" });
      } catch (err) {
        res.set(e.id, { ok: false, erro: (err as Error).message });
      }
      setFeito(new Map(res));
    }
    setAtual(null);
    setRodando(false);
    const ok = [...res.values()].filter((r) => r.ok).length;
    const falhas = res.size - ok;
    if (falhas === 0) toast.success(`Estoque lançado em ${ok} envio(s)`, { description: `${[...res.values()].reduce((s, r) => s + (r.movimentos ?? 0), 0)} movimento(s) no Tiny` });
    else toast.warning(`${ok} lançado(s) · ${falhas} com erro`, { description: "Veja o motivo na lista. Pode clicar de novo: só lança o que faltou.", duration: 15000 });
    onConcluido();
  }

  if (pendentes.length === 0) return null;
  return (
    <>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={abrir}
        title="Lança no Tiny o estoque dos envios já enviados que ainda não foram lançados">
        <PackageCheck className="h-3.5 w-3.5" /> Lançar estoque dos enviados ({pendentes.length})
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { if (!rodando) setAberto(v); }}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Lançar estoque dos envios enviados</DialogTitle>
            <DialogDescription>
              Transferência no Tiny do que foi <b>embalado</b> em cada envio: entrada no depósito Full do marketplace e baixa do Geral.
              É seguro repetir — o app só lança o que ainda falta.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Envios antigos podem ter sido lançados <b>à mão no Tiny</b> antes deste botão existir. Desmarque esses — o app não tem como saber e o estoque dobraria.</span>
          </div>
          <div className="rounded-lg border divide-y">
            <label className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-muted-foreground bg-muted/40">
              <Checkbox checked={escolhidos.length === pendentes.length} disabled={rodando}
                onCheckedChange={(v) => setSel(new Set(v === true ? pendentes.map((e) => e.id) : []))} />
              Envio · marketplace · coleta
              <span className="ml-auto">embalado</span>
            </label>
            {pendentes.map((e) => {
              const r = feito.get(e.id);
              return (
                <label key={e.id} className={cn("flex items-center gap-2.5 px-3 py-2 text-[13px]", !sel.has(e.id) && "opacity-55")}>
                  <Checkbox checked={sel.has(e.id)} disabled={rodando}
                    onCheckedChange={(v) => setSel((s) => { const n = new Set(s); if (v === true) n.add(e.id); else n.delete(e.id); return n; })} />
                  <span className="font-mono font-semibold">{e.numero ? `#${e.numero}` : "(s/ nº)"}</span>
                  <span className="text-muted-foreground text-xs">
                    {MKT[e.marketplace] ?? e.marketplace}{e.empresa ? ` · ${e.empresa}` : " · empresa não definida"}
                    {e.data_envio_agendada ? ` · ${format(parseISO(e.data_envio_agendada), "dd/MM")}` : ""}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {atual === e.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    {r?.ok && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                    {r && !r.ok && <span title={r.erro} className="inline-flex items-center gap-1 text-[11px] text-red-600"><XCircle className="h-4 w-4" /> erro</span>}
                    <span className="font-mono tabular-nums">{formatNumber(embalado(e.id))} un</span>
                  </span>
                </label>
              );
            })}
          </div>
          {[...feito.entries()].some(([, r]) => !r.ok) && (
            <div className="text-xs text-red-700 dark:text-red-400 space-y-0.5">
              {[...feito.entries()].filter(([, r]) => !r.ok).map(([id, r]) => (
                <div key={id}><b>{pendentes.find((e) => e.id === id)?.numero ?? id}:</b> {r.erro}</div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted-foreground">{escolhidos.length} envio(s) · {formatNumber(totalUn)} un</span>
            <Button variant="outline" size="sm" disabled={rodando} onClick={() => setAberto(false)}>Fechar</Button>
            <Button size="sm" className="gap-1.5" disabled={rodando || escolhidos.length === 0} onClick={() => void lancar()}>
              {rodando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
              Lançar {escolhidos.length} envio(s) no Tiny
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
