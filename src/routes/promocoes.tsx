import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { Zap, Loader2, RefreshCw, Plus, Trash2, Search, Send, FilePlus2, CheckCircle2, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

// ─────────────────────────────────────────────────────────────────────────────
const LOJAS = [
  { shop_id: 522186766, nome: "Ottz Pet" },
  { shop_id: 759046323, nome: "SVL Store" },
] as const;

type Slot = { timeslot_id: number; start_time: number; end_time: number };
type FlashSale = {
  flash_sale_id: number; timeslot_id: number; status: number;
  start_time: number; end_time: number; item_count: number; enabled_item_count: number;
  type: number; click_count?: number; remindme_count?: number;
};
type Model = { model_id: number; nome: string | null; model_sku: string | null; preco: number | null; estoque: number | null };
type Produto = {
  item_id: number; nome: string; item_sku: string | null; has_model: boolean;
  preco: number | null; estoque: number | null; imagem: string | null; models: Model[];
};
interface CartItem {
  key: string; item_id: number; model_id: number | null; has_model: boolean;
  nome: string; preco_orig: number | null; promo: string; stock: string; limit: string;
}

const fmtData = (epoch: number) =>
  new Date(epoch * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const TIPO_LABEL: Record<number, string> = { 1: "Programada", 2: "Em andamento", 3: "Encerrada" };

async function chamar(body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabaseExternal.functions.invoke("shopee-flashsale", { body });
  if (error) throw new Error(error.message);
  if (data?.erro) throw new Error(data.erro);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
type SearchParams = { shop: number };

export const Route = createFileRoute("/promocoes")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    shop: LOJAS.some((l) => l.shop_id === Number(s.shop)) ? Number(s.shop) : LOJAS[0].shop_id,
  }),
  component: PromocoesPage,
});

