// Marcações de teste A/B por anúncio (13/nov/2026, pedido do dono — teste "Areia Ottz Pet Mandioca - nov/2026").
// 16/nov: as tarefas tipo 'api' são aplicadas na Shopee pelo botão "Enviar à Shopee" (edge fn no slot tiny-scope-probe,
// fonte supabase/functions/shopee-teste-ab: prévia ao vivo → confirmação → uma chamada por tarefa, relê e confere);
// "Desfazer o braço" volta tudo pelo histórico (anuncio_teste_log). As tarefas 'manual' seguem com a caixa de marcar.
// Banco: anuncio_marcacao + view_anuncio_marcacao + anuncio_marcacao_conferir() (docs/anuncio-marcacao.sql) e
// anuncio_teste_log + reverter_braco_teste() (docs/anuncio-teste-aplicar.sql). Usado em /ads-shopee e em /ia/anuncios.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, FlaskConical, Loader2, RefreshCw, Ban, Send, Undo2, History, PencilLine, ChevronDown } from "lucide-react";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { atualizarCatalogoShopee } from "@/components/promocoes/comum";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type TarefaAval = {
  id: string; texto: string; campo: "preco" | "roas" | "status_campanha" | "titulo" | "criar_campanha" | null; tipo?: "api" | "manual";
  de?: number | string | null; para?: number | string | null; campanha?: string; sku?: string;
  confere_auto?: boolean; feito?: boolean; feito_em?: string; feito_por?: string;
  atual?: string | null; bate?: boolean | null; lido_em?: string | null;
};
export type Marcacao = {
  id: number; shop_id: number; item_id: string | null; teste: string; braco: string; rotulo: string | null;
  estrategia: string; instrucao: string | null; tarefas: TarefaAval[]; tarefas_aval: TarefaAval[];
  preco_planejado: Record<string, number> | null; roas_alvo_planejado: number | null; ads_ligado: boolean | null;
  titulo_planejado: string | null; regra_parada: string | null; data_leitura: string | null;
  status: "pendente" | "em_andamento" | "aplicado" | "nao_mexer" | "divergente" | "revertido"; aplicado_em: string | null; sku_pai: string | null;
  atualizado_em: string; atualizado_por: string | null;
  nome_atual: string | null; foto: string | null; loja: string; n_tarefas: number; n_feitas: number; pendente: boolean;
  // 19/nov: editor de anúncio (/ia/gerar) — SKU de onde o braço nasce (sku_planejado, senão o do anúncio), empresa da loja e rascunho
  sku_editor: string | null; empresa_editor: "ottz" | "svl"; rascunho_id: string | null;
};

/** Busca do /ia/gerar para o braço: rascunho certo; anúncio já criado abre no modo atualizar (item). */
export function buscaEditor(m: Marcacao) {
  if (!m.sku_editor) return null;
  return { sku: m.sku_editor, canal: "shopee", empresa: m.empresa_editor, r: m.rascunho_id ?? undefined, item: m.item_id ?? undefined };
}

const chave = (shop: number | string | null | undefined, item: number | string | null | undefined) => `${shop}:${item}`;

export function useMarcacoes() {
  return useQuery({
    queryKey: ["anuncio-marcacao"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_anuncio_marcacao" as never).select("*").order("id");
      if (error) throw error;
      const lista = (data ?? []) as unknown as Marcacao[];
      const porItem = new Map<string, Marcacao[]>();
      const porSku = new Map<string, Marcacao[]>();
      for (const m of lista) {
        if (m.item_id) porItem.set(chave(m.shop_id, m.item_id), [...(porItem.get(chave(m.shop_id, m.item_id)) ?? []), m]);
        if (m.sku_pai) porSku.set(m.sku_pai, [...(porSku.get(m.sku_pai) ?? []), m]);
      }
      return { lista, porItem, porSku };
    },
  });
}
export function marcacoesDoItem(mapa: Map<string, Marcacao[]> | undefined, shop: number | string | null | undefined, item: number | string | null | undefined) {
  if (!mapa || shop == null || item == null) return [];
  return mapa.get(chave(shop, item)) ?? [];
}

