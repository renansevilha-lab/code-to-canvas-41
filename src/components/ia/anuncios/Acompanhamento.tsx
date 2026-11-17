// Aba Anúncios — visões "Anúncios no ar" e "Mudanças" (16/nov/2026; proposta aprovada pelo dono em
// https://claude.ai/artifact/97jDGeVyqvZr6xZhfzwmj1: "pode aplicar, abre em Anúncios no ar, começa pela Shopee").
// Só apresentação: os números, as regras da faixa "Pede atenção" e o efeito de cada mudança vêm do banco
// (anuncios_no_ar, anuncios_mudancas, anuncio_no_ar_detalhe — docs/anuncios-no-ar-marketplaces.sql).
// 16/nov (2ª parte): os quatro marketplaces (Shopee, Mercado Livre, Amazon, TikTok) com ícone, "Todos" como padrão,
// período de 7 ou 30 dias, contador da regra de parada do teste e Desfazer / Tentar de novo no histórico.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, LayoutGrid, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { int } from "@/components/dashboard/formato";
import { AnaliseAnuncioAds } from "@/components/ads/AnaliseAnuncioAds";
import { BlocoOQueFazer, PainelTestesAB, chamarTesteAb, marcacoesDoItem, useMarcacoes } from "@/components/ads/MarcacoesTeste";

export type Visao = "noar" | "produtos" | "mudancas";
export type BuscaVisao = {
  ver?: string; q?: string; loja?: string; at?: string; ord?: string; mud7?: string; teste?: string; p?: number; f?: string; campo?: string;
  /** marketplace (sem valor = todos) · dias = período de Anúncios no ar ("30"; padrão 7) · per = período de Mudanças ("7"; padrão 30) */
  mk?: string; dias?: string; per?: string;
};

type Mudanca = {
  quando: string; campo: string; de: string | null; para: string | null; descricao: string; origem: "app" | "fora" | "teste";
  quem: string | null; ok: boolean; log_id: number | null; braco: string | null; campanha: string | null;
  antes?: number | null; depois?: number | null; dias_depois?: number | null; completo_em?: string | null; piorou?: boolean; melhorou?: boolean;
};
type Linha = {
  /** shop = id da loja em TEXTO (o do TikTok não cabe em número do JavaScript) */
  mkt: string; shop: string; item_id: string; nome: string; foto: string | null; sku: string | null; loja: string; empresa: string; n_var: number;
  link: string | null; asin: string | null; rateado: boolean;
  preco: number | null; preco_ate: number | null; preco_cheio: number | null; estoque: number | null; dias_estoque: number | null;
  v7: number; v7a: number; u7: number; g7: number; roas: number | null; meta: number | null; mc_pct: number | null; mc_pos_pct: number | null;
  campaign_id: string | null; campanha_status: string | null; orcamento: number | null;
  f_estoque: boolean; f_caindo: boolean; f_prejuizo: boolean; f_teste: boolean; f_teste_pend: boolean;
  marcacoes: { id: number; braco: string; estrategia: string; status: string }[] | null;
  n7: number; n7_sis: number; ultima: string | null; ultima_mudanca: Mudanca | null; sku_editar: string | null;
};
type NoAr = {
  total: number; no_ar: number; de: string; ate: string; linhas: Linha[]; dias: number; por_mkt: Record<string, number>;
  resumo: { vendendo: number; receita7: number | null; receita7a: number | null; ads7: number | null };
  atencao: { estoque: number; zerado: number; caindo: number; caindo_rs: number; prejuizo: number; prejuizo_rs: number; medicao: number; medicao_anuncios: number; teste: number; teste_bracos: string };
};
type LinhaMud = Mudanca & { mkt: string; shop: string; loja: string; item_id: string; nome: string | null; foto: string | null; sku: string | null; link: string | null };
type Mudancas = { total: number; hoje: string; contagem: Record<string, number>; linhas: LinhaMud[] };
type Detalhe = {
  serie: { data: string; venda: number; gasto: number; un: number }[]; mudancas: Mudanca[]; hoje: string;
  campanhas: { campaign_id: string; status: string | null; roas_target: number | null; budget: number | null; nome: string | null }[];
  variacoes: { sku: string | null; preco: number | null; preco_cheio: number | null; estoque: number | null }[];
  /** contador da regra de parada do teste A/B: cliques e ROAS do ADS desde o dia em que o braço foi aplicado */
  teste?: { braco: string; desde: string; regra: string | null; cliques: number; gasto: number; dias: number; roas: number | null }[];
};

// marketplaces da aba: "" = todos (padrão pedido pelo dono)
const MKTS: { id: string; nome: string; logo: string | null; dica: string }[] = [
  { id: "", nome: "Todos", logo: null, dica: "Todos os marketplaces juntos" },
  { id: "shopee", nome: "Shopee", logo: "/logos/shopee-icon.png", dica: "Lojas Ottz e Bumi" },
  { id: "ml", nome: "Mercado Livre", logo: "/logos/ml-icon.png", dica: "Conta Ottz (a conta SVL não tem espelho dos anúncios)" },
  { id: "amazon", nome: "Amazon", logo: "/logos/amazon-icon.png", dica: "Contas ACZ e SVL: anúncios com estoque no CD ou venda em 30 dias" },
  { id: "tiktok", nome: "TikTok", logo: "/logos/tiktok-icon.png", dica: "Loja ACZ" },
];
const MKT = Object.fromEntries(MKTS.map((m) => [m.id, m]));
const CANAL_IA: Record<string, string> = { shopee: "shopee", ml: "mercado_livre", amazon: "amazon", tiktok: "tiktok" };
const temAds = (mkt: string) => mkt === "shopee" || mkt === "ml";

function LogoMkt({ mkt, tam = 16 }: { mkt: string; tam?: number }) {
  const m = MKT[mkt];
  if (!m?.logo) return <LayoutGrid style={{ width: tam, height: tam, flex: "none" }} />;
  return <img src={m.logo} alt={m.nome} title={m.nome} style={{ width: tam, height: tam, flex: "none", borderRadius: 4, objectFit: "contain" }} />;
}

