import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Loader2, Send } from "lucide-react";
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
// DIRETO para o marketplace. Funciona hoje para a SHOPEE (edge fn
// `anuncio-publicar`), em dois modos:
//  - ATUALIZAR um anúncio que já existe (padrão quando o SKU já está anunciado
//    na loja): troca só o que for marcado — título, descrição, fotos, preço;
//  - CRIAR um anúncio novo (nasce fora do ar por padrão).
// Sempre: conferência do que será enviado → confirmação → envio.
// Cada cartão de canal mostra se o produto JÁ está anunciado ali (espelhos da
// gestão). Os outros canais aparecem como "em preparação".
// ============================================================================

const DESTINOS: { canal: string; pronto: boolean; nota: string }[] = [
  { canal: "shopee", pronto: true, nota: "Atualiza um anúncio que já existe ou cria um novo, com o texto, o preço e as fotos aprovadas." },
  { canal: "mercado_livre", pronto: false, nota: "Em preparação. O app já tem permissão; falta montar o envio." },
  { canal: "tiktok", pronto: false, nota: "Em preparação. Precisa enviar as fotos pela API e informar as medidas do pacote." },
  { canal: "amazon", pronto: false, nota: "Em preparação. Cada tipo de produto tem um formulário próprio; entra por último." },
];

interface Existente { item_id: string; nome: string | null; status?: string | null; url?: string | null; variacao?: boolean; model_id?: string | null; nome_variacao?: string | null; preco: number | null; variacoes?: number }
interface Existentes { shopee: { ottz: Existente[]; svl: Existente[] }; mercado_livre: Existente[]; tiktok: Existente[] }
interface Foto { path: string; tipo: string }
interface Previa {
  loja: string; titulo: string; descricao: string; preco: number | null; sku: string; fotos: Foto[];
  // criar
  estoque?: number; fora_do_ar?: boolean; ean?: string | null;
  medidas?: { peso_kg: number | null; comprimento_cm: number | null; largura_cm: number | null; altura_cm: number | null };
  categoria?: { id: number; caminho: string } | null; categorias_sugeridas?: { id: number; caminho: string }[];
  marca?: { id: number; nome: string }; logistica?: { id: number; nome: string }[];
  // atualizar
  alvo?: Existente & { n_variacoes: number; situacao: string | null };
  campos?: { titulo: boolean; descricao: boolean; fotos: boolean; preco: boolean };
  atual?: { titulo: string; descricao: string; fotos: string[]; preco: number | null };
}
interface Publicacao { id: string; canal: string; empresa: string; operacao: string; estado: string; item_id: string | null; url: string | null; fora_do_ar: boolean | null; erro: string | null; criado_por_nome: string | null; criado_em: string }
interface Resposta { ok: boolean; disponivel: boolean; motivo?: string; modo?: "criar" | "atualizar"; existentes?: Existente[]; previa?: Previa; pendencias?: string[]; avisos?: string[]; publicacoes?: Publicacao[] }
type Op = Record<string, string | boolean>;

const txt = (v: number | null | undefined) => (v == null ? "" : String(v).replace(".", ","));
const OP_INICIAL: Op = { fora_do_ar: true, c_titulo: true, c_descricao: true, c_fotos: true, c_preco: false };

