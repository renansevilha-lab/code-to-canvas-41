import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Printer, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatBRL, formatNumber } from "@/lib/format";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { registrarSeparacaoLog } from "@/lib/separacaoLog";
import { acharLoteDaTag, imprimirIdentificadorApi, type TagLoteRow } from "@/lib/identificador";
import { Package as PackageIcon, MessageSquare } from "lucide-react";
import { MensagemLoteDialog, type AlvoMensagem } from "@/components/separacao/MensagemLoteDialog";

// ============================================================================
// Risco de cancelamento automático (Shopee) — TODOS os pedidos em risco,
// inclusive os que já saíram da fila de separação (embalados/concluídos
// aguardando coleta). A fila (/separacao) só mostra situação 1; aqui a fonte
// é view_pedidos_risco_cancelamento (pedido arranjado e ainda não coletado;
// cancela_em = ship_by + 3 dias, regra observada no Seller Center).
// Reimpressão é SEMPRE forçada (pedido a pedido, sem dedup) — por isso pede
// confirmação: etiqueta em dobro no mesmo pacote gera extravio/devolução.
// ============================================================================

interface RiscoRow {
  order_sn: string;
  loja: string;
  shop_id: number;
  status_pedido: string;
  dia_pedido: string;
  vence_em: string;
  cancela_em: string;
  dias_para_cancelar: number;
  sit_separacao: number | null;
  situacao_fisica: string;
  tag_lote: string | null;
  sit_tiny: string | null;
  rastreio: string | null;
  valor: number | null;
  itens: string | null;
  separacao_id: number | null;
}

interface Impressora {
  printer_id: number;
  nome: string;
  computador: string;
  estado: string;
}

// mesmas chaves da Separação: impressora e toggle da identificadora valem aqui
const STORAGE_PRINTER = "separacao.printerId";
const STORAGE_IDENT = "separacao.identificadorLote";
const STORAGE_FOTOS = "risco.mostrarFotos";

// "15996 x1, 15994 x2" -> ["15996", "15994"]
function skusDe(itens: string | null): string[] {
  return (itens ?? "").split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean);
}

