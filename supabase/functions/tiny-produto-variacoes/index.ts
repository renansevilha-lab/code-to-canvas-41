// ============================================================================
// Edge Function: tiny-produto-variacoes v6 (14/out/2026)
// ----------------------------------------------------------------------------
// Cria NO TINY, a partir de um produto simples, um produto COM VARIAÇÕES em que cada
// variação é um KIT do produto base (ex.: "1 unidades", "2 unidades", "3 unidades") —
// a mesma estrutura que a equipe monta à mão hoje (pai 16181 → 16176/16177/16178 = 1×/2×/3× 15820).
// Como nasce no Tiny, o anúncio enviado depois pelo Tiny já sai ligado ao produto.
//   POST ?modulo=sugerir {base_sku, n?}  → dados do produto base + próximos SKUs livres (sugestão)
//   POST ?modulo=previa  {base_sku, nome, sku_pai, grade, variacoes:[{sku, rotulo, quantidade, preco}]}
//        → confere tudo (SKUs livres no espelho e no Tiny) e devolve o que SERIA criado. Não escreve.
//   POST ?modulo=criar   {…o mesmo…, confirmar: true}
//   POST ?modulo=kit     {id_variacao, quantidade, base_sku, confirmar: true} → refaz só o passo do kit
// O que o ensaio de 12/out mostrou (produto de teste TESTE-APP-208691):
//  - API v3 `POST /produtos` (tipo V + grade + variacoes) cria o pai e as variações, mas EXIGE o SKU
//    do pai e de cada variação (o Tiny não numera sozinho pela API) e a variação nasce SIMPLES;
//  - v3 não deixa transformar a variação em kit (`PUT /produtos/{id}/kit` = "Produto não é do tipo
//    'Kit'"; `tipo`/`kit` na variação são ignorados; `PUT /produtos/{id}` na variação = 404);
//  - API v2 `produto.alterar.php` com `classe_produto: "K"` + `kit` TRANSFORMA a variação em kit e
//    mantém o vínculo com o pai. É o passo 2 desta função;
//  - excluir pela API não funciona (v3 DELETE = 403; v2 não aceita situação "E"): produto criado
//    por engano se apaga na tela do Tiny.
// v2: os SKUs sugeridos são conferidos AO VIVO no Tiny (o espelho só se atualiza de madrugada: no 1º
//  uso sugeriu 16476–16481, que o dono tinha criado no Tiny horas antes) e a mensagem de SKU ocupado
//  deixa claro que o nome citado é o do OUTRO produto que já usa aquele número.
// v3: grava no espelho `situacao`, `tipo_variacao` e `sku_pai` dos produtos criados (colunas do pacote do
//  catálogo, 12/out): as variações já aparecem dentro do pai na lista, sem esperar a sincronização.
// v4 (pedido do dono): o produto criado HERDA A FOTO PRINCIPAL do produto base (1º anexo dele no Tiny),
//  no pai e em cada variação — `POST /produtos/{id}/anexos`, primeiro pedindo ao Tiny uma cópia
//  (`externo: false`) e, se ele recusar, como endereço externo. O espelho marca quem nasceu aqui
//  (`produtos.criado_app_em` + `sku_base`), base do filtro "Criados no app" da lista de anúncios.
//   POST ?modulo=foto {sku_pai, confirmar: true} → põe a foto do produto base em quem da família ainda não tem
// v5 (pedido do dono): FOTOS DO ANÚNCIO → TINY.
//   POST ?modulo=fotos-anuncio {itens: [{sku, paths: [caminho no bucket ia-anuncios]}], confirmar?}
//   Sem `confirmar`: só diz quantas fotos o produto tem no Tiny. Com: cada foto entra no produto como CÓPIA
//   do Tiny (`externo: false` — o endereço assinado daqui vence, então nunca como endereço externo) e o 1º
//   anexo do produto passa a ser a foto dele no sistema na hora (`produtos.foto_capa`). Só aceita foto que é
//   do anúncio daquele SKU. Para aos ~24 s e devolve `faltou` (o que não deu tempo), para a tela continuar.
// v6 (14/out/2026, pedido do dono: carpete em 5 cores × quantidades num anúncio só): VÁRIAS BASES e DUAS GRADES.
//   `grades: ["Cor", "Quantidade"]` e cada variação com `base_sku` (o produto daquela cor) e `valores: ["Bege", "2 un"]`
//   → a variação vira kit de N× o produto DA COR dela (a venda baixa o estoque certo). Sem `grades`/`valores`
//   vale o formato antigo (`grade` + `rotulo`, uma base). Para caber nos 30 s com muitas variações: o espelho é
//   gravado logo depois do POST e os kits/fotos param aos ~20 s — o que faltou volta com `pendente: true` (kit)
//   e em `foto.sem_foto`, e a tela termina pelos módulos `kit` e `foto`. A foto de cada variação é a do produto DA COR dela.
//   POST ?modulo=grade {sku_pai} → grade(s) e valores de cada variação, lidos ao vivo do Tiny (só leitura).
// Regras: sessão de usuário com o módulo `ia`; escrita NÃO é repetida (um POST repetido criaria
// produto em dobro); a v2 tem limite de 60 chamadas/min e no código 6 a função para.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SB_URL, SRK);
const TINY = "https://api.tiny.com.br/public-api/v3";
const V2 = "https://api.tiny.com.br/api2";
const V2_TOKEN = (Deno.env.get("TINY_V2_TOKEN") || "").trim();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

