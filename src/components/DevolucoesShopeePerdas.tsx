// ============================================================================
// Perdas Shopee — reembolso SÓ-REEMBOLSO em que a entrega falhou/foi descartada
// e o produto pode não ter voltado (CLAUDE.md §5.10).
//
// Fonte: view_shopee_perda_logistica (1 linha por pedido reembolsado com
// solucao=1 e rastreio da IDA consultado). A "situação" vem pronta do banco:
//   1 descartado/perdido · 2 Shopee diz que devolveu, sem entrada no galpão ·
//   2b voltando · 3 falha, não voltou · 4 entregue × "não recebi" ·
//   5 voltou ao galpão · 6 entregue, reclamação de item · 7 sem evento.
// Nada é calculado aqui além de somar as linhas exibidas: a leitura pagina de
// 1.000 em 1.000 (corte do PostgREST) para a soma não sair silenciosamente
// errada. Itens/rastreio/foto são buscados só para os pedidos filtrados.
//
// "Dar entrada" reusa a aba Recebidas (mesma bipagem) — o pedido sai daqui
// sozinho quando `devolucoes_recebidas` ganha a linha (situação vira 5).
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { Copy, Download, ExternalLink, Loader2, Package as PackageIcon, PackageOpen, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { InfoDevolucaoCampos } from "@/components/InfoDevolucaoShopee";
import {
  buscarInfoDevolucao, solucaoReembolso, statusEntrega, statusSolicitacao, type InfoDevolucao,
} from "@/lib/shopeeDevolucao";
import { cn } from "@/lib/utils";

interface Perda {
  order_sn: string;
  shop_id: number | null;
  data_pedido: string | null;
  return_sn: string | null;
  motivo_devolucao: string | null;
  texto_comprador: string | null;
  valor_reembolsado: number | string | null;
  cmv: number | string | null;
  compensado: number | string | null;
  devolucao_em: string | null;
  produto_recebido_em: string | null;
  ida_ultimo_evento: string | null;
  ida_ultimo_em: string | null;
  situacao: string;
  dias_desde_evento: number | null;
}

interface Extra {
  itens: { sku: string | null; nome: string | null; qtd: number | null }[];
  rastreioIda: string | null;
  rastreioVolta: string | null;
  info?: InfoDevolucao;
}

const COLS =
  "order_sn,shop_id,data_pedido,return_sn,motivo_devolucao,texto_comprador,valor_reembolsado,cmv,compensado,devolucao_em,produto_recebido_em,ida_ultimo_evento,ida_ultimo_em,situacao,dias_desde_evento";

type SitId = "1" | "2" | "2b" | "3" | "7" | "4" | "6" | "5";

// Ordem = prioridade de ação. "perda" = produto e venda possivelmente perdidos.
const SITUACOES: { id: SitId; rotulo: string; dica: string; cor: string; grupo: "perda" | "acompanhar" | "outros" }[] = [
  { id: "1", rotulo: "Descartado / perdido", dica: "O rastreio da ida termina em descarte, extravio ou avaria. Se não houver compensação, cobrar a Shopee.", cor: "#C9432F", grupo: "perda" },
  { id: "2", rotulo: "Devolvido sem entrada", dica: "A Shopee diz que devolveu, mas o pacote não foi bipado em Devoluções › Recebidas. Procurar no galpão antes de cobrar.", cor: "#D9622B", grupo: "perda" },
  { id: "3", rotulo: "Falha, não voltou", dica: "A entrega falhou e não há evento de devolução nem entrada no galpão.", cor: "#B7791F", grupo: "perda" },
  { id: "2b", rotulo: "Voltando", dica: "O pacote está a caminho de volta. Acompanhar; vira problema se parar por muitos dias.", cor: "#2F6FB0", grupo: "acompanhar" },
  { id: "7", rotulo: "Sem evento", dica: "O rastreio não tem evento conclusivo ainda.", cor: "#5C6470", grupo: "acompanhar" },
  { id: "4", rotulo: "Entregue × não recebi", dica: "A Shopee registra entrega, mas o comprador disse que não recebeu e foi reembolsado.", cor: "#7A5CC7", grupo: "outros" },
  { id: "6", rotulo: "Entregue, reclamação de item", dica: "Entregue; o reembolso foi por item faltando, errado ou avariado.", cor: "#8A6D3B", grupo: "outros" },
  { id: "5", rotulo: "Voltou ao galpão", dica: "O produto já teve entrada em Devoluções › Recebidas.", cor: "#0E8A5F", grupo: "outros" },
];
const PADRAO: SitId[] = ["1", "2", "3"];

const MOTIVO_PT: Record<string, string> = {
  NOT_RECEIPT: "Não recebeu",
  ITEM_MISSING: "Item faltando",
  FUNCTIONAL_DMG: "Defeito funcional",
  PHYSICAL_DMG: "Dano físico",
  ITEM_WRONGDAMAGED: "Item errado/danificado",
  WRONG_ITEM: "Item errado",
  DIFF: "Diferente do anunciado",
  CHANGE_MIND: "Desistiu",
  OTHER: "Outro",
};

// Registro físico de devolução (Recebidas) só existe desde 10/ago/2026: antes
// disso "sem entrada no galpão" não significa nada.
const INICIO_RECEBIDAS = "2026-08-10";
type Periodo = "recebidas" | "60d" | "tudo";

const VAZIO: Perda[] = [];
const SEM_EXTRAS: Record<string, Extra> = {};

const sitDe = (s: string): SitId => (s.split(" ")[0] as SitId);
const n = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
const lojaDe = (id: number | null) => (id === 522186766 ? "Ottz" : id === 759046323 ? "Bumi" : String(id ?? "?"));
const dataCurta = (iso: string | null) => (iso ? format(parseISO(iso), "dd/MM/yy") : "—");

async function lerTudo(periodo: Periodo, loja: string, soSemComp: boolean): Promise<Perda[]> {
  const out: Perda[] = [];
  for (let de = 0; ; de += 1000) {
    let q = supabaseExternal.from("view_shopee_perda_logistica").select(COLS);
    if (periodo === "recebidas") q = q.gte("devolucao_em", INICIO_RECEBIDAS);
    if (periodo === "60d") q = q.gte("devolucao_em", new Date(Date.now() - 60 * 86400000).toISOString());
    if (loja === "ottz") q = q.eq("shop_id", 522186766);
    if (loja === "bumi") q = q.eq("shop_id", 759046323);
    if (soSemComp) q = q.eq("compensado_sim", false);
    const { data, error } = await q.order("order_sn").range(de, de + 999);
    if (error) throw error;
    out.push(...((data ?? []) as Perda[]));
    if ((data ?? []).length < 1000) return out;
  }
}

function csv(linhas: (string | number | null)[][]): string {
  const cel = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return linhas.map((l) => l.map(cel).join(";")).join("\n");
}

export function DevolucoesShopeePerdas({ onDarEntrada }: { onDarEntrada: (orderSn: string) => void }) {
  const [periodo, setPeriodo] = useState<Periodo>("recebidas");
  const [loja, setLoja] = useState<"todas" | "ottz" | "bumi">("todas");
  const [soSemComp, setSoSemComp] = useState(true);
  const [sits, setSits] = useState<Set<SitId>>(() => new Set(PADRAO));
  const [busca, setBusca] = useState("");
  const [limite, setLimite] = useState(100);

  const perdasQ = useQuery({
    queryKey: ["devolucoes", "shopee_perdas", periodo, loja, soSemComp],
    staleTime: 60_000,
    refetchOnMount: true, // volta da aba Recebidas: quem teve entrada precisa sair
    queryFn: () => lerTudo(periodo, loja, soSemComp),
  });
  const todas = perdasQ.data ?? VAZIO;

  // contagem por situação com os demais filtros aplicados (chips)
  const porSit = useMemo(() => {
    const m = new Map<SitId, { qtd: number; valor: number }>();
    for (const p of todas) {
      const k = sitDe(p.situacao);
      const cur = m.get(k) ?? { qtd: 0, valor: 0 };
      cur.qtd += 1; cur.valor += n(p.valor_reembolsado);
      m.set(k, cur);
    }
    return m;
  }, [todas]);

  const filtradas = useMemo(() => {
    const b = busca.trim().toUpperCase();
    return todas
      .filter((p) => sits.has(sitDe(p.situacao)))
      .filter((p) => !b || p.order_sn.includes(b) || (p.return_sn ?? "").includes(b))
      .sort((a, b2) => {
        const oa = SITUACOES.findIndex((s) => s.id === sitDe(a.situacao));
        const ob = SITUACOES.findIndex((s) => s.id === sitDe(b2.situacao));
        if (oa !== ob) return oa - ob;
        return (b2.dias_desde_evento ?? 0) - (a.dias_desde_evento ?? 0);
      });
  }, [todas, sits, busca]);

  const totais = useMemo(() => filtradas.reduce(
    (t, p) => ({ reemb: t.reemb + n(p.valor_reembolsado), cmv: t.cmv + n(p.cmv), comp: t.comp + n(p.compensado) }),
    { reemb: 0, cmv: 0, comp: 0 },
  ), [filtradas]);

  // Itens (SKU) e rastreios dos pedidos filtrados — não estão na view.
  const chaveExtra = useMemo(() => filtradas.map((p) => p.order_sn), [filtradas]);
  const extrasQ = useQuery({
    queryKey: ["devolucoes", "shopee_perdas_extra", chaveExtra],
    enabled: chaveExtra.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Record<string, Extra>> => {
      const map: Record<string, Extra> = {};
      const returnSns = filtradas.map((p) => p.return_sn).filter((x): x is string => !!x);
      const infos = await buscarInfoDevolucao(returnSns);
      for (const info of Object.values(infos)) {
        if (!info.order_sn) continue;
        map[info.order_sn] = { itens: info.itens ?? [], rastreioIda: null, rastreioVolta: info.tracking_number, info };
      }
      for (let i = 0; i < chaveExtra.length; i += 200) {
        const { data, error } = await supabaseExternal.from("shopee_rastreio")
          .select("order_sn, tracking_number").in("order_sn", chaveExtra.slice(i, i + 200));
        if (error) throw error;
        for (const r of (data ?? []) as { order_sn: string; tracking_number: string | null }[]) {
          map[r.order_sn] = { ...(map[r.order_sn] ?? { itens: [], rastreioVolta: null }), rastreioIda: r.tracking_number };
        }
      }
      return map;
    },
  });
  const extras = extrasQ.data ?? SEM_EXTRAS;

  const visiveis = useMemo(() => filtradas.slice(0, limite), [filtradas, limite]);
  const skusFoto = useMemo(
    () => Array.from(new Set(visiveis.map((p) => extras[p.order_sn]?.itens?.[0]?.sku).filter((x): x is string => !!x))).sort(),
    [visiveis, extras],
  );
  const fotosQ = useQuery({
    queryKey: ["devolucoes", "fotos_perdas", skusFoto],
    enabled: skusFoto.length > 0,
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<Record<string, string>> => {
      const map: Record<string, string> = {};
      for (let i = 0; i < skusFoto.length; i += 300) {
        const { data } = await supabaseExternal.from("view_foto_produto").select("sku,foto").in("sku", skusFoto.slice(i, i + 300));
        for (const r of (data ?? []) as { sku: string; foto: string | null }[]) if (r.foto) map[r.sku] = r.foto;
      }
      return map;
    },
  });

  function alternar(id: SitId) {
    setLimite(100);
    setSits((cur) => {
      const nx = new Set(cur);
      if (nx.has(id)) nx.delete(id); else nx.add(id);
      return nx;
    });
  }

  function baixarCsv() {
    const linhas: (string | number | null)[][] = [[
      "loja", "pedido", "data_pedido", "situacao", "ultimo_evento_rastreio", "data_evento", "dias_parado",
      "motivo_comprador", "solucao_reembolso", "status_solicitacao", "status_entrega", "reembolsado", "cmv", "compensado", "skus", "rastreio_ida", "rastreio_volta", "recebido_em",
    ]];
    for (const p of filtradas) {
      const ex = extras[p.order_sn];
      linhas.push([
        lojaDe(p.shop_id), p.order_sn, dataCurta(p.data_pedido), p.situacao, p.ida_ultimo_evento, dataCurta(p.ida_ultimo_em),
        p.dias_desde_evento, MOTIVO_PT[p.motivo_devolucao ?? ""] ?? p.motivo_devolucao,
        solucaoReembolso(ex?.info).rotulo, statusSolicitacao(ex?.info).rotulo,
        [statusEntrega(ex?.info).rotulo, statusEntrega(ex?.info).detalhe].filter(Boolean).join(" · "),
        n(p.valor_reembolsado).toFixed(2).replace(".", ","), n(p.cmv).toFixed(2).replace(".", ","), n(p.compensado).toFixed(2).replace(".", ","),
        (ex?.itens ?? []).map((i) => `${i.sku ?? "?"} x${i.qtd ?? 1}`).join(" + "),
        ex?.rastreioIda ?? "", ex?.rastreioVolta ?? "", dataCurta(p.produto_recebido_em),
      ]);
    }
    const blob = new Blob(["﻿" + csv(linhas)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `perdas-shopee-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold">Perdas Shopee — reembolso sem o produto de volta</h2>
        <p className="text-[13px] text-muted-foreground max-w-[900px]">
          Pedidos que a Shopee reembolsou <b>sem devolução do produto</b>, cruzados com o rastreio da entrega e com a
          entrada em Recebidas. Procure no galpão; o que não estiver lá e não tiver compensação, cobre a Shopee no Seller Center.
        </p>
      </div>

      {/* filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["recebidas", "Desde 10/ago"], ["60d", "60 dias"], ["tudo", "Tudo"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setPeriodo(id); setLimite(100); }}
              title={id === "recebidas" ? "Início do registro de Recebidas — antes disso não dá para saber se voltou" : undefined}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                periodo === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([["todas", "Ambas"], ["ottz", "Ottz"], ["bumi", "Bumi"]] as const).map(([id, rot]) => (
            <button key={id} onClick={() => { setLoja(id); setLimite(100); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                loja === id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {([[true, "Sem compensação"], [false, "Todas"]] as const).map(([v, rot]) => (
            <button key={rot} onClick={() => { setSoSemComp(v); setLimite(100); }}
              className={cn("px-2.5 py-1.5 text-xs font-semibold rounded-md transition",
                soSemComp === v ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground")}>
              {rot}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={busca} onChange={(e) => { setBusca(e.target.value); setLimite(100); }}
            placeholder="Pedido ou devolução" className="h-8 w-[190px] pl-8 text-xs" />
        </div>
        <div className="flex gap-2 ml-auto">
          <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={filtradas.length === 0} onClick={baixarCsv}>
            <Download className="h-3.5 w-3.5" /> Planilha (CSV)
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5 h-8" disabled={perdasQ.isFetching}
            onClick={() => void perdasQ.refetch()}>
            {perdasQ.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Atualizar
          </Button>
        </div>
      </div>

      {/* situações (multi-seleção) */}
      <div className="flex flex-wrap gap-2">
        {SITUACOES.map((s, i) => {
          const c = porSit.get(s.id) ?? { qtd: 0, valor: 0 };
          const ativo = sits.has(s.id);
          const quebra = i > 0 && SITUACOES[i - 1].grupo !== s.grupo;
          return (
            <div key={s.id} className={cn("flex", quebra && "ml-2 pl-3 border-l")}>
              <button onClick={() => alternar(s.id)} title={s.dica}
                className={cn("text-left rounded-xl border px-3 py-2 min-w-[132px] transition-colors",
                  ativo ? "bg-card" : "bg-muted/40 opacity-60 hover:opacity-100")}
                style={ativo ? { borderColor: s.cor, boxShadow: `inset 0 0 0 1px ${s.cor}` } : undefined}>
                <div className="text-[10.5px] font-bold uppercase tracking-wide" style={{ color: s.cor }}>{s.rotulo}</div>
                <div className="text-lg font-extrabold tabular-nums leading-tight">{c.qtd}</div>
                <div className="text-[11px] text-muted-foreground tabular-nums">{formatBRL(c.valor)}</div>
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted-foreground">
        <span><b className="text-foreground tabular-nums">{filtradas.length}</b> pedido(s) selecionado(s)</span>
        <span>Reembolsado <b className="text-foreground tabular-nums">{formatBRL(totais.reemb)}</b></span>
        <span>CMV (produto) <b className="text-foreground tabular-nums">{formatBRL(totais.cmv)}</b></span>
        {!soSemComp && <span>Compensado <b className="tabular-nums" style={{ color: "#0E8A5F" }}>{formatBRL(totais.comp)}</b></span>}
      </div>

      {perdasQ.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : perdasQ.isError ? (
        <Card className="p-6 text-sm text-destructive">Erro ao carregar: {(perdasQ.error as Error).message}</Card>
      ) : filtradas.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground">Nada com esses filtros.</Card>
      ) : (
        <div className="flex flex-col gap-2">
          {visiveis.map((p) => {
            const s = SITUACOES.find((x) => x.id === sitDe(p.situacao)) ?? SITUACOES[0];
            const ex = extras[p.order_sn];
            const item = ex?.itens?.[0];
            const foto = item?.sku ? fotosQ.data?.[item.sku] : undefined;
            return (
              <Card key={p.order_sn} className="p-0 overflow-hidden" style={{ borderLeft: `4px solid ${s.cor}` }}>
                <div className="flex flex-wrap items-start gap-3 p-3">
                  {foto ? (
                    <img src={foto} alt="" loading="lazy" className="w-14 h-14 rounded-lg object-cover bg-muted border shrink-0" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <PackageIcon className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}

                  <div className="flex-1 min-w-[260px] space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-bold">{p.order_sn}</span>
                      <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{lojaDe(p.shop_id)}</span>
                      <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full" style={{ background: `${s.cor}1F`, color: s.cor }}>{s.rotulo}</span>
                      <span className="text-[11px] text-muted-foreground">pedido {dataCurta(p.data_pedido)}</span>
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {(ex?.itens ?? []).length === 0
                        ? (extrasQ.isLoading ? "carregando itens…" : "itens não informados")
                        : ex!.itens.map((it, i) => (
                          <span key={i} className="mr-3">
                            <span className="font-mono font-semibold text-foreground">{it.sku ?? "?"}</span>
                            {it.nome ? ` ${String(it.nome).slice(0, 50)}${String(it.nome).length > 50 ? "…" : ""}` : ""} ×{it.qtd ?? 1}
                          </span>
                        ))}
                    </div>
                    <div className="text-[12px]">
                      <span className="font-semibold">{p.ida_ultimo_evento ?? "sem evento"}</span>
                      <span className="text-muted-foreground">
                        {" "}· {dataCurta(p.ida_ultimo_em)}
                        {p.dias_desde_evento != null && <> · há <b className="text-foreground">{p.dias_desde_evento}</b> dia(s)</>}
                        {ex?.rastreioIda && <> · ida <span className="font-mono">{ex.rastreioIda}</span></>}
                        {ex?.rastreioVolta && <> · volta <span className="font-mono">{ex.rastreioVolta}</span></>}
                      </span>
                    </div>
                    <div className="text-[11.5px] text-muted-foreground truncate max-w-[720px]" title={p.texto_comprador ?? undefined}>
                      <span className="font-semibold" style={{ color: "#B7791F" }}>
                        {MOTIVO_PT[p.motivo_devolucao ?? ""] ?? p.motivo_devolucao ?? "—"}
                      </span>
                      {p.texto_comprador ? <> — “{p.texto_comprador}”</> : null}
                      {p.produto_recebido_em && <span style={{ color: "#0E8A5F" }}> · recebido {dataCurta(p.produto_recebido_em)}</span>}
                    </div>
                    <InfoDevolucaoCampos info={ex?.info} carregando={extrasQ.isLoading} />
                  </div>

                  <div className="text-right text-[12px] space-y-0.5 min-w-[130px]">
                    <div><span className="text-muted-foreground">reembolso </span><b className="tabular-nums">{formatBRL(n(p.valor_reembolsado))}</b></div>
                    <div><span className="text-muted-foreground">CMV </span><span className="tabular-nums">{formatBRL(n(p.cmv))}</span></div>
                    {n(p.compensado) > 0 && (
                      <div style={{ color: "#0E8A5F" }}>compensado <b className="tabular-nums">{formatBRL(n(p.compensado))}</b></div>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 shrink-0">
                    {!p.produto_recebido_em && (
                      <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={() => onDarEntrada(p.order_sn)}
                        title="Abre Recebidas com este pedido para registrar que o produto voltou">
                        <PackageOpen className="h-3.5 w-3.5" /> Dar entrada
                      </Button>
                    )}
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="h-7 px-2" title="Copiar número do pedido"
                        onClick={() => { void navigator.clipboard.writeText(p.order_sn); toast.success("Pedido copiado"); }}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 px-2 gap-1 text-xs" asChild title="Abrir no Seller Center">
                        <a href={`https://seller.shopee.com.br/portal/sale/order/${p.order_sn}`} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" /> Shopee
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
          {filtradas.length > limite && (
            <Button variant="outline" className="self-center" onClick={() => setLimite((l) => l + 100)}>
              Mostrar mais ({filtradas.length - limite} restantes)
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
