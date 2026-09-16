import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Boxes, CheckCircle2, ChevronDown, ChevronRight, ListChecks, Loader2, MapPin,
  Package as PackageIcon, Printer, RotateCcw, Search,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/format";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";
import { acharLoteDaTag, imprimirIdentificadorApi } from "@/lib/identificador";
import { FAIXAS_PRAZO, faixaPrazo, nivelPrazo, PRAZO_ESTILO } from "@/lib/prazo";

// ============================================================================
// Separação de pedidos MULTI SKU (aba própria em /separacao, 16/set/2026).
// Fonte: view_separacao_multi_pedidos (1 linha por pedido multi na fila, com
// itens/foto/localização) e view_separacao_multi_picking (necessário × separado
// por SKU, só pedidos ainda SEM TAG). Dois modos:
//   • Por pedido: agrupa pedidos IGUAIS (mesma combinação sku×qtd); expandir
//     mostra os produtos e os pedidos; TAG nasce ao imprimir o grupo.
//   • Picking list: o separador informa quanto pegou de cada SKU (persistido
//     em separacao_multi_picking); só pedidos com TODOS os itens cobertos vão
//     para "liberados" e ganham TAG + etiqueta; o separado é abatido.
// A TAG vem da edge fn separacao-multi (mesma sequência/dedup do tag-lote).
// Impressão: Shopee por TAG e loja (dedup no servidor), ML pedido a pedido;
// identificadora da TAG por último (src/lib/identificador.ts).
// ============================================================================

interface ItemMulti {
  sku: string; nome: string | null; qtd: number; localizacao: string | null; foto: string | null;
}
interface PedidoMulti {
  separacao_id: number; tiny_pedido_id: number | null; venda_numero: string | null;
  numero_ecommerce: string | null; marca_canal: string | null; loja: string;
  tipo_envio: string | null; ordem_envio: number; qtd_skus: number; qtd_unidades: number;
  tag_lote: string | null; tag_lote_em: string | null; ship_by_date: string | null;
  dias_para_prazo: number | null; data_criacao: string | null; chave_combo: string;
  itens: ItemMulti[]; impressao_estado: string | null; impressa_em: string | null;
}
interface PickingRow {
  sku: string; nome: string | null; foto: string | null; localizacao: string | null;
  qtd_necessaria: number; pedidos: number; qtd_separada: number;
  separado_por: string | null; separado_em: string | null;
}
interface Impressora { printer_id: number; nome: string; computador: string; estado: string }

