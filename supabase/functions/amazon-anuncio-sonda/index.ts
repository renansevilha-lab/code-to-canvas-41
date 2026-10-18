// ============================================================================
// Edge Function: amazon-anuncio-sonda v3 (18/out/2026) — IA · Anúncios
// (publicada no slot `amazon-lwa-debug`: criar função nova no projeto falha — ver CLAUDE.md §5.11)
// ----------------------------------------------------------------------------
// DIAGNÓSTICO do envio de anúncio para a Amazon (SP-API, Listings Items). NÃO altera nada:
// toda chamada de escrita vai com `mode=VALIDATION_PREVIEW` (a Amazon só valida, não aplica).
// GET ?conta=ottz|svl&sku=15819[&titulo=...][&foto=<url>][&bruto=1]
//       lê o anúncio do SKU e ensaia uma atualização; `bruto=1` devolve todos os atributos (molde).
// GET ?conta=ottz&sku=14560&busca=texto
//       o produto já existe no catálogo da Amazon? podemos vender nele? tipo de produto sugerido.
// GET ?conta=ottz&sku=10933&ensaio=criar[&preco=][&canal=fba|proprio][&tipo=TIPO][&asin=][&forcar=novo]
//       v2: ENSAIO DE CRIAR. Procura o EAN no catálogo; se o produto existe, ensaia entrar na
//       oferta (LISTING_OFFER_ONLY); se não existe (ou forcar=novo), lê o que o tipo de produto
//       exige e ensaia criar a ficha (LISTING) com o que temos no cadastro. Nada é criado.
// GET ?conta=ottz&asin=B0…[&sku_filho=][&pai=<sku pai que já existe>][&tema=][&valor=][&tipo=]
//       v3 (18/out/2026): PELO ASIN. Ficha do catálogo (marca, tipo, relações de variação: pai/filhos e
//       tema), quais SKUs NOSSOS estão nesse ASIN (searchListingsItems por ASIN), os temas de variação
//       que o tipo de produto aceita e um ENSAIO de pôr o anúncio como variação (pai novo + este
//       anúncio como filho), só com VALIDATION_PREVIEW. Nada é criado.
// Sem dados sensíveis na resposta (nenhum token).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SPAPI = "https://sellingpartnerapi-na.amazon.com";
const MKT_BR = "A2Q3Y263D00KWC";
const SHOP: Record<string, number> = { ottz: 900001, svl: 900002 };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function sp(token: string, metodo: string, path: string, params: Record<string, string>, corpo?: unknown) {
  // trava: escrita só passa como ensaio
  if (metodo !== "GET" && params.mode !== "VALIDATION_PREVIEW") throw new Error("sonda: escrita sem VALIDATION_PREVIEW bloqueada");
  const url = new URL(`${SPAPI}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: metodo,
    headers: { "x-amz-access-token": token, Accept: "application/json", ...(corpo !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  const txt = await r.text();
  let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { bruto: txt.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, body };
}
const pend = (body: any, n = 40): string[] => [
  ...((body?.errors ?? []) as any[]).map((e) => `ERRO ${e.code}: ${String(e.message).slice(0, 200)}`),
  ...((body?.issues ?? []) as any[]).slice(0, n).map((i) => `${i.severity} ${i.code}: ${String(i.message).slice(0, 220)} [${(i.attributeNames ?? []).join(",")}]`),
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const u = new URL(req.url);
  const conta = u.searchParams.get("conta") === "svl" ? "svl" : "ottz";
  const sku = (u.searchParams.get("sku") || "").trim();
  const asinQ = (u.searchParams.get("asin") || "").trim().toUpperCase();
  const ensaioCriar = u.searchParams.get("ensaio") === "criar";
  if (!sku && !asinQ) return json({ erro: "informe ?sku= ou ?asin=" }, 400);
  try {
    const { data: tk } = await sb.from("oauth_tokens_amazon").select("access_token, expires_at, merchant_token, marketplace_id").eq("shop_id", SHOP[conta]).maybeSingle();
    if (!tk) return json({ erro: `conta ${conta} da Amazon não conectada` }, 400);
    const out: Record<string, unknown> = { conta, sku, token_valido_ate: tk.expires_at, tem_merchant_token: Boolean(tk.merchant_token) };
    if (!tk.merchant_token) return json({ ...out, erro: "falta o código de vendedor (merchant token) desta conta" });
    const mkt = tk.marketplace_id || MKT_BR; const seller = String(tk.merchant_token); const token = String(tk.access_token);
    const item = (s: string) => `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(s)}`;

    // ------------------------------------------------------------ v3: PELO ASIN (leitura + ensaio de variação)
    if (asinQ && !ensaioCriar) {
      out.asin = asinQ;
      const cat = await sp(token, "GET", `/catalog/2022-04-01/items/${encodeURIComponent(asinQ)}`, { marketplaceIds: mkt, includedData: "summaries,relationships,identifiers,productTypes,images" });
      const it = cat.body ?? {};
      const resumo = it.summaries?.[0] ?? {};
      const rels = ((it.relationships?.[0]?.relationships ?? []) as any[]);
      const tipoCat = it.productTypes?.[0]?.productType ?? null;
      out.catalogo = {
        http: cat.status, erro: pend(cat.body).slice(0, 2),
        titulo: resumo.itemName ?? null, marca: resumo.brand ?? null, tipo_de_produto: tipoCat,
        classificacao: resumo.browseClassification?.displayName ?? null,
        ean: ((it.identifiers?.[0]?.identifiers ?? []) as any[]).map((x) => `${x.identifierType}:${x.identifier}`).slice(0, 4),
        n_fotos: ((it.images?.[0]?.images ?? []) as any[]).filter((x) => Number(x.height) >= 500).length,
        variacao: rels.length ? rels.map((r) => ({ tipo: r.type, pais: r.parentAsins ?? [], filhos: (r.childAsins ?? []).length, filhos_lista: (r.childAsins ?? []).slice(0, 20), tema: r.variationTheme ?? null })) : "sem relação de variação (anúncio simples)",
      };
      // SKUs nossos nesse ASIN
      const nossos = await sp(token, "GET", `/listings/2021-08-01/items/${encodeURIComponent(seller)}`, { marketplaceIds: mkt, identifiers: asinQ, identifiersType: "ASIN", includedData: "summaries,relationships", pageSize: "20" });
      const meus = ((nossos.body?.items ?? []) as any[]).map((x) => ({ sku_amazon: x.sku, situacao: x.summaries?.[0]?.status ?? null, tipo: x.summaries?.[0]?.productType ?? null, relacoes: x.relationships?.[0]?.relationships ?? [] }));
      out.nossos_skus = { http: nossos.status, erro: pend(nossos.body).slice(0, 2), itens: meus };
      const rest = await sp(token, "GET", "/listings/2021-08-01/restrictions", { asin: asinQ, sellerId: seller, marketplaceIds: mkt, conditionType: "new_new" });
      out.restricoes = ((rest.body?.restrictions ?? []) as any[]).flatMap((x) => (x.reasons ?? []).map((m: any) => `${m.reasonCode ?? ""}: ${String(m.message ?? "").slice(0, 200)}`));
      // temas de variação que o tipo aceita
      const tipo = (u.searchParams.get("tipo") || meus[0]?.tipo || tipoCat || "").trim();
      let temas: string[] = [];
      if (tipo) {
        const def = await sp(token, "GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(tipo)}`, { marketplaceIds: mkt, sellerId: seller, requirements: "LISTING", locale: "pt_BR" });
        const link = def.body?.schema?.link?.resource;
        if (link) {
          try {
            const sc = await (await fetch(String(link))).json();
            temas = (sc?.properties?.variation_theme?.items?.properties?.name?.enum ?? []) as string[];
            out.tipo_de_produto = tipo;
            out.variacao_no_tipo = {
              temas, tem_parentage_level: Boolean(sc?.properties?.parentage_level), tem_child_parent: Boolean(sc?.properties?.child_parent_sku_relationship),
              parentage_level: sc?.properties?.parentage_level?.items?.properties?.value?.enum ?? null,
            };
          } catch (e) { out.variacao_no_tipo = `não li o esquema: ${String(e).slice(0, 120)}`; }
        } else out.variacao_no_tipo = { http: def.status, erro: pend(def.body).slice(0, 3) };
      }
      // ENSAIO (VALIDATION_PREVIEW): pai novo + este anúncio como filho
      const filho = (u.searchParams.get("sku_filho") || meus[0]?.sku_amazon || "").trim();
      const tema = (u.searchParams.get("tema") || temas.find((t) => /^SIZE$/i.test(t)) || temas.find((t) => /NUMBER_OF_ITEMS|ITEM_PACKAGE_QUANTITY|SIZE/i.test(t)) || temas[0] || "").trim();
      if (tipo && tema) {
        const valor = (u.searchParams.get("valor") || "4kg").trim();
        const paiExistente = (u.searchParams.get("pai") || "").trim();
        const pai = paiExistente || `${filho || asinQ}-PAI-ENSAIO`;
        const txt = (v: string) => [{ value: v, language_tag: "pt_BR", marketplace_id: mkt }];
        const so = (v: unknown) => [{ value: v, marketplace_id: mkt }];
        const corpoPai = {
          productType: tipo, requirements: "LISTING",
          attributes: {
            item_name: txt(String(resumo.itemName ?? "Produto").slice(0, 200)), brand: txt(String(resumo.brand ?? "Generico")),
            parentage_level: so("parent"), variation_theme: [{ name: tema, marketplace_id: mkt }],
            country_of_origin: so("BR"), supplier_declared_dg_hz_regulation: so("not_applicable"),
          },
        };
        const pvPai = paiExistente ? null : await sp(token, "PUT", item(pai), { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, corpoPai);
        const ensaio: Record<string, unknown> = { tema, pai_sku: pai, pai: pvPai ? { http: pvPai.status, situacao: pvPai.body?.status ?? null, pendencias: pend(pvPai.body, 30) } : "pai já existe (não ensaiado)" };
        if (filho) {
          const tl = tema.toLowerCase();
          const attrDoTema = tl.includes("number_of_items") ? "number_of_items" : tl.includes("item_package_quantity") ? "item_package_quantity" : tl.includes("size") ? "size" : tl.split("/")[0];
          const valorAttr = attrDoTema === "size" ? txt(valor) : so(Number(valor.replace(/\D/g, "")) || 1);
          const patches = [
            { op: "replace", path: "/attributes/parentage_level", value: so("child") },
            { op: "replace", path: "/attributes/child_parent_sku_relationship", value: [{ child_relationship_type: "variation", parent_sku: pai, marketplace_id: mkt }] },
            { op: "replace", path: "/attributes/variation_theme", value: [{ name: tema, marketplace_id: mkt }] },
            { op: "replace", path: `/attributes/${attrDoTema}`, value: valorAttr },
            // o filho de variação passa a exigir este campo na validação (visto em 18/out), mesmo já preenchido no anúncio
            { op: "replace", path: "/attributes/external_testing_certification", value: so("Não Aplicável") },
          ];
          const pvF = await sp(token, "PATCH", item(filho), { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, { productType: meus.find((m) => m.sku_amazon === filho)?.tipo || tipo, patches });
          ensaio.filho_sku = filho; ensaio.filho = { http: pvF.status, situacao: pvF.body?.status ?? null, pendencias: pend(pvF.body, 30), enviado: patches };
        } else ensaio.filho = "nenhum SKU nosso neste ASIN: o ensaio do filho fica de fora";
        out.ensaio_variacao = ensaio;
      }
      return json(out);
    }

    // ------------------------------------------------------------ v2: ENSAIO DE CRIAR (só validação)
    if (ensaioCriar) {
      const { data: p } = await sb.from("produtos").select("sku, nome, gtin, marca, marca_manual, peso_bruto, preco, foto_capa, tipo").eq("sku", sku).maybeSingle();
      if (!p) return json({ ...out, erro: "SKU não está no cadastro" }, 404);
      const { data: rs } = await sb.from("ia_rascunho").select("canal, titulo, descricao, bullet_points").eq("sku", sku).order("updated_at", { ascending: false }).limit(5);
      const r0 = ((rs ?? []) as any[]).find((x) => x.canal === "amazon") ?? ((rs ?? []) as any[])[0] ?? null;
      const marca = String(p.marca_manual ?? p.marca ?? "").trim();
      const preco = Number(u.searchParams.get("preco") || p.preco || 0);
      const canal = u.searchParams.get("canal") === "proprio" ? "proprio" : "fba";
      const ean = String(p.gtin ?? "").replace(/\D/g, "");
      out.produto = { nome: p.nome, ean: ean || null, marca: marca || null, peso_bruto: p.peso_bruto, preco, tipo_tiny: p.tipo, tem_foto: Boolean(p.foto_capa), texto_do_rascunho: r0 ? r0.canal : null };
      out.canal_de_envio = canal;

      // já temos este SKU anunciado?
      const ja = await sp(token, "GET", item(sku), { marketplaceIds: mkt, includedData: "summaries" });
      out.sku_ja_anunciado = ja.ok && ja.body?.summaries?.[0]?.asin ? { asin: ja.body.summaries[0].asin, situacao: ja.body.summaries[0].status } : false;

      // o produto existe no catálogo? (pelo EAN)
      let achados: any[] = [];
      if (ean) {
        const cat = await sp(token, "GET", "/catalog/2022-04-01/items", { marketplaceIds: mkt, identifiers: ean, identifiersType: "EAN", includedData: "summaries", pageSize: "10" });
        achados = ((cat.body?.items ?? []) as any[]).map((i) => ({ asin: i.asin, titulo: String(i.summaries?.[0]?.itemName ?? "").slice(0, 120), marca: i.summaries?.[0]?.brand ?? null, tipo: i.summaries?.[0]?.productType ?? null }));
        out.catalogo_pelo_ean = { http: cat.status, erro: pend(cat.body).slice(0, 2), itens: achados };
      } else out.catalogo_pelo_ean = "produto sem EAN no cadastro";
      const asinPedido = (u.searchParams.get("asin") || "").trim();
      const alvo = asinPedido ? { asin: asinPedido, tipo: u.searchParams.get("tipo") || achados.find((a) => a.asin === asinPedido)?.tipo || "PRODUCT" } : achados[0];
      const oferta = {
        condition_type: [{ value: "new_new", marketplace_id: mkt }],
        purchasable_offer: [{ currency: "BRL", our_price: [{ schedule: [{ value_with_tax: preco }] }], marketplace_id: mkt }],
        fulfillment_availability: [canal === "fba" ? { fulfillment_channel_code: "AMAZON_NA", marketplace_id: mkt } : { fulfillment_channel_code: "DEFAULT", quantity: 0, marketplace_id: mkt }],
      };

      if (alvo && u.searchParams.get("forcar") !== "novo") {
        // CAMINHO A: o produto já existe na Amazon → só a nossa oferta
        const rest = await sp(token, "GET", "/listings/2021-08-01/restrictions", { asin: alvo.asin, sellerId: seller, marketplaceIds: mkt, conditionType: "new_new" });
        out.caminho = "A — entrar na oferta de um produto que já existe";
        out.restricoes = { http: rest.status, lista: ((rest.body?.restrictions ?? []) as any[]).flatMap((x) => (x.reasons ?? []).map((m: any) => `${m.reasonCode ?? ""}: ${String(m.message ?? "").slice(0, 200)}`)) };
        const corpo = { productType: alvo.tipo || "PRODUCT", requirements: "LISTING_OFFER_ONLY", attributes: { merchant_suggested_asin: [{ value: alvo.asin, marketplace_id: mkt }], ...oferta } };
        const pv = await sp(token, "PUT", item(sku), { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, corpo);
        out.ensaio = { enviado: corpo, http: pv.status, situacao: pv.body?.status ?? null, pendencias: pend(pv.body) };
        return json(out);
      }

      // CAMINHO B: produto novo no catálogo → ficha completa pelo tipo de produto
      out.caminho = "B — criar a ficha do produto (ASIN novo)";
      let tipo = (u.searchParams.get("tipo") || "").trim();
      if (!tipo) {
        const tp = await sp(token, "GET", "/definitions/2020-09-01/productTypes", { marketplaceIds: mkt, keywords: String(p.nome).split(/\s+/).slice(0, 4).join(" "), locale: "pt_BR" });
        const nomes = ((tp.body?.productTypes ?? []) as any[]).map((x) => x.name);
        out.tipos_sugeridos = nomes.slice(0, 8);
        tipo = nomes[0] || "";
      }
      if (!tipo) return json({ ...out, erro: "a Amazon não sugeriu tipo de produto: passe &tipo=" });
      out.tipo_de_produto = tipo;
      const def = await sp(token, "GET", `/definitions/2020-09-01/productTypes/${encodeURIComponent(tipo)}`, { marketplaceIds: mkt, sellerId: seller, requirements: "LISTING", requirementsEnforced: "ENFORCED", locale: "pt_BR" });
      const link = def.body?.schema?.link?.resource;
      if (link) {
        try {
          const sc = await (await fetch(String(link))).json();
          const props = sc?.properties ?? {};
          out.o_que_o_tipo_exige = {
            campos: Object.keys(props).length,
            obrigatorios: ((sc?.required ?? []) as string[]).map((k) => `${k}${props[k]?.title ? ` (${props[k].title})` : ""}`),
            grupos: Object.fromEntries(Object.entries(def.body?.propertyGroups ?? {}).map(([g, v]: [string, any]) => [g, (v?.propertyNames ?? []).length])),
          };
        } catch (e) { out.o_que_o_tipo_exige = `não consegui ler o esquema: ${String(e).slice(0, 120)}`; }
      } else out.o_que_o_tipo_exige = { http: def.status, erro: pend(def.body).slice(0, 3) };

      const txt = (v: string) => [{ value: v, language_tag: "pt_BR", marketplace_id: mkt }];
      const bullets = (Array.isArray(r0?.bullet_points) ? (r0.bullet_points as unknown[]) : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5);
      const atributos: Record<string, unknown> = {
        item_name: txt(String(r0?.titulo || p.nome).slice(0, 200)),
        ...(marca ? { brand: txt(marca) } : {}),
        ...(bullets.length ? { bullet_point: bullets.map((b) => ({ value: b.slice(0, 500), language_tag: "pt_BR", marketplace_id: mkt })) } : {}),
        ...(r0?.descricao ? { product_description: txt(String(r0.descricao).slice(0, 2000)) } : {}),
        country_of_origin: [{ value: "BR", marketplace_id: mkt }],
        supplier_declared_dg_hz_regulation: [{ value: "not_applicable", marketplace_id: mkt }],
        ...(ean ? { externally_assigned_product_identifier: [{ type: "ean", value: ean, marketplace_id: mkt }] } : {}),
        ...(p.foto_capa ? { main_product_image_locator: [{ media_location: String(p.foto_capa), marketplace_id: mkt }] } : {}),
        ...oferta,
      };
      // &completo=1: preenche também o que a Amazon cobrou nos ensaios (valores de EXEMPLO, só para ver se a ficha fecha)
      if (u.searchParams.get("completo") === "1") {
        const so = (v: unknown) => [{ value: v, marketplace_id: mkt }];
        const cm = (v: number) => ({ unit: "centimeters", value: v });
        Object.assign(atributos, {
          bullet_point: (bullets.length ? bullets : ["Alta absorção e controle de odor", "Indicado para gatos"]).map((b) => ({ value: b.slice(0, 500), language_tag: "pt_BR", marketplace_id: mkt })),
          product_description: txt(String(r0?.descricao || p.nome).slice(0, 2000)),
          manufacturer: txt(marca || "Genérico"), model_name: txt(String(p.nome).slice(0, 60)), model_number: so(sku),
          directions: txt("Siga as instruções da embalagem."), specific_uses_for_product: txt("Gatos"), color: txt("Natural"),
          warranty_description: txt("30 dias com o fabricante"), included_components: txt("1 unidade"),
          external_testing_certification: so("Não Aplicável"), batteries_required: so(false), number_of_boxes: so(1),
          contains_liquid_contents: so(false), is_expiration_dated_product: so(false),
          unit_count: [{ value: 1, type: { value: "Unidade", language_tag: "pt_BR" }, marketplace_id: mkt }],
          list_price: [{ currency: "BRL", value_with_tax: preco, marketplace_id: mkt }],
          item_package_weight: [{ unit: "kilograms", value: Number(p.peso_bruto) || 1, marketplace_id: mkt }],
          item_package_dimensions: [{ length: cm(30), width: cm(20), height: cm(10), marketplace_id: mkt }],
        });
      }
      const corpo = { productType: tipo, requirements: "LISTING", attributes: atributos };
      const pv = await sp(token, "PUT", item(sku), { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, corpo);
      out.ensaio = { campos_enviados: Object.keys(atributos), http: pv.status, situacao: pv.body?.status ?? null, pendencias: pend(pv.body, 60) };
      return json(out);
    }

    // ?busca=texto : o produto JA existe no catalogo da Amazon? (so leitura) + podemos vender nele? + tipo de produto sugerido
    const busca = (u.searchParams.get("busca") || "").trim();
    if (busca) {
      const cat = await sp(token, "GET", "/catalog/2022-04-01/items", { marketplaceIds: mkt, keywords: busca, pageSize: "8", includedData: "summaries,identifiers" });
      const itens = ((cat.body?.items ?? []) as any[]).map((i) => ({
        asin: i.asin, titulo: String(i.summaries?.[0]?.itemName ?? "").slice(0, 110), marca: i.summaries?.[0]?.brand ?? null, tipo: i.summaries?.[0]?.productType ?? null,
        ean: ((i.identifiers?.[0]?.identifiers ?? []) as any[]).filter((x) => /EAN|GTIN|UPC/.test(String(x.identifierType))).map((x) => x.identifier).slice(0, 2),
      }));
      const restricoes: any[] = [];
      for (const it of itens.slice(0, 4)) {
        const r = await sp(token, "GET", "/listings/2021-08-01/restrictions", { asin: it.asin, sellerId: seller, marketplaceIds: mkt, conditionType: "new_new" });
        restricoes.push({ asin: it.asin, http: r.status, restricoes: ((r.body?.restrictions ?? []) as any[]).flatMap((x) => (x.reasons ?? []).map((m: any) => `${m.reasonCode ?? ""}: ${String(m.message ?? "").slice(0, 160)}`)) });
      }
      const tipos = await sp(token, "GET", "/definitions/2020-09-01/productTypes", { marketplaceIds: mkt, keywords: busca, locale: "pt_BR" });
      return json({ ...out, busca, catalogo_http: cat.status, itens, restricoes, tipos_sugeridos: ((tipos.body?.productTypes ?? []) as any[]).slice(0, 6).map((p) => p.name) });
    }

    // de qual SKU da Amazon estamos falando: o próprio, FBA-<sku>, o de-para e o que o estoque do FBA conhece
    const [map, fulf] = await Promise.all([
      sb.from("sku_mapeamento").select("sku_origem").eq("marketplace", "amazon").eq("sku_correto", sku),
      sb.from("estoque_fulfillment").select("sku_marketplace").ilike("marketplace", "amazon%").eq("shop_id", SHOP[conta]).eq("sku", sku),
    ]);
    const candidatos = [...new Set([sku, `FBA-${sku}`, ...((map.data ?? []) as any[]).map((x) => String(x.sku_origem)), ...((fulf.data ?? []) as any[]).map((x) => String(x.sku_marketplace))])];
    out.candidatos = candidatos;
    const bruto = u.searchParams.get("bruto") === "1";
    const achados: any[] = [];
    for (const c of candidatos.slice(0, 6)) {
      const r = await sp(token, "GET", item(c), { marketplaceIds: mkt, includedData: `summaries,attributes,issues${bruto ? ",offers,fulfillmentAvailability" : ""}`, issueLocale: "pt_BR" });
      if (!r.ok) { achados.push({ sku_amazon: c, status: r.status, erro: (r.body?.errors ?? []).map((e: any) => `${e.code}: ${String(e.message).slice(0, 120)}`) }); continue; }
      const s = r.body?.summaries?.[0] ?? {}; const a = r.body?.attributes ?? {};
      const fotos = ["main_product_image_locator", ...Array.from({ length: 8 }, (_, i) => `other_product_image_locator_${i + 1}`)]
        .map((k) => ({ atributo: k, url: a[k]?.[0]?.media_location ?? null })).filter((f) => f.url);
      achados.push({
        sku_amazon: c, status: r.status, asin: s.asin, tipo_de_produto: s.productType, situacao: s.status, titulo_resumo: s.itemName,
        item_name: a.item_name ?? null, n_fotos: fotos.length,
        ...(bruto ? { atributos: a, ofertas: r.body?.offers ?? null, disponibilidade: r.body?.fulfillmentAvailability ?? null } : { atributos: Object.keys(a) }),
        pendencias: (r.body?.issues ?? []).slice(0, 6).map((i: any) => `${i.severity} ${i.code}: ${String(i.message).slice(0, 140)} [${(i.attributeNames ?? []).join(",")}]`),
      });
    }
    out.anuncios = achados;
    const alvo = achados.find((x) => x.asin);
    if (alvo && !bruto) {
      // ENSAIO: a Amazon valida e devolve o que aconteceria — nada é aplicado
      const titulo = u.searchParams.get("titulo") || alvo.item_name?.[0]?.value || alvo.titulo_resumo;
      const foto = u.searchParams.get("foto");
      const patches: any[] = [{ op: "replace", path: "/attributes/item_name", value: [{ value: titulo, language_tag: "pt_BR", marketplace_id: mkt }] }];
      if (foto) patches.push({ op: "replace", path: "/attributes/main_product_image_locator", value: [{ media_location: foto, marketplace_id: mkt }] });
      const pv = await sp(token, "PATCH", item(alvo.sku_amazon), { marketplaceIds: mkt, mode: "VALIDATION_PREVIEW", issueLocale: "pt_BR" }, { productType: alvo.tipo_de_produto, patches });
      out.ensaio = { enviado: { productType: alvo.tipo_de_produto, patches }, http: pv.status, resposta: pv.body };
    }
    return json(out);
  } catch (e) {
    return json({ erro: String(e instanceof Error ? e.message : e) }, 500);
  }
});
