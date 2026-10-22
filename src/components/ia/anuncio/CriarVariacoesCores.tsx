import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { chamarVariacoes } from "@/lib/iaAnuncio";
import { rotuloQuantidade, rotulosDasCores, unidadesComuns } from "@/lib/rotulosVariacao";

// ============================================================================
// "Criar produto com variações de cor × quantidade" (14/out/2026, pedido do dono — ex.: Carpete Autocolante
// em 5 cores): a pessoa seleciona na lista de anúncios os produtos SIMPLES de cada cor; aqui escolhe as
// quantidades e o app cria NO TINY um produto pai com duas grades (Cor e Quantidade) em que cada variação é
// um KIT de N× o produto daquela cor — vender "Marrom · 2 un" baixa 2 do produto marrom no Tiny.
// Mesma edge fn do diálogo de uma base só (`tiny-produto-variacoes` v6: `grades` + `base_sku`/`valores` por
// variação). Com muitas variações a função não termina tudo numa chamada: esta tela continua os kits
// (`kit`) e as fotos (`foto`) até acabar.
// ============================================================================

interface Base { sku: string; nome: string; preco: number | null; custo: number | null; tipo: string | null; marca: string | null }
interface Linha { chave: string; base: string; cor: string; qtd: number; sku: string; preco: string }
interface Previa {
  previa: { variacoes: { sku: string; rotulo: string; preco: number; nome: string; custo: number | null; base_sku: string }[] };
  pendencias: string[]; avisos: string[];
}
interface VarRes { sku: string; rotulo: string; base_sku: string; quantidade: number; preco: number; id?: number; ok: boolean; pendente?: boolean; erro: string | null }
interface Resultado { pai: { sku: string; id: number; nome: string }; variacoes: VarRes[]; aviso: string | null }

const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));


