import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBRL } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { Foto, RED, AMBER, corMc } from "./comum";

// ============================================================================
// Escrita no TikTok (etapa 2, 07/out/2026): criar promoção, pôr/tirar produtos e
// encerrar. Tudo passa pela edge fn tiktok-promocoes: sem confirmar = PRÉVIA
// (a margem de cada item é calculada lá, a partir da view_tiktok_produtos_mc);
// com confirmar=1 grava na TikTok, registra em tiktok_promocao_acoes e relê a
// promoção para o espelho. Exige o usuário logado.
// ============================================================================

export interface PromoTT {
  activity_id: string; titulo: string | null; tipo: string | null; status: string | null;
  product_level: string | null; inicio: string | null; fim: string | null;
}
export interface ProdutoTT {
  sku_id: string; product_id: string; titulo: string | null; seller_sku: string | null;
  preco: number | null; foto: string | null;
}

export async function chamarTikTok(modulo: string, body: Record<string, unknown>, confirmar: boolean): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (confirmar && !token) throw new Error("Faça login de novo para alterar o TikTok.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiktok-promocoes?modulo=${modulo}${confirmar ? "&confirmar=1" : ""}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token ?? EXTERNAL_PUBLISHABLE_KEY}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.previa) throw new Error(j.erro ?? `HTTP ${r.status}`);
  return j;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Date → valor de <input type="datetime-local"> no fuso do navegador. */
const paraInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const abertaEditavel = (p: PromoTT) =>
  (p.status === "ONGOING" || p.status === "NOT_START") && (p.tipo === "FIXED_PRICE" || p.tipo === "DIRECT_DISCOUNT");

// ---------------------------------------------------------------------------- Nova promoção
export function NovaPromocaoDialog({ onFechar, onCriada }: { onFechar: () => void; onCriada: (id: string) => void }) {
  const agora = new Date();
  const ini0 = new Date(Math.ceil((agora.getTime() + 15 * 60_000) / (15 * 60_000)) * 15 * 60_000);
  const [titulo, setTitulo] = useState("");
  const [tipo, setTipo] = useState<"FIXED_PRICE" | "DIRECT_DISCOUNT">("FIXED_PRICE");
  const [nivel, setNivel] = useState<"VARIATION" | "PRODUCT">("VARIATION");
  const [inicio, setInicio] = useState(paraInput(ini0));
  const [fim, setFim] = useState(paraInput(new Date(ini0.getTime() + 7 * 86_400_000)));
  const [enviando, setEnviando] = useState(false);

  const corpo = () => ({ titulo: titulo.trim(), tipo, nivel, inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString() });

  async function criar() {
    setEnviando(true);
    try {
      const prev = await chamarTikTok("criar", corpo(), false);
      if (!prev.ok) throw new Error(prev.erro ?? "prévia recusada");
      const r = await chamarTikTok("criar", corpo(), true);
      if (!r.ok) throw new Error(r.erro ?? "falhou");
      toast.success(`Promoção criada no TikTok: ${titulo.trim()}`);
      onCriada(String(r.activity_id ?? ""));
    } catch (e) {
      toast.error("Não foi possível criar a promoção", { description: (e as Error).message });
    } finally { setEnviando(false); }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !enviando) onFechar(); }}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Nova promoção no TikTok (ACZ)</DialogTitle>
          <DialogDescription>
            A promoção nasce vazia. Depois selecione os produtos na tabela e use "Adicionar à promoção".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <label className="block">
            <span className="text-muted-foreground text-[12px]">Nome (aparece só para você no Seller Center)</span>
            <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={50} placeholder="Ex.: Semana do gato" className="mt-1" />
          </label>
          <div>
            <span className="text-muted-foreground text-[12px]">Tipo</span>
            <div className="flex gap-1.5 mt-1">
              <Button size="sm" variant={tipo === "FIXED_PRICE" ? "default" : "outline"} onClick={() => setTipo("FIXED_PRICE")}>Preço fixo</Button>
              <Button size="sm" variant={tipo === "DIRECT_DISCOUNT" ? "default" : "outline"} onClick={() => setTipo("DIRECT_DISCOUNT")}>Desconto %</Button>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground text-[12px]">Valor definido</span>
            <div className="flex gap-1.5 mt-1">
              <Button size="sm" variant={nivel === "VARIATION" ? "default" : "outline"} onClick={() => setNivel("VARIATION")}>Por variação</Button>
              <Button size="sm" variant={nivel === "PRODUCT" ? "default" : "outline"} onClick={() => setNivel("PRODUCT")}>Por produto</Button>
            </div>
            <p className="text-[11.5px] text-muted-foreground mt-1">
              Por variação permite um preço diferente para cada variação. Isso não muda depois de criada.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-muted-foreground text-[12px]">Início</span>
              <Input type="datetime-local" value={inicio} onChange={(e) => setInicio(e.target.value)} className="mt-1" />
            </label>
            <label className="block">
              <span className="text-muted-foreground text-[12px]">Fim</span>
              <Input type="datetime-local" value={fim} onChange={(e) => setFim(e.target.value)} className="mt-1" />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" disabled={enviando} onClick={onFechar}>Cancelar</Button>
            <Button disabled={enviando || !titulo.trim()} onClick={() => void criar()}>
              {enviando && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Criar no TikTok
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Adicionar produtos
interface LinhaPrevia {
  sku_id: string; seller_sku: string | null; titulo: string | null; preco_atual: number; preco_promo: number;
  desconto: number | null; mc: number | null; mc_pct: number | null; alertas: string[];
}

export function AdicionarProdutosDialog({ itens, promocoes, onFechar, onAplicado }: {
  itens: ProdutoTT[]; promocoes: PromoTT[]; onFechar: () => void; onAplicado: () => void;
}) {
  const abertas = useMemo(() => promocoes.filter(abertaEditavel), [promocoes]);
  const [activityId, setActivityId] = useState(abertas[0]?.activity_id ?? "");
  const promo = abertas.find((p) => p.activity_id === activityId) ?? null;
  const fixo = promo?.tipo !== "DIRECT_DISCOUNT";
  const [valores, setValores] = useState<Record<string, string>>({});
  const [descGeral, setDescGeral] = useState("10");
  const [porCliente, setPorCliente] = useState("");
  const [forcar, setForcar] = useState(false);
  const [previa, setPrevia] = useState<{ linhas: LinhaPrevia[]; bloqueios: string[] } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const valorDe = (p: ProdutoTT) => {
    if (valores[p.sku_id] != null) return valores[p.sku_id];
    const d = Number(descGeral) || 0;
    return fixo ? (p.preco ? (Number(p.preco) * (1 - d / 100)).toFixed(2) : "") : String(d);
  };
  const corpo = () => ({
    activity_id: activityId, forcar,
    itens: itens.map((p) => ({
      sku_id: p.sku_id,
      ...(fixo ? { preco: Number(valorDe(p).replace(",", ".")) } : { desconto: Number(valorDe(p)) }),
      ...(porCliente ? { por_cliente: Number(porCliente) } : {}),
    })),
  });

  async function revisar() {
    setOcupado(true);
    try {
      const r = await chamarTikTok("produtos", corpo(), false);
      setPrevia({ linhas: r.linhas ?? [], bloqueios: r.bloqueios ?? (r.erro ? [r.erro] : []) });
    } catch (e) {
      toast.error("Falha na prévia", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }
  async function aplicar() {
    setOcupado(true);
    try {
      const r = await chamarTikTok("produtos", corpo(), true);
      if (!r.ok) throw new Error(r.erro ?? (((r.bloqueios ?? []) as string[]).join("; ") || "recusado"));
      toast.success(`${r.skus ?? itens.length} SKU(s) na promoção "${promo?.titulo ?? ""}"`);
      onAplicado();
    } catch (e) {
      toast.error("O TikTok recusou", { description: (e as Error).message });
    } finally { setOcupado(false); }
  }
  const mudou = () => setPrevia(null);

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-[min(1100px,96vw)] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adicionar {itens.length} SKU(s) a uma promoção do TikTok</DialogTitle>
          <DialogDescription>
            Um produto fica em uma promoção por vez: se ele já estiver em outra, sai de lá. Revise a margem antes de aplicar.
          </DialogDescription>
        </DialogHeader>
        {abertas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma promoção aberta de preço fixo ou desconto. Crie uma em "Nova promoção".</p>
        ) : (
          <div className="space-y-3 text-[13px]">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="text-muted-foreground text-[12px]">Promoção</span>
                <select className="mt-1 block h-9 rounded-md border bg-background px-2 text-[13px] min-w-[280px]" value={activityId}
                  onChange={(e) => { setActivityId(e.target.value); setValores({}); mudou(); }}>
                  {abertas.map((p) => (
                    <option key={p.activity_id} value={p.activity_id}>
                      {p.titulo} · {p.tipo === "FIXED_PRICE" ? "preço fixo" : "desconto %"} · {p.status === "ONGOING" ? "em andamento" : "programada"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-muted-foreground text-[12px]">{fixo ? "Preencher com desconto de" : "Desconto para todos"}</span>
                <div className="flex items-center gap-1 mt-1">
                  <Input className="h-9 w-20" value={descGeral} onChange={(e) => { setDescGeral(e.target.value); setValores({}); mudou(); }} />
                  <span>%</span>
                </div>
              </label>
              <label className="block">
                <span className="text-muted-foreground text-[12px]">Limite por cliente (vazio = sem limite)</span>
                <Input className="h-9 w-28 mt-1" value={porCliente} onChange={(e) => { setPorCliente(e.target.value.replace(/\D/g, "")); mudou(); }} />
              </label>
              <label className="flex items-center gap-1.5 pb-2 cursor-pointer">
                <Checkbox checked={forcar} onCheckedChange={(v) => { setForcar(v === true); mudou(); }} />
                <span className="text-[12px]">forçar (desconto acima de 50% ou preço maior que o atual)</span>
              </label>
            </div>

            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground text-[10.5px] uppercase tracking-wide">
                    <th className="text-left font-medium px-3 py-2">Produto</th>
                    <th className="text-right font-medium px-2 py-2">Preço atual</th>
                    <th className="text-right font-medium px-2 py-2">{fixo ? "Preço na promoção" : "Desconto %"}</th>
                    <th className="text-right font-medium px-2 py-2">Fica por</th>
                    <th className="text-right font-medium px-2 py-2">MC R$</th>
                    <th className="text-right font-medium px-2 py-2">MC %</th>
                    <th className="text-left font-medium px-2 py-2">Avisos</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((p) => {
                    const lp = previa?.linhas.find((x) => x.sku_id === p.sku_id);
                    return (
                      <tr key={p.sku_id} className="border-b last:border-0">
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-2 min-w-[240px]">
                            <Foto url={p.foto} size={32} />
                            <div className="min-w-0">
                              <div className="truncate max-w-[340px]" title={p.titulo ?? ""}>{p.titulo ?? "—"}</div>
                              <div className="text-[11px] text-muted-foreground font-mono">{p.seller_sku ?? "sem SKU"}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{p.preco != null ? formatBRL(Number(p.preco)) : "—"}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Input className="h-8 w-24 ml-auto text-right font-mono" value={valorDe(p)}
                            onChange={(e) => { setValores((v) => ({ ...v, [p.sku_id]: e.target.value })); mudou(); }} />
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">{lp ? formatBRL(lp.preco_promo) : "—"}</td>
                        <td className="px-2 py-1.5 text-right font-mono" style={{ color: lp?.mc_pct != null ? corMc(lp.mc_pct) : undefined }}>
                          {lp?.mc != null ? formatBRL(lp.mc) : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono font-semibold" style={{ color: lp?.mc_pct != null ? corMc(lp.mc_pct) : undefined }}>
                          {lp?.mc_pct != null ? `${(lp.mc_pct * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-[11.5px]" style={{ color: AMBER }}>{lp?.alertas.join(" · ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {previa && previa.bloqueios.length > 0 && (
              <div className="rounded-md border px-3 py-2 text-[12.5px]" style={{ borderColor: RED, color: RED }}>
                <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" />Corrija antes de aplicar:</div>
                <ul className="list-disc pl-5 mt-1">{previa.bloqueios.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={ocupado} onClick={onFechar}>Cancelar</Button>
              <Button variant="outline" disabled={ocupado || !activityId} onClick={() => void revisar()}>
                {ocupado && !previa && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Revisar margem
              </Button>
              <Button disabled={ocupado || !previa || previa.bloqueios.length > 0} onClick={() => void aplicar()}>
                {ocupado && previa && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Aplicar no TikTok
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Itens de uma promoção
interface ItemPromo { product_id: string; sku_id: string; preco_promo: number | null; desconto: number | null; qtd_por_cliente: number | null }

export function ItensPromocao({ promo, produtosPorSku, produtosPorProduto, onMudou }: {
  promo: PromoTT; produtosPorSku: Map<string, ProdutoTT>; produtosPorProduto: Map<string, ProdutoTT>; onMudou: () => void;
}) {
  const [removendo, setRemovendo] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["promocoes-tiktok", "itens", promo.activity_id],
    staleTime: 60_000,
    queryFn: async (): Promise<ItemPromo[]> => {
      const { data, error } = await supabaseExternal.from("tiktok_promocao_itens")
        .select("product_id, sku_id, preco_promo, desconto, qtd_por_cliente").eq("activity_id", promo.activity_id).limit(1000);
      if (error) throw error;
      return (data ?? []) as ItemPromo[];
    },
  });
  const editavel = abertaEditavel(promo);

  async function remover(it: ItemPromo) {
    const nome = (produtosPorSku.get(it.sku_id) ?? produtosPorProduto.get(it.product_id))?.titulo ?? it.sku_id;
    if (!window.confirm(`Tirar da promoção "${promo.titulo}":\n${nome}\n\nO produto volta ao preço normal no TikTok.`)) return;
    setRemovendo(it.sku_id || it.product_id);
    try {
      const corpo = it.sku_id && promo.product_level !== "PRODUCT"
        ? { activity_id: promo.activity_id, sku_ids: [it.sku_id] }
        : { activity_id: promo.activity_id, product_ids: [it.product_id] };
      const r = await chamarTikTok("remover", corpo, true);
      if (!r.ok) throw new Error(r.erro ?? "recusado");
      toast.success("Produto retirado da promoção");
      void q.refetch(); onMudou();
    } catch (e) {
      toast.error("O TikTok recusou", { description: (e as Error).message });
    } finally { setRemovendo(null); }
  }

  if (q.isLoading) return <div className="px-4 py-2 text-[12px] text-muted-foreground">Carregando produtos…</div>;
  const itens = q.data ?? [];
  if (!itens.length) return <div className="px-4 py-2 text-[12px] text-muted-foreground">Nenhum produto nesta promoção ainda.</div>;
  return (
    <div className="px-4 py-2 space-y-1">
      {itens.map((it) => {
        const p = produtosPorSku.get(it.sku_id) ?? produtosPorProduto.get(it.product_id);
        const chave = it.sku_id || it.product_id;
        return (
          <div key={`${it.product_id}-${it.sku_id}`} className="flex items-center gap-2.5 text-[12.5px]">
            <Foto url={p?.foto ?? null} size={28} />
            <span className="flex-1 min-w-0 truncate" title={p?.titulo ?? ""}>{p?.titulo ?? `produto ${it.product_id}`}</span>
            <span className="text-[11px] text-muted-foreground font-mono">{p?.seller_sku ?? ""}</span>
            <span className="font-mono w-24 text-right">
              {it.preco_promo != null ? formatBRL(Number(it.preco_promo)) : it.desconto != null ? `−${it.desconto}%` : "—"}
            </span>
            {p?.preco != null && <span className="text-[11px] text-muted-foreground line-through font-mono">{formatBRL(Number(p.preco))}</span>}
            {editavel && (
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Tirar da promoção" disabled={removendo === chave}
                onClick={() => void remover(it)}>
                {removendo === chave ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" style={{ color: RED }} />}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export async function encerrarPromocao(p: PromoTT): Promise<boolean> {
  if (!window.confirm(`Encerrar AGORA a promoção "${p.titulo}" no TikTok?\n\nTodos os produtos voltam ao preço normal e a TikTok não deixa reativar.`)) return false;
  try {
    const r = await chamarTikTok("encerrar", { activity_id: p.activity_id }, true);
    if (!r.ok) throw new Error(r.erro ?? "recusado");
    toast.success(`Promoção "${p.titulo}" encerrada`);
    return true;
  } catch (e) {
    toast.error("O TikTok recusou", { description: (e as Error).message });
    return false;
  }
}
