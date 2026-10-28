// Produção × Tiny: ao encerrar o lote, entrada do produto acabado no depósito Geral (prévia → confirmação).
// As matérias-primas (farinha, saco, etiqueta) ficam só no app — decisão do dono, 28/out/2026.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Botao, Selo, tabela, td, th } from "./ui";
import { brl, chamarProducaoTiny, int, type RespostaTiny } from "@/lib/producao";

const fmtQtd = (q: number | null | undefined, un: string) =>
  q == null ? "—" : un === "KG" ? `${q.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg` : int(q);

export function DialogoLancarTiny({ aberto, onFechar, refId, titulo, onFeito }: {
  aberto: boolean; onFechar: () => void; refId: number; titulo: string; onFeito?: () => void;
}) {
  const [r, setR] = useState<RespostaTiny | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    if (!aberto) { setR(null); setErro(null); return; }
    setCarregando(true);
    chamarProducaoTiny<RespostaTiny>("lote", { ordem_id: refId })
      .then(setR).catch((e) => setErro(e instanceof Error ? e.message : String(e))).finally(() => setCarregando(false));
  }, [aberto, refId]);

  async function lancar() {
    if (!r) return;
    const pend = r.itens.filter((i) => !i.ja_lancado);
    const linhas = pend.map((i) => `${i.tipo === "E" ? "Entrada" : "Saída"} de ${fmtQtd(i.quantidade, i.unidade)} — ${i.nome}`).join("\n");
    if (!window.confirm(`Lançar no Tiny (depósito Geral)?\n\n${linhas}\n\nIsso mexe no estoque que o Tiny manda aos marketplaces.`)) return;
    setCarregando(true);
    try {
      const res = await chamarProducaoTiny<RespostaTiny>("lote", { ordem_id: refId, confirmar: true });
      setR(res);
      if (res.completo) toast.success("Lançado no Tiny."); else toast.error(`${res.falhas ?? 0} lançamento(s) não entraram: veja o motivo e tente de novo.`);
      onFeito?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setCarregando(false); }
  }

  const pendentes = r?.itens.filter((i) => !i.ja_lancado) ?? [];
  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-2xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>{titulo}</DialogTitle></DialogHeader>
        {carregando && !r && <p style={{ fontSize: 13, color: "var(--pm-t3)" }}>Lendo o estoque no Tiny…</p>}
        {erro && <p style={{ fontSize: 13, color: "var(--pm-r)", fontWeight: 600 }}>{erro}</p>}
        {r && (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={tabela}>
                <thead><tr>
                  <th style={th}>Lançamento</th><th style={th}>Produto no Tiny</th>
                  <th style={{ ...th, textAlign: "right" }}>Quantidade</th><th style={{ ...th, textAlign: "right" }}>R$/un</th>
                  <th style={{ ...th, textAlign: "right" }}>Geral hoje → depois</th><th style={th}></th>
                </tr></thead>
                <tbody>
                  {r.itens.map((i) => (
                    <tr key={i.papel}>
                      <td style={td}><Selo tom={i.tipo === "E" ? "g" : "a"}>{i.tipo === "E" ? "entrada" : "saída"}</Selo></td>
                      <td style={td}>{i.nome}{i.sku ? <span style={{ color: "var(--pm-t3)" }}> · {i.sku}</span> : null}</td>
                      <td style={{ ...td, textAlign: "right" }}>{fmtQtd(i.quantidade, i.unidade)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{brl(i.preco_un, 3)}</td>
                      <td style={{ ...td, textAlign: "right", color: (i.saldo_depois ?? 0) < 0 ? "var(--pm-r)" : undefined }}>
                        {i.saldo_hoje != null ? `${fmtQtd(i.saldo_hoje, i.unidade)} → ${fmtQtd(i.saldo_depois, i.unidade)}` : "—"}
                      </td>
                      <td style={td}>
                        {i.ja_lancado ? <Selo tom="g">lançado</Selo> : i.problema ? <span style={{ fontSize: 12, color: "var(--pm-r)" }}>{i.problema}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.bloqueio && <p style={{ fontSize: 13, color: "var(--pm-r)", fontWeight: 600, margin: "6px 0 0" }}>Não dá para lançar ainda: {r.bloqueio}.</p>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <Botao onClick={onFechar}>Fechar</Botao>
              {pendentes.length > 0 && (
                <Botao tom="primario" onClick={lancar} disabled={carregando || !!r.bloqueio}>
                  {carregando ? "Lançando…" : `Lançar ${pendentes.length} no Tiny`}
                </Botao>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