export function CriarVariacoesCores({ skus, onFechar }: { skus: string[]; onFechar: () => void }) {
  const qc = useQueryClient();
  const basesQ = useQuery({
    queryKey: ["ia-anuncio", "variacoes-cores-bases", skus.join(",")],
    staleTime: 0,
    queryFn: async (): Promise<Base[]> => {
      const [p, c] = await Promise.all([
        supabaseExternal.from("produtos").select("sku, nome, preco, tipo, marca, marca_manual").in("sku", skus),
        supabaseExternal.from("view_cmv_efetivo").select("sku, cmv_efetivo").in("sku", skus),
      ]);
      if (p.error) throw p.error;
      const custo = new Map(((c.data ?? []) as { sku: string; cmv_efetivo: number | null }[]).map((x) => [x.sku, x.cmv_efetivo]));
      type Prod = { sku: string; nome: string | null; preco: number | null; tipo: string | null; marca: string | null; marca_manual: string | null };
      const por = new Map(((p.data ?? []) as Prod[]).map((x) => [x.sku, x]));
      return skus.filter((s) => por.has(s)).map((s) => {
        const x = por.get(s)!;
        return { sku: s, nome: x.nome ?? s, preco: x.preco != null ? Number(x.preco) : null, custo: custo.get(s) != null ? Number(custo.get(s)) : null, tipo: x.tipo, marca: x.marca_manual ?? x.marca };
      });
    },
  });
  // próximos SKUs livres, conferidos ao vivo no Tiny (o pai + uma folga por variação)
  const sugQ = useQuery({
    queryKey: ["ia-anuncio", "variacoes-cores-sugerir", skus.join(",")],
    staleTime: 0,
    queryFn: async () => (await chamarVariacoes("sugerir", { base_sku: skus[0], n: Math.min(51, 1 + skus.length * 6) })) as { skus: string[] },
  });

  const [nome, setNome] = useState("");
  const [skuPai, setSkuPai] = useState("");
  const [grades, setGrades] = useState<[string, string]>(["Cor", "Quantidade"]);
  const [cores, setCores] = useState<{ sku: string; rotulo: string }[]>([]);
  const [qtdsTexto, setQtdsTexto] = useState("1, 2, 3");
  const [edit, setEdit] = useState<Record<string, { sku?: string; preco?: string }>>({});
  const [previa, setPrevia] = useState<{ chave: string; dados: Previa } | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "criando" | "terminando">("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [progresso, setProgresso] = useState("");

  const bases = basesQ.data ?? [];
  // "6 pct (300 un)" quando todo produto base diz quantas unidades tem (ex.: toalhas "50 Un"); senão "6 un"
  const porPacote = unidadesComuns(bases.map((b) => b.nome));
  const rotuloQtd = (n: number) => rotuloQuantidade(n, porPacote);
  const livres = sugQ.data?.skus ?? [];
  useEffect(() => {
    if (!bases.length) return;
    const r = rotulosDasCores(bases);
    setCores(r.cores);
    setNome((n) => n || r.comum);
    // sem "[Cor]" no nome os produtos não são cores (ex.: toalhas Higiene Face × Limpa Patas): o grupo vira "Tipo"
    if (!r.temCor) setGrades((g) => (g[0] === "Cor" ? ["Tipo", g[1]] : g));
  }, [basesQ.data]);
  useEffect(() => { if (livres.length) setSkuPai((s) => s || livres[0]); }, [sugQ.data]);

  const qtds = useMemo(() => [...new Set(qtdsTexto.split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 100))], [qtdsTexto]);
  const precoBase = (s: string) => bases.find((b) => b.sku === s)?.preco ?? null;
  // a grade completa: cada cor × cada quantidade, na ordem das cores (é a ordem que a Shopee mostra)
  const linhas: Linha[] = useMemo(() => {
    const usados = new Set([skuPai]); let i = 1;
    return cores.flatMap((c) => qtds.map((q) => {
      const chave = `${c.sku}|${q}`;
      let sku = edit[chave]?.sku;
      if (sku === undefined) { while (i < livres.length && usados.has(livres[i])) i++; sku = livres[i++] ?? ""; }
      usados.add(sku);
      const pb = precoBase(c.sku);
      return { chave, base: c.sku, cor: c.rotulo, qtd: q, sku, preco: edit[chave]?.preco ?? (pb ? dinheiro(pb * q) : "") };
    }));
  }, [cores, qtds, edit, livres, skuPai, bases]);
  const mudar = (chave: string, x: { sku?: string; preco?: string }) => { setEdit((e) => ({ ...e, [chave]: { ...e[chave], ...x } })); setPrevia(null); };

  const corpo = () => ({
    base_sku: cores[0]?.sku ?? skus[0], nome: nome.trim(), sku_pai: skuPai.trim(), grades: grades.map((g) => g.trim()),
    variacoes: linhas.map((l) => ({ sku: l.sku.trim(), base_sku: l.base, valores: [l.cor.trim(), rotuloQtd(l.qtd)], quantidade: l.qtd, preco: paraNumero(l.preco) || 0 })),
  });
  const chave = JSON.stringify(corpo());
  const conferido = previa?.chave === chave ? previa.dados : null;
  const naoSimples = bases.filter((b) => b.tipo && b.tipo !== "S");

  async function conferir() {
    setOcupado("conferindo");
    try { setPrevia({ chave, dados: (await chamarVariacoes("previa", corpo())) as Previa }); }
    catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message, duration: 12000 }); }
    finally { setOcupado(""); }
  }

  /** Termina o que a 1ª chamada não alcançou: variações que ainda não viraram kit e fotos. */
  async function terminar(r: Resultado) {
    setOcupado("terminando");
    let atual = r;
    const faltam = () => atual.variacoes.filter((v) => !v.ok && v.id && v.pendente);
    for (let rodada = 0; rodada < 6 && faltam().length; rodada++) {
      for (const v of faltam()) {
        setProgresso(`transformando em kit: ${v.rotulo} (${atual.variacoes.filter((x) => x.ok).length}/${atual.variacoes.length})`);
        try {
          const k = await chamarVariacoes("kit", { id_variacao: v.id, quantidade: v.quantidade, base_sku: v.base_sku, confirmar: true });
          // limite do Tiny (código 6 da API antiga = 60 s; 429 da nova = 20 s): espera e retoma
          const limite = k.limite === true;
          const espera = Number(k.espera) > 0 ? Number(k.espera) : 60;
          atual = { ...atual, variacoes: atual.variacoes.map((x) => (x.sku === v.sku ? { ...x, ok: k.ok === true, pendente: !k.ok && limite, erro: k.erro ?? null } : x)) };
          setResultado(atual);
          if (limite) { setProgresso(`o Tiny pediu para esperar: retomo em ${espera} s…`); await new Promise((ok) => setTimeout(ok, espera * 1000)); }
        } catch (e) {
          atual = { ...atual, variacoes: atual.variacoes.map((x) => (x.sku === v.sku ? { ...x, pendente: false, erro: (e as Error).message } : x)) };
          setResultado(atual);
        }
      }
    }
    // fotos: a função para aos ~22 s e diz quem ficou de fora; chama de novo até acabar
    for (let rodada = 0; rodada < 6; rodada++) {
      setProgresso("pondo a foto de cada cor nas variações…");
      try {
        const f = (await chamarVariacoes("foto", { sku_pai: r.pai.sku, confirmar: true })) as { itens?: { pendente?: boolean }[] };
        if (!(f.itens ?? []).some((i) => i.pendente)) break;
      } catch { break; }
    }
    setProgresso("");
    setOcupado("");
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    const ruins = atual.variacoes.filter((v) => !v.ok).length;
    if (ruins) toast.warning(`${ruins} variação(ões) não viraram kit`, { description: "Elas aparecem em vermelho: ajuste no Tiny antes de vender.", duration: 15000 });
    else toast.success("Todas as variações viraram kit no Tiny", { description: "Cada uma baixa o estoque do produto da cor dela.", duration: 10000 });
  }

  async function criar() {
    if (!conferido || conferido.pendencias.length) return;
    if (!window.confirm([
      `Criar no Tiny o produto "${nome.trim()}" (SKU ${skuPai.trim()}) com ${linhas.length} variações (${cores.length} ${grades[0].toLowerCase()} × ${qtds.length} ${grades[1].toLowerCase()})?`, "",
      ...linhas.slice(0, 30).map((l) => `• ${l.cor} · ${rotuloQtd(l.qtd)} — SKU ${l.sku} — R$ ${l.preco} — kit de ${l.qtd}× ${l.base}`),
      ...(linhas.length > 30 ? [`… e mais ${linhas.length - 30}`] : []), "",
      "Os produtos ficam ATIVOS no Tiny. Excluir pela API não funciona: se errar, é preciso apagar na tela do Tiny.",
    ].join("\n"))) return;
    setOcupado("criando");
    try {
      const r = (await chamarVariacoes("criar", { ...corpo(), confirmar: true })) as Resultado & { ok?: boolean; erro?: string; pendencias?: string[] };
      if (r.ok === false || !r.pai) throw new Error(r.erro ?? (r.pendencias ?? []).join(" · ") ?? "o Tiny não criou o produto");
      setResultado(r);
      toast.success(`Produto ${r.pai.sku} criado no Tiny`, { description: r.aviso ?? `${r.variacoes.length} variações`, duration: 10000 });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
      await terminar(r);
    } catch (e) {
      toast.error("O Tiny não criou o produto", { description: (e as Error).message, duration: 15000 });
      setOcupado("");
    }
  }

  const carregando = basesQ.isLoading || sugQ.isLoading;
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Criar produto com variações de {grades[0].toLowerCase()} × {grades[1].toLowerCase()}</DialogTitle>
          <DialogDescription>
            Cria no Tiny um produto novo com duas grades. Cada variação é um kit do produto da {grades[0].toLowerCase()} dela:
            vender "{cores[1]?.rotulo ?? "Marrom"} · 2 un" baixa 2 unidades do produto {cores[1]?.rotulo ?? "marrom"} no Tiny.
          </DialogDescription>
        </DialogHeader>

        {carregando ? <div className="p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Lendo os produtos e os próximos SKUs livres no Tiny…</div>
          : basesQ.isError || sugQ.isError ? <p className="text-sm text-destructive">Não consegui ler: {((basesQ.error ?? sugQ.error) as Error).message}</p>
          : resultado ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3 text-sm">
                <b>{resultado.pai.nome}</b>
                <div className="text-xs text-muted-foreground">SKU {resultado.pai.sku} · criado no Tiny · {resultado.variacoes.filter((v) => v.ok).length} de {resultado.variacoes.length} variações já são kit</div>
                {progresso && <div className="text-xs text-primary mt-1"><Loader2 className="h-3 w-3 animate-spin inline mr-1" />{progresso}</div>}
              </div>
              <div className="divide-y rounded-md border max-h-[45vh] overflow-y-auto">
                {resultado.variacoes.map((v) => (
                  <div key={v.sku} className="flex items-start gap-2.5 px-3 py-1.5 text-sm">
                    {v.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                      : v.pendente ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mt-0.5 shrink-0" />
                      : <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <b>{v.rotulo}</b> · SKU <span className="font-mono">{v.sku}</span> · {formatBRL(v.preco)} · kit de {v.quantidade}× {v.base_sku}
                      {!v.ok && !v.pendente && <div className="text-xs text-destructive">{v.erro ?? "ficou como produto simples"}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                O produto já aparece na lista de anúncios (filtro "Criados no app"). Abra o pai para gerar o anúncio: na Shopee as variações entram com os dois grupos ({grades[0]} e {grades[1]}).
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {naoSimples.length > 0 && (
                <p className="text-xs text-destructive">Só produto SIMPLES pode ser base: {naoSimples.map((b) => b.sku).join(", ")} não é. Tire da seleção.</p>
              )}
              <div className="grid sm:grid-cols-[1fr_120px_120px_120px] gap-2">
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">Nome do produto com variações</span>
                  <Input className="h-8 mt-1" value={nome} onChange={(e) => { setNome(e.target.value); setPrevia(null); }} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">SKU do pai</span>
                  <Input className="h-8 mt-1 font-mono" value={skuPai} onChange={(e) => { setSkuPai(e.target.value); setPrevia(null); }} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">1ª grade</span>
                  <Input className="h-8 mt-1" value={grades[0]} maxLength={14} onChange={(e) => { setGrades([e.target.value, grades[1]]); setPrevia(null); }} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">2ª grade</span>
                  <Input className="h-8 mt-1" value={grades[1]} maxLength={14} onChange={(e) => { setGrades([grades[0], e.target.value]); setPrevia(null); }} />
                </label>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">{grades[0]} <span className="text-[11px] font-normal text-muted-foreground">(um produto simples por opção)</span></div>
                  {cores.map((c, i) => {
                    const b = bases.find((x) => x.sku === c.sku);
                    return (
                      <div key={c.sku} className="flex items-center gap-1.5">
                        <Input className="h-8 w-36 text-sm" value={c.rotulo} maxLength={20}
                          onChange={(e) => { setCores((cs) => cs.map((x, j) => (j === i ? { ...x, rotulo: e.target.value } : x))); setPrevia(null); }} />
                        <span className="text-[11px] text-muted-foreground truncate flex-1" title={b?.nome}>
                          <span className="font-mono">{c.sku}</span> · {b?.preco != null ? formatBRL(b.preco) : "sem preço"}{b?.custo != null ? ` · custo ${formatBRL(b.custo)}` : " · sem custo"}
                        </span>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Tirar" disabled={cores.length <= 1}
                          onClick={() => { setCores((cs) => cs.filter((_, j) => j !== i)); setPrevia(null); }}><X className="h-3.5 w-3.5" /></Button>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-1.5">
                  <div className="text-sm font-medium">{grades[1]} <span className="text-[11px] font-normal text-muted-foreground">(unidades em cada kit)</span></div>
                  <Input className="h-8 text-sm font-mono" value={qtdsTexto} onChange={(e) => { setQtdsTexto(e.target.value); setPrevia(null); }} placeholder="1, 2, 3" />
                  <div className="flex flex-wrap gap-1.5">
                    {["1, 2, 3", "1, 2, 3, 4", "1, 2, 3, 4, 5", "2, 3, 4"].map((t) => (
                      <Button key={t} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => { setQtdsTexto(t); setPrevia(null); }}>{t}</Button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {cores.length} × {qtds.length} = <b>{linhas.length}</b> variações{linhas.length > 50 ? " — a Shopee aceita até 50" : ""}. A opção aparece como "{rotuloQtd(qtds[0] ?? 1)}".
                  </p>
                </div>
              </div>

              <div className="space-y-1">
                <div className="grid grid-cols-[1fr_70px_120px_100px] gap-1.5 text-[11px] text-muted-foreground px-0.5">
                  <span>Variação</span><span>Kit</span><span>SKU</span><span>Preço</span>
                </div>
                <div className="max-h-[38vh] overflow-y-auto space-y-1 pr-1">
                  {linhas.map((l) => (
                    <div key={l.chave} className="grid grid-cols-[1fr_70px_120px_100px] gap-1.5 items-center">
                      <span className="text-sm truncate"><b>{l.cor}</b> · {rotuloQtd(l.qtd)}</span>
                      <span className="text-[11px] text-muted-foreground font-mono">{l.qtd}× {l.base}</span>
                      <Input className="h-7 text-sm font-mono" value={l.sku} onChange={(e) => mudar(l.chave, { sku: e.target.value })} />
                      <Input className="h-7 text-sm font-mono" value={l.preco} onChange={(e) => mudar(l.chave, { preco: e.target.value })} placeholder="0,00" />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Os SKUs são os próximos números livres, conferidos agora no Tiny; o preço sugerido é o do produto da {grades[0].toLowerCase()} × a quantidade. Troque o que quiser.
                </p>
              </div>

              {conferido && (
                <div className="space-y-2">
                  {conferido.pendencias.length > 0 ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-1">
                      <b className="text-destructive flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Falta resolver antes de criar</b>
                      {conferido.pendencias.map((x) => <div key={x}>• {x}</div>)}
                    </div>
                  ) : (
                    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
                      <b className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" />Conferido: SKUs livres, pronto para criar</b>
                      <div className="text-xs text-muted-foreground mt-0.5">{conferido.previa.variacoes.length} variações; custo de cada kit = custo do produto da {grades[0].toLowerCase()} × quantidade.</div>
                    </div>
                  )}
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs space-y-0.5 text-amber-700 dark:text-amber-400">
                    {conferido.avisos.map((x) => <div key={x}>• {x}</div>)}
                  </div>
                </div>
              )}
            </div>
          )}

        <DialogFooter>
          {resultado ? <Button disabled={ocupado === "terminando"} onClick={onFechar}>{ocupado === "terminando" ? "Terminando…" : "Fechar"}</Button> : (
            <>
              <Button variant="ghost" disabled={!!ocupado} onClick={onFechar}>Cancelar</Button>
              <Button variant="outline" disabled={!!ocupado || carregando || naoSimples.length > 0 || linhas.length < 2} onClick={() => void conferir()} className="gap-1.5">
                {ocupado === "conferindo" && <Loader2 className="h-4 w-4 animate-spin" />}Conferir
              </Button>
              <Button disabled={!!ocupado || !conferido || conferido.pendencias.length > 0} onClick={() => void criar()} className="gap-1.5">
                {ocupado === "criando" && <Loader2 className="h-4 w-4 animate-spin" />}
                {ocupado === "criando" ? "Criando no Tiny…" : "Criar no Tiny"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
