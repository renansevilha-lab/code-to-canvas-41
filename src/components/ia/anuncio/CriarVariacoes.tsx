import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatBRL } from "@/lib/format";
import { chamarVariacoes } from "@/lib/iaAnuncio";
import { extrairPeso } from "@/lib/prazo";

// ============================================================================
// "Criar produto com variações" (12/out/2026, pedido do dono): a partir de um produto
// SIMPLES, cria NO TINY um produto pai cujas variações são kits do produto base
// (1 unidades, 2 unidades…) — a estrutura que a equipe montava à mão. A pessoa
// escolhe as variações aqui; a edge fn `tiny-produto-variacoes` confere e cria.
// O anúncio é enviado depois pelo Tiny (já nasce ligado ao produto).
// ============================================================================

interface Sugestao {
  base: { sku: string; nome: string; tipo: string; tipo_variacao: string; preco: number | null; custo: number | null; marca: string | null };
  skus: string[];
}
interface Linha { rotulo: string; quantidade: string; sku: string; preco: string }
interface Previa {
  previa: { variacoes: { sku: string; rotulo: string; quantidade: number; preco: number; nome: string; custo: number | null }[] };
  pendencias: string[]; avisos: string[];
}
interface Resultado {
  pai: { sku: string; id: number; nome: string }; base_sku: string; aviso: string | null;
  variacoes: { sku: string; rotulo: string; quantidade: number; preco: number; id?: number; ok: boolean; erro: string | null }[];
}

const dinheiro = (v: number) => v.toFixed(2).replace(".", ",");
const paraNumero = (s: string) => Number(String(s).replace(/\./g, "").replace(",", "."));
const rotuloUnidades = (n: number) => `${n} ${n === 1 ? "unidade" : "unidades"}`;
const kg = (v: number) => String(Math.round(v * 1000) / 1000).replace(".", ",");
/** Areia (e granulado/sílica) se vende por PESO: as opções são "4kg, 8kg, 12kg…", não "1, 2, 3 unidades". */
const EH_AREIA = /areia|granulado|s[ií]lica/i;

