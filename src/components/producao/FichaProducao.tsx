// Ficha de produção de um produto fabricado: o que vai num saco, proporções, embalagem e custo padrão.
// Tudo vem da view_producao_ficha (a mesma conta do custo padrão dos lotes); aqui só exibe.
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Numero, Selo } from "./ui";
import { brl, int, kg, useFicha } from "@/lib/producao";

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
const num = (n: number | null | undefined, casas = 3) =>
  n == null ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas });

export function FichaProducao({ sku, foto, onFechar }: { sku: string | null; foto?: string; onFechar: () => void }) {
  const q = useFicha(sku);
  const f = q.data;
  const linhas = f
    ? [
        { tipo: "Farinha do big bag", nome: f.farinha ?? "—", qtd: kg(f.farinha_kg, 3), extra: f.mistura ? `${pct(f.farinha_pct)} do peso` : "100% do peso", custo: f.farinha_custo, un: `${brl(f.farinha_custo_kg, 3)}/kg` },
        ...(f.mistura
          ? [{ tipo: "Mistura (sai do Tiny)", nome: f.mistura, qtd: `${num(f.mistura_un, 3)} pacote`, extra: `${kg(f.mistura_kg, 3)} · ${pct(f.mistura_pct)} do peso`, custo: f.mistura_custo, un: `${brl(f.mistura_custo_un)}/pacote` }]
          : []),
        { tipo: "Embalagem", nome: f.embalagem ?? "—", qtd: "1 un", extra: null, custo: f.embalagem_custo, un: null },
        ...(f.etiqueta ? [{ tipo: "Etiqueta", nome: f.etiqueta, qtd: "1 un", extra: null, custo: f.etiqueta_custo, un: null }] : []),
        { tipo: "Mão de obra e fábrica", nome: "Custo de conversão por saco (MOD + CIF ÷ capacidade)", qtd: "—", extra: null, custo: f.custo_conversao_un, un: null },
      ]
    : [];

  return (
    <Dialog open={sku != null} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-2xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)", maxHeight: "90vh", overflowY: "auto" }}>
        <DialogHeader><DialogTitle>Ficha de produção</DialogTitle></DialogHeader>
        {q.isLoading ? (
          <p style={{ color: "var(--pm-t3)", fontSize: 13 }}>Carregando…</p>
        ) : !f ? (
          <p style={{ color: "var(--pm-t3)", fontSize: 13 }}>Este produto não tem ficha de produção.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {foto && <img src={foto} alt="" width={64} height={64} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid var(--pm-bs)", background: "#fff" }} />}
              <div>
                <div style={{ fontWeight: 750 }}>{f.sku}</div>
                <div style={{ fontSize: 13, color: "var(--pm-t2)" }}>{f.produto}</div>
                <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Selo>lote {f.prefixo_lote}-AAAAMMDD-NN</Selo>
                  {f.mistura && <Selo tom="azul">mistura</Selo>}
                  {!f.ativo && <Selo tom="a">ficha desligada</Selo>}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
              <Numero rotulo="Peso no saco" valor={kg(f.peso_nominal_kg, f.peso_nominal_kg % 1 ? 1 : 0)} sub={`mínimo ${int(f.peso_nominal_kg * 1000 - f.tolerancia_g)} g`} />
              <Numero rotulo="Vai no saco" valor={kg(f.consumo_padrao_kg, 3)} sub={`+${pct(f.sobrepeso_pct * 100)} sobrepeso · ${pct(f.perda_pct * 100)} perda`} />
              <Numero rotulo="Custo padrão" valor={brl(f.custo_padrao_un)} sub="por saco" />
              <Numero rotulo="Pesagem" valor={f.pesar_cada ? `1 a cada ${int(f.pesar_cada)}` : "todos"} sub={`os ${int(f.pesar_primeiros)} primeiros`} />
            </div>

            {f.mistura && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Proporção da mistura</div>
                <div style={{ display: "flex", height: 26, borderRadius: 8, overflow: "hidden", border: "1px solid var(--pm-bs)", fontSize: 12, fontWeight: 650 }}>
                  <div style={{ width: `${f.farinha_pct}%`, background: "var(--pm-ams)", color: "var(--pm-am)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    farinha {pct(f.farinha_pct)}
                  </div>
                  <div style={{ width: `${f.mistura_pct}%`, background: "var(--pm-as)", color: "var(--pm-at)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {f.mistura_sku} {pct(f.mistura_pct)}
                  </div>
                </div>
                <p style={{ fontSize: 12, color: "var(--pm-t3)", margin: "6px 0 0" }}>
                  Receita: {kg(f.mistura_farinha_kg, 1)} de farinha para cada pacote de {kg(f.mistura_un_kg, 1)} do {f.mistura_sku}.
                  Para 100 sacos: {kg((f.farinha_kg ?? 0) * 100, 0)} de farinha e {int(Math.ceil((f.mistura_un ?? 0) * 100))} pacotes.
                </p>
              </div>
            )}

            <div>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>O que vai em cada saco</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {linhas.map((x, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--pm-bs)" }}>
                      <td style={{ padding: "7px 8px 7px 0" }}>
                        <div style={{ fontSize: 11, color: "var(--pm-t3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{x.tipo}</div>
                        <div>{x.nome}</div>
                        {x.extra && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{x.extra}</div>}
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "right", fontWeight: 700, whiteSpace: "nowrap" }}>{x.qtd}</td>
                      <td style={{ padding: "7px 0 7px 8px", textAlign: "right", whiteSpace: "nowrap", color: "var(--pm-t2)" }}>
                        {brl(x.custo, 4)}
                        {x.un && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{x.un}</div>}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "1px solid var(--pm-bs)" }}>
                    <td style={{ padding: "7px 8px 7px 0", fontWeight: 700 }}>Custo padrão por saco</td>
                    <td />
                    <td style={{ padding: "7px 0 7px 8px", textAlign: "right", fontWeight: 700 }}>{brl(f.custo_padrao_un)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
