import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch, Loader2, Check, ScanLine, AlertTriangle, Package as PackageIcon, Minus, Plus, ClipboardCheck } from "lucide-react";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useAuth } from "@/hooks/useAuth";

// ============================================================================
// Devoluções recebidas (Fase A) — o pacote físico chega, o operador bipa/digita
// o rastreio (BR…) ou o nº do pedido; casa com o pedido e:
//   (a) "Só registrar" — dá entrada rápida (status 'recebida', a conferir); ou
//   (b) "Registrar conferido" — já confere itens (qtd + estado) -> 'conferida'.
// A lista permite CONFERIR depois um registro pendente. Mostra o status Shopee.
// Backend: devolucoes_recebidas + devolucao_recebida_itens. Sem edge function.
// ============================================================================

type Estado = "ok" | "quebrado" | "furado" | "faltando";
const ESTADOS: { id: Estado; label: string; cor: string }[] = [
  { id: "ok", label: "OK", cor: "#0E8A5F" },
  { id: "quebrado", label: "Quebrado", cor: "#C9432F" },
  { id: "furado", label: "Furado", cor: "#C9432F" },
  { id: "faltando", label: "Faltando", cor: "#B7791F" },
];

function canalCor(m: string | null): string {
  const u = (m ?? "").toUpperCase();
  if (u.includes("SHOPEE")) return "#EE4D2D";
  if (u.includes("MERCADO")) return "#B7791F";
  if (u.includes("AMAZON")) return "#2F6FB0";
  return "#6C7481";
}
function situacaoCor(s: string | null): string {
  const u = (s ?? "").toLowerCase();
  if (u.includes("entreg")) return "#0E8A5F";
  if (u.includes("trânsit") || u.includes("transit")) return "#2F6FB0";
  return "#6C7481";
}
function shopeeCor(s: string | null): string {
  const u = (s ?? "").toUpperCase();
  if (u === "COMPLETED") return "#0E8A5F";
  if (u === "TO_RETURN" || u === "CANCELLED" || u === "IN_CANCEL") return "#C9432F";
  if (u === "TO_CONFIRM_RECEIVE" || u === "SHIPPED" || u === "PROCESSED") return "#2F6FB0";
  return "#6C7481";
}
function envioCor(e: string | null): string {
  const u = (e ?? "").toLowerCase();
  if (u.includes("full")) return "#6E56CF";
  if (u.includes("xpress") || u.includes("spx")) return "#EE4D2D";
  if (u.includes("rápid") || u.includes("rapid") || u.includes("turbo")) return "#B7791F";
  if (u.includes("mercado") || u.includes("meli")) return "#2F6FB0";
  return "#6C7481";
}

interface ItemEsperado { sku: string | null; nome: string | null; qtd: number }
interface Conferido { sku: string | null; nome: string | null; qtd_esperada: number; qtd_recebida: number; estado: Estado; obs: string }
interface PedidoMatch {
  order_sn: string | null; tiny_numero: string | null; marca_canal: string | null;
  situacao: string | null; shopee_status: string | null; rastreio: string | null;
  forma_envio: string | null; itens: ItemEsperado[]; ja_recebida_em: string | null;
}
interface Recebida {
  id: string; order_sn: string | null; tiny_numero: string | null; marca_canal: string | null;
  shopee_status: string | null; forma_envio: string | null; status: string; recebido_em: string; recebido_por: string | null;
  conferido_ok: boolean | null; observacao: string | null; devolucao_recebida_itens?: { sku: string | null }[];
}

const num = (x: unknown) => { const n = Number(x ?? 0); return Number.isFinite(n) ? n : 0; };
const empresaDoCanal = (m: string | null) => (/sevilla|svl/i.test(m ?? "") ? "SVL Store" : "ACZ Pet");
const marketplaceDoCanal = (m: string | null): string | null => {
  const u = (m ?? "").toLowerCase();
  if (u.includes("shopee")) return "shopee";
  if (u.includes("mercado")) return "mercadolivre";
  if (u.includes("amazon")) return "amazon";
  return null;
};

