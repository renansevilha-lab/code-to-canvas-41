// ============================================================================
// Gastos recorrentes do DRE — despesa mensal fixa que NÃO passa pelo Tiny
// (ex.: assinatura do Claude). Vive em dre_gastos_recorrentes e entra nas
// views do DRE expandida mês a mês, de mes_inicio até min(mes_fim, mês atual).
// Encerrar = preencher "até" (o histórico fica); excluir apaga de TODOS os
// meses, inclusive passados — por isso o excluir pede confirmação e o
// encerrar é o caminho normal.
// ============================================================================
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

const CATEGORIAS = [
  "Administrativas", "Pessoal", "Aluguel", "Embalagem",
  "Frete/Logística", "Financeiras", "Pessoal/Creative (revisar)",
  "Outras / a classificar",
] as const;

interface Gasto {
  id: string;
  descricao: string;
  categoria: string;
  valor: number;
  mes_inicio: string;
  mes_fim: string | null;
  observacao: string | null;
  criado_por: string | null;
}

function mesAtualSP(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7);
}

export function GastosRecorrentes({ onMudou }: { onMudou: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [aberto, setAberto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [descricao, setDescricao] = useState("");
  const [categoria, setCategoria] = useState<string>("Administrativas");
  const [valor, setValor] = useState("");
  const [inicio, setInicio] = useState<string>(mesAtualSP());

  const gastosQ = useQuery({
    queryKey: ["dre", "gastos_recorrentes"],
    enabled: aberto,
    queryFn: async (): Promise<Gasto[]> => {
      const { data, error } = await supabaseExternal
        .from("dre_gastos_recorrentes")
        .select("*")
        .order("mes_fim", { ascending: true, nullsFirst: true })
        .order("descricao");
      if (error) throw error;
      return (data ?? []) as Gasto[];
    },
  });

  const recarregar = () => {
    void qc.invalidateQueries({ queryKey: ["dre", "gastos_recorrentes"] });
    onMudou();
  };

  async function adicionar() {
    const v = Number(valor.replace(",", "."));
    if (!descricao.trim()) { toast.warning("Dê um nome ao gasto (ex.: Claude)."); return; }
    if (!v || v <= 0) { toast.warning("Informe o valor mensal."); return; }
    if (!/^\d{4}-\d{2}$/.test(inicio)) { toast.warning("Informe o mês de início."); return; }
    setSalvando(true);
    try {
      const { error } = await supabaseExternal.from("dre_gastos_recorrentes").insert({
        descricao: descricao.trim(), categoria, valor: v, mes_inicio: inicio,
        criado_por: perfil?.nome ?? null,
      });
      if (error) throw error;
      toast.success(`"${descricao.trim()}" cadastrado — R$ ${v.toFixed(2)}/mês desde ${inicio}`);
      setDescricao(""); setValor("");
      recarregar();
    } catch (e) {
      toast.error("Falha ao cadastrar", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  async function encerrar(g: Gasto) {
    const fim = window.prompt(
      `Encerrar "${g.descricao}" em qual mês? (último mês em que o gasto vale, AAAA-MM)`,
      mesAtualSP(),
    );
    if (fim === null) return;
    if (!/^\d{4}-\d{2}$/.test(fim.trim())) { toast.warning("Formato: AAAA-MM"); return; }
    const { error } = await supabaseExternal.from("dre_gastos_recorrentes")
      .update({ mes_fim: fim.trim(), atualizado_em: new Date().toISOString() })
      .eq("id", g.id);
    if (error) { toast.error("Falha ao encerrar", { description: error.message }); return; }
    toast.success(`"${g.descricao}" encerrado em ${fim.trim()} (histórico preservado)`);
    recarregar();
  }

  async function reativar(g: Gasto) {
    const { error } = await supabaseExternal.from("dre_gastos_recorrentes")
      .update({ mes_fim: null, atualizado_em: new Date().toISOString() })
      .eq("id", g.id);
    if (error) { toast.error("Falha ao reativar", { description: error.message }); return; }
    toast.success(`"${g.descricao}" reativado`);
    recarregar();
  }

  async function excluir(g: Gasto) {
    if (!window.confirm(
      `Excluir "${g.descricao}"?\n\nSome de TODOS os meses do DRE, inclusive os passados. ` +
      `Para parar daqui em diante mantendo o histórico, use Encerrar.`,
    )) return;
    const { error } = await supabaseExternal.from("dre_gastos_recorrentes").delete().eq("id", g.id);
    if (error) { toast.error("Falha ao excluir", { description: error.message }); return; }
    toast.success(`"${g.descricao}" excluído`);
    recarregar();
  }

  const gastos = gastosQ.data ?? [];
  const totalAtivo = gastos.filter((g) => !g.mes_fim || g.mes_fim >= mesAtualSP())
    .reduce((s, g) => s + Number(g.valor), 0);

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <CalendarClock className="h-4 w-4" /> Gastos recorrentes
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Gastos recorrentes</DialogTitle>
          <DialogDescription>
            Despesa mensal fixa que não passa pelo Tiny (assinaturas, softwares…).
            Entra no DRE todo mês, do início até o encerramento.
          </DialogDescription>
        </DialogHeader>

        {/* Cadastro */}
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-3 bg-muted/30">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">Descrição</label>
            <Input className="h-8 w-[180px] text-sm" placeholder="ex.: Claude"
              value={descricao} onChange={(e) => setDescricao(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">Categoria</label>
            <select className="h-8 rounded-md border bg-card px-2 text-sm"
              value={categoria} onChange={(e) => setCategoria(e.target.value)}>
              {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">Valor/mês (R$)</label>
            <Input className="h-8 w-[110px] text-sm" placeholder="0,00" inputMode="decimal"
              value={valor} onChange={(e) => setValor(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground">Desde</label>
            <Input type="month" className="h-8 w-[140px] text-sm"
              value={inicio} onChange={(e) => setInicio(e.target.value)} />
          </div>
          <Button size="sm" className="h-8 gap-1.5" disabled={salvando} onClick={() => void adicionar()}>
            {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Adicionar
          </Button>
        </div>

        {/* Lista */}
        {gastosQ.isLoading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Carregando…</p>
        ) : gastos.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Nenhum gasto recorrente ainda.</p>
        ) : (
          <div className="divide-y max-h-[320px] overflow-y-auto">
            {gastos.map((g) => {
              const encerrado = !!g.mes_fim && g.mes_fim < mesAtualSP();
              return (
                <div key={g.id} className={`flex items-center gap-3 py-2 text-sm ${encerrado ? "opacity-55" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{g.descricao}</span>
                    <span className="text-muted-foreground text-xs"> · {g.categoria}</span>
                    <div className="text-[11px] text-muted-foreground">
                      desde {g.mes_inicio}{g.mes_fim ? ` até ${g.mes_fim}` : " · ativo"}
                      {g.criado_por ? ` · por ${g.criado_por}` : ""}
                    </div>
                  </div>
                  <span className="tabular-nums font-mono shrink-0">
                    R$ {Number(g.valor).toFixed(2)}<span className="text-muted-foreground text-xs">/mês</span>
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    {g.mes_fim ? (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void reativar(g)}>Reativar</Button>
                    ) : (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void encerrar(g)}>Encerrar</Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                      title="Excluir de todos os meses (use Encerrar para manter o histórico)"
                      onClick={() => void excluir(g)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {gastos.length > 0 && (
          <p className="text-[11.5px] text-muted-foreground">
            Total ativo: <span className="font-semibold tabular-nums">R$ {totalAtivo.toFixed(2)}/mês</span>
            {" "}· os valores entram na categoria escolhida e no lucro líquido do DRE.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
