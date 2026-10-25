import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, CheckCircle2, ChevronRight, ExternalLink, Loader2, PackagePlus, RefreshCw, Send, XCircle } from "lucide-react";
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
// Envios como sempre. As duas contas (a ACZ ganhou a permissão de envios em 20/out/2026).
// ============================================================================

export interface ItemReposicao { sku: string; quantidade: number; titulo?: string | null }
interface Linha {
  sku: string; msku: string | null; titulo: string | null; quantidade: number; caixas: number | null;
  validade: string | null; problema: string | null; anuncios: string[];
  modelo: { nome: string | null; un_por_caixa: number; comprimento_cm: number; largura_cm: number; altura_cm: number; peso_kg: number } | null;
}
// v5 (19/out/2026): transporte escolhido pela API — se o destino foi confirmado pelo app, o Seller Central exige isso
interface OpcaoTransporte {
  id: string; transportadora: string | null; modo: string | null; solucao: string | null; custo: number | null;
  coleta_inicio: string | null; coleta_fim: string | null; precondicoes: string[];
}
interface NfRemessa { numero: string | null; serie: string | null; chave: string; emitida_em: string | null; valor: number | null; importada_em: string }
interface EnvioAmazon {
  id: string; fba: string | null; cd: string | null; status: string | null; transporte_opcoes?: OpcaoTransporte[]; transporte_escolhido?: string | null; envio_app_id?: string | null;
  nf?: (NfRemessa & { danfe?: boolean; danfe_erro?: string }) | null; nf_erro?: string | null; nf_tentativa_em?: string | null;
  coleta?: { inicio: string; fim: string | null; transportadora: string | null } | null;
}
// v6: depois do transporte confirmado o servidor cria o envio na aba Envios (itens + etiquetas das caixas e de produto)
interface EnvioApp { fba: string | null; cd: string | null; envio_id?: string; criado?: boolean; erro?: string; avisos: string[]; caixas?: number; doc_caixas?: string; doc_produto?: string }
interface Destino { id: string; expira: string | null; taxa: number; desconto: number; envios: { id: string; cd: string | null; cidade: string | null }[] }
interface Plano {
  id: string; plano_id: string | null; passo: string; erro: string | null; destinos: Destino[] | null;
  envios_amazon: EnvioAmazon[] | null;
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
  ler_envios: "lendo os envios da Amazon", destino_confirmado: "falta o transporte",
  gerar_transporte: "cotando o transporte", gerando_transporte: "cotando o transporte", ler_transporte: "lendo as opções de transporte",
  escolher_transporte: "escolher o transporte", confirmando_transporte: "confirmando o transporte", transporte_confirmado: "transporte confirmado", cancelando: "cancelando", cancelado: "cancelado", erro: "parou com erro",
};
const PARADOS = new Set(["escolher_destino", "destino_confirmado", "escolher_transporte", "transporte_confirmado", "cancelado", "erro"]);
const dataHora = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" }) : "—");
const horaBRT = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
/** Nome da opção para gente: parceira da Amazon = coleta; por nossa conta = quem leva e como. */
function rotuloOpcao(o: OpcaoTransporte): string {
  if (o.solucao === "AMAZON_PARTNERED_CARRIER") return `Coleta ${o.transportadora ?? ""} (parceira Amazon) · ${dataHora(o.coleta_inicio)}${o.custo != null ? ` · ${formatBRL(o.custo)}` : ""}`;
  const quem = o.transportadora === "Self" ? "Nós levamos ao CD" : o.transportadora === "Other" ? "Outra transportadora (contratada por nós)" : `${o.transportadora} (contratada por nós)`;
  return `${quem} · ${o.modo === "FREIGHT_LTL" ? "em palete" : "em caixas"}`;
}
const chaveOpcao = (o: OpcaoTransporte) => `${o.solucao}|${o.modo}|${o.transportadora}|${o.coleta_inicio ?? ""}`;
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
  if (passo === "transporte_confirmado") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (passo === "escolher_destino" || passo === "escolher_transporte" || passo === "destino_confirmado") return "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300";
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
  // recolhido por padrão (pedido do dono): a lista ocupa muito espaço no topo da Reposição; o resumo diz se há erro
  const [aberto, setAberto] = useState(false);
  if (!planos.length) return null;
  const comErro = planos.filter((p) => p.passo === "erro").length;
  const parados = planos.filter((p) => p.passo !== "erro" && p.passo !== "transporte_confirmado").length;
  return (
    <Card className="px-3 py-2 space-y-2 border-[#FF9900]/40">
      <button type="button" onClick={() => setAberto((v) => !v)} className="flex w-full items-center gap-2 text-left text-[13px] font-semibold">
        <ChevronRight className={cn("h-4 w-4 transition-transform", aberto && "rotate-90")} />
        <Send className="h-4 w-4 text-[#FF9900]" /> Envios criados na Amazon pelo app (30 dias)
        <span className="text-muted-foreground font-normal">· {planos.length}</span>
        {comErro > 0 && <Badge variant="secondary" className={cn("h-5 px-1.5 text-[10.5px]", corPasso("erro"))}>{comErro} com erro</Badge>}
        {parados > 0 && <Badge variant="secondary" className="h-5 px-1.5 text-[10.5px] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{parados} no meio</Badge>}
        <span className="ml-auto text-[11.5px] font-normal text-muted-foreground">{aberto ? "recolher" : "ver"}</span>
      </button>
      {aberto && <div className="flex flex-wrap gap-2">
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
      </div>}
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
  const [prontoEm, setProntoEm] = useState<string>(() => new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  const [transp, setTransp] = useState<Record<string, string>>({});
  const [confirmarTransp, setConfirmarTransp] = useState(false);
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

  async function cotarTransporte() {
    if (!planoRef) return;
    setRodando("Cotando o transporte na Amazon…");
    try {
      const r: Resposta = await chamar({ modulo: "transporte", plano: planoRef, pronto_em: prontoEm });
      pronto(r); atualizarLista(); setTransp({});
      if (r.ok === false) toast.error(r.erro ?? "A Amazon recusou");
      else if (r.plano?.passo === "erro") toast.error("A Amazon recusou", { description: r.plano.erro ?? undefined });
    } catch (e) { toast.error("Falha na Amazon", { description: (e as Error).message }); } finally { setRodando(null); }
  }
  async function confirmarTransporte() {
    if (!planoRef) return;
    setRodando("Confirmando o transporte na Amazon…");
    try {
      const r: Resposta = await chamar({ modulo: "confirmar-transporte", plano: planoRef, escolhas: transp, confirmar: true });
      pronto(r); atualizarLista();
      if (r.ok === false) toast.error(r.erro ?? "A Amazon recusou");
      else if (r.plano?.passo === "transporte_confirmado") { toast.success("Transporte confirmado: criando o envio na aba Envios…"); await criarEnviosApp(); }
      else if (r.plano?.passo === "erro") toast.error("A Amazon recusou", { description: r.plano.erro ?? undefined });
    } catch (e) { toast.error("Falha na Amazon", { description: (e as Error).message }); } finally { setRodando(null); }
  }
  /** A mesma escolha (mesmo tipo e mesma data de coleta) em todos os envios do plano. */
  function escolherEmTodos(o: OpcaoTransporte) {
    const k = chaveOpcao(o);
    const novo: Record<string, string> = {};
    for (const e of plano?.envios_amazon ?? []) {
      const igual = (e.transporte_opcoes ?? []).find((x) => chaveOpcao(x) === k);
      if (igual) novo[e.id] = igual.id;
    }
    setTransp(novo);
  }
  // envio na aba Envios: automático ao chegar em "transporte confirmado" (1× por janela); o botão refaz
  const [enviosApp, setEnviosApp] = useState<EnvioApp[] | null>(null);
  const tentouEnvios = useRef(false);
  async function criarEnviosApp() {
    if (!planoRef) return;
    tentouEnvios.current = true;
    setRodando("Criando o envio na aba Envios e baixando as etiquetas…");
    try {
      let r: Resposta & { envios_app?: EnvioApp[]; faltam?: number } = await chamar({ modulo: "envios-app", plano: planoRef });
      for (let i = 0; i < 3 && (r.faltam ?? 0) > 0; i++) r = await chamar({ modulo: "envios-app", plano: planoRef });
      if (r.plano) pronto(r);
      setEnviosApp(r.envios_app ?? []);
      void qc.invalidateQueries({ queryKey: ["fulfillment", "envios"] });
      void qc.invalidateQueries({ queryKey: ["fulfillment", "envios-progresso"] });
      if (r.ok === false) toast.error("Envio na aba Envios: algo falhou", { description: r.erro ?? (r.envios_app ?? []).map((e) => e.erro).filter(Boolean).join(" · ") });
      else toast.success("Envio criado na aba Envios, com as etiquetas");
    } catch (e) { toast.error("Falha ao criar o envio na aba Envios", { description: (e as Error).message }); } finally { setRodando(null); }
  }
  // NF de remessa: o cron importa sozinho (amazon-inbound nf-remessa, a cada 10 min); o botão tenta agora
  async function buscarNf() {
    if (!planoRef) return;
    setRodando("Buscando a NF de remessa na Amazon…");
    try {
      const r = (await chamar({ modulo: "nf-remessa", plano: planoRef })) as Resposta & { resultado?: { fba: string; nf?: NfRemessa; pendente?: string; erro?: string }[] };
      const res = r.resultado ?? [];
      const ok = res.filter((x) => x.nf);
      if (ok.length) toast.success(`NF de remessa importada: ${ok.map((x) => `${x.fba} nº ${x.nf?.numero}`).join(" · ")}`, { description: "XML anexado no envio da aba Envios." });
      const falta = res.filter((x) => !x.nf);
      if (falta.length) toast.message("NF ainda não veio", { description: falta.map((x) => `${x.fba}: ${x.pendente ?? x.erro}`).join(" · ") });
      if (!res.length) toast.message("Nenhuma NF a buscar neste plano");
      pronto(await chamar({ modulo: "previa", plano: planoRef }));
      void qc.invalidateQueries({ queryKey: ["fulfillment", "envios"] });
    } catch (e) { toast.error("Falha ao buscar a NF", { description: (e as Error).message }); } finally { setRodando(null); }
  }
  const faltaEnvioApp = plano?.passo === "transporte_confirmado" && (plano.envios_amazon ?? []).some((e) => !e.envio_app_id);
  useEffect(() => {
    if (faltaEnvioApp && !tentouEnvios.current && !rodando) void criarEnviosApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faltaEnvioApp]);
  const enviosTransp = plano?.envios_amazon ?? [];
  const transpCompleto = enviosTransp.length > 0 && enviosTransp.every((e) => transp[e.id]);

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
            O app cria o plano na Amazon com as caixas dos modelos; você escolhe o centro de destino e o transporte aqui. Depois:
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
              Como o destino foi confirmado pelo app, a Amazon exige que o <b>transporte também seja escolhido aqui</b> (no Seller Central a
              etapa 2 fica travada). Informe o dia em que a carga fica pronta e cote.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-[12.5px]">Pronta para sair em</label>
              <input type="date" className="h-8 rounded-md border bg-card px-2 text-[12.5px]" value={prontoEm} min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setProntoEm(e.target.value)} />
              <Button size="sm" className="gap-1.5" disabled={!!rodando} onClick={() => void cotarTransporte()}>
                <Send className="h-4 w-4" /> Cotar transporte
              </Button>
            </div>
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

        {plano?.passo === "escolher_transporte" && (
          <div className="space-y-3 text-sm">
            <p>
              Escolha o transporte de cada envio. A <b>coleta da parceira da Amazon</b> busca em Caieiras no dia escolhido (9h–18h); nas opções
              "por nossa conta" vocês levam ou contratam. "em todos" aplica a mesma escolha nos {enviosTransp.length} envios.
            </p>
            {enviosTransp.map((e) => {
              const ops = [...(e.transporte_opcoes ?? [])].sort((a, b) => chaveOpcao(a).localeCompare(chaveOpcao(b)));
              const parceiro = ops.filter((o) => o.solucao === "AMAZON_PARTNERED_CARRIER");
              const proprio = ops.filter((o) => o.solucao !== "AMAZON_PARTNERED_CARRIER");
              const botao = (o: OpcaoTransporte) => (
                <div key={o.id} className={cn("flex items-center gap-1 rounded-md border pr-1 text-[12px]", transp[e.id] === o.id ? "border-primary ring-2 ring-primary/30" : "")}>
                  <button type="button" className="rounded-l-md px-2 py-1.5 text-left hover:bg-accent/40" onClick={() => setTransp((x) => ({ ...x, [e.id]: o.id }))}>
                    {rotuloOpcao(o)}{o.precondicoes.length ? ` · exige ${o.precondicoes.join(", ")}` : ""}
                  </button>
                  {enviosTransp.length > 1 && (
                    <button type="button" className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground" title="Mesma escolha em todos os envios" onClick={() => escolherEmTodos(o)}>em todos</button>
                  )}
                </div>
              );
              return (
                <div key={e.id} className="space-y-1.5 rounded-md border p-2.5">
                  <div className="font-medium">{e.fba ?? e.id} → {e.cd ?? "?"}</div>
                  {parceiro.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Coleta da parceira da Amazon</div>
                      <div className="flex flex-wrap gap-1.5">{parceiro.map(botao)}</div>
                    </div>
                  )}
                  {proprio.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Por nossa conta</div>
                      <div className="flex flex-wrap gap-1.5">{proprio.map(botao)}</div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button className="gap-1.5" disabled={!transpCompleto || !!rodando} onClick={() => setConfirmarTransp(true)}>
                <CheckCircle2 className="h-4 w-4" /> Confirmar transporte
              </Button>
              <Button variant="outline" size="sm" disabled={!!rodando} onClick={() => void cotarTransporte()}>Cotar de novo</Button>
            </div>
          </div>
        )}

        {plano?.passo === "transporte_confirmado" && (
          <div className="space-y-2 text-sm">
            <div className="rounded-md border border-emerald-300/60 bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
              <CheckCircle2 className="mr-1 inline h-4 w-4" /> Transporte confirmado:{" "}
              {enviosTransp.map((e) => {
                const o = (e.transporte_opcoes ?? []).find((x) => x.id === e.transporte_escolhido);
                return `${e.fba ?? e.id} → ${e.cd ?? "?"}${o ? ` (${rotuloOpcao(o)})` : ""}`;
              }).join(" · ")}
              {enviosTransp.some((e) => (e.transporte_opcoes ?? []).find((x) => x.id === e.transporte_escolhido)?.solucao === "AMAZON_PARTNERED_CARRIER") && (
                <div className="mt-1 text-[12px] text-emerald-800/90 dark:text-emerald-300/90">
                  A data é a escolhida no plano, não a coleta reservada: o horário da coleta é reservado no Seller Central
                  ("Reservar agendamento da transportadora"), e o dia pode estar esgotado lá.
                </div>
              )}
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="mb-1 font-medium">Aba Envios</div>
              {enviosTransp.map((e) => {
                const r = enviosApp?.find((x) => x.fba === e.fba);
                return (
                  <div key={e.id} className="text-[12.5px]">
                    {e.envio_app_id || r?.envio_id ? <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-amber-600" />}
                    <b>{e.fba}</b> → {e.cd ?? "?"}: {e.envio_app_id || r?.envio_id ? "criado na aba Envios" : r?.erro ? `não criado — ${r.erro}` : "ainda não criado"}
                    {r && (r.doc_caixas || r.doc_produto) ? ` · etiquetas: ${[r.doc_caixas ? "caixas" : null, r.doc_produto ? "produto" : null].filter(Boolean).join(" e ")}` : ""}
                    {r?.avisos?.length ? <span className="text-amber-700"> · {r.avisos.join(" · ")}</span> : null}
                    {(e.envio_app_id || r?.envio_id) && (
                      <div className="ml-5 text-[12px] text-muted-foreground">
                        {e.nf ? (
                          <span className="text-emerald-700 dark:text-emerald-400">
                            NF de remessa nº {e.nf.numero} série {e.nf.serie}
                            {e.nf.valor != null ? ` · ${formatBRL(e.nf.valor)}` : ""} · {e.nf.danfe ? "XML e DANFE (PDF) anexados no envio" : "XML anexado no envio"}
                            {e.nf.danfe_erro ? <span className="text-amber-700"> · DANFE não gerado: {e.nf.danfe_erro}</span> : null}
                          </span>
                        ) : (
                          <>NF de remessa: ainda não importada{e.nf_erro ? ` (${e.nf_erro})` : ""}</>
                        )}
                        {e.coleta && (
                          <div className="text-foreground">
                            Coleta na Amazon{e.coleta.transportadora ? ` (${e.coleta.transportadora})` : ""}: <b>{dataHora(e.coleta.inicio)}</b>
                            {` · ${horaBRT(e.coleta.inicio)}${e.coleta.fim ? `–${horaBRT(e.coleta.fim)}` : ""}`}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="mt-2 flex flex-wrap gap-2">
                {faltaEnvioApp && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => void criarEnviosApp()}>
                    <PackagePlus className="h-4 w-4" /> Criar na aba Envios
                  </Button>
                )}
                {!faltaEnvioApp && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => void criarEnviosApp()}
                    title="Refaz só o que faltar (não duplica envio nem etiqueta)">
                    <RefreshCw className="h-4 w-4" /> Conferir etiquetas de novo
                  </Button>
                )}
                {!faltaEnvioApp && enviosTransp.some((e) => !e.nf) && (
                  <Button size="sm" variant="outline" className="gap-1.5" disabled={!!rodando} onClick={() => void buscarNf()}
                    title="A Amazon libera uma consulta por minuto: se vier 'esperar', tente de novo daqui a pouco">
                    <RefreshCw className="h-4 w-4" /> Buscar NF agora
                  </Button>
                )}
              </div>
            </div>
            <p className="text-muted-foreground">
              Falta no Seller Central (etapa 3): gerar a <b>nota fiscal de remessa</b> e reservar o horário da coleta. Gerada a NF, o
              app importa o XML sozinho (a cada 10 min) e anexa no envio da aba Envios. As etiquetas das caixas e de produto já vão
              anexadas pelo app.
            </p>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={`https://sellercentral.amazon.com.br/fba/sendtoamazon?wf=${plano.plano_id}`} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Continuar no Seller Central
              </a>
            </Button>
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

        <AlertDialog open={confirmarTransp} onOpenChange={setConfirmarTransp}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmar o transporte na Amazon?</AlertDialogTitle>
              <AlertDialogDescription>
                {enviosTransp.map((e) => {
                  const o = (e.transporte_opcoes ?? []).find((x) => x.id === transp[e.id]);
                  return `${e.fba ?? e.id}: ${o ? rotuloOpcao(o) : "—"}`;
                }).join(" · ")}. Depois de confirmado, o envio segue para a nota fiscal e a reserva do horário da coleta no Seller Central (a data escolhida aqui pode estar esgotada lá).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Voltar</AlertDialogCancel>
              <AlertDialogAction onClick={() => void confirmarTransporte()}>Confirmar transporte</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmarCancelar} onOpenChange={setConfirmarCancelar}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancelar o plano na Amazon?</AlertDialogTitle>
              <AlertDialogDescription>
                O plano {plano?.plano_id} é cancelado na Amazon e não volta.
                {["destino_confirmado", "escolher_transporte"].includes(plano?.passo ?? "") ? " O destino já foi confirmado: a Amazon pode cobrar pelo cancelamento." : ""}
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
