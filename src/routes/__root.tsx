import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { LogOut } from "lucide-react";
import appCss from "../styles.css?url";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Toaster } from "@/components/ui/sonner";
import { AuthGate } from "@/components/AuthGate";
import { useAuth } from "@/hooks/useAuth";
import { PerfilProvider } from "@/hooks/usePerfil";
import { PerfilGate } from "@/components/PerfilGate";
import { Button } from "@/components/ui/button";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Página não encontrada</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A página que você procura não existe ou foi movida.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Shopee Analytics — Dashboard do vendedor" },
      {
        name: "description",
        content:
          "Plataforma visual para consolidar vendas, anúncios e carteira da Shopee. Faça upload dos seus relatórios e veja KPIs, gráficos e análises por SKU, UF e tipo de envio.",
      },
      { name: "author", content: "Shopee Analytics" },
      { property: "og:title", content: "Shopee Analytics — Dashboard do vendedor" },
      {
        property: "og:description",
        content:
          "Consolide vendas, anúncios e carteira da Shopee em um dashboard interativo. Sem instalação.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Shopee Analytics — Dashboard do vendedor" },
      { name: "description", content: "Claude Canvas transforms Python applications into interactive visual platforms." },
      { property: "og:description", content: "Claude Canvas transforms Python applications into interactive visual platforms." },
      { name: "twitter:description", content: "Claude Canvas transforms Python applications into interactive visual platforms." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/0d44f6ee-fdd1-4555-aeb7-95fd13673d3a/id-preview-989d8d31--9ab2b945-8c61-48ed-a57b-8e3dad41e56b.lovable.app-1779150306487.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/0d44f6ee-fdd1-4555-aeb7-95fd13673d3a/id-preview-989d8d31--9ab2b945-8c61-48ed-a57b-8e3dad41e56b.lovable.app-1779150306487.png" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <AppShell />
      </AuthGate>
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  );
}

function AppShell() {
  const { user, signOut } = useAuth();
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-14 flex items-center gap-3 border-b border-border bg-card px-4 sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-card/85">
            <SidebarTrigger />
            <div className="text-sm text-muted-foreground flex-1">
              Plataforma de análise de vendedores Shopee
            </div>
            {user && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {user.email}
                </span>
                <Button variant="ghost" size="sm" onClick={() => signOut()}>
                  <LogOut className="h-4 w-4" />
                  <span className="ml-1.5 hidden sm:inline">Sair</span>
                </Button>
              </div>
            )}
          </header>
          <main className="flex-1 min-w-0">
            <Outlet />
          </main>
        </div>
        <Toaster position="top-right" richColors />
      </div>
    </SidebarProvider>
  );
}
