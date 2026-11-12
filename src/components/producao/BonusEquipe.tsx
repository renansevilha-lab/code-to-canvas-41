// Produção › Bônus da equipe (12/nov/2026, pedido do dono). Acompanhamento do bônus da areia por pessoa:
// cada lote encerrado paga R$/saco × sacos bons, dividido igualmente entre quem trabalhou nele.
// Toda a conta e o controle de pagamento estão no banco (docs/producao-bonus.sql: producao_bonus,
// producao_bonus_pagar, producao_bonus_desfazer). Por enquanto só o administrador (módulo 'todos') vê.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Botao, Cartao, Entrada, Selo, tabela, td, th } from "./ui";
import { brl, dataBR, hojeSP } from "@/lib/producao";
import { num, rpc } from "@/lib/custos";
import { usePerfil } from "@/hooks/usePerfil";

interface Linha {
  ordem_id: number; codigo: string; dia: string; sku: string; produto: string | null; sacos_lote: number; n_pessoas: number;
  pessoa_id: string; pessoa: string; sacos: number; valor_saco: number; valor: number; pago: boolean; pagamento_id: number | null; pago_em: string | null;
}
interface Pessoa { pessoa_id: string; pessoa: string; lotes: number; sacos: number; total: number; a_pagar: number; pago: number; lotes_a_pagar: number }
interface Pagamento { id: number; pessoa_id: string; pessoa: string; valor: number; pago_em: string; obs: string | null; criado_por: string | null; criado_em: string; lotes: number }
interface Bonus { linhas: Linha[]; pessoas: Pessoa[]; pagamentos: Pagamento[] }

type Periodo = "tudo" | "mes" | "mes_ant" | "30d";
const ROTULO: Record<Periodo, string> = { tudo: "Desde o início", mes: "Este mês", mes_ant: "Mês passado", "30d": "30 dias" };

function intervalo(p: Periodo): { de: string | null; ate: string | null } {
  const hoje = hojeSP();
  if (p === "mes") return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
  if (p === "mes_ant") {
    const d = new Date(`${hoje.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCDate(0); // último dia do mês anterior
    const fim = d.toISOString().slice(0, 10);
    return { de: `${fim.slice(0, 7)}-01`, ate: fim };
  }
  if (p === "30d") { const x = new Date(`${hoje}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 29); return { de: x.toISOString().slice(0, 10), ate: hoje }; }
  return { de: null, ate: null };
}

const CORES = ["#6E56CF", "#E0A030", "#2F9E6E", "#D9534F", "#3B82C4", "#B5568F"];

