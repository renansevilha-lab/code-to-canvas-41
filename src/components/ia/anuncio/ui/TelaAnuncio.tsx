import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, ChevronLeft, ExternalLink } from "lucide-react";

import { LOGO } from "@/components/dashboard/formato";
import { formatBRL } from "@/lib/format";
import { rotuloFoto, urlsAssinadas, type IaEtapa, type IaRascunhoImagem } from "@/lib/iaAnuncio";
import type { ProdutoIa } from "@/components/ia/anuncio/ProdutoTopo";

// ============================================================================
// Tela do anúncio no design novo (Claude Design, pacote "Anúncios", 22/out/2026) — fase 2: o cabeçalho fixo
// (produto, DESTINO, progresso Texto → Fotos → Preço → Enviado e as abas) e a coluna da direita (preço do destino,
// capa principal do destino e onde o produto já está anunciado). Só apresentação: os blocos de texto, termos,
// referências e o envio são os de sempre, dentro do layout novo.
// ============================================================================

export interface LojaAnuncio { canal: string; empresa: string; nome: string; curto: string }
/** As lojas para onde o mesmo anúncio pode ir. Texto e fotos são um só; preço, capa principal e envio são de cada uma. */
export const LOJAS_ANUNCIO: LojaAnuncio[] = [
  { canal: "shopee", empresa: "ottz", nome: "Shopee Ottz", curto: "Shopee Ottz" },
  { canal: "shopee", empresa: "svl", nome: "Shopee Bumi", curto: "Shopee Bumi" },
  { canal: "mercado_livre", empresa: "ottz", nome: "Mercado Livre Ottz", curto: "ML Ottz" },
  { canal: "mercado_livre", empresa: "svl", nome: "Mercado Livre SVL", curto: "ML SVL" },
  { canal: "amazon", empresa: "ottz", nome: "Amazon ACZ", curto: "Amazon ACZ" },
  { canal: "amazon", empresa: "svl", nome: "Amazon SVL", curto: "Amazon SVL" },
  { canal: "tiktok", empresa: "ottz", nome: "TikTok ACZ", curto: "TikTok ACZ" },
];
const LOGO_CANAL: Record<string, string> = { shopee: LOGO.shopee, mercado_livre: LOGO.mercadolivre, amazon: LOGO.amazon, tiktok: LOGO.tiktok };
export const nomeLojaAnuncio = (canal: string, empresa: string) =>
  LOJAS_ANUNCIO.find((l) => l.canal === canal && l.empresa === empresa)?.nome ?? `${canal} ${empresa}`;

/** A capa que vai na frente em cada loja (mesma regra da anuncio-publicar, CAPA_DO_DESTINO). */
const CAPA_DO_DESTINO: Record<string, string[]> = {
  "shopee:ottz": ["capa_ambientada_shopee", "capa_shopee_basica", "capa_shopee_livre"],
  "shopee:svl": ["capa_ambientada_texto"],
  "mercado_livre:ottz": ["capa_ambientada_limpa"],
  "mercado_livre:svl": ["capa_ambientada_limpa"],
};

export interface AnuncioExistente { item_id: string; url?: string | null; status?: string | null }
export interface PublicacaoResumo { canal: string; empresa: string; estado: string; operacao: string | null; criado_em: string; criado_por_nome: string | null; item_id: string | null; url: string | null }
export type Passo = { nome: string; sub: string; st: "feito" | "aviso" | "falta" };

const MONO = "pm-mono";
const logo = (canal: string, px: number): CSSProperties => ({
  width: px, height: px, borderRadius: Math.round(px / 4), flex: "none", border: "1px solid var(--pm-b)",
  background: LOGO_CANAL[canal] ? `#fff url(${LOGO_CANAL[canal]}) center/contain no-repeat` : "var(--pm-s2)",
});
const btnSec: CSSProperties = {
  height: 36, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)",
  cursor: "pointer", fontSize: 12.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", textDecoration: "none",
};
const btnPri: CSSProperties = { ...btnSec, border: "1px solid var(--pm-a)", background: "var(--pm-a)", color: "var(--pm-oa)" };
export const dataCurta = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });

