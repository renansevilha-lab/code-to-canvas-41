import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Receipt } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/lib/format";
import {
  supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { parseNfe } from "@/lib/nfe";

// ============================================================================
// Contas a pagar da NF do fornecedor (01/out/2026): os boletos já vêm na nota —
// XML (cobr/dup: nº, vencimento, valor) ou NF do espelho do Tiny
// (tiny-contas-pagar?modulo=nf-parcelas → GET /notas/{id}.parcelas). O app
// lança cada parcela no Tiny (tiny-contas-pagar?modulo=criar) com o MESMO
// histórico que o Tiny gera ao lançar pela nota — "Ref. a NF nº N, FORNECEDOR
// (parcela i/N)" — e é por ele (+ CNPJ) que detecta conta já lançada, por
// qualquer um dos lados, e não deixa duplicar.
// ============================================================================

interface Parcela { numero: string; vencimento: string; valor: number; incluir: boolean; existe: boolean }
interface Fonte {
  numero: string; emissao: string | null; valor: number; fornecedor: string; cnpj: string | null;
  contatoId: number | null; origem: "tiny" | "xml";
}
interface NfLinkada { tiny_id: number; numero: string | null; data_emissao: string | null; valor: number | null; fornecedor_nome: string | null; fornecedor_cnpj: string | null }

const semZeros = (s: string | null | undefined) => String(s ?? "").trim().replace(/^0+/, "") || String(s ?? "").trim();
const dig = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");
const dataBR = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");

async function fnContas(qs: string, body?: unknown): Promise<any> {
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiny-contas-pagar?${qs}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ...j };
}