type Quem = { id: string; nome: string | null };
async function exigirAcesso(req: Request): Promise<Quem | Response> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let pl: Record<string, unknown> = {};
  try { pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { /* sem jwt */ }
  if (pl.role !== "authenticated") return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const doUsuario = createClient(SB_URL, ANON || SRK, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
  const { data, error } = await doUsuario.rpc("tem_modulo", { p_modulo: "ia" });
  if (error || data !== true) return json({ erro: "sem acesso ao módulo IA · Anúncios" }, 403);
  const { data: perfil } = await db.from("perfis_usuario").select("nome").eq("user_id", String(pl.sub ?? "")).maybeSingle();
  return { id: String(pl.sub ?? ""), nome: (perfil?.nome as string) ?? (pl.email as string) ?? null };
}

/** Token da conta principal do Tiny (sempre `ottz`: nunca "o mais recente"). */
async function tokenTiny(): Promise<string> {
  const { data } = await db.from("oauth_tokens_tiny").select("access_token, expires_at").eq("conta", "ottz").limit(1).single();
  if (!data) throw new Error("token do Tiny (conta ottz) não encontrado");
  if (new Date(data.expires_at as string) < new Date()) throw new Error("token do Tiny vencido — a renovação automática roda de 30 em 30 min; tente de novo em instantes");
  return String(data.access_token);
}
async function v3(token: string, metodo: string, path: string, corpo?: unknown) {
  const r = await fetch(`${TINY}${path}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { mensagem: txt.slice(0, 300) }; }
  await sleep(600); // ~1 chamada/s do Tiny
  return { status: r.status, body };
}
/** API v2 (uma chamada, sem repetir: no código 6 o Tiny reinicia a espera a cada tentativa). */
async function v2(servico: string, campos: Record<string, string>) {
  const fd = new URLSearchParams({ token: V2_TOKEN, formato: "json", ...campos });
  const r = await fetch(`${V2}/${servico}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: fd.toString() });
  const txt = await r.text();
  let body: any = null; try { body = JSON.parse(txt); } catch { body = { retorno: { status: "Erro", erros: [{ erro: txt.slice(0, 200) }] } }; }
  await sleep(1100);
  return body?.retorno ?? {};
}
const erroV3 = (b: any) => [b?.mensagem, ...((b?.detalhes ?? []) as any[]).map((d) => `${d.campo}: ${d.mensagem}`)].filter(Boolean).join(" · ").slice(0, 400);
const erroV2 = (ret: any) => {
  const reg = ret?.registros?.[0]?.registro;
  const erros = [...((ret?.erros ?? []) as any[]), ...((reg?.erros ?? []) as any[])].map((e) => String(e?.erro ?? e)).join(" · ");
  return { codigo: String(reg?.codigo_erro ?? ret?.codigo_erro ?? ""), texto: erros || String(ret?.status ?? "erro") };
};

/** `valores` = um valor por grade (["Bege", "2 un"]); `rotulo` = os valores juntos ("Bege - 2 un"), que é o fim do nome. */
type Variacao = { sku: string; rotulo: string; valores: string[]; baseSku: string; quantidade: number; preco: number };
type Pedido = { baseSku: string; nome: string; skuPai: string; grade: string; grades: string[]; variacoes: Variacao[] };
function lerPedido(body: Record<string, any>): Pedido {
  const baseSku = String(body.base_sku ?? "").trim();
  const grades: string[] = (Array.isArray(body.grades) && body.grades.length ? body.grades : [body.grade ?? "Tamanho"])
    .map((g: unknown) => String(g ?? "").trim() || "Tamanho").slice(0, 2);
  const variacoes: Variacao[] = (Array.isArray(body.variacoes) ? body.variacoes : []).map((v: any) => {
    const valores = (Array.isArray(v?.valores) && v.valores.length ? v.valores : [v?.rotulo ?? ""])
      .map((x: unknown) => String(x ?? "").trim()).slice(0, grades.length) as string[];
    return {
      sku: String(v?.sku ?? "").trim(), valores, rotulo: valores.join(" - "),
      baseSku: String(v?.base_sku ?? "").trim() || baseSku,
      quantidade: Math.floor(num(v?.quantidade) ?? 0), preco: num(v?.preco) ?? 0,
    };
  });
  return {
    baseSku: baseSku || variacoes[0]?.baseSku || "", nome: String(body.nome ?? "").trim(), skuPai: String(body.sku_pai ?? "").trim(),
    grade: grades[0], grades, variacoes,
  };
}
/** Bases distintas do pedido, na ordem em que aparecem (a 1ª é a principal: dela saem unidade, NCM, marca e categoria). */
const basesDe = (pd: Pedido) => [...new Set([pd.baseSku, ...pd.variacoes.map((v) => v.baseSku)].filter(Boolean))];

/** Produto base no espelho + o cadastro dele no Tiny (de onde saem unidade, NCM, origem, marca e categoria). */
async function carregarBase(token: string, sku: string) {
  const { data: p } = await db.from("produtos").select("sku, id_tiny, nome, tipo, preco, ativo").eq("sku", sku).maybeSingle();
  if (!p?.id_tiny) throw new Error(`produto ${sku} não está no catálogo (ou sem o código do Tiny)`);
  const d = await v3(token, "GET", `/produtos/${p.id_tiny}`);
  if (d.status !== 200) throw new Error(`não consegui ler o produto ${sku} no Tiny: ${erroV3(d.body) || d.status}`);
  const { data: cmv } = await db.from("view_cmv_efetivo").select("cmv_efetivo").eq("sku", sku).maybeSingle();
  return { espelho: p as Record<string, any>, det: d.body as Record<string, any>, custo: num(cmv?.cmv_efetivo) };
}
/** SKU já usado? Olha o espelho e, ao vivo, o Tiny (o espelho só conhece os ativos). */
async function skusOcupados(token: string, skus: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data } = await db.from("produtos").select("sku, nome").in("sku", skus);
  for (const x of ((data ?? []) as any[])) out.set(String(x.sku), `já está em uso por OUTRO produto do catálogo ("${String(x.nome ?? "").slice(0, 60)}"): troque o número`);
  // v6: ao vivo no Tiny de 6 em 6 (com 30+ variações, um por vez estourava o tempo da função)
  const faltam = skus.filter((s) => !out.has(s));
  for (let i = 0; i < faltam.length; i += 6) {
    if (i) await sleep(400);
    await Promise.all(faltam.slice(i, i + 6).map(async (s) => {
      const r = await v3(token, "GET", `/produtos?codigo=${encodeURIComponent(s)}&limit=1`);
      const it = (r.body?.itens ?? [])[0];
      if (it && String(it.sku) === s) out.set(s, `já está em uso no Tiny por OUTRO produto ("${String(it.descricao ?? "").slice(0, 60)}"): troque o número`);
    }));
  }
  return out;
}

