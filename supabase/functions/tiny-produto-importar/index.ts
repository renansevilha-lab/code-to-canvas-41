// ============================================================================
// Edge Function: tiny-produto-importar v1 (19/out/2026)
// ----------------------------------------------------------------------------
// Pedido do dono: produto cadastrado no Tiny durante o dia só chegava ao sistema na
// listagem da madrugada (cron 19, 05h BRT) — e desde a tiny-sync-produtos v29 a
// listagem chamada no meio do dia responde "passada de hoje já completa" sem ir ao
// Tiny, e o `detalhar&sku=` só serve a SKU que JÁ está no espelho. Não havia caminho
// para trazer um produto novo na hora (nem o atalho da tela de Promoções funcionava).
//
//   POST {skus: ["16530", …]}  → para cada código: acha no Tiny (GET /produtos?codigo=),
//        lê o detalhe (GET /produtos/{id}) e grava no espelho `produtos` com os MESMOS
//        campos da listagem (mapearItemBasico da v29) + do detalhe (foto, marca, categoria,
//        fornecedor, estoque, pai) e a composição do kit em `produto_kits`. Produto já no
//        espelho = ATUALIZA (custo, nome, foto, kit). Pai com variações traz as variações
//        junto; variação traz o pai se ele ainda não está no espelho.
// Só LÊ no Tiny. Escreve só no espelho (o mesmo que a sincronização escreve).
// ~22 s de orçamento: o que não couber volta em `faltam` (a tela chama de novo).
// Sessão de usuário exigida (qualquer usuário logado).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SRK);
const TINY = "https://api.tiny.com.br/public-api/v3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKU_OK = /^[A-Za-z0-9._-]{1,40}$/;
const ORCAMENTO_MS = 22_000;
const MAX_POR_CHAMADA = 20;

function usuario(req: Request): { id: string; email: string | null } | null {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  try {
    const pl = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (pl.role !== "authenticated") return null;
    return { id: String(pl.sub ?? ""), email: (pl.email as string) ?? null };
  } catch { return null; }
}

/** Token da conta principal do Tiny (sempre `ottz`: nunca "o mais recente"). */
async function tokenTiny(): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.from("oauth_tokens_tiny").select("access_token, expires_at").eq("conta", "ottz").limit(1).maybeSingle();
    if (error) { await sleep(800); continue; } // leitura que falhou não é "sem token" (§5.0)
    if (!data) throw new Error("token do Tiny (conta ottz) não encontrado");
    if (new Date(data.expires_at as string) < new Date()) throw new Error("token do Tiny vencido — a renovação automática roda de 30 em 30 min; tente de novo em instantes");
    return String(data.access_token);
  }
  throw new Error("não consegui ler o token do Tiny (banco ocupado) — tente de novo");
}
async function tinyGet(token: string, path: string): Promise<{ status: number; body: any }> {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${TINY}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const txt = await r.text();
    let body: any = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = { mensagem: txt.slice(0, 200) }; }
    await sleep(600); // ~1 chamada/s do Tiny
    if (r.status === 429 && i < 2) { await sleep(2000 * (i + 1)); continue; } // leitura: repetir não tem efeito colateral
    return { status: r.status, body };
  }
  return { status: 429, body: { mensagem: "o Tiny pediu para esperar (limite de chamadas)" } };
}

/** "2026-09-29 10:00:00" (Brasília, como o Tiny devolve) -> ISO com fuso. Igual à tiny-sync-produtos v29. */
function dataTiny(s: unknown): string | null {
  const t = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(t)) return null;
  return `${t.replace(" ", "T")}${t.length === 16 ? ":00" : ""}-03:00`;
}
const texto = (v: unknown) => (v != null && String(v).trim()) ? String(v).trim() : null;

