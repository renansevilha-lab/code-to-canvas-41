import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Layers, Loader2, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBRL } from "@/lib/format";
import { calcularPreco, chamarAmazonVariacoes } from "@/lib/iaAnuncio";

// ============================================================================
// Variações na Amazon num anúncio que JÁ EXISTE (18/out/2026, pedido do dono: opções B + C).
// Pesquisa pelo ASIN (ou SKU) → mostra a família (pai, tema, filhos com o tamanho de cada um) e os kits
// do mesmo produto base no Tiny. Cada linha marcada vira um envio:
//   B "pôr na família"  = anúncio nosso que hoje está solto passa a ser filho do pai (PATCH);
//   C "tamanho novo"    = SKU novo `<sku>_FBA`, ficha copiada de um irmão (PUT).
// Sem família: cria o pai (o anúncio pesquisado vira o 1º filho).
// Conferir = validador da Amazon (não altera nada). Aplicar só com a conferência limpa e do MESMO pedido,
// com confirmação; cada envio uma vez, para no 1º recusado (edge fn `amazon-variacoes`).
// Código de barras: a Amazon recusa tamanho novo sem ele (erro 8560, também com marca "Genérico") — a
// menos que a marca tenha isenção de GTIN aprovada no Seller Central.
// ============================================================================

interface Filho { sku_amazon: string; sku: string; asin: string | null; valor: string; titulo: string | null; situacao: string[]; preco: number | null }
interface Familia { pai_sku: string; pai_asin: string | null; tema: string; titulo: string | null; tipo: string | null; filhos: Filho[] }
interface Sugestao { sku: string; nome: string; base: string; quantidade: number; valor_sugerido: string; sku_amazon: string | null; asin: string | null; em_outra_familia: string | null; caminho: "entrar" | "novo" }
interface Leitura {
  encontrado: boolean; nosso: boolean; aviso?: string; conta: string;
  catalogo: { asin: string; titulo: string | null; marca: string | null; foto: string | null; ean: string[]; url: string } | null;
  anuncio: { sku_amazon: string; sku: string; asin: string; titulo: string | null; tipo: string | null; situacao: string[]; e_pai: boolean; marca: string | null; preco: number | null; pendencias_amazon: string[] } | null;
  familia: Familia | null; sugestoes: Sugestao[];
}
interface Linha { chave: string; tipo: "entrar" | "novo"; marcado: boolean; sku: string; sku_amazon: string; nome: string; valor: string; preco: string; ean: string; aviso: string | null }
interface Envio { tipo: string; sku_amazon: string; valor: string | null; titulo: string | null; preco: number | null; codigo_barras: string | null; peso_kg: number | null; situacao: string; pendencias: string[]; avisos: string[] }

const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const norm = (v: string) => v.toLowerCase().replace(/\s+/g, "").replace(",", ".");
const TEMAS = [
  { v: "SIZE", t: "Tamanho (ex.: 4kg, 8kg)" },
  { v: "NUMBER_OF_ITEMS", t: "Quantidade de itens" },
  { v: "ITEM_PACKAGE_QUANTITY", t: "Unidades por pacote" },
  { v: "ITEM_WEIGHT", t: "Peso" },
];

/** Bloco na aba Anúncio (destino Amazon). */
export function VariacoesAmazon({ sku, empresa }: { sku: string; empresa: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <Card>
      <CardContent className="p-4 flex flex-wrap items-center gap-3 text-sm">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <b>Variações na Amazon (família de tamanhos)</b>
          <div className="text-xs text-muted-foreground">
            Pesquise pelo ASIN ou SKU, veja a família do anúncio e ponha nela os outros tamanhos — anúncios que já existem soltos ou tamanhos novos. Conta {empresa === "svl" ? "SVL" : "ACZ"}.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAberto(true)}>Abrir</Button>
      </CardContent>
      {aberto && <DialogoAmazon sku={sku} empresa={empresa} onFechar={() => setAberto(false)} />}
    </Card>
  );
}

