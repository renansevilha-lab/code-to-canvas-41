import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useAuth } from "@/hooks/useAuth";

export type Perfil = {
  nome: string | null;
  modulos: string[];
  ativo: boolean;
};

type PerfilCtx = {
  perfil: Perfil | null;
  loading: boolean;
  temAcesso: (slug: string) => boolean;
};

const Ctx = createContext<PerfilCtx>({
  perfil: null,
  loading: true,
  temAcesso: () => false,
});

export function PerfilProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [perfil, setPerfil] = useState<Perfil | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    if (!user) {
      setPerfil(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      const { data } = await supabaseExternal
        .from("perfis_usuario")
        .select("nome, modulos, ativo")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancel) return;
      setPerfil(
        data
          ? {
              nome: (data as any).nome ?? null,
              modulos: ((data as any).modulos ?? []) as string[],
              ativo: !!(data as any).ativo,
            }
          : null,
      );
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [user]);

  const temAcesso = (slug: string) => {
    if (!perfil || !perfil.ativo) return false;
    if (perfil.modulos.includes("todos")) return true;
    return perfil.modulos.includes(slug);
  };

  return <Ctx.Provider value={{ perfil, loading, temAcesso }}>{children}</Ctx.Provider>;
}

export function usePerfil() {
  return useContext(Ctx);
}

// Módulos de acesso (perfis_usuario.modulos). Fonte única — usada também na
// tela de administração de acessos.
export const MODULOS: Array<{ slug: string; label: string; desc: string }> = [
  { slug: "dashboard", label: "Visão & indicadores", desc: "Dashboard, Metas, Tendências, Anomalias" },
  { slug: "galpao", label: "Galpão", desc: "Separação e Fulfillment (operação do galpão)" },
  { slug: "separacao", label: "Pedidos", desc: "Pedidos e Pedidos Integrados (com margem/custo)" },
  { slug: "produtos", label: "Produtos", desc: "Catálogo, Produtos, Mapeamento SKUs, Amazon" },
  { slug: "ads", label: "Mídia & Canais", desc: "ADS Shopee, ADS Mercado Livre, Promoções" },
  { slug: "financeiro", label: "Financeiro", desc: "DRE, Fluxo de Caixa, Contas a Pagar, Carteira, Devoluções" },
  { slug: "todos", label: "Administrador", desc: "Acesso total + gestão de usuários" },
];

// Mapa rota -> módulo. Prefix match (mais longo vence).
const ROTA_MODULO: Array<[string, string]> = [
  ["/metas", "dashboard"],
  ["/anomalias", "dashboard"],
  ["/tendencias", "dashboard"],
  ["/vendas", "dashboard"],
  ["/pedidos-integrados", "separacao"],
  ["/pedidos", "separacao"],
  ["/separacao", "galpao"],
  ["/monitoramento", "galpao"],
  ["/fulfillment", "galpao"],
  ["/usuarios", "todos"],
  ["/contas-pagar", "financeiro"],
  ["/fluxo-caixa", "financeiro"],
  ["/carteira-saldos", "financeiro"],
  ["/carteira", "financeiro"],
  ["/devolucoes", "financeiro"],
  ["/reprocessar-cmv", "financeiro"],
  ["/dre", "financeiro"],
  ["/produtos-margem", "produtos"],
  ["/mapeamento-skus", "produtos"],
  ["/amazon", "produtos"],
  ["/produtos", "produtos"],
  ["/ads-shopee", "ads"],
  ["/ads-ml", "ads"],
  ["/saude-ml", "ads"],
  ["/promocoes", "ads"],
  ["/", "dashboard"],
];

export function moduloDaRota(pathname: string): string {
  const match = ROTA_MODULO.find(([p]) => (p === "/" ? pathname === "/" : pathname.startsWith(p)));
  return match ? match[1] : "dashboard";
}

export function primeiraRotaPermitida(modulos: string[]): string {
  const preferencia: Array<[string, string]> = [
    ["dashboard", "/"],
    ["galpao", "/separacao"],
    ["separacao", "/pedidos-integrados"],
    ["financeiro", "/dre"],
    ["produtos", "/produtos-margem"],
    ["ads", "/ads-shopee"],
  ];
  if (modulos.includes("todos")) return "/";
  for (const [slug, rota] of preferencia) {
    if (modulos.includes(slug)) return rota;
  }
  return "/";
}
