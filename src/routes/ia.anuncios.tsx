import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, ImageOff, ImagePlus, Layers, Loader2, MoreHorizontal, RefreshCw, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CriarVariacoes } from "@/components/ia/anuncio/CriarVariacoes";
import { CriarVariacoesCores } from "@/components/ia/anuncio/CriarVariacoesCores";
import { ImportarDoTiny, importarTudo } from "@/components/ia/anuncio/ImportarDoTiny";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { LOGO, idade, int } from "@/components/dashboard/formato";
import { ProtecaoPacking } from "@/components/fulfillment/ui/Packing";
import { AnunciosAchados } from "@/components/ia/anuncio/AnunciosAchados";
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

type Busca = { q?: string; marca?: string; sit?: string; tipo?: string; sem?: string; giro?: string; ordem?: string; p?: number };

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
  // valor em estoque parado (custo × estoque) — só a RPC versao 6 entende
  { id: "parado", rotulo: "Mais dinheiro parado em estoque" },
];
// estoque parado, na regra do agente de compras (19/out/2026, pedido do dono): sem giro = tem estoque e não
// vendeu em 30 dias; excesso = estoque (+ OC aguardando) para mais de 120 dias. Kit pelo componente; produto
// com variações pelas variações.
const GIROS = [
  { id: "todos", rotulo: "Qualquer estoque" },
  { id: "parado", rotulo: "Estoque parado" },
  { id: "sem_giro", rotulo: "Sem giro (30 dias)" },
  { id: "excesso", rotulo: "Excesso (+120 dias)" },
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
    giro: ["parado", "sem_giro", "excesso"].includes(String(s.giro)) ? String(s.giro) : undefined,
    ordem: ORDENS.some((x) => x.id === s.ordem) && s.ordem !== "vendas" ? String(s.ordem) : undefined,
    p: Number(s.p) > 1 ? Math.floor(Number(s.p)) : undefined,
  }),
  component: AnunciosPage,
});

