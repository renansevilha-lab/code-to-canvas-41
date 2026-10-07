import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Search, Tag, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { FAIXAS_MC, Foto, GREEN, AMBER, RED, corMc, num } from "./comum";
import { AdicionarProdutosDialog, ItensPromocao, NovaPromocaoDialog, encerrarPromocao } from "./TikTokAcoes";

// ============================================================================
// Promoções TikTok Shop — loja ACZ (07/out/2026; etapa 1 = leitura, etapa 2 =
// escrita no mesmo dia: criar, pôr/tirar produtos e encerrar — TikTokAcoes.tsx).
// Espelho gravado pela edge fn tiktok-promocoes?modulo=sync (cron 151, 3×/dia +
// botão): catálogo ativo (tiktok_produtos) e promoções (tiktok_promocoes /
// _itens). Margem no banco (view_tiktok_produtos_mc): preço × (1 − taxa
// efetiva − imposto efetivo, medidos nos pedidos TikTok de 120 dias) − CMV.
// ============================================================================

interface ProdutoMc {
  sku_id: string; product_id: string; titulo: string | null; status: string | null; seller_sku: string | null;
  preco: number | null; estoque: number | null; atualizado_em: string; foto: string | null;
  cmv: number | null; taxa_pct: number | null; imp_pct: number | null; mc: number | null; mc_pct: number | null;
  preco_promo: number | null; promo_titulo: string | null; promo_status: string | null; promo_fim: string | null;
  mc_promo: number | null; mc_promo_pct: number | null; vendas_30d: number;
}
interface Promocao {
  activity_id: string; titulo: string | null; tipo: string | null; status: string | null;
  product_level: string | null; inicio: string | null; fim: string | null;
}

const STATUS_PROMO: Record<string, { rotulo: string; cor: string }> = {
  ONGOING: { rotulo: "Em andamento", cor: GREEN },
  NOT_START: { rotulo: "Programada", cor: AMBER },
  EXPIRED: { rotulo: "Encerrada", cor: "#64748B" },
  DEACTIVATED: { rotulo: "Desativada", cor: "#64748B" },
};
const TIPO_PROMO: Record<string, string> = {
  FIXED_PRICE: "Preço fixo", DIRECT_DISCOUNT: "Desconto %", FLASHSALE: "Relâmpago",
};
const dataBR = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

