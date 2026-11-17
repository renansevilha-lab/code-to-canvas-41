// Aba "Notas de entrada" (16/nov/2026, pedido do dono): espelha as notas de entrada
// do Tiny (compras_nf_entrada), sem as milhares de notas de frete da Shopee e do
// Mercado Livre, de transportadora e de retorno do Full (ignorar = true, marcadas
// pelo sync e pelo gatilho trg_compras_nf_marca_frete). Essas ficam numa lista
// "ocultas", só para conferir. Lê view_compras_notas_entrada.
import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { Spinner } from "@/components/separacao/ui/kit";
import { Copiavel } from "@/components/devolucoes/Copiavel";
import { type NotaEntrada, type OrdemQuadro, SIT_NF, diaMes, fornecedorDe, hojeBRT, num, rotuloOrdem } from "./defs";
import { BotaoR, Busca, Pilulas, SeloR, cartaoR, mini, tnum } from "./pecas";

type Filtro = "todas" | "sem" | "ligadas" | "nao";
type Janela = "7" | "30" | "90" | "365";
const POR_PAGINA = 60;

const ROTULO_STATUS: Record<string, { nome: string; tom: "a" | "r" | "g" | "n" }> = {
  orcamento: { nome: "orçamento", tom: "n" },
  aguardando: { nome: "aguardando", tom: "a" },
  conferencia: { nome: "conferindo", tom: "a" },
  divergente: { nome: "divergência", tom: "r" },
  concluida: { nome: "recebida", tom: "g" },
  excluida: { nome: "ordem excluída", tom: "n" },
};

