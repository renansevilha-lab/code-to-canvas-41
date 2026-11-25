// ============================================================================
// Gestão do ADS da Amazon pela tela (24/nov/2026, pedido do dono: "escalar
// alguns produtos lá dentro"). Escreve pela edge fn `amazon-ads-sync`
// (POST {modulo:"gestao"}): prévia (só leitura) → confirmação → envio UMA vez,
// só com login com o módulo ads. A resposta da Amazon fica em debug_fulfillment
// (modulo 'amazon-ads-gestao'). Só a conta ACZ (Sponsored Products).
// ============================================================================
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatBRL } from "@/lib/format";
import { supabaseExternal } from "@/integrations/supabase/external-client";

const FN = "amazon-ads-sync";

async function chamarGestao(body: Record<string, unknown>) {
  const { data, error } = await supabaseExternal.functions.invoke(FN, { body: { modulo: "gestao", ...body } });
  if (error) {
    let msg = error.message;
    try { const ctx = (error as { context?: Response }).context; if (ctx) { const j = await ctx.json(); msg = j?.erro ?? msg; } } catch { /* mantém */ }
    throw new Error(msg);
  }
  // deno-lint-ignore no-explicit-any
  return data as Record<string, any>;
}

const selectCls = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const ESTADO_PT: Record<string, string> = { ENABLED: "ativa", PAUSED: "pausada", ARCHIVED: "arquivada" };

