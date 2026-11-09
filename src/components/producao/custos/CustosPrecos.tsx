// Produção › Custos e Preços (09/nov/2026, briefing do dono). Tela de decisão, não de lançamento.
// Só para quem tem o módulo 'custos' (ou 'todos'); o banco também barra (RLS + tem_modulo nas funções).
// Toda a conta é do banco: custo_cenario_calcular / preco_cenario_matriz / preco_tabela_atacado.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarraAbas } from "@/components/separacao/ui/kit";
import { Botao, Campo, Cartao, Entrada, Escolha, Selo } from "../ui";
import { excluirCenario, inserir, rpc, salvarCenario, useCenarios, useRecalcular, type Cenario } from "@/lib/custos";
import { PainelCusto } from "./PainelCusto";
import { Precificacao } from "./Precificacao";
import { Comparador } from "./Comparador";
import { Publicadas } from "./Publicadas";

type Sub = "custo" | "precos" | "comparar" | "publicadas";
const CHAVE_CENARIO = "producao.custos.cenario";

export function CustosPrecos() {
  const qc = useQueryClient();
  const recalcular = useRecalcular();
  const cenarios = useCenarios();
  const [sub, setSub] = useState<Sub>("custo");
  const [cenarioId, setCenarioId] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem(CHAVE_CENARIO)); return v > 0 ? v : null; } catch { return null; }
  });
  const [ajustes, setAjustes] = useState(false);

  const lista = cenarios.data ?? [];
  const atual = lista.find((c) => c.id === cenarioId) ?? lista.find((c) => c.padrao) ?? lista[0] ?? null;
  useEffect(() => {
    if (atual && atual.id !== cenarioId) setCenarioId(atual.id);
  }, [atual, cenarioId]);
  useEffect(() => { try { if (cenarioId) localStorage.setItem(CHAVE_CENARIO, String(cenarioId)); } catch { /* noop */ } }, [cenarioId]);

  const recarregarCenarios = () => qc.invalidateQueries({ queryKey: ["custos", "cenarios"] });

  async function novo(duplicar: boolean) {
    const nome = window.prompt(duplicar ? `Nome da cópia de "${atual?.nome}":` : "Nome do cenário novo:", duplicar ? `${atual?.nome} (cópia)` : "");
    if (!nome?.trim()) return;
    try {
      let id: number;
      if (duplicar && atual) id = await rpc<number>("custo_cenario_duplicar", { p_cenario: atual.id, p_nome: nome.trim() });
      else {
        await inserir("custo_cenario", { nome: nome.trim() });
        const r = await recarregarCenarios().then(() => qc.getQueryData<Cenario[]>(["custos", "cenarios"]) ?? []);
        id = r.filter((c) => c.nome === nome.trim()).sort((a, b) => b.id - a.id)[0]?.id ?? 0;
      }
      await recarregarCenarios();
      if (id) setCenarioId(id);
      toast.success(`Cenário "${nome.trim()}" criado.`);
    } catch (e) { toast.error("Não deu para criar o cenário", { description: (e as Error).message }); }
  }

  async function renomear() {
    if (!atual) return;
    const nome = window.prompt("Novo nome do cenário:", atual.nome);
    if (!nome?.trim() || nome.trim() === atual.nome) return;
    try { await salvarCenario(atual.id, { nome: nome.trim() }); await recarregarCenarios(); }
    catch (e) { toast.error("Não deu para renomear", { description: (e as Error).message }); }
  }

  async function marcarPadrao() {
    if (!atual || atual.padrao) return;
    try { await salvarCenario(atual.id, { padrao: true }); await recarregarCenarios(); toast.success(`"${atual.nome}" agora é o cenário padrão.`); }
    catch (e) { toast.error("Não deu para marcar como padrão", { description: (e as Error).message }); }
  }

  async function excluir() {
    if (!atual) return;
    if (atual.padrao) return toast.warning("O cenário padrão não pode ser excluído: marque outro como padrão antes.");
    if (!window.confirm(`Excluir o cenário "${atual.nome}"? Os ajustes por produto dele somem (os dados de produção não mudam).`)) return;
    try { await excluirCenario(atual.id); setCenarioId(null); await recarregarCenarios(); toast.success("Cenário excluído."); }
    catch (e) { toast.error("Não deu para excluir", { description: (e as Error).message }); }
  }

  if (cenarios.isLoading) return <Cartao><span style={{ color: "var(--pm-t3)" }}>Carregando os cenários…</span></Cartao>;
  if (cenarios.error) return <Cartao><span style={{ color: "var(--pm-r)" }}>Não deu para ler os cenários: {(cenarios.error as Error).message}</span></Cartao>;
  if (!atual) return <Cartao><span>Nenhum cenário cadastrado.</span> <Botao onClick={() => novo(false)}>Criar cenário</Botao></Cartao>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Cartao>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 240, flex: "0 1 320px" }}>
            <Campo rotulo="Cenário">
              <Escolha value={atual.id} onChange={(e) => setCenarioId(Number(e.target.value))}>
                {lista.map((c) => <option key={c.id} value={c.id}>{c.nome}{c.padrao ? " (padrão)" : ""}</option>)}
              </Escolha>
            </Campo>
          </div>
          {atual.padrao && <Selo tom="g">padrão</Selo>}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Botao onClick={() => novo(true)}>Duplicar</Botao>
            <Botao onClick={() => novo(false)}>Novo</Botao>
            <Botao onClick={renomear}>Renomear</Botao>
            {!atual.padrao && <Botao onClick={marcarPadrao}>Marcar como padrão</Botao>}
            {!atual.padrao && <Botao tom="fantasma" onClick={excluir}>Excluir</Botao>}
            <Botao tom={ajustes ? "primario" : "secundario"} onClick={() => setAjustes((v) => !v)}>Parâmetros do cenário</Botao>
          </div>
        </div>
        {atual.descricao && <div style={{ fontSize: 12, color: "var(--pm-t3)", marginTop: 8 }}>{atual.descricao}</div>}
        {ajustes && <ParametrosCenario c={atual} onSalvo={() => { void recarregarCenarios(); recalcular(); }} />}
      </Cartao>

      <BarraAbas
        ativa={sub}
        abas={[
          { id: "custo", nome: "Custo por produto", onClick: () => setSub("custo") },
          { id: "precos", nome: "Precificação", onClick: () => setSub("precos") },
          { id: "comparar", nome: "Comparar cenários", onClick: () => setSub("comparar") },
          { id: "publicadas", nome: "Tabelas publicadas", onClick: () => setSub("publicadas") },
        ]}
      />
      {sub === "custo" && <PainelCusto cenario={atual} />}
      {sub === "precos" && <Precificacao cenario={atual} />}
      {sub === "comparar" && <Comparador cenarios={lista} atual={atual} />}
      {sub === "publicadas" && <Publicadas cenarios={lista} />}
    </div>
  );
}

