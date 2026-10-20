import { createClient } from 'jsr:@supabase/supabase-js@2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

async function tinyGet(url: string, token: string, tentativas = 5): Promise<Response> {
  for (let i = 0; i < tentativas; i++) {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (r.status !== 429) return r;
    await r.body?.cancel();
    await sleep(1200 * (i + 1));
  }
  return new Response(null, { status: 429 });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const modo = url.searchParams.get('modo') ?? 'detalhe';
  const limite = Number(url.searchParams.get('limite') ?? '60');
  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: tk } = await db.from('oauth_tokens_tiny').select('access_token').eq('conta', 'ottz').single();
  const token = tk!.access_token as string;

  let ok = 0, falhas = 0, naoAchados = 0;
  const erros: string[] = [];

  if (modo === 'busca') {
    // SKUs sem id_tiny: procurar pelo codigo no catalogo
    const { data: alvos } = await db.from('tmp_fiscal_offers')
      .select('linha, sku_base').is('id_tiny', null).order('linha').limit(limite);
    const vistos = new Map<string, number | null>();
    for (const a of alvos ?? []) {
      const sku = a.sku_base as string;
      if (!vistos.has(sku)) {
        const r = await tinyGet(
          `https://api.tiny.com.br/public-api/v3/produtos?codigo=${encodeURIComponent(sku)}&limit=5`, token);
        if (r.status !== 200) { falhas++; erros.push(`${sku}:${r.status}`); await r.body?.cancel(); vistos.set(sku, null); await sleep(300); continue; }
        const j = await r.json();
        const itens = j?.itens ?? j?.data ?? [];
        const achado = itens.find((p: any) => String(p.sku ?? p.codigo) === sku) ?? null;
        vistos.set(sku, achado ? Number(achado.id) : null);
        if (!achado) naoAchados++;
        await sleep(300);
      }
      const id = vistos.get(sku);
      if (id) { await db.from('tmp_fiscal_offers').update({ id_tiny: id }).eq('linha', a.linha); ok++; }
    }
    return Response.json({ modo, processados: alvos?.length ?? 0, vinculados: ok, nao_achados: naoAchados, falhas, erros: erros.slice(0, 20) });
  }

  // modo detalhe: puxar ncm/origem dos que tem id_tiny e ainda nao tem ncm
  const { data: alvos } = await db.from('tmp_fiscal_offers')
    .select('linha, id_tiny').not('id_tiny', 'is', null).is('ncm', null).order('linha').limit(limite);

  const cache = new Map<number, any>();
  for (const a of alvos ?? []) {
    const id = Number(a.id_tiny);
    if (!cache.has(id)) {
      const r = await tinyGet(`https://api.tiny.com.br/public-api/v3/produtos/${id}`, token);
      if (r.status !== 200) { falhas++; erros.push(`${id}:${r.status}`); await r.body?.cancel(); await sleep(300); continue; }
      cache.set(id, await r.json());
      await sleep(300);
    }
    const p = cache.get(id);
    if (!p) continue;
    await db.from('tmp_fiscal_offers').update({
      status: 200,
      ncm: (p.ncm ?? '').replaceAll('.', '') || null,
      origem: p.origem ?? null,
      gtin: p.gtin || null,
      nome: p.descricao ?? null,
      tipo: p.tipo ?? null,
    }).eq('linha', a.linha);
    ok++;
  }
  return Response.json({ modo, processados: alvos?.length ?? 0, atualizados: ok, falhas, erros: erros.slice(0, 20) });
});
