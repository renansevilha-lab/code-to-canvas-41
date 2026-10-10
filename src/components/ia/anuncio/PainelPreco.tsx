import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { nomeCanal, nomeEmpresa, type IaHistSku, type IaPreco, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// Preço do anúncio (10/out/2026, pedido do dono): usa o que a gestão já sabe.
// - Taxa do canal = o que o marketplace realmente descontou nos pedidos dos
//   últimos 120 dias, na faixa de preço do produto (Shopee: tabela em vigor).
// - "Como vende hoje" = preço, volume e margem REAIS deste produto por canal.
// - Precificação por margem: a pessoa escolhe a margem e o banco devolve o preço
//   (e o caminho inverso: informa o preço e vê a margem). Sem escolher, vale a
//   margem alvo do canal (ia_canal_config).
// Todo o cálculo é do banco (ia_calcular_preco / ia_analisar_preco); aqui só
// exibe. Não depende da IA: aparece antes de existir rascunho.
// ============================================================================

const pct = (v: unknown, casas = 1) => (v == null ? "—" : `${(Number(v) * 100).toFixed(casas)}%`);
const MARGENS_RAPIDAS = [0.1, 0.15, 0.2, 0.25, 0.3];
const emPct = (v: number) => (v * 100).toFixed(1).replace(/\.0$/, "").replace(".", ",");
const corMargem = (v: number | null, alvo: number) => (v == null ? undefined : v >= alvo ? "#0E8A5F" : v > 0 ? "#B7791F" : "#C9432F");

export function PainelPreco({ sku, canal, empresa, rascunho }: { sku: string; canal: string; empresa: string; rascunho: IaRascunho | null }) {
  const qc = useQueryClient();
  // margem escolhida (fração). null = a margem alvo do canal. O que foi salvo no rascunho volta ao abrir.
  const salva = rascunho?.memoria_calculo?.margem_desejada;
  const [margem, setMargem] = useState<number | null>(salva != null ? Number(salva) : null);
  const [margemTxt, setMargemTxt] = useState(salva != null ? emPct(Number(salva)) : "");
  useEffect(() => {
    setMargem(salva != null ? Number(salva) : null);
    setMargemTxt(salva != null ? emPct(Number(salva)) : "");
  }, [rascunho?.id, canal, empresa]);
  // digitação com atraso: só recalcula quando a pessoa para de digitar
  useEffect(() => {
    const t = setTimeout(() => {
      const v = Number(margemTxt.replace(",", "."));
      setMargem(margemTxt.trim() !== "" && v >= 0 && v < 60 ? Math.round(v * 10) / 1000 : null);
    }, 400);
    return () => clearTimeout(t);
  }, [margemTxt]);

  // a chave começa por ["ia-anuncio","produto",sku]: salvar frete/embalagem do produto recalcula sozinho
  const precoQ = useQuery({
    queryKey: ["ia-anuncio", "produto", sku, "preco", canal, empresa, margem],
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<IaPreco> => {
      const { data, error } = await supabaseExternal.rpc("ia_calcular_preco", { p_sku: sku, p_canal: canal, p_empresa: empresa, p_margem: margem });
      if (error) throw error;
      return (data ?? {}) as IaPreco;
    },
  });
  const histQ = useQuery({
    queryKey: ["ia-anuncio", "historico", sku],
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<IaHistSku[]> => {
      const { data, error } = await supabaseExternal.from("ia_hist_sku_canal").select("*").eq("sku", sku).order("unidades_120d", { ascending: false });
      if (error) throw error;
      return (data ?? []) as IaHistSku[];
    },
  });

  const [preco, setPreco] = useState("");
  const [analise, setAnalise] = useState<Record<string, any> | null>(null);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => {
    setPreco(rascunho?.preco_aprovado != null ? String(rascunho.preco_aprovado).replace(".", ",") : "");
    setAnalise(null);
  }, [rascunho?.id, rascunho?.preco_aprovado, canal, empresa]);

  const p = precoQ.data;
  const mem = p?.memoria_calculo ?? {};
  const padrao = Number(mem.margem_padrao_pct ?? (p as any)?.margem_padrao_pct ?? 0.175);
  const alvo = Number(mem.margem_alvo_pct ?? margem ?? padrao);
  const hist = histQ.data ?? [];
  const aqui = hist.find((h) => h.canal === canal && h.empresa === empresa);
  const taxaFraca = ["canal", "cadastro"].includes(String(mem.nivel_taxa ?? ""));
  const numero = () => Number(preco.replace(/\./g, "").replace(",", "."));

  async function analisar(valor?: number) {
    const v = valor ?? numero();
    if (!(v > 0)) { toast.error("Informe um preço"); return; }
    setOcupado(true);
    const { data, error } = await supabaseExternal.rpc("ia_analisar_preco", { p_sku: sku, p_canal: canal, p_empresa: empresa, p_preco: v, p_margem: margem });
    setOcupado(false);
    if (error) { toast.error("Falha na análise", { description: error.message }); return; }
    setAnalise(data as Record<string, any>);
  }
  function usar(v: number | null | undefined) {
    if (v == null) return;
    setPreco(Number(v).toFixed(2).replace(".", ","));
    void analisar(Number(v));
  }
  async function salvar() {
    if (!rascunho) return;
    const v = numero();
    const memoria = { ...(rascunho.memoria_calculo ?? {}), margem_desejada: margem };
    const { error } = await supabaseExternal.from("ia_rascunho").update({ preco_aprovado: v > 0 ? v : null, memoria_calculo: memoria }).eq("id", rascunho.id);
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    toast.success("Preço salvo no rascunho");
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  }

  return (
    <Card><CardContent className="p-5 space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">Preço</h3>
        <span className="text-xs text-muted-foreground">{nomeCanal(canal)} · {nomeEmpresa(empresa)} · pelas taxas reais dos pedidos</span>
        {precoQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Margem que eu quero:</span>
        <div className="relative">
          <Input className="h-8 w-20 font-mono pr-6" value={margemTxt} onChange={(e) => setMargemTxt(e.target.value)} placeholder={emPct(padrao)} />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
        </div>
        {MARGENS_RAPIDAS.map((m) => (
          <Button key={m} size="sm" variant={margem != null && Math.abs(margem - m) < 0.0005 ? "default" : "outline"} className="h-7 px-2 text-xs"
            onClick={() => setMargemTxt(emPct(m))}>{emPct(m)}%</Button>
        ))}
        <Button size="sm" variant={margem == null ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setMargemTxt("")}>
          padrão do canal ({emPct(padrao)}%)
        </Button>
      </div>

      {precoQ.isLoading ? (
        <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Calculando…</div>
      ) : precoQ.isError ? (
        <p className="text-sm text-destructive">Falha ao calcular: {(precoQ.error as Error).message}</p>
      ) : p?.erro ? (
        <p className="text-sm text-amber-600 flex gap-1.5"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />Sem preço sugerido: {p.erro}</p>
      ) : (
        <div className="grid md:grid-cols-[auto_1fr] gap-x-8 gap-y-3">
          <div>
            <div className="text-[11px] text-muted-foreground">Sugerido para {pct(alvo)} de margem</div>
            <div className="text-3xl font-bold font-mono tracking-tight">{formatBRL(Number(p?.preco_sugerido))}</div>
            <div className="text-xs text-muted-foreground">sobram {formatBRL(Number(p?.lucro_reais))} por unidade</div>
            {aqui?.preco_unit_ult != null && (
              <div className="text-xs mt-1.5">
                Hoje vende a <b className="font-mono">{formatBRL(Number(aqui.preco_unit_ult))}</b>
                {aqui.mc_pct != null && <> com <b style={{ color: corMargem(Number(aqui.mc_pct), alvo) }}>{pct(aqui.mc_pct)}</b> de margem</>}
              </div>
            )}
          </div>
          <div className="text-sm space-y-1">
            <Conta rotulo="Custo da mercadoria (gestão)" valor={formatBRL(Number(mem.custo_mercadoria))} />
            {Number(mem.embalagem) > 0 && <Conta rotulo="Embalagem" valor={formatBRL(Number(mem.embalagem))} />}
            {Number(mem.frete_adicional) > 0 && <Conta rotulo="Frete adicional" valor={formatBRL(Number(mem.frete_adicional))} />}
            <Conta rotulo={`Taxa do canal${Number(mem.tarifa_fixa) > 0 ? ` (${pct(mem.comissao_pct, 0)} + ${formatBRL(Number(mem.tarifa_fixa))})` : ""}`}
              valor={Number(mem.tarifa_fixa) > 0
                ? formatBRL(Number(p?.preco_sugerido) * Number(mem.comissao_pct) + Number(mem.tarifa_fixa))
                : `${pct(mem.comissao_pct)} · ${formatBRL(Number(p?.preco_sugerido) * Number(mem.comissao_pct))}`} />
            <Conta rotulo="Imposto" valor={`${pct(mem.imposto_pct)} · ${formatBRL(Number(p?.preco_sugerido) * Number(mem.imposto_pct))}`} />
            <p className={`text-[11px] leading-snug pt-1 ${taxaFraca ? "text-amber-600" : "text-muted-foreground"}`}>
              {taxaFraca && <AlertTriangle className="h-3 w-3 inline mr-1 -mt-0.5" />}
              Taxa medida em: {String(mem.fonte_taxa ?? "—")}
              {mem.amostra != null && <> — {Number(mem.amostra).toLocaleString("pt-BR")} pedidos</>}
              {mem.nivel_taxa !== "tabela" && mem.faixa_min != null && <>, entre {formatBRL(Number(mem.faixa_min))} e {mem.faixa_max != null ? formatBRL(Number(mem.faixa_max)) : "acima"}</>}.
              {taxaFraca && " Estimativa fraca: confira depois das primeiras vendas."}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm border-t pt-3">
        <span className="text-muted-foreground">Preço que vai praticar:</span>
        <Input className="h-8 w-28 font-mono" value={preco} onChange={(e) => { setPreco(e.target.value); setAnalise(null); }} placeholder="0,00"
          onKeyDown={(e) => { if (e.key === "Enter") void analisar(); }} />
        <Button size="sm" variant="outline" className="h-8" disabled={ocupado} onClick={() => void analisar()}>
          {ocupado && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Analisar
        </Button>
        {p?.preco_sugerido != null && <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => usar(p.preco_sugerido)}>usar o sugerido</Button>}
        {aqui?.preco_unit_ult != null && <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => usar(aqui.preco_unit_ult)}>usar o de hoje</Button>}
        {rascunho && <Button size="sm" className="h-8" disabled={!(numero() > 0)} onClick={() => void salvar()}>Salvar preço</Button>}
      </div>
      {analise && (analise.erro ? <p className="text-sm text-destructive">{analise.erro}</p> : (
        <p className="text-sm" style={{ color: corMargem(Number(analise.lucro_pct), alvo) }}>
          A {formatBRL(Number(analise.preco_praticado))}: sobram <b>{formatBRL(Number(analise.lucro_reais))}</b> por unidade ({pct(analise.lucro_pct)} de margem).
          <span className="text-muted-foreground"> Para bater {pct(alvo)}, a mercadoria poderia custar até {formatBRL(Number(analise.custo_max_mercadoria))}
            {Number(analise.folga_reais) >= 0 ? ` (folga de ${formatBRL(Number(analise.folga_reais))})` : ` (faltam ${formatBRL(-Number(analise.folga_reais))})`}.</span>
        </p>
      ))}

      <div>
        <div className="text-[11px] text-muted-foreground mb-1">Como este produto vende hoje (pedidos dos últimos 120 dias)</div>
        {histQ.isLoading ? <div className="text-xs text-muted-foreground">Carregando…</div>
          : hist.length === 0 ? <p className="text-xs text-muted-foreground">Ainda não vendeu em nenhum canal integrado (Shopee, Mercado Livre, Amazon, TikTok).</p>
          : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-2.5 py-1.5">Canal</th>
                    <th className="text-right font-medium px-2.5 py-1.5">Preço</th>
                    <th className="text-right font-medium px-2.5 py-1.5">30 dias</th>
                    <th className="text-right font-medium px-2.5 py-1.5">120 dias</th>
                    <th className="text-right font-medium px-2.5 py-1.5">Taxa do canal</th>
                    <th className="text-right font-medium px-2.5 py-1.5">Margem</th>
                    <th className="text-right font-medium px-2.5 py-1.5">Última venda</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {hist.map((h) => {
                    const atual = h.canal === canal && h.empresa === empresa;
                    return (
                      <tr key={`${h.canal}-${h.empresa}`} className={atual ? "bg-primary/5 font-medium" : undefined}>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">{nomeCanal(h.canal)} · {nomeEmpresa(h.empresa)}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono">{h.preco_unit_ult != null ? formatBRL(Number(h.preco_unit_ult)) : "—"}</td>
                        <td className="px-2.5 py-1.5 text-right">{Number(h.unidades_30d).toLocaleString("pt-BR")} un.</td>
                        <td className="px-2.5 py-1.5 text-right">{Number(h.unidades_120d).toLocaleString("pt-BR")} un.</td>
                        <td className="px-2.5 py-1.5 text-right">{pct(h.taxa_med)}</td>
                        <td className="px-2.5 py-1.5 text-right font-semibold" style={{ color: corMargem(h.mc_pct != null ? Number(h.mc_pct) : null, alvo) }}>{pct(h.mc_pct)}</td>
                        <td className="px-2.5 py-1.5 text-right text-muted-foreground">{h.ultima_venda ? h.ultima_venda.split("-").reverse().slice(0, 2).join("/") : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </CardContent></Card>
  );
}

function Conta({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground">{rotulo}</span>
      <span className="flex-1 border-b border-dotted" />
      <span className="font-mono">{valor}</span>
    </div>
  );
}
