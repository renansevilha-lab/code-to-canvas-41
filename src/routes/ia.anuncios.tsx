import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff, Loader2, Search, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import {
  CANAIS, CANAIS_COM_HISTORICO, ROTULO_ETAPA, nomeCanal, nomeEmpresa,
  type IaCanalHist, type IaCatalogo, type IaCatalogoLinha, type IaRascunhoResumo,
} from "@/lib/iaAnuncio";

// ============================================================================
// /ia/anuncios — o CATÁLOGO ATIVO visto pelo lado do anúncio (10/out/2026, pedido
// do dono): cada produto com onde ele vende hoje (preço e margem reais dos
// pedidos) e a situação do anúncio com IA. Busca, filtro, ordenação e paginação
// são feitos no banco (RPC ia_catalogo) — são ~2,3 mil produtos.
// ============================================================================

type Busca = { q?: string; marca?: string; sit?: string; sem?: string; ordem?: string; p?: number };

const SITUACOES = [
  { id: "todos", rotulo: "Todos" },
  { id: "sem", rotulo: "Sem anúncio com IA" },
  { id: "andamento", rotulo: "Em andamento" },
  { id: "pronto", rotulo: "Prontos" },
];
const ORDENS = [
  { id: "vendas", rotulo: "Mais vendidos (30 dias)" },
  { id: "nome", rotulo: "Nome" },
  { id: "novos", rotulo: "SKU mais novo" },
  { id: "recentes", rotulo: "Anúncio mexido por último" },
];
const POR_PAGINA = 50;
const TODAS = "__todas";

const texto = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const Route = createFileRoute("/ia/anuncios")({
  validateSearch: (s: Record<string, unknown>): Busca => ({
    q: texto(s.q),
    marca: texto(s.marca),
    sit: SITUACOES.some((x) => x.id === s.sit) && s.sit !== "todos" ? String(s.sit) : undefined,
    sem: CANAIS_COM_HISTORICO.includes(String(s.sem)) ? String(s.sem) : undefined,
    ordem: ORDENS.some((x) => x.id === s.ordem) && s.ordem !== "vendas" ? String(s.ordem) : undefined,
    p: Number(s.p) > 1 ? Math.floor(Number(s.p)) : undefined,
  }),
  component: AnunciosPage,
});