async function sincronizar(): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const bearer = data.session?.access_token ?? EXTERNAL_PUBLISHABLE_KEY;
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiktok-promocoes?modulo=sync`, {
    headers: { Authorization: `Bearer ${bearer}`, apikey: EXTERNAL_PUBLISHABLE_KEY },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.erro ?? `HTTP ${r.status}`);
  return j;
}

type Ord = "vendas" | "mcpct" | "preco" | "estoque";

export function PromocoesTikTok() {
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [faixa, setFaixa] = useState("todas");
  const [ord, setOrd] = useState<Ord>("vendas");
  const [sincronizando, setSincronizando] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [novaAberta, setNovaAberta] = useState(false);
  const [adicionarAberto, setAdicionarAberto] = useState(false);
  const [expandida, setExpandida] = useState<string | null>(null);
  const [encerrando, setEncerrando] = useState<string | null>(null);
  const termos = useMemo(() => semAcento(busca).split(/\s+/).filter(Boolean), [busca]);

  const prodQ = useQuery({
    queryKey: ["promocoes-tiktok", "produtos"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ProdutoMc[]> => {
      const { data, error } = await supabaseExternal.from("view_tiktok_produtos_mc")
        .select("sku_id, product_id, titulo, status, seller_sku, preco, estoque, atualizado_em, foto, cmv, taxa_pct, imp_pct, mc, mc_pct, preco_promo, promo_titulo, promo_status, promo_fim, mc_promo, mc_promo_pct, vendas_30d")
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as ProdutoMc[];
    },
  });
  const promoQ = useQuery({
    queryKey: ["promocoes-tiktok", "promocoes"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Promocao[]> => {
      const { data, error } = await supabaseExternal.from("tiktok_promocoes")
        .select("activity_id, titulo, tipo, status, product_level, inicio, fim").order("inicio", { ascending: false }).limit(200);
      if (error) throw error;
      return (data ?? []) as Promocao[];
    },
  });

  const produtos = prodQ.data ?? [];
  const promocoes = promoQ.data ?? [];
  const ultimaSync = produtos.reduce<string | null>((m, p) => (!m || p.atualizado_em > m ? p.atualizado_em : m), null);
  const taxa = produtos[0]?.taxa_pct; const imp = produtos[0]?.imp_pct;

  const passaFaixa = (p: ProdutoMc) => {
    if (faixa === "todas") return true;
    const f = FAIXAS_MC.find((x) => x.id === faixa);
    if (!f || p.mc_pct == null) return false;
    return f.testa(Number(p.mc_pct));
  };
  const lista = useMemo(() => {
    const val = (p: ProdutoMc) => ord === "vendas" ? num(p.vendas_30d) : ord === "mcpct" ? (p.mc_pct == null ? -9 : Number(p.mc_pct))
      : ord === "preco" ? num(p.preco) : num(p.estoque);
    return produtos
      .filter((p) => termos.every((t) => semAcento(`${p.titulo ?? ""} ${p.seller_sku ?? ""}`).includes(t)) && passaFaixa(p))
      .sort((a, b) => val(b) - val(a) || (a.titulo ?? "").localeCompare(b.titulo ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtos, termos, faixa, ord]);

  const porSku = useMemo(() => new Map(produtos.map((p) => [p.sku_id, p])), [produtos]);
  const porProduto = useMemo(() => {
    const m = new Map<string, ProdutoMc>();
    for (const p of produtos) if (!m.has(p.product_id)) m.set(p.product_id, p);
    return m;
  }, [produtos]);
  const selecionados = useMemo(() => produtos.filter((p) => sel.has(p.sku_id)), [produtos, sel]);
  const todosVisiveisMarcados = lista.length > 0 && lista.every((p) => sel.has(p.sku_id));
  const alternar = (sku: string) => setSel((s) => { const n = new Set(s); if (n.has(sku)) n.delete(sku); else n.add(sku); return n; });
  const recarregar = () => { void qc.invalidateQueries({ queryKey: ["promocoes-tiktok"] }); };

  async function rodarSync() {
    setSincronizando(true);
    try {
      const r = await sincronizar();
      const e = (r.erros ?? []) as string[];
      if (e.length) toast.warning("Sincronizado com avisos", { description: e.slice(0, 4).join("\n") });
      else toast.success(`TikTok sincronizado: ${r.catalogo?.skus ?? 0} SKUs · ${r.promocoes?.total ?? 0} promoções`);
      void qc.invalidateQueries({ queryKey: ["promocoes-tiktok"] });
    } catch (e) {
      toast.error("Falha ao sincronizar o TikTok", { description: (e as Error).message });
    } finally { setSincronizando(false); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[12.5px] text-muted-foreground">
          <b className="text-foreground">TikTok Shop · ACZ Pet</b>
          {ultimaSync && <> · sincronizado {dataBR(ultimaSync)}</>}
          {taxa != null && imp != null && (
            <span title="Medido nos pedidos TikTok dos últimos 120 dias: 1 − recebido/venda (comissão, frete e taxas) e imposto/venda">
              {" "}· taxas TikTok {(Number(taxa) * 100).toFixed(1)}% + imposto {(Number(imp) * 100).toFixed(1)}% (efetivos, 120 dias)
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={sincronizando} onClick={() => void rodarSync()}>
            {sincronizando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sincronizar com o TikTok
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setNovaAberta(true)}>
            <Plus className="h-3.5 w-3.5" />Nova promoção
          </Button>
        </div>
      </div>

      {/* Promoções da loja */}
      <div>
        <h3 className="text-[14px] font-semibold mb-2">Promoções da loja</h3>
        {promoQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : promocoes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma promoção — clique em Sincronizar.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {promocoes.map((p) => {
              const st = STATUS_PROMO[p.status ?? ""] ?? { rotulo: p.status ?? "—", cor: "#64748B" };
              const aberta = p.status === "ONGOING" || p.status === "NOT_START";
              const exp = expandida === p.activity_id;
              return (
                <div key={p.activity_id}>
                  <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]">
                    {aberta ? (
                      <button type="button" className="text-muted-foreground hover:text-foreground" title="Ver produtos"
                        onClick={() => setExpandida(exp ? null : p.activity_id)}>
                        {exp ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    ) : <Tag className="h-4 w-4 text-muted-foreground shrink-0" />}
                    <span className="font-medium flex-1 min-w-0 truncate">{p.titulo ?? p.activity_id}</span>
                    <span className="text-[11.5px] text-muted-foreground">{TIPO_PROMO[p.tipo ?? ""] ?? p.tipo} · {p.product_level === "VARIATION" ? "por variação" : "por produto"}</span>
                    <span className="text-[11.5px] text-muted-foreground whitespace-nowrap">{dataBR(p.inicio)} → {dataBR(p.fim)}</span>
                    <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded" style={{ background: `${st.cor}18`, color: st.cor }}>{st.rotulo}</span>
                    {aberta && (
                      <Button size="sm" variant="outline" className="h-7 text-[11.5px] px-2" disabled={encerrando === p.activity_id}
                        onClick={async () => {
                          setEncerrando(p.activity_id);
                          if (await encerrarPromocao(p)) recarregar();
                          setEncerrando(null);
                        }}>
                        {encerrando === p.activity_id && <Loader2 className="h-3 w-3 animate-spin mr-1" />}Encerrar
                      </Button>
                    )}
                  </div>
                  {exp && <ItensPromocao promo={p} produtosPorSku={porSku} produtosPorProduto={porProduto} onMudou={recarregar} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Catálogo com margem */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-[14px] font-semibold mr-2">Produtos ({lista.length})</h3>
          <div className="relative mr-2">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar produto ou SKU"
              className="h-7 w-[240px] pl-8 pr-7 text-[12px]" />
            {busca && (
              <button type="button" onClick={() => setBusca("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" title="Limpar">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <span className="text-[11.5px] text-muted-foreground mr-1">MC:</span>
          {FAIXAS_MC.map((f) => (
            <Button key={f.id} size="sm" variant={faixa === f.id ? "default" : "outline"} className="h-7 text-[11.5px] px-2.5" onClick={() => setFaixa(f.id)}>
              {f.rotulo}
            </Button>
          ))}
          <div className="flex-1" />
          <span className="text-[11.5px] text-muted-foreground mr-1">Ordenar:</span>
          {([["vendas", "Mais vendidos"], ["mcpct", "MC %"], ["preco", "Preço"], ["estoque", "Estoque"]] as const).map(([k, r]) => (
            <Button key={k} size="sm" variant={ord === k ? "default" : "outline"} className="h-7 text-[11.5px] px-2.5 gap-1" onClick={() => setOrd(k)}>
              {ord === k && <ArrowDown className="h-3 w-3" />}{r}
            </Button>
          ))}
        </div>

        {sel.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[12.5px]" style={{ borderColor: AMBER }}>
            <b>{sel.size} SKU(s) selecionado(s)</b>
            <Button size="sm" className="h-7 text-[12px]" onClick={() => setAdicionarAberto(true)}>Adicionar à promoção…</Button>
            <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setSel(new Set())}>Limpar seleção</Button>
          </div>
        )}
        <div className="rounded-lg border overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground text-[10.5px] uppercase tracking-wide">
                <th className="px-2 py-2 w-8">
                  <Checkbox checked={todosVisiveisMarcados} title="Selecionar os filtrados"
                    onCheckedChange={(v) => setSel((s) => {
                      const n = new Set(s);
                      for (const p of lista) { if (v === true) n.add(p.sku_id); else n.delete(p.sku_id); }
                      return n;
                    })} />
                </th>
                <th className="text-left font-medium px-3 py-2">Produto</th>
                <th className="text-right font-medium px-2 py-2">Preço</th>
                <th className="text-right font-medium px-2 py-2" title="Custo do produto hoje (kit = soma dos componentes)">CMV</th>
                <th className="text-right font-medium px-2 py-2" title="Preço − taxas TikTok efetivas − imposto efetivo − CMV">MC R$</th>
                <th className="text-right font-medium px-2 py-2">MC %</th>
                <th className="text-right font-medium px-2 py-2" title="Preço e MC na promoção em andamento/programada">Na promoção</th>
                <th className="text-right font-medium px-2 py-2" title="Unidades vendidas no TikTok nos últimos 30 dias">Vendas 30d</th>
                <th className="text-right font-medium px-2 py-2">Estoque</th>
              </tr>
            </thead>
            <tbody>
              {prodQ.isLoading ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</td></tr>
              ) : prodQ.isError ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center" style={{ color: RED }}>Falha: {(prodQ.error as Error).message}</td></tr>
              ) : lista.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                  {produtos.length === 0 ? "Nenhum produto — clique em Sincronizar com o TikTok." : "Nada com esses filtros."}
                </td></tr>
              ) : lista.map((p) => (
                <tr key={p.sku_id} className={cn("border-b last:border-0", sel.has(p.sku_id) && "bg-muted/40")}>
                  <td className="px-2 py-1.5"><Checkbox checked={sel.has(p.sku_id)} onCheckedChange={() => alternar(p.sku_id)} /></td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2.5 min-w-[280px]">
                      <Foto url={p.foto} size={38} />
                      <div className="min-w-0">
                        <div className="truncate max-w-[520px] font-medium" title={p.titulo ?? ""}>{p.titulo ?? "—"}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">{p.seller_sku ?? "sem SKU"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono">{p.preco != null ? formatBRL(Number(p.preco)) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono text-muted-foreground">{p.cmv != null ? formatBRL(Number(p.cmv)) : "—"}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono" style={{ color: p.mc_pct != null ? corMc(Number(p.mc_pct)) : undefined }}>
                    {p.mc != null ? formatBRL(Number(p.mc)) : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono font-semibold" style={{ color: p.mc_pct != null ? corMc(Number(p.mc_pct)) : undefined }}>
                    {p.mc_pct != null ? `${(Number(p.mc_pct) * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    {p.preco_promo != null ? (
                      <span title={`${p.promo_titulo ?? ""} — até ${dataBR(p.promo_fim)}`}>
                        <span className="font-mono">{formatBRL(Number(p.preco_promo))}</span>
                        {p.mc_promo_pct != null && (
                          <span className="ml-1.5 font-mono text-[11.5px]" style={{ color: corMc(Number(p.mc_promo_pct)) }}>
                            {(Number(p.mc_promo_pct) * 100).toFixed(1)}%
                          </span>
                        )}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn("px-2 py-1.5 text-right tabular-nums", num(p.vendas_30d) === 0 && "text-muted-foreground")}>{num(p.vendas_30d)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{p.estoque ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          Leitura do TikTok (sincroniza 3×/dia — 07h33, 13h33 e 19h33 — e pelo botão). MC = preço − taxas TikTok efetivas (comissão, frete e taxas, medidas no
          recebido real) − imposto efetivo − CMV de hoje. Toda alteração no TikTok mostra a margem antes e fica registrada.
        </p>
      </div>

      {novaAberta && (
        <NovaPromocaoDialog onFechar={() => setNovaAberta(false)}
          onCriada={() => { setNovaAberta(false); recarregar(); }} />
      )}
      {adicionarAberto && (
        <AdicionarProdutosDialog itens={selecionados} promocoes={promocoes}
          onFechar={() => setAdicionarAberto(false)}
          onAplicado={() => { setAdicionarAberto(false); setSel(new Set()); recarregar(); }} />
      )}
    </div>
  );
}
