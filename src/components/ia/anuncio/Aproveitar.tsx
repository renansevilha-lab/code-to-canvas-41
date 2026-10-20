import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, ExternalLink, ImageOff, Loader2, Recycle, Send } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  ROTULO_ETAPA, chamarAproveitar, chamarPublicar, nomeCanal, nomeEmpresa, rotuloFoto, rotuloRelacao, temSeloShopee, urlsAssinadas,
  type IaDestino, type IaEtapa, type IaFonte, type IaFontes, type IaRascunho, type IaRascunhoImagem,
} from "@/lib/iaAnuncio";

/**
 * Aproveitar o que já está pronto, sem gerar de novo (12/out/2026, pedido do dono):
 *  - TRAZER para este produto/canal o texto e as fotos de outro anúncio do mesmo produto (Shopee →
 *    Mercado Livre) ou as fotos de um produto da mesma família de kit;
 *  - LEVAR as fotos deste anúncio para os kits do produto, de uma vez.
 * Tudo pela edge fn `ia-aproveitar`: só copia dentro da gestão, não chama IA nem marketplace.
 */
export function Aproveitar({ sku, canal, empresa, rascunho, imagens, etapas, onDestino }: {
  sku: string; canal: string; empresa: string; rascunho: IaRascunho | null;
  imagens: IaRascunhoImagem[]; etapas: IaEtapa[]; onDestino: (id: string) => void;
}) {
  const fontesQ = useQuery({
    queryKey: ["ia-anuncio", "aproveitar", sku, canal, empresa, rascunho?.id ?? ""],
    enabled: !!sku,
    queryFn: async () => (await chamarAproveitar("fontes", { sku, canal, empresa, destino_id: rascunho?.id })) as IaFontes,
  });
  const [trazer, setTrazer] = useState<IaFonte | null>(null);
  const [levar, setLevar] = useState(false);
  const [lote, setLote] = useState(false);
  const d = fontesQ.data;
  const comArquivo = imagens.filter((i) => i.storage_path);
  const podeLevar = !!rascunho && comArquivo.length > 0 && (d?.familia.length ?? 0) > 0;
  // o MESMO produto não precisa mais ser trazido de outro canal: o anúncio é um só e o destino é
  // escolhido no bloco "Enviar". Aqui ficam só as fotos da família de kit (outros produtos).
  const fontes = (d?.fontes ?? []).filter((f) => f.relacao !== "mesmo");
  if (!d || (fontes.length === 0 && !podeLevar)) return null;

  return (
    <Card><CardContent className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Recycle className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold">Aproveitar as fotos da família de kit</h3>
        <span className="text-xs text-muted-foreground">sem gerar de novo e sem custo de IA</span>
      </div>

      {fontes.length > 0 && (
        <div className="divide-y rounded-md border">
          {fontes.slice(0, 12).map((f) => {
            const ok = f.imagens.filter((i) => i.status === "aprovado").length;
            const st = f.texto?.status ? ROTULO_ETAPA[f.texto.status] : null;
            return (
              <div key={f.rascunho_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <Badge variant={f.relacao === "mesmo" ? "default" : "secondary"} className="text-[10px] py-0">{rotuloRelacao(f)}</Badge>
                <div className="min-w-0 flex-1 basis-[220px]">
                  <div className="truncate" title={f.nome}>
                    {f.relacao !== "mesmo" && <span className="font-mono text-xs text-muted-foreground mr-1.5">{f.sku}</span>}
                    {f.relacao === "mesmo" ? <b>{nomeCanal(f.canal)} · {nomeEmpresa(f.empresa)}</b> : f.nome}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {f.relacao !== "mesmo" && <>{nomeCanal(f.canal)} · {nomeEmpresa(f.empresa)} · </>}
                    {f.texto ? <>texto <span style={{ color: st?.cor }} className="font-semibold">{st?.rotulo ?? "sem revisão"}</span></> : "sem texto"}
                    {" · "}{f.imagens.length} foto(s){f.imagens.length > 0 && <>, {ok} aprovada(s)</>}
                  </div>
                </div>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setTrazer(f)}>
                  <ArrowDownToLine className="h-3.5 w-3.5" />Usar as fotos deste produto
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {podeLevar && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            Este produto tem {d.familia.length} produto(s) na família de kit.
          </span>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setLevar(true)}>
            <ArrowUpFromLine className="h-3.5 w-3.5" />Levar as fotos deste anúncio para os kits
          </Button>
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setLote(true)}>
            <Send className="h-3.5 w-3.5" />Atualizar as fotos em todos os anúncios da família
          </Button>
        </div>
      )}

      {trazer && (
        <DialogoTrazer fonte={trazer} dados={d} sku={sku} canal={canal} empresa={empresa} rascunho={rascunho}
          onFechar={() => setTrazer(null)} onDestino={onDestino} />
      )}
      {levar && rascunho && (
        <DialogoLevar rascunho={rascunho} imagens={comArquivo} etapas={etapas} onFechar={() => setLevar(false)} />
      )}
      {lote && rascunho && (
        <DialogoFamilia rascunho={rascunho} imagens={comArquivo} etapas={etapas} onFechar={() => setLote(false)} />
      )}
    </CardContent></Card>
  );
}

/** Miniaturas com caixa de seleção (as fotos ficam num bucket privado: URL assinada). */
function GradeEscolha({ fotos, sel, onAlternar, nota }: {
  fotos: { id: string; tipo: string; storage_path: string; status: string | null }[];
  sel: Set<string>; onAlternar: (id: string) => void; nota?: (f: { id: string; tipo: string }) => string | null;
}) {
  const paths = fotos.map((f) => f.storage_path);
  const urlsQ = useQuery({
    queryKey: ["ia-anuncio", "urls", paths.join("|")],
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas(paths),
  });
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {fotos.map((f) => {
        const url = urlsQ.data?.[f.storage_path];
        const marcada = sel.has(f.id);
        const obs = nota?.(f) ?? null;
        return (
          <label key={f.id} className={`rounded-md border overflow-hidden cursor-pointer ${marcada ? "ring-2 ring-primary" : "opacity-70"}`}>
            <div className="aspect-square bg-muted/30 flex items-center justify-center relative">
              {url ? <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" />
                : urlsQ.isLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <ImageOff className="h-4 w-4 text-muted-foreground" />}
              <Checkbox className="absolute top-1 left-1 bg-background" checked={marcada} onCheckedChange={() => onAlternar(f.id)} />
            </div>
            <div className="px-1.5 py-1 text-[10.5px] leading-tight">
              <div className="capitalize font-medium truncate">{rotuloFoto(f.tipo)}</div>
              <div className="text-muted-foreground truncate">
                {obs ?? (f.status === "aprovado" ? "aprovada" : f.status === "rejeitado" ? "rejeitada" : "para revisar")}
              </div>
            </div>
          </label>
        );
      })}
    </div>
  );
}
const alternarEm = (s: Set<string>, id: string) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; };

// ---------------------------------------------------------------- trazer (de outro rascunho para este)
export function DialogoTrazer({ fonte, dados, sku, canal, empresa, rascunho, onFechar, onDestino }: {
  fonte: IaFonte; dados: IaFontes; sku: string; canal: string; empresa: string; rascunho: IaRascunho | null;
  onFechar: () => void; onDestino: (id: string) => void;
}) {
  const qc = useQueryClient();
  const mesmo = fonte.relacao === "mesmo";
  const jaTem = useMemo(() => new Set(dados.destino?.tipos ?? []), [dados.destino]);
  // o que vem marcado: as aprovadas que ainda não existem aqui. Capa com selo da Shopee não vai para
  // outro canal; capa de OUTRO produto mostra a quantidade errada.
  const padrao = useMemo(() => {
    const serve = (i: IaFonte["imagens"][number]) => !jaTem.has(i.tipo)
      && !(temSeloShopee(i.tipo) && canal !== "shopee") && (mesmo || !i.tipo.startsWith("capa_"));
    const aprovadas = fonte.imagens.filter((i) => i.status === "aprovado");
    return new Set((aprovadas.length ? aprovadas : fonte.imagens).filter(serve).map((i) => i.id));
  }, [fonte, jaTem, canal, mesmo]);
  const [sel, setSel] = useState<Set<string>>(padrao);
  const [texto, setTexto] = useState(!!fonte.texto && mesmo && !dados.destino?.tem_texto);
  const [aprovadas, setAprovadas] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  useEffect(() => { setSel(padrao); }, [padrao]);

  const escolhidas = fonte.imagens.filter((i) => sel.has(i.id));
  const substitui = escolhidas.filter((i) => jaTem.has(i.tipo)).length;
  const estouro = fonte.texto && fonte.texto.n_titulo > dados.limite_titulo;

  async function aplicar() {
    setOcupado(true);
    try {
      const r = await chamarAproveitar("aplicar", {
        origem_id: fonte.rascunho_id, sku, canal, empresa, destino_id: rascunho?.id,
        texto, imagens: escolhidas.map((i) => i.id), substituir: substitui > 0, aprovadas,
      });
      const puladas = (r.puladas ?? []) as { tipo: string; motivo: string }[];
      toast.success(
        [r.texto ? (r.texto === "copiado_aprovado" ? "texto trazido (aprovado)" : "texto trazido (para revisar)") : null,
          `${(r.copiadas ?? []).length} foto(s) trazida(s)`].filter(Boolean).join(" · "),
        { description: [...((r.avisos ?? []) as string[]), ...puladas.map((p) => `${rotuloFoto(p.tipo)}: ${p.motivo}`)].slice(0, 6).join("\n") || undefined, duration: 9000 },
      );
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
      if (r.rascunho_id && r.rascunho_id !== rascunho?.id) onDestino(String(r.rascunho_id));
      onFechar();
    } catch (e) {
      toast.error("Não foi possível trazer", { description: (e as Error).message, duration: 12000 });
    } finally { setOcupado(false); }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Trazer para {nomeCanal(canal)} · {nomeEmpresa(empresa)}</DialogTitle>
          <DialogDescription>
            De {mesmo ? "este mesmo produto" : <><span className="font-mono">{fonte.sku}</span> · {fonte.nome}</>} em {nomeCanal(fonte.canal)} · {nomeEmpresa(fonte.empresa)}.
            Nada é gerado de novo: o texto e as fotos são copiados para o rascunho deste canal{!rascunho && " (que é criado agora, com o preço calculado)"}.
          </DialogDescription>
        </DialogHeader>

        {fonte.texto && (
          <div className="rounded-md border p-3 space-y-1.5">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <Checkbox checked={texto} onCheckedChange={(v) => setTexto(v === true)} />Texto (título, descrição e bullets)
            </label>
            <p className="text-xs text-muted-foreground">"{fonte.texto.titulo}" · {fonte.texto.n_titulo} caracteres</p>
            {texto && dados.destino?.tem_texto && <p className="text-xs text-amber-600">O rascunho deste canal já tem texto: ele será substituído.</p>}
            {texto && estouro && <p className="text-xs text-amber-600">{nomeCanal(canal)} aceita título de até {dados.limite_titulo} caracteres: o texto vem como está e fica para você encurtar e aprovar.</p>}
            {texto && !mesmo && <p className="text-xs text-amber-600">É o texto de outro produto: ajuste nome e quantidade antes de aprovar.</p>}
          </div>
        )}

        {fonte.imagens.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Fotos ({escolhidas.length} de {fonte.imagens.length})</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSel(new Set(fonte.imagens.map((i) => i.id)))}>todas</Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSel(new Set())}>nenhuma</Button>
            </div>
            <GradeEscolha fotos={fonte.imagens} sel={sel} onAlternar={(id) => setSel((s) => alternarEm(s, id))}
              nota={(f) => (jaTem.has(f.tipo) ? "já existe aqui" : temSeloShopee(f.tipo) && canal !== "shopee" ? "selo da Shopee"
                : !mesmo && f.tipo.startsWith("capa_") ? "capa de outro produto" : null)} />
            {substitui > 0 && <p className="text-xs text-amber-600">{substitui} foto(s) marcada(s) já existe(m) neste rascunho e será(ão) substituída(s).</p>}
            {escolhidas.some((i) => temSeloShopee(i.tipo)) && canal !== "shopee" && (
              <p className="text-xs text-destructive">Há capa com o selo "Preço de Atacado" (estilo da Shopee) marcada: ela não pode ir para outro canal.</p>
            )}
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox checked={aprovadas} onCheckedChange={(v) => setAprovadas(v === true)} />
              o que estava aprovado lá já entra aprovado aqui
            </label>
          </div>
        ) : <p className="text-sm text-muted-foreground">Este anúncio não tem fotos geradas.</p>}

        <DialogFooter>
          <Button variant="ghost" disabled={ocupado} onClick={onFechar}>Cancelar</Button>
          <Button disabled={ocupado || (!texto && escolhidas.length === 0)} onClick={() => void aplicar()} className="gap-1.5">
            {ocupado && <Loader2 className="h-4 w-4 animate-spin" />}
            Trazer {[texto ? "texto" : null, escolhidas.length ? `${escolhidas.length} foto(s)` : null].filter(Boolean).join(" + ")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- levar (deste rascunho para os kits)
function DialogoLevar({ rascunho, imagens, etapas, onFechar }: {
  rascunho: IaRascunho; imagens: IaRascunhoImagem[]; etapas: IaEtapa[]; onFechar: () => void;
}) {
  const qc = useQueryClient();
  const statusDe = useMemo(() => new Map(etapas.filter((e) => e.etapa === "imagem").map((e) => [e.imagem_id, e.status as string])), [etapas]);
  const fotos = useMemo(() => imagens.filter((i) => i.storage_path).sort((a, b) => a.ordem - b.ordem)
    .map((i) => ({ id: i.id, tipo: i.tipo ?? "", storage_path: i.storage_path!, status: statusDe.get(i.id) ?? null })), [imagens, statusDe]);
  const destinosQ = useQuery({
    queryKey: ["ia-anuncio", "aproveitar-destinos", rascunho.id],
    queryFn: async () => ((await chamarAproveitar("destinos", { rascunho_id: rascunho.id })).destinos ?? []) as IaDestino[],
  });
  // capa mostra a quantidade do produto de origem: não vem marcada
  const [sel, setSel] = useState<Set<string>>(() => new Set(fotos.filter((f) => f.status === "aprovado" && !f.tipo.startsWith("capa_")).map((f) => f.id)));
  const [skus, setSkus] = useState<Set<string>>(new Set());
  const [aprovadas, setAprovadas] = useState(true);
  const [substituir, setSubstituir] = useState(false);
  const [andamento, setAndamento] = useState<{ feitos: number; total: number } | null>(null);
  const lista = destinosQ.data ?? [];
  // vêm marcados os kits só deste produto; kit misto (com outros produtos) fica para a pessoa decidir
  useEffect(() => { setSkus(new Set(lista.filter((x) => x.n_componentes <= 1).map((x) => x.sku))); }, [destinosQ.data]);

  async function aplicar() {
    const ids = fotos.filter((f) => sel.has(f.id)).map((f) => f.id);
    let fila = lista.filter((x) => skus.has(x.sku)).map((x) => x.sku);
    const total = fila.length;
    setAndamento({ feitos: 0, total });
    const feitos: { sku: string; ok: boolean; erro?: string; copiadas?: number; criado?: boolean }[] = [];
    try {
      // a função para com folga do limite de tempo e devolve o que faltou: reenvia até acabar
      for (let volta = 0; fila.length && volta < 20; volta++) {
        const r = await chamarAproveitar("aplicar-lote", {
          origem_id: rascunho.id, skus: fila, canal: rascunho.canal, empresa: rascunho.empresa, imagens: ids, substituir, aprovadas,
        });
        feitos.push(...((r.feitos ?? []) as typeof feitos));
        fila = (r.restantes ?? []) as string[];
        setAndamento({ feitos: feitos.length, total });
      }
      const ok = feitos.filter((f) => f.ok);
      const erros = feitos.filter((f) => !f.ok);
      const nFotos = ok.reduce((s, f) => s + (f.copiadas ?? 0), 0);
      (erros.length ? toast.warning : toast.success)(
        `${nFotos} foto(s) levada(s) para ${ok.length} produto(s)`,
        { description: [ok.filter((f) => f.criado).length ? `${ok.filter((f) => f.criado).length} rascunho(s) criado(s) em ${nomeCanal(rascunho.canal)}` : null,
          ...erros.slice(0, 4).map((f) => `${f.sku}: ${f.erro}`)].filter(Boolean).join("\n") || undefined, duration: 10000 },
      );
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
      onFechar();
    } catch (e) {
      toast.error("Parou no meio", { description: `${feitos.length} de ${total} produto(s) feitos. ${(e as Error).message}`, duration: 12000 });
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } finally { setAndamento(null); }
  }

  const ocupado = !!andamento;
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Levar as fotos para os kits</DialogTitle>
          <DialogDescription>
            As fotos marcadas entram no anúncio de {nomeCanal(rascunho.canal)} · {nomeEmpresa(rascunho.empresa)} de cada produto escolhido.
            Quem ainda não tem rascunho ganha um, com o preço calculado. Texto e capa continuam sendo de cada produto.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <span className="text-sm font-medium">Fotos ({sel.size} de {fotos.length})</span>
          <GradeEscolha fotos={fotos} sel={sel} onAlternar={(id) => setSel((s) => alternarEm(s, id))}
            nota={(f) => (f.tipo.startsWith("capa_") ? "capa: mostra a quantidade" : null)} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Produtos ({skus.size} de {lista.length})</span>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSkus(new Set(lista.map((x) => x.sku)))}>todos</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSkus(new Set())}>nenhum</Button>
          </div>
          {destinosQ.isLoading ? <div className="p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando a família…</div>
            : destinosQ.isError ? <div className="p-4 text-sm text-destructive">Falha: {(destinosQ.error as Error).message}</div>
            : (
              <div className="divide-y rounded-md border max-h-[280px] overflow-y-auto">
                {lista.map((x) => (
                  <label key={x.sku} className="flex items-center gap-2.5 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/30">
                    <Checkbox checked={skus.has(x.sku)} onCheckedChange={() => setSkus((s) => alternarEm(s, x.sku))} />
                    <div className="h-8 w-8 rounded border bg-muted/30 overflow-hidden shrink-0 flex items-center justify-center">
                      {x.foto ? <img src={x.foto} alt="" loading="lazy" className="h-full w-full object-cover" /> : <ImageOff className="h-3.5 w-3.5 text-muted-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={x.nome}><span className="font-mono text-xs text-muted-foreground mr-1.5">{x.sku}</span>{x.nome}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {rotuloRelacao(x)} · {x.rascunho_id ? `já tem rascunho, ${x.n_fotos} foto(s)` : "sem rascunho neste canal"}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox checked={aprovadas} onCheckedChange={(v) => setAprovadas(v === true)} />as aprovadas aqui já entram aprovadas lá
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox checked={substituir} onCheckedChange={(v) => setSubstituir(v === true)} />substituir a foto do mesmo tipo que o produto já tiver
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={ocupado} onClick={onFechar}>Cancelar</Button>
          <Button disabled={ocupado || sel.size === 0 || skus.size === 0} onClick={() => void aplicar()} className="gap-1.5">
            {ocupado && <Loader2 className="h-4 w-4 animate-spin" />}
            {andamento ? `Levando… ${andamento.feitos} de ${andamento.total}` : `Levar ${sel.size} foto(s) para ${skus.size} produto(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- lote: as fotos em TODOS os anúncios da família
// Pedido do dono (12/out): com um clique, levar as fotos deste anúncio para todos os anúncios (em todas
// as lojas) dos produtos da família. REGRA: em cada anúncio a CAPA atual fica (1ª foto) e as demais
// são trocadas pelas fotos escolhidas. Passos: escolher fotos e produtos → ver os anúncios que existem
// (lidos ao vivo) → confirmar → um anúncio por vez. Só o campo "Fotos" é enviado.
const LOJAS_LOTE = [
  { canal: "shopee", empresa: "ottz", loja: "Shopee Ottz" }, { canal: "shopee", empresa: "svl", loja: "Shopee Bumi" },
  { canal: "mercado_livre", empresa: "ottz", loja: "Mercado Livre Ottz" }, { canal: "mercado_livre", empresa: "svl", loja: "Mercado Livre SVL" },
  { canal: "amazon", empresa: "ottz", loja: "Amazon ACZ" },
];
interface Listado { item_id: string; nome: string | null; url?: string | null; catalogo?: boolean }
interface AlvoLote { chave: string; canal: string; empresa: string; loja: string; item_id: string; nome: string | null; url: string | null; catalogo: boolean; skus: string[] }
type EstadoAlvo = { estado: "fila" | "enviando" | "ok" | "erro" | "pulado"; msg?: string };

function listadosDe(ex: any, canal: string, empresa: string): Listado[] {
  if (!ex) return [];
  if (canal === "shopee") return (ex.shopee?.[empresa] ?? []) as Listado[];
  if (canal === "mercado_livre") return ((ex.mercado_livre_lojas ? ex.mercado_livre_lojas[empresa] : empresa === "ottz" ? ex.mercado_livre : null) ?? []) as Listado[];
  if (canal === "amazon") return (ex.amazon?.[empresa] ?? []) as Listado[];
  return [];
}

function DialogoFamilia({ rascunho, imagens, etapas, onFechar }: {
  rascunho: IaRascunho; imagens: IaRascunhoImagem[]; etapas: IaEtapa[]; onFechar: () => void;
}) {
  const qc = useQueryClient();
  const statusDe = useMemo(() => new Map(etapas.filter((e) => e.etapa === "imagem").map((e) => [e.imagem_id, e.status as string])), [etapas]);
  // só as APROVADAS: é o que a função de envio aceita mandar
  const fotos = useMemo(() => imagens.filter((i) => i.storage_path && statusDe.get(i.id) === "aprovado").sort((a, b) => a.ordem - b.ordem)
    .map((i) => ({ id: i.id, tipo: i.tipo ?? "", storage_path: i.storage_path!, status: "aprovado" as string | null })), [imagens, statusDe]);
  const destinosQ = useQuery({
    queryKey: ["ia-anuncio", "aproveitar-destinos", rascunho.id],
    queryFn: async () => ((await chamarAproveitar("destinos", { rascunho_id: rascunho.id })).destinos ?? []) as IaDestino[],
  });
  const familia = destinosQ.data ?? [];
  // a capa nova não entra por padrão: a capa de cada anúncio é a que fica
  const [sel, setSel] = useState<Set<string>>(() => new Set(fotos.filter((x) => !x.tipo.startsWith("capa_")).map((x) => x.id)));
  const [skus, setSkus] = useState<Set<string>>(new Set());
  useEffect(() => { setSkus(new Set(familia.filter((x) => x.n_componentes <= 1).map((x) => x.sku))); }, [destinosQ.data]);
  const [passo, setPasso] = useState<"escolha" | "anuncios" | "enviando" | "fim">("escolha");
  const [lendo, setLendo] = useState<{ feitos: number; total: number } | null>(null);
  const [alvos, setAlvos] = useState<AlvoLote[]>([]);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [semLeitura, setSemLeitura] = useState<string[]>([]);
  const [estados, setEstados] = useState<Record<string, EstadoAlvo>>({});
  const parar = useRef(false);
  const marca = (a: AlvoLote, e: EstadoAlvo) => setEstados((x) => ({ ...x, [a.chave]: e }));
  const escolhidas = fotos.filter((x) => sel.has(x.id));

  /** Lê, ao vivo, os anúncios que existem de cada produto em cada loja. O mesmo anúncio pode servir a vários SKUs (variações). */
  async function verAnuncios() {
    const lista = [rascunho.sku, ...familia.filter((x) => skus.has(x.sku)).map((x) => x.sku)];
    setLendo({ feitos: 0, total: lista.length });
    const mapa = new Map<string, AlvoLote>(); const falhas: string[] = [];
    for (let i = 0; i < lista.length; i++) {
      try {
        const ex = (await chamarPublicar("existentes", { sku: lista[i] })).existentes;
        for (const l of LOJAS_LOTE) for (const e of listadosDe(ex, l.canal, l.empresa)) {
          const chave = `${l.canal}:${l.empresa}:${e.item_id}`;
          const ja = mapa.get(chave);
          if (ja) { if (!ja.skus.includes(lista[i])) ja.skus.push(lista[i]); }
          else mapa.set(chave, { chave, ...l, item_id: String(e.item_id), nome: e.nome ?? null, url: e.url ?? null, catalogo: e.catalogo === true, skus: [lista[i]] });
        }
      } catch { falhas.push(lista[i]); }
      setLendo({ feitos: i + 1, total: lista.length });
    }
    const todos = [...mapa.values()];
    setAlvos(todos); setMarcados(new Set(todos.filter((a) => !a.catalogo).map((a) => a.chave)));
    setSemLeitura(falhas); setLendo(null); setPasso("anuncios");
  }

  async function enviar() {
    const lista = alvos.filter((a) => marcados.has(a.chave));
    if (!lista.length || !escolhidas.length) return;
    if (!window.confirm([
      `Atualizar as FOTOS de ${lista.length} anúncio(s)?`, "",
      `Em cada um: a capa atual fica e as outras fotos são trocadas por estas ${escolhidas.length}.`,
      "Os anúncios estão no ar: a mudança aparece para os compradores na hora.",
      "Título, descrição e preço não são alterados.",
    ].join("\n"))) return;
    parar.current = false; setPasso("enviando");
    setEstados(Object.fromEntries(lista.map((a) => [a.chave, { estado: "fila" } as EstadoAlvo])));

    // 1) as fotos entram no rascunho de cada produto da família (o envio parte do rascunho do próprio produto)
    const rascDe = new Map<string, string>([[rascunho.sku, rascunho.id]]);
    const erroDe = new Map<string, string>();
    let fila = [...new Set(lista.flatMap((a) => a.skus))].filter((x) => x !== rascunho.sku);
    try {
      for (let volta = 0; fila.length && volta < 20; volta++) {
        const r = await chamarAproveitar("aplicar-lote", {
          origem_id: rascunho.id, skus: fila, canal: rascunho.canal, empresa: rascunho.empresa,
          imagens: escolhidas.map((x) => x.id), substituir: true, aprovadas: true,
        });
        for (const x of ((r.feitos ?? []) as { sku: string; ok: boolean; rascunho_id?: string; erro?: string }[])) {
          if (x.ok && x.rascunho_id) rascDe.set(x.sku, x.rascunho_id); else erroDe.set(x.sku, x.erro ?? "não consegui levar as fotos para este produto");
        }
        fila = (r.restantes ?? []) as string[];
      }
    } catch (e) { for (const x of fila) erroDe.set(x, (e as Error).message); }

    // 2) o caminho das fotos em cada rascunho (no deste anúncio é o original; nos outros, a cópia), na mesma ordem
    const tipos = escolhidas.map((x) => x.tipo);
    const caminhos = new Map<string, string[]>([[rascunho.id, escolhidas.map((x) => x.storage_path)]]);
    const ids = [...rascDe.values()].filter((id) => id !== rascunho.id);
    if (ids.length) {
      const { data } = await supabaseExternal.from("ia_rascunho_imagem").select("rascunho_id, tipo, storage_path").in("rascunho_id", ids).in("tipo", tipos).limit(5000);
      const linhas = (data ?? []) as { rascunho_id: string; tipo: string; storage_path: string | null }[];
      for (const id of ids) {
        caminhos.set(id, tipos.map((tp) => linhas.find((x) => x.rascunho_id === id && x.tipo === tp)?.storage_path ?? "").filter(Boolean));
      }
    }

    // 3) um anúncio por vez (sem repetir: reenviar sobe as fotos de novo)
    for (const a of lista) {
      if (parar.current) { marca(a, { estado: "pulado", msg: "parado antes de enviar" }); continue; }
      const sku = a.skus.find((x) => rascDe.has(x));
      const rid = sku ? rascDe.get(sku)! : null;
      const novas = rid ? (caminhos.get(rid) ?? []) : [];
      if (!rid || !novas.length) { marca(a, { estado: "erro", msg: erroDe.get(a.skus[0]) ?? "as fotos não chegaram ao rascunho deste produto" }); continue; }
      marca(a, { estado: "enviando" });
      try {
        await chamarPublicar("enviar", {
          rascunho_id: rid, destino: { canal: a.canal, empresa: a.empresa }, confirmar: true,
          opcoes: {
            modo: "atualizar", item_id: a.item_id, campos: { titulo: false, descricao: false, fotos: true, preco: false },
            fotos: { manter_pos: [0], novas, posicao: "fim" },
          },
        });
        marca(a, { estado: "ok" });
      } catch (e) { marca(a, { estado: "erro", msg: (e as Error).message }); }
    }
    setPasso("fim");
    void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  }

  const ocupado = passo === "enviando" || !!lendo;
  const nOk = Object.values(estados).filter((x) => x.estado === "ok").length;
  const nErro = Object.values(estados).filter((x) => x.estado === "erro").length;
  const nomeSku = (x: string) => (x === rascunho.sku ? "este produto" : familia.find((p) => p.sku === x)?.nome ?? x);
  return (
    <Dialog open onOpenChange={(v) => { if (!v && !ocupado) onFechar(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Atualizar as fotos em todos os anúncios da família</DialogTitle>
          <DialogDescription>
            Em cada anúncio a <b>capa atual fica</b> e as outras fotos são trocadas pelas escolhidas aqui. Vale para este produto e para os
            produtos da família marcados, em todas as lojas onde já existe anúncio. Título, descrição e preço não mudam.
          </DialogDescription>
        </DialogHeader>

        {passo === "escolha" && (
          <>
            <div className="space-y-2">
              <span className="text-sm font-medium">Fotos que entram ({escolhidas.length} de {fotos.length} aprovadas)</span>
              {fotos.length ? <GradeEscolha fotos={fotos} sel={sel} onAlternar={(id) => setSel((x) => alternarEm(x, id))}
                nota={(x) => (x.tipo.startsWith("capa_") ? "capa: a de cada anúncio fica" : null)} />
                : <p className="text-sm text-muted-foreground">Aprove ao menos uma foto deste anúncio primeiro.</p>}
              {escolhidas.length > 8 && <p className="text-xs text-amber-600">A Shopee e a Amazon aceitam 9 fotos: com a capa, cabem 8 novas. Os anúncios dessas lojas vão recusar.</p>}
              <p className="text-xs text-amber-600 flex gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />Confira se as artes citam a quantidade (ex.: "Combo 2 unidades"): elas vão iguais para o kit de 3, 6 ou 12.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">Produtos da família ({skus.size} de {familia.length}) + este produto</span>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSkus(new Set(familia.map((x) => x.sku)))}>todos</Button>
                <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSkus(new Set())}>nenhum</Button>
              </div>
              {destinosQ.isLoading ? <div className="p-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Carregando a família…</div> : (
                <div className="divide-y rounded-md border max-h-[220px] overflow-y-auto">
                  {familia.map((x) => (
                    <label key={x.sku} className="flex items-center gap-2.5 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/30">
                      <Checkbox checked={skus.has(x.sku)} onCheckedChange={() => setSkus((y) => alternarEm(y, x.sku))} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate" title={x.nome}><span className="font-mono text-xs text-muted-foreground mr-1.5">{x.sku}</span>{x.nome}</div>
                        <div className="text-[11px] text-muted-foreground">{rotuloRelacao(x)}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" disabled={ocupado} onClick={onFechar}>Cancelar</Button>
              <Button disabled={ocupado || escolhidas.length === 0} onClick={() => void verAnuncios()} className="gap-1.5">
                {lendo && <Loader2 className="h-4 w-4 animate-spin" />}
                {lendo ? `Lendo os anúncios… ${lendo.feitos} de ${lendo.total}` : "Ver os anúncios que serão atualizados"}
              </Button>
            </DialogFooter>
          </>
        )}

        {passo !== "escolha" && (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">
                {passo === "anuncios" ? `Anúncios encontrados (${marcados.size} de ${alvos.length} marcados)` : `${nOk} atualizado(s) · ${nErro} com erro · ${Object.keys(estados).length} no total`}
              </span>
              <div className="flex-1" />
              {passo === "anuncios" && <>
                <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setMarcados(new Set(alvos.filter((a) => !a.catalogo).map((a) => a.chave)))}>todos</Button>
                <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setMarcados(new Set())}>nenhum</Button>
              </>}
            </div>
            {semLeitura.length > 0 && <p className="text-xs text-amber-600">Não consegui ler os anúncios de: {semLeitura.join(", ")}.</p>}
            {alvos.length === 0 && <p className="text-sm text-muted-foreground">Nenhum anúncio encontrado para esses produtos.</p>}
            <div className="divide-y rounded-md border max-h-[46vh] overflow-y-auto">
              {alvos.filter((a) => passo === "anuncios" || estados[a.chave]).map((a) => {
                const st = estados[a.chave];
                return (
                  <label key={a.chave} className="flex items-start gap-2.5 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/30">
                    {passo === "anuncios"
                      ? <Checkbox className="mt-0.5" disabled={a.catalogo} checked={marcados.has(a.chave)} onCheckedChange={() => setMarcados((x) => alternarEm(x, a.chave))} />
                      : st?.estado === "ok" ? <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                      : st?.estado === "erro" ? <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                      : st?.estado === "enviando" ? <Loader2 className="h-4 w-4 animate-spin mt-0.5 shrink-0" />
                      : <span className="h-4 w-4 mt-0.5 shrink-0 rounded-full border" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate"><b>{a.loja}</b> · {a.nome ?? a.item_id}</div>
                      <div className="text-[11px] text-muted-foreground">
                        código {a.item_id} · {a.skus.map((x) => (x === rascunho.sku ? x : `${x}`)).join(", ")}
                        {a.skus.length > 1 && " (o mesmo anúncio vende mais de um destes produtos)"}
                        {a.catalogo && " · anúncio de catálogo: as fotos são da ficha do Mercado Livre"}
                      </div>
                      {st?.msg && <div className={`text-[11px] ${st.estado === "erro" ? "text-destructive" : "text-muted-foreground"}`}>{st.msg}</div>}
                      {passo === "anuncios" && a.skus.length === 1 && a.skus[0] !== rascunho.sku && <div className="text-[11px] text-muted-foreground truncate">{nomeSku(a.skus[0])}</div>}
                    </div>
                    {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="text-xs underline inline-flex items-center gap-0.5 shrink-0">abrir<ExternalLink className="h-3 w-3" /></a>}
                  </label>
                );
              })}
            </div>
            <DialogFooter>
              {passo === "anuncios" && <>
                <Button variant="ghost" onClick={() => setPasso("escolha")}>Voltar</Button>
                <Button disabled={marcados.size === 0} onClick={() => void enviar()} className="gap-1.5"><Send className="h-4 w-4" />Atualizar as fotos de {marcados.size} anúncio(s)</Button>
              </>}
              {passo === "enviando" && <Button variant="outline" onClick={() => { parar.current = true; toast.message("Vou parar depois do anúncio que está sendo enviado"); }}>Parar</Button>}
              {passo === "fim" && <Button onClick={onFechar}>Fechar</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
