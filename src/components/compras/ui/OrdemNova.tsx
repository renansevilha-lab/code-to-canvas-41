// Dentro da ordem, no visual novo (16/nov/2026): cabeçalho fixo com a linha do tempo
// (data, hora e quem em cada etapa) e um botão principal; itens em linha contando na
// unidade em que a carga chega (fardo/caixa) com bipe por código de barras; lateral
// com próximos passos, nota, observações e apontamentos e o histórico do fornecedor.
// Só apresentação: a lógica e os diálogos (nota, estoque, contas, custo) são os da rota.
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ChevronLeft, MoreHorizontal } from "lucide-react";

import { formatBRL, formatNumber } from "@/lib/format";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MenuItens, Spinner } from "@/components/separacao/ui/kit";
import {
  type OrdemQuadro, conferida, diaMes, diasEntre, ehSugestao, etapaAtual, fornecedorDe, num, passosDe, rotuloOrdem,
} from "./defs";
import { Apontamentos } from "./Apontamentos";
import { BotaoR, FotoR, ParKV, Pilulas, Progresso, SeloR, Trilha, cartaoR, kicker, mini, tnum } from "./pecas";
import { imprimirOrdemCompra } from "./ordemCompraPdf";
import { toast } from "sonner";

export interface ItemTela {
  id: string;
  sku: string | null;
  descricao: string | null;
  gtin: string | null;
  quantidade: number;
  qtd_recebida: number;
  conferido: boolean;
  emb_tipo: string | null;
  emb_unidades: number | null;
  qtd_nf: number | null;
  so_na_nf: boolean;
}
export interface EmbTela { emb_tipo: string | null; emb_unidades: number | null }

export interface OrdemNovaProps {
  ordem: OrdemQuadro;
  itens: ItemTela[];
  fotos: Record<string, string>;
  embalagens: Record<string, EmbTela>;
  /** ordens do quadro, para o histórico do fornecedor */
  ordens: OrdemQuadro[];
  ehAdm: boolean;
  autor: string | null;
  salvandoFim: boolean;
  onVoltar: () => void;
  onQtd: (item: ItemTela, qtd: number) => void;
  onConcluir: () => void;
  onArquivar: () => void;
  onExcluir: () => void;
  onAplicarXml: () => void;
  onNfNumero: (v: string | null) => void;
  onFeitoNoTiny: (passo: "estoque" | "contas" | "custo") => void;
  onUsarAntigo: () => void;
  /** botões-diálogo que já existem (cada um abre o seu fluxo) */
  slotEstoque: ReactNode;
  slotContas: ReactNode;
  slotCusto: ReactNode;
  /** painéis que já existem */
  slotDivergencia: ReactNode;
  slotConciliacao: ReactNode;
  /** cartão completo do item (embalagem, pallet, modelo do SKU) — o de sempre */
  renderDetalhe: (item: ItemTela) => ReactNode;
}

type Filtro = "faltam" | "todos" | "dif";

const alvoDe = (i: ItemTela) => (i.qtd_nf != null ? num(i.qtd_nf) : num(i.quantidade));

