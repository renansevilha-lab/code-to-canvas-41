import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Zap, Loader2, Plus, Trash2, Search, AlertTriangle, CalendarClock, ChevronDown, Power,
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
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Relâmpago Shopee — programação DIÁRIA da Promoção Relâmpago da Loja.
// A equipe criava a flash sale na mão todos os dias; aqui fica a lista fixa de
// produtos + preços (flashsale_programacao) e o cron das 18h (jobid 87) monta a
// promoção de AMANHÃ sozinho: cria no slot do dia → adiciona os itens → ativa →
// registra em flashsale_criadas → avisa no Discord. O toggle de automação é por
// loja (flashsale_config) e só vale para o cron; o botão "Programar amanhã"
// dispara na hora (com prévia + confirmação) mesmo com a automação desligada.
// Slots da Shopee são DIÁRIOS (00:00 → 00:00). Máx. 50 itens por flash sale.
// ============================================================================

const LOJAS = [
  { shop_id: 522186766, nome: "Ottz Pet" },
  { shop_id: 759046323, nome: "Bumi Pet" },
] as const;

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
interface CatalogoModel { model_id: number; nome: string | null; model_sku: string | null; preco: number | null; estoque: number | null; }
interface CatalogoItem {
  item_id: number; nome: string; item_sku: string | null; has_model: boolean;
  preco: number | null; estoque: number | null; imagem: string | null; models: CatalogoModel[];
}

const num = (x: unknown): number => { const n = Number(x ?? 0); return Number.isFinite(n) ? n : 0; };
const GREEN = "#0E8A5F", RED = "#C9432F", AMBER = "#B7791F";

function Foto({ url, size = 44 }: { url: string | null; size?: number }) {
  const [erro, setErro] = useState(false);
  return (
    <div className="rounded-[8px] shrink-0 overflow-hidden flex items-center justify-center bg-muted" style={{ width: size, height: size }}>
      {url && !erro
        ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" onError={() => setErro(true)} />
        : <Zap className="h-4 w-4 text-muted-foreground" />}
    </div>
  );
}

