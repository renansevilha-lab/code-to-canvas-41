// Iniciar produção (abre o lote): SKU → big bag da farinha dele (só os com saldo) → embalagem → quem está em cada etapa.
// O código do lote (prefixo-AAAAMMDD-NN) nasce no banco (producao_abrir_lote).
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Entrada, Escolha } from "./ui";
import {
  ETAPAS, embalagensDaFicha, erroMsg, farinhaCurta, farinhaPorSaco, int, kg, useBigBags, useInsumos, useOrdensProducao, useParametros, usePessoas, type Etapa, type OrdemProducao,
} from "@/lib/producao";

export function AbrirLote({ aberto, op, onFechar, onAberto }: {
  aberto: boolean; op?: OrdemProducao | null; onFechar: () => void; onAberto: (id: number) => void;
}) {
  const qc = useQueryClient();
  const params = useParametros();
  const bags = useBigBags();
  const insumos = useInsumos();
  const pessoas = usePessoas();
  const ops = useOrdensProducao(false);

  const [sku, setSku] = useState("");
  const [bag, setBag] = useState("");
  const [emb, setEmb] = useState("");
  const [qtd, setQtd] = useState("");
  const [quem, setQuem] = useState<Partial<Record<Etapa, string>>>(() => {
    try { return JSON.parse(localStorage.getItem("producao.quem") || "{}"); } catch { return {}; }
  });
  const [salvando, setSalvando] = useState(false);
  const [opId, setOpId] = useState("");

  const par = params.data?.find((p) => p.sku === sku) ?? null;
  // 08/nov (dono): na escolha do produto e do big bag, mostrar a MATÉRIA-PRIMA (o código do bag — JAJU-3310-02 — não diz
  // se é a farinha branca ou a marrom, fina ou média). Nome do produto só dos SKUs da produção.
  const skusPar = (params.data ?? []).map((p) => p.sku);
  const nomesQ = useQuery({
    queryKey: ["producao", "nomes-produtos", skusPar.join(",")],
    enabled: aberto && skusPar.length > 0,
    queryFn: async () => {
      const { data } = await supabaseExternal.from("produtos").select("sku, nome").in("sku", skusPar);
      return Object.fromEntries(((data ?? []) as { sku: string; nome: string | null }[]).map((x) => [x.sku, x.nome ?? ""]));
    },
  });
  const nomeInsumo = (id: number | null | undefined) => (id == null ? "" : (insumos.data ?? []).find((i) => Number(i.id) === Number(id))?.nome ?? "");
  const materiaPrima = (p: typeof par) => {
    if (!p) return "";
    const f = farinhaCurta(nomeInsumo(p.farinha_id)) || "farinha não definida na ficha";
    const m = p.mistura_insumo_id ? nomeInsumo(p.mistura_insumo_id) : "";
    return m ? `${f} + ${m}` : f;
  };
  const nomeCurtoProduto = (s: string) => {
    const n = nomesQ.data?.[s] ?? "";
    return n.length > 48 ? `${n.slice(0, 47)}…` : n;
  };
  const embalagens = (insumos.data ?? []).filter((i) => i.tipo === "embalagem" && i.ativo);
  const embSel = embalagens.find((e) => String(e.id) === emb) ?? null;
  // as embalagens da ficha (padrão + alternativas) aparecem como botões; o "outra" abre a lista inteira
  const daFicha = embalagensDaFicha(par, insumos.data);
  const [outraEmb, setOutraEmb] = useState(false);
  const bagsDoSku = useMemo(
    () => (bags.data ?? []).filter((b) => par && b.insumo_id === par.farinha_id && !b.lote_aberto && b.saldo_kg >= farinhaPorSaco(par)),
    [bags.data, par],
  );
  const aClassificar = (bags.data ?? []).filter((b) => b.a_classificar).length;
  const bagSel = bagsDoSku.find((b) => String(b.id) === bag) ?? null;
  const etapas = ETAPAS.filter((e) => e.id !== "etiquetagem" || embSel?.precisa_etiqueta);

  useEffect(() => {
    if (!sku && params.data?.length === 1) setSku(params.data[0].sku);
  }, [params.data, sku]);
  // veio de uma ordem de produção: produto e ordem já escolhidos
  useEffect(() => {
    if (!aberto) return;
    if (op) { setSku(op.sku); setOpId(String(op.id)); } else setOpId("");
  }, [aberto, op?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const opsDoSku = (ops.data ?? []).filter((o) => o.sku === sku && o.status === "aberta" && !o.lote_aberto_id && o.falta > 0);
  const opSel = opsDoSku.find((o) => String(o.id) === opId) ?? null;
  useEffect(() => {
    // produto trocado: a ordem escolhida só vale se for dele; sem escolha, usa a única ordem aberta do produto
    if (opId && !opsDoSku.some((o) => String(o.id) === opId)) setOpId("");
    else if (!opId && !op && opsDoSku.length === 1) setOpId(String(opsDoSku[0].id));
  }, [sku, ops.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (par) setEmb(par.embalagem_padrao_id ? String(par.embalagem_padrao_id) : "");
    setOutraEmb(false);
    setBag("");
  }, [par?.sku]); // eslint-disable-line react-hooks/exhaustive-deps
  // a ordem de produção diz em qual embalagem produzir
  useEffect(() => {
    if (opSel?.embalagem_id) setEmb(String(opSel.embalagem_id));
  }, [opSel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (bagSel && par) {
      const rende = Math.floor(bagSel.saldo_kg / farinhaPorSaco(par));
      setQtd(String(opSel ? Math.min(rende, opSel.falta) : rende));
    }
  }, [bagSel?.id, opSel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function abrir() {
    if (!par || !bagSel) return toast.error("Escolha o produto e o big bag.");
    if (!quem.envase) return toast.error("Diga quem está no envase.");
    const pessoasEtapa = Object.fromEntries(etapas.map((e) => [e.id, quem[e.id] ?? ""]));
    setSalvando(true);
    const { data, error } = await supabaseExternal.rpc("producao_abrir_lote" as never, {
      p_sku: par.sku, p_big_bag: bagSel.id, p_embalagem: emb ? Number(emb) : null,
      p_qtd_planejada: qtd ? Number(qtd) : null, p_pessoas: pessoasEtapa,
    } as never);
    setSalvando(false);
    if (error) return toast.error(erroMsg(error));
    try { localStorage.setItem("producao.quem", JSON.stringify(quem)); } catch { /* sem armazenamento local */ }
    const lote = data as unknown as { id: number; codigo: string };
    if (opSel) {
      const { error: e2 } = await supabaseExternal.from("producao_ordem" as never).update({ op_id: opSel.id } as never).eq("id", lote.id);
      if (e2) toast.error(`Lote aberto, mas não ficou ligado à ordem #${opSel.id}: ${erroMsg(e2)}`);
    }
    toast.success(`Lote ${lote.codigo} aberto${opSel ? ` para a ordem #${opSel.id}` : ""}. Ajuste a datadora para esse código.`);
    void qc.invalidateQueries({ queryKey: ["producao"] });
    onAberto(lote.id);
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-lg" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Iniciar produção</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Campo rotulo="Produto" dica={par ? `Matéria-prima: ${materiaPrima(par)}` : undefined}>
            <Escolha value={sku} onChange={(e) => setSku(e.target.value)}>
              <option value="">Escolha…</option>
              {(params.data ?? []).map((p) => (
                <option key={p.sku} value={p.sku}>
                  {p.sku}{nomeCurtoProduto(p.sku) ? ` · ${nomeCurtoProduto(p.sku)}` : ""} · {materiaPrima(p)}
                </option>
              ))}
            </Escolha>
          </Campo>
          {sku && (opsDoSku.length > 0 || opSel) && (
            <Campo rotulo="Ordem de produção" dica={opSel?.obs ? `Obs.: ${opSel.obs}` : undefined}>
              <Escolha value={opId} onChange={(e) => setOpId(e.target.value)}>
                <option value="">sem ordem</option>
                {opsDoSku.map((o) => (
                  <option key={o.id} value={o.id}>
                    #{o.id} · faltam {int(o.falta)} de {int(o.qtd)}{o.prazo ? ` · até ${o.prazo.slice(8, 10)}/${o.prazo.slice(5, 7)}` : ""}{o.prioridade === "urgente" ? " · URGENTE" : ""}
                  </option>
                ))}
              </Escolha>
            </Campo>
          )}
          <Campo
            rotulo="Big bag de origem"
            dica={par && !bagsDoSku.length
              ? (aClassificar ? `Nenhum big bag de ${farinhaCurta(nomeInsumo(par.farinha_id)) || "farinha desta ficha"}. Há ${aClassificar} big bag(s) a classificar em Entradas.` : `Nenhum big bag de ${farinhaCurta(nomeInsumo(par.farinha_id)) || "farinha desta ficha"} com saldo.`)
              : par ? `Só aparecem os big bags de ${farinhaCurta(nomeInsumo(par.farinha_id))}.` : undefined}
          >
            <Escolha value={bag} onChange={(e) => setBag(e.target.value)} disabled={!par}>
              <option value="">Escolha…</option>
              {bagsDoSku.map((b) => (
                <option key={b.id} value={b.id}>{b.codigo} · {farinhaCurta(b.insumo)} · {kg(b.saldo_kg, 0)} · rende {int(Math.floor(b.saldo_kg / farinhaPorSaco(par!)))} sacos</option>
              ))}
            </Escolha>
          </Campo>
          {daFicha.length > 1 && (
            <Campo rotulo="Embalagem deste lote" dica={opSel?.embalagem ? `a ordem #${opSel.id} pede: ${opSel.embalagem}` : undefined}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {daFicha.map((e) => {
                  const sel = String(e.id) === emb;
                  return (
                    <button key={e.id} type="button" onClick={() => { setEmb(String(e.id)); setOutraEmb(false); }}
                      style={{ padding: "7px 11px", borderRadius: 9, fontSize: 13, cursor: "pointer", textAlign: "left",
                        border: `1px solid ${sel ? "var(--pm-a)" : "var(--pm-bc)"}`, background: sel ? "var(--pm-a)" : "var(--pm-s)", color: sel ? "#fff" : "var(--pm-t)" }}>
                      <div style={{ fontWeight: 650 }}>{e.nome}</div>
                      <div style={{ fontSize: 11, opacity: 0.8 }}>{e.padrao ? "padrão" : "alternativa"}{e.precisa_etiqueta ? " · com etiqueta" : ""}</div>
                    </button>
                  );
                })}
                {!outraEmb && <button type="button" onClick={() => setOutraEmb(true)} style={{ fontSize: 12, color: "var(--pm-t2)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>outra…</button>}
              </div>
            </Campo>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            {daFicha.length > 1 && !outraEmb ? (
              <Campo rotulo="Etiquetagem">
                <div style={{ fontSize: 12.5, paddingTop: 8, color: "var(--pm-t2)" }}>{embSel?.precisa_etiqueta ? "esta embalagem leva etiqueta: a etapa de etiquetagem entra no lote" : "sem etiqueta"}</div>
              </Campo>
            ) : (
              <Campo rotulo="Embalagem" dica={embSel?.precisa_etiqueta ? "precisa de etiqueta: a etapa de etiquetagem entra no lote" : undefined}>
                <Escolha value={emb} onChange={(e) => setEmb(e.target.value)}>
                  {embalagens.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </Escolha>
              </Campo>
            )}
            <Campo rotulo="Sacos planejados">
              <Entrada inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value)} />
            </Campo>
          </div>
          {par?.mistura_insumo_id && par.mistura_un_kg && par.mistura_farinha_kg ? (
            <div style={{ fontSize: 12.5, border: "1px solid var(--pm-bs)", borderRadius: 10, padding: "8px 10px", background: "var(--pm-s2)" }}>
              <b>Mistura:</b> cada {kg(par.mistura_farinha_kg, 0)} de farinha vão com 1 pacote de{" "}
              {(insumos.data ?? []).find((i) => i.id === par.mistura_insumo_id)?.nome ?? "componente"}.
              {Number(qtd) > 0 && (
                <> Para {int(Number(qtd))} sacos: ≈ {int(Math.ceil((Number(qtd) * par.consumo_padrao_kg) / (par.mistura_farinha_kg + par.mistura_un_kg)))} pacotes
                  e {kg(Number(qtd) * farinhaPorSaco(par), 0)} de farinha.</>
              )}
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" }}>Quem está em cada etapa</span>
            {etapas.map((e) => (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "150px 1fr", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13 }}>{e.nome}</span>
                <Escolha value={quem[e.id] ?? ""} onChange={(ev) => setQuem((q) => ({ ...q, [e.id]: ev.target.value }))}>
                  <option value="">—</option>
                  {(pessoas.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
                </Escolha>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <Botao onClick={onFechar}>Cancelar</Botao>
            <Botao tom="primario" onClick={abrir} disabled={salvando || !bagSel}>{salvando ? "Iniciando…" : "Iniciar produção"}</Botao>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
