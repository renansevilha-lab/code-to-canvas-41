import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ImageOff, Images, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { chamarAproveitar, chamarIa, ROTULO_ETAPA, urlsAssinadas, type IaBriefing, type IaEtapa, type IaRascunhoImagem } from "@/lib/iaAnuncio";
import { extrairPeso } from "@/lib/prazo";
import { decidirEtapa } from "@/components/ia/anuncio/EtapaTexto";

// ============================================================================
// "Fotos das variações" (12/out/2026, pedido do dono): no produto COM VARIAÇÕES (pai), gera
// UMA foto por variação — cena ambientada, sem texto de venda, com a quantidade de embalagens
// daquela variação (a variação é um kit de N× o produto base). Opcional: um selo só com o
// peso/quantidade da variação ("8kg", "2 unidades").
// Não tem função nova no servidor: reaproveita o que já existe, variação por variação —
//   1) o briefing do pai é copiado para a variação (a foto precisa de um; não gasta IA);
//   2) `ia-anuncio?modulo=prompts-imagem` escreve o prompt do estilo de capa ambientada com os
//      "dados do operador" (quantidade de embalagens, peso impresso, selo);
//   3) a variação ganha um rascunho (RPC ia_rascunho_criar) se ainda não tem;
//   4) `ia-anuncio?modulo=imagens` põe a foto na fila (o worker gera uma por vez).
// A foto de referência de cada variação é a foto dela no Tiny — que, nas criadas pelo app,
// é a foto principal do produto base.
// ============================================================================

const LIMPA = "imagem_capa_ambientada_limpa"; // estilo 5: produto no ambiente, sem nenhum texto
const COM_SELO = "imagem_capa_ambientada_texto"; // estilo 4: o selo do alto recebe só o peso/quantidade
const TIPOS = [LIMPA, COM_SELO].map((t) => t.replace("imagem_", ""));
const ANDANDO = new Set(["na_fila", "gerando"]);

interface Variacao {
  sku: string; nome: string; quantidade: number; rotulo: string; pesoUnit: string;
  rascunhoId: string | null; temBriefing: boolean;
  imagem: IaRascunhoImagem | null; etapa: IaEtapa | null; url: string | null;
  /** Foto APROVADA do mesmo kit (mesmo produto base × mesma quantidade) em outro anúncio — entra sem gerar. */
  gemea: Gemea | null;
}
interface Gemea { rascunho_id: string; imagem_id: string; sku: string }