/** Este SKU já é de algum produto no Tiny? (sem espera embutida: para sondar alguns de uma vez; null = não deu para saber) */
async function ocupadoNoTiny(token: string, sku: string): Promise<boolean | null> {
  try {
    const r = await fetch(`${TINY}/produtos?codigo=${encodeURIComponent(sku)}&limit=1`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) return null;
    const b = await r.json().catch(() => null);
    return String(b?.itens?.[0]?.sku ?? "") === sku;
  } catch { return null; }
}
/** Próximos SKUs numéricos realmente LIVRES: parte do maior do espelho e confere no Tiny, 6 por vez. */
async function skusLivres(token: string, quantos: number): Promise<string[]> {
  const { data: maior } = await db.from("produtos").select("sku").filter("sku", "match", "^[0-9]{5}$").order("sku", { ascending: false }).limit(1);
  const ini = Number(maior?.[0]?.sku ?? 0) + 1;
  const livres: string[] = [];
  if (ini <= 1) return livres;
  for (let de = ini; livres.length < quantos && de < ini + 72; de += 6) {
    const lote = Array.from({ length: 6 }, (_, i) => String(de + i));
    const res = await Promise.all(lote.map((s) => ocupadoNoTiny(token, s)));
    lote.forEach((s, i) => { if (res[i] === false && livres.length < quantos) livres.push(s); });
    await sleep(500);
  }
  return livres;
}

async function conferir(token: string, pd: Pedido) {
  const pend: string[] = []; const avisos: string[] = [];
  const skusBase = basesDe(pd);
  if (skusBase.length > 20) throw new Error("no máximo 20 produtos base");
  // cada base, lida no espelho e AO VIVO no Tiny (uma por vez: o Tiny limita as chamadas)
  const bases = new Map<string, Awaited<ReturnType<typeof carregarBase>>>();
  for (const s of skusBase) bases.set(s, await carregarBase(token, s));
  const base = bases.get(pd.baseSku)!;
  const multi = skusBase.length > 1;
  for (const [s, b] of bases) {
    const quem = multi ? `o produto base ${s}` : "o produto base";
    if (b.det.tipo !== "S") pend.push(`${quem} precisa ser SIMPLES no Tiny (é do tipo ${b.det.tipo})`);
    if (b.det.tipoVariacao && b.det.tipoVariacao !== "N") pend.push(`${quem} já é pai ou variação de outro produto`);
  }
  if (!pd.nome) pend.push("dê um nome ao produto com variações");
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(pd.skuPai)) pend.push("informe o SKU do produto pai (letras, números, ponto ou hífen)");
  pd.grades.forEach((g) => { if (g.length > 14) pend.push(`o nome da grade "${g}" tem ${g.length} caracteres (a Shopee aceita até 14)`); });
  if (pd.grades.length === 2 && pd.grades[0].toLowerCase() === pd.grades[1].toLowerCase()) pend.push("as duas grades têm o mesmo nome");
  if (pd.variacoes.length < 2) pend.push("informe ao menos 2 variações");
  if (pd.variacoes.length > 50) pend.push("no máximo 50 variações por produto (limite da Shopee)");
  pd.variacoes.forEach((v, i) => {
    const n = `variação ${i + 1}`;
    v.valores.forEach((x, j) => {
      const g = pd.grades.length > 1 ? ` (${pd.grades[j]})` : "";
      if (!x) pend.push(`${n}: escreva o nome da opção${g} (ex.: "2 unidades")`);
      else if (x.length > 20) pend.push(`${n}: "${x}" tem ${x.length} caracteres (a Shopee aceita até 20)`);
    });
    if (v.valores.length < pd.grades.length) pend.push(`${n}: falta o valor de cada grade`);
    if (!/^[A-Za-z0-9._-]{1,30}$/.test(v.sku)) pend.push(`${n}: informe o SKU`);
    if (!(v.quantidade >= 1)) pend.push(`${n}: a quantidade do produto base no kit precisa ser 1 ou mais`);
    if (!(v.preco > 0)) pend.push(`${n}: informe o preço`);
  });
  const todos = [pd.skuPai, ...pd.variacoes.map((v) => v.sku)].filter(Boolean);
  if (new Set(todos).size !== todos.length) pend.push("há SKU repetido entre o pai e as variações");
  if (todos.some((s) => skusBase.includes(s))) pend.push("um SKU novo é igual ao de um produto base");
  if (new Set(pd.variacoes.map((v) => v.rotulo.toLowerCase())).size !== pd.variacoes.length) pend.push("há duas variações com o mesmo nome");
  if (pd.grades.length === 2) {
    // a Shopee exige a grade COMPLETA: toda cor com toda quantidade
    const a = new Set(pd.variacoes.map((v) => v.valores[0]?.toLowerCase())); const b = new Set(pd.variacoes.map((v) => v.valores[1]?.toLowerCase()));
    if (a.size * b.size !== pd.variacoes.length) pend.push(`a grade precisa estar completa: ${a.size} × ${b.size} = ${a.size * b.size} combinações, mas há ${pd.variacoes.length}`);
  }
  if (!pend.length) {
    const ocupados = await skusOcupados(token, todos);
    for (const [s, motivo] of ocupados) pend.push(`SKU ${s} ${motivo}`);
  }
  if (!V2_TOKEN) pend.push("falta a chave da API antiga do Tiny (TINY_V2_TOKEN): sem ela a variação não vira kit");
  for (const [s, b] of bases) if (b.custo == null) avisos.push(`${multi ? `o produto ${s}` : "o produto base"} está sem custo na gestão: o kit vai ficar sem CMV`);
  const semFotoBase = [...bases].filter(([, b]) => !fotoPrincipal(b.det)).map(([s]) => s);
  if (semFotoBase.length) avisos.push(`sem foto no Tiny: ${semFotoBase.join(", ")} — as variações dele(s) nascem sem foto`);
  else avisos.push(multi ? "cada variação recebe a foto principal do produto da cor dela; o pai, a do primeiro" : "o pai e cada variação recebem a foto principal do produto base");
  avisos.push("o produto é criado no Tiny e fica ATIVO; excluir pela API não funciona — se criar por engano, apague na tela do Tiny");
  avisos.push(multi ? "o estoque de cada variação é o do kit: sai do produto da cor dela" : "o estoque de cada variação é o do kit (sai do produto base); o envio para a Shopee é feito depois, pelo Tiny");
  if (pd.variacoes.length > 12) avisos.push(`com ${pd.variacoes.length} variações, transformar todas em kit leva mais de 30 s: a tela termina sozinha o que faltar`);
  const d = base.det;
  const corpo: Record<string, unknown> = {
    tipo: "V", sku: pd.skuPai, descricao: pd.nome, unidade: d.unidade || "UN", origem: Number(d.origem ?? 0), grade: pd.grades,
    ...(d.ncm ? { ncm: d.ncm } : {}), ...(!multi && d.gtin ? { gtin: d.gtin } : {}),
    ...(d.marca?.id ? { marca: { id: d.marca.id } } : {}), ...(d.categoria?.id ? { categoria: { id: d.categoria.id } } : {}),
    precos: { preco: Math.max(...pd.variacoes.map((v) => v.preco), 0) },
    variacoes: pd.variacoes.map((v) => {
      const gtin = bases.get(v.baseSku)?.det.gtin;
      return { sku: v.sku, ...(gtin ? { gtin } : {}), precos: { preco: v.preco }, grade: pd.grades.map((g, j) => ({ chave: g, valor: v.valores[j] ?? "" })) };
    }),
  };
  const custoDe = (v: Variacao) => { const c = bases.get(v.baseSku)?.custo; return c != null ? Number((c * v.quantidade).toFixed(2)) : null; };
  return {
    base, bases, corpo, pendencias: [...new Set(pend)], avisos,
    previa: {
      base: { sku: pd.baseSku, nome: d.descricao, preco: num(d.precos?.preco), custo: base.custo, marca: d.marca?.nome ?? null, ncm: d.ncm ?? null },
      bases: [...bases].map(([s, b]) => ({ sku: s, nome: b.det.descricao, preco: num(b.det.precos?.preco), custo: b.custo })),
      pai: { sku: pd.skuPai, nome: pd.nome, grade: pd.grade, grades: pd.grades },
      variacoes: pd.variacoes.map((v) => ({ ...v, base_sku: v.baseSku, nome: `${pd.nome} - ${v.rotulo}`, custo: custoDe(v) })),
    },
  };
}

