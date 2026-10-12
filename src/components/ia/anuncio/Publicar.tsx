import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, Send } from "lucide-react";
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
// `anuncio-publicar`): prévia do que será enviado → confirmação → cria o
// anúncio com as fotos aprovadas. Por padrão o anúncio nasce FORA DO AR, para
// conferir no Tiny o vínculo pelo SKU antes de ativar. Os outros canais
// aparecem como "em preparação" (ver docs/ia-fase3-publicacao-direta.md).
// ============================================================================

const DESTINOS: { canal: string; pronto: boolean; nota: string }[] = [
  { canal: "shopee", pronto: true, nota: "Cria o anúncio direto na loja, com o texto, o preço e as fotos aprovadas." },
  { canal: "mercado_livre", pronto: false, nota: "Em preparação. O app já tem permissão; falta montar o envio (marca, código de barras e o modelo novo de anúncio do ML)." },
  { canal: "tiktok", pronto: false, nota: "Em preparação. Precisa enviar as fotos pela API e informar as medidas do pacote." },
  { canal: "amazon", pronto: false, nota: "Em preparação. Cada tipo de produto tem um formulário próprio; entra por último." },
];

interface Previa {
  loja: string; titulo: string; descricao: string; preco: number | null; estoque: number; fora_do_ar: boolean; sku: string;
  medidas: { peso_kg: number | null; comprimento_cm: number | null; largura_cm: number | null; altura_cm: number | null };
  categoria: { id: number; caminho: string } | null; categorias_sugeridas: { id: number; caminho: string }[];
  marca: { id: number; nome: string }; logistica: { id: number; nome: string }[]; fotos: { path: string; tipo: string }[]; ean: string | null;
}
interface Publicacao { id: string; canal: string; empresa: string; estado: string; item_id: string | null; url: string | null; fora_do_ar: boolean | null; erro: string | null; criado_por_nome: string | null; criado_em: string }
interface Resposta { ok: boolean; disponivel: boolean; motivo?: string; previa?: Previa; pendencias?: string[]; avisos?: string[]; publicacoes?: Publicacao[] }

const txt = (v: number | null | undefined) => (v == null ? "" : String(v).replace(".", ","));

