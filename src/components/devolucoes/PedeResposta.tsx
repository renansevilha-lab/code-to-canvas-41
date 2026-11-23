// ============================================================================
// Aba "A responder" de /devolucoes — a fila única Shopee + Mercado Livre lida de
// view_devolucoes_pede_resposta. Regra (o que cada marketplace espera, prazo,
// urgência, causa provável) mora na view; aqui só filtro e apresentação.
// Layout de 23/nov/2026 (aprovado pelo dono), no padrão da aba Anúncios: cartões
// "Pede atenção" que filtram, marketplaces com logo, tabela de colunas fixas e o
// caso abrindo na própria linha (PainelCaso embutido).
// ============================================================================
import { Copiavel } from "./Copiavel";
import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";

import { Foto, MONO, Spinner } from "@/components/separacao/ui/kit";
import { PainelCaso } from "./PainelCaso";
import {
  acaoEsperada, brl, diaHora, listarCausas, listarFila, lojaDe, motivoPt, prazoTexto, SOLUCAO_PT,
  type CasoFila, type Empresa,
} from "@/lib/devolucoes";

type Mkt = "todos" | "shopee" | "mercadolivre";
type Visao = "responder" | "aguardando";
type Cartao = "hoje" | "amanha" | "produto" | "ml";

const LOGO: Record<string, string> = { shopee: "/logos/shopee-icon.png", mercadolivre: "/logos/ml-icon.png" };
const NOME_MKT: Record<string, string> = { shopee: "Shopee", mercadolivre: "Mercado Livre" };
const GRADE = "minmax(260px,2.3fr) minmax(170px,1.3fr) minmax(150px,1fr) 96px 168px 84px";