function AnunciosPage() {
  const { q, marca, sit, tipo, sem, giro, ordem, p } = Route.useSearch();
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
    queryKey: ["ia-anuncio", "catalogo", q ?? "", marca ?? "", sit ?? "todos", tipo ?? "", sem ?? "", giro ?? "", ordem ?? "vendas", pagina],
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<IaCatalogo> => {
      const { data, error } = await supabaseExternal.rpc("ia_catalogo", {
        p_busca: q ?? null, p_marca: marca ?? null, p_situacao: sit ?? "todos", p_sem_canal: sem ?? null,
        p_ordem: ordem ?? "vendas", p_offset: (pagina - 1) * POR_PAGINA, p_limit: POR_PAGINA, p_tipo: tipo ?? null,
        // só manda quando há filtro de estoque parado (p_giro tem default na função)
        ...(giro ? { p_giro: giro } : {}),
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
  // "Importar do Tiny": produto cadastrado hoje no Tiny entra no sistema na hora (sem esperar a madrugada)
  const [importarAberto, setImportarAberto] = useState<string | null>(null);
  const verSku = (sku: string) => { setDigitado(sku); set({ q: sku, sit: undefined, tipo: undefined, sem: undefined, marca: undefined, giro: undefined }); };
  // ligar o filtro de estoque parado já ordena pelo dinheiro parado (se a ordem estiver no padrão); desligar volta
  const escolherGiro = (id: string) => {
    const novo = id === "todos" ? undefined : id;
    set({ giro: novo, ordem: novo ? (ordem ?? "parado") : (ordem === "parado" ? undefined : ordem) });
  };
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

  const dialogos = (
    <>
      {variacoesDe && <CriarVariacoes sku={variacoesDe} onFechar={() => setVariacoesDe(null)} />}
      {importarAberto !== null && <ImportarDoTiny inicial={importarAberto} onFechar={() => setImportarAberto(null)} onVer={verSku} />}
      {coresAberto && <CriarVariacoesCores skus={selecionados} onFechar={() => { setCoresAberto(false); setSelecionados([]); }} />}
    </>
  );
  // visual novo (pacote "Anúncios" do Claude Design); a tela antiga fica de reserva se o novo quebrar
  return (
    <>
      <ProtecaoPacking antigo={antigo()}>
        <ListaNova cat={cat} carregando={catQ.isLoading} erro={catQ.isError ? (catQ.error as Error).message : null} onTentar={() => void catQ.refetch()}
          buscando={catQ.isFetching} digitado={digitado} setDigitado={setDigitado} filtros={{ q, marca, sit, tipo, sem, giro, ordem }} set={set}
          escolherGiro={escolherGiro} pagina={pagina} paginas={paginas} total={total} composicoes={kitsQ.data} comCapa={comCapa}
          selecionados={selecionados} alternar={alternar} limparSel={() => setSelecionados([])} abrirCores={() => setCoresAberto(true)}
          onVariacoes={setVariacoesDe} onImportar={(t) => setImportarAberto(t)} />
      </ProtecaoPacking>
      {dialogos}
    </>
  );

  function antigo() {
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

      {cat?.giro && (
        <div className="flex flex-wrap items-center gap-1.5">
          {GIROS.map((x) => {
            const ativo = (giro ?? "todos") === x.id;
            const n = x.id === "todos" ? undefined : cat.giro?.[x.id];
            return (
              <Button key={x.id} size="sm" variant={ativo ? "secondary" : "ghost"}
                className={`h-7 gap-1.5 text-xs ${ativo ? (x.id === "todos" ? "ring-1 ring-primary/40" : "ring-1 ring-amber-500/60") : ""}`}
                onClick={() => escolherGiro(x.id)}>
                {x.rotulo}
                {n !== undefined && <span className="text-muted-foreground">{n.toLocaleString("pt-BR")}</span>}
              </Button>
            );
          })}
          <span className="text-[11px] text-muted-foreground"
            title="Regra do agente de compras: sem giro = tem estoque (Geral + Full) e não vendeu nada em 30 dias; excesso = o estoque, somado às ordens de compra aguardando, dura mais de 120 dias no ritmo de venda dos últimos 30. Kit conta pelo componente; produto com variações, pelas variações. Produto com estoque não sincronizado do Tiny fica de fora.">
            regra do agente de compras{cat.giro_em && <> · estoque de {new Date(cat.giro_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</>}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8 h-9" value={digitado} onChange={(e) => setDigitado(e.target.value)} placeholder="SKU, nome do produto, ou nome/ID do anúncio (Shopee, MLB…)" />
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
          <SelectContent>{ORDENS.filter((o) => (o.id !== "vendas120" || (cat?.versao ?? 1) >= 2 || ordem === "vendas120") && (o.id !== "parado" || (cat?.versao ?? 1) >= 6 || ordem === "parado")).map((o) => <SelectItem key={o.id} value={o.id}>{o.rotulo}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => setImportarAberto(digitado.trim())}
          title="Produto cadastrado hoje no Tiny ainda não aparece? Traga agora (ou atualize um que já está aqui).">
          <Download className="h-4 w-4" />Importar do Tiny
        </Button>
        {catQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {q && <AnunciosAchados busca={q} onSku={(sku) => setDigitado(sku)} />}

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
          <div className="p-10 text-center text-muted-foreground space-y-2">
            <div>Nenhum produto com esses filtros.</div>
            {q && (
              <div className="text-sm">
                Cadastrou hoje no Tiny? A lista só recebe produto novo na sincronização da madrugada.{" "}
                <Button size="sm" variant="outline" className="h-7 gap-1.5 ml-1" onClick={() => setImportarAberto(q)}>
                  <Download className="h-3.5 w-3.5" />Importar "{q}" do Tiny agora
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="divide-y">{cat.linhas.map((x) => <Linha key={x.sku} x={comCapa(x)} canalPadrao={canalPadrao} composicao={kitsQ.data?.[x.sku]} onVariacoes={setVariacoesDe}
            selecionado={selecionados.includes(x.sku)} onSelecionar={alternar} />)}</div>
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
}

interface Componente { sku_componente: string; quantidade: number; nome_componente: string | null }

/** Relê o produto no Tiny e regrava no sistema (nome, custo, foto, kit; o pai traz as variações). */
async function atualizarDoTiny(sku: string, qc: ReturnType<typeof useQueryClient>) {
  const aviso = toast.loading(`Lendo ${sku} no Tiny…`);
  try {
    const itens = await importarTudo([sku]);
    const falhas = itens.filter((i) => !i.ok);
    if (falhas.length) toast.error(`${sku}: não atualizou tudo`, { id: aviso, description: falhas.map((i) => `${i.sku}: ${i.erro}`).join(" · "), duration: 15000 });
    else toast.success(itens.length > 1 ? `${sku} e mais ${itens.length - 1} atualizados do Tiny` : `${sku} atualizado do Tiny`, { id: aviso, duration: 6000 });
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  } catch (e) { toast.error("Não consegui ler o Tiny", { id: aviso, description: (e as Error).message, duration: 15000 }); }
}

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
  const qc = useQueryClient();
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
          {x.giro && x.giro.length > 0 && <SeloGiro x={x} />}
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
          : x.canais.slice(0, 5).map((c) => <SeloCanal key={`${c.canal}-${c.empresa}`} c={c} skus={[x.sku, ...filhas.map((v) => v.sku)]} />)}
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
            <DropdownMenuItem onSelect={() => void atualizarDoTiny(x.sku, qc)}>
              <RefreshCw className="h-4 w-4 mr-2" />Atualizar do Tiny
              <span className="ml-2 text-[10px] text-muted-foreground">custo, foto, kit, variações</span>
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

/**
 * Estoque parado (regra do agente de compras): "sem giro" (vermelho) ou "excesso · 240 dias" (âmbar) + o dinheiro
 * parado. Kit e produto com variações mostram o produto FÍSICO que está parado (componente / variação).
 */
function SeloGiro({ x }: { x: IaCatalogoLinha }) {
  const fis = x.giro ?? [];
  const semGiro = fis.some((f) => f.status === "sem_giro");
  const excesso = fis.filter((f) => f.status === "excesso");
  const maxDias = excesso.reduce((m, f) => Math.max(m, Number(f.dias) || 0), 0);
  const valor = x.giro_valor != null ? Number(x.giro_valor) : fis.reduce((s, f) => s + (Number(f.valor) || 0), 0);
  const deOutro = fis.length > 0 && fis.every((f) => f.sku !== x.sku);
  const rotulo = [semGiro ? "sem giro" : null, excesso.length ? `excesso · ${Math.round(maxDias).toLocaleString("pt-BR")} dias` : null].filter(Boolean).join(" + ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title="Estoque parado — clique para ver"
          className={`inline-flex items-center gap-1 rounded border px-1 text-[9.5px] font-medium leading-4 ${semGiro
            ? "border-red-500/60 text-red-700 dark:text-red-400" : "border-amber-500/60 text-amber-700 dark:text-amber-400"}`}>
          {rotulo}{deOutro && (x.tipo === "K" ? " no componente" : x.tipo === "V" ? " nas variações" : "")}
          {valor > 0 && <span className="opacity-80">· {formatBRL(valor)} parado</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-3 space-y-2 text-sm">
        <div className="font-medium">Estoque parado</div>
        <div className="text-[11px] text-muted-foreground">
          Regra do agente de compras: <b>sem giro</b> = tem estoque e não vendeu em 30 dias; <b>excesso</b> = o estoque (com as
          ordens de compra aguardando) dura mais de 120 dias no ritmo dos últimos 30. Venda de todos os canais, kits abertos nos componentes.
        </div>
        <div className="divide-y">
          {fis.map((f) => (
            <div key={f.sku} className="py-1.5">
              <div className="text-[12px] leading-snug line-clamp-2" title={f.nome ?? ""}>
                <span className="font-mono text-muted-foreground">{f.sku}</span> {f.nome ?? ""}
              </div>
              <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                <span className={f.status === "sem_giro" ? "text-red-600 font-medium" : "text-amber-600 font-medium"}>
                  {f.status === "sem_giro" ? "sem giro" : `excesso · ${Math.round(Number(f.dias) || 0).toLocaleString("pt-BR")} dias`}
                </span>
                {f.estoque != null && <span>{Number(f.estoque).toLocaleString("pt-BR")} un. em estoque</span>}
                <span>{Number(f.venda_30d ?? 0).toLocaleString("pt-BR")} vendidas em 30 dias</span>
                {f.valor != null && <span>{formatBRL(Number(f.valor))} parado</span>}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Shopee Ottz · R$ 41,90 · 18%" — a margem é a real dos pedidos (soma da margem ÷ soma da venda). */
function SeloCanal({ c, skus }: { c: IaCanalHist; skus: string[] }) {
  const mc = c.mc_pct != null ? Number(c.mc_pct) : null;
  const cor = mc == null ? "#64748B" : mc >= 0.15 ? "#0E8A5F" : mc > 0 ? "#B7791F" : "#C9432F";
  const [aberto, setAberto] = useState(false);
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" className="text-[10.5px] px-1.5 py-0.5 rounded border whitespace-nowrap hover:bg-muted/60 cursor-pointer"
          title={`${Number(c.un30).toLocaleString("pt-BR")} un. em 30 dias · ${Number(c.un120).toLocaleString("pt-BR")} un. em 120 dias — clique para ver o anúncio`}>
          <b>{nomeCanal(c.canal)}</b> {nomeEmpresa(c.empresa)}
          {c.preco != null && <> · {formatBRL(Number(c.preco))}</>}
          {mc != null && <> · <span style={{ color: cor }} className="font-semibold">{(mc * 100).toFixed(0)}%</span></>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-3">
        {aberto && <AnunciosDoCanal canal={c.canal} empresa={c.empresa} skus={skus} />}
      </PopoverContent>
    </Popover>
  );
}

const LOJA_SHOPEE: Record<string, number> = { ottz: 522186766, svl: 759046323 };
interface AnuncioVinculado { id: string; nome: string | null; status: string | null; url: string | null; painel: string | null; detalhe: string | null }

/** Os anúncios daquele canal/loja que vendem este produto (ou as variações dele), com o link para conferir. Só o espelho da gestão. */
function AnunciosDoCanal({ canal, empresa, skus }: { canal: string; empresa: string; skus: string[] }) {
  const q = useQuery({
    queryKey: ["ia-anuncio", "anuncios-do-canal", canal, empresa, skus.join(",")],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ lista: AnuncioVinculado[]; aviso: string | null }> => {
      if (canal === "shopee") {
        const shop = LOJA_SHOPEE[empresa];
        if (!shop) return { lista: [], aviso: "loja Shopee desconhecida" };
        const [v, a] = await Promise.all([
          supabaseExternal.from("shopee_anuncios_variacao").select("item_id, sku, nome_variacao").eq("shop_id", shop).in("sku", skus).limit(200),
          supabaseExternal.from("shopee_anuncios").select("item_id").eq("shop_id", shop).in("sku_pai", skus).limit(50),
        ]);
        const vars = (v.data ?? []) as { item_id: number; sku: string; nome_variacao: string | null }[];
        const ids = [...new Set([...vars.map((x) => Number(x.item_id)), ...((a.data ?? []) as { item_id: number }[]).map((x) => Number(x.item_id))])];
        if (!ids.length) return { lista: [], aviso: null };
        const { data: ans } = await supabaseExternal.from("shopee_anuncios").select("item_id, nome, status, sku_pai").eq("shop_id", shop).in("item_id", ids);
        return {
          aviso: null,
          lista: ((ans ?? []) as { item_id: number; nome: string | null; status: string | null; sku_pai: string | null }[]).map((x) => {
            const desta = vars.filter((y) => Number(y.item_id) === Number(x.item_id));
            return {
              id: String(x.item_id), nome: x.nome, status: x.status,
              url: `https://shopee.com.br/product/${shop}/${x.item_id}`, painel: `https://seller.shopee.com.br/portal/product/${x.item_id}`,
              detalhe: [x.sku_pai ? `SKU do anúncio ${x.sku_pai}` : null, desta.length ? `variações ${desta.map((y) => y.sku).join(", ")}` : null].filter(Boolean).join(" · ") || null,
            };
          }).sort((p, z) => Number(z.status === "NORMAL") - Number(p.status === "NORMAL")),
        };
      }
      if (canal === "mercado_livre") {
        if (empresa !== "ottz") return { lista: [], aviso: "Os anúncios do Mercado Livre da SVL não têm espelho no app: confira no Mercado Livre." };
        const { data } = await supabaseExternal.from("ml_anuncios").select("mlb, sku, titulo, status, permalink, catalog_listing").in("sku", skus).limit(50);
        return {
          aviso: null,
          lista: ((data ?? []) as { mlb: string; sku: string; titulo: string | null; status: string | null; permalink: string | null; catalog_listing: boolean | null }[]).map((x) => ({
            id: x.mlb, nome: x.titulo, status: x.status, url: x.permalink, painel: null,
            detalhe: [`SKU ${x.sku}`, x.catalog_listing ? "catálogo" : null].filter(Boolean).join(" · "),
          })).sort((p, z) => Number(z.status === "active") - Number(p.status === "active")),
        };
      }
      if (canal === "tiktok") {
        const { data } = await supabaseExternal.from("tiktok_produtos").select("product_id, seller_sku, titulo").in("seller_sku", skus).limit(50);
        const porId = new Map(((data ?? []) as { product_id: string; seller_sku: string; titulo: string | null }[]).map((x) => [String(x.product_id), x]));
        return { aviso: null, lista: [...porId.values()].map((x) => ({ id: String(x.product_id), nome: x.titulo, status: null, url: null, painel: null, detalhe: `SKU ${x.seller_sku}` })) };
      }
      return { lista: [], aviso: "A Amazon não tem espelho dos anúncios no app: confira no Seller Central." };
    },
  });
  return (
    <div className="space-y-2 text-sm">
      <div className="font-medium">{nomeCanal(canal)} {nomeEmpresa(empresa)} — anúncio(s) deste produto</div>
      {q.isLoading ? <div className="text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />procurando…</div>
        : q.isError ? <div className="text-xs text-destructive">{(q.error as Error).message}</div>
        : q.data?.aviso ? <div className="text-xs text-muted-foreground">{q.data.aviso}</div>
        : !q.data?.lista.length ? <div className="text-xs text-muted-foreground">Nenhum anúncio ligado a este SKU no espelho da gestão (a venda pode vir de um anúncio com outro SKU).</div>
        : (
          <div className="max-h-72 overflow-y-auto divide-y">
            {q.data.lista.map((a) => (
              <div key={a.id} className="py-1.5">
                <div className="text-[12px] leading-snug line-clamp-2" title={a.nome ?? ""}>{a.nome ?? "(sem título)"}</div>
                <div className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-2">
                  <span className="font-mono">{a.id}</span>
                  {a.status && <span className={a.status === "NORMAL" || a.status === "active" ? "text-emerald-600" : "text-amber-600"}>{a.status}</span>}
                  {a.detalhe && <span>{a.detalhe}</span>}
                </div>
                <div className="flex gap-3 text-[11px]">
                  {a.url && <a className="underline" href={a.url} target="_blank" rel="noreferrer">ver o anúncio</a>}
                  {a.painel && <a className="underline" href={a.painel} target="_blank" rel="noreferrer">abrir no Seller Center</a>}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Visual novo (Claude Design, pacote "Anúncios", 22/out/2026): filtros numa barra só (situação, tipo, busca, ordem
// e "Mais filtros"), chips do que está ligado, linha com hierarquia (produto → onde vende → anúncio com IA → Abrir) e
// barra escura de seleção. Só apresentação: os dados e as ações são os da tela antiga, que fica de reserva.

const LOGO_CANAL: Record<string, string> = { shopee: LOGO.shopee, mercado_livre: LOGO.mercadolivre, amazon: LOGO.amazon, tiktok: LOGO.tiktok };
const NOME_CURTO: Record<string, string> = { shopee: "Shopee", mercado_livre: "ML", amazon: "Amazon", tiktok: "TikTok" };
/** loja como a equipe fala: Shopee Ottz/Bumi, ML Ottz/SVL, Amazon ACZ/SVL */
const nomeLoja = (canal: string, empresa: string) =>
  empresa === "svl" ? (canal === "shopee" || canal === "tiktok" ? "Bumi" : "SVL") : canal === "amazon" ? "ACZ" : "Ottz";
const corMargem = (m: number | null) => (m == null ? "var(--pm-t2)" : m < 0 ? "var(--pm-r)" : m < 0.1 ? "var(--pm-am)" : "var(--pm-g)");
const pctBR = (m: number) => `${m < 0 ? "−" : ""}${Math.abs(m * 100).toFixed(1).replace(".", ",")}%`;
const brl = (v: number) => formatBRL(v);
const MONO_A = "pm-mono";
const GRADE_A = "24px minmax(220px,1.5fr) 76px minmax(0,1.45fr) minmax(150px,190px) 124px";
const LOJAS_TOTAL = 6;

const segA = (on: boolean): CSSProperties => ({
  border: 0, cursor: "pointer", height: 32, padding: "0 10px", borderRadius: 8, fontSize: 12.5, fontWeight: on ? 600 : 500,
  background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t2)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
});
const chipA = (on: boolean): CSSProperties => ({
  height: 34, padding: "0 12px", borderRadius: 17, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-bc)"}`,
  background: on ? "var(--pm-a)" : "var(--pm-s)", color: on ? "var(--pm-oa)" : "var(--pm-t)", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
  display: "flex", alignItems: "center", gap: 6,
});
const btnSec: CSSProperties = {
  height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)",
  cursor: "pointer", fontSize: 12.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", textDecoration: "none",
};
const btnPri: CSSProperties = { ...btnSec, border: "1px solid var(--pm-a)", background: "var(--pm-a)", color: "var(--pm-oa)" };
const campo: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, height: 38, padding: "0 4px 0 10px", border: "1px solid var(--pm-bc)",
  borderRadius: 10, background: "var(--pm-s)", fontSize: 12, color: "var(--pm-t2)",
};
const selectA: CSSProperties = { height: 34, border: 0, background: "transparent", fontSize: 12.5, fontWeight: 600, color: "var(--pm-t)", cursor: "pointer", outline: "none" };

/** Resumo do topo: quantos rascunhos, fotos e textos a área tem (contagens no banco, sem baixar linhas). */
function useResumoIa() {
  return useQuery({
    queryKey: ["ia-anuncio", "resumo-topo"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const conta = async (q: PromiseLike<{ count: number | null; error: unknown }>) => { const r = await q; if (r.error) throw r.error; return r.count ?? 0; };
      const [rascunhos, fotos, revisar, textos] = await Promise.all([
        conta(supabaseExternal.from("ia_rascunho").select("id", { count: "exact", head: true })),
        conta(supabaseExternal.from("ia_rascunho_imagem").select("id", { count: "exact", head: true })),
        conta(supabaseExternal.from("ia_etapa").select("id", { count: "exact", head: true }).eq("etapa", "imagem").eq("status", "gerado")),
        conta(supabaseExternal.from("ia_etapa").select("id", { count: "exact", head: true }).eq("etapa", "texto").eq("status", "aprovado")),
      ]);
      return { rascunhos, fotos, revisar, textos };
    },
  });
}

/** Em quantas lojas cada produto da página já foi enviado pela tela (ia_publicacao, só os publicados). */
function usePublicadas(skus: string[]) {
  return useQuery({
    queryKey: ["ia-anuncio", "publicadas", skus.join(",")],
    enabled: skus.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabaseExternal.from("ia_publicacao").select("sku, canal, empresa").eq("estado", "publicado").in("sku", skus).limit(2000);
      if (error) throw error;
      const lojas: Record<string, Set<string>> = {};
      for (const p of (data ?? []) as { sku: string; canal: string; empresa: string }[]) (lojas[p.sku] ??= new Set()).add(`${p.canal}:${p.empresa}`);
      return Object.fromEntries(Object.entries(lojas).map(([k, v]) => [k, v.size]));
    },
  });
}

function ListaNova({ cat, carregando, erro, onTentar, buscando, digitado, setDigitado, filtros, set, escolherGiro, pagina, paginas, total,
  composicoes, comCapa, selecionados, alternar, limparSel, abrirCores, onVariacoes, onImportar }: {
  cat: IaCatalogo | undefined; carregando: boolean; erro: string | null; onTentar: () => void; buscando: boolean;
  digitado: string; setDigitado: (v: string) => void;
  filtros: { q?: string; marca?: string; sit?: string; tipo?: string; sem?: string; giro?: string; ordem?: string };
  set: (x: Partial<Busca>) => void; escolherGiro: (id: string) => void;
  pagina: number; paginas: number; total: number;
  composicoes: Record<string, Componente[]> | undefined; comCapa: (x: IaCatalogoLinha) => IaCatalogoLinha;
  selecionados: string[]; alternar: (sku: string) => void; limparSel: () => void; abrirCores: () => void;
  onVariacoes: (sku: string) => void; onImportar: (q: string) => void;
}) {
  const { q, marca, sit, tipo, sem, giro, ordem } = filtros;
  const [mais, setMais] = useState(false);
  const resumoQ = useResumoIa();
  const linhas = cat?.linhas ?? [];
  const pubQ = usePublicadas(linhas.flatMap((x) => [x.sku, ...(x.variacoes ?? []).map((v) => v.sku)]));
  const canalPadrao = sem ?? "shopee";
  const giroEm = cat?.giro_em ? idade(cat.giro_em) : null;
  const nMais = [giro, sem, marca].filter(Boolean).length;
  const contagem = cat?.contagem ?? {};

  const chips: { nome: string; n?: number; tirar: () => void }[] = [];
  if (sit) chips.push({ nome: SITUACOES.find((s) => s.id === sit)?.rotulo ?? sit, n: contagem[sit], tirar: () => set({ sit: undefined }) });
  if (tipo) chips.push({ nome: TIPOS.find((t) => t.id === tipo)?.rotulo ?? tipo, n: cat?.tipos?.[tipo], tirar: () => set({ tipo: undefined }) });
  if (giro) chips.push({ nome: GIROS.find((g) => g.id === giro)?.rotulo ?? giro, n: cat?.giro?.[giro], tirar: () => escolherGiro("todos") });
  if (sem) chips.push({ nome: `Ainda não vende em ${nomeCanal(sem)}`, tirar: () => set({ sem: undefined }) });
  if (marca) chips.push({ nome: `Marca: ${marca}`, tirar: () => set({ marca: undefined }) });
  if (q) chips.push({ nome: `“${q}”`, tirar: () => { setDigitado(""); set({ q: undefined }); } });

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, padding: "16px 24px 96px", maxWidth: 1440, margin: "0 auto", color: "var(--pm-t)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "8px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>Anúncios com IA</h1>
          <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>
            {resumoQ.data
              ? `${int(resumoQ.data.rascunhos)} rascunhos · ${int(resumoQ.data.fotos)} fotos, ${int(resumoQ.data.revisar)} para revisar · ${int(resumoQ.data.textos)} textos aprovados`
              : "Catálogo ativo, com onde cada produto vende hoje e a situação do anúncio com IA"}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {giroEm && (
          <span style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5, color: giroEm.velho ? "var(--pm-am)" : "var(--pm-t2)" }}
            title="Retrato do estoque usado no filtro de estoque parado (regra do agente de compras)">
            <i style={{ width: 7, height: 7, borderRadius: "50%", background: giroEm.velho ? "var(--pm-am)" : "var(--pm-g)" }} />
            retrato de estoque {fmtDataHora(cat!.giro_em!)} · {giroEm.txt}
          </span>
        )}
        <button type="button" style={btnSec} onClick={() => onImportar(digitado.trim())}
          title="Produto cadastrado hoje no Tiny ainda não aparece? Traga agora (ou atualize um que já está aqui).">
          <Download className="h-4 w-4" /> Importar do Tiny
        </button>
      </div>

      {/* filtros */}
      <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: 10, display: "flex", flexDirection: "column", gap: 8, position: "relative" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", gap: 2, padding: 2, border: "1px solid var(--pm-bc)", borderRadius: 10, background: "var(--pm-s)", flexWrap: "wrap" }}>
            {SITUACOES.filter((s) => s.id !== "sem_capa" || contagem.sem_capa !== undefined).map((s) => {
              const on = (sit ?? "todos") === s.id;
              const n = contagem[s.id];
              return (
                <button key={s.id} type="button" style={segA(on)} className={on ? "pm-hv-a" : "pm-hv"} onClick={() => set({ sit: s.id === "todos" ? undefined : s.id })}>
                  {s.rotulo}{n != null && <span className={MONO_A} style={{ fontSize: 11, opacity: 0.85 }}>{int(n)}</span>}
                </button>
              );
            })}
          </div>
          {cat?.tipos && (
            <label style={campo}>Tipo
              <select style={selectA} value={tipo ?? "todos"} onChange={(e) => set({ tipo: e.target.value === "todos" ? undefined : e.target.value })}>
                {TIPOS.filter((x) => x.id !== "APP" || cat.tipos?.APP !== undefined).map((x) => (
                  <option key={x.id} value={x.id}>{x.rotulo}{cat.tipos?.[x.id] != null ? ` · ${int(cat.tipos[x.id])}` : ""}</option>
                ))}
              </select>
            </label>
          )}
          <div style={{ ...campo, padding: "0 10px", flex: "1 1 220px", minWidth: 180 }}>
            {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            <input value={digitado} onChange={(e) => setDigitado(e.target.value)} placeholder="SKU, nome do produto ou ID do anúncio (Shopee, MLB…)"
              style={{ border: 0, outline: "none", background: "transparent", flex: 1, minWidth: 0, fontSize: 13, color: "var(--pm-t)" }} />
          </div>
          <label style={campo}>Ordem
            <select style={{ ...selectA, maxWidth: 220 }} value={ordem ?? "vendas"} onChange={(e) => set({ ordem: e.target.value === "vendas" ? undefined : e.target.value })}>
              {ORDENS.filter((o) => (o.id !== "vendas120" || (cat?.versao ?? 1) >= 2 || ordem === "vendas120") && (o.id !== "parado" || (cat?.versao ?? 1) >= 6 || ordem === "parado"))
                .map((o) => <option key={o.id} value={o.id}>{o.rotulo}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setMais((v) => !v)} style={{ ...chipA(nMais > 0), height: 38, borderRadius: 10 }}>
            <SlidersHorizontal className="h-4 w-4" />{nMais ? `Mais filtros · ${nMais}` : "Mais filtros"}
          </button>
        </div>

        {mais && (
          <div style={{ position: "absolute", right: 10, top: 56, zIndex: 30, width: "min(480px, calc(100% - 20px))", background: "var(--pm-s)", border: "1px solid var(--pm-bc)", borderRadius: 14, boxShadow: "var(--pm-shl)", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
            {cat?.giro && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>Estoque parado</span>
                {giroEm && <span style={{ fontSize: 11.5, fontWeight: 500, color: giroEm.velho ? "var(--pm-am)" : "var(--pm-t2)" }}>retrato de {fmtDataHora(cat.giro_em!)} · {giroEm.txt} · regra do agente de compras</span>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {GIROS.map((g) => {
                    const n = g.id === "todos" ? undefined : cat.giro?.[g.id];
                    return <button key={g.id} type="button" style={chipA((giro ?? "todos") === g.id)} onClick={() => escolherGiro(g.id)}>{g.rotulo}{n != null && ` · ${int(n)}`}</button>;
                  })}
                </div>
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>Ainda não vende em</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {CANAIS_COM_HISTORICO.map((c) => (
                  <button key={c} type="button" style={{ ...chipA(sem === c), paddingLeft: 8 }} onClick={() => set({ sem: sem === c ? undefined : c })}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, flex: "none", background: `#fff url(${LOGO_CANAL[c]}) center/contain no-repeat` }} />{nomeCanal(c)}
                  </button>
                ))}
              </div>
            </div>
            <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, fontWeight: 700 }}>Marca
              <select value={marca ?? ""} onChange={(e) => set({ marca: e.target.value || undefined })}
                style={{ height: 40, borderRadius: 10, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", padding: "0 10px", fontSize: 13, fontWeight: 500, color: "var(--pm-t)" }}>
                <option value="">Todas as marcas</option>
                {(cat?.marcas ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" style={btnPri} onClick={() => setMais(false)}>Pronto</button></div>
          </div>
        )}

        {chips.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 2 }}>
            <span style={{ fontSize: 12, color: "var(--pm-t2)", fontWeight: 500 }}>Filtrando:</span>
            {chips.map((c) => (
              <button key={c.nome} type="button" title="Tirar filtro" onClick={c.tirar}
                style={{ ...chipA(true), height: 30, borderRadius: 15, padding: "0 6px 0 11px", fontSize: 12 }}>
                {c.nome}{c.n != null && <span className={MONO_A} style={{ fontSize: 11, opacity: 0.9 }}>{int(c.n)}</span>}<X className="h-3.5 w-3.5" />
              </button>
            ))}
            <button type="button" onClick={() => { setDigitado(""); set({ q: undefined, sit: undefined, tipo: undefined, giro: undefined, sem: undefined, marca: undefined, ordem: undefined }); }}
              style={{ height: 30, padding: "0 10px", borderRadius: 8, border: 0, background: "transparent", color: "var(--pm-at)", cursor: "pointer", fontSize: 12, fontWeight: 600, textDecoration: "underline" }}>
              Limpar tudo
            </button>
          </div>
        )}
      </div>

      {q && <AnunciosAchados busca={q} onSku={(sku) => setDigitado(sku)} />}

      {/* tabela */}
      <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-sh)", overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 980 }}>
            <div style={{ display: "grid", gridTemplateColumns: GRADE_A, gap: 12, alignItems: "center", padding: "9px 14px", background: "var(--pm-s2)", borderBottom: "1px solid var(--pm-bs)", fontSize: 11.5, fontWeight: 600, color: "var(--pm-t2)" }}>
              <span /><span>Produto</span><span style={{ textAlign: "right" }}>Custo</span><span>Onde vende hoje · preço e margem</span><span>Anúncio com IA</span><span />
            </div>
            {carregando ? [1, 2, 3, 4, 5, 6].map((k) => (
              <div key={k} style={{ display: "grid", gridTemplateColumns: GRADE_A, gap: 12, alignItems: "center", padding: "12px 14px", borderTop: "1px solid var(--pm-b)" }}>
                <span /><span style={{ display: "flex", gap: 10, alignItems: "center" }}><i style={{ width: 44, height: 44, borderRadius: 9, background: "var(--pm-sk)" }} /><i style={{ width: "60%", height: 12, borderRadius: 5, background: "var(--pm-sk)" }} /></span>
                <i style={{ height: 10, borderRadius: 5, background: "var(--pm-sk)" }} /><i style={{ width: "80%", height: 22, borderRadius: 7, background: "var(--pm-sk)" }} />
                <i style={{ height: 10, borderRadius: 5, background: "var(--pm-sk)" }} /><i style={{ height: 36, borderRadius: 9, background: "var(--pm-sk)" }} />
              </div>
            )) : erro ? (
              <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ color: "var(--pm-r)", fontWeight: 600 }}>Não deu para ler o catálogo agora · {erro}</span>
                <button type="button" style={btnSec} onClick={onTentar}>Tentar de novo</button>
              </div>
            ) : linhas.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "40px 16px", textAlign: "center" }}>
                <b style={{ fontSize: 16, fontWeight: 700 }}>{q ? `Nenhum produto com “${q}”` : "Nenhum produto com esses filtros"}</b>
                {q && <>
                  <span style={{ fontSize: 13, color: "var(--pm-t2)", maxWidth: 440 }}>Não achou? Produto cadastrado hoje no Tiny só entra na lista depois de importar.</span>
                  <button type="button" style={{ ...btnPri, height: 42, fontSize: 13 }} onClick={() => onImportar(q)}>Importar “{q}” do Tiny</button>
                  <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>lê o cadastro do Tiny · não escreve nada</span>
                </>}
              </div>
            ) : linhas.map((x0) => {
              const x = comCapa(x0);
              return <LinhaNova key={x.sku} x={x} canalPadrao={canalPadrao} composicao={composicoes?.[x.sku]} publicadas={pubQ.data}
                selecionado={selecionados.includes(x.sku)} onSelecionar={alternar} onVariacoes={onVariacoes} />;
            })}
          </div>
        </div>
        {total > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--pm-bs)", background: "var(--pm-s2)", fontSize: 12, color: "var(--pm-t2)" }}>
            <span>{int((pagina - 1) * POR_PAGINA + 1)}–{int(Math.min(pagina * POR_PAGINA, total))} de {int(total)} linhas (variações dentro do pai)</span>
            <div style={{ flex: 1 }} />
            <button type="button" style={{ ...btnSec, height: 32, opacity: pagina <= 1 ? 0.45 : 1 }} disabled={pagina <= 1} onClick={() => set({ p: pagina - 1 })}><ChevronLeft className="h-4 w-4" />Anterior</button>
            <span>página {pagina} de {paginas}</span>
            <button type="button" style={{ ...btnSec, height: 32, opacity: pagina >= paginas ? 0.45 : 1 }} disabled={pagina >= paginas} onClick={() => set({ p: pagina + 1 })}>Próxima<ChevronRight className="h-4 w-4" /></button>
          </div>
        )}
      </div>

      {selecionados.length > 0 && (
        <div style={{ position: "sticky", bottom: 14, zIndex: 15, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "10px 12px 10px 16px", borderRadius: 14, background: "var(--pm-t)", color: "var(--pm-s)", boxShadow: "var(--pm-shl)" }}>
          <span style={{ fontSize: 13 }}><b className={MONO_A}>{selecionados.length}</b> {selecionados.length === 1 ? "produto simples marcado" : "produtos simples marcados"}</span>
          <span className={MONO_A} style={{ fontSize: 12, opacity: 0.8 }}>{selecionados.join(" · ")}</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={limparSel} style={{ height: 40, padding: "0 12px", borderRadius: 9, border: "1px solid oklch(1 0 0 / 0.45)", background: "transparent", color: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>Limpar</button>
          {selecionados.length >= 2
            ? <button type="button" onClick={abrirCores} style={{ height: 42, padding: "0 16px", borderRadius: 10, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Criar produto com variações (cor × quantidade)</button>
            : <span style={{ fontSize: 12, opacity: 0.85 }}>marque 2 ou mais para criar variações</span>}
        </div>
      )}
    </div>
  );
}

function fmtDataHora(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
}

/** situação do anúncio com IA em 3 partes: texto · fotos · enviado */
function estadoIa(x: IaCatalogoLinha, publicadas: number) {
  const r = x.rascunhos[0];
  if (!r) return null;
  const texto = r.texto === "aprovado" ? "var(--pm-g)" : r.texto ? "var(--pm-am)" : "var(--pm-sk)";
  const imgs = Number(r.imgs) || 0, ok = Number(r.imgs_ok) || 0, andando = Number(r.andando) || 0;
  const fotos = imgs === 0 ? "var(--pm-sk)" : ok === imgs ? "var(--pm-g)" : "var(--pm-am)";
  const envio = publicadas > 0 ? "var(--pm-g)" : "var(--pm-sk)";
  const partes = [
    r.texto === "aprovado" ? "texto aprovado" : r.texto ? `texto ${ROTULO_ETAPA[r.texto]?.rotulo ?? r.texto}` : "sem texto",
    andando > 0 ? `gerando ${andando} ${andando === 1 ? "foto" : "fotos"}` : imgs === 0 ? "sem fotos" : imgs - ok > 0 ? `${imgs} fotos, ${imgs - ok} a revisar` : `${imgs} fotos aprovadas`,
    publicadas > 0 ? `enviado em ${publicadas} de ${LOJAS_TOTAL} lojas` : null,
  ].filter(Boolean);
  return { cores: [texto, fotos, envio], txt: partes.join(" · "), r, outros: x.rascunhos.length - 1 };
}

function LinhaNova({ x, canalPadrao, composicao, publicadas, variacao, selecionado, onSelecionar, onVariacoes }: {
  x: IaCatalogoLinha; canalPadrao: string; composicao?: Componente[]; publicadas?: Record<string, number>; variacao?: boolean;
  selecionado?: boolean; onSelecionar?: (sku: string) => void; onVariacoes: (sku: string) => void;
}) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const filhas = x.variacoes ?? [];
  const podeSel = !variacao && x.tipo === "S";
  const ia = estadoIa(x, publicadas?.[x.sku] ?? 0);
  const fotoW = variacao ? 32 : 44;
  const ini = (x.nome ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const tipoTxt = x.tipo === "K" ? "Kit" : x.tipo === "V" ? (filhas.length ? `Com variações · ${filhas.length}` : "Com variações") : variacao ? "Variação" : x.criado_app ? "Simples · criado no app" : "Simples";
  const linkIa = ia ? { sku: x.sku, canal: ia.r.canal, empresa: ia.r.empresa, r: ia.r.id } : { sku: x.sku, canal: canalPadrao, empresa: "ottz" };
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: GRADE_A, gap: 12, alignItems: "center", padding: variacao ? "6px 14px" : "10px 14px", borderTop: "1px solid var(--pm-b)", background: selecionado ? "var(--pm-as)" : variacao ? "var(--pm-s2)" : "var(--pm-s)" }}
        className={selecionado ? "" : "pm-linha-hv"}>
        {podeSel ? (
          <button type="button" aria-label="Selecionar" title="Selecionar para criar um produto com variações de cor × quantidade" onClick={() => onSelecionar?.(x.sku)}
            style={{ width: 22, height: 22, borderRadius: 6, border: `1.5px solid ${selecionado ? "var(--pm-a)" : "var(--pm-bc)"}`, background: selecionado ? "var(--pm-a)" : "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-oa)", padding: 0 }}>
            {selecionado && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </button>
        ) : variacao ? <span style={{ justifySelf: "center", width: 1, height: "100%", minHeight: 30, background: "var(--pm-bs)" }} /> : <span />}

        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, paddingLeft: variacao ? 14 : 0 }}>
          {x.foto
            ? <img src={x.foto} alt="" loading="lazy" style={{ width: fotoW, height: fotoW, flex: "none", borderRadius: 9, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-bs)" }} />
            : <span style={{ width: fotoW, height: fotoW, flex: "none", borderRadius: 9, background: "var(--pm-s2)", border: "1px solid var(--pm-bs)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--pm-t2)" }}>{ini}</span>}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span title={x.nome} style={{ fontSize: variacao ? 13 : 14, fontWeight: 600, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.nome}</span>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px", fontSize: 11.5, color: "var(--pm-t2)" }}>
              <span className={MONO_A} style={{ fontWeight: 500, color: "var(--pm-t)" }}>{x.sku}</span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "0 7px", borderRadius: 5, border: "1px solid var(--pm-bc)", color: "var(--pm-t)" }}>{tipoTxt}</span>
              {x.marca && !variacao && <span>{x.marca}</span>}
              {Number(x.un30) > 0 && <span>{int(Number(x.un30))} un em 30 d</span>}
              {x.giro && x.giro.length > 0 && <GiroNovo x={x} />}
              {x.sem_capa && <span style={{ fontWeight: 600, color: "var(--pm-am)" }}>fotos da família · falta a capa</span>}
            </div>
            {composicao && composicao.length > 0 && (
              <span title={composicao.map((c) => `${Number(c.quantidade)}× ${c.sku_componente} ${c.nome_componente ?? ""}`).join(" + ")}
                style={{ fontSize: 11.5, color: "var(--pm-t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                = <span className={MONO_A} style={{ color: "var(--pm-t)" }}>{composicao.map((c) => `${Number(c.quantidade)}× ${c.sku_componente}`).join(" + ")}</span>{" "}
                {composicao.length === 1 ? composicao[0].nome_componente ?? "" : ""}
              </span>
            )}
            {filhas.length > 0 && (
              <button type="button" onClick={() => setAberto((v) => !v)}
                style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 4, height: 26, padding: "0 8px", borderRadius: 7, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: "var(--pm-t)" }}>
                {aberto ? "Recolher" : "Ver"} {filhas.length} variações<ChevronDown className="h-3 w-3" style={{ transform: aberto ? "rotate(180deg)" : "none" }} />
              </button>
            )}
          </div>
        </div>

        <span className={MONO_A} style={{ textAlign: "right", fontSize: 12.5, color: x.custo == null ? "var(--pm-r)" : "var(--pm-t)" }}>
          {x.custo != null ? brl(Number(x.custo)) : x.tipo === "V" ? <span style={{ color: "var(--pm-t2)", fontFamily: "inherit" }}>por variação</span> : "sem custo"}
        </span>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minWidth: 0 }}>
          {x.canais.length === 0
            ? <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>ainda não vende em nenhum canal</span>
            : x.canais.slice(0, 6).map((c) => <CanalNovo key={`${c.canal}-${c.empresa}`} c={c} skus={[x.sku, ...filhas.map((v) => v.sku)]} />)}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          {ia ? (
            <>
              <div style={{ display: "flex", gap: 3 }} title="texto · fotos · enviado">{ia.cores.map((c, i) => <i key={i} style={{ flex: 1, height: 6, borderRadius: 3, background: c }} />)}</div>
              <span style={{ fontSize: 11.5, color: "var(--pm-t2)", lineHeight: 1.3 }}>{ia.txt}{ia.outros > 0 && ` · +${ia.outros} rascunho${ia.outros > 1 ? "s" : ""}`}</span>
            </>
          ) : <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>sem rascunho de IA</span>}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
          <Link to="/ia/gerar" search={linkIa} style={ia ? btnPri : btnSec}>{ia ? "Abrir" : <><Sparkles className="h-3.5 w-3.5" />Criar</>}</Link>
          {!variacao && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" title="Mais ações" style={{ ...btnSec, width: 36, padding: 0, justifyContent: "center" }}><MoreHorizontal className="h-4 w-4" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[280px]">
                <DropdownMenuItem disabled={x.tipo !== "S"} onSelect={() => onVariacoes(x.sku)} className="flex flex-col items-start gap-0">
                  <span className="font-semibold">Criar produto com variações</span>
                  <span className="text-[11px] text-muted-foreground">{x.tipo === "S" ? "usa este como base (quantidades)" : "só produto simples"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void atualizarDoTiny(x.sku, qc)} className="flex flex-col items-start gap-0">
                  <span className="font-semibold">Atualizar do Tiny</span>
                  <span className="text-[11px] text-muted-foreground">relê custo, foto, kit e variações</span>
                </DropdownMenuItem>
                {x.criado_app && (
                  <DropdownMenuItem onSelect={() => copiarFotoDoBase(x.sku)} className="flex flex-col items-start gap-0">
                    <span className="font-semibold">Copiar a foto do produto base</span>
                    <span className="text-[11px] text-muted-foreground">no pai e nas variações sem foto no Tiny</span>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {aberto && filhas.map((v) => <LinhaNova key={v.sku} x={v} canalPadrao={canalPadrao} publicadas={publicadas} variacao onVariacoes={onVariacoes} />)}
    </>
  );
}

/** "excesso · 242 dias · R$ 8.420 parado" — abre os produtos físicos parados (componente / variações). */
function GiroNovo({ x }: { x: IaCatalogoLinha }) {
  const fis = x.giro ?? [];
  const semGiro = fis.some((f) => f.status === "sem_giro");
  const excesso = fis.filter((f) => f.status === "excesso");
  const maxDias = excesso.reduce((m, f) => Math.max(m, Number(f.dias) || 0), 0);
  const valor = x.giro_valor != null ? Number(x.giro_valor) : fis.reduce((s, f) => s + (Number(f.valor) || 0), 0);
  const deOutro = fis.length > 0 && fis.every((f) => f.sku !== x.sku);
  const cor = semGiro ? "var(--pm-r)" : "var(--pm-am)";
  const rotulo = [semGiro ? "sem giro" : null, excesso.length ? `excesso · ${int(maxDias)} dias` : null].filter(Boolean).join(" + ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" title="Estoque parado — clique para ver"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: cor }}>
          <i style={{ width: 6, height: 6, borderRadius: "50%", background: cor }} />
          {rotulo}{deOutro && (x.tipo === "K" ? " no componente" : x.tipo === "V" ? " nas variações" : "")}{valor > 0 && ` · ${brl(valor)} parado`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-3 space-y-2 text-sm">
        <div className="font-medium">Estoque parado</div>
        <div className="text-[11px] text-muted-foreground">
          Sem giro = tem estoque e não vendeu em 30 dias; excesso = o estoque (com as ordens de compra aguardando) dura mais de 120 dias no ritmo dos últimos 30.
        </div>
        <div className="divide-y">
          {fis.map((f) => (
            <div key={f.sku} className="py-1.5">
              <div className="text-[12px] leading-snug line-clamp-2"><span className="font-mono text-muted-foreground">{f.sku}</span> {f.nome ?? ""}</div>
              <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                <span className={f.status === "sem_giro" ? "text-red-600 font-medium" : "text-amber-600 font-medium"}>{f.status === "sem_giro" ? "sem giro" : `excesso · ${int(Number(f.dias) || 0)} dias`}</span>
                {f.estoque != null && <span>{int(Number(f.estoque))} un. em estoque</span>}
                <span>{int(Number(f.venda_30d ?? 0))} vendidas em 30 dias</span>
                {f.valor != null && <span>{brl(Number(f.valor))} parado</span>}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Logo + loja + preço + margem; abre os anúncios daquele canal. */
function CanalNovo({ c, skus }: { c: IaCanalHist; skus: string[] }) {
  const mc = c.mc_pct != null ? Number(c.mc_pct) : null;
  const [aberto, setAberto] = useState(false);
  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <button type="button" title={`${int(Number(c.un30))} un. em 30 dias · ${int(Number(c.un120))} un. em 120 dias — clique para ver o anúncio`}
          style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 8px 0 5px", borderRadius: 7, border: `1px solid ${aberto ? "var(--pm-a)" : "var(--pm-bc)"}`, background: aberto ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", fontSize: 11.5, color: "var(--pm-t)", whiteSpace: "nowrap" }}>
          <span style={{ width: 16, height: 16, borderRadius: 4, flex: "none", border: "1px solid var(--pm-b)", background: LOGO_CANAL[c.canal] ? `#fff url(${LOGO_CANAL[c.canal]}) center/contain no-repeat` : "var(--pm-s2)" }} />
          <span style={{ fontWeight: 600 }}>{LOGO_CANAL[c.canal] ? "" : `${NOME_CURTO[c.canal] ?? nomeCanal(c.canal)} `}{nomeLoja(c.canal, c.empresa)}</span>
          {c.preco != null && <span className={MONO_A}>{brl(Number(c.preco))}</span>}
          <span className={MONO_A} style={{ fontWeight: 700, color: corMargem(mc) }}>{mc == null ? "sem venda" : pctBR(mc)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-3">
        {aberto && <AnunciosDoCanal canal={c.canal} empresa={c.empresa} skus={skus} />}
      </PopoverContent>
    </Popover>
  );
}
