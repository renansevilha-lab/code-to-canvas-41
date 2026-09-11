import { useEffect, useState } from "react";
import { Ban, Loader2, Repeat, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { EXTERNAL_PUBLISHABLE_KEY, EXTERNAL_URL, supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Ações por conta em /contas-pagar (11/set/2026):
//  - "Tornar recorrente": regra em contas_pagar_recorrentes; o cron diário
//    (tiny-contas-pagar?modulo=recorrentes-gerar) cria a conta NO TINY todo mês,
//    N dias antes do vencimento, sem fim (até mes_fim ou desativar). Complementa
//    o "Repetir mensalmente" do diálogo de nova conta (que cria N meses de uma
//    vez). Precisa do contato do Tiny (id) — o espelho só tem o nome.
//  - "Ignorar fornecedor": RPC ignorar_fornecedor_contas_pagar (tabela
//    contas_pagar_ignorar + trigger BEFORE INSERT que descarta no próprio sync).
//    Some da lista e do DRE; no Tiny nada muda. Reativar = reativar_fornecedor_
//    contas_pagar (volta no próximo sync).
// ============================================================================

export interface ContaBase {
  tiny_id?: number | null;
  fornecedor_nome: string | null;
  descricao: string | null;
  valor_total: number;
  data_vencimento: string | null;
  numero_documento: string | null;
}

interface Contato { id: number; nome: string; cpf_cnpj: string | null }

function mesSeguinte(): string {
  const d = new Date();
  d.setDate(1); d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function buscarContatos(q: string): Promise<Contato[]> {
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiny-contas-pagar?modulo=contatos&q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
  });
  const d = (await r.json().catch(() => ({}))) as { contatos?: Contato[]; erro?: string };
  if (!r.ok || d.erro) throw new Error(d.erro ?? `HTTP ${r.status}`);
  return d.contatos ?? [];
}

// ---------------------------------------------------------------------------
export function AcoesConta({ conta, onMudou }: { conta: ContaBase; onMudou: () => void }) {
  const [recAberto, setRecAberto] = useState(false);
  const [ignAberto, setIgnAberto] = useState(false);
  return (
    <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" title="Tornar recorrente (gera todo mês no Tiny)" onClick={() => setRecAberto(true)}>
        <Repeat className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" title="Ignorar este fornecedor (some da lista e do DRE, agora e nos próximos syncs)" onClick={() => setIgnAberto(true)}>
        <Ban className="h-3.5 w-3.5" />
      </Button>
      {recAberto && <RecorrenteDialog conta={conta} onClose={() => setRecAberto(false)} onMudou={onMudou} />}
      {ignAberto && <IgnorarDialog conta={conta} onClose={() => setIgnAberto(false)} onMudou={onMudou} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
function RecorrenteDialog({ conta, onClose, onMudou }: { conta: ContaBase; onClose: () => void; onMudou: () => void }) {
  const { perfil } = usePerfil();
  const [busca, setBusca] = useState(conta.fornecedor_nome ?? "");
  const [contatos, setContatos] = useState<Contato[]>([]);
  const [contato, setContato] = useState<Contato | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [valor, setValor] = useState(String(Number(conta.valor_total ?? 0).toFixed(2)).replace(".", ","));
  const [dia, setDia] = useState(conta.data_vencimento ? Math.min(28, Number(conta.data_vencimento.slice(8, 10))) : 10);
  const [historico, setHistorico] = useState(conta.descricao ?? conta.fornecedor_nome ?? "");
  const [antecedencia, setAntecedencia] = useState(7);
  const [mesInicio, setMesInicio] = useState(mesSeguinte());
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const q = busca.trim();
    if (q.length < 2 || contato) { setContatos([]); return; }
    const t = setTimeout(async () => {
      setBuscando(true);
      try { setContatos(await buscarContatos(q)); }
      catch (e) { toast.error("Falha ao buscar contatos", { description: (e as Error).message }); }
      finally { setBuscando(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [busca, contato]);

  async function salvar() {
    const v = Number(valor.replace(/\./g, "").replace(",", "."));
    if (!contato) { toast.error("Escolha o fornecedor (contato do Tiny)"); return; }
    if (!Number.isFinite(v) || v <= 0) { toast.error("Valor inválido"); return; }
    if (!/^\d{4}-\d{2}$/.test(mesInicio)) { toast.error("Mês inicial no formato AAAA-MM"); return; }
    setSalvando(true);
    try {
      const { error } = await supabaseExternal.from("contas_pagar_recorrentes").insert({
        contato_id: contato.id, fornecedor_nome: contato.nome, valor: v, dia_vencimento: dia,
        historico: historico || null, numero_documento: conta.numero_documento ?? null,
        antecedencia_dias: antecedencia, ativo: true, mes_inicio: mesInicio,
        origem_tiny_id: conta.tiny_id ?? null, criado_por: perfil?.nome ?? null,
      });
      if (error) throw error;
      toast.success(`Recorrência criada — ${contato.nome}`, {
        description: `${formatBRL(v)} todo dia ${dia}, a partir de ${mesInicio.split("-").reverse().join("/")}; a conta é criada no Tiny ${antecedencia} dias antes.`,
        duration: 8000,
      });
      onMudou(); onClose();
    } catch (e) {
      toast.error("Falha ao criar recorrência", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Tornar recorrente</DialogTitle>
          <DialogDescription>Todo mês o app cria esta conta no Tiny, alguns dias antes do vencimento, até você desativar. Se ela já estiver em "Gastos recorrentes" do DRE, encerre lá para não contar duas vezes.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Fornecedor (contato do Tiny)</label>
            {contato ? (
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="truncate"><span className="font-medium">{contato.nome}</span><span className="text-muted-foreground font-mono text-[11px]"> · id {contato.id}</span></span>
                <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => { setContato(null); }}>trocar</button>
              </div>
            ) : (
              <div className="relative">
                <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="nome do fornecedor…" className="h-9" autoFocus />
                {buscando && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                {contatos.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full max-h-52 overflow-auto rounded-md border bg-popover shadow-md">
                    {contatos.map((c) => (
                      <button key={c.id} type="button" onClick={() => { setContato(c); setContatos([]); }} className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex justify-between gap-2">
                        <span className="truncate">{c.nome}</span><span className="text-[11px] text-muted-foreground shrink-0">{c.cpf_cnpj ?? `id ${c.id}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Valor (R$)</label>
              <Input value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" className="h-9 font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Dia do vencimento</label>
              <Input type="number" min={1} max={28} value={dia} onChange={(e) => setDia(Math.max(1, Math.min(28, Number(e.target.value) || 1)))} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Criar N dias antes</label>
              <Input type="number" min={0} max={28} value={antecedencia} onChange={(e) => setAntecedencia(Math.max(0, Math.min(28, Number(e.target.value) || 0)))} className="h-9" />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Histórico</label>
              <Input value={historico} onChange={(e) => setHistorico(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Primeiro mês</label>
              <Input type="month" value={mesInicio} onChange={(e) => setMesInicio(e.target.value)} className="h-9" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={salvando}>Cancelar</Button>
          <Button onClick={() => void salvar()} disabled={salvando || !contato}>{salvando ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}Salvar recorrência</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function IgnorarDialog({ conta, onClose, onMudou }: { conta: ContaBase; onClose: () => void; onMudou: () => void }) {
  const [motivo, setMotivo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const nome = conta.fornecedor_nome ?? "";

  async function salvar() {
    if (!nome) { toast.error("Conta sem fornecedor"); return; }
    setSalvando(true);
    try {
      const { data, error } = await supabaseExternal.rpc("ignorar_fornecedor_contas_pagar", { p_fornecedor: nome, p_motivo: motivo || null });
      if (error) throw error;
      const r = (Array.isArray(data) ? data[0] : data) as { fornecedor?: string; removidas?: number } | undefined;
      toast.success(`Fornecedor ignorado — ${Number(r?.removidas ?? 0)} conta(s) apagada(s) do app`, {
        description: "O Tiny continua com elas; o sync descarta de novo. Reative em Regras.", duration: 8000,
      });
      onMudou(); onClose();
    } catch (e) {
      toast.error("Falha ao ignorar fornecedor", { description: (e as Error).message });
    } finally { setSalvando(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Ignorar fornecedor</DialogTitle>
          <DialogDescription>
            Todas as contas de <span className="font-medium text-foreground">{nome}</span> somem da lista e do DRE, agora e nas próximas importações do Tiny. Nada muda no Tiny.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Motivo (opcional)</label>
          <Input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="ex.: conta pessoal, não é da empresa" className="h-9" autoFocus />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={salvando}>Cancelar</Button>
          <Button variant="destructive" onClick={() => void salvar()} disabled={salvando}>{salvando ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Ban className="h-4 w-4 mr-1.5" />}Ignorar sempre</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
interface Recorrente { id: string; fornecedor_nome: string | null; valor: number; dia_vencimento: number; antecedencia_dias: number; ativo: boolean; mes_inicio: string; ultimo_mes_gerado: string | null; ultimo_erro: string | null }
interface Ignorado { fornecedor_nome: string; motivo: string | null; criado_por: string | null }

export function GestaoRegras({ onMudou }: { onMudou: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [rec, setRec] = useState<Recorrente[]>([]);
  const [ign, setIgn] = useState<Ignorado[]>([]);
  const [carregando, setCarregando] = useState(false);

  async function carregar() {
    setCarregando(true);
    try {
      const [r1, r2] = await Promise.all([
        supabaseExternal.from("contas_pagar_recorrentes").select("*").order("fornecedor_nome"),
        supabaseExternal.from("contas_pagar_ignorar").select("fornecedor_nome, motivo, criado_por").order("fornecedor_nome"),
      ]);
      setRec((r1.data ?? []) as Recorrente[]);
      setIgn((r2.data ?? []) as Ignorado[]);
    } finally { setCarregando(false); }
  }
  useEffect(() => { if (aberto) void carregar(); }, [aberto]);

  async function alternar(r: Recorrente) {
    const { error } = await supabaseExternal.from("contas_pagar_recorrentes").update({ ativo: !r.ativo, atualizado_em: new Date().toISOString() }).eq("id", r.id);
    if (error) toast.error("Falha", { description: error.message }); else void carregar();
  }
  async function removerRec(r: Recorrente) {
    const { error } = await supabaseExternal.from("contas_pagar_recorrentes").delete().eq("id", r.id);
    if (error) toast.error("Falha", { description: error.message }); else { toast.success("Recorrência removida"); void carregar(); }
  }
  async function reativar(i: Ignorado) {
    const { error } = await supabaseExternal.rpc("reativar_fornecedor_contas_pagar", { p_fornecedor: i.fornecedor_nome });
    if (error) toast.error("Falha", { description: error.message });
    else { toast.success("Fornecedor reativado — as contas voltam no próximo sync do Tiny"); void carregar(); onMudou(); }
  }

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5"><Settings2 className="h-4 w-4" /> Regras</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[440px] p-3 space-y-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold mb-1"><Repeat className="h-3.5 w-3.5" /> Recorrentes (criadas no Tiny todo mês)</div>
          {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : rec.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhuma. Use o ícone ↻ na linha de uma conta.</p>
          ) : rec.map((r) => (
            <div key={r.id} className={cn("flex items-center justify-between gap-2 py-1 text-xs border-b last:border-0", !r.ativo && "opacity-60")}>
              <span className="min-w-0">
                <span className="font-medium truncate block">{r.fornecedor_nome ?? "—"}</span>
                <span className="text-muted-foreground">{formatBRL(Number(r.valor))} · dia {r.dia_vencimento} · {r.antecedencia_dias}d antes · desde {r.mes_inicio}{r.ultimo_mes_gerado ? ` · último ${r.ultimo_mes_gerado}` : ""}</span>
                {r.ultimo_erro && <span className="block text-red-600 truncate" title={r.ultimo_erro}>erro: {r.ultimo_erro}</span>}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <Switch checked={r.ativo} onCheckedChange={() => void alternar(r)} />
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => void removerRec(r)} title="Remover"><Trash2 className="h-3 w-3" /></Button>
              </span>
            </div>
          ))}
        </div>
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold mb-1"><Ban className="h-3.5 w-3.5" /> Fornecedores ignorados</div>
          {ign.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum. Use o ícone ⃠ na linha de uma conta (ou "agrupar" no drill do DRE).</p>
          ) : ign.map((i) => (
            <div key={i.fornecedor_nome} className="flex items-center justify-between gap-2 py-1 text-xs border-b last:border-0">
              <span className="min-w-0">
                <span className="font-medium truncate block">{i.fornecedor_nome}</span>
                {i.motivo && <span className="text-muted-foreground">{i.motivo}</span>}
              </span>
              <Button variant="ghost" size="sm" className="h-6 text-[11px] text-muted-foreground shrink-0" onClick={() => void reativar(i)} title="Volta a importar no próximo sync">reativar</Button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
