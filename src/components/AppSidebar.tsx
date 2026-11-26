import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";
import {
  BarChart3,
  Factory,
  Calculator,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  LayoutDashboard,
  Receipt,
  ClipboardCheck,
  Boxes,
  PackageCheck,
  ShoppingCart,
  Target,
  AlertTriangle,
  Truck,
  FileBarChart,
  FileText,
  Warehouse,
  PackagePlus,
  RotateCcw,
  Zap,
  Telescope,
  UsersRound,
  MessageCircle,
  Users,
  ChevronDown,
  Sparkles,
  Wand2,
  Star,
  GripVertical,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  type LucideIcon,
} from "lucide-react";
import { usePerfil } from "@/hooks/usePerfil";
import { useAuth } from "@/hooks/useAuth";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";

interface NavAba {
  nome: string;
  url: string;
}
interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  modulo: string;
  badgeKey?: "anomalias";
  // Telas que viraram ABAS deste item (14/out/2026, pedido do dono: menu menor). A 1ª é a
  // própria `url`. Cada tela segue sendo uma rota (filtros na URL, links antigos valem);
  // a barra de abas aparece no topo do conteúdo (AbasDaTela, no __root).
  abas?: NavAba[];
}
interface NavGroup {
  label: string;
  cor: string; // cor do grupo no menu (rótulo, barra e ícones) — contraste sobre o fundo escuro
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Visão",
    cor: "#38BDF8",
    items: [
      { title: "Dashboard", url: "/", icon: LayoutDashboard, modulo: "dashboard" },
      { title: "Vendas por produto", url: "/vendas", icon: BarChart3, modulo: "dashboard" },
      { title: "Relatórios", url: "/relatorios", icon: FileText, modulo: "dashboard" },
      { title: "Metas", url: "/metas", icon: Target, modulo: "dashboard" },
      { title: "Tendências", url: "/tendencias", icon: TrendingUp, modulo: "dashboard" },
      { title: "Anomalias", url: "/anomalias", icon: AlertTriangle, modulo: "dashboard", badgeKey: "anomalias" },
    ],
  },
  {
    label: "Pedidos & Operação",
    cor: "#FBBF24",
    items: [
      { title: "Pedidos Integrados", url: "/pedidos-integrados", icon: Boxes, modulo: "separacao" },
      {
        title: "Separação", url: "/separacao", icon: PackageCheck, modulo: "galpao",
        abas: [
          { nome: "Fila", url: "/separacao" },
          { nome: "Monitoramento", url: "/monitoramento" },
          { nome: "Histórico", url: "/historico-separacao" },
        ],
      },
      {
        title: "Pedidos Shopee a enviar", url: "/a-enviar", icon: Truck, modulo: "galpao",
        abas: [
          { nome: "A enviar", url: "/a-enviar" },
          { nome: "Risco de cancelamento", url: "/risco-cancelamento" },
        ],
      },
      { title: "Fulfillment", url: "/fulfillment", icon: Warehouse, modulo: "galpao" },
      { title: "Compras & Recebimento", url: "/compras", icon: PackagePlus, modulo: "galpao" },
      { title: "Produção", url: "/producao", icon: Factory, modulo: "galpao" },
      { title: "Devoluções", url: "/devolucoes", icon: RotateCcw, modulo: "devolucoes" },
      { title: "Central de Atendimento", url: "/atendimento", icon: MessageCircle, modulo: "devolucoes" },
      {
        title: "Equipe", url: "/processos", icon: ClipboardCheck, modulo: "galpao",
        abas: [
          { nome: "Manual de Operação", url: "/processos" },
          { nome: "Rotinas da Operação", url: "/rotinas" },
          { nome: "Registro de horas", url: "/registro-horas" },
        ],
      },
    ],
  },
  {
    label: "Produtos",
    cor: "#FB923C",
    items: [
      {
        title: "Produtos", url: "/produtos", icon: Package, modulo: "produtos",
        abas: [
          { nome: "Catálogo", url: "/produtos" },
          { nome: "Margem", url: "/produtos-margem" },
          { nome: "Mapeamento SKUs", url: "/mapeamento-skus" },
        ],
      },
    ],
  },
  {
    label: "Mídia & Canais",
    cor: "#F472B6",
    items: [
      {
        title: "ADS", url: "/ads-shopee", icon: Megaphone, modulo: "ads",
        abas: [
          { nome: "Shopee", url: "/ads-shopee" },
          { nome: "Mercado Livre", url: "/ads-ml" },
          { nome: "Amazon", url: "/ads-amazon" },
          { nome: "Saúde dos anúncios ML", url: "/saude-ml" },
        ],
      },
      { title: "Promoções", url: "/promocoes", icon: Zap, modulo: "ads" },
      { title: "Pesquisa de produtos", url: "/pesquisa-produtos", icon: Telescope, modulo: "ads" },
      { title: "Afiliados TikTok", url: "/afiliados-tiktok", icon: UsersRound, modulo: "ads" },
      { title: "Amazon", url: "/amazon", icon: ShoppingCart, modulo: "produtos" },
    ],
  },
  {
    label: "Financeiro",
    cor: "#34D399",
    items: [
      { title: "Painel financeiro", url: "/financeiro", icon: FileBarChart, modulo: "financeiro" },
      { title: "DRE", url: "/dre", icon: FileBarChart, modulo: "financeiro" },
      { title: "Fluxo de Caixa", url: "/fluxo-caixa", icon: Wallet, modulo: "financeiro" },
      { title: "Contas a Pagar", url: "/contas-pagar", icon: Receipt, modulo: "financeiro" },
      { title: "Reprocessar CMV", url: "/reprocessar-cmv", icon: Calculator, modulo: "financeiro" },
    ],
  },
  {
    label: "IA · Anúncios",
    cor: "oklch(0.8 0.12 300)",
    items: [
      { title: "Anúncios", url: "/ia/anuncios", icon: Wand2, modulo: "ia" },
      {
        title: "Configuração da IA", url: "/ia/prompts", icon: Sparkles, modulo: "ia",
        abas: [
          { nome: "Prompts", url: "/ia/prompts" },
          { nome: "Contextos", url: "/ia/contextos" },
        ],
      },
    ],
  },
  {
    label: "Administração",
    cor: "#A78BFA",
    items: [
      { title: "Usuários e acessos", url: "/usuarios", icon: Users, modulo: "todos" },
    ],
  },
];

