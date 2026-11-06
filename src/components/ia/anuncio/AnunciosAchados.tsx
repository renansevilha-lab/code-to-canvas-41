import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink, Loader2, Pencil } from "lucide-react";

import { Card } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";

// ============================================================================
// Busca de /ia/anuncios também pelos ANÚNCIOS (14/out/2026, pedido do dono): a lista do catálogo
// acha por SKU ou nome do Tiny; aqui o mesmo texto procura nos espelhos da Shopee (duas lojas) e do
// Mercado Livre (só a Ottz tem espelho) — por ID do anúncio (item_id / MLB…) ou pelo título dele — e
// mostra os SKUs de cada anúncio. Clicar no SKU filtra a lista por ele. "Editar no app" (06/nov) abre /ia/gerar no
// produto do anúncio com a conferência já no modo atualizar daquele anúncio (a escrita é a de sempre, com confirmação).
// ============================================================================

const LOJA_SHOPEE: Record<number, string> = { 522186766: "Shopee · Ottz", 759046323: "Shopee · Bumi" };
const EMPRESA_SHOPEE: Record<number, string> = { 522186766: "ottz", 759046323: "svl" };

type Achado = {
  canal: "shopee" | "ml";
  loja: string;
  id: string;
  titulo: string;
  status: string | null;
  url: string;
  skus: string[];
  /** onde abrir para editar: o produto do anúncio (pai das variações quando há), canal e empresa do app */
  editar: { sku: string; canal: string; empresa: string } | null;
};

const ehIdShopee = (t: string) => /^\d{8,}$/.test(t);
const ehIdMl = (t: string) => /^mlb-?\d{6,}$/i.test(t) || /^\d{9,}$/.test(t);

async function buscar(t: string): Promise<Achado[]> {
  const termo = t.replace(/[%,()]/g, " ").trim();
  const porId = ehIdShopee(termo) || ehIdMl(termo);
  const out: Achado[] = [];

  // ---- Shopee
  const sh = porId && ehIdShopee(termo)
    ? await supabaseExternal.from("shopee_anuncios").select("item_id, shop_id, nome, status, sku_pai").eq("item_id", termo).limit(5)
    : await supabaseExternal.from("shopee_anuncios").select("item_id, shop_id, nome, status, sku_pai")
        .ilike("nome", `%${termo}%`).in("status", ["NORMAL", "UNLIST"]).order("vendas", { ascending: false, nullsFirst: false }).limit(12);
  const itens = ((sh.data ?? []) as Array<{ item_id: number | string; shop_id: number; nome: string | null; status: string | null; sku_pai: string | null }>);
  if (itens.length) {
    const { data: vars } = await supabaseExternal.from("shopee_anuncios_variacao").select("item_id, shop_id, sku")
      .in("item_id", itens.map((i) => String(i.item_id))).limit(500);
    for (const i of itens) {
      const skus = new Set<string>();
      if (i.sku_pai) skus.add(i.sku_pai);
      for (const v of (vars ?? []) as Array<{ item_id: number | string; shop_id: number; sku: string | null }>) {
        if (String(v.item_id) === String(i.item_id) && v.shop_id === i.shop_id && v.sku) skus.add(v.sku);
      }
      out.push({
        canal: "shopee", loja: LOJA_SHOPEE[i.shop_id] ?? `Shopee · ${i.shop_id}`, id: String(i.item_id), titulo: i.nome ?? "—",
        status: i.status, url: `https://shopee.com.br/product/${i.shop_id}/${i.item_id}`, skus: [...skus],
        editar: EMPRESA_SHOPEE[i.shop_id] ? { sku: "", canal: "shopee", empresa: EMPRESA_SHOPEE[i.shop_id] } : null,
      });
    }
  }

  // ---- Mercado Livre (espelho = conta Ottz)
  const mlb = ehIdMl(termo) ? `MLB${termo.replace(/\D/g, "")}` : null;
  const ml = mlb
    ? await supabaseExternal.from("ml_anuncios").select("mlb, sku, titulo, status, permalink").eq("mlb", mlb).limit(5)
    : await supabaseExternal.from("ml_anuncios").select("mlb, sku, titulo, status, permalink")
        .ilike("titulo", `%${termo}%`).in("status", ["active", "paused"]).order("visitas_30d", { ascending: false, nullsFirst: false }).limit(12);
  for (const m of (ml.data ?? []) as Array<{ mlb: string; sku: string | null; titulo: string | null; status: string | null; permalink: string | null }>) {
    out.push({
      canal: "ml", loja: "Mercado Livre · Ottz", id: m.mlb, titulo: m.titulo ?? "—", status: m.status,
      url: m.permalink || `https://produto.mercadolivre.com.br/${m.mlb.replace(/^MLB/, "MLB-")}`, skus: m.sku ? [m.sku] : [],
      editar: { sku: "", canal: "mercado_livre", empresa: "ottz" },
    });
  }
  await resolverProduto(out);
  return out;
}

