// Entradas de matéria-prima: farinha (um registro por big bag — é o lote rastreável),
// sacos e etiquetas (um registro por recebimento). O saldo é calculado no banco (entrada − consumo).
// Matéria-prima fica só no app: nada daqui vai ao Tiny (decisão do dono, 28/out/2026).
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Cartao, Entrada, Escolha, Selo, tabela, td, th } from "./ui";
import { useImpressaoBigBag } from "./EtiquetaBigBag";
import { brl, dataBR, erroMsg, hojeSP, int, kg, useBigBags, useEntradas, useEstoqueMp, useInsumos, type BigBag } from "@/lib/producao";

const ACLASSIFICAR = "farinha:?";

export function Entradas() {
  const qc = useQueryClient();
  const insumos = useInsumos();
  const bags = useBigBags();
  const estoque = useEstoqueMp();
  const etiqueta = useImpressaoBigBag();
  const bagsComSaldo = (bags.data ?? []).filter((b) => b.saldo_kg > 0);

  const [insumoSel, setInsumoSel] = useState<string>("");
  const [qtd, setQtd] = useState("");
  const [nBags, setNBags] = useState("1");
  const [custo, setCusto] = useState("");
  const [recebido, setRecebido] = useState(hojeSP());
  const [fornecedor, setFornecedor] = useState("");
  const [nf, setNf] = useState("");
  const [prefixo, setPrefixo] = useState("");
  const [obs, setObs] = useState("");
  const [salvando, setSalvando] = useState(false);

  const insumo = insumos.data?.find((i) => String(i.id) === insumoSel) ?? null;
  const ehFarinha = insumoSel === ACLASSIFICAR || insumo?.tipo === "farinha";
  const unidade = ehFarinha ? "kg" : insumo?.unidade ?? "un";
  const farinhas = (insumos.data ?? []).filter((i) => i.tipo === "farinha" && i.ativo);

  const codigoBase = useMemo(() => {
    const p = (prefixo || fornecedor.split(/\s+/)[0] || "BAG").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "BAG";
    return `${p}-${(nf || recebido.replace(/-/g, "")).replace(/\D/g, "")}`;
  }, [prefixo, fornecedor, nf, recebido]);

  const recarregar = () => void qc.invalidateQueries({ queryKey: ["producao"] });

  async function salvar() {
    const q = Number(qtd.replace(",", "."));
    const c = Number(custo.replace(",", "."));
    const n = ehFarinha ? Math.max(1, Math.floor(Number(nBags) || 1)) : 1;
    if (!insumoSel) return toast.error("Escolha a matéria-prima.");
    if (!(q > 0)) return toast.error(ehFarinha ? "Informe os kg de cada big bag." : "Informe a quantidade.");
    if (!(c >= 0) || custo === "") return toast.error(`Informe o custo por ${unidade}.`);
    const base = {
      insumo_id: insumoSel === ACLASSIFICAR ? null : Number(insumoSel),
      fornecedor_nome: fornecedor || null, nf_numero: nf || null, recebido_em: recebido,
      quantidade: q, custo_un: c, obs: obs || null,
    };
    const linhas = ehFarinha
      ? Array.from({ length: n }, (_, i) => ({ ...base, codigo: `${codigoBase}-${String(i + 1).padStart(2, "0")}` }))
      : [base];
    setSalvando(true);
    const { error } = await supabaseExternal.from("producao_entrada").insert(linhas);
    setSalvando(false);
    if (error) {
      return toast.error(error.code === "23505" ? `Já existe entrada com o código ${codigoBase}-01. Mude o prefixo ou a NF.` : erroMsg(error));
    }
    toast.success(ehFarinha ? `${n} big bag(s) registrados.` : "Entrada registrada.");
    setQtd(""); setNf(""); setObs("");
    recarregar();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Cartao titulo="Nova entrada de matéria-prima">
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <Campo rotulo="Matéria-prima">
            <Escolha value={insumoSel} onChange={(e) => setInsumoSel(e.target.value)}>
              <option value="">Escolha…</option>
              {farinhas.map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
              <option value={ACLASSIFICAR}>Farinha — classificar depois</option>
              {(insumos.data ?? []).filter((i) => i.tipo !== "farinha" && i.ativo).map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
            </Escolha>
          </Campo>
          {ehFarinha && (
            <Campo rotulo="Quantos big bags">
              <Entrada inputMode="numeric" value={nBags} onChange={(e) => setNBags(e.target.value)} />
            </Campo>
          )}
          <Campo rotulo={ehFarinha ? "kg em cada big bag" : `Quantidade (${unidade})`}>
            <Entrada inputMode="decimal" value={qtd} onChange={(e) => setQtd(e.target.value)} placeholder={ehFarinha ? "1000" : ""} />
          </Campo>
          <Campo rotulo={`Custo por ${unidade} (R$)`} dica={insumo?.custo_referencia != null ? `referência ${brl(insumo.custo_referencia, 3)}` : undefined}>
            <Entrada inputMode="decimal" value={custo} onChange={(e) => setCusto(e.target.value)} />
          </Campo>
          <Campo rotulo="Recebido em">
            <Entrada type="date" value={recebido} onChange={(e) => setRecebido(e.target.value)} />
          </Campo>
          <Campo rotulo="Fornecedor">
            <Entrada value={fornecedor} onChange={(e) => setFornecedor(e.target.value)} />
          </Campo>
          <Campo rotulo="Nº da NF">
            <Entrada value={nf} onChange={(e) => setNf(e.target.value)} />
          </Campo>
          {ehFarinha && (
            <Campo rotulo="Prefixo do código" dica={`fica ${codigoBase}-01…`}>
              <Entrada value={prefixo} onChange={(e) => setPrefixo(e.target.value)} placeholder="LOTUS" />
            </Campo>
          )}
          <Campo rotulo="Observação">
            <Entrada value={obs} onChange={(e) => setObs(e.target.value)} />
          </Campo>
        </div>
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <Botao tom="primario" onClick={salvar} disabled={salvando}>{salvando ? "Salvando…" : "Registrar entrada"}</Botao>
        </div>
      </Cartao>

      <EntradasRecebidas />

      <Cartao titulo="Big bags" direita={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>um lote de produção = um big bag</span>
          {etiqueta.seletor}
          <Botao onClick={() => etiqueta.imprimir(bagsComSaldo)} disabled={!bagsComSaldo.length || etiqueta.imprimindo}>
            {etiqueta.imprimindo ? "Imprimindo…" : `Etiquetas dos ${bagsComSaldo.length} com saldo`}
          </Botao>
        </span>
      }>
        <TabelaBigBags bags={bags.data ?? []} farinhas={farinhas} onMudou={recarregar}
          onEtiqueta={(b) => etiqueta.imprimir([b])} imprimindo={etiqueta.imprimindo} />
      </Cartao>

      <Cartao titulo="Saldo das matérias-primas">
        <table style={tabela}>
          <thead><tr>
            <th style={th}>Matéria-prima</th><th style={{ ...th, textAlign: "right" }}>Entrou</th>
            <th style={{ ...th, textAlign: "right" }}>Usado</th><th style={{ ...th, textAlign: "right" }}>Saldo</th>
            <th style={{ ...th, textAlign: "right" }}>Custo médio</th><th style={th}>Última entrada</th>
          </tr></thead>
          <tbody>
            {(estoque.data ?? []).map((e) => (
              <tr key={e.insumo_id}>
                <td style={td}>{e.nome}</td>
                <td style={{ ...td, textAlign: "right" }}>{e.unidade === "kg" ? kg(e.entradas, 0) : int(e.entradas)}</td>
                <td style={{ ...td, textAlign: "right" }}>{e.unidade === "kg" ? kg(e.consumido, 0) : int(e.consumido)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 650, color: e.saldo < 0 ? "var(--pm-r)" : undefined }}>
                  {e.unidade === "kg" ? kg(e.saldo, 0) : int(e.saldo)}
                </td>
                <td style={{ ...td, textAlign: "right" }}>{brl(e.custo_medio ?? e.custo_referencia, 3)}</td>
                <td style={td}>{e.ultima_entrada ? dataBR(e.ultima_entrada) : <Selo tom="a">sem entrada</Selo>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: "8px 0 0" }}>
          A farinha "a classificar" não entra nesta conta até o big bag ser classificado. Saldo negativo = foi usado sem entrada registrada.
        </p>
      </Cartao>

    </div>
  );
}

function TabelaBigBags({ bags, farinhas, onMudou, onEtiqueta, imprimindo }: {
  bags: BigBag[]; farinhas: Array<{ id: number; nome: string }>; onMudou: () => void;
  onEtiqueta: (b: BigBag) => void; imprimindo: boolean;
}) {
  const [salvando, setSalvando] = useState<number | null>(null);
  async function atualizar(id: number, campos: Record<string, unknown>) {
    setSalvando(id);
    const { error } = await supabaseExternal.from("producao_entrada").update(campos).eq("id", id);
    setSalvando(null);
    if (error) return toast.error(erroMsg(error));
    onMudou();
  }
  if (!bags.length) return <p style={{ fontSize: 13, color: "var(--pm-t3)", margin: 0 }}>Nenhum big bag registrado.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tabela}>
        <thead><tr>
          <th style={th}>Código</th><th style={th}>Farinha</th><th style={th}>NF</th>
          <th style={{ ...th, textAlign: "right" }}>Saldo</th><th style={{ ...th, textAlign: "right" }}>Rende</th>
          <th style={th}>Densidade (g/cm³)</th><th style={th}>Situação</th><th style={th}></th>
        </tr></thead>
        <tbody>
          {bags.map((b) => {
            const usado = b.consumido_kg > 0 || !!b.lote_aberto;
            return (
              <tr key={b.id}>
                <td style={{ ...td, fontWeight: 600 }}>{b.codigo}</td>
                <td style={td}>
                  {usado ? b.insumo : (
                    <Escolha
                      value={b.insumo_id ?? ""}
                      disabled={salvando === b.id}
                      onChange={(e) => atualizar(b.id, { insumo_id: e.target.value ? Number(e.target.value) : null })}
                      style={{ height: 30, minWidth: 200, borderColor: b.a_classificar ? "var(--pm-am)" : undefined }}
                    >
                      <option value="">Classificar…</option>
                      {farinhas.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
                    </Escolha>
                  )}
                </td>
                <td style={td}>{b.nf_numero ?? "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{kg(b.saldo_kg, 0)}</td>
                <td style={{ ...td, textAlign: "right" }}>{b.sacos_possiveis != null ? `${int(b.sacos_possiveis)} sacos` : "—"}</td>
                <td style={td}>
                  <Entrada
                    inputMode="decimal"
                    defaultValue={b.densidade_aparente ?? ""}
                    placeholder="medir"
                    style={{ height: 30, width: 90 }}
                    onBlur={(e) => {
                      const v = e.target.value.trim().replace(",", ".");
                      const n = v === "" ? null : Number(v);
                      if (n !== null && !(n > 0)) return toast.error("Densidade inválida.");
                      if (n !== (b.densidade_aparente ?? null)) atualizar(b.id, { densidade_aparente: n });
                    }}
                  />
                </td>
                <td style={td}>
                  {b.lote_aberto ? <Selo tom="azul">no lote {b.lote_aberto}</Selo>
                    : b.a_classificar ? <Selo tom="a">classificar a farinha</Selo>
                    : b.saldo_kg <= 0 ? <Selo>vazio</Selo>
                    : <Selo tom="g">disponível</Selo>}
                </td>
                <td style={{ ...td, textAlign: "right" }}>
                  <Botao onClick={() => onEtiqueta(b)} disabled={imprimindo} style={{ height: 30 }}>Etiqueta</Botao>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EntradasRecebidas() {
  const entradas = useEntradas();
  const insumos = useInsumos();
  const lista = entradas.data ?? [];
  return (
    <Cartao titulo="Entradas recebidas">
      {!lista.length ? <p style={{ fontSize: 13, color: "var(--pm-t3)", margin: 0 }}>Nenhuma entrada.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <th style={th}>Código</th><th style={th}>Matéria-prima</th><th style={th}>Recebido</th><th style={th}>Fornecedor</th><th style={th}>NF</th>
              <th style={{ ...th, textAlign: "right" }}>Quantidade</th><th style={{ ...th, textAlign: "right" }}>R$/un</th><th style={{ ...th, textAlign: "right" }}>Total</th>
            </tr></thead>
            <tbody>
              {lista.map((e) => {
                const ins = insumos.data?.find((i) => i.id === e.insumo_id);
                const un = ins?.unidade ?? "kg";
                return (
                  <tr key={e.id}>
                    <td style={{ ...td, fontWeight: 600 }}>{e.codigo}</td>
                    <td style={td}>{ins?.nome ?? <Selo tom="a">farinha a classificar</Selo>}</td>
                    <td style={td}>{dataBR(e.recebido_em)}</td>
                    <td style={td}>{e.fornecedor_nome ?? "—"}</td>
                    <td style={td}>{e.nf_numero ?? "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>{un === "kg" ? kg(e.quantidade, 0) : int(e.quantidade)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(e.custo_un, 3)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(e.quantidade * e.custo_un)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}
