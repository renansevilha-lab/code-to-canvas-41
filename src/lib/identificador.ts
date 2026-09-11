// ============================================================================
// Etiqueta IDENTIFICADORA do lote (TAG) — fonte única, usada pela Separação
// (fila por SKU e painel "Lotes do dia") e pela tela de Risco de cancelamento.
// ZPL 10x15 na Zebra ZD220 via fulfillment-inbound?modulo=imprimir. Regras:
// sai DEPOIS das etiquetas de envio do lote (fica em cima da tira; a faixa
// "ETIQUETAS ABAIXO" aponta para elas), mostra o PRAZO mais próximo da TAG,
// e no modo automático deduplica por 60s (dois fluxos podem disparar o mesmo
// lote em sequência).
// ============================================================================
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";

export interface TagLoteRow {
  id: number;
  data: string;
  sequencia: number;
  tag: string;
  grupo_origem: string;
  sku: string | null;
  tipo_envio: string | null;
  qtd_pedidos: number;
  qtd_pulados: number;
  status: "aplicada" | "embalada" | string;
  embalado_em: string | null;
  impresso_em?: string | null;
  criado_em: string;
}

export function diasAtePrazo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const diaSP = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // yyyy-mm-dd
  const hoje = diaSP(new Date());
  const prazo = diaSP(new Date(iso));
  return Math.round(
    (new Date(prazo + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) / 86400000,
  );
}

// Dedup da etiqueta identificadora. Os dois fluxos AUTOMÁTICOS (painel "Lotes do
// dia" ao fim do imprimirLote, e a fila por SKU) podem disparar o mesmo lote em
// sequência — saíam 2 identificadoras iguais. Guarda o último envio por tag; no
// modo auto, pula se saiu nos últimos 60s. Botão manual (sem auto) nunca bloqueia.
const IDENT_JANELA_MS = 60000;
const identImpressoEm = new Map<string, number>();

// Sanitiza texto pra ZPL: tira os caracteres de controle (^ ~) e troca o "·"
// (que a fonte da Zebra não tem) por "-". ^CI28 cuida dos acentos.
function zplSan(s: string): string {
  return (s || "").replace(/[\^~]/g, " ").replace(/·/g, "-").replace(/\s+/g, " ").trim();
}

// Gera 1 etiqueta ZPL (bobina 10x15, 203dpi / 812x1218 dots) com:
// LOTE (grande) + código de barras Code128 do tag + tag SKU/qtd + nome do
// produto + nº de pedidos + nº de produtos + método de envio. Calibrar layout
// na ZD220 física (tamanho/fonte/acentos) — este é o primeiro corte.
export function gerarZplIdentificador(o: {
  tag: string;
  grupo: string;
  produtoNome: string;
  pedidos: number;
  produtos: number | null;
  envio: string;
  prazo?: string | null;
}): string {
  const tag = zplSan(o.tag);
  const grupo = zplSan(o.grupo);
  const nome = zplSan(o.produtoNome).slice(0, 90);
  const envio = zplSan(o.envio || "-");
  const prod = o.produtos == null ? "-" : String(o.produtos);
  return [
    "^XA",
    "^CI28",
    "^PW812",
    "^LL1218",
    "^LH0,0",
    "^FO0,50^A0N,44,44^FB812,1,0,C,0^FDLOTE^FS",
    `^FO0,100^A0N,150,150^FB812,1,0,C,0^FD${tag}^FS`,
    `^FO156,270^BY4,2,120^BCN,120,N,N,N^FD${tag}^FS`,
    `^FO0,400^A0N,34,34^FB812,1,0,C,0^FD${tag}^FS`,
    "^FO40,470^GB732,74,3^FS",
    `^FO40,488^A0N,50,50^FB732,1,0,C,0^FD${grupo}^FS`,
    `^FO40,575^A0N,40,40^FB732,3,6,L,0^FD${nome}^FS`,
    "^FO40,740^GB350,140,3^FS",
    "^FO40,752^A0N,30,30^FB350,1,0,C,0^FDPEDIDOS^FS",
    `^FO40,790^A0N,80,80^FB350,1,0,C,0^FD${o.pedidos}^FS`,
    "^FO422,740^GB350,140,3^FS",
    "^FO422,752^A0N,30,30^FB350,1,0,C,0^FDPRODUTOS^FS",
    `^FO422,790^A0N,80,80^FB350,1,0,C,0^FD${prod}^FS`,
    "^FO40,910^GB732,90,90^FS",
    `^FO40,930^A0N,50,50^FB732,1,0,C,0^FR^FDENVIO: ${envio}^FS`,
    // prazo de despacho mais próximo do lote (min ship_by_date dos pedidos)
    ...(o.prazo ? [`^FO40,1012^A0N,44,44^FB732,1,0,C,0^FDPRAZO: ${zplSan(o.prazo)}^FS`] : []),
    // faixa "ETIQUETAS ABAIXO" com setas para baixo: na tira que pende da
    // impressora a identificadora sai POR ÚLTIMO e fica em cima; as etiquetas
    // do lote ficam penduradas ABAIXO dela — a seta evita pegar as de cima.
    "^FO40,1068^GB732,132,3^FS",
    "^FO130,1112^A0N,40,40^FB552,1,0,C,0^FDETIQUETAS DESTE LOTE^FS",
    "^FO130,1156^A0N,34,34^FB552,1,0,C,0^FDESTAO ABAIXO^FS",
    // seta esquerda (haste + chevron "V" desenhado com diagonais)
    "^FO86,1082^GB8,52,8^FS", "^FO60,1130^GD30,42,8,B,L^FS", "^FO90,1130^GD30,42,8,B,R^FS",
    // seta direita
    "^FO718,1082^GB8,52,8^FS", "^FO692,1130^GD30,42,8,B,L^FS", "^FO722,1130^GD30,42,8,B,R^FS",
    "^XZ",
  ].join("");
}

