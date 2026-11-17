// Rascunho de ordem de compra criado por uma sugestão aprovada (Claude → compra_sugestao_aprovar).
// Vive só no app (tiny_id negativo, numero 'SUG-<id>', kanban 'orcamento') e é editável aqui:
// quantidade, preço, itens, previsão e observações. Ainda não vai ao Tiny (fase seguinte: "Enviar ao Tiny").
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatNumber } from "@/lib/format";
import { usePerfil } from "@/hooks/usePerfil";
import { confirmarSep } from "@/components/separacao/ui/dialogos";
import { diaMes, fornecedorDe, num, rotuloOrdem } from "./defs";
import { BotaoR, ParKV, SeloR, cartaoR, kicker, mini, tnum } from "./pecas";

export const CATEGORIA_SUGESTAO = "Sugestão de compra (app)";
/** Ordem criada por sugestão que ainda é rascunho (editável). */
export const ehRascunhoSugestao = (o: { tiny_id: number; numero: string | null; kanban_status: string } | null | undefined): boolean =>
  !!o && o.tiny_id < 0 && (o.numero ?? "").startsWith("SUG-") && o.kanban_status === "orcamento";

interface OrdemR {
  tiny_id: number; numero: string | null; data_pedido: string | null; data_prevista: string | null;
  fornecedor_nome: string | null; fornecedor_fantasia: string | null; total_pedido: number | null;
  observacoes: string | null; observacao_recebimento: string | null; kanban_status: string;
}
interface ItemR { id: string; sku: string | null; descricao: string | null; gtin: string | null; quantidade: number; preco: number | null; tiny_produto_id: number | null }
interface CalcR {
  sku: string; venda_dia: number; disponivel: number; cobertura_atual_dias: number | null; sugestao: number; multiplo_compra: number;
  preco_origem: string | null; alerta: string | null;
}
interface SugestaoR { id: number; criado_em: string; criado_por: string | null; parametros: Record<string, unknown>; itens: CalcR[] }
interface ProdutoR { sku: string; nome: string | null; gtin: string | null; id_tiny: number | string | null; custo: number | null; fornecedor: string | null }

