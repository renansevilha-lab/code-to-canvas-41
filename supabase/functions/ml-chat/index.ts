// ============================================================================
// Edge Function: ml-chat v1 — atendimento do Mercado Livre com IA (26/nov/2026)
// ----------------------------------------------------------------------------
// Duas caixas por conta (ottz = 1107117809, svl = 1299638625):
//   * perguntas (antes da compra): GET /questions/search?status=UNANSWERED;
//     responder = POST /answers {question_id, text}  -> fica PUBLICO no anuncio.
//   * pos-venda (mensagens do pedido): GET /messages/unread?role=seller&tag=post_sale
//     e /messages/packs/{pack}/sellers/{seller}?tag=post_sale (mark_as_read=false);
//     responder = POST no mesmo caminho {from, to, text} (ate 350 caracteres;
//     conversa "blocked" — ex. pedido cancelado — nao aceita mensagem).
// Modulos (GET ou POST JSON):
//   caixa&conta=           perguntas sem resposta + pos-venda com nao lidas
//   conversa&conta=&pack=  mensagens do pos-venda + pedido (status, envio, rastreio)
//   pergunta&conta=&id=    pergunta + anuncio + perguntas anteriores do mesmo anuncio
//   sugerir {conta, tipo: pergunta|pos_venda, referencia, instrucao?} -> rascunho IA
//   responder {conta, tipo, referencia, texto, comprador_id?, sugestao_ia?, confirmar:"1", por?}
// Leitura e IA: so usuario logado (ou chave de ensaio temporaria); envio: so
// usuario logado. Cada envio grava atendimento_respostas. Token SEMPRE da conta.
// ============================================================================
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API = "https://api.mercadolibre.com";
const CONTAS: Record<string, { user_id: number; marca: string; assinatura: string }> = {
  ottz: { user_id: 1107117809, marca: "Ottz Pet", assinatura: "Equipe Ottz" },
  svl: { user_id: 1299638625, marca: "Bumi Pet", assinatura: "Equipe Bumi" },
};
const CHAVE_ENSAIO = "mlchat-ensaio-26nov-k3";
const ENSAIO_ATE = Date.parse("2026-11-27T03:00:00Z");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function jwt(req: Request): any {
  const tk = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  try {
    const p = tk.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p + "===".slice((p.length + 3) % 4)));
  } catch { return {}; }
}

async function token(sb: any, userId: number): Promise<string> {
  const { data } = await sb.from("oauth_tokens_ml").select("access_token").eq("user_id", userId).maybeSingle();
  if (!data?.access_token) throw new Error(`conta ML ${userId} sem token`);
  return data.access_token;
}