function DialogoAmazon({ sku, empresa, onFechar }: { sku: string; empresa: string; onFechar: () => void }) {
  const [busca, setBusca] = useState(sku);
  const [lendo, setLendo] = useState(false);
  const [leitura, setLeitura] = useState<Leitura | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  // família nova (quando o anúncio ainda não tem)
  const [paiNovo, setPaiNovo] = useState({ sku: "", tema: "SIZE", valor: "" });
  const [conferindo, setConferindo] = useState(false);
  const [previa, setPrevia] = useState<{ chave: string; envios: Envio[]; pendencias: string[]; avisos: string[] } | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; erro?: string; feitos: any[]; aviso?: string } | null>(null);

  async function ler(q = busca) {
    const termo = q.trim();
    if (!termo) return;
    setLendo(true); setErro(null); setPrevia(null); setResultado(null); setConfirmar(false);
    try {
      const j = (await chamarAmazonVariacoes("ler", { empresa, busca: termo })) as Leitura & { erro?: string };
      if (j.erro) throw new Error(j.erro);
      setLeitura(j);
      const naFamilia = new Set((j.familia?.filhos ?? []).map((f) => norm(f.valor)).filter(Boolean));
      setLinhas((j.sugestoes ?? []).map((s) => ({
        chave: `${s.caminho}:${s.sku}`, tipo: s.caminho, marcado: false, sku: s.sku, sku_amazon: s.sku_amazon ?? `${s.sku}_FBA`,
        nome: s.nome, valor: s.valor_sugerido, preco: "", ean: "",
        aviso: s.em_outra_familia ? `está na família ${s.em_outra_familia} — sai de lá` : naFamilia.has(norm(s.valor_sugerido)) ? `a família já tem ${s.valor_sugerido}` : null,
      })));
      if (j.anuncio && !j.familia) setPaiNovo((p) => ({ ...p, sku: p.sku || `${j.anuncio!.sku}_PAI` }));
    } catch (e) {
      setErro(String(e instanceof Error ? e.message : e)); setLeitura(null); setLinhas([]);
    } finally { setLendo(false); }
  }
  useEffect(() => { void ler(sku); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const familia = leitura?.familia ?? null;
  const anuncio = leitura?.anuncio ?? null;
  const criandoFamilia = Boolean(anuncio && !familia);

  /** O pedido que vai ao servidor (o mesmo na conferência e no aplicar). */
  const pedido = useMemo(() => {
    const marcadas = linhas.filter((l) => l.marcado);
    const entrar = marcadas.filter((l) => l.tipo === "entrar").map((l) => ({ sku_amazon: l.sku_amazon, valor: l.valor.trim() }));
    const novos = marcadas.filter((l) => l.tipo === "novo").map((l) => ({ sku: l.sku, valor: l.valor.trim(), preco: paraNumero(l.preco) || 0, ...(l.ean.trim() ? { ean: l.ean.trim() } : {}) }));
    if (criandoFamilia && anuncio) {
      entrar.unshift({ sku_amazon: anuncio.sku_amazon, valor: paiNovo.valor.trim() });
      return { empresa, criar_pai: { sku: paiNovo.sku.trim(), tema: paiNovo.tema, molde_sku: anuncio.sku_amazon }, entrar, novos };
    }
    return { empresa, pai_sku: familia?.pai_sku ?? "", entrar, novos };
  }, [linhas, criandoFamilia, anuncio, familia, paiNovo, empresa]);
  const chave = JSON.stringify(pedido);
  const previaValida = previa && previa.chave === chave;
  const nMarcadas = linhas.filter((l) => l.marcado).length;

  function alterar(k: string, p: Partial<Linha>) { setLinhas((ls) => ls.map((l) => (l.chave === k ? { ...l, ...p } : l))); }
  async function marcar(l: Linha, v: boolean) {
    alterar(l.chave, { marcado: v });
    // tamanho novo: preço sugerido da Amazon (margem padrão do canal) se ainda não tem
    if (v && l.tipo === "novo" && !l.preco) {
      try {
        const p = await calcularPreco(l.sku, "amazon", empresa, null);
        if (p.preco_sugerido != null) alterar(l.chave, { preco: String(p.preco_sugerido).replace(".", ",") });
      } catch { /* fica em branco para digitar */ }
    }
  }
  function adicionar(tipo: "entrar" | "novo") {
    const k = `${tipo}:manual-${Date.now()}`;
    setLinhas((ls) => [...ls, { chave: k, tipo, marcado: true, sku: "", sku_amazon: "", nome: "", valor: "", preco: "", ean: "", aviso: null }]);
  }

  async function conferir() {
    setConferindo(true); setResultado(null); setConfirmar(false);
    try {
      const j = await chamarAmazonVariacoes("previa", pedido);
      if (j.erro && !j.envios) throw new Error(j.erro);
      setPrevia({ chave, envios: (j.envios ?? []) as Envio[], pendencias: (j.pendencias ?? []) as string[], avisos: (j.avisos ?? []) as string[] });
    } catch (e) {
      toast.error("Falha ao conferir", { description: String(e instanceof Error ? e.message : e) });
    } finally { setConferindo(false); }
  }
  async function aplicar() {
    setAplicando(true);
    try {
      const j = await chamarAmazonVariacoes("aplicar", { ...pedido, confirmar: true });
      setResultado({ ok: j.ok === true, erro: j.erro, feitos: j.feitos ?? [], aviso: j.aviso });
      if (j.ok) toast.success("Enviado à Amazon", { description: j.aviso });
      else toast.error("A Amazon recusou", { description: j.erro });
    } catch (e) {
      setResultado({ ok: false, erro: String(e instanceof Error ? e.message : e), feitos: [] });
    } finally { setAplicando(false); setConfirmar(false); }
  }

  const envioDe = (skuAmz: string) => (previaValida ? previa!.envios.find((e) => e.sku_amazon === skuAmz) : undefined);

  return (
    <Dialog open onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle>Variações na Amazon · {empresa === "svl" ? "SVL" : "ACZ"}</DialogTitle>
          <DialogDescription>Pesquise pelo ASIN (B0…) ou pelo SKU. Conferir não altera nada na Amazon; aplicar mexe em anúncio no ar e pede confirmação.</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ler()} placeholder="ASIN (B0…) ou SKU" className="max-w-xs" />
          <Button size="sm" onClick={() => void ler()} disabled={lendo}>{lendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Pesquisar</Button>
        </div>
        {lendo && <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />lendo o anúncio, a família e os kits do Tiny na Amazon (leva uns 10 s)…</div>}
        {erro && <div className="text-sm text-destructive">{erro}</div>}

        {leitura && !lendo && (
          <div className="space-y-4 min-w-0">
            {leitura.catalogo && (
              <div className="flex gap-3 items-start rounded-md border p-3">
                {leitura.catalogo.foto && <img src={leitura.catalogo.foto} alt="" className="h-16 w-16 object-contain rounded bg-white" />}
                <div className="min-w-0 text-sm">
                  <div className="font-medium">{leitura.catalogo.titulo}</div>
                  <div className="text-xs text-muted-foreground">
                    {leitura.catalogo.marca} · ASIN {leitura.catalogo.asin}{leitura.catalogo.ean.length ? ` · ${leitura.catalogo.ean.join(", ")}` : ""}
                    {" · "}<a className="underline inline-flex items-center gap-0.5" href={leitura.catalogo.url} target="_blank" rel="noreferrer">ver na Amazon <ExternalLink className="h-3 w-3" /></a>
                  </div>
                  {anuncio && <div className="text-xs">Nosso anúncio: <b>{anuncio.sku_amazon}</b> · {anuncio.situacao.join(" + ") || "sem situação"}{anuncio.preco != null ? ` · ${formatBRL(anuncio.preco)}` : ""}</div>}
                  {anuncio?.pendencias_amazon.map((p) => <div key={p} className="text-xs text-amber-700">a Amazon aponta: {p}</div>)}
                </div>
              </div>
            )}
            {!leitura.nosso && <div className="text-sm text-amber-700">{leitura.aviso}</div>}

            {familia && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="text-sm"><b>Família</b> · pai <b>{familia.pai_sku}</b>{familia.pai_asin ? ` (ASIN ${familia.pai_asin})` : ""} · tema <b>{familia.tema}</b> · {familia.filhos.length} filho(s)</div>
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-muted-foreground"><th className="py-1">Valor</th><th>SKU Amazon</th><th>Nosso SKU</th><th>ASIN</th><th>Preço</th><th>Situação</th></tr></thead>
                  <tbody>
                    {familia.filhos.map((f) => (
                      <tr key={f.sku_amazon} className="border-t">
                        <td className="py-1 font-medium">{f.valor || "—"}</td><td>{f.sku_amazon}</td><td>{f.sku}</td>
                        <td>{f.asin ?? <span className="text-muted-foreground">ainda sem ASIN</span>}</td>
                        <td>{f.preco != null ? formatBRL(f.preco) : "—"}</td><td>{f.situacao.join(" + ") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {criandoFamilia && anuncio && (
              <div className="rounded-md border border-dashed p-3 space-y-2 text-sm">
                <div><b>Este anúncio ainda não tem família.</b> Para criar, o app faz um anúncio pai (copiando a ficha deste) e põe este como o primeiro tamanho.</div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="text-xs">SKU do pai na Amazon<Input className="h-8 mt-1" value={paiNovo.sku} onChange={(e) => setPaiNovo({ ...paiNovo, sku: e.target.value })} /></label>
                  <label className="text-xs">Tema
                    <select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs" value={paiNovo.tema} onChange={(e) => setPaiNovo({ ...paiNovo, tema: e.target.value })}>
                      {TEMAS.map((t) => <option key={t.v} value={t.v}>{t.t}</option>)}
                    </select>
                  </label>
                  <label className="text-xs">Valor deste anúncio ({anuncio.sku_amazon})<Input className="h-8 mt-1" placeholder="ex.: 4kg" value={paiNovo.valor} onChange={(e) => setPaiNovo({ ...paiNovo, valor: e.target.value })} /></label>
                </div>
              </div>
            )}

            {anuncio && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <b>O que entra na família</b>
                  <span className="text-xs text-muted-foreground">— kits do mesmo produto no Tiny; marque os que quer incluir</span>
                </div>
                <div className="rounded-md border divide-y">
                  {linhas.length === 0 && <div className="p-3 text-xs text-muted-foreground">Nenhum kit do mesmo produto no Tiny. Use os botões abaixo para incluir à mão.</div>}
                  {linhas.map((l) => {
                    const ev = envioDe(l.tipo === "novo" ? (l.sku ? `${l.sku}_FBA` : "") : l.sku_amazon);
                    return (
                      <div key={l.chave} className={`p-2 text-xs ${l.marcado ? "" : "opacity-70"}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <input type="checkbox" checked={l.marcado} onChange={(e) => void marcar(l, e.target.checked)} />
                          <span className={`rounded px-1.5 py-0.5 text-[10.5px] ${l.tipo === "entrar" ? "bg-blue-100 text-blue-800" : "bg-emerald-100 text-emerald-800"}`}>
                            {l.tipo === "entrar" ? "pôr na família" : "tamanho novo"}
                          </span>
                          {l.nome ? <span className="min-w-0 flex-1 truncate" title={l.nome}><b>{l.sku}</b> · {l.nome}</span> : (
                            l.tipo === "novo"
                              ? <Input className="h-7 w-32" placeholder="nosso SKU" value={l.sku} onChange={(e) => alterar(l.chave, { sku: e.target.value.trim() })} />
                              : <Input className="h-7 w-40" placeholder="SKU na Amazon" value={l.sku_amazon} onChange={(e) => alterar(l.chave, { sku_amazon: e.target.value.trim() })} />
                          )}
                          {l.tipo === "entrar" && l.nome && <span className="text-muted-foreground">{l.sku_amazon}</span>}
                          <label className="flex items-center gap-1">valor <Input className="h-7 w-20" value={l.valor} onChange={(e) => alterar(l.chave, { valor: e.target.value })} /></label>
                          {l.tipo === "novo" && (
                            <>
                              <label className="flex items-center gap-1">preço <Input className="h-7 w-20" value={l.preco} onChange={(e) => alterar(l.chave, { preco: e.target.value })} /></label>
                              <label className="flex items-center gap-1">cód. barras <Input className="h-7 w-36" placeholder="EAN de 13 dígitos" value={l.ean} onChange={(e) => alterar(l.chave, { ean: e.target.value })} /></label>
                            </>
                          )}
                          {!l.nome && <button type="button" className="text-muted-foreground" onClick={() => setLinhas((ls) => ls.filter((x) => x.chave !== l.chave))}><X className="h-3.5 w-3.5" /></button>}
                        </div>
                        {l.aviso && <div className="mt-1 text-amber-700">{l.aviso}</div>}
                        {l.marcado && l.tipo === "novo" && !l.ean.trim() && <div className="mt-1 text-muted-foreground">sem código de barras a Amazon recusa o tamanho novo (a não ser que a marca tenha isenção de GTIN aprovada)</div>}
                        {ev && (
                          <div className="mt-1 space-y-0.5">
                            <div className={ev.pendencias.length ? "text-destructive" : "text-emerald-700"}>
                              {ev.pendencias.length ? <AlertTriangle className="inline h-3 w-3 mr-1" /> : <CheckCircle2 className="inline h-3 w-3 mr-1" />}
                              Amazon: {ev.situacao === "VALID" ? "pode ir" : ev.situacao}{ev.titulo ? ` · "${ev.titulo}"` : ""}{ev.peso_kg ? ` · ${String(ev.peso_kg).replace(".", ",")} kg` : ""}{ev.codigo_barras ? ` · ${ev.codigo_barras}` : ""}
                            </div>
                            {ev.pendencias.map((p) => <div key={p} className="text-destructive">{p}</div>)}
                            {ev.avisos.map((p) => <div key={p} className="text-muted-foreground">{p}</div>)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => adicionar("entrar")}><Plus className="h-3 w-3" /> anúncio que já existe</Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => adicionar("novo")}><Plus className="h-3 w-3" /> tamanho novo</Button>
                </div>
              </div>
            )}

            {previaValida && (
              <div className="rounded-md border p-3 text-xs space-y-1">
                {previa!.envios.filter((e) => e.tipo === "pai" || (criandoFamilia && e.sku_amazon === anuncio?.sku_amazon)).map((e) => (
                  <div key={e.sku_amazon} className={e.pendencias.length ? "text-destructive" : "text-emerald-700"}>
                    {e.tipo === "pai" ? "Pai" : "Este anúncio"} {e.sku_amazon}: {e.situacao === "VALID" ? "pode ir" : e.situacao}{e.pendencias.length ? ` — ${e.pendencias.join(" · ")}` : ""}
                  </div>
                ))}
                {previa!.pendencias.length > 0
                  ? <div className="text-destructive font-medium">{previa!.pendencias.length} pendência(s) — corrija antes de aplicar</div>
                  : <div className="text-emerald-700 font-medium">Conferido: a Amazon aceita tudo.</div>}
                {previa!.avisos.map((a) => <div key={a} className="text-muted-foreground">{a}</div>)}
              </div>
            )}

            {resultado && (
              <div className={`rounded-md border p-3 text-xs ${resultado.ok ? "border-emerald-300" : "border-destructive"}`}>
                <div className={resultado.ok ? "text-emerald-700 font-medium" : "text-destructive font-medium"}>{resultado.ok ? "Enviado. " + (resultado.aviso ?? "") : resultado.erro}</div>
                {resultado.feitos.map((f: any) => <div key={f.sku_amazon}>{f.sku_amazon} ({f.valor ?? f.tipo}): {f.situacao}</div>)}
                {resultado.ok && <Button size="sm" variant="outline" className="h-7 text-xs mt-2" onClick={() => void ler()}>Ler de novo (a Amazon leva alguns minutos)</Button>}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {confirmar && previaValida ? (
            <>
              <span className="text-xs text-muted-foreground mr-auto">
                Vai mexer em anúncio no ar: {previa!.envios.length} envio(s) na Amazon {empresa === "svl" ? "SVL" : "ACZ"}. Cada um vai uma vez só.
              </span>
              <Button variant="ghost" onClick={() => setConfirmar(false)} disabled={aplicando}>Voltar</Button>
              <Button onClick={() => void aplicar()} disabled={aplicando}>{aplicando && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar e aplicar</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onFechar}>Fechar</Button>
              <Button variant="outline" onClick={() => void conferir()} disabled={!anuncio || conferindo || (nMarcadas === 0 && !criandoFamilia)}>
                {conferindo && <Loader2 className="h-4 w-4 animate-spin" />} Conferir na Amazon
              </Button>
              <Button onClick={() => setConfirmar(true)} disabled={!previaValida || previa!.pendencias.length > 0 || Boolean(resultado?.ok)}>Aplicar</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