// ── cabeçalho fixo ───────────────────────────────────────────────────────────

export function CabecalhoAnuncio({ produto, custo, canal, empresa, onDestino, situacaoLoja, passos, falta, onConferir, podeConferir, abas, aba, onAba }: {
  produto: ProdutoIa; custo: number | null; canal: string; empresa: string; onDestino: (canal: string, empresa: string) => void;
  /** "já anunciado · 2345…" / "não anunciado" / "verificando…" por loja */
  situacaoLoja: (canal: string, empresa: string) => { t: string; cor: string };
  passos: Passo[]; falta: { t: string; cor: string }; onConferir: () => void; podeConferir: boolean;
  abas: { id: string | undefined; rotulo: string; n?: number }[]; aba: string | undefined; onAba: (id: string | undefined) => void;
}) {
  const [menu, setMenu] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const fora = (e: MouseEvent) => { if (!caixa.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [menu]);
  const loja = nomeLojaAnuncio(canal, empresa);
  const ini = (produto.nome ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const tipo = produto.tipo === "K" ? "Kit" : produto.tipo === "V" ? "Com variações" : "Simples";
  return (
    <div style={{ position: "sticky", top: 69, zIndex: 20, background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-shm)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px", padding: "10px 14px" }}>
        <Link to="/ia/anuncios" title="Voltar à lista" className="pm-hv" style={{ ...btnSec, paddingLeft: 6 }}><ChevronLeft className="h-4 w-4" />Lista</Link>
        {produto.foto
          ? <img src={produto.foto} alt="" style={{ width: 48, height: 48, flex: "none", borderRadius: 10, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-bs)" }} />
          : <span style={{ width: 48, height: 48, flex: "none", borderRadius: 10, background: "var(--pm-s2)", border: "1px solid var(--pm-bs)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "var(--pm-t2)" }}>{ini}</span>}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 240px" }}>
          <b style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em", lineHeight: 1.25 }}>{produto.nome}</b>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", fontSize: 12, color: "var(--pm-t2)" }}>
            <span className={MONO} style={{ fontWeight: 600, color: "var(--pm-t)" }}>{produto.sku}</span>
            <span style={{ fontSize: 11, fontWeight: 600, padding: "0 7px", borderRadius: 5, border: "1px solid var(--pm-bc)", color: "var(--pm-t)" }}>{tipo}</span>
            {produto.marca && <span style={{ whiteSpace: "nowrap" }}>{produto.marca}</span>}
            {produto.categoria_caminho && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }} title={produto.categoria_caminho}>{produto.categoria_caminho.split(" -> ").slice(-1)[0]}</span>}
            <span style={{ whiteSpace: "nowrap" }}>custo <b className={MONO} style={{ fontWeight: 600, color: custo == null ? "var(--pm-r)" : "var(--pm-t)" }}>{custo != null ? formatBRL(custo) : "sem custo"}</b></span>
          </div>
        </div>
        <div ref={caixa} style={{ display: "flex", alignItems: "center", gap: 10, position: "relative", flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11.5, color: "var(--pm-t2)", textAlign: "right", maxWidth: 260 }}>
            <span><b style={{ color: "var(--pm-at)" }}>Muda com o destino:</b> preço, capa principal, envio</span>
            <span><b style={{ color: "var(--pm-t)" }}>Um só para todas as lojas:</b> texto e fotos</span>
          </div>
          <button type="button" onClick={() => setMenu((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 10, height: 48, padding: "0 12px", borderRadius: 11, border: "2px solid var(--pm-a)", background: "var(--pm-as)", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}>
            <span style={logo(canal, 24)} />
            <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--pm-at)", letterSpacing: "0.04em" }}>DESTINO</span>
              <b style={{ fontSize: 15, fontWeight: 700 }}>{loja}</b>
            </span>
            <ChevronDown className="h-4 w-4" />
          </button>
          {menu && (
            <div style={{ position: "absolute", right: 0, top: 54, zIndex: 40, width: 360, maxWidth: "90vw", background: "var(--pm-s)", border: "1px solid var(--pm-bc)", borderRadius: 14, boxShadow: "var(--pm-shl)", padding: 6, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 11.5, color: "var(--pm-t2)", padding: "6px 8px" }}>Preço, capa principal e envio seguem a loja escolhida</span>
              {LOJAS_ANUNCIO.map((l) => {
                const on = l.canal === canal && l.empresa === empresa;
                const st = situacaoLoja(l.canal, l.empresa);
                return (
                  <button key={`${l.canal}:${l.empresa}`} type="button" className={on ? "" : "pm-hv"} onClick={() => { setMenu(false); onDestino(l.canal, l.empresa); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 48, padding: "6px 10px", borderRadius: 9, border: `1px solid ${on ? "var(--pm-a)" : "transparent"}`, background: on ? "var(--pm-as)" : "transparent", cursor: "pointer", textAlign: "left", color: "var(--pm-t)" }}>
                    <span style={logo(l.canal, 20)} />
                    <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                      <b style={{ fontSize: 13, fontWeight: 600 }}>{l.nome}</b>
                      <span style={{ fontSize: 11.5, color: st.cor }}>{st.t}</span>
                    </span>
                    {on && <Check className="h-4 w-4" style={{ color: "var(--pm-at)" }} strokeWidth={2.5} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "8px 14px", borderTop: "1px solid var(--pm-b)", background: "var(--pm-s2)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          {passos.map((p, i) => {
            const cor = p.st === "feito" ? "var(--pm-g)" : p.st === "aviso" ? "var(--pm-am)" : "var(--pm-s)";
            return (
              <div key={p.nome} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px 4px 5px", borderRadius: 20, border: `1px solid ${p.st === "aviso" ? "var(--pm-am)" : "var(--pm-bs)"}`, background: "var(--pm-s)" }}>
                  <span style={{ width: 22, height: 22, borderRadius: "50%", background: cor, color: p.st === "falta" ? "var(--pm-t2)" : "#fff", border: `1.5px solid ${p.st === "falta" ? "var(--pm-bc)" : cor}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
                    {p.st === "feito" ? "✓" : p.st === "aviso" ? "!" : i + 1}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
                    <b style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap" }}>{p.nome}</b>
                    <span style={{ fontSize: 11, fontWeight: 500, whiteSpace: "nowrap", color: p.st === "aviso" ? "var(--pm-am)" : p.st === "feito" ? "var(--pm-g)" : "var(--pm-t2)" }}>{p.sub}</span>
                  </span>
                </div>
                {i < passos.length - 1 && <ArrowRight className="h-3.5 w-3.5" style={{ color: "var(--pm-t2)" }} />}
              </div>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: falta.cor, maxWidth: 420, textWrap: "pretty" }}>{falta.t}</span>
        <button type="button" onClick={onConferir} disabled={!podeConferir} className={podeConferir ? "pm-hv-a" : ""}
          style={{ ...btnPri, height: 38, padding: "0 14px", fontSize: 13, opacity: podeConferir ? 1 : 0.5, cursor: podeConferir ? "pointer" : "not-allowed" }}>
          Conferir envio · {loja}
        </button>
      </div>

      <nav style={{ display: "flex", gap: 2, padding: "0 10px", borderTop: "1px solid var(--pm-b)", overflowX: "auto" }}>
        {abas.map((t) => {
          const on = aba === t.id;
          return (
            <button key={t.rotulo} type="button" onClick={() => onAba(t.id)} className={on ? "" : "pm-hv"}
              style={{ border: 0, background: "transparent", cursor: "pointer", padding: "10px 12px 8px", borderBottom: `3px solid ${on ? "var(--pm-a)" : "transparent"}`, fontSize: 13.5, fontWeight: on ? 700 : 500, color: on ? "var(--pm-t)" : "var(--pm-t2)", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
              {t.rotulo}
              {!!t.n && <span style={{ fontSize: 11, fontWeight: 700, padding: "0 7px", borderRadius: 9, background: "var(--pm-ams)", color: "var(--pm-am)" }}>{t.n}</span>}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

// ── coluna da direita ────────────────────────────────────────────────────────

/** Moldura de seção no padrão novo, com a faixa roxa no topo quando o bloco é "deste destino". */
export function SecaoPm({ titulo, selo, direita, destino, children, logoCanal }: {
  titulo: ReactNode; selo?: string; direita?: ReactNode; destino?: boolean; children: ReactNode; logoCanal?: string;
}) {
  return (
    <section style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderTop: destino ? "4px solid var(--pm-a)" : "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 10px", padding: "10px 14px", borderBottom: "1px solid var(--pm-b)" }}>
        {logoCanal && <span style={logo(logoCanal, 18)} />}
        <b style={{ fontSize: 14, fontWeight: 700 }}>{titulo}</b>
        {selo && <span style={{ fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 6, background: destino ? "var(--pm-as)" : "transparent", border: destino ? 0 : "1px solid var(--pm-bc)", color: destino ? "var(--pm-at)" : "var(--pm-t)" }}>{selo}</span>}
        <div style={{ flex: 1 }} />
        {direita}
      </div>
      {children}
    </section>
  );
}

/** A capa que vai na frente nesta loja (regra da anuncio-publicar) — a aprovada do tipo certo, ou o aviso de que falta. */
export function CapaDestino({ canal, empresa, imagens, etapas, onFotos }: {
  canal: string; empresa: string; imagens: IaRascunhoImagem[]; etapas: IaEtapa[]; onFotos: () => void;
}) {
  const tipos = CAPA_DO_DESTINO[`${canal}:${empresa}`];
  const aprovada = (i: IaRascunhoImagem) => !!i.storage_path && etapas.some((e) => e.imagem_id === i.id && e.status === "aprovado");
  const capa = tipos
    ? tipos.map((t) => imagens.find((i) => i.tipo === t && aprovada(i))).find(Boolean) ?? null
    : imagens.find((i) => (i.tipo ?? "").startsWith("capa") && aprovada(i)) ?? imagens.find(aprovada) ?? null;
  const urlQ = useQuery({
    queryKey: ["ia-anuncio", "url", capa?.storage_path ?? ""],
    enabled: !!capa?.storage_path,
    staleTime: 50 * 60_000,
    queryFn: async () => (await urlsAssinadas([capa!.storage_path!]))[capa!.storage_path!] ?? null,
  });
  const loja = nomeLojaAnuncio(canal, empresa).toUpperCase();
  return (
    <section style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderTop: "4px solid var(--pm-a)", borderRadius: 14, boxShadow: "var(--pm-sh)", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
      {urlQ.data
        ? <img src={urlQ.data} alt="" style={{ width: 72, height: 72, flex: "none", borderRadius: 10, objectFit: "cover", border: "1px solid var(--pm-bs)", background: "#fff" }} />
        : <span className={MONO} style={{ width: 72, height: 72, flex: "none", borderRadius: 10, border: "1px solid var(--pm-bs)", background: "repeating-linear-gradient(135deg,var(--pm-s2) 0 8px,var(--pm-hv) 8px 16px)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600, color: "var(--pm-t2)" }}>capa</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--pm-at)" }}>CAPA PRINCIPAL · {loja}</span>
        {capa
          ? <b style={{ fontSize: 13, fontWeight: 600 }}>{rotuloFoto(capa.tipo ?? "")}</b>
          : <b style={{ fontSize: 13, fontWeight: 600, color: "var(--pm-am)" }}>
              {tipos ? `Falta aprovar a capa desta loja (${rotuloFoto(tipos[0])})` : "Nenhuma foto aprovada ainda"}
            </b>}
        {capa && tipos && <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>vai na frente; as outras capas não vão para esta loja</span>}
        <button type="button" onClick={onFotos} className="pm-hv" style={{ ...btnSec, alignSelf: "flex-start", marginTop: 4, height: 30, padding: "0 10px", fontSize: 12 }}>
          {capa ? "Trocar na aba Fotos" : "Ir para a aba Fotos"}
        </button>
      </div>
    </section>
  );
}

/** Onde o produto já está anunciado, loja a loja, com o último envio pelo app e o botão de enviar. */
export function OndeAnunciado({ canal, empresa, listaDe, carregando, publicacoes, onEnviar }: {
  canal: string; empresa: string;
  listaDe: (canal: string, empresa: string) => AnuncioExistente[] | null | undefined;
  carregando: boolean; publicacoes: PublicacaoResumo[]; onEnviar: (canal: string, empresa: string) => void;
}) {
  return (
    <SecaoPm titulo="Onde está anunciado">
      {LOJAS_ANUNCIO.filter((l) => l.canal !== "tiktok").map((l) => {
        const on = l.canal === canal && l.empresa === empresa;
        const lista = listaDe(l.canal, l.empresa);
        const ultimo = publicacoes.find((p) => p.canal === l.canal && p.empresa === l.empresa);
        const tem = !!lista && lista.length > 0;
        return (
          <div key={`${l.canal}:${l.empresa}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderTop: "1px solid var(--pm-b)", background: on ? "var(--pm-as)" : "transparent", borderLeft: `4px solid ${on ? "var(--pm-a)" : "transparent"}` }}>
            <span style={logo(l.canal, 20)} />
            <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 13, fontWeight: 600 }}>{l.nome}</b>
              {carregando && lista === undefined ? <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>verificando…</span>
                : lista == null ? <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>não deu para verificar</span>
                : tem ? (
                  <span style={{ display: "flex", flexWrap: "wrap", gap: "0 8px" }}>
                    {lista.slice(0, 2).map((e) => e.url
                      ? <a key={e.item_id} href={e.url} target="_blank" rel="noreferrer" className={MONO} style={{ fontSize: 11.5, fontWeight: 600, color: "var(--pm-at)", display: "inline-flex", alignItems: "center", gap: 3 }}>{e.item_id}<ExternalLink className="h-3 w-3" /></a>
                      : <span key={e.item_id} className={MONO} style={{ fontSize: 11.5, fontWeight: 600 }}>{e.item_id}</span>)}
                    {lista.length > 2 && <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>+{lista.length - 2}</span>}
                  </span>
                ) : <span style={{ fontSize: 11.5, color: "var(--pm-t2)", fontWeight: 600 }}>não anunciado</span>}
              <span style={{ fontSize: 11, color: ultimo?.estado === "erro" ? "var(--pm-r)" : "var(--pm-t2)" }}>
                {ultimo
                  ? `${ultimo.estado === "erro" ? "erro no envio" : ultimo.operacao === "criar" ? "criado" : "atualizado"} pelo app ${dataCurta(ultimo.criado_em)}${ultimo.criado_por_nome ? ` · ${ultimo.criado_por_nome}` : ""}`
                  : "nunca enviado pelo app"}
              </span>
            </span>
            <button type="button" onClick={() => onEnviar(l.canal, l.empresa)} className={on ? "pm-hv-a" : "pm-hv"} style={{ ...(on ? btnPri : btnSec), height: 34 }}>
              {tem ? "Atualizar" : "Criar"}
            </button>
          </div>
        );
      })}
    </SecaoPm>
  );
}
