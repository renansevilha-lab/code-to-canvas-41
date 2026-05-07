/**
 * Sincronização das importações com o Lovable Cloud (Supabase).
 * Cada função recebe os mesmos rows que vão pro IndexedDB e faz upsert
 * idempotente nas tabelas correspondentes.
 *
 * Estratégia: chunks de 500 rows, upsert por chave natural.
 * Em caso de erro, devolvemos erro mas NÃO bloqueamos o IndexedDB local
 * (chamamos best-effort do smartUpload).
 */

import { supabase } from "@/integrations/supabase/client";
import type { Pedido, ItemPedido } from "@/lib/vendas/types";
import type { AdRow } from "@/lib/ads/types";
import type { CmvRow } from "@/lib/cmv/types";
import type { TransacaoCarteira } from "@/lib/carteira/types";

const DEFAULT_SHOP_ID = 0; // ACZ Pet (placeholder até OAuth)
const CHUNK = 500;

function chunked<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function logImport(
  tipo: string,
  arquivo: string,
  qtd: number,
  status: "sucesso" | "erro",
  detalhes?: unknown
) {
  await supabase.from("imports_log").insert({
    tipo,
    arquivo,
    qtd_registros: qtd,
    status,
    finalizado_em: new Date().toISOString(),
    detalhes: detalhes ? (detalhes as never) : null,
  });
}

// ---------- VENDAS ----------

export async function syncVendas(
  pedidos: Pedido[],
  itens: ItemPedido[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const pedidosRows = pedidos.map((p) => ({
      id: p.id,
      shop_id: DEFAULT_SHOP_ID,
      data_pedido: p.data_hora_pedido || `${p.data_pedido}T00:00:00Z`,
      status_pedido: p.status,
      motivo_cancelamento: p.motivo_cancelamento || null,
      opcao_envio: p.opcao_envio || null,
      cidade: p.cidade || null,
      uf: p.uf || null,
      valido: p.pedido_valido,
      renda_estimada: p.renda_estimada,
      imposto_estimado: p.imposto_estimado,
      taxa_transacao: p.taxa_transacao,
      taxa_servico: p.taxa_servico,
      taxa_comissao: p.taxa_comissao,
      comissao_afiliados: p.comissao_afiliados,
      ajuste_acao_comercial: p.ajuste_acao_comercial,
      subtotal_bruto: p.valor_total,
      subtotal_produtos: p.subtotal_produtos,
      primeiro_produto: p.primeiro_produto || null,
      fonte: "planilha",
    }));

    for (const c of chunked(pedidosRows)) {
      const { error } = await supabase
        .from("pedidos")
        .upsert(c, { onConflict: "id" });
      if (error) throw error;
    }

    // Itens: deletar dos pedidos afetados e reinserir
    const idsAfetados = Array.from(new Set(itens.map((i) => i.id_pedido)));
    for (const c of chunked(idsAfetados, 200)) {
      const { error } = await supabase
        .from("pedido_itens")
        .delete()
        .in("pedido_id", c);
      if (error) throw error;
    }

    const itensRows = itens.map((i) => ({
      pedido_id: i.id_pedido,
      sku_pai: i.sku_principal || null,
      sku_filho: i.sku || null,
      nome_produto: i.produto || null,
      quantidade: i.quantidade,
      subtotal_produto: i.subtotal,
    }));

    for (const c of chunked(itensRows)) {
      const { error } = await supabase.from("pedido_itens").insert(c);
      if (error) throw error;
    }

    await logImport("vendas", "smart_upload", pedidos.length, "sucesso");
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    await logImport("vendas", "smart_upload", 0, "erro", { msg });
    return { ok: false, error: msg };
  }
}

// ---------- ADS ----------

export async function syncAds(
  rows: AdRow[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const adsRows = rows
      .filter((r) => r.data) // tabela exige data NOT NULL
      .map((r) => ({
        shop_id: DEFAULT_SHOP_ID,
        data: r.data,
        sku: r.id_anuncio || r.nome_anuncio,
        impressoes: r.impressoes,
        cliques: r.cliques,
        gasto: r.gasto,
        gmv: r.gmv,
        receita_direta: r.gmv,
        itens_vendidos: r.itens_vendidos,
        conversoes: r.pedidos,
        conversoes_diretas: r.pedidos,
        cpc: r.cpc,
        ctr: r.ctr_pct,
        roas: r.roas,
        acos: r.gmv > 0 ? (r.gasto / r.gmv) * 100 : 0,
      }));

    for (const c of chunked(adsRows)) {
      const { error } = await supabase
        .from("ads_diario")
        .upsert(c, { onConflict: "shop_id,sku,data", ignoreDuplicates: false });
      if (error) throw error;
    }

    await logImport("ads", "smart_upload", adsRows.length, "sucesso");
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    await logImport("ads", "smart_upload", 0, "erro", { msg });
    return { ok: false, error: msg };
  }
}

// ---------- CMV ----------

export async function syncCmv(
  rows: CmvRow[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const cmvRows = rows.map((r) => ({
      sku: r.sku,
      custo: r.cmv,
      fonte: r.formato_origem === "Tiny ERP" ? "tiny" : "planilha",
    }));

    for (const c of chunked(cmvRows)) {
      const { error } = await supabase
        .from("cmv_skus")
        .upsert(c, { onConflict: "sku" });
      if (error) throw error;
    }

    await logImport("cmv", "smart_upload", cmvRows.length, "sucesso");
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    await logImport("cmv", "smart_upload", 0, "erro", { msg });
    return { ok: false, error: msg };
  }
}

// ---------- CARTEIRA ----------

export async function syncCarteira(
  rows: TransacaoCarteira[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const txRows = rows.map((r) => ({
      shop_id: DEFAULT_SHOP_ID,
      shopee_transaction_id: r.chave,
      data: new Date(r.data_hora.replace(" ", "T") + "Z").toISOString(),
      tipo: r.tipo,
      classificacao: r.tipo,
      direcao: r.direcao,
      valor: r.valor,
      pedido_id: r.id_pedido || null,
      descricao: r.descricao,
      status: r.status,
      saldo_apos: r.saldo_apos,
      fonte: "planilha",
    }));

    for (const c of chunked(txRows)) {
      const { error } = await supabase
        .from("transacoes_carteira")
        .upsert(c, { onConflict: "shopee_transaction_id" });
      if (error) throw error;
    }

    await logImport("carteira", "smart_upload", txRows.length, "sucesso");
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    await logImport("carteira", "smart_upload", 0, "erro", { msg });
    return { ok: false, error: msg };
  }
}