function desde(dias: number): string {
  const d = new Date(`${hojeBRT()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

const semZeros = (n: string | null) => (n ?? "").replace(/^0+/, "") || "—";

export function NotasEntrada({ ordens, autor, onAbrirOrdem, onDarEntrada }: {
  ordens: OrdemQuadro[];
  autor: string | null;
  onAbrirOrdem: (tinyId: number) => void;
  onDarEntrada: () => void;
}) {
  const qc = useQueryClient();
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [janela, setJanela] = useState<Janela>("30");
  const [busca, setBusca] = useState("");
  const [ocultas, setOcultas] = useState(false);
  const [aberta, setAberta] = useState<number | null>(null);
  const [ligando, setLigando] = useState<number | null>(null);
  const [limite, setLimite] = useState(POR_PAGINA);

  const de = desde(Number(janela));

  // Notas válidas da janela (poucas dezenas por mês) — filtro e busca no navegador.
  const notasQ = useQuery({
    queryKey: ["compras", "notas", de],
    queryFn: async (): Promise<NotaEntrada[]> => {
      const out: NotaEntrada[] = [];
      for (let ini = 0; ; ini += 1000) {
        const { data, error } = await supabaseExternal
          .from("view_compras_notas_entrada").select("*")
          .or("ignorar.eq.false,nao_compra_em.not.is.null")
          .gte("data_emissao", de)
          .order("data_emissao", { ascending: false }).order("tiny_id", { ascending: false })
          .range(ini, ini + 999);
        if (error) throw error;
        out.push(...((data ?? []) as NotaEntrada[]));
        if (!data || data.length < 1000) break;
      }
      return out;
    },
  });

  // Ocultas (frete, transportadora, retorno do Full): só a contagem, e a lista quando pedida.
  const ocultasNQ = useQuery({
    queryKey: ["compras", "notas-ocultas-n"],
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabaseExternal
        .from("compras_nf_entrada").select("tiny_id", { count: "exact", head: true })
        .eq("ignorar", true).is("nao_compra_em", null);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const ocultasQ = useQuery({
    queryKey: ["compras", "notas-ocultas", busca.trim()],
    enabled: ocultas,
    queryFn: async () => {
      let q = supabaseExternal.from("compras_nf_entrada")
        .select("tiny_id, numero, data_emissao, fornecedor_nome, valor")
        .eq("ignorar", true).is("nao_compra_em", null)
        .order("data_emissao", { ascending: false }).limit(100);
      const b = busca.trim();
      if (b) q = /^\d+$/.test(b) ? q.ilike("numero", `%${b}%`) : q.ilike("fornecedor_nome", `%${b}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Array<{ tiny_id: number; numero: string | null; data_emissao: string | null; fornecedor_nome: string | null; valor: number | null }>;
    },
  });

  const itensQ = useQuery({
    queryKey: ["compras", "nota-itens", aberta],
    enabled: aberta != null,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("compras_nf_itens")
        .select("id_item, sku, descricao, quantidade, valor_unitario, valor_total")
        .eq("nf_tiny_id", aberta as number).order("valor_total", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Array<{ id_item: number; sku: string | null; descricao: string | null; quantidade: number; valor_unitario: number | null; valor_total: number | null }>;
    },
  });

  const todas = useMemo(() => notasQ.data ?? [], [notasQ.data]);
  const cont = useMemo(() => ({
    todas: todas.filter((n) => !n.nao_compra_em).length,
    sem: todas.filter((n) => !n.nao_compra_em && !n.ordem_tiny_id).length,
    ligadas: todas.filter((n) => !n.nao_compra_em && !!n.ordem_tiny_id).length,
    nao: todas.filter((n) => !!n.nao_compra_em).length,
  }), [todas]);

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return todas.filter((n) => {
      if (filtro === "nao" ? !n.nao_compra_em : !!n.nao_compra_em) return false;
      if (filtro === "sem" && n.ordem_tiny_id) return false;
      if (filtro === "ligadas" && !n.ordem_tiny_id) return false;
      if (!q) return true;
      return `${n.numero ?? ""} ${n.fornecedor_nome ?? ""} ${n.chave_acesso ?? ""} ${n.ordem_numero ?? ""}`.toLowerCase().includes(q);
    });
  }, [todas, filtro, busca]);
  const valorLista = lista.reduce((s, n) => s + num(n.valor), 0);

  const recarregar = () => { void qc.invalidateQueries({ queryKey: ["compras", "notas"] }); void qc.invalidateQueries({ queryKey: ["compras", "quadro"] }); };

  async function marcarNaoCompra(n: NotaEntrada, marcar: boolean) {
    const { error } = await supabaseExternal.from("compras_nf_entrada").update(
      marcar ? { ignorar: true, nao_compra_em: new Date().toISOString(), nao_compra_por: autor }
        : { ignorar: false, nao_compra_em: null, nao_compra_por: null },
    ).eq("tiny_id", n.tiny_id);
    if (error) { toast.error("Não consegui salvar", { description: error.message }); return; }
    toast.success(marcar ? `Nota ${semZeros(n.numero)} tirada da lista (não é compra)` : `Nota ${semZeros(n.numero)} voltou para a lista`);
    recarregar();
  }

  async function ligar(n: NotaEntrada, ordemId: number | null) {
    const { error } = await supabaseExternal.from("compras_nf_entrada").update(
      ordemId == null
        ? { ordem_tiny_id: null, match_metodo: null, match_score: null, conciliado_por: autor, conciliado_em: new Date().toISOString() }
        : { ordem_tiny_id: ordemId, match_metodo: "manual", match_score: null, conciliado_por: autor, conciliado_em: new Date().toISOString() },
    ).eq("tiny_id", n.tiny_id);
    if (error) { toast.error("Não consegui ligar a nota", { description: error.message }); return; }
    setLigando(null);
    toast.success(ordemId == null ? "Nota desligada da ordem" : "Nota ligada à ordem", {
      description: ordemId == null ? undefined : "Abra a ordem e use “Aplicar à conferência” para a nota valer na contagem.",
    });
    recarregar();
  }

  // Ordens candidatas para ligar: mesmo fornecedor primeiro, depois as em aberto.
  function candidatas(n: NotaEntrada): OrdemQuadro[] {
    const chave = (s: string | null) => (s ?? "").trim().toUpperCase().slice(0, 10);
    const vivas = ordens.filter((o) => o.kanban_status !== "excluida");
    const mesmo = vivas.filter((o) => (n.fornecedor_id && o.fornecedor_id === n.fornecedor_id) || (chave(o.fornecedor_nome) && chave(o.fornecedor_nome) === chave(n.fornecedor_nome)));
    const abertas = vivas.filter((o) => o.kanban_status !== "concluida" && !mesmo.includes(o));
    return [...mesmo, ...abertas].slice(0, 40);
  }

  const cab: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--pm-t3)", textAlign: "left", padding: "10px 14px", borderBottom: "1px solid var(--pm-b)", whiteSpace: "nowrap" };
  const cel: React.CSSProperties = { padding: "11px 14px", borderBottom: "1px solid var(--pm-b)", verticalAlign: "middle" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <section style={cartaoR}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--pm-b)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Notas de entrada</span>
          <span style={{ fontWeight: 700, background: "var(--pm-s2)", borderRadius: 999, padding: "1px 9px", fontSize: 12, ...tnum }}>{lista.length}</span>
          <span style={{ ...mini, flex: 1 }}>As mesmas notas de entrada do Tiny · {formatBRL(valorLista)} nesta lista</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--pm-b)", flexWrap: "wrap" }}>
          <Pilulas<Filtro> valor={filtro} onValor={(v) => { setFiltro(v); setLimite(POR_PAGINA); }} ops={[
            { id: "todas", nome: `Todas ${cont.todas}` }, { id: "sem", nome: `Sem ordem ${cont.sem}` },
            { id: "ligadas", nome: `Ligadas a ordem ${cont.ligadas}` }, { id: "nao", nome: `Não é compra ${cont.nao}` },
          ]} />
          <Pilulas<Janela> valor={janela} onValor={(v) => { setJanela(v); setLimite(POR_PAGINA); }} ops={[
            { id: "7", nome: "7 dias" }, { id: "30", nome: "30 dias" }, { id: "90", nome: "90 dias" }, { id: "365", nome: "12 meses" },
          ]} />
          <Busca valor={busca} onValor={setBusca} placeholder="Fornecedor, número ou chave" largura={300} />
          <BotaoR pequeno onClick={() => setOcultas((v) => !v)} title="Notas de frete da Shopee e do Mercado Livre, de transportadora e de retorno do Full">
            Ocultas: {ocultasNQ.data != null ? formatNumber(ocultasNQ.data) : "…"} de frete e retorno {ocultas ? "▾" : "›"}
          </BotaoR>
        </div>

        {notasQ.isLoading ? (
          <div style={{ padding: 24, display: "flex", alignItems: "center", gap: 8, ...mini }}><Spinner /> Lendo as notas…</div>
        ) : notasQ.error ? (
          <div style={{ padding: 16, color: "var(--pm-r)" }}>Não consegui ler as notas: {(notasQ.error as Error).message}</div>
        ) : lista.length === 0 ? (
          <div style={{ padding: 24, ...mini }}>Nenhuma nota neste filtro.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940, fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...cab, width: 28 }} />
                  <th style={cab}>Emissão</th><th style={cab}>Nota</th><th style={cab}>Fornecedor</th>
                  <th style={{ ...cab, textAlign: "right" }}>Itens</th><th style={{ ...cab, textAlign: "right" }}>Valor</th>
                  <th style={cab}>No Tiny</th><th style={cab}>Ordem / entrada</th><th style={cab}>Etapa</th><th style={cab} />
                </tr>
              </thead>
              <tbody>
                {lista.slice(0, limite).map((n) => {
                  const sit = SIT_NF[n.situacao ?? ""] ?? { nome: n.situacao ? `situação ${n.situacao}` : "—", tom: "n" as const };
                  const st = n.kanban_status ? ROTULO_STATUS[n.kanban_status] : null;
                  const exp = aberta === n.tiny_id;
                  return (
                    <Fragment key={n.tiny_id}>
                      <tr className="pm-linha-hv" style={{ cursor: "pointer" }} onClick={() => setAberta(exp ? null : n.tiny_id)}>
                        <td style={cel}>{exp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td style={{ ...cel, ...tnum, whiteSpace: "nowrap" }}>{diaMes(n.data_emissao)}</td>
                        <td style={{ ...cel, whiteSpace: "nowrap" }}>
                          <Copiavel valor={semZeros(n.numero)} oQue="Número da nota"><b style={tnum}>{semZeros(n.numero)}</b></Copiavel>
                          {n.serie ? <span style={mini}> · série {n.serie}</span> : null}
                        </td>
                        <td style={{ ...cel, fontWeight: 500, overflowWrap: "anywhere" }}>{n.fornecedor_nome ?? "—"}</td>
                        <td style={{ ...cel, textAlign: "right", ...tnum }}>{n.itens_qtd ?? "—"}</td>
                        <td style={{ ...cel, textAlign: "right", ...tnum, whiteSpace: "nowrap" }}>{formatBRL(num(n.valor))}</td>
                        <td style={cel}><SeloR tom={sit.tom}>{sit.nome}</SeloR></td>
                        <td style={cel}>
                          {n.nao_compra_em ? <SeloR tom="n" title={n.nao_compra_por ? `marcada por ${n.nao_compra_por}` : undefined}>não é compra</SeloR>
                            : n.ordem_tiny_id ? <SeloR tom="z">{rotuloOrdem({ tiny_id: n.ordem_tiny_id, numero: n.ordem_numero })}</SeloR>
                              : <SeloR tom="a">sem ordem</SeloR>}
                        </td>
                        <td style={cel}>{st ? <SeloR tom={st.tom}>{st.nome}</SeloR> : <span style={mini}>—</span>}</td>
                        <td style={{ ...cel, textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                          {n.nao_compra_em ? (
                            <BotaoR pequeno onClick={() => void marcarNaoCompra(n, false)}>Voltar à lista</BotaoR>
                          ) : n.ordem_tiny_id ? (
                            <BotaoR pequeno onClick={() => onAbrirOrdem(n.ordem_tiny_id as number)}>Abrir ›</BotaoR>
                          ) : (
                            <BotaoR pequeno tom="primario" onClick={() => setLigando(ligando === n.tiny_id ? null : n.tiny_id)}>Ligar a uma ordem</BotaoR>
                          )}
                        </td>
                      </tr>
                      {(exp || ligando === n.tiny_id) && (
                        <tr>
                          <td colSpan={10} style={{ padding: "12px 16px 16px 44px", borderBottom: "1px solid var(--pm-b)", background: "var(--pm-s2)" }}>
                            {ligando === n.tiny_id && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: exp ? 14 : 0 }}>
                                <b>Ligar a nota {semZeros(n.numero)} a qual ordem?</b>
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                  {candidatas(n).map((o) => (
                                    <BotaoR key={o.tiny_id} pequeno onClick={() => void ligar(n, o.tiny_id)}>
                                      {rotuloOrdem(o)} · {fornecedorDe(o)} · {diaMes(o.data_pedido)}
                                    </BotaoR>
                                  ))}
                                  {candidatas(n).length === 0 && <span style={mini}>Nenhuma ordem em aberto para ligar.</span>}
                                </div>
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                                  <span style={mini}>Não tem ordem para esta nota?</span>
                                  <BotaoR pequeno onClick={onDarEntrada} title="Cria o recebimento a partir do arquivo XML desta nota">Dar entrada pelo XML</BotaoR>
                                  <BotaoR pequeno onClick={() => void marcarNaoCompra(n, true)} title="Tira da lista sem apagar (serviço, equipamento, despesa)">Não é compra</BotaoR>
                                </div>
                              </div>
                            )}
                            {exp && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", ...mini }}>
                                  {n.fornecedor_cnpj && <span>CNPJ <Copiavel valor={n.fornecedor_cnpj} oQue="CNPJ">{n.fornecedor_cnpj}</Copiavel></span>}
                                  {n.chave_acesso && <span>Chave <Copiavel valor={n.chave_acesso} oQue="Chave da nota">{n.chave_acesso}</Copiavel></span>}
                                  {num(n.valor_frete) > 0 && <span>Frete {formatBRL(num(n.valor_frete))}</span>}
                                </div>
                                {itensQ.isLoading ? <span style={mini}>Lendo os itens…</span>
                                  : (itensQ.data ?? []).length === 0 ? <span style={mini}>Os itens desta nota ainda não foram lidos do Tiny.</span>
                                    : (
                                      <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%", maxWidth: 820 }}>
                                        <tbody>
                                          {(itensQ.data ?? []).map((i) => (
                                            <tr key={i.id_item}>
                                              <td style={{ padding: "3px 10px 3px 0", ...tnum, color: "var(--pm-t3)", whiteSpace: "nowrap" }}>{i.sku || "sem SKU"}</td>
                                              <td style={{ padding: "3px 10px 3px 0" }}>{i.descricao}</td>
                                              <td style={{ padding: "3px 10px 3px 0", textAlign: "right", ...tnum, whiteSpace: "nowrap" }}>{formatNumber(num(i.quantidade))} × {formatBRL(num(i.valor_unitario))}</td>
                                              <td style={{ padding: "3px 0", textAlign: "right", ...tnum, fontWeight: 600, whiteSpace: "nowrap" }}>{formatBRL(num(i.valor_total))}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    )}
                                {!n.nao_compra_em && (
                                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    {n.ordem_tiny_id && !n.ligada_pelo_app && <BotaoR pequeno onClick={() => void ligar(n, null)}>Desligar da ordem</BotaoR>}
                                    {!n.ordem_tiny_id && ligando !== n.tiny_id && <BotaoR pequeno onClick={() => void marcarNaoCompra(n, true)}>Não é compra</BotaoR>}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {lista.length > limite && (
          <div style={{ padding: "10px 16px" }}><BotaoR pequeno onClick={() => setLimite((l) => l + POR_PAGINA)}>Ver mais ({lista.length - limite})</BotaoR></div>
        )}
      </section>

      {ocultas && (
        <section style={cartaoR}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--pm-b)" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Ocultas</span>
            <span style={{ ...mini, marginLeft: 10 }}>
              Frete da Shopee e do Mercado Livre, transportadoras e retorno do Full. As 100 mais recentes{busca.trim() ? " da busca" : ""}; use a busca acima para achar uma nota.
            </span>
          </div>
          {ocultasQ.isLoading ? <div style={{ padding: 16, ...mini }}>Lendo…</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 560 }}>
                <tbody>
                  {(ocultasQ.data ?? []).map((n) => (
                    <tr key={n.tiny_id}>
                      <td style={{ ...cel, padding: "7px 14px", ...tnum }}>{diaMes(n.data_emissao)}</td>
                      <td style={{ ...cel, padding: "7px 14px", ...tnum }}>{semZeros(n.numero)}</td>
                      <td style={{ ...cel, padding: "7px 14px" }}>{n.fornecedor_nome ?? "sem fornecedor"}</td>
                      <td style={{ ...cel, padding: "7px 14px", textAlign: "right", ...tnum }}>{formatBRL(num(n.valor))}</td>
                      <td style={{ ...cel, padding: "7px 14px", textAlign: "right" }}>
                        <BotaoR pequeno onClick={async () => {
                          const { error } = await supabaseExternal.from("compras_nf_entrada").update({ ignorar: false }).eq("tiny_id", n.tiny_id);
                          if (error) { toast.error("Não consegui mostrar a nota", { description: error.message }); return; }
                          toast.success(`Nota ${semZeros(n.numero)} voltou para a lista`);
                          void qc.invalidateQueries({ queryKey: ["compras"] });
                        }}>É compra: mostrar</BotaoR>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
