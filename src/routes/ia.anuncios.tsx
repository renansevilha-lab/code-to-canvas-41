import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ImageOff, ImagePlus, Layers, Loader2, MoreHorizontal, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CriarVariacoes } from "@/components/ia/anuncio/CriarVariacoes";
import { CriarVariacoesCores } from "@/components/ia/anuncio/CriarVariacoesCores";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarVariacoes } from "@/lib/iaAnuncio";
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

type Busca = { q?: string; marca?: string; sit?: string; tipo?: string; sem?: string; ordem?: string; p?: number };

const SITUACOES = [
  { id: "todos", rotulo: "Todos" },
  { id: "sem", rotulo: "Sem anúncio com IA" },
  { id: "andamento", rotulo: "Em andamento" },
  { id: "pronto", rotulo: "Prontos" },
  // fila de capas a fazer: recebeu fotos aproveitadas da família e ainda não tem capa própria aprovada
  { id: "sem_capa", rotulo: "Fotos da família, sem capa própria" },
];
const ORDENS = [
  { id: "vendas", rotulo: "Mais vendidos (30 dias)" },
  { id: "vendas120", rotulo: "Mais vendidos (geral · 120 dias)" },
  { id: "nome", rotulo: "Nome" },
  { id: "novos", rotulo: "SKU mais novo" },
  { id: "recentes", rotulo: "Anúncio mexido por último" },
];
// tipo do produto, como as abas do Tiny (o "com variações" é o produto pai)
const TIPOS = [
  { id: "todos", rotulo: "Todos os tipos" },
  { id: "S", rotulo: "Simples" },
  { id: "K", rotulo: "Kits" },
  { id: "V", rotulo: "Com variações" },
  // criados pelo app em "Criar produto com variações" (produtos.criado_app_em); só aparece quando a RPC conta
  { id: "APP", rotulo: "Criados no app" },
];
const POR_PAGINA = 50;
const TODAS = "__todas";

const texto = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const Route = createFileRoute("/ia/anuncios")({
  validateSearch: (s: Record<string, unknown>): Busca => ({
    q: texto(s.q),
    marca: texto(s.marca),
    sit: SITUACOES.some((x) => x.id === s.sit) && s.sit !== "todos" ? String(s.sit) : undefined,
    tipo: ["S", "K", "V", "APP"].includes(String(s.tipo)) ? String(s.tipo) : undefined,
    sem: CANAIS_COM_HISTORICO.includes(String(s.sem)) ? String(s.sem) : undefined,
    ordem: ORDENS.some((x) => x.id === s.ordem) && s.ordem !== "vendas" ? String(s.ordem) : undefined,
    p: Number(s.p) > 1 ? Math.floor(Number(s.p)) : undefined,
  }),
  component: AnunciosPage,
});