export function OrdemNova(p: OrdemNovaProps) {
  const { ordem, itens } = p;
  const [filtro, setFiltro] = useState<Filtro>("faltam");
  const [abertos, setAbertos] = useState<Record<string, boolean>>({});
  const [bipe, setBipe] = useState("");
  const [bipeMsg, setBipeMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const bipeRef = useRef<HTMLInputElement>(null);

  const ped = itens.reduce((s, i) => s + alvoDe(i), 0);
  const rec = itens.reduce((s, i) => s + num(i.qtd_recebida), 0);
  const completo = ped > 0 && itens.every((i) => num(i.qtd_recebida) === alvoDe(i));
  const pelaNf = itens.some((i) => i.qtd_nf != null);
  const jaConferida = conferida(ordem);
  const passos = passosDe({ ...ordem, ped, rec });

  const embDe = (i: ItemTela): { un: number; tipo: string } | null => {
    const lemb = i.sku ? p.embalagens[i.sku] : undefined;
    const un = num(i.emb_unidades ?? lemb?.emb_unidades);
    const tipo = i.emb_tipo ?? lemb?.emb_tipo ?? null;
    if (un > 1 && tipo !== "unidade") return { un, tipo: tipo === "fardo" ? "fardo" : "caixa" };
    return null;
  };

  const cont = {
    faltam: itens.filter((i) => num(i.qtd_recebida) !== alvoDe(i)).length,
    todos: itens.length,
    dif: itens.filter((i) => (num(i.qtd_recebida) > 0 && num(i.qtd_recebida) !== alvoDe(i)) || i.so_na_nf || (i.qtd_nf != null && num(i.qtd_nf) !== num(i.quantidade))).length,
  };
  // Mantém na tela o item recém-contado mesmo que ele saia do filtro "Faltam".
  const [fixos, setFixos] = useState<Record<string, boolean>>({});
  const visiveis = useMemo(() => {
    const filtrados = itens.filter((i) => {
      if (filtro === "todos" || fixos[i.id]) return true;
      const r = num(i.qtd_recebida), a = alvoDe(i);
      if (filtro === "faltam") return r !== a;
      return (r > 0 && r !== a) || i.so_na_nf || (i.qtd_nf != null && num(i.qtd_nf) !== num(i.quantidade));
    });
    return filtrados;
  }, [itens, filtro, fixos]);

  const contar = (i: ItemTela, qtd: number) => { setFixos((f) => ({ ...f, [i.id]: true })); p.onQtd(i, Math.max(0, qtd)); };

  function bipar() {
    const cod = bipe.trim();
    if (!cod) return;
    const item = itens.find((i) => (i.gtin && i.gtin.trim() === cod) || (i.sku && i.sku.trim() === cod));
    setBipe("");
    if (!item) { setBipeMsg({ ok: false, t: `Código ${cod} não está nesta ordem` }); return; }
    const e = embDe(item);
    const soma = e ? e.un : 1;
    contar(item, num(item.qtd_recebida) + soma);
    setBipeMsg({ ok: true, t: `+${soma} un · ${item.descricao ?? item.sku}` });
    bipeRef.current?.focus();
  }

  // ---- histórico do fornecedor (ordens já recebidas dele no quadro) ----
  const hist = useMemo(() => {
    const chave = (o: OrdemQuadro) => (o.fornecedor_id ? `id:${o.fornecedor_id}` : `n:${fornecedorDe(o).toUpperCase().slice(0, 12)}`);
    const meus = p.ordens.filter((o) => o.tiny_id !== ordem.tiny_id && chave(o) === chave(ordem) && o.kanban_status !== "excluida");
    const recebidas = meus.filter((o) => o.recebido_em && o.data_pedido && o.tiny_id > 0);
    const prazos = recebidas.map((o) => diasEntre(o.data_pedido as string, o.recebido_em as string)).filter((d) => d >= 0 && d < 200);
    const comPrev = recebidas.filter((o) => o.data_prevista);
    const noPrazo = comPrev.filter((o) => diasEntre(o.data_prevista as string, o.recebido_em as string) <= 0).length;
    return {
      n: meus.length,
      prazo: prazos.length ? Math.round(prazos.reduce((s, d) => s + d, 0) / prazos.length) : null,
      nPrazo: prazos.length,
      noPrazo, comPrev: comPrev.length,
      diverg: meus.filter((o) => o.kanban_status === "divergente" || o.divergencia_oc_nf).length,
    };
  }, [p.ordens, ordem]);

  const principal = !jaConferida
    ? { t: completo ? "Concluir conferência" : rec > 0 ? "Concluir com diferença" : "Concluir conferência", on: p.onConcluir }
    : null;

  const feitoBtn = (passo: "estoque" | "contas" | "custo") => (
    <BotaoR pequeno tom="fantasma" onClick={() => p.onFeitoNoTiny(passo)} title="Marca este passo como já feito direto no Tiny, sem lançar nada">Já fiz no Tiny</BotaoR>
  );
  const linhaPasso = (nome: string, em: string | null, por: string | null) =>
    em ? <span><SeloR tom="g">feito {diaMes(em)}</SeloR>{por ? <span style={mini}> {por}</span> : null}</span> : <SeloR tom="n">pendente</SeloR>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* cabeçalho fixo */}
      <section style={{ ...cartaoR, padding: "14px 16px", position: "sticky", top: 69, zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <BotaoR pequeno onClick={p.onVoltar}><ChevronLeft size={13} /> Quadro</BotaoR>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{rotuloOrdem(ordem)} · {fornecedorDe(ordem)}</span>
              {ordem.tiny_id < 0 && <SeloR tom="z">{ehSugestao(ordem) ? "sugestão de compra" : "entrada por nota"}</SeloR>}
              {ordem.kanban_status === "divergente" && <SeloR tom="r">divergência</SeloR>}
              {ordem.kanban_status === "orcamento" && <SeloR tom="n">orçamento</SeloR>}
            </div>
            <div style={mini}>
              pedido {diaMes(ordem.data_pedido)}
              {ordem.data_prevista ? ` · previsto ${diaMes(ordem.data_prevista)}` : ""}
              {ordem.nf_numero ? ` · nota ${ordem.nf_numero.length > 12 ? `…${ordem.nf_numero.slice(-9)}` : ordem.nf_numero}` : ""}
              {` · ${itens.length} ${itens.length === 1 ? "produto" : "produtos"}`}
              {p.ehAdm && num(ordem.total_pedido) > 0 ? ` · ${formatBRL(num(ordem.total_pedido))}` : ""}
            </div>
          </div>
          <div style={{ minWidth: 170 }}>
            <div style={mini}>Conferido{pelaNf ? " (pela nota)" : ""}</div>
            <b style={tnum}>{formatNumber(rec)} / {formatNumber(ped)} un</b>
            <Progresso feito={rec} total={ped} cor={rec > ped ? "var(--pm-am)" : undefined} />
          </div>
          {principal && (
            <BotaoR tom="primario" onClick={principal.on} disabled={p.salvandoFim || itens.length === 0}>
              {p.salvandoFim && <Spinner size={13} />} {principal.t}
            </BotaoR>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Mais ações" className="pm-hv"
                style={{ border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", borderRadius: 999, padding: "6px 11px", cursor: "pointer", display: "inline-flex" }}>
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenuTrigger>
            <MenuItens itens={[
              { t: "Imprimir PDF", sub: "Ordem no modelo Bumi, para o fornecedor",
                onClick: () => void imprimirOrdemCompra(ordem.tiny_id).catch((e) => toast.error("Não deu para gerar o PDF", { description: (e as Error).message })) },
              { t: "Arquivar", sub: "Tira do quadro; nada muda no Tiny", onClick: p.onArquivar },
              ...(p.ehAdm ? [{ t: "Excluir do app", sub: "Não exclui no Tiny", onClick: p.onExcluir, perigo: true }] : []),
              { t: "Usar o visual antigo", onClick: p.onUsarAntigo },
            ]} />
          </DropdownMenu>
        </div>
        <div style={{ marginTop: 14 }}><Trilha passos={passos} detalhe /></div>
      </section>

      {p.slotDivergencia}

      <div className="cp-duas" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 330px", gap: 14, alignItems: "start" }}>
        {/* itens */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <section style={cartaoR}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--pm-b)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Itens</span>
              <Pilulas<Filtro> valor={filtro} onValor={(v) => { setFiltro(v); setFixos({}); }} ops={[
                { id: "faltam", nome: `Faltam ${cont.faltam}` }, { id: "todos", nome: `Todos ${cont.todos}` }, { id: "dif", nome: `Com diferença ${cont.dif}` },
              ]} />
              <div style={{ flex: "1 1 220px", maxWidth: 360, display: "flex", flexDirection: "column", gap: 2 }}>
                <input ref={bipeRef} value={bipe} onChange={(e) => setBipe(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") bipar(); }}
                  placeholder="Bipe o código de barras para contar" aria-label="Bipar código de barras"
                  style={{ border: "1px solid var(--pm-bc)", borderRadius: 999, padding: "8px 14px", background: "var(--pm-s)", color: "var(--pm-t)", fontFamily: "inherit", fontSize: 13, width: "100%" }} />
                {bipeMsg && <span style={{ fontSize: 11.5, color: bipeMsg.ok ? "var(--pm-g)" : "var(--pm-r)", paddingLeft: 14 }}>{bipeMsg.t}</span>}
              </div>
            </div>

            {itens.length === 0 && (
              <div style={{ padding: 24, ...mini }}>Itens ainda não sincronizados. Use “Atualizar do Tiny” no quadro.</div>
            )}
            {itens.length > 0 && visiveis.length === 0 && (
              <div style={{ padding: 24, color: "var(--pm-g)", fontWeight: 500 }}>
                {filtro === "faltam" ? "Tudo contado. Nenhum item faltando." : "Nenhum item com diferença."}
              </div>
            )}

            {visiveis.map((i, idx) => {
              const alvo = alvoDe(i), r = num(i.qtd_recebida);
              const e = embDe(i);
              const emPacote = e ? r / e.un : r;
              const pacTxt = Number.isInteger(emPacote) ? String(emPacote) : emPacote.toFixed(2).replace(".", ",");
              const nfDifere = i.qtd_nf != null && num(i.qtd_nf) !== num(i.quantidade);
              const aberto = !!abertos[i.id];
              return (
                <div key={i.id} style={{ borderBottom: idx === visiveis.length - 1 ? undefined : "1px solid var(--pm-b)" }}>
                  <div className="cp-item" style={{ display: "grid", gridTemplateColumns: "46px minmax(200px,1.6fr) minmax(150px,.9fr) auto minmax(150px,auto)", gap: 14, alignItems: "center", padding: "12px 16px" }}>
                    <FotoR url={i.sku ? p.fotos[i.sku] : undefined} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{i.descricao ?? "Sem descrição"}</div>
                      <div style={mini}>
                        {i.sku ? `SKU ${i.sku}` : "sem SKU"}{i.gtin ? ` · EAN ${i.gtin}` : ""}{e ? ` · ${e.tipo} de ${e.un}` : ""}
                      </div>
                      {(i.so_na_nf || nfDifere) && (
                        <div style={{ marginTop: 2 }}>
                          <SeloR tom={i.so_na_nf ? "z" : "a"}>
                            {i.so_na_nf ? "só na nota, não está na ordem"
                              : num(i.qtd_nf) === 0 ? `não veio na nota · ordem ${formatNumber(num(i.quantidade))} un`
                                : `ordem ${formatNumber(num(i.quantidade))} · nota ${formatNumber(num(i.qtd_nf))} un`}
                          </SeloR>
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={mini}>Esperado{i.qtd_nf != null ? " pela nota" : ""}</div>
                      <b style={tnum}>{formatNumber(alvo)} un</b>
                      {e && <span style={mini}> = {formatNumber(alvo / e.un, Number.isInteger(alvo / e.un) ? 0 : 1)} {e.tipo}{alvo / e.un === 1 ? "" : "s"}</span>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                      <Contador valor={pacTxt} rotulo={e ? `${e.tipo}s contados` : "unidades contadas"}
                        onMenos={() => contar(i, r - (e ? e.un : 1))} onMais={() => contar(i, r + (e ? e.un : 1))}
                        onDigitado={(n) => contar(i, Math.round(n * (e ? e.un : 1)))} />
                      <span style={mini}>{e ? `${e.tipo}s · ${formatNumber(r)} un` : "unidades"}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
                      {r === alvo && i.conferido ? <SeloR tom="g">completo</SeloR>
                        : r > alvo ? <SeloR tom="r">+{formatNumber(r - alvo)} un</SeloR>
                          : r > 0 ? <SeloR tom="a">faltam {formatNumber(alvo - r)}</SeloR> : null}
                      {r !== alvo && <BotaoR pequeno onClick={() => contar(i, alvo)}>Veio tudo</BotaoR>}
                      <BotaoR pequeno tom="fantasma" onClick={() => setAbertos((a) => ({ ...a, [i.id]: !aberto }))}
                        title="Encaixotamento, pallet e contagem por unidade">{aberto ? "Fechar" : "Embalagem"}</BotaoR>
                    </div>
                  </div>
                  {aberto && <div style={{ padding: "0 16px 14px" }}>{p.renderDetalhe(i)}</div>}
                </div>
              );
            })}
          </section>

          {p.slotConciliacao}
        </div>

        {/* lateral */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <section style={{ ...cartaoR, padding: "14px 16px" }}>
            <div style={{ ...kicker, marginBottom: 6 }}>Próximos passos</div>
            <ParKV k="Estoque no Tiny" v={linhaPasso("estoque", ordem.estoque_lancado_em, ordem.estoque_lancado_por)} />
            <ParKV k="Contas a pagar" v={linhaPasso("contas", ordem.contas_lancadas_em, ordem.contas_lancadas_por)} />
            <ParKV k="Custo do produto" v={linhaPasso("custo", ordem.custo_em, ordem.custo_por)} ultimo />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{p.slotEstoque}{!ordem.estoque_lancado_em && feitoBtn("estoque")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{p.slotContas}{!ordem.contas_lancadas_em && feitoBtn("contas")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>{p.slotCusto}{!ordem.custo_em && feitoBtn("custo")}</div>
            </div>
          </section>

          <section style={{ ...cartaoR, padding: "14px 16px" }}>
            <div style={{ ...kicker, marginBottom: 6 }}>Nota fiscal</div>
            <NfNumero valor={ordem.nf_numero} onCommit={p.onNfNumero} />
            {ordem.nf_em && <div style={{ ...mini, marginTop: 4 }}>nota aplicada em {diaMes(ordem.nf_em)}</div>}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <BotaoR pequeno onClick={p.onAplicarXml} disabled={itens.length === 0} title="Lê o XML da nota do fornecedor e aplica à conferência">Aplicar nota pelo XML</BotaoR>
            </div>
          </section>

          <Apontamentos ordemTinyId={ordem.tiny_id} autor={p.autor} etapa={etapaAtual({ ...ordem, ped, rec })}
            antiga={ordem.observacao_recebimento} podeApagar={p.ehAdm} />

          <section style={{ ...cartaoR, padding: "14px 16px" }}>
            <div style={{ ...kicker, marginBottom: 6 }}>Fornecedor</div>
            {hist.n === 0 ? <span style={mini}>Primeira ordem deste fornecedor no quadro.</span> : (
              <>
                <ParKV k="Prazo real de entrega" v={hist.prazo != null ? `${hist.prazo} ${hist.prazo === 1 ? "dia" : "dias"} (${hist.nPrazo} ${hist.nPrazo === 1 ? "ordem" : "ordens"})` : "sem registro"} />
                <ParKV k="Entregas no prazo" v={hist.comPrev ? `${hist.noPrazo} de ${hist.comPrev}` : "sem previsão informada"} />
                <ParKV k="Ordens com divergência" v={`${hist.diverg} de ${hist.n}`} ultimo />
              </>
            )}
          </section>
        </div>
      </div>
      <style>{`
        @media (max-width: 1000px){ .pm-ui .cp-duas { grid-template-columns: 1fr !important; } }
        @media (max-width: 900px){ .pm-ui .cp-item { grid-template-columns: 46px 1fr !important; } }
      `}</style>
    </div>
  );
}

function Contador({ valor, rotulo, onMenos, onMais, onDigitado }: {
  valor: string; rotulo: string; onMenos: () => void; onMais: () => void; onDigitado: (n: number) => void;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = (v: string) => {
    setTxt(null);
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) onDigitado(n);
  };
  const bt: React.CSSProperties = { border: 0, background: "transparent", color: "var(--pm-t)", fontFamily: "inherit", fontSize: 16, fontWeight: 600, width: 36, height: 36, cursor: "pointer" };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--pm-bc)", borderRadius: 999, overflow: "hidden", background: "var(--pm-s)" }}>
      <button type="button" className="pm-hv" style={bt} onClick={onMenos} aria-label="menos">−</button>
      <input value={txt ?? valor} aria-label={rotulo} inputMode="decimal"
        onChange={(e) => setTxt(e.target.value)} onFocus={(e) => e.target.select()}
        onBlur={(e) => { if (txt != null) commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{ width: 68, border: 0, background: "transparent", color: "var(--pm-t)", fontFamily: "inherit", fontSize: 14, fontWeight: 700, textAlign: "center", ...tnum }} />
      <button type="button" className="pm-hv" style={bt} onClick={onMais} aria-label="mais">+</button>
    </div>
  );
}

function NfNumero({ valor, onCommit }: { valor: string | null; onCommit: (v: string | null) => void }) {
  const [txt, setTxt] = useState<string | null>(null);
  return (
    <input value={txt ?? valor ?? ""} placeholder="Número ou chave da nota" aria-label="Número ou chave da nota"
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => { if (txt != null && txt.trim() !== (valor ?? "")) onCommit(txt.trim() || null); setTxt(null); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      style={{ width: "100%", border: "1px solid var(--pm-bc)", borderRadius: 999, padding: "7px 13px", background: "var(--pm-s)", color: "var(--pm-t)", fontFamily: "inherit", fontSize: 13 }} />
  );
}
