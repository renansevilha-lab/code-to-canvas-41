import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, CheckCircle2, ExternalLink, Loader2, PackagePlus, RefreshCw, Send, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { ModelosCaixaAmazon } from "./ModelosCaixaAmazon";

// ============================================================================
// Envio à Amazon pela API, a partir da REPOSIÇÃO (14/out/2026, pedido do dono): os produtos escolhidos no
// "Montar envio" viram o plano de envio na Amazon (edge fn amazon-inbound) — anúncio × modelo de caixa,
// caixas preenchidas pelos modelos, e a pessoa escolhe o centro de destino. Não cria envio no app: depois
// do destino, segue no Seller Central (transportadora, nota fiscal, etiquetas), baixa o PDF e lança em
// Envios como sempre. Só a SVL por enquanto (a ACZ ainda não tem a permissão de envios).
// ============================================================================

export interface ItemReposicao { sku: string; quantidade: number; titulo?: string | null }
interface Linha {
  sku: string; msku: string | null; titulo: string | null; quantidade: number; caixas: number | null;
  validade: string | null; problema: string | null; anuncios: string[];
  modelo: { nome: string | null; un_por_caixa: number; comprimento_cm: number; largura_cm: number; altura_cm: number; peso_kg: number } | null;
}
interface Destino { id: string; expira: string | null; taxa: number; desconto: number; envios: { id: string; cd: string | null; cidade: string | null }[] }
interface Plano {
  id: string; plano_id: string | null; passo: string; erro: string | null; destinos: Destino[] | null;
  envios_amazon: { id: string; fba: string | null; cd: string | null; status: string | null }[] | null;
  criado_por: string | null; criado_em: string; ultimos: { em: string; acao?: string; erro?: string }[];
}
interface Resposta { ok: boolean; erro?: string; conta: string; empresa: string | null; linhas: Linha[]; pendencias: string[]; avisos: string[]; plano: Plano | null }
interface PlanoResumo {
  id: string; empresa: string | null; passo: string; plano_id: string | null; erro: string | null; criado_por: string | null; criado_em: string;
  itens_origem: ItemReposicao[]; envios_amazon: { fba: string | null; cd: string | null }[] | null;
}

export const PASSOS: Record<string, string> = {
  novo: "começando", criando: "criando o plano", gerar_embalagem: "pedindo opções de embalagem", gerando_embalagem: "pedindo opções de embalagem",
  escolher_embalagem: "escolhendo a embalagem", confirmando_embalagem: "confirmando a embalagem", caixas: "informando as caixas",
  enviando_caixas: "informando as caixas", gerar_destinos: "pedindo os centros de destino", gerando_destinos: "pedindo os centros de destino",
  ler_destinos: "lendo os centros de destino", escolher_destino: "escolher o destino", confirmando_destino: "confirmando o destino",
  ler_envios: "lendo os envios da Amazon", destino_confirmado: "destino confirmado", cancelando: "cancelando", cancelado: "cancelado", erro: "parou com erro",
};
const PARADOS = new Set(["escolher_destino", "destino_confirmado", "cancelado", "erro"]);
const shopDe = (empresa: string | null) => (empresa === "SVL Store" ? 900002 : 900001);

async function chamar(body: Record<string, unknown>): Promise<any> {
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
  return j;
}

function corPasso(passo: string) {
  if (passo === "erro") return "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300";
  if (passo === "destino_confirmado") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (passo === "escolher_destino") return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
  if (passo === "cancelado") return "bg-muted text-muted-foreground";
  return "";
}