export function Publicar({ rascunho, onCanal }: { rascunho: IaRascunho; onCanal: (canal: string) => void }) {
  return (
    <Card><CardContent className="p-5 space-y-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-semibold">3 · Enviar anúncio</h3>
        <span className="text-xs text-muted-foreground">direto para o marketplace, sempre com conferência antes</span>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {DESTINOS.map((d) => {
          const atual = d.canal === rascunho.canal;
          return (
            <div key={d.canal} className={`rounded-md border p-3 space-y-1.5 ${atual ? "border-primary/60 bg-primary/5" : ""}`}>
              <div className="flex items-center gap-1.5">
                <b className="text-sm">{nomeCanal(d.canal)}</b>
                {d.pronto ? <Badge className="text-[10px] py-0 px-1.5">disponível</Badge> : <Badge variant="secondary" className="text-[10px] py-0 px-1.5">em preparação</Badge>}
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
        ? <EnvioShopee rascunho={rascunho} />
        : <p className="text-sm text-muted-foreground">O envio direto de {nomeCanal(rascunho.canal)} ainda não está pronto. Por enquanto, o texto e as fotos aprovadas daqui podem ser copiados para o anúncio.</p>}
    </CardContent></Card>
  );
}

function EnvioShopee({ rascunho }: { rascunho: IaRascunho }) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  // o que a pessoa ajustou na conferência (vazio = o que a função sugerir)
  const [op, setOp] = useState<Record<string, string | boolean>>({ fora_do_ar: true });
  const [aplicado, setAplicado] = useState<Record<string, string | boolean>>({ fora_do_ar: true });
  const [enviando, setEnviando] = useState(false);
  const [deNovo, setDeNovo] = useState(false);
  useEffect(() => { setAberto(false); setOp({ fora_do_ar: true }); setAplicado({ fora_do_ar: true }); setDeNovo(false); }, [rascunho.id]);

  const previaQ = useQuery({
    queryKey: ["ia-anuncio", "publicar", rascunho.id, rascunho.updated_at, JSON.stringify(aplicado)],
    enabled: aberto,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<Resposta> => (await chamarPublicar("previa", { rascunho_id: rascunho.id, opcoes: limpar(aplicado) })) as Resposta,
  });
  const d = previaQ.data;
  const p = d?.previa;
  const fotosQ = useQuery({
    queryKey: ["ia-anuncio", "publicar-fotos", (p?.fotos ?? []).map((f) => f.path).join("|")],
    enabled: !!p?.fotos.length,
    staleTime: 30 * 60_000,
    queryFn: () => urlsAssinadas((p?.fotos ?? []).map((f) => f.path)),
  });
  const campo = (k: string, padrao: number | null | undefined) => (op[k] !== undefined ? String(op[k]) : txt(padrao));
  const mudou = JSON.stringify(op) !== JSON.stringify(aplicado);
  const publicado = (d?.publicacoes ?? []).find((x) => x.estado === "publicado");

  async function enviar() {
    if (!p) return;
    const aviso = [
      `Criar o anúncio na ${p.loja}?`, "",
      `${p.titulo}`, `Preço: ${p.preco != null ? formatBRL(p.preco) : "—"} · Estoque inicial: ${p.estoque} · ${p.fotos.length} foto(s)`,
      p.fora_do_ar ? "Vai nascer FORA DO AR (não listado). Você ativa depois no Seller Center." : "Vai nascer NO AR, visível para os compradores.",
    ].join("\n");
    if (!window.confirm(aviso)) return;
    setEnviando(true);
    try {
      const r = await chamarPublicar("enviar", { rascunho_id: rascunho.id, opcoes: { ...limpar(aplicado), de_novo: deNovo }, confirmar: true });
      toast.success("Anúncio criado na Shopee", { description: `Código ${r.item_id}${r.fora_do_ar ? " · fora do ar" : ""}` });
      setDeNovo(false);
    } catch (e) {
      toast.error("A Shopee não aceitou o anúncio", { description: (e as Error).message, duration: 15000 });
    } finally {
      setEnviando(false);
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    }
  }

  if (!aberto) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button className="gap-1.5" onClick={() => setAberto(true)}><Send className="h-4 w-4" />Conferir e enviar para a Shopee ({nomeEmpresa(rascunho.empresa)})</Button>
        <span className="text-xs text-muted-foreground">Abre a conferência; nada é enviado antes de você confirmar.</span>
      </div>
    );
  }
  if (previaQ.isLoading) return <div className="text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Montando a conferência (lendo Tiny e Shopee)…</div>;
  if (previaQ.isError) return <p className="text-sm text-destructive">Falha ao montar a conferência: {(previaQ.error as Error).message}</p>;
  if (!p) return <p className="text-sm text-muted-foreground">{d?.motivo ?? "Sem dados."}</p>;

  const pend = d?.pendencias ?? []; const avisos = d?.avisos ?? [];
  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <b>{p.loja}</b>
          <span className="text-muted-foreground">SKU {p.sku}</span>
          {previaQ.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Linha rotulo="Título" valor={`${p.titulo} (${p.titulo.length}/120)`} />
          <Linha rotulo="Preço" valor={p.preco != null ? formatBRL(p.preco) : "—"} />
          <Linha rotulo="Marca" valor={p.marca.nome} />
          <Linha rotulo="Código de barras" valor={p.ean ?? "sem código no Tiny"} />
          <Linha rotulo="Canais de envio" valor={p.logistica.map((l) => l.nome).join(", ") || "—"} />
          <Linha rotulo="Descrição" valor={`${p.descricao.length.toLocaleString("pt-BR")} caracteres (texto + bullets)`} />
        </div>

        <div className="flex flex-wrap gap-2">
          {p.fotos.map((f, i) => (
            <div key={f.path} className="w-16">
              <div className="h-16 w-16 rounded border bg-muted/30 overflow-hidden">
                {fotosQ.data?.[f.path] && <img src={fotosQ.data[f.path]} alt="" className="h-full w-full object-cover" />}
              </div>
              <div className="text-[9.5px] text-muted-foreground truncate capitalize" title={rotuloFoto(f.tipo)}>{i + 1}. {rotuloFoto(f.tipo)}</div>
            </div>
          ))}
          {p.fotos.length === 0 && <span className="text-xs text-muted-foreground">Nenhuma foto aprovada.</span>}
        </div>

        <div className="flex flex-wrap items-end gap-3 text-sm border-t pt-3">
          <label className="block min-w-[260px] flex-1">
            <span className="text-[11px] text-muted-foreground">Categoria na Shopee</span>
            <select className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs"
              value={String(op.categoria_id ?? p.categoria?.id ?? "")} onChange={(e) => setOp({ ...op, categoria_id: e.target.value })}>
              {p.categorias_sugeridas.length === 0 && <option value="">nenhuma sugestão</option>}
              {p.categorias_sugeridas.map((c) => <option key={c.id} value={c.id}>{c.caminho}</option>)}
              {p.categoria && !p.categorias_sugeridas.some((c) => c.id === p.categoria!.id) && <option value={p.categoria.id}>{p.categoria.caminho || p.categoria.id}</option>}
            </select>
          </label>
          <Medida rotulo="Peso (kg)" valor={campo("peso_kg", p.medidas.peso_kg)} onChange={(v) => setOp({ ...op, peso_kg: v })} />
          <Medida rotulo="Compr. (cm)" valor={campo("comprimento_cm", p.medidas.comprimento_cm)} onChange={(v) => setOp({ ...op, comprimento_cm: v })} />
          <Medida rotulo="Largura (cm)" valor={campo("largura_cm", p.medidas.largura_cm)} onChange={(v) => setOp({ ...op, largura_cm: v })} />
          <Medida rotulo="Altura (cm)" valor={campo("altura_cm", p.medidas.altura_cm)} onChange={(v) => setOp({ ...op, altura_cm: v })} />
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
        <Button className="gap-1.5" disabled={enviando || mudou || pend.length > 0 || (!!publicado && !deNovo)} onClick={() => void enviar()}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {enviando ? "Enviando fotos e criando o anúncio…" : "Enviar para a Shopee"}
        </Button>
        {publicado && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={deNovo} onCheckedChange={(v) => setDeNovo(v === true)} />este rascunho já foi enviado; criar outro anúncio mesmo assim
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
              {x.estado === "publicado" && <span>anúncio <b className="font-mono">{x.item_id}</b>{x.fora_do_ar ? " · criado fora do ar" : ""}</span>}
              {x.url && <a href={x.url} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5">abrir<ExternalLink className="h-3 w-3" /></a>}
              {x.estado === "erro" && <span className="text-destructive">{x.erro}</span>}
              {x.estado === "enviando" && <span className="text-muted-foreground">envio em andamento</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tira os campos vazios e converte vírgula em ponto: a função entende vazio como "use o sugerido". */
function limpar(op: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) {
    if (typeof v === "boolean") out[k] = v;
    else if (v.trim() !== "") out[k] = v.trim().replace(",", ".");
  }
  return out;
}

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
