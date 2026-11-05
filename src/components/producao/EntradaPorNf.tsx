// Entrada de matéria-prima pela NF (05/nov/2026, pedido do dono): em vez de digitar, sobe o XML da NF-e ou
// escolhe uma NF de entrada que o sistema já espelhou do Tiny (compras_nf_entrada). Cada linha da nota vira
// uma entrada em producao_entrada (farinha = um registro por big bag; saco/etiqueta = um registro), com a
// NF guardada (número, série, chave, CNPJ, NCM, CFOP). O de-para "linha da nota → matéria-prima" fica
// lembrado neste navegador por fornecedor + descrição. Nada vai ao Tiny.
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Entrada, Escolha, Selo, tabela, td, th } from "./ui";
import { brl, dataBR, erroMsg, hojeSP, int, kg, useInsumos, type Insumo } from "@/lib/producao";
import { parseNfe, similaridade, valorLiquido, type ItemXml, type NfXml } from "@/lib/nfe";

const ACLASSIFICAR = "farinha:?";
const IGNORAR = "ignorar";
const LEMBRAR = "producao.nf.depara";

type Origem = "xml" | "tiny";
interface Linha {
  item: ItemXml;
  destino: string;          // id do insumo | ACLASSIFICAR | IGNORAR
  qtd: string;              // na unidade da matéria-prima (kg ou un)
  bags: string;             // só farinha
}

const normDesc = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const chaveLembrar = (cnpj: string, desc: string) => `${(cnpj || "").replace(/\D/g, "")}|${normDesc(desc)}`;
const lerLembrados = (): Record<string, { destino: string; fator: number }> => {
  try { return JSON.parse(localStorage.getItem(LEMBRAR) || "{}"); } catch { return {}; }
};
const num = (s: string) => { const v = Number(String(s).trim().replace(/\./g, "").replace(",", ".")); return Number.isFinite(v) ? v : NaN; };
const numDec = (s: string) => { const v = Number(String(s).trim().replace(",", ".")); return Number.isFinite(v) ? v : NaN; };
const fmt = (n: number, casas = 3) => String(Math.round(n * 10 ** casas) / 10 ** casas).replace(".", ",");

/** Quantidade da linha na unidade da matéria-prima: kg (TON × 1000) ou unidades (milheiro × 1000). */
function qtdSugerida(it: ItemXml, unidade: "kg" | "un", fatorLembrado?: number): number {
  if (fatorLembrado) return it.qCom * fatorLembrado;
  const u = (it.uTrib || it.uCom || "").toUpperCase();
  const q = it.uTrib ? it.qTrib : it.qCom;
  if (unidade === "kg") {
    if (/^(T|TON|TONELADA)/.test(u)) return q * 1000;
    if (/^G$|GRAMA/.test(u)) return q / 1000;
    return q;
  }
  if (/^(MIL|MILHEIRO|ML)$/.test(u)) return q * 1000;
  return q;
}