function ParametrosCenario({ c, onSalvo }: { c: Cenario; onSalvo: () => void }) {
  const [v, setV] = useState({
    nome: c.nome, descricao: c.descricao ?? "", imposto: String(c.imposto_pct * 100), fator: String(c.fator_encargos),
    horas_mes: String(c.horas_mes_mensalista), horas_dia: String(c.horas_dia_diarista), volume: String(c.volume_mes_un),
  });
  useEffect(() => {
    setV({ nome: c.nome, descricao: c.descricao ?? "", imposto: String(c.imposto_pct * 100), fator: String(c.fator_encargos),
      horas_mes: String(c.horas_mes_mensalista), horas_dia: String(c.horas_dia_diarista), volume: String(c.volume_mes_un) });
  }, [c]);
  const n = (s: string) => Number(s.replace(",", "."));
  async function salvar() {
    const campos = { descricao: v.descricao.trim() || null, imposto_pct: n(v.imposto) / 100, fator_encargos: n(v.fator),
      horas_mes_mensalista: n(v.horas_mes), horas_dia_diarista: n(v.horas_dia), volume_mes_un: n(v.volume) };
    if (Object.values(campos).some((x) => typeof x === "number" && !(x >= 0))) return toast.error("Confira os números.");
    try { await salvarCenario(c.id, campos); onSalvo(); toast.success("Parâmetros salvos."); }
    catch (e) { toast.error("Não deu para salvar", { description: (e as Error).message }); }
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--pm-b)", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
      <Campo rotulo="Imposto (%)" dica="Simples da BMPC (projeto 11,5%). Cada canal pode ter o próprio.">
        <Entrada inputMode="decimal" value={v.imposto} onChange={(e) => setV({ ...v, imposto: e.target.value })} />
      </Campo>
      <Campo rotulo="Encargos sobre salário" dica="1,35 = +35% sobre o salário mensal">
        <Entrada inputMode="decimal" value={v.fator} onChange={(e) => setV({ ...v, fator: e.target.value })} />
      </Campo>
      <Campo rotulo="Horas/mês do mensalista"><Entrada inputMode="decimal" value={v.horas_mes} onChange={(e) => setV({ ...v, horas_mes: e.target.value })} /></Campo>
      <Campo rotulo="Horas/dia do diarista"><Entrada inputMode="decimal" value={v.horas_dia} onChange={(e) => setV({ ...v, horas_dia: e.target.value })} /></Campo>
      <Campo rotulo="Volume por mês (un)" dica="Base do desperdício por mês"><Entrada inputMode="numeric" value={v.volume} onChange={(e) => setV({ ...v, volume: e.target.value })} /></Campo>
      <div style={{ gridColumn: "1 / -1" }}>
        <Campo rotulo="Descrição"><Entrada value={v.descricao} onChange={(e) => setV({ ...v, descricao: e.target.value })} /></Campo>
      </div>
      <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}><Botao tom="primario" onClick={salvar}>Salvar parâmetros</Botao></div>
    </div>
  );
}
