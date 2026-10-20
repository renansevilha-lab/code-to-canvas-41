import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Rocket } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";

// ============================================================================
// Meta de ROAS, orçamento e "impulsionado" das campanhas da Shopee (20/out/2026, pedido do dono).
// Lidos AO VIVO na Shopee pela edge fn `shopee-ads-gestao` — publicada no slot `shopee-flashsale-probe`
// (o projeto está no limite de funções do plano). Só os anúncios da página visível.
// Alterar orçamento/meta = `ads/edit_manual_product_ads` (change_budget / change_roas_target): prévia →
// confirmação → envio UMA vez, só com login; a resposta da Shopee fica em debug_fulfillment
// (modulo 'shopee-ads-editar').
// ============================================================================

const FN = "shopee-flashsale-probe";
const LOJA_POR_SHOP: Record<string, "ottz" | "svl"> = { "522186766": "ottz", "759046323": "svl" };

export interface CampanhaConfig {
  campaign_id: string; ad_type: string | null; bidding_method: string | null; status: string | null;
  budget: number | null; roas_target: number | null; item_id: string | null; nome: string | null;
}
interface ConfigLoja {
  loja: string; campanhas: CampanhaConfig[]; impulsionados: { item_id: string; cool_down_second: number | null }[];
  saldo: number | null; recarga_automatica: boolean | null; erros: string[];
}
export interface ShopeeAdsConfig {
  porCampanha: Map<string, CampanhaConfig & { loja: string }>;
  impulsionados: Set<string>;
  lojas: ConfigLoja[];
}

async function chamar(body: Record<string, unknown>) {
  const { data, error } = await supabaseExternal.functions.invoke(FN, { body });
  if (error) {
    // corpo do erro (401/404) traz a mensagem da função
    let msg = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) { const j = await ctx.json(); msg = j?.erro ?? msg; } } catch { /* mantém */ }
    throw new Error(msg);
  }
  return data as Record<string, any>;
}

/** Configuração ao vivo das campanhas da página (agrupadas por loja). */
export function useShopeeAdsConfig(rows: { campaign_id: number | string; shop_id: number | string | null }[]) {
  const porLoja: Record<string, string[]> = {};
  for (const r of rows) {
    const loja = LOJA_POR_SHOP[String(r.shop_id ?? "")];
    if (loja) (porLoja[loja] ??= []).push(String(r.campaign_id));
  }
  const chave = Object.entries(porLoja).map(([l, ids]) => `${l}:${[...ids].sort().join(",")}`).sort().join("|");
  return useQuery({
    queryKey: ["ads-shopee", "config", chave],
    enabled: rows.length > 0,
    staleTime: 2 * 60_000,
    placeholderData: (a) => a,
    queryFn: async (): Promise<ShopeeAdsConfig> => {
      const lojas = await Promise.all(Object.entries(porLoja).map(([loja, ids]) =>
        chamar({ modulo: "config", loja, campanhas: ids }) as Promise<ConfigLoja>));
      const porCampanha = new Map<string, CampanhaConfig & { loja: string }>();
      const impulsionados = new Set<string>();
      for (const l of lojas) {
        for (const c of l.campanhas ?? []) porCampanha.set(c.campaign_id, { ...c, loja: l.loja });
        for (const i of l.impulsionados ?? []) impulsionados.add(i.item_id);
      }
      return { porCampanha, impulsionados, lojas };
    },
  });
}

export function SeloImpulsionado() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300 px-1.5 py-0 text-[10px] font-medium"
      title="Anúncio impulsionado agora na Shopee (Impulsionar produto)">
      <Rocket className="h-3 w-3" /> impulsionado
    </span>
  );
}

/** Orçamento por dia como a Shopee guarda: 0 = sem limite. */
export function textoOrcamento(v: number | null | undefined) {
  if (v == null) return "—";
  return Number(v) > 0 ? formatBRL(Number(v)) : "sem limite";
}

/** Célula da meta de ROAS com o lápis de editar (meta + orçamento). */
export function MetaRoasCelula({ cfg, nome, roasAtual }: { cfg: (CampanhaConfig & { loja: string }) | undefined; nome: string; roasAtual: number }) {
  const [aberto, setAberto] = useState(false);
  if (!cfg) return <span className="text-muted-foreground text-xs">—</span>;
  const meta = cfg.roas_target;
  const abaixo = meta != null && roasAtual > 0 && roasAtual < meta;
  return (
    <div className="flex items-center justify-center gap-1">
      <span className={`text-xs tabular-nums ${abaixo ? "text-amber-700 font-medium" : ""}`}
        title={meta != null ? `Meta de ROAS na Shopee: ${meta}x${abaixo ? " — o ROAS do período está abaixo da meta" : ""}` : "Campanha sem meta de ROAS (lance manual)"}>
        {meta != null ? `${String(meta).replace(".", ",")}x` : "manual"}
      </span>
      {cfg.ad_type === "manual" && (
        <Button size="icon" variant="ghost" className="h-6 w-6" title="Alterar meta de ROAS / orçamento na Shopee" onClick={() => setAberto(true)}>
          <Pencil className="h-3 w-3" />
        </Button>
      )}
      {aberto && <EditarCampanha cfg={cfg} nome={nome} onFechar={() => setAberto(false)} />}
    </div>
  );
}