/** Passo 2: a variação (nascida simples) vira KIT do produto base, pela API v2. */
async function virarKit(token: string, idVariacao: number, idBase: number, quantidade: number) {
  const g = await v3(token, "GET", `/produtos/${idVariacao}`);
  if (g.status !== 200) return { ok: false, erro: `não consegui ler a variação ${idVariacao}: ${erroV3(g.body) || g.status}` };
  const d = g.body;
  if (d.tipoVariacao !== "V") return { ok: false, erro: "este produto não é uma variação" };
  const produto: Record<string, unknown> = {
    sequencia: "1", id: idVariacao, codigo: d.sku, nome: d.descricao, unidade: d.unidade || "UN", preco: Number(d.precos?.preco ?? 0),
    origem: String(d.origem ?? 0), situacao: "A", tipo: "P", classe_produto: "K",
    ...(d.ncm ? { ncm: d.ncm } : {}), ...(d.gtin ? { gtin: d.gtin } : {}),
    kit: [{ item: { id_produto: idBase, quantidade } }],
  };
  const ret = await v2("produto.alterar.php", { produto: JSON.stringify({ produtos: [{ produto }] }) });
  const regOk = String(ret?.registros?.[0]?.registro?.status ?? ret?.status ?? "") === "OK";
  if (!regOk) { const e = erroV2(ret); return { ok: false, erro: `o Tiny recusou transformar em kit: ${e.texto}`, limite: e.codigo === "6" }; }
  const c = await v3(token, "GET", `/produtos/${idVariacao}`);
  const kit = ((c.body?.kit ?? []) as any[]).map((k) => ({ sku: k.produto?.sku, quantidade: Number(k.quantidade) }));
  const certo = c.body?.tipo === "K" && kit.length === 1 && Number(kit[0].quantidade) === quantidade;
  return { ok: certo, erro: certo ? null : "o Tiny respondeu OK, mas a variação não ficou como kit — confira no Tiny", sku: c.body?.sku, tipo: c.body?.tipo, kit, preco: num(c.body?.precos?.preco) };
}

/** Foto principal de um produto do Tiny = o 1º anexo com endereço (a mesma regra do `foto_capa` do espelho). */
const fotoPrincipal = (det: any): string | null => {
  const a = ((det?.anexos ?? []) as any[]).find((x) => x?.url);
  return a ? String(a.url) : null;
};
/** Põe UMA foto no produto. 1ª tentativa: o Tiny guarda uma cópia (`externo: false`) — assim a foto não depende do
 *  arquivo do produto base, que o Tiny apaga quando a foto de lá é trocada. Se ele recusar o pedido (400/422, nada
 *  foi gravado), vai como endereço externo. Erro de outro tipo não é repetido (repetir poderia pôr a foto em dobro). */
