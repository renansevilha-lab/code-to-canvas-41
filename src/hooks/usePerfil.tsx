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

// Mapa rota -> módulo. Prefix match (mais longo vence).
const ROTA_MODULO: Array<[string, string]> = [
  ["/metas", "dashboard"],
  ["/anomalias", "dashboard"],
  ["/tendencias", "dashboard"],
  ["/pedidos-integrados", "separacao"],
  ["/pedidos", "separacao"],
  ["/separacao", "separacao"],
  ["/fulfillment", "separacao"],
  ["/contas-pagar", "financeiro"],
  ["/fluxo-caixa", "financeiro"],
  ["/carteira-saldos", "financeiro"],
  ["/carteira", "financeiro"],
  ["/dre", "financeiro"],
  ["/produtos-margem", "produtos"],
  ["/mapeamento-skus", "produtos"],
  ["/amazon", "produtos"],
  ["/produtos", "produtos"],
  ["/ads-shopee", "ads"],
  ["/", "dashboard"],
];

export function moduloDaRota(pathname: string): string {
  const match = ROTA_MODULO.find(([p]) => (p === "/" ? pathname === "/" : pathname.startsWith(p)));
  return match ? match[1] : "dashboard";
}

export function primeiraRotaPermitida(modulos: string[]): string {
  const preferencia: Array<[string, string]> = [
    ["dashboard", "/"],
    ["separacao", "/separacao"],
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
