import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { calcularPreco, chamarPublicar, chamarVariacoes, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// Produto com variações na AMAZON — a família inteira pela tela (29/out/2026, pedido do dono: "não conseguimos
// automatizar a criação de anúncios na Amazon" para produto pai). anuncio-publicar v16: o rascunho do PAI vai uma
// vez como anúncio pai (opcoes.pai_amz, sem oferta nem preço) e uma vez por variação (opcoes.variacao +
// opcoes.familia_amz), com SKU, peso, EAN e preço da variação; texto e fotos do pai. Pai primeiro, depois as
// variações, uma por vez, com confirmação; para no primeiro recusado.
// ============================================================================

interface Linha { sku: string; nome: string; valor: string; preco: string; ean: string; incluir: boolean }
interface Atributo { id: string; nome: string; obrigatorio: boolean; valor: string; opcoes: string[] }
interface Conferido { pendencias: string[]; avisos: string[]; titulo?: string; skuAmz?: string; temas?: string[]; tema?: string; faltam?: Atributo[] }
interface Feito { sku: string; ok: boolean; item_id?: string; url?: string | null; erro?: string; pulado?: boolean }

const numero = (s: string) => { const n = Number(String(s).replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
const ehMedida = (vs: string[]) => vs.length > 0 && vs.every((v) => /\d/.test(v) && /(kg|g|ml|l|cm|un|unid|x)\b/i.test(v));
const JA_EXISTE = /já existe o anúncio/i;

export function FamiliaAmazon({ sku, empresa, rascunho }: { sku: string; empresa: string; rascunho: IaRascunho | null }) {
  const [linhas, setLinhas] = useState<Linha[] | null>(null);
  const [tema, setTema] = useState("");
  const [temas, setTemas] = useState<string[]>([]);
  const [conf, setConf] = useState<Record<string, Conferido | { erro: string }>>({});
  const [confDe, setConfDe] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<"" | "conferindo" | "enviando">("");
  const [feitos, setFeitos] = useState<Feito[]>([]);
  // campos que a Amazon exige e vieram vazios (ex.: Cor em areia): preenchidos uma vez, valem para o pai e as variações
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [pedidos, setPedidos] = useState<Atributo[]>([]);

  // variações ativas, com o valor da grade do Tiny (ou o fim do nome)
  const baseQ = useQuery({
    queryKey: ["ia-anuncio", "amz-familia", sku],
    placeholderData: undefined, staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: filhas } = await supabaseExternal.from("produtos").select("sku, nome, gtin").eq("sku_pai", sku).eq("ativo", true).order("sku");
      const fs = (filhas ?? []) as { sku: string; nome: string | null; gtin: string | null }[];
      let porSku = new Map<string, string[]>();
      try {
        const g = (await chamarVariacoes("grade", { sku_pai: sku })) as { variacoes?: { sku: string; valores: string[] }[] };
        porSku = new Map((g.variacoes ?? []).map((v) => [v.sku, v.valores]));
      } catch { /* sem a grade do Tiny: o valor sai do nome da variação */ }
      return fs.map((f) => {
        const nome = f.nome ?? f.sku;
        const vs = porSku.get(f.sku) ?? [];
        return { sku: f.sku, nome, valor: (vs.length ? vs : nome.split(" - ").slice(1)).join(" ").trim() };
      });
    },
  });

  // preço sugerido de cada variação na Amazon (margem padrão do canal)
  useEffect(() => {
    const b = baseQ.data;
    if (!b || linhas) return;
    let vivo = true;
    void (async () => {
      const precos = await Promise.all(b.map(async (f) => {
        try { return (await calcularPreco(f.sku, "amazon", empresa, null)).preco_sugerido ?? null; } catch { return null; }
      }));
      if (!vivo) return;
      setTema(ehMedida(b.map((f) => f.valor)) ? "SIZE" : "STYLE");
      setLinhas(b.map((f, i) => ({ sku: f.sku, nome: f.nome, valor: f.valor, preco: precos[i] != null ? String(precos[i]).replace(".", ",") : "", ean: "", incluir: true })));
    })();
    return () => { vivo = false; };
  }, [baseQ.data, empresa, linhas]);

  const escolhidas = (linhas ?? []).filter((l) => l.incluir);
  const repetidas = escolhidas.filter((l, i) => escolhidas.findIndex((o) => o.valor.trim().toLowerCase() === l.valor.trim().toLowerCase()) !== i);
  const pedido = JSON.stringify({ tema, extras, l: escolhidas.map((l) => [l.sku, l.valor, l.preco, l.ean]) });
  const atributos = () => { const a = Object.fromEntries(Object.entries(extras).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])); return Object.keys(a).length ? { atributos: a } : {}; };
  const conferidoAgora = confDe === pedido;
  const destino = { canal: "amazon", empresa };
  const PAI = "__pai__";

  const opPai = () => ({ modo: "criar", pai_amz: { tema }, ...atributos() });
  const opFilho = (l: Linha) => ({
    modo: "criar", preco: numero(l.preco), ...atributos(), ...(l.ean.trim() ? { gtin: l.ean.trim() } : {}),
    variacao: { sku: l.sku }, familia_amz: { pai_sku: sku, tema, valor: l.valor.trim() },
  });
  const ler = (r: any): Conferido => ({
    pendencias: r.pendencias ?? [], avisos: r.avisos ?? [], titulo: r.previa?.titulo,
    skuAmz: r.previa?.amazon?.sku_amazon, temas: r.previa?.amazon?.familia?.temas ?? [], tema: r.previa?.amazon?.familia?.tema,
    faltam: ((r.previa?.atributos ?? []) as Atributo[]).filter((a) => a.obrigatorio && !String(a.valor ?? "").trim()),
  });

  async function conferir() {
    if (!rascunho) return;
    setOcupado("conferindo"); setConf({}); setFeitos([]);
    const out: Record<string, Conferido | { erro: string }> = {};
    try {
      const p = ler(await chamarPublicar("previa", { rascunho_id: rascunho.id, destino, opcoes: opPai() }));
      out[PAI] = p;
      if (p.temas?.length) setTemas(p.temas);
    } catch (e) { out[PAI] = { erro: (e as Error).message }; }
    setConf({ ...out });
    for (const l of escolhidas) {
      try { out[l.sku] = ler(await chamarPublicar("previa", { rascunho_id: rascunho.id, destino, opcoes: opFilho(l) })); }
      catch (e) { out[l.sku] = { erro: (e as Error).message }; }
      setConf({ ...out });
    }
    // junta os campos exigidos e vazios de todos (sem repetir), para a pessoa preencher uma vez
    const m = new Map<string, Atributo>();
    for (const c of Object.values(out)) if (!("erro" in c)) for (const a of c.faltam ?? []) if (!m.has(a.id)) m.set(a.id, a);
    setPedidos((ant) => [...new Map([...ant, ...m.values()].map((a) => [a.id, a])).values()]);
    setConfDe(pedido); setOcupado("");
  }

  const cPai = conf[PAI];
  // o pai que já existe na conta não é criado de novo: as variações entram nele
  const paiExiste = !!cPai && !("erro" in cPai) && cPai.pendencias.length > 0 && cPai.pendencias.every((x) => JA_EXISTE.test(x));
  const paiPronto = !!cPai && !("erro" in cPai) && (cPai.pendencias.length === 0 || paiExiste);
  const filhasProntas = escolhidas.filter((l) => { const c = conf[l.sku]; return c && !("erro" in c) && c.pendencias.length === 0; });
  const podeEnviar = !!rascunho && conferidoAgora && paiPronto && escolhidas.length > 0 && filhasProntas.length === escolhidas.length && repetidas.length === 0;

  async function criar() {
    if (!rascunho || !podeEnviar) return;
    const lista = escolhidas.map((l) => `• ${l.sku}_FBA — ${l.valor} — ${formatBRL(numero(l.preco) ?? 0)}`);
    if (!window.confirm([
      `Criar a família na Amazon (${empresa === "svl" ? "SVL" : "ACZ"}), variação por ${tema}?`, "",
      paiExiste ? `Anúncio pai ${sku}: já existe, as variações entram nele.` : `1) anúncio PAI ${sku} (não se vende, só agrupa)`,
      `${paiExiste ? "" : "2) "}${escolhidas.length} variação(ões), ficha nova pelo FBA:`, ...lista, "",
      "Texto e fotos são os deste anúncio. Cada uma só vende depois que o estoque chegar ao CD da Amazon.",
    ].join("\n"))) return;
    setOcupado("enviando");
    const out: Feito[] = [];
    const parar = (f: Feito) => { out.push(f); setFeitos([...out]); };
    if (!paiExiste) {
      try {
        const r = (await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino, opcoes: opPai(), confirmar: true })) as any;
        if (r.ok === false || !r.item_id) { parar({ sku: PAI, ok: false, erro: r.erro ?? "recusado" }); setOcupado(""); toast.error(`A Amazon recusou o anúncio pai: ${r.erro ?? ""}`, { duration: 20000 }); return; }
        out.push({ sku: PAI, ok: true, item_id: r.item_id, url: r.url }); setFeitos([...out]);
      } catch (e) { parar({ sku: PAI, ok: false, erro: (e as Error).message }); setOcupado(""); return; }
    } else out.push({ sku: PAI, ok: true, pulado: true, item_id: sku });
    for (const l of escolhidas) {
      try {
        const r = (await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino, opcoes: opFilho(l), confirmar: true })) as any;
        if (r.ok === false || !r.item_id) { parar({ sku: l.sku, ok: false, erro: r.erro ?? "recusado" }); break; }
        out.push({ sku: l.sku, ok: true, item_id: r.item_id, url: r.url });
      } catch (e) { parar({ sku: l.sku, ok: false, erro: (e as Error).message }); break; }
      setFeitos([...out]);
    }
    setOcupado("");
    const ok = out.filter((x) => x.ok && x.sku !== PAI).length;
    if (ok === escolhidas.length) toast.success(`Família criada na Amazon: pai + ${ok} variação(ões)`, { description: "A Amazon processa em alguns minutos (às vezes horas) e só então dá os ASINs." });
    else toast.error(`Parou em ${out[out.length - 1]?.sku}: ${ok} de ${escolhidas.length} variação(ões) criada(s)`, { duration: 20000 });
    setConfDe(null);
  }

  const mudar = (s: string, p: Partial<Linha>) => setLinhas((ls) => (ls ?? []).map((l) => (l.sku === s ? { ...l, ...p } : l)));
  const situacao = (chave: string) => {
    const f = feitos.find((x) => x.sku === chave);
    if (f) return f.ok
      ? <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />{f.pulado ? "já existia" : `criado ${f.item_id}`}
          {f.url && <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex"><ExternalLink className="h-3 w-3" /></a>}</span>
      : <span className="text-destructive">{f.erro}</span>;
    const c = conf[chave];
    if (!c) return <span className="text-muted-foreground">—</span>;
    if ("erro" in c) return <span className="text-destructive">{c.erro}</span>;
    if (chave === PAI && paiExiste) return <span className="text-emerald-700 dark:text-emerald-400">já existe: as variações entram nele</span>;
    return <>
      {c.pendencias.length === 0 && <span className="text-emerald-700 dark:text-emerald-400">pronto para criar</span>}
      {c.pendencias.map((x) => <div key={x} className="text-destructive">• {x}</div>)}
      {c.avisos.filter((x) => /código de barras|isenção|peso|NCM|origem|ainda não existe/i.test(x)).map((x) => <div key={x} className="text-amber-700 dark:text-amber-400">• {x}</div>)}
    </>;
  };

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium"><Layers className="h-4 w-4" />Família na Amazon ({empresa === "svl" ? "SVL" : "ACZ"})</div>
      <p className="text-xs text-muted-foreground">
        Cria o anúncio <b>pai</b> (agrupa, não se vende) e um anúncio por <b>variação</b>, já ligados na mesma página da Amazon.
        Texto e fotos são os deste anúncio; SKU, peso, código de barras e preço são de cada variação. Tudo é conferido no
        validador da Amazon antes; nada é criado sem a sua confirmação.
      </p>
      {!rascunho && <p className="text-xs text-amber-700 dark:text-amber-400">Gere ou escreva o texto do anúncio antes.</p>}
      {baseQ.isLoading || (baseQ.data && !linhas) ? <div className="text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin inline mr-1" />Lendo as variações…</div> : null}
      {baseQ.isError && <p className="text-xs text-destructive">Não consegui ler as variações: {(baseQ.error as Error).message}</p>}
      {linhas && linhas.length === 0 && <p className="text-xs text-muted-foreground">Este produto não tem variações ativas no cadastro.</p>}

      {linhas && linhas.length > 0 && (
        <>
          <label className="flex flex-wrap items-center gap-2 text-xs">
            Variação por
            {temas.length ? (
              <select className="h-7 rounded border bg-background px-2 text-xs" value={tema} disabled={!!ocupado} onChange={(e) => setTema(e.target.value)}>
                {[...new Set([tema, ...temas])].filter(Boolean).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            ) : (
              <Input className="h-7 w-40 text-xs font-mono" value={tema} disabled={!!ocupado} onChange={(e) => setTema(e.target.value.toUpperCase())} />
            )}
            <span className="text-muted-foreground">(SIZE = tamanho/peso, STYLE = tipo/estilo; a lista completa aparece depois de conferir)</span>
          </label>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2" /><th className="py-1 pr-2">SKU na Amazon</th><th className="py-1 pr-2">Valor da variação</th>
                <th className="py-1 pr-2">Preço</th><th className="py-1 pr-2">EAN (opcional)</th><th className="py-1">Conferência</th>
              </tr></thead>
              <tbody>
                <tr className="border-t align-top bg-muted/30">
                  <td className="py-1.5 pr-2" /><td className="py-1.5 pr-2 font-mono">{sku}</td>
                  <td className="py-1.5 pr-2 text-muted-foreground" colSpan={3}>anúncio pai (sem preço, sem estoque)</td>
                  <td className="py-1.5 space-y-0.5">{situacao(PAI)}</td>
                </tr>
                {linhas.map((l) => (
                  <tr key={l.sku} className="border-t align-top">
                    <td className="py-1.5 pr-2"><Checkbox checked={l.incluir} disabled={!!ocupado} onCheckedChange={(v) => mudar(l.sku, { incluir: v === true })} /></td>
                    <td className="py-1.5 pr-2 font-mono" title={l.nome}>{l.sku}_FBA</td>
                    <td className="py-1.5 pr-2"><Input className="h-7 w-40 text-xs" value={l.valor} disabled={!!ocupado} onChange={(e) => mudar(l.sku, { valor: e.target.value })} placeholder="ex.: Sílica Grossa" /></td>
                    <td className="py-1.5 pr-2"><Input className="h-7 w-24 text-right tabular-nums text-xs" inputMode="decimal" value={l.preco} disabled={!!ocupado}
                      onChange={(e) => mudar(l.sku, { preco: e.target.value })} placeholder="preço" /></td>
                    <td className="py-1.5 pr-2"><Input className="h-7 w-36 font-mono text-xs" inputMode="numeric" value={l.ean} disabled={!!ocupado}
                      onChange={(e) => mudar(l.sku, { ean: e.target.value })} placeholder="do cadastro" /></td>
                    <td className="py-1.5 space-y-0.5">{situacao(l.sku)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {repetidas.length > 0 && <p className="text-xs text-destructive">{repetidas.map((l) => l.sku).join(", ")}: mesmo valor de outra variação — a Amazon não aceita dois iguais na família.</p>}
          {pedidos.length > 0 && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 space-y-2">
              <div className="text-xs text-amber-700 dark:text-amber-400">A Amazon exige estes campos. Preencha uma vez: vale para o pai e todas as variações. Depois, confira de novo.</div>
              <div className="flex flex-wrap gap-2">
                {pedidos.map((a) => (
                  <label key={a.id} className="block text-xs">
                    <span className="text-muted-foreground">{a.nome}</span>
                    <Input className="h-7 w-48 text-xs mt-0.5" list={`fam-amz-${a.id}`} value={extras[a.id] ?? ""} disabled={!!ocupado}
                      onChange={(e) => setExtras((x) => ({ ...x, [a.id]: e.target.value }))} placeholder={a.id === "color" ? "ex.: Branco" : ""} />
                    {a.opcoes.length > 0 && <datalist id={`fam-amz-${a.id}`}>{a.opcoes.map((o) => <option key={o} value={o} />)}</datalist>}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!rascunho || !!ocupado || escolhidas.length === 0 || !tema} onClick={() => void conferir()}>
              {ocupado === "conferindo" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}Conferir na Amazon
            </Button>
            <Button size="sm" disabled={!podeEnviar || !!ocupado} onClick={() => void criar()}>
              {ocupado === "enviando" ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}Criar a família ({paiExiste ? "" : "pai + "}{escolhidas.length} variação(ões))
            </Button>
            {!conferidoAgora && Object.keys(conf).length > 0 && !ocupado && <span className="text-xs text-muted-foreground">mudou algo: confira de novo</span>}
          </div>
        </>
      )}
    </CardContent></Card>
  );
}
