// Custo variável por unidade de cada produto fabricado, no cenário escolhido.
// O número vem de custo_cenario_calcular (banco). Editar um campo grava em custo_cenario_sku e o banco recalcula.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Botao, Campo, Cartao, Entrada, Escolha, Selo, tabela, td, th } from "../ui";
import { brl, int, kg, useFotos } from "@/lib/producao";
import { Produtividade } from "./Produtividade";
import { LinhaCanal } from "./Precificacao";
import {
  FONTE_KG, FONTE_MOD, FONTE_PRECO_KG, num, pct, salvarSku, salvarSkus, useCenarioSkus, useCusto, useMargens, useMatriz, useMedicoes, useRecalcular,
  type Cenario, type CenarioSku, type CustoSku, type LinhaMatriz,
} from "@/lib/custos";

const CORES = { materia: "#8B6F47", embalagem: "#5B8DEF", mod: "#E0A030", premio: "#9C6ADE", cif: "#7A8699" };

export function PainelCusto({ cenario }: { cenario: Cenario }) {
  const custo = useCusto(cenario.id);
  const skus = useCenarioSkus(cenario.id);
  const fotos = useFotos((custo.data ?? []).map((c) => c.sku));
  const [aberto, setAberto] = useState<string | null>(null);
  // visual: cartões (um por produto) ou linhas (tabela, cada coluna um custo; clicar na célula explica) — pedido do dono, 09/nov
  const [visual, setVisual] = useState<"cartoes" | "linhas">(() => { try { return localStorage.getItem("custos.visual") === "linhas" ? "linhas" : "cartoes"; } catch { return "cartoes"; } });
  const trocarVisual = (v: "cartoes" | "linhas") => { setVisual(v); try { localStorage.setItem("custos.visual", v); } catch { /* sem armazenamento */ } };
  const linhas = custo.data ?? [];
  const porSku = useMemo(() => Object.fromEntries((skus.data ?? []).map((s) => [s.sku, s])), [skus.data]);
  const med = useMedicoes();
  // preços por canal (preco_cenario_matriz) para o bloco "Preço nos marketplaces" de cada cartão
  const matriz = useMatriz(cenario.id);
  const margens = useMargens();
  const mcs = useMemo(() => (margens.data ?? []).filter((m) => m.ativo).map((m) => Number(m.mc_pct)), [margens.data]);
  const matrizPorSku = useMemo(() => {
    const m: Record<string, LinhaMatriz[]> = {};
    for (const l of matriz.data ?? []) (m[l.sku] ??= []).push(l);
    return m;
  }, [matriz.data]);
  // produtividade de cada produto (lotes limpos, view_custo_mod_medida): a do próprio SKU ou, sem lote limpo, a do grupo
  const prod = useMemo(() => {
    const m = med.data?.mod ?? [];
    const grupo = (c: CustoSku) => m.find((x) => x.sku == null && (c.mistura ? x.grupo === "Misturas" : x.grupo.startsWith("Mandioca pura " + String(Number(c.peso_nominal_kg)).replace(".", ","))));
    return Object.fromEntries(linhas.map((c) => {
      const proprio = m.find((x) => x.sku === c.sku);
      return [c.sku, proprio ? { ...proprio, do_grupo: false } : grupo(c) ? { ...grupo(c)!, do_grupo: true } : null];
    }));
  }, [med.data, linhas]);

  if (custo.isLoading) return <Cartao><span style={{ color: "var(--pm-t3)" }}>Calculando…</span></Cartao>;
  if (custo.error) return <Cartao><span style={{ color: "var(--pm-r)" }}>Não deu para calcular: {(custo.error as Error).message}</span></Cartao>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Produtividade />
      <AcoesEmMassa cenario={cenario} linhas={linhas} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", border: "1px solid var(--pm-bc)", borderRadius: 9, overflow: "hidden" }}>
          {(["cartoes", "linhas"] as const).map((k) => (
            <button key={k} type="button" onClick={() => trocarVisual(k)}
              style={{ border: 0, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", background: visual === k ? "var(--pm-a)" : "var(--pm-s)", color: visual === k ? "var(--pm-oa)" : "var(--pm-t)" }}>
              {k === "cartoes" ? "Cartões" : "Linhas"}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{visual === "linhas" ? "Cada coluna é um custo. Clique num valor para ver como ele foi calculado." : "Um cartão por produto, com matéria-prima, preço nos marketplaces e ajustes."}</span>
        <div style={{ flex: 1 }} />
        <Legenda />
      </div>
      {visual === "linhas" ? (
        <TabelaCustos linhas={linhas} fotos={fotos.data ?? {}} cenario={cenario} cfgs={porSku} prod={prod} matrizPorSku={matrizPorSku} mcs={mcs} precosCarregando={matriz.isLoading} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(520px, 1fr))", gap: 12 }}>
          {linhas.map((c) => (
            <CartaoSku key={c.sku} c={c} foto={fotos.data?.[c.sku]} aberto={aberto === c.sku}
              onAbrir={() => setAberto(aberto === c.sku ? null : c.sku)} cfg={porSku[c.sku]} pronto={!!skus.data} cenario={cenario} prod={prod[c.sku]}
              precos={matrizPorSku[c.sku]} mcs={mcs} precosCarregando={matriz.isLoading} />
          ))}
        </div>
      )}
      <MaoDeObra />
      <MateriaPrima />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual em linhas: uma linha por produto, uma coluna por custo. Clicar numa célula abre, embaixo da
// linha, a explicação daquele custo (de onde veio cada número) — e, na mão de obra, o campo de trocar.
// ---------------------------------------------------------------------------
type Coluna = "materia" | "embalagem" | "mod" | "premio" | "cif" | "total";
const COLUNAS: Array<{ k: Coluna; nome: string; cor?: string }> = [
  { k: "materia", nome: "Matéria-prima", cor: CORES.materia }, { k: "embalagem", nome: "Embalagem + etiqueta", cor: CORES.embalagem },
  { k: "mod", nome: "Mão de obra", cor: CORES.mod }, { k: "premio", nome: "Prêmio por lote", cor: CORES.premio },
  { k: "cif", nome: "Indireto (CIF)", cor: CORES.cif }, { k: "total", nome: "Custo variável" },
];
const valorColuna = (c: CustoSku, k: Coluna): number | null =>
  k === "materia" ? c.materia : k === "embalagem" ? c.embalagem + c.etiqueta : k === "mod" ? c.mod : k === "premio" ? c.premio ?? 0 : k === "cif" ? c.cif ?? 0 : c.cv;

type ProdSku = { un_h_linha: number; un_homem_hora: number; lotes: number; un_total: number; do_grupo: boolean } | null | undefined;

function TabelaCustos({ linhas, fotos, cenario, cfgs, prod, matrizPorSku, mcs, precosCarregando }: {
  linhas: CustoSku[]; fotos: Record<string, string>; cenario: Cenario; cfgs: Record<string, CenarioSku>; prod: Record<string, ProdSku>;
  matrizPorSku: Record<string, LinhaMatriz[]>; mcs: number[]; precosCarregando: boolean;
}) {
  const [aberto, setAberto] = useState<{ sku: string; col: Coluna } | null>(null);
  const clicar = (sku: string, col: Coluna) => setAberto(aberto && aberto.sku === sku && aberto.col === col ? null : { sku, col });
  const nCols = 2 + COLUNAS.length;
  return (
    <Cartao>
      <div style={{ overflowX: "auto" }}>
        <table style={tabela}>
          <thead><tr>
            <th style={th}>Produto</th>
            {COLUNAS.map((col) => (
              <th key={col.k} style={{ ...th, textAlign: "right" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{col.cor && <span style={{ width: 8, height: 8, borderRadius: 2, background: col.cor }} />}{col.nome}</span>
              </th>
            ))}
            <th style={{ ...th, textAlign: "right" }}>vs padrão</th>
          </tr></thead>
          <tbody>
            {linhas.map((c) => {
              const ab = aberto?.sku === c.sku ? aberto.col : null;
              const dif = c.cv - c.cv_padrao;
              return (
                <Fragment key={c.sku}>
                  <tr style={{ background: ab ? "var(--pm-s2)" : undefined }}>
                    <td style={{ ...td, minWidth: 260 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        {fotos[c.sku] ? <img src={fotos[c.sku]} alt="" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover", background: "#fff", flexShrink: 0 }} /> : <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--pm-s2)", flexShrink: 0 }} />}
                        <div style={{ minWidth: 0 }}>
                          <b>{c.sku}</b> {c.mistura && <Selo tom="azul">mistura</Selo>}{c.alerta_desperdicio && <Selo tom="r">desperdício</Selo>}
                          <div style={{ fontSize: 11.5, color: "var(--pm-t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 }} title={c.nome ?? ""}>{c.nome}</div>
                        </div>
                      </div>
                    </td>
                    {COLUNAS.map((col) => {
                      const v = valorColuna(c, col.k);
                      const sel = ab === col.k;
                      return (
                        <td key={col.k} style={{ ...td, textAlign: "right", padding: "4px 6px" }}>
                          <button type="button" onClick={() => clicar(c.sku, col.k)} title={`Ver como ${col.nome.toLowerCase()} foi calculado`}
                            style={{ border: `1px solid ${sel ? "var(--pm-a)" : "transparent"}`, borderRadius: 7, background: sel ? "var(--pm-as)" : "transparent", cursor: "pointer", color: sel ? "var(--pm-at)" : "inherit", font: "inherit",
                              fontWeight: col.k === "total" ? 750 : 600, fontSize: col.k === "total" ? 14 : 13, fontVariantNumeric: "tabular-nums", padding: "4px 8px", whiteSpace: "nowrap" }}
                            className="pm-hv">
                            {v == null ? "—" : brl(v)}
                          </button>
                        </td>
                      );
                    })}
                    <td style={{ ...td, textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums", color: Math.abs(dif) < 0.005 ? "var(--pm-t3)" : dif > 0 ? "var(--pm-r)" : "var(--pm-g)", whiteSpace: "nowrap" }}>
                      {Math.abs(dif) < 0.005 ? "= padrão" : `${dif > 0 ? "+" : ""}${brl(dif)}`}
                    </td>
                  </tr>
                  {ab && (
                    <tr>
                      <td colSpan={nCols} style={{ ...td, padding: "0 8px 12px", background: "var(--pm-s2)", borderBottom: "2px solid var(--pm-a)" }}>
                        <ExplicacaoCusto c={c} col={ab} cenario={cenario} cfg={cfgs[c.sku]} prod={prod[c.sku]} precos={matrizPorSku[c.sku]} mcs={mcs} precosCarregando={precosCarregando} onFechar={() => setAberto(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Cartao>
  );
}

function ExplicacaoCusto({ c, col, cenario, cfg, prod, precos, mcs, precosCarregando, onFechar }: {
  c: CustoSku; col: Coluna; cenario: Cenario; cfg?: CenarioSku; prod: ProdSku; precos?: LinhaMatriz[]; mcs: number[]; precosCarregando: boolean; onFechar: () => void;
}) {
  const [ajustar, setAjustar] = useState(false);
  const titulo = COLUNAS.find((x) => x.k === col)!;
  const farinhaRs = (Number(c.kg_farinha) || 0) * (Number(c.preco_kg) || 0);
  const misturaRs = c.mistura ? (Number(c.un_mistura) || 0) * (Number(c.preco_mistura_un) || 0) : 0;
  const L = ({ r, v, sub }: { r: React.ReactNode; v?: React.ReactNode; sub?: React.ReactNode }) => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "0 12px", alignItems: "baseline", padding: "3px 0", borderBottom: "1px dashed var(--pm-b)" }}>
      <span>{r}{sub && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{sub}</div>}</span>
      {v != null && <b style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{v}</b>}
    </div>
  );
  const texto: React.ReactNode = (() => {
    switch (col) {
      case "materia": return (
        <>
          <p style={{ margin: "0 0 6px" }}>O que entra no saco e quanto cada parte custa, no cenário "{cenario.nome}".</p>
          <L r={<><b>{c.farinha_nome ?? "Farinha (não identificada)"}</b> — {num(c.kg_farinha ?? c.kg_un, 3)} kg × {brl(c.preco_kg, 4)}/kg</>}
            v={brl(farinhaRs)}
            sub={<>consumo <b>{FONTE_KG[c.kg_un_fonte]}</b> (padrão da ficha {num(c.kg_un_padrao, 3)} kg · medido no fechamento do big bag {c.kg_un_medido == null ? "—" : num(c.kg_un_medido, 3)} kg{c.bags_medidos ? `, ${c.bags_medidos} bags` : ""}) · preço <b>{FONTE_PRECO_KG[c.preco_kg_fonte] ?? c.preco_kg_fonte}</b> (última entrada {brl(c.preco_kg_ultima, 4)} · referência {brl(c.preco_kg_referencia, 4)} · média 90 d {brl(c.preco_kg_media_90d, 4)})</>} />
          {c.mistura && <L r={<><b>{c.mistura_nome ?? "Componente da mistura"}</b> — {num(c.un_mistura, 3)} un × {brl(c.preco_mistura_un)}</>} v={brl(misturaRs)} sub="produto comprado; preço = custo do cadastro do Tiny (ou o manual do cenário)" />}
          <L r={<b>Matéria-prima por saco</b>} v={brl(c.materia)} />
          {c.alerta_desperdicio && <div style={{ color: "var(--pm-r)", fontWeight: 600, marginTop: 6 }}>Consumo medido {pct((c.kg_un_medido ?? 0) / c.kg_un_padrao - 1)} acima do padrão: {brl(c.desperdicio_un)} de desperdício por saco, {brl(c.desperdicio_mes, 0)} por mês a {int(cenario.volume_mes_un)} un.</div>}
        </>
      );
      case "embalagem": return (
        <>
          <p style={{ margin: "0 0 6px" }}>Saco e etiqueta, por unidade. O preço é o custo médio das entradas de matéria-prima, salvo valor manual no cenário.</p>
          <L r={<><b>{c.embalagem_nome ?? "Embalagem"}</b></>} v={brl(c.embalagem, 4)} sub={cfg?.embalagem_rs_un_manual != null ? "valor manual do cenário" : "custo médio do cadastro de insumos"} />
          <L r={<b>Etiqueta</b>} v={brl(c.etiqueta, 4)} sub={cfg?.etiqueta_rs_un_manual != null ? "valor manual do cenário" : c.etiqueta > 0 ? "custo médio do cadastro de insumos" : "embalagem impressa, sem etiqueta"} />
          <L r={<b>Embalagem + etiqueta por saco</b>} v={brl(c.embalagem + c.etiqueta)} />
        </>
      );
      case "mod": return (
        <>
          <p style={{ margin: "0 0 6px" }}>Custo das pessoas que fizeram o lote: diarista = diária ÷ {num(cenario.horas_dia_diarista, 0)} h; mensalista = salário × {num(cenario.fator_encargos, 2)} de encargos ÷ {int(cenario.horas_mes_mensalista)} h. Dividido pelos sacos que a equipe produziu por hora.</p>
          <L r={<><b>Fonte neste cenário:</b> {FONTE_MOD[c.mod_fonte] ?? c.mod_fonte}</>} />
          {c.mod_un_homem_hora != null && <L r={<>Produtividade medida</>} v={`${num(c.mod_un_homem_hora, 1)} sacos por pessoa/hora`}
            sub={prod ? `${num(prod.un_h_linha, 1)} sacos/h de linha · ${prod.do_grupo ? "média do grupo (este produto tem menos de 2 lotes / 200 sacos limpos)" : `${prod.lotes} ${prod.lotes === 1 ? "lote" : "lotes"}, ${int(prod.un_total)} sacos`}` : undefined} />}
          {c.mod_rs_hora != null && <L r="Custo da hora de trabalho" v={`${brl(c.mod_rs_hora)}/homem-hora`} sub="média ponderada das pessoas dos lotes considerados" />}
          {c.mod_un_homem_hora != null && c.mod_rs_hora != null && <L r={<>{brl(c.mod_rs_hora)} ÷ {num(c.mod_un_homem_hora, 1)} sacos</>} v={brl(c.mod_rs_hora / c.mod_un_homem_hora)} />}
          <div style={{ marginTop: 8, maxWidth: 420 }}><MaoDeObraRapida c={c} cenario={cenario} /></div>
        </>
      );
      case "premio": return (
        <>
          <p style={{ margin: "0 0 6px" }}>Prêmio pago à equipe por big bag fechado, rateado pelos sacos que o bag rende.</p>
          <L r={<>{brl(cfg?.premio_rs_lote ?? 50)} por big bag ÷ {num(c.un_por_lote, 0)} sacos</>} v={brl(c.premio, 4)} sub={cfg?.un_por_lote != null ? "sacos por bag informados no cenário" : `sacos por bag = 1.000 kg ÷ ${num(c.kg_farinha ?? c.kg_un, 3)} kg de farinha por saco`} />
        </>
      );
      case "cif": return (
        <>
          <p style={{ margin: "0 0 6px" }}>Custo indireto de fabricação por saco: energia, espaço, depreciação da seladora. É um valor informado no cenário (hoje {brl(c.cif ?? 0, 4)}), não medido.</p>
          <L r="Indireto por saco" v={brl(c.cif ?? 0, 4)} sub={(c.cif ?? 0) === 0 ? "zerado — use 'Ajustar tudo no cenário' ou a ação em massa 'CIF R$/un' para informar" : "informado no cenário"} />
        </>
      );
      default: return (
        <>
          <p style={{ margin: "0 0 6px" }}>Soma das colunas. É o custo variável de fabricar um saco — sem mão de obra fixa, sem venda.</p>
          <L r="Matéria-prima" v={brl(c.materia)} /><L r="Embalagem + etiqueta" v={brl(c.embalagem + c.etiqueta)} /><L r="Mão de obra" v={c.mod == null ? "—" : brl(c.mod)} />
          <L r="Prêmio por lote" v={brl(c.premio ?? 0)} /><L r="Indireto (CIF)" v={brl(c.cif ?? 0)} />
          <L r={<b>Custo variável</b>} v={<span style={{ fontSize: 15 }}>{brl(c.cv)}</span>} sub={<>padrão da ficha {brl(c.cv_padrao)} · medido {c.cv_medido == null ? "—" : brl(c.cv_medido)}</>} />
          <div style={{ marginTop: 10 }}><PrecosMarketplace c={c} precos={precos} mcs={mcs} carregando={precosCarregando} cenario={cenario} /></div>
        </>
      );
    }
  })();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, paddingTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {titulo.cor && <span style={{ width: 10, height: 10, borderRadius: 3, background: titulo.cor }} />}
        <b style={{ fontSize: 13 }}>{titulo.nome} — {c.sku}</b>
        <div style={{ flex: 1 }} />
        <Botao tom="fantasma" onClick={() => setAjustar((v) => !v)} style={{ height: 28 }}>{ajustar ? "Fechar ajustes" : "Ajustar tudo no cenário"}</Botao>
        <Botao tom="fantasma" onClick={onFechar} style={{ height: 28 }}>Fechar</Botao>
      </div>
      <div style={{ maxWidth: 900 }}>{texto}</div>
      {c.avisos.length > 0 && <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "var(--pm-am)" }}>{c.avisos.map((a) => <li key={a}>{a}</li>)}</ul>}
      {ajustar && <EditorSku c={c} cfg={cfg} cenario={cenario} />}
    </div>
  );
}

function Legenda() {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--pm-t2)" }}>
      {[["materia", "Matéria-prima"], ["embalagem", "Embalagem + etiqueta"], ["mod", "Mão de obra"], ["premio", "Prêmio por lote"], ["cif", "Indireto (CIF)"]].map(([k, n]) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: CORES[k as keyof typeof CORES] }} />{n}
        </span>
      ))}
    </div>
  );
}

function CartaoSku({ c, foto, aberto, onAbrir, cfg, pronto, cenario, prod, precos, mcs, precosCarregando }: { c: CustoSku; foto?: string; aberto: boolean; onAbrir: () => void; cfg?: CenarioSku; pronto: boolean; cenario: Cenario;
  prod?: { un_h_linha: number; un_homem_hora: number; lotes: number; un_total: number; do_grupo: boolean } | null;
  precos?: LinhaMatriz[]; mcs: number[]; precosCarregando: boolean }) {
  const partes = [
    { k: "materia", v: c.materia }, { k: "embalagem", v: c.embalagem + c.etiqueta }, { k: "mod", v: c.mod ?? 0 },
    { k: "premio", v: c.premio ?? 0 }, { k: "cif", v: c.cif ?? 0 },
  ];
  const total = partes.reduce((s, p) => s + p.v, 0) || 1;
  const fonteKg = c.kg_un_fonte;
  const tomKg = fonteKg === "medido" ? "g" : fonteKg === "manual" ? "azul" : fonteKg === "padrao_sem_medida" ? "a" : "n";
  return (
    <section style={{ background: "var(--pm-s)", border: `1px solid ${c.alerta_desperdicio ? "var(--pm-r)" : "var(--pm-bs)"}`, borderRadius: 14, padding: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column", gap: 10, gridColumn: aberto ? "1 / -1" : undefined }}>
      <header style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {foto ? <img src={foto} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 8, background: "#fff", flexShrink: 0 }} />
          : <div style={{ width: 46, height: 46, borderRadius: 8, background: "var(--pm-s2)", flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{c.sku} {c.mistura && <Selo tom="azul">mistura</Selo>}</div>
          <div style={{ fontSize: 12, color: "var(--pm-t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.nome ?? ""}>{c.nome}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 24, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{brl(c.cv)}</div>
          <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>custo variável / un</div>
        </div>
      </header>

      <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "var(--pm-s2)" }} title="Composição do custo">
        {partes.filter((p) => p.v > 0).map((p) => (
          <div key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: CORES[p.k as keyof typeof CORES] }} title={`${p.k}: ${brl(p.v)}`} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 12.5 }}>
        <Linha r="Matéria-prima" v={brl(c.materia)} cor={CORES.materia} />
        <Linha r="Embalagem + etiqueta" v={brl(c.embalagem + c.etiqueta)} cor={CORES.embalagem} />
        <MaoDeObraRapida c={c} cenario={cenario} />
        <Linha r="Prêmio + CIF" v={brl((c.premio ?? 0) + (c.cif ?? 0))} cor={CORES.premio} />
      </div>

      <MateriaConsiderada c={c} tomKg={tomKg as "g" | "azul" | "a" | "n"} />

      <div style={{ fontSize: 12, color: "var(--pm-t2)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        {prod && <span style={{ width: "100%" }}>Produtividade <b>{num(prod.un_h_linha, 1)} sacos/h</b> de linha · <b>{num(prod.un_homem_hora, 1)}</b> por pessoa/hora{prod.do_grupo ? " (média do grupo)" : ` (${prod.lotes} ${prod.lotes === 1 ? "lote" : "lotes"}, ${int(prod.un_total)} sacos)`}</span>}
        <span>Padrão <b>{brl(c.cv_padrao)}</b></span>
        <span>Medido <b>{c.cv_medido == null ? "—" : brl(c.cv_medido)}</b></span>
        <span>Cenário <b>{brl(c.cv)}</b></span>
        {Math.abs(c.cv - c.cv_padrao) >= 0.005 && <span style={{ color: c.cv > c.cv_padrao ? "var(--pm-r)" : "var(--pm-g)" }}>{c.cv > c.cv_padrao ? "+" : ""}{brl(c.cv - c.cv_padrao)} vs padrão</span>}
      </div>

      {c.alerta_desperdicio && (
        <div style={{ background: "var(--pm-rs)", color: "var(--pm-r)", borderRadius: 9, padding: "8px 10px", fontSize: 12.5, fontWeight: 600 }}>
          Consumo medido {num(c.kg_un_medido, 3)} kg/un está {pct((c.kg_un_medido ?? 0) / c.kg_un_padrao - 1)} acima do padrão ({num(c.kg_un_padrao, 3)}):
          desperdício de {brl(c.desperdicio_un)} por saco, {brl(c.desperdicio_mes, 0)} por mês a {int(cenario.volume_mes_un)} un.
        </div>
      )}
      {c.avisos.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "var(--pm-am)" }}>{c.avisos.map((a) => <li key={a}>{a}</li>)}</ul>
      )}

      <PrecosMarketplace c={c} precos={precos} mcs={mcs} carregando={precosCarregando} cenario={cenario} />

      <div><Botao onClick={onAbrir}>{aberto ? "Fechar" : "Ajustar tudo no cenário"}</Botao></div>
      {aberto && (pronto ? <EditorSku c={c} cfg={cfg} cenario={cenario} /> : <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Carregando…</span>)}
    </section>
  );
}

const Linha = ({ r, v, cor }: { r: string; v: string; cor?: string }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
    <span style={{ color: "var(--pm-t3)", display: "inline-flex", alignItems: "center", gap: 6 }}>{cor && <span style={{ width: 8, height: 8, borderRadius: 2, background: cor, flexShrink: 0 }} />}{r}</span>
    <b style={{ fontVariantNumeric: "tabular-nums" }}>{v}</b>
  </div>
);

// Mão de obra editável direto no cartão (pedido do dono, 09/nov): clicar no valor abre um campo
// "R$ por saco"; salvar grava fonte_mod = manual_un no cenário e o banco recalcula. "voltar à medida" desfaz.
function MaoDeObraRapida({ c, cenario }: { c: CustoSku; cenario: Cenario }) {
  const recalcular = useRecalcular();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState("");
  const [salvando, setSalvando] = useState(false);
  const manual = c.mod_fonte.startsWith("manual");
  async function gravar(campos: Partial<CenarioSku>, msg: string) {
    setSalvando(true);
    try { await salvarSku(cenario.id, c.sku, campos); recalcular(); setEditando(false); toast.success(msg); }
    catch (e) { toast.error("Não deu para salvar", { description: (e as Error).message }); }
    finally { setSalvando(false); }
  }
  function salvar() {
    const p = Number(valor.trim().replace(",", "."));
    if (!(p >= 0) || valor.trim() === "") return toast.warning("Informe o valor em R$ por saco.");
    void gravar({ fonte_mod: "manual_un", mod_rs_un_manual: p }, `Mão de obra de ${c.sku}: ${brl(p)} por saco (cenário ${cenario.nome}).`);
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", minHeight: 22 }}>
      <span style={{ color: "var(--pm-t3)", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: CORES.mod, flexShrink: 0 }} />Mão de obra
        {manual && !editando && (
          <button type="button" onClick={() => void gravar({ fonte_mod: "medido" }, `Mão de obra de ${c.sku} voltou à medida dos lotes.`)} disabled={salvando}
            title={`Hoje: valor manual. Medida nos lotes: ${c.mod_un_homem_hora == null ? "sem medida" : `${num(c.mod_un_homem_hora, 1)} un/homem-hora a ${brl(c.mod_rs_hora)}/h`}`}
            style={{ border: 0, background: "transparent", color: "var(--pm-at)", cursor: "pointer", fontSize: 11, padding: 0 }}>manual · voltar à medida</button>
        )}
      </span>
      {editando ? (
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>R$/saco</span>
          <Entrada autoFocus inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} disabled={salvando}
            onKeyDown={(e) => { if (e.key === "Enter") salvar(); if (e.key === "Escape") setEditando(false); }} style={{ width: 72, height: 28 }} />
          <Botao tom="primario" onClick={salvar} disabled={salvando} style={{ height: 28, padding: "0 9px" }}>OK</Botao>
          <Botao tom="fantasma" onClick={() => setEditando(false)} disabled={salvando} style={{ height: 28, padding: "0 7px" }}>✕</Botao>
        </span>
      ) : (
        <button type="button" onClick={() => { setValor(c.mod == null ? "" : num(c.mod, 2)); setEditando(true); }}
          title={`${FONTE_MOD[c.mod_fonte] ?? c.mod_fonte} — clique para trocar o valor por saco`}
          style={{ border: "1px dashed var(--pm-bc)", borderRadius: 6, background: "transparent", cursor: "pointer", color: "inherit", font: "inherit", fontWeight: 700, fontVariantNumeric: "tabular-nums", padding: "0 6px", lineHeight: "20px" }}>
          {c.mod == null ? "—" : brl(c.mod)} <span style={{ fontSize: 10, fontWeight: 400, color: "var(--pm-t3)" }}>✎</span>
        </button>
      )}
    </div>
  );
}

// Qual matéria-prima está entrando na conta: farinha (nome, kg por saco e de onde veio, R$/kg e de onde veio),
// e, nas misturas, o componente comprado (quantos por saco e a que preço).
function MateriaConsiderada({ c, tomKg }: { c: CustoSku; tomKg: "g" | "azul" | "a" | "n" }) {
  const farinhaRs = (Number(c.kg_farinha) || 0) * (Number(c.preco_kg) || 0);
  const misturaRs = c.mistura ? (Number(c.un_mistura) || 0) * (Number(c.preco_mistura_un) || 0) : 0;
  return (
    <div style={{ background: "var(--pm-s2)", borderRadius: 10, padding: "8px 10px", fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--pm-t2)", textTransform: "uppercase", letterSpacing: ".04em" }}>Matéria-prima considerada</div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ minWidth: 0 }}>
          <b>{c.farinha_nome ?? "Farinha (não identificada)"}</b>
          <span style={{ color: "var(--pm-t3)" }}> · {num(c.kg_farinha ?? c.kg_un, 3)} kg/saco</span>
        </span>
        <b style={{ fontVariantNumeric: "tabular-nums" }}>{brl(farinhaRs)}</b>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Selo tom={tomKg}>{num(c.kg_un, 3)} kg/un · {FONTE_KG[c.kg_un_fonte]}</Selo>
        <Selo>{brl(c.preco_kg, 4)}/kg · {FONTE_PRECO_KG[c.preco_kg_fonte] ?? c.preco_kg_fonte}</Selo>
      </div>
      {c.mistura && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", borderTop: "1px dashed var(--pm-b)", paddingTop: 4 }}>
          <span style={{ minWidth: 0 }}>
            <b>{c.mistura_nome ?? "Componente da mistura"}</b>
            <span style={{ color: "var(--pm-t3)" }}> · {num(c.un_mistura, 3)} un/saco a {brl(c.preco_mistura_un)} (custo do Tiny)</span>
          </span>
          <b style={{ fontVariantNumeric: "tabular-nums" }}>{brl(misturaRs)}</b>
        </div>
      )}
    </div>
  );
}

// Preço nos marketplaces (e atacado) deste produto, direto no cartão — a mesma linha da aba Precificação.
function PrecosMarketplace({ c, precos, mcs, carregando, cenario }: { c: CustoSku; precos?: LinhaMatriz[]; mcs: number[]; carregando: boolean; cenario: Cenario }) {
  const [verAtacado, setVerAtacado] = useState(false);
  if (carregando) return <div style={{ fontSize: 12, color: "var(--pm-t3)" }}>Calculando os preços…</div>;
  if (!precos?.length) return null;
  const mkt = precos.filter((l) => l.tipo === "marketplace");
  const atac = precos.filter((l) => l.tipo === "atacado");
  const lista = [...mkt, ...(verAtacado ? atac : [])];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--pm-t2)", textTransform: "uppercase", letterSpacing: ".04em" }}>Preço nos marketplaces</span>
        <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>sobre {brl(c.cv)} de custo</span>
        <div style={{ flex: 1 }} />
        {atac.length > 0 && <button type="button" onClick={() => setVerAtacado((v) => !v)} style={{ border: 0, background: "transparent", color: "var(--pm-at)", cursor: "pointer", fontSize: 11.5, padding: 0 }}>{verAtacado ? "esconder atacado" : "ver atacado"}</button>}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...tabela, fontSize: 12 }}>
          <thead><tr>
            <th style={th}>Canal</th>
            {mcs.map((m) => <th key={m} style={{ ...th, textAlign: "right" }}>MC {pct(m, Math.round(m * 1000) % 10 ? 1 : 0)}</th>)}
            <th style={{ ...th, textAlign: "right" }}>Piso</th><th style={{ ...th, textAlign: "right" }}>Praticado</th><th style={{ ...th, textAlign: "right" }}>MC</th>
          </tr></thead>
          <tbody>{lista.map((l) => <LinhaCanal key={l.canal} l={l} mcs={mcs} f={(v) => v ?? null} cenario={cenario} />)}</tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor por SKU: grava em custo_cenario_sku (0,5 s depois de parar de digitar) e o banco recalcula
// ---------------------------------------------------------------------------
type Form = Record<keyof Omit<CenarioSku, "cenario_id" | "sku">, string>;
const NUMERICOS: Array<keyof Form> = ["kg_un_manual", "preco_kg_manual", "preco_mistura_un_manual", "embalagem_rs_un_manual", "etiqueta_rs_un_manual",
  "mod_rs_hora_manual", "un_homem_hora_manual", "mod_rs_un_manual", "premio_rs_lote", "un_por_lote", "cif_rs_un"];

function paraForm(cfg?: CenarioSku): Form {
  const s = (v: unknown) => (v == null ? "" : String(v).replace(".", ","));
  return {
    fonte_materia: cfg?.fonte_materia ?? "medido", kg_un_manual: s(cfg?.kg_un_manual), preco_kg_fonte: cfg?.preco_kg_fonte ?? "ultima_entrada",
    preco_kg_manual: s(cfg?.preco_kg_manual), preco_mistura_un_manual: s(cfg?.preco_mistura_un_manual),
    embalagem_rs_un_manual: s(cfg?.embalagem_rs_un_manual), etiqueta_rs_un_manual: s(cfg?.etiqueta_rs_un_manual),
    fonte_mod: cfg?.fonte_mod ?? "medido", mod_rs_hora_manual: s(cfg?.mod_rs_hora_manual), un_homem_hora_manual: s(cfg?.un_homem_hora_manual),
    mod_rs_un_manual: s(cfg?.mod_rs_un_manual), premio_rs_lote: s(cfg?.premio_rs_lote ?? 50), un_por_lote: s(cfg?.un_por_lote),
    cif_rs_un: s(cfg?.cif_rs_un ?? 0), observacao: cfg?.observacao ?? "",
  };
}

function EditorSku({ c, cfg, cenario }: { c: CustoSku; cfg?: CenarioSku; cenario: Cenario }) {
  const recalcular = useRecalcular();
  const [f, setF] = useState<Form>(() => paraForm(cfg));
  const [estado, setEstado] = useState<"" | "salvando" | "salvo" | "erro">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function mudar(campo: keyof Form, valor: string) {
    const novo = { ...f, [campo]: valor };
    setF(novo);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void gravar(novo), 500);
  }

  async function gravar(v: Form) {
    const campos: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (NUMERICOS.includes(k as keyof Form)) {
        const t = val.trim().replace(",", ".");
        if (t === "") campos[k] = k === "premio_rs_lote" ? 0 : k === "cif_rs_un" ? 0 : null;
        else if (Number.isFinite(Number(t))) campos[k] = Number(t);
        else { setEstado("erro"); return; }
      } else campos[k] = k === "observacao" ? (val.trim() || null) : val;
    }
    setEstado("salvando");
    try { await salvarSku(cenario.id, c.sku, campos as Partial<CenarioSku>); setEstado("salvo"); recalcular(); }
    catch (e) { setEstado("erro"); toast.error("Não deu para salvar", { description: (e as Error).message }); }
  }

  const grupo = (titulo: string, filhos: React.ReactNode) => (
    <fieldset style={{ border: "1px solid var(--pm-b)", borderRadius: 10, padding: 10, margin: 0, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 650, padding: "0 6px", color: "var(--pm-t2)" }}>{titulo}</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>{filhos}</div>
    </fieldset>
  );
  const ent = (campo: keyof Form, rotulo: string, dica?: string, desligado?: boolean) => (
    <Campo rotulo={rotulo} dica={dica}>
      <Entrada inputMode="decimal" value={f[campo]} disabled={desligado} onChange={(e) => mudar(campo, e.target.value)} />
    </Campo>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8, borderTop: "1px solid var(--pm-b)" }}>
      <div style={{ fontSize: 12, color: estado === "erro" ? "var(--pm-r)" : "var(--pm-t3)" }}>
        Cada mudança vale só para o cenário "{cenario.nome}" e não mexe nos dados de produção.
        {estado === "salvando" && " Salvando…"}{estado === "salvo" && " Salvo — custo recalculado."}{estado === "erro" && " Número inválido ou erro ao salvar."}
      </div>
      {grupo("Matéria-prima", <>
        <Campo rotulo="Consumo (kg por saco)" dica={`padrão ${num(c.kg_un_padrao, 3)} · medido ${c.kg_un_medido == null ? "—" : num(c.kg_un_medido, 3)}${c.bags_medidos ? ` (${c.bags_medidos} big bags)` : ""}`}>
          <Escolha value={f.fonte_materia} onChange={(e) => mudar("fonte_materia", e.target.value)}>
            <option value="medido">Medido (fechamento do big bag)</option><option value="padrao">Padrão da ficha</option><option value="manual">Manual</option>
          </Escolha>
        </Campo>
        {ent("kg_un_manual", "kg por saco (manual)", undefined, f.fonte_materia !== "manual")}
        <Campo rotulo={`Preço do kg — ${c.farinha_nome ?? "farinha"}`} dica={`última ${brl(c.preco_kg_ultima, 4)} · ref. ${brl(c.preco_kg_referencia, 4)} · 90 d ${brl(c.preco_kg_media_90d, 4)}`}>
          <Escolha value={f.preco_kg_fonte} onChange={(e) => mudar("preco_kg_fonte", e.target.value)}>
            <option value="ultima_entrada">Última entrada</option><option value="media_90d">Média 90 dias</option><option value="referencia">Referência</option><option value="manual">Manual</option>
          </Escolha>
        </Campo>
        {ent("preco_kg_manual", "R$/kg (manual)", undefined, f.preco_kg_fonte !== "manual")}
        {c.mistura && ent("preco_mistura_un_manual", `R$ por un de ${c.mistura_nome ?? "mistura"}`, `hoje ${brl(c.preco_mistura_un)} (custo do Tiny)`)}
      </>)}
      {grupo("Embalagem", <>
        {ent("embalagem_rs_un_manual", `Embalagem (R$/un)`, `${c.embalagem_nome ?? ""} · cadastro ${brl(c.embalagem, 4)} (vazio = cadastro)`)}
        {ent("etiqueta_rs_un_manual", "Etiqueta (R$/un)", `cadastro ${brl(c.etiqueta, 4)} (vazio = cadastro)`)}
      </>)}
      {grupo("Mão de obra", <>
        <Campo rotulo="Fonte" dica={`medida: ${c.mod_un_homem_hora == null ? "—" : `${num(c.mod_un_homem_hora, 1)} un/homem-hora`} · ${brl(c.mod_rs_hora)}/h`}>
          <Escolha value={f.fonte_mod} onChange={(e) => mudar("fonte_mod", e.target.value)}>
            <option value="medido">Medida nos lotes</option><option value="manual_hora">Manual: R$/hora e un/homem-hora</option><option value="manual_un">Manual: R$ por saco</option>
          </Escolha>
        </Campo>
        {ent("mod_rs_hora_manual", "R$ por homem-hora", undefined, f.fonte_mod !== "manual_hora")}
        {ent("un_homem_hora_manual", "Sacos por homem-hora", undefined, f.fonte_mod !== "manual_hora")}
        {ent("mod_rs_un_manual", "R$ por saco", undefined, f.fonte_mod !== "manual_un")}
      </>)}
      {grupo("Outros", <>
        {ent("premio_rs_lote", "Prêmio por big bag (R$)", `÷ ${num(c.un_por_lote, 0)} sacos = ${brl(c.premio, 4)}/un`)}
        {ent("un_por_lote", "Sacos por big bag", "vazio = 1.000 kg ÷ kg de farinha por saco")}
        {ent("cif_rs_un", "Indireto — CIF (R$/un)", "energia, espaço, depreciação")}
        <Campo rotulo="Observação"><Entrada value={f.observacao} onChange={(e) => mudar("observacao", e.target.value)} /></Campo>
      </>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AcoesEmMassa({ cenario, linhas }: { cenario: Cenario; linhas: CustoSku[] }) {
  const recalcular = useRecalcular();
  const farinhas = useMemo(() => {
    const m = new Map<number, { nome: string; skus: string[]; preco: number }>();
    for (const l of linhas) if (l.farinha_id != null) {
      const x = m.get(l.farinha_id) ?? { nome: l.farinha_nome ?? `#${l.farinha_id}`, skus: [], preco: l.preco_kg };
      x.skus.push(l.sku); m.set(l.farinha_id, x);
    }
    return [...m.entries()];
  }, [linhas]);
  const [farinha, setFarinha] = useState<number | "">("");
  const [precoKg, setPrecoKg] = useState("");
  const [modH, setModH] = useState("");
  const [cif, setCif] = useState("");
  const n = (s: string) => Number(s.trim().replace(",", "."));

  async function aplicar(desc: string, fn: () => Promise<void>) {
    if (!window.confirm(`${desc}\n\nVale só para o cenário "${cenario.nome}".`)) return;
    try { await fn(); recalcular(); toast.success("Aplicado."); } catch (e) { toast.error("Não deu para aplicar", { description: (e as Error).message }); }
  }

  return (
    <Cartao titulo="Ações em massa">
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="Farinha"><Escolha value={farinha} onChange={(e) => setFarinha(e.target.value ? Number(e.target.value) : "")} style={{ width: 230 }}>
            <option value="">Escolha…</option>{farinhas.map(([id, x]) => <option key={id} value={id}>{x.nome} ({x.skus.length})</option>)}
          </Escolha></Campo>
          <Campo rotulo="R$/kg"><Entrada inputMode="decimal" value={precoKg} onChange={(e) => setPrecoKg(e.target.value)} style={{ width: 90 }} /></Campo>
          <Botao disabled={!farinha || !(n(precoKg) > 0)} onClick={() => {
            const x = farinhas.find(([id]) => id === farinha)?.[1]; if (!x) return;
            void aplicar(`Preço da farinha ${x.nome} = ${brl(n(precoKg), 4)}/kg em ${x.skus.join(", ")}?`,
              () => salvarSkus(cenario.id, x.skus, { preco_kg_fonte: "manual", preco_kg_manual: n(precoKg) }));
          }}>Aplicar</Botao>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="MOD R$/homem-hora" dica="mantém a produtividade medida de cada produto"><Entrada inputMode="decimal" value={modH} onChange={(e) => setModH(e.target.value)} style={{ width: 110 }} /></Campo>
          <Botao disabled={!(n(modH) > 0)} onClick={() => void aplicar(`Mão de obra a ${brl(n(modH))}/homem-hora em todos os produtos?`, async () => {
            for (const l of linhas) {
              if (!l.mod_un_homem_hora) continue;
              await salvarSku(cenario.id, l.sku, { fonte_mod: "manual_hora", mod_rs_hora_manual: n(modH), un_homem_hora_manual: l.mod_un_homem_hora });
            }
          })}>Aplicar a todos</Botao>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="CIF R$/un"><Entrada inputMode="decimal" value={cif} onChange={(e) => setCif(e.target.value)} style={{ width: 90 }} /></Campo>
          <Botao disabled={!(n(cif) >= 0) || cif.trim() === ""} onClick={() => void aplicar(`Custo indireto (CIF) de ${brl(n(cif), 4)} por saco em todos os produtos?`,
            () => salvarSkus(cenario.id, linhas.map((l) => l.sku), { cif_rs_un: n(cif) }))}>Aplicar a todos</Botao>
        </div>
      </div>
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
function MaoDeObra() {
  const med = useMedicoes();
  const [verLotes, setVerLotes] = useState(false);
  const d = med.data;
  if (med.isLoading) return null;
  if (!d) return <Cartao titulo="Mão de obra"><span style={{ color: "var(--pm-r)" }}>Não deu para ler as medições.</span></Cartao>;
  const grupos = d.mod.filter((m) => m.sku == null);
  const inuteis = d.lotes.filter((l) => !l.limpo).length;
  return (
    <Cartao titulo="Mão de obra medida (cenário padrão)" direita={<Selo tom={inuteis ? "a" : "g"}>{inuteis} de {d.lotes.length} lotes com apontamento inútil</Selo>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
        {grupos.map((g) => (
          <div key={g.grupo} style={{ background: "var(--pm-s2)", borderRadius: 10, padding: 10, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 3 }}>
            <b>{g.grupo}</b>
            <span>{g.lotes} lotes · {int(g.un_total)} sacos · {num(g.horas_linha, 2)} h de linha · {num(g.homem_horas, 2)} homem-h</span>
            <span>Ritmo de linha <b>{num(g.un_h_linha, 1)} un/h</b> · <b>{num(g.un_homem_hora, 1)}</b> un/homem-hora</span>
            <span>{brl(g.rs_homem_hora_medio)}/homem-hora · MOD <b>{brl(g.mod_rs_un)}</b> por saco</span>
          </div>
        ))}
      </div>
      {d.dot.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <b>Tamanho da equipe (mandioca pura, lotes limpos):</b>{" "}
          {d.dot.map((x) => <span key={x.pessoas} style={{ marginRight: 14 }}>{x.pessoas} pessoas → {num(x.un_homem_hora, 1)} un/homem-hora, MOD {brl(x.mod_rs_un)} ({x.lotes} lotes)</span>)}
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Decisão de escala: com menos gente por lote, cada pessoa rende mais; o ritmo da linha cai pouco.</div>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
        Limpo = lote entre 10 min e 4 h (misturas até 12 h) e, na mandioca pura, ritmo entre 40 e 150 sacos/h. Hoje as etapas de cada lote são
        carimbadas com a mesma janela da ordem, então homem-hora = pessoas × janela. Produto com menos de 2 lotes / 200 sacos limpos usa o número do grupo.
      </div>
      <div style={{ marginTop: 8 }}><Botao tom="fantasma" onClick={() => setVerLotes((v) => !v)}>{verLotes ? "Esconder lotes" : "Ver lotes"}</Botao></div>
      {verLotes && (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>{["Lote", "SKU", "Dia", "Sacos", "Janela", "Pessoas", "Homem-h", "R$", "un/h", "un/homem-h", "Situação"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{d.lotes.map((l) => (
              <tr key={l.ordem_id}>
                <td style={td}>{l.codigo}</td><td style={td}>{l.sku}</td><td style={td}>{l.dia?.split("-").reverse().slice(0, 2).join("/")}</td>
                <td style={td}>{int(l.un)}</td><td style={td}>{num(l.min_linha, 0)} min</td><td style={td} title={l.quem ?? ""}>{l.pessoas ?? "—"}</td>
                <td style={td}>{num(l.homem_horas, 2)}</td><td style={td}>{brl(l.custo)}</td><td style={td}>{num(l.un_h_linha, 1)}</td><td style={td}>{num(l.un_homem_hora, 1)}</td>
                <td style={td}>{l.limpo ? <Selo tom="g">limpo</Selo> : <Selo tom="a">{l.motivo}</Selo>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

function MateriaPrima() {
  const med = useMedicoes();
  const bags = med.data?.bags ?? [];
  if (!bags.length) return null;
  const NOMES: Record<string, [string, "g" | "a" | "n" | "r"]> = {
    ok: ["entra na medição", "g"], mistura: ["mistura: fora", "n"], contaminada: ["pesos diferentes: fora", "a"],
    lote_aberto: ["lote aberto", "a"], sem_producao: ["sem produção", "n"], aberto: ["não fechado", "n"],
  };
  return (
    <Cartao titulo="Consumo de farinha pelo fechamento do big bag">
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginBottom: 6 }}>
        Só o big bag inteiro é medição: a baixa por lote lança o padrão ou joga o resto do saco no último lote. Um bag sozinho varia muito
        (sacos contados no lote de outro bag), por isso o número vale com 2 ou mais bags da mesma farinha.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tabela}>
          <thead><tr>{["Big bag", "Farinha", "Consumido", "Produtos", "Sacos", "kg/saco", "Situação"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>{bags.map((b) => (
            <tr key={b.entrada_id}>
              <td style={td}>{b.codigo}</td><td style={td}>{b.insumo.replace(/^Farinha de mandioca\s*/i, "")}</td><td style={td}>{kg(b.kg_consumido, 0)}</td>
              <td style={td}>{b.skus ?? "—"}</td><td style={td}>{int(b.un)}</td><td style={td}>{num(b.kg_un, 3)}</td>
              <td style={td}><Selo tom={NOMES[b.situacao]?.[1] ?? "n"}>{NOMES[b.situacao]?.[0] ?? b.situacao}</Selo></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Cartao>
  );
}