// ---------------------------------------------------------------- editar orçamento/estado
export function EditarCampanhaAmz({ campanha, onFeito }: {
  campanha: { campaign_id: string; nome: string | null; orcamento: number | null; status: string | null };
  onFeito: () => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [orc, setOrc] = useState("");
  const [estado, setEstado] = useState("");
  // deno-lint-ignore no-explicit-any
  const [previa, setPrevia] = useState<any[] | null>(null);
  const [ocupado, setOcupado] = useState<"" | "previa" | "aplicar">("");
  const [erro, setErro] = useState("");
  const [feito, setFeito] = useState(false);

  const mudancas = useMemo(() => {
    // deno-lint-ignore no-explicit-any
    const m: any[] = [];
    const o = Number(orc.replace(",", "."));
    if (orc.trim() && Number.isFinite(o) && o > 0 && o !== campanha.orcamento) m.push({ tipo: "campanha", id: campanha.campaign_id, campo: "orcamento", para: o });
    if (estado && estado !== (campanha.status ?? "").toUpperCase()) m.push({ tipo: "campanha", id: campanha.campaign_id, campo: "estado", para: estado });
    return m;
  }, [orc, estado, campanha]);

  function abrir() {
    setAberto(true); setPrevia(null); setErro(""); setFeito(false);
    setOrc(campanha.orcamento != null ? String(campanha.orcamento) : "");
    setEstado((campanha.status ?? "").toUpperCase() || "ENABLED");
  }
  async function conferir() {
    setOcupado("previa"); setErro(""); setPrevia(null);
    try {
      const r = await chamarGestao({ acao: "editar", mudancas });
      setPrevia(r.previa ?? []);
    } catch (e) { setErro((e as Error).message); } finally { setOcupado(""); }
  }
  async function aplicar() {
    const texto = (previa ?? []).map((p) => `· ${p.campo === "estado" ? ESTADO_PT[String(p.hoje)] ?? p.hoje : formatBRL(Number(p.hoje))} → ${p.campo === "estado" ? ESTADO_PT[String(p.para)] ?? p.para : formatBRL(Number(p.para))} (${p.campo})`).join("\n");
    if (!window.confirm(`Aplicar na Amazon, na campanha "${campanha.nome ?? campanha.campaign_id}"?\n\n${texto}`)) return;
    setOcupado("aplicar"); setErro("");
    try {
      const r = await chamarGestao({ acao: "editar", confirmar: true, mudancas });
      if (!r.ok) throw new Error(`a Amazon recusou: ${JSON.stringify(r.resultados ?? r).slice(0, 300)}`);
      setFeito(true); onFeito();
    } catch (e) { setErro((e as Error).message); } finally { setOcupado(""); }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={abrir}>
        <Pencil className="h-3 w-3" /> Editar orçamento e estado
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Editar campanha na Amazon</DialogTitle></DialogHeader>
          <div className="text-sm font-medium truncate">{campanha.nome ?? campanha.campaign_id}</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Orçamento diário (R$)
              <Input value={orc} onChange={(e) => { setOrc(e.target.value); setPrevia(null); setFeito(false); }} inputMode="decimal" className="h-9" />
            </label>
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Estado
              <select className={selectCls} value={estado} onChange={(e) => { setEstado(e.target.value); setPrevia(null); setFeito(false); }}>
                <option value="ENABLED">ativa</option>
                <option value="PAUSED">pausada</option>
                <option value="ARCHIVED">arquivada (não volta)</option>
              </select>
            </label>
          </div>
          {previa && previa.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs flex flex-col gap-1">
              <div className="font-medium">Vai mudar:</div>
              {previa.map((p, i) => (
                <div key={i}>
                  {p.campo === "orcamento" ? <>orçamento {formatBRL(Number(p.hoje))} → <b>{formatBRL(Number(p.para))}</b>/dia</>
                    : <>estado {ESTADO_PT[String(p.hoje)] ?? p.hoje} → <b>{ESTADO_PT[String(p.para)] ?? p.para}</b></>}
                  {(p.avisos ?? []).map((a: string) => <span key={a} className="text-amber-600 dark:text-amber-400"> · {a}</span>)}
                </div>
              ))}
            </div>
          )}
          {erro && <div className="text-xs text-red-600 dark:text-red-400">{erro}</div>}
          {feito && <div className="text-xs text-emerald-600 dark:text-emerald-400">Aplicado na Amazon. A tela atualiza o espelho; o gasto do dia segue chegando 1×/dia.</div>}
          <div className="flex justify-end gap-2">
            {!previa?.length ? (
              <Button size="sm" onClick={conferir} disabled={ocupado !== "" || mudancas.length === 0}>
                {ocupado === "previa" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />} Conferir
              </Button>
            ) : (
              <Button size="sm" onClick={aplicar} disabled={ocupado !== "" || feito}>
                {ocupado === "aplicar" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />} Aplicar na Amazon
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------- criar campanha por SKU
interface MeuSku { sku_amazon: string; asin: string | null; sku: string | null; nome: string | null }
interface Palavra { texto: string; match: "EXACT" | "PHRASE" | "BROAD"; lance: string }

export function CriarCampanhaAmz({ onFeito }: { onFeito: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [seg, setSeg] = useState<"MANUAL" | "AUTO">("MANUAL");
  const [orc, setOrc] = useState("10");
  const [lance, setLance] = useState("0,60");
  const [ativa, setAtiva] = useState(false);
  const [skus, setSkus] = useState<MeuSku[]>([]);
  const [busca, setBusca] = useState("");
  const [palavras, setPalavras] = useState<Palavra[]>([]);
  const [novaPalavra, setNovaPalavra] = useState("");
  const [novoMatch, setNovoMatch] = useState<Palavra["match"]>("EXACT");
  // deno-lint-ignore no-explicit-any
  const [previa, setPrevia] = useState<any | null>(null);
  // deno-lint-ignore no-explicit-any
  const [resultado, setResultado] = useState<any | null>(null);
  const [ocupado, setOcupado] = useState<"" | "previa" | "criar">("");
  const [erro, setErro] = useState("");

  const buscaQ = useQuery({
    queryKey: ["amz-meus-skus", busca],
    enabled: aberto && busca.trim().length >= 2,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<MeuSku[]> => {
      const t = busca.trim();
      const { data, error } = await supabaseExternal.from("pesquisa_amz_meus_skus")
        .select("sku_amazon, asin, sku, nome").eq("conta", "ottz")
        .or(`sku_amazon.ilike.%${t}%,sku.ilike.%${t}%,nome.ilike.%${t}%,asin.ilike.%${t}%`)
        .limit(12);
      if (error) throw new Error(error.message);
      return (data ?? []) as MeuSku[];
    },
  });

  const numBr = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
  const corpo = () => ({
    acao: "criar", nome: nome.trim(), segmentacao: seg, orcamento: numBr(orc), lance_padrao: numBr(lance),
    estado: ativa ? "ENABLED" : "PAUSED", skus: skus.map((s) => s.sku_amazon),
    palavras: palavras.map((p) => ({ texto: p.texto, match: p.match, lance: numBr(p.lance) })),
  });
  function limpar() {
    setPrevia(null); setResultado(null); setErro("");
  }
  async function conferir() {
    setOcupado("previa"); limpar();
    try {
      const r = await chamarGestao(corpo());
      setPrevia(r.previa ?? null);
      if (!r.ok && r.previa?.pendencias?.length) setErro("Pendências: " + r.previa.pendencias.join("; "));
    } catch (e) { setErro((e as Error).message); } finally { setOcupado(""); }
  }
  async function criar(continuar?: { campaignId: string; adGroupId: string | null }) {
    if (!continuar) {
      const resumo = `Criar na Amazon a campanha "${nome.trim()}" (${seg === "AUTO" ? "automática" : "manual"}, ${formatBRL(numBr(orc))}/dia, nasce ${ativa ? "ATIVA" : "pausada"})\n` +
        `· ${skus.length} produto(s): ${skus.map((s) => s.sku_amazon).join(", ")}` +
        (seg === "MANUAL" ? `\n· ${palavras.length} palavra(s)-chave` : "");
      if (!window.confirm(resumo)) return;
    }
    setOcupado("criar"); setErro("");
    try {
      const r = await chamarGestao({ ...corpo(), confirmar: true, ...(continuar ? { continuar } : {}) });
      setResultado(r);
      if (r.ok) onFeito();
      else setErro(r.erro ?? "a Amazon recusou");
    } catch (e) { setErro((e as Error).message); } finally { setOcupado(""); }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => { setAberto(true); limpar(); }}>
        <Plus className="h-3.5 w-3.5" /> Nova campanha
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-base">Nova campanha na Amazon (Produtos Patrocinados)</DialogTitle></DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted-foreground flex flex-col gap-1 col-span-2">
              Nome da campanha
              <Input value={nome} onChange={(e) => { setNome(e.target.value); limpar(); }} className="h-9" placeholder='ex.: "SP | Exata | Areia Ottz Fina"' />
            </label>
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Segmentação
              <select className={selectCls} value={seg} onChange={(e) => { setSeg(e.target.value as "MANUAL" | "AUTO"); limpar(); }}>
                <option value="MANUAL">manual (minhas palavras)</option>
                <option value="AUTO">automática (a Amazon escolhe)</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Orçamento diário (R$)
              <Input value={orc} onChange={(e) => { setOrc(e.target.value); limpar(); }} inputMode="decimal" className="h-9" />
            </label>
            <label className="text-xs text-muted-foreground flex flex-col gap-1">
              Lance padrão do grupo (R$)
              <Input value={lance} onChange={(e) => { setLance(e.target.value); limpar(); }} inputMode="decimal" className="h-9" />
            </label>
            <label className="text-xs text-muted-foreground flex items-center gap-2 mt-4">
              <input type="checkbox" checked={ativa} onChange={(e) => { setAtiva(e.target.checked); limpar(); }} />
              já nascer ativa (desmarcado = nasce pausada)
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium">Produtos (SKU do anúncio na Amazon)</div>
            {skus.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {skus.map((s) => (
                  <span key={s.sku_amazon} className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">
                    <b>{s.sku_amazon}</b>{s.nome && <span className="text-muted-foreground max-w-[180px] truncate">· {s.nome}</span>}
                    <button type="button" onClick={() => { setSkus(skus.filter((x) => x.sku_amazon !== s.sku_amazon)); limpar(); }}><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <Input value={busca} onChange={(e) => setBusca(e.target.value)} className="h-9" placeholder="buscar por SKU, ASIN ou nome…" />
            {busca.trim().length >= 2 && (
              <div className="rounded-md border divide-y max-h-44 overflow-y-auto text-xs">
                {buscaQ.isLoading ? <div className="p-2 text-muted-foreground">buscando…</div>
                  : (buscaQ.data ?? []).length === 0 ? <div className="p-2 text-muted-foreground">nada achado nos anúncios da conta ACZ</div>
                  : (buscaQ.data ?? []).filter((m) => !skus.some((s) => s.sku_amazon === m.sku_amazon)).map((m) => (
                    <button key={m.sku_amazon} type="button" className="w-full text-left p-2 hover:bg-accent/50 flex flex-col"
                      onClick={() => { setSkus([...skus, m]); setBusca(""); limpar(); }}>
                      <span><b>{m.sku_amazon}</b> <span className="text-muted-foreground">· {m.asin}{m.sku ? ` · nosso ${m.sku}` : ""}</span></span>
                      {m.nome && <span className="text-muted-foreground truncate">{m.nome}</span>}
                    </button>
                  ))}
              </div>
            )}
          </div>

          {seg === "MANUAL" && (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs font-medium">Palavras-chave</div>
              {palavras.map((p, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate"><b>{p.texto}</b></span>
                  <select className="h-7 rounded-md border border-input bg-background px-1 text-xs" value={p.match}
                    onChange={(e) => { const c = [...palavras]; c[i] = { ...p, match: e.target.value as Palavra["match"] }; setPalavras(c); limpar(); }}>
                    <option value="EXACT">exata</option><option value="PHRASE">frase</option><option value="BROAD">ampla</option>
                  </select>
                  <Input className="h-7 w-20 text-xs" inputMode="decimal" value={p.lance}
                    onChange={(e) => { const c = [...palavras]; c[i] = { ...p, lance: e.target.value }; setPalavras(c); limpar(); }} />
                  <button type="button" onClick={() => { setPalavras(palavras.filter((_, j) => j !== i)); limpar(); }}><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Input className="h-8 text-xs" placeholder="nova palavra-chave…" value={novaPalavra}
                  onChange={(e) => setNovaPalavra(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && novaPalavra.trim()) { setPalavras([...palavras, { texto: novaPalavra.trim(), match: novoMatch, lance }]); setNovaPalavra(""); limpar(); } }} />
                <select className="h-8 rounded-md border border-input bg-background px-1 text-xs" value={novoMatch} onChange={(e) => setNovoMatch(e.target.value as Palavra["match"])}>
                  <option value="EXACT">exata</option><option value="PHRASE">frase</option><option value="BROAD">ampla</option>
                </select>
                <Button type="button" variant="outline" size="sm" className="h-8" disabled={!novaPalavra.trim()}
                  onClick={() => { setPalavras([...palavras, { texto: novaPalavra.trim(), match: novoMatch, lance }]); setNovaPalavra(""); limpar(); }}>
                  Pôr
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground">Lance por palavra (R$); em branco vale o lance padrão do grupo.</div>
            </div>
          )}

          {previa && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs flex flex-col gap-1">
              <div className="font-medium">Conferido na gestão:</div>
              <div>{previa.nome} · {previa.segmentacao === "AUTO" ? "automática" : "manual"} · {formatBRL(previa.orcamento)}/dia · nasce {previa.estado === "ENABLED" ? "ATIVA" : "pausada"}</div>
              {/* deno-lint-ignore no-explicit-any */}
              {previa.skus?.map((s: any) => (
                <div key={s.sku_amazon}>· {s.sku_amazon} {s.conhecido ? <span className="text-muted-foreground">({s.asin}{s.nome ? ` · ${s.nome.slice(0, 60)}` : ""})</span> : <span className="text-amber-600 dark:text-amber-400">— não achado nos anúncios da conta</span>}</div>
              ))}
              {previa.palavras?.length > 0 && <div>· {previa.palavras.length} palavra(s)-chave</div>}
              {(previa.avisos ?? []).map((a: string) => <div key={a} className="text-amber-600 dark:text-amber-400">⚠ {a}</div>)}
              {(previa.pendencias ?? []).map((a: string) => <div key={a} className="text-red-600 dark:text-red-400">✕ {a}</div>)}
            </div>
          )}
          {erro && <div className="text-xs text-red-600 dark:text-red-400">{erro}</div>}
          {resultado?.ok && (
            <div className="text-xs text-emerald-600 dark:text-emerald-400">
              Campanha criada na Amazon (#{resultado.campaignId}), {resultado.estado === "ENABLED" ? "ativa" : "pausada"}.
              {resultado.estado !== "ENABLED" && " Para ligar: Editar orçamento e estado → ativa."}
            </div>
          )}
          {resultado && !resultado.ok && resultado.parou_em && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
              Parou em "{resultado.parou_em}" — o que já foi criado ficou na Amazon (campanha {resultado.campaignId ?? "—"}).
              <Button variant="outline" size="sm" className="h-7 ml-2" disabled={ocupado !== ""}
                onClick={() => criar({ campaignId: resultado.campaignId, adGroupId: resultado.adGroupId ?? null })}>
                Continuar de onde parou
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {!previa || previa.pendencias?.length ? (
              <Button size="sm" onClick={conferir} disabled={ocupado !== ""}>
                {ocupado === "previa" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />} Conferir
              </Button>
            ) : (
              <Button size="sm" onClick={() => criar()} disabled={ocupado !== "" || !!resultado?.ok}>
                {ocupado === "criar" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />} Criar na Amazon
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
