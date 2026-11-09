// Preço por canal e margem de contribuição, piso (MC 0) e margem do preço praticado hoje.
// Tudo de preco_cenario_matriz (banco). "Por kg" só divide o que veio pelo peso do saco (apresentação).
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Botao, Campo, Cartao, Entrada, Selo, tabela, td, th } from "../ui";
import { brl, useFotos } from "@/lib/producao";
import { inserir, num, pct, rpc, useCanais, useCusto, useMatriz, useMargens, useTabelaAtacado, type Cenario, type LinhaMatriz } from "@/lib/custos";
import { abrirTabelaHtml } from "./tabelaHtml";

export function Precificacao({ cenario }: { cenario: Cenario }) {
  const matriz = useMatriz(cenario.id);
  const custo = useCusto(cenario.id);
  const margens = useMargens();
  const [porKg, setPorKg] = useState(false);
  const [busca, setBusca] = useState("");
  const [publicar, setPublicar] = useState(false);
  const linhas = matriz.data ?? [];
  const mcs = (margens.data ?? []).filter((m) => m.ativo).map((m) => Number(m.mc_pct));
  const peso = useMemo(() => Object.fromEntries((custo.data ?? []).map((c) => [c.sku, Number(c.peso_nominal_kg) || 1])), [custo.data]);
  const fotos = useFotos([...new Set(linhas.map((l) => l.sku))]);
  const porSku = useMemo(() => {
    const m = new Map<string, LinhaMatriz[]>();
    for (const l of linhas) { const a = m.get(l.sku) ?? []; a.push(l); m.set(l.sku, a); }
    const q = busca.trim().toLowerCase();
    return [...m.entries()].filter(([sku, ls]) => !q || sku.toLowerCase().includes(q) || (ls[0].nome ?? "").toLowerCase().includes(q));
  }, [linhas, busca]);

  if (matriz.isLoading) return <Cartao><span style={{ color: "var(--pm-t3)" }}>Calculando os preços…</span></Cartao>;
  if (matriz.error) return <Cartao><span style={{ color: "var(--pm-r)" }}>Não deu para calcular: {(matriz.error as Error).message}</span></Cartao>;

  const f = (sku: string, v: number | null | undefined) => (v == null ? null : porKg ? v / (peso[sku] ?? 1) : v);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Cartao>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Entrada value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Filtrar produto" style={{ width: 220 }} />
          <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 9, overflow: "hidden" }}>
            {[false, true].map((k) => (
              <button key={String(k)} type="button" onClick={() => setPorKg(k)}
                style={{ border: 0, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", background: porKg === k ? "var(--pm-a)" : "var(--pm-s)", color: porKg === k ? "var(--pm-oa)" : "var(--pm-t)" }}>
                {k ? "por kg" : "por saco"}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <Botao tom="primario" onClick={() => setPublicar(true)}>Publicar tabela de atacado</Botao>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
          Marketplace: preço = (custo + tarifa fixa) ÷ (1 − comissão − imposto − MC); Shopee pela tabela de faixas vigente (a faixa que contém o preço).
          Atacado: preço = custo ÷ (1 − imposto − custo financeiro − MC). Piso = MC 0. "Praticado": vermelho abaixo da menor margem-alvo, preto abaixo do piso.
        </div>
      </Cartao>

      {porSku.map(([sku, ls]) => (
        <Cartao key={sku} titulo={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {fotos.data?.[sku] && <img src={fotos.data[sku]} alt="" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover", background: "#fff" }} />}
            {sku} <span style={{ fontWeight: 400, color: "var(--pm-t2)" }}>{ls[0].nome}</span>
          </span>
        } direita={<span style={{ fontSize: 12.5 }}>custo variável <b>{brl(f(sku, ls[0].cv))}</b>{porKg ? "/kg" : "/saco"}</span>}>
          <div style={{ overflowX: "auto" }}>
            <table style={tabela}>
              <thead>
                <tr>
                  <th style={th}>Canal</th>
                  {mcs.map((m) => <th key={m} style={{ ...th, textAlign: "right" }}>MC {pct(m, Math.round(m * 1000) % 10 ? 1 : 0)}</th>)}
                  <th style={{ ...th, textAlign: "right" }}>Piso</th>
                  <th style={{ ...th, textAlign: "right" }}>Praticado hoje</th>
                  <th style={{ ...th, textAlign: "right" }}>MC praticada</th>
                </tr>
              </thead>
              <tbody>
                {ls.map((l) => <LinhaCanal key={l.canal} l={l} mcs={mcs} f={(v) => f(sku, v)} cenario={cenario} />)}
              </tbody>
            </table>
          </div>
        </Cartao>
      ))}
      <PublicarTabela aberto={publicar} onFechar={() => setPublicar(false)} cenario={cenario} />
    </div>
  );
}

function LinhaCanal({ l, mcs, f, cenario }: { l: LinhaMatriz; mcs: number[]; f: (v: number | null | undefined) => number | null; cenario: Cenario }) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const corPrat = l.abaixo_piso ? "#000" : l.abaixo_alvo ? "var(--pm-r)" : "var(--pm-t)";
  async function salvar() {
    const p = Number(valor.trim().replace(",", "."));
    if (!(p > 0)) return setEditando(false);
    try {
      await inserir("preco_praticado", { sku: l.sku, canal: l.canal, preco: p, origem: "manual" });
      setEditando(false);
      void qc.invalidateQueries({ queryKey: ["custos", "matriz", cenario.id] });
      toast.success(`Preço praticado de ${l.sku} em ${l.canal_nome}: ${brl(p)}.`);
    } catch (e) { toast.error("Não deu para salvar", { description: (e as Error).message }); }
  }
  return (
    <tr>
      <td style={td}>
        <div style={{ fontWeight: 600 }}>{l.canal_nome}</div>
        <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>imposto {pct(l.imposto)}</div>
      </td>
      {mcs.map((m) => {
        const p = l.precos?.find((x) => Number(x.mc) === m);
        return (
          <td key={m} style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }} title={p ? `comissão ${pct(p.comissao)} + ${brl(p.fixo)}${p.fora_faixa ? " — fora das faixas (usada a 1ª)" : ""}` : ""}>
            {p?.preco == null ? "—" : brl(f(p.preco))}{p?.fora_faixa && <span style={{ color: "var(--pm-am)" }}> *</span>}
          </td>
        );
      })}
      <td style={{ ...td, textAlign: "right", color: "var(--pm-t2)", fontVariantNumeric: "tabular-nums" }}>{brl(f(l.piso))}</td>
      <td style={{ ...td, textAlign: "right", color: corPrat, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
        {editando ? (
          <span style={{ display: "inline-flex", gap: 4 }}>
            <Entrada autoFocus inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void salvar(); if (e.key === "Escape") setEditando(false); }} style={{ width: 80, height: 30 }} />
            <Botao onClick={salvar} style={{ height: 30 }}>OK</Botao>
          </span>
        ) : (
          <button type="button" onClick={() => { setValor(l.praticado ? String(l.praticado).replace(".", ",") : ""); setEditando(true); }}
            title={l.praticado_origem === "shopee_anuncios" ? "menor preço ativo nos anúncios da Shopee — clique para fixar outro" : "clique para informar o preço praticado"}
            style={{ border: 0, background: "transparent", cursor: "pointer", color: "inherit", font: "inherit" }}>
            {l.praticado == null ? <span style={{ color: "var(--pm-t3)", fontWeight: 400 }}>informar</span> : brl(f(l.praticado))}
            {l.praticado_origem === "shopee_anuncios" && <span style={{ fontSize: 10, color: "var(--pm-t3)", fontWeight: 400 }}> anúncio</span>}
          </button>
        )}
      </td>
      <td style={{ ...td, textAlign: "right", color: corPrat, fontWeight: 650 }}>{l.mc_praticado == null ? "—" : pct(l.mc_praticado)}</td>
    </tr>
  );
}

function PublicarTabela({ aberto, onFechar, cenario }: { aberto: boolean; onFechar: () => void; cenario: Cenario }) {
  const qc = useQueryClient();
  const canais = useCanais();
  const atacado = (canais.data ?? []).filter((c) => c.ativo && c.tipo === "atacado");
  const [mcTxt, setMcTxt] = useState<Record<string, string>>({});
  const [nome, setNome] = useState("");
  const [enviando, setEnviando] = useState(false);
  const mc = useMemo(() => {
    const o: Record<string, number> = {};
    for (const c of atacado) {
      const t = mcTxt[c.canal];
      const v = t == null || t.trim() === "" ? Number(c.mc_publicacao ?? 0.25) : Number(t.replace(",", ".")) / 100;
      o[c.canal] = Number.isFinite(v) ? v : Number(c.mc_publicacao ?? 0.25);
    }
    return o;
  }, [atacado, mcTxt]);
  const previa = useTabelaAtacado(aberto ? cenario.id : null, aberto && atacado.length ? mc : null);

  async function confirmar() {
    if (!window.confirm(`Publicar a tabela de atacado do cenário "${cenario.nome}"? Depois de publicada ela não muda; para mudar, publique outra.`)) return;
    const janela = window.open("", "_blank");
    setEnviando(true);
    try {
      const id = await rpc<number>("preco_publicar_tabela", { p_cenario: cenario.id, p_nome: nome.trim() || null, p_mc: mc });
      void qc.invalidateQueries({ queryKey: ["custos", "publicadas"] });
      toast.success("Tabela publicada.", { description: `Registro #${id}. Abra pela aba Tabelas publicadas.` });
      if (previa.data) abrirTabelaHtml({ ...previa.data, cenario: cenario.nome, gerado_em: new Date().toISOString() }, nome.trim() || "Tabela de atacado", true, janela);
      else janela?.close();
      onFechar();
    } catch (e) { janela?.close(); toast.error("Não deu para publicar", { description: (e as Error).message }); }
    finally { setEnviando(false); }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-3xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Publicar tabela de atacado</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Campo rotulo="Nome da tabela"><Entrada value={nome} onChange={(e) => setNome(e.target.value)} placeholder={`Tabela de atacado ${new Date().toLocaleDateString("pt-BR")}`} /></Campo>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, atacado.length)}, 1fr)`, gap: 10 }}>
            {atacado.map((c) => (
              <Campo key={c.canal} rotulo={`${c.nome_exibicao} — MC %`} dica={c.condicao_padrao ?? undefined}>
                <Entrada inputMode="decimal" value={mcTxt[c.canal] ?? num((c.mc_publicacao ?? 0.25) * 100, 1)} onChange={(e) => setMcTxt({ ...mcTxt, [c.canal]: e.target.value })} />
              </Campo>
            ))}
          </div>
          <div style={{ maxHeight: 340, overflow: "auto" }}>
            {previa.isLoading && <span style={{ color: "var(--pm-t3)" }}>Calculando…</span>}
            {previa.data && (
              <table style={tabela}>
                <thead><tr><th style={th}>Produto</th>{previa.data.faixas.map((fx) => <th key={fx.canal} style={{ ...th, textAlign: "right" }}>{fx.nome}</th>)}</tr></thead>
                <tbody>{previa.data.itens.map((i) => (
                  <tr key={i.sku}>
                    <td style={td}><b>{i.sku}</b> <span style={{ color: "var(--pm-t3)", fontSize: 12 }}>{i.nome}</span></td>
                    {previa.data!.faixas.map((fx) => (
                      <td key={fx.canal} style={{ ...td, textAlign: "right" }}>
                        <b>{brl(i.faixas[fx.canal]?.preco)}</b>
                        <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>piso {brl(i.faixas[fx.canal]?.piso)}</div>
                      </td>
                    ))}
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Selo>cenário {cenario.nome}</Selo>
            <div style={{ flex: 1 }} />
            <Botao tom="fantasma" onClick={onFechar} disabled={enviando}>Cancelar</Botao>
            <Botao tom="primario" onClick={confirmar} disabled={enviando || !previa.data}>{enviando ? "Publicando…" : "Publicar"}</Botao>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
