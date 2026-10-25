import { useState } from "react";
import { AlertTriangle, CheckCircle2, Landmark, Loader2, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { chamarMlFiscal } from "@/lib/iaAnuncio";

// ============================================================================
// Só os DADOS FISCAIS do produto no Mercado Livre (25/out/2026, pedido do dono): NCM, origem e CEST, sem mexer no
// anúncio. O ML guarda isso por SKU (vale para todo anúncio do produto); kit usa os dados do componente. Valores
// sugeridos = Tiny; dá para corrigir. Conferir só lê; Enviar = um envio por SKU, com confirmação
// (edge fn `ml-fiscal`, módulos previa/aplicar).
// ============================================================================

interface LinhaFiscal { campo: "ncm" | "origem" | "cest"; nome: string; atual: string; novo: string; fonte: string; muda: boolean }
interface ItemFiscal {
  sku: string; nome: string | null; quantidade: number | null; existe: boolean; pode_faturar: boolean | null; regra: string | null;
  metodo: "PUT" | "POST" | null; linhas: LinhaFiscal[];
}
interface Previa { conta: string; sku: string; tipo: string | null; nada_a_mudar: boolean; itens: ItemFiscal[] }
type Valores = Record<string, Partial<Record<LinhaFiscal["campo"], string>>>;
interface Feito { sku: string; ok: boolean; metodo: string; status: number; erro: string | null; enviados: string[]; depois: Record<string, string> | null }

const ORIGENS = [
  ["0", "0 · Nacional"], ["1", "1 · Estrangeira, importação direta"], ["2", "2 · Estrangeira, mercado interno"],
  ["3", "3 · Nacional, importado 40–70%"], ["4", "4 · Nacional, processo básico"], ["5", "5 · Nacional, importado até 40%"],
  ["6", "6 · Estrangeira direta, sem similar"], ["7", "7 · Estrangeira interna, sem similar"], ["8", "8 · Nacional, importado acima de 70%"],
];
const rotulo = (campo: string, v: string) => (!v ? "—" : campo === "origem" ? (ORIGENS.find((o) => o[0] === v)?.[1] ?? v) : v);

/** Bloco na aba Anúncio (destino Mercado Livre). */
export function FiscalML({ sku, empresa }: { sku: string; empresa: string }) {
  const [alvo, setAlvo] = useState(sku);
  const [valores, setValores] = useState<Valores>({});
  const [lendo, setLendo] = useState(false);
  const [previa, setPrevia] = useState<{ chave: string; p: Previa; pendencias: string[]; avisos: string[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: boolean; erro?: string; feitos?: Feito[] } | null>(null);
  const conta = empresa === "svl" ? "SVL" : "Ottz";

  const pedido = (s = alvo, v = valores) => ({ empresa, sku: s.trim(), valores: v });
  const chave = JSON.stringify(pedido());

  async function conferir(s = alvo, v = valores) {
    if (!s.trim()) return;
    setLendo(true); setErro(null); setConfirmar(false); setResultado(null);
    try {
      const j = await chamarMlFiscal("previa", pedido(s, v));
      setPrevia({ chave: JSON.stringify(pedido(s, v)), p: j.previa, pendencias: j.pendencias ?? [], avisos: j.avisos ?? [] });
    } catch (e) {
      setPrevia(null); setErro(String(e instanceof Error ? e.message : e));
    } finally { setLendo(false); }
  }

  async function enviar() {
    setEnviando(true);
    try {
      const j = await chamarMlFiscal("aplicar", { ...pedido(), confirmar: true });
      setResultado(j);
      toast.success("Dados fiscais enviados ao Mercado Livre", { description: (j.feitos ?? []).map((f: Feito) => `${f.sku}: ${f.enviados.join(", ")}`).join(" · ") });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      setResultado({ ok: false, erro: msg });
      toast.error("O Mercado Livre não aceitou", { description: msg });
    } finally { setEnviando(false); setConfirmar(false); }
  }

  const mudar = (s: string, campo: LinhaFiscal["campo"], v: string) => {
    setValores((x) => ({ ...x, [s]: { ...(x[s] ?? {}), [campo]: v } })); setConfirmar(false); setResultado(null);
  };
  const atual = previa && previa.chave === chave;
  const p = previa?.p;
  const vaiMudar = (p?.itens ?? []).filter((i) => i.metodo).map((i) => ({ i, l: i.linhas.filter((l) => l.muda) }));
  const podeEnviar = atual && !!p && previa!.pendencias.length === 0 && !p.nada_a_mudar && !resultado?.ok;
  const valorTela = (s: string, l: LinhaFiscal) => valores[s]?.[l.campo] ?? l.novo;

  return (
    <Card>
      <CardContent className="p-4 space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" />
          <b>Dados fiscais no Mercado Livre</b>
          <span className="text-xs text-muted-foreground">NCM, origem e CEST do produto na conta {conta} — sem mexer no anúncio. O ML guarda por SKU: vale para todos os anúncios do produto.</span>
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setValores({}); void conferir(alvo, {}); }}>
          <Input value={alvo} onChange={(e) => setAlvo(e.target.value)} placeholder="nosso SKU" className="h-8 max-w-[10rem]" />
          <Button type="submit" size="sm" variant="outline" disabled={lendo || !alvo.trim()}>
            {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Search className="h-3.5 w-3.5 mr-1" />}Conferir
          </Button>
        </form>
        {erro && <p className="text-xs text-destructive">{erro}</p>}

        {p && (
          <div className="space-y-3">
            {p.itens.map((it) => (
              <div key={it.sku} className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-medium">{it.quantidade ? `${it.quantidade}× ` : ""}{it.nome ?? it.sku}</span>
                  <span className="text-muted-foreground">
                    SKU {it.sku} · {it.existe ? `cadastrado no ML${it.pode_faturar ? " · pode emitir nota" : " · ML diz que NÃO pode emitir nota"}${it.regra ? ` · regra ${it.regra}` : ""}` : "ainda sem cadastro fiscal no ML"}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-3 font-normal">Campo</th><th className="py-1 pr-3 font-normal">No ML hoje</th>
                      <th className="py-1 pr-3 font-normal">Vai ficar</th><th className="py-1 font-normal">De onde vem</th>
                    </tr></thead>
                    <tbody>
                      {it.linhas.map((l) => (
                        <tr key={l.campo} className="border-t">
                          <td className="py-1.5 pr-3 font-medium">{l.nome}</td>
                          <td className="py-1.5 pr-3">{rotulo(l.campo, l.atual)}</td>
                          <td className="py-1.5 pr-3">
                            {l.campo === "origem" ? (
                              <select className="h-7 rounded-md border bg-background px-1.5 text-xs" value={valorTela(it.sku, l)} onChange={(e) => mudar(it.sku, l.campo, e.target.value)}>
                                {ORIGENS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                              </select>
                            ) : (
                              <Input className="h-7 w-32 text-xs" inputMode="numeric" value={valorTela(it.sku, l)} placeholder={l.campo === "cest" ? "sem CEST" : ""}
                                onChange={(e) => mudar(it.sku, l.campo, e.target.value)} />
                            )}
                            {atual && l.muda && <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">muda</span>}
                          </td>
                          <td className="py-1.5 text-muted-foreground">{valores[it.sku]?.[l.campo] !== undefined ? "digitado" : l.fonte || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {!atual && <p className="text-xs text-amber-700 dark:text-amber-400">Você mudou algum valor: clique em Conferir de novo antes de enviar.</p>}
            {atual && previa!.pendencias.length > 0 && (
              <ul className="space-y-0.5 text-xs text-destructive">{previa!.pendencias.map((x) => <li key={x} className="flex gap-1"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />{x}</li>)}</ul>
            )}
            {atual && previa!.avisos.length > 0 && (
              <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-400">{previa!.avisos.map((x) => <li key={x}>• {x}</li>)}</ul>
            )}
            {atual && p.nada_a_mudar && !previa!.pendencias.length && (
              <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />Os dados fiscais no ML já estão assim: nada a enviar.</p>
            )}

            {resultado && (
              <div className={`rounded-md border p-2 text-xs space-y-0.5 ${resultado.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}>
                {(resultado.feitos ?? []).map((f) => (
                  <div key={f.sku}>
                    <b>{f.sku}:</b> {f.ok
                      ? <>enviado ({f.enviados.join(", ")}). {f.depois && <>Lido de volta: NCM {f.depois.ncm || "—"} · origem {f.depois.origem || "—"} · CEST {f.depois.cest || "—"}{f.depois.pode_faturar === "true" ? " · pode emitir nota" : ""}.</>}</>
                      : <span className="text-destructive">{f.erro}</span>}
                  </div>
                ))}
                {!resultado.ok && resultado.erro && <div className="text-destructive">{resultado.erro}</div>}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {confirmar && podeEnviar ? (
                <>
                  <span className="text-xs text-muted-foreground mr-auto">
                    Vai alterar o cadastro fiscal no Mercado Livre {conta}: {vaiMudar.map(({ i, l }) => `${i.sku} — ${i.existe ? l.map((x) => `${x.nome} ${rotulo(x.campo, x.atual)} → ${rotulo(x.campo, x.novo)}`).join("; ") : "cadastro novo"}`).join(" · ")}. Vale para todos os anúncios do produto. Vai uma vez só.
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
