import { useEffect } from "react";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { Loader2, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";
import { usePerfil, moduloDaRota, primeiraRotaPermitida } from "@/hooks/usePerfil";

export function PerfilGate({ children }: { children: React.ReactNode }) {
  const { perfil, loading, temAcesso } = usePerfil();
  const { signOut } = useAuth();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const navigate = useNavigate();

  const permitido = perfil && perfil.ativo && temAcesso(moduloDaRota(pathname));

  useEffect(() => {
    if (loading || !perfil || !perfil.ativo) return;
    if (!temAcesso(moduloDaRota(pathname))) {
      const destino = primeiraRotaPermitida(perfil.modulos);
      if (destino !== pathname) navigate({ to: destino, replace: true });
    }
  }, [pathname, perfil, loading]);

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!perfil || !perfil.ativo) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <Card className="max-w-md w-full p-8 text-center space-y-4">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <ShieldAlert className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold">Acesso não liberado</h1>
          <p className="text-sm text-muted-foreground">
            Sua conta ainda não tem permissão para acessar o sistema. Fale com o administrador.
          </p>
          <Button variant="outline" onClick={() => signOut()} className="mt-2">
            <LogOut className="h-4 w-4 mr-2" /> Sair
          </Button>
        </Card>
      </div>
    );
  }

  if (!permitido) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}