function construirItens(sep: { itens_json?: unknown; sku_unico?: string | null; nome_produto?: string | null; qtd_unidades?: number | string | null } | undefined): ItemEsperado[] {
  if (!sep) return [];
  const arr = sep.itens_json as Array<{ produto?: { sku?: string; descricao?: string }; quantidade?: number | string }> | null;
  if (Array.isArray(arr) && arr.length) {
    return arr.map((it) => ({ sku: it.produto?.sku ?? null, nome: it.produto?.descricao ?? null, qtd: num(it.quantidade) }));
  }
  if (sep.sku_unico) return [{ sku: sep.sku_unico, nome: sep.nome_produto ?? null, qtd: num(sep.qtd_unidades) }];
  return [];
}

function useFotos(skus: (string | null | undefined)[]) {
  const chave = useMemo(() => Array.from(new Set(skus.filter((s): s is string => !!s))).sort(), [skus]);
  return useQuery({
    queryKey: ["devrec", "fotos", chave],
    enabled: chave.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<Record<string, string>> => {
      const map: Record<string, string> = {};
      for (let i = 0; i < chave.length; i += 300) {
        const lote = chave.slice(i, i + 300);
        const { data } = await supabaseExternal.from("view_foto_produto").select("sku,foto").in("sku", lote);
        for (const r of (data ?? []) as { sku: string; foto: string | null }[]) if (r.foto) map[r.sku] = r.foto;
      }
      return map;
    },
  });
}

