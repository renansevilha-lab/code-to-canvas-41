// Envios ao Full × marketplace (19/out/2026, pedido do dono):
//  - ImportarEnviosAmazon: traz para a aba Envios os envios já criados no Seller Central (amazon-inbound v7 amazon-envios/importar)
//  - RecebimentoAmazon: no envio da Amazon, quanto a Amazon já recebeu de cada SKU, ao vivo (amazon-inbound recebimento)
//  - NotaRemessaML: no envio do ML, acha e anexa a nota de remessa que o próprio ML emite (ml-nf-remessa)
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Download, FileText, Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

async function chamar(funcao: string, body: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/${funcao}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ importar da Amazon
interface EnvioAmz { numero: string; nome: string | null; status: string | null; status_pt: string | null; cd: string | null; no_app: string | null }

export function ImportarEnviosAmazon({ onImportado }: { onImportado: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [empresa, setEmpresa] = useState<"SVL Store" | "ACZ Pet">("SVL Store");
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [importando, setImportando] = useState(false);
  const q = useQuery({
    queryKey: ["fulfillment", "amazon-envios", empresa],
    enabled: aberto,
    staleTime: 0,
    gcTime: 0,
    placeholderData: undefined,
    queryFn: async () => (await chamar("amazon-inbound", { modulo: "amazon-envios", empresa, dias: 45 })) as { ok: boolean; erro?: string; sem_papel?: boolean; envios?: EnvioAmz[] },
  });
  const fora = (q.data?.envios ?? []).filter((e) => !e.no_app);
  const noApp = (q.data?.envios ?? []).length - fora.length;

  async function importar() {
    if (!marcados.size) return;
    if (!window.confirm(`Criar ${marcados.size} envio(s) na aba Envios com os itens da Amazon?`)) return;
    setImportando(true);
    try {
      const r = await chamar("amazon-inbound", { modulo: "importar", empresa, ids: [...marcados], confirmar: true });
      const res = (r.resultado ?? []) as { numero: string; criado?: boolean; erro?: string }[];
      const criados = res.filter((x) => x.criado).length;
      const erros = res.filter((x) => x.erro);
      if (criados) toast.success(`${criados} envio(s) importado(s) da Amazon`);
      if (erros.length) toast.error("Alguns não foram importados", { description: erros.map((x) => `${x.numero}: ${x.erro}`).join(" · ") });
      setMarcados(new Set());
      onImportado();
      void q.refetch();
    } catch (e) { toast.error("Falha ao importar", { description: (e as Error).message }); } finally { setImportando(false); }
  }

  return (
    <>
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAberto(true)} title="Trazer envios já criados no Seller Central">
        <Download className="h-3.5 w-3.5" /> Importar da Amazon
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { if (!importando) setAberto(v); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Envios já criados na Amazon</DialogTitle>
            <DialogDescription>
              Envios dos últimos 45 dias que ainda não estão na aba Envios. Importar cria o envio com os produtos e as quantidades
              que a Amazon tem; etiquetas e nota fiscal continuam por anexo.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {(["SVL Store", "ACZ Pet"] as const).map((e) => (
              <Button key={e} size="sm" variant={empresa === e ? "default" : "outline"} onClick={() => { setEmpresa(e); setMarcados(new Set()); }}>{e}</Button>
            ))}
            <Button size="sm" variant="ghost" className="gap-1" disabled={q.isFetching} onClick={() => void q.refetch()}>
              <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} /> Atualizar
            </Button>
          </div>
          {q.isFetching && <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Lendo os envios na Amazon…</p>}
          {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
          {q.data?.ok === false && (
            <p className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {q.data.erro}
            </p>
          )}
          {q.data?.ok && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{fora.length} fora da aba Envios · {noApp} já estão lá</p>
              {fora.length === 0 ? (
                <p className="text-sm text-muted-foreground">Todos os envios do período já estão na aba Envios.</p>
              ) : (
                <div className="divide-y rounded-md border">
                  {fora.map((e) => (
                    <label key={e.numero} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                      <input type="checkbox" checked={marcados.has(e.numero)}
                        onChange={(ev) => setMarcados((s) => { const n = new Set(s); if (ev.target.checked) n.add(e.numero); else n.delete(e.numero); return n; })} />
                      <span className="font-mono text-[12.5px]">{e.numero}</span>
                      <span className="text-muted-foreground">{e.cd ?? "?"}</span>
                      <span className="flex-1 truncate text-muted-foreground">{e.nome}</span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px]", e.status === "WORKING" || e.status === "READY_TO_SHIP" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700")}>
                        {e.status_pt}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex justify-end">
                <Button disabled={!marcados.size || importando} className="gap-1.5" onClick={() => void importar()}>
                  {importando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Importar {marcados.size || ""}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ recebido × enviado (Amazon)
interface LinhaRec { sku: string; sku_amazon: string; enviado: number; recebido: number }

export function RecebimentoAmazon({ numero, empresa }: { numero: string; empresa: string | null }) {
  const emp = empresa === "SVL Store" ? "SVL Store" : "ACZ Pet";
  const q = useQuery({
    queryKey: ["fulfillment", "recebimento-amazon", numero, emp],
    staleTime: 5 * 60_000,
    placeholderData: undefined,
    queryFn: async () => (await chamar("amazon-inbound", { modulo: "recebimento", empresa: emp, numero })) as
      { ok: boolean; erro?: string; status_pt?: string; enviado?: number; recebido?: number; itens?: LinhaRec[]; lido_em?: string },
  });
  const d = q.data;
  // a API v0 pode repetir o mesmo SKU (uma linha por caixa): soma por SKU
  const porSku = new Map<string, LinhaRec>();
  for (const l of d?.itens ?? []) {
    const k = `${l.sku}|${l.sku_amazon}`;
    const a = porSku.get(k);
    porSku.set(k, a ? { ...a, enviado: a.enviado + l.enviado, recebido: a.recebido + l.recebido } : { ...l });
  }
  const linhas = [...porSku.values()];
  const enviado = linhas.reduce((s, l) => s + l.enviado, 0), recebido = linhas.reduce((s, l) => s + l.recebido, 0);
  return (
    <Card className="p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><PackageCheck className="h-4 w-4" /> Recebido pela Amazon</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {d?.status_pt && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">{d.status_pt}</span>}
          <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={q.isFetching} onClick={() => void q.refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} /> Atualizar
          </Button>
        </div>
      </div>
      {q.isLoading && <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Consultando a Amazon…</p>}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
      {d?.ok === false && <p className="text-sm text-amber-800">{d.erro}</p>}
      {d?.ok && (
        <>
          <p className="text-sm">
            <b>{formatNumber(recebido)}</b> de {formatNumber(enviado)} unidades recebidas
            {enviado > recebido ? <span className="text-amber-700"> · faltam {formatNumber(enviado - recebido)}</span> : enviado > 0 ? <span className="text-emerald-700"> · tudo recebido</span> : null}
          </p>
          <table className="w-full text-[12.5px]">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1">SKU</th><th>Enviado</th><th>Recebido</th><th>Falta</th></tr></thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={`${l.sku}|${l.sku_amazon}`} className="border-t">
                  <td className="py-1">{l.sku}{l.sku_amazon !== l.sku && <span className="text-muted-foreground"> ({l.sku_amazon})</span>}</td>
                  <td>{formatNumber(l.enviado)}</td>
                  <td>{formatNumber(l.recebido)}</td>
                  <td className={cn(l.enviado > l.recebido && "font-medium text-amber-700")}>{l.enviado > l.recebido ? formatNumber(l.enviado - l.recebido) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ nota de remessa do ML
export function NotaRemessaML({ envioId, onAnexado }: { envioId: string; onAnexado: () => void }) {
  const [rodando, setRodando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function buscar() {
    setRodando(true); setMsg(null);
    try {
      const r = await chamar("ml-nf-remessa", { envio_id: envioId });
      const x = (r.resultado ?? [])[0] ?? {};
      if (x.erro) { setMsg(x.erro); toast.error("Nota de remessa", { description: x.erro }); return; }
      if (!x.achou) { setMsg(x.aviso ?? "nota ainda não encontrada"); return; }
      const rot = (x.notas ?? []).map((n: any) => n.rotulo).join(", ");
      setMsg(`Anexada: ${rot}`);
      toast.success(`Nota de remessa anexada (${rot})`);
      onAnexado();
    } catch (e) { setMsg((e as Error).message); toast.error("Falha ao buscar a nota", { description: (e as Error).message }); } finally { setRodando(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button size="sm" variant="outline" className="gap-1.5" disabled={rodando} onClick={() => void buscar()}
        title="O Mercado Livre emite a nota de remessa do envio ao Full; o app procura e anexa DANFE e XML">
        {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Buscar nota de remessa no ML
      </Button>
      {msg && <span className="flex items-center gap-1 text-muted-foreground">{msg.startsWith("Anexada") && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}{msg}</span>}
    </div>
  );
}