/** Marketplaces com ícone; "Todos" primeiro e marcado quando não há escolha. */
function SeletorMkt({ valor, onMudar, contagem }: { valor: string | undefined; onMudar: (v: string | undefined) => void; contagem?: Record<string, number> }) {
  return (
    <div style={{ display: "flex", gap: 2, padding: 2, border: "1px solid var(--pm-bc)", borderRadius: 10, flexWrap: "wrap" }}>
      {MKTS.map((m) => {
        const on = (valor ?? "") === m.id;
        const n = contagem?.[m.id || "todos"];
        return (
          <button key={m.id || "todos"} type="button" title={m.dica} onClick={() => onMudar(m.id || undefined)} className={on ? "pm-hv-a" : "pm-hv"}
            style={{ border: 0, cursor: "pointer", height: 34, padding: "0 11px", borderRadius: 8, fontSize: 12.5, fontWeight: on ? 600 : 500, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t)", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
            <LogoMkt mkt={m.id} tam={16} />
            {m.nome}
            {n != null && <span className={MONO} style={{ fontSize: 11, opacity: on ? 0.9 : 0.6 }}>{int(n)}</span>}
          </button>
        );
      })}
    </div>
  );
}

const POR_PAGINA = 50;
const MONO = "pm-mono";
const num = (v: unknown) => Number(v ?? 0);
const brl0 = (v: unknown) => `R$ ${int(num(v))}`;
const dec1 = (v: unknown) => num(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const quandoTxt = (iso: string) => {
  const d = new Date(iso);
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const dia = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const hora = d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  return dia === hoje ? `hoje ${hora}` : `${dia.slice(0, 5)} ${hora}`;
};

const cartao: CSSProperties = { background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 14, boxShadow: "var(--pm-sh)" };
const btnSec: CSSProperties = {
  height: 40, padding: "0 14px", borderRadius: 10, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", whiteSpace: "nowrap",
};
const btnPri: CSSProperties = { ...btnSec, border: "1px solid var(--pm-a)", background: "var(--pm-a)", color: "var(--pm-oa)" };
const chip = (on: boolean): CSSProperties => ({
  height: 36, padding: "0 12px", borderRadius: 18, border: `1px solid ${on ? "var(--pm-a)" : "var(--pm-bc)"}`, background: on ? "var(--pm-a)" : "var(--pm-s)",
  color: on ? "var(--pm-oa)" : "var(--pm-t)", fontSize: 12.5, fontWeight: on ? 600 : 500, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
});
const campoCx: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, height: 40, padding: "0 10px", border: "1px solid var(--pm-bc)", borderRadius: 10, fontSize: 12, color: "var(--pm-t2)", background: "var(--pm-s)",
};
const selectCx: CSSProperties = { border: 0, background: "transparent", fontSize: 12.5, fontWeight: 600, color: "var(--pm-t)", cursor: "pointer", outline: "none", height: 34 };
const cab: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--pm-t2)" };
const sub: CSSProperties = { fontSize: 11, color: "var(--pm-t2)" };

/** Seletor das três visões da aba (Produtos · Anúncios no ar · Mudanças). */
export function SeletorVisao({ ver, onVer }: { ver: Visao; onVer: (v: Visao) => void }) {
  const ops: { id: Visao; nome: string }[] = [{ id: "produtos", nome: "Produtos" }, { id: "noar", nome: "Anúncios no ar" }, { id: "mudancas", nome: "Mudanças" }];
  return (
    <div style={{ display: "flex", gap: 2, padding: 3, border: "1px solid var(--pm-bc)", borderRadius: 12, background: "var(--pm-s)" }}>
      {ops.map((o) => {
        const on = o.id === ver;
        return (
          <button key={o.id} type="button" onClick={() => onVer(o.id)} className={on ? "pm-hv-a" : "pm-hv"}
            style={{ border: 0, cursor: "pointer", height: 38, padding: "0 14px", borderRadius: 9, fontSize: 13, fontWeight: on ? 600 : 500, background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t2)", whiteSpace: "nowrap" }}>
            {o.nome}
          </button>
        );
      })}
    </div>
  );
}

function rotuloMudanca(m: Mudanca): string {
  const seta = m.de != null && m.para != null ? ` ${fmtVal(m.campo, m.de)} → ${fmtVal(m.campo, m.para)}` : m.para != null ? ` ${fmtVal(m.campo, m.para)}` : "";
  const nome: Record<string, string> = {
    preco_venda: "Preço", preco_cheio: "Preço cheio", titulo: "Título trocado", descricao: "Descrição trocada", fotos: "Fotos", anuncio_criado: "Anúncio criado",
    promocao: "Promoção", status_anuncio: "Situação", roas: "ROAS alvo", orcamento: "Orçamento de ADS", campanha: "Campanha", campanha_nova: "Campanha por palavra-chave",
    relampago: "Relâmpago", desfeito: "Desfeito",
  };
  if (m.campo === "titulo") return "Título trocado";
  if (m.campo === "fotos" || m.campo === "desfeito" || m.campo === "anuncio_criado" || m.campo === "descricao") return m.campo === "fotos" ? `Fotos · ${m.descricao}` : m.descricao.charAt(0).toUpperCase() + m.descricao.slice(1);
  return `${nome[m.campo] ?? m.descricao}${seta}`;
}
function fmtVal(campo: string, v: string): string {
  if (campo === "preco_venda" || campo === "preco_cheio" || campo === "orcamento") { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v; }
  if (campo === "roas") { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : v; }
  if (campo === "campanha") return v === "paused" ? "pausada" : v === "ongoing" || v === "active" ? "rodando" : v === "ended" || v === "closed" ? "encerrada" : v;
  if (campo === "status_anuncio") return v === "NORMAL" || v === "active" ? "no ar" : v === "UNLIST" || v === "paused" ? "fora do ar" : v;
  return v;
}
const ORIGEM: Record<string, { nome: string; cor: string }> = {
  app: { nome: "pelo app", cor: "var(--pm-t)" }, teste: { nome: "teste A/B", cor: "var(--pm-at)" }, fora: { nome: "fora do app", cor: "var(--pm-t2)" },
};

/** Resultado de uma mudança: receita dos 7 dias antes → dos 7 dias a partir do dia (só dias fechados). */
function Efeito({ m }: { m: Mudanca }) {
  if (!m.ok) return <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-r)" }}>falhou · nada mudou</span>;
  const antes = num(m.antes), depois = num(m.depois), dias = num(m.dias_depois);
  if (dias < 7) {
    return (
      <span style={{ fontSize: 12 }}>
        <b style={{ color: "var(--pm-at)" }}>medindo · sai em {ddmm(m.completo_em)}</b>
        {dias >= 1 && <><br /><span style={sub}>{brl0(antes)} em 7 d → {brl0(depois)} em {dias} d</span></>}
      </span>
    );
  }
  if (antes === 0 && depois === 0) return <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>sem venda antes nem depois</span>;
  const cor = m.piorou || depois < 0.7 * antes ? "var(--pm-r)" : m.melhorou || depois > 1.3 * antes ? "var(--pm-g)" : "var(--pm-t)";
  const pct = antes > 0 ? Math.round((depois / antes - 1) * 100) : null;
  return (
    <span style={{ fontSize: 12 }}>
      <b style={{ color: cor }}>{brl0(antes)} → {brl0(depois)}</b>
      {pct != null && <><br /><span style={sub}>{pct > 0 ? "+" : ""}{pct}% na receita de 7 dias</span></>}
    </span>
  );
}

