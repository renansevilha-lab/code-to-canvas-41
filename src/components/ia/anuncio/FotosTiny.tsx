import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ImageUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { chamarVariacoes } from "@/lib/iaAnuncio";
import { EV_CRIADO, EV_VAI_CRIAR, type AnuncioCriado, type VaiCriar } from "@/lib/iaEnvioEventos";

// ============================================================================
// Fotos do anúncio → Tiny (13/out/2026, pedido do dono). As fotos aprovadas do anúncio entram no
// produto do Tiny — pelo menos as principais — e a 1ª passa a ser a foto do produto no sistema
// na hora (`produtos.foto_capa`). O Tiny guarda uma CÓPIA de cada foto (edge fn
// `tiny-produto-variacoes?modulo=fotos-anuncio`), então ela não depende do nosso armazenamento.
// Pode ir junto com a criação do anúncio (caixa marcada) ou pelo botão, a qualquer momento.
// As fotos entram DEPOIS das que o produto já tem no Tiny: a principal de lá só muda se ele
// estava sem foto. A API do Tiny não apaga foto — por isso há confirmação.
// ============================================================================

const QUANTAS = [1, 3, 5, 9];
interface Item {
  sku: string; ok?: boolean; erro?: string; fotos_no_tiny?: number | null; validas?: number;
  enviadas?: { path: string; ok: boolean; erro: string | null }[]; faltou?: string[]; foto_capa?: string;
}

