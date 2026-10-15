import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, CheckCircle2, ExternalLink, Loader2, PackagePlus, RefreshCw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { ModelosCaixaAmazon } from "./ModelosCaixaAmazon";

// ============================================================================
// Envio pela API da Amazon (14/out/2026, pedido do dono): o envio da aba Envios vira o plano na Amazon
// (edge fn amazon-inbound) — itens × anúncio × modelo de caixa, caixas preenchidas pelos modelos, e a
// pessoa escolhe o centro de destino. Transportadora, nota fiscal e etiquetas seguem no Seller Central.
// Só a SVL por enquanto (a ACZ ainda não tem a permissão de envios no aplicativo da Amazon).
// ============================================================================

interface Linha {
  sku: string; msku: string | null; titulo: string | null; quantidade: number; caixas: number | null;
  validade: string | null; problema: string | null; anuncios: string[];
  modelo: { nome: string | null; un_por_caixa: number; comprimento_cm: number; largura_cm: number; altura_cm: number; peso_kg: number } | null;
}
interface Destino { id: string; expira: string | null; taxa: number; desconto: number; envios: { id: string; cd: string | null; cidade: string | null }[] }
interface Plano {
  plano_id: string | null; passo: string; erro: string | null; destinos: Destino[] | null; destino_escolhido: string | null;
  envios_amazon: { id: string; fba: string | null; cd: string | null; status: string | null }[] | null;
  criado_por: string | null; criado_em: string; atualizado_em: string; ultimos: { em: string; acao?: string; erro?: string }[];
}
interface Resposta { ok: boolean; erro?: string; conta: string; linhas: Linha[]; pendencias: string[]; avisos: string[]; plano: Plano | null }

const PASSOS: Record<string, string> = {
  novo: "começando", criando: "criando o plano", gerar_embalagem: "pedindo opções de embalagem", gerando_embalagem: "pedindo opções de embalagem",
  escolher_embalagem: "escolhendo a embalagem", confirmando_embalagem: "confirmando a embalagem", caixas: "informando as caixas",
  enviando_caixas: "informando as caixas", gerar_destinos: "pedindo os centros de destino", gerando_destinos: "pedindo os centros de destino",
  ler_destinos: "lendo os centros de destino", escolher_destino: "escolha o centro de destino", confirmando_destino: "confirmando o destino",
  ler_envios: "lendo os envios da Amazon", destino_confirmado: "destino confirmado", cancelando: "cancelando", cancelado: "cancelado", erro: "parou com erro",
};
const PARADOS = new Set(["escolher_destino", "destino_confirmado", "cancelado", "erro"]);

