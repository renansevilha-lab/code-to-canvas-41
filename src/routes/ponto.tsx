import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, KeyRound, Loader2, LogIn, LogOut, UtensilsCrossed, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { cn } from "@/lib/utils";

// ============================================================================
// Ponto (16/set/2026) — quiosque de marcação para a equipe do galpão.
// A pessoa escolhe o nome, digita a SUA senha e bate Chegada / Almoço / Saída.
// Toda a regra (senha em hash, ordem dos eventos, um por dia) mora no banco:
// RPCs `ponto_registrar` e `ponto_definir_senha` (security definer). O front
// só lê `view_ponto_pessoas` (sem hash) e `view_ponto_dia`.
// "Almoço" é um botão só: o 1º clique registra a saída, o 2º a volta.
// ============================================================================

export const Route = createFileRoute("/ponto")({
  component: PontoPage,
});

interface Pessoa { id: string; nome: string; ativo: boolean; tem_senha: boolean }
interface DiaRow {
  pessoa_id: string; nome: string; dia: string;
  chegada: string | null; almoco_saida: string | null; almoco_volta: string | null; saida: string | null;
  horas_decimal: number | null; incompleto: boolean;
}
type Evento = "chegada" | "almoco" | "saida";

const hojeISO = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const hora = (iso: string | null) => (iso ? format(new Date(iso), "HH:mm") : "—");
const horasFmt = (h: number | null) => {
  if (h == null) return "—";
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

function usePessoas() {
  return useQuery({
    queryKey: ["ponto", "pessoas"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("view_ponto_pessoas").select("*");
      if (error) throw error;
      return (data ?? []) as Pessoa[];
    },
  });
}

function useDia(de: string, ate: string) {
  return useQuery({
    queryKey: ["ponto", "dia", de, ate],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("view_ponto_dia").select("*").gte("dia", de).lte("dia", ate).order("dia", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DiaRow[];
    },
    refetchInterval: 60_000,
  });
}

function PontoPage() {
  const qc = useQueryClient();
  const { data: pessoas } = usePessoas();
  const hoje = hojeISO();
  const { data: hojeRows } = useDia(hoje, hoje);

  const [pessoaId, setPessoaId] = useState<string | null>(null);
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState<Evento | null>(null);
  const [senhaDlg, setSenhaDlg] = useState(false);

  const pessoa = pessoas?.find((p) => p.id === pessoaId) ?? null;
  const meuDia = hojeRows?.find((r) => r.pessoa_id === pessoaId) ?? null;

  // próximo passo lógico — só para rotular/desabilitar botões; a regra vale no banco
  const estado = useMemo(() => {
    const chegou = !!meuDia?.chegada, almSai = !!meuDia?.almoco_saida, almVol = !!meuDia?.almoco_volta, saiu = !!meuDia?.saida;
    return {
      chegada: !chegou,
      almoco: chegou && !saiu && !(almSai && almVol),
      almocoRotulo: almSai && !almVol ? "Voltei do almoço" : "Saí para o almoço",
      saida: chegou && !saiu && !(almSai && !almVol),
    };
  }, [meuDia]);

  function invalidar() {
    void qc.invalidateQueries({ queryKey: ["ponto"] });
  }

  async function bater(ev: Evento) {
    if (!pessoa) return;
    if (!pessoa.tem_senha) { setSenhaDlg(true); return; }
    if (!senha) { toast.warning("Digite sua senha"); return; }
    setBusy(ev);
    try {
      const { data, error } = await supabaseExternal.rpc("ponto_registrar", {
        p_pessoa_id: pessoa.id, p_senha: senha, p_evento: ev,
        p_origem: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : null,
      });
      if (error) throw error;
      const r = data as { ok: boolean; erro?: string; evento?: string; hora?: string; sem_senha?: boolean };
      if (!r.ok) {
        if (r.sem_senha) setSenhaDlg(true);
        toast.error(r.erro ?? "Não registrou");
        return;
      }
      const rotulo = r.evento === "chegada" ? "Chegada" : r.evento === "almoco_saida" ? "Saída para o almoço"
        : r.evento === "almoco_volta" ? "Volta do almoço" : "Saída";
      toast.success(`${rotulo} registrada às ${r.hora} — ${pessoa.nome}`, { icon: <CheckCircle2 className="h-4 w-4" /> });
      setSenha("");
      invalidar();
    } catch (e) {
      toast.error("Erro ao registrar", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2"><Clock className="h-5 w-5" /> Ponto</h1>
        <p className="text-sm text-muted-foreground">Escolha seu nome, digite sua senha e registre. O horário é o do servidor (Brasília).</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="p-5 flex flex-col gap-5">
          {/* 1) quem */}
          <div className="flex flex-wrap gap-2">
            {(pessoas ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { setPessoaId(p.id); setSenha(""); }}
                className={cn(
                  "px-5 py-3 rounded-lg border text-base font-medium transition-colors",
                  pessoaId === p.id ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent",
                )}
              >
                {p.nome}
                {!p.tem_senha && <span className="ml-2 text-[10px] uppercase tracking-wide opacity-70">sem senha</span>}
              </button>
            ))}
          </div>

          {pessoa ? (
            <>
              {/* 2) senha */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">Senha de {pessoa.nome}</label>
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    placeholder={pessoa.tem_senha ? "••••" : "defina sua senha primeiro"}
                    disabled={!pessoa.tem_senha}
                    className="w-48 text-lg tracking-widest"
                  />
                </div>
                <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setSenhaDlg(true)}>
                  <KeyRound className="h-4 w-4" /> {pessoa.tem_senha ? "Alterar senha" : "Definir senha"}
                </Button>
              </div>

              {/* 3) bater */}
              <div className="grid gap-3 sm:grid-cols-3">
                <BotaoPonto icon={LogIn} rotulo="Chegada" hora={hora(meuDia?.chegada ?? null)} ativo={estado.chegada}
                  busy={busy === "chegada"} onClick={() => void bater("chegada")} />
                <BotaoPonto icon={UtensilsCrossed} rotulo={estado.almoco ? estado.almocoRotulo : "Almoço"}
                  hora={meuDia?.almoco_saida ? `${hora(meuDia.almoco_saida)} → ${hora(meuDia.almoco_volta)}` : "—"}
                  ativo={estado.almoco} busy={busy === "almoco"} onClick={() => void bater("almoco")} />
                <BotaoPonto icon={LogOut} rotulo="Saída" hora={hora(meuDia?.saida ?? null)} ativo={estado.saida}
                  busy={busy === "saida"} onClick={() => void bater("saida")} />
              </div>
              {meuDia?.saida && (
                <p className="text-sm text-muted-foreground">
                  Hoje: <span className="font-semibold text-foreground">{horasFmt(meuDia.horas_decimal)}</span> trabalhadas.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Selecione seu nome acima.</p>
          )}
        </Card>

        {/* hoje, todo mundo */}
        <Card className="p-4">
          <h2 className="text-sm font-semibold mb-2">Hoje · {format(new Date(), "dd/MM")}</h2>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="text-left font-medium py-1">Nome</th><th className="font-medium">Chegada</th><th className="font-medium">Almoço</th><th className="font-medium">Saída</th><th className="font-medium text-right">Horas</th></tr>
            </thead>
            <tbody>
              {(pessoas ?? []).map((p) => {
                const r = hojeRows?.find((x) => x.pessoa_id === p.id);
                return (
                  <tr key={p.id} className="border-t">
                    <td className="py-1.5">{p.nome}</td>
                    <td className="text-center font-mono">{hora(r?.chegada ?? null)}</td>
                    <td className="text-center font-mono text-xs">{r?.almoco_saida ? `${hora(r.almoco_saida)}–${hora(r.almoco_volta)}` : "—"}</td>
                    <td className="text-center font-mono">{hora(r?.saida ?? null)}</td>
                    <td className="text-right font-mono">{horasFmt(r?.horas_decimal ?? null)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <Relatorio pessoas={pessoas ?? []} />

      {pessoa && (
        <SenhaDialog pessoa={pessoa} aberto={senhaDlg} onClose={() => setSenhaDlg(false)} onSalvo={invalidar} />
      )}
    </div>
  );
}

function BotaoPonto({ icon: Icon, rotulo, hora, ativo, busy, onClick }: {
  icon: typeof LogIn; rotulo: string; hora: string; ativo: boolean; busy: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!ativo || busy}
      onClick={onClick}
      className={cn(
        "rounded-xl border p-5 text-left flex flex-col gap-2 transition-colors",
        ativo ? "hover:bg-accent border-primary/40" : "opacity-60 cursor-not-allowed",
      )}
    >
      <span className="flex items-center gap-2 text-base font-semibold">
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />} {rotulo}
      </span>
      <span className="font-mono text-sm text-muted-foreground">{hora}</span>
    </button>
  );
}

function SenhaDialog({ pessoa, aberto, onClose, onSalvo }: { pessoa: Pessoa; aberto: boolean; onClose: () => void; onSalvo: () => void }) {
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [conf, setConf] = useState("");
  const [busy, setBusy] = useState(false);

  async function salvar() {
    if (nova.length < 4) { toast.warning("A senha precisa ter pelo menos 4 caracteres"); return; }
    if (nova !== conf) { toast.warning("As senhas não conferem"); return; }
    setBusy(true);
    try {
      const { data, error } = await supabaseExternal.rpc("ponto_definir_senha", {
        p_pessoa_id: pessoa.id, p_senha: nova, p_senha_atual: pessoa.tem_senha ? atual : null,
      });
      if (error) throw error;
      const r = data as { ok: boolean; erro?: string };
      if (!r.ok) { toast.error(r.erro ?? "Não salvou"); return; }
      toast.success(`Senha de ${pessoa.nome} ${pessoa.tem_senha ? "alterada" : "definida"}`);
      setAtual(""); setNova(""); setConf("");
      onSalvo();
      onClose();
    } catch (e) {
      toast.error("Erro ao salvar senha", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> {pessoa.tem_senha ? "Alterar" : "Definir"} senha — {pessoa.nome}</DialogTitle>
          <DialogDescription>Só você deve saber esta senha. Ela é guardada de forma protegida (hash) e não pode ser recuperada, só redefinida.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {pessoa.tem_senha && (
            <Input type="password" autoComplete="off" placeholder="Senha atual" value={atual} onChange={(e) => setAtual(e.target.value)} />
          )}
          <Input type="password" autoComplete="new-password" placeholder="Nova senha (mín. 4)" value={nova} onChange={(e) => setNova(e.target.value)} />
          <Input type="password" autoComplete="new-password" placeholder="Repita a nova senha" value={conf} onChange={(e) => setConf(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void salvar(); }} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={() => void salvar()} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- relatório
function Relatorio({ pessoas }: { pessoas: Pessoa[] }) {
  const [mes, setMes] = useState(() => hojeISO().slice(0, 7));
  const de = `${mes}-01`;
  const ate = useMemo(() => {
    const [y, m] = mes.split("-").map(Number);
    return new Date(y, m, 0).toLocaleDateString("sv-SE");
  }, [mes]);
  const { data: rows } = useDia(de, ate);
  const [aberto, setAberto] = useState<string | null>(null);

  const porPessoa = useMemo(() => {
    const m = new Map<string, { dias: DiaRow[]; total: number; incompletos: number }>();
    for (const r of rows ?? []) {
      const e = m.get(r.pessoa_id) ?? { dias: [], total: 0, incompletos: 0 };
      e.dias.push(r);
      e.total += r.horas_decimal ?? 0;
      if (r.incompleto) e.incompletos++;
      m.set(r.pessoa_id, e);
    }
    return m;
  }, [rows]);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold">Relatório do mês</h2>
        <input type="month" value={mes} onChange={(e) => setMes(e.target.value)} className="border rounded-md px-2 py-1 text-sm bg-background" />
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr><th className="text-left font-medium py-1">Nome</th><th className="font-medium">Dias</th><th className="font-medium">Incompletos</th><th className="font-medium text-right">Total de horas</th></tr>
        </thead>
        <tbody>
          {pessoas.map((p) => {
            const e = porPessoa.get(p.id);
            const on = aberto === p.id;
            return (
              <FragmentRow key={p.id} on={on} onToggle={() => setAberto(on ? null : p.id)} nome={p.nome}
                dias={e?.dias.length ?? 0} incompletos={e?.incompletos ?? 0} total={e?.total ?? 0} detalhe={e?.dias ?? []} />
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground mt-2">Horas = saída − chegada − intervalo de almoço. Dia sem saída ou sem volta do almoço conta como incompleto e não soma.</p>
    </Card>
  );
}

function FragmentRow({ on, onToggle, nome, dias, incompletos, total, detalhe }: {
  on: boolean; onToggle: () => void; nome: string; dias: number; incompletos: number; total: number; detalhe: DiaRow[];
}) {
  return (
    <>
      <tr className="border-t cursor-pointer hover:bg-accent/40" onClick={onToggle}>
        <td className="py-1.5">{nome}</td>
        <td className="text-center">{dias}</td>
        <td className={cn("text-center", incompletos > 0 && "text-amber-700 dark:text-amber-400")}>{incompletos}</td>
        <td className="text-right font-mono">{horasFmt(total)}</td>
      </tr>
      {on && detalhe.map((d) => (
        <tr key={d.dia} className="text-xs text-muted-foreground bg-muted/30">
          <td className="py-1 pl-4">{format(new Date(`${d.dia}T12:00:00`), "dd/MM (EEE)")}</td>
          <td className="text-center font-mono" colSpan={2}>
            {hora(d.chegada)} · {d.almoco_saida ? `${hora(d.almoco_saida)}–${hora(d.almoco_volta)}` : "sem almoço"} · {hora(d.saida)}
          </td>
          <td className="text-right font-mono">{d.incompleto ? "incompleto" : horasFmt(d.horas_decimal)}</td>
        </tr>
      ))}
    </>
  );
}