// cor por braço: controle cinza, T1 roxo, T2 azul, T3 âmbar
function corBraco(m: Marcacao) {
  if (m.status === "nao_mexer") return { fg: "#475569", bg: "#F1F5F9", bd: "#CBD5E1" };
  if (m.braco.startsWith("T1")) return { fg: "#5B3FC4", bg: "#F1EDFF", bd: "#C9BCF7" };
  if (m.braco.startsWith("T2")) return { fg: "#1D5FBF", bg: "#EAF2FF", bd: "#B5CDF3" };
  if (m.braco.startsWith("T3")) return { fg: "#9A5A00", bg: "#FFF4E0", bd: "#F1D19A" };
  return { fg: "#334155", bg: "#F8FAFC", bd: "#CBD5E1" };
}
const ROT_STATUS: Record<Marcacao["status"], string> = { pendente: "pendente", em_andamento: "em andamento", aplicado: "aplicado", nao_mexer: "não mexer", divergente: "divergente", revertido: "revertido" };

// edge fn do teste (slot tiny-scope-probe): previa (leitura), aplicar e reverter (sessão com módulo 'ads')
export async function chamarTesteAb(modulo: "previa" | "aplicar" | "reverter", corpo?: Record<string, unknown>): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiny-scope-probe?modulo=${modulo}`, {
    method: modulo === "previa" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: modulo === "previa" ? undefined : JSON.stringify(corpo ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}
export type LogTeste = {
  id: number; braco: string; tarefa_id: string | null; acao: string; de: unknown; para: unknown; ok: boolean | null; conferido: boolean | null;
  valor_relido: unknown; erro: string | null; quem: string | null; revertido_em: string | null; criado_em: string; campaign_id: string | null;
};
export function useHistoricoTeste(teste: string | undefined) {
  return useQuery({
    queryKey: ["anuncio-teste-log", teste],
    enabled: !!teste,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("anuncio_teste_log" as never).select("id, braco, tarefa_id, acao, de, para, ok, conferido, valor_relido, erro, quem, revertido_em, criado_em, campaign_id")
        .eq("teste", teste!).order("criado_em", { ascending: false }).limit(300);
      if (error) throw error;
      return (data ?? []) as unknown as LogTeste[];
    },
  });
}
export function marcacoesDoSku(mapa: Map<string, Marcacao[]> | undefined, sku: string | null | undefined) {
  if (!mapa || !sku) return [];
  return mapa.get(sku) ?? [];
}
const ROT_ACAO: Record<string, string> = {
  preco: "preço de venda", roas: "ROAS alvo", pausar: "pausar campanha", titulo: "título", criar_campanha: "criar campanha manual",
  relampago_programacao: "tirar da relâmpago (programação)", relampago_remover: "tirar da relâmpago de hoje",
};
function txtValor(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (typeof v === "string") return v === "paused" ? "pausada" : v === "ongoing" ? "rodando" : v === "resume" ? "retomar" : v;
  const o = v as Record<string, unknown>;
  if (o.preco != null) return Number(o.preco).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (o.campanha) return `campanha ${o.campanha}`;
  if (o.ativo != null) return o.ativo ? "na relâmpago" : "fora da relâmpago";
  if (o.status) return String(o.status);
  return JSON.stringify(v).slice(0, 80);
}

/** Enviar à Shopee (prévia → confirmação → aplicar) e desfazer o braço. */
function AcoesShopee({ m }: { m: Marcacao }) {
  const qc = useQueryClient();
  const [ocupado, setOcupado] = useState<string | null>(null);
  const apiPend = (m.tarefas ?? []).filter((t) => t.tipo === "api" && !t.feito).length;
  const temApi = (m.tarefas ?? []).some((t) => t.tipo === "api");
  if (!temApi || m.status === "nao_mexer" || !m.item_id) return null;
  const recarregar = () => { void qc.invalidateQueries({ queryKey: ["anuncio-marcacao"] }); void qc.invalidateQueries({ queryKey: ["anuncio-teste-log"] }); };

  async function enviar() {
    setOcupado("enviar");
    try {
      const pv = await chamarTesteAb("previa");
      const linhas = ((pv.linhas ?? []) as any[]).filter((l) => l.braco === m.braco);
      const texto = linhas.map((l) => `• ${l.campo}: ${txtValor(l.atual)} → ${txtValor(l.novo)}`).join("\n");
      if (!window.confirm(`Enviar à Shopee — ${m.braco} (${m.loja}, item ${m.item_id})\n\nLido agora na Shopee:\n${texto}\n\nSó vão as tarefas pela API ainda não feitas; cada uma vai uma vez e é conferida depois. Confirmar?`)) return;
      const r = await chamarTesteAb("aplicar", { bracos: [m.braco] });
      const res = ((r.resultados ?? []) as any[]);
      const ruins = res.filter((x) => !x.ok || x.conferido === false);
      if (ruins.length) toast.error(`${m.braco}: ${ruins.length} alteração(ões) não conferiram — ${ruins.map((x) => `${ROT_ACAO[x.acao] ?? x.acao}: ${x.erro ?? "valor não bateu"}`).join("; ")}`, { duration: 15000 });
      else toast.success(`${m.braco}: ${res.length} alteração(ões) aplicadas e conferidas na Shopee.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setOcupado(null); recarregar(); }
  }
  async function desfazer() {
    setOcupado("desfazer");
    try {
      const pv = await chamarTesteAb("reverter", { braco: m.braco, confirmar: false });
      const plano = ((pv.plano ?? []) as any[]);
      if (!plano.length) { toast.info("Nada a desfazer neste braço."); return; }
      const texto = plano.map((p) => `• ${ROT_ACAO[p.acao] ?? p.acao}: volta para ${txtValor(p.volta_para)}`).join("\n");
      if (!window.confirm(`Desfazer o braço ${m.braco} na Shopee?\n\n${texto}\n\n${pv.aviso ?? ""}`)) return;
      const r = await chamarTesteAb("reverter", { braco: m.braco, confirmar: true });
      if (r.ok) toast.success(`${m.braco} desfeito na Shopee.`); else toast.error(`${m.braco}: parte não voltou — veja o histórico.`);
    } catch (e) { toast.error((e as Error).message); }
    finally { setOcupado(null); recarregar(); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {m.status !== "revertido" && apiPend > 0 && (
        <Button size="sm" className="h-8 text-xs" disabled={!!ocupado} onClick={enviar}>
          {ocupado === "enviar" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Send className="h-3.5 w-3.5 mr-1" />}
          Enviar à Shopee ({apiPend} pela API)
        </Button>
      )}
      {m.status !== "revertido" && m.n_feitas > 0 && (
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!!ocupado} onClick={desfazer}>
          {ocupado === "desfazer" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Undo2 className="h-3.5 w-3.5 mr-1" />}
          Desfazer o braço
        </Button>
      )}
      {m.status === "divergente" && <span className="text-[11px] text-red-700">uma alteração não conferiu — veja o histórico abaixo</span>}
    </div>
  );
}