// Imprime a etiqueta identificadora de UM lote (ZPL cru via fulfillment-inbound
// -> PrintNode). Reutilizada pelos dois fluxos de impressão: por lote ("Lotes do
// dia") e por SKU (fila priorizada). No modo automático pula lote de 1 pedido.
// A lista "lotes de hoje" atualiza a cada 30s — uma TAG recém-criada (aplicar
// TAG + imprimir na mesma tacada) ainda não está no cache e a identificadora
// era pulada EM SILÊNCIO (caso real: TAG 1009-35 do ML, 10/set). Fallback: se
// não achar no cache, busca a TAG direto do banco.
export async function acharLoteDaTag(
  tag: string,
  lotesHoje: TagLoteRow[] | undefined,
): Promise<TagLoteRow | null> {
  const local = (lotesHoje ?? []).find((l) => l.tag === tag);
  if (local) return local;
  const { data } = await supabaseExternal
    .from("tags_lote").select("*").eq("tag", tag).maybeSingle();
  return (data as TagLoteRow | null) ?? null;
}

export async function imprimirIdentificadorApi(
  lote: TagLoteRow,
  printerId: number,
  opts?: { auto?: boolean },
): Promise<void> {
  // Conta SEMPRE pela TAG do sistema (lote.qtd_pedidos) — fonte da verdade.
  // NÃO usar a contagem de etiquetas enviadas: a etiqueta Shopee tem ~2 blocos
  // ^XA por pedido, então "enviadas" dava ~2x (8 pedidos apareciam como 14/16).
  const pedidosReal = lote.qtd_pedidos;
  // Sai para TODO lote, inclusive de 1 pedido (10/set: a bancada recebeu 3
  // etiquetas ML de lotes unitários sem identificadora e não soube a TAG).
  if (!printerId) {
    if (!opts?.auto) toast.warning("Escolha a impressora primeiro.");
    return;
  }
  // Dedup no modo auto: pula se a identificadora deste lote já saiu nos últimos
  // 60s (evita as 2 iguais quando painel + por-SKU disparam em sequência).
  // Reserva o slot ANTES do await pra também barrar chamadas quase simultâneas.
  const ultimoIdent = identImpressoEm.get(lote.tag);
  if (opts?.auto && ultimoIdent != null && Date.now() - ultimoIdent < IDENT_JANELA_MS) return;
  identImpressoEm.set(lote.tag, Date.now());
  try {
    let produtoNome = "Vários itens";
    if (lote.sku) {
      const { data } = await supabaseExternal
        .from("produtos").select("nome").eq("sku", lote.sku).maybeSingle();
      produtoNome = (data as { nome?: string } | null)?.nome || `SKU ${lote.sku}`;
    }
    const mUn = /(\d+)\s*un\s*$/i.exec(lote.grupo_origem ?? "");
    const unPorPedido = mUn ? Number(mUn[1]) : null;
    const produtos = unPorPedido != null ? unPorPedido * pedidosReal : null;
    // prazo de despacho mais próximo entre os pedidos da TAG (separacao_tiny
    // cobre todas as situações — a view de fila só mostra situação 1)
    let prazo: string | null = null;
    try {
      const { data: sep } = await supabaseExternal
        .from("separacao_tiny").select("numero_ecommerce").eq("tag_lote", lote.tag).limit(500);
      const sns = ((sep ?? []) as { numero_ecommerce: string | null }[])
        .map((r) => r.numero_ecommerce).filter((x): x is string => !!x);
      if (sns.length > 0) {
        const { data: pz } = await supabaseExternal
          .from("pedidos").select("ship_by_date").in("id", sns)
          .not("ship_by_date", "is", null).order("ship_by_date", { ascending: true }).limit(1);
        const iso = (pz?.[0] as { ship_by_date?: string } | undefined)?.ship_by_date ?? null;
        const dias = diasAtePrazo(iso);
        if (iso && dias != null) {
          const ddmm = new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
          prazo = dias < 0 ? `VENCIDO ${ddmm}` : dias === 0 ? `HOJE ${ddmm}` : dias === 1 ? `AMANHA ${ddmm}` : `${ddmm} (${dias} dias)`;
        }
      }
    } catch { /* sem prazo não impede a identificadora */ }
    const zpl = gerarZplIdentificador({
      tag: lote.tag,
      grupo: lote.grupo_origem ?? "",
      produtoNome,
      pedidos: pedidosReal,
      produtos,
      envio: lote.tipo_envio ?? "-",
      prazo,
    });
    const { data: res, error } = await supabaseExternal.functions.invoke("fulfillment-inbound", {
      body: { modulo: "imprimir", zpl, printer_id: printerId, title: `Identificador ${lote.tag}` },
    });
    if (error) throw new Error(error.message);
    if (!(res as { ok?: boolean })?.ok) {
      throw new Error(JSON.stringify((res as { resposta?: unknown })?.resposta ?? res));
    }
    if (!opts?.auto) toast.success(`Identificador do lote ${lote.tag} enviado à impressora`);
  } catch (e) {
    identImpressoEm.delete(lote.tag); // libera pra retentar se falhou
    toast.error(`Falha no identificador do lote ${lote.tag}`, { description: (e as Error).message });
  }
}