export function ContasDaNf({ ordemTinyId, fornecedorId }: { ordemTinyId: number; fornecedorId: number | null }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [aberto, setAberto] = useState(false);
  const [fonte, setFonte] = useState<Fonte | null>(null);
  const [parcelas, setParcelas] = useState<Parcela[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [lancando, setLancando] = useState(false);
  const [buscaContato, setBuscaContato] = useState("");
  const [contatos, setContatos] = useState<Array<{ id: number; nome: string; cpf_cnpj: string | null }>>([]);

  // NFs do Tiny já vinculadas a esta OC
  const nfsQ = useQuery({
    queryKey: ["compras", "nfs-da-oc", ordemTinyId],
    enabled: aberto,
    queryFn: async (): Promise<NfLinkada[]> => {
      const { data, error } = await supabaseExternal.from("compras_nf_entrada")
        .select("tiny_id, numero, data_emissao, valor, fornecedor_nome, fornecedor_cnpj")
        .eq("ordem_tiny_id", ordemTinyId).order("data_emissao", { ascending: false });
      if (error) throw error;
      return (data ?? []) as NfLinkada[];
    },
  });

  function limpar() { setFonte(null); setParcelas([]); setContatos([]); setBuscaContato(""); }

  // Selo "C" no kanban: contas da NF lançadas (pelo app, com o nome de quem lançou)
  // ou já existentes no Tiny (só marca se ainda não estava marcada).
  async function marcarContasOc(por: string, soSeVazio: boolean) {
    let q = supabaseExternal.from("compras_ordens")
      .update({ contas_lancadas_em: new Date().toISOString(), contas_lancadas_por: por }).eq("tiny_id", ordemTinyId);
    if (soSeVazio) q = q.is("contas_lancadas_em", null);
    await q;
    void qc.invalidateQueries({ queryKey: ["compras", "ordens"] });
    void qc.invalidateQueries({ queryKey: ["compras", "ordem", ordemTinyId] });
  }

  // contas que já existem para esta NF (lançadas pelo Tiny OU pelo app)
  async function marcarExistentes(f: Fonte, ps: Array<Omit<Parcela, "existe" | "incluir">>): Promise<Parcela[]> {
    const num = semZeros(f.numero);
    const { data } = await supabaseExternal.from("contas_pagar")
      .select("descricao, fornecedor_cnpj_cpf, data_vencimento, valor_total").ilike("descricao", `%NF nº ${num}%`).limit(200);
    const re = new RegExp(`NF n[ºo°.]?\\s*0*${num}(?!\\d)`, "i");
    const ja = ((data ?? []) as Array<{ descricao: string | null; fornecedor_cnpj_cpf: string | null; data_vencimento: string | null; valor_total: number }>)
      .filter((c) => re.test(c.descricao ?? "") && (!f.cnpj || !dig(c.fornecedor_cnpj_cpf) || dig(c.fornecedor_cnpj_cpf) === dig(f.cnpj)));
    const res = ps.map((p) => {
      const existe = ja.some((c) => c.data_vencimento === p.vencimento && Math.abs(Number(c.valor_total) - p.valor) < 0.02)
        || (ja.length >= ps.length && ps.length > 0); // NF inteira já lançada (datas podem ter sido ajustadas)
      return { ...p, existe, incluir: !existe };
    });
    if (res.length > 0 && res.every((p) => p.existe)) void marcarContasOc("já existiam no Tiny", true);
    return res;
  }

  async function usarNfTiny(nf: NfLinkada) {
    setCarregando(true);
    try {
      const r = await fnContas(`modulo=nf-parcelas&nf_tiny_id=${nf.tiny_id}`);
      if (r.erro) throw new Error(r.erro);
      const f: Fonte = {
        numero: String(r.numero ?? nf.numero ?? ""), emissao: r.data_emissao ?? nf.data_emissao, valor: Number(r.valor ?? nf.valor ?? 0),
        fornecedor: r.contato?.nome ?? nf.fornecedor_nome ?? "", cnpj: r.contato?.cpf_cnpj ?? nf.fornecedor_cnpj,
        contatoId: r.contato?.id ?? fornecedorId, origem: "tiny",
      };
      const ps = ((r.parcelas ?? []) as Array<{ numero: string; vencimento: string | null; valor: number }>)
        .filter((p) => p.vencimento).map((p) => ({ numero: p.numero, vencimento: String(p.vencimento).slice(0, 10), valor: Number(p.valor) }));
      setFonte(f);
      setParcelas(await marcarExistentes(f, ps));
      if (ps.length === 0) toast.warning("A NF no Tiny não tem parcelas cadastradas", { description: "Use o XML da NF-e ou lance pela tela de Contas a pagar." });
    } catch (e) {
      toast.error("Falha ao ler as parcelas da NF no Tiny", { description: (e as Error).message });
    } finally { setCarregando(false); }
  }

  async function usarXml(file: File | undefined) {
    if (!file) return;
    setCarregando(true);
    try {
      const nf = parseNfe(await file.text());
      const f: Fonte = {
        numero: nf.numero, emissao: nf.emissao, valor: nf.valor, fornecedor: nf.razaoSocial, cnpj: nf.cnpj,
        contatoId: fornecedorId, origem: "xml",
      };
      const ps = (nf.duplicatas ?? []).filter((d) => d.vencimento).map((d) => ({ numero: d.numero, vencimento: d.vencimento as string, valor: d.valor }));
      setFonte(f);
      setParcelas(await marcarExistentes(f, ps));
      if (ps.length === 0) toast.warning("O XML não traz duplicatas (cobr/dup)", { description: "Nota à vista ou sem boleto na NF — lance pela tela de Contas a pagar." });
    } catch (e) {
      toast.error("Não consegui ler o XML", { description: (e as Error).message });
    } finally { setCarregando(false); }
  }

  async function buscarContatos(q: string) {
    setBuscaContato(q);
    if (q.trim().length < 3) { setContatos([]); return; }
    const r = await fnContas(`modulo=contatos&q=${encodeURIComponent(q.trim())}`);
    setContatos((r.contatos ?? []) as Array<{ id: number; nome: string; cpf_cnpj: string | null }>);
  }

  const incluidas = parcelas.filter((p) => p.incluir);
  const soma = useMemo(() => parcelas.reduce((s, p) => s + p.valor, 0), [parcelas]);
  const difTotal = fonte ? Math.round((soma - fonte.valor) * 100) / 100 : 0;

  async function lancar() {
    if (!fonte?.contatoId || incluidas.length === 0) return;
    const num = semZeros(fonte.numero);
    const total = parcelas.length;
    if (!window.confirm(
      `Lançar ${incluidas.length} conta(s) a pagar no Tiny?\n\n` +
      incluidas.map((p) => `${dataBR(p.vencimento)} — ${formatBRL(p.valor)}`).join("\n") +
      `\n\nFornecedor: ${fonte.fornecedor}\nCada conta é um lançamento REAL no Tiny.`,
    )) return;
    setLancando(true);
    let ok = 0; const erros: string[] = [];
    for (const p of incluidas) {
      const i = parcelas.indexOf(p) + 1;
      const r = await fnContas("modulo=criar", {
        contato_id: fonte.contatoId, fornecedor_nome: fonte.fornecedor, valor: p.valor, data_vencimento: p.vencimento,
        data_emissao: fonte.emissao, numero_documento: `${num}/${i}`,
        historico: `Ref. a NF nº ${num}, ${fonte.fornecedor} (parcela ${i}/${total})`,
        criado_por: perfil?.nome ?? null,
      });
      if (r.ok) ok++;
      else {
        const det = Array.isArray(r.validacao) ? r.validacao.map((x: { campo: string; mensagem: string }) => `${x.campo}: ${x.mensagem}`).join(" · ") : r.erro ?? `HTTP ${r.http}`;
        erros.push(`${dataBR(p.vencimento)}: ${det}`);
      }
    }
    setLancando(false);
    if (ok > 0 && erros.length === 0) await marcarContasOc(perfil?.nome ?? "app", false);
    if (erros.length === 0) toast.success(`${ok} conta(s) lançada(s) no Tiny — NF ${num}`);
    else toast.warning(`${ok} lançada(s) · ${erros.length} erro(s)`, { description: erros.slice(0, 4).join("\n"), duration: 15000 });
    void qc.invalidateQueries({ queryKey: ["contas-pagar"] });
    if (fonte) setParcelas(await marcarExistentes(fonte, parcelas.map(({ numero, vencimento, valor }) => ({ numero, vencimento, valor }))));
  }

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAberto(true)} title="Lançar no Tiny as contas a pagar (boletos) da NF do fornecedor">
        <Receipt className="h-4 w-4" /> Contas da NF
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => { setAberto(v); if (!v) limpar(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Contas a pagar da NF</DialogTitle>
            <DialogDescription>
              Os boletos (vencimentos e valores) vêm da própria nota. O app lança cada parcela no Tiny com o mesmo
              histórico que o Tiny usa — e bloqueia o que já foi lançado, por aqui ou pelo Tiny.
            </DialogDescription>
          </DialogHeader>

          {!fonte && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">NFs do Tiny vinculadas a esta OC</span>
                {nfsQ.isLoading ? <span className="text-xs text-muted-foreground">Carregando…</span>
                  : (nfsQ.data ?? []).length === 0 ? <span className="text-xs text-muted-foreground">Nenhuma NF do Tiny vinculada — use o XML abaixo.</span>
                  : (nfsQ.data ?? []).map((nf) => (
                    <button key={nf.tiny_id} type="button" disabled={carregando} onClick={() => void usarNfTiny(nf)}
                      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/40 text-left">
                      <span><b>NF {semZeros(nf.numero)}</b> · {dataBR(nf.data_emissao)} · {nf.fornecedor_nome}</span>
                      <span className="font-mono tabular-nums">{formatBRL(Number(nf.valor ?? 0))}</span>
                    </button>
                  ))}
              </div>
              <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-sm text-muted-foreground cursor-pointer hover:bg-muted/40"
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void usarXml(e.dataTransfer.files?.[0]); }}>
                {carregando ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileUp className="h-5 w-5" />}
                <span>Ou arraste o <b>XML da NF-e</b> aqui (lê as duplicatas)</span>
                <input type="file" accept=".xml,text/xml,application/xml" className="hidden" onChange={(e) => { void usarXml(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            </div>
          )}

          {fonte && (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border p-2.5 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-semibold">NF {semZeros(fonte.numero)}</span>
                <span>{fonte.fornecedor}</span>
                <span className="text-xs text-muted-foreground">emissão {dataBR(fonte.emissao)} · {fonte.origem === "tiny" ? "parcelas do Tiny" : "duplicatas do XML"}</span>
                <span className="font-mono tabular-nums ml-auto">{formatBRL(fonte.valor)}</span>
              </div>

              {!fonte.contatoId && (
                <div className="rounded-md bg-amber-500/10 p-2.5 text-xs flex flex-col gap-1.5">
                  <span className="font-semibold text-amber-800 dark:text-amber-300">Fornecedor sem contato do Tiny nesta OC — escolha o contato:</span>
                  <Input className="h-8 text-xs" placeholder="buscar pelo nome no Tiny…" value={buscaContato} onChange={(e) => void buscarContatos(e.target.value)} />
                  {contatos.map((c) => (
                    <button key={c.id} type="button" className="text-left hover:underline" onClick={() => { setFonte({ ...fonte, contatoId: c.id, fornecedor: c.nome }); setContatos([]); }}>
                      {c.nome} {c.cpf_cnpj ? `· ${c.cpf_cnpj}` : ""}
                    </button>
                  ))}
                </div>
              )}

              {parcelas.length === 0 ? (
                <p className="text-sm text-muted-foreground">A nota não tem parcelas/duplicatas.</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 text-muted-foreground text-[10px] uppercase">
                      <tr>
                        <th className="w-8 px-2 py-1.5" />
                        <th className="text-left px-2 py-1.5 font-medium">Parcela</th>
                        <th className="text-left px-2 py-1.5 font-medium">Vencimento</th>
                        <th className="text-right px-2 py-1.5 font-medium">Valor</th>
                        <th className="text-left px-2 py-1.5 font-medium">Situação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {parcelas.map((p, i) => (
                        <tr key={i} className={cn(p.existe && "opacity-60")}>
                          <td className="px-2 py-1.5">
                            <Checkbox checked={p.incluir} disabled={p.existe}
                              onCheckedChange={(v) => setParcelas((ps) => ps.map((x, j) => (j === i ? { ...x, incluir: v === true } : x)))} />
                          </td>
                          <td className="px-2 py-1.5 font-mono">{i + 1}/{parcelas.length}</td>
                          <td className="px-2 py-1.5">
                            <Input type="date" className="h-7 w-[150px] text-xs" value={p.vencimento} disabled={p.existe}
                              onChange={(e) => setParcelas((ps) => ps.map((x, j) => (j === i ? { ...x, vencimento: e.target.value } : x)))} />
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Input className="h-7 w-[110px] ml-auto text-right font-mono text-xs" inputMode="decimal" disabled={p.existe}
                              value={String(p.valor)}
                              onChange={(e) => {
                                const v = Number(e.target.value.replace(",", "."));
                                setParcelas((ps) => ps.map((x, j) => (j === i ? { ...x, valor: Number.isFinite(v) ? v : 0 } : x)));
                              }} />
                          </td>
                          <td className="px-2 py-1.5">
                            {p.existe
                              ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-semibold"><CheckCircle2 className="h-3.5 w-3.5" /> já lançada no Tiny</span>
                              : <span className="text-muted-foreground">a lançar</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {parcelas.length > 0 && Math.abs(difTotal) >= 0.02 && (
                <div className="text-xs rounded-md bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Soma das parcelas ({formatBRL(soma)}) difere do valor da NF ({formatBRL(fonte.valor)}) em {formatBRL(difTotal)}.
                </div>
              )}
              {parcelas.length > 0 && parcelas.every((p) => p.existe) && (
                <div className="text-xs rounded-md bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 px-2.5 py-1.5 flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Todas as contas desta NF já estão no Tiny — nada a lançar.
                </div>
              )}

              <div className="flex justify-between gap-2">
                <Button variant="ghost" size="sm" onClick={limpar}>outra NF</Button>
                <Button size="sm" className="gap-1.5" disabled={!fonte.contatoId || incluidas.length === 0 || lancando} onClick={() => void lancar()}>
                  {lancando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Receipt className="h-3.5 w-3.5" />}
                  Lançar {incluidas.length} conta(s) no Tiny
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
