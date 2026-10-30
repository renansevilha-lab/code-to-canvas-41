// ============================================================================
// Aba "Resultados" de /devolucoes (29/out/2026, pedido do dono: "aba de
// resultados, perdas totais e etc"). Tudo vem da RPC devolucao_resultados
// (view_devolucao_erros: Shopee + Mercado Livre, uma linha por caso); aqui só
// apresentação e o drill (devolucao_resultados_casos → PainelCaso).
//
// Dinheiro, nas palavras da tela:
//   Reembolsado ao cliente   = o que o cliente recebeu de volta.
//   Saiu do nosso bolso      = descontado de nós − compensado pelo marketplace.
//   Produto que não voltou   = CMV dos casos em que o produto ficou com o cliente/extraviou.
//   Perda total              = saiu do bolso + produto que não voltou.
// ============================================================================
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";

import { Botao, Cartao, Numero, Selo, tabela, td, th } from "@/components/producao/ui";
import { Foto, Segmento, Spinner } from "@/components/separacao/ui/kit";
import { PainelCaso } from "./PainelCaso";
import {
  brl, casoFilaDeErro, dia, GRUPO_CAUSA_PT, lerCasosResultado, lerResultados, listarCausas, motivoPt, periodoJanela,
  type CasoErro, type Empresa, type JanelaResultados, type ResultadosDevolucao,
} from "@/lib/devolucoes";

const JANELAS: Array<{ id: JanelaResultados; nome: string }> = [
  { id: "mes", nome: "Mês atual" }, { id: "3m", nome: "3 meses" }, { id: "6m", nome: "6 meses" }, { id: "12m", nome: "12 meses" }, { id: "ano", nome: "Este ano" },
];
const MKT_PT: Record<string, string> = { shopee: "Shopee", mercadolivre: "Mercado Livre" };
const EMP_PT: Record<string, string> = { ottz: "Ottz / ACZ", svl: "SVL / Bumi" };
const COR_GRUPO: Record<string, string> = {
  separacao: "var(--pm-r)", embalagem: "var(--pm-am)", transportadora: "var(--pm-azul, #3b82f6)", produto: "#a855f7", cliente: "var(--pm-t3)", outro: "var(--pm-t3)",
};

const pct = (n: number, d: number, casas = 1) => (d > 0 ? `${((n / d) * 100).toLocaleString("pt-BR", { maximumFractionDigits: casas, minimumFractionDigits: casas })}%` : "—");
const int = (n: number) => n.toLocaleString("pt-BR");
const mesPt = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }).replace(".", "");
};

type Drill = { titulo: string; grupo?: string | null; causa?: string | null; separador?: string | null; sku?: string | null };

