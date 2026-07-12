import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
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
import { supabaseExternal } from "@/integrations/supabase/external-client";

type NavItem = {
  title: string;
  url: string;
  icon: typeof ShoppingBag;
  badgeKey?: "anomalias";
};

const principal: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Metas", url: "/metas", icon: Target },
  { title: "Anomalias", url: "/anomalias", icon: AlertTriangle, badgeKey: "anomalias" },
  { title: "Pedidos", url: "/pedidos", icon: ClipboardList },
  { title: "Pedidos Integrados", url: "/pedidos-integrados", icon: Boxes },
  { title: "Separação", url: "/separacao", icon: PackageCheck },
  { title: "Contas a Pagar", url: "/contas-pagar", icon: Receipt },
  { title: "Fluxo de Caixa", url: "/fluxo-caixa", icon: Wallet },
  { title: "Catálogo", url: "/produtos", icon: Package },
];

const modulos: NavItem[] = [
  { title: "Produtos", url: "/produtos-margem", icon: Package },
  { title: "Amazon", url: "/amazon", icon: ShoppingCart },
  { title: "Mapeamento SKUs", url: "/mapeamento-skus", icon: Link2 },
  { title: "ADS Shopee", url: "/ads-shopee", icon: Megaphone },
  { title: "Tendências", url: "/tendencias", icon: TrendingUp },
  { title: "Carteira", url: "/carteira", icon: Wallet },
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

  const renderGroup = (label: string, items: NavItem[]) => (
    <SidebarGroup>
      {!collapsed && (
        <SidebarGroupLabel className="text-[11px] uppercase tracking-wider text-muted-foreground/70 font-medium">
          {label}
        </SidebarGroupLabel>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
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
  );

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
        {renderGroup("Principal", principal)}
        {renderGroup("Módulos", modulos)}
      </SidebarContent>
    </Sidebar>
  );
}
