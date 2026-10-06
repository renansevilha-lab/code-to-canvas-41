import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Calculator, CheckCircle2, Loader2, Package as PackageIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatBRL, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Formação de custo da compra (dono, 02/out/2026): custo unitário = (valor da
// NF do SKU + rateio de frete/IPI/ST/outras − desconto) / unidades. Usa o preço
// DESTA nota (não média com o estoque). "Gravar no Tiny" atualiza o preço de
// custo do cadastro (o app copia de lá às 05:00) e já atualiza o custo do app.
// 06/out: o preço vem da NF APLICADA (valor da linha − desconto do item) quando
// houver; o cabeçalho da NF (frete, IPI, ST, desconto) pré-preenche os extras; e
// o custo pode ser digitado à mão por produto (substitui o calculado).
// O cálculo é da edge fn compras-estoque (custo-preview / custo-aplicar) — o
// front só mostra. Kits e variações ficam de fora.
// ============================================================================

type Rateio = "valor" | "quantidade";
interface Extras { frete: number; ipi: number; st: number; outras: number; desconto: number; rateio: Rateio }
interface Linha {
  sku: string; nome: string | null; foto: string | null; unidades: number; valor_nf: number; preco_nf_unit: number;
  rateio_total: number; rateio_unit: number; ajuste_unit: number; ajuste_motivo: string | null; custo_final: number; custo_atual: number | null; variacao_pct: number | null;
  origem_preco?: "nf" | "oc" | "misto"; nfs?: string[]; desconto_item?: number; desconto_item_unit?: number;
  custo_calculado?: number; manual?: boolean; manual_motivo?: string | null;
}
interface CabecalhoNf {
  nf_numero: string; origem: "xml" | "tiny"; frete: number; ipi: number; st: number; outras: number;
  desconto_total: number; desconto_itens: number; desconto_extra: number; lido: boolean; erro_leitura: string | null;
}
interface Aplicado { custo_final: number; custo_anterior: number | null; tiny_ok: boolean | null; tiny_erro: string | null; aplicado_em: string; aplicado_por: string | null }
interface Preview {
  extras: Extras; ajustes: Record<string, { valor_un: number; motivo: string | null }>; frete_nf: number; linhas: Linha[]; avisos: Array<{ sku: string | null; motivo: string }>;
  extras_total: number; total_nf: number; total_com_extras: number; aplicados: Record<string, Aplicado>;
  manuais?: Record<string, { custo: number; motivo: string | null }>;
  cabecalho_nf?: CabecalhoNf[]; extras_da_nf?: Omit<Extras, "rateio">; nf_nao_aplicadas?: string[];
}

const CAMPOS: Array<{ k: keyof Omit<Extras, "rateio">; rot: string; dica: string }> = [
  { k: "frete", rot: "Frete", dica: "Frete pago por nós (CT-e ou destacado na NF)" },
  { k: "ipi", rot: "IPI", dica: "IPI não recuperável" },
  { k: "st", rot: "ICMS-ST", dica: "Substituição tributária / DIFAL pagos na entrada" },
  { k: "outras", rot: "Outras despesas", dica: "Seguro, descarga, taxa de boleto…" },
  { k: "desconto", rot: "Desconto", dica: "Desconto ou bonificação a abater do custo" },
];

async function chamar(qs: string): Promise<any> {
  const { data } = await supabaseExternal.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sessão expirada — entre de novo no app.");
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/compras-estoque?${qs}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: EXTERNAL_PUBLISHABLE_KEY },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.erro ?? `HTTP ${r.status}`);
  return j;
}

type AjTxt = Record<string, { v: string; m: string }>;
const qsExtras = (e: Extras, aj: AjTxt, man: AjTxt) => {
  // despesa manual por unidade por SKU (ex.: etiqueta) — o servidor soma depois do rateio
  const ajustes = Object.fromEntries(Object.entries(aj).filter(([, a]) => num(a.v) > 0).map(([sku, a]) => [sku, { valor_un: num(a.v), motivo: a.m.trim() || null }]));
  // custo digitado à mão — substitui o calculado
  const manuais = Object.fromEntries(Object.entries(man).filter(([, a]) => num(a.v) > 0).map(([sku, a]) => [sku, { custo: num(a.v), motivo: a.m.trim() || null }]));
  return CAMPOS.map(({ k }) => `${k}=${e[k] || 0}`).join("&") + `&rateio=${e.rateio}&ajustes=${encodeURIComponent(JSON.stringify(ajustes))}&manuais=${encodeURIComponent(JSON.stringify(manuais))}`;
};
const txtNum = (v: number) => (v ? String(v).replace(".", ",") : "");
const num = (s: string) => { const v = Number(s.replace(/\./g, "").replace(",", ".")); return Number.isFinite(v) && v >= 0 ? v : 0; };