const CHAVE_GRUPOS = "menu.gruposAbertos";
const CHAVE_FAVORITOS = "menu.favoritos";
const COR_FAVORITOS = "#FACC15";
const CHAVE_ORDEM = "menu.ordem";

// Ordem do menu escolhida pela pessoa (26/nov/2026, pedido do dono): grupos e itens
// arrastáveis, item pode ir para outro grupo. Fica neste navegador, como os favoritos.
type OrdemMenu = { grupos: string[]; itens: Record<string, string[]> };

function aplicarOrdem(ordem: OrdemMenu | null): NavGroup[] {
  if (!ordem) return NAV_GROUPS;
  const porUrl = new Map<string, NavItem>();
  NAV_GROUPS.forEach((g) => g.items.forEach((it) => porUrl.set(it.url, it)));
  const usados = new Set<string>();
  const labels = [
    ...ordem.grupos.filter((l) => NAV_GROUPS.some((g) => g.label === l)),
    ...NAV_GROUPS.map((g) => g.label).filter((l) => !ordem.grupos.includes(l)),
  ];
  const grupos = labels.map((l) => {
    const base = NAV_GROUPS.find((g) => g.label === l)!;
    const items: NavItem[] = [];
    for (const u of ordem.itens[l] ?? []) {
      const it = porUrl.get(u);
      if (it && !usados.has(u)) { items.push(it); usados.add(u); }
    }
    return { ...base, items };
  });
  // item novo (ou que não estava na ordem salva) fica no grupo de origem, no fim
  NAV_GROUPS.forEach((g) => g.items.forEach((it) => {
    if (!usados.has(it.url)) grupos.find((x) => x.label === g.label)!.items.push(it);
  }));
  return grupos;
}
const ordemDe = (gs: NavGroup[]): OrdemMenu => ({
  grupos: gs.map((g) => g.label),
  itens: Object.fromEntries(gs.map((g) => [g.label, g.items.map((it) => it.url)])),
});

type Local = { grupo: NavGroup; item: NavItem; aba: NavAba | null };