// Foto + nome por SKU (produtos.foto_capa/nome) — só os SKUs visíveis, em
// lotes de 300 (corte de 1.000 do PostgREST).
function useProdutos(skus: string[]) {
  const chave = useMemo(() => Array.from(new Set(skus)).sort(), [skus]);
  return useQuery({
    queryKey: ["risco-cancelamento", "produtos", chave],
    enabled: chave.length > 0,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Record<string, { nome: string | null; foto: string | null }>> => {
      const map: Record<string, { nome: string | null; foto: string | null }> = {};
      for (let i = 0; i < chave.length; i += 300) {
        const { data } = await supabaseExternal
          .from("produtos").select("sku, nome, foto_capa").in("sku", chave.slice(i, i + 300));
        for (const r of (data ?? []) as { sku: string; nome: string | null; foto_capa: string | null }[]) {
          map[r.sku] = { nome: r.nome, foto: r.foto_capa };
        }
      }
      return map;
    },
  });
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const lojaParam = (shopId: number): "ottz" | "svl" => (shopId === 522186766 ? "ottz" : "svl");

function useImpressoras() {
  return useQuery({
    queryKey: ["separacao", "impressoras"],
    queryFn: async () => {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras`, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const data = (await resp.json().catch(() => ({}))) as { impressoras?: Impressora[] };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (data.impressoras ?? []).filter((p) => (p.nome ?? "").toLowerCase().includes("zd220"));
    },
    refetchInterval: 60_000,
  });
}

/** Etiqueta Shopee de UM pedido (sem dedup no servidor = reimprime sempre). */
async function reimprimirShopee(loja: "ottz" | "svl", orderSn: string, printerId: number): Promise<boolean> {
  const url = `${EXTERNAL_URL}/functions/v1/shopee-sync-ads` +
    `?modulo=imprimir&loja=${loja}&order_sn=${encodeURIComponent(orderSn)}&printer_id=${printerId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } });
  const data = (await resp.json().catch(() => ({}))) as {
    erro?: string; etiquetas_prontas?: number; pedidos_no_lote?: number; aviso?: string | null;
  };
  if (!resp.ok || data.erro) {
    toast.error(`Falha ao imprimir ${orderSn}`, { description: data.erro ?? `HTTP ${resp.status}` });
    return false;
  }
  if ((data.etiquetas_prontas ?? 0) < (data.pedidos_no_lote ?? 1)) {
    toast.warning(`${orderSn}: etiqueta não está pronta na Shopee`, {
      description: data.aviso ?? "Pedido sem envio arranjado — nada para imprimir.", duration: 10000,
    });
    return false;
  }
  return true;
}

/** Marca UMA separação como embalada no Tiny (mesmo endpoint da Separação). */
async function embalarUmApi(separacaoId: number): Promise<void> {
  const resp = await fetch(
    `${EXTERNAL_URL}/functions/v1/tiny-separacao?modulo=embalar-um&separacao_id=${separacaoId}&confirmar=1`,
    { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
  );
  if (!resp.ok) {
    const d = (await resp.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(d.error ?? d.message ?? `HTTP ${resp.status}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function RiscoCancelamentoPage() {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const { data: impressoras } = useImpressoras();
  const [printerId, setPrinterId] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    const v = Number(window.localStorage.getItem(STORAGE_PRINTER));
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  useEffect(() => {
    if (typeof window !== "undefined" && printerId > 0) window.localStorage.setItem(STORAGE_PRINTER, String(printerId));
  }, [printerId]);
  const impressora = impressoras?.find((p) => p.printer_id === printerId);

  const [empresa, setEmpresa] = useState<"todas" | "Ottz Pet" | "Bumi Pet">("todas");
  const [quando, setQuando] = useState<"hoje" | "amanha" | "todos">("hoje");
  const [situacao, setSituacao] = useState<"todas" | "embalado" | "fila" | "fora">("todas");
  const [busca, setBusca] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  // identificadora do lote depois das etiquetas (mesma regra/chave da Separação)
  const [identOn, setIdentOn] = useState<boolean>(() => {
    try { const v = localStorage.getItem(STORAGE_IDENT); return v === null ? true : v === "1"; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem(STORAGE_IDENT, identOn ? "1" : "0"); } catch { /* noop */ } }, [identOn]);
  const [mostrarFotos, setMostrarFotos] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_FOTOS) !== "0"; } catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem(STORAGE_FOTOS, mostrarFotos ? "1" : "0"); } catch { /* noop */ } }, [mostrarFotos]);
  const [imprimindo, setImprimindo] = useState<string | null>(null);
  const [massa, setMassa] = useState<{ atual: number; total: number } | null>(null);
  const cancelarRef = useRef(false);
  const pausaRef = useRef(false);
  const [pausado, setPausado] = useState(false);
  // pedidos reimpressos NESTA sessão da tela — alvo do "marcar embalado"
  const [reimpressos, setReimpressos] = useState<Set<string>>(new Set());
  const [embalando, setEmbalando] = useState<{ atual: number; total: number } | null>(null);
  // "tratados" = tirados da lista pela operação (persistido; o risco real segue)
  const [mostrarTratados, setMostrarTratados] = useState(false);
  // mensagem em massa (chat Shopee) para os pedidos selecionados
  const [msgAlvo, setMsgAlvo] = useState<AlvoMensagem | null>(null);
  const tratadosQ = useQuery({
    queryKey: ["risco-cancelamento", "tratados"],
    refetchInterval: 120_000,
    queryFn: async (): Promise<Map<string, { por: string | null; em: string }>> => {
      const { data, error } = await supabaseExternal
        .from("risco_cancelamento_tratados").select("order_sn, tratado_por, tratado_em").limit(5000);
      if (error) throw error;
      const m = new Map<string, { por: string | null; em: string }>();
      for (const r of (data ?? []) as { order_sn: string; tratado_por: string | null; tratado_em: string }[]) {
        m.set(r.order_sn, { por: r.tratado_por, em: r.tratado_em });
      }
      return m;
    },
  });
  const tratados = tratadosQ.data ?? new Map<string, { por: string | null; em: string }>();

  const q = useQuery({
    queryKey: ["risco-cancelamento", "lista"],
    refetchInterval: 120_000,
    queryFn: async (): Promise<RiscoRow[]> => {
      const { data, error } = await supabaseExternal
        .from("view_pedidos_risco_cancelamento").select("*")
        .order("cancela_em", { ascending: true }).order("loja").order("situacao_fisica").order("order_sn")
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as RiscoRow[];
    },
  });

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return (q.data ?? []).filter((r) => {
      if (!mostrarTratados && tratados.has(r.order_sn)) return false;
      if (empresa !== "todas" && r.loja !== empresa) return false;
      if (quando === "hoje" && Number(r.dias_para_cancelar) > 0) return false;
      if (quando === "amanha" && Number(r.dias_para_cancelar) !== 1) return false;
      if (situacao === "embalado" && !r.situacao_fisica.startsWith("embalado")) return false;
      if (situacao === "fila" && !["na fila", "em separação"].includes(r.situacao_fisica)) return false;
      if (situacao === "fora" && r.situacao_fisica !== "fora da separação") return false;
      if (t && !(
        r.order_sn.toLowerCase().includes(t) || (r.rastreio ?? "").toLowerCase().includes(t) ||
        (r.tag_lote ?? "").toLowerCase().includes(t) || (r.itens ?? "").toLowerCase().includes(t)
      )) return false;
      return true;
    });
  }, [q.data, empresa, quando, situacao, busca, mostrarTratados, tratados]);

  const skusVisiveis = useMemo(() => linhas.flatMap((r) => skusDe(r.itens)), [linhas]);
  const produtosQ = useProdutos(mostrarFotos ? skusVisiveis : []);

  // identificadora da TAG (modo auto: dedupe 60s; TAG recém-criada é buscada no banco)
  async function identificadoraDaTag(tag: string | null) {
    if (!identOn || !tag || !printerId) return;
    const lote = await acharLoteDaTag(tag, undefined);
    if (lote) await imprimirIdentificadorApi(lote, printerId, { auto: true });
  }

  // Pedido SEM TAG (embalado fora do fluxo de lote) não tem identificadora de
  // lote — sai uma identificadora de REIMPRESSÃO por SKU, mesmo ZPL, com a
  // "TAG" REIMP-hhmm-sku, para a pilha reimpressa ser reconhecida na bancada.
  async function identificadoraReimpressao(sku: string, loja: string, pedidos: number) {
    if (!identOn || !printerId) return;
    const agora = new Date();
    const hhmm = `${String(agora.getHours()).padStart(2, "0")}${String(agora.getMinutes()).padStart(2, "0")}`;
    const lote: TagLoteRow = {
      id: 0, data: agora.toISOString().slice(0, 10), sequencia: 0,
      tag: `REIMP-${hhmm}`,
      grupo_origem: `REIMPRESSAO · ${sku} · ${loja}`,
      sku, tipo_envio: loja, qtd_pedidos: pedidos, qtd_pulados: 0,
      status: "aplicada", embalado_em: null, criado_em: agora.toISOString(),
    };
    await imprimirIdentificadorApi(lote, printerId, {});
  }

  const resumo = useMemo(() => {
    const todos = q.data ?? [];
    const hoje = todos.filter((r) => Number(r.dias_para_cancelar) <= 0);
    const amanha = todos.filter((r) => Number(r.dias_para_cancelar) === 1);
    const soma = (xs: RiscoRow[]) => xs.reduce((a, b) => a + Number(b.valor ?? 0), 0);
    return {
      hoje: hoje.length, hojeValor: soma(hoje), hojeEmbalados: hoje.filter((r) => r.situacao_fisica.startsWith("embalado")).length,
      amanha: amanha.length, amanhaValor: soma(amanha),
      filtrados: linhas.length, filtradosValor: soma(linhas),
    };
  }, [q.data, linhas]);

  const AVISO = (n: number) =>
    `ATENÇÃO — reimprimir ${n} etiqueta(s)\n\n` +
    `Estes pedidos já tiveram etiqueta impressa (constam como embalados/concluídos). ` +
    `Se a etiqueta anterior ainda estiver no pacote, ele fica com DUAS — risco de extravio/devolução.\n\n` +
    `Use só se as etiquetas anteriores foram perdidas, rasgadas ou saíram na impressora errada.\n\n` +
    `Impressora: ${impressora?.nome ?? "(nenhuma selecionada)"}. Confirmar?`;

  async function reimprimirUm(r: RiscoRow) {
    if (!printerId) { toast.warning("Escolha a impressora primeiro."); return; }
    if (imprimindo || massa) return;
    if (!window.confirm(AVISO(1))) return;
    setImprimindo(r.order_sn);
    try {
      const ok = await reimprimirShopee(lojaParam(r.shop_id), r.order_sn, printerId);
      if (ok) {
        toast.success(`Etiqueta ${r.order_sn} enviada`, { description: impressora?.nome ?? "" });
        void registrarSeparacaoLog({
          evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
          order_sn: r.order_sn, tag: r.tag_lote, detalhe: { via: "risco", forcar: true, loja: lojaParam(r.shop_id) },
        });
        if (r.tag_lote) await identificadoraDaTag(r.tag_lote);
        else await identificadoraReimpressao(skusDe(r.itens)[0] ?? "?", r.loja, 1);
        setReimpressos((prev) => new Set(prev).add(r.order_sn));
      }
    } finally {
      setImprimindo(null);
    }
  }

  async function reimprimirSelecionados() {
    if (!printerId) { toast.warning("Escolha a impressora primeiro."); return; }
    if (massa) return;
    // ordena por TAG para a identificadora sair logo DEPOIS das etiquetas de cada lote
    // chave de agrupamento: TAG real, ou (sem TAG) SKU+loja — cada grupo fecha
    // com a sua identificadora logo depois das etiquetas
    const chaveDe = (r: RiscoRow) => r.tag_lote ? `T|${r.tag_lote}` : `S|${r.loja}|${skusDe(r.itens)[0] ?? "?"}`;
    const alvo = linhas.filter((r) => sel.has(r.order_sn))
      .sort((a, b) => chaveDe(a).localeCompare(chaveDe(b)) || a.order_sn.localeCompare(b.order_sn));
    if (alvo.length === 0) return;
    if (impressora?.estado === "offline") { toast.error("Impressora offline"); return; }
    if (!window.confirm(AVISO(alvo.length))) return;
    cancelarRef.current = false;
    pausaRef.current = false;
    setPausado(false);
    let ok = 0;
    let chaveAberta: string | null = null;
    let linhaAberta: RiscoRow | null = null;
    let okNaTag = 0;
    const feitos = new Set<string>();
    const fecharGrupo = async () => {
      if (!linhaAberta || okNaTag === 0) return;
      if (linhaAberta.tag_lote) await identificadoraDaTag(linhaAberta.tag_lote);
      else await identificadoraReimpressao(skusDe(linhaAberta.itens)[0] ?? "?", linhaAberta.loja, okNaTag);
    };
    try {
      for (let i = 0; i < alvo.length; i++) {
        // pausa: segura ANTES do próximo pedido (nunca no meio de uma etiqueta)
        while (pausaRef.current && !cancelarRef.current) await sleep(400);
        if (cancelarRef.current) break;
        setMassa({ atual: i + 1, total: alvo.length });
        const r = alvo[i];
        if (chaveDe(r) !== chaveAberta) {
          // mudou de grupo: fecha o anterior com a identificadora dele
          await fecharGrupo();
          chaveAberta = chaveDe(r); linhaAberta = r; okNaTag = 0;
        }
        if (await reimprimirShopee(lojaParam(r.shop_id), r.order_sn, printerId)) {
          ok++; okNaTag++; feitos.add(r.order_sn);
          void registrarSeparacaoLog({
            evento: "etiqueta_impressa", usuario: perfil?.nome ?? null,
            order_sn: r.order_sn, tag: r.tag_lote, detalhe: { via: "risco-massa", forcar: true, loja: lojaParam(r.shop_id) },
          });
        }
      }
      await fecharGrupo();
    } finally {
      setMassa(null);
      setPausado(false);
      pausaRef.current = false;
      setReimpressos((prev) => { const n = new Set(prev); for (const x of feitos) n.add(x); return n; });
    }
    toast[cancelarRef.current ? "info" : "success"](
      cancelarRef.current
        ? `Reimpressão encerrada — ${ok} etiqueta(s) saíram antes de parar`
        : `${ok} de ${alvo.length} etiqueta(s) reimpressa(s)`,
      { description: impressora?.nome ?? "" },
    );
    setSel(new Set());
  }

  // Marca embalado no Tiny os pedidos informados que ainda estão na fila/em
  // separação (quem já consta embalado/concluído é pulado; fora da separação
  // não tem separacao_id).
  async function marcarEmbalado(orderSns: Set<string>, origem: "reimpressos" | "selecionados") {
    if (embalando || massa) return;
    const todos = (q.data ?? []).filter((r) => orderSns.has(r.order_sn));
    const alvo = todos.filter((r) => r.separacao_id && ["na fila", "em separação"].includes(r.situacao_fisica));
    const pulados = todos.length - alvo.length;
    if (alvo.length === 0) {
      toast.info("Nada a marcar", { description: pulados > 0 ? `${pulados} já constam embalados/concluídos ou estão fora da separação.` : "Nenhum pedido." });
      return;
    }
    if (!window.confirm(
      `Marcar como EMBALADOS no Tiny ${alvo.length} pedido(s) ${origem === "reimpressos" ? "reimpressos nesta sessão" : "selecionados"}?\n` +
      (pulados > 0 ? `${pulados} ficam de fora (já embalados/concluídos ou fora da separação).\n` : "") +
      `Confirme só se a etiqueta nova está no pacote.`,
    )) return;
    let ok = 0, erros = 0;
    try {
      for (let i = 0; i < alvo.length; i++) {
        setEmbalando({ atual: i + 1, total: alvo.length });
        const r = alvo[i];
        try {
          await embalarUmApi(r.separacao_id as number);
          ok++;
          void registrarSeparacaoLog({
            evento: "embalado", usuario: perfil?.nome ?? null,
            order_sn: r.order_sn, separacao_id: r.separacao_id, tag: r.tag_lote,
            detalhe: { via: "risco", forcado: false },
          });
        } catch (e) {
          erros++;
          toast.error(`Falha ao embalar ${r.order_sn}`, { description: (e as Error).message });
        }
      }
    } finally {
      setEmbalando(null);
      setReimpressos((prev) => { const n = new Set(prev); for (const r of alvo) n.delete(r.order_sn); return n; });
      void qc.invalidateQueries({ queryKey: ["risco-cancelamento"] });
    }
    toast[erros > 0 ? "warning" : "success"](`${ok} pedido(s) marcados como embalados${erros > 0 ? ` · ${erros} erro(s)` : ""}`);
  }

  // Tira da lista (persistido) — só os que ainda não estão tratados.
  async function tirarDaLista(orderSns: Set<string>, origem: "reimpressos" | "selecionados") {
    const alvo = [...orderSns].filter((sn) => !tratados.has(sn));
    if (alvo.length === 0) { toast.info("Esses pedidos já estão fora da lista."); return; }
    if (!window.confirm(
      `Tirar da lista ${alvo.length} pedido(s) ${origem === "reimpressos" ? "reimpressos nesta sessão" : "selecionados"}?\n\n` +
      `Só some desta tela — o risco na Shopee continua até a coleta bipar. ` +
      `Dá para rever/desfazer em "Mostrar tratados".`,
    )) return;
    const { error } = await supabaseExternal.from("risco_cancelamento_tratados").upsert(
      alvo.map((sn) => ({ order_sn: sn, tratado_por: perfil?.nome ?? null, motivo: origem })),
      { onConflict: "order_sn" },
    );
    if (error) { toast.error("Falha ao tirar da lista", { description: error.message }); return; }
    toast.success(`${alvo.length} pedido(s) fora da lista`);
    setReimpressos((prev) => { const n = new Set(prev); for (const sn of alvo) n.delete(sn); return n; });
    setSel(new Set());
    void qc.invalidateQueries({ queryKey: ["risco-cancelamento", "tratados"] });
  }

  async function voltarParaLista(orderSns: Set<string>) {
    const alvo = [...orderSns].filter((sn) => tratados.has(sn));
    if (alvo.length === 0) return;
    const { error } = await supabaseExternal.from("risco_cancelamento_tratados").delete().in("order_sn", alvo);
    if (error) { toast.error("Falha ao voltar para a lista", { description: error.message }); return; }
    toast.success(`${alvo.length} pedido(s) de volta à lista`);
    setSel(new Set());
    void qc.invalidateQueries({ queryKey: ["risco-cancelamento", "tratados"] });
  }

  const todasSel = linhas.length > 0 && linhas.every((r) => sel.has(r.order_sn));

  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Risco de cancelamento — Shopee</h1>
          <p className="text-[12.5px] text-muted-foreground max-w-3xl">
            Pedidos com envio arranjado e ainda <b>não coletados</b> — inclusive os que já saíram da fila de
            separação (embalados/concluídos). A Shopee cancela automaticamente ~3 dias após o prazo de envio;
            a data é estimada (a API não a expõe). Reimpressão aqui é sempre forçada, pedido a pedido.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={printerId ? String(printerId) : ""} onValueChange={(v) => setPrinterId(Number(v))}>
            <SelectTrigger className={cn("h-9 w-[260px] text-sm bg-card", impressora?.estado === "offline" && "border-destructive text-destructive")}>
              <Printer className="h-3.5 w-3.5 mr-1 shrink-0" />
              <SelectValue placeholder="Impressora (Zebra)" />
            </SelectTrigger>
            <SelectContent>
              {(impressoras ?? []).map((p) => (
                <SelectItem key={p.printer_id} value={String(p.printer_id)}>
                  {p.nome} · {p.computador} {p.estado === "offline" ? "· OFFLINE" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-9 gap-1.5" disabled={q.isFetching}
            onClick={() => void qc.invalidateQueries({ queryKey: ["risco-cancelamento"] })}>
            {q.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Atualizar
          </Button>
        </div>
      </div>

      {/* resumo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3 border-red-300 bg-red-50 dark:bg-red-950/30">
          <div className="text-[11px] font-bold uppercase tracking-wide text-red-700 dark:text-red-300">Cancela HOJE</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.hoje)}</div>
          <div className="text-[11px] text-muted-foreground">{formatNumber(resumo.hojeEmbalados)} embalados aguardando coleta · {formatBRL(resumo.hojeValor)}</div>
        </Card>
        <Card className="p-3 border-orange-300 bg-orange-50 dark:bg-orange-950/30">
          <div className="text-[11px] font-bold uppercase tracking-wide text-orange-700 dark:text-orange-300">Cancela amanhã</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.amanha)}</div>
          <div className="text-[11px] text-muted-foreground">{formatBRL(resumo.amanhaValor)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">No filtro atual</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(resumo.filtrados)}</div>
          <div className="text-[11px] text-muted-foreground">{formatBRL(resumo.filtradosValor)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Selecionados</div>
          <div className="text-2xl font-extrabold tabular-nums">{formatNumber(sel.size)}</div>
          <div className="text-[11px] text-muted-foreground">marque na tabela para reimprimir em massa</div>
        </Card>
      </div>

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["todas", "Todas"], ["Ottz Pet", "Ottz"], ["Bumi Pet", "Bumi"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setEmpresa(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                empresa === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["hoje", "Cancela hoje"], ["amanha", "Cancela amanhã"], ["todos", "Hoje + amanhã"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setQuando(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                quando === id ? (id === "hoje" ? "bg-red-600 text-white" : "bg-accent text-accent-foreground") : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["todas", "Todas situações"], ["embalado", "Embalados (aguardam coleta)"], ["fila", "Na fila"], ["fora", "Fora da separação"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setSituacao(id); setSel(new Set()); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                situacao === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        {(() => {
          const n = (q.data ?? []).filter((r) => tratados.has(r.order_sn)).length;
          if (n === 0 && !mostrarTratados) return null;
          return (
            <label className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none px-1">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={mostrarTratados} onChange={(e) => setMostrarTratados(e.target.checked)} />
              Mostrar tratados ({formatNumber(n)})
            </label>
          );
        })()}
        <label className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none px-1">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={identOn} onChange={(e) => setIdentOn(e.target.checked)} />
          Identificadora do lote
        </label>
        <label className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none px-1">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={mostrarFotos} onChange={(e) => setMostrarFotos(e.target.checked)} />
          Mostrar foto e nome
        </label>
        <div className="relative w-full sm:w-auto sm:min-w-[260px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input className="h-9 pl-8 text-sm bg-card" placeholder="Pedido, rastreio, TAG ou SKU"
            value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </div>

      {/* tabela */}
      <Card className="overflow-x-auto">
        {q.isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando…</div>
        ) : linhas.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Nenhum pedido com esses filtros. 🎉</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-2 w-8">
                  <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer" checked={todasSel}
                    onChange={(e) => setSel(e.target.checked ? new Set(linhas.map((r) => r.order_sn)) : new Set())}
                    title="Selecionar todos do filtro" />
                </th>
                <th className="p-2 text-left">Pedido</th>
                <th className="p-2 text-left">Loja</th>
                <th className="p-2 text-left">Situação física</th>
                <th className="p-2 text-left">TAG</th>
                <th className="p-2 text-left">Rastreio</th>
                <th className="p-2 text-left">{mostrarFotos ? "Produto" : "Itens"}</th>
                <th className="p-2 text-right">Valor</th>
                <th className="p-2 text-left">Prazo</th>
                <th className="p-2 text-left">Cancela</th>
                <th className="p-2 text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((r) => {
                const hoje = Number(r.dias_para_cancelar) <= 0;
                const semEnvio = r.status_pedido === "READY_TO_SHIP";
                return (
                  <tr key={r.order_sn} className={cn("border-t border-border/60", sel.has(r.order_sn) && "bg-accent/40")}>
                    <td className="p-2">
                      <input type="checkbox" className="h-4 w-4 accent-primary cursor-pointer" checked={sel.has(r.order_sn)}
                        onChange={(e) => setSel((prev) => { const n = new Set(prev); if (e.target.checked) n.add(r.order_sn); else n.delete(r.order_sn); return n; })} />
                    </td>
                    <td className="p-2 font-mono font-semibold">{r.order_sn}</td>
                    <td className="p-2">{r.loja}</td>
                    <td className="p-2">
                      <span className={cn("px-2 py-0.5 rounded-full text-[11px] font-semibold",
                        r.situacao_fisica.startsWith("embalado") ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : r.situacao_fisica === "fora da separação" ? "bg-muted text-muted-foreground"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300")}>
                        {r.situacao_fisica}
                      </span>
                      {tratados.has(r.order_sn) && (
                        <span className="ml-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
                          title={`Tirado da lista${tratados.get(r.order_sn)?.por ? ` por ${tratados.get(r.order_sn)?.por}` : ""} — o risco na Shopee continua até a coleta`}>
                          tratado
                        </span>
                      )}
                      {semEnvio && (
                        <span className="ml-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                          title="Pedido sem envio arranjado na Shopee — não há etiqueta; precisa faturar/arranjar">
                          sem envio arranjado
                        </span>
                      )}
                    </td>
                    <td className="p-2 font-mono">{r.tag_lote ?? "—"}</td>
                    <td className="p-2 font-mono text-[11.5px]">{r.rastreio ?? "—"}</td>
                    <td className="p-2 max-w-[300px]" title={r.itens ?? ""}>
                      {(() => {
                        const skus = skusDe(r.itens);
                        const p0 = skus[0] ? produtosQ.data?.[skus[0]] : undefined;
                        if (!mostrarFotos) return <span className="text-muted-foreground truncate block">{r.itens ?? "—"}</span>;
                        return (
                          <div className="flex items-center gap-2 min-w-0">
                            {p0?.foto ? (
                              <img src={p0.foto} alt="" loading="lazy" className="w-9 h-9 rounded-md object-cover bg-muted border shrink-0" />
                            ) : (
                              <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0"><PackageIcon className="h-4 w-4 text-muted-foreground" /></div>
                            )}
                            <div className="min-w-0">
                              <div className="truncate text-[12px]">{p0?.nome ?? skus[0] ?? "—"}</div>
                              <div className="text-[11px] text-muted-foreground font-mono truncate">
                                {r.itens ?? ""}{skus.length > 1 ? ` · ${skus.length} SKUs` : ""}
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatBRL(Number(r.valor ?? 0))}</td>
                    <td className="p-2 tabular-nums">{ddmm(r.vence_em)}</td>
                    <td className="p-2">
                      <span className={cn("font-bold tabular-nums", hoje ? "text-destructive" : "text-orange-700 dark:text-orange-400")}>
                        {hoje ? `HOJE ${ddmm(r.cancela_em)}` : `amanhã ${ddmm(r.cancela_em)}`}
                      </span>
                    </td>
                    <td className="p-2 text-right">
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400"
                        disabled={imprimindo !== null || massa !== null || semEnvio}
                        title={semEnvio ? "Sem envio arranjado — não há etiqueta" : "Reimprime a etiqueta deste pedido (forçado)"}
                        onClick={() => void reimprimirUm(r)}>
                        {imprimindo === r.order_sn ? <Loader2 className="h-3 w-3 animate-spin" /> : <Printer className="h-3 w-3" />}
                        Reimprimir
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <MensagemLoteDialog alvo={msgAlvo} onClose={() => setMsgAlvo(null)} enviadoPor={perfil?.nome ?? null} />

      {/* barra de seleção / progresso */}
      {(sel.size > 0 || massa || embalando || reimpressos.size > 0) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-wrap items-center justify-center gap-3 px-4 py-2.5 rounded-xl bg-card border shadow-lg max-w-[95vw]">
          {massa ? (
            <>
              <Loader2 className={cn("h-4 w-4 text-primary", !pausado && "animate-spin")} />
              <span className="text-sm font-medium tabular-nums">
                {pausado ? "PAUSADO em" : "Reimprimindo"} {massa.atual}/{massa.total}
              </span>
              <Button size="sm" variant={pausado ? "default" : "secondary"}
                onClick={() => { pausaRef.current = !pausaRef.current; setPausado(pausaRef.current); }}>
                {pausado ? "Retomar" : "Pausar"}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => { cancelarRef.current = true; pausaRef.current = false; }}>
                Encerrar (após esta etiqueta)
              </Button>
            </>
          ) : embalando ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span className="text-sm font-medium tabular-nums">Marcando embalado {embalando.atual}/{embalando.total}</span>
            </>
          ) : (
            <>
              {sel.size > 0 && (
                <>
                  <span className="text-sm font-medium">{sel.size} selecionado(s)</span>
                  <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => void reimprimirSelecionados()}>
                    <AlertTriangle className="h-4 w-4" /> Reimprimir selecionados (forçar)
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void marcarEmbalado(sel, "selecionados")}>
                    <PackageIcon className="h-4 w-4" /> Marcar embalado selecionados
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5"
                    title="Envia uma mensagem no chat da Shopee para os compradores dos pedidos selecionados"
                    onClick={() => setMsgAlvo({ tipo: "pedidos", orderSns: [...sel], rotulo: `${sel.size} pedido(s) em risco de cancelamento` })}>
                    <MessageSquare className="h-4 w-4" /> Mensagem aos clientes ({sel.size})
                  </Button>
                  {mostrarTratados && [...sel].some((sn) => tratados.has(sn)) ? (
                    <Button size="sm" variant="outline" onClick={() => void voltarParaLista(sel)}>Voltar à lista</Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void tirarDaLista(sel, "selecionados")}>Tirar da lista</Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Limpar</Button>
                </>
              )}
              {reimpressos.size > 0 && (
                <Button size="sm" variant="default" className="gap-1.5"
                  title="Marca embalado no Tiny os pedidos reimpressos nesta sessão que ainda estão na fila"
                  onClick={() => void marcarEmbalado(reimpressos, "reimpressos")}>
                  <PackageIcon className="h-4 w-4" /> Marcar embalado os reimpressos ({reimpressos.size})
                </Button>
              )}
              {reimpressos.size > 0 && (
                <Button size="sm" variant="outline" className="gap-1.5"
                  title="Tira desta lista os pedidos reimpressos com sucesso nesta sessão (o risco na Shopee continua até a coleta)"
                  onClick={() => void tirarDaLista(reimpressos, "reimpressos")}>
                  Tirar da lista os reimpressos ({reimpressos.size})
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/risco-cancelamento")({
  component: RiscoCancelamentoPage,
});
