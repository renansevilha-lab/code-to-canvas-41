import { useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  EXTERNAL_PUBLISHABLE_KEY,
  EXTERNAL_URL,
  supabaseExternal,
} from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";

// ============================================================================
// Nova conta a pagar (item 2, 10/set/2026). A conta é criada NO TINY pela edge
// function `tiny-contas-pagar?modulo=criar` (POST /contas-pagar exige contato.id,
// valor > 0 e dataVencimento) e espelhada em contas_pagar na hora; o boleto/NF
// vai para o Storage (bucket contas-pagar-docs) e fica em contas_pagar_anexos.
// O espelho é do Tiny: nunca gravamos direto em contas_pagar.
// ============================================================================

interface Contato { id: number; nome: string; fantasia: string | null; cpf_cnpj: string | null; tipo: string | null }

type TipoDoc = "boleto" | "nf" | "outro";

function hoje(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export function NovaContaDialog({ onCriada }: { onCriada: () => void }) {
  const { perfil } = usePerfil();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [contatos, setContatos] = useState<Contato[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [contato, setContato] = useState<Contato | null>(null);
  const [valor, setValor] = useState("");
  const [vencimento, setVencimento] = useState(hoje());
  const [emissao, setEmissao] = useState(hoje());
  const [documento, setDocumento] = useState("");
  const [tipoDoc, setTipoDoc] = useState<TipoDoc>("boleto");
  const [historico, setHistorico] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [salvando, setSalvando] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // busca de contato no Tiny (debounce 350 ms)
  useEffect(() => {
    if (!aberto) return;
    const q = busca.trim();
    if (q.length < 2 || contato) { setContatos([]); return; }
    const t = setTimeout(async () => {
      setBuscando(true);
      try {
        const r = await fetch(
          `${EXTERNAL_URL}/functions/v1/tiny-contas-pagar?modulo=contatos&q=${encodeURIComponent(q)}`,
          { headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` } },
        );
        const d = (await r.json().catch(() => ({}))) as { contatos?: Contato[]; erro?: string };
        if (!r.ok || d.erro) throw new Error(d.erro ?? `HTTP ${r.status}`);
        setContatos(d.contatos ?? []);
      } catch (e) {
        toast.error("Falha ao buscar contatos no Tiny", { description: (e as Error).message });
      } finally {
        setBuscando(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [busca, aberto, contato]);

  function limpar() {
    setBusca(""); setContatos([]); setContato(null); setValor(""); setVencimento(hoje()); setEmissao(hoje());
    setDocumento(""); setTipoDoc("boleto"); setHistorico(""); setArquivo(null);
  }

  async function salvar() {
    const v = Number(valor.replace(/\./g, "").replace(",", "."));
    if (!contato) { toast.error("Escolha o fornecedor (contato do Tiny)"); return; }
    if (!Number.isFinite(v) || v <= 0) { toast.error("Informe um valor válido"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) { toast.error("Informe o vencimento"); return; }
    setSalvando(true);
    try {
      const r = await fetch(`${EXTERNAL_URL}/functions/v1/tiny-contas-pagar?modulo=criar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contato_id: contato.id,
          fornecedor_nome: contato.nome,
          valor: v,
          data_vencimento: vencimento,
          data_emissao: emissao || null,
          numero_documento: documento || null,
          historico: historico || (tipoDoc === "boleto" ? "Boleto" : tipoDoc === "nf" ? "NF" : null),
          criado_por: perfil?.nome ?? null,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean; tiny_id?: number | null; espelhado?: boolean; erro?: string;
        validacao?: Array<{ campo: string; mensagem: string }> | unknown;
      };
      if (!r.ok || !d.ok) {
        const det = Array.isArray(d.validacao)
          ? (d.validacao as Array<{ campo: string; mensagem: string }>).map((x) => `${x.campo}: ${x.mensagem}`).join(" · ")
          : d.erro ?? `HTTP ${r.status}`;
        throw new Error(det);
      }
      const tinyId = d.tiny_id ?? null;

      // anexo (boleto/NF) — opcional; falha no anexo NÃO desfaz a conta (já existe no Tiny)
      if (arquivo && tinyId) {
        try {
          const ext = arquivo.name.split(".").pop()?.toLowerCase() || "pdf";
          const path = `${tinyId}/${Date.now()}-${tipoDoc}.${ext}`;
          const { error: eUp } = await supabaseExternal.storage
            .from("contas-pagar-docs")
            .upload(path, arquivo, { contentType: arquivo.type || "application/pdf", upsert: false });
          if (eUp) throw eUp;
          const { error: eIns } = await supabaseExternal.from("contas_pagar_anexos").insert({
            tiny_id: tinyId, tipo: tipoDoc, nome: arquivo.name, storage_path: path,
            mime: arquivo.type || null, tamanho: arquivo.size, criado_por: perfil?.nome ?? null,
          });
          if (eIns) throw eIns;
        } catch (e) {
          toast.warning("Conta criada, mas o anexo não subiu", { description: (e as Error).message });
        }
      }

      toast.success(`Conta a pagar criada no Tiny${tinyId ? ` (id ${tinyId})` : ""}`, {
        description: `${contato.nome} · R$ ${v.toFixed(2).replace(".", ",")} · vence ${vencimento.split("-").reverse().join("/")}${d.espelhado ? "" : " · espelho atualiza no próximo sync"}`,
        duration: 8000,
      });
      setAberto(false);
      limpar();
      onCriada();
    } catch (e) {
      toast.error("Não foi possível criar a conta no Tiny", { description: (e as Error).message, duration: 10000 });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(o) => { setAberto(o); if (!o) limpar(); }}>
      <Button variant="default" size="sm" className="gap-1.5" onClick={() => setAberto(true)}>
        <Plus className="h-4 w-4" /> Nova conta a pagar
      </Button>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Nova conta a pagar</DialogTitle>
          <DialogDescription>
            Criada direto no Tiny (contas a pagar) e refletida aqui na hora. Anexe o boleto ou a NF.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {/* Fornecedor */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Fornecedor (contato do Tiny)</label>
            {contato ? (
              <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="truncate">
                  <span className="font-medium">{contato.nome}</span>
                  {contato.cpf_cnpj && <span className="text-muted-foreground"> · {contato.cpf_cnpj}</span>}
                  <span className="text-muted-foreground font-mono text-[11px]"> · id {contato.id}</span>
                </span>
                <button type="button" className="text-xs text-muted-foreground hover:underline shrink-0" onClick={() => { setContato(null); setBusca(""); }}>
                  trocar
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Digite o nome do fornecedor…" className="pl-8 h-9" autoFocus />
                {buscando && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                {contatos.length > 0 && (
                  <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border bg-popover shadow-md">
                    {contatos.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setContato(c); setContatos([]); }}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{c.nome}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">{c.cpf_cnpj ?? `id ${c.id}`}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Valor (R$)</label>
              <Input value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0,00" inputMode="decimal" className="h-9 font-mono" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Vencimento</label>
              <Input type="date" value={vencimento} onChange={(e) => setVencimento(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Emissão</label>
              <Input type="date" value={emissao} onChange={(e) => setEmissao(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Documento</label>
              <div className="flex gap-2">
                <Select value={tipoDoc} onValueChange={(v) => setTipoDoc(v as TipoDoc)}>
                  <SelectTrigger className="h-9 w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="boleto">Boleto</SelectItem>
                    <SelectItem value="nf">NF</SelectItem>
                    <SelectItem value="outro">Outro</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="nº do boleto / NF" className="h-9" />
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Histórico</label>
            <Input value={historico} onChange={(e) => setHistorico(e.target.value)} placeholder="ex.: NF 12345 areia — parcela 1/3" className="h-9" />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Anexo (boleto / NF em PDF, opcional)</label>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*,.xml"
              className="hidden"
              onChange={(e) => { setArquivo(e.target.files?.[0] ?? null); e.currentTarget.value = ""; }}
            />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => fileRef.current?.click()}>
                <Paperclip className="h-3.5 w-3.5" /> {arquivo ? "Trocar arquivo" : "Escolher arquivo"}
              </Button>
              {arquivo && (
                <span className={cn("text-xs text-muted-foreground truncate")}>
                  {arquivo.name} · {Math.round(arquivo.size / 1024)} KB
                </span>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setAberto(false)} disabled={salvando}>Cancelar</Button>
          <Button onClick={() => void salvar()} disabled={salvando || !contato}>
            {salvando ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Criar no Tiny
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
