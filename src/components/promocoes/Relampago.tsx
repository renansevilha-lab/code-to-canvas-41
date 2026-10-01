import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Zap, Loader2, Plus, Trash2, Search, AlertTriangle, CalendarClock, ChevronDown, Power, ChevronLeft, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import {
  AMBER, Foto, GREEN, LOJAS, RED, calcMc, chamarFlashsale, corMc, num, tetoRelampago, tituloMc, type McBase,
} from "./comum";

// ============================================================================
// Relâmpago Shopee — programação DIÁRIA da Promoção Relâmpago da Loja.
// (Aba "Relâmpago" de /promocoes-shopee; antes era a rota /flash-sale.)
// A lista fixa de produtos+preços (flashsale_programacao) é RECONCILIADA com a
// promoção de amanhã: o cron das 18h (jobid 87) — ou o botão manual — compara
// com o que já existe no slot na Shopee e adiciona SÓ o que falta.
// MC%: comissão/imposto EFETIVOS medidos nos pedidos reais (RPC
// flashsale_mc_base — mediana 60d, mono-SKU) + CMV atual kit-aware; o front só
// aplica MC(p) = p·(1−com−imp) − cmv.
// Adicionar produto (30/set/2026): 20 por página, "mais vendidos (30d)" ou
// "mais recentes" (RPC shopee_anuncios_busca — vendas pelos NOSSOS pedidos, o
// espelho não traz vendas) e preço relâmpago já no TETO estimado que a Shopee
// aceita (tetoRelampago: 1% abaixo do atual e ≤ menor preço vendido em 7 dias,
// RPC promo_mc_base).
// ============================================================================

interface ProgItem {
  id: string; shop_id: number; item_id: number; model_id: number;
  item_nome: string | null; model_nome: string | null; sku: string | null; imagem: string | null;
  preco_original: number | null; preco_promo: number; estoque_promo: number;
  limite_compra: number; ativo: boolean; criado_por: string | null;
}
interface Criada {
  id: number; shop_id: number; dia: string; flash_sale_id: number | null;
  status: string; itens_ok: number; itens_falha: number; detalhe: Record<string, unknown> | null;
  criado_em: string;
}

