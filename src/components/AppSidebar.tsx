import { Link, useRouterState } from "@tanstack/react-router";
import {
  ShoppingBag,
  Megaphone,
  Wallet,
  TrendingUp,
  Package,
  LayoutDashboard,
  Plug,
  Receipt,
  ClipboardList,
  Boxes,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";

type NavItem = {
  title: string;
  url: string;
  icon: typeof ShoppingBag;
  status?: "ready" | "soon";
};

const principal: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard, status: "ready" },
  { title: "Pedidos", url: "/pedidos", icon: ClipboardList, status: "ready" },
  { title: "Pedidos Integrados", url: "/pedidos-integrados", icon: Boxes, status: "ready" },
  { title: "Contas a Pagar", url: "/contas-pagar", icon: Receipt, status: "ready" },
  { title: "Fluxo de Caixa", url: "/fluxo-caixa", icon: Wallet, status: "ready" },
  { title: "Catálogo", url: "/produtos", icon: Package, status: "ready" },
];

const modulos: NavItem[] = [
  { title: "Vendas", url: "/vendas", icon: ShoppingBag, status: "ready" },
  { title: "Anúncios", url: "/ads", icon: Megaphone, status: "ready" },
  { title: "Margem (CMV)", url: "/cmv", icon: TrendingUp, status: "ready" },
  { title: "Carteira", url: "/carteira", icon: Wallet, status: "ready" },
  { title: "Resultado", url: "/resultado", icon: Package, status: "soon" },
];

const integracoes: NavItem[] = [
  { title: "Conexões", url: "/conexoes", icon: Plug, status: "ready" },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const currentPath = useRouterState({
    select: (router) => router.location.pathname,
  });

  const isActive = (path: string) => {
    if (path === "/") return currentPath === "/";
    return currentPath.startsWith(path);
  };

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="border-b border-sidebar-border px-4 py-3">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-primary to-primary-glow text-primary-foreground font-bold text-sm shrink-0">
            S
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-sidebar-foreground">
                Shopee Analytics
              </span>
              <span className="text-[11px] text-muted-foreground">
                Dashboard do vendedor
              </span>
            </div>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-medium">
              Principal
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {principal.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    tooltip={collapsed ? item.title : undefined}
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-medium">
              Módulos
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {modulos.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    tooltip={collapsed ? item.title : undefined}
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      {!collapsed && (
                        <>
                          <span className="flex-1">{item.title}</span>
                          {item.status === "soon" && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] py-0 px-1.5 font-normal h-4"
                            >
                              em breve
                            </Badge>
                          )}
                        </>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          {!collapsed && (
            <SidebarGroupLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-medium">
              Integrações
            </SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {integracoes.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.url)}
                    tooltip={collapsed ? item.title : undefined}
                  >
                    <Link to={item.url}>
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