function Foto({ url }: { url: string | null }) {
  const [erro, setErro] = useState(false);
  if (!url || erro) return <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0"><PackageIcon className="h-4 w-4 text-muted-foreground" /></div>;
  return <img src={url} alt="" loading="lazy" onError={() => setErro(true)} className="h-10 w-10 rounded-md object-cover border shrink-0" />;
}

export function FormacaoCusto({ ordemTinyId, numero }: { ordemTinyId: number; numero: string | null }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [aberto, setAberto] = useState(false);
  const [prev, setPrev] = useState<Preview | null>(null);
  const [ex, setEx] = useState<Extras | null>(null);
  const [txt, setTxt] = useState<Record<string, string>>({});
  const [aj, setAj] = useState<AjTxt>({});
  const [man, setMan] = useState<AjTxt>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [carregando, setCarregando] = useState(false);
  const [gravando, setGravando] = useState(false);

  async function carregar(e: Extras | null, a: AjTxt = aj, mn: AjTxt = man) {
    setCarregando(true);
    try {
      const p: Preview = await chamar(`modulo=custo-preview&ordem_tiny_id=${ordemTinyId}${e ? `&${qsExtras(e, a, mn)}` : ""}`);
      setPrev(p);
      if (!e) {
        setEx(p.extras);
        setTxt(Object.fromEntries(CAMPOS.map(({ k }) => [k, txtNum(p.extras[k])])));
        setAj(Object.fromEntries(Object.entries(p.ajustes ?? {}).map(([sku, a]) => [sku, { v: String(a.valor_un).replace(".", ","), m: a.motivo ?? "" }])));
        setMan(Object.fromEntries(Object.entries(p.manuais ?? {}).map(([sku, a]) => [sku, { v: String(a.custo).replace(".", ","), m: a.motivo ?? "" }])));
        // pré-seleciona o que ainda não foi gravado com este custo
        setSel(new Set(p.linhas.filter((l) => !(p.aplicados[l.sku]?.tiny_ok && Math.abs(p.aplicados[l.sku].custo_final - l.custo_final) < 0.005)).map((l) => l.sku)));
      }
    } catch (err) { toast.error("Falha na formação de custo", { description: (err as Error).message }); }
    finally { setCarregando(false); }
  }

  // recalcula (no servidor) 400 ms depois da última digitação
  useEffect(() => {
    if (!aberto || !ex) return;
    const t = setTimeout(() => { void carregar(ex, aj, man); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex, aj, man]);

  function abrir() { setAberto(true); setPrev(null); setEx(null); setAj({}); setMan({}); void carregar(null, {}, {}); }

  // Volta frete/IPI/ST/outras/desconto para os valores do cabeçalho da NF.
  function usarValoresDaNf() {
    const d = prev?.extras_da_nf;
    if (!d || !ex) return;
    setEx({ ...ex, ...d });
    setTxt(Object.fromEntries(CAMPOS.map(({ k }) => [k, txtNum(d[k])])));
  }

  const escolhidas = useMemo(() => (prev?.linhas ?? []).filter((l) => sel.has(l.sku)), [prev, sel]);

  async function gravar() {
    if (!ex || escolhidas.length === 0) return;
    if (!window.confirm(
      `Gravar o preço de custo no cadastro do Tiny (e no app)?\n\n` +
      escolhidas.map((l) => `${l.sku}: ${l.custo_atual != null ? formatBRL(l.custo_atual) : "—"} → ${formatBRL(l.custo_final)}${l.manual ? ` (MANUAL${l.manual_motivo ? `: ${l.manual_motivo}` : ""}; calculado ${formatBRL(l.custo_calculado ?? 0)})` : l.ajuste_unit ?` (inclui +${formatBRL(l.ajuste_unit)}/un${l.ajuste_motivo ? ` ${l.ajuste_motivo}` : ""})` : ""}`).join("\n") +
      `\n\nSó o custo muda; o app confere o cadastro depois de gravar.`,
    )) return;
    setGravando(true);
    try {
      let restantes = escolhidas.map((l) => l.sku);
      const falhas: string[] = []; let ok = 0;
      // a função grava ~10 por chamada (limite de 30 s); repete até acabar
      for (let volta = 0; volta < 10 && restantes.length; volta++) {
        const r = await chamar(`modulo=custo-aplicar&ordem_tiny_id=${ordemTinyId}&confirmar=1&${qsExtras(ex, aj, man)}&skus=${encodeURIComponent(restantes.join(","))}&aplicado_por=${encodeURIComponent(perfil?.nome ?? "app")}`);
        for (const x of (r.resultados ?? []) as Array<{ sku: string; ok: boolean; erro: string | null }>) { if (x.ok) ok++; else falhas.push(`${x.sku}: ${x.erro}`); }
        restantes = (r.pendentes ?? []) as string[];
      }
      if (falhas.length === 0) toast.success(`Custo gravado no Tiny — ${ok} SKU(s)`, { description: "O custo do app já foi atualizado." });
      else toast.warning(`${ok} gravado(s) · ${falhas.length} com problema`, { description: falhas.slice(0, 5).join("\n"), duration: 20000 });
      void qc.invalidateQueries({ queryKey: ["compras"] });
      await carregar(ex);
    } catch (err) { toast.error("Falha ao gravar o custo", { description: (err as Error).message }); }
    finally { setGravando(false); }
  }

  const todas = (prev?.linhas.length ?? 0) > 0 && escolhidas.length === prev!.linhas.length;
  // o aviso de NF vinculada e não aplicada já aparece no topo
  const avisosItens = (prev?.avisos ?? []).filter((a) => !(a.sku == null && a.motivo.includes("não aplicada")));

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={abrir} title="Custo unitário da compra (NF + frete/impostos) e gravação no cadastro do Tiny">
        <Calculator className="h-4 w-4" /> Formação de custo
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { if (!v && !gravando) setAberto(false); }}>
        <DialogContent className="max-w-[min(1180px,96vw)] w-full max-h-[92vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>Formação de custo — OC #{numero ?? ordemTinyId}</DialogTitle>
            <DialogDescription>
              Custo unitário = (valor do item na NF + parte dos custos extras) ÷ unidades. Vale o preço <b>desta nota</b>.
              Gravar atualiza o <b>preço de custo no cadastro do Tiny</b> e o custo do app na hora.
            </DialogDescription>
          </DialogHeader>

          {!prev || !ex ? (
            <div className="py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="flex flex-col gap-4">
              {(prev.nf_nao_aplicadas?.length ?? 0) > 0 && (
                <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
                  <span>
                    A NF <b>{prev.nf_nao_aplicadas!.join(", ")}</b> está vinculada mas <b>não foi aplicada à conferência</b>: os preços abaixo
                    são os da OC e o desconto/IPI da nota não entram. Feche, use "Aplicar à conferência" no quadro da NF e abra de novo.
                  </span>
                </div>
              )}
              {/* extras */}
              <div className="rounded-lg border p-3 flex flex-col gap-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  {CAMPOS.map(({ k, rot, dica }) => (
                    <label key={k} className="flex flex-col gap-1" title={dica}>
                      <span className="text-[11px] font-semibold text-muted-foreground">{rot} (R$){k === "desconto" ? " −" : " +"}</span>
                      <Input value={txt[k] ?? ""} inputMode="decimal" placeholder="0,00" className="h-9 font-mono text-sm"
                        onChange={(e) => { setTxt((t) => ({ ...t, [k]: e.target.value })); setEx((x) => (x ? { ...x, [k]: num(e.target.value) } : x)); }} />
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="text-muted-foreground font-semibold">Ratear por</span>
                  <div className="inline-flex rounded-lg border p-0.5">
                    {([["valor", "valor do item"], ["quantidade", "quantidade"]] as const).map(([r, rot]) => (
                      <button key={r} type="button" onClick={() => setEx((x) => (x ? { ...x, rateio: r } : x))}
                        className={cn("px-3 py-1 rounded-md font-semibold", ex.rateio === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>{rot}</button>
                    ))}
                  </div>
                  <span className="text-muted-foreground">Frete destacado na NF: <b className="text-foreground">{formatBRL(prev.frete_nf)}</b></span>
                  {carregando && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  <span className="ml-auto tabular-nums">
                    NF {formatBRL(prev.total_nf)} {prev.extras_total >= 0 ? "+" : "−"} extras {formatBRL(Math.abs(prev.extras_total))} = <b>{formatBRL(prev.total_com_extras)}</b>
                  </span>
                </div>
                {(prev.cabecalho_nf?.length ?? 0) > 0 && (() => {
                  const d = prev.extras_da_nf;
                  const difere = !!d && CAMPOS.some(({ k }) => Math.abs((d[k] ?? 0) - (ex[k] ?? 0)) > 0.004);
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                      {prev.cabecalho_nf!.map((c) => (
                        <span key={c.nf_numero} className="tabular-nums">
                          <b className="text-foreground">NF {c.nf_numero}</b>{c.origem === "tiny" ? " (Tiny)" : " (XML)"}:
                          {c.erro_leitura ? <span className="text-red-700 dark:text-red-400"> cabeçalho não lido ({c.erro_leitura})</span> : <>
                            {c.desconto_total > 0 && <> desconto {formatBRL(c.desconto_total)}{c.desconto_itens > 0 ? ` (${formatBRL(c.desconto_itens)} já nos itens)` : " (rateado — o Tiny não diz de qual item)"}</>}
                            {c.ipi > 0 && <> · IPI {formatBRL(c.ipi)}</>}
                            {c.st > 0 && <> · ST {formatBRL(c.st)}</>}
                            {c.frete > 0 && <> · frete {formatBRL(c.frete)}</>}
                            {c.outras > 0 && <> · outras {formatBRL(c.outras)}</>}
                            {!c.desconto_total && !c.ipi && !c.st && !c.frete && !c.outras && <> sem desconto, IPI ou frete</>}
                          </>}
                        </span>
                      ))}
                      {difere && (
                        <button type="button" onClick={usarValoresDaNf} className="ml-auto font-semibold text-primary hover:underline">
                          usar os valores da NF nos campos acima
                        </button>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* itens */}
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-[10px] uppercase text-muted-foreground">
                    <tr>
                      <th className="px-2 py-2 w-8"><Checkbox checked={todas} onCheckedChange={(v) => setSel(new Set(v === true ? prev.linhas.map((l) => l.sku) : []))} /></th>
                      <th className="px-2 py-2 text-left font-medium">Produto</th>
                      <th className="px-2 py-2 text-right font-medium">Unidades</th>
                      <th className="px-2 py-2 text-right font-medium">Preço NF un.</th>
                      <th className="px-2 py-2 text-right font-medium">+ Extras un.</th>
                      <th className="px-2 py-2 text-left font-medium" title="Despesa manual por unidade (etiqueta, embalagem, mão de obra…)">+ Despesa un.</th>
                      <th className="px-2 py-2 text-left font-medium" title="Digite para usar este custo no lugar do calculado">Custo manual</th>
                      <th className="px-2 py-2 text-right font-medium">= Custo novo</th>
                      <th className="px-2 py-2 text-right font-medium">Custo atual</th>
                      <th className="px-2 py-2 text-right font-medium">Variação</th>
                      <th className="px-2 py-2 text-left font-medium">Tiny</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {prev.linhas.length === 0 ? (
                      <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">Nenhum item com preço nesta OC.</td></tr>
                    ) : prev.linhas.map((l) => {
                      const ap = prev.aplicados[l.sku];
                      const igual = l.custo_atual != null && Math.abs(l.custo_atual - l.custo_final) < 0.005;
                      return (
                        <tr key={l.sku} className={cn(!sel.has(l.sku) && "opacity-60")}>
                          <td className="px-2 py-2"><Checkbox checked={sel.has(l.sku)} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); if (v === true) n.add(l.sku); else n.delete(l.sku); return n; })} /></td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2.5 min-w-[260px]">
                              <Foto url={l.foto} />
                              <div className="min-w-0">
                                <div className="text-[12.5px] font-medium leading-snug">{l.nome ?? "—"}</div>
                                <div className="font-mono text-[10.5px] text-muted-foreground">{l.sku}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">{formatNumber(l.unidades)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            <div className="font-mono">{formatBRL(l.preco_nf_unit)}</div>
                            {l.origem_preco === "oc" ? (
                              <div className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold" title="Sem NF aplicada para este item: preço da ordem de compra">preço da OC</div>
                            ) : (
                              <div className="text-[10px] text-muted-foreground" title={l.origem_preco === "misto" ? "Parte das unidades com preço da NF, parte com o da OC" : "Valor da NF aplicada, já sem o desconto do item"}>
                                {l.origem_preco === "misto" ? "NF + OC" : `NF ${(l.nfs ?? []).join(", ")}`}
                                {(l.desconto_item_unit ?? 0) > 0 && <span className="text-emerald-700 dark:text-emerald-400"> · desc. −{formatBRL(l.desconto_item_unit ?? 0)}</span>}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">{l.rateio_unit ? `${l.rateio_unit > 0 ? "+" : "−"}${formatBRL(Math.abs(l.rateio_unit))}` : "—"}</td>
                          <td className="px-2 py-2">
                            <div className="flex flex-col gap-1 w-[130px]">
                              <Input value={aj[l.sku]?.v ?? ""} inputMode="decimal" placeholder="0,00" className="h-7 font-mono text-xs text-right"
                                onChange={(e) => { const v = e.target.value; setAj((a) => ({ ...a, [l.sku]: { v, m: a[l.sku]?.m ?? "" } })); }} />
                              <Input value={aj[l.sku]?.m ?? ""} placeholder="motivo (ex.: etiqueta)" className="h-6 text-[10.5px]"
                                onChange={(e) => { const m = e.target.value; setAj((a) => ({ ...a, [l.sku]: { v: a[l.sku]?.v ?? "", m } })); }} />
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex flex-col gap-1 w-[130px]">
                              <Input value={man[l.sku]?.v ?? ""} inputMode="decimal" placeholder="calculado"
                                className={cn("h-7 font-mono text-xs text-right", (man[l.sku]?.v ?? "") !== "" && "border-primary")}
                                onChange={(e) => { const v = e.target.value; setMan((a) => ({ ...a, [l.sku]: { v, m: a[l.sku]?.m ?? "" } })); }} />
                              <Input value={man[l.sku]?.m ?? ""} placeholder="motivo (ex.: bonificação)" className="h-6 text-[10.5px]"
                                onChange={(e) => { const m = e.target.value; setMan((a) => ({ ...a, [l.sku]: { v: a[l.sku]?.v ?? "", m } })); }} />
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            <div className="font-mono font-bold text-[13px]">{formatBRL(l.custo_final)}</div>
                            {l.manual && (
                              <div className="text-[10px] text-primary font-semibold" title={l.manual_motivo ?? undefined}>
                                manual · calc. {formatBRL(l.custo_calculado ?? 0)}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">{l.custo_atual != null ? formatBRL(l.custo_atual) : "—"}</td>
                          <td className={cn("px-2 py-2 text-right tabular-nums font-semibold",
                            igual ? "text-muted-foreground" : (l.variacao_pct ?? 0) > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
                            {igual ? "igual" : l.variacao_pct != null ? `${l.variacao_pct > 0 ? "+" : ""}${l.variacao_pct.toLocaleString("pt-BR")}%` : "—"}
                          </td>
                          <td className="px-2 py-2 text-[11px]">
                            {ap ? (ap.tiny_ok ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" title={`${ap.aplicado_por ?? ""} · ${new Date(ap.aplicado_em).toLocaleString("pt-BR")}`}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> {formatBRL(ap.custo_final)} · {ap.aplicado_por}
                              </span>
                            ) : <span className="text-red-700 dark:text-red-400" title={ap.tiny_erro ?? ""}>falhou</span>) : <span className="text-muted-foreground">não gravado</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {avisosItens.length > 0 && (
                <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                  <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> Fora da formação</div>
                  {avisosItens.slice(0, 12).map((a, i) => <div key={i}><span className="font-mono">{a.sku ?? "—"}</span>: {a.motivo}</div>)}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="mr-auto text-[11px] text-muted-foreground max-w-[520px]">
                  O custo atual vem do cadastro do Tiny. Vendas já feitas mantêm o custo da hora da venda — para corrigir um período, use Reprocessar CMV.
                </span>
                <Button variant="outline" size="sm" onClick={() => setAberto(false)} disabled={gravando}>Fechar</Button>
                <Button size="sm" className="gap-1.5" disabled={escolhidas.length === 0 || gravando || carregando} onClick={() => void gravar()}>
                  {gravando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
                  Gravar custo no Tiny ({escolhidas.length})
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
