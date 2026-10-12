import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ExternalLink, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatBRL } from "@/lib/format";
import { chamarPublicar, nomeCanal, nomeEmpresa, rotuloFoto, urlsAssinadas, type IaRascunho } from "@/lib/iaAnuncio";

// ============================================================================
// 3 · Enviar anúncio (12/out/2026, pedido do dono): manda o anúncio montado aqui
// DIRETO para o marketplace. Funciona hoje para a SHOPEE e o MERCADO LIVRE
// (edge fn `anuncio-publicar`; o mesmo componente `Envio` serve aos dois), em
// dois modos:
//  - ATUALIZAR um anúncio que já existe (padrão quando o SKU já está anunciado
//    na loja): troca só o que for marcado — título, descrição, fotos, preço.
//    Nas fotos, as atuais do anúncio FICAM por padrão e as novas entram; a
//    pessoa escolhe quais atuais manter, quais novas incluir e a posição;
//  - CRIAR um anúncio novo (nasce fora do ar por padrão; no Mercado Livre é
//    pausado logo depois de criado e a conferência passa pelo validador do ML,
//    com as características obrigatórias da categoria para preencher).
// Sempre: conferência do que será enviado → confirmação → envio.
// Cada cartão de canal mostra se o produto JÁ está anunciado ali (espelhos da
// gestão). Os outros canais aparecem como "em preparação".
// UM ANÚNCIO, VÁRIOS DESTINOS (12/out, pedido do dono): o cartão é o seletor do
// destino (canal + loja). O mesmo rascunho vai para qualquer um deles — a função
// recebe `destino`; não existe mais "abrir o rascunho de <canal>".
// ============================================================================

const DESTINOS: { canal: string; pronto: boolean; nota: string }[] = [
  { canal: "shopee", pronto: true, nota: "Atualiza um anúncio que já existe ou cria um novo, com o texto, o preço e as fotos aprovadas." },
  { canal: "mercado_livre", pronto: true, nota: "Atualiza um anúncio que já existe ou cria um novo; a conferência passa pelo validador do Mercado Livre." },
  { canal: "tiktok", pronto: false, nota: "Em preparação. Precisa enviar as fotos pela API e informar as medidas do pacote." },
  { canal: "amazon", pronto: false, nota: "Em preparação. Cada tipo de produto tem um formulário próprio; entra por último." },
];

interface Existente { item_id: string; nome: string | null; status?: string | null; url?: string | null; variacao?: boolean; model_id?: string | null; nome_variacao?: string | null; preco: number | null; variacoes?: number; vendas?: number; catalogo?: boolean }
interface Existentes {
  shopee: { ottz: Existente[]; svl: Existente[] }; mercado_livre: Existente[]; tiktok: Existente[];
  /** Mercado Livre ao vivo, por conta (null = não deu para consultar). */
  mercado_livre_lojas?: { ottz: Existente[] | null; svl: Existente[] | null };
}
interface Atributo { id: string; nome: string; obrigatorio: boolean; valor: string; opcoes: string[]; dica: string | null }
interface Foto { path: string; tipo: string }
interface Previa {
  loja: string; titulo: string; descricao: string; preco: number | null; sku: string; fotos: Foto[];
  // criar
  estoque?: number; fora_do_ar?: boolean; ean?: string | null;
  medidas?: { peso_kg: number | null; comprimento_cm: number | null; largura_cm: number | null; altura_cm: number | null };
  categoria?: { id: number | string; caminho: string } | null; categorias_sugeridas?: { id: number | string; caminho: string }[];
  marca?: { id: number; nome: string }; logistica?: { id: number; nome: string }[];
  // criar · Mercado Livre
  tipo_anuncio?: string; tipos_anuncio?: { id: string; nome: string }[]; atributos?: Atributo[];
  /** limites do marketplace/categoria (sem isso valem os da Shopee: 120 e 9) */
  limites?: { titulo: number; fotos: number };
  // atualizar
  alvo?: Existente & { n_variacoes: number; situacao: string | null };
  campos?: { titulo: boolean; descricao: boolean; fotos: boolean; preco: boolean };
  atual?: { titulo: string; descricao: string; fotos: { id: string; url: string }[]; preco: number | null };
  fotos_plano?: { manter: string[]; novas: string[]; posicao: "inicio" | "fim" };
}
interface Publicacao { id: string; canal: string; empresa: string; operacao: string; estado: string; item_id: string | null; url: string | null; fora_do_ar: boolean | null; erro: string | null; criado_por_nome: string | null; criado_em: string }
interface Resposta { ok: boolean; disponivel: boolean; motivo?: string; modo?: "criar" | "atualizar"; existentes?: Existente[]; previa?: Previa; pendencias?: string[]; avisos?: string[]; publicacoes?: Publicacao[] }
type Op = Record<string, string | boolean>;

