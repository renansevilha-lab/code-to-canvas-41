// Etiqueta de controle interno do big bag (Zebra ZD220, bobina 10x15, 203 dpi = 812x1218 dots).
// Mesmo caminho da identificadora da Separação: ZPL cru → fulfillment-inbound?modulo=imprimir → PrintNode
// ou fila própria. A impressora escolhida é a mesma da Separação (localStorage separacao.printerId).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";
import { aplicarApelidos } from "@/lib/impressoras";
import { zplSan } from "@/lib/identificador";
import { dataBR, type BigBag } from "@/lib/producao";
import { Escolha } from "./ui";

const STORAGE_PRINTER = "separacao.printerId";
const STORAGE_COPIAS = "producao.etiquetaBag.copias";

interface Impressora { printer_id: number; nome: string; computador: string; estado: string }

function useImpressoras() {
  return useQuery({
    queryKey: ["producao", "impressoras"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<Impressora[]> => {
      const resp = await fetch(`${EXTERNAL_URL}/functions/v1/shopee-sync-ads?modulo=impressoras`, {
        headers: { Authorization: `Bearer ${EXTERNAL_PUBLISHABLE_KEY}` },
      });
      const data = (await resp.json().catch(() => ({}))) as { impressoras?: Impressora[] };
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return aplicarApelidos((data.impressoras ?? []).filter((p) => (p.nome ?? "").toLowerCase().includes("zd220")));
    },
  });
}

/** "Farinha de mandioca Lotus — grãos médios" → "GRÃOS MÉDIOS". */
function tipoFarinha(nome: string | null): string | null {
  if (!nome) return null;
  const depois = nome.split(/\s+[—–-]\s+/).pop() ?? nome;
  return depois.toUpperCase();
}

const kgTexto = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} kg`;

export function gerarZplBigBag(b: BigBag): string {
  const codigo = zplSan(b.codigo);
  const tipo = zplSan(tipoFarinha(b.insumo) ?? "");
  // Code128: ~11 módulos por caractere + início, verificador e fim. Centraliza na largura da etiqueta.
  // Barra mais fina (2) quando o código não cabe com 3; o texto grande encolhe com o tamanho do código.
  const modulo = (11 * (codigo.length + 2) + 13) * 3 <= 772 ? 3 : 2;
  const largura = (11 * (codigo.length + 2) + 13) * modulo;
  const xBarra = Math.max(20, Math.round((812 - largura) / 2));
  const fonte = Math.max(40, Math.min(92, Math.floor(760 / (codigo.length * 0.62))));
  return [
    "^XA", "^CI28", "^PW812", "^LL1218", "^LH0,0",
    // faixa do topo
    "^FO30,30^GB752,80,80^FS",
    "^FO30,50^A0N,46,46^FB752,1,0,C,0^FR^FDBIG BAG - MATERIA-PRIMA^FS",
    // código grande + código de barras
    `^FO0,${232 - fonte}^A0N,${fonte},${Math.round(fonte * 0.87)}^FB812,1,0,C,0^FD${codigo}^FS`,
    `^FO${xBarra},250^BY${modulo},2,130^BCN,130,N,N,N^FD${codigo}^FS`,
    // tipo de farinha (vazio = escrever à mão)
    "^FO30,420^GB752,190,3^FS",
    "^FO30,436^A0N,30,30^FB752,1,0,C,0^FDFARINHA^FS",
    tipo
      ? `^FO40,480^A0N,84,74^FB732,1,0,C,0^FD${tipo}^FS`
      : "^FO120,560^GB572,3,3^FS",
    ...(b.sku ? [`^FO30,566^A0N,32,32^FB752,1,0,C,0^FDPARA O SKU ${zplSan(b.sku)}^FS`] : []),
    // peso | NF
    "^FO30,630^GB368,150,3^FS",
    "^FO30,646^A0N,30,30^FB368,1,0,C,0^FDPESO^FS",
    `^FO30,690^A0N,70,60^FB368,1,0,C,0^FD${zplSan(kgTexto(b.qtd_inicial_kg))}^FS`,
    "^FO414,630^GB368,150,3^FS",
    "^FO414,646^A0N,30,30^FB368,1,0,C,0^FDNOTA FISCAL^FS",
    `^FO414,690^A0N,70,60^FB368,1,0,C,0^FD${zplSan(b.nf_numero ?? "-")}^FS`,
    // fornecedor e recebimento
    `^FO40,805^A0N,36,34^FB732,1,0,L,0^FDFornecedor: ${zplSan(b.fornecedor_nome ?? "-").slice(0, 36)}^FS`,
    `^FO40,855^A0N,36,34^FB732,1,0,L,0^FDRecebido em: ${zplSan(dataBR(b.recebido_em))}^FS`,
    // campos para preencher à mão
    "^FO30,910^GB752,240,3^FS",
    "^FO50,935^A0N,34,32^FDABERTO EM:^FS", "^FO290,965^GB470,2,2^FS",
    "^FO50,1010^A0N,34,32^FDFINALIZADO EM:^FS", "^FO350,1040^GB410,2,2^FS",
    "^FO50,1085^A0N,34,32^FDLOTE:^FS", "^FO170,1115^GB590,2,2^FS",
    "^FO0,1168^A0N,28,28^FB812,1,0,C,0^FDCONTROLE INTERNO - NAO RETIRAR^FS",
    "^XZ",
  ].join("");
}

/** Seletor de impressora + cópias e o envio das etiquetas. */
export function useImpressaoBigBag() {
  const { data: impressoras, isLoading } = useImpressoras();
  const [printerId, setPrinterId] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(STORAGE_PRINTER)); return Number.isFinite(v) && v > 0 ? v : 0; } catch { return 0; }
  });
  const [copias, setCopias] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(STORAGE_COPIAS)); return v === 2 ? 2 : 1; } catch { return 1; }
  });
  useEffect(() => { try { if (printerId > 0) localStorage.setItem(STORAGE_PRINTER, String(printerId)); } catch { /* noop */ } }, [printerId]);
  useEffect(() => { try { localStorage.setItem(STORAGE_COPIAS, String(copias)); } catch { /* noop */ } }, [copias]);
  const [imprimindo, setImprimindo] = useState(false);

  async function imprimir(bags: BigBag[]) {
    if (!bags.length) return;
    if (!printerId) return toast.warning("Escolha a impressora primeiro.");
    const semTipo = bags.filter((b) => !b.insumo_id).length;
    if (semTipo && !window.confirm(`${semTipo} big bag(s) ainda sem a farinha definida: a etiqueta sai com o tipo em branco para escrever à mão. Imprimir assim mesmo?`)) return;
    setImprimindo(true);
    try {
      const zpl = bags.flatMap((b) => Array.from({ length: copias }, () => gerarZplBigBag(b))).join("");
      const titulo = bags.length === 1 ? `Big bag ${bags[0].codigo}` : `Big bags (${bags.length})`;
      const { data: res, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
        body: { modulo: "imprimir", zpl, printer_id: printerId, title: titulo },
      });
      if (error) throw new Error(error.message);
      if (!(res as { ok?: boolean })?.ok) throw new Error(JSON.stringify((res as { resposta?: unknown })?.resposta ?? res));
      toast.success(`${bags.length * copias} etiqueta(s) enviada(s) à impressora.`);
    } catch (e) {
      toast.error("Falha ao imprimir a etiqueta", { description: e instanceof Error ? e.message : String(e) });
    } finally { setImprimindo(false); }
  }

  const seletor = (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <Escolha value={printerId || ""} onChange={(e) => setPrinterId(Number(e.target.value))} style={{ height: 32, minWidth: 200 }}>
        <option value="">{isLoading ? "Carregando impressoras…" : "Escolha a impressora"}</option>
        {(impressoras ?? []).map((p) => (
          <option key={p.printer_id} value={p.printer_id}>{p.nome}{p.estado !== "online" ? " (offline)" : ""}</option>
        ))}
      </Escolha>
      <Escolha value={copias} onChange={(e) => setCopias(Number(e.target.value))} style={{ height: 32, width: 110 }}>
        <option value={1}>1 por bag</option>
        <option value={2}>2 por bag</option>
      </Escolha>
    </span>
  );
  return { seletor, imprimir, imprimindo, pronto: printerId > 0 };
}
