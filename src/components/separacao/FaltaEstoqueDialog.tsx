import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, PackageX, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EXTERNAL_PUBLISHABLE_KEY, EXTERNAL_URL, supabaseExternal } from "@/integrations/supabase/external-client";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";
import { cn } from "@/lib/utils";

// ============================================================================
// Reportar falta de estoque — diálogo de confirmação (decisão do dono, 17/set):
//   • produto SIMPLES: confirma e (por padrão) zera o depósito Geral no Tiny;
//   • KIT: o operador ESCOLHE qual componente está em falta — o estoque desse
//     componente é zerado, nunca o kit (o kit não tem estoque próprio);
//   • em ambos os casos há confirmação explícita com os números do Tiny.
// Backend: separacao-falta v6 (preview=1 lê o saldo ao vivo; zerar=1 aplica
// marcador + balanço 0 + aviso no Discord #estoque-pedido-sem-estoque e agenda
// a conferência do anúncio na Shopee via estoque-conferir).
// ============================================================================

export type AlvoFalta = {
  /** filtro da separacao-falta: `separacao_id=…`, `tag=…`, `grupo=…` ou `sku=…&envio=…` */
  filtro: string;
  rotulo: string;
  sku: string | null;
  via: "menu_pedido" | "menu_lote" | "menu_linha";
  log?: { tag?: string | null; order_sn?: string | null; separacao_id?: number | null; grupo?: string | null };
};

interface Geral { saldo: number; reservado: number; disponivel: number; deposito_id: number }
interface Candidato {
  sku: string; nome: string | null; id_tiny: number | null; custo: number | null;
  quantidade: number | null; geral: Geral | null; erro?: string;
}
interface Preview {
  preview: true; ref: string; pedidos: number; unidades: number;
  sku: string | null; tipo: string | null; nome: string | null; candidatos: Candidato[]; aviso?: string; erro?: string;
}
export interface ResultadoFalta {
  ok?: boolean; erro?: string; aplicados?: number; pedidos_no_lote?: number; falhas?: string[]; discord?: boolean;
  precisa_escolher?: boolean;
  estoque?: { sku: string; zerado: boolean; ja_zerado?: boolean; saldo_anterior?: number | null; reservado?: number | null; erro?: string } | null;
}

const LS_ZERAR = "separacao.falta.zerarTiny";