function Foto({ url, nome, className }: { url?: string | null; nome?: string | null; className?: string }) {
  if (!url) {
    return (
      <div className={cn("rounded-[13px] bg-muted flex items-center justify-center shrink-0", className)}>
        <PackageIcon className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }
  return (
    <img src={url} alt={nome ?? ""} loading="lazy"
      className={cn("rounded-[13px] object-cover bg-muted shrink-0", className)}
      onError={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")} />
  );
}

function Pill({ cor, children }: { cor: string; children: ReactNode }) {
  return (
    <span className="text-[12px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
      style={{ background: `${cor}1F`, color: cor }}>
      {children}
    </span>
  );
}

export function DevolucoesRecebidas() {
  const { user } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [termo, setTermo] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pedido, setPedido] = useState<PedidoMatch | null>(null);
  const [conf, setConf] = useState<Conferido[]>([]);
  const [obs, setObs] = useState("");
  const [salvando, setSalvando] = useState(false);
  // Se setado, estamos conferindo um registro JÁ existente (da lista).
  const [conferindoId, setConferindoId] = useState<string | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const listaQ = useQuery({
    queryKey: ["devolucoes-recebidas"],
    queryFn: async (): Promise<Recebida[]> => {
      const { data, error } = await supabaseExternal
        .from("devolucoes_recebidas")
        .select("id, order_sn, tiny_numero, marca_canal, shopee_status, forma_envio, status, recebido_em, recebido_por, conferido_ok, observacao, devolucao_recebida_itens(sku)")
        .order("recebido_em", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Recebida[];
    },
    refetchOnWindowFocus: false,
  });

  const lista = listaQ.data ?? [];
  const fotosItens = useFotos(conf.map((c) => c.sku));
  const fotosLista = useFotos(lista.map((r) => r.devolucao_recebida_itens?.[0]?.sku));

  function limpar() { setTermo(""); setPedido(null); setConf([]); setObs(""); setConferindoId(null); inputRef.current?.focus(); }

  async function buscar() {
    const raw = termo.trim();
    if (!raw) return;
    setBuscando(true); setErro(null); setPedido(null); setConf([]); setConferindoId(null); setObs("");
    try {
      const brMatch = raw.match(/BR[A-Z0-9]{6,}/i);
      const br = brMatch ? brMatch[0] : null;
      const ors = [`numero_ecommerce.eq.${raw}`, `numero_pedido.eq.${raw}`];
      if (br) ors.push(`codigo_rastreamento.ilike.${br}*`);
      const { data, error } = await supabaseExternal
        .from("pedidos_tiny")
        .select("numero_ecommerce, numero_pedido, marca_canal, situacao, codigo_rastreamento, forma_envio")
        .or(ors.join(","))
        .limit(5);
      if (error) throw error;
      if (!data || data.length === 0) {
        setErro(`Pedido não encontrado para "${raw}". Confira o código e tente de novo.`);
        return;
      }
      const pt = data[0] as { numero_ecommerce: string | null; numero_pedido: string | null; marca_canal: string | null; situacao: string | null; codigo_rastreamento: string | null; forma_envio: string | null };

      const [{ data: sepRows }, { data: pRow }, { data: jaRec }] = await Promise.all([
        supabaseExternal.from("separacao_tiny").select("sku_unico, nome_produto, qtd_unidades, qtd_skus, itens_json").eq("numero_ecommerce", pt.numero_ecommerce).limit(1),
        supabaseExternal.from("pedidos").select("status_pedido, opcao_envio").eq("id", pt.numero_ecommerce ?? "").maybeSingle(),
        supabaseExternal.from("devolucoes_recebidas").select("recebido_em").eq("order_sn", pt.numero_ecommerce).order("recebido_em", { ascending: false }).limit(1),
      ]);
      const p = pRow as { status_pedido?: string; opcao_envio?: string } | null;
      const itens = construirItens(sepRows?.[0]);
      setPedido({
        order_sn: pt.numero_ecommerce, tiny_numero: pt.numero_pedido, marca_canal: pt.marca_canal,
        situacao: pt.situacao, shopee_status: p?.status_pedido ?? null,
        forma_envio: p?.opcao_envio || pt.forma_envio || null,
        rastreio: pt.codigo_rastreamento, itens,
        ja_recebida_em: (jaRec?.[0]?.recebido_em as string) ?? null,
      });
      setConf(itens.map((it) => ({ sku: it.sku, nome: it.nome, qtd_esperada: it.qtd, qtd_recebida: it.qtd, estado: "ok", obs: "" })));
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setBuscando(false);
      inputRef.current?.focus();
    }
  }

  // Abre a conferência de um registro JÁ recebido (pendente) a partir da lista.
  async function abrirConferencia(r: Recebida) {
    const { data: itens } = await supabaseExternal
      .from("devolucao_recebida_itens")
      .select("sku, nome_produto, qtd_esperada, qtd_recebida, estado, observacao")
      .eq("devolucao_id", r.id).order("criado_em", { ascending: true });
    setPedido({
      order_sn: r.order_sn, tiny_numero: r.tiny_numero, marca_canal: r.marca_canal,
      situacao: null, shopee_status: r.shopee_status, forma_envio: r.forma_envio, rastreio: null, itens: [], ja_recebida_em: null,
    });
    setConf((itens ?? []).map((it) => {
      const i = it as { sku: string | null; nome_produto: string | null; qtd_esperada: number; qtd_recebida: number | null; estado: string | null; observacao: string | null };
      return { sku: i.sku, nome: i.nome_produto, qtd_esperada: num(i.qtd_esperada), qtd_recebida: i.qtd_recebida == null ? num(i.qtd_esperada) : num(i.qtd_recebida), estado: (i.estado as Estado) ?? "ok", obs: i.observacao ?? "" };
    }));
    setObs(r.observacao ?? "");
    setConferindoId(r.id);
    setErro(null); setTermo("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setConfItem(i: number, patch: Partial<Conferido>) {
    setConf((old) => old.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  async function salvar(conferir: boolean) {
    if (!pedido) return;
    setSalvando(true);
    try {
      const conferidoOk = conferir ? conf.every((c) => c.estado === "ok" && c.qtd_recebida === c.qtd_esperada) : null;

      if (conferindoId) {
        // Conferência de um registro já existente -> UPDATE.
        const { error } = await supabaseExternal.from("devolucoes_recebidas").update({
          status: "conferida", conferido_ok: conferidoOk, observacao: obs.trim() || null, atualizado_em: new Date().toISOString(),
        }).eq("id", conferindoId);
        if (error) throw error;
        await supabaseExternal.from("devolucao_recebida_itens").delete().eq("devolucao_id", conferindoId);
        if (conf.length) {
          const linhas = conf.map((c) => ({
            devolucao_id: conferindoId, sku: c.sku, nome_produto: c.nome, qtd_esperada: c.qtd_esperada,
            qtd_recebida: c.qtd_recebida, estado: c.estado, observacao: c.obs.trim() || null,
          }));
          const { error: e2 } = await supabaseExternal.from("devolucao_recebida_itens").insert(linhas);
          if (e2) throw e2;
        }
        toast.success(`Conferência do pedido ${pedido.order_sn} salva`, { description: conferidoOk ? "Tudo certo ✓" : "Com ressalva" });
      } else {
        // Novo registro (scan) -> INSERT (só registrar OU já conferido).
        const { data: dev, error } = await supabaseExternal.from("devolucoes_recebidas").insert({
          order_sn: pedido.order_sn, tiny_numero: pedido.tiny_numero, rastreio: pedido.rastreio,
          marketplace: marketplaceDoCanal(pedido.marca_canal), marca_canal: pedido.marca_canal,
          empresa: empresaDoCanal(pedido.marca_canal), shopee_status: pedido.shopee_status,
          forma_envio: pedido.forma_envio,
          status: conferir ? "conferida" : "recebida", recebido_por: user?.email ?? null,
          conferido_ok: conferidoOk, observacao: obs.trim() || null,
        }).select("id").single();
        if (error) throw error;
        const devId = (dev as { id: string }).id;
        if (conf.length) {
          const linhas = conf.map((c) => ({
            devolucao_id: devId, sku: c.sku, nome_produto: c.nome, qtd_esperada: c.qtd_esperada,
            qtd_recebida: conferir ? c.qtd_recebida : null, estado: conferir ? c.estado : null, observacao: c.obs.trim() || null,
          }));
          const { error: e2 } = await supabaseExternal.from("devolucao_recebida_itens").insert(linhas);
          if (e2) throw e2;
        }
        toast.success(
          conferir ? `Devolução ${pedido.order_sn} registrada e conferida` : `Devolução ${pedido.order_sn} registrada — a conferir`,
          { description: conferir ? (conferidoOk ? "Tudo certo ✓" : "Com ressalva") : "Confira os itens quando quiser, pela lista." },
        );
      }
      limpar();
      listaQ.refetch();
    } catch (e) {
      toast.error("Falha ao salvar devolução", { description: (e as Error).message });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Barra de recebimento (scan-first) */}
      <Card className="p-5 border-[1.5px] border-primary flex flex-col gap-3">
        <form onSubmit={(e) => { e.preventDefault(); void buscar(); }} className="flex items-center gap-3.5">
          <ScanLine className="h-6 w-6 text-primary shrink-0" />
          <input
            ref={inputRef}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Rastreio (BR…) ou nº do pedido"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none font-mono text-[22px] font-semibold text-foreground placeholder:text-muted-foreground/60"
          />
          <Button type="submit" className="h-12 px-6 text-[14.5px] font-bold gap-2 shrink-0" disabled={buscando || !termo.trim()}>
            {buscando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackageSearch className="h-4 w-4" />}
            Buscar
          </Button>
        </form>
        {erro && (
          <div className="flex items-center gap-2 rounded-[10px] px-3.5 py-2.5" style={{ background: "#C9432F14", border: "1px solid #C9432F40" }}>
            <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "#C9432F" }} />
            <span className="text-[13px] font-medium" style={{ color: "#C9432F" }}>{erro}</span>
          </div>
        )}
      </Card>

      {/* Pedido encontrado + conferência */}
      {pedido && (
        <Card className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-2.5">
            {conferindoId && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary self-start">
                <ClipboardCheck className="h-3.5 w-3.5" /> Conferindo devolução já registrada
              </span>
            )}
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-2xl font-extrabold font-mono tracking-tight">{pedido.order_sn}</span>
              <Pill cor="#6C7481">Tiny {pedido.tiny_numero}</Pill>
              <Pill cor={canalCor(pedido.marca_canal)}>{pedido.marca_canal}</Pill>
              {pedido.forma_envio && <Pill cor={envioCor(pedido.forma_envio)}>{pedido.forma_envio}</Pill>}
              {pedido.situacao && <Pill cor={situacaoCor(pedido.situacao)}><span className="capitalize">{pedido.situacao}</span></Pill>}
              {pedido.shopee_status && <Pill cor={shopeeCor(pedido.shopee_status)}>Shopee: {pedido.shopee_status}</Pill>}
            </div>
            {pedido.rastreio && <span className="text-[12.5px] text-muted-foreground font-mono">{pedido.rastreio}</span>}
            {pedido.ja_recebida_em && !conferindoId && (
              <div className="inline-flex items-center gap-2 rounded-[10px] px-3 py-2 self-start" style={{ background: "#B7791F16", border: "1px solid #B7791F44" }}>
                <AlertTriangle className="h-3.5 w-3.5" style={{ color: "#B7791F" }} />
                <span className="text-[12.5px] font-semibold" style={{ color: "#B7791F" }}>
                  Já registrada em {format(parseISO(pedido.ja_recebida_em), "dd/MM HH:mm")}
                </span>
              </div>
            )}
          </div>

          <div className="h-px bg-border" />

          {conf.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sem itens detalhados para este pedido — registre mesmo assim e confira manualmente.</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {conf.map((c, i) => {
                const mismatch = c.qtd_recebida !== c.qtd_esperada;
                const estCor = ESTADOS.find((e) => e.id === c.estado)?.cor ?? "#0E8A5F";
                const tint = c.estado !== "ok" ? estCor : mismatch ? "#B7791F" : null;
                return (
                  <div key={i}
                    className={cn("flex items-center gap-4 rounded-[14px] p-3.5 flex-wrap border-[1.5px]", !tint && "border-border bg-muted/50")}
                    style={tint ? { borderColor: tint, background: `${tint}12` } : undefined}>
                    <Foto url={c.sku ? fotosItens.data?.[c.sku] : undefined} nome={c.nome} className="w-[76px] h-[76px]" />
                    <div className="flex flex-col gap-0.5 min-w-[160px] flex-[1.4]">
                      <span className="text-[14.5px] font-semibold leading-tight line-clamp-2">{c.nome ?? "—"}</span>
                      <span className="text-[11.5px] text-muted-foreground font-mono">SKU {c.sku ?? "—"}</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[22px] font-extrabold tabular-nums leading-none">{c.qtd_esperada}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Esperado</span>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setConfItem(i, { qtd_recebida: Math.max(0, c.qtd_recebida - 1) })} disabled={c.qtd_recebida <= 0}>
                          <Minus className="h-3.5 w-3.5" />
                        </Button>
                        <Input value={String(c.qtd_recebida)} onChange={(e) => setConfItem(i, { qtd_recebida: Math.max(0, parseInt(e.target.value.replace(/[^\d]/g, ""), 10) || 0) })}
                          inputMode="numeric" className="h-8 w-12 text-center text-[18px] font-extrabold font-mono px-1 tabular-nums" />
                        <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setConfItem(i, { qtd_recebida: c.qtd_recebida + 1 })}>
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Recebido</span>
                    </div>
                    <div className="flex gap-1.5 flex-wrap">
                      {ESTADOS.map((e) => {
                        const active = c.estado === e.id;
                        return (
                          <button key={e.id} onClick={() => setConfItem(i, { estado: e.id })}
                            className="text-[11.5px] font-bold px-2.5 py-1.5 rounded-[8px] cursor-pointer transition-colors"
                            style={{ border: `1.5px solid ${e.cor}`, background: active ? e.cor : "transparent", color: active ? "#fff" : e.cor }}>
                            {e.label}
                          </button>
                        );
                      })}
                    </div>
                    <Input value={c.obs} onChange={(e) => setConfItem(i, { obs: e.target.value })} placeholder="Observação do item"
                      className="h-8 flex-1 min-w-[140px] text-[12.5px]" />
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <Input value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observação geral"
              className="flex-1 min-w-[220px] h-11 bg-muted/50" />
            <Button variant="outline" className="h-11 px-4" onClick={limpar}>Cancelar</Button>
            {conferindoId ? (
              <Button className="h-11 px-5 gap-2 font-bold" disabled={salvando} onClick={() => void salvar(true)}>
                {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                Salvar conferência
              </Button>
            ) : (
              <>
                <Button variant="outline" className="h-11 px-4 gap-2" disabled={salvando} onClick={() => void salvar(false)}
                  title="Dá entrada agora; a conferência dos itens fica pra depois (pela lista)">
                  {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Só registrar
                </Button>
                <Button className="h-11 px-5 gap-2 font-bold" disabled={salvando} onClick={() => void salvar(true)}>
                  {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                  Registrar conferido
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      {/* Lista de recebidas */}
      <div className="flex flex-col gap-3">
        <span className="text-[13px] font-semibold">Devoluções recebidas</span>
        {listaQ.isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : lista.length === 0 ? (
          <Card className="border-dashed py-11 px-8 flex items-center justify-center">
            <span className="text-[13.5px] text-muted-foreground">Nenhuma devolução recebida ainda — bipe uma etiqueta para começar</span>
          </Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="bg-muted/50 border-b text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-[80px] py-3 px-4"></th>
                    <th className="text-left py-3 px-2 font-bold whitespace-nowrap">Recebido</th>
                    <th className="text-left py-3 px-2 font-bold whitespace-nowrap">Pedido</th>
                    <th className="text-left py-3 px-2 font-bold whitespace-nowrap">Canal</th>
                    <th className="text-left py-3 px-2 font-bold whitespace-nowrap">Conferência / Observação</th>
                    <th className="text-left py-3 px-2 font-bold whitespace-nowrap">Por</th>
                  </tr>
                </thead>
                <tbody>
                  {lista.map((r) => {
                    const sku = r.devolucao_recebida_itens?.[0]?.sku ?? null;
                    const cCor = canalCor(r.marca_canal);
                    const pendente = r.status === "recebida";
                    return (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 px-4"><Foto url={sku ? fotosLista.data?.[sku] : undefined} className="w-[60px] h-[60px] rounded-[14px]" /></td>
                        <td className="py-3 px-2 text-[12.5px] text-muted-foreground font-mono whitespace-nowrap">{format(parseISO(r.recebido_em), "dd/MM HH:mm")}</td>
                        <td className="py-3 px-2 min-w-0">
                          <div className="flex flex-col leading-tight gap-0.5">
                            <span className="text-[12.5px] font-semibold font-mono truncate">{r.order_sn}</span>
                            <span className="text-[10.5px] text-muted-foreground">Tiny {r.tiny_numero}</span>
                            {r.shopee_status && (
                              <span className="text-[10px] font-semibold" style={{ color: shopeeCor(r.shopee_status) }}>Shopee: {r.shopee_status}</span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-2">
                          <div className="flex flex-col gap-1 items-start">
                            <span className="text-[11.5px] font-medium px-2.5 py-1 rounded-md whitespace-nowrap" style={{ background: `${cCor}1F`, color: cCor }}>{r.marca_canal}</span>
                            {r.forma_envio && <span className="text-[10.5px] font-semibold" style={{ color: envioCor(r.forma_envio) }}>{r.forma_envio}</span>}
                          </div>
                        </td>
                        <td className="py-3 px-2 min-w-0">
                          {pendente ? (
                            <div className="flex items-center gap-2">
                              <span className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap shrink-0" style={{ background: "#B7791F1F", color: "#B7791F" }}>A conferir</span>
                              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => void abrirConferencia(r)}>
                                <ClipboardCheck className="h-3.5 w-3.5" /> Conferir
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3 min-w-0">
                              {r.conferido_ok ? (
                                <span className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap shrink-0" style={{ background: "#0E8A5F1F", color: "#0E8A5F" }}>Tudo certo ✓</span>
                              ) : (
                                <span className="text-[11.5px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap shrink-0" style={{ background: "#B7791F1F", color: "#B7791F" }}>Com ressalva ⚠</span>
                              )}
                              <span className="text-[12.5px] text-muted-foreground truncate">{r.observacao ?? ""}</span>
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-2 text-[12.5px] whitespace-nowrap">{(r.recebido_por ?? "").split("@")[0]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
