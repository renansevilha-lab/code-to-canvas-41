import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Info, Trash2, ShieldCheck, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { format, parseISO } from "date-fns";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { MODULOS } from "@/hooks/usePerfil";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/usuarios")({
  component: UsuariosPage,
});

type UsuarioRow = {
  user_id: string;
  email: string | null;
  criado_login: string | null;
  ultimo_login: string | null;
  nome: string | null;
  modulos: string[];
  ativo: boolean;
  tem_perfil: boolean;
};

type Edit = { nome: string; modulos: string[]; ativo: boolean };

function UsuariosPage() {
  const [usuarios, setUsuarios] = useState<UsuarioRow[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function carregar() {
    setLoading(true);
    setErro(null);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("admin-usuarios", { body: { modulo: "listar" } });
      if (error) throw new Error(error.message);
      if ((data as { erro?: string })?.erro) throw new Error((data as { erro?: string }).erro);
      const us = ((data as { usuarios?: UsuarioRow[] }).usuarios ?? []) as UsuarioRow[];
      setUsuarios(us);
      const e: Record<string, Edit> = {};
      // `perfis_usuario.nome` é NOT NULL: quem ainda não tem nome entra com o
      // prefixo do e-mail (o admin edita se quiser) em vez de ir vazio/null.
      for (const u of us) {
        e[u.user_id] = {
          nome: u.nome ?? (u.email ? u.email.split("@")[0] : ""),
          modulos: [...u.modulos],
          ativo: u.tem_perfil ? u.ativo : true,
        };
      }
      setEdits(e);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void carregar();
  }, []);

  function patch(uid: string, p: Partial<Edit>) {
    setEdits((prev) => ({ ...prev, [uid]: { ...prev[uid], ...p } }));
  }
  function toggleModulo(uid: string, slug: string) {
    const cur = edits[uid];
    if (!cur) return;
    patch(uid, {
      modulos: cur.modulos.includes(slug) ? cur.modulos.filter((m) => m !== slug) : [...cur.modulos, slug],
    });
  }

  function sujo(u: UsuarioRow): boolean {
    const ed = edits[u.user_id];
    if (!ed) return false;
    if (!u.tem_perfil) return ed.modulos.length > 0; // conceder acesso a quem não tem
    const mesmaLista =
      ed.modulos.length === u.modulos.length && ed.modulos.every((m) => u.modulos.includes(m));
    return !(mesmaLista && ed.ativo === u.ativo && (ed.nome || "") === (u.nome || ""));
  }

  async function salvar(u: UsuarioRow) {
    const ed = edits[u.user_id];
    if (!ed) return;
    setBusyId(u.user_id);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("admin-usuarios", {
        body: { modulo: "salvar", user_id: u.user_id, nome: ed.nome || null, modulos: ed.modulos, ativo: ed.ativo },
      });
      if (error) throw new Error(error.message);
      if ((data as { erro?: string })?.erro) throw new Error((data as { erro?: string }).erro);
      toast.success(`Acesso de ${u.email ?? "usuário"} salvo`);
      await carregar();
    } catch (e) {
      toast.error("Falha ao salvar", { description: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function remover(u: UsuarioRow) {
    if (!window.confirm(`Revogar o acesso de ${u.email ?? "usuário"}? O login continua existindo no Supabase, mas ele perde a permissão de entrar no sistema.`)) return;
    setBusyId(u.user_id);
    try {
      const { data, error } = await supabaseExternal.functions.invoke("admin-usuarios", { body: { modulo: "remover", user_id: u.user_id } });
      if (error) throw new Error(error.message);
      if ((data as { erro?: string })?.erro) throw new Error((data as { erro?: string }).erro);
      toast.success("Acesso revogado");
      await carregar();
    } catch (e) {
      toast.error("Falha ao revogar", { description: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-[18px]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2 text-[13px] text-muted-foreground max-w-2xl">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Para dar acesso a um novo funcionário, crie o login em <strong>Authentication → Users</strong> no painel do
            Supabase. Ele aparece aqui; marque os módulos que ele pode ver e salve. Para só a operação do galpão, marque
            apenas <strong>Galpão</strong>.
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => void carregar()} disabled={loading} className="gap-2">
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Atualizar
        </Button>
      </div>

      {erro && (
        <Card className="p-4 border-destructive/30 bg-destructive/5">
          <p className="text-sm text-destructive font-medium">Erro ao carregar usuários</p>
          <p className="text-xs text-muted-foreground mt-1">{erro}</p>
        </Card>
      )}

      {loading && usuarios.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando usuários…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {usuarios.map((u) => {
            const ed = edits[u.user_id];
            if (!ed) return null;
            const admin = ed.modulos.includes("todos");
            const dirty = sujo(u);
            const busy = busyId === u.user_id;
            const semAcesso = !u.tem_perfil;
            return (
              <Card key={u.user_id} className={cn("p-5 flex flex-col gap-4", semAcesso && "border-dashed")}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14.5px] font-semibold truncate">{u.email ?? "(sem e-mail)"}</span>
                      {semAcesso ? (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Sem acesso</span>
                      ) : u.ativo ? (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Ativo</span>
                      ) : (
                        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">Inativo</span>
                      )}
                      {admin && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                          <ShieldCheck className="h-3 w-3" /> Admin
                        </span>
                      )}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground mt-0.5 tabular-nums">
                      {u.ultimo_login ? `Último acesso ${format(parseISO(u.ultimo_login), "dd/MM/yyyy HH:mm")}` : "Nunca acessou"}
                    </div>
                  </div>
                  <Input
                    value={ed.nome}
                    onChange={(e) => patch(u.user_id, { nome: e.target.value })}
                    placeholder="Nome (opcional)"
                    className="h-9 w-full sm:w-56 bg-card"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Módulos que pode ver</span>
                  <div className="flex flex-wrap gap-2">
                    {MODULOS.map((m) => {
                      const on = ed.modulos.includes(m.slug);
                      const opaco = admin && m.slug !== "todos"; // 'todos' cobre tudo
                      return (
                        <button
                          key={m.slug}
                          onClick={() => toggleModulo(u.user_id, m.slug)}
                          title={m.desc}
                          className={cn(
                            "flex items-center gap-1.5 rounded-[9px] border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                            on
                              ? "bg-primary text-primary-foreground border-transparent"
                              : "bg-card text-secondary-foreground border-border hover:border-[#C9CFD8]",
                            opaco && !on && "opacity-40",
                          )}
                        >
                          {on && <CheckCircle2 className="h-3.5 w-3.5" />}
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                  {admin && (
                    <span className="text-[11px] text-muted-foreground">Administrador vê tudo — os demais módulos ficam implícitos.</span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                  <button
                    onClick={() => patch(u.user_id, { ativo: !ed.ativo })}
                    className="inline-flex items-center gap-2 text-[13px] font-medium"
                    title="Ativar/desativar o acesso"
                  >
                    <span
                      className={cn(
                        "relative h-5 w-9 rounded-full transition-colors",
                        ed.ativo ? "bg-primary" : "bg-muted",
                      )}
                    >
                      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", ed.ativo ? "left-[18px]" : "left-0.5")} />
                    </span>
                    {ed.ativo ? "Acesso ativo" : "Acesso desativado"}
                  </button>
                  <div className="flex items-center gap-2">
                    {u.tem_perfil && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive gap-1.5"
                        onClick={() => void remover(u)}
                        disabled={busy}
                      >
                        <Trash2 className="h-4 w-4" /> Revogar
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void salvar(u)} disabled={busy || !dirty} className="gap-1.5">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {semAcesso ? "Conceder acesso" : "Salvar"}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
          {usuarios.length === 0 && !loading && (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              Nenhum login encontrado. Crie usuários em Authentication → Users no Supabase.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
