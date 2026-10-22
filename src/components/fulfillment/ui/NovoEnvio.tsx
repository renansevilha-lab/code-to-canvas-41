import { type CSSProperties, type DragEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { LOGO, int } from "@/components/dashboard/formato";
import { NOME_EMP } from "@/components/fulfillment/ui/Cabecalho";
import { ETAPAS } from "@/components/fulfillment/ui/QuadroEnvios";
import { HostDialogosSep } from "@/components/separacao/ui/dialogos";

// ============================================================================
// Fulfillment › Novo envio no padrão do design (Claude Design,
// Fulfillment-NovoEnvio.dc.html, 22/out/2026): Conta → PDF de preparação →
// Coleta e etiquetas → Criar. Só apresentação: ler o PDF, corrigir SKU e criar
// (ou atualizar o envio que já existe) continuam no NovoEnvio de
// routes/fulfillment.tsx, que passa os handlers.
// ============================================================================

export interface ItemNovo {
  sku: string; sku_origem: string | null; titulo: string | null; titulo_pdf: string | null;
  qtd: number | null; qtd_pdf?: number | null; no_cadastro: boolean;
}

export interface NovoEnvioProps {
  marketplace: string; empresa: string;
  onConta: (marketplace: string, empresa: string) => void;
  numero: string; onNumero: (v: string) => void;
  centro: string; onCentro: (v: string) => void;
  data: string; onData: (v: string) => void;
  itens: ItemNovo[];
  fotos: Record<string, string | null | undefined>;
  totalPdf: number | null; produtosPdf: number | null; avisoLeitura: string | null;
  lendo: boolean; arquivo: string | null; lidoEm: string | null;
  onPdf: (f: File) => void;
  onQtd: (i: number, v: string) => void; onSku: (i: number, v: string) => void; onSkuPronto: (i: number) => void; onRemover: (i: number) => void;
  nEtiquetas: number; zplNome: string | null; onZpl: (f: File) => void;
  salvando: boolean;
  /** cria (ou atualiza o que já existe) e devolve o id; null = cancelado ou falhou */
  onCriar: () => Promise<{ id: string; atualizado: boolean } | null>;
  onAbrir: (id: string) => void; onQuadro: () => void;
  onReposicao: () => void;
  importarAmazon: ReactNode;
}

const MONO = "pm-mono";
const MKT_NOME: Record<string, string> = { mercadolivre: "Mercado Livre", shopee: "Shopee", tiktok: "TikTok Shop", temu: "Temu", shein: "Shein", olist: "Olist", magalu: "Magalu", amazon: "Amazon" };
const CONTAS = [
  { mkt: "mercadolivre", emp: "ACZ Pet", nome: "Mercado Livre ACZ" },
  { mkt: "mercadolivre", emp: "SVL Store", nome: "Mercado Livre SVL" },
  { mkt: "shopee", emp: "ACZ Pet", nome: "Shopee Ottz" },
  { mkt: "shopee", emp: "SVL Store", nome: "Shopee Bumi" },
];
const OUTROS = ["tiktok", "temu", "shein", "olist", "magalu"];
const card: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-sh)", padding: 14, display: "flex", flexDirection: "column", gap: 10 };
const selo: CSSProperties = { fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap", flex: "none" };
const logo = (mkt: string, px: number): CSSProperties => ({ display: "inline-block", width: px, height: px, borderRadius: 5, flex: "none", boxShadow: "0 0 0 1px var(--pm-b)", background: LOGO[mkt] ? `#fff url(${LOGO[mkt]}) center/contain no-repeat` : "var(--pm-s2)" });
const btnPrim = (off?: boolean): CSSProperties => ({ height: 44, padding: "0 18px", borderRadius: 10, border: 0, background: off ? "var(--pm-bs)" : "var(--pm-a)", color: "var(--pm-oa)", cursor: off ? "default" : "pointer", fontSize: 13, fontWeight: 600 });
const btnSec: CSSProperties = { height: 44, padding: "0 14px", borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 13, color: "var(--pm-t)" };
const campo: CSSProperties = { height: 40, borderRadius: 9, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "0 10px", fontSize: 13, color: "var(--pm-t)" };
const Check = ({ cor = "var(--pm-g)", s = 14 }: { cor?: string; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={cor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);
const ddmmaaaa = (iso: string) => (iso ? iso.split("-").reverse().join("/") : "");

export function NovoEnvioNovo(p: NovoEnvioProps) {
  const [passo, setPasso] = useState(1);
  const [outro, setOutro] = useState(!CONTAS.some((c) => c.mkt === p.marketplace));
  const [arrastando, setArrastando] = useState(false);
  const [arrastandoZpl, setArrastandoZpl] = useState(false);
  const [criado, setCriado] = useState<{ id: string; atualizado: boolean } | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const zplRef = useRef<HTMLInputElement>(null);

  const contaNome = CONTAS.find((c) => c.mkt === p.marketplace && c.emp === p.empresa)?.nome
    ?? `${MKT_NOME[p.marketplace] ?? p.marketplace}${p.empresa ? ` ${p.empresa === "SVL Store" ? "SVL" : "ACZ"}` : ""}`;
  const empNome = p.empresa ? NOME_EMP[p.empresa] ?? p.empresa : "sem empresa";
  const mktNome = MKT_NOME[p.marketplace] ?? p.marketplace;

  const soma = p.itens.reduce((s, i) => s + (Number(i.qtd) || 0), 0);
  const linhas = useMemo(() => p.itens.map((it, i) => {
    const semSku = !(it.sku ?? "").trim();
    const fora = !semSku && !it.no_cadastro;
    const semQtd = it.qtd == null;
    const dq = !semQtd && it.qtd_pdf != null && it.qtd !== it.qtd_pdf;
    const nivel = semSku || fora ? 2 : dq || semQtd ? 1 : 0;
    const sit = semSku ? "sem SKU · vincule para continuar" : fora ? "SKU fora do cadastro" : semQtd ? "sem quantidade" : dq ? `≠ PDF diz ${int(it.qtd_pdf!)}` : "✓ confere";
    return { it, i, nivel, sit, semSku, fora, dq, semQtd };
  }).sort((a, b) => b.nivel - a.nivel || a.i - b.i), [p.itens]);
  const semSku = linhas.filter((l) => l.semSku).length;
  const pend = linhas.filter((l) => l.nivel > 0).length;
  const linhasBatem = p.produtosPdf == null || p.itens.length === p.produtosPdf;
  const totalBate = p.totalPdf == null || soma === p.totalPdf;
  const okTot = linhasBatem && totalBate && pend === 0;
  const bloq = p.itens.length === 0 || semSku > 0;
  const conf = okTot
    ? { titulo: "✓ confere com o PDF", sub: `${p.itens.length} itens · ${int(soma)} un, igual ao total do PDF`, bg: "var(--pm-gs)", cor: "var(--pm-g)" }
    : {
        titulo: !linhasBatem ? `≠ ${p.itens.length} linhas, o PDF tem ${p.produtosPdf} produtos` : !totalBate ? `≠ PDF diz ${int(p.totalPdf!)} un` : `${pend} ${pend === 1 ? "linha pede" : "linhas pedem"} atenção`,
        sub: `a tabela soma ${int(soma)} un${pend ? ` · ${pend} ${pend === 1 ? "linha destacada" : "linhas destacadas"} no topo` : ""}`,
        bg: "var(--pm-ams)", cor: "var(--pm-am)",
      };
  const nota = semSku ? "Vincule o SKU para continuar: sem ele o item não entra no Tiny." : !okTot ? "Dá para seguir, mas confira antes." : "";

  const P: Array<[string, string]> = [
    ["Conta", contaNome],
    ["PDF de preparação", p.itens.length ? `${p.itens.length} itens · ${int(soma)} un` : "subir e conferir"],
    ["Coleta e etiquetas", passo > 3 ? `${p.data ? ddmmaaaa(p.data).slice(0, 5) : "sem data"}${p.nEtiquetas ? " · ZPL" : ""}` : "data e ZPL"],
    ["Criar", criado ? (criado.atualizado ? "atualizado" : "criado") : "revisar"],
  ];
  const atual = criado ? 5 : passo;

  async function criar() {
    const r = await p.onCriar();
    if (r) setCriado(r);
  }

  const soltarPdf = (e: DragEvent) => { e.preventDefault(); setArrastando(false); const f = e.dataTransfer.files?.[0]; if (f) p.onPdf(f); };

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--pm-t)", fontSize: 13, lineHeight: 1.4, fontVariantNumeric: "tabular-nums" }}>
      <HostDialogosSep />
      <input ref={pdfRef} type="file" accept="application/pdf" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) p.onPdf(f); }} />
      <input ref={zplRef} type="file" accept=".txt,.zpl,text/plain" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) p.onZpl(f); }} />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}>Novo envio</h1>
        <span style={{ fontSize: 12.5, color: "var(--pm-t3)" }}>Mercado Livre e Shopee: o envio é criado no painel do marketplace e o PDF de preparação é subido aqui</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {P.map(([nome, sub], k) => {
          const n = k + 1; const feito = atual > n; const cur = atual === n;
          return (
            <button key={nome} type="button" onClick={() => { if (n < atual && !criado) setPasso(n); }}
              style={{ flex: "1 1 160px", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 12, border: `1px solid ${cur ? "var(--pm-a)" : "var(--pm-b)"}`, background: cur ? "var(--pm-as)" : "var(--pm-s)", cursor: n < atual && !criado ? "pointer" : "default", textAlign: "left", color: "var(--pm-t)" }}>
              <span style={{ width: 26, height: 26, flex: "none", borderRadius: "50%", background: feito ? "var(--pm-g)" : cur ? "var(--pm-a)" : "var(--pm-s2)", color: feito || cur ? "var(--pm-oa)" : "var(--pm-t3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{feito ? "✓" : n}</span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: cur ? 600 : 500, color: cur || feito ? "var(--pm-t)" : "var(--pm-t2)" }}>{nome}</span>
                <span style={{ fontSize: 11, color: "var(--pm-t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* 1 · Conta */}
      {!criado && passo === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))", gap: 12, alignItems: "start" }}>
          <div style={card}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Para qual conta?</span>
            <span style={{ fontSize: 12, color: "var(--pm-t3)", marginTop: -6 }}>O estoque no CD é de cada conta: escolha a que vai receber.</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,180px),1fr))", gap: 8 }}>
              {CONTAS.map((c) => {
                const on = !outro && c.mkt === p.marketplace && c.emp === p.empresa;
                return (
                  <button key={c.nome} type="button" onClick={() => { setOutro(false); p.onConta(c.mkt, c.emp); }}
                    style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, minHeight: 84, borderRadius: 12, border: `1.5px solid ${on ? "var(--pm-a)" : "var(--pm-b)"}`, background: on ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={logo(c.mkt, 20)} />
                      <b style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{c.nome}</b>
                      <span style={selo}>{NOME_EMP[c.emp]}</span>
                    </span>
                    <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>pelo PDF de preparação</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => { setOutro(true); if (!OUTROS.includes(p.marketplace)) p.onConta("tiktok", p.empresa); }}
                style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, minHeight: 84, borderRadius: 12, border: `1.5px solid ${outro ? "var(--pm-a)" : "var(--pm-b)"}`, background: outro ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}>
                <b style={{ fontSize: 13, fontWeight: 600 }}>Outro marketplace</b>
                <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>TikTok, Temu, Shein, Olist, Magalu</span>
              </button>
            </div>
            {outro && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <select value={p.marketplace} onChange={(e) => p.onConta(e.target.value, p.empresa)} style={campo}>
                  {OUTROS.map((m) => <option key={m} value={m}>{MKT_NOME[m]}</option>)}
                </select>
                <select value={p.empresa} onChange={(e) => p.onConta(p.marketplace, e.target.value)} style={campo}>
                  <option value="">sem empresa</option>
                  <option value="ACZ Pet">Ottz Pet (ACZ)</option>
                  <option value="SVL Store">Bumi Pet (SVL)</option>
                </select>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setPasso(2)} style={btnPrim()}>Continuar · subir o PDF</button>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ ...card, gap: 8 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={logo("amazon", 18)} /><b style={{ fontSize: 13, fontWeight: 600 }}>Amazon: pelo plano da Reposição</b></span>
              <span style={{ fontSize: 12, color: "var(--pm-t2)", textWrap: "pretty" }}>Na Amazon o envio nasce sozinho quando o plano chega ao fim, com itens, caixas e etiquetas. Não precisa de PDF.</span>
              <button type="button" onClick={p.onReposicao} style={{ alignSelf: "flex-start", height: 38, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, fontWeight: 500, color: "var(--pm-t)" }}>Montar envio na Reposição →</button>
            </div>
            <div style={{ ...card, gap: 8 }}>
              <b style={{ fontSize: 13, fontWeight: 600 }}>Importar da Amazon</b>
              <span style={{ fontSize: 12, color: "var(--pm-t2)", textWrap: "pretty" }}>Para envios criados direto no Seller Central. O app lê itens, CD e etiquetas pela API.</span>
              <div>{p.importarAmazon}</div>
            </div>
          </div>
        </div>
      )}

      {/* 2 · PDF */}
      {!criado && passo === 2 && (
        <div style={{ ...card, gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span style={logo(p.marketplace, 18)} />
            <b style={{ fontSize: 13, fontWeight: 600 }}>{contaNome}</b>
            <span style={selo}>{empNome}</span>
            <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>· PDF de preparação</span>
          </div>

          {p.lendo ? (
            <div style={{ minHeight: 240, borderRadius: 14, border: "1px solid var(--pm-b)", background: "var(--pm-s2)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <div style={{ width: 220, height: 6, borderRadius: 3, background: "var(--pm-sk)", overflow: "hidden" }}><i style={{ display: "block", height: "100%", width: "60%", background: "var(--pm-a)" }} /></div>
              <span style={{ fontSize: 13, color: "var(--pm-t2)" }}>Lendo {p.arquivo ?? "o PDF"}…</span>
            </div>
          ) : p.itens.length === 0 ? (
            <div onDragOver={(e) => { e.preventDefault(); if (!arrastando) setArrastando(true); }} onDragLeave={() => setArrastando(false)} onDrop={soltarPdf}
              style={{ minHeight: 240, borderRadius: 14, border: `2px dashed ${arrastando ? "var(--pm-a)" : "var(--pm-bs)"}`, background: arrastando ? "var(--pm-as)" : "var(--pm-s2)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, textAlign: "center" }}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--pm-at)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></svg>
              <b style={{ fontSize: 16, fontWeight: 600 }}>Solte aqui o PDF de preparação do {mktNome}</b>
              <span style={{ fontSize: 12.5, color: "var(--pm-t2)", maxWidth: 440, textWrap: "pretty" }}>O app lê o número do envio e os itens com as quantidades. Você confere antes de criar.</span>
              <button type="button" onClick={() => pdfRef.current?.click()} style={{ ...btnSec, fontWeight: 500 }}>Escolher arquivo</button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", borderRadius: 8, background: "var(--pm-s2)", fontSize: 12 }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--pm-t3)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                  <span className={MONO}>{p.arquivo ?? "PDF"}</span>
                  {p.lidoEm && <span style={{ color: "var(--pm-t3)" }}>· lido às {p.lidoEm}</span>}
                </span>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--pm-t2)" }}>
                  Envio
                  <input value={p.numero} onChange={(e) => p.onNumero(e.target.value)} placeholder="nº do envio" className={MONO} style={{ ...campo, height: 32, width: 130, fontSize: 12.5 }} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--pm-t2)" }}>
                  CD
                  <input value={p.centro} onChange={(e) => p.onCentro(e.target.value)} placeholder="ex.: Perus - BRRC01" style={{ ...campo, height: 32, width: 180, fontSize: 12.5 }} />
                </label>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => pdfRef.current?.click()} style={{ height: 32, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)" }}>Trocar PDF</button>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", padding: "10px 14px", borderRadius: 12, background: conf.bg }}>
                <span className={MONO} style={{ fontSize: 16, fontWeight: 600, color: conf.cor }}>{conf.titulo}</span>
                <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>{conf.sub}</span>
                {p.avisoLeitura && !okTot && <span style={{ flexBasis: "100%", fontSize: 12, color: "var(--pm-am)", fontWeight: 500 }}>⚠ {p.avisoLeitura}</span>}
              </div>

              <div style={{ border: "1px solid var(--pm-b)", borderRadius: 12, overflowX: "auto" }}>
                <div style={{ minWidth: 760 }}>
                  <Grade cab>
                    <span>Produto lido do PDF</span><span>SKU no app</span><span style={{ textAlign: "right" }}>PDF</span><span style={{ textAlign: "right" }}>Enviar</span><span>Conferência</span><span />
                  </Grade>
                  {linhas.map(({ it, i, nivel, sit, semSku: ss, fora }) => {
                    const foto = it.sku ? p.fotos[it.sku] : null;
                    return (
                      <Grade key={`${i}-${it.sku_origem ?? ""}`} fundo={nivel === 2 ? "var(--pm-rs)" : nivel === 1 ? "var(--pm-ams)" : "transparent"}>
                        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          {foto ? <img src={foto} alt="" loading="lazy" style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover", flex: "none", background: "#fff", border: "1px solid var(--pm-b)" }} />
                            : <span style={{ width: 30, height: 30, borderRadius: 6, flex: "none", background: "var(--pm-s2)", border: "1px solid var(--pm-b)" }} />}
                          <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{it.titulo ?? it.titulo_pdf ?? "—"}</span>
                            {it.sku_origem && it.sku_origem !== it.sku && <span className={MONO} style={{ fontSize: 10.5, color: "var(--pm-t3)" }}>no PDF: {it.sku_origem}</span>}
                          </span>
                        </span>
                        <input value={it.sku ?? ""} onChange={(e) => p.onSku(i, e.target.value)} onBlur={() => p.onSkuPronto(i)}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
                          placeholder="vincular SKU…" title="Corrija o SKU se o PDF veio errado (ex.: SKU da Amazon)" className={MONO}
                          style={{ height: 32, width: "100%", borderRadius: 8, border: `1px solid ${ss || fora ? "var(--pm-r)" : "var(--pm-bs)"}`, background: "var(--pm-s)", padding: "0 8px", fontSize: 12, color: ss || fora ? "var(--pm-r)" : "var(--pm-t)" }} />
                        <span className={MONO} style={{ textAlign: "right", color: "var(--pm-t2)" }}>{it.qtd_pdf != null ? int(it.qtd_pdf) : "—"}</span>
                        <input value={it.qtd ?? ""} onChange={(e) => p.onQtd(i, e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" className={MONO}
                          style={{ height: 32, width: "100%", textAlign: "right", borderRadius: 8, border: `1px solid ${nivel === 1 ? "var(--pm-am)" : "var(--pm-bs)"}`, background: "var(--pm-s)", padding: "0 8px", fontSize: 12.5, color: "var(--pm-t)" }} />
                        <span style={{ fontSize: 12, fontWeight: nivel ? 600 : 500, color: nivel === 2 ? "var(--pm-r)" : nivel === 1 ? "var(--pm-am)" : "var(--pm-g)" }}>{sit}</span>
                        <button type="button" title="Tirar este item" onClick={() => p.onRemover(i)}
                          style={{ width: 28, height: 28, borderRadius: 7, border: 0, background: "transparent", cursor: "pointer", color: "var(--pm-t3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                        </button>
                      </Grade>
                    );
                  })}
                  <Grade total>
                    <span>Total · {p.itens.length} itens</span><span />
                    <span className={MONO} style={{ textAlign: "right" }}>{p.totalPdf != null ? int(p.totalPdf) : "—"}</span>
                    <span className={MONO} style={{ textAlign: "right", paddingRight: 9 }}>{int(soma)}</span>
                    <span style={{ color: conf.cor }}>{okTot ? "✓ confere com o PDF" : totalBate ? "confira as linhas" : `≠ PDF diz ${int(p.totalPdf!)}`}</span><span />
                  </Grade>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: semSku ? "var(--pm-r)" : "var(--pm-t3)" }}>{nota}</span>
                <button type="button" onClick={() => setPasso(1)} style={btnSec}>Voltar</button>
                <button type="button" disabled={bloq} onClick={() => { if (!bloq) setPasso(3); }} style={btnPrim(bloq)}>Continuar · coleta e etiquetas</button>
              </div>
            </>
          )}
          {p.itens.length === 0 && !p.lendo && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <button type="button" onClick={() => setPasso(1)} style={btnSec}>Voltar</button>
            </div>
          )}
        </div>
      )}

      {/* 3 · Coleta e etiquetas */}
      {!criado && passo === 3 && (
        <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12.5, fontWeight: 600 }}>Data de coleta</label>
            <input type="date" value={p.data} onChange={(e) => p.onData(e.target.value)} className={MONO}
              style={{ height: 44, borderRadius: 10, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "0 12px", fontSize: 14, color: "var(--pm-t)" }} />
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>a mesma agendada no painel do {mktNome}{p.centro ? ` · ${p.centro}` : ""} · pode ficar em branco e preencher depois</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>Etiquetas de volume (ZPL)</span>
            {p.nEtiquetas > 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 12, background: "var(--pm-gs)", fontSize: 12.5 }}>
                <Check />
                <span className={MONO}>{p.zplNome ?? "etiquetas"}</span>
                <span style={{ color: "var(--pm-t2)" }}>· {int(p.nEtiquetas)} etiquetas</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={() => zplRef.current?.click()} style={{ height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)" }}>Trocar</button>
              </div>
            ) : (
              <button type="button" onClick={() => zplRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); if (!arrastandoZpl) setArrastandoZpl(true); }} onDragLeave={() => setArrastandoZpl(false)}
                onDrop={(e) => { e.preventDefault(); setArrastandoZpl(false); const f = e.dataTransfer.files?.[0]; if (f) p.onZpl(f); }}
                style={{ minHeight: 88, borderRadius: 12, border: `2px dashed ${arrastandoZpl ? "var(--pm-a)" : "var(--pm-bs)"}`, background: arrastandoZpl ? "var(--pm-as)" : "var(--pm-s2)", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 13, fontWeight: 500, color: "var(--pm-t)" }}>
                Solte o arquivo .zpl ou clique
                <span style={{ fontSize: 11.5, color: "var(--pm-t3)", fontWeight: 400 }}>pode subir depois, na tela do envio</span>
              </button>
            )}
          </div>
          <div style={{ gridColumn: "1/-1", display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setPasso(2)} style={btnSec}>Voltar</button>
            <button type="button" onClick={() => setPasso(4)} style={btnPrim()}>Continuar · revisar</button>
          </div>
        </div>
      )}

      {/* 4 · Revisar */}
      {!criado && passo === 4 && (
        <div style={{ ...card, gap: 12, maxWidth: 640, padding: 16 }}>
          <b style={{ fontSize: 15, fontWeight: 600 }}>Revisar e criar</b>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 13 }}>
            <span style={{ color: "var(--pm-t3)" }}>Conta</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={logo(p.marketplace, 15)} />{contaNome} <span style={selo}>{empNome}</span></span>
            <span style={{ color: "var(--pm-t3)" }}>Envio</span>
            <span className={MONO}>{p.numero ? (/^\d+$/.test(p.numero) ? `#${p.numero}` : p.numero) : "sem número"}{p.centro ? ` · ${p.centro}` : ""}</span>
            <span style={{ color: "var(--pm-t3)" }}>Itens</span>
            <span><b className={MONO} style={{ fontWeight: 600 }}>{int(soma)} un</b> em {p.itens.length} itens · <span style={{ color: conf.cor }}>{okTot ? "✓ confere com o PDF" : conf.titulo}</span></span>
            <span style={{ color: "var(--pm-t3)" }}>Coleta</span>
            <span className={MONO}>{p.data ? ddmmaaaa(p.data) : "sem data"}</span>
            <span style={{ color: "var(--pm-t3)" }}>Etiquetas</span>
            <span>{p.nEtiquetas ? `${p.zplNome ?? "ZPL"} · ${int(p.nEtiquetas)} etiquetas` : "sem ZPL ainda · dá para subir na tela do envio"}</span>
          </div>
          <div style={{ padding: "10px 12px", borderRadius: 10, background: "var(--pm-s2)", fontSize: 12.5, color: "var(--pm-t2)", textWrap: "pretty" }}>
            O envio entra no quadro em <b style={{ color: "var(--pm-t)", fontWeight: 600 }}>Separando</b>. Nada é escrito no {mktNome} nem no Tiny agora: o estoque só é lançado no Tiny depois de marcado como enviado. Se já existe um envio com este número, o app pergunta se é para atualizá-lo.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={() => setPasso(3)} style={btnSec}>Voltar</button>
            <button type="button" disabled={p.salvando} onClick={() => void criar()} style={btnPrim(p.salvando)}>{p.salvando ? "Criando…" : "Criar envio e separar"}</button>
          </div>
        </div>
      )}

      {/* criado */}
      {criado && (
        <div style={{ ...card, padding: 24, alignItems: "flex-start", maxWidth: 640 }}>
          <span style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--pm-gs)", display: "flex", alignItems: "center", justifyContent: "center" }}><Check s={20} /></span>
          <b style={{ fontSize: 18, fontWeight: 600 }}>Envio <span className={MONO}>{p.numero ? (/^\d+$/.test(p.numero) ? `#${p.numero}` : p.numero) : ""}</span> {criado.atualizado ? "atualizado" : "criado"}</b>
          <span style={{ fontSize: 13, color: "var(--pm-t2)" }}>
            {contaNome} · {p.itens.length} itens · {int(soma)} un{p.data ? ` · coleta ${ddmmaaaa(p.data).slice(0, 5)}` : ""}
            {criado.atualizado ? " · a separação já feita foi preservada e a equipe recebeu no Discord o que mudou" : <> · entrou em <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600, color: "var(--pm-t)" }}><i style={{ width: 8, height: 8, borderRadius: 2, background: ETAPAS[0].cor }} />Separando</span></>}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
            <button type="button" onClick={() => p.onAbrir(criado.id)} style={btnPrim()}>Abrir a separação</button>
            <button type="button" onClick={p.onQuadro} style={btnSec}>Voltar ao quadro</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Grade({ children, cab, total, fundo }: { children: ReactNode; cab?: boolean; total?: boolean; fundo?: string }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "minmax(240px,1.6fr) 150px 70px 96px minmax(170px,1fr) 32px", gap: 10, alignItems: "center",
      padding: cab ? "8px 12px" : total ? "9px 12px" : "7px 12px",
      background: cab ? "var(--pm-s2)" : fundo ?? "transparent",
      borderTop: cab ? 0 : `1px solid ${total ? "var(--pm-bs)" : "var(--pm-b)"}`,
      fontSize: cab ? 11 : 12.5, color: cab ? "var(--pm-t3)" : "var(--pm-t)", fontWeight: cab ? 500 : total ? 600 : 400,
    }}>
      {children}
    </div>
  );
}