const cab: CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--pm-t3)" };
const sub: CSSProperties = { fontSize: 11.5, color: "var(--pm-t2)" };
const el: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" };
const botao: CSSProperties = { height: 34, padding: "0 13px", borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", cursor: "pointer", fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 };
const TOM_SELO: Record<string, { bg: string; fg: string }> = {
  r: { bg: "var(--pm-rs)", fg: "var(--pm-r)" }, a: { bg: "var(--pm-ams)", fg: "var(--pm-am)" }, g: { bg: "var(--pm-gs)", fg: "var(--pm-g)" },
  n: { bg: "var(--pm-s2)", fg: "var(--pm-t2)" }, azul: { bg: "var(--pm-as)", fg: "var(--pm-at)" },
};
function Selo({ tom, children }: { tom: string; children: React.ReactNode }) {
  const t = TOM_SELO[tom] ?? TOM_SELO.n;
  return <span style={{ display: "inline-block", fontSize: 11.5, fontWeight: 600, padding: "2px 9px", borderRadius: 7, background: t.bg, color: t.fg, whiteSpace: "nowrap" }}>{children}</span>;
}

const bateCartao = (c: CasoFila, k: Cartao) =>
  k === "hoje" ? c.precisa_acao && (c.urgencia === "vencido" || c.urgencia === "hoje")
    : k === "amanha" ? c.precisa_acao && c.urgencia === "amanha"
      : k === "produto" ? c.acao_esperada === "validar_produto"
        : c.marketplace === "mercadolivre" && c.precisa_acao;

export function PedeResposta({ empresa }: { empresa: Empresa | "ambas" }) {
  const filaQ = useQuery({ queryKey: ["devolucoes", "fila"], queryFn: listarFila, staleTime: 60_000, refetchInterval: 180_000 });
  const causasQ = useQuery({ queryKey: ["devolucoes", "causas"], queryFn: listarCausas, staleTime: 10 * 60_000 });
  const [mkt, setMkt] = useState<Mkt>("todos");
  const [visao, setVisao] = useState<Visao>("responder");
  const [cartao, setCartao] = useState<Cartao | null>(null);
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState<string | null>(null);

  const todos = useMemo(() => (filaQ.data ?? []).filter((c) => empresa === "ambas" || c.empresa === empresa), [filaQ.data, empresa]);
  const pedem = useMemo(() => todos.filter((c) => c.precisa_acao), [todos]);
  const aguardam = useMemo(() => todos.filter((c) => !c.precisa_acao), [todos]);

  const cartoes: Array<{ id: Cartao; t: string; s: string; cor: string; n: number }> = [
    { id: "hoje", t: "Vence hoje ou já venceu", s: "o marketplace decide sozinho depois do prazo", cor: "var(--pm-r)", n: 0 },
    { id: "amanha", t: "Vence amanhã", s: "responda hoje para não virar urgente", cor: "var(--pm-am)", n: 0 },
    { id: "produto", t: "Produto devolvido para validar", s: "o pacote chegou: conferir e aprovar ou recusar", cor: "var(--pm-am)", n: 0 },
    { id: "ml", t: "Reclamações no Mercado Livre", s: "mediador ou comprador esperando resposta", cor: "var(--pm-a)", n: 0 },
  ].map((k) => ({ ...k, id: k.id as Cartao, n: todos.filter((c) => bateCartao(c, k.id as Cartao)).length }));

  const base = cartao ? todos.filter((c) => bateCartao(c, cartao)) : visao === "responder" ? pedem : aguardam;
  const nMkt = (m: Mkt) => base.filter((c) => m === "todos" || c.marketplace === m).length;

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return base
      .filter((c) => mkt === "todos" || c.marketplace === mkt)
      .filter((c) => !q || [c.case_id, c.order_sn, c.tiny_numero, c.sku, c.nome_produto, c.texto_cliente, c.motivo_nome].some((x) => (x ?? "").toLowerCase().includes(q)))
      .sort((a, b) => {
        const pa = a.prazo ? new Date(a.prazo).getTime() : Infinity;
        const pb = b.prazo ? new Date(b.prazo).getTime() : Infinity;
        if (pa !== pb) return pa - pb;
        return (b.criado_em ?? "").localeCompare(a.criado_em ?? "");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, cartao, visao, mkt, busca]);

  const chave = (c: CasoFila) => `${c.marketplace}:${c.case_id}`;
  const proximo = () => {
    const i = lista.findIndex((c) => chave(c) === aberto);
    const p = lista[i + 1] ?? lista.find((c) => chave(c) !== aberto);
    setAberto(p ? chave(p) : null);
  };
  const valorPede = pedem.reduce((s, c) => s + (c.valor ?? 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* visão */}
      <div style={{ display: "flex", gap: 2, padding: 3, border: "1px solid var(--pm-bc)", borderRadius: 12, background: "var(--pm-s)", alignSelf: "flex-start", flexWrap: "wrap" }}>
        {([["responder", "A responder", pedem.length], ["aguardando", "Aguardando", aguardam.length]] as Array<[Visao, string, number]>).map(([id, nome, n]) => {
          const on = !cartao && visao === id;
          return (
            <button key={id} type="button" aria-pressed={on} onClick={() => { setCartao(null); setVisao(id); setAberto(null); }}
              title={id === "aguardando" ? "Produto voltando ou em análise do marketplace: nada a fazer agora" : "Casos que esperam uma resposta nossa"}
              style={{ border: 0, cursor: "pointer", height: 38, padding: "0 14px", borderRadius: 9, fontSize: 13, fontWeight: on ? 600 : 500, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t2)", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 7 }}>
              {nome} <span style={{ ...MONO, fontSize: 11, opacity: 0.85 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* pede atenção */}
      <div>
        <div style={{ ...cab, marginBottom: 7 }}>Pede atenção</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          {cartoes.map((k) => {
            const on = cartao === k.id;
            return (
              <button key={k.id} type="button" aria-pressed={on} onClick={() => { setCartao(on ? null : k.id); setAberto(null); }}
                style={{ textAlign: "left", cursor: "pointer", background: on ? "var(--pm-as)" : "var(--pm-s)", border: on ? "1.5px solid var(--pm-a)" : "1px solid var(--pm-bs)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3, boxShadow: "var(--pm-sh)", color: "var(--pm-t)", opacity: k.n === 0 && !on ? 0.7 : 1 }}>
                <span style={{ display: "flex", gap: 7, alignItems: "center", fontWeight: 600, fontSize: 13 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: k.n ? k.cor : "var(--pm-bar)", flex: "none" }} />{k.t}
                </span>
                <span style={{ ...MONO, fontSize: 22, fontWeight: 700 }}>{filaQ.isLoading ? "…" : k.n}</span>
                <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{k.s}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* marketplaces + busca */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 2, padding: 2, border: "1px solid var(--pm-bc)", borderRadius: 10, flexWrap: "wrap", background: "var(--pm-s)" }}>
          {(["todos", "shopee", "mercadolivre"] as Mkt[]).map((m) => {
            const on = mkt === m;
            return (
              <button key={m} type="button" aria-pressed={on} onClick={() => setMkt(m)}
                style={{ border: 0, cursor: "pointer", height: 34, padding: "0 11px", borderRadius: 8, fontSize: 12.5, fontWeight: on ? 600 : 500, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                {m !== "todos" && <img src={LOGO[m]} alt="" style={{ width: 18, height: 18, borderRadius: 4, objectFit: "contain" }} />}
                {m === "todos" ? "Todos" : NOME_MKT[m]} <span style={{ ...MONO, fontSize: 11, opacity: 0.85 }}>{nMkt(m)}</span>
              </button>
            );
          })}
        </div>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar" placeholder="Pedido, solicitação, SKU, produto ou texto do cliente"
          style={{ flex: 1, minWidth: 210, height: 40, padding: "0 14px", borderRadius: 10, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontFamily: "inherit", fontSize: 13, boxSizing: "border-box" }} />
        <button type="button" className="pm-hv" style={botao} onClick={() => void filaQ.refetch()} disabled={filaQ.isFetching}>{filaQ.isFetching ? <Spinner /> : "↻"} Atualizar</button>
      </div>

      {filaQ.error && <div style={{ color: "var(--pm-r)" }}>{(filaQ.error as Error).message}</div>}

      {/* tabela */}
      <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-sh)", overflowX: "auto" }}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 14, padding: "9px 14px", background: "var(--pm-s2)", borderRadius: "14px 14px 0 0", ...cab }}>
            <span>Produto e pedido</span><span>O cliente diz</span><span>O que fazer</span><span style={{ textAlign: "right" }}>Valor</span><span>Prazo</span><span />
          </div>
          {filaQ.isLoading && <div style={{ padding: 18, color: "var(--pm-t3)", display: "flex", gap: 8, alignItems: "center" }}><Spinner /> lendo a fila…</div>}
          {!filaQ.isLoading && lista.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: "var(--pm-t3)", borderTop: "1px solid var(--pm-b)" }}>
              {cartao || busca || mkt !== "todos" ? "Nenhum caso com este filtro." : visao === "responder" ? "Nada pedindo resposta agora." : "Nenhum caso aguardando."}
            </div>
          )}
          {lista.map((c) => {
            const k = chave(c);
            const on = aberto === k;
            return (
              <div key={k}>
                <Linha c={c} aberto={on} onAbrir={() => setAberto(on ? null : k)} />
                {on && (
                  <div style={{ borderTop: "1px solid var(--pm-b)", background: "var(--pm-as)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", maxWidth: 920, margin: "0 auto", width: "100%" }}>
                      <button type="button" className="pm-hv" style={botao} onClick={proximo} disabled={lista.length < 2}>Próximo caso ›</button>
                    </div>
                    <PainelCaso embutido caso={c} causas={causasQ.data ?? []} onFechar={() => setAberto(null)} onMudou={() => void filaQ.refetch()} />
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ padding: "10px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12, color: "var(--pm-t2)" }}>
            {lista.length} na lista · {pedem.length} pedem resposta ({brl(valorPede)}) · {aguardam.length} só aguardam · atualiza a cada 3 min (o Mercado Livre a cada 20)
          </div>
        </div>
      </div>
    </div>
  );
}

function Linha({ c, aberto, onAbrir }: { c: CasoFila; aberto: boolean; onAbrir: () => void }) {
  const ae = acaoEsperada(c.acao_esperada);
  const pz = prazoTexto(c.prazo);
  const problemas = c.entrada_problemas?.length ?? 0;
  const fala = c.texto_cliente ? c.texto_cliente.split("\n").pop() : null;
  return (
    <div
      role="button" tabIndex={0} aria-expanded={aberto} onClick={onAbrir} className={aberto ? undefined : "pm-linha-hv"}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onAbrir(); } }}
      style={{ display: "grid", gridTemplateColumns: GRADE, gap: 14, alignItems: "center", padding: "11px 14px", borderTop: "1px solid var(--pm-b)", cursor: "pointer", background: aberto ? "var(--pm-as)" : undefined, color: "var(--pm-t)", opacity: c.precisa_acao ? 1 : 0.85 }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", minWidth: 0 }}>
        <Foto src={c.foto} alt={c.nome_produto ?? ""} tam={44} />
        <div style={{ minWidth: 0 }}>
          <span style={{ ...el, fontWeight: 600 }} title={c.nome_produto ?? ""}>{c.nome_produto ?? c.sku ?? "—"}{c.itens.length > 1 ? ` (+${c.itens.length - 1})` : ""}</span>
          <span style={{ ...sub, display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
            <img src={LOGO[c.marketplace]} alt={NOME_MKT[c.marketplace]} title={NOME_MKT[c.marketplace]} style={{ width: 16, height: 16, borderRadius: 4, objectFit: "contain", flex: "none" }} />
            <span style={{ whiteSpace: "nowrap" }}>{lojaDe(c)}</span>
            <Copiavel valor={c.order_sn} style={{ fontSize: 11.5 }} />
            {c.sku && <span style={{ whiteSpace: "nowrap" }}>· SKU <Copiavel valor={c.sku} oQue="SKU" style={{ fontSize: 11.5 }} /></span>}
          </span>
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <span style={{ ...el, fontWeight: 600 }}>{motivoPt(c.motivo_nome ?? c.motivo)}{c.fotos_cliente > 0 ? ` · ${c.fotos_cliente} foto${c.fotos_cliente > 1 ? "s" : ""}` : ""}</span>
        <span style={{ ...sub, ...el, fontStyle: fala ? "italic" : undefined }} title={fala ?? ""}>{fala ? `"${fala}"` : c.solucao ? SOLUCAO_PT[c.solucao] ?? c.solucao : "sem texto do cliente"}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start", minWidth: 0 }}>
        <Selo tom={c.precisa_acao ? "azul" : "n"}>{ae.rotulo.length > 26 ? ae.curto : ae.rotulo}</Selo>
        {c.entrada_em ? <Selo tom={problemas ? "r" : "g"}>{problemas ? `no galpão · ${problemas} com problema` : "no galpão"}</Selo> : null}
        {c.respondido_em && <span style={sub}>respondido {diaHora(c.respondido_em)}</span>}
      </div>
      <span style={{ ...MONO, textAlign: "right", fontSize: 13 }}>{brl(c.valor)}</span>
      <div>
        {c.prazo
          ? <><Selo tom={pz.tom}>{pz.txt === "venceu" ? "venceu" : `vence em ${pz.txt}`}</Selo><span style={{ ...sub, display: "block", marginTop: 2 }}>{diaHora(c.prazo)}</span></>
          : <span style={sub}>sem prazo</span>}
      </div>
      <span style={{ textAlign: "right" }}><span style={{ ...botao, height: 30 }}>{aberto ? "Fechar" : "Abrir"}</span></span>
    </div>
  );
}