export function Resultados({ empresa, janela, onJanela }: { empresa: Empresa | "ambas"; janela: JanelaResultados; onJanela: (j: JanelaResultados) => void }) {
  const { de, ate } = useMemo(() => periodoJanela(janela), [janela]);
  const q = useQuery({
    queryKey: ["devolucoes", "resultados", de, ate, empresa],
    queryFn: () => lerResultados(de, ate, empresa),
    staleTime: 5 * 60_000, placeholderData: undefined,
  });
  const causasQ = useQuery({ queryKey: ["devolucoes", "causas"], queryFn: listarCausas, staleTime: 10 * 60_000 });
  const [drill, setDrill] = useState<Drill | null>(null);
  const [aberto, setAberto] = useState<CasoErro | null>(null);
  const [verMotivos, setVerMotivos] = useState(false);
  const [verClasses, setVerClasses] = useState(false);
  const r = q.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Segmento<JanelaResultados> ops={JANELAS} valor={janela} onValor={onJanela} />
        <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{dia(de)} a {dia(ate)} · pela data da devolução/reclamação</span>
        <div style={{ flex: 1 }} />
        <Botao onClick={() => void q.refetch()} disabled={q.isFetching}>{q.isFetching ? <Spinner /> : null} Atualizar</Botao>
      </div>

      {q.isError && (
        <div style={{ padding: 12, borderRadius: 12, background: "var(--pm-rs)", color: "var(--pm-r)", fontSize: 12.5 }}>
          Não deu para ler os resultados: {(q.error as Error).message}
        </div>
      )}

      {!r && !q.isError && (
        <div style={{ padding: 40, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--pm-t3)" }}><Spinner /> Somando os casos do período…</div>
      )}

      {r && (
        <>
          <Totais r={r} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
            <PorMes r={r} />
            <PorLoja r={r} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
            <PorCausa r={r} onDrill={setDrill} />
            <PorPessoa r={r} onDrill={setDrill} />
          </div>

          <PorSku r={r} onDrill={setDrill} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 14 }}>
            <Cartao titulo="Motivo informado pelo cliente" direita={<Botao tom="fantasma" onClick={() => setVerMotivos((v) => !v)}>{verMotivos ? "esconder" : "ver"}</Botao>}>
              {verMotivos ? (
                <table style={tabela}>
                  <thead><tr><th style={th}>Marketplace</th><th style={th}>Motivo</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>Perda total</th></tr></thead>
                  <tbody>
                    {r.por_motivo.map((m, i) => (
                      <tr key={i}><td style={td}>{MKT_PT[m.marketplace]}</td><td style={td}>{motivoPt(m.motivo)}</td><td style={{ ...td, textAlign: "right" }}>{int(m.casos)}</td><td style={{ ...td, textAlign: "right" }}>{brl(m.perda_total)}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>{r.por_motivo.length} motivos diferentes no período. O motivo é o que o cliente escolheu no marketplace; a causa (acima) é a nossa leitura.</div>}
            </Cartao>
            <Cartao titulo="Como cada caso terminou" direita={<Botao tom="fantasma" onClick={() => setVerClasses((v) => !v)}>{verClasses ? "esconder" : "ver"}</Botao>}>
              {verClasses ? (
                <table style={tabela}>
                  <thead><tr><th style={th}>Marketplace</th><th style={th}>Situação</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>Perda total</th></tr></thead>
                  <tbody>
                    {r.por_classe.map((c, i) => (
                      <tr key={i}><td style={td}>{MKT_PT[c.marketplace]}</td><td style={td}>{c.classe.replace(/^\d\d\s/, "")}</td><td style={{ ...td, textAlign: "right" }}>{int(c.casos)}</td><td style={{ ...td, textAlign: "right" }}>{brl(c.perda_total)}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>Quem pagou o reembolso (nós, a Shopee, o ML), se o produto voltou, disputas ganhas e perdidas.</div>}
            </Cartao>
          </div>

          {drill && (
            <DrillCasos de={de} ate={ate} empresa={empresa} drill={drill} onFechar={() => setDrill(null)} onAbrir={setAberto} />
          )}
        </>
      )}

      {aberto && (
        <PainelCaso caso={casoFilaDeErro(aberto)} causas={causasQ.data ?? []} onFechar={() => setAberto(null)} onMudou={() => { void q.refetch(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Totais({ r }: { r: ResultadosDevolucao }) {
  const t = r.totais;
  const grade: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))", gap: 14 };
  return (
    <Cartao>
      <div style={grade}>
        <Numero rotulo="Perda total" valor={brl(t.perda_total)} tom="r" sub="dinheiro + produto que não voltou" />
        <Numero rotulo="Saiu do nosso bolso" valor={brl(t.perda_liquida)} sub={`reembolsado ${brl(t.reembolsado)} · marketplace cobriu ${brl(t.compensado + (t.reembolsado - t.descontado))}`} />
        <Numero rotulo="Produto que não voltou" valor={brl(t.cmv_perdido)} tom="a" sub="a custo (CMV)" />
        <Numero rotulo="Casos" valor={int(t.casos)} sub={`${pct(t.casos, t.pedidos, 2)} dos ${int(t.pedidos)} pedidos · ${int(t.em_aberto)} em aberto`} />
        <Numero rotulo="Produto voltou" valor={int(t.produto_voltou)} sub={`${pct(t.produto_voltou, t.casos)} dos casos`} />
        <Numero rotulo="Causa confirmada" valor={pct(t.classificados, t.casos)} tom={t.classificados / Math.max(t.casos, 1) < 0.3 ? "a" : "g"} sub="o resto é a causa provável pelo motivo" />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 10, lineHeight: 1.5 }}>
        <b style={{ fontWeight: 600 }}>Como ler:</b> "saiu do nosso bolso" é o reembolso que foi descontado de nós menos o que o marketplace devolveu (compensação, cobertura).
        "Produto que não voltou" é o custo da mercadoria nos casos em que o cliente ficou com ela ou o pacote extraviou e o reembolso foi nosso. A causa vem da resposta dada no painel do caso ou da entrada no galpão; sem isso, é a causa provável pelo motivo que o cliente escolheu.
      </div>
    </Cartao>
  );
}

function Barra({ v, max, cor = "var(--pm-a)" }: { v: number; max: number; cor?: string }) {
  const w = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
  return <span style={{ display: "inline-block", width: 90, height: 6, borderRadius: 3, background: "var(--pm-s2)", verticalAlign: "middle" }}><span style={{ display: "block", width: `${w}%`, height: "100%", borderRadius: 3, background: cor }} /></span>;
}

function PorMes({ r }: { r: ResultadosDevolucao }) {
  const max = Math.max(...r.por_mes.map((m) => m.perda_total), 0);
  return (
    <Cartao titulo="Por mês">
      <table style={tabela}>
        <thead><tr><th style={th}>Mês</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>% pedidos</th><th style={{ ...th, textAlign: "right" }}>Bolso</th><th style={{ ...th, textAlign: "right" }}>Produto</th><th style={{ ...th, textAlign: "right" }}>Perda total</th><th style={th} /></tr></thead>
        <tbody>
          {r.por_mes.map((m) => (
            <tr key={m.mes}>
              <td style={td}>{mesPt(m.mes)}</td>
              <td style={{ ...td, textAlign: "right" }}>{int(m.casos)}</td>
              <td style={{ ...td, textAlign: "right", color: "var(--pm-t2)" }}>{pct(m.casos, m.pedidos, 2)}</td>
              <td style={{ ...td, textAlign: "right" }}>{brl(m.perda_liquida)}</td>
              <td style={{ ...td, textAlign: "right" }}>{brl(m.cmv_perdido)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{brl(m.perda_total)}</td>
              <td style={td}><Barra v={m.perda_total} max={max} cor="var(--pm-r)" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Cartao>
  );
}

function PorLoja({ r }: { r: ResultadosDevolucao }) {
  return (
    <Cartao titulo="Por marketplace e loja">
      <table style={tabela}>
        <thead><tr><th style={th}>Loja</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>% pedidos</th><th style={{ ...th, textAlign: "right" }}>Reembolsado</th><th style={{ ...th, textAlign: "right" }}>Bolso</th><th style={{ ...th, textAlign: "right" }}>Produto</th><th style={{ ...th, textAlign: "right" }}>Perda total</th></tr></thead>
        <tbody>
          {r.por_marketplace.map((m, i) => (
            <tr key={i}>
              <td style={td}>{MKT_PT[m.marketplace]} <span style={{ color: "var(--pm-t3)" }}>· {m.empresa ? EMP_PT[m.empresa] : "?"}</span></td>
              <td style={{ ...td, textAlign: "right" }}>{int(m.casos)}</td>
              <td style={{ ...td, textAlign: "right", color: "var(--pm-t2)" }}>{pct(m.casos, m.pedidos, 2)}</td>
              <td style={{ ...td, textAlign: "right" }}>{brl(m.reembolsado)}</td>
              <td style={{ ...td, textAlign: "right" }}>{brl(m.perda_liquida)}</td>
              <td style={{ ...td, textAlign: "right" }}>{brl(m.cmv_perdido)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{brl(m.perda_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
        Mercado Livre: só reclamações (mediações e devoluções); cancelamento de compra fica de fora. Quando o ML cobre o reembolso, nada sai do nosso bolso.
      </div>
    </Cartao>
  );
}

function PorCausa({ r, onDrill }: { r: ResultadosDevolucao; onDrill: (d: Drill) => void }) {
  const [abertos, setAbertos] = useState<Record<string, boolean>>({ separacao: true, embalagem: true });
  const tot = r.totais;
  const maxG = Math.max(...r.por_grupo.map((g) => g.perda_total), 0);
  return (
    <Cartao titulo="Por causa" direita={<span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>clique na linha para ver os casos</span>}>
      <table style={tabela}>
        <thead><tr><th style={th}>Causa</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>% casos</th><th style={{ ...th, textAlign: "right" }}>Perda total</th><th style={th} /></tr></thead>
        <tbody>
          {r.por_grupo.map((g) => {
            const causas = r.por_causa.filter((c) => c.grupo === g.grupo);
            const on = !!abertos[g.grupo];
            return [
              <tr key={g.grupo} style={{ cursor: "pointer", background: "var(--pm-s2)" }} onClick={() => setAbertos((a) => ({ ...a, [g.grupo]: !on }))}>
                <td style={{ ...td, fontWeight: 600 }}>
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: COR_GRUPO[g.grupo] ?? "var(--pm-t3)", marginRight: 8 }} />
                  {GRUPO_CAUSA_PT[g.grupo] ?? g.grupo}
                  <span style={{ color: "var(--pm-t3)", fontWeight: 500, marginLeft: 6, fontSize: 11 }}>{on ? "▾" : "▸"}</span>
                  {g.classificados === 0 && g.casos > 0 && <Selo tom="a">só provável</Selo>}
                </td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{int(g.casos)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--pm-t2)" }}>{pct(g.casos, tot.casos)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{brl(g.perda_total)}</td>
                <td style={td}><Barra v={g.perda_total} max={maxG} cor={COR_GRUPO[g.grupo]} /></td>
              </tr>,
              ...(on ? causas.map((c) => (
                <tr key={`${g.grupo}:${c.causa}`} className="pm-linha-hv" style={{ cursor: "pointer" }} onClick={() => onDrill({ titulo: c.causa_nome ?? c.causa ?? "Outro", causa: c.causa, grupo: c.causa ? null : g.grupo })}>
                  <td style={{ ...td, paddingLeft: 30 }}>{c.causa_nome ?? c.causa ?? "Outro"} <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>· {int(c.classificados)} confirmados</span></td>
                  <td style={{ ...td, textAlign: "right" }}>{int(c.casos)}</td>
                  <td style={{ ...td, textAlign: "right", color: "var(--pm-t2)" }}>{pct(c.casos, tot.casos)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{brl(c.perda_total)}</td>
                  <td style={td} />
                </tr>
              )) : []),
            ];
          })}
        </tbody>
      </table>
    </Cartao>
  );
}

function PorPessoa({ r, onDrill }: { r: ResultadosDevolucao; onDrill: (d: Drill) => void }) {
  return (
    <Cartao titulo="Por quem finalizou a TAG" direita={<span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>erros nossos = separação + embalagem</span>}>
      {r.por_pessoa.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>Nenhum caso do período tem TAG finalizada com nome. O crédito vem do Monitoramento ("Finalizando como").</div>
      ) : (
        <table style={tabela}>
          <thead><tr><th style={th}>Pessoa</th><th style={{ ...th, textAlign: "right" }}>Pedidos finalizados</th><th style={{ ...th, textAlign: "right" }}>Casos</th><th style={{ ...th, textAlign: "right" }}>Erros nossos</th><th style={{ ...th, textAlign: "right" }}>% erros</th><th style={{ ...th, textAlign: "right" }}>Perda total</th></tr></thead>
          <tbody>
            {r.por_pessoa.map((p) => {
              const taxa = p.pedidos_finalizados > 0 ? p.erros_nossos / p.pedidos_finalizados : 0;
              return (
                <tr key={p.separador} className="pm-linha-hv" style={{ cursor: "pointer" }} onClick={() => onDrill({ titulo: `Casos de ${p.separador}`, separador: p.separador })}>
                  <td style={{ ...td, fontWeight: 600 }}>{p.separador}</td>
                  <td style={{ ...td, textAlign: "right" }}>{int(p.pedidos_finalizados)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{int(p.casos)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{int(p.erros_nossos)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600, color: taxa > 0.02 ? "var(--pm-r)" : taxa > 0.01 ? "var(--pm-am)" : "var(--pm-g)" }}>{pct(p.erros_nossos, p.pedidos_finalizados, 2)}</td>
                  <td style={{ ...td, textAlign: "right" }}>{brl(p.perda_total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
        "Casos" conta tudo que voltou de um pedido que a pessoa finalizou (inclusive transportadora e cliente). "Erros nossos" são só os de separação e embalagem — e a maioria ainda é causa provável, não confirmada. Login compartilhado ("Separacao 1") não diz quem foi.
      </div>
    </Cartao>
  );
}

function PorSku({ r, onDrill }: { r: ResultadosDevolucao; onDrill: (d: Drill) => void }) {
  return (
    <Cartao titulo="Produtos que mais perdem" direita={<span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>20 maiores por perda total</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: 8 }}>
        {r.por_sku.map((s) => (
          <button key={s.sku} type="button" className="pm-hv" onClick={() => onDrill({ titulo: `${s.sku} · ${s.nome_produto ?? ""}`, sku: s.sku })}
            style={{ display: "flex", gap: 10, alignItems: "center", textAlign: "left", padding: 8, borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", color: "var(--pm-t)" }}>
            <Foto src={s.foto} alt={s.nome_produto ?? s.sku} tam={44} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.nome_produto ?? ""}>{s.nome_produto ?? "—"}</div>
              <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
                {s.sku} · {int(s.casos)} casos
                {s.separacao > 0 && <> · <span style={{ color: "var(--pm-r)" }}>{s.separacao} separação</span></>}
                {s.embalagem > 0 && <> · <span style={{ color: "var(--pm-am)" }}>{s.embalagem} embalagem</span></>}
              </div>
            </div>
            <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap" }}>{brl(s.perda_total)}</div>
          </button>
        ))}
      </div>
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
// Drill: lista de casos de um recorte

function DrillCasos({ de, ate, empresa, drill, onFechar, onAbrir }: { de: string; ate: string; empresa: Empresa | "ambas"; drill: Drill; onFechar: () => void; onAbrir: (c: CasoErro) => void }) {
  const q = useQuery({
    queryKey: ["devolucoes", "resultados-casos", de, ate, empresa, drill.grupo ?? null, drill.causa ?? null, drill.separador ?? null, drill.sku ?? null],
    queryFn: () => lerCasosResultado({ de, ate, empresa, grupo: drill.grupo, causa: drill.causa, separador: drill.separador, sku: drill.sku }),
    staleTime: 60_000, placeholderData: undefined,
  });
  const casos = q.data ?? [];
  const ORIGEM: Record<string, { txt: string; tom: "g" | "azul" | "n" }> = { resposta: { txt: "confirmada", tom: "g" }, entrada: { txt: "no galpão", tom: "azul" }, provavel: { txt: "provável", tom: "n" } };
  return (
    <Cartao titulo={<>Casos · {drill.titulo}</>} direita={<Botao tom="fantasma" onClick={onFechar}>fechar</Botao>}>
      {q.isLoading ? <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--pm-t3)" }}><Spinner /> lendo…</div> : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={tabela}>
              <thead><tr>
                <th style={th}>Data</th><th style={th}>Loja</th><th style={th}>Pedido</th><th style={th}>Produto</th><th style={th}>Motivo</th><th style={th}>Causa</th><th style={th}>Quem</th>
                <th style={{ ...th, textAlign: "right" }}>Reembolso</th><th style={{ ...th, textAlign: "right" }}>Bolso</th><th style={{ ...th, textAlign: "right" }}>Produto</th><th style={th}>Voltou</th>
              </tr></thead>
              <tbody>
                {casos.map((c) => (
                  <tr key={`${c.marketplace}:${c.case_id}`} className="pm-linha-hv" style={{ cursor: "pointer" }} onClick={() => onAbrir(c)}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{dia(c.data)}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{MKT_PT[c.marketplace]} <span style={{ color: "var(--pm-t3)" }}>{c.empresa ? EMP_PT[c.empresa] : ""}</span></td>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{c.order_sn ?? c.case_id}</td>
                    <td style={{ ...td, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.nome_produto ?? ""}>{c.sku ? <b style={{ fontWeight: 600 }}>{c.sku}</b> : null} {c.nome_produto ?? ""}</td>
                    <td style={td}>{motivoPt(c.motivo)}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{c.causa_nome ?? c.causa ?? "—"} <Selo tom={ORIGEM[c.causa_origem]?.tom ?? "n"}>{ORIGEM[c.causa_origem]?.txt ?? c.causa_origem}</Selo></td>
                    <td style={td}>{c.separador ?? "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(c.valor_reembolsado)}</td>
                    <td style={{ ...td, textAlign: "right", color: c.perda_liquida > 0 ? "var(--pm-r)" : undefined }}>{brl(c.perda_liquida)}</td>
                    <td style={{ ...td, textAlign: "right", color: c.cmv_perdido > 0 ? "var(--pm-am)" : undefined }}>{brl(c.cmv_perdido)}</td>
                    <td style={td}>{c.produto_voltou ? <Selo tom="g">sim</Selo> : c.em_aberto ? <Selo tom="n">em aberto</Selo> : <Selo tom="r">não</Selo>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
            {casos.length >= 200 ? "Mostrando os 200 de maior perda. " : `${casos.length} casos. `}
            Clique num caso para abrir o painel e confirmar a causa — a causa confirmada substitui a provável aqui.
          </div>
        </>
      )}
    </Cartao>
  );
}