function AnunciosPage() {
  const { q, marca, sit, tipo, sem, ordem, p } = Route.useSearch();
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
    queryKey: ["ia-anuncio", "catalogo", q ?? "", marca ?? "", sit ?? "todos", tipo ?? "", sem ?? "", ordem ?? "vendas", pagina],
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<IaCatalogo> => {
      const { data, error } = await supabaseExternal.rpc("ia_catalogo", {
        p_busca: q ?? null, p_marca: marca ?? null, p_situacao: sit ?? "todos", p_sem_canal: sem ?? null,
        p_ordem: ordem ?? "vendas", p_offset: (pagina - 1) * POR_PAGINA, p_limit: POR_PAGINA, p_tipo: tipo ?? null,
      });
      if (error) throw error;
      return data as IaCatalogo;
    },
  });
  const cat = catQ.data;
  // FOTO NA HORA: a lista lê a foto de uma tabela que só é refeita a cada 3 h; quem ainda aparece sem
  // foto é conferido direto no cadastro (`produtos.foto_capa`, que o envio de fotos ao Tiny grava na hora)
  const semFoto = (cat?.linhas ?? []).flatMap((x) => [x, ...(x.variacoes ?? [])]).filter((x) => !x.foto).map((x) => x.sku);
  const capasQ = useQuery({
    queryKey: ["ia-anuncio", "capas", semFoto.join(",")],
    enabled: semFoto.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data } = await supabaseExternal.from("produtos").select("sku, foto_capa").in("sku", semFoto).not("foto_capa", "is", null);
      return Object.fromEntries(((data ?? []) as { sku: string; foto_capa: string }[]).map((d) => [d.sku, d.foto_capa]));
    },
  });
  const comCapa = (x: IaCatalogoLinha): IaCatalogoLinha => ({
    ...x, foto: x.foto ?? capasQ.data?.[x.sku] ?? null,
    ...(x.variacoes ? { variacoes: x.variacoes.map((v) => ({ ...v, foto: v.foto ?? capasQ.data?.[v.sku] ?? null })) } : {}),
  });
  const total = cat?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const canalPadrao = sem ?? "shopee";
  // menu "…" da linha → criar no Tiny um produto com variações a partir deste produto simples
  const [variacoesDe, setVariacoesDe] = useState<string | null>(null);
  // seleção de produtos SIMPLES (vale entre páginas e buscas) → um produto com variações de cor × quantidade
  const [selecionados, setSelecionados] = useState<string[]>([]);
  const [coresAberto, setCoresAberto] = useState(false);
  const alternar = (sku: string) => setSelecionados((s) => (s.includes(sku) ? s.filter((x) => x !== sku) : [...s, sku]));

  // kits como no Tiny: a composicao (quantidade x componente) aparece na linha. So os kits da pagina.
  const skusKit = (cat?.linhas ?? []).filter((x) => x.tipo === "K").map((x) => x.sku);
  const kitsQ = useQuery({
    queryKey: ["ia-anuncio", "composicoes", skusKit.join(",")],
    enabled: skusKit.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("produto_kits").select("sku_kit, sku_componente, quantidade, nome_componente").in("sku_kit", skusKit).limit(1000);
      if (error) throw error;
      const por: Record<string, Componente[]> = {};
      for (const c of (data ?? []) as (Componente & { sku_kit: string })[]) (por[c.sku_kit] ??= []).push(c);
      return por;
    },
  });

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
        {SITUACOES.filter((s) => s.id !== "sem_capa" || cat?.contagem.sem_capa !== undefined).map((s) => {
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

      {cat?.tipos && (
        <div className="flex flex-wrap gap-1.5">
          {TIPOS.filter((x) => x.id !== "APP" || cat.tipos?.APP !== undefined).map((x) => {
            const ativo = (tipo ?? "todos") === x.id;
            return (
              <Button key={x.id} size="sm" variant={ativo ? "secondary" : "ghost"} className={`h-7 gap-1.5 text-xs ${ativo ? "ring-1 ring-primary/40" : ""}`}
                onClick={() => set({ tipo: x.id === "todos" ? undefined : x.id })}>
                {x.rotulo}
                <span className="text-muted-foreground">{(cat.tipos?.[x.id] ?? 0).toLocaleString("pt-BR")}</span>
              </Button>
            );
          })}
        </div>
      )}

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
          <SelectContent>{ORDENS.filter((o) => o.id !== "vendas120" || (cat?.versao ?? 1) >= 2 || ordem === "vendas120").map((o) => <SelectItem key={o.id} value={o.id}>{o.rotulo}</SelectItem>)}</SelectContent>
        </Select>
        {catQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {selecionados.length > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-background/95 px-3 py-2 text-sm shadow-sm backdrop-blur">
          <span><b>{selecionados.length}</b> produto(s) selecionado(s): <span className="font-mono text-xs text-muted-foreground">{selecionados.join(", ")}</span></span>
          <div className="flex-1" />
          <Button size="sm" className="h-8 gap-1.5" disabled={selecionados.length < 2} onClick={() => setCoresAberto(true)}
            title={selecionados.length < 2 ? "Selecione ao menos 2 produtos (um por cor)" : undefined}>
            <Layers className="h-4 w-4" />Criar produto com variações (cor × quantidade)
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelecionados([])}>Limpar</Button>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="hidden lg:flex items-center gap-3 px-4 py-2 border-b bg-muted/30 text-[11px] font-medium text-muted-foreground">
          <span className="w-4 shrink-0" />
          <span className="w-11 shrink-0" />
          <span className="flex-1">Produto</span>
          <span className="w-20 text-right">Custo</span>
          <span className="w-16 text-right">30 dias</span>
          <span className="w-[300px]">Onde vende hoje (preço · margem)</span>
          <span className="w-[230px]">Anúncio com IA</span>
          <span className="w-8" />
          <span className="w-[76px]" />
        </div>
        {catQ.isLoading ? (
          <div className="p-10 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando o catálogo…</div>
        ) : catQ.isError ? (
          <div className="p-10 text-center text-destructive">Falha: {(catQ.error as Error).message}</div>
        ) : !cat?.linhas.length ? (
          <div className="p-10 text-center text-muted-foreground">Nenhum produto com esses filtros.</div>
        ) : (
          <div className="divide-y">{cat.linhas.map((x) => <Linha key={x.sku} x={comCapa(x)} canalPadrao={canalPadrao} composicao={kitsQ.data?.[x.sku]} onVariacoes={setVariacoesDe}
            selecionado={selecionados.includes(x.sku)} onSelecionar={alternar} />)}</div>
        )}
      </Card>

      {variacoesDe && <CriarVariacoes sku={variacoesDe} onFechar={() => setVariacoesDe(null)} />}
      {coresAberto && <CriarVariacoesCores skus={selecionados} onFechar={() => { setCoresAberto(false); setSelecionados([]); }} />}

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

interface Componente { sku_componente: string; quantidade: number; nome_componente: string | null }

/** Produto criado pelo app: põe a foto principal do produto base no pai e nas variações que ainda não têm foto no Tiny. */
async function copiarFotoDoBase(sku: string) {
  if (!window.confirm(`Pôr no Tiny a foto principal do produto base em ${sku} e nas variações que ainda estão sem foto?`)) return;
  const aviso = toast.loading("Copiando a foto do produto base…");
  try {
    const r = (await chamarVariacoes("foto", { sku_pai: sku, confirmar: true })) as {
      ok: boolean; erro?: string; itens?: { sku: string; ok: boolean; ja_tinha?: boolean; erro?: string | null }[];
    };
    const itens = r.itens ?? [];
    const novas = itens.filter((i) => i.ok && !i.ja_tinha).length;
    const falhas = itens.filter((i) => !i.ok);
    if (r.erro || falhas.length) toast.error("A foto não entrou em tudo", { id: aviso, description: r.erro ?? falhas.map((i) => `${i.sku}: ${i.erro}`).join(" · "), duration: 15000 });
    else toast.success(novas ? `Foto copiada para ${novas} produto(s)` : "Todos já tinham foto", { id: aviso, description: "Na lista, a foto aparece em até 3 horas.", duration: 8000 });
  } catch (e) { toast.error("Não consegui copiar a foto", { id: aviso, description: (e as Error).message, duration: 15000 }); }
}

/**
 * Uma linha do catálogo. Como no Tiny: o kit mostra a composição, e o produto com variações
 * abre as variações logo abaixo (cada uma com venda, canais e anúncio próprios).
 */
function Linha({ x, canalPadrao, composicao, variacao, onVariacoes, selecionado, onSelecionar }: {
  x: IaCatalogoLinha; canalPadrao: string; composicao?: Componente[]; variacao?: boolean; onVariacoes?: (sku: string) => void;
  selecionado?: boolean; onSelecionar?: (sku: string) => void;
}) {
  const podeSelecionar = !!onSelecionar && !variacao && x.tipo === "S";
  const primeiro = x.rascunhos[0];
  const filhas = x.variacoes ?? [];
  const [aberto, setAberto] = useState(false);
  return (
    <>
    <div className={`flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-2 px-4 py-2.5 hover:bg-muted/20 ${variacao ? "lg:pl-12 bg-muted/10" : ""} ${selecionado ? "bg-primary/5" : ""}`}>
      <span className="w-4 shrink-0 flex items-center">
        {podeSelecionar && (
          <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer" checked={!!selecionado} onChange={() => onSelecionar!(x.sku)}
            title="Selecionar para criar um produto com variações de cor × quantidade" />
        )}
      </span>
      <div className="h-11 w-11 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
        {x.foto ? <img src={x.foto} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="truncate text-sm font-medium" title={x.nome}>{x.nome}</div>
        <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span className="font-mono">{x.sku}</span>
          {x.marca && <span>· {x.marca}</span>}
          {x.tipo === "K" && <Badge variant="secondary" className="text-[9.5px] py-0 px-1">kit</Badge>}
          {x.tipo === "V" && filhas.length === 0 && <Badge variant="secondary" className="text-[9.5px] py-0 px-1">com variações</Badge>}
          {variacao && <Badge variant="outline" className="text-[9.5px] py-0 px-1">variação</Badge>}
          {x.criado_app && <Badge variant="outline" className="text-[9.5px] py-0 px-1 border-primary/50 text-primary">criado no app</Badge>}
          {x.sem_capa && <Badge variant="outline" className="text-[9.5px] py-0 px-1 border-amber-500/60 text-amber-700 dark:text-amber-400">fotos da família · falta a capa</Badge>}
          {filhas.length > 0 && (
            <button type="button" onClick={() => setAberto((v) => !v)}
              className="inline-flex items-center gap-0.5 rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground hover:bg-secondary/70">
              {aberto ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}{filhas.length} variações
            </button>
          )}
        </div>
        {composicao && composicao.length > 0 && (
          <div className="text-[11px] text-muted-foreground truncate" title={composicao.map((c) => `${Number(c.quantidade)}× ${c.sku_componente} ${c.nome_componente ?? ""}`).join(" + ")}>
            {composicao.slice(0, 3).map((c, i) => (
              <span key={c.sku_componente}>
                {i > 0 && " + "}<b className="text-foreground/80">{Number(c.quantidade).toLocaleString("pt-BR")}×</b>{" "}
                <span className="font-mono">{c.sku_componente}</span> {c.nome_componente ?? ""}
              </span>
            ))}
            {composicao.length > 3 && <> + {composicao.length - 3} item(ns)</>}
          </div>
        )}
      </div>
      <span className="w-20 text-right text-xs font-mono">
        {x.custo != null ? formatBRL(Number(x.custo)) : <span className="text-destructive font-sans">sem custo</span>}
      </span>
      <span className="w-16 text-right text-sm">
        {Number(x.un30) > 0 ? <><b>{Number(x.un30).toLocaleString("pt-BR")}</b> <span className="text-[10.5px] text-muted-foreground">un.</span></> : <span className="text-muted-foreground">—</span>}
        {Number(x.un120) > 0 && <span className="block text-[10px] text-muted-foreground leading-tight">{Number(x.un120).toLocaleString("pt-BR")} em 120 d</span>}
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
      {onVariacoes && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 shrink-0" title="Mais ações"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={x.tipo !== "S" || variacao} onSelect={() => onVariacoes(x.sku)}>
              <Layers className="h-4 w-4 mr-2" />Criar produto com variações
              {x.tipo !== "S" && <span className="ml-2 text-[10px] text-muted-foreground">só produto simples</span>}
            </DropdownMenuItem>
            {x.criado_app && !variacao && (
              <DropdownMenuItem onSelect={() => copiarFotoDoBase(x.sku)}>
                <ImagePlus className="h-4 w-4 mr-2" />Copiar a foto do produto base
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button asChild size="sm" variant={primeiro ? "outline" : "default"} className="h-8 w-[76px] gap-1 shrink-0">
        {primeiro ? (
          <Link to="/ia/gerar" search={{ sku: x.sku, canal: primeiro.canal, empresa: primeiro.empresa, r: primeiro.id }}>Abrir</Link>
        ) : (
          <Link to="/ia/gerar" search={{ sku: x.sku, canal: canalPadrao, empresa: "ottz" }}><Sparkles className="h-3.5 w-3.5" />Criar</Link>
        )}
      </Button>
    </div>
    {aberto && filhas.map((v) => <Linha key={v.sku} x={v} canalPadrao={canalPadrao} variacao onVariacoes={onVariacoes} />)}
    </>
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
