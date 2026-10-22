import { Component, type CSSProperties, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { LOGO, ddmm, hojeSP, int } from "@/components/dashboard/formato";
import { ETAPAS, idxEtapa } from "@/components/fulfillment/ui/QuadroEnvios";
import { NOME_EMP, nomeConta } from "@/components/fulfillment/ui/Cabecalho";
import { HostDialogosSep, pedirTextoSep } from "@/components/separacao/ui/dialogos";

// ============================================================================
// Fulfillment › dentro do envio (Packing) no padrão do design "Fulfillment"
// (Claude Design, Fulfillment-Packing.dc.html, 22/out/2026). Só apresentação:
// toda a lógica (contar, etiquetas, documentos, marcar enviado, lançar no Tiny)
// continua no PackingEnvio de routes/fulfillment.tsx, que passa os handlers.
// As confirmações saem por confirmarSep() — com HostDialogosSep montado aqui
// viram o diálogo desenhado; se esta tela quebrar, o PackingEnvio mostra a
// tela antiga (ProtecaoPacking) e elas voltam a ser window.confirm.
// ============================================================================

export interface ItemPk {
  id: string; sku: string | null; titulo: string | null; qtd_planejada: number; qtd_separada: number;
}
export interface DocPk { id: string; tipo: string; nome: string | null; mime: string | null; tamanho: number | null }
export interface ImpressoraPk { printer_id: number; nome: string; computador: string; estado: string; configurada?: boolean }
export interface EnvioPk {
  numero: string | null; marketplace: string; empresa: string | null; centro: string | null; status: string;
  data_envio_agendada: string | null; estoque_lancado_em: string | null; estoque_lancado_por: string | null;
}

export interface PackingProps {
  envio: EnvioPk;
  itens: ItemPk[];
  carregandoItens: boolean;
  fotos: Record<string, string | null | undefined>;
  /** SKUs do envio sem id_tiny no cadastro (não entram no lançamento) */
  semCadastro: Set<string>;
  // impressora
  impressoras: ImpressoraPk[];
  printerId: number;
  onPrinter: (id: number) => void;
  // contagem
  onSet: (it: ItemPk, n: number) => void;
  onTrocarSku: (it: ItemPk, sku: string) => void;
  // etiquetas
  nEtiquetasVolume: number;
  temEtiquetaVolume: boolean;
  imprimindoVolume: boolean;
  onImprimirVolume: () => Promise<boolean>;
  onSubirZpl: (f: File) => void;
  temEtiquetaSku: (sku: string | null) => boolean;
  imprimindoSku: string | null;
  onImprimirSku: (sku: string, qtd: number) => void;
  // documentos
  docs: DocPk[];
  carregandoDocs: boolean;
  erroDocs: boolean;
  onTentarDocs: () => void;
  subindoDocs: boolean;
  onSubirDocs: (files: File[]) => void;
  tiposDoc: Array<{ id: string; label: string }>;
  onTipoDoc: (id: string, tipo: string) => void;
  imprimindoDoc: string | null;
  onImprimirDoc: (d: DocPk) => void;
  onAbrirDoc: (d: DocPk) => void;
  onExcluirDoc: (d: DocPk) => void;
  extraDocs?: ReactNode;
  // envio
  obs: string; onObs: (v: string) => void; onSalvarObs: () => void;
  dataAg: string; onDataAg: (v: string) => void; onSalvarDataAg: () => void;
  onEtapa: (status: string) => void;
  enviando: boolean; onMarcarEnviado: () => void;
  lancando: boolean; onLancar: () => void;
  atualizandoPdf: boolean; onAtualizarPdf: (f: File) => void;
  novoSku: string; onNovoSku: (v: string) => void; novoQtd: string; onNovoQtd: (v: string) => void;
  adicionando: boolean; onAdicionar: () => void;
  onExcluirEnvio: () => void;
  /** Encaixotamento da Amazon etc. — acima dos itens */
  extraTopo?: ReactNode;
  /** recebimento por SKU (Amazon enviado) — abaixo dos itens */
  extraBaixo?: ReactNode;
}

const MONO = "pm-mono";
const card: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 };
const tituloCard: CSSProperties = { fontSize: 12.5, fontWeight: 600 };
const btnQuad = (px: number): CSSProperties => ({ width: px, height: px, flex: "none", borderRadius: 10, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t2)" });
const campo: CSSProperties = { height: 38, borderRadius: 9, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "0 10px", fontSize: 13, color: "var(--pm-t)" };
const btnLinha: CSSProperties = { height: 38, borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--pm-t)" };

const IcImp = ({ s = 16 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6" /><rect x="6" y="14" width="12" height="8" rx="1" /></svg>
);
const IcDoc = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--pm-t3)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
);
const Spin = () => <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid currentColor", borderRightColor: "transparent", display: "inline-block", animation: "spin 0.8s linear infinite" }} />;

