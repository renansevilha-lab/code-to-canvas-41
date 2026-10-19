import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ImageOff, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatBRL } from "@/lib/format";
import { importarDoTiny, type ItemImportado } from "@/lib/iaAnuncio";

// ============================================================================
// "Importar do Tiny" (19/out/2026, pedido do dono): produto cadastrado no Tiny durante o
// dia só chegava ao sistema na sincronização da madrugada. Aqui a pessoa digita o(s)
// SKU(s) e a edge fn `tiny-produto-importar` lê o produto no Tiny e grava no cadastro do
// sistema na hora (o mesmo que a sincronização grava). Produto que já existe = atualiza.
// ============================================================================

/** Importa (ou atualiza) os códigos, continuando enquanto a função devolver `faltam`. */
export async function importarTudo(skus: string[], aoAndar?: (feitos: ItemImportado[], faltam: number) => void): Promise<ItemImportado[]> {
  let fila = skus;
  const feitos: ItemImportado[] = [];
  for (let volta = 0; volta < 6 && fila.length; volta++) {
    const r = await importarDoTiny(fila);
    feitos.push(...r.itens);
    fila = r.faltam ?? [];
    aoAndar?.(feitos, fila.length);
  }
  return feitos;
}

const lerCodigos = (s: string) => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];

export function ImportarDoTiny({ inicial, onFechar, onVer }: { inicial?: string; onFechar: () => void; onVer: (sku: string) => void }) {
  const qc = useQueryClient();
  const [txt, setTxt] = useState(inicial && /^[A-Za-z0-9._-]{1,40}$/.test(inicial.trim()) ? inicial.trim() : "");
  const [rodando, setRodando] = useState(false);
  const [progresso, setProgresso] = useState("");
  const [itens, setItens] = useState<ItemImportado[] | null>(null);
  const codigos = lerCodigos(txt);

  async function importar() {
    if (!codigos.length) return;
    setRodando(true); setItens(null); setProgresso("Lendo no Tiny…");
    try {
      const feitos = await importarTudo(codigos, (f, faltam) => { setItens([...f]); setProgresso(faltam ? `Lendo no Tiny… faltam ${faltam}` : ""); });
      setItens(feitos);
      const ok = feitos.filter((i) => i.ok).length;
      (ok === feitos.length ? toast.success : toast.warning)(`${ok} de ${feitos.length} produto(s) no sistema`, { duration: 6000 });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) {
      toast.error("Não consegui importar", { description: (e as Error).message, duration: 12000 });
    } finally { setRodando(false); setProgresso(""); }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !rodando) onFechar(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar ou atualizar produto do Tiny</DialogTitle>
          <DialogDescription>
            Digite o SKU (código no Tiny) de cada produto — vários separados por vírgula ou espaço. O sistema lê o produto no Tiny e grava na hora:
            nome, custo, preço, foto, marca, categoria, estoque e a composição do kit. Se já existir aqui, atualiza. Produto com variações traz as variações junto.
            Nada é alterado no Tiny.
          </DialogDescription>
        </DialogHeader>

        <Textarea rows={2} className="font-mono text-sm" value={txt} onChange={(e) => setTxt(e.target.value)} placeholder="16530, 16531" disabled={rodando}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void importar(); } }} />
        {progresso && <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />{progresso}</div>}

        {itens && itens.length > 0 && (
          <div className="divide-y rounded-md border">
            {itens.map((i) => (
              <div key={i.sku} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                {i.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> : <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />}
                <div className="h-9 w-9 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                  {i.foto ? <img src={i.foto} alt="" className="h-full w-full object-cover" /> : <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate"><span className="font-mono text-xs text-muted-foreground mr-1.5">{i.sku}</span>{i.nome ?? ""}</div>
                  {i.ok ? (
                    <div className="text-[11px] text-muted-foreground">
                      {i.novo ? <b className="text-emerald-700 dark:text-emerald-400">novo no sistema</b> : <b>atualizado</b>}
                      {i.origem !== "pedido" && <> · {i.origem}</>}
                      {" · "}{i.tipo === "K" ? "kit" : i.tipo === "V" ? "com variações" : "simples"}
                      {i.situacao && i.situacao !== "A" && <span className="text-amber-600"> · {i.situacao === "I" ? "inativo" : "excluído"} no Tiny (fica fora da lista)</span>}
                      {" · "}custo {i.custo ? formatBRL(Number(i.custo)) : <span className="text-destructive">sem custo no Tiny</span>}
                      {i.preco != null && <> · preço {formatBRL(Number(i.preco))}</>}
                      {i.estoque != null && <> · estoque {i.estoque}</>}
                      {i.componentes ? <> · kit de {i.componentes} item(ns)</> : null}
                      {i.variacoes ? <> · {i.variacoes} variações</> : null}
                      {!i.foto && <> · sem foto no Tiny</>}
                    </div>
                  ) : <div className="text-[11px] text-destructive">{i.erro}</div>}
                </div>
                {i.ok && i.situacao === "A" && i.origem === "pedido" && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { onVer(i.sku); onFechar(); }}>Ver na lista</Button>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={rodando} onClick={onFechar}>Fechar</Button>
          <Button disabled={rodando || !codigos.length} onClick={() => void importar()} className="gap-1.5">
            {rodando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {codigos.length > 1 ? `Importar ${codigos.length} produtos` : "Importar do Tiny"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