const txt = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));
const lerNum = (s: string): number | null => {
  const t = s.trim().replace(/\./g, "").replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const campo: React.CSSProperties = {
  height: 30, padding: "0 8px", border: "1px solid var(--pm-bc)", borderRadius: 8, background: "var(--pm-s)", color: "var(--pm-t)",
  font: "inherit", fontSize: 13, textAlign: "right", fontVariantNumeric: "tabular-nums", width: 92,
};

export function RascunhoCompra({ tinyId, onVoltar }: { tinyId: number; onVoltar: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [busca, setBusca] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const ordemQ = useQuery({
    queryKey: ["compras", "rascunho", tinyId],
    queryFn: async (): Promise<OrdemR | null> => {
      const { data, error } = await supabaseExternal.from("compras_ordens").select("*").eq("tiny_id", tinyId).maybeSingle();
      if (error) throw error;
      return (data ?? null) as OrdemR | null;
    },
  });
  const itensQ = useQuery({
    queryKey: ["compras", "rascunho-itens", tinyId],
    queryFn: async (): Promise<ItemR[]> => {
      const { data, error } = await supabaseExternal.from("compra_ordem_itens").select("*").eq("ordem_tiny_id", tinyId).order("descricao");
      if (error) throw error;
      return (data ?? []) as ItemR[];
    },
  });
  const sugQ = useQuery({
    queryKey: ["compras", "rascunho-sugestao", tinyId],
    queryFn: async (): Promise<SugestaoR | null> => {
      const { data, error } = await supabaseExternal.from("compras_sugestoes").select("id, criado_em, criado_por, parametros, itens").eq("ordem_tiny_id", tinyId).maybeSingle();
      if (error) throw error;
      return (data ?? null) as SugestaoR | null;
    },
  });
  const buscaQ = useQuery({
    queryKey: ["compras", "rascunho-busca", busca.trim()],
    enabled: busca.trim().length >= 3,
    queryFn: async (): Promise<ProdutoR[]> => {
      const t = busca.trim().replace(/[%,()]/g, " ");
      const { data, error } = await supabaseExternal.from("produtos").select("sku, nome, gtin, id_tiny, custo, fornecedor")
        .or(`sku.eq.${t},nome.ilike.%${t}%`).neq("tipo", "K").limit(8);
      if (error) throw error;
      return (data ?? []) as ProdutoR[];
    },
  });

  const ordem = ordemQ.data;
  const itens = useMemo(() => itensQ.data ?? [], [itensQ.data]);
  const calc = useMemo(() => new Map((sugQ.data?.itens ?? []).map((c) => [c.sku, c])), [sugQ.data]);
  const total = itens.reduce((s, i) => s + num(i.quantidade) * num(i.preco), 0);
  const unidades = itens.reduce((s, i) => s + num(i.quantidade), 0);

  async function gravarTotais(lista: ItemR[]) {
    const t = lista.reduce((s, i) => s + num(i.quantidade) * num(i.preco), 0);
    const u = lista.reduce((s, i) => s + num(i.quantidade), 0);
    const { error } = await supabaseExternal.from("compras_ordens")
      .update({ total_produtos: Math.round(t * 100) / 100, total_pedido: Math.round(t * 100) / 100, itens_qtd: u, atualizado_em: new Date().toISOString() })
      .eq("tiny_id", tinyId);
    if (error) toast.error("Falha ao gravar o total", { description: error.message });
    void qc.invalidateQueries({ queryKey: ["compras", "quadro"] });
  }

  async function salvarItem(item: ItemR, patch: Partial<Pick<ItemR, "quantidade" | "preco">>) {
    const novos = itens.map((i) => (i.id === item.id ? { ...i, ...patch } : i));
    qc.setQueryData<ItemR[]>(["compras", "rascunho-itens", tinyId], novos);
    const { error } = await supabaseExternal.from("compra_ordem_itens").update({ ...patch, atualizado_em: new Date().toISOString() }).eq("id", item.id);
    if (error) { toast.error("Falha ao salvar o item", { description: error.message }); void itensQ.refetch(); return; }
    await gravarTotais(novos);
  }

  async function removerItem(item: ItemR) {
    const ok = await confirmarSep({ kicker: item.sku ?? "item", titulo: "Tirar este produto do rascunho?", resumo: item.descricao ?? "", okTxt: "Tirar" });
    if (!ok) return;
    const { error } = await supabaseExternal.from("compra_ordem_itens").delete().eq("id", item.id);
    if (error) { toast.error("Falha ao tirar o item", { description: error.message }); return; }
    const novos = itens.filter((i) => i.id !== item.id);
    qc.setQueryData<ItemR[]>(["compras", "rascunho-itens", tinyId], novos);
    await gravarTotais(novos);
  }

  async function adicionar(p: ProdutoR) {
    if (itens.some((i) => i.sku === p.sku)) { toast.info(`${p.sku} já está no rascunho`); return; }
    const idTiny = p.id_tiny == null || p.id_tiny === "" ? null : Number(p.id_tiny);
    const { data, error } = await supabaseExternal.from("compra_ordem_itens")
      .insert({ ordem_tiny_id: tinyId, tiny_produto_id: Number.isFinite(idTiny) ? idTiny : null, sku: p.sku, descricao: p.nome, gtin: p.gtin, quantidade: 0, preco: num(p.custo) })
      .select("*").single();
    if (error) { toast.error("Falha ao incluir o produto", { description: error.message }); return; }
    setBusca("");
    const novos = [...itens, data as ItemR];
    qc.setQueryData<ItemR[]>(["compras", "rascunho-itens", tinyId], novos);
    await gravarTotais(novos);
  }

  async function salvarOrdem(patch: Partial<OrdemR>) {
    qc.setQueryData<OrdemR | null>(["compras", "rascunho", tinyId], (o) => (o ? { ...o, ...patch } : o));
    const { error } = await supabaseExternal.from("compras_ordens").update(patch).eq("tiny_id", tinyId);
    if (error) toast.error("Falha ao salvar", { description: error.message });
  }

  // Sai do quadro (exclusão lógica, como as outras ordens). "tiny" = a ordem foi digitada no Tiny e virá pelo sync.
  async function retirar(motivo: "descartar" | "tiny") {
    if (!ordem) return;
    const ok = await confirmarSep(motivo === "tiny"
      ? { kicker: rotuloOrdem(ordem), titulo: "Já lançou esta ordem no Tiny?", resumo: "O rascunho sai do quadro para não aparecer duas vezes: a ordem do Tiny chega sozinha na próxima sincronização (até 30 min).", okTxt: "Sim, tirar o rascunho" }
      : { kicker: rotuloOrdem(ordem), titulo: "Descartar este rascunho?", resumo: "Nada foi enviado ao Tiny. A sugestão continua no histórico.", okTxt: "Descartar" });
    if (!ok) return;
    setOcupado(true);
    const nota = motivo === "tiny" ? "Rascunho substituído pela ordem lançada no Tiny" : "Rascunho descartado";
    const { error } = await supabaseExternal.from("compras_ordens").update({
      kanban_status: "excluida", arquivada_em: new Date().toISOString(),
      observacao_recebimento: [ordem.observacao_recebimento?.trim(), `${nota}${perfil?.nome ? ` por ${perfil.nome}` : ""}`].filter(Boolean).join(" · "),
    }).eq("tiny_id", tinyId);
    setOcupado(false);
    if (error) { toast.error("Falha ao tirar o rascunho", { description: error.message }); return; }
    toast.success("Rascunho retirado do quadro");
    void qc.invalidateQueries({ queryKey: ["compras"] });
    onVoltar();
  }

  if (ordemQ.isLoading || itensQ.isLoading) return <div style={{ ...cartaoR, padding: 24, color: "var(--pm-t3)" }}>Carregando o rascunho…</div>;
  if (!ordem) return <div style={{ ...cartaoR, padding: 24 }}>Rascunho não encontrado. <BotaoR pequeno onClick={onVoltar}>Voltar</BotaoR></div>;

  const par = (sugQ.data?.parametros ?? {}) as Record<string, unknown>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <section style={{ ...cartaoR, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <BotaoR pequeno onClick={onVoltar}><ChevronLeft size={13} /> Quadro</BotaoR>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{rotuloOrdem(ordem)} · {fornecedorDe(ordem)}</span>
              <SeloR tom="z">rascunho · só no app</SeloR>
            </div>
            <div style={mini}>criado {diaMes(ordem.data_pedido)} · {itens.length} {itens.length === 1 ? "produto" : "produtos"} · {formatNumber(unidades)} un</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={mini}>Total do rascunho</div>
            <b style={{ fontSize: 18, ...tnum }}>{formatBRL(total)}</b>
          </div>
          <BotaoR tom="contorno" disabled={ocupado} onClick={() => void retirar("tiny")} title="Use depois de digitar esta ordem no Tiny, para ela não aparecer duas vezes">Já lancei no Tiny</BotaoR>
          <BotaoR tom="perigo" disabled={ocupado} onClick={() => void retirar("descartar")}>Descartar</BotaoR>
        </div>
        <div style={{ ...mini, marginTop: 10 }}>
          Este rascunho ainda <b>não está no Tiny</b>. Ajuste quantidades, preços e itens à vontade; o envio ao Tiny por aqui entra na próxima etapa.
        </div>
      </section>

      <div className="cp-duas" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 330px", gap: 14, alignItems: "start" }}>
        <section style={{ ...cartaoR, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "right", color: "var(--pm-t3)", fontSize: 11.5 }}>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 500 }}>Produto</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }} title="Venda por dia usada na sugestão">Venda/dia</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }} title="Disponível quando a sugestão foi gerada: galpão − reservado + Fulls + ordens aguardando">Disponível</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }}>Cobertura</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }}>Sugerido</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }}>Quantidade</th>
                  <th style={{ padding: "10px 8px", fontWeight: 500 }}>Preço un.</th>
                  <th style={{ padding: "10px 14px", fontWeight: 500 }}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <LinhaItem key={i.id} item={i} calc={i.sku ? calc.get(i.sku) : undefined}
                    onSalvar={(patch) => void salvarItem(i, patch)} onRemover={() => void removerItem(i)} />
                ))}
                {itens.length === 0 && <tr><td colSpan={9} style={{ padding: 22, textAlign: "center", color: "var(--pm-t3)" }}>Nenhum produto no rascunho. Inclua pelo campo abaixo.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ borderTop: "1px solid var(--pm-b)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Plus size={14} style={{ color: "var(--pm-t3)" }} />
              <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Incluir produto: SKU ou parte do nome (3 letras ou mais)"
                style={{ ...campo, textAlign: "left", width: "100%", maxWidth: 460 }} />
            </div>
            {busca.trim().length >= 3 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {buscaQ.isLoading && <span style={mini}>Procurando…</span>}
                {buscaQ.data?.length === 0 && <span style={mini}>Nenhum produto encontrado.</span>}
                {buscaQ.data?.map((p) => (
                  <button key={p.sku} type="button" className="pm-hv" onClick={() => void adicionar(p)}
                    style={{ textAlign: "left", border: "none", background: "transparent", color: "var(--pm-t)", padding: "5px 8px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 12.5 }}>
                    <b>{p.sku}</b> · {p.nome} <span style={mini}>· {p.fornecedor || "sem fornecedor"} · custo {formatBRL(num(p.custo))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <section style={{ ...cartaoR, padding: 14 }}>
            <div style={kicker}>Pedido</div>
            <ParKV k="Fornecedor" v={fornecedorDe(ordem)} />
            <ParKV k="Total" v={formatBRL(total)} />
            <ParKV k="Unidades" v={formatNumber(unidades)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "6px 0" }}>
              <span style={{ color: "var(--pm-t3)" }}>Previsão de chegada</span>
              <input type="date" value={ordem.data_prevista ?? ""} onChange={(e) => void salvarOrdem({ data_prevista: e.target.value || null })}
                style={{ ...campo, width: 150, textAlign: "left" }} />
            </div>
            <div style={{ ...mini, margin: "8px 0 4px" }}>Observações</div>
            <Observacoes valor={ordem.observacoes ?? ""} onSalvar={(v) => void salvarOrdem({ observacoes: v || null })} />
          </section>
          {sugQ.data && (
            <section style={{ ...cartaoR, padding: 14 }}>
              <div style={kicker}>Como foi calculado</div>
              <ParKV k="Sugestão" v={`nº ${sugQ.data.id} · ${diaMes(sugQ.data.criado_em)}`} />
              <ParKV k="Cobertura desejada" v={`${String(par.cobertura_dias ?? "—")} dias${par.somar_lead_time ? " + prazo do fornecedor" : ""}`} />
              <ParKV k="Vendas consideradas" v={`${String(par.periodo_dias ?? "—")} dias`} />
              <ParKV k="Venda/dia" v={par.metodo === "periodo" ? "média do período" : "maior entre período e histórico"} />
              {num(par.crescimento_pct) !== 0 && <ParKV k="Crescimento" v={`${num(par.crescimento_pct) > 0 ? "+" : ""}${String(par.crescimento_pct)}%`} />}
              <ParKV k="Fulls contam como estoque" v={par.contar_fulls === false ? "não" : "sim"} />
              <ParKV k="Gerada por" v={sugQ.data.criado_por ?? "—"} ultimo />
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function LinhaItem({ item, calc, onSalvar, onRemover }: {
  item: ItemR; calc?: CalcR; onSalvar: (patch: Partial<Pick<ItemR, "quantidade" | "preco">>) => void; onRemover: () => void;
}) {
  const [qtd, setQtd] = useState(txt(item.quantidade));
  const [preco, setPreco] = useState(txt(item.preco));
  useEffect(() => setQtd(txt(item.quantidade)), [item.quantidade]);
  useEffect(() => setPreco(txt(item.preco)), [item.preco]);
  const mult = calc?.multiplo_compra ?? 1;
  const foraDoMultiplo = mult > 1 && num(item.quantidade) % mult !== 0;
  const td: React.CSSProperties = { padding: "8px", textAlign: "right", borderTop: "1px solid var(--pm-b)", ...tnum };

  const sair = (qual: "quantidade" | "preco", s: string) => {
    const n = lerNum(s);
    if (n == null) { toast.error("Número inválido"); if (qual === "quantidade") setQtd(txt(item.quantidade)); else setPreco(txt(item.preco)); return; }
    if (n !== num(item[qual])) onSalvar({ [qual]: n });
  };
  const teclas = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };

  return (
    <tr>
      <td style={{ ...td, textAlign: "left", padding: "8px 14px", minWidth: 240 }}>
        <b>{item.sku ?? "—"}</b>
        <div style={{ fontSize: 12, color: "var(--pm-t2)" }}>{item.descricao}</div>
        {calc?.alerta && <div style={{ fontSize: 11.5, color: "var(--pm-am)" }}>{calc.alerta}</div>}
        {foraDoMultiplo && <div style={{ fontSize: 11.5, color: "var(--pm-am)" }}>fora do múltiplo de compra ({mult} un)</div>}
      </td>
      <td style={td}>{calc ? formatNumber(num(calc.venda_dia)) : "—"}</td>
      <td style={td}>{calc ? formatNumber(num(calc.disponivel)) : "—"}</td>
      <td style={td}>{calc?.cobertura_atual_dias != null ? `${formatNumber(num(calc.cobertura_atual_dias))} d` : "—"}</td>
      <td style={td}>{calc ? formatNumber(num(calc.sugestao)) : "—"}</td>
      <td style={td}><input inputMode="decimal" value={qtd} onChange={(e) => setQtd(e.target.value)} onBlur={(e) => sair("quantidade", e.target.value)} onKeyDown={teclas} aria-label={`Quantidade de ${item.sku}`} style={campo} /></td>
      <td style={td} title={calc?.preco_origem ?? undefined}><input inputMode="decimal" value={preco} onChange={(e) => setPreco(e.target.value)} onBlur={(e) => sair("preco", e.target.value)} onKeyDown={teclas} aria-label={`Preço de ${item.sku}`} style={campo} /></td>
      <td style={{ ...td, padding: "8px 14px", fontWeight: 600 }}>{formatBRL(num(item.quantidade) * num(item.preco))}</td>
      <td style={{ ...td, width: 34 }}>
        <button type="button" onClick={onRemover} aria-label={`Tirar ${item.sku}`} className="pm-hv"
          style={{ border: "none", background: "transparent", color: "var(--pm-t3)", cursor: "pointer", padding: 4, borderRadius: 6, display: "inline-flex" }}><Trash2 size={14} /></button>
      </td>
    </tr>
  );
}

function Observacoes({ valor, onSalvar }: { valor: string; onSalvar: (v: string) => void }) {
  const [v, setV] = useState(valor);
  useEffect(() => setV(valor), [valor]);
  return (
    <textarea value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== valor.trim()) onSalvar(v.trim()); }} rows={4}
      style={{ width: "100%", border: "1px solid var(--pm-bc)", borderRadius: 8, background: "var(--pm-s)", color: "var(--pm-t)", font: "inherit", fontSize: 12.5, padding: 8, resize: "vertical" }} />
  );
}
