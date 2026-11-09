// Histórico das tabelas de atacado publicadas (imutáveis) e a diferença para a versão anterior.
import { useState } from "react";
import { Botao, Cartao, Selo, tabela, td, th } from "../ui";
import { brl } from "@/lib/producao";
import { pct, usePublicadas, type Cenario, type Publicada } from "@/lib/custos";
import { abrirTabelaHtml } from "./tabelaHtml";

export function Publicadas({ cenarios }: { cenarios: Cenario[] }) {
  const pubs = usePublicadas();
  const [aberta, setAberta] = useState<number | null>(null);
  const lista = pubs.data ?? [];
  if (pubs.isLoading) return <Cartao><span style={{ color: "var(--pm-t3)" }}>Carregando…</span></Cartao>;
  if (!lista.length) return <Cartao titulo="Tabelas publicadas"><span style={{ color: "var(--pm-t3)" }}>Nenhuma tabela publicada ainda. Publique pela aba Precificação.</span></Cartao>;
  const nomeCen = (id: number) => cenarios.find((c) => c.id === id)?.nome ?? `#${id}`;
  return (
    <Cartao titulo="Tabelas publicadas">
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lista.map((p, i) => (
          <div key={p.id} style={{ border: "1px solid var(--pm-b)", borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <b>{p.nome}</b>
              <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>
                {new Date(p.publicado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}
                {p.publicado_por_nome ? ` · ${p.publicado_por_nome}` : ""} · cenário {p.snapshot.cenario ?? nomeCen(p.cenario_id)}
              </span>
              {Object.entries(p.mc).map(([k, v]) => <Selo key={k}>{p.snapshot.faixas.find((f) => f.canal === k)?.nome ?? k} {pct(v)}</Selo>)}
              <div style={{ flex: 1 }} />
              <Botao onClick={() => abrirTabelaHtml(p.snapshot, p.nome, false)}>Para o representante</Botao>
              <Botao onClick={() => abrirTabelaHtml(p.snapshot, p.nome, true)}>Completa</Botao>
              {lista[i + 1] && <Botao tom="fantasma" onClick={() => setAberta(aberta === p.id ? null : p.id)}>{aberta === p.id ? "Fechar diferença" : "Diferença p/ anterior"}</Botao>}
            </div>
            {aberta === p.id && lista[i + 1] && <Diferenca atual={p} anterior={lista[i + 1]} />}
          </div>
        ))}
      </div>
    </Cartao>
  );
}

function Diferenca({ atual, anterior }: { atual: Publicada; anterior: Publicada }) {
  const faixas = atual.snapshot.faixas;
  const skus = [...new Set([...atual.snapshot.itens.map((i) => i.sku), ...anterior.snapshot.itens.map((i) => i.sku)])].sort();
  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <div style={{ fontSize: 12, color: "var(--pm-t3)", marginBottom: 4 }}>Comparando com "{anterior.nome}".</div>
      <table style={tabela}>
        <thead><tr><th style={th}>Produto</th>{faixas.map((f) => <th key={f.canal} style={{ ...th, textAlign: "right" }}>{f.nome}</th>)}</tr></thead>
        <tbody>{skus.map((sku) => {
          const a = atual.snapshot.itens.find((x) => x.sku === sku), b = anterior.snapshot.itens.find((x) => x.sku === sku);
          return (
            <tr key={sku}>
              <td style={td}><b>{sku}</b>{!b && <Selo tom="azul">novo</Selo>}{!a && <Selo tom="a">saiu</Selo>}</td>
              {faixas.map((f) => {
                const pa = a?.faixas[f.canal]?.preco, pb = b?.faixas[f.canal]?.preco;
                const d = pa != null && pb != null ? pa - pb : null;
                return (
                  <td key={f.canal} style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    {brl(pb)} → <b>{brl(pa)}</b>
                    {d != null && Math.abs(d) >= 0.005 && <span style={{ color: d > 0 ? "var(--pm-r)" : "var(--pm-g)", marginLeft: 6 }}>{d > 0 ? "+" : ""}{brl(d)}</span>}
                  </td>
                );
              })}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}