/** Linha do espelho = campos da listagem (mapearItemBasico) + campos do detalhe (detalharProdutos), da v29. */
function linhaDoEspelho(det: any, itemLista: any | null) {
  const agora = new Date().toISOString();
  const precos = det?.precos || itemLista?.precos || {};
  const linha: Record<string, unknown> = {
    sku: String(det.sku).trim(),
    id_tiny: det.id || itemLista?.id || null,
    nome: det.descricao || itemLista?.descricao || null,
    tipo: det.tipo || itemLista?.tipo || null,
    custo: parseFloat(precos.precoCusto) || 0,
    preco: parseFloat(precos.preco) || null,
    ativo: det.situacao === "A",
    situacao: det.situacao || null,
    gtin: texto(det.gtin),
    unidade: texto(det.unidade),
    tipo_variacao: det.tipoVariacao || null,
    tiny_visto_em: agora,
    atualizado_em: agora,
    // detalhe
    foto_capa: det?.anexos?.[0]?.url || null,
    marca: det?.marca?.nome || null,
    categoria: det?.categoria?.nome || null,
    categoria_caminho: det?.categoria?.caminhoCompleto || null,
    fornecedor: det?.fornecedores?.[0]?.nome || null,
    sku_pai: det?.produtoPai?.sku ? String(det.produtoPai.sku).trim() : null,
    id_tiny_pai: det?.produtoPai?.id || null,
    detalhe_atualizado_em: agora,
  };
  const alterado = dataTiny(itemLista?.dataAlteracao);
  if (alterado) linha.tiny_alterado_em = alterado;
  const qtd = det?.estoque?.quantidade;
  if (qtd !== undefined && qtd !== null && !isNaN(parseFloat(qtd))) {
    linha.estoque = Math.round(parseFloat(qtd));
    linha.estoque_atualizado_em = agora;
  }
  return linha;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  const quem = usuario(req);
  if (!quem) return json({ erro: "faça login no app (sessão de usuário exigida)" }, 401);
  const body = await req.json().catch(() => ({})) as Record<string, any>;
  const pedidos = [...new Set(
    (Array.isArray(body.skus) ? body.skus : String(body.skus ?? "").split(/[\s,;]+/))
      .map((s: unknown) => String(s ?? "").trim()).filter(Boolean),
  )] as string[];
  if (!pedidos.length) return json({ ok: false, erro: "informe os SKUs (códigos do Tiny)" }, 400);
  const invalidos = pedidos.filter((s) => !SKU_OK.test(s));
  if (invalidos.length) return json({ ok: false, erro: `código inválido: ${invalidos.join(", ")}` }, 400);
  if (pedidos.length > MAX_POR_CHAMADA) return json({ ok: false, erro: `no máximo ${MAX_POR_CHAMADA} códigos por vez` }, 400);
  const trazerFamilia = body.familia !== false;

  try {
    const token = await tokenTiny();
    const inicio = Date.now();
    // fila: [sku, id do Tiny se já conhecido, motivo]
    const fila: { sku: string; id: number | null; origem: string }[] = pedidos.map((sku) => ({ sku, id: null, origem: "pedido" }));
    const vistos = new Set<string>();
    const itens: Record<string, unknown>[] = [];
    const faltam: string[] = [];

    while (fila.length) {
      const alvo = fila.shift()!;
      if (vistos.has(alvo.sku)) continue;
      vistos.add(alvo.sku);
      if (Date.now() - inicio > ORCAMENTO_MS) { faltam.push(alvo.sku); continue; }

      const { data: antes } = await db.from("produtos").select("sku, id_tiny, nome, custo, ativo, foto_capa").eq("sku", alvo.sku).maybeSingle();
      // 1) achar no Tiny: pelo id que já se conhece (variação/pai) ou pelo código
      let itemLista: any = null;
      let id = alvo.id ?? (antes?.id_tiny ? Number(antes.id_tiny) : null);
      const l = await tinyGet(token, `/produtos?codigo=${encodeURIComponent(alvo.sku)}&limit=10`);
      if (l.status === 200) itemLista = ((l.body?.itens ?? []) as any[]).find((x) => String(x?.sku ?? "").trim() === alvo.sku) ?? null;
      if (itemLista?.id) id = Number(itemLista.id);
      if (!id) {
        itens.push({ sku: alvo.sku, ok: false, origem: alvo.origem, erro: l.status === 200 ? "não achei este código no Tiny (confira o SKU)" : `o Tiny não respondeu a busca (${l.status})` });
        continue;
      }
      // 2) detalhe
      const d = await tinyGet(token, `/produtos/${id}`);
      if (d.status === 404) { itens.push({ sku: alvo.sku, ok: false, origem: alvo.origem, erro: "o produto não existe mais no Tiny" }); continue; }
      if (d.status !== 200 || !d.body?.sku) { itens.push({ sku: alvo.sku, ok: false, origem: alvo.origem, erro: `não consegui ler o produto no Tiny (${d.status}): ${String(d.body?.mensagem ?? "").slice(0, 150)}` }); continue; }
      const det = d.body;
      if (String(det.sku).trim() !== alvo.sku) { itens.push({ sku: alvo.sku, ok: false, origem: alvo.origem, erro: `o Tiny devolveu outro código (${det.sku})` }); continue; }

      // 3) espelho
      const linha = linhaDoEspelho(det, itemLista);
      const up = await db.from("produtos").upsert(linha, { onConflict: "sku" });
      if (up.error) { itens.push({ sku: alvo.sku, ok: false, origem: alvo.origem, erro: `não consegui gravar no sistema: ${up.error.message.slice(0, 150)}` }); continue; }

      // kit: a composição do Tiny é a fonte (igual ao detalhar da v29)
      let componentes = 0;
      if (det.tipo === "K" && Array.isArray(det.kit) && det.kit.length > 0) {
        const comps = det.kit.map((c: any) => {
          const sc = c?.produto?.sku || c?.sku || null;
          return sc ? {
            sku_kit: alvo.sku, sku_componente: String(sc).trim(), nome_kit: det.descricao ?? null,
            nome_componente: c?.produto?.descricao || null, quantidade: parseFloat(c?.quantidade) || 1,
            atualizado_em: new Date().toISOString(),
          } : null;
        }).filter(Boolean) as Record<string, unknown>[];
        if (comps.length) {
          await db.from("produto_kits").delete().eq("sku_kit", alvo.sku);
          const ins = await db.from("produto_kits").insert(comps);
          if (!ins.error) componentes = comps.length;
          // componente que ainda não está no espelho vem junto (sem ele o kit fica sem custo)
          if (trazerFamilia) {
            const skusComp = comps.map((c) => String(c.sku_componente));
            const { data: ja } = await db.from("produtos").select("sku").in("sku", skusComp);
            const tem = new Set(((ja ?? []) as any[]).map((x) => String(x.sku)));
            for (const sc of skusComp) if (!tem.has(sc)) fila.push({ sku: sc, id: null, origem: `componente de ${alvo.sku}` });
          }
        }
      }
      // pai: as variações vêm junto e ficam ligadas a ele
      const filhos = (Array.isArray(det.variacoes) ? det.variacoes : [])
        .map((v: any) => ({ sku: String(v?.sku ?? "").trim(), id: v?.id ? Number(v.id) : null }))
        .filter((v: { sku: string }) => v.sku && v.sku !== alvo.sku);
      if (filhos.length) {
        await db.from("produtos").update({ sku_pai: alvo.sku, id_tiny_pai: det.id }).in("sku", filhos.map((f: { sku: string }) => f.sku));
        if (trazerFamilia) for (const f of filhos) fila.push({ sku: f.sku, id: f.id, origem: `variação de ${alvo.sku}` });
      }
      // variação cujo pai ainda não está no espelho: traz o pai (a lista agrupa por ele)
      if (trazerFamilia && linha.sku_pai) {
        const { data: pai } = await db.from("produtos").select("sku").eq("sku", String(linha.sku_pai)).maybeSingle();
        if (!pai) fila.push({ sku: String(linha.sku_pai), id: det?.produtoPai?.id ? Number(det.produtoPai.id) : null, origem: `pai de ${alvo.sku}` });
      }

      itens.push({
        sku: alvo.sku, ok: true, origem: alvo.origem, novo: !antes, nome: linha.nome, tipo: linha.tipo,
        tipo_variacao: linha.tipo_variacao, situacao: linha.situacao, ativo: linha.ativo,
        custo: linha.custo, preco: linha.preco, estoque: linha.estoque ?? null, foto: linha.foto_capa,
        sku_pai: linha.sku_pai, componentes, variacoes: filhos.length,
        mudou: antes ? {
          nome: antes.nome !== linha.nome, custo: Number(antes.custo ?? 0) !== Number(linha.custo ?? 0),
          ativo: antes.ativo !== linha.ativo, foto: (antes.foto_capa ?? null) !== (linha.foto_capa ?? null),
        } : null,
      });
    }

    await db.from("debug_fulfillment").insert({
      modulo: "tiny-produto-importar", etapa: pedidos.join(",").slice(0, 120), status_http: 200,
      resultado: { quem: quem.email, itens: itens.map((i) => ({ sku: i.sku, ok: i.ok, novo: i.novo, erro: i.erro ?? null })), faltam },
    });
    // ok = a chamada funcionou; o resultado de CADA código está em `itens` (um que falha não esconde os outros)
    return json({ ok: true, tudo_ok: itens.every((i) => i.ok) && !faltam.length, itens, faltam, tempo_ms: Date.now() - inicio });
  } catch (e) {
    return json({ ok: false, erro: String(e instanceof Error ? e.message : e).slice(0, 500) }, 500);
  }
});