export function Publicar({ rascunho, onCanal }: { rascunho: IaRascunho; onCanal: (canal: string) => void }) {
  const exQ = useQuery({
    queryKey: ["ia-anuncio", "existentes", rascunho.sku],
    staleTime: 5 * 60_000,
    queryFn: async () => (await chamarPublicar("existentes", { sku: rascunho.sku })).existentes as Existentes,
  });
  const ex = exQ.data;
  const doCanal = (canal: string): { rotulo: string; lista: Existente[] }[] => {
    if (!ex) return [];
    if (canal === "shopee") return [{ rotulo: "Ottz", lista: ex.shopee.ottz }, { rotulo: "Bumi", lista: ex.shopee.svl }];
    if (canal === "mercado_livre") return [{ rotulo: "Ottz", lista: ex.mercado_livre }];
    if (canal === "tiktok") return [{ rotulo: "ACZ", lista: ex.tiktok }];
    return [];
  };
  return (
    <Card><CardContent className="p-5 space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">3 · Enviar anúncio</h3>
        <span className="text-xs text-muted-foreground">direto para o marketplace, sempre com conferência antes</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {DESTINOS.map((d) => {
          const atual = d.canal === rascunho.canal;
          const lojas = doCanal(d.canal);
          return (
            <div key={d.canal} className={`rounded-md border p-3 space-y-1.5 ${atual ? "border-primary/60 bg-primary/5" : ""}`}>
              <div className="flex items-center gap-1.5">
                <b className="text-sm">{nomeCanal(d.canal)}</b>
                {d.pronto ? <Badge className="text-[10px] py-0 px-1.5">disponível</Badge> : <Badge variant="secondary" className="text-[10px] py-0 px-1.5">em preparação</Badge>}
              </div>
              <div className="text-[11px] leading-snug space-y-0.5">
                {exQ.isLoading ? <span className="text-muted-foreground">verificando se já existe…</span>
                  : exQ.isError ? <span className="text-muted-foreground">não consegui verificar se já existe</span>
                  : d.canal === "amazon" ? <span className="text-muted-foreground">anúncios da Amazon ainda não são lidos pela gestão</span>
                  : lojas.map((l) => (
                    <div key={l.rotulo}>
                      <span className="text-muted-foreground">{l.rotulo}: </span>
                      {l.lista.length === 0 ? <span>ainda não anunciado</span> : (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">
                          já anunciado{l.lista.length > 1 ? ` (${l.lista.length})` : ""}
                          {l.lista.slice(0, 2).map((e) => e.url && (
                            <a key={e.item_id} href={e.url} target="_blank" rel="noreferrer" className="ml-1 underline font-normal inline-flex items-center gap-0.5">ver<ExternalLink className="h-2.5 w-2.5" /></a>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">{d.nota}</p>
              {atual
                ? <p className="text-[11px] font-medium">Este rascunho é deste canal.</p>
                : <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onCanal(d.canal)}>abrir o rascunho de {nomeCanal(d.canal)}</Button>}
            </div>
          );
        })}
      </div>
      {rascunho.canal === "shopee"
        ? <EnvioShopee rascunho={rascunho} jaExiste={(rascunho.empresa === "svl" ? ex?.shopee.svl : ex?.shopee.ottz) ?? null} />
        : <p className="text-sm text-muted-foreground">O envio direto de {nomeCanal(rascunho.canal)} ainda não está pronto. Por enquanto, o texto e as fotos aprovadas daqui podem ser copiados para o anúncio.</p>}
    </CardContent></Card>
  );
}

function EnvioShopee({ rascunho, jaExiste }: { rascunho: IaRascunho; jaExiste: Existente[] | null }) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  // o que a pessoa ajustou na conferência (vazio = o que a função sugerir)
  const [op, setOp] = useState<Op>(OP_INICIAL);
  const [aplicado, setAplicado] = useState<Op>(OP_INICIAL);
  const [enviando, setEnviando] = useState(false);
  const [deNovo, setDeNovo] = useState(false);
  useEffect(() => { setAberto(false); setOp(OP_INICIAL); setAplicado(OP_INICIAL); setDeNovo(false); }, [rascunho.id]);

  const previaQ = useQuery({
    queryKey: ["ia-anuncio", "publicar", rascunho.id, rascunho.updated_at, JSON.stringify(aplicado)],
    enabled: aberto,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<Resposta> => (await chamarPublicar("previa", { rascunho_id: rascunho.id, opcoes: limpar(aplicado) })) as Resposta,
  });
  const d = previaQ.data;
  const p = d?.previa;
  const modo = d?.modo ?? "criar";
  const fotosQ = useQuery({
    queryKey: ["ia-anuncio", "publicar-fotos", (p?.fotos ?? []).map((f) => f.path).join("|")],
    enabled: !!p?.fotos.length,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas((p?.fotos ?? []).map((f) => f.path)),
  });
  const campo = (k: string, padrao: number | null | undefined) => (typeof op[k] === "string" ? String(op[k]) : txt(padrao));
  const mudou = JSON.stringify(op) !== JSON.stringify(aplicado);
  // trocar de modo ou de anúncio refaz a conferência na hora (são leituras diferentes na Shopee)
  const trocar = (x: Op) => { const n = { ...op, ...x }; setOp(n); setAplicado(n); };
  const criado = (d?.publicacoes ?? []).find((x) => x.estado === "publicado" && x.operacao !== "atualizar");
  const existentes = d?.existentes ?? jaExiste ?? [];

  async function enviar() {
    if (!p) return;
    const c = p.campos;
    const aviso = modo === "atualizar" ? [
      `Atualizar o anúncio ${p.alvo?.item_id} na ${p.loja}?`, "",
      `Vai trocar: ${[c?.titulo ? "título" : "", c?.descricao ? "descrição" : "", c?.fotos ? `fotos (${p.fotos.length})` : "", c?.preco ? `preço (${p.preco != null ? formatBRL(p.preco) : "—"})` : ""].filter(Boolean).join(", ")}.`,
      (p.alvo?.n_variacoes ?? 0) > 0 ? `O anúncio tem ${p.alvo?.n_variacoes} variações: título, descrição e fotos valem para todas.` : "",
      "O anúncio está no ar: a mudança aparece para os compradores na hora.",
    ].filter(Boolean).join("\n") : [
      `Criar o anúncio na ${p.loja}?`, "",
      `${p.titulo}`, `Preço: ${p.preco != null ? formatBRL(p.preco) : "—"} · Estoque inicial: ${p.estoque} · ${p.fotos.length} foto(s)`,
      p.fora_do_ar ? "Vai nascer FORA DO AR (não listado). Você ativa depois no Seller Center." : "Vai nascer NO AR, visível para os compradores.",
    ].join("\n");
    if (!window.confirm(aviso)) return;
    setEnviando(true);
    try {
      const r = await chamarPublicar("enviar", { rascunho_id: rascunho.id, opcoes: { ...limpar(aplicado), modo, de_novo: deNovo }, confirmar: true });
      if (modo === "atualizar") toast.success("Anúncio atualizado na Shopee", { description: `Código ${r.item_id} · ${(r.atualizados ?? []).join(", ")}` });
      else toast.success("Anúncio criado na Shopee", { description: `Código ${r.item_id}${r.fora_do_ar ? " · fora do ar" : ""}` });
      setDeNovo(false);
    } catch (e) {
      toast.error(modo === "atualizar" ? "A Shopee não aceitou a atualização" : "A Shopee não aceitou o anúncio", { description: (e as Error).message, duration: 15000 });
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
              ? <>Este produto <b>ainda não tem anúncio</b> na Shopee {nomeEmpresa(rascunho.empresa)}: o envio cria um anúncio novo.</>
              : <>Este produto <b>já tem {n === 1 ? "um anúncio" : `${n} anúncios`}</b> na Shopee {nomeEmpresa(rascunho.empresa)}: o padrão é <b>atualizar</b> o que existe, sem criar duplicado.</>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="gap-1.5" onClick={() => setAberto(true)}><Send className="h-4 w-4" />Conferir e enviar para a Shopee ({nomeEmpresa(rascunho.empresa)})</Button>
          <span className="text-xs text-muted-foreground">Abre a conferência; nada é enviado antes de você confirmar.</span>
        </div>
      </div>
    );
  }
  if (previaQ.isLoading) return <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Montando a conferência (lendo a Shopee)…</div>;
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
            ? <>Este produto <b>ainda não tem anúncio</b> na {p.loja}.</>
            : <>Este produto <b>já tem {existentes.length === 1 ? "um anúncio" : `${existentes.length} anúncios`}</b> na {p.loja}.</>}
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
                  <input type="radio" className="mt-1" checked={sel} disabled={previaQ.isFetching} onChange={() => trocar({ modo: "atualizar", item_id: e.item_id })} />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block truncate text-sm">{e.nome ?? e.item_id}</span>
                    <span className="text-muted-foreground">
                      código {e.item_id}
                      {e.variacao ? <> · este SKU é a variação <b>{e.nome_variacao || e.model_id}</b> do anúncio</> : " · anúncio só deste SKU"}
                      {e.preco != null && <> · {formatBRL(e.preco)}</>}
                      {e.status && e.status !== "NORMAL" && <> · {e.status === "UNLIST" ? "fora do ar" : e.status}</>}
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
          <Troca rotulo="Título" marcado={op.c_titulo !== false} onMarcar={(v) => trocar({ c_titulo: v })}
            antes={p.atual.titulo} depois={`${p.titulo} (${p.titulo.length}/120)`} />
          <Troca rotulo="Descrição" marcado={op.c_descricao !== false} onMarcar={(v) => trocar({ c_descricao: v })}
            antes={resumo(p.atual.descricao)} depois={resumo(p.descricao)} />
          <div className="flex items-start gap-2">
            <Checkbox className="mt-1" checked={op.c_fotos !== false} onCheckedChange={(v) => trocar({ c_fotos: v === true })} />
            <div className="min-w-0 flex-1 space-y-1">
              <b className="text-sm">Fotos</b>
              <div className="flex flex-wrap items-center gap-2">
                <Miniaturas urls={p.atual.fotos} />
                <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                <Miniaturas urls={p.fotos.map((f) => fotosQ.data?.[f.path] ?? "")} legendas={p.fotos.map((f) => rotuloFoto(f.tipo))} />
              </div>
            </div>
          </div>
          <Troca rotulo="Preço" marcado={op.c_preco === true} onMarcar={(v) => trocar({ c_preco: v })}
            antes={p.atual.preco != null ? formatBRL(p.atual.preco) : "—"} depois={p.preco != null ? formatBRL(p.preco) : "—"}
            nota="Desmarcado por padrão: mexer no preço pode afetar promoção em andamento." />
          {mudou && <Button size="sm" variant="outline" onClick={() => setAplicado(op)}>Atualizar a conferência com o que mudei</Button>}
        </div>
      ) : (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm"><b>{p.loja}</b><span className="text-muted-foreground">SKU {p.sku} · anúncio novo</span></div>
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Linha rotulo="Título" valor={`${p.titulo} (${p.titulo.length}/120)`} />
            <Linha rotulo="Preço" valor={p.preco != null ? formatBRL(p.preco) : "—"} />
            <Linha rotulo="Marca" valor={p.marca?.nome ?? "—"} />
            <Linha rotulo="Código de barras" valor={p.ean ?? "sem código no Tiny"} />
            <Linha rotulo="Canais de envio" valor={(p.logistica ?? []).map((l) => l.nome).join(", ") || "—"} />
            <Linha rotulo="Descrição" valor={`${p.descricao.length.toLocaleString("pt-BR")} caracteres (texto + bullets)`} />
          </div>
          <Miniaturas urls={p.fotos.map((f) => fotosQ.data?.[f.path] ?? "")} legendas={p.fotos.map((f, i) => `${i + 1}. ${rotuloFoto(f.tipo)}`)} />
          <div className="flex flex-wrap items-end gap-3 text-sm border-t pt-3">
            <label className="block min-w-[260px] flex-1">
              <span className="text-[11px] text-muted-foreground">Categoria na Shopee</span>
              <select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
                value={String(op.categoria_id ?? p.categoria?.id ?? "")} onChange={(e) => setOp({ ...op, categoria_id: e.target.value })}>
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
          </div>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox className="mt-0.5" checked={op.fora_do_ar !== false} onCheckedChange={(v) => setOp({ ...op, fora_do_ar: v === true })} />
            <span>
              Criar <b>fora do ar</b> (não listado)
              <span className="block text-[11px] text-muted-foreground">Recomendado: confira no Tiny se o anúncio foi ligado ao produto pelo SKU (é o que faz estoque e pedido funcionarem) e ative depois no Seller Center.</span>
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
          {enviando ? "Enviando para a Shopee…" : modo === "atualizar" ? "Atualizar o anúncio na Shopee" : "Criar o anúncio na Shopee"}
        </Button>
        {modo === "criar" && criado && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={deNovo} onCheckedChange={(v) => setDeNovo(v === true)} />este rascunho já criou um anúncio; criar outro mesmo assim
          </label>
        )}
        {mudou && <span className="text-xs text-muted-foreground">Atualize a conferência antes de enviar.</span>}
      </div>

      {(d?.publicacoes ?? []).length > 0 && (
        <div className="rounded-md border divide-y text-xs">
          {(d?.publicacoes ?? []).map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              {x.estado === "publicado" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : x.estado === "erro" ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{new Date(x.criado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              {x.criado_por_nome && <span className="text-muted-foreground">{x.criado_por_nome}</span>}
              {x.estado === "publicado" && <span>{x.operacao === "atualizar" ? "atualizou o anúncio" : "criou o anúncio"} <b className="font-mono">{x.item_id}</b>{x.fora_do_ar ? " · fora do ar" : ""}</span>}
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
  for (const [k, v] of Object.entries(op)) {
    if (k.startsWith("c_")) { campos[k.slice(2)] = v === true; continue; }
    if (typeof v === "boolean") out[k] = v;
    else if (v.trim() !== "") out[k] = v.trim().replace(",", ".");
  }
  out.campos = campos;
  return out;
}
const resumo = (t: string) => `${t.length.toLocaleString("pt-BR")} caracteres · ${t.replace(/\s+/g, " ").slice(0, 150)}${t.length > 150 ? "…" : ""}`;

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return <div className="min-w-0"><span className="text-[11px] text-muted-foreground block">{rotulo}</span><span className="break-words">{valor}</span></div>;
}
function Medida({ rotulo, valor, onChange }: { rotulo: string; valor: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted-foreground">{rotulo}</span>
      <Input className="h-8 mt-1 w-24 font-mono" value={valor} onChange={(e) => onChange(e.target.value)} />
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
function Miniaturas({ urls, legendas }: { urls: string[]; legendas?: string[] }) {
  if (!urls.length) return <span className="text-xs text-muted-foreground">nenhuma foto</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {urls.slice(0, 9).map((u, i) => (
        <div key={`${u}-${i}`} className="w-14">
          <div className="h-14 w-14 rounded border bg-muted/30 overflow-hidden">{u && <img src={u} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
          {legendas?.[i] && <div className="text-[9.5px] text-muted-foreground truncate capitalize" title={legendas[i]}>{legendas[i]}</div>}
        </div>
      ))}
    </div>
  );
}