/** Histórico de mudanças do braço (o que o sistema enviou, de → para, se conferiu). */
export function HistoricoBraco({ m, compacto }: { m: Marcacao; compacto?: boolean }) {
  const q = useHistoricoTeste(m.teste);
  const linhas = (q.data ?? []).filter((l) => l.braco === m.braco);
  if (!linhas.length) return null;
  return (
    <details className="rounded-md border bg-card" open={!compacto}>
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-medium flex items-center gap-1.5"><History className="h-3.5 w-3.5" /> Histórico de mudanças ({linhas.length})</summary>
      <div className="divide-y">
        {linhas.map((l) => (
          <div key={l.id} className="px-2 py-1.5 text-[11.5px] flex flex-wrap items-baseline gap-x-2">
            <span className="text-muted-foreground tabular-nums">{dmh(l.criado_em)}</span>
            <b>{l.acao.startsWith("reverter:") ? `desfeito · ${ROT_ACAO[l.acao.slice(9)] ?? l.acao.slice(9)}` : ROT_ACAO[l.acao] ?? l.acao}</b>
            <span>{txtValor(l.de)} → {txtValor(l.para)}</span>
            {l.ok === false ? <span className="text-red-700">falhou{l.erro ? `: ${l.erro}` : ""}</span>
              : l.conferido === false ? <span className="text-red-700">não conferiu (relido {txtValor(l.valor_relido)})</span>
              : l.conferido ? <span className="text-emerald-700">conferido na Shopee</span> : <span className="text-muted-foreground">enviado</span>}
            {l.revertido_em && <span className="text-amber-700">desfeito em {dmh(l.revertido_em)}</span>}
            {l.quem && <span className="text-muted-foreground">· {l.quem}</span>}
          </div>
        ))}
      </div>
    </details>
  );
}
const dm = (iso: string | null | undefined) => (iso ? new Date(iso + (iso.length === 10 ? "T12:00:00" : "")).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : "—");
const dmh = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

function fmtValor(campo: TarefaAval["campo"], v: unknown) {
  if (v == null || v === "") return "—";
  if (campo === "preco") return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  if (campo === "roas") return Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  if (campo === "status_campanha") return v === "paused" ? "pausada" : v === "ongoing" ? "rodando" : v === "ended" || v === "closed" ? "encerrada" : String(v);
  return String(v);
}