const txt = (v: number | null | undefined) => (v == null ? "" : String(v).replace(".", ","));
// no Mercado Livre o título começa desmarcado: o ML recusa a troca em anúncio que já vendeu
const opInicial = (canal: string): Op => ({ fora_do_ar: true, c_titulo: canal !== "mercado_livre", c_descricao: true, c_fotos: true, c_preco: false });
const situacao = (st?: string | null) => (!st || st === "NORMAL" || st === "active" ? "" : st === "UNLIST" ? "fora do ar" : st === "paused" ? "pausado" : st);

/** Lojas de cada marketplace: o destino do envio é sempre canal + empresa. */
const LOJAS: Record<string, { rotulo: string; empresa: string }[]> = {
  shopee: [{ rotulo: "Ottz", empresa: "ottz" }, { rotulo: "Bumi", empresa: "svl" }],
  mercado_livre: [{ rotulo: "Ottz", empresa: "ottz" }, { rotulo: "SVL", empresa: "svl" }],
  tiktok: [{ rotulo: "ACZ", empresa: "ottz" }],
};

export function Publicar({ rascunho, canal, empresa, onDestino }: {
  rascunho: IaRascunho; canal: string; empresa: string; onDestino: (canal: string, empresa: string) => void;
}) {
  const exQ = useQuery({
    queryKey: ["ia-anuncio", "existentes", rascunho.sku],
    staleTime: 5 * 60_000,
    queryFn: async () => (await chamarPublicar("existentes", { sku: rascunho.sku })).existentes as Existentes,
  });
  const ex = exQ.data;
  /** Anúncios que já existem naquela loja (undefined = ainda lendo; null = não deu para consultar). */
  const listaDe = (c: string, e: string): Existente[] | null | undefined => {
    if (!ex) return undefined;
    if (c === "shopee") return e === "svl" ? ex.shopee.svl : ex.shopee.ottz;
    if (c === "mercado_livre") return ex.mercado_livre_lojas ? (e === "svl" ? ex.mercado_livre_lojas.svl : ex.mercado_livre_lojas.ottz) : (e === "svl" ? null : ex.mercado_livre);
    if (c === "tiktok") return ex.tiktok;
    return undefined;
  };
  const pronto = DESTINOS.find((d) => d.canal === canal)?.pronto === true;
  return (
    <Card><CardContent className="p-5 space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">3 · Enviar anúncio</h3>
        <span className="text-xs text-muted-foreground">o mesmo texto e as mesmas fotos servem a todos: escolha para onde enviar; a conferência vem antes</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {DESTINOS.map((d) => {
          const atual = d.canal === canal;
          const lojas = LOJAS[d.canal] ?? [];
          return (
            <div key={d.canal} className={`rounded-md border p-3 space-y-1.5 ${atual ? "border-primary/60 bg-primary/5" : ""}`}>
              <div className="flex items-center gap-1.5">
                <b className="text-sm">{nomeCanal(d.canal)}</b>
                {d.pronto ? <Badge className="text-[10px] py-0 px-1.5">disponível</Badge> : <Badge variant="secondary" className="text-[10px] py-0 px-1.5">em preparação</Badge>}
              </div>
              <div className="text-[11px] leading-snug space-y-0.5">
                {d.canal === "amazon" ? <span className="text-muted-foreground">anúncios da Amazon ainda não são lidos pela gestão</span>
                  : lojas.map((l) => {
                    const lista = listaDe(d.canal, l.empresa);
                    const escolhida = atual && l.empresa === empresa;
                    return (
                      <div key={l.rotulo} className="flex items-center gap-1.5 min-h-[26px]">
                        <div className="min-w-0 flex-1">
                          <span className="text-muted-foreground">{l.rotulo}: </span>
                          {exQ.isLoading ? <span className="text-muted-foreground">verificando…</span>
                            : exQ.isError || lista == null ? <span className="text-muted-foreground">não consegui verificar</span>
                            : lista.length === 0 ? <span>ainda não anunciado</span> : (
                            <span className="font-medium text-emerald-700 dark:text-emerald-400">
                              já anunciado{lista.length > 1 ? ` (${lista.length})` : ""}
                              {lista.slice(0, 2).map((e) => e.url && (
                                <a key={e.item_id} href={e.url} target="_blank" rel="noreferrer" className="ml-1 underline font-normal inline-flex items-center gap-0.5">ver<ExternalLink className="h-2.5 w-2.5" /></a>
                              ))}
                            </span>
                          )}
                        </div>
                        {d.pronto && (
                          <Button size="sm" variant={escolhida ? "default" : "outline"} className="h-6 px-2 text-[11px] shrink-0"
                            onClick={() => onDestino(d.canal, l.empresa)}>{escolhida ? "escolhido" : "enviar para cá"}</Button>
                        )}
                      </div>
                    );
                  })}
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">{d.nota}</p>
            </div>
          );
        })}
      </div>
      {pronto
        ? <Envio key={`${rascunho.id}-${canal}-${empresa}`} rascunho={rascunho} canal={canal} empresa={empresa} jaExiste={listaDe(canal, empresa) ?? null} />
        : <p className="text-sm text-muted-foreground">O envio direto de {nomeCanal(canal)} ainda não está pronto: escolha a Shopee ou o Mercado Livre nos cartões acima. O texto e as fotos aprovadas daqui podem ser copiados para o anúncio.</p>}
    </CardContent></Card>
  );
}

