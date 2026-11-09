// Dois cenários lado a lado: custo variável por produto, diferença e os preços de atacado que saem de cada um.
import { useState } from "react";
import { Campo, Cartao, Escolha, tabela, td, th } from "../ui";
import { brl } from "@/lib/producao";
import { useCusto, useTabelaAtacado, type Cenario } from "@/lib/custos";

export function Comparador({ cenarios, atual }: { cenarios: Cenario[]; atual: Cenario }) {
  const [a, setA] = useState<number>(atual.id);
  const [b, setB] = useState<number>(() => cenarios.find((c) => c.id !== atual.id)?.id ?? atual.id);
  const ca = useCusto(a), cb = useCusto(b);
  const ta = useTabelaAtacado(a, null), tb = useTabelaAtacado(b, null);
  const nome = (id: number) => cenarios.find((c) => c.id === id)?.nome ?? `#${id}`;
  const skus = [...new Set([...(ca.data ?? []).map((x) => x.sku), ...(cb.data ?? []).map((x) => x.sku)])].sort();
  const faixas = ta.data?.faixas ?? tb.data?.faixas ?? [];

  return (
    <Cartao titulo="Comparar cenários">
      {cenarios.length < 2 && <div style={{ fontSize: 12.5, color: "var(--pm-am)", marginBottom: 10 }}>Só há um cenário. Use "Duplicar" e mude o que quiser na cópia para comparar.</div>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ width: 260 }}><Campo rotulo="Cenário A"><Escolha value={a} onChange={(e) => setA(Number(e.target.value))}>{cenarios.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</Escolha></Campo></div>
        <div style={{ width: 260 }}><Campo rotulo="Cenário B"><Escolha value={b} onChange={(e) => setB(Number(e.target.value))}>{cenarios.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}</Escolha></Campo></div>
      </div>
      {(ca.isLoading || cb.isLoading) ? <span style={{ color: "var(--pm-t3)" }}>Calculando…</span> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead>
              <tr>
                <th style={th}>Produto</th>
                <th style={{ ...th, textAlign: "right" }}>Custo A</th><th style={{ ...th, textAlign: "right" }}>Custo B</th><th style={{ ...th, textAlign: "right" }}>B − A</th>
                {faixas.map((f) => <th key={f.canal} style={{ ...th, textAlign: "right" }}>{f.nome} A → B</th>)}
              </tr>
            </thead>
            <tbody>
              {skus.map((sku) => {
                const x = ca.data?.find((c) => c.sku === sku), y = cb.data?.find((c) => c.sku === sku);
                const d = x && y ? y.cv - x.cv : null;
                const ia = ta.data?.itens.find((i) => i.sku === sku), ib = tb.data?.itens.find((i) => i.sku === sku);
                return (
                  <tr key={sku}>
                    <td style={td}><b>{sku}</b> <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{x?.nome ?? y?.nome}</span></td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(x?.cv)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(y?.cv)}</td>
                    <td style={{ ...td, textAlign: "right", fontWeight: 650, color: d == null || Math.abs(d) < 0.005 ? "var(--pm-t3)" : d > 0 ? "var(--pm-r)" : "var(--pm-g)" }}>
                      {d == null ? "—" : `${d > 0 ? "+" : ""}${brl(d)}`}
                    </td>
                    {faixas.map((f) => (
                      <td key={f.canal} style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                        {brl(ia?.faixas[f.canal]?.preco)} → <b>{brl(ib?.faixas[f.canal]?.preco)}</b>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 6 }}>Preços de atacado com a MC padrão de cada faixa. A = {nome(a)}, B = {nome(b)}.</div>
        </div>
      )}
    </Cartao>
  );
}