const STORAGE_PRINTER = "separacao.printerId";
const STORAGE_IDENT = "separacao.identificadorLote";
const STORAGE_MODO = "separacao.multi.modo";
type EstadoFiltro = "todos" | "sem_tag" | "com_tag" | "impressos" | "nao_impressos";
const ESTADOS: ReadonlyArray<readonly [EstadoFiltro, string]> = [
  ["todos", "Todos"], ["sem_tag", "Sem TAG"], ["com_tag", "Com TAG"], ["impressos", "Impressos"], ["nao_impressos", "Não impressos"],
];
// selo de prazo (mesma régua da fila): "3d atraso" / "vence hoje" / "amanhã" / "em N d"
function PrazoBadge({ dias, iso }: { dias: number | null; iso: string | null }) {
  const nivel = nivelPrazo(dias);
  if (!nivel) return <span className="text-muted-foreground">sem prazo</span>;
  const texto = dias! < 0 ? `${-dias!}d atraso` : dias === 0 ? "vence hoje" : dias === 1 ? "amanhã" : `em ${dias} d`;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold tabular-nums whitespace-nowrap", PRAZO_ESTILO[nivel])}
      title={iso ? `Prazo de envio ${ddmm(iso)}` : ""}>
      {texto}{iso ? <span className="font-normal opacity-80">· {ddmm(iso)}</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------- helpers
function lojaDeMarca(m: string | null): "ottz" | "svl" | null {
  const s = (m ?? "").toLowerCase();
  if (s.includes("tiktok") || s.includes("mercado")) return null;
  if (s.includes("ottz") || s.includes("acz")) return "ottz";
  if (s.includes("svl") || s.includes("sevilla") || s.includes("bumi")) return "svl";
  return null;
}
const ehMl = (m: string | null) => (m ?? "").toLowerCase().includes("mercado");
const mlContaIntegrada = (m: string | null) => {
  const s = (m ?? "").toLowerCase();
  return !(s.includes("svl") || s.includes("sevilla") || s.includes("bumi"));
};
const impressa = (p: PedidoMulti) => p.impressao_estado === "done" || p.impressao_estado === "forcado";
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// prioridade: ER antes de SPX antes de ML; prazo mais próximo; mais antigo
function porPrioridade(a: PedidoMulti, b: PedidoMulti): number {
  if (a.ordem_envio !== b.ordem_envio) return a.ordem_envio - b.ordem_envio;
  const da = a.dias_para_prazo ?? 999, db = b.dias_para_prazo ?? 999;
  if (da !== db) return da - db;
  return (a.data_criacao ?? "").localeCompare(b.data_criacao ?? "");
}
function descricaoCombo(itens: ItemMulti[]): string {
  return itens.map((i) => `${i.sku} ×${formatNumber(i.qtd)}`).join(" + ");
}

const HEADERS = { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` };

async function aplicarTagMulti(separacaoIds: number[], grupo: string): Promise<{ tag: string; separacao_ids: number[]; pulados: number }> {
  const resp = await fetch(`${EXTERNAL_URL}/functions/v1/separacao-multi?modulo=tag`, {
    method: "POST", headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ separacao_ids: separacaoIds, grupo }),
  });
  const d = (await resp.json().catch(() => ({}))) as { erro?: string; tag?: string; separacao_ids?: number[]; pedidos_pulados?: number };
  if (!resp.ok || d.erro || !d.tag) throw new Error(d.erro ?? `HTTP ${resp.status}`);
  return { tag: d.tag, separacao_ids: d.separacao_ids ?? [], pulados: d.pedidos_pulados ?? 0 };
}

async function imprimirLoteShopee(loja: "ottz" | "svl", tag: string, printerId: number, forcar = false): Promise<{ enviadas: number; jaPulados: number }> {
  const url = `${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=imprimir&loja=${loja}&tag=${encodeURIComponent(tag)}&printer_id=${printerId}${forcar ? "&forcar=1" : ""}`;
  const resp = await fetch(url, { headers: HEADERS });
  const d = (await resp.json().catch(() => ({}))) as {
    erro?: string; etiquetas_enviadas?: number; etiquetas_prontas?: number; pedidos_no_lote?: number; ja_impressos_pulados?: number; aviso?: string | null;
  };
  if (!resp.ok || d.erro) {
    toast.error(`Falha ao imprimir TAG ${tag} (${loja === "ottz" ? "Ottz" : "Bumi"})`, { description: d.erro ?? `HTTP ${resp.status}` });
    return { enviadas: 0, jaPulados: 0 };
  }
  if ((d.etiquetas_prontas ?? 0) < (d.pedidos_no_lote ?? 0)) {
    toast.warning(`TAG ${tag}: ${d.etiquetas_enviadas ?? 0} de ${d.pedidos_no_lote} etiquetas`, {
      description: d.aviso ?? "Alguns pedidos não tinham etiqueta pronta na Shopee.", duration: 10000,
    });
  }
  return { enviadas: d.etiquetas_enviadas ?? 0, jaPulados: d.ja_impressos_pulados ?? 0 };
}

async function imprimirPedidoMl(orderId: string, printerId: number): Promise<boolean> {
  const url = `${EXTERNAL_URL}/functions/v1/ml-etiqueta?modulo=imprimir&order_id=${encodeURIComponent(orderId)}&printer_id=${printerId}`;
  const resp = await fetch(url, { headers: HEADERS });
  const d = (await resp.json().catch(() => ({}))) as { erro?: string; enviado?: boolean; liberado?: boolean; motivo?: string; dica?: string; status?: string };
  if (resp.status === 409 || d.liberado === false) {
    toast.warning(`ML ${orderId}: envio ainda não liberado`, { description: d.dica ?? d.motivo ?? `status ${d.status ?? "?"}`, duration: 10000 });
    return false;
  }
  if (!resp.ok || d.erro) { toast.error(`Falha ao imprimir ML ${orderId}`, { description: d.erro ?? `HTTP ${resp.status}` }); return false; }
  if (d.enviado === false) { toast.warning(`ML ${orderId}: não foi para a impressora`, { description: d.motivo ?? "" }); return false; }
  return true;
}

async function embalarUmApi(separacaoId: number): Promise<void> {
  const resp = await fetch(`${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=embalar-um&separacao_id=${separacaoId}&confirmar=1`, { headers: HEADERS });
  if (!resp.ok) {
    const d = (await resp.json().catch(() => ({}))) as { erro?: string; error?: string; message?: string };
    throw new Error(d.erro ?? d.error ?? d.message ?? `HTTP ${resp.status}`);
  }
}

async function aguardarImpressora(onTick: (impressas: number, pendentes: number) => void, cancelado: () => boolean, maxMs = 120_000) {
  const inicio = Date.now();
  let impressas = 0;
  while (Date.now() - inicio < maxMs && !cancelado()) {
    try {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=confirmar-impressao`, { headers: HEADERS });
      const d = (await resp.json().catch(() => ({}))) as { jobs_done?: number; jobs_ainda_sent?: number };
      impressas += d.jobs_done ?? 0;
      const pendentes = d.jobs_ainda_sent ?? 0;
      onTick(impressas, pendentes);
      if (pendentes === 0) return;
    } catch { /* tenta de novo */ }
    await sleep(4000);
  }
}

function useImpressoras() {
  return useQuery({
    queryKey: ["separacao", "impressoras"],
    queryFn: async () => {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras`, { headers: HEADERS });
      const data = (await resp.json().catch(() => ({}))) as { impressoras?: Impressora[] };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (data.impressoras ?? []).filter((p) => (p.nome ?? "").toLowerCase().includes("zd220"));
    },
    refetchInterval: 60_000,
  });
}

// ============================================================================
export function MultiSkuPanel() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const { data: impressoras } = useImpressoras();
  const [printerId, setPrinterId] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(STORAGE_PRINTER)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
  });
  useEffect(() => { try { if (printerId > 0) localStorage.setItem(STORAGE_PRINTER, String(printerId)); } catch { /* noop */ } }, [printerId]);
  const impressora = impressoras?.find((p) => p.printer_id === printerId);
  const identOn = (() => { try { const v = localStorage.getItem(STORAGE_IDENT); return v === null ? true : v === "1"; } catch { return true; } })();

  const [modo, setModo] = useState<"pedido" | "picking">(() => {
    try { return localStorage.getItem(STORAGE_MODO) === "picking" ? "picking" : "pedido"; } catch { return "pedido"; }
  });
  useEffect(() => { try { localStorage.setItem(STORAGE_MODO, modo); } catch { /* noop */ } }, [modo]);
  const [busca, setBusca] = useState("");
  // filtros (valem nos dois modos; no picking limitam o que entra na lista)
  const [envios, setEnvios] = useState<string[] | null>(null);        // null = todos
  const [empresa, setEmpresa] = useState<"todas" | "Ottz" | "Bumi" | "ML">("todas");
  const [prazoFiltro, setPrazoFiltro] = useState<string[]>([]);       // faixas (vazio = todas)
  const [estado, setEstado] = useState<EstadoFiltro>("todos");
  const filtrosAtivos = envios !== null || empresa !== "todas" || prazoFiltro.length > 0 || estado !== "todos" || busca.trim() !== "";
  const limparFiltros = () => { setEnvios(null); setEmpresa("todas"); setPrazoFiltro([]); setEstado("todos"); setBusca(""); };
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  const [pedidosAbertos, setPedidosAbertos] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set()); // chaves de combinação selecionadas

  // progresso (mesma barra da fila): enviando → impressora → concluído
  const [prog, setProg] = useState<{ etapa: string; etiquetas: number; fase: "enviando" | "impressora" | "concluido"; impressas?: number; pendentes?: number } | null>(null);
  const [embalando, setEmbalando] = useState<{ atual: number; total: number } | null>(null);
  const fecharRef = useRef(false);
  const ocupado = prog !== null || embalando !== null;

  const q = useQuery({
    queryKey: ["separacao", "multi", "pedidos"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<PedidoMulti[]> => {
      const { data, error } = await supabaseExternal.from("view_separacao_multi_pedidos").select("*").limit(2000);
      if (error) throw error;
      return ((data ?? []) as PedidoMulti[]).map((p) => ({ ...p, itens: (p.itens ?? []) as ItemMulti[] })).sort(porPrioridade);
    },
  });
  const pickingQ = useQuery({
    queryKey: ["separacao", "multi", "picking"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<PickingRow[]> => {
      const { data, error } = await supabaseExternal.from("view_separacao_multi_picking").select("*").order("localizacao").limit(2000);
      if (error) throw error;
      return (data ?? []) as PickingRow[];
    },
  });
  const pedidos = q.data ?? [];
  const pickingBase = pickingQ.data ?? [];
  const invalidar = () => {
    void qc.invalidateQueries({ queryKey: ["separacao", "multi"] });
    void qc.invalidateQueries({ queryKey: ["separacao"] });
  };

  const enviosDisponiveis = useMemo(() => Array.from(new Set(pedidos.map((p) => p.tipo_envio ?? "?"))).sort((a, b) => {
    const o = (e: string) => (e === "ER" ? 1 : e === "SPX" ? 2 : e === "ML" ? 3 : 4); return o(a) - o(b) || a.localeCompare(b);
  }), [pedidos]);
  const faixasDisponiveis = useMemo(() => new Set(pedidos.map((p) => faixaPrazo(p.dias_para_prazo))), [pedidos]);

  const filtrados = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return pedidos.filter((p) => {
      if (envios && !envios.includes(p.tipo_envio ?? "?")) return false;
      if (empresa !== "todas" && p.loja !== empresa) return false;
      if (prazoFiltro.length > 0 && !prazoFiltro.includes(faixaPrazo(p.dias_para_prazo))) return false;
      if (estado === "sem_tag" && p.tag_lote) return false;
      if (estado === "com_tag" && !p.tag_lote) return false;
      if (estado === "impressos" && !impressa(p)) return false;
      if (estado === "nao_impressos" && impressa(p)) return false;
      if (t && !(
        (p.venda_numero ?? "").toLowerCase().includes(t) || (p.numero_ecommerce ?? "").toLowerCase().includes(t) ||
        (p.tag_lote ?? "").toLowerCase().includes(t) || p.itens.some((i) => i.sku.toLowerCase().includes(t) || (i.nome ?? "").toLowerCase().includes(t)))) return false;
      return true;
    });
  }, [pedidos, busca, envios, empresa, prazoFiltro, estado]);

  // picking respeita os filtros: o necessário é recalculado só com os pedidos
  // SEM TAG que passaram no filtro (ex.: "só Entrega Rápida de hoje"); o
  // separado (persistido) vem da tabela, por SKU.
  const picking = useMemo(() => {
    const need = new Map<string, { qtd: number; pedidos: Set<number> }>();
    for (const p of filtrados) {
      if (p.tag_lote) continue;
      for (const i of p.itens) {
        const e = need.get(i.sku) ?? { qtd: 0, pedidos: new Set<number>() };
        e.qtd += i.qtd; e.pedidos.add(p.separacao_id); need.set(i.sku, e);
      }
    }
    const porSku = new Map(pickingBase.map((r) => [r.sku, r]));
    const linhas: PickingRow[] = [];
    for (const [sku, e] of need.entries()) {
      const b = porSku.get(sku);
      const item = filtrados.flatMap((p) => p.itens).find((i) => i.sku === sku);
      linhas.push({
        sku, nome: b?.nome ?? item?.nome ?? null, foto: b?.foto ?? item?.foto ?? null, localizacao: b?.localizacao ?? item?.localizacao ?? null,
        qtd_necessaria: e.qtd, pedidos: e.pedidos.size, qtd_separada: Number(b?.qtd_separada ?? 0),
        separado_por: b?.separado_por ?? null, separado_em: b?.separado_em ?? null,
      });
    }
    return linhas.sort((a, b) => (a.localizacao ?? "~").localeCompare(b.localizacao ?? "~") || a.sku.localeCompare(b.sku));
  }, [filtrados, pickingBase]);

  // grupos de pedidos IGUAIS (mesma combinação sku×qtd), na ordem de prioridade
  const grupos = useMemo(() => {
    const m = new Map<string, PedidoMulti[]>();
    for (const p of filtrados) { const l = m.get(p.chave_combo) ?? []; l.push(p); m.set(p.chave_combo, l); }
    return Array.from(m.entries()).map(([chave, peds]) => ({ chave, peds: peds.sort(porPrioridade), itens: peds[0].itens }))
      .sort((a, b) => porPrioridade(a.peds[0], b.peds[0]) || b.peds.length - a.peds.length);
  }, [filtrados]);

  const resumo = useMemo(() => ({
    pedidos: pedidos.length, combos: new Set(pedidos.map((p) => p.chave_combo)).size,
    unidades: pedidos.reduce((s, p) => s + Number(p.qtd_unidades ?? 0), 0),
    semTag: pedidos.filter((p) => !p.tag_lote).length,
    impressos: pedidos.filter(impressa).length,
  }), [pedidos]);

  // ---------------------------------------------------------------- picking: alocação
  // Greedy por prioridade: um pedido só é liberado se TODOS os seus itens cabem
  // no que ainda resta separado; ao liberar, consome. Quem não cabe não consome.
  const alocacao = useMemo(() => {
    const restante = new Map<string, number>(picking.map((r) => [r.sku, Number(r.qtd_separada ?? 0)]));
    const pendentes = filtrados.filter((p) => !p.tag_lote).sort(porPrioridade);
    const liberados: PedidoMulti[] = [];
    const faltando: { p: PedidoMulti; faltas: { sku: string; falta: number }[] }[] = [];
    for (const p of pendentes) {
      const faltas = p.itens.map((i) => ({ sku: i.sku, falta: i.qtd - (restante.get(i.sku) ?? 0) })).filter((f) => f.falta > 0);
      if (faltas.length === 0) {
        for (const i of p.itens) restante.set(i.sku, (restante.get(i.sku) ?? 0) - i.qtd);
        liberados.push(p);
      } else faltando.push({ p, faltas });
    }
    return { liberados, faltando, sobra: restante };
  }, [filtrados, picking]);

  // ---------------------------------------------------------------- impressão
  /** Imprime as etiquetas dos pedidos (todos com TAG): Shopee por TAG e loja, ML por pedido, identificadora por TAG no fim. */
  async function imprimirComTag(peds: PedidoMulti[], opts?: { forcar?: boolean }): Promise<number> {
    const porTag = new Map<string, PedidoMulti[]>();
    for (const p of peds) { if (!p.tag_lote) continue; const l = porTag.get(p.tag_lote) ?? []; l.push(p); porTag.set(p.tag_lote, l); }
    let total = 0;
    for (const [tag, lista] of porTag.entries()) {
      let loteImpresso = false;
      const lojas = Array.from(new Set(lista.map((p) => lojaDeMarca(p.marca_canal)).filter((l): l is "ottz" | "svl" => !!l)));
      for (const loja of lojas) {
        setProg((pr) => ({ etapa: `${tag} · ${loja === "ottz" ? "Ottz" : "Bumi"}`, etiquetas: pr?.etiquetas ?? 0, fase: "enviando" }));
        const { enviadas, jaPulados } = await imprimirLoteShopee(loja, tag, printerId, !!opts?.forcar);
        total += enviadas;
        if (enviadas > 0 || jaPulados > 0) loteImpresso = true;
        setProg((pr) => ({ etapa: `${tag} · ${loja === "ottz" ? "Ottz" : "Bumi"}`, etiquetas: (pr?.etiquetas ?? 0) + enviadas, fase: "enviando" }));
        if (enviadas > 0) {
          void registrarSeparacaoLog({ evento: "etiqueta_impressa", usuario: perfil?.nome ?? null, tag, detalhe: { via: "multi", loja, enviadas, jaPulados, forcar: !!opts?.forcar } });
        }
      }
      const doMl = lista.filter((p) => ehMl(p.marca_canal) && p.numero_ecommerce);
      if (doMl.length > 0) {
        setProg((pr) => ({ etapa: `${tag} · ML`, etiquetas: pr?.etiquetas ?? 0, fase: "enviando" }));
        let semConta = 0;
        for (const p of doMl) {
          if (!mlContaIntegrada(p.marca_canal)) { semConta++; continue; }
          if (!opts?.forcar && impressa(p)) continue; // regra de ouro: ML já impresso não sai de novo
          if (await imprimirPedidoMl(p.numero_ecommerce as string, printerId)) {
            total++; loteImpresso = true;
            setProg((pr) => ({ etapa: `${tag} · ML`, etiquetas: (pr?.etiquetas ?? 0) + 1, fase: "enviando" }));
            void registrarSeparacaoLog({ evento: "etiqueta_impressa", usuario: perfil?.nome ?? null, tag, order_sn: p.numero_ecommerce, separacao_id: p.separacao_id, detalhe: { via: "multi-ml", forcar: !!opts?.forcar } });
          }
        }
        if (semConta > 0) toast.warning(`${semConta} pedido(s) da conta SVL do ML não saem pelo app`, { duration: 8000 });
      }
      if (identOn && loteImpresso) {
        const lote = await acharLoteDaTag(tag, undefined);
        if (lote) await imprimirIdentificadorApi(lote, printerId, opts?.forcar ? {} : { auto: true });
        else toast.warning(`Identificadora da TAG ${tag} não saiu`, { description: "Lote não encontrado." });
      }
    }
    return total;
  }

  /** Aplica TAG (se faltar) e imprime. `grupo` rotula a TAG em tags_lote. */
  async function tagEImprimir(peds: PedidoMulti[], grupo: string, opts?: { forcar?: boolean }) {
    if (!printerId) { toast.warning("Escolha a impressora primeiro."); return; }
    if (ocupado || peds.length === 0) return;
    if (impressora?.estado === "offline" && !window.confirm("Impressora offline. O job pode ficar preso na fila. Continuar?")) return;
    fecharRef.current = false;
    setProg({ etapa: "TAG", etiquetas: 0, fase: "enviando" });
    try {
      let lista = peds;
      const semTag = peds.filter((p) => !p.tag_lote);
      if (semTag.length > 0) {
        const r = await aplicarTagMulti(semTag.map((p) => p.separacao_id), grupo);
        toast.success(`TAG ${r.tag} aplicada em ${r.separacao_ids.length} pedido(s)`, { description: r.pulados > 0 ? `${r.pulados} pulado(s): já tinham TAG hoje` : grupo });
        const ok = new Set(r.separacao_ids);
        lista = peds.map((p) => (ok.has(p.separacao_id) ? { ...p, tag_lote: r.tag } : p));
        void registrarSeparacaoLog({ evento: "tag_aplicada", usuario: perfil?.nome ?? null, tag: r.tag, detalhe: { via: "multi", grupo, pedidos: r.separacao_ids.length } });
      }
      const n = await imprimirComTag(lista.filter((p) => p.tag_lote), opts);
      if (n > 0) {
        setProg((pr) => ({ ...(pr ?? { etapa: "", etiquetas: n }), fase: "impressora", impressas: 0, pendentes: n }));
        await aguardarImpressora(
          (impressas, pendentes) => setProg((pr) => (pr ? { ...pr, fase: pendentes === 0 ? "concluido" : "impressora", impressas, pendentes } : pr)),
          () => fecharRef.current,
        );
        if (!fecharRef.current) await sleep(2000);
      } else {
        toast.info("Nenhuma etiqueta nova enviada", { description: "Já impressas (proteção) ou ainda sem etiqueta pronta." });
      }
    } catch (e) {
      toast.error("Falha", { description: (e as Error).message });
    } finally {
      setProg(null);
      setSel(new Set());
      invalidar();
    }
  }

  async function imprimirUmPedido(p: PedidoMulti) {
    if (impressa(p) && !window.confirm(`A etiqueta do pedido ${p.venda_numero} já saiu (${hhmm(p.impressa_em)}). Reimprimir mesmo assim? Etiqueta em dobro no pacote gera extravio.`)) return;
    await tagEImprimir([p], `MULTI · ${descricaoCombo(p.itens)}`, { forcar: impressa(p) });
  }

  // ---------------------------------------------------------------- embalar
  async function marcarEmbalado(peds: PedidoMulti[]) {
    const alvo = peds.filter(impressa);
    const pulados = peds.length - alvo.length;
    if (alvo.length === 0) { toast.info("Nada a embalar", { description: "Só pedidos com etiqueta impressa e confirmada podem ser embalados." }); return; }
    if (!window.confirm(`Marcar ${alvo.length} pedido(s) como EMBALADOS no Tiny?${pulados > 0 ? `\n${pulados} ficam de fora (etiqueta ainda não impressa).` : ""}`)) return;
    let ok = 0, erros = 0;
    try {
      for (let i = 0; i < alvo.length; i++) {
        setEmbalando({ atual: i + 1, total: alvo.length });
        const p = alvo[i];
        try {
          await embalarUmApi(p.separacao_id); ok++;
          void registrarSeparacaoLog({ evento: "embalado", usuario: perfil?.nome ?? null, order_sn: p.numero_ecommerce, separacao_id: p.separacao_id, tag: p.tag_lote, detalhe: { via: "multi", forcado: false } });
        } catch (e) { erros++; toast.error(`Falha ao embalar ${p.venda_numero}`, { description: (e as Error).message }); }
      }
    } finally { setEmbalando(null); invalidar(); }
    toast[erros > 0 ? "warning" : "success"](`${ok} pedido(s) embalados${erros > 0 ? ` · ${erros} erro(s)` : ""}`);
  }

  // ---------------------------------------------------------------- picking: gravar
  const [editando, setEditando] = useState<Record<string, string>>({});
  async function salvarSeparado(sku: string, valor: number) {
    const v = Math.max(0, Number.isFinite(valor) ? valor : 0);
    const { error } = await supabaseExternal.from("separacao_multi_picking").upsert(
      { sku, qtd_separada: v, atualizado_por: perfil?.nome ?? null, atualizado_em: new Date().toISOString() }, { onConflict: "sku" });
    if (error) { toast.error("Falha ao gravar", { description: error.message }); return; }
    setEditando((e) => { const n = { ...e }; delete n[sku]; return n; });
    void qc.invalidateQueries({ queryKey: ["separacao", "multi", "picking"] });
  }
  async function marcarTudoSeparado() {
    if (!window.confirm(`Marcar TODOS os ${picking.length} SKUs como totalmente separados?`)) return;
    const { error } = await supabaseExternal.from("separacao_multi_picking").upsert(
      picking.map((r) => ({ sku: r.sku, qtd_separada: Math.max(Number(r.qtd_necessaria), Number(r.qtd_separada)), atualizado_por: perfil?.nome ?? null, atualizado_em: new Date().toISOString() })), { onConflict: "sku" });
    if (error) { toast.error("Falha", { description: error.message }); return; }
    void qc.invalidateQueries({ queryKey: ["separacao", "multi", "picking"] });
  }
  async function zerarPicking() {
    if (!window.confirm("Zerar o picking (todas as quantidades separadas voltam a 0)?")) return;
    const { error } = await supabaseExternal.from("separacao_multi_picking").delete().neq("sku", "");
    if (error) { toast.error("Falha", { description: error.message }); return; }
    void qc.invalidateQueries({ queryKey: ["separacao", "multi", "picking"] });
  }
  /** Libera os pedidos cobertos pelo picking: TAG + etiquetas; abate o separado. */
  async function liberarEImprimir() {
    const lib = alocacao.liberados;
    if (lib.length === 0) return;
    if (!window.confirm(`Liberar ${lib.length} pedido(s) cobertos pelo picking: aplicar TAG, imprimir as etiquetas e abater as quantidades separadas?`)) return;
    // abate ANTES de imprimir (o que sobra continua separado para os próximos)
    const consumo = new Map<string, number>();
    for (const p of lib) for (const i of p.itens) consumo.set(i.sku, (consumo.get(i.sku) ?? 0) + i.qtd);
    const linhas = pickingBase.filter((r) => consumo.has(r.sku)).map((r) => ({
      sku: r.sku, qtd_separada: Math.max(0, Number(r.qtd_separada) - (consumo.get(r.sku) ?? 0)),
      atualizado_por: perfil?.nome ?? null, atualizado_em: new Date().toISOString(),
    }));
    if (linhas.length > 0) {
      const { error } = await supabaseExternal.from("separacao_multi_picking").upsert(linhas, { onConflict: "sku" });
      if (error) { toast.error("Falha ao abater o picking — nada foi impresso", { description: error.message }); return; }
    }
    await tagEImprimir(lib, "MULTI · picking");
  }

  const selecionados = useMemo(() => grupos.filter((g) => sel.has(g.chave)).flatMap((g) => g.peds), [grupos, sel]);
  const toggleAberto = (k: string) => setAbertos((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const togglePedido = (id: number) => setPedidosAbertos((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ================================================================ render
  return (
    <div className="space-y-4">
      {/* cabeçalho */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border bg-card p-0.5">
            <button onClick={() => setModo("pedido")} className={cn("px-3 py-1.5 text-xs font-semibold rounded-md transition flex items-center gap-1.5", modo === "pedido" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Boxes className="h-3.5 w-3.5" /> Por pedido
            </button>
            <button onClick={() => setModo("picking")} className={cn("px-3 py-1.5 text-xs font-semibold rounded-md transition flex items-center gap-1.5", modo === "picking" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              <ListChecks className="h-3.5 w-3.5" /> Picking list
            </button>
          </div>
          <div className="text-[12.5px] text-muted-foreground">
            <b className="text-foreground">{formatNumber(resumo.pedidos)}</b> pedidos · {formatNumber(resumo.combos)} combinações · {formatNumber(resumo.unidades)} un ·{" "}
            {formatNumber(resumo.semTag)} sem TAG · {formatNumber(resumo.impressos)} impressos
            {filtrosAtivos && <> · <b className="text-foreground">{formatNumber(filtrados.length)}</b> no filtro</>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input className="h-9 pl-8 text-sm bg-card w-[220px]" placeholder="Pedido, TAG, SKU ou nome" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
          <Select value={printerId ? String(printerId) : ""} onValueChange={(v) => setPrinterId(Number(v))}>
            <SelectTrigger className={cn("h-9 w-[240px] text-sm bg-card", impressora?.estado === "offline" && "border-destructive text-destructive")}>
              <Printer className="h-3.5 w-3.5 mr-1 shrink-0" /><SelectValue placeholder="Impressora (Zebra)" />
            </SelectTrigger>
            <SelectContent>
              {(impressoras ?? []).map((p) => (
                <SelectItem key={p.printer_id} value={String(p.printer_id)}>{p.nome} · {p.computador}{p.estado === "offline" ? " · OFFLINE" : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* filtros */}
      {pedidos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border bg-card p-0.5">
            <button onClick={() => setEnvios(null)} className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition", envios === null ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>Todos envios</button>
            {enviosDisponiveis.map((e) => {
              const n = pedidos.filter((p) => (p.tipo_envio ?? "?") === e).length;
              const on = envios?.includes(e) ?? false;
              return (
                <button key={e} title="Clique isola o envio; Ctrl+clique soma"
                  onClick={(ev) => {
                    if (ev.ctrlKey || ev.metaKey) { const base = envios ?? enviosDisponiveis; setEnvios(base.includes(e) ? base.filter((x) => x !== e) : [...base, e]); }
                    else setEnvios(envios && envios.length === 1 && envios[0] === e ? null : [e]);
                  }}
                  className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition", on ? (e === "ER" ? "bg-red-600 text-white" : "bg-accent text-accent-foreground") : "text-muted-foreground hover:text-foreground")}>
                  {e} <span className="opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="inline-flex rounded-lg border bg-card p-0.5">
            {([["todas", "Todas"], ["Ottz", "Ottz"], ["Bumi", "Bumi"], ["ML", "ML"]] as const).map(([id, rot]) => (
              <button key={id} onClick={() => setEmpresa(id)} className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition", empresa === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>{rot}</button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border bg-card p-0.5" title="Prazo de envio — marque mais de uma faixa">
            {FAIXAS_PRAZO.filter((f) => faixasDisponiveis.has(f.id)).map((f) => {
              const n = pedidos.filter((p) => faixaPrazo(p.dias_para_prazo) === f.id).length;
              const on = prazoFiltro.includes(f.id);
              return (
                <button key={f.id} onClick={() => setPrazoFiltro((cur) => (cur.includes(f.id) ? cur.filter((x) => x !== f.id) : [...cur, f.id]))}
                  className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition", on ? (f.id === "vencidos" ? "bg-red-600 text-white" : f.id === "0" ? "bg-orange-600 text-white" : "bg-accent text-accent-foreground") : "text-muted-foreground hover:text-foreground")}>
                  {f.label} <span className="opacity-70">{n}</span>
                </button>
              );
            })}
          </div>
          <div className="inline-flex rounded-lg border bg-card p-0.5">
            {ESTADOS.map(([id, rot]) => (
              <button key={id} onClick={() => setEstado(id)} className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition", estado === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>{rot}</button>
            ))}
          </div>
          {filtrosAtivos && <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={limparFiltros}>Limpar filtros</Button>}
        </div>
      )}

      {q.isLoading ? (
        <Card className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</Card>
      ) : pedidos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum pedido multi-SKU na fila. 🎉</Card>
      ) : filtrados.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">Nenhum pedido com esses filtros. <button className="underline" onClick={limparFiltros}>Limpar filtros</button></Card>
      ) : modo === "pedido" ? (
        // ============================================================ POR PEDIDO
        <div className="space-y-2">
          {grupos.map((g) => {
            const aberto = abertos.has(g.chave);
            const tags = Array.from(new Set(g.peds.map((p) => p.tag_lote).filter(Boolean))) as string[];
            const nImp = g.peds.filter(impressa).length;
            const envios = Array.from(new Set(g.peds.map((p) => p.tipo_envio ?? "?")));
            return (
              <Card key={g.chave} className={cn("border-purple-300/60 dark:border-purple-900/60", sel.has(g.chave) && "ring-2 ring-primary/40")}>
                <div className="p-3 flex items-center gap-3">
                  <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer shrink-0" checked={sel.has(g.chave)}
                    onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(g.chave); else n.delete(g.chave); return n; })} />
                  <button className="flex items-center gap-2 min-w-0 flex-1 text-left" onClick={() => toggleAberto(g.chave)}>
                    {aberto ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <div className="flex -space-x-2 shrink-0">
                      {g.itens.slice(0, 4).map((i) => i.foto
                        ? <img key={i.sku} src={i.foto} alt="" className="w-9 h-9 rounded-md object-cover border bg-muted" />
                        : <div key={i.sku} className="w-9 h-9 rounded-md border bg-muted flex items-center justify-center"><PackageIcon className="h-4 w-4 text-muted-foreground" /></div>)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">{descricaoCombo(g.itens)}</div>
                      <div className="text-[11.5px] text-muted-foreground truncate">
                        {g.itens.map((i) => i.nome ?? i.sku).join(" + ")}
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0 text-[11.5px]">
                    <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300 font-semibold">{g.peds.length} pedido(s)</span>
                    {envios.map((e) => <span key={e} className="px-2 py-0.5 rounded-full bg-muted font-semibold">{e}</span>)}
                    {(() => {
                      const comPrazo = g.peds.filter((p) => p.dias_para_prazo != null);
                      if (comPrazo.length === 0) return null;
                      const m = comPrazo.reduce((a, b) => ((a.dias_para_prazo ?? 999) <= (b.dias_para_prazo ?? 999) ? a : b));
                      return <PrazoBadge dias={m.dias_para_prazo} iso={m.ship_by_date} />;
                    })()}
                    {tags.map((t) => <span key={t} className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 font-mono font-semibold">{t}</span>)}
                    {nImp > 0 && <span className="text-muted-foreground">{nImp}/{g.peds.length} impressos</span>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button size="sm" className="h-8 gap-1.5" disabled={ocupado} title="Aplica a TAG (se faltar) e imprime as etiquetas dos pedidos deste grupo"
                      onClick={() => void tagEImprimir(g.peds, `MULTI · ${descricaoCombo(g.itens)}`)}>
                      <Printer className="h-3.5 w-3.5" /> Imprimir etiquetas
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={ocupado || nImp === 0} title="Marca embalado no Tiny os pedidos deste grupo com etiqueta impressa"
                      onClick={() => void marcarEmbalado(g.peds)}>
                      <PackageIcon className="h-3.5 w-3.5" /> Embalar ({nImp})
                    </Button>
                  </div>
                </div>
                {aberto && (
                  <div className="border-t px-3 pb-3 pt-2 space-y-3">
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {g.itens.map((i) => (
                        <div key={i.sku} className="flex items-center gap-2 rounded-md border p-2 bg-muted/30">
                          {i.foto ? <img src={i.foto} alt="" className="w-12 h-12 rounded-md object-cover border bg-muted shrink-0" />
                            : <div className="w-12 h-12 rounded-md border bg-muted flex items-center justify-center shrink-0"><PackageIcon className="h-5 w-5 text-muted-foreground" /></div>}
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-medium truncate">{i.nome ?? i.sku}</div>
                            <div className="text-[11px] text-muted-foreground font-mono">{i.sku} · <b className="text-foreground">×{formatNumber(i.qtd)}</b>{i.localizacao ? <> · <MapPin className="inline h-3 w-3" /> {i.localizacao}</> : null}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <table className="w-full text-[12.5px]">
                      <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        <tr><th className="text-left py-1">Pedido</th><th className="text-left">Loja</th><th className="text-left">Envio</th><th className="text-left">Prazo</th><th className="text-left">TAG</th><th className="text-left">Etiqueta</th><th className="text-right">Ação</th></tr>
                      </thead>
                      <tbody>
                        {g.peds.map((p) => (
                          <tr key={p.separacao_id} className="border-t border-border/60">
                            <td className="py-1.5">
                              <button className="font-mono font-semibold hover:underline" onClick={() => togglePedido(p.separacao_id)} title={p.numero_ecommerce ?? ""}>#{p.venda_numero}</button>
                              {pedidosAbertos.has(p.separacao_id) && <div className="text-[11px] text-muted-foreground font-mono">{p.numero_ecommerce}</div>}
                            </td>
                            <td>{p.loja}</td>
                            <td>{p.tipo_envio ?? "—"}</td>
                            <td><PrazoBadge dias={p.dias_para_prazo} iso={p.ship_by_date} /></td>
                            <td className="font-mono">{p.tag_lote ?? "—"}</td>
                            <td>
                              {impressa(p) ? <span className="text-emerald-700 dark:text-emerald-400 font-semibold">impressa {hhmm(p.impressa_em)}</span>
                                : p.impressao_estado === "sent" ? <span className="text-amber-700">enviada</span>
                                : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={ocupado} onClick={() => void imprimirUmPedido(p)}>
                                <Printer className="h-3 w-3" /> {impressa(p) ? "Reimprimir" : "Imprimir"}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={ocupado || !impressa(p)} onClick={() => void marcarEmbalado([p])}>
                                <PackageIcon className="h-3 w-3" /> Embalado
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      ) : (
        // ============================================================ PICKING LIST
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
          <Card className="overflow-hidden">
            <div className="p-3 flex flex-wrap items-center justify-between gap-2 border-b">
              <div className="text-sm font-semibold">Picking list — {formatNumber(picking.length)} SKUs · {formatNumber(picking.reduce((s, r) => s + Number(r.qtd_necessaria), 0))} un a separar (pedidos sem TAG{filtrosAtivos ? ", no filtro" : ""})</div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-8" onClick={() => void marcarTudoSeparado()} disabled={picking.length === 0}>Marcar tudo separado</Button>
                <Button size="sm" variant="ghost" className="h-8 gap-1" onClick={() => void zerarPicking()} disabled={picking.length === 0}><RotateCcw className="h-3.5 w-3.5" /> Zerar</Button>
              </div>
            </div>
            {picking.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground text-center">Nenhum item pendente: todos os pedidos multi já têm TAG.</div>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr><th className="p-2 text-left">Local</th><th className="p-2 text-left">Produto</th><th className="p-2 text-right">Necessário</th><th className="p-2 text-right">Pedidos</th><th className="p-2 text-right w-[140px]">Separado</th></tr>
                </thead>
                <tbody>
                  {picking.map((r) => {
                    const nec = Number(r.qtd_necessaria), sep = Number(r.qtd_separada);
                    const completo = sep >= nec;
                    const val = editando[r.sku] ?? String(sep);
                    return (
                      <tr key={r.sku} className={cn("border-t border-border/60", completo && "bg-emerald-50/60 dark:bg-emerald-950/20")}>
                        <td className="p-2 font-mono text-[11.5px] whitespace-nowrap">{r.localizacao ?? "—"}</td>
                        <td className="p-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {r.foto ? <img src={r.foto} alt="" className="w-9 h-9 rounded-md object-cover border bg-muted shrink-0" />
                              : <div className="w-9 h-9 rounded-md border bg-muted flex items-center justify-center shrink-0"><PackageIcon className="h-4 w-4 text-muted-foreground" /></div>}
                            <div className="min-w-0"><div className="truncate">{r.nome ?? r.sku}</div><div className="text-[11px] text-muted-foreground font-mono">{r.sku}</div></div>
                          </div>
                        </td>
                        <td className="p-2 text-right tabular-nums font-semibold">{formatNumber(nec)}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{formatNumber(r.pedidos)}</td>
                        <td className="p-2">
                          <div className="flex items-center justify-end gap-1">
                            <Input type="number" min={0} step={1} className={cn("h-8 w-20 text-right tabular-nums", completo && "border-emerald-500")} value={val}
                              onChange={(e) => setEditando((s) => ({ ...s, [r.sku]: e.target.value }))}
                              onBlur={() => { if (editando[r.sku] !== undefined) void salvarSeparado(r.sku, Number(editando[r.sku])); }}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                            <Button size="sm" variant={completo ? "secondary" : "outline"} className="h-8 px-2" title="Marcar todo o necessário como separado" onClick={() => void salvarSeparado(r.sku, nec)}>
                              <CheckCircle2 className={cn("h-3.5 w-3.5", completo && "text-emerald-600")} />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          <div className="space-y-3">
            <Card className="p-3 border-emerald-300 dark:border-emerald-900">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-sm font-semibold">Liberados para impressão ({alocacao.liberados.length})</div>
                <Button size="sm" className="h-8 gap-1.5" disabled={ocupado || alocacao.liberados.length === 0 || !printerId} onClick={() => void liberarEImprimir()}>
                  <Printer className="h-3.5 w-3.5" /> Liberar e imprimir ({alocacao.liberados.length})
                </Button>
              </div>
              <div className="text-[11.5px] text-muted-foreground mb-2">Pedidos cujos itens estão TODOS cobertos pelo separado, na ordem de prioridade. Ao liberar: TAG + etiquetas, e o separado é abatido.</div>
              {alocacao.liberados.length === 0 ? <div className="text-sm text-muted-foreground">Nenhum pedido completo ainda.</div> : (
                <div className="space-y-1 max-h-[420px] overflow-auto">
                  {alocacao.liberados.map((p) => (
                    <div key={p.separacao_id} className="rounded-md border p-2 text-[12px] flex items-center justify-between gap-2">
                      <div className="min-w-0"><span className="font-mono font-semibold">#{p.venda_numero}</span> <span className="text-muted-foreground">{p.loja} · {p.tipo_envio}</span> <PrazoBadge dias={p.dias_para_prazo} iso={p.ship_by_date} /><div className="text-muted-foreground truncate">{descricaoCombo(p.itens)}</div></div>
                      <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card className="p-3">
              <div className="text-sm font-semibold mb-1">Ainda incompletos ({alocacao.faltando.length})</div>
              {alocacao.faltando.length === 0 ? <div className="text-sm text-muted-foreground">—</div> : (
                <div className="space-y-1 max-h-[360px] overflow-auto">
                  {alocacao.faltando.map(({ p, faltas }) => (
                    <div key={p.separacao_id} className="rounded-md border p-2 text-[12px]">
                      <span className="font-mono font-semibold">#{p.venda_numero}</span> <span className="text-muted-foreground">{p.loja} · {p.tipo_envio}</span> <PrazoBadge dias={p.dias_para_prazo} iso={p.ship_by_date} />
                      <div className="text-amber-700 dark:text-amber-400">falta {faltas.map((f) => `${f.sku} ×${formatNumber(f.falta)}`).join(", ")}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* barra flutuante: progresso / seleção */}
      {(prog || embalando || (modo === "pedido" && sel.size > 0)) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-wrap items-center justify-center gap-3 px-4 py-2.5 rounded-xl bg-card border shadow-lg max-w-[95vw]">
          {prog ? (
            <>
              {prog.fase === "concluido" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Loader2 className="h-4 w-4 animate-spin text-primary" />}
              <span className="text-sm font-medium tabular-nums">
                {prog.fase === "enviando" ? <>Enviando <span className="font-mono">{prog.etapa}</span> · <b>{prog.etiquetas}</b> etiqueta(s)</>
                  : <>{prog.fase === "concluido" ? "Impressora concluiu" : "Impressora imprimindo"} · <b>{prog.etiquetas}</b> enviada(s) · faltam <b>{prog.pendentes ?? 0}</b> · {prog.impressas ?? 0} confirmada(s)</>}
              </span>
              {prog.fase === "impressora" && <Button size="sm" variant="ghost" onClick={() => { fecharRef.current = true; }}>Fechar</Button>}
            </>
          ) : embalando ? (
            <><Loader2 className="h-4 w-4 animate-spin text-primary" /><span className="text-sm font-medium tabular-nums">Marcando embalado {embalando.atual}/{embalando.total}</span></>
          ) : (
            <>
              <span className="text-sm font-medium">{sel.size} grupo(s) · {selecionados.length} pedido(s)</span>
              <Button size="sm" className="gap-1.5" disabled={ocupado} onClick={() => {
                // uma TAG por grupo selecionado, na ordem de prioridade
                void (async () => { for (const g of grupos.filter((x) => sel.has(x.chave))) await tagEImprimir(g.peds, `MULTI · ${descricaoCombo(g.itens)}`); })();
              }}>
                <Printer className="h-4 w-4" /> Imprimir selecionados
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" disabled={ocupado} onClick={() => void marcarEmbalado(selecionados)}>
                <PackageIcon className="h-4 w-4" /> Embalar impressos ({selecionados.filter(impressa).length})
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Limpar</Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