export function EtiquetaMarcacao({ m, onClick }: { m: Marcacao; onClick?: () => void }) {
  const c = corBraco(m);
  const texto = m.status === "nao_mexer" ? "Controle · Não mexer" : `${m.braco} · ${m.estrategia}`;
  return (
    <button type="button" onClick={onClick}
      title={`${m.teste}${m.rotulo ? ` · ${m.rotulo}` : ""} — ${ROT_STATUS[m.status]}${m.n_tarefas ? ` (${m.n_feitas}/${m.n_tarefas} tarefas)` : ""}${m.data_leitura ? ` · leitura em ${dm(m.data_leitura)}` : ""}`}
      className="inline-flex items-center gap-1 rounded-md border px-1.5 text-[10.5px] leading-[18px] font-medium max-w-full"
      style={{ color: c.fg, background: c.bg, borderColor: c.bd }}>
      {m.status === "nao_mexer" ? <Ban className="h-3 w-3 shrink-0" /> : <FlaskConical className="h-3 w-3 shrink-0" />}
      <span className="truncate">{texto}</span>
      {m.status !== "nao_mexer" && m.n_tarefas > 0 && (
        <span className="tabular-nums opacity-80">{m.status === "aplicado" ? "✓" : `${m.n_feitas}/${m.n_tarefas}`}</span>
      )}
    </button>
  );
}