/** Planos criados pelo app nos últimos 30 dias — no topo da Reposição; clicar abre o plano. */
export function PlanosAmazonLista({ onAbrir }: { onAbrir: (planoId: string, empresa: string | null) => void }) {
  const q = useQuery({
    queryKey: ["amazon-inbound", "lista"],
    queryFn: async () => ((await chamar({ modulo: "lista" })).planos ?? []) as PlanoResumo[],
    staleTime: 30_000,
  });
  const planos = (q.data ?? []).filter((p) => p.passo !== "cancelado");
  if (!planos.length) return null;
  return (
    <Card className="p-3 space-y-2 border-[#FF9900]/40">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Send className="h-4 w-4 text-[#FF9900]" /> Envios criados na Amazon pelo app (30 dias)
      </div>
      <div className="flex flex-wrap gap-2">
        {planos.map((p) => {
          const un = (p.itens_origem ?? []).reduce((s, i) => s + Number(i.quantidade ?? 0), 0);
          return (
            <button key={p.id} type="button" onClick={() => onAbrir(p.id, p.empresa)}
              className="rounded-md border px-3 py-2 text-left text-[12.5px] hover:bg-accent/40">
              <div className="flex items-center gap-2">
                <span className="font-medium">{new Date(p.criado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <Badge variant="secondary" className={cn("h-5 px-1.5 text-[10.5px]", corPasso(p.passo))}>{PASSOS[p.passo] ?? p.passo}</Badge>
              </div>
              <div className="text-muted-foreground">
                {p.empresa ?? "—"} · {(p.itens_origem ?? []).length} SKU · {formatNumber(un)} un
                {p.envios_amazon?.length ? ` · ${p.envios_amazon.map((e) => e.fba).filter(Boolean).join(" + ")}` : ""}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** Janela do plano: com `itens` (vindo do Montar envio) começa um plano novo; com `planoId` abre um existente. */
export function PlanoAmazonDialog({ aberto, onFechar, empresa, itens, planoId: planoInicial }: {
  aberto: boolean; onFechar: () => void; empresa: string | null; itens?: ItemReposicao[]; planoId?: string | null;
}) {
  const qc = useQueryClient();
  const [planoRef, setPlanoRef] = useState<string | null>(planoInicial ?? null);
  const [escolhas, setEscolhas] = useState<Record<string, string>>({});
  const [rodando, setRodando] = useState<string | null>(null);
  const [confirmarCriar, setConfirmarCriar] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  const [destinoSel, setDestinoSel] = useState<string | null>(null);
  const [confirmarDestino, setConfirmarDestino] = useState(false);
  const [modelos, setModelos] = useState<{ msku?: string | null; sku?: string | null } | null>(null);

  const entrada = (itens ?? []).map((i) => ({ sku: i.sku, quantidade: i.quantidade, titulo: i.titulo ?? null, msku: escolhas[i.sku] ?? null }));
  const chave = planoRef ? ["amazon-inbound", "plano", planoRef] : ["amazon-inbound", "previa", empresa, JSON.stringify(entrada)];
  const q = useQuery({
    queryKey: chave,
    enabled: aberto && (!!planoRef || entrada.length > 0),
    placeholderData: undefined,
    staleTime: 0,
    queryFn: async () => (await chamar(planoRef ? { modulo: "previa", plano: planoRef } : { modulo: "previa", empresa, itens: entrada })) as Resposta,
  });
  const d = q.data;
  const plano = d?.plano ?? null;
  const pronto = (r: Resposta) => qc.setQueryData(r.plano ? ["amazon-inbound", "plano", r.plano.id] : chave, r);
  const atualizarLista = () => void qc.invalidateQueries({ queryKey: ["amazon-inbound", "lista"] });

  async function avancar(primeira: boolean) {
    setRodando("Criando o plano na Amazon…");
    try {
      let r: Resposta = await chamar(primeira ? { modulo: "avancar", empresa, itens: entrada, confirmar: true } : { modulo: "avancar", plano: planoRef });
      if (r.plano?.id) { setPlanoRef(r.plano.id); pronto(r); }
      for (let i = 0; i < 15 && r.plano && !PARADOS.has(r.plano.passo); i++) {
        setRodando(`Na Amazon: ${PASSOS[r.plano.passo] ?? r.plano.passo}…`);
        r = await chamar({ modulo: "avancar", plano: r.plano.id });
        pronto(r);
      }
      atualizarLista();
      if (r.plano?.passo === "erro") toast.error("A Amazon recusou um passo", { description: r.plano.erro ?? undefined });
      else if (r.plano?.passo === "escolher_destino") toast.success("Plano criado: escolha o centro de destino");
      else if (r.plano && !PARADOS.has(r.plano.passo)) toast.message("A Amazon ainda está processando — clique em Continuar daqui a pouco");
    } catch (e) {
      toast.error("Falha no envio à Amazon", { description: (e as Error).message });
    } finally {
      setRodando(null);
    }
  }
  async function acao(modulo: "confirmar-destino" | "cancelar", texto: string) {
    if (!planoRef) return;
    setRodando(texto);
    try {
      const r: Resposta = await chamar({ modulo, plano: planoRef, confirmar: true, ...(modulo === "confirmar-destino" ? { opcao_id: destinoSel } : {}) });
      pronto(r);
      atualizarLista();
      if (r.ok === false) toast.error(r.erro ?? "A Amazon recusou");
      else if (r.plano?.passo === "destino_confirmado") toast.success("Destino confirmado na Amazon");
      else if (r.plano?.passo === "cancelado") toast.success("Plano cancelado na Amazon");
      else if (r.plano?.passo === "erro") toast.error("A Amazon recusou", { description: r.plano.erro ?? undefined });
    } catch (e) {
      toast.error("Falha na Amazon", { description: (e as Error).message });
    } finally {
      setRodando(null);
    }
  }

  const linhas = d?.linhas ?? [];
  const totalCaixas = linhas.reduce((s, l) => s + (l.caixas ?? 0), 0);
  const destinoEscolhido = plano?.destinos?.find((x) => x.id === destinoSel) ?? null;
  const novo = !plano;

  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v && !rodando) onFechar(); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <Send className="h-5 w-5 text-[#FF9900]" /> Envio à Amazon pela API
            {d?.conta && <span className="text-sm font-normal text-muted-foreground">{d.conta}</span>}
            {plano && <Badge variant="secondary" className={corPasso(plano.passo)}>{PASSOS[plano.passo] ?? plano.passo}</Badge>}
          </DialogTitle>
          <DialogDescription>
            O app cria o plano na Amazon com as caixas dos modelos e para na escolha do centro de destino. Depois: transportadora,
            nota fiscal e etiquetas no Seller Central; baixe o PDF e lance em Envios como sempre.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setModelos({})}><Boxes className="h-4 w-4" /> Modelos de caixa</Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Atualizar" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cn("h-4 w-4", q.isFetching && "animate-spin")} />
          </Button>
          {rodando && <span className="ml-2 flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> {rodando}</span>}
        </div>

        {q.isLoading && <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Conferindo os itens…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

        {d && (
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
                {linhas.map((l) => (
                  <tr key={l.sku} className="border-t align-top">
                    <td className="px-2 py-1.5">
                      <div className="font-mono text-[12px]">{l.sku}</div>
                      {l.titulo && <div className="max-w-[260px] truncate text-[11px] text-muted-foreground" title={l.titulo}>{l.titulo}</div>}
                    </td>
                    <td className="px-2 py-1.5">
                      {novo && l.anuncios.length > 1 ? (
                        <select className="h-8 rounded-md border bg-card px-1.5 text-[12px] font-mono" value={l.msku ?? ""}
                          onChange={(e) => setEscolhas((x) => ({ ...x, [l.sku]: e.target.value }))}>
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
                      ) : l.msku && novo ? (
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-[12px]" onClick={() => setModelos({ msku: l.msku, sku: l.sku })}>
                          <PackagePlus className="h-3.5 w-3.5" /> cadastrar modelo
                        </Button>
                      ) : "—"}
                      {novo && l.problema && <div className="mt-0.5 text-[11.5px] text-destructive">{l.problema}</div>}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{l.caixas ?? "—"}</td>
                    <td className="px-2 py-1.5 text-[12px] whitespace-nowrap">{l.validade ? l.validade.split("-").reverse().join("/") : <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {d && novo && (
          <>
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
            <Button className="gap-1.5" disabled={!!rodando || d.pendencias.length > 0 || linhas.length === 0} onClick={() => setConfirmarCriar(true)}>
              {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Criar plano na Amazon ({totalCaixas} {totalCaixas === 1 ? "caixa" : "caixas"})
            </Button>
          </>
        )}

        {plano && plano.passo === "erro" && (
          <div className="space-y-2">
            <p className="rounded-md border border-red-300/60 bg-red-50 px-3 py-2 text-[12.5px] text-red-800 dark:bg-red-950/30 dark:text-red-300">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> {plano.erro}
            </p>
            <p className="text-[12.5px] text-muted-foreground">Corrija (modelo de caixa, validade…) e monte o envio de novo na Reposição.{plano.plano_id ? " Cancele este plano para não deixá-lo aberto na Amazon." : ""}</p>
            {plano.plano_id && (
              <Button variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => setConfirmarCancelar(true)}>
                <XCircle className="h-4 w-4" /> Cancelar o plano na Amazon
              </Button>
            )}
          </div>
        )}

        {plano && !PARADOS.has(plano.passo) && (
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className={cn("h-4 w-4", rodando && "animate-spin")} />
            <span>{rodando ?? `A Amazon está em: ${PASSOS[plano.passo] ?? plano.passo}.`}</span>
            {!rodando && <Button size="sm" variant="outline" onClick={() => void avancar(false)}>Continuar</Button>}
          </div>
        )}

        {plano?.passo === "escolher_destino" && (
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
                <CheckCircle2 className="h-4 w-4" /> Confirmar destino
              </Button>
              <Button variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => setConfirmarCancelar(true)}>
                <XCircle className="h-4 w-4" /> Cancelar o plano
              </Button>
            </div>
          </div>
        )}

        {plano?.passo === "destino_confirmado" && (
          <div className="space-y-2 text-sm">
            <div className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
              <CheckCircle2 className="mr-1 inline h-4 w-4" /> Envio criado na Amazon:{" "}
              {(plano.envios_amazon ?? []).map((e) => `${e.fba ?? e.id}${e.cd ? ` → ${e.cd}` : ""}`).join(" · ")}
            </div>
            <p className="text-muted-foreground">
              Falta no Seller Central: escolher a transportadora, informar a nota fiscal de remessa e imprimir as etiquetas. Depois baixe o PDF
              do envio e lance em Fulfillment › Envios, como sempre.
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
                {d?.conta}: {linhas.map((l) => `${l.msku} × ${l.quantidade}`).join(", ")} — {totalCaixas} {totalCaixas === 1 ? "caixa" : "caixas"}, saindo de
                Caieiras. O app cria o plano, informa as caixas pelos modelos e para na escolha do centro de destino (nada é confirmado nem
                cobrado antes disso). O plano aparece no Seller Central.
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
              <AlertDialogAction onClick={() => void acao("confirmar-destino", "Confirmando o destino na Amazon…")}>Confirmar destino</AlertDialogAction>
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
              <AlertDialogAction onClick={() => void acao("cancelar", "Cancelando o plano na Amazon…")}>Cancelar o plano</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {modelos && (
          <ModelosCaixaAmazon shopId={shopDe(empresa)} aberto onFechar={() => { setModelos(null); void q.refetch(); }} novoMsku={modelos.msku} novoSku={modelos.sku} />
        )}
      </DialogContent>
    </Dialog>
  );
}
