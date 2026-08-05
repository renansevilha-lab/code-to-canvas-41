import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { resolveRange, type PeriodPreset } from "@/lib/dashboard/period";

// ---------------------------------------------------------------- tipos
interface SkuRow {
  sku: string; nome: string | null; marca: string | null; foto: string | null; canal: string | null;
  qtd_atual: number; qtd_anterior: number; valor_atual: number; valor_anterior: number;
}
interface MarcaRow {
  marca: string; qtd_atual: number; qtd_anterior: number;
  valor_atual: number; valor_anterior: number; skus: number;
}

// ---------------------------------------------------------------- design tokens (do handoff)
const ACCENT = "#6E56CF";
const PALETTE = ["#6E56CF", "#2E9E8F", "#E0A72E", "#4A7BD9", "#C9432F"];
const VERDE = "#0E8A5F";
const VERMELHO = "#C9432F";
const CANAL: Record<string, { nome: string; cor: string }> = {
  shopee: { nome: "Shopee", cor: "#6E56CF" },
  mercadolivre: { nome: "Mercado Livre", cor: "#E0A72E" },
  amazon: { nome: "Amazon", cor: "#2E9E8F" },
};
const canalMeta = (mk: string | null) => (mk && CANAL[mk]) || { nome: mk ?? "—", cor: "#8B93A1" };

// formatadores (iguais ao handoff)
const brl = (v: number) => "R$ " + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brlS = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return s + "R$ " + (a / 1e6).toFixed(2).replace(".", ",") + " mi";
  if (a >= 1000) return s + "R$ " + (a / 1000).toFixed(1).replace(".", ",") + " mil";
  return s + "R$ " + a.toFixed(0);
};
const pct1 = (v: number) => v.toFixed(1).replace(".", ",") + "%";
const sig = (v: number) => (v >= 0 ? "↑ " : "↓ ") + Math.abs(v).toFixed(1).replace(".", ",") + "%";
const nf = (v: number) => Math.round(v).toLocaleString("pt-BR");
const growth = (a: number, b: number) => (a ? (b - a) / a : 0);
const iniciais = (m: string) => m.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
const MONO = "'JetBrains Mono', monospace";

// ---------------------------------------------------------------- rota / URL
const VALID_PRESETS: PeriodPreset[] = ["today", "yesterday", "last7", "last30", "mtd", "prev_month", "last90", "custom"];
type View = "sku" | "marca";
type SortKey = "receita" | "unidades" | "crescimento";
const SORTS: SortKey[] = ["receita", "unidades", "crescimento"];
const PERIOD_OPTS: { v: PeriodPreset; l: string }[] = [
  { v: "today", l: "Hoje" }, { v: "yesterday", l: "Ontem" },
  { v: "last7", l: "Últimos 7 dias" }, { v: "last30", l: "Últimos 30 dias" },
  { v: "mtd", l: "Mês atual" }, { v: "prev_month", l: "Mês anterior" },
];
const CANAL_OPTS = [
  { v: "", l: "Todos os canais" }, { v: "shopee", l: "Shopee" },
  { v: "mercadolivre", l: "Mercado Livre" }, { v: "amazon", l: "Amazon" },
];
const SORT_OPTS: { v: SortKey; l: string }[] = [
  { v: "receita", l: "Maior receita" }, { v: "unidades", l: "Mais unidades" }, { v: "crescimento", l: "Maior crescimento" },
];

type SearchP = {
  period: PeriodPreset; from?: string; to?: string;
  view: View; mk?: string; marca?: string; q?: string; sort: SortKey;
};

export const Route = createFileRoute("/vendas")({
  validateSearch: (s: Record<string, unknown>): SearchP => ({
    period: VALID_PRESETS.includes(s.period as PeriodPreset) ? (s.period as PeriodPreset) : "mtd",
    from: typeof s.from === "string" ? s.from : undefined,
    to: typeof s.to === "string" ? s.to : undefined,
    view: s.view === "marca" ? "marca" : "sku",
    mk: typeof s.mk === "string" && s.mk ? s.mk : undefined,
    marca: typeof s.marca === "string" && s.marca ? s.marca : undefined,
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    sort: SORTS.includes(s.sort as SortKey) ? (s.sort as SortKey) : "receita",
  }),
  component: VendasPage,
});

