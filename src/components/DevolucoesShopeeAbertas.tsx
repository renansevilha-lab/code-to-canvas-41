// ============================================================================
// Devoluções ABERTAS na Shopee — espelho de shopee_devolucoes (Returns API).
//
// Mostra o que o Seller Center mostra: motivo (+ texto do comprador), fotos,
// itens, valor e o PRAZO do vendedor (due_date — depois dele a Shopee finaliza
// sozinha a favor do comprador). E deixa RESPONDER pelo app:
//   · Reembolsar  = v2.returns.confirm  ("finalizar sem disputa")
//   · Disputar    = v2.returns.dispute  (vai a julgamento; exige justificativa)
// As duas ações são IRREVERSÍVEIS e mexem com dinheiro — cada uma passa por
// diálogo próprio, por solicitação, e o backend só age com &confirmar=1.
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { AlertTriangle, ExternalLink, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";

interface DevAberta {
  return_sn: string;
  order_sn: string | null;
  shop_id: number | null;
  reason: string | null;
  text_reason: string | null;
  status: string | null;
  refund_amount: number | null;
  images: string[] | null;
  needs_logistics: boolean | null;
  tracking_number: string | null;
  due_date: string | null;
  itens: { sku: string | null; nome: string | null; qtd: number | null }[] | null;
  create_time: string | null;
  // cruzamento com o recebimento fisico no estoque (bipagem) — por order_sn
  recebida_id: string | null;
  recebida_status: string | null;
  conferido_ok: boolean | null;
  recebido_em: string | null;
  recebido_por: string | null;
  recebida_obs: string | null;
  itens_problema: { sku: string | null; estado: string | null; obs: string | null; qtd_esperada: number | null; qtd_recebida: number | null }[] | null;
}

const MOTIVO_PT: Record<string, string> = {
  ITEM_MISSING: "Item faltando",
  FUNCTIONAL_DMG: "Defeito funcional",
  PHYSICAL_DMG: "Dano físico",
  ITEM_WRONGDAMAGED: "Item errado/danificado",
  WRONG_ITEM: "Item errado",
  NOT_RECEIPT: "Não recebeu",
  DIFF: "Diferente do anunciado",
  CHANGE_MIND: "Desistiu da compra",
  ITEM_FAKE: "Alega falsificado",
  USED: "Alega usado",
  EXPIRED_PRODUCT: "Produto vencido",
  OTHER: "Outro",
};

const STATUS_PT: Record<string, { rotulo: string; cor: string }> = {
  REQUESTED: { rotulo: "Aguardando Shopee", cor: "#2F6FB0" },
  PROCESSING: { rotulo: "Em processamento", cor: "#B7791F" },
  ACCEPTED: { rotulo: "Pendente sua validação", cor: "#C9432F" },
  JUDGING: { rotulo: "Em disputa (julgamento)", cor: "#7A5CC7" },
};

function lojaDe(shopId: number | null): string {
  if (shopId === 522186766) return "Ottz Pet";
  if (shopId === 759046323) return "Bumi Pet";
  return String(shopId ?? "?");
}

/** "vence em 3h" / "vence em 2d" / "venceu" — do due_date da Shopee. */
function prazoTexto(iso: string | null): { txt: string; urgente: boolean } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { txt: "prazo venceu", urgente: true };
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return { txt: `vence em ${Math.max(1, Math.floor(ms / 60_000))}min`, urgente: true };
  if (h < 24) return { txt: `vence em ${h}h`, urgente: true };
  return { txt: `vence em ${Math.floor(h / 24)}d`, urgente: false };
}