async function chamar(body: Record<string, unknown>): Promise<Resposta> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/amazon-inbound`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j?.linhas) throw new Error(j?.erro ? `${j.erro}${j.pendencias ? `: ${j.pendencias.join(" · ")}` : ""}` : `HTTP ${r.status}`);
  return j as Resposta;
}

export function EnvioAmazonApi({ envioId, empresa }: { envioId: string; empresa: string | null }) {
  const qc = useQueryClient();
  const shopId = empresa === "SVL Store" ? 900002 : 900001;
  const [rodando, setRodando] = useState<string | null>(null);
  const [confirmarCriar, setConfirmarCriar] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  const [destinoSel, setDestinoSel] = useState<string | null>(null);
  const [confirmarDestino, setConfirmarDestino] = useState(false);
  const [modelos, setModelos] = useState<{ msku?: string | null; sku?: string | null } | null>(null);

  const q = useQuery({
    queryKey: ["amazon-inbound", envioId],
    placeholderData: undefined,
    staleTime: 0,
    queryFn: () => chamar({ modulo: "previa", envio_id: envioId }),
  });
  const d = q.data;
  const plano = d?.plano ?? null;
  const ativo = plano && plano.passo !== "cancelado";

  /** Avança o plano até parar (escolher destino, erro…) — cada chamada roda ~20 s no servidor. */
  async function avancar(primeira: boolean) {
    setRodando("Criando o plano na Amazon…");
    try {
      let r = await chamar({ modulo: "avancar", envio_id: envioId, confirmar: primeira });
      for (let i = 0; i < 15 && r.plano && !PARADOS.has(r.plano.passo); i++) {
        setRodando(`Na Amazon: ${PASSOS[r.plano.passo] ?? r.plano.passo}…`);
        qc.setQueryData(["amazon-inbound", envioId], r);
        r = await chamar({ modulo: "avancar", envio_id: envioId });
      }
      qc.setQueryData(["amazon-inbound", envioId], r);
      if (r.plano?.passo === "erro") toast.error("A Amazon recusou um passo", { description: r.plano.erro ?? undefined });
      else if (r.plano?.passo === "escolher_destino") toast.success("Plano criado: escolha o centro de destino");
      else if (r.plano && !PARADOS.has(r.plano.passo)) toast.message("A Amazon ainda está processando — clique em Continuar daqui a pouco");
    } catch (e) {
      toast.error("Falha no envio à Amazon", { description: (e as Error).message });
      void q.refetch();
    } finally {
      setRodando(null);
    }
  }
  async function confirmarDest() {
    if (!destinoSel) return;
    setRodando("Confirmando o destino na Amazon…");
    try {
      const r = await chamar({ modulo: "confirmar-destino", envio_id: envioId, opcao_id: destinoSel, confirmar: true });
      qc.setQueryData(["amazon-inbound", envioId], r);
      if (r.plano?.passo === "destino_confirmado") {
        toast.success("Destino confirmado na Amazon");
        void qc.invalidateQueries({ queryKey: ["fulfillment"] });
      } else if (r.plano?.passo === "erro") toast.error("A Amazon recusou", { description: r.plano.erro ?? undefined });
    } catch (e) {
      toast.error("Falha ao confirmar o destino", { description: (e as Error).message });
    } finally {
      setRodando(null);
    }
  }
  async function cancelar() {
    setRodando("Cancelando o plano na Amazon…");
    try {
      const r = await chamar({ modulo: "cancelar", envio_id: envioId, confirmar: true });
      qc.setQueryData(["amazon-inbound", envioId], r);
      if (r.ok === false) toast.error(r.erro ?? "A Amazon recusou o cancelamento");
      else toast.success("Plano cancelado na Amazon");
    } catch (e) {
      toast.error("Falha ao cancelar", { description: (e as Error).message });
    } finally {
      setRodando(null);
    }
  }
  async function escolherAnuncio(sku: string, msku: string) {
    const { error } = await supabaseExternal.from("fulfillment_envio_itens").update({ sku_origem: msku }).eq("envio_id", envioId).eq("sku", sku);
    if (error) return toast.error("Não salvou o anúncio", { description: error.message });
    void q.refetch();
  }

  const totalCaixas = (d?.linhas ?? []).reduce((s, l) => s + (l.caixas ?? 0), 0);
  const destinoEscolhido = plano?.destinos?.find((x) => x.id === destinoSel) ?? null;

  return (
    <Card className="p-4 space-y-3 border-[#FF9900]/40">
      <div className="flex flex-wrap items-center gap-2">
        <Send className="h-4 w-4 text-[#FF9900]" />
        <h3 className="text-sm font-semibold">Criar envio na Amazon pela API</h3>
        {d?.conta && <span className="text-xs text-muted-foreground">{d.conta}</span>}
        {plano && (
          <Badge variant="secondary" className={cn(plano.passo === "erro" && "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
            plano.passo === "destino_confirmado" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300")}>
            {PASSOS[plano.passo] ?? plano.passo}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setModelos({})}><Boxes className="h-4 w-4" /> Modelos de caixa</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Atualizar" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cn("h-4 w-4", q.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {q.isLoading && <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Conferindo os itens…</p>}
      {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      {d && (!ativo || plano?.passo === "erro") && (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 text-left">Produto</th>
                  <th className="px-2 py-2 text-left">Anúncio na Amazon</th>
                  <th className="px-2 py-2 text-right">Unidades</th>
                  <th className="px-2 py-2 text-left">Modelo de caixa</th>
                  <th className="px-2 py-2 text-right">Caixas</th>
                  <th className="px-2 py-2 text-left">Validade</th>
                </tr>
              </thead>
              <tbody>
                {d.linhas.map((l) => (
                  <tr key={l.sku} className="border-t align-top">
                    <td className="px-2 py-1.5">
                      <div className="font-mono text-[12px]">{l.sku}</div>
                      {l.titulo && <div className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={l.titulo}>{l.titulo}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {l.anuncios.length > 1 ? (
                        <select className="h-8 rounded-md border bg-card px-1.5 text-[12px] font-mono" value={l.msku ?? ""} onChange={(e) => void escolherAnuncio(l.sku, e.target.value)}>
                          <option value="" disabled>escolha…</option>
                          {l.anuncios.map((a) => <option key={a} value={a}>{a}</option>)}
                        </select>
                      ) : <span className="font-mono text-[12px]">{l.msku ?? "—"}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.quantidade}</td>
                    <td className="px-2 py-1.5 text-[12px]">
                      {l.modelo ? (
                        <span>
                          {l.modelo.nome || "sem nome"} · {l.modelo.un_por_caixa} un · {Number(l.modelo.comprimento_cm)}×{Number(l.modelo.largura_cm)}×{Number(l.modelo.altura_cm)} cm · {String(l.modelo.peso_kg).replace(".", ",")} kg
                        </span>
                      ) : l.msku ? (
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[12px]" onClick={() => setModelos({ msku: l.msku, sku: l.sku })}>
                          <PackagePlus className="h-3.5 w-3.5" /> cadastrar modelo
                        </Button>
                      ) : "—"}
                      {l.problema && <div className="mt-0.5 text-[11.5px] text-destructive">{l.problema}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.caixas ?? "—"}</td>
                    <td className="px-2 py-1.5 text-[12px] whitespace-nowrap">{l.validade ? l.validade.split("-").reverse().join("/") : <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.pendencias.length > 0 && (
            <ul className="space-y-0.5 rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-[12.5px] text-red-800 dark:bg-red-950/30 dark:text-red-300">
              {d.pendencias.map((p) => <li key={p}>• {p}</li>)}
            </ul>
          )}
          {d.avisos.length > 0 && (
            <ul className="space-y-0.5 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {d.avisos.map((p) => <li key={p}>• {p}</li>)}
            </ul>
          )}
          {plano?.passo === "erro" && plano.erro && (
            <p className="rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-[12.5px] text-red-800 dark:bg-red-950/30 dark:text-red-300">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> {plano.erro}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(!plano || plano.passo === "cancelado" || (plano.passo === "erro" && !plano.plano_id) || (plano.passo === "erro" && /^(criando|criar plano):/.test(plano.erro ?? ""))) && (
              <Button className="gap-1.5" disabled={!!rodando || d.pendencias.length > 0 || d.linhas.length === 0} onClick={() => setConfirmarCriar(true)}>
                {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Criar plano na Amazon ({totalCaixas} {totalCaixas === 1 ? "caixa" : "caixas"})
              </Button>
            )}
            {plano?.passo === "erro" && plano.plano_id && (
              <Button variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => setConfirmarCancelar(true)}>
                <XCircle className="h-4 w-4" /> Cancelar o plano na Amazon
              </Button>
            )}
            {rodando && <span className="text-sm text-muted-foreground">{rodando}</span>}
          </div>
        </>
      )}

      {plano && ativo && plano.passo !== "erro" && (
        <div className="space-y-3">
          {!PARADOS.has(plano.passo) && (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className={cn("h-4 w-4", rodando && "animate-spin")} />
              <span>{rodando ?? `A Amazon está em: ${PASSOS[plano.passo] ?? plano.passo}.`}</span>
              {!rodando && <Button size="sm" variant="outline" onClick={() => void avancar(false)}>Continuar</Button>}
            </div>
          )}

          {plano.passo === "escolher_destino" && (
            <div className="space-y-2">
              <p className="text-sm">Escolha para onde mandar. A Amazon pode dividir o envio em mais de um centro; a taxa é a da alocação escolhida.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(plano.destinos ?? []).map((o) => (
                  <button key={o.id} type="button" onClick={() => setDestinoSel(o.id)}
                    className={cn("rounded-md border p-3 text-left text-sm transition", destinoSel === o.id ? "border-primary ring-2 ring-primary/30" : "hover:bg-accent/40")}>
                    <div className="font-medium">{o.envios.map((e) => `${e.cd ?? "?"}${e.cidade ? ` (${e.cidade})` : ""}`).join(" + ")}</div>
                    <div className="text-[12.5px] text-muted-foreground">
                      {o.envios.length} {o.envios.length === 1 ? "envio" : "envios"} · taxa {formatBRL(o.taxa)}{o.desconto ? ` · desconto ${formatBRL(o.desconto)}` : ""}
                      {o.expira ? ` · vale até ${new Date(o.expira).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className="gap-1.5" disabled={!destinoSel || !!rodando} onClick={() => setConfirmarDestino(true)}>
                  {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirmar destino
                </Button>
                <Button variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => setConfirmarCancelar(true)}>
                  <XCircle className="h-4 w-4" /> Cancelar o plano
                </Button>
                {rodando && <span className="self-center text-sm text-muted-foreground">{rodando}</span>}
              </div>
            </div>
          )}

          {plano.passo === "destino_confirmado" && (
            <div className="space-y-2 text-sm">
              <div className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                <CheckCircle2 className="mr-1 inline h-4 w-4" /> Envio criado na Amazon:{" "}
                {(plano.envios_amazon ?? []).map((e) => `${e.fba ?? e.id}${e.cd ? ` → ${e.cd}` : ""}`).join(" · ")}
              </div>
              <p className="text-muted-foreground">
                Falta no Seller Central: escolher a transportadora, informar a nota fiscal de remessa e imprimir as etiquetas das caixas.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm" className="gap-1.5">
                  <a href={`https://sellercentral.amazon.com.br/fba/sendtoamazon?wf=${plano.plano_id}`} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" /> Continuar no Seller Central
                  </a>
                </Button>
                <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-destructive" disabled={!!rodando} onClick={() => setConfirmarCancelar(true)}>
                  <XCircle className="h-4 w-4" /> Cancelar o plano
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {plano && (plano.ultimos?.length ?? 0) > 0 && (
        <details className="text-[11.5px] text-muted-foreground">
          <summary className="cursor-pointer">Histórico do plano{plano.plano_id ? ` (${plano.plano_id})` : ""}{plano.criado_por ? ` · criado por ${plano.criado_por}` : ""}</summary>
          <ul className="mt-1 space-y-0.5">
            {plano.ultimos.map((u, i) => (
              <li key={i}>{new Date(u.em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })} — {u.acao}{u.erro ? `: ${u.erro}` : ""}</li>
            ))}
          </ul>
        </details>
      )}

      <AlertDialog open={confirmarCriar} onOpenChange={setConfirmarCriar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Criar o plano de envio na Amazon?</AlertDialogTitle>
            <AlertDialogDescription>
              {d?.conta}: {(d?.linhas ?? []).map((l) => `${l.msku} × ${l.quantidade}`).join(", ")} — {totalCaixas} {totalCaixas === 1 ? "caixa" : "caixas"}, saindo de
              Caieiras. O app cria o plano, informa as caixas pelos modelos e para na escolha do centro de destino (nada é confirmado
              nem cobrado antes disso). O plano aparece no Seller Central.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void avancar(true)}>Criar plano</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmarDestino} onOpenChange={setConfirmarDestino}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar este destino?</AlertDialogTitle>
            <AlertDialogDescription>
              {destinoEscolhido ? `${destinoEscolhido.envios.map((e) => e.cd ?? "?").join(" + ")} · taxa de alocação ${formatBRL(destinoEscolhido.taxa)}. ` : ""}
              Depois de confirmado, a Amazon cria o(s) envio(s) e a taxa passa a valer. Cancelar depois disso pode ter custo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmarDest()}>Confirmar destino</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmarCancelar} onOpenChange={setConfirmarCancelar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar o plano na Amazon?</AlertDialogTitle>
            <AlertDialogDescription>
              O plano {plano?.plano_id} é cancelado na Amazon e não volta.
              {plano?.passo === "destino_confirmado" ? " O destino já foi confirmado: a Amazon pode cobrar pelo cancelamento." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void cancelar()}>Cancelar o plano</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {modelos && (
        <ModelosCaixaAmazon shopId={shopId} aberto onFechar={() => { setModelos(null); void q.refetch(); }} novoMsku={modelos.msku} novoSku={modelos.sku} />
      )}
    </Card>
  );
}
