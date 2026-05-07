import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link2, Plug, RefreshCw, Store } from "lucide-react";
import {
  getShopeeAuthUrl,
  listShopeeConnections,
} from "@/lib/shopee/auth.functions";

type ConexoesSearch = { ok?: string; shop_id?: string };

export const Route = createFileRoute("/conexoes")({
  validateSearch: (s: Record<string, unknown>): ConexoesSearch => ({
    ok: typeof s.ok === "string" ? s.ok : undefined,
    shop_id: typeof s.shop_id === "string" ? s.shop_id : undefined,
  }),
  component: ConexoesPage,
});

function ConexoesPage() {
  const search = useSearch({ from: "/conexoes" });
  const getAuthUrl = useServerFn(getShopeeAuthUrl);
  const listConn = useServerFn(listShopeeConnections);
  const [connecting, setConnecting] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["shopee-connections"],
    queryFn: () => listConn(),
  });

  useEffect(() => {
    if (search.ok === "1" && search.shop_id) {
      toast.success(`Loja ${search.shop_id} conectada com sucesso!`);
      refetch();
    }
  }, [search.ok, search.shop_id, refetch]);

  async function handleConnect() {
    try {
      setConnecting(true);
      const redirectUrl = `${window.location.origin}/api/public/shopee/callback`;
      const { url } = await getAuthUrl({ data: { redirectUrl } });
      window.location.href = url;
    } catch (e) {
      toast.error(`Erro ao gerar URL: ${(e as Error).message}`);
      setConnecting(false);
    }
  }

  const conexoes = data?.connections ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Conexões</h1>
        <p className="text-sm text-muted-foreground">
          Conecte sua loja Shopee para sincronizar pedidos, anúncios e carteira automaticamente.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Plug className="h-4 w-4" /> Shopee Open Platform
              </CardTitle>
              <CardDescription>
                Autorize o app na sua Seller Center para liberar acesso à API.
              </CardDescription>
            </div>
            <Button onClick={handleConnect} disabled={connecting}>
              <Link2 className="h-4 w-4" />
              {connecting ? "Redirecionando..." : "Conectar loja"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : conexoes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma loja conectada ainda. Clique em "Conectar loja" para começar.
            </p>
          ) : (
            <div className="space-y-3">
              {conexoes.map((c) => {
                const expira = new Date(c.expires_at);
                const expirado = expira.getTime() < Date.now();
                return (
                  <div
                    key={c.shop_id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10">
                        <Store className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Shop ID {c.shop_id}</p>
                        <p className="text-xs text-muted-foreground">
                          Token expira em {expira.toLocaleString("pt-BR")}
                        </p>
                      </div>
                    </div>
                    <Badge variant={expirado ? "destructive" : "secondary"}>
                      {expirado ? "Expirado" : "Ativo"}
                    </Badge>
                  </div>
                );
              })}
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="h-3.5 w-3.5" /> Atualizar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Como funciona</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>1. Clique em <b>Conectar loja</b> — você será redirecionado à Shopee.</p>
          <p>2. Faça login na sua Seller Center e autorize o app.</p>
          <p>3. Você volta automaticamente para cá com a loja vinculada.</p>
          <p>4. Após conectar, vamos sincronizar pedidos/ads/carteira (próxima fase).</p>
        </CardContent>
      </Card>
    </div>
  );
}
