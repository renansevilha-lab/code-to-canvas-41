// ============================================================================
// Devoluções ABERTAS na Shopee — espelho de shopee_devolucoes (Returns API).
//
// Mostra o que o Seller Center mostra: motivo (+ texto do comprador), fotos,
// itens, valor e o PRAZO do vendedor (due_date — depois dele a Shopee finaliza
// sozinha a favor do comprador). E deixa RESPONDER pelo app:
//   · Aceitar reembolso  = v2.returns.confirm  ("finalizar sem disputa")
//   · Negar / Disputar   = v2.returns.dispute  (vai a julgamento)
// Regras REAIS da Shopee (descobertas ao vivo, 27/ago):
//   - Os motivos de disputa são POR SOLICITAÇÃO (get_return_dispute_reason).
//     Caso "não recebi o pedido" volta VAZIO = não há contestação via API (a
//     Shopee decide pelo rastreio) — o diálogo explica e aponta o Seller Center.
//   - Motivos com produto (53/55...) EXIGEM evidência anexada: as fotos sobem
//     via convert_image e vão no image_list do dispute.
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

async function chamarResponder(qs: string, body?: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${EXTERNAL_URL}/functions/v1/shopee-devolucao-probe?${qs}`,
    {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const d = (await resp.json().catch(() => ({}))) as { ok?: boolean; erro?: string; resposta?: { message?: string }; message?: string };
  if (!resp.ok || d.ok === false) {
    throw new Error(d.erro ?? d.resposta?.message ?? d.message ?? `HTTP ${resp.status}`);
  }
  return d as Record<string, unknown>;
}

interface MotivoDisputa {
  dispute_reason: number;
  dispute_requirement: string | null;
  evidence_module_list?: { module_index: number; requirement: string; is_required: boolean }[];
}

function arquivoParaBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]+,/, ""));
    r.onerror = () => reject(new Error("falha ao ler o arquivo"));
    r.readAsDataURL(file);
  });
}

export function DevolucoesShopeeAbertas() {
  const qc = useQueryClient();
  const [agindo, setAgindo] = useState<string | null>(null);
  const [disputa, setDisputa] = useState<DevAberta | null>(null);
  const [dispTexto, setDispTexto] = useState("");
  const [dispEmail, setDispEmail] = useState<string>(() => {
    try { return localStorage.getItem("devol_disputa_email") ?? ""; } catch { return ""; }
  });
  const [dispMotivo, setDispMotivo] = useState<string>("");
  const [dispFotos, setDispFotos] = useState<File[]>([]);

  // Motivos de disputa REAIS da solicitação aberta no diálogo (variam por caso;
  // vazio = a Shopee não aceita contestação via API para ela).
  const motivosQ = useQuery({
    queryKey: ["devolucoes", "motivos_disputa", disputa?.return_sn ?? ""],
    enabled: disputa !== null,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<MotivoDisputa[]> => {
      const d = await chamarResponder(`modulo=motivos-disputa&return_sn=${encodeURIComponent(disputa!.return_sn)}`);
      return (d.motivos ?? []) as MotivoDisputa[];
    },
  });
  const motivos = motivosQ.data ?? [];
  const motivoSel = motivos.find((m) => String(m.dispute_reason) === dispMotivo) ?? motivos[0];
  const evidenciaObrigatoria = (motivoSel?.evidence_module_list ?? []).some((m) => m.is_required);

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
    if (!disputa || !motivoSel) return;
    const texto = dispTexto.trim();
    const email = dispEmail.trim();
    if (texto.length < 10) { toast.warning("Escreva a justificativa (mín. 10 caracteres)."); return; }
    if (!email.includes("@")) { toast.warning("Informe um e-mail de contato válido."); return; }
    if (evidenciaObrigatoria && dispFotos.length === 0) {
      toast.warning("Este motivo EXIGE evidência — anexe ao menos 1 foto.");
      return;
    }
    setAgindo(disputa.return_sn);
    try {
      try { localStorage.setItem("devol_disputa_email", email); } catch { /* noop */ }
      // 1) sobe as fotos (convert_image) e vira URLs de evidência da Shopee
      const urls: string[] = [];
      for (const f of dispFotos) {
        const b64 = await arquivoParaBase64(f);
        const r = await chamarResponder(`modulo=converter-imagem`, {
          return_sn: disputa.return_sn, imagem_base64: b64, mime: f.type || "image/jpeg",
        });
        if (r.url) urls.push(String(r.url));
      }
      // 2) abre a disputa com o motivo real + evidências por módulo exigido
      const imageList = (motivoSel.evidence_module_list ?? [])
        .map((m) => ({ module_index: m.module_index, requirement: m.requirement, image_url: urls }))
        .filter((m) => m.image_url.length > 0);
      await chamarResponder(
        `modulo=responder-disputar&return_sn=${encodeURIComponent(disputa.return_sn)}&confirmar=1`,
        {
          motivo: motivoSel.dispute_reason, email, texto,
          image_list: imageList,
        },
      );
      toast.success(`Disputa aberta — ${disputa.return_sn}`, { description: "A Shopee vai julgar. Acompanhe por aqui e pelo Seller Center." });
      setDisputa(null); setDispTexto(""); setDispFotos([]);
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
            const podeResponder = ["REQUESTED", "PROCESSING", "ACCEPTED"].includes(d.status ?? "")
              && prazo && prazo.txt !== "prazo venceu";
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
                        onClick={() => { setDisputa(d); setDispTexto(""); setDispFotos([]); setDispMotivo(""); }}>
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <AlertTriangle className="h-3 w-3" />}
                        Negar / Disputar…
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs text-muted-foreground"
                        disabled={busy || agindo !== null}
                        onClick={() => void reembolsar(d)}>
                        <Undo2 className="h-3 w-3" /> Aceitar reembolso
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

      {/* Diálogo de disputa — motivos REAIS da Shopee para a solicitação */}
      <Dialog open={disputa !== null} onOpenChange={(o) => { if (!o) setDisputa(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Negar / Disputar {disputa?.return_sn}</DialogTitle>
            <DialogDescription>
              A solicitação vai para julgamento da Shopee. Ação irreversível — em jogo o
              reembolso de R$ {Number(disputa?.refund_amount ?? 0).toFixed(2)}.
            </DialogDescription>
          </DialogHeader>

          {motivosQ.isLoading ? (
            <p className="text-sm text-muted-foreground py-3 text-center">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1.5" />
              Perguntando à Shopee quais contestações valem para este caso…
            </p>
          ) : motivos.length === 0 ? (
            <div className="rounded-md border p-3 text-[13px] space-y-1.5" style={{ borderColor: "#B7791F55", background: "#B7791F0F" }}>
              <p className="font-medium" style={{ color: "#B7791F" }}>
                A Shopee não aceita contestação via API para esta solicitação.
              </p>
              <p className="text-muted-foreground">
                É o padrão dos casos <b>"não recebi o pedido"</b>: a própria Shopee decide
                pelo rastreio da entrega. Se você tem comprovante de entrega, conteste pelo
                <b> Seller Center</b> (Pedidos › Devolução/Reembolso). Se a entrega falhou
                mesmo, use "Aceitar reembolso".
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="space-y-1">
                <label className="text-[11.5px] text-muted-foreground">Motivo da contestação (opções da Shopee para este caso)</label>
                <select
                  className="w-full h-9 rounded-md border bg-card px-2 text-sm"
                  value={String(motivoSel?.dispute_reason ?? "")}
                  onChange={(e) => setDispMotivo(e.target.value)}
                >
                  {motivos.map((m) => (
                    <option key={m.dispute_reason} value={String(m.dispute_reason)}>
                      {(m.dispute_requirement ?? `Motivo ${m.dispute_reason}`).split("\n")[0].slice(0, 90)}
                    </option>
                  ))}
                </select>
                {motivoSel?.dispute_requirement && (
                  <p className="text-[11px] text-muted-foreground whitespace-pre-line">{motivoSel.dispute_requirement.trim()}</p>
                )}
              </div>
              {(motivoSel?.evidence_module_list ?? []).map((m) => (
                <div key={m.module_index} className="space-y-1">
                  <label className="text-[11.5px] font-medium" style={{ color: m.is_required ? "#C9432F" : undefined }}>
                    Evidência{m.is_required ? " (obrigatória)" : ""}: <span className="font-normal text-muted-foreground">{m.requirement}</span>
                  </label>
                  <Input type="file" accept="image/jpeg,image/png,image/jpg" multiple className="h-9 text-xs"
                    onChange={(e) => setDispFotos(Array.from(e.target.files ?? []))} />
                  {dispFotos.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">{dispFotos.length} foto(s) selecionada(s) — sobem como evidência oficial</p>
                  )}
                </div>
              ))}
              <Textarea rows={4} placeholder="Justificativa que a Shopee vai ler…"
                value={dispTexto} onChange={(e) => setDispTexto(e.target.value)} />
              <Input type="email" placeholder="E-mail de contato (a Shopee responde nele)"
                value={dispEmail} onChange={(e) => setDispEmail(e.target.value)} />
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisputa(null)}>Cancelar</Button>
            <Button variant="destructive"
              disabled={agindo !== null || motivosQ.isLoading || motivos.length === 0}
              onClick={() => void enviarDisputa()}>
              {agindo ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Abrir disputa
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