/** Conferência + envio (Shopee e Mercado Livre: mesma tela, textos e campos mudam pelo canal). */
function Envio({ rascunho, canal, empresa, jaExiste }: { rascunho: IaRascunho; canal: string; empresa: string; jaExiste: Existente[] | null }) {
  const qc = useQueryClient();
  // o destino vai em toda chamada: o mesmo rascunho serve a qualquer marketplace/loja
  const destino = { canal, empresa };
  const ml = canal === "mercado_livre";
  const MK = ml ? "Mercado Livre" : "Shopee";
  const NO = ml ? "no" : "na"; const ART = ml ? "o" : "a";
  const [aberto, setAberto] = useState(false);
  // o que a pessoa ajustou na conferência (vazio = o que a função sugerir)
  const [op, setOp] = useState<Op>(() => opInicial(canal));
  const [aplicado, setAplicado] = useState<Op>(() => opInicial(canal));
  const [enviando, setEnviando] = useState(false);
  const [deNovo, setDeNovo] = useState(false);
  useEffect(() => { const i = opInicial(canal); setAberto(false); setOp(i); setAplicado(i); setDeNovo(false); }, [rascunho.id, canal, empresa]);

  const previaQ = useQuery({
    queryKey: ["ia-anuncio", "publicar", rascunho.id, canal, empresa, rascunho.updated_at, JSON.stringify(aplicado)],
    enabled: aberto,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<Resposta> => (await chamarPublicar("previa", { rascunho_id: rascunho.id, destino, opcoes: limpar(aplicado) })) as Resposta,
  });
  const d = previaQ.data;
  const p = d?.previa;
  const modo = d?.modo ?? "criar";
  const limTitulo = p?.limites?.titulo ?? 120;
  const limFotos = p?.limites?.fotos ?? 9;
  const fotosQ = useQuery({
    queryKey: ["ia-anuncio", "publicar-fotos", (p?.fotos ?? []).map((f) => f.path).join("|")],
    enabled: !!p?.fotos.length,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas((p?.fotos ?? []).map((f) => f.path)),
  });
  // escolha de fotos no modo atualizar: mora em op (f_manter / f_novas / f_pos); sem escolha = o padrão da função
  const lista = (k: string, padrao: string[]) => (typeof op[k] === "string" ? String(op[k]).split("|").filter(Boolean) : padrao);
  const manter = lista("f_manter", p?.fotos_plano?.manter ?? []);
  const novas = lista("f_novas", p?.fotos_plano?.novas ?? []);
  const posicao = op.f_pos === "inicio" || op.f_pos === "fim" ? op.f_pos : (p?.fotos_plano?.posicao ?? "fim");
  const chaveFotos = (o: Op) => `${o.f_manter ?? "~"}#${o.f_novas ?? "~"}#${o.f_pos ?? "~"}`;
  // a conferência é refeita sozinha, pouco depois do último clique nas fotos
  useEffect(() => {
    if (chaveFotos(op) === chaveFotos(aplicado)) return;
    const t = setTimeout(() => setAplicado((a) => {
      const n: Op = { ...a };
      for (const k of ["f_manter", "f_novas", "f_pos"]) { if (op[k] === undefined) delete n[k]; else n[k] = op[k]; }
      return n;
    }), 700);
    return () => clearTimeout(t);
  }, [op.f_manter, op.f_novas, op.f_pos]);
  /** Marca/desmarca uma foto mantendo a ordem da lista de origem. */
  const alternarFoto = (k: "f_manter" | "f_novas", id: string, marcadas: string[], origem: string[]) =>
    setOp({ ...op, [k]: origem.filter((x) => marcadas.includes(x) !== (x === id)).join("|") });
  const campo = (k: string, padrao: number | null | undefined) => (typeof op[k] === "string" ? String(op[k]) : txt(padrao));
  const mudou = JSON.stringify(op) !== JSON.stringify(aplicado);
  // trocar de modo ou de anúncio refaz a conferência na hora (são leituras diferentes na Shopee)
  const trocar = (x: Op) => { const n = { ...op, ...x }; setOp(n); setAplicado(n); };
  const criado = (d?.publicacoes ?? []).find((x) => x.estado === "publicado" && x.operacao !== "atualizar" && x.canal === canal && x.empresa === empresa);
  const existentes = d?.existentes ?? jaExiste ?? [];

  async function enviar() {
    if (!p) return;
    const c = p.campos;
    const aviso = modo === "atualizar" ? [
      `Atualizar o anúncio ${p.alvo?.item_id} ${NO} ${p.loja}?`, "",
      `Vai trocar: ${[c?.titulo ? "título" : "", c?.descricao ? "descrição" : "", c?.fotos ? `fotos (ficam ${manter.length} das atuais + ${novas.length} nova(s))` : "", c?.preco ? `preço (${p.preco != null ? formatBRL(p.preco) : "—"})` : ""].filter(Boolean).join(", ")}.`,
      (p.alvo?.n_variacoes ?? 0) > 0 ? `O anúncio tem ${p.alvo?.n_variacoes} variações: título, descrição e fotos valem para todas.` : "",
      "O anúncio está no ar: a mudança aparece para os compradores na hora.",
    ].filter(Boolean).join("\n") : [
      `Criar o anúncio ${NO} ${p.loja}?`, "",
      `${p.titulo}`, `Preço: ${p.preco != null ? formatBRL(p.preco) : "—"} · Estoque inicial: ${p.estoque} · ${p.fotos.length} foto(s)`,
      p.fora_do_ar
        ? (ml ? "Vai ser PAUSADO logo depois de criado. Você reativa depois no Mercado Livre." : "Vai nascer FORA DO AR (não listado). Você ativa depois no Seller Center.")
        : "Vai nascer NO AR, visível para os compradores.",
    ].join("\n");
    if (!window.confirm(aviso)) return;
    setEnviando(true);
    try {
      const r = await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino, opcoes: { ...limpar(aplicado), modo, de_novo: deNovo }, confirmar: true });
      if (modo === "atualizar") toast.success(`Anúncio atualizado ${NO} ${MK}`, { description: `Código ${r.item_id} · ${(r.atualizados ?? []).join(", ")}` });
      else toast.success(`Anúncio criado ${NO} ${MK}`, { description: `Código ${r.item_id}${r.fora_do_ar ? (ml ? " · pausado" : " · fora do ar") : ""}${r.titulo_final ? ` · ${r.titulo_final}` : ""}` });
      // o que deu certo pela metade (ex.: criado mas não pausou) não pode passar batido
      for (const av of ((r.avisos ?? []) as string[]).filter((x) => /^(ATENÇÃO|o anúncio foi criado, mas)/.test(x))) toast.warning(av, { duration: 30000 });
      setDeNovo(false);
    } catch (e) {
      toast.error(`${ml ? "O" : "A"} ${MK} não aceitou ${modo === "atualizar" ? "a atualização" : "o anúncio"}`, { description: (e as Error).message, duration: 15000 });
    } finally {
      setEnviando(false);
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    }
  }

  if (!aberto) {
    const n = jaExiste?.length ?? 0;
    return (
      <div className="space-y-2">
        {jaExiste && (
          <div className={`rounded-md border px-3 py-2 text-sm ${n ? "border-emerald-500/40 bg-emerald-500/5" : ""}`}>
            {n === 0
              ? <>Este produto <b>ainda não tem anúncio</b> {NO} {MK} {nomeEmpresa(empresa)}: o envio cria um anúncio novo.</>
              : <>Este produto <b>já tem {n === 1 ? "um anúncio" : `${n} anúncios`}</b> {NO} {MK} {nomeEmpresa(empresa)}: o padrão é <b>atualizar</b> o que existe, sem criar duplicado.</>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="gap-1.5" onClick={() => setAberto(true)}><Send className="h-4 w-4" />Conferir e enviar para {ART} {MK} ({nomeEmpresa(empresa)})</Button>
          <span className="text-xs text-muted-foreground">Abre a conferência; nada é enviado antes de você confirmar.</span>
        </div>
      </div>
    );
  }
  if (previaQ.isLoading) return <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Montando a conferência (lendo {ART} {MK})…</div>;
  if (previaQ.isError) return (
    <div className="space-y-2">
      <p className="text-sm text-destructive">Falha ao montar a conferência: {(previaQ.error as Error).message}</p>
      <Button size="sm" variant="outline" onClick={() => trocar({ modo: "criar" })}>tentar como anúncio novo</Button>
    </div>
  );
  if (!p) return <p className="text-sm text-muted-foreground">{d?.motivo ?? "Sem dados."}</p>;

  const pend = d?.pendencias ?? []; const avisos = d?.avisos ?? [];
  return (
    <div className="space-y-3">
      {/* existe ou não + escolha do que fazer */}
      <div className="rounded-md border p-3 space-y-2 text-sm">
        <div>
          {existentes.length === 0
            ? <>Este produto <b>ainda não tem anúncio</b> {NO} {p.loja}.</>
            : <>Este produto <b>já tem {existentes.length === 1 ? "um anúncio" : `${existentes.length} anúncios`}</b> {NO} {p.loja}.</>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={modo === "atualizar" ? "default" : "outline"} disabled={existentes.length === 0 || previaQ.isFetching}
            onClick={() => trocar({ modo: "atualizar" })}>Atualizar anúncio existente</Button>
          <Button size="sm" variant={modo === "criar" ? "default" : "outline"} disabled={previaQ.isFetching} onClick={() => trocar({ modo: "criar" })}>Criar anúncio novo</Button>
          {previaQ.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground self-center" />}
        </div>
        {modo === "atualizar" && existentes.length > 0 && (
          <div className="space-y-1">
            {existentes.map((e) => {
              const sel = p.alvo?.item_id === e.item_id;
              return (
                <label key={e.item_id} className={`flex items-start gap-2 rounded border px-2 py-1.5 cursor-pointer ${sel ? "border-primary/60 bg-primary/5" : ""}`}>
                  <input type="radio" className="mt-1" checked={sel} disabled={previaQ.isFetching} onChange={() => { const n: Op = { ...op, modo: "atualizar", item_id: e.item_id }; delete n.f_manter; delete n.f_novas; delete n.f_pos; setOp(n); setAplicado(n); }} />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block truncate text-sm">{e.nome ?? e.item_id}</span>
                    <span className="text-muted-foreground">
                      código {e.item_id}
                      {e.variacao ? <> · este SKU é a variação <b>{e.nome_variacao || e.model_id}</b> do anúncio</> : ml ? "" : " · anúncio só deste SKU"}
                      {e.preco != null && <> · {formatBRL(e.preco)}</>}
                      {e.vendas != null && <> · {e.vendas.toLocaleString("pt-BR")} venda{e.vendas === 1 ? "" : "s"}</>}
                      {e.catalogo && <> · catálogo</>}
                      {situacao(e.status) && <> · {situacao(e.status)}</>}
                    </span>
                  </span>
                  {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="text-xs underline inline-flex items-center gap-0.5 shrink-0">abrir<ExternalLink className="h-3 w-3" /></a>}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {modo === "atualizar" && p.atual && p.campos ? (
        <div className="rounded-md border p-3 space-y-3">
          <p className="text-[11px] text-muted-foreground">Marque o que quer trocar no anúncio. O que ficar desmarcado continua como está.</p>
          <Troca rotulo="Título" marcado={op.c_titulo === true} onMarcar={(v) => trocar({ c_titulo: v })}
            antes={p.atual.titulo} depois={`${p.titulo} (${p.titulo.length}/${limTitulo})`}
            nota={ml ? "Desmarcado por padrão: o Mercado Livre só deixa trocar o título de anúncio que ainda não vendeu." : undefined} />
          <Troca rotulo="Descrição" marcado={op.c_descricao !== false} onMarcar={(v) => trocar({ c_descricao: v })}
            antes={resumo(p.atual.descricao)} depois={resumo(p.descricao)} />
          <div className="flex items-start gap-2">
            <Checkbox className="mt-1" checked={op.c_fotos !== false} onCheckedChange={(v) => trocar({ c_fotos: v === true })} />
            <div className={`min-w-0 flex-1 space-y-2 ${op.c_fotos !== false ? "" : "opacity-60 pointer-events-none"}`}>
              <b className="text-sm">Fotos</b>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Do anúncio hoje · clique para manter ou tirar</div>
                <Selecao itens={p.atual.fotos.map((f) => ({ id: f.id, url: f.url }))} marcados={manter} fora="sai"
                  onAlternar={(id) => alternarFoto("f_manter", id, manter, p.atual!.fotos.map((f) => f.id))} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Novas, aprovadas aqui · clique para incluir ou não</div>
                <Selecao itens={p.fotos.map((f) => ({ id: f.path, url: fotosQ.data?.[f.path] ?? "", legenda: rotuloFoto(f.tipo) }))} marcados={novas} fora="não entra"
                  onAlternar={(id) => alternarFoto("f_novas", id, novas, p.fotos.map((f) => f.path))} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">As novas entram:</span>
                <Button size="sm" variant={posicao === "inicio" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => setOp({ ...op, f_pos: "inicio" })}>no início (a 1ª vira a capa)</Button>
                <Button size="sm" variant={posicao === "fim" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => setOp({ ...op, f_pos: "fim" })}>no fim</Button>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Vai ficar com {manter.length + novas.length} de {limFotos} fotos ({manter.length} das atuais + {novas.length} nova{novas.length === 1 ? "" : "s"})
                </div>
                <Miniaturas urls={(() => {
                  const n = p.fotos.filter((f) => novas.includes(f.path)).map((f) => fotosQ.data?.[f.path] ?? "");
                  const m = p.atual!.fotos.filter((f) => manter.includes(f.id)).map((f) => f.url);
                  return posicao === "inicio" ? [...n, ...m] : [...m, ...n];
                })()} max={limFotos} />
              </div>
            </div>
          </div>
          <Troca rotulo="Preço" marcado={op.c_preco === true} onMarcar={(v) => trocar({ c_preco: v })}
            antes={p.atual.preco != null ? formatBRL(p.atual.preco) : "—"} depois={p.preco != null ? formatBRL(p.preco) : "—"}
            nota="Desmarcado por padrão: mexer no preço pode afetar promoção em andamento." />
        </div>
      ) : (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm"><b>{p.loja}</b><span className="text-muted-foreground">SKU {p.sku} · anúncio novo</span></div>
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Linha rotulo="Título" valor={`${p.titulo} (${p.titulo.length}/${limTitulo})`} />
            <Linha rotulo="Preço" valor={p.preco != null ? formatBRL(p.preco) : "—"} />
            {p.marca && <Linha rotulo="Marca" valor={p.marca.nome} />}
            <Linha rotulo="Código de barras" valor={p.ean ?? (ml ? "sem código — vai como \"produto sem código cadastrado\"" : "sem código no Tiny")} />
            {p.logistica && <Linha rotulo="Canais de envio" valor={p.logistica.map((l) => l.nome).join(", ") || "—"} />}
            {ml && <Linha rotulo="Envio" valor="Mercado Envios, sem retirada em mãos" />}
            <Linha rotulo="Descrição" valor={`${p.descricao.length.toLocaleString("pt-BR")} caracteres (texto + bullets)`} />
          </div>
          <Miniaturas urls={p.fotos.map((f) => fotosQ.data?.[f.path] ?? "")} legendas={p.fotos.map((f, i) => `${i + 1}. ${rotuloFoto(f.tipo)}`)} max={limFotos} />
          <div className="flex flex-wrap items-end gap-3 text-sm border-t pt-3">
            <label className="block min-w-[260px] flex-1">
              <span className="text-[11px] text-muted-foreground">Categoria {NO} {MK}</span>
              {/* no Mercado Livre a categoria muda as características pedidas: a conferência é refeita na hora */}
              <select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
                value={String(op.categoria_id ?? p.categoria?.id ?? "")} onChange={(e) => (ml ? trocar({ categoria_id: e.target.value }) : setOp({ ...op, categoria_id: e.target.value }))}>
                {(p.categorias_sugeridas ?? []).length === 0 && <option value="">nenhuma sugestão</option>}
                {(p.categorias_sugeridas ?? []).map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}
                {p.categoria && !(p.categorias_sugeridas ?? []).some((c) => c.id === p.categoria!.id) && <option value={p.categoria.id}>{p.categoria.caminho || p.categoria.id}</option>}
              </select>
            </label>
            <Medida rotulo="Peso (kg)" valor={campo("peso_kg", p.medidas?.peso_kg)} onChange={(v) => setOp({ ...op, peso_kg: v })} />
            <Medida rotulo="Compr. (cm)" valor={campo("comprimento_cm", p.medidas?.comprimento_cm)} onChange={(v) => setOp({ ...op, comprimento_cm: v })} />
            <Medida rotulo="Largura (cm)" valor={campo("largura_cm", p.medidas?.largura_cm)} onChange={(v) => setOp({ ...op, largura_cm: v })} />
            <Medida rotulo="Altura (cm)" valor={campo("altura_cm", p.medidas?.altura_cm)} onChange={(v) => setOp({ ...op, altura_cm: v })} />
            <Medida rotulo="Estoque inicial" valor={campo("estoque", p.estoque)} onChange={(v) => setOp({ ...op, estoque: v })} />
            {ml && (
              <label className="block">
                <span className="text-[11px] text-muted-foreground">Tipo de anúncio</span>
                <select className="mt-1 h-8 block rounded-md border bg-background px-2 text-xs"
                  value={String(op.tipo_anuncio ?? p.tipo_anuncio ?? "")} onChange={(e) => setOp({ ...op, tipo_anuncio: e.target.value })}>
                  {(p.tipos_anuncio ?? []).map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
                </select>
              </label>
            )}
            {ml && <Medida rotulo="Código de barras" largo valor={typeof op.gtin === "string" ? op.gtin : (p.ean ?? "")} onChange={(v) => setOp({ ...op, gtin: v })} />}
          </div>
          {ml && (p.atributos ?? []).length > 0 && (
            <div className="border-t pt-3 space-y-2">
              <div className="text-[11px] text-muted-foreground">Características que o Mercado Livre pede nesta categoria (as com * são obrigatórias; as outras melhoram a ficha)</div>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {(p.atributos ?? []).map((a) => (
                  <label key={a.id} className="block min-w-0">
                    <span className="text-[11px] text-muted-foreground">{a.nome}{a.obrigatorio ? " *" : ""}</span>
                    <Input className="h-8 mt-1 text-xs" list={a.opcoes.length ? `ml-at-${a.id}` : undefined} placeholder={a.dica ?? ""}
                      value={typeof op[`a_${a.id}`] === "string" ? String(op[`a_${a.id}`]) : a.valor}
                      onChange={(e) => setOp({ ...op, [`a_${a.id}`]: e.target.value })} />
                    {a.opcoes.length > 0 && <datalist id={`ml-at-${a.id}`}>{a.opcoes.map((o) => <option key={o} value={o} />)}</datalist>}
                  </label>
                ))}
              </div>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox className="mt-0.5" checked={op.fora_do_ar !== false} onCheckedChange={(v) => setOp({ ...op, fora_do_ar: v === true })} />
            <span>
              {ml ? <>Criar e <b>pausar</b> em seguida</> : <>Criar <b>fora do ar</b> (não listado)</>}
              <span className="block text-[11px] text-muted-foreground">Recomendado: confira no Tiny se o anúncio foi ligado ao produto pelo SKU (é o que faz estoque e pedido funcionarem) e {ml ? "reative depois no Mercado Livre" : "ative depois no Seller Center"}.</span>
            </span>
          </label>
          {mudou && <Button size="sm" variant="outline" onClick={() => setAplicado(op)}>Atualizar a conferência com o que mudei</Button>}
        </div>
      )}

      {pend.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-1">
          <b className="text-destructive flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Falta resolver antes de enviar</b>
          {pend.map((x) => <div key={x}>• {x}</div>)}
        </div>
      )}
      {avisos.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs space-y-1 text-amber-700 dark:text-amber-400">
          {avisos.map((x) => <div key={x}>• {x}</div>)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button className="gap-1.5" disabled={enviando || mudou || previaQ.isFetching || pend.length > 0 || (modo === "criar" && !!criado && !deNovo)} onClick={() => void enviar()}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {enviando ? `Enviando para ${ART} ${MK}…` : modo === "atualizar" ? `Atualizar o anúncio ${NO} ${MK}` : `Criar o anúncio ${NO} ${MK}`}
        </Button>
        {modo === "criar" && criado && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={deNovo} onCheckedChange={(v) => setDeNovo(v === true)} />este rascunho já criou um anúncio; criar outro mesmo assim
          </label>
        )}
        {mudou && <span className="text-xs text-muted-foreground">{modo === "atualizar" ? "Refazendo a conferência…" : "Atualize a conferência antes de enviar."}</span>}
      </div>

      {(d?.publicacoes ?? []).length > 0 && (
        <div className="rounded-md border divide-y text-xs">
          {(d?.publicacoes ?? []).map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              {x.estado === "publicado" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : x.estado === "erro" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{new Date(x.criado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              {x.criado_por_nome && <span className="text-muted-foreground">{x.criado_por_nome}</span>}
              <span className="font-medium">{nomeCanal(x.canal)} {nomeEmpresa(x.empresa)}</span>
              {x.estado === "publicado" && <span>{x.operacao === "atualizar" ? "atualizou o anúncio" : "criou o anúncio"} <b className="font-mono">{x.item_id}</b>{x.fora_do_ar ? (x.canal === "mercado_livre" ? " · pausado" : " · fora do ar") : ""}</span>}
              {x.url && <a href={x.url} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">abrir<ExternalLink className="h-3 w-3" /></a>}
              {x.estado === "erro" && <span className="text-destructive">{x.operacao === "atualizar" ? "atualização" : "criação"} recusada: {x.erro}</span>}
              {x.estado === "enviando" && <span className="text-muted-foreground">envio em andamento</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Monta as opções da função: tira os vazios, troca vírgula por ponto e junta os c_* em `campos`. */
function limpar(op: Op): Record<string, unknown> {
  const out: Record<string, unknown> = {}; const campos: Record<string, boolean> = {};
  const fotos: Record<string, unknown> = {}; const atributos: Record<string, string> = {};
  for (const [k, v] of Object.entries(op)) {
    if (k.startsWith("c_")) { campos[k.slice(2)] = v === true; continue; }
    if (k.startsWith("a_")) { if (String(v).trim()) atributos[k.slice(2)] = String(v).trim(); continue; }
    if (k === "f_manter" || k === "f_novas") { fotos[k.slice(2)] = String(v).split("|").filter(Boolean); continue; }
    if (k === "f_pos") { fotos.posicao = v; continue; }
    if (typeof v === "boolean") out[k] = v;
    else if (v.trim() !== "") out[k] = v.trim().replace(",", ".");
  }
  out.campos = campos;
  if (Object.keys(fotos).length) out.fotos = fotos;
  if (Object.keys(atributos).length) out.atributos = atributos;
  return out;
}
const resumo = (t: string) => `${t.length.toLocaleString("pt-BR")} caracteres · ${t.replace(/\s+/g, " ").slice(0, 150)}${t.length > 150 ? "…" : ""}`;

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return <div className="min-w-0"><span className="text-[11px] text-muted-foreground block">{rotulo}</span><span className="break-words">{valor}</span></div>;
}
function Medida({ rotulo, valor, onChange, largo }: { rotulo: string; valor: string; onChange: (v: string) => void; largo?: boolean }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{rotulo}</span>
      <Input className={`h-8 mt-1 font-mono ${largo ? "w-40" : "w-24"}`} value={valor} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
/** Uma linha "antes → depois" com a caixa que decide se o campo é atualizado. */
function Troca({ rotulo, marcado, onMarcar, antes, depois, nota }: { rotulo: string; marcado: boolean; onMarcar: (v: boolean) => void; antes: string; depois: string; nota?: string }) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox className="mt-1" checked={marcado} onCheckedChange={(v) => onMarcar(v === true)} />
      <div className={`min-w-0 flex-1 text-sm ${marcado ? "" : "opacity-60"}`}>
        <b>{rotulo}</b>
        <div className="grid md:grid-cols-[1fr_auto_1fr] gap-x-2 gap-y-0.5 items-start">
          <span className="text-muted-foreground break-words"><span className="text-[10px] uppercase tracking-wide block">hoje</span>{antes || "—"}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground mt-4 hidden md:block" />
          <span className="break-words"><span className="text-[10px] uppercase tracking-wide block text-muted-foreground">{marcado ? "vai ficar" : "novo (não será enviado)"}</span>{depois || "—"}</span>
        </div>
        {nota && <p className="text-[11px] text-muted-foreground mt-0.5">{nota}</p>}
      </div>
    </div>
  );
}
/** Fotos clicáveis: marcada = fica/entra; desmarcada = fica apagada com o rótulo `fora`. */
function Selecao({ itens, marcados, fora, onAlternar }: {
  itens: { id: string; url: string; legenda?: string }[]; marcados: string[]; fora: string; onAlternar: (id: string) => void;
}) {
  if (!itens.length) return <span className="text-xs text-muted-foreground">nenhuma foto</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {itens.map((f) => {
        const on = marcados.includes(f.id);
        return (
          <button key={f.id} type="button" onClick={() => onAlternar(f.id)} className="w-16 text-left" title={on ? "clique para tirar" : "clique para incluir"}>
            <div className={`relative h-16 w-16 rounded border-2 overflow-hidden bg-muted/30 ${on ? "border-primary" : "border-dashed border-muted-foreground/40"}`}>
              {f.url && <img src={f.url} alt="" loading="lazy" className={`h-full w-full object-cover ${on ? "" : "opacity-30 grayscale"}`} />}
              <span className={`absolute top-0.5 right-0.5 h-4 w-4 rounded-full flex items-center justify-center ${on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {on ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
              </span>
            </div>
            <div className="text-[9.5px] truncate capitalize text-muted-foreground">{on ? (f.legenda ?? "fica") : fora}</div>
          </button>
        );
      })}
    </div>
  );
}
function Miniaturas({ urls, legendas, max = 9 }: { urls: string[]; legendas?: string[]; max?: number }) {
  if (!urls.length) return <span className="text-xs text-muted-foreground">nenhuma foto</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {urls.slice(0, max).map((u, i) => (
        <div key={`${u}-${i}`} className="w-14">
          <div className="h-14 w-14 rounded border bg-muted/30 overflow-hidden">{u && <img src={u} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
          {legendas?.[i] && <div className="text-[9.5px] text-muted-foreground truncate capitalize" title={legendas[i]}>{legendas[i]}</div>}
        </div>
      ))}
    </div>
  );
}