/** Item (e aba) da rota atual: a url mais longa que casa ganha ("/produtos-margem" ≠ "/produtos"). */
export function localizarRota(pathname: string): Local | null {
  let melhor: (Local & { len: number }) | null = null;
  for (const g of NAV_GROUPS) {
    for (const it of g.items) {
      const alvos: Array<{ url: string; aba: NavAba | null }> = it.abas?.length
        ? it.abas.map((a) => ({ url: a.url, aba: a }))
        : [{ url: it.url, aba: null }];
      for (const a of alvos) {
        const casa = a.url === "/" ? pathname === "/" : pathname.startsWith(a.url);
        if (casa && (!melhor || a.url.length > melhor.len)) melhor = { grupo: g, item: it, aba: a.aba, len: a.url.length };
      }
    }
  }
  return melhor;
}

// Título + grupo da rota atual (usado no header do shell).
export function crumbDaRota(pathname: string): { grupo: string; titulo: string } {
  const l = localizarRota(pathname);
  if (!l) return { grupo: "Ottz Commerce", titulo: "Painel" };
  const primeira = !l.aba || l.aba.url === l.item.abas?.[0]?.url;
  return { grupo: l.grupo.label, titulo: primeira ? l.item.title : `${l.item.title} · ${l.aba!.nome}` };
}