interface Previa { ok: boolean; trocas?: { acao: string; campo: string; de: number | null; para: number }[]; pendencias?: string[] }

function EditarCampanha({ cfg, nome, onFechar }: { cfg: CampanhaConfig & { loja: string }; nome: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const [roas, setRoas] = useState(cfg.roas_target != null ? String(cfg.roas_target).replace(".", ",") : "");
  const [orc, setOrc] = useState(cfg.budget != null ? String(cfg.budget).replace(".", ",") : "");
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const corpo = () => ({
    modulo: "editar", loja: cfg.loja, campaign_id: cfg.campaign_id,
    ...(cfg.bidding_method === "auto" && roas.trim() ? { roas_target: roas.trim().replace(",", ".") } : {}),
    ...(orc.trim() ? { budget: orc.trim().replace(/\./g, "").replace(",", ".") } : {}),
  });
  const rotulo = (campo: string) => (campo === "budget" ? "Orçamento por dia" : "Meta de ROAS");
  const valor = (campo: string, v: number | null) => (campo === "budget" ? textoOrcamento(v) : v == null ? "—" : `${String(v).replace(".", ",")}x`);

  async function conferir() {
    setOcupado(true);
    try { setPrevia(await chamar(corpo()) as Previa); }
    catch (e) { toast.error("Não consegui conferir na Shopee", { description: (e as Error).message }); }
    finally { setOcupado(false); }
  }
  async function aplicar() {
    if (!previa?.trocas?.length) return;
    const linhas = previa.trocas.map((t) => `${rotulo(t.campo)}: ${valor(t.campo, t.de)} → ${valor(t.campo, t.para)}`);
    if (!window.confirm(`Alterar a campanha na Shopee (${cfg.loja === "svl" ? "Bumi/SVL" : "Ottz"})?\n\n${nome}\n\n${linhas.join("\n")}\n\nVale na hora para o anúncio no ar.`)) return;
    setOcupado(true);
    try {
      const r = await chamar({ ...corpo(), confirmar: "1" });
      const res = (r.resultados ?? []) as { campo: string; ok: boolean; erro: string | null; mensagem: string | null }[];
      const falhas = res.filter((x) => !x.ok);
      if (r.ok) {
        toast.success("Campanha alterada na Shopee", { description: `Agora: meta ${valor("roas_target", r.depois?.roas_target ?? null)} · orçamento ${textoOrcamento(r.depois?.budget)}` });
        void qc.invalidateQueries({ queryKey: ["ads-shopee", "config"] });
        onFechar();
      } else {
        toast.error("A Shopee não aceitou a alteração", { description: falhas.map((f) => `${rotulo(f.campo)}: ${f.mensagem || f.erro}`).join(" · ") || "sem resposta", duration: 20000 });
        void qc.invalidateQueries({ queryKey: ["ads-shopee", "config"] });
      }
    } catch (e) {
      toast.error("Não consegui alterar a campanha", { description: (e as Error).message, duration: 15000 });
    } finally { setOcupado(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onFechar(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Alterar campanha na Shopee</DialogTitle>
          <DialogDescription className="line-clamp-2">{nome}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {cfg.bidding_method === "auto" ? (
            <div>
              <Label className="text-xs">Meta de ROAS (hoje {cfg.roas_target != null ? `${String(cfg.roas_target).replace(".", ",")}x` : "—"})</Label>
              <Input inputMode="decimal" value={roas} onChange={(e) => { setRoas(e.target.value); setPrevia(null); }} className="mt-1" />
              <p className="text-[11px] text-muted-foreground mt-1">Meta mais alta = a Shopee gasta menos e só mostra onde espera vender mais por real investido.</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Campanha com lance manual: não tem meta de ROAS.</p>
          )}
          <div>
            <Label className="text-xs">Orçamento por dia, R$ (hoje {textoOrcamento(cfg.budget)}; 0 = sem limite)</Label>
            <Input inputMode="decimal" value={orc} onChange={(e) => { setOrc(e.target.value); setPrevia(null); }} className="mt-1" />
          </div>
          {previa && (
            <div className={`rounded-md border p-2.5 text-xs space-y-1 ${previa.pendencias?.length ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5"}`}>
              {(previa.trocas ?? []).map((t) => <div key={t.campo}><b>{rotulo(t.campo)}:</b> {valor(t.campo, t.de)} → {valor(t.campo, t.para)}</div>)}
              {(previa.pendencias ?? []).map((p) => <div key={p} className="text-amber-700">• {p}</div>)}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            A mudança vai direto para a Shopee e vale na hora. Primeiro uso pelo sistema: se a Shopee recusar, a mensagem dela aparece aqui.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onFechar} disabled={ocupado}>Fechar</Button>
          {previa?.ok && previa.trocas?.length ? (
            <Button onClick={() => void aplicar()} disabled={ocupado}>{ocupado && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Aplicar na Shopee</Button>
          ) : (
            <Button onClick={() => void conferir()} disabled={ocupado}>{ocupado && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Conferir</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