async function chamarFalta(qs: string): Promise<{ resp: Response; d: ResultadoFalta & Partial<Preview> }> {
  const resp = await fetch(`${EXTERNAL_URL}/functions/v1/separacao-falta?${qs}`, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const d = (await resp.json().catch(() => ({}))) as ResultadoFalta & Partial<Preview>;
  return { resp, d };
}

/** Texto curto do que aconteceu com o estoque, para o toast. */
export function descreverEstoque(e: ResultadoFalta["estoque"]): string {
  if (!e) return "";
  if (e.erro) return ` · Tiny NÃO zerado: ${e.erro}`;
  if (e.ja_zerado) return " · Tiny já estava 0";
  return ` · Tiny Geral ${e.saldo_anterior ?? "?"} → 0`;
}

/** "Estoque voltou": balanço com o saldo anterior guardado. Confirmação simples. */
export async function desfazerZeramento(sku: string, por: string | null): Promise<boolean> {
  if (!window.confirm(
    `O estoque de ${sku} voltou?\n\nLança no Tiny um balanço com o saldo que havia antes de zerar (depósito Geral) e avisa no Discord.`,
  )) return false;
  try {
    const { resp, d } = await chamarFalta(`desfazer=1&sku=${encodeURIComponent(sku)}&por=${encodeURIComponent(por ?? "")}`);
    const r = d as unknown as { ok?: boolean; erro?: string; saldo_restaurado?: number | null; lancado?: boolean };
    if (!resp.ok || !r.ok) throw new Error(r.erro ?? `HTTP ${resp.status}`);
    toast.success(`Estoque voltou — ${sku}`, {
      description: r.lancado ? `Balanço ${r.saldo_restaurado} lançado no depósito Geral.` : "Sem lançamento (já estava 0 quando foi reportado).",
    });
    return true;
  } catch (e) {
    toast.error("Erro ao desfazer", { description: (e as Error).message });
    return false;
  }
}

export interface ConferenciaRow {
  id: number; sku: string; sku_reportado: string | null; saldo_anterior: number | null; ja_zerado: boolean;
  zerado_em: string; zerado_por: string | null; conferir_em: string | null; tentativas: number;
  conferido_em: string | null; shopee_zerada: boolean | null; desfeito_em: string | null;
  resultado: { total_vivo?: number; ativos?: number } | null;
}

/** Último zeramento por SKU (3 dias) — alimenta o selo "Shopee zerada / ainda com estoque". */
export function useConferenciaFalta() {
  return useQuery({
    queryKey: ["separacao", "falta_estoque_conferencia"],
    queryFn: async () => {
      const desde = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const { data, error } = await supabaseExternal
        .from("falta_estoque_conferencia")
        .select("id, sku, sku_reportado, saldo_anterior, ja_zerado, zerado_em, zerado_por, conferir_em, tentativas, conferido_em, shopee_zerada, desfeito_em, resultado")
        .gte("zerado_em", desde)
        .order("zerado_em", { ascending: false })
        .limit(500);
      if (error) throw error;
      const map = new Map<string, ConferenciaRow>();
      for (const r of (data ?? []) as ConferenciaRow[]) {
        // indexa pelo SKU zerado E pelo reportado (kit) — a linha da fila mostra o kit
        if (!map.has(r.sku)) map.set(r.sku, r);
        if (r.sku_reportado && !map.has(r.sku_reportado)) map.set(r.sku_reportado, r);
      }
      return map;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function ConferenciaBadge({ c }: { c: ConferenciaRow | undefined }) {
  if (!c || c.desfeito_em) return null;
  const quem = c.zerado_por ? ` por ${c.zerado_por}` : "";
  const tiny = c.ja_zerado ? "Tiny já estava 0" : `Tiny Geral ${c.saldo_anterior ?? "?"} → 0`;
  if (!c.conferido_em) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-sans font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        title={`${tiny}${quem} · conferindo o anúncio na Shopee (tentativa ${c.tentativas + 1})`}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> conferindo Shopee
      </span>
    );
  }
  if (c.shopee_zerada) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-sans font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        title={`${tiny}${quem} · anúncio na Shopee com 0 (${c.resultado?.ativos ?? "?"} ativo(s))`}
      >
        Shopee zerada
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] font-sans font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
      title={`${tiny}${quem} · a Shopee AINDA mostra ${c.resultado?.total_vivo ?? "?"} un depois de ${c.tentativas} conferência(s)`}
    >
      <AlertTriangle className="h-3 w-3" /> Shopee ainda com {c.resultado?.total_vivo ?? "?"}
    </span>
  );
}

function fmtGeral(g: Geral | null, erro?: string): string {
  if (!g) return erro ? `sem leitura (${erro})` : "sem leitura";
  return `Geral: ${g.saldo}${g.reservado ? ` (${g.reservado} reservados · ${g.disponivel} disp.)` : ""}`;
}

export function FaltaEstoqueDialog({ alvo, onClose, onFeito, por }: {
  alvo: AlvoFalta | null;
  onClose: () => void;
  onFeito?: (d: ResultadoFalta) => void;
  por: string | null;
}) {
  const aberto = alvo != null;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erroPreview, setErroPreview] = useState<string | null>(null);
  const [zerar, setZerar] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_ZERAR) !== "0"; } catch { return true; }
  });
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!alvo) { setPreview(null); setErroPreview(null); setEscolhido(null); return; }
    let vivo = true;
    setCarregando(true); setPreview(null); setErroPreview(null); setEscolhido(null);
    void chamarFalta(`${alvo.filtro}&preview=1`).then(({ resp, d }) => {
      if (!vivo) return;
      if (!resp.ok || !(d as Preview).preview) { setErroPreview(d.erro ?? `HTTP ${resp.status}`); return; }
      const p = d as Preview;
      setPreview(p);
      // produto simples com 1 candidato: já vem escolhido
      if (p.tipo !== "K" && p.candidatos.length === 1) setEscolhido(p.candidatos[0].sku);
    }).catch((e) => { if (vivo) setErroPreview((e as Error).message); })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [alvo]);

  function alternarZerar(v: boolean) {
    setZerar(v);
    try { localStorage.setItem(LS_ZERAR, v ? "1" : "0"); } catch { /* ignore */ }
  }

  const ehKit = preview?.tipo === "K";
  const candidatoEscolhido = preview?.candidatos.find((c) => c.sku === escolhido) ?? null;
  const podeZerar = !!preview && !!preview.sku && preview.candidatos.length > 0;
  const zerarEfetivo = zerar && podeZerar;
  const faltaEscolha = zerarEfetivo && ehKit && !escolhido;
  const podeConfirmar = !!alvo && !carregando && !enviando && !erroPreview && !!preview && !faltaEscolha;

  async function confirmar() {
    if (!alvo || !preview) return;
    setEnviando(true);
    try {
      let qs = `${alvo.filtro}&por=${encodeURIComponent(por ?? "")}`;
      if (zerarEfetivo) {
        qs += "&zerar=1";
        // kit: componente escolhido; simples: o próprio SKU (o servidor resolve)
        if (ehKit && escolhido) qs += `&sku_zerar=${encodeURIComponent(escolhido)}`;
      }
      const { resp, d } = await chamarFalta(qs);
      if (!resp.ok || !d.ok) throw new Error(d.erro ?? d.falhas?.[0] ?? `HTTP ${resp.status}`);
      const parcial = (d.aplicados ?? 0) < (d.pedidos_no_lote ?? 0);
      const erroEstoque = !!d.estoque?.erro;
      const msg = `${d.aplicados}/${d.pedidos_no_lote} pedido(s) marcados no Tiny` +
        (parcial ? " — rode de novo para o restante" : "") +
        descreverEstoque(d.estoque) +
        (d.discord ? " · aviso no Discord" : " (Discord indisponível agora)");
      if (erroEstoque) toast.warning(`Falta reportada — ${preview.sku ?? alvo.rotulo}`, { description: msg, duration: 12000 });
      else toast.success(`Falta reportada — ${preview.sku ?? alvo.rotulo}`, { description: msg, duration: parcial ? 10000 : 6000 });
      void registrarSeparacaoLog({
        evento: "falta_estoque", usuario: por,
        tag: alvo.log?.tag ?? null, order_sn: alvo.log?.order_sn ?? null,
        separacao_id: alvo.log?.separacao_id ?? null, sku: alvo.sku ?? preview.sku ?? null,
        detalhe: {
          via: alvo.via, grupo: alvo.log?.grupo ?? undefined,
          aplicados: d.aplicados, no_lote: d.pedidos_no_lote,
          zerar: zerarEfetivo, sku_zerar: zerarEfetivo ? (ehKit ? escolhido : preview.sku) : null,
          saldo_anterior: d.estoque?.saldo_anterior ?? null, estoque_erro: d.estoque?.erro ?? null,
        },
      });
      onFeito?.(d);
      onClose();
    } catch (e) {
      toast.error(`Erro ao reportar falta — ${alvo.rotulo}`, { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o && !enviando) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageX className="h-4 w-4 text-amber-600" /> Reportar falta de estoque
          </DialogTitle>
          <DialogDescription>{alvo?.rotulo}</DialogDescription>
        </DialogHeader>

        {carregando && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Lendo o estoque no Tiny…
          </div>
        )}
        {erroPreview && (
          <div className="text-sm text-destructive py-2">Não foi possível preparar o reporte: {erroPreview}</div>
        )}

        {preview && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border p-3 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-semibold">{preview.sku ?? "sem SKU único"}</span>
                <span className="text-xs text-muted-foreground">
                  {preview.pedidos} pedido(s) · {preview.unidades} un{ehKit ? " · KIT" : ""}
                </span>
              </div>
              <div className="text-muted-foreground line-clamp-2">{preview.nome ?? "—"}</div>
              {preview.aviso && <div className="text-xs text-amber-700">{preview.aviso}</div>}
            </div>

            <p className="text-muted-foreground">
              Aplica o marcador <b>FALTA ESTOQUE</b> nos pedidos no Tiny e avisa no Discord (#estoque-pedido-sem-estoque).
            </p>

            <label className={cn("flex items-start gap-2 rounded-md border p-3", !podeZerar && "opacity-60")}>
              <Checkbox checked={zerarEfetivo} disabled={!podeZerar} onCheckedChange={(v) => alternarZerar(v === true)} className="mt-0.5" />
              <span>
                <span className="font-medium">Zerar o estoque no Tiny (depósito Geral)</span>
                <span className="block text-xs text-muted-foreground">
                  Lança um balanço = 0 para o Tiny parar de anunciar estoque que não existe. A Shopee é conferida ~10 min depois
                  e o resultado sai no Discord. Dá para desfazer em "Estoque voltou".
                </span>
              </span>
            </label>

            {zerarEfetivo && ehKit && (
              <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                <div className="font-medium text-amber-900 dark:text-amber-200">
                  Este SKU é um kit. Qual componente está em falta?
                </div>
                <div className="space-y-1">
                  {preview.candidatos.map((c) => (
                    <label
                      key={c.sku}
                      className={cn(
                        "flex items-start gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/30",
                        escolhido === c.sku && "bg-amber-100 dark:bg-amber-900/40",
                      )}
                    >
                      <input type="radio" name="sku_zerar" className="mt-1" checked={escolhido === c.sku} onChange={() => setEscolhido(c.sku)} />
                      <span className="min-w-0">
                        <span className="font-mono font-semibold">{c.sku}</span>
                        {c.quantidade != null && <span className="text-xs text-muted-foreground"> · {c.quantidade}× no kit</span>}
                        <span className="block text-xs text-muted-foreground truncate">{c.nome ?? "—"}</span>
                        <span className={cn("block text-xs", c.geral ? "text-foreground" : "text-destructive")}>{fmtGeral(c.geral, c.erro)}</span>
                      </span>
                    </label>
                  ))}
                  {preview.candidatos.length === 0 && (
                    <div className="text-xs text-destructive">Kit sem composição cadastrada no Tiny — não há o que zerar.</div>
                  )}
                </div>
              </div>
            )}

            {zerarEfetivo && !ehKit && candidatoEscolhido && (
              <div className="rounded-md border p-3 text-xs">
                <span className="font-medium">Tiny hoje:</span> {fmtGeral(candidatoEscolhido.geral, candidatoEscolhido.erro)}
                {candidatoEscolhido.geral && candidatoEscolhido.geral.saldo > 0 && <span> → <b>0</b></span>}
                {candidatoEscolhido.geral && candidatoEscolhido.geral.saldo <= 0 && <span> · já está zerado (só confere a Shopee)</span>}
                {!candidatoEscolhido.geral && (
                  <span className="block text-destructive mt-1">Sem leitura do Tiny — o balanço vai falhar; o marcador e o aviso saem mesmo assim.</span>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={enviando}>Cancelar</Button>
          <Button
            onClick={() => void confirmar()}
            disabled={!podeConfirmar}
            className={cn(zerarEfetivo ? "bg-amber-600 hover:bg-amber-700 text-white" : "")}
            title={faltaEscolha ? "Escolha o componente em falta" : undefined}
          >
            {enviando ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <PackageX className="h-4 w-4 mr-2" />}
            {zerarEfetivo
              ? `Confirmar: reportar falta e zerar${ehKit && escolhido ? ` ${escolhido}` : ""} no Tiny`
              : "Confirmar: reportar falta (sem zerar)"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