async function chamarFn(qs: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-flashsale?${qs}`, {
    ...init,
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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

function FlashSalePage() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [shopId, setShopId] = useState<number>(LOJAS[0].shop_id);
  const [dlgAdd, setDlgAdd] = useState(false);
  const [dlgPrev, setDlgPrev] = useState<null | { dia: string; resultados: any[] }>(null);
  const [programando, setProgramando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  // ---------------- programação + config + histórico ----------------
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
      return (data ?? []) as { shop_id: number; automacao_ativa: boolean }[];
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

  const prog = progQ.data ?? [];
  const ativos = prog.filter((p) => p.ativo);
  const automacao = (cfgQ.data ?? []).find((c) => Number(c.shop_id) === shopId)?.automacao_ativa ?? false;
  const recarregarProg = () => void qc.invalidateQueries({ queryKey: ["flashsale", "prog", shopId] });

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
    toast.success("Removido da programação");
    recarregarProg();
  }
  async function toggleAutomacao(ligar: boolean) {
    const { error } = await supabaseExternal.from("flashsale_config")
      .upsert({ shop_id: shopId, automacao_ativa: ligar, atualizado_em: new Date().toISOString() });
    if (error) { toast.error("Falha ao salvar automação", { description: error.message }); return; }
    toast.success(ligar
      ? "Automação LIGADA — o cron das 18h programa a relâmpago de amanhã sozinho"
      : "Automação desligada — nada é criado sem o botão manual");
    void qc.invalidateQueries({ queryKey: ["flashsale", "cfg"] });
  }

  // ---------------- programar amanhã (prévia → confirmar) ----------------
  async function abrirPrevia() {
    setProgramando(true);
    try {
      const r = await chamarFn(`modulo=programar&shop_id=${shopId}`);
      setDlgPrev({ dia: r.dia, resultados: r.resultados ?? [] });
    } catch (e) {
      toast.error("Falha ao montar a prévia", { description: (e as Error).message });
    } finally { setProgramando(false); }
  }
  async function confirmarProgramacao() {
    setConfirmando(true);
    try {
      const r = await chamarFn(`modulo=programar&shop_id=${shopId}&confirmar=1`);
      const res = (r.resultados ?? [])[0] ?? {};
      if (res.status === "ok") toast.success(`Relâmpago de ${r.dia} criada e ativada (${res.itens_ok} itens)`);
      else if (res.status === "ja_criada") toast.info(`A relâmpago de ${r.dia} já existia (flash sale ${res.flash_sale_id})`);
      else if (res.status === "parcial") toast.warning(`Criada com ${res.itens_falha} falha(s) — conferir no Seller Center`, { duration: 9000 });
      else toast.error(`Falhou: ${res.erro ?? res.message ?? res.status}`, { duration: 9000 });
      setDlgPrev(null);
      void qc.invalidateQueries({ queryKey: ["flashsale", "hist", shopId] });
    } catch (e) {
      toast.error("Falha ao programar", { description: (e as Error).message });
    } finally { setConfirmando(false); }
  }

  const nomeLoja = LOJAS.find((l) => l.shop_id === shopId)?.nome ?? String(shopId);

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-[1200px]">
      {/* Cabeçalho */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-[-0.02em] flex items-center gap-2">
            <Zap className="h-5 w-5" style={{ color: "#DB6B1F" }} /> Relâmpago Shopee
          </h1>
          <p className="text-[12.5px] text-muted-foreground mt-0.5">
            Programação diária da Promoção Relâmpago da Loja — os produtos e preços abaixo são
            recriados <b>todos os dias</b> na promoção de amanhã.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {LOJAS.map((l) => (
            <Button key={l.shop_id} size="sm" variant={shopId === l.shop_id ? "default" : "outline"}
              className="h-8" onClick={() => setShopId(l.shop_id)}>
              {l.nome}
            </Button>
          ))}
        </div>
      </div>

      {/* Automação + ação manual */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border p-3.5 bg-muted/30">
        <div className="flex items-center gap-2.5">
          <Power className="h-4 w-4" style={{ color: automacao ? GREEN : "#94A3B8" }} />
          <div>
            <div className="text-[13px] font-medium">Automação diária — {nomeLoja}</div>
            <div className="text-[11.5px] text-muted-foreground">
              Cron às 18h cria a relâmpago de amanhã com os itens ativos abaixo
            </div>
          </div>
          <Switch checked={automacao} onCheckedChange={(v) => void toggleAutomacao(v)} className="ml-1" />
        </div>
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
              <th className="text-right font-medium px-2 py-2">Estoque promo</th>
              <th className="text-right font-medium px-2 py-2" title="0 = sem limite por comprador">Limite</th>
              <th className="text-center font-medium px-2 py-2">Ativo</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {progQ.isLoading ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">Carregando…</td></tr>
            ) : prog.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                Nenhum produto programado para {nomeLoja} — comece por “Adicionar produto”.
              </td></tr>
            ) : prog.map((p) => {
              const orig = num(p.preco_original);
              const desc = orig > 0 ? 1 - num(p.preco_promo) / orig : null;
              const alerta = orig > 0 && (num(p.preco_promo) >= orig || num(p.preco_promo) < orig * 0.5);
              return (
                <tr key={p.id} className={cn("border-b last:border-0", !p.ativo && "opacity-50")}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5 min-w-[260px]">
                      <Foto url={p.imagem} />
                      <div className="min-w-0">
                        <div className="truncate max-w-[340px] font-medium" title={p.item_nome ?? ""}>{p.item_nome ?? "—"}</div>
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
                        <span title={num(p.preco_promo) >= orig ? "Promo maior ou igual ao preço atual — o cron PULA este item" : "Promo abaixo de 50% do preço atual — o cron PULA este item (proteção contra dedo errado)"}>
                          <AlertTriangle className="h-3.5 w-3.5" style={{ color: AMBER }} />
                        </span>
                      )}
                      <CampoNum valor={num(p.preco_promo)} largura="w-[84px]"
                        onSalvar={(v) => void atualizarItem(p.id, { preco_promo: v }, "preço")} />
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-mono"
                    style={{ color: desc != null && desc > 0 ? GREEN : RED }}>
                    {desc != null ? `${(desc * 100).toFixed(0)}%` : "—"}
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
          {ativos.length} de {prog.length} item(ns) entram na relâmpago de amanhã · limite da Shopee: 50 itens ·
          estoque promo: 1–1000 · limite 0 = sem limite por comprador.
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
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                <span className="tabular-nums font-mono w-[86px]">{c.dia.split("-").reverse().join("/")}</span>
                <span className="px-1.5 py-0.5 rounded text-[11px] font-medium"
                  style={{
                    background: c.status === "ok" ? `${GREEN}18` : c.status === "parcial" ? `${AMBER}18` : `${RED}18`,
                    color: c.status === "ok" ? GREEN : c.status === "parcial" ? AMBER : RED,
                  }}>
                  {c.status === "ok" ? "criada + ativa" : c.status}
                </span>
                <span className="text-muted-foreground">{c.itens_ok} item(ns){c.itens_falha ? ` · ${c.itens_falha} falha(s)` : ""}</span>
                <span className="flex-1" />
                {c.flash_sale_id && <span className="text-[11px] text-muted-foreground font-mono">#{c.flash_sale_id}</span>}
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
          <li>Às <b>18h</b>, o cron cria a flash sale, adiciona os itens <b>ativos</b> desta lista com o preço apontado, ativa e registra aqui — e avisa no Discord.</li>
          <li>Uma por dia por loja: se a de amanhã já existe, o cron não cria de novo (sem duplicar).</li>
          <li>Proteção de preço: item com promo <b>maior/igual ao preço atual</b> ou <b>abaixo de 50%</b> dele é pulado e reportado.</li>
          <li>O botão “Programar amanhã agora” faz o mesmo na hora, com prévia — funciona mesmo com a automação desligada.</li>
          <li>Preço atual é o registrado quando o produto entrou na lista; se mudar o preço no Seller Center, ajuste aqui também.</li>
        </ul>
      </details>

      {/* Dialog prévia/confirmação */}
      <Dialog open={dlgPrev !== null} onOpenChange={(v) => { if (!v) setDlgPrev(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Programar relâmpago de {dlgPrev?.dia?.split("-").reverse().join("/")}</DialogTitle>
            <DialogDescription>
              Prévia do que será criado na {nomeLoja}. Confirmando, a promoção é criada e <b>ativada</b> na Shopee.
            </DialogDescription>
          </DialogHeader>
          {dlgPrev?.resultados.map((r: any, i: number) => (
            <div key={i} className="text-[13px] space-y-1.5">
              {r.status === "dry" ? (
                <>
                  <p><b>{r.itens}</b> produto(s) · <b>{r.modelos}</b> variação(ões) no slot de {r.dia}.</p>
                  {(r.pulados ?? []).length > 0 && (
                    <p className="text-[12px]" style={{ color: AMBER }}>
                      <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
                      {r.pulados.length} item(ns) pulado(s) pela proteção de preço: {r.pulados.map((x: any) => x.sku).join(", ")}
                    </p>
                  )}
                </>
              ) : r.status === "ja_criada" ? (
                <p>A relâmpago desse dia <b>já foi criada</b> (flash sale #{r.flash_sale_id}). Nada a fazer.</p>
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
              Criar e ativar
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
// Dialog de catálogo: pagina o modulo=catalogo (50/página) com filtro local.
// Adicionar grava na programação com promo = preço atual (edita depois na tabela).
// ============================================================================
function AdicionarProduto({ aberto, onFechar, shopId, jaProgramados, criadoPor, onAdicionou }: {
  aberto: boolean; onFechar: () => void; shopId: number;
  jaProgramados: Set<string>; criadoPor: string | null; onAdicionou: () => void;
}) {
  const [busca, setBusca] = useState("");
  const [paginas, setPaginas] = useState<CatalogoItem[][]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [carregando, setCarregando] = useState(false);
  const [salvandoKey, setSalvandoKey] = useState<string | null>(null);

  const carregandoRef = useRef(false);
  async function carregarPagina(offset: number, reset = false) {
    if (carregandoRef.current) return;
    carregandoRef.current = true;
    setCarregando(true);
    try {
      const r = await chamarFn(`modulo=catalogo&shop_id=${shopId}&offset=${offset}&limit=50`);
      if (r.error) throw new Error(r.message ?? r.error);
      setPaginas((p) => (reset ? [r.produtos ?? []] : [...p, r.produtos ?? []]));
      setNextOffset(r.tem_proxima ? r.next_offset : null);
    } catch (e) {
      toast.error("Falha ao carregar o catálogo", { description: (e as Error).message });
    } finally { carregandoRef.current = false; setCarregando(false); }
  }

  // primeira página ao abrir / trocar de loja
  useEffect(() => {
    if (!aberto) return;
    setPaginas([]); setNextOffset(0); setBusca("");
    void carregarPagina(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto, shopId]);

  const itens = useMemo(() => {
    const todos = paginas.flat();
    const q = busca.trim().toLowerCase();
    if (!q) return todos;
    return todos.filter((i) =>
      i.nome.toLowerCase().includes(q) || (i.item_sku ?? "").toLowerCase().includes(q) ||
      i.models.some((m) => (m.model_sku ?? "").toLowerCase().includes(q)));
  }, [paginas, busca]);

  async function adicionar(item: CatalogoItem, model: CatalogoModel | null) {
    const key = `${item.item_id}:${model?.model_id ?? 0}`;
    const preco = num(model?.preco ?? item.preco);
    if (preco <= 0) { toast.warning("Produto sem preço legível — adicione outro ou ajuste na Shopee."); return; }
    setSalvandoKey(key);
    try {
      const { error } = await supabaseExternal.from("flashsale_programacao").insert({
        shop_id: shopId, item_id: item.item_id, model_id: model?.model_id ?? 0,
        item_nome: item.nome, model_nome: model?.nome ?? null,
        sku: model?.model_sku ?? item.item_sku ?? null, imagem: item.imagem,
        preco_original: preco, preco_promo: preco, // promo começa = atual; edita na tabela
        criado_por: criadoPor,
      });
      if (error) throw error;
      toast.success(`"${item.nome.slice(0, 40)}" adicionado — ajuste o preço relâmpago na tabela`);
      onAdicionou();
    } catch (e) {
      toast.error("Falha ao adicionar", { description: (e as Error).message });
    } finally { setSalvandoKey(null); }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Adicionar produto à programação</DialogTitle>
          <DialogDescription>Catálogo da Shopee ({LOJAS.find((l) => l.shop_id === shopId)?.nome}) — o preço relâmpago você ajusta depois, na tabela.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-8 pl-8 text-sm" placeholder="Filtrar por nome ou SKU (nas páginas carregadas)"
            value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <div className="max-h-[420px] overflow-y-auto divide-y rounded-md border">
          {itens.length === 0 && !carregando && (
            <p className="text-sm text-muted-foreground p-4 text-center">Nada por aqui ainda.</p>
          )}
          {itens.map((item) => {
            const alvos: (CatalogoModel | null)[] = item.has_model && item.models.length > 0 ? item.models : [null];
            return alvos.map((m) => {
              const key = `${item.item_id}:${m?.model_id ?? 0}`;
              const ja = jaProgramados.has(key);
              const preco = num(m?.preco ?? item.preco);
              return (
                <div key={key} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
                  <Foto url={item.imagem} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate" title={item.nome}>{item.nome}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {(m?.model_sku ?? item.item_sku) || "sem SKU"}{m?.nome ? ` · var. ${m.nome}` : ""}
                      {" · "}estoque {num(m?.estoque ?? item.estoque)}
                    </div>
                  </div>
                  <span className="tabular-nums font-mono shrink-0">{preco > 0 ? formatBRL(preco) : "—"}</span>
                  <Button size="sm" variant={ja ? "ghost" : "outline"} className="h-7 text-xs shrink-0 w-[92px]"
                    disabled={ja || salvandoKey === key} onClick={() => void adicionar(item, m)}>
                    {salvandoKey === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : ja ? "Já na lista" : "Adicionar"}
                  </Button>
                </div>
              );
            });
          })}
        </div>
        <div className="flex justify-center">
          {nextOffset !== null && (
            <Button variant="outline" size="sm" className="h-8" disabled={carregando}
              onClick={() => void carregarPagina(nextOffset)}>
              {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Carregar mais produtos
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const Route = createFileRoute("/flash-sale")({
  component: FlashSalePage,
});
