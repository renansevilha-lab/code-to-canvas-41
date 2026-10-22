// Encaixotamento do envio da Amazon (22/out/2026, pedido do dono): por produto, a foto e como montar os volumes dele
// (quantos volumes, unidades por volume, medidas e peso) e o preparo que a Amazon exige — sem a lista caixa a caixa.
// Os dados vêm de amazon_envio_plano.envios_amazon[].encaixotamento, gravado pela amazon-inbound (v11) ao criar o envio
// ou na rodada de 10 min. v12: a folha de encaixotamento em PDF vai junto nos documentos do envio, e envio criado no
// Seller Central (sem plano do app) ganha o botão "Buscar na Amazon" (vincular).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Loader2, Package, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import { supabaseExternal, EXTERNAL_URL, EXTERNAL_PUBLISHABLE_KEY } from "@/integrations/supabase/external-client";

interface CaixaEnc { id: string | null; nome: string | null; qtd: number; kg: number | null; c: number | null; l: number | null; a: number | null; unidade: string; itens: { msku: string; q: number }[] }
interface ItemEnc { msku: string; asin: string | null; fnsku: string | null; q: number; etiqueta: string | null; validade: string | null; preparo: { tipo: string; quem: string | null }[] }
interface Encaixotamento { lido_em: string; caixas: CaixaEnc[]; itens: ItemEnc[] }

const PREPARO: Record<string, string> = {
  ITEM_LABELING: "etiqueta FNSKU", ITEM_POLYBAGGING: "saco plástico", ITEM_BUBBLEWRAP: "plástico bolha", ITEM_TAPING: "fita",
  ITEM_BLACK_SHRINKWRAP: "filme preto", ITEM_BOXING: "caixa", ITEM_SETCREAT: "montar conjunto", ITEM_SETSTK: "etiqueta de conjunto",
  ITEM_CAP_SEALING: "lacre da tampa", ITEM_SUFFOSTK: "aviso de sufocamento", ITEM_HANG_GARMENT: "cabide", ITEM_DEBUNDLE: "desfazer conjunto",
  ITEM_NO_PREP: "sem preparo", ITEM_RMOVHANG: "tirar cabide", ITEM_SIOC: "embalagem própria",
};
const nomePreparo = (t: string) => PREPARO[t] ?? t.replace(/^ITEM_/, "").toLowerCase().replace(/_/g, " ");
const dataBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Por produto: os formatos de volume (unidades por volume × medidas × peso) e quantos de cada; caixas com mais de um
 *  produto ficam à parte. */
function montarVolumes(caixas: CaixaEnc[]) {
  const porMsku = new Map<string, Map<string, { volumes: number; un: number; c: number | null; l: number | null; a: number | null; kg: number | null; nomes: Set<string> }>>();
  const mistas = new Map<string, { volumes: number; cx: CaixaEnc }>();
  for (const cx of caixas) {
    const n = Math.max(1, cx.qtd || 1);
    if (cx.itens.length !== 1) {
      const k = [cx.itens.map((i) => `${i.msku}×${i.q}`).sort().join("+"), cx.c, cx.l, cx.a, cx.kg].join("|");
      const g = mistas.get(k) ?? { volumes: 0, cx };
      g.volumes += n;
      mistas.set(k, g);
      continue;
    }
    const it = cx.itens[0];
    const formatos = porMsku.get(it.msku) ?? new Map();
    const k = [it.q, cx.c, cx.l, cx.a, cx.kg].join("|");
    const f = formatos.get(k) ?? { volumes: 0, un: it.q, c: cx.c, l: cx.l, a: cx.a, kg: cx.kg, nomes: new Set<string>() };
    f.volumes += n;
    // o nome do modelo da caixa vem repetido em cada caixa (e com espaço no fim): guarda uma vez só
    if (cx.nome?.trim()) f.nomes.add(cx.nome.trim());
    formatos.set(k, f);
    porMsku.set(it.msku, formatos);
  }
  return { porMsku, mistas: [...mistas.values()] };
}

