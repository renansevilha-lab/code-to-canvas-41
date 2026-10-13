import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL } from "@/lib/format";
import { decidirEtapa } from "@/components/ia/anuncio/EtapaTexto";
import { FotosTiny } from "@/components/ia/anuncio/FotosTiny";
import { chamarPublicar, nomeCanal, nomeEmpresa, rotuloFoto, urlsAssinadas, type IaPreco, type IaRascunho } from "@/lib/iaAnuncio";
import { EV_CRIADO, EV_PRONTO, EV_VAI_CRIAR, type AnuncioCriado, type AnuncioPronto, type VaiCriar } from "@/lib/iaEnvioEventos";

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
  { canal: "amazon", pronto: true, nota: "Atualiza um anúncio que já existe (título, descrição, bullets e fotos), conferido pelo validador da Amazon. Criar anúncio novo e preço ainda não." },
];

interface Existente { item_id: string; nome: string | null; status?: string | null; url?: string | null; variacao?: boolean; model_id?: string | null; nome_variacao?: string | null; preco: number | null; variacoes?: number; vendas?: number; catalogo?: boolean }
interface Existentes {
  shopee: { ottz: Existente[]; svl: Existente[] }; mercado_livre: Existente[]; tiktok: Existente[];
  /** Mercado Livre ao vivo, por conta (null = não deu para consultar). */
  mercado_livre_lojas?: { ottz: Existente[] | null; svl: Existente[] | null };
  /** Amazon ao vivo, por conta (null = não deu para consultar; SVL sem o código de vendedor). */
  amazon?: { ottz: Existente[] | null; svl: Existente[] | null };
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
const opInicial = (canal: string): Op => ({ fora_do_ar: canal !== "shopee", c_titulo: canal !== "mercado_livre", c_descricao: true, c_fotos: true, c_preco: false });
const situacao = (st?: string | null) => (!st || st === "NORMAL" || st === "active" ? "" : st === "UNLIST" ? "fora do ar" : st === "paused" ? "pausado" : st);

/** Lojas de cada marketplace: o destino do envio é sempre canal + empresa. */
const LOJAS: Record<string, { rotulo: string; empresa: string }[]> = {
  shopee: [{ rotulo: "Ottz", empresa: "ottz" }, { rotulo: "Bumi", empresa: "svl" }],
  mercado_livre: [{ rotulo: "Ottz", empresa: "ottz" }, { rotulo: "SVL", empresa: "svl" }],
  tiktok: [{ rotulo: "ACZ", empresa: "ottz" }],
  amazon: [{ rotulo: "ACZ", empresa: "ottz" }, { rotulo: "SVL", empresa: "svl" }],
};

export function Publicar({ rascunho, canal, empresa, onDestino, noEnvio }: {
  rascunho: IaRascunho; canal: string; empresa: string; onDestino: (canal: string, empresa: string) => void;
  /** bloco extra dentro da conferência de CRIAR (ex.: cadastrar em Minha Promoção, na Shopee) */
  noEnvio?: ReactNode;
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
    if (c === "amazon") return ex.amazon ? (e === "svl" ? ex.amazon.svl : ex.amazon.ottz) : null;
    return undefined;
  };
  const pronto = DESTINOS.find((d) => d.canal === canal)?.pronto === true;
  // clicar em "enviar para cá" já abre a conferência (o número muda a cada clique e remonta o Envio aberto)
  const [abrir, setAbrir] = useState(0);
  // todos os anúncios deste produto no canal escolhido (todas as lojas): servem ao "Atualizar também"
  const outros: Outro[] = (LOJAS[canal] ?? []).flatMap((l) => (listaDe(canal, l.empresa) ?? []).map((e) => ({ empresa: l.empresa, rotulo: l.rotulo, e })));
  // ENVIAR TAMBÉM (13/out, pedido do dono): criado num lugar, a conferência já oferece os outros
  const demais: Demais[] = DESTINOS.filter((d) => d.pronto).flatMap((d) => (LOJAS[d.canal] ?? [])
    .filter((l) => !(d.canal === canal && l.empresa === empresa))
    .map((l) => ({ canal: d.canal, empresa: l.empresa, rotulo: `${nomeCanal(d.canal)} · ${l.rotulo}`, lista: listaDe(d.canal, l.empresa) })));
  const irPara = (c: string, e: string) => { setAbrir((n) => n + 1); onDestino(c, e); };
  // a ordem das fotos arrumada num destino vale para os outros (o anúncio é um só)
  const [ordemComum, setOrdemComum] = useState<{ id: string; ordem: string[] } | null>(null);
  // ao escolher um destino, a conferência dele fica à vista (a tela não sobe nem desce sozinha)
  const caixa = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (abrir > 0) caixa.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [abrir, canal, empresa]);
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
                {lojas.map((l) => {
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
                            onClick={() => { setAbrir((n) => n + 1); onDestino(d.canal, l.empresa); }}>{escolhida ? "escolhido" : "enviar para cá"}</Button>
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
      <div ref={caixa} className="scroll-mt-20 scroll-mb-6">
      {pronto
        ? <Envio key={`${rascunho.id}-${canal}-${empresa}-${abrir}`} rascunho={rascunho} canal={canal} empresa={empresa} jaExiste={listaDe(canal, empresa) ?? null}
            abertoInicial={abrir > 0} outros={outros} noEnvio={noEnvio} demais={demais} onIr={irPara}
            ordemInicial={ordemComum?.id === rascunho.id ? ordemComum.ordem : null} onOrdem={(o) => setOrdemComum({ id: rascunho.id, ordem: o })} />
        : <p className="text-sm text-muted-foreground">O envio direto de {nomeCanal(canal)} ainda não está pronto: escolha a Shopee ou o Mercado Livre nos cartões acima. O texto e as fotos aprovadas daqui podem ser copiados para o anúncio.</p>}
      </div>
    </CardContent></Card>
  );
}

/** Outro destino (marketplace + loja) deste mesmo anúncio: undefined = ainda lendo; null = não deu para consultar. */
interface Demais { canal: string; empresa: string; rotulo: string; lista: Existente[] | null | undefined }

/** Um anúncio deste produto numa loja do canal (candidato ao "Atualizar também"). */
interface Outro { empresa: string; rotulo: string; e: Existente }

/** Conferência + envio (Shopee e Mercado Livre: mesma tela, textos e campos mudam pelo canal). */
function Envio({ rascunho, canal, empresa, jaExiste, abertoInicial, outros, noEnvio, demais, onIr, ordemInicial, onOrdem }: {
  rascunho: IaRascunho; canal: string; empresa: string; jaExiste: Existente[] | null; abertoInicial?: boolean; outros?: Outro[]; noEnvio?: ReactNode;
  demais?: Demais[]; onIr?: (canal: string, empresa: string) => void;
  /** ordem das fotos já arrumada em outro destino deste anúncio */
  ordemInicial?: string[] | null; onOrdem?: (ordem: string[]) => void;
}) {
  const qc = useQueryClient();
  // o destino vai em toda chamada: o mesmo rascunho serve a qualquer marketplace/loja
  const destino = { canal, empresa };
  const ml = canal === "mercado_livre";
  const amz = canal === "amazon";
  const MK = ml ? "Mercado Livre" : amz ? "Amazon" : "Shopee";
  const NO = ml ? "no" : "na"; const ART = ml ? "o" : "a";
  const [aberto, setAberto] = useState(abertoInicial === true);
  // o que a pessoa ajustou na conferência (vazio = o que a função sugerir)
  const [op, setOp] = useState<Op>(() => opInicial(canal));
  const [aplicado, setAplicado] = useState<Op>(() => opInicial(canal));
  const [enviando, setEnviando] = useState(false);
  const [deNovo, setDeNovo] = useState(false);
  // acabou de criar aqui: os outros destinos aparecem na hora, sem esperar a conferência recarregar
  const [recem, setRecem] = useState<string | null>(null);
  // ajustes feitos na própria conferência (13/out, pedido do dono): título e tirar foto mexem no rascunho
  const [tituloTxt, setTituloTxt] = useState<string | null>(null);
  const [mexendo, setMexendo] = useState(false);
  // PREÇO PADRÃO (13/out, pedido do dono): sem preço aprovado para este destino, a conferência já
  // abre com o preço da margem padrão do canal (Shopee = 30%, em IA › Prompts › Canais), calculado
  // agora — o "sugerido" guardado no rascunho é o da margem antiga.
  const proprioD = rascunho.canal === canal && rascunho.empresa === empresa;
  const aprovadoD = proprioD ? rascunho.preco_aprovado : rascunho.memoria_calculo?.destinos?.[`${canal}:${empresa}`]?.preco;
  const padraoQ = useQuery({
    queryKey: ["ia-anuncio", "produto", rascunho.sku, "preco", canal, empresa, null],
    enabled: canal === "shopee" && aprovadoD == null,
    queryFn: async (): Promise<IaPreco> => {
      const { data, error } = await supabaseExternal.rpc("ia_calcular_preco", { p_sku: rascunho.sku, p_canal: canal, p_empresa: empresa, p_margem: null });
      if (error) throw error;
      return (data ?? {}) as IaPreco;
    },
  });
  const precoPadrao = canal === "shopee" && aprovadoD == null ? padraoQ.data?.preco_sugerido ?? null : null;
  const margemPadrao = padraoQ.data?.memoria_calculo?.margem_padrao_pct as number | undefined;
  const padraoPosto = useRef<string | null>(null);
  useEffect(() => {
    if (precoPadrao == null || padraoPosto.current != null) return;
    const s = String(precoPadrao);
    padraoPosto.current = s;
    setOp((o) => (o.preco === undefined ? { ...o, preco: s } : o));
    setAplicado((a) => (a.preco === undefined ? { ...a, preco: s } : a));
  }, [precoPadrao]);
  // aprovou um preco no bloco Preco depois de abrir aqui: o padrao sai da frente (o aprovado manda)
  useEffect(() => {
    const posto = padraoPosto.current;
    if (aprovadoD == null || posto == null) return;
    padraoPosto.current = null;
    const tirar = (o: Op): Op => { if (o.preco !== posto) return o; const n = { ...o }; delete n.preco; return n; };
    setOp(tirar); setAplicado(tirar);
  }, [aprovadoD]);

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
  // ORDEM FINAL das fotos: a que a pessoa arrumou (arrastando ou pelas setas) ou, sem mexer, atuais/novas pela
  // posição. Fica só na tela e vai junto no envio (não refaz a conferência a cada troca de lugar).
  const [ordem, setOrdem] = useState<string[] | null>(ordemInicial ?? null);
  useEffect(() => { if (ordem) onOrdem?.(ordem); }, [ordem]);
  const idsAtuais = (p?.atual?.fotos ?? []).map((f) => f.id);
  const baseOrdem = modo === "atualizar"
    ? (() => {
      const m = idsAtuais.filter((id) => manter.includes(id));
      const n = (p?.fotos ?? []).map((f) => f.path).filter((x) => novas.includes(x));
      return posicao === "inicio" ? [...n, ...m] : [...m, ...n];
    })()
    : (p?.fotos ?? []).map((f) => f.path);
  const finalOrdem = ordem ? [...ordem.filter((x) => baseOrdem.includes(x)), ...baseOrdem.filter((x) => !ordem.includes(x))] : baseOrdem;
  const itensOrdem = finalOrdem.map((x) => {
    const a = p?.atual?.fotos.find((f) => f.id === x); const n = p?.fotos.find((f) => f.path === x);
    return { id: x, url: a ? a.url : (fotosQ.data?.[x] ?? ""), legenda: a ? "atual" : rotuloFoto(n?.tipo ?? "") };
  });
  // ATUALIZAR TAMBÉM: a mesma troca em outros anúncios deste produto no mesmo marketplace
  const [tambem, setTambem] = useState<Record<string, boolean>>({});
  const [prontoT, setProntoT] = useState<Record<string, boolean>>({});
  const chaveT = (o: Outro) => `${o.empresa}:${o.e.item_id}`;
  const alvosT = (outros ?? []).filter((o) => !(o.empresa === empresa && o.e.item_id === p?.alvo?.item_id));
  /** As opções do anúncio principal traduzidas para outro anúncio: fotos atuais por POSIÇÃO (os ids são de cada anúncio). */
  const opcoesT = (o: Outro, comOrdem: boolean): Record<string, unknown> => {
    const fotos: Record<string, unknown> = { manter_pos: manter.map((id) => idsAtuais.indexOf(id)).filter((i) => i >= 0), novas, posicao };
    if (comOrdem && ordem) fotos.ordem = finalOrdem.map((x) => (idsAtuais.includes(x) ? `#${idsAtuais.indexOf(x)}` : x));
    return { modo: "atualizar", item_id: o.e.item_id, campos: limpar(aplicado).campos, fotos };
  };
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
  /** Tira a foto do anúncio: ela deixa de estar aprovada (fica "rejeitada" no bloco Fotos, onde dá para aprovar de novo). */
  async function tirarFoto(path: string) {
    if (!window.confirm("Tirar esta foto do anúncio?\n\nEla deixa de estar aprovada — vale para todos os destinos. Para voltar, aprove de novo no bloco Fotos.")) return;
    setMexendo(true);
    try {
      const im = await supabaseExternal.from("ia_rascunho_imagem").select("id").eq("rascunho_id", rascunho.id).eq("storage_path", path).limit(1);
      const idImagem = (im.data ?? [])[0]?.id;
      const et = idImagem ? await supabaseExternal.from("ia_etapa").select("id").eq("imagem_id", idImagem).limit(1) : { data: [] as { id: string }[] };
      const idEtapa = (et.data ?? [])[0]?.id;
      if (!idEtapa) throw new Error("não achei esta foto no rascunho");
      await decidirEtapa(String(idEtapa), false);
      setOrdem((o) => (o ? o.filter((x) => x !== path) : o));
      await qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) { toast.error("Não consegui tirar a foto", { description: (e as Error).message, duration: 12000 }); }
    finally { setMexendo(false); }
  }
  /** Título editado na conferência: grava no anúncio (é o mesmo para todos os destinos) e mantém o texto aprovado. */
  async function salvarTitulo() {
    const novo = (tituloTxt ?? "").trim();
    if (!novo || novo === p?.titulo) { setTituloTxt(null); return; }
    setMexendo(true);
    try {
      const et = await supabaseExternal.from("ia_etapa").select("id, status").eq("rascunho_id", rascunho.id).eq("etapa", "texto").limit(1);
      const etapa = (et.data ?? [])[0] as { id: string; status: string } | undefined;
      const { error } = await supabaseExternal.from("ia_rascunho").update({ titulo: novo }).eq("id", rascunho.id);
      if (error) throw error;
      // mudar o texto devolve a etapa a "para revisar"; quem editou o título aqui já o aprovou
      if (etapa?.status === "aprovado") await decidirEtapa(String(etapa.id), true);
      setTituloTxt(null);
      await qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
      toast.success("Título atualizado", { description: "Vale para todos os destinos deste anúncio." });
    } catch (e) { toast.error("Não consegui salvar o título", { description: (e as Error).message, duration: 12000 }); }
    finally { setMexendo(false); }
  }
  const campo = (k: string, padrao: number | null | undefined) => (typeof op[k] === "string" ? String(op[k]) : txt(padrao));
  const mudou = JSON.stringify(op) !== JSON.stringify(aplicado);
  // trocar de modo ou de anúncio refaz a conferência na hora (são leituras diferentes na Shopee)
  const trocar = (x: Op) => { const n = { ...op, ...x }; setOp(n); setAplicado(n); };
  const criado = (d?.publicacoes ?? []).find((x) => x.estado === "publicado" && x.operacao !== "atualizar" && x.canal === canal && x.empresa === empresa);
  const extras = modo === "atualizar" ? alvosT.filter((o) => tambem[chaveT(o)]) : [];
  const extrasProntos = extras.filter((o) => prontoT[chaveT(o)]);
  const existentes = d?.existentes ?? jaExiste ?? [];

  async function enviar() {
    if (!p) return;
    const c = p.campos;
    const junto: VaiCriar = { canal, empresa, sku: rascunho.sku, variacoes: false, promocao: null };
    if (modo !== "atualizar") window.dispatchEvent(new CustomEvent(EV_VAI_CRIAR, { detail: junto }));
    // com variações, o anúncio simples nasce fora do ar e só vai ao ar depois que elas existem
    const ativarDepois = modo !== "atualizar" && canal === "shopee" && junto.variacoes && !p.fora_do_ar;
    const aviso = modo === "atualizar" ? [
      `Atualizar o anúncio ${p.alvo?.item_id} ${NO} ${p.loja}?`, "",
      `Vai trocar: ${[c?.titulo ? "título" : "", c?.descricao ? "descrição" : "", c?.fotos ? `fotos (ficam ${manter.length} das atuais + ${novas.length} nova(s))` : "", c?.preco ? `preço (${p.preco != null ? formatBRL(p.preco) : "—"})` : ""].filter(Boolean).join(", ")}.`,
      (p.alvo?.n_variacoes ?? 0) > 0 ? `O anúncio tem ${p.alvo?.n_variacoes} variações: título, descrição e fotos valem para todas.` : "",
      extrasProntos.length ? `TAMBÉM, com a mesma troca: ${extrasProntos.map((o) => `${MK} ${o.rotulo} (${o.e.item_id})`).join(", ")}.` : "",
      extras.length > extrasProntos.length ? `${extras.length - extrasProntos.length} anúncio(s) marcado(s) em "Atualizar também" tem pendência e fica(m) de fora.` : "",
      "O anúncio está no ar: a mudança aparece para os compradores na hora.",
    ].filter(Boolean).join("\n") : [
      `Criar o anúncio ${NO} ${p.loja}?`, "",
      `${p.titulo}`, `Preço: ${p.preco != null ? formatBRL(p.preco) : "—"} · Estoque inicial: ${p.estoque} · ${p.fotos.length} foto(s)`,
      p.fora_do_ar
        ? (ml ? "Vai ser PAUSADO logo depois de criado. Você reativa depois no Mercado Livre." : "Vai nascer FORA DO AR (não listado). Você ativa depois no Seller Center.")
        : ativarDepois
          ? "Nasce fora do ar e vai ao AR logo depois que as variações forem criadas (segundos)."
          : "Vai nascer NO AR, visível para os compradores.",
      ...(junto.variacoes ? ["Em seguida: cria as variações (bloco Variações deste anúncio)."] : []),
      ...(junto.promocao ? [`Em seguida: cadastra na promoção ${junto.promocao} — o preço promocional vale na hora.`] : []),
      ...(junto.tiny ? [`Também: manda ${junto.tiny} para o produto no Tiny.`] : []),
    ].join("\n");
    if (!window.confirm(aviso)) return;
    setEnviando(true);
    try {
      const opc: Record<string, unknown> = { ...limpar(aplicado), modo, de_novo: deNovo };
      if (ordem) opc.fotos = { ...((opc.fotos as Record<string, unknown> | undefined) ?? {}), ordem: finalOrdem };
      if (ativarDepois) opc.fora_do_ar = true;
      const r = await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino, opcoes: opc, confirmar: true });
      if (modo === "atualizar") toast.success(`Anúncio atualizado ${NO} ${MK}`, { description: `Código ${r.item_id} · ${(r.atualizados ?? []).join(", ")}` });
      else toast.success(`Anúncio criado ${NO} ${MK}`, { description: `Código ${r.item_id}${r.fora_do_ar ? (ml ? " · pausado" : " · fora do ar") : ""}${r.titulo_final ? ` · ${r.titulo_final}` : ""}` });
      // produto pai na Shopee: o bloco "Variações deste anúncio" ouve este aviso e cria as opções no anúncio recém-criado
      if (modo !== "atualizar" && r.item_id) {
        setRecem(String(r.item_id));
        const criadoAgora: AnuncioCriado = { canal, empresa, sku: rascunho.sku, item_id: String(r.item_id), ativar: ativarDepois, preco: p.preco ?? null };
        window.dispatchEvent(new CustomEvent(EV_CRIADO, { detail: criadoAgora }));
        // anúncio simples já está completo: a promoção (se escolhida) entra agora; com variações, quem avisa é o bloco delas
        if (!junto.variacoes) {
          const pronto: AnuncioPronto = { canal, empresa, sku: rascunho.sku, item_id: String(r.item_id), precos: p.preco != null ? { [rascunho.sku]: Number(p.preco) } : {} };
          window.dispatchEvent(new CustomEvent(EV_PRONTO, { detail: pronto }));
        }
      }
      // o que deu certo pela metade (ex.: criado mas não pausou) não pode passar batido
      for (const av of ((r.avisos ?? []) as string[]).filter((x) => /^(ATENÇÃO|o anúncio foi criado, mas)/.test(x))) toast.warning(av, { duration: 30000 });
      setDeNovo(false);
      // os outros anúncios marcados: um por vez, só depois que o principal deu certo
      for (const o of extrasProntos) {
        try {
          const rr = await chamarPublicar("enviar", { rascunho_id: rascunho.id, destino: { canal, empresa: o.empresa }, opcoes: opcoesT(o, true), confirmar: true });
          toast.success(`Também atualizado: ${MK} ${o.rotulo}`, { description: `Código ${rr.item_id} · ${(rr.atualizados ?? []).join(", ")}` });
        } catch (e) {
          toast.error(`${MK} ${o.rotulo} (${o.e.item_id}) não aceitou a atualização`, { description: (e as Error).message, duration: 20000 });
        }
      }
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
          <Button size="sm" variant={modo === "criar" ? "default" : "outline"} disabled={previaQ.isFetching || amz} title={amz ? "Criar anúncio novo na Amazon ainda não está pronto" : undefined}
            onClick={() => trocar({ modo: "criar" })}>Criar anúncio novo</Button>
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
            antes={resumo(p.atual.descricao)} depois={resumo(p.descricao)} nota={amz ? "Na Amazon a descrição e os bullets vão em campos separados; aqui aparecem juntos." : undefined} />
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
                <Button size="sm" variant={posicao === "inicio" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => { setOrdem(null); setOp({ ...op, f_pos: "inicio" }); }}>no início (a 1ª vira a capa)</Button>
                <Button size="sm" variant={posicao === "fim" ? "default" : "outline"} className="h-6 px-2 text-[11px]" onClick={() => { setOrdem(null); setOp({ ...op, f_pos: "fim" }); }}>no fim</Button>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Vai ficar com {manter.length + novas.length} de {limFotos} fotos ({manter.length} das atuais + {novas.length} nova{novas.length === 1 ? "" : "s"}) · arraste ou use as setas para mudar a ordem
                </div>
                <Ordenavel itens={itensOrdem} max={limFotos} onOrdem={setOrdem} />
              </div>
            </div>
          </div>
          <Troca rotulo="Preço" marcado={op.c_preco === true} onMarcar={(v) => trocar({ c_preco: v })}
            antes={p.atual.preco != null ? formatBRL(p.atual.preco) : "—"} depois={p.preco != null ? formatBRL(p.preco) : "—"}
            nota={amz ? "O preço na Amazon ainda não é trocado por aqui." : "Desmarcado por padrão: mexer no preço pode afetar promoção em andamento."} />
        </div>
      ) : (
        <div className="rounded-md border p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm"><b>{p.loja}</b><span className="text-muted-foreground">SKU {p.sku} · anúncio novo</span></div>
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <label className="block md:col-span-2">
              <span className={`text-[11px] ${(tituloTxt ?? p.titulo).length > limTitulo ? "text-destructive" : "text-muted-foreground"}`}>
                Título ({(tituloTxt ?? p.titulo).length}/{limTitulo}) · o mesmo para todos os destinos
              </span>
              <div className="flex gap-2 mt-1">
                <Input className="h-8 text-sm" value={tituloTxt ?? p.titulo} disabled={mexendo} onChange={(e) => setTituloTxt(e.target.value)} />
                {tituloTxt != null && tituloTxt.trim() !== p.titulo && (
                  <>
                    <Button size="sm" className="h-8 shrink-0" disabled={mexendo || !tituloTxt.trim()} onClick={() => void salvarTitulo()}>Salvar título</Button>
                    <Button size="sm" variant="ghost" className="h-8 shrink-0" disabled={mexendo} onClick={() => setTituloTxt(null)}>Desfazer</Button>
                  </>
                )}
              </div>
            </label>
            <label className="block">
              <span className="text-[11px] text-muted-foreground">Preço (R$) · só deste envio{precoPadrao != null && String(op.preco ?? "") === String(precoPadrao) && margemPadrao ? ` · padrão: margem de ${(margemPadrao * 100).toFixed(0)}%` : ""}</span>
              <Input className="h-8 mt-1 w-[150px] text-sm tabular-nums" inputMode="decimal" placeholder="defina o preço"
                value={campo("preco", p.preco)} onChange={(e) => setOp({ ...op, preco: e.target.value })} />
            </label>
            {p.marca && <Linha rotulo="Marca" valor={p.marca.nome} />}
            <Linha rotulo="Código de barras" valor={p.ean ?? (ml ? "sem código — vai como \"produto sem código cadastrado\"" : "sem código no Tiny")} />
            {p.logistica && <Linha rotulo="Canais de envio" valor={p.logistica.map((l) => l.nome).join(", ") || "—"} />}
            {ml && <Linha rotulo="Envio" valor="Mercado Envios, sem retirada em mãos" />}
            <Linha rotulo="Descrição" valor={`${p.descricao.length.toLocaleString("pt-BR")} caracteres (texto + bullets)`} />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Fotos, na ordem em que vão · clique para ampliar · arraste ou use as setas para mudar · o X tira a foto</div>
            <Ordenavel itens={itensOrdem} max={limFotos} onOrdem={setOrdem} onTirar={mexendo ? undefined : (id) => void tirarFoto(id)} />
          </div>
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
          {canal === "shopee" && noEnvio}
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <Checkbox className="mt-0.5" checked={op.fora_do_ar !== false} onCheckedChange={(v) => setOp({ ...op, fora_do_ar: v === true })} />
            <span>
              {ml ? <>Criar e <b>pausar</b> em seguida</> : <>Criar <b>fora do ar</b> (não listado)</>}
              <span className="block text-[11px] text-muted-foreground">{ml
                ? "Recomendado: confira no Tiny se o anúncio foi ligado ao produto pelo SKU (é o que faz estoque e pedido funcionarem) e reative depois no Mercado Livre."
                : "Desmarcado (padrão): o anúncio nasce NO AR. Marque para criar sem listar e ativar depois no Seller Center."}</span>
            </span>
          </label>
          {mudou && <Button size="sm" variant="outline" onClick={() => setAplicado(op)}>Atualizar a conferência com o que mudei</Button>}
        </div>
      )}