async function porFoto(token: string, id: number, url: string, externo?: boolean) {
  let erro = "";
  for (const modo of (externo === undefined ? [false, true] : [externo])) {
    const r = await v3(token, "POST", `/produtos/${id}/anexos`, [{ url, externo: modo }]);
    if (r.status >= 200 && r.status < 300) {
      const lista = (Array.isArray(r.body) ? r.body : []) as any[];
      return { ok: true, externo: modo, url: String(lista.find((x) => x?.url)?.url ?? url), resposta: lista, erro: null as string | null };
    }
    erro = erroV3(r.body) || String(r.status);
    if (r.status !== 400 && r.status !== 422) break;
  }
  return { ok: false, externo: null, url: null, resposta: null, erro: `o Tiny recusou a foto: ${erro}` };
}
/** A família criada pelo app (pai + variações) recebe a foto principal do produto base — só quem ainda não tem foto. */
async function fotosDaFamilia(token: string, skuPai: string, dry: boolean, externo?: boolean) {
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(skuPai)) return { ok: false, erro: "informe sku_pai" };
  const t0 = Date.now();
  const { data } = await db.from("produtos").select("sku, id_tiny, nome, sku_base, criado_app_em, foto_capa")
    .or(`sku.eq.${skuPai},sku_pai.eq.${skuPai}`).not("criado_app_em", "is", null).not("id_tiny", "is", null).order("sku");
  const linhas = (data ?? []) as any[];
  const pai = linhas.find((x) => x.sku === skuPai);
  if (!pai?.sku_base) return { ok: false, erro: `o produto ${skuPai} não foi criado pelo app (não sei qual é o produto base dele)` };
  const base = await carregarBase(token, String(pai.sku_base));
  const url = fotoPrincipal(base.det);
  // v6: cada variação recebe a foto do produto DELA (o componente do kit — no carpete, a cor); sem kit, a do base
  const { data: ks } = await db.from("produto_kits").select("sku_kit, sku_componente").in("sku_kit", linhas.map((x) => x.sku));
  const compDe = new Map<string, string>();
  for (const k of ((ks ?? []) as any[])) compDe.set(String(k.sku_kit), compDe.has(String(k.sku_kit)) ? "" : String(k.sku_componente));
  const fotoDeBase = new Map<string, string | null>([[String(pai.sku_base), url]]);
  const fotoPara = async (sku: string): Promise<string | null> => {
    const comp = compDe.get(sku) || String(pai.sku_base);
    if (!fotoDeBase.has(comp)) {
      try { fotoDeBase.set(comp, fotoPrincipal((await carregarBase(token, comp)).det)); } catch { fotoDeBase.set(comp, null); }
    }
    return fotoDeBase.get(comp) ?? null;
  };
  if (!url && !compDe.size) return { ok: false, erro: `o produto base ${pai.sku_base} não tem foto no Tiny` };
  const itens: Record<string, unknown>[] = [];
  for (const p of linhas) {
    // v6: quem já tem foto no espelho não é relido; e para aos ~22 s (`pendente`: a tela chama de novo)
    if (p.foto_capa && !dry) { itens.push({ sku: p.sku, ok: true, ja_tinha: true, url: p.foto_capa }); continue; }
    if (Date.now() - t0 > 22_000) { itens.push({ sku: p.sku, ok: false, pendente: true, erro: "não coube nesta chamada" }); continue; }
    const g = await v3(token, "GET", `/produtos/${p.id_tiny}`);
    if (g.status !== 200) { itens.push({ sku: p.sku, ok: false, erro: erroV3(g.body) || g.status }); continue; }
    const atual = fotoPrincipal(g.body);
    if (atual) { itens.push({ sku: p.sku, ok: true, ja_tinha: true, url: atual }); continue; }
    const foto = await fotoPara(String(p.sku));
    if (!foto) { itens.push({ sku: p.sku, ok: false, erro: "o produto base dele não tem foto no Tiny" }); continue; }
    if (dry) { itens.push({ sku: p.sku, ok: true, faria: true }); continue; }
    const r = await porFoto(token, Number(p.id_tiny), foto, externo);
    if (r.ok) await db.from("produtos").update({ foto_capa: r.url }).eq("sku", p.sku);
    itens.push({ sku: p.sku, ok: r.ok, externo: r.externo, url: r.url, erro: r.erro, resposta: r.resposta });
  }
  return { ok: itens.every((i) => i.ok), base_sku: pai.sku_base, foto: url, dry, itens };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const inicio = Date.now(); // orçamento de tempo do `criar` (o limite da função é ~30 s)
  // ensaio da foto (12/out, noite): só com o código do ensaio e até o prazo; depois disso este trecho não faz nada.
  //  ?ids=…&base_sku=… → põe a foto do produto base em produto DE TESTE (nome começa com "TESTE APP")
  //  ?sku_pai=…        → a família criada pelo app recebe a foto do produto base dela (&dry=1 só mostra)
  const u0 = new URL(req.url);
  if (u0.searchParams.get("modulo") === "foto-ensaio") {
    if (Date.now() > Date.parse("2026-10-13T03:00:00Z") || u0.searchParams.get("chave") !== "f90c81b7390da6003544") return json({ erro: "encerrado" }, 410);
    try {
      const tk = await tokenTiny();
      const ex = u0.searchParams.get("externo"); const externo = ex === "1" ? true : ex === "0" ? false : undefined;
      const dry = u0.searchParams.get("dry") === "1";
      const skuPai = u0.searchParams.get("sku_pai");
      if (skuPai) return json(await fotosDaFamilia(tk, skuPai, dry, externo));
      const base = await carregarBase(tk, String(u0.searchParams.get("base_sku") ?? ""));
      const url = fotoPrincipal(base.det); const out: Record<string, unknown>[] = [];
      for (const id of (u0.searchParams.get("ids") || "").split(",").map(Number).filter(Boolean)) {
        const g = await v3(tk, "GET", `/produtos/${id}`);
        if (g.status !== 200 || !String(g.body?.descricao ?? "").startsWith("TESTE APP")) { out.push({ id, pulado: "não é produto de teste" }); continue; }
        if (dry || !url) { out.push({ id, sku: g.body.sku, anexos: g.body.anexos ?? [] }); continue; }
        const r = await porFoto(tk, id, url, externo);
        const c = await v3(tk, "GET", `/produtos/${id}`);
        out.push({ id, sku: g.body.sku, antes: g.body.anexos ?? [], envio: r, depois: c.body?.anexos ?? [] });
      }
      return json({ ok: true, base: { sku: base.espelho.sku, anexos: base.det.anexos ?? [] }, out });
    } catch (e) { return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500); }
  }
  // 14/out (pedido do dono): INATIVAR o pai duplicado 16523 e as 4 variações que ficaram simples (o Tiny recusou o kit
  // por nome repetido do 16506). Só estes 5 SKUs, só até o prazo; o nome ganha " (duplicado, inativo)" no mesmo passo —
  // sem isso o `alterar` da v2 recusa de novo pelo nome repetido. Uma chamada por produto, sem repetição.
  if (u0.searchParams.get("modulo") === "inativar-16523") {
    if (Date.now() > Date.parse("2026-10-15T23:00:00Z") || u0.searchParams.get("chave") !== "d3c9-16523-a71e5b") return json({ erro: "encerrado" }, 410);
    const PERMITIDOS = ["16524", "16526", "16528", "16530", "16523"]; // variações primeiro, o pai por último
    try {
      const tk = await tokenTiny(); const out: Record<string, unknown>[] = [];
      const { data: esp } = await db.from("produtos").select("sku, id_tiny").in("sku", PERMITIDOS);
      for (const sku of PERMITIDOS) {
        const id = Number(((esp ?? []) as any[]).find((x) => x.sku === sku)?.id_tiny);
        if (!id) { out.push({ sku, pulado: "sem id do Tiny no espelho" }); continue; }
        const g = await v3(tk, "GET", `/produtos/${id}`);
        const doPai = sku === "16523" ? g.body?.tipoVariacao === "P" : String(g.body?.produtoPai?.sku ?? "") === "16523";
        if (g.status !== 200 || String(g.body?.sku) !== sku || !doPai) { out.push({ sku, pulado: "não confere (SKU ou pai diferente)", status: g.status }); continue; }
        if (g.body?.situacao === "I") { out.push({ sku, ja_estava: "I" }); continue; }
        const nome = String(g.body.descricao ?? "").includes("(duplicado, inativo)") ? String(g.body.descricao) : `${g.body.descricao} (duplicado, inativo)`;
        const produto = { sequencia: "1", id, codigo: sku, nome: nome.slice(0, 120), unidade: g.body.unidade || "UN", preco: Number(g.body.precos?.preco ?? 0), origem: String(g.body.origem ?? 0), situacao: "I", tipo: "P" };
        const ret = await v2("produto.alterar.php", { produto: JSON.stringify({ produtos: [{ produto }] }) });
        const e = erroV2(ret);
        const c = await v3(tk, "GET", `/produtos/${id}`);
        const ok = c.body?.situacao === "I";
        if (ok) await db.from("produtos").update({ ativo: false, situacao: "I", nome: c.body?.descricao ?? nome, atualizado_em: new Date().toISOString() }).eq("sku", sku);
        out.push({ sku, ok, situacao: c.body?.situacao, nome: c.body?.descricao, v2: ret?.registros?.[0]?.registro?.status ?? ret?.status, erro: ok ? null : e.texto });
        if (!ok && e.codigo === "6") break; // limite da v2: para tudo, sem repetir
      }
      await db.from("debug_fulfillment").insert({ modulo: "tiny-produto-variacoes", etapa: "16523:inativar", status_http: 200, resultado: { out } });
      return json({ ok: true, out });
    } catch (e) { return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500); }
  }
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = await exigirAcesso(req);
  if (quem instanceof Response) return quem;
  const modulo = new URL(req.url).searchParams.get("modulo") ?? "";
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  try {
    const token = await tokenTiny();

    if (modulo === "sugerir") {
      const base = await carregarBase(token, String(body.base_sku ?? "").trim());
      // próximos SKUs livres, conferidos ao vivo no Tiny (sugestão; a pessoa pode trocar)
      const n = Math.min(Math.max(Math.floor(num(body.n) ?? 4), 1), 51);
      const livres = await skusLivres(token, n);
      const d = base.det;
      return json({
        ok: true,
        base: { sku: base.espelho.sku, nome: d.descricao, tipo: d.tipo, tipo_variacao: d.tipoVariacao ?? "N", preco: num(d.precos?.preco), custo: base.custo, marca: d.marca?.nome ?? null },
        skus: livres,
      });
    }

    if (modulo === "grade") {
      // só leitura: a(s) grade(s) do produto pai e o valor de cada variação, como estão no Tiny
      const skuPai = String(body.sku_pai ?? "").trim();
      const { data: p } = await db.from("produtos").select("sku, id_tiny").eq("sku", skuPai).maybeSingle();
      if (!p?.id_tiny) return json({ ok: false, erro: `produto ${skuPai} sem o código do Tiny` }, 400);
      const g = await v3(token, "GET", `/produtos/${p.id_tiny}`);
      if (g.status !== 200) return json({ ok: false, erro: `não consegui ler ${skuPai} no Tiny: ${erroV3(g.body) || g.status}` }, 200);
      const variacoes = ((g.body?.variacoes ?? []) as any[]).map((v) => ({
        sku: String(v.sku ?? ""), valores: ((v.grade ?? []) as any[]).map((x) => String(x?.valor ?? "")), chaves: ((v.grade ?? []) as any[]).map((x) => String(x?.chave ?? "")),
      }));
      const grades = variacoes[0]?.chaves ?? [];
      return json({ ok: true, sku_pai: skuPai, grades, variacoes: variacoes.map(({ sku, valores }) => ({ sku, valores })) });
    }

    if (modulo === "foto") {
      if (body.confirmar !== true && body.dry !== true) return json({ ok: false, erro: "exige confirmar: true" }, 400);
      return json(await fotosDaFamilia(token, String(body.sku_pai ?? "").trim(), body.confirmar !== true));
    }

    if (modulo === "fotos-anuncio") {
      const itens = (Array.isArray(body.itens) ? body.itens : []).slice(0, 8).map((x: any) => ({
        sku: String(x?.sku ?? "").trim(),
        paths: [...new Set((Array.isArray(x?.paths) ? x.paths : []).map((p: unknown) => String(p)))].slice(0, 9) as string[],
      })).filter((x: { sku: string }) => /^[A-Za-z0-9._-]{1,30}$/.test(x.sku));
      if (!itens.length) return json({ ok: false, erro: "informe itens: [{sku, paths}]" }, 400);
      const inicio = Date.now(); const LIMITE = 24_000;
      const saida: any[] = [];
      for (const it of itens) {
        const { data: prod } = await db.from("produtos").select("sku, nome, id_tiny").eq("sku", it.sku).maybeSingle();
        if (!prod?.id_tiny) { saida.push({ sku: it.sku, ok: false, erro: "produto sem cadastro no Tiny" }); continue; }
        // só foto que é do anúncio deste produto
        const { data: rs } = await db.from("ia_rascunho").select("id").eq("sku", it.sku);
        const ids = ((rs ?? []) as any[]).map((r) => r.id);
        const { data: ims } = ids.length && it.paths.length
          ? await db.from("ia_rascunho_imagem").select("storage_path").in("rascunho_id", ids).in("storage_path", it.paths)
          : { data: [] as any[] };
        const validas = new Set(((ims ?? []) as any[]).map((i) => String(i.storage_path)));
        const paths = it.paths.filter((p: string) => validas.has(p));
        const id = Number(prod.id_tiny);
        const det = await v3(token, "GET", `/produtos/${id}`);
        if (det.status !== 200) { saida.push({ sku: it.sku, ok: false, erro: `não consegui ler o produto no Tiny: ${erroV3(det.body) || det.status}` }); continue; }
        const linha: any = {
          sku: it.sku, nome: prod.nome, id_tiny: id, fotos_no_tiny: ((det.body?.anexos ?? []) as any[]).length,
          validas: paths.length, ignoradas: it.paths.length - paths.length, enviadas: [] as any[], faltou: [] as string[],
        };
        if (body.confirmar !== true) { saida.push({ ...linha, ok: true }); continue; }
        for (const p of paths) {
          if (Date.now() - inicio > LIMITE) { linha.faltou.push(p); continue; }
          const s = await db.storage.from("ia-anuncios").createSignedUrl(p, 7200);
          if (s.error || !s.data?.signedUrl) { linha.enviadas.push({ path: p, ok: false, erro: "não consegui abrir a foto no armazenamento" }); continue; }
          const r = await porFoto(token, id, s.data.signedUrl, false);
          linha.enviadas.push({ path: p, ok: r.ok, erro: r.erro });
          await sleep(350);
        }
        // a foto principal do Tiny (1º anexo) passa a valer no sistema na hora — nunca o endereço assinado daqui
        const dep = await v3(token, "GET", `/produtos/${id}`);
        if (dep.status === 200) {
          linha.fotos_no_tiny = ((dep.body?.anexos ?? []) as any[]).length;
          const capa = fotoPrincipal(dep.body);
          if (capa && !/supabase\.co\//.test(capa)) { await db.from("produtos").update({ foto_capa: capa }).eq("sku", it.sku); linha.foto_capa = capa; }
        }
        linha.ok = linha.enviadas.length > 0 && linha.enviadas.every((e: any) => e.ok) && !linha.faltou.length;
        saida.push(linha);
        await db.from("debug_fulfillment").insert({ modulo: "tiny-fotos-anuncio", etapa: it.sku, status_http: linha.ok ? 200 : 207, resultado: { quem: quem.nome, ...linha } });
      }
      return json({ ok: true, itens: saida });
    }

    if (modulo === "kit") {
      if (body.confirmar !== true) return json({ ok: false, erro: "exige confirmar: true" }, 400);
      const base = await carregarBase(token, String(body.base_sku ?? "").trim());
      const r = await virarKit(token, Number(body.id_variacao), Number(base.espelho.id_tiny), Math.floor(num(body.quantidade) ?? 0));
      if (r.ok && r.sku) {
        await db.from("produto_kits").delete().eq("sku_kit", r.sku);
        await db.from("produto_kits").insert({ sku_kit: r.sku, sku_componente: base.espelho.sku, quantidade: Number(body.quantidade), nome_componente: base.det.descricao, atualizado_em: new Date().toISOString() });
        await db.from("produtos").update({ tipo: "K" }).eq("sku", r.sku);
      }
      return json({ ...r, ok: r.ok });
    }

    const pd = lerPedido(body);
    if (!pd.baseSku) return json({ ok: false, erro: "informe base_sku" }, 400);
    const c = await conferir(token, pd);
    if (modulo === "previa") return json({ ok: true, previa: c.previa, pendencias: c.pendencias, avisos: c.avisos });
    if (modulo !== "criar") return json({ ok: false, erro: "use ?modulo=sugerir, previa, criar, kit, foto, fotos-anuncio ou grade" }, 400);
    if (body.confirmar !== true) return json({ ok: false, erro: "criar exige confirmar: true" }, 400);
    if (c.pendencias.length) return json({ ok: false, erro: "há pendências", pendencias: c.pendencias }, 400);

    const passos: Record<string, unknown>[] = [];
    const registrar = (status: number, resultado: unknown) => db.from("debug_fulfillment").insert({ modulo: "tiny-produto-variacoes", etapa: pd.skuPai, status_http: status, resultado });
    // PASSO 1 — o pai com as variações (sem repetição: repetir criaria produto em dobro)
    let cr = await v3(token, "POST", "/produtos", c.corpo);
    if (cr.status === 400 && (c.corpo.marca || c.corpo.categoria)) {
      // 400 = nada foi criado: tenta uma vez sem marca/categoria (ids que o Tiny pode não aceitar na criação)
      passos.push({ passo: "criar (com marca e categoria)", ok: false, erro: erroV3(cr.body) });
      const { marca: _m, categoria: _c, ...semExtras } = c.corpo as Record<string, unknown>;
      cr = await v3(token, "POST", "/produtos", semExtras);
    }
    const idPai = cr.body?.id as number | undefined;
    if (cr.status !== 201 || !idPai) {
      await registrar(cr.status, { quem: quem.nome, enviado: c.corpo, resposta: cr.body });
      return json({ ok: false, erro: `o Tiny recusou criar o produto: ${erroV3(cr.body) || cr.status}`, passos }, 200);
    }
    passos.push({ passo: "produto com variações criado no Tiny", ok: true, sku: pd.skuPai, id: idPai });
    const criadas = ((cr.body?.variacoes ?? []) as any[]).map((v) => ({ id: Number(v.id), sku: String(v.codigo) }));
    const agora = new Date().toISOString();
    const baseDe = (v: Variacao) => c.bases.get(v.baseSku) ?? c.base;

    // o app já enxerga os produtos novos, sem esperar a sincronização da madrugada. v6: gravado LOGO, antes dos kits
    // (com muitas variações a chamada pode não chegar ao fim; o pai e as variações já ficam no espelho).
    // As duas formas de linha têm as MESMAS chaves: o upsert em lote exige isso.
    const fotoDe = new Map<string, string>(); const okKit = new Set<string>();
    const linhasEspelho = () => [
      { sku: pd.skuPai, id_tiny: idPai, nome: pd.nome, tipo: "V", preco: (c.corpo.precos as any).preco, ativo: true, situacao: "A", tipo_variacao: "P", sku_pai: null, id_tiny_pai: null, foto_capa: fotoDe.get(pd.skuPai) ?? null, criado_app_em: agora, sku_base: pd.baseSku, atualizado_em: agora },
      ...pd.variacoes.filter((v) => criadas.some((x) => x.sku === v.sku)).map((v) => ({
        sku: v.sku, id_tiny: criadas.find((x) => x.sku === v.sku)!.id, nome: `${pd.nome} - ${v.rotulo}`, tipo: okKit.has(v.sku) ? "K" : "S", preco: v.preco, ativo: true, situacao: "A",
        tipo_variacao: "V", sku_pai: pd.skuPai, id_tiny_pai: idPai, foto_capa: fotoDe.get(v.sku) ?? null, criado_app_em: agora, sku_base: v.baseSku, atualizado_em: agora,
      })),
    ];
    const up0 = await db.from("produtos").upsert(linhasEspelho(), { onConflict: "sku" });

    // PASSO 2 — cada variação vira kit do produto base DELA (v6: até ~20 s; o que faltar a tela termina pelo `kit`)
    const variacoes: Record<string, unknown>[] = [];
    let parou = false;
    for (const v of pd.variacoes) {
      const linha = { sku: v.sku, rotulo: v.rotulo, valores: v.valores, base_sku: v.baseSku, quantidade: v.quantidade, preco: v.preco };
      const cv = criadas.find((x) => x.sku === v.sku);
      if (!cv) { variacoes.push({ ...linha, ok: false, erro: "o Tiny não devolveu esta variação" }); continue; }
      if (parou) { variacoes.push({ ...linha, id: cv.id, ok: false, pendente: true, erro: "não tentei: o Tiny pediu para esperar (limite de chamadas) — tente de novo daqui a 1 minuto" }); continue; }
      if (Date.now() - inicio > 20_000) { variacoes.push({ ...linha, id: cv.id, ok: false, pendente: true, erro: "ainda não virou kit (não coube nesta chamada)" }); continue; }
      const k = await virarKit(token, cv.id, Number(baseDe(v).espelho.id_tiny), v.quantidade);
      if ((k as any).limite) parou = true;
      if (k.ok) okKit.add(v.sku);
      variacoes.push({ ...linha, id: cv.id, ok: k.ok, erro: k.erro ?? null, tipo: (k as any).tipo ?? "S" });
    }
    const kits = pd.variacoes.filter((v) => okKit.has(v.sku)).map((v) => ({
      sku_kit: v.sku, sku_componente: v.baseSku, quantidade: v.quantidade, nome_kit: `${pd.nome} - ${v.rotulo}`, nome_componente: baseDe(v).det.descricao, atualizado_em: agora,
    }));
    if (kits.length) {
      await db.from("produto_kits").delete().in("sku_kit", kits.map((k) => k.sku_kit));
      await db.from("produto_kits").insert(kits);
    }

    // PASSO 3 — fotos: o pai recebe a do 1º produto base; cada variação, a do produto base DELA (até ~24 s)
    const semFoto: string[] = [];
    const alvos = [{ sku: pd.skuPai, id: idPai, base: c.base }, ...criadas.map((x) => {
      const v = pd.variacoes.find((y) => y.sku === x.sku); return { ...x, base: v ? baseDe(v) : c.base };
    })];
    for (const alvo of alvos) {
      const foto = fotoPrincipal(alvo.base.det);
      if (!foto || Date.now() - inicio > 24_000) { semFoto.push(alvo.sku); continue; }
      const f = await porFoto(token, alvo.id, foto);
      if (f.ok) fotoDe.set(alvo.sku, String(f.url)); else semFoto.push(alvo.sku);
    }
    passos.push({ passo: "foto principal do produto base", ok: semFoto.length === 0, com_foto: fotoDe.size, sem_foto: semFoto });
    const up = await db.from("produtos").upsert(linhasEspelho(), { onConflict: "sku" });

    const pendentes = variacoes.filter((v: any) => v.pendente).length;
    const falhas = variacoes.filter((v: any) => !v.ok && !v.pendente).length;
    const avisosFim = [
      falhas ? `${falhas} variação(ões) ficaram como produto simples (sem a composição do kit): use "tentar de novo" ou ajuste no Tiny antes de vender` : null,
      pendentes ? `${pendentes} variação(ões) ainda não viraram kit: a tela continua sozinha` : null,
      semFoto.length ? `${semFoto.length} produto(s) ainda sem foto: a tela continua (ou use "Copiar a foto do produto base" no menu do produto)` : null,
    ].filter(Boolean);
    await registrar(201, { quem: quem.nome, base: pd.baseSku, bases: [...c.bases.keys()], grades: pd.grades, pai: { sku: pd.skuPai, id: idPai }, variacoes, espelho: up.error?.message ?? up0.error?.message ?? "ok" });
    return json({
      ok: true, pai: { sku: pd.skuPai, id: idPai, nome: pd.nome }, variacoes, passos, base_sku: pd.baseSku, grades: pd.grades,
      foto: { url: fotoPrincipal(c.base.det), com_foto: fotoDe.size, sem_foto: semFoto },
      aviso: avisosFim.length ? avisosFim.join(" · ") : null,
    });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
