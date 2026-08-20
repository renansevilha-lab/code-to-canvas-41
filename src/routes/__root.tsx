import { Outlet, Link, createRootRoute, HeadContent, Scripts, useRouterState } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, useEffect, useState, type ReactNode } from "react";


import { LogOut, PanelLeft } from "lucide-react";
import appCss from "../styles.css?url";
import { AppSidebar, crumbDaRota } from "@/components/AppSidebar";
import { Toaster } from "@/components/ui/sonner";
import { AuthGate } from "@/components/AuthGate";
import { useLogoutInatividade } from "@/hooks/useLogoutInatividade";
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
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

// Boundary de render: impede que um erro em uma tela apague o app inteiro
// (tela branca). Mostra uma mensagem recuperável mantendo o shell/sidebar.
// Reseta ao trocar de rota (key={pathname} no uso).
class RouteErrorBoundary extends Component<{ children: ReactNode }, { erro: Error | null }> {
  state: { erro: Error | null } = { erro: null };
  static getDerivedStateFromError(erro: Error) {
    return { erro };
  }
  componentDidCatch(erro: Error) {
    // eslint-disable-next-line no-console
    console.error("[render] erro nesta tela:", erro);
  }
  render() {
    if (this.state.erro) {
      return (
        <div className="w-full px-6 md:px-8 py-20 flex flex-col items-center justify-center text-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center text-2xl font-semibold">!</div>
          <h2 className="text-lg font-semibold text-foreground">Algo deu errado nesta tela</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            Um erro inesperado interrompeu o carregamento. Recarregue a página; se continuar, avise o suporte.
          </p>
          <p className="text-[11px] font-mono text-muted-foreground/70 max-w-lg break-words">{this.state.erro.message}</p>
          <Button size="sm" className="mt-2" onClick={() => window.location.reload()}>
            Recarregar
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

function RootShell({ children }: { children: ReactNode }) {
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

// QueryClient criado UMA vez no nível de módulo — nunca recriado em re-render.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
      placeholderData: (previousData: unknown) => previousData,
    },
  },
});

function RootComponent() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <PerfilProvider>
          <AppShell />
        </PerfilProvider>
      </AuthGate>
      <Toaster position="top-right" richColors />
    </QueryClientProvider>
  );
}


function AppShell() {
  const { user, signOut } = useAuth();
  // Sessão do Supabase se renova sozinha: sem isto ninguém nunca é desconectado.
  // Só age fora do expediente (18h–7h) para não derrubar a bancada no meio do dia.
  useLogoutInatividade(signOut);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { grupo, titulo } = crumbDaRota(pathname);
  // Menu recolhível (persistido). Inicia aberto no SSR/primeiro render e lê o
  // localStorage após montar — evita mismatch de hidratação.
  const [navAberto, setNavAberto] = useState(true);
  useEffect(() => {
    try { setNavAberto(localStorage.getItem("nav.aberto") !== "0"); } catch { /* noop */ }
  }, []);
  function toggleNav() {
    setNavAberto((v) => {
      const nv = !v;
      try { localStorage.setItem("nav.aberto", nv ? "1" : "0"); } catch { /* noop */ }
      return nv;
    });
  }
  return (
    <div className="min-h-screen flex w-full bg-background">
      {navAberto && <AppSidebar />}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border px-8 py-3.5 bg-background/85 backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleNav}
            title={navAberto ? "Recolher menu" : "Expandir menu"}
            aria-label={navAberto ? "Recolher menu" : "Expandir menu"}
            className="shrink-0 -ml-2 h-9 w-9"
          >
            <PanelLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground font-medium">
              <span>{grupo}</span>
              <span className="opacity-50">/</span>
              <span className="text-foreground">{titulo}</span>
            </div>
            <h1 className="text-[21px] font-semibold tracking-tight text-foreground leading-none">{titulo}</h1>
          </div>
          <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            <span className="hidden sm:inline">Sincronizado</span>
          </div>
          {user && (
            <Button variant="ghost" size="sm" onClick={() => signOut()}>
              <LogOut className="h-4 w-4" />
              <span className="ml-1.5 hidden sm:inline">Sair</span>
            </Button>
          )}
        </header>
        <main className="flex-1 min-w-0">
          <PerfilGate>
            <RouteErrorBoundary key={pathname}>
              <Outlet />
            </RouteErrorBoundary>
          </PerfilGate>
        </main>
      </div>
    </div>
  );
}
