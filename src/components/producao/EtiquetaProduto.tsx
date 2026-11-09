// Etiqueta do PRODUTO (a arte que vai no saco), impressa pela Produção quando precisar (09/nov/2026, pedido do dono).
// A arte é um ZPL pronto por SKU, guardado no repositório em ./etiquetas/<sku>.zpl (o dono manda o arquivo; produto novo =
// arquivo novo na pasta). Mesmo caminho das outras etiquetas: ZPL cru → fulfillment-inbound?modulo=imprimir → fila
// própria da Zebra. A impressora é a mesma da Separação (localStorage separacao.printerId). Quantidade vai por ^PQ (a
// imagem tem ~75 kB: repetir o ZPL N vezes mandaria N cópias dela).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { listarImpressoras } from "@/lib/impressoras";
import { Botao, Campo, Entrada, Escolha } from "./ui";

const STORAGE_PRINTER = "separacao.printerId";
const MAX_QTD = 500;

const ARQUIVOS = import.meta.glob("./etiquetas/*.zpl", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
const POR_SKU: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.entries(ARQUIVOS).map(([caminho, ler]) => [caminho.replace(/^.*\/(.+)\.zpl$/, "$1"), ler]),
);

/** O produto tem etiqueta cadastrada? */
export const temEtiquetaProduto = (sku: string) => !!POR_SKU[sku];

/** Quantidade de cópias pelo ^PQ (troca o que existe ou acrescenta antes do ^XZ). */
function comQuantidade(zpl: string, n: number): string {
  if (/\^PQ\d+/.test(zpl)) return zpl.replace(/\^PQ\d+[^\^]*/, `^PQ${n}`);
  return zpl.replace(/\^XZ\s*$/, `^PQ${n}\n^XZ`);
}

/** EAN-13 do código de barras da arte (^BE…^FD<12 ou 13 dígitos>). */
function eanDaArte(zpl: string): string | null {
  const m = zpl.match(/\^BE[^\^]*(?:\^[A-Z][A-Z0-9][^\^]*)*?\^FD(\d{12,13})\^FS/);
  if (!m) return null;
  const d = m[1].slice(0, 12);
  const soma = d.split("").reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return d + ((10 - (soma % 10)) % 10);
}

/** Desenha a imagem ^GFA da arte num canvas (prévia para conferir se é a etiqueta certa). */
function desenharGfa(zpl: string, canvas: HTMLCanvasElement) {
  const m = zpl.match(/\^GFA,\d+,\d+,(\d+),([\s\S]*?)\^FS/);
  if (!m) return false;
  const bpl = Number(m[1]);
  const dados = m[2].replace(/\s/g, "");
  const linhas: string[] = [];
  let ant = "", linha = "", n = 0;
  const conta = (c: string) => (c >= "G" && c <= "Y" ? c.charCodeAt(0) - 70 : c >= "g" && c <= "z" ? (c.charCodeAt(0) - 102) * 20 : 0);
  const fecha = (l: string) => { linhas.push(l); ant = l; linha = ""; };
  for (const c of dados) {
    if (c === ",") { fecha(linha.padEnd(bpl * 2, "0")); continue; }
    if (c === "!") { fecha(linha.padEnd(bpl * 2, "F")); continue; }
    if (c === ":") { linhas.push(ant); continue; }
    const k = conta(c);
    if (k) { n += k; continue; }
    linha += c.repeat(n || 1); n = 0;
    if (linha.length >= bpl * 2) fecha(linha.slice(0, bpl * 2));
  }
  const w = bpl * 8, h = linhas.length;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx || !h) return false;
  const img = ctx.createImageData(w, h);
  linhas.forEach((l, y) => {
    for (let b = 0; b < bpl; b++) {
      const v = parseInt(l.substr(b * 2, 2), 16) || 0;
      for (let k = 0; k < 8; k++) {
        const o = (y * w + b * 8 + k) * 4;
        const cor = v & (0x80 >> k) ? 0 : 255;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = cor; img.data[o + 3] = 255;
      }
    }
  });
  ctx.putImageData(img, 0, 0);
  return true;
}

