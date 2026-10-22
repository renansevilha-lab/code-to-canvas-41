import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Landmark, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { chamarAmazonVariacoes } from "@/lib/iaAnuncio";

// ============================================================================
// Só os DADOS FISCAIS de um anúncio Amazon que já existe (22/out/2026, pedido do dono).
// NCM, origem, atividade da empresa e CEST — sem mexer em título, fotos ou preço. Pesquisa pelo ASIN,
// SKU da Amazon ou nosso SKU. Os valores sugeridos vêm do Tiny (NCM e CEST), da regra da casa (origem 0)
// e da conta (atividade); dá para corrigir. Só vai o campo que muda. Conferir = validador da Amazon (não
// grava); Enviar = um envio só, com confirmação (edge fn `amazon-variacoes`, módulos fiscal-previa/-aplicar).
// ============================================================================

interface LinhaFiscal { campo: "ncm" | "origem" | "papel" | "cest"; nome: string; atual: string; novo: string; fonte: string; muda: boolean }
interface Previa {
  conta: string; sku_amazon: string; skus_achados: string[]; asin: string | null; nome: string | null; tipo: string | null;
  situacao: string[]; url: string | null; nosso_sku: string | null; nome_cadastro: string | null; origem_tiny: string | null;
  linhas: LinhaFiscal[]; nada_a_mudar: boolean; validacao: string | null;
}
type Valores = Partial<Record<LinhaFiscal["campo"], string>>;

const ORIGENS = [
  ["0", "0 · Nacional"], ["1", "1 · Estrangeira, importação direta"], ["2", "2 · Estrangeira, mercado interno"],
  ["3", "3 · Nacional, importado 40–70%"], ["4", "4 · Nacional, processo básico"], ["5", "5 · Nacional, importado até 40%"],
  ["6", "6 · Estrangeira direta, sem similar"], ["7", "7 · Estrangeira interna, sem similar"], ["8", "8 · Nacional, importado acima de 70%"],
];
const PAPEIS = [["distributor", "Distribuidor"], ["manufacturer", "Fabricante"], ["importer", "Importador"]];
const rotulo = (campo: string, v: string) =>
  !v ? "—" : campo === "origem" ? (ORIGENS.find((o) => o[0] === v)?.[1] ?? v) : campo === "papel" ? (PAPEIS.find((p) => p[0] === v)?.[1] ?? v) : v;

