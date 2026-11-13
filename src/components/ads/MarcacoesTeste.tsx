// Marcações de teste A/B por anúncio (13/nov/2026, pedido do dono — teste "Areia Ottz Pet Mandioca - nov/2026").
// O painel SÓ marca e confere: nada aqui altera preço, título ou campanha na Shopee. As mudanças são feitas à mão
// no Seller Center; a conferência compara o valor real (espelho do catálogo e configuração de ADS) com o planejado.
// Banco: tabela anuncio_marcacao + view_anuncio_marcacao + anuncio_marcacao_conferir() (docs/anuncio-marcacao.sql).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Circle, FlaskConical, Loader2, RefreshCw, Ban } from "lucide-react";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { atualizarCatalogoShopee } from "@/components/promocoes/comum";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type TarefaAval = {
  id: string; texto: string; campo: "preco" | "roas" | "status_campanha" | "titulo" | null;
  de?: number | string | null; para?: number | string | null; campanha?: string; sku?: string;
  confere_auto?: boolean; feito?: boolean; feito_em?: string; feito_por?: string;
  atual?: string | null; bate?: boolean | null; lido_em?: string | null;
};
export type Marcacao = {
  id: number; shop_id: number; item_id: string | null; teste: string; braco: string; rotulo: string | null;
  estrategia: string; instrucao: string | null; tarefas: TarefaAval[]; tarefas_aval: TarefaAval[];
  preco_planejado: Record<string, number> | null; roas_alvo_planejado: number | null; ads_ligado: boolean | null;
  titulo_planejado: string | null; regra_parada: string | null; data_leitura: string | null;
  status: "pendente" | "em_andamento" | "aplicado" | "nao_mexer"; aplicado_em: string | null;
  atualizado_em: string; atualizado_por: string | null;
  nome_atual: string | null; foto: string | null; loja: string; n_tarefas: number; n_feitas: number; pendente: boolean;
};

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
      for (const m of lista) if (m.item_id) porItem.set(chave(m.shop_id, m.item_id), [...(porItem.get(chave(m.shop_id, m.item_id)) ?? []), m]);
      return { lista, porItem };
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
const ROT_STATUS: Record<Marcacao["status"], string> = { pendente: "pendente", em_andamento: "em andamento", aplicado: "aplicado", nao_mexer: "não mexer" };
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
          <div className="text-xs font-semibold text-amber-900">Anúncio a criar</div>
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
                  <div className={cn(t.feito && "text-emerald-900")}>{t.texto}</div>
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
      {m.regra_parada && <div className="text-xs rounded-md bg-red-50 border border-red-200 px-2 py-1.5 text-red-900"><b>Regra de parada:</b> {m.regra_parada}</div>}
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
  const vistos = lista.filter((m) => (!teste || m.teste === teste) && (!soPendente || m.pendente));
  const nPend = lista.filter((m) => (!teste || m.teste === teste) && m.pendente).length;

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
            O painel só marca e confere — as mudanças são feitas no Seller Center. Preço e título são conferidos pelo catálogo (relido de madrugada ou em "Conferir agora"); ROAS e campanha pela configuração de ADS (a cada 2 h).
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
          {vistos.map((m) => (
            <div key={m.id}>
              <button type="button" onClick={() => setAberto(aberto === m.id ? null : m.id)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/40">
                {m.foto ? <img src={m.foto} alt="" className="h-9 w-9 rounded object-cover shrink-0" loading="lazy" />
                  : <div className="h-9 w-9 rounded bg-muted shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5"><EtiquetaMarcacao m={m} /><span className="text-[11px] text-muted-foreground">{m.loja}{m.rotulo ? ` · ${m.rotulo}` : ""}</span></div>
                  <div className="text-xs truncate mt-0.5">{m.nome_atual ?? (m.item_id ? `item ${m.item_id}` : "anúncio ainda não criado")}</div>
                </div>
                <span className="text-[11px] text-muted-foreground whitespace-nowrap">{m.item_id ?? "sem ID"}</span>
              </button>
              {aberto === m.id && <div className="px-3 pb-3"><BlocoOQueFazer m={m} compacto /></div>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
