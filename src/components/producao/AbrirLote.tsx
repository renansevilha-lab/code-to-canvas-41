// Abrir lote: SKU → big bag da farinha dele (só os com saldo) → embalagem → quem está em cada etapa.
// O código do lote (prefixo-AAAAMMDD-NN) nasce no banco (producao_abrir_lote).
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Entrada, Escolha } from "./ui";
import { ETAPAS, erroMsg, int, kg, useBigBags, useInsumos, useParametros, usePessoas, type Etapa } from "@/lib/producao";

export function AbrirLote({ aberto, onFechar, onAberto }: { aberto: boolean; onFechar: () => void; onAberto: (id: number) => void }) {
  const qc = useQueryClient();
  const params = useParametros();
  const bags = useBigBags();
  const insumos = useInsumos();
  const pessoas = usePessoas();

  const [sku, setSku] = useState("");
  const [bag, setBag] = useState("");
  const [emb, setEmb] = useState("");
  const [qtd, setQtd] = useState("");
  const [quem, setQuem] = useState<Partial<Record<Etapa, string>>>(() => {
    try { return JSON.parse(localStorage.getItem("producao.quem") || "{}"); } catch { return {}; }
  });
  const [salvando, setSalvando] = useState(false);

  const par = params.data?.find((p) => p.sku === sku) ?? null;
  const embalagens = (insumos.data ?? []).filter((i) => i.tipo === "embalagem" && i.ativo);
  const embSel = embalagens.find((e) => String(e.id) === emb) ?? null;
  const bagsDoSku = useMemo(
    () => (bags.data ?? []).filter((b) => par && b.insumo_id === par.farinha_id && !b.lote_aberto && b.saldo_kg >= (par.consumo_padrao_kg ?? 0)),
    [bags.data, par],
  );
  const aClassificar = (bags.data ?? []).filter((b) => b.a_classificar).length;
  const bagSel = bagsDoSku.find((b) => String(b.id) === bag) ?? null;
  const etapas = ETAPAS.filter((e) => e.id !== "etiquetagem" || embSel?.precisa_etiqueta);

  useEffect(() => {
    if (!sku && params.data?.length === 1) setSku(params.data[0].sku);
  }, [params.data, sku]);
  useEffect(() => {
    if (par) setEmb(par.embalagem_padrao_id ? String(par.embalagem_padrao_id) : "");
    setBag("");
  }, [par?.sku]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (bagSel && par) setQtd(String(Math.floor(bagSel.saldo_kg / par.consumo_padrao_kg)));
  }, [bagSel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const op = data as unknown as { id: number; codigo: string };
    toast.success(`Lote ${op.codigo} aberto. Ajuste a datadora para esse código.`);
    void qc.invalidateQueries({ queryKey: ["producao"] });
    onAberto(op.id);
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-lg" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Abrir lote</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Campo rotulo="Produto">
            <Escolha value={sku} onChange={(e) => setSku(e.target.value)}>
              <option value="">Escolha…</option>
              {(params.data ?? []).map((p) => <option key={p.sku} value={p.sku}>{p.sku} · {p.prefixo_lote}</option>)}
            </Escolha>
          </Campo>
          <Campo
            rotulo="Big bag de origem"
            dica={par && !bagsDoSku.length ? (aClassificar ? `Nenhum big bag desta farinha. Há ${aClassificar} big bag(s) a classificar em Entradas.` : "Nenhum big bag desta farinha com saldo.") : undefined}
          >
            <Escolha value={bag} onChange={(e) => setBag(e.target.value)} disabled={!par}>
              <option value="">Escolha…</option>
              {bagsDoSku.map((b) => (
                <option key={b.id} value={b.id}>{b.codigo} · {kg(b.saldo_kg, 0)} · rende {int(b.sacos_possiveis)} sacos</option>
              ))}
            </Escolha>
          </Campo>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
            <Campo rotulo="Embalagem" dica={embSel?.precisa_etiqueta ? "precisa de etiqueta: a etapa de etiquetagem entra no lote" : undefined}>
              <Escolha value={emb} onChange={(e) => setEmb(e.target.value)}>
                {embalagens.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
              </Escolha>
            </Campo>
            <Campo rotulo="Sacos planejados">
              <Entrada inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value)} />
            </Campo>
          </div>
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
            <Botao tom="primario" onClick={abrir} disabled={salvando || !bagSel}>{salvando ? "Abrindo…" : "Abrir lote"}</Botao>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
