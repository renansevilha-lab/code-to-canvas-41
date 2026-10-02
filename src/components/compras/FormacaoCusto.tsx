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
// O cálculo é da edge fn compras-estoque (custo-preview / custo-aplicar) — o
// front só mostra. Kits e variações ficam de fora.
// ============================================================================

type Rateio = "valor" | "quantidade";
interface Extras { frete: number; ipi: number; st: number; outras: number; desconto: number; rateio: Rateio }
interface Linha {
  sku: string; nome: string | null; foto: string | null; unidades: number; valor_nf: number; preco_nf_unit: number;
  rateio_total: number; rateio_unit: number; custo_final: number; custo_atual: number | null; variacao_pct: number | null;
}
interface Aplicado { custo_final: number; custo_anterior: number | null; tiny_ok: boolean | null; tiny_erro: string | null; aplicado_em: string; aplicado_por: string | null }
interface Preview {
  extras: Extras; frete_nf: number; linhas: Linha[]; avisos: Array<{ sku: string | null; motivo: string }>;
  extras_total: number; total_nf: number; total_com_extras: number; aplicados: Record<string, Aplicado>;
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

const qsExtras = (e: Extras) => CAMPOS.map(({ k }) => `${k}=${e[k] || 0}`).join("&") + `&rateio=${e.rateio}`;
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
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [carregando, setCarregando] = useState(false);
  const [gravando, setGravando] = useState(false);

  async function carregar(e: Extras | null) {
    setCarregando(true);
    try {
      const p: Preview = await chamar(`modulo=custo-preview&ordem_tiny_id=${ordemTinyId}${e ? `&${qsExtras(e)}` : ""}`);
      setPrev(p);
      if (!e) {
        setEx(p.extras);
        setTxt(Object.fromEntries(CAMPOS.map(({ k }) => [k, p.extras[k] ? String(p.extras[k]).replace(".", ",") : ""])));
        // pré-seleciona o que ainda não foi gravado com este custo
        setSel(new Set(p.linhas.filter((l) => !(p.aplicados[l.sku]?.tiny_ok && Math.abs(p.aplicados[l.sku].custo_final - l.custo_final) < 0.005)).map((l) => l.sku)));
      }
    } catch (err) { toast.error("Falha na formação de custo", { description: (err as Error).message }); }
    finally { setCarregando(false); }
  }

  // recalcula (no servidor) 400 ms depois da última digitação
  useEffect(() => {
    if (!aberto || !ex) return;
    const t = setTimeout(() => { void carregar(ex); }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ex]);

  function abrir() { setAberto(true); setPrev(null); setEx(null); void carregar(null); }

  const escolhidas = useMemo(() => (prev?.linhas ?? []).filter((l) => sel.has(l.sku)), [prev, sel]);

  async function gravar() {
    if (!ex || escolhidas.length === 0) return;
    if (!window.confirm(
      `Gravar o preço de custo no cadastro do Tiny (e no app)?\n\n` +
      escolhidas.map((l) => `${l.sku}: ${l.custo_atual != null ? formatBRL(l.custo_atual) : "—"} → ${formatBRL(l.custo_final)}`).join("\n") +
      `\n\nSó o custo muda; o app confere o cadastro depois de gravar.`,
    )) return;
    setGravando(true);
    try {
      let restantes = escolhidas.map((l) => l.sku);
      const falhas: string[] = []; let ok = 0;
      // a função grava ~10 por chamada (limite de 30 s); repete até acabar
      for (let volta = 0; volta < 10 && restantes.length; volta++) {
        const r = await chamar(`modulo=custo-aplicar&ordem_tiny_id=${ordemTinyId}&confirmar=1&${qsExtras(ex)}&skus=${encodeURIComponent(restantes.join(","))}&aplicado_por=${encodeURIComponent(perfil?.nome ?? "app")}`);
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
                      <th className="px-2 py-2 text-right font-medium">= Custo novo</th>
                      <th className="px-2 py-2 text-right font-medium">Custo atual</th>
                      <th className="px-2 py-2 text-right font-medium">Variação</th>
                      <th className="px-2 py-2 text-left font-medium">Tiny</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {prev.linhas.length === 0 ? (
                      <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">Nenhum item com preço nesta OC.</td></tr>
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
                          <td className="px-2 py-2 text-right tabular-nums font-mono">{formatBRL(l.preco_nf_unit)}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">{l.rateio_unit ? `${l.rateio_unit > 0 ? "+" : "−"}${formatBRL(Math.abs(l.rateio_unit))}` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums font-mono font-bold text-[13px]">{formatBRL(l.custo_final)}</td>
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

              {prev.avisos.length > 0 && (
                <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                  <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> Fora da formação</div>
                  {prev.avisos.slice(0, 12).map((a, i) => <div key={i}><span className="font-mono">{a.sku ?? "—"}</span>: {a.motivo}</div>)}
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