export function CriarVariacoes({ sku, onFechar }: { sku: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const sugQ = useQuery({
    queryKey: ["ia-anuncio", "variacoes-sugerir", sku],
    staleTime: 0,
    queryFn: async () => (await chamarVariacoes("sugerir", { base_sku: sku, n: 13 })) as Sugestao,
  });
  const [nome, setNome] = useState("");
  const [skuPai, setSkuPai] = useState("");
  const [grade, setGrade] = useState("Tamanho");
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [previa, setPrevia] = useState<{ chave: string; dados: Previa } | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "criando">("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [refazendo, setRefazendo] = useState<string | null>(null);

  const base = sugQ.data?.base;
  const livres = sugQ.data?.skus ?? [];
  const [nomeEditado, setNomeEditado] = useState(false);
  // peso da embalagem do produto base, lido do nome ("… 4kg"), só para areia: muda o nome das opções e o do pai
  const peso = useMemo(() => {
    if (!base || !EH_AREIA.test(base.nome)) return null;
    const p = extrairPeso(base.nome);
    if (!p) return null;
    const v = Number(p.valor.replace(",", "."));
    if (!(v > 0)) return null;
    return { kg: p.unidade === "g" ? v / 1000 : p.unidade === "kg" ? v : 0, inicio: p.inicio, fim: p.fim };
  }, [base]);
  const porPeso = !!peso && peso.kg > 0;
  const rotuloDe = (n: number) => (porPeso ? `${kg(peso!.kg * n)}kg` : rotuloUnidades(n));
  /** Nome do pai: na areia, o peso do nome vira a faixa ("4kg a 20kg"). */
  const nomeDoPai = (qtds: number[]) => {
    if (!base) return "";
    if (!porPeso || qtds.length === 0) return base.nome;
    const min = Math.min(...qtds), max = Math.max(...qtds);
    return `${base.nome.slice(0, peso!.inicio)}${kg(peso!.kg * min)}kg a ${kg(peso!.kg * max)}kg${base.nome.slice(peso!.fim)}`.replace(/\s+/g, " ").trim();
  };
  /** Monta as linhas para as quantidades dadas: SKUs na sequência sugerida e preço = preço do produto base × quantidade. */
  const montar = (qtds: number[]) => {
    setLinhas(qtds.map((n, i) => ({ rotulo: rotuloDe(n), quantidade: String(n), sku: livres[i + 1] ?? "", preco: base?.preco ? dinheiro(base.preco * n) : "" })));
    if (!nomeEditado) setNome(nomeDoPai(qtds));
    setPrevia(null);
  };
  useEffect(() => {
    if (!sugQ.data) return;
    setSkuPai(sugQ.data.skus[0] ?? "");
    montar(porPeso ? [1, 2, 3, 4, 5] : [1, 2, 3]);
  }, [sugQ.data]);

  const mudar = (i: number, x: Partial<Linha>) => {
    setLinhas((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      // mudou a quantidade e o nome da opção ainda era o automático: o nome acompanha (na areia, o peso)
      const n = Number(x.quantidade);
      const acompanha = x.quantidade !== undefined && x.rotulo === undefined && n >= 1 && l.rotulo === rotuloDe(Number(l.quantidade));
      return { ...l, ...x, ...(acompanha ? { rotulo: rotuloDe(n) } : {}) };
    }));
    setPrevia(null);
  };
  const adicionar = () => {
    const usados = new Set([skuPai, ...linhas.map((l) => l.sku)]);
    const maiorQtd = Math.max(0, ...linhas.map((l) => Number(l.quantidade) || 0));
    const n = maiorQtd + 1;
    setLinhas((ls) => [...ls, { rotulo: rotuloDe(n), quantidade: String(n), sku: livres.find((s) => !usados.has(s)) ?? "", preco: base?.preco ? dinheiro(base.preco * n) : "" }]);
    setPrevia(null);
  };
  const corpo = () => ({
    base_sku: sku, nome: nome.trim(), sku_pai: skuPai.trim(), grade: grade.trim() || "Tamanho",
    variacoes: linhas.map((l) => ({ sku: l.sku.trim(), rotulo: l.rotulo.trim(), quantidade: Number(l.quantidade) || 0, preco: paraNumero(l.preco) || 0 })),
  });
  const chave = JSON.stringify(corpo());
  const conferido = previa?.chave === chave ? previa.dados : null;

  async function conferir() {
    setOcupado("conferindo");
    try { setPrevia({ chave, dados: (await chamarVariacoes("previa", corpo())) as Previa }); }
    catch (e) { toast.error("Não consegui conferir", { description: (e as Error).message, duration: 12000 }); }
    finally { setOcupado(""); }
  }
  async function criar() {
    if (!conferido || conferido.pendencias.length) return;
    if (!window.confirm([
      `Criar no Tiny o produto "${nome.trim()}" (SKU ${skuPai.trim()}) com ${linhas.length} variações?`, "",
      ...linhas.map((l) => `• ${l.rotulo} — SKU ${l.sku} — R$ ${l.preco} — kit de ${l.quantidade}× ${sku}`), "",
      "Os produtos ficam ATIVOS no Tiny. Excluir pela API não funciona: se errar, é preciso apagar na tela do Tiny.",
    ].join("\n"))) return;
    setOcupado("criando");
    try {
      const r = (await chamarVariacoes("criar", { ...corpo(), confirmar: true })) as Resultado;
      setResultado(r);
      (r.aviso ? toast.warning : toast.success)(`Produto ${r.pai.sku} criado no Tiny`, { description: r.aviso ?? `${r.variacoes.length} variações, cada uma como kit do ${sku}`, duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) { toast.error("O Tiny não criou o produto", { description: (e as Error).message, duration: 15000 }); }
    finally { setOcupado(""); }
  }
  async function refazerKit(v: Resultado["variacoes"][number]) {
    if (!v.id || !resultado) return;
    setRefazendo(v.sku);
    try {
      const r = await chamarVariacoes("kit", { id_variacao: v.id, quantidade: v.quantidade, base_sku: resultado.base_sku, confirmar: true });
      setResultado({ ...resultado, variacoes: resultado.variacoes.map((x) => (x.sku === v.sku ? { ...x, ok: r.ok === true, erro: r.erro ?? null } : x)) });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) { toast.error("Ainda não deu", { description: (e as Error).message, duration: 12000 }); }
    finally { setRefazendo(null); }
  }

  const naoSimples = base && (base.tipo !== "S" || base.tipo_variacao !== "N");
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Criar produto com variações</DialogTitle>
          <DialogDescription>
            Cria no Tiny um produto novo em que cada variação é um kit deste produto. O estoque de cada variação sai do produto base.
            Depois, envie para a Shopee pelo Tiny: o anúncio já nasce ligado.
          </DialogDescription>
        </DialogHeader>

        {sugQ.isLoading ? <div className="p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Lendo o produto no Tiny…</div>
          : sugQ.isError ? <p className="text-sm text-destructive">Não consegui ler o produto: {(sugQ.error as Error).message}</p>
          : resultado ? (
            <div className="space-y-3">
              <div className="rounded-md border p-3 text-sm">
                <b>{resultado.pai.nome}</b>
                <div className="text-xs text-muted-foreground">SKU {resultado.pai.sku} · criado no Tiny</div>
              </div>
              <div className="divide-y rounded-md border">
                {resultado.variacoes.map((v) => (
                  <div key={v.sku} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                    {v.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" /> : <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div><b>{v.rotulo}</b> · SKU <span className="font-mono">{v.sku}</span> · {formatBRL(v.preco)} · kit de {v.quantidade}× {resultado.base_sku}</div>
                      {!v.ok && <div className="text-xs text-destructive">{v.erro ?? "ficou como produto simples"}</div>}
                    </div>
                    {!v.ok && v.id && (
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={refazendo === v.sku} onClick={() => void refazerKit(v)}>
                        {refazendo === v.sku ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}tentar de novo
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {resultado.aviso && <p className="text-xs text-amber-600">{resultado.aviso}</p>}
              <p className="text-xs text-muted-foreground">O produto já aparece na lista de anúncios. As fotos e o texto podem ser levados pelo bloco "Aproveitar as fotos da família de kit".</p>
            </div>
          ) : base && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/20 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground mr-1.5">{base.sku}</span><b>{base.nome}</b>
                <div className="text-xs text-muted-foreground">
                  produto base · preço no Tiny {base.preco != null ? formatBRL(base.preco) : "—"} · custo {base.custo != null ? formatBRL(base.custo) : "sem custo"}
                  {base.marca && <> · {base.marca}</>}
                </div>
                {naoSimples && <p className="text-xs text-destructive mt-1">Este produto não é simples no Tiny (é kit, pai ou variação): só produto simples pode ser a base.</p>}
              </div>

              <div className="grid sm:grid-cols-[1fr_130px_150px] gap-2">
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">Nome do produto com variações</span>
                  <Input className="h-8 mt-1" value={nome} onChange={(e) => { setNome(e.target.value); setNomeEditado(true); setPrevia(null); }} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">SKU do pai</span>
                  <Input className="h-8 mt-1 font-mono" value={skuPai} onChange={(e) => { setSkuPai(e.target.value); setPrevia(null); }} />
                </label>
                <label className="block">
                  <span className="text-[11px] text-muted-foreground">Nome da variação (grade)</span>
                  <Input className="h-8 mt-1" value={grade} onChange={(e) => { setGrade(e.target.value); setPrevia(null); }} />
                </label>
              </div>

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium mr-1">Variações</span>
                  {(porPeso ? [[1, 2, 3], [1, 2, 3, 4, 5], [2, 3, 4, 5]] : [[1, 2, 3], [3, 4, 6], [6, 12]]).map((q) => (
                    <Button key={q.join("-")} size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => montar(q)}>
                      {porPeso ? `${q.map((n) => kg(peso!.kg * n)).join(" · ")} kg` : `${q.join(" · ")} un.`}
                    </Button>
                  ))}
                  {porPeso && <span className="text-[11px] text-muted-foreground">areia: as opções vão por peso ({kg(peso!.kg)}kg por embalagem)</span>}
                </div>
                <div className="grid grid-cols-[1fr_70px_120px_100px_28px] gap-1.5 text-[11px] text-muted-foreground px-0.5">
                  <span>Nome da opção</span><span>Qtd. no kit</span><span>SKU</span><span>Preço</span><span />
                </div>
                {linhas.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_70px_120px_100px_28px] gap-1.5">
                    <Input className="h-8 text-sm" value={l.rotulo} onChange={(e) => mudar(i, { rotulo: e.target.value })} placeholder="2 unidades" />
                    <Input className="h-8 text-sm font-mono" value={l.quantidade} onChange={(e) => mudar(i, { quantidade: e.target.value.replace(/\D/g, "") })} />
                    <Input className="h-8 text-sm font-mono" value={l.sku} onChange={(e) => mudar(i, { sku: e.target.value })} />
                    <Input className="h-8 text-sm font-mono" value={l.preco} onChange={(e) => mudar(i, { preco: e.target.value })} placeholder="0,00" />
                    <Button size="sm" variant="ghost" className="h-8 w-7 p-0" title="Tirar" onClick={() => { setLinhas((ls) => ls.filter((_, j) => j !== i)); setPrevia(null); }}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={adicionar}><Plus className="h-3.5 w-3.5" />variação</Button>
                <p className="text-[11px] text-muted-foreground">
                  Os SKUs sugeridos são os próximos números livres, conferidos agora no Tiny (ele exige o SKU na criação pela API); troque se preferir. O preço sugerido é o do produto base × a quantidade.
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
                    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm space-y-0.5">
                      <b className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" />Conferido: SKUs livres, pronto para criar</b>
                      {conferido.previa.variacoes.map((v) => (
                        <div key={v.sku} className="text-xs">
                          <span className="font-mono">{v.sku}</span> · {v.nome} · {formatBRL(v.preco)}
                          {v.custo != null && <span className="text-muted-foreground"> · custo {formatBRL(v.custo)}</span>}
                        </div>
                      ))}
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
          {resultado ? <Button onClick={onFechar}>Fechar</Button> : (
            <>
              <Button variant="ghost" disabled={!!ocupado} onClick={onFechar}>Cancelar</Button>
              <Button variant="outline" disabled={!!ocupado || !base || !!naoSimples} onClick={() => void conferir()} className="gap-1.5">
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
