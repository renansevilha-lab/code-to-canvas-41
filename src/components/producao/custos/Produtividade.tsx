// Produtividade média por hora (lotes com apontamento bom) e quem produziu quanto, no período escolhido.
// Números de producao_relatorio_equipe (banco); o mesmo dado vira o relatório em PDF (imprimir → salvar como PDF).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Botao, Cartao, Selo } from "../ui";
import { hojeSP, int } from "@/lib/producao";
import { num, rpc } from "@/lib/custos";
import { relatorioEquipeHtml, type RelEquipe } from "./relatorioEquipe";

type Periodo = "tudo" | "mes" | "30d" | "7d";
const ROTULO: Record<Periodo, string> = { tudo: "Desde o início", mes: "Este mês", "30d": "30 dias", "7d": "7 dias" };

function intervalo(p: Periodo): { de: string | null; ate: string | null } {
  const hoje = hojeSP();
  const menos = (d: number) => { const x = new Date(`${hoje}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - d); return x.toISOString().slice(0, 10); };
  if (p === "mes") return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
  if (p === "30d") return { de: menos(29), ate: hoje };
  if (p === "7d") return { de: menos(6), ate: hoje };
  return { de: null, ate: null };
}

export function Produtividade() {
  const [periodo, setPeriodo] = useState<Periodo>("tudo");
  const { de, ate } = intervalo(periodo);
  const q = useQuery({
    queryKey: ["custos", "relatorio-equipe", de, ate],
    queryFn: () => rpc<RelEquipe>("producao_relatorio_equipe", { p_de: de, p_ate: ate }),
  });
  const r = q.data;

  function abrirPdf() {
    if (!r) return;
    const w = window.open("", "_blank");
    if (!w) return toast.error("O navegador bloqueou a janela do relatório. Libere pop-ups para este site.");
    w.document.open();
    w.document.write(relatorioEquipeHtml(r).replace("</body>", "<script>setTimeout(function(){window.print()},400)</script></body>"));
    w.document.close();
  }

  const kpi = (rot: string, val: string, sub?: string) => (
    <div style={{ background: "var(--pm-s2)", borderRadius: 10, padding: "8px 12px", minWidth: 130 }}>
      <div style={{ fontSize: 11, color: "var(--pm-t3)", fontWeight: 600 }}>{rot}</div>
      <div style={{ fontSize: 20, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{val}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>{sub}</div>}
    </div>
  );

  return (
    <Cartao
      titulo="Produtividade da produção"
      direita={
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 9, overflow: "hidden" }}>
            {(Object.keys(ROTULO) as Periodo[]).map((p) => (
              <button key={p} type="button" onClick={() => setPeriodo(p)}
                style={{ border: 0, padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: periodo === p ? "var(--pm-a)" : "var(--pm-s)", color: periodo === p ? "var(--pm-oa)" : "var(--pm-t)" }}>
                {ROTULO[p]}
              </button>
            ))}
          </div>
          <Botao tom="primario" onClick={abrirPdf} disabled={!r || !r.lotes.length}>Relatório da equipe (PDF)</Botao>
        </div>
      }
    >
      {q.isLoading && <span style={{ color: "var(--pm-t3)" }}>Carregando…</span>}
      {q.error && <span style={{ color: "var(--pm-r)" }}>Não deu para ler: {(q.error as Error).message}</span>}
      {r && !r.lotes.length && <span style={{ color: "var(--pm-t3)" }}>Nenhum lote encerrado no período.</span>}
      {r && r.lotes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {kpi("Sacos por hora", num(r.resumo.un_h_linha, 1), "ritmo da linha")}
            {kpi("Por pessoa/hora", num(r.resumo.un_homem_hora, 1), "sacos")}
            {kpi("Sacos produzidos", int(r.resumo.sacos), `${r.resumo.lotes} lotes`)}
            {kpi("Horas de linha", num(r.resumo.horas_linha_limpas, 1), "lotes bons")}
            {r.equipe.map((e) => kpi(`Equipe de ${e.pessoas}`, num(e.un_homem_hora, 1), `por pessoa/hora · linha ${num(e.un_h_linha, 1)}/h`))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
            {r.pessoas.map((p) => (
              <div key={p.pessoa_id} style={{ border: "1px solid var(--pm-b)", borderRadius: 10, padding: "8px 10px", fontSize: 12.5 }}>
                <b>{p.nome}</b>
                <div><b style={{ fontSize: 16 }}>{int(p.parcela)}</b> sacos <span style={{ color: "var(--pm-t3)" }}>em {p.lotes} lotes</span></div>
                <div style={{ color: "var(--pm-t2)" }}>{num(p.un_hora, 1)} sacos/hora · {num(p.horas_limpas, 1)} h medidas</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Selo tom={r.resumo.lotes_limpos < r.resumo.lotes ? "a" : "g"}>{r.resumo.lotes_limpos} de {r.resumo.lotes} lotes com apontamento bom</Selo>
            Sacos por hora conta só os lotes bons (misturas incluídas: elas puxam a média para baixo — veja por produto em cada cartão).
            A parte de cada pessoa divide os sacos do lote pelas horas de quem estava.
          </div>
        </div>
      )}
    </Cartao>
  );
}
