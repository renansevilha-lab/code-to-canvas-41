// Painel do dia: o que está rodando, o que a cobertura pede, big bags e lotes encerrados.
import { Botao, Cartao, Numero, Selo, tabela, td, th } from "./ui";
import {
  brl, horaBR, int, kg, minutos, nomeMotivoParada, periodoBR, useBigBags, useEstoqueAcabado, useFotos, useLotes, useParametros, type Lote,
} from "@/lib/producao";

export function Painel({ onAbrirLote, onIrLote, onIrEntradas }: { onAbrirLote: () => void; onIrLote: (id: number) => void; onIrEntradas: () => void }) {
  const abertos = useLotes("aberta");
  const todos = useLotes("todas", 30);
  const params = useParametros();
  const bags = useBigBags();
  const acabado = useEstoqueAcabado((params.data ?? []).map((p) => p.sku));

  const encerrados = (todos.data ?? []).filter((l) => l.status === "encerrada");
  const fotos = useFotos([...(params.data ?? []).map((p) => p.sku), ...(todos.data ?? []).map((l) => l.sku)]).data ?? {};
  const listaBags = bags.data ?? [];
  const aClassificar = listaBags.filter((b) => b.a_classificar).length;
  const semDensidade = listaBags.filter((b) => b.densidade_pendente && b.saldo_kg > 0).length;
  const kgDisp = listaBags.filter((b) => !b.a_classificar).reduce((s, b) => s + Math.max(0, b.saldo_kg), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {(aClassificar > 0 || semDensidade > 0) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {aClassificar > 0 && (
            <button type="button" onClick={onIrEntradas} className="pm-hv"
              style={{ border: "1px solid var(--pm-am)", background: "var(--pm-ams)", color: "var(--pm-am)", borderRadius: 10, padding: "8px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {aClassificar} big bag(s) sem a farinha definida — classificar em Entradas ›
            </button>
          )}
          {semDensidade > 0 && <Selo tom="n">densidade aparente ainda não medida em {semDensidade} big bag(s)</Selo>}
        </div>
      )}

      <Cartao titulo="Rodando agora" direita={<Botao tom="primario" onClick={onAbrirLote}>Iniciar produção</Botao>}>
        {!(abertos.data ?? []).length ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--pm-t3)" }}>Nenhum lote aberto.</p>
        ) : (
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {(abertos.data ?? []).map((l) => <CartaoLote key={l.id} l={l} foto={fotos[l.sku]} onClick={() => onIrLote(l.id)} />)}
          </div>
        )}
      </Cartao>

      <Cartao titulo="O que produzir" direita={<span style={{ fontSize: 12, color: "var(--pm-t3)" }}>farinha disponível: {kg(kgDisp, 0)}</span>}>
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <th style={th}>Produto</th><th style={{ ...th, textAlign: "right" }}>Estoque</th>
              <th style={{ ...th, textAlign: "right" }}>Venda 30 dias</th><th style={{ ...th, textAlign: "right" }}>Cobertura</th>
              <th style={{ ...th, textAlign: "right" }}>Meta</th><th style={{ ...th, textAlign: "right" }}>Custo no Tiny</th>
            </tr></thead>
            <tbody>
              {(acabado.data ?? []).map((a) => {
                const meta = params.data?.find((p) => p.sku === a.sku)?.meta_estoque_un ?? null;
                return (
                  <tr key={a.sku}>
                    <td style={td}><Produto foto={fotos[a.sku]} sku={a.sku} nome={a.nome} /></td>
                    <td style={{ ...td, textAlign: "right" }}>{int(a.estoque)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{int(a.venda_30d)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{a.cobertura != null ? `${int(a.cobertura)} dias` : "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {meta != null ? (a.estoque != null && a.estoque < meta ? <Selo tom="a">faltam {int(meta - a.estoque)}</Selo> : int(meta)) : "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(a.custo_tiny)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: "8px 0 0" }}>
          Estoque e venda pela mesma regra do agente de compras (Geral + Fulls, kits abertos). Com pouca venda ainda, a cobertura não diz muito: use a meta da ficha técnica.
        </p>
      </Cartao>

      <Cartao titulo="Lotes encerrados">
        {!encerrados.length ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--pm-t3)" }}>Nenhum lote encerrado ainda.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={tabela}>
              <thead><tr>
                <th style={th}>Lote</th><th style={th}>Produto</th><th style={th}>Início → fim</th><th style={{ ...th, textAlign: "right" }}>Bons</th>
                <th style={{ ...th, textAlign: "right" }}>Refugo</th><th style={{ ...th, textAlign: "right" }}>Farinha / saco</th>
                <th style={{ ...th, textAlign: "right" }}>Custo / saco</th><th style={{ ...th, textAlign: "right" }}>Peso médio</th>
                <th style={{ ...th, textAlign: "right" }}>Ritmo</th>
              </tr></thead>
              <tbody>
                {encerrados.map((l) => {
                  const porSaco = l.consumo_real_kg && l.boas ? l.consumo_real_kg / l.boas : null;
                  return (
                    <tr key={l.id} className="pm-linha-hv" style={{ cursor: "pointer" }} onClick={() => onIrLote(l.id)}>
                      <td style={{ ...td, fontWeight: 600 }}>{l.codigo}</td>
                      <td style={td}><Produto foto={fotos[l.sku]} sku={l.sku} nome={l.produto} pequeno /></td>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>
                        {periodoBR(l.inicio_em, l.fim_em)}
                        <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{minutos(l.minutos_total)}{l.minutos_parados ? ` · parado ${minutos(l.minutos_parados)}` : ""}</div>
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>{int(l.boas)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{int(l.refugo)}</td>
                      <td style={{ ...td, textAlign: "right", color: porSaco != null && porSaco > l.farinha_padrao_kg * 1.01 ? "var(--pm-r)" : undefined }}>
                        {porSaco != null ? kg(porSaco, 3) : "—"} <span style={{ color: "var(--pm-t3)" }}>/ {kg(l.farinha_padrao_kg, 3)}</span>
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {brl(l.custo_real_un)} <span style={{ color: "var(--pm-t3)" }}>/ {brl(l.custo_padrao_un)}</span>
                      </td>
                      <td style={{ ...td, textAlign: "right", color: l.abaixo_t ? "var(--pm-r)" : undefined }}>
                        {l.media_g != null ? `${int(l.media_g)} g` : "—"}
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>{l.un_hora != null ? `${int(l.un_hora)}/h` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </div>
  );
}

/** Foto + SKU + nome do produto (sem foto = quadrado vazio, para a coluna não pular). */
export function Produto({ foto, sku, nome, pequeno }: { foto?: string; sku: string; nome: string | null; pequeno?: boolean }) {
  const lado = pequeno ? 34 : 44;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: pequeno ? 180 : 240 }}>
      {foto ? (
        <img src={foto} alt="" loading="lazy" width={lado} height={lado}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
          style={{ width: lado, height: lado, objectFit: "cover", borderRadius: 8, border: "1px solid var(--pm-bs)", background: "#fff", flexShrink: 0 }} />
      ) : (
        <div style={{ width: lado, height: lado, borderRadius: 8, background: "var(--pm-s2)", flexShrink: 0 }} />
      )}
      <div style={{ lineHeight: 1.25 }}>
        <b>{sku}</b>
        {nome && <div style={{ fontSize: pequeno ? 11.5 : 12.5, color: "var(--pm-t2)" }}>{nome}</div>}
      </div>
    </div>
  );
}

function CartaoLote({ l, foto, onClick }: { l: Lote; foto?: string; onClick: () => void }) {
  const pct = l.qtd_planejada ? Math.min(100, (l.envasados / l.qtd_planejada) * 100) : null;
  return (
    <button type="button" onClick={onClick} className="pm-linha-hv"
      style={{ textAlign: "left", border: "1px solid var(--pm-bs)", borderRadius: 12, padding: 12, background: "var(--pm-s)", color: "var(--pm-t)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 750, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{l.codigo}</span>
        <div style={{ flex: 1 }} />
        {l.parado_agora ? <Selo tom="r">parado · {nomeMotivoParada(l.parada_motivo)}</Selo> : <Selo tom="g">rodando</Selo>}
      </div>
      <Produto foto={foto} sku={l.sku} nome={l.produto} pequeno />
      <div style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>big bag {l.big_bag} · começou {horaBR(l.inicio_em)}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <Numero rotulo="Envasados" valor={int(l.envasados)} sub={l.qtd_planejada ? `de ${int(l.qtd_planejada)}` : undefined} />
        <Numero rotulo="Ritmo" valor={l.un_hora != null ? `${int(l.un_hora)}/h` : "—"} sub={minutos(l.minutos_total)} />
        <Numero rotulo="Peso médio" valor={l.media_g != null ? `${int(l.media_g)}` : "—"}
          tom={l.alerta_peso === "abaixo_nominal" ? "r" : l.alerta_peso === "atencao" ? "a" : undefined} sub={`${int(l.pesagens)} pesagens`} />
      </div>
      {pct != null && (
        <div style={{ height: 6, borderRadius: 4, background: "var(--pm-s2)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "var(--pm-a)" }} />
        </div>
      )}
    </button>
  );
}
