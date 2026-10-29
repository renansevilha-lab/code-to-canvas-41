// ============================================================================
// Aba "Pede resposta" de /devolucoes (29/out/2026) — a fila única Shopee +
// Mercado Livre lida de view_devolucoes_pede_resposta: tudo que espera uma
// decisão nossa, por prazo. Clicar abre o painel do caso (PainelCaso). Regra
// (o que cada marketplace espera, prazo, urgência, causa provável) mora na
// view; aqui só filtro e apresentação.
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Botao, Entrada, Selo } from "@/components/producao/ui";
import { FaixaPedeAcao, Foto, Segmento, Spinner, type CartaoAcao } from "@/components/separacao/ui/kit";
import { PainelCaso } from "./PainelCaso";
import {
  acaoEsperada, brl, diaHora, listarCausas, listarFila, lojaDe, motivoPt, prazoTexto, SOLUCAO_PT,
  type CasoFila, type Empresa,
} from "@/lib/devolucoes";

type Mkt = "todos" | "shopee" | "mercadolivre";
type Recorte = "pede" | "hoje" | "produto" | "ml" | "todos";

export function PedeResposta({ empresa }: { empresa: Empresa | "ambas" }) {
  const filaQ = useQuery({ queryKey: ["devolucoes", "fila"], queryFn: listarFila, staleTime: 60_000, refetchInterval: 180_000 });
  const causasQ = useQuery({ queryKey: ["devolucoes", "causas"], queryFn: listarCausas, staleTime: 10 * 60_000 });
  const [mkt, setMkt] = useState<Mkt>("todos");
  const [recorte, setRecorte] = useState<Recorte>("pede");
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState<{ marketplace: string; case_id: string } | null>(null);

  const todos = useMemo(() => (filaQ.data ?? []).filter((c) => empresa === "ambas" || c.empresa === empresa), [filaQ.data, empresa]);

  const n = useMemo(() => ({
    pede: todos.filter((c) => c.precisa_acao).length,
    hoje: todos.filter((c) => c.precisa_acao && (c.urgencia === "vencido" || c.urgencia === "hoje")).length,
    amanha: todos.filter((c) => c.precisa_acao && c.urgencia === "amanha").length,
    produto: todos.filter((c) => c.acao_esperada === "validar_produto").length,
    ml: todos.filter((c) => c.marketplace === "mercadolivre" && c.precisa_acao).length,
    valorPede: todos.filter((c) => c.precisa_acao).reduce((s, c) => s + (c.valor ?? 0), 0),
    semEntrada: todos.filter((c) => c.acao_esperada === "aguardando_produto").length,
  }), [todos]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return todos
      .filter((c) => mkt === "todos" || c.marketplace === mkt)
      .filter((c) => {
        if (recorte === "pede") return c.precisa_acao;
        if (recorte === "hoje") return c.precisa_acao && (c.urgencia === "vencido" || c.urgencia === "hoje");
        if (recorte === "produto") return c.acao_esperada === "validar_produto";
        if (recorte === "ml") return c.marketplace === "mercadolivre" && c.precisa_acao;
        return true;
      })
      .filter((c) => !q || [c.case_id, c.order_sn, c.tiny_numero, c.sku, c.nome_produto, c.texto_cliente, c.motivo_nome].some((x) => (x ?? "").toLowerCase().includes(q)))
      .sort((a, b) => {
        if (a.precisa_acao !== b.precisa_acao) return a.precisa_acao ? -1 : 1;
        const pa = a.prazo ? new Date(a.prazo).getTime() : Infinity;
        const pb = b.prazo ? new Date(b.prazo).getTime() : Infinity;
        if (pa !== pb) return pa - pb;
        return (b.criado_em ?? "").localeCompare(a.criado_em ?? "");
      });
  }, [todos, mkt, recorte, busca]);

  const cartoes: CartaoAcao[] = [];
  if (n.hoje) cartoes.push({ chave: "hoje", tom: "r", label: "Vence hoje ou já venceu", n: String(n.hoje), ctx: "o marketplace decide sozinho depois do prazo", onClick: () => setRecorte("hoje") });
  if (n.amanha) cartoes.push({ chave: "amanha", tom: "a", label: "Vence amanhã", n: String(n.amanha), ctx: "responda hoje para não virar urgente", onClick: () => setRecorte("pede") });
  if (n.produto) cartoes.push({ chave: "produto", tom: "a", label: "Produto devolvido para validar", n: String(n.produto), ctx: "o pacote chegou — conferir e aprovar ou recusar", onClick: () => setRecorte("produto") });
  if (n.ml) cartoes.push({ chave: "ml", tom: "a", label: "Reclamações no Mercado Livre", n: String(n.ml), ctx: "mediador ou comprador esperando resposta", onClick: () => setRecorte("ml") });
  const emDia: string[] = [];
  if (!n.hoje) emDia.push("nenhum prazo vencendo hoje");
  if (!n.ml) emDia.push("ML sem reclamação aberta");

  const casoAberto = aberto ? todos.find((c) => c.marketplace === aberto.marketplace && c.case_id === aberto.case_id) ?? null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <FaixaPedeAcao cartoes={cartoes} emDia={emDia} carregando={filaQ.isLoading} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Segmento<Recorte>
          valor={recorte} onValor={setRecorte}
          ops={[
            { id: "pede", nome: "Pede resposta", sub: String(n.pede) },
            { id: "hoje", nome: "Hoje / vencidos", sub: String(n.hoje) },
            { id: "produto", nome: "Validar produto", sub: String(n.produto) },
            { id: "todos", nome: "Tudo em aberto", sub: String(todos.length) },
          ]}
        />
        <Segmento<Mkt> valor={mkt} onValor={setMkt} ops={[{ id: "todos", nome: "Shopee + ML" }, { id: "shopee", nome: "Shopee" }, { id: "mercadolivre", nome: "Mercado Livre" }]} />
        <div style={{ flex: 1 }} />
        <Entrada value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="pedido, solicitação, SKU, produto, texto…" style={{ width: 280 }} />
        <Botao tom="secundario" onClick={() => void filaQ.refetch()} disabled={filaQ.isFetching}>{filaQ.isFetching ? <Spinner /> : "↻"} Atualizar</Botao>
      </div>

      <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>
        {n.pede} pedem resposta ({brl(n.valorPede)}) · {n.semEntrada} aguardando o produto voltar · lista atualiza a cada 3 min (o ML a cada 20)
      </div>

      {filaQ.error && <div style={{ color: "var(--pm-r)" }}>{(filaQ.error as Error).message}</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filaQ.isLoading && <div style={{ color: "var(--pm-t3)", display: "flex", gap: 8, alignItems: "center" }}><Spinner /> lendo a fila…</div>}
        {!filaQ.isLoading && lista.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--pm-t3)", background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 12 }}>
            Nada aqui {recorte === "pede" ? "pedindo resposta" : "neste recorte"}{empresa !== "ambas" ? ` na ${empresa === "svl" ? "SVL" : "Ottz"}` : ""}.
          </div>
        )}
        {lista.map((c) => <Linha key={`${c.marketplace}:${c.case_id}`} c={c} onAbrir={() => setAberto({ marketplace: c.marketplace, case_id: c.case_id })} causaNome={causasQ.data?.find((x) => x.codigo === (c.causa_interna ?? c.causa_provavel))?.nome ?? null} />)}
      </div>

      {casoAberto && (
        <PainelCaso caso={casoAberto} causas={causasQ.data ?? []} onFechar={() => setAberto(null)} onMudou={() => void filaQ.refetch()} />
      )}
    </div>
  );
}

