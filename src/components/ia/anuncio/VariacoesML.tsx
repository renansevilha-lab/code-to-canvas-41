import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { calcularPreco, chamarPublicar, chamarVariacoes, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// Produto com variações no MERCADO LIVRE (28/out/2026, pedido do dono). As nossas contas estão no modelo
// "User Products": não existe anúncio com array de variações — cada variação é um anúncio próprio, e o ML junta
// na mesma página os anúncios com o MESMO nome de família e a mesma marca. O que diferencia uma da outra vai na
// quantidade do pacote (UNITS_PER_PACK) e num atributo personalizado com a grade do Tiny (ex. "Tipo: Sílica
// Grossa"). O texto e as fotos são os do anúncio do pai; SKU, peso, cadastro e preço são de cada variação
// (anuncio-publicar v15, opcoes.variacao). Um anúncio por vez, com confirmação; para no primeiro recusado.
// ============================================================================

interface Linha {
  sku: string; nome: string; valores: string[]; qtd: number | null;
  preco: string; incluir: boolean;
}
interface Conferido { pendencias: string[]; avisos: string[]; existentes: { item_id: string; url?: string | null }[]; titulo?: string }
interface Feito { sku: string; ok: boolean; item_id?: string; url?: string; erro?: string; pausado?: boolean }

const ehQuantidade = (grade: string, valores: string[]) =>
  /quant|qtd|unid/i.test(grade) || (valores.length > 0 && valores.every((v) => /^\s*\d+\s*(un|unid\w*|x)?\.?\s*$/i.test(v)));
const numero = (s: string) => { const n = Number(String(s).replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };

export function VariacoesML({ sku, empresa, rascunho }: { sku: string; empresa: string; rascunho: IaRascunho | null }) {
  const [linhas, setLinhas] = useState<Linha[] | null>(null);
  const [pausado, setPausado] = useState(true);
  const [conf, setConf] = useState<Record<string, Conferido | { erro: string }>>({});
  const [confDe, setConfDe] = useState<string | null>(null); // o pedido que foi conferido (muda = conferir de novo)
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "enviando">("");
  const [feitos, setFeitos] = useState<Feito[]>([]);

  // grade do Tiny (nomes e valores de cada variação), composição do kit e cadastro
  const baseQ = useQuery({
    queryKey: ["ia-anuncio", "ml-variacoes", sku],
    placeholderData: undefined, staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: filhas } = await supabaseExternal.from("produtos").select("sku, nome").eq("sku_pai", sku).eq("ativo", true).order("sku");
      const fs = (filhas ?? []) as { sku: string; nome: string | null }[];
      let grades: string[] = []; let porSku = new Map<string, string[]>();
      try {
        const g = (await chamarVariacoes("grade", { sku_pai: sku })) as { grades?: string[]; variacoes?: { sku: string; valores: string[] }[] };
        grades = g.grades ?? [];
        porSku = new Map((g.variacoes ?? []).map((v) => [v.sku, v.valores]));
      } catch { /* sem a grade do Tiny: os valores saem do nome da variação */ }
      const { data: kits } = fs.length
        ? await supabaseExternal.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_kit", fs.map((f) => f.sku))
        : { data: [] };
      const qtdKit = new Map<string, number>();
      for (const s of fs.map((f) => f.sku)) {
        const cs = ((kits ?? []) as { sku_kit: string; sku_componente: string; quantidade: number }[]).filter((k) => k.sku_kit === s);
        if (cs.length === 1) qtdKit.set(s, Number(cs[0].quantidade) || 1);
      }
      return { grades, filhas: fs.map((f) => ({ sku: f.sku, nome: f.nome ?? f.sku, valores: porSku.get(f.sku) ?? [], qtd: qtdKit.get(f.sku) ?? null })) };
    },
  });

  // preço sugerido de cada variação no Mercado Livre (margem padrão do canal)
  useEffect(() => {
    const b = baseQ.data;
    if (!b || linhas) return;
    let vivo = true;
    void (async () => {
      const precos = await Promise.all(b.filhas.map(async (f) => {
        try { return (await calcularPreco(f.sku, "mercado_livre", empresa, null)).preco_sugerido ?? null; } catch { return null; }
      }));
      if (!vivo) return;
      setLinhas(b.filhas.map((f, i) => {
        const valores = f.valores.length ? f.valores : (f.nome.split(" - ").slice(1));
        return { sku: f.sku, nome: f.nome, valores, qtd: f.qtd, preco: precos[i] != null ? String(precos[i]).replace(".", ",") : "", incluir: true };
      }));
    })();
    return () => { vivo = false; };
  }, [baseQ.data, empresa, linhas]);

  const grades = baseQ.data?.grades ?? [];
  // o que vai como atributo: quantidade → UNITS_PER_PACK; o resto → atributo personalizado com o nome da grade
  const atributosDe = (l: Linha) => {
    const extras: { name: string; value_name: string }[] = [];
    let qtd = l.qtd;
    l.valores.forEach((v, i) => {
      const g = grades[i] ?? (l.valores.length > 1 ? `Opção ${i + 1}` : "Tipo");
      const colunaVals = (linhas ?? []).map((x) => x.valores[i] ?? "");
      if (ehQuantidade(g, colunaVals)) { const n = Number(String(v).replace(/\D/g, "")); if (n > 0) qtd = qtd ?? n; return; }
      if (v.trim()) extras.push({ name: g, value_name: v.trim() });
    });
    return { extras, qtd };
  };
  const escolhidas = (linhas ?? []).filter((l) => l.incluir);
  const assinatura = (l: Linha) => { const a = atributosDe(l); return `${a.qtd ?? ""}|${a.extras.map((x) => `${x.name}=${x.value_name}`).join(";")}`; };
  const repetidas = escolhidas.filter((l, i) => escolhidas.findIndex((o) => assinatura(o) === assinatura(l)) !== i);
  const pedido = JSON.stringify({ pausado, l: escolhidas.map((l) => [l.sku, l.preco, assinatura(l)]) });
  const conferidoAgora = confDe === pedido;

  const opcoes = (l: Linha) => {
    const a = atributosDe(l);
    return {
      modo: "criar", preco: numero(l.preco), estoque: 1, fora_do_ar: pausado,
      variacao: { sku: l.sku, atributos_extra: a.extras },
      ...(a.qtd ? { atributos: { UNITS_PER_PACK: String(a.qtd) } } : {}),
    };
  };
  const destino = { canal: "mercado_livre", empresa };

  async function conferir() {
    if (!rascunho) return;
    setOcupado("conferindo"); setConf({}); setFeitos([]);
    const out: Record<string, Conferido | { erro: string }> = {};
    for (const l of escolhidas) {
      try {
        const r = (await chamarPublicar("previa", { rascunho_id: rascunho.id, destino, opcoes: opcoes(l) })) as any;
        out[l.sku] = { pendencias: r.pendencias ?? [], avisos: r.avisos ?? [], existentes: r.existentes ?? [], titulo: r.previa?.titulo };
      } catch (e) { out[l.sku] = { erro: (e as Error).message }; }
      setConf({ ...out });
    }
    setConfDe(pedido); setOcupado("");
  }

  const prontas = escolhidas.filter((l) => { const c = conf[l.sku]; return c && !("erro" in c) && c.pendencias.length === 0; });
  const podeEnviar = !!rascunho && conferidoAgora && escolhidas.length > 0 && prontas.length === escolhidas.length && repetidas.length === 0;

  async function criar() {
    if (!rascunho || !podeEnviar) return;
    const lista = escolhidas.map((l) => { const a = atributosDe(l); return `• ${l.sku} — ${[...a.extras.map((x) => x.value_name), a.qtd ? `${a.qtd} un` : ""].filter(Boolean).join(" · ")} — ${formatBRL(numero(l.preco) ?? 0)}`; });
    if (!window.confirm([`Criar ${escolhidas.length} anúncio(s) no Mercado Livre (${empresa === "svl" ? "SVL" : "Ottz"}), um por variação?`, "",
      ...lista, "", `Mesmo nome de família ("${rascunho.titulo ?? ""}"): o Mercado Livre junta todos na mesma página.`,
      pausado ? "Nascem PAUSADOS (estoque 1); ative no Mercado Livre depois de conferir." : "Nascem NO AR, com estoque 1, antes de o Tiny assumir o estoque pelo SKU."].join("\n"))) return;
    setOcupado("enviando");
    const out: Feito[] = [];
    for (const l of escolhidas) {
      try {
        const r = (await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino, opcoes: opcoes(l), confirmar: true })) as any;
        if (r.ok === false || !r.item_id) { out.push({ sku: l.sku, ok: false, erro: r.erro ?? "recusado" }); setFeitos([...out]); break; }
        out.push({ sku: l.sku, ok: true, item_id: r.item_id, url: r.url, pausado: r.fora_do_ar });
      } catch (e) { out.push({ sku: l.sku, ok: false, erro: (e as Error).message }); setFeitos([...out]); break; }
      setFeitos([...out]);
    }
    setOcupado("");
    const ok = out.filter((x) => x.ok).length;
    if (ok === escolhidas.length) toast.success(`${ok} anúncio(s) criado(s) no Mercado Livre`, { description: "Um por variação, mesmo nome de família." });
    else toast.error(`Parou na variação ${out[out.length - 1]?.sku}: ${ok} de ${escolhidas.length} criado(s)`, { duration: 20000 });
    setConfDe(null);
  }

  const mudar = (s: string, p: Partial<Linha>) => setLinhas((ls) => (ls ?? []).map((l) => (l.sku === s ? { ...l, ...p } : l)));

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Layers className="h-4 w-4" />Variações no Mercado Livre</div>
      <p className="text-xs text-muted-foreground">
        No Mercado Livre não existe um anúncio com lista de variações: cada variação vira um anúncio próprio, com o mesmo nome
        de família, e o Mercado Livre junta todos na mesma página. Texto e fotos são os deste anúncio; SKU, peso e preço são de
        cada variação. O que diferencia uma da outra vai na quantidade do pacote e na grade do Tiny{grades.length ? ` (${grades.join(" · ")})` : ""}.
      </p>
      {!rascunho && <p className="text-xs text-amber-700 dark:text-amber-400">Gere ou escreva o texto do anúncio antes (o título vira o nome da família).</p>}
      {baseQ.isLoading || (baseQ.data && !linhas) ? <div className="text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />Lendo as variações…</div> : null}
      {baseQ.isError && <p className="text-xs text-destructive">Não consegui ler as variações: {(baseQ.error as Error).message}</p>}
      {linhas && linhas.length === 0 && <p className="text-xs text-muted-foreground">Este produto não tem variações ativas no cadastro.</p>}

      {linhas && linhas.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2" /><th className="py-1 pr-2">SKU</th><th className="py-1 pr-2">Diferença</th><th className="py-1 pr-2">Qtd. pacote</th>
                <th className="py-1 pr-2">Preço</th><th className="py-1">Conferência</th>
              </tr></thead>
              <tbody>
                {linhas.map((l) => {
                  const a = atributosDe(l);
                  const c = conf[l.sku];
                  const f = feitos.find((x) => x.sku === l.sku);
                  return (
                    <tr key={l.sku} className="border-t align-top">
                      <td className="py-1.5 pr-2"><Checkbox checked={l.incluir} disabled={!!ocupado} onCheckedChange={(v) => mudar(l.sku, { incluir: v === true })} /></td>
                      <td className="py-1.5 pr-2 font-mono">{l.sku}</td>
                      <td className="py-1.5 pr-2">{a.extras.length ? a.extras.map((x) => `${x.name}: ${x.value_name}`).join(" · ") : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-1.5 pr-2 tabular-nums">{a.qtd ?? "—"}</td>
                      <td className="py-1.5 pr-2"><Input className="h-7 w-24 text-right tabular-nums text-xs" inputMode="decimal" value={l.preco} disabled={!!ocupado}
                        onChange={(e) => mudar(l.sku, { preco: e.target.value })} placeholder="preço" /></td>
                      <td className="py-1.5 space-y-0.5">
                        {f ? (f.ok
                          ? <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />criado {f.item_id}{f.pausado ? " · pausado" : ""}
                              {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex"><ExternalLink className="h-3 w-3" /></a>}</span>
                          : <span className="text-destructive">{f.erro}</span>)
                          : !c ? <span className="text-muted-foreground">—</span>
                          : "erro" in c ? <span className="text-destructive">{c.erro}</span>
                          : <>
                              {c.pendencias.length === 0 ? <span className="text-emerald-700 dark:text-emerald-400">pronto para criar</span> : null}
                              {c.pendencias.map((x) => <div key={x} className="text-destructive">• {x}</div>)}
                              {c.existentes.length > 0 && <div className="text-amber-700 dark:text-amber-400">• já há {c.existentes.length} anúncio(s) com este SKU nesta conta: criar gera duplicado</div>}
                            </>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {repetidas.length > 0 && (
            <p className="text-xs text-destructive flex items-start gap-1"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {repetidas.map((l) => l.sku).join(", ")}: mesma quantidade e mesma grade de outra variação — o Mercado Livre não teria como diferenciar.</p>
          )}
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={pausado} disabled={!!ocupado} onCheckedChange={(v) => setPausado(v === true)} />criar pausados (ative no Mercado Livre depois de conferir)
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!rascunho || !!ocupado || escolhidas.length === 0} onClick={() => void conferir()}>
              {ocupado === "conferindo" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}Conferir no Mercado Livre
            </Button>
            <Button size="sm" disabled={!podeEnviar || !!ocupado} onClick={() => void criar()}>
              {ocupado === "enviando" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}Criar {escolhidas.length} anúncio(s) no Mercado Livre
            </Button>
            {!conferidoAgora && Object.keys(conf).length > 0 && !ocupado && <span className="text-xs text-muted-foreground">mudou algo: confira de novo</span>}
          </div>
        </>
      )}
    </CardContent></Card>
  );
}