// estilos reutilizados
const selStyle: CSSProperties = {
  border: "1px solid #E6E8EC", background: "#fff", color: "#4B5462", fontFamily: "inherit",
  fontSize: "12.5px", fontWeight: 500, padding: "8px 12px", borderRadius: "9px", cursor: "pointer",
};
const thStyle: CSSProperties = {
  fontSize: "11px", fontWeight: 600, letterSpacing: ".04em", textTransform: "uppercase",
  color: "#8B93A1", padding: "13px 8px",
};

function VendasPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.period, search.from, search.to);
  const patch = (p: Partial<SearchP>) => navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });

  const skuQ = useQuery({
    queryKey: ["vendas", "sku", range.from, range.to, search.mk ?? ""],
    queryFn: async (): Promise<SkuRow[]> => {
      const { data, error } = await supabaseExternal.rpc("vendas_por_sku", {
        data_inicial: range.from, data_final: range.to, p_marketplace: search.mk ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as SkuRow[];
    },
    staleTime: 5 * 60 * 1000,
  });
  const marcaQ = useQuery({
    queryKey: ["vendas", "marca", range.from, range.to, search.mk ?? ""],
    queryFn: async (): Promise<MarcaRow[]> => {
      const { data, error } = await supabaseExternal.rpc("vendas_por_marca", {
        data_inicial: range.from, data_final: range.to, p_marketplace: search.mk ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as MarcaRow[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const allSku = skuQ.data ?? [];
  const allMarca = marcaQ.data ?? [];

  // cor por marca: ranking por receita → paleta cíclica (igual handoff)
  const marcaCor = useMemo(() => {
    const m: Record<string, string> = {};
    [...allMarca].sort((a, b) => b.valor_atual - a.valor_atual).forEach((x, i) => { m[x.marca] = PALETTE[i % PALETTE.length]; });
    return m;
  }, [allMarca]);
  const corMarca = (mca: string | null) => (mca && marcaCor[mca]) || "#8B93A1";

  const marcasOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allSku) if (r.marca) set.add(r.marca);
    return Array.from(set).sort();
  }, [allSku]);

  const isSku = search.view === "sku";
  const baseAll = isSku ? allSku : allMarca;
  const totalReceita = baseAll.reduce((s, r) => s + Number(r.valor_atual ?? 0), 0) || 1;
  const totalUnid = baseAll.reduce((s, r) => s + Number(r.qtd_atual ?? 0), 0);
  const totalCount = baseAll.length;

  const sortFn = <T extends { valor_atual: number; qtd_atual: number; qtd_anterior: number }>(a: T, b: T) => {
    if (search.sort === "unidades") return b.qtd_atual - a.qtd_atual;
    if (search.sort === "crescimento") return growth(b.qtd_anterior, b.qtd_atual) - growth(a.qtd_anterior, a.qtd_atual);
    return b.valor_atual - a.valor_atual;
  };

  const skuRows = useMemo(() => {
    let r = allSku;
    if (search.marca) r = r.filter((x) => x.marca === search.marca);
    if (search.q) {
      const t = search.q.toLowerCase();
      r = r.filter((x) => (x.nome ?? "").toLowerCase().includes(t) || x.sku.toLowerCase().includes(t));
    }
    return [...r].sort(sortFn);
  }, [allSku, search.marca, search.q, search.sort]);

  const marcaRows = useMemo(() => {
    let r = allMarca;
    if (search.q) {
      const t = search.q.toLowerCase();
      r = r.filter((x) => x.marca.toLowerCase().includes(t));
    }
    return [...r].sort(sortFn);
  }, [allMarca, search.q, search.sort]);

  const maxParticSku = Math.max(1e-6, ...allSku.map((r) => r.valor_atual / totalReceita * 100));
  const maxParticMarca = Math.max(1e-6, ...allMarca.map((r) => r.valor_atual / totalReceita * 100));

  const loading = isSku ? skuQ.isLoading : marcaQ.isLoading;
  const empty = !loading && (isSku ? skuRows.length : marcaRows.length) === 0;
  const erro = skuQ.error || marcaQ.error;

  const kpis = [
    { label: "Receita no período", value: brlS(totalReceita), color: ACCENT },
    { label: "Unidades vendidas", value: nf(totalUnid), color: "#0F1216" },
    { label: isSku ? "SKUs vendidos" : "Marcas ativas", value: nf(totalCount), color: "#0F1216" },
    { label: "Receita média / unidade", value: totalUnid > 0 ? brl(totalReceita / totalUnid) : "—", color: "#0F1216" },
  ];

  const periodOptions = search.period === "custom"
    ? [{ v: "custom" as PeriodPreset, l: "Personalizado" }, ...PERIOD_OPTS]
    : PERIOD_OPTS;

  const btnSeg = (active: boolean): CSSProperties => ({
    border: 0, cursor: "pointer", fontFamily: "inherit", fontSize: "12.5px", fontWeight: 600,
    padding: "8px 16px", borderRadius: "7px", whiteSpace: "nowrap",
    background: active ? "#0E1114" : "transparent", color: active ? "#fff" : "#6C7481",
  });
  const btnChip = (active: boolean): CSSProperties => ({
    border: `1px solid ${active ? "#0E1114" : "#E6E8EC"}`, background: active ? "#0E1114" : "#fff",
    color: active ? "#fff" : "#4B5462", fontFamily: "inherit", fontSize: "12.5px", fontWeight: 500,
    padding: "8px 14px", borderRadius: "9px", cursor: "pointer", whiteSpace: "nowrap",
  });

  return (
    <div className="w-full px-6 md:px-8 py-6" style={{ color: "#0F1216" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* voltar + título curto (o shell já mostra o breadcrumb) */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Link to="/" style={{ color: "#8B93A1", display: "inline-flex" }} title="Voltar ao Dashboard">
            <ArrowLeft size={16} />
          </Link>
          <span style={{ fontSize: "13px", color: "#8B93A1" }}>
            Unidades e receita por produto, com kits destrinchados · atual vs. período anterior.
          </span>
        </div>

        {/* filtros */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "2px", background: "#fff", border: "1px solid #E6E8EC", borderRadius: "10px", padding: "3px" }}>
            {(["sku", "marca"] as View[]).map((v) => (
              <button key={v} onClick={() => patch({ view: v })} style={btnSeg(search.view === v)}>
                {v === "sku" ? "Por SKU" : "Por marca"}
              </button>
            ))}
          </div>
          <div style={{ width: "1px", height: "22px", background: "#E1E4E9", margin: "0 2px" }} />
          {CANAL_OPTS.map((c) => (
            <button key={c.v} onClick={() => patch({ mk: c.v || undefined })} style={btnChip((search.mk ?? "") === c.v)}>
              {c.l}
            </button>
          ))}
          {isSku && (
            <select value={search.marca ?? ""} onChange={(e) => patch({ marca: e.target.value || undefined })} style={selStyle}>
              <option value="">Todas as marcas</option>
              {marcasOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <select value={search.sort} onChange={(e) => patch({ sort: e.target.value as SortKey })} style={selStyle}>
            {SORT_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <select
            value={search.period}
            onChange={(e) => patch({ period: e.target.value as PeriodPreset, from: undefined, to: undefined })}
            style={selStyle}
          >
            {periodOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          <div style={{ flex: "0 1 260px", minWidth: "180px", display: "flex", alignItems: "center", gap: "7px", background: "#fff", border: "1px solid #E6E8EC", borderRadius: "9px", padding: "8px 12px" }}>
            <span style={{ color: "#A6ADBA", fontSize: "13px" }}>⌕</span>
            <input
              value={search.q ?? ""}
              onChange={(e) => patch({ q: e.target.value || undefined })}
              placeholder={isSku ? "Buscar produto ou SKU…" : "Buscar marca…"}
              style={{ border: 0, outline: 0, fontFamily: "inherit", fontSize: "12.5px", color: "#0F1216", flex: 1, minWidth: 0, background: "transparent" }}
            />
          </div>
        </div>

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "14px" }}>
          {kpis.map((k) => (
            <div key={k.label} style={{ background: "#fff", border: "1px solid #E6E8EC", borderRadius: "14px", padding: "18px 20px 16px", display: "flex", flexDirection: "column", gap: "10px", boxShadow: "0 1px 2px rgba(16,20,26,.04)", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "3px", background: k.color }} />
              <span style={{ fontSize: "12px", fontWeight: 600, color: "#6C7481" }}>{k.label}</span>
              <span style={{ fontSize: "27px", fontWeight: 600, letterSpacing: "-.03em", color: "#0F1216", fontVariantNumeric: "tabular-nums", lineHeight: 1, fontFamily: MONO }}>
                {loading ? "—" : k.value}
              </span>
            </div>
          ))}
        </div>

        {erro && (
          <div style={{ background: "#FBEDEA", border: "1px solid #F3D4CD", borderRadius: "12px", padding: "14px 16px", fontSize: "13px", color: VERMELHO }}>
            Erro ao carregar: {(erro as Error).message}
          </div>
        )}

        {loading ? (
          <div style={{ background: "#fff", border: "1px solid #E6E8EC", borderRadius: "14px", padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} style={{ height: "40px", borderRadius: "8px", background: "#F1F2F5", opacity: 1 - i * 0.06 }} />
            ))}
          </div>
        ) : empty ? (
          <div style={{ background: "#fff", border: "1px solid #E6E8EC", borderRadius: "14px", padding: "56px 40px", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", textAlign: "center" }}>
            <div style={{ width: "44px", height: "44px", borderRadius: "12px", background: "#F4F5F7", display: "flex", alignItems: "center", justifyContent: "center", color: "#9BA2AE", fontSize: "18px" }}>⌕</div>
            <div style={{ fontSize: "15px", fontWeight: 600 }}>Nenhum resultado encontrado</div>
            <div style={{ fontSize: "13px", color: "#8B93A1", maxWidth: "360px", lineHeight: 1.5 }}>Ajuste os filtros de canal, marca ou período, ou refine sua busca.</div>
          </div>
        ) : (
          <>
            <span style={{ fontSize: "12px", color: "#8B93A1" }}>
              Mostrando {isSku ? skuRows.length : marcaRows.length} de {totalCount} {isSku ? "SKUs" : "marcas"} do período
            </span>
            {isSku
              ? <SkuTable rows={skuRows} totalReceita={totalReceita} maxPartic={maxParticSku} corMarca={corMarca} />
              : <MarcaTable rows={marcaRows} totalReceita={totalReceita} maxPartic={maxParticMarca} corMarca={corMarca} />}
          </>
        )}

        <p style={{ fontSize: "12px", color: "#8B93A1", lineHeight: 1.6 }}>
          Kits destrinchados nos componentes; a receita do kit é rateada pelo peso de CMV de cada componente (a soma bate o
          total do período). "% da receita" = participação de cada {isSku ? "SKU" : "marca"} na receita total do período.
          Escopo: pedidos válidos de Shopee + Mercado Livre + Amazon.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tabela SKU
const SKU_COLS = "52px minmax(230px,1.3fr) 130px 108px 128px 96px 118px 176px";
function SkuTable({ rows, totalReceita, maxPartic, corMarca }: {
  rows: SkuRow[]; totalReceita: number; maxPartic: number; corMarca: (m: string | null) => string;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E6E8EC", borderRadius: "14px", boxShadow: "0 1px 2px rgba(16,20,26,.04)", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: SKU_COLS, padding: "0 20px", borderBottom: "1px solid #EDEFF3", background: "#FAFBFC" }}>
        <span />
        <span style={thStyle}>Produto</span>
        <span style={thStyle}>Marca</span>
        <span style={thStyle}>Canal</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Un. ant → atual</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Var.</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Receita</span>
        <span style={thStyle}>% da receita</span>
      </div>
      {rows.map((r) => {
        const cor = corMarca(r.marca);
        const varPct = growth(Number(r.qtd_anterior ?? 0), Number(r.qtd_atual ?? 0)) * 100;
        const partic = Number(r.valor_atual ?? 0) / totalReceita * 100;
        const cm = canalMeta(r.canal);
        return (
          <div key={r.sku} style={{ display: "grid", gridTemplateColumns: SKU_COLS, alignItems: "center", padding: "0 20px", borderBottom: "1px solid #F2F3F6" }}>
            <div style={{ padding: "10px 8px 10px 0" }}>
              {r.foto ? (
                <img src={r.foto} alt="" loading="lazy" style={{ width: "36px", height: "36px", borderRadius: "9px", objectFit: "cover", border: "1px solid #EDEFF3", display: "block" }} />
              ) : (
                <div style={{ width: "36px", height: "36px", borderRadius: "9px", background: cor + "20", display: "flex", alignItems: "center", justifyContent: "center", color: cor, fontSize: "12px", fontWeight: 700 }}>
                  {iniciais(r.marca ?? r.sku)}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "10px 8px", minWidth: 0 }}>
              <span style={{ fontSize: "13px", fontWeight: 500, color: "#0F1216", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.nome ?? r.sku}>{r.nome ?? r.sku}</span>
              <span style={{ fontSize: "11px", color: "#9BA2AE", fontFamily: MONO }}>{r.sku}</span>
            </div>
            <div style={{ padding: "10px 8px", display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
              <span style={{ width: "7px", height: "7px", borderRadius: "50%", flex: "0 0 7px", background: cor }} />
              <span style={{ fontSize: "12px", color: "#4B5462", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.marca}</span>
            </div>
            <div style={{ padding: "10px 8px" }}>
              <span style={{ fontSize: "11.5px", fontWeight: 500, padding: "4px 9px", borderRadius: "6px", background: cm.cor + "18", color: cm.cor }}>{cm.nome}</span>
            </div>
            <div style={{ padding: "10px 8px", textAlign: "right", fontSize: "12.5px", color: "#6C7481", fontFamily: MONO, whiteSpace: "nowrap" }}>
              {nf(Number(r.qtd_anterior ?? 0))} → {nf(Number(r.qtd_atual ?? 0))}
            </div>
            <div style={{ padding: "10px 8px", textAlign: "right", fontSize: "12.5px", fontWeight: 600, color: varPct >= 0 ? VERDE : VERMELHO, fontFamily: MONO }}>{sig(varPct)}</div>
            <div style={{ padding: "10px 8px", textAlign: "right", fontSize: "13px", fontWeight: 600, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>{brl(Number(r.valor_atual ?? 0))}</div>
            <div style={{ padding: "10px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "#F1F2F5", overflow: "hidden", minWidth: "40px" }}>
                <div style={{ height: "100%", borderRadius: "3px", width: Math.max(3, partic / maxPartic * 100).toFixed(1) + "%", background: cor }} />
              </div>
              <span style={{ fontSize: "12px", fontWeight: 600, fontFamily: MONO, color: "#0F1216", whiteSpace: "nowrap", width: "40px", textAlign: "right" }}>{pct1(partic)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- tabela Marca
const MARCA_COLS = "minmax(220px,1.6fr) 108px 150px 96px 128px 200px";
function MarcaTable({ rows, totalReceita, maxPartic, corMarca }: {
  rows: MarcaRow[]; totalReceita: number; maxPartic: number; corMarca: (m: string | null) => string;
}) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E6E8EC", borderRadius: "14px", boxShadow: "0 1px 2px rgba(16,20,26,.04)", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: MARCA_COLS, padding: "0 20px", borderBottom: "1px solid #EDEFF3", background: "#FAFBFC" }}>
        <span style={thStyle}>Marca</span>
        <span style={thStyle}>SKUs</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Un. ant → atual</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Var.</span>
        <span style={{ ...thStyle, textAlign: "right" }}>Receita</span>
        <span style={thStyle}>% da receita</span>
      </div>
      {rows.map((r) => {
        const cor = corMarca(r.marca);
        const varPct = growth(Number(r.qtd_anterior ?? 0), Number(r.qtd_atual ?? 0)) * 100;
        const partic = Number(r.valor_atual ?? 0) / totalReceita * 100;
        return (
          <div key={r.marca} style={{ display: "grid", gridTemplateColumns: MARCA_COLS, alignItems: "center", padding: "0 20px", borderBottom: "1px solid #F2F3F6" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 8px" }}>
              <span style={{ width: "9px", height: "9px", borderRadius: "50%", flex: "0 0 9px", background: cor }} />
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#0F1216" }}>{r.marca}</span>
            </div>
            <span style={{ padding: "12px 8px", fontSize: "12.5px", color: "#6C7481", fontFamily: MONO }}>{nf(Number(r.skus ?? 0))}</span>
            <div style={{ padding: "12px 8px", textAlign: "right", fontSize: "12.5px", color: "#6C7481", fontFamily: MONO, whiteSpace: "nowrap" }}>
              {nf(Number(r.qtd_anterior ?? 0))} → {nf(Number(r.qtd_atual ?? 0))}
            </div>
            <div style={{ padding: "12px 8px", textAlign: "right", fontSize: "12.5px", fontWeight: 600, color: varPct >= 0 ? VERDE : VERMELHO, fontFamily: MONO }}>{sig(varPct)}</div>
            <div style={{ padding: "12px 8px", textAlign: "right", fontSize: "13.5px", fontWeight: 600, fontVariantNumeric: "tabular-nums", fontFamily: MONO }}>{brlS(Number(r.valor_atual ?? 0))}</div>
            <div style={{ padding: "12px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "#F1F2F5", overflow: "hidden", minWidth: "50px" }}>
                <div style={{ height: "100%", borderRadius: "3px", width: Math.max(3, partic / maxPartic * 100).toFixed(1) + "%", background: cor }} />
              </div>
              <span style={{ fontSize: "12.5px", fontWeight: 600, fontFamily: MONO, color: "#0F1216", whiteSpace: "nowrap", width: "44px", textAlign: "right" }}>{pct1(partic)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