/** Qual produto do catálogo abrir para editar o anúncio: o SKU do anúncio (item_sku) se é produto ativo; senão o
 *  pai comum das variações; senão o único SKU. Anúncio sem SKU do catálogo fica sem o botão. */
async function resolverProduto(lista: Achado[]) {
  const todos = [...new Set(lista.flatMap((a) => a.skus))];
  if (!todos.length) { for (const a of lista) a.editar = null; return; }
  const { data } = await supabaseExternal.from("produtos").select("sku, sku_pai, ativo").in("sku", todos).limit(1000);
  const prod = new Map(((data ?? []) as Array<{ sku: string; sku_pai: string | null; ativo: boolean | null }>).map((x) => [x.sku, x]));
  for (const a of lista) {
    if (!a.editar) continue;
    const ativos = a.skus.filter((s) => prod.get(s)?.ativo);
    const pais = [...new Set(ativos.map((s) => prod.get(s)?.sku_pai).filter((x): x is string => !!x))];
    const sku = ativos.length === 0 ? null
      : ativos.includes(a.skus[0]) && (a.skus.length === 1 || !prod.get(a.skus[0])?.sku_pai) ? a.skus[0]
      : pais.length === 1 ? pais[0]
      : ativos[0];
    a.editar = sku ? { ...a.editar, sku } : null;
  }
}

export function AnunciosAchados({ busca, onSku }: { busca: string; onSku: (sku: string) => void }) {
  const t = busca.trim();
  const porId = ehIdShopee(t) || ehIdMl(t);
  const [aberto, setAberto] = useState(false);
  const q = useQuery({
    queryKey: ["ia-anuncio", "anuncios-achados", t],
    enabled: t.length >= 3,
    staleTime: 60_000,
    queryFn: () => buscar(t),
  });
  if (t.length < 3) return null;
  if (q.isLoading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Procurando também nos anúncios da Shopee e do Mercado Livre…
      </p>
    );
  }
  const achados = q.data ?? [];
  if (!achados.length) {
    return porId ? (
      <p className="text-xs text-muted-foreground">
        Nenhum anúncio com o ID {t} nos espelhos da Shopee e do Mercado Livre (o Mercado Livre da SVL não tem espelho).
      </p>
    ) : null;
  }
  const mostrar = porId || aberto;
  return (
    <Card className="p-3 space-y-2">
      <button type="button" className="flex w-full items-center gap-2 text-left text-sm font-medium" onClick={() => setAberto((a) => !a)}>
        <ChevronDown className={cn("h-4 w-4 transition-transform", !mostrar && "-rotate-90")} />
        {porId ? "Anúncio com este ID" : `Anúncios com "${t}" no título`}
        <span className="text-muted-foreground font-normal">({achados.length}{achados.length >= 12 ? "+" : ""})</span>
        {!porId && !mostrar && <span className="text-xs text-muted-foreground font-normal">· clique para ver</span>}
      </button>
      {mostrar && (
        <div className="divide-y">
          {achados.map((a) => (
            <div key={`${a.canal}:${a.loja}:${a.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold",
                a.canal === "shopee" ? "bg-[#EE4D2D]/10 text-[#EE4D2D]" : "bg-[#E8B500]/15 text-[#9A7800]")}>{a.loja}</span>
              <span className="min-w-0 flex-1 truncate" title={a.titulo}>{a.titulo}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{a.id}</span>
              {a.status && !["NORMAL", "active"].includes(a.status) && (
                <span className="text-[11px] text-amber-600">{a.status === "UNLIST" || a.status === "paused" ? "fora do ar" : a.status}</span>
              )}
              <span className="flex flex-wrap gap-1">
                {a.skus.length ? a.skus.map((s) => (
                  <button key={s} type="button" onClick={() => onSku(s)} title="Mostrar este produto na lista"
                    className="rounded border px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent">{s}</button>
                )) : <span className="text-[11px] text-muted-foreground">sem SKU</span>}
              </span>
              {a.editar ? (
                <Link to="/ia/gerar" search={{ sku: a.editar.sku, canal: a.editar.canal, empresa: a.editar.empresa, item: a.id }}
                  title={`Abrir no app o produto ${a.editar.sku} com este anúncio pronto para atualizar`}
                  className="inline-flex items-center gap-1 rounded border border-primary/50 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10">
                  <Pencil className="h-3 w-3" />Editar no app
                </Link>
              ) : <span className="text-[11px] text-muted-foreground" title="Nenhum SKU deste anúncio está ativo no catálogo">sem produto no catálogo</span>}
              <a href={a.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Abrir o anúncio">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