function AnunciosPage() {
  const { q, marca, sit, sem, ordem, p } = Route.useSearch();
  const nav = useNavigate({ from: "/ia/anuncios" });
  const set = (x: Partial<Busca>) => void nav({ search: (s: Busca) => ({ ...s, p: undefined, ...x }), replace: true });
  const pagina = p ?? 1;

  // busca com atraso: só vai ao banco quando a pessoa para de digitar
  const [digitado, setDigitado] = useState(q ?? "");
  useEffect(() => {
    const t = setTimeout(() => { if ((q ?? "") !== digitado.trim()) set({ q: digitado.trim() || undefined }); }, 350);
    return () => clearTimeout(t);
  }, [digitado]);

  const catQ = useQuery({
    queryKey: ["ia-anuncio", "catalogo", q ?? "", marca ?? "", sit ?? "todos", sem ?? "", ordem ?? "vendas", pagina],
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<IaCatalogo> => {
      const { data, error } = await supabaseExternal.rpc("ia_catalogo", {
        p_busca: q ?? null, p_marca: marca ?? null, p_situacao: sit ?? "todos", p_sem_canal: sem ?? null,
        p_ordem: ordem ?? "vendas", p_offset: (pagina - 1) * POR_PAGINA, p_limit: POR_PAGINA,
      });
      if (error) throw error;
      return data as IaCatalogo;
    },
  });
  const cat = catQ.data;
  const total = cat?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const canalPadrao = sem ?? "shopee";

  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Anúncios com IA</h1>
        <p className="text-sm text-muted-foreground">
          Catálogo ativo, com onde cada produto vende hoje e a situação do anúncio. Abra um produto para montar texto, preço e fotos.
          {cat?.historico_em && <> Vendas e margens dos últimos 120 dias, atualizadas em {new Date(cat.historico_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.</>}
        </p>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {SITUACOES.map((s) => {
          const ativo = (sit ?? "todos") === s.id;
          return (
            <Button key={s.id} size="sm" variant={ativo ? "default" : "outline"} className="h-8 gap-1.5"
              onClick={() => set({ sit: s.id === "todos" ? undefined : s.id })}>
              {s.rotulo}
              {cat && <span className={ativo ? "opacity-80" : "text-muted-foreground"}>{(cat.contagem[s.id] ?? 0).toLocaleString("pt-BR")}</span>}
            </Button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8 h-9" value={digitado} onChange={(e) => setDigitado(e.target.value)} placeholder="SKU ou nome do produto" />
        </div>
        <Select value={marca ?? TODAS} onValueChange={(v) => set({ marca: v === TODAS ? undefined : v })}>
          <SelectTrigger className="h-9 w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS}>Todas as marcas</SelectItem>
            {(cat?.marcas ?? []).map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sem ?? TODAS} onValueChange={(v) => set({ sem: v === TODAS ? undefined : v })}>
          <SelectTrigger className="h-9 w-[210px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={TODAS}>Vende em qualquer canal</SelectItem>
            {CANAIS.filter((c) => CANAIS_COM_HISTORICO.includes(c.id)).map((c) => (
              <SelectItem key={c.id} value={c.id}>Ainda não vende: {c.nome}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ordem ?? "vendas"} onValueChange={(v) => set({ ordem: v === "vendas" ? undefined : v })}>
          <SelectTrigger className="h-9 w-[220px]"><SelectValue /></SelectTrigger>
          <SelectContent>{ORDENS.map((o) => <SelectItem key={o.id} value={o.id}>{o.rotulo}</SelectItem>)}</SelectContent>
        </Select>
        {catQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <Card className="overflow-hidden">
        <div className="hidden lg:flex items-center gap-3 px-4 py-2 border-b bg-muted/30 text-[11px] font-medium text-muted-foreground">
          <span className="w-11 shrink-0" />
          <span className="flex-1">Produto</span>
          <span className="w-20 text-right">Custo</span>
          <span className="w-16 text-right">30 dias</span>
          <span className="w-[300px]">Onde vende hoje (preço · margem)</span>
          <span className="w-[230px]">Anúncio com IA</span>
          <span className="w-[76px]" />
        </div>
        {catQ.isLoading ? (
          <div className="p-10 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando o catálogo…</div>
        ) : catQ.isError ? (
          <div className="p-10 text-center text-destructive">Falha: {(catQ.error as Error).message}</div>
        ) : !cat?.linhas.length ? (
          <div className="p-10 text-center text-muted-foreground">Nenhum produto com esses filtros.</div>
        ) : (
          <div className="divide-y">{cat.linhas.map((x) => <Linha key={x.sku} x={x} canalPadrao={canalPadrao} />)}</div>
        )}
      </Card>

      {total > 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {((pagina - 1) * POR_PAGINA + 1).toLocaleString("pt-BR")}–{Math.min(pagina * POR_PAGINA, total).toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} produtos
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" className="h-8 gap-1" disabled={pagina <= 1} onClick={() => set({ p: pagina - 1 })}>
            <ChevronLeft className="h-4 w-4" />Anterior
          </Button>
          <span>página {pagina} de {paginas}</span>
          <Button size="sm" variant="outline" className="h-8 gap-1" disabled={pagina >= paginas} onClick={() => set({ p: pagina + 1 })}>
            Próxima<ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function Linha({ x, canalPadrao }: { x: IaCatalogoLinha; canalPadrao: string }) {
  const primeiro = x.rascunhos[0];
  return (
    <div className="flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-2.5 hover:bg-muted/20">
      <div className="h-11 w-11 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
        {x.foto ? <img src={x.foto} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="truncate text-sm font-medium" title={x.nome}>{x.nome}</div>
        <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span className="font-mono">{x.sku}</span>
          {x.marca && <span>· {x.marca}</span>}
          {x.tipo === "K" && <Badge variant="secondary" className="text-[9.5px] py-0 px-1">kit</Badge>}
          {x.tipo === "V" && <Badge variant="secondary" className="text-[9.5px] py-0 px-1">com variações</Badge>}
        </div>
      </div>
      <span className="w-20 text-right text-xs font-mono">
        {x.custo != null ? formatBRL(Number(x.custo)) : <span className="text-destructive font-sans">sem custo</span>}
      </span>
      <span className="w-16 text-right text-sm">
        {Number(x.un30) > 0 ? <><b>{Number(x.un30).toLocaleString("pt-BR")}</b> <span className="text-[10.5px] text-muted-foreground">un.</span></> : <span className="text-muted-foreground">—</span>}
      </span>
      <div className="w-full lg:w-[300px] flex flex-wrap gap-1">
        {x.canais.length === 0
          ? <span className="text-[11px] text-muted-foreground">sem venda em 120 dias</span>
          : x.canais.slice(0, 5).map((c) => <SeloCanal key={`${c.canal}-${c.empresa}`} c={c} />)}
      </div>
      <div className="w-full lg:w-[230px] flex flex-wrap gap-1">
        {x.rascunhos.length === 0
          ? <span className="text-[11px] text-muted-foreground">nenhum ainda</span>
          : x.rascunhos.slice(0, 4).map((r) => <SeloRascunho key={r.id} r={r} sku={x.sku} />)}
      </div>
      <Button asChild size="sm" variant={primeiro ? "outline" : "default"} className="h-8 w-[76px] gap-1 shrink-0">
        {primeiro ? (
          <Link to="/ia/gerar" search={{ sku: x.sku, canal: primeiro.canal, empresa: primeiro.empresa, r: primeiro.id }}>Abrir</Link>
        ) : (
          <Link to="/ia/gerar" search={{ sku: x.sku, canal: canalPadrao, empresa: "ottz" }}><Sparkles className="h-3.5 w-3.5" />Criar</Link>
        )}
      </Button>
    </div>
  );
}

/** "Shopee Ottz · R$ 41,90 · 18%" — a margem é a real dos pedidos (soma da margem ÷ soma da venda). */
function SeloCanal({ c }: { c: IaCanalHist }) {
  const mc = c.mc_pct != null ? Number(c.mc_pct) : null;
  const cor = mc == null ? "#64748B" : mc >= 0.15 ? "#0E8A5F" : mc > 0 ? "#B7791F" : "#C9432F";
  return (
    <span className="text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap"
      title={`${Number(c.un30).toLocaleString("pt-BR")} un. em 30 dias · ${Number(c.un120).toLocaleString("pt-BR")} un. em 120 dias`}>
      <b>{nomeCanal(c.canal)}</b> {nomeEmpresa(c.empresa)}
      {c.preco != null && <> · {formatBRL(Number(c.preco))}</>}
      {mc != null && <> · <span style={{ color: cor }} className="font-semibold">{(mc * 100).toFixed(0)}%</span></>}
    </span>
  );
}

function SeloRascunho({ r, sku }: { r: IaRascunhoResumo; sku: string }) {
  const st = r.texto ? ROTULO_ETAPA[r.texto] : null;
  return (
    <Link to="/ia/gerar" search={{ sku, canal: r.canal, empresa: r.empresa, r: r.id }}
      className="text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap hover:bg-muted/50">
      <b>{nomeCanal(r.canal)}</b> {nomeEmpresa(r.empresa)} ·{" "}
      <span style={{ color: st?.cor ?? "#64748B" }} className="font-semibold">{st ? `texto ${st.rotulo}` : "sem texto"}</span>
      {Number(r.andando) > 0
        ? <> · <Loader2 className="h-3 w-3 animate-spin inline -mt-0.5" /> {r.andando}</>
        : Number(r.imgs) > 0 && <> · {r.imgs_ok}/{r.imgs} fotos</>}
    </Link>
  );
}
