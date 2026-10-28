// Produção × Tiny (opção B): prévia → confirmação → lançamento de estoque no depósito Geral.
// Matérias-primas precisam estar ligadas a um produto do Tiny (criar ou ligar a um SKU que já existe).
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePerfil } from "@/hooks/usePerfil";
import { Botao, Cartao, Selo, tabela, td, th } from "./ui";
import { brl, chamarProducaoTiny, dataBR, int, useEntradas, useInsumos, type RespostaTiny } from "@/lib/producao";

const fmtQtd = (q: number | null | undefined, un: string) =>
  q == null ? "—" : un === "KG" ? `${q.toLocaleString("pt-BR", { maximumFractionDigits: 3 })} kg` : int(q);

export function DialogoLancarTiny({ aberto, onFechar, modulo, refId, titulo, onFeito }: {
  aberto: boolean; onFechar: () => void; modulo: "lote" | "entrada"; refId: number; titulo: string; onFeito?: () => void;
}) {
  const [r, setR] = useState<RespostaTiny | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const chave = modulo === "lote" ? "ordem_id" : "entrada_id";

  useEffect(() => {
    if (!aberto) { setR(null); setErro(null); return; }
    setCarregando(true);
    chamarProducaoTiny<RespostaTiny>(modulo, { [chave]: refId })
      .then(setR).catch((e) => setErro(e instanceof Error ? e.message : String(e))).finally(() => setCarregando(false));
  }, [aberto, modulo, refId, chave]);

  async function lancar() {
    if (!r) return;
    const pend = r.itens.filter((i) => !i.ja_lancado);
    const linhas = pend.map((i) => `${i.tipo === "E" ? "Entrada" : "Saída"} de ${fmtQtd(i.quantidade, i.unidade)} — ${i.nome}`).join("\n");
    if (!window.confirm(`Lançar no Tiny (depósito Geral)?\n\n${linhas}\n\nIsso mexe no estoque que o Tiny manda aos marketplaces.`)) return;
    setCarregando(true);
    try {
      const res = await chamarProducaoTiny<RespostaTiny>(modulo, { [chave]: refId, confirmar: true });
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
            {pendentes.some((i) => (i.saldo_depois ?? 0) < 0) && (
              <p style={{ fontSize: 12.5, color: "var(--pm-am)", margin: "6px 0 0" }}>
                Algum saldo fica negativo no Tiny: falta lançar a entrada dessa matéria-prima (aba Entradas).
              </p>
            )}
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

/** Matérias-primas × produto do Tiny. Criar/ligar = administrador. */
export function InsumosNoTiny() {
  const qc = useQueryClient();
  const insumos = useInsumos();
  const { temAcesso } = usePerfil();
  const admin = temAcesso("todos");
  const [ocupado, setOcupado] = useState<number | null>(null);

  async function criar(id: number, nome: string) {
    setOcupado(id);
    try {
      const pre = await chamarProducaoTiny<{ corpo: { sku: string; unidade: string; ncm?: string } }>("cadastrar", { insumo_id: id });
      const c = pre.corpo;
      if (!window.confirm(`Criar no Tiny o produto "${nome}"?\n\nSKU ${c.sku} · unidade ${c.unidade}${c.ncm ? ` · NCM ${c.ncm}` : ""}\n\nA API do Tiny não apaga produto: se errar, só dá para inativar na tela do Tiny.`)) return;
      const r = await chamarProducaoTiny<{ criado: { sku: string } }>("cadastrar", { insumo_id: id, sku: c.sku, confirmar: true });
      toast.success(`Criado no Tiny com o SKU ${r.criado.sku}.`);
      void qc.invalidateQueries({ queryKey: ["producao"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setOcupado(null); }
  }
  async function ligar(id: number, nome: string) {
    const sku = window.prompt(`SKU do produto que já existe no Tiny para "${nome}":`)?.trim();
    if (!sku) return;
    setOcupado(id);
    try {
      const r = await chamarProducaoTiny<{ ligado: { sku: string; nome: string } }>("ligar", { insumo_id: id, sku });
      toast.success(`Ligado a ${r.ligado.sku} (${r.ligado.nome}).`);
      void qc.invalidateQueries({ queryKey: ["producao"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setOcupado(null); }
  }

  const lista = (insumos.data ?? []).filter((i) => i.ativo);
  const faltam = lista.filter((i) => !i.tiny_produto_id).length;
  return (
    <Cartao titulo="Matérias-primas no Tiny" direita={faltam ? <Selo tom="a">{faltam} sem produto no Tiny</Selo> : <Selo tom="g">todas ligadas</Selo>}>
      <table style={tabela}>
        <thead><tr><th style={th}>Matéria-prima</th><th style={th}>Produto no Tiny</th><th style={th}></th></tr></thead>
        <tbody>
          {lista.map((i) => (
            <tr key={i.id}>
              <td style={td}>{i.nome} <span style={{ color: "var(--pm-t3)" }}>({i.unidade})</span></td>
              <td style={td}>{i.tiny_sku ? <b>{i.tiny_sku}</b> : <span style={{ color: "var(--pm-t3)" }}>não ligado</span>}</td>
              <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                {!i.tiny_produto_id && admin && (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <Botao onClick={() => criar(i.id, i.nome)} disabled={ocupado === i.id}>Criar no Tiny</Botao>
                    <Botao tom="fantasma" onClick={() => ligar(i.id, i.nome)} disabled={ocupado === i.id}>Já existe: ligar</Botao>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: "8px 0 0" }}>
        Sem a ligação, o encerramento do lote não consegue dar baixa da matéria-prima no Tiny. {admin ? "" : "Só o administrador cria ou liga."}
      </p>
    </Cartao>
  );
}

/** Entradas recentes com o lançamento no Tiny. */
export function EntradasNoTiny() {
  const qc = useQueryClient();
  const entradas = useEntradas();
  const insumos = useInsumos();
  const [lancando, setLancando] = useState<{ id: number; codigo: string } | null>(null);
  const nomeInsumo = (id: number | null) => insumos.data?.find((i) => i.id === id)?.nome ?? "farinha a classificar";
  return (
    <Cartao titulo="Entradas recebidas">
      {!(entradas.data ?? []).length ? <p style={{ fontSize: 13, color: "var(--pm-t3)", margin: 0 }}>Nenhuma entrada.</p> : (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>
              <th style={th}>Código</th><th style={th}>Matéria-prima</th><th style={th}>Recebido</th><th style={th}>NF</th>
              <th style={{ ...th, textAlign: "right" }}>Quantidade</th><th style={{ ...th, textAlign: "right" }}>R$/un</th><th style={th}>Tiny</th>
            </tr></thead>
            <tbody>
              {(entradas.data ?? []).map((e) => {
                const un = insumos.data?.find((i) => i.id === e.insumo_id)?.unidade ?? "kg";
                return (
                  <tr key={e.id}>
                    <td style={{ ...td, fontWeight: 600 }}>{e.codigo}</td>
                    <td style={td}>{nomeInsumo(e.insumo_id)}</td>
                    <td style={td}>{dataBR(e.recebido_em)}</td>
                    <td style={td}>{e.nf_numero ?? "—"}</td>
                    <td style={{ ...td, textAlign: "right" }}>{un === "kg" ? `${int(e.quantidade)} kg` : int(e.quantidade)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{brl(e.custo_un, 3)}</td>
                    <td style={td}>
                      {e.tiny_lancado_em ? <Selo tom="g">lançado {dataBR(e.tiny_lancado_em)}</Selo>
                        : <Botao onClick={() => setLancando({ id: e.id, codigo: e.codigo })} disabled={!e.insumo_id}>Lançar no Tiny</Botao>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {lancando && (
        <DialogoLancarTiny aberto onFechar={() => setLancando(null)} modulo="entrada" refId={lancando.id}
          titulo={`Entrada ${lancando.codigo} no Tiny`} onFeito={() => void qc.invalidateQueries({ queryKey: ["producao"] })} />
      )}
    </Cartao>
  );
}
