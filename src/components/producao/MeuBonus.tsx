// Produção › Bônus da equipe — visão de CADA PESSOA (13/nov/2026, pedido do dono).
// No galpão o login é compartilhado, então a tela pergunta quem é e pede a senha da pessoa.
// A senha é a MESMA do Ponto (ponto_pessoas): quem ainda não tem escolhe uma no 1º acesso.
// Cada um só enxerga o próprio bônus: a conta e a conferência da senha estão no banco
// (docs/producao-bonus-pessoal.sql: producao_bonus_quem, producao_bonus_minhas).
// A senha fica só na memória desta tela; sair, trocar de aba ou 5 min parado = pede de novo.
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Botao, Cartao, Entrada, Selo, tabela, td, th } from "./ui";
import { brl, dataBR, hojeSP } from "@/lib/producao";
import { num, rpc } from "@/lib/custos";

interface Quem { pessoa_id: string; pessoa: string; tem_senha: boolean; tem_ponto: boolean }
interface Linha {
  ordem_id: number; codigo: string; dia: string; sku: string; produto: string | null; sacos_lote: number; n_pessoas: number;
  sacos: number; valor_saco: number; valor: number; pago: boolean; pago_em: string | null;
}
interface Resumo { lotes: number; sacos: number; total: number; a_pagar: number; pago: number; lotes_a_pagar: number }
interface Pagamento { id: number; valor: number; pago_em: string; obs: string | null; lotes: number }
interface Minhas { ok: boolean; erro?: string; precisa_senha?: boolean; pessoa?: string; linhas?: Linha[]; resumo?: Resumo; pagamentos?: Pagamento[] }

