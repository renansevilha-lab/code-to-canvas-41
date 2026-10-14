// ml-anuncio-sonda v5 (14/out/2026) - DIAGNOSTICO. So o modo ?teste=limite escreve (v4: regrava o mesmo valor; v5: &valor=N troca e volta).
// v3 (12/out/2026): nao publica nem altera nada.
// Ensaia, so com LEITURA e com o VALIDADOR do Mercado Livre (/items/validate confere o corpo e
// nao cria anuncio), as chamadas que a `anuncio-publicar` v4 faz para o Mercado Livre:
//   GET ?conta=ottz|svl&sku=15984[&titulo=...]
//     existentes  -> /users/{id}/items/search?seller_sku= + multiget
//     categoria   -> /sites/MLB/domain_discovery/search, /categories/{id}, /categories/{id}/attributes
//     tipos       -> quantos anuncios ativos da conta em gold_pro x gold_special
//     validacao   -> corpo de criacao montado como a funcao monta (family_name, sem title)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ML = "https://api.mercadolibre.com";
const CONTA: Record<string, number> = { ottz: 1107117809, svl: 1299638625 };
const AUTO = new Set(["SELLER_SKU", "GTIN", "EMPTY_GTIN_REASON", "ITEM_CONDITION", "SELLER_PACKAGE_HEIGHT", "SELLER_PACKAGE_WIDTH", "SELLER_PACKAGE_LENGTH", "SELLER_PACKAGE_WEIGHT", "SELLER_PACKAGE_TYPE"]);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
async function ml(token: string, path: string, metodo = "GET", corpo?: unknown) {
  const r = await fetch(`${ML}${path}`, { method: metodo, headers: { Authorization: `Bearer ${token}`, ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) }, body: corpo !== undefined ? JSON.stringify(corpo) : undefined });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt.slice(0, 300); }
  return { status: r.status, body };
}
Deno.serve(async (req) => {
  const u = new URL(req.url);
  const conta = u.searchParams.get("conta") || "ottz";
  const sku = u.searchParams.get("sku") || "";
  const userId = CONTA[conta];
  const { data: tk } = await sb.from("oauth_tokens_ml").select("access_token").eq("user_id", userId).maybeSingle();
  if (!tk) return json({ erro: "sem token" }, 400);
  const token = tk.access_token as string;

  // v4 (14/out/2026, autorizado pelo dono): o limite de unidades por compra (sale_term
  // PURCHASE_MAX_QUANTITY) pode ser alterado pela API? O validador recusa na criacao; aqui o teste
  // e no anuncio EXISTENTE, regravando os termos de venda com os MESMOS valores que ele ja tem
  // (nada muda no anuncio). Uma chamada, sem repeticao. Expira no fim de 15/out.
  if (u.searchParams.get("teste") === "limite") {
    if (Date.now() > Date.parse("2026-10-16T03:00:00Z")) return json({ erro: "teste expirado" }, 410);
    const mlb = String(u.searchParams.get("mlb") || "");
    if (!/^MLB\d+$/.test(mlb)) return json({ erro: "mlb invalido" }, 400);
    const antes = await ml(token, `/items/${mlb}?attributes=id,seller_id,status,sale_terms`);
    if (antes.status !== 200 || Number(antes.body?.seller_id) !== userId) return json({ erro: "anuncio nao e desta conta", status: antes.status }, 400);
    const termos = ((antes.body?.sale_terms ?? []) as any[]).map((t) => ({ id: String(t.id), value_name: t.value_name }));
    if (!termos.some((t) => t.id === "PURCHASE_MAX_QUANTITY")) return json({ erro: "anuncio sem limite de unidades", termos }, 400);
    // v5 (14/out, autorizado pelo dono: "1 -> 2 -> 1"): com &valor=N troca o limite para N e VOLTA na
    // hora ao valor de antes. A volta tem 1 nova tentativa (so repoe estado; nao cria nada).
    const valor = u.searchParams.get("valor");
    if (valor != null) {
      if (!/^\d{1,3}$/.test(valor) || Number(valor) < 1) return json({ erro: "valor invalido" }, 400);
      const original = String(termos.find((t) => t.id === "PURCHASE_MAX_QUANTITY")!.value_name);
      if (original === valor) return json({ erro: "valor igual ao atual", original }, 400);
      const com = (v: string) => termos.map((t) => (t.id === "PURCHASE_MAX_QUANTITY" ? { ...t, value_name: v } : t));
      const resumo = (r: { status: number; body: any }) => r.status === 200
        ? { status: 200, limite: (r.body?.sale_terms ?? []).find((t: any) => t.id === "PURCHASE_MAX_QUANTITY")?.value_name ?? null }
        : { status: r.status, mensagem: r.body?.message ?? null, causas: (r.body?.cause ?? []).map((c: any) => `${c.type}:${c.code}:${String(c.message).slice(0, 220)}`) };
      const troca = await ml(token, `/items/${mlb}`, "PUT", { sale_terms: com(valor) });
      const lidoTroca = await ml(token, `/items/${mlb}?attributes=id,sale_terms`);
      let volta: { status: number; body: any } | null = null;
      if (troca.status === 200 || (lidoTroca.status === 200 && (resumo(lidoTroca) as any).limite !== original)) {
        volta = await ml(token, `/items/${mlb}`, "PUT", { sale_terms: com(original) });
        if (volta.status !== 200) { await new Promise((r) => setTimeout(r, 2000)); volta = await ml(token, `/items/${mlb}`, "PUT", { sale_terms: com(original) }); }
      }
      const fim = await ml(token, `/items/${mlb}?attributes=id,sale_terms`);
      return json({
        mlb, original, pedido: valor, troca: resumo(troca), lido_apos_troca: resumo(lidoTroca), volta: volta ? resumo(volta) : null, final: resumo(fim),
      });
    }
    const put = await ml(token, `/items/${mlb}`, "PUT", { sale_terms: termos });
    const depois = await ml(token, `/items/${mlb}?attributes=id,status,sale_terms`);
    return json({
      mlb, enviado: { sale_terms: termos }, put_status: put.status,
      put_resposta: put.status === 200 ? { sale_terms: put.body?.sale_terms } : { mensagem: put.body?.message ?? null, erro: put.body?.error ?? null,
        causas: (put.body?.cause ?? []).map((c: any) => `${c.type}:${c.code}:${String(c.message).slice(0, 220)}`) },
      antes: antes.body?.sale_terms, depois: depois.body?.sale_terms,
    });
  }

  // existentes
  const s = await ml(token, `/users/${userId}/items/search?seller_sku=${encodeURIComponent(sku)}&limit=50`);
  const ids = ((s.body?.results ?? []) as unknown[]).map(String).slice(0, 20);
  const mg = ids.length ? await ml(token, `/items?ids=${ids.join(",")}&attributes=id,title,price,status,permalink,sold_quantity,catalog_listing,variations`) : null;
  const existentes = ((Array.isArray(mg?.body) ? mg!.body : []) as any[]).map((x) => x?.body)
    .map((it) => ({ id: it?.id, titulo: it?.title, preco: it?.price, status: it?.status, vendas: it?.sold_quantity, catalogo: it?.catalog_listing, n_var: (it?.variations ?? []).length }));

  // um anúncio de exemplo (para a foto e para o título, se não vier)
  let exemplo: any = null;
  const idEx = ids[0] ?? (await ml(token, `/users/${userId}/items/search?status=active&limit=1`)).body?.results?.[0];
  if (idEx) exemplo = (await ml(token, `/items/${idEx}`)).body;
  const titulo = (u.searchParams.get("titulo") || exemplo?.title || "").slice(0, 60);

  // categoria
  const disc = await ml(token, `/sites/MLB/domain_discovery/search?limit=4&q=${encodeURIComponent(titulo)}`);
  const palpites = (Array.isArray(disc.body) ? disc.body : []) as any[];
  const catId = String(palpites[0]?.category_id ?? exemplo?.category_id ?? "");
  const [cat, atr, nPro, nEsp, desc] = await Promise.all([
    ml(token, `/categories/${catId}`), ml(token, `/categories/${catId}/attributes`),
    ml(token, `/users/${userId}/items/search?status=active&listing_type_id=gold_pro&limit=1`),
    ml(token, `/users/${userId}/items/search?status=active&listing_type_id=gold_special&limit=1`),
    idEx ? ml(token, `/items/${idEx}/description`) : Promise.resolve(null),
  ]);
  const previstos = new Map<string, string>(((palpites[0]?.attributes ?? []) as any[]).filter((a) => a?.id && a?.value_name).map((a) => [String(a.id), String(a.value_name)]));
  const atributos = ((Array.isArray(atr.body) ? atr.body : []) as any[])
    .filter((a) => a?.id && !AUTO.has(String(a.id)) && !a.tags?.hidden && !a.tags?.read_only && !a.tags?.fixed && (a.tags?.required || a.tags?.catalog_required || a.tags?.conditional_required))
    .map((a) => ({ id: a.id, nome: a.name, obrigatorio: a.tags?.required === true, tags: Object.keys(a.tags ?? {}), tipo: a.value_type, n_opcoes: (a.values ?? []).length,
      unidades: (a.allowed_units ?? []).map((x: any) => x.name).slice(0, 4), dica: a.hint ?? null, previsto: previstos.get(String(a.id)) ?? null }));

  // validação do corpo como a função monta (marca do exemplo; obrigatórios sem valor ficam de fora de propósito)
  const marca = (exemplo?.attributes ?? []).find((a: any) => a.id === "BRAND")?.value_name ?? "Genérica";
  const corpo = {
    family_name: titulo, category_id: catId, price: Number(exemplo?.price) || 49.9, currency_id: "BRL", available_quantity: 1,
    buying_mode: "buy_it_now", condition: "new", listing_type_id: "gold_special",
    pictures: ((exemplo?.pictures ?? []) as any[]).slice(0, 1).map((p) => ({ source: p.secure_url ?? p.url })),
    sale_terms: [{ id: "WARRANTY_TYPE", value_name: "Garantia do vendedor" }, { id: "WARRANTY_TIME", value_name: "30 dias" }],
    shipping: { mode: "me2", local_pick_up: false, free_shipping: false },
    attributes: [
      { id: "BRAND", value_name: marca },
      ...atributos.filter((a) => a.id !== "BRAND" && a.previsto).map((a) => ({ id: a.id, value_name: a.previsto })),
      { id: "SELLER_SKU", value_name: sku || "TESTE" },
      { id: "EMPTY_GTIN_REASON", value_id: "17055160", value_name: "O produto não tem código cadastrado" },
      { id: "SELLER_PACKAGE_HEIGHT", value_name: "10 cm" }, { id: "SELLER_PACKAGE_WIDTH", value_name: "20 cm" },
      { id: "SELLER_PACKAGE_LENGTH", value_name: "30 cm" }, { id: "SELLER_PACKAGE_WEIGHT", value_name: "1200 g" },
    ],
  };
  const v = await ml(token, "/items/validate", "POST", corpo);
  return json({
    conta, sku, busca_status: s.status, existentes, multiget_status: mg?.status ?? null,
    titulo, palpites: palpites.map((p) => ({ categoria: p.category_id, nome: p.category_name, dominio: p.domain_name, n_atributos: (p.attributes ?? []).length })),
    categoria: { status: cat.status, id: cat.body?.id, caminho: (cat.body?.path_from_root ?? []).map((x: any) => x.name).join(" > "), filhos: (cat.body?.children_categories ?? []).length,
      titulo_max: cat.body?.settings?.max_title_length, fotos_max: cat.body?.settings?.max_pictures_per_item, desc_max: cat.body?.settings?.max_description_length },
    atributos,
    tipos: { gold_pro: { status: nPro.status, total: nPro.body?.paging?.total }, gold_special: { status: nEsp.status, total: nEsp.body?.paging?.total } },
    exemplo: exemplo ? { id: exemplo.id, family_name: exemplo.family_name ?? null, user_product_id: exemplo.user_product_id ?? null, n_fotos: (exemplo.pictures ?? []).length,
      foto0: exemplo.pictures?.[0] ? Object.keys(exemplo.pictures[0]) : null, descricao_status: desc?.status ?? null } : null,
    validacao: { status: v.status, mensagem: v.body?.message ?? null, causas: (v.body?.cause ?? []).map((c: any) => `${c.type}:${c.code}:${String(c.message).slice(0, 220)}`) },
  });
});