/** Barra de abas no topo do conteúdo quando a tela atual é uma aba de um item do menu. */
export function AbasDaTela() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const l = localizarRota(pathname);
  if (!l?.aba || !l.item.abas) return null;
  return (
    <div className="px-6 md:px-8 pt-4">
      <div className="inline-flex h-10 max-w-full items-center gap-1 overflow-x-auto rounded-md border border-input bg-card p-1 text-foreground">
        {l.item.abas.map((a) => {
          const ativo = a.url === l.aba!.url;
          return (
            <Link
              key={a.url}
              to={a.url}
              className={cn(
                "inline-flex items-center whitespace-nowrap rounded-sm px-4 py-1.5 text-sm font-medium transition-all",
                ativo ? "bg-primary text-primary-foreground font-semibold" : "hover:bg-accent",
              )}
            >
              {a.nome}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function lerLocal<T>(chave: string, padrao: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(chave) ?? "null");
    return v ?? padrao;
  } catch {
    return padrao;
  }
}
function gravarLocal(chave: string, valor: unknown) {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch {
    /* sem armazenamento: só não lembra */
  }
}

export function AppSidebar() {
  const currentPath = useRouterState({ select: (router) => router.location.pathname });
  const { temAcesso } = usePerfil();
  const { user } = useAuth();

  // Grupos fechados por padrão (pedido do dono, 14/out/2026): abre só o grupo da tela atual
  // e o que a pessoa abrir à mão. Favoritos: sempre visíveis, numa seção própria no topo.
  // Os dois ficam neste navegador (lidos depois de montar, para não divergir do SSR).
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});
  const [favoritos, setFavoritos] = useState<string[]>([]);
  const [carregado, setCarregado] = useState(false);
  const [ordem, setOrdem] = useState<OrdemMenu | null>(null);
  const [organizando, setOrganizando] = useState(false);
  const [arrastando, setArrastando] = useState<{ tipo: "grupo" | "item"; id: string } | null>(null);
  const [sobre, setSobre] = useState<string | null>(null);
  useEffect(() => {
    const g = lerLocal<Record<string, boolean>>(CHAVE_GRUPOS, {});
    const f = lerLocal<string[]>(CHAVE_FAVORITOS, []);
    setAbertos(g && typeof g === "object" ? g : {});
    setFavoritos(Array.isArray(f) ? f.filter((x) => typeof x === "string") : []);
    const o = lerLocal<OrdemMenu | null>(CHAVE_ORDEM, null);
    setOrdem(o && Array.isArray(o.grupos) && o.itens && typeof o.itens === "object" ? o : null);
    setCarregado(true);
  }, []);
  const local = localizarRota(currentPath);
  const grupoAtual = local?.grupo.label ?? "";
  useEffect(() => {
    if (!carregado || !grupoAtual) return;
    setAbertos((a) => (a[grupoAtual] ? a : { ...a, [grupoAtual]: true }));
  }, [grupoAtual, carregado]);
  useEffect(() => {
    if (carregado) gravarLocal(CHAVE_GRUPOS, abertos);
  }, [abertos, carregado]);
  useEffect(() => {
    if (carregado) gravarLocal(CHAVE_FAVORITOS, favoritos);
  }, [favoritos, carregado]);
  const grupos = aplicarOrdem(ordem);
  const salvarOrdem = (gs: NavGroup[]) => {
    const o = ordemDe(gs);
    setOrdem(o);
    gravarLocal(CHAVE_ORDEM, o);
  };
  const restaurarOrdem = () => {
    setOrdem(null);
    try { localStorage.removeItem(CHAVE_ORDEM); } catch { /* sem armazenamento */ }
  };
  const moverGrupo = (label: string, destino: number) => {
    const gs = [...grupos];
    const i = gs.findIndex((g) => g.label === label);
    if (i < 0 || destino < 0 || destino >= gs.length || i === destino) return;
    const [g] = gs.splice(i, 1);
    gs.splice(destino, 0, g);
    salvarOrdem(gs);
  };
  /** Leva o item ao grupo `paraGrupo`, antes do item `antesDe` (null = no fim). */
  const moverItem = (url: string, paraGrupo: string, antesDe: string | null) => {
    if (url === antesDe) return;
    const gs = grupos.map((g) => ({ ...g, items: [...g.items] }));
    let item: NavItem | undefined;
    for (const g of gs) {
      const i = g.items.findIndex((it) => it.url === url);
      if (i >= 0) [item] = g.items.splice(i, 1);
    }
    const alvo = gs.find((g) => g.label === paraGrupo);
    if (!item || !alvo) return;
    const j = antesDe ? alvo.items.findIndex((it) => it.url === antesDe) : -1;
    if (j >= 0) alvo.items.splice(j, 0, item); else alvo.items.push(item);
    salvarOrdem(gs);
  };
  const subirDescerItem = (url: string, delta: number) => {
    const gs = grupos.map((x) => ({ ...x, items: [...x.items] }));
    const g = gs.find((x) => x.items.some((it) => it.url === url));
    if (!g) return;
    const i = g.items.findIndex((it) => it.url === url);
    const j = i + delta;
    if (j < 0 || j >= g.items.length) return;
    [g.items[i], g.items[j]] = [g.items[j], g.items[i]];
    salvarOrdem(gs);
  };
  const soltar = (alvoGrupo: string, antesDe: string | null) => {
    const a = arrastando;
    setArrastando(null);
    setSobre(null);
    if (!a) return;
    if (a.tipo === "item") moverItem(a.id, alvoGrupo, antesDe);
    else moverGrupo(a.id, grupos.findIndex((g) => g.label === alvoGrupo));
  };

  const alternarFavorito = (url: string) =>
    setFavoritos((f) => (f.includes(url) ? f.filter((x) => x !== url) : [...f, url]));

  const [anomaliasCount, setAnomaliasCount] = useState(0);
  useEffect(() => {
    let cancel = false;
    const buscar = async () => {
      try {
        const { count } = await supabaseExternal
          .from("view_anomalias")
          .select("*", { count: "exact", head: true })
          .eq("severidade", "alta");
        if (!cancel && typeof count === "number") setAnomaliasCount(count);
      } catch {
        /* silencioso */
      }
    };
    void buscar();
    const interval = setInterval(() => void buscar(), 5 * 60 * 1000);
    return () => {
      cancel = true;
      clearInterval(interval);
    };
  }, []);

  const email = user?.email ?? "";
  const iniciais = (email.split("@")[0] || "?").slice(0, 2).toUpperCase();

  // favoritos na ordem em que foram marcados, só os que a pessoa pode abrir
  const todos = grupos.flatMap((g) => g.items.map((it) => ({ it, cor: g.cor })));
  const favs = favoritos
    .map((u) => todos.find((x) => x.it.url === u))
    .filter((x): x is { it: NavItem; cor: string } => !!x && temAcesso(x.it.modulo));

  const botaoSeta = "p-0.5 rounded hover:bg-[var(--sb-hv)] disabled:opacity-25 text-[color:var(--sb-txt2)]";
  const linhaOrganizar = (it: NavItem, g: NavGroup, idx: number, total: number) => (
    <div
      key={"o:" + it.url}
      draggable
      onDragStart={(e) => { e.stopPropagation(); setArrastando({ tipo: "item", id: it.url }); e.dataTransfer.effectAllowed = "move"; }}
      onDragEnd={() => { setArrastando(null); setSobre(null); }}
      onDragOver={(e) => { if (arrastando?.tipo === "item") { e.preventDefault(); e.stopPropagation(); setSobre("i:" + it.url); } }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); soltar(g.label, it.url); }}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-[9px] text-[13px] text-[color:var(--sb-txt)] cursor-grab active:cursor-grabbing border-t-2 border-transparent",
        sobre === "i:" + it.url && arrastando?.id !== it.url && "border-[color:var(--sb-txt)]",
        arrastando?.id === it.url && "opacity-40",
      )}
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-[color:var(--sb-txt2)]" />
      <it.icon className="h-4 w-4 shrink-0" style={{ color: g.cor }} />
      <span className="flex-1 truncate">{it.title}</span>
      <button type="button" disabled={idx === 0} onClick={() => subirDescerItem(it.url, -1)} className={botaoSeta} aria-label="Subir" title="Subir">
        <ArrowUp className="h-3 w-3" />
      </button>
      <button type="button" disabled={idx === total - 1} onClick={() => subirDescerItem(it.url, 1)} className={botaoSeta} aria-label="Descer" title="Descer">
        <ArrowDown className="h-3 w-3" />
      </button>
    </div>
  );

  const linha = (it: NavItem, cor: string, emFavoritos: boolean) => {
    const ativo = local?.item === it;
    const badge = it.badgeKey === "anomalias" ? anomaliasCount || null : null;
    const fav = favoritos.includes(it.url);
    return (
      <div key={(emFavoritos ? "f:" : "") + it.url} className="group relative">
        <Link
          to={it.url}
          className={cn(
            "flex items-center gap-2.5 px-3 py-2 pr-8 rounded-[9px] text-[13.5px] font-normal transition-colors",
            ativo
              ? "bg-accent text-accent-foreground font-semibold"
              : "text-[color:var(--sb-txt)] hover:bg-[var(--sb-hv)]",
          )}
          style={{ "--cor": cor } as CSSProperties}
        >
          <it.icon className="h-4 w-4 shrink-0" style={{ color: ativo ? "currentColor" : "var(--sb-icone)" }} />
          <span className="flex-1 truncate">{it.title}</span>
          {badge != null && (
            <span className="bg-[var(--sb-badge-bg)] text-[color:var(--sb-badge-t)] text-[10px] font-semibold px-1.5 py-0.5 rounded-full font-mono">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </Link>
        <button
          type="button"
          onClick={() => alternarFavorito(it.url)}
          title={fav ? "Tirar dos favoritos" : "Adicionar aos favoritos"}
          aria-label={fav ? "Tirar dos favoritos" : "Adicionar aos favoritos"}
          className={cn(
            "absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-opacity",
            fav && emFavoritos ? "opacity-0 group-hover:opacity-100" : fav ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
          )}
        >
          <Star
            className="h-3.5 w-3.5"
            style={{ color: fav ? COR_FAVORITOS : ativo ? "#FFFFFF" : "var(--sb-txt2)" }}
            fill={fav ? COR_FAVORITOS : "none"}
          />
        </button>
      </div>
    );
  };

  return (
    <aside className="w-[252px] shrink-0 bg-[var(--sb-bg)] flex flex-col sticky top-0 h-screen border-r border-[var(--sb-borda)]">
      {/* Marca */}
      <Link to="/" className="flex items-center gap-3 px-5 py-[18px] border-b border-[var(--sb-borda)]">
        <div className="h-[34px] w-[34px] rounded-[10px] bg-primary flex items-center justify-center text-white font-bold text-[15px] tracking-tight shrink-0">
          O
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[color:var(--sb-txt)] text-sm font-semibold tracking-tight">Ottz Commerce</span>
          <span className="text-[color:var(--sb-txt2)] text-[11px] font-medium">Gestão de vendas</span>
        </div>
      </Link>

      {/* Navegação */}
      <nav className="flex-1 overflow-y-auto px-3 py-3.5 flex flex-col gap-3">
        {/* Favoritos: sempre abertos */}
        <div className={cn("flex flex-col gap-0.5", organizando && "hidden")}>
          <div
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.09em]"
            style={{ color: COR_FAVORITOS }}
          >
            <Star className="h-3 w-3 shrink-0" fill={COR_FAVORITOS} />
            <span className="flex-1 text-left">Favoritos</span>
          </div>
          {favs.length ? (
            <div className="flex flex-col gap-px">{favs.map((x) => linha(x.it, x.cor, true))}</div>
          ) : (
            <p className="px-3 pb-1 text-[11.5px] leading-snug text-[color:var(--sb-txt2)]">
              Passe o mouse num item do menu e clique na estrela para fixá-lo aqui.
            </p>
          )}
        </div>

        {organizando && (
          <div className="flex flex-col gap-1.5 rounded-[9px] border border-dashed border-[var(--sb-borda)] px-3 py-2 text-[11.5px] leading-snug text-[color:var(--sb-txt2)]">
            <span>Arraste os grupos e os itens (ou use as setas). Solte um item sobre o título de outro grupo para mudá-lo de grupo.</span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setOrganizando(false)} className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-semibold text-white">Pronto</button>
              <button type="button" onClick={() => { if (window.confirm("Voltar o menu para a ordem padrão?")) restaurarOrdem(); }} className="rounded-md px-2.5 py-1 text-[12px] text-[color:var(--sb-txt)] hover:bg-[var(--sb-hv)]">Ordem padrão</button>
            </div>
          </div>
        )}
        {grupos.map((g, gi) => {
          const itens = g.items.filter((it) => temAcesso(it.modulo));
          if (itens.length === 0 && !organizando) return null;
          if (organizando) {
            return (
              <div
                key={g.label}
                className={cn("flex flex-col gap-0.5 rounded-md border-t-2 border-transparent", sobre === "g:" + g.label && "border-[color:var(--sb-txt)]", arrastando?.id === g.label && "opacity-40")}
                onDragOver={(e) => { if (arrastando) { e.preventDefault(); setSobre("g:" + g.label); } }}
                onDrop={(e) => { e.preventDefault(); soltar(g.label, null); }}
              >
                <div
                  draggable
                  onDragStart={(e) => { setArrastando({ tipo: "grupo", id: g.label }); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setArrastando(null); setSobre(null); }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.09em] cursor-grab active:cursor-grabbing"
                  style={{ color: "var(--sb-grupo)" }}
                >
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-[color:var(--sb-txt2)]" />
                  <span className="h-3 w-[3px] rounded-full shrink-0" style={{ background: g.cor }} />
                  <span className="flex-1 text-left truncate">{g.label}</span>
                  <button type="button" disabled={gi === 0} onClick={() => moverGrupo(g.label, gi - 1)} className={botaoSeta} aria-label="Subir grupo" title="Subir grupo">
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button type="button" disabled={gi === grupos.length - 1} onClick={() => moverGrupo(g.label, gi + 1)} className={botaoSeta} aria-label="Descer grupo" title="Descer grupo">
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex flex-col gap-px pl-2">
                  {itens.length ? itens.map((it, i) => linhaOrganizar(it, g, i, itens.length)) : (
                    <span className="px-2 py-1 text-[11.5px] text-[color:var(--sb-txt2)]">vazio — solte um item aqui</span>
                  )}
                </div>
              </div>
            );
          }
          const aberto = abertos[g.label];
          return (
            <div key={g.label} className="flex flex-col gap-0.5">
              <button
                onClick={() => setAbertos((a) => ({ ...a, [g.label]: !a[g.label] }))}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.09em] rounded-md hover:bg-[var(--sb-hv)] transition"
                style={{ "--cor": g.cor, color: "var(--sb-grupo)" } as CSSProperties}
              >
                <span className="h-3 w-[3px] rounded-full shrink-0" style={{ background: g.cor }} />
                <span className="flex-1 text-left">{g.label}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !aberto && "-rotate-90")} />
              </button>
              {aberto && <div className="flex flex-col gap-px">{itens.map((it) => linha(it, g.cor, false))}</div>}
            </div>
          );
        })}
      </nav>

      {/* Usuário */}
      <div className="px-3 py-3 border-t border-[var(--sb-borda)] flex items-center gap-2.5">
        <div className="h-[30px] w-[30px] rounded-full bg-[var(--sb-avatar)] text-[color:var(--sb-txt2)] flex items-center justify-center text-xs font-semibold shrink-0">
          {iniciais}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-[color:var(--sb-txt)] text-[12.5px] font-medium truncate">{email ? email.split("@")[0] : "Usuário"}</span>
          <span className="text-[color:var(--sb-txt2)] text-[11px] truncate">{email || "—"}</span>
        </div>
        <button
          type="button"
          onClick={() => { setOrganizando((v) => !v); setArrastando(null); setSobre(null); }}
          title={organizando ? "Terminar de organizar" : "Organizar o menu (mudar a ordem)"}
          aria-label="Organizar o menu"
          className={cn("rounded-md p-1.5 transition hover:bg-[var(--sb-hv)]", organizando ? "text-white bg-primary" : "text-[color:var(--sb-txt2)]")}
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
