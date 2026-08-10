import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Calculator,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  LayoutDashboard,
  Receipt,
  ClipboardList,
  Boxes,
  PackageCheck,
  ShoppingCart,
  Link2,
  Target,
  ShoppingBag,
  AlertTriangle,
  FileBarChart,
  Warehouse,
  Radar,
  RotateCcw,
  Zap,
  Users,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { usePerfil } from "@/hooks/usePerfil";
import { useAuth } from "@/hooks/useAuth";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";

interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  modulo: string;
  badgeKey?: "anomalias";
}
interface NavGroup {
  label: string;
  items: NavItem[];
}

// Estrutura de navegação (organização revisada, mantendo todos os itens).
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Visão",
    items: [
      { title: "Dashboard", url: "/", icon: LayoutDashboard, modulo: "dashboard" },
      { title: "Vendas por produto", url: "/vendas", icon: BarChart3, modulo: "dashboard" },
      { title: "Metas", url: "/metas", icon: Target, modulo: "dashboard" },
      { title: "Tendências", url: "/tendencias", icon: TrendingUp, modulo: "dashboard" },
      { title: "Anomalias", url: "/anomalias", icon: AlertTriangle, modulo: "dashboard", badgeKey: "anomalias" },
    ],
  },
  {
    label: "Pedidos & Operação",
    items: [
      { title: "Pedidos", url: "/pedidos", icon: ClipboardList, modulo: "separacao" },
      { title: "Pedidos Integrados", url: "/pedidos-integrados", icon: Boxes, modulo: "separacao" },
      { title: "Separação", url: "/separacao", icon: PackageCheck, modulo: "galpao" },
      { title: "Monitoramento", url: "/monitoramento", icon: Radar, modulo: "galpao" },
      { title: "Fulfillment", url: "/fulfillment", icon: Warehouse, modulo: "galpao" },
      { title: "Devoluções", url: "/devolucoes", icon: RotateCcw, modulo: "financeiro" },
    ],
  },
  {
    label: "Produtos",
    items: [
      { title: "Catálogo", url: "/produtos", icon: Package, modulo: "produtos" },
      { title: "Produtos", url: "/produtos-margem", icon: ShoppingBag, modulo: "produtos" },
      { title: "Mapeamento SKUs", url: "/mapeamento-skus", icon: Link2, modulo: "produtos" },
    ],
  },
  {
    label: "Mídia & Canais",
    items: [
      { title: "ADS Shopee", url: "/ads-shopee", icon: Megaphone, modulo: "ads" },
      { title: "ADS Mercado Livre", url: "/ads-ml", icon: Megaphone, modulo: "ads" },
      { title: "Saúde ML", url: "/saude-ml", icon: Activity, modulo: "ads" },
      { title: "Promoções", url: "/promocoes", icon: Zap, modulo: "ads" },
      { title: "Amazon", url: "/amazon", icon: ShoppingCart, modulo: "produtos" },
    ],
  },
  {
    label: "Financeiro",
    items: [
      { title: "DRE", url: "/dre", icon: FileBarChart, modulo: "financeiro" },
      { title: "Fluxo de Caixa", url: "/fluxo-caixa", icon: Wallet, modulo: "financeiro" },
      { title: "Contas a Pagar", url: "/contas-pagar", icon: Receipt, modulo: "financeiro" },
      { title: "Reprocessar CMV", url: "/reprocessar-cmv", icon: Calculator, modulo: "financeiro" },
      { title: "Carteira", url: "/carteira", icon: Wallet, modulo: "financeiro" },
      { title: "Saldos MKT", url: "/carteira-saldos", icon: Wallet, modulo: "financeiro" },
    ],
  },
  {
    label: "Administração",
    items: [
      { title: "Usuários e acessos", url: "/usuarios", icon: Users, modulo: "todos" },
    ],
  },
];