// ───────────────────────────────────────────── Anúncios no ar
const GRADE = "minmax(280px,2.3fr) 104px 148px 176px 128px 112px minmax(170px,1.4fr) 24px";
const ORDENS = [
  { id: "receita", nome: "Maior receita" }, { id: "queda", nome: "Maior queda" }, { id: "mexido", nome: "Mexido por último" },
  { id: "margem", nome: "Menor margem depois do ADS" }, { id: "estoque", nome: "Estoque acabando" },
];

export function AnunciosNoAr({ busca, set }: { busca: BuscaVisao; set: (x: Partial<BuscaVisao>) => void }) {
  const { q, loja, at, ord, mud7, teste, p, mk, dias } = busca;
  const pagina = p ?? 1;
  const [digitado, setDigitado] = useState(q ?? "");
  // a busca também muda por fora (botão Abrir das Mudanças): acompanha, sem atropelar o que está sendo digitado
  const enviado = useRef(q ?? "");
  useEffect(() => { if ((q ?? "") !== enviado.current) { enviado.current = q ?? ""; setDigitado(q ?? ""); } }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if ((q ?? "") !== digitado.trim()) { enviado.current = digitado.trim(); set({ q: digitado.trim() || undefined }); } }, 350);
    return () => clearTimeout(t);
  }, [digitado]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [analise, setAnalise] = useState<{ mkt: string; shop: string; campaignId: string; nome: string; item: string } | null>(null);
  const marcQ = useMarcacoes();

  const dadosQ = useQuery({
    queryKey: ["anuncios-no-ar", mk ?? "", dias ?? "", loja ?? "", q ?? "", at ?? "", ord ?? "", mud7 ?? "", teste ?? "", pagina],
    placeholderData: (ant) => ant,
    staleTime: 2 * 60_000,
    queryFn: async (): Promise<NoAr> => {
      const { data, error } = await supabaseExternal.rpc("anuncios_no_ar" as never, {
        p_empresa: loja ?? null, p_busca: q ?? null, p_atencao: at ?? null, p_so_teste: teste === "1", p_mudou7: mud7 === "1",
        p_ordem: ord ?? "receita", p_offset: (pagina - 1) * POR_PAGINA, p_limit: POR_PAGINA, p_mkt: mk ?? "todos", p_dias: dias === "30" ? 30 : 7,
      } as never);
      if (error) throw error;
      return data as unknown as NoAr;
    },
  });
  const d = dadosQ.data;
  const r = d?.resumo;
  const nd = d?.dias ?? (dias === "30" ? 30 : 7);
  const ondeTxt = mk ? `no ${MKT[mk]?.nome ?? mk}`.replace("no Shopee", "na Shopee").replace("no Amazon", "na Amazon") : "em todos os marketplaces";
  const varReceita = r && num(r.receita7a) > 0 ? Math.round((num(r.receita7) / num(r.receita7a) - 1) * 100) : null;
  const paginas = Math.max(1, Math.ceil((d?.total ?? 0) / POR_PAGINA));
  const a = d?.atencao;
  const cartoes: { id: string; n: number; nome: string; sub: string; cor: string }[] = a ? [
    { id: "estoque", n: a.estoque, nome: "Estoque acabando", sub: `menos de 7 dias de venda no anúncio${a.zerado ? ` · ${a.zerado} já zerado${a.zerado > 1 ? "s" : ""}` : ""}`, cor: "var(--pm-r)" },
    { id: "caindo", n: a.caindo, nome: "Vendas caindo", sub: `30% ou mais abaixo · ${brl0(a.caindo_rs)} a menos ${nd === 7 ? "na semana" : "em 30 dias"}`, cor: "var(--pm-am)" },
    { id: "prejuizo", n: a.prejuizo, nome: "Prejuízo depois do ADS", sub: `margem negativa em ${nd} dias · ${brl0(a.prejuizo_rs)} no total`, cor: "var(--pm-r)" },
    { id: "teste", n: a.teste, nome: "Testes A/B com pendência", sub: a.teste_bracos || "nenhum braço pendente", cor: "var(--pm-at)" },
    { id: "medicao", n: a.medicao, nome: "Mudanças em medição", sub: `do sistema, nos últimos 7 dias · ${a.medicao_anuncios} anúncio${a.medicao_anuncios === 1 ? "" : "s"}`, cor: "var(--pm-t)" },
  ] : [];

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 24px 96px", maxWidth: 1440, margin: "0 auto", color: "var(--pm-t)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "10px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>Anúncios</h1>
          <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>
            {r ? <>{int(r.vendendo)} anúncios venderam nos últimos {nd} dias {ondeTxt} · {brl0(r.receita7)}{varReceita != null && ` (${varReceita > 0 ? "+" : ""}${varReceita}% sobre os ${nd} dias antes)`} · ADS {brl0(r.ads7)}</>
              : "Acompanhamento dos anúncios que estão no ar"}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        {dadosQ.isFetching && <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--pm-t2)" }} />}
        <SeletorVisao ver="noar" onVer={(v) => set({ ver: v === "noar" ? undefined : v, p: undefined })} />
      </div>

      {dadosQ.isError && (
        <div style={{ ...cartao, padding: 14, borderColor: "var(--pm-r)", color: "var(--pm-r)", fontSize: 13 }}>
          Não consegui ler os anúncios: {(dadosQ.error as Error).message}{" "}
          <button type="button" style={{ ...btnSec, height: 32, marginLeft: 8 }} onClick={() => void dadosQ.refetch()}>Tentar de novo</button>
        </div>
      )}

      {/* pede atenção */}
      {a && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ ...cab, fontSize: 11.5, letterSpacing: "0.06em" }}>Pede atenção</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
            {cartoes.map((c) => {
              const on = at === c.id;
              return (
                <button key={c.id} type="button" onClick={() => set({ at: on ? undefined : c.id, p: undefined, ord: !on && c.id === "estoque" ? "estoque" : !on && c.id === "caindo" ? "queda" : !on && c.id === "prejuizo" ? "margem" : !on && c.id === "medicao" ? "mexido" : undefined })}
                  title={on ? "Tirar o filtro" : "Filtrar a lista"}
                  style={{ textAlign: "left", cursor: "pointer", background: on ? "var(--pm-as)" : "var(--pm-s)", border: on ? "1.5px solid var(--pm-a)" : "1px solid var(--pm-bs)", borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4, opacity: c.n === 0 && !on ? 0.7 : 1 }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <b style={{ fontSize: 26, fontWeight: 700, color: c.n === 0 ? "var(--pm-t3)" : c.cor, lineHeight: 1 }}>{int(c.n)}</b>
                    <b style={{ fontSize: 13, color: "var(--pm-t)" }}>{c.nome}</b>
                  </span>
                  <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{c.sub}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {at === "teste" && <PainelTestesAB />}

      {/* filtros */}
      <div style={{ ...cartao, padding: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <SeletorMkt valor={mk} contagem={d?.por_mkt} onMudar={(v) => { setAberto(null); set({ mk: v, p: undefined }); }} />
        <label style={campoCx}>Loja
          <select style={selectCx} value={loja ?? ""} onChange={(e) => set({ loja: e.target.value || undefined, p: undefined })}>
            <option value="">Todas</option><option value="ottz">Ottz / ACZ</option><option value="svl">Bumi / SVL</option>
          </select>
        </label>
        <label style={campoCx}>Período
          <select style={selectCx} value={dias === "30" ? "30" : "7"} onChange={(e) => set({ dias: e.target.value === "30" ? "30" : undefined, p: undefined })}>
            <option value="7">7 dias × 7 anteriores</option><option value="30">30 dias × 30 anteriores</option>
          </select>
        </label>
        <div style={{ ...campoCx, flex: "1 1 240px", minWidth: 200 }}>
          <Search className="h-4 w-4" />
          <input value={digitado} onChange={(e) => setDigitado(e.target.value)} placeholder="nome, SKU ou ID do anúncio"
            style={{ border: 0, outline: "none", background: "transparent", flex: 1, minWidth: 0, fontSize: 13, color: "var(--pm-t)" }} />
        </div>
        <label style={campoCx}>Ordem
          <select style={{ ...selectCx, maxWidth: 220 }} value={ord ?? "receita"} onChange={(e) => set({ ord: e.target.value === "receita" ? undefined : e.target.value, p: undefined })}>
            {ORDENS.map((o) => <option key={o.id} value={o.id}>{o.nome}</option>)}
          </select>
        </label>
        <button type="button" style={chip(teste === "1")} onClick={() => set({ teste: teste === "1" ? undefined : "1", p: undefined })}>Só com teste A/B</button>
        <button type="button" style={chip(mud7 === "1")} onClick={() => set({ mud7: mud7 === "1" ? undefined : "1", p: undefined })}>Mudou nos últimos 7 dias</button>
        {d && <span style={{ ...sub, marginLeft: "auto" }}>{nd} dias ({ddmm(d.de)} a {ddmm(d.ate)}) × os {nd} anteriores</span>}
      </div>

      {/* lista */}
      <div style={{ ...cartao, overflowX: "auto" }}>
        <div style={{ minWidth: 1160 }}>
          <div style={{ display: "grid", gridTemplateColumns: GRADE, gap: 14, padding: "9px 14px", background: "var(--pm-s2)", borderRadius: "14px 14px 0 0", ...cab }}>
            <span>Anúncio</span><span>Preço</span><span>Vendas {nd} dias</span><span>ADS · ROAS × meta</span><span>Margem</span><span>Estoque</span><span>Última mudança</span><span />
          </div>
          {dadosQ.isLoading && <div style={{ padding: 28, textAlign: "center", color: "var(--pm-t2)" }}><Loader2 className="h-4 w-4 animate-spin inline-block" /> Carregando os anúncios…</div>}
          {d && d.linhas.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "var(--pm-t2)", fontSize: 13 }}>Nenhum anúncio neste filtro.</div>}
          {(d?.linhas ?? []).map((x) => {
            const k = `${x.mkt}:${x.shop}:${x.item_id}`;
            const on = aberto === k;
            return (
              <div key={k}>
                <LinhaAnuncio x={x} aberto={on} onAbrir={() => setAberto(on ? null : k)} />
                {on && <DetalheAnuncio x={x} nd={nd} marcacoes={x.mkt === "shopee" ? marcacoesDoItem(marcQ.data?.porItem, x.shop, x.item_id) : []}
                  onAnalise={() => x.campaign_id && setAnalise({ mkt: x.mkt, shop: x.shop, campaignId: x.campaign_id, nome: x.nome, item: x.item_id })} />}
              </div>
            );
          })}
          {d && d.total > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12, color: "var(--pm-t2)" }}>
              <span>{int(d.total)} anúncio{d.total === 1 ? "" : "s"} neste filtro · {int(d.no_ar)} no ar · página {pagina} de {paginas}</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" style={{ ...btnSec, height: 36, opacity: pagina <= 1 ? 0.5 : 1 }} disabled={pagina <= 1} onClick={() => set({ p: pagina - 1 > 1 ? pagina - 1 : undefined })}>Anterior</button>
                <button type="button" style={{ ...btnSec, height: 36, opacity: pagina >= paginas ? 0.5 : 1 }} disabled={pagina >= paginas} onClick={() => set({ p: pagina + 1 })}>Próxima</button>
              </span>
            </div>
          )}
        </div>
      </div>

      {analise && (analise.mkt === "ml"
        ? <AnaliseAnuncioAds campaignId={analise.campaignId} nome={analise.nome} ml={{ item: analise.item }} onFechar={() => setAnalise(null)} />
        : <AnaliseAnuncioAds shopId={Number(analise.shop)} campaignId={analise.campaignId} nome={analise.nome} onFechar={() => setAnalise(null)} />)}
    </div>
  );
}

