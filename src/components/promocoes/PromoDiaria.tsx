import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Repeat, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { AMBER, GREEN, RED, chamarPromocoes } from "./comum";

// ============================================================================
// Promoção DIÁRIA (02/out/2026, decisão do dono: "uma promoção nova por dia").
// A partir de um desconto existente, grava em promo_recorrente o snapshot dos
// itens/preços + horário; a shopee-promocoes?modulo=recorrente-programar (cron
// 137, 06h23 e 18h23) cria um desconto por dia, N dias à frente, janela de
// 24 h − 1 min (não sobrepõe o dia seguinte). Idempotente (promo_recorrente_
// criadas por dia + nome na Shopee). Histórico por dia no painel.
// ============================================================================

export interface LinhaSnapshot { item_id: number; model_id: number; promo: number; limite: number }
interface Recorrente {
  id: number; shop_id: number; nome: string; hora_inicio: string; dias_antecedencia: number;
  n_itens: number; ativo: boolean; primeiro_inicio: string | null; criado_por: string | null;
}
interface Criada { recorrente_id: number; dia: string; status: string; itens_ok: number; itens_falha: number; detalhe: { falhas?: Array<{ item_id: number; motivo: string }> } | null }

const horaBR = (epoch: number) =>
  new Date(epoch * 1000).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const diaBR = (iso: string) => iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/");

/** item_list no formato do add_discount_item, a partir das linhas do desconto. */
export function montarSnapshot(linhas: LinhaSnapshot[]): unknown[] {
  const porItem = new Map<number, LinhaSnapshot[]>();
  for (const l of linhas) { if (!porItem.has(l.item_id)) porItem.set(l.item_id, []); porItem.get(l.item_id)!.push(l); }
  return [...porItem.entries()].map(([itemId, ls]) => ls[0].model_id
    ? { item_id: itemId, purchase_limit: ls[0].limite, model_list: ls.map((l) => ({ model_id: l.model_id, model_promotion_price: l.promo })) }
    : { item_id: itemId, purchase_limit: ls[0].limite, item_promotion_price: ls[0].promo });
}