// Campo numérico com edição local + gravação no blur (evita update a cada tecla).
function CampoNum({ valor, largura, onSalvar, decimais = 2 }: {
  valor: number; largura: string; onSalvar: (v: number) => void; decimais?: number;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const mostrado = txt ?? (decimais > 0 ? valor.toFixed(decimais) : String(valor));
  return (
    <Input
      className={cn("h-7 text-[12.5px] tabular-nums font-mono text-right px-1.5", largura)}
      inputMode="decimal" value={mostrado}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        if (txt === null) return;
        const v = Number(txt.replace(",", "."));
        setTxt(null);
        if (Number.isFinite(v) && v !== valor) onSalvar(v);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function Relampago({ shopId }: { shopId: number }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [dlgAdd, setDlgAdd] = useState(false);
  const [dlgPrev, setDlgPrev] = useState<null | { dia: string; resultados: any[] }>(null);
  const [programando, setProgramando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  // ---------------- programação + config + histórico + base de MC ----------------
  const progQ = useQuery({
    queryKey: ["flashsale", "prog", shopId],
    queryFn: async (): Promise<ProgItem[]> => {
      const { data, error } = await supabaseExternal
        .from("flashsale_programacao").select("*")
        .eq("shop_id", shopId).order("item_nome").order("model_nome");
      if (error) throw error;
      return (data ?? []) as ProgItem[];
    },
  });
  const cfgQ = useQuery({
    queryKey: ["flashsale", "cfg"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("flashsale_config").select("*");
      if (error) throw error;
      return (data ?? []) as { shop_id: number; automacao_ativa: boolean; max_itens_bloco: number }[];
    },
  });
  const histQ = useQuery({
    queryKey: ["flashsale", "hist", shopId],
    queryFn: async (): Promise<Criada[]> => {
      const { data, error } = await supabaseExternal
        .from("flashsale_criadas").select("*")
        .eq("shop_id", shopId).order("dia", { ascending: false }).limit(10);
      if (error) throw error;
      return (data ?? []) as Criada[];
    },
  });
  // comissão/imposto efetivos + CMV por SKU programado (regra no banco)
  const mcQ = useQuery({
    queryKey: ["flashsale", "mc", shopId],
    queryFn: async (): Promise<Map<string, McBase>> => {
      const { data, error } = await supabaseExternal.rpc("flashsale_mc_base", { p_shop_id: shopId });
      if (error) throw error;
      return new Map(((data ?? []) as McBase[]).map((r) => [r.sku, r]));
    },
  });

  const prog = progQ.data ?? [];
  const ativos = prog.filter((p) => p.ativo);
  const cfg = (cfgQ.data ?? []).find((c) => Number(c.shop_id) === shopId);
  const automacao = cfg?.automacao_ativa ?? false;
  const mcMap = mcQ.data ?? new Map<string, McBase>();
  const recarregarProg = () => {
    void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });
    void qc.invalidateQueries({ queryKey: ["flashsale", "mc", shopId] });
  };

  // ---------------- mutações da programação ----------------
  async function atualizarItem(id: string, patch: Record<string, unknown>, rotulo: string) {
    const { error } = await supabaseExternal.from("flashsale_programacao")
      .update({ ...patch, atualizado_em: new Date().toISOString() }).eq("id", id);
    if (error) { toast.error(`Falha ao salvar ${rotulo}`, { description: error.message }); return; }
    recarregarProg();
  }
  async function removerItem(p: ProgItem) {
    if (!window.confirm(`Remover "${p.item_nome ?? p.sku}" da programação diária?`)) return;
    const { error } = await supabaseExternal.from("flashsale_programacao").delete().eq("id", p.id);
    if (error) { toast.error("Falha ao remover", { description: error.message }); return; }
    toast.success("Removido da programação (não tira da promoção de amanhã se já entrou)");
    recarregarProg();
  }
  async function salvarConfig(patch: Record<string, unknown>, ok: string) {
    const { error } = await supabaseExternal.from("flashsale_config")
      .upsert({ shop_id: shopId, ...patch, atualizado_em: new Date().toISOString() });
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    toast.success(ok);
    void qc.invalidateQueries({ queryKey: ["flashsale", "cfg"] });
  }

  // ---------------- programar amanhã (prévia → confirmar) ----------------
  async function abrirPrevia() {
    setProgramando(true);
    try {
      const r = await chamarFlashsale(`modulo=programar&shop_id=${shopId}`);
      setDlgPrev({ dia: r.dia, resultados: r.resultados ?? [] });
    } catch (e) {
      toast.error("Falha ao montar a prévia", { description: (e as Error).message });
    } finally { setProgramando(false); }
  }
  async function confirmarProgramacao() {
    setConfirmando(true);
    try {
      const r = await chamarFlashsale(`modulo=programar&shop_id=${shopId}&confirmar=1`);
      const res = (r.resultados ?? [])[0] ?? {};
      const motivos = ((res.problemas ?? []) as { sku: string; motivo: string }[])
        .slice(0, 4).map((x) => `${x.sku}: ${x.motivo}`).join("\n") || undefined;
      if (res.status === "ok") toast.success(`+${res.itens_ok} item(ns) na relâmpago de ${r.dia}${res.ja_na_promo ? ` (${res.ja_na_promo} já estavam)` : ""}`);
      else if (res.status === "em_dia") toast.info(`Tudo em dia — os itens programados já estão na promoção de ${r.dia}.`);
      else if (res.status === "parcial") toast.warning(`${res.itens_ok} ok e ${res.itens_falha} falha(s)`, { description: motivos, duration: 12000 });
      else toast.error(`Falhou: ${res.erro ?? res.message ?? res.status}`, { description: motivos, duration: 12000 });
      setDlgPrev(null);
      void qc.invalidateQueries({ queryKey: ["flashsale", "hist", shopId] });
    } catch (e) {
      toast.error("Falha ao programar", { description: (e as Error).message });
    } finally { setConfirmando(false); }
  }

  const nomeLoja = LOJAS.find((l) => l.shop_id === shopId)?.nome ?? String(shopId);

  return (
    <div className="space-y-5">
      {/* Automação + ação manual */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border p-3.5 bg-muted/30">
        <div className="flex items-center gap-2.5">
          <Power className="h-4 w-4" style={{ color: automacao ? GREEN : "#94A3B8" }} />
          <div>
            <div className="text-[13px] font-medium">Automação diária — {nomeLoja}</div>
            <div className="text-[11.5px] text-muted-foreground">
              Cron às 18h monta/completa a relâmpago de amanhã com os itens ativos
            </div>
          </div>
          <Switch checked={automacao} className="ml-1"
            onCheckedChange={(v) => void salvarConfig({ automacao_ativa: v },
              v ? "Automação LIGADA — o cron das 18h assume" : "Automação desligada — só pelo botão manual")} />
        </div>
        <span className="text-[12px] text-muted-foreground"
          title="Limite real da Shopee, medido em produção: o create numa data que já tem promoção volta 'already exist', e a promoção aceita dezenas de produtos.">
          1 promoção por dia · até 50 produtos
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="h-8 gap-1.5"
          disabled={programando || ativos.length === 0} onClick={() => void abrirPrevia()}>
          {programando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}
          Programar amanhã agora
        </Button>
        <Button size="sm" className="h-8 gap-1.5" onClick={() => setDlgAdd(true)}>
          <Plus className="h-3.5 w-3.5" /> Adicionar produto
        </Button>
      </div>

      {/* Tabela de programação */}
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b bg-muted/40 text-muted-foreground text-[11px] uppercase tracking-wide">
              <th className="text-left font-medium px-3 py-2">Produto</th>
              <th className="text-right font-medium px-2 py-2">Preço atual</th>
              <th className="text-right font-medium px-2 py-2">Preço relâmpago</th>
              <th className="text-right font-medium px-2 py-2">Desc.</th>
              <th className="text-right font-medium px-2 py-2"
                title="Margem de contribuição estimada no preço relâmpago: comissão e imposto efetivos medidos nos seus pedidos (60 dias) + custo atual do produto">MC promo</th>
              <th className="text-right font-medium px-2 py-2">Estoque promo</th>
              <th className="text-right font-medium px-2 py-2" title="0 = sem limite por comprador">Limite</th>
              <th className="text-center font-medium px-2 py-2">Ativo</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {progQ.isLoading ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Carregando…</td></tr>
            ) : prog.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                Nenhum produto programado para {nomeLoja} — comece por “Adicionar produto”.
              </td></tr>
            ) : prog.map((p) => {
              const orig = num(p.preco_original);
              const desc = orig > 0 ? 1 - num(p.preco_promo) / orig : null;
              const alerta = orig > 0 && (num(p.preco_promo) >= orig || num(p.preco_promo) < orig * 0.5);
              const base = p.sku ? mcMap.get(p.sku) : undefined;
              const mc = calcMc(base, num(p.preco_promo));
              return (
                <tr key={p.id} className={cn("border-b last:border-0", !p.ativo && "opacity-50")}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5 min-w-[240px]">
                      <Foto url={p.imagem} />
                      <div className="min-w-0">
                        <div className="truncate max-w-[320px] font-medium" title={p.item_nome ?? ""}>{p.item_nome ?? "—"}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {p.sku ?? "sem SKU"}{p.model_nome ? ` · var. ${p.model_nome}` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
                    {orig > 0 ? formatBRL(orig) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {alerta && (
                        <span title={num(p.preco_promo) >= orig ? "Promo maior ou igual ao preço atual — o sistema PULA este item" : "Promo abaixo de 50% do preço atual — o sistema PULA este item (proteção contra dedo errado)"}>
                          <AlertTriangle className="h-3.5 w-3.5" style={{ color: AMBER }} />
                        </span>
                      )}
                      <CampoNum valor={num(p.preco_promo)} largura="w-[84px]"
                        onSalvar={(v) => void atualizarItem(p.id, { preco_promo: v }, "preço")} />
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-mono"
                    title={desc != null && desc > 0 && desc < 0.01
                      ? "Desconto abaixo de 1% — a Shopee costuma RECUSAR pelo critério de preço da promoção (foi o motivo da maioria das falhas). Dê ao menos 1% de desconto."
                      : undefined}
                    style={{ color: desc == null || desc <= 0 ? RED : desc < 0.01 ? AMBER : GREEN }}>
                    {desc != null ? `${(desc * 100).toFixed(desc < 0.01 ? 2 : 0)}%${desc > 0 && desc < 0.01 ? " ⚠" : ""}` : "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-mono"
                    style={{ color: mc ? corMc(mc.pct) : undefined }}
                    title={tituloMc(base, mc)}>
                    {mc ? `${(mc.pct * 100).toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <CampoNum valor={p.estoque_promo} largura="w-[64px]" decimais={0}
                      onSalvar={(v) => void atualizarItem(p.id, { estoque_promo: Math.max(1, Math.min(1000, Math.round(v))) }, "estoque")} />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <CampoNum valor={p.limite_compra} largura="w-[56px]" decimais={0}
                      onSalvar={(v) => void atualizarItem(p.id, { limite_compra: Math.max(0, Math.round(v)) }, "limite")} />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Switch checked={p.ativo} onCheckedChange={(v) => void atualizarItem(p.id, { ativo: v }, "ativo")} />
                  </td>
                  <td className="px-2 py-2">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => void removerItem(p)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {prog.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground -mt-2">
          {ativos.length} de {prog.length} item(ns) ativos · 1 promoção por dia com até 50 produtos (limite Shopee) ·
          desconto mínimo do critério: ~1% (1 centavo é recusado) · estoque promo precisa existir no anúncio ·
          MC estimada com taxas reais dos últimos 60 dias.
        </p>
      )}

      {/* Histórico */}
      <div>
        <h2 className="text-[14px] font-semibold mb-2">Últimas programações — {nomeLoja}</h2>
        {histQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (histQ.data ?? []).length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Nenhuma relâmpago criada pelo app ainda.</p>
        ) : (
          <div className="rounded-lg border divide-y">
            {(histQ.data ?? []).map((c) => (
              <div key={c.id}>
              <div className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                <span className="tabular-nums font-mono w-[86px]">{c.dia.split("-").reverse().join("/")}</span>
                <span className="px-1.5 py-0.5 rounded text-[11px] font-medium"
                  style={{
                    background: c.status === "ok" ? `${GREEN}18` : c.status === "parcial" ? `${AMBER}18` : `${RED}18`,
                    color: c.status === "ok" ? GREEN : c.status === "parcial" ? AMBER : RED,
                  }}>
                  {c.status === "ok" ? "completa" : c.status}
                </span>
                <span className="text-muted-foreground">{c.itens_ok} adicionado(s){c.itens_falha ? ` · ${c.itens_falha} falha(s)` : ""}</span>
                <span className="flex-1" />
                {c.flash_sale_id && <span className="text-[11px] text-muted-foreground font-mono">#{c.flash_sale_id}</span>}
              </div>
              {Array.isArray((c.detalhe as { problemas?: { sku: string; motivo: string }[] })?.problemas)
                && ((c.detalhe as { problemas: { sku: string; motivo: string }[] }).problemas.length > 0) && (
                <div className="px-3 pb-2 -mt-1 space-y-0.5">
                  {(c.detalhe as { problemas: { sku: string; motivo: string }[] }).problemas.slice(0, 8).map((p, i) => (
                    <p key={i} className="text-[11px] leading-snug" style={{ color: AMBER }}>
                      <span className="font-mono font-semibold">{p.sku}</span>: {p.motivo}
                    </p>
                  ))}
                </div>
              )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Como funciona */}
      <details className="rounded-lg border p-3.5 text-[12.5px] text-muted-foreground [&_summary]:cursor-pointer">
        <summary className="font-medium text-foreground flex items-center gap-1.5">
          <ChevronDown className="h-3.5 w-3.5" /> Como funciona a automação
        </summary>
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li>A Shopee abre <b>um slot por dia</b> (00:00 → 00:00). O sistema sempre programa o dia de <b>amanhã</b>.</li>
          <li>Às <b>18h</b> (ou pelo botão), ele compara esta lista com a promoção de amanhã na Shopee e adiciona <b>só o que falta</b> — se você incluir um produto depois, a próxima rodada completa a promoção, sem duplicar.</li>
          <li>A Shopee permite <b>1 promoção relâmpago por dia</b>, com até <b>50 produtos</b> — o sistema completa a existente; o que não couber é reportado.</li>
          <li><b>Desconto mínimo ~1%</b>: promo "1 centavo abaixo" é recusada pelo critério de preço da Shopee (foi a causa da maioria das falhas). E a promo não pode ficar acima do <b>menor preço dos últimos 7 dias</b> do item.</li>
          <li>Blocos que você desativar no Seller Center continuam desativados — o sistema não religa promoção desligada na mão.</li>
          <li>Proteção de preço: item com promo <b>maior/igual ao preço atual</b> ou <b>abaixo de 50%</b> dele é pulado e reportado no Discord.</li>
          <li><b>MC promo</b> é estimada: comissão e imposto <b>efetivos</b> medidos nos seus pedidos dos últimos 60 dias (por SKU; sem histórico, média da loja) + CMV atual do cadastro. Passe o mouse para ver a conta.</li>
          <li>Preço atual é o registrado quando o produto entrou na lista; se mudar o preço no Seller Center, ajuste aqui também.</li>
        </ul>
      </details>

      {/* Dialog prévia/confirmação */}
      <Dialog open={dlgPrev !== null} onOpenChange={(v) => { if (!v) setDlgPrev(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Programar relâmpago de {dlgPrev?.dia?.split("-").reverse().join("/")}</DialogTitle>
            <DialogDescription>
              Prévia da reconciliação na {nomeLoja}. Confirmando, o que falta entra na promoção e blocos novos são <b>ativados</b>.
            </DialogDescription>
          </DialogHeader>
          {dlgPrev?.resultados.map((r: any, i: number) => (
            <div key={i} className="text-[13px] space-y-1.5">
              {r.status === "dry" ? (
                <>
                  <p>
                    {r.itens_ja_na_promo > 0 && <><b>{r.itens_ja_na_promo}</b> produto(s) já estão na promoção de amanhã. </>}
                    Faltam <b>{r.faltam}</b>{r.sales_existentes > 0
                      ? <> — entram na promoção existente</>
                      : <> — a promoção do dia será criada e ativada</>}.
                    {r.nao_cabem > 0 && <> <span style={{ color: AMBER }}>{r.nao_cabem} não cabem (limite Shopee: 1 promoção/dia, 50 produtos).</span></>}
                  </p>
                  {(r.pulados ?? []).length > 0 && (
                    <p className="text-[12px]" style={{ color: AMBER }}>
                      <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
                      {r.pulados.length} item(ns) pulado(s) pela proteção de preço: {r.pulados.map((x: any) => x.sku).join(", ")}
                    </p>
                  )}
                </>
              ) : r.status === "em_dia" ? (
                <p>Tudo em dia — os itens programados <b>já estão</b> na promoção de amanhã ({r.itens_ja_na_promo} produto(s) em {r.sales_existentes} bloco(s)).</p>
              ) : r.status === "sem_itens_programados" ? (
                <p>Nenhum item ativo na programação desta loja.</p>
              ) : (
                <p style={{ color: RED }}>Não dá para programar: {r.erro ?? r.status}</p>
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setDlgPrev(null)}>Cancelar</Button>
            <Button size="sm" className="gap-1.5"
              disabled={confirmando || !(dlgPrev?.resultados ?? []).some((r: any) => r.status === "dry")}
              onClick={() => void confirmarProgramacao()}>
              {confirmando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Completar promoção
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog adicionar produto */}
      <AdicionarProduto aberto={dlgAdd} onFechar={() => setDlgAdd(false)} shopId={shopId}
        jaProgramados={new Set(prog.map((p) => `${p.item_id}:${p.model_id}`))}
        criadoPor={perfil?.nome ?? null}
        onAdicionou={recarregarProg} />
    </div>
  );
}


// ============================================================================
// Dialog "Adicionar produto": 20 anúncios por página, ordenados por MAIS
// VENDIDOS (30 dias, pelos nossos pedidos) ou MAIS RECENTES (criação na
// Shopee), com busca por nome/SKU. Cada linha já mostra o TETO relâmpago
// estimado e a MC nesse preço; "Adicionar" grava na programação com esse teto.
// ============================================================================
interface AnuncioBusca {
  item_id: number; nome: string; sku_pai: string | null; tem_variacao: boolean;
  preco_min: number | null; preco_max: number | null; estoque_total: number | null;
  imagem_url: string | null; criado_em_shopee: string | null; vendas_30d: number; total: number;
}
interface VariacaoRow { item_id: number; model_id: number; sku: string | null; nome_variacao: string | null; preco: number | null; estoque: number | null; }

const POR_PAGINA = 20;

function AdicionarProduto({ aberto, onFechar, shopId, jaProgramados, criadoPor, onAdicionou }: {
  aberto: boolean; onFechar: () => void; shopId: number;
  jaProgramados: Set<string>; criadoPor: string | null; onAdicionou: () => void;
}) {
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");
  const [ordem, setOrdem] = useState<"vendas" | "recentes">("vendas");
  const [pagina, setPagina] = useState(0);
  const [salvandoKey, setSalvandoKey] = useState<string | null>(null);

  // debounce simples da busca; volta para a 1ª página a cada filtro novo
  useEffect(() => {
    const t = setTimeout(() => { setBuscaAtiva(busca.trim()); setPagina(0); }, 350);
    return () => clearTimeout(t);
  }, [busca]);

  const catQ = useQuery({
    queryKey: ["flashsale", "busca", shopId, buscaAtiva, ordem, pagina],
    enabled: aberto,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ anuncios: AnuncioBusca[]; variacoes: Map<number, VariacaoRow[]> }> => {
      const { data, error } = await supabaseExternal.rpc("shopee_anuncios_busca", {
        p_shop_id: shopId, p_busca: buscaAtiva.replace(/[%_]/g, " ") || null, p_ordem: ordem,
        p_offset: pagina * POR_PAGINA, p_limit: POR_PAGINA,
      });
      if (error) throw error;
      const anuncios = (data ?? []) as AnuncioBusca[];
      const varMap = new Map<number, VariacaoRow[]>();
      const comVar = anuncios.filter((a) => a.tem_variacao).map((a) => a.item_id);
      if (comVar.length > 0) {
        const { data: vars } = await supabaseExternal.from("shopee_anuncios_variacao")
          .select("item_id, model_id, sku, nome_variacao, preco, estoque")
          .eq("shop_id", shopId).in("item_id", comVar);
        for (const v of (vars ?? []) as VariacaoRow[]) {
          if (!varMap.has(v.item_id)) varMap.set(v.item_id, []);
          varMap.get(v.item_id)!.push(v);
        }
      }
      return { anuncios, variacoes: varMap };
    },
  });

  const anuncios = useMemo(() => catQ.data?.anuncios ?? [], [catQ.data]);
  const variacoes = useMemo(() => catQ.data?.variacoes ?? new Map<number, VariacaoRow[]>(), [catQ.data]);
  const total = anuncios[0]?.total ?? 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  // MC + menor preço 7d + vendas 30d por SKU da página (regra no banco)
  const skusPagina = useMemo(() => {
    const s = new Set<string>();
    for (const a of anuncios) {
      if (a.tem_variacao) for (const v of variacoes.get(a.item_id) ?? []) { if (v.sku) s.add(v.sku); }
      else if (a.sku_pai) s.add(a.sku_pai);
    }
    return [...s].sort();
  }, [anuncios, variacoes]);
  const baseQ = useQuery({
    queryKey: ["flashsale", "busca-base", shopId, skusPagina],
    enabled: aberto && skusPagina.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<Map<string, McBase>> => {
      const { data, error } = await supabaseExternal.rpc("promo_mc_base", { p_shop_id: shopId, p_skus: skusPagina });
      if (error) throw error;
      return new Map(((data ?? []) as McBase[]).map((r) => [r.sku, r]));
    },
  });
  const bases = baseQ.data ?? new Map<string, McBase>();

  async function adicionar(a: AnuncioBusca, v: VariacaoRow | null, preco: number, teto: number | null) {
    const key = `${a.item_id}:${v?.model_id ?? 0}`;
    if (preco <= 0) { toast.warning("Produto sem preço no espelho — sincronize o catálogo ou ajuste depois."); }
    setSalvandoKey(key);
    try {
      const promo = teto ?? (preco > 0 ? preco : 1);
      const { error } = await supabaseExternal.from("flashsale_programacao").insert({
        shop_id: shopId, item_id: a.item_id, model_id: v?.model_id ?? 0,
        item_nome: a.nome, model_nome: v?.nome_variacao ?? null,
        sku: v?.sku ?? a.sku_pai ?? null, imagem: a.imagem_url,
        preco_original: preco > 0 ? preco : null, preco_promo: promo,
        criado_por: criadoPor,
      });
      if (error) throw error;
      toast.success(`"${a.nome.slice(0, 40)}" adicionado`, {
        description: teto != null
          ? `Preço relâmpago já no teto estimado: ${formatBRL(teto)} — ajuste na tabela se quiser.`
          : "Ajuste o preço relâmpago na tabela.",
      });
      onAdicionou();
    } catch (e) {
      toast.error("Falha ao adicionar", { description: (e as Error).message });
    } finally { setSalvandoKey(null); }
  }

  const nomeLoja = LOJAS.find((l) => l.shop_id === shopId)?.nome;

  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Adicionar produto à relâmpago</DialogTitle>
          <DialogDescription>
            Catálogo da {nomeLoja}, {POR_PAGINA} por página. O preço relâmpago já entra no <b>maior preço que a
            Shopee deve aceitar</b> (1% abaixo do atual e nunca acima do menor preço vendido nos últimos 7 dias).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-8 text-sm" placeholder="nome ou SKU — ex.: areia bumi · 15984" autoFocus
              value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
          {([["vendas", "Mais vendidos (30 dias)"], ["recentes", "Mais recentes"]] as const).map(([k, rot]) => (
            <Button key={k} size="sm" variant={ordem === k ? "default" : "outline"} className="h-8 text-xs"
              onClick={() => { setOrdem(k); setPagina(0); }}>
              {rot}
            </Button>
          ))}
        </div>
        <div className="max-h-[460px] overflow-y-auto rounded-md border">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur text-muted-foreground text-[10.5px] uppercase tracking-wide">
              <tr>
                <th className="text-left font-medium px-3 py-1.5">Produto</th>
                <th className="text-right font-medium px-2 py-1.5">{ordem === "recentes" ? "Criado" : "Vendas 30d"}</th>
                <th className="text-right font-medium px-2 py-1.5">Preço atual</th>
                <th className="text-right font-medium px-2 py-1.5" title="Maior preço relâmpago que a Shopee deve aceitar (estimativa)">Teto relâmpago</th>
                <th className="text-right font-medium px-2 py-1.5">MC no teto</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {catQ.isLoading ? (
                <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Buscando…</td></tr>
              ) : catQ.isError ? (
                <tr><td colSpan={6} className="p-4 text-center" style={{ color: RED }}>Falha na busca: {(catQ.error as Error).message}</td></tr>
              ) : anuncios.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Nada encontrado{buscaAtiva ? ` para “${buscaAtiva}”` : ""}.</td></tr>
              ) : anuncios.map((a) => {
                const alvos: (VariacaoRow | null)[] = a.tem_variacao ? (variacoes.get(a.item_id) ?? []) : [null];
                return alvos.map((v) => {
                  const key = `${a.item_id}:${v?.model_id ?? 0}`;
                  const ja = jaProgramados.has(key);
                  const sku = v?.sku ?? a.sku_pai ?? null;
                  const base = sku ? bases.get(sku) : undefined;
                  const preco = num(v?.preco ?? a.preco_min);
                  const t = tetoRelampago(preco, base?.menor_preco_7d != null ? num(base.menor_preco_7d) : null);
                  const mc = t ? calcMc(base, t.teto) : null;
                  return (
                    <tr key={key}>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Foto url={a.imagem_url} size={36} />
                          <div className="min-w-0">
                            <div className="truncate max-w-[340px]" title={a.nome}>{a.nome}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {sku || "sem SKU"}{v?.nome_variacao ? ` · ${v.nome_variacao}` : ""} · estoque {num(v?.estoque ?? a.estoque_total)}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                        {ordem === "recentes"
                          ? (a.criado_em_shopee ? new Date(a.criado_em_shopee).toLocaleDateString("pt-BR") : "—")
                          : (v ? (base ? `${num(base.vendas_30d)} un` : "…") : `${num(a.vendas_30d)} un`)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-mono">{preco > 0 ? formatBRL(preco) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-mono font-semibold" title={t?.motivo}>
                        {baseQ.isLoading ? <Loader2 className="h-3 w-3 animate-spin inline" /> : t ? formatBRL(t.teto) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-mono" style={{ color: mc ? corMc(mc.pct) : undefined }}
                        title={tituloMc(base, mc)}>
                        {mc ? `${(mc.pct * 100).toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Button size="sm" variant={ja ? "ghost" : "outline"} className="h-7 text-xs w-[92px]"
                          disabled={ja || salvandoKey === key || baseQ.isLoading}
                          onClick={() => void adicionar(a, v, preco, t?.teto ?? null)}>
                          {salvandoKey === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : ja ? "Já na lista" : "Adicionar"}
                        </Button>
                      </td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {total > 0 ? `${total} anúncio(s)` : ""} · catálogo do espelho (sync diário) · vendas e menor preço pelos nossos pedidos.
            Teto é estimativa — se a Shopee recusar, o motivo aparece no histórico.
          </p>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={pagina === 0 || catQ.isFetching}
              onClick={() => setPagina((p) => Math.max(0, p - 1))}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="text-[12px] tabular-nums">{pagina + 1} / {paginas}</span>
            <Button size="icon" variant="outline" className="h-7 w-7" disabled={pagina + 1 >= paginas || catQ.isFetching}
              onClick={() => setPagina((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