export function EntradaPorNf({ aberto, onFechar }: { aberto: boolean; onFechar: () => void }) {
  const qc = useQueryClient();
  const insumos = useInsumos();
  const [origem, setOrigem] = useState<Origem>("xml");
  const [nf, setNf] = useState<NfXml | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [recebido, setRecebido] = useState(hojeSP());
  const [prefixo, setPrefixo] = useState("");
  const [rateio, setRateio] = useState(true);
  const [busca, setBusca] = useState("");
  const [lendo, setLendo] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const arquivo = useRef<HTMLInputElement>(null);

  const lista = (insumos.data ?? []).filter((i) => i.ativo && i.tipo !== "produto");
  const porId = useMemo(() => new Map((insumos.data ?? []).map((i) => [String(i.id), i])), [insumos.data]);
  const unidadeDe = (destino: string): "kg" | "un" =>
    destino === ACLASSIFICAR ? "kg" : ((porId.get(destino)?.unidade as "kg" | "un") ?? "un");
  const ehFarinha = (destino: string) => destino === ACLASSIFICAR || porId.get(destino)?.tipo === "farinha";

  // NFs do Tiny (espelho): só com busca, para não listar as milhares de notas de retorno do Full
  const nfsTiny = useQuery({
    queryKey: ["producao", "nfs-tiny", busca.trim()],
    enabled: aberto && origem === "tiny" && busca.trim().length >= 2,
    queryFn: async () => {
      const b = busca.trim();
      let q = supabaseExternal.from("compras_nf_entrada")
        .select("tiny_id, numero, serie, chave_acesso, data_emissao, fornecedor_nome, fornecedor_cnpj, valor, valor_frete, itens_qtd")
        .eq("ignorar", false).order("data_emissao", { ascending: false }).limit(25);
      q = /^\d+$/.test(b) ? q.or(`numero.ilike.%${b}%,fornecedor_cnpj.ilike.%${b}%`) : q.ilike("fornecedor_nome", `%${b}%`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ tiny_id: number; numero: string; serie: string | null; chave_acesso: string | null; data_emissao: string | null;
        fornecedor_nome: string | null; fornecedor_cnpj: string | null; valor: number | null; valor_frete: number | null; itens_qtd: number | null }>;
    },
  });

  // já existe entrada desta NF?
  const ja = useQuery({
    queryKey: ["producao", "nf-ja", nf?.chave, nf?.numero, nf?.cnpj],
    enabled: !!nf,
    placeholderData: undefined,
    queryFn: async () => {
      let q = supabaseExternal.from("producao_entrada").select("codigo, insumo_id, quantidade");
      q = nf!.chave ? q.eq("nf_chave", nf!.chave) : q.eq("nf_numero", nf!.numero).eq("fornecedor_cnpj", nf!.cnpj.replace(/\D/g, ""));
      const { data, error } = await q.limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ codigo: string; insumo_id: number | null; quantidade: number }>;
    },
  });

  function montar(n: NfXml) {
    const lembrados = lerLembrados();
    const farinhas = lista.filter((i) => i.tipo === "farinha");
    const ls: Linha[] = n.itens.map((it) => {
      const lem = lembrados[chaveLembrar(n.cnpj, it.xProd)];
      let destino = lem?.destino && (lem.destino === IGNORAR || lem.destino === ACLASSIFICAR || porId.has(lem.destino)) ? lem.destino : "";
      if (!destino) {
        // palpite pelo nome: a matéria-prima mais parecida; farinha sem tipo claro = classificar depois
        // (empate entre dois — ex.: farinha fina × grossa com o mesmo nome base — não chuta)
        let melhor: Insumo | null = null; let nota = 0; let segunda = 0;
        for (const i of lista) {
          const s = similaridade(it.xProd, i.nome);
          if (s > nota) { segunda = nota; nota = s; melhor = i; } else if (s > segunda) segunda = s;
        }
        if (melhor && nota >= 0.5 && nota > segunda) destino = String(melhor.id);
        else if (/FARINHA|MANDIOCA/i.test(it.xProd)) destino = farinhas.length === 1 ? String(farinhas[0].id) : ACLASSIFICAR;
        else destino = IGNORAR;
      }
      const un = destino === IGNORAR ? "un" : unidadeDe(destino);
      const q = qtdSugerida(it, un, lem?.fator);
      const bags = ehFarinha(destino) ? Math.max(1, Math.round(q / 1000)) : 1;
      return { item: it, destino, qtd: fmt(q), bags: String(bags) };
    });
    setNf(n);
    setLinhas(ls);
    setPrefixo((n.emitente || n.razaoSocial || "BAG").split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10));
    setRateio(!!n.totais && (n.totais.frete + n.totais.ipi + n.totais.st + n.totais.outras) > 0);
  }

  async function lerXml(f: File | undefined) {
    if (!f) return;
    try { montar(parseNfe(await f.text())); } catch (e) { toast.error((e as Error).message); }
    if (arquivo.current) arquivo.current.value = "";
  }

  async function lerTiny(n: NonNullable<typeof nfsTiny.data>[number]) {
    setLendo(true);
    const { data, error } = await supabaseExternal.from("compras_nf_itens")
      .select("id_item, sku, descricao, ncm, quantidade, valor_unitario, valor_total").eq("nf_tiny_id", n.tiny_id).order("id_item");
    setLendo(false);
    if (error) return toast.error(error.message);
    const itens = (data ?? []) as Array<{ id_item: number; sku: string | null; descricao: string | null; ncm: string | null; quantidade: number; valor_unitario: number; valor_total: number | null }>;
    if (!itens.length) return toast.error("Essa NF ainda não tem os itens lidos do Tiny. Suba o XML da NF-e.");
    montar({
      chave: n.chave_acesso, numero: String(Number(n.numero) || n.numero), numeroBruto: n.numero, serie: n.serie ?? "",
      emissao: n.data_emissao, emitente: n.fornecedor_nome ?? "", razaoSocial: n.fornecedor_nome ?? "", cnpj: n.fornecedor_cnpj ?? "",
      valor: Number(n.valor ?? 0),
      itens: itens.map((x, i) => ({
        n: i + 1, cProd: x.sku ?? String(x.id_item), ean: null, eanTrib: null, xProd: x.descricao ?? "", uCom: "", qCom: Number(x.quantidade),
        uTrib: "", qTrib: Number(x.quantidade), vProd: Number(x.valor_total ?? x.quantidade * x.valor_unitario), vDesc: 0, ncm: x.ncm ?? undefined,
      })),
      totais: n.valor_frete ? { frete: Number(n.valor_frete), ipi: 0, st: 0, outras: 0, desconto: 0 } : undefined,
    });
  }

  const extras = nf?.totais ? nf.totais.frete + nf.totais.ipi + nf.totais.st + nf.totais.outras : 0;
  const totalProdutos = nf ? nf.itens.reduce((s, x) => s + valorLiquido(x), 0) : 0;
  const custoLinha = (l: Linha) => {
    const v = valorLiquido(l.item);
    return v + (rateio && totalProdutos > 0 ? (extras * v) / totalProdutos : 0);
  };
  const set = (i: number, campo: Partial<Linha>) => setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, ...campo } : l)));
  function trocarDestino(i: number, destino: string) {
    const l = linhas[i];
    const un = destino === IGNORAR ? "un" : unidadeDe(destino);
    const q = qtdSugerida(l.item, un);
    set(i, { destino, qtd: fmt(q), bags: String(ehFarinha(destino) ? Math.max(1, Math.round(q / 1000)) : 1) });
  }

  function fechar() { setNf(null); setLinhas([]); setBusca(""); onFechar(); }

  async function salvar() {
    if (!nf) return;
    const usadas = linhas.filter((l) => l.destino !== IGNORAR);
    if (!usadas.length) return toast.error("Nenhuma linha virou matéria-prima — escolha o que é cada item.");
    for (const l of usadas) {
      const q = numDec(l.qtd);
      if (!(q > 0)) return toast.error(`Quantidade inválida em "${l.item.xProd}".`);
      if (ehFarinha(l.destino) && !(num(l.bags) >= 1)) return toast.error(`Informe quantos big bags em "${l.item.xProd}".`);
    }
    if (ja.data?.length && !window.confirm(`Esta NF já tem ${ja.data.length} entrada(s) registrada(s) (${ja.data.slice(0, 4).map((x) => x.codigo).join(", ")}…). Registrar mesmo assim?`)) return;
    const cnpj = nf.cnpj.replace(/\D/g, "") || null;
    const base = {
      fornecedor_nome: nf.razaoSocial || nf.emitente || null, fornecedor_cnpj: cnpj, nf_numero: nf.numero || null,
      nf_serie: nf.serie || null, nf_chave: nf.chave, nf_emissao: nf.emissao, recebido_em: recebido,
    };
    const pfx = (prefixo || "BAG").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "BAG";
    let seqBag = 0;
    const rows: Record<string, unknown>[] = [];
    for (const l of usadas) {
      const q = numDec(l.qtd);
      const custoUn = Math.round((custoLinha(l) / q) * 10000) / 10000;
      const comum = {
        ...base, insumo_id: l.destino === ACLASSIFICAR ? null : Number(l.destino), nf_item_codigo: l.item.cProd || null,
        ncm: l.item.ncm ?? null, cfop: l.item.cfop ?? null, custo_un: custoUn,
        obs: `NF ${nf.numero}: ${l.item.xProd}`.slice(0, 300),
      };
      if (ehFarinha(l.destino)) {
        const n = Math.max(1, Math.floor(num(l.bags)));
        const cada = Math.round((q / n) * 1000) / 1000;
        for (let k = 0; k < n; k++) {
          seqBag += 1;
          rows.push({ ...comum, quantidade: cada, codigo: `${pfx}-${nf.numero.replace(/\D/g, "") || recebido.replace(/-/g, "")}-${String(seqBag).padStart(2, "0")}` });
        }
      } else rows.push({ ...comum, quantidade: q });
    }
    setSalvando(true);
    const { error } = await supabaseExternal.from("producao_entrada").insert(rows as never);
    setSalvando(false);
    if (error) return toast.error(error.code === "23505" ? `Já existe big bag com o código ${pfx}-${nf.numero}-01. Mude o prefixo.` : erroMsg(error));
    // lembra o de-para deste fornecedor (destino + quantas unidades por unidade da nota)
    try {
      const lem = lerLembrados();
      for (const l of linhas) {
        const q = numDec(l.qtd);
        lem[chaveLembrar(nf.cnpj, l.item.xProd)] = { destino: l.destino, fator: l.destino !== IGNORAR && l.item.qCom > 0 && q > 0 ? q / l.item.qCom : 0 };
      }
      localStorage.setItem(LEMBRAR, JSON.stringify(lem));
    } catch { /* sem armazenamento local */ }
    toast.success(`${rows.length} entrada(s) registradas da NF ${nf.numero}.`);
    void qc.invalidateQueries({ queryKey: ["producao"] });
    fechar();
  }

  const destinoOpcoes = (
    <>
      <option value={IGNORAR}>não é matéria-prima (não registrar)</option>
      {lista.filter((i) => i.tipo === "farinha").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
      <option value={ACLASSIFICAR}>Farinha — classificar depois</option>
      {lista.filter((i) => i.tipo !== "farinha").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
    </>
  );

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && fechar()}>
      <DialogContent className="pm-ui max-w-5xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)", maxHeight: "90vh", overflowY: "auto" }}>
        <DialogHeader><DialogTitle>Entrada de matéria-prima pela NF</DialogTitle></DialogHeader>
        {!nf ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Botao tom={origem === "xml" ? "primario" : "secundario"} onClick={() => setOrigem("xml")}>XML da NF-e</Botao>
              <Botao tom={origem === "tiny" ? "primario" : "secundario"} onClick={() => setOrigem("tiny")}>NF que já está no sistema (Tiny)</Botao>
            </div>
            {origem === "xml" ? (
              <div style={{ border: "2px dashed var(--pm-bc)", borderRadius: 12, padding: 24, textAlign: "center" }}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void lerXml(e.dataTransfer.files?.[0]); }}>
                <p style={{ margin: "0 0 10px", fontSize: 13.5 }}>Arraste o XML da NF-e aqui ou</p>
                <input ref={arquivo} type="file" accept=".xml,text/xml" style={{ display: "none" }} onChange={(e) => void lerXml(e.target.files?.[0])} />
                <Botao tom="primario" onClick={() => arquivo.current?.click()}>Escolher o arquivo XML</Botao>
                <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--pm-t3)" }}>Com o XML vêm unidade, NCM, CFOP, frete e IPI da nota.</p>
              </div>
            ) : (
              <div>
                <Campo rotulo="Procurar a NF" dica="nome do fornecedor, número da nota ou CNPJ">
                  <Entrada autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="ex.: Lotus, 19532" />
                </Campo>
                {busca.trim().length >= 2 && (
                  nfsTiny.isLoading ? <p style={{ fontSize: 13, color: "var(--pm-t3)" }}>Procurando…</p>
                  : !(nfsTiny.data ?? []).length ? <p style={{ fontSize: 13, color: "var(--pm-t3)" }}>Nenhuma NF de entrada encontrada.</p>
                  : (
                    <table style={{ ...tabela, marginTop: 8 }}>
                      <thead><tr><th style={th}>NF</th><th style={th}>Emissão</th><th style={th}>Fornecedor</th><th style={{ ...th, textAlign: "right" }}>Itens</th><th style={{ ...th, textAlign: "right" }}>Valor</th><th style={th} /></tr></thead>
                      <tbody>
                        {(nfsTiny.data ?? []).map((n) => (
                          <tr key={n.tiny_id}>
                            <td style={{ ...td, fontWeight: 600 }}>{n.numero}{n.serie ? `/${n.serie}` : ""}</td>
                            <td style={td}>{dataBR(n.data_emissao)}</td>
                            <td style={td}>{n.fornecedor_nome}</td>
                            <td style={{ ...td, textAlign: "right" }}>{int(n.itens_qtd)}</td>
                            <td style={{ ...td, textAlign: "right" }}>{brl(n.valor)}</td>
                            <td style={{ ...td, textAlign: "right" }}><Botao onClick={() => lerTiny(n)} disabled={lendo}>Usar esta</Botao></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}
                <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: "8px 0 0" }}>A NF do Tiny não traz a unidade (fardo, milheiro, tonelada): confira a quantidade de cada linha.</p>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, padding: 10, borderRadius: 9, background: "var(--pm-s2)" }}>
              <b>NF {nf.numero}{nf.serie ? `/${nf.serie}` : ""}</b> · {nf.razaoSocial || nf.emitente} · emitida {dataBR(nf.emissao)} · {brl(nf.valor)}
              {extras > 0 && <> · frete/IPI/outros {brl(extras)}</>}
              {ja.data && ja.data.length > 0 && <div style={{ marginTop: 4 }}><Selo tom="a">esta NF já tem {ja.data.length} entrada(s): {ja.data.slice(0, 5).map((x) => x.codigo).join(", ")}</Selo></div>}
            </div>
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <Campo rotulo="Recebido em"><Entrada type="date" value={recebido} onChange={(e) => setRecebido(e.target.value)} /></Campo>
              {linhas.some((l) => ehFarinha(l.destino)) && (
                <Campo rotulo="Prefixo dos big bags" dica={`fica ${prefixo || "BAG"}-${nf.numero}-01…`}>
                  <Entrada value={prefixo} onChange={(e) => setPrefixo(e.target.value)} />
                </Campo>
              )}
              {extras > 0 && (
                <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center", marginTop: 18 }}>
                  <input type="checkbox" checked={rateio} onChange={(e) => setRateio(e.target.checked)} /> somar frete/IPI/outros ao custo (por valor)
                </label>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={tabela}>
                <thead><tr>
                  <th style={th}>Linha da nota</th><th style={{ ...th, textAlign: "right" }}>Na nota</th><th style={{ ...th, minWidth: 220 }}>Vira matéria-prima</th>
                  <th style={{ ...th, minWidth: 110 }}>Quantidade</th><th style={{ ...th, minWidth: 80 }}>Big bags</th><th style={{ ...th, textAlign: "right" }}>Custo</th>
                </tr></thead>
                <tbody>
                  {linhas.map((l, i) => {
                    const ign = l.destino === IGNORAR;
                    const un = ign ? "un" : unidadeDe(l.destino);
                    const q = numDec(l.qtd);
                    const fa = !ign && ehFarinha(l.destino);
                    const nb = Math.max(1, Math.floor(num(l.bags) || 1));
                    return (
                      <tr key={i} style={{ opacity: ign ? 0.55 : 1 }}>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{l.item.xProd}</div>
                          <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{l.item.cProd}{l.item.ncm ? ` · NCM ${l.item.ncm}` : ""}{l.item.cfop ? ` · CFOP ${l.item.cfop}` : ""}</div>
                        </td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          {fmt(l.item.qCom)} {l.item.uCom}
                          <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{brl(valorLiquido(l.item))}</div>
                        </td>
                        <td style={td}><Escolha value={l.destino} onChange={(e) => trocarDestino(i, e.target.value)}>{destinoOpcoes}</Escolha></td>
                        <td style={td}>
                          {!ign && (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                              <Entrada inputMode="decimal" value={l.qtd} onChange={(e) => set(i, { qtd: e.target.value })} style={{ width: 100 }} />
                              <span style={{ fontSize: 12 }}>{un}</span>
                            </div>
                          )}
                        </td>
                        <td style={td}>
                          {fa && (
                            <>
                              <Entrada inputMode="numeric" value={l.bags} onChange={(e) => set(i, { bags: e.target.value })} style={{ width: 64 }} />
                              {q > 0 && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{kg(q / nb, 0)} cada</div>}
                            </>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          {!ign && q > 0 ? (
                            <>
                              {brl(custoLinha(l) / q, 4)}/{un}
                              <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>total {brl(custoLinha(l))}</div>
                            </>
                          ) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: 0 }}>
              Confira a quantidade na unidade da matéria-prima (kg da farinha; unidades de saco e etiqueta — nota em milheiro ou fardo precisa converter).
              A escolha de cada linha fica lembrada para as próximas notas deste fornecedor.
            </p>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <Botao tom="fantasma" onClick={() => { setNf(null); setLinhas([]); }}>Outra NF</Botao>
              <div style={{ display: "flex", gap: 8 }}>
                <Botao onClick={fechar} disabled={salvando}>Cancelar</Botao>
                <Botao tom="primario" onClick={salvar} disabled={salvando}>{salvando ? "Registrando…" : "Registrar entradas"}</Botao>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