// Título + grupo da rota atual (usado no header do shell).
export function crumbDaRota(pathname: string): { grupo: string; titulo: string } {
  let melhor: { grupo: string; titulo: string; len: number } | null = null;
  for (const g of NAV_GROUPS) {
    for (const it of g.items) {
      const match = it.url === "/" ? pathname === "/" : pathname.startsWith(it.url);
      if (match && (!melhor || it.url.length > melhor.len)) {
        melhor = { grupo: g.label, titulo: it.title, len: it.url.length };
      }
    }
  }
  return melhor ? { grupo: melhor.grupo, titulo: melhor.titulo } : { grupo: "Ottz Commerce", titulo: "Painel" };
}

export function AppSidebar() {
  const currentPath = useRouterState({ select: (router) => router.location.pathname });
  const { temAcesso } = usePerfil();
  const { user } = useAuth();

  const [abertos, setAbertos] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(NAV_GROUPS.map((g) => [g.label, true])),
  );
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

  const isActive = (path: string) => (path === "/" ? currentPath === "/" : currentPath.startsWith(path));

  const email = user?.email ?? "";
  const iniciais = (email.split("@")[0] || "?").slice(0, 2).toUpperCase();

  return (
    <aside className="w-[252px] shrink-0 bg-[#0E1114] flex flex-col sticky top-0 h-screen border-r border-[#1C2027]">
      {/* Marca */}
      <Link to="/" className="flex items-center gap-3 px-5 py-[18px] border-b border-[#1C2027]">
        <div className="h-[34px] w-[34px] rounded-[10px] bg-primary flex items-center justify-center text-white font-bold text-[15px] tracking-tight shrink-0">
          O
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-white text-sm font-semibold tracking-tight">Ottz Commerce</span>
          <span className="text-[#6B7483] text-[11px] font-medium">Gestão de vendas</span>
        </div>
      </Link>

      {/* Navegação */}
      <nav className="flex-1 overflow-y-auto px-3 py-3.5 flex flex-col gap-3.5">
        {NAV_GROUPS.map((g) => {
          const itens = g.items.filter((it) => temAcesso(it.modulo));
          if (itens.length === 0) return null;
          const aberto = abertos[g.label];
          return (
            <div key={g.label} className="flex flex-col gap-0.5">
              <button
                onClick={() => setAbertos((a) => ({ ...a, [g.label]: !a[g.label] }))}
                className="flex items-center justify-between w-full px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-[#5D6675] hover:text-[#8B95A5] transition-colors"
              >
                <span>{g.label}</span>
                <ChevronDown className={cn("h-3 w-3 transition-transform", !aberto && "-rotate-90")} />
              </button>
              {aberto && (
                <div className="flex flex-col gap-px">
                  {itens.map((it) => {
                    const ativo = isActive(it.url);
                    const badge = it.badgeKey === "anomalias" ? anomaliasCount || null : null;
                    return (
                      <Link
                        key={it.url}
                        to={it.url}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-2 rounded-[9px] text-[13.5px] font-medium tracking-tight transition-colors",
                          ativo ? "bg-primary text-white" : "text-[#98A1AF] hover:bg-[#1A1F27] hover:text-[#E8EBF0]",
                        )}
                      >
                        <it.icon className="h-4 w-4 shrink-0 opacity-90" />
                        <span className="flex-1 truncate">{it.title}</span>
                        {badge != null && (
                          <span className="bg-[#3A1D1D] text-[#F08A7A] text-[10px] font-semibold px-1.5 py-0.5 rounded-full font-mono">
                            {badge > 99 ? "99+" : badge}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Usuário */}
      <div className="px-3 py-3 border-t border-[#1C2027] flex items-center gap-2.5">
        <div className="h-[30px] w-[30px] rounded-full bg-[#232A33] text-[#B9C2CF] flex items-center justify-center text-xs font-semibold shrink-0">
          {iniciais}
        </div>
        <div className="flex-1 min-w-0 flex flex-col">
          <span className="text-[#D5DAE2] text-[12.5px] font-medium truncate">{email ? email.split("@")[0] : "Usuário"}</span>
          <span className="text-[#5D6675] text-[11px] truncate">{email || "—"}</span>
        </div>
      </div>
    </aside>
  );
}