function useEstreito(px = 900) {
  const [v, setV] = useState(() => typeof window !== "undefined" && window.matchMedia(`(max-width: ${px}px)`).matches);
  useEffect(() => {
    const m = window.matchMedia(`(max-width: ${px}px)`);
    const f = () => setV(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [px]);
  return v;
}

function coletaTxt(e: EnvioPk): string {
  if (!e.data_envio_agendada) return "sem data de coleta";
  const d = Math.round((Date.parse(`${e.data_envio_agendada}T12:00:00Z`) - Date.parse(`${hojeSP()}T12:00:00Z`)) / 86_400_000);
  const dm = ddmm(e.data_envio_agendada);
  if (e.status === "enviado") return `coleta ${dm}`;
  if (d < 0) return `coleta ${dm}, atrasada`;
  if (d === 0) return `coleta hoje, ${dm}`;
  if (d === 1) return `coleta amanhã, ${dm}`;
  return `coleta ${dm}, em ${d} dias`;
}

const recebimentoTxt: Record<string, string> = {
  mercadolivre: "O Mercado Livre não informa o recebimento por SKU. Depois da coleta, confira no painel do ML.",
  amazon: "Depois que o envio sai, o recebimento por SKU aparece abaixo dos itens (lido da Amazon).",
  shopee: "A Shopee não informa o recebimento pela API. Depois da coleta, confira no Seller Center.",
};

export function PackingNovo(p: PackingProps) {
  const estreito = useEstreito();
  const [ocultar, setOcultar] = useState(false);
  const [mais, setMais] = useState(false);
  const [docDel, setDocDel] = useState<string | null>(null);
  const [impressoAgora, setImpressoAgora] = useState(false);
  const [addAberto, setAddAberto] = useState(false);
  const docRef = useRef<HTMLInputElement>(null);
  const zplRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);

  const { envio, itens } = p;
  const plan = itens.reduce((s, i) => s + i.qtd_planejada, 0);
  const sep = itens.reduce((s, i) => s + i.qtd_separada, 0);
  const incomp = itens.filter((i) => i.qtd_separada < i.qtd_planejada);
  const falta = incomp.reduce((s, i) => s + (i.qtd_planejada - i.qtd_separada), 0);
  const nOk = itens.length - incomp.length;
  const pct = plan > 0 ? Math.min(100, Math.round((sep / plan) * 100)) : 0;
  const idx = idxEtapa(envio.status);
  const enviado = envio.status === "enviado";
  const lancado = !!envio.estoque_lancado_em;
  const impresso = impressoAgora || idx >= 3;
  const etapa = ETAPAS[idx];
  const unFora = itens.filter((i) => i.sku && p.semCadastro.has(i.sku)).reduce((s, i) => s + i.qtd_separada, 0);

  const curP = lancado ? 4 : enviado ? 3 : impresso ? 2 : falta > 0 ? 0 : 1;
  const passos = ["Contar itens", "Imprimir etiquetas", "Marcar enviado", "Lançar no Tiny"].map((nome, i) => {
    const feito = i === 0 ? falta === 0 && plan > 0 : i < curP;
    const atual = i === curP;
    return { nome: (feito ? "✓ " : "") + nome, bar: feito ? "var(--pm-g)" : atual ? "var(--pm-a)" : "var(--pm-sk)", cor: feito ? "var(--pm-g)" : atual ? "var(--pm-t)" : "var(--pm-t3)", fw: atual ? 600 : 500 };
  });

  const imp = p.impressoras.find((x) => x.printer_id === p.printerId);
  const fmtLanc = envio.estoque_lancado_em
    ? new Date(envio.estoque_lancado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

  async function imprimirVolume() {
    const ok = await p.onImprimirVolume();
    if (ok) {
      setImpressoAgora(true);
      if (falta === 0 && idx < 3) p.onEtapa("pronto_envio");
    }
  }

  type Prim = { label: ReactNode; nota: string; onClick: () => void; off?: boolean; ocupado?: boolean; ok?: boolean };
  let prim: Prim;
  if (!enviado && !impresso) {
    prim = p.temEtiquetaVolume
      ? {
          label: p.nEtiquetasVolume > 0 ? `Imprimir ${int(p.nEtiquetasVolume)} etiquetas de volume` : "Imprimir etiquetas de volume",
          nota: falta > 0 ? `Faltam ${int(falta)} un. Dá para imprimir agora e seguir contando.` : "Tudo contado. Imprima e cole nos volumes.",
          onClick: () => void imprimirVolume(), ocupado: p.imprimindoVolume,
        }
      : {
          label: "Subir etiquetas de volume",
          nota: "Baixe no marketplace o arquivo das etiquetas (.zpl ou .txt; Amazon: PDF em Documentos).",
          onClick: () => zplRef.current?.click(),
        };
  } else if (!enviado) {
    prim = { label: "Marcar enviado", nota: falta > 0 ? `Faltam ${int(falta)} un: vai pedir confirmação.` : "Quando a coleta levar os volumes.", onClick: p.onMarcarEnviado, ocupado: p.enviando };
  } else if (!lancado && sep > 0) {
    prim = { label: "Lançar estoque no Tiny", nota: `Enquanto não lança, o Tiny segue vendendo as ${int(sep - unFora)} un que já saíram.`, onClick: p.onLancar, ocupado: p.lancando };
  } else if (lancado) {
    prim = { label: "Estoque lançado no Tiny ✓", nota: `${fmtLanc}${envio.estoque_lancado_por ? ` · ${envio.estoque_lancado_por}` : ""} · ${envio.centro ?? nomeConta(envio.marketplace, envio.empresa)}`, onClick: () => {}, off: true, ok: true };
  } else {
    prim = { label: "Nada a lançar no Tiny", nota: "Nenhuma unidade contada neste envio.", onClick: () => {}, off: true };
  }

  const botaoPrim = (alto: number) => (
    <button
      type="button"
      onClick={prim.onClick}
      disabled={prim.off || prim.ocupado}
      style={{
        height: alto, borderRadius: 11, border: 0, cursor: prim.off || prim.ocupado ? "default" : "pointer", fontSize: 15, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%",
        background: prim.ok ? "var(--pm-gs)" : prim.off ? "var(--pm-s2)" : "var(--pm-a)",
        color: prim.ok ? "var(--pm-g)" : prim.off ? "var(--pm-t3)" : "var(--pm-oa)", opacity: prim.ocupado ? 0.75 : 1,
      }}
    >
      {prim.ocupado && <Spin />}{prim.label}
    </button>
  );

  const ordenados = useMemo(() => {
    const comp = (i: ItemPk) => i.qtd_planejada > 0 && i.qtd_separada >= i.qtd_planejada;
    return itens.map((it, k) => ({ it, k })).sort((a, b) => (comp(a.it) === comp(b.it) ? a.k - b.k : comp(a.it) ? 1 : -1)).map((x) => x.it);
  }, [itens]);
  const visiveis = ordenados.filter((i) => !(ocultar && i.qtd_planejada > 0 && i.qtd_separada >= i.qtd_planejada));

  async function corrigirSku(it: ItemPk) {
    const v = await pedirTextoSep({
      kicker: `SKU ${it.sku ?? "—"}`,
      titulo: "Corrigir o SKU deste item",
      atual: it.sku ?? "",
      placeholder: "ex.: 15984",
      ajuda: "Use o SKU do cadastro do Tiny. O SKU que veio do marketplace fica guardado como origem.",
      okTxt: "Trocar SKU",
    });
    if (v != null && v.trim() && v.trim() !== it.sku) p.onTrocarSku(it, v.trim());
  }
  async function etiquetaItem(it: ItemPk) {
    if (!it.sku) return;
    const v = await pedirTextoSep({
      kicker: `Etiqueta de produto · ${imp?.nome ?? "impressora"}`,
      titulo: `Quantas etiquetas do SKU ${it.sku}?`,
      atual: String(it.qtd_planejada),
      ajuda: it.titulo ?? undefined,
      okTxt: "Imprimir",
    });
    const n = parseInt(v ?? "", 10);
    if (n > 0) p.onImprimirSku(it.sku, n);
  }

  const ladoVisivel = !estreito || mais;
  const docsNormais = p.docs;

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, color: "var(--pm-t)", fontSize: 13, lineHeight: 1.4, fontVariantNumeric: "tabular-nums" }}>
      <HostDialogosSep />
      <input ref={zplRef} type="file" accept=".txt,.zpl,text/plain" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) p.onSubirZpl(f); }} />
      <input ref={docRef} type="file" accept="application/pdf,.pdf,image/*,.zpl,.txt" multiple style={{ display: "none" }}
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.currentTarget.value = ""; if (fs.length) p.onSubirDocs(fs); }} />
      <input ref={pdfRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) p.onAtualizarPdf(f); }} />

      {/* topo fixo: progresso, passos e o próximo passo */}
      <div style={{ position: "sticky", top: 69, zIndex: 6, background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 14, boxShadow: "var(--pm-shl)", padding: "14px 16px", display: "flex", flexWrap: "wrap", gap: "14px 28px", alignItems: "center" }}>
        <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px" }}>
            <span style={{ width: 20, height: 20, borderRadius: 5, flex: "none", boxShadow: "0 0 0 1px var(--pm-b)", background: `#fff url(${LOGO[envio.marketplace] ?? LOGO.shopee}) center/contain no-repeat` }} />
            <span className={MONO} style={{ fontSize: 15, fontWeight: 600 }}>{envio.numero ? (/^\d+$/.test(envio.numero) ? `#${envio.numero}` : envio.numero) : "(sem nº)"}</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap" }}>{NOME_EMP[envio.empresa ?? "ACZ Pet"] ?? envio.empresa ?? "Ottz Pet"}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "2px 8px", borderRadius: 6, background: "var(--pm-s2)" }}>
              <i style={{ width: 8, height: 8, borderRadius: 2, background: etapa.cor }} />{etapa.nome}
            </span>
            <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>
              {nomeConta(envio.marketplace, envio.empresa)}{envio.centro ? ` · ${envio.centro}` : ""} · {coletaTxt(envio)}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
            <span style={{ fontSize: 14, color: "var(--pm-t2)", fontWeight: 500 }}>Separado</span>
            <span className={MONO} style={{ fontSize: estreito ? 26 : 32, fontWeight: 600, letterSpacing: "-0.02em" }}>{int(sep)}</span>
            <span className={MONO} style={{ fontSize: 16, color: "var(--pm-t2)" }}>de {int(plan)} un</span>
            <span className={MONO} style={{ fontSize: 16, fontWeight: 600, color: falta === 0 && plan > 0 ? "var(--pm-g)" : "var(--pm-a)" }}>· {pct}%</span>
          </div>
          <div style={{ height: 10, borderRadius: 5, background: "var(--pm-sk)", overflow: "hidden" }}>
            <i style={{ display: "block", height: "100%", width: `${pct}%`, background: falta === 0 && plan > 0 ? "var(--pm-g)" : "var(--pm-a)", borderRadius: 5, transition: "width .25s" }} />
          </div>
          <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>
            {itens.length === 0 ? "Nenhum item neste envio."
              : falta > 0 ? `Faltam ${int(falta)} un em ${incomp.length} ${incomp.length === 1 ? "item" : "itens"} · ${nOk} de ${itens.length} itens completos`
              : `Todos os ${itens.length} itens completos`}
          </span>
        </div>
        <div style={{ flex: "0 1 340px", minWidth: 260, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 4 }}>
            {passos.map((x) => (
              <div key={x.nome} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <i style={{ height: 4, borderRadius: 2, background: x.bar }} />
                <span style={{ fontSize: 11, color: x.cor, fontWeight: x.fw, whiteSpace: "nowrap" }}>{x.nome}</span>
              </div>
            ))}
          </div>
          {!estreito && (
            <>
              {botaoPrim(50)}
              <span style={{ fontSize: 11.5, color: "var(--pm-t3)", textWrap: "pretty" }}>{prim.nota}</span>
            </>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: estreito ? "minmax(0,1fr)" : "minmax(0,1fr) 300px", gap: 12, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          {p.extraTopo}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Itens</span>
            <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{itens.length} itens · {nOk} completos · contagem salva sozinha</span>
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setOcultar((v) => !v)}
              style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t)" }}>
              <span style={{ width: 30, height: 18, borderRadius: 9, background: ocultar ? "var(--pm-a)" : "var(--pm-bs)", position: "relative", flex: "none" }}>
                <i style={{ position: "absolute", top: 2, left: ocultar ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "var(--pm-s)", boxShadow: "var(--pm-sh)", transition: "left .15s" }} />
              </span>
              Ocultar completos · {nOk}
            </button>
          </div>

          {p.carregandoItens ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,290px),1fr))", gap: 10 }}>
              {[1, 2, 3, 4, 5, 6].map((k) => (
                <div key={k} style={{ height: 142, borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 12, display: "flex", gap: 10 }}>
                  <div style={{ width: 56, height: 56, borderRadius: 10, background: "var(--pm-sk)" }} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ width: "80%", height: 12, borderRadius: 5, background: "var(--pm-sk)" }} />
                    <div style={{ width: "40%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,290px),1fr))", gap: 10 }}>
                {visiveis.map((it) => (
                  <CartaoItem
                    key={it.id}
                    it={it}
                    foto={it.sku ? p.fotos[it.sku] ?? null : null}
                    semCad={!!it.sku && p.semCadastro.has(it.sku)}
                    temEtiqueta={p.temEtiquetaSku(it.sku)}
                    imprimindo={p.imprimindoSku === it.sku}
                    onSet={(n) => p.onSet(it, n)}
                    onCorrigir={() => void corrigirSku(it)}
                    onEtiqueta={() => void etiquetaItem(it)}
                  />
                ))}
              </div>
              {ocultar && nOk > 0 && (
                <button type="button" onClick={() => setOcultar(false)}
                  style={{ height: 44, borderRadius: 12, border: "1px dashed var(--pm-bs)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)" }}>
                  {nOk} {nOk === 1 ? "item completo oculto" : "itens completos ocultos"} · mostrar
                </button>
              )}
            </>
          )}
          {p.extraBaixo}
        </div>

        {estreito && (
          <button type="button" onClick={() => setMais((v) => !v)}
            style={{ height: 44, borderRadius: 12, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--pm-t)" }}>
            Documentos, impressora e cadastro
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: mais ? "rotate(90deg)" : "none" }}><path d="m9 18 6-6-6-6" /></svg>
          </button>
        )}

        {ladoVisivel && (
          <aside style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div style={card}>
              <span style={tituloCard}>Impressora</span>
              <select value={p.printerId || ""} onChange={(e) => p.onPrinter(Number(e.target.value))} style={campo}>
                {p.impressoras.length === 0 && <option value="">Nenhuma ZD220</option>}
                {p.impressoras.map((x) => (
                  <option key={x.printer_id} value={x.printer_id}>
                    {x.configurada ? "★ " : ""}{x.nome} — {x.computador}{x.estado !== "online" ? ` (${x.estado})` : ""}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 11, color: imp && imp.estado !== "online" ? "var(--pm-am)" : "var(--pm-t3)" }}>
                {imp && imp.estado !== "online" ? `${imp.nome} está ${imp.estado}` : "vale para todas as etiquetas deste envio"}
              </span>
            </div>

            <div style={{ ...card, padding: 0, gap: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "12px 14px 6px" }}>
                <span style={tituloCard}>Documentos</span>
                <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>tipo lido pelo nome do arquivo</span>
              </div>
              {p.extraDocs && <div style={{ padding: "0 14px 8px" }}>{p.extraDocs}</div>}
              {p.temEtiquetaVolume && p.nEtiquetasVolume > 0 && (
                <LinhaDoc
                  tipo="Etiquetas de volume (ZPL)"
                  arq={`${int(p.nEtiquetasVolume)} etiquetas`}
                  acoes={<>
                    <button type="button" title={`Imprimir na ${imp?.nome ?? "impressora"}`} disabled={p.imprimindoVolume} onClick={() => void imprimirVolume()} style={btnQuad(32)}>{p.imprimindoVolume ? <Spin /> : <IcImp s={14} />}</button>
                    <button type="button" title="Trocar o arquivo das etiquetas" onClick={() => zplRef.current?.click()} style={{ ...btnQuad(32), color: "var(--pm-t3)" }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>
                    </button>
                  </>}
                />
              )}
              {p.carregandoDocs && <div style={{ margin: "4px 14px 14px", height: 120, borderRadius: 10, background: "var(--pm-sk)" }} />}
              {p.erroDocs && !p.carregandoDocs && (
                <div style={{ margin: "4px 14px 14px", display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 10, background: "var(--pm-rs)", fontSize: 12 }}>
                  <b style={{ color: "var(--pm-r)", fontWeight: 600 }}>Não deu para ler os documentos agora</b>
                  <span style={{ color: "var(--pm-t2)" }}>A contagem e as ações acima seguem funcionando.</span>
                  <button type="button" onClick={p.onTentarDocs} style={{ alignSelf: "flex-start", height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Tentar de novo</button>
                </div>
              )}
              {!p.carregandoDocs && !p.erroDocs && (
                <>
                  {docsNormais.map((d) => (
                    <LinhaDoc
                      key={d.id}
                      tipo={
                        <select value={d.tipo} onChange={(e) => p.onTipoDoc(d.id, e.target.value)} title="Tipo detectado — corrija se errou"
                          style={{ border: 0, background: "transparent", padding: 0, fontSize: 12.5, fontWeight: 500, color: "var(--pm-t)", cursor: "pointer", maxWidth: "100%" }}>
                          {p.tiposDoc.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                          {!p.tiposDoc.some((t) => t.id === d.tipo) && <option value={d.tipo}>{d.tipo}</option>}
                        </select>
                      }
                      arq={`${d.nome ?? "documento"}${d.tamanho ? ` · ${Math.round(d.tamanho / 1024)} KB` : ""}`}
                      onAbrir={() => p.onAbrirDoc(d)}
                      acoes={docDel === d.id ? (
                        <>
                          <span style={{ fontSize: 11.5, color: "var(--pm-r)" }}>Excluir?</span>
                          <button type="button" onClick={() => { setDocDel(null); p.onExcluirDoc(d); }} style={{ height: 30, padding: "0 8px", borderRadius: 7, border: 0, background: "var(--pm-r)", color: "var(--pm-or)", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>Sim</button>
                          <button type="button" onClick={() => setDocDel(null)} style={{ height: 30, padding: "0 8px", borderRadius: 7, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", fontSize: 11.5, color: "var(--pm-t)" }}>Não</button>
                        </>
                      ) : (
                        <>
                          {(d.mime ?? "").includes("pdf") && (
                            <button type="button" title={`Imprimir na ${imp?.nome ?? "impressora"}`} disabled={p.imprimindoDoc !== null} onClick={() => p.onImprimirDoc(d)} style={btnQuad(32)}>
                              {p.imprimindoDoc === d.id ? <Spin /> : <IcImp s={14} />}
                            </button>
                          )}
                          <button type="button" title="Excluir documento" onClick={() => setDocDel(d.id)} style={{ ...btnQuad(32), color: "var(--pm-t3)" }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                          </button>
                        </>
                      )}
                    />
                  ))}
                  <div style={{ display: "flex", gap: 6, margin: "6px 14px 12px" }}>
                    <button type="button" disabled={p.subindoDocs} onClick={() => docRef.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const fs = Array.from(e.dataTransfer.files ?? []); if (fs.length) p.onSubirDocs(fs); }}
                      title="Pode escolher ou soltar vários arquivos de uma vez (DANFE, folha de envio, etiquetas…)"
                      style={{ flex: 1, height: 36, borderRadius: 9, border: "1px dashed var(--pm-bs)", background: "transparent", cursor: "pointer", fontSize: 12.5, color: "var(--pm-t2)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                      {p.subindoDocs && <Spin />}{p.subindoDocs ? "Anexando…" : "Subir documento"}
                    </button>
                    {!p.temEtiquetaVolume && (
                      <button type="button" onClick={() => zplRef.current?.click()} title="Arquivo de etiquetas de volume (.zpl / .txt)"
                        style={{ height: 36, padding: "0 10px", borderRadius: 9, border: "1px dashed var(--pm-bs)", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--pm-t2)" }}>
                        Etiquetas ZPL
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            <div style={card}>
              <span style={tituloCard}>Observações</span>
              <textarea value={p.obs} onChange={(e) => p.onObs(e.target.value)} onBlur={p.onSalvarObs}
                placeholder="Recado para quem embala ou para a coleta"
                style={{ minHeight: 64, resize: "vertical", borderRadius: 9, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", padding: "8px 10px", fontSize: 12.5, color: "var(--pm-t)" }} />
            </div>

            <div style={card}>
              <span style={tituloCard}>Recebimento no CD</span>
              <span style={{ fontSize: 12, color: "var(--pm-t2)", textWrap: "pretty" }}>{recebimentoTxt[envio.marketplace] ?? recebimentoTxt.shopee}</span>
            </div>

            <div style={{ ...card, gap: 8 }}>
              <span style={tituloCard}>Cadastro do envio</span>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--pm-t3)" }}>
                Etapa
                <select value={envio.status} onChange={(e) => p.onEtapa(e.target.value)} style={campo}>
                  {ETAPAS.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5, color: "var(--pm-t3)" }}>
                Data da coleta
                <input type="date" value={p.dataAg} onChange={(e) => p.onDataAg(e.target.value)} onBlur={p.onSalvarDataAg} style={campo} />
              </label>
              {addAberto ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 8, borderRadius: 10, background: "var(--pm-s2)" }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input autoFocus value={p.novoSku} onChange={(e) => p.onNovoSku(e.target.value)} placeholder="SKU" className={MONO}
                      onKeyDown={(e) => { if (e.key === "Enter") p.onAdicionar(); }} style={{ ...campo, flex: 1, minWidth: 0 }} />
                    <input value={p.novoQtd} onChange={(e) => p.onNovoQtd(e.target.value.replace(/[^\d]/g, ""))} placeholder="Qtd" inputMode="numeric" className={MONO}
                      onKeyDown={(e) => { if (e.key === "Enter") p.onAdicionar(); }} style={{ ...campo, width: 70, textAlign: "center" }} />
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="button" onClick={() => setAddAberto(false)} style={{ ...btnLinha, flex: 1, height: 34 }}>Fechar</button>
                    <button type="button" disabled={p.adicionando} onClick={p.onAdicionar}
                      style={{ ...btnLinha, flex: 1, height: 34, border: 0, background: "var(--pm-a)", color: "var(--pm-oa)", fontWeight: 600 }}>
                      {p.adicionando && <Spin />}Adicionar
                    </button>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>A quantidade entra como embalada (é o que vira estoque no lançamento).</span>
                </div>
              ) : (
                <button type="button" onClick={() => setAddAberto(true)} style={btnLinha}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
                  Adicionar item
                </button>
              )}
              <button type="button" disabled={p.atualizandoPdf} onClick={() => pdfRef.current?.click()} style={btnLinha}
                title="O marketplace mudou o envio? Suba o novo PDF de preparação: produtos e quantidades são atualizados, a separação já feita é preservada e a equipe é avisada no Discord.">
                {p.atualizandoPdf && <Spin />}Atualizar pelo PDF do marketplace
              </button>
              <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Para corrigir um SKU, clique no SKU no cartão do item.</span>
              <button type="button" onClick={p.onExcluirEnvio} style={{ ...btnLinha, color: "var(--pm-r)" }}>Excluir envio</button>
            </div>
          </aside>
        )}
      </div>

      {estreito && (
        <div style={{ position: "sticky", bottom: 0, zIndex: 6, padding: "10px 0 4px", background: "linear-gradient(transparent, var(--pm-bg) 30%)", display: "flex", flexDirection: "column", gap: 4 }}>
          {botaoPrim(52)}
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)", textAlign: "center" }}>{prim.nota}</span>
        </div>
      )}
    </div>
  );
}

function LinhaDoc({ tipo, arq, acoes, onAbrir }: { tipo: ReactNode; arq: string; acoes: ReactNode; onAbrir?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--pm-b)" }}>
      <IcDoc />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, minWidth: 0 }}>{tipo}</span>
        {onAbrir ? (
          <button type="button" onClick={onAbrir} title="Abrir" className={MONO}
            style={{ border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", fontSize: 11, color: "var(--pm-at)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{arq}</button>
        ) : (
          <span className={MONO} style={{ fontSize: 11, color: "var(--pm-t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{arq}</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>{acoes}</div>
    </div>
  );
}

function CartaoItem({ it, foto, semCad, temEtiqueta, imprimindo, onSet, onCorrigir, onEtiqueta }: {
  it: ItemPk; foto: string | null; semCad: boolean; temEtiqueta: boolean; imprimindo: boolean;
  onSet: (n: number) => void; onCorrigir: () => void; onEtiqueta: () => void;
}) {
  const [txt, setTxt] = useState(String(it.qtd_separada));
  useEffect(() => { setTxt(String(it.qtd_separada)); }, [it.qtd_separada]);
  const [fotoOk, setFotoOk] = useState(true);
  const ok = it.qtd_planejada > 0 && it.qtd_separada >= it.qtd_planejada;
  const passou = it.qtd_separada > it.qtd_planejada;
  const commit = () => {
    const n = Math.max(0, parseInt(txt, 10) || 0);
    setTxt(String(n));
    if (n !== it.qtd_separada) onSet(n);
  };
  const ab = (it.titulo ?? it.sku ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div style={{ background: ok ? "var(--pm-gs)" : "var(--pm-s)", border: `1.5px solid ${ok ? "var(--pm-g)" : "var(--pm-b)"}`, borderRadius: 14, padding: 12, display: "flex", flexDirection: "column", gap: 10, boxShadow: "var(--pm-sh)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {foto && fotoOk ? (
          <img src={foto} alt="" loading="lazy" onError={() => setFotoOk(false)}
            style={{ width: 56, height: 56, flex: "none", borderRadius: 10, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-b)" }} />
        ) : (
          <span style={{ width: 56, height: 56, flex: "none", borderRadius: 10, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, color: "var(--pm-t3)" }}>{ab}</span>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3, textWrap: "pretty" }}>{it.titulo ?? "—"}</span>
          <button type="button" onClick={onCorrigir} title="Corrigir o SKU (ex.: veio errado do marketplace)" className={MONO}
            style={{ alignSelf: "flex-start", border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: 11.5, color: "var(--pm-t3)" }}>
            SKU {it.sku ?? "—"} ✎
          </button>
          {semCad && (
            <span style={{ fontSize: 11.5, color: "var(--pm-r)", fontWeight: 600 }}>
              sem cadastro no Tiny · <button type="button" onClick={onCorrigir} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", color: "var(--pm-r)", textDecoration: "underline", fontSize: 11.5, fontWeight: 600 }}>corrigir SKU</button>
            </span>
          )}
          {passou && <span style={{ fontSize: 11.5, color: "var(--pm-am)", fontWeight: 600 }}>{int(it.qtd_separada - it.qtd_planejada)} un a mais que o plano</span>}
        </div>
        {ok && (
          <span style={{ width: 26, height: 26, flex: "none", borderRadius: "50%", background: "var(--pm-g)", color: "var(--pm-s)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button type="button" aria-label="Menos um" disabled={it.qtd_separada <= 0} onClick={() => onSet(it.qtd_separada - 1)} style={{ ...btnQuad(44), color: "var(--pm-t)", opacity: it.qtd_separada <= 0 ? 0.45 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round"><path d="M5 12h14" /></svg>
        </button>
        <input value={txt} inputMode="numeric" className={MONO}
          onChange={(e) => setTxt(e.target.value.replace(/[^\d]/g, ""))}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
          style={{ width: 64, height: 44, flex: "none", textAlign: "center", borderRadius: 10, border: "1px solid var(--pm-bs)", background: "var(--pm-s)", fontSize: 18, fontWeight: 600, color: "var(--pm-t)" }} />
        <button type="button" aria-label="Mais um" onClick={() => onSet(it.qtd_separada + 1)} style={{ ...btnQuad(44), color: "var(--pm-t)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
        </button>
        <span className={MONO} style={{ fontSize: 13, color: "var(--pm-t2)", whiteSpace: "nowrap" }}>de {int(it.qtd_planejada)}</span>
        <div style={{ flex: 1 }} />
        {!ok && it.qtd_planejada > 0 && (
          <button type="button" onClick={() => onSet(it.qtd_planejada)}
            style={{ height: 44, padding: "0 12px", borderRadius: 10, border: "1px solid var(--pm-a)", background: "var(--pm-s)", color: "var(--pm-at)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
            Completar
          </button>
        )}
        <button type="button" onClick={onEtiqueta} disabled={!temEtiqueta || imprimindo}
          title={temEtiqueta ? "Imprimir as etiquetas deste item" : "Sem etiqueta ZPL deste SKU no arquivo anexado. Amazon (PDF): imprima o arquivo em Documentos."}
          style={{ ...btnQuad(44), opacity: temEtiqueta ? 1 : 0.4, cursor: temEtiqueta ? "pointer" : "default" }}>
          {imprimindo ? <Spin /> : <IcImp s={17} />}
        </button>
      </div>
    </div>
  );
}

/** Se a tela nova quebrar, mostra a antiga (mesma lógica, mesmos dados). */
export class ProtecaoPacking extends Component<{ antigo: ReactNode; children: ReactNode }, { erro: boolean }> {
  state = { erro: false };
  static getDerivedStateFromError() { return { erro: true }; }
  componentDidCatch(e: Error, info: ErrorInfo) { console.error("[Packing novo] caiu para o visual antigo:", e, info.componentStack); }
  render() { return this.state.erro ? this.props.antigo : this.props.children; }
}