async function mlGet(tk: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${tk}` } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
}
async function mlPost(tk: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: { _raw: t.slice(0, 300) } }; }
}

// em paralelo, de N em N
async function emLotes<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...await Promise.all(xs.slice(i, i + n).map(f)));
  return out;
}

async function anuncios(sb: any, mlbs: string[]) {
  const m = new Map<string, any>();
  if (!mlbs.length) return m;
  const { data } = await sb.from("ml_anuncios").select("mlb, titulo, foto, preco, estoque, permalink, sku").in("mlb", mlbs);
  for (const a of (data || [])) m.set(a.mlb, a);
  return m;
}

const msgDe = (m: any, seller: number) => ({
  id: m.id,
  de_nos: Number(m.from?.user_id) === seller,
  texto: m.text ?? "",
  em: m.message_date?.created ?? m.message_date?.received ?? null,
  lida: !!m.message_date?.read,
  anexos: (m.message_attachments || []).map((a: any) => a.original_filename || a.filename).filter(Boolean),
  moderada: m.message_moderation?.status && m.message_moderation.status !== "clean" ? m.message_moderation.status : null,
});

async function lerConversa(sb: any, tk: string, seller: number, pack: string) {
  const r = await mlGet(tk, `/messages/packs/${pack}/sellers/${seller}?tag=post_sale&mark_as_read=false&limit=40`);
  if (r.status !== 200) return { erro: `${r.status} ${r.body?.message || r.body?.error || ""}`.trim() } as any;
  const msgs = (r.body.messages || []).map((m: any) => msgDe(m, seller))
    .sort((a: any, b: any) => String(a.em).localeCompare(String(b.em)));
  const compradorMsg = (r.body.messages || []).find((m: any) => Number(m.from?.user_id) !== seller);
  const nossaMsg = (r.body.messages || []).find((m: any) => Number(m.from?.user_id) === seller);
  const comprador_id = compradorMsg ? String(compradorMsg.from.user_id) : nossaMsg ? String(nossaMsg.to?.user_id ?? "") : null;
  const st = r.body.conversation_status || {};
  // pedido(s): pack -> orders; pedido avulso usa o proprio id
  let orderIds: string[] = [pack];
  const pk = await mlGet(tk, `/packs/${pack}`);
  if (pk.status === 200 && Array.isArray(pk.body.orders)) orderIds = pk.body.orders.map((o: any) => String(o.id));
  const pedidos = await emLotes(orderIds.slice(0, 4), 4, async (oid) => {
    const o = await mlGet(tk, `/orders/${oid}`);
    if (o.status !== 200) return null;
    const pg = (o.body.payments || []).find((x: any) => x.status === "approved") || (o.body.payments || [])[0];
    const ped: any = {
      pedido: String(o.body.id), status: o.body.status, criado: String(o.body.date_created || "").slice(0, 10),
      criado_em: o.body.date_created ?? null, pago_em: pg?.date_approved ?? null,
      pagamento: pg?.payment_type ?? null, parcelas: pg?.installments ?? null,
      total: o.body.total_amount, total_pago: o.body.paid_amount ?? null,
      itens: (o.body.order_items || []).map((i: any) => ({ mlb: i.item?.id, titulo: i.item?.title, qtd: i.quantity, preco: i.unit_price ?? null, variacao: (i.item?.variation_attributes || []).map((v: any) => v.value_name).join(" / ") || null })),
      envio: null as any,
      reclamacao: null as any,
    };
    const sid = o.body.shipping?.id;
    if (sid) {
      const s = await mlGet(tk, `/shipments/${sid}`);
      if (s.status === 200) ped.envio = {
        status: s.body.status, substatus: s.body.substatus, rastreio: s.body.tracking_number ?? null,
        modo: s.body.logistic_type ?? null, transportadora: s.body.tracking_method ?? null,
        previsao: s.body.shipping_option?.estimated_delivery_time?.date?.slice(0, 10) ?? null,
        despachar_ate: s.body.shipping_option?.estimated_handling_limit?.date?.slice(0, 10) ?? null,
        coletado_em: s.body.status_history?.date_shipped ?? null,
        entregue_em: s.body.status_history?.date_delivered ?? null,
      };
    }
    // v2: reclamacao/devolucao do pedido (espelho ml_claims, sem cancel_purchase)
    const { data: cl } = await sb.from("ml_claims")
      .select("claim_id, tipo, stage, status, reason_id, resolucao, prazo_acao, criado_em, acoes_disponiveis, return_id")
      .eq("order_id", String(o.body.id)).neq("tipo", "cancel_purchase").order("criado_em", { ascending: false }).limit(1).maybeSingle();
    if (cl) {
      const { data: mo } = cl.reason_id ? await sb.from("ml_claim_motivos").select("nome, detalhe").eq("reason_id", cl.reason_id).maybeSingle() : { data: null };
      ped.reclamacao = {
        id: String(cl.claim_id), tipo: cl.tipo, etapa: cl.stage, status: cl.status, motivo: mo?.detalhe || mo?.nome || cl.reason_id,
        resolucao: cl.resolucao ?? null, prazo: cl.prazo_acao ?? null, aberta_em: cl.criado_em ?? null,
        devolucao: !!cl.return_id, acoes: cl.acoes_disponiveis ?? null,
      };
    }
    return ped;
  });
  return {
    pack, comprador_id, mensagens: msgs,
    bloqueada: st.status === "blocked", motivo_bloqueio: st.substatus ?? null,
    pedidos: pedidos.filter(Boolean),
  };
}

const TOM_PADRAO = 'TOM: simpatico, humano e natural, sem formalidade de robo e sem exagero. Comece com "Oi, tudo bem?". Use "voce", frases diretas, no maximo 1 emoji.';

// v2 (26/nov): cliente que so agradece/encerra ("obrigada", "ok, valeu") recebe a resposta curta
// padrao do dono, sem cumprimento nem repetir o pedido — e sem gastar chamada da IA.
const RESPOSTA_AGRADECIMENTO = "Imagina, estamos à disposição.\n\nQualquer dúvida é só nos chamar! :)";
const RE_AGRADECIMENTO = /^(?:(?:muit[oa]s?|mt|mto|desde ja|ja|entao|ah|ahh|ta bom|tá bom|ta|tá|beleza|blz|ok|okay|certo|perfeito|otimo|ótimo|show|maravilha|entendi|combinado|tudo bem|tudo certo|aguardo|vou aguardar|fico no aguardo)[\s,.!]*)*(?:obrigad[oa]s?|obg|brigad[oa]|grat[oa]|gratidao|gratidão|agradeco|agradeço|valeu|vlw|thanks|ok|okay|blz|beleza|show|perfeito|certo|entendi|combinado|aguardo|fico no aguardo)?(?:[\s,.!]*(?:pela atencao|pela atenção|pelo retorno|pela ajuda|pela informacao|pela informação|mesmo|demais|viu|ta|tá|ate mais|até mais|bom dia|boa tarde|boa noite|abs|abraços?|[:;]-?\)|❤️|🙏|😊|🙂|👍|😀|😉|🥰|☺️))*[\s,.!]*$/i;
function soAgradecimento(conversa: { de: string; texto: string }[] | undefined): boolean {
  const c = (conversa || []).filter((m) => m.texto && m.texto.trim());
  const ult = c[c.length - 1];
  if (!ult || ult.de !== "cliente") return false;
  const t = ult.texto.trim().normalize("NFC");
  if (t.length > 60 || t.includes("?")) return false;
  // só agradecimento de verdade passa direto; "ok", "certo", "aguardo" sozinhos ficam com a IA
  return /(obrigad|obg|brigad|grat[oa]|gratid|agrade|valeu|vlw|thanks)/i.test(t) && RE_AGRADECIMENTO.test(t);
}

async function rascunhoIa(sb: any, conta: string, tipo: string, ctx: any, instrucao: string) {
  if (tipo !== "pergunta" && !instrucao && soAgradecimento(ctx?.conversa)) {
    return { sugestao: RESPOSTA_AGRADECIMENTO, precisa_humano: false, motivo: null, modelo: "regra: agradecimento", limite: 340 };
  }
  // tom de voz vem de atendimento_config (chave 'tom'): muda sem publicar a funcao
  const { data: cfg } = await sb.from("atendimento_config").select("valor").eq("chave", "tom").maybeSingle();
  const tom = cfg?.valor || TOM_PADRAO;
  const key = Deno.env.get("OPENAI_API_KEY") || "";
  if (!key) return { erro: "OPENAI_API_KEY nao cadastrada" };
  const modelo = Deno.env.get("MODELO_TEXTO_OPENAI") || "gpt-5.5";
  const c = CONTAS[conta];
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const limite = tipo === "pergunta" ? 800 : 340;
  const regras = [
    `Voce atende clientes da loja ${c.marca} no Mercado Livre Brasil (pet shop: areia para gatos, higiene e acessorios pet). Hoje e ${hoje}.`,
    tipo === "pergunta"
      ? "Responda a PERGUNTA de um interessado num anuncio. A resposta fica PUBLICA no anuncio: sem dados pessoais, sem numero de pedido. Responda com base no titulo/atributos do anuncio e nas respostas anteriores da loja; se a informacao nao estiver nos dados, diga que o detalhe esta na descricao/ficha do anuncio ou que nao temos essa informacao, sem inventar."
      : "Escreva a PROXIMA mensagem da loja na conversa pos-venda de um pedido.",
    `Portugues do Brasil, no maximo ${limite} caracteres (conte os caracteres: o limite e rigido).`,
    tom,
    `Termine com a assinatura "${c.assinatura}".`,
    ...(tipo === "pergunta" ? [] : [`EXCECAO: se a ultima mensagem do cliente for so agradecimento ou despedida, sem pergunta nova (ex.: "obrigada", "ok, valeu", "recebi, obrigado"), responda EXATAMENTE "${RESPOSTA_AGRADECIMENTO.replace(/\n/g, "\\n")}" — sem cumprimento, sem repetir pedido/prazo e sem assinatura.`]),
    "Use SOMENTE os dados fornecidos. Nunca invente prazo, rastreio, estoque, preco, medida ou composicao.",
    "NUNCA prometa reembolso, troca, desconto, cupom ou brinde. Problema com o produto ou entrega: acolha, peca foto/detalhes se faltar e oriente a usar 'Tenho um problema' / devolucao pelo Mercado Livre, dizendo que a equipe analisa com prioridade.",
    "Nunca passe telefone, WhatsApp, e-mail, redes sociais nem link externo (regra do Mercado Livre).",
    "Se exigir decisao humana (reclamacao grave, produto errado/quebrado, pedido de reembolso, ameaca, informacao que os dados nao respondem), marque precisa_humano=true e escreva uma resposta segura de acolhimento.",
    'Responda APENAS um JSON: {"resposta": "...", "precisa_humano": true|false, "motivo": "frase curta para a equipe"}.',
  ].join("\n");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelo, response_format: { type: "json_object" }, max_completion_tokens: 4000, reasoning_effort: "low",
      messages: [{ role: "system", content: regras }, { role: "user", content: JSON.stringify({ ...ctx, instrucao_da_equipe: instrucao || null }) }],
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as any));
  const t = await r.text();
  if (!r.ok) return { erro: `OpenAI ${r.status}: ${t.slice(0, 200)}` };
  try {
    const out = JSON.parse(JSON.parse(t).choices?.[0]?.message?.content || "{}");
    let resp = String(out.resposta || "").trim();
    if (resp.length > limite + 10) resp = resp.slice(0, limite);
    return { sugestao: resp, precisa_humano: !!out.precisa_humano, motivo: out.motivo || null, modelo, limite };
  } catch { return { erro: "resposta da IA fora do formato" }; }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const sb = createClient(SUPABASE_URL, SRK);
  const url = new URL(req.url);
  let corpo: any = {};
  if (req.method === "POST") { try { corpo = await req.json(); } catch { corpo = {}; } }
  const p = (k: string) => url.searchParams.get(k) ?? (corpo?.[k] != null ? String(corpo[k]) : null);
  const modulo = p("modulo") || "caixa";
  const j = jwt(req);
  const logado = j.role === "authenticated" || j.role === "service_role";
  const ensaio = p("chave") === CHAVE_ENSAIO && Date.now() < ENSAIO_ATE && modulo !== "responder";
  if (!logado && !ensaio) return json({ erro: "exige login" }, 401);

  const conta = (p("conta") || "ottz").toLowerCase();
  const c = CONTAS[conta];
  if (!c) return json({ erro: "conta deve ser ottz ou svl" }, 400);
  let tk: string;
  try { tk = await token(sb, c.user_id); } catch (e) { return json({ erro: (e as Error).message }, 500); }

  // ---------------------------------------------------------------- CAIXA
  if (modulo === "caixa") {
    const [perg, unread] = await Promise.all([
      mlGet(tk, `/questions/search?seller_id=${c.user_id}&status=UNANSWERED&api_version=4&limit=50&sort_fields=date_created&sort_types=DESC`),
      mlGet(tk, `/messages/unread?role=seller&tag=post_sale`),
    ]);
    const perguntas = (perg.body?.questions || []).map((q: any) => ({
      id: String(q.id), item_id: q.item_id, texto: q.text, em: q.date_created, comprador_id: q.from?.id != null ? String(q.from.id) : null,
    }));
    const amap = await anuncios(sb, [...new Set(perguntas.map((q: any) => q.item_id))] as string[]);
    for (const q of perguntas) { const a = amap.get(q.item_id); q.anuncio = a ? { titulo: a.titulo, foto: a.foto, preco: a.preco, estoque: a.estoque } : null; }

    const packs = (unread.body?.results || []).slice(0, 30).map((r: any) => ({
      pack: String(r.resource || "").split("/")[2], nao_lidas: r.count ?? 0,
    })).filter((x: any) => x.pack);
    const posVenda = await emLotes(packs, 6, async (x: any) => {
      // a lista vem da mais ANTIGA para a mais nova: le o total e pede a ultima
      let r = await mlGet(tk, `/messages/packs/${x.pack}/sellers/${c.user_id}?tag=post_sale&mark_as_read=false&limit=1`);
      const total = Number(r.body?.paging?.total ?? 0);
      if (total > 1) r = await mlGet(tk, `/messages/packs/${x.pack}/sellers/${c.user_id}?tag=post_sale&mark_as_read=false&limit=1&offset=${total - 1}`);
      const m = r.body?.messages?.[0];
      return {
        ...x,
        ultima_msg: m?.text ?? null, ultima_em: m?.message_date?.created ?? null,
        ultima_de_nos: m ? Number(m.from?.user_id) === c.user_id : false,
        comprador_id: m ? String(Number(m.from?.user_id) === c.user_id ? m.to?.user_id : m.from?.user_id) : null,
        bloqueada: r.body?.conversation_status?.status === "blocked",
        motivo_bloqueio: r.body?.conversation_status?.substatus ?? null,
        produto: null as string | null, status_pedido: null as string | null,
      };
    });
    // titulo do produto pelo espelho de pedidos (pack_id ou id do pedido)
    const ids = posVenda.map((x: any) => x.pack);
    if (ids.length) {
      const { data } = await sb.from("pedidos").select("id, pack_id, primeiro_produto, status_pedido")
        .eq("marketplace", "mercadolivre").or(`pack_id.in.(${ids.join(",")}),id.in.(${ids.join(",")})`);
      for (const x of posVenda as any[]) {
        const pd = (data || []).find((d: any) => String(d.pack_id) === x.pack || String(d.id) === x.pack);
        x.produto = pd?.primeiro_produto ?? null; x.status_pedido = pd?.status_pedido ?? null;
      }
    }
    return json({
      modulo, conta, perguntas, pos_venda: posVenda,
      totais: { perguntas: perg.body?.total ?? perguntas.length, pos_venda: unread.body?.total ?? posVenda.length },
      erros: [perg.status !== 200 ? `perguntas ${perg.status}` : null, unread.status !== 200 ? `mensagens ${unread.status}` : null].filter(Boolean),
    });
  }

  // ------------------------------------------------------------- CONVERSA
  if (modulo === "conversa") {
    const pack = (p("pack") || "").trim();
    if (!/^\d+$/.test(pack)) return json({ erro: "informe pack" }, 400);
    const r = await lerConversa(sb, tk, c.user_id, pack);
    if (r.erro) return json({ modulo, erro: r.erro }, 502);
    const amap = await anuncios(sb, r.pedidos.flatMap((x: any) => x.itens.map((i: any) => i.mlb)).filter(Boolean));
    for (const pd of r.pedidos) for (const i of pd.itens) { const a = amap.get(i.mlb); i.foto = a?.foto ?? null; i.sku = a?.sku ?? null; }
    return json({ modulo, conta, ...r });
  }

  // ------------------------------------------------------------- PERGUNTA
  if (modulo === "pergunta") {
    const id = (p("id") || "").trim();
    if (!/^\d+$/.test(id)) return json({ erro: "informe id" }, 400);
    const q = await mlGet(tk, `/questions/${id}?api_version=4`);
    if (q.status !== 200) return json({ modulo, erro: `${q.status} ${q.body?.message || ""}` }, 502);
    const item = q.body.item_id;
    const [it, ant] = await Promise.all([
      mlGet(tk, `/items/${item}?attributes=id,title,price,available_quantity,attributes,permalink,pictures`),
      mlGet(tk, `/questions/search?item=${item}&status=ANSWERED&api_version=4&limit=8&sort_fields=date_created&sort_types=DESC`),
    ]);
    return json({
      modulo, conta,
      pergunta: { id, texto: q.body.text, em: q.body.date_created, status: q.body.status, comprador_id: q.body.from?.id != null ? String(q.body.from.id) : null },
      anuncio: it.status === 200 ? {
        mlb: item, titulo: it.body.title, preco: it.body.price, estoque: it.body.available_quantity, link: it.body.permalink,
        foto: it.body.pictures?.[0]?.secure_url ?? null,
        atributos: (it.body.attributes || []).filter((a: any) => a.value_name).slice(0, 25).map((a: any) => `${a.name}: ${a.value_name}`),
      } : { mlb: item },
      anteriores: (ant.body?.questions || []).filter((x: any) => x.answer?.text).map((x: any) => ({ p: x.text, r: x.answer.text })),
    });
  }

  // -------------------------------------------------------------- SUGERIR
  if (modulo === "sugerir") {
    const tipo = p("tipo") === "pergunta" ? "pergunta" : "pos_venda";
    const ref = (p("referencia") || "").trim();
    if (!/^\d+$/.test(ref)) return json({ erro: "informe referencia" }, 400);
    let ctx: any;
    if (tipo === "pergunta") {
      const q = await mlGet(tk, `/questions/${ref}?api_version=4`);
      if (q.status !== 200) return json({ modulo, erro: `pergunta ${q.status}` }, 502);
      const [it, ant] = await Promise.all([
        mlGet(tk, `/items/${q.body.item_id}?attributes=title,price,available_quantity,attributes`),
        mlGet(tk, `/questions/search?item=${q.body.item_id}&status=ANSWERED&api_version=4&limit=8&sort_fields=date_created&sort_types=DESC`),
      ]);
      ctx = {
        pergunta: q.body.text,
        anuncio: { titulo: it.body?.title, preco: it.body?.price, estoque: it.body?.available_quantity,
          atributos: (it.body?.attributes || []).filter((a: any) => a.value_name).slice(0, 30).map((a: any) => `${a.name}: ${a.value_name}`) },
        respostas_anteriores_da_loja: (ant.body?.questions || []).filter((x: any) => x.answer?.text).map((x: any) => ({ pergunta: x.text, resposta: x.answer.text })),
      };
    } else {
      const r = await lerConversa(sb, tk, c.user_id, ref);
      if (r.erro) return json({ modulo, erro: r.erro }, 502);
      ctx = { conversa: r.mensagens.slice(-20).map((m: any) => ({ de: m.de_nos ? "loja" : "cliente", texto: m.texto, em: m.em })), pedidos: r.pedidos };
      if (r.bloqueada) return json({ modulo, erro: `conversa bloqueada pelo Mercado Livre (${r.motivo_bloqueio || "sem motivo"}) — nao aceita mensagem` }, 409);
    }
    const out = await rascunhoIa(sb, conta, tipo, ctx, (p("instrucao") || "").slice(0, 500));
    return json({ modulo, conta, tipo, referencia: ref, ...out });
  }

  // ------------------------------------------------------------ RESPONDER
  if (modulo === "responder") {
    if (j.role !== "authenticated") return json({ erro: "envio so por usuario logado" }, 401);
    const tipo = p("tipo") === "pergunta" ? "pergunta" : "pos_venda";
    const ref = (p("referencia") || "").trim();
    const texto = (p("texto") || "").trim();
    if (!/^\d+$/.test(ref) || !texto) return json({ erro: "informe referencia e texto" }, 400);
    const max = tipo === "pergunta" ? 2000 : 350;
    if (texto.length > max) return json({ erro: `texto passa de ${max} caracteres` }, 400);
    if (p("confirmar") !== "1") return json({ modulo, dry: true, conta, tipo, referencia: ref, texto, aviso: "repita com confirmar=1 para ENVIAR" });
    let r: { status: number; body: any };
    let compradorId = p("comprador_id");
    if (tipo === "pergunta") {
      r = await mlPost(tk, `/answers`, { question_id: Number(ref), text: texto });
    } else {
      if (!compradorId || !/^\d+$/.test(compradorId)) {
        const conv = await lerConversa(sb, tk, c.user_id, ref);
        compradorId = conv.comprador_id;
      }
      if (!compradorId) return json({ erro: "nao achei o comprador da conversa" }, 400);
      r = await mlPost(tk, `/messages/packs/${ref}/sellers/${c.user_id}?tag=post_sale`, {
        from: { user_id: String(c.user_id) }, to: { user_id: String(compradorId) }, text: texto,
      });
    }
    const ok = r.status >= 200 && r.status < 300;
    const sug = p("sugestao_ia");
    await sb.from("atendimento_respostas").insert({
      marketplace: "mercadolivre", conta, tipo, referencia: ref, comprador_id: compradorId ?? null, texto,
      sugestao_ia: sug, editado: sug == null ? null : sug.trim() !== texto, ok, resposta: r.body ?? null,
      por: p("por") || j.email || j.sub || null,
    });
    if (!ok) return json({ modulo, ok: false, erro: r.body?.message || r.body?.error || `HTTP ${r.status}`, causa: r.body?.cause ?? null }, 502);
    return json({ modulo, ok: true, conta, tipo, referencia: ref });
  }

  return json({ modulos: ["caixa", "conversa", "pergunta", "sugerir", "responder"] });
});