export function FotosVariacoes({ sku, nomePai, canal, empresa, briefing, tiposAtivos, modelos }: {
  sku: string; nomePai: string; canal: string; empresa: string; briefing: IaBriefing | null;
  tiposAtivos: string[]; modelos: { id: string; label: string; custo_estimado_usd: number; padrao: boolean }[];
}) {
  const qc = useQueryClient();
  const chave = ["ia-anuncio", "fotos-variacoes", sku];
  const [comSelo, setComSelo] = useState(true);
  const [rodando, setRodando] = useState<Record<string, string>>({});
  const modelo = modelos.find((m) => m.padrao) ?? modelos[0];

  const q = useQuery({
    queryKey: chave,
    queryFn: async (): Promise<Variacao[]> => {
      const { data: vs, error } = await supabaseExternal.from("produtos").select("sku, nome").eq("sku_pai", sku).eq("ativo", true).order("sku");
      if (error) throw error;
      const vars = (vs ?? []) as { sku: string; nome: string | null }[];
      if (!vars.length) return [];
      const skus = vars.map((v) => v.sku);
      const [k, r, b] = await Promise.all([
        supabaseExternal.from("produto_kits").select("sku_kit, sku_componente, quantidade, nome_componente").in("sku_kit", skus),
        supabaseExternal.from("ia_rascunho").select("id, sku, created_at").in("sku", skus).order("created_at", { ascending: false }),
        supabaseExternal.from("ia_briefing").select("sku").in("sku", skus),
      ]);
      const kits = (k.data ?? []) as { sku_kit: string; sku_componente: string; quantidade: number; nome_componente: string | null }[];
      const rasc = (r.data ?? []) as { id: string; sku: string }[];
      const comBriefing = new Set(((b.data ?? []) as { sku: string }[]).map((x) => x.sku));
      const ids = rasc.map((x) => x.id);
      const im = ids.length
        ? await supabaseExternal.from("ia_rascunho_imagem").select("*").in("rascunho_id", ids).in("tipo", TIPOS)
        : { data: [] as IaRascunhoImagem[] };
      const imagens = (im.data ?? []) as IaRascunhoImagem[];
      const et = imagens.length
        ? await supabaseExternal.from("ia_etapa").select("*").in("imagem_id", imagens.map((i) => i.id))
        : { data: [] as IaEtapa[] };
      const etapas = (et.data ?? []) as IaEtapa[];
      const gemeas = await fotosGemeas(kits, skus).catch(() => new Map<string, Gemea>());
      const urls = await urlsAssinadas(imagens.map((i) => i.storage_path ?? "").filter(Boolean)).catch(() => ({} as Record<string, string>));

      return vars.map((v) => {
        const comp = kits.filter((x) => x.sku_kit === v.sku);
        // variação = kit de UM componente; fora disso vale 1 embalagem (quem decide é o operador, no Refazer)
        const quantidade = comp.length === 1 ? Math.max(1, Math.round(Number(comp[0].quantidade) || 1)) : 1;
        const nome = v.nome ?? v.sku;
        const sufixo = nome.startsWith(`${nomePai} - `) ? nome.slice(nomePai.length + 3).trim() : "";
        const p = extrairPeso(comp[0]?.nome_componente ?? "");
        const meus = new Set(rasc.filter((x) => x.sku === v.sku).map((x) => x.id));
        const minhas = imagens.filter((i) => meus.has(i.rascunho_id));
        const etapaDe = (i: IaRascunhoImagem) => etapas.find((e) => e.imagem_id === i.id) ?? null;
        // a que está sendo gerada vem primeiro; senão a mais recente
        const imagem = minhas.find((i) => ANDANDO.has(etapaDe(i)?.status ?? ""))
          ?? [...minhas].sort((a, z) => String(z.gerado_em ?? "").localeCompare(String(a.gerado_em ?? "")))[0] ?? null;
        return {
          sku: v.sku, nome, quantidade,
          rotulo: sufixo || `${quantidade} ${quantidade === 1 ? "unidade" : "unidades"}`,
          pesoUnit: p ? `${p.valor}${p.unidade}` : "",
          rascunhoId: rasc.find((x) => x.sku === v.sku)?.id ?? null, temBriefing: comBriefing.has(v.sku),
          imagem, etapa: imagem ? etapaDe(imagem) : null,
          url: imagem?.storage_path ? urls[imagem.storage_path] ?? null : null,
          gemea: comp.length === 1 ? gemeas.get(chaveKit(comp[0].sku_componente, comp[0].quantidade)) ?? null : null,
        };
      }).sort((a, z) => a.quantidade - z.quantidade || a.sku.localeCompare(z.sku));
    },
    refetchInterval: (x) => ((x.state.data as Variacao[] | undefined)?.some((v) => ANDANDO.has(v.etapa?.status ?? "")) ? 3000 : false),
  });
  const vars = q.data ?? [];

  // APROVEITAR AUTOMATICAMENTE (14/out/2026, pedido do dono): a variação sem foto que é o MESMO kit de uma
  // variação de outro anúncio com foto aprovada (ex.: "8kg" = 4× a areia de 2kg nos anúncios "2kg a 10kg" e
  // "8kg a 20kg") recebe essa foto sozinha, já aprovada — sem gerar e sem custo. Uma vez por abertura do bloco.
  const aproveitando = useRef(new Set<string>());
  const [copiando, setCopiando] = useState(false);
  useEffect(() => {
    const alvo = (q.data ?? []).filter((v) => v.gemea && !v.imagem?.storage_path && !ANDANDO.has(v.etapa?.status ?? "") && !aproveitando.current.has(v.sku));
    if (!alvo.length || copiando) return;
    alvo.forEach((v) => aproveitando.current.add(v.sku));
    setCopiando(true);
    void (async () => {
      const ok: string[] = []; const falhas: string[] = [];
      for (const v of alvo) {
        try {
          const r = await chamarAproveitar("aplicar", {
            origem_id: v.gemea!.rascunho_id, imagens: [v.gemea!.imagem_id], aprovadas: true,
            ...(v.rascunhoId ? { destino_id: v.rascunhoId } : { sku: v.sku, canal, empresa }),
          });
          if (((r.copiadas ?? []) as unknown[]).length) ok.push(`${v.rotulo} (do ${v.gemea!.sku})`);
          else falhas.push(`${v.rotulo}: ${((r.puladas ?? []) as { motivo: string }[])[0]?.motivo ?? "não copiou"}`);
        } catch (e) { falhas.push(`${v.rotulo}: ${(e as Error).message}`); }
      }
      setCopiando(false);
      void qc.invalidateQueries({ queryKey: chave });
      if (ok.length) toast.success(`${ok.length} foto(s) de variação aproveitada(s), sem gerar`, { description: `Mesmo kit em outro anúncio, já aprovada: ${ok.join(", ")}`, duration: 10000 });
      if (falhas.length) toast.error("Não consegui aproveitar algumas fotos de variação", { description: falhas.join("\n"), duration: 15000 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  if (!vars.length) return null;

  const tipo = comSelo && tiposAtivos.includes(COM_SELO) ? COM_SELO : LIMPA;
  const estiloAtivo = tiposAtivos.includes(tipo);
  const faltam = vars.filter((v) => (!v.imagem || v.etapa?.status === "erro") && !(v.gemea && !v.imagem?.storage_path));
  const custo = (n: number) => (modelo ? `US$ ${(n * Number(modelo.custo_estimado_usd)).toFixed(2).replace(".", ",")}` : "");
  const marca = (s: string, texto?: string) => setRodando((r) => { const n = { ...r }; if (texto) n[s] = texto; else delete n[s]; return n; });

  /** FOTO DE REFERÊNCIA (13/out): a variação é o MESMO produto do pai em outra quantidade. Sem foto real própria,
   *  ela passa a usar a foto de referência do produto pai (ou do produto base) — sem isso a IA recusa a variação
   *  ("SKU … sem foto de referência"), mesmo com o pai tendo a foto certa. Devolve o erro (ou null). */
  async function garantirReferencia(skuVar: string): Promise<string | null> {
    const [{ data: pai }, { data: kit }, { data: prod }] = await Promise.all([
      supabaseExternal.from("produtos").select("sku_base").eq("sku", sku).maybeSingle(),
      supabaseExternal.from("produto_kits").select("sku_componente").eq("sku_kit", skuVar),
      supabaseExternal.from("produtos").select("foto_capa").eq("sku", skuVar).maybeSingle(),
    ]);
    const base = (pai?.sku_base as string | null) ?? null;
    // o produto DA variação (o componente do kit): com cores (14/out), cada variação é de um produto diferente
    const comps = (kit ?? []) as { sku_componente: string }[];
    const comp = comps.length === 1 ? comps[0].sku_componente : null;
    const { data: ex, error: e1 } = await supabaseExternal.from("ia_produto_extra").select("sku, foto_ref_path").in("sku", [skuVar, sku, ...(base ? [base] : []), ...(comp ? [comp] : [])]);
    if (e1) return `referência: ${e1.message}`;
    const ref = (x: string) => ((ex ?? []) as { sku: string; foto_ref_path: string | null }[]).find((l) => l.sku === x)?.foto_ref_path ?? null;
    if (ref(skuVar)) return null;
    // variação de um produto DIFERENTE do produto base do pai (outra cor): vale a foto dela, nunca a do pai.
    // Com foto no catálogo, a função de imagem já usa essa foto; sem, a referência do produto da cor.
    if (comp && base && comp !== base) {
      if (prod?.foto_capa) return null;
      const daCor = ref(comp);
      if (!daCor) return null;
      const { error } = await supabaseExternal.from("ia_produto_extra").upsert({ sku: skuVar, foto_ref_path: daCor, fotos_ref: [daCor] }, { onConflict: "sku" });
      return error ? `referência: ${error.message}` : null;
    }
    const herdada = ref(sku) ?? (base ? ref(base) : null);
    if (!herdada) return null; // sem referência no pai: a função tenta a foto do catálogo e, se não houver, avisa
    const { error } = await supabaseExternal.from("ia_produto_extra").upsert({ sku: skuVar, foto_ref_path: herdada, fotos_ref: [herdada] }, { onConflict: "sku" });
    return error ? `referência: ${error.message}` : null;
  }

  /** Uma variação: referência → briefing → prompt → rascunho → fila. Devolve o erro (ou null). */
  async function gerarUma(v: Variacao): Promise<string | null> {
    try {
      marca(v.sku, "foto de referência…");
      const erroRef = await garantirReferencia(v.sku);
      if (erroRef) return erroRef;
      if (!v.temBriefing) {
        if (!briefing) return "gere o texto deste produto antes (o briefing dele é a base das fotos das variações)";
        marca(v.sku, "briefing…");
        const { id: _i, sku: _s, updated_at: _u, ...resto } = briefing as IaBriefing & Record<string, unknown>;
        delete (resto as Record<string, unknown>).created_at;
        const { error } = await supabaseExternal.from("ia_briefing").insert({ ...resto, sku: v.sku });
        if (error && !/duplicate|unique/i.test(error.message)) return `briefing: ${error.message}`;
      }
      marca(v.sku, "escrevendo o prompt…");
      const capa = tipo === COM_SELO
        ? { quantidade: String(v.quantidade), peso: v.pesoUnit, barra: "", faixa: v.rotulo, icones: "", fundo: "", sem_texto: false }
        : { quantidade: String(v.quantidade), peso: v.pesoUnit, barra: "", faixa: "", icones: "", fundo: "", sem_texto: true };
      const rp = await chamarIa("prompts-imagem", { sku: v.sku, canal, fotos: [tipo], forcar: true, capa });
      if (!((rp.prompts_escritos ?? []) as { tipo: string }[]).some((x) => x.tipo === tipo)) {
        return ((rp.pulados ?? []) as { motivo: string }[])[0]?.motivo ?? "o prompt não foi escrito";
      }
      let rascunhoId = v.rascunhoId;
      if (!rascunhoId) {
        marca(v.sku, "criando o rascunho…");
        const { data, error } = await supabaseExternal.rpc("ia_rascunho_criar", { p_sku: v.sku, p_canal: canal, p_empresa: empresa });
        if (error) return `rascunho: ${error.message}`;
        rascunhoId = String(data);
      }
      marca(v.sku, "pondo na fila…");
      const ri = await chamarIa("imagens", { rascunho_id: rascunhoId, fotos: [tipo], modelo: modelo?.id });
      if (!((ri.enfileiradas ?? []) as unknown[]).length) return ((ri.puladas ?? []) as { motivo: string }[])[0]?.motivo ?? "a foto não entrou na fila";
      return null;
    } catch (e) {
      const m = (e as Error).message;
      return /sem foto de refer/i.test(m) ? `${m} — suba a foto real do produto no topo da página (botão Trocar): as variações usam a do produto pai` : m;
    }
    finally { marca(v.sku); }
  }
  async function gerar(alvo: Variacao[]) {
    if (!alvo.length) return;
    const txt = alvo.length === 1 ? `a foto da variação ${alvo[0].rotulo}` : `${alvo.length} fotos (uma por variação)`;
    if (!window.confirm(`Gerar ${txt}? Custo estimado ${custo(alvo.length)}.\n\nCada foto mostra o produto no ambiente de uso, com a quantidade de embalagens da variação${tipo === COM_SELO ? " e um selo só com o peso/quantidade" : ", sem nenhum texto"}.`)) return;
    const falhas: string[] = [];
    for (const v of alvo) {
      const erro = await gerarUma(v);
      if (erro) falhas.push(`${v.rotulo}: ${erro}`);
      void qc.invalidateQueries({ queryKey: chave });
    }
    if (falhas.length) toast.error(`${falhas.length} foto(s) não entraram na fila`, { description: falhas.slice(0, 5).join("\n"), duration: 15000 });
    else toast.success(`${alvo.length} foto(s) na fila`, { description: "Elas aparecem aqui conforme ficam prontas (cerca de 1 minuto cada)." });
  }
  async function aprovar(v: Variacao) {
    if (!v.etapa) return;
    try { await decidirEtapa(v.etapa.id, true); void qc.invalidateQueries({ queryKey: chave }); }
    catch (e) { toast.error("Não consegui aprovar", { description: (e as Error).message }); }
  }
  const ocupado = Object.keys(rodando).length > 0 || copiando;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 basis-[280px]">
            <h2 className="text-base font-semibold flex items-center gap-2"><Images className="h-4 w-4" />Fotos das variações</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Uma foto por variação: o produto no ambiente de uso, sem texto de venda, com a quantidade de embalagens de cada opção.
              A foto fica no anúncio da própria variação (abra a variação para ver o texto e as outras fotos dela).
              Variação que é o mesmo kit de outro anúncio com foto aprovada recebe essa foto sozinha, sem gerar.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={comSelo} disabled={ocupado || !tiposAtivos.includes(COM_SELO)}
              onChange={(e) => setComSelo(e.target.checked)} />
            Selo só com o peso/quantidade da variação (ex.: {vars[Math.min(1, vars.length - 1)].rotulo})
          </label>
          <Button size="sm" className="gap-1.5" disabled={ocupado || !faltam.length || !estiloAtivo} onClick={() => void gerar(faltam)}>
            {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {faltam.length ? `Gerar as ${faltam.length} que faltam · ${custo(faltam.length)}` : "Todas as variações têm foto"}
          </Button>
        </div>
        {!estiloAtivo && <p className="text-xs text-destructive">O estilo de capa ambientada está desativado em IA · Prompts: reative para gerar.</p>}
        {!briefing && vars.some((v) => !v.temBriefing) && (
          <p className="text-xs text-amber-600">Gere antes o texto deste produto: as fotos das variações usam o briefing dele.</p>
        )}

        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          {vars.map((v) => {
            const st = v.etapa?.status;
            const fazendo = rodando[v.sku] ?? (st && ANDANDO.has(st) ? (st === "gerando" ? "gerando…" : "na fila…")
              : copiando && v.gemea && !v.imagem?.storage_path ? `usando a foto do ${v.gemea.sku}…` : "");
            return (
              <div key={v.sku} className="rounded-lg border overflow-hidden bg-card">
                <div className="aspect-square bg-muted/40 flex items-center justify-center relative">
                  {v.url && !fazendo
                    ? <img key={`${v.url}`} src={v.url} alt={v.rotulo} loading="lazy" className="h-full w-full object-cover" />
                    : fazendo
                      ? <div className="text-center text-[11px] text-muted-foreground px-2"><Loader2 className="h-5 w-5 animate-spin mx-auto mb-1" />{fazendo}</div>
                      : <ImageOff className="h-6 w-6 text-muted-foreground" />}
                  {st && !fazendo && (
                    <Badge variant="outline" className={`absolute left-1.5 top-1.5 bg-background/90 text-[10px] py-0 px-1.5 ${ROTULO_ETAPA[st]?.cor ?? ""}`}>
                      {ROTULO_ETAPA[st]?.rotulo ?? st}
                    </Badge>
                  )}
                </div>
                <div className="p-2 space-y-1.5">
                  <div className="text-sm font-medium leading-tight">{v.rotulo}</div>
                  <div className="text-[11px] text-muted-foreground">
                    <Link to="/ia/gerar" search={{ sku: v.sku, canal, empresa }} className="font-mono underline-offset-2 hover:underline">{v.sku}</Link>
                    {" · "}{v.quantidade} {v.quantidade === 1 ? "embalagem" : "embalagens"}
                  </div>
                  {st === "erro" && v.etapa?.erro && <div className="text-[11px] text-destructive line-clamp-2" title={v.etapa.erro}>{v.etapa.erro}</div>}
                  <div className="flex gap-1">
                    {st === "gerado" && (
                      <Button size="sm" variant="default" className="h-7 flex-1 gap-1 px-2 text-[11px]" disabled={ocupado} onClick={() => void aprovar(v)}>
                        <Check className="h-3.5 w-3.5" />Aprovar
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-7 flex-1 gap-1 px-2 text-[11px]" disabled={ocupado || !!fazendo || !estiloAtivo}
                      onClick={() => void gerar([v])}>
                      {v.imagem ? <><RotateCcw className="h-3.5 w-3.5" />Refazer</> : <><Sparkles className="h-3.5 w-3.5" />Gerar</>}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

const chaveKit = (componente: string, quantidade: number | string) => `${componente}|${Number(quantidade)}`;

/** Fotos aprovadas (capa ambientada) dos OUTROS kits com o mesmo produto base e a mesma quantidade — o mesmo kit
 *  usado como variação em outro anúncio. Só kit de UM componente; a foto aprovada mais recente vence. */
async function fotosGemeas(kits: { sku_kit: string; sku_componente: string; quantidade: number }[], meus: string[]): Promise<Map<string, Gemea>> {
  const saida = new Map<string, Gemea>();
  const simples = kits.filter((k) => kits.filter((x) => x.sku_kit === k.sku_kit).length === 1);
  const componentes = [...new Set(simples.map((k) => k.sku_componente))];
  if (!componentes.length) return saida;
  const { data: cand } = await supabaseExternal.from("produto_kits").select("sku_kit, sku_componente, quantidade").in("sku_componente", componentes);
  const outros = ((cand ?? []) as { sku_kit: string; sku_componente: string; quantidade: number }[]).filter((c) => !meus.includes(c.sku_kit));
  if (!outros.length) return saida;
  const skusOutros = [...new Set(outros.map((c) => c.sku_kit))];
  // kit misto (mais de um componente) não serve: a foto mostraria outra coisa
  const { data: todos } = await supabaseExternal.from("produto_kits").select("sku_kit").in("sku_kit", skusOutros);
  const nComp = new Map<string, number>();
  for (const x of (todos ?? []) as { sku_kit: string }[]) nComp.set(x.sku_kit, (nComp.get(x.sku_kit) ?? 0) + 1);
  const validos = outros.filter((c) => nComp.get(c.sku_kit) === 1);
  if (!validos.length) return saida;
  const { data: rs } = await supabaseExternal.from("ia_rascunho").select("id, sku").in("sku", validos.map((c) => c.sku_kit));
  const rasc = (rs ?? []) as { id: string; sku: string }[];
  if (!rasc.length) return saida;
  const { data: im } = await supabaseExternal.from("ia_rascunho_imagem").select("id, rascunho_id, storage_path, gerado_em")
    .in("rascunho_id", rasc.map((r) => r.id)).in("tipo", TIPOS).not("storage_path", "is", null);
  const imgs = (im ?? []) as { id: string; rascunho_id: string; gerado_em: string | null }[];
  if (!imgs.length) return saida;
  const { data: et } = await supabaseExternal.from("ia_etapa").select("imagem_id, status").in("imagem_id", imgs.map((i) => i.id)).eq("status", "aprovado");
  const aprovadas = new Set(((et ?? []) as { imagem_id: string }[]).map((e) => e.imagem_id));
  for (const i of [...imgs].filter((x) => aprovadas.has(x.id)).sort((a, z) => String(z.gerado_em ?? "").localeCompare(String(a.gerado_em ?? "")))) {
    const r = rasc.find((x) => x.id === i.rascunho_id)!;
    const k = validos.find((c) => c.sku_kit === r.sku)!;
    const ch = chaveKit(k.sku_componente, k.quantidade);
    if (!saida.has(ch)) saida.set(ch, { rascunho_id: r.id, imagem_id: i.id, sku: r.sku });
  }
  return saida;
}