function PromocoesPage() {
  const { shop } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setShop = (s: number) => navigate({ search: { shop: s }, replace: true });

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
      <header>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Zap className="h-6 w-6" /> Promoções Relâmpago (Shopee)
          </h1>
          <div className="inline-flex rounded-md border bg-card p-0.5">
            {LOJAS.map((l) => (
              <button
                key={l.shop_id}
                onClick={() => setShop(l.shop_id)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-sm transition",
                  shop === l.shop_id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {l.nome}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Criar/gerir flash sales da loja pela API. Criação nasce como <strong>rascunho (desativada)</strong>; ativar é
          um passo separado — muda preço na loja <strong>ao vivo</strong>.
        </p>
      </header>

      {/* key força remontar (limpa o wizard) ao trocar de loja */}
      <CriarWizard key={`criar-${shop}`} shop={shop} />
      <ListaExistentes key={`lista-${shop}`} shop={shop} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Lista das flash sales existentes
function ListaExistentes({ shop }: { shop: number }) {
  const q = useQuery({
    queryKey: ["flashsale", "list", shop],
    queryFn: async () => {
      const d = await chamar({ modulo: "list", shop_id: shop, type: 0, limit: 30 });
      return (d.flash_sale_list ?? []) as FlashSale[];
    },
  });
  const rows = q.data ?? [];

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 p-4 border-b">
        <h3 className="text-sm font-semibold">Flash sales existentes {q.data && <span className="text-muted-foreground font-normal">({rows.length})</span>}</h3>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Atualizar
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-3 py-2">Período</th>
              <th className="text-left font-medium px-3 py-2">Situação</th>
              <th className="text-right font-medium px-3 py-2">Itens (ativos)</th>
              <th className="text-right font-medium px-3 py-2">Cliques</th>
              <th className="text-right font-medium px-3 py-2">Lembretes</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i} className="border-t"><td colSpan={5} className="px-3 py-3"><Skeleton className="h-5 w-full" /></td></tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-10 text-center text-sm text-muted-foreground">Nenhuma flash sale nesta loja.</td></tr>
            ) : (
              rows.map((f) => (
                <tr key={f.flash_sale_id} className="border-t hover:bg-accent/40">
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{fmtData(f.start_time)} → {fmtData(f.end_time)}</td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className="text-[10px] h-5 px-1.5">{TIPO_LABEL[f.type] ?? `tipo ${f.type}`}{f.status === 1 ? " · ativa" : " · off"}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.item_count}{typeof f.enabled_item_count === "number" ? ` (${f.enabled_item_count})` : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.click_count ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.remindme_count ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard de criação
function CriarWizard({ shop }: { shop: number }) {
  const [slotSel, setSlotSel] = useState<number | null>(null);
  const [criando, setCriando] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [ativando, setAtivando] = useState(false);
  const [ativada, setAtivada] = useState(false);

  const slotsQuery = useQuery({
    queryKey: ["flashsale", "slots", shop],
    queryFn: async () => {
      const d = await chamar({ modulo: "slots", shop_id: shop, dias: 7 });
      return (d.slots ?? []) as Slot[];
    },
  });
  const slots = slotsQuery.data ?? [];

  async function criarRascunho() {
    if (!slotSel) return;
    const s = slots.find((x) => x.timeslot_id === slotSel);
    if (!window.confirm(`Criar rascunho de flash sale no horário ${s ? fmtData(s.start_time) : ""}?\n\nNasce DESATIVADA (não fica pública ainda).`)) return;
    setCriando(true);
    try {
      const d = await chamar({ modulo: "criar", shop_id: shop, timeslot_id: slotSel, confirmar: "1" });
      if (!d.ok || !d.flash_sale_id) throw new Error(d.message || d.error || "Shopee não confirmou a criação");
      setDraftId(d.flash_sale_id);
      setAtivada(false);
      toast.success(`Rascunho criado (id ${d.flash_sale_id})`, { description: "Agora adicione produtos e ative." });
    } catch (e) {
      toast.error("Falha ao criar rascunho", { description: (e as Error).message });
    } finally {
      setCriando(false);
    }
  }

  async function enviarItens() {
    if (!draftId || cart.length === 0) return;
    // valida inputs
    for (const c of cart) {
      if (!(Number(c.promo) > 0) || !(Number(c.stock) > 0)) {
        toast.warning(`Preencha preço e estoque de "${c.nome}"`);
        return;
      }
    }
    const byItem = new Map<number, any>();
    for (const c of cart) {
      if (c.has_model) {
        if (!byItem.has(c.item_id)) byItem.set(c.item_id, { item_id: c.item_id, purchase_limit: Number(c.limit) || 0, models: [] });
        byItem.get(c.item_id).models.push({ model_id: c.model_id, input_promo_price: Number(c.promo), stock: Number(c.stock) });
      } else {
        byItem.set(c.item_id, { item_id: c.item_id, purchase_limit: Number(c.limit) || 0, item_input_promo_price: Number(c.promo), item_stock: Number(c.stock) });
      }
    }
    const items = Array.from(byItem.values());
    if (!window.confirm(`Adicionar ${cart.length} item(ns) ao rascunho ${draftId}?\n\nAinda NÃO fica público (só depois de ativar).`)) return;
    setEnviando(true);
    try {
      const d = await chamar({ modulo: "add-items", shop_id: shop, flash_sale_id: draftId, confirmar: "1", items });
      if (!d.ok) throw new Error(d.message || d.error || "Shopee não confirmou");
      const failed = d.response?.failed_items?.length || 0;
      toast.success(`Itens enviados${failed ? ` (${failed} rejeitados por elegibilidade)` : ""}`, {
        description: failed ? "Confira os rejeitados no painel da Shopee." : "Revise e clique em Ativar.",
      });
    } catch (e) {
      toast.error("Falha ao adicionar itens", { description: (e as Error).message });
    } finally {
      setEnviando(false);
    }
  }

  async function ativar() {
    if (!draftId) return;
    if (!window.confirm(`ATIVAR a flash sale ${draftId} na loja?\n\n⚠️ Fica PÚBLICA e muda o preço ao vivo. Definitivo (dá pra desativar depois no painel).`)) return;
    setAtivando(true);
    try {
      const d = await chamar({ modulo: "ativar", shop_id: shop, flash_sale_id: draftId, status: 1, confirmar: "1" });
      if (!d.ok) throw new Error(d.message || d.error || "Shopee não confirmou");
      setAtivada(true);
      toast.success("Flash sale ATIVADA");
    } catch (e) {
      toast.error("Falha ao ativar", { description: (e as Error).message });
    } finally {
      setAtivando(false);
    }
  }

  function resetar() {
    setDraftId(null); setCart([]); setSlotSel(null); setAtivada(false);
  }

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold flex items-center gap-2"><FilePlus2 className="h-4 w-4" /> Criar promoção</h3>
        {draftId && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetar}>Começar outra</Button>
        )}
      </div>

      {/* Passo 1: slot + criar rascunho */}
      {!draftId ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Horário (próximos 7 dias)</label>
            <select
              className="h-9 rounded-md border bg-card px-2 text-sm min-w-[220px]"
              value={slotSel ?? ""}
              onChange={(e) => setSlotSel(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{slotsQuery.isLoading ? "carregando..." : "selecione um horário"}</option>
              {slots.map((s) => (
                <option key={s.timeslot_id} value={s.timeslot_id}>{fmtData(s.start_time)} → {fmtData(s.end_time)}</option>
              ))}
            </select>
          </div>
          <Button size="sm" className="h-9 gap-1.5" disabled={!slotSel || criando} onClick={() => void criarRascunho()}>
            {criando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus2 className="h-4 w-4" />}
            Criar rascunho
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline" className="gap-1">Rascunho #{draftId}</Badge>
            {ativada
              ? <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 text-xs"><CheckCircle2 className="h-3.5 w-3.5" /> ativada</span>
              : <span className="text-xs text-muted-foreground">desativada (não pública)</span>}
          </div>

          {/* Passo 2: catálogo + carrinho */}
          <CatalogoPicker shop={shop} cart={cart} setCart={setCart} />

          {cart.length > 0 && (
            <CarrinhoEditor cart={cart} setCart={setCart} />
          )}

          {/* Passo 3: enviar itens + ativar */}
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button size="sm" className="h-9 gap-1.5" disabled={cart.length === 0 || enviando} onClick={() => void enviarItens()}>
              {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Adicionar {cart.length} ao rascunho
            </Button>
            <Button
              size="sm" variant="outline"
              className="h-9 gap-1.5 border-emerald-500/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
              disabled={ativando || ativada}
              onClick={() => void ativar()}
            >
              {ativando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Ativar (fica público)
            </Button>
            <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
              <ExternalLink className="h-3 w-3" /> Adicione os itens antes de ativar. Rejeições por elegibilidade aparecem no aviso.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seletor de catálogo (paginado, busca por nome na página)
function CatalogoPicker({ shop, cart, setCart }: { shop: number; cart: CartItem[]; setCart: Dispatch<SetStateAction<CartItem[]>> }) {
  const [offset, setOffset] = useState(0);
  const [busca, setBusca] = useState("");

  const q = useQuery({
    queryKey: ["flashsale", "catalogo", shop, offset],
    queryFn: async () => {
      const d = await chamar({ modulo: "catalogo", shop_id: shop, offset, limit: 20 });
      return d as { produtos: Produto[]; tem_proxima: boolean; next_offset: number | null };
    },
  });
  const produtos = q.data?.produtos ?? [];
  const filtrados = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return t ? produtos.filter((p) => (p.nome || "").toLowerCase().includes(t) || (p.item_sku || "").toLowerCase().includes(t)) : produtos;
  }, [produtos, busca]);

  const noCarrinho = (key: string) => cart.some((c) => c.key === key);
  function addAo(item: Produto, model: Model | null) {
    const key = model ? `${item.item_id}:${model.model_id}` : `${item.item_id}`;
    if (noCarrinho(key)) return;
    setCart((c) => [...c, {
      key, item_id: item.item_id, model_id: model?.model_id ?? null, has_model: item.has_model,
      nome: model ? `${item.nome} · ${model.nome ?? model.model_sku ?? model.model_id}` : item.nome,
      preco_orig: model ? model.preco : item.preco, promo: "", stock: "", limit: "0",
    }]);
  }

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 p-2 border-b">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Filtrar nesta página..." className="pl-8 h-8" />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-8" disabled={offset === 0 || q.isFetching} onClick={() => setOffset((o) => Math.max(0, o - 20))}>Anterior</Button>
          <Button variant="outline" size="sm" className="h-8" disabled={!q.data?.tem_proxima || q.isFetching} onClick={() => setOffset(q.data?.next_offset ?? offset + 20)}>Próxima</Button>
        </div>
      </div>
      <div className="max-h-[320px] overflow-y-auto divide-y">
        {q.isLoading ? (
          <div className="p-4"><Skeleton className="h-24 w-full" /></div>
        ) : filtrados.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Nenhum produto nesta página.</div>
        ) : (
          filtrados.map((p) => (
            <div key={p.item_id} className="p-2.5 flex gap-3 items-start">
              {p.imagem
                ? <img src={p.imagem} alt="" className="h-10 w-10 rounded object-cover shrink-0" />
                : <div className="h-10 w-10 rounded bg-muted shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{p.nome}</div>
                {!p.has_model ? (
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                    <span>{p.preco != null ? formatBRL(p.preco) : "—"}</span>
                    <span>· estoque {p.estoque ?? "—"}</span>
                    <Button size="sm" variant="outline" className="h-6 text-xs ml-auto" disabled={noCarrinho(`${p.item_id}`)} onClick={() => addAo(p, null)}>
                      {noCarrinho(`${p.item_id}`) ? "no carrinho" : "adicionar"}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1 space-y-1">
                    {p.models.map((m) => (
                      <div key={m.model_id} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{m.nome ?? m.model_sku ?? m.model_id}</span>
                        <span>· {m.preco != null ? formatBRL(m.preco) : "—"}</span>
                        <span>· est. {m.estoque ?? "—"}</span>
                        <Button size="sm" variant="outline" className="h-6 text-xs ml-auto" disabled={noCarrinho(`${p.item_id}:${m.model_id}`)} onClick={() => addAo(p, m)}>
                          {noCarrinho(`${p.item_id}:${m.model_id}`) ? "ok" : "adicionar"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor do carrinho (preço promo / estoque / limite)
function CarrinhoEditor({ cart, setCart }: { cart: CartItem[]; setCart: Dispatch<SetStateAction<CartItem[]>> }) {
  const set = (key: string, campo: "promo" | "stock" | "limit", v: string) =>
    setCart((c) => c.map((x) => (x.key === key ? { ...x, [campo]: v } : x)));
  const remover = (key: string) => setCart((c) => c.filter((x) => x.key !== key));

  return (
    <div className="rounded-md border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Produto</th>
            <th className="text-right font-medium px-3 py-2">Preço atual</th>
            <th className="text-left font-medium px-3 py-2 w-28">Preço promo</th>
            <th className="text-left font-medium px-3 py-2 w-24">Estoque</th>
            <th className="text-left font-medium px-3 py-2 w-24">Limite/compra</th>
            <th className="text-right font-medium px-3 py-2">Desc.</th>
            <th className="w-8"></th>
          </tr>
        </thead>
        <tbody>
          {cart.map((c) => {
            const promo = Number(c.promo);
            const desc = c.preco_orig && promo > 0 ? Math.round((1 - promo / c.preco_orig) * 100) : null;
            return (
              <tr key={c.key} className="border-t">
                <td className="px-3 py-2 max-w-[280px] truncate">{c.nome}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{c.preco_orig != null ? formatBRL(c.preco_orig) : "—"}</td>
                <td className="px-3 py-1.5"><Input value={c.promo} onChange={(e) => set(c.key, "promo", e.target.value)} inputMode="decimal" placeholder="0,00" className="h-8" /></td>
                <td className="px-3 py-1.5"><Input value={c.stock} onChange={(e) => set(c.key, "stock", e.target.value)} inputMode="numeric" placeholder="0" className="h-8" /></td>
                <td className="px-3 py-1.5"><Input value={c.limit} onChange={(e) => set(c.key, "limit", e.target.value)} inputMode="numeric" placeholder="0" className="h-8" /></td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {desc != null ? <span className={cn(desc <= 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}>{desc}%</span> : "—"}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => remover(c.key)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