function LinhaAnuncio({ x, aberto, onAbrir }: { x: Linha; aberto: boolean; onAbrir: () => void }) {
  const delta = num(x.v7a) > 0 ? Math.round((num(x.v7) / num(x.v7a) - 1) * 100) : null;
  const corDelta = delta == null ? "var(--pm-t2)" : delta <= -30 ? "var(--pm-r)" : delta < 0 ? "var(--pm-am)" : "var(--pm-g)";
  const pctMeta = x.roas != null && x.meta ? Math.min(100, Math.round((num(x.roas) / num(x.meta)) * 100)) : null;
  const corRoas = x.f_prejuizo ? "var(--pm-r)" : pctMeta == null ? "var(--pm-t)" : pctMeta >= 100 ? "var(--pm-g)" : "var(--pm-am)";
  const um = x.ultima_mudanca;
  const mudouHoje = um && new Date(um.quando).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) === new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const ini = (x.nome ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return (
    <div role="button" tabIndex={0} onClick={onAbrir} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAbrir(); } }}
      className={aberto ? "" : "pm-linha-hv"}
      style={{ display: "grid", gridTemplateColumns: GRADE, gap: 14, alignItems: "center", padding: "11px 14px", borderTop: "1px solid var(--pm-b)", background: aberto ? "var(--pm-as)" : "var(--pm-s)", cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        {x.foto
          ? <img src={x.foto} alt="" loading="lazy" style={{ width: 44, height: 44, flex: "none", borderRadius: 9, objectFit: "cover", background: "#fff", border: "1px solid var(--pm-bs)" }} />
          : <span style={{ width: 44, height: 44, flex: "none", borderRadius: 9, background: "var(--pm-s2)", border: "1px solid var(--pm-bs)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--pm-t2)" }}>{ini}</span>}
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span title={x.nome} style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.nome}</span>
          <span style={{ fontSize: 11.5, color: "var(--pm-t2)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "3px 6px" }}>
            {x.sku && <span className={MONO} style={{ color: "var(--pm-t)" }}>{x.sku}</span>}
            <LogoMkt mkt={x.mkt} tam={14} />
            <span>{x.loja}{x.n_var > 0 ? ` · ${x.n_var} variações` : ""} · {x.asin ? `${x.asin} · ` : ""}{x.item_id}</span>
            {(x.marcacoes ?? []).map((m) => (
              <span key={m.id} style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 6, background: m.status === "nao_mexer" ? "var(--pm-s2)" : aberto ? "var(--pm-s)" : "var(--pm-as)", color: m.status === "nao_mexer" ? "var(--pm-t2)" : m.status === "divergente" ? "var(--pm-r)" : "var(--pm-at)", border: `1px solid ${m.status === "nao_mexer" ? "var(--pm-bc)" : m.status === "divergente" ? "var(--pm-r)" : "var(--pm-a)"}` }}>
                {m.status === "nao_mexer" ? "Teste A/B · controle, não mexer" : `Teste A/B · ${m.braco} ${m.estrategia}`}
              </span>
            ))}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <b style={{ fontSize: 13 }}>{x.preco != null ? formatBRL(num(x.preco)) : "—"}</b>
        <span style={mudouHoje && um?.campo === "preco_venda" ? { fontSize: 11, color: "var(--pm-at)", fontWeight: 600 } : sub}>
          {mudouHoje && um?.campo === "preco_venda" ? "mudou hoje" : x.preco_ate != null ? `até ${formatBRL(num(x.preco_ate))}` : x.preco_cheio != null ? `cheio ${formatBRL(num(x.preco_cheio))}` : x.mkt === "amazon" && x.preco != null ? "último vendido" : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span><b style={{ fontSize: 13 }}>{brl0(x.v7)}</b>{delta != null && <b style={{ fontSize: 11.5, color: corDelta }}> {delta > 0 ? "+" : ""}{delta}%</b>}</span>
        <span style={sub} title={x.rateado ? "O Mercado Livre não liga a venda ao anúncio: a venda do SKU foi dividida entre os anúncios ativos dele, na proporção das visitas" : undefined}>{x.rateado ? "≈ " : ""}{int(num(x.u7))} un · antes {brl0(x.v7a)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {num(x.g7) > 0 || x.meta != null ? (
          <>
            <span style={{ fontSize: 12 }}>{brl0(x.g7)}{x.roas != null && <> · <b style={{ color: corRoas }}>{dec1(x.roas)}</b></>} <span style={{ color: "var(--pm-t2)" }}>{x.meta != null ? `de ${dec1(x.meta)}` : "sem meta"}{x.campanha_status && x.campanha_status !== "ongoing" ? " · pausada" : ""}</span></span>
            {pctMeta != null && <span style={{ height: 6, borderRadius: 3, background: aberto ? "var(--pm-s)" : "var(--pm-s2)", display: "block" }}><span style={{ display: "block", width: `${pctMeta}%`, height: 6, borderRadius: 3, background: corRoas }} /></span>}
          </>
        ) : <span style={{ fontSize: 12, color: "var(--pm-t2)" }}>{temAds(x.mkt) ? "sem ADS" : "ADS não integrado"}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <b style={{ fontSize: 13 }}>{x.mc_pct != null ? `${dec1(x.mc_pct)}%` : "—"}</b>
        {x.mc_pos_pct != null && (
          <span style={{ fontSize: 11, fontWeight: num(x.mc_pos_pct) < 5 ? 600 : 400, color: num(x.mc_pos_pct) < 0 ? "var(--pm-r)" : num(x.mc_pos_pct) < 5 ? "var(--pm-am)" : "var(--pm-t2)" }}>
            {num(x.g7) > 0 ? `${dec1(x.mc_pos_pct)}% depois do ADS` : temAds(x.mkt) ? "sem gasto de ADS" : ""}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <b style={{ fontSize: 13, color: x.f_estoque ? "var(--pm-r)" : "var(--pm-t)" }}>{x.estoque != null ? int(num(x.estoque)) : "—"}</b>
        <span style={{ fontSize: 11, fontWeight: x.f_estoque ? 600 : 400, color: x.f_estoque ? "var(--pm-r)" : "var(--pm-t2)" }}>
          {x.estoque != null && num(x.estoque) <= 0 ? "zerado" : x.dias_estoque == null ? "" : num(x.dias_estoque) > 60 ? "sobra" : `dá para ${num(x.dias_estoque) < 10 ? dec1(x.dias_estoque) : int(num(x.dias_estoque))} dia${num(x.dias_estoque) >= 2 ? "s" : ""}`}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        {um ? (
          <>
            <span title={rotuloMudanca(um)} style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: um.ok ? "var(--pm-t)" : "var(--pm-r)" }}>{rotuloMudanca(um)}</span>
            <span style={sub}>{quandoTxt(um.quando)} · {ORIGEM[um.origem]?.nome ?? um.origem}{num(x.n7) > 1 ? ` · ${x.n7} em 7 dias` : ""}</span>
          </>
        ) : <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>sem mudança em 30 dias</span>}
      </div>
      {aberto ? <ChevronDown className="h-4 w-4" style={{ color: "var(--pm-at)" }} /> : <ChevronRight className="h-4 w-4" style={{ color: "var(--pm-t3)" }} />}
    </div>
  );
}

function DetalheAnuncio({ x, nd, marcacoes, onAnalise }: { x: Linha; nd: number; marcacoes: ReturnType<typeof marcacoesDoItem>; onAnalise: () => void }) {
  const q = useQuery({
    queryKey: ["anuncio-no-ar-detalhe", x.mkt, x.shop, x.item_id],
    staleTime: 60_000,
    queryFn: async (): Promise<Detalhe> => {
      const { data, error } = await supabaseExternal.rpc("anuncio_no_ar_detalhe" as never, { p_shop: x.shop, p_item: x.item_id, p_mkt: x.mkt } as never);
      if (error) throw error;
      return data as unknown as Detalhe;
    },
  });
  const det = q.data;
  const dias = det?.serie ?? [];
  const max = Math.max(1, ...dias.map((s) => num(s.venda)));
  const diasComMudanca = useMemo(() => new Set((det?.mudancas ?? []).map((m) => new Date(m.quando).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }))), [det]);
  const nomeMkt = MKT[x.mkt]?.nome ?? x.mkt;
  return (
    <div style={{ background: "var(--pm-as)", padding: "0 14px 14px" }}>
      <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 12, padding: 14, display: "flex", flexWrap: "wrap", gap: 18 }}>
        {q.isLoading && <div style={{ color: "var(--pm-t2)", fontSize: 13 }}><Loader2 className="h-4 w-4 animate-spin inline-block" /> Lendo o acompanhamento…</div>}
        {q.isError && <div style={{ color: "var(--pm-r)", fontSize: 13 }}>Não consegui ler o acompanhamento: {(q.error as Error).message}</div>}
        {det && (
          <>
            {/* vendas por dia */}
            <div style={{ flex: "1 1 300px", minWidth: 270, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}><b style={{ fontSize: 13 }}>Vendas por dia · 28 dias</b><span style={sub}>roxo = dia com mudança</span></div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 72, borderBottom: "1px solid var(--pm-b)" }}>
                {dias.map((s) => {
                  const marca = diasComMudanca.has(s.data);
                  const v = num(s.venda);
                  return <span key={s.data} title={`${ddmm(s.data)} · ${brl0(v)} · ${int(num(s.un))} un${num(s.gasto) > 0 ? ` · ADS ${brl0(s.gasto)}` : ""}${marca ? " · houve mudança" : ""}`}
                    style={{ flex: 1, minWidth: 4, borderRadius: "2px 2px 0 0", height: v > 0 ? Math.round(6 + (v / max) * 62) : 4, background: marca ? "var(--pm-a)" : v > 0 ? "var(--pm-g)" : "var(--pm-b)" }} />;
                })}
              </div>
              <div className={MONO} style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--pm-t2)" }}><span>{ddmm(dias[0]?.data)}</span><span>{ddmm(dias[dias.length - 1]?.data)}</span></div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
                <div style={{ background: "var(--pm-s2)", borderRadius: 9, padding: "8px 10px" }}><span style={sub}>Receita {nd} dias</span><br /><b style={{ fontSize: 14 }}>{brl0(x.v7)}</b> <span style={sub}>{int(num(x.u7))} un</span></div>
                <div style={{ background: "var(--pm-s2)", borderRadius: 9, padding: "8px 10px" }}><span style={sub}>ADS {nd} dias</span><br /><b style={{ fontSize: 14 }}>{temAds(x.mkt) ? brl0(x.g7) : "—"}</b> <span style={sub}>{!temAds(x.mkt) ? "não integrado" : x.roas != null ? `ROAS ${dec1(x.roas)}` : "sem ROAS"}</span></div>
              </div>
              {det.variacoes.length > 0 && (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--pm-at)" }}>Variações ({det.variacoes.length})</summary>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 6 }}>
                    {det.variacoes.map((v, i) => (
                      <span key={`${v.sku}-${i}`} style={{ fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span className={MONO}>{v.sku ?? "sem SKU"}</span><span>{v.preco != null ? formatBRL(num(v.preco)) : "—"} · {v.estoque != null ? `${int(num(v.estoque))} un` : "—"}</span>
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>

            {/* histórico */}
            <div style={{ flex: "2 1 420px", minWidth: 300, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}><b style={{ fontSize: 13 }}>Histórico de mudanças</b><span style={sub}>resultado = receita dos 7 dias antes → 7 dias depois{x.rateado ? " (venda do SKU dividida entre os anúncios)" : ""}</span></div>
              {det.mudancas.length === 0 && <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>Nenhuma mudança registrada nos últimos 90 dias.</span>}
              <div style={{ display: "flex", flexDirection: "column", maxHeight: 320, overflowY: "auto" }}>
                {det.mudancas.map((m, i) => (
                  <div key={`${m.quando}-${m.campo}-${i}`} style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr) 170px", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--pm-b)" }}>
                    <span className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>{quandoTxt(m.quando)}</span>
                    <span style={{ fontSize: 12.5 }}>
                      <b style={{ color: m.ok ? "var(--pm-t)" : "var(--pm-r)" }}>{rotuloMudanca(m)}</b>{" "}
                      <span style={{ fontSize: 11, color: ORIGEM[m.origem]?.cor, fontWeight: m.origem === "teste" ? 600 : 400 }}>· {ORIGEM[m.origem]?.nome ?? m.origem}{m.braco ? ` ${m.braco}` : ""}{m.quem && m.origem !== "fora" ? ` · ${m.quem}` : ""}</span>
                      {m.campo === "titulo" && m.para && <span style={{ display: "block", fontSize: 11.5, color: "var(--pm-t2)" }}>{m.para}</span>}
                    </span>
                    <Efeito m={m} />
                  </div>
                ))}
              </div>
            </div>

            {/* teste e ações */}
            <div style={{ flex: "1 1 280px", minWidth: 250, display: "flex", flexDirection: "column", gap: 10 }}>
              {marcacoes.map((m) => <BlocoOQueFazer key={m.id} m={m} compacto />)}
              {(det.teste ?? []).map((tt) => (
                <div key={tt.braco} style={{ fontSize: 12, background: "var(--pm-s2)", borderRadius: 9, padding: "8px 10px", color: "var(--pm-t2)" }}>
                  <b style={{ color: "var(--pm-t)" }}>Regra de parada · {tt.braco}</b>
                  {tt.regra && <span style={{ display: "block" }}>{tt.regra}</span>}
                  <span style={{ display: "block", color: "var(--pm-t)" }}>
                    Desde {ddmm(tt.desde)}: <b>{int(num(tt.cliques))} cliques</b> · ROAS do ADS <b>{tt.roas != null ? dec1(tt.roas) : "—"}</b>
                    {num(tt.dias) === 0 ? " (o 1º dia fecha amanhã)" : ` (${tt.dias} dia${num(tt.dias) === 1 ? "" : "s"} fechado${num(tt.dias) === 1 ? "" : "s"})`}
                  </span>
                </div>
              ))}
              {det.campanhas.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--pm-t2)" }}>
                  <b style={{ color: "var(--pm-t)" }}>Campanhas de ADS</b>
                  {det.campanhas.slice(0, 4).map((c) => (
                    <span key={c.campaign_id} style={{ display: "block" }}>
                      <span className={MONO}>{c.campaign_id}</span> · {c.status === "ongoing" ? "rodando" : c.status === "paused" ? "pausada" : c.status ?? "—"}{c.roas_target != null ? ` · meta ${dec1(c.roas_target)}` : ""}{num(c.budget) > 0 ? ` · ${formatBRL(num(c.budget))}/dia` : ""}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {x.sku_editar ? (
                  <Link to="/ia/gerar" search={{ sku: x.sku_editar, canal: CANAL_IA[x.mkt] ?? "shopee", empresa: x.empresa === "svl" ? "svl" : "ottz", ...(x.mkt === "shopee" || x.mkt === "ml" ? { item: x.item_id } : {}) }} style={btnPri}
                    title="Abrir o anúncio no app para trocar título, descrição, fotos e preço">Editar anúncio</Link>
                ) : <span style={{ ...sub, alignSelf: "center" }}>produto sem cadastro ativo: edição pelo app indisponível</span>}
                {x.campaign_id && <button type="button" style={btnSec} onClick={onAnalise}>Análise de ADS</button>}
                {x.link && <a href={x.link} target="_blank" rel="noreferrer" style={btnSec}><ExternalLink className="h-3.5 w-3.5" />Ver {x.mkt === "shopee" || x.mkt === "amazon" ? "na" : "no"} {nomeMkt}</a>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── Mudanças
const FILTROS: { id: string; nome: string; chave: string; dica?: string }[] = [
  { id: "", nome: "Tudo", chave: "tudo" }, { id: "app", nome: "Feito pelo app", chave: "app" }, { id: "teste", nome: "Teste A/B", chave: "teste" },
  { id: "fora", nome: "Feito fora do app", chave: "fora" },
  { id: "medidas", nome: "Mudanças medidas", chave: "medidas", dica: "Só as mudanças que já têm os 7 dias fechados depois delas — resultado completo, sem as que ainda estão medindo" },
  { id: "piorou", nome: "Piorou depois da mudança", chave: "piorou" }, { id: "falhou", nome: "Falhou ou não conferiu", chave: "falhou" },
];
const GRADE_M = "104px minmax(240px,1.5fr) minmax(250px,1.7fr) 140px 190px 176px";

const txtVal = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Desfazer o braço do teste / tentar de novo o que falhou — as mesmas chamadas do bloco "O que fazer" (sempre com conferência antes). */
function AcoesTesteFeed({ braco, falhou, onFeito }: { braco: string; falhou: boolean; onFeito: () => void }) {
  const [ocupado, setOcupado] = useState(false);
  async function rodar() {
    setOcupado(true);
    try {
      if (falhou) {
        const pv = await chamarTesteAb("previa");
        const linhas = ((pv.linhas ?? []) as any[]).filter((l) => l.braco === braco);
        const texto = linhas.map((l) => `• ${l.campo}: ${txtVal(l.atual)} → ${txtVal(l.novo)}`).join("\n");
        if (!window.confirm(`Tentar de novo o braço ${braco} na Shopee?\n\nLido agora na Shopee:\n${texto || "(nada pendente pela API)"}\n\nSó vão as tarefas pela API ainda não feitas; cada uma vai uma vez e é conferida depois.`)) return;
        const r = await chamarTesteAb("aplicar", { bracos: [braco] });
        const ruins = ((r.resultados ?? []) as any[]).filter((x) => !x.ok || x.conferido === false);
        if (ruins.length) toast.error(`${braco}: ${ruins.length} alteração(ões) não conferiram — ${ruins.map((x) => `${x.acao}: ${x.erro ?? "valor não bateu"}`).join("; ")}`, { duration: 15000 });
        else toast.success(`${braco}: aplicado e conferido na Shopee.`);
      } else {
        const pv = await chamarTesteAb("reverter", { braco, confirmar: false });
        const plano = ((pv.plano ?? []) as any[]);
        if (!plano.length) { toast.info("Nada a desfazer neste braço."); return; }
        const texto = plano.map((p) => `• ${p.acao}: volta para ${txtVal(p.volta_para)}`).join("\n");
        if (!window.confirm(`Desfazer o braço ${braco} na Shopee?\n\n${texto}\n\n${pv.aviso ?? ""}`)) return;
        const r = await chamarTesteAb("reverter", { braco, confirmar: true });
        if (r.ok) toast.success(`${braco} desfeito na Shopee.`); else toast.error(`${braco}: parte não voltou — veja o histórico.`);
      }
    } catch (e) { toast.error((e as Error).message); }
    finally { setOcupado(false); onFeito(); }
  }
  return (
    <button type="button" disabled={ocupado} onClick={() => void rodar()} title={falhou ? "Envia de novo só o que não foi feito neste braço" : "Volta este braço do teste ao que era antes"}
      style={{ ...btnSec, height: 36, padding: "0 10px", opacity: ocupado ? 0.6 : 1, ...(falhou ? { borderColor: "var(--pm-r)", color: "var(--pm-r)" } : {}) }}>
      {ocupado ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{falhou ? "Tentar de novo" : "Desfazer"}
    </button>
  );
}

export function MudancasAnuncios({ busca, set }: { busca: BuscaVisao; set: (x: Partial<BuscaVisao>) => void }) {
  const { q, loja, f, campo, p, mk, per } = busca;
  const pagina = p ?? 1;
  const POR = 80;
  const diasM = per === "7" ? 7 : 30;
  const [digitado, setDigitado] = useState(q ?? "");
  // a busca também muda por fora (botão Abrir das Mudanças): acompanha, sem atropelar o que está sendo digitado
  const enviado = useRef(q ?? "");
  useEffect(() => { if ((q ?? "") !== enviado.current) { enviado.current = q ?? ""; setDigitado(q ?? ""); } }, [q]);
  useEffect(() => {
    const t = setTimeout(() => { if ((q ?? "") !== digitado.trim()) { enviado.current = digitado.trim(); set({ q: digitado.trim() || undefined }); } }, 350);
    return () => clearTimeout(t);
  }, [digitado]);
  const dadosQ = useQuery({
    queryKey: ["anuncios-mudancas", mk ?? "", diasM, loja ?? "", q ?? "", f ?? "", campo ?? "", pagina],
    placeholderData: (ant) => ant,
    staleTime: 2 * 60_000,
    queryFn: async (): Promise<Mudancas> => {
      const { data, error } = await supabaseExternal.rpc("anuncios_mudancas" as never, {
        p_dias: diasM, p_filtro: f ?? null, p_campo: campo ?? null, p_empresa: loja ?? null, p_busca: q ?? null, p_offset: (pagina - 1) * POR, p_limit: POR, p_mkt: mk ?? null,
      } as never);
      if (error) throw error;
      return data as unknown as Mudancas;
    },
  });
  const d = dadosQ.data;
  const paginas = Math.max(1, Math.ceil((d?.total ?? 0) / POR));
  // mudanças do mesmo anúncio, no mesmo minuto e da mesma origem viram uma linha só
  const grupos = useMemo(() => {
    const out: { chave: string; itens: LinhaMud[] }[] = [];
    for (const l of d?.linhas ?? []) {
      const chave = `${l.mkt}:${l.shop}:${l.item_id}:${l.quando.slice(0, 15)}:${l.origem}`;
      const ult = out[out.length - 1];
      if (ult && ult.chave === chave) ult.itens.push(l); else out.push({ chave, itens: [l] });
    }
    return out;
  }, [d]);

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 24px 96px", maxWidth: 1440, margin: "0 auto", color: "var(--pm-t)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "10px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.02em" }}>Anúncios</h1>
          <span style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>Tudo que mudou nos anúncios nos últimos {diasM} dias, feito pelo app ou fora dele, com o resultado de cada mudança</span>
        </div>
        <div style={{ flex: 1 }} />
        {dadosQ.isFetching && <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--pm-t2)" }} />}
        <SeletorVisao ver="mudancas" onVer={(v) => set({ ver: v === "noar" ? undefined : v, p: undefined, f: undefined, campo: undefined })} />
      </div>

      {dadosQ.isError && <div style={{ ...cartao, padding: 14, borderColor: "var(--pm-r)", color: "var(--pm-r)", fontSize: 13 }}>Não consegui ler as mudanças: {(dadosQ.error as Error).message}</div>}

      <div style={{ ...cartao, padding: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <SeletorMkt valor={mk} onMudar={(v) => set({ mk: v, p: undefined })} />
        <div style={{ flexBasis: "100%", height: 0 }} />
        {FILTROS.map((x) => {
          const on = (f ?? "") === x.id;
          const n = d?.contagem?.[x.chave];
          return <button key={x.id} type="button" title={x.dica} style={chip(on)} onClick={() => set({ f: x.id || undefined, p: undefined })}>{x.nome}{n != null && <span className={MONO} style={{ fontSize: 11, opacity: 0.9 }}>{int(n)}</span>}</button>;
        })}
        <div style={{ flex: 1 }} />
        <div style={{ ...campoCx, flex: "0 1 240px", minWidth: 180 }}>
          <Search className="h-4 w-4" />
          <input value={digitado} onChange={(e) => setDigitado(e.target.value)} placeholder="nome, SKU ou ID do anúncio"
            style={{ border: 0, outline: "none", background: "transparent", flex: 1, minWidth: 0, fontSize: 13, color: "var(--pm-t)" }} />
        </div>
        <label style={campoCx}>O que mudou
          <select style={selectCx} value={campo ?? ""} onChange={(e) => set({ campo: e.target.value || undefined, p: undefined })}>
            <option value="">Qualquer coisa</option><option value="preco">Preço</option><option value="conteudo">Título, texto e fotos</option>
            <option value="ads">ADS (meta, orçamento, pausa)</option><option value="promocao">Promoção e situação</option>
          </select>
        </label>
        <label style={campoCx}>Loja
          <select style={selectCx} value={loja ?? ""} onChange={(e) => set({ loja: e.target.value || undefined, p: undefined })}>
            <option value="">Todas</option><option value="ottz">Ottz / ACZ</option><option value="svl">Bumi / SVL</option>
          </select>
        </label>
        <label style={campoCx}>Período
          <select style={selectCx} value={per === "7" ? "7" : "30"} onChange={(e) => set({ per: e.target.value === "7" ? "7" : undefined, p: undefined })}>
            <option value="30">Últimos 30 dias</option><option value="7">Últimos 7 dias</option>
          </select>
        </label>
      </div>

      <div style={{ ...cartao, overflowX: "auto" }}>
        <div style={{ minWidth: 1160 }}>
          <div style={{ display: "grid", gridTemplateColumns: GRADE_M, gap: 14, padding: "9px 14px", background: "var(--pm-s2)", borderRadius: "14px 14px 0 0", ...cab }}>
            <span>Quando</span><span>Anúncio</span><span>O que mudou</span><span>Quem</span><span>Resultado em 7 dias</span><span />
          </div>
          {dadosQ.isLoading && <div style={{ padding: 28, textAlign: "center", color: "var(--pm-t2)" }}><Loader2 className="h-4 w-4 animate-spin inline-block" /> Carregando as mudanças…</div>}
          {d && grupos.length === 0 && <div style={{ padding: 28, textAlign: "center", color: "var(--pm-t2)", fontSize: 13 }}>{f === "medidas" && diasM <= 7 ? "Nenhuma mudança deste período completou os 7 dias de medição. Troque o período para Últimos 30 dias." : "Nenhuma mudança neste filtro."}</div>}
          {grupos.map((g) => {
            const l = g.itens[0];
            const falhou = g.itens.some((i) => !i.ok);
            const pior = g.itens.find((i) => i.piorou) ?? l;
            return (
              <div key={`${g.chave}-${l.campo}`} style={{ display: "grid", gridTemplateColumns: GRADE_M, gap: 14, alignItems: "center", padding: "11px 14px", borderTop: "1px solid var(--pm-b)", background: falhou ? "var(--pm-rs)" : "var(--pm-s)" }}>
                <span className={MONO} style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>{quandoTxt(l.quando)}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                  {l.foto && <img src={l.foto} alt="" loading="lazy" style={{ width: 36, height: 36, flex: "none", borderRadius: 8, objectFit: "cover", border: "1px solid var(--pm-bs)" }} />}
                  <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span title={l.nome ?? ""} style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.nome ?? `anúncio ${l.item_id}`}</span>
                    <span style={{ fontSize: 11.5, color: "var(--pm-t2)", display: "flex", alignItems: "center", gap: 5 }}><LogoMkt mkt={l.mkt} tam={13} />{l.loja} · {l.item_id}{l.braco ? ` · ${l.braco}` : ""}</span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  {g.itens.map((i, n) => <span key={n} style={{ fontSize: 12.5, color: i.ok ? "var(--pm-t)" : "var(--pm-r)", fontWeight: i.ok ? 500 : 600 }}>{rotuloMudanca(i)}</span>)}
                </div>
                <span style={{ fontSize: 12 }}>
                  <b style={{ color: ORIGEM[l.origem]?.cor }}>{l.origem === "teste" ? "Teste A/B" : l.origem === "app" ? "Pelo app" : "Fora do app"}</b><br />
                  <span style={{ color: falhou ? "var(--pm-r)" : "var(--pm-t2)", fontWeight: falhou ? 600 : 400 }}>{falhou ? "falhou" : l.origem === "fora" ? "visto na leitura diária" : l.quem ?? "sistema"}</span>
                </span>
                <Efeito m={falhou ? g.itens.find((i) => !i.ok)! : pior} />
                <span style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                  {l.origem === "teste" && l.braco && <AcoesTesteFeed braco={l.braco} falhou={falhou} onFeito={() => void dadosQ.refetch()} />}
                  <button type="button" style={{ ...btnSec, height: 36, padding: "0 10px" }} onClick={() => set({ ver: undefined, q: l.item_id, mk: undefined, f: undefined, campo: undefined, p: undefined, per: undefined })}
                    title="Abrir este anúncio em Anúncios no ar">Abrir</button>
                </span>
              </div>
            );
          })}
          {d && d.total > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--pm-b)", fontSize: 12, color: "var(--pm-t2)" }}>
              <span>{int(d.total)} mudança{d.total === 1 ? "" : "s"} · página {pagina} de {paginas}</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" style={{ ...btnSec, height: 36, opacity: pagina <= 1 ? 0.5 : 1 }} disabled={pagina <= 1} onClick={() => set({ p: pagina - 1 > 1 ? pagina - 1 : undefined })}>Anterior</button>
                <button type="button" style={{ ...btnSec, height: 36, opacity: pagina >= paginas ? 0.5 : 1 }} disabled={pagina >= paginas} onClick={() => set({ p: pagina + 1 })}>Próxima</button>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