// "O que fazer": tarefas com atual × planejado. Tarefa automática só fica feita pela conferência; manual = caixa.
export function BlocoOQueFazer({ m, compacto }: { m: Marcacao; compacto?: boolean }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [salvando, setSalvando] = useState<string | null>(null);
  const [itemDigitado, setItemDigitado] = useState("");
  const c = corBraco(m);

  async function marcarManual(t: TarefaAval, feito: boolean) {
    setSalvando(t.id);
    const tarefas = m.tarefas.map((x) => x.id !== t.id ? x
      : feito ? { ...x, feito: true, feito_em: new Date().toISOString(), feito_por: perfil?.nome ?? "—" }
      : { ...x, feito: false, feito_em: undefined, feito_por: undefined });
    const { error } = await supabaseExternal.from("anuncio_marcacao" as never)
      .update({ tarefas, atualizado_por: perfil?.nome ?? null } as never).eq("id", m.id);
    setSalvando(null);
    if (error) return toast.error(error.message);
    void qc.invalidateQueries({ queryKey: ["anuncio-marcacao"] });
  }
  async function salvarItem() {
    const id = itemDigitado.replace(/\D/g, "");
    if (id.length < 6) return toast.error("Cole o ID do anúncio da Shopee (só números).");
    setSalvando("item");
    const { error } = await supabaseExternal.from("anuncio_marcacao" as never)
      .update({ item_id: id, atualizado_por: perfil?.nome ?? null } as never).eq("id", m.id);
    setSalvando(null);
    if (error) return toast.error(error.message);
    toast.success(`Anúncio ${id} ligado ao ${m.braco}.`);
    void qc.invalidateQueries({ queryKey: ["anuncio-marcacao"] });
  }

  return (
    <div className="rounded-lg border p-3 space-y-2.5" style={{ borderColor: c.bd }}>
      <div className="flex flex-wrap items-center gap-2">
        <EtiquetaMarcacao m={m} />
        <span className="text-xs text-muted-foreground">{m.loja}{m.rotulo ? ` · ${m.rotulo}` : ""} · {ROT_STATUS[m.status]}
          {m.status === "aplicado" && m.aplicado_em ? ` em ${dmh(m.aplicado_em)}` : ""}
          {m.data_leitura ? ` · leitura do resultado em ${dm(m.data_leitura)}` : ""}</span>
      </div>
      {!compacto && <div className="text-[11px] text-muted-foreground">{m.teste}</div>}
      {m.instrucao && <div className="text-xs">{m.instrucao}</div>}

      {!m.item_id && m.status !== "nao_mexer" && (
        <div className="rounded-md bg-amber-50 border border-amber-200 p-2.5 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-amber-900">Anúncio a criar</div>
            {buscaEditor(m) && (
              <Button asChild size="sm" className="h-7 text-xs">
                <Link to="/ia/gerar" search={buscaEditor(m)!}><PencilLine className="h-3.5 w-3.5 mr-1" />Criar anúncio no editor</Link>
              </Button>
            )}
          </div>
          {m.titulo_planejado && <div className="text-xs">Título: <b>{m.titulo_planejado}</b></div>}
          {m.preco_planejado && (
            <div className="text-xs">Preços: {Object.entries(m.preco_planejado).map(([k, v]) => `${k} ${fmtValor("preco", v)}`).join(" · ")}</div>
          )}
          {m.ads_ligado === false && <div className="text-xs">Sem ADS.</div>}
          <div className="flex items-center gap-2 pt-0.5">
            <Input className="h-8 text-xs max-w-[220px]" placeholder="ID do anúncio depois de publicar" value={itemDigitado}
              onChange={(e) => setItemDigitado(e.target.value)} />
            <Button size="sm" className="h-8 text-xs" disabled={salvando === "item"} onClick={salvarItem}>
              {salvando === "item" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Ligar o anúncio"}
            </Button>
          </div>
        </div>
      )}

      {m.status === "nao_mexer" ? (
        <div className="text-xs font-medium text-slate-600">Grupo de controle: não alterar preço, título nem campanha.</div>
      ) : (
        <div className="space-y-1.5">
          {(m.tarefas_aval ?? []).map((t) => {
            const auto = !!t.confere_auto;
            return (
              <div key={t.id} className={cn("flex items-start gap-2 rounded-md px-2 py-1.5", t.feito ? "bg-emerald-50" : "bg-muted/40")}>
                {auto ? (
                  t.feito ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" /> : <Circle className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                ) : (
                  <input type="checkbox" className="mt-1 shrink-0" checked={!!t.feito} disabled={salvando === t.id}
                    onChange={(e) => void marcarManual(t, e.target.checked)} />
                )}
                <div className="min-w-0 flex-1 text-xs">
                  <div className={cn(t.feito && "text-emerald-900")}>
                    {t.tipo && <span className={cn("mr-1.5 rounded px-1 text-[10px] font-semibold uppercase", t.tipo === "api" ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700")}>{t.tipo === "api" ? "API" : "manual"}</span>}
                    {t.texto}
                  </div>
                  {auto && t.campo && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      hoje <b className={cn(t.bate ? "text-emerald-700" : "text-foreground")}>{fmtValor(t.campo, t.atual)}</b>
                      {" → "}planejado <b>{fmtValor(t.campo, t.para)}</b>
                      {t.lido_em && <> · lido {dmh(t.lido_em)}</>}
                      {!t.feito && t.bate && <> · <span className="text-emerald-700">bate — marca na próxima conferência</span></>}
                      {!t.feito && !t.bate && <> · confere sozinho quando o valor real mudar</>}
                    </div>
                  )}
                  {t.feito && <div className="text-[11px] text-emerald-800">feito {dmh(t.feito_em)}{t.feito_por ? ` · ${t.feito_por}` : ""}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AcoesShopee m={m} />
      {m.regra_parada && <div className="text-xs rounded-md bg-red-50 border border-red-200 px-2 py-1.5 text-red-900"><b>Regra de parada:</b> {m.regra_parada}</div>}
      <HistoricoBraco m={m} compacto={compacto} />
    </div>
  );
}

// Painel acima da lista de anúncios: os anúncios do teste, filtro por teste e "Com ação pendente", conferir agora.
export function PainelTestesAB() {
  const q = useMarcacoes();
  const qc = useQueryClient();
  const [teste, setTeste] = useState<string>("");
  const [soPendente, setSoPendente] = useState(true);
  const [aberto, setAberto] = useState<number | null>(null);
  const [conferindo, setConferindo] = useState(false);
  const lista = q.data?.lista ?? [];
  const testes = useMemo(() => [...new Set(lista.map((m) => m.teste))], [lista]);
  const vistos = lista.filter((m) => (!teste || m.teste === teste) && (!soPendente || m.pendente || m.status === "divergente"));
  const nPend = lista.filter((m) => (!teste || m.teste === teste) && (m.pendente || m.status === "divergente")).length;

  async function conferirAgora() {
    setConferindo(true);
    try {
      const porLoja = new Map<number, number[]>();
      for (const m of lista) if (m.item_id && m.status !== "nao_mexer") porLoja.set(m.shop_id, [...(porLoja.get(m.shop_id) ?? []), Number(m.item_id)]);
      const avisos: string[] = [];
      for (const [shop, itens] of porLoja) {
        try { const r = await atualizarCatalogoShopee(shop, itens); avisos.push(...r.erros); } catch (e) { avisos.push((e as Error).message); }
        const loja = shop === 759046323 ? "svl" : "ottz";
        const { error } = await supabaseExternal.functions.invoke("shopee-flashsale-probe", { body: { modulo: "capturar", loja } });
        if (error) avisos.push(`ADS ${loja}: ${error.message}`);
      }
      const { data, error } = await supabaseExternal.rpc("anuncio_marcacao_conferir" as never);
      if (error) throw error;
      const n = Number((data as { marcadas?: number } | null)?.marcadas ?? 0);
      toast.success(n ? `${n} tarefa(s) conferida(s) e marcada(s).` : "Conferido: nenhuma tarefa nova bateu com o real.");
      if (avisos.length) toast.warning(avisos.slice(0, 3).join(" · "));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setConferindo(false);
      void qc.invalidateQueries({ queryKey: ["anuncio-marcacao"] });
    }
  }

  if (q.isLoading || lista.length === 0) return null;
  return (
    <Card className="p-3 md:p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-[14.5px] font-semibold tracking-[-0.015em] flex items-center gap-1.5"><FlaskConical className="h-4 w-4 text-primary" /> Testes A/B</span>
          <span className="text-[12px] text-muted-foreground">
            "Enviar à Shopee" aplica pela API o que tem endpoint (preço na promoção, ROAS, pausar/criar campanha, título) e confere na hora; o resto fica como tarefa manual. Cada braço tem o histórico de mudanças e o botão de desfazer.
          </span>
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={conferindo} onClick={conferirAgora}>
          {conferindo ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />} Conferir agora
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <select className="h-7 rounded-md border bg-card px-2 text-xs" value={teste} onChange={(e) => setTeste(e.target.value)}>
          <option value="">Todos os testes</option>
          {testes.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <Button size="sm" variant={soPendente ? "default" : "outline"} className="h-7 text-xs" onClick={() => setSoPendente((v) => !v)}>
          Com ação pendente <span className="ml-1 tabular-nums opacity-80">{nPend}</span>
        </Button>
        {soPendente && <span className="text-[11px] text-muted-foreground">desligue para ver também os aplicados e os de controle</span>}
      </div>
      {vistos.length === 0 ? (
        <div className="text-xs text-muted-foreground">Nada pendente neste teste.</div>
      ) : (
        <div className="divide-y rounded-md border">
          {vistos.map((m) => {
            const busca = buscaEditor(m);
            const aCriar = !m.item_id && m.status !== "nao_mexer";
            const conteudo = (
              <>
                {m.foto ? <img src={m.foto} alt="" className="h-9 w-9 rounded object-cover shrink-0" loading="lazy" />
                  : <div className="h-9 w-9 rounded bg-muted shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5"><EtiquetaMarcacao m={m} /><span className="text-[11px] text-muted-foreground">{m.loja}{m.rotulo ? ` · ${m.rotulo}` : ""}</span></div>
                  <div className="text-xs truncate mt-0.5">{m.nome_atual ?? (m.item_id ? `item ${m.item_id}` : aCriar && busca ? `anúncio ainda não criado — abre o rascunho do ${m.sku_editor} no editor` : "anúncio ainda não criado")}</div>
                </div>
              </>
            );
            return (
              <div key={m.id}>
                <div className="flex items-center gap-2 pr-2 hover:bg-muted/40">
                  {aCriar && busca ? (
                    // anúncio a criar: a linha abre direto a tela de edição de anúncio, no rascunho do braço
                    <Link to="/ia/gerar" search={busca} className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 text-left">{conteudo}</Link>
                  ) : (
                    <button type="button" onClick={() => setAberto(aberto === m.id ? null : m.id)} className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 text-left">{conteudo}</button>
                  )}
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">{m.item_id ?? "sem ID"}</span>
                  {busca && (
                    <Button asChild size="sm" variant={aCriar ? "default" : "outline"} className="h-7 text-xs">
                      <Link to="/ia/gerar" search={busca}><PencilLine className="h-3.5 w-3.5 mr-1" />{aCriar ? "Criar anúncio" : "Editar"}</Link>
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Tarefas do braço" onClick={() => setAberto(aberto === m.id ? null : m.id)}>
                    <ChevronDown className={cn("h-4 w-4 transition-transform", aberto === m.id && "rotate-180")} />
                  </Button>
                </div>
                {aberto === m.id && <div className="px-3 pb-3"><BlocoOQueFazer m={m} compacto /></div>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