async function chamarResponder(qs: string): Promise<{ ok?: boolean; erro?: string; resposta?: unknown }> {
  const resp = await fetch(
    `${EXTERNAL_URL}/functions/v1/shopee-devolucao-probe?${qs}`,
    { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
  );
  const d = (await resp.json().catch(() => ({}))) as { ok?: boolean; erro?: string; resposta?: { message?: string } };
  if (!resp.ok || d.ok === false) {
    throw new Error(d.erro ?? d.resposta?.message ?? `HTTP ${resp.status}`);
  }
  return d;
}

export function DevolucoesShopeeAbertas() {
  const qc = useQueryClient();
  const [agindo, setAgindo] = useState<string | null>(null);
  const [disputa, setDisputa] = useState<DevAberta | null>(null);
  const [dispTexto, setDispTexto] = useState("");
  const [dispEmail, setDispEmail] = useState<string>(() => {
    try { return localStorage.getItem("devol_disputa_email") ?? ""; } catch { return ""; }
  });
  const [dispMotivo, setDispMotivo] = useState("2");

  const abertasQ = useQuery({
    queryKey: ["devolucoes", "shopee_abertas"],
    refetchInterval: 120_000,
    queryFn: async (): Promise<DevAberta[]> => {
      // abertas = em andamento OU aprovadas ainda dentro do prazo do vendedor
      const { data, error } = await supabaseExternal
        .from("view_devolucoes_shopee_abertas")
        .select("*")
        .or(`status.in.(REQUESTED,PROCESSING,JUDGING),and(status.eq.ACCEPTED,due_date.gt.${new Date().toISOString()})`)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as DevAberta[];
    },
  });

  const lista = abertasQ.data ?? [];
  const pendentes = useMemo(() => lista.filter((d) => d.status === "ACCEPTED").length, [lista]);

  async function reembolsar(d: DevAberta) {
    const valor = d.refund_amount != null ? `R$ ${Number(d.refund_amount).toFixed(2)}` : "o valor da solicitação";
    if (!window.confirm(
      `Finalizar SEM disputa e reembolsar o comprador?\n\n` +
      `Solicitação ${d.return_sn} · pedido ${d.order_sn}\n` +
      `Reembolso de ${valor}. AÇÃO IRREVERSÍVEL.`,
    )) return;
    setAgindo(d.return_sn);
    try {
      await chamarResponder(`modulo=responder-reembolsar&return_sn=${encodeURIComponent(d.return_sn)}&confirmar=1`);
      toast.success(`Reembolso confirmado — ${d.return_sn}`);
      void qc.invalidateQueries({ queryKey: ["devolucoes", "shopee_abertas"] });
    } catch (e) {
      toast.error("Falha ao reembolsar", { description: (e as Error).message });
    } finally {
      setAgindo(null);
    }
  }

  async function enviarDisputa() {
    if (!disputa) return;
    const texto = dispTexto.trim();
    const email = dispEmail.trim();
    if (texto.length < 10) { toast.warning("Escreva a justificativa (mín. 10 caracteres)."); return; }
    if (!email.includes("@")) { toast.warning("Informe um e-mail de contato válido."); return; }
    setAgindo(disputa.return_sn);
    try {
      try { localStorage.setItem("devol_disputa_email", email); } catch { /* noop */ }
      await chamarResponder(
        `modulo=responder-disputar&return_sn=${encodeURIComponent(disputa.return_sn)}` +
        `&motivo=${encodeURIComponent(dispMotivo)}&email=${encodeURIComponent(email)}` +
        `&texto=${encodeURIComponent(texto)}&confirmar=1`,
      );
      toast.success(`Disputa aberta — ${disputa.return_sn}`, { description: "A Shopee vai julgar. Acompanhe pelo Seller Center." });
      setDisputa(null); setDispTexto("");
      void qc.invalidateQueries({ queryKey: ["devolucoes", "shopee_abertas"] });
    } catch (e) {
      toast.error("Falha ao abrir disputa", { description: (e as Error).message });
    } finally {
      setAgindo(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12.5px] text-muted-foreground">
          {lista.length} solicitação(ões) aberta(s) na Shopee
          {pendentes > 0 && <> · <span className="font-semibold text-destructive">{pendentes} aguardando sua validação</span></>}
          {" "}— dados do espelho (sync a cada 30 min)
        </p>
        <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={abertasQ.isFetching}
          onClick={() => void abertasQ.refetch()}>
          {abertasQ.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Atualizar
        </Button>
      </div>

      {abertasQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : lista.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">Nenhuma solicitação aberta. 🎉</Card>
      ) : (
        <div className="flex flex-col gap-2.5">
          {lista.map((d) => {
            const st = STATUS_PT[d.status ?? ""] ?? { rotulo: d.status ?? "?", cor: "#5C6470" };
            const prazo = prazoTexto(d.due_date);
            const podeResponder = d.status === "ACCEPTED" && prazo && prazo.txt !== "prazo venceu";
            const busy = agindo === d.return_sn;
            return (
              <Card key={d.return_sn} className="p-3.5">
                <div className="flex flex-wrap items-start gap-3">
                  {(d.images ?? []).slice(0, 2).map((img, i) => (
                    <a key={i} href={img} target="_blank" rel="noreferrer" title="Foto enviada pelo comprador">
                      <img src={img} alt="foto do comprador" className="w-[64px] h-[64px] rounded-lg object-cover border" loading="lazy" />
                    </a>
                  ))}
                  <div className="flex-1 min-w-[220px] space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12.5px] font-semibold">{d.return_sn}</span>
                      <span className="text-[11px] text-muted-foreground font-mono">pedido {d.order_sn ?? "—"}</span>
                      <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{lojaDe(d.shop_id)}</span>
                      <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full" style={{ background: `${st.cor}1F`, color: st.cor }}>{st.rotulo}</span>
                      {prazo && (
                        <span className={`text-[11px] font-semibold ${prazo.urgente ? "text-destructive" : "text-muted-foreground"}`}>
                          ⏳ {prazo.txt}{d.due_date ? ` (${format(parseISO(d.due_date), "dd/MM HH:mm")})` : ""}
                        </span>
                      )}
                    </div>
                    <div className="text-[12.5px]">
                      <span className="font-semibold" style={{ color: "#B7791F" }}>{MOTIVO_PT[d.reason ?? ""] ?? d.reason ?? "—"}</span>
                      {d.text_reason && <span className="text-muted-foreground"> — “{d.text_reason}”</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-muted-foreground">
                      {(d.itens ?? []).map((it, i) => (
                        <span key={i} className="font-mono">{it.sku ?? "?"} ×{it.qtd ?? 1}</span>
                      ))}
                      {d.refund_amount != null && <span className="font-semibold text-foreground">R$ {Number(d.refund_amount).toFixed(2)}</span>}
                      {d.needs_logistics && <span title="O comprador devolve o produto">📦 devolve o produto{d.tracking_number ? ` · ${d.tracking_number}` : ""}</span>}
                    </div>
                    {/* Cruzamento com o ESTOQUE (bipagem): é o dado que orienta a
                        resposta — voltou com ressalva = base para disputar;
                        voltou "tudo certo" = reembolsa tranquilo. */}
                    {(() => {
                      if (!d.recebida_id) {
                        if (!d.needs_logistics) return null;
                        return (
                          <div className="text-[11.5px] text-muted-foreground">
                            📭 Ainda <span className="font-semibold">não recebida</span> no estoque
                          </div>
                        );
                      }
                      const quando = d.recebido_em ? format(parseISO(d.recebido_em), "dd/MM HH:mm") : "";
                      const quem = (d.recebido_por ?? "").split("@")[0];
                      if (d.recebida_status === "recebida") {
                        return (
                          <div className="text-[11.5px] font-medium" style={{ color: "#B7791F" }}>
                            📦 Recebida no estoque {quando} — <span className="font-semibold">a conferir</span>
                          </div>
                        );
                      }
                      if (d.conferido_ok) {
                        return (
                          <div className="text-[11.5px] font-medium" style={{ color: "#0E8A5F" }}>
                            📦 Recebida e conferida {quando}{quem ? ` por ${quem}` : ""} — tudo certo ✓
                          </div>
                        );
                      }
                      return (
                        <div className="flex flex-col gap-0.5">
                          <div className="text-[11.5px] font-semibold" style={{ color: "#C9432F" }}>
                            📦 Recebida {quando}{quem ? ` por ${quem}` : ""} — COM RESSALVA (base para disputa):
                          </div>
                          {(d.itens_problema ?? []).map((it, i) => (
                            <span key={i} className="text-[11px] leading-tight" style={{ color: "#B7791F" }}>
                              <span className="font-mono font-semibold">{it.sku ?? "?"}</span>
                              {it.estado && it.estado !== "ok" && <> · {it.estado}</>}
                              {it.qtd_recebida != null && it.qtd_esperada != null && it.qtd_recebida !== it.qtd_esperada && (
                                <> · recebido {it.qtd_recebida}/{it.qtd_esperada}</>
                              )}
                              {it.obs && <span className="text-muted-foreground"> — {it.obs}</span>}
                            </span>
                          ))}
                          {d.recebida_obs && <span className="text-[11px] text-muted-foreground">{d.recebida_obs}</span>}
                        </div>
                      );
                    })()}
                  </div>
                  {podeResponder && (
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs"
                        disabled={busy || agindo !== null}
                        onClick={() => { setDisputa(d); setDispTexto(""); }}>
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertTriangle className="h-3 w-3" />}
                        Disputar…
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground"
                        disabled={busy || agindo !== null}
                        onClick={() => void reembolsar(d)}>
                        <Undo2 className="h-3 w-3" /> Reembolsar
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
        <ExternalLink className="h-3 w-3" />
        Casos com evidência (foto/vídeo do seu lado) são melhor conduzidos pelo Seller Center — a API não anexa arquivos.
      </p>

      {/* Diálogo de disputa — justificativa obrigatória */}
      <Dialog open={disputa !== null} onOpenChange={(o) => { if (!o) setDisputa(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disputar {disputa?.return_sn}</DialogTitle>
            <DialogDescription>
              A solicitação vai para julgamento da Shopee. Ação irreversível — explique
              por que o reembolso de R$ {Number(disputa?.refund_amount ?? 0).toFixed(2)} não é devido.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2.5">
            <select
              className="w-full h-9 rounded-md border bg-card px-2 text-sm"
              value={dispMotivo}
              onChange={(e) => setDispMotivo(e.target.value)}
            >
              <option value="1">Não recebi o produto de volta</option>
              <option value="2">Produto voltou danificado / diferente do enviado</option>
              <option value="3">Outro motivo</option>
            </select>
            <Textarea rows={4} placeholder="Justificativa que a Shopee vai ler…"
              value={dispTexto} onChange={(e) => setDispTexto(e.target.value)} />
            <Input type="email" placeholder="E-mail de contato (a Shopee responde nele)"
              value={dispEmail} onChange={(e) => setDispEmail(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisputa(null)}>Cancelar</Button>
            <Button variant="destructive" disabled={agindo !== null} onClick={() => void enviarDisputa()}>
              {agindo ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Abrir disputa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