async function chamarInbound(corpo: Record<string, unknown>) {
  const { data } = await supabaseExternal.auth.getSession();
  const r = await fetch(`${EXTERNAL_URL}/functions/v1/amazon-inbound`, {
    method: "POST",
    headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}`, apikey: EXTERNAL_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok) throw new Error(j.erro ?? `HTTP ${r.status}`);
  return j;
}

function Foto({ url }: { url: string | null | undefined }) {
  const [ok, setOk] = useState(true);
  return (
    <div className="flex h-16 w-16 flex-none items-center justify-center overflow-hidden rounded-md border bg-white">
      {url && ok ? <img src={url} alt="" loading="lazy" className="h-full w-full object-contain" onError={() => setOk(false)} />
        : <Package className="h-6 w-6 text-muted-foreground" />}
    </div>
  );
}

export function EncaixotamentoAmazon({ numero }: { numero: string }) {
  const qc = useQueryClient();
  const [lendo, setLendo] = useState(false);
  const q = useQuery({
    queryKey: ["fulfillment", "encaixotamento-amazon", numero],
    staleTime: 60_000,
    placeholderData: undefined,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("amazon_envio_plano").select("id, itens, envios_amazon")
        .contains("envios_amazon", JSON.stringify([{ fba: numero }])).limit(1).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const envio = ((data.envios_amazon ?? []) as { fba: string; encaixotamento?: Encaixotamento }[]).find((e) => e.fba === numero);
      const nomes = new Map(((data.itens ?? []) as { msku: string; sku: string; titulo: string | null }[]).map((l) => [String(l.msku), l]));
      // foto só dos SKUs deste envio
      const skus = [...new Set([...nomes.values()].map((l) => l.sku).filter(Boolean))];
      const fotos = new Map<string, string | null>();
      if (skus.length) {
        const { data: fs } = await supabaseExternal.from("view_foto_produto").select("sku, foto").in("sku", skus);
        for (const f of (fs ?? []) as { sku: string; foto: string | null }[]) fotos.set(String(f.sku), f.foto);
      }
      return { plano: String(data.id), enc: envio?.encaixotamento ?? null, nomes, fotos };
    },
  });
  if (q.isLoading) return null;

  // envio criado no Seller Central: o app ainda não conhece o plano da Amazon
  async function vincular() {
    setLendo(true);
    try {
      const j = await chamarInbound({ modulo: "vincular", numeros: [numero] });
      const r = ((j.resultado ?? []) as Record<string, any>[])[0];
      if (r?.erro || r?.pendente) throw new Error(r.erro ?? r.pendente);
      if (r && !r.achado) throw new Error("não achei o plano deste envio na Amazon");
      toast.success("Envio ligado à Amazon", { description: "Caixas, etiquetas e folha de encaixotamento anexadas. A NF chega sozinha quando for gerada no Seller Central." });
      await q.refetch();
      void qc.invalidateQueries({ queryKey: ["fulfillment"] });
    } catch (e) { toast.error("Não consegui buscar na Amazon", { description: (e as Error).message }); } finally { setLendo(false); }
  }
  if (!q.data) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="text-sm">
          <div className="flex items-center gap-1.5 font-semibold"><Boxes className="h-4 w-4" /> Encaixotamento (Amazon)</div>
          <div className="text-muted-foreground">Envio criado no Seller Central: busque o plano na Amazon para trazer as caixas, as etiquetas, a folha de encaixotamento e a NF.</div>
        </div>
        <Button size="sm" variant="outline" className="gap-1" disabled={lendo} onClick={() => void vincular()}>
          {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Buscar na Amazon
        </Button>
      </Card>
    );
  }

  async function lerAgora() {
    setLendo(true);
    try {
      await chamarInbound({ modulo: "nf-remessa", plano: q.data!.plano, reler: true });
      await q.refetch();
      void qc.invalidateQueries({ queryKey: ["fulfillment"] });
    } catch (e) { toast.error("Não consegui ler da Amazon", { description: (e as Error).message }); } finally { setLendo(false); }
  }

  const { enc, nomes, fotos } = q.data;
  const nome = (msku: string) => nomes.get(msku);
  const { porMsku, mistas } = montarVolumes(enc?.caixas ?? []);
  const totalCaixas = (enc?.caixas ?? []).reduce((s, c) => s + Math.max(1, c.qtd || 1), 0);
  const totalUn = (enc?.caixas ?? []).reduce((s, c) => s + Math.max(1, c.qtd || 1) * c.itens.reduce((t, i) => t + i.q, 0), 0);
  const totalKg = (enc?.caixas ?? []).reduce((s, c) => s + Math.max(1, c.qtd || 1) * (c.kg ?? 0), 0);

  return (
    <Card className="p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Boxes className="h-4 w-4" /> Como montar os volumes</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {enc && <span>{formatNumber(totalCaixas)} volumes · {formatNumber(totalUn)} un · {formatNumber(Math.round(totalKg))} kg</span>}
          <Button size="sm" variant="ghost" className="h-7 gap-1" disabled={lendo} onClick={() => void lerAgora()}
            title="Relê as caixas, a NF e a coleta na Amazon e refaz a folha PREP (PDF nos documentos do envio)">
            {lendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Ler da Amazon
          </Button>
        </div>
      </div>
      {!enc ? (
        <p className="text-sm text-muted-foreground">Ainda não lido da Amazon — aparece em até 10 minutos, ou clique em "Ler da Amazon".</p>
      ) : (
        <div className="divide-y">
          {(enc.itens ?? []).map((i) => {
            const n = nome(i.msku);
            const especial = i.preparo.filter((p) => p.tipo !== "ITEM_LABELING" && p.tipo !== "ITEM_NO_PREP");
            const formatos = [...(porMsku.get(i.msku)?.values() ?? [])];
            return (
              <div key={i.msku} className="flex gap-3 py-2.5">
                <Foto url={n?.sku ? fotos.get(n.sku) : null} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="text-sm font-medium leading-snug">{n?.titulo ?? i.msku}</div>
                  <div className="text-[11.5px] text-muted-foreground">
                    SKU <span className="font-mono">{n?.sku ?? i.msku}</span> · {formatNumber(i.q)} un
                    {i.validade ? ` · validade ${dataBR(i.validade)}` : ""}
                  </div>
                  {formatos.map((f, k) => (
                    <div key={k} className="text-[14px]">
                      <b className="tabular-nums">{formatNumber(f.volumes)} {f.volumes === 1 ? "volume" : "volumes"}</b> com <b>{f.un} un</b> cada
                      <span className="text-muted-foreground">{f.nomes.size ? ` · ${[...f.nomes].join(" / ")}` : ""} · {f.c ?? "?"}×{f.l ?? "?"}×{f.a ?? "?"} cm · {f.kg != null ? `${formatNumber(f.kg)} kg` : "peso ?"}</span>
                    </div>
                  ))}
                  {especial.length > 0 && (
                    <div className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[12px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                      <AlertTriangle className="h-3 w-3" /> Preparo: {especial.map((p) => nomePreparo(p.tipo)).join(" + ")}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {mistas.map((g, k) => (
            <div key={`m${k}`} className="py-2.5 text-[14px]">
              <b>{formatNumber(g.volumes)} {g.volumes === 1 ? "volume misto" : "volumes mistos"}</b> com{" "}
              {g.cx.itens.map((i) => `${i.q} un ${nome(i.msku)?.sku ?? i.msku}`).join(" + ")}
              <span className="text-muted-foreground"> · {g.cx.c ?? "?"}×{g.cx.l ?? "?"}×{g.cx.a ?? "?"} cm · {g.cx.kg != null ? `${formatNumber(g.cx.kg)} kg` : "peso ?"}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
