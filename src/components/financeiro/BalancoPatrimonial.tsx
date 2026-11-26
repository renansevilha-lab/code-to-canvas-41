import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";

import { L, idade } from "@/components/dashboard/formato";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { ContasAgrupadas, EstoqueDetalhe, type ContaAberta } from "./PainelFinanceiro";

// ============================================================================
// Balanço patrimonial GERENCIAL (26/nov/2026; ACZ + SVL juntas; desenho aprovado pelo dono).
// financeiro_balanco(p_mes) devolve as linhas prontas: as do sistema (carteiras, Mercado Pago,
// a receber, estoque, matéria-prima, fornecedores, contas de 30 dias) e as digitadas (bancos,
// imobilizado, empréstimos, cartão, capital), gravadas por fin_saldo_gravar e válidas até
// serem atualizadas. Mês fechado = foto guardada no dia 1. docs/financeiro-balanco.sql.
// ============================================================================

interface LinhaB {
  grupo: string; chave: string; nome: string; valor: number | null; origem: "sistema" | "manual" | "estimativa";
  ordem: number; dica?: string | null; falta?: boolean; de_mes?: string | null; por?: string | null; em?: string | null;
}
interface Balanco {
  mes: string; ao_vivo?: boolean; sem_fechamento?: boolean; fechado_em?: string | null; lido_em?: string | null;
  linhas: LinhaB[];
  totais: { ativo_circulante: number; ativo_nao_circulante: number; ativo: number; passivo_circulante: number; passivo_nao_circulante: number; passivo: number; patrimonio: number; capital_social: number; resultado_acumulado: number };
  indicadores: { liquidez_corrente: number | null; liquidez_seca: number | null; endividamento_pct: number | null; capital_giro_liquido: number; estoque_pct_ativo: number | null };
  pendentes: number; meses_fechados: string[];
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const nomeMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const R2 = (v: number) => `${v < 0 ? "−" : ""}R$ ${Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const paraNumero = (s: string): number | null => {
  const t = s.trim().replace(/[R$\s]/g, "");
  if (!t) return null;
  const v = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
  return Number.isFinite(v) ? v : NaN;
};
const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: "14px 16px", minWidth: 0 };
const rot: CSSProperties = { fontSize: 11, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--pm-t3)", fontWeight: 600 };
const sub: CSSProperties = { fontSize: 12, color: "var(--pm-t3)" };
const GRUPO: Record<string, string> = {
  ativo_circulante: "Ativo circulante", ativo_nao_circulante: "Ativo não circulante",
  passivo_circulante: "Passivo circulante", passivo_nao_circulante: "Passivo não circulante", patrimonio: "Patrimônio dos sócios",
};
const DETALHE = new Set(["estoque", "fornecedores", "outras_contas"]);
const ehMerc = (x: ContaAberta) => (x.categoria ?? "").toLowerCase().startsWith("mercadoria");
const naoMerc30 = (x: ContaAberta) => !ehMerc(x) && ["atrasado", "hoje", "ate_7d", "ate_15d", "ate_30d"].includes(x.faixa);

function Etiqueta({ tipo, children }: { tipo: "s" | "m" | "e"; children: ReactNode }) {
  const c = tipo === "s" ? ["var(--pm-as)", "var(--pm-at)"] : tipo === "e" ? ["var(--pm-ams)", "var(--pm-am)"] : ["var(--pm-s2)", "var(--pm-t3)"];
  return <span style={{ fontSize: 10.5, fontWeight: 600, borderRadius: 999, padding: "0 7px", marginLeft: 6, whiteSpace: "nowrap", background: c[0], color: c[1] }}>{children}</span>;
}

/** Campo de um saldo digitado: grava ao sair do campo ou no Enter; vazio apaga o saldo do mês. */
function CampoSaldo({ linha, mes, onSalvo }: { linha: LinhaB; mes: string; onSalvo: () => void }) {
  const doMes = linha.de_mes === mes && linha.origem === "manual";
  const inicial = linha.origem === "manual" && linha.valor != null ? linha.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "";
  const [txt, setTxt] = useState(inicial);
  const [estado, setEstado] = useState<"" | "salvando" | "salvo" | "erro">("");
  const [erro, setErro] = useState("");
  useEffect(() => { setTxt(inicial); }, [inicial]);
  const salvar = async () => {
    if (txt === inicial) return;
    const v = paraNumero(txt);
    if (Number.isNaN(v)) { setEstado("erro"); setErro("Digite só o número, por exemplo 12.345,67"); return; }
    setEstado("salvando");
    const { error } = await supabaseExternal.rpc("fin_saldo_gravar" as never, { p_chave: linha.chave, p_mes: mes, p_valor: v, p_obs: null } as never);
    if (error) { setEstado("erro"); setErro(error.message); return; }
    setEstado("salvo"); onSalvo();
  };
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
      <input id={`saldo-${linha.chave}`} aria-label={linha.nome} inputMode="decimal" value={txt}
        placeholder={linha.origem === "estimativa" && linha.valor != null ? linha.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) : "digitar"}
        onChange={(e) => { setTxt(e.target.value); setEstado(""); }} onBlur={salvar}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="pm-mono"
        style={{ width: 130, textAlign: "right", padding: "4px 8px", borderRadius: 8, border: `1px solid ${estado === "erro" ? "var(--pm-r)" : "var(--pm-bc)"}`, background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 13 }} />
      <span style={{ fontSize: 10.5, color: estado === "erro" ? "var(--pm-r)" : "var(--pm-t3)" }}>
        {estado === "salvando" ? "salvando…" : estado === "salvo" ? "salvo" : estado === "erro" ? erro
          : linha.origem === "manual" && linha.valor != null && !doMes && linha.de_mes ? `saldo de ${nomeMes(linha.de_mes)}` : ""}
      </span>
    </span>
  );
}

function NovaConta({ onCriada }: { onCriada: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [grupo, setGrupo] = useState("ativo_circulante");
  const [erro, setErro] = useState("");
  const criar = async () => {
    if (nome.trim().length < 2) { setErro("Dê um nome à conta."); return; }
    const chave = "x_" + nome.trim().toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    const { error } = await supabaseExternal.rpc("fin_balanco_conta_salvar" as never, { p_chave: chave, p_grupo: grupo, p_nome: nome.trim(), p_ordem: 90, p_ativo: true } as never);
    if (error) { setErro(error.message); return; }
    setNome(""); setErro(""); setAberto(false); onCriada();
  };
  const campo: CSSProperties = { height: 30, borderRadius: 8, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", padding: "0 10px", fontSize: 13 };
  if (!aberto) return <button type="button" onClick={() => setAberto(true)} style={{ border: 0, background: "transparent", color: "var(--pm-at)", fontSize: 12.5, fontWeight: 500, cursor: "pointer", padding: 0, textAlign: "left" }}>+ Adicionar conta (outro banco, bem ou dívida)</button>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <input id="nova-conta-nome" aria-label="Nome da conta" placeholder="Nome (ex.: Banco XP)" value={nome} onChange={(e) => setNome(e.target.value)} style={{ ...campo, minWidth: 200 }} />
      <select id="nova-conta-grupo" aria-label="Onde entra" value={grupo} onChange={(e) => setGrupo(e.target.value)} style={campo}>
        {Object.entries(GRUPO).filter(([k]) => k !== "patrimonio").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <button type="button" onClick={criar} style={{ ...campo, background: "var(--pm-a)", color: "var(--pm-oa)", border: 0, fontWeight: 600, cursor: "pointer" }}>Criar</button>
      <button type="button" onClick={() => setAberto(false)} style={{ ...campo, cursor: "pointer" }}>Cancelar</button>
      {erro && <span style={{ fontSize: 12, color: "var(--pm-r)" }}>{erro}</span>}
    </div>
  );
}

export function BalancoPatrimonial() {
  const qc = useQueryClient();
  const [mes, setMes] = useState<string | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["financeiro", "balanco", mes],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("financeiro_balanco" as never, { p_mes: mes } as never);
      if (error) throw error;
      return data as unknown as Balanco;
    },
    placeholderData: undefined,
  });
  const recarregar = () => qc.invalidateQueries({ queryKey: ["financeiro", "balanco"] });

  if (q.isLoading) return <div style={{ ...cartao, ...sub }}>Montando o balanço…</div>;
  if (q.error || !q.data) return <div style={{ ...cartao, color: "var(--pm-r)" }}>Não consegui montar o balanço: {(q.error as Error)?.message ?? "sem resposta"}</div>;
  const b = q.data;
  if (b.sem_fechamento) return (
    <div style={cartao}>Não há fechamento guardado para {nomeMes(b.mes)}. <button type="button" onClick={() => setMes(null)} style={{ cursor: "pointer" }}>Voltar para agora</button></div>
  );
  const t = b.totais, i = b.indicadores;
  const doGrupo = (g: string) => b.linhas.filter((l) => l.grupo === g);

  const linha = (l: LinhaB) => {
    const expande = l.origem === "sistema" && DETALHE.has(l.chave) && !!b.ao_vivo;
    return (
      <div key={l.chave}>
        <div className="pm-linha-hv" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", padding: "6px 8px", borderRadius: 8, fontSize: 13, background: aberto === l.chave ? "var(--pm-s2)" : undefined }}>
          <span style={{ minWidth: 0, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 2 }}>
            {expande
              ? <button type="button" onClick={() => setAberto(aberto === l.chave ? null : l.chave)} style={{ display: "inline-flex", alignItems: "center", gap: 4, border: 0, background: "transparent", color: "var(--pm-t)", cursor: "pointer", padding: 0, fontSize: 13, textAlign: "left" }}>
                  {aberto === l.chave ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{l.nome}</button>
              : <span title={l.dica ?? undefined}>{l.nome}</span>}
            <Etiqueta tipo={l.origem === "sistema" ? "s" : l.origem === "estimativa" ? "e" : "m"}>{l.origem === "sistema" ? "sistema" : l.origem === "estimativa" ? "estimativa do DRE" : "você digita"}</Etiqueta>
          </span>
          {l.origem === "sistema"
            ? <b className="pm-mono" style={{ fontWeight: 600 }}>{R2(l.valor ?? 0)}</b>
            : <CampoSaldo linha={l} mes={b.mes} onSalvo={recarregar} />}
        </div>
        {aberto === l.chave && expande && (
          <div style={{ margin: "4px 0 10px 14px", paddingLeft: 10, borderLeft: "2px solid var(--pm-a)" }}>
            {l.chave === "estoque" ? <EstoqueDetalhe />
              : l.chave === "fornecedores" ? <ContasAgrupadas filtro={ehMerc} />
              : <ContasAgrupadas filtro={naoMerc30} />}
          </div>
        )}
      </div>
    );
  };
  const bloco = (g: string, total: number) => (
    <div style={{ marginTop: 14 }}>
      <div style={{ ...rot, padding: "0 8px 2px" }}>{GRUPO[g]}</div>
      {doGrupo(g).map(linha)}
      <div style={{ display: "flex", justifyContent: "space-between", padding: 8, borderTop: "1px solid var(--pm-b)", fontWeight: 700, fontSize: 13 }}><span>Total</span><span className="pm-mono">{R2(total)}</span></div>
    </div>
  );
  const totalGrande = (nome: string, v: number) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 8px 0", borderTop: "2px solid var(--pm-t)", fontWeight: 700, fontSize: 16, marginTop: 6 }}><span>{nome}</span><span className="pm-mono">{R2(v)}</span></div>
  );
  const num2 = (v: number | null) => (v == null ? "—" : v.toFixed(2).replace(".", ","));
  const ind: Array<[string, string, string]> = [
    ["Patrimônio dos sócios", L(t.patrimonio), "ativo − passivo"],
    ["Liquidez corrente", num2(i.liquidez_corrente), "ativo circulante ÷ passivo circulante"],
    ["Liquidez seca", num2(i.liquidez_seca), "sem contar o estoque"],
    ["Endividamento", i.endividamento_pct != null ? `${String(i.endividamento_pct).replace(".", ",")}%` : "—", "quanto do ativo é de terceiros"],
    ["Estoque no ativo", i.estoque_pct_ativo != null ? `${String(i.estoque_pct_ativo).replace(".", ",")}%` : "—", "dinheiro que está em mercadoria"],
  ];
  const chip = (id: string | null, nome: string) => (
    <button key={id ?? "agora"} type="button" onClick={() => { setMes(id); setAberto(null); }}
      style={{ height: 28, padding: "0 12px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${mes === id ? "var(--pm-a)" : "var(--pm-bc)"}`, background: mes === id ? "var(--pm-a)" : "var(--pm-s)", color: mes === id ? "var(--pm-oa)" : "var(--pm-t2)" }}>{nome}</button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {chip(null, "Agora")}
        {b.meses_fechados.map((m) => chip(m, nomeMes(m)))}
        <span style={sub}>
          {b.ao_vivo ? `${nomeMes(b.mes)} · ao vivo${b.lido_em ? ` · lido ${idade(b.lido_em).txt}` : ""}` : `${nomeMes(b.mes)} · fechado${b.fechado_em ? ` em ${new Date(b.fechado_em).toLocaleDateString("pt-BR")}` : ""}`}
          {" · "}ACZ + SVL juntas · balanço gerencial, não substitui o do contador
        </span>
      </div>
      {b.pendentes > 0 && (
        <div style={{ background: "var(--pm-ams)", border: "1px solid var(--pm-am)", borderRadius: 10, padding: "8px 12px", fontSize: 13 }}>
          <b>Faltam {b.pendentes} saldos que só você tem</b> (bancos, imobilizado, empréstimos, cartão, capital). Sem eles o balanço mostra só a parte que o sistema enxerga. Digite o valor na linha e saia do campo para gravar; o que não existir pode ficar 0.
        </div>
      )}

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
        {ind.map(([nome, valor, nota]) => (
          <div key={nome} style={cartao}><div style={rot}>{nome}</div><div style={{ fontSize: 23, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 4 }}>{valor}</div><div style={sub}>{nota}</div></div>
        ))}
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 12, alignItems: "start" }}>
        <div style={cartao}>
          <b style={{ fontSize: 15 }}>Ativo</b><div style={sub}>O que a empresa tem</div>
          {bloco("ativo_circulante", t.ativo_circulante)}
          {bloco("ativo_nao_circulante", t.ativo_nao_circulante)}
          {totalGrande("Total do ativo", t.ativo)}
        </div>
        <div style={cartao}>
          <b style={{ fontSize: 15 }}>Passivo e patrimônio</b><div style={sub}>O que a empresa deve, e o que sobra para os sócios</div>
          {bloco("passivo_circulante", t.passivo_circulante)}
          {bloco("passivo_nao_circulante", t.passivo_nao_circulante)}
          <div style={{ marginTop: 14 }}>
            <div style={{ ...rot, padding: "0 8px 2px" }}>{GRUPO.patrimonio}</div>
            {doGrupo("patrimonio").map(linha)}
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, padding: "6px 8px", fontSize: 13 }}>
              <span>Resultado acumulado<Etiqueta tipo="s">por diferença</Etiqueta></span>
              <b className="pm-mono" style={{ fontWeight: 600, color: t.resultado_acumulado < 0 ? "var(--pm-r)" : "var(--pm-g)" }}>{R2(t.resultado_acumulado)}</b>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: 8, borderTop: "1px solid var(--pm-b)", fontWeight: 700, fontSize: 13 }}><span>Total</span><span className="pm-mono">{R2(t.patrimonio)}</span></div>
          </div>
          {totalGrande("Passivo + patrimônio", t.passivo + t.patrimonio)}
        </div>
      </section>

      <div style={{ ...cartao, display: "flex", flexDirection: "column", gap: 8 }}>
        <NovaConta onCriada={recarregar} />
        <div style={sub}>
          Fornecedor de mercadoria entra inteiro; das demais contas, só o que venceu ou vence em 30 dias (salário e aluguel de meses à frente ainda não são dívida).
          Impostos a pagar usam a estimativa do DRE do mês até você digitar o valor real. Um saldo digitado vale até ser atualizado.
          {b.ao_vivo ? " Os valores do sistema são fotografados no dia 1 de cada mês e o mês fechado fica guardado aqui." : " Os valores do sistema deste mês são a foto do fechamento; os saldos digitados podem ser corrigidos."}
        </div>
      </div>
    </div>
  );
}