export function BonusEquipe() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [periodo, setPeriodo] = useState<Periodo>("tudo");
  const [pessoaSel, setPessoaSel] = useState<string | null>(null);
  const [soAPagar, setSoAPagar] = useState(false);
  const [marcados, setMarcados] = useState<Set<number> | null>(null); // null = todos os a pagar da pessoa
  const [pagoEm, setPagoEm] = useState(hojeSP());
  const [obs, setObs] = useState("");
  const [gravando, setGravando] = useState(false);
  const { de, ate } = intervalo(periodo);

  const q = useQuery({
    queryKey: ["producao", "bonus", de, ate],
    queryFn: () => rpc<Bonus>("producao_bonus", { p_de: de, p_ate: ate }),
  });
  const b = q.data;
  const cor = useMemo(() => {
    const m: Record<string, string> = {};
    (b?.pessoas ?? []).slice().sort((x, y) => x.pessoa.localeCompare(y.pessoa)).forEach((p, i) => { m[p.pessoa_id] = CORES[i % CORES.length]; });
    return m;
  }, [b]);

  const tot = useMemo(() => {
    const ps = b?.pessoas ?? [];
    const lotes = new Map<number, number>();
    for (const l of b?.linhas ?? []) lotes.set(l.ordem_id, Number(l.sacos_lote));
    return {
      a_pagar: ps.reduce((s, p) => s + Number(p.a_pagar), 0),
      pago: ps.reduce((s, p) => s + Number(p.pago), 0),
      total: ps.reduce((s, p) => s + Number(p.total), 0),
      sacos: [...lotes.values()].reduce((s, x) => s + x, 0),
      lotes: lotes.size,
    };
  }, [b]);

  // linhas da pessoa escolhida
  const daPessoa = useMemo(() => (b?.linhas ?? []).filter((l) => l.pessoa_id === pessoaSel && (!soAPagar || !l.pago)), [b, pessoaSel, soAPagar]);
  const aPagarPessoa = daPessoa.filter((l) => !l.pago);
  const selecionados = aPagarPessoa.filter((l) => (marcados ? marcados.has(l.ordem_id) : true));
  const totalSel = selecionados.reduce((s, l) => s + Number(l.valor), 0);

  // visão geral: um lote por linha, com a parte de cada pessoa
  const porLote = useMemo(() => {
    const m = new Map<number, { l: Linha; gente: Linha[] }>();
    for (const l of b?.linhas ?? []) {
      if (soAPagar && l.pago) continue;
      const x = m.get(l.ordem_id) ?? { l, gente: [] };
      x.gente.push(l);
      m.set(l.ordem_id, x);
    }
    return [...m.values()];
  }, [b, soAPagar]);

  function escolher(id: string | null) {
    setPessoaSel(id);
    setMarcados(null);
    setObs("");
  }
  function alternar(ordem: number) {
    const base = marcados ?? new Set(aPagarPessoa.map((l) => l.ordem_id));
    const n = new Set(base);
    if (n.has(ordem)) n.delete(ordem); else n.add(ordem);
    setMarcados(n);
  }

  async function pagar() {
    if (!pessoaSel || !selecionados.length) return;
    const nome = b?.pessoas.find((p) => p.pessoa_id === pessoaSel)?.pessoa ?? pessoaSel;
    if (!window.confirm(`Registrar o pagamento de ${brl(Math.round(totalSel * 100) / 100)} para ${nome}?\n\n${selecionados.length} lote(s), pago em ${dataBR(pagoEm)}.\nOs valores ficam congelados neste pagamento.`)) return;
    setGravando(true);
    try {
      await rpc("producao_bonus_pagar", { p_pessoa: pessoaSel, p_ordens: selecionados.map((l) => l.ordem_id), p_pago_em: pagoEm, p_obs: obs || null, p_por: perfil?.nome ?? null });
      toast.success(`Pagamento de ${nome} registrado.`);
      setMarcados(null);
      setObs("");
      await qc.invalidateQueries({ queryKey: ["producao", "bonus"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGravando(false);
    }
  }

  async function desfazer(p: Pagamento) {
    if (!window.confirm(`Desfazer o pagamento de ${brl(Number(p.valor))} para ${p.pessoa} (${dataBR(p.pago_em)})?\nOs ${p.lotes} lote(s) voltam para "a pagar".`)) return;
    try {
      await rpc("producao_bonus_desfazer", { p_pagamento: p.id });
      toast.success("Pagamento desfeito.");
      await qc.invalidateQueries({ queryKey: ["producao", "bonus"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const segmento = (
    <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 9, overflow: "hidden" }}>
      {(Object.keys(ROTULO) as Periodo[]).map((p) => (
        <button key={p} type="button" onClick={() => setPeriodo(p)}
          style={{ border: 0, padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: periodo === p ? "var(--pm-a)" : "var(--pm-s)", color: periodo === p ? "var(--pm-oa)" : "var(--pm-t)" }}>
          {ROTULO[p]}
        </button>
      ))}
    </div>
  );
  const kpi = (rot: string, val: string, sub?: string, corV?: string) => (
    <div style={{ background: "var(--pm-s2)", borderRadius: 10, padding: "8px 12px", minWidth: 140 }}>
      <div style={{ fontSize: 11, color: "var(--pm-t3)", fontWeight: 600 }}>{rot}</div>
      <div style={{ fontSize: 20, fontWeight: 750, fontVariantNumeric: "tabular-nums", color: corV ?? "var(--pm-t)" }}>{val}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>{sub}</div>}
    </div>
  );
  const pessoaAtual = b?.pessoas.find((p) => p.pessoa_id === pessoaSel);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Cartao titulo="Bônus da equipe — areia" direita={segmento}>
        <div style={{ fontSize: 12, color: "var(--pm-t3)", marginBottom: 10 }}>
          Cada lote encerrado paga o valor por saco da ficha (Mão de obra por saco) × sacos bons, dividido igualmente entre quem trabalhou no lote.
          O período é pela data de início do lote. Só você vê esta tela por enquanto.
        </div>
        {q.isLoading && <span style={{ color: "var(--pm-t3)" }}>Carregando…</span>}
        {q.error && <span style={{ color: "var(--pm-r)" }}>Não deu para ler: {(q.error as Error).message}</span>}
        {b && !b.linhas.length && <span style={{ color: "var(--pm-t3)" }}>Nenhum lote encerrado no período.</span>}
        {b && b.linhas.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {kpi("A pagar", brl(tot.a_pagar), "ainda não marcado como pago", tot.a_pagar > 0 ? "var(--pm-am)" : undefined)}
              {kpi("Já pago", brl(tot.pago), undefined, tot.pago > 0 ? "var(--pm-g)" : undefined)}
              {kpi("Bônus do período", brl(tot.total), `${tot.lotes} lotes`)}
              {kpi("Sacos bons", num(tot.sacos, 0), "nos lotes do período")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 8 }}>
              {b.pessoas.map((p) => {
                const ativo = pessoaSel === p.pessoa_id;
                return (
                  <button key={p.pessoa_id} type="button" onClick={() => escolher(ativo ? null : p.pessoa_id)} className="pm-hv"
                    style={{ textAlign: "left", cursor: "pointer", background: ativo ? "var(--pm-as)" : "var(--pm-s)", border: `1px solid ${ativo ? "var(--pm-a)" : "var(--pm-b)"}`,
                      borderTop: `5px solid ${cor[p.pessoa_id]}`, borderRadius: 12, padding: "10px 12px", color: "var(--pm-t)", fontSize: 12.5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 28, height: 28, borderRadius: "50%", background: cor[p.pessoa_id], color: "#fff", fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{p.pessoa[0]}</span>
                      <b style={{ fontSize: 14 }}>{p.pessoa}</b>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, margin: "6px 0 2px", fontVariantNumeric: "tabular-nums", color: Number(p.a_pagar) > 0 ? "var(--pm-am)" : "var(--pm-g)" }}>
                      {brl(Number(p.a_pagar))}
                    </div>
                    <div style={{ color: "var(--pm-t3)" }}>a pagar · {p.lotes_a_pagar} lote(s)</div>
                    <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", color: "var(--pm-t2)" }}>
                      <span>Pago {brl(Number(p.pago))}</span><span>{num(Number(p.sacos), 0)} sacos · {p.lotes} lotes</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Cartao>

      {b && b.linhas.length > 0 && (
        <Cartao
          titulo={pessoaAtual ? `Lotes de ${pessoaAtual.pessoa}` : "Lotes do período"}
          direita={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12.5, cursor: "pointer" }}>
                <input type="checkbox" checked={soAPagar} onChange={(e) => setSoAPagar(e.target.checked)} /> Só o que falta pagar
              </label>
              {pessoaAtual && <Botao tom="fantasma" onClick={() => escolher(null)}>Ver todos</Botao>}
            </div>
          }
        >
          {!pessoaAtual && <div style={{ fontSize: 12, color: "var(--pm-t3)", marginBottom: 8 }}>Clique numa pessoa acima para ver os lotes dela e registrar o pagamento.</div>}
          <div style={{ overflowX: "auto" }}>
            {pessoaAtual ? (
              <table style={tabela}>
                <thead><tr>
                  <th style={th} /><th style={th}>Dia</th><th style={th}>Lote</th><th style={th}>Produto</th>
                  <th style={{ ...th, textAlign: "right" }}>Sacos do lote</th><th style={{ ...th, textAlign: "right" }}>Pessoas</th>
                  <th style={{ ...th, textAlign: "right" }}>Parte (sacos)</th><th style={{ ...th, textAlign: "right" }}>R$/saco</th>
                  <th style={{ ...th, textAlign: "right" }}>Bônus</th><th style={th}>Situação</th>
                </tr></thead>
                <tbody>
                  {daPessoa.map((l) => (
                    <tr key={l.ordem_id}>
                      <td style={td}>{!l.pago && <input type="checkbox" checked={marcados ? marcados.has(l.ordem_id) : true} onChange={() => alternar(l.ordem_id)} />}</td>
                      <td style={td}>{dataBR(l.dia)}</td>
                      <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{l.codigo}</td>
                      <td style={{ ...td, maxWidth: 320 }}><span style={{ fontWeight: 600 }}>{l.sku}</span> <span style={{ color: "var(--pm-t3)" }}>{l.produto}</span></td>
                      <td style={{ ...td, textAlign: "right" }}>{num(Number(l.sacos_lote), 0)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{l.n_pessoas}</td>
                      <td style={{ ...td, textAlign: "right" }}>{num(Number(l.sacos), 2)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{brl(Number(l.valor_saco))}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 650 }}>{brl(Number(l.valor))}</td>
                      <td style={td}>{l.pago ? <Selo tom="g">pago {dataBR(l.pago_em)}</Selo> : <Selo tom="a">a pagar</Selo>}</td>
                    </tr>
                  ))}
                  {!daPessoa.length && <tr><td style={{ ...td, color: "var(--pm-t3)" }} colSpan={10}>Nada no período.</td></tr>}
                </tbody>
              </table>
            ) : (
              <table style={tabela}>
                <thead><tr>
                  <th style={th}>Dia</th><th style={th}>Lote</th><th style={th}>Produto</th>
                  <th style={{ ...th, textAlign: "right" }}>Sacos bons</th><th style={{ ...th, textAlign: "right" }}>R$/saco</th>
                  <th style={{ ...th, textAlign: "right" }}>Bônus do lote</th><th style={th}>Quem trabalhou (parte de cada um)</th>
                </tr></thead>
                <tbody>
                  {porLote.map(({ l, gente }) => (
                    <tr key={l.ordem_id}>
                      <td style={td}>{dataBR(l.dia)}</td>
                      <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{l.codigo}</td>
                      <td style={{ ...td, maxWidth: 300 }}><span style={{ fontWeight: 600 }}>{l.sku}</span> <span style={{ color: "var(--pm-t3)" }}>{l.produto}</span></td>
                      <td style={{ ...td, textAlign: "right" }}>{num(Number(l.sacos_lote), 0)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{brl(Number(l.valor_saco))}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 650 }}>{brl(gente.reduce((s, x) => s + Number(x.valor), 0))}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {gente.map((x) => (
                            <span key={x.pessoa_id} title={x.pago ? `pago em ${dataBR(x.pago_em)}` : "a pagar"}
                              style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 20, border: `1px solid ${cor[x.pessoa_id]}`, background: x.pago ? "var(--pm-gs)" : "var(--pm-s)", whiteSpace: "nowrap" }}>
                              <b style={{ color: cor[x.pessoa_id] }}>{x.pessoa}</b> {brl(Number(x.valor))}{x.pago ? " ✓" : ""}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!porLote.length && <tr><td style={{ ...td, color: "var(--pm-t3)" }} colSpan={7}>Nada no período.</td></tr>}
                </tbody>
              </table>
            )}
          </div>

          {pessoaAtual && aPagarPessoa.length > 0 && (
            <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", borderTop: "1px solid var(--pm-b)", paddingTop: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600 }}>Selecionado</span>
                <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{brl(Math.round(totalSel * 100) / 100)}</span>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{selecionados.length} de {aPagarPessoa.length} lote(s) a pagar</span>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600 }}>
                Pago em
                <Entrada type="date" value={pagoEm} onChange={(e) => setPagoEm(e.target.value)} style={{ width: 150 }} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600, flex: 1, minWidth: 200 }}>
                Observação (opcional)
                <Entrada value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Ex.: PIX, junto com o salário" />
              </label>
              <Botao tom="primario" onClick={pagar} disabled={gravando || !selecionados.length}>
                {gravando ? "Registrando…" : `Marcar como pago`}
              </Botao>
            </div>
          )}
        </Cartao>
      )}

      {b && b.pagamentos.length > 0 && (
        <Cartao titulo="Pagamentos registrados">
          <div style={{ overflowX: "auto" }}>
            <table style={tabela}>
              <thead><tr>
                <th style={th}>Pago em</th><th style={th}>Pessoa</th><th style={{ ...th, textAlign: "right" }}>Valor</th>
                <th style={{ ...th, textAlign: "right" }}>Lotes</th><th style={th}>Observação</th><th style={th}>Registrado por</th><th style={th} />
              </tr></thead>
              <tbody>
                {b.pagamentos.filter((p) => !pessoaSel || p.pessoa_id === pessoaSel).map((p) => (
                  <tr key={p.id}>
                    <td style={td}>{dataBR(p.pago_em)}</td>
                    <td style={td}><b style={{ color: cor[p.pessoa_id] }}>{p.pessoa}</b></td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 650 }}>{brl(Number(p.valor))}</td>
                    <td style={{ ...td, textAlign: "right" }}>{p.lotes}</td>
                    <td style={{ ...td, color: "var(--pm-t2)" }}>{p.obs ?? "—"}</td>
                    <td style={{ ...td, color: "var(--pm-t3)", fontSize: 12 }}>{p.criado_por ?? "—"} · {dataBR(p.criado_em)}</td>
                    <td style={{ ...td, textAlign: "right" }}><Botao tom="fantasma" onClick={() => desfazer(p)}>Desfazer</Botao></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}
    </div>
  );
}