      {modo === "atualizar" && alvosT.length > 0 && (
        <div className="rounded-md border p-3 space-y-1.5">
          <div className="text-sm"><b>Atualizar também</b> <span className="text-xs text-muted-foreground">— a mesma troca nos outros anúncios deste produto {NO} {MK}. As fotos atuais que ficam são as das mesmas posições.</span></div>
          {alvosT.map((o) => (
            <Tambem key={chaveT(o)} rascunho={rascunho} canal={canal} alvo={o} opcoes={opcoesT(o, false)} parado={mudou || previaQ.isFetching}
              marcado={tambem[chaveT(o)] === true} onMarcar={(v) => setTambem((x) => ({ ...x, [chaveT(o)]: v }))}
              onPronto={(v) => setProntoT((x) => (x[chaveT(o)] === v ? x : { ...x, [chaveT(o)]: v }))} />
          ))}
        </div>
      )}

      <FotosTiny sku={rascunho.sku} canal={canal} empresa={empresa} urls={fotosQ.data ?? {}}
        paths={[...finalOrdem.filter((x) => p.fotos.some((f) => f.path === x)), ...p.fotos.map((f) => f.path).filter((x) => !finalOrdem.includes(x))].slice(0, 9)} />

      {pend.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-1">
          <b className="text-destructive flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Falta resolver antes de enviar</b>
          {pend.map((x) => <div key={x}>• {x}</div>)}
        </div>
      )}
      {avisos.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs space-y-1 text-amber-700 dark:text-amber-400">
          {avisos.map((x) => (
            <div key={x}>• {/criar gera um anúncio simples/.test(x)
              ? "este produto tem variações: o anúncio é criado e, em seguida, as opções do bloco “Variações deste anúncio na Shopee” (logo acima) entram nele"
              : x}</div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button className="gap-1.5" disabled={enviando || mudou || previaQ.isFetching || pend.length > 0 || (modo === "criar" && !!criado && !deNovo)} onClick={() => void enviar()}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {enviando ? `Enviando para ${ART} ${MK}…` : modo === "atualizar" ? (extrasProntos.length ? `Atualizar os ${extrasProntos.length + 1} anúncios ${NO} ${MK}` : `Atualizar o anúncio ${NO} ${MK}`) : `Criar o anúncio ${NO} ${MK}`}
        </Button>
        {modo === "criar" && criado && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <Checkbox checked={deNovo} onCheckedChange={(v) => setDeNovo(v === true)} />este rascunho já criou um anúncio; criar outro mesmo assim
          </label>
        )}
        {mudou && <span className="text-xs text-muted-foreground">{modo === "atualizar" ? "Refazendo a conferência…" : "Atualize a conferência antes de enviar."}</span>}
      </div>

      {(recem || criado) && onIr && (demais ?? []).length > 0 && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-2">
          <div className="text-sm">
            <CheckCircle2 className="h-4 w-4 inline mr-1.5 -mt-0.5 text-emerald-600" />
            <b>Anúncio criado {NO} {MK}{recem ? ` (${recem})` : ""}.</b> <span className="text-xs text-muted-foreground">Enviar também para — o mesmo texto e as mesmas fotos; a conferência de cada um abre aqui:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {(demais ?? []).map((x) => {
              const n = x.lista?.length ?? 0;
              const soAtualiza = x.canal === "amazon";
              const parado = soAtualiza && x.lista !== undefined && n === 0;
              return (
                <Button key={`${x.canal}:${x.empresa}`} size="sm" variant={n > 0 ? "outline" : "default"} className="h-8 gap-1.5" disabled={enviando || parado}
                  title={parado ? "criar anúncio novo na Amazon ainda não está pronto por aqui" : undefined} onClick={() => onIr(x.canal, x.empresa)}>
                  <ArrowRight className="h-3.5 w-3.5" />{x.rotulo}
                  <span className="text-[10.5px] font-normal opacity-80">
                    {x.lista === undefined ? "verificando…" : x.lista === null ? "não consegui verificar" : n > 0 ? `já anunciado${n > 1 ? ` (${n})` : ""} · atualizar` : parado ? "ainda não cria por aqui" : "ainda não anunciado"}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      )}

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
/** Outro anúncio do mesmo produto que recebe a MESMA troca; é conferido em separado antes de entrar no envio. */
function Tambem({ rascunho, canal, alvo, opcoes, marcado, parado, onMarcar, onPronto }: {
  rascunho: IaRascunho; canal: string; alvo: Outro; opcoes: Record<string, unknown>; marcado: boolean; parado: boolean;
  onMarcar: (v: boolean) => void; onPronto: (v: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["ia-anuncio", "publicar-tambem", rascunho.id, rascunho.updated_at, canal, alvo.empresa, alvo.e.item_id, JSON.stringify(opcoes)],
    enabled: marcado && !parado,
    placeholderData: (anterior) => anterior,
    queryFn: async (): Promise<Resposta> => (await chamarPublicar("previa", { rascunho_id: rascunho.id, destino: { canal, empresa: alvo.empresa }, opcoes })) as Resposta,
  });
  const pend = q.data?.pendencias ?? [];
  const pronto = marcado && !parado && !!q.data?.previa && pend.length === 0 && !q.isFetching && !q.isError;
  useEffect(() => { onPronto(pronto); }, [pronto]);
  const e = alvo.e;
  return (
    <label className="flex items-start gap-2 rounded border px-2 py-1.5 cursor-pointer text-xs">
      <Checkbox className="mt-0.5" checked={marcado} onCheckedChange={(v) => onMarcar(v === true)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm"><b>{alvo.rotulo}</b> · {e.nome ?? e.item_id}</span>
        <span className="text-muted-foreground">
          código {e.item_id}
          {e.preco != null && <> · {formatBRL(e.preco)}</>}
          {e.vendas != null && <> · {e.vendas.toLocaleString("pt-BR")} venda{e.vendas === 1 ? "" : "s"}</>}
          {e.catalogo && <> · catálogo</>}
          {situacao(e.status) && <> · {situacao(e.status)}</>}
        </span>
        {marcado && (
          <span className="block mt-0.5">
            {q.isError ? <span className="text-destructive">não consegui conferir: {(q.error as Error).message}</span>
              : parado || q.isFetching || !q.data ? <span className="text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin inline mr-1 -mt-0.5" />conferindo…</span>
              : pend.length ? <span className="text-destructive">fica de fora: {pend.join(" · ")}</span>
              : <span className="text-emerald-700 dark:text-emerald-400">pronto: vai ficar com {(q.data.previa?.fotos_plano?.manter.length ?? 0) + (q.data.previa?.fotos_plano?.novas.length ?? 0)} foto(s)
                {(q.data.avisos ?? []).length > 0 && <span className="text-amber-600"> · {(q.data.avisos ?? []).slice(0, 2).join(" · ")}</span>}</span>}
          </span>
        )}
      </span>
      {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-0.5 shrink-0">abrir<ExternalLink className="h-3 w-3" /></a>}
    </label>
  );
}

/** Fotos na ordem final: arraste ou use as setas para mudar de lugar. A primeira é a capa. */
function Ordenavel({ itens, max, onOrdem, onTirar }: {
  itens: { id: string; url: string; legenda?: string }[]; max: number; onOrdem: (ids: string[]) => void; onTirar?: (id: string) => void;
}) {
  const [pego, setPego] = useState<string | null>(null);
  const [grande, setGrande] = useState<string | null>(null);
  if (!itens.length) return <span className="text-xs text-muted-foreground">nenhuma foto</span>;
  const ids = itens.map((x) => x.id);
  const mover = (id: string, para: number) => {
    const de = ids.indexOf(id);
    if (de === -1 || para < 0 || para >= ids.length || para === de) return;
    const n = [...ids]; n.splice(de, 1); n.splice(para, 0, id); onOrdem(n);
  };
  return (
    <div className="flex flex-wrap gap-2.5">
      {grande && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setGrande(null)}>
          <img src={grande} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
      {itens.map((f, i) => (
        <div key={f.id} draggable onDragStart={() => setPego(f.id)} onDragEnd={() => setPego(null)}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (pego) mover(pego, i); setPego(null); }}
          className={`w-36 cursor-grab ${pego === f.id || i >= max ? "opacity-40" : ""}`} title={i >= max ? "passa do limite de fotos: não vai" : "arraste para mudar a ordem"}>
          <div className={`relative h-36 w-36 rounded-md border-2 overflow-hidden bg-muted/30 ${i === 0 ? "border-primary" : "border-border"}`}>
            {f.url && <img src={f.url} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover cursor-zoom-in" onClick={() => setGrande(f.url)} />}
            <span className="absolute top-0 left-0 bg-background/85 px-1.5 py-0.5 text-[11px] font-semibold rounded-br">{i === 0 ? "capa" : i + 1}</span>
            {onTirar && (
              <button type="button" title="tirar esta foto do anúncio" onClick={() => onTirar(f.id)}
                className="absolute top-1 right-1 h-6 w-6 rounded-full bg-background/90 shadow flex items-center justify-center hover:bg-destructive hover:text-white">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-0.5">
            <button type="button" className="h-4 w-4 rounded hover:bg-muted disabled:opacity-30" disabled={i === 0} onClick={() => mover(f.id, i - 1)} title="mais para a frente">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="text-[11px] text-muted-foreground truncate capitalize px-0.5">{f.legenda ?? ""}</span>
            <button type="button" className="h-4 w-4 rounded hover:bg-muted disabled:opacity-30" disabled={i === itens.length - 1} onClick={() => mover(f.id, i + 1)} title="mais para trás">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
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