/** Bloco na aba Anúncio (destino Amazon). */
export function FiscalAmazon({ sku, empresa }: { sku: string; empresa: string }) {
  const [busca, setBusca] = useState(sku);
  const [skuAmz, setSkuAmz] = useState<string | null>(null);
  const [valores, setValores] = useState<Valores>({});
  const [lendo, setLendo] = useState(false);
  const [previa, setPrevia] = useState<{ chave: string; p: Previa; pendencias: string[]; avisos: string[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; erro?: string; enviados?: string[]; depois?: Record<string, string> | null; aviso?: string } | null>(null);

  const pedido = (q = busca, item = skuAmz, v = valores) => ({ empresa, busca: q.trim(), item_id: item ?? undefined, valores: v });
  const chave = JSON.stringify(pedido());

  async function conferir(q = busca, item = skuAmz, v = valores) {
    if (!q.trim()) return;
    setLendo(true); setErro(null); setConfirmar(false); setResultado(null);
    try {
      const j = await chamarAmazonVariacoes("fiscal-previa", pedido(q, item, v));
      if (!j.ok) throw new Error(j.erro ?? "falha ao conferir");
      // o SKU da Amazon que a função escolheu passa a valer: a conferência é DESTE anúncio
      const achado = String(j.previa.sku_amazon);
      setSkuAmz(achado);
      setPrevia({ chave: JSON.stringify(pedido(q, achado, v)), p: j.previa, pendencias: j.pendencias ?? [], avisos: j.avisos ?? [] });
    } catch (e) {
      setPrevia(null); setErro(String(e instanceof Error ? e.message : e));
    } finally { setLendo(false); }
  }

  async function enviar() {
    setEnviando(true);
    try {
      const j = await chamarAmazonVariacoes("fiscal-aplicar", { ...pedido(), confirmar: true });
      setResultado(j);
      if (j.ok) toast.success("Dados fiscais enviados à Amazon", { description: (j.enviados ?? []).join(", ") });
      else toast.error("A Amazon recusou", { description: j.erro });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setResultado({ ok: false, erro: msg });
      toast.error("Falha ao enviar", { description: msg });
    } finally { setEnviando(false); setConfirmar(false); }
  }

  const mudar = (campo: LinhaFiscal["campo"], v: string) => { setValores((x) => ({ ...x, [campo]: v })); setConfirmar(false); setResultado(null); };
  const atual = previa && previa.chave === chave;
  const p = previa?.p;
  const vaiMudar = p?.linhas.filter((l) => l.muda) ?? [];
  const podeEnviar = atual && !!p && previa!.pendencias.length === 0 && !p.nada_a_mudar && !resultado?.ok;
  const valorTela = (l: LinhaFiscal) => valores[l.campo] ?? l.novo;

  return (
    <Card>
      <CardContent className="p-4 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" />
          <b>Dados fiscais na Amazon</b>
          <span className="text-xs text-muted-foreground">NCM, origem, atividade e CEST de um anúncio que já existe — sem mexer em título, fotos ou preço. Conta {empresa === "svl" ? "SVL" : "ACZ"}.</span>
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setSkuAmz(null); setValores({}); void conferir(busca, null, {}); }}>
          <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="ASIN (B0…), SKU da Amazon ou nosso SKU" className="h-8 max-w-xs" />
          <Button type="submit" size="sm" variant="outline" disabled={lendo || !busca.trim()}>
            {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Search className="h-3.5 w-3.5 mr-1" />}Conferir
          </Button>
        </form>
        {erro && <p className="text-xs text-destructive">{erro}</p>}

        {p && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="font-medium">{p.nome ?? p.sku_amazon}</span>
              <span className="text-muted-foreground">SKU Amazon {p.sku_amazon}{p.asin ? ` · ASIN ${p.asin}` : ""}{p.nosso_sku ? ` · nosso SKU ${p.nosso_sku}` : ""} · {p.situacao.join(", ") || "sem situação"}</span>
              {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">ver na Amazon <ExternalLink className="h-3 w-3" /></a>}
            </div>
            {p.skus_achados.length > 1 && (
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted-foreground">Este ASIN tem {p.skus_achados.length} SKUs nossos:</span>
                {p.skus_achados.map((s) => (
                  <Button key={s} size="sm" variant={s === p.sku_amazon ? "secondary" : "ghost"} className="h-6 px-2 text-[11px]"
                    onClick={() => { setSkuAmz(s); setValores({}); void conferir(busca, s, {}); }}>{s}</Button>
                ))}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">Campo</th><th className="py-1 pr-3 font-normal">No anúncio hoje</th>
                  <th className="py-1 pr-3 font-normal">Vai ficar</th><th className="py-1 font-normal">De onde vem</th>
                </tr></thead>
                <tbody>
                  {p.linhas.map((l) => (
                    <tr key={l.campo} className="border-t">
                      <td className="py-1.5 pr-3 font-medium">{l.nome}</td>
                      <td className="py-1.5 pr-3">{rotulo(l.campo, l.atual)}</td>
                      <td className="py-1.5 pr-3">
                        {l.campo === "origem" || l.campo === "papel" ? (
                          <select className="h-7 rounded-md border bg-background px-1.5 text-xs" value={valorTela(l)} onChange={(e) => mudar(l.campo, e.target.value)}>
                            {(l.campo === "origem" ? ORIGENS : PAPEIS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                          </select>
                        ) : (
                          <Input className="h-7 w-32 text-xs" inputMode="numeric" value={valorTela(l)} placeholder={l.campo === "cest" ? "sem CEST" : ""}
                            onChange={(e) => mudar(l.campo, e.target.value)} />
                        )}
                        {atual && l.muda && <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">muda</span>}
                      </td>
                      <td className="py-1.5 text-muted-foreground">{valores[l.campo] !== undefined ? "digitado" : l.fonte || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {!atual && <p className="text-xs text-amber-700 dark:text-amber-400">Você mudou algum valor: clique em Conferir de novo antes de enviar.</p>}
            {atual && previa!.pendencias.length > 0 && (
              <ul className="space-y-0.5 text-xs text-destructive">{previa!.pendencias.map((x) => <li key={x} className="flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{x}</li>)}</ul>
            )}
            {atual && previa!.avisos.length > 0 && (
              <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">{previa!.avisos.map((x) => <li key={x}>• {x}</li>)}</ul>
            )}
            {atual && p.nada_a_mudar && !previa!.pendencias.length && (
              <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />Os dados fiscais do anúncio já estão assim: nada a enviar.</p>
            )}
            {atual && !p.nada_a_mudar && !previa!.pendencias.length && p.validacao === "VALID" && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">A Amazon validou a alteração (nada foi gravado ainda).</p>
            )}

            {resultado && (
              <div className={`rounded-md border p-2 text-xs ${resultado.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}>
                {resultado.ok ? (
                  <>
                    <b>Enviado: {(resultado.enviados ?? []).join(", ")}.</b>{" "}
                    {resultado.depois && <>Lido de volta: {p.linhas.map((l) => `${l.nome} ${rotulo(l.campo, resultado.depois![l.campo] ?? "")}`).join(" · ")}. </>}
                    <span className="text-muted-foreground">{resultado.aviso}</span>
                  </>
                ) : <span className="text-destructive">{resultado.erro}</span>}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {confirmar && podeEnviar ? (
                <>
                  <span className="text-xs text-muted-foreground mr-auto">
                    Vai alterar o anúncio {p.sku_amazon} na Amazon {empresa === "svl" ? "SVL" : "ACZ"}: {vaiMudar.map((l) => `${l.nome} ${rotulo(l.campo, l.atual)} → ${rotulo(l.campo, l.novo)}`).join("; ")}. Vai uma vez só.
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmar(false)} disabled={enviando}>Voltar</Button>
                  <Button size="sm" onClick={() => void enviar()} disabled={enviando}>
                    {enviando && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Confirmar envio
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" onClick={() => void conferir()} disabled={lendo}>Conferir de novo</Button>
                  <Button size="sm" onClick={() => setConfirmar(true)} disabled={!podeEnviar}>Enviar só os dados fiscais</Button>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