// ---------------------------------------------------------------------------- botão + diálogo
export function RepetirDiario({ shopId, desconto, linhas }: {
  shopId: number;
  desconto: { discount_id: number; discount_name: string; end_time: number };
  linhas: LinhaSnapshot[];
}) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState(desconto.discount_name);
  const [hora, setHora] = useState(horaBR(desconto.end_time + 60)); // 1 min depois do fim da atual: não sobrepõe
  const [dias, setDias] = useState("3");
  const [previa, setPrevia] = useState<null | { id: number; dias: Array<{ dia: string; status: string; nome?: string }> }>(null);
  const [salvando, setSalvando] = useState(false);

  async function salvarEPrever() {
    const n = Math.min(14, Math.max(1, parseInt(dias, 10) || 3));
    if (!/^\d{2}:\d{2}$/.test(hora)) { toast.error("Horário inválido (HH:MM)"); return; }
    setSalvando(true);
    try {
      const itens = montarSnapshot(linhas);
      const { data, error } = await supabaseExternal.from("promo_recorrente").insert({
        shop_id: shopId, nome: nome.trim() || desconto.discount_name, hora_inicio: hora, dias_antecedencia: n,
        itens, n_itens: itens.length, origem_discount_id: desconto.discount_id,
        primeiro_inicio: new Date(desconto.end_time * 1000).toISOString(),
        ativo: true, criado_por: perfil?.nome ?? null,
      }).select("id").single();
      if (error) throw error;
      const id = (data as { id: number }).id;
      const r = await chamarPromocoes(`modulo=recorrente-programar&id=${id}`);
      const res = (r.resultado ?? [])[0] ?? {};
      setPrevia({ id, dias: res.dias ?? [] });
      void qc.invalidateQueries({ queryKey: ["promo-shopee", "recorrentes", shopId] });
    } catch (e) {
      toast.error("Falha ao salvar a promoção diária", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  async function confirmar() {
    if (!previa) return;
    setSalvando(true);
    try {
      const r = await chamarPromocoes(`modulo=recorrente-programar&id=${previa.id}&confirmar=1`);
      const res = (r.resultado ?? [])[0] ?? {};
      const ds = (res.dias ?? []) as Array<{ dia: string; status: string; erro?: string; itens_ok?: number; falhas?: unknown[] }>;
      const criadas = ds.filter((d) => d.status === "ok" || d.status === "parcial").length;
      const erros = ds.filter((d) => d.status === "erro");
      if (erros.length) toast.warning(`${criadas} dia(s) programado(s) · ${erros.length} com erro`, { description: erros.slice(0, 3).map((d) => `${diaBR(d.dia)}: ${d.erro}`).join("\n"), duration: 15000 });
      else toast.success(`Promoção diária ativa — ${criadas} dia(s) já programado(s) na Shopee`);
      void qc.invalidateQueries({ queryKey: ["promo-shopee"] });
      setAberto(false); setPrevia(null);
    } catch (e) {
      toast.error("Falha ao programar", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setAberto(true)}
        title="Criar automaticamente esta promoção todos os dias, com os mesmos produtos e preços">
        <Repeat className="h-3.5 w-3.5" /> Repetir todo dia
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { setAberto(v); if (!v) setPrevia(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Repetir “{desconto.discount_name}” todo dia</DialogTitle>
            <DialogDescription>
              Uma promoção nova por dia, com os mesmos {linhas.length} produto(s)/variação(ões) e preços de agora.
              Cada uma dura 24 h (até 1 min antes da do dia seguinte) e fica programada com antecedência.
            </DialogDescription>
          </DialogHeader>
          {!previa ? (
            <div className="flex flex-col gap-3 text-sm">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Nome (cada dia ganha a data no fim, ex.: “{nome} 03/10”)</span>
                <Input value={nome} onChange={(e) => setNome(e.target.value)} className="h-8" />
              </label>
              <div className="flex gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Começa todo dia às</span>
                  <Input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className="h-8 w-[120px]" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Dias programados à frente</span>
                  <Input value={dias} onChange={(e) => setDias(e.target.value)} className="h-8 w-[80px]" inputMode="numeric" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                A primeira começa quando a atual termina ({new Date(desconto.end_time * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}),
                para não sobrepor. Mudou preço? Edite aqui depois — a repetição usa os preços salvos agora.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAberto(false)}>Cancelar</Button>
                <Button size="sm" className="gap-1.5" disabled={salvando} onClick={() => void salvarEPrever()}>
                  {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Ver os dias
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <div className="rounded-md border divide-y">
                {previa.dias.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">Nenhum dia novo na janela — a promoção atual ainda cobre o período. O agendamento cria os próximos sozinho.</p>
                ) : previa.dias.map((d, i) => (
                  <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                    <span>{d.nome ?? diaBR(d.dia)}</span>
                    <span className="text-muted-foreground">{d.status === "criaria" ? "será criada" : d.status === "ja_programada" ? "já programada" : d.status}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Confirmando, as promoções são criadas na Shopee agora; depois o sistema mantém sempre {dias} dia(s) à frente (06h23 e 18h23).</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAberto(false)}>Depois</Button>
                <Button size="sm" className="gap-1.5" disabled={salvando} onClick={() => void confirmar()}>
                  {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />} Confirmar e programar
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------- painel
export function PainelPromoDiaria({ shopId }: { shopId: number }) {
  const qc = useQueryClient();
  const [rodando, setRodando] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["promo-shopee", "recorrentes", shopId],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("promo_recorrente").select("*").eq("shop_id", shopId).order("criado_em");
      if (error) throw error;
      const regras = (data ?? []) as Recorrente[];
      let criadas: Criada[] = [];
      if (regras.length) {
        const desde = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        const { data: c } = await supabaseExternal.from("promo_recorrente_criadas")
          .select("recorrente_id, dia, status, itens_ok, itens_falha, detalhe").in("recorrente_id", regras.map((r) => r.id)).gte("dia", desde).order("dia");
        criadas = (c ?? []) as Criada[];
      }
      return { regras, criadas };
    },
  });
  const regras = q.data?.regras ?? [];
  if (regras.length === 0) return null;

  async function alternar(r: Recorrente, ativo: boolean) {
    const { error } = await supabaseExternal.from("promo_recorrente").update({ ativo, atualizado_em: new Date().toISOString() }).eq("id", r.id);
    if (error) toast.error("Falha", { description: error.message });
    else toast.success(ativo ? "Promoção diária reativada" : "Promoção diária pausada — as já criadas na Shopee continuam");
    void qc.invalidateQueries({ queryKey: ["promo-shopee", "recorrentes", shopId] });
  }
  async function excluir(r: Recorrente) {
    if (!window.confirm(`Parar de repetir "${r.nome}"? As promoções já criadas na Shopee continuam valendo (encerre-as lá, se precisar).`)) return;
    const { error } = await supabaseExternal.from("promo_recorrente").delete().eq("id", r.id);
    if (error) toast.error("Falha", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["promo-shopee", "recorrentes", shopId] });
  }
  async function programarAgora(r: Recorrente) {
    setRodando(r.id);
    try {
      const res = await chamarPromocoes(`modulo=recorrente-programar&id=${r.id}&confirmar=1`);
      const ds = ((res.resultado ?? [])[0]?.dias ?? []) as Array<{ status: string }>;
      const novas = ds.filter((d) => d.status === "ok" || d.status === "parcial").length;
      toast.success(novas ? `${novas} dia(s) novo(s) programado(s)` : "Tudo já programado");
      void qc.invalidateQueries({ queryKey: ["promo-shopee"] });
    } catch (e) { toast.error("Falha ao programar", { description: (e as Error).message }); }
    finally { setRodando(null); }
  }

  return (
    <div className="rounded-lg border p-3 flex flex-col gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Repeat className="h-3.5 w-3.5" /> Promoções diárias
      </span>
      {regras.map((r) => {
        const dias = (q.data?.criadas ?? []).filter((c) => c.recorrente_id === r.id);
        return (
          <div key={r.id} className={cn("flex flex-wrap items-center gap-3 text-[13px]", !r.ativo && "opacity-60")}>
            <Switch checked={r.ativo} onCheckedChange={(v) => void alternar(r, v)} />
            <span className="font-medium">{r.nome}</span>
            <span className="text-xs text-muted-foreground">todo dia às {r.hora_inicio.slice(0, 5)} · {r.n_itens} anúncio(s) · {r.dias_antecedencia} dia(s) à frente</span>
            <div className="flex items-center gap-1">
              {dias.map((d) => (
                <span key={d.dia} className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded"
                  title={d.detalhe?.falhas?.length ? d.detalhe.falhas.slice(0, 5).map((f) => `${f.item_id}: ${f.motivo}`).join("\n") : undefined}
                  style={{ background: `${d.status === "ok" ? GREEN : d.status === "parcial" ? AMBER : RED}18`, color: d.status === "ok" ? GREEN : d.status === "parcial" ? AMBER : RED }}>
                  {diaBR(d.dia)}{d.itens_falha ? ` · ${d.itens_falha} recusa(s)` : ""}
                </span>
              ))}
            </div>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={rodando === r.id || !r.ativo} onClick={() => void programarAgora(r)}>
              {rodando === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CalendarClock className="h-3 w-3" />} Programar agora
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void excluir(r)} title="Parar de repetir">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