export function EtiquetaProduto({ sku, nome, onFechar }: { sku: string | null; nome?: string | null; onFechar: () => void }) {
  const cadastro = useQuery({
    queryKey: ["producao", "etiqueta-produto-gtin", sku],
    enabled: !!sku,
    placeholderData: undefined,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("produtos").select("gtin").eq("sku", sku!).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { gtin: string | null } | null)?.gtin ?? null;
    },
  });
  const gtin = cadastro.data;
  const arte = useQuery({
    queryKey: ["producao", "etiqueta-produto", sku],
    enabled: !!sku && !!POR_SKU[sku],
    staleTime: Infinity,
    queryFn: () => POR_SKU[sku!](),
  });
  const impressoras = useQuery({ queryKey: ["producao", "impressoras"], refetchInterval: 60_000, queryFn: listarImpressoras });
  const [printerId, setPrinterId] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(STORAGE_PRINTER)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
  });
  useEffect(() => { try { if (printerId > 0) localStorage.setItem(STORAGE_PRINTER, String(printerId)); } catch { /* noop */ } }, [printerId]);
  const [qtd, setQtd] = useState("1");
  const [imprimindo, setImprimindo] = useState(false);
  useEffect(() => { setQtd("1"); }, [sku]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const [semPrevia, setSemPrevia] = useState(false);
  useEffect(() => {
    if (arte.data && canvas.current) setSemPrevia(!desenharGfa(arte.data, canvas.current));
  }, [arte.data]);

  const ean = useMemo(() => (arte.data ? eanDaArte(arte.data) : null), [arte.data]);
  const gtinTiny = (gtin ?? "").replace(/\D/g, "") || null;
  const eanDiverge = !!ean && !!gtinTiny && ean !== gtinTiny;

  async function imprimir() {
    const n = Number(qtd);
    if (!Number.isInteger(n) || n < 1) return toast.error("Quantas etiquetas? (número inteiro)");
    if (n > MAX_QTD) return toast.error(`No máximo ${MAX_QTD} por vez.`);
    if (!printerId) return toast.warning("Escolha a impressora primeiro.");
    if (!arte.data) return;
    if (!window.confirm(`Imprimir ${n} etiqueta(s) do ${sku}?${eanDiverge ? `\n\nAtenção: o código de barras da etiqueta (${ean}) é diferente do EAN do produto no Tiny (${gtinTiny}).` : ""}`)) return;
    setImprimindo(true);
    try {
      const { data: res, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
        body: { modulo: "imprimir", zpl: comQuantidade(arte.data, n), printer_id: printerId, title: `Etiqueta ${sku} ×${n}` },
      });
      if (error) throw new Error(error.message);
      if (!(res as { ok?: boolean })?.ok) throw new Error(JSON.stringify((res as { resposta?: unknown })?.resposta ?? res));
      toast.success(`${n} etiqueta(s) do ${sku} enviada(s) à impressora.`);
      onFechar();
    } catch (e) {
      toast.error("Falha ao imprimir a etiqueta", { description: e instanceof Error ? e.message : String(e) });
    } finally { setImprimindo(false); }
  }

  return (
    <Dialog open={!!sku} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-lg" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Etiqueta do produto</DialogTitle></DialogHeader>
        {sku && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 700 }}>{sku}</div>
              {nome && <div style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>{nome}</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "center", padding: 10, borderRadius: 10, background: "var(--pm-s2)" }}>
              {arte.isLoading && <span style={{ fontSize: 13, color: "var(--pm-t3)" }}>Carregando a etiqueta…</span>}
              {arte.error && <span style={{ fontSize: 13, color: "var(--pm-r)" }}>Não deu para ler a etiqueta.</span>}
              <canvas ref={canvas} style={{ display: arte.data && !semPrevia ? "block" : "none", width: 200, height: "auto", background: "#fff", border: "1px solid var(--pm-bs)", borderRadius: 4 }} />
              {semPrevia && <span style={{ fontSize: 13, color: "var(--pm-t3)" }}>Sem prévia (a etiqueta não tem imagem).</span>}
            </div>
            <div style={{ fontSize: 12.5, color: eanDiverge ? "var(--pm-r)" : "var(--pm-t2)" }}>
              Código de barras na etiqueta: <b>{ean ?? "—"}</b>
              {gtinTiny && <> · EAN no Tiny: <b>{gtinTiny}</b></>}
              {eanDiverge && <div style={{ fontWeight: 600, marginTop: 2 }}>Os dois não batem: o leitor vai reconhecer o saco como outro produto.</div>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 10 }}>
              <Campo rotulo="Impressora">
                <Escolha value={printerId || ""} onChange={(e) => setPrinterId(Number(e.target.value))}>
                  <option value="">{impressoras.isLoading ? "Carregando…" : "Escolha a impressora"}</option>
                  {(impressoras.data ?? []).map((p) => (
                    <option key={p.printer_id} value={p.printer_id}>{p.nome}{p.estado !== "online" ? " (offline)" : ""}</option>
                  ))}
                </Escolha>
              </Campo>
              <Campo rotulo="Quantas">
                <Entrada inputMode="numeric" value={qtd} onChange={(e) => setQtd(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  onKeyDown={(e) => { if (e.key === "Enter") void imprimir(); }} style={{ textAlign: "center", fontWeight: 700 }} />
              </Campo>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Botao tom="fantasma" onClick={onFechar} disabled={imprimindo}>Cancelar</Botao>
              <Botao tom="primario" onClick={imprimir} disabled={imprimindo || !arte.data}>{imprimindo ? "Enviando…" : "Imprimir"}</Botao>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