function Linha({ c, onAbrir, causaNome }: { c: CasoFila; onAbrir: () => void; causaNome: string | null }) {
  const ae = acaoEsperada(c.acao_esperada);
  const pz = prazoTexto(c.prazo);
  const corBorda = !c.precisa_acao ? "var(--pm-b)" : pz.tom === "r" ? "var(--pm-r)" : pz.tom === "a" ? "var(--pm-am)" : "var(--pm-a)";
  const problemas = c.entrada_problemas?.length ?? 0;
  return (
    <button
      type="button" onClick={onAbrir} className="pm-linha-hv"
      style={{ textAlign: "left", display: "grid", gridTemplateColumns: "52px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "10px 12px", borderRadius: 12, border: "1px solid var(--pm-bs)", borderLeft: `4px solid ${corBorda}`, background: "var(--pm-s)", cursor: "pointer", color: "var(--pm-t)", opacity: c.precisa_acao ? 1 : 0.78 }}
    >
      <Foto src={c.foto} alt={c.nome_produto ?? ""} tam={52} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
          <Selo tom={c.marketplace === "shopee" ? "r" : "a"}>{c.marketplace === "shopee" ? "Shopee" : "ML"}</Selo>
          <span style={{ color: "var(--pm-t2)" }}>{lojaDe(c)}</span>
          <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{c.case_id}</span>
          <span style={{ color: "var(--pm-t3)" }}>pedido {c.order_sn ?? "—"}{c.tiny_numero ? ` · Tiny ${c.tiny_numero}` : ""}</span>
        </div>
        <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <b>{motivoPt(c.motivo_nome ?? c.motivo)}</b>
          {c.solucao && <span style={{ color: "var(--pm-t3)" }}> · {SOLUCAO_PT[c.solucao] ?? c.solucao}</span>}
          {c.texto_cliente && <span style={{ color: "var(--pm-t2)", fontStyle: "italic" }}> — "{c.texto_cliente.split("\n").pop()}"</span>}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--pm-t3)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>{c.sku ? `${c.sku} · ` : ""}{c.nome_produto ?? ""}{c.itens.length > 1 ? ` (+${c.itens.length - 1})` : ""}</span>
          {c.entrada_em ? <Selo tom={problemas ? "r" : "g"}>{problemas ? `no galpão · ${problemas} com problema` : "no galpão"}</Selo> : null}
          {causaNome && <Selo tom={c.causa_interna ? "azul" : "n"}>{c.causa_interna ? causaNome : `provável: ${causaNome}`}</Selo>}
          {c.respondido_em && <Selo tom="g">respondido {diaHora(c.respondido_em)}</Selo>}
          {c.fotos_cliente > 0 && <span>{c.fotos_cliente} foto{c.fotos_cliente > 1 ? "s" : ""}</span>}
        </div>
      </div>
      <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{brl(c.valor)}</span>
        <Selo tom={ae.tom}>{ae.curto}</Selo>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: pz.tom === "r" ? "var(--pm-r)" : pz.tom === "a" ? "var(--pm-am)" : "var(--pm-t3)" }}>
          {c.prazo ? (pz.txt === "venceu" ? `venceu · ${diaHora(c.prazo)}` : `vence em ${pz.txt}`) : "sem prazo"}
        </span>
      </div>
    </button>
  );
}
