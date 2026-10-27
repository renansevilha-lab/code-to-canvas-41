import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";
import {
  BarChart3,
  Calculator,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  LayoutDashboard,
  Receipt,
  ClipboardList,
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
  Users,
  ChevronDown,
  Sparkles,
  Wand2,
  Star,
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
      { title: "Pedidos", url: "/pedidos", icon: ClipboardList, modulo: "separacao" },
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
      { title: "Devoluções", url: "/devolucoes", icon: RotateCcw, modulo: "devolucoes" },
      {
        title: "Equipe", url: "/processos", icon: ClipboardCheck, modulo: "galpao",
        abas: [
          { nome: "Manual de Operação", url: "/processos" },
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
          { nome: "Saúde dos anúncios ML", url: "/saude-ml" },
        ],
      },
      { title: "Promoções", url: "/promocoes", icon: Zap, modulo: "ads" },
      { title: "Pesquisa de produtos", url: "/pesquisa-produtos", icon: Telescope, modulo: "ads" },
      { title: "Amazon", url: "/amazon", icon: ShoppingCart, modulo: "produtos" },
    ],
  },
  {
    label: "Financeiro",
    cor: "#34D399",
    items: [
      { title: "DRE", url: "/dre", icon: FileBarChart, modulo: "financeiro" },
      { title: "Fluxo de Caixa", url: "/fluxo-caixa", icon: Wallet, modulo: "financeiro" },
      { title: "Contas a Pagar", url: "/contas-pagar", icon: Receipt, modulo: "financeiro" },
      { title: "Reprocessar CMV", url: "/reprocessar-cmv", icon: Calculator, modulo: "financeiro" },
      {
        title: "Carteira", url: "/carteira", icon: Wallet, modulo: "financeiro",
        abas: [
          { nome: "Carteira", url: "/carteira" },
          { nome: "Saldos MKT", url: "/carteira-saldos" },
        ],
      },
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
  useEffect(() => {
    const g = lerLocal<Record<string, boolean>>(CHAVE_GRUPOS, {});
    const f = lerLocal<string[]>(CHAVE_FAVORITOS, []);
    setAbertos(g && typeof g === "object" ? g : {});
    setFavoritos(Array.isArray(f) ? f.filter((x) => typeof x === "string") : []);
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
  const todos = NAV_GROUPS.flatMap((g) => g.items.map((it) => ({ it, cor: g.cor })));
  const favs = favoritos
    .map((u) => todos.find((x) => x.it.url === u))
    .filter((x): x is { it: NavItem; cor: string } => !!x && temAcesso(x.it.modulo));

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
        <div className="flex flex-col gap-0.5">
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

        {NAV_GROUPS.map((g) => {
          const itens = g.items.filter((it) => temAcesso(it.modulo));
          if (itens.length === 0) return null;
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
      </div>
    </aside>
  );
}