export function FotosTiny({ sku, canal, empresa, paths, urls }: { sku: string; canal: string; empresa: string; paths: string[]; urls: Record<string, string> }) {
  const qc = useQueryClient();
  const [quantas, setQuantas] = useState(5);
  const [junto, setJunto] = useState<boolean | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<{ ok: number; falhas: string[] } | null>(null);

  const tinyQ = useQuery({
    queryKey: ["ia-anuncio", "tiny-fotos", sku],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Item | null> => (((await chamarVariacoes("fotos-anuncio", { itens: [{ sku, paths: [] }] })) as { itens?: Item[] }).itens ?? [])[0] ?? null,
  });
  const noTiny = tinyQ.data?.fotos_no_tiny ?? null;
  // padrão: vai junto com o anúncio quando o produto ainda não tem foto no Tiny
  useEffect(() => { if (junto === null && noTiny != null) setJunto(noTiny === 0); }, [noTiny, junto]);
  const escolhidas = paths.slice(0, quantas);

  async function enviar(lista: string[]) {
    if (!lista.length) return;
    setOcupado(true); setResultado(null);
    const feitas: { path: string; ok: boolean; erro: string | null }[] = []; let erro: string | null = null;
    try {
      // o servidor para aos ~24 s e devolve o que ficou por mandar: seguimos de onde parou (não repete o que já foi)
      let fila = lista;
      for (let volta = 0; volta < 5 && fila.length; volta++) {
        const r = (await chamarVariacoes("fotos-anuncio", { itens: [{ sku, paths: fila }], confirmar: true })) as { itens?: Item[] };
        const it = (r.itens ?? [])[0];
        if (!it || it.erro) { erro = it?.erro ?? "o servidor não respondeu sobre este produto"; break; }
        feitas.push(...(it.enviadas ?? []));
        fila = it.faltou ?? [];
        if (!(it.enviadas ?? []).length) break;
      }
      const ok = feitas.filter((f) => f.ok).length;
      const falhas = [...(erro ? [erro] : []), ...feitas.filter((f) => !f.ok).map((f) => f.erro ?? "o Tiny recusou uma foto")];
      setResultado({ ok, falhas: [...new Set(falhas)] });
      if (ok && !falhas.length) toast.success(`${ok} foto(s) no Tiny`, { description: "A principal já é a foto do produto no sistema." });
      else toast.warning(`Tiny: ${ok} foto(s) enviada(s), ${falhas.length} problema(s)`, { duration: 20000 });
    } catch (e) {
      setResultado({ ok: feitas.filter((f) => f.ok).length, falhas: [(e as Error).message] });
      toast.error("Não consegui mandar as fotos ao Tiny", { description: (e as Error).message, duration: 20000 });
    } finally {
      setOcupado(false);
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    }
  }

  // o envio do anúncio pergunta antes de confirmar e avisa quando criou
  const agora = useRef({ junto, escolhidas, enviar });
  agora.current = { junto, escolhidas, enviar };
  useEffect(() => {
    const eDaqui = (d: { canal?: string; empresa?: string; sku?: string }) => d.canal === canal && d.empresa === empresa && d.sku === sku;
    const vaiCriar = (ev: Event) => {
      const d = (ev as CustomEvent).detail as VaiCriar; const a = agora.current;
      if (eDaqui(d) && a.junto && a.escolhidas.length) d.tiny = `${a.escolhidas.length} foto(s)`;
    };
    const criado = (ev: Event) => {
      const d = (ev as CustomEvent).detail as AnuncioCriado; const a = agora.current;
      if (eDaqui(d) && a.junto && a.escolhidas.length) void a.enviar(a.escolhidas);
    };
    window.addEventListener(EV_VAI_CRIAR, vaiCriar); window.addEventListener(EV_CRIADO, criado);
    return () => { window.removeEventListener(EV_VAI_CRIAR, vaiCriar); window.removeEventListener(EV_CRIADO, criado); };
  }, [sku, canal, empresa]);

  if (!paths.length) return null;
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ImageUp className="h-4 w-4" /><b>Fotos no Tiny</b>
        <span className="text-xs text-muted-foreground">
          — {tinyQ.isLoading ? "verificando o produto no Tiny…" : tinyQ.isError || tinyQ.data?.erro ? `não consegui verificar (${tinyQ.data?.erro ?? (tinyQ.error as Error)?.message})`
            : noTiny === 0 ? "o produto está SEM foto no Tiny: a 1ª daqui vira a principal (e a foto do produto no sistema)"
            : `o produto já tem ${noTiny} foto(s) no Tiny: as daqui entram depois delas`}
        </span>
        {(tinyQ.isFetching || ocupado) && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground mr-1">Mandar as primeiras:</span>
        {QUANTAS.filter((n, i) => i === 0 || QUANTAS[i - 1] < paths.length).map((n) => (
          <Button key={n} size="sm" variant={quantas === n || (n >= paths.length && quantas >= paths.length) ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setQuantas(n)}>
            {n >= paths.length ? `todas (${paths.length})` : n}
          </Button>
        ))}
        <div className="flex gap-1 ml-2">
          {escolhidas.map((p, i) => (
            <div key={p} className={`h-9 w-9 rounded border overflow-hidden bg-muted/30 ${i === 0 ? "border-primary" : ""}`} title={i === 0 ? "principal" : `${i + 1}ª`}>
              {urls[p] && <img src={urls[p]} alt="" className="h-full w-full object-cover" />}
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={junto === true} onChange={(e) => setJunto(e.target.checked)} />
          Mandar junto, assim que o anúncio for criado
        </label>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={ocupado}
          onClick={() => { if (window.confirm(`Mandar ${escolhidas.length} foto(s) deste anúncio para o produto ${sku} no Tiny?\n\n${noTiny ? `Ele já tem ${noTiny} foto(s) lá: estas entram depois.` : "A 1ª vira a foto principal do produto."}\nA API do Tiny não apaga foto: para tirar depois, só na tela do Tiny.`)) void enviar(escolhidas); }}>
          Mandar agora ao Tiny
        </Button>
      </div>
      {resultado && (
        <div className={`rounded-md border p-2 text-xs ${resultado.falhas.length ? "border-amber-500/40 bg-amber-500/5" : "border-emerald-500/40 bg-emerald-500/5"}`}>
          <div className="flex items-center gap-1.5 font-medium">
            {resultado.falhas.length ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
            Tiny: {resultado.ok} foto(s) enviada(s){resultado.falhas.length ? ` · ${resultado.falhas.length} problema(s)` : ""}
          </div>
          {resultado.falhas.map((x) => <div key={x}>• {x}</div>)}
        </div>
      )}
    </div>
  );
}