type Periodo = "tudo" | "mes" | "30d";
const ROTULO: Record<Periodo, string> = { tudo: "Desde o início", mes: "Este mês", "30d": "30 dias" };
function intervalo(p: Periodo): { de: string | null; ate: string | null } {
  const hoje = hojeSP();
  if (p === "mes") return { de: `${hoje.slice(0, 7)}-01`, ate: hoje };
  if (p === "30d") { const x = new Date(`${hoje}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 29); return { de: x.toISOString().slice(0, 10), ate: hoje }; }
  return { de: null, ate: null };
}
const PARADO_MS = 5 * 60 * 1000;

export function MeuBonus() {
  const [pessoa, setPessoa] = useState<Quem | null>(null);
  const [senha, setSenha] = useState("");
  const [senha2, setSenha2] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [dados, setDados] = useState<Minhas | null>(null);
  const [periodo, setPeriodo] = useState<Periodo>("tudo");
  const senhaOk = useRef<string | null>(null); // só em memória
  const ultimoUso = useRef(Date.now());

  const quemQ = useQuery({ queryKey: ["producao", "bonus-quem"], queryFn: () => rpc<Quem[]>("producao_bonus_quem", {}), staleTime: 0 });

  const sair = useCallback(() => {
    senhaOk.current = null;
    setDados(null); setPessoa(null); setSenha(""); setSenha2(""); setErro(null); setPeriodo("tudo");
  }, []);

  // 5 minutos sem mexer = trava de novo (computador da bancada é de todos)
  useEffect(() => {
    if (!dados) return;
    const marcar = () => { ultimoUso.current = Date.now(); };
    window.addEventListener("pointerdown", marcar);
    window.addEventListener("keydown", marcar);
    const t = window.setInterval(() => { if (Date.now() - ultimoUso.current > PARADO_MS) sair(); }, 15_000);
    return () => { window.removeEventListener("pointerdown", marcar); window.removeEventListener("keydown", marcar); window.clearInterval(t); };
  }, [dados, sair]);

  async function carregar(p: Quem, s: string, per: Periodo) {
    const { de, ate } = intervalo(per);
    const r = await rpc<Minhas>("producao_bonus_minhas", { p_pessoa: p.pessoa_id, p_senha: s, p_de: de, p_ate: ate });
    return r;
  }

  async function entrar() {
    if (!pessoa) return;
    setErro(null);
    const primeira = !pessoa.tem_senha;
    if (primeira) {
      if (senha.length < 4) return setErro("A senha precisa ter pelo menos 4 caracteres.");
      if (senha !== senha2) return setErro("As duas senhas não são iguais.");
    } else if (!senha) return setErro("Digite sua senha.");
    setOcupado(true);
    try {
      if (primeira) {
        const d = await rpc<{ ok: boolean; erro?: string }>("ponto_definir_senha", { p_pessoa_id: pessoa.pessoa_id, p_senha: senha, p_senha_atual: null });
        if (!d.ok) { setErro(d.erro ?? "Não deu para gravar a senha."); return; }
        void quemQ.refetch();
      }
      const r = await carregar(pessoa, senha, periodo);
      if (r.precisa_senha) { setPessoa({ ...pessoa, tem_senha: false }); setErro("Você ainda não tem senha: escolha uma."); return; }
      if (!r.ok) { setErro(r.erro ?? "Não deu para entrar."); setSenha(""); return; }
      senhaOk.current = senha;
      ultimoUso.current = Date.now();
      setSenha(""); setSenha2("");
      setDados(r);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  async function trocarPeriodo(p: Periodo) {
    if (!pessoa || !senhaOk.current) return;
    setPeriodo(p);
    try {
      const r = await carregar(pessoa, senhaOk.current, p);
      if (r.ok) setDados(r); else sair();
    } catch (e) { setErro((e as Error).message); }
  }

  // ---------- 1) quem é você? ----------
  if (!pessoa) {
    const lista = quemQ.data ?? [];
    return (
      <Cartao titulo="Meu bônus — quem é você?">
        <div style={{ fontSize: 12.5, color: "var(--pm-t3)", marginBottom: 12 }}>
          Escolha o seu nome. Cada pessoa vê só o próprio bônus, com a sua senha (a mesma do Ponto).
        </div>
        {quemQ.isLoading && <span style={{ color: "var(--pm-t3)" }}>Carregando…</span>}
        {quemQ.error && <span style={{ color: "var(--pm-r)" }}>Não deu para ler: {(quemQ.error as Error).message}</span>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 10 }}>
          {lista.map((p) => (
            <button key={p.pessoa_id} type="button" className="pm-hv" disabled={!p.tem_ponto}
              onClick={() => { setPessoa(p); setErro(null); setSenha(""); setSenha2(""); }}
              style={{ textAlign: "left", cursor: p.tem_ponto ? "pointer" : "not-allowed", background: "var(--pm-s)", border: "1px solid var(--pm-bc)",
                borderRadius: 14, padding: "14px 14px", color: "var(--pm-t)", display: "flex", alignItems: "center", gap: 10, opacity: p.tem_ponto ? 1 : 0.5 }}>
              <span style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--pm-a)", color: "var(--pm-oa)", fontWeight: 700, fontSize: 16, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                {p.pessoa[0]}
              </span>
              <span style={{ display: "flex", flexDirection: "column" }}>
                <b style={{ fontSize: 15 }}>{p.pessoa}</b>
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{!p.tem_ponto ? "sem cadastro no Ponto" : p.tem_senha ? "entrar com a senha" : "1º acesso: criar senha"}</span>
              </span>
            </button>
          ))}
        </div>
        {!quemQ.isLoading && !lista.length && !quemQ.error && <span style={{ color: "var(--pm-t3)" }}>Ninguém com lote de produção ainda.</span>}
      </Cartao>
    );
  }

  // ---------- 2) senha (ou criar senha no 1º acesso) ----------
  if (!dados) {
    const primeira = !pessoa.tem_senha;
    return (
      <Cartao titulo={primeira ? `Olá, ${pessoa.pessoa} — crie sua senha` : `Olá, ${pessoa.pessoa}`}>
        <form onSubmit={(e) => { e.preventDefault(); void entrar(); }} style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 340 }}>
          <div style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>
            {primeira
              ? "É o seu primeiro acesso. Escolha uma senha (pelo menos 4 caracteres) — ela também vale para o Ponto. Não conte para ninguém."
              : "Digite a sua senha (a mesma do Ponto)."}
          </div>
          <Entrada type="password" autoFocus autoComplete="off" value={senha} onChange={(e) => setSenha(e.target.value)}
            placeholder={primeira ? "Nova senha" : "Senha"} style={{ fontSize: 16, padding: "10px 12px" }} />
          {primeira && (
            <Entrada type="password" autoComplete="off" value={senha2} onChange={(e) => setSenha2(e.target.value)}
              placeholder="Repita a senha" style={{ fontSize: 16, padding: "10px 12px" }} />
          )}
          {erro && <span style={{ color: "var(--pm-r)", fontSize: 12.5, fontWeight: 600 }}>{erro}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Botao tom="primario" type="submit" disabled={ocupado}>{ocupado ? "Conferindo…" : primeira ? "Criar senha e entrar" : "Entrar"}</Botao>
            <Botao tom="fantasma" type="button" onClick={sair}>Não sou {pessoa.pessoa}</Botao>
          </div>
          {!primeira && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Esqueceu a senha? Peça ao administrador para zerar — aí você cria outra.</span>}
        </form>
      </Cartao>
    );
  }

  // ---------- 3) o bônus da pessoa ----------
  const r = dados.resumo;
  const linhas = dados.linhas ?? [];
  const kpi = (rot: string, val: string, sub?: string, cor?: string) => (
    <div style={{ background: "var(--pm-s2)", borderRadius: 12, padding: "10px 14px", minWidth: 150 }}>
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 600 }}>{rot}</div>
      <div style={{ fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: cor ?? "var(--pm-t)" }}>{val}</div>
      {sub && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Cartao
        titulo={`Bônus de ${dados.pessoa}`}
        direita={
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 9, overflow: "hidden" }}>
              {(Object.keys(ROTULO) as Periodo[]).map((p) => (
                <button key={p} type="button" onClick={() => void trocarPeriodo(p)}
                  style={{ border: 0, padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: periodo === p ? "var(--pm-a)" : "var(--pm-s)", color: periodo === p ? "var(--pm-oa)" : "var(--pm-t)" }}>
                  {ROTULO[p]}
                </button>
              ))}
            </div>
            <Botao tom="secundario" onClick={sair}>Sair</Botao>
          </div>
        }
      >
        <div style={{ fontSize: 12, color: "var(--pm-t3)", marginBottom: 10 }}>
          Cada lote encerrado paga o valor por saco × sacos bons, dividido igualmente entre quem trabalhou no lote. Só você vê esta tela —
          saia ao terminar (ela trava sozinha depois de 5 minutos parada).
        </div>
        {r && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {kpi("A receber", brl(Number(r.a_pagar)), `${r.lotes_a_pagar} lote(s) ainda não pagos`, Number(r.a_pagar) > 0 ? "var(--pm-am)" : "var(--pm-g)")}
            {kpi("Já recebido", brl(Number(r.pago)), undefined, Number(r.pago) > 0 ? "var(--pm-g)" : undefined)}
            {kpi("Total no período", brl(Number(r.total)), `${r.lotes} lote(s) · ${num(Number(r.sacos), 0)} sacos (sua parte)`)}
          </div>
        )}
      </Cartao>

      <Cartao titulo="Meus lotes">
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <th style={th}>Dia</th><th style={th}>Lote</th><th style={th}>Produto</th>
              <th style={{ ...th, textAlign: "right" }}>Sacos do lote</th><th style={{ ...th, textAlign: "right" }}>Pessoas</th>
              <th style={{ ...th, textAlign: "right" }}>Minha parte (sacos)</th><th style={{ ...th, textAlign: "right" }}>R$/saco</th>
              <th style={{ ...th, textAlign: "right" }}>Bônus</th><th style={th}>Situação</th>
            </tr></thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.ordem_id}>
                  <td style={td}>{dataBR(l.dia)}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{l.codigo}</td>
                  <td style={{ ...td, maxWidth: 320 }}><span style={{ fontWeight: 600 }}>{l.sku}</span> <span style={{ color: "var(--pm-t3)" }}>{l.produto}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>{num(Number(l.sacos_lote), 0)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{l.n_pessoas}</td>
                  <td style={{ ...td, textAlign: "right" }}>{num(Number(l.sacos), 2)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{brl(Number(l.valor_saco))}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 650 }}>{brl(Number(l.valor))}</td>
                  <td style={td}>{l.pago ? <Selo tom="g">pago {dataBR(l.pago_em)}</Selo> : <Selo tom="a">a receber</Selo>}</td>
                </tr>
              ))}
              {!linhas.length && <tr><td style={{ ...td, color: "var(--pm-t3)" }} colSpan={9}>Nenhum lote no período.</td></tr>}
            </tbody>
          </table>
        </div>
      </Cartao>

      {(dados.pagamentos ?? []).length > 0 && (
        <Cartao titulo="Pagamentos que recebi">
          <table style={tabela}>
            <thead><tr><th style={th}>Pago em</th><th style={{ ...th, textAlign: "right" }}>Valor</th><th style={{ ...th, textAlign: "right" }}>Lotes</th><th style={th}>Observação</th></tr></thead>
            <tbody>
              {(dados.pagamentos ?? []).map((p) => (
                <tr key={p.id}>
                  <td style={td}>{dataBR(p.pago_em)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 650 }}>{brl(Number(p.valor))}</td>
                  <td style={{ ...td, textAlign: "right" }}>{p.lotes}</td>
                  <td style={{ ...td, color: "var(--pm-t2)" }}>{p.obs ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Cartao>
      )}
    </div>
  );
}
