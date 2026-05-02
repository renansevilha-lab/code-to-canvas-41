/**
 * Storage local em IndexedDB (via idb).
 * Mantém histórico acumulado de Pedidos e Itens, dedup por chave única.
 *
 * Equivalente ao "Excel mestre" do Python: ler histórico → mesclar novo → dedup.
 */

import { getShopeeAnalyticsDB } from "@/lib/storage/db";

import type { ItemPedido, Pedido } from "./types";

interface DBSchema extends Record<string, unknown> {
  pedidos: { key: string; value: Pedido };
  itens: { key: string; value: ItemPedido };
}

const getDB = getShopeeAnalyticsDB;

export async function getAllPedidos(): Promise<Pedido[]> {
  const db = await getDB();
  return (await db.getAll("pedidos")) as Pedido[];
}

export async function getAllItens(): Promise<ItemPedido[]> {
  const db = await getDB();
  return (await db.getAll("itens")) as ItemPedido[];
}

/**
 * Insere/atualiza pedidos. Dedup por id (keyPath).
 * Retorna quantos foram inseridos novos vs atualizados.
 */
export async function salvarPedidos(
  pedidos: Pedido[]
): Promise<{ novos: number; atualizados: number }> {
  if (pedidos.length === 0) return { novos: 0, atualizados: 0 };
  const db = await getDB();
  const tx = db.transaction("pedidos", "readwrite");
  const store = tx.objectStore("pedidos");
  let novos = 0;
  let atualizados = 0;
  for (const p of pedidos) {
    const existing = await store.get(p.id);
    if (existing) atualizados++;
    else novos++;
    await store.put(p);
  }
  await tx.done;
  return { novos, atualizados };
}

/**
 * Itens: dedup por (id_pedido, sku, variacao).
 * Estratégia: removemos todos os itens dos pedidos sendo importados e regravamos.
 * É correto porque sempre processamos pedido completo (todos os SKUs juntos).
 */
export async function salvarItens(itens: ItemPedido[]): Promise<number> {
  if (itens.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction("itens", "readwrite");
  const store = tx.objectStore("itens");
  const idx = store.index("id_pedido");

  const idsAfetados = new Set(itens.map((i) => i.id_pedido));

  // Remove existentes desses pedidos
  for (const id of idsAfetados) {
    let cursor = await idx.openCursor(IDBKeyRange.only(id));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }

  // Insere novos
  for (const item of itens) {
    await store.add(item);
  }
  await tx.done;
  return itens.length;
}

export async function limparTudoVendas(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["pedidos", "itens"], "readwrite");
  await tx.objectStore("pedidos").clear();
  await tx.objectStore("itens").clear();
  await tx.done;
}

export async function statsVendas(): Promise<{
  total_pedidos: number;
  total_itens: number;
  data_min: string | null;
  data_max: string | null;
}> {
  const db = await getDB();
  const total_pedidos = await db.count("pedidos");
  const total_itens = await db.count("itens");

  let data_min: string | null = null;
  let data_max: string | null = null;
  if (total_pedidos > 0) {
    const idx = db.transaction("pedidos").objectStore("pedidos").index("data_pedido");
    const first = await idx.openCursor(null, "next");
    if (first) data_min = String(first.key);
    const last = await idx.openCursor(null, "prev");
    if (last) data_max = String(last.key);
  }

  return { total_pedidos, total_itens, data_min, data_max };
}
